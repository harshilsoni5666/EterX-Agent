import { z } from 'zod';
import fs from 'fs-extra';
import path from 'path';
import { ToolDefinition } from '../../schemas';
import { resolveWorkspaceDirectoryForContext } from '../../workspace/path_resolver';
import { normalizeTimeoutMs } from '../core/terminal_timeout';
import {
  backgroundTerminalTask,
  waitTerminalTask,
  getTerminalBackgroundTaskStatus,
  killTerminalBackgroundTask,
  listTerminalBackgroundTasks,
  readTerminalTasks,
  runTerminalCommandWithCheckIn,
  type TerminalTaskReadRequest,
} from '../core/terminal_background';
import { findExecutable, resolveTerminalShell } from '../core/shell_resolver';
import { authorizeToolCommand } from '../security/command_broker';
import { environmentForExplicitProgram } from '../../runtime/python-runtime';
import { formatTerminalProgram } from '../../terminal-invocation';
import { executeParallelToolCalls } from '../../parallel-tool-calls';
import { boundTerminalBatchEntries } from '../../terminal-batch-output';
import { isSourceReadShellCommand } from '../../shell-command-shape';
import {
  MIN_TERMINAL_OUTPUT_CHARS, MAX_TERMINAL_OUTPUT_CHARS, explicitOutputChars,
  resolveTerminalOutputKind, terminalOutputPageChars, type TerminalOutputKind,
} from '../../source-read-policy';

const DEFAULT_MODEL_OUTPUT_CHARS = 24_000;
const MIN_MODEL_OUTPUT_CHARS = MIN_TERMINAL_OUTPUT_CHARS;
const MAX_MODEL_OUTPUT_CHARS = MAX_TERMINAL_OUTPUT_CHARS;

const describeProgram = formatTerminalProgram;

function terminalFailureAdvice(output: string, shell: string): string {
  if (/ModuleNotFoundError|No module named/i.test(output)) return 'The interpreter ran. Resolve only the named missing dependency for that interpreter (prefer a workspace virtual environment), then rerun the actual task. Do not repeat shell/version discovery.';
  if (/ParserError|Unexpected token|SyntaxError|terminator|not recognized|command not found/i.test(output)) return `Read the specific error before retrying. Current executor: ${shell}. For Python/Node use program + args to avoid shell quoting. Use the executable paths already supplied in runtime context; inspect only the specific missing executable if necessary.`;
  if (/EACCES|EPERM|Access.*denied|Permission denied|Operation not permitted/i.test(output)) return 'The host OS denied this operation. Use the exact path and permission error to explain the blocker; retry only after changing the relevant path or permission. On macOS protected folders may require OS privacy access.';
  return 'Use the actual stderr to correct the failing operation. Reuse known paths and dependencies; repeat only after a relevant change, or choose another viable approach.';
}

type TerminalCommandRequest = {
  command: string;
  program?: string;
  args?: string[];
  shell?: string;
  env?: Record<string, string>;
  cwd?: string;
  timeoutSeconds?: number;
  timeoutMs?: number;
  background?: boolean;
  maxOutputChars?: number;
  outputKind?: TerminalOutputKind;
};

type TerminalCommandResult = {
  command: string;
  program?: string;
  args?: string[];
  outputKind?: TerminalOutputKind;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
  timeoutMs?: number;
  processId?: string;
  taskId?: string;
  tasks?: TerminalTaskReadRequest[];
  outputEnd?: number;
  outputStart?: number;
  hasMoreOutput?: boolean;
  nextOutputOffset?: number;
  outputLimited?: boolean;
  outputFile?: string;
  outputReadError?: string;
  outputPersistenceError?: string;
  statusPersistenceError?: string;
  streamId?: string;
  nextActionNote?: string;
  stillRunning?: boolean;
  backgroundTaskId?: string;
  totalOutputChars?: number;
  droppedOutputChars?: number;
  message?: string;
  cwd?: string;
  shell?: string;
  /** The managed terminal publisher already owns the console timeline. */
  _consoleTraceEmitted?: boolean;
};

type WorkspaceTerminalInput = Omit<TerminalCommandRequest, 'command'> & {
  mode?: 'run' | 'check' | 'wait' | 'background' | 'list' | 'kill';
  command?: string;
  commands?: TerminalCommandRequest[];
  taskId?: string;
  sinceOffset?: number;
  parallel?: boolean;
};

