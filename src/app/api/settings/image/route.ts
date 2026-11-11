import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOrigin } from '../../agent/_shared';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';
import { updateStoredRuntimeSettings } from '../../../../lib/agent/runtime-settings-store';
import { applyRuntimeImageSettings, testImageProvider } from '../../../../lib/image/image-generation-runtime';
import { IMAGE_PROVIDER_IDS, normalizeImageSettings, type ImageProvider } from '../../../../lib/image/image-generation-config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const isImageProvider = (value: unknown): value is ImageProvider =>
  typeof value === 'string' && (IMAGE_PROVIDER_IDS as readonly string[]).includes(value);

export async function POST(req: NextRequest) {
  hydrateServerRuntimeSettings();
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  try {
    const body = await req.json().catch(() => ({}));
    const provider = String(body?.provider || '').trim();
    if (!isImageProvider(provider)) {
      return NextResponse.json({ ok: false, error: 'Unknown image generation provider.' }, { status: 400 });
    }
    const result = await testImageProvider(provider, String(body?.key || ''), String(body?.model || ''), String(body?.baseURL || ''));
    return NextResponse.json({ ok: true, provider, model: result.model, result: { message: result.message } });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || 'Image provider test failed.' }, { status: 502 });
  }
}

export async function PUT(req: NextRequest) {
  hydrateServerRuntimeSettings();
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  try {
    const body = await req.json().catch(() => null);
    const settings = body && Object.prototype.hasOwnProperty.call(body, 'image') ? body.image : body;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return NextResponse.json({ ok: false, error: 'An image settings object is required.' }, { status: 400 });
    }
    const normalized = normalizeImageSettings(settings);
    await updateStoredRuntimeSettings({ image: normalized });
    const applied = applyRuntimeImageSettings(normalized);
    return NextResponse.json({ ok: true, provider: applied.provider, fallbackProviders: applied.fallbackProviders });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || 'Could not apply image generation settings.' }, { status: 500 });
  }
}
