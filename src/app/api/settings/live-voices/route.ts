import { NextRequest, NextResponse } from 'next/server';
import { normalizeLiveProvider } from '../../../../lib/live/live-provider';
import { getLiveVoiceOptions } from '../../../../lib/live/voice-catalog';
import { readStoredRuntimeSettings } from '../../../../lib/agent/runtime-settings-store';
import { rejectCrossOrigin } from '../../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const firstKey = (value: unknown): string => {
  const values = Array.isArray(value) ? value : [value];
  return values.map(item => String(item || '').trim()).find(Boolean) || '';
};

const buildVoiceCatalogResponse = async (providerValue: unknown, modelValue: unknown) => {
  const provider = normalizeLiveProvider(providerValue);
  const modelId = String(modelValue || 'auto').trim() || 'auto';
  let voices = getLiveVoiceOptions(provider.value);
  let source = 'native-media-catalog';

  // xAI documents a provider voice directory. Keep the static voices as a
  // resilient fallback when the key is missing or the directory is offline.
  if (provider.provider === 'grok') {
    const key = firstKey(readStoredRuntimeSettings().liveApiKeys?.[provider.keyProvider]);
    if (key) {
      try {
        const response = await fetch('https://api.x.ai/v1/tts/voices', {
          headers: { Authorization: `Bearer ${key}` },
          cache: 'no-store',
        });
        if (response.ok) {
          const payload = await response.json();
          const discovered = Array.isArray(payload?.voices)
            ? payload.voices.map((voice: any) => ({
                value: String(voice?.voice_id || '').trim(),
                label: String(voice?.name || voice?.voice_id || '').trim(),
                description: String(voice?.language || '').trim() || undefined,
              })).filter((voice: { value: string }) => voice.value)
            : [];
          if (discovered.length) {
            voices = [{ value: 'auto', label: 'Auto (xAI Default)', tag: 'AUTO' }, ...discovered];
            source = 'provider-directory';
          }
        }
      } catch {
        // Static documented voices keep the selector usable during discovery failures.
      }
    }
  }

  return {
    ok: true,
    provider: provider.value,
    modelId,
    mediaProvider: provider.provider,
    source,
    defaultVoice: voices.find(voice => voice.value !== 'auto')?.value || 'auto',
    updatedAt: Date.now(),
    voices,
  };
};

export async function POST(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  const body = await req.json().catch(() => ({}));
  return NextResponse.json(await buildVoiceCatalogResponse(body?.provider, body?.modelId));
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  return NextResponse.json(await buildVoiceCatalogResponse(
    url.searchParams.get('provider'),
    url.searchParams.get('modelId'),
  ));
}
