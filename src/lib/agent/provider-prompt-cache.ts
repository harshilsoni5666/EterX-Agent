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

export function resolveProviderPromptCacheMode(
  provider: MainAgentProvider,
  enabled: boolean,
  explicitGeminiCacheActive = false,
): ProviderPromptCacheMode {
  if (!enabled) return 'disabled';
  if (provider === 'gemini') return explicitGeminiCacheActive ? 'explicit-remote' : 'implicit-prefix';
  if (provider === 'anthropic') return 'explicit-ephemeral';
  if (provider === 'openai') return 'implicit-keyed';
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

export function removeOpenAIPromptCachePolicy(params: Record<string, any>): void {
  delete params.prompt_cache_key;
  delete params.prompt_cache_retention;
}

export function isUnsupportedOpenAICacheOptionError(message: string): boolean {
  return /(?:unknown|unsupported|unrecognized|invalid).{0,80}prompt_cache|prompt_cache.{0,80}(?:unknown|unsupported|unrecognized|invalid)/i.test(message);
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
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return 0;
  };
  if (provider === 'anthropic') {
    const directInputTokens = numberFrom(raw.input_tokens, raw.inputTokens);
    const cacheReadTokens = numberFrom(raw.cache_read_input_tokens, raw.cacheReadInputTokens);
    const cacheCreationTokens = numberFrom(raw.cache_creation_input_tokens, raw.cacheCreationInputTokens);
    const promptTokens = directInputTokens + cacheReadTokens + cacheCreationTokens;
    const completionTokens = numberFrom(raw.output_tokens, raw.outputTokens);
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cachedTokens: cacheReadTokens,
    };
  }
  if (provider === 'gemini') {
    const promptTokens = numberFrom(raw.promptTokenCount, raw.inputTokenCount, raw.promptTokens, raw.inputTokens);
    const visibleOutputTokens = numberFrom(raw.candidatesTokenCount, raw.outputTokenCount, raw.completionTokens, raw.outputTokens);
    const reasoningTokens = numberFrom(raw.thoughtsTokenCount, raw.thoughtTokenCount, raw.reasoningTokens);
    const completionTokens = visibleOutputTokens + reasoningTokens;
    const reportedTotal = numberFrom(raw.totalTokenCount, raw.totalTokens, raw.total_tokens);
    return {
      promptTokens,
      completionTokens,
      totalTokens: Math.max(reportedTotal, promptTokens + completionTokens),
      cachedTokens: numberFrom(raw.cachedContentTokenCount, raw.cachedTokens),
      reasoningTokens,
      toolUsePromptTokens: numberFrom(raw.toolUsePromptTokenCount, raw.toolUsePromptTokens),
    };
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
    completionTokens,
  };
  const cachedTokens = numberFrom(
      raw.prompt_tokens_details?.cached_tokens,
      raw.input_tokens_details?.cached_tokens,
      raw.cached_tokens,
      raw.cachedTokens,
    );
  if (cachedTokens > 0) normalized.cachedTokens = cachedTokens;
  // Preserve the compact legacy shape when a provider omits optional usage
  // fields, while retaining every measured metric when it is present.
  if (reportedTotal > 0) normalized.totalTokens = reportedTotal;
  if (reasoningTokens > 0) normalized.reasoningTokens = reasoningTokens;
  return normalized;
}
