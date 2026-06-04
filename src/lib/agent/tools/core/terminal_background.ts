import { ChildProcess, exec, spawn } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs-extra';
import {
  emitRuntimeTrace,
  normalizeCheckInMs,
  normalizeHardTimeoutMs,
  secondsFromTimeoutMs,
  terminalBackgroundHandoffNote,
  terminalTimeoutNote
} from './terminal_timeout';

type TerminalTaskStatus = 'running' | 'completed' | 'failed' | 'killed';

export interface TerminalCommandRunOptions {
  command: string;
  cwd: string;
  source: string;
  context?: any;
  description?: string;
  shell?: boolean | string;
  env?: NodeJS.ProcessEnv;
  checkInMs?: number;
  hardTimeoutMs?: number;
  maxOutputChars?: number;
  traceThrottleMs?: number;
}

export interface TerminalBackgroundTask {
  id: string;
  command: string;
  description: string;
  source: string;
  cwd: string;
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
  traceContext?: { _onTrace?: (trace: any) => void; chatId?: string };
  flushTimer?: NodeJS.Timeout;
  persistTimer?: NodeJS.Timeout;
  checkTimer?: NodeJS.Timeout;
  statusTimer?: NodeJS.Timeout;
}

const TASKS_DIR = path.resolve(process.cwd(), '.workspaces', 'background_tasks');
const DEFAULT_MAX_OUTPUT_CHARS = 10 * 1024 * 1024;
const DEFAULT_TRACE_THROTTLE_MS = 250;

const globalForTerminalTasks = globalThis as typeof globalThis & {
  __eterxTerminalBackgroundTasks?: Map<string, TerminalBackgroundTask>;
};

const terminalTasks: Map<string, TerminalBackgroundTask> =
  globalForTerminalTasks.__eterxTerminalBackgroundTasks ||
  (globalForTerminalTasks.__eterxTerminalBackgroundTasks = new Map());

