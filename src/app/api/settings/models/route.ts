import { requestModelCatalog } from '../../../../lib/model-discovery-request';
import { NextRequest, NextResponse } from 'next/server';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  getRuntimeApiKeyStatus,
  getRuntimeApiKeyValues as savedApiKeyValues,
  type RuntimeApiKeyProvider,
} from '../../../../lib/agent/runtime-api-keys';
import {
  getModelThinkingOptions,
  inferModelThinkingCapabilities,
  isAnthropicAdaptiveThinkingModel,
  normalizeModelThinkingCapabilities,
  type MainAgentProvider,
  type ModelThinkingCapabilities,
} from '../../../../lib/agent/model-routing';
import { isModelProvider } from '../../../../lib/agent/model-selector-store';
import {
  getProviderBaseURL as savedProviderBaseURL,
  getRuntimeProviderBaseURLs,
  normalizeProviderBaseURL,
  isLocalModelProvider,
} from '../../../../lib/agent/provider-runtime';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';
import { rejectCrossOrigin } from '../../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Discovery and per-key connection checks are read-only. Their credentials
// must not replace a running chat's settings or leak into another request.
const discoveryScope = new AsyncLocalStorage<{
  deadlineAt: number;
  keys: Record<string, string[]>;
  baseURLs: Partial<Record<MainAgentProvider, string>>;
}>();
const requestJson = async (input: string, init: RequestInit = {}, timeoutMs = 12_000) => {
  const remaining = (discoveryScope.getStore()?.deadlineAt ?? Date.now() + 35_000) - Date.now();
  if (remaining <= 0) throw new Error('Model discovery timed out. Please retry.');
  const response = await requestModelCatalog(input, init, Math.min(timeoutMs, remaining));
  if (!response.ok) return response;
  const payload = await response.json();
  if (!Array.isArray(payload) && !['data', 'models', 'voices'].some(key => Array.isArray(payload?.[key]))) {
    throw new Error('Provider returned an invalid model catalog. Saved models have been kept.');
  }
  return response;
};
const getRuntimeApiKeyValues = (provider: RuntimeApiKeyProvider): string[] =>
  discoveryScope.getStore()?.keys[provider] || (discoveryScope.getStore() ? [] : savedApiKeyValues(provider));
const getProviderBaseURL = (provider: MainAgentProvider): string =>
  savedProviderBaseURL(provider, discoveryScope.getStore()?.baseURLs);

type ProviderModel = {
  id: string;
  name: string;
  description?: string;
  baseModelId?: string;
  version?: string;
  lifecycle?: string;
  deprecationDate?: string;
  contextLength?: number;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  capabilities?: string[];
  thinking?: ModelThinkingCapabilities;
  createdAt?: number;
};

type ProviderModelResult = {
  provider: RuntimeApiKeyProvider;
  connected: boolean;
  source: 'live' | 'unavailable';
  models: ProviderModel[];
  excludedCount?: number;
  error?: string;
};

const MODEL_FETCH_TIMEOUT_MS = 12_000;

const NON_AGENT_MODEL_ID = /(?:^|[/:._-])(?:audio|embed(?:ding)?s?|image|moderation|orpheus|realtime|speech|transcri(?:be|ption)|translate|tts|whisper|guard|rerank|search|video)(?:$|[/:._-])/i;
const NON_CONCRETE_MODEL_ID = /^(?:auto|default|latest|recommended)(?:[\s_-]|$)/i;

const isExpired = (value: unknown) => {
  if (!value) return false;
  const timestamp = typeof value === 'number'
    ? (value > 10_000_000_000 ? value : value * 1000)
    : Date.parse(String(value));
  return Number.isFinite(timestamp) && timestamp <= Date.now();
};

const readModelAvailability = (model: any) => ({
  lifecycle: model?.active === false || model?.enabled === false || model?.deprecated === true
    ? 'disabled' : String(model?.lifecycle || model?.status || ''),
  deprecationDate: model?.deprecationDate || model?.expiration_date || model?.shutdown_at || model?.end_of_life,
});

const isAgentCompatibleModel = (model: ProviderModel) => {
  const id = String(model.id || '').trim();
  if (!id || id.toLowerCase() === 'openrouter/auto' || id.toLowerCase().startsWith('kilo-auto/') || NON_CONCRETE_MODEL_ID.test(id) || NON_AGENT_MODEL_ID.test(id) || isExpired(model.deprecationDate)) return false;
  if (model.capabilities?.includes('tool-calling:false')) return false;
  const lifecycle = String(model.lifecycle || '').toLowerCase();
  return !['deprecated', 'retired', 'disabled', 'expired', 'unavailable'].some(status => lifecycle.includes(status));
};

