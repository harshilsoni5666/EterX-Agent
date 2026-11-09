import { ChildProcess, execFile, spawn } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs-extra';
import { StringDecoder } from 'string_decoder';
import {
  normalizeCheckInMs,
  normalizeHardTimeoutMs,
  secondsFromTimeoutMs,
  terminalBackgroundHandoffNote,
  terminalTimeoutNote
} from './terminal_timeout';
import { authorizeToolCommand } from '../security/command_broker';
import { buildTerminalShellInvocation } from './shell_resolver';
import { getEterxWorkspaceDir } from '../../storage-paths';
import { managedWorkspaces } from '../../workspace/managed';
import { resolveTerminalOutputKind, terminalOutputPageChars, type TerminalOutputKind } from '../../source-read-policy';

type TerminalTaskStatus = 'running' | 'completed' | 'failed' | 'killed';

export interface TerminalCommandRunOptions {
  command: string;
  cwd: string;
  source: string;
  context?: any;
  /**
   * Reuse a decision made by a higher-level tool.  Background/process tools
   * already authorize once to resolve the final cwd and environment; doing a
   * second broker pass here made launches needlessly slow and could reject the
   * same command on the second pass.
   */
  authorization?: { cwd: string; env: NodeJS.ProcessEnv };
  description?: string;
  shell?: boolean | string;
  /** Direct executable invocation; args are passed unchanged, never as shell text. */
  program?: string;
  args?: string[];
  env?: Partial<NodeJS.ProcessEnv>;
  checkInMs?: number;
  hardTimeoutMs?: number;
  maxOutputChars?: number;
  outputKind?: TerminalOutputKind;
  traceThrottleMs?: number;
  immediateHandoff?: boolean;
  surviveRunSettlement?: boolean;
}

export interface TerminalBackgroundTask {
  id: string;
  command: string;
  program?: string;
  args?: string[];
  description: string;
  source: string;
  /** Chat/project owner. Terminal task IDs must not cross chat boundaries. */
  ownerChatId?: string;
  cwd: string;
  shell?: string;
  pid?: number;
  status: TerminalTaskStatus;
  startedAt: number;
  lastActivityAt: number;
  completedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  output: string;
  /** Output waiting for the next live trace flush. Traces carry deltas so
   * sustained/parallel commands do not repeatedly copy their full history. */
  pendingTraceOutput: string;
  totalOutputChars: number;
  traceOutputOffset: number;
  droppedOutputChars: number;
  maxOutputChars: number;
  outputKind?: TerminalOutputKind;
  checkInMs: number;
  hardTimeoutMs?: number;
  handedOff: boolean;
  background?: boolean;
  hardTimedOut?: boolean;
  outputFile: string;
  statusFile: string;
  streamId: string;
  consoleTraceEmitted?: boolean;
  process?: ChildProcess;
  traceContext?: {
    _onTrace?: (trace: any) => void;
    chatId?: string;
    ownerTraceId?: string;
    runId?: string;
    turnId?: string;
  };
  flushTimer?: NodeJS.Timeout;
  persistTimer?: NodeJS.Timeout;
  checkTimer?: NodeJS.Timeout;
  statusTimer?: NodeJS.Timeout;
  pendingFileOutput: string;
  outputWrite?: Promise<void>;
  persistedOutputChars?: number;
  outputPersistenceError?: string;
  statusWrite?: Promise<void>;
  statusPersistenceError?: string;
  finalization?: Promise<void>;
  stop?: (exitCode?: number) => Promise<void>;
  stopping?: Promise<void>;
  stopExitCode?: number;
}

const TASKS_DIR = getEterxWorkspaceDir('terminal_tasks');
const MAX_LIVE_TRACE_CHARS = 256_000;
const MAX_PENDING_OUTPUT_CHARS = 512_000;
const MAX_PERSISTED_OUTPUT_BYTES = 25 * 1024 * 1024;
const PERSISTED_OUTPUT_RETAIN_BYTES = 16 * 1024 * 1024;
const DEFAULT_TRACE_THROTTLE_MS = 100;

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveUnder(parent: string, ...segments: string[]): string {
  const resolved = path.resolve(parent, ...segments);
  if (!isPathInside(parent, resolved)) {
    throw new Error(`Resolved path escapes expected directory: ${resolved}`);
  }
  return resolved;
}

function safeTaskId(value: string): string {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await fs.writeJson(tmpPath, data, { spaces: 2 });
    // Renaming replaces the record atomically. move(overwrite) unlinks it
    // first, allowing concurrent readers to observe a missing status file.
    await fs.rename(tmpPath, filePath);
  } finally {
    await fs.remove(tmpPath).catch(() => undefined);
  }
}

const globalForTerminalTasks = globalThis as typeof globalThis & {
  __eterxTerminalBackgroundTasks?: Map<string, TerminalBackgroundTask>;
};

const terminalTasks: Map<string, TerminalBackgroundTask> =
  globalForTerminalTasks.__eterxTerminalBackgroundTasks ||
  (globalForTerminalTasks.__eterxTerminalBackgroundTasks = new Map());

