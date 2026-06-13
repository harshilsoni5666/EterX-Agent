import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import { taskStore } from '../../../../lib/agent/task-store';
import {
  attachAgentApiSessionCookie,
  getOrCreateAgentApiSession,
  isSafeChatId,
  jsonError,
  parseInteger,
  rejectCrossOrigin,
  requireChatOwner,
} from '../_shared';

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
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);

    const searchParams = req.nextUrl.searchParams;
    const chatId = searchParams.get('chatId');
    const afterStr = searchParams.get('after');

    if (!isSafeChatId(chatId)) {
      return attachAgentApiSessionCookie(jsonError('chatId is required', 400), session);
    }

    const ownerError = requireChatOwner(chatId, session.sessionId);
    if (ownerError) {
      return attachAgentApiSessionCookie(ownerError, session);
    }

    const afterIndex = Math.max(-1, parseInteger(afterStr, -1));
    let result = agentRegistry.getTraces(chatId, afterIndex);

    if (result.status === 'idle') {
      const persisted = await taskStore.getPollState(chatId, afterIndex);
      if (persisted.status !== 'idle') {
        result = persisted;
      }
    }

    // Return with anti-cache headers for maximum freshness
    return attachAgentApiSessionCookie(new NextResponse(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    }), session);
  } catch (error: any) {
    console.error('[API: agent/poll] Error:', error);
    const response = NextResponse.json(
      { status: 'idle', traces: [], totalTraces: 0, maxIndex: -1, finalAnswer: '', error: error.message },
      { status: 500 }
    );
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
