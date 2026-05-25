'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 * ETERX MONITOR PANEL — Real-Time Agent Activity Window
 * Full discrete window — see EVERYTHING the agent does live:
 *   • Browser navigation + screenshots
 *   • Terminal commands + streaming output
 *   • File system changes (read/write/delete)
 *   • Agent thought stream + reasoning
 *   • Web search queries + results
 *   • API calls + memory recalls
 *   • Active tool execution card
 *   • Live stats bar
 * ═══════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Monitor, Terminal, Globe, FileText, Brain, Search,
  Cpu, Zap, CheckCircle2, XCircle, Loader2,
  Clock, ArrowRight, X, Minimize2,
  Maximize2, RefreshCw, Activity,
  FolderOpen, Download, AlertTriangle,
  Square, Hash, Server, Box, MemoryStick,
  Play, ChevronDown, ChevronUp
} from 'lucide-react';

export interface MonitorEvent {
  id: string;
  type: string;
  ts: number;
  chatId?: string;
  tool?: string;
  args?: any;
  result?: any;
  text?: string;
  url?: string;
  screenshot?: string;
  cmd?: string;
  output?: string;
  filePath?: string;
  domain?: string;
  durationMs?: number;
  success?: boolean;
  error?: string;
  meta?: any;
}

type TabId = 'live' | 'browser' | 'terminal' | 'files' | 'thoughts' | 'search';

interface TabConfig {
  id: TabId;
  label: string;
  icon: React.FC<{ className?: string; style?: React.CSSProperties }>;
  color: string;
  eventTypes: string[];
}

const TABS: TabConfig[] = [
  { id: 'live',     label: 'Live',     icon: Activity,   color: '#E2765A', eventTypes: [] },
  { id: 'browser',  label: 'Browser',  icon: Globe,      color: '#3b82f6', eventTypes: ['browser_nav','browser_screenshot'] },
  { id: 'terminal', label: 'Terminal', icon: Terminal,   color: '#10b981', eventTypes: ['terminal_cmd','terminal_output'] },
  { id: 'files',    label: 'Files',    icon: FolderOpen, color: '#f59e0b', eventTypes: ['file_write','file_read','file_delete'] },
  { id: 'thoughts', label: 'Thoughts', icon: Brain,      color: '#8b5cf6', eventTypes: ['thought','message','milestone','memory_recall'] },
  { id: 'search',   label: 'Search',  icon: Search,     color: '#06b6d4', eventTypes: ['search_query','search_result','api_call'] },
];