const commandRequestSchema = z.object({
  command: z.string().min(1).optional().describe('Shell script. Supply command OR program, never both.'),
  program: z.string().min(1).optional().describe('Executable name or absolute path. python/python3 use this chat’s selected Python environment; explicit paths are honored. Executes directly without shell quoting.'),
  args: z.array(z.string()).optional().describe('Exact program arguments, e.g. ["-c", "print(123)"]. No shell expansion.'),
  shell: z.string().optional().describe('Shell preference for command only. Defaults to this chat setting.'),
  env: z.record(z.string(), z.string()).optional().describe('Environment overrides for this invocation. Do not pass secrets unless required.'),
  cwd: z.string().optional().describe('Optional working directory override for this command.'),
  timeoutSeconds: z.number().optional().describe('Optional foreground check-in override for this command, up to 120 seconds.'),
  background: z.boolean().optional().describe('Start this command immediately as a managed background process.'),
  maxOutputChars: z.number().int().min(MIN_MODEL_OUTPUT_CHARS).max(MAX_MODEL_OUTPUT_CHARS).optional().describe('Optional response page allowance, including reads/searches. Exact remaining read output is available through taskId and outputEnd.'),
  outputKind: z.enum(['read', 'log']).optional().describe('Auto-detected for standard commands. read retains exact output and returns a bounded verbatim page; log bounds noisy execution output. Overrides the shared outputKind, not execution safety.'),
});

/** Give known installs and builds a useful foreground check-in automatically. */
function detectInstallTimeout(command: string): number {
  const lower = command.toLowerCase().trim();
  if (/\b(npm\s+(install|ci|i)\b|yarn\s*(install)?\b|pnpm\s+(install|i)\b|bun\s+install\b)/i.test(lower)) return 120;
  if (/\b(pip\s+install|pip3\s+install|poetry\s+install|pipenv\s+install)/i.test(lower)) return 120;
  if (/\b(cargo\s+(build|install)|rustup)/i.test(lower)) return 120;
  if (/\b(dotnet\s+(build|restore|publish))/i.test(lower)) return 120;
  if (/\b(mvn\s+(install|package|compile)|gradle\s+(build|assemble))/i.test(lower)) return 120;
  if (/\b(npm\s+run\s+build|yarn\s+build|pnpm\s+build|next\s+build|vite\s+build|tsc\b)/i.test(lower)) return 120;
  if (/\b(npm\s+create|npx\s)/i.test(lower)) return 120;
  return 0;
}

export function normalizeModelOutputChars(value: unknown): number {
  return explicitOutputChars(value) ?? DEFAULT_MODEL_OUTPUT_CHARS;
}

/**
 * Recognize file/content reads regardless of file extension. Execution logs
 * are deliberately separate; they retain their bounded recent-output window.
 */
export function isSourceReadCommand(command: string): boolean {
  return isSourceReadShellCommand(command);
}

export function resolveModelOutputChars(command: string, value: unknown, outputKind?: TerminalOutputKind): number {
  return terminalOutputPageChars(value);
}

function keepRecentOutput(value: string, maxChars: number): { text: string; dropped: number } {
  if (maxChars <= 0) return { text: '', dropped: value.length };
  if (value.length <= maxChars) return { text: value, dropped: 0 };
  const marker = '...[earlier output omitted]...\n';
  if (maxChars <= marker.length) return { text: value.slice(-maxChars), dropped: value.length - maxChars };
  const retained = maxChars - marker.length;
  const dropped = value.length - retained;
  return {
    text: `${marker}${value.slice(-retained)}`,
    dropped,
  };
}

/** Keep structural context from both ends when a multi-command response is too large. */
export function keepHeadAndTailOutput(value: string, maxChars: number): { text: string; dropped: number } {
  if (maxChars <= 0) return { text: '', dropped: value.length };
  if (value.length <= maxChars) return { text: value, dropped: 0 };
  const marker = '\n...[middle output omitted; request a narrower range for the missing section]...\n';
  if (maxChars <= marker.length) return { text: value.slice(0, maxChars), dropped: value.length - maxChars };
  const retained = maxChars - marker.length;
  const headChars = Math.ceil(retained * 0.5);
  const tailChars = retained - headChars;
  return {
    text: `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`,
    dropped: value.length - retained,
  };
}

function ownerChatId(context: any): string | undefined {
  const value = String(context?.ownerChatId || context?.chatId || context?.projectId || '').trim();
  return value || undefined;
}

/** All sections share one response budget. Read pages retain an exact prefix. */
function fitBatchOutput(sections: { text: string; preserve: boolean }[], maxChars: number): { text: string; dropped: number }[] {
  const allocations = new Array(sections.length).fill(0);
  const bounded = sections.map((section, index) => ({ ...section, index }))
    .filter(section => section.text.length > 0);
  let remaining = Math.max(0, maxChars - Math.max(0, bounded.length - 1) * 2);
  const bySize = bounded.sort((a, b) => a.text.length - b.text.length);
  bySize.forEach((section, index) => {
    const share = Math.floor(remaining / (bySize.length - index));
    allocations[section.index] = Math.min(share, section.text.length);
    remaining -= allocations[section.index];
  });
  return sections.map((section, index) => section.preserve
    ? { text: section.text.slice(0, allocations[index]), dropped: Math.max(0, section.text.length - allocations[index]) }
    : keepRecentOutput(section.text, allocations[index]));
}

function safeTaskId(value: unknown): string {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
}

/**
 * Validation and setup failures happen before terminal_background can create a
 * managed process. Publish the same settled console contract here so a mixed
 * parallel batch never needs one synthetic aggregate row on top of its real
 * child streams.
 */
