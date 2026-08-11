import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOrigin } from '../../agent/_shared';
import { adaptiveExperience } from '../../../../lib/agent/self-improvement/engine';
import { readStoredRuntimeSettings, updateStoredRuntimeSettings } from '../../../../lib/agent/runtime-settings-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const headers = { 'Cache-Control': 'no-cache, no-store, must-revalidate' };

export async function GET(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  const stored = readStoredRuntimeSettings();
  return NextResponse.json({
    ok: true,
    enabled: stored.selfImprovement?.enabled !== false,
    stats: await adaptiveExperience.getStats(),
  }, { headers });
}

export async function PUT(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  try {
    const body = await req.json().catch(() => ({}));
    const enabled = body?.enabled !== false;
    await updateStoredRuntimeSettings({ selfImprovement: { enabled } });
    return NextResponse.json({
      ok: true,
      enabled,
      stats: await adaptiveExperience.getStats(),
    }, { headers });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Could not update self-improvement.',
    }, { status: 500, headers });
  }
}
