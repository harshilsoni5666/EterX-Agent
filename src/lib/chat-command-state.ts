import { appStorage } from './client-storage';
import { summarizeModelUsage } from './model-usage';

export const CHAT_PLAN_MODE_CHANGED = 'eterx-chat-plan-mode-changed';
const planKey = (chatId?: string | null) => `eterx_plan_mode:${chatId || 'new_chat'}`;
export const readChatPlanMode = (chatId?: string | null): boolean => appStorage.getItem(planKey(chatId)) === 'true';
export const writeChatPlanMode = (chatId: string | null | undefined, enabled: boolean) => {
  appStorage.setItem(planKey(chatId), String(enabled));
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CHAT_PLAN_MODE_CHANGED, { detail: chatId || 'new_chat' }));
};

const swarmKey = (chatId?: string | null) => `eterx_swarm_mode:${chatId || 'new_chat'}`;
export const readChatSwarmMode = (chatId?: string | null): boolean => appStorage.getItem(swarmKey(chatId)) === 'true';
export const writeChatSwarmMode = (chatId: string | null | undefined, enabled: boolean) => {
  appStorage.setItem(swarmKey(chatId), String(enabled));
};

/** Sum provider receipts, never context snapshots or local token estimates. */
export function summarizeChatUsage(logs: any[]) {
  return summarizeModelUsage(logs);
}
