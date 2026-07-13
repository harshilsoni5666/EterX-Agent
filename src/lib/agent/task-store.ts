import fs from 'fs-extra';
import path from 'path';

/**
 * TaskStore — Persistent Server-Side Task State
 *
 * Saves task execution state (trace logs, status, final answer) to disk.
 *
 * What this DOES:
 * - Allows the polling UI to retrieve streamed trace events and the final answer
 *   even after a page reload or network blip.
 * - Persists the last known status and answer for completed/stopped/failed tasks.
 * - Each chat's task state is fully independent (keyed by chatId).
 *
 * What this does NOT do:
 * - Running tasks are NOT resumed after a process restart. The Node.js
 *   process dies with the task; on the next cleanup pass those entries
 *   are detected (status='running' + age > 2 h) and marked 'failed'.
 *
 * Storage: .workspaces/.tasks/{chatId}.json
 */

const TASKS_DIR = path.resolve(process.cwd(), '.workspaces', '.tasks');
const MAX_TASK_CACHE_ENTRIES = 80;
const MAX_RUNNING_TRACE_LOGS = 700;
const MAX_COMPLETED_TRACE_LOGS = 350;
const MAX_PROMPT_CHARS = 12000;
const MAX_FINAL_ANSWER_CHARS = 100000;

export interface PersistedTask {
  taskId: string;
  chatId: string;
  runId?: string;
  prompt: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  traceLogs: any[];
  finalAnswer: string;
  startedAt: number;
  completedAt?: number;
  lastUpdatedAt: number;
}

// Debounce timers per chat to prevent I/O spam
const writeTimers: Map<string, NodeJS.Timeout> = new Map();
const DEBOUNCE_MS = 500;

// In-memory cache for fast reads
const taskCache: Map<string, PersistedTask> = new Map();

async function ensureDir() {
  await fs.ensureDir(TASKS_DIR);
}

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

function getTaskPath(chatId: string): string {
  // Sanitize chatId for filesystem safety
  const safe = (chatId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || '_global');
  return resolveUnder(TASKS_DIR, `${safe}.json`);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.writeJson(tmpPath, value, { spaces: 2 });
  await fs.move(tmpPath, filePath, { overwrite: true });
}

function compactTraceEvent(traceEvent: any): any {
  if (!traceEvent || typeof traceEvent !== 'object') return traceEvent;

  if (traceEvent.type === 'file_preview') {
    const { content, diffLines, ...rest } = traceEvent;
    const compact: any = { ...rest };
    if (typeof content === 'string') {
      compact.contentPreview = content.substring(0, 2000);
      compact._contentStripped = content.length > compact.contentPreview.length;
    }
    if (Array.isArray(diffLines)) {
      compact.diffLines = diffLines.slice(-80);
      compact._diffLinesStripped = diffLines.length > compact.diffLines.length;
    }
    return compact;
  }

  if (traceEvent.type === 'console_output') {
    const { output, ...rest } = traceEvent;
    const outputText = String(output || '');
    return {
      ...rest,
      output: outputText.length > 2500 ? `${outputText.substring(0, 2500)}\n...[output compacted]` : outputText,
      _contentStripped: outputText.length > 2500,
    };
  }

  if ((traceEvent.type === 'thought_stream' || traceEvent.type === 'work_note') && typeof traceEvent.text === 'string' && traceEvent.text.length > 12000) {
    return {
      ...traceEvent,
      text: `${traceEvent.text.substring(0, 12000)}\n...[trace compacted]`,
      _contentStripped: true,
    };
  }

  return traceEvent;
}

function trimTask(task: PersistedTask, compactAll = false): void {
  task.prompt = String(task.prompt || '').substring(0, MAX_PROMPT_CHARS);
  task.finalAnswer = String(task.finalAnswer || '').substring(0, MAX_FINAL_ANSWER_CHARS);
  const limit = task.status === 'running' ? MAX_RUNNING_TRACE_LOGS : MAX_COMPLETED_TRACE_LOGS;
  const traceLogs = (task.traceLogs || []).slice(-limit);
  task.traceLogs = compactAll ? traceLogs.map(compactTraceEvent) : traceLogs;
}