export async function runTerminalCommandWithCheckIn(options: TerminalCommandRunOptions): Promise<any> {
  await fs.ensureDir(TASKS_DIR);

  if (options.context?.abortSignal?.aborted || options.context?.isCancelled?.()) {
    return {
      success: false,
      stdout: '',
      stderr: 'Terminal command cancelled before launch.',
      output: 'Terminal command cancelled before launch.',
      exitCode: 130,
      executionTimeMs: 0,
      timedOut: false,
      stillRunning: false,
      status: 'killed',
    };
  }

  const checkInMs = normalizeCheckInMs(options.checkInMs, options.command);
  // A check-in is a handoff boundary, not an execution deadline. Commands
  // that outlive it continue as managed background tasks until they exit or
  // are explicitly killed. A hard timeout exists only when a caller opts in.
  const hardTimeoutMs = options.hardTimeoutMs === undefined
    ? undefined
    : normalizeHardTimeoutMs(options.hardTimeoutMs, checkInMs);
  const authorization: { allowed: boolean; cwd: string; env: NodeJS.ProcessEnv; reason?: string } = options.authorization
    ? { allowed: true, cwd: options.authorization.cwd, env: options.authorization.env }
    : await authorizeToolCommand({
      command: options.command,
      cwd: options.cwd,
      context: options.context,
      env: options.env,
      timeoutMs: hardTimeoutMs,
    });
  if (!authorization.allowed) {
    const reason = authorization.reason || 'Terminal command blocked by command policy';
    return {
      success: false,
      stdout: '',
      stderr: reason,
      output: reason,
      exitCode: 126,
      executionTimeMs: 0,
      timedOut: false,
      stillRunning: false,
      status: 'failed',
    };
  }

  if (options.context?.abortSignal?.aborted || options.context?.isCancelled?.()) {
    return {
      success: false,
      stdout: '',
      stderr: 'Terminal command cancelled before launch.',
      output: 'Terminal command cancelled before launch.',
      exitCode: 130,
      executionTimeMs: 0,
      timedOut: false,
      stillRunning: false,
      status: 'killed',
    };
  }

  const id = `term_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const startedAt = Date.now();
  const streamId = `${options.source}_${startedAt}_${crypto.randomBytes(3).toString('hex')}`;
  const traceContext = createTraceContext(options.context);

  const task: TerminalBackgroundTask = {
    id,
    command: options.command,
    program: options.program,
    args: options.program ? [...(options.args || [])] : undefined,
    description: options.description || options.command,
    source: options.source,
    ownerChatId: String(options.context?.ownerChatId || options.context?.chatId || options.context?.projectId || '').trim() || undefined,
    cwd: authorization.cwd,
    status: 'running',
    startedAt,
    lastActivityAt: startedAt,
    exitCode: null,
    stdout: '',
    stderr: '',
    output: '',
    pendingTraceOutput: '',
    totalOutputChars: 0,
    traceOutputOffset: 0,
    droppedOutputChars: 0,
    maxOutputChars: terminalOutputPageChars(options.maxOutputChars, options.context?.contextCompaction?.activeContextWindow),
    outputKind: resolveTerminalOutputKind(options.command, options.outputKind),
    checkInMs,
    hardTimeoutMs,
    handedOff: false,
    background: options.immediateHandoff === true,
    outputFile: resolveUnder(TASKS_DIR, `${id}_output.txt`),
    statusFile: resolveUnder(TASKS_DIR, `${id}_status.json`),
    streamId,
    traceContext,
    pendingFileOutput: '',
    persistedOutputChars: 0,
  };

  terminalTasks.set(id, task);
  persistTaskStatus(task).catch(() => undefined);

  let invocation: ReturnType<typeof buildTerminalShellInvocation>;
  try {
    invocation = options.program
      ? { file: options.program, args: options.args || [], shell: false }
      : buildTerminalShellInvocation(options.command, options.shell, authorization.cwd);
    task.shell = invocation.file;
  } catch (error: any) {
    task.status = 'failed';
    task.exitCode = 127;
    task.completedAt = Date.now();
    appendTaskOutput(task, 'stderr', String(error?.message || error));
    flushTaskOutput(task, true, 127);
    await waitForTaskOutputWrites(task);
    await persistTaskStatus(task);
    retainFinishedTask(task);
    return buildTerminalResult(task);
  }

  let child: ChildProcess;
  let releaseWorkspace: (() => void) & { setProcess?: (pid?: number) => void } = () => {};
  try {
    releaseWorkspace = managedWorkspaces.acquireWorkspaceLease(authorization.cwd);
    child = spawn(invocation.file, invocation.args, {
      cwd: authorization.cwd,
      shell: invocation.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      env: { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...authorization.env },
      detached: process.platform !== 'win32',
    });
  } catch (error: any) {
    releaseWorkspace();
    task.status = 'failed';
    task.exitCode = 127;
    task.completedAt = Date.now();
    appendTaskOutput(task, 'stderr', String(error?.message || error));
    flushTaskOutput(task, true, 127);
    await waitForTaskOutputWrites(task);
    await persistTaskStatus(task);
    retainFinishedTask(task);
    return buildTerminalResult(task);
  }

  task.process = child;
  task.pid = child.pid || undefined;
  // Lease metadata failure must not abandon an already spawned process before
  // its error/output listeners are installed. The parent lease remains held.
  try { releaseWorkspace.setProcess?.(child.pid); } catch { /* Keep the live parent lease. */ }
  // Attach process listeners immediately. Awaiting disk I/O here lets very
  // short commands exit before their output/close events have subscribers.
  persistTaskStatus(task).catch(() => undefined);

  let resultResolved = false;
  let handoffTimer: NodeJS.Timeout | undefined;

  return new Promise((resolve) => {
    const abortSignal = options.context?.abortSignal as AbortSignal | undefined;
    let onAbort = () => {};
    let childClosed = false;
    let closeSignal: string | null = null;
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const resolveOnce = (result: any, keepAbortListener = false) => {
      if (resultResolved) return;
      resultResolved = true;
      if (!keepAbortListener) abortSignal?.removeEventListener('abort', onAbort);
      if (handoffTimer) clearTimeout(handoffTimer);
      resolve(result);
    };

    const finishTask = (status: TerminalTaskStatus, exitCode: number | null, signal?: string | null): Promise<void> => {
      if (task.finalization) return task.finalization;
      task.finalization = (async () => {
        task.status = status;
        task.exitCode = exitCode;
        task.signal = signal || null;
        task.completedAt = Date.now();
        abortSignal?.removeEventListener('abort', onAbort);
        if (handoffTimer) clearTimeout(handoffTimer);
        clearTaskTimers(task);
        releaseWorkspace();
        flushTaskOutput(task, true, exitCode ?? (status === 'completed' ? 0 : 1));
        await waitForTaskOutputWrites(task);
        await persistTaskStatus(task);

        if (task.handedOff) emitTrace(task.traceContext, {
          type: 'terminal_task_completed',
          timestamp: Date.now(),
          text: `Terminal task ${status}`,
          title: 'Terminal command',
          note: `Task ${task.id} ${status} with exit code ${exitCode ?? 'unknown'}. Use workspace_run_command mode="check" for final output.`,
          command: task.command,
          taskId: task.id,
          exitCode,
          durationMs: Date.now() - task.startedAt,
          iconCategory: 'terminal'
        });
      })().finally(() => {
        resolveOnce(buildTerminalResult(task));
        retainFinishedTask(task);
      });
      return task.finalization;
    };

    onAbort = () => {
      if (task.status !== 'running') return;
      const reason = String((abortSignal as any)?.reason?.message || (abortSignal as any)?.reason || '');
      if ((task.background || options.surviveRunSettlement) && reason.includes('MAIN_RUN_SETTLED')) {
        abortSignal?.removeEventListener('abort', onAbort);
        return;
      }
      void task.stop?.(130).catch(error => {
        appendTaskOutput(task, 'stderr', `\nCould not stop process: ${error.message}\n`);
        flushTaskOutput(task);
      });
    };

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let decodersFlushed = false;
    const onData = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (decodersFlushed) return;
      const text = stream === 'stdout' ? stdoutDecoder.write(chunk) : stderrDecoder.write(chunk);
      appendTaskOutput(task, stream, text);
      scheduleTaskFlush(task, options.traceThrottleMs || DEFAULT_TRACE_THROTTLE_MS);
      scheduleTaskStatusPersist(task);
    };
    const flushDecoders = () => {
      if (decodersFlushed) return;
      decodersFlushed = true;
      appendTaskOutput(task, 'stdout', stdoutDecoder.end());
      appendTaskOutput(task, 'stderr', stderrDecoder.end());
    };

    task.stop = (exitCode = 143) => {
      if (task.stopping) return task.stopping;
      if (task.status !== 'running') return task.finalization || Promise.resolve();
      task.stopExitCode = exitCode;
      if (exitCode === 124) task.hardTimedOut = true;
      task.stopping = (async () => {
        try {
          await killProcessTree(task.pid, task.process);
          // Drain the pipes before ending UTF-8 decoders. Process exit alone
          // does not mean its final stdout/stderr chunks have been delivered.
          let drainTimer: NodeJS.Timeout | undefined;
          await Promise.race([
            closed,
            new Promise<void>(resolve => { drainTimer = setTimeout(resolve, 2_000); }),
          ]).finally(() => { if (drainTimer) clearTimeout(drainTimer); });
          if (!childClosed) {
            child.stdout?.destroy();
            child.stderr?.destroy();
          }
          flushDecoders();
          await finishTask(exitCode === 124 ? 'failed' : 'killed', exitCode, closeSignal);
        } catch (error) {
          task.stopExitCode = undefined;
          throw error;
        }
      })().finally(() => { task.stopping = undefined; });
      return task.stopping;
    };

    child.stdout?.on('data', (chunk: Buffer) => onData('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => onData('stderr', chunk));

    child.on('close', (code: number | null, signal: string | null) => {
      childClosed = true;
      closeSignal = signal;
      resolveClosed();
      flushDecoders();
      // The shell can close before its descendants. Stop owns completion
      // until the entire process group/tree has been terminated.
      if (task.stopExitCode !== undefined || task.stopping) return;
      const status = code === 0 && !task.hardTimedOut ? 'completed' : 'failed';
      finishTask(status, task.hardTimedOut ? 124 : code, signal).catch(() => {
        resolveOnce(buildTerminalResult(task));
      });
    });

    child.on('error', (error: Error) => {
      appendTaskOutput(task, 'stderr', error.message);
      // An error on a live child is not proof of exit. A spawn failure has no
      // PID; only that failure can settle here without waiting for close.
      if (task.pid) { scheduleTaskFlush(task, DEFAULT_TRACE_THROTTLE_MS); return; }
      flushDecoders();
      finishTask('failed', 1, null).catch(() => {
        resolveOnce(buildTerminalResult(task));
      });
    });

    // Publish task identity even when the program has not written anything yet.
    flushTaskOutput(task, false, undefined, true);

    if (abortSignal?.aborted || options.context?.isCancelled?.()) {
      onAbort();
    } else {
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    }

    handoffTimer = setTimeout(() => {
      if (task.status !== 'running') return;

      task.handedOff = true;
      // Handoff is a live snapshot, not command completion. Marking this
      // event final makes consumers render a successful exit before the
      // process has actually exited and before a later check can report the
      // real status.
      flushTaskOutput(task, false);
      const note = runningTaskNote(task);
      emitTrace(task.traceContext, {
        type: 'timer_expired',
        timestamp: Date.now(),
        text: task.background ? 'Terminal command running in background' : 'Terminal command still running',
        title: 'Terminal command',
        note,
        durationMs: Date.now() - task.startedAt,
        command: task.command,
        taskId: task.id,
        iconCategory: 'terminal'
      });
      // The agent owns its wait/check loop; do not inject recurring timer traces.
      const published = persistTaskStatus(task);
      // Continue observing explicit user cancellation. Normal response settlement
      // is handled separately above and must not kill handed-off work.
      void published.then(() => resolveOnce(task.status === 'running' ? buildRunningResult(task, note) : buildTerminalResult(task), task.status === 'running'));
    }, options.immediateHandoff ? 0 : checkInMs);
    handoffTimer.unref?.();

    if (hardTimeoutMs !== undefined) {
      task.statusTimer = setTimeout(() => {
        if (task.status !== 'running') return;
        appendTaskOutput(task, 'stderr', `\nThe ${secondsFromTimeoutMs(hardTimeoutMs)}-second execution deadline was reached; stopping the command.\n`);
        void task.stop?.(124).catch(error => {
          appendTaskOutput(task, 'stderr', `\nCould not terminate timed-out process: ${error.message}\n`);
          flushTaskOutput(task);
        });
      }, hardTimeoutMs);
      task.statusTimer.unref?.();
    }
  });
}

export async function getTerminalBackgroundTaskStatus(
  taskId: string,
  ownerChatId?: string,
  sinceOffset?: number,
  maxOutputChars?: number,
): Promise<any | null> {
  taskId = safeTaskId(taskId);
  if (!taskId) return null;
  const requestedOwner = String(ownerChatId || '').trim();
  const inMemory = terminalTasks.get(taskId);
  if (inMemory) {
    if (requestedOwner && inMemory.ownerChatId !== requestedOwner) return null;
    const limit = terminalOutputPageChars(maxOutputChars ?? inMemory.maxOutputChars);
    if (resolveTerminalOutputKind(inMemory.command, inMemory.outputKind) === 'read') {
      const snapshot = { ...inMemory, output: inMemory.output.slice(-limit) };
      await waitForTaskOutputWrites(inMemory, snapshot.totalOutputChars);
      return withReadOutputPage(buildStatusResult(snapshot, sinceOffset), inMemory.outputFile,
        sinceOffset, limit, inMemory.outputPersistenceError);
    }
    return buildStatusResult({ ...inMemory, output: inMemory.output.slice(-limit) }, sinceOffset);
  }

  const statusFile = resolveUnder(TASKS_DIR, `${taskId}_status.json`);
  if (!await fs.pathExists(statusFile)) return null;

  const status = await fs.readJson(statusFile);
  if (requestedOwner && String(status.ownerChatId || '') !== requestedOwner) return null;
  const outputFile = status.outputFile && isPathInside(TASKS_DIR, path.resolve(status.outputFile))
    ? status.outputFile
    : resolveUnder(TASKS_DIR, `${taskId}_output.txt`);
  const persistedOutputLimit = terminalOutputPageChars(maxOutputChars ?? status.maxOutputChars);
  const outputKind = resolveTerminalOutputKind(String(status.command || ''), status.outputKind);
  const output = outputKind === 'read' ? '' : await readOutputTail(outputFile, persistedOutputLimit);
  // Saved output survives a restart; an active execution handle does not.
  // PID existence alone cannot establish identity or recover an exit status.
  const persistedStatus = status.status === 'running' ? 'unknown' : status.status || 'unknown';
  const outputWindow = buildOutputWindow(
    output,
    Number(status.totalOutputChars) || output.length,
    sinceOffset,
  );
  const result = {
    success: persistedStatus === 'completed',
    terminalTask: true,
    taskId,
    streamId: String(status.streamId || `terminal_${taskId}`),
    ownerTraceId: status.ownerTraceId,
    runId: status.runId,
    turnId: status.turnId || status.runId,
    status: persistedStatus,
    running: persistedStatus === 'running',
    background: status.background === true,
    command: status.command,
    program: status.program,
    args: status.args,
    outputKind,
    cwd: status.cwd,
    shell: status.shell,
    pid: status.pid,
    exitCode: persistedStatus === 'unknown' ? null : status.exitCode ?? null,
    startedAt: status.startedAt,
    completedAt: status.completedAt,
    elapsedMs: (status.completedAt || Date.now()) - status.startedAt,
    stdout: outputWindow.text,
    stderr: '',
    output: outputWindow.text,
    outputStart: outputWindow.start,
    outputEnd: outputWindow.end,
    hasNewOutput: outputWindow.hasNewOutput,
    totalOutputChars: status.totalOutputChars ?? output.length,
    droppedOutputChars: status.droppedOutputChars ?? 0,
    outputPersistenceError: status.outputPersistenceError,
    timedOut: status.hardTimedOut === true,
    message: persistedStatus === 'unknown'
      ? `Saved terminal task ${taskId}: its final outcome is unavailable in this app session. Retained output is shown below.`
      : `Terminal task ${taskId}: ${persistedStatus} | "${status.description || status.command}"`,
    nextActionNote: persistedStatus === 'unknown'
      ? 'The original execution handle is unavailable. Read the retained output and current task state before deciding what remains; do not infer success, failure, or automatically replay a mutation.'
      : 'Read the final output and continue from the result.'
  };
  return outputKind === 'read'
    ? withReadOutputPage(result, outputFile, sinceOffset, persistedOutputLimit, status.outputPersistenceError)
    : result;
}

// Share history across route bundles and hot reloads. A menu refresh never waits
// for a scan of every chat's saved tasks.
const historyGlobal = globalThis as typeof globalThis & {
  __eterxTerminalHistory?: { tasks: Map<string, any>; pending?: Promise<void>; refreshedAt: number };
};
const terminalHistory: NonNullable<typeof historyGlobal.__eterxTerminalHistory> = historyGlobal.__eterxTerminalHistory ||= { tasks: new Map(), refreshedAt: 0 };

function refreshTerminalHistory(): void {
  if (terminalHistory.pending || Date.now() - terminalHistory.refreshedAt < 30_000) return;
  terminalHistory.pending = (async () => {
    const files = (await fs.readdir(TASKS_DIR)).filter(file => file.endsWith('_status.json'));
    let cursor = 0;
    // Bounded concurrency avoids a serial filesystem crawl without flooding disk I/O.
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (cursor < files.length) {
        const file = files[cursor++];
        const id = file.slice(0, -'_status.json'.length);
        if (terminalTasks.has(id)) continue;
        const cached = terminalHistory.tasks.get(id);
        if (cached && cached.status !== 'running') continue;
        try {
          const status = await fs.readJson(resolveUnder(TASKS_DIR, file));
          if (status?.terminalTask === false || !status?.ownerChatId) continue;
          terminalHistory.tasks.set(id, {
            id, terminalTask: true, ownerChatId: status.ownerChatId,
            status: status.status, description: status.description || status.command,
            command: status.command, program: status.program, args: status.args, pid: status.pid, cwd: status.cwd,
            exitCode: status.exitCode ?? null, startedAt: status.startedAt,
            completedAt: status.completedAt, background: status.background === true,
          });
        } catch { /* Ignore incomplete or removed records. */ }
      }
    }));
  })().catch(() => undefined).finally(() => {
    terminalHistory.refreshedAt = Date.now();
    terminalHistory.pending = undefined;
  });
}

export async function listTerminalBackgroundTasks(ownerChatId?: string, backgroundOnly = false): Promise<any[]> {
  refreshTerminalHistory();
  const requestedOwner = String(ownerChatId || '').trim();
  // On the first discovery, include persisted tasks before reporting an empty
  // list. Otherwise a resumed agent can launch work that is already running.
  if (terminalHistory.refreshedAt === 0 && terminalHistory.pending) await terminalHistory.pending;
  const tasks = new Map<string, any>();
  for (const [id, saved] of terminalHistory.tasks) {
    if (requestedOwner && saved.ownerChatId !== requestedOwner) continue;
    if (backgroundOnly && saved.background !== true) continue;
    if (terminalTasks.has(id)) continue;
    const status = saved.status === 'running' ? 'unknown' : saved.status;
    tasks.set(id, { ...saved, status, exitCode: status === 'unknown' ? null : saved.exitCode });
  }
  // Live records are authoritative and available without any filesystem awaits.
  for (const task of terminalTasks.values()) {
    if (requestedOwner && task.ownerChatId !== requestedOwner) continue;
    if (backgroundOnly && task.background !== true) continue;
    tasks.set(task.id, compactTask(task));
  }
  return Array.from(tasks.values());
}

/** Cheap automatic context for this chat; no filesystem scan or process probe. */
export function getLiveTerminalTaskContext(ownerChatId: string): any[] {
  if (!ownerChatId) return [];
  return [...terminalTasks.values()]
    .filter(task => task.ownerChatId === ownerChatId)
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt)
    .slice(0, 12)
    .map(task => ({
      taskId: task.id, command: task.command, cwd: task.cwd, shell: task.shell,
      status: task.status, exitCode: task.exitCode, outputEnd: task.totalOutputChars,
      background: task.background === true,
    }));
}

export async function waitTerminalTask(taskId: string, ownerChatId: string, timeoutMs: number, sinceOffset?: number, signal?: AbortSignal, maxOutputChars?: number): Promise<any | null> {
  const deadline = Date.now() + Math.max(1000, Math.min(120_000, timeoutMs));
  let result = await getTerminalBackgroundTaskStatus(taskId, ownerChatId, sinceOffset, maxOutputChars);
  while (result?.running && !result.hasNewOutput && !signal?.aborted && Date.now() < deadline) {
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, Math.min(500, Math.max(0, deadline - Date.now())));
      signal?.addEventListener('abort', done, { once: true });
      if (signal?.aborted) done();
    });
    result = await getTerminalBackgroundTaskStatus(taskId, ownerChatId, sinceOffset, maxOutputChars);
  }
  return result;
}

export async function backgroundTerminalTask(taskId: string, ownerChatId: string): Promise<any | null> {
  const task = terminalTasks.get(safeTaskId(taskId));
  if (!task) {
    return getTerminalBackgroundTaskStatus(taskId, ownerChatId);
  }
  if (task.ownerChatId !== ownerChatId) return null;
  if (task.status === 'running') {
    task.background = true;
    await persistTaskStatus(task);
  }
  return getTerminalBackgroundTaskStatus(task.id, ownerChatId);
}

export async function killTerminalBackgroundTask(taskId: string, ownerChatId?: string): Promise<any | null> {
  taskId = safeTaskId(taskId);
  if (!taskId) return null;
  const requestedOwner = String(ownerChatId || '').trim();
  const task = terminalTasks.get(taskId);
  if (task) {
    if (requestedOwner && task.ownerChatId !== requestedOwner) return null;
    if (task.stopping) {
      await task.stopping;
    } else if (task.status === 'running') {
      if (!task.stop) throw new Error('The terminal process is still starting. Retry Stop in a moment.');
      await task.stop();
    } else if (task.finalization) {
      await task.finalization;
    }
    return getTerminalBackgroundTaskStatus(task.id, requestedOwner);
  }

  const statusFile = resolveUnder(TASKS_DIR, `${taskId}_status.json`);
  if (!await fs.pathExists(statusFile)) return null;
  const status = await fs.readJson(statusFile);
  if (requestedOwner && String(status.ownerChatId || '') !== requestedOwner) return null;
  // Do not signal an unrelated process after the OS reuses a saved PID.
  // The returned unknown state explains that there is no active handle here.
  return getTerminalBackgroundTaskStatus(taskId, requestedOwner);
}

/** Include background tasks whose launching agent has already settled. */
export async function stopAllTerminalTasks(): Promise<void> {
  const tasks = [...terminalTasks.values()];
  const results = await Promise.allSettled(tasks.map(async task => {
    if (task.stopping) await task.stopping;
    else if (task.status === 'running') {
      if (!task.stop) throw new Error(`Terminal task ${task.id} is still starting.`);
      await task.stop();
    } else if (task.finalization) await task.finalization;
  }));
  const failures = results.flatMap((result, index) => result.status === 'rejected'
    ? [`${tasks[index].id}: ${String(result.reason?.message || result.reason)}`] : []);
  if (failures.length) throw new Error(`Could not stop terminal tasks: ${failures.join('; ')}`);
}

function retainFinishedTask(task: TerminalBackgroundTask) {
  const timer = setTimeout(() => {
    if (terminalTasks.get(task.id) === task && task.status !== 'running') terminalTasks.delete(task.id);
  }, 15 * 60 * 1000);
  timer.unref?.();
}

function appendTaskOutput(task: TerminalBackgroundTask, stream: 'stdout' | 'stderr', text: string) {
  if (!text) return;
  task.lastActivityAt = Date.now();
  task.totalOutputChars += text.length;
  task.pendingTraceOutput = (task.pendingTraceOutput + text).slice(-MAX_LIVE_TRACE_CHARS);
  // Disk is the exact archive. Neither a read nor an explicit retention hint
  // grants an unbounded heap buffer, trace payload, or provider response.
  const outputLimit = terminalOutputPageChars(task.maxOutputChars);
  task[stream] = trimOutput(task[stream] + text, outputLimit).text;

  const combined = trimOutput(task.output + text, outputLimit);
  task.output = combined.text;
  task.droppedOutputChars += combined.dropped;

  if (task.outputPersistenceError) return;
  task.pendingFileOutput += text;
  if (task.pendingFileOutput.length >= MAX_PENDING_OUTPUT_CHARS) {
    task.process?.stdout?.pause();
    task.process?.stderr?.pause();
  }
  scheduleTaskOutputWrite(task);
}

function scheduleTaskOutputWrite(task: TerminalBackgroundTask) {
  if (task.outputWrite || !task.pendingFileOutput || task.outputPersistenceError) return;

  // One bounded batch per promise lets readers wait for their snapshot even
  // when a noisy background process never stops producing output.
  const batch = task.pendingFileOutput;
  task.pendingFileOutput = '';
  task.outputWrite = (async () => {
    await fs.ensureDir(TASKS_DIR);
    await fs.appendFile(task.outputFile, batch);
    task.persistedOutputChars = (task.persistedOutputChars || 0) + batch.length;

    const stats = await fs.stat(task.outputFile).catch(() => null);
    if (resolveTerminalOutputKind(task.command, task.outputKind) !== 'read' && stats && stats.size > MAX_PERSISTED_OUTPUT_BYTES) {
      const content = await fs.readFile(task.outputFile);
      let retainFrom = Math.max(0, content.length - PERSISTED_OUTPUT_RETAIN_BYTES);
      // Advance past UTF-8 continuation bytes so rotation never begins in the
      // middle of a character.
      while (retainFrom < content.length && (content[retainFrom] & 0xC0) === 0x80) retainFrom += 1;
      // Leave rotation headroom so the next small append does not immediately
      // trigger another full-file read and rewrite.
      await fs.writeFile(task.outputFile, content.subarray(retainFrom));
    }
  })()
    .catch(error => {
      task.outputPersistenceError = String(error?.message || error);
      // Once the archive has a gap its offsets are no longer exact. Keep the
      // live tail, report the error, and avoid an endless failing write loop.
      task.pendingFileOutput = '';
    })
    .finally(() => {
      task.outputWrite = undefined;
      // Disk failure must not leave a subprocess permanently paused.
      if (task.pendingFileOutput.length < MAX_PENDING_OUTPUT_CHARS) {
        task.process?.stdout?.resume();
        task.process?.stderr?.resume();
      }
      if (task.pendingFileOutput) scheduleTaskOutputWrite(task);
    });
}

async function waitForTaskOutputWrites(task: TerminalBackgroundTask, throughOffset = task.totalOutputChars): Promise<void> {
  while (!task.outputPersistenceError && (task.persistedOutputChars || 0) < throughOffset && (task.outputWrite || task.pendingFileOutput)) {
    if (!task.outputWrite) scheduleTaskOutputWrite(task);
    const activeWrite = task.outputWrite;
    if (activeWrite) await activeWrite.catch(() => undefined);
  }
}

function trimOutput(text: string, maxChars: number): { text: string; dropped: number } {
  if (text.length <= maxChars) return { text, dropped: 0 };
  const dropped = text.length - maxChars;
  return { text: text.slice(dropped), dropped };
}

function scheduleTaskFlush(task: TerminalBackgroundTask, throttleMs: number) {
  if (task.flushTimer) return;
  task.flushTimer = setTimeout(() => {
    task.flushTimer = undefined;
    flushTaskOutput(task, task.status !== 'running', task.exitCode);
  }, Math.max(16, throttleMs));
  task.flushTimer.unref?.();
}

function scheduleTaskStatusPersist(task: TerminalBackgroundTask) {
  if (task.persistTimer) return;
  task.persistTimer = setTimeout(() => {
    task.persistTimer = undefined;
    persistTaskStatus(task).catch(() => undefined);
  }, 1_000);
  task.persistTimer.unref?.();
}

function flushTaskOutput(task: TerminalBackgroundTask, final = false, exitCode?: number | null, force = false) {
  const outputChunk = task.pendingTraceOutput;
  const outputStart = Math.max(task.traceOutputOffset, task.totalOutputChars - outputChunk.length);
  const outputEnd = task.totalOutputChars;
  if (!outputChunk && !final && !force) return;
  const emittedAt = Date.now();
  const settledAt = final ? task.completedAt || emittedAt : undefined;

  task.pendingTraceOutput = '';
  task.traceOutputOffset = outputEnd;
  const output = final ? terminalTraceSnapshotOutput(task) : outputChunk;
  const emitted = emitTrace(task.traceContext, {
    type: 'console_output',
    command: task.command,
    program: task.program,
    args: task.args,
    output,
    source: task.source,
    cwd: task.cwd,
    shell: task.shell,
    pid: task.pid,
    streamId: task.streamId,
    taskId: task.id,
    ownerTraceId: task.traceContext?.ownerTraceId,
    runId: task.traceContext?.runId,
    turnId: task.traceContext?.turnId,
    toolName: task.source,
    startTime: task.startedAt,
    ...(final ? { endTime: settledAt } : {}),
    timestamp: emittedAt,
    isStreaming: !final,
    isDelta: !final,
    streamState: final ? 'closed' : 'open',
    status: final ? task.status : 'running',
    outputStart: final ? Math.max(0, task.totalOutputChars - task.output.length) : outputStart,
    outputEnd,
    totalOutputChars: task.totalOutputChars,
    droppedOutputChars: task.droppedOutputChars,
    outputFile: task.outputFile,
    ...(final ? {
      exitCode: exitCode ?? task.exitCode ?? 0,
      durationMs: Math.max(0, Number(settledAt) - task.startedAt),
    } : {})
  });
  task.consoleTraceEmitted = task.consoleTraceEmitted || emitted;
}

function buildRunningResult(task: TerminalBackgroundTask, note: string): any {
  return {
    command: task.command,
    program: task.program,
    args: task.args,
    success: true,
    outputKind: resolveTerminalOutputKind(task.command, task.outputKind),
    stdout: task.stdout,
    stderr: task.stderr,
    output: visibleOutput(task),
    exitCode: null,
    executionTimeMs: Date.now() - task.startedAt,
    timedOut: false,
    stillRunning: true,
    backgroundTaskId: task.background ? task.id : undefined,
    taskId: task.id,
    streamId: task.streamId,
    ownerTraceId: task.traceContext?.ownerTraceId,
    runId: task.traceContext?.runId,
    turnId: task.traceContext?.turnId,
    cwd: task.cwd,
    shell: task.shell,
    pid: task.pid,
    totalOutputChars: task.totalOutputChars,
    droppedOutputChars: task.droppedOutputChars,
    outputPersistenceError: task.outputPersistenceError,
    statusPersistenceError: task.statusPersistenceError,
    background: task.background === true,
    status: task.status,
    checkInMs: task.checkInMs,
    hardTimeoutMs: task.hardTimeoutMs,
    _consoleTraceEmitted: task.consoleTraceEmitted === true,
    nextActionNote: note
  };
}

function buildTerminalResult(task: TerminalBackgroundTask): any {
  const hardTimeoutNote = task.hardTimedOut && task.status !== 'running' && task.hardTimeoutMs !== undefined
    ? terminalTimeoutNote(task.command, task.hardTimeoutMs)
    : '';
  return {
    command: task.command,
    program: task.program,
    args: task.args,
    success: task.status === 'completed',
    outputKind: resolveTerminalOutputKind(task.command, task.outputKind),
    stdout: task.stdout,
    stderr: task.stderr + (hardTimeoutNote ? `\n${hardTimeoutNote}` : ''),
    output: visibleOutput(task),
    exitCode: task.exitCode ?? (task.status === 'completed' ? 0 : 1),
    executionTimeMs: (task.completedAt || Date.now()) - task.startedAt,
    timedOut: Boolean(task.hardTimedOut),
    stillRunning: task.status === 'running',
    backgroundTaskId: task.background ? task.id : undefined,
    taskId: task.id,
    streamId: task.streamId,
    ownerTraceId: task.traceContext?.ownerTraceId,
    runId: task.traceContext?.runId,
    turnId: task.traceContext?.turnId,
    cwd: task.cwd,
    shell: task.shell,
    pid: task.pid,
    totalOutputChars: task.totalOutputChars,
    droppedOutputChars: task.droppedOutputChars,
    outputPersistenceError: task.outputPersistenceError,
    statusPersistenceError: task.statusPersistenceError,
    status: task.status,
    message: task.status === 'completed' && !task.stdout && !task.stderr
      ? 'Command completed successfully with no output.'
      : undefined,
    timeoutMs: task.checkInMs,
    hardTimeoutMs: task.hardTimeoutMs,
    _consoleTraceEmitted: task.consoleTraceEmitted === true,
    nextActionNote: task.status === 'running'
      ? runningTaskNote(task)
      : undefined
  };
}

function buildStatusResult(task: TerminalBackgroundTask, sinceOffset?: number): any {
  const outputWindow = buildOutputWindow(task.output, task.totalOutputChars, sinceOffset);
  return {
    success: task.status === 'completed',
    terminalTask: true,
    taskId: task.id,
    streamId: task.streamId,
    ownerTraceId: task.traceContext?.ownerTraceId,
    runId: task.traceContext?.runId,
    turnId: task.traceContext?.turnId,
    status: task.status,
    running: task.status === 'running',
    background: task.background === true,
    command: task.command,
    program: task.program,
    args: task.args,
    outputKind: resolveTerminalOutputKind(task.command, task.outputKind),
    cwd: task.cwd,
    shell: task.shell,
    pid: task.pid,
    exitCode: task.exitCode ?? null,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    elapsedMs: (task.completedAt || Date.now()) - task.startedAt,
    stdout: outputWindow.text,
    stderr: '',
    output: outputWindow.text,
    outputStart: outputWindow.start,
    outputEnd: outputWindow.end,
    hasNewOutput: outputWindow.hasNewOutput,
    totalOutputChars: task.totalOutputChars,
    droppedOutputChars: task.droppedOutputChars,
    outputPersistenceError: task.outputPersistenceError,
    statusPersistenceError: task.statusPersistenceError,
    timedOut: task.hardTimedOut === true,
    // The in-memory process is already publishing cumulative console traces.
    // A manual mode="check" observes it; it must not create another UI row.
    _consoleTraceEmitted: task.consoleTraceEmitted === true,
    message: `Terminal task ${task.id}: ${task.status} | "${task.description}" | Duration: ${(((task.completedAt || Date.now()) - task.startedAt) / 1000).toFixed(1)}s`,
    nextActionNote: task.status === 'running'
      ? `Use workspace_run_command mode="wait" with taskId="${task.id}" and sinceOffset=${outputWindow.end} to await new output or completion.`
      : 'Read the final output and continue from the result.'
  };
}

function runningTaskNote(task: TerminalBackgroundTask): string {
  return task.background
    ? `Terminal task ${task.id} is running in the background. Use workspace_run_command mode="wait" or mode="check" with this taskId for output, or mode="kill" to stop it. Do not launch the same command again.`
    : terminalBackgroundHandoffNote(task.command, task.id, task.checkInMs);
}

function compactTask(task: TerminalBackgroundTask): any {
  return {
    id: task.id,
    terminalTask: true,
    background: task.background === true,
    status: task.status,
    description: task.description,
    command: task.command,
    program: task.program,
    args: task.args,
    pid: task.pid,
    cwd: task.cwd,
    exitCode: task.exitCode ?? null,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    duration: task.completedAt ? `${((task.completedAt - task.startedAt) / 1000).toFixed(1)}s` : 'running'
  };
}

function visibleOutput(task: TerminalBackgroundTask): string {
  if (task.droppedOutputChars <= 0) return task.output;
  return `...[${task.droppedOutputChars} earlier chars truncated from terminal buffer]...\n${task.output}`;
}

/** Read character ranges without loading a multi-megabyte transcript into memory. */
async function withReadOutputPage(
  result: any,
  outputFile: string,
  sinceOffset: number | undefined,
  limit: number,
  persistenceError?: string,
): Promise<any> {
  const total = Math.max(0, Math.floor(Number(result.totalOutputChars) || 0));
  const start = Math.min(total, Math.max(0, Number.isFinite(sinceOffset) ? Math.floor(sinceOffset!) : 0));
  const end = Math.min(total, start + terminalOutputPageChars(limit));
  let text = '';
  try {
    if (persistenceError) throw new Error(persistenceError);
    if (end > start) {
      // setEncoding preserves UTF-8 code points across disk chunks. Offsets
      // are JS string characters, matching the existing terminal protocol.
      const stream = fs.createReadStream(outputFile, { encoding: 'utf8', highWaterMark: 64 * 1024 });
      let cursor = 0;
      try {
        for await (const chunk of stream) {
          const value = String(chunk);
          const next = cursor + value.length;
          if (next > start) text += value.slice(Math.max(0, start - cursor), Math.max(0, end - cursor));
          cursor = next;
          if (cursor >= end) break;
        }
      } finally { stream.destroy(); }
      if (text.length !== end - start) throw new Error('The saved terminal output is incomplete.');
    }
    const hasMoreOutput = end < total;
    return {
      ...result,
      stdout: text, stderr: '', output: text,
      outputFile,
      outputStart: start, outputEnd: end, hasNewOutput: text.length > 0,
      hasMoreOutput, nextOutputOffset: hasMoreOutput ? end : undefined,
      outputLimited: start > 0 || hasMoreOutput,
      // Paging is not data loss. Retention on disk is separate from the live buffer.
      droppedOutputChars: 0,
      nextActionNote: hasMoreOutput
        ? `Output page ${start}-${end} of ${total} characters. Exact output is retained. Read the next page with workspace_run_command mode="check", taskId="${result.taskId}", sinceOffset=${end}; or narrow the search. Do not rerun the command to page its output.`
        : result.nextActionNote,
    };
  } catch (error: any) {
    return {
      ...result,
      outputLimited: true,
      outputReadError: String(error?.message || error),
      nextActionNote: 'Exact retained output could not be read. This response is incomplete; use a narrow read of the original source for missing evidence. Do not infer that omitted content was inspected.',
    };
  }
}

function buildOutputWindow(
  retainedOutput: string,
  totalOutputChars: number,
  sinceOffset?: number,
): { text: string; start: number; end: number; hasNewOutput: boolean } {
  const total = Math.max(retainedOutput.length, Math.floor(Number(totalOutputChars) || 0));
  const retainedStart = Math.max(0, total - retainedOutput.length);
  const requested = Number.isFinite(Number(sinceOffset))
    ? Math.max(0, Math.min(total, Math.floor(Number(sinceOffset))))
    : 0;
  const start = Math.max(retainedStart, requested);
  const delta = retainedOutput.slice(start - retainedStart);
  const omitted = Math.max(0, retainedStart - requested);
  const text = omitted > 0
    ? `...[${omitted} requested terminal chars are no longer retained]...\n${delta}`
    : delta;
  return { text, start, end: total, hasNewOutput: delta.length > 0 };
}

function terminalTraceSnapshotOutput(task: TerminalBackgroundTask, maxChars = 1024 * 1024): string {
  const output = visibleOutput(task);
  if (output.length <= maxChars) return output;
  const headChars = Math.floor(maxChars * 0.2);
  const tailChars = maxChars - headChars;
  const omitted = output.length - headChars - tailChars;
  return `${ output.slice(0, headChars) }\n...[${ omitted } terminal output chars omitted from the UI snapshot]...\n${ output.slice(-tailChars) }`;
}

function clearTaskTimers(task: TerminalBackgroundTask) {
  if (task.flushTimer) clearTimeout(task.flushTimer);
  if (task.persistTimer) clearTimeout(task.persistTimer);
  if (task.statusTimer) clearTimeout(task.statusTimer);
  if (task.checkTimer) {
    clearTimeout(task.checkTimer);
    clearInterval(task.checkTimer);
  }
  task.flushTimer = undefined;
  task.persistTimer = undefined;
  task.statusTimer = undefined;
  task.checkTimer = undefined;
}

async function persistTaskStatus(task: TerminalBackgroundTask) {
  terminalHistory.tasks.set(task.id, { ...compactTask(task), ownerChatId: task.ownerChatId });
  task.statusWrite = (task.statusWrite || Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      await fs.ensureDir(TASKS_DIR);
      await writeJsonAtomic(task.statusFile, serializeTask(task));
      task.statusPersistenceError = undefined;
    }).catch(error => {
      // Persistence must not turn a successfully stopped process into a stop
      // failure or prevent the foreground command promise from settling.
      task.statusPersistenceError = String(error?.message || error);
    });
  await task.statusWrite;
}

function serializeTask(task: TerminalBackgroundTask): Record<string, any> {
  return {
    terminalTask: true,
    id: task.id,
    command: task.command,
    program: task.program,
    args: task.args,
    description: task.description,
    source: task.source,
    ownerChatId: task.ownerChatId,
    streamId: task.streamId,
    ownerTraceId: task.traceContext?.ownerTraceId,
    runId: task.traceContext?.runId,
    turnId: task.traceContext?.turnId,
    cwd: task.cwd,
    shell: task.shell,
    pid: task.pid,
    status: task.status,
    startedAt: task.startedAt,
    lastActivityAt: task.lastActivityAt,
    completedAt: task.completedAt,
    exitCode: task.exitCode ?? null,
    signal: task.signal ?? null,
    // Exact read output lives in outputFile; do not duplicate it in status JSON.
    stderr: resolveTerminalOutputKind(task.command, task.outputKind) === 'read' ? undefined : task.stderr.slice(-12_000),
    outputFile: task.outputFile,
    outputPersistenceError: task.outputPersistenceError,
    statusFile: task.statusFile,
    droppedOutputChars: task.droppedOutputChars,
    totalOutputChars: task.totalOutputChars,
    maxOutputChars: task.maxOutputChars,
    outputKind: resolveTerminalOutputKind(task.command, task.outputKind),
    checkInMs: task.checkInMs,
    hardTimeoutMs: task.hardTimeoutMs,
    handedOff: task.handedOff,
    background: task.background === true,
    hardTimedOut: task.hardTimedOut || false
  };
}

async function readOutputTail(filePath: string, maxChars = 24_000): Promise<string> {
  maxChars = terminalOutputPageChars(maxChars);
  let handle: number | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const stats = await fs.fstat(handle);
    const byteCount = Math.min(stats.size, Math.max(4, maxChars * 4));
    const buffer = Buffer.allocUnsafe(byteCount);
    const { bytesRead } = await fs.read(handle, buffer, 0, byteCount, Math.max(0, stats.size - byteCount));
    let start = 0;
    // Never decode from the middle of a UTF-8 code point.
    while (start < bytesRead && (buffer[start] & 0xC0) === 0x80) start++;
    return buffer.subarray(start, bytesRead).toString('utf8').slice(-maxChars);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
  finally { if (handle !== undefined) await fs.close(handle).catch(() => undefined); }
}

function createTraceContext(context: any): {
  _onTrace?: (trace: any) => void;
  chatId?: string;
  ownerTraceId?: string;
  runId?: string;
  turnId?: string;
} {
  return {
    _onTrace: typeof context?._onTrace === 'function' ? context._onTrace : undefined,
    chatId: context?.chatId || context?.projectId,
    ownerTraceId: context?.ownerTraceId,
    runId: context?.runId,
    turnId: context?.turnId || context?.runId,
  };
}

function emitTrace(context: {
  _onTrace?: (trace: any) => void;
  chatId?: string;
  ownerTraceId?: string;
  runId?: string;
  turnId?: string;
} | undefined, event: any): boolean {
  const ownedEvent = {
    ...(context?.ownerTraceId && !event?.ownerTraceId ? { ownerTraceId: context.ownerTraceId } : {}),
    ...(context?.runId && !event?.runId ? { runId: context.runId } : {}),
    ...(context?.turnId && !event?.turnId ? { turnId: context.turnId } : {}),
    ...event,
  };
  if (typeof context?._onTrace === 'function') {
    try {
      context._onTrace(ownedEvent);
      return true;
    } catch {
      // A disconnected chat stream must not interrupt process output handling.
    }
  }

  if (context?.chatId) {
    try {
      const { taskStore } = require('../../task-store');
      taskStore.addTrace(context.chatId, ownedEvent, context.runId);
      return true;
    } catch {
      // Trace persistence is best-effort.
    }
  }
  return false;
}

async function killProcessTree(pid?: number, child?: ChildProcess): Promise<void> {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('The process has no PID yet.');
  const childExited = () => Boolean(child && (child.exitCode !== null || child.signalCode !== null));
  if (process.platform === 'win32') {
    const drained = () => (!child?.stdout || child.stdout.readableEnded) && (!child?.stderr || child.stderr.readableEnded);
    // Never taskkill a saved/reused PID once the live parent handle has exited.
    if (childExited()) {
      // Normal exit can precede pipe closure; allow its buffered output to
      // drain before treating open inherited pipes as surviving descendants.
      const drainDeadline = Date.now() + 2_000;
      while (!drained() && Date.now() < drainDeadline) await new Promise(resolve => setTimeout(resolve, 25));
      if (drained()) return;
      throw new Error('The shell has exited but its output pipes are still open. Its descendants no longer have a safe process-tree handle.');
    }
    await new Promise<void>((resolve, reject) => {
      const rootKey = Object.keys(process.env).find(key => key.toLowerCase() === 'systemroot')
        || Object.keys(process.env).find(key => key.toLowerCase() === 'windir');
      const taskkill = path.join(rootKey && process.env[rootKey] || 'C:\\Windows', 'System32', 'taskkill.exe');
      execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, (error, _stdout, stderr) => {
        if (error && (!childExited() || !drained() || isProcessAlive(pid))) reject(new Error(stderr?.trim() || error.message));
        else resolve();
      });
    });
    return;
  }
  // Detached commands own a process group; terminate pipelines and descendants too.
  const groupAlive = () => isProcessAlive(-pid);
  // Choose the target once. If a group disappears during escalation, do not
  // fall back to a positive PID that the OS could already have reassigned.
  const useGroup = groupAlive();
  const alive = () => useGroup ? groupAlive() : !childExited() && isProcessAlive(pid);
  const signal = (value: NodeJS.Signals) => {
    if (!useGroup && childExited()) return;
    try {
      if (useGroup) process.kill(-pid, value);
      else if (child) child.kill(value);
      else process.kill(pid, value);
    } catch (error: any) {
      if (error?.code !== 'ESRCH') throw error;
    }
  };
  if (!alive()) return;
  signal('SIGTERM');
  const deadline = Date.now() + 2_000;
  while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  if (!alive()) return;
  signal('SIGKILL');
  const killDeadline = Date.now() + 2_000;
  while (alive() && Date.now() < killDeadline) await new Promise(resolve => setTimeout(resolve, 50));
  if (alive()) throw new Error('The process could not be stopped. It may require different OS permissions.');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but this runtime is not allowed to
    // signal it. Treating that as dead creates false failures after restarts.
    return error?.code === 'EPERM';
  }
}
