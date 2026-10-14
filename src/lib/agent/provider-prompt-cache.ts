import { createHash } from 'crypto';
import type { MainAgentProvider } from './model-routing';

export type ProviderPromptCacheMode =
  | 'disabled'
  | 'explicit-remote'
  | 'explicit-ephemeral'
  | 'implicit-keyed'
  | 'implicit-prefix';

type PromptCacheIdentityInput = {
  provider: MainAgentProvider;
  model: string;
  staticPrompt: string;
  tools: unknown[];
};

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? String(value) : encoded;
  }
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`);
  return `{${entries.join(',')}}`;
}

/** Stabilize the actual wire payload, not just the local cache fingerprint. */
export function canonicalizeToolDeclarations<T>(tools: T[]): T[] {
  const canonical = (value: any): any => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  };
  const name = (tool: any) => String(tool?.name || tool?.function?.name || tool?.type || '');
  return [...tools].sort((a, b) => name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0).map(canonical);
}

export function buildPromptCacheIdentity(input: PromptCacheIdentityInput): string {
  const digest = createHash('sha256')
    .update(input.provider)
    .update('\0')
    .update(input.model)
    .update('\0')
    .update(input.staticPrompt)
    .update('\0')
    .update(stableSerialize(input.tools))
    .digest('hex')
    .slice(0, 40);
  return `eterx-${digest}`;
}

/** Stable, non-sensitive conversation affinity for providers that cache by header. */
export function buildProviderConversationCacheId(
  provider: MainAgentProvider,
  conversationScope: string,
): string | null {
  if (provider !== 'grok') return null;
  const digest = createHash('sha256')
    .update('eterx-grok-conversation\0')
    .update(String(conversationScope || 'default'))
    .digest('hex')
    .slice(0, 32);
  return `eterx-${digest}`;
}

/** Distribute conversations while keeping a returning chat on the same
 * credential/project. Reordering the configured keys does not move the chat. */
export function providerCacheKeyIndex(provider: MainAgentProvider, scope: string, keys: string[]): number {
  let selected = 0, highest = '';
  keys.forEach((key, index) => {
    const score = createHash('sha256').update(provider).update('\0').update(scope)
      .update('\0').update(key).digest('hex');
    if (score > highest) { highest = score; selected = index; }
  });
  return selected;
}

export function resolveProviderPromptCacheMode(
  provider: MainAgentProvider,
  enabled: boolean,
  explicitGeminiCacheActive = false,
): ProviderPromptCacheMode {
  if (!enabled) return 'disabled';
  if (provider === 'gemini') return explicitGeminiCacheActive ? 'explicit-remote' : 'implicit-prefix';
  if (provider === 'anthropic') return 'explicit-ephemeral';
  if (provider === 'openai') return 'implicit-keyed';
  if (provider === 'grok') return 'implicit-keyed';
  return 'implicit-prefix';
}

export function applyOpenAIPromptCachePolicy(
  params: Record<string, any>,
  input: Omit<PromptCacheIdentityInput, 'provider'> & { conversationScope?: string },
): string {
  const identity = buildPromptCacheIdentity({ provider: 'openai', ...input });
  params.prompt_cache_key = identity;
  // Caching is automatic. Let the model/account choose its supported default:
  // forcing a retention breaks models with different cache lifetime controls.
  delete params.prompt_cache_retention;
  const retention = process.env.OPENAI_PROMPT_CACHE_RETENTION?.trim().replace('-', '_');
  const version = input.model.match(/(?:^|\/)gpt-(\d+)(?:\.(\d+))?/i);
  const modernCache = version && (Number(version[1]) > 5 || (Number(version[1]) === 5 && Number(version[2]) >= 6));
  // Older OpenAI models can overflow a cache route when a swarm shares one
  // hot key. Keep each conversation on a deterministic shard, while allowing
  // conversations within that shard to share the common instruction prefix.
  const configuredShards = Number.parseInt(process.env.OPENAI_PROMPT_CACHE_SHARDS || '8', 10);
  const shards = Number.isFinite(configuredShards) ? Math.max(1, Math.min(64, configuredShards)) : 8;
  if (!modernCache && input.conversationScope && shards > 1) {
    const shard = createHash('sha256').update(input.conversationScope).digest().readUInt32BE(0) % shards;
    params.prompt_cache_key = `${identity}-s${shards}-${shard}`;
  }
  const extendedOnly = /(?:^|\/)gpt-5\.5(?:$|-)/i.test(input.model);
  if (!modernCache && (retention === '24h' || (retention === 'in_memory' && !extendedOnly))) {
    params.prompt_cache_retention = retention;
  }
  params.stream_options = { ...params.stream_options, include_usage: true };
  return params.prompt_cache_key;
}

const openAIResponseCacheBoundaries = new WeakMap<any[], { item: number; field: 'content' | 'output'; block: number; signature: string }>();

/** Modern Responses models accept explicit boundaries alongside implicit caching.
 * Earlier models and other vendors never receive these fields. */
export function applyOpenAIResponsesCachePolicy(body: Record<string, any>, transcript: any[]): void {
  const version = String(body.model || '').match(/(?:^|\/)gpt-(\d+)(?:\.(\d+))?/i);
  if (process.env.ETERX_DISABLE_CONTEXT_CACHE === '1' || !version
    || !(Number(version[1]) > 5 || Number(version[1]) === 5 && Number(version[2]) >= 6)) return;
  body.prompt_cache_options = { mode: 'implicit' };
  const input = body.input as any[];
  const blocksFor = (item: any, field: 'content' | 'output'): any[] => {
    if (typeof item[field] === 'string') item[field] = [{ type: 'input_text', text: item[field] }];
    return Array.isArray(item[field]) ? item[field] : [];
  };
  const mark = (block: any) => { block.prompt_cache_breakpoint = { mode: 'explicit' }; };
  const firstSystem = input.find(item => item?.role === 'system' || item?.role === 'developer');
  if (firstSystem) {
    const block = [...blocksFor(firstSystem, 'content')].reverse().find(item => item?.type === 'input_text' && item.text?.trim());
    if (block) mark(block);
  }
  const previous = openAIResponseCacheBoundaries.get(transcript);
  let previousMarked = false;
  if (previous && input[previous.item]) {
    const block = blocksFor(input[previous.item], previous.field)[previous.block];
    if (block && stableSerialize(block) === previous.signature) { mark(block); previousMarked = true; }
  }
  for (let index = input.length - 1; index >= 0; index--) {
    const item = input[index];
    if (item?.role !== 'user' && item?.type !== 'function_call_output') continue;
    const field = item.type === 'function_call_output' ? 'output' : 'content';
    const blocks = blocksFor(item, field);
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const block = blocks[blockIndex];
      if (block?.type !== 'input_text' || !block.text?.trim()) continue;
      const { prompt_cache_breakpoint: _boundary, ...content } = block;
      openAIResponseCacheBoundaries.set(transcript, { item: index, field, block: blockIndex, signature: stableSerialize(content) });
      mark(block);
      if (!previousMarked) {
        // A restored transcript has a new array identity. Its preceding user
        // turn is still a useful write boundary without persisted cache hints.
        for (let priorIndex = index - 1; priorIndex >= 0; priorIndex--) {
          const prior = input[priorIndex];
          if (prior?.role !== 'user' && prior?.type !== 'function_call_output') continue;
          const priorField = prior.type === 'function_call_output' ? 'output' : 'content';
          const priorBlock = [...blocksFor(prior, priorField)].reverse()
            .find(item => item?.type === 'input_text' && item.text?.trim());
          if (priorBlock) { mark(priorBlock); break; }
        }
      }
      return;
    }
  }
}

/** Retry only a rejected cache hint, before a stream has been returned. */
export async function withOpenAICacheFallback<T>(
  params: Record<string, any>,
  send: (body: Record<string, any>) => Promise<T>,
): Promise<T> {
  try {
    return await send(params);
  } catch (error: any) {
    const status = Number(error?.status || error?.statusCode || 0);
    const field = String(error?.param || error?.error?.param || '');
    const message = String(error?.message || '');
    const rejectedHint = ['prompt_cache_retention', 'prompt_cache_key', 'prompt_cache_options', 'prompt_cache_breakpoint'].some(name =>
      (params[name] !== undefined || name === 'prompt_cache_breakpoint' && params.prompt_cache_options)
      && (field.includes(name) || message.includes(name)));
    if (status !== 400 || !rejectedHint) throw error;
    const fallback = { ...params };
    delete fallback.prompt_cache_retention;
    delete fallback.prompt_cache_key;
    delete fallback.prompt_cache_options;
    if (Array.isArray(fallback.input)) fallback.input = fallback.input.map((item: any) => {
      const clean = { ...item };
      for (const field of ['content', 'output']) if (Array.isArray(clean[field])) {
        clean[field] = clean[field].map(({ prompt_cache_breakpoint: _boundary, ...block }: any) => block);
      }
      return clean;
    });
    // Implicit provider caching remains active; no tools or reasoning change.
    return send(fallback);
  }
}

type AnthropicCacheBoundary = { message: number; block: number; signature: string };
const anthropicCacheBoundaries = new WeakMap<any[], AnthropicCacheBoundary>();

/** Claude allows four explicit breakpoints. Keep the previous write reachable
 * even when a large tool/steering turn exceeds the provider's lookback window. */
export function applyAnthropicPromptCachePolicy(
  params: Record<string, any>,
  enabled = process.env.ETERX_DISABLE_CONTEXT_CACHE !== '1',
  cacheScope: any[] = params.messages,
): void {
  delete params.cache_control;
  const transcript = params.messages;
  // Cache metadata belongs to this request, never the durable transcript or
  // shared tool declarations (mutating them caused false tool-surface changes).
  if (Array.isArray(params.tools)) params.tools = params.tools.map((tool: any) => ({ ...tool }));
  if (typeof params.system === 'string') params.system = [{ type: 'text', text: params.system }];
  if (Array.isArray(params.system)) params.system = params.system.map((block: any) => ({ ...block }));
  if (Array.isArray(transcript)) params.messages = transcript.map((message: any) => ({
    ...message,
    content: typeof message.content === 'string' ? [{ type: 'text', text: message.content }]
      : Array.isArray(message.content) ? message.content.map((block: any) => ({ ...block })) : message.content,
  }));
  const groups = [params.tools, params.system, ...(params.messages || []).map((message: any) => message.content)];
  for (const group of groups) {
    if (Array.isArray(group)) for (const block of group) {
      if (block && typeof block === 'object') delete block.cache_control;
    }
  }
  if (!enabled) return;
  const control = process.env.ANTHROPIC_PROMPT_CACHE_TTL === '1h'
    ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  if (params.tools?.length) params.tools[params.tools.length - 1].cache_control = { ...control };
  if (Array.isArray(params.system)) {
    const block = params.system.find((item: any) => item?.type === 'text' && item.text?.trim());
    if (block) block.cache_control = { ...control };
  }
  const eligible = (item: any) => (item?.type === 'text' && item.text?.trim())
    || ['image', 'document', 'tool_use', 'tool_result'].includes(item?.type);
  const previous = Array.isArray(cacheScope) ? anthropicCacheBoundaries.get(cacheScope) : undefined;
  let previousMarked = false;
  if (previous) {
    const block = params.messages?.[previous.message]?.content?.[previous.block];
    if (eligible(block) && stableSerialize(block) === previous.signature) {
      block.cache_control = { ...control };
      previousMarked = true;
    }
  }
  for (let i = (params.messages?.length || 0) - 1; i >= 0; i--) {
    const message = params.messages[i];
    if (typeof message.content === 'string') {
      if (!message.content.trim()) continue;
      message.content = [{ type: 'text', text: message.content }];
    }
    if (!Array.isArray(message.content)) continue;
    for (let index = message.content.length - 1; index >= 0; index--) {
      const block = message.content[index];
      if (!eligible(block)) continue;
      const { cache_control: _control, ...content } = block;
      if (Array.isArray(cacheScope)) anthropicCacheBoundaries.set(cacheScope, {
        message: i, block: index, signature: stableSerialize(content),
      });
      block.cache_control = { ...control };
      if (!previousMarked) {
        for (let priorIndex = i - 1; priorIndex >= 0; priorIndex--) {
          const prior = params.messages[priorIndex];
          if (prior?.role !== 'user' || !Array.isArray(prior.content)) continue;
          const priorBlock = [...prior.content].reverse().find(eligible);
          if (priorBlock) { priorBlock.cache_control = { ...control }; break; }
        }
      }
      return;
    }
  }
}

/** Dynamic system instructions require implicit caching on Gemini. */
export function canUseExplicitGeminiSystemCache(dynamicSystemInstruction: string): boolean {
  return !dynamicSystemInstruction.trim();
}

export function buildOpenAISystemPromptContent(
  model: string,
  staticPrompt: string,
  dynamicPrompt: string,
  cacheEnabled: boolean,
): string | Array<Record<string, any>> {
  void model;
  void cacheEnabled;
  return `${staticPrompt}\n\n${dynamicPrompt}`;
}

/** Streaming usage is a sequence of cumulative, sometimes partial snapshots.
 * Missing fields do not erase earlier measurements; a reported zero still wins. */
export function mergeProviderUsageSnapshots(previous: any, incoming: any): any {
  if (!incoming) return previous;
  if (!previous) return incoming;
  const merged = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  for (const key of ['prompt_tokens_details', 'input_tokens_details', 'completion_tokens_details',
    'output_tokens_details', 'cache_creation']) {
    if (previous[key] && incoming[key]) merged[key] = mergeProviderUsageSnapshots(previous[key], incoming[key]);
  }
  return merged;
}

export function normalizeProviderCacheUsage(
  provider: MainAgentProvider,
  usage: any,
): Record<string, number> {
  if (!usage) return {};
  // SDK adapters do not all return the same shape. Keep this boundary
  // provider-neutral so the rest of the app only consumes measured fields.
  const raw = usage?.usageMetadata || usage?.usage || usage;
  // Native bridges normalize before crossing the OpenAI-shaped transport.
  // Preserve measurement flags and provider-specific accounting on a second pass.
  if (raw.promptTokensMeasured !== undefined && raw.completionTokensMeasured !== undefined
    && raw.promptTokens !== undefined) {
    return Object.fromEntries(Object.entries(raw).filter(([, value]) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0)) as Record<string, number>;
  }
  const numberFrom = (...values: unknown[]) => {
    for (const value of values) {
      if (value === undefined || value === null || value === '') continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return 0;
  };
  const wasProvided = (...values: unknown[]) => values.some(value => {
    if (value === undefined || value === null || value === '') return false;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0;
  });
  if (provider === 'anthropic' || (raw.input_tokens !== undefined
    && (raw.cache_read_input_tokens !== undefined || raw.cache_creation_input_tokens !== undefined))) {
    const directInputTokens = numberFrom(raw.input_tokens, raw.inputTokens);
    const cacheReadTokens = numberFrom(raw.cache_read_input_tokens, raw.cacheReadInputTokens);
    const cacheCreationTokens = numberFrom(raw.cache_creation_input_tokens, raw.cacheCreationInputTokens,
      raw.cache_creation ? numberFrom(raw.cache_creation.ephemeral_5m_input_tokens)
        + numberFrom(raw.cache_creation.ephemeral_1h_input_tokens) : undefined);
    const promptTokens = directInputTokens + cacheReadTokens + cacheCreationTokens;
    const completionTokens = numberFrom(raw.output_tokens, raw.outputTokens);
    const cacheTokensMeasured = wasProvided(
      raw.cache_read_input_tokens,
      raw.cacheReadInputTokens,
    );
    const normalized: Record<string, number> = {
      promptTokens,
      inputTokens: promptTokens,
      completionTokens,
      visibleOutputTokens: completionTokens,
      generatedTokens: completionTokens,
      outputTokens: completionTokens,
      totalTokens: promptTokens + completionTokens,
      providerReportedTotalTokens: 0,
      promptTokensMeasured: wasProvided(raw.input_tokens, raw.inputTokens, raw.cache_creation_input_tokens,
        raw.cacheCreationInputTokens, raw.cache_creation?.ephemeral_5m_input_tokens,
        raw.cache_creation?.ephemeral_1h_input_tokens) || cacheTokensMeasured ? 1 : 0,
      completionTokensMeasured: wasProvided(raw.output_tokens, raw.outputTokens) ? 1 : 0,
      reasoningTokensMeasured: 0,
      cacheTokensMeasured: cacheTokensMeasured ? 1 : 0,
      cacheWriteTokensMeasured: wasProvided(raw.cache_creation_input_tokens, raw.cacheCreationInputTokens,
        raw.cache_creation?.ephemeral_5m_input_tokens, raw.cache_creation?.ephemeral_1h_input_tokens) ? 1 : 0,
      cacheReadTokens,
      cacheCreationTokens,
    };
    if (cacheTokensMeasured) {
      normalized.cachedTokens = cacheReadTokens;
      normalized.uncachedPromptTokens = Math.max(0, promptTokens - cacheReadTokens);
      normalized.cacheHitRatio = promptTokens > 0 ? cacheReadTokens / promptTokens : 0;
    }
    return normalized;
  }
  if (provider === 'gemini' || raw.promptTokenCount !== undefined || raw.prompt_token_count !== undefined) {
    const promptTokens = numberFrom(
      raw.promptTokenCount,
      raw.totalInputTokens,
      raw.prompt_token_count,
      raw.total_input_tokens,
      raw.inputTokenCount,
      raw.promptTokens,
      raw.inputTokens,
    );
    const visibleOutputTokens = numberFrom(
      raw.candidatesTokenCount,
      raw.totalOutputTokens,
      raw.responseTokenCount,
      raw.candidates_token_count,
      raw.total_output_tokens,
      raw.response_token_count,
      raw.outputTokenCount,
      raw.completionTokens,
      raw.outputTokens,
    );
    const reasoningTokens = numberFrom(
      raw.thoughtsTokenCount,
      raw.totalThoughtTokens,
      raw.thoughts_token_count,
      raw.total_thought_tokens,
      raw.thoughtTokenCount,
      raw.reasoningTokens,
    );
    const toolUsePromptTokens = numberFrom(
      raw.toolUsePromptTokenCount,
      raw.totalToolUseTokens,
      raw.tool_use_prompt_token_count,
      raw.total_tool_use_tokens,
      raw.toolUsePromptTokens,
    );
    const completionTokens = visibleOutputTokens + reasoningTokens;
    const reportedTotal = numberFrom(raw.totalTokenCount, raw.total_token_count, raw.totalTokens, raw.total_tokens);
    // Gemini reports tool-use prompt tokens as a diagnostic component of the
    // prompt, not as an additional billable bucket. Adding it again inflates
    // fallback totals when totalTokenCount is absent.
    const measuredComponentTotal = promptTokens + completionTokens;
    const totalTokens = reportedTotal > 0 ? reportedTotal : measuredComponentTotal;
    const measuredCachedTokens = numberFrom(
      raw.cachedContentTokenCount,
      raw.totalCachedTokens,
      raw.cached_content_token_count,
      raw.total_cached_tokens,
      raw.cachedTokens,
    );
    const cacheTokensMeasured = wasProvided(
      raw.cachedContentTokenCount,
      raw.totalCachedTokens,
      raw.cached_content_token_count,
      raw.total_cached_tokens,
      raw.cachedTokens,
    );
    const cachedTokens = promptTokens > 0
      ? Math.min(promptTokens, measuredCachedTokens)
      : measuredCachedTokens;
    const normalized: Record<string, number> = {
      promptTokens,
      inputTokens: promptTokens,
      completionTokens,
      visibleOutputTokens,
      generatedTokens: completionTokens,
      outputTokens: completionTokens,
      totalTokens,
      providerReportedTotalTokens: reportedTotal,
      promptTokensMeasured: wasProvided(
        raw.promptTokenCount,
        raw.totalInputTokens,
        raw.prompt_token_count,
        raw.total_input_tokens,
        raw.inputTokenCount,
        raw.promptTokens,
        raw.inputTokens,
      ) ? 1 : 0,
      completionTokensMeasured: wasProvided(
        raw.candidatesTokenCount,
        raw.totalOutputTokens,
        raw.responseTokenCount,
        raw.candidates_token_count,
        raw.total_output_tokens,
        raw.response_token_count,
        raw.outputTokenCount,
        raw.completionTokens,
        raw.outputTokens,
      ) ? 1 : 0,
      reasoningTokensMeasured: wasProvided(
        raw.thoughtsTokenCount,
        raw.totalThoughtTokens,
        raw.thoughts_token_count,
        raw.total_thought_tokens,
        raw.thoughtTokenCount,
        raw.reasoningTokens,
      ) ? 1 : 0,
      cacheTokensMeasured: cacheTokensMeasured ? 1 : 0,
      cacheWriteTokensMeasured: 0,
      reasoningTokens,
      toolUsePromptTokens,
    };
    if (cacheTokensMeasured) {
      normalized.cachedTokens = cachedTokens;
      normalized.uncachedPromptTokens = Math.max(0, promptTokens - cachedTokens);
      normalized.cacheHitRatio = promptTokens > 0 ? cachedTokens / promptTokens : 0;
    }
    return normalized;
  }
  const splitPromptTokens = wasProvided(raw.prompt_cache_hit_tokens) && wasProvided(raw.prompt_cache_miss_tokens)
    ? numberFrom(raw.prompt_cache_hit_tokens) + numberFrom(raw.prompt_cache_miss_tokens) : undefined;
  const promptTokens = numberFrom(raw.prompt_tokens, raw.input_tokens, raw.promptTokens, raw.inputTokens, splitPromptTokens);
  const completionTokens = numberFrom(raw.completion_tokens, raw.output_tokens, raw.completionTokens, raw.outputTokens);
  const reasoningTokens = numberFrom(
    raw.completion_tokens_details?.reasoning_tokens,
    raw.output_tokens_details?.reasoning_tokens,
    raw.reasoning_tokens,
    raw.reasoningTokens,
  );
  const reportedTotal = numberFrom(raw.total_tokens, raw.totalTokens, raw.totalTokenCount);
  const normalized: Record<string, number> = {
    promptTokens,
    inputTokens: promptTokens,
    completionTokens,
    visibleOutputTokens: Math.max(0, completionTokens - reasoningTokens),
    generatedTokens: completionTokens,
    outputTokens: completionTokens,
    providerReportedTotalTokens: reportedTotal,
    promptTokensMeasured: wasProvided(raw.prompt_tokens, raw.input_tokens, raw.promptTokens, raw.inputTokens, splitPromptTokens) ? 1 : 0,
    completionTokensMeasured: wasProvided(raw.completion_tokens, raw.output_tokens, raw.completionTokens, raw.outputTokens) ? 1 : 0,
    reasoningTokensMeasured: wasProvided(
      raw.completion_tokens_details?.reasoning_tokens,
      raw.output_tokens_details?.reasoning_tokens,
      raw.reasoning_tokens,
      raw.reasoningTokens,
    ) ? 1 : 0,
  };
  const cacheTokensMeasured = wasProvided(
    raw.prompt_tokens_details?.cached_tokens,
    raw.input_tokens_details?.cached_tokens,
    raw.cached_tokens,
    raw.cachedTokens,
    raw.prompt_cache_hit_tokens,
  );
  const measuredCachedTokens = numberFrom(
      raw.prompt_cache_hit_tokens,
      raw.prompt_tokens_details?.cached_tokens,
      raw.input_tokens_details?.cached_tokens,
      raw.cached_tokens,
      raw.cachedTokens,
    );
  const cachedTokens = promptTokens > 0
    ? Math.min(promptTokens, measuredCachedTokens)
    : measuredCachedTokens;
  const cacheWriteTokens = numberFrom(
    raw.prompt_tokens_details?.cache_write_tokens,
    raw.input_tokens_details?.cache_write_tokens,
    raw.cache_write_tokens,
    raw.cacheWriteTokens,
  );
  const cacheWriteTokensMeasured = wasProvided(
    raw.prompt_tokens_details?.cache_write_tokens,
    raw.input_tokens_details?.cache_write_tokens,
    raw.cache_write_tokens,
    raw.cacheWriteTokens,
  );
  normalized.cacheTokensMeasured = cacheTokensMeasured ? 1 : 0;
  normalized.cacheWriteTokensMeasured = cacheWriteTokensMeasured ? 1 : 0;
  if (cacheTokensMeasured) normalized.cachedTokens = cachedTokens;
  if (cacheWriteTokensMeasured) normalized.cacheWriteTokens = cacheWriteTokens;
  if (promptTokens > 0 && cacheTokensMeasured) {
    normalized.uncachedPromptTokens = Math.max(0, promptTokens - cachedTokens);
    normalized.cacheHitRatio = cachedTokens / promptTokens;
  }
  // Preserve the compact legacy shape when a provider omits optional usage
  // fields, while retaining every measured metric when it is present.
  normalized.totalTokens = reportedTotal > 0 ? reportedTotal : promptTokens + completionTokens;
  if (reasoningTokens > 0) normalized.reasoningTokens = reasoningTokens;
  return normalized;
}
