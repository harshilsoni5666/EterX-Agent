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
import { buildScopedRuntimeSettings } from '../../../../lib/agent/runtime-api-keys';
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
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);
    const activeSession = session;

    const body = await readJsonObject(req);
    const { agentId, messages, model, mode, temperature, apiKeys, modelOverrides, runLocation, pinnedContext } = body;

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

    const runtimeSettings = buildScopedRuntimeSettings(apiKeys, modelOverrides);
    const safeMode = normalizeMainAgentMode(mode);
    // The custom agent runner only supports Gemini via GoogleGenAI.
    // If the user's selected provider is non-Gemini (mistral/openai/anthropic/groq/openrouter),
    // we map to the equivalent Gemini mode so the runner always gets a valid Gemini model name.
    const GEMINI_MODES = new Set<string>(['think', 'fast']);
    const geminiRunnerMode = GEMINI_MODES.has(safeMode) ? safeMode : 'think';
    const requestedModel = cleanString(model, 160);
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

    // Load the agent (validates it's finalized)
    try {
      await runner.loadAgent(agentId);
    } catch (err: any) {
      return attachAgentApiSessionCookie(jsonError(err.message || 'Agent is not ready.', 404), session);
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
    const profile = await runner.loadAgent(agentId);
    return Response.json({
      ready: true,
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