function emitImmediateTerminalFailure(
  context: any,
  command: string,
  stderr: string,
  cwd: string,
  exitCode: number,
  shell?: string,
): boolean {
  const emit = typeof context?._onTrace === 'function' ? context._onTrace : null;
  if (!emit) return false;
  const at = Date.now();
  const streamId = `terminal_rejected_${at}_${Math.random().toString(36).slice(2, 9)}`;
  try {
    emit({
      type: 'console_output',
      command,
      output: stderr,
      source: 'workspace_run_command',
      cwd,
      shell,
      streamId,
      ownerTraceId: context?.ownerTraceId,
      runId: context?.runId,
      turnId: context?.turnId,
      toolName: 'workspace_run_command',
      startTime: at,
      endTime: at,
      timestamp: at,
      isStreaming: false,
      isDelta: false,
      streamState: 'closed',
      status: 'failed',
      exitCode,
      durationMs: 0,
      outputStart: 0,
      outputEnd: stderr.length,
      totalOutputChars: stderr.length,
      droppedOutputChars: 0,
    });
    return true;
  } catch {
    return false;
  }
}

async function executeTerminalCommand(
  input: TerminalCommandRequest,
  context: any,
): Promise<TerminalCommandResult> {
  const runDir = resolveWorkspaceDirectoryForContext(input.cwd, context);
  const autoTimeout = detectInstallTimeout(input.command);
  const explicitTimeout = input.timeoutSeconds == null ? input.timeoutMs : Math.max(1000, input.timeoutSeconds * 1000);
  const timeoutMs = autoTimeout > 0 && !explicitTimeout
    ? normalizeTimeoutMs(autoTimeout * 1000)
    : normalizeTimeoutMs(explicitTimeout);

  const directory = await fs.stat(runDir).catch(() => null);
  if (!directory?.isDirectory()) {
    const stderr = `Working directory is unavailable or is not a folder: ${runDir}. Reconnect the drive or choose the intended folder; this command has not run elsewhere.`;
    return {
      command: input.command,
      success: false,
      stdout: '',
      stderr,
      exitCode: 1,
      cwd: runDir,
      _consoleTraceEmitted: emitImmediateTerminalFailure(context, input.command, stderr, runDir, 1),
    };
  }

  let shell: string;
  try {
    shell = input.program ? 'direct' : resolveTerminalShell(input.shell || context?.terminalShell);
  } catch (error: any) {
    const stderr = String(error?.message || error);
    return {
      command: input.command,
      success: false,
      stdout: '',
      stderr,
      exitCode: 127,
      timedOut: false,
      cwd: runDir,
      _consoleTraceEmitted: emitImmediateTerminalFailure(context, input.command, stderr, runDir, 127),
    };
  }

  try {
    const authorization = await authorizeToolCommand({ command: input.command, cwd: runDir, env: input.env, context });
    const requestedProgram = input.program && /[\\/]/.test(input.program) ? path.resolve(runDir, input.program) : input.program;
    const useChatPython = /^(?:python|python3)(?:\.exe)?$/i.test(input.program || '');
    if (useChatPython && authorization.pythonRuntime?.issue) throw new Error(authorization.pythonRuntime.issue);
    const program = useChatPython ? authorization.pythonRuntime?.program
      : requestedProgram ? findExecutable([requestedProgram], authorization.env) : undefined;
    if (input.program && !program) throw new Error(`Executable not found: ${input.program}. Use the host executable paths supplied in runtime context or provide its installed absolute path.`);
    if (program && !useChatPython && /^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(path.basename(program))) {
      authorization.env = environmentForExplicitProgram(program, context, runDir, input.env);
    }
    if (program && process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(program)) {
      throw new Error('Windows batch files require shell=cmd and command. program + args is for native executables; use node with the package CLI script when appropriate.');
    }
    const result = await runTerminalCommandWithCheckIn({
      command: program ? describeProgram(program, input.args) : input.command,
      program: program || undefined,
      args: input.args,
      authorization,
      cwd: runDir,
      source: 'workspace_run_command',
      context,
      shell,
      checkInMs: input.background ? 1 : timeoutMs,
      hardTimeoutMs: undefined,
      maxOutputChars: terminalOutputPageChars(input.maxOutputChars, context?.contextCompaction?.activeContextWindow),
      outputKind: resolveTerminalOutputKind(input.command, input.outputKind),
      immediateHandoff: input.background === true,
      surviveRunSettlement: input.background === true,
    });

    const outputKind = resolveTerminalOutputKind(input.command, input.outputKind);
    const outputLimit = terminalOutputPageChars(input.maxOutputChars, context?.contextCompaction?.activeContextWindow);
    const page = outputKind === 'read' && result.taskId
      ? await getTerminalBackgroundTaskStatus(result.taskId, ownerChatId(context), 0, outputLimit) : null;
    const rawStdout = page ? String(page.stdout || '') : typeof result.stdout === 'string' ? result.stdout : String(result.output || '');
    const rawStderr = page ? String(page.stderr || '') : String(result.stderr || '');
    const stderrView = keepRecentOutput(rawStderr, Math.min(rawStderr.length,
      Math.max(Math.floor(outputLimit * 0.4), outputLimit - Math.min(rawStdout.length, outputLimit))));
    const bufferNotice = !page && Number(result.droppedOutputChars || 0) > 0
      ? '...[earlier terminal output omitted; this is not a complete source read]...\n' : '';
    const stdoutAllowance = Math.max(0, outputLimit - stderrView.text.length - bufferNotice.length);
    const stdoutView = outputKind === 'read'
      ? { text: rawStdout, dropped: 0 } : keepRecentOutput(rawStdout, stdoutAllowance);
    return {
      command: result.command || input.command,
      program: result.program,
      args: result.args,
      outputKind,
      success: Boolean(result.success),
      stdout: bufferNotice + stdoutView.text,
      stderr: stderrView.text,
      exitCode: result.stillRunning ? null : result.exitCode ?? (result.success ? 0 : 1),
      timedOut: Boolean(result.timedOut),
      timeoutMs: result.timeoutMs,
      processId: result.taskId,
      taskId: result.taskId,
      outputStart: page?.outputStart,
      outputEnd: page?.outputEnd ?? result.totalOutputChars,
      hasMoreOutput: page?.hasMoreOutput,
      nextOutputOffset: page?.nextOutputOffset,
      outputLimited: page?.outputLimited,
      outputFile: page?.outputFile,
      outputReadError: page?.outputReadError,
      outputPersistenceError: page?.outputPersistenceError ?? result.outputPersistenceError,
      statusPersistenceError: page?.statusPersistenceError ?? result.statusPersistenceError,
      streamId: result.streamId,
      nextActionNote: page?.nextActionNote || result.nextActionNote || (!result.success && !result.stillRunning
        ? terminalFailureAdvice(rawStderr || rawStdout, shell) : undefined),
      stillRunning: Boolean(result.stillRunning),
      backgroundTaskId: result.backgroundTaskId,
      totalOutputChars: page?.totalOutputChars ?? result.totalOutputChars,
      droppedOutputChars: Number(page?.droppedOutputChars ?? result.droppedOutputChars ?? 0) + stdoutView.dropped + stderrView.dropped,
      message: result.message,
      cwd: result.cwd || runDir,
      shell: result.shell || shell,
      // Do not discard this internal lifecycle marker. The managed terminal
      // has already emitted the authoritative per-process live/final stream;
      // losing the marker makes Main synthesize a second console card for the
      // same command (and one extra aggregate card for a parallel batch).
      _consoleTraceEmitted: result._consoleTraceEmitted === true,
    };
  } catch (error: any) {
    const stderr = String(error?.message || error);
    return {
      command: input.command,
      success: false,
      stdout: '',
      stderr,
      exitCode: 1,
      cwd: runDir,
      shell,
      _consoleTraceEmitted: emitImmediateTerminalFailure(context, input.command, stderr, runDir, 1, shell),
    };
  }
}

