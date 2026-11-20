import { NextRequest, NextResponse } from 'next/server';
import { decideToolApproval, listPendingToolApprovals, setRuntimeChatPermissionMode } from '../../../../lib/agent/tool-approval-runtime';
import { isChatPermissionMode, isToolApprovalDecision } from '../../../../lib/chat-permissions';
import {
  attachAgentApiSessionCookie, getOrCreateAgentApiSession, isSafeChatId, isSafeRunId,
  jsonError, readJsonObject, rejectCrossOrigin, requireChatOwner,
} from '../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  const chatId = req.nextUrl.searchParams.get('chatId');
  if (!isSafeChatId(chatId)) return jsonError('Invalid chat ID.', 400);
  const session = getOrCreateAgentApiSession(req);
  return attachAgentApiSessionCookie(NextResponse.json({
    pending: listPendingToolApprovals(chatId, session.sessionId),
  }, { headers: { 'Cache-Control': 'no-store' } }), session);
}

export async function PUT(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  const session = getOrCreateAgentApiSession(req);
  const { chatId, mode } = await readJsonObject(req);
  if (!isSafeChatId(chatId) || !isChatPermissionMode(mode)) {
    return attachAgentApiSessionCookie(jsonError('A valid chat ID and permission mode are required.', 400), session);
  }
  const ownerError = requireChatOwner(chatId, session.sessionId);
  if (ownerError) return attachAgentApiSessionCookie(ownerError, session);
  setRuntimeChatPermissionMode(chatId, session.sessionId, mode);
  return attachAgentApiSessionCookie(NextResponse.json({ success: true }), session);
}

export async function POST(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  const { chatId, id, decision } = await readJsonObject(req);
  if (!isSafeChatId(chatId) || !isSafeRunId(id) || !isToolApprovalDecision(decision)) {
    return jsonError('A valid chat, approval ID, and decision are required.', 400);
  }
  const session = getOrCreateAgentApiSession(req);
  const result = decideToolApproval(chatId, session.sessionId, id, decision);
  const response = result === 'accepted' ? NextResponse.json({ success: true })
    : result === 'conflict' ? jsonError('A decision was already recorded for this action.', 409)
    : jsonError('This action is no longer waiting for approval.', 404);
  return attachAgentApiSessionCookie(response, session);
}
