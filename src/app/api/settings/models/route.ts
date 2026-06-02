import { NextRequest, NextResponse } from 'next/server';
import {
  applyRuntimeApiKeys,
  applyRuntimeModelOverrides,
  getRuntimeApiKey,
  type RuntimeApiKeyProvider,
} from '../../../../lib/agent/runtime-api-keys';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ProviderModel = {
  id: string;
  name: string;
  description?: string;
  contextLength?: number;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  capabilities?: string[];
};

type ProviderModelResult = {
  provider: RuntimeApiKeyProvider;
  connected: boolean;
  source: 'live' | 'unavailable';
  models: ProviderModel[];
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

const trimModels = (models: ProviderModel[]) =>
  models
    .filter(model => model.id);

const providerError = (provider: RuntimeApiKeyProvider, error: unknown): ProviderModelResult => ({
  provider,
  connected: false,
  source: 'unavailable',
  models: [],
  error: error instanceof Error ? error.message : String(error || 'Model discovery failed'),
});

async function fetchGeminiModels(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKey('gemini');
  if (!apiKey) return { provider: 'gemini', connected: false, source: 'unavailable', models: [], error: 'Missing Gemini API key' };

  try {
    const res = await withTimeout(fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${ encodeURIComponent(apiKey) }&pageSize=1000`, {
      cache: 'no-store',
    }));
    if (!res.ok) throw new Error(`Gemini models request failed (${ res.status })`);
    const data = await res.json();
    const models = trimModels((data.models || [])
      .filter((model: any) => Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent'))
      .map((model: any) => ({
        id: String(model.name || '').replace(/^models\//, ''),
        name: model.displayName || String(model.name || '').replace(/^models\//, ''),
        description: model.description,
        inputTokenLimit: model.inputTokenLimit,
        outputTokenLimit: model.outputTokenLimit,
        capabilities: [
          ...(model.supportedGenerationMethods || []),
          model.thinking ? 'thinking' : undefined,
        ].filter(Boolean),
      })));
    return { provider: 'gemini', connected: true, source: 'live', models };
  } catch (error) {
    return providerError('gemini', error);
  }
}

async function fetchOpenAIModels(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKey('openai');
  if (!apiKey) return { provider: 'openai', connected: false, source: 'unavailable', models: [], error: 'Missing OpenAI API key' };

  try {
    const res = await withTimeout(fetch('https://api.openai.com/v1/models', {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${ apiKey }` },
    }));
    if (!res.ok) throw new Error(`OpenAI models request failed (${ res.status })`);
    const data = await res.json();
    const models = trimModels((data.data || [])
      .map((model: any) => ({
        id: String(model.id || ''),
        name: String(model.id || ''),
        description: model.owned_by ? `Owned by ${ model.owned_by }` : undefined,
      }))
      .sort((a: ProviderModel, b: ProviderModel) => a.id.localeCompare(b.id)));
    return { provider: 'openai', connected: true, source: 'live', models };
  } catch (error) {
    return providerError('openai', error);
  }
}

async function fetchOpenRouterModels(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKey('openrouter');

  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${ apiKey }`;
    const res = await withTimeout(fetch('https://openrouter.ai/api/v1/models?output_modalities=all', {
      cache: 'no-store',
      headers,
    }));
    if (!res.ok) throw new Error(`OpenRouter models request failed (${ res.status })`);
    const data = await res.json();
    const models = trimModels((data.data || []).map((model: any) => ({
      id: String(model.id || ''),
      name: model.name || model.id,
      description: model.description,
      contextLength: model.context_length,
      capabilities: [
        ...(model.architecture?.input_modalities || []),
        ...(model.architecture?.output_modalities || []),
        model.architecture?.instruct_type,
        ...(model.supported_parameters || []),
      ].filter(Boolean),
    })));
    return { provider: 'openrouter', connected: true, source: 'live', models };
  } catch (error) {
    return providerError('openrouter', error);
  }
}

async function fetchMistralModels(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKey('mistral');
  if (!apiKey) return { provider: 'mistral', connected: false, source: 'unavailable', models: [], error: 'Missing Mistral API key' };

  try {
    const res = await withTimeout(fetch('https://api.mistral.ai/v1/models', {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${ apiKey }` },
    }));
    if (!res.ok) throw new Error(`Mistral models request failed (${ res.status })`);
    const data = await res.json();
    const models = trimModels((data.data || []).map((model: any) => ({
      id: String(model.id || ''),
      name: model.name || model.id,
      description: model.description,
      capabilities: Object.entries(model.capabilities || {})
        .filter(([, enabled]) => Boolean(enabled))
        .map(([name]) => name),
    })));
    return { provider: 'mistral', connected: true, source: 'live', models };
  } catch (error) {
    return providerError('mistral', error);
  }
}

async function fetchAnthropicModels(): Promise<ProviderModelResult> {
  const apiKey = getRuntimeApiKey('anthropic');
  if (!apiKey) return { provider: 'anthropic', connected: false, source: 'unavailable', models: [], error: 'Missing Anthropic API key' };

  try {
    const res = await withTimeout(fetch('https://api.anthropic.com/v1/models', {
      cache: 'no-store',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    }));
    if (!res.ok) throw new Error(`Anthropic models request failed (${ res.status })`);
    const data = await res.json();
    const models = trimModels((data.data || []).map((model: any) => ({
      id: String(model.id || ''),
      name: model.display_name || model.id,
      description: [
        model.type ? `Type: ${ model.type }` : undefined,
        model.created_at ? `Created ${ model.created_at }` : undefined,
      ].filter(Boolean).join(' | ') || undefined,
    })));
    return { provider: 'anthropic', connected: true, source: 'live', models };
  } catch (error) {
    return providerError('anthropic', error);
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  applyRuntimeApiKeys(body?.apiKeys);
  applyRuntimeModelOverrides(body?.modelOverrides);

  const requested = Array.isArray(body?.providers) && body.providers.length > 0
    ? new Set(body.providers.map((provider: unknown) => String(provider)))
    : null;

  const jobs: Array<Promise<ProviderModelResult>> = [];
  if (!requested || requested.has('gemini')) jobs.push(fetchGeminiModels());
  if (!requested || requested.has('mistral')) jobs.push(fetchMistralModels());
  if (!requested || requested.has('openai')) jobs.push(fetchOpenAIModels());
  if (!requested || requested.has('openrouter')) jobs.push(fetchOpenRouterModels());
  if (!requested || requested.has('anthropic')) jobs.push(fetchAnthropicModels());

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
