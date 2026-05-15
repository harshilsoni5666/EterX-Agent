import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/agent/poll?chatId=xxx&after=-1 — Incremental trace polling
 * 
 * Returns new trace events since the given index. The UI polls this every 150-300ms
 * while an agent is running. This is the key to UI independence:
 * - Agent runs on server regardless of UI state
 * - UI can disconnect/reconnect anytime by polling with after=0
 * - Switching chats just means polling a different chatId
 * - Page refresh? Poll from after=-1 to get FULL history
 * 
 * Returns: { status, traces: [...], totalTraces, maxIndex, finalAnswer, startedAt, completedAt }
 */
export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const chatId = searchParams.get('chatId');
    const afterStr = searchParams.get('after');

    if (!chatId) {
      return NextResponse.json({ error: 'chatId is required' }, { status: 400 });
    }

    const afterIndex = afterStr ? parseInt(afterStr, 10) : -1;
    const result = agentRegistry.getTraces(chatId, afterIndex);

    // Return with anti-cache headers for maximum freshness
    return new NextResponse(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });
  } catch (error: any) {
    console.error('[API: agent/poll] Error:', error);
    return NextResponse.json(
      { status: 'idle', traces: [], totalTraces: 0, maxIndex: -1, finalAnswer: '', error: error.message },
      { status: 500 }
    );
  }
}
