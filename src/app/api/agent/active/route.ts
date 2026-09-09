import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import { attachAgentApiSessionCookie, getOrCreateAgentApiSession, isChatOwnedBySession, rejectCrossOrigin } from '../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Discover work still owned by this server after a renderer restart. This
// reads metadata only; recovery fetches each transcript independently.
export async function GET(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  const session = getOrCreateAgentApiSession(req);
  const agents = agentRegistry.getAllStatus().filter(agent => isChatOwnedBySession(agent.chatId, session.sessionId));
  return attachAgentApiSessionCookie(NextResponse.json({ agents }, {
    headers: { 'Cache-Control': 'no-store' },
  }), session);
}
