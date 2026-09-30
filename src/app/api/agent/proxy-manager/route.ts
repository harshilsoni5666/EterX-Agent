import { NextRequest, NextResponse } from 'next/server';
import { getProxyManagerHistory, isProxyManagerBusy, talkToProxyManager } from '../../../../lib/agent/autonomy/proxy-manager-runtime';
import { resolveChatMediaForRequest } from '../../../../lib/chat-media-store';
import { hydrateServerRuntimeSettings } from '../../../../lib/agent/server-runtime-hydration';
import { isModelProvider } from '../../../../lib/agent/model-selector-store';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import {
  attachAgentApiSessionCookie,
  cleanString,
  getOrCreateAgentApiSession,
  isSafeChatId,
  isSafeRunId,
  normalizeMediaAttachments,
  jsonError,
  readJsonObject,
  rejectCrossOrigin,
  requireChatOwner,
} from '../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 180;

export async function GET(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  const session = getOrCreateAgentApiSession(req);
  const chatId = req.nextUrl.searchParams.get('chatId') || '';
  if (!isSafeChatId(chatId)) return attachAgentApiSessionCookie(jsonError('Valid chatId is required', 400), session);
  const ownerError = requireChatOwner(chatId, session.sessionId);
  if (ownerError) return attachAgentApiSessionCookie(ownerError, session);
  const context = agentRegistry.getProxyManagerContext(chatId);
  return attachAgentApiSessionCookie(NextResponse.json({
    success: true,
    messages: getProxyManagerHistory(chatId, req.nextUrl.searchParams.get('afterMessageId') || undefined),
    processing: isProxyManagerBusy(chatId),
    control: {
      enabled: context.proxyControl.enabled,
      paused: context.proxyControl.paused,
      intervention: context.proxyControl.intervention,
      modelSelection: context.proxyControl.modelSelection,
      updatedAt: context.proxyControl.updatedAt,
    },
    context,
  }), session);
}

export async function POST(req: NextRequest) {
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);
    const body = await readJsonObject(req);
    const chatId = typeof body.chatId === 'string' ? body.chatId : '';
    const message = typeof body.message === 'string'
      ? body.message.replace(/\u0000/g, '').trim()
      : '';
    const attachmentContext = typeof body.attachmentContext === 'string'
      ? body.attachmentContext.replace(/\u0000/g, '')
      : '';
    if (!isSafeChatId(chatId)) return attachAgentApiSessionCookie(jsonError('Valid chatId is required', 400), session);
    const ownerError = requireChatOwner(chatId, session.sessionId);
    if (ownerError) return attachAgentApiSessionCookie(ownerError, session);
    if (!message) return attachAgentApiSessionCookie(jsonError('message is required', 400), session);
    if (body.requestId !== undefined && !isSafeRunId(body.requestId)) {
      return attachAgentApiSessionCookie(jsonError('A valid requestId is required', 400), session);
    }
    hydrateServerRuntimeSettings();
    const mediaAttachments = await resolveChatMediaForRequest(`${chatId}::proxy-manager`, message, normalizeMediaAttachments(body.mediaAttachments));
    const requestId = typeof body.requestId === 'string' ? body.requestId : undefined;

    const provider = isModelProvider(body?.model?.provider) ? body.model.provider : undefined;
    const modelId = cleanString(body?.model?.modelId, 220);
    const mainModel = isModelProvider(body?.mainModel?.provider) && cleanString(body?.mainModel?.modelId, 220)
      ? { provider: body.mainModel.provider, modelId: cleanString(body.mainModel.modelId, 220) }
      : undefined;
    const contextCompaction = body?.contextCompaction && typeof body.contextCompaction === 'object'
      ? body.contextCompaction
      : undefined;
    if (body.stream === true) {
      const encoder = new TextEncoder();
      let closeStream = () => {};
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          let heartbeat: ReturnType<typeof setInterval> | undefined;
          const close = () => {
            if (closed) return;
            closed = true;
            if (heartbeat) clearInterval(heartbeat);
            req.signal.removeEventListener('abort', close);
            try { controller.close(); } catch { }
          };
          closeStream = close;
          const send = (event: Record<string, any>) => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            } catch {
              close();
            }
          };
          req.signal.addEventListener('abort', close, { once: true });
          if (req.signal.aborted) close();
          if (!closed) {
            heartbeat = setInterval(() => send({ type: 'heartbeat', timestamp: Date.now() }), 15_000);
            heartbeat.unref?.();
          }
          send({ type: 'accepted', chatId, requestId, timestamp: Date.now() });
          talkToProxyManager({
            chatId,
            message,
            requestId,
            mediaAttachments,
            attachmentContext,
            model: { provider, modelId },
            mainModel,
            contextCompaction,
            onProgress: progress => send({ type: 'progress', progress }),
          }).then(result => {
            send({
              type: 'complete',
              result,
              context: agentRegistry.getProxyManagerContext(chatId),
            });
          }).catch((error: any) => {
            send({ type: 'error', error: error?.message || 'Proxy Manager failed' });
          }).finally(close);
        },
        // The accepted turn continues independently and is recovered via GET.
        cancel() { closeStream(); },
      });
      return attachAgentApiSessionCookie(new NextResponse(stream, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, no-transform',
          'Content-Encoding': 'identity',
          'X-Content-Type-Options': 'nosniff',
          'X-Accel-Buffering': 'no',
        },
      }), session);
    }
    const result = await talkToProxyManager({
      chatId,
      message,
      requestId,
      mediaAttachments,
      attachmentContext,
      model: { provider, modelId },
      mainModel,
      contextCompaction,
    });
    return attachAgentApiSessionCookie(NextResponse.json({
      success: true,
      ...result,
      context: agentRegistry.getProxyManagerContext(chatId),
    }), session);
  } catch (error: any) {
    const response = NextResponse.json({ success: false, error: error?.message || 'Proxy Manager failed' }, { status: 500 });
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