export async function runTerminalCommandWithCheckIn(options: TerminalCommandRunOptions): Promise<any> {
  await fs.ensureDir(TASKS_DIR);

  const checkInMs = normalizeCheckInMs(options.checkInMs, options.command);
  const hardTimeoutMs = normalizeHardTimeoutMs(options.hardTimeoutMs, checkInMs);
  const id = `term_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const startedAt = Date.now();
  const streamId = `${options.source}_${startedAt}_${crypto.randomBytes(3).toString('hex')}`;
  const traceContext = createTraceContext(options.context);

  const task: TerminalBackgroundTask = {
    id,
    command: options.command,
    description: options.description || options.command,
    source: options.source,
    cwd: options.cwd,
    status: 'running',
    startedAt,
    lastActivityAt: startedAt,
    exitCode: null,
    stdout: '',
    stderr: '',
    output: '',
    droppedOutputChars: 0,
    maxOutputChars: options.maxOutputChars || DEFAULT_MAX_OUTPUT_CHARS,
    checkInMs,
    hardTimeoutMs,
    handedOff: false,
    outputFile: path.join(TASKS_DIR, `${id}_output.txt`),
    statusFile: path.join(TASKS_DIR, `${id}_status.json`),
    streamId,
    traceContext
  };

  terminalTasks.set(id, task);
  await persistTaskStatus(task);

  const child = spawn(options.command, [], {
    cwd: options.cwd,
    shell: options.shell ?? true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: options.env || process.env
  });

  task.process = child;
  task.pid = child.pid || undefined;
  await persistTaskStatus(task);

  let resultResolved = false;
  let handoffTimer: NodeJS.Timeout | undefined;

  return new Promise((resolve) => {
    const resolveOnce = (result: any) => {
      if (resultResolved) return;
      resultResolved = true;
      if (handoffTimer) clearTimeout(handoffTimer);
      resolve(result);
    };

    const finishTask = async (status: TerminalTaskStatus, exitCode: number | null, signal?: string | null) => {
      task.status = status;
      task.exitCode = exitCode;
      task.signal = signal || null;
      task.completedAt = Date.now();
      clearTaskTimers(task);
      flushTaskOutput(task, true, exitCode ?? (status === 'completed' ? 0 : 1));
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
    };

    const onData = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      appendTaskOutput(task, stream, chunk.toString());
      scheduleTaskFlush(task, options.traceThrottleMs || DEFAULT_TRACE_THROTTLE_MS);
      scheduleTaskStatusPersist(task);
    };

    child.stdout?.on('data', (chunk: Buffer) => onData('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => onData('stderr', chunk));

    child.on('close', (code: number | null, signal: string | null) => {
      const status = code === 0 && !task.hardTimedOut ? 'completed' : 'failed';
      finishTask(status, task.hardTimedOut ? 124 : code, signal).catch(() => {
        resolveOnce(buildTerminalResult(task));
      });
    });

    child.on('error', (error: Error) => {
      appendTaskOutput(task, 'stderr', error.message);
      finishTask('failed', 1, null).catch(() => {
        resolveOnce(buildTerminalResult(task));
      });
    });

    handoffTimer = setTimeout(() => {
      if (task.status !== 'running') return;

      task.handedOff = true;
      flushTaskOutput(task, true);
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
    }, checkInMs);
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

export async function getTerminalBackgroundTaskStatus(taskId: string): Promise<any | null> {
  const inMemory = terminalTasks.get(taskId);
  if (inMemory) {
    return buildStatusResult(inMemory);
  }

  const statusFile = path.join(TASKS_DIR, `${taskId}_status.json`);
  if (!await fs.pathExists(statusFile)) return null;

  const status = await fs.readJson(statusFile);
  const outputFile = status.outputFile || path.join(TASKS_DIR, `${taskId}_output.txt`);
  const output = await readOutputTail(outputFile);
  return {
    success: true,
    terminalTask: true,
    taskId,
    status: status.status || 'unknown',
    running: status.status === 'running',
    command: status.command,
    cwd: status.cwd,
    pid: status.pid,
    exitCode: status.exitCode ?? null,
    startedAt: status.startedAt,
    completedAt: status.completedAt,
    elapsedMs: (status.completedAt || Date.now()) - status.startedAt,
    stdout: output,
    stderr: status.stderr || '',
    output,
    message: `Terminal task ${taskId}: ${status.status || 'unknown'} | "${status.description || status.command}"`,
    nextActionNote: status.status === 'running'
      ? `Use wait_timer, then background_task mode="check" with taskId="${taskId}". The process was restored from disk, so control may be limited after server restart.`
      : 'Read the final output and continue from the result.'
  };
}

export async function listTerminalBackgroundTasks(): Promise<any[]> {
  await fs.ensureDir(TASKS_DIR);
  const tasks = new Map<string, any>();

  for (const task of Array.from(terminalTasks.values())) {
    tasks.set(task.id, compactTask(task));
  }

  const files = await fs.readdir(TASKS_DIR).catch(() => []);
  for (const file of files) {
    if (!file.endsWith('_status.json')) continue;
    const taskId = file.replace('_status.json', '');
    if (tasks.has(taskId)) continue;
    try {
      const status = await fs.readJson(path.join(TASKS_DIR, file));
      if (status?.terminalTask === false) continue;
      tasks.set(taskId, {
        id: taskId,
        terminalTask: true,
        status: status.status,
        description: status.description || status.command,
        command: status.command,
        pid: status.pid,
        cwd: status.cwd,
        exitCode: status.exitCode ?? null,
        startedAt: status.startedAt,
        completedAt: status.completedAt,
        duration: status.completedAt ? `${((status.completedAt - status.startedAt) / 1000).toFixed(1)}s` : 'running'
      });
    } catch {
      // Ignore malformed status files.
    }
  }

  return Array.from(tasks.values());
}

export async function killTerminalBackgroundTask(taskId: string): Promise<any | null> {
  const task = terminalTasks.get(taskId);
  if (task) {
    if (task.status === 'running') {
      killProcessTree(task.pid);
      task.status = 'killed';
      task.exitCode = 143;
      task.completedAt = Date.now();
      appendTaskOutput(task, 'stderr', '\nKilled by agent.\n');
      clearTaskTimers(task);
      await persistTaskStatus(task);
    }
    return buildStatusResult(task);
  }

  const statusFile = path.join(TASKS_DIR, `${taskId}_status.json`);
  if (!await fs.pathExists(statusFile)) return null;
  const status = await fs.readJson(statusFile);
  if (status?.pid && status?.status === 'running') {
    killProcessTree(status.pid);
    status.status = 'killed';
    status.exitCode = 143;
    status.completedAt = Date.now();
    await fs.writeJson(statusFile, status, { spaces: 2 });
  }
  return getTerminalBackgroundTaskStatus(taskId);
}

function appendTaskOutput(task: TerminalBackgroundTask, stream: 'stdout' | 'stderr', text: string) {
  if (!text) return;
  task.lastActivityAt = Date.now();
  task[stream] = trimOutput(task[stream] + text, task.maxOutputChars).text;

  const combined = trimOutput(task.output + text, task.maxOutputChars);
  task.output = combined.text;
  task.droppedOutputChars += combined.dropped;

  fs.appendFile(task.outputFile, text).catch(() => undefined);
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
  }, throttleMs);
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
  const output = visibleOutput(task);
  if (!output.trim()) return;
  emitTrace(task.traceContext, {
    type: 'console_output',
    command: task.command,
    output,
    content: output,
    source: task.source,
    streamId: task.streamId,
    taskId: task.id,
    isStreaming: !final,
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
    exitCode: 0,
    executionTimeMs: Date.now() - task.startedAt,
    timedOut: false,
    stillRunning: true,
    backgroundTaskId: task.id,
    taskId: task.id,
    pid: task.pid,
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
    pid: task.pid,
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
    success: true,
    terminalTask: true,
    taskId: task.id,
    status: task.status,
    running: task.status === 'running',
    command: task.command,
    cwd: task.cwd,
    pid: task.pid,
    exitCode: task.exitCode ?? null,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    elapsedMs: (task.completedAt || Date.now()) - task.startedAt,
    stdout: task.stdout,
    stderr: task.stderr,
    output: visibleOutput(task),
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
  await fs.ensureDir(TASKS_DIR);
  await fs.writeJson(task.statusFile, serializeTask(task), { spaces: 2 });
}

function serializeTask(task: TerminalBackgroundTask): Record<string, any> {
  return {
    terminalTask: true,
    id: task.id,
    command: task.command,
    description: task.description,
    source: task.source,
    cwd: task.cwd,
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

function createTraceContext(context: any): { _onTrace?: (trace: any) => void; chatId?: string } {
  return {
    _onTrace: typeof context?._onTrace === 'function' ? context._onTrace : undefined,
    chatId: context?.chatId || context?.projectId
  };
}

function emitTrace(context: { _onTrace?: (trace: any) => void; chatId?: string } | undefined, event: any) {
  if (typeof context?._onTrace === 'function') {
    context._onTrace(event);
  }

  if (context?.chatId) {
    try {
      const { taskStore } = require('../../task-store');
      taskStore.addTrace(context.chatId, event);
    } catch {
      // Trace persistence is best-effort.
    }
  }
}

function killProcessTree(pid?: number) {
  if (!pid) return;

  if (process.platform === 'win32') {
    exec(`taskkill /PID ${pid} /T /F`, { windowsHide: true }, () => undefined);
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  const timer = setTimeout(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process already stopped.
    }
  }, 2_000);
  timer.unref?.();
}
