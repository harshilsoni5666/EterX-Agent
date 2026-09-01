import { NextRequest, NextResponse } from 'next/server';
import { globalSubAgentSpawner } from '@/lib/agent/roles/sub_agent';
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

const readStringList = (value: unknown, maxItems = 20): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .slice(0, maxItems)
    .map(item => cleanString(item, 500))
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
};

/** Direct human-to-subagent guidance. This is not an inter-agent mailbox. */
export async function POST(request: NextRequest) {
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(request);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(request);
    const body = await readJsonObject(request);
    const projectId = cleanString(body.projectId, 180);
    const agentName = cleanString(body.agentName, 120);
    const agentId = cleanString(body.agentId, 240);
    const messageId = cleanString(body.messageId, 240);
    const text = typeof body.text === 'string'
      ? body.text.replace(/\u0000/g, '').trim()
      : '';
    const requestedCreatedAt = Number(body.createdAt);

    if (!isSafeChatId(projectId)) {
      return attachAgentApiSessionCookie(jsonError('Valid projectId is required', 400), session);
    }
    const ownerError = requireChatOwner(projectId, session.sessionId);
    if (ownerError) return attachAgentApiSessionCookie(ownerError, session);
    if (!agentName || !agentId || !text) {
      return attachAgentApiSessionCookie(jsonError('agentName, agentId, and text are required', 400), session);
    }

    const result = globalSubAgentSpawner.sendDirectUserMessage(projectId, agentName, agentId, {
      id: messageId || `direct_${ Date.now() }`,
      text,
      timestamp: Number.isSafeInteger(requestedCreatedAt) && requestedCreatedAt > 0
        ? requestedCreatedAt
        : Date.now(),
      filePaths: readStringList(body.filePaths),
      requestedModelSelection: cleanString(body.requestedModelSelection, 360) || undefined,
      requestedModelProvider: cleanString(body.requestedModelProvider, 80) || undefined,
      requestedModelName: cleanString(body.requestedModelName, 240) || undefined,
      requestedMode: cleanString(body.requestedMode, 40) as any || undefined,
      requestedThinkingLevel: cleanString(body.requestedThinkingLevel, 20) as any || undefined,
    });
    if (!result.success) {
      return attachAgentApiSessionCookie(jsonError(result.error || 'Subagent is unavailable', 409), session);
    }
    return attachAgentApiSessionCookie(NextResponse.json({
      success: true,
      messageId: result.messageId,
      agentName,
      agentId,
    }), session);
  } catch (error: any) {
    const response = NextResponse.json({ success: false, error: error?.message || 'Failed to send direct guidance' }, { status: 500 });
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
