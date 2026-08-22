import fs from 'fs-extra';
import path from 'path';
import { getEterxWorkspaceDir } from './storage-paths';
import { stableScopeSegment } from './context-scope';
import { closeThoughtStreamsForBoundary, mergeThoughtStreamTrace } from '../thought-stream-lifecycle';
import { isStreamFinalEvent, mergeStreamingText, normalizeStreamTimestamp } from '../streaming-lifecycle';
import { isPrivateReasoningTrace } from './trace-visibility';

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

const TASKS_DIR = getEterxWorkspaceDir('.tasks');
const TASK_STORE_PROCESS_STARTED_AT = Date.now();
const MAX_TASK_CACHE_ENTRIES = 80;
const MAX_RUNNING_TRACE_LOGS = 700;
const MAX_COMPLETED_TRACE_LOGS = 350;
const MAX_PERSISTED_CONSOLE_CHARS = 120_000;
const MAX_PERSISTED_CONSOLE_CHUNK_CHARS = 6_000;
const MAX_PROMPT_CHARS = 12000;
const MAX_FINAL_ANSWER_CHARS = 100000;
const WORK_NOTE_PHASE_BOUNDARY_TYPES = new Set([
  'command', 'tool_call', 'exploration', 'file_edit', 'browser',
  'communication', 'progress', 'ask_user', 'steering_received',
  'sub_agent_spawn', 'sub_agent_action', 'sub_agent_complete',
  'sub_agent_error', 'answer',
]);

const isOpenPersistedWorkNote = (log: any): boolean => {
  if (
    !log ||
    log.type !== 'work_note' ||
    log._streamingCancelled === true ||
    isStreamFinalEvent(log) ||
    ['complete', 'error', 'stopped', 'cancelled', 'canceled', 'closed'].includes(String(log.status || '').toLowerCase())
  ) return false;
  return log.isStreaming === true ||
    log.isLiveTyping === true ||
    log.isDelta === true ||
    log.streamState === 'open' ||
    ['running', 'working', 'pending', 'streaming'].includes(String(log.status || '').toLowerCase());
};

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

// Throttled timers and per-chat write chains prevent I/O spam and stale-write races.
const writeTimers: Map<string, NodeJS.Timeout> = new Map();
const DEBOUNCE_MS = 500;
const writeChains: Map<string, Promise<void>> = new Map();
const pendingWriteSnapshots: Map<string, string> = new Map();

// In-memory cache for fast reads
const taskCache: Map<string, PersistedTask> = new Map();
let orphanRecoveryPromise: Promise<void> | null = null;

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
  const safe = stableScopeSegment(chatId, 120);
  return resolveUnder(TASKS_DIR, `${safe}.json`);
}

function getLegacyTaskPath(chatId: string): string {
  const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || '_global';
  return resolveUnder(TASKS_DIR, `${safe}.json`);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.writeJson(tmpPath, value, { spaces: 2 });
  if (await fs.pathExists(filePath)) await fs.copyFile(filePath, `${filePath}.backup`).catch(() => {});
  await fs.move(tmpPath, filePath, { overwrite: true });
}

async function writeSerializedJsonAtomic(filePath: string, serialized: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.writeFile(tmpPath, serialized, 'utf8');
  if (await fs.pathExists(filePath)) await fs.copyFile(filePath, `${filePath}.backup`).catch(() => {});
  await fs.move(tmpPath, filePath, { overwrite: true });
}

