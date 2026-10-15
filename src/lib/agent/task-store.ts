import fs from 'fs-extra';
import path from 'path';
import { getEterxWorkspaceDir } from './storage-paths';
import { stableScopeSegment } from './context-scope';
import { closeThoughtStreamsForBoundary, mergeThoughtStreamTrace } from '../thought-stream-lifecycle';
import {
  isStreamFinalEvent,
  mergeStreamingText,
  mergeVisibleNarrativeText,
  normalizeStreamTimestamp,
} from '../streaming-lifecycle';
import { isUserVisibleTrace } from './trace-visibility';
import {
  areLikelySameFeedActionLifecycle,
  getFeedActionLifecycleCandidateKeys,
  getFeedActionSingletonIdentity,
  haveConflictingFeedActionInvocations,
  isFeedTraceExplicitlySettled,
  isFeedTraceOpen,
  isFeedTurnBoundary,
} from '../chat-feed-lifecycle';
import { formatUnknownError } from './error-format';
import { sameUserAdmission } from '../steering-delivery';
import { contextUsageScopeKey, mergeContextCompactionSnapshot, mergeContextUsageSnapshot, upsertContextUsageSnapshot } from '../context-usage-snapshot';
import { reconcileModelUsageLogs, upsertModelUsageReceipt } from '../model-usage';

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
 *   process dies with the task; records predating this process are recovered
 *   as interrupted, without counting time while the application was closed.
 *
 * Storage: .workspaces/.tasks/{chatId}.json
 */

const TASKS_DIR = getEterxWorkspaceDir('.tasks');
// Module reloads are not process restarts. Using module evaluation time could
// mark a still-running task as orphaned after a development hot reload.
const TASK_STORE_PROCESS_STARTED_AT = Date.now() - process.uptime() * 1_000;
const MAX_TASK_CACHE_ENTRIES = 80;
// Match the live registry budget so settling or reloading a run never causes
// the visible timeline to collapse from hundreds of events to a short tail.
const MAX_RUNNING_TRACE_LOGS = 2000;
const MAX_COMPLETED_TRACE_LOGS = MAX_RUNNING_TRACE_LOGS;
const MAX_PERSISTED_CONSOLE_CHARS = 120_000;
const MAX_PERSISTED_CONSOLE_CHUNK_CHARS = 6_000;
const MAX_FINAL_ANSWER_CHARS = 100000;
const WORK_NOTE_PHASE_BOUNDARY_TYPES = new Set([
  'command', 'tool_call', 'exploration', 'file_edit', 'browser',
  'communication', 'progress', 'ask_user', 'steering_received',
  'sub_agent_spawn', 'sub_agent_action', 'sub_agent_complete',
  'sub_agent_error', 'answer',
]);
const PERSISTED_ACTION_TRACE_TYPES = new Set([
  'command', 'tool_call', 'exploration', 'file_edit', 'browser',
  'communication', 'sub_agent_action',
]);

const normalizedPersistedActionType = (value: unknown): string => {
  const type = String(value || '').trim().toLowerCase();
  return type === 'tool_call' ? 'command' : type;
};

const persistedActionIdentities = (log: any): Set<string> => {
  const strongIdentities = [
    // Registry snapshot replacement assigns a fresh delivery cursor but keeps
    // the first cursor as the immutable action lifecycle origin. Persisted
    // and live copies must therefore correlate on the origin, not only on the
    // newest transport index or provider IDs (which can be regenerated).
    // `_traceIdx` is a delivery cursor and can be reassigned by polling or
    // restore. Only the explicitly preserved origin is a lifecycle identity.
    ['origin', log?._originTraceIdx],
    ['singleton', getFeedActionSingletonIdentity(log)],
    ['tool', log?.toolCallId],
    ['trace', log?.traceId],
    ['response', log?.responseKey],
    ['event', log?.id],
  ]
    .map(([kind, value]) => {
      const normalized = String(value ?? '').trim();
      return normalized ? `${kind}:${normalized}` : '';
    })
    .filter(Boolean);
  if (strongIdentities.length > 0) return new Set(strongIdentities);

  // A provider/background stream can contain several actions. It becomes a
  // safe legacy lifecycle key only when scoped by this action's immutable
  // command/tool/file content and its original start marker.
  const streamId = String(log?.streamId || '').trim();
  const normalize = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const tool = normalize(log?.tool || log?.toolName || log?.name);
  const operation = [
    log?.command,
    log?.filepath || log?.filename,
    log?.query || log?.searchQuery,
  ].map(normalize).filter(Boolean);
  const content = (operation.length > 0
    ? [tool, ...operation]
    : [tool, normalize(log?.secondary)])
    .filter(Boolean)
    .join('|')
    .slice(0, 640);
  const start = String(log?.streamStartedAt ?? log?.startTime ?? '').trim();
  return streamId && content
    ? new Set([`stream:${streamId}:${start}:${content}`])
    : new Set();
};

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
    ['running', 'working', 'pending', 'streaming', 'spawning', 'started'].includes(String(log.status || '').toLowerCase());
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

function trimTraceLedgerWithBoundary(traceLogs: any[], limit: number): any[] {
  const source = Array.isArray(traceLogs) ? traceLogs : [];
  if (source.length <= limit) return source;

  const firstUserBoundaryIndex = source.findIndex(trace => trace?.type === 'user_action');
  const retainedIndexes = new Set<number>();
  if (firstUserBoundaryIndex >= 0) retainedIndexes.add(firstUserBoundaryIndex);

  let remaining = Math.max(0, limit - retainedIndexes.size);
  let segmentEnd = source.length - 1;

  // Compact by query segment instead of taking an unstructured tail. Every
  // retained action/note/answer must retain the user or steering boundary that
  // owns it; otherwise rows from intermediate queries visually fall under the
  // next surviving query after a reconnect.
  while (segmentEnd >= 0 && remaining > 0) {
    let boundaryIndex = -1;
    for (let index = segmentEnd; index >= 0; index -= 1) {
      if (isFeedTurnBoundary(source[index])) {
        boundaryIndex = index;
        break;
      }
    }

    const contentStart = boundaryIndex >= 0 ? boundaryIndex + 1 : 0;
    if (boundaryIndex >= 0 && !retainedIndexes.has(boundaryIndex)) {
      retainedIndexes.add(boundaryIndex);
      remaining -= 1;
      if (remaining <= 0) break;
    }

    const availableContent = Math.max(0, segmentEnd - contentStart + 1);
    const contentToKeep = Math.min(remaining, availableContent);
    const retainedContentStart = segmentEnd - contentToKeep + 1;
    for (let index = retainedContentStart; index <= segmentEnd; index += 1) {
      retainedIndexes.add(index);
    }
    remaining -= contentToKeep;
    segmentEnd = boundaryIndex >= 0 ? boundaryIndex - 1 : -1;
  }

  return [...retainedIndexes]
    .sort((left, right) => left - right)
    .map(index => source[index]);
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
    id: previous.id || incoming.id,
    _feedPresentationId: previous._feedPresentationId || incoming._feedPresentationId,
    _feedBoundaryId: previous._feedBoundaryId || incoming._feedBoundaryId,
    _feedBoundaryOrder: previous._feedBoundaryOrder ?? incoming._feedBoundaryOrder,
    _feedEventOrder: previous._feedEventOrder ?? incoming._feedEventOrder,
    _originTraceIdx: previous._originTraceIdx ?? previous._traceIdx ?? incoming._originTraceIdx ?? incoming._traceIdx,
    _traceIdx: previous._traceIdx ?? incoming._traceIdx,
    _pollIdx: incoming._traceIdx ?? incoming._pollIdx ?? previous._pollIdx ?? previous._traceIdx,
    output: mergedOutput,
    content: undefined,
    outputPreview: undefined,
    ...(mergedStart !== undefined ? { outputStart: mergedStart } : {}),
    ...(mergedEnd !== undefined ? { outputEnd: mergedEnd } : {}),
    startTime: previous.startTime || previous.timestamp || incoming.startTime || incoming.timestamp,
  };
}

