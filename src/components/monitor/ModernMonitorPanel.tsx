'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Code2,
  FileText,
  FolderOpen,
  Globe2,
  ListTodo,
  Minimize2,
  Monitor,
  PanelRightClose,
  Play,
  Search,
  Square,
  Terminal,
  X,
  XCircle,
  Zap,
} from 'lucide-react';

export interface MonitorEvent {
  id: string;
  type: string;
  ts: number;
  chatId?: string;
  tool?: string;
  args?: unknown;
  result?: unknown;
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
  appName?: string;
  appPid?: number;
  appTitle?: string;
  frameData?: string;
  frameWidth?: number;
  frameHeight?: number;
  frameQuality?: number;
  actionCount?: number;
  meta?: unknown;
}

export interface MonitorPanelProps {
  isOpen: boolean;
  onClose: () => void;
  chatId?: string | null;
  defaultWidth?: number;
}

type MonitorMode = 'computer' | 'browser' | 'terminal' | 'files' | 'thoughts' | 'search' | 'timeline';

type ModeConfig = {
  id: MonitorMode;
  label: string;
  icon: React.FC<{ className?: string }>;
  eventTypes: string[];
};

function isUsefulLiveFrame(event: MonitorEvent) {
  if (event.type !== 'live_frame' || !event.frameData) return false;
  // Empty isolated desktops compress into tiny two-tone JPEGs. Those should not
  // replace real browser/app screenshots in the Computer view.
  return event.frameData.length > 12000;
}

function isVisualFrame(event: MonitorEvent) {
  if (event.type === 'live_frame') return isUsefulLiveFrame(event);
  return (event.type === 'desktop_screenshot' || event.type === 'browser_screenshot') && !!event.screenshot;
}

function visualFrameScore(event: MonitorEvent) {
  if (event.type === 'browser_screenshot') return event.ts + 30000;
  if (event.type === 'desktop_screenshot') return event.ts + 20000;
  return event.ts;
}

const MODES: ModeConfig[] = [
  {
    id: 'computer',
    label: 'Computer',
    icon: Monitor,
    eventTypes: [
      'live_frame',
      'desktop_screenshot',
      'browser_screenshot',
      'browser_nav',
      'desktop_action',
      'app_connected',
      'app_disconnected',
      'app_state',
      'user_takeover',
      'agent_takeover',
    ],
  },
  { id: 'browser', label: 'Browser', icon: Globe2, eventTypes: ['browser_nav', 'browser_screenshot'] },
  { id: 'terminal', label: 'Terminal', icon: Terminal, eventTypes: ['terminal_cmd', 'terminal_output'] },
  { id: 'files', label: 'Files', icon: FolderOpen, eventTypes: ['file_write', 'file_read', 'file_delete'] },
  { id: 'thoughts', label: 'Thoughts', icon: Brain, eventTypes: ['thought', 'message', 'milestone', 'memory_recall', 'model_switch', 'context_compress'] },
  { id: 'search', label: 'Search', icon: Search, eventTypes: ['search_query', 'search_result', 'api_call'] },
  { id: 'timeline', label: 'Timeline', icon: Activity, eventTypes: [] },
];

const EVENT_LABEL: Record<string, string> = {
  tool_start: 'Tool started',
  tool_end: 'Tool completed',
  tool_error: 'Tool failed',
  browser_nav: 'Navigating',
  browser_screenshot: 'Viewing page',
  desktop_screenshot: 'Viewing desktop',
  desktop_action: 'Desktop action',
  app_connected: 'Connected app',
  app_disconnected: 'Disconnected app',
  app_state: 'App state',
  user_takeover: 'User control',
  agent_takeover: 'Agent control',
  live_frame: 'Live frame',
  terminal_cmd: 'Running command',
  terminal_output: 'Terminal output',
  file_write: 'Writing file',
  file_read: 'Reading file',
  file_delete: 'Deleting file',
  thought: 'Thinking',
  message: 'Message',
  milestone: 'Milestone',
  search_query: 'Searching',
  search_result: 'Search result',
  api_call: 'API call',
  memory_recall: 'Memory recall',
  model_switch: 'Model switch',
  context_compress: 'Context compression',
  task_start: 'Task started',
  task_done: 'Task complete',
  task_failed: 'Task failed',
  error: 'Error',
  session_start: 'Session started',
};

