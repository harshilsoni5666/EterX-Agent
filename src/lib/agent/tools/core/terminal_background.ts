import { ChildProcess, execFile, spawn } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs-extra';
import { StringDecoder } from 'string_decoder';
import {
  emitRuntimeTrace,
  normalizeCheckInMs,
  normalizeHardTimeoutMs,
  secondsFromTimeoutMs,
  terminalBackgroundHandoffNote,
  terminalTimeoutNote
} from './terminal_timeout';
import { authorizeToolCommand } from '../security/command_broker';
import { buildTerminalShellInvocation } from './shell_resolver';
import { getEterxWorkspaceDir } from '../../storage-paths';

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
  env?: NodeJS.ProcessEnv;
  checkInMs?: number;
  hardTimeoutMs?: number;
  maxOutputChars?: number;
  traceThrottleMs?: number;
  immediateHandoff?: boolean;
  surviveRunSettlement?: boolean;
}

export interface TerminalBackgroundTask {
  id: string;
  command: string;
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
  checkInMs: number;
  hardTimeoutMs: number;
  handedOff: boolean;
  hardTimedOut?: boolean;
  outputFile: string;
  statusFile: string;
  streamId: string;
  process?: ChildProcess;
  traceContext?: {
    _onTrace?: (trace: any) => void;
    chatId?: string;
    ownerTraceId?: string;
    runId?: string;
  };
  flushTimer?: NodeJS.Timeout;
  persistTimer?: NodeJS.Timeout;
  checkTimer?: NodeJS.Timeout;
  statusTimer?: NodeJS.Timeout;
  pendingFileOutput: string;
  outputWrite?: Promise<void>;
  statusWrite?: Promise<void>;
}

