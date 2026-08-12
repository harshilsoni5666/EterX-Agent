const TERMINAL_WORK_STATUSES = new Set([
  'completed',
  'complete',
  'failed',
  'stopped',
  'cancelled',
  'canceled',
  'error',
]);

const TERMINAL_WORK_TYPES = new Set([
  'done',
  'error',
]);

const TERMINAL_WORK_TEXT =
  /(?:generation stopped by user|agent stopped(?:\s*:|\b)|agent connection (?:failed|did not start)|agent start failed|custom agent (?:start|connection) failed)/i;

/**
 * Suppress only commentary about the work-note protocol itself. Natural
 * first-person intent is valid user-facing progress and must stay visible.
 */
export const isInternalWorkNoteNoise = (value: unknown): boolean => {
  const text = String(value || '').trim();
  if (!text || text.length < 4) return true;
  return /\b(?:work note|timeline note|status line)\b/i.test(text) &&
    /\b(?:workspace|external|prompt|rule|communication style|phase change|highly professional)\b/i.test(text);
};

/**
 * Returns true only for traces that conclusively end the current main-agent
 * turn. Tool/sub-agent errors are intentionally not inferred from arbitrary
 * text, because the main agent can recover from those.
 */
export const isTerminalWorkTrace = (log: any): boolean => {
  if (!log) return false;

  const agentName = String(log.agentName || '').trim().toLowerCase();
  const isMainAgentTrace = !log.subAgent &&
    !log.subAgentId &&
    !log.subAgentChatId &&
    !log.terminalTask &&
    (!agentName || agentName === 'main');
  const status = String(log.status || '').trim().toLowerCase();
  if (
    TERMINAL_WORK_STATUSES.has(status) &&
    isMainAgentTrace &&
    (log.mainTurnTerminal === true || ['done', 'error', 'agent_status', 'run_status'].includes(String(log.type || '').toLowerCase()))
  ) return true;

  const type = String(log.type || '').trim().toLowerCase();
  if (TERMINAL_WORK_TYPES.has(type) && isMainAgentTrace) return true;

  const text = String(log.text || log.message || '').trim();
  return isMainAgentTrace && TERMINAL_WORK_TEXT.test(text);
};

/**
 * The server's running flag can briefly lag behind the trace stream. A final
 * answer or any terminal trace in this turn wins over that stale flag, even if
 * a late cleanup trace was appended after the terminal event.
 */
export const isTurnWorkActive = (
  running: boolean,
  hasFinalAnswer: boolean,
  turnLogs: any[],
): boolean => {
  if (!running || hasFinalAnswer) return false;
  return !turnLogs.some(isTerminalWorkTrace);
};

/**
 * Keep simple sends and direct answers visually quiet. The expandable work
 * sequence begins only after the agent has produced a real workflow action.
 */
export const shouldShowWorkflowSequence = (stepCount: number): boolean =>
  Number.isFinite(stepCount) && stepCount > 0;

/**
 * Context compaction is a replace-in-place lifecycle. Only the newest phase
 * for a transaction is renderable. Unterminated starts/retries disappear when
 * the turn settles, and a later real work event proves an orphaned start is no
 * longer active.
 */
export const shouldRenderContextCompactionEvent = (
  log: any,
  index: number,
  logs: any[],
  isThinkingTurn: boolean,
): boolean => {
  if (log?.type !== 'context_compaction') return true;
  const compactionId = String(log.compactionId || '');
  const latestIndex = logs.reduce(
    (found, candidate, candidateIndex) =>
      candidate?.type === 'context_compaction' &&
      String(candidate.compactionId || '') === compactionId
        ? candidateIndex
        : found,
    -1,
  );
  if (latestIndex !== index) return false;
  if (log.phase === 'retrying' && !isThinkingTurn) return false;
  if (log.phase !== 'compacting') return true;
  if (!isThinkingTurn) return false;
  return !logs.slice(index + 1).some(candidate =>
    candidate?.type !== 'context_usage' &&
    candidate?.type !== 'context_compaction'
  );
};

type TimelineEntry = {
  log: any;
  sourceIndex: number;
  boundaryIndex: number;
};

