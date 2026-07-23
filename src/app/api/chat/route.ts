import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../lib/agent/agent-registry';
import { getMainAgentModelConfig, normalizeMainAgentMode, normalizeModelThinkingCapabilities, normalizeThinkingLevelForModel } from '../../../lib/agent/model-routing';
import {
  buildAgentBuilderPinnedContext,
  buildAgentBuilderUserRequest,
  buildAgentFlowPinnedContext,
  buildCustomAgentPinnedContext,
  getAgentBuilderMode,
  getAgentIdFromBuilderChatId,
  isAgentBuilderChatId,
  loadCustomAgentProfile,
  readAgentFlowProfile,
} from '../../../lib/agent/builder-agent';
import { buildScopedRuntimeSettings } from '../../../lib/agent/runtime-api-keys';
import {
  attachAgentApiSessionCookie,
  cleanString,
  getOrCreateAgentApiSession,
  isSafeAgentId,
  isSafeChatId,
  isSafeRunId,
  jsonError,
  MAX_PROMPT_CHARS,
  normalizeHistory,
  normalizeMediaAttachments,
  readJsonObject,
  rejectCrossOrigin,
  requireChatOwner,
} from '../agent/_shared';

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
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);

    const { 
      prompt: rawPrompt, 
      history = [], 
      mediaAttachments = [], 
      userId = 'default_user', 
      projectId = 'default_project', 
      mode = 'think', 
      selectedModel = null,
      strictModelSelection = false,
      thinkingLevel = 'low',
      modelThinkingCapability = null,
      pinnedContext = null, 
      userName = 'Developer',
      runLocation = 'local',
      customAgentId = null,
      customAgentName = null,
      runId,
    } = await readJsonObject(req);
    const prompt = cleanString(rawPrompt, MAX_PROMPT_CHARS);
    const safeMediaAttachments = normalizeMediaAttachments(mediaAttachments);
    const chatId = projectId;

    if (!isSafeChatId(chatId) || (!prompt && safeMediaAttachments.length === 0)) {
      return attachAgentApiSessionCookie(
        jsonError('Valid projectId and either a prompt or attachment are required', 400),
        session,
      );
    }

    const ownerError = requireChatOwner(chatId, session.sessionId);
    if (ownerError) {
      return attachAgentApiSessionCookie(ownerError, session);
    }

    const safeMode = normalizeMainAgentMode(mode);
    const safeUserId = cleanString(userId, 120) || 'default_user';
    const safeUserName = cleanString(userName, 120) || 'Developer';
    const safePinnedContext = pinnedContext && typeof pinnedContext === 'object' && !Array.isArray(pinnedContext)
      ? pinnedContext
      : {};
    const runtimeSettings = buildScopedRuntimeSettings();
    const selectedModelConfig = getMainAgentModelConfig(safeMode, runtimeSettings);
    const requestedModelProvider = selectedModel && typeof selectedModel === 'object'
      ? String((selectedModel as any).provider || '').trim()
      : '';
    const requestedModelName = selectedModel && typeof selectedModel === 'object'
      ? String((selectedModel as any).modelId || (selectedModel as any).modelName || '').trim()
      : '';
    const exactModelName = requestedModelProvider === selectedModelConfig.provider
      && requestedModelName.length > 0
      ? requestedModelName.slice(0, 200)
      : '';
    const safeModelThinkingCapability = normalizeModelThinkingCapabilities(modelThinkingCapability);
    const safeThinkingLevel = normalizeThinkingLevelForModel(
      thinkingLevel,
      selectedModelConfig.provider,
      exactModelName || selectedModelConfig.modelName,
      safeModelThinkingCapability,
    );
    const isBuilderChat = isAgentBuilderChatId(chatId);
    const builderAgentId = isBuilderChat ? getAgentIdFromBuilderChatId(chatId) : '';
    const selectedRuntimeId = typeof customAgentId === 'string' ? customAgentId.trim() : '';
    const isCustomAgentRun = !isBuilderChat && selectedRuntimeId.length > 0;
    let effectivePinnedContext: Record<string, any> = {
      ...(isBuilderChat ? buildAgentBuilderPinnedContext(chatId, safePinnedContext) : safePinnedContext),
      thinkingLevel: safeThinkingLevel,
      ...(exactModelName ? {
        selectedModelName: exactModelName,
        selectedModelProvider: requestedModelProvider,
        strictModelSelection: strictModelSelection === true,
      } : {}),
      ...(safeModelThinkingCapability ? { modelThinkingCapability: safeModelThinkingCapability } : {}),
      agentSessionId: session.sessionId,
      runLocation: typeof runLocation === 'string' ? runLocation : 'local',
    };
    // Apply custom agent context — this makes the orchestrator load the profile
    // and Agent.ts inject the custom agent's identity into the system prompt.
    if (isCustomAgentRun) {
      if (!isSafeAgentId(selectedRuntimeId)) {
        return attachAgentApiSessionCookie(jsonError('The selected agent or flow ID is invalid.', 400), session);
      }

      const flow = await readAgentFlowProfile(selectedRuntimeId);
      if (flow.status === 'ready' && flow.steps.length > 0) {
        effectivePinnedContext = buildAgentFlowPinnedContext(flow.flowId, flow.name, effectivePinnedContext);
      } else {
        const profile = await loadCustomAgentProfile(selectedRuntimeId);
        if (!profile) {
          return attachAgentApiSessionCookie(
            jsonError('This custom agent is not ready yet. Open it in Agent Builder and finish setup first.', 409),
            session,
          );
        }
        effectivePinnedContext = buildCustomAgentPinnedContext(
          profile.agentId,
          profile.name || (typeof customAgentName === 'string' ? customAgentName : profile.agentId),
          effectivePinnedContext,
        );
      }
    }
    if (runId !== undefined && !isSafeRunId(runId)) {
      return attachAgentApiSessionCookie(jsonError('runId must be a valid identifier when provided', 400), session);
    }
    const promptWithAttachmentFallback = prompt || 'Please review the attached file or media and help me with it.';
    const effectivePrompt = isBuilderChat ? buildAgentBuilderUserRequest(builderAgentId, promptWithAttachmentFallback) : promptWithAttachmentFallback;
    const effectiveMode = isBuilderChat ? getAgentBuilderMode(safeMode) : safeMode;

    // A stopped run may still be unwinding tools and releasing its key. Wait for
    // that run-scoped cleanup so its successor cannot be affected by stale finalizers.
    await agentRegistry.waitForStoppedRunToSettle(chatId, 5000);

    // Start the agent via the registry (fire-and-forget, non-blocking)
    const startResult = agentRegistry.startAgent(
      chatId,
      effectivePrompt,
      normalizeHistory(history),
      effectiveMode,
      safeUserId,
      effectivePinnedContext,
      safeMediaAttachments,
      safeUserName,
      runtimeSettings.preferredGeminiApiKey,
      runtimeSettings,
      runId,
    );

    if (startResult.status === 'no_keys') {
      return attachAgentApiSessionCookie(jsonError('All API keys are in use. Try again shortly.', 503, startResult), session);
    }
    if (startResult.status === 'already_running') {
      return attachAgentApiSessionCookie(jsonError(startResult.message, 409, startResult), session);
    }

    // The desktop UI has a reconnectable, run-aware poller and does not consume
    // SSE trace payloads. Let it release this request immediately instead of
    // allocating another 100ms interval and long-lived connection per chat.
    // SSE remains the default for backward-compatible API clients.
    if (/\brespond-async\b/i.test(req.headers.get('prefer') || '')) {
      return attachAgentApiSessionCookie(
        NextResponse.json(startResult, {
          status: 202,
          headers: { 'Preference-Applied': 'respond-async' },
        }),
        session,
      );
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

    return attachAgentApiSessionCookie(new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable nginx/proxy buffering
      },
    }), session);
  } catch (error: any) {
    console.error('API Error:', error);
    const response = NextResponse.json(
      { error: 'Internal Agent Error', details: error.message },
      { status: 500 }
    );
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
