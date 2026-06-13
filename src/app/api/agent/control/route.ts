import { NextRequest, NextResponse } from 'next/server';
import { pauseAgent, resumeAgent, closeAgent, isAgentPaused, isAgentClosed, getAgentControlStates } from '@/lib/agent/roles/sub_agent';

/**
 * POST /api/agent/control
 * 
 * Controls sub-agent lifecycle: pause, resume, close, or get status.
 * 
 * Body: { action: 'pause' | 'resume' | 'close' | 'status', projectId: string, agentName?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, projectId, agentName } = body;

    if (!projectId) {
      return NextResponse.json({ success: false, error: 'projectId is required' }, { status: 400 });
    }

    switch (action) {
      case 'pause': {
        if (!agentName) {
          return NextResponse.json({ success: false, error: 'agentName is required for pause' }, { status: 400 });
        }
        const result = pauseAgent(projectId, agentName);
        return NextResponse.json({ success: true, action: 'pause', agentName, paused: result });
      }

      case 'resume': {
        if (!agentName) {
          return NextResponse.json({ success: false, error: 'agentName is required for resume' }, { status: 400 });
        }
        const result = resumeAgent(projectId, agentName);
        return NextResponse.json({ success: true, action: 'resume', agentName, resumed: result });
      }

      case 'close': {
        if (!agentName) {
          return NextResponse.json({ success: false, error: 'agentName is required for close' }, { status: 400 });
        }
        const result = closeAgent(projectId, agentName);
        return NextResponse.json({ success: true, action: 'close', agentName, closed: result });
      }

      case 'status': {
        if (agentName) {
          return NextResponse.json({
            success: true,
            action: 'status',
            agentName,
            paused: isAgentPaused(projectId, agentName),
            closed: isAgentClosed(projectId, agentName),
          });
        }
        const states = getAgentControlStates(projectId);
        return NextResponse.json({ success: true, action: 'status', agents: states });
      }

      default:
        return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error: any) {
    console.error('[Agent Control] Error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 });
  }
}
