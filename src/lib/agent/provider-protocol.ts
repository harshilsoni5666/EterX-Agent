import type { MainAgentProvider } from './model-routing';

export type ProviderProtocol = 'chat' | 'responses' | 'messages' | 'generateContent';

/** Endpoint contracts are independent of model effort controls. */
export function getProviderProtocol(provider: MainAgentProvider, model: string, capabilities: string[] = []): ProviderProtocol {
  // Native reasoning models need Responses for readable summaries (and GPT-6
  // tool calls with thinking). Older catalog snapshots may list only Chat.
  if (provider === 'openai' && /^(?:gpt-(?:[5-9]|[1-9]\d+)|o[134](?:-|$))|codex/i.test(model)) return 'responses';
  const endpoints = capabilities.filter(value => value.startsWith('api:')).map(value => value.slice(4));
  if (endpoints.length) {
    // Reasoning summaries are available through Responses. A catalog that
    // advertises both endpoints must not send OpenAI thinking through Chat.
    if (provider === 'openai' && endpoints.includes('responses')) return 'responses';
    for (const protocol of ['chat', 'responses', 'messages', 'generateContent'] as const) {
      if (endpoints.includes(protocol)) return protocol;
    }
  }
  if (provider === 'gemini') return 'generateContent';
  if (provider === 'anthropic') return 'messages';
  if (provider === 'perplexity' || provider === 'lmstudio') return 'responses';
  // OpenCode Zen publishes a different endpoint per model. A Claude/Gemini
  // model in its catalog is not an OpenAI Chat Completions model.
  // https://opencode.ai/docs/zen/#models
  if (provider === 'opencode') {
    if (/^claude-/i.test(model) || ['qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.5-plus'].includes(model)) return 'messages';
    if (/^gemini-/i.test(model)) return 'generateContent';
    if (/^(?:gpt-|grok-|muse-spark-)/i.test(model)) return 'responses';
  }
  return 'chat';
}
