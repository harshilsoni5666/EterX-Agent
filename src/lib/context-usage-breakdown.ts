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

export const serializeContextValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  const ancestors = new WeakSet<object>();
  const normalize = (candidate: unknown): unknown => {
    if (candidate === null || candidate === undefined) return candidate ?? null;
    if (typeof candidate === 'bigint') return `${candidate.toString()}n`;
    if (typeof candidate === 'function') return `[Function ${candidate.name || 'anonymous'}]`;
    if (typeof candidate === 'symbol') return candidate.toString();
    if (typeof candidate !== 'object') return candidate;
    if (ancestors.has(candidate)) return '[Circular reference]';
    ancestors.add(candidate);
    try {
      if (candidate instanceof Date) return candidate.toISOString();
      if (candidate instanceof Error) {
        const cause = (candidate as Error & { cause?: unknown }).cause;
        return {
          name: candidate.name,
          message: candidate.message,
          stack: candidate.stack,
          ...(cause !== undefined ? { cause: normalize(cause) } : {}),
        };
      }
      if (candidate instanceof Map) {
        return Array.from(candidate.entries()).map(([key, entry]) => [normalize(key), normalize(entry)]);
      }
      if (candidate instanceof Set) return Array.from(candidate.values()).map(normalize);
      if (Array.isArray(candidate)) return candidate.map(normalize);
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(candidate as Record<string, unknown>)) {
        try {
          normalized[key] = normalize((candidate as Record<string, unknown>)[key]);
        } catch {
          normalized[key] = '[Unreadable property]';
        }
      }
      return normalized;
    } finally {
      // Only recursive ancestry is circular. A shared object referenced by two
      // independent messages must be serialized twice instead of losing the
      // second occurrence as a false cycle.
      ancestors.delete(candidate);
    }
  };
  try {
    const serialized = JSON.stringify(normalize(value ?? ''));
    return typeof serialized === 'string' ? serialized : String(serialized ?? '');
  } catch {
    try {
      return String(value ?? '');
    } catch {
      return '[Unserializable context value]';
    }
  }
};

const embeddedMediaTokenEstimate = (mimeType: string, encodedCharacters: number): number => {
  const approximateBytes = Math.max(0, Math.floor(encodedCharacters * 0.75));
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) {
    return Math.max(256, Math.min(8_192, Math.ceil(approximateBytes / 512)));
  }
  if (mime === 'application/pdf' || /(?:document|text|json|xml|csv)/.test(mime)) {
    return Math.max(1_000, Math.min(64_000, Math.ceil(approximateBytes / 8)));
  }
  if (mime.startsWith('audio/') || mime.startsWith('video/')) {
    return Math.max(1_000, Math.min(64_000, Math.ceil(approximateBytes / 64)));
  }
  return Math.max(256, Math.min(16_000, Math.ceil(approximateBytes / 32)));
};

/**
 * Provider wire payloads may contain megabytes of base64, but multimodal
 * models account for those inputs as media tokens rather than tokenizing the
 * transport string. Replace only recognizable embedded binary carriers with
 * a bounded token-weight placeholder; ordinary text and structured tool data
 * retain the exact serializer above. Provider-reported input usage remains
 * authoritative after the request.
 */
export const serializeContextValueForMeasurement = (value: unknown): string => {
  const ancestors = new WeakSet<object>();
  const mediaPlaceholder = (mimeType: string, encodedCharacters: number) => {
    const tokens = embeddedMediaTokenEstimate(mimeType, encodedCharacters);
    return `[Embedded ${mimeType || 'binary'} media: estimated ${tokens} context tokens]\n${'x'.repeat(tokens * 4)}`;
  };
  const normalize = (candidate: unknown, key = '', parentMimeType = ''): unknown => {
    if (typeof candidate === 'string') {
      const dataUrl = candidate.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/is);
      if (dataUrl) return mediaPlaceholder(dataUrl[1] || parentMimeType, dataUrl[2].length);
      if (
        candidate.length > 2_048
        && /^(?:data|file_data|base64)$/i.test(key)
        && /^[A-Za-z0-9+/=_\r\n-]+$/.test(candidate.slice(0, Math.min(candidate.length, 4_096)))
      ) {
        return mediaPlaceholder(parentMimeType, candidate.length);
      }
      return candidate;
    }
    if (candidate === null || candidate === undefined) return candidate ?? null;
    if (typeof candidate === 'bigint') return `${candidate.toString()}n`;
    if (typeof candidate === 'function') return `[Function ${candidate.name || 'anonymous'}]`;
    if (typeof candidate === 'symbol') return candidate.toString();
    if (typeof candidate !== 'object') return candidate;
    if (ancestors.has(candidate)) return '[Circular reference]';
    ancestors.add(candidate);
    try {
      if (candidate instanceof Date) return candidate.toISOString();
      if (candidate instanceof Error) return { name: candidate.name, message: candidate.message };
      if (candidate instanceof Map) {
        return Array.from(candidate.entries()).map(([mapKey, entry]) => [
          normalize(mapKey),
          normalize(entry),
        ]);
      }
      if (candidate instanceof Set) return Array.from(candidate.values()).map(entry => normalize(entry));
      if (Array.isArray(candidate)) return candidate.map(entry => normalize(entry, key, parentMimeType));
      const record = candidate as Record<string, unknown>;
      const mimeType = String(
        record.mimeType
        || record.mime_type
        || record.media_type
        || parentMimeType
        || '',
      );
      const normalized: Record<string, unknown> = {};
      for (const property of Object.keys(record)) {
        try {
          normalized[property] = normalize(record[property], property, mimeType);
        } catch {
          normalized[property] = '[Unreadable property]';
        }
      }
      return normalized;
    } finally {
      ancestors.delete(candidate);
    }
  };
  try {
    const serialized = JSON.stringify(normalize(value ?? ''));
    return typeof serialized === 'string' ? serialized : String(serialized ?? '');
  } catch {
    return serializeContextValue(value);
  }
};

