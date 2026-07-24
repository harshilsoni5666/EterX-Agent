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
