import { NextRequest, NextResponse } from 'next/server';
import { setRuntimeSwarmMode } from '../../../../lib/agent/swarm-mode';
import { attachAgentApiSessionCookie, getOrCreateAgentApiSession, isSafeChatId, jsonError, readJsonObject, rejectCrossOrigin, requireChatOwner } from '../_shared';

export async function POST(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  const session = getOrCreateAgentApiSession(req);
  const body = await readJsonObject(req);
  if (!isSafeChatId(body.chatId) || typeof body.enabled !== 'boolean') return attachAgentApiSessionCookie(jsonError('Valid chatId and enabled are required'), session);
  const ownerError = requireChatOwner(body.chatId, session.sessionId);
  if (ownerError) return attachAgentApiSessionCookie(ownerError, session);
  setRuntimeSwarmMode(body.chatId, body.enabled);
  return attachAgentApiSessionCookie(NextResponse.json({ success: true }), session);
}
