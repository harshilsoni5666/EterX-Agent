"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Sidebar } from '../components/layout/sidebar';
import { ChatInput } from '../components/layout/chat-input';
import { ChatFeed } from '../components/chat/chat-feed';
import { AlertTriangle, CheckCircle2, ChevronDown, Clock3, Code2, GraduationCap, List, MessageSquare, Pencil, PenTool, SendHorizontal, SquarePen, Search, X, ArrowLeft, Trash, ListTodo, ChevronRight, Monitor, GitFork, Terminal, GitBranch, GitCommit, PlusSquare, Check, FileCode, FileText, MoreHorizontal, Sparkles, Pin, PinOff, Archive, Split, Calendar, ExternalLink, Copy } from 'lucide-react';
import { Tooltip } from '../components/ui/tooltip';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import { InteractiveGrid } from '../components/ui/interactive-grid';
import { GeminiLiveSession, LiveSessionState } from '../lib/live/gemini-live';
import {
  MAIN_AGENT_MODEL_OPTIONS,
  MAIN_AGENT_THINKING_LEVEL_STORAGE_KEY,
  normalizeMainAgentThinkingLevel,
  type MainAgentMode,
  type MainAgentThinkingLevel,
} from '../lib/agent/model-routing';
import {
  AUTO_MODEL_SELECTION,
  CHAT_MODEL_SELECTION_STORAGE_KEY,
  MODEL_API_KEYS_STORAGE_KEY,
  MODEL_CATALOG_STORAGE_KEY,
  MODEL_OVERRIDE_STORAGE_KEY,
  MODEL_PROVIDER_MODE,
  MODEL_SELECTOR_STORAGE_KEY,
  composeApiKeysForSelection,
  normalizeModelSelectorEntries,
  parseModelEntryKey,
  pickAutoModelEntry,
} from '../lib/agent/model-selector-store';
import {
  createCustomToolActionLog,
  createCustomToolResultLogs,
  createCustomWorkNoteLog,
  normalizeCustomAgentStatus,
  shouldShowCustomAgentStatus,
  type CustomToolActiveTrace,
} from '../lib/agent/custom-agent-trace-adapter';
import { formatVisibleWorkNote } from '../lib/agent/work-note';
import { FilePanelProvider, useGlobalFilePanel } from '../contexts/FilePanelContext';

const CommandPalette = dynamic(
  () => import('../components/layout/command-palette').then(mod => mod.CommandPalette),
  { ssr: false },
);

const SettingsPanel = dynamic(
  () => import('../components/layout/settings-panel').then(mod => mod.SettingsPanel),
  { ssr: false },
);

const IdePanel = dynamic(
  () => import('../components/chat/file-panel').then(mod => mod.IdePanel),
  { ssr: false },
);

const AgentsView = dynamic(
  () => import('../components/agents/agents-view').then(mod => mod.AgentsView),
  { ssr: false },
);

const AgentChannelsView = dynamic(
  () => import('../components/channels/agent-channels-view').then(mod => mod.AgentChannelsView),
  { ssr: false },
);

const ProjectsView = dynamic(
  () => import('../components/projects/projects-view').then(mod => mod.ProjectsView),
  { ssr: false },
);

const MonitorPanel = dynamic(
  () => import('../components/monitor/ModernMonitorPanel').then(mod => mod.MonitorPanel),
  { ssr: false },
);

const HeaderSidebarOpenIcon = ({ className = "w-[18px] h-[18px]" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={`${ className } transition-colors duration-150`}>
    <rect x="3" y="3" width="18" height="18" rx="5" />
    <path d="M9 3v18" />
    <path className="opacity-0 transition-opacity duration-150 group-hover:opacity-100" d="M13 9l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const getBasename = (path: string) => path.split(/[/\\]/).pop() || path;

const isProjectFile = (filepath: string) => {
  if (!filepath) return false;
  const pathLower = filepath.toLowerCase();

  // Exclude EterX-Agent internal files
  if (pathLower.includes('page.tsx')) return false;
  if (pathLower.includes('chat-input.tsx')) return false;
  if (pathLower.includes('route.ts')) return false;
  if (pathLower.includes('system')) return false;
  if (pathLower.includes('walkthrough.md')) return false;
  if (pathLower.includes('task.md')) return false;
  if (pathLower.includes('implementation_plan.md')) return false;

  // Other standard excludes
  if (pathLower.includes('.system_generated')) return false;
  if (pathLower.includes('node_modules')) return false;
  if (pathLower.includes('.next')) return false;
  if (pathLower.includes('.git/')) return false;
  if (pathLower.includes('.git\\')) return false;
  if (pathLower.includes('.vscode')) return false;
  if (pathLower.includes('.temp')) return false;
  if (pathLower.includes('.gitleaks')) return false;
  if (pathLower.endsWith('.log')) return false;

  return true;
};

const getFileIconPath = (filepath: string) => {
  const ext = filepath.split('.').pop()?.toLowerCase();
  const filename = filepath.split('/').pop()?.toLowerCase() || '';

  if (filename.startsWith('.git') || filename.includes('git')) {
    return '/icons/files/git.svg';
  }
  if (filename.includes('eslint')) {
    return '/icons/files/eslint.svg';
  }
  if (filename.includes('prettier')) {
    return '/icons/files/prettier.svg';
  }
  if (filename.includes('tsconfig')) {
    return '/icons/files/tsconfig.svg';
  }
  if (filename === 'package.json') {
    return '/icons/files/npm.svg';
  }
  if (filename === 'yarn.lock') {
    return '/icons/files/yarn.svg';
  }
  if (filename === 'pnpm-lock.yaml') {
    return '/icons/files/pnpm.svg';
  }
  if (filename.includes('next.config')) {
    return '/icons/files/next.svg';
  }
  if (filename.includes('vite.config')) {
    return '/icons/files/vite.svg';
  }
  if (filename.includes('webpack.config')) {
    return '/icons/files/webpack.svg';
  }
  if (filename.startsWith('.env') || filename === 'settings.json') {
    return '/icons/files/settings.svg';
  }

  switch (ext) {
    case 'tsx':
    case 'jsx':
      return '/icons/files/react.svg';
    case 'ts':
      return '/icons/files/typescript.svg';
    case 'js':
      return '/icons/files/javascript.svg';
    case 'py':
      return '/icons/files/python.svg';
    case 'html':
      return '/icons/files/html.svg';
    case 'css':
      return '/icons/files/css.svg';
    case 'json':
      return '/icons/files/json.svg';
    case 'go':
      return '/icons/files/go.svg';
    case 'md':
      return '/icons/files/markdown.svg';
    case 'sh':
    case 'bash':
    case 'zsh':
      return '/icons/files/console.svg';
    case 'svg':
      return '/icons/files/svg.svg';
    case 'yaml':
    case 'yml':
      return '/icons/files/yaml.svg';
    case 'dockerfile':
      return '/icons/files/docker.svg';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'ico':
      return '/icons/files/image.svg';
    case 'pdf':
      return '/icons/files/pdf.svg';
    case 'zip':
    case 'tar':
    case 'gz':
    case 'rar':
      return '/icons/files/zip.svg';
    case 'lock':
      return '/icons/files/lock.svg';
    case 'sql':
    case 'db':
      return '/icons/files/database.svg';
    case 'sass':
    case 'scss':
      return '/icons/files/sass.svg';
    default:
      return '/icons/files/document.svg';
  }
};

type WorkMenuSourceItem = {
  id: string;
  name: string;
  path: string;
  isPinned?: boolean;
  status?: 'MOD' | 'ADD';
  additions?: number;
  deletions?: number;
};

const WorkMenuSectionButton = ({
  title,
  meta,
  open,
  onClick,
  onMouseEnter,
}: {
  title: string;
  meta?: string | number;
  open: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseEnter?: () => void;
}) => (
  <button
    type="button"
    aria-expanded={open}
    onMouseEnter={onMouseEnter}
    onClick={onClick}
    className="eterx-work-menu-section-button group"
  >
    <span className="min-w-0 truncate">{title}</span>
    <span className="flex shrink-0 items-center gap-2">
      {meta !== undefined && meta !== '' && (
        <span className="eterx-work-menu-section-badge">{meta}</span>
      )}
      <ChevronDown className={`h-3.5 w-3.5 text-white/34 transition duration-150 group-hover:text-white/64 ${ open ? '' : '-rotate-90' }`} />
    </span>
  </button>
);

const WorkMenuEmptyState = ({ label, detail }: { label: string; detail?: string }) => (
  <div className="eterx-work-menu-empty">
    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-white/14" />
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {detail && <span className="hidden shrink-0 text-white/28 sm:inline">{detail}</span>}
  </div>
);

const WorkMenuStatusIndicator = ({ status }: { status?: string }) => {
  switch (status) {
    case 'working':
    case 'spawning':
      return (
        <svg className="animate-spin h-3.5 w-3.5 text-white/80 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-label="Working">
          <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      );
    case 'paused':
      return (
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-amber-400" aria-label="Paused">
          <svg viewBox="0 0 10 10" fill="currentColor" className="h-2.5 w-2.5">
            <rect x="1" y="1" width="3" height="8" rx="0.5" />
            <rect x="6" y="1" width="3" height="8" rx="0.5" />
          </svg>
        </span>
      );
    case 'completed':
      return <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400/80" aria-label="Completed" />;
    case 'error':
      return <span className="h-2 w-2 shrink-0 rounded-full bg-red-400/80" aria-label="Error" />;
    case 'closed':
      return <span className="h-2 w-2 shrink-0 rounded-full bg-white/15" aria-label="Closed" />;
    default:
      return <span className="h-2 w-2 shrink-0 rounded-full bg-white/20" aria-label="Idle" />;
  }
};

const SUB_AGENT_ICON_NAMES = new Set([
  'einstein', 'heisenberg', 'sam', 'dario', 'elon',
  'tesla', 'newton', 'turing', 'ada', 'curie',
  'feynman', 'darwin', 'hawking', 'galileo', 'davinci',
  'aristotle', 'oppenheimer', 'gates', 'jobs', 'pascal'
]);

const getAgentDisplayName = (name?: string) => String(name || 'Agent').trim() || 'Agent';

const getAgentInitials = (name?: string) => {
  const safeName = getAgentDisplayName(name);
  const parts = safeName.split(/[\s_-]+/).filter(Boolean);
  if (parts.length > 1) {
    return `${ parts[0][0] || '' }${ parts[1][0] || '' }`.toUpperCase();
  }
  return safeName.slice(0, 2).toUpperCase();
};

const getSubAgentStatusTone = (status?: string) => {
  switch (status) {
    case 'working':
    case 'spawning':
      return 'emerald';
    case 'paused':
      return 'amber';
    case 'completed':
      return 'blue';
    case 'error':
      return 'red';
    case 'closed':
      return 'muted';
    default:
      return 'neutral';
  }
};

const SubAgentAvatar = ({
  name,
  status,
  size = 'sm',
}: {
  name?: string;
  status?: string;
  size?: 'xs' | 'sm' | 'md';
}) => {
  const displayName = getAgentDisplayName(name);
  const lowerName = displayName.toLowerCase().trim();
  const hasImage = SUB_AGENT_ICON_NAMES.has(lowerName);
  const sizeClass = size === 'md' ? 'h-7 w-7' : size === 'xs' ? 'h-[22px] w-[22px]' : 'h-6 w-6';
  const textClass = size === 'md' ? 'text-[10px]' : 'text-[9px]';

  return (
    <span className={`relative flex ${ sizeClass } shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/[0.13] bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.18),rgba(255,255,255,0.04)_42%,rgba(0,0,0,0.18))] shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]`}>
      {hasImage ? (
        <img src={`/icons/sub-agents/${ lowerName }.png`} alt={displayName} className="h-full w-full select-none object-cover" />
      ) : (
        <span className={`${ textClass } font-bold leading-none text-white/72`}>
          {getAgentInitials(displayName)}
        </span>
      )}
    </span>
  );
};

const TaskStatusGlyphMini = ({ status, active }: { status?: string; active?: boolean }) => {
  if (status === 'done') {
    return (
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-[#A9A9A9] text-[#1F1F1F] shadow-[inset_0_1px_0_rgba(255,255,255,0.28)]">
        <Check className="h-2 w-2" strokeWidth={3.5} />
      </span>
    );
  }

  if (active || status === 'in_progress') {
    return (
      <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
        <span className="absolute inset-0 rounded-full border-[1.5px] border-white/[0.16]" />
        <span className="absolute inset-0 rounded-full border-[1.5px] border-transparent border-r-white/45 border-t-white/90 animate-[spin_1.15s_linear_infinite]" />
      </span>
    );
  }

  return <span className="block h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px] border-[#A9A9A9]/50" />;
};

interface ChatSession {
  id: string;
  title: string;
  updatedAt: number;
  traceLogs: any[];
  isFavorite?: boolean;
  workspacePath?: string | null;
  runLocation?: 'local' | 'sandbox';
}

type ComposerAttachment = {
  id?: string;
  file: File;
  name?: string;
  preview: string;
  uploadStatus?: 'uploading' | 'done' | 'error';
  localPath?: string;
  fileUri?: string;
};

type TaskTrackerStep = {
  id?: string;
  step: number;
  name: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
  tools?: string[];
  done_when?: string;
  step_type?: string;
  expected_output?: string;
  risk?: string;
  artifacts?: string[];
};

type TaskTrackerState = {
  goal?: string;
  phase?: 'generating' | 'generated' | 'progress' | 'complete';
  status?: 'generating' | 'in_progress' | 'completed' | 'failed' | 'stopped';
  complexity?: string;
  estimatedMinutes?: number;
  completedSteps?: number;
  totalSteps?: number;
  activeStepName?: string | null;
  steps?: TaskTrackerStep[];
};

type NetworkBannerPhase = 'online' | 'offline' | 'restored';
type ActiveView = 'chat' | 'code' | 'agents' | 'channels' | 'projects';

const NETWORK_PROBE_URL = 'https://www.gstatic.com/generate_204';

const NetworkStatusBanner = ({
  phase,
  visible,
  onDismiss,
}: {
  phase: NetworkBannerPhase;
  visible: boolean;
  onDismiss: () => void;
}) => {
  const offline = phase === 'offline';
  if (phase === 'online') return null;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: -54, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -54, scale: 0.985 }}
          transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          className="pointer-events-none fixed inset-x-0 top-0 z-[9999] flex justify-center px-4 pt-5"
        >
          <div className="group pointer-events-auto relative flex min-h-[58px] w-full max-w-[520px] items-center gap-3 overflow-hidden rounded-[18px] border border-white/[0.12] bg-[#141414]/95 px-4 py-3 pr-12 text-[#F2F0EC] shadow-[0_18px_52px_rgba(0,0,0,0.48),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-2xl">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" />
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/[0.13] bg-white/[0.055]">
              {offline ? (
                <motion.span
                  className="h-[17px] w-[17px] rounded-full border-[2px] border-white/20 border-t-white"
                  animate={{ rotate: 360 }}
                  transition={{ duration: 0.82, repeat: Infinity, ease: 'linear' }}
                />
              ) : (
                <CheckCircle2 className="h-[18px] w-[18px] text-white" strokeWidth={2.2} />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold tracking-normal">
                {offline ? 'No internet connection' : 'Connection restored'}
              </span>
              <span className="mt-0.5 block truncate text-[12.5px] font-medium text-[#A7A39E]">
                {offline
                  ? 'Agent activity is paused. You can keep using the app while we reconnect.'
                  : 'Agent activity is resuming automatically.'}
              </span>
            </span>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss network status"
              className="absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.09] bg-white/[0.055] text-white/70 opacity-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] transition-all duration-200 hover:bg-white/[0.11] hover:text-white focus:opacity-100 focus:outline-none group-hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2.3} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

const getPetLogText = (log: any) => {
  const raw = log?.text || log?.command || log?.summary || log?.message || '';
  return String(raw).replace(/\s+/g, ' ').trim();
};

const getLatestPetMonitorText = (logs: any[], isThinking: boolean) => {
  if (isThinking) return 'Thinking';
  for (let i = logs.length - 1; i >= 0; i--) {
    const log = logs[i];
    if (!log || log.type === 'user_action' || log.type === 'task_plan') continue;
    const text = getPetLogText(log);
    if (text) return text;
  }
  return isThinking ? 'Thinking' : '';
};

const PetThinkingLabel = ({ className = '' }: { className?: string }) => (
  <span className={`eterx-pet-thinking-label inline-flex items-baseline gap-[3px] ${ className }`}>
    <span>Thinking</span>
    <span className="eterx-pet-thinking-dots inline-flex w-[22px] items-baseline justify-start gap-[2px]" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  </span>
);

const FloatingPetMonitor = ({
  open,
  isThinking,
  title,
  logs,
  onClose,
  onReply,
}: {
  open: boolean;
  isThinking: boolean;
  title: string;
  logs: any[];
  onClose: () => void;
  onReply: (message: string) => void;
}) => {
  const [position, setPosition] = useState({ x: 28, y: 82 });
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const dragFrameRef = useRef<number | null>(null);

  const latestText = useMemo(() => getLatestPetMonitorText(logs, isThinking), [isThinking, logs]);

  const displayTitle = title?.trim() || 'EterX agent';
  const previewText = isThinking ? 'Thinking' : latestText;

  const startDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button,input,textarea')) return;

    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = position;

    const handleMove = (moveEvent: PointerEvent) => {
      const next = {
        x: Math.max(8, Math.min(window.innerWidth - 96, origin.x + moveEvent.clientX - startX)),
        y: Math.max(8, Math.min(window.innerHeight - 64, origin.y + moveEvent.clientY - startY)),
      };

      if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = window.requestAnimationFrame(() => {
        setPosition(next);
        dragFrameRef.current = null;
      });
    };

    const stopDrag = () => {
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
  }, [position]);

  useEffect(() => {
    return () => {
      if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
    };
  }, []);

  const submitReply = useCallback(() => {
    const message = replyText.trim();
    if (!message) return;
    onReply(message);
    setReplyText('');
    setReplyOpen(false);
  }, [onReply, replyText]);

  if (!open || !isThinking) return null;

  return (
    <div
      className={`eterx-pet-monitor group fixed z-[9998] w-[326px] max-w-[calc(100vw-24px)] select-none rounded-[24px] border border-white/[0.16] bg-[#171717]/96 text-[#F2F0EC] shadow-[0_18px_54px_rgba(0,0,0,0.36),inset_0_1px_0_rgba(255,255,255,0.055)] backdrop-blur-2xl ${ replyOpen ? 'p-3' : 'px-4 py-3.5' }`}
      style={{ left: position.x, top: position.y }}
      onPointerDown={startDrag}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close pet monitor"
        className="eterx-pet-close absolute -left-2 -top-2 flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.16] bg-[#1F1F1F] text-white/72 opacity-0 shadow-[0_10px_26px_rgba(0,0,0,0.28)] transition-all duration-100 hover:bg-[#2A2A2A] hover:text-white group-hover:opacity-100 focus:opacity-100"
      >
        <X className="h-4 w-4" strokeWidth={2.3} />
      </button>

      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1 pt-0.5">
          {replyOpen ? (
            <div>
              <div className="eterx-pet-title truncate text-[13px] font-semibold leading-5 text-[#A8A39B]">
                {displayTitle}
              </div>
              <div className="eterx-pet-status mt-1 line-clamp-2 text-[15px] font-semibold leading-5 text-[#F2F0EC]">
                <PetThinkingLabel />
              </div>
            </div>
          ) : (
            <div className="eterx-pet-status text-[20px] font-semibold leading-7 text-[#F2F0EC]">
              <PetThinkingLabel />
            </div>
          )}
        </div>

        <span className="eterx-pet-spinner mt-1 h-[15px] w-[15px] shrink-0 rounded-full border-2 border-white/35 border-t-white animate-spin" />
      </div>

      {!replyOpen && (
        <button
          type="button"
          onClick={() => setReplyOpen(true)}
          className="eterx-pet-reply-button absolute bottom-3 right-4 hidden rounded-full border border-white/[0.10] bg-white/[0.055] px-4 py-1.5 text-[15px] font-medium text-[#E8E5DF] transition-colors hover:bg-white/[0.10] hover:text-white group-hover:block"
        >
          Reply
        </button>
      )}

      {replyOpen && (
        <div className="eterx-pet-reply-area mt-3 border-t border-white/[0.08] pt-3">
          <div className="flex items-center gap-2">
            <input
              value={replyText}
              onChange={(event) => setReplyText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitReply();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setReplyOpen(false);
                }
              }}
              autoFocus
              placeholder="Reply"
              className="eterx-pet-reply-input h-10 min-w-0 flex-1 select-text rounded-[10px] border border-[#6EA8FF]/70 bg-[#151515] px-3 text-[15px] font-medium text-white outline-none placeholder:text-[#8C8984] focus:border-[#8AB4FF]"
            />
            <button
              type="button"
              onClick={submitReply}
              disabled={!replyText.trim()}
              className="eterx-pet-reply-submit h-10 shrink-0 rounded-full bg-[#B8B4AC] px-4 text-[15px] font-semibold text-[#202020] transition-colors hover:bg-[#D8D4CC] disabled:cursor-default disabled:opacity-45"
            >
              Reply
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const serializeComposerAttachment = (att: ComposerAttachment) => {
  const fileName = att.name || att.file?.name || 'file';
  const mimeType = att.file?.type || 'application/octet-stream';
  return {
    id: att.id,
    name: fileName,
    preview: att.preview,
    uploadStatus: att.uploadStatus,
    localPath: att.localPath,
    fileUri: undefined,
    mimeType,
    size: att.file?.size || 0,
    file: {
      name: att.file?.name || fileName,
      type: mimeType,
      size: att.file?.size || 0,
    },
  };
};

const DEFAULT_CHAT_TITLE = 'New chat';
const SELECTED_AGENT_STORAGE_KEY = 'eterx_selected_agent';
const SETTINGS_STORAGE_KEY = 'eterx_settings';
const SETTINGS_CHANNEL = 'eterx-settings';
const API_KEY_STORAGE_KEY = 'eterx_api_keys';

const readStoredMainAgentMode = (): MainAgentMode | null => {
  if (typeof window === 'undefined') return null;
  try {
    const saved = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    const settings = saved ? JSON.parse(saved) : {};
    const mode = typeof settings?.agentMode === 'string' ? settings.agentMode.trim() : '';
    return MAIN_AGENT_MODEL_OPTIONS.some(option => option.id === mode) ? mode as MainAgentMode : null;
  } catch {
    return null;
  }
};

const readStringRecord = (storageKey: string): Record<string, string> => {
  if (typeof window === 'undefined') return {};
  try {
    const saved = window.localStorage.getItem(storageKey);
    const parsed = saved ? JSON.parse(saved) : {};
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : ''])
        .filter(([, value]) => Boolean(value)),
    );
  } catch {
    return {};
  }
};

const readRuntimeBaseApiKeys = (): Record<string, string> => readStringRecord(API_KEY_STORAGE_KEY);

const readRuntimeModelApiKeys = (): Record<string, string> => readStringRecord(MODEL_API_KEYS_STORAGE_KEY);

const readRuntimeModelEntries = () => {
  if (typeof window === 'undefined') return [];
  try {
    const savedEntries = JSON.parse(window.localStorage.getItem(MODEL_SELECTOR_STORAGE_KEY) || '[]');
    const savedCatalog = JSON.parse(window.localStorage.getItem(MODEL_CATALOG_STORAGE_KEY) || '{}');
    return normalizeModelSelectorEntries(savedEntries, savedCatalog);
  } catch {
    return [];
  }
};

const readRuntimeChatModelSelection = () => {
  if (typeof window === 'undefined') return AUTO_MODEL_SELECTION;
  return window.localStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) || AUTO_MODEL_SELECTION;
};

const readRuntimeApiKeys = (): Record<string, string> => {
  const baseKeys = readRuntimeBaseApiKeys();
  return composeApiKeysForSelection(
    baseKeys,
    readRuntimeModelApiKeys(),
    readRuntimeModelEntries(),
    readRuntimeChatModelSelection(),
  );
};

const readRuntimeModelOverrides = (): Record<string, string> => {
  if (typeof window === 'undefined') return {};
  const selection = readRuntimeChatModelSelection();
  const exactEntry = parseModelEntryKey(selection);
  if (exactEntry) return { [exactEntry.provider]: exactEntry.modelId };
  const autoEntry = pickAutoModelEntry(readRuntimeModelEntries(), readRuntimeBaseApiKeys(), readRuntimeModelApiKeys());
  if (autoEntry) return { [autoEntry.provider]: autoEntry.modelId };

  try {
    const saved = window.localStorage.getItem(MODEL_OVERRIDE_STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : {};
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : ''])
        .filter(([, value]) => Boolean(value)),
    );
  } catch {
    return {};
  }
};

const readRuntimeAgentMode = (fallbackMode: MainAgentMode): MainAgentMode => {
  const selection = readRuntimeChatModelSelection();
  const exactEntry = parseModelEntryKey(selection);
  if (exactEntry) return MODEL_PROVIDER_MODE[exactEntry.provider];
  const autoEntry = pickAutoModelEntry(readRuntimeModelEntries(), readRuntimeBaseApiKeys(), readRuntimeModelApiKeys());
  return autoEntry ? MODEL_PROVIDER_MODE[autoEntry.provider] : fallbackMode;
};

type SelectedAgentState = {
  agentId: string | null;
  agentName: string;
};

const readSelectedAgentState = (): SelectedAgentState => {
  if (typeof window === 'undefined') return { agentId: null, agentName: 'General' };
  try {
    const saved = localStorage.getItem(SELECTED_AGENT_STORAGE_KEY);
    if (!saved) return { agentId: null, agentName: 'General' };
    const parsed = JSON.parse(saved);
    const agentId = typeof parsed?.agentId === 'string' && parsed.agentId.trim()
      ? parsed.agentId.trim()
      : null;
    const agentName = typeof parsed?.agentName === 'string' && parsed.agentName.trim()
      ? parsed.agentName.trim()
      : agentId === 'coding'
        ? 'Coding'
        : agentId || 'General';
    return { agentId, agentName };
  } catch {
    return { agentId: null, agentName: 'General' };
  }
};

const isDefaultChatTitle = (title?: string | null) =>
  !title?.trim() || title.trim().toLowerCase() === DEFAULT_CHAT_TITLE.toLowerCase();

const titleCaseWords = (value: string) =>
  value.toLowerCase().replace(/\b[a-z0-9]/g, letter => letter.toUpperCase());

