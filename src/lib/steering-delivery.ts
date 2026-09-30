import { mergeUserAttachments, visibleUserRequest } from './chat-user-payload';

/** Transport receipts never own a conversation turn. Only context delivery does. */
export const normalizeAdmissionId = (value: string): string => value.replace(/^steering-turn-/, '');
export const queuedFollowUpKey = (chatId: string, id: string): string => `${chatId}:${normalizeAdmissionId(id)}`;
export function immutableUserAdmission(log: any): string {
  if (!['user_action', 'steering_received'].includes(log?.type)) return '';
  const explicit = String(log.admissionId || '').trim();
  if (explicit) return normalizeAdmissionId(explicit);
  const runId = String(log.runId || '').trim();
  const eventId = String(log.id || '').trim();
  if (log.type === 'user_action') {
    // These prefixes are app-owned admission IDs, not provider message IDs.
    // Recovery/failed-transport copies may lack the later run metadata.
    if (eventId.startsWith('user-turn-')) return normalizeAdmissionId(eventId.slice('user-turn-'.length));
    if (eventId.startsWith('queue-failed-turn:')) return normalizeAdmissionId(eventId.slice('queue-failed-turn:'.length));
    // The opening turn is the run admission even after recovery flags have
    // been cleared during hydration. Later guidance has its own turn ID;
    // never deduplicate those messages by run ID or by matching prose.
    if (runId && String(log.turnId || '') === runId) return normalizeAdmissionId(runId);
  }
  const steeringId = String(log.steeringId || '').trim();
  if (steeringId && log.turnId === `steering-turn-${steeringId}`) return normalizeAdmissionId(log.turnId);
  return '';
}

export function userAdmissionKey(log: any): string {
  const identity = immutableUserAdmission(log);
  return identity ? JSON.stringify([
    String(log?.ownerChatId || log?.chatId || ''),
    String(log?.subAgentChatId || log?.subAgentId || log?.subAgent || 'main'),
    identity,
  ]) : '';
}

export function sameUserAdmission(left: any, right: any): boolean {
  const identity = immutableUserAdmission(left);
  if (!identity || identity !== immutableUserAdmission(right)) return false;
  const owner = (log: any) => String(log.subAgentChatId || log.subAgentId || log.subAgent || 'main');
  const chat = (log: any) => String(log.ownerChatId || log.chatId || '');
  return owner(left) === owner(right) && (!chat(left) || !chat(right) || chat(left) === chat(right));
}

export function steeringMessageIds(log: any): string[] {
  const ids = [log?.steeringId, ...(Array.isArray(log?.steeringIds) ? log.steeringIds : [])];
  if (log?.type === 'user_action' && String(log?.runId || '').startsWith('steering-turn-')) {
    ids.push(String(log.runId).slice('steering-turn-'.length));
  }
  return [...new Set(ids.map(id => String(id || '').trim()).filter(Boolean))];
}

export function upsertQueuedSteering(logs: any[], incoming: any): void {
  const id = normalizeAdmissionId(String(incoming.steeringId || ''));
  const index = id ? logs.findIndex(log => log?.type === 'steering_queued' &&
    normalizeAdmissionId(String(log.steeringId || '')) === id &&
    String(log.subAgentChatId || log.subAgentId || log.subAgent || 'main') ===
      String(incoming.subAgentChatId || incoming.subAgentId || incoming.subAgent || 'main') &&
    (!(log.ownerChatId || log.chatId) || !(incoming.ownerChatId || incoming.chatId) ||
      String(log.ownerChatId || log.chatId) === String(incoming.ownerChatId || incoming.chatId))) : -1;
  if (index < 0) {
    logs.push(incoming);
    return;
  }
  const previous = logs[index];
  logs[index] = {
    ...previous,
    ...incoming,
    attachments: mergeUserAttachments(previous.attachments, incoming.attachments),
    id: previous.id || incoming.id,
    timestamp: previous.timestamp || incoming.timestamp,
    startTime: previous.startTime || incoming.startTime,
    _feedPresentationId: previous._feedPresentationId || incoming._feedPresentationId,
  };
}