const TASKS_DIR = getEterxWorkspaceDir('background_tasks');
const DEFAULT_MAX_OUTPUT_CHARS = 10 * 1024 * 1024;
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
  await fs.writeJson(tmpPath, data, { spaces: 2 });
  await fs.move(tmpPath, filePath, { overwrite: true });
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
  const hardTimeoutMs = normalizeHardTimeoutMs(options.hardTimeoutMs, checkInMs);
  // Terminal tools are explicit user-directed execution surfaces. Keep the
  // broker's historical default (network allowed) unless the caller opted
  // into a deny policy; this prevents npm/pip/git commands from being blocked
  // only after the first authorization pass.
  const networkPolicy = options.context?.networkPolicy === 'deny' && options.context?.allowNetwork !== true
    ? 'deny'
    : 'allow';
  const authorization: { allowed: boolean; cwd: string; env: NodeJS.ProcessEnv; reason?: string } = options.authorization
    ? { allowed: true, cwd: options.authorization.cwd, env: options.authorization.env }
    : await authorizeToolCommand({
      command: options.command,
      cwd: options.cwd,
      context: options.context,
      env: options.env,
      timeoutMs: hardTimeoutMs,
      network: networkPolicy,
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
    description: options.description || options.command,
    source: options.source,
    ownerChatId: String(options.context?.chatId || options.context?.projectId || '').trim() || undefined,
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
    maxOutputChars: options.maxOutputChars || DEFAULT_MAX_OUTPUT_CHARS,
    checkInMs,
    hardTimeoutMs,
    handedOff: false,
    outputFile: resolveUnder(TASKS_DIR, `${id}_output.txt`),
    statusFile: resolveUnder(TASKS_DIR, `${id}_status.json`),
    streamId,
    traceContext,
    pendingFileOutput: '',
  };

  terminalTasks.set(id, task);
  persistTaskStatus(task).catch(() => undefined);

  let invocation: ReturnType<typeof buildTerminalShellInvocation>;
  try {
    invocation = buildTerminalShellInvocation(options.command, options.shell);
    task.shell = invocation.file;
  } catch (error: any) {
    task.status = 'failed';
    task.exitCode = 127;
    task.completedAt = Date.now();
    appendTaskOutput(task, 'stderr', String(error?.message || error));
    flushTaskOutput(task, true, 127);
    await persistTaskStatus(task);
    return buildTerminalResult(task);
  }

  let child: ChildProcess;
  try {
    child = spawn(invocation.file, invocation.args, {
      cwd: authorization.cwd,
      shell: invocation.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: authorization.env,
      detached: process.platform !== 'win32',
    });
  } catch (error: any) {
    task.status = 'failed';
    task.exitCode = 127;
    task.completedAt = Date.now();
    appendTaskOutput(task, 'stderr', String(error?.message || error));
    flushTaskOutput(task, true, 127);
    await persistTaskStatus(task);
    return buildTerminalResult(task);
  }

  task.process = child;
  task.pid = child.pid || undefined;
  // Attach process listeners immediately. Awaiting disk I/O here lets very
  // short commands exit before their output/close events have subscribers.
  persistTaskStatus(task).catch(() => undefined);

  let resultResolved = false;
  let handoffTimer: NodeJS.Timeout | undefined;

  return new Promise((resolve) => {
    const abortSignal = options.context?.abortSignal as AbortSignal | undefined;
    let onAbort = () => {};
    let finishStarted = false;
    const resolveOnce = (result: any) => {
      if (resultResolved) return;
      resultResolved = true;
      abortSignal?.removeEventListener('abort', onAbort);
      if (handoffTimer) clearTimeout(handoffTimer);
      resolve(result);
    };

    const finishTask = async (status: TerminalTaskStatus, exitCode: number | null, signal?: string | null) => {
      if (finishStarted || task.status !== 'running') return;
      finishStarted = true;
      task.status = status;
      task.exitCode = exitCode;
      task.signal = signal || null;
      task.completedAt = Date.now();
      clearTaskTimers(task);
      flushTaskOutput(task, true, exitCode ?? (status === 'completed' ? 0 : 1));
      await waitForTaskOutputWrites(task);
      await persistTaskStatus(task);

      if (task.handedOff) {
        emitRuntimeTrace(task.traceContext, {
          type: 'terminal_task_completed',
          text: `Terminal task ${status}`,
          title: 'Terminal command',
          note: `Task ${task.id} ${status} with exit code ${exitCode ?? 'unknown'}. Check background_task for final output.`,
          command: task.command,
          taskId: task.id,
          exitCode,
          durationMs: Date.now() - task.startedAt,
          iconCategory: 'terminal'
        });
      }

      resolveOnce(buildTerminalResult(task));
      const retentionTimer = setTimeout(() => {
        if (terminalTasks.get(task.id) === task && task.status !== 'running') {
          terminalTasks.delete(task.id);
        }
      }, 15 * 60 * 1000);
      retentionTimer.unref?.();
    };

    onAbort = () => {
      if (task.status !== 'running') return;
      const reason = String((abortSignal as any)?.reason?.message || (abortSignal as any)?.reason || '');
      if (options.surviveRunSettlement && task.handedOff && reason.includes('MAIN_RUN_SETTLED')) {
        abortSignal?.removeEventListener('abort', onAbort);
        return;
      }
      appendTaskOutput(task, 'stderr', '\nCancelled by user.\n');
      killProcessTree(task.pid);
      finishTask('killed', 130, 'SIGTERM').catch(() => {
        resolveOnce(buildTerminalResult(task));
      });
    };

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let decodersFlushed = false;
    const onData = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
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

    child.stdout?.on('data', (chunk: Buffer) => onData('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => onData('stderr', chunk));

    child.on('close', (code: number | null, signal: string | null) => {
      flushDecoders();
      const status = code === 0 && !task.hardTimedOut ? 'completed' : 'failed';
      finishTask(status, task.hardTimedOut ? 124 : code, signal).catch(() => {
        resolveOnce(buildTerminalResult(task));
      });
    });

    child.on('error', (error: Error) => {
      flushDecoders();
      appendTaskOutput(task, 'stderr', error.message);
      finishTask('failed', 1, null).catch(() => {
        resolveOnce(buildTerminalResult(task));
      });
    });

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
      const note = terminalBackgroundHandoffNote(task.command, task.id, task.checkInMs);
      emitRuntimeTrace(task.traceContext, {
        type: 'timer_expired',
        text: 'Terminal command still running',
        title: 'Terminal command',
        note,
        durationMs: task.checkInMs,
        command: task.command,
        taskId: task.id,
        iconCategory: 'terminal'
      });
      scheduleAutomatedCheckIns(task);
      persistTaskStatus(task).catch(() => undefined);
      resolveOnce(buildRunningResult(task, note));
    }, options.immediateHandoff ? 0 : checkInMs);
    handoffTimer.unref?.();

    task.statusTimer = setTimeout(() => {
      if (task.status !== 'running') return;
      task.hardTimedOut = true;
      appendTaskOutput(task, 'stderr', `\n${terminalTimeoutNote(task.command, task.hardTimeoutMs)}\n`);
      killProcessTree(task.pid);
    }, hardTimeoutMs);
    task.statusTimer.unref?.();
  });
}

