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

const normalizedText = (value: unknown, max = Number.POSITIVE_INFINITY): string => {
  const text = String(value || '').replace(/\u0000/g, '').trim();
  return Number.isFinite(max) ? text.slice(0, max) : text;
};

const isProxyOnlyBoundary = (log: any): boolean =>
  log?.type === 'user_action' &&
  (log?.source === 'user_proxy' || log?.source === 'proxy_manager') &&
  Boolean(log?.steeringId || (Array.isArray(log?.steeringIds) && log.steeringIds.length > 0));

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
  const turns = logs.flatMap((log: any, index: number): PersistedDialogueTurn[] => {
    if (isProxyOnlyBoundary(log)) return [];
    const role = log?.type === 'user_action'
      ? 'user'
      : log?.type === 'answer' && log?.streamState !== 'open' && log?.isStreaming !== true
        ? 'assistant'
        : null;
    if (!role) return [];
    const text = normalizedText(log?.text);
    if (!text) return [];
    const rawId = normalizedText(log?.id || log?.answerId || log?.turnId || log?.runId, 500);
    const originId = rawId
      ? `chat-trace:${rawId}:${role}`
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
  try {
    const chat = await loadChatById(stableChatId);
    if (!chat) return 0;
    return fabric.importDialogueTurns(extractPersistedDialogueTurns(chat, currentRequest));
  } catch {
    return 0;
  }
}