export const estimateContextValueTokens = (value: unknown): number =>
  Math.ceil(Math.max(0, serializeContextValueForMeasurement(value).length) / 4);

const estimateTokensFromText = estimateContextValueTokens;

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
  skills: number;
  subagents: number;
  mcpDynamicTools: number;
} => {
  const measured = { toolDefinitions: 0, skills: 0, subagents: 0, mcpDynamicTools: 0 };
  for (const declaration of toolDeclarationsFrom(tools)) {
    const record = declaration && typeof declaration === 'object'
      ? declaration as Record<string, any>
      : {};
    const name = String(record.name || record.function?.name || '').trim().toLowerCase();
    const tokens = estimateTokensFromText(declaration);
    if (SKILL_TOOL_NAMES.has(name)) measured.skills += tokens;
    else if (SUBAGENT_TOOL_NAME.test(name)) measured.subagents += tokens;
    else if (MCP_DYNAMIC_TOOL_NAME.test(name)) measured.mcpDynamicTools += tokens;
    else measured.toolDefinitions += tokens;
  }
  return measured;
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
  if (record.role === 'tool') {
    const directName = add(record.name || record.tool_name);
    if (!directName) {
      const referencedName = toolUseNames.get(String(record.tool_call_id || record.call_id || '').trim());
      if (referencedName) names.add(referencedName);
    }
  }
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
    if (Array.isArray(record.tool_calls)) {
      const envelope = { ...record, tool_calls: [] };
      measured.conversation += estimateTokensFromText(envelope);
      for (const call of record.tool_calls) addMeasuredValue(call);
      continue;
    }
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
    : serializeContextValue(systemInstruction || '');
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
    : measuredSystem.skills + measuredTools.skills + measuredConversation.skills;
  const subagentDefinitions = input.breakdownSources?.subagentDefinitions
    ? estimateTokensFromText(input.breakdownSources.subagentDefinitions)
    : measuredSystem.subagentDefinitions + measuredTools.subagents + measuredConversation.subagents;
  const systemPrompt = input.breakdownSources?.systemPrompt
    ? estimateTokensFromText(input.breakdownSources.systemPrompt)
    : measuredSystem.systemPrompt;

  return {
    systemPrompt,
    toolDefinitions: measuredTools.toolDefinitions,
    rules,
    skills,
    mcpDynamicTools: measuredTools.mcpDynamicTools + measuredConversation.mcpDynamicTools,
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

  const safeUsedTokens = Math.max(0, Math.round(Number(usedTokens || 0)));
  if (safeUsedTokens <= 0) {
    return Object.fromEntries(
      (Object.keys(normalized) as ContextUsageCategoryKey[]).map(key => [key, 0]),
    ) as ContextUsageBreakdown;
  }
  const visibleKeys = (Object.keys(normalized) as ContextUsageCategoryKey[])
    .filter(key => key !== 'providerOverhead');
  const visibleTotal = visibleKeys.reduce((sum, key) => sum + normalized[key], 0);
  if (visibleTotal <= 0) {
    normalized.conversation = safeUsedTokens;
    normalized.providerOverhead = 0;
    return normalized;
  }

  // Providers expose an authoritative aggregate input count but not a
  // per-component count. Calibrate the exact serialized component weights to
  // that aggregate so the visible rows remain provider-neutral and add up
  // exactly, instead of hiding or mislabelling a reconciliation remainder.
  const scale = safeUsedTokens / visibleTotal;
  const calibrated = { ...normalized, providerOverhead: 0 };
  for (const key of visibleKeys) calibrated[key] = Math.floor(normalized[key] * scale);
  const assigned = visibleKeys.reduce((sum, key) => sum + calibrated[key], 0);
  const largestKey = visibleKeys.reduce((largest, key) =>
    normalized[key] > normalized[largest] ? key : largest
  , visibleKeys[0]);
  calibrated[largestKey] += safeUsedTokens - assigned;
  return calibrated;
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
