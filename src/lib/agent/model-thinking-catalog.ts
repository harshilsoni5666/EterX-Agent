import {
  getDocumentedThinkingCapabilities,
  normalizeModelThinkingCapabilities,
  type MainAgentProvider,
  type ModelThinkingCapabilities,
  type ModelThinkingParameter,
} from './model-routing';

const unsupported = (): ModelThinkingCapabilities => ({ levels: [], source: 'provider' });
const parameterNames: Record<string, ModelThinkingParameter> = {
  thinkingLevel: 'thinkingLevel', thinking_level: 'thinking_level',
  thinkingBudget: 'thinkingBudget', thinking_budget: 'thinking_budget',
  enable_thinking: 'enable_thinking', 'thinking.type': 'thinking.type',
  'reasoning.enabled': 'reasoning.enabled',
  'chat_template_kwargs.enable_thinking': 'chat_template_kwargs.enable_thinking',
  'chat_template_kwargs.thinking': 'chat_template_kwargs.thinking',
  reasoning_effort: 'reasoning_effort', reasoning: 'reasoning', 'reasoning.effort': 'reasoning',
  'output_config.effort': 'output_config.effort', 'thinking.budget_tokens': 'thinking.budget_tokens',
  'chat_template_kwargs.reasoning_effort': 'chat_template_kwargs.reasoning_effort',
};

// Read JSON Schema properties without evaluating templates or trusting arbitrary
// request paths. Only the explicitly supported wire fields above are accepted.
function schemaProperty(schema: any, path: string): any {
  if (!schema || typeof schema !== 'object') return undefined;
  const direct = schema.properties?.[path] ?? schema[path];
  if (direct !== undefined) return direct;
  let current = schema;
  for (const part of path.split('.')) current = current?.properties?.[part];
  if (current) return current;
  for (const variant of [...(schema.anyOf || []), ...(schema.oneOf || []), ...(schema.allOf || [])]) {
    const result = schemaProperty(variant, path);
    if (result) return result;
  }
  return undefined;
}

function readSchemaContract(model: any): ModelThinkingCapabilities | null {
  const schemas = [model?.input_schema, model?.inputSchema, model?.schema?.input, model?.schema,
    model?.parameters, model?.supported_parameters, model?.capabilities?.parameters];
  // Effort takes precedence over a boolean when both are documented by schema.
  for (const name of ['reasoning_effort', 'reasoning.effort', 'output_config.effort', 'thinkingLevel', 'thinking_level', 'chat_template_kwargs.reasoning_effort', 'thinking.type', 'enable_thinking', 'reasoning.enabled', 'chat_template_kwargs.enable_thinking', 'chat_template_kwargs.thinking']) {
    const field = schemas.map(schema => schemaProperty(schema, name)).find(value => value && typeof value === 'object');
    if (!field) continue;
    const values = Array.isArray(field.enum) ? field.enum : field.type === 'boolean' ? [false, true] : undefined;
    if (!values) continue;
    const parameter = parameterNames[name];
    const boolean = field.type === 'boolean';
    const wireValues: NonNullable<ModelThinkingCapabilities['wireValues']> = {};
    const levels = values.flatMap((raw: unknown) => {
      const value = raw === true ? 'on' : raw === false ? 'off' : raw;
      const level = normalizeModelThinkingCapabilities({ levels: [value] })?.levels[0];
      if (!level) return [];
      if (!boolean && typeof raw === 'string') wireValues[level] = raw;
      return [level];
    });
    if (!levels.length) continue;
    const defaultValue = field.default === true ? 'on' : field.default === false ? 'off' : field.default;
    return normalizeModelThinkingCapabilities({ levels, parameter, wireValues, defaultLevel: defaultValue,
      kind: boolean || name === 'thinking.type' ? 'toggle' : 'effort', source: 'provider' });
  }
  return null;
}

