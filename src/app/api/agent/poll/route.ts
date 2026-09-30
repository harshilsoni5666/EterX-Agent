import { NextRequest, NextResponse } from 'next/server';
import { setMaxListeners } from 'node:events';
import { agentRegistry } from '../../../../lib/agent/agent-registry';
import { taskStore } from '../../../../lib/agent/task-store';
import { getPendingProxyTaskCount } from '../../../../lib/agent/autonomy/proxy-control-plane';
import { formatUnknownError } from '../../../../lib/agent/error-format';
import {
  attachAgentApiSessionCookie,
  getOrCreateAgentApiSession,
  isSafeChatId,
  isSafeRunId,
  jsonError,
  parseInteger,
  rejectCrossOrigin,
  requireChatOwner,
} from '../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function readPollState(chatId: string, after: number, runId?: string, signal?: AbortSignal): Promise<any> {
  let live: any = agentRegistry.getTraces(chatId, after, runId);
  if (live.status !== 'idle') return live;

  let recovered = false;
  let persisted: Awaited<ReturnType<typeof taskStore.getPollState>> | undefined;
  let recoveryError: unknown;
  const recovery = taskStore.getPollState(chatId, after).then(
    value => { persisted = value; recovered = true; },
    error => { recoveryError = error; recovered = true; },
  );
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    while (!lifetime.signal.aborted) {
      const version = agentRegistry.getTraceChangeVersion(chatId);
      live = agentRegistry.getTraces(chatId, after, runId);
      // Live work takes priority even while a slow disk recovery is pending.
      // Re-reading also prevents an old disk run from pinning a new watcher.
      if (live.status !== 'idle') return live;
      if (recovered) {
        if (recoveryError) throw recoveryError;
        if (persisted && persisted.status !== 'idle' && (!runId || persisted.runId === runId)) {
          return {
            ...persisted,
            ...(live.successorRunId && Number(live.successorStartedAt) >= Number(persisted.startedAt) ? {
              successorRunId: live.successorRunId,
              successorStartedAt: live.successorStartedAt,
            } : {}),
          };
        }
        return live;
      }
      await Promise.race([
        recovery,
        agentRegistry.waitForTraceChange(chatId, after, 4000, lifetime.signal, runId,
          live.status, live.successorRunId, version),
      ]);
    }
    return live;
  } finally {
    lifetime.abort();
    signal?.removeEventListener('abort', abort);
  }
}

