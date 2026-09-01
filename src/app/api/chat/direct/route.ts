import { NextRequest, NextResponse } from 'next/server';
import { streamDirectChat } from '../../../../lib/chat/direct-chat';
import { buildScopedRuntimeSettings } from '../../../../lib/agent/runtime-api-keys';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';
import {
  attachAgentApiSessionCookie,
  cleanContextText,
  cleanString,
  getOrCreateAgentApiSession,
  isSafeChatId,
  jsonError,
  normalizeHistory,
  normalizeMediaAttachments,
  readJsonObject,
  rejectCrossOrigin,
  requireChatOwner,
} from '../../agent/_shared';
import { isModelProvider } from '../../../../lib/agent/model-selector-store';
import { resolveChatMediaForRequest } from '../../../../lib/chat-media-store';
import { formatUnknownError } from '../../../../lib/agent/error-format';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/chat/direct
 *
 * Isolated conversational path for the Chat selector. It deliberately does
 * not touch AgentRegistry or Agent.ts: no agent profile, agent tools,
 * orchestration, or EterX agent prompt is added here. It still uses the same
 * durable per-chat continuity and compaction transaction as Agent mode.
 */
export async function POST(req: NextRequest) {
  hydrateServerRuntimeSettings();
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;

  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);

    const {
      prompt: rawPrompt,
      history = [],
      mediaAttachments = [],
      projectId = 'default_project',
      mode = 'think',
      thinkingLevel = 'low',
      modelThinkingCapability = null,
      modelWireCapabilities = [],
      selectedModel = null,
      contextCompaction = null,
      runId = '',
    } = await readJsonObject(req);
    const prompt = cleanContextText(rawPrompt).trim();
    const chatId = String(projectId || '');
    const safeMediaAttachments = normalizeMediaAttachments(mediaAttachments);

    if (!isSafeChatId(chatId) || (!prompt && safeMediaAttachments.length === 0)) {
      return attachAgentApiSessionCookie(
        jsonError('Valid projectId and either a prompt or attachment are required', 400),
        session,
      );
    }

    const ownerError = requireChatOwner(chatId, session.sessionId);
    if (ownerError) return attachAgentApiSessionCookie(ownerError, session);

    const chatMediaAttachments = await resolveChatMediaForRequest(
      chatId,
      prompt,
      safeMediaAttachments,
    );

    const selectedProvider = String(selectedModel?.provider || '').trim();
    const selectedModelId = String(selectedModel?.modelId || selectedModel?.modelName || '').trim();
    if (!isModelProvider(selectedProvider) || !selectedModelId) {
      return attachAgentApiSessionCookie(
        jsonError('Add a concrete model from a live provider catalog and select it before sending.', 400),
        session,
      );
    }

    const encoder = new TextEncoder();
    const streamAbortController = new AbortController();
    const normalizedRunId = String(runId || '').trim().slice(0, 160) || undefined;
    let streamClosed = false;
    const forwardAbort = () => streamAbortController.abort();
    req.signal.addEventListener('abort', forwardAbort, { once: true });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const close = () => {
          if (streamClosed) return;
          streamClosed = true;
          try { controller.close(); } catch { }
        };
        const send = (event: Record<string, unknown>) => {
          if (streamAbortController.signal.aborted || streamClosed) return false;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            return true;
          } catch {
            streamClosed = true;
            return false;
          }
        };

        void streamDirectChat({
          chatId,
          prompt,
          history: normalizeHistory(history),
          mediaAttachments: chatMediaAttachments,
          mode,
          thinkingLevel: String(thinkingLevel || 'low'),
          modelThinkingCapability,
          modelWireCapabilities: Array.isArray(modelWireCapabilities)
            ? modelWireCapabilities.map(value => String(value || '').trim()).filter(Boolean).slice(0, 100)
            : [],
          selectedModel,
          contextCompaction,
          runId: normalizedRunId,
          runtimeSettings: buildScopedRuntimeSettings(),
        }, trace => send({ type: 'trace', data: trace }), streamAbortController.signal)
          .then(result => {
            send({ type: 'done', data: { success: true, ...result } });
            close();
          })
          .catch(error => {
            if (!streamAbortController.signal.aborted) {
              // Close any answer that was already rendered before a provider
              // failed. Otherwise the feed can remain permanently in a live
              // typing state even though the request has ended.
              if (normalizedRunId) {
                send({
                  type: 'trace',
                  data: {
                    type: 'answer',
                    text: '',
                    isDelta: false,
                    isStreaming: false,
                    isLiveTyping: false,
                    streamState: 'closed',
                    final: true,
                    runId: normalizedRunId,
                    turnId: normalizedRunId,
                    timestamp: Date.now(),
                  },
                });
              }
              send({ type: 'error', error: formatUnknownError(error, 'Direct chat failed.') });
            }
            close();
          })
          .finally(() => req.signal.removeEventListener('abort', forwardAbort));
      },
      cancel() {
        streamClosed = true;
        streamAbortController.abort();
        req.signal.removeEventListener('abort', forwardAbort);
      },
    });

    const response = new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
    return attachAgentApiSessionCookie(response, session);
  } catch (error: any) {
    console.error('[DirectChat] API error:', error);
    const response = NextResponse.json(
      { success: false, error: formatUnknownError(error, 'Direct chat failed.') },
      { status: 500 },
    );
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
