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

const DEFAULT_MODEL_OUTPUT_CHARS = 24_000;
const DEFAULT_SOURCE_READ_OUTPUT_CHARS = 128_000;
const MIN_MODEL_OUTPUT_CHARS = 4_000;
const MAX_MODEL_OUTPUT_CHARS = 256_000;

type TerminalCommandRequest = {
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
  timeoutMs?: number;
  background?: boolean;
  maxOutputChars?: number;
};

type TerminalCommandResult = {
  command: string;
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
  maxOutputChars: z.number().int().min(MIN_MODEL_OUTPUT_CHARS).max(MAX_MODEL_OUTPUT_CHARS).optional().describe('Optional output allowance for this command.'),
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
  const requested = Number(value);
  if (!Number.isFinite(requested)) return DEFAULT_MODEL_OUTPUT_CHARS;
  return Math.max(MIN_MODEL_OUTPUT_CHARS, Math.min(MAX_MODEL_OUTPUT_CHARS, Math.floor(requested)));
}

/**
 * Whole-file and source-range reads need their beginning (imports, types, and
 * declarations) just as much as their end. Build, test, and log commands are
 * deliberately excluded so their noisy output keeps the smaller recent-output
 * window.
 */
export function isSourceReadCommand(command: string): boolean {
  const normalized = String(command || '')
    .replace(/\r?\n/g, ' ')
    .trim();
  if (!normalized) return false;

  return [
    /\bget-content\b/i,
    /(?:\[system\.)?\[?io\.file\]?::readalltext\b/i,
    /(?:^|[;&|]\s*)gc\b/i,
    /(?:^|[;&|]\s*)(?:cat|bat|head|tail|less|more|nl)\b/i,
    /(?:^|[;&|]\s*)type\s+(?!nul\b)/i,
    /(?:^|[;&|]\s*)sed\s+-n\b/i,
    /(?:^|[;&|]\s*)awk\b/i,
    /(?:^|[;&|]\s*)git\s+(?:show|diff)\b/i,
  ].some(pattern => pattern.test(normalized));
}

export function resolveModelOutputChars(command: string, value: unknown): number {
  if (Number.isFinite(Number(value))) return normalizeModelOutputChars(value);
  return isSourceReadCommand(command)
    ? DEFAULT_SOURCE_READ_OUTPUT_CHARS
    : DEFAULT_MODEL_OUTPUT_CHARS;
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
      maxOutputChars: resolveModelOutputChars(input.command, input.maxOutputChars),
      immediateHandoff: input.background === true,
      surviveRunSettlement: input.background === true,
    });

    return {
      command: input.command,
      success: Boolean(result.success),
      stdout: result.stdout || result.output || '',
      stderr: result.stderr || '',
      exitCode: result.stillRunning ? null : result.exitCode ?? (result.success ? 0 : 1),
      timedOut: Boolean(result.timedOut),
      timeoutMs: result.timeoutMs,
      processId: result.taskId,
      streamId: result.streamId,
      nextActionNote: result.nextActionNote,
      stillRunning: Boolean(result.stillRunning),
      backgroundTaskId: result.backgroundTaskId || result.taskId,
      totalOutputChars: result.totalOutputChars,
      droppedOutputChars: result.droppedOutputChars,
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
  description: 'Cross-platform workspace terminal for inspection, search, execution, package commands, managed processes, and verification. mode=run executes command or a commands batch. background=true returns a managed task immediately. mode=check/list/kill reads or controls managed tasks. Source reads have a larger bounded output allowance than other commands. File mutations belong to workspace_edit_file.',
  category: 'workspace',
  inputSchema: z.object({
    mode: z.enum(['run', 'check', 'list', 'kill']).optional().describe('Defaults to run. check and kill require a returned taskId.'),
    command: z.string().min(1).optional().describe('Single-command mode. Exact command for the runtime OS and selected shell. Use for file discovery, targeted reads, text search, metadata, scripts, builds, linting, and tests.'),
    commands: z.array(commandRequestSchema).min(1).max(32).optional().describe('Batch mode for independent terminal operations, especially parallel file reads and searches. Do not also provide command.'),
    taskId: z.string().optional().describe('Managed terminal task ID required by mode=check or mode=kill.'),
    sinceOffset: z.number().int().min(0).optional().describe('For mode=check, return only output produced after this offset. Reuse outputEnd from the previous check.'),
    cwd: z.string().optional().describe('Shared working directory. Prefer an absolute path, or use a path relative to the active user workspace. With no selected workspace, the runtime scratch root is used.'),
    timeoutSeconds: z.number().optional().describe('Foreground check-in in seconds, up to 120. This does not kill the command.'),
    background: z.boolean().optional().describe('Return immediately with a managed taskId. The process continues until it exits, is cancelled, or is killed.'),
    maxOutputChars: z.number().int().min(MIN_MODEL_OUTPUT_CHARS).max(MAX_MODEL_OUTPUT_CHARS).optional().describe('Explicit terminal output allowance. Defaults to 128000 for recognized source reads and 24000 for builds, tests, logs, and other commands. In batch mode this also bounds the combined response.'),
    parallel: z.boolean().optional().describe('Batch mode only. Run commands concurrently by default; set false when one command depends on an earlier command.'),
  }),
  outputSchema: z.object({
    success: z.boolean().optional(),
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
    }));
    let results: TerminalCommandResult[];
    if (input.parallel !== false) {
      results = await Promise.all(requests.map(request => executeTerminalCommand(request, context)));
    } else {
      results = [];
      for (const request of requests) results.push(await executeTerminalCommand(request, context));
    }

    const stdoutRaw = results
      .map((result, index) => result.stdout
        ? `[command ${index + 1}] ${result.command}\n${result.stdout}`
        : '')
      .filter(Boolean)
      .join('\n\n');
    const stderrRaw = results
      .map((result, index) => result.stderr
        ? `[command ${index + 1}] ${result.command}\n${result.stderr}`
        : '')
      .filter(Boolean)
      .join('\n\n');
    const combinedLimit = Number.isFinite(Number(input.maxOutputChars))
      ? normalizeModelOutputChars(input.maxOutputChars)
      : Math.min(
          MAX_MODEL_OUTPUT_CHARS,
          requests.reduce((sum, request) => sum + resolveModelOutputChars(request.command, request.maxOutputChars), 0),
        );
    const includesSourceReads = requests.some(request => isSourceReadCommand(request.command));
    const stderrAllowance = Math.min(stderrRaw.length, Math.floor(combinedLimit * 0.4));
    const stderrView = keepRecentOutput(stderrRaw, stderrAllowance || combinedLimit);
    const stdoutAllowance = Math.max(0, combinedLimit - stderrView.text.length);
    const stdoutView = includesSourceReads
      ? keepHeadAndTailOutput(stdoutRaw, stdoutAllowance)
      : keepRecentOutput(stdoutRaw, stdoutAllowance);
    const metadata = results.map(({ stdout: _stdout, stderr: _stderr, ...result }) => result);
    const runningTasks = results.filter(result => result.stillRunning);
    const cwdValues = [...new Set(results.map(result => result.cwd).filter(Boolean))];
    const shellValues = [...new Set(results.map(result => result.shell).filter(Boolean))];

    return {
      success: results.every(result => result.success),
      stdout: stdoutView.text,
      stderr: stderrView.text,
      exitCode: runningTasks.length > 0 ? null : results.every(result => result.success) ? 0 : 1,
      timedOut: results.some(result => result.timedOut),
      stillRunning: runningTasks.length > 0,
      nextActionNote: runningTasks.length > 0
        ? `${runningTasks.length} command(s) continue as managed background tasks; use their task IDs to inspect later output.`
        : undefined,
      totalOutputChars: results.reduce((sum, result) => sum + Number(result.totalOutputChars ?? result.stdout.length + result.stderr.length), 0),
      droppedOutputChars: results.reduce((sum, result) => sum + Number(result.droppedOutputChars || 0), 0) + stdoutView.dropped + stderrView.dropped,
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