/** One browser request watches all live chats without exhausting HTTP slots. */
export async function POST(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;
  const session = getOrCreateAgentApiSession(req);
  const respond = (body: any, status = 200) => attachAgentApiSessionCookie(
    NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } }), session,
  );
  const body = await req.json().catch(() => null);
  if (!Array.isArray(body?.requests) || body.requests.length < 1 || body.requests.length > 128) {
    return respond({ error: 'Provide between 1 and 128 poll requests.' }, 400);
  }
  const requests: Array<{ chatId: string; after: number; runId?: string; denied?: boolean }> = [];
  for (const item of body.requests) {
    if (!isSafeChatId(item?.chatId) || (item.runId && !isSafeRunId(item.runId))) {
      return respond({ error: 'Invalid chat or run identity.' }, 400);
    }
    const ownerError = requireChatOwner(item.chatId, session.sessionId);
    requests.push({ chatId: item.chatId, after: Math.max(-1, parseInteger(String(item.after), -1)), runId: item.runId || undefined, denied: Boolean(ownerError) });
  }
  const read = async (item: typeof requests[number], signal: AbortSignal = req.signal): Promise<any> => {
    if (item.denied) return { _pollError: 'Polling access denied for this chat.' };
    try {
      const result = await readPollState(item.chatId, item.after, item.runId, signal);
      const { items: queuedFollowUps, queueRevision } = agentRegistry.getQueuedFollowUpSnapshot(item.chatId);
      return { ...result, queuedFollowUps, queueRevision, pendingFollowUpCount: queuedFollowUps.length,
        pendingProxyTaskCount: getPendingProxyTaskCount(item.chatId) };
    } catch (error) {
      return { _pollError: formatUnknownError(error, 'Agent polling failed') };
    }
  };
  if (req.headers.get('accept')?.includes('application/x-ndjson')) {
    const encoder = new TextEncoder();
    const lifetime = new AbortController();
    setMaxListeners(requests.length + 4, lifetime.signal);
    const abort = () => lifetime.abort();
    req.signal.addEventListener('abort', abort, { once: true });
    if (req.signal.aborted) abort();
    const writers = new Set<() => void>();
    const resumeWriters = () => {
      for (const resume of writers) resume();
      writers.clear();
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const finish = () => {
          if (closed) return;
          closed = true;
          lifetime.abort();
          resumeWriters();
          req.signal.removeEventListener('abort', abort);
          try { controller.close(); } catch { /* Consumer already disconnected. */ }
        };
        const send = async (index: number, result: any) => {
          // Bound the outgoing stream rather than buffering every token when
          // a renderer is suspended or the network stops accepting bytes.
          while (!closed && !lifetime.signal.aborted && (controller.desiredSize ?? 0) <= 0) {
            await new Promise<void>(resolve => writers.add(resolve));
          }
          if (closed || lifetime.signal.aborted) return;
          controller.enqueue(encoder.encode(`${JSON.stringify({ index, result })}\n`));
        };
        lifetime.signal.addEventListener('abort', finish, { once: true });
        // Each subscription owns its cursor and waits independently. Disk
        // recovery for one task must never gate another task's live chunks.
        const watch = async (request: typeof requests[number], index: number) => {
          const item = { ...request };
          while (!lifetime.signal.aborted) {
            const observedVersion = agentRegistry.getTraceChangeVersion(item.chatId);
            const result = await read(item, lifetime.signal);
            if (lifetime.signal.aborted) return;
            await send(index, result);
            if (result._pollError) return;
            // Pin an initially unscoped subscriber to its first actual run.
            // Its successor is then handed off after the predecessor's final
            // rows, never read with indices belonging to the previous run.
            if (!item.runId && result.runId) item.runId = String(result.runId);
            if (Number.isFinite(result.maxIndex)) item.after = result.maxIndex;
            // Let queued socket writes and other chats run even when a busy
            // producer changes its revision on every read/wait handoff.
            await new Promise<void>(resolve => setImmediate(resolve));
            // Initial idle/startup and terminal states also wait for events;
            // they must not spin or hold the rest of the subscriptions back.
            await agentRegistry.waitForTraceChange(
              item.chatId, item.after, 4000, lifetime.signal, item.runId,
              result.status, result.successorRunId,
              observedVersion,
            );
          }
        };
        void Promise.allSettled(requests.map((item, index) => new Promise<void>(resolve => setImmediate(resolve))
          .then(() => watch(item, index)).catch(async error => {
          if (!lifetime.signal.aborted) await send(index, { _pollError: formatUnknownError(error, 'Live updates interrupted') });
        }))).finally(finish);
      },
      pull() { resumeWriters(); },
      cancel() {
        lifetime.abort();
        resumeWriters();
        req.signal.removeEventListener('abort', abort);
      },
    }, { highWaterMark: 256 * 1024, size: chunk => chunk.byteLength });
    return attachAgentApiSessionCookie(new NextResponse(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, no-transform',
        'X-Accel-Buffering': 'no',
        // Disable framework compression: its output buffer can otherwise
        // retain several small live records until a larger chunk is ready.
        'Content-Encoding': 'identity',
      },
    }), session);
  }
  let results = await Promise.all(requests.map(item => read(item)));
  if (results.every(result => result.status === 'running' && !result.traces?.length) && !req.signal.aborted) {
    const controller = new AbortController();
    setMaxListeners(requests.length + 4, controller.signal);
    const abort = () => controller.abort();
    req.signal.addEventListener('abort', abort, { once: true });
    try {
      if (req.signal.aborted) controller.abort();
      // Wake the whole batch on the first event. The short idle bound also
      // admits newly opened chats promptly, without a second held connection.
      await Promise.race(requests.map(item => agentRegistry.waitForTraceChange(
        item.chatId, item.after, 200, controller.signal, item.runId,
      )));
    } finally {
      controller.abort();
      req.signal.removeEventListener('abort', abort);
    }
    results = await Promise.all(requests.map(item => read(item)));
  }
  return respond({ results });
}

