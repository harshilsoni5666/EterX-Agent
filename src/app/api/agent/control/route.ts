import { NextRequest, NextResponse } from 'next/server';
import { pauseAgent, resumeAgent, closeAgent, isAgentPaused, isAgentClosed, getAgentControlStates } from '@/lib/agent/roles/sub_agent';
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

/**
 * POST /api/agent/control
 * 
 * Controls sub-agent lifecycle: pause, resume, close, or get status.
 * 
 * Body: { action: 'pause' | 'resume' | 'close' | 'status', projectId: string, agentName?: string }
 */
export async function POST(req: NextRequest) {
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);
    const body = await readJsonObject(req);
    const action = cleanString(body.action, 32);
    const projectId = cleanString(body.projectId, 180);
    const agentName = cleanString(body.agentName, 80);
    const agentId = cleanString(body.agentId, 240);

    if (!isSafeChatId(projectId)) {
      return attachAgentApiSessionCookie(jsonError('Valid projectId is required', 400), session);
    }
    const ownerError = requireChatOwner(projectId, session.sessionId);
    if (ownerError) return attachAgentApiSessionCookie(ownerError, session);

    switch (action) {
      case 'pause': {
        if (!agentName) {
          return attachAgentApiSessionCookie(jsonError('agentName is required for pause', 400), session);
        }
        const result = pauseAgent(projectId, agentName, undefined, agentId || undefined);
        return attachAgentApiSessionCookie(NextResponse.json({ success: result, action: 'pause', agentName, agentId: agentId || undefined, paused: result }), session);
      }

      case 'resume': {
        if (!agentName) {
          return attachAgentApiSessionCookie(jsonError('agentName is required for resume', 400), session);
        }
        const result = resumeAgent(projectId, agentName, undefined, agentId || undefined);
        return attachAgentApiSessionCookie(NextResponse.json({ success: result, action: 'resume', agentName, agentId: agentId || undefined, resumed: result }), session);
      }

      case 'close': {
        if (!agentName) {
          return attachAgentApiSessionCookie(jsonError('agentName is required for close', 400), session);
        }
        const result = closeAgent(projectId, agentName, undefined, agentId || undefined);
        return attachAgentApiSessionCookie(NextResponse.json({ success: result, action: 'close', agentName, agentId: agentId || undefined, closed: result }), session);
      }

      case 'status': {
        if (agentName) {
          return attachAgentApiSessionCookie(NextResponse.json({
            success: true,
            action: 'status',
            agentName,
            paused: isAgentPaused(projectId, agentName, agentId || undefined),
            closed: isAgentClosed(projectId, agentName, agentId || undefined),
          }), session);
        }
        const states = getAgentControlStates(projectId);
        return attachAgentApiSessionCookie(NextResponse.json({ success: true, action: 'status', agents: states }), session);
      }

      default:
        return attachAgentApiSessionCookie(jsonError(`Unknown action: ${action}`, 400), session);
    }
  } catch (error: any) {
    console.error('[Agent Control] Error:', error);
    const response = NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 });
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
