import { NextRequest, NextResponse } from 'next/server';
import {
  clearStoredRuntimeSettings,
  readStoredRuntimeSettings,
  updateStoredRuntimeSettings,
} from '../../../../lib/agent/runtime-settings-store';
import { rejectCrossOrigin } from '../../agent/_shared';
import { applyRuntimeApiKeys, applyRuntimeApiRetries, applyRuntimeModelOverrides } from '../../../../lib/agent/runtime-api-keys';
import { applyRuntimeProviderBaseURLs } from '../../../../lib/agent/provider-runtime';
import { applyRuntimeSearchSettings, getRuntimeSearchSettings } from '../../../../lib/search/search-runtime';
import { applyRuntimeImageSettings } from '../../../../lib/image/image-generation-runtime';
import { applyRuntimeVideoSettings } from '../../../../lib/video/video-generation-runtime';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const noStoreHeaders = { 'Cache-Control': 'no-cache, no-store, must-revalidate' };

export async function GET(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  hydrateServerRuntimeSettings();
  return NextResponse.json(
    { ok: true, settings: readStoredRuntimeSettings() },
    { headers: noStoreHeaders },
  );
}

export async function PUT(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;

  try {
    const body = await req.json().catch(() => ({}));
    const settings = body?.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)
      ? body.settings
      : body;
    await updateStoredRuntimeSettings(settings || {});
    if (Object.prototype.hasOwnProperty.call(settings || {}, 'apiRetries')) {
      applyRuntimeApiRetries(settings?.apiRetries);
    }
    if (Object.prototype.hasOwnProperty.call(settings || {}, 'apiKeys')) {
      applyRuntimeApiKeys(settings?.apiKeys && typeof settings.apiKeys === 'object' ? settings.apiKeys : {});
    }
    if (Object.prototype.hasOwnProperty.call(settings || {}, 'modelOverrides')) {
      applyRuntimeModelOverrides(settings?.modelOverrides && typeof settings.modelOverrides === 'object' ? settings.modelOverrides : {});
    }
    if (Object.prototype.hasOwnProperty.call(settings || {}, 'baseURLs')) {
      applyRuntimeProviderBaseURLs(settings?.baseURLs && typeof settings.baseURLs === 'object' ? settings.baseURLs : {});
    }
    if (settings?.search) {
      applyRuntimeSearchSettings(settings?.search || {}, settings?.apiKeys?.tavily);
    } else if (Object.prototype.hasOwnProperty.call(settings || {}, 'apiKeys')
      && settings?.apiKeys && Object.prototype.hasOwnProperty.call(settings.apiKeys, 'tavily')) {
      const currentSearch = getRuntimeSearchSettings();
      applyRuntimeSearchSettings({
        ...currentSearch,
        apiKeys: { ...currentSearch.apiKeys, tavily: settings.apiKeys.tavily },
      });
    }
    if (settings?.image) applyRuntimeImageSettings(settings.image);
    if (settings?.video) applyRuntimeVideoSettings(settings.video);
    return NextResponse.json(
      { ok: true, settings: readStoredRuntimeSettings() },
      { headers: noStoreHeaders },
    );
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'Could not persist runtime settings.' },
      { status: 500, headers: noStoreHeaders },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  await clearStoredRuntimeSettings();
  applyRuntimeApiKeys({});
  applyRuntimeApiRetries(undefined);
  applyRuntimeModelOverrides({});
  applyRuntimeProviderBaseURLs({});
  applyRuntimeSearchSettings({});
  applyRuntimeImageSettings({});
  applyRuntimeVideoSettings({});
  return NextResponse.json({ ok: true }, { headers: noStoreHeaders });
}
