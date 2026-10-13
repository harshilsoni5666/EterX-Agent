import { agentIdentitiesOverlap, isFeedTurnBoundary, orderFeedTimelineLogs } from './chat-feed-lifecycle';
import { selectSubAgentUsageLogs } from './chat-usage-scope';

const text = (value: unknown): string => String(value || '').trim();
const workerId = (value: any): string => text(value?.subAgentId || value?.agentId || value?.subAgentChatId || value?.id)
  .split('::sub-agent::').pop() || '';
const fullAnswer = (log: any): string => text(log?.result || log?.content || log?.answer);
const resultTypes = new Set(['sub_agent_answer', 'sub_agent_result', 'sub_agent_complete']);

/** Project one worker's ledger into the same turn/answer contract as Main. */
export function projectSubAgentFeed(logs: any[], agent: any, chatId: string | null): any[] {
  if (!agent) return [];
  const identity = workerId(agent) || text(agent.name);
  const taskTurnId = `subagent-task:${identity}`;
  const owned = selectSubAgentUsageLogs(logs, agent, chatId);
  const firstSpawn = owned.find(log => log.type === 'sub_agent_spawn' && !log._teamPollSignature);
  const task = text(firstSpawn?.task || agent.task);
  const initialTurn = (value: unknown) => {
    const turn = text(value);
    return !turn || turn.startsWith('subagent-task:') ? taskTurnId : turn;
  };
  let activeTurn = taskTurnId;
  const projected: any[] = [];
  for (const log of owned) {
    let type = text(log.type);
    let content = log.text;
    if (type === 'inter_agent_message') {
      const from = text(log.from || log.senderAgentName).toLowerCase();
      if (from === text(agent.name).toLowerCase()) {
        // Mailbox history can recover the lossless final response when an
        // older saved chat only retained the roster's completion status.
        const tags = Array.isArray(log.tags) ? log.tags : [];
        if (tags.includes('sub-agent-result') && log.payloadTruncated !== true && text(log.body || log.content)) {
          type = 'sub_agent_result';
          content = text(log.body || log.content);
        } else continue;
      } else {
        content = text(log.body || log.content || log.text);
        if (!content) continue;
        type = 'user_action';
      }
    }
    const boundary = type === 'user_action' || type === 'steering_received';
    const explicitTurn = log.type === 'inter_agent_message' && boundary
      ? `inter-agent-turn-${log.messageId || log.id}`
      : text(log.subAgentTurnId) || (boundary
        ? text(log.turnId) || `inter-agent-turn-${log.messageId || log.id}`
        : '');
    const turnId = explicitTurn ? initialTurn(explicitTurn) : activeTurn;
    if (boundary) activeTurn = turnId;
    if (type === 'sub_agent_spawn' || log._teamPollSignature && !fullAnswer(log) && !['sub_agent_error', 'sub_agent_close'].includes(type)) continue;
    if (type === 'sub_agent_action') type = 'command';
    if (type === 'sub_agent_error') {
      type = 'error';
      content = log.error || log.secondary || log.text;
    }
    if (type === 'sub_agent_pause' || type === 'sub_agent_resume') continue;
    if (type === 'sub_agent_close') type = 'agent_status';

    // Parent presentation pointers are immutable on the parent surface only.
    // Reusing them here makes the common feed put child work above its prompt.
    const {
      _feedBoundaryId, _feedBoundaryAliases, _feedTurnAliases, _feedBoundaryOrder,
      _feedEventOrder, _feedPresentationId, subAgent, subAgentId, subAgentChatId,
      isSubAgent, agentRole, rootTurnId, rootRunId, ...event
    } = log;
    projected.push({
      ...event,
      type,
      text: content,
      agentName: 'Main',
      ownerChatId: chatId || undefined,
      runId: `subagent-run:${identity}:${turnId}`,
      turnId,
      subAgentTurnId: turnId,
      ...(boundary ? { source: 'human', directToSubAgent: true } : {}),
      ...(log.type === 'sub_agent_error' ? { mainTurnTerminal: true } : {}),
      ...(log.type === 'sub_agent_close' ? { mainTurnTerminal: true, status: 'stopped' } : {}),
    });
  }

  // Roster "Done" and task summaries are status metadata, never answers.
  // Prefer the actual provider answer; completion is a lossless fallback for
  // older histories and reconnects that missed the answer stream.
  const results = new Map<string, { log: any; value: string }>();
  for (const log of projected) {
    if (!resultTypes.has(log.type)) continue;
    const result = fullAnswer(log) || (log.type !== 'sub_agent_complete' ? text(log.text) : '');
    if (!result) continue;
    const existing = results.get(log.turnId);
    if (!existing || !log._teamPollSignature && (existing.log._teamPollSignature || log.type === 'sub_agent_complete')) {
      results.set(log.turnId, { log, value: result });
    }
  }
  const answerTurns = new Set(projected.filter(log => log.type === 'answer' && text(log.text)).map(log => log.turnId));
  const feed = projected.flatMap(log => {
    if (!resultTypes.has(log.type)) return [log];
    const result = results.get(log.turnId);
    if (!result || answerTurns.has(log.turnId) || result.log !== log) return [];
    // Only one completion representation can supply a given turn's answer.
    answerTurns.add(log.turnId);
    const completedAt = log.endTime || log.timestamp;
    return [{
      ...log,
      type: 'answer',
      text: result.value,
      answerId: log.answerId || `subagent-answer:${identity}:${log.turnId}`,
      timestamp: completedAt,
      startTime: completedAt,
      isStreaming: false,
      isLiveTyping: false,
      streamState: 'closed',
    }];
  });
  if (task && !feed.some(log => isFeedTurnBoundary(log) && log.turnId === taskTurnId)) {
    const startedAt = firstSpawn?.startTime || firstSpawn?.timestamp || agent.startedAt || 1;
    feed.unshift({
      type: 'user_action', text: task, id: taskTurnId,
      ownerChatId: chatId || undefined,
      runId: `subagent-run:${identity}:${taskTurnId}`, turnId: taskTurnId,
      source: 'human', directToSubAgent: true,
      timestamp: startedAt, startTime: startedAt, endTime: startedAt,
    });
  }
  return orderFeedTimelineLogs(feed);
}