function rememberTask(chatId: string, task: PersistedTask): void {
  taskCache.delete(chatId);
  taskCache.set(chatId, task);

  while (taskCache.size > MAX_TASK_CACHE_ENTRIES) {
    let oldestChatId: string | null = null;
    let oldestUpdatedAt = Number.POSITIVE_INFINITY;

    for (const [id, cached] of taskCache.entries()) {
      if (cached.status === 'running') continue;
      const updatedAt = cached.completedAt || cached.lastUpdatedAt || cached.startedAt || 0;
      if (updatedAt < oldestUpdatedAt) {
        oldestUpdatedAt = updatedAt;
        oldestChatId = id;
      }
    }

    if (!oldestChatId) break;
    taskCache.delete(oldestChatId);
  }
}

/**
 * Flush a task to disk immediately (bypassing debounce).
 */
async function flushToDisk(chatId: string): Promise<void> {
  const task = taskCache.get(chatId);
  if (!task) return;
  
  try {
    await ensureDir();
    trimTask(task);
    await writeJsonAtomic(getTaskPath(chatId), task);
  } catch (err: any) {
    console.warn(`[TaskStore] ⚠️ Failed to persist task for ${chatId}: ${err.message}`);
  }
}

/**
 * Schedule a debounced write to disk.
 * For high-frequency trace events, this batches writes.
 */
function scheduleDiskWrite(chatId: string): void {
  const existing = writeTimers.get(chatId);
  if (existing) clearTimeout(existing);
  
  writeTimers.set(chatId, setTimeout(() => {
    flushToDisk(chatId).catch(() => {});
    writeTimers.delete(chatId);
  }, DEBOUNCE_MS));
  writeTimers.get(chatId)?.unref?.();
}

