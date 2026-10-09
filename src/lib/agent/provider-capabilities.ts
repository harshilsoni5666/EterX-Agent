import type {
  MainAgentProvider,
  MainAgentThinkingLevel,
  ModelThinkingCapabilities,
} from './model-routing';
import { inferModelThinkingCapabilities, isOpenAIReasoningModel, normalizeThinkingLevelForModel, toMistralReasoningEffort, toOpenAIReasoningEffort } from './model-routing';
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
  const level = normalizeThinkingLevelForModel(thinking.level, provider, modelName, thinking.capabilities);
  const parameter = thinking.capabilities?.parameter;

  if (provider === 'grok') {
    const capabilities = thinking.capabilities?.source === 'provider'
      ? thinking.capabilities : inferModelThinkingCapabilities(provider, modelName);
    if (capabilities?.parameter === 'reasoning_effort') params.reasoning_effort = toOpenAIReasoningEffort(level);
    return;
  }

  // Provider/model semantics win over a generic parameter label. Groq's Qwen
  // models use only none/default, unlike GPT-OSS low/medium/high.
  if (provider === 'groq' && /qwen(?:\/|[-_])?qwen?3|qwen3/i.test(modelName)) {
    params.reasoning_effort = level === 'off' ? 'none' : 'default';
    params.reasoning_format = 'parsed';
  } else if (parameter === 'thinkingLevel') {
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
  } else if (provider === 'qwen') {
    params.enable_thinking = level !== 'off';
    if (level !== 'off') params.thinking_budget = thinkingBudget(level);
  } else if (provider === 'llamacpp') {
    params.chat_template_kwargs = {
      ...(params.chat_template_kwargs || {}),
      reasoning_effort: toOpenAIReasoningEffort(level),
    };
  } else if (provider === 'openai' && isOpenAIReasoningModel(modelName)) {
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

export type CompatibleTaggedReasoningSplitter = {
  push: (content: string) => { text: string; reasoning: string };
  flush: () => { text: string; reasoning: string };
};

const TAGGED_REASONING_PAIRS = [
  ['<think>', '</think>'],
  ['<thinking>', '</thinking>'],
  ['<reasoning>', '</reasoning>'],
  ['<analysis>', '</analysis>'],
] as const;

const longestTagPrefixSuffix = (value: string, tags: readonly string[]): number => {
  const lower = value.toLowerCase();
  let longest = 0;
  for (const tag of tags) {
    const normalizedTag = tag.toLowerCase();
    const limit = Math.min(lower.length, normalizedTag.length - 1);
    for (let length = limit; length > longest; length -= 1) {
      if (lower.endsWith(normalizedTag.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
};

/**
 * Some OpenAI-compatible providers expose native reasoning as tagged content
 * instead of a reasoning field. Keep a tiny cross-chunk parser per provider
 * request so split tags never leak into the answer or appear only after the
 * response settles. Opening tags are recognized only before visible answer
 * text, which keeps literal examples such as code snippets intact.
 */
export function createCompatibleTaggedReasoningSplitter(): CompatibleTaggedReasoningSplitter {
  let pending = '';
  let activeCloseTag = '';
  let allowOpeningTag = true;

  const push = (content: string) => {
    let remaining = pending + String(content || '');
    pending = '';
    let text = '';
    let reasoning = '';

    while (remaining) {
      const lower = remaining.toLowerCase();
      if (activeCloseTag) {
        const closeIndex = lower.indexOf(activeCloseTag);
        if (closeIndex >= 0) {
          reasoning += remaining.slice(0, closeIndex);
          remaining = remaining.slice(closeIndex + activeCloseTag.length);
          activeCloseTag = '';
          allowOpeningTag = false;
          continue;
        }
        const retained = longestTagPrefixSuffix(remaining, [activeCloseTag]);
        reasoning += retained > 0 ? remaining.slice(0, -retained) : remaining;
        pending = retained > 0 ? remaining.slice(-retained) : '';
        break;
      }

      if (!allowOpeningTag) {
        text += remaining;
        break;
      }

      let openingIndex = -1;
      let openingTag = '';
      let closingTag = '';
      for (const [candidateOpen, candidateClose] of TAGGED_REASONING_PAIRS) {
        const candidateIndex = lower.indexOf(candidateOpen);
        if (candidateIndex >= 0 && (openingIndex < 0 || candidateIndex < openingIndex)) {
          openingIndex = candidateIndex;
          openingTag = candidateOpen;
          closingTag = candidateClose;
        }
      }

      if (openingIndex >= 0) {
        const before = remaining.slice(0, openingIndex);
        // Reasoning envelopes are a response prefix. Once normal answer text
        // begins, a tag-looking string is user-facing content, not control.
        if (before.trim()) {
          text += remaining;
          allowOpeningTag = false;
          break;
        }
        text += before;
        remaining = remaining.slice(openingIndex + openingTag.length);
        activeCloseTag = closingTag;
        continue;
      }

      const retained = longestTagPrefixSuffix(
        remaining,
        TAGGED_REASONING_PAIRS.map(([open]) => open),
      );
      const visible = retained > 0 ? remaining.slice(0, -retained) : remaining;
      text += visible;
      if (visible.trim()) allowOpeningTag = false;
      pending = retained > 0 ? remaining.slice(-retained) : '';
      break;
    }

    return { text, reasoning };
  };

  return {
    push,
    flush: () => {
      const result = activeCloseTag
        ? { text: '', reasoning: pending }
        : { text: pending, reasoning: '' };
      pending = '';
      activeCloseTag = '';
      allowOpeningTag = false;
      return result;
    },
  };
}

export function splitCompatibleDeltaContent(
  content: unknown,
  taggedReasoning?: CompatibleTaggedReasoningSplitter,
): { text: string; reasoning: string } {
  if (!Array.isArray(content)) {
    const text = extractProviderText(content);
    return taggedReasoning ? taggedReasoning.push(text) : { text, reasoning: '' };
  }
  let text = '';
  let reasoning = '';
  for (const part of content) {
    const type = String((part as any)?.type || '').toLowerCase();
    const isReasoning = /think|reason|analysis/.test(type);
    const value = isReasoning
      ? extractProviderText((part as any)?.thinking ?? (part as any)?.reasoning ?? part)
      : extractProviderText(part);
    if (isReasoning) {
      reasoning += value;
    } else if (taggedReasoning) {
      const split = taggedReasoning.push(value);
      text += split.text;
      reasoning += split.reasoning;
    } else {
      text += value;
    }
  }
  return { text, reasoning };
}

/**
 * Accumulate Mistral's streamed content chunks without flattening ThinkChunk.
 * The complete structured assistant content is replayed after tool calls, as
 * required by Mistral's reasoning contract.
 */
export function appendMistralStructuredContent(
  accumulated: any[],
  deltaContent: unknown,
): any[] {
  if (!Array.isArray(deltaContent)) return accumulated;
  const next = [...accumulated];
  for (const rawPart of deltaContent) {
    if (!rawPart || typeof rawPart !== 'object') continue;
    const part = rawPart as Record<string, any>;
    const type = String(part.type || '').toLowerCase();
    if (/think|reason|analysis/.test(type)) {
      const text = extractProviderText(part.thinking ?? part.reasoning ?? part);
      if (!text) continue;
      const previous = next[next.length - 1];
      if (previous?.type === part.type && Array.isArray(previous.thinking)) {
        const inner = previous.thinking[previous.thinking.length - 1];
        if (inner?.type === 'text') inner.text = `${String(inner.text || '')}${text}`;
        else previous.thinking.push({ type: 'text', text });
      } else {
        next.push({ ...part, thinking: [{ type: 'text', text }] });
      }
      continue;
    }

    const text = extractProviderText(part);
    if (!text) {
      next.push(part);
      continue;
    }
    const previous = next[next.length - 1];
    if (previous?.type === part.type && typeof previous.text === 'string') {
      previous.text = `${previous.text}${text}`;
    } else {
      next.push({ ...part, text });
    }
  }
  return next;
}
