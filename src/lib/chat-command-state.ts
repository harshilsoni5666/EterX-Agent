import { appStorage } from './client-storage';

const planKey = (chatId?: string | null) => `eterx_plan_mode:${chatId || 'new_chat'}`;
export const readChatPlanMode = (chatId?: string | null): boolean => appStorage.getItem(planKey(chatId)) === 'true';
export const writeChatPlanMode = (chatId: string | null | undefined, enabled: boolean) => {
  appStorage.setItem(planKey(chatId), String(enabled));
};

/** Sum provider receipts, never context snapshots or local token estimates. */
export function summarizeChatUsage(logs: any[]) {
  const seen = new Set<string>();
  let input = 0, output = 0, cached = 0, cacheMeasuredInput = 0;
  const count = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  for (const log of logs) {
    if (log?.type !== 'model_usage') continue;
    const key = String(log.usageId || `${log.runId || ''}:${log.provider || ''}:${log.model || ''}:${log.phase || ''}:${log.interaction ?? ''}:${log.timestamp || ''}:${log.promptTokens ?? log.inputTokens}:${log.completionTokens ?? log.outputTokens}`);
    if (seen.has(key)) continue;
    seen.add(key);
    const prompt = count(log.promptTokens ?? log.inputTokens);
    input += prompt;
    output += count(log.completionTokens ?? log.outputTokens);
    if (log.cacheTokensMeasured !== undefined ? Number(log.cacheTokensMeasured) > 0 : log.cachedTokens !== undefined || log.cacheHitRatio !== undefined) {
      cached += Math.min(prompt, count(log.cachedTokens ?? prompt * count(log.cacheHitRatio)));
      cacheMeasuredInput += prompt;
    }
  }
  return { input, output, total: input + output, cacheHitRate: cacheMeasuredInput ? cached / cacheMeasuredInput : null };
}