const trimModels = (models: ProviderModel[]) => {
  const seen = new Set<string>();
  return models.map(model => ({ ...model, ...readModelAvailability(model), id: String(model.id || '').trim() })).filter(model => {
    if (!isAgentCompatibleModel(model) || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
};

const preferredModelScore = (provider: string, model: ProviderModel) => {
  void provider;
  const id = model.id.toLowerCase();
  let score = Number(model.createdAt || 0) / 1_000_000_000;
  if (/preview|experimental|\bexp\b/.test(id)) score -= 20;
  return score;
};

const resultWithExcluded = (
  provider: RuntimeApiKeyProvider,
  rawModels: ProviderModel[],
): ProviderModelResult => {
  const models = trimModels(rawModels)
    .map(model => {
      const providerId = String(provider);
      if (model.thinking || !isModelProvider(providerId)) return model;
      const inferred = inferModelThinkingCapabilities(providerId, model.id);
      return inferred ? { ...model, thinking: inferred } : model;
    })
    .map((model, index) => ({ model, index }))
    .sort((a, b) => preferredModelScore(provider, b.model) - preferredModelScore(provider, a.model) || a.index - b.index)
    .map(({ model }) => model);
  return {
    provider,
    connected: true,
    source: 'live',
    models,
    excludedCount: Math.max(0, rawModels.length - models.length),
  };
};

/** Normalize live model metadata without assuming a provider-specific schema. */
const readThinkingCapabilities = (model: any, parameter: ModelThinkingCapabilities['parameter']) => {
  const reasoning = model?.reasoning || model?.capabilities?.reasoning || {};
  const thinking = model?.thinking || model?.thinkingConfig || model?.capabilities?.thinking || {};
  return normalizeModelThinkingCapabilities({
    levels: reasoning.supported_efforts
      || reasoning.supportedEfforts
      || thinking.supported_levels
      || thinking.supportedLevels
      || thinking.supported_thinking_levels
      || model?.supported_reasoning_efforts
      || model?.supportedThinkingLevels,
    defaultLevel: reasoning.default_effort
      || reasoning.defaultEffort
      || thinking.default_level
      || thinking.defaultLevel
      || model?.default_reasoning_effort,
    parameter,
  });
};

const readAdvertisedThinkingCapabilities = (
  model: any,
  provider: MainAgentProvider,
  fallbackParameter: ModelThinkingCapabilities['parameter'],
): ModelThinkingCapabilities | null => {
  const explicit = readThinkingCapabilities(model, fallbackParameter);
  if (explicit) return explicit;

  const supported = Array.isArray(model?.supported_parameters)
    ? model.supported_parameters.map((value: unknown) => String(value || '').trim().toLowerCase())
    : [];
  const has = (...names: string[]) => names.some(name => supported.includes(name));
  const parameter: ModelThinkingCapabilities['parameter'] | undefined = has('thinking_level', 'thinkinglevel')
    ? 'thinkingLevel'
    : has('thinking_budget', 'thinkingbudget')
      ? 'thinkingBudget'
      : has('enable_thinking', 'thinking_enabled')
        ? 'enable_thinking'
        : has('output_config.effort')
          ? 'output_config.effort'
          : has('reasoning_effort', 'reasoning.effort')
            ? 'reasoning_effort'
            : has('reasoning')
              ? 'reasoning'
              : provider === 'deepseek' && has('thinking')
                ? 'thinking.type'
                : undefined;
  if (!parameter) return inferModelThinkingCapabilities(provider, String(model?.id || model?.name || ''));

  const inferred = inferModelThinkingCapabilities(provider, String(model?.id || model?.name || ''));
  const levels: ModelThinkingCapabilities['levels'] = inferred?.levels?.length
    ? [...inferred.levels]
    : parameter === 'thinking.type'
      ? ['off', 'high', 'max']
      : parameter === 'enable_thinking'
        ? ['off', 'high']
        : parameter === 'thinkingLevel' || parameter === 'thinkingBudget' || parameter === 'reasoning'
          ? ['off', 'low', 'medium', 'high']
          : ['high'];
  const defaultLevel = levels.includes('medium')
    ? 'medium'
    : levels.includes('high')
      ? 'high'
      : levels.find(level => level !== 'off') || levels[0];
  return {
    levels: [...levels],
    defaultLevel,
    parameter,
    source: 'provider',
  };
};

const providerError = (provider: RuntimeApiKeyProvider, error: unknown): ProviderModelResult => ({
  provider,
  connected: false,
  source: 'unavailable',
  models: [],
  error: error instanceof Error ? error.message : String(error || 'Model discovery failed'),
});

async function fetchGeminiModels(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKeyValues('gemini')[0];
  if (!apiKey) return { provider: 'gemini', connected: false, source: 'unavailable', models: [], error: 'Missing Gemini API key' };

  try {
    const rawModels: any[] = [];
    let pageToken = '';
    // models.list is paginated even when pageSize=1000. Keep discovery the
    // source of truth rather than silently dropping later model pages.
    for (let page = 0; page < 100; page++) {
      const token = pageToken ? `&pageToken=${ encodeURIComponent(pageToken) }` : '';
      const res = await requestJson(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${ token }`, {
        cache: 'no-store',
        headers: { 'x-goog-api-key': apiKey },
      }, MODEL_FETCH_TIMEOUT_MS);
      if (!res.ok) throw new Error(`Gemini models request failed (${ res.status })`);
      const data = await res.json();
      rawModels.push(...(Array.isArray(data.models) ? data.models : []));
      pageToken = String(data.nextPageToken || '');
      if (!pageToken) break;
      if (pageTokens.has(pageToken) || page === 99) throw new Error('Provider returned an incomplete model catalog. Please retry.');
      pageTokens.add(pageToken);
    }

    const mappedModels = rawModels
      .filter((model: any) => Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent'))
      .map((model: any) => ({
        ...readModelAvailability(model),
        id: String(model.name || model.baseModelId || '').replace(/^models\//, ''),
        name: model.displayName || String(model.name || '').replace(/^models\//, ''),
        description: model.description,
        baseModelId: model.baseModelId,
        version: model.version,
        ...readModelAvailability(model),
        inputTokenLimit: model.inputTokenLimit,
        outputTokenLimit: model.outputTokenLimit,
        capabilities: [
          ...(model.supportedGenerationMethods || []),
          model.inputTokenLimit ? 'text-input' : undefined,
          model.thinking ? 'thinking' : undefined,
        ].filter(Boolean),
        thinking: readThinkingCapabilities(
          model,
          /gemini-2\.5/i.test(String(model.baseModelId || model.name || '')) ? 'thinkingBudget' : 'thinkingLevel',
        ) || (model.thinking
          ? {
            levels: getModelThinkingOptions('gemini', String(model.baseModelId || model.name || '')).map(option => option.id),
            defaultLevel: getModelThinkingOptions('gemini', String(model.baseModelId || model.name || '')).find(option => option.id === 'medium')?.id
              || getModelThinkingOptions('gemini', String(model.baseModelId || model.name || ''))[0]?.id,
            parameter: /gemini-2\.5/i.test(String(model.baseModelId || model.name || '')) ? 'thinkingBudget' as const : 'thinkingLevel' as const,
            source: 'inferred' as const,
          }
          : undefined),
      }));
    return resultWithExcluded('gemini', mappedModels);
  } catch (error) {
    return providerError('gemini', error);
  }
}

async function fetchOpenAIModels(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKeyValues('openai')[0];
  if (!apiKey) return { provider: 'openai', connected: false, source: 'unavailable', models: [], error: 'Missing OpenAI API key' };

  try {
    const baseUrl = getProviderBaseURL('openai');
    const res = await requestJson(`${baseUrl}/models`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${ apiKey }` },
    }, MODEL_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`OpenAI models request failed (${ res.status })`);
    const data = await res.json();
    const mappedModels = (data.data || [])
      .filter((model: any) => /^(?:ft:)?(?:gpt-|o[1-9](?:-|$)|chatgpt-)/i.test(String(model.id || '')))
      .map((model: any) => ({
        ...readModelAvailability(model),
        id: String(model.id || ''),
        name: String(model.id || ''),
        description: model.owned_by ? `Owned by ${ model.owned_by }` : undefined,
        createdAt: Number(model.created) || undefined,
        thinking: readThinkingCapabilities(model, 'reasoning_effort') || (() => {
          const levels = getModelThinkingOptions('openai', String(model.id || '')).map(option => option.id);
          return levels.length > 0
            ? { levels, defaultLevel: levels.includes('medium') ? 'medium' as const : levels[0], parameter: 'reasoning_effort' as const, source: 'inferred' as const }
            : undefined;
        })(),
      }))
      .sort((a: ProviderModel, b: ProviderModel) => (b.createdAt || 0) - (a.createdAt || 0) || a.id.localeCompare(b.id));
    return resultWithExcluded('openai', mappedModels);
  } catch (error) {
    return providerError('openai', error);
  }
}

async function fetchOpenRouterModels(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKeyValues('openrouter')[0];
  if (!apiKey) {
    return {
      provider: 'openrouter',
      connected: false,
      source: 'unavailable',
      models: [],
      error: 'Add an OpenRouter API key to load models',
    };
  }

  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${ apiKey }` };
    const baseUrl = getProviderBaseURL('openrouter');
    const res = await requestJson(`${baseUrl}/models?output_modalities=all`, {
      cache: 'no-store',
      headers,
    }, MODEL_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`OpenRouter models request failed (${ res.status })`);
    const data = await res.json();
    const mappedModels = (data.data || [])
      .filter((model: any) => {
        const outputs = Array.isArray(model.architecture?.output_modalities) ? model.architecture.output_modalities : [];
        const parameters = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
        return (outputs.length === 0 || outputs.includes('text'))
          && parameters.includes('tools')
          && !isExpired(model.expiration_date);
      })
      .map((model: any) => {
        const supportedParameters = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
        const inferredThinking = getModelThinkingOptions('openrouter', String(model.id || '')).map(option => option.id);
        const genericReasoning = supportedParameters.includes('reasoning')
          ? (inferredThinking.length > 0 ? inferredThinking : ['off', 'low', 'medium', 'high'])
          : [];
        return {
          ...readModelAvailability(model),
          id: String(model.id || ''),
          name: model.name || model.id,
          description: model.description,
          contextLength: model.context_length,
          outputTokenLimit: Number(model.top_provider?.max_completion_tokens) || undefined,
          deprecationDate: model.expiration_date || undefined,
          createdAt: Number(model.created) || undefined,
          capabilities: [
            ...(model.architecture?.input_modalities || []),
            ...(model.architecture?.output_modalities || []),
            model.architecture?.instruct_type,
            ...supportedParameters,
          ].filter(Boolean),
          thinking: readThinkingCapabilities(model, 'reasoning') || (genericReasoning.length > 0
            ? { levels: genericReasoning, defaultLevel: genericReasoning.includes('medium') ? 'medium' : genericReasoning[0], parameter: 'reasoning', source: 'inferred' }
            : undefined),
        } as ProviderModel;
      })
      .sort((a: ProviderModel, b: ProviderModel) => (b.createdAt || 0) - (a.createdAt || 0));
    return resultWithExcluded('openrouter', mappedModels);
  } catch (error) {
    return providerError('openrouter', error);
  }
}

async function fetchGroqModels(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKeyValues('groq')[0];
  if (!apiKey) return { provider: 'groq', connected: false, source: 'unavailable', models: [], error: 'Missing Groq API key' };

  try {
    const baseUrl = getProviderBaseURL('groq');
    const res = await requestJson(`${baseUrl}/models`, {
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${ apiKey }`,
        'Content-Type': 'application/json',
      },
    }, MODEL_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Groq models request failed (${ res.status })`);
    const data = await res.json();
    const mappedModels = (data.data || [])
      .map((model: any) => ({
        ...readModelAvailability(model),
        id: String(model.id || ''),
        name: String(model.id || ''),
        description: model.owned_by ? `Owned by ${ model.owned_by }` : undefined,
        ...readModelAvailability(model),
        contextLength: model.context_window,
        thinking: readThinkingCapabilities(model, 'reasoning_effort') || (() => {
          const levels = getModelThinkingOptions('groq', String(model.id || '')).map(option => option.id);
          if (levels.length === 0) return undefined;
          return {
            levels,
            defaultLevel: /qwen/i.test(String(model.id || '')) ? 'high' : 'medium',
            parameter: 'reasoning_effort',
            source: 'inferred',
          } as ModelThinkingCapabilities;
        })(),
      }))
      .sort((a: ProviderModel, b: ProviderModel) => a.id.localeCompare(b.id));
    return resultWithExcluded('groq', mappedModels);
  } catch (error) {
    return providerError('groq', error);
  }
}

async function fetchMistralModels(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKeyValues('mistral')[0];
  if (!apiKey) return { provider: 'mistral', connected: false, source: 'unavailable', models: [], error: 'Missing Mistral API key' };

  try {
    const baseUrl = getProviderBaseURL('mistral');
    const res = await requestJson(`${baseUrl}/models`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${ apiKey }` },
    }, MODEL_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Mistral models request failed (${ res.status })`);
    const data = await res.json();
    const mappedModels = (data.data || [])
      .filter((model: any) => {
        const capabilities = model.capabilities || {};
        return capabilities.completion_chat !== false && capabilities.function_calling !== false;
      })
      .map((model: any) => ({
      ...readModelAvailability(model),
      id: String(model.id || ''),
      name: model.name || model.id,
      description: model.description,
        capabilities: Object.entries(model.capabilities || {})
          .filter(([, enabled]) => Boolean(enabled))
          .map(([name]) => name),
        thinking: readThinkingCapabilities(model, 'reasoning_effort') || (() => {
          const levels = getModelThinkingOptions('mistral', String(model.id || '')).map(option => option.id);
          return levels.length > 0
            ? { levels, defaultLevel: levels.includes('medium') ? 'medium' as const : levels[0], parameter: 'reasoning_effort' as const, source: 'inferred' as const }
            : undefined;
        })(),
      }));
    return resultWithExcluded('mistral', mappedModels);
  } catch (error) {
    return providerError('mistral', error);
  }
}

async function fetchAnthropicModels(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKeyValues('anthropic')[0];
  if (!apiKey) return { provider: 'anthropic', connected: false, source: 'unavailable', models: [], error: 'Missing Anthropic API key' };

  try {
    const baseUrl = getProviderBaseURL('anthropic');
    const discoveredModels: any[] = [];
    let afterId = '';
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ limit: '100' });
      if (afterId) query.set('after_id', afterId);
      const res = await requestJson(`${baseUrl.replace(/\/+$/, '')}/v1/models?${query.toString()}`, {
        cache: 'no-store',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      }, MODEL_FETCH_TIMEOUT_MS);
      if (!res.ok) throw new Error(`Anthropic models request failed (${res.status})`);
      const data = await res.json();
      const pageModels = Array.isArray(data?.data) ? data.data : [];
      discoveredModels.push(...pageModels);
      if (!data?.has_more || !data?.last_id || pageModels.length === 0) break;
      if (afterId === String(data.last_id) || page === 19) throw new Error('Provider returned an incomplete model catalog. Please retry.');
      afterId = String(data.last_id);
    }
    const mappedModels = discoveredModels.map((model: any) => {
      const capabilities = model.capabilities && typeof model.capabilities === 'object'
        ? Object.entries(model.capabilities)
          .filter(([, value]) => Boolean((value as any)?.supported ?? value))
          .map(([key]) => key)
        : undefined;
      return {
        ...readModelAvailability(model),
        id: String(model.id || ''),
        name: model.display_name || model.id,
        description: [
          model.type ? `Type: ${ model.type }` : undefined,
          model.created_at ? `Created ${ model.created_at }` : undefined,
          model.max_input_tokens ? `Input ${ model.max_input_tokens }` : undefined,
          model.max_tokens ? `Output ${ model.max_tokens }` : undefined,
        ].filter(Boolean).join(' | ') || undefined,
        contextLength: Number(model.max_input_tokens) || undefined,
        inputTokenLimit: Number(model.max_input_tokens) || undefined,
        outputTokenLimit: Number(model.max_tokens) || undefined,
        capabilities,
        thinking: readThinkingCapabilities(
          model,
          isAnthropicAdaptiveThinkingModel(String(model.id || '')) ? 'output_config.effort' : undefined,
        ) || (() => {
          const levels = getModelThinkingOptions('anthropic', String(model.id || '')).map(option => option.id);
          return levels.length > 0
            ? {
              levels,
              defaultLevel: levels.includes('medium') ? 'medium' : levels[0],
              ...(isAnthropicAdaptiveThinkingModel(String(model.id || ''))
                ? { parameter: 'output_config.effort' as const }
                : {}),
              source: 'inferred' as const,
            }
            : undefined;
        })(),
      };
    });
    return resultWithExcluded('anthropic', mappedModels);
  } catch (error) {
    return providerError('anthropic', error);
  }
}


async function fetchDeepSeekModels(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKeyValues('deepseek' as any)[0];
  if (!apiKey) return { provider: 'deepseek' as any, connected: false, source: 'unavailable', models: [], error: 'Missing DeepSeek API key' };
  try {
    const res = await requestJson(`${getProviderBaseURL('deepseek').replace(/\/+$/, '')}/models`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
    }, MODEL_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`DeepSeek models request failed (${res.status})`);
    const data = await res.json();
    const models = trimModels((data.data || []).map((model: any) => ({
      ...readModelAvailability(model),
      id: String(model.id || ''),
      name: String(model.id || ''),
      description: model.owned_by ? `Owned by ${model.owned_by}` : undefined,
    })));
    return resultWithExcluded('deepseek' as any, models);
  } catch (error) {
    return providerError('deepseek' as any, error);
  }
}

async function fetchGrokModels(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKeyValues('grok' as any)[0];
  if (!apiKey) return { provider: 'grok' as any, connected: false, source: 'unavailable', models: [], error: 'Missing xAI Grok API key' };
  try {
    const res = await requestJson(`${getProviderBaseURL('grok').replace(/\/+$/, '')}/models`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
    }, MODEL_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Grok models request failed (${res.status})`);
    const data = await res.json();
    const models = trimModels((data.data || []).map((model: any) => ({
      ...readModelAvailability(model),
      id: String(model.id || ''),
      name: String(model.id || ''),
      description: 'xAI Grok Model',
    })));
    return resultWithExcluded('grok' as any, models);
  } catch (error) {
    return providerError('grok' as any, error);
  }
}