/**
 * GET /api/agent/poll?chatId=xxx&after=-1 — Incremental trace polling
 * 
 * Returns new trace events since the given index. While an agent is running,
 * the UI keeps a short long-poll request open and the registry wakes it as
 * soon as a trace arrives. This is the key to UI independence:
 * - Agent runs on server regardless of UI state
 * - UI can disconnect/reconnect anytime by polling with after=0
 * - Switching chats just means polling a different chatId
 * - Page refresh? Poll from after=-1 to get FULL history
 * 
 * Returns: { status, traces: [...], totalTraces, maxIndex, finalAnswer, startedAt, completedAt }
 */
export async function GET(req: NextRequest) {
  let session: ReturnType<typeof getOrCreateAgentApiSession> | null = null;
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;
    session = getOrCreateAgentApiSession(req);

    const searchParams = req.nextUrl.searchParams;
    const chatId = searchParams.get('chatId');
    const afterStr = searchParams.get('after');
    const requestedRunId = searchParams.get('runId');
    const waitMs = Math.min(7000, Math.max(0, parseInteger(searchParams.get('wait'), 0)));

    if (!isSafeChatId(chatId)) {
      return attachAgentApiSessionCookie(jsonError('chatId is required', 400), session);
    }
    if (requestedRunId && !isSafeRunId(requestedRunId)) {
      return attachAgentApiSessionCookie(jsonError('runId is invalid', 400), session);
    }

    const ownerError = requireChatOwner(chatId, session.sessionId);
    if (ownerError) {
      return attachAgentApiSessionCookie(ownerError, session);
    }

    const afterIndex = Math.max(-1, parseInteger(afterStr, -1));
    let result = await readPollState(chatId, afterIndex, requestedRunId || undefined, req.signal);

    // Hold an otherwise empty running response briefly. This is real-time
    // long polling: traces return as soon as they exist, but an idle agent no
    // longer forces the renderer to create and parse 4-9 HTTP responses every
    // second. Agent execution remains fully independent and every chat keeps
    // its own live connection.
    if (waitMs > 0 && result.status === 'running' && (!Array.isArray(result.traces) || result.traces.length === 0)) {
      await agentRegistry.waitForTraceChange(
        chatId,
        afterIndex,
        waitMs,
        req.signal,
        requestedRunId || undefined,
      );
      result = await readPollState(chatId, afterIndex, requestedRunId || undefined, req.signal);
    }
    result.pendingProxyTaskCount = getPendingProxyTaskCount(chatId);
    const { items: queuedFollowUps, queueRevision } = agentRegistry.getQueuedFollowUpSnapshot(chatId);
    result.queueRevision = queueRevision;
    result.pendingFollowUpCount = queuedFollowUps.length;
    result.queuedFollowUps = queuedFollowUps;

    // Return with anti-cache headers for maximum freshness
    return attachAgentApiSessionCookie(new NextResponse(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    }), session);
  } catch (error: any) {
    const message = formatUnknownError(error, 'Agent polling failed');
    console.error('[API: agent/poll] Error:', message);
    const response = NextResponse.json(
      { status: 'idle', traces: [], totalTraces: 0, maxIndex: -1, finalAnswer: '', error: message },
      { status: 500 }
    );
    return session ? attachAgentApiSessionCookie(response, session) : response;
  }
}
