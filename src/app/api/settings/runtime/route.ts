import { NextRequest, NextResponse } from 'next/server';
import {
  clearStoredRuntimeSettings,
  readStoredRuntimeSettings,
  updateStoredRuntimeSettings,
} from '../../../../lib/agent/runtime-settings-store';
import { rejectCrossOrigin } from '../../agent/_shared';
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
    const body = await req.json().catch(() => null);
    const settings = body && Object.prototype.hasOwnProperty.call(body, 'settings') ? body.settings : body;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return NextResponse.json({ ok: false, error: 'A settings object is required.' }, { status: 400, headers: noStoreHeaders });
    }
    await updateStoredRuntimeSettings(settings);
    // Apply the committed snapshot, including model-specific credentials.
    // Applying only apiKeys here dropped those keys until the next request.
    hydrateServerRuntimeSettings(true);
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
  try {
    await clearStoredRuntimeSettings();
    hydrateServerRuntimeSettings(true);
    return NextResponse.json({ ok: true }, { headers: noStoreHeaders });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || 'Could not clear runtime settings.' }, { status: 500, headers: noStoreHeaders });
  }
}
