import { NextRequest, NextResponse } from 'next/server';
import { readStoredRuntimeSettings } from '../../../../lib/agent/runtime-settings-store';
import { rejectCrossOrigin } from '../../agent/_shared';
import {
  DEFAULT_GEMINI_LIVE_MODEL,
  getLiveModelOptions,
  isOpenAIRealtimeModel,
  normalizeLiveProvider,
  isGeminiLiveModel,
} from '../../../../lib/live/live-provider';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const withTimeout = async <T,>(promise: Promise<T>, ms = 12_000): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const firstKey = (value: unknown): string => {
  const values = Array.isArray(value) ? value : [value];
  return values.map(item => String(item || '').trim()).find(Boolean) || '';
};

const readKey = (providerKey: string, override?: unknown): string => {
  const explicit = firstKey(override);
  if (explicit) return explicit;
  const stored = readStoredRuntimeSettings();
  return firstKey(stored.liveApiKeys?.[providerKey]);
};

const staticModels = (providerValue: string) => {
  const provider = normalizeLiveProvider(providerValue);
  return getLiveModelOptions(providerValue).map(model => ({
    id: model.value,
    name: model.label,
    description: model.description,
    tag: model.tag,
    capabilities: [
      'audio',
      'voice',
      ...(provider.supportsVision ? ['video'] : []),
      provider.transport,
    ],
  }));
};

const responseFor = (
  providerValue: string,
  connected: boolean,
  models: Array<Record<string, unknown>>,
  error?: string,
  status = 200,
) => NextResponse.json({
  ok: status < 400,
  provider: providerValue,
  connected,
  source: connected ? 'live' : 'catalog',
  models,
  ...(error ? { error } : {}),
  updatedAt: Date.now(),
}, { status });

const validateProviderKey = async (providerValue: string, apiKey: string): Promise<void> => {
  const provider = normalizeLiveProvider(providerValue);
  if (provider.provider === 'openai') {
    const response = await withTimeout(fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: 'no-store',
    }));
    if (!response.ok) throw new Error(`OpenAI credential check failed (${response.status}).`);
  } else if (provider.provider === 'grok') {
    const response = await withTimeout(fetch('https://api.x.ai/v1/tts/voices', {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: 'no-store',
    }));
    if (!response.ok) throw new Error(`xAI credential check failed (${response.status}).`);
  } else if (provider.provider === 'deepgram') {
    const response = await withTimeout(fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: 60 }),
      cache: 'no-store',
    }));
    if (!response.ok) throw new Error(`Deepgram credential check failed (${response.status}).`);
  } else if (provider.provider === 'elevenlabs') {
    const response = await withTimeout(fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': apiKey },
      cache: 'no-store',
    }));
    if (!response.ok) throw new Error(`ElevenLabs credential check failed (${response.status}).`);
  }
};

export async function POST(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;

  const body = await req.json().catch(() => ({}));
  const provider = normalizeLiveProvider(body?.provider);
  const models = staticModels(provider.value);
  const apiKey = readKey(provider.keyProvider, body?.key);

  // Keep the static catalog visible before a key is configured. This prevents
  // the Live Convo tab from rendering an empty model selector while still
  // making the missing credential explicit to the user.
  if (!apiKey) {
    return responseFor(provider.value, false, models, `No ${provider.label} API key is configured.`);
  }

  if (provider.provider === 'gemini') {
    try {
      const response = await withTimeout(fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1000`, {
        cache: 'no-store',
      }));
      if (!response.ok) throw new Error(`Gemini Live model request failed (${response.status})`);
      const payload = await response.json();
      const discovered = (Array.isArray(payload?.models) ? payload.models : [])
        .filter((model: any) => {
          const id = String(model?.baseModelId || model?.name || '').replace(/^models\//, '');
          const methods = Array.isArray(model?.supportedGenerationMethods) ? model.supportedGenerationMethods : [];
          return isGeminiLiveModel(id) && methods.includes('bidiGenerateContent');
        })
        .map((model: any) => {
          const id = String(model?.baseModelId || model?.name || '').replace(/^models\//, '');
          return {
            id,
            name: String(model?.displayName || id),
            description: model?.description,
            capabilities: Array.isArray(model?.supportedGenerationMethods) ? model.supportedGenerationMethods : [],
          };
        })
        .filter((model: { id: string }) => Boolean(model.id))
        .sort((left: { id: string }, right: { id: string }) => {
          if (left.id === DEFAULT_GEMINI_LIVE_MODEL) return -1;
          if (right.id === DEFAULT_GEMINI_LIVE_MODEL) return 1;
          return left.id.localeCompare(right.id);
        });

      return responseFor(provider.value, true, discovered.length ? discovered : models);
    } catch (error) {
      return responseFor(
        provider.value,
        false,
        models,
        error instanceof Error ? error.message : String(error || 'Live model discovery failed'),
        502,
      );
    }
  }

  if (provider.provider === 'openai') {
    try {
      const response = await withTimeout(fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        cache: 'no-store',
      }));
      if (!response.ok) throw new Error(`OpenAI Live model request failed (${response.status})`);
      const payload = await response.json();
      const discovered = (Array.isArray(payload?.data) ? payload.data : [])
        .map((model: any) => String(model?.id || '').trim())
        .filter((id: string) => isOpenAIRealtimeModel(id))
        .map((id: string) => ({
          id,
          name: id === 'gpt-realtime' ? 'GPT Realtime' : id === 'gpt-realtime-mini' ? 'GPT Realtime Mini' : id,
          description: 'Returned by the OpenAI Realtime model catalog',
          capabilities: ['audio', 'voice', 'openai-webrtc'],
        }));
      const merged = new Map(models.map(model => [String(model.id), model]));
      for (const model of discovered) merged.set(model.id, model);
      return responseFor(provider.value, true, [...merged.values()]);
    } catch (error) {
      return responseFor(
        provider.value,
        false,
        models,
        error instanceof Error ? error.message : String(error || 'OpenAI Live model discovery failed'),
        502,
      );
    }
  }

  try {
    await validateProviderKey(provider.value, apiKey);
    return responseFor(provider.value, true, models);
  } catch (error) {
    return responseFor(
      provider.value,
      false,
      models,
      error instanceof Error ? error.message : String(error || 'Provider credential check failed'),
      502,
    );
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  return POST(new NextRequest(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify({ provider: url.searchParams.get('provider') || 'agent-live-convo' }),
  }));
}
