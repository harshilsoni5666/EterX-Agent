import { NextRequest, NextResponse } from 'next/server';
import {
  clearStoredRuntimeSettings,
  readStoredRuntimeSettings,
  updateStoredRuntimeSettings,
} from '../../../../lib/agent/runtime-settings-store';
import { rejectCrossOrigin } from '../../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const noStoreHeaders = { 'Cache-Control': 'no-cache, no-store, must-revalidate' };

export async function GET(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
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
  return NextResponse.json({ ok: true }, { headers: noStoreHeaders });
}
