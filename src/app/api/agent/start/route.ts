import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import { getMainAgentModelConfig, normalizeMainAgentMode, normalizeModelThinkingCapabilities, normalizeThinkingLevelForModel } from '../../../../lib/agent/model-routing';
import {
  buildAgentBuilderPinnedContext,
  buildAgentBuilderUserRequest,
  getAgentBuilderMode,
  getAgentIdFromBuilderChatId,
  isAgentBuilderChatId,
} from '../../../../lib/agent/builder-agent';
import { buildScopedRuntimeSettings } from '../../../../lib/agent/runtime-api-keys';
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
      thinkingLevel = 'low',
      modelThinkingCapability = null,
      userId = 'default_user', 
      pinnedContext = null, 
      mediaAttachments = [], 
      userName = 'Developer',
      runId,
    } = await readJsonObject(req);
    const prompt = cleanString(rawPrompt, MAX_PROMPT_CHARS);

    if (!isSafeChatId(chatId) || !prompt) {
      return attachAgentApiSessionCookie(
        jsonError('Valid chatId and prompt are required', 400),
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
    const selectedModelConfig = getMainAgentModelConfig(safeMode, runtimeSettings);
    const safeModelThinkingCapability = normalizeModelThinkingCapabilities(modelThinkingCapability);
    const safeThinkingLevel = normalizeThinkingLevelForModel(
      thinkingLevel,
      selectedModelConfig.provider,
      selectedModelConfig.modelName,
      safeModelThinkingCapability,
    );
    const isBuilderChat = isAgentBuilderChatId(chatId);
    const builderAgentId = isBuilderChat ? getAgentIdFromBuilderChatId(chatId) : '';
    const effectivePinnedContext = {
      ...(isBuilderChat ? buildAgentBuilderPinnedContext(chatId, safePinnedContext) : safePinnedContext),
      thinkingLevel: safeThinkingLevel,
      ...(safeModelThinkingCapability ? { modelThinkingCapability: safeModelThinkingCapability } : {}),
      agentSessionId: session.sessionId,
    };
    const effectivePrompt = isBuilderChat ? buildAgentBuilderUserRequest(builderAgentId, prompt) : prompt;
    const effectiveMode = isBuilderChat ? getAgentBuilderMode(safeMode) : safeMode;

    const result = agentRegistry.startAgent(
      chatId,
      effectivePrompt,
      normalizeHistory(history),
      effectiveMode,
      safeUserId,
      effectivePinnedContext,
      normalizeMediaAttachments(mediaAttachments),
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
