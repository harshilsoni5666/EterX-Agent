export const contextWorkerId = (log: any): string => {
  const child = log?.subAgentChatId || log?.subAgentId;
  if (child) return String(child).trim();
  if (typeof log?.chatId === 'string' && log.chatId.includes('::sub-agent::')) return log.chatId.trim();
  const owner = log?.ownerChatId;
  return typeof owner === 'string' && owner.includes('::sub-agent::') ? owner.trim() : '';
};

/** Usage is a measurement of one request, not an append-only lifecycle row. */
export const contextUsageScopeKey = (log: any): string | null => {
  const runId = String(log?.runId || '').trim();
  const turnId = String(log?.subAgentTurnId || log?.turnId || runId).trim();
  // Unowned legacy samples cannot safely replace a different query's sample.
  if (!turnId) return null;
  const childId = contextWorkerId(log);
  const childMarker = '::sub-agent::';
  const owner = childId
    ? `child:${childId.includes(childMarker) ? childId.split(childMarker).pop() : childId}`
    : log?.subAgent
      ? `child-name:${String(log.subAgent).trim()}`
      : log?.agentId
        ? `agent:${String(log.agentId).trim()}`
        : 'main';
  return JSON.stringify([
    String(log?.ownerChatId || log?.chatId || '').trim(),
    runId,
    turnId,
    owner,
  ]);
};

const finiteCursor = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export const contextUsageCursor = (log: any): number | null =>
  finiteCursor(log?._contextMeasurementIdx) ?? finiteCursor(log?._pollIdx) ?? finiteCursor(log?._traceIdx)
  ?? (['context_usage', 'context_compaction', 'model_usage'].includes(log?.type) ? null : finiteCursor(log?._originTraceIdx));

// Issued before measuring the request. A late receipt can have a newer poll
// cursor and wall-clock timestamp than the preflight of the following request.
export const contextRequestTime = (log: any): number =>
  Number(/^context-request-(\d+)-/.exec(String(log?.contextRequestId || ''))?.[1]) || 0;

export const contextPayloadSuperseded = (previous: any, incoming: any): boolean => {
  const previousRequest = contextRequestTime(previous), nextRequest = contextRequestTime(incoming);
  if (previousRequest && nextRequest && nextRequest < previousRequest) return true;
  return Boolean(previous?.contextRequestId && previous.contextRequestId === incoming?.contextRequestId
    && previous.compactionId && !incoming.compactionId && incoming.contextReplaced !== true);
};

export const contextMeasurementTime = (log: any): number => {
  let time = Number(log?.measurementAt || log?.timestamp || log?.endTime || log?.startTime || 0);
  if (!Number.isFinite(time) || time <= 0) return 0;
  while (time > 10_000_000_000_000) time /= 1000;
  if (time < 10_000_000_000) time *= 1000;
  return time;
};

/** Counts from different tokenizers/payloads are not interchangeable. */
export const contextMeasurementModel = (log: any): string => {
  const payload = log?.type === 'context_compaction' && log.usage ? log.usage : log;
  const provider = String(payload?.provider || '').trim().toLowerCase();
  const model = String(payload?.model || payload?.modelId || '').trim();
  return provider && model ? JSON.stringify([provider, model]) : '';
};

export const isPendingContextCompaction = (log: any): boolean => log?.type === 'context_compaction'
  && (log.phase === 'compacting' || log.phase === 'retrying');

export const isTerminalContextCompaction = (log: any): boolean => log?.type === 'context_compaction'
  && (log.phase === 'compacted' || log.phase === 'failed');

const incomingMeasurementIsOlder = (previous: any, incoming: any): boolean => {
  const previousRun = String(previous?.runId || '').trim();
  const incomingRun = String(incoming?.runId || '').trim();
  const previousCursor = contextUsageCursor(previous);
  const incomingCursor = contextUsageCursor(incoming);
  // Delivery counters are only comparable inside the same server run. Never
  // let a delayed reconnect stamp old metrics with a newer timestamp/cursor.
  const comparableCursors = previousRun && previousRun === incomingRun
    && previousCursor !== null && incomingCursor !== null;
  return comparableCursors && previousCursor !== incomingCursor
    ? incomingCursor! < previousCursor!
    : contextMeasurementTime(incoming) < contextMeasurementTime(previous);
};

