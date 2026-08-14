export type ChatAgentSelection = {
  agentId: string | null;
  agentName: string;
  chatMode?: boolean;
};

export const GENERAL_AGENT_SELECTION: ChatAgentSelection = Object.freeze({
  agentId: null,
  agentName: 'General',
  chatMode: false,
});

export const normalizeChatAgentSelection = (value?: Partial<ChatAgentSelection> | null): ChatAgentSelection => {
  const chatMode = value?.chatMode === true;
  const agentId = chatMode ? null : String(value?.agentId || '').trim() || null;
  const agentName = chatMode
    ? 'Chat'
    : agentId
      ? String(value?.agentName || '').trim() || (agentId === 'coding' ? 'Coding' : agentId)
      : 'General';
  return { agentId, agentName, chatMode };
};

export const chatAgentSelectionsEqual = (
  left?: Partial<ChatAgentSelection> | null,
  right?: Partial<ChatAgentSelection> | null,
): boolean => {
  const normalizedLeft = normalizeChatAgentSelection(left);
  const normalizedRight = normalizeChatAgentSelection(right);
  return normalizedLeft.agentId === normalizedRight.agentId
    && normalizedLeft.chatMode === normalizedRight.chatMode;
};

/**
 * Recover the runtime identity that owns the currently active turn. New user
 * boundaries carry an explicit selection. The trace fallback keeps custom
 * agent runs created by older clients distinguishable after rehydration.
 */
export const findActiveRunAgentSelection = (
  logs: any[],
  runId?: string | null,
): ChatAgentSelection | null => {
  const safeLogs = Array.isArray(logs) ? logs : [];
  const normalizedRunId = String(runId || '').trim();
  const matching = normalizedRunId
    ? safeLogs.filter(log => String(log?.runId || log?.turnId || '').trim() === normalizedRunId)
    : safeLogs;
  const boundary = [...matching].reverse().find(log => log?.type === 'user_action');
  if (boundary && (
    boundary.selectedAgentId !== undefined
    || boundary.selectedAgentName !== undefined
    || boundary.chatMode !== undefined
  )) {
    return normalizeChatAgentSelection({
      agentId: boundary.selectedAgentId ?? null,
      agentName: boundary.selectedAgentName,
      chatMode: boundary.chatMode === true,
    });
  }

  const customTrace = [...matching].reverse().find(log => String(log?.customAgentId || '').trim());
  if (customTrace) {
    return normalizeChatAgentSelection({
      agentId: String(customTrace.customAgentId).trim(),
      agentName: customTrace.agentName || customTrace.customAgentName || customTrace.customAgentId,
    });
  }

  return null;
};

export const shouldQueueForAgentSwitch = (
  logs: any[],
  runId: string | null | undefined,
  requestedSelection: Partial<ChatAgentSelection> | null | undefined,
): boolean => {
  const activeSelection = findActiveRunAgentSelection(logs, runId);
  return Boolean(
    activeSelection && !chatAgentSelectionsEqual(activeSelection, requestedSelection),
  );
};