async function readTaskWithBackup(filePath: string): Promise<PersistedTask> {
  for (const source of [filePath, `${filePath}.backup`]) {
    try {
      return await fs.readJson(source) as PersistedTask;
    } catch {
      if (source === filePath && await fs.pathExists(filePath)) {
        await fs.move(filePath, `${filePath}.corrupt-${Date.now()}`).catch(() => {});
      }
    }
  }
  throw new Error(`Unable to read persisted task: ${filePath}`);
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
    const { output, content, outputPreview, ...rest } = traceEvent;
    const outputText = String(output ?? content ?? outputPreview ?? '');
    const isDelta = traceEvent.isDelta === true;
    const compactOutput = outputText.length <= MAX_PERSISTED_CONSOLE_CHUNK_CHARS
      ? outputText
      : isDelta
        ? outputText.slice(-MAX_PERSISTED_CONSOLE_CHUNK_CHARS)
        : `${outputText.slice(0, 1_500)}\n...[terminal output compacted]...\n${outputText.slice(-(MAX_PERSISTED_CONSOLE_CHUNK_CHARS - 1_500))}`;
    const outputEnd = Number(traceEvent.outputEnd);
    return {
      ...rest,
      output: compactOutput,
      ...(isDelta && outputText.length > MAX_PERSISTED_CONSOLE_CHUNK_CHARS && Number.isFinite(outputEnd)
        ? { outputStart: Math.max(0, outputEnd - compactOutput.length) }
        : {}),
      _contentStripped: traceEvent._contentStripped === true || outputText.length > compactOutput.length,
    };
  }

  // Keep cumulative thought snapshots intact. Compacting a thought update
  // inserts non-model text into the stream and causes later updates to lose
  // everything after the compaction boundary.
  if (traceEvent.type === 'work_note' && typeof traceEvent.text === 'string' && traceEvent.text.length > 12000) {
    return {
      ...traceEvent,
      text: `${traceEvent.text.substring(0, 12000)}\n...[trace compacted]`,
      _contentStripped: true,
    };
  }

  return traceEvent;
}

function getConsoleTraceOutput(trace: any): string {
  const candidates = [trace?.output, trace?.content, trace?.outputPreview];
  const value = candidates.find(candidate => candidate !== undefined && candidate !== null && String(candidate).length > 0)
    ?? candidates.find(candidate => candidate !== undefined && candidate !== null);
  return String(value ?? '');
}

/**
 * Persist one bounded, offset-aware snapshot per terminal stream. Live traces
 * arrive as deltas; consolidating them here keeps disk polling linear while
 * retaining enough offset information for reconnects to append idempotently.
 */
function mergePersistedConsoleTrace(previous: any, incoming: any): any {
  const previousText = getConsoleTraceOutput(previous);
  const incomingText = getConsoleTraceOutput(incoming);
  const previousStart = Number(previous?.outputStart);
  const previousEnd = Number(previous?.outputEnd);
  const incomingStart = Number(incoming?.outputStart);
  const incomingEnd = Number(incoming?.outputEnd);
  let mergedOutput = incomingText;
  let mergedStart = Number.isFinite(incomingStart) ? incomingStart : undefined;
  const mergedEnd = Number.isFinite(incomingEnd)
    ? incomingEnd
    : Number.isFinite(previousEnd)
      ? previousEnd
      : undefined;

  if (incoming?.isDelta === true) {
    if (Number.isFinite(previousEnd) && Number.isFinite(incomingStart) && Number.isFinite(incomingEnd)) {
      if (incomingEnd <= previousEnd) return previous;
      if (incomingStart <= previousEnd) {
        const overlap = Math.max(0, previousEnd - incomingStart);
        mergedOutput = `${previousText}${incomingText.slice(overlap)}`;
        mergedStart = Number.isFinite(previousStart)
          ? previousStart
          : Math.max(0, previousEnd - previousText.length);
      }
      // A real gap means the earlier snapshot is no longer contiguous. Keep
      // the new range; the client uses outputStart to render a reconnect note.
    } else {
      mergedOutput = mergeStreamingText(previousText, incomingText, true);
      mergedStart = Number.isFinite(previousStart) ? previousStart : mergedStart;
    }
  } else {
    const sameLogicalEnd = Number.isFinite(previousEnd) && Number.isFinite(incomingEnd) && previousEnd === incomingEnd;
    const incomingWasCompacted = incoming?._contentStripped === true;
    if (sameLogicalEnd && incomingWasCompacted && previousText.length > incomingText.length) {
      mergedOutput = previousText;
      mergedStart = Number.isFinite(previousStart) ? previousStart : mergedStart;
    } else {
      mergedOutput = mergeStreamingText(previousText, incomingText, false);
    }
  }

  if (mergedOutput.length > MAX_PERSISTED_CONSOLE_CHARS) {
    const removedChars = mergedOutput.length - MAX_PERSISTED_CONSOLE_CHARS;
    mergedOutput = mergedOutput.slice(removedChars);
    mergedStart = typeof mergedStart === 'number' && Number.isFinite(mergedStart)
      ? mergedStart + removedChars
      : typeof mergedEnd === 'number' && Number.isFinite(mergedEnd)
        ? Math.max(0, mergedEnd - mergedOutput.length)
        : undefined;
  }

  return {
    ...previous,
    ...incoming,
    output: mergedOutput,
    content: undefined,
    outputPreview: undefined,
    ...(mergedStart !== undefined ? { outputStart: mergedStart } : {}),
    ...(mergedEnd !== undefined ? { outputEnd: mergedEnd } : {}),
    startTime: previous.startTime || previous.timestamp || incoming.startTime || incoming.timestamp,
  };
}

