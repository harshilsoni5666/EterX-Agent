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
 * Provider/runtime progress telemetry is useful for diagnostics, but it is
 * not useful conversation content. Tool-loop iteration counters used to
 * become full-width timeline rows in Agent Builder and made one real action
 * look like several separate phases.
 */
export const isInternalProgressNoise = (value: unknown): boolean => {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return false;

  // Initial runner status is already represented by the live Working pill.
  // Keeping it as a second narrative row creates a duplicated "thinking"
  // state, especially in Agent Builder where status events become work notes.
  if (/^.+\s+is thinking\.{0,3}$/i.test(text)) return true;

  return /^(?:(?:.+?)\s+)?(?:processed\s+\d+\s+tool\s+calls?(?:\s*\(\s*iteration\s+\d+\s*\/\s*\d+\s*\))?|tool\s+calls?\s+processed(?:\s*\(\s*iteration\s+\d+\s*\/\s*\d+\s*\))?|iteration\s+\d+\s*\/\s*\d+)\.?$/i.test(text);
};

/** Return false only for progress events that should stay out of the feed. */
export const shouldRenderProgressTrace = (log: any): boolean => {
  if (!log || !['progress', 'status', 'work_note'].includes(String(log.type || ''))) return true;
  return !isInternalProgressNoise(log.text) && !isInternalProgressNoise(log.secondary);
};

/**
 * Returns true only for traces that conclusively end the current main-agent
 * turn. Tool/sub-agent errors are intentionally not inferred from arbitrary
 * text, because the main agent can recover from those.
 */
