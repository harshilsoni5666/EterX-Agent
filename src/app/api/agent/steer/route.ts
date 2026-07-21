import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import {
  attachAgentApiSessionCookie,
  cleanString,
  getOrCreateAgentApiSession,
  isSafeChatId,
  jsonError,
  readJsonObject,
  rejectCrossOrigin,
  requireChatOwner,
} from '../_shared';

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
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);

    const body = await readJsonObject(req);
    const { chatId, message, id } = body as { chatId?: string; message?: string; id?: string };
    const cleanMessage = cleanString(message, 8000);
    const cleanId = id === undefined ? undefined : cleanString(id, 120);

    if (!isSafeChatId(chatId)) {
      return attachAgentApiSessionCookie(jsonError('Valid chatId is required', 400, { reason: 'Valid chatId is required' }), session);
    }
    const ownerError = requireChatOwner(chatId, session.sessionId);
    if (ownerError) {
      return attachAgentApiSessionCookie(ownerError, session);
    }
    if (!cleanMessage) {
      return attachAgentApiSessionCookie(jsonError('message must be a non-empty string', 400, { reason: 'message must be a non-empty string' }), session);
    }
    if (id !== undefined && !cleanId) {
      return attachAgentApiSessionCookie(jsonError('id must be a valid string when provided', 400, { reason: 'id must be a valid string when provided' }), session);
    }

    const queued = agentRegistry.addSteeringMessage(chatId, cleanMessage, cleanId);

    if (!queued) {
      const stillRunning = agentRegistry.isRunning(chatId);
      return attachAgentApiSessionCookie(NextResponse.json(
        {
          success: false,
          reason: stillRunning
            ? 'The live steering queue is full. The message was not queued and remains available in the composer.'
            : 'No running agent found for this chat. The message was not queued.',
        },
        { status: stillRunning ? 429 : 409 }
      ), session);
    }

    console.log(`[API/steer] 🧭 Steering queued for chat ${chatId.substring(0, 8)}...`);
    return attachAgentApiSessionCookie(NextResponse.json({ success: true, message: 'Steering message queued' }), session);
  } catch (error: any) {
    const response = NextResponse.json({ success: false, error: error.message }, { status: 500 });
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