const EVENT_CONFIG: Record<string, { icon: React.FC<{className?:string; style?: React.CSSProperties}>, color: string, label: string }> = {
  tool_start:         { icon: Play,          color: '#3b82f6',  label: 'Tool Start' },
  tool_end:           { icon: CheckCircle2,  color: '#10b981',  label: 'Tool Done' },
  tool_error:         { icon: XCircle,       color: '#ef4444',  label: 'Tool Error' },
  thought:            { icon: Brain,         color: '#8b5cf6',  label: 'Thinking' },
  message:            { icon: Hash,          color: '#E2765A',  label: 'Response' },
  browser_nav:        { icon: Globe,         color: '#3b82f6',  label: 'Navigate' },
  browser_screenshot: { icon: Monitor,       color: '#3b82f6',  label: 'Screenshot' },
  terminal_cmd:       { icon: Terminal,      color: '#10b981',  label: 'Command' },
  terminal_output:    { icon: Hash,          color: '#6b7280',  label: 'Output' },
  file_write:         { icon: Download,      color: '#f59e0b',  label: 'Write File' },
  file_read:          { icon: FolderOpen,    color: '#94a3b8',  label: 'Read File' },
  file_delete:        { icon: X,             color: '#ef4444',  label: 'Delete File' },
  task_start:         { icon: Zap,           color: '#E2765A',  label: 'Task Start' },
  task_done:          { icon: CheckCircle2,  color: '#10b981',  label: 'Task Done' },
  task_failed:        { icon: XCircle,       color: '#ef4444',  label: 'Task Failed' },
  milestone:          { icon: CheckCircle2,  color: '#10b981',  label: 'Milestone' },
  error:              { icon: AlertTriangle, color: '#ef4444',  label: 'Error' },
  search_query:       { icon: Search,        color: '#06b6d4',  label: 'Search' },
  search_result:      { icon: ArrowRight,    color: '#06b6d4',  label: 'Result' },
  api_call:           { icon: Server,        color: '#8b5cf6',  label: 'API Call' },
  memory_recall:      { icon: MemoryStick,   color: '#8b5cf6',  label: 'Memory' },
  model_switch:       { icon: RefreshCw,     color: '#f59e0b',  label: 'Model Switch' },
  context_compress:   { icon: Box,           color: '#f59e0b',  label: 'Compress' },
  session_start:      { icon: Zap,           color: '#10b981',  label: 'Session' },
  heartbeat:          { icon: Activity,      color: '#1f2937',  label: 'Heartbeat' },
};

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function fmtDuration(ms?: number) {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Connection Badge ──────────────────────────────────────────────

function ConnectionBadge({ connected, evCount }: { connected: boolean; evCount: number }) {
  return (
    <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium transition-all ${
      connected
        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
        : 'bg-red-500/10 text-red-400 border border-red-500/20'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
        connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'
      }`} />
      {connected ? 'Live' : 'Offline'}
      {evCount > 0 && <span className="opacity-50">· {evCount}</span>}
    </div>
  );
}

// ── Event Badge ───────────────────────────────────────────────────

function EventBadge({ type }: { type: string }) {
  const cfg = EVENT_CONFIG[type] || { icon: Activity, color: '#6b7280', label: type };
  const Icon = cfg.icon;
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-medium flex-shrink-0"
      style={{ backgroundColor: cfg.color + '18', color: cfg.color, border: `1px solid ${cfg.color}22` }}
    >
      <Icon className="w-2.5 h-2.5 flex-shrink-0" />
      {cfg.label}
    </span>
  );
}

// ── Live Event Row ────────────────────────────────────────────────

function LiveEventRow({ event, isNew }: { event: MonitorEvent; isNew: boolean }) {
  const cfg = EVENT_CONFIG[event.type] || { icon: Activity, color: '#6b7280', label: event.type };
  const Icon = cfg.icon;
  const [expanded, setExpanded] = useState(false);

  const getContent = (): string | null => {
    if (event.type === 'browser_nav' && event.url) return event.url;
    if (event.type === 'terminal_cmd' && event.cmd) return event.cmd;
    if (event.type === 'terminal_output' && event.output) return event.output.trim().slice(0, 400);
    if (event.type === 'file_write' && event.filePath) return event.filePath;
    if (event.type === 'file_read' && event.filePath) return event.filePath;
    if (event.type === 'file_delete' && event.filePath) return event.filePath;
    if (event.type === 'thought' && event.text) return event.text;
    if (event.type === 'search_query' && event.text) return event.text;
    if (event.type === 'search_result' && event.text) return event.text.slice(0, 300);
    if (event.type === 'tool_start' && event.tool) {
      const argsStr = event.args ? JSON.stringify(event.args).slice(0, 120) : '';
      return `${event.tool}(${argsStr})`;
    }
    if (event.type === 'tool_end' && event.tool) return `${event.tool} completed in ${fmtDuration(event.durationMs)}`;
    if (event.type === 'tool_error' && event.tool) return `${event.tool}: ${event.error?.slice(0, 120)}`;
    if (event.type === 'milestone' && event.text) return event.text;
    if (event.type === 'memory_recall' && event.text) return event.text.slice(0, 300);
    if (event.type === 'model_switch' && event.text) return event.text;
    if (event.text) return event.text.slice(0, 300);
    return null;
  };

  const content = getContent();
  if (event.type === 'heartbeat') return null;
  const isLong = content && content.length > 120;

  return (
    <motion.div
      initial={isNew ? { opacity: 0, x: 6, backgroundColor: cfg.color + '15' } : { opacity: 1 }}
      animate={{ opacity: 1, x: 0, backgroundColor: 'transparent' }}
      transition={{ duration: 0.25 }}
      className="flex items-start gap-2.5 px-3 py-2 hover:bg-white/[0.025] border-b border-white/[0.03] group cursor-default"
    >
      {/* Icon dot */}
      <div
        className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center mt-0.5"
        style={{ backgroundColor: cfg.color + '18' }}
      >
        <Icon className="w-3 h-3" style={{ color: cfg.color }} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
          <EventBadge type={event.type} />
          {event.tool && (
            <span className="text-[9px] font-mono text-white/25">{event.tool}</span>
          )}
          {event.durationMs != null && (
            <span className="text-[9px] text-white/20 ml-auto flex-shrink-0">{fmtDuration(event.durationMs)}</span>
          )}
        </div>
        {content && (
          <p
            className={`text-[11px] text-white/50 font-mono leading-relaxed break-all ${
              !expanded && isLong ? 'line-clamp-2' : ''
            }`}
          >
            {content}
          </p>
        )}
        {isLong && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="flex items-center gap-0.5 text-[9px] text-white/25 hover:text-white/50 mt-0.5 transition-colors"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {expanded ? 'collapse' : 'expand'}
          </button>
        )}
      </div>

      {/* Timestamp */}
      <span className="flex-shrink-0 text-[9px] text-white/15 font-mono mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {fmtTime(event.ts)}
      </span>
    </motion.div>
  );
}

// ── Browser View ─────────────────────────────────────────────────

function BrowserView({ events }: { events: MonitorEvent[] }) {
  const screenshots = events.filter(e => e.type === 'browser_screenshot' && e.screenshot);
  const navs = events.filter(e => e.type === 'browser_nav');
  const latestScreenshot = screenshots[screenshots.length - 1];
  const latestNav = navs[navs.length - 1];

  return (
    <div className="flex flex-col h-full">
      {/* Fake URL bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] bg-[#111] flex-shrink-0">
        <div className="flex gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
          <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
          <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
        </div>
        <div className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1 text-[11px] font-mono text-white/40 truncate">
          {latestNav?.url || 'No browser activity yet'}
        </div>
        <Globe className="w-3.5 h-3.5 text-blue-400/50 flex-shrink-0" />
      </div>

      {/* Screenshot area */}
      <div className="flex-1 overflow-hidden relative bg-[#080808]">
        {latestScreenshot?.screenshot ? (
          <motion.img
            key={latestScreenshot.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            src={`data:image/png;base64,${latestScreenshot.screenshot}`}
            className="w-full h-full object-contain"
            alt="Browser view"
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-white/20 p-4">
            <Globe className="w-10 h-10 opacity-20" />
            <div className="text-center">
              <p className="text-[13px] font-medium text-white/30">Browser View</p>
              <p className="text-[11px] mt-1">Screenshots appear when agent uses browser</p>
            </div>
            {navs.length > 0 && (
              <div className="w-full max-w-xs space-y-1 mt-2">
                {navs.slice(-5).reverse().map(ev => (
                  <div key={ev.id} className="flex items-center gap-2 text-[10px] text-white/30 px-2.5 py-1 bg-white/[0.03] rounded">
                    <Globe className="w-3 h-3 flex-shrink-0 text-blue-400/50" />
                    <span className="truncate font-mono">{ev.url}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {latestNav && latestScreenshot && (
          <div className="absolute bottom-2 left-2 right-2">
            <div className="bg-black/70 backdrop-blur-sm rounded px-2 py-1 text-[10px] font-mono text-white/50 truncate">
              {latestNav.url}
            </div>
          </div>
        )}
      </div>

      {/* Navigation history */}
      <div className="border-t border-white/[0.06] flex-shrink-0 max-h-32 overflow-y-auto custom-scrollbar">
        {navs.slice(-10).reverse().map((ev, i) => (
          <div key={ev.id} className={`flex items-center gap-2 px-3 py-1.5 text-[10px] border-b border-white/[0.03] ${
            i === 0 ? 'bg-blue-500/5 text-blue-300/60' : 'text-white/25'
          }`}>
            <Globe className="w-3 h-3 flex-shrink-0" />
            <span className="truncate font-mono">{ev.url}</span>
            <span className="flex-shrink-0 ml-auto text-white/20">{fmtTime(ev.ts)}</span>
          </div>
        ))}
        {navs.length === 0 && (
          <div className="flex items-center justify-center py-3 text-[10px] text-white/20">No navigation yet</div>
        )}
      </div>
    </div>
  );
}

// ── Terminal View ─────────────────────────────────────────────────

function TerminalView({ events }: { events: MonitorEvent[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  const cmds = events.filter(e => e.type === 'terminal_cmd' || e.type === 'terminal_output');

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [cmds.length]);

  return (
    <div className="flex flex-col h-full bg-[#070707]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] bg-[#0f0f0f] flex-shrink-0">
        <Terminal className="w-3.5 h-3.5 text-emerald-400" />
        <span className="text-[11px] font-mono text-white/40">Terminal</span>
        <span className="ml-auto text-[9px] font-mono text-white/20">{cmds.length} entries</span>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar p-3 font-mono text-[11px] leading-relaxed">
        {cmds.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-white/20">
            <Terminal className="w-8 h-8 opacity-20" />
            <p>No terminal activity yet</p>
          </div>
        ) : (
          <>
            {cmds.map(ev => (
              <div key={ev.id}>
                {ev.type === 'terminal_cmd' && (
                  <div className="flex items-start gap-2 mt-3 mb-0.5">
                    <span className="text-emerald-500 flex-shrink-0 select-none">❯</span>
                    <span className="text-emerald-300 break-all">{ev.cmd}</span>
                    <span className="ml-auto text-white/15 text-[9px] flex-shrink-0">{fmtTime(ev.ts)}</span>
                  </div>
                )}
                {ev.type === 'terminal_output' && (
                  <pre className="text-white/45 whitespace-pre-wrap break-all pl-4 text-[10px]">{ev.output}</pre>
                )}
              </div>
            ))}
            <div ref={endRef} />
          </>
        )}
      </div>
    </div>
  );
}

// ── Files View ────────────────────────────────────────────────────

function FilesView({ events }: { events: MonitorEvent[] }) {
  const fileEvents = events.filter(e => ['file_write','file_read','file_delete'].includes(e.type));

  const getFileStyle = (type: string) => {
    if (type === 'file_write') return { Icon: Download, color: '#f59e0b', label: 'wrote' };
    if (type === 'file_delete') return { Icon: X, color: '#ef4444', label: 'deleted' };
    return { Icon: FolderOpen, color: '#94a3b8', label: 'read' };
  };

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      {fileEvents.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full gap-3 text-white/20">
          <FolderOpen className="w-10 h-10 opacity-20" />
          <p className="text-sm">No file operations yet</p>
        </div>
      ) : (
        <div className="divide-y divide-white/[0.03]">
          {fileEvents.slice().reverse().map(ev => {
            const { Icon, color, label } = getFileStyle(ev.type);
            const parts = (ev.filePath || '?').replace(/\\/g, '/').split('/');
            const filename = parts.pop() || '?';
            const dir = parts.join('/');
            return (
              <div key={ev.id} className="flex items-start gap-3 px-3 py-2.5 hover:bg-white/[0.02]">
                <div className="w-7 h-7 rounded flex items-center justify-center flex-shrink-0" style={{ background: color + '15' }}>
                  <Icon className="w-3.5 h-3.5" style={{ color }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[12px] font-medium text-white/75 truncate">{filename}</span>
                    <EventBadge type={ev.type} />
                  </div>
                  {dir && <p className="text-[9px] font-mono text-white/20 truncate mt-0.5">{dir}</p>}
                </div>
                <span className="text-[9px] text-white/20 flex-shrink-0 font-mono mt-1">{fmtTime(ev.ts)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Thoughts View ─────────────────────────────────────────────────

function ThoughtsView({ events }: { events: MonitorEvent[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  const thoughts = events.filter(e =>
    ['thought','message','milestone','memory_recall','task_start','task_done','task_failed','model_switch','context_compress'].includes(e.type)
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thoughts.length]);

  return (
    <div className="h-full overflow-y-auto custom-scrollbar p-3 space-y-2">
      {thoughts.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full gap-3 text-white/20">
          <Brain className="w-10 h-10 opacity-20" />
          <p className="text-sm">Agent thoughts appear here in real-time</p>
        </div>
      ) : (
        <>
          {thoughts.map(ev => {
            const cfg = EVENT_CONFIG[ev.type] || { color: '#6b7280' };
            return (
              <motion.div
                key={ev.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-lg p-3 border"
                style={{ backgroundColor: cfg.color + '08', borderColor: cfg.color + '20' }}
              >
                <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                  <EventBadge type={ev.type} />
                  <span className="text-[9px] text-white/20 font-mono ml-auto">{fmtTime(ev.ts)}</span>
                </div>
                <p className="text-[11px] text-white/55 leading-relaxed whitespace-pre-wrap">
                  {ev.text || ''}
                </p>
              </motion.div>
            );
          })}
          <div ref={endRef} />
        </>
      )}
    </div>
  );
}

// ── Search View ───────────────────────────────────────────────────

function SearchView({ events }: { events: MonitorEvent[] }) {
  const searches = events.filter(e => ['search_query','search_result','api_call'].includes(e.type));

  return (
    <div className="h-full overflow-y-auto custom-scrollbar divide-y divide-white/[0.03]">
      {searches.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full gap-3 text-white/20">
          <Search className="w-10 h-10 opacity-20" />
          <p className="text-sm">Search & API activity here</p>
        </div>
      ) : (
        searches.slice().reverse().map(ev => (
          <div key={ev.id} className="px-3 py-2.5 hover:bg-white/[0.02]">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <EventBadge type={ev.type} />
              <span className="text-[9px] text-white/20 font-mono ml-auto">{fmtTime(ev.ts)}</span>
            </div>
            <p className="text-[11px] text-white/50 leading-relaxed line-clamp-4">{ev.text}</p>
          </div>
        ))
      )}
    </div>
  );
}

// ── Stats Bar ─────────────────────────────────────────────────────

function StatsBar({ events }: { events: MonitorEvent[] }) {
  const toolsDone = events.filter(e => e.type === 'tool_end').length;
  const errors = events.filter(e => e.type === 'tool_error' || e.type === 'error').length;
  const filesWritten = events.filter(e => e.type === 'file_write').length;
  const searches = events.filter(e => e.type === 'search_query').length;
  const lastEvent = events.filter(e => e.type !== 'heartbeat').at(-1);

  const avgDuration = (() => {
    const durations = events
      .filter(e => e.type === 'tool_end' && e.durationMs)
      .map(e => e.durationMs!);
    if (!durations.length) return null;
    return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  })();

  const stats = [
    { label: 'Tools',  value: toolsDone,                              color: '#3b82f6', icon: Zap },
    { label: 'Errors', value: errors,                                 color: errors > 0 ? '#ef4444' : '#374151', icon: XCircle },
    { label: 'Files',  value: filesWritten,                           color: '#f59e0b', icon: FileText },
    { label: 'Searches', value: searches,                             color: '#06b6d4', icon: Search },
    { label: 'Avg',    value: avgDuration ? fmtDuration(avgDuration) : '—', color: '#6b7280', icon: Clock },
  ];

  return (
    <div className="flex items-stretch border-t border-white/[0.06] bg-[#090909] flex-shrink-0 overflow-x-auto eterx-tab-strip-scroll">
      {stats.map(({ label, value, color, icon: Icon }) => (
        <div key={label} className="flex items-center gap-1.5 px-2.5 py-2 border-r border-white/[0.05] flex-shrink-0">
          <Icon className="w-3 h-3" style={{ color }} />
          <span className="text-[9px] text-white/25">{label}</span>
          <span className="text-[10px] font-mono font-semibold" style={{ color }}>{value}</span>
        </div>
      ))}
      {lastEvent && (
        <div className="flex items-center gap-1.5 px-2.5 py-2 ml-auto flex-shrink-0">
          <Activity className="w-3 h-3 text-white/15" />
          <span className="text-[9px] text-white/20 font-mono">{fmtTime(lastEvent.ts)}</span>
        </div>
      )}
    </div>
  );
}

// ── Active Tool Card ──────────────────────────────────────────────

function ActiveToolCard({ event }: { event: MonitorEvent | null }) {
  if (!event) return null;
  const cfg = EVENT_CONFIG[event.type] || { icon: Activity, color: '#6b7280', label: event.type };
  const Icon = cfg.icon;

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={event.id}
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 4 }}
        className="flex items-center gap-2.5 px-3 py-2 border-b border-white/[0.06] flex-shrink-0"
        style={{ background: `linear-gradient(90deg, ${cfg.color}10, transparent 80%)` }}
      >
        <div className="w-6 h-6 rounded flex items-center justify-center flex-shrink-0" style={{ background: cfg.color + '20' }}>
          <Icon className="w-3.5 h-3.5" style={{ color: cfg.color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold text-white/70">{cfg.label}</span>
            {event.tool && <span className="text-[9px] font-mono text-white/25">· {event.tool}</span>}
          </div>
          {(event.cmd || event.url || event.filePath || event.text) && (
            <p className="text-[10px] text-white/30 font-mono truncate mt-0.5">
              {event.cmd || event.url || event.filePath || event.text?.slice(0, 80)}
            </p>
          )}
        </div>
        <Loader2 className="w-3.5 h-3.5 text-white/20 animate-spin flex-shrink-0" />
      </motion.div>
    </AnimatePresence>
  );
}

// ── Main Monitor Panel ────────────────────────────────────────────

export interface MonitorPanelProps {
  isOpen: boolean;
  onClose: () => void;
  chatId?: string | null;
  defaultWidth?: number;
}

export function MonitorPanel({ isOpen, onClose, chatId, defaultWidth = 480 }: MonitorPanelProps) {
  const [events, setEvents] = useState<MonitorEvent[]>([]);
  const [newEventIds, setNewEventIds] = useState<Set<string>>(new Set());
  const [connected, setConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('live');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(defaultWidth);
  const liveEndRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectRef = useRef<NodeJS.Timeout | null>(null);
  const newEvTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isResizingRef = useRef(false);
  const resizeStartRef = useRef({ x: 0, width: 0 });

  const getTabCount = useCallback((tab: TabConfig) => {
    if (tab.id === 'live' || tab.eventTypes.length === 0) return 0;
    return events.filter(e => tab.eventTypes.includes(e.type)).length;
  }, [events]);

  // Last active tool (tool_start without subsequent tool_end)
  const activeToolEvent = (() => {
    const recent = events.slice(-30);
    const lastStart = [...recent].reverse().find(e => e.type === 'tool_start');
    const lastEnd = [...recent].reverse().find(e => e.type === 'tool_end' || e.type === 'tool_error');
    if (!lastStart) return null;
    if (lastEnd && lastEnd.ts > lastStart.ts) return null;
    if (Date.now() - lastStart.ts > 30_000) return null;
    return lastStart;
  })();

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    const es = new EventSource('/api/monitor/stream');
    esRef.current = es;
    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as MonitorEvent;
        if (ev.type === 'connected') { setConnected(true); return; }
        if (ev.type === 'heartbeat') return;
        if (chatId && ev.chatId && ev.chatId !== chatId) return;
        setEvents(prev => [...prev, ev].slice(-1000));
        setNewEventIds(prev => new Set([...prev, ev.id]));
        if (newEvTimerRef.current) clearTimeout(newEvTimerRef.current);
        newEvTimerRef.current = setTimeout(() => setNewEventIds(new Set()), 2500);
      } catch { }
    };
    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      reconnectRef.current = setTimeout(() => connect(), 3000);
    };
  }, [chatId]);

  useEffect(() => {
    if (!isOpen) return;
    connect();
    return () => {
      esRef.current?.close();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, [isOpen, connect]);

  // Auto-scroll live tab
  useEffect(() => {
    if (activeTab === 'live') {
      liveEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events.length, activeTab]);

  // Panel resize drag
  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    resizeStartRef.current = { x: e.clientX, width: panelWidth };
    const onMove = (mv: MouseEvent) => {
      if (!isResizingRef.current) return;
      const delta = resizeStartRef.current.x - mv.clientX;
      const next = Math.max(320, Math.min(900, resizeStartRef.current.width + delta));
      setPanelWidth(next);
    };
    const onUp = () => {
      isResizingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (!isOpen) return null;

  const visibleEvents = events.filter(e => e.type !== 'heartbeat');
  const actualWidth = isFullscreen ? '100%' : `${panelWidth}px`;

  return (
    <motion.div
      initial={{ opacity: 0, x: 32 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 32 }}
      transition={{ type: 'spring', damping: 30, stiffness: 300 }}
      className="relative flex flex-col h-full border-l border-white/[0.07] bg-[#0b0b0b] overflow-hidden z-30"
      style={{ width: actualWidth, minWidth: isFullscreen ? undefined : '320px' }}
    >
      {/* Resize handle */}
      {!isFullscreen && (
        <div
          onMouseDown={onResizeMouseDown}
          className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#E2765A]/40 transition-colors z-50 group"
        >
          <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-8 bg-white/10 group-hover:bg-[#E2765A]/60 rounded-full transition-colors" />
        </div>
      )}

      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.07] bg-[#0e0e0e] flex-shrink-0">
        <div className="w-5 h-5 rounded bg-[#E2765A]/15 flex items-center justify-center flex-shrink-0">
          <Monitor className="w-3 h-3 text-[#E2765A]" />
        </div>
        <span className="text-[12px] font-semibold text-white/75 tracking-wide">Monitor</span>
        <ConnectionBadge connected={connected} evCount={visibleEvents.length} />
        <div className="ml-auto flex items-center gap-0.5">
          <button
            onClick={() => setEvents([])}
            title="Clear"
            className="p-1.5 rounded hover:bg-white/[0.05] text-white/25 hover:text-white/60 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setIsFullscreen(f => !f)}
            title={isFullscreen ? 'Restore' : 'Fullscreen'}
            className="p-1.5 rounded hover:bg-white/[0.05] text-white/25 hover:text-white/60 transition-colors"
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-white/[0.05] text-white/25 hover:text-white/60 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Active tool banner ── */}
      <ActiveToolCard event={activeToolEvent} />

      {/* ── Tab Bar ── */}
      <div className="flex items-stretch border-b border-white/[0.06] bg-[#0b0b0b] overflow-x-auto flex-shrink-0 eterx-tab-strip-scroll">
        {TABS.map(tab => {
          const Icon = tab.icon;
          const count = getTabCount(tab);
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium whitespace-nowrap border-b-2 flex-shrink-0 transition-all ${
                active
                  ? 'border-current'
                  : 'border-transparent text-white/30 hover:text-white/55 hover:bg-white/[0.02]'
              }`}
              style={active ? { color: tab.color, borderColor: tab.color } : {}}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
              {count > 0 && (
                <span
                  className="text-[9px] px-1 py-0.5 rounded-full font-mono leading-none"
                  style={{ backgroundColor: tab.color + '20', color: tab.color }}
                >
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'live' && (
          <div className="h-full overflow-y-auto custom-scrollbar">
            {visibleEvents.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-4 text-white/20 p-6">
                <div className="w-12 h-12 rounded-xl bg-white/[0.03] border border-white/[0.04] flex items-center justify-center">
                  <Activity className="w-6 h-6" />
                </div>
                <div className="text-center">
                  <p className="text-[13px] font-medium text-white/30">Waiting for agent</p>
                  <p className="text-[11px] mt-1 leading-relaxed">
                    {connected
                      ? 'Stream connected — send a message to start'
                      : 'Connecting to event stream...'}
                  </p>
                </div>
                {!connected && (
                  <div className="flex items-center gap-2 text-[10px] text-yellow-400/50">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Reconnecting...
                  </div>
                )}
              </div>
            ) : (
              <>
                {visibleEvents.map(ev => (
                  <LiveEventRow key={ev.id} event={ev} isNew={newEventIds.has(ev.id)} />
                ))}
                <div ref={liveEndRef} />
              </>
            )}
          </div>
        )}
        {activeTab === 'browser'  && <BrowserView  events={events} />}
        {activeTab === 'terminal' && <TerminalView events={events} />}
        {activeTab === 'files'    && <FilesView    events={events} />}
        {activeTab === 'thoughts' && <ThoughtsView events={events} />}
        {activeTab === 'search'   && <SearchView   events={events} />}
      </div>

      {/* ── Stats Bar ── */}
      <StatsBar events={events} />
    </motion.div>
  );
}