export const isTerminalWorkTrace = (log: any): boolean => {
  if (!log) return false;

  const type = String(log.type || '').trim().toLowerCase();
  const explicitChildTrace = /^sub_agent_|^inter_agent_/.test(type) ||
    Boolean(log.subAgent || log.subAgentId || log.subAgentChatId || log.terminalTask);
  const isMainAgentTrace = !log.subAgent &&
    !log.subAgentId &&
    !log.subAgentChatId &&
    !log.terminalTask &&
    !explicitChildTrace;
  const status = String(log.status || '').trim().toLowerCase();
  if (
    TERMINAL_WORK_STATUSES.has(status) &&
    isMainAgentTrace &&
    (log.mainTurnTerminal === true || ['done', 'error', 'agent_status', 'run_status'].includes(String(log.type || '').toLowerCase()))
  ) return true;

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

const timelineIdentityAliases = (log: any): string[] => Array.from(new Set(
  [log?.turnId, log?.runId]
    .map(value => String(value || '').trim())
    .filter(Boolean)
));

const timelineIdentity = (log: any): string => timelineIdentityAliases(log)[0] || '';

const normalizedTimelineType = (log: any): string =>
  String(log?.type || '').trim().toLowerCase() === 'tool_call'
    ? 'command'
    : String(log?.type || '').trim().toLowerCase();

const timelineContentSignature = (log: any): string => String(
  log?.text ?? log?.question ?? log?.command ?? log?.output ?? log?.secondary ?? ''
).replace(/\s+/g, ' ').trim().slice(0, 320);

const timelineStableKey = (log: any): string => {
  const type = normalizedTimelineType(log);
  const scope = String(log?.turnId || log?.runId || '').trim();
  if (!type) return '';
  if (type === 'user_action') {
    const stableId = String(log?.id || '').trim();
    return stableId
      ? `user:${ scope }:${ stableId }`
      : `user:${ scope }:${ String(log?.source || 'human') }:${ timelineContentSignature(log) }`;
  }
  const stableId = String(
    log?.toolCallId ??
    log?.streamId ??
    log?.noteId ??
    log?.thoughtId ??
    log?.answerId ??
    log?.traceId ??
    log?.responseKey ??
    log?.messageId ??
    log?.id ??
    ''
  ).trim();
  if (stableId) return `trace:${ scope }:${ type }:${ stableId }`;
  const traceIndex = timelineTraceIndex(log);
  if (traceIndex !== null) return `trace:${ scope }:${ type }:index:${ traceIndex }`;
  const timestamp = timelineTimestamp(log);
  return timestamp !== null
    ? `trace:${ scope }:${ type }:time:${ timestamp }:${ timelineContentSignature(log) }`
    : '';
};

const mergeTimelineTrace = (previous: any, incoming: any): any => {
  const terminalStatuses = new Set(['completed', 'complete', 'done', 'success', 'failed', 'error', 'stopped', 'cancelled', 'canceled', 'closed']);
  const previousClosed = previous?.final === true || previous?.done === true || previous?.isStreaming === false ||
    previous?.streamState === 'closed' || terminalStatuses.has(String(previous?.status || '').toLowerCase());
  const incomingOpen = incoming?.isStreaming === true || incoming?.isLiveTyping === true || incoming?.streamState === 'open' ||
    ['running', 'working', 'pending', 'streaming'].includes(String(incoming?.status || '').toLowerCase());
  const previousText = String(previous?.text || '');
  const incomingText = String(incoming?.text || '');
  const previousOutput = String(previous?.output || '');
  const incomingOutput = String(incoming?.output || '');
  const preserveSettledLifecycle = previousClosed && incomingOpen;
  const previousStatus = String(previous?.status || '').trim().toLowerCase();
  const settledStatus = ['running', 'working', 'pending', 'streaming', 'spawning'].includes(previousStatus)
    ? 'completed'
    : previous?.status;

  return {
    ...previous,
    ...incoming,
    text: incomingText.length >= previousText.length ? incoming.text : previous.text,
    ...(previousOutput || incomingOutput
      ? { output: incomingOutput.length >= previousOutput.length ? incoming.output : previous.output }
      : {}),
    startTime: previous?.startTime || previous?.timestamp || incoming?.startTime || incoming?.timestamp,
    ...(preserveSettledLifecycle ? {
      isStreaming: false,
      isLiveTyping: false,
      isLive: false,
      streamState: 'closed',
      status: settledStatus,
      final: previous?.final,
      done: previous?.done,
      endTime: previous?.endTime || previous?.timestamp || incoming?.endTime,
      timestamp: previous?.timestamp || previous?.endTime || incoming?.timestamp,
    } : {}),
  };
};

const RECOVERABLE_MAIN_RUN_TYPES = new Set([
  'model_selection',
  'thought_stream',
  'work_note',
  'command',
  'exploration',
  'file_edit',
  'progress',
  'browser',
  'communication',
  'ask_user',
  'context_compaction',
  'answer',
  'done',
  'error',
  'agent_status',
  'run_status',
]);

const isMainRunTrace = (log: any): boolean => {
  const type = normalizedTimelineType(log);
  return !log?.subAgent &&
    !log?.subAgentId &&
    !log?.subAgentChatId &&
    !log?.terminalTask &&
    !/^sub_agent_|^inter_agent_/.test(type);
};

const LIVE_LIFECYCLE_TYPES = new Set([
  'thought_stream',
  'work_note',
  'command',
  'tool_call',
  'exploration',
  'file_edit',
  'progress',
  'browser',
  'communication',
  'console_output',
  'sub_agent_action',
]);

const ACTIVE_LIFECYCLE_STATUSES = new Set(['running', 'working', 'pending', 'streaming', 'spawning']);
const SUB_AGENT_TERMINAL_TYPES = new Set([
  'sub_agent_answer',
  'sub_agent_result',
  'sub_agent_complete',
  'sub_agent_error',
  'sub_agent_close',
]);

const subAgentLifecycleIdentity = (log: any): string => String(
  log?.subAgentChatId || log?.subAgentId || log?.agentId || log?.subAgent || log?.agentName || ''
).trim().toLowerCase();

const isOpenLifecycleTrace = (log: any): boolean => Boolean(
  LIVE_LIFECYCLE_TYPES.has(normalizedTimelineType(log)) && (
    log?.isLive === true ||
    log?.isStreaming === true ||
    log?.isLiveTyping === true ||
    log?.streamState === 'open' ||
    ACTIVE_LIFECYCLE_STATUSES.has(String(log?.status || log?.agentStatus || '').trim().toLowerCase())
  )
);

const settleLifecycleTrace = (log: any, endedAt: number, status = 'completed'): any => {
  if (!isOpenLifecycleTrace(log)) return log;
  const startedAt = timelineTimestamp(log);
  const existingEnd = (() => {
    const value = Number(log?.endTime);
    if (!Number.isFinite(value) || value <= 0) return null;
    let normalized = value;
    while (normalized > 10_000_000_000_000) normalized /= 1000;
    if (normalized < 10_000_000_000) normalized *= 1000;
    return normalized;
  })();
  const safeEnd = existingEnd !== null &&
    (!startedAt || existingEnd >= startedAt) &&
    existingEnd <= endedAt
      ? existingEnd
      : Math.max(startedAt || 1, endedAt);
  return {
    ...log,
    isLive: false,
    isStreaming: false,
    isLiveTyping: false,
    streamState: 'closed',
    status: status === 'error' ? 'error' : 'completed',
    endTime: safeEnd,
  };
};

/**
 * Freeze stale live rows at the event that actually ended their lifecycle.
 * Reconnect snapshots can arrive out of order and otherwise revive an old
 * command, thought, or delegated worker after it already completed.
 */
export const settleFeedTraceLifecycles = (logs: any[]): any[] => {
  const source = Array.isArray(logs) ? logs : [];
  if (source.length === 0) return [];
  const settled = source.map(log => {
    if (
      log?.type !== 'work_note' ||
      log?._streamingCancelled !== true ||
      !String(log?.text || '').trim() ||
      isInternalWorkNoteNoise(log?.text)
    ) return log;

    // Cancellation closes a provisional note; it does not retract words the
    // agent already presented to the user. Some providers never send the
    // replacement/final note after this event, which previously made the
    // first meaningful update disappear before the first tool action.
    const cancelledAt = timelineTimestamp({
      timestamp: log?._cancelledAt ?? log?.endTime ?? log?.timestamp,
    });
    return {
      ...log,
      isLive: false,
      isStreaming: false,
      isLiveTyping: false,
      streamState: 'closed',
      status: 'completed',
      ...(cancelledAt !== null ? { endTime: cancelledAt } : {}),
      _streamingCancelled: undefined,
      _cancelTraceIdx: undefined,
      _cancelledAt: undefined,
    };
  });
  let turnStart = 0;

  const settleMainRange = (endExclusive: number, endedAt: number, status = 'completed') => {
    for (let index = turnStart; index < endExclusive; index += 1) {
      if (!isMainRunTrace(settled[index])) continue;
      settled[index] = settleLifecycleTrace(settled[index], endedAt, status);
    }
  };

  source.forEach((log, index) => {
    if (!log) return;
    const type = normalizedTimelineType(log);
    const eventAt = timelineTimestamp(log) || Date.now();

    if (type === 'user_action') {
      if (index > turnStart) settleMainRange(index, Math.max(1, eventAt - 1));
      turnStart = index + 1;
      return;
    }

    if (SUB_AGENT_TERMINAL_TYPES.has(type)) {
      const identity = subAgentLifecycleIdentity(log);
      if (identity) {
        const terminalStatus = type === 'sub_agent_error' ? 'error' : 'completed';
        for (let priorIndex = turnStart; priorIndex < index; priorIndex += 1) {
          if (subAgentLifecycleIdentity(settled[priorIndex]) !== identity) continue;
          settled[priorIndex] = settleLifecycleTrace(settled[priorIndex], eventAt, terminalStatus);
        }
      }
    }

    const settledAnswer = type === 'answer' &&
      String(log?.text || '').trim().length > 0 &&
      log?.isStreaming !== true &&
      log?.isLiveTyping !== true &&
      log?.streamState !== 'open';
    if (settledAnswer || isTerminalWorkTrace(log)) {
      const terminalStatus = type === 'error' || ['failed', 'error', 'stopped', 'cancelled', 'canceled'].includes(
        String(log?.status || '').trim().toLowerCase(),
      ) ? 'error' : 'completed';
      settleMainRange(index, eventAt, terminalStatus);
    }
  });

  return settled;
};

/**
 * Recover a presentation boundary when an older/stale chat snapshot retained
 * a run's actions but lost its opening user_action. Without this boundary the
 * feed treats those real actions as an orphan preamble and hides them.
 */
export interface RecoveredUserRequest {
  text: string;
  timestamp?: number;
}

const normalizedRequestText = (value: unknown): string => String(value || '')
  .replace(/^\s*\[USER REQUEST\]\s*(?:\r?\n)?/i, '')
  .trim();

const normalizedRequestTimestamp = (value: unknown): number | null =>
  timelineTimestamp({ timestamp: value });

export const recoverMissingUserTurnBoundaries = (
  logs: any[],
  recoveredRequests: RecoveredUserRequest[] = [],
): any[] => {
  const source = Array.isArray(logs) ? logs : [];
  if (source.length === 0) return [];

  const requests = (Array.isArray(recoveredRequests) ? recoveredRequests : [])
    .map((request, index) => ({
      index,
      text: normalizedRequestText(request?.text),
      timestamp: normalizedRequestTimestamp(request?.timestamp),
    }))
    .filter(request => Boolean(request.text))
    .sort((left, right) => {
      if (left.timestamp !== null && right.timestamp !== null) return left.timestamp - right.timestamp;
      if (left.timestamp !== null) return -1;
      if (right.timestamp !== null) return 1;
      return left.index - right.index;
    });
  const usedRequestIndexes = new Set<number>();
  const requestDistance = (request: typeof requests[number], log: any): number => {
    const logAt = timelineTimestamp(log);
    if (request.timestamp === null || logAt === null) return Number.MAX_SAFE_INTEGER;
    return Math.abs(request.timestamp - logAt);
  };
  const claimRequest = (log: any, preferText = '') => {
    const normalizedPreferredText = normalizedRequestText(preferText).toLowerCase();
    let best: typeof requests[number] | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const request of requests) {
      if (usedRequestIndexes.has(request.index)) continue;
      const exactText = Boolean(
        normalizedPreferredText && request.text.toLowerCase() === normalizedPreferredText,
      );
      const distance = requestDistance(request, log);
      const score = (exactText ? 0 : 1_000_000_000_000_000) + distance;
      if (score < bestScore) {
        best = request;
        bestScore = score;
      }
    }
    if (!best) return null;
    usedRequestIndexes.add(best.index);
    return best;
  };

  // Reserve durable requests already represented by genuine boundaries so a
  // missing older run cannot borrow a later prompt merely because it is close
  // in time. Existing synthetic boundaries are rehydrated in the next pass.
  const reservedRequestsByBoundary = new Map<number, typeof requests[number]>();
  source.forEach((log, index) => {
    if (log?.type !== 'user_action' || log?._recoveredBoundary === true) return;
    const request = claimRequest(log, log.text);
    if (request) reservedRequestsByBoundary.set(index, request);
  });

  const hydratedSource = source.map((log, index) => {
    if (
      log?.type === 'user_action' &&
      log?._recoveredBoundary !== true &&
      !normalizedRequestText(log.text)
    ) {
      const request = reservedRequestsByBoundary.get(index);
      return request
        ? { ...log, text: request.text, source: log.source || 'human' }
        : log;
    }
    if (log?.type !== 'user_action' || log?._recoveredBoundary !== true) return log;
    if (log?._recoveredExactText === true && normalizedRequestText(log.text)) return log;
    const request = claimRequest(log);
    if (!request) {
      return {
        ...log,
        text: '',
        source: 'recovered',
        _recoveredExactText: undefined,
        _hiddenRecoveredBoundary: true,
      };
    }
    return {
      ...log,
      text: request.text,
      source: 'human',
      _recoveredExactText: true,
      _hiddenRecoveredBoundary: undefined,
    };
  });

  const boundaryTurnIds = new Set<string>();
  const boundaryRunIds = new Set<string>();
  hydratedSource.forEach(log => {
    if (log?.type !== 'user_action') return;
    const turnId = String(log?.turnId || '').trim();
    const runId = String(log?.runId || '').trim();
    if (turnId) boundaryTurnIds.add(turnId);
    if (runId) boundaryRunIds.add(runId);
  });

  const candidates = new Map<string, { firstIndex: number; firstLog: any; qualifies: boolean }>();
  hydratedSource.forEach((log, index) => {
    if (!log || log.type === 'user_action') return;
    const turnId = String(log.turnId || '').trim();
    const runId = String(log.runId || '').trim();
    const identity = turnId || runId;
    if (!identity) return;
    const alreadyOwned = turnId ? boundaryTurnIds.has(turnId) : boundaryRunIds.has(runId);
    if (alreadyOwned) return;
    const candidate = candidates.get(identity) || { firstIndex: index, firstLog: log, qualifies: false };
    candidate.qualifies ||= isMainRunTrace(log) && RECOVERABLE_MAIN_RUN_TYPES.has(normalizedTimelineType(log));
    candidates.set(identity, candidate);
  });

  const missing = Array.from(candidates.entries())
    .filter(([, candidate]) => candidate.qualifies)
    .sort((left, right) => left[1].firstIndex - right[1].firstIndex);
  if (missing.length === 0) return hydratedSource.slice();

  const insertions = new Map<number, any[]>();
  missing.forEach(([identity, candidate]) => {
    const firstTimestamp = timelineTimestamp(candidate.firstLog);
    const turnId = String(candidate.firstLog?.turnId || candidate.firstLog?.runId || identity).trim();
    const runId = String(candidate.firstLog?.runId || turnId || identity).trim();
    const request = claimRequest(candidate.firstLog);
    const boundary = {
      id: `recovered-user-turn-${ turnId }`,
      type: 'user_action',
      text: request?.text || '',
      source: request ? 'human' : 'recovered',
      _recoveredBoundary: true,
      ...(request
        ? { _recoveredExactText: true }
        : { _hiddenRecoveredBoundary: true }),
      ...(candidate.firstLog?.ownerChatId ? { ownerChatId: candidate.firstLog.ownerChatId } : {}),
      ...(candidate.firstLog?.chatId ? { chatId: candidate.firstLog.chatId } : {}),
      ...(runId ? { runId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(firstTimestamp !== null ? {
        timestamp: Math.max(1, firstTimestamp - 1),
        startTime: Math.max(1, firstTimestamp - 1),
        endTime: Math.max(1, firstTimestamp - 1),
      } : {}),
    };
    const atIndex = insertions.get(candidate.firstIndex) || [];
    atIndex.push(boundary);
    insertions.set(candidate.firstIndex, atIndex);
  });

  const repaired: any[] = [];
  hydratedSource.forEach((log, index) => {
    if (insertions.has(index)) repaired.push(...insertions.get(index)!);
    repaired.push(log);
  });
  return repaired;
};

/**
 * Merge two snapshots as an append-only conversation ledger. A newer window
 * may update one run while holding an older copy of another; replacing the
 * whole trace array would erase earlier user boundaries and overlap turns.
 */
export const mergeFeedTraceHistories = (
  durableLogs: any[],
  incomingLogs: any[],
  recoveredRequests: RecoveredUserRequest[] | string = [],
): any[] => {
  const merged: any[] = [];
  const indexes = new Map<string, number>();
  const recoveredBoundaryByScope = new Map<string, number>();
  const realBoundaryByTurn = new Map<string, number>();
  const realBoundaryScopes = new Set<string>();

  const append = (log: any) => {
    if (!log || typeof log !== 'object') return;
    const turnId = String(log.turnId || '').trim();
    const scope = String(turnId || log.runId || '').trim();
    if (log.type === 'user_action' && scope) {
      if (log._recoveredBoundary === true) {
        if (realBoundaryScopes.has(scope)) return;
        const existingRecoveredIndex = recoveredBoundaryByScope.get(scope);
        if (existingRecoveredIndex !== undefined) {
          merged[existingRecoveredIndex] = mergeTimelineTrace(merged[existingRecoveredIndex], log);
          return;
        }
        recoveredBoundaryByScope.set(scope, merged.length);
      } else {
        realBoundaryScopes.add(scope);
        const recoveredIndex = recoveredBoundaryByScope.get(scope);
        if (recoveredIndex !== undefined) {
          merged[recoveredIndex] = log;
          recoveredBoundaryByScope.delete(scope);
          const key = timelineStableKey(log);
          if (key) indexes.set(key, recoveredIndex);
          if (turnId) realBoundaryByTurn.set(turnId, recoveredIndex);
          return;
        }
        const existingTurnIndex = turnId ? realBoundaryByTurn.get(turnId) : undefined;
        if (existingTurnIndex !== undefined) {
          merged[existingTurnIndex] = mergeTimelineTrace(merged[existingTurnIndex], log);
          const key = timelineStableKey(log);
          if (key) indexes.set(key, existingTurnIndex);
          return;
        }
      }
    }

    const key = timelineStableKey(log);
    const existingIndex = key ? indexes.get(key) : undefined;
    if (existingIndex !== undefined) {
      merged[existingIndex] = mergeTimelineTrace(merged[existingIndex], log);
      return;
    }
    const index = merged.length;
    merged.push(log);
    if (key) indexes.set(key, index);
    if (log.type === 'user_action' && log._recoveredBoundary !== true && turnId) {
      realBoundaryByTurn.set(turnId, index);
    }
  };

  (Array.isArray(durableLogs) ? durableLogs : []).forEach(append);
  (Array.isArray(incomingLogs) ? incomingLogs : []).forEach(append);
  return settleFeedTraceLifecycles(
    orderFeedTimelineLogs(recoverMissingUserTurnBoundaries(
      merged,
      Array.isArray(recoveredRequests) ? recoveredRequests : [],
    )),
  );
};

const timelineTraceIndex = (log: any): number | null => {
  const value = Number(log?._traceIdx);
  return Number.isFinite(value) ? value : null;
};

const timelineTimestamp = (log: any): number | null => {
  let value = Number(log?.startTime ?? log?.timestamp ?? log?.endTime);
  if (!Number.isFinite(value) || value <= 0) return null;
  while (value > 10_000_000_000_000) value /= 1000;
  if (value < 10_000_000_000) value *= 1000;
  return value;
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
  const boundariesByTurnId = new Map<string, TimelineEntry[]>();
  const boundariesByRunId = new Map<string, TimelineEntry[]>();
  const boundariesByIdentity = new Map<string, TimelineEntry[]>();
  const boundaryIndexBySourceIndex = new Map<number, number>();

  boundaryEntries.forEach((boundary) => {
    boundaryIndexBySourceIndex.set(boundary.sourceIndex, boundary.boundaryIndex);
    const turnId = String(boundary.log?.turnId || '').trim();
    const runId = String(boundary.log?.runId || '').trim();
    if (turnId) {
      const turnEntries = boundariesByTurnId.get(turnId) || [];
      turnEntries.push(boundary);
      boundariesByTurnId.set(turnId, turnEntries);
    }
    if (runId) {
      const runEntries = boundariesByRunId.get(runId) || [];
      runEntries.push(boundary);
      boundariesByRunId.set(runId, runEntries);
    }
    timelineIdentityAliases(boundary.log).forEach((identity) => {
      const identityEntries = boundariesByIdentity.get(identity) || [];
      identityEntries.push(boundary);
      boundariesByIdentity.set(identity, identityEntries);
    });
  });

  const selectNearestPrecedingBoundary = (matches: TimelineEntry[], log: any): number => {
    if (matches.length === 0) return -1;
    if (matches.length === 1) return matches[0].boundaryIndex;

    // A long-lived Proxy run can host several user queries and may restart
    // trace indices for each internal response. Event time is therefore the
    // strongest separator when several boundaries share the same run alias.
    const logTime = timelineTimestamp(log);
    if (logTime !== null) {
      let timedSelection: TimelineEntry | null = null;
      let selectedTime = -Infinity;
      for (const boundary of matches) {
        const boundaryTime = timelineTimestamp(boundary.log);
        if (boundaryTime === null || boundaryTime > logTime) continue;
        if (boundaryTime >= selectedTime) {
          timedSelection = boundary;
          selectedTime = boundaryTime;
        }
      }
      if (timedSelection) return timedSelection.boundaryIndex;
    }

    let selected: TimelineEntry | null = null;
    for (const boundary of matches) {
      if (compareTimelinePositions(boundary.log, log) <= 0) selected = boundary;
    }
    return (selected || matches[0]).boundaryIndex;
  };

  const selectNearestTimestampBoundary = (log: any): number => {
    const logTime = timelineTimestamp(log);
    if (logTime === null) return -1;
    let selected: TimelineEntry | null = null;
    let selectedTime = -Infinity;
    for (const boundary of boundaryEntries) {
      const boundaryTime = timelineTimestamp(boundary.log);
      if (boundaryTime === null || boundaryTime > logTime) continue;
      if (boundaryTime >= selectedTime) {
        selected = boundary;
        selectedTime = boundaryTime;
      }
    }
    return selected?.boundaryIndex ?? -1;
  };

  const findOwnerBoundary = (log: any): number => {
    const turnId = String(log?.turnId || '').trim();
    const runId = String(log?.runId || '').trim();
    // A run can contain several Main/Proxy queries. A real turn match is
    // authoritative; the shared run ID is only a compatibility fallback for
    // older traces that never carried a turn identity.
    const exactTurnMatches = turnId ? boundariesByTurnId.get(turnId) || [] : [];
    if (exactTurnMatches.length > 0) {
      return selectNearestPrecedingBoundary(exactTurnMatches, log);
    }
    const matches = turnId
      ? []
      : runId
        ? boundariesByRunId.get(runId) || []
        : Array.from(new Set(
          timelineIdentityAliases(log)
            .flatMap(identity => boundariesByIdentity.get(identity) || [])
        ));
    if (matches.length > 0) {
      // Proxy-backed runs can contain multiple user boundaries under one run
      // ID. Use trace/timestamp position to select the nearest preceding one.
      return selectNearestPrecedingBoundary(matches, log);
    }

    // Some legacy/live helper rows arrive without run identity after their
    // owning turn has already settled. Delivery order would attach those rows
    // to the newest query, so use their event time before falling back to
    // neighboring transport order.
    return selectNearestTimestampBoundary(log);
  };

  let nearestBoundaryIndex = -1;
  source.forEach((log, sourceIndex) => {
    if (!log) return;
    if (log.type === 'user_action') {
      nearestBoundaryIndex = boundaryIndexBySourceIndex.get(sourceIndex) ?? nearestBoundaryIndex;
      return;
    }
    const boundaryIndex = findOwnerBoundary(log);
    const entry = { log, sourceIndex, boundaryIndex };
    if (boundaryIndex >= 0) entriesByBoundary[boundaryIndex].push(entry);
    else if (
      sourceIndex < boundaryEntries[0].sourceIndex
      || timelineTimestamp(log) !== null && compareTimelinePositions(log, boundaryEntries[0].log) < 0
      || timelineIdentityAliases(log).length > 0
    ) {
      // Explicitly-owned events with no matching boundary are orphans from a
      // different/older run. Keep them outside every visible query instead of
      // silently moving them under the latest boundary by delivery order.
      preamble.push(entry);
    }
    else {
      // Truly unscoped helper rows stay with their original neighboring turn.
      // They are not safe to move across a user boundary.
      entriesByBoundary[Math.max(0, nearestBoundaryIndex)].push(entry);
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
