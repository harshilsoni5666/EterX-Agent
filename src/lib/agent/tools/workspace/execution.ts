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
  cwd?: string;
  shell?: string;
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

function normalizeModelOutputChars(value: unknown): number {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return DEFAULT_MODEL_OUTPUT_CHARS;
  return Math.max(MIN_MODEL_OUTPUT_CHARS, Math.min(MAX_MODEL_OUTPUT_CHARS, Math.floor(requested)));
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

function ownerChatId(context: any): string | undefined {
  const value = String(context?.chatId || context?.projectId || '').trim();
  return value || undefined;
}

function safeTaskId(value: unknown): string {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
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
    return {
      command: input.command,
      success: false,
      stdout: '',
      stderr: `Working directory not found: ${runDir}`,
      exitCode: 1,
      cwd: runDir,
    };
  }

  if (referencesDesktopHelperScript(input.command, runDir)) {
    return {
      command: input.command,
      success: false,
      stdout: '',
      stderr: 'This command references a helper script directly on the Desktop root. Use the computer tool for UI automation, or move an intentional project script into the project directory.',
      exitCode: 1,
      cwd: runDir,
    };
  }

  let shell: string;
  try {
    shell = resolveTerminalShell(context?.terminalShell);
  } catch (error: any) {
    return {
      command: input.command,
      success: false,
      stdout: '',
      stderr: String(error?.message || error),
      exitCode: 127,
      timedOut: false,
      cwd: runDir,
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
      cwd: result.cwd || runDir,
      shell: result.shell || shell,
    };
  } catch (error: any) {
    return {
      command: input.command,
      success: false,
      stdout: '',
      stderr: String(error?.message || error),
      exitCode: 1,
      cwd: runDir,
      shell,
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
  description: 'The complete cross-platform terminal for workspace inspection, file and directory reading, metadata, search, execution, package commands, managed background processes, and verification. mode=run accepts command for one operation or commands for independent operations in one call. Use mode=check/list/kill to manage handed-off tasks without another tool. Prefer rg/rg --files, request targeted output, use cwd instead of a cd prefix, and set parallel=false when batched commands depend on each other. File creation and source edits belong to workspace_edit_file so the UI receives real diffs.',
  category: 'workspace',
  inputSchema: z.object({
    mode: z.enum(['run', 'check', 'list', 'kill']).optional().describe('Defaults to run. Use check/list/kill to inspect or stop managed background terminal tasks.'),
    command: z.string().min(1).optional().describe('Single-command mode. Exact command for the runtime OS and selected shell. Use for file discovery, targeted reads, text search, metadata, scripts, builds, linting, and tests.'),
    commands: z.array(commandRequestSchema).min(1).max(32).optional().describe('Batch mode for independent terminal operations, especially parallel file reads and searches. Do not also provide command.'),
    taskId: z.string().optional().describe('Managed terminal task ID required by mode=check or mode=kill.'),
    sinceOffset: z.number().int().min(0).optional().describe('For mode=check, return only output produced after this offset. Reuse outputEnd from the previous check.'),
    cwd: z.string().optional().describe('Shared working directory. Prefer an absolute path, or use a path relative to the active user workspace. With no selected workspace, the runtime scratch root is used.'),
    timeoutSeconds: z.number().optional().describe('Shared foreground check-in in seconds, up to 120. This is not a kill deadline: a still-running command is handed off as a managed background task.'),
    background: z.boolean().optional().describe('Shared background default for installations, servers, watchers, and other long-running work.'),
    maxOutputChars: z.number().int().min(MIN_MODEL_OUTPUT_CHARS).max(MAX_MODEL_OUTPUT_CHARS).optional().describe('Maximum recent terminal characters returned to the model. Default 24000. In batch mode this also bounds the combined response.'),
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
      .filter(result => result.stdout)
      .map((result, index) => `[command ${index + 1}] ${result.command}\n${result.stdout}`)
      .join('\n\n');
    const stderrRaw = results
      .filter(result => result.stderr)
      .map((result, index) => `[command ${index + 1}] ${result.command}\n${result.stderr}`)
      .join('\n\n');
    const combinedLimit = normalizeModelOutputChars(input.maxOutputChars);
    const stderrAllowance = Math.min(stderrRaw.length, Math.floor(combinedLimit * 0.4));
    const stderrView = keepRecentOutput(stderrRaw, stderrAllowance || combinedLimit);
    const stdoutView = keepRecentOutput(stdoutRaw, Math.max(0, combinedLimit - stderrView.text.length));
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
      results: metadata,
    };
  },
};
