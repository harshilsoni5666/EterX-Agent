'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 * ETERX AGENT STATUS — Minimal Live Indicator Widget
 * ═══════════════════════════════════════════════════════════════
 * A tiny floating status widget. Shows:
 *  - Current app name (big, clear)
 *  - Action counter (how many actions done)
 *  - Live pulse dot (thinking/working indicator)
 *  - Thinking label below name
 *
 * Drop anywhere: <AgentStatus />
 * ═══════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useRef } from 'react';

interface StatusEvent {
  type: string;
  appName?: string;
  appTitle?: string;
  actionCount?: number;
  tool?: string;
  text?: string;
  ts: number;
  meta?: any;
}

interface AgentStatusState {
  appName: string | null;
  appTitle: string | null;
  actionCount: number;
  isThinking: boolean;
  lastTool: string | null;
  isUserInControl: boolean;
  connected: boolean;
  streaming: boolean;
}

const INITIAL_STATE: AgentStatusState = {
  appName: null,
  appTitle: null,
  actionCount: 0,
  isThinking: false,
  lastTool: null,
  isUserInControl: false,
  connected: false,
  streaming: false,
};

// ─── Hook: subscribe to agent status via SSE ──────────────────────────────────
export function useAgentStatus(): AgentStatusState {
  const [state, setState] = useState<AgentStatusState>(INITIAL_STATE);
  const esRef = useRef<EventSource | null>(null);
  const reconnectRef = useRef<NodeJS.Timeout | null>(null);
  const thinkingTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    let mounted = true;

    const connect = () => {
      if (!mounted) return;
      const es = new EventSource('/api/monitor/live');
      esRef.current = es;

      es.onopen = () => {
        if (!mounted) return;
        setState(s => ({ ...s, connected: true }));
      };

      es.onmessage = (e) => {
        if (!mounted) return;
        try {
          const ev: StatusEvent = JSON.parse(e.data);
          setState(prev => processEvent(prev, ev));

          // Auto-clear thinking after 3s of no tool_start
          if (ev.type === 'tool_start') {
            if (thinkingTimer.current) clearTimeout(thinkingTimer.current);
            thinkingTimer.current = setTimeout(() => {
              setState(s => ({ ...s, isThinking: false }));
            }, 4000);
          }
        } catch { }
      };

      es.onerror = () => {
        if (!mounted) return;
        setState(s => ({ ...s, connected: false }));
        es.close();
        esRef.current = null;
        reconnectRef.current = setTimeout(connect, 3000);
      };
    };

    connect();

    return () => {
      mounted = false;
      esRef.current?.close();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (thinkingTimer.current) clearTimeout(thinkingTimer.current);
    };
  }, []);

  return state;
}

function processEvent(prev: AgentStatusState, ev: StatusEvent): AgentStatusState {
  const next = { ...prev };

  switch (ev.type) {
    case 'connected':
    case 'ping':
      next.connected = true;
      if (ev.meta?.actionCount !== undefined) next.actionCount = ev.meta.actionCount;
      if (ev.meta?.currentApp) next.appName = ev.meta.currentApp;
      if (ev.meta?.userInControl !== undefined) next.isUserInControl = ev.meta.userInControl;
      break;

    case 'heartbeat':
      next.connected = true;
      if (ev.meta?.actionCount !== undefined) next.actionCount = ev.meta.actionCount;
      if (ev.meta?.currentApp) next.appName = ev.meta.currentApp;
      if (ev.meta?.userInControl !== undefined) next.isUserInControl = ev.meta.userInControl;
      break;

    case 'tool_start':
      next.isThinking = true;
      next.lastTool = ev.tool || null;
      if (ev.actionCount !== undefined) next.actionCount = ev.actionCount;
      break;

    case 'tool_end':
    case 'tool_error':
      next.isThinking = false;
      if (ev.actionCount !== undefined) next.actionCount = ev.actionCount;
      break;

    case 'app_connected':
      next.appName = ev.appName || null;
      next.appTitle = ev.appTitle || null;
      break;

    case 'app_disconnected':
      if (next.appName === ev.appName) next.appName = null;
      break;

    case 'app_state':
      if (ev.appName) next.appName = ev.appName;
      break;

    case 'browser_nav':
      next.appName = 'Browser';
      break;

    case 'live_frame':
    case 'desktop_screenshot':
      next.streaming = true;
      break;

    case 'user_takeover':
      next.isUserInControl = true;
      break;

    case 'agent_takeover':
      next.isUserInControl = false;
      break;
  }

  return next;
}

