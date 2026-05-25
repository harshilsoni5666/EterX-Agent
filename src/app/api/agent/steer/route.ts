import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/agent/steer
 *
 * Accepts a live steering message while an agent is running.
 * The message is appended to a per-chat queue that is drained by the
 * ReAct loop on the next free iteration — so the agent is never
 * interrupted mid-action; it sees the comment when it naturally becomes
 * ready to decide its next step.
 *
 * Body: { chatId: string; message: string; id?: string }
 * Returns:
 *   { success: true }  — queued successfully
 *   { success: false, reason: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { chatId, message, id } = body as { chatId?: string; message?: string; id?: string };

    if (!chatId) {
      return NextResponse.json({ success: false, reason: 'chatId is required' }, { status: 400 });
    }
    if (!message || !String(message).trim()) {
      return NextResponse.json({ success: false, reason: 'message must be a non-empty string' }, { status: 400 });
    }

    const queued = agentRegistry.addSteeringMessage(chatId, String(message).trim(), id);

    if (!queued) {
      return NextResponse.json(
        { success: false, reason: 'No running agent found for this chat. The message was not queued.' },
        { status: 409 }
      );
    }

    console.log(`[API/steer] 🧭 Steering queued for chat ${chatId.substring(0, 8)}...`);
    return NextResponse.json({ success: true, message: 'Steering message queued' });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