export async function getTerminalBackgroundTaskStatus(taskId: string, ownerChatId?: string): Promise<any | null> {
  taskId = safeTaskId(taskId);
  if (!taskId) return null;
  const requestedOwner = String(ownerChatId || '').trim();
  const inMemory = terminalTasks.get(taskId);
  if (inMemory) {
    if (requestedOwner && inMemory.ownerChatId !== requestedOwner) return null;
    return buildStatusResult(inMemory);
  }

  const statusFile = resolveUnder(TASKS_DIR, `${taskId}_status.json`);
  if (!await fs.pathExists(statusFile)) return null;

  const status = await fs.readJson(statusFile);
  if (requestedOwner && String(status.ownerChatId || '') !== requestedOwner) return null;
  const outputFile = status.outputFile && isPathInside(TASKS_DIR, path.resolve(status.outputFile))
    ? status.outputFile
    : resolveUnder(TASKS_DIR, `${taskId}_output.txt`);
  const output = await readOutputTail(outputFile);
  let persistedStatus = status.status || 'unknown';
  if (persistedStatus === 'running' && (!status.pid || !isProcessAlive(status.pid))) {
    // A status file can outlive the Node process that launched it. Persist the
    // terminal failure once so every later poll sees a settled task instead of
    // repeatedly treating a dead PID as live.
    persistedStatus = 'failed';
    status.status = 'failed';
    status.exitCode = status.exitCode ?? 1;
    status.completedAt = status.completedAt || Date.now();
    await writeJsonAtomic(statusFile, status).catch(() => undefined);
  }
  return {
    success: persistedStatus === 'completed',
    terminalTask: true,
    taskId,
    streamId: String(status.streamId || `terminal_${taskId}`),
    ownerTraceId: status.ownerTraceId,
    runId: status.runId,
    status: persistedStatus,
    running: persistedStatus === 'running',
    command: status.command,
    cwd: status.cwd,
    shell: status.shell,
    pid: status.pid,
    exitCode: status.exitCode ?? null,
    startedAt: status.startedAt,
    completedAt: status.completedAt,
    elapsedMs: (status.completedAt || Date.now()) - status.startedAt,
    stdout: output,
    stderr: status.stderr || '',
    output,
    totalOutputChars: status.totalOutputChars ?? output.length,
    droppedOutputChars: status.droppedOutputChars ?? 0,
    message: `Terminal task ${taskId}: ${persistedStatus} | "${status.description || status.command}"`,
    nextActionNote: persistedStatus === 'running'
      ? `Use wait_timer, then background_task mode="check" with taskId="${taskId}". The process was restored from disk, so control may be limited after server restart.`
      : 'Read the final output and continue from the result.'
  };
}

export async function listTerminalBackgroundTasks(ownerChatId?: string): Promise<any[]> {
  await fs.ensureDir(TASKS_DIR);
  const requestedOwner = String(ownerChatId || '').trim();
  const tasks = new Map<string, any>();

  for (const task of Array.from(terminalTasks.values())) {
    if (requestedOwner && task.ownerChatId !== requestedOwner) continue;
    tasks.set(task.id, compactTask(task));
  }

  const files = await fs.readdir(TASKS_DIR).catch(() => []);
  for (const file of files) {
    if (!file.endsWith('_status.json')) continue;
    const taskId = file.replace('_status.json', '');
    if (tasks.has(taskId)) continue;
    try {
      const status = await fs.readJson(resolveUnder(TASKS_DIR, file));
      if (status?.terminalTask === false) continue;
      if (requestedOwner && String(status.ownerChatId || '') !== requestedOwner) continue;
      let persistedStatus = status.status;
      if (persistedStatus === 'running' && (!status.pid || !isProcessAlive(status.pid))) {
        persistedStatus = 'failed';
        status.status = 'failed';
        status.exitCode = status.exitCode ?? 1;
        status.completedAt = status.completedAt || Date.now();
        await writeJsonAtomic(resolveUnder(TASKS_DIR, file), status).catch(() => undefined);
      }
      tasks.set(taskId, {
        id: taskId,
        terminalTask: true,
        status: persistedStatus,
        description: status.description || status.command,
        command: status.command,
        ownerTraceId: status.ownerTraceId,
        runId: status.runId,
        pid: status.pid,
        cwd: status.cwd,
        exitCode: status.exitCode ?? null,
        startedAt: status.startedAt,
        completedAt: status.completedAt,
        duration: status.completedAt ? `${((status.completedAt - status.startedAt) / 1000).toFixed(1)}s` : (persistedStatus === 'running' ? 'running' : 'unknown')
      });
    } catch {
      // Ignore malformed status files.
    }
  }

  return Array.from(tasks.values());
}

