import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import {
  attachAgentApiSessionCookie,
  getOrCreateAgentApiSession,
  isSafeChatId,
  jsonError,
  readJsonObject,
  rejectCrossOrigin,
  requireChatOwner,
} from '../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);
    const body = await readJsonObject(req);
    const chatId = typeof body.chatId === 'string' ? body.chatId : '';
    const action = body.action;
    const level = body.level;
    if (!isSafeChatId(chatId)) return attachAgentApiSessionCookie(jsonError('Valid chatId is required', 400), session);
    const ownerError = requireChatOwner(chatId, session.sessionId);
    if (ownerError) return attachAgentApiSessionCookie(ownerError, session);
    if (!['pause', 'resume', 'intervention'].includes(String(action))) {
      return attachAgentApiSessionCookie(jsonError('Unknown proxy action', 400), session);
    }
    if (action === 'intervention' && !['minimal', 'normal', 'high'].includes(String(level))) {
      return attachAgentApiSessionCookie(jsonError('Invalid intervention level', 400), session);
    }
    const success = agentRegistry.controlUserProxy(chatId, action as any, level as any);
    return attachAgentApiSessionCookie(NextResponse.json({ success, action, level }), session);
  } catch (error: any) {
    const response = NextResponse.json({ success: false, error: error?.message || 'Internal error' }, { status: 500 });
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
