'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 * EterX Live Browser Panel
 * Shows real-time screenshots from the agent's browser via SSE.
 * Embedded in the IDE panel as a "Browser" tab.
 * ═══════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Monitor, Maximize2, Minimize2, Globe, Wifi, WifiOff, ZoomIn, ZoomOut } from 'lucide-react';

interface BrowserFrame {
  screenshot?: string;  // base64 PNG
  url?: string;
  ts: number;
  type?: string;
}

interface BrowserLog {
  ts: number;
  type: 'nav' | 'activity' | 'step' | 'terminal' | 'file';
  text: string;
}

export interface LiveBrowserPanelProps {
  chatId?: string;
  onClose?: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** Legacy caller compatibility; live browser events are the authoritative URL source. */
  initialUrl?: string;
}

const MAX_LOG_ENTRIES = 50;
const SSE_URL = '/api/monitor/screenshots';

const RUNTIME_SECRET_PATTERNS: RegExp[] = [
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bsk-(?:proj-|ant-|live-|test-)?[0-9A-Za-z_-]{16,}\b/g,
  /\b(?:authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|passwd)\s*[:=]\s*(?:Bearer\s+)?['"]?[^'"\r\n&]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];

const redactRuntimeText = (value: unknown, maxLength = 900) => {
  const raw = String(value ?? '');
  const clipped = raw.length > maxLength ? `${raw.slice(0, maxLength)}\n...[truncated]` : raw;
  return RUNTIME_SECRET_PATTERNS.reduce((text, pattern) => (
    text.replace(pattern, (match) => {
      const separator = match.match(/^(.+?\s*[:=]\s*)(?:Bearer\s+)?/i);
      if (separator) return `${separator[1]}[redacted]`;
      if (/^Bearer\s+/i.test(match)) return 'Bearer [redacted]';
      return '[redacted]';
    })
  ), clipped);
};

export const LiveBrowserPanel: React.FC<LiveBrowserPanelProps> = ({
  chatId,
  isFullscreen,
  onToggleFullscreen,
}) => {
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [logs, setLogs] = useState<BrowserLog[]>([]);
  const [connected, setConnected] = useState(false);
  const [currentUrl, setCurrentUrl] = useState('');
  const [showLogs, setShowLogs] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [lastActivity, setLastActivity] = useState<string>('Waiting for browser activity...');
  const [isAgentActive, setIsAgentActive] = useState(false);
  const [frameCount, setFrameCount] = useState(0);

  const eventSourceRef = useRef<EventSource | null>(null);
  const activityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const markActive = useCallback((text: string) => {
    setIsAgentActive(true);
    setLastActivity(text);
    if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
    activityTimerRef.current = setTimeout(() => setIsAgentActive(false), 4000);
  }, []);

  const addLog = useCallback((log: BrowserLog) => {
    setLogs(prev => [...prev.slice(-MAX_LOG_ENTRIES + 1), log]);
  }, []);

  // Connect to the SSE stream
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let retryCount = 0;

    const connect = () => {
      if (disposed) return;
      es?.close();
      const streamUrl = chatId ? `${SSE_URL}?chatId=${encodeURIComponent(chatId)}` : SSE_URL;
      es = new EventSource(streamUrl);
      eventSourceRef.current = es;

      es.onopen = () => {
        retryCount = 0;
        setConnected(true);
      };
      es.onerror = () => {
        es?.close();
        setConnected(false);
        if (disposed || reconnectTimer) return;
        const delay = Math.min(15000, 1000 * (2 ** Math.min(retryCount++, 4)));
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      };

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'connected') {
            setConnected(true);
            return;
          }

          if (data.type === 'screenshot' && data.base64) {
            setFrame({ screenshot: data.base64, url: data.url, ts: data.ts, type: 'screenshot' });
            if (data.url) setCurrentUrl(data.url);
            setFrameCount(c => c + 1);
            markActive('Browser active');
            return;
          }

          if (data.type === 'nav' && data.url) {
            setCurrentUrl(data.url);
            addLog({ ts: data.ts, type: 'nav', text: `Opened ${data.url}` });
            let destination = 'new page';
            try { destination = new URL(data.url).hostname || destination; } catch { /* non-standard browser URL */ }
            markActive(`Navigating to ${destination}`);
            return;
          }

          if (data.type === 'activity') {
            const label = data.eventType === 'tool_start' ? `Running ${data.tool}` : `Completed ${data.tool}`;
            addLog({ ts: data.ts, type: 'activity', text: label });
            markActive(label);
            return;
          }

          if (data.type === 'step' && data.text) {
            addLog({ ts: data.ts, type: 'step', text: data.text });
            markActive(data.text.substring(0, 60));
            return;
          }

          if (data.type === 'terminal' && data.cmd) {
            addLog({ ts: data.ts, type: 'terminal', text: `$ ${redactRuntimeText(data.cmd)}` });
            return;
          }

          if (data.type === 'file' && data.path) {
            addLog({ ts: data.ts, type: 'file', text: `${data.action === 'file_write' ? 'Updated' : 'Read'} ${data.path.split(/[\\/]/).pop()}` });
            return;
          }
        } catch { /* ignore malformed events */ }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
      eventSourceRef.current = null;
      if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
    };
  }, [chatId, markActive, addLog]);

  // Auto-scroll logs
  useEffect(() => {
    if (showLogs && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, showLogs]);

  const frameTimestamp = frame ? new Date(frame.ts).toLocaleTimeString() : null;
  const hasLiveFrame = !!frame?.screenshot;

  return (
    <div className="flex flex-col h-full bg-[#0A0A0C] select-none">
      {/* ── Toolbar ───────────────────────────────────────── */}
      <div
        className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-white/[0.06]"
        style={{ background: 'linear-gradient(180deg,#1A1A1C 0%,#151517 100%)' }}
      >
        {/* Address bar */}
        <div className="flex items-center flex-1 gap-1 min-w-0 bg-[#0D0D10] border border-white/[0.07] rounded-[8px] px-2.5 py-1.5 shadow-none">
          <Globe className="w-3 h-3 text-[#555350] shrink-0" />
          <div className="flex-1 min-w-0 truncate text-[11px] font-mono text-[#C8C6C3]">
            {currentUrl || 'Waiting for the controlled browser'}
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setZoom(z => Math.max(0.3, z - 0.1))}
            className="p-1.5 rounded-md text-[#555350] hover:text-white hover:bg-white/[0.06] transition-colors"
            title="Zoom out"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="text-[10px] font-mono text-[#555350] w-8 text-center">{Math.round(zoom * 100)}%</span>
          <button
            onClick={() => setZoom(z => Math.min(2, z + 0.1))}
            className="p-1.5 rounded-md text-[#555350] hover:text-white hover:bg-white/[0.06] transition-colors"
            title="Zoom in"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => setShowLogs(l => !l)}
            className={`p-1.5 rounded-md transition-colors ${showLogs ? 'text-white bg-white/[0.10]' : 'text-[#555350] hover:text-white hover:bg-white/[0.06]'}`}
            title="Toggle activity log"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </button>

          {onToggleFullscreen && (
            <button onClick={onToggleFullscreen} className="p-1.5 rounded-md text-[#555350] hover:text-white hover:bg-white/[0.06] transition-colors">
              {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>

        {/* Connection badge */}
        <div className={`flex items-center gap-1.5 shrink-0 px-2 py-1 rounded-full text-[10px] font-semibold border ${
          connected
            ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
            : 'bg-red-500/10 border-red-500/20 text-red-400'
        }`}>
          {connected ? <Wifi className="w-2.5 h-2.5" /> : <WifiOff className="w-2.5 h-2.5" />}
          {connected ? 'Live' : 'Off'}
        </div>
      </div>

      {/* ── Status strip ──────────────────────────────────── */}
      <AnimatePresence>
        {isAgentActive && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 28, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="flex items-center gap-2 px-3 bg-[#0D1B0D] border-b border-emerald-500/15 shrink-0 overflow-hidden"
          >
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
            </span>
            <span className="text-[11px] font-medium text-emerald-400/90 truncate">{lastActivity}</span>
            {frameCount > 0 && (
              <span className="ml-auto text-[10px] font-mono text-emerald-600 shrink-0">{frameCount} frames</span>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Main content area ─────────────────────────────── */}
      <div className="flex flex-1 min-h-0">

        {/* Primary view: real-time frames from the controlled browser */}
        <div className="flex-1 relative overflow-hidden bg-[#0A0A0C]">

          {/* Live screenshot from agent browser */}
          {hasLiveFrame && (
            <div className="eterx-scrollbar absolute inset-0 flex items-start justify-center overflow-auto bg-[#080808]">
              <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top center', transition: 'transform 0.15s ease' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:${frame!.screenshot!.startsWith('/9j/') ? 'image/jpeg' : 'image/png'};base64,${frame!.screenshot}`}
                  alt="Browser screenshot"
                  className="max-w-none shadow-none"
                  draggable={false}
                />
              </div>
            </div>
          )}

          {/* Empty state */}
          {!hasLiveFrame && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-[#333]">
              <Monitor className="w-12 h-12 opacity-20" />
              <div className="text-center">
                <div className="text-[14px] font-semibold text-[#555] mb-1">Browser stream inactive</div>
                <div className="text-[12px] text-[#3A3A3A]">
                  {connected
                    ? 'Waiting for the first live frame from the controlled browser'
                    : 'Connecting to live stream...'}
                </div>
              </div>
            </div>
          )}

          {/* Screenshot timestamp badge */}
          {hasLiveFrame && frameTimestamp && (
            <div className="absolute bottom-3 right-3 px-2 py-1 rounded-full bg-black/60 border border-white/[0.08] text-[10px] font-mono text-[#888] backdrop-blur-xs">
              {frameTimestamp}
            </div>
          )}

        </div>

        {/* Activity log sidebar */}
        <AnimatePresence>
          {showLogs && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 220, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="flex flex-col border-l border-white/[0.06] bg-[#0D0D10] overflow-hidden shrink-0"
            >
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.05] shrink-0">
                <span className="text-[10px] font-bold text-[#555] uppercase tracking-widest">Activity</span>
                <button onClick={() => setLogs([])} className="text-[10px] text-[#444] hover:text-[#888] transition-colors">Clear</button>
              </div>
              <div className="eterx-scrollbar flex-1 overflow-y-auto min-h-0 py-1">
                {logs.length === 0 && (
                  <div className="px-3 py-2 text-[11px] text-[#333] italic">No activity yet</div>
                )}
                {logs.map((log, i) => (
                  <div key={i} className="flex items-start gap-2 px-3 py-1 hover:bg-white/[0.02]">
                    <span className="text-[9px] font-mono text-[#333] shrink-0 mt-0.5">
                      {new Date(log.ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                    <span className={`text-[11px] font-mono break-all leading-relaxed ${
                      log.type === 'nav' ? 'text-[#4FC1FF]' :
                      log.type === 'activity' ? 'text-[#A3A19E]' :
                      log.type === 'terminal' ? 'text-[#56D364]' :
                      log.type === 'file' ? 'text-[#FFD580]' :
                      'text-[#888]'
                    }`}>
                      {log.text.substring(0, 80)}
                    </span>
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
