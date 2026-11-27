import { isModelProvider, parseModelEntryKey, type ModelSelectorEntry } from './agent/model-selector-store';
import { isConclusiveSettledAnswerTrace, isFeedTurnBoundary, isTerminalWorkTrace } from './chat-feed-lifecycle';
import { getAskUserResponseKey, isAskUserPrompt, isPendingAskUser } from './ask-user';

export interface ChatFocusDisposition {
  focusSettled?: boolean;
  focusUpdatedAt?: number;
  focusWakeAt?: number | null;
}

export function mergeChatFocusDisposition(
  durable: ChatFocusDisposition,
  incoming: ChatFocusDisposition,
): ChatFocusDisposition {
  const winner = Number(incoming.focusUpdatedAt || 0) >= Number(durable.focusUpdatedAt || 0)
    ? incoming : durable;
  return { focusSettled: winner.focusSettled, focusUpdatedAt: winner.focusUpdatedAt, focusWakeAt: winner.focusWakeAt };
}

export const FOCUS_GROUPS = [
  { id: 'working', label: 'Working', empty: 'No chats are working right now.' },
  { id: 'attention', label: 'Attention Needed', empty: 'Nothing needs your attention.' },
  { id: 'settled', label: 'Settled', empty: 'Chats you settle will appear here.' },
] as const;

export type FocusGroup = typeof FOCUS_GROUPS[number]['id'];
export type FocusStatus = 'working' | 'input' | 'done' | 'failed' | 'stopped' | 'scheduled' | 'queued' | 'paused' | 'snoozed' | 'woke' | 'settled';

export interface FocusQuestionTarget {
  chatId: string;
  responseKey: string;
}

export function canSettleFocusItem(status?: FocusStatus): boolean {
  return status !== 'working' && status !== 'input';
}

interface FocusTraceState {
  activityAt: number;
  status?: 'input' | 'done' | 'failed' | 'stopped';
  question?: any;
  pendingQuestions: ReadonlyMap<string, any>;
  turnModel?: ModelSelectorEntry;
  previousModel?: ModelSelectorEntry;
}

const traceCache = new WeakMap<readonly unknown[], FocusTraceState>();
const modelTraceTypes = new Set(['model_selection', 'model_usage', 'context_usage']);
const stoppedStatuses = new Set(['stopped', 'cancelled', 'canceled', 'aborted']);

function readTraceModel(log: any): ModelSelectorEntry | undefined {
  if (!modelTraceTypes.has(log?.type) || log.phase === 'chat_title' || log.auxiliaryRuntime) return;
  const provider = log.provider;
  const modelId = String(log.model || log.modelId || '').trim();
  if (isModelProvider(provider) && modelId) return { provider, modelId };
}

function isMainTrace(log: any) {
  return log && !log.subAgentId && !log.subAgentChatId && !log.isSubAgent
    && (!log.subAgent || log.subAgent === 'Main') && !log.terminalTask && !log.auxiliaryRuntime;
}

export function readFocusTrace(logs: any[]): FocusTraceState {
  const cached = traceCache.get(logs);
  if (cached) return cached;
  const boundary = logs.findLastIndex(log => isMainTrace(log) && isFeedTurnBoundary(log) &&
    !log._queuedFollowUp && !log.isLive);
  const turn = logs[boundary];
  const runId = turn?.runId || turn?.turnId;
  const startAt = Number(turn?.timestamp || 0);
  const belongsToRun = (log: any) => Boolean(runId && (
    log.runId === runId || log.turnId === runId || log.rootRunId === runId || log.rootTurnId === runId));
  const turnLogs = logs.slice(boundary + 1).filter(log => log &&
    (!runId || (!log.runId && !log.turnId) || belongsToRun(log)));
  const mainLogs = turnLogs.filter(isMainTrace);
  const terminal = mainLogs.findLast(isTerminalWorkTrace);
  const answer = mainLogs.findLast(isConclusiveSettledAnswerTrace);
  const pendingQuestions = new Map<string, any>();
  if (!terminal) {
    // An agent can keep a question open across a live steering boundary.
    const questions = new Map<string, any>();
    logs.forEach((log, index) => {
      if (!isAskUserPrompt(log) ||
        !(belongsToRun(log) || index > boundary && (!runId || (!log.runId && !log.turnId)))) return;
      const key = getAskUserResponseKey(log);
      const previous = questions.get(key);
      if (!previous || isPendingAskUser(previous)) questions.set(key, log);
    });
    for (const [key, log] of questions) {
      if (isPendingAskUser(log)) pendingQuestions.set(key, log);
    }
  }
  const question = Array.from(pendingQuestions.values()).at(-1);
  const terminalKind = String(terminal?.status || terminal?.type || '').toLowerCase();
  const failed = terminal && (terminalKind === 'error' || terminalKind === 'failed' || terminal.type === 'error');
  const stopped = terminal && stoppedStatuses.has(terminalKind);
  const status = failed ? 'failed' : stopped ? 'stopped' : question ? 'input' : terminal || answer ? 'done' : undefined;
  const outcome = terminal || answer;
  const activityAt = Math.max(startAt, Number(outcome?.endTime || outcome?.timestamp || 0), Number(question?.timestamp || 0));
  const turnModel = readTraceModel(mainLogs.findLast(log => readTraceModel(log))) || parseModelEntryKey(turn?.modelSelection) || undefined;
  const previousModel = turnModel || boundary < 0 ? undefined : readTraceModel(
    logs.slice(0, boundary).findLast(log => isMainTrace(log) && readTraceModel(log)),
  );
  const state = { activityAt, status, question, pendingQuestions, turnModel, previousModel } satisfies FocusTraceState;
  traceCache.set(logs, state);
  return state;
}

export function resolveFocusModel(trace: FocusTraceState | undefined, modelSelection: string | undefined) {
  return trace?.turnModel || parseModelEntryKey(modelSelection) || trace?.previousModel;
}
