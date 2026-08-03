import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import { getMainAgentModelConfig, normalizeMainAgentMode, normalizeModelThinkingCapabilities, normalizeThinkingLevelForModel } from '../../../../lib/agent/model-routing';
import {
  buildAgentBuilderPinnedContext,
  getAgentBuilderMode,
  getAgentIdFromBuilderChatId,
  isAgentBuilderChatId,
} from '../../../../lib/agent/builder-agent';
import { buildScopedRuntimeSettings } from '../../../../lib/agent/runtime-api-keys';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';
import { MODEL_PROVIDER_MODE, isModelProvider } from '../../../../lib/agent/model-selector-store';
import { readProxyControl, updateProxyControl } from '../../../../lib/agent/autonomy/proxy-control-plane';
import {
  attachAgentApiSessionCookie,
  cleanString,
  getOrCreateAgentApiSession,
  isSafeChatId,
  isSafeRunId,
  jsonError,
  MAX_PROMPT_CHARS,
  normalizeHistory,
  normalizeMediaAttachments,
  readJsonObject,
  rejectCrossOrigin,
  requireChatOwner,
} from '../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/agent/start — Fire-and-forget agent launch
 * 
 * Starts an agent for a specific chat. Returns immediately.
 * The agent runs in the background, fully independent of the UI.
 * The UI polls /api/agent/poll to get trace updates.
 * 
 * Body: { chatId, prompt, history, mode, userId, pinnedContext, mediaAttachments, userName }
 * Returns: { status: 'started' | 'already_running' | 'no_keys', chatId, message }
 */
export async function POST(req: NextRequest) {
  hydrateServerRuntimeSettings();
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);

    const { 
      chatId, 
      prompt: rawPrompt,
      history = [], 
      mode = 'think', 
      selectedModel = null,
      strictModelSelection = false,
      thinkingLevel = 'low',
      modelThinkingCapability = null,
      userId = 'default_user', 
      pinnedContext = null, 
      mediaAttachments = [], 
      userName = 'Developer',
      runId,
    } = await readJsonObject(req);
    const prompt = cleanString(rawPrompt, MAX_PROMPT_CHARS);
    const safeMediaAttachments = normalizeMediaAttachments(mediaAttachments);

    if (!isSafeChatId(chatId) || (!prompt && safeMediaAttachments.length === 0)) {
      return attachAgentApiSessionCookie(
        jsonError('Valid chatId and either a prompt or attachment are required', 400),
        session,
      );
    }
    if (runId !== undefined && !isSafeRunId(runId)) {
      return attachAgentApiSessionCookie(jsonError('runId must be a valid identifier when provided', 400), session);
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
    const requestedModelProvider = selectedModel && typeof selectedModel === 'object'
      ? String((selectedModel as any).provider || '').trim()
      : '';
    const requestedModelName = selectedModel && typeof selectedModel === 'object'
      ? String((selectedModel as any).modelId || (selectedModel as any).modelName || '').trim()
      : '';
    const hasValidSelectedModel = isModelProvider(requestedModelProvider) && requestedModelName.length > 0;
    const hasSelectedModelRequest = selectedModel !== null && selectedModel !== undefined;
    if (hasSelectedModelRequest && !hasValidSelectedModel) {
      return attachAgentApiSessionCookie(jsonError('The selected model is invalid. Choose a provider and exact model ID.', 400), session);
    }
    const selectedModelConfig = getMainAgentModelConfig(
      hasValidSelectedModel ? MODEL_PROVIDER_MODE[requestedModelProvider] : safeMode,
      runtimeSettings,
    );
    const exactModelName = hasValidSelectedModel
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
    const isAutonomousRun = safePinnedContext?.agentRuntime === 'autonomy_v1'
      || safePinnedContext?.autonomy?.enabled === true;
    const isGeneralRun = !isBuilderChat && !isAutonomousRun;
    if (safePinnedContext?.agentRuntime === 'autonomy_v1' || safePinnedContext?.autonomy?.enabled === true) {
      updateProxyControl(chatId, {
        enabled: safePinnedContext?.autonomy?.enabled !== false,
        intervention: safePinnedContext?.autonomy?.intervention,
        modelSelection: safePinnedContext?.autonomy?.proxyModelSelection,
      });
    }
    const proxyControl = readProxyControl(chatId);
    const effectivePinnedContext = {
      ...(isBuilderChat ? buildAgentBuilderPinnedContext(chatId, safePinnedContext) : safePinnedContext),
      ...(isGeneralRun ? {
        disableSubAgents: true,
        allowAgentSpawning: false,
      } : {}),
      ...((safePinnedContext?.agentRuntime === 'autonomy_v1' || safePinnedContext?.autonomy?.enabled === true) ? {
        autonomy: {
          ...(safePinnedContext.autonomy || {}),
          enabled: proxyControl.enabled,
          intervention: proxyControl.intervention,
          proxyModelSelection: proxyControl.modelSelection,
        },
      } : {}),
      thinkingLevel: safeThinkingLevel,
      ...(exactModelName ? {
        selectedModelName: exactModelName,
        selectedModelProvider: requestedModelProvider,
        // An exact selector entry is authoritative even if an older client
        // omitted the strict flag. Never silently replace the user's model.
        strictModelSelection: strictModelSelection === true || hasValidSelectedModel,
      } : {}),
      ...(safeModelThinkingCapability ? { modelThinkingCapability: safeModelThinkingCapability } : {}),
      agentSessionId: session.sessionId,
    };
    const promptWithAttachmentFallback = prompt || 'Please review the attached file or media and help me with it.';
    // The builder identity is already carried by the pinned runtime context.
    // Keep the user turn itself human-readable so the registry cannot echo an
    // internal routing envelope back into the visible chat transcript.
    const effectivePrompt = promptWithAttachmentFallback;
    const effectiveMode = isBuilderChat ? getAgentBuilderMode(safeMode) : safeMode;

    await agentRegistry.waitForStoppedRunToSettle(chatId, 5000);

    const result = agentRegistry.startAgent(
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

    if (result.status === 'no_keys') {
      return attachAgentApiSessionCookie(jsonError(result.message, 503, result), session);
    }
    if (result.status === 'already_running') {
      return attachAgentApiSessionCookie(jsonError(result.message, 409, result), session);
    }

    return attachAgentApiSessionCookie(NextResponse.json(result), session);
  } catch (error: any) {
    console.error('[API: agent/start] Error:', error);
    const response = NextResponse.json(
      { error: 'Failed to start agent', details: error.message },
      { status: 500 }
    );
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
