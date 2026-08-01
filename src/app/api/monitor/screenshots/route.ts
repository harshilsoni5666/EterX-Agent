/**
 * ═══════════════════════════════════════════════════════════════
 * EterX live browser stream.
 * Streams current browser frames and activity events over SSE without
 * replaying stale screenshots from previous sessions.
 * ═══════════════════════════════════════════════════════════════
 */

import { NextRequest } from 'next/server';
import { monitorEmitter } from '../../../../lib/agent/monitor/emitter';
import { rejectCrossOrigin } from '../../agent/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const originError = rejectCrossOrigin(req);
  if (originError) return originError;

  const url = new URL(req.url);
  const chatId = url.searchParams.get('chatId') || undefined;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const send = (data: Record<string, any>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Send connection confirmation
      send({ type: 'connected', ts: Date.now() });

      // Stream only live monitor events. Stale files from previous sessions are
      // intentionally excluded so the panel always reflects the real browser.
      const onMonitorEvent = (ev: any) => {
        if (closed) return;
        if (ev.type === 'browser_screenshot' && ev.screenshot) {
          send({ type: 'screenshot', ts: ev.ts, base64: ev.screenshot, url: ev.url, chatId: ev.chatId });
        }
        if (ev.type === 'browser_nav') {
          send({ type: 'nav', ts: ev.ts, url: ev.url, chatId: ev.chatId });
        }
        if (ev.type === 'tool_start' || ev.type === 'tool_end') {
          send({ type: 'activity', ts: ev.ts, tool: ev.tool, eventType: ev.type, durationMs: ev.durationMs });
        }
        if (ev.type === 'thought' || ev.type === 'task_start' || ev.type === 'task_done' || ev.type === 'milestone') {
          send({ type: 'step', ts: ev.ts, text: ev.text, stepType: ev.type });
        }
        if (ev.type === 'terminal_cmd') {
          send({ type: 'terminal', ts: ev.ts, cmd: ev.cmd });
        }
        if (ev.type === 'file_write' || ev.type === 'file_read') {
          send({ type: 'file', ts: ev.ts, path: ev.filePath, action: ev.type });
        }
      };
      const unsubMonitor = chatId
        ? monitorEmitter.subscribeForChat(chatId, onMonitorEvent, { replay: false, includeVisual: true })
        : monitorEmitter.subscribe(onMonitorEvent);

      // Heartbeat every 10s
      const heartbeat = setInterval(() => {
        if (closed) { clearInterval(heartbeat); return; }
        send({ type: 'heartbeat', ts: Date.now() });
      }, 10000);

      req.signal.addEventListener('abort', () => {
        closed = true;
        unsubMonitor();
        clearInterval(heartbeat);
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
    },
  });
}

// Polling intentionally does not return cached frames; use the live SSE stream.
export async function POST(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    return Response.json({
      screenshot: null,
      liveOnly: true,
      message: 'Browser frames are available only from the live SSE stream.',
      ts: Date.now(),
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
