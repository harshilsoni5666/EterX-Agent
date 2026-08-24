import type {
  MainAgentProvider,
  MainAgentThinkingLevel,
  ModelThinkingCapabilities,
} from './model-routing';
import { toMistralReasoningEffort, toOpenAIReasoningEffort } from './model-routing';
import { extractProviderText } from '../streaming-lifecycle';

/**
 * Request-shape capabilities, not marketing capabilities. A flag is enabled
 * only when this harness knows the provider accepts that exact wire field.
 */
const STREAM_USAGE_PROVIDERS = new Set<MainAgentProvider>([
  'openai', 'mistral', 'groq', 'deepseek', 'grok', 'cerebras', 'together',
  'fireworks', 'sambanova', 'deepinfra', 'huggingface', 'nvidia', 'qwen',
  'mimo', 'tokenhub', 'zai', 'kimi', 'minimax', 'ollamacloud', 'arcee',
  'gmi', 'upstage',
]);

const PARALLEL_TOOL_PROVIDERS = new Set<MainAgentProvider>([
  'openai', 'mistral', 'grok',
]);

export function providerSupportsStreamUsage(provider: MainAgentProvider): boolean {
  // OpenRouter includes usage automatically and deprecates stream_options.
  return STREAM_USAGE_PROVIDERS.has(provider);
}

export function providerSupportsParallelToolCalls(
  provider: MainAgentProvider,
  modelName: string,
): boolean {
  if (!PARALLEL_TOOL_PROVIDERS.has(provider)) return false;
  // Groq GPT-OSS is intentionally excluded by keeping Groq out of the set.
  return !/\b(?:o1|o3-mini)\b/i.test(String(modelName || ''));
}

export function assertProviderToolsSupported(
  provider: MainAgentProvider,
  modelName: string,
  advertisedCapabilities: string[] = [],
): void {
  const capabilities = advertisedCapabilities.map(value => String(value || '').trim().toLowerCase());
  if (capabilities.includes('tool-calling:false')) {
    throw new Error(
      `TOOLS_UNSUPPORTED: ${provider}/${modelName} is reported by its live catalog as not supporting tool calls. Select a tool-capable model for Agent mode.`,
    );
  }
}

export type CompatibleThinking = {
  level: MainAgentThinkingLevel;
  capabilities?: ModelThinkingCapabilities | null;
};

const thinkingBudget = (level: MainAgentThinkingLevel): number => {
  if (level === 'off') return 0;
  if (level === 'minimal') return 512;
  if (level === 'low') return 1024;
  if (level === 'high') return 24_576;
  if (level === 'xhigh' || level === 'max') return 32_768;
  return 8192;
};

/** Apply only a provider-native reasoning control. No retry-without fallback. */
export function applyCompatibleThinkingParameters(
  params: Record<string, any>,
  provider: MainAgentProvider,
  modelName: string,
  thinking: CompatibleThinking | null,
): void {
  if (!thinking) return;
  const level = thinking.level;
  const parameter = thinking.capabilities?.parameter;

  if (parameter === 'thinkingLevel') {
    params.thinkingLevel = level;
  } else if (parameter === 'thinkingBudget') {
    params.thinkingBudget = thinkingBudget(level);
  } else if (parameter === 'thinking.type') {
    params.thinking = { type: level === 'off' ? 'disabled' : 'enabled' };
    if (level !== 'off') {
      params.reasoning_effort = level === 'max' || level === 'xhigh' ? 'max' : 'high';
    }
  } else if (parameter === 'enable_thinking') {
    params.enable_thinking = level !== 'off';
    if (level !== 'off') params.thinking_budget = thinkingBudget(level);
  } else if (parameter === 'reasoning') {
    params.reasoning = { effort: level === 'off' ? 'none' : level, exclude: false };
  } else if (parameter === 'reasoning_effort') {
    params.reasoning_effort = toOpenAIReasoningEffort(level);
  } else if (parameter === 'output_config.effort') {
    params.output_config = { effort: level === 'off' ? 'none' : level };
  } else if (provider === 'openrouter') {
    params.reasoning = { effort: level === 'off' ? 'none' : level, exclude: false };
  } else if (provider === 'mistral') {
    params.reasoning_effort = toMistralReasoningEffort(level);
  } else if (provider === 'groq' && /gpt-oss/i.test(modelName)) {
    params.reasoning_effort = toOpenAIReasoningEffort(level);
  } else if ((provider === 'together' || provider === 'nvidia') && /gpt-oss/i.test(modelName)) {
    params.reasoning_effort = toOpenAIReasoningEffort(level);
  } else if (provider === 'grok' && /grok-(?:3|4)/i.test(modelName)) {
    params.reasoning_effort = toOpenAIReasoningEffort(level);
  } else if (provider === 'qwen') {
    params.enable_thinking = level !== 'off';
    if (level !== 'off') params.thinking_budget = thinkingBudget(level);
  } else if (provider === 'llamacpp') {
    params.chat_template_kwargs = {
      ...(params.chat_template_kwargs || {}),
      reasoning_effort: toOpenAIReasoningEffort(level),
    };
  } else if (provider === 'openai' && /(?:^|\/)(?:o[134]|gpt-5)/i.test(modelName)) {
    params.reasoning_effort = toOpenAIReasoningEffort(level);
  }
}

export function reasoningContinuationFields(
  provider: MainAgentProvider,
  reasoningText: string,
  reasoningDetails?: unknown[],
): Record<string, unknown> {
  if (provider === 'openrouter' && Array.isArray(reasoningDetails) && reasoningDetails.length > 0) {
    return { reasoning_details: reasoningDetails };
  }
  if (provider === 'openrouter') return reasoningText ? { reasoning: reasoningText } : {};
  if (['deepseek', 'mimo', 'kimi'].includes(provider)) {
    return reasoningText ? { reasoning_content: reasoningText } : {};
  }
  return {};
}

export function assertSuccessfulCompatibleFinish(
  finishReason: unknown,
  hasToolCalls: boolean,
): void {
  const reason = String(finishReason || '').trim().toLowerCase();
  if (!reason) {
    throw new Error('MODEL_STREAM_INCOMPLETE: provider closed the stream without a finish reason.');
  }
  if (reason === 'stop') return;
  if ((reason === 'tool_calls' || reason === 'function_call') && hasToolCalls) return;
  throw new Error(`MODEL_STREAM_INCOMPLETE: provider ended the stream with finish_reason=${reason}.`);
}

export function splitCompatibleDeltaContent(
  content: unknown,
): { text: string; reasoning: string } {
  if (!Array.isArray(content)) return { text: extractProviderText(content), reasoning: '' };
  let text = '';
  let reasoning = '';
  for (const part of content) {
    const type = String((part as any)?.type || '').toLowerCase();
    const value = extractProviderText(part);
    if (/think|reason|analysis/.test(type)) reasoning += value;
    else text += value;
  }
  return { text, reasoning };
}