async function fetchCerebrasModels(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKeyValues('cerebras' as any)[0];
  if (!apiKey) return { provider: 'cerebras' as any, connected: false, source: 'unavailable', models: [], error: 'Missing Cerebras API key' };
  try {
    const res = await requestJson(`${getProviderBaseURL('cerebras').replace(/\/+$/, '')}/models`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
    }, MODEL_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Cerebras models request failed (${res.status})`);
    const data = await res.json();
    const models = trimModels((data.data || []).map((model: any) => ({
      ...readModelAvailability(model),
      id: String(model.id || ''),
      name: String(model.id || ''),
      description: 'Cerebras Wafer Engine Model',
    })));
    return resultWithExcluded('cerebras' as any, models);
  } catch (error) {
    return providerError('cerebras' as any, error);
  }
}

async function fetchTogetherModels(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKeyValues('together' as any)[0];
  if (!apiKey) return { provider: 'together' as any, connected: false, source: 'unavailable', models: [], error: 'Missing Together API key' };
  try {
    const res = await requestJson(`${getProviderBaseURL('together').replace(/\/+$/, '')}/models`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
    }, MODEL_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Together models request failed (${res.status})`);
    const data = await res.json();
    const raw = Array.isArray(data) ? data : data.data || [];
    const models = trimModels(raw.map((model: any) => ({
      ...readModelAvailability(model),
      id: String(model.id || model.name || ''),
      name: model.display_name || model.id || model.name,
      description: model.description || 'Together AI Model',
      contextLength: model.context_length,
    })));
    return resultWithExcluded('together' as any, models);
  } catch (error) {
    return providerError('together' as any, error);
  }
}