function terminalTaskResult(task: any, taskId: string, mode: string): any {
  if (!task?.terminalTask) {
    return {
      success: false, command: '', stdout: '',
      stderr: task?.error || `Managed terminal task not found: ${taskId}`,
      exitCode: 1, mode, taskId,
    };
  }
  const running = Boolean(task.running || task.status === 'running');
  const status = String(task.status || (running ? 'running' : 'unknown'));
  const killed = status === 'killed';
  return {
    success: mode === 'kill' ? killed : running || task.success !== false,
    command: task.command,
    program: task.program,
    args: task.args,
    outputKind: task.outputKind ?? resolveTerminalOutputKind(String(task.command || '')),
    // Output is the chronological combined stream; return it only once.
    stdout: String(task.output ?? task.stdout ?? ''),
    stderr: '',
    exitCode: running || status === 'unknown' ? null : task.exitCode ?? (task.success === false ? 1 : 0),
    timedOut: Boolean(task.timedOut),
    stillRunning: running,
    backgroundTaskId: task.background ? taskId : undefined,
    taskId,
    streamId: task.streamId,
    nextActionNote: task.nextActionNote,
    totalOutputChars: task.totalOutputChars,
    droppedOutputChars: task.droppedOutputChars,
    outputStart: task.outputStart,
    outputEnd: task.outputEnd,
    hasMoreOutput: task.hasMoreOutput,
    nextOutputOffset: task.nextOutputOffset,
    outputLimited: task.outputLimited,
    outputFile: task.outputFile,
    outputReadError: task.outputReadError,
    outputPersistenceError: task.outputPersistenceError,
    statusPersistenceError: task.statusPersistenceError,
    hasNewOutput: task.hasNewOutput,
    cwd: task.cwd,
    shell: task.shell,
    mode,
    status,
    _consoleTraceEmitted: task._consoleTraceEmitted === true,
    message: mode === 'kill'
      ? killed
        ? `Managed terminal task ${taskId} terminated.`
        : `Managed terminal task ${taskId} was not running (status: ${status}).`
      : task.message,
  };
}

