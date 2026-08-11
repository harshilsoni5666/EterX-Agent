import { mergeStreamingText } from './streaming-lifecycle';

const TERMINAL_STREAM_TYPES = new Set(['done', 'error', 'agent_status', 'run_status']);
const TERMINAL_STREAM_STATUSES = new Set([
  'completed',
  'complete',
  'failed',
  'stopped',
  'cancelled',
  'canceled',
  'error',
]);
const THOUGHT_CLOSING_BOUNDARY_TYPES = new Set([
  'thought_stream_boundary',
  'command',
  'tool_call',
  'action',
  'answer',
  'work_note',
  'thought',
]);

const asFiniteTimestamp = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Main-agent events intentionally share one owner. Concurrent sub-agents use
 * isolated owners so they cannot close or merge each other's thought streams.
 */
export const getThoughtStreamOwner = (trace: any): string => {
  const subAgentChatId = String(trace?.subAgentChatId || trace?.subAgentId || '').trim();
  if (subAgentChatId) return `sub:${ subAgentChatId }`;

  const explicitSubAgent = String(trace?.subAgent || '').trim();
  if (explicitSubAgent) return `sub:${ explicitSubAgent }`;

  const agentName = String(trace?.agentName || '').trim();
  if (agentName && agentName.toLowerCase() !== 'main') return `sub:${ agentName }`;

  return 'main';
};

const isGlobalTerminalBoundary = (trace: any): boolean => {
  const type = String(trace?.type || '').trim().toLowerCase();
  const status = String(trace?.status || '').trim().toLowerCase();
  return getThoughtStreamOwner(trace) === 'main' && TERMINAL_STREAM_TYPES.has(type) && (
    type === 'done' ||
    type === 'error' ||
    TERMINAL_STREAM_STATUSES.has(status)
  );
};

const isThoughtClosingBoundary = (trace: any): boolean => {
  const type = String(trace?.type || '').trim().toLowerCase();
  return THOUGHT_CLOSING_BOUNDARY_TYPES.has(type);
};

const getTraceTimestamp = (trace: any): number =>
  asFiniteTimestamp(trace?.endTime) ??
  asFiniteTimestamp(trace?.timestamp) ??
  asFiniteTimestamp(trace?.startTime) ??
  Date.now();

const getThoughtUpdateTimestamp = (trace: any): number =>
  asFiniteTimestamp(trace?.endTime) ??
  asFiniteTimestamp(trace?.timestamp) ??
  asFiniteTimestamp(trace?.startTime) ??
  Date.now();

const closeThoughtAt = (log: any, endedAt: number) => {
  const startedAt = asFiniteTimestamp(log?.startTime);
  const safeEnd = startedAt === null ? endedAt : Math.max(startedAt, endedAt);
  return {
    ...log,
    isStreaming: false,
    streamState: 'closed',
    endTime: safeEnd,
    timestamp: safeEnd,
  };
};

const isThoughtFinalEvent = (trace: any): boolean => {
  const state = String(trace?.state || trace?.status || '').trim().toLowerCase();
  const finishReason = String(trace?.finishReason || trace?.finish_reason || '').trim().toLowerCase();
  return trace?.final === true ||
    trace?.done === true ||
    trace?.isStreaming === false ||
    trace?.streamState === 'closed' ||
    ['completed', 'complete', 'failed', 'stopped', 'cancelled', 'canceled', 'error', 'closed'].includes(state) ||
    Boolean(finishReason && finishReason !== 'null' && finishReason !== 'undefined');
};

/** Provider stream state is authoritative; do not infer liveness from age. */
export const isThoughtStreamOpen = (trace: any): boolean => {
  if (!trace || trace.type !== 'thought_stream' || isThoughtFinalEvent(trace)) return false;
  return trace.isStreaming === true ||
    trace.streamState === 'open' ||
    trace.isLiveTyping === true;
};

/**
 * Direct Chat uses an empty UI-only thought row as a live lifecycle shell.
 * Once that shell closes it has no user-visible content and must not become a
 * historical thought card. Keep this rule shared by both feed renderers.
 */
export const shouldRenderThoughtStream = (trace: any): boolean => {
  if (!trace || trace.type !== 'thought_stream') return false;
  const text = String(trace.text || '').replace(/<\/?(?:thought|work_note)>/gi, '').trim();
  return Boolean(text) || (trace.uiOnly === true && isThoughtStreamOpen(trace));
};

const getThoughtStreamChatId = (trace: any): string => String(
  trace?.chatId || trace?.ownerChatId || ''
).trim();

const getThoughtStreamRunId = (trace: any): string => String(
  trace?.runId || trace?.turnId || trace?.originRunId || ''
).trim();

