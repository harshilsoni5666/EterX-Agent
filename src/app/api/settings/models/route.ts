import { NextRequest, NextResponse } from 'next/server';
import {
  applyRuntimeApiKeys,
  applyRuntimeModelOverrides,
  getRuntimeApiKey,
  getRuntimeApiKeyStatus,
  getRuntimeApiKeyValues,
  type RuntimeApiKeyProvider,
} from '../../../../lib/agent/runtime-api-keys';
import {
  getModelThinkingOptions,
  normalizeModelThinkingCapabilities,
  type MainAgentProvider,
  type ModelThinkingCapabilities,
} from '../../../../lib/agent/model-routing';
import { getProviderBaseURL, isLocalModelProvider } from '../../../../lib/agent/provider-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

const withTimeout = async <T,>(promise: Promise<T>, ms = MODEL_FETCH_TIMEOUT_MS): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ ms }ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const NON_AGENT_MODEL_ID = /(?:^|[/:._-])(?:audio|embed(?:ding)?s?|image|moderation|orpheus|realtime|speech|transcri(?:be|ption)|translate|tts|whisper|guard|rerank|search|video)(?:$|[/:._-])/i;

const isExpired = (value: unknown) => {
  if (!value) return false;
  const timestamp = typeof value === 'number'
    ? (value > 10_000_000_000 ? value : value * 1000)
    : Date.parse(String(value));
  return Number.isFinite(timestamp) && timestamp <= Date.now();
};

const isAgentCompatibleModel = (model: ProviderModel) => {
  const id = String(model.id || '').trim();
  if (!id || NON_AGENT_MODEL_ID.test(id) || isExpired(model.deprecationDate)) return false;
  const lifecycle = String(model.lifecycle || '').toLowerCase();
  return !['deprecated', 'retired', 'disabled', 'expired', 'unavailable'].some(status => lifecycle.includes(status));
};