export const taskStore = {
  /**
   * Create a new task entry when a chat request starts.
   */
  async createTask(chatId: string, prompt: string, runId?: string): Promise<string> {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    
    const task: PersistedTask = {
      taskId,
      chatId,
      runId,
      prompt,
      status: 'running',
      traceLogs: [],
      finalAnswer: '',
      startedAt: Date.now(),
      lastUpdatedAt: Date.now(),
    };
    
    rememberTask(chatId, task);
    await flushToDisk(chatId); // Immediate write for task creation
    console.log(`[TaskStore] 📝 Created task ${taskId} for chat ${chatId.substring(0, 8)}...`);
    return taskId;
  },

  /**
   * Append a trace log event. Debounced to prevent I/O spam during streaming.
   */
  addTrace(chatId: string, traceEvent: any): void {
    const task = taskCache.get(chatId);
    if (!task) return;

    const now = Date.now();
    const compactEvent = compactTraceEvent(traceEvent);
    const timedEvent = compactEvent && typeof compactEvent === 'object'
      ? { timestamp: now, ...compactEvent }
      : compactEvent;

    if (timedEvent?.type === 'work_note_cancel') {
      const noteId = timedEvent.noteId || null;
      const subAgent = timedEvent.subAgent || null;
      for (let i = task.traceLogs.length - 1; i >= 0; i--) {
        const log = task.traceLogs[i];
        if (
          log?.type === 'work_note' &&
          (log.subAgent || null) === subAgent &&
          (!noteId || log.noteId === noteId)
        ) {
          task.traceLogs[i] = { ...log, _streamingCancelled: true };
          break;
        }
      }
    } else if (timedEvent?.type === 'work_note') {
      const noteText = String(timedEvent.text || '').trim();
      if (!noteText) return;
      const noteId = timedEvent.noteId || null;
      const subAgent = timedEvent.subAgent || null;
      const incomingIsFinal = timedEvent.isStreaming === false || timedEvent.isDelta === false;
      let mergeIdx = -1;
      for (let i = task.traceLogs.length - 1; i >= 0; i--) {
        const log = task.traceLogs[i];
        if (log?.type !== 'work_note' || (log.subAgent || null) !== subAgent) continue;
        const sameNote = noteId && log.noteId && log.noteId === noteId;
        const sameText = String(log.text || '').trim() === noteText;
        // Also merge final note into a streaming-cancelled placeholder
        const isCancelledPlaceholder = log._streamingCancelled && incomingIsFinal;
        if (sameNote || sameText || isCancelledPlaceholder) {
          mergeIdx = i;
          break;
        }
      }
      if (mergeIdx >= 0) {
        task.traceLogs[mergeIdx] = {
          ...task.traceLogs[mergeIdx],
          ...timedEvent,
          text: noteText,
          noteId,
          subAgent,
          _streamingCancelled: undefined,
        };
      } else {
        task.traceLogs.push({ ...timedEvent, text: noteText, noteId, subAgent });
      }
    } else {
      task.traceLogs.push(timedEvent);
    }
    task.lastUpdatedAt = now;
    
    // Keep trace logs bounded to prevent massive files
    trimTask(task);
    
    scheduleDiskWrite(chatId);
  },

  /**
   * Mark a task as completed with the final answer.
   */
  async completeTask(chatId: string, finalAnswer: string, success: boolean, statusOverride?: 'completed' | 'failed' | 'stopped'): Promise<void> {
    const task = taskCache.get(chatId);
    if (!task) return;
    
    task.status = statusOverride || (success ? 'completed' : 'failed');
    task.finalAnswer = finalAnswer;
    task.completedAt = Date.now();
    task.lastUpdatedAt = Date.now();
    trimTask(task);
    
    // Cancel any pending debounced write and flush immediately
    const timer = writeTimers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      writeTimers.delete(chatId);
    }
    
    await flushToDisk(chatId);
    console.log(`[TaskStore] ✅ Task ${task.taskId} completed (${task.status}) for chat ${chatId.substring(0, 8)}...`);
  },

  /**
   * Mark a task as stopped by user.
   */
  async stopTask(chatId: string, finalAnswer = 'Stopped by user.'): Promise<void> {
    const task = taskCache.get(chatId);
    if (!task || task.status !== 'running') return;
    
    task.status = 'stopped';
    task.finalAnswer = finalAnswer;
    task.completedAt = Date.now();
    task.lastUpdatedAt = Date.now();
    trimTask(task);
    
    const timer = writeTimers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      writeTimers.delete(chatId);
    }
    
    await flushToDisk(chatId);
    console.log(`[TaskStore] 🛑 Task stopped for chat ${chatId.substring(0, 8)}...`);
  },

  /**
   * Get the current task state for a chat.
   * Checks in-memory cache first, then disk.
   */
  async getTask(chatId: string): Promise<PersistedTask | null> {
    // Check in-memory cache first
    const cached = taskCache.get(chatId);
    if (cached) return cached;
    
    // Try loading from disk
    try {
      const taskPath = getTaskPath(chatId);
      if (await fs.pathExists(taskPath)) {
        const task = await fs.readJson(taskPath) as PersistedTask;
        trimTask(task, true);
        rememberTask(chatId, task);
        return task;
      }
    } catch { /* silent */ }
    
    return null;
  },

  /**
   * Check if a chat has an actively running task.
   */
  isRunning(chatId: string): boolean {
    const task = taskCache.get(chatId);
    return task?.status === 'running';
  },

  /**
   * Poll-compatible persisted task state.
   */
  async getPollState(chatId: string, afterIndex: number = -1): Promise<{
    status: PersistedTask['status'] | 'idle';
    traces: any[];
    totalTraces: number;
    maxIndex: number;
    finalAnswer: string;
    runId?: string;
    startedAt?: number;
    completedAt?: number;
    error?: string;
  }> {
    const task = await this.getTask(chatId);
    if (!task) {
      return { status: 'idle', traces: [], totalTraces: 0, maxIndex: -1, finalAnswer: '' };
    }

    const sourceTraces = task.traceLogs || [];
    const traces: any[] = [];
    let maxIndex = -1;

    for (let index = 0; index < sourceTraces.length; index++) {
      const trace = sourceTraces[index];
      const traceObj = trace && typeof trace === 'object' ? trace : { value: trace };
      const traceIndex = Number.isFinite(traceObj._traceIdx) ? traceObj._traceIdx : index;
      if (traceIndex > maxIndex) maxIndex = traceIndex;
      if (afterIndex < 0 || traceIndex > afterIndex) {
        const fallbackTimestamp = task.completedAt || task.lastUpdatedAt || task.startedAt;
        const indexedTrace = traceObj._traceIdx === traceIndex ? traceObj : { ...traceObj, _traceIdx: traceIndex };
        traces.push(indexedTrace.timestamp ? indexedTrace : { ...indexedTrace, timestamp: fallbackTimestamp });
      }
    }

    return {
      status: task.status,
      traces,
      totalTraces: sourceTraces.length,
      maxIndex,
      finalAnswer: task.finalAnswer,
      runId: task.runId,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      error: task.status === 'failed' ? task.finalAnswer : undefined,
    };
  },

  /**
   * Lightweight diagnostics for health endpoints.
   */
  getCacheStatus(): {
    cachedTasks: number;
    pendingWrites: number;
    runningTasks: number;
    completedTasks: number;
  } {
    let runningTasks = 0;
    let completedTasks = 0;
    for (const task of taskCache.values()) {
      if (task.status === 'running') runningTasks++;
      else completedTasks++;
    }
    return {
      cachedTasks: taskCache.size,
      pendingWrites: writeTimers.size,
      runningTasks,
      completedTasks,
    };
  },

  /**
   * Clean up completed/old task files (call periodically).
   */
  async cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<void> {
    try {
      await ensureDir();
      const files = await fs.readdir(TASKS_DIR);
      const cutoff = Date.now() - maxAgeMs;
      
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const taskPath = resolveUnder(TASKS_DIR, file);
          const data = await fs.readJson(taskPath);
          let lastUpdated = data.completedAt || data.lastUpdatedAt || data.startedAt || 0;
          
          // Auto-recover/fail tasks that have been "running" globally for >2 hours (likely App crashed)
          if (data.status === 'running' && (Date.now() - (data.lastUpdatedAt || data.startedAt)) > 2 * 60 * 60 * 1000) {
            console.log(`[TaskStore] 🧹 Task ${data.taskId} stuck in running state for >2 hours. Marking as failed.`);
            data.status = 'failed';
            data.finalAnswer = 'Task failed due to a system crash or timeout.';
            data.completedAt = Date.now();
            data.lastUpdatedAt = Date.now();
            data.traceLogs = (data.traceLogs || []).slice(-MAX_COMPLETED_TRACE_LOGS).map(compactTraceEvent);
            await writeJsonAtomic(taskPath, data);
            lastUpdated = data.completedAt || data.lastUpdatedAt || data.startedAt || 0;
          }

          if (data.status !== 'running' && lastUpdated < cutoff) {
            await fs.remove(taskPath);
            const chatId = data.chatId || file.replace('.json', '');
            taskCache.delete(chatId);
            const timer = writeTimers.get(chatId);
            if (timer) {
              clearTimeout(timer);
              writeTimers.delete(chatId);
            }
          }
        } catch { /* silent */ }
      }
    } catch { /* silent */ }
  },

  /**
   * Clear the in-memory cache entry for a chat (after client has retrieved results).
   */
  clearCache(chatId: string): void {
    taskCache.delete(chatId);
    const timer = writeTimers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      writeTimers.delete(chatId);
    }
  },
};
