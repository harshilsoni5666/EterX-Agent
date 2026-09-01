import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import { taskStore } from '../../../../lib/agent/task-store';
import { getPendingProxyTaskCount } from '../../../../lib/agent/autonomy/proxy-control-plane';
import { formatUnknownError } from '../../../../lib/agent/error-format';
import {
  attachAgentApiSessionCookie,
  getOrCreateAgentApiSession,
  isSafeChatId,
  isSafeRunId,
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
 * Returns new trace events since the given index. While an agent is running,
 * the UI keeps a short long-poll request open and the registry wakes it as
 * soon as a trace arrives. This is the key to UI independence:
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
    const requestedRunId = searchParams.get('runId');
    const waitMs = Math.min(7000, Math.max(0, parseInteger(searchParams.get('wait'), 0)));

    if (!isSafeChatId(chatId)) {
      return attachAgentApiSessionCookie(jsonError('chatId is required', 400), session);
    }
    if (requestedRunId && !isSafeRunId(requestedRunId)) {
      return attachAgentApiSessionCookie(jsonError('runId is invalid', 400), session);
    }

    const ownerError = requireChatOwner(chatId, session.sessionId);
    if (ownerError) {
      return attachAgentApiSessionCookie(ownerError, session);
    }

    const afterIndex = Math.max(-1, parseInteger(afterStr, -1));
    let result: any = agentRegistry.getTraces(chatId, afterIndex, requestedRunId || undefined);

    if (result.status === 'idle') {
      const persisted = await taskStore.getPollState(chatId, afterIndex);
      // A run-scoped poll must never be hydrated with another run's saved
      // snapshot. Doing so makes the first actions from a successor appear
      // beneath its predecessor (or vice versa) after a reconnect.
      if (
        persisted.status !== 'idle'
        && (!requestedRunId || persisted.runId === requestedRunId)
      ) {
        result = persisted;
      }
    }

    // Hold an otherwise empty running response briefly. This is real-time
    // long polling: traces return as soon as they exist, but an idle agent no
    // longer forces the renderer to create and parse 4-9 HTTP responses every
    // second. Agent execution remains fully independent and every chat keeps
    // its own live connection.
    if (waitMs > 0 && result.status === 'running' && (!Array.isArray(result.traces) || result.traces.length === 0)) {
      await agentRegistry.waitForTraceChange(
        chatId,
        afterIndex,
        waitMs,
        req.signal,
        requestedRunId || undefined,
      );
      let next: any = agentRegistry.getTraces(chatId, afterIndex, requestedRunId || undefined);
      // A restored run can be task-store backed until its live registry is
      // reattached. Preserve long-poll semantics for that path as well.
      if (next.status === 'idle') {
        const persisted = await taskStore.getPollState(chatId, afterIndex);
        if (
          persisted.status !== 'idle'
          && (!requestedRunId || persisted.runId === requestedRunId)
        ) next = persisted;
      }
      result = next;
    }
    result.pendingProxyTaskCount = getPendingProxyTaskCount(chatId);
    const queuedFollowUps = agentRegistry.getQueuedFollowUps(chatId);
    result.pendingFollowUpCount = queuedFollowUps.length;
    result.queuedFollowUps = queuedFollowUps;

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
    const message = formatUnknownError(error, 'Agent polling failed');
    console.error('[API: agent/poll] Error:', message);
    const response = NextResponse.json(
      { status: 'idle', traces: [], totalTraces: 0, maxIndex: -1, finalAnswer: '', error: message },
      { status: 500 }
    );
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