function trimTask(task: PersistedTask, compactAll = false): void {
  task.prompt = String(task.prompt || '').substring(0, MAX_PROMPT_CHARS);
  task.finalAnswer = String(task.finalAnswer || '').substring(0, MAX_FINAL_ANSWER_CHARS);
  const limit = task.status === 'running' ? MAX_RUNNING_TRACE_LOGS : MAX_COMPLETED_TRACE_LOGS;
  if (!Array.isArray(task.traceLogs)) task.traceLogs = [];
  if (task.traceLogs.length > limit) task.traceLogs = task.traceLogs.slice(-limit);
  if (compactAll) task.traceLogs = task.traceLogs.map(compactTraceEvent);
}

function settleOrphanedLiveTraces(traceLogs: any[], completedAt: number, interrupted = true): any[] {
  return (Array.isArray(traceLogs) ? traceLogs : []).map((trace: any) => {
    const isLive =
      trace?.isStreaming === true ||
      trace?.isLiveTyping === true ||
      trace?.isDelta === true ||
      trace?.streamState === 'open';
    const canRemainLive = ['console_output', 'work_note', 'thought_stream', 'answer'].includes(String(trace?.type || ''));
    if (!isLive || !canRemainLive) return trace;
    const startedAt = Number(trace.startTime || trace.timestamp || completedAt);
    const settled = {
      ...trace,
      isStreaming: false,
      isLiveTyping: false,
      isDelta: false,
      streamState: 'closed',
      endTime: completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      interrupted,
    };
    return trace.type === 'console_output'
      ? { ...settled, exitCode: typeof trace.exitCode === 'number' ? trace.exitCode : interrupted ? 1 : 0 }
      : settled;
  });
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

  trimTask(task);
  // Serialize once at scheduling time. The old clone-then-writeJson path
  // stringified every long trace history twice per flush.
  const snapshot = JSON.stringify(task);
  // Keep only the newest queued snapshot when disk or antivirus latency is
  // slower than the live trace cadence. One writer per chat drains this slot.
  pendingWriteSnapshots.set(chatId, snapshot);
  let nextWrite = writeChains.get(chatId);
  if (!nextWrite) {
    nextWrite = (async () => {
      while (pendingWriteSnapshots.has(chatId)) {
        const latest = pendingWriteSnapshots.get(chatId)!;
        pendingWriteSnapshots.delete(chatId);
        await ensureDir();
        await writeSerializedJsonAtomic(getTaskPath(chatId), latest);
      }
    })();
    writeChains.set(chatId, nextWrite);
  }

  try {
    await nextWrite;
  } catch (err: any) {
    console.warn(`[TaskStore] ⚠️ Failed to persist task for ${chatId}: ${err.message}`);
  } finally {
    if (writeChains.get(chatId) === nextWrite) writeChains.delete(chatId);
    if (pendingWriteSnapshots.has(chatId) && taskCache.has(chatId)) void flushToDisk(chatId);
  }
}

/**
 * Schedule a throttled write to disk. Continuous trace streams are snapshotted
 * at least once per interval instead of postponing persistence indefinitely.
 */