/**
 * One terminal primitive covers repository discovery, targeted file reads,
 * search, execution, and verification on Windows, macOS, and Linux. It also
 * batches independent commands so several targeted reads can run in parallel.
 */
export const workspaceRunCommandTool: ToolDefinition = {
  name: 'workspace_run_command',
  modelDescription: 'Use program + args for native executables and Python/Node scripts without shell quoting; command is for shell syntax. Host/chat paths are supplied in runtime context. mode=run (default): provide exactly one of command, program (+ args), or commands:[{command or program,...}]. Batch independent reads/searches; up to six safe reads run concurrently, mutations stay ordered; parallel=false preserves dependencies. Foreground is the default. A check-in returns control without backgrounding or stopping the command. Only background=true on launch or mode=background explicitly backgrounds it. Continue independent work while it runs. mode=check reads now; mode=wait waits for output or completion. For several tasks, use one call with tasks:[{taskId,sinceOffset},...] instead of polling each separately. A grouped wait returns all snapshots when ANY task has output or settles, under one timeout; include only tasks still needing observation. For one task, use taskId and sinceOffset. Reuse each result’s outputEnd as its next sinceOffset; automatic runtime status is not delivered output. Empty output is not completion: inspect status/stillRunning. mode=list recovers IDs from this chat; background/kill require a single taskId. Never run task IDs or control modes as shell commands or relaunch a pending command. File/content reads retain exact output in bounded verbatim pages. If hasMoreOutput, check the returned taskId(s) from outputEnd, or narrow the search. Never rerun just to page output. Auto-detection covers literal readers/searches; outputKind=read supports other readers, log bounds noisy output. maxOutputChars is shared across batch output. Read complete relevant files/sections, not project dumps. Edit with workspace_edit_file.',
  description: 'Cross-platform workspace terminal for inspection, search, execution, package commands, managed processes, and verification. mode=run executes command or a commands batch. background=true returns a managed task immediately. mode=check/list/kill reads or controls managed tasks. File/code/content is retained exactly and delivered in bounded verbatim pages; use taskId and outputEnd to read remaining pages. Author source and text with workspace_edit_file; run generators, converters, builds and package tools here when the task requires them.',
  category: 'workspace',
  inputSchema: z.object({
    mode: z.enum(['run', 'check', 'wait', 'background', 'list', 'kill']).optional().describe('Defaults to run. check/wait accept taskId or tasks. background/kill use one taskId. wait returns on any watched output or completion.'),
    command: z.string().min(1).optional().describe('One command. For multiple independent reads/searches, prefer commands instead. Read complete small files or relevant function/type ranges in large files; do not repeatedly request tiny slices.'),
    program: z.string().min(1).optional().describe('Native executable name or absolute path. python/python3 select this chat’s runtime; explicit paths are honored. Use program + args to bypass shell quoting. Provide exactly one of command, program, or commands.'),
    args: z.array(z.string()).optional().describe('Arguments passed unchanged to program. Do not shell-quote individual arguments.'),
    shell: z.string().optional().describe('Shell preference for shell commands only; defaults to the chat setting.'),
    env: z.record(z.string(), z.string()).optional().describe('Environment overrides scoped to this invocation.'),
    commands: z.array(commandRequestSchema).min(1).max(32).optional().describe('Batch mode for independent terminal operations, especially parallel file reads and searches. Do not also provide command.'),
    taskId: z.string().optional().describe('One managed task for check/wait/background/kill. For several checks/waits, use tasks instead.'),
    tasks: z.array(z.object({
      taskId: z.string().min(1).describe('Managed task ID returned by a previous launch/check.'),
      sinceOffset: z.number().int().min(0).optional().describe('This task’s last delivered outputEnd. Omit only for its first read; runtime status does not advance this cursor.'),
    })).min(1).max(32).optional().describe('For check/wait only: read multiple tasks in one response under a shared output budget. wait returns when any has output or settles. Do not also supply taskId or a top-level sinceOffset.'),
    sinceOffset: z.number().int().min(0).optional().describe('For mode=check/wait, read from this character offset. Reuse outputEnd for the next exact page when hasMoreOutput is true, including after the command completes.'),
    cwd: z.string().optional().describe('Defaults to this chat selected project or dedicated working folder. Relative paths are literal. Use absolute OS folder paths from runtime context for Desktop/Documents/Downloads, or ~ for the home directory.'),
    timeoutSeconds: z.number().optional().describe('Foreground check-in in seconds, up to 120. This does not kill the command.'),
    background: z.boolean().optional().describe('Return immediately with a managed taskId. The process continues until it exits, is cancelled, or is killed.'),
    maxOutputChars: z.number().int().min(MIN_MODEL_OUTPUT_CHARS).max(MAX_MODEL_OUTPUT_CHARS).optional().describe(`Response page allowance in characters: default ${DEFAULT_MODEL_OUTPUT_CHARS}, maximum ${MAX_MODEL_OUTPUT_CHARS}, further limited by context capacity. Bounds combined batch output too. Remaining read output is retained; use taskId and outputEnd to continue.`),
    outputKind: z.enum(['read', 'log']).optional().describe('Optional retention hint: read retains file/code/content exactly and delivers bounded pages; log bounds noisy execution output. Standard literal reads/searches are recognized automatically. Shared by batch entries unless overridden. Does not authorize actions or make scripts parallel-safe.'),
    parallel: z.boolean().optional().describe('Independent literal reads/searches run concurrently by default. Mutations and unknown shell scripts remain ordered. Set false for dependencies; true never overrides safety.'),
  }),
  outputSchema: z.object({
    success: z.boolean().optional(),
    command: z.string().optional(),
    program: z.string().optional(),
    args: z.array(z.string()).optional(),
    outputKind: z.enum(['read', 'log', 'mixed']).optional(),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().nullable().optional(),
    timedOut: z.boolean().optional(),
    timeoutMs: z.number().optional(),
    processId: z.string().optional(),
    streamId: z.string().optional(),
    nextActionNote: z.string().optional(),
    stillRunning: z.boolean().optional(),
    backgroundTaskId: z.string().optional(),
    totalOutputChars: z.number().optional(),
    droppedOutputChars: z.number().optional(),
    outputStart: z.number().optional(),
    outputEnd: z.number().optional(),
    hasMoreOutput: z.boolean().optional(),
    nextOutputOffset: z.number().optional(),
    outputLimited: z.boolean().optional(),
    outputFile: z.string().optional(),
    outputReadError: z.string().optional(),
    hasNewOutput: z.boolean().optional(),
    cwd: z.string().optional(),
    shell: z.string().optional(),
    batch: z.boolean().optional(),
    mode: z.string().optional(),
    taskId: z.string().optional(),
    status: z.string().optional(),
    message: z.string().optional(),
    tasks: z.array(z.any()).optional(),
    _consoleTraceEmitted: z.boolean().optional(),
    results: z.array(z.object({
      command: z.string(),
      success: z.boolean(),
      exitCode: z.number().nullable().optional(),
      timedOut: z.boolean().optional(),
      stillRunning: z.boolean().optional(),
      backgroundTaskId: z.string().optional(),
      totalOutputChars: z.number().optional(),
      droppedOutputChars: z.number().optional(),
      cwd: z.string().optional(),
      shell: z.string().optional(),
      _consoleTraceEmitted: z.boolean().optional(),
    }).passthrough()).optional(),
  }),
  execute: async (input: WorkspaceTerminalInput, context: any) => {
    const mode = input.mode || 'run';
    if (!['run', 'check', 'wait', 'background', 'list', 'kill'].includes(mode)) {
      return { success: false, stdout: '', stderr: `Unsupported terminal mode: ${mode}. Host paths and shell details are already supplied in runtime context. Use run for a real command or list/check/wait/background/kill for managed processes.`, exitCode: 1, mode };
    }
    if (input.tasks !== undefined && mode !== 'check' && mode !== 'wait') {
      return { success: false, stdout: '', stderr: 'tasks is supported only for mode=check or mode=wait.', exitCode: 1, mode };
    }
    if (mode !== 'run' && !ownerChatId(context)) {
      return { success: false, stdout: '', stderr: 'A chat context is required to list, check, or stop terminal tasks.', exitCode: 1, mode };
    }
    if ((mode === 'check' || mode === 'wait') && input.tasks !== undefined) {
      if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > 32
        || input.taskId !== undefined || input.sinceOffset !== undefined) {
        return { success: false, stdout: '', stderr: 'Provide 1-32 tasks with their own sinceOffset values, without a top-level taskId or sinceOffset.', exitCode: 1, mode };
      }
      const requests = input.tasks.map(task => ({ taskId: safeTaskId(task?.taskId), sinceOffset: task?.sinceOffset }));
      if (requests.some(task => !task.taskId || (task.sinceOffset !== undefined && (!Number.isSafeInteger(task.sinceOffset) || task.sinceOffset < 0)))
        || new Set(requests.map(task => task.taskId)).size !== requests.length) {
        return { success: false, stdout: '', stderr: 'Each task needs a distinct taskId and an optional nonnegative integer sinceOffset.', exitCode: 1, mode };
      }
      const maxOutputChars = terminalOutputPageChars(input.maxOutputChars, context?.contextCompaction?.activeContextWindow);
      const snapshots = await readTerminalTasks(requests, ownerChatId(context)!, {
        timeoutMs: mode === 'wait'
          ? normalizeTimeoutMs(input.timeoutSeconds == null ? undefined : Math.max(1000, input.timeoutSeconds * 1000)) : 0,
        signal: context?.abortSignal,
        maxOutputChars,
      });
      const entries = snapshots.map((task, index) => {
        const result = terminalTaskResult(task, requests[index].taskId, mode);
        // One group hint replaces repeated per-task status prose. Keep recovery
        // details for missing handles, persistence failures, and unreadable pages.
        if (task?.terminalTask && result.status !== 'unknown' && !result.outputReadError
          && !result.outputPersistenceError && !result.statusPersistenceError) {
          result.message = undefined;
          result.nextActionNote = undefined;
        }
        return result;
      });
      const results = boundTerminalBatchEntries(entries, maxOutputChars);
      const runningCount = results.filter(task => task.stillRunning).length;
      const unknown = results.some(task => task.status === 'unknown');
      const success = results.every(task => task.success);
      const hasMoreOutput = results.some(task => task.hasMoreOutput);
      const reads = results.map(task => task.outputKind === 'read');
      return {
        success, stdout: '', stderr: '', batch: true, mode, results,
        outputKind: reads.every(Boolean) ? 'read' : reads.some(Boolean) ? 'mixed' : 'log',
        stillRunning: runningCount > 0,
        exitCode: runningCount > 0 || unknown ? null : success ? 0 : 1,
        status: unknown ? 'unknown' : undefined,
        timedOut: results.some(task => task.timedOut),
        hasMoreOutput,
        hasNewOutput: results.some(task => task.hasNewOutput),
        outputLimited: results.some(task => task.outputLimited),
        _consoleTraceEmitted: results.every(task => task._consoleTraceEmitted === true),
        message: `${results.length} terminal task(s); ${runningCount} still running.`,
        nextActionNote: hasMoreOutput || runningCount > 0
          ? 'Use one check/wait with tasks:[{taskId,sinceOffset:outputEnd},...] for tasks with unread output or ongoing work. Remove settled tasks whose output is consumed; keep each task’s own delivered cursor. A wait returns when any watched task has output or settles.'
          : undefined,
      };
    }
    if (mode === 'list') {
      const tasks = await listTerminalBackgroundTasks(ownerChatId(context));
      return {
        success: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
        mode,
        tasks,
        message: `${tasks.length} managed terminal task(s).`,
      };
    }
    if (mode === 'check' || mode === 'wait' || mode === 'background' || mode === 'kill') {
      const taskId = safeTaskId(input.taskId);
      if (!taskId) {
        return {
          success: false,
          stdout: '',
          stderr: `taskId is required for mode=${mode}.`,
          exitCode: 1,
          mode,
        };
      }
      let task: any;
      try {
        task = mode === 'check'
          ? await getTerminalBackgroundTaskStatus(taskId, ownerChatId(context), input.sinceOffset,
              terminalOutputPageChars(input.maxOutputChars, context?.contextCompaction?.activeContextWindow))
          : mode === 'wait'
            ? await waitTerminalTask(taskId, ownerChatId(context)!, normalizeTimeoutMs(input.timeoutSeconds == null ? undefined : Math.max(1000, input.timeoutSeconds * 1000)), input.sinceOffset, context?.abortSignal,
                terminalOutputPageChars(input.maxOutputChars, context?.contextCompaction?.activeContextWindow))
            : mode === 'background'
              ? await backgroundTerminalTask(taskId, ownerChatId(context)!)
              : await killTerminalBackgroundTask(taskId, ownerChatId(context));
      } catch (error) {
        return { success: false, stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 1, mode, taskId };
      }
      return terminalTaskResult(task, taskId, mode);
    }

    const hasSingle = typeof input.command === 'string' && input.command.trim().length > 0;
    const hasProgram = typeof input.program === 'string' && input.program.trim().length > 0;
    const hasBatch = Array.isArray(input.commands) && input.commands.length > 0;
    if (Number(hasSingle) + Number(hasProgram) + Number(hasBatch) !== 1 || (input.args && !hasProgram)) {
      return {
        success: false,
        stdout: '',
        stderr: 'Provide exactly one of command, program, or commands. args requires program.',
        exitCode: 1,
      };
    }

    if (hasSingle || hasProgram) {
      try { return await executeTerminalCommand({ ...input, command: input.command || describeProgram(input.program!, input.args) }, context); }
      catch (error) { return { success: false, stdout: '', stderr: String((error as Error).message || error), exitCode: 1 }; }
    }

    if (input.commands!.some(item => Boolean(item.command) === Boolean(item.program) || (item.args && !item.program))) {
      return { success: false, stdout: '', stderr: 'Each batch entry requires exactly one of command or program; args requires program.', exitCode: 1 };
    }
    const requests = input.commands!.map(item => ({
      ...item,
      command: item.command || describeProgram(item.program!, item.args),
      shell: item.shell ?? input.shell,
      env: { ...input.env, ...item.env },
      cwd: item.cwd ?? input.cwd,
      timeoutSeconds: item.timeoutSeconds ?? input.timeoutSeconds,
      background: item.background ?? input.background,
      maxOutputChars: item.maxOutputChars ?? input.maxOutputChars,
      outputKind: item.outputKind ?? input.outputKind,
    }));
    const calls = requests.map(args => ({ name: 'workspace_run_command', args }));
    const skippedCommand = (call: typeof calls[number]): TerminalCommandResult => ({
      command: call.args.command,
      cwd: call.args.cwd,
      success: false,
      stdout: '',
      stderr: 'CANCELLED_BY_USER: command was not started.',
      exitCode: 1,
    });
    const results = await executeParallelToolCalls(calls, async (call): Promise<TerminalCommandResult> => {
      try { return await executeTerminalCommand(call.args, context); }
      catch (error) {
        return {
          command: call.args.command,
          cwd: call.args.cwd,
          success: false,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
        };
      }
    }, {
      maxParallel: input.parallel === false ? 1 : 6,
      shouldStop: () => context?.abortSignal?.aborted === true,
      onSkipped: skippedCommand,
    });

    const reads = requests.map(request => resolveTerminalOutputKind(request.command, request.outputKind) === 'read');
    const sections = results.flatMap((result, index) => ['stdout', 'stderr'].map(field => ({
      text: result[field as 'stdout' | 'stderr']
        ? `[command ${index + 1}] ${result.command}\n${result[field as 'stdout' | 'stderr']}` : '',
      preserve: reads[index],
    })));
    const views = fitBatchOutput(sections, terminalOutputPageChars(input.maxOutputChars, context?.contextCompaction?.activeContextWindow))
      .map((view, index) => {
        const commandIndex = Math.floor(index / 2);
        const headerLength = `[command ${commandIndex + 1}] ${results[commandIndex].command}\n`.length;
        // An allowance smaller than the label delivered no source characters.
        // Omit that label so exact read lengths still frame the other siblings.
        return sections[index].preserve && view.text.length > 0 && view.text.length <= headerLength
          ? { text: '', dropped: sections[index].text.length } : view;
      });
    const stdout = views.filter((_, index) => index % 2 === 0).map(view => view.text).filter(Boolean).join('\n\n');
    const stderr = views.filter((_, index) => index % 2 === 1).map(view => view.text).filter(Boolean).join('\n\n');
    const metadata = results.map(({ stdout, stderr: _stderr, ...result }, index) => {
      // Frame the presentation without parsing delimiters inside arbitrary
      // command output. The model compactor removes this internal field.
      const framed = { ...result, _outputSectionChars: [views[index * 2].text.length, views[index * 2 + 1].text.length] };
      if (!reads[index] || !result.taskId || result.outputReadError) return framed;
      const delivered = Math.max(0, stdout.length - views[index * 2].dropped);
      const outputEnd = (result.outputStart || 0) + delivered;
      const hasMoreOutput = outputEnd < Number(result.totalOutputChars || 0);
      return {
        ...framed, outputEnd, hasMoreOutput, outputLimited: result.outputLimited || hasMoreOutput,
        nextOutputOffset: hasMoreOutput ? outputEnd : undefined,
        nextActionNote: hasMoreOutput
          ? `Read the next exact page with mode="check", taskId="${result.taskId}", sinceOffset=${outputEnd}. Do not rerun this command to retrieve output.`
          : result.nextActionNote,
      };
    });
    const runningTasks = results.filter(result => result.stillRunning);
    const cwdValues = [...new Set(results.map(result => result.cwd).filter(Boolean))];
    const shellValues = [...new Set(results.map(result => result.shell).filter(Boolean))];

    return {
      success: results.every(result => result.success),
      stdout,
      stderr,
      outputKind: reads.every(Boolean) ? 'read' : reads.some(Boolean) ? 'mixed' : 'log',
      hasMoreOutput: metadata.some(result => result.hasMoreOutput),
      outputLimited: metadata.some(result => result.outputLimited),
      exitCode: runningTasks.length > 0 ? null : results.every(result => result.success) ? 0 : 1,
      timedOut: results.some(result => result.timedOut),
      stillRunning: runningTasks.length > 0,
      nextActionNote: runningTasks.length > 0
        ? `${runningTasks.length} command(s) are still running. Use one mode=wait/check with tasks:[{taskId,sinceOffset:outputEnd},...] for their results. They are background tasks only when explicitly requested.`
        : metadata.some(result => result.hasMoreOutput)
          ? 'Read remaining pages together with mode=check and tasks:[{taskId,sinceOffset:outputEnd},...]. Use each result’s own offset; do not rerun commands.'
          : undefined,
      totalOutputChars: results.reduce((sum, result) => sum + Number(result.totalOutputChars ?? result.stdout.length + result.stderr.length), 0),
      droppedOutputChars: results.reduce((sum, result) => sum + Number(result.droppedOutputChars || 0), 0)
        + views.reduce((sum, view, index) => sum + (sections[index].preserve ? 0 : view.dropped), 0),
      cwd: cwdValues.length === 1 ? cwdValues[0] : undefined,
      shell: shellValues.length === 1 ? shellValues[0] : undefined,
      batch: true,
      // Every child command uses the managed terminal publisher. Keep Main
      // from adding a synthetic aggregate console lifecycle on top of those
      // independently keyed streams.
      _consoleTraceEmitted: results.every(result => result._consoleTraceEmitted === true),
      results: metadata,
    };
  },
};