async function fetchElevenLabsVoices(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKeyValues('elevenlabs' as any)[0];
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers['xi-api-key'] = apiKey;
    const res = await requestJson('https://api.elevenlabs.io/v1/voices', {
      cache: 'no-store',
      headers,
    }, MODEL_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`ElevenLabs voices request failed (${res.status})`);
    const data = await res.json();
    const raw = data.voices || [];
    const models = trimModels(raw.map((voice: any) => ({
      id: String(voice.voice_id || voice.name || ''),
      name: `${voice.name} (${voice.category || 'voice'})`,
      description: voice.description || `ElevenLabs ${voice.category || 'voice'}`,
    })));
    return resultWithExcluded('elevenlabs' as any, models);
  } catch (error) {
    return providerError('elevenlabs' as any, error);
  }
}

async function fetchOllamaModels(): Promise<ProviderModelResult> {
  try {
    const baseURL = getProviderBaseURL('ollama') || 'http://127.0.0.1:11434/v1';
    const apiKey = getRuntimeApiKeyValues('ollama' as any)[0] || 'ollama';
    let res = await requestJson(`${baseURL}/models`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
    }, 30_000);

    // Older Ollama releases may expose the native catalog before they expose
    // the OpenAI-compatible `/v1/models` route. Keep that route as a fallback
    // so existing local installs remain discoverable without changing chat,
    // which always uses the documented `/v1` OpenAI-compatible API.
    if (!res.ok) {
      const host = baseURL.replace(/\/v1\/?$/i, '').replace(/\/+$/, '');
      res = await requestJson(`${host}/api/tags`, { cache: 'no-store' }, 30_000);
    }
    if (!res.ok) throw new Error(`Ollama local request failed (${res.status})`);
    const data = await res.json();
    const rawModels = Array.isArray(data?.data) ? data.data : (data?.models || []);
    const models = trimModels(rawModels.map((model: any) => ({
      ...readModelAvailability(model),
      id: String(model.id || model.name || model.model || ''),
      name: String(model.name || model.model || model.id || ''),
      description: model.details?.parameter_size ? `Local (${model.details.parameter_size})` : 'Local Ollama Model',
      contextLength: Number(model.context_length || model.details?.context_length || 0) || undefined,
    })));
    return resultWithExcluded('ollama' as any, models);
  } catch (error) {
    return providerError('ollama' as any, error);
  }
}

