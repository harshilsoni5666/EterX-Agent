import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import { formatUnknownError } from '../../../../lib/agent/error-format';
import { resolveChatMediaForRequest } from '../../../../lib/chat-media-store';
import { normalizeMainAgentMode, normalizeModelThinkingCapabilities, normalizeThinkingLevelForModel } from '../../../../lib/agent/model-routing';
import { isModelProvider } from '../../../../lib/agent/model-selector-store';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';
import { buildScopedRuntimeSettings } from '../../../../lib/agent/runtime-api-keys';
import {
  attachAgentApiSessionCookie,
  cleanContextText,
  cleanString,
  getOrCreateAgentApiSession,
  isSafeChatId,
  isSafeRunId,
  jsonError,
  normalizeMediaAttachments,
  readJsonObject,
  rejectCrossOrigin,
  requireChatOwner,
} from '../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);
    const chatId = req.nextUrl.searchParams.get('chatId');
    if (!isSafeChatId(chatId)) {
      return attachAgentApiSessionCookie(jsonError('Valid chatId is required.', 400), session);
    }
    const ownerError = requireChatOwner(chatId, session.sessionId);
    if (ownerError) return attachAgentApiSessionCookie(ownerError, session);
    const { items, queueRevision } = agentRegistry.getQueuedFollowUpSnapshot(chatId);
    return attachAgentApiSessionCookie(NextResponse.json({
      success: true,
      chatId,
      count: items.length,
      queueRevision,
      items,
    }), session);
  } catch (error: any) {
    const response = NextResponse.json({ success: false, error: formatUnknownError(error, 'Failed to inspect queued guidance') }, { status: 500 });
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}

export async function POST(req: NextRequest) {
  const desktopAdmissionEpoch = agentRegistry.getDesktopAdmissionEpoch();
  hydrateServerRuntimeSettings();
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);
    const body = await readJsonObject(req);
    const chatId = body.chatId;
    const action = cleanString(body.action, 40).toLowerCase() || 'enqueue';
    if (!isSafeChatId(chatId)) {
      return attachAgentApiSessionCookie(jsonError('Valid chatId is required.', 400), session);
    }
    const ownerError = requireChatOwner(chatId, session.sessionId);
    if (ownerError) return attachAgentApiSessionCookie(ownerError, session);

    if (action === 'remove' || action === 'prioritize' || action === 'steer') {
      const id = cleanString(body.id, 160);
      if (!isSafeRunId(id)) {
        return attachAgentApiSessionCookie(jsonError('A valid queue item ID is required.', 400), session);
      }
      const changed = action === 'remove'
        ? agentRegistry.removeQueuedFollowUp(chatId, id)
        : action === 'steer' ? agentRegistry.steerQueuedFollowUp(chatId, id)
        : agentRegistry.prioritizeQueuedFollowUp(chatId, id);
      const { items, queueRevision } = agentRegistry.getQueuedFollowUpSnapshot(chatId);
      return attachAgentApiSessionCookie(NextResponse.json({
        success: changed,
        action,
        chatId,
        id,
        count: items.length,
        queueRevision,
        items,
      }, { status: changed ? 200 : 404 }), session);
    }

    if (action !== 'enqueue') {
      return attachAgentApiSessionCookie(jsonError('Unsupported queue action.', 400), session);
    }

    const prompt = cleanContextText(body.prompt).trim();
    const mediaAttachments = normalizeMediaAttachments(body.mediaAttachments);
    if (!prompt && mediaAttachments.length === 0) {
      return attachAgentApiSessionCookie(jsonError('A prompt or attachment is required.', 400), session);
    }
    const requestedId = body.id === undefined ? undefined : cleanString(body.id, 160);
    if (requestedId !== undefined && !isSafeRunId(requestedId)) {
      return attachAgentApiSessionCookie(jsonError('Queue item ID is invalid.', 400), session);
    }
    const resolvedMedia = await resolveChatMediaForRequest(chatId, prompt, mediaAttachments);
    const requestedCreatedAt = Number(body.createdAt);
    const selectedModel = body.selectedModel && typeof body.selectedModel === 'object' && !Array.isArray(body.selectedModel)
      ? body.selectedModel as Record<string, unknown>
      : null;
    const selectedModelProvider = String(selectedModel?.provider || '').trim();
    const selectedModelName = String(selectedModel?.modelId || selectedModel?.modelName || '').trim().slice(0, 200);
    const hasRuntimeOverride = isModelProvider(selectedModelProvider) && Boolean(selectedModelName);
    const modelThinkingCapability = hasRuntimeOverride
      ? normalizeModelThinkingCapabilities(body.modelThinkingCapability)
      : null;
    const runtimeOverride = hasRuntimeOverride
      ? {
          mode: normalizeMainAgentMode(body.mode),
          selectedModelProvider,
          selectedModelName,
          thinkingLevel: normalizeThinkingLevelForModel(
            body.thinkingLevel,
            selectedModelProvider,
            selectedModelName,
            modelThinkingCapability,
          ),
          ...(modelThinkingCapability ? { modelThinkingCapability } : {}),
          modelWireCapabilities: Array.isArray(body.modelWireCapabilities)
            ? Array.from(new Set(body.modelWireCapabilities
                .map((value: unknown) => String(value || '').trim())
                .filter(Boolean)))
                .slice(0, 100)
            : [],
          runtimeSettings: buildScopedRuntimeSettings(),
        }
      : undefined;
    const result = agentRegistry.queueUserFollowUp(
      chatId,
      prompt || 'Please review the attached file or media and help me with it.',
      resolvedMedia,
      requestedId,
      Number.isFinite(requestedCreatedAt) && requestedCreatedAt > 0
        ? requestedCreatedAt
        : undefined,
      runtimeOverride,
      undefined,
      desktopAdmissionEpoch,
    );
    const status = result.accepted ? 202 : result.status === 'queue_full' ? 429 : 409;
    const queueSnapshot = agentRegistry.getQueuedFollowUpSnapshot(chatId);
    return attachAgentApiSessionCookie(NextResponse.json({
      success: result.accepted,
      status: result.status,
      handoffPending: result.handoffPending === true,
      message: result.message,
      item: result.item,
      ...queueSnapshot,
    }, { status }), session);
  } catch (error: any) {
    const response = NextResponse.json({ success: false, error: formatUnknownError(error, 'Failed to queue guidance') }, { status: 500 });
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
