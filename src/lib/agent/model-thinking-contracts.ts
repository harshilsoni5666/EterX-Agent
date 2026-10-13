import type { MainAgentProvider, MainAgentThinkingLevel, ModelThinkingCapabilities, ModelThinkingParameter } from './model-routing';

const contract = (
  parameter: ModelThinkingParameter,
  levels: MainAgentThinkingLevel[],
  defaultLevel: MainAgentThinkingLevel = 'medium',
): ModelThinkingCapabilities => ({ parameter, levels, defaultLevel, source: 'documented' });

/**
 * Confirmed native API contracts, not model discovery or name-based guesses.
 * Only live catalogs determine availability. Unknown IDs have no controls.
 * Keep versions explicit: a future model must not inherit an older enum.
 * Sources: developers.openai.com/api/docs/models,
 * platform.claude.com/docs/en/build-with-claude/effort,
 * ai.google.dev/gemini-api/docs/thinking,
 * console.groq.com/docs/reasoning, api-docs.deepseek.com/api/list-models.
 */
export function getDocumentedThinkingCapabilities(
  provider: MainAgentProvider,
  modelName: string,
): ModelThinkingCapabilities | null {
  const model = String(modelName || '').trim().toLowerCase();
  // Only a dated snapshot of an explicitly supported ID shares its contract.
  const id = model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const effort = (...levels: MainAgentThinkingLevel[]) => contract('reasoning_effort', levels);
  const toggle = (parameter: ModelThinkingParameter, enabled = true): ModelThinkingCapabilities => ({
    ...contract(parameter, ['off', 'high'], enabled ? 'high' : 'off'), kind: 'toggle',
  });
  const switchedEffort = (toggleParameter: NonNullable<ModelThinkingCapabilities['toggleParameter']>, levels: MainAgentThinkingLevel[], defaultLevel: MainAgentThinkingLevel): ModelThinkingCapabilities => ({
    ...contract('reasoning_effort', ['off', ...levels], defaultLevel), toggleParameter, omitLevels: ['off'],
  });
  // Zen exposes the vendors' native protocols for these families, rather
  // than rewriting them all into Chat Completions (opencode.ai/docs/zen).
  if (provider === 'opencode') {
    if (id.startsWith('gpt-')) return getDocumentedThinkingCapabilities('openai', id);
    if (id.startsWith('claude-')) return getDocumentedThinkingCapabilities('anthropic', id);
    if (id.startsWith('gemini-')) return getDocumentedThinkingCapabilities('gemini', id);
    if (id.startsWith('grok-')) return getDocumentedThinkingCapabilities('grok', id);
  }

  if (provider === 'openai') {
    switch (id) {
      case 'gpt-6-astra': case 'gpt-6.1-sol':
        return effort('low', 'medium', 'high', 'xhigh', 'max');
      case 'gpt-6-sol': case 'gpt-6-luna':
      case 'gpt-5.6-sol': case 'gpt-5.6-terra': case 'gpt-5.6-luna':
        return effort('off', 'low', 'medium', 'high', 'xhigh', 'max');
      case 'gpt-5.5': case 'gpt-5.4': case 'gpt-5.4-nano': case 'gpt-5.2':
        return effort('off', 'low', 'medium', 'high', 'xhigh');
      case 'gpt-5.4-mini':
        return { ...effort('off', 'low', 'medium', 'high', 'xhigh'), defaultLevel: 'off' };
      case 'gpt-5.1':
        return { ...effort('off', 'low', 'medium', 'high'), defaultLevel: 'off' };
      case 'gpt-5': case 'gpt-5-mini': case 'gpt-5-nano':
        return effort('minimal', 'low', 'medium', 'high');
      case 'gpt-5.1-codex-max': case 'gpt-5.2-codex': case 'gpt-5.3-codex':
        return effort('low', 'medium', 'high', 'xhigh');
      case 'gpt-5-codex': case 'gpt-5.1-codex': case 'gpt-5.1-codex-mini':
      case 'o1': case 'o3': case 'o3-mini': case 'o4-mini':
        return effort('low', 'medium', 'high');
      case 'gpt-5-pro':
        return contract('reasoning_effort', ['high'], 'high');
      case 'gpt-5.2-pro': case 'gpt-5.4-pro': case 'gpt-5.5-pro':
        return contract('reasoning_effort', ['medium', 'high', 'xhigh'], 'high');
      default: return null;
    }
  }

  if (provider === 'gemini') {
    const gemini = id.replace(/^models\//, '').replace(/-preview(?:-\d{2}-\d{2})?$/, '');
    switch (gemini) {
      case 'gemini-3.8-flash':
        return contract('thinkingLevel', ['low', 'medium', 'high']);
      case 'gemini-3.6-flash':
        return contract('thinkingLevel', ['minimal', 'low', 'medium', 'high']);
      case 'gemini-3.5-flash-lite': case 'gemini-3.1-flash-lite':
      case 'gemini-3.1-flash-live':
        return contract('thinkingLevel', ['minimal', 'low', 'medium', 'high'], 'minimal');
      case 'gemini-3-flash':
        return contract('thinkingLevel', ['minimal', 'low', 'medium', 'high'], 'high');
      case 'gemini-3.1-pro':
        return contract('thinkingLevel', ['low', 'medium', 'high'], 'high');
      case 'gemini-3-pro':
        return contract('thinkingLevel', ['low', 'high'], 'high');
      case 'gemini-3.1-flash-lite-image':
        return contract('thinkingLevel', ['minimal', 'high'], 'minimal');
      case 'gemini-2.5-pro':
        return contract('thinkingBudget', ['low', 'medium', 'high']);
      case 'gemini-2.5-flash': case 'gemini-2.5-flash-lite':
        return contract('thinkingBudget', ['off', 'low', 'medium', 'high']);
      default: return null;
    }
  }

  if (provider === 'anthropic') {
    const claude = id.replace(/-\d{8}$/, '').replace(/-latest$/, '').replace(/\./g, '-');
    switch (claude) {
      case 'claude-fable-5': case 'claude-fable-5-1': case 'claude-mythos-5': case 'claude-mythos-5-1':
      case 'claude-opus-5': case 'claude-opus-4-7': case 'claude-opus-4-8':
      case 'claude-sonnet-5': case 'claude-sonnet-5-5':
        return contract('output_config.effort', ['low', 'medium', 'high', 'xhigh', 'max'], 'high');
      case 'claude-opus-5-5': case 'claude-haiku-5-5':
        return contract('output_config.effort', ['low', 'medium', 'high', 'xhigh', 'max']);
      case 'claude-mythos-preview': case 'claude-opus-4-6': case 'claude-sonnet-4-6':
        return contract('output_config.effort', ['low', 'medium', 'high', 'max'], 'high');
      case 'claude-opus-4-5':
        return contract('output_config.effort', ['low', 'medium', 'high'], 'high');
      case 'claude-sonnet-4': case 'claude-opus-4': case 'claude-opus-4-1':
      case 'claude-sonnet-4-5': case 'claude-haiku-4-5': case 'claude-3-7-sonnet':
        return contract('thinking.budget_tokens', ['off', 'low', 'medium', 'high']);
      default: return null;
    }
  }

  if (provider === 'deepseek') {
    if (['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'].includes(id)) {
      return contract('reasoning_effort', ['off', 'low', 'high', 'max'], 'high');
    }
    return null;
  }
  if (provider === 'groq') {
    if (['openai/gpt-oss-20b', 'openai/gpt-oss-120b'].includes(id)) return effort('low', 'medium', 'high');
    if (['qwen/qwen3-32b', 'qwen/qwen3.6-27b'].includes(id)) {
      return { ...contract('reasoning_effort', ['off', 'high'], 'high'), wireValues: { off: 'none', high: 'default' } };
    }
    if (id === 'qwen/qwen3.8-27b') return effort('off', 'low', 'medium', 'high');
    return null;
  }
  if (provider === 'mistral') {
    if (['mistral-small-latest', 'mistral-small-2603', 'mistral-medium-3-5', 'mistral-large-4-0'].includes(id)) {
      return contract('reasoning_effort', ['off', 'high'], 'off');
    }
    if (id === 'zai-glm-5-3') return contract('reasoning_effort', ['low', 'high', 'max'], 'high');
    return null;
  }
  if (provider === 'grok') {
    if (['grok-4.6', 'grok-4.7'].includes(id)) return contract('reasoning_effort', ['low', 'medium', 'high', 'xhigh'], 'high');
    if (id === 'grok-4.5') return effort('low', 'medium', 'high');
    if (['grok-3-mini', 'grok-3-mini-fast'].includes(id)) return contract('reasoning_effort', ['low', 'high'], 'low');
  }
  // These are hosting-provider contracts: the same weights can expose a
  // different control (or no control) on another service.
  // docs.z.ai/guides/overview/concept-param
  if (provider === 'zai') {
    if (['glm-5.3', 'glm-5.3-flash'].includes(id)) return contract('reasoning_effort', ['low', 'high', 'max'], 'max');
    if (id === 'glm-5.2') return switchedEffort('thinking.type', ['high', 'max'], 'max');
    if (['glm-4.5', 'glm-4.5-air', 'glm-4.5v', 'glm-4.6', 'glm-4.6v', 'glm-4.7', 'glm-4.7-flash', 'glm-5', 'glm-5.1'].includes(id)) return toggle('thinking.type');
  }
  // platform.kimi.ai/docs (native K3 does not accept thinking.type).
  if (provider === 'kimi') {
    if (id === 'kimi-k3') return contract('reasoning_effort', ['low', 'high', 'max'], 'max');
    if (['kimi-k2.5', 'kimi-k2.6'].includes(id)) return toggle('thinking.type');
  }
  // platform.minimax.io/docs/api-reference/text-openai-api
  if (provider === 'minimax') {
    if (id === 'minimax-m3.1-flash-preview') return contract('reasoning_effort', ['low', 'medium', 'high', 'xhigh', 'max'], 'max');
    if (id === 'minimax-m3') return { ...toggle('thinking.type'), wireValues: { off: 'disabled', high: 'adaptive' } };
    // M2 models always think; they have no adjustable effort or Off setting.
  }
  // docs.qwencloud.com/api-reference/chat/openai-chat
  if (provider === 'qwen') {
    if (['qwen3.8-max', 'qwen3.8-max-0902', 'qwen3.8-flash', 'qwen3.8-2.4t-a95b', 'qwen3.8-27b', 'qwen3.8-omni-flash'].includes(id)) return switchedEffort('enable_thinking', ['low', 'medium', 'xhigh'], 'xhigh');
    if (['glm-5.3', 'zhipu/glm-5.3'].includes(id)) return contract('reasoning_effort', ['low', 'high', 'max'], 'max');
    if (id === 'kimi-k3') return switchedEffort('enable_thinking', ['low', 'high', 'max'], 'max');
    if (['deepseek-v4-flash-0731', 'deepseek-v4-pro-0813', 'deepseek-v4.1-flash'].includes(id)) return switchedEffort('enable_thinking', ['low', 'high', 'max'], 'high');
    if (['deepseek-v4-pro', 'deepseek-v4-flash', 'glm-5', 'glm-5.1', 'glm-5.2'].includes(id)) return switchedEffort('enable_thinking', ['high', 'max'], 'high');
    if (['qwen3-235b-a22b', 'qwen3-32b', 'qwen3-30b-a3b', 'qwen3-14b', 'qwen3-8b', 'qwen3-4b', 'qwen3-1.7b', 'qwen3-0.6b', 'qwen3.5-plus', 'qwen3.6-plus'].includes(id)) return toggle('enable_thinking');
  }
  // docs.together.ai/docs/inference/chat/reasoning
  if (provider === 'together') {
    if (['openai/gpt-oss-20b', 'openai/gpt-oss-120b'].includes(id)) return effort('low', 'medium', 'high');
    if (['minimaxai/minimax-m3', 'zai-org/glm-5.2', 'moonshotai/kimi-k3', 'qwen/qwen3.6-plus', 'qwen/qwen3.5-9b'].includes(id)) return toggle('reasoning.enabled');
    if (id === 'deepseek-ai/deepseek-v4-pro-0813') return switchedEffort('reasoning.enabled', ['high', 'max'], 'high');
  }
  // NVIDIA NIM's schema is model-specific, even for OpenAI-compatible routes.
  // docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-super-120b-a12b-infer
  if (provider === 'nvidia' && id === 'nvidia/nemotron-3-super-120b-a12b') return contract('reasoning_effort', ['off', 'low', 'high'], 'high');
  if (provider === 'nvidia' && ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'].includes(id)) return effort('low', 'medium', 'high');
  // deepinfra.com/blog/glm-5-3-model-integration-guide
  if (provider === 'deepinfra' && id === 'zai-org/glm-5.3') return contract('reasoning_effort', ['low', 'high', 'max'], 'max');
  // inference-docs.cerebras.ai/capabilities/reasoning
  if (provider === 'cerebras') {
    if (id === 'gpt-oss-120b') return effort('low', 'medium', 'high');
    if (id === 'qwen-3.8-27b') return contract('reasoning_effort', ['off', 'low', 'medium', 'high'], 'high');
    if (id === 'gemma-4-31b') return { ...toggle('reasoning_effort', false), wireValues: { off: 'none', high: 'medium' } };
  }
  // mimo.mi.com/docs/en-US/api/chat/openai-api
  if (provider === 'mimo' && ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed', 'mimo-v2.5-pro', 'mimo-v2.5'].includes(id)) return toggle('thinking.type');
  // community.sambanova.ai/t/gemma-4-reasoning/1675 (provider response).
  if (provider === 'sambanova' && id === 'gemma-4-31b-it') return toggle('chat_template_kwargs.enable_thinking', false);
  // docs.fireworks.ai/api-reference/post-chatcompletions
  if (provider === 'fireworks') {
    const name = id.replace(/^accounts\/fireworks\/models\//, '');
    if (['gpt-oss-20b', 'gpt-oss-120b', 'minimax-m2', 'minimax-m2p1', 'minimax-m2p5', 'minimax-m2p7', 'minimax-m2.1', 'minimax-m2.5', 'minimax-m2.7'].includes(name)) return effort('low', 'medium', 'high');
    if (['deepseek-v4-flash', 'deepseek-v4-pro'].includes(name)) return contract('reasoning_effort', ['off', 'low', 'high', 'max'], 'low');
    if (name === 'deepseek-v4.1-flash') return contract('reasoning_effort', ['off', 'low', 'high', 'max'], 'high');
    if (['deepseek-v3p1', 'deepseek-v3p2'].includes(name)) return { ...toggle('reasoning_effort', name === 'deepseek-v3p2'), wireValues: { off: 'none', high: 'medium' } };
  }
  // A model hosted by a gateway does not inherit the origin provider's API.
  // Gateways/local servers must advertise their own parameter and enum.
  return null;
}