const persistedActionReplaySignature = (log: any): string => {
  const scope = String(log?.turnId || log?.runId || '').trim();
  const startedAt = Number(log?.startTime || log?.timestamp || 0);
  const endedAt = Number(log?.endTime || 0);
  const duration = Number(log?.durationMs || 0);
  if (!scope || !(startedAt > 0 || endedAt > 0 || duration > 0)) return '';
  const content = [
    log?.command,
    log?.tool,
    log?.name,
    log?.filepath || log?.filename,
    log?.query || log?.searchQuery,
    log?.secondary,
    log?.text,
  ].map(value => String(value ?? '').replace(/\s+/g, ' ').trim()).join('|');
  return [
    scope,
    normalizedPersistedActionType(log?.type),
    String(log?._originTraceIdx ?? log?.toolCallId ?? log?.traceId ?? log?.responseKey ?? ''),
    content,
    startedAt,
    endedAt,
    duration,
    String(log?.status || ''),
    String(log?.exitCode ?? ''),
  ].join('::');
};

function canonicalizePersistedActionLogs(traceLogs: any[]): any[] {
  const canonical: any[] = [];
  const actionIndexes = new Map<string, number>();
  const likelyActionIndexes = new Map<string, Set<number>>();
  const taskPlanIndexes = new Map<string, number>();
  const contextUsageIndexes = new Map<string, number>();
  const registerLikelyAction = (log: any, index: number) => {
    getFeedActionLifecycleCandidateKeys(log).forEach(key => {
      const indexes = likelyActionIndexes.get(key) || new Set<number>();
      indexes.add(index);
      likelyActionIndexes.set(key, indexes);
    });
  };
  const findLikelyActionIndex = (log: any): number | undefined => {
    const candidates = new Set<number>();
    getFeedActionLifecycleCandidateKeys(log).forEach(key => {
      likelyActionIndexes.get(key)?.forEach(index => candidates.add(index));
    });
    for (const index of candidates) {
      if (areLikelySameFeedActionLifecycle(canonical[index], log)) return index;
    }
    return undefined;
  };

  for (const log of reconcileModelUsageLogs(Array.isArray(traceLogs) ? traceLogs : [])) {
    if (String(log?.type || '') === 'context_usage') {
      const usageKey = contextUsageScopeKey(log);
      const existingUsageIndex = usageKey ? contextUsageIndexes.get(usageKey) : undefined;
      const previous = existingUsageIndex === undefined ? null : canonical[existingUsageIndex];
      const merged = mergeContextUsageSnapshot(previous, log);
      if (merged === previous) continue;
      if (existingUsageIndex !== undefined) canonical[existingUsageIndex] = null;
      const nextIndex = canonical.length;
      canonical.push(merged);
      if (usageKey) contextUsageIndexes.set(usageKey, nextIndex);
      continue;
    }
    if (String(log?.type || '') === 'task_plan') {
      const scope = String(log?.turnId || log?.runId || '').trim();
      const planKey = scope ? `task-plan:${ scope }` : '';
      const existingPlanIndex = planKey ? taskPlanIndexes.get(planKey) : undefined;
      if (existingPlanIndex !== undefined) {
        const previous = canonical[existingPlanIndex];
        canonical[existingPlanIndex] = {
          ...previous,
          ...log,
          id: previous?.id || log?.id,
          planId: previous?.planId || log?.planId,
          ownerTraceId: previous?.ownerTraceId || log?.ownerTraceId,
          _feedPresentationId: previous?._feedPresentationId || log?._feedPresentationId,
          _feedBoundaryId: previous?._feedBoundaryId || log?._feedBoundaryId,
          _feedBoundaryOrder: previous?._feedBoundaryOrder ?? log?._feedBoundaryOrder,
          _feedEventOrder: previous?._feedEventOrder ?? log?._feedEventOrder,
          _traceIdx: previous?._traceIdx ?? log?._traceIdx,
          startTime: previous?.startTime || previous?.timestamp || log?.startTime || log?.timestamp,
          timestamp: Math.max(Number(previous?.timestamp || 0), Number(log?.timestamp || 0)),
        };
        continue;
      }
      if (planKey) taskPlanIndexes.set(planKey, canonical.length);
      canonical.push(log);
      continue;
    }
    if (!PERSISTED_ACTION_TRACE_TYPES.has(String(log?.type || ''))) {
      canonical.push(log);
      continue;
    }
    const scope = String(log?.turnId || log?.runId || 'unscoped').trim();
    const type = normalizedPersistedActionType(log?.type);
    const strongKeys = [...persistedActionIdentities(log)].map(identity => `${ scope }:${ type }:${ identity }`);
    const replaySignature = persistedActionReplaySignature(log);
    const likelyReplayIndex = findLikelyActionIndex(log);
    const correlatedIndex = strongKeys
      .map(key => actionIndexes.get(key))
      .find(index => index !== undefined) ?? (
        replaySignature ? actionIndexes.get(`replay:${ replaySignature }`) : undefined
      ) ?? likelyReplayIndex;
    const existingIndex = correlatedIndex !== undefined &&
      haveConflictingFeedActionInvocations(canonical[correlatedIndex], log)
      ? undefined
      : correlatedIndex;
    if (existingIndex === undefined) {
      const index = canonical.length;
      strongKeys.forEach(key => actionIndexes.set(key, index));
      if (replaySignature) actionIndexes.set(`replay:${ replaySignature }`, index);
      canonical.push(log);
      registerLikelyAction(log, index);
      continue;
    }

    const previous = canonical[existingIndex];
    const previousSettled = isFeedTraceExplicitlySettled(previous);
    const incomingOpen = isFeedTraceOpen(log);
    const sameTemporalLifecycle = Boolean(
      (Number(previous?.startTime || previous?.timestamp || 0) &&
        Number(previous?.startTime || previous?.timestamp || 0) === Number(log?.startTime || log?.timestamp || 0)) ||
      (Number(previous?.endTime || 0) && Number(previous?.endTime || 0) === Number(log?.endTime || 0)) ||
      (previous?._traceIdx !== undefined && previous?._traceIdx === log?._traceIdx)
    );
    const sameLogicalLifecycle = areLikelySameFeedActionLifecycle(previous, log);
    if (!isFeedTraceOpen(previous) && !isFeedTraceOpen(log) && !sameTemporalLifecycle && !sameLogicalLifecycle) {
      const index = canonical.length;
      strongKeys.forEach(key => actionIndexes.set(key, index));
      if (replaySignature) actionIndexes.set(`replay:${ replaySignature }`, index);
      canonical.push(log);
      registerLikelyAction(log, index);
      continue;
    }

    canonical[existingIndex] = {
      ...previous,
      ...log,
      id: previous?.id || log?.id,
      _feedPresentationId: previous?._feedPresentationId || log?._feedPresentationId,
      _feedBoundaryId: previous?._feedBoundaryId || log?._feedBoundaryId,
      _feedBoundaryOrder: previous?._feedBoundaryOrder ?? log?._feedBoundaryOrder,
      _feedEventOrder: previous?._feedEventOrder ?? log?._feedEventOrder,
      _originTraceIdx: previous?._originTraceIdx ?? previous?._traceIdx ?? log?._originTraceIdx ?? log?._traceIdx,
      _traceIdx: previous?._traceIdx ?? log?._traceIdx,
      _pollIdx: log?._pollIdx ?? log?._traceIdx ?? previous?._pollIdx ?? previous?._traceIdx,
      startTime: previous?.startTime || previous?.timestamp || log?.startTime || log?.timestamp,
      endTime: Math.max(Number(previous?.endTime || 0), Number(log?.endTime || 0)) || log?.endTime,
      timestamp: Math.max(Number(previous?.timestamp || 0), Number(log?.timestamp || 0)),
      ...(previousSettled && incomingOpen ? {
        isStreaming: false,
        isLiveTyping: false,
        isLive: false,
        isDelta: false,
        streamState: 'closed',
        status: previous?.status,
        state: previous?.state,
        phase: previous?.phase,
        exitCode: previous?.exitCode,
        durationMs: previous?.durationMs,
        endTime: previous?.endTime,
      } : {}),
    };
    strongKeys.forEach(key => actionIndexes.set(key, existingIndex));
    if (replaySignature) actionIndexes.set(`replay:${ replaySignature }`, existingIndex);
    registerLikelyAction(canonical[existingIndex], existingIndex);
  }

  return canonical.filter(Boolean);
}

