import { z } from 'zod';
import fs from 'fs-extra';
import { ToolDefinition } from '../../schemas';
import { resolveWorkspaceDirectoryForContext } from '../../workspace/path_resolver';
import { normalizeTimeoutMs } from '../core/terminal_timeout';
import {
  getTerminalBackgroundTaskStatus,
  killTerminalBackgroundTask,
  listTerminalBackgroundTasks,
  runTerminalCommandWithCheckIn,
} from '../core/terminal_background';
import { resolveTerminalShell } from '../core/shell_resolver';
import { referencesDesktopHelperScript } from '../shared/desktop_guard';
import { groupParallelToolCalls } from '../../parallel-tool-calls';
import { isSourceReadShellCommand } from '../../shell-command-shape';
import {
  MIN_TERMINAL_OUTPUT_CHARS, MAX_TERMINAL_OUTPUT_CHARS, explicitOutputChars,
  resolveTerminalOutputKind, type TerminalOutputKind,
} from '../../source-read-policy';

const DEFAULT_MODEL_OUTPUT_CHARS = 24_000;
const MIN_MODEL_OUTPUT_CHARS = MIN_TERMINAL_OUTPUT_CHARS;
const MAX_MODEL_OUTPUT_CHARS = MAX_TERMINAL_OUTPUT_CHARS;

type TerminalCommandRequest = {
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
  timeoutMs?: number;
  background?: boolean;
  maxOutputChars?: number;
  outputKind?: TerminalOutputKind;
};

type TerminalCommandResult = {
  command: string;
  outputKind?: TerminalOutputKind;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
  timeoutMs?: number;
  processId?: string;
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
  mode?: 'run' | 'check' | 'list' | 'kill';
  command?: string;
  commands?: TerminalCommandRequest[];
  taskId?: string;
  sinceOffset?: number;
  parallel?: boolean;
};

