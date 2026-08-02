import { NextRequest, NextResponse } from 'next/server';
import { loadScheduledTaskSnapshot, saveScheduledTaskSnapshot } from '../../../lib/scheduled-task-store';
import { normalizeScheduledTask } from '../../../lib/scheduled-tasks';
import { rejectCrossOrigin } from '../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const headers = { 'Cache-Control': 'no-cache, no-store, must-revalidate' };

export async function GET(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  try {
    return NextResponse.json(await loadScheduledTaskSnapshot(), { headers });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Unable to load scheduled tasks.' }, { status: 500, headers });
  }
}

export async function PUT(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  try {
    const body = await req.json();
    if (!Array.isArray(body?.tasks)) {
      return NextResponse.json({ error: 'tasks must be an array.' }, { status: 400, headers });
    }
    const snapshot = await saveScheduledTaskSnapshot(body.tasks.map(normalizeScheduledTask), Date.now());
    return NextResponse.json({ ok: true, ...snapshot }, { headers });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Unable to save scheduled tasks.' }, { status: 500, headers });
  }
}
