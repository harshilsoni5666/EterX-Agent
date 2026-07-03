/**
 * ═══════════════════════════════════════════════════════════════
 * /api/monitor/live — High-performance Live Stream SSE Endpoint
 * ═══════════════════════════════════════════════════════════════
 * Streams real-time JPEG frames of the desktop/browser/any app.
 * Also accepts control commands: start, stop, config, takeover
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
  const onlyFrames = url.searchParams.get('frames') === '1';

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const send = (data: Record<string, any>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch { closed = true; }
      };

      // Send initial state
      send({
        type: 'connected',
        ts: Date.now(),
        stats: monitorEmitter.getStats(),
      });

      // Replay recent events
      const recent = chatId
        ? monitorEmitter.getRecentForChat(chatId, onlyFrames ? 5 : 80, { includeVisual: true })
        : monitorEmitter.getRecent(onlyFrames ? 5 : 80);
      for (const ev of recent) {
        if (closed) break;
        if (onlyFrames && ev.type !== 'live_frame' && ev.type !== 'desktop_screenshot' && ev.type !== 'browser_screenshot') continue;
        send(ev);
      }

      // Subscribe to new events
      const onEvent = (ev: any) => {
        if (closed) return;
        if (onlyFrames && ev.type !== 'live_frame' && ev.type !== 'desktop_screenshot' && ev.type !== 'browser_screenshot' && ev.type !== 'heartbeat') return;
        send(ev);
      };
      const unsub = chatId
        ? monitorEmitter.subscribeForChat(chatId, onEvent, { replay: false, includeVisual: true })
        : monitorEmitter.subscribe(onEvent);

      // Heartbeat every 8s
      const hb = setInterval(() => {
        if (closed) { clearInterval(hb); return; }
        send({ type: 'ping', ts: Date.now(), stats: monitorEmitter.getStats() });
      }, 8000);

      req.signal.addEventListener('abort', () => {
        closed = true;
        unsub();
        clearInterval(hb);
        try { controller.close(); } catch { }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ─── POST: control commands ───────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const originError = rejectCrossOrigin(req);
    if (originError) return originError;

    const body = await req.json();
    const { action, chatId } = body;

    switch (action) {
      case 'start_stream': {
        const { isUnsafeHostControlEnabled } = await import('../../../../lib/agent/computer/computer-session');
        if (!isUnsafeHostControlEnabled()) {
          const { listManagedWindows } = await import('../../../../lib/agent/computer/managed-computer');
          const windows = await listManagedWindows(chatId || '');
          if (windows.length === 0) {
            return Response.json({
              ok: false,
              action: 'stream_not_ready',
              error: 'EterX Computer has no active app yet. Start a browser, desktop app, or connected app first.',
            }, { status: 409 });
          }
        }

        const { startLiveStream } = await import('../../../../lib/agent/computer/live-stream');
        await startLiveStream({
          fps: body.fps || 8,
          quality: body.quality || 80,
          maxWidth: body.maxWidth || 1280,
          chatId: chatId || '',
        });
        return Response.json({ ok: true, action: 'stream_started' });
      }

      case 'stop_stream': {
        const { stopLiveStream } = await import('../../../../lib/agent/computer/live-stream');
        stopLiveStream();
        return Response.json({ ok: true, action: 'stream_stopped' });
      }

      case 'user_takeover': {
        monitorEmitter.userTakeover(chatId);
        return Response.json({ ok: true, action: 'user_takeover', userInControl: true });
      }

      case 'agent_takeover': {
        monitorEmitter.agentTakeover(chatId);
        return Response.json({ ok: true, action: 'agent_takeover', userInControl: false });
      }

      case 'list_apps': {
        const { listApps } = await import('../../../../lib/agent/computer/app-connector');
        const apps = await listApps();
        return Response.json({ ok: true, apps });
      }

      case 'focus_app': {
        const { focusApp } = await import('../../../../lib/agent/computer/app-connector');
        const ok = await focusApp(body.app || '', chatId);
        return Response.json({ ok, action: 'focus_app', app: body.app });
      }

      case 'capture_frame': {
        const { captureFrameForVision } = await import('../../../../lib/agent/computer/live-stream');
        const frame = await captureFrameForVision(body.quality || 80, body.maxWidth || 1280, chatId || '');
        return Response.json({ ok: !!frame, frame: frame || null, ts: Date.now() });
      }

      case 'get_stats': {
        const { getLiveStreamStats, isLiveStreaming } = await import('../../../../lib/agent/computer/live-stream');
        return Response.json({
          ok: true,
          streaming: isLiveStreaming(),
          streamStats: getLiveStreamStats(),
          monitorStats: monitorEmitter.getStats(),
        });
      }

      default:
        return Response.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