const commandRequestSchema = z.object({
  command: z.string().min(1).describe('Exact command for the runtime OS and selected shell.'),
  cwd: z.string().optional().describe('Optional working directory override for this command.'),
  timeoutSeconds: z.number().optional().describe('Optional foreground check-in override for this command, up to 120 seconds.'),
  background: z.boolean().optional().describe('Start this command immediately as a managed background process.'),
  maxOutputChars: z.number().int().min(MIN_MODEL_OUTPUT_CHARS).max(MAX_MODEL_OUTPUT_CHARS).optional().describe('Optional log-output allowance. File/content reads are not clipped.'),
  outputKind: z.enum(['read', 'log']).optional().describe('Auto-detected for standard commands. read preserves file/code/content output exactly; log bounds noisy execution output. Overrides the shared outputKind, not execution safety.'),
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
  if (resolveTerminalOutputKind(command, outputKind) === 'read') return Number.POSITIVE_INFINITY;
  const explicit = explicitOutputChars(value);
  if (explicit !== undefined) return explicit;
  return DEFAULT_MODEL_OUTPUT_CHARS;
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
  const value = String(context?.chatId || context?.projectId || '').trim();
  return value || undefined;
}

/** File/content sections are exempt; only logs share the batch allowance. */
function fitBatchOutput(sections: { text: string; preserve: boolean }[], maxChars: number): { text: string; dropped: number }[] {
  const allocations = new Array(sections.length).fill(0);
  const bounded = sections.map((section, index) => ({ ...section, index }))
    .filter(section => !section.preserve && section.text.length > 0);
  let remaining = Math.max(0, maxChars - Math.max(0, bounded.length - 1) * 2);
  const bySize = bounded.sort((a, b) => a.text.length - b.text.length);
  bySize.forEach((section, index) => {
    const share = Math.floor(remaining / (bySize.length - index));
    allocations[section.index] = Math.min(share, section.text.length);
    remaining -= allocations[section.index];
  });
  return sections.map((section, index) => section.preserve
    ? { text: section.text, dropped: 0 } : keepRecentOutput(section.text, allocations[index]));
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
  const explicitTimeout = input.timeoutSeconds ?? input.timeoutMs;
  const timeoutMs = autoTimeout > 0 && !explicitTimeout
    ? normalizeTimeoutMs(autoTimeout)
    : normalizeTimeoutMs(explicitTimeout);

  if (!await fs.pathExists(runDir)) {
    const stderr = `Working directory not found: ${runDir}`;
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

  if (referencesDesktopHelperScript(input.command, runDir)) {
    const stderr = 'This command references a helper script directly on the Desktop root. Use the computer tool for UI automation, or move an intentional project script into the project directory.';
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
    shell = resolveTerminalShell(context?.terminalShell);
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
    const result = await runTerminalCommandWithCheckIn({
      command: input.command,
      cwd: runDir,
      source: 'workspace_run_command',
      context,
      shell,
      checkInMs: input.background ? 1 : timeoutMs,
      hardTimeoutMs: undefined,
      maxOutputChars: normalizeModelOutputChars(input.maxOutputChars),
      outputKind: resolveTerminalOutputKind(input.command, input.outputKind),
      immediateHandoff: input.background === true,
      surviveRunSettlement: input.background === true,
    });

    const outputKind = resolveTerminalOutputKind(input.command, input.outputKind);
    const outputLimit = resolveModelOutputChars(input.command, input.maxOutputChars, outputKind);
    const rawStdout = typeof result.stdout === 'string' ? result.stdout : String(result.output || '');
    const rawStderr = String(result.stderr || '');
    const stderrView = keepRecentOutput(rawStderr, Math.min(rawStderr.length,
      Math.max(Math.floor(outputLimit * 0.4), outputLimit - Math.min(rawStdout.length, outputLimit))));
    const bufferNotice = Number(result.droppedOutputChars || 0) > 0
      ? '...[earlier terminal output omitted; this is not a complete source read]...\n' : '';
    const stdoutAllowance = Math.max(0, outputLimit - stderrView.text.length - bufferNotice.length);
    const stdoutView = outputKind === 'read'
      ? { text: rawStdout, dropped: 0 } : keepRecentOutput(rawStdout, stdoutAllowance);
    return {
      command: input.command,
      outputKind,
      success: Boolean(result.success),
      stdout: bufferNotice + stdoutView.text,
      stderr: stderrView.text,
      exitCode: result.stillRunning ? null : result.exitCode ?? (result.success ? 0 : 1),
      timedOut: Boolean(result.timedOut),
      timeoutMs: result.timeoutMs,
      processId: result.taskId,
      streamId: result.streamId,
      nextActionNote: result.nextActionNote,
      stillRunning: Boolean(result.stillRunning),
      backgroundTaskId: result.backgroundTaskId || result.taskId,
      totalOutputChars: result.totalOutputChars,
      droppedOutputChars: Number(result.droppedOutputChars || 0) + stdoutView.dropped + stderrView.dropped,
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

/**
 * One terminal primitive covers repository discovery, targeted file reads,
 * search, execution, and verification on Windows, macOS, and Linux. It also
 * batches independent commands so several targeted reads can run in parallel.
 */
export const workspaceRunCommandTool: ToolDefinition = {
  name: 'workspace_run_command',
  modelDescription: 'mode=run (default): provide command OR commands:[{command,...}], never both. Batch independent reads/searches; up to six safe reads run concurrently, mutations stay ordered; parallel=false preserves dependencies. File/code/content reads are not clipped or summarized. Auto-detection covers literal readers/searches; set outputKind=read for other readers, log for noisy execution. maxOutputChars limits logs only. Read complete relevant files/sections, not project dumps: model context is finite. background=true returns a task ID, not completion. mode=check/kill requires returned taskId; check reuses outputEnd as sinceOffset. mode=list needs no taskId. Edit with workspace_edit_file.',
  description: 'Cross-platform workspace terminal for inspection, search, execution, package commands, managed processes, and verification. mode=run executes command or a commands batch. background=true returns a managed task immediately. mode=check/list/kill reads or controls managed tasks. File/code/content reads remain exact; output limits apply only to logs. File mutations belong to workspace_edit_file.',
  category: 'workspace',
  inputSchema: z.object({
    mode: z.enum(['run', 'check', 'list', 'kill']).optional().describe('Defaults to run. check and kill require a returned taskId.'),
    command: z.string().min(1).optional().describe('One command. For multiple independent reads/searches, prefer commands instead. Read complete small files or relevant function/type ranges in large files; do not repeatedly request tiny slices.'),
    commands: z.array(commandRequestSchema).min(1).max(32).optional().describe('Batch mode for independent terminal operations, especially parallel file reads and searches. Do not also provide command.'),
    taskId: z.string().optional().describe('Managed terminal task ID required by mode=check or mode=kill.'),
    sinceOffset: z.number().int().min(0).optional().describe('For mode=check, return only output produced after this offset. Reuse outputEnd from the previous check.'),
    cwd: z.string().optional().describe('Shared working directory. Prefer an absolute path, or use a path relative to the active user workspace. With no selected workspace, the runtime scratch root is used.'),
    timeoutSeconds: z.number().optional().describe('Foreground check-in in seconds, up to 120. This does not kill the command.'),
    background: z.boolean().optional().describe('Return immediately with a managed taskId. The process continues until it exits, is cancelled, or is killed.'),
    maxOutputChars: z.number().int().min(MIN_MODEL_OUTPUT_CHARS).max(MAX_MODEL_OUTPUT_CHARS).optional().describe(`Log-output allowance in characters: default ${DEFAULT_MODEL_OUTPUT_CHARS}, maximum ${MAX_MODEL_OUTPUT_CHARS}; also bounds combined logs in a batch. Does not truncate file/code/content reads.`),
    outputKind: z.enum(['read', 'log']).optional().describe('Optional retention hint: read returns file/code/content output intact; log bounds noisy execution output. Standard literal reads/searches are recognized automatically. Shared by batch entries unless overridden. Does not authorize actions or make scripts parallel-safe.'),
    parallel: z.boolean().optional().describe('Independent literal reads/searches run concurrently by default. Mutations and unknown shell scripts remain ordered. Set false for dependencies; true never overrides safety.'),
  }),
  outputSchema: z.object({
    success: z.boolean().optional(),
    command: z.string().optional(),
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
    if (mode === 'check' || mode === 'kill') {
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
      const task = mode === 'check'
        ? await getTerminalBackgroundTaskStatus(taskId, ownerChatId(context), input.sinceOffset)
        : await killTerminalBackgroundTask(taskId, ownerChatId(context));
      if (!task?.terminalTask) {
        return {
          success: false,
          stdout: '',
          stderr: `Managed terminal task not found: ${taskId}`,
          exitCode: 1,
          mode,
          taskId,
        };
      }
      const running = Boolean(task.running || task.status === 'running');
      const status = String(task.status || (running ? 'running' : 'unknown'));
      const killed = status === 'killed';
      const output = String(task.output ?? task.stdout ?? '');
      return {
        success: mode === 'kill' ? killed : running || task.success !== false,
        command: task.command,
        outputKind: task.outputKind ?? resolveTerminalOutputKind(String(task.command || '')),
        // `output` is the chronological combined stream. Returning stdout,
        // stderr, and output repeated the same terminal text up to three times.
        stdout: output,
        stderr: '',
        exitCode: running ? null : task.exitCode ?? (task.success === false ? 1 : 0),
        timedOut: Boolean(task.timedOut),
        stillRunning: running,
        backgroundTaskId: taskId,
        taskId,
        streamId: task.streamId,
        nextActionNote: task.nextActionNote,
        totalOutputChars: task.totalOutputChars,
        droppedOutputChars: task.droppedOutputChars,
        outputStart: task.outputStart,
        outputEnd: task.outputEnd,
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

    const hasSingle = typeof input.command === 'string' && input.command.trim().length > 0;
    const hasBatch = Array.isArray(input.commands) && input.commands.length > 0;
    if (hasSingle === hasBatch) {
      return {
        success: false,
        stdout: '',
        stderr: 'Provide exactly one of command or commands.',
        exitCode: 1,
      };
    }

    if (hasSingle) {
      return executeTerminalCommand({ ...input, command: input.command! }, context);
    }

    const requests = input.commands!.map(item => ({
      ...item,
      cwd: item.cwd ?? input.cwd,
      timeoutSeconds: item.timeoutSeconds ?? input.timeoutSeconds,
      background: item.background ?? input.background,
      maxOutputChars: item.maxOutputChars ?? input.maxOutputChars,
      outputKind: item.outputKind ?? input.outputKind,
    }));
    const results: TerminalCommandResult[] = [];
    const calls = requests.map(args => ({ name: 'workspace_run_command', args }));
    const groups = input.parallel === false ? calls.map(call => [call]) : groupParallelToolCalls(calls);
    for (const group of groups) {
      const settled = await Promise.allSettled(group.map(call => executeTerminalCommand(call.args, context)));
      for (let index = 0; index < settled.length; index++) {
        const result = settled[index];
        results.push(result.status === 'fulfilled' ? result.value : {
          command: group[index].args.command,
          cwd: group[index].args.cwd,
          success: false,
          stdout: '',
          stderr: result.reason instanceof Error ? result.reason.message : String(result.reason),
          exitCode: 1,
        });
      }
    }

    const reads = requests.map(request => resolveTerminalOutputKind(request.command, request.outputKind) === 'read');
    const sections = results.flatMap((result, index) => ['stdout', 'stderr'].map(field => ({
      text: result[field as 'stdout' | 'stderr']
        ? `[command ${index + 1}] ${result.command}\n${result[field as 'stdout' | 'stderr']}` : '',
      preserve: reads[index],
    })));
    const views = fitBatchOutput(sections, normalizeModelOutputChars(input.maxOutputChars));
    const stdout = views.filter((_, index) => index % 2 === 0).map(view => view.text).filter(Boolean).join('\n\n');
    const stderr = views.filter((_, index) => index % 2 === 1).map(view => view.text).filter(Boolean).join('\n\n');
    const metadata = results.map(({ stdout: _stdout, stderr: _stderr, ...result }) => result);
    const runningTasks = results.filter(result => result.stillRunning);
    const cwdValues = [...new Set(results.map(result => result.cwd).filter(Boolean))];
    const shellValues = [...new Set(results.map(result => result.shell).filter(Boolean))];

    return {
      success: results.every(result => result.success),
      stdout,
      stderr,
      outputKind: reads.every(Boolean) ? 'read' : reads.some(Boolean) ? 'mixed' : 'log',
      exitCode: runningTasks.length > 0 ? null : results.every(result => result.success) ? 0 : 1,
      timedOut: results.some(result => result.timedOut),
      stillRunning: runningTasks.length > 0,
      nextActionNote: runningTasks.length > 0
        ? `${runningTasks.length} command(s) continue as managed background tasks; use their task IDs to inspect later output.`
        : undefined,
      totalOutputChars: results.reduce((sum, result) => sum + Number(result.totalOutputChars ?? result.stdout.length + result.stderr.length), 0),
      droppedOutputChars: results.reduce((sum, result) => sum + Number(result.droppedOutputChars || 0), 0) + views.reduce((sum, view) => sum + view.dropped, 0),
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
