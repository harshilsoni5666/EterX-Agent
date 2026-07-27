import { NextRequest, NextResponse } from 'next/server';
import { getProxyManagerHistory, talkToProxyManager } from '../../../../lib/agent/autonomy/proxy-manager-runtime';
import { isModelProvider } from '../../../../lib/agent/model-selector-store';
import { readProxyControl } from '../../../../lib/agent/autonomy/proxy-control-plane';
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
export const maxDuration = 180;

export async function GET(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  const session = getOrCreateAgentApiSession(req);
  const chatId = req.nextUrl.searchParams.get('chatId') || '';
  if (!isSafeChatId(chatId)) return attachAgentApiSessionCookie(jsonError('Valid chatId is required', 400), session);
  const ownerError = requireChatOwner(chatId, session.sessionId);
  if (ownerError) return attachAgentApiSessionCookie(ownerError, session);
  return attachAgentApiSessionCookie(NextResponse.json({
    success: true,
    messages: getProxyManagerHistory(chatId),
    control: readProxyControl(chatId),
    context: agentRegistry.getProxyManagerContext(chatId),
  }), session);
}

export async function POST(req: NextRequest) {
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);
    const body = await readJsonObject(req);
    const chatId = typeof body.chatId === 'string' ? body.chatId : '';
    const message = cleanString(body.message, 12000);
    if (!isSafeChatId(chatId)) return attachAgentApiSessionCookie(jsonError('Valid chatId is required', 400), session);
    const ownerError = requireChatOwner(chatId, session.sessionId);
    if (ownerError) return attachAgentApiSessionCookie(ownerError, session);
    if (!message) return attachAgentApiSessionCookie(jsonError('message is required', 400), session);

    const provider = isModelProvider(body?.model?.provider) ? body.model.provider : undefined;
    const modelId = cleanString(body?.model?.modelId, 220);
    const result = await talkToProxyManager({ chatId, message, model: { provider, modelId } });
    return attachAgentApiSessionCookie(NextResponse.json({
      success: true,
      ...result,
      context: agentRegistry.getProxyManagerContext(chatId),
    }), session);
  } catch (error: any) {
    const response = NextResponse.json({ success: false, error: error?.message || 'Proxy Manager failed' }, { status: 500 });
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
