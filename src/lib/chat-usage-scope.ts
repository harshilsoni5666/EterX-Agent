import { agentIdentitiesOverlap } from './chat-feed-lifecycle';

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
    if (!agentIdentitiesOverlap(log, agent)) return false;
    if (log.subAgentChatId || log.subAgentId || log.agentId) return true;
    const scope = String(log.turnId || log.runId || '').trim();
    return !agent.turnScope || !scope || scope === agent.turnScope;
  });
}

/** A child or auxiliary request never supplies the parent's current context. */
export function selectMainContextLogs(logs: any[], chatId?: string | null, agents: any[] = []): any[] {
  return logs.filter(log => traceBelongsToUsageChat(log, chatId)
    && log.auxiliaryRuntime !== true
    && !log.subAgentId && !log.subAgentChatId && log.isSubAgent !== true
    && !String(log.chatId || '').includes('::sub-agent::')
    && !['subagent', 'sub_agent', 'sub-agent'].includes(String(log.agentRole || '').toLowerCase())
    && (!log.subAgent || String(log.subAgent).toLowerCase() === 'main' || log.agentRuntime === 'agent_builder')
    && !agents.some(agent => agentIdentitiesOverlap(log, agent)));
}
