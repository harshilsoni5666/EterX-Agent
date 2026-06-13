/**
 * ETERX MONITOR — Server-Sent Events (SSE) Stream
 * Real-time agent event feed for the Monitor Panel UI.
 */

import { NextRequest } from 'next/server';
import { monitorEmitter } from '../../../../lib/agent/monitor/emitter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const chatId = url.searchParams.get('chatId') || undefined;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const send = (data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          closed = true;
          unsub();
        }
      };

      send(JSON.stringify({ type: 'connected', ts: Date.now(), version: '2.0' }));

      const onEvent = (event: any) => {
        if (closed) return;
        try {
          send(JSON.stringify(event));
        } catch {
          closed = true;
        }
      };
      const unsub = chatId
        ? monitorEmitter.subscribeForChat(chatId, onEvent, { includeGlobal: true })
        : monitorEmitter.subscribe(onEvent);

      req.signal.addEventListener('abort', () => {
        closed = true;
        unsub();
        try { controller.close(); } catch { }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const limit = Math.min(Number(body.limit) || 100, 500);
    const chatId = typeof body.chatId === 'string' && body.chatId.trim() ? body.chatId.trim() : '';
    const events = chatId
      ? monitorEmitter.getRecentForChat(chatId, limit, { includeGlobal: true })
      : monitorEmitter.getRecent(limit);
    return Response.json({ events, ts: Date.now() });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