export async function killTerminalBackgroundTask(taskId: string, ownerChatId?: string): Promise<any | null> {
  taskId = safeTaskId(taskId);
  if (!taskId) return null;
  const requestedOwner = String(ownerChatId || '').trim();
  const task = terminalTasks.get(taskId);
  if (task) {
    if (requestedOwner && task.ownerChatId !== requestedOwner) return null;
    if (task.status === 'running') {
      killProcessTree(task.pid);
      task.status = 'killed';
      task.exitCode = 143;
      task.completedAt = Date.now();
      appendTaskOutput(task, 'stderr', '\nKilled by agent.\n');
      clearTaskTimers(task);
      flushTaskOutput(task, true, 143);
      await waitForTaskOutputWrites(task);
      await persistTaskStatus(task);
    }
    return buildStatusResult(task);
  }

  const statusFile = resolveUnder(TASKS_DIR, `${taskId}_status.json`);
  if (!await fs.pathExists(statusFile)) return null;
  const status = await fs.readJson(statusFile);
  if (requestedOwner && String(status.ownerChatId || '') !== requestedOwner) return null;
  if (status?.pid && status?.status === 'running') {
    killProcessTree(status.pid);
    status.status = 'killed';
    status.exitCode = 143;
    status.completedAt = Date.now();
    await writeJsonAtomic(statusFile, status);
  }
  return getTerminalBackgroundTaskStatus(taskId, requestedOwner);
}

function appendTaskOutput(task: TerminalBackgroundTask, stream: 'stdout' | 'stderr', text: string) {
  if (!text) return;
  task.lastActivityAt = Date.now();
  task.totalOutputChars += text.length;
  task.pendingTraceOutput += text;
  task[stream] = trimOutput(task[stream] + text, task.maxOutputChars).text;

  const combined = trimOutput(task.output + text, task.maxOutputChars);
  task.output = combined.text;
  task.droppedOutputChars += combined.dropped;

  task.pendingFileOutput += text;
  scheduleTaskOutputWrite(task);
}

