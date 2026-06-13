import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import { cancelAllSubAgents, cancelAgent } from '../../../../lib/agent/roles/sub_agent';
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

/**
 * POST /api/agent/stop — Stop agent for a specific chat (or all).
 * 
 * Per-chat stop: { chatId: "xxx" } → only stops that chat's agent
 * Emergency stop: { all: true, confirm: "STOP_ALL_AGENTS" } → stops ALL agents
 * 
 * This is the key independence feature: stopping Chat A doesn't kill Chat B.
 */
export async function POST(req: NextRequest) {
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);

    const body = await readJsonObject(req);
    const { chatId } = body;

    if (chatId !== undefined && chatId !== null && chatId !== '') {
      if (!isSafeChatId(chatId)) {
        return attachAgentApiSessionCookie(jsonError('Valid chatId is required.', 400), session);
      }
      const ownerError = requireChatOwner(chatId, session.sessionId);
      if (ownerError) {
        return attachAgentApiSessionCookie(ownerError, session);
      }
      // Per-chat stop
      const stopped = agentRegistry.stopAgent(chatId);
      cancelAgent(chatId); // Also set per-chat cancel flag for sub-agents
      console.log(`[API] 🛑 Stop requested for chat ${chatId.substring(0, 8)}... — ${stopped ? 'stopped' : 'not running'}`);
      return attachAgentApiSessionCookie(NextResponse.json({ success: stopped, chatId, message: stopped ? 'Agent stopped' : 'No running agent found' }), session);
    }

    if (body.all !== true || body.confirm !== 'STOP_ALL_AGENTS') {
      return attachAgentApiSessionCookie(jsonError('Global stop requires all=true and confirm="STOP_ALL_AGENTS".', 400), session);
    }

    // Emergency global stop
    agentRegistry.stopAll();
    cancelAllSubAgents();
    console.log('[API] 🛑 EMERGENCY STOP — all agents cancelled');
    return attachAgentApiSessionCookie(NextResponse.json({ success: true, message: 'All agents stopping' }), session);
  } catch (error: any) {
    const response = NextResponse.json({ success: false, error: error.message }, { status: 500 });
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