const timelineIdentity = (log: any): string => String(
  log?.turnId || log?.runId || ''
).trim();

const timelineTraceIndex = (log: any): number | null => {
  const value = Number(log?._traceIdx);
  return Number.isFinite(value) ? value : null;
};

const timelineTimestamp = (log: any): number | null => {
  const value = Number(log?.startTime ?? log?.timestamp ?? log?.endTime);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const compareTimelineEntries = (left: TimelineEntry, right: TimelineEntry): number => {
  const leftIndex = timelineTraceIndex(left.log);
  const rightIndex = timelineTraceIndex(right.log);
  if (leftIndex !== null && rightIndex !== null && leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }

  const leftTime = timelineTimestamp(left.log);
  const rightTime = timelineTimestamp(right.log);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  // Unindexed optimistic/live rows must retain transport order relative to
  // another unindexed row. They do not have enough information to be safely
  // placed by timestamp alone.
  return left.sourceIndex - right.sourceIndex;
};

const compareTimelinePositions = (left: any, right: any): number => {
  const leftIndex = timelineTraceIndex(left);
  const rightIndex = timelineTraceIndex(right);
  if (leftIndex !== null && rightIndex !== null && leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }
  const leftTime = timelineTimestamp(left);
  const rightTime = timelineTimestamp(right);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return 0;
};

/**
 * Sub-agent events are transported with a mixture of a full child-chat ID,
 * the short run ID, and (for older traces) only the agent name. Return all
 * stable aliases so the roster, tabs, and feed use the same ownership rules.
 */
export const getAgentIdentityAliases = (value: any): Set<string> => {
  const aliases = new Set<string>();
  const add = (candidate: unknown) => {
    const normalized = String(candidate || '').trim().toLowerCase();
    if (!normalized) return;
    aliases.add(normalized);
    const marker = '::sub-agent::';
    const markerIndex = normalized.lastIndexOf(marker);
    if (markerIndex >= 0) {
      const shortId = normalized.slice(markerIndex + marker.length).trim();
      if (shortId) aliases.add(shortId);
    }
  };

  if (typeof value === 'string') add(value);
  else if (value && typeof value === 'object') {
    add(value.id);
    add(value.subAgentChatId);
    add(value.subAgentId);
    add(value.agentId);
    add(value.agentName);
    add(value.subAgent);
    add(value.name);
  }
  return aliases;
};

export const agentIdentitiesOverlap = (left: any, right: any): boolean => {
  const strongAliases = (value: any): Set<string> => {
    if (typeof value === 'string') return getAgentIdentityAliases(value);
    if (!value || typeof value !== 'object') return new Set();
    // Timeline/message `id` values identify the event, not its worker. Roster
    // entries have no event type, while full child-chat IDs are self-describing.
    const objectId = String(value.id || '').trim();
    const rosterId = !value.type || objectId.includes('::sub-agent::')
      ? objectId
      : undefined;
    return getAgentIdentityAliases({
      id: rosterId,
      subAgentChatId: value.subAgentChatId,
      subAgentId: value.subAgentId,
      agentId: value.agentId,
    });
  };
  const leftStrong = strongAliases(left);
  const rightStrong = strongAliases(right);
  if (leftStrong.size > 0 && rightStrong.size > 0) {
    return [...leftStrong].some(alias => rightStrong.has(alias));
  }
  const leftAliases = getAgentIdentityAliases(left);
  const rightAliases = getAgentIdentityAliases(right);
  return [...leftAliases].some(alias => rightAliases.has(alias));
};

/**
 * Restore trace order after polling/reconnects deliver an older event late.
 *
 * Trace indices are scoped to a server run, so sorting the whole conversation
 * by `_traceIdx` would scramble historical turns. First partition by the
 * visible user boundary that owns each trace, then order only within that
 * boundary. This keeps actions, thought updates, and answer snapshots in one
 * deterministic turn without letting a late event leak into the newest turn.
 */
export const orderFeedTimelineLogs = (logs: any[]): any[] => {
  const source = Array.isArray(logs) ? logs : [];
  if (source.length < 2) return source.slice();

  const boundaries = source
    .map((log, sourceIndex) => ({ log, sourceIndex }))
    .filter(entry => entry.log?.type === 'user_action');

  if (boundaries.length === 0) {
    return source
      .map((log, sourceIndex) => ({ log, sourceIndex, boundaryIndex: 0 }))
      .sort(compareTimelineEntries)
      .map(entry => entry.log);
  }

  const boundaryEntries: TimelineEntry[] = boundaries.map((entry, boundaryIndex) => ({
    log: entry.log,
    sourceIndex: entry.sourceIndex,
    boundaryIndex,
  }));
  const entriesByBoundary = boundaryEntries.map(entry => [entry] as TimelineEntry[]);
  const preamble: TimelineEntry[] = [];

  const findOwnerBoundary = (log: any, sourceIndex: number): number => {
    const identity = timelineIdentity(log);
    if (!identity) return -1;

    const exactTurnMatches = boundaryEntries.filter(boundary =>
      String(boundary.log?.turnId || '').trim() === String(log?.turnId || '').trim() &&
      String(log?.turnId || '').trim() !== '' &&
      timelineIdentity(boundary.log) === identity
    );
    if (exactTurnMatches.length > 0) {
      if (exactTurnMatches.length === 1) return exactTurnMatches[0].boundaryIndex;
      const preceding = exactTurnMatches.filter(boundary =>
        compareTimelinePositions(boundary.log, log) <= 0
      );
      return (preceding.length > 0 ? preceding : exactTurnMatches)[
        (preceding.length > 0 ? preceding : exactTurnMatches).length - 1
      ].boundaryIndex;
    }

    const runMatches = boundaryEntries.filter(boundary => timelineIdentity(boundary.log) === identity);
    if (runMatches.length === 0) return -1;
    if (runMatches.length === 1) return runMatches[0].boundaryIndex;

    // Proxy-backed runs can contain multiple user boundaries under one run
    // ID. Use the trace/timestamp position to select the most recent boundary
    // that precedes this event; otherwise transport order wins.
    const preceding = runMatches.filter(boundary => compareTimelinePositions(boundary.log, log) <= 0);
    return (preceding.length > 0 ? preceding : runMatches)[
      (preceding.length > 0 ? preceding : runMatches).length - 1
    ].boundaryIndex;
  };

  source.forEach((log, sourceIndex) => {
    if (!log || log.type === 'user_action') return;
    const boundaryIndex = findOwnerBoundary(log, sourceIndex);
    const entry = { log, sourceIndex, boundaryIndex };
    if (boundaryIndex >= 0) entriesByBoundary[boundaryIndex].push(entry);
    else if (sourceIndex < boundaryEntries[0].sourceIndex) preamble.push(entry);
    else {
      // Truly unscoped helper rows stay with their original neighboring turn.
      // They are not safe to move across a user boundary.
      const nearestBoundary = boundaryEntries.reduce((nearest, boundary) =>
        boundary.sourceIndex <= sourceIndex ? boundary : nearest,
      boundaryEntries[0]);
      entriesByBoundary[nearestBoundary.boundaryIndex].push(entry);
    }
  });

  const orderedBoundaryEntries = boundaryEntries.slice().sort((left, right) => {
    const sameIdentity = Boolean(timelineIdentity(left.log)) &&
      timelineIdentity(left.log) === timelineIdentity(right.log);
    if (sameIdentity) return compareTimelineEntries(left, right);

    const leftTime = timelineTimestamp(left.log);
    const rightTime = timelineTimestamp(right.log);
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.sourceIndex - right.sourceIndex;
  });

  const ordered: any[] = [...preamble.sort(compareTimelineEntries).map(entry => entry.log)];
  orderedBoundaryEntries.forEach(boundaryEntry => {
    const entries = entriesByBoundary[boundaryEntry.boundaryIndex];
    const boundary = entries[0];
    const rest = entries.slice(1).sort(compareTimelineEntries);
    ordered.push(boundary.log, ...rest.map(entry => entry.log));
  });
  return ordered;
};