function scheduleDiskWrite(chatId: string): void {
  if (writeTimers.has(chatId)) return;

  writeTimers.set(chatId, setTimeout(() => {
    writeTimers.delete(chatId);
    flushToDisk(chatId).catch(() => {});
  }, DEBOUNCE_MS));
  writeTimers.get(chatId)?.unref?.();
}

export const taskStore = {
  /**
   * A desktop close kills the Node process. No in-memory execution can exist
   * after restart, so persisted running tasks must never be presented as live.
   */
  async recoverOrphanedRunningTasks(): Promise<void> {
    if (orphanRecoveryPromise) return orphanRecoveryPromise;
    orphanRecoveryPromise = (async () => {
      try {
        if (!(await fs.pathExists(TASKS_DIR))) return;
        const files = await fs.readdir(TASKS_DIR);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          const taskPath = resolveUnder(TASKS_DIR, file);
          try {
            const task = await readTaskWithBackup(taskPath);
            if (task.status !== 'running') continue;
            // Recovery can overlap the first live starts after a cold launch.
            // Only tasks that existed before this module initialized are
            // orphans; a newer timestamp belongs to this live process.
            if ((task.startedAt || 0) >= TASK_STORE_PROCESS_STARTED_AT) continue;
            task.status = 'failed';
            task.finalAnswer = 'Agent interrupted because EterX was closed or restarted. Previous activity is preserved above.';
            task.completedAt = Date.now();
            task.lastUpdatedAt = task.completedAt;
            task.traceLogs = settleOrphanedLiveTraces(task.traceLogs, task.completedAt);
            trimTask(task, true);
            await writeJsonAtomic(taskPath, task);
          } catch (error: any) {
            console.warn(`[TaskStore] Could not recover orphaned task ${file}: ${error?.message || error}`);
          }
        }
      } catch (error: any) {
        console.warn(`[TaskStore] Could not scan for orphaned tasks: ${error?.message || error}`);
      }
    })();
    return orphanRecoveryPromise;
  },
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
  addTrace(chatId: string, traceEvent: any, expectedRunId?: string): void {
    const task = taskCache.get(chatId);
    if (!task) return;
    if (expectedRunId && task.runId !== expectedRunId) return;

    const now = Date.now();
    const compactEvent = compactTraceEvent(traceEvent);
    const timedEvent = compactEvent && typeof compactEvent === 'object'
      ? {
        ...compactEvent,
        timestamp: normalizeStreamTimestamp(compactEvent.timestamp, now),
        ...(compactEvent.startTime !== undefined
          ? { startTime: normalizeStreamTimestamp(compactEvent.startTime, normalizeStreamTimestamp(compactEvent.timestamp, now)) }
          : {}),
        ...(compactEvent.endTime !== undefined
          ? { endTime: normalizeStreamTimestamp(compactEvent.endTime, normalizeStreamTimestamp(compactEvent.timestamp, now)) }
          : {}),
      }
      : compactEvent;

    // Reasoning may be useful inside the active runtime, but it is not durable
    // conversation content and must never be written into a user's chat task.
    if (isPrivateReasoningTrace(timedEvent)) return;

    if (timedEvent?.type !== 'thought_stream') {
      closeThoughtStreamsForBoundary(task.traceLogs, timedEvent);
    }

    if (timedEvent?.type === 'user_action') {
      const eventId = String(timedEvent.id || '').trim();
      const eventRunId = String(timedEvent.runId || timedEvent.turnId || task.runId || '').trim();
      const traceIndex = timedEvent._traceIdx;
      const existingUserIndex = task.traceLogs.findIndex((log: any) => {
        if (log?.type !== 'user_action') return false;
        const logRunId = String(log.runId || log.turnId || '').trim();
        if (eventRunId && logRunId && eventRunId !== logRunId) return false;
        const sameId = eventId && String(log.id || '').trim() === eventId;
        const sameTraceIndex = traceIndex !== undefined && traceIndex !== null && log._traceIdx === traceIndex;
        return Boolean(sameId || sameTraceIndex);
      });
      if (existingUserIndex >= 0) {
        task.traceLogs[existingUserIndex] = {
          ...task.traceLogs[existingUserIndex],
          ...timedEvent,
          startTime: task.traceLogs[existingUserIndex].startTime || timedEvent.startTime || timedEvent.timestamp,
        };
      } else {
        task.traceLogs.push(timedEvent);
      }
    } else if (timedEvent?.type === 'thought_stream') {
      mergeThoughtStreamTrace(task.traceLogs, timedEvent);
    } else if (timedEvent?.type === 'answer_cancel') {
      const answerId = String(timedEvent.answerId || '').trim();
      for (let i = task.traceLogs.length - 1; i >= 0; i--) {
        const log = task.traceLogs[i];
        if (log?.type === 'user_action') break;
        if (
          log?.type === 'answer' &&
          (
            (answerId && String(log.answerId || '') === answerId) ||
            (!answerId && (log.isStreaming || log.isLiveTyping || log.streamState === 'open'))
          )
        ) {
          task.traceLogs.splice(i, 1);
        }
      }
    } else if (timedEvent?.type === 'answer') {
      const answerId = String(timedEvent.answerId || '').trim();
      const incomingIsStreaming =
        timedEvent.isStreaming === true ||
        timedEvent.isLiveTyping === true ||
        timedEvent.isDelta === true ||
        timedEvent.streamState === 'open';
      let mergeIdx = -1;
      for (let i = task.traceLogs.length - 1; i >= 0; i--) {
        const log = task.traceLogs[i];
        if (log?.type === 'user_action') break;
        if (log?.type !== 'answer') continue;
        const sameText = String(log.text || '').trim() === String(timedEvent.text || '').trim();
        if (
          (answerId && String(log.answerId || '') === answerId) ||
          (!incomingIsStreaming && (log.isStreaming || log.isLiveTyping || sameText))
        ) {
          mergeIdx = i;
          break;
        }
      }
      if (mergeIdx >= 0) {
        const previous = task.traceLogs[mergeIdx];
        task.traceLogs[mergeIdx] = {
          ...previous,
          ...timedEvent,
          text: mergeStreamingText(previous.text, timedEvent.text, timedEvent.isDelta === true),
          startTime: previous.startTime || timedEvent.startTime || timedEvent.timestamp,
          endTime: Math.max(
            Number(previous.endTime || previous.timestamp || 0),
            Number(timedEvent.endTime || timedEvent.timestamp || 0),
          ),
          timestamp: Math.max(
            Number(previous.timestamp || 0),
            Number(timedEvent.timestamp || 0),
          ),
          isStreaming: incomingIsStreaming,
          isLiveTyping: incomingIsStreaming,
          wasStreaming: Boolean(
            previous.wasStreaming ||
            previous.isStreaming ||
            previous.isLiveTyping ||
            timedEvent.wasStreaming ||
            incomingIsStreaming
          ),
        };
      } else {
        task.traceLogs.push({
          ...timedEvent,
          isStreaming: incomingIsStreaming,
          isLiveTyping: incomingIsStreaming,
        });
      }
    } else if (timedEvent?.type === 'work_note_cancel') {
      const noteId = timedEvent.noteId || null;
      const subAgent = timedEvent.subAgent || null;
      const subAgentIdentity = timedEvent.subAgentChatId || timedEvent.subAgentId || subAgent;
      for (let i = task.traceLogs.length - 1; i >= 0; i--) {
        const log = task.traceLogs[i];
        if (log?.type === 'user_action') break;
        if (
          log?.type === 'work_note' &&
          (log.subAgentChatId || log.subAgentId || log.subAgent || null) === subAgentIdentity &&
          (!noteId || log.noteId === noteId)
        ) {
          const existingTraceIdx = Number(log._traceIdx);
          const cancellationTraceIdx = Number(timedEvent._traceIdx);
          if (
            Number.isFinite(existingTraceIdx) &&
            Number.isFinite(cancellationTraceIdx) &&
            cancellationTraceIdx < existingTraceIdx
          ) break;
          // Cancellation events address a live placeholder, not a durable
          // note that has already replaced it.
          if (!isOpenPersistedWorkNote(log)) {
            if (noteId && log.noteId === noteId) break;
            continue;
          }
          task.traceLogs[i] = {
            ...log,
            _streamingCancelled: true,
            _cancelTraceIdx: timedEvent._traceIdx,
            _cancelledAt: timedEvent.timestamp,
          };
          break;
        }
      }
    } else if (timedEvent?.type === 'work_note') {
      const noteText = String(timedEvent.text || '');
      if (!noteText.trim()) return;
      const noteId = timedEvent.noteId || null;
      const subAgent = timedEvent.subAgent || null;
      const subAgentIdentity = timedEvent.subAgentChatId || timedEvent.subAgentId || subAgent;
      // Provider adapters commonly emit a complete one-shot work note without
      // any stream flags. Treat only an explicitly open note as provisional.
      const incomingIsFinal = !isOpenPersistedWorkNote(timedEvent);
      let mergeIdx = -1;
      let ignoreCancelledUpdate = false;
      let crossedPhaseBoundary = false;
      for (let i = task.traceLogs.length - 1; i >= 0; i--) {
        const log = task.traceLogs[i];
        if (log?.type === 'user_action') break;
        if (WORK_NOTE_PHASE_BOUNDARY_TYPES.has(String(log?.type || ''))) {
          crossedPhaseBoundary = true;
          continue;
        }
        if (
          log?.type !== 'work_note' ||
          (log.subAgentChatId || log.subAgentId || log.subAgent || null) !== subAgentIdentity
        ) continue;
        const sameNote = noteId && log.noteId && log.noteId === noteId;
        const sameText = String(log.text || '').trim() === noteText.trim();
        if (sameNote && log._streamingCancelled && !incomingIsFinal) {
          ignoreCancelledUpdate = true;
          break;
        }
        // A cancellation may be immediately followed by the permanent form of
        // the same streamed note. Do not reuse an older cancelled row after an
        // action or a later phase has already started.
        const cancellationTraceIdx = Number(log._cancelTraceIdx);
        const incomingTraceIdx = Number(timedEvent._traceIdx);
        const cancelledAt = Number(log._cancelledAt || log.endTime || log.timestamp || 0);
        const incomingAt = Number(timedEvent.startTime || timedEvent.timestamp || 0);
        const orderedCancellation =
          !Number.isFinite(cancellationTraceIdx) ||
          !Number.isFinite(incomingTraceIdx) ||
          incomingTraceIdx >= cancellationTraceIdx;
        const closeInTime = !cancelledAt || !incomingAt || Math.abs(incomingAt - cancelledAt) <= 15_000;
        const isCancelledPlaceholder = Boolean(
          log._streamingCancelled &&
          incomingIsFinal &&
          !crossedPhaseBoundary &&
          i === task.traceLogs.length - 1 &&
          orderedCancellation &&
          closeInTime
        );
        const canMergeIdlessStream = Boolean(
          !crossedPhaseBoundary &&
          (!noteId || !log.noteId) &&
          isOpenPersistedWorkNote(log)
        );
        const canFinalizeAdjacentText = Boolean(
          !crossedPhaseBoundary &&
          sameText &&
          incomingIsFinal &&
          isOpenPersistedWorkNote(log)
        );
        if (sameNote || canFinalizeAdjacentText || canMergeIdlessStream || isCancelledPlaceholder) {
          mergeIdx = i;
          break;
        }
        if (sameText) break;
      }
      if (ignoreCancelledUpdate) return;
      if (mergeIdx >= 0) {
        const previous = task.traceLogs[mergeIdx];
        task.traceLogs[mergeIdx] = {
          ...previous,
          ...timedEvent,
          text: incomingIsFinal && timedEvent.isDelta !== true
            ? noteText
            : mergeStreamingText(previous.text, noteText, timedEvent.isDelta === true),
          noteId: noteId || previous.noteId || null,
          subAgent: subAgent ?? previous.subAgent ?? null,
          _traceIdx: previous._traceIdx ?? timedEvent._traceIdx,
          startTime: previous.startTime || timedEvent.startTime || timedEvent.timestamp,
          endTime: Math.max(
            Number(previous.endTime || previous.timestamp || 0),
            Number(timedEvent.endTime || timedEvent.timestamp || 0),
          ),
          timestamp: Math.max(
            Number(previous.timestamp || 0),
            Number(timedEvent.timestamp || 0),
          ),
          _streamingCancelled: undefined,
          _cancelTraceIdx: undefined,
          _cancelledAt: undefined,
        };
      } else {
        task.traceLogs.push({ ...timedEvent, text: noteText, noteId, subAgent });
      }
    } else if (timedEvent?.type === 'console_output') {
      const streamId = String(timedEvent.streamId || '').trim();
      const ownerTraceId = String(timedEvent.ownerTraceId || '').trim();
      const terminalTaskId = String(timedEvent.taskId || timedEvent.backgroundTaskId || '').trim();
      let mergeIdx = -1;

      for (let i = task.traceLogs.length - 1; i >= 0; i--) {
        const log = task.traceLogs[i];
        if (log?.type === 'user_action') break;
        if (log?.type !== 'console_output') continue;
        const sameStream = streamId && String(log.streamId || '') === streamId;
        const sameOwner = ownerTraceId
          && String(log.ownerTraceId || '') === ownerTraceId
          && String(log.command || '') === String(timedEvent.command || '');
        const sameTask = terminalTaskId && String(log.taskId || log.backgroundTaskId || '') === terminalTaskId;
        if (sameStream || sameOwner || sameTask) {
          mergeIdx = i;
          break;
        }
      }

      if (mergeIdx >= 0) {
        const previous = task.traceLogs[mergeIdx];
        task.traceLogs[mergeIdx] = mergePersistedConsoleTrace(previous, timedEvent);
      } else {
        task.traceLogs.push(timedEvent);
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
  async completeTask(chatId: string, finalAnswer: string, success: boolean, statusOverride?: 'completed' | 'failed' | 'stopped', expectedRunId?: string): Promise<void> {
    const task = taskCache.get(chatId);
    if (!task) return;
    if (expectedRunId && task.runId !== expectedRunId) return;
    
    task.status = statusOverride || (success ? 'completed' : 'failed');
    task.finalAnswer = finalAnswer;
    task.completedAt = Date.now();
    task.lastUpdatedAt = task.completedAt;
    task.traceLogs = settleOrphanedLiveTraces(task.traceLogs, task.completedAt, task.status !== 'completed');
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
  async stopTask(chatId: string, finalAnswer = 'Stopped by user.', expectedRunId?: string): Promise<void> {
    const task = taskCache.get(chatId);
    if (!task || task.status !== 'running') return;
    if (expectedRunId && task.runId !== expectedRunId) return;
    
    task.status = 'stopped';
    task.finalAnswer = finalAnswer;
    task.completedAt = Date.now();
    task.lastUpdatedAt = task.completedAt;
    task.traceLogs = settleOrphanedLiveTraces(task.traceLogs, task.completedAt);
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
      const legacyTaskPath = getLegacyTaskPath(chatId);
      const readableTaskPath = await fs.pathExists(taskPath)
        ? taskPath
        : (legacyTaskPath !== taskPath && await fs.pathExists(legacyTaskPath) ? legacyTaskPath : null);
      if (readableTaskPath) {
        const task = await readTaskWithBackup(readableTaskPath);
        if (String(task.chatId || '') !== chatId) return null;
        trimTask(task, true);
        rememberTask(chatId, task);
        // Migrate a verified legacy record to its collision-proof namespace.
        if (readableTaskPath !== taskPath) await flushToDisk(chatId);
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
    await this.recoverOrphanedRunningTasks();
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
      if (isPrivateReasoningTrace(traceObj)) continue;
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
      pendingWrites: writeTimers.size + writeChains.size + pendingWriteSnapshots.size,
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
            data.lastUpdatedAt = data.completedAt;
            data.traceLogs = settleOrphanedLiveTraces(data.traceLogs, data.completedAt)
              .slice(-MAX_COMPLETED_TRACE_LOGS)
              .map(compactTraceEvent);
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
            pendingWriteSnapshots.delete(chatId);
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
    pendingWriteSnapshots.delete(chatId);
  },
};
