import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../lib/agent/agent-registry';
import { normalizeMainAgentMode } from '../../../lib/agent/model-routing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300; // Agent reasoning can take time

// Ensure tools are bootstrapped into the registry
import '../../../lib/agent/tools/index'; 

/**
 * POST /api/chat — SSE stream that delegates to AgentRegistry
 * 
 * BACKWARD COMPATIBLE: The frontend still sends the same request.
 * But now internally it:
 * 1. Starts the agent via AgentRegistry (fire-and-forget)
 * 2. Polls the registry's trace buffer and streams events via SSE
 * 3. If the SSE connection drops, the agent KEEPS RUNNING
 * 4. Frontend can reconnect via /api/agent/poll
 * 
 * This is the bridge between old SSE-based UI and new registry-based backend.
 */
export async function POST(req: NextRequest) {
  try {
    const { 
      prompt, 
      history = [], 
      mediaAttachments = [], 
      userId = 'default_user', 
      projectId = 'default_project', 
      mode = 'think', 
      pinnedContext = null, 
      userName = 'Developer' 
    } = await req.json();

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    const safeMode = normalizeMainAgentMode(mode);

    // Use projectId as chatId (they're the same in the frontend)
    const chatId = projectId;

    // Start the agent via the registry (fire-and-forget, non-blocking)
    const startResult = agentRegistry.startAgent(
      chatId,
      prompt,
      history,
      safeMode,
      userId,
      pinnedContext,
      mediaAttachments,
      userName
    );

    if (startResult.status === 'no_keys') {
      return NextResponse.json({ error: 'All API keys are in use. Try again shortly.' }, { status: 503 });
    }

    // Now stream the traces via SSE by polling the registry buffer
    const encoder = new TextEncoder();
    let lastIndex = -1;
    let sseActive = true;

    const stream = new ReadableStream({
      async start(controller) {
        const sendEvent = (data: any) => {
          try {
            if (sseActive) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            }
          } catch (e) {
            // Client likely disconnected. That's FINE — agent keeps running.
            sseActive = false;
          }
        };

        // Poll the registry buffer and stream to client
        const pollInterval = setInterval(() => {
          try {
            const result = agentRegistry.getTraces(chatId, lastIndex);

            // Send new traces
            for (const trace of result.traces) {
              sendEvent({ type: 'trace', data: trace });
            }

            // Update cursor
            if (result.maxIndex >= 0) {
              lastIndex = result.maxIndex;
            }

            // Check if done
            if (result.status !== 'running') {
              clearInterval(pollInterval);

              if (result.status === 'completed') {
                // Extract final answer from the done event or from result
                sendEvent({ type: 'done', data: { 
                  success: true, 
                  finalAnswer: result.finalAnswer,
                  taskId: chatId,
                  executionTimeMs: result.completedAt ? result.completedAt - (result.startedAt || 0) : 0,
                  artifactsGenerated: []
                }});
              } else if (result.status === 'failed') {
                sendEvent({ type: 'error', data: result.error || 'Agent failed' });
              } else if (result.status === 'stopped') {
                sendEvent({ type: 'done', data: { 
                  success: false, 
                  finalAnswer: 'Stopped by user.',
                  taskId: chatId,
                  executionTimeMs: 0,
                  artifactsGenerated: []
                }});
              }

              // Close SSE stream
              try { controller.close(); } catch {}
            }
          } catch (err) {
            // Polling error — agent keeps running, SSE just stops
            clearInterval(pollInterval);
            try { controller.close(); } catch {}
          }
        }, 100); // Poll registry every 100ms for ultra-fast SSE streaming

        // Safety: if client disconnects, stop polling (but NOT the agent)
        // The agent continues via the registry. Client can reconnect via /api/agent/poll.
        req.signal.addEventListener('abort', () => {
          sseActive = false;
          clearInterval(pollInterval);
          try { controller.close(); } catch {}
          console.log(`[ChatSSE] Client disconnected for chat ${chatId.substring(0, 8)}... — agent continues running`);
        });
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable nginx/proxy buffering
      },
    });
  } catch (error: any) {
    console.error('API Error:', error);
    return NextResponse.json(
      { error: 'Internal Agent Error', details: error.message },
      { status: 500 }
    );
  }
}
