'use client';
/**
 * Agent Team View v2 — Zoom-Call Grid Layout
 * 
 * Enterprise-grade agent monitoring with multiple view modes:
 * - Grid View: All agents shown as tiles (like a Zoom call)
 * - Focus View: Single agent zoomed in, others as thumbnails
 * - Timeline View: Chronological activity across all agents
 * 
 * Each agent tile shows:
 * - Live status indicator (spinner/check/error)
 * - Current action text (live updating)
 * - Step count + duration
 * - Expandable trace feed
 * 
 * Users can click any tile to zoom in, or switch views instantly.
 */
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ═══════════════════════════════════════════════════════════════
// Inline Icons
// ═══════════════════════════════════════════════════════════════
const I = {
  Users: (p: any) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  Grid: (p: any) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  Maximize: (p: any) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>,
  Minimize: (p: any) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>,
  X: (p: any) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Check: (p: any) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
  Arrow: (p: any) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>,
  Msg: (p: any) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
  Home: (p: any) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
};

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════
interface AgentData {
  name: string;
  status: 'spawning' | 'working' | 'completed' | 'error' | 'idle';
  task: string;
  currentAction?: string;
  stepCount: number;
  durationMs: number;
  startedAt: number;
  result?: string;
  actions: Array<{ text: string; type: string; ts: number }>;
}

type ViewMode = 'grid' | 'focus';

interface Props {
  traceLogs: any[];
  isThinking: boolean;
  onClose: () => void;
}

// ═══════════════════════════════════════════════════════════════
// Spinner
// ═══════════════════════════════════════════════════════════════
// Action type icons for the feed
const actionTypeIcon = (type: string): string => {
  const icons: Record<string, string> = {
    'progress': '⚡', 'exploration': '🔍', 'file_edit': '✏️', 'command': '▶',
    'work_note': '💭', 'browser': '🌐', 'communication': '📡', 'sub_agent_action': '🔧',
    'sub_agent_spawn': '🚀', 'sub_agent_complete': '✅', 'sub_agent_error': '❌',
    'thought_stream': '💡', 'file_preview': '📄', 'console_output': '📟',
  };
  return icons[type] || '•';
};

const Spin = ({ c = 'h-4 w-4', color = 'violet' }: { c?: string; color?: string }) => (
  <span className={`relative flex shrink-0 items-center justify-center ${c}`}>
    <span className="absolute inset-0 rounded-full border-[2px] border-white/[0.10]" />
    <span className={`absolute inset-0 rounded-full border-[2px] border-transparent border-r-${color}-400/50 border-t-${color}-400 animate-[spin_1.1s_linear_infinite]`} />
  </span>
);

// ═══════════════════════════════════════════════════════════════
// Status colors
// ═══════════════════════════════════════════════════════════════
const SC: Record<string, { ring: string; dot: string; label: string; text: string; glow: string }> = {
  spawning: { ring: 'ring-blue-500/30', dot: 'bg-blue-400', label: 'Starting', text: 'text-blue-400', glow: 'shadow-[0_0_12px_rgba(59,130,246,0.15)]' },
  working: { ring: 'ring-amber-500/30', dot: 'bg-amber-400', label: 'Working', text: 'text-amber-400', glow: 'shadow-[0_0_12px_rgba(245,158,11,0.15)]' },
  completed: { ring: 'ring-emerald-500/30', dot: 'bg-emerald-400', label: 'Done', text: 'text-emerald-400', glow: '' },
  error: { ring: 'ring-red-500/30', dot: 'bg-red-400', label: 'Error', text: 'text-red-400', glow: '' },
  idle: { ring: 'ring-gray-500/30', dot: 'bg-gray-400', label: 'Idle', text: 'text-gray-400', glow: '' },
};

