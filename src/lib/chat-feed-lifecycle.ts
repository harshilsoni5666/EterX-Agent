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

  const status = String(log.status || '').trim().toLowerCase();
  if (
    TERMINAL_WORK_STATUSES.has(status) &&
    !log.subAgent &&
    !log.agentName &&
    !log.terminalTask &&
    (log.mainTurnTerminal === true || ['done', 'error', 'agent_status', 'run_status'].includes(String(log.type || '').toLowerCase()))
  ) return true;

  const type = String(log.type || '').trim().toLowerCase();
  if (TERMINAL_WORK_TYPES.has(type) && !log.subAgent && !log.agentName) return true;

  const text = String(log.text || log.message || '').trim();
  return TERMINAL_WORK_TEXT.test(text);
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