/** Read actual provider metadata; a parameter name alone does not define its enum. */
function readThinkingContract(model: any, provider: MainAgentProvider): ModelThinkingCapabilities {
  const id = String(model?.id || model?.key || model?.model_id || model?.baseModelId || model?.name || model?.model || '');
  const documented = getDocumentedThinkingCapabilities(provider, id);
  const reasoning = model?.reasoning ?? model?.capabilities?.reasoning;
  const thinking = model?.thinking ?? model?.thinkingConfig ?? model?.capabilities?.thinking;
  const effort = model?.effort ?? model?.capabilities?.effort;
  if ([reasoning, thinking, effort].some(value => value === false || value?.supported === false)
    || model?.supports_reasoning === false || model?.supports_thinking === false) return unsupported();

  if (provider === 'openrouter') {
    // OpenRouter publishes its own per-model enum. null explicitly means all
    // gateway efforts; omitted means no effort selector. Never copy the
    // upstream vendor's enum into a gateway's request contract.
    if (!reasoning || typeof reasoning !== 'object') return unsupported();
    const efforts: unknown[] | null = reasoning.supported_efforts === null
      ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      : Array.isArray(reasoning.supported_efforts) ? reasoning.supported_efforts : null;
    if (efforts) {
      const live = normalizeModelThinkingCapabilities({ levels: efforts, parameter: 'reasoning',
        defaultLevel: reasoning.default_enabled === false ? 'off' : reasoning.default_effort, source: 'provider' });
      if (!live) return unsupported();
      if (reasoning.mandatory === true) live.levels = live.levels.filter(level => level !== 'off');
      else if (reasoning.mandatory === false && !live.levels.includes('off')) {
        live.levels.unshift('off');
        live.toggleParameter = 'reasoning.enabled';
        live.omitLevels = ['off'];
        if (reasoning.default_enabled === false) live.defaultLevel = 'off';
      }
      return live;
    }
    if (reasoning.mandatory === false && typeof reasoning.default_enabled === 'boolean') {
      return { levels: ['off', 'high'], parameter: 'reasoning.enabled', kind: 'toggle',
        defaultLevel: reasoning.default_enabled ? 'high' : 'off', source: 'provider' };
    }
    return unsupported();
  }

  const schema = readSchemaContract(model);
  if (schema) return schema;
  // Native Ollama /api/show describes the actual installed model/template.
  // Its OpenAI bridge accepts named values verbatim and none for Boolean Off.
  if ((provider === 'ollama' || provider === 'ollamacloud') && Array.isArray(thinking?.values)) {
    const values: unknown[] = thinking.values;
    if (values.length === 1 && values[0] === false) return unsupported();
    const boolean = values.every(value => typeof value === 'boolean');
    return normalizeModelThinkingCapabilities({
      levels: values.map(value => value === true ? 'on' : value === false ? 'off' : value),
      defaultLevel: thinking.default === true ? 'on' : thinking.default === false ? 'off' : thinking.default,
      parameter: 'reasoning_effort', kind: boolean ? 'toggle' : 'effort',
      wireValues: Object.fromEntries(values.flatMap(value => {
        const level = normalizeModelThinkingCapabilities({ levels: [value === true ? 'on' : value === false ? 'off' : value] })?.levels[0];
        return level ? [[level, value === false ? 'none' : value === true ? 'high' : value]] : [];
      })), source: 'provider',
    }) || unsupported();
  }
  // LM Studio publishes native on/off plus named modes. Its OpenAI Responses
  // adapter consumes reasoning.effort (the Chat route can ignore the field).
  if (provider === 'lmstudio' && Array.isArray(reasoning?.allowed_options)) {
    return normalizeModelThinkingCapabilities({
      levels: reasoning.allowed_options, defaultLevel: reasoning.default,
      parameter: 'reasoning', kind: reasoning.allowed_options.every((value: string) => value === 'on' || value === 'off') ? 'toggle' : 'effort',
      wireValues: { off: 'none', ...(reasoning.allowed_options.includes('on') ? { high: 'medium' } : {}) }, source: 'provider',
    }) || unsupported();
  }

  const advertised = Array.isArray(model?.supported_parameters)
    ? model.supported_parameters.map(String)
    : null;
  const advertisedParameters = advertised?.map((name: string) => parameterNames[name]).filter(Boolean);
  const parameterPriority: ModelThinkingParameter[] = ['output_config.effort', 'reasoning_effort', 'reasoning', 'thinkingLevel', 'thinking_level', 'thinkingBudget', 'thinking_budget', 'thinking.budget_tokens', 'chat_template_kwargs.reasoning_effort', 'thinking.type', 'enable_thinking', 'reasoning.enabled', 'chat_template_kwargs.enable_thinking', 'chat_template_kwargs.thinking'];
  const advertisedParameter = parameterPriority.find(name => advertisedParameters?.includes(name));
  const explicitParameter = parameterNames[String(thinking?.parameter || reasoning?.parameter || effort?.parameter || '')];
  let parameter: ModelThinkingParameter | undefined = explicitParameter || advertisedParameter || documented?.parameter;
  if (provider === 'gemini') {
    if (parameter === 'thinking_level') parameter = 'thinkingLevel';
    if (parameter === 'thinking_budget') parameter = 'thinkingBudget';
  }
  if (!parameter) {
    if (provider === 'anthropic' && effort) parameter = 'output_config.effort';
    else if (provider === 'gemini' && (thinking || model?.supportedThinkingLevels)) parameter = 'thinkingLevel';
    else if (['openai', 'groq', 'mistral', 'deepseek', 'grok'].includes(provider)) parameter = 'reasoning_effort';
    else if (model?.supported_reasoning_efforts || model?.reasoning_effort_levels || model?.capabilities?.reasoning_effort_levels || reasoning?.supported_efforts || reasoning?.supportedEfforts) parameter = 'reasoning_effort';
  }
  if (!parameter) return unsupported();

  const levels = [
    reasoning?.levels, reasoning?.supported_efforts, reasoning?.supportedEfforts, reasoning?.supported_levels,
    thinking?.levels, thinking?.supported_levels, thinking?.supportedLevels, thinking?.supported_thinking_levels,
    effort?.supported_levels, effort?.levels, model?.supported_reasoning_efforts, model?.supportedThinkingLevels,
    model?.reasoning_effort_levels, model?.capabilities?.reasoning_effort_levels,
  ].find(Array.isArray) ?? (effort && typeof effort === 'object'
    && ['low', 'medium', 'high', 'xhigh', 'max'].some(level => typeof effort[level] === 'boolean')
    ? ['low', 'medium', 'high', 'xhigh', 'max'].filter(level => effort[level] === true)
    : undefined);

  if (levels) {
    const hasProviderDefault = provider === 'groq' && levels.includes('default');
    const wireValues: NonNullable<ModelThinkingCapabilities['wireValues']> = {};
    for (const value of levels) {
      const raw = typeof value === 'object' ? value?.effort ?? value?.level ?? value?.id : value;
      const normalized = normalizeModelThinkingCapabilities({ levels: [raw], parameter })?.levels[0];
      if (normalized && typeof raw === 'string') wireValues[normalized] = raw;
    }
    if (hasProviderDefault && !levels.includes('high')) wireValues.high = 'default';
    const rawDefault = reasoning?.default_effort ?? reasoning?.defaultEffort ?? reasoning?.default ?? thinking?.default_level
      ?? thinking?.defaultLevel ?? effort?.default_level ?? model?.default_reasoning_effort;
    const live = normalizeModelThinkingCapabilities({
      levels: levels.map((value: any) => hasProviderDefault && value === 'default' ? 'high'
        : typeof value === 'object' ? value?.effort ?? value?.level ?? value?.id : value),
      defaultLevel: hasProviderDefault && rawDefault === 'default' ? 'high' : rawDefault,
      wireValues,
      parameter,
      source: 'provider',
      ...(documented?.toggleParameter ? { toggleParameter: documented.toggleParameter, omitLevels: documented.omitLevels } : {}),
    });
    if (!live) return unsupported();
    // DeepSeek's effort list describes the enabled mode only; its native API
    // separately accepts none to disable thinking (see /api/list-models).
    if (provider === 'deepseek' && Array.isArray(effort?.supported_levels) && live.levels.length && !live.levels.includes('off')) {
      live.levels.unshift('off');
    }
    return live;
  }

  if (documented && parameter === documented.parameter) return documented;
  // A real boolean toggle can be represented as Off/On, without invented
  // Low/Medium/High budget presets or an extra reasoning_effort field.
  if (['enable_thinking', 'reasoning.enabled', 'chat_template_kwargs.enable_thinking', 'chat_template_kwargs.thinking'].includes(parameter) && advertisedParameters?.includes(parameter)) {
    return { levels: ['off', 'high'], parameter, kind: 'toggle', source: 'provider' };
  }
  return unsupported();
}