const EVENT_ICON: Record<string, React.FC<{ className?: string }>> = {
  tool_start: Play,
  tool_end: CheckCircle2,
  tool_error: XCircle,
  browser_nav: Globe2,
  browser_screenshot: Monitor,
  desktop_screenshot: Monitor,
  desktop_action: Monitor,
  app_connected: Monitor,
  app_disconnected: XCircle,
  app_state: Activity,
  user_takeover: PanelRightClose,
  agent_takeover: Play,
  live_frame: Monitor,
  terminal_cmd: Terminal,
  terminal_output: Code2,
  file_write: FileText,
  file_read: FolderOpen,
  file_delete: X,
  thought: Brain,
  message: Activity,
  milestone: CheckCircle2,
  search_query: Search,
  search_result: Search,
  api_call: Zap,
  memory_recall: Brain,
  model_switch: Activity,
  context_compress: FileText,
  task_start: Zap,
  task_done: CheckCircle2,
  task_failed: XCircle,
  error: AlertTriangle,
  session_start: Zap,
};

function formatClock(ts?: number) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatElapsed(ts?: number) {
  if (!ts) return '0:00';
  const totalSeconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function formatDuration(ms?: number) {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function eventLabel(type: string) {
  return EVENT_LABEL[type] || type.replace(/_/g, ' ');
}

function eventContent(event: MonitorEvent) {
  if (event.cmd) return event.cmd;
  if (event.url) return event.url;
  if (event.filePath) return event.filePath;
  if (event.appTitle) return event.appTitle;
  if (event.appName) return event.appName;
  if (event.error) return event.error;
  if (event.output) return event.output.trim();
  if (event.text) return event.text;
  if (event.tool) return event.tool;
  return eventLabel(event.type);
}

function activityState(event: MonitorEvent | null, connected: boolean) {
  if (!connected) return 'Offline';
  if (!event) return 'Idle';
  if (event.type === 'tool_error' || event.type === 'task_failed' || event.type === 'error') return 'Needs attention';
  if (event.type === 'tool_end' || event.type === 'task_done' || event.type === 'milestone') return 'Complete';
  return 'Thinking';
}

function modeEvents(events: MonitorEvent[], mode: MonitorMode) {
  const visible = events.filter(event => event.type !== 'heartbeat' && event.type !== 'connected');
  if (mode === 'timeline') return visible;
  const config = MODES.find(item => item.id === mode);
  if (!config) return visible;
  return visible.filter(event => config.eventTypes.includes(event.type));
}

function EmptyState({
  icon: Icon,
  title,
  detail,
  variant = 'panel',
}: {
  icon: React.FC<{ className?: string }>;
  title: string;
  detail: string;
  variant?: 'panel' | 'screen';
}) {
  if (variant === 'screen') {
    return (
      <div className="flex h-full min-h-[320px] flex-col items-center justify-center px-6 text-center">
        <div className="relative mb-7 flex h-16 w-16 items-center justify-center">
          <Icon className="h-12 w-12 text-white/72" />
          <span className="absolute h-[2px] w-16 rotate-[-36deg] rounded-full bg-white/80 shadow-[0_0_10px_rgba(255,255,255,0.26)]" />
        </div>
        <p className="text-[15px] font-semibold text-white/72">{title}</p>
        <p className="mt-3 max-w-md text-[13px] leading-6 text-white/30">{detail}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.04]">
        <Icon className="h-5 w-5 text-white/35" />
      </div>
      <div>
        <p className="text-sm font-semibold text-white/70">{title}</p>
        <p className="mt-1 max-w-sm text-xs leading-5 text-white/35">{detail}</p>
      </div>
    </div>
  );
}

function MonitorIconButton({
  label,
  onClick,
  children,
  active = false,
  disabled = false,
}: {
  label: string;
  onClick?: () => void;
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-9 w-9 items-center justify-center rounded-xl border transition-all ${
        active
          ? 'border-sky-400/30 bg-sky-400/12 text-sky-300'
          : 'border-transparent bg-transparent text-white/50 hover:border-white/[0.12] hover:bg-white/[0.06] hover:text-white/82'
      } ${disabled ? 'cursor-not-allowed opacity-35 hover:border-transparent hover:bg-transparent hover:text-white/50' : ''}`}
    >
      {children}
    </button>
  );
}

function ModeSwitcher({
  mode,
  events,
  onChange,
}: {
  mode: MonitorMode;
  events: MonitorEvent[];
  onChange: (mode: MonitorMode) => void;
}) {
  return (
    <div className="flex min-h-10 items-center gap-1 overflow-x-auto rounded-2xl border border-white/[0.075] bg-black/18 p-1 eterx-tab-strip-scroll">
      {MODES.map(item => {
        const Icon = item.icon;
        const active = mode === item.id;
        const count = modeEvents(events, item.id).length;

        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            className={`flex h-8 shrink-0 items-center gap-2 rounded-xl px-3 text-xs font-medium transition-all ${
              active
                ? 'bg-white/[0.095] text-white shadow-[0_10px_24px_rgba(0,0,0,0.22)]'
                : 'text-white/42 hover:bg-white/[0.055] hover:text-white/72'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{item.label}</span>
            {count > 0 && item.id !== 'timeline' && (
              <span className="rounded-full bg-white/[0.08] px-1.5 py-0.5 text-[10px] leading-none text-white/45">
                {count > 99 ? '99+' : count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function ComputerStage({
  events,
  connected,
  streamBusy,
  streaming,
  onStartStream,
  onStopStream,
}: {
  events: MonitorEvent[];
  connected: boolean;
  streamBusy: boolean;
  streaming: boolean;
  onStartStream: () => void;
  onStopStream: () => void;
}) {
  const frames = events
    .filter(isVisualFrame)
    .sort((a, b) => visualFrameScore(a) - visualFrameScore(b));
  const navs = events.filter(event => event.type === 'browser_nav' && event.url);
  const latestNav = navs[navs.length - 1];
  const latestFrame = frames[frames.length - 1] || null;
  const latestApp = [...events].reverse().find(event => event.appTitle || event.appName);
  const activeSource = latestFrame
    ? latestFrame.url ||
      latestFrame.appTitle ||
      latestFrame.appName ||
      [...navs].reverse().find(event => event.ts <= latestFrame.ts)?.url ||
      latestNav?.url
    : latestNav?.url;
  const imageSrc = latestFrame?.frameData
    ? `data:image/jpeg;base64,${latestFrame.frameData}`
    : latestFrame?.screenshot
      ? `data:image/png;base64,${latestFrame.screenshot}`
      : null;
  const isLiveFrame = latestFrame?.type === 'live_frame';

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-white/[0.09] bg-[#111] shadow-[0_24px_70px_rgba(0,0,0,0.36)]">
      <div className="relative min-h-[540px] flex-1 overflow-hidden bg-black">
        {imageSrc ? (
          <motion.img
            key={latestFrame.id}
            initial={{ opacity: 0.42 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: isLiveFrame ? 0.08 : 0.18 }}
            src={imageSrc}
            alt="Live agent computer frame"
            className="h-full w-full bg-white object-contain"
          />
        ) : (
          <EmptyState
            icon={Monitor}
            title={connected ? 'EterX Computer not active' : 'Computer stream offline'}
            detail={connected ? 'Live computer screen will appear here when agent starts using the browser, desktop, or a connected app.' : 'The panel will reconnect automatically and keep the computer stream ready.'}
            variant="screen"
          />
        )}

        {activeSource && !imageSrc && (
          <div className="absolute bottom-5 left-5 right-5 rounded-2xl border border-white/[0.08] bg-black/55 px-4 py-3 backdrop-blur-md">
            <p className="truncate font-mono text-xs text-white/55">{activeSource}</p>
          </div>
        )}
      </div>

      <div className="flex h-14 shrink-0 items-center gap-4 border-t border-white/[0.06] bg-[#1b1b1b] px-5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onStartStream}
            disabled={streamBusy || streaming}
            aria-label="Start live computer stream"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-white/55 transition hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Play className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onStopStream}
            disabled={streamBusy || !streaming}
            aria-label="Stop live computer stream"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-white/55 transition hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Square className="h-4 w-4" />
          </button>
        </div>

        <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-sky-500 shadow-[0_0_18px_rgba(14,165,233,0.42)] transition-[width] duration-200"
            style={{ width: connected ? '100%' : '14%' }}
          />
          {streaming && (
            <div className="absolute inset-y-0 left-0 w-1/3 animate-[pulse_1.2s_ease-in-out_infinite] rounded-full bg-white/25" />
          )}
        </div>

        <div className="flex items-center gap-2 rounded-full px-2.5 py-1 text-sm text-white/78">
          <span className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-emerald-500 shadow-[0_0_12px_rgba(34,197,94,0.7)]' : 'bg-red-400'}`} />
          <span>{streaming ? 'live stream' : connected ? 'connected' : 'offline'}</span>
        </div>
      </div>
    </div>
  );
}


function BrowserStage({
  events,
  screenshotIndex,
  setScreenshotIndex,
  connected,
}: {
  events: MonitorEvent[];
  screenshotIndex: number;
  setScreenshotIndex: (i: number) => void;
  connected: boolean;
}) {
  const screenshots = events.filter(ev => ev.type === 'browser_screenshot' && ev.screenshot);
  const navs = events.filter(ev => ev.type === 'browser_nav' && ev.url);
  const current = screenshots[screenshotIndex] ?? null;
  const latestNav = navs[navs.length - 1];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-white/[0.09] bg-[#111] shadow-[0_24px_70px_rgba(0,0,0,0.36)]">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.055] bg-[#171717] px-5">
        <p className="max-w-full truncate font-mono text-[13px] font-semibold text-white/43">
          {latestNav?.url ?? 'Browser'}
        </p>
        <div className="flex items-center gap-2 text-xs text-white/35">
          <button type="button" disabled={screenshotIndex <= 0} onClick={() => setScreenshotIndex(screenshotIndex - 1)} className="disabled:opacity-20 hover:text-white/70">‹</button>
          <span>{screenshots.length ? screenshotIndex + 1 : 0}/{Math.max(1, screenshots.length)}</span>
          <button type="button" disabled={screenshotIndex >= screenshots.length - 1} onClick={() => setScreenshotIndex(screenshotIndex + 1)} className="disabled:opacity-20 hover:text-white/70">›</button>
        </div>
      </div>
      <div className="relative min-h-[340px] flex-1 overflow-hidden bg-[#080808]">
        {current?.screenshot ? (
          <img src={`data:image/png;base64,${current.screenshot}`} alt="Browser screenshot" className="h-full w-full object-contain" />
        ) : (
          <EmptyState icon={Globe2} title={connected ? 'Waiting for browser frames' : 'Monitor offline'} detail="Screenshots captured by the browser agent will appear here in real-time." />
        )}
      </div>
    </div>
  );
}

function TerminalStage({ events }: { events: MonitorEvent[] }) {

  const terminalEvents = modeEvents(events, 'terminal');

  if (terminalEvents.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-hidden rounded-[20px] border border-white/[0.09] bg-[#101010]">
        <EmptyState icon={Terminal} title="No terminal activity" detail="Commands and streaming output will appear when the agent uses the shell." />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto rounded-[20px] border border-white/[0.09] bg-[#090909] p-4 font-mono text-xs custom-scrollbar">
      {terminalEvents.map(event => (
        <div key={event.id} className="mb-3 last:mb-0">
          {event.type === 'terminal_cmd' ? (
            <div className="flex items-start gap-2 rounded-xl border border-emerald-400/12 bg-emerald-400/[0.055] px-3 py-2 text-emerald-200/90">
              <span className="select-none text-emerald-400">$</span>
              <span className="min-w-0 flex-1 break-all">{event.cmd}</span>
              <span className="shrink-0 text-[10px] text-emerald-100/30">{formatClock(event.ts)}</span>
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words px-3 py-1.5 text-white/48">{event.output}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

function ListStage({
  mode,
  events,
}: {
  mode: MonitorMode;
  events: MonitorEvent[];
}) {
  const filtered = modeEvents(events, mode).slice().reverse();
  const config = MODES.find(item => item.id === mode) || MODES[0];
  const Icon = config.icon;

  if (filtered.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-hidden rounded-[20px] border border-white/[0.09] bg-[#101010]">
        <EmptyState icon={Icon} title={`No ${config.label.toLowerCase()} activity`} detail="Relevant agent events will appear here as soon as they are emitted." />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto rounded-[20px] border border-white/[0.09] bg-[#101010] p-3 custom-scrollbar">
      <div className="space-y-2">
        {filtered.map(event => {
          const EventIcon = EVENT_ICON[event.type] || Activity;
          const content = eventContent(event);

          return (
            <motion.div
              key={event.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-2xl border border-white/[0.065] bg-white/[0.035] px-3.5 py-3 transition hover:border-white/[0.12] hover:bg-white/[0.055]"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-white/62">
                  <EventIcon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-sm font-semibold text-white/76">{eventLabel(event.type)}</p>
                    {event.durationMs != null && <span className="text-[10px] text-white/35">{formatDuration(event.durationMs)}</span>}
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-white/35">{formatClock(event.ts)}</p>
                </div>
              </div>
              {content && (
                <p className="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-xs leading-5 text-white/50">
                  {content}
                </p>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function ActivityCard({
  event,
  connected,
  expanded,
  onToggleExpanded,
  recentEvents,
}: {
  event: MonitorEvent | null;
  connected: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  recentEvents: MonitorEvent[];
}) {
  const status = activityState(event, connected);
  const title = event ? eventContent(event) : 'No tasks';

  return (
    <div className="shrink-0 rounded-[15px] border border-white/[0.075] bg-white/[0.032] px-3.5 py-2 shadow-[0_12px_28px_rgba(0,0,0,0.18)]">
      <button
        type="button"
        onClick={onToggleExpanded}
        className="flex min-h-8 w-full items-center gap-3 text-left"
        aria-expanded={expanded}
      >
        <ListTodo className="h-4 w-4 shrink-0 text-white/42" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-white/82">{title}</p>
          {event && (
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-white/36">
              <span>{formatElapsed(event.ts)}</span>
              <span>{status}</span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3 text-sm text-white/45">
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </div>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="mt-2 space-y-1.5 border-t border-white/[0.06] pt-2">
              {recentEvents.length === 0 ? (
                <p className="text-xs text-white/35">No activity has been captured yet.</p>
              ) : (
                recentEvents.slice(-4).reverse().map(item => {
                  const Icon = EVENT_ICON[item.type] || Activity;
                  return (
                    <div key={item.id} className="flex items-center gap-2 rounded-xl bg-black/16 px-2.5 py-2">
                      <Icon className="h-3.5 w-3.5 shrink-0 text-white/42" />
                      <p className="min-w-0 flex-1 truncate text-xs text-white/52">{eventContent(item)}</p>
                      <span className="shrink-0 text-[10px] text-white/28">{formatClock(item.ts)}</span>
                    </div>
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function MonitorPanel({ isOpen, onClose, chatId, defaultWidth = 640 }: MonitorPanelProps) {
  const [events, setEvents] = useState<MonitorEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [mode, setMode] = useState<MonitorMode>('computer');
  const [panelWidth, setPanelWidth] = useState(defaultWidth);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamBusy, setStreamBusy] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeRef = useRef({ active: false, x: 0, width: defaultWidth });

  const visibleEvents = useMemo(
    () => events.filter(event => event.type !== 'heartbeat' && event.type !== 'connected'),
    [events],
  );
  const latestEvent = visibleEvents[visibleEvents.length - 1] || null;
  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const params = new URLSearchParams();
    if (chatId) params.set('chatId', chatId);
    const source = new EventSource(`/api/monitor/live${params.toString() ? `?${params.toString()}` : ''}`);
    eventSourceRef.current = source;
    source.onopen = () => setConnected(true);
    source.onmessage = event => {
      try {
        const parsed = JSON.parse(event.data) as MonitorEvent;
        if (parsed.type === 'connected' || parsed.type === 'ping') {
          setConnected(true);
          return;
        }
        if (parsed.type === 'heartbeat') return;
        const isVisualEvent = parsed.type === 'live_frame' || parsed.type === 'desktop_screenshot' || parsed.type === 'browser_screenshot';
        if (chatId && parsed.chatId && parsed.chatId !== chatId && !isVisualEvent) return;
        if (parsed.type === 'live_frame') setStreaming(true);
        setEvents(previous => [...previous, parsed].slice(-1000));
      } catch {
        // Ignore malformed monitor payloads so the UI stream remains alive.
      }
    };
    source.onerror = () => {
      setConnected(false);
      source.close();
      eventSourceRef.current = null;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(connect, 3000);
    };
  }, [chatId]);

  const controlStream = useCallback(async (action: 'start_stream' | 'stop_stream') => {
    setStreamBusy(true);
    setStreamError(null);
    try {
      const response = await fetch('/api/monitor/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          chatId: chatId || '',
          fps: 5,
          quality: 65,
          maxWidth: 1280,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.error || `Unable to ${action.replace('_', ' ')}`);
      }
      setStreaming(action === 'start_stream');
    } catch (error) {
      setStreamError(error instanceof Error ? error.message : 'Unable to control live stream');
    } finally {
      setStreamBusy(false);
    }
  }, [chatId]);

  useEffect(() => {
    if (!isOpen) return;
    connect();
    return () => {
      eventSourceRef.current?.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, [connect, isOpen]);

  useEffect(() => {
    setPanelWidth(defaultWidth);
  }, [defaultWidth]);

  const onResizeMouseDown = (event: React.MouseEvent) => {
    event.preventDefault();
    resizeRef.current = { active: true, x: event.clientX, width: panelWidth };

    const onMove = (moveEvent: MouseEvent) => {
      if (!resizeRef.current.active) return;
      const delta = resizeRef.current.x - moveEvent.clientX;
      setPanelWidth(Math.max(460, Math.min(880, resizeRef.current.width + delta)));
    };

    const onUp = () => {
      resizeRef.current.active = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (!isOpen) return null;

  return (
    <motion.aside
      initial={{ opacity: 0, x: 36, scale: 0.992 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 36, scale: 0.992 }}
      transition={{ type: 'spring', damping: 34, stiffness: 310 }}
      className="relative z-30 my-2 mr-3 flex h-[calc(100%-16px)] min-h-0 shrink-0 flex-col overflow-hidden rounded-[30px] border border-white/[0.09] bg-[#202020] shadow-[0_28px_90px_rgba(0,0,0,0.42)]"
      style={{ width: isFullscreen ? 'calc(100% - 24px)' : `${panelWidth}px`, minWidth: isFullscreen ? undefined : 460 }}
    >
      {!isFullscreen && (
        <button
          type="button"
          onMouseDown={onResizeMouseDown}
          aria-label="Resize monitor panel"
          className="absolute left-0 top-0 z-40 h-full w-2 cursor-col-resize"
        >
          <span className="absolute left-1 top-1/2 h-16 w-0.5 -translate-y-1/2 rounded-full bg-white/10 opacity-0 transition group-hover:opacity-100" />
        </button>
      )}

      <div className="flex shrink-0 items-start justify-between gap-4 px-5 pb-2.5 pt-4">
        <div className="min-w-0">
          <h2 className="truncate text-[21px] font-semibold tracking-[-0.01em] text-white/86">EterX Computer</h2>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <MonitorIconButton label="Show live computer view" onClick={() => setMode('computer')} active={mode === 'computer'}>
            <Monitor className="h-[19px] w-[19px]" />
          </MonitorIconButton>
          <MonitorIconButton label={isFullscreen ? 'Restore monitor panel' : 'Expand monitor panel'} onClick={() => setIsFullscreen(value => !value)}>
            {isFullscreen ? <Minimize2 className="h-[19px] w-[19px]" /> : <Square className="h-[19px] w-[19px]" />}
          </MonitorIconButton>
          <MonitorIconButton label="Close monitor" onClick={onClose}>
            <X className="h-[22px] w-[22px]" />
          </MonitorIconButton>
        </div>
      </div>

      {streamError && (
        <div className="px-5 pb-3">
          <div className="rounded-xl border border-red-400/15 bg-red-400/[0.06] px-3 py-2 text-xs text-red-200/70">
            {streamError}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pb-5">
        {mode === 'computer' && (
          <ComputerStage
            events={events}
            connected={connected}
            streamBusy={streamBusy}
            streaming={streaming}
            onStartStream={() => void controlStream('start_stream')}
            onStopStream={() => void controlStream('stop_stream')}
          />
        )}

        <ActivityCard
          event={latestEvent}
          connected={connected}
          expanded={activityExpanded}
          onToggleExpanded={() => setActivityExpanded(value => !value)}
          recentEvents={visibleEvents}
        />
      </div>

      <div className="pointer-events-none absolute inset-0 rounded-[30px] ring-1 ring-inset ring-white/[0.035]" />
      <div className="pointer-events-none absolute left-0 right-0 top-0 h-px bg-white/[0.16]" />
    </motion.aside>
  );
}

export default MonitorPanel;