function trimTask(task: PersistedTask, compactAll = false): void {
  task.prompt = String(task.prompt || '').replace(/\u0000/g, '');
  task.finalAnswer = String(task.finalAnswer || '').substring(0, MAX_FINAL_ANSWER_CHARS);
  const limit = task.status === 'running' ? MAX_RUNNING_TRACE_LOGS : MAX_COMPLETED_TRACE_LOGS;
  if (!Array.isArray(task.traceLogs)) task.traceLogs = [];
  task.traceLogs = canonicalizePersistedActionLogs(task.traceLogs);
  if (task.traceLogs.length > limit) task.traceLogs = trimTraceLedgerWithBoundary(task.traceLogs, limit);
  if (compactAll) task.traceLogs = task.traceLogs.map(compactTraceEvent);
}

function settleOrphanedLiveTraces(traceLogs: any[], completedAt: number, interrupted = true): any[] {
  return (Array.isArray(traceLogs) ? traceLogs : []).map((trace: any) => {
    const isLive = !isStreamFinalEvent(trace) && (
      trace?.isLive === true ||
      trace?.isStreaming === true ||
      trace?.isLiveTyping === true ||
      trace?.isDelta === true ||
      trace?.streamState === 'open' ||
      ['running', 'working', 'pending', 'streaming', 'spawning', 'started'].includes(
        String(trace?.status || '').trim().toLowerCase()
      )
    );
    const canRemainLive = [
      'console_output', 'work_note', 'thought_stream', 'answer', 'command',
      'tool_call', 'exploration', 'file_edit', 'file_preview', 'progress', 'browser',
      'communication', 'sub_agent_action',
    ].includes(String(trace?.type || ''));
    if (!isLive || !canRemainLive) return trace;
    const startedAt = Number(trace.startTime || trace.timestamp || completedAt);
    const settled = {
      ...trace,
      isLive: false,
      isStreaming: false,
      isLiveTyping: false,
      isDelta: false,
      streamState: 'closed',
      status: ['running', 'working', 'pending', 'streaming', 'spawning', 'started'].includes(
        String(trace?.status || '').trim().toLowerCase()
      ) ? interrupted ? 'stopped' : 'completed' : trace?.status,
      endTime: completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      interrupted,
    };
    return trace.type === 'console_output'
      ? { ...settled, exitCode: typeof trace.exitCode === 'number' ? trace.exitCode : interrupted ? 1 : 0 }
      : settled;
  });
}

function lastRecordedTaskActivity(task: PersistedTask): number {
  let latest = Math.max(
    normalizeStreamTimestamp(task.startedAt, 0),
    normalizeStreamTimestamp(task.lastUpdatedAt, 0),
  );
  for (const trace of Array.isArray(task.traceLogs) ? task.traceLogs : []) {
    latest = Math.max(latest, ...[trace?.startTime, trace?.timestamp, trace?.endTime]
      .map(value => normalizeStreamTimestamp(value, 0)));
  }
  // A recovery timestamp is an observation of a crash, not its occurrence.
  return latest || TASK_STORE_PROCESS_STARTED_AT;
}