export function readModelThinkingCapabilities(model: any, provider: MainAgentProvider): ModelThinkingCapabilities {
  const rawId = String(model?.id || model?.key || model?.model_id || model?.name || model?.baseModelId || model?.model || '').trim();
  const modelId = provider === 'gemini' ? rawId.replace(/^models\//, '') : rawId;
  return { ...readThinkingContract(model, provider), provider, modelId, updatedAt: Date.now() };
}

/** Preserve explicit tool/chat denials across all catalog adapters. */
export function readModelWireCapabilities(model: any): string[] {
  const raw = model?.capabilities;
  const capabilities = Array.isArray(raw) ? raw.map(String) : raw && typeof raw === 'object'
    ? Object.entries(raw).filter(([, value]) => value === true || (value as any)?.supported === true).map(([name]) => name)
    : [];
  const parameters = Array.isArray(model?.supported_parameters) ? model.supported_parameters.map(String) : null;
  const toolFlags = [model?.supports_tools, model?.supports_function_calling, raw?.tools, raw?.tool_calling, raw?.function_calling, raw?.trained_for_tool_use];
  const outputs = model?.output_modalities ?? model?.architecture?.output_modalities;
  const endpoints = Array.isArray(model?.supported_endpoints) ? model.supported_endpoints : Array.isArray(model?.endpoints) ? model.endpoints : [];
  const protocols = endpoints.flatMap((endpoint: unknown) => {
    if (typeof endpoint !== 'string') return [];
    if (/(?:^|\/)chat\/completions\/?$/.test(endpoint)) return ['api:chat'];
    if (/(?:^|\/)responses\/?$/.test(endpoint)) return ['api:responses'];
    if (/(?:^|\/)messages\/?$/.test(endpoint)) return ['api:messages'];
    if (/generateContent|streamGenerateContent/.test(endpoint)) return ['api:generateContent'];
    return [];
  });
  const inputSchema = model?.input_schema || model?.inputSchema;
  const noTools = toolFlags.some(value => value === false || value?.supported === false)
    || (inputSchema?.additionalProperties === false && inputSchema?.properties && !schemaProperty(inputSchema, 'tools'));
  const noChat = raw?.completion_chat === false || raw?.completion_chat?.supported === false
    || (Array.isArray(outputs) && !outputs.includes('text'))
    || ['embedding', 'embeddings', 'rerank', 'reranker', 'decision', 'text-to-image', 'text-to-speech', 'automatic-speech-recognition'].includes(String(model?.type || model?.task || model?.pipeline_tag || '').toLowerCase());
  return Array.from(new Set([...capabilities, ...protocols, ...(parameters || []), ...(noTools ? ['tool-calling:false'] : []), ...(noChat ? ['chat:false'] : [])]));
}