const fallbackTitleFromPrompt = (prompt: string) => {
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'make', 'making',
    'fix', 'issue', 'please', 'proper', 'fast', 'best', 'okay', 'just', 'want',
    'need', 'can', 'you', 'your', 'there', 'their', 'then', 'than', 'into',
  ]);
  const seen = new Set<string>();
  const words = String(prompt || '')
    .replace(/[^A-Za-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map(word => word.trim())
    .filter(word => {
      const key = word.toLowerCase();
      if (word.length <= 2 || stopWords.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);

  if (words.length >= 2) return titleCaseWords(words.join(' '));
  if (words.length === 1) return titleCaseWords(`${ words[0] } Task`);
  return DEFAULT_CHAT_TITLE;
};

const sortChats = (chats: ChatSession[]) => {
  return [...chats].sort((a, b) => {
    if (a.isFavorite && !b.isFavorite) return -1;
    if (!a.isFavorite && b.isFavorite) return 1;
    return b.updatedAt - a.updatedAt;
  });
};

const getCatchyGreeting = () => {
  const hour = new Date().getHours();

  if (hour >= 5 && hour < 12) {
    const greetings = [

      "Morning looks nominal.",
      "Fresh canvas awaits us.",
      "The early bird builds.",
      "First light, first breakthrough.",

      "Morning clarity is engaged.",
      "Let us lead today.",

      "Hand over, Drink coffee!",
      "New day, elegant solutions.",

      "Morning co-pilot is online.",
      "Let's set the pace.",
      "Lets work hard!",
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  if (hour >= 12 && hour < 17) {
    const greetings = [

      "Decent Afternoon!.",


      "Engines at cruise altitude.",

      "Steady hands build empires.",
      "I am ready!",
      "Afternoon work.",
      "Let's build something beautiful.",

      "Your ideas, my execution.",
      "Just type!",
      "Give me to work on.",
      ".Lets Start!",
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  if (hour >= 17 && hour < 22) {
    const greetings = [
      "Evening aesthetic .",


      "Sun never sets for us!",



      "Best ideas come tonight.",


      "Helloooo.",
      "Hell yeah!",
      "Pass it to me.",
      "Please give me work!",
      "Evening belongs to you.",
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  const greetings = [
    "Hey black owl.",
    "brhhhhh.",
    "Zero distractions, maximum work.",

    "Late night, sharp focus.",

    "The night is yours.",

    "Its time to work!.",
    "Code sleeps for nobody.",

    "Moonlight productivity is active.",
  ];
  return greetings[Math.floor(Math.random() * greetings.length)];
};

export interface PinnedItem {
  id: string;
  type: 'file' | 'folder';
  path: string;
  name: string;
}

const SPLIT_CHAT_WIDTH_KEY = 'eterx_split_chat_width';
const DEFAULT_CHAT_PANEL_RATIO = 0.52;
const MIN_CHAT_PANEL_WIDTH = 420;
const MIN_FILE_PANEL_WIDTH = 420;
const MAX_CHAT_PANEL_WIDTH = 960;
const MAX_FILE_PANEL_WIDTH = 940;

const getClampedSplitWidth = (width: number, containerWidth: number) => {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return width;

  const minChatBase = Math.min(MIN_CHAT_PANEL_WIDTH, Math.max(320, containerWidth * 0.42));
  const minFile = Math.min(MIN_FILE_PANEL_WIDTH, Math.max(320, containerWidth * 0.36));
  const minChatByMaxFile = Math.max(0, containerWidth - MAX_FILE_PANEL_WIDTH);
  const minChat = Math.min(containerWidth - minFile, Math.max(minChatBase, minChatByMaxFile));
  const maxByFilePanel = Math.max(minChat, containerWidth - minFile);
  const maxChat = Math.max(minChat, Math.min(MAX_CHAT_PANEL_WIDTH, maxByFilePanel));

  return Math.round(Math.min(Math.max(width, minChat), maxChat));
};

export default function DeepWorkUIWrapper() {
  return (
    <FilePanelProvider>
      <DeepWorkUI />
    </FilePanelProvider>
  );
}

function DeepWorkUI() {
  const { openFiles } = useGlobalFilePanel();
  const hasOpenFiles = openFiles.length > 0;
  const isRightPanelVisible = hasOpenFiles;
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const latestChatPanelWidthRef = useRef<number | null>(null);
  const [chatPanelWidth, setChatPanelWidth] = useState<number | null>(null);
  const [isResizingPanels, setIsResizingPanels] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [selectedProjectSection, setSelectedProjectSection] = useState('new-tasks');
  const [pendingSteering, setPendingSteering] = useState<{ id: string, text: string }[]>([]);
  // Per-chat thinking state: Set of chatIds that have running agents
  const [runningChats, setRunningChats] = useState<Set<string>>(new Set());
  const [unreadChatIds, setUnreadChatIds] = useState<Set<string>>(new Set());
  const [traceLogs, setTraceLogs] = useState<any[]>([]);
  const [greeting, setGreeting] = useState("Initializing...");

  const [chats, setChats] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [buildingAgentId, setBuildingAgentId] = useState<string | null>(null);

  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [audioVolume, setAudioVolume] = useState<number>(0);
  const [isProcessingVoice, setIsProcessingVoice] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [chatActionMenuOpen, setChatActionMenuOpen] = useState(false);
  const [isEditingChatTitle, setIsEditingChatTitle] = useState(false);
  const [editingTitleText, setEditingTitleText] = useState("");
  const [headerSearchOpen, setHeaderSearchOpen] = useState(false);
  const [headerSearchQuery, setHeaderSearchQuery] = useState("");
  const [activeView, setActiveViewState] = useState<ActiveView>('chat');
  const [agentMode, setAgentMode] = useState<MainAgentMode>(() => readStoredMainAgentMode() || 'think');
  const [thinkingLevel, setThinkingLevelState] = useState<MainAgentThinkingLevel>('low');
  const [selectedAgentState, setSelectedAgentState] = useState<SelectedAgentState>({
    agentId: null,
    agentName: 'General',
  });
  const [activeWorkspacePath, setActiveWorkspacePath] = useState<string | null>(null);
  const [activeRunLocation, setActiveRunLocation] = useState<'local' | 'sandbox'>('local');
  const [pinnedItems, setPinnedItems] = useState<PinnedItem[]>([]);
  const [envDropdownOpen, setEnvDropdownOpen] = useState(false);
  const envDropdownRef = useRef<HTMLDivElement | null>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<'local' | 'branch' | 'todo' | null>(null);
  const [currentBranch, setCurrentBranch] = useState('safe-hardening');
  const [currentEnv, setCurrentEnv] = useState('Local');
  const [branchSearch, setBranchSearch] = useState('');
  const [gitBranches, setGitBranches] = useState<Array<{ name: string; uncommitted: string | null }>>([
    { name: 'main', uncommitted: null },
    { name: 'safe-hardening', uncommitted: 'Uncommitted: 1 file' }
  ]);
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [gitError, setGitError] = useState<string | null>(null);
  const [todoSectionOpen, setTodoSectionOpen] = useState(true);
  const [sourcesSectionOpen, setSourcesSectionOpen] = useState(true);
  const [subAgentsSectionOpen, setSubAgentsSectionOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [agentTeamOpen, setAgentTeamOpen] = useState(false);
  const [activeSubAgentTab, setActiveSubAgentTab] = useState<string | null>(null);
  const [subAgentOrder, setSubAgentOrder] = useState<string[]>([]);
  const [overflowDropdownOpen, setOverflowDropdownOpen] = useState(false);
  const [petWidgetOpen, setPetWidgetOpen] = useState(false);
  const [nativePetAvailable, setNativePetAvailable] = useState(false);
  const canUseMonitor = activeView === 'chat' && !!activeChatId;
  const [networkPhase, setNetworkPhase] = useState<NetworkBannerPhase>('online');
  const [networkBannerVisible, setNetworkBannerVisible] = useState(false);
  const closedSidebarDragStartRef = useRef<number | null>(null);
  const closedSidebarDragOpenedRef = useRef(false);
  const dragConstraintsRef = useRef<HTMLDivElement>(null);
  const selectedAgent = selectedAgentState.agentId;
  const selectedAgentName = selectedAgentState.agentName;
  const networkPausedRef = useRef(false);
  const networkOutageIdRef = useRef(0);
  const networkDismissedOutageRef = useRef<number | null>(null);
  const networkRestoreTimerRef = useRef<number | null>(null);
  const networkBannerVisibleRef = useRef(false);
  const runningChatsRef = useRef<Set<string>>(new Set());
  const activeViewRef = useRef<ActiveView>('chat');
  const isNetworkPaused = networkPhase === 'offline';

  // Auto-close sidebar on window resize if width is narrow
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 768) {
        setSidebarOpen(false);
      }
    };
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const [workMenuLayouts, setWorkMenuLayouts] = useState<Record<string, { x: number; y: number; width: number; height: number | 'auto' }>>({});

  const handleMenuDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const chatId = activeChatId || 'default';
    const currentLayout = workMenuLayouts[chatId] || { x: 0, y: 0, width: 320, height: 'auto' };

    const startX = currentLayout.x;
    const startY = currentLayout.y;
    const startMouseX = e.clientX;
    const startMouseY = e.clientY;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startMouseX;
      const dy = moveEvent.clientY - startMouseY;

      let nextX = startX + dx;
      let nextY = startY + dy;

      if (envDropdownRef.current) {
        const rect = envDropdownRef.current.getBoundingClientRect();
        const defaultLeft = rect.left - startX;
        const defaultTop = rect.top - startY;

        const minX = -defaultLeft + 10;
        const maxX = window.innerWidth - defaultLeft - rect.width - 10;
        const minY = -defaultTop + 10;
        const maxY = window.innerHeight - defaultTop - rect.height - 10;

        nextX = Math.max(minX, Math.min(maxX, nextX));
        nextY = Math.max(minY, Math.min(maxY, nextY));
      }

      setWorkMenuLayouts(prev => ({
        ...prev,
        [chatId]: {
          ...currentLayout,
          x: nextX,
          y: nextY
        }
      }));
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [activeChatId, workMenuLayouts]);

  const handleMenuResizeLeftStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const chatId = activeChatId || 'default';
    const currentLayout = workMenuLayouts[chatId] || { x: 0, y: 0, width: 320, height: 'auto' };

    const startWidth = currentLayout.width;
    const startX = currentLayout.x;
    const startMouseX = e.clientX;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startMouseX;
      const nextWidth = Math.max(260, Math.min(600, startWidth - dx));
      const actualDx = startWidth - nextWidth;
      const nextX = startX + actualDx;

      setWorkMenuLayouts(prev => ({
        ...prev,
        [chatId]: {
          ...prev[chatId] || currentLayout,
          width: nextWidth,
          x: nextX
        }
      }));
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [activeChatId, workMenuLayouts]);

  const handleMenuResizeBottomStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const chatId = activeChatId || 'default';
    let startHeight = 350;
    if (envDropdownRef.current) {
      startHeight = envDropdownRef.current.offsetHeight;
    }

    const currentLayout = workMenuLayouts[chatId] || { x: 0, y: 0, width: 320, height: 'auto' };
    const startMouseY = e.clientY;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dy = moveEvent.clientY - startMouseY;
      const nextHeight = Math.max(150, Math.min(window.innerHeight - 100, startHeight + dy));

      setWorkMenuLayouts(prev => ({
        ...prev,
        [chatId]: {
          ...prev[chatId] || currentLayout,
          height: nextHeight
        }
      }));
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [activeChatId, workMenuLayouts]);

  const handleMenuResizeCornerStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const chatId = activeChatId || 'default';
    let startHeight = 350;
    if (envDropdownRef.current) {
      startHeight = envDropdownRef.current.offsetHeight;
    }

    const currentLayout = workMenuLayouts[chatId] || { x: 0, y: 0, width: 320, height: 'auto' };
    const startWidth = currentLayout.width;
    const startX = currentLayout.x;
    const startMouseX = e.clientX;
    const startMouseY = e.clientY;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startMouseX;
      const dy = moveEvent.clientY - startMouseY;

      const nextWidth = Math.max(260, Math.min(600, startWidth - dx));
      const actualDx = startWidth - nextWidth;
      const nextX = startX + actualDx;

      const nextHeight = Math.max(150, Math.min(window.innerHeight - 100, startHeight + dy));

      setWorkMenuLayouts(prev => ({
        ...prev,
        [chatId]: {
          ...prev[chatId] || currentLayout,
          width: nextWidth,
          x: nextX,
          height: nextHeight
        }
      }));
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [activeChatId, workMenuLayouts]);

  const setActiveView = useCallback((view: ActiveView) => {
    if (view === 'agents' || view === 'channels' || view === 'projects') {
      setBuildingAgentId(null);
    }
    if (view !== 'chat') {
      setHeaderMenuOpen(false);
      setHeaderSearchOpen(false);
      setHeaderSearchQuery("");
    }
    setActiveViewState(view);
  }, []);

  const openSettingsWindow = useCallback(() => {
    try {
      const saved = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
      const settings = saved ? JSON.parse(saved) : {};
      const requested = settings.theme === 'dark' || settings.theme === 'system' ? settings.theme : 'light';
      const resolved = requested === 'system'
        ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : requested;
      (window as any).electronAPI?.setNativeTheme?.(resolved);
    } catch {
      // Native theme sync is only needed for Electron popout polish.
    }
    const opened = window.open(
      '/settings?tab=models',
      'eterx-settings',
      'width=1440,height=960,resizable=yes,scrollbars=yes',
    );
    if (!opened) setIsSettingsOpen(true);
  }, []);

  useEffect(() => {
    const applyStoredAgentMode = () => {
      const storedMode = readStoredMainAgentMode();
      if (storedMode) {
        setAgentMode(currentMode => currentMode === storedMode ? currentMode : storedMode);
      }
    };

    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === SETTINGS_STORAGE_KEY) applyStoredAgentMode();
    };

    applyStoredAgentMode();
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', applyStoredAgentMode);
    window.addEventListener('eterx-settings-updated', applyStoredAgentMode);

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(SETTINGS_CHANNEL);
      channel.onmessage = applyStoredAgentMode;
    } catch {
      channel = null;
    }

    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', applyStoredAgentMode);
      window.removeEventListener('eterx-settings-updated', applyStoredAgentMode);
      channel?.close();
    };
  }, []);

  // ═══ Gemini Live Session State ═══
  const [liveState, setLiveState] = useState<LiveSessionState>('idle');
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveOutputText, setLiveOutputText] = useState('');
  const [liveInputText, setLiveInputText] = useState('');
  const [liveSpokenText, setLiveSpokenText] = useState('');
  const [liveCommands, setLiveCommands] = useState<any[]>([]);
  const liveCommandsRef = useRef<any[]>([]);
  const [liveMicVolume, setLiveMicVolume] = useState(0);
  const [liveModelVolume, setLiveModelVolume] = useState<number | number[]>(0);
  const [liveActiveTool, setLiveActiveTool] = useState<string | null>(null);
  const [liveMicMuted, setLiveMicMuted] = useState(false);
  const [liveSpeakerMuted, setLiveSpeakerMuted] = useState(false);
  const liveSessionRef = useRef<GeminiLiveSession | null>(null);
  const liveConversationRef = useRef<{ role: string; text: string }[]>([]);

  // Derived: isThinking for CURRENT active chat only
  const isThinking = (activeChatId ? runningChats.has(activeChatId) : false) || (liveState !== 'idle');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Per-chat polling intervals: Map<chatId, intervalId>
  const pollingIntervalsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  // Per-chat trace index cursor for incremental polling
  const pollCursorsRef = useRef<Map<string, number>>(new Map());
  // Per-chat client-side run guard. When a new prompt starts, ignore stale
  // completed traces from the previous execution until the server creates the
  // fresh run for this send.
  const pollRunStartRef = useRef<Map<string, number>>(new Map());
  // Server-issued/client-provided run identity. Timestamp guards are not
  // precise enough when a stopped run and a replacement start within 1 second.
  const pollRunIdRef = useRef<Map<string, string>>(new Map());
  // Invalidates in-flight poll callbacks when a poller is restarted or stopped.
  const pollGenerationRef = useRef<Map<string, number>>(new Map());
  // CRITICAL: Ref for activeChatId so polling closures always see the latest value
  const activeChatIdRef = useRef<string | null>(null);
  const localStorageTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingLocalStorageWrite = useRef(false);
  const panelResizeCleanupRef = useRef<(() => void) | null>(null);
  // Keep ref synced with state
  activeChatIdRef.current = activeChatId;
  activeViewRef.current = activeView;
  runningChatsRef.current = runningChats;
  networkBannerVisibleRef.current = networkBannerVisible;

  const isChatCurrentlyVisible = useCallback((chatId: string) => (
    activeChatIdRef.current === chatId &&
    activeViewRef.current === 'chat' &&
    (typeof document === 'undefined' || document.visibilityState === 'visible')
  ), []);

  const markChatUnreadIfBackground = useCallback((chatId: string) => {
    if (!chatId || isChatCurrentlyVisible(chatId)) return;
    setUnreadChatIds(prev => {
      if (prev.has(chatId)) return prev;
      const next = new Set(prev);
      next.add(chatId);
      return next;
    });
  }, [isChatCurrentlyVisible]);

  const clearUnreadChat = useCallback((chatId: string | null) => {
    if (!chatId) return;
    setUnreadChatIds(prev => {
      if (!prev.has(chatId)) return prev;
      const next = new Set(prev);
      next.delete(chatId);
      return next;
    });
  }, []);

  const revealNetworkBanner = useCallback(() => {
    if (!networkPausedRef.current) return;
    if (networkDismissedOutageRef.current === networkOutageIdRef.current) return;
    networkBannerVisibleRef.current = true;
    setNetworkBannerVisible(true);
  }, []);

  const dismissNetworkBanner = useCallback(() => {
    if (networkPausedRef.current) {
      networkDismissedOutageRef.current = networkOutageIdRef.current;
    }
    networkBannerVisibleRef.current = false;
    setNetworkBannerVisible(false);
  }, []);

  useEffect(() => {
    setNativePetAvailable(!!(window as any).electronAPI?.openPetWindow);
  }, []);

  useEffect(() => {
    setSelectedAgentState(readSelectedAgentState());
  }, []);

  useEffect(() => {
    if (!canUseMonitor && monitorOpen) {
      setMonitorOpen(false);
    }
  }, [canUseMonitor, monitorOpen]);

  useEffect(() => {
    try {
      const savedThinkingLevel = localStorage.getItem(MAIN_AGENT_THINKING_LEVEL_STORAGE_KEY);
      if (savedThinkingLevel) {
        setThinkingLevelState(normalizeMainAgentThinkingLevel(savedThinkingLevel));
      }
    } catch { }
  }, []);

  const setThinkingLevel = useCallback((level: MainAgentThinkingLevel) => {
    const safeLevel = normalizeMainAgentThinkingLevel(level);
    setThinkingLevelState(safeLevel);
    try {
      localStorage.setItem(MAIN_AGENT_THINKING_LEVEL_STORAGE_KEY, safeLevel);
    } catch { }
  }, []);

  const handleAgentChange = useCallback((agentId: string | null, agentName: string) => {
    const next: SelectedAgentState = {
      agentId: agentId?.trim() ? agentId.trim() : null,
      agentName: agentId?.trim() ? (agentName?.trim() || agentId.trim()) : 'General',
    };
    setSelectedAgentState(next);
    try {
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, JSON.stringify(next));
    } catch { }
  }, []);

  const resizeChatPanelBy = useCallback((delta: number) => {
    const container = splitContainerRef.current;
    if (!container) return;

    const containerWidth = container.getBoundingClientRect().width;
    setChatPanelWidth(current => {
      const baseWidth = current ?? containerWidth * DEFAULT_CHAT_PANEL_RATIO;
      const nextWidth = getClampedSplitWidth(baseWidth + delta, containerWidth);
      latestChatPanelWidthRef.current = nextWidth;
      localStorage.setItem(SPLIT_CHAT_WIDTH_KEY, String(nextWidth));
      return nextWidth;
    });
  }, []);

  const resetPanelSplit = useCallback(() => {
    const container = splitContainerRef.current;
    if (!container) return;

    const containerWidth = container.getBoundingClientRect().width;
    const nextWidth = getClampedSplitWidth(containerWidth * DEFAULT_CHAT_PANEL_RATIO, containerWidth);
    latestChatPanelWidthRef.current = nextWidth;
    setChatPanelWidth(nextWidth);
    localStorage.setItem(SPLIT_CHAT_WIDTH_KEY, String(nextWidth));
  }, []);

  const handlePanelResizeStart = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const container = splitContainerRef.current;
    if (!hasOpenFiles || !container) return;

    event.preventDefault();
    panelResizeCleanupRef.current?.();
    const containerRect = container.getBoundingClientRect();
    const previousBodyCursor = document.body.style.cursor === 'col-resize' ? '' : document.body.style.cursor;
    const previousHtmlCursor = document.documentElement.style.cursor === 'col-resize' ? '' : document.documentElement.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const resizeButton = event.currentTarget;

    setIsResizingPanels(true);
    document.body.style.cursor = 'col-resize';
    document.documentElement.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    try {
      resizeButton.setPointerCapture(event.pointerId);
    } catch { }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      const nextWidth = getClampedSplitWidth(moveEvent.clientX - containerRect.left, containerRect.width);
      latestChatPanelWidthRef.current = nextWidth;
      setChatPanelWidth(nextWidth);
    };

    const finishResize = () => {
      if (!panelResizeCleanupRef.current) return;
      setIsResizingPanels(false);
      document.body.style.cursor = previousBodyCursor;
      document.documentElement.style.cursor = previousHtmlCursor;
      document.body.style.userSelect = previousUserSelect;
      if (latestChatPanelWidthRef.current !== null) {
        localStorage.setItem(SPLIT_CHAT_WIDTH_KEY, String(latestChatPanelWidthRef.current));
      }
      try {
        if (resizeButton.hasPointerCapture(event.pointerId)) resizeButton.releasePointerCapture(event.pointerId);
      } catch { }
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
      window.removeEventListener('blur', finishResize);
      document.removeEventListener('pointerup', finishResize);
      document.removeEventListener('pointercancel', finishResize);
      document.removeEventListener('mouseup', finishResize);
      document.removeEventListener('mouseleave', finishResize);
      document.removeEventListener('keydown', handleKeyDown);
      panelResizeCleanupRef.current = null;
    };

    const handleKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') finishResize();
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
    window.addEventListener('blur', finishResize);
    document.addEventListener('pointerup', finishResize);
    document.addEventListener('pointercancel', finishResize);
    document.addEventListener('mouseup', finishResize);
    document.addEventListener('mouseleave', finishResize);
    document.addEventListener('keydown', handleKeyDown);
    panelResizeCleanupRef.current = finishResize;
  }, [hasOpenFiles]);

  const handlePanelResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      resizeChatPanelBy(-32);
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      resizeChatPanelBy(32);
    }
    if (event.key === 'Home') {
      event.preventDefault();
      resetPanelSplit();
    }
  }, [resetPanelSplit, resizeChatPanelBy]);

  useEffect(() => {
    if (!hasOpenFiles) panelResizeCleanupRef.current?.();
  }, [hasOpenFiles]);

  useEffect(() => {
    return () => panelResizeCleanupRef.current?.();
  }, []);

  useEffect(() => {
    if (!hasOpenFiles) return;
    const container = splitContainerRef.current;
    if (!container) return;

    const applyWidth = (containerWidth: number, current: number | null) => {
      const savedWidth = Number(localStorage.getItem(SPLIT_CHAT_WIDTH_KEY));
      const fallbackWidth = containerWidth * DEFAULT_CHAT_PANEL_RATIO;
      const requestedWidth = current ?? (Number.isFinite(savedWidth) && savedWidth > 0 ? savedWidth : fallbackWidth);
      return getClampedSplitWidth(requestedWidth, containerWidth);
    };

    setChatPanelWidth(current => {
      const nextWidth = applyWidth(container.getBoundingClientRect().width, current);
      latestChatPanelWidthRef.current = nextWidth;
      return nextWidth;
    });

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const containerWidth = entries[0]?.contentRect.width ?? container.getBoundingClientRect().width;
      setChatPanelWidth(current => {
        const nextWidth = applyWidth(containerWidth, current);
        latestChatPanelWidthRef.current = nextWidth;
        return current === nextWidth ? current : nextWidth;
      });
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [hasOpenFiles]);

  // Track notified chats to prevent duplicate popups (StrictMode/Overlapping Fetch fix)
  const notifiedChatIdsRef = useRef<Set<string>>(new Set());

  // Custom Speech Media Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const silenceIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const transcriptBufferRef = useRef('');
  const lastSpeechTimeRef = useRef(0);
  const isManualStopRef = useRef(false);
  const hasSpokenRef = useRef(false);
  const isCancelledRef = useRef(false);

  const cancelVoice = () => {
    isCancelledRef.current = true;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    setIsProcessingVoice(false);
    setAudioVolume(0);
  };

  const acceptVoice = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  };

  // ═══════════════════════════════════════════════════════════════
  // GEMINI LIVE — Real-time voice conversation with gemini-3.1-flash-live-preview
  // ═══════════════════════════════════════════════════════════════

  const startLiveSession = useCallback(async () => {
    if (networkPausedRef.current) {
      revealNetworkBanner();
      return;
    }

    if (liveSessionRef.current) {
      liveSessionRef.current.disconnect();
      liveSessionRef.current = null;
    }

    setLiveState('connecting');
    setLiveError(null);
    setLiveOutputText('');
    setLiveInputText('');
    setLiveCommands([]);
    liveCommandsRef.current = [];
    liveConversationRef.current = [];

    let currentChatId = activeChatId;
    // If on a new/empty chat window with no ID, create a fresh chat for the live session.
    // If on an existing conversation, stay in that same chat.
    if (!currentChatId) {
      currentChatId = crypto.randomUUID();
      const newChat: ChatSession = {
        id: currentChatId,
        title: "Live Conversation",
        updatedAt: Date.now(),
        traceLogs: []
      };
      setChats(prev => {
        const updated = [newChat, ...prev];
        localStorage.setItem('eterx_chats', JSON.stringify(stripChatsForStorage(updated)));
        return updated;
      });
      setActiveChatId(currentChatId);
      setTraceLogs([]);
    }
    setActiveView('chat');

    try {
      // Fetch an API key from the pool
      const res = await fetch('/api/live/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: activeChatId || `live_${ Date.now() }`, apiKeys: readRuntimeApiKeys(), modelOverrides: readRuntimeModelOverrides() })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to get API key');
      }

      const { apiKey } = await res.json();

      const session = new GeminiLiveSession(apiKey, currentChatId, {
        onStateChange: (state) => {
          setLiveState(state);
          if (state !== 'connected' && state !== 'listening') {
            setLiveMicVolume(0);
          }
        },
        onMicVolume: (volume) => {
          setLiveMicVolume(volume);
        },
        onModelVolume: (volume) => {
          setLiveModelVolume(volume);
        },
        onToolCallActive: (toolName) => {
          setLiveActiveTool(toolName);
        },
        onToolAction: (text, secondary) => {
          const cmd = { type: 'command', text, secondary, isLive: true };
          setLiveCommands(prev => [...prev, cmd]);
          liveCommandsRef.current = [...liveCommandsRef.current, cmd];
        },
        onInputTranscription: (text) => {
          setLiveInputText(text);
        },
        onOutputTranscription: (text) => {
          setLiveOutputText(text);
        },
        onOutputPlaybackProgress: (spokenText) => {
          setLiveSpokenText(spokenText);
        },
        onTurnComplete: (userText, modelText) => {
          const newTraceLogs: any[] = [];
          if (userText.trim()) {
            newTraceLogs.push({ type: 'user_action', text: userText.trim(), isLive: true });
          }

          if (modelText.trim()) {
            newTraceLogs.push({ type: 'answer', text: modelText.trim(), isLive: true });
          }

          // Append buffered commands from this turn after the text
          newTraceLogs.push(...liveCommandsRef.current);
          if (newTraceLogs.length > 0) {
            setTraceLogs(prev => {
              const merged = [...prev, ...newTraceLogs];
              setChats(prevChats => {
                const updated = prevChats.map(c => {
                  if (c.id === currentChatId) {
                    const newTitle = c.title === "Live Conversation" && userText.trim() ? userText.trim().slice(0, 50) : c.title;
                    return { ...c, traceLogs: merged, updatedAt: Date.now(), title: newTitle };
                  }
                  return c;
                });
                localStorage.setItem('eterx_chats', JSON.stringify(stripChatsForStorage(updated)));
                return updated;
              });
              return merged;
            });
          }

          // Reset per-turn display text and buffered commands
          setLiveInputText('');
          setLiveOutputText('');
          setLiveSpokenText('');
          setLiveCommands([]);
          liveCommandsRef.current = [];
        },
        onInterrupted: () => {
          setLiveOutputText('');
          setLiveCommands([]);
          liveCommandsRef.current = [];
        },
        onError: (error) => {
          console.error('[LiveSession] Error:', error);
          setLiveError(error);
          setLiveState('error');
          setTimeout(() => {
            setLiveState('idle');
            setLiveError(null);
          }, 4000);
        },
      });

      liveSessionRef.current = session;
      await session.connect();

    } catch (error: any) {
      console.error('[LiveSession] Failed to start:', error);
      setLiveError(error.message || 'Failed to start Live API');
      setLiveState('error');
      setTimeout(() => {
        setLiveState('idle');
        setLiveError(null);
      }, 4000);
    }
  }, [activeChatId, revealNetworkBanner]);

  const stopLiveSession = useCallback(() => {
    if (liveSessionRef.current) {
      liveSessionRef.current.disconnect();
      liveSessionRef.current = null;
    }

    setLiveState('idle');
    setLiveOutputText('');
    setLiveSpokenText('');
    setLiveInputText('');
  }, []);

  const toggleLiveMicMute = useCallback(() => {
    setLiveMicMuted(prev => {
      const next = !prev;
      if (liveSessionRef.current) liveSessionRef.current.setMicMuted(next);
      return next;
    });
  }, []);

  const toggleLiveSpeakerMute = useCallback(() => {
    setLiveSpeakerMuted(prev => {
      const next = !prev;
      if (liveSessionRef.current) liveSessionRef.current.setSpeakerMuted(next);
      return next;
    });
  }, []);

  const getLiveTraceLogs = useCallback(() => {
    if (liveState === 'idle') return [];

    const logs = [];
    if (liveInputText) {
      logs.push({ type: 'user_action', text: liveInputText, isLive: true });
    }

    if (liveOutputText) {
      logs.push({ type: 'answer', text: liveOutputText, spokenText: liveSpokenText, isLive: true, isLiveTyping: true });
    }

    // Add any tool commands that happened in this live turn after the text
    if (liveCommands.length > 0) {
      logs.push(...liveCommands);
    }

    return logs;
  }, [liveState, liveInputText, liveOutputText, liveSpokenText, liveCommands]);

  useEffect(() => {
    setGreeting(getCatchyGreeting());
  }, []);

  useEffect(() => {
    if (!headerMenuOpen) {
      setHeaderSearchOpen(false);
      setHeaderSearchQuery("");
    }
  }, [headerMenuOpen]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('eterx_chats');
      if (saved) {
        const parsed = JSON.parse(saved);
        setChats(sortChats(parsed));
      }
    } catch (e) { }
  }, []);

  // ═══════════════════════════════════════════════════════════════
  // ALWAYS-ON POLLING: Agents and UI run at FULL SPEED at ALL TIMES.
  // No pausing, no slowing down — whether user is on screen or not.
  // The backend agent is fully independent. UI polling stays live 24/7.
  //
  // PAGE VISIBILITY FIX: When the user leaves and returns, OS/browser
  // throttle setTimeout chains. On return we immediately fire a catch-up
  // poll for all running chats instead of waiting for the next scheduled
  // tick — delivering buffered traces smoothly without a "burst" flash.
  // ═══════════════════════════════════════════════════════════════

  // Per-chat immediate catch-up poll callbacks on page visibility restore
  const catchUpPollersRef = useRef<Map<string, () => void>>(new Map());

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (activeViewRef.current === 'chat') clearUnreadChat(activeChatIdRef.current);
        // Page just became visible — immediately trigger a catch-up for all running chats
        // so we deliver all accumulated traces smoothly rather than waiting for next timeout
        for (const catchUpPoll of catchUpPollersRef.current.values()) {
          catchUpPoll();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [clearUnreadChat]);


  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setCmdPaletteOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (activeChatId) {
      const activeChat = chats.find(c => c.id === activeChatId);
      if (activeChat && !isDefaultChatTitle(activeChat.title)) {
        document.title = activeChat.title;
        return;
      }
    }
    document.title = "EterX";
  }, [activeChatId, chats]);

  useEffect(() => {
    if (activeView === 'chat' && activeChatId) clearUnreadChat(activeChatId);
  }, [activeChatId, activeView, clearUnreadChat]);

  const updateActiveChatLogs = (updater: any[] | ((prev: any[]) => any[])): any[] => {
    let finalLogs: any[] = [];
    setTraceLogs(prev => {
      finalLogs = typeof updater === 'function' ? updater(prev) : updater;
      if (activeChatId) {
        setChats(currentChats => {
          const updated = currentChats.map(c =>
            c.id === activeChatId ? { ...c, traceLogs: finalLogs, updatedAt: Date.now() } : c
          );
          const sorted = sortChats(updated);
          localStorage.setItem('eterx_chats', JSON.stringify(stripChatsForStorage(sorted)));
          return sorted;
        });
      }
      return finalLogs;
    });
    return finalLogs;
  };

  const AGENT_CONNECTION_NOTE_ID = 'eterx-agent-connection';
  const isAgentConnectionLog = (log: any) =>
    !!log && (log._connection === true || (log.type === 'work_note' && log.noteId === AGENT_CONNECTION_NOTE_ID));
  const stripAgentConnectionLogs = (logs: any[] = []) => logs.filter(log => !isAgentConnectionLog(log));
  const getConsoleOutputText = (log: any) => String(log?.output ?? log?.content ?? '');
  const findMergeableConsoleOutputIndex = (logs: any[], trace: any) => {
    const streamId = String(trace?.streamId || '');
    if (!streamId) return -1;
    for (let i = logs.length - 1; i >= 0; i -= 1) {
      const log = logs[i];
      if (log?.type === 'user_action') break;
      if (log?.type === 'console_output' && String(log.streamId || '') === streamId) return i;
    }
    return -1;
  };
  const isDuplicateConsoleOutput = (logs: any[], trace: any) => {
    const traceText = getConsoleOutputText(trace);
    return logs.some((log: any) =>
      log?.type === 'console_output' &&
      log.command === trace.command &&
      getConsoleOutputText(log) === traceText
    );
  };
  const stripTraceLogForStorage = (log: any) => {
    if (log?.type === 'file_preview' && typeof log.content === 'string' && log.content.length > 500) {
      const { content: _content, ...rest } = log;
      return { ...rest, _contentStripped: true };
    }
    if (log?.type === 'console_output') {
      const outputText = getConsoleOutputText(log);
      if (outputText.length > 500) {
        const { output: _output, content: _content, ...rest } = log;
        return {
          ...rest,
          outputPreview: outputText.substring(0, 500),
          _contentStripped: true
        };
      }
    }
    return log;
  };
  const stripChatsForStorage = (chatList: ChatSession[]) =>
    chatList.map(chat => ({
      ...chat,
      traceLogs: (chat.traceLogs || []).map(stripTraceLogForStorage)
    }));
  const isTerminalAgentStatus = (status: any) => status === 'completed' || status === 'failed' || status === 'stopped';
  const normalizeClientTraceTime = (value: unknown, fallback = Date.now()) => {
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw <= 0) return fallback;
    let timestamp = raw < 10_000_000_000 ? raw * 1000 : raw;
    while (timestamp > 10_000_000_000_000) timestamp = Math.floor(timestamp / 1000);
    const now = Date.now();
    const minPlausible = Date.UTC(2020, 0, 1);
    return timestamp >= minPlausible && timestamp <= now + 60_000 ? timestamp : fallback;
  };
  const withTraceTiming = (trace: any, fallback = Date.now()) => {
    const timestamp = normalizeClientTraceTime(trace?.timestamp, fallback);
    const startTime = normalizeClientTraceTime(trace?.startTime, timestamp);
    const endTime = normalizeClientTraceTime(trace?.endTime, timestamp);
    return { ...trace, timestamp, startTime, endTime };
  };
  const interAgentMessageLog = (message: any, agentNameOverride?: string) => {
    const at = normalizeClientTraceTime(message?.timestamp, Date.now());
    const agentName = agentNameOverride || (message?.to && message.to !== '*' && message.to !== 'Main' ? message.to : message?.from);
    const deliverAfter = Number(message?.deliverAfter || message?.metadata?.deliverAfter || 0) || undefined;
    return {
      id: `comm_${ message?.id || `${ at }_${ Math.random().toString(36).slice(2, 8) }` }`,
      type: 'inter_agent_message',
      text: String(message?.body || message?.text || ''),
      from: message?.from || 'Main',
      to: message?.to || agentName,
      subject: message?.subject || 'Agent message',
      body: String(message?.body || message?.text || ''),
      messageType: message?.type || message?.messageType || 'coordination',
      priority: message?.priority || message?.metadata?.priority || 'normal',
      deliveryMode: message?.deliveryMode || message?.metadata?.deliveryMode || 'defer',
      scheduled: message?.scheduled === true || (deliverAfter ? deliverAfter > Date.now() : false),
      deliverAfter,
      requiresResponse: message?.requiresResponse === true || message?.metadata?.requiresResponse === true,
      messageId: message?.id || message?.messageId,
      replyTo: message?.replyTo || message?.metadata?.replyTo,
      filePaths: message?.filePaths || message?.metadata?.filePaths,
      artifactPaths: message?.artifactPaths || message?.metadata?.artifactPaths,
      tags: message?.tags || message?.metadata?.tags,
      agentName,
      subAgent: agentName && agentName !== 'Main' ? agentName : undefined,
      timestamp: at,
      startTime: at,
      endTime: at,
    };
  };
  const parseScheduledAgentMessage = (raw: string) => {
    const match = raw.match(/^\/(?:in|after)\s+(\d+)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\s+([\s\S]+)$/i);
    if (!match) return { text: raw, deliverAfterMs: undefined as number | undefined, label: '' };
    const value = Math.max(0, Number(match[1]) || 0);
    const unit = match[2].toLowerCase();
    const multiplier = unit === 'ms'
      ? 1
      : unit.startsWith('s')
        ? 1000
        : unit.startsWith('h') || unit === 'hr' || unit === 'hrs'
          ? 3_600_000
          : 60_000;
    const deliverAfterMs = Math.min(value * multiplier, 86_400_000);
    return {
      text: match[3].trim(),
      deliverAfterMs,
      label: `${ value }${ unit }`,
    };
  };
  const systemThoughtLog = (text: string, at = Date.now()) => ({
    type: 'thought',
    text,
    timestamp: at,
    startTime: at,
    endTime: at,
  });

  const removeRunningChat = (chatId: string) => {
    setRunningChats(prev => {
      if (!prev.has(chatId)) return prev;
      const next = new Set(prev);
      next.delete(chatId);
      return next;
    });
  };

  const setChatLogsById = (
    chatId: string,
    nextLogsOrUpdater: any[] | ((prev: any[]) => any[]),
    options: { touchUpdatedAt?: boolean } = {}
  ) => {
    if (activeChatIdRef.current === chatId) {
      setTraceLogs(prevLogs => typeof nextLogsOrUpdater === 'function'
        ? nextLogsOrUpdater(prevLogs)
        : nextLogsOrUpdater
      );
    }

    setChats(currentChats => {
      const updated = currentChats.map(chat => {
        if (chat.id !== chatId) return chat;
        const previousLogs = chat.traceLogs || [];
        const nextLogs = typeof nextLogsOrUpdater === 'function'
          ? nextLogsOrUpdater(previousLogs)
          : nextLogsOrUpdater;
        return {
          ...chat,
          traceLogs: nextLogs,
          updatedAt: options.touchUpdatedAt ? Date.now() : chat.updatedAt,
        };
      });
      const sorted = options.touchUpdatedAt ? sortChats(updated) : updated;
      try { localStorage.setItem('eterx_chats', JSON.stringify(stripChatsForStorage(sorted))); } catch { }
      return sorted;
    });
  };

  const clearAgentConnectionStatus = (chatId: string) => {
    setChatLogsById(chatId, logs => stripAgentConnectionLogs(logs));
  };

  const loadChat = (id: string) => {
    let chat = chats.find(c => c.id === id);

    // CRITICAL: Read freshest trace data from localStorage.
    // The background poller writes to localStorage on every tick, but React state
    // may be stale (closure). Without this, switching back to an initializing chat
    // shows the "Agent is initializing" screen even though traces already exist.
    try {
      const stored = JSON.parse(localStorage.getItem('eterx_chats') || '[]');
      const freshChat = stored.find((c: any) => c.id === id);
      if (freshChat && (freshChat.traceLogs?.length || 0) > (chat?.traceLogs?.length || 0)) {
        chat = { ...chat, ...freshChat };
      }
    } catch { /* fallback to React state */ }

    if (chat) {
      activeChatIdRef.current = id;
      setActiveChatId(id);
      setTraceLogs(chat.traceLogs || []);
      setActiveWorkspacePath(chat.workspacePath || null);
      if (typeof window !== 'undefined') {
        if (chat.workspacePath) {
          localStorage.setItem('eterx_active_workspace_path', chat.workspacePath);
        } else {
          localStorage.removeItem('eterx_active_workspace_path');
        }
      }
      setActiveRunLocation(chat.runLocation || 'local');
      clearUnreadChat(id);
      if (window.innerWidth < 768) setSidebarOpen(false);

      // Clear buildingAgentId if we're not loading a builder chat
      if (!id.startsWith('agent_builder_')) {
        setBuildingAgentId(null);
      } else {
        // If it IS a builder chat, extract the agentId from the chatId
        const agentId = id.replace('agent_builder_', '');
        setBuildingAgentId(agentId);
      }

      // ALL pollers run at the same speed — no restart needed on chat switch.
      // Just check if this chat has an active agent that isn't being polled yet.
      if (pollingIntervalsRef.current.has(id)) {
        // Already polling — just mark as running for UI
        setRunningChats(prev => new Set(prev).add(id));
      } else {
        // No poller — check server for a running agent
        fetchAgentPoll(id, -1, 5000)
          .then(data => {
            if (data.status === 'running') {
              // Agent is running! Merge server traces into the current turn.
              if (data.traces && data.traces.length > 0) {
                const mergedLogs = mergeServerRunLogs(chat.traceLogs || [], data.traces);

                setTraceLogs(mergedLogs);
                setChats(prev => {
                  const updated = prev.map(c => c.id === id ? { ...c, traceLogs: mergedLogs } : c);
                  try { localStorage.setItem('eterx_chats', JSON.stringify(stripChatsForStorage(updated))); } catch { }
                  return updated;
                });
              }
              setRunningChats(prev => new Set(prev).add(id));
              startPolling(id, data.maxIndex ?? (data.totalTraces - 1));
            }
          })
          .catch(() => { /* offline — just show local state */ });
      }

      setTimeout(() => {
        const container = document.getElementById('chat-container');
        if (container) container.scrollTop = container.scrollHeight;
      }, 50);
    }
  };

  const handleWorkspacePathChange = useCallback((path: string | null) => {
    setActiveWorkspacePath(path);
    if (typeof window !== 'undefined') {
      if (path) {
        localStorage.setItem('eterx_active_workspace_path', path);
      } else {
        localStorage.removeItem('eterx_active_workspace_path');
      }
    }
    if (activeChatId) {
      setChats(prev => {
        const updated = prev.map(chat => chat.id === activeChatId ? { ...chat, workspacePath: path } : chat);
        localStorage.setItem('eterx_chats', JSON.stringify(stripChatsForStorage(updated)));
        return updated;
      });
    }
  }, [activeChatId]);

  const handleRunLocationChange = useCallback((location: 'local' | 'sandbox') => {
    setActiveRunLocation(location);
    if (activeChatId) {
      setChats(prev => {
        const updated = prev.map(chat => chat.id === activeChatId ? { ...chat, runLocation: location } : chat);
        localStorage.setItem('eterx_chats', JSON.stringify(stripChatsForStorage(updated)));
        return updated;
      });
    }
  }, [activeChatId]);

  const handleOpenAgentBuilder = (id: string) => {
    setBuildingAgentId(id);
    const builderChatId = `agent_builder_${ id }`;
    let chat = chats.find(c => c.id === builderChatId);
    if (!chat) {
      chat = {
        id: builderChatId,
        title: `Building Agent: ${ id }`,
        updatedAt: Date.now(),
        traceLogs: []
      };
      setChats(prev => {
        const updated = [chat!, ...prev];
        localStorage.setItem('eterx_chats', JSON.stringify(stripChatsForStorage(updated)));
        return updated;
      });
      activeChatIdRef.current = builderChatId;
      setActiveChatId(builderChatId);
      setTraceLogs([]);
    } else {
      loadChat(builderChatId);
    }
  };

  const handleUseAgentInChat = useCallback((agentId: string | null, agentName: string) => {
    handleAgentChange(agentId, agentName);
    setBuildingAgentId(null);
    setActiveView('chat');
    setInputValue('');

    if (activeChatIdRef.current?.startsWith('agent_builder_')) {
      activeChatIdRef.current = null;
      setActiveChatId(null);
      setTraceLogs([]);
      setMonitorOpen(false);
    }
  }, [handleAgentChange]);

  const createNewChat = () => {
    activeChatIdRef.current = null;
    setActiveChatId(null);
    setMonitorOpen(false);
    setTraceLogs([]);
    setInputValue('');
    setBuildingAgentId(null);
  };

  const deleteChats = (ids: string[]) => {
    const idsToDelete = [...new Set(ids)].filter(Boolean);
    if (idsToDelete.length === 0) return;

    const deleteSet = new Set(idsToDelete);
    const deletingActiveChat = !!activeChatId && deleteSet.has(activeChatId);
    if (deletingActiveChat) activeChatIdRef.current = null;

    if (localStorageTimerRef.current) {
      clearTimeout(localStorageTimerRef.current);
      localStorageTimerRef.current = null;
    }
    pendingLocalStorageWrite.current = false;

    idsToDelete.forEach(chatId => {
      const timeoutId = pollingIntervalsRef.current.get(chatId);
      if (timeoutId) clearTimeout(timeoutId);
      pollingIntervalsRef.current.delete(chatId);
      pollCursorsRef.current.delete(chatId);
      pollRunStartRef.current.delete(chatId);
      pollRunIdRef.current.delete(chatId);
      pollGenerationRef.current.set(chatId, (pollGenerationRef.current.get(chatId) || 0) + 1);
      catchUpPollersRef.current.delete(chatId);
      notifiedChatIdsRef.current.delete(chatId);
      fetch('/api/agent/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId })
      }).catch(() => { });
    });

    if (deletingActiveChat && abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    setRunningChats(prev => {
      const next = new Set(prev);
      idsToDelete.forEach(chatId => next.delete(chatId));
      return next;
    });

    setUnreadChatIds(prev => {
      const next = new Set(prev);
      idsToDelete.forEach(chatId => next.delete(chatId));
      return next.size === prev.size ? prev : next;
    });

    setChats(prev => {
      const updated = prev.filter(c => !deleteSet.has(c.id));
      localStorage.setItem('eterx_chats', JSON.stringify(stripChatsForStorage(updated)));
      return updated;
    });

    if (deletingActiveChat) {
      setActiveChatId(null);
      setTraceLogs([]);
      setBuildingAgentId(null);
    }
  };

  const deleteChat = (id: string) => {
    deleteChats([id]);
  };

  const renameChat = (id: string, newTitle: string) => {
    setChats(prev => {
      const updated = prev.map(c =>
        c.id === id ? { ...c, title: newTitle, updatedAt: Date.now() } : c
      );
      const sorted = sortChats(updated);
      localStorage.setItem('eterx_chats', JSON.stringify(stripChatsForStorage(sorted)));
      return sorted;
    });
  };

  const toggleFavorite = (id: string) => {
    setChats(prev => {
      const updated = prev.map(c =>
        c.id === id ? { ...c, isFavorite: !c.isFavorite } : c
      );
      const sorted = sortChats(updated);
      localStorage.setItem('eterx_chats', JSON.stringify(stripChatsForStorage(sorted)));
      return sorted;
    });
  };

  const fetchGeneratedTitle = async (history: any[], currentTitle?: string, mode: MainAgentMode = agentMode): Promise<string | null> => {
    const res = await fetch('/api/chat/title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        history,
        currentTitle: currentTitle || DEFAULT_CHAT_TITLE,
        mode,
        apiKeys: readRuntimeApiKeys(),
        modelOverrides: readRuntimeModelOverrides()
      })
    });

    if (!res.ok) return null;

    const data = await res.json();
    const title = String(data.title || '').trim();
    return title && !isDefaultChatTitle(title) ? title : null;
  };

  const generateTitle = async (chatId: string, history: any[], currentTitle?: string, mode: MainAgentMode = agentMode) => {
    try {
      // Use passed title or fall back to finding in current state (for background updates)
      const existingTitle = currentTitle || chats.find(c => c.id === chatId)?.title || DEFAULT_CHAT_TITLE;

      const title = await fetchGeneratedTitle(history, existingTitle, mode);
      if (title && title !== existingTitle) {
        setChats(prev => {
          const updated = prev.map(c =>
            c.id === chatId ? { ...c, title, updatedAt: Date.now() } : c
          );
          const sorted = sortChats(updated);
          localStorage.setItem('eterx_chats', JSON.stringify(stripChatsForStorage(sorted)));
          return sorted;
        });
      }
    } catch (e) {
      console.warn('[Naming] Background naming failed:', e);
    }
  };

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    const next = scrollHeight - scrollTop - clientHeight > 100;
    setShowScrollBottom(prev => prev === next ? prev : next);
  }, []);

  const handleAnswerAskUser = useCallback((timestamp: number, answer: string, responseKey?: string) => {
    const answeredWith = String(answer || '').trim();
    const normalizedResponseKey = String(responseKey || '').trim();
    if ((!timestamp && !normalizedResponseKey) || !answeredWith) return;

    const answeredAt = Date.now();
    const markAnswered = (logs: any[] = []) => logs.map((log: any) => {
      if (log?.type !== 'ask_user') return log;
      const sameResponseKey = normalizedResponseKey && String(log.responseKey || '') === normalizedResponseKey;
      const sameTimestamp = timestamp && Number(log.timestamp) === Number(timestamp);
      if (!sameResponseKey && !sameTimestamp) return log;
      return { ...log, answeredWith, answeredAt };
    });

    setTraceLogs(prev => markAnswered(prev));

    if (!activeChatId) return;
    setChats(prev => {
      const updated = prev.map(chat =>
        chat.id === activeChatId
          ? { ...chat, traceLogs: markAnswered(chat.traceLogs || []), updatedAt: answeredAt }
          : chat
      );
      const sorted = sortChats(updated);
      try {
        window.localStorage.setItem('eterx_chats', JSON.stringify(stripChatsForStorage(sorted)));
      } catch { }
      return sorted;
    });
  }, [activeChatId]);

  const fetchAgentPoll = async (chatId: string, after: number, timeoutMs = 8000) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`/api/agent/poll?chatId=${ encodeURIComponent(chatId) }&after=${ after }`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Poll HTTP ${ res.status }`);
      return await res.json();
    } finally {
      window.clearTimeout(timeout);
    }
  };

  const mergeTaskPlanLog = (logs: any[], trace: any) => {
    let planIdx = -1;
    for (let i = logs.length - 1; i >= 0; i--) {
      if (logs[i]?.type === 'user_action') break;
      if (logs[i]?.type === 'task_plan') {
        planIdx = i;
        break;
      }
    }

    if (planIdx >= 0) {
      logs[planIdx] = {
        ...logs[planIdx],
        ...trace,
        startTime: logs[planIdx].startTime || trace.startTime,
        endTime: trace.endTime,
        timestamp: trace.timestamp,
      };
    } else {
      logs.push(trace);
    }
  };

  /**
   * Process raw server trace events into the format expected by the UI.
   * Handles merging thought_stream, answer, and other events.
   */
  const processServerTraces = (traces: any[], existingLogs: any[] = []): any[] => {
    const logs: any[] = [];
    // Only dedup within current turn (after last user_action in existing logs)
    const lastUserIdx = existingLogs.reduceRight((found, l, i) => found === -1 && l.type === 'user_action' ? i : found, -1);
    const dedupScope = lastUserIdx >= 0 ? existingLogs.slice(lastUserIdx) : existingLogs;
    const seenTraceIdx = new Set(
      dedupScope
        .map((log: any) => log?._traceIdx)
        .filter((idx: any) => idx !== undefined && idx !== null)
    );
    for (const trace of traces) {
      // Deduplicate by _traceIdx only within current turn
      if (trace._traceIdx !== undefined && trace._traceIdx !== null) {
        if (seenTraceIdx.has(trace._traceIdx)) continue;
        seenTraceIdx.add(trace._traceIdx);
      }

      let processedLog = withTraceTiming(trace);
      const traceAt = processedLog.endTime;

      // Preserve isLive status if this trace matches a local log that was marked as live
      if (trace.type === 'command' || trace.type === 'answer') {
        const localMatch = existingLogs.find(l =>
          l.type === trace.type &&
          (l.text === trace.text || (trace._traceIdx !== undefined && l._traceIdx === trace._traceIdx))
        );
        if (localMatch?.isLive) {
          processedLog.isLive = true;
        }
      }

      if (trace.type === 'work_note_cancel') {
        const subAgent = trace.subAgent || null;
        const noteId = trace.noteId || null;
        // Mark rather than splice — prevents flash when final work_note follows
        for (let i = logs.length - 1; i >= 0; i--) {
          if (logs[i].type === 'user_action') break;
          if (
            logs[i].type === 'work_note' &&
            (logs[i].subAgent || null) === subAgent &&
            (!noteId || logs[i].noteId === noteId)
          ) {
            logs[i] = { ...logs[i], _streamingCancelled: true };
            break;
          }
        }
        continue;
      }

      if (trace.type === 'thought_stream') {
        const subAgent = trace.subAgent || null;
        const thoughtId = trace.thoughtId || null;
        let mergeIdx = -1;
        for (let i = logs.length - 1; i >= 0; i--) {
          if (logs[i].type === 'user_action') break;
          if (logs[i].type === 'thought_stream' && (logs[i].subAgent || null) === subAgent) {
            if (thoughtId && logs[i].thoughtId && logs[i].thoughtId !== thoughtId) break;
            mergeIdx = i;
            break;
          }
        }
        if (mergeIdx >= 0) {
          // Preserve the original startTime from when the thought began
          logs[mergeIdx] = { ...logs[mergeIdx], text: trace.text, thoughtId, _traceIdx: trace._traceIdx, timestamp: traceAt, startTime: logs[mergeIdx].startTime, endTime: trace.endTime ?? traceAt };
        } else {
          logs.push({ type: 'thought_stream', text: trace.text, subAgent, thoughtId, _traceIdx: trace._traceIdx, timestamp: traceAt, startTime: trace.startTime ?? traceAt, endTime: trace.endTime ?? traceAt });
        }
      } else if (trace.type === 'work_note') {
        const subAgent = trace.subAgent || null;
        const noteId = trace.noteId || null;
        const incomingIsFinal = trace.isStreaming === false || trace.isDelta === false;
        const noteText = formatVisibleWorkNote(String(trace.text || ''));
        if (!noteText) continue;
        let mergeIdx = -1;
        let duplicateIdx = -1;
        for (let i = logs.length - 1; i >= 0; i--) {
          if (logs[i].type === 'user_action') break;
          if (logs[i].type === 'work_note' && (logs[i].subAgent || null) === subAgent) {
            const existingText = String(logs[i].text || '').trim();
            if (noteId && logs[i].noteId && logs[i].noteId === noteId) {
              mergeIdx = i;
              break;
            }
            // Merge final note into a streaming-cancelled placeholder
            if (logs[i]._streamingCancelled && incomingIsFinal) {
              mergeIdx = i;
              break;
            }
            if (existingText === noteText) {
              if (incomingIsFinal && (logs[i].isStreaming || logs[i].isDelta)) {
                mergeIdx = i;
              } else {
                duplicateIdx = i;
              }
              break;
            }
            if (!noteId || !logs[i].noteId) {
              mergeIdx = i;
              break;
            }
          }
        }
        if (duplicateIdx >= 0) continue;
        if (mergeIdx >= 0) {
          logs[mergeIdx] = {
            ...logs[mergeIdx],
            ...trace,
            type: 'work_note',
            text: noteText,
            subAgent,
            noteId,
            _traceIdx: trace._traceIdx ?? logs[mergeIdx]._traceIdx,
            timestamp: traceAt,
            startTime: logs[mergeIdx].startTime || processedLog.startTime,
            endTime: traceAt,
            _streamingCancelled: undefined,
          };
        } else {
          logs.push({ ...processedLog, type: 'work_note', text: noteText, subAgent, noteId, _traceIdx: trace._traceIdx, startTime: processedLog.startTime, endTime: traceAt });
        }
      } else if (trace.type === 'ask_user') {
        const question = String(trace.question || '').trim();
        if (!question) {
          continue;
        }

        const responseKey = String(trace.responseKey || (trace.timestamp ? `ask_user_${ trace.timestamp }` : '')).trim();
        let askIdx = -1;
        for (let i = logs.length - 1; i >= 0; i--) {
          if (logs[i].type === 'user_action') break;
          if (logs[i].type !== 'ask_user') continue;
          const sameResponseKey = responseKey && logs[i].responseKey === responseKey;
          const sameQuestion = String(logs[i].question || '').trim() === question;
          if (sameResponseKey || sameQuestion) {
            askIdx = i;
            break;
          }
        }

        const nextAskLog = {
          ...processedLog,
          ...trace,
          type: 'ask_user',
          question,
          responseKey: responseKey || processedLog.responseKey,
          timestamp: Number(trace.timestamp || processedLog.timestamp || traceAt),
          startTime: processedLog.startTime,
          endTime: traceAt,
        };

        if (askIdx >= 0) {
          logs[askIdx] = {
            ...logs[askIdx],
            ...nextAskLog,
            answeredWith: logs[askIdx].answeredWith,
            answeredAt: logs[askIdx].answeredAt,
          };
        } else {
          logs.push(nextAskLog);
        }
      } else if (trace.type === 'task_plan') {
        mergeTaskPlanLog(logs, processedLog);
      } else if (trace.type === 'answer' && !trace.subAgent) {
        let answerIdx = -1;
        for (let i = logs.length - 1; i >= 0; i--) {
          if (logs[i].type === 'user_action') break;
          if (logs[i].type === 'answer') { answerIdx = i; break; }
        }
        if (answerIdx >= 0) {
          logs[answerIdx] = { ...logs[answerIdx], ...processedLog, text: trace.text, _traceIdx: trace._traceIdx, isLive: processedLog.isLive };
        } else {
          logs.push(processedLog);
        }
      } else if (trace.type === 'file_preview') {
        const stablePreviewIdx = logs.findLastIndex((l: any) =>
          l.type === 'file_preview' && (
            (trace._traceIdx !== undefined && trace._traceIdx !== null && l._traceIdx === trace._traceIdx) ||
            (trace.traceId && l.traceId === trace.traceId) ||
            (trace.id && l.id === trace.id)
          )
        );
        if (stablePreviewIdx >= 0) {
          logs[stablePreviewIdx] = { ...processedLog, startTime: logs[stablePreviewIdx].startTime || processedLog.startTime, endTime: traceAt };
        } else {
          const tracePreviewPath = String(trace.filepath || trace.filename || '');
          const existingIdx = trace.ownerTraceId
            ? logs.findLastIndex((l: any) =>
              l.type === 'file_preview' &&
              l.ownerTraceId === trace.ownerTraceId &&
              (!tracePreviewPath || String(l.filepath || l.filename || '') === tracePreviewPath)
            )
            : trace.dedupe !== false
              ? logs.findLastIndex((l: any) => l.type === 'file_preview' && l.filepath === trace.filepath && l.dedupe !== false)
              : -1;
          if (existingIdx >= 0) {
            logs[existingIdx] = { ...processedLog, startTime: logs[existingIdx].startTime || processedLog.startTime, endTime: traceAt };
          } else {
            logs.push(processedLog);
          }
        }
      } else if (trace.type === 'console_output') {
        const mergeIdx = findMergeableConsoleOutputIndex(logs, trace);
        if (mergeIdx >= 0) {
          logs[mergeIdx] = {
            ...logs[mergeIdx],
            ...processedLog,
            _traceIdx: trace._traceIdx ?? logs[mergeIdx]._traceIdx,
            startTime: logs[mergeIdx].startTime || processedLog.startTime,
            endTime: traceAt,
            timestamp: traceAt,
          };
        } else if (!isDuplicateConsoleOutput(logs, trace)) {
          logs.push(processedLog);
        }
      } else if (trace.type === 'done') {
        // Skip — handled by polling completion
      } else if (trace.type === 'error') {
        logs.push({ type: 'thought_stream', text: `Error: ${ trace.data || trace.text || 'Unknown error' }`, _traceIdx: trace._traceIdx, timestamp: traceAt, startTime: traceAt, endTime: traceAt });
      } else {
        // When a real (non-instant) action trace arrives, remove any preceding _instant preview
        if (!trace._instant && (trace.type === 'command' || trace.type === 'file_edit' || trace.type === 'exploration')) {
          const instantIdx = logs.findIndex(l => l._instant && l.type === trace.type);
          if (instantIdx >= 0) logs.splice(instantIdx, 1);
        }
        // Skip _instant traces if a real trace of same type already exists
        if (trace._instant && logs.some(l => !l._instant && (l.type === 'command' || l.type === 'file_edit' || l.type === 'exploration'))) {
          continue;
        }
        logs.push(processedLog);
      }
    }
    return logs;
  };

  const mergeServerRunLogs = (existingLogs: any[], traces: any[]) => {
    const logs = Array.isArray(existingLogs) ? existingLogs : [];
    const lastUserIdx = logs.reduceRight((found, log, index) =>
      found === -1 && log.type === 'user_action' ? index : found, -1);
    const prefix = lastUserIdx >= 0 ? logs.slice(0, lastUserIdx + 1) : [];
    return [...prefix, ...processServerTraces(traces, prefix)];
  };

  // Debounced localStorage writer — prevents data corruption from rapid concurrent writes
  const debouncedSaveToLocalStorage = () => {
    pendingLocalStorageWrite.current = true;
    if (localStorageTimerRef.current) return; // Already scheduled
    localStorageTimerRef.current = setTimeout(() => {
      localStorageTimerRef.current = null;
      if (pendingLocalStorageWrite.current) {
        pendingLocalStorageWrite.current = false;
        // Read current chats state and write to localStorage
        setChats(currentChats => {
          try { localStorage.setItem('eterx_chats', JSON.stringify(stripChatsForStorage(currentChats))); } catch { }
          return currentChats; // Don't modify state
        });
      }
    }, 2000); // Write at most every 2 seconds during polling
  };
  /**
   * Start incremental polling for a specific chat.
   * Each chat has its own polling interval — fully independent.
   * 
   * DESIGN: ALL chats poll at the SAME full speed. No background slowdown.
   * - 150ms when receiving data (streaming), 250ms when idle
   * - Exponential backoff on network errors (caps at 5s), auto-recovers
   * - Agent runs at full speed whether user is on screen or not
   * - Does NOT stop on 'idle' status (race: agent hasn't started yet)
   * - Does NOT update updatedAt (prevents sidebar reordering chaos)
   * - Debounces localStorage writes (prevents data corruption)
   * - Only updates visible traceLogs for the ACTIVE chat
  */
  const startPolling = (chatId: string, initialCursor: number = -1, runStartedAfter?: number) => {
    // A replacement poller gets its own generation. Any old request that
    // resolves later becomes a no-op instead of clearing the new run's UI.
    if (pollingIntervalsRef.current.has(chatId)) {
      stopPolling(chatId, false);
    }
    const pollGeneration = (pollGenerationRef.current.get(chatId) || 0) + 1;
    pollGenerationRef.current.set(chatId, pollGeneration);
    if (typeof runStartedAfter === 'number') {
      pollRunStartRef.current.set(chatId, runStartedAfter);
    }

    pollCursorsRef.current.set(chatId, initialCursor);
    let idleCount = 0; // Track consecutive idle responses
    let errorBackoff = 0; // Exponential backoff on errors (0 = no error)
    let lastHadData = false; // Track if last poll had new data

    const finishDisconnectedStart = (message: string) => {
      stopPolling(chatId);
      clearAgentConnectionStatus(chatId);
      removeRunningChat(chatId);
      markChatUnreadIfBackground(chatId);
      setChatLogsById(chatId, logs => [
        ...stripAgentConnectionLogs(logs),
        systemThoughtLog(`\n\n*${ message }*`)
      ]);
    };

    const handleStartPending = () => {
      idleCount++;
      lastHadData = false;
      // Only stop after 100s of continuous pending state. This covers Next.js
      // cold compilation and slow registry startup without leaving the UI stuck.
      if (idleCount > 400) {
        finishDisconnectedStart('Agent connection did not start. Please retry this message.');
        return false;
      }
      scheduleNextPoll();
      return true;
    };

    const scheduleNextPoll = () => {
      if (pollGenerationRef.current.get(chatId) !== pollGeneration) return;
      // UNIFORM SPEED: All chats get the same full-speed polling.
      // No active/background distinction — every agent is a first-class citizen.
      let delay: number;
      if (networkPausedRef.current) {
        delay = 1000;
      } else if (errorBackoff > 0) {
        delay = Math.min(5000, 500 * Math.pow(2, errorBackoff - 1)); // 500ms, 1s, 2s, 4s, 5s cap
      } else {
        delay = lastHadData ? 150 : 250; // Full speed: 150ms streaming, 250ms idle
      }

      const timeoutId = setTimeout(pollOnce, delay);
      pollingIntervalsRef.current.set(chatId, timeoutId as any);
    };

    // Reference to the poll function — registered with catchUpPollersRef so the
    // page visibility handler can trigger an immediate catch-up when user returns
    // (fixes the "UI burst" bug where all buffered traces appear at once)
    const pollOnce = async () => {

      // Safety: if we were stopped while waiting, don't run
      if (!pollingIntervalsRef.current.has(chatId) || pollGenerationRef.current.get(chatId) !== pollGeneration) return;
      if (networkPausedRef.current) {
        errorBackoff = 0;
        lastHadData = false;
        scheduleNextPoll();
        return;
      }

      try {
        const cursor = pollCursorsRef.current.get(chatId) ?? -1;
        const data = await fetchAgentPoll(chatId, cursor);

        // The request may have been replaced while awaiting the response.
        if (!pollingIntervalsRef.current.has(chatId) || pollGenerationRef.current.get(chatId) !== pollGeneration) return;

        // Reset error backoff on successful fetch
        errorBackoff = 0;

        const expectedRunId = pollRunIdRef.current.get(chatId);
        const serverRunId = typeof data.runId === 'string' ? data.runId : '';
        if (expectedRunId && serverRunId !== expectedRunId) {
          if (!handleStartPending()) return;
          return;
        }

        const expectedRunStart = pollRunStartRef.current.get(chatId) || 0;
        const serverRunStart = typeof data.startedAt === 'number' ? data.startedAt : 0;
        const isStaleServerRun = !!(expectedRunStart && serverRunStart && serverRunStart + 1000 < expectedRunStart);

        if (isStaleServerRun) {
          if (!handleStartPending()) return;
          return;
        }

        // Track idle responses — stop after 30 seconds of continuous idle
        // (agent never started, or server restarted)
        if (data.status === 'idle') {
          if (!handleStartPending()) return;
          return; // Don't process â€” agent hasn't started yet
        }
        idleCount = 0; // Agent exists, reset idle counter

        lastHadData = data.traces && data.traces.length > 0;
        if (data.traces && data.traces.length > 0) {
          // Update cursor using server's stable monotonic maxIndex (NOT totalTraces - 1)
          if (data.maxIndex !== undefined && data.maxIndex >= 0) {
            pollCursorsRef.current.set(chatId, data.maxIndex);
          } else {
            pollCursorsRef.current.set(chatId, data.maxIndex ?? (data.totalTraces - 1));
          }

          // CRITICAL: Check if this poll is for the CURRENTLY ACTIVE chat
          const isActiveChat = activeChatIdRef.current === chatId;

          // ═══════════════════════════════════════════
          // UNIFIED TRACE PROCESSOR — used for BOTH active and background chats
          // Prevents duplicate action containers by deduplicating on _traceIdx
          // ═══════════════════════════════════════════
          const processTraces = (existingLogs: any[]): any[] => {
            let logs = stripAgentConnectionLogs([...existingLogs]);
            // Find start of current turn (after last user_action) for dedup scoping
            const lastUserIdx = logs.reduceRight((found, l, i) => found === -1 && l.type === 'user_action' ? i : found, -1);
            const currentTurnLogs = lastUserIdx >= 0 ? logs.slice(lastUserIdx) : logs;
            const seenTraceIdx = new Set(
              currentTurnLogs
                .map((log: any) => log?._traceIdx)
                .filter((idx: any) => idx !== undefined && idx !== null)
            );
            for (const trace of data.traces) {
              // DEDUP: only skip if _traceIdx already exists in the CURRENT TURN (not old questions)
              if (trace._traceIdx !== undefined && trace._traceIdx !== null) {
                if (seenTraceIdx.has(trace._traceIdx)) continue;
                seenTraceIdx.add(trace._traceIdx);
              }
              const timedTrace = withTraceTiming(trace);
              const traceAt = timedTrace.endTime;

              if (trace.type === 'work_note_cancel') {
                const subAgent = trace.subAgent || null;
                const noteId = trace.noteId || null;
                // Mark the streaming worknote as cancelled rather than removing it.
                // This preserves its DOM position so the final permanent work_note
                // merges into it in-place — preventing the flash/re-animate bug.
                for (let i = logs.length - 1; i >= 0; i--) {
                  if (logs[i].type === 'user_action') break;
                  if (
                    logs[i].type === 'work_note' &&
                    (logs[i].subAgent || null) === subAgent &&
                    (!noteId || logs[i].noteId === noteId)
                  ) {
                    logs[i] = { ...logs[i], _streamingCancelled: true };
                    break;
                  }
                }
                continue;
              }

              if (trace.type === 'thought_stream') {
                const subAgent = trace.subAgent || null;
                const thoughtId = trace.thoughtId || null;
                let mergeIdx = -1;
                for (let i = logs.length - 1; i >= 0; i--) {
                  if (logs[i].type === 'user_action') break;
                  if (logs[i].type === 'thought_stream' && (logs[i].subAgent || null) === subAgent) {
                    if (thoughtId && logs[i].thoughtId && logs[i].thoughtId !== thoughtId) break;
                    mergeIdx = i;
                    break;
                  }
                }
                if (mergeIdx >= 0) {
                  // Preserve the original startTime from when the thought began
                  logs[mergeIdx] = { ...logs[mergeIdx], text: trace.text, thoughtId, _traceIdx: trace._traceIdx, timestamp: traceAt, startTime: logs[mergeIdx].startTime, endTime: trace.endTime ?? traceAt };
                } else {
                  logs.push({ type: 'thought_stream', text: trace.text, subAgent, thoughtId, _traceIdx: trace._traceIdx, timestamp: traceAt, startTime: trace.startTime ?? traceAt, endTime: trace.endTime ?? traceAt });
                }
              } else if (trace.type === 'work_note') {
                const subAgent = trace.subAgent || null;
                const noteId = trace.noteId || null;
                const incomingIsFinal = trace.isStreaming === false || trace.isDelta === false;
                const noteText = formatVisibleWorkNote(String(trace.text || ''));
                if (!noteText) continue;
                let mergeIdx = -1;
                let duplicateIdx = -1;
                for (let i = logs.length - 1; i >= 0; i--) {
                  if (logs[i].type === 'user_action') break;
                  if (logs[i].type === 'work_note' && (logs[i].subAgent || null) === subAgent) {
                    const existingText = String(logs[i].text || '').trim();
                    if (noteId && logs[i].noteId && logs[i].noteId === noteId) {
                      mergeIdx = i;
                      break;
                    }
                    // Merge final note into a streaming-cancelled placeholder (same subAgent, no noteId match needed)
                    if (logs[i]._streamingCancelled && incomingIsFinal) {
                      mergeIdx = i;
                      break;
                    }
                    if (existingText === noteText) {
                      if (incomingIsFinal && (logs[i].isStreaming || logs[i].isDelta)) {
                        mergeIdx = i;
                      } else {
                        duplicateIdx = i;
                      }
                      break;
                    }
                    if (!noteId || !logs[i].noteId) {
                      mergeIdx = i;
                      break;
                    }
                  }
                }
                if (duplicateIdx >= 0) continue;
                if (mergeIdx >= 0) {
                  logs[mergeIdx] = {
                    ...logs[mergeIdx],
                    ...trace,
                    type: 'work_note',
                    text: noteText,
                    subAgent,
                    noteId,
                    _traceIdx: trace._traceIdx ?? logs[mergeIdx]._traceIdx,
                    timestamp: traceAt,
                    startTime: logs[mergeIdx].startTime || timedTrace.startTime,
                    endTime: traceAt,
                    _streamingCancelled: undefined,
                  };
                } else {
                  logs.push({ ...timedTrace, type: 'work_note', text: noteText, subAgent, noteId, _traceIdx: trace._traceIdx, startTime: timedTrace.startTime, endTime: traceAt });
                }
              } else if (trace.type === 'ask_user') {
                const question = String(trace.question || '').trim();
                if (!question) {
                  continue;
                }

                const responseKey = String(trace.responseKey || (trace.timestamp ? `ask_user_${ trace.timestamp }` : '')).trim();
                let askIdx = -1;
                for (let i = logs.length - 1; i >= 0; i--) {
                  if (logs[i].type === 'user_action') break;
                  if (logs[i].type !== 'ask_user') continue;
                  const sameResponseKey = responseKey && logs[i].responseKey === responseKey;
                  const sameQuestion = String(logs[i].question || '').trim() === question;
                  if (sameResponseKey || sameQuestion) {
                    askIdx = i;
                    break;
                  }
                }

                const nextAskLog = {
                  ...timedTrace,
                  ...trace,
                  type: 'ask_user',
                  question,
                  responseKey: responseKey || timedTrace.responseKey,
                  timestamp: Number(trace.timestamp || timedTrace.timestamp || traceAt),
                  startTime: timedTrace.startTime,
                  endTime: traceAt,
                };

                if (askIdx >= 0) {
                  logs[askIdx] = {
                    ...logs[askIdx],
                    ...nextAskLog,
                    answeredWith: logs[askIdx].answeredWith,
                    answeredAt: logs[askIdx].answeredAt,
                  };
                } else {
                  logs.push(nextAskLog);
                }
              } else if (trace.type === 'task_plan') {
                mergeTaskPlanLog(logs, timedTrace);
              } else if (trace.type === 'answer' && !trace.subAgent) {
                let answerIdx = -1;
                for (let i = logs.length - 1; i >= 0; i--) {
                  if (logs[i].type === 'user_action') break;
                  if (logs[i].type === 'answer') { answerIdx = i; break; }
                }
                if (answerIdx >= 0) {
                  logs[answerIdx] = { ...logs[answerIdx], ...timedTrace, text: trace.text, _traceIdx: trace._traceIdx };
                } else {
                  logs.push(timedTrace);
                }
              } else if (trace.type === 'file_preview') {
                const stablePreviewIdx = logs.findLastIndex((l: any) =>
                  l.type === 'file_preview' && (
                    (trace._traceIdx !== undefined && trace._traceIdx !== null && l._traceIdx === trace._traceIdx) ||
                    (trace.traceId && l.traceId === trace.traceId) ||
                    (trace.id && l.id === trace.id)
                  )
                );
                if (stablePreviewIdx >= 0) {
                  logs[stablePreviewIdx] = { ...timedTrace, startTime: logs[stablePreviewIdx].startTime || timedTrace.startTime, endTime: traceAt };
                } else {
                  const tracePreviewPath = String(trace.filepath || trace.filename || '');
                  const existingIdx = trace.ownerTraceId
                    ? logs.findLastIndex((l: any) =>
                      l.type === 'file_preview' &&
                      l.ownerTraceId === trace.ownerTraceId &&
                      (!tracePreviewPath || String(l.filepath || l.filename || '') === tracePreviewPath)
                    )
                    : trace.dedupe !== false
                      ? logs.findLastIndex((l: any) => l.type === 'file_preview' && l.filepath === trace.filepath && l.dedupe !== false)
                      : -1;
                  if (existingIdx >= 0) {
                    logs[existingIdx] = { ...timedTrace, startTime: logs[existingIdx].startTime || timedTrace.startTime, endTime: traceAt };
                  } else {
                    logs.push(timedTrace);
                  }
                }
              } else if (trace.type === 'console_output') {
                // Always push new console output — each shell execution is a unique event
                // Dedup only exact same command+output combo
                const mergeIdx = findMergeableConsoleOutputIndex(logs, trace);
                if (mergeIdx >= 0) {
                  logs[mergeIdx] = {
                    ...logs[mergeIdx],
                    ...timedTrace,
                    _traceIdx: trace._traceIdx ?? logs[mergeIdx]._traceIdx,
                    startTime: logs[mergeIdx].startTime || timedTrace.startTime,
                    endTime: traceAt,
                    timestamp: traceAt,
                  };
                } else if (!isDuplicateConsoleOutput(logs, trace)) {
                  logs.push(timedTrace);
                }
              } else if (trace.type === 'done' || trace.type === 'error') {
                // Skip — handled by status check below
              } else {
                // ALL other types (command, exploration, file_edit, etc.) — deduplicated by _traceIdx above
                // Replace _instant preview with real trace
                if (!trace._instant && (trace.type === 'command' || trace.type === 'file_edit' || trace.type === 'exploration')) {
                  const instantIdx = logs.findIndex(l => l._instant && l.type === trace.type);
                  if (instantIdx >= 0) logs.splice(instantIdx, 1);
                }
                if (trace._instant && logs.some(l => !l._instant && (l.type === 'command' || l.type === 'file_edit' || l.type === 'exploration'))) {
                  continue;
                }
                logs.push(timedTrace);
              }
            }
            return logs;
          };

          if (isActiveChat) {
            // Active chat — update visible traceLogs
            setTraceLogs(prevLogs => {
              const newLogs = processTraces(prevLogs);

              // Update chats state (NO updatedAt change, NO localStorage write here)
              setChats(currentChats => {
                return currentChats.map(c =>
                  c.id === chatId ? { ...c, traceLogs: newLogs } : c
                );
              });

              return newLogs;
            });
          } else {
            // BACKGROUND chat — only update chats state, DON'T touch traceLogs
            setChats(currentChats => {
              const chat = currentChats.find(c => c.id === chatId);
              if (!chat) return currentChats;

              const chatLogs = processTraces(chat.traceLogs || []);

              return currentChats.map(c =>
                c.id === chatId ? { ...c, traceLogs: chatLogs } : c
              );
            });
          }

          // Debounced localStorage write — strip large content fields to avoid quota overflow
          debouncedSaveToLocalStorage();
        }

        // CRITICAL: Only stop on TERMINAL states, NOT 'idle'
        // 'idle' means agent hasn't started yet (race condition)
        if (data.status === 'failed') {
          // Show error trace so UI doesn't silently drop — this was causing the
          // 'UI gets off while running' appearance (agent failed, no feedback)
          const errMsg = data.finalAnswer || data.error || 'All API attempts exhausted or agent encountered a fatal error.';
          const isActiveChat = activeChatIdRef.current === chatId;
          if (isActiveChat) {
            setTraceLogs(prev => [
              ...stripAgentConnectionLogs(prev),
              systemThoughtLog(`\n\n*Agent stopped: ${ errMsg.slice(0, 200) }*`, normalizeClientTraceTime(data.completedAt))
            ]);
          } else {
            setChats(currentChats => currentChats.map(c => c.id === chatId
              ? { ...c, traceLogs: [...stripAgentConnectionLogs(c.traceLogs || []), systemThoughtLog(`\n\n*Agent stopped: ${ errMsg.slice(0, 200) }*`, normalizeClientTraceTime(data.completedAt))] }
              : c
            ));
          }
        }
        if (data.status === 'completed' || data.status === 'failed' || data.status === 'stopped') {
          // Check if it's already stopped by a overlapping async fetch
          const shouldNotify = pollingIntervalsRef.current.has(chatId);

          clearAgentConnectionStatus(chatId);
          stopPolling(chatId);
          removeRunningChat(chatId);
          markChatUnreadIfBackground(chatId);

          // TRIGGER DESKTOP NOTIFICATION (Outside setState to prevent React.StrictMode double-firing!)
          if (shouldNotify && data.status === 'completed' && 'Notification' in window) {
            // Ensure exactly ONE notification per agent run - solves the 2-3x duplicate bug
            if (!notifiedChatIdsRef.current.has(chatId)) {
              notifiedChatIdsRef.current.add(chatId);

              try {
                const svd = localStorage.getItem('eterx_settings');
                const settings = svd ? JSON.parse(svd) : {};
                if (settings.desktopNotifications !== false) {
                  const svdChats = localStorage.getItem('eterx_chats');
                  const parsedChats = svdChats ? JSON.parse(svdChats) : [];
                  const cht = parsedChats.find((c: any) => c.id === chatId);
                  let titleName = cht && !isDefaultChatTitle(cht.title) ? cht.title : '';

                  if (!titleName) {
                    const firstUserMsg = cht?.traceLogs?.find((l: any) => l.type === 'user_action')?.text;
                    if (firstUserMsg) {
                      titleName = firstUserMsg.length > 35 ? firstUserMsg.substring(0, 35) + '...' : firstUserMsg;
                    } else {
                      titleName = 'EterX Agent';
                    }
                  }

                  let cleanBody = data.finalAnswer
                    ? data.finalAnswer.replace(/<[^>]*>?/gm, '').replace(/[*#_`]/g, '')
                    : "The agent has finished completing your task.";

                  if (cleanBody.length > 130) cleanBody = cleanBody.substring(0, 130) + '...';

                  // Use Native Electron IPC for perfect OS Notification UI
                  const win = window as any;
                  if (win.electronAPI && win.electronAPI.showNotification) {
                    win.electronAPI.showNotification(titleName, cleanBody);
                  } else {
                    new Notification(titleName, { body: cleanBody });
                  }
                }
              } catch { }
            }
          }

          // Final save to localStorage (immediate, not debounced).
          // Strip large content fields before saving to prevent quota errors.
          setChats(currentChats => {
            const stripped = stripChatsForStorage(currentChats);
            try { localStorage.setItem('eterx_chats', JSON.stringify(stripped)); } catch { }
            return currentChats; // Don't update React state with stripped version
          });

          return; // Don't schedule next poll — we're done
        }
      } catch {
        // Network error — don't stop polling, agent might still be running
        // Apply exponential backoff
        errorBackoff = Math.min(errorBackoff + 1, 5);
        lastHadData = false;
      }

      // Schedule next poll (only if still active)
      if (pollingIntervalsRef.current.has(chatId) && pollGenerationRef.current.get(chatId) === pollGeneration) {
        // Remove old entry before scheduling (setTimeout returns a new ID)
        pollingIntervalsRef.current.delete(chatId);
        scheduleNextPoll();
      }
    };

    // Kick off the first poll AND register for visibility catch-up
    catchUpPollersRef.current.set(chatId, () => {
      if (pollGenerationRef.current.get(chatId) !== pollGeneration) return;
      const existingTimer = pollingIntervalsRef.current.get(chatId);
      if (existingTimer) {
        clearTimeout(existingTimer);
        pollingIntervalsRef.current.delete(chatId);
      }
      const immediateId = setTimeout(pollOnce, 0);
      pollingIntervalsRef.current.set(chatId, immediateId as any);
    });
    const immediateId = setTimeout(pollOnce, 0);
    pollingIntervalsRef.current.set(chatId, immediateId as any);
  };

  /**
   * Stop polling for a specific chat.
   */
  const stopPolling = (chatId: string, clearRunIdentity: boolean = true) => {
    const timeoutId = pollingIntervalsRef.current.get(chatId);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    pollingIntervalsRef.current.delete(chatId);
    pollCursorsRef.current.delete(chatId);
    if (clearRunIdentity) {
      pollRunStartRef.current.delete(chatId);
      pollRunIdRef.current.delete(chatId);
    }
    catchUpPollersRef.current.delete(chatId);
    pollGenerationRef.current.set(chatId, (pollGenerationRef.current.get(chatId) || 0) + 1);
  };

  useEffect(() => {
    let disposed = false;
    let probeTimer: number | null = null;

    const clearRestoreTimer = () => {
      if (networkRestoreTimerRef.current !== null) {
        window.clearTimeout(networkRestoreTimerRef.current);
        networkRestoreTimerRef.current = null;
      }
    };

    const markOffline = () => {
      clearRestoreTimer();
      if (!networkPausedRef.current) {
        networkPausedRef.current = true;
        networkOutageIdRef.current += 1;
        networkDismissedOutageRef.current = null;
      }
      setNetworkPhase('offline');
      if (networkDismissedOutageRef.current !== networkOutageIdRef.current) {
        networkBannerVisibleRef.current = true;
        setNetworkBannerVisible(true);
      }

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (liveSessionRef.current) {
        liveSessionRef.current.disconnect();
        liveSessionRef.current = null;
        setLiveState('idle');
        setLiveOutputText('');
        setLiveInputText('');
      }
    };

    const markOnline = () => {
      if (!networkPausedRef.current) return;
      networkPausedRef.current = false;
      clearRestoreTimer();
      setNetworkPhase('restored');
      networkBannerVisibleRef.current = true;
      setNetworkBannerVisible(true);

      for (const chatId of runningChatsRef.current) {
        if (pollingIntervalsRef.current.has(chatId)) {
          catchUpPollersRef.current.get(chatId)?.();
        } else {
          startPolling(chatId, pollCursorsRef.current.get(chatId) ?? -1, pollRunStartRef.current.get(chatId));
        }
      }

      networkRestoreTimerRef.current = window.setTimeout(() => {
        if (networkPausedRef.current) return;
        setNetworkPhase('online');
        networkBannerVisibleRef.current = false;
        setNetworkBannerVisible(false);
      }, 2200);
    };

    const probeNetwork = async () => {
      if (disposed) return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        markOffline();
        return;
      }

      // Independent heartbeat; do not rely on an active agent request to detect outages.
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 3200);

      try {
        await fetch(`${ NETWORK_PROBE_URL }?t=${ Date.now() }`, {
          method: 'GET',
          mode: 'no-cors',
          cache: 'no-store',
          signal: controller.signal,
        });
        markOnline();
      } catch {
        markOffline();
      } finally {
        window.clearTimeout(timeoutId);
      }
    };

    const scheduleProbe = () => {
      if (disposed) return;
      probeTimer = window.setTimeout(async () => {
        await probeNetwork();
        scheduleProbe();
      }, networkPausedRef.current ? 1800 : 5000);
    };

    const handleOffline = () => markOffline();
    const handleOnline = () => { void probeNetwork(); };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    void probeNetwork();
    scheduleProbe();

    return () => {
      disposed = true;
      if (probeTimer !== null) window.clearTimeout(probeTimer);
      clearRestoreTimer();
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const getWatchedChatIds = () => {
      const ids = new Set<string>();
      if (activeChatId) ids.add(activeChatId);
      runningChats.forEach(id => ids.add(id));
      return ids;
    };

    if (getWatchedChatIds().size === 0) return;

    let cancelled = false;
    const reconcileDetachedPollers = async () => {
      if (networkPausedRef.current) return;
      const ids = getWatchedChatIds();
      for (const chatId of ids) {
        if (cancelled) return;
        if (pollingIntervalsRef.current.has(chatId)) continue;

        try {
          const data = await fetchAgentPoll(chatId, -1, 5000);
          if (cancelled) return;

          if (data.traces && data.traces.length > 0) {
            if (activeChatIdRef.current === chatId) {
              setTraceLogs(prevLogs => {
                const mergedLogs = mergeServerRunLogs(prevLogs, data.traces);
                setChats(prev => prev.map(c => c.id === chatId ? { ...c, traceLogs: mergedLogs } : c));
                return mergedLogs;
              });
            } else {
              setChats(prev => prev.map(c => {
                if (c.id !== chatId) return c;
                return { ...c, traceLogs: mergeServerRunLogs(c.traceLogs || [], data.traces) };
              }));
            }
            debouncedSaveToLocalStorage();
          }

          if (data.status === 'running') {
            setRunningChats(prev => {
              if (prev.has(chatId)) return prev;
              const next = new Set(prev);
              next.add(chatId);
              return next;
            });

            startPolling(chatId, data.maxIndex ?? (data.totalTraces - 1));
          } else if (isTerminalAgentStatus(data.status) || (data.status === 'idle' && runningChatsRef.current.has(chatId))) {
            removeRunningChat(chatId);
            if (isTerminalAgentStatus(data.status)) markChatUnreadIfBackground(chatId);
          }
        } catch {
          // Keep the UI quiet here; the normal poller/backoff path will recover.
        }
      }
    };

    reconcileDetachedPollers();
    const interval = window.setInterval(reconcileDetachedPollers, 3500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeChatId, runningChats]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStop = () => {
    if (!activeChatId) return;

    // === HARD KILL: Complete disconnect for this chat ===

    // 1. Abort the SSE stream if it exists
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    // 2. Stop polling immediately
    stopPolling(activeChatId);

    // 3. Signal backend to stop THIS chat's agent + ALL its sub-agents
    fetch('/api/agent/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: activeChatId })
    }).catch(() => { });

    // 4. Clear all running state for this chat
    removeRunningChat(activeChatId);

    // 5. Clear notification tracking (so future runs can notify again)
    notifiedChatIdsRef.current.delete(activeChatId);

    // 6. Append stopped message to chat
    updateActiveChatLogs(prev => [
      ...stripAgentConnectionLogs(prev),
      systemThoughtLog("\n\n*Generation stopped by user.*")
    ]);
  };

  // Remove pending steering messages when they appear in traceLogs
  useEffect(() => {
    if (pendingSteering.length === 0) return;

    const lastUserIdx = traceLogs.reduceRight((found, l, i) => found === -1 && l.type === 'user_action' ? i : found, -1);
    const currentTurnLogs = lastUserIdx >= 0 ? traceLogs.slice(lastUserIdx) : traceLogs;

    const receivedTexts = new Set(
      currentTurnLogs
        .filter(l => l.type === 'steering_received')
        .map(l => l.text)
    );

    if (receivedTexts.size > 0) {
      setPendingSteering(prev => prev.filter(p => !receivedTexts.has(p.text)));
    }
  }, [traceLogs, pendingSteering.length]);

  /**
   * handleSteer - sends a live steering comment to the running agent.
   * The message is queued server-side and injected into the model context
   * at the next free ReAct iteration (non-disruptive, agent is never paused).
   */
  const sendSteeringMessage = useCallback(async (message: string) => {
    const steerMessage = message.trim();
    if (!activeChatId || !steerMessage) return;
    if (networkPausedRef.current) {
      revealNetworkBanner();
      return;
    }

    const newSteering = { id: Date.now().toString(), text: steerMessage };
    setPendingSteering(prev => [...prev, newSteering]);

    try {
      const res = await fetch('/api/agent/steer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: activeChatId, message: steerMessage }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.warn('[handleSteer] Steer failed:', err.reason || res.status);
      } else {
        console.log('[handleSteer] Steering message sent:', steerMessage.substring(0, 60));
      }
    } catch (e: any) {
      console.warn('[handleSteer] Network error:', e?.message);
    }
  }, [activeChatId, revealNetworkBanner]);

  const handleSteer = async () => {
    if (!inputValue.trim()) return;
    const steerMessage = inputValue.trim();
    setInputValue('');
    await sendSteeringMessage(steerMessage);
  };

  const toggleSpeech = () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return alert("Microphone access is not supported in this environment.");
    }

    if (isRecording) {
      isManualStopRef.current = true;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      return;
    }

    transcriptBufferRef.current = inputValue;
    if (transcriptBufferRef.current && !transcriptBufferRef.current.endsWith(' ')) {
      transcriptBufferRef.current += ' ';
    }

    lastSpeechTimeRef.current = Date.now();
    isManualStopRef.current = false;
    hasSpokenRef.current = false;
    isCancelledRef.current = false;
    audioChunksRef.current = [];

    const startRecording = async () => {
      try {
        // Request microphone with minimal processing — noiseSuppression can eat speech on some systems
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: true,
          }
        });

        // Diagnostics: log what microphone we got
        const tracks = stream.getAudioTracks();
        console.log('[Voice] Got', tracks.length, 'audio track(s)');
        tracks.forEach((t, i) => {
          console.log(`[Voice] Track ${ i }: label="${ t.label }" enabled=${ t.enabled } muted=${ t.muted } readyState=${ t.readyState }`);
          const settings = t.getSettings();
          console.log(`[Voice] Track ${ i } settings:`, JSON.stringify(settings));
        });

        // Detect best supported mimeType
        const mimeTypes = [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/ogg;codecs=opus',
          'audio/mp4',
          'audio/wav',
          ''
        ];
        let selectedMime = '';
        for (const mime of mimeTypes) {
          if (!mime || MediaRecorder.isTypeSupported(mime)) {
            selectedMime = mime;
            break;
          }
        }
        console.log('[Voice] Using mimeType:', selectedMime || '(browser default)');

        const recorderOptions: MediaRecorderOptions = {};
        if (selectedMime) recorderOptions.mimeType = selectedMime;

        const mediaRecorder = new MediaRecorder(stream, recorderOptions);
        mediaRecorderRef.current = mediaRecorder;

        // Setup AudioContext for volume visualization
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }
        console.log('[Voice] AudioContext state:', audioContext.state, 'sampleRate:', audioContext.sampleRate);

        audioContextRef.current = audioContext;
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.5;
        analyser.minDecibels = -90;
        analyser.maxDecibels = -10;
        source.connect(analyser);

        const freqData = new Uint8Array(analyser.frequencyBinCount);
        let volumeLogCounter = 0;

        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            audioChunksRef.current.push(e.data);
            console.log('[Voice] Chunk received:', e.data.size, 'bytes');
          }
        };

        const cleanupAndTranscribe = async () => {
          setIsRecording(false);
          setAudioVolume(0);
          if (silenceIntervalRef.current) clearInterval(silenceIntervalRef.current);
          if (audioContextRef.current) {
            audioContextRef.current.close().catch(() => { });
            audioContextRef.current = null;
          }
          stream.getTracks().forEach(track => track.stop());

          if (isCancelledRef.current) {
            setInputValue(transcriptBufferRef.current);
            return;
          }

          if (audioChunksRef.current.length === 0) {
            console.warn('[Voice] No audio chunks collected');
            return;
          }

          const blobType = mediaRecorder.mimeType || 'audio/webm';
          const audioBlob = new Blob(audioChunksRef.current, { type: blobType });
          console.log('[Voice] Final blob:', audioBlob.size, 'bytes, type:', blobType, 'chunks:', audioChunksRef.current.length);

          if (audioBlob.size < 1000) {
            console.warn('[Voice] Audio too short');
            return;
          }

          setIsProcessingVoice(true);

          let ext = 'webm';
          if (blobType.includes('ogg')) ext = 'ogg';
          else if (blobType.includes('mp4')) ext = 'mp4';
          else if (blobType.includes('wav')) ext = 'wav';

          const formData = new FormData();
          formData.append('file', audioBlob, `audio.${ ext }`);

          try {
            const res = await fetch('/api/whisper', {
              method: 'POST',
              body: formData
            });

            const data = await res.json();
            console.log('[Voice] Whisper response:', JSON.stringify(data));

            if (data.filtered) {
              // Server detected hallucination or empty audio
              console.warn('[Voice] Speech not detected, reason:', data.reason);
              setInputValue(transcriptBufferRef.current);
              alert("Could not detect speech. Please check your microphone is selected correctly in Windows Sound Settings → Input.");
            } else if (data.text && data.text.trim()) {
              setInputValue(transcriptBufferRef.current + data.text);
            } else {
              setInputValue(transcriptBufferRef.current);
            }
          } catch (e) {
            console.error('[Voice] Transcription error:', e);
            setInputValue(transcriptBufferRef.current);
            alert("Whisper Transcription Error: Could not connect to Groq.");
          } finally {
            setIsProcessingVoice(false);
          }
        };

        mediaRecorder.onstop = () => {
          cleanupAndTranscribe();
        };

        // Volume monitoring — use frequency data for reliable speech detection
        silenceIntervalRef.current = setInterval(() => {
          if (isManualStopRef.current) {
            if (mediaRecorder.state === 'recording') mediaRecorder.stop();
            return;
          }

          analyser.getByteFrequencyData(freqData);
          // Use RMS of frequency bins for more accurate volume
          let sumSquares = 0;
          for (let i = 0; i < freqData.length; i++) {
            sumSquares += freqData[i] * freqData[i];
          }
          const rms = Math.sqrt(sumSquares / freqData.length);
          // Normalize to 0-100 range
          const normalizedVolume = Math.min(100, (rms / 128) * 100);
          setAudioVolume(normalizedVolume);

          // Log volume periodically for debugging
          volumeLogCounter++;
          if (volumeLogCounter % 25 === 0) { // every ~2 seconds
            console.log('[Voice] Volume RMS:', rms.toFixed(1), 'normalized:', normalizedVolume.toFixed(1));
          }

          if (normalizedVolume > 5) {
            hasSpokenRef.current = true;
            lastSpeechTimeRef.current = Date.now();
          }

          const timeSinceLast = Date.now() - lastSpeechTimeRef.current;
          const limit = hasSpokenRef.current ? 4000 : 20000; // 20s timeout if never spoke

          if (timeSinceLast >= limit) {
            if (mediaRecorder.state === 'recording') mediaRecorder.stop();
          }
        }, 80);

        mediaRecorder.start();
        setIsRecording(true);
        console.log('[Voice] Recording started. mimeType:', mediaRecorder.mimeType, 'state:', mediaRecorder.state);
      } catch (err: any) {
        console.error("[Voice] Microphone Error:", err);
        alert("Microphone Error: " + (err.message || "Please grant microphone permissions."));
      }
    };

    startRecording();
  };

  const handleOpenAgentTeam = useCallback((agentName?: string) => {
    if (agentName) {
      // Switch to that agent's tab in the header
      setActiveSubAgentTab(agentName === 'Main' ? null : agentName);
    }
    setAgentTeamOpen(true);
  }, []);

  const handleSendSubAgentMessage = useCallback(async () => {
    const agentName = activeSubAgentTab;
    const chatId = activeChatId;
    if (!agentName || !chatId) return;

    if (isRecording && mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
    if (!inputValue.trim() && attachments.length === 0) return;
    if (networkPausedRef.current) {
      revealNetworkBanner();
      return;
    }

    const sentAt = Date.now();
    const scheduledMessage = parseScheduledAgentMessage(inputValue.trim());
    const currentAttachments = [...attachments];
    const filePaths = currentAttachments
      .map(att => (att as any).localPath || (att.file as any).path || att.name || att.file?.name)
      .filter(Boolean);
    const attachmentContext = currentAttachments.length > 0
      ? `\n\n[Attachments]\n${ currentAttachments.map(att => {
        const name = att.name || att.file?.name || 'attachment';
        const path = (att as any).localPath || (att.file as any).path;
        return `- ${ name }${ path ? ` (${ path })` : '' }`;
      }).join('\n') }`
      : '';
    const body = `${ scheduledMessage.text }${ attachmentContext }`.trim();

    setInputValue('');
    setAttachments([]);

    try {
      const res = await fetch('/api/agents/comm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: scheduledMessage.deliverAfterMs ? 'schedule' : 'send',
          projectId: chatId,
          from: 'Main',
          to: agentName,
          type: 'question',
          subject: scheduledMessage.deliverAfterMs ? `Scheduled message (${ scheduledMessage.label })` : 'Main message',
          body,
          priority: 'normal',
          deliveryMode: 'defer',
          requiresResponse: false,
          deliverAfterMs: scheduledMessage.deliverAfterMs,
          filePaths,
          tags: ['ui', 'sub-agent-chat'],
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `HTTP ${ res.status }`);
      }

      const message = data.message ? {
        ...data.message,
        scheduled: data.scheduled,
        deliverAfter: data.deliverAfter || data.message.deliverAfter,
      } : {
        id: data.messageId,
        from: 'Main',
        to: agentName,
        type: 'question',
        subject: scheduledMessage.deliverAfterMs ? `Scheduled message (${ scheduledMessage.label })` : 'Main message',
        body,
        priority: 'normal',
        deliveryMode: 'defer',
        scheduled: !!scheduledMessage.deliverAfterMs,
        deliverAfter: scheduledMessage.deliverAfterMs ? sentAt + scheduledMessage.deliverAfterMs : undefined,
        filePaths,
        timestamp: sentAt,
      };
      const log = interAgentMessageLog(message, agentName);
      setChatLogsById(chatId, previousLogs => {
        const existingIds = new Set(previousLogs.map((item: any) => item.messageId || item.id).filter(Boolean));
        if (existingIds.has(log.messageId) || existingIds.has(log.id)) return previousLogs;
        return [...previousLogs, log];
      }, { touchUpdatedAt: true });
    } catch (error: any) {
      const failureLog = systemThoughtLog(`Failed to send message to ${ agentName }: ${ error?.message || 'Unknown error' }`, Date.now());
      setChatLogsById(chatId, previousLogs => [...previousLogs, failureLog], { touchUpdatedAt: true });
    }
  }, [activeChatId, activeSubAgentTab, attachments, inputValue, isRecording, revealNetworkBanner]);

  const handleSend = async () => {
    if (isRecording && mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
    if (!inputValue.trim() && attachments.length === 0) return;
    if (isThinking) return;
    if (networkPausedRef.current) {
      revealNetworkBanner();
      return;
    }

    // Request notification permissions implicitly during this user gesture
    try {
      const saved = localStorage.getItem('eterx_settings');
      const settings = saved ? JSON.parse(saved) : {};
      if (settings.desktopNotifications !== false && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    } catch { }

    const promptText = inputValue;
    const runAgentMode = readRuntimeAgentMode(agentMode);
    const runThinkingLevel = thinkingLevel;
    const currentAttachments = [...attachments];
    const userLogAttachments = currentAttachments.map(serializeComposerAttachment);
    const runStartedAt = Date.now();
    const clientRunId = crypto.randomUUID();
    const userLog = { type: 'user_action', text: promptText, attachments: userLogAttachments, startTime: runStartedAt, endTime: runStartedAt };
    const historySourceLogs = activeChatId ? stripAgentConnectionLogs(traceLogs) : [];
    setInputValue("");
    setAttachments([]);

    let chatIdToUse = activeChatId;

    // Reset notification state for this chat run
    if (chatIdToUse) notifiedChatIdsRef.current.delete(chatIdToUse);

    // Use pre-uploaded media data from background uploads (already done when attached)
    const mediaAttachments: any[] = currentAttachments.map(att => ({
      id: att.id,
      name: att.name || att.file.name,
      path: (att as any).localPath || (att.file as any).path || undefined,
      mimeType: att.file.type || 'application/octet-stream',
      // Gemini file URIs are API-key scoped. The agent must upload with its
      // leased key instead of using any pre-send URI from the UI.
      fileUri: undefined,
    }));

    if (!chatIdToUse) {
      chatIdToUse = crypto.randomUUID();
      activeChatIdRef.current = chatIdToUse;
      setActiveChatId(chatIdToUse);

      const initialTitle = fallbackTitleFromPrompt(promptText);
      const newChat: ChatSession = {
        id: chatIdToUse,
        title: initialTitle,
        updatedAt: Date.now(),
        traceLogs: [userLog],
        workspacePath: activeWorkspacePath,
        runLocation: activeRunLocation,
      };

      setChats(prev => {
        const updated = [newChat, ...prev];
        localStorage.setItem('eterx_chats', JSON.stringify(stripChatsForStorage(updated)));
        return updated;
      });
      setTraceLogs([userLog]);

      const titleChatId = chatIdToUse;
      const initialTitleHistory = [{ role: 'user', parts: [{ text: promptText }] }];
      void fetchGeneratedTitle(initialTitleHistory, DEFAULT_CHAT_TITLE, runAgentMode)
        .then(generatedTitle => {
          if (!generatedTitle || generatedTitle === initialTitle) return;
          setChats(prev => {
            const updated = prev.map(chat => chat.id === titleChatId ? { ...chat, title: generatedTitle } : chat);
            localStorage.setItem('eterx_chats', JSON.stringify(stripChatsForStorage(updated)));
            return updated;
          });
        })
        .catch(error => {
          console.warn('[Naming] Initial naming failed:', error);
        });
    } else {
      const updatedLogs = [...stripAgentConnectionLogs(traceLogs), userLog];
      setChatLogsById(chatIdToUse, updatedLogs, { touchUpdatedAt: true });

      // Adaptive renaming logic (every 5 messages)
      const userMessageCount = updatedLogs.filter(l => l.type === 'user_action').length;
      if (userMessageCount > 1 && userMessageCount % 5 === 0) {
        const chatHistory = updatedLogs
          .filter(log => log.type === 'user_action' || log.type === 'thought' || log.type === 'answer')
          .map(log => ({
            role: log.type === 'user_action' ? 'user' : 'model',
            parts: [{ text: log.text }]
          }));
        generateTitle(chatIdToUse, chatHistory, undefined, runAgentMode);
      }
    }

    clearUnreadChat(chatIdToUse);

    if (window.innerWidth < 768) setSidebarOpen(false);

    // Mark this chat as running
    setRunningChats(prev => new Set(prev).add(chatIdToUse!));

    // Build chat history for context
    const chatHistory = historySourceLogs
      .filter(log => log.type === 'user_action' || log.type === 'answer')
      .map(log => ({
        role: log.type === 'user_action' ? 'user' : 'model',
        parts: [{ text: log.text }]
      }));

    const isBuilderChat = !!chatIdToUse && chatIdToUse.startsWith('agent_builder_');
    const builderAgentId = isBuilderChat ? chatIdToUse!.replace('agent_builder_', '') : null;
    const selectedCustomRuntimeId = selectedAgent && selectedAgent !== 'coding' && !isBuilderChat
      ? selectedAgent
      : null;
    // The legacy runner remains in this file only for a staged migration, but
    // all live custom-agent and flow runs use the shared AgentRegistry below.
    const isCustomAgentRun = false;

    if (isCustomAgentRun) {
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const answerLogId = `custom_agent_answer_${ runStartedAt }`;
      let pendingCustomText = '';
      let customTraceSeq = 0;
      let customWorkNoteSeq = 0;
      const activeCustomToolLogs = new Map<string, CustomToolActiveTrace>();

      const setCustomAgentAnswer = (text: string, isLive: boolean) => {
        const at = Date.now();
        const answerLog = {
          id: answerLogId,
          type: 'answer',
          text,
          agentName: selectedAgentName,
          customAgentId: selectedAgent,
          isLive,
          startTime: runStartedAt,
          endTime: at,
          timestamp: at,
        };
        setChatLogsById(chatIdToUse!, logs => {
          const cleanLogs = stripAgentConnectionLogs(logs);
          const existingIdx = cleanLogs.findIndex(log => log.id === answerLogId);
          if (existingIdx >= 0) {
            const next = [...cleanLogs];
            next[existingIdx] = { ...next[existingIdx], ...answerLog };
            return next;
          }
          return [...cleanLogs, answerLog];
        }, { touchUpdatedAt: true });
      };

      const appendCustomAgentTrace = (log: any) => {
        setChatLogsById(chatIdToUse!, logs => [
          ...stripAgentConnectionLogs(logs),
          { ...log, _traceIdx: customTraceSeq++ },
        ], { touchUpdatedAt: true });
      };

      const updateCustomAgentTrace = (logId: string, patch: any) => {
        setChatLogsById(chatIdToUse!, logs => {
          const cleanLogs = stripAgentConnectionLogs(logs);
          return cleanLogs.map(log => log.id === logId ? { ...log, ...patch } : log);
        }, { touchUpdatedAt: true });
      };

      const appendCustomAgentStatus = (text: string, agentName = selectedAgentName) => {
        const cleanText = normalizeCustomAgentStatus(text);
        if (!shouldShowCustomAgentStatus(cleanText)) return;
        const at = Date.now();
        appendCustomAgentTrace({
          id: `custom_status_${ at }_${ Math.random().toString(36).slice(2, 8) }`,
          type: 'thought_stream',
          text: cleanText,
          subAgent: agentName,
          startTime: at,
          endTime: at,
          timestamp: at,
        });
      };

      const flushCustomWorkNote = () => {
        const noteLog = createCustomWorkNoteLog(
          pendingCustomText,
          selectedAgentName,
          `custom_work_${ runStartedAt }_${ customWorkNoteSeq++ }`,
          Date.now(),
        );
        pendingCustomText = '';
        if (noteLog) appendCustomAgentTrace(noteLog);
      };

      const customToolTraceKey = (event: any) => `${ String(event?.agentName || selectedAgentName) }:${ String(event?.toolName || '') }`;

      const attachmentContext = mediaAttachments.length > 0
        ? `\n\n[Attached files]\n${ mediaAttachments.map(att => `- ${ att.name }${ att.path ? ` (${ att.path })` : '' }`).join('\n') }`
        : '';

      const runnerMessages = [
        ...historySourceLogs
          .filter(log => log.type === 'user_action' || log.type === 'answer')
          .map(log => ({
            role: log.type === 'user_action' ? 'user' : 'model',
            content: String(log.text || ''),
          })),
        { role: 'user', content: `${ promptText }${ attachmentContext }` },
      ];

      try {
        const runLocationVal = typeof window !== 'undefined' ? (window.localStorage.getItem('eterx_run_location') || 'local') : 'local';
        const response = await fetch('/api/agents/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: selectedAgent,
            chatId: chatIdToUse,
            messages: runnerMessages,
            mode: runAgentMode,
            apiKeys: readRuntimeApiKeys(),
            modelOverrides: readRuntimeModelOverrides(),
            runLocation: runLocationVal,
            pinnedContext: {
              ...(pinnedItems.length > 0 ? { paths: pinnedItems.map(item => item.path) } : {}),
              ...(activeWorkspacePath ? {
                paths: [activeWorkspacePath, ...pinnedItems.map(item => item.path)],
                workspacePath: activeWorkspacePath,
                isFocusedWorkspace: true,
              } : {}),
            },
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          let message = `Custom agent start failed (${ response.status }).`;
          try {
            const payload = await response.json();
            message = payload.error || message;
          } catch { }
          setChatLogsById(chatIdToUse!, logs => [
            ...stripAgentConnectionLogs(logs),
            systemThoughtLog(`\n\n*${ message }*`),
          ], { touchUpdatedAt: true });
          return;
        }

        if (!response.body) throw new Error('No readable stream from custom agent.');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const handleRunnerEvent = (event: any) => {
          if (!event || typeof event !== 'object') return;
          if (event.type === 'text') {
            pendingCustomText += String(event.text || '');
          } else if (event.type === 'status') {
            appendCustomAgentStatus(String(event.text || ''), String(event.agentName || selectedAgentName));
          } else if (event.type === 'ask_user') {
            const at = Number(event.timestamp || Date.now());
            flushCustomWorkNote();
            appendCustomAgentTrace({
              id: `custom-ask-${ String(event.responseKey || at) }`,
              ...event,
              type: 'ask_user',
              text: String(event.question || 'Input needed'),
              timestamp: at,
              startTime: at,
              endTime: at,
            });
          } else if (event.type === 'tool_call') {
            const at = Date.now();
            flushCustomWorkNote();
            const actionLog = createCustomToolActionLog(event, String(event.agentName || selectedAgentName), at);
            activeCustomToolLogs.set(customToolTraceKey(event), {
              id: actionLog.id,
              toolName: String(event.toolName || ''),
              command: actionLog.command ? String(actionLog.command) : undefined,
              filename: actionLog.filename ? String(actionLog.filename) : undefined,
              toolArgs: event.toolArgs,
            });
            appendCustomAgentTrace(actionLog);
          } else if (event.type === 'tool_result') {
            const at = Date.now();
            const active = activeCustomToolLogs.get(customToolTraceKey(event));
            if (active) {
              updateCustomAgentTrace(active.id, {
                endTime: at,
                timestamp: at,
                toolResult: event.toolResult,
              });
              createCustomToolResultLogs(event, active, at).forEach(appendCustomAgentTrace);
              activeCustomToolLogs.delete(customToolTraceKey(event));
            }
          } else if (event.type === 'error') {
            const message = String(event.text || 'Custom agent failed.');
            setChatLogsById(chatIdToUse!, logs => [
              ...stripAgentConnectionLogs(logs),
              systemThoughtLog(`\n\n*${ message.slice(0, 240) }*`),
            ], { touchUpdatedAt: true });
          } else if (event.type === 'done') {
            if (pendingCustomText.trim()) {
              setCustomAgentAnswer(pendingCustomText, false);
              pendingCustomText = '';
            }
            removeRunningChat(chatIdToUse!);
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              handleRunnerEvent(JSON.parse(trimmed));
            } catch { }
          }
        }

        if (buffer.trim()) {
          try {
            handleRunnerEvent(JSON.parse(buffer.trim()));
          } catch { }
        }
        if (pendingCustomText.trim()) {
          setCustomAgentAnswer(pendingCustomText, false);
          pendingCustomText = '';
        }
      } catch (error: any) {
        if (error.name !== 'AbortError') {
          setChatLogsById(chatIdToUse!, logs => [
            ...stripAgentConnectionLogs(logs),
            systemThoughtLog(`\n\n*Custom agent connection failed: ${ String(error.message || error).slice(0, 180) }*`),
          ], { touchUpdatedAt: true });
        }
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        removeRunningChat(chatIdToUse!);
        markChatUnreadIfBackground(chatIdToUse!);
      }
      return;
    }

    // ═══════════════════════════════════════════════════════════════
    // FIRE-AND-FORGET: Start the SSE stream (backward compatible)
    // The agent runs via AgentRegistry on the server. Even if this
    // SSE stream drops, the agent keeps running. We also start
    // a polling loop as backup/primary for trace updates.
    // ═══════════════════════════════════════════════════════════════

    const requestPinnedContext = {
      ...(pinnedItems.length > 0 ? { paths: pinnedItems.map(p => p.path) } : {}),
      ...(isBuilderChat ? { agentRuntime: 'agent_builder', agentId: builderAgentId } : {}),
      ...(selectedAgent === 'coding' && !isBuilderChat ? { agentRuntime: 'main_coding_agent', agentProfile: 'eterx-code' } : {}),
      ...(activeWorkspacePath ? {
        paths: [activeWorkspacePath, ...(pinnedItems.length > 0 ? pinnedItems.map(p => p.path) : [])],
        workspacePath: activeWorkspacePath,
        isFocusedWorkspace: true
      } : {}),
    };
    const hasPinnedContext = Object.keys(requestPinnedContext).length > 0;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Register the new run before contacting the server. Polling starts only
    // after the start response sets the ownership cookie, avoiding a first-run
    // poll/start race that could create two different browser sessions.
    pollCursorsRef.current.set(chatIdToUse!, -1);
    pollRunStartRef.current.set(chatIdToUse!, runStartedAt);
    pollRunIdRef.current.set(chatIdToUse!, clientRunId);
    let serverAccepted = false;
    // Also start SSE stream for faster real-time events (optional enhancement)
    try {
      const runLocationVal = activeRunLocation;
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: promptText,
          history: chatHistory,
          mediaAttachments,
          userId: 'default',
          projectId: chatIdToUse,
          mode: runAgentMode,
          thinkingLevel: runThinkingLevel,
          pinnedContext: hasPinnedContext ? requestPinnedContext : null,
          apiKeys: readRuntimeApiKeys(),
          modelOverrides: readRuntimeModelOverrides(),
          runLocation: runLocationVal,
          customAgentId: selectedCustomRuntimeId,
          customAgentName: selectedCustomRuntimeId ? selectedAgentName : null,
          runId: clientRunId,
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        let message = `Agent start failed (${ response.status }).`;
        try {
          const errorPayload = await response.json();
          message = errorPayload.error || errorPayload.details || message;
        } catch { }

        stopPolling(chatIdToUse!);
        removeRunningChat(chatIdToUse!);
        markChatUnreadIfBackground(chatIdToUse!);
        setChatLogsById(chatIdToUse!, prev => [
          ...stripAgentConnectionLogs(prev),
          systemThoughtLog(`\n\n*${ message }*`)
        ]);
        return;
      }

      serverAccepted = true;
      startPolling(chatIdToUse!, -1, runStartedAt);

      if (!response.body) throw new Error("No readable stream");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const messages = sseBuffer.split('\n\n');
        sseBuffer = messages.pop() || '';

        for (const chunk of messages) {
          const trimmed = chunk.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          try {
            const parsed = JSON.parse(trimmed.replace(/^data:\s*/, ''));

            // SSE events are handled by the polling loop.
            // We intentionally do NOT act on 'done' here — let polling detect
            // the terminal state so it can pick up all final traces first.
            // Acting on SSE 'done' directly caused a race: runningChats cleared
            // before polling got the last traces, making UI look disconnected.
            if (parsed.type === 'done') {
              // No-op: polling will detect completed/failed/stopped on next tick (150-250ms)
              // and perform the full cleanup including final trace collection.
            }
          } catch (e) { }
        }
      }

    } catch (error: any) {
      if (error.name !== 'AbortError') {
        if (!serverAccepted) {
          stopPolling(chatIdToUse!);
          removeRunningChat(chatIdToUse!);
          markChatUnreadIfBackground(chatIdToUse!);
          setChatLogsById(chatIdToUse!, prev => [
            ...stripAgentConnectionLogs(prev),
            systemThoughtLog(`\n\n*Agent connection failed: ${ String(error.message || error).slice(0, 180) }*`)
          ]);
          return;
        }
        // SSE failed but agent is still running on server!
        // Polling will continue getting updates.
        console.warn('[handleSend] SSE stream disconnected — polling continues:', error.message);
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  };

  // ═══════════════════════════════════════════════════════════════
  // STARTUP REHYDRATION: On page load, check for running agents
  // ═══════════════════════════════════════════════════════════════
  useEffect(() => {
    const rehydrate = async () => {
      try {
        const saved = localStorage.getItem('eterx_chats');
        if (!saved) return;
        const savedChats: ChatSession[] = JSON.parse(saved);

        // Check each chat for running agents on the server
        for (const chat of savedChats.slice(0, 10)) { // Check last 10 chats max
          try {
            const data = await fetchAgentPoll(chat.id, -1, 5000);

            if (data.status === 'running') {
              console.log(`[Rehydrate] 🔄 Found running agent for chat "${ chat.title }" (${ chat.id.substring(0, 8) }...)`);
              setRunningChats(prev => new Set(prev).add(chat.id));

              // If this is the active chat, load live traces
              if (data.traces && data.traces.length > 0) {
                const mergedLogs = mergeServerRunLogs(chat.traceLogs || [], data.traces);
                // Update the chat's traceLogs with merged state
                setChats(prev => {
                  const updated = prev.map(c =>
                    c.id === chat.id ? { ...c, traceLogs: mergedLogs } : c
                  );
                  try { localStorage.setItem('eterx_chats', JSON.stringify(stripChatsForStorage(updated))); } catch { }
                  return updated;
                });
              }

              // Start polling for this chat
              startPolling(chat.id, data.maxIndex ?? (data.totalTraces - 1));
            }
          } catch {
            // Skip — server might not be ready yet
          }
        }
      } catch {
        // Silent — rehydration is optional
      }
    };

    // Delay rehydration slightly to let the page render first
    const timer = setTimeout(rehydrate, 1000);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ═══════════════════════════════════════════════════════════════
  // VISIBILITY CHANGE: When user returns to tab, check for updates
  // ═══════════════════════════════════════════════════════════════
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && activeChatId && !networkPausedRef.current) {
        // User returned to tab — check if active chat's agent is still running
        fetchAgentPoll(activeChatId, -1, 5000)
          .then(data => {
            if (data.status === 'running' && !pollingIntervalsRef.current.has(activeChatId!)) {
              // Agent is running but we're not polling! Restart polling.
              console.log('[Visibility] 🔄 Reconnecting to running agent...');
              setRunningChats(prev => new Set(prev).add(activeChatId!));

              if (data.traces && data.traces.length > 0) {
                setTraceLogs(prevLogs => mergeServerRunLogs(prevLogs, data.traces));
              }

              startPolling(activeChatId!, data.maxIndex ?? (data.totalTraces - 1));
            } else if (isTerminalAgentStatus(data.status) || data.status === 'idle') {
              removeRunningChat(activeChatId!);
            }
          })
          .catch(() => { /* offline */ });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [activeChatId]); // eslint-disable-line react-hooks/exhaustive-deps

  const suggestions = [
    { icon: <Code2 className="w-3.5 h-3.5" />, text: "Code" },
    { icon: <PenTool className="w-3.5 h-3.5" />, text: "Write" },
    { icon: <GraduationCap className="w-3.5 h-3.5" />, text: "Learn" },
    { icon: <MessageSquare className="w-3.5 h-3.5" />, text: "Life stuff" },
    { icon: <img src="/logo.png" alt="Logo" className="w-4 h-4 object-contain brightness-0 invert opacity-80" />, text: "EterX's choice" }
  ];
  // No longer use full-screen initializing state — always show ChatFeed immediately
  const isInitializingChat = false;
  const displayTraceLogs = useMemo(() => {
    const baseLogs = liveState !== 'idle'
      ? traceLogs.filter(l => l.type !== 'thought_stream')
      : traceLogs;

    // Filter out sub-agent details when we are in the main view
    const filteredLogs = baseLogs.filter(l => {
      if (!l) return false;
      const isSubAgentLog = l.subAgent && l.subAgent !== 'Main';
      if (isSubAgentLog) {
        // Keep ONLY sub_agent_spawn in the main timeline
        return l.type === 'sub_agent_spawn';
      }
      return true;
    });

    return [...filteredLogs, ...getLiveTraceLogs()];
  }, [liveState, traceLogs, getLiveTraceLogs]);

  const currentSubAgents = useMemo(() => {
    const agentMap = new Map<string, any>();
    const getTraceEventTime = (log: any) => {
      const at = Number(log?.startTime || log?.timestamp || log?.endTime || 0);
      return Number.isFinite(at) && at > 0 ? at : 0;
    };
    const firstTraceAt = traceLogs.map(getTraceEventTime).find(Boolean) || Date.now();

    // Add Main agent if running or if we have trace logs for it
    if (isThinking) {
      let mainStatus = 'working';
      let mainStartedAt = 0;
      for (const log of traceLogs) {
        if (!log) continue;
        const name = log.agentName || log.subAgent;
        if (name === 'Main' && !mainStartedAt) mainStartedAt = getTraceEventTime(log);
        if (name !== 'Main') continue;
        if (log.type === 'sub_agent_pause') {
          mainStatus = 'paused';
        } else if (log.type === 'sub_agent_resume') {
          mainStatus = 'working';
        } else if (log.type === 'sub_agent_close') {
          mainStatus = 'closed';
        }
      }
      agentMap.set('Main', {
        name: 'Main',
        status: mainStatus,
        task: 'Main orchestrator',
        stepCount: 0,
        durationMs: 0,
        startedAt: mainStartedAt || firstTraceAt,
      });
    }

    for (const log of traceLogs) {
      if (!log) continue;
      const name = log.agentName || log.subAgent;
      if (!name) continue;

      if (name === 'Main') {
        const m = agentMap.get('Main');
        if (m) {
          if (log.type === 'sub_agent_pause') m.status = 'paused';
          else if (log.type === 'sub_agent_resume') m.status = 'working';
          else if (log.type === 'sub_agent_close') m.status = 'closed';
        }
        continue;
      }

      if (log.type === 'sub_agent_spawn') {
        const existing = agentMap.get(name);
        agentMap.set(name, {
          name, status: 'working', task: log.task || log.secondary || log.text || '',
          stepCount: 0, durationMs: 0, startedAt: existing?.startedAt || getTraceEventTime(log) || firstTraceAt,
        });
      } else if (log.type === 'sub_agent_action') {
        const a = agentMap.get(name);
        if (a && a.status !== 'closed') { a.status = 'working'; a.currentAction = log.text?.substring(0, 80); a.stepCount = log.agentStep || (a.stepCount + 1); }
      } else if (log.type === 'sub_agent_complete') {
        const a = agentMap.get(name);
        if (a) { a.status = 'completed'; a.durationMs = log.durationMs || 0; a.stepCount = log.stepCount || a.stepCount; }
      } else if (log.type === 'sub_agent_error') {
        const a = agentMap.get(name);
        if (a) { a.status = 'error'; }
      } else if (log.type === 'sub_agent_pause') {
        const a = agentMap.get(name);
        if (a) { a.status = 'paused'; }
      } else if (log.type === 'sub_agent_resume') {
        const a = agentMap.get(name);
        if (a) { a.status = 'working'; }
      } else if (log.type === 'sub_agent_close') {
        const a = agentMap.get(name);
        if (a) { a.status = 'closed'; }
      }
    }
    return Array.from(agentMap.values());
  }, [traceLogs, isThinking]);

  const realSubAgents = useMemo(
    () => currentSubAgents.filter((agent: any) => agent?.name && agent.name !== 'Main'),
    [currentSubAgents]
  );

  useEffect(() => {
    const names = realSubAgents.map((a: any) => a.name);
    setSubAgentOrder(prev => {
      const existing = prev.filter(name => names.includes(name));
      const brandNew = names.filter(name => !prev.includes(name));
      return [...existing, ...brandNew];
    });
  }, [realSubAgents]);

  const orderedRealSubAgents = useMemo(() => {
    return [...realSubAgents].sort((a, b) => {
      const indexA = subAgentOrder.indexOf(a.name);
      const indexB = subAgentOrder.indexOf(b.name);
      const finalA = indexA === -1 ? 9999 : indexA;
      const finalB = indexB === -1 ? 9999 : indexB;
      return finalA - finalB;
    });
  }, [realSubAgents, subAgentOrder]);

  const headerSubAgentTabs = useMemo(() => {
    const maxVisibleTabs = activeSubAgentTab ? 3 : 4;
    if (orderedRealSubAgents.length <= maxVisibleTabs) return orderedRealSubAgents;

    const activeIndex = orderedRealSubAgents.findIndex((agent: any) => agent.name === activeSubAgentTab);
    if (activeIndex === -1 || activeIndex < maxVisibleTabs) {
      return orderedRealSubAgents.slice(0, maxVisibleTabs);
    }

    const result = orderedRealSubAgents.slice(0, maxVisibleTabs - 1);
    result.push(orderedRealSubAgents[activeIndex]);
    return result;
  }, [activeSubAgentTab, orderedRealSubAgents]);

  const hiddenSubAgents = useMemo(() => {
    const visibleNames = headerSubAgentTabs.map((a: any) => a.name);
    return orderedRealSubAgents.filter((agent: any) => !visibleNames.includes(agent.name));
  }, [orderedRealSubAgents, headerSubAgentTabs]);

  const visibleAgentNames = useMemo(() => {
    return headerSubAgentTabs.map((agent: any) => agent.name);
  }, [headerSubAgentTabs]);

  const handleReorderVisible = (newVisibleOrder: string[]) => {
    setSubAgentOrder(prev => {
      const currentVisibleNames = headerSubAgentTabs.map((agent: any) => agent.name);
      const hiddenNames = prev.filter(name => !currentVisibleNames.includes(name));
      return [...newVisibleOrder, ...hiddenNames];
    });
  };

  const handleSelectHiddenAgent = (agentName: string) => {
    const maxVisibleTabs = activeSubAgentTab ? 3 : 4;
    setSubAgentOrder(prev => {
      const visibleNames = prev.slice(0, maxVisibleTabs);
      const activeIdx = visibleNames.indexOf(activeSubAgentTab || '');
      const swapTargetIdx = activeIdx !== -1 ? activeIdx : (maxVisibleTabs - 1);

      const newOrder = [...prev];
      const targetAgentName = newOrder[swapTargetIdx];
      const hiddenAgentIdx = newOrder.indexOf(agentName);

      if (hiddenAgentIdx !== -1 && swapTargetIdx < newOrder.length) {
        newOrder[swapTargetIdx] = agentName;
        newOrder[hiddenAgentIdx] = targetAgentName;
      }
      return newOrder;
    });
    setActiveSubAgentTab(agentName);
  };

  useEffect(() => {
    if (!activeChatId || !activeSubAgentTab) return;
    let cancelled = false;
    const chatId = activeChatId;
    const agentName = activeSubAgentTab;

    const syncSubAgentHistory = async () => {
      try {
        const params = new URLSearchParams({
          action: 'history',
          projectId: chatId,
          agentName,
          limit: '80',
        });
        const res = await fetch(`/api/agents/comm?${ params.toString() }`, { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const data = await res.json().catch(() => null);
        if (!data?.success || !Array.isArray(data.messages) || cancelled) return;

        const incomingLogs = data.messages
          .map((message: any) => interAgentMessageLog(message, agentName))
          .filter((log: any) => log.messageId);

        if (incomingLogs.length === 0) return;

        setChatLogsById(chatId, previousLogs => {
          const existingIds = new Set(previousLogs.map((log: any) => log.messageId || log.id).filter(Boolean));
          const additions = incomingLogs.filter((log: any) => !existingIds.has(log.messageId) && !existingIds.has(log.id));
          return additions.length > 0 ? [...previousLogs, ...additions] : previousLogs;
        });
      } catch {
        // History polling is best-effort; normal agent polling still owns run state.
      }
    };

    syncSubAgentHistory();
    const intervalId = window.setInterval(syncSubAgentHistory, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeChatId, activeSubAgentTab]);

  const hiddenHeaderSubAgentCount = hiddenSubAgents.length;

  useEffect(() => {
    if (!activeSubAgentTab) return;
    if (!realSubAgents.some((agent: any) => agent.name === activeSubAgentTab)) {
      setActiveSubAgentTab(null);
    }
  }, [activeSubAgentTab, realSubAgents]);

  // Per-sub-agent trace logs — filters the main traceLogs for the selected sub-agent tab
  const subAgentDisplayLogs = useMemo(() => {
    if (!activeSubAgentTab) return [];
    const filtered = traceLogs.filter(log => {
      if (!log) return false;
      const agentName = log.agentName || log.subAgent;
      return agentName === activeSubAgentTab;
    });

    // Prepend a synthetic user_action log with the sub-agent's full task brief
    const agentInfo = currentSubAgents.find(a => a.name === activeSubAgentTab);
    if (agentInfo && agentInfo.task) {
      return [
        {
          type: 'user_action',
          text: agentInfo.task,
          timestamp: agentInfo.startedAt || Date.now(),
          agentName: activeSubAgentTab,
          subAgent: activeSubAgentTab
        },
        ...filtered
      ];
    }
    return filtered;
  }, [traceLogs, activeSubAgentTab, currentSubAgents]);

  // Which logs to show in ChatFeed — main or sub-agent
  const effectiveDisplayLogs = activeSubAgentTab ? subAgentDisplayLogs : displayTraceLogs;
  // Compute effective thinking state
  const effectiveIsThinking = activeSubAgentTab
    ? currentSubAgents.some(a => a.name === activeSubAgentTab && a.status === 'working')
    : isThinking && (!currentSubAgents.some(a => a.name === 'Main' && a.status === 'paused'));
  const currentTaskTracker = useMemo<TaskTrackerState | null>(() => {
    for (let i = traceLogs.length - 1; i >= 0; i--) {
      const log = traceLogs[i];
      if (log?.type === 'task_plan') {
        return {
          goal: log.goal,
          phase: log.phase,
          status: log.status,
          complexity: log.complexity,
          estimatedMinutes: log.estimatedMinutes,
          completedSteps: log.completedSteps,
          totalSteps: log.totalSteps,
          activeStepName: log.activeStepName,
          steps: Array.isArray(log.steps) ? log.steps : [],
        };
      }
      if (log?.type === 'user_action') break;
    }
    return null;
  }, [traceLogs]);

  const lastTaskTracker = useMemo<TaskTrackerState | null>(() => {
    for (let i = traceLogs.length - 1; i >= 0; i--) {
      const log = traceLogs[i];
      if (log?.type === 'task_plan') {
        return {
          goal: log.goal,
          phase: log.phase,
          status: log.status,
          complexity: log.complexity,
          estimatedMinutes: log.estimatedMinutes,
          completedSteps: log.completedSteps,
          totalSteps: log.totalSteps,
          activeStepName: log.activeStepName,
          steps: Array.isArray(log.steps) ? log.steps : [],
        };
      }
    }
    return null;
  }, [traceLogs]);

  const todoCounterText = useMemo(() => {
    const tracker = lastTaskTracker || currentTaskTracker;
    if (!tracker?.steps || tracker.steps.length === 0) return '';
    const completed = tracker.steps.filter(s => s.status === 'done').length;
    const total = tracker.steps.length;
    return `${ completed }/${ total }`;
  }, [lastTaskTracker, currentTaskTracker]);

  const chatChangeStats = useMemo(() => {
    const fileStatusMap = new Map<string, { path: string; status: 'MOD' | 'ADD' }>();
    const fileDiffsMap = new Map<string, { additions: number; deletions: number }>();

    for (const log of traceLogs) {
      if (!log) continue;

      // Only process file_edit logs to calculate changes, avoiding duplicate count from file_preview logs
      if (log.type !== 'file_edit') {
        continue;
      }

      const toolName = log.tool || log.name || '';
      const args = log.toolArgs || {};
      const text = String(log.text || log.content || log.secondary || '').toLowerCase();

      // Determine file status if we edit or write to a file
      let targetFile = '';
      const argFilename = args.TargetFile || args.targetFile || args.filePath || args.filepath || args.filename || args.fileName || '';
      if (argFilename && typeof argFilename === 'string') {
        targetFile = argFilename.trim();
      } else {
        const filename = log.filename || log.secondary || '';
        if (filename && typeof filename === 'string') {
          let cleaned = filename.trim();
          if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
            cleaned = cleaned.substring(1, cleaned.length - 1);
          }
          if (cleaned.includes('.') || cleaned.includes('/') || cleaned.includes('\\')) {
            const lastPart = cleaned.split(/[/\\]/).pop() || '';
            if (lastPart.includes('.')) {
              targetFile = cleaned;
            }
          }
        }
      }

      if (targetFile && !isProjectFile(targetFile)) {
        continue;
      }

      if (targetFile && isProjectFile(targetFile)) {
        const key = getBasename(targetFile).toLowerCase();
        let fileStatus: 'MOD' | 'ADD' = 'MOD';
        if (
          toolName.includes('write_to_file') ||
          toolName.includes('write_file') ||
          toolName.includes('create_file') ||
          text.includes('created file') ||
          text.includes('new file') ||
          text.includes('wrote file')
        ) {
          fileStatus = 'ADD';
        }

        const existingStatus = fileStatusMap.get(key);
        // Prefer absolute path if available (contains slashes)
        const pathVal = (targetFile.includes('/') || targetFile.includes('\\')) ? targetFile : (existingStatus?.path || targetFile);
        if (!existingStatus || fileStatus === 'ADD') {
          fileStatusMap.set(key, { path: pathVal, status: fileStatus });
        } else {
          existingStatus.path = pathVal;
        }
      }

      // Extract additions/deletions
      let logAdditions = 0;
      let logDeletions = 0;
      const addVal = parseInt(log.added || log.additions || log.linesAdded || log.add || 0, 10);
      const delVal = parseInt(log.removed || log.deletions || log.linesRemoved || log.remove || 0, 10);

      if (!isNaN(addVal)) logAdditions = addVal;
      if (!isNaN(delVal)) logDeletions = delVal;

      if (targetFile && isProjectFile(targetFile)) {
        const key = getBasename(targetFile).toLowerCase();
        const existing = fileDiffsMap.get(key) || { additions: 0, deletions: 0 };
        fileDiffsMap.set(key, {
          additions: existing.additions + logAdditions,
          deletions: existing.deletions + logDeletions
        });
      }
    }

    let summedAdditions = 0;
    let summedDeletions = 0;
    const filesList = Array.from(fileStatusMap.entries()).map(([key, info]) => {
      const diffs = fileDiffsMap.get(key) || { additions: 0, deletions: 0 };
      summedAdditions += diffs.additions;
      summedDeletions += diffs.deletions;
      return {
        path: info.path,
        status: info.status,
        additions: diffs.additions,
        deletions: diffs.deletions
      };
    });

    return {
      additions: summedAdditions,
      deletions: summedDeletions,
      files: filesList
    };
  }, [traceLogs]);

  const workMenuSources = useMemo<WorkMenuSourceItem[]>(() => {
    const itemsList: WorkMenuSourceItem[] = [];

    for (const item of pinnedItems || []) {
      itemsList.push({
        id: item.id,
        name: item.name,
        path: item.path,
        isPinned: true,
      });
    }

    for (const file of chatChangeStats.files || []) {
      const name = getBasename(file.path);
      const existing = itemsList.find(item => item.path === file.path || item.name === name);
      if (existing) {
        existing.status = file.status;
        existing.additions = file.additions;
        existing.deletions = file.deletions;
      } else {
        itemsList.push({
          id: `chat-${ file.path }`,
          name,
          path: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
        });
      }
    }

    return itemsList;
  }, [pinnedItems, chatChangeStats.files]);

  const fetchGitInfo = useCallback(async () => {
    // Completely disconnected from executing real git command lines on host.
    // Calculate session uncommitted files dynamically from chatChangeStats
    const filesCount = chatChangeStats?.files?.length || 0;
    const uncommittedText = filesCount > 0 ? `Uncommitted: ${ filesCount } file${ filesCount > 1 ? 's' : '' }` : null;

    setGitBranches(prev => {
      const hasCurrent = prev.some(b => b.name === currentBranch);
      const updatedList = hasCurrent ? [...prev] : [...prev, { name: currentBranch, uncommitted: null }];
      return updatedList.map(b => {
        if (b.name === currentBranch) {
          return { ...b, uncommitted: uncommittedText };
        }
        return b;
      });
    });
  }, [chatChangeStats?.files?.length, currentBranch]);

  const handleCheckoutBranch = async (branchName: string) => {
    setGitError(null);
    setCurrentBranch(branchName);

    // Update the uncommitted count immediately for the checked-out branch
    const filesCount = chatChangeStats?.files?.length || 0;
    const uncommittedText = filesCount > 0 ? `Uncommitted: ${ filesCount } file${ filesCount > 1 ? 's' : '' }` : null;
    setGitBranches(prev => {
      const hasBranch = prev.some(b => b.name === branchName);
      const updatedList = hasBranch ? [...prev] : [...prev, { name: branchName, uncommitted: null }];
      return updatedList.map(b => {
        return { ...b, uncommitted: b.name === branchName ? uncommittedText : null };
      });
    });
    setActiveSubmenu(null);
  };

  const handleCreateBranchSubmit = async () => {
    if (!newBranchName.trim()) return;
    setGitError(null);
    const newName = newBranchName.trim();
    setCurrentBranch(newName);

    const filesCount = chatChangeStats?.files?.length || 0;
    const uncommittedText = filesCount > 0 ? `Uncommitted: ${ filesCount } file${ filesCount > 1 ? 's' : '' }` : null;
    setGitBranches(prev => {
      const hasBranch = prev.some(b => b.name === newName);
      const updatedList = hasBranch ? [...prev] : [...prev, { name: newName, uncommitted: null }];
      return updatedList.map(b => {
        return { ...b, uncommitted: b.name === newName ? uncommittedText : null };
      });
    });

    setIsCreatingBranch(false);
    setNewBranchName('');
    setActiveSubmenu(null);
  };

  useEffect(() => {
    fetchGitInfo();
  }, [traceLogs.length, isThinking, fetchGitInfo]);
  const petMonitorTitle = useMemo(() => {
    const activeChat = activeChatId ? chats.find(chat => chat.id === activeChatId) : null;
    if (activeChat?.title && !isDefaultChatTitle(activeChat.title)) return activeChat.title;
    for (let i = traceLogs.length - 1; i >= 0; i--) {
      if (traceLogs[i]?.type === 'user_action') {
        const text = String(traceLogs[i].text || '').trim();
        if (text) return text;
      }
    }
    return 'EterX agent';
  }, [activeChatId, chats, traceLogs]);
  const petMonitorStatus = useMemo(() => ({
    title: petMonitorTitle,
    text: getLatestPetMonitorText(displayTraceLogs, isThinking) || 'Thinking',
    isThinking,
  }), [displayTraceLogs, isThinking, petMonitorTitle]);

  const openPetWidget = useCallback(() => {
    if (!activeChatId || !isThinking) return;
    setPetWidgetOpen(true);
    const api = (window as any).electronAPI;
    if (api?.openPetWindow) {
      void api.openPetWindow(petMonitorStatus);
    }
  }, [activeChatId, isThinking, petMonitorStatus]);

  useEffect(() => {
    if (!isThinking) {
      setPetWidgetOpen(false);
      (window as any).electronAPI?.closePetWindow?.();
    }
  }, [isThinking]);

  useEffect(() => {
    if (!nativePetAvailable || !petWidgetOpen || !isThinking) return;
    (window as any).electronAPI?.updatePetWindow?.(petMonitorStatus);
  }, [isThinking, nativePetAvailable, petMonitorStatus, petWidgetOpen]);

  useEffect(() => {
    const api = (window as any).electronAPI;
    const unsubscribeReply = api?.onPetReply?.((message: string) => {
      void sendSteeringMessage(message);
    });
    const unsubscribeClosed = api?.onPetWindowClosed?.(() => {
      setPetWidgetOpen(false);
    });
    return () => {
      unsubscribeReply?.();
      unsubscribeClosed?.();
    };
  }, [sendSteeringMessage]);

  const showNewChatMotionField =
    activeView === 'chat' &&
    !activeChatId &&
    traceLogs.length === 0 &&
    liveState === 'idle';

  const handleClosedSidebarHandlePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    closedSidebarDragStartRef.current = event.clientX;
    closedSidebarDragOpenedRef.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);

  const handleClosedSidebarHandlePointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const startX = closedSidebarDragStartRef.current;
    if (startX === null) return;
    if (event.clientX - startX >= 12) {
      closedSidebarDragStartRef.current = null;
      closedSidebarDragOpenedRef.current = true;
      setSidebarOpen(true);
    }
  }, []);

  const handleClosedSidebarHandlePointerEnd = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    closedSidebarDragStartRef.current = null;
  }, []);

  const handleClosedSidebarHandleClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (closedSidebarDragOpenedRef.current) {
      closedSidebarDragOpenedRef.current = false;
      return;
    }
    setSidebarOpen(true);
  }, [clearUnreadChat]);

  return (
    <div data-active-view={activeView} data-sidebar-open={sidebarOpen ? 'true' : 'false'} className="eterx-app-shell flex h-screen font-sans overflow-hidden selection:bg-[#E2765A]/30 transition-colors relative">
      <NetworkStatusBanner
        phase={networkPhase}
        visible={networkBannerVisible}
        onDismiss={dismissNetworkBanner}
      />
      <FloatingPetMonitor
        open={petWidgetOpen && !nativePetAvailable}
        isThinking={isThinking}
        title={petMonitorTitle}
        logs={displayTraceLogs}
        onClose={() => setPetWidgetOpen(false)}
        onReply={sendSteeringMessage}
      />

      {sidebarOpen && (
        <Sidebar
          isOpen={sidebarOpen}
          setIsOpen={setSidebarOpen}
          createNewChat={createNewChat}
          chats={chats.filter(c => !c.id.startsWith('agent_builder_'))}
          activeChatId={activeChatId}
          loadChat={loadChat}
          deleteChat={deleteChat}
          deleteChats={deleteChats}
          renameChat={renameChat}
          toggleFavorite={toggleFavorite}
          onSearchClick={() => setCmdPaletteOpen(true)}
          activeView={activeView}
          setActiveView={setActiveView}
          runningChats={runningChats}
          unreadChats={unreadChatIds}
          onSettingsClick={openSettingsWindow}
          isThinking={isThinking}
        />
      )}

      <SettingsPanel isOpen={isSettingsOpen} initialTab="models" onClose={() => setIsSettingsOpen(false)} />
      {!sidebarOpen && (
        <>
          <div className="eterx-sidebar-closed-toggle-shell">
            <Tooltip text="Open sidebar" side="right">
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setSidebarOpen(true)}
                aria-label="Open sidebar"
                className="eterx-sidebar-closed-toggle group flex h-8 w-8 items-center justify-center rounded-[8px] border border-transparent bg-transparent text-[var(--sidebar-muted-text)] transition-colors duration-150 hover:bg-[var(--sidebar-toggle-hover-bg)] hover:text-[var(--sidebar-hover-text)] active:bg-[var(--sidebar-toggle-active-bg)] cursor-pointer [-webkit-app-region:no-drag]"
              >
                <HeaderSidebarOpenIcon />
              </button>
            </Tooltip>
          </div>
          <button
            type="button"
            aria-label="Open sidebar"
            title="Open sidebar"
            onClick={handleClosedSidebarHandleClick}
            onPointerDown={handleClosedSidebarHandlePointerDown}
            onPointerMove={handleClosedSidebarHandlePointerMove}
            onPointerUp={handleClosedSidebarHandlePointerEnd}
            onPointerCancel={handleClosedSidebarHandlePointerEnd}
            className="eterx-sidebar-closed-edge-handle"
          />
        </>
      )}

      <div className="eterx-workspace-shell flex-1 flex flex-col relative overflow-hidden z-10 transition-colors duration-300">
        {/* Absolute Header (Draggable Region for Electron) */}
        <>
          <div className={`eterx-main-panel ${ !sidebarOpen ? 'eterx-main-panel-sidebar-closed' : '' } flex-1 flex flex-col relative overflow-hidden`}>
            <div className="eterx-main-header relative z-50 flex h-[var(--eterx-main-header-height)] shrink-0 items-center justify-between gap-4 border-b border-[var(--border)] pl-3 pr-6 [-webkit-app-region:drag]">
              <div className="flex min-w-0 items-center gap-2 pointer-events-auto [-webkit-app-region:no-drag]">
                <div id="agent-builder-back-portal" className="flex items-center">
                  {buildingAgentId && (
                    <button
                      onClick={() => {
                        setBuildingAgentId(null);
                        setActiveChatId(null);
                        setTraceLogs([]);
                      }}
                      className="flex items-center gap-2 px-3 py-1.5 bg-white/[0.05] border border-white/5 hover:border-white/10 hover:bg-white/[0.08] text-[#E8E6E3] hover:text-white transition-all rounded-lg group shadow-sm active:scale-95 mr-2"
                    >
                      <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                      <span className="text-[13px] font-medium tracking-wide">Back to Agent-Room</span>
                    </button>
                  )}
                </div>
                {!sidebarOpen && activeView === 'chat' && !buildingAgentId && (
                  <Tooltip text="New chat" side="bottom">
                    <button
                      type="button"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        createNewChat();
                        setActiveView('chat');
                      }}
                      aria-label="New chat"
                      className="group flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-transparent bg-transparent text-[var(--sidebar-muted-text)] transition-colors duration-150 hover:bg-[var(--sidebar-toggle-hover-bg)] hover:text-[var(--sidebar-hover-text)] active:bg-[var(--sidebar-toggle-active-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus-ring)]"
                    >
                      <SquarePen className="h-[17px] w-[17px]" strokeWidth={2.15} />
                    </button>
                  </Tooltip>
                )}
                {(() => {
                  if ((activeView === 'agents' && buildingAgentId) || activeView === 'channels') return null;
                  if (activeView === 'projects' || (activeView === 'agents' && !buildingAgentId)) {
                    const headerLabel = activeView === 'projects' ? 'Tasks' : 'Agents';
                    return (
                      <div className="relative min-w-0 [-webkit-app-region:no-drag] pl-3.5 py-1">
                        <span className="text-[20px] font-bold text-white tracking-tight select-none">{headerLabel}</span>
                      </div>
                    );
                  }
                  const activeChat = activeChatId ? chats.find(c => c.id === activeChatId) : null;
                  const titleText = activeChat ? activeChat.title : DEFAULT_CHAT_TITLE;

                  return (
                    <div className="relative min-w-0 [-webkit-app-region:no-drag]">
                      <div
                        data-open={headerMenuOpen ? 'true' : 'false'}
                        onClick={() => {
                          if (!isEditingChatTitle) {
                            setHeaderMenuOpen(!headerMenuOpen);
                          }
                        }}
                        className={`eterx-thread-tab flex min-w-0 items-center gap-1.5 pl-3.5 pr-1 py-1 text-[13px] font-medium transition-all duration-200 ${ isEditingChatTitle ? 'cursor-default' : 'cursor-pointer' }`}
                      >
                        {isEditingChatTitle ? (
                          <input
                            type="text"
                            autoFocus
                            value={editingTitleText}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setEditingTitleText(e.target.value)}
                            onFocus={(e) => e.target.select()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                if (editingTitleText.trim() && activeChatId) {
                                  renameChat(activeChatId, editingTitleText.trim());
                                }
                                setIsEditingChatTitle(false);
                              } else if (e.key === 'Escape') {
                                setIsEditingChatTitle(false);
                              }
                            }}
                            onBlur={() => {
                              if (editingTitleText.trim() && activeChatId) {
                                renameChat(activeChatId, editingTitleText.trim());
                              }
                              setIsEditingChatTitle(false);
                            }}
                            className="bg-transparent border-none outline-none text-[#E8E6E3] text-[13px] font-medium min-w-[120px] max-w-[400px] py-0 px-0"
                          />
                        ) : (
                          <span className="truncate max-w-[400px] select-none text-[#E8E6E3]">{titleText}</span>
                        )}
                        <div
                          className="relative flex items-center justify-center w-[24px] h-[24px]"
                        >
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!isEditingChatTitle) {
                                setChatActionMenuOpen(!chatActionMenuOpen);
                              }
                            }}
                            className="w-[24px] h-[24px] flex items-center justify-center rounded-full hover:bg-white/10 active:bg-white/15 text-[#555350] hover:text-white transition-all duration-150"
                          >
                            <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${ chatActionMenuOpen ? 'rotate-180 text-white' : '' }`} strokeWidth={1.6} />
                          </div>
                          
                          <AnimatePresence>
                            {chatActionMenuOpen && (
                              <>
                                <div className="fixed inset-0 z-40 cursor-default" onClick={(e) => { e.stopPropagation(); setChatActionMenuOpen(false); }}></div>
                                <motion.div
                                  initial={{ opacity: 0, y: -5, scale: 0.98 }}
                                  animate={{ opacity: 1, y: 0, scale: 1 }}
                                  exit={{ opacity: 0, y: -5, scale: 0.98 }}
                                  transition={{ duration: 0.15, ease: "easeOut" }}
                                  onClick={(e) => e.stopPropagation()}
                                  className="absolute right-0 top-[calc(100%+8px)] w-[180px] z-50 bg-[#1E1E1E]/95 backdrop-blur-xl border border-white/[0.08] rounded-xl shadow-[0_12px_36px_rgba(0,0,0,0.5)] p-1.5 flex flex-col gap-0.5"
                                >
                                  <button
                                    onClick={() => {
                                      setChatActionMenuOpen(false);
                                      if (activeChatId) toggleFavorite(activeChatId);
                                    }}
                                    className="flex items-center text-left px-2.5 py-1.5 text-[12px] font-normal text-[#E8E6E3] hover:bg-white/[0.05] rounded-md transition-colors"
                                  >
                                    {activeChat?.isFavorite ? (
                                      <>
                                        <PinOff className="w-3.5 h-3.5 mr-2.5 shrink-0 text-[#A3A19E]" strokeWidth={1.5} />
                                        <span>Unpin task</span>
                                      </>
                                    ) : (
                                      <>
                                        <Pin className="w-3.5 h-3.5 mr-2.5 shrink-0 text-[#A3A19E]" strokeWidth={1.5} />
                                        <span>Pin task</span>
                                      </>
                                    )}
                                  </button>
                                  <button
                                    onClick={() => {
                                      setChatActionMenuOpen(false);
                                      if (activeChatId) {
                                        setEditingTitleText(titleText);
                                        setIsEditingChatTitle(true);
                                      }
                                    }}
                                    className="flex items-center text-left px-2.5 py-1.5 text-[12px] font-normal text-[#E8E6E3] hover:bg-white/[0.05] rounded-md transition-colors"
                                  >
                                    <Pencil className="w-3.5 h-3.5 mr-2.5 shrink-0 text-[#A3A19E]" strokeWidth={1.5} />
                                    <span>Rename task</span>
                                  </button>
                                  
                                  <div className="my-1 h-px bg-white/[0.06]" />

                                  <button
                                    onClick={() => setChatActionMenuOpen(false)}
                                    className="flex items-center text-left px-2.5 py-1.5 text-[12px] font-normal text-[#E8E6E3] hover:bg-white/[0.05] rounded-md transition-colors"
                                  >
                                    <Calendar className="w-3.5 h-3.5 mr-2.5 shrink-0 text-[#A3A19E]" strokeWidth={1.5} />
                                    <span>Schedule task...</span>
                                  </button>
                                  
                                  <div className="my-1 h-px bg-white/[0.06]" />

                                  <button
                                    onClick={() => setChatActionMenuOpen(false)}
                                    className="flex items-center text-left px-2.5 py-1.5 text-[12px] font-normal text-[#E8E6E3] hover:bg-white/[0.05] rounded-md transition-colors"
                                  >
                                    <ExternalLink className="w-3.5 h-3.5 mr-2.5 shrink-0 text-[#A3A19E]" strokeWidth={1.5} />
                                    <span>Open in new window</span>
                                  </button>
                                </motion.div>
                              </>
                            )}
                          </AnimatePresence>
                        </div>
                      </div>
                      <AnimatePresence>
                        {headerMenuOpen && (
                          <>
                            <div className="fixed inset-0 z-40 cursor-default" onClick={(e) => { e.stopPropagation(); setHeaderMenuOpen(false); }}></div>
                            <motion.div
                              initial={{ opacity: 0, y: -5, scale: 0.98 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, y: -5, scale: 0.98 }}
                              transition={{ duration: 0.15, ease: "easeOut" }}
                              onClick={(e) => e.stopPropagation()}
                              className="absolute left-0 top-[calc(100%+8px)] w-[300px] z-50 bg-[#1E1E1E]/95 backdrop-blur-xl border border-white/[0.08] rounded-xl shadow-[0_12px_36px_rgba(0,0,0,0.5)] p-1.5 flex flex-col max-h-[400px]"
                            >
                              <div className="flex items-center justify-between px-2.5 mb-2 mt-1 h-6">
                                {!headerSearchOpen ? (
                                  <>
                                    <div className="text-[11.5px] font-semibold text-white/50">Threads</div>
                                    <Search
                                      className="w-3.5 h-3.5 text-white/40 hover:text-[#E8E6E3] cursor-pointer transition-colors"
                                      onClick={(e) => { e.stopPropagation(); setHeaderSearchOpen(true); }}
                                      strokeWidth={1.6}
                                    />
                                  </>
                                ) : (
                                  <motion.div
                                    initial={{ width: 0, opacity: 0 }}
                                    animate={{ width: "100%", opacity: 1 }}
                                    className="flex items-center gap-2 w-full bg-white/5 rounded-md px-2 py-1 h-full"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <Search className="w-3 h-3 text-[#A3A19E]" strokeWidth={1.6} />
                                    <input
                                      type="text"
                                      autoFocus
                                      placeholder="Search threads..."
                                      value={headerSearchQuery}
                                      onChange={(e) => setHeaderSearchQuery(e.target.value)}
                                      className="bg-transparent border-none outline-none text-[12px] text-[#E8E6E3] placeholder:text-white/20 w-full font-normal"
                                    />
                                    <X
                                      className="w-3 h-3 text-white/40 hover:text-[#E8E6E3] cursor-pointer"
                                      onClick={(e) => { e.stopPropagation(); setHeaderSearchOpen(false); setHeaderSearchQuery(""); }}
                                      strokeWidth={1.6}
                                    />
                                  </motion.div>
                                )}
                              </div>
                              <div className="overflow-y-auto custom-scrollbar flex-1 space-y-[2px]">
                                {(() => {
                                  const filteredChats = chats.filter(c =>
                                    c.title &&
                                    c.title.toLowerCase().includes(headerSearchQuery.toLowerCase())
                                  );

                                  if (filteredChats.length === 0) {
                                    return <div className="px-2.5 py-2 text-[12px] text-white/30 italic">No threads found</div>;
                                  }

                                  return filteredChats.map(chat => (
                                    <div
                                      key={chat.id}
                                      onClick={() => {
                                        loadChat(chat.id);
                                        setHeaderMenuOpen(false);
                                      }}
                                      className={`w-full text-left px-2.5 py-1.5 text-[12px] rounded-md truncate transition-all duration-150 flex items-center group cursor-pointer border border-transparent active:scale-[0.98] ${ activeChatId === chat.id ? 'bg-white/[0.08] text-white font-medium shadow-sm' : 'text-[#A3A19E] hover:bg-white/[0.05] active:bg-white/10 hover:text-[#E8E6E3]' }`}
                                    >
                                      <MessageSquare className="w-3.5 h-3.5 mr-2.5 shrink-0 text-white/40 group-hover:text-white/60 transition-colors" strokeWidth={1.5} />
                                      <span className="truncate font-normal">{chat.title}</span>
                                    </div>
                                  ));
                                })()}
                              </div>
                            </motion.div>
                          </>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })()}
              </div>

              {/* Sub-Agent Tabs — shown in header when agents are active */}
              {realSubAgents.length > 0 && activeView === 'chat' && activeChatId && (
                <div className="eterx-agent-dock pointer-events-auto [-webkit-app-region:no-drag]" role="tablist" aria-label="Agent workspaces">
                  {/* Main agent tab */}
                  <button
                    type="button"
                    onClick={() => setActiveSubAgentTab(null)}
                    role="tab"
                    aria-selected={!activeSubAgentTab}
                    className={`eterx-agent-tab eterx-agent-tab-main flex items-center gap-2 relative
                    ${ !activeSubAgentTab
                        ? 'eterx-agent-tab-active'
                        : 'eterx-agent-tab-idle'
                      }`}
                  >
                    {!activeSubAgentTab && (
                      <motion.div
                        layoutId="activeSubAgentTabHighlight"
                        className="eterx-agent-tab-active-bg"
                        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                      />
                    )}
                    <span className="eterx-agent-tab-label">Main</span>
                  </button>

                  {/* Drag-to-reorder sub-agent tabs */}
                  <Reorder.Group
                    ref={dragConstraintsRef}
                    axis="x"
                    values={visibleAgentNames}
                    onReorder={handleReorderVisible}
                    className="flex items-center gap-1 min-w-0"
                    as="div"
                  >
                    {headerSubAgentTabs.map((agent: any) => {
                      const isActive = activeSubAgentTab === agent.name;
                      const isClosed = agent.status === 'closed';
                      const isWorking = agent.status === 'working' || agent.status === 'spawning';
                      return (
                        <Reorder.Item
                          dragConstraints={dragConstraintsRef}
                          dragElastic={0.12}
                          whileDrag={{
                            scale: 1.04,
                            zIndex: 99,
                            boxShadow: "0 8px 30px rgba(0,0,0,0.6)",
                          }}
                          transition={{ type: "spring", stiffness: 500, damping: 40 }}
                          key={agent.name}
                          value={agent.name}
                          as="button"
                          type="button"
                          onTap={() => setActiveSubAgentTab(agent.name)}
                          role="tab"
                          aria-selected={isActive}
                          className={`eterx-agent-tab min-w-0 select-none relative
                          ${ isActive
                              ? 'eterx-agent-tab-active'
                              : isClosed
                                ? 'eterx-agent-tab-closed'
                                : 'eterx-agent-tab-idle'
                            }`}
                        >
                          {isActive && (
                            <motion.div
                              layoutId="activeSubAgentTabHighlight"
                              className="eterx-agent-tab-active-bg"
                              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                            />
                          )}
                          <SubAgentAvatar name={agent.name} status={agent.status} size="xs" />
                          <span className="eterx-agent-tab-label min-w-0 truncate">{agent.name}</span>
                          {isWorking && (
                            <svg className="animate-spin h-3.5 w-3.5 text-white/80 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-label="Working">
                              <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                              <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </svg>
                          )}
                        </Reorder.Item>
                      );
                    })}
                  </Reorder.Group>

                  {/* Hidden agents dropdown trigger & menu */}
                  {hiddenHeaderSubAgentCount > 0 && (
                    <div className="relative overflow-visible shrink-0 flex items-center">
                      <button
                        type="button"
                        onClick={() => setOverflowDropdownOpen(!overflowDropdownOpen)}
                        className={`eterx-agent-tab eterx-agent-tab-overflow flex items-center gap-1.5 transition-all
                          ${ overflowDropdownOpen 
                            ? 'border-white/25 bg-white/12 text-white shadow-[0_4px_12px_rgba(255,255,255,0.15)]' 
                            : 'border-white/12 bg-white/8 text-white/60'
                          }`}
                        title={`${ hiddenHeaderSubAgentCount } more agents`}
                      >
                        <span className="text-[11px] font-bold">+{hiddenHeaderSubAgentCount}</span>
                        <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${ overflowDropdownOpen ? 'rotate-180 text-white' : 'text-white/60' }`} strokeWidth={2.2} />
                      </button>

                      {overflowDropdownOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setOverflowDropdownOpen(false)} />
                          <div className="absolute right-0 top-[calc(100%+6px)] min-w-[170px] z-50 bg-[#000000]/95 backdrop-blur-xl border border-white/12 rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.8)] p-1.5 flex flex-col gap-0.5 pointer-events-auto">
                            <div className="px-2.5 py-1 text-[9px] font-bold text-[#6A6460] uppercase tracking-wider select-none">
                              Hidden Agents
                            </div>
                            {hiddenSubAgents.map((agent: any) => (
                              <button
                                key={agent.name}
                                type="button"
                                onClick={() => {
                                  handleSelectHiddenAgent(agent.name);
                                  setOverflowDropdownOpen(false);
                                }}
                                className="w-full text-left px-2.5 py-1.5 text-[12.5px] font-medium text-white/70 hover:text-white hover:bg-white/5 active:scale-[0.98] rounded-lg transition-all flex items-center gap-2"
                              >
                                <SubAgentAvatar name={agent.name} status={agent.status} size="xs" />
                                <span className="truncate flex-1">{agent.name}</span>
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="flex shrink-0 items-center gap-1.5 pointer-events-auto [-webkit-app-region:no-drag]">
                {canUseMonitor && (
                  <div className="relative">
                    <button
                      type="button"
                      aria-label="Toggle git environment dropdown"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEnvDropdownOpen(!envDropdownOpen);
                      }}
                      className={`relative eterx-header-icon-button flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-transparent bg-transparent text-[var(--sidebar-muted-text)] transition-colors duration-150 hover:bg-[var(--sidebar-toggle-hover-bg)] hover:text-[var(--sidebar-hover-text)] active:bg-[var(--sidebar-toggle-active-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus-ring)] ${ envDropdownOpen ? 'bg-[var(--sidebar-toggle-hover-bg)] text-[var(--sidebar-hover-text)]' : '' }`}
                    >
                      <ListTodo className="h-[17px] w-[17px]" strokeWidth={2.15} />
                    </button>
                    <AnimatePresence>
                      {envDropdownOpen && (() => {
                        const chatId = activeChatId || 'default';
                        const layout = workMenuLayouts[chatId] || { x: 0, y: 0, width: 320, height: 'auto' };
                        return (
                          <motion.div
                            ref={envDropdownRef}
                            initial={{ opacity: 0, y: -5, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: -5, scale: 0.98 }}
                            transition={{ duration: 0.15, ease: "easeOut" }}
                            onMouseLeave={() => setActiveSubmenu(null)}
                            className="eterx-work-menu absolute right-0 top-[calc(100%+10px)] z-[70] flex flex-col"
                            style={{
                              transform: `translate(${ layout.x }px, ${ layout.y }px)`,
                              width: layout.width,
                              height: layout.height,
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            {/* Drag handle */}
                            <div
                              className="eterx-work-menu-drag-bar group/drag"
                              onMouseDown={handleMenuDragStart}
                            >
                              <div className="eterx-work-menu-drag-handle" />
                            </div>

                            {/* Resize handles */}
                            <div
                              className="eterx-work-menu-resize-l"
                              onMouseDown={handleMenuResizeLeftStart}
                            />
                            <div
                              className="eterx-work-menu-resize-b"
                              onMouseDown={handleMenuResizeBottomStart}
                            />
                            <div
                              className="eterx-work-menu-resize-corner"
                              onMouseDown={handleMenuResizeCornerStart}
                            />

                            <div className="eterx-work-menu-content flex-1 overflow-y-auto custom-scrollbar">
                              <WorkMenuSectionButton
                                title="Todo"
                                meta={todoCounterText || (isThinking ? 'Live' : undefined)}
                                open={todoSectionOpen}
                                onMouseEnter={() => setActiveSubmenu(null)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setTodoSectionOpen(!todoSectionOpen);
                                }}
                              />

                              {/* Todo List Container */}
                              <AnimatePresence initial={false}>
                                {todoSectionOpen && (
                                  <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: "auto", opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.15, ease: "easeOut" }}
                                    className="overflow-hidden"
                                  >
                                    <div
                                      onMouseEnter={() => setActiveSubmenu(null)}
                                      className="eterx-work-menu-list custom-scrollbar mb-1"
                                    >
                                      {(() => {
                                        const tracker = lastTaskTracker || currentTaskTracker;
                                        const isGenerating = tracker?.phase === 'generating' ||
                                          tracker?.status === 'generating' ||
                                          (isThinking && (!tracker || !tracker.steps || tracker.steps.length === 0));

                                        if (isGenerating) {
                                          return (
                                            <div className="space-y-1 px-1 py-1">
                                              {['Preparing steps', 'Checking scope', 'Organizing work'].map((label, index) => (
                                                <div key={label} className="eterx-work-menu-task-row text-white/58">
                                                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-[#A9A9A9]/30 bg-white/[0.02]">
                                                    <span
                                                      className="h-[4px] w-[4px] rounded-full bg-current opacity-60 animate-[eterx-task-dot_2.8s_ease-in-out_infinite]"
                                                      style={{ animationDelay: `${ index * 0.32 }s` }}
                                                    />
                                                  </span>
                                                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-white/50">
                                                    {label}
                                                  </span>
                                                </div>
                                              ))}
                                            </div>
                                          );
                                        }

                                        if (tracker?.steps && tracker.steps.length > 0) {
                                          return tracker.steps.map((step) => {
                                            const activeWorking = step.status === 'in_progress' || (step.status === 'pending' && tracker.activeStepName === step.name);
                                            return (
                                              <div
                                                key={step.id || step.step}
                                                className="eterx-work-menu-task-row text-white/80"
                                              >
                                                <span className="shrink-0">
                                                  <TaskStatusGlyphMini status={step.status} active={activeWorking} />
                                                </span>
                                                <span className={`truncate flex-1 ${ step.status === 'done' ? 'line-through text-white/45' : activeWorking ? 'text-white font-medium' : 'text-white/70' }`}>
                                                  {step.name || `Task ${ step.step }`}
                                                </span>
                                              </div>
                                            );
                                          });
                                        }

                                        return (
                                          <WorkMenuEmptyState label="Nothing to show" />
                                        );
                                      })()}
                                    </div>
                                  </motion.div>
                                )}
                              </AnimatePresence>

                              {/* Divider */}
                              <div
                                onMouseEnter={() => setActiveSubmenu(null)}
                                className="eterx-work-menu-divider"
                              />

                              {/* Changes Row */}
                              <button
                                onMouseEnter={() => setActiveSubmenu(null)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEnvDropdownOpen(false);
                                  setMonitorOpen(true);
                                }}
                                className="eterx-work-menu-row group"
                              >
                                <PlusSquare className="eterx-work-menu-row-icon" />
                                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                                  <span className="truncate text-white/90">Changes</span>
                                  <div className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold tabular-nums">
                                    <span className="text-[#19C37D]">+{chatChangeStats.additions}</span>
                                    <span className="text-[#EF4444]">-{chatChangeStats.deletions}</span>
                                  </div>
                                </span>
                              </button>

                              {/* Local Row */}
                              <div
                                role="button"
                                tabIndex={0}
                                onMouseEnter={() => setActiveSubmenu('local')}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveSubmenu(activeSubmenu === 'local' ? null : 'local');
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setActiveSubmenu(activeSubmenu === 'local' ? null : 'local');
                                  }
                                }}
                                className={`eterx-work-menu-row group relative ${ activeSubmenu === 'local' ? 'eterx-work-menu-row-active' : '' }`}
                              >
                                <Monitor className="eterx-work-menu-row-icon" />
                                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                                  <span className={`truncate ${ activeSubmenu === 'local' ? 'text-white font-medium' : '' }`}>{currentEnv}</span>
                                  <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-white/30 transition-transform ${ activeSubmenu === 'local' ? 'text-white' : '' }`} />
                                </span>

                                {/* Local Submenu Flyout */}
                                <AnimatePresence>
                                  {activeSubmenu === 'local' && (
                                    <motion.div
                                      initial={{ opacity: 0, x: 5 }}
                                      animate={{ opacity: 1, x: 0 }}
                                      exit={{ opacity: 0, x: 5 }}
                                      transition={{ duration: 0.15 }}
                                      className="eterx-work-menu-flyout absolute right-[calc(100%+10px)] top-0 w-[248px]"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <div className="eterx-work-menu-flyout-label">
                                        Continue in
                                      </div>

                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setCurrentEnv('Local');
                                          setActiveSubmenu(null);
                                        }}
                                        className="eterx-work-menu-row group"
                                      >
                                        <Monitor className="eterx-work-menu-row-icon" />
                                        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                                          <span className={`truncate ${ currentEnv === 'Local' ? 'text-white font-medium' : '' }`}>Work locally</span>
                                          {currentEnv === 'Local' && <Check className="w-3.5 h-3.5 text-[#19C37D] shrink-0" />}
                                        </span>
                                      </button>

                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setCurrentEnv('Worktree');
                                          setActiveSubmenu(null);
                                        }}
                                        className="eterx-work-menu-row group"
                                      >
                                        <GitFork className="eterx-work-menu-row-icon" />
                                        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                                          <span className={`truncate ${ currentEnv === 'Worktree' ? 'text-white font-medium' : '' }`}>Handoff to worktree</span>
                                          {currentEnv === 'Worktree' && <Check className="w-3.5 h-3.5 text-[#19C37D] shrink-0" />}
                                        </span>
                                      </button>

                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setCurrentEnv('Sandbox');
                                          setActiveSubmenu(null);
                                        }}
                                        className="eterx-work-menu-row group"
                                      >
                                        <Terminal className="eterx-work-menu-row-icon" />
                                        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                                          <span className={`truncate ${ currentEnv === 'Sandbox' ? 'text-white font-medium' : '' }`}>Sandbox</span>
                                          {currentEnv === 'Sandbox' && <Check className="w-3.5 h-3.5 text-[#19C37D] shrink-0" />}
                                        </span>
                                      </button>
                                    </motion.div>
                                  )}
                                </AnimatePresence>
                              </div>

                              {/* Branch Row */}
                              <div
                                role="button"
                                tabIndex={0}
                                onMouseEnter={() => setActiveSubmenu('branch')}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveSubmenu(activeSubmenu === 'branch' ? null : 'branch');
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setActiveSubmenu(activeSubmenu === 'branch' ? null : 'branch');
                                  }
                                }}
                                className={`eterx-work-menu-row group relative ${ activeSubmenu === 'branch' ? 'eterx-work-menu-row-active' : '' }`}
                              >
                                <GitBranch className="eterx-work-menu-row-icon" />
                                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                                  <span className={`truncate font-mono ${ activeSubmenu === 'branch' ? 'text-white font-medium' : '' }`}>{currentBranch}</span>
                                  <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-white/30 transition-transform ${ activeSubmenu === 'branch' ? 'text-white' : '' }`} />
                                </span>

                                {/* Branch Submenu Flyout */}
                                <AnimatePresence>
                                  {activeSubmenu === 'branch' && (
                                    <motion.div
                                      initial={{ opacity: 0, x: 5 }}
                                      animate={{ opacity: 1, x: 0 }}
                                      exit={{ opacity: 0, x: 5 }}
                                      transition={{ duration: 0.15 }}
                                      className="eterx-work-menu-flyout absolute right-[calc(100%+10px)] top-0 w-[276px]"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      {gitError && (
                                        <div className="mb-1.5 rounded-[10px] border border-red-500/20 bg-red-500/10 p-2 text-[11px] text-red-400 break-words">
                                          {gitError}
                                        </div>
                                      )}

                                      {isCreatingBranch ? (
                                        <div className="flex flex-col gap-2">
                                          <div className="eterx-work-menu-flyout-label px-1">
                                            Create new branch
                                          </div>

                                          <div className="eterx-work-menu-search">
                                            <GitBranch className="h-3.5 w-3.5 shrink-0 text-white/34" />
                                            <input
                                              type="text"
                                              placeholder="Branch name"
                                              autoFocus
                                              value={newBranchName}
                                              onChange={(e) => setNewBranchName(e.target.value)}
                                              className="w-full border-none bg-transparent font-mono text-[12px] text-white/90 outline-none placeholder:text-white/35"
                                              onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                  handleCreateBranchSubmit();
                                                } else if (e.key === 'Escape') {
                                                  setIsCreatingBranch(false);
                                                  setNewBranchName('');
                                                }
                                              }}
                                            />
                                          </div>

                                          <div className="flex items-center gap-2 justify-end mt-1">
                                            <button
                                              onClick={() => {
                                                setIsCreatingBranch(false);
                                                setNewBranchName('');
                                                setGitError(null);
                                              }}
                                              className="rounded-[8px] bg-white/[0.055] px-2.5 py-1 text-[11px] font-medium text-white/78 transition-colors hover:bg-white/[0.10] hover:text-white"
                                            >
                                              Cancel
                                            </button>
                                            <button
                                              disabled={!newBranchName.trim()}
                                              onClick={handleCreateBranchSubmit}
                                              className="rounded-[8px] bg-[#19C37D]/18 px-2.5 py-1 text-[11px] font-semibold text-[#35D291] transition-colors hover:bg-[#19C37D]/28 disabled:text-[#19C37D]/50 disabled:opacity-40 disabled:hover:bg-[#19C37D]/18"
                                            >
                                              Create
                                            </button>
                                          </div>
                                        </div>
                                      ) : (
                                        <>
                                          <div className="eterx-work-menu-search mb-1.5">
                                            <Search className="h-3.5 w-3.5 shrink-0 text-white/34" />
                                            <input
                                              type="text"
                                              placeholder="Search branches"
                                              value={branchSearch}
                                              onChange={(e) => setBranchSearch(e.target.value)}
                                              className="w-full border-none bg-transparent text-[12px] text-white/90 outline-none placeholder:text-white/35"
                                            />
                                          </div>

                                          <div className="eterx-work-menu-flyout-label">
                                            Branches
                                          </div>

                                          <div className="eterx-work-menu-list eterx-work-menu-list-tall custom-scrollbar">
                                            {(() => {
                                              const filteredBranches = gitBranches.filter(b =>
                                                b.name.toLowerCase().includes(branchSearch.toLowerCase())
                                              );

                                              if (filteredBranches.length === 0) {
                                                return <WorkMenuEmptyState label="No branches found" />;
                                              }

                                              return filteredBranches.map((b) => (
                                                <button
                                                  key={b.name}
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleCheckoutBranch(b.name);
                                                  }}
                                                  className="eterx-work-menu-row group items-start"
                                                >
                                                  <GitBranch className="eterx-work-menu-row-icon mt-0.5" />
                                                  <span className="flex min-w-0 flex-1 items-start justify-between gap-3">
                                                    <div className="flex flex-col min-w-0">
                                                      <span className={`truncate font-mono ${ currentBranch === b.name ? 'text-white font-medium' : 'text-white/70' }`}>{b.name}</span>
                                                      {b.uncommitted && (
                                                        <span className="text-[10px] text-white/35">{b.uncommitted}</span>
                                                      )}
                                                    </div>
                                                    {currentBranch === b.name && (
                                                      <Check className="w-3.5 h-3.5 text-[#19C37D] shrink-0 mt-0.5" />
                                                    )}
                                                  </span>
                                                </button>
                                              ));
                                            })()}
                                          </div>

                                          <div className="eterx-work-menu-divider my-1" />

                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setIsCreatingBranch(true);
                                            }}
                                            className="eterx-work-menu-row group text-white/64"
                                          >
                                            <PlusSquare className="eterx-work-menu-row-icon" />
                                            <span className="min-w-0 flex-1 truncate">Create and checkout new branch...</span>
                                          </button>
                                        </>
                                      )}
                                    </motion.div>
                                  )}
                                </AnimatePresence>
                              </div>

                              {/* Commit/Push Row */}
                              <button
                                onMouseEnter={() => setActiveSubmenu(null)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEnvDropdownOpen(false);
                                  setMonitorOpen(true);
                                }}
                                className="eterx-work-menu-row group"
                              >
                                <GitCommit className="eterx-work-menu-row-icon" />
                                <span className="min-w-0 flex-1 truncate">Commit or push</span>
                              </button>

                              {/* Divider */}
                              <div
                                onMouseEnter={() => setActiveSubmenu(null)}
                                className="eterx-work-menu-divider"
                              />

                              <WorkMenuSectionButton
                                title="Sources"
                                meta={workMenuSources.length || undefined}
                                open={sourcesSectionOpen}
                                onMouseEnter={() => setActiveSubmenu(null)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSourcesSectionOpen(!sourcesSectionOpen);
                                }}
                              />

                              {/* Sources List Container */}
                              <AnimatePresence initial={false}>
                                {sourcesSectionOpen && (
                                  <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: "auto", opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.15, ease: "easeOut" }}
                                    className="overflow-hidden"
                                  >
                                    <div
                                      onMouseEnter={() => setActiveSubmenu(null)}
                                      className="eterx-work-menu-list custom-scrollbar"
                                    >
                                      {workMenuSources.length > 0 ? (
                                        workMenuSources.map((item) => {
                                          const iconPath = getFileIconPath(item.path);
                                          return (
                                            <div
                                              key={item.id}
                                              className="eterx-work-menu-row group"
                                              title={item.path}
                                            >
                                              <img
                                                src={iconPath}
                                                className="h-4 w-4 shrink-0 object-contain transition-transform duration-100 group-hover:scale-105"
                                                alt=""
                                              />
                                              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-white/80 group-hover:text-white">
                                                {item.name}
                                              </span>
                                              {((item.additions || 0) > 0 || (item.deletions || 0) > 0) && (
                                                <div className="ml-1 flex shrink-0 items-center gap-1.5 text-[10.5px] font-semibold tabular-nums">
                                                  {(item.additions || 0) > 0 && <span className="text-[#34D399]">+{item.additions}</span>}
                                                  {(item.deletions || 0) > 0 && <span className="text-[#F87171]">-{item.deletions}</span>}
                                                </div>
                                              )}
                                            </div>
                                          );
                                        })
                                      ) : (
                                        <WorkMenuEmptyState label="No active sources" />
                                      )}
                                    </div>
                                  </motion.div>
                                )}
                              </AnimatePresence>

                              {/* Divider */}
                              <div
                                onMouseEnter={() => setActiveSubmenu(null)}
                                className="eterx-work-menu-divider"
                              />

                              <WorkMenuSectionButton
                                title="Sub-agents"
                                meta={realSubAgents.length || undefined}
                                open={subAgentsSectionOpen}
                                onMouseEnter={() => setActiveSubmenu(null)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSubAgentsSectionOpen(!subAgentsSectionOpen);
                                }}
                              />

                              {/* Sub-agents Row */}
                              <AnimatePresence initial={false}>
                                {subAgentsSectionOpen && (
                                  <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: "auto", opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.15, ease: "easeOut" }}
                                    className="overflow-hidden"
                                  >
                                    <div
                                      onMouseEnter={() => setActiveSubmenu(null)}
                                      className="eterx-work-menu-list custom-scrollbar"
                                    >
                                      {realSubAgents.length > 0 ? (
                                        realSubAgents.map((agent) => {
                                          const isClosed = agent.status === 'closed';
                                          return (
                                            <div
                                              key={agent.name}
                                              className="eterx-work-menu-row group"
                                              onClick={() => {
                                                handleOpenAgentTeam(agent.name);
                                                setEnvDropdownOpen(false);
                                              }}
                                            >
                                              <SubAgentAvatar name={agent.name} status={agent.status} size="xs" />
                                              {/* Agent name */}
                                              <span className={`truncate flex-1 text-[12px] font-medium ${ isClosed ? 'text-white/30 line-through' : 'text-white/75 group-hover:text-white' }`} title={agent.task}>
                                                {agent.name}
                                              </span>
                                              <WorkMenuStatusIndicator status={agent.status} />
                                            </div>
                                          );
                                        })
                                      ) : (
                                        <WorkMenuEmptyState label="No active sub-agents" />
                                      )}
                                    </div>
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </div>
                          </motion.div>
                        );
                      })()}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            </div>


            <div className={`eterx-new-chat-motion-field absolute bottom-0 left-0 right-0 h-[38vh] pointer-events-none overflow-hidden z-0 flex items-end justify-center ${ showNewChatMotionField ? 'opacity-100 transition-opacity duration-[1000ms] ease-out' : 'opacity-0 transition-opacity duration-[1000ms] ease-in' }`}>
              <div key="eterx-home-field-new-chat" className="eterx-home-field">
                <div className="eterx-home-plasma">
                  <div className="eterx-home-plasma-blob eterx-home-plasma-pink" />
                  <div className="eterx-home-plasma-blob eterx-home-plasma-emerald" />
                  <div className="eterx-home-plasma-blob eterx-home-plasma-blue" />
                  <div className="eterx-home-plasma-blob eterx-home-plasma-lime" />
                </div>
                <div className="eterx-home-wave-stage">
                  <div className="eterx-home-wave-depth eterx-home-wave-depth-back" />
                  <div className="eterx-home-wave-volume eterx-home-wave-volume-back" />
                  <div className="eterx-home-lobe eterx-home-lobe-left" />
                  <div className="eterx-home-lobe eterx-home-lobe-center" />
                  <div className="eterx-home-wave-volume eterx-home-wave-volume-mid" />
                  <div className="eterx-home-lobe eterx-home-lobe-right" />
                  <div className="eterx-home-wave-depth eterx-home-wave-depth-front" />
                  <div className="eterx-home-wave-volume eterx-home-wave-volume-front" />
                </div>
              </div>
              <div className="eterx-home-vignette" />
            </div>
            <div className={`eterx-chat-top-fade pointer-events-none absolute left-0 right-0 top-[var(--eterx-main-header-height)] z-40 h-[48px] ${ activeView === 'channels' || activeView === 'projects' ? 'hidden' : '' }`} />

            {/* Split Content Area */}
            <div
              ref={splitContainerRef}
              className={`flex-1 flex overflow-hidden w-full relative z-10 ${ isResizingPanels ? 'cursor-col-resize select-none' : '' }`}
            >
              {activeView === 'agents' && !buildingAgentId ? (
                <AgentsView
                  onOpenBuilder={handleOpenAgentBuilder}
                  onUseAgent={handleUseAgentInChat}
                  selectedAgentId={selectedAgent}
                />
              ) : activeView === 'channels' ? (
                <AgentChannelsView />
              ) : activeView === 'projects' ? (
                <ProjectsView
                  selectedSection={selectedProjectSection}
                  setSelectedSection={setSelectedProjectSection}
                />
              ) : (
                <>
                  {/* Chat Container */}
                  <div
                    className={`flex flex-col relative h-full min-w-0 ${ hasOpenFiles ? `shrink-0 min-w-[320px] ${ isResizingPanels ? 'transition-none' : 'transition-[width,flex-basis] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]' }` : 'w-full transition-all duration-300' }`}
                    style={hasOpenFiles ? { width: chatPanelWidth ?? undefined, flexBasis: chatPanelWidth === null ? `${ DEFAULT_CHAT_PANEL_RATIO * 100 }%` : undefined } : undefined}
                  >
                    <ChatFeed
                      key={`${ activeChatId }-${ activeSubAgentTab || 'main' }`}
                      traceLogs={effectiveDisplayLogs}
                      isThinking={effectiveIsThinking}
                      messagesEndRef={messagesEndRef}
                      setSidebarOpen={setSidebarOpen}
                      sidebarOpen={sidebarOpen}
                      handleScroll={handleScroll}
                      showScrollBottom={showScrollBottom}
                      isCompressed={isRightPanelVisible}
                      onAnswerAskUser={handleAnswerAskUser}
                      onEditUserMessage={setInputValue}
                      onOpenAgentTeam={handleOpenAgentTeam}
                      isSubAgentTab={!!activeSubAgentTab}
                    />

                    {/* Pending Steering Queue */}
                    {!activeSubAgentTab && pendingSteering.length > 0 && (
                      <div className={`px-4 ${ isRightPanelVisible ? 'sm:px-4' : 'sm:px-12' } w-full max-w-[760px] mx-auto flex flex-col gap-2 pb-2`}>
                        <div className="text-xs text-neutral-500 font-medium px-1 flex items-center gap-1.5">
                          Pending messages <span className="w-4 h-4 inline-flex items-center justify-center rounded-full bg-neutral-800 text-[10px] text-neutral-400">i</span>
                        </div>
                        {pendingSteering.map(msg => (
                          <div key={msg.id} className="bg-[#242424] rounded-xl py-2.5 px-3.5 flex items-center justify-between gap-3 text-sm text-neutral-200 shadow-sm border border-white/[0.04]">
                            <span className="truncate">{msg.text}</span>
                            <button
                              onClick={() => setPendingSteering(prev => prev.filter(p => p.id !== msg.id))}
                              className="text-neutral-500 hover:text-red-400 transition-colors p-1 -mr-1"
                            >
                              <Trash className="w-4 h-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {activeSubAgentTab && (
                      <div className={`px-4 ${ isRightPanelVisible ? 'sm:px-4' : 'sm:px-12' } w-full max-w-[760px] mx-auto pb-2`}>
                        <div className="flex min-h-[34px] items-center justify-between gap-3 rounded-[8px] border border-white/[0.07] bg-[#181818]/88 px-3 py-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
                          <span className="flex min-w-0 items-center gap-2">
                            <MessageSquare className="h-3.5 w-3.5 shrink-0 text-white/48" strokeWidth={2.1} />
                            <span className="min-w-0 truncate text-[12px] font-semibold text-white/82">{activeSubAgentTab}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            <span className={`h-1.5 w-1.5 rounded-full ${ effectiveIsThinking ? 'bg-emerald-300/80' : 'bg-white/28' }`} />
                            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/38">
                              {effectiveIsThinking ? 'working' : 'ready'} - deferred
                            </span>
                          </span>
                        </div>
                      </div>
                    )}

                    <ChatInput
                      inputValue={inputValue}
                      setInputValue={setInputValue}
                      isThinking={activeSubAgentTab ? false : isThinking}
                      isRecording={isRecording}
                      handleSend={activeSubAgentTab ? handleSendSubAgentMessage : handleSend}
                      handleStop={handleStop}
                      handleSteer={activeSubAgentTab ? handleSendSubAgentMessage : handleSteer}
                      toggleSpeech={toggleSpeech}
                      attachments={attachments}
                      setAttachments={setAttachments}
                      greeting={greeting}
                      traceLogsLength={traceLogs.length}
                      isProcessingVoice={isProcessingVoice}
                      audioVolume={audioVolume}
                      cancelVoice={cancelVoice}
                      acceptVoice={acceptVoice}
                      agentMode={agentMode}
                      onModeChange={setAgentMode}
                      thinkingLevel={thinkingLevel}
                      onThinkingLevelChange={setThinkingLevel}
                      pinnedItems={pinnedItems}
                      setPinnedItems={setPinnedItems}
                      liveState={liveState}
                      liveError={liveError}
                      onLiveStart={startLiveSession}
                      onLiveStop={stopLiveSession}
                      liveOutputText={liveOutputText}
                      liveInputText={liveInputText}
                      liveMicVolume={liveMicVolume}
                      liveModelVolume={liveModelVolume}
                      liveActiveTool={liveActiveTool}
                      isMicMuted={liveMicMuted}
                      onToggleMicMute={toggleLiveMicMute}
                      isSpeakerMuted={liveSpeakerMuted}
                      onToggleSpeakerMute={toggleLiveSpeakerMute}
                      isNetworkPaused={isNetworkPaused}
                      onNetworkPausedAction={revealNetworkBanner}
                      isCompressed={isRightPanelVisible}
                      taskTracker={currentTaskTracker}
                      activeChatId={activeChatId}
                      onOpenAgentBuilder={handleOpenAgentBuilder}
                      selectedAgent={selectedAgent}
                      selectedAgentName={activeSubAgentTab || selectedAgentName}
                      composerPlaceholder={activeSubAgentTab ? `Message ${ activeSubAgentTab }` : undefined}
                      onAgentChange={handleAgentChange}
                      onOpenPet={openPetWidget}
                      workspacePath={activeWorkspacePath}
                      onWorkspacePathChange={handleWorkspacePathChange}
                      runLocation={activeRunLocation}
                      onRunLocationChange={handleRunLocationChange}
                      onOpenAgents={() => {
                        setBuildingAgentId(null);
                        setActiveView('agents');
                      }}
                      onOpenProjects={() => {
                        setBuildingAgentId(null);
                        setActiveView('projects');
                      }}
                    />

                    {/* Disclaimer Text */}
                    {traceLogs.length === 0 && !isThinking && liveState === 'idle' && (
                      <div className="absolute bottom-6 left-0 right-0 flex flex-col items-center pointer-events-none z-40">
                        <div className="text-center text-[12px] text-black/60 font-medium tracking-wide mix-blend-overlay">
                          EterX is an AI Agent and can make Mistakes ; Please Double-Check Its Work.
                        </div>
                      </div>
                    )}
                  </div>

                  {isRightPanelVisible && (
                    <button
                      type="button"
                      role="separator"
                      aria-label="Resize chat and file panels"
                      aria-orientation="vertical"
                      title="Drag to resize panels. Double-click to reset."
                      onPointerDown={handlePanelResizeStart}
                      onDoubleClick={resetPanelSplit}
                      onKeyDown={handlePanelResizeKeyDown}
                      className={`group relative z-30 flex h-full w-[16px] shrink-0 cursor-col-resize items-center justify-center outline-none transition-opacity duration-200 ${ isResizingPanels ? 'opacity-100' : 'opacity-60 hover:opacity-100 focus-visible:opacity-100' }`}
                    >
                      <span className="absolute inset-y-4 left-1/2 w-px -translate-x-1/2 rounded-full bg-white/[0.055] transition-colors duration-200 group-hover:bg-white/[0.14] group-focus-visible:bg-white/[0.18]" />
                      <span className={`relative flex h-16 w-[9px] items-center justify-center rounded-full border shadow-[0_14px_30px_rgba(0,0,0,0.34)] transition-all duration-200 ${ isResizingPanels ? 'border-white/25 bg-[#303030]' : 'border-white/[0.08] bg-[#1D1D1D]/90 group-hover:border-white/[0.18] group-hover:bg-[#272727]' }`}>
                        <span className={`h-8 w-[2px] rounded-full transition-colors duration-200 ${ isResizingPanels ? 'bg-white/90' : 'bg-[#777] group-hover:bg-white/80 group-focus-visible:bg-white/90' }`} />
                      </span>
                    </button>
                  )}

                  {/* Right Panel Container */}
                  {isRightPanelVisible && (
                    <IdePanel />
                  )}

                  {/* Agent Team Panel */}
                  <AnimatePresence>
                    {agentTeamOpen && (
                      <motion.aside
                        initial={{ opacity: 0, y: -8, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -8, scale: 0.98 }}
                        transition={{ duration: 0.16 }}
                        className="absolute top-[42px] right-4 z-50 w-[320px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-white/[0.09] bg-[#151515]/95 shadow-[0_24px_80px_rgba(0,0,0,0.55)] backdrop-blur-xl pointer-events-auto"
                      >
                        <div className="flex items-center justify-between border-b border-white/[0.07] px-3 py-2.5">
                          <div className="min-w-0">
                            <div className="text-[12px] font-semibold text-white/90">Agent Team</div>
                            <div className="text-[11px] text-white/42">
                              {isThinking ? 'Coordinating current work' : 'Latest agent activity'}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setAgentTeamOpen(false)}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white/80"
                            aria-label="Close agent team"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <div className="max-h-[420px] overflow-y-auto p-2 space-y-1.5 custom-scrollbar">
                          {realSubAgents.length === 0 ? (
                            <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-3 text-[12px] text-white/48">
                              No delegated agents are active yet.
                            </div>
                          ) : (
                            realSubAgents.map((agent: any) => {
                              const status = String(agent.status || 'pending');
                              const isWorking = status === 'working' || status === 'spawning';
                              const isPaused = status === 'paused';
                              const isCompleted = status === 'completed';
                              const isClosed = status === 'closed';
                              const isError = status === 'error';

                              const handleControl = async (action: string) => {
                                try {
                                  await fetch('/api/agent/control', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ action, projectId: activeChatId, agentName: agent.name }),
                                  });
                                } catch (err) {
                                  console.error(`[AgentControl] ${ action } failed:`, err);
                                }
                              };

                              const statusBadge = isCompleted
                                ? { bg: 'bg-emerald-500/10 text-emerald-400', label: 'Done' }
                                : isPaused
                                  ? { bg: 'bg-amber-500/10 text-amber-400', label: 'Paused' }
                                  : isClosed
                                    ? { bg: 'bg-white/[0.04] text-white/30', label: 'Closed' }
                                    : isError
                                      ? { bg: 'bg-red-500/10 text-red-400', label: 'Error' }
                                      : isWorking
                                        ? { bg: 'bg-emerald-500/10 text-emerald-400', label: 'Working' }
                                        : { bg: 'bg-white/[0.04] text-white/40', label: status };

                              return (
                                <div key={agent.name} className={`rounded-[12px] border border-white/[0.07] bg-[linear-gradient(180deg,rgba(255,255,255,0.055),rgba(255,255,255,0.026))] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] ${ isClosed ? 'opacity-45' : '' }`}>
                                  <div className="flex items-center gap-2.5">
                                    <SubAgentAvatar name={agent.name} status={status} size="md" />
                                    {/* Name + status */}
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-2">
                                        <span className="truncate text-[12px] font-semibold text-white/86">{agent.name}</span>
                                        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider ${ statusBadge.bg }`}>
                                          {statusBadge.label}
                                        </span>
                                      </div>
                                      <div className="mt-0.5 line-clamp-1 text-[10.5px] leading-4 text-white/40">
                                        {agent.currentAction || agent.task || 'Waiting...'}
                                      </div>
                                    </div>
                                    {/* Control buttons */}
                                    {!isClosed && !isCompleted && (
                                      <div className="flex shrink-0 items-center gap-1">
                                        {isWorking && (
                                          <button
                                            type="button"
                                            onClick={() => handleControl('pause')}
                                            className="flex h-6 w-6 items-center justify-center rounded-md text-white/40 transition-colors hover:bg-amber-500/10 hover:text-amber-400"
                                            aria-label={`Pause ${ agent.name }`}
                                            title="Pause"
                                          >
                                            <svg viewBox="0 0 10 10" fill="currentColor" className="w-2.5 h-2.5"><rect x="1" y="1" width="3" height="8" rx="0.5" /><rect x="6" y="1" width="3" height="8" rx="0.5" /></svg>
                                          </button>
                                        )}
                                        {isPaused && (
                                          <button
                                            type="button"
                                            onClick={() => handleControl('resume')}
                                            className="flex h-6 w-6 items-center justify-center rounded-md text-white/40 transition-colors hover:bg-emerald-500/10 hover:text-emerald-400"
                                            aria-label={`Resume ${ agent.name }`}
                                            title="Resume"
                                          >
                                            <svg viewBox="0 0 10 10" fill="currentColor" className="w-3 h-3"><polygon points="2,1 9,5 2,9" /></svg>
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          onClick={() => handleControl('close')}
                                          className="flex h-6 w-6 items-center justify-center rounded-md text-white/40 transition-colors hover:bg-red-500/10 hover:text-red-400"
                                          aria-label={`Close ${ agent.name }`}
                                          title="Close"
                                        >
                                          <X className="w-3 h-3" />
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </motion.aside>
                    )}
                  </AnimatePresence>
                  {/* Computer Panel */}
                  <AnimatePresence>
                    {canUseMonitor && monitorOpen && (
                      <MonitorPanel isOpen={monitorOpen} onClose={() => setMonitorOpen(false)} chatId={activeChatId} defaultWidth={640} />
                    )}
                  </AnimatePresence>
                </>
              )}
            </div>
          </div>
        </>
      </div>

      <CommandPalette
        isOpen={cmdPaletteOpen}
        onClose={() => setCmdPaletteOpen(false)}
        createNewChat={createNewChat}
        chats={chats}
        loadChat={loadChat}
      />

      <style dangerouslySetInnerHTML={{
        __html: `
        .eterx-home-field {
          position: absolute;
          inset: 0;
          overflow: hidden;
          isolation: isolate;
          background: linear-gradient(180deg, transparent 0%, transparent 20%, rgba(10, 22, 24, 0.18) 72%, rgba(13, 207, 187, 0.10) 100%);
          animation: eterx-home-field-enter 900ms cubic-bezier(0.16, 1, 0.3, 1) both;
        }

        .eterx-home-plasma,
        .eterx-home-plasma-blob,
        .eterx-home-wave-stage,
        .eterx-home-wave-volume,
        .eterx-home-wave-depth,
        .eterx-home-lobe,
        .eterx-home-vignette {
          position: absolute;
          pointer-events: none;
        }

        .eterx-home-plasma {
          z-index: 1;
          left: 50%;
          bottom: -14vh;
          width: min(1480px, 122vw);
          height: 32vh;
          transform: translateX(-50%);
          filter: blur(36px) saturate(1.10);
          opacity: 0.42;
          mix-blend-mode: normal;
          animation: eterx-home-plasma-breathe 13s ease-in-out infinite;
          will-change: transform;
        }

        .eterx-home-plasma-blob {
          top: 15%;
          height: 76%;
          border-radius: 999px;
          mix-blend-mode: normal;
          will-change: transform;
        }

        .eterx-home-plasma-pink {
          left: -6%;
          width: 31%;
          background: #e6509f;
          animation: eterx-home-plasma-drift-a 14s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }

        .eterx-home-plasma-emerald {
          left: 13%;
          width: 45%;
          background: #12d4b3;
          animation: eterx-home-plasma-drift-b 12.8s cubic-bezier(0.4, 0, 0.2, 1) -2.6s infinite;
        }

        .eterx-home-plasma-blue {
          right: 13%;
          width: 47%;
          background: #328cf6;
          animation: eterx-home-plasma-drift-a 15s cubic-bezier(0.4, 0, 0.2, 1) -5.4s infinite;
        }

        .eterx-home-plasma-lime {
          right: -5%;
          width: 30%;
          background: #a7c941;
          animation: eterx-home-plasma-drift-b 14.4s cubic-bezier(0.4, 0, 0.2, 1) -7.8s infinite;
        }

        .eterx-home-wave-stage {
          z-index: 4;
          left: 50%;
          bottom: -9vh;
          width: min(1620px, 132vw);
          height: 39vh;
          overflow: hidden;
          contain: strict;
          backface-visibility: hidden;
          transform: translateX(-50%) perspective(820px) rotateX(8deg) translateY(0);
          transform-origin: 50% 100%;
          opacity: 0.92;
          filter: saturate(1.08);
          mix-blend-mode: normal;
          animation: eterx-home-wave-stage-float 9.2s ease-in-out infinite;
          will-change: transform;
        }

        .eterx-home-wave-volume {
          z-index: 3;
          left: 50%;
          border-radius: 50% 50% 0 0 / 76% 76% 0 0;
          transform-origin: 50% 100%;
          will-change: transform, opacity;
          -webkit-mask-image: radial-gradient(ellipse at 50% 88%, black 0%, black 54%, transparent 74%);
          mask-image: radial-gradient(ellipse at 50% 88%, black 0%, black 54%, transparent 74%);
        }

        .eterx-home-wave-volume-back {
          z-index: 2;
          bottom: 8.5vh;
          width: 112%;
          height: 26vh;
          background:
            radial-gradient(ellipse at 18% 62%, rgba(204, 58, 145, 0.18), transparent 48%),
            radial-gradient(ellipse at 38% 56%, rgba(17, 188, 160, 0.28), transparent 56%),
            radial-gradient(ellipse at 65% 48%, rgba(46, 129, 230, 0.32), transparent 58%),
            radial-gradient(ellipse at 92% 62%, rgba(150, 178, 56, 0.14), transparent 48%);
          filter: blur(22px);
          opacity: 0.32;
          transform: translateX(-50%) rotate(-2deg) scale(1.06, 0.70);
          animation: eterx-home-wave-volume-back 11.8s ease-in-out infinite;
        }

        .eterx-home-wave-volume-mid {
          z-index: 4;
          bottom: 0.5vh;
          width: 122%;
          height: 31vh;
          background:
            radial-gradient(ellipse at 12% 68%, rgba(214, 69, 151, 0.20), transparent 48%),
            radial-gradient(ellipse at 34% 58%, rgba(18, 213, 178, 0.46), transparent 58%),
            radial-gradient(ellipse at 61% 53%, rgba(39, 187, 228, 0.44), transparent 60%),
            radial-gradient(ellipse at 76% 56%, rgba(58, 139, 241, 0.42), transparent 58%),
            radial-gradient(ellipse at 98% 64%, rgba(158, 188, 58, 0.20), transparent 48%);
          filter: blur(15px);
          opacity: 0.58;
          transform: translateX(-50%) rotate(1.2deg) scale(1.02, 0.78);
          animation: eterx-home-wave-volume-mid 8.8s ease-in-out infinite;
        }

        .eterx-home-wave-volume-front {
          z-index: 6;
          bottom: -4.5vh;
          width: 130%;
          height: 29vh;
          background:
            radial-gradient(ellipse at 13% 52%, rgba(220, 72, 158, 0.16), transparent 45%),
            radial-gradient(ellipse at 38% 48%, rgba(23, 226, 190, 0.54), transparent 58%),
            radial-gradient(ellipse at 66% 48%, rgba(53, 204, 239, 0.46), transparent 59%),
            radial-gradient(ellipse at 82% 52%, rgba(77, 150, 246, 0.46), transparent 58%),
            radial-gradient(ellipse at 98% 58%, rgba(170, 198, 62, 0.17), transparent 45%);
          filter: blur(12px);
          opacity: 0.68;
          transform: translateX(-50%) rotate(-0.8deg) scale(1.08, 0.72);
          animation: eterx-home-wave-volume-front 7.8s ease-in-out infinite;
        }

        .eterx-home-wave-depth {
          z-index: 5;
          left: 50%;
          border-radius: 50% 50% 0 0 / 70% 70% 0 0;
          background:
            radial-gradient(ellipse at 50% 100%, rgba(1, 9, 11, 0.78), rgba(2, 10, 13, 0.42) 42%, transparent 72%);
          mix-blend-mode: multiply;
          transform-origin: 50% 100%;
          will-change: transform, opacity;
          -webkit-mask-image: radial-gradient(ellipse at 50% 86%, black 0%, black 48%, transparent 75%);
          mask-image: radial-gradient(ellipse at 50% 86%, black 0%, black 48%, transparent 75%);
        }

        .eterx-home-wave-depth-back {
          z-index: 1;
          bottom: 8.5vh;
          width: 114%;
          height: 24vh;
          filter: blur(18px);
          opacity: 0.58;
          transform: translateX(-50%) rotate(1.4deg) scale(1.08, 0.66);
          animation: eterx-home-wave-depth-back 10.4s ease-in-out infinite;
        }

        .eterx-home-wave-depth-front {
          z-index: 5;
          bottom: 0;
          width: 126%;
          height: 24vh;
          filter: blur(14px);
          opacity: 0.24;
          transform: translateX(-50%) rotate(-1deg) scale(1.08, 0.58);
          animation: eterx-home-wave-depth-front 8.4s ease-in-out infinite;
        }

        .eterx-home-lobe {
          z-index: 5;
          bottom: -1vh;
          width: 34%;
          height: 28vh;
          border-radius: 999px;
          filter: blur(22px);
          opacity: 0.42;
          will-change: transform, opacity;
          -webkit-mask-image: radial-gradient(ellipse at 50% 70%, black 0%, black 54%, transparent 76%);
          mask-image: radial-gradient(ellipse at 50% 70%, black 0%, black 54%, transparent 76%);
        }

        .eterx-home-lobe-left {
          left: 7%;
          background: radial-gradient(ellipse at 50% 50%, rgba(224, 74, 158, 0.46), rgba(20, 222, 188, 0.24) 48%, transparent 76%);
          animation: eterx-home-lobe-left 9s ease-in-out infinite;
        }

        .eterx-home-lobe-center {
          left: 36%;
          width: 40%;
          background: radial-gradient(ellipse at 50% 54%, rgba(20, 228, 194, 0.52), rgba(53, 204, 240, 0.34) 50%, transparent 76%);
          opacity: 0.46;
          animation: eterx-home-lobe-center 7.8s ease-in-out infinite;
        }

        .eterx-home-lobe-right {
          right: 2%;
          width: 36%;
          background: radial-gradient(ellipse at 50% 52%, rgba(72, 154, 250, 0.48), rgba(170, 202, 64, 0.24) 48%, transparent 76%);
          animation: eterx-home-lobe-right 10s ease-in-out infinite;
        }

        .eterx-home-vignette {
          inset: 0;
          z-index: 8;
          background:
            linear-gradient(180deg, #0F0F0F 0%, rgba(15, 15, 15, 0.78) 14%, rgba(15, 15, 15, 0.20) 42%, transparent 100%),
            radial-gradient(122% 104% at 50% 100%, transparent 0%, transparent 58%, rgba(15, 15, 15, 0.42) 83%, #0F0F0F 100%),
            linear-gradient(90deg, #0F0F0F 0%, rgba(15, 15, 15, 0.30) 10%, transparent 23%, transparent 78%, rgba(15, 15, 15, 0.34) 90%, #0F0F0F 100%);
        }

        .eterx-new-chat-motion-field {
          transform: translateZ(0);
          will-change: opacity;
          filter: saturate(0.42) brightness(0.76);
          clip-path: inset(0 0 0 0 round 0 0 0 var(--eterx-main-panel-left-radius, var(--eterx-shell-radius)));
          -webkit-mask-image: linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.12) 14%, rgba(0, 0, 0, 0.82) 32%, #000 100%);
          mask-image: linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.12) 14%, rgba(0, 0, 0, 0.82) 32%, #000 100%);
          background:
            radial-gradient(ellipse at 0% 100%, rgba(34, 34, 34, 0.48) 0%, rgba(34, 34, 34, 0.30) 34%, transparent 68%),
            linear-gradient(180deg, transparent 0%, transparent 44%, rgba(34, 34, 34, 0.10) 74%, rgba(34, 34, 34, 0.22) 100%);
        }

        .eterx-new-chat-motion-field .eterx-home-field {
          animation: none;
          opacity: 1 !important;
          transform: none !important;
        }

        .eterx-new-chat-motion-field .eterx-home-vignette {
          background:
            radial-gradient(122% 100% at 58% 100%, transparent 0%, transparent 66%, rgba(15, 15, 15, 0.18) 88%, rgba(15, 15, 15, 0.48) 100%);
        }

        @keyframes eterx-home-field-enter {
          0% { opacity: 0; transform: translateY(20px) scale(0.985); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }

        @keyframes eterx-home-plasma-breathe {
          0%, 100% { transform: translateX(-50%) translateY(0) scale(1, 1); }
          45% { transform: translateX(-50%) translateY(-0.8vh) scale(1.02, 1.06); }
          72% { transform: translateX(-50%) translateY(0.3vh) scale(0.995, 0.96); }
        }

        @keyframes eterx-home-plasma-drift-a {
          0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
          38% { transform: translate3d(5.4%, -8%, 0) scale(1.08); }
          70% { transform: translate3d(-4.2%, 4.8%, 0) scale(0.96); }
        }

        @keyframes eterx-home-plasma-drift-b {
          0%, 100% { transform: translate3d(0, 1%, 0) scale(1); }
          44% { transform: translate3d(-5.6%, -7%, 0) scale(1.07); }
          74% { transform: translate3d(4.4%, 4.2%, 0) scale(0.97); }
        }

        @keyframes eterx-home-wave-stage-float {
          0%, 100% { transform: translateX(-50%) perspective(820px) rotateX(8deg) translate3d(0, 0, 0); }
          45% { transform: translateX(-50%) perspective(820px) rotateX(10deg) translate3d(0, -0.8vh, 0); }
          74% { transform: translateX(-50%) perspective(820px) rotateX(7deg) translate3d(0, 0.35vh, 0); }
        }

        @keyframes eterx-home-wave-volume-back {
          0%, 100% { transform: translateX(-50%) rotate(-2deg) translate3d(-1.2%, 0, 0) scale(1.05, 0.68); opacity: 0.32; }
          43% { transform: translateX(-50%) rotate(-0.7deg) translate3d(1.8%, -1.1vh, 0) scale(1.10, 0.74); opacity: 0.42; }
          72% { transform: translateX(-50%) rotate(-2.6deg) translate3d(-1.9%, 0.45vh, 0) scale(1.02, 0.67); opacity: 0.36; }
        }

        @keyframes eterx-home-wave-volume-mid {
          0%, 100% { transform: translateX(-50%) rotate(1.2deg) translate3d(1.2%, 0, 0) scale(1.02, 0.76); opacity: 0.60; }
          38% { transform: translateX(-50%) rotate(-0.35deg) translate3d(-2%, -1.45vh, 0) scale(1.07, 0.83); opacity: 0.70; }
          68% { transform: translateX(-50%) rotate(2deg) translate3d(2%, 0.55vh, 0) scale(0.99, 0.74); opacity: 0.64; }
        }

        @keyframes eterx-home-wave-volume-front {
          0%, 100% { transform: translateX(-50%) rotate(-0.8deg) translate3d(-1.2%, 0, 0) scale(1.07, 0.70); opacity: 0.68; }
          44% { transform: translateX(-50%) rotate(0.75deg) translate3d(2.1%, -1.2vh, 0) scale(1.12, 0.78); opacity: 0.78; }
          78% { transform: translateX(-50%) rotate(-1.5deg) translate3d(-2.3%, 0.55vh, 0) scale(1.03, 0.69); opacity: 0.72; }
        }

        @keyframes eterx-home-wave-depth-back {
          0%, 100% { transform: translateX(-50%) rotate(1.4deg) translate3d(1.8%, 0, 0) scale(1.08, 0.66); opacity: 0.58; }
          45% { transform: translateX(-50%) rotate(-0.4deg) translate3d(-2.2%, -1.5vh, 0) scale(1.15, 0.72); opacity: 0.72; }
          76% { transform: translateX(-50%) rotate(2.1deg) translate3d(2.6%, 0.5vh, 0) scale(1.04, 0.64); opacity: 0.62; }
        }

        @keyframes eterx-home-wave-depth-front {
          0%, 100% { transform: translateX(-50%) rotate(-1deg) translate3d(-1.5%, 0, 0) scale(1.08, 0.58); opacity: 0.24; }
          42% { transform: translateX(-50%) rotate(0.7deg) translate3d(2.3%, -1.1vh, 0) scale(1.13, 0.64); opacity: 0.34; }
          74% { transform: translateX(-50%) rotate(-1.9deg) translate3d(-2.7%, 0.6vh, 0) scale(1.04, 0.56); opacity: 0.28; }
        }

        @keyframes eterx-home-lobe-left {
          0%, 100% { transform: translate3d(-2%, 1vh, 0) scale(0.92, 0.86); opacity: 0.28; }
          45% { transform: translate3d(8%, -1.1vh, 0) scale(1.10, 0.98); opacity: 0.46; }
          76% { transform: translate3d(2%, 0.2vh, 0) scale(0.98, 0.90); opacity: 0.34; }
        }

        @keyframes eterx-home-lobe-center {
          0%, 100% { transform: translate3d(2%, 0.5vh, 0) scale(1, 0.92); opacity: 0.34; }
          40% { transform: translate3d(-6%, -1.3vh, 0) scale(1.08, 1); opacity: 0.50; }
          72% { transform: translate3d(4%, 0.35vh, 0) scale(0.96, 0.90); opacity: 0.40; }
        }

        @keyframes eterx-home-lobe-right {
          0%, 100% { transform: translate3d(3%, 0.8vh, 0) scale(0.94, 0.88); opacity: 0.28; }
          48% { transform: translate3d(-9%, -1vh, 0) scale(1.09, 0.98); opacity: 0.44; }
          78% { transform: translate3d(-2%, 0.35vh, 0) scale(0.98, 0.90); opacity: 0.34; }
        }

        @media (max-width: 720px) {
          .eterx-home-plasma {
            bottom: -13vh;
            width: 148vw;
            height: 34vh;
          }

          .eterx-home-wave-stage {
            width: 158vw;
            height: 42vh;
          }

          .eterx-home-wave-volume-mid {
            width: 132%;
          }

          .eterx-home-wave-volume-front {
            width: 140%;
          }

          .eterx-home-lobe {
            width: 42%;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .eterx-home-field,
          .eterx-home-plasma,
          .eterx-home-plasma-blob,
          .eterx-home-wave-stage,
          .eterx-home-wave-volume,
          .eterx-home-wave-depth,
          .eterx-home-lobe {
            animation-duration: 1ms;
            animation-iteration-count: 1;
          }
        }

        @keyframes loading-dot {
          0%, 100% { transform: translateY(0); opacity: 0.3; }
          50% { transform: translateY(-5px); opacity: 1; }
        }
        .anim-dot-1 { animation: loading-dot 1.2s ease-in-out infinite 0s; }
        .anim-dot-2 { animation: loading-dot 1.2s ease-in-out infinite 0.2s; }
        .anim-dot-3 { animation: loading-dot 1.2s ease-in-out infinite 0.4s; }

        .code-span {
           font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        }
      `}} />
    </div>
  );
}
