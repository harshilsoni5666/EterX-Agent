import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import { resolveChatMediaForRequest } from '../../../../lib/chat-media-store';
import {
  attachAgentApiSessionCookie,
  cleanString,
  getOrCreateAgentApiSession,
  isSafeChatId,
  isSafeRunId,
  jsonError,
  MAX_PROMPT_CHARS,
  normalizeMediaAttachments,
  readJsonObject,
  rejectCrossOrigin,
  requireChatOwner,
} from '../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);
    const chatId = req.nextUrl.searchParams.get('chatId');
    if (!isSafeChatId(chatId)) {
      return attachAgentApiSessionCookie(jsonError('Valid chatId is required.', 400), session);
    }
    const ownerError = requireChatOwner(chatId, session.sessionId);
    if (ownerError) return attachAgentApiSessionCookie(ownerError, session);
    const items = agentRegistry.getQueuedFollowUps(chatId);
    return attachAgentApiSessionCookie(NextResponse.json({
      success: true,
      chatId,
      count: items.length,
      items,
    }), session);
  } catch (error: any) {
    const response = NextResponse.json({ success: false, error: error.message }, { status: 500 });
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}

export async function POST(req: NextRequest) {
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);
    const body = await readJsonObject(req);
    const chatId = body.chatId;
    const action = cleanString(body.action, 40).toLowerCase() || 'enqueue';
    if (!isSafeChatId(chatId)) {
      return attachAgentApiSessionCookie(jsonError('Valid chatId is required.', 400), session);
    }
    const ownerError = requireChatOwner(chatId, session.sessionId);
    if (ownerError) return attachAgentApiSessionCookie(ownerError, session);

    if (action === 'remove' || action === 'prioritize') {
      const id = cleanString(body.id, 160);
      if (!isSafeRunId(id)) {
        return attachAgentApiSessionCookie(jsonError('A valid queue item ID is required.', 400), session);
      }
      const changed = action === 'remove'
        ? agentRegistry.removeQueuedFollowUp(chatId, id)
        : agentRegistry.prioritizeQueuedFollowUp(chatId, id);
      const items = agentRegistry.getQueuedFollowUps(chatId);
      return attachAgentApiSessionCookie(NextResponse.json({
        success: changed,
        action,
        chatId,
        id,
        count: items.length,
        items,
      }, { status: changed ? 200 : 404 }), session);
    }

    if (action !== 'enqueue') {
      return attachAgentApiSessionCookie(jsonError('Unsupported queue action.', 400), session);
    }

    const prompt = cleanString(body.prompt, MAX_PROMPT_CHARS);
    const mediaAttachments = normalizeMediaAttachments(body.mediaAttachments);
    if (!prompt && mediaAttachments.length === 0) {
      return attachAgentApiSessionCookie(jsonError('A prompt or attachment is required.', 400), session);
    }
    const requestedId = body.id === undefined ? undefined : cleanString(body.id, 160);
    if (requestedId !== undefined && !isSafeRunId(requestedId)) {
      return attachAgentApiSessionCookie(jsonError('Queue item ID is invalid.', 400), session);
    }
    const resolvedMedia = await resolveChatMediaForRequest(chatId, prompt, mediaAttachments);
    const result = agentRegistry.queueUserFollowUp(
      chatId,
      prompt || 'Please review the attached file or media and help me with it.',
      resolvedMedia,
      requestedId,
    );
    const status = result.accepted ? 202 : result.status === 'queue_full' ? 429 : 409;
    return attachAgentApiSessionCookie(NextResponse.json({
      success: result.accepted,
      status: result.status,
      message: result.message,
      item: result.item,
      items: agentRegistry.getQueuedFollowUps(chatId),
    }, { status }), session);
  } catch (error: any) {
    const response = NextResponse.json({ success: false, error: error.message }, { status: 500 });
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
