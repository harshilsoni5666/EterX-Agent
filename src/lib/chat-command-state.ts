import { appStorage } from './client-storage';
import { summarizeModelUsage } from './model-usage';

const planKey = (chatId?: string | null) => `eterx_plan_mode:${chatId || 'new_chat'}`;
export const readChatPlanMode = (chatId?: string | null): boolean => appStorage.getItem(planKey(chatId)) === 'true';
export const writeChatPlanMode = (chatId: string | null | undefined, enabled: boolean) => {
  appStorage.setItem(planKey(chatId), String(enabled));
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
