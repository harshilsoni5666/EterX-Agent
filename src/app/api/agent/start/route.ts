import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import { formatUnknownError } from '../../../../lib/agent/error-format';
import { normalizeMainAgentMode, normalizeModelThinkingCapabilities, normalizeThinkingLevelForModel } from '../../../../lib/agent/model-routing';
import {
  buildAgentBuilderPinnedContext,
  getAgentBuilderMode,
  getAgentIdFromBuilderChatId,
  isAgentBuilderChatId,
} from '../../../../lib/agent/builder-agent';
import { buildScopedRuntimeSettings } from '../../../../lib/agent/runtime-api-keys';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';
import { isModelProvider } from '../../../../lib/agent/model-selector-store';
import { readProxyControl, updateProxyControl } from '../../../../lib/agent/autonomy/proxy-control-plane';
import {
  attachAgentApiSessionCookie,
  cleanContextText,
  cleanString,
  getOrCreateAgentApiSession,
  isSafeChatId,
  isSafeRunId,
  jsonError,
  normalizeHistory,
  normalizeMediaAttachments,
  readJsonObject,
  rejectCrossOrigin,
  requireChatOwner,
} from '../_shared';
import { resolveChatMediaForRequest } from '../../../../lib/chat-media-store';

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
      modelWireCapabilities = [],
      userId = 'default_user', 
      pinnedContext = null, 
      mediaAttachments = [], 
      userName = 'Developer',
      runId,
    } = await readJsonObject(req);
    const prompt = cleanContextText(rawPrompt).trim();
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

    const chatMediaAttachments = await resolveChatMediaForRequest(
      chatId,
      prompt,
      safeMediaAttachments,
    );

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
    if (!hasSelectedModelRequest || !hasValidSelectedModel) {
      return attachAgentApiSessionCookie(jsonError('Add a concrete model from a live provider catalog and select it before starting an agent.', 400), session);
    }
    const exactModelName = requestedModelName.slice(0, 200);
    const safeModelThinkingCapability = normalizeModelThinkingCapabilities(modelThinkingCapability);
    const safeModelWireCapabilities = Array.isArray(modelWireCapabilities)
      ? Array.from(new Set(modelWireCapabilities.map((value: unknown) => String(value || '').trim()).filter(Boolean))).slice(0, 100)
      : [];
    const safeThinkingLevel = normalizeThinkingLevelForModel(
      thinkingLevel,
      requestedModelProvider,
      exactModelName,
      safeModelThinkingCapability,
    );
    const isBuilderChat = isAgentBuilderChatId(chatId);
    const builderAgentId = isBuilderChat ? getAgentIdFromBuilderChatId(chatId) : '';
    const hasExplicitAutonomySelection = typeof safePinnedContext?.autonomy?.enabled === 'boolean';
    const hasAutonomyContext = safePinnedContext?.agentRuntime === 'autonomy_v1' || hasExplicitAutonomySelection;
    if (hasAutonomyContext) {
      updateProxyControl(chatId, {
        // Preserve the user's explicit off state. Autonomy must never be
        // inferred merely because a stale control record exists for the chat.
        enabled: safePinnedContext?.autonomy?.enabled === true,
        intervention: safePinnedContext?.autonomy?.intervention,
        modelSelection: safePinnedContext?.autonomy?.proxyModelSelection,
      });
    }
    const proxyControl = readProxyControl(chatId);
    const effectivePinnedContext = {
      ...(isBuilderChat ? buildAgentBuilderPinnedContext(chatId, safePinnedContext) : safePinnedContext),
      ...(hasAutonomyContext ? {
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
      ...(safeModelWireCapabilities.length > 0 ? { modelWireCapabilities: safeModelWireCapabilities } : {}),
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
      chatMediaAttachments,
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
    if (result.status === 'cancelled') {
      return attachAgentApiSessionCookie(jsonError(result.message, 409, result), session);
    }

    return attachAgentApiSessionCookie(NextResponse.json(result), session);
  } catch (error: any) {
    console.error('[API: agent/start] Error:', error);
    const response = NextResponse.json(
      { error: 'Failed to start agent', details: formatUnknownError(error, 'Failed to start agent') },
      { status: 500 }
    );
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
