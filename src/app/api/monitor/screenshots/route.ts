/**
 * ═══════════════════════════════════════════════════════════════
 * ETERX COMPUTER VIEW — Screenshot Watch SSE Endpoint
 * Watches the screenshots directory for new files and streams
 * them as base64 PNG via SSE. This powers the live "Computer View"
 * panel that shows exactly what the agent's browser sees.
 * ═══════════════════════════════════════════════════════════════
 */

import { NextRequest } from 'next/server';
import path from 'path';
import fs from 'fs';
import { monitorEmitter } from '../../../../lib/agent/monitor/emitter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SCREENSHOTS_DIR = path.resolve(process.cwd(), '.workspaces', 'temp', 'screenshots');

// Ensure dir exists
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

function resolveUnder(parent: string, ...segments: string[]): string {
  const root = path.resolve(parent);
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(root, resolved);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(`Blocked screenshot path traversal: ${resolved}`);
  }
  return resolved;
}

function readFileAsBase64(filePath: string): string | null {
  try {
    const buf = fs.readFileSync(filePath);
    return buf.toString('base64');
  } catch {
    return null;
  }
}

function getLatestScreenshot(): { path: string; ts: number } | null {
  try {
    const files = fs.readdirSync(SCREENSHOTS_DIR)
      .filter(f => f.endsWith('.png'))
      .map(f => ({
        path: resolveUnder(SCREENSHOTS_DIR, f),
        ts: fs.statSync(resolveUnder(SCREENSHOTS_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => b.ts - a.ts);
    return files[0] || null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const chatId = url.searchParams.get('chatId') || undefined;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let lastScreenshotPath = '';
      let lastEventTs = 0;

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

      // Send the latest existing screenshot immediately
      const latest = getLatestScreenshot();
      if (latest) {
        const base64 = readFileAsBase64(latest.path);
        if (base64) {
          send({
            type: 'screenshot',
            ts: latest.ts,
            path: latest.path,
            filename: path.basename(latest.path),
            base64,
          });
          lastScreenshotPath = latest.path;
          lastEventTs = latest.ts;
        }
      }

      // Watch screenshots directory for new files
      let watcher: fs.FSWatcher | null = null;
      try {
        watcher = fs.watch(SCREENSHOTS_DIR, { persistent: false }, (eventType, filename) => {
          if (!filename || !filename.endsWith('.png') || closed) return;
          let filePath = '';
          try {
            filePath = resolveUnder(SCREENSHOTS_DIR, filename);
          } catch {
            return;
          }
          // Small delay to ensure file is fully written
          setTimeout(() => {
            if (closed) return;
            try {
              const stat = fs.statSync(filePath);
              if (stat.mtimeMs <= lastEventTs) return;
              const base64 = fs.readFileSync(filePath).toString('base64');
              if (!base64) return;
              lastScreenshotPath = filePath;
              lastEventTs = stat.mtimeMs;
              send({
                type: 'screenshot',
                ts: stat.mtimeMs,
                path: filePath,
                filename,
                base64,
              });
            } catch { /* file may not exist yet */ }
          }, 120);
        });
      } catch { /* fs.watch may not be supported */ }

      // Also subscribe to monitor emitter for browser_screenshot events
      const onMonitorEvent = (ev: any) => {
        if (closed) return;
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
        watcher?.close();
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
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// Poll endpoint — returns latest screenshot as base64
export async function POST(req: NextRequest) {
  try {
    const latest = getLatestScreenshot();
    if (!latest) {
      return Response.json({ screenshot: null, ts: Date.now() });
    }
    const base64 = readFileAsBase64(latest.path);
    return Response.json({
      screenshot: base64,
      filename: path.basename(latest.path),
      path: latest.path,
      ts: latest.ts,
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
