import type {
  MainAgentProvider,
  MainAgentThinkingLevel,
  ModelThinkingCapabilities,
} from './model-routing';
import { getAnthropicThinkingBudget, resolveModelThinkingCapabilities, normalizeThinkingLevelForModel, toOpenAIReasoningEffort } from './model-routing';
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

/** Request readable Claude thinking without touching signed history blocks. */
export function applyAnthropicThinkingDisplay(params: Record<string, any>): void {
  if (params.thinking?.type === 'adaptive' || params.thinking?.type === 'enabled') {
    params.thinking = { ...params.thinking, display: 'summarized' };
  }
}

/** Read both initial blocks and deltas, and close thinking before tool output. */
export function createAnthropicContentStreamReader() {
  const blocks = new Map<number, string>();
  const reasoningByBlock = new Map<number, string>();
  const read = (event: any): { text: string; reasoning: string; reasoningBoundary: boolean } => {
    const result = { text: '', reasoning: '', reasoningBoundary: false };
    if (event?.type === 'content_block_start') {
      const block = event.content_block;
      blocks.set(event.index, String(block?.type || ''));
      if (block?.type === 'thinking') result.reasoning = extractProviderReasoningText(block);
      if (block?.type === 'text') result.text = extractProviderText(block);
    } else if (event?.type === 'content_block_delta') {
      if (event.delta?.type === 'thinking_delta') result.reasoning = extractProviderReasoningText(event.delta.thinking);
      if (event.delta?.type === 'text_delta') result.text = extractProviderText(event.delta.text);
    } else if (event?.type === 'content_block_stop') {
      result.reasoningBoundary = blocks.get(event.index) === 'thinking';
      blocks.delete(event.index);
    }
    if (result.reasoning) {
      reasoningByBlock.set(event.index, (reasoningByBlock.get(event.index) || '') + result.reasoning);
    }
    return result;
  };
  return Object.assign(read, {
    remainingReasoning(content: unknown): string[] {
      if (!Array.isArray(content)) return [];
      return content.flatMap((block, index) => {
        if (block?.type !== 'thinking') return [];
        const full = extractProviderReasoningText(block);
        const streamed = reasoningByBlock.get(index) || '';
        if (!full.startsWith(streamed)) return [];
        reasoningByBlock.set(index, full);
        const remaining = full.slice(streamed.length);
        // Some Messages gateways deliver readable thinking only in the final
        // block. Preserve it, without replaying already streamed Markdown or
        // treating opaque signatures/redacted blocks as visible thoughts.
        return remaining ? [remaining] : [];
      });
    },
  });
}

/** Extract only readable reasoning; signatures and encrypted data are opaque. */
export function extractProviderReasoningText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractProviderReasoningText).join('');
  if (!value || typeof value !== 'object') return '';
  const part = value as Record<string, any>;
  if (/encrypted|redacted|signature/i.test(String(part.type || ''))) return '';
  for (const key of ['text', 'thinking', 'reasoning', 'summary', 'content', 'value', 'output_text', 'outputText']) {
    const text = extractProviderReasoningText(part[key]);
    if (text) return text;
  }
  return '';
}

export function extractCompatibleReasoningText(payload: Record<string, any> | null | undefined): string {
  if (!payload) return '';
  for (const key of ['reasoning_content', 'reasoning', 'thinking', 'thought', 'analysis', 'reasoning_details', 'reasoningDetails', 'reasoningContent']) {
    const text = extractProviderReasoningText(payload[key]);
    // Empty aliases must not hide another provider's populated field. Several
    // gateways return both readable text and its mirror in reasoning_details.
    if (text) return text;
  }
  return '';
}

