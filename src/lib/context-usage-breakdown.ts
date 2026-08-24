export type ContextUsageBreakdown = {
  systemPrompt: number;
  toolDefinitions: number;
  rules: number;
  skills: number;
  mcpDynamicTools: number;
  subagentDefinitions: number;
  conversation: number;
  providerOverhead: number;
};

export type ContextUsageBreakdownSources = {
  systemPrompt?: string;
  rules?: string;
  skills?: string;
  subagentDefinitions?: string;
};

export type ContextUsageCategoryKey = keyof ContextUsageBreakdown;

export const CONTEXT_USAGE_CATEGORIES: Array<{
  key: ContextUsageCategoryKey;
  label: string;
  color: string;
}> = [
  { key: 'systemPrompt', label: 'System prompt', color: '#A3A3A3' },
  { key: 'toolDefinitions', label: 'Tool definitions', color: '#B07EE8' },
  { key: 'rules', label: 'Rules', color: '#6BB87B' },
  { key: 'skills', label: 'Skills', color: '#C4A882' },
  { key: 'mcpDynamicTools', label: 'MCP & dynamic tools', color: '#B38BAD' },
  { key: 'subagentDefinitions', label: 'Subagent definitions', color: '#6B9FD4' },
  { key: 'conversation', label: 'Conversation', color: '#E57373' },
  { key: 'providerOverhead', label: 'Provider framing', color: '#7E8793' },
];

const estimateTokensFromText = (value: unknown): number => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(Math.max(0, text.length) / 4);
};

const MCP_DYNAMIC_TOOL_NAME = /^(?:mcp(?:__|_|$)|connector(?:__|_|$)|connector_mcp$|gateway_bridge$|channel_agent$|agent_tool(?:__|_|$))/i;
const SUBAGENT_TOOL_NAME = /^(?:spawn_sub_agent|agent_communicate|sub_agent(?:_|$))/i;
const SKILL_TOOL_NAMES = new Set(['get_skill_guidelines', 'skill_loader']);

const toolDeclarationsFrom = (tools: unknown): unknown[] => {
  if (!Array.isArray(tools)) return tools ? [tools] : [];
  const declarations: unknown[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      declarations.push(tool);
      continue;
    }
    const record = tool as Record<string, any>;
    if (Array.isArray(record.functionDeclarations)) declarations.push(...record.functionDeclarations);
    else if (record.function && typeof record.function === 'object') declarations.push(record.function);
    else declarations.push(record);
  }
  return declarations;
};

const measureToolSections = (tools: unknown): {
  toolDefinitions: number;
} => {
  return {
    // Every declaration is a schema paid for on the request, regardless of
    // whether the model invokes it. Activity categories below account only
    // for calls/results actually retained in the conversation.
    toolDefinitions: estimateTokensFromText(toolDeclarationsFrom(tools)),
  };
};

const collectProviderToolReferences = (
  value: unknown,
  toolUseNames: Map<string, string>,
  names = new Set<string>(),
  seen = new WeakSet<object>(),
): Set<string> => {
  if (!value || typeof value !== 'object') return names;
  if (seen.has(value as object)) return names;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const item of value) collectProviderToolReferences(item, toolUseNames, names, seen);
    return names;
  }

  const record = value as Record<string, any>;
  const add = (candidate: unknown) => {
    const normalized = String(candidate || '').trim().toLowerCase();
    if (normalized) names.add(normalized);
    return normalized;
  };
  const remember = (id: unknown, name: unknown) => {
    const normalizedId = String(id || '').trim();
    const normalizedName = add(name);
    if (normalizedId && normalizedName) toolUseNames.set(normalizedId, normalizedName);
  };

  if (record.functionCall && typeof record.functionCall === 'object') {
    remember(record.functionCall.id || record.functionCall.call_id, record.functionCall.name);
  }
  if (record.functionResponse && typeof record.functionResponse === 'object') {
    add(record.functionResponse.name);
  }
  if (record.type === 'tool_use' || record.type === 'function_call') {
    remember(record.id || record.call_id, record.name);
  }
  if (record.type === 'tool_result' || record.type === 'function_call_output') {
    const referencedName = toolUseNames.get(String(record.tool_use_id || record.call_id || '').trim());
    if (referencedName) names.add(referencedName);
  }
  if (record.role === 'tool') add(record.name || record.tool_name);
  if (Array.isArray(record.tool_calls)) {
    for (const call of record.tool_calls) {
      remember(call?.id || call?.call_id, call?.function?.name || call?.name);
    }
  }

  // Recurse only through provider protocol containers. Arbitrary tool output
  // can contain business objects with a `name` field and must never be
  // mistaken for another tool invocation.
  if (Array.isArray(record.parts)) {
    collectProviderToolReferences(record.parts, toolUseNames, names, seen);
  }
  if (Array.isArray(record.content)) {
    collectProviderToolReferences(record.content, toolUseNames, names, seen);
  }
  return names;
};