export const mergeContextUsageSnapshot = (previous: any, incoming: any): any => {
  if (!previous) return { ...incoming, startTime: incoming?.timestamp || incoming?.startTime };
  const sameRequest = previous.contextRequestId && previous.contextRequestId === incoming.contextRequestId;
  // The POST receipt and the poll can carry the same sample. Preserve its
  // server cursor, and never roll a committed capsule back to its preflight.
  if (contextPayloadSuperseded(previous, incoming)) return previous;
  const advancesCommit = sameRequest && incoming.compactionId && !previous.compactionId;
  if (!advancesCommit && (incomingMeasurementIsOlder(previous, incoming)
    || (sameRequest && contextUsageCursor(previous) !== null && contextUsageCursor(incoming) === null
      && contextMeasurementTime(previous) === contextMeasurementTime(incoming)))) return previous;
  return {
    // Missing measurement fields must remain missing, not inherit a different
    // model's breakdown, calibration, capacity or token total.
    ...incoming,
    id: previous.id || incoming.id,
    _originTraceIdx: previous._originTraceIdx ?? previous._traceIdx ?? incoming._originTraceIdx ?? incoming._traceIdx,
    startTime: incoming.timestamp || incoming.startTime,
  };
};

/** Keep a compaction's presentation slot separate from its terminal measurement. */
export const mergeContextCompactionSnapshot = (previous: any, incoming: any): any => {
  const phaseRank = (phase: unknown) => phase === 'compacted' || phase === 'failed' ? 2 : phase === 'retrying' ? 1 : 0;
  const rank = phaseRank(incoming?.phase);
  if (previous) {
    const previousRank = phaseRank(previous.phase);
    if (previousRank > rank || (previousRank === rank && incomingMeasurementIsOlder(previous, incoming))) return previous;
    if (previousRank === 2 && rank === 2 && previous.phase !== incoming.phase) return previous;
  }
  return {
    ...previous,
    ...incoming,
    ...(isTerminalContextCompaction(incoming) && previous?.interrupted ? { interrupted: false } : {}),
    id: previous?.id || incoming.id || `context-compaction:${incoming.compactionId}`,
    _feedPresentationId: previous?._feedPresentationId || incoming._feedPresentationId,
    _feedBoundaryId: previous?._feedBoundaryId || incoming._feedBoundaryId,
    _feedBoundaryOrder: previous?._feedBoundaryOrder ?? incoming._feedBoundaryOrder,
    _feedEventOrder: previous?._feedEventOrder ?? incoming._feedEventOrder,
    _originTraceIdx: previous?._originTraceIdx ?? previous?._traceIdx ?? incoming._originTraceIdx ?? incoming._traceIdx,
    _traceIdx: previous?._traceIdx ?? incoming._traceIdx,
    _pollIdx: incoming._pollIdx ?? incoming._traceIdx ?? previous?._pollIdx ?? previous?._traceIdx,
    _contextMeasurementIdx: contextUsageCursor(incoming) ?? previous?._contextMeasurementIdx,
    startTime: previous?.startTime || previous?.timestamp || incoming.startTime || incoming.timestamp,
    endTime: rank === 2 ? incoming.endTime || incoming.timestamp : undefined,
  };
};

/**
 * Feed rows keep their first presentation slot; measurements must use their
 * latest occurrence instead. Sort globally by measurement time, then restore
 * server sequence within each run. Never compare reset cursors across runs.
 */
export const orderContextMeasurementLogs = (logs: any[]): any[] => {
  const ordered = logs.map((log, index) => ({ log, index }))
    .sort((left, right) => contextMeasurementTime(left.log) - contextMeasurementTime(right.log)
      || left.index - right.index);
  const runSlots = new Map<string, number[]>();
  ordered.forEach(({ log }, index) => {
    const runId = String(log?.runId || '').trim();
    if (!runId || contextUsageCursor(log) === null) return;
    const slots = runSlots.get(runId) || [];
    slots.push(index);
    runSlots.set(runId, slots);
  });
  for (const slots of runSlots.values()) {
    const sequenced = slots.map(index => ordered[index]).sort((left, right) =>
      contextUsageCursor(left.log)! - contextUsageCursor(right.log)! || left.index - right.index);
    slots.forEach((slot, index) => { ordered[slot] = sequenced[index]; });
  }
  return ordered.map(entry => entry.log);
};

export const upsertContextUsageSnapshot = (logs: any[], incoming: any): void => {
  const key = contextUsageScopeKey(incoming);
  let existingIndex = -1;
  if (key) {
    for (let index = logs.length - 1; index >= 0; index -= 1) {
      if (logs[index]?.type === 'context_usage' && contextUsageScopeKey(logs[index]) === key) {
        existingIndex = index;
        break;
      }
    }
  }
  const previous = existingIndex >= 0 ? logs[existingIndex] : null;
  const merged = mergeContextUsageSnapshot(previous, incoming);
  if (merged === previous) return;
  if (existingIndex >= 0) logs.splice(existingIndex, 1);
  logs.push(merged);
};
