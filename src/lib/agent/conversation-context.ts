import { createHash } from 'crypto';
import { loadChatById } from '../chat-store';
import type { ContextFabric } from './context-fabric';

export type PersistedDialogueTurn = {
  originId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt?: number;
};

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const activeTranscriptHydrations = new WeakMap<ContextFabric, Promise<number>>();
const transcriptHydrationState = new WeakMap<ContextFabric, {
  traceCount: number;
  tailIdentity: string;
}>();

const normalizedText = (value: unknown, max = Number.POSITIVE_INFINITY): string => {
  const text = String(value || '').replace(/\u0000/g, '').trim();
  return Number.isFinite(max) ? text.slice(0, max) : text;
};

const isProxyOnlyBoundary = (log: any): boolean =>
  log?.type === 'user_action' &&
  (log?.source === 'user_proxy' || log?.source === 'proxy_manager') &&
  Boolean(log?.steeringId || (Array.isArray(log?.steeringIds) && log.steeringIds.length > 0));

const traceIdentity = (log: any, index: number): string => hash([
  index,
  normalizedText(log?.id || log?.answerId || log?.turnId || log?.runId, 500),
  normalizedText(log?.type, 80),
  normalizedText(log?.streamState, 40),
  log?.isStreaming === true ? '1' : '0',
  normalizedText(log?.text),
].join('\u0000'));

const extractPersistedDialogueTurnsFromLogs = (
  logs: any[],
  currentRequest: string,
  startIndex: number,
): PersistedDialogueTurn[] => {
  const safeStart = Math.max(0, Math.min(logs.length, Math.floor(startIndex)));
  const turns = logs.slice(safeStart).flatMap((log: any, localIndex: number): PersistedDialogueTurn[] => {
    if (isProxyOnlyBoundary(log)) return [];
    const role = log?.type === 'user_action' || log?.type === 'steering_received'
      ? 'user'
      : log?.type === 'answer' && log?.streamState !== 'open' && log?.isStreaming !== true
        ? 'assistant'
        : null;
    if (!role) return [];
    const text = normalizedText(log?.text);
    if (!text) return [];
    const rawId = normalizedText(log?.id || log?.answerId || log?.turnId || log?.runId, 500);
    const runId = normalizedText(log?.runId, 220);
    // The optimistic and server root bubble use user-turn-${runId}, whereas
    // the live fabric owns user-run:${runId}. Canonicalize only that exact
    // root identity; steering and repeated messages must keep distinct IDs.
    const dialogueId = role === 'user' && runId && rawId === `user-turn-${runId}`
      && (!log?.turnId || log.turnId === runId)
      ? runId
      : rawId;
    const index = safeStart + localIndex;
    const originId = dialogueId
      ? `chat-trace:${dialogueId}:${role}`
      : `chat-legacy:${index}:${role}:${hash(text).slice(0, 20)}`;
    const timestamp = Number(log?.timestamp || log?.endTime || log?.startTime || 0);
    return [{
      originId,
      role,
      text,
      ...(Number.isFinite(timestamp) && timestamp > 0 ? { createdAt: timestamp } : {}),
    }];
  });

  // The renderer persists the optimistic current user bubble before starting
  // the server run. observeUserRequest() owns that live turn, so do not import
  // the same unpaired bubble as historical dialogue.
  const current = normalizedText(currentRequest);
  const last = turns[turns.length - 1];
  if (current && last?.role === 'user' && last.text === current) turns.pop();
  return turns;
};

/**
 * Convert the durable, user-visible chat snapshot into stable dialogue pages.
 * Tool traces and thoughts already have richer Context Fabric records, so this
 * importer deliberately handles only human messages and settled answers.
 */
export function extractPersistedDialogueTurns(
  chat: unknown,
  currentRequest = '',
): PersistedDialogueTurn[] {
  const logs = Array.isArray((chat as any)?.traceLogs) ? (chat as any).traceLogs : [];
  return extractPersistedDialogueTurnsFromLogs(logs, currentRequest, 0);
}

/**
 * One-way recovery bridge from the durable chat transcript to Context Fabric.
 * Failures are advisory: a live request must still run with the fabric state
 * and client tail already available.
 */
export async function hydratePersistedConversationContext(
  fabric: ContextFabric,
  chatId: string,
  currentRequest = '',
): Promise<number> {
  const stableChatId = normalizedText(chatId, 500);
  if (!stableChatId) return 0;
  const activeHydration = activeTranscriptHydrations.get(fabric);
  if (activeHydration) return activeHydration;
  const hydration = (async () => {
    const chat = await loadChatById(stableChatId);
    if (!chat) return 0;
    const logs = Array.isArray((chat as any)?.traceLogs) ? (chat as any).traceLogs : [];
    const previous = transcriptHydrationState.get(fabric);
    const prefixUnchanged = Boolean(
      previous
      && previous.traceCount <= logs.length
      && (
        previous.traceCount === 0
        || traceIdentity(logs[previous.traceCount - 1], previous.traceCount - 1) === previous.tailIdentity
      ),
    );
    // Revisit a tiny overlap because the last persisted answer can transition
    // from an open stream to settled text without increasing trace count. The
    // fabric's origin index makes this overlap constant-time and idempotent.
    const startIndex = prefixUnchanged ? Math.max(0, previous!.traceCount - 2) : 0;
    const imported = fabric.importDialogueTurns(
      extractPersistedDialogueTurnsFromLogs(logs, currentRequest, startIndex),
    );
    transcriptHydrationState.set(fabric, {
      traceCount: logs.length,
      tailIdentity: logs.length > 0 ? traceIdentity(logs[logs.length - 1], logs.length - 1) : '',
    });
    return imported;
  })();
  activeTranscriptHydrations.set(fabric, hydration);
  try {
    return await hydration;
  } catch {
    return 0;
  } finally {
    if (activeTranscriptHydrations.get(fabric) === hydration) {
      activeTranscriptHydrations.delete(fabric);
    }
  }
}