async function fetchLMStudioModels(): Promise<ProviderModelResult> {
  try {
    const baseURL = getProviderBaseURL('lmstudio') || 'http://127.0.0.1:1234/v1';
    const apiKey = getRuntimeApiKeyValues('lmstudio' as any)[0];
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
    let res = await requestJson(`${baseURL}/models`, {
      cache: 'no-store',
      headers,
    }, 30_000);
    // LM Studio also exposes a native catalog at `/api/v1/models`. Prefer the
    // OpenAI-compatible path for consistency with chat, then support the
    // native path for installations where only the v1 REST server is enabled.
    if (!res.ok) {
      const host = baseURL.replace(/\/v1\/?$/i, '').replace(/\/+$/, '');
      res = await requestJson(`${host}/api/v1/models`, { cache: 'no-store', headers }, 30_000);
    }
    if (!res.ok) throw new Error(`LM Studio local request failed (${res.status})`);
    const data = await res.json();
    const rawModels = Array.isArray(data?.data) ? data.data : (data?.models || []);
    const models = trimModels(rawModels.map((model: any) => ({
      ...readModelAvailability(model),
      id: String(model.id || model.key || model.model_id || ''),
      name: String(model.id || model.key || model.model_id || ''),
      description: 'LM Studio Desktop Local Server',
    })));
    return resultWithExcluded('lmstudio' as any, models);
  } catch (error) {
    return providerError('lmstudio' as any, error);
  }
}