const hasThoughtStreamScope = (trace: any): boolean => Boolean(
  getThoughtStreamChatId(trace) || getThoughtStreamRunId(trace)
);

const thoughtStreamScopesMatch = (left: any, right: any): boolean => {
  if (getThoughtStreamOwner(left) !== getThoughtStreamOwner(right)) return false;

  const leftChatId = getThoughtStreamChatId(left);
  const rightChatId = getThoughtStreamChatId(right);
  if (leftChatId || rightChatId) {
    if (!leftChatId || !rightChatId || leftChatId !== rightChatId) return false;
  }

  const leftRunId = getThoughtStreamRunId(left);
  const rightRunId = getThoughtStreamRunId(right);
  if (leftRunId || rightRunId) {
    if (!leftRunId || !rightRunId || leftRunId !== rightRunId) return false;
  }

  return true;
};

/**
 * Close reasoning at a real lifecycle boundary. Provider final payloads may
 * arrive after the visible boundary; mergeThoughtStreamTrace keeps those
 * payloads in the already-closed row so the timer stays frozen and text is
 * not lost.
 */
export const closeThoughtStreamsForBoundary = (logs: any[], boundary: any): void => {
  if (!boundary || boundary.type === 'thought_stream') return;

  const closeAll = boundary.type === 'user_action' || isGlobalTerminalBoundary(boundary);
  const closeOwner = isThoughtClosingBoundary(boundary);
  if (!closeAll && !closeOwner) return;
  const boundaryOwner = getThoughtStreamOwner(boundary);
  const boundaryHasScope = hasThoughtStreamScope(boundary);
  const endedAt = getTraceTimestamp(boundary);
  const ownersClosed = new Set<string>();

  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const log = logs[index];
    if (!log) continue;
    // Lifecycle scope never crosses a user-turn boundary. A global terminal
    // event closes all owners in the current turn, not historical turns.
    if (log.type === 'user_action') break;

    const owner = getThoughtStreamOwner(log);
    if (boundary.type !== 'user_action' && boundaryHasScope && !thoughtStreamScopesMatch(log, boundary)) continue;
    if (!closeAll && owner !== boundaryOwner) continue;
    if (ownersClosed.has(owner)) continue;

    if (log.type !== 'thought_stream') continue;
    if (log.isStreaming === false || log.streamState === 'closed') continue;

    ownersClosed.add(owner);
    logs[index] = closeThoughtAt(log, endedAt);
  }
};

const findMergeableThoughtIndex = (logs: any[], incoming: any): number => {
  const owner = getThoughtStreamOwner(incoming);
  const incomingThoughtId = String(incoming?.thoughtId || '').trim();
  const incomingStart = asFiniteTimestamp(incoming?.startTime);
  const incomingIsFinal = isThoughtFinalEvent(incoming);

  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const candidate = logs[index];
    if (!candidate) continue;
    if (candidate.type === 'user_action') break;
    if (!thoughtStreamScopesMatch(candidate, incoming) || getThoughtStreamOwner(candidate) !== owner) continue;

    // Provider stream IDs (or their stable start timestamp fallback) remain
    // authoritative even when tool/answer traces are delivered in between.
    if (candidate.type !== 'thought_stream') {
      if (!incomingThoughtId && incomingStart === null) return -1;
      continue;
    }

    const existingThoughtId = String(candidate.thoughtId || '').trim();
    const existingStart = asFiniteTimestamp(candidate.startTime);
    if (incomingThoughtId) {
      if (existingThoughtId !== incomingThoughtId) continue;
    } else if (incomingStart !== null) {
      if (existingStart !== incomingStart) continue;
    } else if (existingThoughtId) {
      return -1;
    }

    const candidateIsOpen = candidate.isStreaming !== false && candidate.streamState !== 'closed';
    const repeatedFinalForSameId =
      incomingIsFinal &&
      Boolean(incomingThoughtId) &&
      incomingThoughtId === existingThoughtId;
    const lateReplayOfClosedStream =
      !candidateIsOpen &&
      isOlderThoughtUpdate(candidate, incoming);

    // A catch-up poll can deliver an older open snapshot after another path
    // has already committed the final snapshot. Treat it as an update to the
    // existing stream instead of opening a second thought row. A closed row
    // with a newer phase anchor still remains a genuinely new stream.
    return candidateIsOpen || repeatedFinalForSameId || lateReplayOfClosedStream ? index : -1;
  }

  return -1;
};

const mergeThoughtText = (existing: any, incoming: any): string =>
  mergeStreamingText(existing?.text, incoming?.text, incoming?.isDelta === true);

const getTraceIndex = (trace: any): number | null => {
  const value = Number(trace?._traceIdx);
  return Number.isFinite(value) ? value : null;
};