const trimModels = (models: ProviderModel[]) => {
  const seen = new Set<string>();
  return models.filter(model => {
    if (!isAgentCompatibleModel(model) || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
};

const preferredModelScore = (provider: string, model: ProviderModel) => {
  const id = model.id.toLowerCase();
  let score = Number(model.createdAt || 0) / 1_000_000_000;
  if (/preview|experimental|\bexp\b/.test(id)) score -= 20;
  if (provider === 'gemini') {
    if (id === 'gemini-3.6-flash') score += 1000;
    else if (id.startsWith('gemini-3.5-flash')) score += 900;
    else if (id.startsWith('gemini-3.1-pro')) score += 850;
    else if (id.startsWith('gemini-3')) score += 800;
    else if (id.startsWith('gemini-2.5')) score += 600;
  } else if (provider === 'openai') {
    if (id === 'gpt-5.6' || id === 'gpt-5.6-sol') score += 1000;
    else if (id.includes('gpt-5.6-terra')) score += 900;
    else if (id.includes('gpt-5.6-luna')) score += 850;
    else if (id.startsWith('gpt-5')) score += 700;
  } else if (provider === 'openrouter') {
    if (id === 'openrouter/auto') score += 1200;
    else if (id === 'openai/gpt-oss-120b') score += 1000;
    else if (id === 'openai/gpt-oss-20b') score += 900;
  } else if (provider === 'groq') {
    if (id === 'openai/gpt-oss-120b') score += 1000;
    else if (id === 'openai/gpt-oss-20b') score += 900;
    else if (id === 'qwen/qwen3.6-27b') score += 800;
  } else if (provider === 'anthropic') {
    if (id.includes('claude-sonnet-5')) score += 1000;
    else if (id.includes('claude-opus-5')) score += 950;
    else if (id.includes('claude-fable-5')) score += 900;
  } else if (provider === 'mistral') {
    if (id.includes('mistral-medium-3-5')) score += 1000;
    else if (id.includes('mistral-large')) score += 900;
    else if (id.includes('mistral-small')) score += 800;
  }
  return score;
};

const resultWithExcluded = (
  provider: RuntimeApiKeyProvider,
  rawModels: ProviderModel[],
): ProviderModelResult => {
  const models = trimModels(rawModels)
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
    for (let page = 0; page < 20; page++) {
      const token = pageToken ? `&pageToken=${ encodeURIComponent(pageToken) }` : '';
      const res = await withTimeout(fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${ encodeURIComponent(apiKey) }&pageSize=1000${ token }`, {
        cache: 'no-store',
      }));
      if (!res.ok) throw new Error(`Gemini models request failed (${ res.status })`);
      const data = await res.json();
      rawModels.push(...(Array.isArray(data.models) ? data.models : []));
      pageToken = String(data.nextPageToken || '');
      if (!pageToken) break;
    }

    const mappedModels = rawModels
      .filter((model: any) => Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent'))
      .map((model: any) => ({
        id: String(model.baseModelId || model.name || '').replace(/^models\//, ''),
        name: model.displayName || String(model.name || '').replace(/^models\//, ''),
        description: model.description,
        baseModelId: model.baseModelId,
        version: model.version,
        lifecycle: model.lifecycle,
        deprecationDate: model.deprecationDate,
        inputTokenLimit: model.inputTokenLimit,
        outputTokenLimit: model.outputTokenLimit,
        capabilities: [
          ...(model.supportedGenerationMethods || []),
          model.inputTokenLimit ? 'text-input' : undefined,
          model.thinking ? 'thinking' : undefined,
        ].filter(Boolean),
        thinking: readThinkingCapabilities(model, 'thinkingLevel') || (model.thinking
          ? {
            levels: getModelThinkingOptions('gemini', String(model.baseModelId || model.name || '')).map(option => option.id),
            defaultLevel: 'medium' as const,
            parameter: 'thinkingLevel' as const,
            source: 'provider' as const,
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
    const baseUrl = process.env.OPENAI_BASE_URL
      ? process.env.OPENAI_BASE_URL.replace(/\/+$/, '')
      : 'https://api.openai.com/v1';
    const res = await withTimeout(fetch(`${baseUrl}/models`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${ apiKey }` },
    }));
    if (!res.ok) throw new Error(`OpenAI models request failed (${ res.status })`);
    const data = await res.json();
    const mappedModels = (data.data || [])
      .filter((model: any) => /^(?:ft:)?(?:gpt-|o[1-9](?:-|$)|chatgpt-)/i.test(String(model.id || '')))
      .map((model: any) => ({
        id: String(model.id || ''),
        name: String(model.id || ''),
        description: model.owned_by ? `Owned by ${ model.owned_by }` : undefined,
        createdAt: Number(model.created) || undefined,
        thinking: readThinkingCapabilities(model, 'reasoning_effort') || (() => {
          const levels = getModelThinkingOptions('openai', String(model.id || '')).map(option => option.id);
          return levels.length > 0
            ? { levels, defaultLevel: levels.includes('medium') ? 'medium' as const : levels[0], parameter: 'reasoning_effort' as const, source: 'provider' as const }
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

  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${ apiKey }`;
    const baseUrl = process.env.OPENROUTER_BASE_URL
      ? process.env.OPENROUTER_BASE_URL.replace(/\/+$/, '')
      : 'https://openrouter.ai/api/v1';
    const res = await withTimeout(fetch(`${baseUrl}/models?output_modalities=all`, {
      cache: 'no-store',
      headers,
    }));
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
            ? { levels: genericReasoning, defaultLevel: genericReasoning.includes('medium') ? 'medium' : genericReasoning[0], parameter: 'reasoning', source: 'provider' }
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
    const baseUrl = process.env.GROQ_BASE_URL
      ? process.env.GROQ_BASE_URL.replace(/\/+$/, '')
      : 'https://api.groq.com/openai/v1';
    const res = await withTimeout(fetch(`${baseUrl}/models`, {
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${ apiKey }`,
        'Content-Type': 'application/json',
      },
    }));
    if (!res.ok) throw new Error(`Groq models request failed (${ res.status })`);
    const data = await res.json();
    const mappedModels = (data.data || [])
      .map((model: any) => ({
        id: String(model.id || ''),
        name: String(model.id || ''),
        description: model.owned_by ? `Owned by ${ model.owned_by }` : undefined,
        contextLength: model.context_window,
        thinking: readThinkingCapabilities(model, 'reasoning_effort') || (/gpt-oss/i.test(String(model.id || ''))
          ? {
            levels: ['low', 'medium', 'high'],
            defaultLevel: 'medium',
            parameter: 'reasoning_effort',
            source: 'provider',
          } as ModelThinkingCapabilities
          : undefined),
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
    const baseUrl = (process.env.MISTRAL_BASE_URL || process.env.MISTRAL_API_BASE_URL)
      ? (process.env.MISTRAL_BASE_URL || process.env.MISTRAL_API_BASE_URL)!.replace(/\/+$/, '')
      : 'https://api.mistral.ai/v1';
    const res = await withTimeout(fetch(`${baseUrl}/models`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${ apiKey }` },
    }));
    if (!res.ok) throw new Error(`Mistral models request failed (${ res.status })`);
    const data = await res.json();
    const mappedModels = (data.data || [])
      .filter((model: any) => {
        const capabilities = model.capabilities || {};
        return capabilities.completion_chat !== false && capabilities.function_calling !== false;
      })
      .map((model: any) => ({
      id: String(model.id || ''),
      name: model.name || model.id,
      description: model.description,
        capabilities: Object.entries(model.capabilities || {})
          .filter(([, enabled]) => Boolean(enabled))
          .map(([name]) => name),
        thinking: readThinkingCapabilities(model, 'reasoning_effort') || (() => {
          const levels = getModelThinkingOptions('mistral', String(model.id || '')).map(option => option.id);
          return levels.length > 0
            ? { levels, defaultLevel: levels.includes('high') ? 'high' as const : levels[0], parameter: 'reasoning_effort' as const, source: 'provider' as const }
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
    const baseUrl = process.env.ANTHROPIC_BASE_URL
      ? process.env.ANTHROPIC_BASE_URL.replace(/\/+$/, '')
      : 'https://api.anthropic.com';
    const res = await withTimeout(fetch(`${baseUrl}/v1/models`, {
      cache: 'no-store',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    }));
    if (!res.ok) throw new Error(`Anthropic models request failed (${ res.status })`);
    const data = await res.json();
    const mappedModels = (data.data || []).map((model: any) => {
      const capabilities = model.capabilities && typeof model.capabilities === 'object'
        ? Object.entries(model.capabilities)
          .filter(([, value]) => Boolean((value as any)?.supported ?? value))
          .map(([key]) => key)
        : undefined;
      return {
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
        thinking: readThinkingCapabilities(model, 'output_config.effort') || (() => {
          const levels = getModelThinkingOptions('anthropic', String(model.id || '')).map(option => option.id);
          return levels.length > 0
            ? { levels, defaultLevel: levels.includes('high') ? 'high' : levels[0], parameter: 'output_config.effort', source: 'provider' as const }
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
    const res = await withTimeout(fetch('https://api.deepseek.com/v1/models', {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
    }));
    if (!res.ok) throw new Error(`DeepSeek models request failed (${res.status})`);
    const data = await res.json();
    const models = trimModels((data.data || []).map((model: any) => ({
      id: String(model.id || ''),
      name: String(model.id || ''),
      description: model.owned_by ? `Owned by ${model.owned_by}` : undefined,
    })));
    return { provider: 'deepseek' as any, connected: true, source: 'live', models };
  } catch (error) {
    return providerError('deepseek' as any, error);
  }
}

async function fetchGrokModels(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKeyValues('grok' as any)[0];
  if (!apiKey) return { provider: 'grok' as any, connected: false, source: 'unavailable', models: [], error: 'Missing xAI Grok API key' };
  try {
    const res = await withTimeout(fetch('https://api.x.ai/v1/models', {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
    }));
    if (!res.ok) throw new Error(`Grok models request failed (${res.status})`);
    const data = await res.json();
    const models = trimModels((data.data || []).map((model: any) => ({
      id: String(model.id || ''),
      name: String(model.id || ''),
      description: 'xAI Grok Model',
    })));
    return { provider: 'grok' as any, connected: true, source: 'live', models };
  } catch (error) {
    return providerError('grok' as any, error);
  }
}

async function fetchCerebrasModels(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKeyValues('cerebras' as any)[0];
  if (!apiKey) return { provider: 'cerebras' as any, connected: false, source: 'unavailable', models: [], error: 'Missing Cerebras API key' };
  try {
    const res = await withTimeout(fetch('https://api.cerebras.ai/v1/models', {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
    }));
    if (!res.ok) throw new Error(`Cerebras models request failed (${res.status})`);
    const data = await res.json();
    const models = trimModels((data.data || []).map((model: any) => ({
      id: String(model.id || ''),
      name: String(model.id || ''),
      description: 'Cerebras Wafer Engine Model',
    })));
    return { provider: 'cerebras' as any, connected: true, source: 'live', models };
  } catch (error) {
    return providerError('cerebras' as any, error);
  }
}

async function fetchTogetherModels(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKeyValues('together' as any)[0];
  if (!apiKey) return { provider: 'together' as any, connected: false, source: 'unavailable', models: [], error: 'Missing Together API key' };
  try {
    const res = await withTimeout(fetch('https://api.together.xyz/v1/models', {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
    }));
    if (!res.ok) throw new Error(`Together models request failed (${res.status})`);
    const data = await res.json();
    const raw = Array.isArray(data) ? data : data.data || [];
    const models = trimModels(raw.map((model: any) => ({
      id: String(model.id || model.name || ''),
      name: model.display_name || model.id || model.name,
      description: model.description || 'Together AI Model',
      contextLength: model.context_length,
    })));
    return { provider: 'together' as any, connected: true, source: 'live', models };
  } catch (error) {
    return providerError('together' as any, error);
  }
}

async function fetchElevenLabsVoices(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKeyValues('elevenlabs' as any)[0];
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers['xi-api-key'] = apiKey;
    const res = await withTimeout(fetch('https://api.elevenlabs.io/v1/voices', {
      cache: 'no-store',
      headers,
    }));
    if (!res.ok) throw new Error(`ElevenLabs voices request failed (${res.status})`);
    const data = await res.json();
    const raw = data.voices || [];
    const models = trimModels(raw.map((voice: any) => ({
      id: String(voice.voice_id || voice.name || ''),
      name: `${voice.name} (${voice.category || 'voice'})`,
      description: voice.description || `ElevenLabs ${voice.category || 'voice'}`,
    })));
    return { provider: 'elevenlabs' as any, connected: true, source: 'live', models };
  } catch (error) {
    return providerError('elevenlabs' as any, error);
  }
}

async function fetchOllamaModels(): Promise<ProviderModelResult> {
  try {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const res = await withTimeout(fetch(`${host.replace(/\/+$/, '')}/api/tags`, {
      cache: 'no-store',
    }), 4000);
    if (!res.ok) throw new Error(`Ollama local request failed (${res.status})`);
    const data = await res.json();
    const models = trimModels((data.models || []).map((model: any) => ({
      id: String(model.name || model.model || ''),
      name: String(model.name || model.model || ''),
      description: model.details?.parameter_size ? `Local (${model.details.parameter_size})` : 'Local Ollama Model',
    })));
    return { provider: 'ollama' as any, connected: true, source: 'live', models };
  } catch (error) {
    return providerError('ollama' as any, error);
  }
}

async function fetchLMStudioModels(): Promise<ProviderModelResult> {
  try {
    const host = process.env.LMSTUDIO_HOST || 'http://localhost:1234';
    const res = await withTimeout(fetch(`${host.replace(/\/+$/, '')}/v1/models`, {
      cache: 'no-store',
    }), 4000);
    if (!res.ok) throw new Error(`LM Studio local request failed (${res.status})`);
    const data = await res.json();
    const models = trimModels((data.data || []).map((model: any) => ({
      id: String(model.id || ''),
      name: String(model.id || ''),
      description: 'LM Studio Desktop Local Server',
    })));
    return { provider: 'lmstudio' as any, connected: true, source: 'live', models };
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
    const res = await withTimeout(fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
      cache: 'no-store',
      headers,
    }), isLocalModelProvider(provider) ? 4_000 : MODEL_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`${provider} models request failed (${res.status})`);
    const payload = await res.json();
    const raw = Array.isArray(payload) ? payload : payload?.data || payload?.models || [];
    return resultWithExcluded(runtimeProvider, raw.map((model: any) => ({
      id: String(model?.id || model?.name || model?.model || ''),
      name: String(model?.display_name || model?.name || model?.id || model?.model || ''),
      description: model?.description || model?.owned_by || undefined,
      contextLength: Number(model?.context_length || model?.max_context_length || model?.max_model_len || 0) || undefined,
      createdAt: Number(model?.created || model?.created_at || 0) || undefined,
      capabilities: Array.isArray(model?.capabilities)
        ? model.capabilities
        : model?.capabilities && typeof model.capabilities === 'object'
          ? Object.entries(model.capabilities).filter(([, enabled]) => enabled === true).map(([name]) => name)
          : undefined,
      thinking: readThinkingCapabilities(model, 'reasoning_effort')
        || (getModelThinkingOptions(provider, String(model?.id || model?.name || '')).length
          ? {
              levels: getModelThinkingOptions(provider, String(model?.id || model?.name || '')).map(option => option.id),
              defaultLevel: 'medium',
              parameter: 'reasoning_effort',
              source: 'provider',
            } as ModelThinkingCapabilities
          : undefined),
    })));
  } catch (error) {
    return providerError(runtimeProvider, error);
  }
}


export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'apiKeys')) {
    const mergedKeys = Object.keys(getRuntimeApiKeyStatus()).reduce<Record<string, string[]>>((acc, provider) => {
      acc[provider] = getRuntimeApiKeyValues(provider as RuntimeApiKeyProvider);
      return acc;
    }, {});
    Object.entries(body.apiKeys && typeof body.apiKeys === 'object' ? body.apiKeys : {}).forEach(([provider, value]) => {
      mergedKeys[provider] = Array.isArray(value) ? value.map(String) : [String(value || '')];
    });
    applyRuntimeApiKeys(mergedKeys);
  }
  if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'modelOverrides')) {
    applyRuntimeModelOverrides(body.modelOverrides);
  }

  const requested = Array.isArray(body?.providers) && body.providers.length > 0
    ? new Set(body.providers.map((provider: unknown) => String(provider)))
    : null;

  const jobs: Array<Promise<ProviderModelResult>> = [];
  if (!requested || requested.has('gemini')) jobs.push(fetchGeminiModels());
  if (!requested || requested.has('mistral')) jobs.push(fetchMistralModels());
  if (!requested || requested.has('openai')) jobs.push(fetchOpenAIModels());
  if (!requested || requested.has('openrouter')) jobs.push(fetchOpenRouterModels());
  if (!requested || requested.has('groq')) jobs.push(fetchGroqModels());
  if (!requested || requested.has('anthropic')) jobs.push(fetchAnthropicModels());
  if (!requested || requested.has('deepseek')) jobs.push(fetchDeepSeekModels());
  if (!requested || requested.has('grok')) jobs.push(fetchGrokModels());
  if (!requested || requested.has('cerebras')) jobs.push(fetchCerebrasModels());
  if (!requested || requested.has('together')) jobs.push(fetchTogetherModels());
  if (!requested || requested.has('elevenlabs')) jobs.push(fetchElevenLabsVoices());
  if (!requested || requested.has('ollama')) jobs.push(fetchOllamaModels());
  if (!requested || requested.has('lmstudio')) jobs.push(fetchLMStudioModels());
  if (!requested || requested.has('fireworks')) jobs.push(fetchCompatibleModels('fireworks'));
  if (!requested || requested.has('sambanova')) jobs.push(fetchCompatibleModels('sambanova'));
  if (!requested || requested.has('perplexity')) jobs.push(fetchCompatibleModels('perplexity'));
  if (!requested || requested.has('deepinfra')) jobs.push(fetchCompatibleModels('deepinfra'));
  if (!requested || requested.has('huggingface')) jobs.push(fetchCompatibleModels('huggingface'));
  if (!requested || requested.has('nvidia')) jobs.push(fetchCompatibleModels('nvidia'));
  if (!requested || requested.has('cloudflare')) jobs.push(fetchCompatibleModels('cloudflare'));
  if (!requested || requested.has('vllm')) jobs.push(fetchCompatibleModels('vllm'));
  if (!requested || requested.has('llamacpp')) jobs.push(fetchCompatibleModels('llamacpp'));
  if (!requested || requested.has('novita')) jobs.push(fetchCompatibleModels('novita'));
  if (!requested || requested.has('qwen')) jobs.push(fetchCompatibleModels('qwen'));
  if (!requested || requested.has('mimo')) jobs.push(fetchCompatibleModels('mimo'));
  if (!requested || requested.has('tokenhub')) jobs.push(fetchCompatibleModels('tokenhub'));
  if (!requested || requested.has('zai')) jobs.push(fetchCompatibleModels('zai'));
  if (!requested || requested.has('kimi')) jobs.push(fetchCompatibleModels('kimi'));
  if (!requested || requested.has('stepfun')) jobs.push(fetchCompatibleModels('stepfun'));
  if (!requested || requested.has('minimax')) jobs.push(fetchCompatibleModels('minimax'));
  if (!requested || requested.has('ollamacloud')) jobs.push(fetchCompatibleModels('ollamacloud'));
  if (!requested || requested.has('arcee')) jobs.push(fetchCompatibleModels('arcee'));
  if (!requested || requested.has('gmi')) jobs.push(fetchCompatibleModels('gmi'));
  if (!requested || requested.has('kilo')) jobs.push(fetchCompatibleModels('kilo'));
  if (!requested || requested.has('opencode')) jobs.push(fetchCompatibleModels('opencode'));
  if (!requested || requested.has('upstage')) jobs.push(fetchCompatibleModels('upstage'));
  if (!requested || requested.has('custom')) jobs.push(fetchCompatibleModels('custom'));

  const results = await Promise.all(jobs);
  return NextResponse.json({
    ok: true,
    updatedAt: Date.now(),
    providers: results.reduce<Record<string, ProviderModelResult>>((acc, result) => {
      acc[result.provider] = result;
      return acc;
    }, {}),
  });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const providersParam = url.searchParams.get('providers');
  const requested = providersParam
    ? new Set(providersParam.split(','))
    : null;

  const jobs: Array<Promise<ProviderModelResult>> = [];
  if (!requested || requested.has('gemini')) jobs.push(fetchGeminiModels());
  if (!requested || requested.has('mistral')) jobs.push(fetchMistralModels());
  if (!requested || requested.has('openai')) jobs.push(fetchOpenAIModels());
  if (!requested || requested.has('openrouter')) jobs.push(fetchOpenRouterModels());
  if (!requested || requested.has('groq')) jobs.push(fetchGroqModels());
  if (!requested || requested.has('anthropic')) jobs.push(fetchAnthropicModels());
  if (!requested || requested.has('deepseek')) jobs.push(fetchDeepSeekModels());
  if (!requested || requested.has('grok')) jobs.push(fetchGrokModels());
  if (!requested || requested.has('cerebras')) jobs.push(fetchCerebrasModels());
  if (!requested || requested.has('together')) jobs.push(fetchTogetherModels());
  if (!requested || requested.has('elevenlabs')) jobs.push(fetchElevenLabsVoices());
  if (!requested || requested.has('ollama')) jobs.push(fetchOllamaModels());
  if (!requested || requested.has('lmstudio')) jobs.push(fetchLMStudioModels());
  if (!requested || requested.has('fireworks')) jobs.push(fetchCompatibleModels('fireworks'));
  if (!requested || requested.has('sambanova')) jobs.push(fetchCompatibleModels('sambanova'));
  if (!requested || requested.has('perplexity')) jobs.push(fetchCompatibleModels('perplexity'));
  if (!requested || requested.has('deepinfra')) jobs.push(fetchCompatibleModels('deepinfra'));
  if (!requested || requested.has('huggingface')) jobs.push(fetchCompatibleModels('huggingface'));
  if (!requested || requested.has('nvidia')) jobs.push(fetchCompatibleModels('nvidia'));
  if (!requested || requested.has('cloudflare')) jobs.push(fetchCompatibleModels('cloudflare'));
  if (!requested || requested.has('vllm')) jobs.push(fetchCompatibleModels('vllm'));
  if (!requested || requested.has('llamacpp')) jobs.push(fetchCompatibleModels('llamacpp'));
  if (!requested || requested.has('novita')) jobs.push(fetchCompatibleModels('novita'));
  if (!requested || requested.has('qwen')) jobs.push(fetchCompatibleModels('qwen'));
  if (!requested || requested.has('mimo')) jobs.push(fetchCompatibleModels('mimo'));
  if (!requested || requested.has('tokenhub')) jobs.push(fetchCompatibleModels('tokenhub'));
  if (!requested || requested.has('zai')) jobs.push(fetchCompatibleModels('zai'));
  if (!requested || requested.has('kimi')) jobs.push(fetchCompatibleModels('kimi'));
  if (!requested || requested.has('stepfun')) jobs.push(fetchCompatibleModels('stepfun'));
  if (!requested || requested.has('minimax')) jobs.push(fetchCompatibleModels('minimax'));
  if (!requested || requested.has('ollamacloud')) jobs.push(fetchCompatibleModels('ollamacloud'));
  if (!requested || requested.has('arcee')) jobs.push(fetchCompatibleModels('arcee'));
  if (!requested || requested.has('gmi')) jobs.push(fetchCompatibleModels('gmi'));
  if (!requested || requested.has('kilo')) jobs.push(fetchCompatibleModels('kilo'));
  if (!requested || requested.has('opencode')) jobs.push(fetchCompatibleModels('opencode'));
  if (!requested || requested.has('upstage')) jobs.push(fetchCompatibleModels('upstage'));
  if (!requested || requested.has('custom')) jobs.push(fetchCompatibleModels('custom'));

  const results = await Promise.all(jobs);
  return NextResponse.json({
    ok: true,
    updatedAt: Date.now(),
    providers: results.reduce<Record<string, ProviderModelResult>>((acc, result) => {
      acc[result.provider] = result;
      return acc;
    }, {}),
  });
}

