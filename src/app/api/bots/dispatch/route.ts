import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOrigin } from '../../agent/_shared';
import { telegramBotRuntime } from '../../../../lib/agent/telegram-bot-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  try {
    const { eventId } = await request.json();
    if (typeof eventId !== 'string' || !/^tbot_[a-zA-Z0-9_-]{1,110}$/.test(eventId)) return NextResponse.json({ error: 'Invalid bot event.' }, { status: 400 });
    return NextResponse.json(await telegramBotRuntime.dispatch(eventId));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not dispatch bot message.' }, { status: 503 });
  }
}