/** One launch row per worker, even when roster polling precedes live traces. */
export function reconcileSubAgentLifecycleRows(logs: any[]): any[] {
  const launches = new Map<string, { index: number; agent: any }>();
  const terminalRows = new Map<string, number>();
  const launchMembers = (log: any): any[] => {
    const members = Array.isArray(log.agentDetails) && log.agentDetails.length
      ? log.agentDetails : Array.isArray(log.spawnedAgents) ? log.spawnedAgents : [];
    return members.length ? members.map((member: any) => typeof member === 'string' ? { name: member } : member)
      : [{ ...log, name: log.agentName || log.subAgent }];
  };
  const scope = (log: any) => text(log.subAgentTurnId).startsWith('subagent-task:')
    ? text(log.turnId || log.runId)
    : text(log.subAgentTurnId || log.turnId || log.runId);
  const strongByName = new Map<string, Set<string>>();
  logs.forEach(log => {
    const members = log.type === 'sub_agent_spawn' || Array.isArray(log.spawnedAgents) ? launchMembers(log) : [{ ...log, name: log.agentName || log.subAgent }];
    members.forEach(member => {
      const id = workerId({ ...member, id: undefined });
      if (!id || !member.name) return;
      const key = `${text(log.turnId || log.runId)}:${text(member.name).toLowerCase()}`;
      const ids = strongByName.get(key) || new Set<string>();
      ids.add(id);
      strongByName.set(key, ids);
    });
  });
  const identity = (member: any, log: any) => {
    const id = workerId({ ...member, id: undefined });
    if (id) return id;
    const nameKey = `${text(log.turnId || log.runId)}:${text(member.name || member.agentName || member.subAgent).toLowerCase()}`;
    const ids = strongByName.get(nameKey);
    return ids?.size === 1 ? [...ids][0] : nameKey;
  };
  const isLaunch = (log: any) => log.type === 'sub_agent_spawn' ||
    log.type === 'command' && Array.isArray(log.spawnedAgents) && /^(?:spawning|launching)\b/i.test(text(log.text));
  logs.forEach((log, index) => {
    if (isLaunch(log)) {
      launchMembers(log).forEach(member => {
        if (!member.name) return;
        const key = identity(member, log);
        const previous = launches.get(key);
        launches.set(key, { index: previous?.index ?? index, agent: { ...previous?.agent, ...member } });
      });
    }
    if (resultTypes.has(log.type) || ['sub_agent_error', 'sub_agent_close'].includes(log.type)) {
      const key = `${identity(log, log)}:${scope(log)}`;
      const previous = terminalRows.get(key);
      if (previous === undefined || logs[previous]._teamPollSignature && !log._teamPollSignature) terminalRows.set(key, index);
    }
  });
  // A batch can arrive after the first roster entries. Consolidate its exact
  // members at the earliest launch position, preserving the visible order.
  logs.forEach((log, index) => {
    if (!isLaunch(log)) return;
    const members = launchMembers(log);
    if (members.length < 2) return;
    const keys = members.map(member => identity(member, log));
    const firstIndex = Math.min(index, ...keys.map(key => launches.get(key)?.index ?? index));
    keys.forEach(key => {
      const launch = launches.get(key);
      if (launch) launch.index = firstIndex;
    });
  });
  return logs.flatMap((log, index) => {
    if (isLaunch(log)) {
      const agents = [...launches.values()].filter(item => item.index === index).map(item => item.agent);
      return agents.length ? [{ ...log, type: 'sub_agent_spawn', agentDetails: agents, spawnedAgents: agents.map(agent => agent.name) }] : [];
    }
    if (resultTypes.has(log.type) || ['sub_agent_error', 'sub_agent_close'].includes(log.type)) {
      return terminalRows.get(`${identity(log, log)}:${scope(log)}`) === index ? [log] : [];
    }
    // Drop a count-only summary only when every completion is represented.
    // Older compacted histories may have kept just this summary.
    const batchSummary = log.type === 'command' ? text(log.text).match(/^(\d+)\/(\d+) agents completed$/i) : null;
    if (batchSummary && terminalRows.size >= Number(batchSummary[2])) return [];
    return [log];
  });
}