async function fetchCompatibleModels(provider: MainAgentProvider): Promise<ProviderModelResult> {
  const runtimeProvider = provider as RuntimeApiKeyProvider;
  const apiKey = getRuntimeApiKeyValues(runtimeProvider)[0];
  if (!apiKey && !isLocalModelProvider(provider)) {
    return {
      provider: runtimeProvider,
      connected: false,
      source: 'unavailable',
      models: [],
      error: `Missing ${provider} API key`,
    };
  }

  const baseURL = getProviderBaseURL(provider);
  if (!baseURL) {
    return {
      provider: runtimeProvider,
      connected: false,
      source: 'unavailable',
      models: [],
      error: `${provider} requires a configured base URL`,
    };
  }

  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await requestJson(`${baseURL.replace(/\/+$/, '')}/models`, {
      cache: 'no-store',
      headers,
    }, isLocalModelProvider(provider) ? 30_000 : MODEL_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`${provider} models request failed (${res.status})`);
    const payload = await res.json();
    const raw = Array.isArray(payload) ? payload : payload?.data || payload?.models || [];
    const thinkingParameter: ModelThinkingCapabilities['parameter'] = provider === 'qwen'
      ? 'enable_thinking'
      : provider === 'perplexity'
        ? 'reasoning'
        : 'reasoning_effort';
    return resultWithExcluded(runtimeProvider, raw.map((model: any) => {
      const supportedParameters = Array.isArray(model?.supported_parameters)
        ? model.supported_parameters.map((value: unknown) => String(value || '').trim()).filter(Boolean)
        : null;
      const reportedCapabilities = Array.isArray(model?.capabilities)
        ? model.capabilities
        : model?.capabilities && typeof model.capabilities === 'object'
          ? Object.entries(model.capabilities).filter(([, enabled]) => enabled === true).map(([name]) => name)
          : [];
      const capabilities = [
        ...reportedCapabilities,
        ...(supportedParameters || []),
        ...(supportedParameters && !supportedParameters.some((value: string) => /^(?:tools?|tool_choice|function_call(?:ing)?)$/i.test(value))
          ? ['tool-calling:false']
          : []),
      ];
      return {
      lifecycle: model?.active === false || model?.enabled === false ? 'disabled' : model?.lifecycle || model?.status,
      deprecationDate: model?.expiration_date || model?.deprecationDate,
      ...readModelAvailability(model),
      id: String(model?.id || model?.name || model?.model || ''),
      name: String(model?.display_name || model?.name || model?.id || model?.model || ''),
      description: model?.description || model?.owned_by || undefined,
      contextLength: Number(model?.context_length || model?.max_context_length || model?.max_model_len || 0) || undefined,
      createdAt: Number(model?.created || model?.created_at || 0) || undefined,
      capabilities: capabilities.length > 0 ? capabilities : undefined,
      // Generic catalogs are not allowed to invent reasoning_effort support.
      // Only provider-returned capability metadata is promoted into the UI.
      thinking: readAdvertisedThinkingCapabilities(model, provider, thinkingParameter) || undefined,
      };
    }));
  } catch (error) {
    return providerError(runtimeProvider, error);
  }
}


