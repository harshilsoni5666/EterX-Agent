import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';
import { parseModelEntryKey } from '../../../../lib/agent/model-selector-store';
import { attachAgentApiSessionCookie, getOrCreateAgentApiSession, isSafeChatId, jsonError, readJsonObject, rejectCrossOrigin, requireChatOwner } from '../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  const session = getOrCreateAgentApiSession(req);
  const respond = (response: NextResponse) => attachAgentApiSessionCookie(response, session);
  try {
    const body = await readJsonObject(req);
    if (!isSafeChatId(body.chatId)) return respond(jsonError('Valid chatId is required', 400));
    const ownerError = requireChatOwner(body.chatId, session.sessionId);
    if (ownerError) return respond(ownerError);
    hydrateServerRuntimeSettings();
    const model = parseModelEntryKey(body.modelSelection);
    const history = Array.isArray(body.history) ? body.history : [];
    if (history.some((message: any) => !message || !['user', 'model'].includes(message.role)
      || !Array.isArray(message.parts) || message.parts.some((part: any) => typeof part?.text !== 'string'))) {
      return respond(jsonError('Invalid chat history.', 400));
    }
    await agentRegistry.compactChat(body.chatId, body.contextCompaction,
      model ? { provider: model.provider, model: model.modelId, history } : undefined);
    return respond(NextResponse.json({ success: true }));
  } catch (error) {
    return respond(jsonError(error instanceof Error ? error.message : 'Could not compact context.', 500));
  }
}
