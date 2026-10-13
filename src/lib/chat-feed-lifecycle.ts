import { contextUsageCursor, mergeContextCompactionSnapshot, mergeContextUsageSnapshot } from './context-usage-snapshot';
import { modelUsageReceiptKey, mergeModelUsageReceipt } from './model-usage';
import { sameUserAdmission, userAdmissionKey, reconcileQueuedTurnDelivery } from './steering-delivery';
import { mergeUserAttachments, visibleUserRequest } from './chat-user-payload';

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

const ACTIVE_FEED_STATUSES = new Set([
  'running',
  'working',
  'pending',
  'streaming',
  'spawning',
  'started',
  'compacting',
  'retrying',
]);

const SETTLED_FEED_STATUSES = new Set([
  'completed',
  'complete',
  'done',
  'success',
  'failed',
  'error',
  'stopped',
  'cancelled',
  'canceled',
  'closed',
  'compacted',
]);

/**
 * Both a normal user message and accepted live guidance start a new visible
 * feed phase. Keeping this decision shared prevents events after guidance
 * from inheriting the answer/liveness/dedupe state of the preceding phase.
 */
export const isFeedTurnBoundary = (log: any): boolean => Boolean(
  log && (log.type === 'user_action' || log.type === 'steering_received')
);

export const getFeedTraceWorkerScope = (log: any): string => String(
  log?.subAgentChatId || log?.subAgentId || log?.subAgent || 'main',
).trim().split('::sub-agent::').pop() || 'main';

const FEED_ACTION_TYPES = new Set([
  'command', 'tool_call', 'exploration', 'file_edit', 'browser',
  'communication', 'sub_agent_action',
]);

/** Normalize the provider-specific field that names the action's tool. */
export const getFeedActionToolName = (log: any): string => String(
  log?.tool || log?.toolName || log?.name || '',
).trim().toLowerCase();

/**
 * Some tools describe one logical object per user query even if the provider
 * retries them under a fresh transport ID. Keep that retry on the first row.
 */
export const getFeedActionSingletonIdentity = (log: any): string => {
  if (!FEED_ACTION_TYPES.has(String(log?.type || '').trim().toLowerCase())) return '';
  const toolName = getFeedActionToolName(log);
  return toolName === 'task_decomposer' ? 'task_decomposer' : '';
};

const normalizedFeedActionType = (log: any): string => {
  const type = String(log?.type || '').trim().toLowerCase();
  return type === 'tool_call' ? 'command' : type;
};

/**
 * The presentation boundary is the canonical query owner after timeline
 * recovery. Provider turn aliases can legitimately differ between the open
 * and settled copies of one action (especially for Main/worker hand-offs),
 * so lifecycle reconciliation must prefer that resolved owner whenever it is
 * available. Before ordering, retain the transport's explicit turn/run scope.
 */
const feedActionLifecycleScope = (log: any): string => String(
  log?._feedBoundaryId || log?.turnId || log?.runId || '',
).trim();

const normalizedFeedActionContent = (log: any): string => {
  const normalize = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const toolName = getFeedActionToolName(log);
  const structuredOperation = [
    log?.command,
    log?.filepath || log?.filename,
    log?.query || log?.searchQuery,
  ].map(normalize).filter(Boolean);
  // `secondary` is often presentation text and may change from a running
  // label to an outcome summary. Once a command/path/query exists, exclude
  // that mutable subtitle from lifecycle identity so an enriched settlement
  // can still find its already-mounted start row. For tools without structured
  // fields, secondary remains part of the identity because it commonly holds
  // the real arguments that distinguish two calls.
  const operation = structuredOperation.length > 0
    ? [toolName, ...structuredOperation].filter(Boolean).join('|')
    : [toolName, normalize(log?.secondary)].filter(Boolean).join('|');
  // Display labels commonly change between open and settled snapshots
  // ("Running command" -> "Ran command"). Use prose only for legacy rows
  // that carry no operational identity at all.
  return operation || String(log?.text ?? '').replace(/\s+/g, ' ').trim();
};

const normalizedFeedActionDuration = (log: any): number => {
  const explicit = Number(log?.durationMs || 0);
  if (explicit > 0) return explicit;
  const normalize = (value: unknown) => {
    let timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
    while (timestamp > 10_000_000_000_000) timestamp /= 1000;
    if (timestamp < 10_000_000_000) timestamp *= 1000;
    return timestamp;
  };
  const startedAt = normalize(log?.startTime);
  const endedAt = normalize(log?.endTime);
  return startedAt > 0 && endedAt >= startedAt ? endedAt - startedAt : 0;
};

const normalizedFeedActionOutcome = (log: any): string => {
  const status = String(log?.status || '').trim().toLowerCase();
  if (['complete', 'completed', 'done', 'success', 'succeeded', 'closed'].includes(status)) return 'completed';
  if (['failed', 'failure', 'error'].includes(status)) return 'failed';
  if (['stopped', 'cancelled', 'canceled'].includes(status)) return 'stopped';
  if (['running', 'working', 'pending', 'streaming', 'started'].includes(status)) return 'running';
  return Number(log?.durationMs || 0) > 0 || Number(log?.endTime || 0) > 0
    ? 'completed'
    : status;
};

const normalizedFeedActionExitCode = (log: any): string =>
  log?.exitCode === undefined || log?.exitCode === null || log?.exitCode === ''
    ? '0'
    : String(log.exitCode);

/**
 * Provider and registry invocation identities are stronger than coincidental
 * timing/content equality. Parallel tools can intentionally run the same
 * command and finish in the same clock bucket; distinct identities must keep
 * those calls as distinct rows.
 */
const getFeedActionInvocationIdentities = (log: any): Set<string> => new Set(
  [
    // `_traceIdx` is a delivery cursor and a replay receives a new one. Only an
    // explicitly preserved lifecycle origin is an invocation identity; using
    // the current cursor here disabled legacy replay reconciliation entirely.
    ['origin', log?._originTraceIdx],
    ['tool', log?.toolCallId],
    ['trace', log?.traceId],
    ['response', log?.responseKey],
  ]
    .map(([kind, value]) => {
      const identity = String(value ?? '').trim();
      return identity ? `${ kind }:${ identity }` : '';
    })
    .filter(Boolean),
);

/**
 * A generic UI/event id is only a fallback correlation hint. When both rows
 * already expose provider/registry invocation identities and none overlap,
 * they are different calls even if an adapter reused the same `id`. This is
 * especially important for parallel identical commands.
 */
export const haveConflictingFeedActionInvocations = (left: any, right: any): boolean => {
  // Comparable authoritative fields win over shared adapter/event aliases.
  // Incomparable fields (e.g. one side has only an origin, the other a tool
  // ID) are enrichment, not evidence that this is a different invocation.
  for (const field of ['toolCallId', '_originTraceIdx', 'traceId', 'responseKey']) {
    const a = String(left?.[field] ?? '').trim();
    const b = String(right?.[field] ?? '').trim();
    if (a && b) return a !== b;
  }
  return false;
};

/**
 * Constant-time lookup keys for the conservative replay predicate below.
 * Duration keys include the adjacent 25 ms buckets and are always validated
 * again with `areLikelySameFeedActionLifecycle`; the buckets only replace an
 * O(n) scan and never decide that two actions are equal by themselves.
 */
export const getFeedActionLifecycleCandidateKeys = (log: any): string[] => {
  if (!log || !FEED_ACTION_TYPES.has(String(log.type || '').trim().toLowerCase())) return [];
  const type = normalizedFeedActionType(log);
  const scope = feedActionLifecycleScope(log);
  if (!scope) return [];

  const content = normalizedFeedActionContent(log);
  const prefix = JSON.stringify([scope, type, content]);
  const keys: string[] = [];
  const originIndex = Number(log?._originTraceIdx);
  if (Number.isFinite(originIndex)) keys.push(`origin:${ prefix }:${ originIndex }`);
  const singleton = getFeedActionSingletonIdentity(log);
  if (singleton) keys.push(`singleton:${ JSON.stringify([scope, type, singleton]) }`);

  const startedAt = Number(log.startTime || 0);
  if (startedAt > 0) keys.push(`start:${ prefix }:${ startedAt }`);

  const duration = normalizedFeedActionDuration(log);
  if (duration > 0) {
    const bucket = Math.floor(duration / 25);
    const suffix = JSON.stringify([
      normalizedFeedActionOutcome(log),
      normalizedFeedActionExitCode(log),
    ]);
    for (let offset = -1; offset <= 1; offset += 1) {
      const candidateBucket = bucket + offset;
      if (candidateBucket >= 0) keys.push(`duration:${ prefix }:${ candidateBucket }:${ suffix }`);
    }
  }
  return Array.from(new Set(keys));
};

/**
 * Conservative fallback for a settled action replayed with regenerated IDs.
 * It requires the same query, exact rendered action, outcome, and duration.
 * The runtime's own per-query call ledger rejects an intentional exact repeat,
 * so a later matching transport copy is the same lifecycle row.
 */
export const areLikelySameFeedActionLifecycle = (left: any, right: any): boolean => {
  if (!left || !right) return false;
  if (!FEED_ACTION_TYPES.has(String(left.type || '').trim().toLowerCase())) return false;
  if (!FEED_ACTION_TYPES.has(String(right.type || '').trim().toLowerCase())) return false;
  if (normalizedFeedActionType(left) !== normalizedFeedActionType(right)) return false;

  const leftScope = feedActionLifecycleScope(left);
  const rightScope = feedActionLifecycleScope(right);
  if (!leftScope || !rightScope || leftScope !== rightScope) return false;

  const leftSingleton = getFeedActionSingletonIdentity(left);
  const rightSingleton = getFeedActionSingletonIdentity(right);
  if (leftSingleton && leftSingleton === rightSingleton) return true;

  if (haveConflictingFeedActionInvocations(left, right)) return false;
  const leftOrigin = String(left?._originTraceIdx ?? '').trim();
  const rightOrigin = String(right?._originTraceIdx ?? '').trim();
  if (leftOrigin && rightOrigin && leftOrigin === rightOrigin) {
    return true;
  }
  const leftInvocations = getFeedActionInvocationIdentities(left);
  const rightInvocations = getFeedActionInvocationIdentities(right);
  if ([...leftInvocations].some(identity => rightInvocations.has(identity))) return true;

  if (normalizedFeedActionContent(left) !== normalizedFeedActionContent(right)) return false;
  const leftStart = Number(left.startTime || 0);
  const rightStart = Number(right.startTime || 0);
  // Timing/outcome resemblance cannot identify an invocation: two genuine
  // edits to one file can have the same duration and success label. Legacy
  // snapshots need an exact start anchor and no conflicting event ID.
  const leftId = String(left.id || '').trim();
  const rightId = String(right.id || '').trim();
  return leftStart > 0 && leftStart === rightStart &&
    (!leftId || !rightId || leftId === rightId);
};

