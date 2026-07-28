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
  delete params.stream_options;
}

export function isUnsupportedOpenAICacheOptionError(message: string): boolean {
  return /(?:unknown|unsupported|unrecognized|invalid).{0,80}(?:prompt_cache|stream_options)|(?:prompt_cache|stream_options).{0,80}(?:unknown|unsupported|unrecognized|invalid)/i.test(message);
}

export function normalizeProviderCacheUsage(
  provider: MainAgentProvider,
  usage: any,
): Record<string, number> {
  if (!usage) return {};
  if (provider === 'anthropic') {
    return {
      promptTokens: usage.input_tokens ?? 0,
      completionTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    };
  }
  if (provider === 'gemini') {
    const promptTokens = usage.promptTokenCount ?? usage.inputTokenCount ?? 0;
    const completionTokens = usage.candidatesTokenCount ?? usage.outputTokenCount ?? 0;
    return {
      promptTokens,
      completionTokens,
      totalTokens: usage.totalTokenCount ?? (promptTokens + completionTokens),
      cachedTokens: usage.cachedContentTokenCount ?? 0,
    };
  }
  return {
    promptTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    cachedTokens:
      usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      0,
  };
}
