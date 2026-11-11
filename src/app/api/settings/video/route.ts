import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOrigin } from '../../agent/_shared';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';
import { updateStoredRuntimeSettings } from '../../../../lib/agent/runtime-settings-store';
import { applyRuntimeVideoSettings, testVideoProvider } from '../../../../lib/video/video-generation-runtime';
import { VIDEO_PROVIDER_IDS, normalizeVideoSettings, type VideoProvider } from '../../../../lib/video/video-generation-config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const isVideoProvider = (value: unknown): value is VideoProvider =>
  typeof value === 'string' && (VIDEO_PROVIDER_IDS as readonly string[]).includes(value);

export async function POST(req: NextRequest) {
  hydrateServerRuntimeSettings();
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  try {
    const body = await req.json().catch(() => ({}));
    const provider = String(body?.provider || '').trim();
    if (!isVideoProvider(provider)) return NextResponse.json({ ok: false, error: 'Unknown video generation provider.' }, { status: 400 });
    const result = await testVideoProvider(provider, String(body?.key || ''), String(body?.model || ''), String(body?.baseURL || ''));
    return NextResponse.json({ ok: true, provider, model: result.model, result: { message: result.message } });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || 'Video provider test failed.' }, { status: 502 });
  }
}

export async function PUT(req: NextRequest) {
  hydrateServerRuntimeSettings();
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  try {
    const body = await req.json().catch(() => null);
    const settings = body && Object.prototype.hasOwnProperty.call(body, 'video') ? body.video : body;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return NextResponse.json({ ok: false, error: 'A video settings object is required.' }, { status: 400 });
    }
    const normalized = normalizeVideoSettings(settings);
    await updateStoredRuntimeSettings({ video: normalized });
    const applied = applyRuntimeVideoSettings(normalized);
    return NextResponse.json({ ok: true, provider: applied.provider, fallbackProviders: applied.fallbackProviders });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || 'Could not apply video generation settings.' }, { status: 500 });
  }
}
