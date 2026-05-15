import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import { cancelAllSubAgents, cancelAgent } from '../../../../lib/agent/roles/sub_agent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/agent/stop — Stop agent for a specific chat (or all).
 * 
 * Per-chat stop: { chatId: "xxx" } → only stops that chat's agent
 * Emergency stop: { } → stops ALL agents
 * 
 * This is the key independence feature: stopping Chat A doesn't kill Chat B.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { chatId } = body;

    if (chatId) {
      // Per-chat stop
      const stopped = agentRegistry.stopAgent(chatId);
      cancelAgent(chatId); // Also set per-chat cancel flag for sub-agents
      console.log(`[API] 🛑 Stop requested for chat ${chatId.substring(0, 8)}... — ${stopped ? 'stopped' : 'not running'}`);
      return NextResponse.json({ success: stopped, chatId, message: stopped ? 'Agent stopped' : 'No running agent found' });
    } else {
      // Emergency global stop
      agentRegistry.stopAll();
      cancelAllSubAgents();
      console.log('[API] 🛑 EMERGENCY STOP — all agents cancelled');
      return NextResponse.json({ success: true, message: 'All agents stopping' });
    }
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