/** Derive both surfaces from the saved ledger, including reconnect snapshots. */
export function projectSteeringDelivery(logs: any[]): { timeline: any[]; pending: any[] } {
  logs = reconcileQueuedTurnDelivery(logs);
  const delivered = new Map<string, any[]>();
  const matchesOwner = (left: any, right: any) => {
    const chat = (log: any) => String(log.ownerChatId || log.chatId || '');
    const worker = (log: any) => String(log.subAgentChatId || log.subAgentId || log.subAgent || 'main');
    if (chat(left) && chat(right) && chat(left) !== chat(right)) return false;
    if (worker(left) !== worker(right)) return false;
    // One client admission keeps its identity when the active run finishes
    // and transfers guidance to a successor. Run IDs may change in that handoff.
    return steeringMessageIds(left).some(id => steeringMessageIds(right)
      .some(receiptId => normalizeAdmissionId(receiptId) === normalizeAdmissionId(id)));
  };
  for (const log of logs) {
    if (['steering_received', 'steering_applied', 'steering_cancelled', 'user_action'].includes(log?.type) && log._queuedFollowUp !== true) {
      steeringMessageIds(log).forEach(rawId => {
        const id = normalizeAdmissionId(rawId);
        delivered.set(id, [...(delivered.get(id) || []), log]);
      });
    }
  }
  const queued: any[] = [];
  const timeline: any[] = [];
  for (const log of logs) {
    if (log?.type === 'steering_queued') upsertQueuedSteering(queued, log);
    else if (log?.type === 'user_action' && log._queuedFollowUp === true) continue;
    else if (log?.type !== 'steering_cancelled') timeline.push(log);
  }
  const enrichment = new Map<any, any[]>();
  const pending = queued.filter(log => {
    const matches = steeringMessageIds(log).flatMap(id => delivered.get(normalizeAdmissionId(id)) || [])
      .filter(receipt => matchesOwner(log, receipt));
    for (const receipt of matches) {
      enrichment.set(receipt, mergeUserAttachments(
        mergeUserAttachments(enrichment.get(receipt), log.attachments), receipt.attachments,
      ));
    }
    return matches.length === 0;
  });
  return {
    timeline: timeline.map(log => enrichment.has(log)
      ? { ...log, text: visibleUserRequest(log.text), attachments: enrichment.get(log) } : log),
    pending: pending
      .sort((left, right) => Number(left.startTime || left.timestamp || 0) - Number(right.startTime || right.timestamp || 0)),
  };
}

/** A saved queue flag cannot overrule work that already ran for that turn. */
export function reconcileQueuedTurnDelivery(logs: any[]): any[] {
  const activity = new Set<string>();
  const chatOwner = logs.find(log => log?.ownerChatId || log?.chatId);
  const defaultChat = String(chatOwner?.ownerChatId || chatOwner?.chatId || '');
  const scope = (log: any, id: string) => JSON.stringify([
    String(log.ownerChatId || log.chatId || defaultChat),
    String(log.subAgentChatId || log.subAgentId || log.subAgent || 'main'), id,
  ]);
  const workTypes = new Set(['answer', 'thought_stream', 'thought', 'work_note', 'command',
    'tool_call', 'file_edit', 'exploration', 'browser', 'done', 'error', 'agent_status', 'run_status']);
  for (const log of logs) {
    if (!log || !workTypes.has(log.type) || log._connection === true || log._queuedFollowUp === true) continue;
    const turn = String(log.turnId || log.runId || '').trim();
    if (turn) activity.add(scope(log, turn));
  }
  return logs.map(log => {
    if (log?.type !== 'user_action' || log._queuedFollowUp !== true) return log;
    const turn = String(log.turnId || log.runId || '').trim();
    if (!turn || !activity.has(scope(log, turn))) return log;
    return { ...log, _queuedFollowUp: false, _hiddenRecoveredBoundary: undefined };
  });
}

const settledQueueAdmissionsCache = new WeakMap<any[], Set<string>>();
export function settledQueueAdmissionIds(logs: any[]): ReadonlySet<string> {
  const cached = settledQueueAdmissionsCache.get(logs);
  if (cached) return cached;
  const ids = new Set<string>();
  const confirmedTurns = new Set(logs.filter(log => log &&
    ['answer', 'thought_stream', 'thought', 'work_note', 'command', 'tool_call', 'file_edit',
      'exploration', 'browser', 'done', 'error', 'agent_status', 'run_status'].includes(log.type) &&
    log._connection !== true && log._queuedFollowUp !== true)
    .map(log => JSON.stringify([log.subAgentChatId || log.subAgentId || log.subAgent || 'main', log.turnId || log.runId || ''])));
  for (const log of reconcileQueuedTurnDelivery(logs)) {
    if (!['user_action', 'steering_received', 'steering_applied', 'steering_cancelled'].includes(log?.type) || log._queuedFollowUp === true) continue;
    if (log.type === 'user_action') {
      // Reserving an optimistic user bubble is not proof of server delivery.
      // Otherwise the first attempt to enqueue that same draft is discarded.
      if (log._traceIdx == null && !confirmedTurns.has(JSON.stringify([
        log.subAgentChatId || log.subAgentId || log.subAgent || 'main', log.turnId || log.runId || '',
      ]))) continue;
      const admission = immutableUserAdmission(log);
      if (admission) ids.add(admission);
      if (log.runId && log.turnId === log.runId) ids.add(String(log.runId));
    }
    for (const id of steeringMessageIds(log)) {
      ids.add(id);
      ids.add(normalizeAdmissionId(id));
      ids.add(`steering-turn-${normalizeAdmissionId(id)}`);
    }
  }
  settledQueueAdmissionsCache.set(logs, ids);
  return ids;
}
