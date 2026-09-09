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
  input: Omit<PromptCacheIdentityInput, 'provider'>,
): string {
  const identity = buildPromptCacheIdentity({ provider: 'openai', ...input });
  params.prompt_cache_key = identity;
  params.prompt_cache_retention =
    process.env.OPENAI_PROMPT_CACHE_RETENTION === '24h' ? '24h' : 'in-memory';
  params.stream_options = { include_usage: true };
  return identity;
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

export function normalizeProviderCacheUsage(
  provider: MainAgentProvider,
  usage: any,
): Record<string, number> {
  if (!usage) return {};
  // SDK adapters do not all return the same shape. Keep this boundary
  // provider-neutral so the rest of the app only consumes measured fields.
  const raw = usage?.usageMetadata || usage?.usage || usage;
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
  if (provider === 'anthropic') {
    const directInputTokens = numberFrom(raw.input_tokens, raw.inputTokens);
    const cacheReadTokens = numberFrom(raw.cache_read_input_tokens, raw.cacheReadInputTokens);
    const cacheCreationTokens = numberFrom(raw.cache_creation_input_tokens, raw.cacheCreationInputTokens);
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
      promptTokensMeasured: wasProvided(raw.input_tokens, raw.inputTokens) || cacheTokensMeasured ? 1 : 0,
      completionTokensMeasured: wasProvided(raw.output_tokens, raw.outputTokens) ? 1 : 0,
      reasoningTokensMeasured: 0,
      cacheTokensMeasured: cacheTokensMeasured ? 1 : 0,
      cacheWriteTokensMeasured: wasProvided(raw.cache_creation_input_tokens, raw.cacheCreationInputTokens) ? 1 : 0,
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
  if (provider === 'gemini') {
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
  const promptTokens = numberFrom(raw.prompt_tokens, raw.input_tokens, raw.promptTokens, raw.inputTokens);
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
    promptTokensMeasured: wasProvided(raw.prompt_tokens, raw.input_tokens, raw.promptTokens, raw.inputTokens) ? 1 : 0,
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
  );
  const measuredCachedTokens = numberFrom(
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