export async function POST(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  hydrateServerRuntimeSettings();
  const body = await req.json().catch(() => ({}));
  const keys: Record<string, string[]> = body?.replaceRuntimeKeys === true ? {} : Object.fromEntries(
    Object.keys(getRuntimeApiKeyStatus()).map(provider => [provider, savedApiKeyValues(provider as RuntimeApiKeyProvider)]),
  );
  for (const [provider, value] of Object.entries(body?.apiKeys && typeof body.apiKeys === 'object' ? body.apiKeys : {})) {
    keys[provider] = (Array.isArray(value) ? value : [value]).flatMap(item => String(item || '').split(/[\n,;]+/))
      .map(key => key.trim()).filter(Boolean);
  }
  const baseURLs = body?.baseURLs && typeof body.baseURLs === 'object'
    ? { ...getRuntimeProviderBaseURLs(), ...Object.fromEntries(Object.entries(body.baseURLs).filter(([provider]) => isModelProvider(provider))
      .map(([provider, value]) => [provider, normalizeProviderBaseURL(provider as MainAgentProvider, value)])) }
    : getRuntimeProviderBaseURLs();

  return discoveryScope.run({ keys, baseURLs, deadlineAt: Date.now() + 35_000 }, async () => {
  const requested = Array.isArray(body?.providers) && body.providers.length > 0
    ? new Set(body.providers.map((provider: unknown) => String(provider)))
    : null;

  const jobs: Array<Promise<ProviderModelResult>> = [];
  const discover = async (provider: RuntimeApiKeyProvider, fetchModels: () => Promise<ProviderModelResult>) => {
    const scope = discoveryScope.getStore()!;
    const pool = Array.from(new Set(scope.keys[provider] || []));
    let result = await fetchModels();
    for (const key of pool.slice(1, 3)) {
      if (result.connected || !/\b(?:401|403)\b/.test(result.error || '')) break;
      result = await discoveryScope.run({ ...scope, keys: { ...scope.keys, [provider]: [key] } }, fetchModels);
    }
    return result;
  };
  if (!requested || requested.has('gemini')) jobs.push(discover('gemini' as RuntimeApiKeyProvider, fetchGeminiModels));
  if (!requested || requested.has('mistral')) jobs.push(discover('mistral' as RuntimeApiKeyProvider, fetchMistralModels));
  if (!requested || requested.has('openai')) jobs.push(discover('openai' as RuntimeApiKeyProvider, fetchOpenAIModels));
  if (!requested || requested.has('openrouter')) jobs.push(discover('openrouter' as RuntimeApiKeyProvider, fetchOpenRouterModels));
  if (!requested || requested.has('groq')) jobs.push(discover('groq' as RuntimeApiKeyProvider, fetchGroqModels));
  if (!requested || requested.has('anthropic')) jobs.push(discover('anthropic' as RuntimeApiKeyProvider, fetchAnthropicModels));
  if (!requested || requested.has('deepseek')) jobs.push(discover('deepseek' as RuntimeApiKeyProvider, fetchDeepSeekModels));
  if (!requested || requested.has('grok')) jobs.push(discover('grok' as RuntimeApiKeyProvider, fetchGrokModels));
  if (!requested || requested.has('cerebras')) jobs.push(discover('cerebras' as RuntimeApiKeyProvider, fetchCerebrasModels));
  if (!requested || requested.has('together')) jobs.push(discover('together' as RuntimeApiKeyProvider, fetchTogetherModels));
  if (!requested || requested.has('elevenlabs')) jobs.push(fetchElevenLabsVoices());
  if (!requested || requested.has('ollama')) jobs.push(discover('ollama' as RuntimeApiKeyProvider, fetchOllamaModels));
  if (!requested || requested.has('lmstudio')) jobs.push(discover('lmstudio' as RuntimeApiKeyProvider, fetchLMStudioModels));
  if (!requested || requested.has('fireworks')) jobs.push(discover('fireworks' as RuntimeApiKeyProvider, () => fetchCompatibleModels('fireworks')));
  if (!requested || requested.has('sambanova')) jobs.push(discover('sambanova' as RuntimeApiKeyProvider, () => fetchCompatibleModels('sambanova')));
  if (!requested || requested.has('perplexity')) jobs.push(discover('perplexity' as RuntimeApiKeyProvider, () => fetchCompatibleModels('perplexity')));
  if (!requested || requested.has('deepinfra')) jobs.push(discover('deepinfra' as RuntimeApiKeyProvider, () => fetchCompatibleModels('deepinfra')));
  if (!requested || requested.has('huggingface')) jobs.push(discover('huggingface' as RuntimeApiKeyProvider, () => fetchCompatibleModels('huggingface')));
  if (!requested || requested.has('nvidia')) jobs.push(discover('nvidia' as RuntimeApiKeyProvider, () => fetchCompatibleModels('nvidia')));
  if (!requested || requested.has('cloudflare')) jobs.push(discover('cloudflare' as RuntimeApiKeyProvider, () => fetchCompatibleModels('cloudflare')));
  if (!requested || requested.has('vllm')) jobs.push(discover('vllm' as RuntimeApiKeyProvider, () => fetchCompatibleModels('vllm')));
  if (!requested || requested.has('llamacpp')) jobs.push(discover('llamacpp' as RuntimeApiKeyProvider, () => fetchCompatibleModels('llamacpp')));
  if (!requested || requested.has('novita')) jobs.push(discover('novita' as RuntimeApiKeyProvider, () => fetchCompatibleModels('novita')));
  if (!requested || requested.has('qwen')) jobs.push(discover('qwen' as RuntimeApiKeyProvider, () => fetchCompatibleModels('qwen')));
  if (!requested || requested.has('mimo')) jobs.push(discover('mimo' as RuntimeApiKeyProvider, () => fetchCompatibleModels('mimo')));
  if (!requested || requested.has('tokenhub')) jobs.push(discover('tokenhub' as RuntimeApiKeyProvider, () => fetchCompatibleModels('tokenhub')));
  if (!requested || requested.has('zai')) jobs.push(discover('zai' as RuntimeApiKeyProvider, () => fetchCompatibleModels('zai')));
  if (!requested || requested.has('kimi')) jobs.push(discover('kimi' as RuntimeApiKeyProvider, () => fetchCompatibleModels('kimi')));
  if (!requested || requested.has('stepfun')) jobs.push(discover('stepfun' as RuntimeApiKeyProvider, () => fetchCompatibleModels('stepfun')));
  if (!requested || requested.has('minimax')) jobs.push(discover('minimax' as RuntimeApiKeyProvider, () => fetchCompatibleModels('minimax')));
  if (!requested || requested.has('ollamacloud')) jobs.push(discover('ollamacloud' as RuntimeApiKeyProvider, () => fetchCompatibleModels('ollamacloud')));
  if (!requested || requested.has('arcee')) jobs.push(discover('arcee' as RuntimeApiKeyProvider, () => fetchCompatibleModels('arcee')));
  if (!requested || requested.has('gmi')) jobs.push(discover('gmi' as RuntimeApiKeyProvider, () => fetchCompatibleModels('gmi')));
  if (!requested || requested.has('kilo')) jobs.push(discover('kilo' as RuntimeApiKeyProvider, () => fetchCompatibleModels('kilo')));
  if (!requested || requested.has('opencode')) jobs.push(discover('opencode' as RuntimeApiKeyProvider, () => fetchCompatibleModels('opencode')));
  if (!requested || requested.has('upstage')) jobs.push(discover('upstage' as RuntimeApiKeyProvider, () => fetchCompatibleModels('upstage')));
  if (!requested || requested.has('custom')) jobs.push(discover('custom' as RuntimeApiKeyProvider, () => fetchCompatibleModels('custom')));

  const results = await Promise.all(jobs);
  return NextResponse.json({
    ok: true,
    updatedAt: Date.now(),
    providers: results.reduce<Record<string, ProviderModelResult>>((acc, result) => {
      acc[result.provider] = result;
      return acc;
    }, {}),
  });
  });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  return POST(new NextRequest(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify({ providers: url.searchParams.get('providers')?.split(',').map(value => value.trim()).filter(Boolean) }),
  }));
}
