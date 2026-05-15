import fs from 'fs-extra';
import path from 'path';

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
const writeTimers: Map<string, NodeJS.Timeout> = new Map();
const DEBOUNCE_MS = 500;

// In-memory cache for fast reads
const taskCache: Map<string, PersistedTask> = new Map();

async function ensureDir() {
  await fs.ensureDir(TASKS_DIR);
}

function getTaskPath(chatId: string): string {
  // Sanitize chatId for filesystem safety
  const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(TASKS_DIR, `${safe}.json`);
}

/**
 * Flush a task to disk immediately (bypassing debounce).
 */
async function flushToDisk(chatId: string): Promise<void> {
  const task = taskCache.get(chatId);
  if (!task) return;
  
  try {
    await ensureDir();
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
    
    taskCache.set(chatId, task);
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
    
    task.traceLogs.push(traceEvent);
    task.lastUpdatedAt = Date.now();
    
    // Keep trace logs bounded to prevent massive files
    if (task.traceLogs.length > 500) {
      task.traceLogs = task.traceLogs.slice(-400);
    }
    
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
        taskCache.set(chatId, task);
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
          const lastUpdated = data.completedAt || data.lastUpdatedAt;
          
          // Auto-recover/fail tasks that have been "running" globally for >2 hours (likely App crashed)
          if (data.status === 'running' && (Date.now() - (data.lastUpdatedAt || data.startedAt)) > 2 * 60 * 60 * 1000) {
            console.log(`[TaskStore] 🧹 Task ${data.taskId} stuck in running state for >2 hours. Marking as failed.`);
            data.status = 'failed';
            data.finalAnswer = 'Task failed due to a system crash or timeout.';
            data.completedAt = Date.now();
            await fs.writeJson(path.join(TASKS_DIR, file), data, { spaces: 2 });
          }

          if (data.status !== 'running' && lastUpdated < cutoff) {
            await fs.remove(path.join(TASKS_DIR, file));
            const chatId = file.replace('.json', '');
            taskCache.delete(chatId);
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
  },
};