const isOlderThoughtUpdate = (existing: any, incoming: any): boolean => {
  const existingIndex = getTraceIndex(existing);
  const incomingIndex = getTraceIndex(incoming);
  if (existingIndex !== null && incomingIndex !== null) {
    return incomingIndex < existingIndex;
  }

  const existingTime = asFiniteTimestamp(existing?.endTime) ?? asFiniteTimestamp(existing?.timestamp);
  const incomingTime = asFiniteTimestamp(incoming?.endTime) ?? asFiniteTimestamp(incoming?.timestamp);
  return existingTime !== null && incomingTime !== null && incomingTime < existingTime;
};

const findThoughtIndexForExplicitFinal = (logs: any[], incoming: any): number => {
  const thoughtId = String(incoming?.thoughtId || '').trim();
  const owner = getThoughtStreamOwner(incoming);
  const incomingStart = asFiniteTimestamp(incoming?.startTime);
  const incomingText = String(incoming?.text || '');
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const candidate = logs[index];
    if (!candidate) continue;
    if (candidate.type === 'user_action') break;
    if (
      candidate.type === 'thought_stream' &&
      thoughtStreamScopesMatch(candidate, incoming) &&
       getThoughtStreamOwner(candidate) === owner &&
      (
        (thoughtId && String(candidate.thoughtId || '').trim() === thoughtId) ||
        (
          !thoughtId &&
          (
            (incomingStart !== null && asFiniteTimestamp(candidate.startTime) === incomingStart) ||
            (incomingText && String(candidate.text || '') === incomingText)
          )
        )
      )
    ) {
      return index;
    }
  }
  return -1;
};

const getCanonicalThoughtIdentity = (log: any): string => {
  if (log?.type !== 'thought_stream') return '';
  const owner = getThoughtStreamOwner(log);
  const chatIdentity = getThoughtStreamChatId(log);
  const runIdentity = getThoughtStreamRunId(log);
  const thoughtId = String(log?.thoughtId || '').trim();
  const start = asFiniteTimestamp(log?.startTime);
  // Without a phase anchor we cannot safely distinguish two real thoughts
  // that happen to contain the same text, so leave that record untouched.
  if (!thoughtId && start === null) return '';
  return `${ chatIdentity || 'legacy-chat' }::${ runIdentity || 'legacy-run' }::${ owner }::${ thoughtId || 'start' }::${ start ?? '' }`;
};

const mergeCanonicalThought = (existing: any, incoming: any): any => {
  const incomingIsOlder = isOlderThoughtUpdate(existing, incoming);
  const existingIsClosed = existing?.isStreaming === false || existing?.streamState === 'closed';
  const incomingIsOpen = !isThoughtFinalEvent(incoming);
  const previousText = String(existing?.text || '');
  const incomingText = String(incoming?.text || '');
  const incomingEnd = getThoughtUpdateTimestamp(incoming);
  const existingEnd = asFiniteTimestamp(existing?.endTime) ?? asFiniteTimestamp(existing?.timestamp);
  const preserveExistingState = existingIsClosed || incomingIsOlder;
  const preferred = preserveExistingState
    ? existing
    : { ...existing, ...incoming };

  return {
    ...preferred,
    // Thought payloads are cumulative snapshots. Keep the longest snapshot
    // when recovery delivers an older or shorter copy after the final one.
    text: incomingText.length >= previousText.length ? incomingText : previousText,
    startTime: asFiniteTimestamp(existing?.startTime) ?? asFiniteTimestamp(incoming?.startTime) ?? incomingEnd,
    endTime: preserveExistingState && existingEnd !== null
      ? existingEnd
      : Math.max(existingEnd ?? incomingEnd, incomingEnd),
    timestamp: preserveExistingState && existingEnd !== null
      ? existingEnd
      : Math.max(asFiniteTimestamp(existing?.timestamp) ?? incomingEnd, incomingEnd),
    isStreaming: existingIsClosed
      ? false
      : incomingIsOlder
        ? existing?.isStreaming === true
        : incomingIsOpen,
    streamState: existingIsClosed
      ? 'closed'
      : incomingIsOlder
        ? existing?.streamState || (existing?.isStreaming === true ? 'open' : 'closed')
        : incomingIsOpen ? 'open' : 'closed',
  };
};

/**
 * Collapse duplicate thought snapshots already present in a trace list.
 * This is ingestion normalization, not a UI visibility filter: the returned
 * list is the canonical lifecycle state used by persistence and rendering.
 */