// ═══════════════════════════════════════════════════════════════
// Agent Grid Tile (Zoom-call style)
// ═══════════════════════════════════════════════════════════════
const AgentTile = ({ agent, onFocus, isFocused, size }: {
  agent: AgentData; onFocus: () => void; isFocused: boolean; size: 'large' | 'medium' | 'small';
}) => {
  const feedRef = useRef<HTMLDivElement>(null);
  const sc = SC[agent.status] || SC.idle;
  const elapsed = agent.durationMs > 0
    ? `${(agent.durationMs / 1000).toFixed(1)}s`
    : `${Math.max(0, Math.round((Date.now() - agent.startedAt) / 1000))}s`;
  const isLive = agent.status === 'working' || agent.status === 'spawning';

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [agent.actions.length]);

  const tileHeight = size === 'large' ? 'h-full' : size === 'medium' ? 'h-[320px]' : 'h-[180px]';

  return (
    <motion.div
      layout
      onClick={onFocus}
      className={`relative flex flex-col overflow-hidden rounded-[16px] border transition-all duration-200 cursor-pointer
        ${isFocused
          ? 'border-violet-500/30 bg-[#110F1A] ' + sc.glow
          : 'border-white/[0.06] bg-[#111111] hover:border-white/[0.10] hover:bg-[#141414]'
        } ${tileHeight}`}
    >
      {/* Header Bar */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-white/[0.04] shrink-0">
        {/* Avatar */}
        <div className={`relative flex h-7 w-7 items-center justify-center rounded-full bg-[#1a1a1a] ring-2 ${sc.ring} shrink-0`}>
          <span className="text-[11px] font-bold text-[#D4D0CB]">{agent.name.charAt(0)}</span>
          {isLive && <span className={`absolute -bottom-px -right-px h-2.5 w-2.5 rounded-full ${sc.dot} border-[1.5px] border-[#111] animate-pulse`} />}
          {agent.status === 'completed' && <span className="absolute -bottom-px -right-px h-2.5 w-2.5 rounded-full bg-emerald-400 border-[1.5px] border-[#111]" />}
        </div>

        {/* Name + Status */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[12px] font-semibold text-[#E0DCD6] truncate">{agent.name}</span>
            <span className={`text-[8px] font-bold uppercase tracking-wider ${sc.text}`}>{sc.label}</span>
          </div>
          {size !== 'small' && (
            <span className="block text-[10px] text-[#555350] truncate">{agent.currentAction || agent.task.substring(0, 40)}</span>
          )}
        </div>

        {/* Metrics */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-mono text-[#6B6660]">{elapsed}</span>
          <span className="text-[9px] text-[#3A3835]">{agent.stepCount}st</span>
        </div>
      </div>

      {/* Feed Body */}
      <div ref={feedRef} className="flex-1 overflow-y-auto px-3 py-1.5 custom-scrollbar">
        {agent.actions.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            {isLive ? <Spin c="h-5 w-5" /> : <span className="text-[10px] text-[#3A3835]">No activity</span>}
          </div>
        ) : (
          agent.actions.slice(size === 'small' ? -3 : size === 'medium' ? -12 : -30).map((a, i) => (
            <div key={i} className="flex items-start gap-1.5 py-[3px]">
              <span className="text-[8px] mt-[2px] shrink-0 opacity-60">{actionTypeIcon(a.type)}</span>
              <span className="text-[10px] text-[#7A756F] leading-[1.5] truncate">{a.text}</span>
            </div>
          ))
        )}
      </div>

      {/* Result bar for completed agents */}
      {agent.result && size !== 'small' && (
        <div className="border-t border-emerald-500/10 bg-emerald-500/[0.02] px-3 py-2 shrink-0">
          <p className="text-[10px] text-emerald-300/70 truncate">✓ {agent.result.substring(0, 80)}</p>
        </div>
      )}
    </motion.div>
  );
};

// ═══════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════
export const AgentTeamView: React.FC<Props> = ({ traceLogs, isThinking, onClose }) => {
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [focusedAgent, setFocusedAgent] = useState<string | null>(null);
  const [updateTick, setUpdateTick] = useState(0);

  // Tick every 2s for elapsed time updates
  useEffect(() => {
    const t = setInterval(() => setUpdateTick(v => v + 1), 2000);
    return () => clearInterval(t);
  }, []);

  // Build agent data from trace logs
  const agents = useMemo(() => {
    const map = new Map<string, AgentData>();

    // Main agent
    map.set('Main', {
      name: 'Main', status: isThinking ? 'working' : 'idle', task: 'Primary orchestrator',
      stepCount: 0, durationMs: 0, startedAt: Date.now(), actions: [],
    });

    for (const log of traceLogs) {
      if (!log) continue;
      const name = log.agentName || log.subAgent;

      if (!name) {
        // Main agent
        const main = map.get('Main')!;
        if (log.text && !['user_action', 'answer', 'thought_stream', 'task_plan'].includes(log.type)) {
          main.actions.push({ text: log.text, type: log.type, ts: Date.now() });
          main.stepCount++;
        }
        continue;
      }

      if (log.type === 'sub_agent_spawn') {
        map.set(name, {
          name, status: 'spawning', task: log.secondary || log.text || '',
          stepCount: 0, durationMs: 0, startedAt: Date.now(), actions: [],
        });
      } else if (log.type === 'sub_agent_action') {
        const a = map.get(name);
        if (a) {
          a.status = 'working';
          a.currentAction = log.text?.substring(0, 80);
          a.stepCount = log.agentStep || (a.stepCount + 1);
          if (log.text) a.actions.push({ text: log.text, type: log.type, ts: Date.now() });
        }
      } else if (log.type === 'sub_agent_complete') {
        const a = map.get(name);
        if (a) {
          a.status = 'completed'; a.durationMs = log.durationMs || 0;
          a.stepCount = log.stepCount || a.stepCount;
          a.result = log.taskSummary || log.result;
        }
      } else if (log.type === 'sub_agent_error') {
        const a = map.get(name);
        if (a) { a.status = 'error'; a.result = log.secondary || log.text; }
      }
    }

    // Cap actions arrays
    for (const a of map.values()) {
      if (a.actions.length > 100) a.actions = a.actions.slice(-100);
    }

    return Array.from(map.values());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceLogs, isThinking, updateTick]);

  const activeCount = agents.filter(a => a.status === 'working' || a.status === 'spawning').length;
  const completedCount = agents.filter(a => a.status === 'completed').length;

  // Grid layout calculation
  const gridCols = agents.length <= 2 ? 1 : agents.length <= 4 ? 2 : agents.length <= 9 ? 3 : 4;

  const handleFocus = useCallback((name: string) => {
    if (viewMode === 'grid') {
      setFocusedAgent(name);
      setViewMode('focus');
    } else {
      setFocusedAgent(name);
    }
  }, [viewMode]);

  const handleBackToGrid = useCallback(() => {
    setViewMode('grid');
    setFocusedAgent(null);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] flex flex-col bg-[#0A0A0A]"
    >
      {/* ─── Top Bar ─── */}
      <div className="flex items-center justify-between px-5 h-[52px] border-b border-white/[0.04] shrink-0 bg-[#0E0E0E]">
        <div className="flex items-center gap-3">
          {viewMode === 'focus' && (
            <button
              onClick={handleBackToGrid}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.06] transition-colors text-[12px] text-[#9B958D] font-medium"
            >
              <I.Arrow className="w-3.5 h-3.5" />
              Back
            </button>
          )}
          <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-gradient-to-br from-violet-500/15 to-indigo-500/15 border border-violet-500/15">
            <I.Users className="w-4 h-4 text-violet-400" />
          </div>
          <div>
            <h2 className="text-[14px] font-bold text-[#E0DCD6] leading-tight">Agent Team</h2>
            <p className="text-[10px] text-[#555350]">
              {agents.length} agents · {activeCount > 0 ? `${activeCount} active` : ''}{activeCount > 0 && completedCount > 0 ? ' · ' : ''}{completedCount > 0 ? `${completedCount} done` : ''}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* View Toggle */}
          <div className="flex items-center rounded-lg bg-white/[0.03] border border-white/[0.06] p-0.5">
            <button
              onClick={handleBackToGrid}
              className={`flex items-center justify-center h-7 w-7 rounded-md transition-colors ${viewMode === 'grid' ? 'bg-violet-500/15 text-violet-300' : 'text-[#555350] hover:text-[#9B958D]'}`}
              title="Grid View"
            >
              <I.Grid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => { if (!focusedAgent && agents.length > 0) setFocusedAgent(agents[0].name); setViewMode('focus'); }}
              className={`flex items-center justify-center h-7 w-7 rounded-md transition-colors ${viewMode === 'focus' ? 'bg-violet-500/15 text-violet-300' : 'text-[#555350] hover:text-[#9B958D]'}`}
              title="Focus View"
            >
              <I.Maximize className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Live indicator */}
          {activeCount > 0 && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/8 border border-amber-500/15">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
              <span className="text-[9px] font-bold text-amber-400 uppercase tracking-wider">Live</span>
            </div>
          )}

          {/* Back to chat */}
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.06] transition-colors text-[11px] text-[#9B958D] font-medium"
          >
            <I.Home className="w-3.5 h-3.5" />
            Chat
          </button>

          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-white/[0.04] transition-colors">
            <I.X className="w-3.5 h-3.5 text-[#555350]" />
          </button>
        </div>
      </div>

      {/* ─── Grid View ─── */}
      {viewMode === 'grid' && (
        <div className="flex-1 overflow-auto p-4">
          <div
            className="grid gap-3 h-full auto-rows-fr"
            style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}
          >
            {agents.map(agent => (
              <AgentTile
                key={agent.name}
                agent={agent}
                onFocus={() => handleFocus(agent.name)}
                isFocused={false}
                size={agents.length <= 2 ? 'large' : agents.length <= 4 ? 'medium' : 'small'}
              />
            ))}
          </div>
        </div>
      )}

      {/* ─── Focus View ─── */}
      {viewMode === 'focus' && (
        <div className="flex-1 flex overflow-hidden">
          {/* Main focused agent */}
          <div className="flex-1 p-3">
            {focusedAgent && (
              <AgentTile
                agent={agents.find(a => a.name === focusedAgent) || agents[0]}
                onFocus={() => {}}
                isFocused={true}
                size="large"
              />
            )}
          </div>

          {/* Sidebar thumbnails */}
          {agents.length > 1 && (
            <div className="w-[200px] shrink-0 border-l border-white/[0.04] overflow-y-auto p-2 space-y-2">
              <div className="px-2 py-1">
                <span className="text-[9px] font-bold text-[#3A3835] uppercase tracking-wider">All Agents</span>
              </div>
              {agents.filter(a => a.name !== focusedAgent).map(agent => (
                <AgentTile
                  key={agent.name}
                  agent={agent}
                  onFocus={() => setFocusedAgent(agent.name)}
                  isFocused={false}
                  size="small"
                />
              ))}
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
};

export default AgentTeamView;