/** Explicit close markers always win over stale running/status snapshots. */
export const isFeedTraceExplicitlySettled = (log: any): boolean => Boolean(
  log && (
    log.final === true ||
    log.done === true ||
    log.isStreaming === false ||
    (log.isLiveTyping === false && log.isStreaming !== true) ||
    String(log.streamState || '').trim().toLowerCase() === 'closed' ||
    [log.status, log.state, log.agentStatus, log.phase].some(value =>
      SETTLED_FEED_STATUSES.has(String(value || '').trim().toLowerCase())
    )
  )
);

/** One provider-neutral liveness decision shared by ingestion and rendering. */
export const isFeedTraceOpen = (log: any): boolean => Boolean(
  log &&
  !isFeedTraceExplicitlySettled(log) &&
  (
    log.isLive === true ||
    log.isStreaming === true ||
    log.isLiveTyping === true ||
    log.isDelta === true ||
    String(log.streamState || '').trim().toLowerCase() === 'open' ||
    [log.status, log.state, log.agentStatus, log.phase].some(value =>
      ACTIVE_FEED_STATUSES.has(String(value || '').trim().toLowerCase())
    )
  )
);

export const isSettledAnswerTrace = (log: any): boolean => Boolean(
  log?.type === 'answer' &&
  String(log.text || '').trim() &&
  !isFeedTraceOpen(log)
);

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
  if (!log || log.mainTurnTerminal === false || isFeedTurnBoundary(log)) return false;

  const type = String(log.type || '').trim().toLowerCase();
  const agentName = String(log.agentName || '').trim().toLowerCase();
  // Some delegated runtimes emit narrative rows with only agentName (without
  // the richer subAgentId/subAgentChatId fields). A non-Main name on a
  // thought/work-note row is still worker-owned and must not close Main's turn.
  const namedDelegatedNarrative = Boolean(agentName) &&
    !/^(?:main|main agent|assistant|eterx|eterx agent|root)$/.test(agentName) &&
    ['thought', 'thought_stream', 'work_note', 'autonomy_proxy_status'].includes(type);
  const explicitChildTrace = /^sub_agent_|^inter_agent_/.test(type) ||
    Boolean(log.subAgent || log.subAgentId || log.subAgentChatId || log.terminalTask) ||
    log.isSubAgent === true ||
    String(log.agentRole || '').trim().toLowerCase() === 'sub_agent' ||
    namedDelegatedNarrative;
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
  return isMainAgentTrace &&
    ['thought', 'progress', 'status', 'agent_status', 'run_status', 'error', 'done'].includes(type) &&
    TERMINAL_WORK_TEXT.test(text);
};

/** Server cancellation, the stop response, and local cancellation share one event. */
export const createStoppedRunTrace = (
  scope: { ownerChatId?: string; runId?: string; turnId?: string },
  at: number,
) => ({
  id: `run-terminal:${scope.runId || scope.ownerChatId || 'chat'}:${scope.turnId || scope.runId || at}:stopped`,
  type: 'agent_status',
  status: 'stopped',
  title: 'Run stopped',
  text: 'Stopped by you.',
  detail: 'Stopped by you.',
  mainTurnTerminal: true,
  timestamp: at,
  startTime: at,
  endTime: at,
  ...scope,
});