// ─── Minimal Status Widget ────────────────────────────────────────────────────

interface AgentStatusProps {
  className?: string;
  /** Show compact mode (just dot + counter, no name) */
  compact?: boolean;
}

export function AgentStatus({ className = '', compact = false }: AgentStatusProps) {
  const status = useAgentStatus();

  if (compact) {
    return (
      <div className={`flex items-center gap-1.5 ${className}`}>
        <StatusDot connected={status.connected} thinking={status.isThinking} />
        {status.actionCount > 0 && (
          <span className="tabular-nums text-[11px] font-mono text-white/30">
            {status.actionCount}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={`flex flex-col items-start gap-0.5 ${className}`}>
      {/* App Name — big */}
      <div className="flex items-center gap-2">
        <span className="text-[15px] font-semibold text-white/85 tracking-tight leading-none">
          {status.appName || 'EterX'}
        </span>
        <StatusDot connected={status.connected} thinking={status.isThinking} />
      </div>

      {/* Counter + thinking label below */}
      <div className="flex items-center gap-1.5 h-4">
        {status.actionCount > 0 && (
          <span className="tabular-nums text-[11px] font-mono font-medium text-[#E2765A]/70">
            {status.actionCount.toLocaleString()}
          </span>
        )}
        {status.isThinking && (
          <ThinkingLabel tool={status.lastTool} />
        )}
        {!status.isThinking && status.connected && !status.isUserInControl && status.actionCount > 0 && (
          <span className="text-[10px] text-white/20">ready</span>
        )}
        {status.isUserInControl && (
          <span className="text-[10px] text-blue-400/60">you're in control</span>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusDot({ connected, thinking }: { connected: boolean; thinking: boolean }) {
  if (!connected) {
    return <span className="w-1.5 h-1.5 rounded-full bg-white/15 flex-shrink-0" />;
  }
  if (thinking) {
    return (
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{
          background: '#E2765A',
          boxShadow: '0 0 0 0 rgba(226,118,90,0.4)',
          animation: 'eterx-status-pulse 1.2s ease-in-out infinite',
        }}
      />
    );
  }
  return (
    <span
      className="w-1.5 h-1.5 rounded-full flex-shrink-0"
      style={{ background: '#10b981', opacity: 0.6 }}
    />
  );
}

const TOOL_LABELS: Record<string, string> = {
  desktop_control: 'controlling',
  browser_control: 'browsing',
  screenshot_capture: 'seeing',
  workspace_write_file: 'writing',
  workspace_read_file: 'reading',
  system_shell: 'running cmd',
  web_search: 'searching',
  deep_research: 'researching',
  spawn_sub_agent: 'delegating',
};

function ThinkingLabel({ tool }: { tool: string | null }) {
  const label = tool ? (TOOL_LABELS[tool] || 'working') : 'thinking';
  return (
    <span
      className="text-[10px] text-white/35"
      style={{ animation: 'eterx-status-blink 1.4s ease-in-out infinite' }}
    >
      {label}…
    </span>
  );
}

// ─── CSS keyframes (inject once) ─────────────────────────────────────────────

if (typeof document !== 'undefined') {
  const styleId = 'eterx-status-styles';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      @keyframes eterx-status-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(226,118,90,0.5); transform: scale(1); }
        50% { box-shadow: 0 0 0 5px rgba(226,118,90,0); transform: scale(1.15); }
      }
      @keyframes eterx-status-blink {
        0%, 100% { opacity: 0.35; }
        50% { opacity: 0.7; }
      }
    `;
    document.head.appendChild(style);
  }
}
