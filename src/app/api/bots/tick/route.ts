import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOrigin } from '../../agent/_shared';
import { tickBotRoutines } from '../../../../lib/agent/telegram-bot-scheduler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: NextRequest) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  try { return NextResponse.json({ ok: true, events: await tickBotRoutines() }); }
  catch { return NextResponse.json({ ok: false }, { status: 503 }); }
}