const measureConversationSections = (contents: unknown[]): {
  conversation: number;
  skills: number;
  subagents: number;
  mcpDynamicTools: number;
} => {
  const measured = { conversation: 0, skills: 0, subagents: 0, mcpDynamicTools: 0 };
  const toolUseNames = new Map<string, string>();
  collectProviderToolReferences(contents, toolUseNames);
  const addMeasuredValue = (value: unknown) => {
    const toolNames = collectProviderToolReferences(value, toolUseNames);
    const tokens = estimateTokensFromText(value);
    if ([...toolNames].some(name => SKILL_TOOL_NAMES.has(name))) measured.skills += tokens;
    else if ([...toolNames].some(name => SUBAGENT_TOOL_NAME.test(name))) measured.subagents += tokens;
    else if ([...toolNames].some(name => MCP_DYNAMIC_TOOL_NAME.test(name))) measured.mcpDynamicTools += tokens;
    else measured.conversation += tokens;
  };
  for (const turn of Array.isArray(contents) ? contents : []) {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) {
      addMeasuredValue(turn);
      continue;
    }
    const record = turn as Record<string, unknown>;
    const segmentedKey = Array.isArray(record.parts)
      ? 'parts'
      : Array.isArray(record.content) ? 'content' : '';
    if (!segmentedKey) {
      addMeasuredValue(turn);
      continue;
    }

    // Gemini and Anthropic can mix text with tool calls/results in one turn.
    // Attribute each part independently so a small skill load does not turn
    // the assistant's entire response into "Skills".
    const segments = record[segmentedKey] as unknown[];
    const envelope = { ...record, [segmentedKey]: [] };
    measured.conversation += estimateTokensFromText(envelope);
    for (const segment of segments) addMeasuredValue(segment);
  }
  return measured;
};

const UPPER_HEADING = /^[A-Z][A-Z0-9 /&()'._-]{2,}:?$/;
const RULE_HEADING = /(?:RULE|PRIORITY|PROTOCOL|CONTRACT|BOUNDARY|EXECUTION|FILESYSTEM|WORK NOTES|TRUTHFUL|CORRECTION|ANTI-|VERIFICATION|AUTONOM|RESPONSE|MULTI-TOOL|TASK PROTOCOL|CONTEXT MANAGEMENT)/;

const measureSystemSections = (systemInstruction: unknown): {
  systemPrompt: number;
  rules: number;
  skills: number;
  subagentDefinitions: number;
} => {
  const text = typeof systemInstruction === 'string'
    ? systemInstruction
    : JSON.stringify(systemInstruction || '');
  const buckets = { systemPrompt: '', rules: '', skills: '', subagentDefinitions: '' };
  let category: keyof typeof buckets = 'systemPrompt';
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = index < lines.length - 1 ? `${lines[index]}\n` : lines[index];
    const heading = line.trim();
    if (UPPER_HEADING.test(heading)) {
      if (/SKILL PATHWAYS/.test(heading)) category = 'systemPrompt';
      else if (/SKILLS?\b/.test(heading)) category = 'skills';
      else if (/SUB-?AGENTS?\b/.test(heading)) category = 'subagentDefinitions';
      else if (RULE_HEADING.test(heading)) category = 'rules';
      else category = 'systemPrompt';
    }
    buckets[category] += line;
  }
  return {
    systemPrompt: estimateTokensFromText(buckets.systemPrompt),
    rules: estimateTokensFromText(buckets.rules),
    skills: estimateTokensFromText(buckets.skills),
    subagentDefinitions: estimateTokensFromText(buckets.subagentDefinitions),
  };
};

export const buildContextUsageBreakdown = (input: {
  contents?: unknown[];
  tools?: unknown;
  systemInstruction?: unknown;
  breakdownSources?: ContextUsageBreakdownSources;
}): ContextUsageBreakdown => {
  const measuredConversation = measureConversationSections(input.contents || []);
  const measuredSystem = measureSystemSections(input.systemInstruction);
  const measuredTools = measureToolSections(input.tools);
  const rules = input.breakdownSources?.rules
    ? estimateTokensFromText(input.breakdownSources.rules)
    : measuredSystem.rules;
  const skills = input.breakdownSources?.skills
    ? estimateTokensFromText(input.breakdownSources.skills)
    : measuredConversation.skills;
  const subagentDefinitions = input.breakdownSources?.subagentDefinitions
    ? estimateTokensFromText(input.breakdownSources.subagentDefinitions)
    : measuredConversation.subagents;
  const systemPrompt = input.breakdownSources?.systemPrompt
    ? estimateTokensFromText(input.breakdownSources.systemPrompt)
    : measuredSystem.systemPrompt + measuredSystem.skills + measuredSystem.subagentDefinitions;

  return {
    systemPrompt,
    toolDefinitions: measuredTools.toolDefinitions,
    rules,
    skills,
    mcpDynamicTools: measuredConversation.mcpDynamicTools,
    subagentDefinitions,
    conversation: measuredConversation.conversation,
    providerOverhead: 0,
  };
};