function scheduleTaskOutputWrite(task: TerminalBackgroundTask) {
  if (task.outputWrite || !task.pendingFileOutput) return;

  task.outputWrite = (async () => {
    await fs.ensureDir(TASKS_DIR);
    while (task.pendingFileOutput) {
      const batch = task.pendingFileOutput;
      task.pendingFileOutput = '';
      await fs.appendFile(task.outputFile, batch);
    }

    const stats = await fs.stat(task.outputFile).catch(() => null);
    if (stats && stats.size > MAX_PERSISTED_OUTPUT_BYTES) {
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
    .catch(() => undefined)
    .finally(() => {
      task.outputWrite = undefined;
      if (task.pendingFileOutput) scheduleTaskOutputWrite(task);
    });
}

async function waitForTaskOutputWrites(task: TerminalBackgroundTask): Promise<void> {
  while (task.outputWrite || task.pendingFileOutput) {
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
    flushTaskOutput(task);
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

function flushTaskOutput(task: TerminalBackgroundTask, final = false, exitCode?: number | null) {
  const outputChunk = task.pendingTraceOutput;
  const outputStart = task.traceOutputOffset;
  const outputEnd = task.totalOutputChars;
  if (!outputChunk && !final) return;

  task.pendingTraceOutput = '';
  task.traceOutputOffset = outputEnd;
  const output = final ? terminalTraceSnapshotOutput(task) : outputChunk;
  emitTrace(task.traceContext, {
    type: 'console_output',
    command: task.command,
    output,
    source: task.source,
    cwd: task.cwd,
    shell: task.shell,
    pid: task.pid,
    streamId: task.streamId,
    taskId: task.id,
    ownerTraceId: task.traceContext?.ownerTraceId,
    runId: task.traceContext?.runId,
    toolName: task.source,
    isStreaming: !final,
    isDelta: !final,
    outputStart: final ? Math.max(0, task.totalOutputChars - task.output.length) : outputStart,
    outputEnd,
    totalOutputChars: task.totalOutputChars,
    droppedOutputChars: task.droppedOutputChars,
    ...(final ? { exitCode: exitCode ?? task.exitCode ?? 0, durationMs: Date.now() - task.startedAt } : {})
  });
}

function scheduleAutomatedCheckIns(task: TerminalBackgroundTask) {
  if (task.checkTimer) return;
  task.checkTimer = setInterval(() => {
    if (task.status !== 'running') {
      clearTaskTimers(task);
      return;
    }

    const seconds = secondsFromTimeoutMs(task.checkInMs);
    emitRuntimeTrace(task.traceContext, {
      type: 'timer_expired',
      text: 'Terminal background check-in',
      title: 'Terminal command',
      note: `Task ${task.id} is still running. Use background_task mode="check" with this taskId, or wait another ${seconds} seconds if there is no new output.`,
      durationMs: task.checkInMs,
      command: task.command,
      taskId: task.id,
      iconCategory: 'terminal'
    });
    persistTaskStatus(task).catch(() => undefined);
  }, task.checkInMs);
  task.checkTimer.unref?.();
}

function buildRunningResult(task: TerminalBackgroundTask, note: string): any {
  return {
    success: true,
    stdout: task.stdout,
    stderr: task.stderr,
    output: visibleOutput(task),
    exitCode: null,
    executionTimeMs: Date.now() - task.startedAt,
    timedOut: false,
    stillRunning: true,
    backgroundTaskId: task.id,
    taskId: task.id,
    streamId: task.streamId,
    ownerTraceId: task.traceContext?.ownerTraceId,
    runId: task.traceContext?.runId,
    cwd: task.cwd,
    shell: task.shell,
    pid: task.pid,
    totalOutputChars: task.totalOutputChars,
    droppedOutputChars: task.droppedOutputChars,
    status: task.status,
    checkInMs: task.checkInMs,
    hardTimeoutMs: task.hardTimeoutMs,
    _consoleTraceEmitted: true,
    nextActionNote: note
  };
}

function buildTerminalResult(task: TerminalBackgroundTask): any {
  const hardTimeoutNote = task.hardTimedOut ? terminalTimeoutNote(task.command, task.hardTimeoutMs) : '';
  return {
    success: task.status === 'completed',
    stdout: task.stdout,
    stderr: task.stderr + (hardTimeoutNote ? `\n${hardTimeoutNote}` : ''),
    output: visibleOutput(task),
    exitCode: task.hardTimedOut ? 124 : task.exitCode ?? (task.status === 'completed' ? 0 : 1),
    executionTimeMs: (task.completedAt || Date.now()) - task.startedAt,
    timedOut: Boolean(task.hardTimedOut),
    stillRunning: task.status === 'running',
    backgroundTaskId: task.handedOff ? task.id : undefined,
    taskId: task.id,
    streamId: task.streamId,
    ownerTraceId: task.traceContext?.ownerTraceId,
    runId: task.traceContext?.runId,
    cwd: task.cwd,
    shell: task.shell,
    pid: task.pid,
    totalOutputChars: task.totalOutputChars,
    droppedOutputChars: task.droppedOutputChars,
    status: task.status,
    timeoutMs: task.checkInMs,
    hardTimeoutMs: task.hardTimeoutMs,
    _consoleTraceEmitted: true,
    nextActionNote: task.status === 'running'
      ? terminalBackgroundHandoffNote(task.command, task.id, task.checkInMs)
      : undefined
  };
}

function buildStatusResult(task: TerminalBackgroundTask): any {
  return {
    success: task.status === 'completed',
    terminalTask: true,
    taskId: task.id,
    streamId: task.streamId,
    ownerTraceId: task.traceContext?.ownerTraceId,
    runId: task.traceContext?.runId,
    status: task.status,
    running: task.status === 'running',
    command: task.command,
    cwd: task.cwd,
    shell: task.shell,
    pid: task.pid,
    exitCode: task.exitCode ?? null,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    elapsedMs: (task.completedAt || Date.now()) - task.startedAt,
    stdout: task.stdout,
    stderr: task.stderr,
    output: visibleOutput(task),
    totalOutputChars: task.totalOutputChars,
    droppedOutputChars: task.droppedOutputChars,
    message: `Terminal task ${task.id}: ${task.status} | "${task.description}" | Duration: ${(((task.completedAt || Date.now()) - task.startedAt) / 1000).toFixed(1)}s`,
    nextActionNote: task.status === 'running'
      ? `Use wait_timer for ${secondsFromTimeoutMs(task.checkInMs)} seconds, then background_task mode="check" with taskId="${task.id}".`
      : 'Read the final output and continue from the result.'
  };
}

function compactTask(task: TerminalBackgroundTask): any {
  return {
    id: task.id,
    terminalTask: true,
    status: task.status,
    description: task.description,
    command: task.command.substring(0, 120),
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
  task.statusWrite = (task.statusWrite || Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      await fs.ensureDir(TASKS_DIR);
      await writeJsonAtomic(task.statusFile, serializeTask(task));
    });
  await task.statusWrite;
}

function serializeTask(task: TerminalBackgroundTask): Record<string, any> {
  return {
    terminalTask: true,
    id: task.id,
    command: task.command,
    description: task.description,
    source: task.source,
    ownerChatId: task.ownerChatId,
    streamId: task.streamId,
    ownerTraceId: task.traceContext?.ownerTraceId,
    runId: task.traceContext?.runId,
    cwd: task.cwd,
    shell: task.shell,
    pid: task.pid,
    status: task.status,
    startedAt: task.startedAt,
    lastActivityAt: task.lastActivityAt,
    completedAt: task.completedAt,
    exitCode: task.exitCode ?? null,
    signal: task.signal ?? null,
    stderr: task.stderr.slice(-12_000),
    outputFile: task.outputFile,
    statusFile: task.statusFile,
    droppedOutputChars: task.droppedOutputChars,
    totalOutputChars: task.totalOutputChars,
    checkInMs: task.checkInMs,
    hardTimeoutMs: task.hardTimeoutMs,
    handedOff: task.handedOff,
    hardTimedOut: task.hardTimedOut || false
  };
}

async function readOutputTail(filePath: string, maxChars = 12_000): Promise<string> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content.length > maxChars
      ? `...[${content.length - maxChars} earlier chars truncated from terminal output]...\n${content.slice(-maxChars)}`
      : content;
  } catch {
    return '';
  }
}

function createTraceContext(context: any): {
  _onTrace?: (trace: any) => void;
  chatId?: string;
  ownerTraceId?: string;
  runId?: string;
} {
  return {
    _onTrace: typeof context?._onTrace === 'function' ? context._onTrace : undefined,
    chatId: context?.chatId || context?.projectId,
    ownerTraceId: context?.ownerTraceId,
    runId: context?.runId || context?.turnId,
  };
}

function emitTrace(context: {
  _onTrace?: (trace: any) => void;
  chatId?: string;
  ownerTraceId?: string;
  runId?: string;
} | undefined, event: any) {
  if (typeof context?._onTrace === 'function') {
    context._onTrace(event);
    return;
  }

  if (context?.chatId) {
    try {
      const { taskStore } = require('../../task-store');
      taskStore.addTrace(context.chatId, event, context.runId);
    } catch {
      // Trace persistence is best-effort.
    }
  }
}

function killProcessTree(pid?: number) {
  if (!pid) return;

  if (process.platform === 'win32') {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    return;
  }

  signalProcessGroup(pid, 'SIGTERM');

  const timer = setTimeout(() => {
    signalProcessGroup(pid, 'SIGKILL');
  }, 2_000);
  timer.unref?.();
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  let signalled = false;
  try {
    // POSIX terminal children are detached into their own process group so
    // pipelines and grandchildren are terminated together.
    process.kill(-pid, signal);
    signalled = true;
  } catch {
    // Older tasks may not have been detached; fall back to the direct PID.
  }
  if (!signalled) {
    try { process.kill(pid, signal); } catch { /* already stopped */ }
  }
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
