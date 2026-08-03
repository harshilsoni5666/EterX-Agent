import { NextRequest, NextResponse } from 'next/server';
import { readStoredRuntimeSettings } from '../../../../lib/agent/runtime-settings-store';
import { rejectCrossOrigin } from '../../agent/_shared';
import { DEFAULT_GEMINI_LIVE_MODEL, normalizeLiveProvider, isGeminiLiveModel } from '../../../../lib/live/live-provider';

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

const readKey = (): string => {
  const stored = readStoredRuntimeSettings();
  const value = stored.liveApiKeys?.gemini;
  const values = Array.isArray(value) ? value : [value];
  return values.map(item => String(item || '').trim()).find(Boolean) || '';
};

const unavailable = (error: string, status = 503) => NextResponse.json({
  ok: false,
  provider: 'gemini',
  connected: false,
  source: 'unavailable',
  models: [],
  error,
}, { status });

export async function POST(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;

  const body = await req.json().catch(() => ({}));
  if (normalizeLiveProvider(body?.provider).provider !== 'gemini') {
    return unavailable('This Live Convo transport is not configured.', 400);
  }

  const apiKey = readKey();
  if (!apiKey) return unavailable('No separate Agent Live API key is configured.');

  try {
    const response = await withTimeout(fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1000`, {
      cache: 'no-store',
    }));
    if (!response.ok) throw new Error(`Gemini Live model request failed (${response.status})`);
    const payload = await response.json();
    const models = (Array.isArray(payload?.models) ? payload.models : [])
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

    return NextResponse.json({
      ok: true,
      provider: 'gemini',
      connected: true,
      source: 'live',
      models,
      updatedAt: Date.now(),
    });
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error || 'Live model discovery failed'), 502);
  }
}

export async function GET(req: NextRequest) {
  return POST(new NextRequest(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify({ provider: 'agent-live-convo' }),
  }));
}