export const normalizeContextUsageBreakdown = (
  breakdown: Partial<ContextUsageBreakdown> | null | undefined,
  usedTokens: number,
): ContextUsageBreakdown => {
  const normalized: ContextUsageBreakdown = {
    systemPrompt: Math.max(0, Math.round(Number(breakdown?.systemPrompt || 0))),
    toolDefinitions: Math.max(0, Math.round(Number(breakdown?.toolDefinitions || 0))),
    rules: Math.max(0, Math.round(Number(breakdown?.rules || 0))),
    skills: Math.max(0, Math.round(Number(breakdown?.skills || 0))),
    mcpDynamicTools: Math.max(0, Math.round(Number(breakdown?.mcpDynamicTools || 0))),
    subagentDefinitions: Math.max(0, Math.round(Number(breakdown?.subagentDefinitions || 0))),
    conversation: Math.max(0, Math.round(Number(breakdown?.conversation || 0))),
    providerOverhead: Math.max(0, Math.round(Number(breakdown?.providerOverhead || 0))),
  };

  const total = Object.values(normalized).reduce((sum, value) => sum + value, 0);
  const safeUsedTokens = Math.max(0, Math.round(Number(usedTokens || 0)));
  if (safeUsedTokens <= 0) {
    return Object.fromEntries(
      (Object.keys(normalized) as ContextUsageCategoryKey[]).map(key => [key, 0]),
    ) as ContextUsageBreakdown;
  }
  if (total <= 0) {
    normalized.providerOverhead = safeUsedTokens;
    return normalized;
  }
  if (total < safeUsedTokens) {
    normalized.providerOverhead += safeUsedTokens - total;
    return normalized;
  }
  if (total === safeUsedTokens) return normalized;

  const scale = safeUsedTokens / total;
  const scaled = Object.fromEntries(
    (Object.keys(normalized) as ContextUsageCategoryKey[])
      .map(key => [key, Math.floor(normalized[key] * scale)]),
  ) as ContextUsageBreakdown;
  const assigned = Object.values(scaled).reduce((sum, value) => sum + value, 0);
  scaled.providerOverhead += safeUsedTokens - assigned;
  return scaled;
};

export const deriveEstimatedContextUsageBreakdown = (input: {
  usedTokens: number;
  systemTokens?: number;
  toolTokens?: number;
  conversationTokens?: number;
  customInstructions?: string;
  subAgentCount?: number;
  loadedSkillCount?: number;
}): ContextUsageBreakdown => {
  const usedTokens = Math.max(0, Math.round(input.usedTokens || 0));
  const toolDefinitions = Math.max(0, Math.round(Number(input.toolTokens || 0)));
  const rules = Math.ceil(String(input.customInstructions || '').trim().length / 4);
  const loadedSkillCount = Math.max(0, Math.round(Number(input.loadedSkillCount || 0)));
  const skills = loadedSkillCount > 0 ? Math.round(loadedSkillCount * 320) : 0;
  const mcpDynamicTools = 0;
  const subagentDefinitions = Math.max(0, Math.round(Math.max(0, input.subAgentCount || 0) * 220));
  const systemTokens = Math.max(0, Math.round(Number(input.systemTokens || 0)));
  const systemPrompt = systemTokens > 0
    ? Math.max(320, systemTokens - rules - skills - subagentDefinitions)
    : 450;
  const conversation = Math.max(
    0,
    Math.round(Number(input.conversationTokens || 0))
      || Math.max(0, usedTokens - systemPrompt - toolDefinitions - rules - skills - subagentDefinitions),
  );

  return normalizeContextUsageBreakdown({
    systemPrompt,
    toolDefinitions: toolDefinitions || Math.min(6900, Math.max(0, usedTokens - conversation - systemPrompt - rules - skills - mcpDynamicTools - subagentDefinitions)),
    rules,
    skills,
    mcpDynamicTools,
    subagentDefinitions,
    conversation,
    providerOverhead: 0,
  }, usedTokens);
};

export const formatContextUsageTokenCount = (value: number, options?: { prefixTilde?: boolean }) => {
  const safeValue = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  const prefix = options?.prefixTilde ? '~' : '';
  if (safeValue < 1_000) return `${prefix}${safeValue.toLocaleString()}`;
  if (safeValue >= 1_000_000) {
    const formatted = (safeValue / 1_000_000).toFixed(safeValue >= 10_000_000 ? 0 : 1).replace(/\.0$/, '');
    return `${prefix}${formatted}M`;
  }
  const formatted = (safeValue / 1_000).toFixed(safeValue >= 10_000 ? 0 : 1).replace(/\.0$/, '');
  return `${prefix}${formatted}K`;
};

export const sumContextUsageBreakdown = (breakdown: ContextUsageBreakdown): number =>
  Object.values(breakdown).reduce((sum, value) => sum + value, 0);
