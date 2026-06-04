import fs from 'fs-extra';
import path from 'path';
import { formatVisibleWorkNote } from './work-note';

/**
 * TaskStore — Persistent Server-Side Task State
 * 
 * Saves task execution state (trace logs, status, final answer) to disk.
 * This ensures that:
 * 1. If the app closes while a task is running, the task CONTINUES on the server
 * 2. When the app reopens, it can retrieve completed/running task results
 * 3. Each chat's task state is fully independent
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
  prompt: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  traceLogs: any[];
  finalAnswer: string;
  startedAt: number;
  completedAt?: number;
  lastUpdatedAt: number;
}

// Debounce timers per chat to prevent I/O spam
const globalForTaskStore = globalThis as typeof globalThis & {
  __eterxTaskCache?: Map<string, PersistedTask>;
  __eterxWriteTimers?: Map<string, NodeJS.Timeout>;
};

const writeTimers: Map<string, NodeJS.Timeout> =
  globalForTaskStore.__eterxWriteTimers ||
  (globalForTaskStore.__eterxWriteTimers = new Map());

const DEBOUNCE_MS = 500;

// In-memory cache for fast reads
const taskCache: Map<string, PersistedTask> =
  globalForTaskStore.__eterxTaskCache ||
  (globalForTaskStore.__eterxTaskCache = new Map());

async function ensureDir() {
  await fs.ensureDir(TASKS_DIR);
}

function getTaskPath(chatId: string): string {
  // Sanitize chatId for filesystem safety
  const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(TASKS_DIR, `${safe}.json`);
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
    const { output, content, ...rest } = traceEvent;
    const outputText = String(output ?? content ?? '');
    const compactedOutput = outputText.length > 2500
      ? `${outputText.substring(0, 2500)}\n...[output compacted]`
      : outputText;
    return {
      ...rest,
      output: compactedOutput,
      content: compactedOutput,
      _contentStripped: outputText.length > 2500,
    };
  }

  if (traceEvent.type === 'thought_stream' && typeof traceEvent.text === 'string' && traceEvent.text.length > 12000) {
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
    await fs.writeJson(getTaskPath(chatId), task, { spaces: 2 });
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
  async createTask(chatId: string, prompt: string): Promise<string> {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    
    const task: PersistedTask = {
      taskId,
      chatId,
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
          task.traceLogs.splice(i, 1);
          break;
        }
      }
    } else if (timedEvent?.type === 'work_note') {
      const noteText = formatVisibleWorkNote(String(timedEvent.text || ''));
      if (!noteText) return;
      const noteId = timedEvent.noteId || null;
      const subAgent = timedEvent.subAgent || null;
      let mergeIdx = -1;
      for (let i = task.traceLogs.length - 1; i >= 0; i--) {
        const log = task.traceLogs[i];
        if (log?.type !== 'work_note' || (log.subAgent || null) !== subAgent) continue;
        const sameNote = noteId && log.noteId && log.noteId === noteId;
        const sameText = String(log.text || '').trim() === noteText;
        if (sameNote || sameText) {
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
          const data = await fs.readJson(path.join(TASKS_DIR, file));
          let lastUpdated = data.completedAt || data.lastUpdatedAt || data.startedAt || 0;
          
          // Auto-recover/fail tasks that have been "running" globally for >2 hours (likely App crashed)
          if (data.status === 'running' && (Date.now() - (data.lastUpdatedAt || data.startedAt)) > 2 * 60 * 60 * 1000) {
            console.log(`[TaskStore] 🧹 Task ${data.taskId} stuck in running state for >2 hours. Marking as failed.`);
            data.status = 'failed';
            data.finalAnswer = 'Task failed due to a system crash or timeout.';
            data.completedAt = Date.now();
            data.lastUpdatedAt = Date.now();
            data.traceLogs = (data.traceLogs || []).slice(-MAX_COMPLETED_TRACE_LOGS).map(compactTraceEvent);
            await fs.writeJson(path.join(TASKS_DIR, file), data, { spaces: 2 });
            lastUpdated = data.completedAt || data.lastUpdatedAt || data.startedAt || 0;
          }

          if (data.status !== 'running' && lastUpdated < cutoff) {
            await fs.remove(path.join(TASKS_DIR, file));
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