/** Apply only a provider-native reasoning control. No retry-without fallback. */
export function applyCompatibleThinkingParameters(
  params: Record<string, any>,
  provider: MainAgentProvider,
  modelName: string,
  thinking: CompatibleThinking | null,
): void {
  if (!thinking) return;
  const capabilities = resolveModelThinkingCapabilities(provider, modelName, thinking.capabilities);
  if (!capabilities?.parameter || !capabilities.levels.length) return;
  const level = normalizeThinkingLevelForModel(thinking.level, provider, modelName, capabilities);
  const effort = capabilities.wireValues?.[level] ?? toOpenAIReasoningEffort(level);

  const setToggle = (parameter: string, enabled: boolean) => {
    if (parameter === 'thinking.type') params.thinking = { type: enabled ? 'enabled' : 'disabled' };
    else if (parameter === 'enable_thinking') params.enable_thinking = enabled;
    else if (parameter === 'reasoning.enabled') params.reasoning = { ...(params.reasoning || {}), enabled };
    else if (parameter === 'chat_template_kwargs.enable_thinking') params.chat_template_kwargs = { ...(params.chat_template_kwargs || {}), enable_thinking: enabled };
  };
  if (capabilities.toggleParameter) setToggle(capabilities.toggleParameter, level !== 'off');
  if (capabilities.omitLevels?.includes(level)) return;

  switch (capabilities.parameter) {
    case 'thinkingLevel':
      params.thinkingLevel = capabilities.wireValues?.[level] ?? level;
      break;
    case 'thinkingBudget':
      params.thinkingBudget = thinkingBudget(level);
      break;
    case 'thinking_level':
      params.thinking_level = capabilities.wireValues?.[level] ?? level;
      break;
    case 'thinking_budget':
      params.thinking_budget = thinkingBudget(level);
      break;
    case 'thinking.type':
      params.thinking = { type: capabilities.wireValues?.[level] ?? (level === 'off' ? 'disabled' : 'enabled') };
      break;
    case 'enable_thinking':
    case 'reasoning.enabled':
    case 'chat_template_kwargs.enable_thinking':
      setToggle(capabilities.parameter, level !== 'off');
      break;
    case 'chat_template_kwargs.thinking':
      params.chat_template_kwargs = { ...(params.chat_template_kwargs || {}), thinking: level !== 'off' };
      break;
    case 'reasoning':
      params.reasoning = { ...(params.reasoning || {}), effort };
      break;
    case 'reasoning_effort':
      params.reasoning_effort = effort;
      if (provider === 'groq' && /^qwen\//i.test(modelName)) params.reasoning_format = 'parsed';
      break;
    case 'output_config.effort':
      params.output_config = { effort };
      break;
    case 'thinking.budget_tokens':
      params.thinking = level === 'off' ? { type: 'disabled' } : { type: 'enabled', budget_tokens: getAnthropicThinkingBudget(level) };
      break;
    case 'chat_template_kwargs.reasoning_effort':
      params.chat_template_kwargs = { ...(params.chat_template_kwargs || {}), reasoning_effort: effort };
      break;
  }
}
export function reasoningContinuationFields(
  provider: MainAgentProvider,
  reasoningText: string,
  reasoningDetails?: unknown[],
  returnedFields?: Record<string, unknown>,
): Record<string, unknown> {
  if (returnedFields) {
    // Preserve the fields the selected endpoint actually returned, including
    // hosted models. Never translate another provider's reasoning vocabulary.
    return Object.fromEntries(['reasoning_content', 'reasoning', 'reasoning_details']
      .filter(key => typeof returnedFields[key] === 'string' || Array.isArray(returnedFields[key]))
      .map(key => [key, returnedFields[key]]));
  }
  if (provider === 'openrouter' && Array.isArray(reasoningDetails) && reasoningDetails.length > 0) {
    return { reasoning_details: reasoningDetails };
  }
  if (provider === 'openrouter') return reasoningText ? { reasoning: reasoningText } : {};
  if (['deepseek', 'mimo', 'kimi', 'zai', 'qwen', 'minimax', 'fireworks'].includes(provider)) {
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
      ? extractProviderReasoningText(part)
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
