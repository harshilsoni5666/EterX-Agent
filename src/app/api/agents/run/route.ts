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
import { readAgentFlowProfile } from '../../../../lib/agent/builder-agent';
import { buildScopedRuntimeSettings } from '../../../../lib/agent/runtime-api-keys';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';
import { resolveModelName, normalizeMainAgentMode } from '../../../../lib/agent/model-routing';
import {
  attachAgentApiSessionCookie,
  cleanString,
  getOrCreateAgentApiSession,
  isSafeAgentId,
  isSafeChatId,
  jsonError,
  normalizeRunnerMessages,
  readJsonObject,
  rejectCrossOrigin,
  requireChatOwner,
} from '../../agent/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const isGoogleGenAIModelName = (value: string) => /^(?:models\/)?gemini[-_]/i.test(value.trim());

export async function POST(req: NextRequest) {
  hydrateServerRuntimeSettings();
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);
    const activeSession = session;

    const body = await readJsonObject(req);
    const { agentId, messages, model, mode, temperature, runLocation, pinnedContext } = body;

    if (!isSafeAgentId(agentId)) {
      return attachAgentApiSessionCookie(jsonError('A valid agentId is required.', 400), session);
    }

    const chatId = isSafeChatId(body.chatId)
      ? body.chatId
      : `custom-agent-${agentId}-${Date.now().toString(36)}`;
    const ownerError = requireChatOwner(chatId, activeSession.sessionId);
    if (ownerError) return attachAgentApiSessionCookie(ownerError, session);
    const agentSessionId = activeSession.sessionId;

    const normalized = normalizeRunnerMessages(messages);
    if (normalized.error || !normalized.messages) {
      return attachAgentApiSessionCookie(jsonError(normalized.error || 'Invalid messages payload.', 400), session);
    }

    const runtimeSettings = buildScopedRuntimeSettings();
    const safeMode = normalizeMainAgentMode(mode);
    const requestedModel = cleanString(model, 160);
    // This endpoint is intentionally Gemini-only. The desktop client routes
    // external/local custom-agent runs through /api/chat, where the main
    // provider-aware runtime preserves the selected provider and model. Do
    // not silently reinterpret a caller's provider as Gemini here.
    if (safeMode !== 'think' && safeMode !== 'fast') {
      return attachAgentApiSessionCookie(
        jsonError('The dedicated custom-agent runner supports Gemini only; use the main agent runtime for this provider.', 400),
        session,
      );
    }
    if (requestedModel && !isGoogleGenAIModelName(requestedModel)) {
      return attachAgentApiSessionCookie(
        jsonError('The dedicated custom-agent runner requires a Gemini model; use the main agent runtime for this provider.', 400),
        session,
      );
    }
    const geminiRunnerMode = safeMode;
    const fallbackGeminiModel = resolveModelName(geminiRunnerMode as any, runtimeSettings);
    const safeModel = requestedModel && isGoogleGenAIModelName(requestedModel)
      ? requestedModel
      : fallbackGeminiModel;
    const requestedTemperature = temperature === undefined ? undefined : Number(temperature);
    if (requestedTemperature !== undefined && (!Number.isFinite(requestedTemperature) || requestedTemperature < 0 || requestedTemperature > 2)) {
      return attachAgentApiSessionCookie(jsonError('temperature must be a number between 0 and 2.', 400), session);
    }
    const safeTemperature = requestedTemperature;

    const runner = new AgentRunner();

    // A selection can be either one finalized custom agent or a finalized
    // multi-agent flow. Flows deliberately have no agent profile, so detect
    // them before attempting the single-agent loader.
    let selectedFlow: Awaited<ReturnType<typeof readAgentFlowProfile>> | null = null;
    try {
      const flow = await readAgentFlowProfile(agentId);
      if (flow.status === 'ready' && flow.steps.length > 0) selectedFlow = flow;
    } catch (err: any) {
      // No flow profile exists for this identifier; it may still be an agent.
    }

    if (!selectedFlow) {
      try {
        await runner.loadAgent(agentId);
      } catch (err: any) {
        return attachAgentApiSessionCookie(jsonError(err.message || 'Agent or flow is not ready.', 404), session);
      }
    }

    // Stream events back
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const abortRun = () => {
          closed = true;
          runner.cancel();
        };
        const writeEvent = (event: any) => {
          if (closed) return false;
          try {
            controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
            return true;
          } catch {
            closed = true;
            runner.cancel();
            return false;
          }
        };

        req.signal.addEventListener('abort', abortRun);

        try {
          for await (const event of runner.run(normalized.messages!, {
            agentId,
            mode: geminiRunnerMode as any,
            model: safeModel,
            temperature: safeTemperature,
            preferredGeminiApiKey: runtimeSettings.preferredGeminiApiKey,
            runtimeSettings,
            chatId,
            agentSessionId,
            runLocation: typeof runLocation === 'string' ? runLocation : 'local',
            pinnedContext,
          })) {
            if (closed || req.signal.aborted) {
              runner.cancel();
              break;
            }

            if (!writeEvent(event)) break;
          }
        } catch (err: any) {
          writeEvent({
            type: 'error',
            text: err.message || 'Agent runner failed',
            timestamp: Date.now(),
          });
        } finally {
          req.signal.removeEventListener('abort', abortRun);
          closed = true;
          try { controller.close(); } catch { }
        }
      },
    });

    return attachAgentApiSessionCookie(new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    }), session);

  } catch (err: any) {
    console.error('[AgentRunner] Error:', err);
    const response = jsonError(err.message || 'Agent runner failed', 500);
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}

/** GET /api/agents/run?agentId=xxx — Check if agent is ready */
export async function GET(req: NextRequest) {
  const agentId = req.nextUrl.searchParams.get('agentId');
  if (!isSafeAgentId(agentId)) {
    return jsonError('A valid agentId param is required.', 400);
  }

  try {
    const runner = new AgentRunner();
    const flow = await readAgentFlowProfile(agentId);
    if (flow.status === 'ready' && flow.steps.length > 0) {
      return Response.json({
        ready: true,
        kind: 'flow',
        agentId: flow.flowId,
        name: flow.name || flow.flowId,
        mission: flow.description,
        toolCount: 0,
        stepCount: flow.steps.length,
        status: flow.status,
      });
    }
    const profile = await runner.loadAgent(agentId);
    return Response.json({
      ready: true,
      kind: 'agent',
      agentId: profile.agentId,
      name: profile.name || agentId,
      mission: profile.mission,
      toolCount: (profile.directMainTools?.length || 0) + (profile.customTools?.length || 0),
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