/** Reconcile notice representations, not independent API retries or tool errors. */
export const reconcileTerminalRunNotices = (logs: any[]): any[] => {
  const result: any[] = [];
  const notices = new Map<string, number>();
  let boundary: any = null;
  for (const log of logs) {
    if (isFeedTurnBoundary(log)) {
      boundary = log;
      // Even malformed legacy turns reusing IDs remain separate occurrences.
      notices.clear();
    }
    const type = String(log?.type || '').toLowerCase();
    const status = String(log?.status || '').toLowerCase();
    const detail = String(log?.detail || log?.text || log?.message || '')
      .replace(/^\s*[*_`]+|[*_`]+\s*$/g, '').replace(/\s+/g, ' ').trim();
    const stopped = ['stopped', 'cancelled', 'canceled'].includes(status) ||
      /^(?:generation stopped by user\.?|agent stopped\.?|stopped by (?:you|user)\.?)$/i.test(detail);
    const isNotice = ['thought', 'agent_status', 'run_status', 'status', 'error', 'done'].includes(type) &&
      isTerminalWorkTrace(log) && (Boolean(detail) || type === 'agent_status') &&
      !['completed', 'complete', 'success'].includes(status);
    const runId = String(log?.runId || boundary?.runId || '').trim();
    const turnId = String(log?.turnId || boundary?.turnId || log?._feedBoundaryId || '').trim();
    const outcome = stopped ? 'stopped' : `error:${detail.replace(/^agent (?:stopped|error)\s*:\s*/i, '').toLowerCase()}`;
    const key = isNotice && (runId || turnId) ? JSON.stringify([
      log?.ownerChatId || log?.chatId || boundary?.ownerChatId || boundary?.chatId || '',
      runId, turnId, outcome,
    ]) : '';
    const existingIndex = key ? notices.get(key) : undefined;
    if (existingIndex === undefined) {
      if (key) notices.set(key, result.length);
      result.push(log);
      continue;
    }
    const previous = result[existingIndex];
    const times = [previous.endTime, previous.timestamp, log.endTime, log.timestamp]
      .map(value => timelineTimestamp({ timestamp: value }))
      .filter((value): value is number => value !== null);
    const at = times.length ? Math.min(...times) : undefined;
    const cursors = [previous._pollIdx, previous._traceIdx, log._pollIdx, log._traceIdx]
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    result[existingIndex] = {
      ...previous,
      ...log,
      ...(stopped ? { type: 'agent_status', status: 'stopped', title: 'Run stopped' } : {}),
      id: previous.id || log.id,
      _feedPresentationId: previous._feedPresentationId || log._feedPresentationId,
      _feedBoundaryId: previous._feedBoundaryId || log._feedBoundaryId,
      _feedBoundaryOrder: previous._feedBoundaryOrder ?? log._feedBoundaryOrder,
      _feedEventOrder: previous._feedEventOrder ?? log._feedEventOrder,
      _originTraceIdx: previous._originTraceIdx ?? log._originTraceIdx,
      _traceIdx: previous._traceIdx ?? log._traceIdx,
      ...(cursors.length ? { _pollIdx: Math.max(...cursors) } : {}),
      ...(at !== undefined ? { timestamp: at, startTime: at, endTime: at } : {}),
    };
  }
  return result;
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

const STABLE_NARRATIVE_TRACE_TYPES = new Set([
  'thought_stream',
  'work_note',
  'autonomy_proxy_status',
]);

const STABLE_ACTION_TRACE_TYPES = new Set([
  'command',
  'tool_call',
  'exploration',
  'file_edit',
  'file_preview',
  'progress',
  'browser',
  'communication',
  'sub_agent_action',
  'task_plan',
]);

const STABLE_STATUS_TRACE_TYPES = new Set([
  'status',
  'run_status',
  'agent_status',
  'context_compaction',
  'error',
  'done',
]);

/**
 * Give every visible narrative stream one immutable presentation identity.
 * Provider stream/note IDs are commonly reused by the next run, so the ID is
 * scoped to the owning chat, turn, and agent before it reaches React. Keeping
 * an already assigned identity is important: a later poll may add timestamps
 * or scope fields, but must not remount a row that has already landed.
 */
export const ensureStableNarrativePresentationIds = (
  logs: any[] = [],
  fallbackChatId?: string,
): any[] => logs.map((log: any) => {
  const type = String(log?.type || '').trim().toLowerCase();
  if (!log || !STABLE_NARRATIVE_TRACE_TYPES.has(type)) return log;

  const preserved = String(log._feedPresentationId || '').trim();
  if (preserved) return log;

  const chatScope = String(log.ownerChatId || log.chatId || fallbackChatId || 'legacy-chat').trim();
  const turnScope = String(log.turnId || log.runId || 'legacy-turn').trim();
  const ownerScope = String(
    log.subAgentChatId ||
    log.subAgentId ||
    log.subAgent ||
    log.agentName ||
    'main'
  ).trim().toLowerCase();
  const anchors: Array<[string, unknown]> = [
    ['origin', log._originTraceIdx],
    ['thought', log.thoughtId],
    ['note', log.noteId],
    ['trace', log.traceId],
    ['event', log.id],
    ['stream', log.streamId],
    ['index', log._traceIdx],
    ['time', log.streamStartedAt ?? log.startTime ?? log.timestamp ?? log.endTime],
  ];
  const anchor = anchors.find(([, value]) => String(value ?? '').trim().length > 0);
  if (!anchor) return log;

  return {
    ...log,
    _feedPresentationId: `narrative:${ chatScope }:${ turnScope }:${ ownerScope }:${ anchor[0] }:${ String(anchor[1]).trim() }`,
  };
});

/**
 * Action rows need the same immutable presentation contract as narration.
 * In particular, a settled poll may add a tool-call ID after a live row was
 * first rendered from its trace index. Assigning once at ingestion prevents
 * that enrichment from changing the React key or expansion state.
 */
export const ensureStableFeedPresentationIds = (
  logs: any[] = [],
  fallbackChatId?: string,
): any[] => ensureStableNarrativePresentationIds(logs, fallbackChatId).map((log: any) => {
  if (log && fallbackChatId && !log.ownerChatId && !log.chatId) {
    log = { ...log, ownerChatId: fallbackChatId };
  }
  const type = String(log?.type || '').trim().toLowerCase();
  const isAction = STABLE_ACTION_TRACE_TYPES.has(type);
  const isResponse = type === 'answer';
  const isStatus = STABLE_STATUS_TRACE_TYPES.has(type);
  if (!log || (!isAction && !isResponse && !isStatus)) return log;

  const preserved = String(log._feedPresentationId || '').trim();
  if (preserved) return log;

  const chatScope = String(log.ownerChatId || log.chatId || fallbackChatId || 'legacy-chat').trim();
  const turnScope = String(log.turnId || log.runId || 'legacy-turn').trim();
  const ownerScope = String(
    log.subAgentChatId ||
    log.subAgentId ||
    log.subAgent ||
    log.agentName ||
    'main'
  ).trim().toLowerCase();
  const stableType = isResponse
    ? 'answer'
    : type === 'tool_call' || type === 'sub_agent_action' ? 'command' : type;
  const actionStreamContent = isAction
    ? [
      log?.command,
      log?.tool || log?.toolName || log?.name,
      log?.filepath || log?.filename,
      log?.query || log?.searchQuery,
      log?.secondary,
      log?.text,
    ]
      .map(value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase())
      .filter(Boolean)
      .join('|')
      .slice(0, 640)
    : '';
  const actionStreamAnchor = isAction && log?.streamId && actionStreamContent
    ? `${ String(log.streamId) }|${ String(log.streamStartedAt ?? log.startTime ?? log.timestamp ?? '') }|${ actionStreamContent }`
    : '';
  const anchors: Array<[string, unknown]> = [
    ['compaction', log.compactionId],
    ['origin', log._originTraceIdx],
    ['answer', log.answerId],
    ['tool', log.toolCallId],
    ['response', log.responseKey],
    ['message', log.messageId],
    ['trace', log.traceId],
    ['event', log.id],
    ['index', log._traceIdx],
    // A provider stream is a container and may carry several actions. Never
    // give those actions the same React presentation identity.
    ['stream', isAction ? actionStreamAnchor : log.streamId],
    ['time', log.streamStartedAt ?? log.startTime ?? log.timestamp ?? log.endTime],
  ];
  const anchor = anchors.find(([, value]) => String(value ?? '').trim().length > 0);
  if (!anchor) return log;

  return {
    ...log,
    _feedPresentationId: `${ isResponse ? 'response' : isStatus ? 'status' : 'action' }:${ chatScope }:${ turnScope }:${ ownerScope }:${ stableType }:${ anchor[0] }:${ String(anchor[1]).trim() }`,
  };
});

/**
 * Render one chronological lifecycle row per compaction transaction. Retry and
 * terminal events share a compactionId, so only the newest state is visible;
 * this prevents a single transfer from leaving several permanent feed rows.
 */
export const shouldRenderContextCompactionEvent = (
  log: any,
  index: number,
  logs: any[],
  isThinkingTurn: boolean,
): boolean => {
  if (log?.type !== 'context_compaction') return true;
  const compactionId = String(log?.compactionId || '').trim();
  if (!compactionId) return true;
  const phase = String(log?.phase || '').trim().toLowerCase();
  if ((phase === 'compacting' || phase === 'retrying') && !isThinkingTurn) return false;
  return !logs.slice(index + 1).some(candidate =>
    candidate?.type === 'context_compaction'
    && String(candidate?.compactionId || '').trim() === compactionId
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

const timelineStableKeys = (log: any): string[] => {
  const type = normalizedTimelineType(log);
  if (type === 'model_usage') {
    const receiptKey = modelUsageReceiptKey(log);
    return receiptKey ? [`model-receipt:${receiptKey}`] : [];
  }
  // Turn identity is authoritative. Including both turn and run aliases here
  // let two real queries inside one long-lived run match the same provider ID.
  const ownerScope = String(log?.turnId || log?.runId || '').trim();
  const chatScope = String(log?.ownerChatId || log?.chatId || 'chat').trim();
  const workerScope = getFeedTraceWorkerScope(log);
  const scopes = ownerScope ? [`${ownerScope}:worker:${workerScope}:${log?.subAgentTurnId || ''}`] : [];
  if (!type) return [];
  const admissionKey = userAdmissionKey(log);
  if (admissionKey) return [`admission:${ admissionKey }`];
  if (type === 'user_action') {
    const turnScope = String(log?.turnId || '').trim();
    const runScope = String(log?.runId || '').trim();
    const boundaryScope = [
      `chat:${ chatScope }`,
      turnScope ? `turn:${ turnScope }` : '',
      runScope ? `run:${ runScope }` : '',
    ].filter(Boolean).join(':');
    const originTraceIndex = String(log?._originTraceIdx ?? '').trim();
    if (originTraceIndex) return [`user:${ boundaryScope }:origin:${ originTraceIndex }`];

    const localTraceIndex = String(log?._traceIdx ?? '').trim();
    const timestamp = timelineTimestamp(log);
    // A provider-generated `id` and a local trace index can both restart on a
    // later request. Pair them with the complete turn+run owner and admission
    // time; never register an id as chat-global boundary identity. The old
    // global key silently replaced a third query when a transport recycled
    // `user-turn-*`, taking that query's entire work group with it.
    if (localTraceIndex && timestamp !== null) {
      return [`user:${ boundaryScope }:index:${ localTraceIndex }:time:${ timestamp }`];
    }
    const eventId = String(log?.id || log?.messageId || '').trim();
    if (eventId && timestamp !== null) {
      return [`user:${ boundaryScope }:event:${ eventId }:time:${ timestamp }`];
    }
    if (timestamp !== null) {
      return [`user:${ boundaryScope }:time:${ timestamp }:${ String(log?.source || 'human') }:${ timelineContentSignature(log) }`];
    }
    // Two real no-id/no-time user messages can legitimately repeat verbatim.
    // They are not safe to collapse merely because a long-lived run reused a
    // scope or the user sent the same request twice.
    return [];
  }
  const actionTypes = new Set([
    'command', 'exploration', 'file_edit', 'browser', 'communication', 'sub_agent_action',
  ]);
  const childResultTypes = new Set(['file_preview', 'console_output', 'tool_result_preview']);
  const streamAnchor = String(
    log?.command || log?.filepath || log?.filename || log?.secondary || log?.tool || log?.toolName || '',
  ).replace(/\s+/g, ' ').trim().slice(0, 480);
  const ownerChildAnchor = String(
    log?.filepath || log?.filename || log?.command || log?.toolName || log?.tool || log?.name || '',
  ).replace(/\s+/g, ' ').trim().slice(0, 480);
  const stableIds = Array.from(new Set([
    ...[
      log?.toolCallId,
      log?.noteId,
      log?.thoughtId,
      log?.answerId,
      log?.traceId,
      log?.responseKey,
      log?.messageId,
      log?.steeringId,
      log?.id,
    ]
      .map(value => String(value ?? '').trim())
      .filter(Boolean)
      .map(value => `event:${ value }`),
    ...(log?._originTraceIdx !== undefined && log?._originTraceIdx !== null && String(log._originTraceIdx).trim()
      ? [`origin:${ String(log._originTraceIdx).trim() }`]
      : []),
    // A provider stream can host several actions. It is safe only with the
    // action/command anchor and start marker that identify this lifecycle.
    ...(String(log?.streamId || '').trim() && streamAnchor
      ? [`stream:${ String(log.streamId).trim() }:${ String(log?.streamStartedAt ?? log?.startTime ?? '') }:${ streamAnchor }`]
      : []),
    // Result children follow their exact action owner, but one edit call can
    // produce one preview per file, so owner+path/command is the real key.
    ...(childResultTypes.has(type) && String(log?.ownerTraceId || '').trim() && ownerChildAnchor
      ? [`owner:${ String(log.ownerTraceId).trim() }:${ ownerChildAnchor }`]
      : []),
    ...(log?._traceIdx !== undefined && log?._traceIdx !== null && String(log._traceIdx).trim()
      ? [`index:${ String(log._traceIdx).trim() }`]
      : []),
  ]));
  // Never let a run-wide stream become a peer of a real per-action ID. The
  // anchored stream fallback above is retained only for legacy ID-less rows.
  if (actionTypes.has(type) && stableIds.some(value => value.startsWith('event:'))) {
    for (let index = stableIds.length - 1; index >= 0; index -= 1) {
      if (stableIds[index].startsWith('stream:')) stableIds.splice(index, 1);
    }
  }
  if (stableIds.length > 0) {
    return (scopes.length > 0 ? scopes : [`unscoped:worker:${workerScope}`])
      .flatMap(scope => stableIds.map(stableId => `trace:${ scope }:${ type }:${ stableId }`));
  }
  const traceIndex = timelineTraceIndex(log);
  if (traceIndex !== null) {
    return (scopes.length > 0 ? scopes : [`unscoped:worker:${workerScope}`])
      .map(scope => `trace:${ scope }:${ type }:index:${ traceIndex }`);
  }
  const timestamp = timelineTimestamp(log);
  return timestamp !== null
    ? [`trace:time:worker:${workerScope}:${ type }:${ timestamp }:${ timelineContentSignature(log) }`]
    : [];
};

/**
 * Reconcile optimistic, recovered, and durable copies of one user boundary.
 *
 * Recovered boundaries deliberately carry `_hiddenRecoveredBoundary` while
 * their exact prompt is unknown. A normal object spread leaves that flag on
 * the row when a later poll supplies the real text, so the renderer continues
 * hiding a perfectly valid query. Keep the genuine boundary identity and make
 * visible text a monotonic property of the merged transcript row.
 */
const mergedBoundaryAliases = (previous: any, incoming: any) => ({
  _feedBoundaryAliases: [...new Set([
    ...(previous?._feedBoundaryAliases || []), ...(incoming?._feedBoundaryAliases || []),
    previous?._feedBoundaryId, incoming?._feedBoundaryId,
  ].filter(Boolean))],
  _feedTurnAliases: [...new Set([
    ...(previous?._feedTurnAliases || []), ...(incoming?._feedTurnAliases || []),
    previous?.turnId, incoming?.turnId,
  ].filter(Boolean))],
});

export const mergeUserTurnBoundaries = (previous: any, incoming: any): any => {
  if (previous?.type !== 'user_action' || incoming?.type !== 'user_action') {
    return {
      ...previous,
      ...incoming,
      ...mergedBoundaryAliases(previous, incoming),
      _feedBoundaryId: previous?._feedBoundaryId || incoming?._feedBoundaryId || undefined,
      _feedBoundaryOrder: previous?._feedBoundaryOrder ?? incoming?._feedBoundaryOrder,
      _feedEventOrder: previous?._feedEventOrder ?? incoming?._feedEventOrder,
    };
  }

  const previousText = visibleUserRequest(previous?.text);
  const incomingText = visibleUserRequest(incoming?.text);
  const previousVisible = Boolean(previousText.trim()) && previous?._hiddenRecoveredBoundary !== true;
  const incomingVisible = Boolean(incomingText.trim()) && incoming?._hiddenRecoveredBoundary !== true;
  const previousGenuine = previous?._recoveredBoundary !== true;
  const incomingGenuine = incoming?._recoveredBoundary !== true;
  const preferPreviousIdentity = previousGenuine && !incomingGenuine;
  const merged = preferPreviousIdentity
    ? { ...incoming, ...previous }
    : { ...previous, ...incoming };
  const previousRunId = String(previous?.runId || '').trim();
  const incomingRunId = String(incoming?.runId || '').trim();
  const mergedRunId = String(merged?.runId || '').trim();
  const crossesRunBoundary = Boolean(
    previousRunId && incomingRunId && previousRunId !== incomingRunId,
  );
  const authoritativeTransport = crossesRunBoundary
    ? incomingRunId === mergedRunId
      ? incoming
      : previousRunId === mergedRunId
        ? previous
        : incoming
    : null;
  const visibleText = incomingVisible && (!previousVisible || incomingText.length >= previousText.length)
    ? incomingText
    : previousVisible
      ? previousText
      : incomingText.length >= previousText.length
        ? incomingText
        : previousText;
  const chosenTextLog = visibleText === incomingText ? incoming : previous;
  const hasVisibleText = Boolean(visibleText.trim()) && (previousVisible || incomingVisible);
  const previousStart = Number(previous?.startTime || previous?.timestamp || 0);
  const incomingStart = Number(incoming?.startTime || incoming?.timestamp || 0);

  return {
    ...merged,
    ...mergedBoundaryAliases(previous, incoming),
    // Once a boundary is mounted, keep its first event ID as the presentation
    // identity. Recovery/durable enrichment may add trace/run metadata, but
    // swapping the ID would remount the user/assistant pair and recycle local
    // Thought/Worked state into a fresh subtree.
    id: previous?.id || incoming?.id,
    _feedBoundaryId: previous?._feedBoundaryId || incoming?._feedBoundaryId || undefined,
    _feedBoundaryOrder: previous?._feedBoundaryOrder ?? incoming?._feedBoundaryOrder,
    text: visibleText,
    _queuedFollowUp: previous?._queuedFollowUp === false || incoming?._queuedFollowUp === false ||
      (incoming?._queuedFollowUp !== true && incoming?._recoveredBoundary !== true && incoming?._traceIdx != null)
      ? false : merged?._queuedFollowUp,
    source: chosenTextLog?.source || merged?.source || 'human',
    attachments: mergeUserAttachments(previous?.attachments, incoming?.attachments),
    _traceIdx: authoritativeTransport
      ? authoritativeTransport._traceIdx
      : previous?._traceIdx ?? incoming?._traceIdx,
    _pollIdx: authoritativeTransport
      ? authoritativeTransport._pollIdx ?? authoritativeTransport._traceIdx
      : incoming?._pollIdx ?? incoming?._traceIdx ?? previous?._pollIdx ?? previous?._traceIdx,
    startTime: previousStart > 0 && incomingStart > 0
      ? Math.min(previousStart, incomingStart)
      : previousStart || incomingStart || undefined,
    ...(hasVisibleText || previous?.attachments?.length || incoming?.attachments?.length
      ? { _hiddenRecoveredBoundary: undefined } : {}),
    ...(previousGenuine || incomingGenuine
      ? {
        _recoveredBoundary: undefined,
        _recoveredExactText: undefined,
      }
      : {}),
  };
};

/** A sparse transport snapshot must not erase a payload already delivered. */
export const mergeFeedTracePayload = (previous: any, incoming: any): any => {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value !== undefined) merged[key] = value;
  }
  for (const key of ['diffLines', 'content', 'contentPreview', 'preview', 'toolResult', 'toolArgs', 'fileOperationResult', 'result']) {
    if (merged[key] == null && previous?.[key] != null) merged[key] = previous[key];
  }
  for (const key of ['text', 'output', 'content']) {
    if (typeof previous?.[key] === 'string' && typeof merged[key] === 'string' && previous[key].length > merged[key].length) {
      merged[key] = previous[key];
    }
  }
  return merged;
};

const mergeTimelineTrace = (previous: any, incoming: any): any => {
  if (previous?.type === 'model_usage' && incoming?.type === 'model_usage') {
    return mergeModelUsageReceipt(previous, incoming);
  }
  if (previous?.type === 'context_compaction' && incoming?.type === 'context_compaction') {
    return mergeContextCompactionSnapshot(previous, incoming);
  }
  if (previous?.type === 'context_usage' && incoming?.type === 'context_usage') {
    return mergeContextUsageSnapshot(previous, incoming);
  }
  if (previous?.type === 'user_action' && incoming?.type === 'user_action') {
    return mergeUserTurnBoundaries(previous, incoming);
  }
  const previousClosed = isFeedTraceExplicitlySettled(previous);
  const previousOpen = isFeedTraceOpen(previous);
  const incomingOpen = isFeedTraceOpen(incoming);
  const previousText = String(previous?.text || '');
  const incomingText = String(incoming?.text || '');
  const previousOutput = String(previous?.output || '');
  const incomingOutput = String(incoming?.output || '');
  const preserveSettledLifecycle = previousClosed && incomingOpen;
  const previousStatus = String(previous?.status || '').trim().toLowerCase();
  const settledStatus = ACTIVE_FEED_STATUSES.has(previousStatus)
    ? 'completed'
    : previous?.status;
  const previousTraceIndex = timelineTraceIndex(previous);
  const incomingTraceIndex = timelineTraceIndex(incoming);
  const previousAt = timelineTimestamp(previous);
  const incomingAt = timelineTimestamp(incoming);
  const incomingIsOlder = previousTraceIndex !== null && incomingTraceIndex !== null &&
    previousTraceIndex !== incomingTraceIndex
    ? incomingTraceIndex < previousTraceIndex
    : previousAt !== null && incomingAt !== null && incomingAt < previousAt;
  const incomingClosesLifecycle = previousOpen && !incomingOpen && !incomingIsOlder && (
    normalizedTimelineType(incoming) === 'answer' ||
    LIVE_LIFECYCLE_TYPES.has(normalizedTimelineType(incoming))
  );
  const incomingStatus = String(incoming?.status || '').trim().toLowerCase();
  const closedStatus = ACTIVE_FEED_STATUSES.has(incomingStatus || previousStatus)
    ? 'completed'
    : incoming?.status || settledStatus;

  return {
    ...mergeFeedTracePayload(previous, incoming),
    _feedPresentationId: previous?._feedPresentationId || incoming?._feedPresentationId || undefined,
    _feedBoundaryId: previous?._feedBoundaryId || incoming?._feedBoundaryId || undefined,
    _feedBoundaryOrder: previous?._feedBoundaryOrder ?? incoming?._feedBoundaryOrder,
    _feedEventOrder: previous?._feedEventOrder ?? incoming?._feedEventOrder,
    _originTraceIdx: previous?._originTraceIdx ?? previous?._traceIdx ?? incoming?._originTraceIdx ?? incoming?._traceIdx,
    _traceIdx: previous?._traceIdx ?? incoming?._traceIdx,
    _pollIdx: incoming?._pollIdx ?? incoming?._traceIdx ?? previous?._pollIdx ?? previous?._traceIdx,
    // Once text has reached the feed, a compact final provider snapshot must
    // not make the already-visible narration shrink or disappear.
    text: incomingText.length >= previousText.length ? incoming.text : previous.text,
    ...(previousOutput || incomingOutput
      ? { output: incomingOutput.length >= previousOutput.length ? incoming.output : previous.output }
      : {}),
    startTime: previous?.startTime || previous?.timestamp || incoming?.startTime || incoming?.timestamp,
    ...(incomingClosesLifecycle ? {
      isStreaming: false,
      isLiveTyping: false,
      isLive: false,
      isDelta: false,
      streamState: 'closed',
      status: closedStatus,
      endTime: incoming?.endTime || incoming?.timestamp || previous?.endTime || previous?.timestamp,
    } : {}),
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

const PROVISIONAL_ANSWER_CONTINUATION_TYPES = new Set([
  'work_note',
  'command',
  'exploration',
  'file_edit',
  'progress',
  'browser',
  'communication',
  'ask_user',
  'context_compaction',
  'sub_agent_spawn',
  'sub_agent_action',
]);

const feedTraceOwnershipMatches = (left: any, right: any): boolean => {
  if (getFeedTraceWorkerScope(left) !== getFeedTraceWorkerScope(right)) return false;
  if (left?.subAgentTurnId && right?.subAgentTurnId && left.subAgentTurnId !== right.subAgentTurnId) return false;
  const leftChat = String(left?.ownerChatId || left?.chatId || '').trim();
  const rightChat = String(right?.ownerChatId || right?.chatId || '').trim();
  if (leftChat && rightChat && leftChat !== rightChat) return false;
  const leftTurn = String(left?.turnId || '').trim();
  const rightTurn = String(right?.turnId || '').trim();
  if (leftTurn && rightTurn) return leftTurn === rightTurn;
  const leftRun = String(left?.runId || '').trim();
  const rightRun = String(right?.runId || '').trim();
  if (leftRun && rightRun) return leftRun === rightRun;
  return true;
};

/**
 * Some providers publish an answer-shaped text event immediately before
 * revealing that the turn will continue with a tool. Treat that text as
 * terminal only when the remainder of the same turn contains no workflow
 * continuation; otherwise the UI would collapse and reopen between events.
 */
export const isConclusiveSettledAnswerTrace = (
  log: any,
  index: number,
  logs: any[],
): boolean => {
  if (!isSettledAnswerTrace(log)) return false;
  const answerId = String(log?.answerId || '').trim();
  for (let laterIndex = index + 1; laterIndex < logs.length; laterIndex += 1) {
    const later = logs[laterIndex];
    if (later?.type === 'user_action' || later?.type === 'steering_received') break;
    if (!feedTraceOwnershipMatches(log, later)) continue;
    const laterType = normalizedTimelineType(later);
    if (
      laterType === 'answer_cancel' &&
      (!answerId || String(later?.answerId || '').trim() === answerId)
    ) return false;
    if (PROVISIONAL_ANSWER_CONTINUATION_TYPES.has(laterType)) return false;
  }
  return true;
};

/**
 * A provider can stream ordinary text before revealing a function call. That
 * text starts life as a provisional answer, then answer_cancel + work_note
 * transitions it into the narration for the tool phase. Reconcile that state
 * transition here so stale append-only snapshots cannot retain both forms.
 */
const reconcileProvisionalAnswerTransitions = (logs: any[]): any[] => {
  const source = Array.isArray(logs) ? logs : [];
  if (source.length === 0) return [];
  const superseded = new Set<number>();
  const converted = new Map<number, any>();

  const preserveAsWorkNote = (index: number, answer: any, transition: any, noteId?: string) => {
    if (!String(answer?.text || '').trim()) {
      superseded.add(index);
      return;
    }
    const stableAnswer = ensureStableFeedPresentationIds(
      [answer],
      String(answer?.ownerChatId || answer?.chatId || '').trim() || undefined,
    )[0];
    const answerId = String(answer?.answerId || '').trim();
    const resolvedNoteId = String(noteId || '').trim() ||
      (answerId ? `answer-transition-${ answerId }` : undefined);
    const owner = (trace: any) => String(trace?.subAgentChatId || trace?.subAgentId || trace?.subAgent || 'main');
    const replacementIndex = resolvedNoteId ? source.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && candidate?.type === 'work_note' &&
      String(candidate.noteId || '').trim() === resolvedNoteId &&
      feedTraceOwnershipMatches(answer, candidate) && owner(answer) === owner(candidate)
    ) : -1;
    const replacement = replacementIndex >= 0 ? source[replacementIndex] : undefined;
    if (replacementIndex >= 0) superseded.add(replacementIndex);
    converted.set(index, {
      ...stableAnswer,
      ...(replacement || {}),
      type: 'work_note',
      ...(resolvedNoteId ? { noteId: resolvedNoteId } : {}),
      _feedPresentationId: stableAnswer._feedPresentationId,
      text: replacement?.text || stableAnswer.text,
      _answerTransitionPending: replacement ? undefined : true,
      _streamingCancelled: undefined,
      isStreaming: replacement ? isFeedTraceOpen(replacement) : false,
      isLiveTyping: replacement ? isFeedTraceOpen(replacement) : false,
      streamState: replacement && isFeedTraceOpen(replacement) ? 'open' : 'closed',
      status: replacement?.status || 'completed',
      endTime: replacement?.endTime || transition?.timestamp || transition?.endTime || answer?.timestamp,
    });
  };

  source.forEach((log, index) => {
    if (log?.type !== 'answer') return;

    const answerId = String(log?.answerId || '').trim();
    const answerWasOpen = isFeedTraceOpen(log);
    for (let laterIndex = index + 1; laterIndex < source.length; laterIndex += 1) {
      const later = source[laterIndex];
      if (isFeedTurnBoundary(later)) break;
      if (!feedTraceOwnershipMatches(log, later)) continue;
      const laterType = normalizedTimelineType(later);
      const explicitlyCancelled = laterType === 'answer_cancel' && (
        !answerId || String(later?.answerId || '').trim() === answerId
      );
      if (explicitlyCancelled) {
        const replacementNoteId = String(later?.replacementNoteId || '').trim();
        const replacementText = String(later?.replacementText || log?.text || '').trim();
        if (replacementNoteId && replacementText) {
          preserveAsWorkNote(index, { ...log, text: replacementText }, later, replacementNoteId);
        }
        else superseded.add(index);
        break;
      }
      if (answerWasOpen && PROVISIONAL_ANSWER_CONTINUATION_TYPES.has(laterType)) {
        // The provider may omit answer_cancel but the ordered ledger still
        // proves this open answer became narration for continued work. Keep
        // the already-visible row, using the following note's explicit ID
        // when that is the continuation event, rather than retracting text.
        preserveAsWorkNote(
          index,
          log,
          later,
          laterType === 'work_note' ? String(later?.noteId || '').trim() : undefined,
        );
        break;
      }
      // A settled update for this same answer means the response remained a
      // direct answer; normal stable-ID merging handles that lifecycle.
      if (
        laterType === 'answer' &&
        answerId &&
        String(later?.answerId || '').trim() === answerId &&
        isSettledAnswerTrace(later)
      ) break;
    }
  });

  if (superseded.size === 0 && converted.size === 0) return source.slice();
  const reconciled: any[] = [];
  source.forEach((log, index) => {
    if (superseded.has(index)) return;
    reconciled.push(converted.get(index) || log);
  });
  return reconciled;
};

const LIVE_LIFECYCLE_TYPES = new Set([
  'answer',
  'thought_stream',
  'work_note',
  'command',
  'tool_call',
  'exploration',
  'file_edit',
  'progress',
  'browser',
  'communication',
  'file_preview',
  'console_output',
  'sub_agent_action',
]);

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
  LIVE_LIFECYCLE_TYPES.has(normalizedTimelineType(log)) && isFeedTraceOpen(log)
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
  const explicitDuration = Number(log?.durationMs);
  const settledDuration = Number.isFinite(explicitDuration) && explicitDuration >= 0
    ? explicitDuration
    : startedAt
      ? Math.max(0, safeEnd - startedAt)
      : undefined;
  return {
    ...log,
    isLive: false,
    isStreaming: false,
    isLiveTyping: false,
    streamState: 'closed',
    status: status === 'error'
      ? 'error'
      : ['stopped', 'cancelled', 'canceled'].includes(status)
        ? 'stopped'
        : 'completed',
    endTime: safeEnd,
    ...(settledDuration !== undefined ? { durationMs: settledDuration } : {}),
  };
};

/**
 * Freeze stale live rows at the event that actually ended their lifecycle.
 * Reconnect snapshots can arrive out of order and otherwise revive an old
 * command, thought, or delegated worker after it already completed.
 */
export const settleFeedTraceLifecycles = (logs: any[]): any[] => {
  // Lifecycle boundaries must be evaluated in event order, not transport
  // arrival order. Polling can append an older guidance/action after newer
  // rows; settling first would close the wrong phase and leave the real live
  // tail looking completed.
  const orderedSource = orderFeedTimelineLogs(Array.isArray(logs) ? logs : []);
  const source = reconcileProvisionalAnswerTransitions(orderedSource);
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
  let lastKnownEventAt = 1;
  let terminalAt: number | null = null;
  let terminalStatus = 'completed';

  const settleMainRange = (endExclusive: number, endedAt: number, status = 'completed') => {
    for (let index = turnStart; index < endExclusive; index += 1) {
      if (!isMainRunTrace(settled[index])) continue;
      settled[index] = settleLifecycleTrace(settled[index], endedAt, status);
    }
  };

  source.forEach((log, index) => {
    if (!log) return;
    const type = normalizedTimelineType(log);
    const explicitEventAt = timelineTimestamp(log);
    if (explicitEventAt !== null) lastKnownEventAt = Math.max(lastKnownEventAt, explicitEventAt);
    // Historical/legacy traces do not always carry timestamps. Date.now()
    // made those rows acquire a new end time on every hydration, which in turn
    // remounted cards and restarted elapsed timers. The nearest known ledger
    // time is deterministic and is the only safe fallback.
    const eventAt = explicitEventAt ?? lastKnownEventAt;

    if (isFeedTurnBoundary(log)) {
      if (index > turnStart) settleMainRange(index, Math.max(1, eventAt - 1));
      turnStart = index + 1;
      terminalAt = null;
      terminalStatus = 'completed';
      return;
    }

    // Cleanup/reconnect events can be delivered after a final answer. They are
    // still useful ledger rows, but they must never revive a live action in a
    // turn that has already conclusively ended.
    if (terminalAt !== null && isMainRunTrace(log)) {
      settled[index] = settleLifecycleTrace(settled[index], terminalAt, terminalStatus);
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

    const settledAnswer = isMainRunTrace(log) && isConclusiveSettledAnswerTrace(log, index, source);
    if (settledAnswer || isTerminalWorkTrace(log)) {
      const explicitTerminalStatus = String(log?.status || '').trim().toLowerCase();
      terminalStatus = ['stopped', 'cancelled', 'canceled'].includes(explicitTerminalStatus)
        ? 'stopped'
        : type === 'error' || ['failed', 'error'].includes(explicitTerminalStatus)
          ? 'error'
          : 'completed';
      settleMainRange(index, eventAt, terminalStatus);
      terminalAt = terminalAt === null ? eventAt : Math.min(terminalAt, eventAt);
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
  /** Immutable run owner from the durable context episode, when available. */
  runId?: string;
}

const normalizedRequestText = (value: unknown): string => visibleUserRequest(value)
  .replace(/^\s*\[USER REQUEST\]\s*(?:\r?\n)?/i, '')
  .trim();

const normalizedRequestTimestamp = (value: unknown): number | null =>
  timelineTimestamp({ timestamp: value });

/** Remove only imported copies that can be tied back to an existing event. */
const reconcileRecoveredDialogueCopies = (logs: any[]): any[] => {
  const genuine = new Map<string, any[]>();
  const key = (log: any) => JSON.stringify([
    log.type,
    String(log.subAgentChatId || log.subAgentId || log.subAgent || 'main'),
    log.type === 'user_action' ? visibleUserRequest(log.text).trim() : String(log.text || '').trim(),
  ]);
  const recovered = (log: any) => log?._recoveredBoundary === true || log?._recoveredExactText === true;
  for (const log of logs) {
    if (!['user_action', 'answer'].includes(log?.type) || recovered(log)) continue;
    const identity = key(log);
    genuine.set(identity, [...(genuine.get(identity) || []), log]);
  }
  return logs.filter(log => {
    if (!['user_action', 'answer'].includes(log?.type) || !recovered(log) || !String(log.text || '').trim()) return true;
    return !(genuine.get(key(log)) || []).some(original => {
      const chat = (item: any) => String(item.ownerChatId || item.chatId || '');
      if (chat(original) && chat(log) && chat(original) !== chat(log)) return false;
      if (original.runId && log.runId && original.runId !== log.runId) return false;
      if (log.type === 'user_action') return sameUserAdmission(original, log) ||
        Boolean(log.turnId && (log.turnId === original.id || log.turnId === original.turnId));
      const sameTurn = original.turnId && log.turnId && original.turnId === log.turnId;
      const originalAt = timelineTimestamp(original);
      const recoveredAt = timelineTimestamp(log);
      return sameTurn && !isFeedTraceOpen(original) && originalAt !== null && recoveredAt !== null &&
        Math.abs(originalAt - recoveredAt) <= 1000;
    });
  });
};

export const recoverMissingUserTurnBoundaries = (
  logs: any[],
  recoveredRequests: RecoveredUserRequest[] = [],
): any[] => {
  const source = reconcileRecoveredDialogueCopies(reconcileQueuedTurnDelivery(Array.isArray(logs) ? logs : []));
  if (source.length === 0) return [];

  const requests = (Array.isArray(recoveredRequests) ? recoveredRequests : [])
    .map((request, index) => ({
      index,
      text: normalizedRequestText(request?.text),
      timestamp: normalizedRequestTimestamp(request?.timestamp),
      runId: String(request?.runId || '').trim(),
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
  const claimRequest = (log: any, preferText = '', exactOnly = false) => {
    const normalizedPreferredText = normalizedRequestText(preferText).toLowerCase();
    const logRunId = String(log?.runId || log?.turnId || '').trim();
    let best: typeof requests[number] | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const request of requests) {
      if (usedRequestIndexes.has(request.index)) continue;
      // Two explicit run owners are immutable. Text equality and clock
      // proximity are never permission to move a user request across them.
      // Allowing this fallback made an empty/late boundary for run B borrow
      // run A's prompt, so the first query reappeared before later work.
      if (logRunId && request.runId && request.runId !== logRunId) continue;
      const exactText = Boolean(
        normalizedPreferredText && request.text.toLowerCase() === normalizedPreferredText,
      );
      if (exactOnly && !exactText) continue;
      const exactRun = Boolean(logRunId && request.runId && request.runId === logRunId);
      const distance = requestDistance(request, log);
      // Run ownership outranks all fuzzy recovery. Text is next, and time is
      // only the legacy fallback for episodes that predate origin IDs.
      const score = (exactRun ? 0 : request.runId ? 2_000_000_000_000_000 : 1_000_000_000_000_000)
        + (exactText ? 0 : 500_000_000_000_000)
        + distance;
      if (score < bestScore) {
        best = request;
        bestScore = score;
      }
    }
    if (!best) return null;
    usedRequestIndexes.add(best.index);
    return best;
  };
  const claimPrecedingRequest = (log: any) => {
    const logAt = timelineTimestamp(log);
    if (logAt === null) return null;
    const logRunId = String(log?.runId || log?.turnId || '').trim();
    if (logRunId) {
      const exact = requests.find(request =>
        !usedRequestIndexes.has(request.index) && request.runId === logRunId
      );
      if (exact) {
        usedRequestIndexes.add(exact.index);
        return exact;
      }
    }
    let best: typeof requests[number] | null = null;
    for (const request of requests) {
      if (
        usedRequestIndexes.has(request.index) ||
        // A request with a known, different run can never repair this orphan.
        (request.runId && logRunId && request.runId !== logRunId) ||
        request.timestamp === null ||
        request.timestamp > logAt
      ) continue;
      if (!best || request.timestamp > (best.timestamp ?? -Infinity)) best = request;
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
    const visibleText = normalizedRequestText(log.text);
    const request = claimRequest(log, visibleText, Boolean(visibleText));
    if (request) reservedRequestsByBoundary.set(index, request);
  });

  const hydratedSourceWithRecovery = source.map((log, index) => {
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
    if (normalizedRequestText(log.text) && (log?._recoveredExactText === true || log?._hiddenRecoveredBoundary !== true)) {
      // Presentation often has no context episodes. Their absence cannot
      // erase an already recovered query on the next render.
      return { ...log, text: visibleUserRequest(log.text), _recoveredExactText: true, _hiddenRecoveredBoundary: undefined };
    }
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

  // Older recovery logic could manufacture a new user boundary for a late
  // event whose turn alias changed even though its run already had a genuine
  // visible boundary. If context recovery then supplied the opening request,
  // that first query appeared again before every later phase. Remove only
  // provable synthetic duplicates; a recovered boundary with distinct text
  // remains valid transcript data.
  const genuineBoundaries = hydratedSourceWithRecovery.filter(log =>
    log?.type === 'user_action' &&
    log?._recoveredBoundary !== true &&
    log?._recoveredExactText !== true,
  );
  const preferredRecoveredOpenings = new Map<string, { log: any; score: number }>();
  hydratedSourceWithRecovery.forEach(log => {
    if (log?.type !== 'user_action' || (log?._recoveredBoundary !== true && log?._recoveredExactText !== true)) return;
    const runId = String(log?.runId || '').trim();
    const text = normalizedRequestText(log?.text).toLowerCase();
    if (!runId || !text) return;
    const owner = String(log?.ownerChatId || log?.chatId || '').trim();
    const turnId = String(log?.turnId || '').trim();
    const eventId = String(log?.id || '').trim();
    const score = (turnId === runId ? 2 : 0) + (eventId === `user-turn-${runId}` ? 1 : 0);
    const key = JSON.stringify([owner, String(log?.subAgentChatId || log?.subAgentId || log?.subAgent || 'main'), runId, turnId, text]);
    const current = preferredRecoveredOpenings.get(key);
    if (!current || score > current.score) preferredRecoveredOpenings.set(key, { log, score });
  });
  const hydratedSource = hydratedSourceWithRecovery.filter(log => {
    const isRecoveredOpeningBoundary = log?.type === 'user_action' && (
      log?._recoveredBoundary === true || log?._recoveredExactText === true
    );
    if (!isRecoveredOpeningBoundary) return true;
    const recoveredTurnId = String(log?.turnId || '').trim();
    const recoveredRunId = String(log?.runId || '').trim();
    const recoveredText = normalizedRequestText(log?.text).toLowerCase();
    if (recoveredRunId && recoveredText) {
      const owner = String(log?.ownerChatId || log?.chatId || '').trim();
      const preferred = preferredRecoveredOpenings.get(JSON.stringify([
        owner, String(log?.subAgentChatId || log?.subAgentId || log?.subAgent || 'main'),
        recoveredRunId, recoveredTurnId, recoveredText,
      ]));
      if (preferred && preferred.log !== log) return false;
    }
    return !genuineBoundaries.some(boundary => {
      if (sameUserAdmission(boundary, log)) return true;
      const owner = (entry: any) => String(entry?.ownerChatId || entry?.chatId || '');
      const worker = (entry: any) => String(entry?.subAgentChatId || entry?.subAgentId || entry?.subAgent || 'main');
      if (worker(boundary) !== worker(log) || (owner(boundary) && owner(log) && owner(boundary) !== owner(log))) return false;
      const boundaryTurnId = String(boundary?.turnId || '').trim();
      const boundaryRunId = String(boundary?.runId || '').trim();
      const sameTurn = Boolean(recoveredTurnId && boundaryTurnId === recoveredTurnId);
      if (recoveredRunId && boundaryRunId && recoveredRunId !== boundaryRunId) return false;
      // Repeated words within a long run are still distinct user turns.
      return sameTurn;
    });
  });

  const boundaryTurnIds = new Set<string>();
  const boundaryRunIds = new Set<string>();
  const boundaryFeedIds = new Set<string>();
  hydratedSource.forEach(log => {
    // Accepted live guidance is a real visible turn boundary too. Treating
    // only user_action as ownership caused every steered phase to look
    // orphaned and invited a synthetic recovered boundary into the middle of
    // the existing transcript.
    if (!isFeedTurnBoundary(log)) return;
    const turnId = String(log?.turnId || '').trim();
    const runId = String(log?.runId || '').trim();
    const feedBoundaryId = String(log?._feedBoundaryId || '').trim();
    if (turnId) boundaryTurnIds.add(turnId);
    if (runId) boundaryRunIds.add(runId);
    if (feedBoundaryId) boundaryFeedIds.add(feedBoundaryId);
  });

  const candidates = new Map<string, { firstIndex: number; firstLog: any; qualifies: boolean }>();
  hydratedSource.forEach((log, index) => {
    if (!log || log.type === 'user_action') return;
    const turnId = String(log.turnId || '').trim();
    const runId = String(log.runId || '').trim();
    const feedBoundaryId = String(log._feedBoundaryId || '').trim();
    const identity = turnId || runId;
    if (!identity) return;
    const alreadyOwned = Boolean(
      feedBoundaryId && boundaryFeedIds.has(feedBoundaryId),
    ) || (turnId
      ? boundaryTurnIds.has(turnId)
      : Boolean(runId && boundaryRunIds.has(runId)));
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
    // An orphan action may be a late snapshot from an older turn. Never give
    // it the text of a later request merely because that future request is
    // closer in absolute time; that was the source of repeated/moved user
    // bubbles after a second or third Send. A user admission must precede the
    // work it owns, otherwise keep the recovered boundary hidden.
    // A long-lived run can contain several visible queries. If this event has
    // a new turn alias while that run already has a real boundary, a run-only
    // recovered request cannot prove which query it belongs to. Borrowing the
    // run's first prompt here made that prompt flash again before later
    // normalization removed it. Keep an invisible ownership boundary until
    // the exact user/steering event arrives and enriches it.
    const request = runId && boundaryRunIds.has(runId)
      ? null
      : claimPrecedingRequest(candidate.firstLog);
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
  const realBoundaryScopes = new Set<string>();

  const registerTraceKeys = (log: any, index: number) => {
    timelineStableKeys(log).forEach(key => indexes.set(key, index));
  };

  const findTraceIndex = (log: any): number | undefined => {
    for (const key of timelineStableKeys(log)) {
      const index = indexes.get(key);
      if (index !== undefined) return index;
    }
    return undefined;
  };

  const append = (log: any) => {
    if (!log || typeof log !== 'object') return;
    const scope = timelineIdentity(log);
    if (log.type === 'user_action' && scope) {
      if (log._recoveredBoundary === true) {
        if (realBoundaryScopes.has(scope)) return;
        const existingRecoveredIndex = recoveredBoundaryByScope.get(scope);
        if (existingRecoveredIndex !== undefined) {
          merged[existingRecoveredIndex] = mergeTimelineTrace(merged[existingRecoveredIndex], log);
          registerTraceKeys(merged[existingRecoveredIndex], existingRecoveredIndex);
          return;
        }
        recoveredBoundaryByScope.set(scope, merged.length);
      } else {
        realBoundaryScopes.add(scope);
        const recoveredIndex = recoveredBoundaryByScope.get(scope);
        if (recoveredIndex !== undefined) {
          merged[recoveredIndex] = mergeUserTurnBoundaries(merged[recoveredIndex], log);
          recoveredBoundaryByScope.delete(scope);
          registerTraceKeys(merged[recoveredIndex], recoveredIndex);
          return;
        }
      }
    }

    const existingIndex = findTraceIndex(log);
    if (existingIndex !== undefined) {
      merged[existingIndex] = mergeTimelineTrace(merged[existingIndex], log);
      registerTraceKeys(merged[existingIndex], existingIndex);
      return;
    }
    const index = merged.length;
    merged.push(log);
    registerTraceKeys(log, index);
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
  if (log?.type === 'context_usage') return contextUsageCursor(log);
  const raw = log?._originTraceIdx ?? log?._traceIdx;
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
};

const timelineTimestamp = (log: any): number | null => {
  // Worker completions carry the execution start for duration display, but
  // their position in the transcript is the time they finished.
  const times = /^sub_agent_(?:complete|answer|result|error|close)$/.test(String(log?.type || ''))
    ? [log?.endTime, log?.timestamp, log?.startTime]
    : [log?.startTime, log?.timestamp, log?.endTime];
  const raw = times
    .map(value => Number(value))
    .find(value => Number.isFinite(value) && value > 0);
  if (raw === undefined) return null;
  let value = raw;
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
 * visible user/guidance boundary that owns each trace, then order only within
 * that boundary. This keeps actions, thought updates, and answer snapshots in
 * one deterministic phase without letting a late event leak into the newest.
 */
export const orderFeedTimelineLogs = (logs: any[]): any[] => {
  const input = Array.isArray(logs) ? logs : [];
  // A guidance message accepted at the completion edge can be promoted into
  // a successor run. Its acknowledgement (`steering_received`) and the new
  // run's canonical `user_action` are two transport representations of the
  // same immutable query. Collapse only an exact chat+turn match; repeated
  // text under different turn IDs remains two real user requests.
  const source: any[] = [];
  const boundaryIndexes = new Map<string, number>();
  input.forEach((log) => {
    if (!isFeedTurnBoundary(log)) {
      source.push(log);
      return;
    }
    const chatScope = String(log?.ownerChatId || log?.chatId || 'chat').trim();
    const turnId = String(log?.turnId || '').trim();
    const boundaryKey = userAdmissionKey(log) || (turnId ? `${ chatScope }:${ turnId }` : '');
    const existingIndex = boundaryKey ? boundaryIndexes.get(boundaryKey) : undefined;
    if (existingIndex === undefined) {
      if (boundaryKey) boundaryIndexes.set(boundaryKey, source.length);
      source.push(log);
      return;
    }

    const previous = source[existingIndex];
    const previousText = normalizedRequestText(previous?.text);
    const incomingText = normalizedRequestText(log?.text);
    // A malformed producer reusing one turn for different content is safer as
    // two visible rows than silently replacing either user request.
    if (previousText && incomingText && previousText !== incomingText) {
      source.push(log);
      return;
    }
    const meaningfulWorkBetween = source.slice(existingIndex + 1).some(candidate =>
      !isFeedTurnBoundary(candidate) &&
      isMainRunTrace(candidate) &&
      RECOVERABLE_MAIN_RUN_TYPES.has(normalizedTimelineType(candidate))
    );
    const previousTraceIndex = timelineTraceIndex(previous);
    const incomingTraceIndex = timelineTraceIndex(log);
    const previousAdmission = timelineTimestamp(previous);
    const incomingAdmission = timelineTimestamp(log);
    const previousOriginIndex = String(previous?._originTraceIdx ?? '').trim();
    const incomingOriginIndex = String(log?._originTraceIdx ?? '').trim();
    const sameTracePosition = Boolean(
      previousTraceIndex !== null &&
      incomingTraceIndex !== null &&
      previousTraceIndex === incomingTraceIndex &&
      String(previous?.runId || '').trim() === String(log?.runId || '').trim() &&
      (
        Boolean(previousOriginIndex && incomingOriginIndex && previousOriginIndex === incomingOriginIndex) ||
        Boolean(previousAdmission !== null && incomingAdmission !== null && previousAdmission === incomingAdmission)
      )
    );
    const isSteeringPromotion = previous?.type !== log?.type && Boolean(
      [previous?.type, log?.type].includes('steering_received') &&
      [previous?.type, log?.type].includes('user_action')
    );
    const isRecoveredPromotion = Boolean(
      previous?._recoveredBoundary === true || log?._recoveredBoundary === true
    );
    // Equal turn IDs are not enough: malformed/legacy providers can reuse a
    // turn for multiple sends. Once meaningful assistant work has landed, a
    // later boundary is a new transcript occurrence even when its text and
    // transport ID are identical. Only an exact transport snapshot or the
    // explicit steering/recovery representation hand-off may collapse here.
    if (!sameTracePosition && !sameUserAdmission(previous, log) && (
      meaningfulWorkBetween ||
      (!isSteeringPromotion && !isRecoveredPromotion)
    )) {
      source.push(log);
      return;
    }
    const canonical = log?.type === 'user_action'
      ? log
      : previous?.type === 'user_action'
        ? previous
        : log;
    const previousRunId = String(previous?.runId || '').trim();
    const canonicalRunId = String(canonical?.runId || '').trim();
    const crossesRunBoundary = Boolean(
      previousRunId && canonicalRunId && previousRunId !== canonicalRunId,
    );
    // A completion-edge steering acknowledgement can be promoted into a
    // successor run while retaining the same turn ID and mounted user bubble.
    // Trace indices restart at zero for that successor, so only presentation
    // identity may survive the collapse; its transport cursor must come from
    // the canonical user_action in the new run.
    const canonicalTraceIndex = canonical?._traceIdx;
    const mergedTraceIndex = crossesRunBoundary
      ? canonicalTraceIndex
      : previous?._traceIdx ?? log?._traceIdx;
    const mergedPollIndex = crossesRunBoundary
      ? canonical?._pollIdx ?? canonicalTraceIndex
      : log?._pollIdx ?? log?._traceIdx ?? previous?._pollIdx ?? previous?._traceIdx;
    const earliestAt = [timelineTimestamp(previous), timelineTimestamp(log)]
      .filter((value): value is number => value !== null)
      .sort((left, right) => left - right)[0];
    source[existingIndex] = {
      ...previous,
      ...log,
      ...canonical,
      ...mergedBoundaryAliases(previous, log),
      // Preserve the mounted boundary/card identity while enriching it with
      // the successor's authoritative run ownership.
      id: previous?.id || log?.id,
      text: incomingText || previousText,
      source: canonical?.source || previous?.source || log?.source || 'human',
      _feedBoundaryId: previous?._feedBoundaryId || log?._feedBoundaryId || undefined,
      _feedBoundaryOrder: previous?._feedBoundaryOrder ?? log?._feedBoundaryOrder,
      _traceIdx: mergedTraceIndex,
      _pollIdx: mergedPollIndex,
      ...(earliestAt !== undefined ? {
        timestamp: earliestAt,
        startTime: earliestAt,
        endTime: earliestAt,
      } : {}),
    };
  });
  if (source.length < 2) return source.slice();

  const stableBoundaryId = (log: any, sourceIndex: number): string => {
    const preserved = String(log?._feedBoundaryId || '').trim();
    if (preserved) return preserved;
    const chatScope = String(log?.ownerChatId || log?.chatId || 'chat').trim();
    const kind = log?.type === 'steering_received' ? 'steering' : 'user';
    const identity = String(
      log?.turnId ||
      log?.steeringId ||
      log?.messageId ||
      log?.id ||
      log?.runId ||
      log?._traceIdx ||
      log?.timestamp ||
      sourceIndex,
    ).trim();
    return `feed-boundary:${ chatScope }:${ kind }:${ identity }`;
  };

  const boundaries = source
    .map((log, sourceIndex) => ({ log, sourceIndex }))
    .filter(entry => isFeedTurnBoundary(entry.log));

  if (boundaries.length === 0) {
    const entries = source.map((log, sourceIndex) => ({ log, sourceIndex, boundaryIndex: 0 }));
    return entries
      .sort((left, right) => compareTimelineEntries(left, right) || (
        Number(left.log?._feedEventOrder) - Number(right.log?._feedEventOrder)
      ) || left.sourceIndex - right.sourceIndex)
      .map((entry, index) => ({ ...entry.log, _feedEventOrder: index }));
  }

  const boundaryIdCounts = new Map<string, number>();
  const boundaryEntries: TimelineEntry[] = boundaries.map((entry, boundaryIndex) => {
    const baseBoundaryId = stableBoundaryId(entry.log, entry.sourceIndex);
    const occurrence = boundaryIdCounts.get(baseBoundaryId) || 0;
    boundaryIdCounts.set(baseBoundaryId, occurrence + 1);
    const boundaryId = occurrence === 0
      ? baseBoundaryId
      : `${baseBoundaryId}:occurrence:${entry.sourceIndex}`;
    return {
      log: String(entry.log?._feedBoundaryId || '').trim() === boundaryId
        ? entry.log
        : { ...entry.log, _feedBoundaryId: boundaryId },
      sourceIndex: entry.sourceIndex,
      boundaryIndex,
    };
  });
  const entriesByBoundary = boundaryEntries.map(entry => [entry] as TimelineEntry[]);
  const preamble: TimelineEntry[] = [];
  const boundariesByTurnId = new Map<string, TimelineEntry[]>();
  const boundariesByRunId = new Map<string, TimelineEntry[]>();
  const boundariesByIdentity = new Map<string, TimelineEntry[]>();
  const boundariesByStableId = new Map<string, TimelineEntry[]>();
  const boundaryIndexBySourceIndex = new Map<number, number>();
  // Bind repeat snapshots of one immutable event to the first turn that saw
  // them. Provider event IDs (for example `mistral_work_stream_1`) restart on
  // every run, so their identity is turn-scoped rather than chat-global.
  // Polling may refresh a snapshot's timestamp, but it may never move an event
  // into another request that happens to reuse the same provider-local ID.
  const eventOwnerBoundary = new Map<string, number>();
  const transportEventKeys = (log: any): string[] => {
    const normalizedType = normalizedTimelineType(log);
    const type = ['thought_stream', 'work_note', 'autonomy_proxy_status'].includes(normalizedType)
      ? 'narrative'
      : normalizedType;
    const chatScope = String(log?.ownerChatId || log?.chatId || 'chat').trim();
    const turnScope = String(log?._feedBoundaryId || log?.turnId || log?.runId || 'unscoped').trim();
    const runScope = String(log?.runId || log?.originRunId || 'unscoped-run').trim();
    const eventScope = `${ chatScope }:${ turnScope }`;
    const actionTypes = new Set([
      'command', 'tool_call', 'exploration', 'file_edit', 'browser',
      'communication', 'sub_agent_action',
    ]);
    const ownerChainId = String(
      log?.ownerTraceId || (actionTypes.has(normalizedType) ? log?.traceId || log?.toolCallId : '') || '',
    ).trim();
    const hasExplicitTurnScope = Boolean(
      String(log?._feedBoundaryId || log?.turnId || '').trim(),
    );
    const ownerChainScope = hasExplicitTurnScope
      ? eventScope
      : `${ chatScope }:${ runScope }`;
    const scopedEventKeys = [
      ['toolCallId', log?.toolCallId],
      ['streamId', log?.noteId || log?.thoughtId
        ? null
        : log?.streamId
          ? `${ String(log.streamId) }|${ String(log.streamStartedAt ?? log.startTime ?? log.timestamp ?? '') }|${ String(log.command || log.filepath || log.filename || log.secondary || timelineContentSignature(log)) }`
          : null],
      ['noteId', log?.noteId],
      ['thoughtId', log?.thoughtId],
      ['answerId', log?.answerId],
      ['traceId', log?.traceId],
      ['responseKey', log?.responseKey],
      ['messageId', log?.messageId],
      ['steeringId', log?.steeringId],
      ['id', log?.id],
    ]
      .map(([field, value]) => {
        const normalized = String(value ?? '').trim();
        return normalized ? `${ eventScope }:${ type }:${ field }:${ normalized }` : '';
      })
      .filter(Boolean);
    return Array.from(new Set([
      // Child snapshots/results keep the owning action's placement even if a
      // late transport path omitted or mis-stamped the newer turn identity.
      ownerChainId ? `${ ownerChainScope }:ownerChain:${ ownerChainId }` : '',
      ...scopedEventKeys,
    ].filter(Boolean)));
  };

  boundaryEntries.forEach((boundary) => {
    boundaryIndexBySourceIndex.set(boundary.sourceIndex, boundary.boundaryIndex);
    const turnId = String(boundary.log?.turnId || '').trim();
    const runId = String(boundary.log?.runId || '').trim();
    const stableId = String(boundary.log?._feedBoundaryId || '').trim();
    for (const alias of new Set<string>([stableId, ...(boundary.log?._feedBoundaryAliases || [])].filter(Boolean))) {
      const stableEntries = boundariesByStableId.get(alias) || [];
      stableEntries.push(boundary);
      boundariesByStableId.set(alias, stableEntries);
    }
    for (const alias of new Set<string>([turnId, ...(boundary.log?._feedTurnAliases || [])].filter(Boolean))) {
      const turnEntries = boundariesByTurnId.get(alias) || [];
      turnEntries.push(boundary);
      boundariesByTurnId.set(alias, turnEntries);
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

  const selectNearestPrecedingBoundary = (
    matches: TimelineEntry[],
    log: any,
    sourceIndex: number,
  ): number => {
    if (matches.length === 0) return -1;
    if (matches.length === 1) return matches[0].boundaryIndex;

    // Explicit turn IDs are normally unique, but long-lived Proxy transports
    // can reuse one ID for several user requests. In that case the append-only
    // trace position is the only stable ownership signal for a late event.
    // Resolve it before transport order: a delayed event is often delivered
    // after the newer boundary, so choosing the last source row would move it
    // into the wrong query.
    const logIndex = timelineTraceIndex(log);
    if (logIndex !== null) {
      let indexedSelection: TimelineEntry | null = null;
      let selectedIndex = -Infinity;
      for (const boundary of matches) {
        const boundaryTraceIndex = timelineTraceIndex(boundary.log);
        if (boundaryTraceIndex === null || boundaryTraceIndex > logIndex) continue;
        if (boundaryTraceIndex >= selectedIndex) {
          indexedSelection = boundary;
          selectedIndex = boundaryTraceIndex;
        }
      }
      if (indexedSelection) return indexedSelection.boundaryIndex;
    }

    // A long-lived Proxy run can host several user queries and can refresh an
    // old event's timestamp on every poll. Prefer the event's append-only
    // transport neighborhood. Use time only when it conclusively proves that
    // the event predates that neighboring boundary.
    const logTime = timelineTimestamp(log);
    let sourceSelection: TimelineEntry | null = null;
    for (const boundary of matches) {
      if (boundary.sourceIndex <= sourceIndex) sourceSelection = boundary;
    }
    if (sourceSelection) {
      const boundaryTime = timelineTimestamp(sourceSelection.log);
      if (logTime === null || boundaryTime === null || logTime >= boundaryTime) {
        return sourceSelection.boundaryIndex;
      }
    }

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

    // Legacy/helper events can lack both a timestamp and trace index. Their
    // transport neighborhood is the only trustworthy ownership signal.
    return (sourceSelection || matches[0]).boundaryIndex;
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

  const findOwnerBoundary = (log: any, sourceIndex: number): number => {
    // Once an event has appeared beneath a boundary, that ownership is part
    // of the transcript. New user/steering turns and refreshed timestamps may
    // enrich the event, but they must never move completed history elsewhere.
    const persistedBoundaryId = String(log?._feedBoundaryId || '').trim();
    const persistedMatches = persistedBoundaryId
      ? boundariesByStableId.get(persistedBoundaryId) || []
      : [];
    if (persistedMatches.length > 0) {
      return selectNearestPrecedingBoundary(persistedMatches, log, sourceIndex);
    }
    // Older recovery versions renamed synthetic boundary IDs. An exact turn
    // identity can repair that stale presentation pointer; a timestamp cannot.

    const turnId = String(log?.turnId || '').trim();
    const runId = String(log?.runId || '').trim();
    // A run can contain several Main/Proxy queries. A real turn match is
    // authoritative; the shared run ID is only a compatibility fallback for
    // older traces that never carried a turn identity.
    const exactTurnMatches = turnId ? boundariesByTurnId.get(turnId) || [] : [];
    if (exactTurnMatches.length > 0) {
      return selectNearestPrecedingBoundary(exactTurnMatches, log, sourceIndex);
    }
    // Auxiliary runtimes use their own worker turn while still reporting the
    // immutable root query they serve. If the worker boundary is not visible
    // on this surface, the root turn is the authoritative owner. This keeps a
    // late worker/file/message snapshot beneath its originating query instead
    // of leaving it in the preamble or allowing a later request to claim it.
    const rootTurnId = String(log?.rootTurnId || '').trim();
    const rootTurnMatches = rootTurnId
      ? boundariesByTurnId.get(rootTurnId) || []
      : [];
    if (rootTurnMatches.length > 0) {
      return selectNearestPrecedingBoundary(rootTurnMatches, log, sourceIndex);
    }
    if (persistedBoundaryId) return -1;
    // Likewise, a real turn ID that is not represented in this transcript
    // slice denotes an orphaned/trimmed turn. Timestamp proximity must never
    // migrate it into a different user request.
    if (turnId || rootTurnId) return -1;
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
      return selectNearestPrecedingBoundary(matches, log, sourceIndex);
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
    if (isFeedTurnBoundary(log)) {
      nearestBoundaryIndex = boundaryIndexBySourceIndex.get(sourceIndex) ?? nearestBoundaryIndex;
      return;
    }
    const eventKeys = transportEventKeys(log);
    const persistedBoundaryId = String(log?._feedBoundaryId || '').trim();
    const persistedBoundaryMatches = persistedBoundaryId
      ? boundariesByStableId.get(persistedBoundaryId) || []
      : [];
    const persistedBoundary = persistedBoundaryMatches.length > 0
      ? selectNearestPrecedingBoundary(persistedBoundaryMatches, log, sourceIndex)
      : undefined;
    const previouslyBoundBoundary = eventKeys.reduce<number | undefined>(
      (found, key) => found ?? eventOwnerBoundary.get(key),
      undefined,
    );
    const boundaryIndex = persistedBoundary ?? previouslyBoundBoundary ?? findOwnerBoundary(log, sourceIndex);
    if (boundaryIndex >= 0) {
      eventKeys.forEach(key => {
        if (!eventOwnerBoundary.has(key)) eventOwnerBoundary.set(key, boundaryIndex);
      });
    }
    const boundaryId = boundaryIndex >= 0
      ? String(boundaryEntries[boundaryIndex]?.log?._feedBoundaryId || '').trim()
      : '';
    const ownedLog = boundaryId && String(log?._feedBoundaryId || '').trim() !== boundaryId
      ? { ...log, _feedBoundaryId: boundaryId }
      : log;
    const entry = { log: ownedLog, sourceIndex, boundaryIndex };
    if (boundaryIndex >= 0) entriesByBoundary[boundaryIndex].push(entry);
    else if (
      Boolean(String(
        log?._feedBoundaryId || log?.turnId || log?.rootTurnId || log?.runId || '',
      ).trim())
      ||
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

  const compareBoundaryEntries = (left: TimelineEntry, right: TimelineEntry) => {
    // A boundary's admission time is immutable and shared by the optimistic
    // client event and its server acknowledgement. It remains authoritative
    // when concurrent poll/queue requests arrive in a different order.
    const leftTime = timelineTimestamp(left.log);
    const rightTime = timelineTimestamp(right.log);
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    const leftRunId = String(left.log?.runId || '').trim();
    const rightRunId = String(right.log?.runId || '').trim();
    if (leftRunId && leftRunId === rightRunId) {
      const traceOrder = compareTimelineEntries(left, right);
      if (traceOrder) return traceOrder;
    }
    const leftStoredOrder = Number(left.log?._feedBoundaryOrder);
    const rightStoredOrder = Number(right.log?._feedBoundaryOrder);
    if (Number.isFinite(leftStoredOrder) && Number.isFinite(rightStoredOrder) && leftStoredOrder !== rightStoredOrder) {
      return leftStoredOrder - rightStoredOrder;
    }
    return left.sourceIndex - right.sourceIndex;
  };

  const lifecycleSnapshotIdentity = (log: any): string => {
    const type = normalizedTimelineType(log);
    const owner = `${getFeedTraceWorkerScope(log)}:${String(log?.subAgentTurnId || '')}`;
    const identityField = [
      'toolCallId', 'noteId', 'thoughtId', 'answerId', 'responseKey', 'steeringId', 'id',
    ].find(field => String(log?.[field] ?? '').trim());
    if (identityField) return `${owner}:${type}:${identityField}:${String(log[identityField]).trim()}`;
    const traceIndex = timelineTraceIndex(log);
    return traceIndex === null ? '' : `${owner}:${type}:trace:${traceIndex}`;
  };

  const deduplicateBoundaryEntries = (entries: TimelineEntry[]): TimelineEntry[] => {
    const deduplicated: TimelineEntry[] = [];
    const identityIndexes = new Map<string, number>();
    entries.forEach(entry => {
      const identity = lifecycleSnapshotIdentity(entry.log);
      if (!identity) {
        deduplicated.push(entry);
        return;
      }
      const existingIndex = identityIndexes.get(identity);
      if (existingIndex === undefined) {
        identityIndexes.set(identity, deduplicated.length);
        deduplicated.push(entry);
        return;
      }
      // The later snapshot is authoritative for the same lifecycle event.
      // Keep entries from separate boundaries independent by applying this
      // reconciliation only after ownership has already been resolved.
      deduplicated[existingIndex] = entry;
    });
    return deduplicated;
  };

  const orderedBoundaryEntries = boundaryEntries
    .slice()
    .sort(compareBoundaryEntries)
    .map((entry, index) => ({
      ...entry,
      log: { ...entry.log, _feedBoundaryOrder: index },
    }));

  const ordered: any[] = preamble
    .slice()
    .sort((left, right) => compareTimelineEntries(left, right) || left.sourceIndex - right.sourceIndex)
    .map((entry, index) => ({ ...entry.log, _feedEventOrder: index }));
  orderedBoundaryEntries.forEach(boundaryEntry => {
    const entries = deduplicateBoundaryEntries(entriesByBoundary[boundaryEntry.boundaryIndex]);
    const orderedEntries = entries
      .slice(1)
      .sort((left, right) => compareTimelineEntries(left, right) || left.sourceIndex - right.sourceIndex)
      .map((entry, index) => ({ ...entry.log, _feedEventOrder: index }));
    ordered.push(
      boundaryEntry.log,
      ...orderedEntries,
    );
  });
  return reconcileTerminalRunNotices(ordered);
};
