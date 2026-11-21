import { agentIdentitiesOverlap } from './chat-feed-lifecycle';
import { contextWorkerId } from './context-usage-snapshot';

/** The supplied history belongs to this chat; legacy rows can lack ownership fields. */
export function traceBelongsToUsageChat(log: any, chatId?: string | null): boolean {
  if (!log) return false;
  const target = String(chatId || '').trim();
  const owner = String(log.ownerChatId || log.chatId || '').trim();
  if (!owner) return true;
  return Boolean(target && (owner === target || owner.startsWith(`${target}::sub-agent::`)));
}

export function selectSubAgentUsageLogs(logs: any[], agent: any, chatId?: string | null): any[] {
  if (!agent) return [];
  return logs.filter(log => {
    if (!traceBelongsToUsageChat(log, chatId)) return false;
    const child = contextWorkerId(log);
    if (!agentIdentitiesOverlap(child && !log.subAgentId && !log.subAgentChatId ? { ...log, subAgentChatId: child } : log, agent)) return false;
    if (child || log.agentId) return true;
    const scope = String(log.turnId || log.runId || '').trim();
    return !agent.turnScope || !scope || scope === agent.turnScope;
  });
}

/** A child or auxiliary request never supplies the parent's current context. */
export function selectMainContextLogs(logs: any[], chatId?: string | null, agents: any[] = []): any[] {
  return logs.filter(log => traceBelongsToUsageChat(log, chatId)
    && log.auxiliaryRuntime !== true
    && !contextWorkerId(log) && log.isSubAgent !== true
    && !['subagent', 'sub_agent', 'sub-agent'].includes(String(log.agentRole || '').toLowerCase())
    && (!log.subAgent || String(log.subAgent).toLowerCase() === 'main' || log.agentRuntime === 'agent_builder')
    && !agents.some(agent => agentIdentitiesOverlap(log, agent)));
}
