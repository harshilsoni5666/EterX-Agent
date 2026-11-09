import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOrigin } from '../../agent/_shared';
import { ensureCuaDriverDaemon, getCuaDriverStatus, runCua } from '../../../../lib/agent/computer/cua-driver';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  const driver = await getCuaDriverStatus(request.nextUrl.searchParams.get('refresh') === '1');
  return NextResponse.json({ success: true, platform: process.platform, driver }, { headers });
}

export async function POST(request: NextRequest) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  try {
    const body = await request.json();
    if (body?.action === 'start') {
      const status = await ensureCuaDriverDaemon();
      if (!status.daemonRunning) return NextResponse.json({ success: false, error: status.message, driver: status }, { status: 409, headers });
    } else if (body?.action === 'permissions' && process.platform === 'darwin') {
      // Only this explicit settings button asks the OS to show permission UI.
      await runCua(['permissions', 'grant'], 15_000);
    } else {
      return NextResponse.json({ success: false, error: 'Unknown desktop setup action.' }, { status: 400, headers });
    }
    const driver = await getCuaDriverStatus(true);
    return NextResponse.json({ success: true, driver, message: body.action === 'permissions'
      ? 'Enable CuaDriver in macOS Accessibility and Screen Recording, then refresh status.'
      : driver.message }, { headers });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: String(error?.message || 'Desktop setup failed.').slice(0, 700) }, { status: 409, headers });
  }
}
