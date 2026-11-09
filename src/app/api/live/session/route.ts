import { NextRequest, NextResponse } from 'next/server';
import { createLiveCatalogRequest } from '../../../../lib/live/catalog-request';
import { rejectCrossOrigin } from '../../agent/_shared';
import {
  DEFAULT_DEEPGRAM_THINK_MODEL,
  isLiveModelForProvider,
  normalizeLiveProvider,
  readDeepgramGrantCredential,
  readLiveRealtimeCredential,
} from '../../../../lib/live/live-provider';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const providerModel = (providerValue: unknown, modelValue: unknown): string => {
  const requested = String(modelValue || '').trim();
  if (requested && requested !== 'auto') {
    if (!isLiveModelForProvider(providerValue, requested)) throw new Error('The selected model is incompatible with this Live provider. Choose a model in Live settings.');
    return requested;
  }
  throw new Error('Resolve an exact available Live model before starting a session.');
};

const providerVoice = (voiceValue: unknown): string => {
  const voice = String(voiceValue || '').trim();
  return voice && !['auto', 'agent-default'].includes(voice) ? voice : '';
};

export async function POST(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;

  try {
    const body = await req.json().catch(() => ({}));
    const provider = normalizeLiveProvider(body?.provider);
    if (provider.transport === 'model-voice') return NextResponse.json({ ok: false, error: 'Configured models use the agent connection and do not need a realtime token.' }, { status: 400 });
    const client = createLiveCatalogRequest(provider.value, undefined, req.signal, body?.model);
    if (!client.hasKey) {
      return NextResponse.json({ ok: false, error: `No ${provider.label} API key is configured.` }, { status: 503 });
    }

    const model = providerModel(provider.value, body?.model);
    const voice = providerVoice(body?.voice);
    const instructions = String(body?.instructions || '').trim().slice(0, 20_000);

    if (provider.transport === 'gemini-native') {
      const expiresAt = Date.now() + 30 * 60_000;
      const payload = await client.request('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uses: 1,
          expireTime: new Date(expiresAt).toISOString(),
          newSessionExpireTime: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
      const token = String(payload?.name || '').trim();
      if (!token.startsWith('auth_tokens/')) throw new Error('Gemini did not return an ephemeral Live token.');
      return NextResponse.json({ ok: true, provider: provider.value, token, expiresAt, model }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (provider.transport === 'openai-webrtc') {
      const payload = await client.request('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
              output: { format: { type: 'audio/pcm', rate: 24000 }, voice: voice || 'marin' },
            },
          },
        }),
      });
      const credential = readLiveRealtimeCredential(payload);
      if (!credential.token) throw new Error(`${provider.label} did not return a client secret.`);
      return NextResponse.json({ ok: true, provider: provider.value, token: credential.token, expiresAt: credential.expiresAt, model }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (provider.transport === 'xai-native') {
      const payload = await client.request('https://api.x.ai/v1/realtime/client_secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expires_after: { seconds: 300 } }),
      });
      const credential = readLiveRealtimeCredential(payload);
      if (!credential.token) throw new Error(`${provider.label} did not return a client secret.`);
      return NextResponse.json({ ok: true, provider: provider.value, token: credential.token, expiresAt: credential.expiresAt, model }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (provider.transport === 'deepgram-native') {
      const payload = await client.request('https://api.deepgram.com/v1/auth/grant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl_seconds: 60 }),
      });
      const credential = readDeepgramGrantCredential(payload);
      return NextResponse.json({
        ok: true,
        provider: provider.value,
        token: credential.token,
        expiresIn: credential.expiresIn,
        thinkModel: DEFAULT_DEEPGRAM_THINK_MODEL,
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (provider.transport === 'elevenlabs-native') {
      const agentId = String(body?.agentId || '').trim();
      if (!agentId) {
        return NextResponse.json({ ok: false, error: 'ElevenLabs requires a Conversational Agent ID in Live settings.' }, { status: 400 });
      }
      const agent = await client.request('https://api.elevenlabs.io/v1/convai/agents/' + encodeURIComponent(agentId));
      const allowedOverrides = agent.platform_settings?.overrides?.conversation_config_override;
      if (voice && allowedOverrides?.tts?.voice_id !== true) {
        return NextResponse.json({ ok: false, error: 'This ElevenLabs agent does not allow voice overrides. Choose Agent configured voice, or enable voice overrides in the agent settings.' }, { status: 400 });
      }
      const allowPromptOverride = allowedOverrides?.agent?.prompt?.prompt === true;
      const url = new URL('https://api.elevenlabs.io/v1/convai/conversation/get-signed-url');
      url.searchParams.set('agent_id', agentId);
      const payload = await client.request(url.toString(), { method: 'GET', cache: 'no-store' });
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
        parsedSignedUrl.hostname !== 'api.elevenlabs.io' ||
        parsedSignedUrl.pathname !== '/v1/convai/conversation' ||
        !parsedSignedUrl.searchParams.get('agent_id')
      ) {
        throw new Error('ElevenLabs returned an invalid signed conversation URL.');
      }
      return NextResponse.json({ ok: true, provider: provider.value, signedUrl, allowPromptOverride }, { headers: { 'Cache-Control': 'no-store' } });
    }

    return NextResponse.json({ ok: false, error: `No realtime authorization adapter is available for ${provider.label}.` }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error || 'Live authorization failed.') }, { status: 502 });
  }
}
