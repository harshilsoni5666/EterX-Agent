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
import { Monitor, RefreshCw, ExternalLink, X, Maximize2, Minimize2, Globe, Wifi, WifiOff, ZoomIn, ZoomOut } from 'lucide-react';

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
  /** Optional static URL to show in the address bar (e.g. from localhost proxy) */
  initialUrl?: string;
}

const MAX_LOG_ENTRIES = 50;
const SSE_URL = '/api/monitor/screenshots';

function normalizeBrowserAddress(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return '';

  const hostMatch = trimmed.match(/^(localhost|127\.0\.0\.1|\[::1\]|::1)(?::(\d+))?(\/.*)?$/i);
  if (hostMatch) {
    const host = hostMatch[1];
    const port = hostMatch[2] || '3000';
    const rest = hostMatch[3] || '/';
    return `http://${host}:${port}${rest}`;
  }

  const portOnlyMatch = trimmed.match(/^:?(3000|[1-9]\d{1,4})(\/.*)?$/);
  if (portOnlyMatch) {
    return `http://localhost:${portOnlyMatch[1]}${portOnlyMatch[2] || '/'}`;
  }

  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return '';
}

export const LiveBrowserPanel: React.FC<LiveBrowserPanelProps> = ({
  chatId,
  onClose,
  isFullscreen,
  onToggleFullscreen,
  initialUrl,
}) => {
  const initialBrowserTarget = normalizeBrowserAddress(initialUrl || '');
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [logs, setLogs] = useState<BrowserLog[]>([]);
  const [connected, setConnected] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(initialBrowserTarget || initialUrl || '');
  const [urlInput, setUrlInput] = useState(initialBrowserTarget || initialUrl || '');
  const [showLogs, setShowLogs] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [lastActivity, setLastActivity] = useState<string>('Waiting for browser activity...');
  const [isAgentActive, setIsAgentActive] = useState(false);
  const [frameCount, setFrameCount] = useState(0);
  const [iframeUrl, setIframeUrl] = useState<string | null>(initialBrowserTarget || null);

  const iframeRef = useRef<HTMLIFrameElement>(null);
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
    let es: EventSource;

    const connect = () => {
      es = new EventSource(SSE_URL);
      eventSourceRef.current = es;

      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        // Reconnect after 3s
        setTimeout(connect, 3000);
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
            setFrameCount(c => c + 1);
            markActive('Browser active');
            return;
          }

          if (data.type === 'nav' && data.url) {
            setCurrentUrl(data.url);
            setUrlInput(data.url);
            addLog({ ts: data.ts, type: 'nav', text: `→ ${data.url}` });
            markActive(`Navigating to ${new URL(data.url).hostname}`);
            return;
          }

          if (data.type === 'activity') {
            const label = data.eventType === 'tool_start' ? `▶ ${data.tool}` : `✓ ${data.tool}`;
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
            addLog({ ts: data.ts, type: 'terminal', text: `$ ${data.cmd}` });
            return;
          }

          if (data.type === 'file' && data.path) {
            addLog({ ts: data.ts, type: 'file', text: `${data.action === 'file_write' ? '✎' : '◎'} ${data.path.split(/[\\/]/).pop()}` });
            return;
          }
        } catch { /* ignore malformed events */ }
      };
    };

    connect();
    return () => {
      es?.close();
      eventSourceRef.current = null;
    };
  }, [markActive, addLog]);

  // Auto-scroll logs
  useEffect(() => {
    if (showLogs && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, showLogs]);

  // Navigate the proxy iframe
  const navigateIframe = (nextInput = urlInput) => {
    const target = normalizeBrowserAddress(nextInput);
    if (!target) return;
    setUrlInput(target);
    setCurrentUrl(target);
    setIframeUrl(target);
  };

  const frameTimestamp = frame ? new Date(frame.ts).toLocaleTimeString() : null;
  const hasLiveFrame = !!frame?.screenshot;
  const hasIframe = !!iframeUrl;

  return (
    <div className="flex flex-col h-full bg-[#0A0A0C] select-none">
      {/* ── Toolbar ───────────────────────────────────────── */}
      <div
        className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-white/[0.06]"
        style={{ background: 'linear-gradient(180deg,#1A1A1C 0%,#151517 100%)' }}
      >
        {/* Traffic lights */}
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="w-2.5 h-2.5 rounded-full bg-[#FF5F57] shadow-sm border border-black/20" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#FEBC2E] shadow-sm border border-black/20" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#28C840] shadow-sm border border-black/20" />
        </div>

        {/* Address bar */}
        <div className="flex items-center flex-1 gap-1 min-w-0 bg-[#0D0D10] border border-white/[0.07] rounded-[8px] px-2.5 py-1.5 shadow-inner">
          <Globe className="w-3 h-3 text-[#555350] shrink-0" />
          <input
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') navigateIframe(); }}
            placeholder="localhost:3000 or paste URL..."
            className="flex-1 min-w-0 bg-transparent text-[11px] font-mono text-[#C8C6C3] outline-none placeholder-[#3A3A3A]"
          />
          {urlInput && (
            <button onClick={() => { setUrlInput(''); setIframeUrl(null); }} className="shrink-0 text-[#555350] hover:text-white transition-colors">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => navigateIframe()}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold bg-white/[0.06] text-[#C8C6C3] hover:bg-white/[0.10] hover:text-white transition-colors border border-white/[0.06]"
          >
            Go
          </button>

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

        {/* Primary view: iframe (proxy) or live screenshot */}
        <div className="flex-1 relative overflow-hidden bg-[#0A0A0C]">

          {/* Proxy iframe — shown when user types a URL */}
          {hasIframe && (
            <div className="absolute inset-0" style={{ transformOrigin: 'top left', transform: `scale(${zoom})`, width: `${100 / zoom}%`, height: `${100 / zoom}%` }}>
              <iframe
                ref={iframeRef}
                src={iframeUrl!}
                className="w-full h-full border-0"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                title="Preview"
              />
            </div>
          )}

          {/* Live screenshot from agent browser */}
          {!hasIframe && hasLiveFrame && (
            <div className="absolute inset-0 flex items-start justify-center overflow-auto bg-[#080808]">
              <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top center', transition: 'transform 0.15s ease' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:image/png;base64,${frame!.screenshot}`}
                  alt="Browser screenshot"
                  className="max-w-none shadow-2xl"
                  draggable={false}
                />
              </div>
            </div>
          )}

          {/* Empty state */}
          {!hasIframe && !hasLiveFrame && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-[#333]">
              <Monitor className="w-12 h-12 opacity-20" />
              <div className="text-center">
                <div className="text-[14px] font-semibold text-[#555] mb-1">No Preview Active</div>
                <div className="text-[12px] text-[#3A3A3A]">
                  {connected
                    ? 'Enter a localhost URL above, or wait for the agent to open a browser'
                    : 'Connecting to live stream...'}
                </div>
              </div>
              {connected && (
                <div className="flex flex-col items-center gap-2 mt-2">
                  <div className="text-[11px] text-[#4A4A4A] font-mono">Try: localhost:3000</div>
                  <button
                    onClick={() => navigateIframe('localhost:3000')}
                    className="px-3 py-1.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[12px] text-[#888] hover:text-white hover:bg-white/[0.10] transition-colors"
                  >
                    Open localhost:3000
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Screenshot timestamp badge */}
          {!hasIframe && hasLiveFrame && frameTimestamp && (
            <div className="absolute bottom-3 right-3 px-2 py-1 rounded-full bg-black/60 border border-white/[0.08] text-[10px] font-mono text-[#888] backdrop-blur-sm">
              {frameTimestamp}
            </div>
          )}

          {/* URL chip overlay */}
          {!hasIframe && currentUrl && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 max-w-[80%] truncate px-2.5 py-1 rounded-full bg-black/70 border border-white/[0.08] text-[10px] font-mono text-[#888] backdrop-blur-sm">
              {currentUrl}
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
              <div className="flex-1 overflow-y-auto min-h-0 py-1">
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
