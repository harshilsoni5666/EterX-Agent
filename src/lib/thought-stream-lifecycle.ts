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

/**
 * Close reasoning only at a real lifecycle boundary. Ordinary tool, answer,
 * note, and status traces are allowed to interleave with provider reasoning;
 * treating them as an implicit end is what caused counters to stop early.
 */
export const closeThoughtStreamsForBoundary = (logs: any[], boundary: any): void => {
  if (!boundary || boundary.type === 'thought_stream') return;

  const closeAll = boundary.type === 'user_action' || isGlobalTerminalBoundary(boundary);
  const closeOwner = boundary.type === 'thought_stream_boundary';
  if (!closeAll && !closeOwner) return;
  const boundaryOwner = getThoughtStreamOwner(boundary);
  const endedAt = getTraceTimestamp(boundary);
  const ownersClosed = new Set<string>();

  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const log = logs[index];
    if (!log) continue;
    // Lifecycle scope never crosses a user-turn boundary. A global terminal
    // event closes all owners in the current turn, not historical turns.
    if (log.type === 'user_action') break;

    const owner = getThoughtStreamOwner(log);
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
  const incomingIsFinal = incoming?.isStreaming === false || incoming?.streamState === 'closed';

  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const candidate = logs[index];
    if (!candidate) continue;
    if (candidate.type === 'user_action') break;
    if (getThoughtStreamOwner(candidate) !== owner) continue;

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

    return candidateIsOpen || repeatedFinalForSameId ? index : -1;
  }

  return -1;
};

const mergeThoughtText = (existing: any, incoming: any): string => {
  const nextText = String(incoming?.text || '');
  if (incoming?.isDelta !== true) return nextText;

  const previousText = String(existing?.text || '');
  if (!nextText || previousText.endsWith(nextText)) return previousText;
  return previousText + nextText;
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

/**
 * Merge a provider-neutral thought event into only the currently open stream.
 * Providers may send cumulative text or deltas and may omit/reuse stream IDs.
 */
export const mergeThoughtStreamTrace = (logs: any[], incoming: any): number => {
  const incomingIsFinal = incoming?.isStreaming === false || incoming?.streamState === 'closed';
  const explicitFinalIndex = incomingIsFinal
    ? findThoughtIndexForExplicitFinal(logs, incoming)
    : -1;

  // Providers can send the explicit end marker after answer/tool chunks. The
  // boundary already froze the timer, so acknowledge the close in place and do
  // not append a duplicate or extend reasoning time through visible output.
  if (explicitFinalIndex >= 0) {
    const existing = logs[explicitFinalIndex];
    const existingWasClosed = existing?.isStreaming === false || existing?.streamState === 'closed';
    const incomingEnd = getThoughtUpdateTimestamp(incoming);
    const finalEnd = existingWasClosed
      ? asFiniteTimestamp(existing?.endTime) ?? incomingEnd
      : incomingEnd;
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
  const incomingIsOpen = incoming?.isStreaming !== false && incoming?.streamState !== 'closed';
  const incomingEnd = getThoughtUpdateTimestamp(incoming);

  if (mergeIndex >= 0) {
    const existing = logs[mergeIndex];
    logs[mergeIndex] = {
      ...existing,
      ...incoming,
      text: mergeThoughtText(existing, incoming),
      startTime: asFiniteTimestamp(existing?.startTime) ?? asFiniteTimestamp(incoming?.startTime) ?? incomingEnd,
      endTime: incomingEnd,
      timestamp: incomingEnd,
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
