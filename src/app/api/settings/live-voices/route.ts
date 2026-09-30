import { NextRequest, NextResponse } from 'next/server';
import { normalizeLiveProvider, getDefaultLiveVoice, isDeepgramLiveVoice } from '../../../../lib/live/live-provider';
import { getLiveVoiceOptions, type LiveVoiceOption } from '../../../../lib/live/voice-catalog';
import { createLiveCatalogRequest, isAvailableCatalogItem } from '../../../../lib/live/catalog-request';
import { rejectCrossOrigin } from '../../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function buildVoiceCatalogResponse(body: any) {
  const provider = normalizeLiveProvider(body?.provider);
  const client = createLiveCatalogRequest(provider.value, body?.key);
  let source = 'documented-catalog';
  let voices: LiveVoiceOption[] = [];
  let defaultVoice = getDefaultLiveVoice(provider.value);
  let error = '';
  try {
    if (provider.provider === 'gemini' || provider.provider === 'openai') {
      // These transports expose prebuilt voices, not an account voice-list API.
      voices = getLiveVoiceOptions(provider.value);
    } else if (provider.provider === 'grok') {
      const payload = await client.request('https://api.x.ai/v1/tts/voices');
      if (!Array.isArray(payload?.voices)) throw new Error('xAI returned an invalid voice catalog.');
      voices = payload.voices.filter(isAvailableCatalogItem).map((voice: any) => ({
        value: String(voice.voice_id || voice.id || '').trim(),
        label: String(voice.name || voice.voice_id || voice.id || '').trim(),
        description: String(voice.description || voice.language || ''),
      }));
      source = 'provider-directory';
    } else if (provider.provider === 'deepgram') {
      const payload = await client.request('https://api.deepgram.com/v1/models');
      if (!Array.isArray(payload?.tts)) throw new Error('Deepgram returned an invalid voice catalog.');
      voices = payload.tts.filter(isAvailableCatalogItem).map((voice: any) => ({
        value: String(voice.canonical_name || '').trim(),
        label: String(voice.name || voice.canonical_name || '').trim(),
        description: Array.isArray(voice.languages) ? voice.languages.join(', ') : '',
      })).filter((voice: LiveVoiceOption) => isDeepgramLiveVoice(voice.value));
      source = 'provider-directory';
    } else if (provider.provider === 'elevenlabs') {
      const agentId = String(body?.agentId || '').trim();
      if (agentId) {
        const agent = await client.request('https://api.elevenlabs.io/v1/convai/agents/' + encodeURIComponent(agentId));
        if (agent.platform_settings?.overrides?.conversation_config_override?.tts?.voice_id !== true) {
          return { ok: true, provider: provider.value, modelId: String(body?.modelId || 'auto'),
            mediaProvider: provider.provider, source: 'agent-configuration', defaultVoice: 'agent-default', updatedAt: Date.now(),
            voices: [{ value: 'auto', label: 'Auto (Agent configured voice)' },
              { value: 'agent-default', label: 'Agent configured voice', description: 'Enable voice overrides in ElevenLabs to choose another voice.' }] };
        }
      }
      const tokens = new Set<string>();
      let token = '';
      for (let page = 0; page < 100; page++) {
        const payload = await client.request('https://api.elevenlabs.io/v2/voices?page_size=100'
          + (token ? '&next_page_token=' + encodeURIComponent(token) : ''));
        if (!Array.isArray(payload?.voices)) throw new Error('ElevenLabs returned an invalid voice catalog.');
        voices.push(...payload.voices.filter(isAvailableCatalogItem).map((voice: any) => ({
          value: String(voice.voice_id || '').trim(), label: String(voice.name || voice.voice_id || '').trim(),
          description: String(voice.description || voice.category || ''),
        })));
        if (!payload.has_more) break;
        token = String(payload.next_page_token || '');
        if (!token || tokens.has(token) || page === 99) throw new Error('ElevenLabs returned an incomplete voice catalog. Please retry.');
        tokens.add(token);
      }
      // Preserve the agent's configured voice unless the user explicitly overrides it.
      voices.unshift({ value: 'agent-default', label: 'Agent configured voice', tag: 'AGENT' });
      source = 'provider-directory';
    }
    voices = Array.from(new Map(voices.filter(voice => voice.value && voice.value !== 'auto')
      .map(voice => [voice.value, voice])).values());
    if (!voices.length) throw new Error(`No compatible voices were returned by ${provider.label}.`);
    if (!voices.some(voice => voice.value === defaultVoice)) defaultVoice = voices[0].value;
    voices.unshift({ value: 'auto', label: 'Auto (Provider default)', tag: 'AUTO' });
  } catch (cause) {
    voices = [];
    source = 'unavailable';
    error = cause instanceof Error ? cause.message : 'Voice discovery failed.';
  }
  return { ok: !error, provider: provider.value, modelId: String(body?.modelId || 'auto'),
    mediaProvider: provider.provider, source, defaultVoice, updatedAt: Date.now(), voices, ...(error ? { error } : {}) };
}

export async function POST(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  const result = await buildVoiceCatalogResponse(await req.json().catch(() => ({})));
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  return POST(new NextRequest(req.url, { method: 'POST', headers: req.headers,
    body: JSON.stringify({ provider: url.searchParams.get('provider'), modelId: url.searchParams.get('modelId') }) }));
}
