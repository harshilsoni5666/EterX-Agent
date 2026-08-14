import { NextRequest, NextResponse } from 'next/server';
import { readStoredRuntimeSettings } from '../../../../lib/agent/runtime-settings-store';
import { rejectCrossOrigin } from '../../agent/_shared';
import {
  DEFAULT_DEEPGRAM_THINK_MODEL,
  DEFAULT_OPENAI_LIVE_MODEL,
  getLiveModelOptions,
  isLiveModelForProvider,
  isOpenAIRealtimeModel,
  normalizeLiveProvider,
  readDeepgramGrantCredential,
  readLiveRealtimeCredential,
} from '../../../../lib/live/live-provider';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const firstKey = (value: unknown): string => {
  const values = Array.isArray(value) ? value : [value];
  return values.map(item => String(item || '').trim()).find(Boolean) || '';
};

const withTimeout = async <T,>(promise: Promise<T>, ms = 15_000): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Provider authorization timed out after ${ms}ms.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const providerModel = (providerValue: unknown, modelValue: unknown): string => {
  const requested = String(modelValue || '').trim();
  const options = getLiveModelOptions(providerValue);
  return requested && requested !== 'auto' && isLiveModelForProvider(providerValue, requested) && (
    options.some(option => option.value === requested) || isOpenAIRealtimeModel(requested)
  )
    ? requested
    : String(options.find(option => option.value !== 'auto')?.value || '');
};

const providerVoice = (voiceValue: unknown): string => {
  const voice = String(voiceValue || '').trim();
  return voice && !['auto', 'agent-default'].includes(voice) ? voice : '';
};

const upstreamError = async (response: Response, providerLabel: string): Promise<Error> => {
  const payload = await response.json().catch(() => null);
  const detail = payload?.error?.message || payload?.message || payload?.error || response.statusText;
  return new Error(`${providerLabel} authorization failed (${response.status}): ${String(detail || 'unknown error')}`);
};

export async function POST(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;

  try {
    const body = await req.json().catch(() => ({}));
    const provider = normalizeLiveProvider(body?.provider);
    const stored = readStoredRuntimeSettings();
    const apiKey = firstKey(stored.liveApiKeys?.[provider.keyProvider]);
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: `No ${provider.label} API key is configured.` }, { status: 503 });
    }

    const model = providerModel(provider.value, body?.model);
    const voice = providerVoice(body?.voice);
    const instructions = String(body?.instructions || '').trim().slice(0, 20_000);

    if (provider.transport === 'openai-webrtc') {
      const response = await withTimeout(fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: {
            type: 'realtime',
            model,
            output_modalities: ['audio'],
            instructions,
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                transcription: { model: 'gpt-4o-mini-transcribe' },
                turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true },
              },
              output: { format: { type: 'audio/pcm' }, voice: voice || 'marin' },
            },
          },
        }),
      }));
      if (!response.ok) throw await upstreamError(response, provider.label);
      const payload = await response.json();
      const credential = readLiveRealtimeCredential(payload);
      if (!credential.token) throw new Error(`${provider.label} did not return a client secret.`);
      return NextResponse.json({ ok: true, provider: provider.value, token: credential.token, expiresAt: credential.expiresAt, model: model || DEFAULT_OPENAI_LIVE_MODEL });
    }

    if (provider.transport === 'xai-native') {
      const response = await withTimeout(fetch('https://api.x.ai/v1/realtime/client_secrets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expires_after: { seconds: 300 } }),
      }));
      if (!response.ok) throw await upstreamError(response, provider.label);
      const payload = await response.json();
      const credential = readLiveRealtimeCredential(payload);
      if (!credential.token) throw new Error(`${provider.label} did not return a client secret.`);
      return NextResponse.json({ ok: true, provider: provider.value, token: credential.token, expiresAt: credential.expiresAt, model });
    }

    if (provider.transport === 'deepgram-native') {
      const response = await withTimeout(fetch('https://api.deepgram.com/v1/auth/grant', {
        method: 'POST',
        headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl_seconds: 60 }),
      }));
      if (!response.ok) throw await upstreamError(response, provider.label);
      const payload = await response.json();
      const credential = readDeepgramGrantCredential(payload);
      return NextResponse.json({
        ok: true,
        provider: provider.value,
        token: credential.token,
        expiresIn: credential.expiresIn,
        thinkModel: DEFAULT_DEEPGRAM_THINK_MODEL,
      });
    }

    if (provider.transport === 'elevenlabs-native') {
      const agentId = String(body?.agentId || '').trim();
      if (!agentId) {
        return NextResponse.json({ ok: false, error: 'ElevenLabs requires a Conversational Agent ID in Live settings.' }, { status: 400 });
      }
      const url = new URL('https://api.elevenlabs.io/v1/convai/conversation/get-signed-url');
      url.searchParams.set('agent_id', agentId);
      const response = await withTimeout(fetch(url, { headers: { 'xi-api-key': apiKey } }));
      if (!response.ok) throw await upstreamError(response, provider.label);
      const payload = await response.json();
      const signedUrl = String(payload?.signed_url || '').trim();
      if (!signedUrl) throw new Error('ElevenLabs did not return a signed conversation URL.');
      let parsedSignedUrl: URL;
      try {
        parsedSignedUrl = new URL(signedUrl);
      } catch {
        throw new Error('ElevenLabs returned an invalid signed conversation URL.');
      }
      if (
        parsedSignedUrl.protocol !== 'wss:' ||
        parsedSignedUrl.pathname !== '/v1/convai/conversation' ||
        !parsedSignedUrl.searchParams.get('agent_id')
      ) {
        throw new Error('ElevenLabs returned an invalid signed conversation URL.');
      }
      return NextResponse.json({ ok: true, provider: provider.value, signedUrl });
    }

    return NextResponse.json({ ok: false, error: `No realtime authorization adapter is available for ${provider.label}.` }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error || 'Live authorization failed.') }, { status: 502 });
  }
}
