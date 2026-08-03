import { NextRequest } from 'next/server';
import { AgentRunner } from '../../../../lib/agent/agent-runner';
import { buildScopedRuntimeSettings } from '../../../../lib/agent/runtime-api-keys';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';
import { resolveModelName } from '../../../../lib/agent/model-routing';
import {
  cleanString,
  isSafeAgentId,
  jsonError,
  normalizeRunnerMessages,
  readJsonObject,
  rejectCrossOrigin,
} from '../../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Standalone Agent Builder endpoint.
 *
 * This intentionally uses the same draft-aware builder runner as builder
 * chats. The old endpoint called Gemini directly without function
 * declarations, so it could only describe setup and could never persist it.
 */
export async function POST(req: NextRequest) {
  hydrateServerRuntimeSettings();
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const { messages, agentId = 'standalone-builder' } = await readJsonObject(req);
    const safeAgentId = cleanString(agentId, 96) || 'standalone-builder';
    if (!isSafeAgentId(safeAgentId)) {
      return jsonError('A valid agentId is required.', 400);
    }

    const normalized = normalizeRunnerMessages(messages);
    if (normalized.error || !normalized.messages) {
      return jsonError(normalized.error || 'Messages array is required.', 400);
    }

    const runtimeSettings = buildScopedRuntimeSettings();
    const runner = new AgentRunner();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const abortRun = () => {
          closed = true;
          runner.cancel();
        };
        req.signal.addEventListener('abort', abortRun);

        try {
          for await (const event of runner.run(normalized.messages!, {
            agentId: safeAgentId,
            runtime: 'agent_builder',
            mode: 'think',
            model: resolveModelName('think', runtimeSettings),
            preferredGeminiApiKey: runtimeSettings.preferredGeminiApiKey,
            runtimeSettings,
            chatId: `agent_builder_${safeAgentId}`,
            runLocation: 'local',
            pinnedContext: {
              agentRuntime: 'agent_builder',
              agentId: safeAgentId,
            },
          })) {
            if (closed || req.signal.aborted) break;
            if (event.type === 'text' && event.text) {
              controller.enqueue(encoder.encode(String(event.text)));
            } else if (event.type === 'error' && event.text) {
              controller.enqueue(encoder.encode(`\nAgent Builder failed: ${String(event.text).slice(0, 500)}`));
            }
          }
        } catch (error: any) {
          if (!closed) {
            controller.enqueue(encoder.encode(`\nAgent Builder failed: ${String(error?.message || error).slice(0, 500)}`));
          }
        } finally {
          req.signal.removeEventListener('abort', abortRun);
          closed = true;
          try { controller.close(); } catch { }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  } catch (error: any) {
    console.error('[AgentBuilder] Error:', error);
    return jsonError(error?.message || 'Agent Builder failed.', 500);
  }
}
