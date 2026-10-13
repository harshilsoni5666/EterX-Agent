import { modelUsageReceiptKey, readModelUsage, uniqueModelUsageLogs } from './model-usage';

export type ProfileActivityStats = {
  daily: Record<string, number>;
  models: Record<string, number>;
  reasoning: Record<string, number>;
  skillsExplored: number;
  totalSkillsUsed: number;
};

export const EMPTY_PROFILE_ACTIVITY: ProfileActivityStats = {
  daily: {}, models: {}, reasoning: {}, skillsExplored: 0, totalSkillsUsed: 0,
};

export function activityTimestamp(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric)
    ? numeric < 10_000_000_000 ? numeric * 1000 : numeric
    : typeof value === 'string' ? Date.parse(value) : 0;
  return timestamp > 0 && Number.isFinite(new Date(timestamp).getTime()) ? timestamp : 0;
}

/** Calendar keys stay in local time, including across daylight-saving changes. */
export function activityDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function activityDate(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function activityDayDistance(start: Date, end: Date): number {
  return Math.round((Date.UTC(end.getFullYear(), end.getMonth(), end.getDate())
    - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86_400_000);
}

/** Rebuild from all saved history; a new month never trims or resets past data. */
export function buildProfileActivity(chats: any[]): ProfileActivityStats {
  const daily: Record<string, number> = Object.create(null);
  const models: Record<string, number> = Object.create(null);
  const reasoning: Record<string, number> = Object.create(null);
  const receipts = new Set<string>();
  const skills = new Set<string>();
  let totalSkillsUsed = 0;

  for (const chat of chats) {
    if (!chat || typeof chat !== 'object') continue;
    const logs = Array.isArray(chat.traceLogs) ? chat.traceLogs : [];
    for (const log of uniqueModelUsageLogs(logs)) {
      const count = readModelUsage(log).processedTokens;
      if (!Number.isFinite(count) || count <= 0) continue;
      // Only globally unique usage IDs can be deduplicated across chat copies.
      const receipt = log.usageId ? modelUsageReceiptKey(log) : null;
      if (receipt && receipts.has(receipt)) continue;
      if (receipt) receipts.add(receipt);
      const timestamp = activityTimestamp(log.timestamp) || activityTimestamp(log.endTime)
        || activityTimestamp(log.startTime) || activityTimestamp(chat.createdAt) || activityTimestamp(chat.updatedAt);
      if (timestamp) {
        const day = activityDayKey(new Date(timestamp));
        daily[day] = (daily[day] || 0) + count;
      }
      // Background titles count toward token activity, but not model preferences.
      if (log.phase === 'chat_title' || log.auxiliaryRuntime === true) continue;
      const model = String(log.model || log.modelId || '').trim();
      if (model) models[model] = (models[model] || 0) + 1;
      const level = String(log.thinkingLevel ?? log.selectedThinkingLevel
        ?? log.reasoningEffort ?? log.reasoning_effort ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
      if (level) {
        const normalized = ['extra_high', 'extrahigh'].includes(level) ? 'xhigh' : level;
        reasoning[normalized] = (reasoning[normalized] || 0) + 1;
      }
    }

    // Start/completion/replay events for one skill invocation count only once.
    const skillCalls = new Map<string, any>();
    logs.forEach((log: any, index: number) => {
      if (!log || String(log.tool || log.toolName || log.name || '') !== 'get_skill_guidelines') return;
      const worker = log.subAgentChatId || log.subAgentId || log.agentId || '';
      const identity = log.toolCallId || log.traceId || log.id || log.startTime || `legacy-${index}`;
      const key = JSON.stringify([log.runId || log.turnId || '', worker, identity]);
      skillCalls.set(key, { ...skillCalls.get(key), ...log });
    });
    for (const log of skillCalls.values()) {
      const status = String(log.status || '').toLowerCase();
      if (!['complete', 'completed', 'success', 'succeeded', 'done'].includes(status)) continue;
      if (log.error || log.success === false || log.output?.error || log.output?.success === false) continue;
      let args = log.toolArgs || log.args || log.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = null; }
      }
      const skill = String(args?.skill_name || log.skillName || log.skillId || log.secondary || '')
        .trim().toLowerCase().replace(/-/g, '_');
      if (!skill) continue;
      skills.add(skill);
      totalSkillsUsed += 1;
    }
  }
  return { daily, models, reasoning, skillsExplored: skills.size, totalSkillsUsed };
}

export function mostUsedActivityValue(counts: Record<string, number>) {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  return entries.length ? { name: entries[0][0], percent: Math.round(entries[0][1] / total * 100) } : null;
}
