import { NextRequest, NextResponse } from 'next/server';
import { streamDirectChat } from '../../../../lib/chat/direct-chat';
import { buildScopedRuntimeSettings } from '../../../../lib/agent/runtime-api-keys';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';
import {
  attachAgentApiSessionCookie,
  cleanString,
  getOrCreateAgentApiSession,
  isSafeChatId,
  jsonError,
  normalizeHistory,
  normalizeMediaAttachments,
  readJsonObject,
  rejectCrossOrigin,
  requireChatOwner,
  MAX_PROMPT_CHARS,
} from '../../agent/_shared';
import { isModelProvider } from '../../../../lib/agent/model-selector-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/chat/direct
 *
 * Isolated conversational path for the Chat selector. It deliberately does
 * not touch AgentRegistry or Agent.ts: no agent profile, tools, orchestration,
 * memory injection, or EterX system prompt is added here.
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
      selectedModel = null,
      runId = '',
    } = await readJsonObject(req);
    const prompt = cleanString(rawPrompt, MAX_PROMPT_CHARS);
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

    if (selectedModel !== null && selectedModel !== undefined) {
      const provider = String(selectedModel?.provider || '').trim();
      const modelId = String(selectedModel?.modelId || selectedModel?.modelName || '').trim();
      if (!isModelProvider(provider) || !modelId) {
        return attachAgentApiSessionCookie(
          jsonError('The selected model is invalid. Choose a provider and exact model ID.', 400),
          session,
        );
      }
    }

    const encoder = new TextEncoder();
    const streamAbortController = new AbortController();
    const forwardAbort = () => streamAbortController.abort();
    req.signal.addEventListener('abort', forwardAbort, { once: true });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: Record<string, unknown>) => {
          if (streamAbortController.signal.aborted) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };

        void streamDirectChat({
          prompt,
          history: normalizeHistory(history),
          mediaAttachments: safeMediaAttachments,
          mode,
          selectedModel,
          runId: String(runId || '').trim().slice(0, 160) || undefined,
          runtimeSettings: buildScopedRuntimeSettings(),
        }, trace => send({ type: 'trace', data: trace }), streamAbortController.signal)
          .then(result => {
            send({ type: 'done', data: { success: true, ...result } });
            controller.close();
          })
          .catch(error => {
            if (!streamAbortController.signal.aborted) {
              send({ type: 'error', error: String(error?.message || error || 'Direct chat failed.') });
              controller.close();
            } else {
              try { controller.close(); } catch { }
            }
          })
          .finally(() => req.signal.removeEventListener('abort', forwardAbort));
      },
      cancel() {
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
      { success: false, error: String(error?.message || error || 'Direct chat failed.') },
      { status: 500 },
    );
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