export const canonicalizeThoughtStreamLogs = (logs: any[]): any[] => {
  const source = Array.isArray(logs) ? logs : [];
  const canonical: any[] = [];
  const thoughtIndexes = new Map<string, number>();

  for (const log of source) {
    if (
      log?.type === 'thought_stream' &&
      log?.uiOnly === true &&
      !String(log.text || '').trim() &&
      !isThoughtStreamOpen(log)
    ) continue;
    if (log?.type === 'user_action') thoughtIndexes.clear();
    const identity = getCanonicalThoughtIdentity(log);
    if (!identity) {
      canonical.push(log);
      continue;
    }

    const existingIndex = thoughtIndexes.get(identity);
    if (existingIndex === undefined) {
      thoughtIndexes.set(identity, canonical.length);
      canonical.push(log);
      continue;
    }

    canonical[existingIndex] = mergeCanonicalThought(canonical[existingIndex], log);
  }

  return canonical;
};

/**
 * Merge a provider-neutral thought event into only the currently open stream.
 * Providers may send cumulative text or deltas and may omit/reuse stream IDs.
 */
export const mergeThoughtStreamTrace = (logs: any[], incoming: any): number => {
  const canonical = canonicalizeThoughtStreamLogs(logs);
  if (canonical.length !== logs.length || canonical.some((log, index) => log !== logs[index])) {
    logs.splice(0, logs.length, ...canonical);
  }
  const incomingIsFinal = isThoughtFinalEvent(incoming);
  const explicitFinalIndex = incomingIsFinal
    ? findThoughtIndexForExplicitFinal(logs, incoming)
    : -1;

  // Providers can send the explicit end marker after answer/tool chunks. The
  // boundary already froze the timer, so acknowledge the close in place and do
  // not append a duplicate or extend reasoning time through visible output.
  if (explicitFinalIndex >= 0) {
    const existing = logs[explicitFinalIndex];
    const incomingEnd = getThoughtUpdateTimestamp(incoming);
    const existingEnd = asFiniteTimestamp(existing?.endTime) ?? asFiniteTimestamp(existing?.timestamp);
    const existingWasClosed = existing?.isStreaming === false || existing?.streamState === 'closed';
    // A late provider close is text reconciliation only. Once a tool/answer
    // boundary froze this row, its timer must never include delivery latency
    // after that boundary.
    const finalEnd = existingWasClosed
      ? existingEnd ?? incomingEnd
      : existingEnd === null ? incomingEnd : Math.max(existingEnd, incomingEnd);
    logs[explicitFinalIndex] = {
      ...existing,
      ...incoming,
      text: mergeThoughtText(existing, incoming),
      startTime: asFiniteTimestamp(existing?.startTime) ?? asFiniteTimestamp(incoming?.startTime) ?? finalEnd,
      endTime: finalEnd,
      timestamp: finalEnd,
      isStreaming: false,
      streamState: 'closed',
    };
    return explicitFinalIndex;
  }

  const mergeIndex = findMergeableThoughtIndex(logs, incoming);
  const incomingIsOpen = !isThoughtFinalEvent(incoming);
  const incomingEnd = getThoughtUpdateTimestamp(incoming);

  if (mergeIndex >= 0) {
    const existing = logs[mergeIndex];
    if (!incomingIsFinal && isOlderThoughtUpdate(existing, incoming)) return mergeIndex;
    logs[mergeIndex] = {
      ...existing,
      ...incoming,
      text: mergeThoughtText(existing, incoming),
      startTime: asFiniteTimestamp(existing?.startTime) ?? asFiniteTimestamp(incoming?.startTime) ?? incomingEnd,
      endTime: Math.max(asFiniteTimestamp(existing?.endTime) ?? incomingEnd, incomingEnd),
      timestamp: Math.max(asFiniteTimestamp(existing?.timestamp) ?? incomingEnd, incomingEnd),
      isStreaming: incomingIsOpen,
      streamState: incomingIsOpen ? 'open' : 'closed',
    };
    return mergeIndex;
  }

  // A genuinely new thought supersedes an unclosed stream from the same owner.
  const startedAt = asFiniteTimestamp(incoming?.startTime) ?? incomingEnd;
  closeThoughtStreamsForBoundary(logs, {
    type: 'thought_stream_boundary',
    subAgentChatId: incoming?.subAgentChatId,
    subAgentId: incoming?.subAgentId,
    subAgent: incoming?.subAgent,
    agentName: incoming?.agentName,
    chatId: incoming?.chatId,
    ownerChatId: incoming?.ownerChatId,
    runId: incoming?.runId,
    turnId: incoming?.turnId,
    startTime: startedAt,
    timestamp: startedAt,
    endTime: startedAt,
  });

  logs.push({
    ...incoming,
    type: 'thought_stream',
    startTime: startedAt,
    endTime: Math.max(startedAt, incomingEnd),
    timestamp: Math.max(startedAt, incomingEnd),
    isStreaming: incomingIsOpen,
    streamState: incomingIsOpen ? 'open' : 'closed',
  });
  return logs.length - 1;
};