function rememberTask(chatId: string, task: PersistedTask): void {
  taskCache.delete(chatId);
  taskCache.set(chatId, task);

  while (taskCache.size > MAX_TASK_CACHE_ENTRIES) {
    let oldestChatId: string | null = null;
    let oldestUpdatedAt = Number.POSITIVE_INFINITY;

    for (const [id, cached] of taskCache.entries()) {
      if (id === chatId) continue;
      if (cached.status === 'running') continue;
      // A busy workspace can exceed the cache target with live chats alone.
      // Never evict a just-finished transcript before its scheduled write has
      // taken a snapshot, or completion/steering rows can disappear on reload.
      if (writeTimers.has(id) || writeChains.has(id) || pendingWriteSnapshots.has(id)) continue;
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
async function flushToDisk(chatId: string, throwOnError = false): Promise<void> {
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
    if (throwOnError) throw err;
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
  async flushPendingWrites(chatIds?: string[]): Promise<void> {
    const ids = chatIds || [...taskCache.keys()];
    await Promise.all(ids.map(async chatId => {
      const timer = writeTimers.get(chatId);
      if (timer) clearTimeout(timer);
      writeTimers.delete(chatId);
      await flushToDisk(chatId, true);
      // A terminal update can join an existing writer while its last await is
      // returning. Include that writer before the desktop kills its server.
      await writeChains.get(chatId);
    }));
  },

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
            // A cold-start scan can overlap a new run or an independently
            // restored chat. Never overwrite that newer in-memory owner with
            // a disk record that was read before its admission.
            if (taskCache.has(task.chatId)) continue;
            task.status = 'failed';
            task.finalAnswer = 'Agent interrupted because EterX was closed or restarted. Previous activity is preserved above.';
            task.completedAt = lastRecordedTaskActivity(task);
            task.lastUpdatedAt = Date.now();
            task.traceLogs = settleOrphanedLiveTraces(task.traceLogs, task.completedAt);
            trimTask(task, true);
            rememberTask(task.chatId, task);
            await flushToDisk(task.chatId);
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
    let timedEvent = compactEvent && typeof compactEvent === 'object'
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

    if (timedEvent && typeof timedEvent === 'object') {
      const eventRunId = String(timedEvent.runId || expectedRunId || task.runId || '').trim();
      let eventTurnId = String(timedEvent.turnId || '').trim();
      if (!eventTurnId) {
        const ownerIdentity = String(
          timedEvent.ownerTraceId || timedEvent.parentTraceId || '',
        ).trim();
        if (ownerIdentity) {
          const ownerAction = [...task.traceLogs].reverse().find((log: any) =>
            PERSISTED_ACTION_TRACE_TYPES.has(String(log?.type || '')) &&
            [log?.traceId, log?.toolCallId, log?.id]
              .map(value => String(value || '').trim())
              .includes(ownerIdentity)
          );
          eventTurnId = String(ownerAction?.turnId || '').trim();
        }
        if (!eventTurnId) {
          const latestRunBoundary = [...task.traceLogs].reverse().find((log: any) =>
            isFeedTurnBoundary(log) && (
              !eventRunId ||
              String(log?.runId || '').trim() === eventRunId ||
              (!String(log?.runId || '').trim() && String(log?.turnId || '').trim() === eventRunId)
            )
          );
          eventTurnId = String(
            latestRunBoundary?.turnId || latestRunBoundary?.id || eventRunId,
          ).trim();
        }
      }
      timedEvent = {
        ...timedEvent,
        ownerChatId: timedEvent.ownerChatId || chatId,
        ...(eventRunId ? { runId: eventRunId } : {}),
        ...(eventTurnId ? { turnId: eventTurnId } : {}),
      };
    }

    // Raw provider reasoning remains internal. Explicit non-empty uiOnly
    // Thought snapshots are presentation events, however, and must share the
    // same durable lifecycle as the live feed or snapshot reconciliation can
    // make a landed row disappear between provider chunks.
    if (!isUserVisibleTrace(timedEvent)) return;

    if (timedEvent?.type !== 'thought_stream') {
      closeThoughtStreamsForBoundary(task.traceLogs, timedEvent);
    }

    if (timedEvent?.type === 'user_action') {
      const eventRunId = String(timedEvent.runId || timedEvent.turnId || task.runId || '').trim();
      const traceIndex = timedEvent._traceIdx;
      const existingUserIndex = task.traceLogs.findIndex((log: any) => {
        if (log?.type !== 'user_action') return false;
        if (sameUserAdmission(log, timedEvent)) return true;
        const logRunId = String(log.runId || log.turnId || '').trim();
        if (eventRunId && logRunId && eventRunId !== logRunId) return false;
        const incomingTurnId = String(timedEvent.turnId || '').trim();
        const existingTurnId = String(log.turnId || '').trim();
        if (incomingTurnId && existingTurnId && incomingTurnId !== existingTurnId) return false;
        const sameTraceIndex = traceIndex !== undefined && traceIndex !== null && log._traceIdx === traceIndex;
        // Legacy adapters can recycle generic event IDs. Without a canonical
        // admission identity, require a cursor in the same run/turn namespace.
        return Boolean(
          sameTraceIndex &&
          ((eventRunId && logRunId && eventRunId === logRunId) ||
            (incomingTurnId && existingTurnId && incomingTurnId === existingTurnId))
        );
      });
      if (existingUserIndex >= 0) {
        const previous = task.traceLogs[existingUserIndex];
        task.traceLogs[existingUserIndex] = {
          ...previous,
          ...timedEvent,
          id: previous.id || timedEvent.id,
          _feedPresentationId: previous._feedPresentationId || timedEvent._feedPresentationId,
          _feedBoundaryId: previous._feedBoundaryId || timedEvent._feedBoundaryId,
          _feedBoundaryOrder: previous._feedBoundaryOrder ?? timedEvent._feedBoundaryOrder,
          _feedEventOrder: previous._feedEventOrder ?? timedEvent._feedEventOrder,
          _originTraceIdx: previous._originTraceIdx ?? previous._traceIdx ?? timedEvent._originTraceIdx ?? timedEvent._traceIdx,
          _traceIdx: previous._traceIdx ?? timedEvent._traceIdx,
          _pollIdx: timedEvent._traceIdx ?? timedEvent._pollIdx ?? previous._pollIdx ?? previous._traceIdx,
          startTime: previous.startTime || timedEvent.startTime || timedEvent.timestamp,
        };
      } else {
        task.traceLogs.push(timedEvent);
      }
    } else if (timedEvent?.type === 'steering_received') {
      const incomingRunId = String(timedEvent.runId || '').trim();
      const incomingTurnId = String(timedEvent.turnId || '').trim();
      const incomingTraceIndex = timedEvent._traceIdx;
      const existingSteeringIndex = task.traceLogs.findIndex(log => {
          if (log?.type !== 'steering_received') return false;
          if (sameUserAdmission(log, timedEvent)) return true;
          if (incomingTraceIndex === undefined || incomingTraceIndex === null || log._traceIdx !== incomingTraceIndex) return false;
          const existingRunId = String(log.runId || '').trim();
          const existingTurnId = String(log.turnId || '').trim();
          return Boolean(
            (incomingRunId && existingRunId && incomingRunId === existingRunId) ||
            (incomingTurnId && existingTurnId && incomingTurnId === existingTurnId)
          );
        });
      if (existingSteeringIndex >= 0) {
        const previous = task.traceLogs[existingSteeringIndex];
        task.traceLogs[existingSteeringIndex] = {
          ...previous,
          ...timedEvent,
          id: previous.id || timedEvent.id,
          _feedPresentationId: previous._feedPresentationId || timedEvent._feedPresentationId,
          _feedBoundaryId: previous._feedBoundaryId || timedEvent._feedBoundaryId,
          _feedBoundaryOrder: previous._feedBoundaryOrder ?? timedEvent._feedBoundaryOrder,
          _feedEventOrder: previous._feedEventOrder ?? timedEvent._feedEventOrder,
          _traceIdx: previous._traceIdx ?? timedEvent._traceIdx,
          _pollIdx: timedEvent._traceIdx ?? timedEvent._pollIdx ?? previous._pollIdx ?? previous._traceIdx,
          startTime: previous.startTime || timedEvent.startTime || timedEvent.timestamp,
          timestamp: Math.max(Number(previous.timestamp || 0), Number(timedEvent.timestamp || 0)),
        };
      } else {
        task.traceLogs.push(timedEvent);
      }
    } else if (timedEvent?.type === 'done' || timedEvent?.type === 'error') {
      const incomingId = String(timedEvent.id || '').trim();
      const incomingScope = String(timedEvent.turnId || timedEvent.runId || '').trim();
      const incomingOrigin = timedEvent._originTraceIdx ?? timedEvent._traceIdx;
      const incomingAt = Number(timedEvent.timestamp || timedEvent.endTime || 0);
      const incomingText = formatUnknownError(timedEvent.text ?? timedEvent.detail ?? timedEvent.data, '');
      const existingTerminalIndex = task.traceLogs.findIndex((log: any) => {
        if (log?.type !== timedEvent.type) return false;
        const existingScope = String(log.turnId || log.runId || '').trim();
        if (incomingScope && existingScope && incomingScope !== existingScope) return false;
        const sameId = Boolean(incomingId && String(log.id || '').trim() === incomingId);
        const existingOrigin = log._originTraceIdx ?? log._traceIdx;
        const sameOrigin = incomingOrigin !== undefined && incomingOrigin !== null &&
          existingOrigin !== undefined && existingOrigin !== null && existingOrigin === incomingOrigin;
        // Legacy terminal traces occasionally had neither an id nor a trace
        // cursor. Exact time + exact payload is the only safe replay key for
        // those records; it cannot merge two differently reported failures.
        const sameLegacyEvent = !incomingId && incomingOrigin === undefined &&
          Number(log.timestamp || log.endTime || 0) === incomingAt &&
          formatUnknownError(log.text ?? log.detail ?? log.data, '') === incomingText;
        return sameId || sameOrigin || sameLegacyEvent;
      });
      if (existingTerminalIndex >= 0) {
        const previous = task.traceLogs[existingTerminalIndex];
        task.traceLogs[existingTerminalIndex] = {
          ...previous,
          ...timedEvent,
          id: previous.id || timedEvent.id,
          text: formatUnknownError(
            timedEvent.text ?? timedEvent.detail,
            formatUnknownError(previous.text ?? previous.detail, ''),
          ),
          detail: formatUnknownError(
            timedEvent.detail,
            formatUnknownError(previous.detail, ''),
          ) || undefined,
          _originTraceIdx: previous._originTraceIdx ?? previous._traceIdx ?? timedEvent._originTraceIdx ?? timedEvent._traceIdx,
          _traceIdx: previous._traceIdx ?? timedEvent._traceIdx,
          _pollIdx: timedEvent._traceIdx ?? timedEvent._pollIdx ?? previous._pollIdx ?? previous._traceIdx,
          startTime: previous.startTime || previous.timestamp || timedEvent.startTime || timedEvent.timestamp,
          endTime: Math.max(
            Number(previous.endTime || previous.timestamp || 0),
            Number(timedEvent.endTime || timedEvent.timestamp || 0),
          ) || undefined,
          timestamp: Math.max(Number(previous.timestamp || 0), Number(timedEvent.timestamp || 0)),
        };
      } else {
        task.traceLogs.push(timedEvent);
      }
    } else if (timedEvent?.type === 'model_usage') {
      upsertModelUsageReceipt(task.traceLogs, timedEvent);
    } else if (timedEvent?.type === 'context_usage') {
      upsertContextUsageSnapshot(task.traceLogs, timedEvent);
    } else if (timedEvent?.type === 'context_compaction' && String(timedEvent.compactionId || '').trim()) {
      const incomingCompactionId = String(timedEvent.compactionId).trim();
      const incomingChatId = String(timedEvent.chatId || timedEvent.ownerChatId || chatId).trim();
      const existingCompactionIndex = task.traceLogs.findIndex((log: any) => {
        if (log?.type !== 'context_compaction') return false;
        if (String(log.compactionId || '').trim() !== incomingCompactionId) return false;
        const existingChatId = String(log.chatId || log.ownerChatId || chatId).trim();
        return !incomingChatId || !existingChatId || incomingChatId === existingChatId;
      });
      if (existingCompactionIndex >= 0) {
        task.traceLogs[existingCompactionIndex] = mergeContextCompactionSnapshot(
          task.traceLogs[existingCompactionIndex],
          timedEvent,
        );
      } else {
        task.traceLogs.push({
          ...timedEvent,
          id: timedEvent.id || `context-compaction:${ incomingCompactionId }`,
          startTime: timedEvent.startTime || timedEvent.timestamp,
        });
      }
    } else if (timedEvent?.type === 'thought_stream') {
      mergeThoughtStreamTrace(task.traceLogs, timedEvent);
    } else if (timedEvent?.type === 'progress' && String(timedEvent.id || '').trim()) {
      const incomingId = String(timedEvent.id).trim();
      const incomingScope = String(timedEvent.turnId || timedEvent.runId || '').trim();
      const existingProgressIndex = task.traceLogs.findIndex((log: any) => {
        if (log?.type !== 'progress' || String(log.id || '').trim() !== incomingId) return false;
        const existingScope = String(log.turnId || log.runId || '').trim();
        return !incomingScope || !existingScope || incomingScope === existingScope;
      });
      if (existingProgressIndex >= 0) {
        const previous = task.traceLogs[existingProgressIndex];
        task.traceLogs[existingProgressIndex] = {
          ...previous,
          ...timedEvent,
          id: previous.id || timedEvent.id,
          _feedPresentationId: previous._feedPresentationId || timedEvent._feedPresentationId,
          _feedBoundaryId: previous._feedBoundaryId || timedEvent._feedBoundaryId,
          _feedBoundaryOrder: previous._feedBoundaryOrder ?? timedEvent._feedBoundaryOrder,
          _feedEventOrder: previous._feedEventOrder ?? timedEvent._feedEventOrder,
          _traceIdx: previous._traceIdx ?? timedEvent._traceIdx,
          _pollIdx: timedEvent._traceIdx ?? timedEvent._pollIdx ?? previous._pollIdx ?? previous._traceIdx,
          startTime: previous.startTime || previous.timestamp || timedEvent.startTime || timedEvent.timestamp,
          timestamp: Math.max(Number(previous.timestamp || 0), Number(timedEvent.timestamp || 0)),
        };
      } else {
        task.traceLogs.push(timedEvent);
      }
    } else if (timedEvent?.type === 'task_plan') {
      const incomingScope = String(timedEvent.turnId || timedEvent.runId || '').trim();
      const existingPlanIndex = incomingScope
        ? task.traceLogs.findIndex((log: any) =>
          log?.type === 'task_plan' &&
          String(log.turnId || log.runId || '').trim() === incomingScope
        )
        : -1;
      if (existingPlanIndex >= 0) {
        const previous = task.traceLogs[existingPlanIndex];
        task.traceLogs[existingPlanIndex] = {
          ...previous,
          ...timedEvent,
          id: previous.id || timedEvent.id,
          planId: previous.planId || timedEvent.planId,
          ownerTraceId: previous.ownerTraceId || timedEvent.ownerTraceId,
          _feedPresentationId: previous._feedPresentationId || timedEvent._feedPresentationId,
          _feedBoundaryId: previous._feedBoundaryId || timedEvent._feedBoundaryId,
          _feedBoundaryOrder: previous._feedBoundaryOrder ?? timedEvent._feedBoundaryOrder,
          _feedEventOrder: previous._feedEventOrder ?? timedEvent._feedEventOrder,
          _traceIdx: previous._traceIdx ?? timedEvent._traceIdx,
          _pollIdx: timedEvent._traceIdx ?? timedEvent._pollIdx ?? previous._pollIdx ?? previous._traceIdx,
          startTime: previous.startTime || previous.timestamp || timedEvent.startTime || timedEvent.timestamp,
          timestamp: Math.max(Number(previous.timestamp || 0), Number(timedEvent.timestamp || 0)),
        };
      } else {
        task.traceLogs.push(timedEvent);
      }
    } else if (PERSISTED_ACTION_TRACE_TYPES.has(String(timedEvent?.type || ''))) {
      const incomingIdentities = persistedActionIdentities(timedEvent);
      const incomingScope = String(timedEvent.turnId || timedEvent.runId || '').trim();
      const incomingType = normalizedPersistedActionType(timedEvent.type);
      let mergeIdx = -1;
      if (incomingIdentities.size > 0) {
        for (let index = task.traceLogs.length - 1; index >= 0; index -= 1) {
          const existing = task.traceLogs[index];
          // A strong action ID retains the turn assigned when the action first
          // landed, even if a later steering boundary is already present.
          if (isFeedTurnBoundary(existing)) continue;
          if (!PERSISTED_ACTION_TRACE_TYPES.has(String(existing?.type || ''))) continue;
          if (normalizedPersistedActionType(existing.type) !== incomingType) continue;
          const existingScope = String(existing.turnId || existing.runId || '').trim();
          if (incomingScope && existingScope && incomingScope !== existingScope) continue;
          if (
            !haveConflictingFeedActionInvocations(existing, timedEvent) &&
            [...persistedActionIdentities(existing)].some(identity => incomingIdentities.has(identity))
          ) {
            mergeIdx = index;
            break;
          }
        }
      }
      if (mergeIdx < 0) {
        for (let index = task.traceLogs.length - 1; index >= 0; index -= 1) {
          if (areLikelySameFeedActionLifecycle(task.traceLogs[index], timedEvent)) {
            mergeIdx = index;
            break;
          }
        }
      }
      if (mergeIdx >= 0) {
        const previous = task.traceLogs[mergeIdx];
        const incomingStatus = String(timedEvent.status || '').trim().toLowerCase();
        const incomingOpen = !isStreamFinalEvent(timedEvent) && (
          timedEvent.isLive === true ||
          timedEvent.isStreaming === true ||
          timedEvent.isLiveTyping === true ||
          timedEvent.streamState === 'open' ||
          ['running', 'working', 'pending', 'streaming', 'spawning', 'started'].includes(incomingStatus)
        );
        task.traceLogs[mergeIdx] = {
          ...previous,
          ...timedEvent,
          id: previous.id || timedEvent.id,
          _feedPresentationId: previous._feedPresentationId || timedEvent._feedPresentationId,
          _feedBoundaryId: previous._feedBoundaryId || timedEvent._feedBoundaryId,
          _feedBoundaryOrder: previous._feedBoundaryOrder ?? timedEvent._feedBoundaryOrder,
          _feedEventOrder: previous._feedEventOrder ?? timedEvent._feedEventOrder,
          _traceIdx: previous._traceIdx ?? timedEvent._traceIdx,
          _pollIdx: timedEvent._traceIdx ?? timedEvent._pollIdx ?? previous._pollIdx ?? previous._traceIdx,
          startTime: previous.startTime || previous.timestamp || timedEvent.startTime || timedEvent.timestamp,
          endTime: Math.max(
            Number(previous.endTime || previous.timestamp || 0),
            Number(timedEvent.endTime || timedEvent.timestamp || 0),
          ) || undefined,
          timestamp: Math.max(Number(previous.timestamp || 0), Number(timedEvent.timestamp || 0)),
          ...(!incomingOpen ? {
            isLive: false,
            isStreaming: false,
            isLiveTyping: false,
            isDelta: false,
            streamState: 'closed',
            status: ['running', 'working', 'pending', 'streaming', 'spawning', 'started'].includes(incomingStatus)
              ? 'completed'
              : timedEvent.status || previous.status,
          } : {}),
        };
      } else {
        task.traceLogs.push(timedEvent);
      }
    } else if (timedEvent?.type === 'file_preview') {
      const incomingId = String(timedEvent.id || timedEvent.traceId || '').trim();
      const incomingOwner = String(timedEvent.ownerTraceId || '').trim();
      const incomingPath = String(timedEvent.filepath || timedEvent.filename || '').replace(/\\/g, '/').toLowerCase();
      const incomingScope = String(timedEvent.turnId || timedEvent.runId || '').trim();
      let mergeIdx = -1;
      for (let index = task.traceLogs.length - 1; index >= 0; index--) {
        const existing = task.traceLogs[index];
        if (isFeedTurnBoundary(existing)) {
          if (incomingId || incomingOwner) continue;
          break;
        }
        if (existing?.type !== 'file_preview') continue;
        const existingScope = String(existing.turnId || existing.runId || '').trim();
        if (incomingScope && existingScope && incomingScope !== existingScope) continue;
        const existingId = String(existing.id || existing.traceId || '').trim();
        const existingOwner = String(existing.ownerTraceId || '').trim();
        const existingPath = String(existing.filepath || existing.filename || '').replace(/\\/g, '/').toLowerCase();
        const sameIdentity = Boolean(incomingId && existingId === incomingId);
        const sameOwnerPath = Boolean(
          incomingOwner &&
          existingOwner === incomingOwner &&
          ((!incomingPath && !existingPath) || (incomingPath && existingPath === incomingPath))
        );
        const samePath = Boolean(
          !incomingOwner &&
          !existingOwner &&
          incomingPath &&
          timedEvent.dedupe !== false &&
          existingPath === incomingPath &&
          existing.dedupe !== false
        );
        if (sameIdentity || sameOwnerPath || samePath) {
          mergeIdx = index;
          break;
        }
      }
      if (mergeIdx >= 0) {
        const previous = task.traceLogs[mergeIdx];
        task.traceLogs[mergeIdx] = {
          ...previous,
          ...timedEvent,
          id: previous.id || timedEvent.id,
          _feedPresentationId: previous._feedPresentationId || timedEvent._feedPresentationId,
          _feedBoundaryId: previous._feedBoundaryId || timedEvent._feedBoundaryId,
          _feedBoundaryOrder: previous._feedBoundaryOrder ?? timedEvent._feedBoundaryOrder,
          _feedEventOrder: previous._feedEventOrder ?? timedEvent._feedEventOrder,
          _traceIdx: previous._traceIdx ?? timedEvent._traceIdx,
          _pollIdx: timedEvent._traceIdx ?? timedEvent._pollIdx ?? previous._pollIdx ?? previous._traceIdx,
          startTime: previous.startTime || timedEvent.startTime || timedEvent.timestamp,
          endTime: Math.max(
            Number(previous.endTime || previous.timestamp || 0),
            Number(timedEvent.endTime || timedEvent.timestamp || 0),
          ),
          timestamp: Math.max(Number(previous.timestamp || 0), Number(timedEvent.timestamp || 0)),
        };
      } else {
        task.traceLogs.push(timedEvent);
      }
    } else if (timedEvent?.type === 'answer_cancel') {
      const answerId = String(timedEvent.answerId || '').trim();
      const replacementNoteId = String(timedEvent.replacementNoteId || '').trim();
      const incomingScope = String(timedEvent.turnId || timedEvent.runId || '').trim();
      const incomingOwner = timedEvent.subAgentChatId || timedEvent.subAgentId || timedEvent.subAgent || null;
      const replacementExists = Boolean(replacementNoteId && task.traceLogs.some(log =>
        log?.type === 'work_note' && log.noteId === replacementNoteId &&
        (log.subAgentChatId || log.subAgentId || log.subAgent || null) === incomingOwner &&
        (!incomingScope || String(log.turnId || log.runId || '').trim() === incomingScope)));
      for (let i = task.traceLogs.length - 1; i >= 0; i--) {
        const log = task.traceLogs[i];
        if (isFeedTurnBoundary(log)) {
          if (answerId) continue;
          break;
        }
        if (
          log?.type === 'answer' &&
          (log.subAgentChatId || log.subAgentId || log.subAgent || null) === incomingOwner &&
          (!incomingScope || !String(log.turnId || log.runId || '').trim() || String(log.turnId || log.runId || '').trim() === incomingScope) &&
          (
            (answerId && String(log.answerId || '') === answerId) ||
            (!answerId && (log.isStreaming || log.isLiveTyping || log.streamState === 'open'))
          )
        ) {
          if (replacementExists) {
            task.traceLogs.splice(i, 1);
            continue;
          }
          if (replacementNoteId && String(log.text || '').trim()) {
            // Persist the same row transition that live clients observe. The
            // cancel delivery index becomes `_pollIdx`, so a reconnect that
            // already consumed the answer still receives this in-place update.
            task.traceLogs[i] = {
              ...log,
              type: 'work_note',
              noteId: replacementNoteId,
              isLive: false,
              isStreaming: false,
              isLiveTyping: false,
              isDelta: false,
              streamState: 'closed',
              status: 'completed',
              _answerTransitionPending: true,
              _streamingCancelled: true,
              _cancelTraceIdx: timedEvent._traceIdx,
              _cancelledAt: timedEvent.timestamp || timedEvent.endTime,
              _pollIdx: timedEvent._traceIdx ?? log._pollIdx ?? log._traceIdx,
            };
          } else {
            task.traceLogs.splice(i, 1);
          }
          break;
        }
      }
      // Keep a durable transition event. Incremental clients that already
      // rendered the provisional answer use it to update that same row, while
      // a full reconnect sees the converted work note stored above.
      task.traceLogs.push(timedEvent);
    } else if (timedEvent?.type === 'answer') {
      const answerId = String(timedEvent.answerId || '').trim();
      const incomingIsStreaming =
        !isStreamFinalEvent(timedEvent) && (
          timedEvent.isStreaming === true ||
          timedEvent.isLiveTyping === true ||
          timedEvent.isDelta === true ||
          timedEvent.streamState === 'open'
        );
      let mergeIdx = -1;
      const incomingScope = String(timedEvent.turnId || timedEvent.runId || '').trim();
      for (let i = task.traceLogs.length - 1; i >= 0; i--) {
        const log = task.traceLogs[i];
        if (isFeedTurnBoundary(log)) {
          if (answerId) continue;
          break;
        }
        if (log?.type !== 'answer') continue;
        const existingScope = String(log.turnId || log.runId || '').trim();
        if (incomingScope && existingScope && incomingScope !== existingScope) continue;
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
          _feedPresentationId: previous._feedPresentationId || timedEvent._feedPresentationId,
          _feedBoundaryId: previous._feedBoundaryId || timedEvent._feedBoundaryId,
          _feedBoundaryOrder: previous._feedBoundaryOrder ?? timedEvent._feedBoundaryOrder,
          _feedEventOrder: previous._feedEventOrder ?? timedEvent._feedEventOrder,
          // The answer is one presentation row for its whole cumulative
          // stream. Preserve its first timeline position and separately carry
          // the newest delivery cursor used by incremental polling.
          _traceIdx: previous._traceIdx ?? timedEvent._traceIdx,
          _pollIdx: timedEvent._traceIdx ?? timedEvent._pollIdx ?? previous._pollIdx ?? previous._traceIdx,
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
          isLive: incomingIsStreaming ? timedEvent.isLive : false,
          isDelta: incomingIsStreaming ? timedEvent.isDelta : false,
          streamState: incomingIsStreaming ? 'open' : 'closed',
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
          isLive: incomingIsStreaming ? timedEvent.isLive : false,
          isDelta: incomingIsStreaming ? timedEvent.isDelta : false,
          streamState: incomingIsStreaming ? 'open' : 'closed',
        });
      }
    } else if (timedEvent?.type === 'work_note_cancel') {
      const noteId = timedEvent.noteId || null;
      const subAgent = timedEvent.subAgent || null;
      const subAgentIdentity = timedEvent.subAgentChatId || timedEvent.subAgentId || subAgent;
      const incomingScope = String(timedEvent.turnId || timedEvent.runId || '').trim();
      for (let i = task.traceLogs.length - 1; i >= 0; i--) {
        const log = task.traceLogs[i];
        if (isFeedTurnBoundary(log)) {
          const boundaryScope = String(log.turnId || log.runId || '').trim();
          // Provider-local note IDs may restart on a later query. Cross a
          // visible boundary only when this cancellation explicitly owns an
          // older, different turn; an unscoped ID is never enough authority.
          if (noteId && incomingScope && boundaryScope && incomingScope !== boundaryScope) continue;
          break;
        }
        if (
          log?.type === 'work_note' &&
          (!incomingScope || !String(log.turnId || log.runId || '').trim() || String(log.turnId || log.runId || '').trim() === incomingScope) &&
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
            _pollIdx: timedEvent._traceIdx ?? log._pollIdx ?? log._traceIdx,
          };
          break;
        }
      }
    } else if (timedEvent?.type === 'work_note') {
      const noteText = String(timedEvent.text || '');
      if (!noteText.trim()) return;
      const normalizedNoteText = noteText.replace(/\s+/g, ' ').trim();
      const noteId = timedEvent.noteId || null;
      const subAgent = timedEvent.subAgent || null;
      const subAgentIdentity = timedEvent.subAgentChatId || timedEvent.subAgentId || subAgent;
      const incomingScope = String(timedEvent.turnId || timedEvent.runId || '').trim();
      // Provider adapters commonly emit a complete one-shot work note without
      // any stream flags. Treat only an explicitly open note as provisional.
      const incomingIsFinal = !isOpenPersistedWorkNote(timedEvent);
      let mergeIdx = -1;
      let ignoreCancelledUpdate = false;
      let crossedPhaseBoundary = false;
      for (let i = task.traceLogs.length - 1; i >= 0; i--) {
        const log = task.traceLogs[i];
        if (isFeedTurnBoundary(log)) {
          const boundaryScope = String(log.turnId || log.runId || '').trim();
          if (noteId && incomingScope && boundaryScope && incomingScope !== boundaryScope) {
            crossedPhaseBoundary = true;
            continue;
          }
          break;
        }
        if (WORK_NOTE_PHASE_BOUNDARY_TYPES.has(String(log?.type || ''))) {
          crossedPhaseBoundary = true;
          continue;
        }
        if (
          log?.type !== 'work_note' ||
          (incomingScope && String(log.turnId || log.runId || '').trim() && String(log.turnId || log.runId || '').trim() !== incomingScope) ||
          (log.subAgentChatId || log.subAgentId || log.subAgent || null) !== subAgentIdentity
        ) continue;
        const sameNote = noteId && log.noteId && log.noteId === noteId;
        const sameText = String(log.text || '').replace(/\s+/g, ' ').trim() === normalizedNoteText;
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
        const isAdjacentExactDuplicate = Boolean(
          !crossedPhaseBoundary &&
          sameText &&
          i === task.traceLogs.length - 1 &&
          closeInTime
        );
        // Two adapters can publish the same note under different local IDs
        // during a live->durable hand-off. Exact adjacent same-owner text in
        // one query is one lifecycle; a repeat after any action/phase boundary
        // remains a separate, intentional note.
        if (
          sameNote ||
          canFinalizeAdjacentText ||
          canMergeIdlessStream ||
          isCancelledPlaceholder ||
          isAdjacentExactDuplicate
        ) {
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
          text: mergeVisibleNarrativeText(
            previous.text,
            noteText,
            timedEvent.isDelta === true,
          ),
          _feedPresentationId: previous._feedPresentationId || timedEvent._feedPresentationId,
          _feedBoundaryId: previous._feedBoundaryId || timedEvent._feedBoundaryId,
          _feedBoundaryOrder: previous._feedBoundaryOrder ?? timedEvent._feedBoundaryOrder,
          _feedEventOrder: previous._feedEventOrder ?? timedEvent._feedEventOrder,
          noteId: noteId || previous.noteId || null,
          subAgent: subAgent ?? previous.subAgent ?? null,
          // Keep the row's original timeline identity/position, but retain
          // the newest delivery cursor so incremental polling still emits an
          // in-place update that reused this persisted row.
          _traceIdx: previous._traceIdx ?? timedEvent._traceIdx,
          _pollIdx: timedEvent._traceIdx ?? previous._pollIdx ?? previous._traceIdx,
          startTime: previous.startTime || timedEvent.startTime || timedEvent.timestamp,
          endTime: Math.max(
            Number(previous.endTime || previous.timestamp || 0),
            Number(timedEvent.endTime || timedEvent.timestamp || 0),
          ),
          timestamp: Math.max(
            Number(previous.timestamp || 0),
            Number(timedEvent.timestamp || 0),
          ),
          ...(incomingIsFinal ? {
            isLive: false,
            isStreaming: false,
            isLiveTyping: false,
            isDelta: false,
            streamState: 'closed',
            status: ['running', 'working', 'pending', 'streaming', 'spawning', 'started'].includes(
              String(timedEvent.status || previous.status || '').trim().toLowerCase()
            ) ? 'completed' : timedEvent.status || previous.status,
          } : {}),
          _streamingCancelled: undefined,
          _cancelTraceIdx: undefined,
          _cancelledAt: undefined,
          _answerTransitionPending: undefined,
        };
      } else {
        task.traceLogs.push({
          ...timedEvent,
          text: noteText,
          noteId,
          subAgent,
          ...(incomingIsFinal ? {
            isLive: false,
            isStreaming: false,
            isLiveTyping: false,
            isDelta: false,
            streamState: 'closed',
            status: ['running', 'working', 'pending', 'streaming', 'spawning', 'started'].includes(
              String(timedEvent.status || '').trim().toLowerCase()
            ) ? 'completed' : timedEvent.status,
          } : {}),
        });
      }
    } else if (timedEvent?.type === 'console_output') {
      const streamId = String(timedEvent.streamId || '').trim();
      const ownerTraceId = String(timedEvent.ownerTraceId || '').trim();
      const terminalTaskId = String(timedEvent.taskId || timedEvent.backgroundTaskId || '').trim();
      const incomingScope = String(timedEvent.turnId || timedEvent.runId || '').trim();
      let mergeIdx = -1;

      for (let i = task.traceLogs.length - 1; i >= 0; i--) {
        const log = task.traceLogs[i];
        if (isFeedTurnBoundary(log)) {
          if (streamId || ownerTraceId || terminalTaskId) continue;
          break;
        }
        if (log?.type !== 'console_output') continue;
        const existingScope = String(log.turnId || log.runId || '').trim();
        if (incomingScope && existingScope && incomingScope !== existingScope) continue;
        const sameCommand = String(log.command || '').trim() === String(timedEvent.command || '').trim();
        const existingStreamId = String(log.streamId || '').trim();
        const existingTaskId = String(log.taskId || log.backgroundTaskId || '').trim();
        const sameStream = streamId && existingStreamId === streamId && sameCommand;
        const hasConflictingStream = Boolean(streamId && existingStreamId && streamId !== existingStreamId);
        const hasConflictingTask = Boolean(
          terminalTaskId && existingTaskId && terminalTaskId !== existingTaskId,
        );
        const sameOwner = ownerTraceId
          && String(log.ownerTraceId || '') === ownerTraceId
          && sameCommand
          // One batched workspace action can own several parallel processes,
          // including intentionally repeated commands. Exact stream/task IDs
          // outrank the shared action owner and must remain separate rows.
          && !hasConflictingStream
          && !hasConflictingTask;
        const sameTask = terminalTaskId
          && existingTaskId === terminalTaskId
          && sameCommand;
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
    // The first terminal outcome owns this run. Late cleanup/cancellation
    // cannot rewrite a completed response (or turn a stopped run into success).
    if (task.status !== 'running') return;

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
        // A new run may have been admitted while this disk read was pending.
        const admitted = taskCache.get(chatId);
        if (admitted) return admitted;
        const interrupted = task.status === 'running' && task.startedAt < TASK_STORE_PROCESS_STARTED_AT;
        if (interrupted) {
          task.status = 'failed';
          task.finalAnswer = 'Agent interrupted because EterX was closed or restarted. Previous activity is preserved above.';
          task.completedAt = lastRecordedTaskActivity(task);
          task.lastUpdatedAt = Date.now();
          task.traceLogs = settleOrphanedLiveTraces(task.traceLogs, task.completedAt);
        }
        trimTask(task, true);
        rememberTask(chatId, task);
        // Migrate a verified legacy record to its collision-proof namespace.
        if (interrupted || readableTaskPath !== taskPath) await flushToDisk(chatId);
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
    terminalTurnId?: string;
  }> {
    // Recover this chat directly. Waiting for a workspace-wide archive scan
    // held every reopened chat behind unrelated files and slow disk reads.
    const task = await this.getTask(chatId);
    if (!task) {
      return { status: 'idle', traces: [], totalTraces: 0, maxIndex: -1, finalAnswer: '' };
    }

    const persistedTraces = task.traceLogs || [];
    const terminalTurnId = String(
      [...persistedTraces].reverse().find(trace =>
        trace?.mainTurnTerminal === true && String(trace?.turnId || '').trim()
      )?.turnId || '',
    ).trim();
    const hasUserBoundary = persistedTraces.some(trace => trace?.type === 'user_action');
    const recoveredPrompt = String(task.prompt || '').trim();
    // `task.prompt` is always the run's opening request. A compacted ledger
    // may begin with a later steering turn, which must not become the owner of
    // this recovered query or the UI will duplicate the first prompt there.
    const recoveredTurnId = String(
      task.runId || persistedTraces.find(trace => String(trace?.turnId || '').trim())?.turnId || '',
    ).trim();
    const sourceTraces = !hasUserBoundary && recoveredPrompt
      ? [
        {
          id: `user-turn-${ task.runId || task.taskId }`,
          type: 'user_action',
          text: recoveredPrompt,
          source: 'human',
          ownerChatId: chatId,
          ...(task.runId ? { runId: task.runId } : {}),
          ...(recoveredTurnId ? { turnId: recoveredTurnId } : {}),
          timestamp: task.startedAt,
          startTime: task.startedAt,
          endTime: task.startedAt,
          _traceIdx: -1,
          _recoveredExactText: true,
        },
        ...persistedTraces,
      ]
      : persistedTraces;
    const traces: any[] = [];
    let maxIndex = -1;

    for (let index = 0; index < sourceTraces.length; index++) {
      const trace = sourceTraces[index];
      const traceObj = trace && typeof trace === 'object' ? trace : { value: trace };
      const traceIndex = Number.isFinite(traceObj._pollIdx)
        ? traceObj._pollIdx
        : Number.isFinite(traceObj._traceIdx) ? traceObj._traceIdx : index;
      if (traceIndex > maxIndex) maxIndex = traceIndex;
      if (!isUserVisibleTrace(traceObj)) continue;
      if (afterIndex < 0 || traceIndex > afterIndex) {
        const fallbackTimestamp = task.completedAt || task.lastUpdatedAt || task.startedAt;
        const indexedTrace = traceObj._traceIdx !== undefined && traceObj._traceIdx !== null
          ? traceObj
          : { ...traceObj, _traceIdx: traceIndex };
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
      ...(terminalTurnId ? { terminalTurnId } : {}),
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
          
          // Quiet long-running work is not a crashed process. Only a record
          // predating this process can be an orphan; age alone proves nothing.
          if (data.status === 'running' && data.startedAt < TASK_STORE_PROCESS_STARTED_AT) {
            console.log(`[TaskStore] Recovering interrupted task ${data.taskId}.`);
            data.status = 'failed';
            data.finalAnswer = 'Task failed due to a system crash or timeout.';
            data.completedAt = lastRecordedTaskActivity(data);
            data.lastUpdatedAt = Date.now();
            data.traceLogs = trimTraceLedgerWithBoundary(
              settleOrphanedLiveTraces(data.traceLogs, data.completedAt),
              MAX_COMPLETED_TRACE_LOGS,
            ).map(compactTraceEvent);
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
