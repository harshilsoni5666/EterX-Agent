import { NextRequest, NextResponse } from 'next/server';
import { normalizeLiveProvider } from '../../../../lib/live/live-provider';
import { GEMINI_LIVE_VOICE_OPTIONS } from '../../../../lib/live/voice-catalog';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const buildVoiceCatalogResponse = (providerValue: unknown, modelValue: unknown) => {
  const provider = normalizeLiveProvider(providerValue);
  const modelId = String(modelValue || 'auto').trim() || 'auto';

  return {
    ok: true,
    provider: provider.value,
    modelId,
    mediaProvider: provider.provider,
    source: 'native-media-catalog',
    defaultVoice: 'Kore',
    updatedAt: Date.now(),
    voices: GEMINI_LIVE_VOICE_OPTIONS,
  };
};

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  return NextResponse.json(buildVoiceCatalogResponse(body?.provider, body?.modelId));
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  return NextResponse.json(buildVoiceCatalogResponse(
    url.searchParams.get('provider'),
    url.searchParams.get('modelId'),
  ));
}
