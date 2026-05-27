/**
 * Agent Runner API — Executes custom-built agents
 * 
 * POST /api/agents/run
 * Body: { agentId, messages: [{role, content}], model?, temperature? }
 * 
 * Streams SSE events:
 * - {"type":"text","text":"..."}
 * - {"type":"tool_call","toolName":"...","toolArgs":{}}
 * - {"type":"tool_result","toolName":"...","toolResult":{}}
 * - {"type":"status","text":"..."}
 * - {"type":"error","text":"..."}
 * - {"type":"done"}
 */
import { NextRequest } from 'next/server';
import { AgentRunner } from '../../../../lib/agent/agent-runner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { agentId, messages, model, temperature } = body;

    if (!agentId || typeof agentId !== 'string') {
      return new Response(JSON.stringify({ error: 'agentId is required' }), { status: 400 });
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'messages array is required' }), { status: 400 });
    }

    const runner = new AgentRunner();

    // Load the agent (validates it's finalized)
    try {
      await runner.loadAgent(agentId);
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message }), { status: 404 });
    }

    // Stream events back
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of runner.run(messages, {
            agentId,
            model: model || undefined,
            temperature: temperature || undefined,
          })) {
            const line = JSON.stringify(event) + '\n';
            controller.enqueue(encoder.encode(line));
          }
        } catch (err: any) {
          const errorEvent = JSON.stringify({
            type: 'error',
            text: err.message || 'Agent runner failed',
            timestamp: Date.now(),
          }) + '\n';
          controller.enqueue(encoder.encode(errorEvent));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });

  } catch (err: any) {
    console.error('[AgentRunner] Error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

/** GET /api/agents/run?agentId=xxx — Check if agent is ready */
export async function GET(req: NextRequest) {
  const agentId = req.nextUrl.searchParams.get('agentId');
  if (!agentId) {
    return new Response(JSON.stringify({ error: 'agentId param required' }), { status: 400 });
  }

  try {
    const runner = new AgentRunner();
    const profile = await runner.loadAgent(agentId);
    return Response.json({
      ready: true,
      agentId: profile.agentId,
      name: profile.name || agentId,
      mission: profile.mission,
      toolCount: profile.directMainTools.length + profile.customTools.length,
      status: profile.status,
    });
  } catch (err: any) {
    return Response.json({
      ready: false,
      agentId,
      error: err.message,
    });
  }
}
