"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Sidebar } from '../components/layout/sidebar';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { applyEterxTheme, broadcastEterxSettingsUpdate } from '../components/theme/theme-bridge';
import { ChatInput } from '../components/layout/chat-input';
import { ChatFeed } from '../components/chat/chat-feed';
import { FloatingLiveWidget } from '../components/chat/FloatingLiveWidget';
import {
  LiveMissionStrip,
  type LiveMissionEntry,
  type LiveMissionState,
} from '../components/chat/LiveMissionStrip';
// @ts-ignore — react-markdown's runtime types vary between desktop bundles.
import ReactMarkdown from 'react-markdown';
import { markdownComponents, normalizeMarkdownForRendering, remarkPlugins, rehypePlugins } from '../components/chat/markdown-renderer';
import { Maximize2, Minimize2, AlertTriangle, CheckCircle2, ChevronDown, Sun, Moon, Clock3, Code2, GraduationCap, List, MessageSquare, Pencil, PenTool, SendHorizontal, SquarePen, Search, X, ArrowLeft, ListTodo, ChevronRight, Monitor, GitFork, Terminal, GitBranch, GitCommit, PlusSquare, Check, FileCode, FileText, MoreHorizontal, Sparkles, Pin, PinOff, Archive, Split, Calendar, ExternalLink, Copy, ChevronLeft, History, RefreshCw, Plus, Pause, Play, SlidersHorizontal, ShieldCheck, Minus, ArrowUp, Mic, Power, LifeBuoy, Bug, Mail, Paperclip, Camera } from 'lucide-react';
import { Tooltip } from '../components/ui/tooltip';
import { safeCopyTextToClipboard } from '../components/ui/copy-button';
import { Shimmer } from '../components/ui/shimmer';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import { InteractiveGrid } from '../components/ui/interactive-grid';
import { GeminiLiveSession, LiveSessionState } from '../lib/live/gemini-live';
import {
  MAIN_AGENT_MODEL_OPTIONS,
  MAIN_AGENT_THINKING_LEVEL_STORAGE_KEY,
  normalizeModelThinkingCapabilities,
  normalizeMainAgentThinkingLevel,
  type MainAgentMode,
  type MainAgentThinkingLevel,
  type ModelThinkingCapabilities,
} from '../lib/agent/model-routing';
import {
  AUTO_MODEL_SELECTION,
  CHAT_CONTEXT_WINDOW_OVERRIDES_STORAGE_KEY,
  CHAT_MODEL_SELECTION_STORAGE_KEY,
  MODEL_API_KEYS_STORAGE_KEY,
  MODEL_CATALOG_STORAGE_KEY,
  MODEL_CONTEXT_WINDOWS_STORAGE_KEY,
  MODEL_OVERRIDE_STORAGE_KEY,
  MODEL_PROVIDER_MODE,
  MODEL_SELECTOR_STORAGE_KEY,
  MODEL_THINKING_CAPABILITIES_STORAGE_KEY,
  modelEntryKey,
  composeApiKeysForSelection,
  entriesToModelCatalog,
  ensureModelSelectorEntry,
  isModelProvider,
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
import { closeThoughtStreamsForBoundary, mergeThoughtStreamTrace } from '../lib/thought-stream-lifecycle';
import { FilePanelProvider, useGlobalFilePanel } from '../contexts/FilePanelContext';
import { isProjectFile, getFileIconPath } from '../lib/utils/file-icon-utils';
import { WorkMenuSectionButton, WorkMenuEmptyState, WorkMenuStatusIndicator } from '../components/layout/WorkMenuHelpers';
import { FloatingPetMonitor, PetThinkingLabel, getLatestPetMonitorText } from '../components/chat/FloatingPetMonitor';
import {
  computeNextScheduledRun,
  normalizeScheduledTask,
  type ScheduledTaskRecord,
  type ScheduledTaskRun,
} from '../lib/scheduled-tasks';

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
const MAX_AGENT_HISTORY_MESSAGES = 80;
const MAX_AGENT_HISTORY_MESSAGE_CHARS = 60_000;
const MAX_AGENT_HISTORY_TOTAL_CHARS = 400_000;

const isInjectedProxyBoundary = (log: any) =>
  log?.type === 'user_action' &&
  (log.source === 'user_proxy' || log.source === 'proxy_manager') &&
  Boolean(log.steeringId || (Array.isArray(log.steeringIds) && log.steeringIds.length > 0));

const buildBoundedAgentHistory = (logs: any[]) => {
  const newestFirst: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  const excludedProxyTurnIndexes = new Set<number>();
  let excludeCurrentTurn = false;
  logs.forEach((log, index) => {
    if (log?.type === 'user_action') excludeCurrentTurn = isInjectedProxyBoundary(log);
    if (excludeCurrentTurn && (log?.type === 'user_action' || log?.type === 'answer')) {
      excludedProxyTurnIndexes.add(index);
    }
  });
  let remainingChars = MAX_AGENT_HISTORY_TOTAL_CHARS;

  for (let index = logs.length - 1; index >= 0 && newestFirst.length < MAX_AGENT_HISTORY_MESSAGES && remainingChars > 0; index--) {
    const log = logs[index];
    if (log?.type !== 'user_action' && log?.type !== 'answer') continue;
    if (excludedProxyTurnIndexes.has(index)) continue;
    const text = String(log.text || '').slice(0, Math.min(MAX_AGENT_HISTORY_MESSAGE_CHARS, remainingChars));
    if (!text) continue;
    newestFirst.push({
      role: log.type === 'user_action' ? 'user' : 'model',
      parts: [{ text }],
    });
    remainingChars -= text.length;
  }

  return newestFirst.reverse();
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

const SubAgentAvatar = React.memo(({
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
        <>
          <span className={`absolute inset-0 flex items-center justify-center ${ textClass } font-bold leading-none text-white/72`}>
            {getAgentInitials(displayName)}
          </span>
          <img
            src={`/icons/sub-agents/${ lowerName }.png`}
            alt={displayName}
            draggable={false}
            onError={(event) => { event.currentTarget.style.display = 'none'; }}
            className="relative z-10 block h-full w-full select-none object-cover"
          />
        </>
      ) : (
        <span className={`${ textClass } font-bold leading-none text-white/72`}>
          {getAgentInitials(displayName)}
        </span>
      )}
    </span>
  );
});

const TaskStatusGlyphMini = React.memo(({ status, active }: { status?: string; active?: boolean }) => {
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
});

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

type QueuedFollowUp = {
  id: string;
  chatId: string;
  text: string;
  attachments: ComposerAttachment[];
  createdAt: number;
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

type ActiveView = 'chat' | 'agents' | 'channels' | 'projects';

// Probe the EterX backend itself. A third-party connectivity URL can be blocked
// by a firewall while every configured model endpoint still works, falsely
// freezing all sends and pollers.
/* Network status UI removed: connectivity never gates execution. */
/* const NetworkStatusBanner = ({
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
}; */



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
const isGeneratedEmptyChat = (chat: ChatSession | null | undefined) => {
  if (!chat || (chat.traceLogs || []).length > 0) return false;
  const title = String(chat.title || '').trim().toLowerCase();
  return title === 'live conversation' || title === DEFAULT_CHAT_TITLE.toLowerCase();
};
const removeGeneratedEmptyChats = (chatList: ChatSession[]) => chatList.filter(chat => {
  return !isGeneratedEmptyChat(chat);
});
const SELECTED_AGENT_STORAGE_KEY = 'eterx_selected_agent';
const SETTINGS_STORAGE_KEY = 'eterx_settings';
const SETTINGS_CHANNEL = 'eterx-settings';
const API_KEY_STORAGE_KEY = 'eterx_api_keys';
const ACTIVE_CHAT_STORAGE_KEY = 'eterx_active_chat';
const CHAT_INDEX_STORAGE_KEY = 'eterx_chat_index';

const readStoredTerminalShell = (): string => {
  if (typeof window === 'undefined') return 'auto';
  try {
    const saved = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    const value = String(saved ? JSON.parse(saved)?.terminalShell || '' : '').trim().toLowerCase();
    return ['auto', 'powershell', 'cmd', 'git-bash', 'wsl', 'zsh', 'bash', 'fish', 'sh'].includes(value)
      ? value
      : 'auto';
  } catch {
    return 'auto';
  }
};

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

const readRuntimeModelThinkingCapability = (selection = readRuntimeChatModelSelection()): ModelThinkingCapabilities | null => {
  if (typeof window === 'undefined') return null;
  const entry = parseModelEntryKey(selection);
  if (!entry) return null;
  try {
    const raw = JSON.parse(window.localStorage.getItem(MODEL_THINKING_CAPABILITIES_STORAGE_KEY) || '{}');
    return normalizeModelThinkingCapabilities(raw?.[modelEntryKey(entry.provider, entry.modelId)]);
  } catch {
    return null;
  }
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

const readRuntimeAgentMode = (fallbackMode: MainAgentMode, selection = readRuntimeChatModelSelection()): MainAgentMode => {
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
  return { agentId: null, agentName: 'General' };
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

const formatProxyManagerMarkdown = (value: string) => {
  const normalized = normalizeMarkdownForRendering(String(value || '').replace(/\\n/g, '\n')).trim();
  // Models sometimes begin a numbered deliverable list immediately after a
  // sentence. Put each item on a Markdown block boundary so emphasis and list
  // rendering work instead of exposing raw ** markers.
  return normalized
    .replace(/([.!?:]\s*)(?=\d{1,2}\.\s+(?:\*\*|__)?[A-Za-z])/g, '$1\n\n')
    .replace(/([^\n])\s+(?=([-*])\s+(?:\*\*|__)?[A-Za-z])/g, '$1\n\n');
};

const proxyManagerMarkdownComponents = {
  ...markdownComponents,
  p: ({ ...props }: any) => <p className="mb-2.5 break-words text-[12.5px] leading-relaxed text-white/88 last:mb-0" {...props} />,
  ol: ({ ...props }: any) => <ol className="my-2 list-decimal space-y-1.5 pl-5 text-[12.5px] leading-relaxed text-white/85" {...props} />,
  ul: ({ ...props }: any) => <ul className="my-2 list-disc space-y-1.5 pl-5 text-[12.5px] leading-relaxed text-white/85" {...props} />,
  li: ({ ...props }: any) => <li className="break-words leading-relaxed text-white/88" {...props} />,
  h1: ({ ...props }: any) => <h1 className="mb-2 mt-4 text-[16px] font-bold leading-tight text-white border-b border-white/10 pb-1.5" {...props} />,
  h2: ({ ...props }: any) => <h2 className="mb-2 mt-3.5 text-[15px] font-bold leading-tight text-white/95 border-b border-white/[0.07] pb-1" {...props} />,
  h3: ({ ...props }: any) => <h3 className="mb-1.5 mt-3 text-[14px] font-semibold leading-tight text-white/90" {...props} />,
  h4: ({ ...props }: any) => <h4 className="mb-1.5 mt-2.5 text-[13px] font-semibold leading-tight text-white/85" {...props} />,
  pre: ({ ...props }: any) => <pre className="my-2.5 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-white/[0.08] bg-white/[0.04] p-3 text-[11px] leading-relaxed eterx-scrollbar" {...props} />,
  strong: ({ ...props }: any) => <strong className="font-bold text-white" {...props} />,
  em: ({ ...props }: any) => <em className="italic text-white/85" {...props} />,
  table: ({ ...props }: any) => (
    <div className="eterx-markdown-table-wrap eterx-scrollbar my-3 w-full max-w-full overflow-x-auto rounded-xl border border-white/[0.10] bg-[#1E1E1E] shadow-sm">
      <table className="eterx-markdown-table w-full min-w-full border-collapse text-left text-[12px]" {...props} />
    </div>
  ),
  thead: ({ ...props }: any) => <thead className="eterx-markdown-thead bg-white/[0.06] border-b border-white/10" {...props} />,
  th: ({ ...props }: any) => <th className="eterx-markdown-th border-b border-r border-white/[0.08] last:border-r-0 px-3 py-2 text-left font-bold text-white text-[12px] bg-white/[0.03]" {...props} />,
  td: ({ ...props }: any) => <td className="eterx-markdown-td border-b border-r border-white/[0.05] last:border-r-0 px-3 py-2 align-top text-white/85 text-[12px] leading-relaxed" {...props} />,
  tr: ({ ...props }: any) => <tr className="eterx-markdown-tr transition-colors hover:bg-white/[0.04] even:bg-white/[0.015]" {...props} />,
  a: ({ node, href, children, ...props }: any) => (
    <a className="text-[#E2765A] font-medium underline-offset-2 hover:underline" target="_blank" rel="noopener noreferrer" href={href} {...props}>{children}</a>
  ),
};

type ProxyLiveTurn = {
  chatId: string;
  turnId: string;
  events: Array<{
    type: 'work' | 'status';
    text: string;
    tool?: string;
    phase?: string;
    timestamp: number;
  }>;
};

const sortChats = (chats: ChatSession[]) => {
  return [...chats].sort((a, b) => {
    if (a.isFavorite && !b.isFavorite) return -1;
    if (!a.isFavorite && b.isFavorite) return 1;
    return b.updatedAt - a.updatedAt;
  });
};

const readContextCompactionSettings = (
  activeModelEntry?: { provider: string; modelId: string } | null,
  chatId?: string | null,
) => {
  if (typeof window === 'undefined') return { enabled: true, model: null, customInstructions: '' };
  try {
    const saved = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    const settings = saved ? JSON.parse(saved) : {};
    const selection = String(settings.contextCompactionModelSelection || AUTO_MODEL_SELECTION);
    const parsedModel = parseModelEntryKey(selection);
    const availableModels = readRuntimeModelEntries();
    const model = parsedModel && availableModels.some(entry =>
      modelEntryKey(entry.provider, entry.modelId) === modelEntryKey(parsedModel.provider, parsedModel.modelId)
    )
      ? parsedModel
      : null;
    let activeContextWindow = 0;
    if (activeModelEntry) {
      const contextWindows = JSON.parse(window.localStorage.getItem(MODEL_CONTEXT_WINDOWS_STORAGE_KEY) || '{}');
      const discoveredMaximum = Number(contextWindows?.[modelEntryKey(activeModelEntry.provider, activeModelEntry.modelId)] || 0);
      const modelMaximum = Number.isFinite(discoveredMaximum) && discoveredMaximum >= 16_000
        ? Math.floor(discoveredMaximum)
        : resolveClientContextWindow(activeModelEntry.provider, activeModelEntry.modelId);
      let budgetSelection = String(settings.contextWindowSizeSelection || '258000');
      if (chatId) {
        try {
          const chatOverrides = JSON.parse(window.localStorage.getItem(CHAT_CONTEXT_WINDOW_OVERRIDES_STORAGE_KEY) || '{}');
          const chatBudget = String(chatOverrides?.[chatId] || '').trim();
          if (chatBudget) budgetSelection = chatBudget;
        } catch { }
      }
      const requestedBudget = budgetSelection === 'model_max'
        ? modelMaximum
        : Number(budgetSelection || 258_000);
      activeContextWindow = Math.min(
        modelMaximum,
        Number.isFinite(requestedBudget) && requestedBudget >= 16_000 ? Math.floor(requestedBudget) : 258_000,
      );
    }
    return {
      enabled: settings.contextCompactionEnabled !== false,
      model: model ? { provider: model.provider, modelId: model.modelId } : null,
      customInstructions: String(settings.contextCompactionInstructions || '').slice(0, 12000),
      activeContextWindow: Number.isFinite(activeContextWindow) && activeContextWindow >= 16_000
        ? Math.floor(activeContextWindow)
        : undefined,
    };
  } catch {
    return { enabled: true, model: null, customInstructions: '' };
  }
};

function resolveClientContextWindow(provider: string, modelName: string): number {
  const model = String(modelName || '').toLowerCase();
  if (provider === 'gemini') return /gemini-(?:1\.5|2\.0|2\.5|3)/.test(model) ? 1_048_576 : 1_000_000;
  if (provider === 'anthropic') return model.includes('1m') ? 1_000_000 : 200_000;
  if (provider === 'openrouter' && model.includes('gemini')) return 1_000_000;
  if (/gpt-5|o3|o4|gpt-4\.1/.test(model)) return 400_000;
  if (provider === 'mistral' || /devstral|codestral/.test(model)) return 256_000;
  if (provider === 'groq') return 131_072;
  return 256_000;
}

const estimateLiveTraceTokens = (log: any): number => {
  if (!log) return 0;
  const type = String(log.type || '');
  if ([
    'context_usage',
    'context_compaction',
    'answer_cancel',
    'work_note',
    'work_note_cancel',
    'progress',
    'tool_result_preview',
    'agent_decision',
    'done',
  ].includes(type)) return 0;
  const textCanEnterContext = [
    'user_action',
    'answer',
    'thought_stream',
    'tool_result',
    'ask_user',
    'steering_applied',
  ].includes(type);
  const fragments = [
    textCanEnterContext ? log.text : null,
    log.output,
    log.command,
    log.toolResult,
    log.result,
    log.question,
    log.answeredWith,
  ];
  let chars = 0;
  const seen = new Set<string>();
  for (const fragment of fragments) {
    if (typeof fragment === 'string') {
      if (!seen.has(fragment)) {
        seen.add(fragment);
        chars += fragment.length;
      }
    }
    else if (fragment && typeof fragment === 'object') {
      try {
        const serialized = JSON.stringify(fragment);
        if (!seen.has(serialized)) {
          seen.add(serialized);
          chars += serialized.length;
        }
      } catch { }
    }
  }
  return chars > 0 ? Math.ceil(chars / 4) + 4 : 0;
};

const contextTraceEstimateIdentity = (log: any): string => {
  const eventId = String(
    log?.thoughtId ||
    log?.answerId ||
    log?.toolCallId ||
    log?.callId ||
    log?.questionId ||
    log?.id ||
    '',
  ).trim();
  if (!eventId) return '';
  return `${String(log?.runId || log?.turnId || '')}|${String(log?.type || '')}|${eventId}`;
};

const traceLogIdentity = (log: any) => [
  log?.id || '',
  log?.type || '',
  log?.timestamp || log?.startTime || '',
  String(log?.text || log?.output || '').slice(0, 160),
].join('|');

const chatHasLogsMissingFromDurable = (durable: ChatSession, cached: ChatSession) => {
  const cachedLogs = cached.traceLogs || [];
  if (cachedLogs.length === 0) return false;
  const lastCachedIdentity = traceLogIdentity(cachedLogs[cachedLogs.length - 1]);
  return !(durable.traceLogs || []).some(log => traceLogIdentity(log) === lastCachedIdentity);
};

const enforceChatTraceOwnership = (chat: ChatSession): ChatSession => {
  const traceLogs = (chat.traceLogs || []).filter(
    log => !log?.chatId || log.chatId === chat.id
  );
  return traceLogs.length === (chat.traceLogs || []).length
    ? chat
    : { ...chat, traceLogs };
};

const mergeCachedChatIntoDurable = (durable: ChatSession, cached: ChatSession): ChatSession => {
  const durableLogs = durable.traceLogs || [];
  const cachedLogs = cached.traceLogs || [];
  if (durableLogs.length === 0 || cachedLogs.length === 0) {
    return {
      ...durable,
      ...cached,
      traceLogs: cachedLogs.length ? cachedLogs : durableLogs,
    };
  }
  const firstCachedIdentity = traceLogIdentity(cachedLogs[0]);
  let overlapIndex = -1;
  for (let i = durableLogs.length - 1; i >= 0; i -= 1) {
    if (traceLogIdentity(durableLogs[i]) === firstCachedIdentity) {
      overlapIndex = i;
      break;
    }
  }
  const mergedLogs = overlapIndex >= 0
    ? (() => {
        const lastCachedIdentity = traceLogIdentity(cachedLogs[cachedLogs.length - 1]);
        const lastCachedIndex = durableLogs.findIndex(
          (log, index) => index >= overlapIndex && traceLogIdentity(log) === lastCachedIdentity
        );
        return lastCachedIndex >= overlapIndex
          ? durableLogs
          : [...durableLogs.slice(0, overlapIndex), ...cachedLogs];
      })()
    : durableLogs.length >= cachedLogs.length ? durableLogs : cachedLogs;
  return { ...durable, ...cached, traceLogs: mergedLogs };
};

const getCatchyGreeting = () => {
  const hour = new Date().getHours();

  // Base greetings that are always in the rotation pool
  const greetings = [
    "brhhhhh.",
    "Helloooo.",
    "It's time to work!",
    "Let's start!",
  ];

  // Dynamically inject a time-appropriate greeting
  if (hour >= 5 && hour < 12) {
    greetings.push("Good morning!");
  } else if (hour >= 12 && hour < 17) {
    greetings.push("Good afternoon!");
  } else if (hour >= 17 && hour < 22) {
    greetings.push("Good evening!");
  } else {
    // Night time (10 PM to 5 AM)
    greetings.push("Hey black owl!");
  }

  return greetings[Math.floor(Math.random() * greetings.length)];
};

export interface PinnedItem {
  id: string;
  type: 'file' | 'folder';
  path: string;
  name: string;
  systemIcon?: string;
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
  const chatScrollPositionsRef = useRef<Record<string, number>>({});
  const [chatPanelWidth, setChatPanelWidth] = useState<number | null>(null);
  const [isResizingPanels, setIsResizingPanels] = useState(false);
  const [inputValue, setInputValue] = useState("");
  // Interface for all composer state elements saved per-chat
  interface ChatComposerState {
    inputValue: string;
    runLocation: 'local' | 'sandbox';
    selectedAgent: SelectedAgentState;
    agentMode: MainAgentMode;
    thinkingLevel: MainAgentThinkingLevel;
    attachments: ComposerAttachment[];
    pinnedItems: PinnedItem[];
    chatModelSelection: string;
  }

  const [activeModelSelection, setActiveModelSelection] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) || AUTO_MODEL_SELECTION;
    }
    return AUTO_MODEL_SELECTION;
  });
  const composerRuntimeSelectionRef = useRef({
    modelSelection: activeModelSelection,
    selectedAgent: readSelectedAgentState(),
    agentMode: (readStoredMainAgentMode() || 'think') as MainAgentMode,
    thinkingLevel: 'low' as MainAgentThinkingLevel,
  });
  const [proxyModelEntries, setProxyModelEntries] = useState(() => readRuntimeModelEntries());
  const [contextSettingsRevision, setContextSettingsRevision] = useState(0);
  const [proxyModelSelection, setProxyModelSelection] = useState<string>(AUTO_MODEL_SELECTION);
  const [proxyRuntimeModelSelection, setProxyRuntimeModelSelection] = useState<string>(AUTO_MODEL_SELECTION);
  const [showProxyAttachMenu, setShowProxyAttachMenu] = useState(false);
  const [copiedProxyMsgId, setCopiedProxyMsgId] = useState<string | null>(null);
  const proxyMessageFeedRef = useRef<HTMLDivElement | null>(null);

  const [composerStates, setComposerStates] = useState<Record<string, ChatComposerState>>(() => {
    if (typeof window !== 'undefined') {
      try {
        return JSON.parse(localStorage.getItem('eterx_chat_composer_states') || '{}');
      } catch {
        return {};
      }
    }
    return {};
  });
  const composerStatesRef = useRef(composerStates);
  composerStatesRef.current = composerStates;

  const updateComposerState = useCallback((updater: (prev: ChatComposerState) => ChatComposerState) => {
    const key = activeChatIdRef.current || 'new_chat';
    setComposerStates(prevStates => {
      const defaultState: ChatComposerState = {
        inputValue: '',
        runLocation: 'local',
        selectedAgent: composerRuntimeSelectionRef.current.selectedAgent,
        agentMode: composerRuntimeSelectionRef.current.agentMode,
        thinkingLevel: composerRuntimeSelectionRef.current.thinkingLevel,
        attachments: [],
        pinnedItems: [],
        chatModelSelection: composerRuntimeSelectionRef.current.modelSelection,
      };
      const currentState = prevStates[key] || defaultState;
      const nextState = updater(currentState);
      const nextStates = { ...prevStates, [key]: nextState };
      try { localStorage.setItem('eterx_chat_composer_states', JSON.stringify(nextStates)); } catch { }
      return nextStates;
    });
  }, []);

  const clearDraftComposerState = useCallback((targetChatId?: string | null) => {
    setInputValue('');
    setAttachments([]);
    setComposerStates(prevStates => {
      const keysToClear = Array.from(new Set(['new_chat', targetChatId || activeChatIdRef.current || ''])).filter(Boolean);
      const nextStates = { ...prevStates };
      for (const k of keysToClear) {
        const existing = nextStates[k] || {
          inputValue: '',
          runLocation: 'local',
          selectedAgent: composerRuntimeSelectionRef.current.selectedAgent,
          agentMode: composerRuntimeSelectionRef.current.agentMode,
          thinkingLevel: composerRuntimeSelectionRef.current.thinkingLevel,
          attachments: [],
          pinnedItems: [],
          chatModelSelection: composerRuntimeSelectionRef.current.modelSelection,
        };
        nextStates[k] = {
          ...existing,
          inputValue: '',
          attachments: [],
        };
      }
      try { localStorage.setItem('eterx_chat_composer_states', JSON.stringify(nextStates)); } catch { }
      return nextStates;
    });
  }, []);

  const applyComposerState = useCallback((state?: ChatComposerState) => {
    const defaultState: ChatComposerState = {
      inputValue: '',
      runLocation: 'local',
      selectedAgent: composerRuntimeSelectionRef.current.selectedAgent,
      agentMode: composerRuntimeSelectionRef.current.agentMode,
      thinkingLevel: composerRuntimeSelectionRef.current.thinkingLevel,
      attachments: [],
      pinnedItems: [],
      chatModelSelection: composerRuntimeSelectionRef.current.modelSelection,
    };
    const target: ChatComposerState = {
      ...defaultState,
      ...(state || {}),
      selectedAgent: state?.selectedAgent || defaultState.selectedAgent,
      pinnedItems: state?.pinnedItems || defaultState.pinnedItems,
      attachments: state?.attachments || defaultState.attachments,
      chatModelSelection: state?.chatModelSelection || defaultState.chatModelSelection,
    };
    composerRuntimeSelectionRef.current = {
      modelSelection: target.chatModelSelection || composerRuntimeSelectionRef.current.modelSelection,
      selectedAgent: target.selectedAgent || composerRuntimeSelectionRef.current.selectedAgent,
      agentMode: target.agentMode || composerRuntimeSelectionRef.current.agentMode,
      thinkingLevel: target.thinkingLevel || composerRuntimeSelectionRef.current.thinkingLevel,
    };
    setInputValue(target.inputValue);
    setActiveRunLocation(target.runLocation);
    setSelectedAgentState(target.selectedAgent);
    setAgentMode(target.agentMode);
    setThinkingLevelState(target.thinkingLevel);
    setAttachments(target.attachments);
    setPinnedItems(target.pinnedItems ?? []);
    // Guard: if chatModelSelection is missing (old stored state), keep current selection
    if (target.chatModelSelection) {
      setActiveModelSelection(target.chatModelSelection);
    }
  }, []);

  const updateInputValue = useCallback((value: string | ((prev: string) => string)) => {
    setInputValue(prev => {
      const resolved = typeof value === 'function' ? value(prev) : value;
      updateComposerState(state => ({ ...state, inputValue: resolved }));
      return resolved;
    });
  }, [updateComposerState]);

  const updateAttachments = useCallback((value: ComposerAttachment[] | ((prev: ComposerAttachment[]) => ComposerAttachment[])) => {
    setAttachments(prev => {
      const resolved = typeof value === 'function' ? value(prev) : value;
      updateComposerState(state => ({ ...state, attachments: resolved }));
      return resolved;
    });
  }, [updateComposerState]);

  const updatePinnedItems = useCallback((value: PinnedItem[] | ((prev: PinnedItem[]) => PinnedItem[])) => {
    setPinnedItems(prev => {
      const resolved = typeof value === 'function' ? value(prev) : value;
      updateComposerState(state => ({ ...state, pinnedItems: resolved }));
      return resolved;
    });
  }, [updateComposerState]);

  const handleAgentModeChange = useCallback((mode: MainAgentMode) => {
    composerRuntimeSelectionRef.current.agentMode = mode;
    setAgentMode(mode);
    updateComposerState(state => ({ ...state, agentMode: mode }));
  }, [updateComposerState]);

  const handleModelSelectionChange = useCallback((selection: string) => {
    composerRuntimeSelectionRef.current.modelSelection = selection;
    setActiveModelSelection(selection);
    updateComposerState(state => ({ ...state, chatModelSelection: selection }));
  }, [updateComposerState]);

  const handleProxyModelSelectionChange = useCallback((selection: string) => {
    const option = [
      { optionKey: AUTO_MODEL_SELECTION, provider: 'auto' as const, modelId: '' },
      ...proxyModelEntries.map(entry => ({
        optionKey: modelEntryKey(entry.provider, entry.modelId),
        provider: entry.provider,
        modelId: entry.modelId,
      })),
    ].find(candidate => candidate.optionKey === selection);
    if (!option) return;

    setProxyModelSelection(option.optionKey);
  }, [proxyModelEntries]);

  const handleProxyRuntimeModelSelectionChange = useCallback((selection: string) => {
    const valid = selection === AUTO_MODEL_SELECTION || proxyModelEntries.some(entry => modelEntryKey(entry.provider, entry.modelId) === selection);
    if (!valid) return;
    setProxyRuntimeModelSelection(selection);
    try {
      localStorage.setItem(`eterx_proxy_runtime_model_${ activeChatIdRef.current || 'new_chat' }`, selection);
    } catch { }
    const chatId = activeChatIdRef.current;
    if (chatId) {
      fetch('/api/agent/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, action: 'model', modelSelection: selection }),
      }).catch(() => undefined);
    }
  }, [proxyModelEntries]);

  useEffect(() => {
    const refreshProxyModels = () => {
      setProxyModelEntries(readRuntimeModelEntries());
      setContextSettingsRevision(revision => revision + 1);
    };
    window.addEventListener('storage', refreshProxyModels);
    window.addEventListener('focus', refreshProxyModels);
    window.addEventListener('eterx-settings-updated', refreshProxyModels);
    return () => {
      window.removeEventListener('storage', refreshProxyModels);
      window.removeEventListener('focus', refreshProxyModels);
      window.removeEventListener('eterx-settings-updated', refreshProxyModels);
    };
  }, []);
  const [selectedProjectSection, setSelectedProjectSection] = useState('new-tasks');
  const [pendingSteering, setPendingSteering] = useState<{ id: string, text: string, chatId: string }[]>([]);
  const [queuedFollowUps, setQueuedFollowUps] = useState<QueuedFollowUp[]>([]);
  const queuedFollowUpDispatchRef = useRef<Set<string>>(new Set());
  // Admission is scoped per chat. A process-wide latch made a send in chat A
  // silently block chat B until the first request was accepted or timed out.
  const sendAdmissionsRef = useRef<Map<string, number>>(new Map());
  const scheduledTaskRunAdmissionsRef = useRef<Set<string>>(new Set());
  const scheduledTaskIntervalsRef = useRef<Map<string, number>>(new Map());
  const schedulerMountedAtRef = useRef(Date.now());
  const runStartReadinessRef = useRef<Map<string, Promise<void>>>(new Map());
  const stopRequestsRef = useRef<Map<string, Promise<boolean>>>(new Map());
  const steeringAdmissionsRef = useRef<Set<string>>(new Set());
  const queuedFollowUpAdmissionsRef = useRef<Set<string>>(new Set());
  const subAgentSendAdmissionsRef = useRef<Set<string>>(new Set());
  // Per-chat thinking state: Set of chatIds that have running agents
  const [runningChats, setRunningChats] = useState<Set<string>>(new Set());
  const [unreadChatIds, setUnreadChatIds] = useState<Set<string>>(new Set());
  const [traceLogs, setTraceLogs] = useState<any[]>([]);
  const traceLogsLengthRef = useRef(0);
  useEffect(() => {
    traceLogsLengthRef.current = traceLogs.length;
  }, [traceLogs.length]);
  const [greeting, setGreeting] = useState("Initializing...");

  const [chats, setChats] = useState<ChatSession[]>([]);
  const nonBuilderChats = useMemo(() => chats.filter(c => !c.id.startsWith('agent_builder_')), [chats]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [buildingAgentId, setBuildingAgentId] = useState<string | null>(null);

  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [audioVolume, setAudioVolume] = useState<number>(0);
  const [isProcessingVoice, setIsProcessingVoice] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  // Reset scroll-to-bottom button when switching chats or on empty/new chat
  useEffect(() => { setShowScrollBottom(false); }, [activeChatId]);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [chatActionMenuOpen, setChatActionMenuOpen] = useState(false);
  const [isEditingChatTitle, setIsEditingChatTitle] = useState(false);
  const [editingTitleText, setEditingTitleText] = useState("");
  const [headerSearchOpen, setHeaderSearchOpen] = useState(false);
  const [headerSearchQuery, setHeaderSearchQuery] = useState("");
  const [activeView, setActiveViewState] = useState<ActiveView>('chat');
  const [agentMode, setAgentMode] = useState<MainAgentMode>(() => composerRuntimeSelectionRef.current.agentMode);
  const [thinkingLevel, setThinkingLevelState] = useState<MainAgentThinkingLevel>(() => composerRuntimeSelectionRef.current.thinkingLevel);
  const [selectedAgentState, setSelectedAgentState] = useState<SelectedAgentState>(() => composerRuntimeSelectionRef.current.selectedAgent);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(SELECTED_AGENT_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        const agentId = typeof parsed?.agentId === 'string' && parsed.agentId.trim() ? parsed.agentId.trim() : null;
        const agentName = typeof parsed?.agentName === 'string' && parsed.agentName.trim()
          ? parsed.agentName.trim()
          : agentId === 'coding' ? 'Coding' : agentId || 'General';
        setSelectedAgentState({ agentId, agentName });
        return;
      }
      const rawSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
      const settings = rawSettings ? JSON.parse(rawSettings) : null;
      if (settings?.workMode === 'specialist') {
        setSelectedAgentState({ agentId: 'autonomous', agentName: 'Autonomous' });
      }
    } catch {}
  }, []);
  const [proxyEnabled, setProxyEnabled] = useState(true);
  const [proxyIntervention, setProxyIntervention] = useState<'minimal' | 'normal' | 'high'>('normal');
  const [proxyDropdownOpen, setProxyDropdownOpen] = useState(false);
  const [showProxyChat, setShowProxyChat] = useState(false);
  const [proxyChatInput, setProxyChatInput] = useState('');
  const [showProxyModelMenu, setShowProxyModelMenu] = useState(false);
  const [showProxyRuntimeModelMenu, setShowProxyRuntimeModelMenu] = useState(false);
  const [showProxyInterventionMenu, setShowProxyInterventionMenu] = useState(false);
  const [proxyChatMessages, setProxyChatMessages] = useState<Array<{
    id?: string;
    sender: 'user' | 'proxy';
    text: string;
    time: string;
    delivery?: string;
    operation?: string;
    work?: Array<{ text: string; tool: string }>;
  }>>([]);
  const [proxyManagerContext, setProxyManagerContext] = useState<any>(null);
  const [proxyChatHistoryChatId, setProxyChatHistoryChatId] = useState<string | null>(null);
  const [proxyChatLoading, setProxyChatLoading] = useState(false);
  const proxyLoadingChatIdsRef = useRef<Set<string>>(new Set());
  const proxyLiveTurnsRef = useRef<Map<string, ProxyLiveTurn>>(new Map());
  const [proxyLiveTurn, setProxyLiveTurn] = useState<ProxyLiveTurn | null>(null);
  const [proxyChatWindow, setProxyChatWindow] = useState({ x: 0, y: 0, width: 340, height: 460 });
  const [isProxyExpanded, setIsProxyExpanded] = useState(false);
  
  const toggleProxyExpanded = useCallback(() => {
    setIsProxyExpanded(prev => {
      const next = !prev;
      if (next) {
        setProxyChatWindow({ x: 0, y: 0, width: 440, height: 620 });
      } else {
        setProxyChatWindow({ x: 0, y: 0, width: 340, height: 460 });
      }
      return next;
    });
  }, []);
  const proxyChatWindowRef = useRef<HTMLDivElement | null>(null);
  const proxyMessagesEndRef = useRef<HTMLDivElement | null>(null);
  const proxyWindowInteractionRef = useRef<{
    type: 'drag' | 'resize';
    startX: number;
    startY: number;
    startWindow: typeof proxyChatWindow;
    baseLeft0: number;
    baseTop0: number;
    startRect: { left: number; top: number; width: number; height: number };
  } | null>(null);
  const [activeWorkspacePath, setActiveWorkspacePath] = useState<string | null>(null);
  const [activeRunLocation, setActiveRunLocation] = useState<'local' | 'sandbox'>('local');
  const [pinnedItems, setPinnedItems] = useState<PinnedItem[]>([]);
  const [envDropdownOpen, setEnvDropdownOpen] = useState(false);
  const [isHeaderGitRepo, setIsHeaderGitRepo] = useState(false);
  const [githubDropdownOpen, setGithubDropdownOpen] = useState(false);
  const githubDropdownRef = useRef<HTMLDivElement | null>(null);
  const [recentCommits, setRecentCommits] = useState<Array<{ hash: string; msg: string }>>([]);
  const [gitStatusList, setGitStatusList] = useState<Array<{ status: string; path: string }>>([]);
  const [hoveredSubmenu, setHoveredSubmenu] = useState<'branch' | 'commits' | 'status' | null>(null);
  const [isCommitsLoading, setIsCommitsLoading] = useState(false);
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
  const [settingsInitialTab, setSettingsInitialTab] = useState<string>('models');
  const [activeTopbarMenu, setActiveTopbarMenu] = useState<'theme' | 'help' | null>(null);
  const topbarThemeOpen = activeTopbarMenu === 'theme';
  const topbarHelpOpen = activeTopbarMenu === 'help';
  const setTopbarThemeOpen = (v: boolean) => setActiveTopbarMenu(v ? 'theme' : null);
  const setTopbarHelpOpen = (v: boolean) => setActiveTopbarMenu(v ? 'help' : null);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [agentTeamOpen, setAgentTeamOpen] = useState(false);
  const [subAgentDockOpen, setSubAgentDockOpen] = useState(false);
  const [activeSubAgentTab, setActiveSubAgentTab] = useState<string | null>(null);
  const [subAgentOrder, setSubAgentOrder] = useState<string[]>([]);
  const [overflowDropdownOpen, setOverflowDropdownOpen] = useState(false);
  const [petWidgetOpen, setPetWidgetOpen] = useState(false);
  const [nativePetAvailable, setNativePetAvailable] = useState(false);
  const canUseMonitor = activeView === 'chat' && !!activeChatId;
  const closedSidebarDragStartRef = useRef<number | null>(null);
  const closedSidebarDragOpenedRef = useRef(false);
  const dragConstraintsRef = useRef<HTMLDivElement>(null);
  const selectedAgent = selectedAgentState.agentId;
  const selectedAgentName = selectedAgentState.agentName;
  const runningChatsRef = useRef<Set<string>>(new Set());
  // Tracks chats that were explicitly stopped — prevents reconcile from re-adding them during the cleanup window
  const stoppingChatsRef = useRef<Set<string>>(new Set());
  const activeViewRef = useRef<ActiveView>('chat');
  const isNetworkPaused = false;

  // Poll Git repository status, active branch, and list of branches
  useEffect(() => {
    let active = true;
    const checkGitStatus = () => {
      if (!activeWorkspacePath) {
        if (active) {
          setIsHeaderGitRepo(false);
          setCurrentBranch('main');
          setGitBranches([{ name: 'main', uncommitted: null }]);
        }
        return;
      }

      // Get current active branch name
      fetch('/api/code/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'git branch --show-current', cwd: activeWorkspacePath }),
      })
        .then(r => r.json())
        .then(data => {
          if (!active) return;
          if (data.stdout?.trim() && !data.stdout.includes('Sandbox') && !data.stdout.includes(' ') && !data.stdout.includes('error:')) {
            const activeBranch = data.stdout.trim();
            setCurrentBranch(activeBranch);
            setIsHeaderGitRepo(true);

            // Get all local branches
            fetch('/api/code/execute', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ command: 'git branch', cwd: activeWorkspacePath }),
            })
              .then(r2 => r2.json())
              .then(data2 => {
                if (!active) return;
                if (data2.stdout) {
                  const list = data2.stdout
                    .split('\n')
                    .map((b: string) => {
                      let cleaned = b.trim();
                      if (cleaned.startsWith('*')) {
                        cleaned = cleaned.substring(1).trim();
                      }
                      return cleaned;
                    })
                    .filter((b: string) => {
                      return b && !b.includes(' ') && !b.includes('Sandbox') && !b.includes('error:') && !b.includes('fatal:');
                    })
                    .map((name: string) => ({ name, uncommitted: null }));
                  if (list.length > 0) {
                    setGitBranches(list);
                  }
                }
              })
              .catch(() => { });
          } else {
            setIsHeaderGitRepo(false);
            setCurrentBranch('main');
          }
        })
        .catch(() => {
          if (!active) return;
          setIsHeaderGitRepo(false);
          setCurrentBranch('main');
        });
    };

    checkGitStatus();
    const interval = setInterval(checkGitStatus, 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [activeWorkspacePath]);

  // In compact desktop windows the sidebar becomes an overlay at 960px.
  // Close it automatically at the same boundary so the workspace never opens
  // underneath a modal-width navigation panel.
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 960) {
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
  const handleThemeChange = useCallback((newTheme: 'light' | 'dark') => {
    console.log('[ThemeChange] Changing theme to:', newTheme);
    const changeThemeDOM = () => {
      try {
        const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
        const settings = saved ? JSON.parse(saved) : {};
        settings.theme = newTheme;
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));

        // Direct DOM manipulation to ensure instant update
        const root = document.documentElement;
        root.setAttribute('data-theme', newTheme);
        root.classList.toggle('dark', newTheme === 'dark');
        root.classList.toggle('light', newTheme === 'light');
        root.style.colorScheme = newTheme;

        // Sync natively
        (window as any).electronAPI?.setNativeTheme?.(newTheme);

        applyEterxTheme(newTheme);
        broadcastEterxSettingsUpdate(settings);

        window.dispatchEvent(new StorageEvent('storage', { key: SETTINGS_STORAGE_KEY }));
      } catch (err) {
        console.error('[ThemeChange] Error changing theme:', err);
      }
    };

    if (typeof document !== 'undefined' && (document as any).startViewTransition) {
      const rootClass = document.documentElement.classList;
      rootClass.add('theme-transitioning');
      const transition = (document as any).startViewTransition(() => {
        changeThemeDOM();
      });
      transition.finished.then(() => {
        rootClass.remove('theme-transitioning');
      });
    } else {
      changeThemeDOM();
    }
    setTopbarThemeOpen(false);
  }, []);
  const openSettingsWindow = useCallback((tab?: any) => {
    if (tab && typeof tab === 'string') {
      setSettingsInitialTab(tab);
    } else {
      setSettingsInitialTab('general');
    }
    setIsSettingsOpen(true);
  }, [setSettingsInitialTab, setIsSettingsOpen]);

  useEffect(() => {
    const applyStoredAgentMode = () => {
      const composerKey = activeChatIdRef.current || 'new_chat';
      if (composerStatesRef.current[composerKey]) return;
      const storedMode = readStoredMainAgentMode();
      if (storedMode) {
        composerRuntimeSelectionRef.current.agentMode = storedMode;
        setAgentMode(currentMode => currentMode === storedMode ? currentMode : storedMode);
      }
    };

    const applyStoredSettings = () => {
      applyStoredAgentMode();
    };

    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === SETTINGS_STORAGE_KEY) applyStoredSettings();
    };

    applyStoredSettings();
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', applyStoredSettings);
    window.addEventListener('eterx-settings-updated', applyStoredSettings);

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(SETTINGS_CHANNEL);
      channel.onmessage = applyStoredSettings;
    } catch {
      channel = null;
    }

    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', applyStoredSettings);
      window.removeEventListener('eterx-settings-updated', applyStoredSettings);
      channel?.close();
    };
  }, [updateComposerState]);

  // ═══ Gemini Live Session State ═══
  const [liveState, setLiveState] = useState<LiveSessionState>('idle');
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveOutputText, setLiveOutputText] = useState('');
  const [liveInputText, setLiveInputText] = useState('');
  const [liveSpokenText, setLiveSpokenText] = useState('');
  const [liveCommands, setLiveCommands] = useState<any[]>([]);
  const liveInputTextRef = useRef('');
  const liveOutputTextRef = useRef('');
  const liveCommandsRef = useRef<any[]>([]);
  const liveRichResponseRef = useRef<string | null>(null);
  const liveTurnIdRef = useRef<string | null>(null);
  // A live-frame snapshot is only valid for the turn that produced it. Clear it
  // synchronously whenever navigation or a regular send starts so a previous
  // answer/tool sequence can never be rendered beneath the next user message.
  const lastLiveLogsSnapshotRef = useRef<{
    chatId: string | null;
    turnId: string | null;
    commitKey: string | null;
    logs: any[];
  }>({
    chatId: null,
    turnId: null,
    commitKey: null,
    logs: [],
  });
  const [liveMicVolume, setLiveMicVolume] = useState(0);
  const [liveModelVolume, setLiveModelVolume] = useState<number | number[]>(0);
  const [liveActiveTool, setLiveActiveTool] = useState<string | null>(null);
  const [liveMicMuted, setLiveMicMuted] = useState(false);
  const [liveSpeakerMuted, setLiveSpeakerMuted] = useState(false);
  const [liveCameraEnabled, setLiveCameraEnabled] = useState(false);
  const [liveScreenShareEnabled, setLiveScreenShareEnabled] = useState(false);
  const [liveActivityLabel, setLiveActivityLabel] = useState<string | null>(null);
  const [liveMission, setLiveMission] = useState<LiveMissionState | null>(null);
  const liveMissionRef = useRef<LiveMissionState | null>(null);
  const liveActiveActivityIdRef = useRef<string | null>(null);
  const liveSessionRef = useRef<GeminiLiveSession | null>(null);
  const liveSessionTokenRef = useRef<string | null>(null);
  const liveCommitTurnRef = useRef<((userText: string, modelText: string, commands: any[]) => void) | null>(null);
  const liveProgressAnnouncementAtRef = useRef<Map<string, number>>(new Map());
  const liveMainDispatchRef = useRef(false);
  const liveChatIdRef = useRef<string | null>(null);
  const [liveChatId, setLiveChatId] = useState<string | null>(null);
  const liveEphemeralChatIdRef = useRef<string | null>(null);
  const liveConversationRef = useRef<{ role: string; text: string }[]>([]);

  // Derived: isThinking for CURRENT active chat only
  const isLiveSessionActive =
    activeChatId !== null &&
    activeChatId === liveChatId &&
    liveState !== 'idle' &&
    liveState !== 'error';
  const hasBackgroundLiveSession =
    liveChatId !== null &&
    activeChatId !== liveChatId &&
    liveState !== 'idle' &&
    liveState !== 'error';

  const updateLiveMission = useCallback((
    updater: (mission: LiveMissionState | null) => LiveMissionState | null
  ) => {
    setLiveMission(previous => {
      const next = updater(previous);
      liveMissionRef.current = next;
      return next;
    });
  }, []);

  const upsertLiveMissionEntry = useCallback((entry: LiveMissionEntry) => {
    updateLiveMission(previous => {
      const base: LiveMissionState = previous || {
        id: `mission_${crypto.randomUUID()}`,
        goal: liveInputTextRef.current.trim() || 'Coordinate the requested work',
        entries: [],
        updatedAt: Date.now(),
      };
      const existingIndex = base.entries.findIndex(item => item.id === entry.id);
      const entries = existingIndex >= 0 ? [...base.entries] : [...base.entries, entry];
      if (existingIndex >= 0) entries[existingIndex] = { ...entries[existingIndex], ...entry };
      return {
        ...base,
        entries: entries.slice(-16),
        updatedAt: Date.now(),
      };
    });
  }, [updateLiveMission]);

  const syncLiveMissionTask = useCallback((
    chatId: string,
    label: string,
    detail: string,
    status: LiveMissionEntry['status'],
  ) => {
    updateLiveMission(previous => {
      const base: LiveMissionState = previous || {
        id: `mission_${crypto.randomUUID()}`,
        goal: liveInputTextRef.current.trim() || 'Coordinate the requested work',
        entries: [],
        updatedAt: Date.now(),
      };
      const existingIndex = base.entries.findIndex(entry =>
        entry.kind === 'task' && entry.chatId === chatId
      );
      const existing = existingIndex >= 0 ? base.entries[existingIndex] : null;
      const nextEntry: LiveMissionEntry = {
        id: existing?.id || `task_${chatId}`,
        kind: 'task',
        label: String(label || existing?.label || 'Background task').slice(0, 120),
        detail: String(detail || existing?.detail || '').slice(0, 260) || undefined,
        status,
        chatId,
        updatedAt: Date.now(),
      };
      const entries = [...base.entries];
      if (existingIndex >= 0) entries[existingIndex] = nextEntry;
      else entries.push(nextEntry);
      return { ...base, entries: entries.slice(-16), updatedAt: Date.now() };
    });
  }, [updateLiveMission]);

  useEffect(() => {
    const snapshot = lastLiveLogsSnapshotRef.current;
    if (snapshot.chatId && snapshot.chatId !== activeChatId) {
      lastLiveLogsSnapshotRef.current = {
        chatId: null,
        turnId: null,
        commitKey: null,
        logs: [],
      };
    }
  }, [activeChatId]);
  const isThinking = (activeChatId ? runningChats.has(activeChatId) : false);
  const sidebarRunningChats = useMemo(() => {
    if (!liveChatId || liveState === 'idle' || liveState === 'error') return runningChats;
    const visibleRuns = new Set(runningChats);
    visibleRuns.add(liveChatId);
    return visibleRuns;
  }, [runningChats, liveChatId, liveState]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
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
  const pendingTitleRequestsRef = useRef<Map<string, {
    history: any[];
    currentTitle: string;
    mode: MainAgentMode;
  }>>(new Map());
  // Invalidates in-flight poll callbacks when a poller is restarted or stopped.
  const pollGenerationRef = useRef<Map<string, number>>(new Map());
  const backgroundChatUpdatesRef = useRef<Map<string, Array<(logs: any[]) => any[]>>>(new Map());
  const backgroundUpdateTimerRef = useRef<number | null>(null);
  // CRITICAL: Ref for activeChatId so polling closures always see the latest value
  const activeChatIdRef = useRef<string | null>(null);
  const localStorageTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingLocalStorageWrite = useRef(false);
  const lastChatSnapshotAtRef = useRef(0);
  const persistedChatSignaturesRef = useRef<Map<string, string>>(new Map());
  const chatSnapshotReadyRef = useRef(false);
  const pendingChatDeletionIdsRef = useRef<Set<string>>(new Set());
  const hydratedChatIdsRef = useRef<Set<string>>(new Set());
  const chatDetailRequestsRef = useRef<Map<string, Promise<void>>>(new Map());
  const chatsRef = useRef<ChatSession[]>([]);
  const restoredActiveChatRef = useRef(false);
  const panelResizeCleanupRef = useRef<(() => void) | null>(null);
  // Keep ref synced with state
  activeChatIdRef.current = activeChatId;
  chatsRef.current = chats;
  activeViewRef.current = activeView;
  runningChatsRef.current = runningChats;
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

  useEffect(() => {
    if (activeChatId && activeView === 'chat') {
      clearUnreadChat(activeChatId);
    }
  }, [activeChatId, activeView, clearUnreadChat]);

  // Real-time scheduled tasks background runner
  useEffect(() => {
    const checkTasks = () => {
      try {
        const raw = localStorage.getItem('eterx_scheduled_tasks');
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const tasks: ScheduledTaskRecord[] = Array.isArray(parsed) ? parsed.map(normalizeScheduledTask) : [];
        const now = Date.now();
        let updated = false;
        const dueTasks: ScheduledTaskRecord[] = [];

        tasks.forEach(task => {
          if (task.status === 'scheduled' && now >= task.scheduledTimestamp) {
            task.status = 'queued';
            task.updatedAt = now;
            updated = true;
            dueTasks.push(task);
          } else if (task.status === 'queued' && now >= task.scheduledTimestamp) {
            dueTasks.push(task);
          } else if (
            task.status === 'running' &&
            task.chatId &&
            now - schedulerMountedAtRef.current > 30_000 &&
            !runningChatsRef.current.has(task.chatId)
          ) {
            const latestRun = task.history?.[task.history.length - 1];
            if (latestRun && now - latestRun.startedAt > 2 * 60 * 1000) {
              latestRun.status = 'failed';
              latestRun.completedAt = now;
              latestRun.error = 'The app restarted before this scheduled run could be reattached. Review its chat before running it again.';
              task.status = 'failed';
              task.updatedAt = now;
              task.lastError = latestRun.error;
              updated = true;
            }
          }
        });

        if (updated) {
          localStorage.setItem('eterx_scheduled_tasks', JSON.stringify(tasks));
          window.dispatchEvent(new CustomEvent('eterx_scheduled_tasks_updated'));
        }
        dueTasks.forEach(task => {
          window.dispatchEvent(new CustomEvent('eterx_trigger_scheduled_task', { detail: { task } }));
        });
      } catch { }
    };

    checkTasks();
    const interval = setInterval(checkTasks, 5000);
    return () => clearInterval(interval);
  }, []);



  const revealNetworkBanner = useCallback(() => {
    // Connectivity is not an execution gate; this callback remains a no-op for
    // compatibility with child components that still expose the old action.
  }, []);

  const dismissNetworkBanner = useCallback(() => {
    // Kept as a compatibility no-op for existing callers.
  }, []);

  useEffect(() => {
    setNativePetAvailable(!!(window as any).electronAPI?.openPetWindow);
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
        const restoredLevel = normalizeMainAgentThinkingLevel(savedThinkingLevel);
        composerRuntimeSelectionRef.current.thinkingLevel = restoredLevel;
        setThinkingLevelState(restoredLevel);
      }
    } catch { }
  }, []);

  const setThinkingLevel = useCallback((level: MainAgentThinkingLevel) => {
    const safeLevel = normalizeMainAgentThinkingLevel(level);
    composerRuntimeSelectionRef.current.thinkingLevel = safeLevel;
    setThinkingLevelState(safeLevel);
    updateComposerState(state => ({ ...state, thinkingLevel: safeLevel }));
    try {
      localStorage.setItem(MAIN_AGENT_THINKING_LEVEL_STORAGE_KEY, safeLevel);
    } catch { }
  }, [updateComposerState]);

  const handleAgentChange = useCallback((agentId: string | null, agentName: string) => {
    const next: SelectedAgentState = {
      agentId: agentId?.trim() ? agentId.trim() : null,
      agentName: agentId?.trim() ? (agentName?.trim() || agentId.trim()) : 'General',
    };
    composerRuntimeSelectionRef.current.selectedAgent = next;
    setSelectedAgentState(next);
    // A sub-agent tab belongs to the previously selected main agent. Keeping it
    // selected after changing the main agent makes the composer and timeline
    // point at two different runtimes.
    setActiveSubAgentTab(null);
    setSubAgentDockOpen(false);
    setOverflowDropdownOpen(false);
    setAgentTeamOpen(false);
    updateComposerState(state => ({ ...state, selectedAgent: next }));
    try {
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, JSON.stringify(next));
    } catch { }
  }, [updateComposerState]);

  const updateProxyControl = useCallback(async (action: 'pause' | 'resume' | 'intervention', level?: 'minimal' | 'normal' | 'high') => {
    if (!activeChatId) return false;
    try {
      const response = await fetch('/api/agent/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: activeChatId, action, level }),
      });
      return response.ok && Boolean((await response.json().catch(() => ({}))).success);
    } catch {
      return false;
    }
  }, [activeChatId]);

  const handleProxyToggle = useCallback(async () => {
    const nextEnabled = !proxyEnabled;
    setProxyEnabled(nextEnabled);
    try { localStorage.setItem(`eterx_proxy_controls_${ activeChatId || 'new_chat' }`, JSON.stringify({ enabled: nextEnabled, intervention: proxyIntervention })); } catch { }
    if (activeChatId) await updateProxyControl(nextEnabled ? 'resume' : 'pause');
  }, [activeChatId, proxyEnabled, proxyIntervention, updateProxyControl]);

  const handleProxyInterventionChange = useCallback(async (level: 'minimal' | 'normal' | 'high') => {
    const previousLevel = proxyIntervention;
    setProxyIntervention(level);
    try { localStorage.setItem(`eterx_proxy_controls_${ activeChatId || 'new_chat' }`, JSON.stringify({ enabled: proxyEnabled, intervention: level })); } catch { }
    if (activeChatId && !await updateProxyControl('intervention', level)) {
      setProxyIntervention(previousLevel);
      try { localStorage.setItem(`eterx_proxy_controls_${ activeChatId }`, JSON.stringify({ enabled: proxyEnabled, intervention: previousLevel })); } catch { }
    }
  }, [activeChatId, proxyEnabled, proxyIntervention, updateProxyControl]);

  useEffect(() => {
    const key = `eterx_proxy_controls_${ activeChatId || 'new_chat' }`;
    try {
      const saved = JSON.parse(localStorage.getItem(key) || '{}');
      setProxyEnabled(saved.enabled !== false);
      setProxyIntervention(['minimal', 'normal', 'high'].includes(saved.intervention) ? saved.intervention : 'normal');
    } catch {
      setProxyEnabled(true);
      setProxyIntervention('normal');
    }
  }, [activeChatId]);

  useEffect(() => {
    if (!showProxyChat || !activeChatId) return;
    const targetChatId = activeChatId;
    let cancelled = false;
    const refreshProxyContext = async () => {
      try {
        const response = await fetch(`/api/agent/proxy-manager?chatId=${encodeURIComponent(targetChatId)}`, {
          cache: 'no-store',
        });
        const data = response.ok ? await response.json() : null;
        if (cancelled || activeChatIdRef.current !== targetChatId || !data?.context) return;
        setProxyManagerContext(data.context);
      } catch { }
    };
    void refreshProxyContext();
    const interval = window.setInterval(refreshProxyContext, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeChatId, showProxyChat]);

  useEffect(() => {
    try {
      setProxyRuntimeModelSelection(localStorage.getItem(`eterx_proxy_runtime_model_${ activeChatId || 'new_chat' }`) || AUTO_MODEL_SELECTION);
    } catch {
      setProxyRuntimeModelSelection(AUTO_MODEL_SELECTION);
    }
  }, [activeChatId]);

  const proxyCardRef = useRef<HTMLDivElement>(null);
  const proxyModelMenuRef = useRef<HTMLDivElement>(null);
  const proxyAttachMenuRef = useRef<HTMLDivElement>(null);
  const [proxyAttachments, setProxyAttachments] = useState<ComposerAttachment[]>([]);
  const [customInputHeight, setCustomInputHeight] = useState<number | null>(null);

  const startInputHeightResize = useCallback((downEvent: React.PointerEvent) => {
    downEvent.preventDefault();
    const startY = downEvent.clientY;
    const startHeight = customInputHeight || 36;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const dy = startY - moveEvent.clientY;
      const newHeight = Math.max(32, Math.min(360, startHeight + dy));
      setCustomInputHeight(newHeight);
    };

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }, [customInputHeight]);
  const [proxyPinnedItems, setProxyPinnedItems] = useState<{ name: string; isFolder?: boolean; path?: string }[]>([]);
  const proxyFileInputRef = useRef<HTMLInputElement>(null);
  const proxyPinInputRef = useRef<HTMLInputElement>(null);

  const handleProxyFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const newAtts: ComposerAttachment[] = files.map(file => ({
      id: `proxy-att-${Date.now()}-${Math.random()}`,
      file,
      name: file.name,
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : '',
    }));
    setProxyAttachments(prev => [...prev, ...newAtts]);
    if (event.target) event.target.value = '';
  };

  const handleProxyPinSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const newPins = files.map(file => {
      const relPath = (file as any).webkitRelativePath || file.name;
      const parts = relPath.split('/');
      const name = parts.length > 1 ? parts[0] : file.name;
      return {
        name,
        isFolder: parts.length > 1,
        path: (file as any).path || relPath || file.name,
      };
    });
    setProxyPinnedItems(prev => {
      const existing = new Set(prev.map(p => p.path || p.name));
      const added = newPins.filter(p => !existing.has(p.path || p.name));
      return [...prev, ...added];
    });
    if (event.target) event.target.value = '';
  };

  const handleProxyTakeScreenshot = async () => {
    try {
      const canvas = document.createElement('canvas');
      const w = window.innerWidth || 1280;
      const h = window.innerHeight || 800;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#181818';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#252525';
        ctx.fillRect(40, 40, w - 80, h - 80);
        ctx.font = '16px sans-serif';
        ctx.fillStyle = '#888';
        ctx.fillText('App Screenshot Preview', 60, 80);
      }
      const dataUrl = canvas.toDataURL('image/png');
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const file = new File([blob], `screenshot_${Date.now()}.png`, { type: 'image/png' });
      setProxyAttachments(prev => [
        ...prev,
        {
          id: `proxy-att-${Date.now()}-${Math.random()}`,
          file,
          name: file.name,
          preview: dataUrl,
        }
      ]);
    } catch (e) { }
  };

  useEffect(() => {
    if (!showProxyRuntimeModelMenu && !showProxyInterventionMenu && !showProxyModelMenu && !showProxyAttachMenu) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (proxyCardRef.current && !proxyCardRef.current.contains(target)) {
        setShowProxyRuntimeModelMenu(false);
        setShowProxyInterventionMenu(false);
      }
      if (proxyModelMenuRef.current && !proxyModelMenuRef.current.contains(target)) {
        setShowProxyModelMenu(false);
      }
      if (proxyAttachMenuRef.current && !proxyAttachMenuRef.current.contains(target)) {
        setShowProxyAttachMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showProxyRuntimeModelMenu, showProxyInterventionMenu, showProxyModelMenu, showProxyAttachMenu]);


  useEffect(() => {
    if (!activeChatId) {
      setProxyChatMessages([]);
      setProxyChatHistoryChatId(null);
      setProxyModelSelection(AUTO_MODEL_SELECTION);
      setProxyManagerContext(null);
      setProxyLiveTurn(null);
      return;
    }
    setProxyChatMessages([]);
    setProxyChatHistoryChatId(null);
    setProxyChatInput('');
    setShowProxyModelMenu(false);
    setShowProxyRuntimeModelMenu(false);
    setShowProxyInterventionMenu(false);
    setProxyChatLoading(proxyLoadingChatIdsRef.current.has(activeChatId));
    setProxyLiveTurn(proxyLiveTurnsRef.current.get(activeChatId) || null);
    try {
      setProxyModelSelection(localStorage.getItem(`eterx_proxy_manager_model_${ activeChatId }`) || AUTO_MODEL_SELECTION);
    } catch { setProxyModelSelection(AUTO_MODEL_SELECTION); }
    let cancelled = false;
    fetch(`/api/agent/proxy-manager?chatId=${ encodeURIComponent(activeChatId) }`)
      .then(response => response.ok ? response.json() : Promise.reject(new Error('history unavailable')))
      .then(data => {
        if (cancelled) return;
        if (data.control && typeof data.control === 'object') {
          setProxyEnabled(data.control.enabled !== false);
          if (['minimal', 'normal', 'high'].includes(data.control.intervention)) {
            setProxyIntervention(data.control.intervention);
          }
          if (typeof data.control.modelSelection === 'string' && data.control.modelSelection) {
            setProxyRuntimeModelSelection(data.control.modelSelection);
          }
        }
        setProxyManagerContext(data.context || null);
        setProxyChatMessages((Array.isArray(data.messages) ? data.messages : []).map((item: any) => ({
          id: String(item.id || ''),
          sender: item.role === 'user' ? 'user' : 'proxy',
          text: String(item.text || ''),
          time: new Date(Number(item.createdAt || Date.now())).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          delivery: item.delivery,
          operation: item.operation,
          work: Array.isArray(item.work) ? item.work : [],
        })));
        setProxyChatHistoryChatId(activeChatId);
      })
      .catch(() => { if (!cancelled) setProxyChatMessages([]); });
    return () => { cancelled = true; };
  }, [activeChatId]);

  useEffect(() => {
    if (!activeChatId) return;
    try { localStorage.setItem(`eterx_proxy_manager_model_${ activeChatId }`, proxyModelSelection); } catch { }
  }, [activeChatId, proxyModelSelection]);

  const visibleProxyChatMessages = proxyChatHistoryChatId === activeChatId ? proxyChatMessages : [];

  useEffect(() => {
    if (!showProxyChat) return;
    const frame = window.requestAnimationFrame(() => {
      proxyMessagesEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeChatId, proxyChatLoading, proxyChatMessages.length, proxyLiveTurn?.events.length, showProxyChat]);

  const handleSendProxyMessage = useCallback(async () => {
    const rawText = proxyChatInput.trim();
    const hasAttachments = proxyAttachments.length > 0 || proxyPinnedItems.length > 0;
    if (
      (!rawText && !hasAttachments) ||
      !activeChatId ||
      proxyChatLoading ||
      proxyLoadingChatIdsRef.current.has(activeChatId)
    ) return;
    const requestChatId = activeChatId;
    proxyLoadingChatIdsRef.current.add(requestChatId);
    setProxyChatLoading(true);

    const attachmentContextParts = await Promise.all(proxyAttachments.map(async attachment => {
      const file = attachment.file;
      const name = attachment.name || file?.name || 'attachment';
      const localPath = (attachment as any).localPath || (file as any)?.path;
      const metadata = `${name} (${file?.type || 'application/octet-stream'}, ${Number(file?.size || 0)} bytes)`;
      if (localPath) return `${metadata}\nLocal path: ${localPath}`;
      const isReadableText =
        file &&
        (
          file.type.startsWith('text/') ||
          /\.(?:txt|md|json|ya?ml|csv|tsv|js|jsx|ts|tsx|css|html|xml|py|java|go|rs|sql|sh|ps1)$/i.test(name)
        );
      if (!isReadableText) return metadata;
      try {
        const content = (await file.text()).slice(0, 12000);
        return `${metadata}\nContent:\n${content}`;
      } catch {
        return metadata;
      }
    }));
    proxyPinnedItems.forEach(item => {
      attachmentContextParts.push(
        `${item.isFolder ? 'Pinned folder' : 'Pinned item'}: ${item.name}${(item as any).path ? `\nLocal path: ${(item as any).path}` : ''}`,
      );
    });
    const attachmentContext = attachmentContextParts.join('\n\n').slice(0, 24000);

    let fullText = rawText;
    if (proxyPinnedItems.length > 0) {
      const pinNames = proxyPinnedItems.map(p => `📌 ${p.name}`).join(', ');
      fullText = fullText ? `${fullText}\n\n${pinNames}` : pinNames;
    }
    if (proxyAttachments.length > 0) {
      const attNames = proxyAttachments.map(a => `📎 ${a.name || 'attachment'}`).join(', ');
      fullText = fullText ? `${fullText}\n\n${attNames}` : attNames;
    }

    const optimisticId = crypto.randomUUID();
    setProxyChatHistoryChatId(requestChatId);
    setProxyChatMessages(prev => [...prev, {
      id: optimisticId,
      sender: 'user',
      text: fullText,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }]);

    setProxyChatInput('');
    setProxyAttachments([]);
    setProxyPinnedItems([]);
    const liveTurn: ProxyLiveTurn = {
      chatId: requestChatId,
      turnId: optimisticId,
      events: [],
    };
    proxyLiveTurnsRef.current.set(requestChatId, liveTurn);
    setProxyLiveTurn(liveTurn);

    const parsedModel = parseModelEntryKey(proxyModelSelection);
    const applyProxyProgress = (event: ProxyLiveTurn['events'][number]) => {
      const current = proxyLiveTurnsRef.current.get(requestChatId);
      if (!current || current.turnId !== optimisticId) return;
      const previous = current.events[current.events.length - 1];
      if (previous?.text === event.text && previous?.phase === event.phase) return;
      const next = { ...current, events: [...current.events, event].slice(-24) };
      proxyLiveTurnsRef.current.set(requestChatId, next);
      if (activeChatIdRef.current === requestChatId) setProxyLiveTurn(next);
    };
    try {
      const response = await fetch('/api/agent/proxy-manager', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: requestChatId,
          message: fullText,
          attachmentContext,
          model: parsedModel || {},
          stream: true,
        }),
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        throw new Error(failure.error || 'Proxy Manager request failed');
      }
      let data: any = {};
      const contentType = response.headers.get('content-type') || '';
      if (response.body && contentType.includes('application/x-ndjson')) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = '';
        const processLine = (line: string) => {
          if (!line.trim()) return;
          const event = JSON.parse(line);
          if (event.type === 'progress' && event.progress) {
            applyProxyProgress(event.progress);
          } else if (event.type === 'complete') {
            data = { success: true, ...(event.result || {}), context: event.context };
          } else if (event.type === 'error') {
            throw new Error(event.error || 'Proxy Manager request failed');
          }
        };
        while (true) {
          const chunk = await reader.read();
          buffered += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
          const lines = buffered.split('\n');
          buffered = lines.pop() || '';
          lines.forEach(processLine);
          if (chunk.done) break;
        }
        if (buffered.trim()) processLine(buffered);
      } else {
        data = await response.json().catch(() => ({}));
      }
      if (!response.ok || !data.success) throw new Error(data.error || 'Proxy Manager request failed');
      const historyArr = Array.isArray(data.history) ? data.history : [];
      if (activeChatIdRef.current === requestChatId) {
        setProxyManagerContext(data.context || null);
        if (historyArr.length > 0) {
        // Full history from server — replace list (canonical source of truth)
        setProxyChatMessages(historyArr.map((item: any) => ({
          id: String(item.id || ''),
          sender: item.role === 'user' ? 'user' : 'proxy',
          text: String(item.text || ''),
          time: new Date(Number(item.createdAt || Date.now())).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          delivery: item.delivery,
          operation: item.operation,
          work: Array.isArray(item.work) ? item.work : [],
        })));
        } else if (data.reply) {
        // Server returned only the reply (no full history) — append it
        setProxyChatMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          sender: 'proxy' as const,
          text: String(data.reply || ''),
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        }]);
        }
      }
      if (data.wakeRequested) {
        const connectProxyRun = async (attempt = 0) => {
          try {
            const poll = await fetchAgentPoll(requestChatId, -1, 5000);
            if (poll.status !== 'running') {
              if (attempt < 11) window.setTimeout(() => connectProxyRun(attempt + 1), 500);
              return;
            }
            setRunningChats(previous => new Set(previous).add(requestChatId));
            if (poll.traces?.length) {
              setChatLogsById(requestChatId, previous => mergeServerRunLogs(previous, poll.traces, {
                runId: poll.runId,
                startedAt: poll.startedAt,
              }));
            }
            startPolling(requestChatId, poll.maxIndex ?? (poll.totalTraces - 1), poll.startedAt, poll.runId);
          } catch {
            if (attempt < 11) window.setTimeout(() => connectProxyRun(attempt + 1), 700);
          }
        };
        window.setTimeout(() => connectProxyRun(), 250);
      }
      // else: server sent empty history + no reply → keep optimistic user msg
    } catch (error: any) {
      if (activeChatIdRef.current === requestChatId) {
        setProxyChatMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          sender: 'proxy',
          text: String(error?.message || 'Proxy Manager is temporarily unavailable.'),
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          delivery: 'unavailable',
        }]);
      }
    } finally {
      proxyLoadingChatIdsRef.current.delete(requestChatId);
      if (proxyLiveTurnsRef.current.get(requestChatId)?.turnId === optimisticId) {
        proxyLiveTurnsRef.current.delete(requestChatId);
      }
      if (activeChatIdRef.current === requestChatId) {
        setProxyLiveTurn(null);
        setProxyChatLoading(false);
      }
    }
  }, [activeChatId, proxyAttachments, proxyChatInput, proxyChatLoading, proxyModelSelection, proxyPinnedItems]);

  const handleProxyWindowPointerMove = useCallback((event: PointerEvent) => {
    const interaction = proxyWindowInteractionRef.current;
    if (!interaction) return;
    const dx = event.clientX - interaction.startX;
    const dy = event.clientY - interaction.startY;

    const containerRect = splitContainerRef.current?.getBoundingClientRect();

    if (interaction.type === 'drag') {
      const { baseLeft0, baseTop0, startRect } = interaction;
      const targetLeft = startRect.left + dx;
      const targetTop = startRect.top + dy;

      const boundaryMinLeft = (containerRect ? containerRect.left : 0) + 12;
      const boundaryMaxLeft = (containerRect ? containerRect.right : window.innerWidth) - startRect.width - 12;
      const boundaryMinTop = (containerRect ? containerRect.top : 0) + 12;
      const boundaryMaxTop = (containerRect ? containerRect.bottom : window.innerHeight) - startRect.height - 12;

      const clampedLeft = Math.max(boundaryMinLeft, Math.min(Math.max(boundaryMinLeft, boundaryMaxLeft), targetLeft));
      const clampedTop = Math.max(boundaryMinTop, Math.min(Math.max(boundaryMinTop, boundaryMaxTop), targetTop));

      setProxyChatWindow(current => ({
        ...current,
        x: clampedLeft - baseLeft0,
        y: clampedTop - baseTop0,
      }));
    } else {
      const { baseLeft0, baseTop0, startRect } = interaction;
      const containerRight = containerRect ? containerRect.right : window.innerWidth;
      const containerBottom = containerRect ? containerRect.bottom : window.innerHeight;
      const maxWidth = Math.max(280, containerRight - startRect.left - 12);
      const maxHeight = Math.max(320, containerBottom - startRect.top - 12);

      const nextWidth = Math.max(280, Math.min(580, maxWidth, startRect.width + dx));
      const nextHeight = Math.max(320, Math.min(740, maxHeight, startRect.height + dy));

      const boundaryMinLeft = (containerRect ? containerRect.left : 0) + 12;
      const boundaryMaxLeft = containerRight - nextWidth - 12;
      const boundaryMinTop = (containerRect ? containerRect.top : 0) + 12;
      const boundaryMaxTop = containerBottom - nextHeight - 12;

      const clampedLeft = Math.max(boundaryMinLeft, Math.min(Math.max(boundaryMinLeft, boundaryMaxLeft), startRect.left));
      const clampedTop = Math.max(boundaryMinTop, Math.min(Math.max(boundaryMinTop, boundaryMaxTop), startRect.top));

      setProxyChatWindow(current => ({
        ...current,
        width: nextWidth,
        height: nextHeight,
        x: clampedLeft - baseLeft0,
        y: clampedTop - baseTop0,
      }));
    }
  }, []);

  const handleProxyWindowPointerUp = useCallback(() => {
    proxyWindowInteractionRef.current = null;
  }, []);

  useEffect(() => {
    if (!showProxyChat) return;
    const clampProxyWindowToBounds = () => {
      const rect = proxyChatWindowRef.current?.getBoundingClientRect();
      if (!rect) return;
      const baseLeft0 = rect.left - proxyChatWindow.x;
      const baseTop0 = rect.top - proxyChatWindow.y;

      const containerRect = splitContainerRef.current?.getBoundingClientRect();
      const boundaryMinLeft = (containerRect ? containerRect.left : 0) + 12;
      const boundaryMaxLeft = (containerRect ? containerRect.right : window.innerWidth) - rect.width - 12;
      const boundaryMinTop = (containerRect ? containerRect.top : 0) + 12;
      const boundaryMaxTop = (containerRect ? containerRect.bottom : window.innerHeight) - rect.height - 12;

      const clampedLeft = Math.max(boundaryMinLeft, Math.min(Math.max(boundaryMinLeft, boundaryMaxLeft), rect.left));
      const clampedTop = Math.max(boundaryMinTop, Math.min(Math.max(boundaryMinTop, boundaryMaxTop), rect.top));

      const nextX = clampedLeft - baseLeft0;
      const nextY = clampedTop - baseTop0;

      if (Math.abs(nextX - proxyChatWindow.x) > 0.5 || Math.abs(nextY - proxyChatWindow.y) > 0.5) {
        setProxyChatWindow(current => ({
          ...current,
          x: nextX,
          y: nextY,
        }));
      }
    };

    const timerId = setTimeout(clampProxyWindowToBounds, 40);
    window.addEventListener('resize', clampProxyWindowToBounds);
    return () => {
      clearTimeout(timerId);
      window.removeEventListener('resize', clampProxyWindowToBounds);
    };
  }, [showProxyChat, proxyChatWindow.x, proxyChatWindow.y, proxyChatWindow.width, proxyChatWindow.height]);

  useEffect(() => {
    window.addEventListener('pointermove', handleProxyWindowPointerMove);
    window.addEventListener('pointerup', handleProxyWindowPointerUp);
    return () => {
      window.removeEventListener('pointermove', handleProxyWindowPointerMove);
      window.removeEventListener('pointerup', handleProxyWindowPointerUp);
    };
  }, [handleProxyWindowPointerMove, handleProxyWindowPointerUp]);

  const startProxyWindowInteraction = useCallback((type: 'drag' | 'resize', event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = proxyChatWindowRef.current?.getBoundingClientRect();
    if (!rect) return;
    proxyWindowInteractionRef.current = {
      type,
      startX: event.clientX,
      startY: event.clientY,
      startWindow: proxyChatWindow,
      baseLeft0: rect.left - proxyChatWindow.x,
      baseTop0: rect.top - proxyChatWindow.y,
      startRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    };
  }, [proxyChatWindow]);

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

  const discardEphemeralLiveRoom = useCallback((chatId: string | null) => {
    if (!chatId || liveEphemeralChatIdRef.current !== chatId) return;
    liveEphemeralChatIdRef.current = null;
    lastLiveLogsSnapshotRef.current = { chatId: null, turnId: null, commitKey: null, logs: [] };
    setChats(previous => {
      const updated = removeGeneratedEmptyChats(previous);
      if (updated.length === previous.length) return previous;
      persistChats(updated);
      return updated;
    });
    if (activeChatIdRef.current === chatId) {
      activeChatIdRef.current = null;
      setActiveChatId(null);
      setTraceLogs([]);
    }
  }, []);

  const startLiveSession = useCallback(async () => {
    if (activeChatId && runningChatsRef.current.has(activeChatId)) return;

    const sessionToken = crypto.randomUUID();
    liveSessionTokenRef.current = sessionToken;

    if (liveSessionRef.current) {
      liveSessionRef.current.disconnect();
      liveSessionRef.current = null;
    }

    setLiveState('connecting');
    setLiveError(null);
    setLiveOutputText('');
    setLiveInputText('');
    setLiveSpokenText('');
    setLiveCommands([]);
    setLiveActiveTool(null);
    setLiveActivityLabel(null);
    setLiveMission(null);
    liveMissionRef.current = null;
    liveActiveActivityIdRef.current = null;
    setLiveCameraEnabled(false);
    setLiveScreenShareEnabled(false);
    setLiveMicVolume(0);
    setLiveModelVolume(0);
    liveInputTextRef.current = '';
    liveOutputTextRef.current = '';
    liveCommandsRef.current = [];
    liveTurnIdRef.current = null;
    liveConversationRef.current = [];
    lastLiveLogsSnapshotRef.current = { chatId: null, turnId: null, commitKey: null, logs: [] };

    let currentChatId = activeChatId;
    const selectedChat = currentChatId
      ? chatsRef.current.find(chat => chat.id === currentChatId)
      : null;
    // A new live room stays ephemeral until its first real turn. Persisting it
    // here leaves empty "Live Conversation" rows behind after disconnects.
    if (!currentChatId || !selectedChat || isGeneratedEmptyChat(selectedChat)) {
      if (selectedChat && isGeneratedEmptyChat(selectedChat)) {
        setChats(previous => {
          const updated = previous.filter(chat => chat.id !== selectedChat.id);
          persistChats(updated);
          return updated;
        });
      }
      currentChatId = crypto.randomUUID();
      liveEphemeralChatIdRef.current = currentChatId;
      activeChatIdRef.current = currentChatId;
      setActiveChatId(currentChatId);
      setTraceLogs([]);
    } else {
      liveEphemeralChatIdRef.current = null;
    }
    liveChatIdRef.current = currentChatId;
    setLiveChatId(currentChatId);
    setActiveView('chat');
    const isCurrentSession = () =>
      liveSessionTokenRef.current === sessionToken &&
      liveChatIdRef.current === currentChatId;

    try {
      let storedLiveSettings: any = {};
      try {
        storedLiveSettings = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}');
      } catch {}
      if (storedLiveSettings.liveConvoEnabled === false) {
        throw new Error('Live Convo is disabled in Settings.');
      }
      const normalizedLiveProvider = String(
        storedLiveSettings.liveConvoProvider || 'gemini'
      ).replace(/-live|-voice|-local|-realtime|-speech/g, '');
      const configuredLiveProvider = isModelProvider(normalizedLiveProvider)
        ? normalizedLiveProvider
        : 'gemini';
      const configuredLiveModel = String(storedLiveSettings.liveConvoModel || 'auto').trim() || 'auto';
      let resolvedLiveWorkerModel = configuredLiveModel === 'auto' ? '' : configuredLiveModel;

      // Auto is resolved from a fresh provider catalog at the moment a Live
      // session starts. The stored preference remains "auto", so future model
      // launches automatically follow provider catalog changes.
      if (configuredLiveModel === 'auto') {
        try {
          const catalogResponse = await fetch('/api/settings/models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ providers: [configuredLiveProvider] }),
          });
          const catalogPayload = await catalogResponse.json();
          const currentModels = catalogPayload?.providers?.[configuredLiveProvider]?.models;
          if (catalogResponse.ok && Array.isArray(currentModels) && currentModels[0]?.id) {
            resolvedLiveWorkerModel = String(currentModels[0].id);
          }
        } catch {}
      }
      if (!resolvedLiveWorkerModel) {
        resolvedLiveWorkerModel =
          readRuntimeModelEntries().find(entry => entry.provider === configuredLiveProvider)?.modelId ||
          '';
      }
      const defaultLiveWorker = resolvedLiveWorkerModel
        ? {
            provider: configuredLiveProvider,
            modelId: resolvedLiveWorkerModel,
            selection: modelEntryKey(configuredLiveProvider, resolvedLiveWorkerModel),
          }
        : null;
      if (defaultLiveWorker) {
        const registeredEntries = ensureModelSelectorEntry(
          readRuntimeModelEntries(),
          defaultLiveWorker.provider,
          defaultLiveWorker.modelId,
        );
        const registeredCatalog = entriesToModelCatalog(registeredEntries);
        localStorage.setItem(MODEL_SELECTOR_STORAGE_KEY, JSON.stringify(registeredEntries));
        localStorage.setItem(MODEL_CATALOG_STORAGE_KEY, JSON.stringify(registeredCatalog));
        broadcastEterxSettingsUpdate({
          type: 'model-selector-updated',
          modelEntries: registeredEntries,
          modelCatalog: registeredCatalog,
        });
      }
      const configuredLiveVoice = String(storedLiveSettings.liveConvoVoice || 'auto').trim() || 'auto';
      let resolvedLiveVoice = configuredLiveVoice === 'auto' ? 'Kore' : configuredLiveVoice;
      try {
        const voiceResponse = await fetch('/api/settings/live-voices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: configuredLiveProvider,
            modelId: resolvedLiveWorkerModel || configuredLiveModel,
          }),
        });
        const voicePayload = await voiceResponse.json();
        const availableVoices = Array.isArray(voicePayload?.voices)
          ? voicePayload.voices
              .map((voice: any) => String(voice?.value || voice?.id || '').trim())
              .filter(Boolean)
          : [];
        const defaultVoice = String(voicePayload?.defaultVoice || 'Kore').trim() || 'Kore';
        if (
          voiceResponse.ok &&
          voicePayload?.ok &&
          (configuredLiveVoice === 'auto' || !availableVoices.includes(configuredLiveVoice))
        ) {
          resolvedLiveVoice = defaultVoice;
        }
      } catch {
        // The compatible media default keeps Live usable if discovery is
        // temporarily unavailable.
      }

      // Fetch an API key from the pool
      const res = await fetch('/api/live/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: currentChatId })
      });
      if (!isCurrentSession()) return;

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to get API key');
      }

      const { apiKey } = await res.json();
      if (!isCurrentSession()) return;

      // Pre-load past memories & current chat history for instant context
      let pastMemories: string[] = [];
      try {
        const localMemStr = localStorage.getItem(`eterx_live_mem_${currentChatId}`);
        const localMem = localMemStr ? JSON.parse(localMemStr) : [];
        const globalMemStr = localStorage.getItem(`eterx_global_memories`);
        const globalMem = globalMemStr ? JSON.parse(globalMemStr) : [];
        pastMemories = [
          ...localMem.map((m: any) => m.fact || m),
          // Legacy Live memory stored chat-specific facts in a global array.
          // Only truly unscoped records or records owned by this chat may enter
          // the Live model context.
          ...globalMem
            .filter((m: any) => !m?.chatId || m.chatId === currentChatId)
            .map((m: any) => m.fact || m)
        ];
      } catch {}

      const targetChatObj = chatsRef.current.find(c => c.id === currentChatId);
      const chatHistory = (targetChatObj?.traceLogs || [])
        .filter((l: any) => l.type === 'user_action' || l.type === 'answer')
        .map((l: any) => ({
          role: l.type === 'user_action' ? 'user' : 'model',
          text: l.text || ''
        }));

      const ensureLiveTurnId = () => {
        if (!liveTurnIdRef.current) {
          liveTurnIdRef.current = `live_${ crypto.randomUUID() }`;
        }
        return liveTurnIdRef.current;
      };

      const commitLiveTurn = (userText: string, modelText: string, commands: any[]) => {
        const cleanUserText = userText.trim();
        const cleanModelText = modelText.trim();
        if (!cleanUserText && !cleanModelText && commands.length === 0) return;
        const liveTurnId = ensureLiveTurnId();
        const commitKey = `live_commit_${ crypto.randomUUID() }`;
        // When Live delegates or steers Main, the Main prompt/steering event is
        // already the run's user boundary. Preserve concise tool outcomes while
        // transient thought and spoken pacing remain inside the Live orb.
        // same run—without inserting a duplicate user message or answer row.
        if (runningChatsRef.current.has(currentChatId)) {
          const ownerChat = chatsRef.current.find(chat => chat.id === currentChatId);
          const ownerUserLog = [...(ownerChat?.traceLogs || [])]
            .reverse()
            .find((log: any) => log?.type === 'user_action');
          const ownerRunId = String(ownerUserLog?.runId || ownerUserLog?.turnId || '').trim();
          if (!ownerRunId) {
            lastLiveLogsSnapshotRef.current = { chatId: null, turnId: null, commitKey: null, logs: [] };
            return;
          }
          const completedAt = Date.now();
          const sidecarLogs = [
            ...commands.map(command => ({
              ...command,
              chatId: currentChatId,
              runId: ownerRunId,
              turnId: ownerRunId,
              _liveCommitKey: commitKey,
              isLive: true,
              timestamp: command.timestamp || completedAt,
            })),
          ];
          if (sidecarLogs.length === 0) {
            lastLiveLogsSnapshotRef.current = { chatId: null, turnId: null, commitKey: null, logs: [] };
            return;
          }
          lastLiveLogsSnapshotRef.current = {
            chatId: currentChatId,
            turnId: liveTurnId,
            commitKey,
            logs: sidecarLogs,
          };
          setChatLogsById(currentChatId, previous => [...previous, ...sidecarLogs], { touchUpdatedAt: true });
          return;
        }
        if (
          liveEphemeralChatIdRef.current === currentChatId &&
          !cleanUserText
        ) {
          lastLiveLogsSnapshotRef.current = { chatId: null, turnId: null, commitKey: null, logs: [] };
          return;
        }

        const completedAt = Date.now();
        const turnId = liveTurnId;
        const newTraceLogs: any[] = [];
        if (cleanUserText) {
          newTraceLogs.push({
            type: 'user_action',
            text: cleanUserText,
            chatId: currentChatId,
            isLive: true,
            runId: turnId,
            turnId,
            _liveCommitKey: commitKey,
            startTime: completedAt,
            endTime: completedAt,
            timestamp: completedAt,
          });
        }
        newTraceLogs.push(...commands.map(command => ({
          ...command,
          chatId: currentChatId,
          runId: turnId,
          turnId,
          _liveCommitKey: commitKey,
          timestamp: command.timestamp || completedAt,
        })));
        if (cleanModelText) {
          newTraceLogs.push({
            type: 'answer',
            text: cleanModelText,
            chatId: currentChatId,
            isLive: true,
            isStreaming: false,
            isLiveTyping: false,
            wasStreaming: true,
            runId: turnId,
            turnId,
            _liveCommitKey: commitKey,
            startTime: completedAt,
            endTime: completedAt,
            timestamp: completedAt,
          });
        }

        lastLiveLogsSnapshotRef.current = {
          chatId: currentChatId,
          turnId,
          commitKey,
          logs: newTraceLogs,
        };

        const liveTitle = (cleanUserText || cleanModelText || 'Live conversation').slice(0, 50);
        liveEphemeralChatIdRef.current = null;
        setChats(prevChats => {
          const existingChat = prevChats.find(chat => chat.id === currentChatId);
          const updated = existingChat
            ? prevChats.map(chat => {
                if (chat.id !== currentChatId) return chat;
                const newTitle = chat.title === "Live Conversation" && cleanUserText
                  ? cleanUserText.slice(0, 50)
                  : chat.title;
                return {
                  ...chat,
                  traceLogs: [...(chat.traceLogs || []), ...newTraceLogs],
                  updatedAt: completedAt,
                  title: newTitle,
                };
              })
            : [{
                id: currentChatId,
                title: liveTitle,
                updatedAt: completedAt,
                traceLogs: newTraceLogs,
                workspacePath: activeWorkspacePath,
                runLocation: activeRunLocation,
              }, ...prevChats];
          const sorted = sortChats(updated);
          persistChats(sorted);
          return sorted;
        });

        if (activeChatIdRef.current === currentChatId) {
          setTraceLogs(previous =>
            activeChatIdRef.current === currentChatId
              ? [...previous, ...newTraceLogs]
              : previous
          );
        }
        markChatUnreadIfBackground(currentChatId);
      };

      const clearLiveTurn = () => {
        setLiveInputText('');
        setLiveOutputText('');
        setLiveSpokenText('');
        setLiveCommands([]);
        setLiveActiveTool(null);
        liveInputTextRef.current = '';
        liveOutputTextRef.current = '';
        liveCommandsRef.current = [];
        liveRichResponseRef.current = null;
        liveTurnIdRef.current = null;
      };
      liveCommitTurnRef.current = commitLiveTurn;

      const session = new GeminiLiveSession(
        apiKey,
        currentChatId,
        {
          onStateChange: (state) => {
            if (!isCurrentSession()) return;
            setLiveState(state);
            if (state !== 'connected' && state !== 'listening') {
              setLiveMicVolume(0);
            }
          },
          onMicVolume: (volume) => {
            if (!isCurrentSession()) return;
            setLiveMicVolume(volume);
          },
          onModelVolume: (volume) => {
            if (!isCurrentSession()) return;
            setLiveModelVolume(volume);
          },
          onToolCallActive: (toolName) => {
            if (!isCurrentSession()) return;
            setLiveActiveTool(toolName);
          },
          onCameraStateChange: (enabled) => {
            if (!isCurrentSession()) return;
            setLiveCameraEnabled(enabled);
          },
          onScreenShareStateChange: (enabled) => {
            if (!isCurrentSession()) return;
            setLiveScreenShareEnabled(enabled);
          },
          onAgentActivity: (activity) => {
            if (!isCurrentSession()) return;
            const isActive = activity.phase === 'started' || activity.phase === 'running';
            const activityTurnId = liveTurnIdRef.current || (isActive ? ensureLiveTurnId() : null);
            if (isActive) {
              liveActiveActivityIdRef.current = activity.id;
              setLiveActivityLabel(
                activity.kind === 'thinking'
                  ? activity.detail || activity.label
                  : activity.label
              );
            } else if (liveActiveActivityIdRef.current === activity.id) {
              liveActiveActivityIdRef.current = null;
              setLiveActivityLabel(null);
            }
            // Native thought summaries are transient orb state, not chat logs.
            if (activity.kind === 'thinking') return;
            if (!activityTurnId) return;
            const trace = {
              type: 'command',
              text: activity.label,
              secondary: activity.resultSummary || undefined,
              tool: activity.toolName,
              toolName: activity.toolName,
              toolCallId: activity.id,
              isLive: true,
              runId: activityTurnId,
              turnId: activityTurnId,
              isStreaming: isActive,
              phase: activity.phase,
              startTime: activity.startedAt,
              endTime: activity.completedAt,
              timestamp: activity.startedAt,
            };
            upsertLiveMissionEntry({
              id: activity.id,
              kind: activity.kind === 'delegation' ? 'task' : 'step',
              label: activity.label,
              detail: activity.resultSummary || activity.detail,
              status: isActive
                ? 'active'
                : activity.phase === 'completed'
                  ? 'done'
                  : 'blocked',
              updatedAt: activity.completedAt || Date.now(),
            });

            const upsertActivity = (previous: any[]) => {
              const index = previous.findIndex(item =>
                item.noteId === activity.id || item.toolCallId === activity.id
              );
              const next = index < 0 ? [...previous, trace] : [...previous];
              if (index >= 0) {
                next[index] = {
                  ...previous[index],
                  ...trace,
                  startTime: previous[index].startTime || trace.startTime,
                  timestamp: previous[index].timestamp || trace.timestamp,
                };
              }
              return next.slice(-4);
            };

            liveCommandsRef.current = upsertActivity(liveCommandsRef.current);
            setLiveCommands(previous => upsertActivity(previous));
          },
          onInputTranscription: (text) => {
            if (!isCurrentSession()) return;
            ensureLiveTurnId();
            liveInputTextRef.current = text;
            const cleanGoal = text.trim().replace(/\s+/g, ' ');
            if (cleanGoal) {
              updateLiveMission(previous => {
                const next = previous || {
                  id: `mission_${crypto.randomUUID()}`,
                  goal: cleanGoal,
                  entries: [],
                  updatedAt: Date.now(),
                };
                // Provider transcription arrives incrementally before the
                // mission acquires evidence; keep the goal aligned to the full
                // utterance without overwriting a later model-refined goal.
                if (next.entries.length > 0) return next;
                return { ...next, goal: cleanGoal.slice(0, 280), updatedAt: Date.now() };
              });
            }
            setLiveInputText(text);
          },
          onOutputTranscription: (text) => {
            if (!isCurrentSession()) return;
            ensureLiveTurnId();
            liveOutputTextRef.current = text;
            setLiveOutputText(text);
          },
          onOutputPlaybackProgress: (spokenText) => {
            if (!isCurrentSession()) return;
            if (spokenText) ensureLiveTurnId();
            setLiveSpokenText(spokenText);
          },
          onTurnComplete: (userText, modelText, metadata) => {
            if (!isCurrentSession()) return;
            if (metadata?.systemEvent) {
              clearLiveTurn();
              return;
            }
            const richResponse = liveRichResponseRef.current;
            commitLiveTurn(userText, richResponse || modelText, liveCommandsRef.current);
            clearLiveTurn();
          },
          onAppControlAction: async (action, args) => {
            if (!isCurrentSession()) return { error: 'Live session is no longer active.' };
            const ownerIsActive = activeChatIdRef.current === currentChatId;
            if (action === 'update_live_mission') {
              const operation = String(args.operation || 'get').trim().toLowerCase();
              if (operation === 'get') return { mission: liveMissionRef.current };
              if (operation === 'reset') {
                const goal = String(args.goal || '').trim();
                const next: LiveMissionState = {
                  id: `mission_${crypto.randomUUID()}`,
                  goal: goal || 'Coordinate the requested work',
                  entries: [],
                  updatedAt: Date.now(),
                };
                liveMissionRef.current = next;
                setLiveMission(next);
                return { success: true, mission: next };
              }
              if (operation === 'set_goal') {
                const goal = String(args.goal || '').trim();
                if (!goal) return { error: 'A non-empty mission goal is required.' };
                updateLiveMission(previous => ({
                  id: previous?.id || `mission_${crypto.randomUUID()}`,
                  goal: goal.slice(0, 280),
                  entries: previous?.entries || [],
                  updatedAt: Date.now(),
                }));
                return { success: true, goal };
              }
              if (operation === 'upsert') {
                const label = String(args.label || '').trim();
                if (!label) return { error: 'A concise mission item label is required.' };
                const allowedKinds = new Set(['step', 'task', 'evidence', 'decision', 'blocker']);
                const allowedStatuses = new Set(['queued', 'active', 'done', 'blocked']);
                const kind = allowedKinds.has(String(args.kind)) ? String(args.kind) : 'step';
                const status = allowedStatuses.has(String(args.status)) ? String(args.status) : 'active';
                const entry: LiveMissionEntry = {
                  id: String(args.item_id || args.itemId || `mission_item_${crypto.randomUUID()}`),
                  kind: kind as LiveMissionEntry['kind'],
                  label: label.slice(0, 120),
                  detail: String(args.detail || '').trim().slice(0, 260) || undefined,
                  status: status as LiveMissionEntry['status'],
                  chatId: String(args.chat_id || args.chatId || '').trim() || undefined,
                  updatedAt: Date.now(),
                };
                upsertLiveMissionEntry(entry);
                return { success: true, item: entry };
              }
              return { error: `Unsupported mission operation: ${operation}` };
            }
            if (action === 'list_all_chats') {
              const visibleChats = chatsRef.current.slice(0, 100);
              return {
                liveOwnerChatId: currentChatId,
                activeChatId: activeChatIdRef.current,
                totalChats: chatsRef.current.length,
                truncated: chatsRef.current.length > visibleChats.length,
                chats: visibleChats.map(chat => ({
                  id: chat.id,
                  title: chat.title || 'Untitled',
                  isActive: chat.id === activeChatIdRef.current,
                  isLiveOwner: chat.id === currentChatId,
                  isRunning: runningChatsRef.current.has(chat.id),
                  updatedAt: chat.updatedAt,
                })),
              };
            }

            if (action === 'read_chat_full_context') {
              const targetChatId = String(args.chat_id || args.chatId || currentChatId);
              const targetChat = chatsRef.current.find(c => c.id === targetChatId);
              if (!targetChat) {
                return { error: `Chat session not found for ID: ${targetChatId}` };
              }
              const boundedLogs = (targetChat.traceLogs || []).slice(-160);
              const transcript = boundedLogs
                .map((log: any, idx: number) => {
                  if (log.type === 'user_action') return `[Message #${idx + 1}] USER QUERY: ${log.text}`;
                  if (log.type === 'answer') return `[Message #${idx + 1}] AGENT RESPONSE: ${log.text}`;
                  if (log.type === 'command') return `[Action #${idx + 1}] TOOL EXECUTION: ${log.text} (${log.secondary || ''})`;
                  if (log.type === 'thought') return `[Thought #${idx + 1}] THINKING: ${log.text}`;
                  return `[Item #${idx + 1}] ${log.type}: ${log.text || log.secondary || ''}`;
                })
                .join('\n');
              return {
                chatId: targetChat.id,
                title: targetChat.title,
                totalMessages: targetChat.traceLogs?.length || 0,
                returnedItems: boundedLogs.length,
                truncated: (targetChat.traceLogs?.length || 0) > boundedLogs.length,
                fullTranscript: transcript || '(No messages in this chat yet)',
              };
            }

            if (action === 'switch_active_chat') {
              const targetChatId = String(args.chat_id || args.chatId || '').trim();
              if (!targetChatId || !chatsRef.current.some(chat => chat.id === targetChatId)) {
                return { error: `Chat session not found for ID: ${targetChatId || '(missing)'}` };
              }
              loadChat(targetChatId);
              return {
                success: true,
                activeChatId: targetChatId,
                liveOwnerChatId: currentChatId,
                message: 'Chat opened. Live remains attached to its owner chat.',
              };
            }

            if (action === 'select_sub_agent') {
              if (!ownerIsActive) {
                return { error: 'The Live owner chat is no longer active.' };
              }
              const name = args.agentName || 'General';
              setActiveSubAgentTab(name);
              return { success: true, message: `Selected sub-agent "${name}".` };
            }

            if (action === 'list_available_models') {
              const entries = readRuntimeModelEntries();
              return {
                selectedModelId: composerRuntimeSelectionRef.current.modelSelection,
                models: entries.map(entry => ({
                  id: modelEntryKey(entry.provider, entry.modelId),
                  provider: entry.provider,
                  modelId: entry.modelId,
                })),
              };
            }

            if (action === 'select_model') {
              if (!ownerIsActive) {
                return { error: 'The Live owner chat is no longer active.' };
              }
              if (args.modelId) {
                const requestedModelId = String(args.modelId).trim();
                const entries = readRuntimeModelEntries();
                const matchedEntry = entries.find(entry =>
                  modelEntryKey(entry.provider, entry.modelId) === requestedModelId ||
                  entry.modelId === requestedModelId
                );
                if (!matchedEntry) {
                  return { error: 'That model is not configured. Call list_available_models and use an exact returned ID.' };
                }
                const selectionId = modelEntryKey(matchedEntry.provider, matchedEntry.modelId);
                handleModelSelectionChange(selectionId);
                return {
                  success: true,
                  modelId: selectionId,
                  provider: matchedEntry.provider,
                  message: `Changed external worker model to "${matchedEntry.modelId}".`,
                };
              }
            }

            if (action === 'add_attachment_to_prompt') {
              if (!ownerIsActive) {
                return { error: 'The Live owner chat is no longer active.' };
              }
              if (args.filePath) {
                const fileName = args.fileName || args.filePath.split(/[/\\]/).pop() || 'attachment';
                const newAttachment: any = {
                  id: crypto.randomUUID(),
                  name: fileName,
                  path: args.filePath,
                  file: null,
                  preview: args.filePath,
                  type: 'file'
                };
                updateAttachments((prev: any[]) => [...(prev || []), newAttachment]);
                return { success: true, message: `Attached file "${fileName}" to composer.` };
              }
            }

            if (action === 'send_prompt_to_main_agent') {
              const prompt = String(args.prompt || '').trim();
              if (!prompt) return { error: 'A non-empty prompt is required.' };
              const createNewChat = args.create_new_chat === true || args.createNewChat === true;
              const dispatchChatId = createNewChat
                ? crypto.randomUUID()
                : String(args.chat_id || args.chatId || currentChatId).trim();
              const dispatchChat = chatsRef.current.find(chat => chat.id === dispatchChatId);
              if (!dispatchChat && !createNewChat) return { error: `Chat session not found for ID: ${dispatchChatId}` };
              if (runningChatsRef.current.has(dispatchChatId)) {
                const followUpMode = String(args.follow_up_mode || args.followUpMode || 'auto').trim().toLowerCase();
                if (followUpMode === 'queue') {
                  const queuedItem: QueuedFollowUp = {
                    id: crypto.randomUUID(),
                    chatId: dispatchChatId,
                    text: prompt,
                    attachments: [],
                    createdAt: Date.now(),
                  };
                  setQueuedFollowUps(previous => [...previous, queuedItem]);
                  syncLiveMissionTask(
                    dispatchChatId,
                    dispatchChat?.title || 'Queued background task',
                    prompt,
                    'queued',
                  );
                  return {
                    success: true,
                    mode: 'queued_next_run',
                    queueId: queuedItem.id,
                    chatId: dispatchChatId,
                    chatTitle: dispatchChat?.title || 'Untitled',
                    message: `Follow-up queued after the active run in "${dispatchChat?.title || 'Untitled'}".`,
                  };
                }
                const steered = await sendSteeringMessageToChat(dispatchChatId, prompt);
                if (steered) {
                  syncLiveMissionTask(
                    dispatchChatId,
                    dispatchChat?.title || 'Background task',
                    prompt,
                    'active',
                  );
                  return {
                    success: true,
                    mode: 'steered_existing_run',
                    chatId: dispatchChatId,
                    chatTitle: dispatchChat?.title || 'Untitled',
                    message: `Instruction delivered to the running task in "${dispatchChat?.title || 'Untitled'}".`,
                  };
                }
                // The run may have completed between the state read and the
                // steering admission. Re-evaluate and fall through to a fresh
                // dispatch only when it is now genuinely idle.
                if (runningChatsRef.current.has(dispatchChatId)) {
                  return { error: 'Main agent is already running and could not accept the update.' };
                }
              }
              const requestedWorkerModelId = args.modelId ? String(args.modelId).trim() : '';
              const matchedWorkerModel = requestedWorkerModelId
                ? readRuntimeModelEntries().find(entry =>
                    modelEntryKey(entry.provider, entry.modelId) === requestedWorkerModelId ||
                    entry.modelId === requestedWorkerModelId
                  )
                : defaultLiveWorker;
              if (requestedWorkerModelId && !matchedWorkerModel) {
                return { error: 'Requested worker model is not configured. Call list_available_models and use an exact returned ID.' };
              }
              let requestedWorkerAgent: SelectedAgentState | undefined;
              if (args.subAgent) {
                const requestedAgent = String(args.subAgent).trim();
                const normalizedAgent = requestedAgent.toLowerCase();
                requestedWorkerAgent = {
                  agentId: normalizedAgent === 'general' ? null : normalizedAgent,
                  agentName: normalizedAgent === 'general' ? 'General' : requestedAgent,
                };
              } else if (args.executionMode) {
                const executionMode = String(args.executionMode).trim().toLowerCase();
                if (executionMode === 'autonomous' || executionMode === 'team') {
                  requestedWorkerAgent = { agentId: 'autonomous', agentName: 'Autonomous' };
                } else if (executionMode === 'coding') {
                  requestedWorkerAgent = { agentId: 'coding', agentName: 'Coding' };
                } else if (executionMode === 'general') {
                  requestedWorkerAgent = { agentId: null, agentName: 'General' };
                }
              }
              // The normal composer correctly blocks human sends during a
              // Live call. This explicit Live tool is the one authorized
              // bridge and must bypass only that guard for this invocation.
              liveMainDispatchRef.current = true;
              try {
                const dispatched = await handleSend(prompt, [], dispatchChatId, {
                  modelSelection: matchedWorkerModel
                    ? modelEntryKey(matchedWorkerModel.provider as any, matchedWorkerModel.modelId)
                    : undefined,
                  selectedAgent: requestedWorkerAgent,
                  thinkingLevel: args.thinkingLevel as MainAgentThinkingLevel | undefined,
                  createNewChat,
                  backgroundChat: createNewChat,
                  initialTitle: String(args.chat_title || args.chatTitle || '').trim() || undefined,
                });
                if (!dispatched) {
                  // The inverse race is also possible: another run can become
                  // active while the fresh dispatch is being admitted. Deliver
                  // the same intent as steering rather than making the caller
                  // choose or repeat the instruction.
                  if (runningChatsRef.current.has(dispatchChatId)) {
                    const steered = await sendSteeringMessageToChat(dispatchChatId, prompt);
                    if (steered) {
                      syncLiveMissionTask(
                        dispatchChatId,
                        dispatchChat?.title || 'Background task',
                        prompt,
                        'active',
                      );
                      return {
                        success: true,
                        mode: 'steered_existing_run',
                        chatId: dispatchChatId,
                        chatTitle: dispatchChat?.title || 'Untitled',
                        message: `Instruction delivered to the run that became active in "${dispatchChat?.title || 'Untitled'}".`,
                      };
                    }
                  }
                  return { error: 'Main did not accept the prompt. The chat may have changed, another send may already be admitted, or startup failed.' };
                }
              } finally {
                liveMainDispatchRef.current = false;
              }
              const dispatchedChatTitle =
                dispatchChat?.title ||
                String(args.chat_title || args.chatTitle || '').trim() ||
                fallbackTitleFromPrompt(prompt);
              syncLiveMissionTask(dispatchChatId, dispatchedChatTitle, prompt, 'active');
              return {
                success: true,
                mode: 'started_new_run',
                chatId: dispatchChatId,
                chatTitle: dispatchedChatTitle,
                createdChat: createNewChat,
                message: createNewChat
                  ? 'A new background task chat was created and started.'
                  : `Task started in "${dispatchChat?.title || 'Untitled'}".`,
              };
            }

            if (action === 'manage_scheduled_tasks') {
              const operation = String(args.operation || 'list').toLowerCase();
              let tasks: ScheduledTaskRecord[] = [];
              try {
                const saved = JSON.parse(localStorage.getItem('eterx_scheduled_tasks') || '[]');
                tasks = Array.isArray(saved) ? saved.map(normalizeScheduledTask) : [];
              } catch {
                tasks = [];
              }
              const saveScheduledTasks = (next: ScheduledTaskRecord[]) => {
                localStorage.setItem('eterx_scheduled_tasks', JSON.stringify(next));
                window.dispatchEvent(new CustomEvent('eterx_scheduled_tasks_updated'));
              };
              const resolveTaskModel = (requested: unknown): { value?: string; error?: string } => {
                const modelId = String(requested || '').trim();
                if (!modelId || modelId === AUTO_MODEL_SELECTION || modelId.toLowerCase() === 'auto') {
                  return { value: AUTO_MODEL_SELECTION };
                }
                const match = readRuntimeModelEntries().find(entry =>
                  modelEntryKey(entry.provider, entry.modelId) === modelId ||
                  entry.modelId === modelId
                );
                return match
                  ? { value: modelEntryKey(match.provider, match.modelId) }
                  : { error: 'That model is not configured. Call list_available_models and use an exact returned ID.' };
              };
              const resolveTaskAgent = (requestedId: unknown, requestedName: unknown) => {
                const agentId = String(requestedId || '').trim();
                if (!agentId || agentId === 'general') return { agentId: null, agentName: 'General' };
                if (agentId === 'coding') return { agentId, agentName: 'Coding' };
                if (agentId === 'autonomous') return { agentId, agentName: 'Autonomous' };
                let savedAgents: any[] = [];
                try {
                  const parsed = JSON.parse(localStorage.getItem('eterx_agents') || '[]');
                  savedAgents = Array.isArray(parsed) ? parsed : [];
                } catch { }
                const match = savedAgents.find(agent => agent.id === agentId && agent.isSetup !== false);
                return match
                  ? { agentId, agentName: String(match.name || requestedName || agentId) }
                  : { error: `Ready custom agent not found for ID: ${agentId}` };
              };
              if (operation === 'list') {
                return {
                  totalTasks: tasks.length,
                  tasks: tasks.slice(0, 100).map(task => ({
                    ...task,
                    history: task.history?.slice(-5) || [],
                  })),
                };
              }
              const taskId = String(args.task_id || '').trim();
              const existingTask = taskId ? tasks.find(item => item.id === taskId) : undefined;
              if (operation === 'history') {
                if (!existingTask) return { error: `Scheduled task not found for ID: ${taskId || '(missing)'}` };
                return {
                  taskId,
                  title: existingTask.title,
                  runCount: existingTask.runCount || existingTask.history?.length || 0,
                  history: [...(existingTask.history || [])].reverse(),
                };
              }
              if (operation === 'create') {
                const title = String(args.title || '').trim();
                const description = String(args.description || title).trim();
                if (!title || !description) return { error: 'A title and task description are required.' };
                const resolvedModel = resolveTaskModel(args.modelId);
                if (resolvedModel.error) return { error: resolvedModel.error };
                const resolvedAgent = resolveTaskAgent(args.agentId, args.agentName);
                if ('error' in resolvedAgent) return { error: resolvedAgent.error };
                const requestedTime = args.scheduled_at ? Date.parse(String(args.scheduled_at)) : Date.now();
                if (!Number.isFinite(requestedTime)) return { error: 'scheduled_at must be a valid ISO date/time.' };
                const scheduledDate = new Date(requestedTime);
                const recurrence = String(args.recurrence || 'none').trim().toLowerCase();
                if (
                  !['none', 'once', 'hourly', 'daily', 'weekdays', 'weekly'].includes(recurrence) &&
                  (!recurrence.startsWith('custom:') || computeNextScheduledRun(recurrence, requestedTime) === null)
                ) return { error: 'Invalid recurrence. Use none, hourly, daily, weekdays, weekly, or custom:<interval/5-field cron>.' };
                const localDate = [
                  scheduledDate.getFullYear(),
                  String(scheduledDate.getMonth() + 1).padStart(2, '0'),
                  String(scheduledDate.getDate()).padStart(2, '0'),
                ].join('-');
                const task = normalizeScheduledTask({
                  id: `task_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
                  title,
                  description,
                  model: resolvedModel.value,
                  thinkingLevel: ['minimal', 'low', 'medium', 'high'].includes(String(args.thinkingLevel))
                    ? args.thinkingLevel
                    : undefined,
                  agentId: resolvedAgent.agentId,
                  agentName: resolvedAgent.agentName,
                  priority: ['low', 'medium', 'high'].includes(String(args.priority).toLowerCase())
                    ? String(args.priority).toLowerCase() as ScheduledTaskRecord['priority']
                    : 'medium',
                  recurrence,
                  triggerTime: scheduledDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
                  dateOption: 'custom',
                  customDate: localDate,
                  sources: Array.isArray(args.sources)
                    ? args.sources
                        .filter((source: any) => String(source?.path || '').trim())
                        .map((source: any) => ({
                          id: crypto.randomUUID(),
                          path: String(source.path),
                          name: String(source.name || source.path.split(/[/\\]/).pop() || 'Source'),
                          type: String(source.type || 'file'),
                        }))
                    : [],
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                  scheduledTimestamp: requestedTime,
                  status: 'scheduled',
                  history: [],
                  runCount: 0,
                });
                tasks = [task, ...tasks];
                saveScheduledTasks(tasks);
                if (requestedTime <= Date.now()) {
                  task.status = 'queued';
                  saveScheduledTasks(tasks);
                  window.dispatchEvent(new CustomEvent('eterx_trigger_scheduled_task', { detail: { task } }));
                }
                return { success: true, taskId: task.id, task, message: `Scheduled "${title}".` };
              }
              if (!existingTask) return { error: `Scheduled task not found for ID: ${taskId || '(missing)'}` };
              if (operation === 'update') {
                if (existingTask.status === 'running') return { error: 'A running task cannot be edited. Stop its chat run first or wait for completion.' };
                if (args.title !== undefined) {
                  const title = String(args.title).trim();
                  if (!title) return { error: 'Task title cannot be empty.' };
                  existingTask.title = title;
                }
                if (args.description !== undefined) {
                  const description = String(args.description).trim();
                  if (!description) return { error: 'Task description cannot be empty.' };
                  existingTask.description = description;
                }
                if (args.modelId !== undefined) {
                  const resolvedModel = resolveTaskModel(args.modelId);
                  if (resolvedModel.error) return { error: resolvedModel.error };
                  existingTask.model = resolvedModel.value!;
                }
                if (args.agentId !== undefined) {
                  const resolvedAgent = resolveTaskAgent(args.agentId, args.agentName);
                  if ('error' in resolvedAgent) return { error: resolvedAgent.error };
                  existingTask.agentId = resolvedAgent.agentId;
                  existingTask.agentName = resolvedAgent.agentName;
                }
                if (args.priority !== undefined) {
                  const priority = String(args.priority).toLowerCase();
                  if (!['low', 'medium', 'high'].includes(priority)) return { error: 'Priority must be low, medium, or high.' };
                  existingTask.priority = priority as ScheduledTaskRecord['priority'];
                }
                if (args.thinkingLevel !== undefined) {
                  const level = String(args.thinkingLevel);
                  if (!['minimal', 'low', 'medium', 'high'].includes(level)) return { error: 'Thinking level must be minimal, low, medium, or high.' };
                  existingTask.thinkingLevel = level as ScheduledTaskRecord['thinkingLevel'];
                }
                if (args.recurrence !== undefined) {
                  const recurrence = String(args.recurrence).trim().toLowerCase();
                  if (
                    !['none', 'once', 'hourly', 'daily', 'weekdays', 'weekly'].includes(recurrence) &&
                    (!recurrence.startsWith('custom:') || computeNextScheduledRun(recurrence, Date.now()) === null)
                  ) return { error: 'Invalid recurrence rule.' };
                  existingTask.recurrence = recurrence;
                }
                if (args.scheduled_at !== undefined) {
                  const requestedTime = Date.parse(String(args.scheduled_at));
                  if (!Number.isFinite(requestedTime)) return { error: 'scheduled_at must be a valid ISO date/time.' };
                  const date = new Date(requestedTime);
                  existingTask.scheduledTimestamp = requestedTime;
                  existingTask.triggerTime = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                  existingTask.customDate = [
                    date.getFullYear(),
                    String(date.getMonth() + 1).padStart(2, '0'),
                    String(date.getDate()).padStart(2, '0'),
                  ].join('-');
                  existingTask.dateOption = 'custom';
                  existingTask.status = 'scheduled';
                }
                if (Array.isArray(args.sources)) {
                  existingTask.sources = args.sources
                    .filter((source: any) => String(source?.path || '').trim())
                    .map((source: any) => ({
                      id: crypto.randomUUID(),
                      path: String(source.path),
                      name: String(source.name || source.path.split(/[/\\]/).pop() || 'Source'),
                      type: String(source.type || 'file'),
                    }));
                }
                existingTask.updatedAt = Date.now();
                saveScheduledTasks(tasks);
                return { success: true, taskId, task: existingTask, message: `Updated "${existingTask.title}".` };
              }
              if (operation === 'run_now') {
                if (existingTask.status === 'running') return { error: `"${existingTask.title}" is already running.` };
                existingTask.status = 'queued';
                existingTask.scheduledTimestamp = Date.now();
                existingTask.updatedAt = Date.now();
                saveScheduledTasks(tasks);
                window.dispatchEvent(new CustomEvent('eterx_trigger_scheduled_task', { detail: { task: existingTask } }));
                return { success: true, taskId, message: `Started "${existingTask.title}".` };
              }
              if (operation === 'remove') {
                if (existingTask.status === 'running') {
                  return { error: 'A running scheduled task cannot be removed. Stop its chat run first.' };
                }
                tasks = tasks.filter(item => item.id !== taskId);
                saveScheduledTasks(tasks);
                return { success: true, taskId, message: `Removed "${existingTask.title}".` };
              }
              return { error: `Unsupported scheduled-task operation: ${operation}` };
            }

            if (action === 'manage_custom_agents') {
              const operation = String(args.operation || 'list').toLowerCase();
              let localAgents: any[] = [];
              try {
                localAgents = JSON.parse(localStorage.getItem('eterx_agents') || '[]');
                if (!Array.isArray(localAgents)) localAgents = [];
              } catch {
                localAgents = [];
              }
              let serverAgents: any[] = [];
              try {
                const response = await fetch('/api/agents/list', { cache: 'no-store' });
                const payload = response.ok ? await response.json() : {};
                serverAgents = Array.isArray(payload.agents) ? payload.agents : [];
              } catch { }
              const agentsById = new Map<string, any>();
              for (const agent of localAgents) agentsById.set(String(agent.id), { ...agent });
              for (const agent of serverAgents) {
                const id = String(agent.agentId || agent.id || '').trim();
                if (!id) continue;
                const local = agentsById.get(id);
                agentsById.set(id, {
                  ...local,
                  ...agent,
                  id,
                  name: agent.name || local?.name || id,
                  description: local?.description || agent.mission || '',
                  isSetup: agent.status === 'ready',
                });
              }
              const agents = Array.from(agentsById.values());
              const resolveAgentModel = (requested: unknown): { value?: string; error?: string } => {
                const modelId = String(requested || '').trim();
                if (!modelId || modelId === AUTO_MODEL_SELECTION || modelId.toLowerCase() === 'auto') {
                  return { value: AUTO_MODEL_SELECTION };
                }
                const match = readRuntimeModelEntries().find(entry =>
                  modelEntryKey(entry.provider, entry.modelId) === modelId ||
                  entry.modelId === modelId
                );
                return match
                  ? { value: modelEntryKey(match.provider, match.modelId) }
                  : { error: 'That model is not configured. Call list_available_models and use an exact returned ID.' };
              };
              if (operation === 'list') {
                return {
                  agents: agents.map(agent => ({
                    id: agent.id,
                    name: agent.name,
                    description: agent.description,
                    mission: agent.mission,
                    isSetup: agent.isSetup,
                    status: agent.status || (agent.isSetup === false ? 'draft' : 'ready'),
                    accessType: agent.accessType,
                    toolCount: agent.toolCount,
                    preferredModel: agent.preferredModel,
                    preferredThinkingLevel: agent.preferredThinkingLevel,
                    updatedAt: agent.updatedAt,
                  })),
                };
              }
              const requestedAgentId = String(args.agentId || '').trim();
              const requestedAgent = agents.find(item => item.id === requestedAgentId);
              if (operation === 'inspect') {
                if (!requestedAgent) return { error: `Custom agent not found for ID: ${requestedAgentId || '(missing)'}` };
                try {
                  const response = await fetch(`/api/agents/list?agentId=${encodeURIComponent(requestedAgentId)}`, { cache: 'no-store' });
                  const payload = response.ok ? await response.json() : {};
                  return {
                    agent: requestedAgent,
                    profile: payload.profile || null,
                  };
                } catch {
                  return { agent: requestedAgent, profile: null };
                }
              }
              if (operation === 'select') {
                if (!requestedAgent) return { error: `Custom agent not found for ID: ${requestedAgentId || '(missing)'}` };
                if (requestedAgent.isSetup === false || requestedAgent.status === 'draft') {
                  return { error: `"${requestedAgent.name}" is still a draft. Open its builder and finish setup first.` };
                }
                const selectedModel = resolveAgentModel(args.modelId ?? requestedAgent.preferredModel);
                if (selectedModel.error) return { error: selectedModel.error };
                const selectedThinking = args.thinkingLevel !== undefined ? String(args.thinkingLevel) : undefined;
                if (selectedThinking && !['minimal', 'low', 'medium', 'high'].includes(selectedThinking)) {
                  return { error: 'Thinking level must be minimal, low, medium, or high.' };
                }
                handleAgentChange(requestedAgent.id, requestedAgent.name);
                if (args.modelId !== undefined || requestedAgent.preferredModel) {
                  handleModelSelectionChange(selectedModel.value!);
                }
                const effectiveThinking = selectedThinking || requestedAgent.preferredThinkingLevel;
                if (effectiveThinking) setThinkingLevel(effectiveThinking as MainAgentThinkingLevel);
                return {
                  success: true,
                  agentId: requestedAgentId,
                  modelId: args.modelId !== undefined || requestedAgent.preferredModel ? selectedModel.value : undefined,
                  message: `Selected "${requestedAgent.name}".`,
                };
              }
              if (operation === 'open_builder' || operation === 'create' || operation === 'configure') {
                const agentId = operation === 'create'
                  ? `eterxagent-live-${Date.now()}`
                  : requestedAgentId;
                if (!agentId) return { error: 'An exact agent ID is required.' };
                if (operation !== 'create' && !requestedAgent) {
                  return { error: `Custom agent not found for ID: ${agentId}` };
                }
                const builderModel = resolveAgentModel(args.modelId ?? requestedAgent?.preferredModel);
                if (builderModel.error) return { error: builderModel.error };
                const builderThinking = args.thinkingLevel !== undefined ? String(args.thinkingLevel) : undefined;
                if (builderThinking && !['minimal', 'low', 'medium', 'high'].includes(builderThinking)) {
                  return { error: 'Thinking level must be minimal, low, medium, or high.' };
                }
                handleOpenAgentBuilder(agentId);
                if (operation === 'create' || operation === 'configure') {
                  const requirements = String(args.requirements || '').trim();
                  if (!requirements) return { error: 'Agent requirements are required for builder configuration.' };
                  const builderRequest = [
                    operation === 'create'
                      ? `Create and fully configure the custom agent "${String(args.agentName || agentId)}".`
                      : `Update and fully revalidate the existing custom agent "${requestedAgent?.name || agentId}".`,
                    '',
                    'Requirements:',
                    requirements,
                    '',
                    `Preferred runtime model: ${builderModel.value || AUTO_MODEL_SELECTION}.`,
                    'Infer professional defaults where the request is already clear. Build the complete prompt, behavior rules, safety rules, skills, tool access, completion criteria, and save/finalize the real agent profile. Ask only for genuinely missing consequential requirements.',
                  ].join('\n');
                  const builderDispatched = await new Promise<boolean>(resolve => {
                    window.setTimeout(async () => {
                      liveMainDispatchRef.current = true;
                      try {
                        resolve(await handleSend(builderRequest, [], `agent_builder_${agentId}`, {
                          modelSelection: builderModel.value,
                          thinkingLevel: builderThinking as MainAgentThinkingLevel | undefined,
                        }));
                      } catch {
                        resolve(false);
                      } finally {
                        liveMainDispatchRef.current = false;
                      }
                    }, 0);
                  });
                  if (!builderDispatched) return { error: 'The agent builder opened but could not start its setup run.' };
                  let savedProfile: any = null;
                  try {
                    const response = await fetch(`/api/agents/list?agentId=${encodeURIComponent(agentId)}`, { cache: 'no-store' });
                    const payload = response.ok ? await response.json() : {};
                    savedProfile = payload.profile || null;
                  } catch { }
                  const localEntry = {
                    id: agentId,
                    name: savedProfile?.name || String(args.agentName || requestedAgent?.name || agentId),
                    description: savedProfile?.mission || requirements.slice(0, 240),
                    accessType: requestedAgent?.accessType || 'Agent Decides',
                    isSetup: savedProfile?.status === 'ready',
                    toolCount: savedProfile
                      ? (savedProfile.directMainTools?.length || 0) + (savedProfile.customTools?.length || 0)
                      : requestedAgent?.toolCount || 0,
                    preferredModel: builderModel.value || requestedAgent?.preferredModel || AUTO_MODEL_SELECTION,
                    preferredThinkingLevel: builderThinking || requestedAgent?.preferredThinkingLevel,
                    builderMessages: requestedAgent?.builderMessages || [],
                  };
                  const nextAgents = [localEntry, ...localAgents.filter(agent => agent.id !== agentId)];
                  localStorage.setItem('eterx_agents', JSON.stringify(nextAgents));
                  window.dispatchEvent(new CustomEvent('eterx_agents_updated'));
                }
                return {
                  success: true,
                  agentId,
                  message: operation === 'create'
                    ? `Agent builder processed the setup requirements for "${String(args.agentName || agentId)}".`
                    : operation === 'configure'
                      ? `Agent builder processed the new requirements for "${requestedAgent?.name || agentId}".`
                      : 'Agent builder opened.',
                };
              }
              return { error: `Unsupported custom-agent operation: ${operation}` };
            }

            if (action === 'present_rich_response') {
              const markdown = String(args.markdown || '').trim();
              if (!markdown) return { error: 'A non-empty Markdown response is required.' };
              if (markdown.length > 60000) {
                return { error: 'The rich response is too large. Condense it to the essential explanation.' };
              }
              liveRichResponseRef.current = markdown;
              return {
                success: true,
                chatId: currentChatId,
                format: 'markdown',
                message: 'Rich response staged for the current Live turn.',
              };
            }

            if (action === 'get_main_agent_status') {
              const targetChatId = String(args.chat_id || args.chatId || currentChatId);
              const targetChat = chatsRef.current.find(c => c.id === targetChatId);
              if (!targetChat) return { error: `Chat session not found for ID: ${targetChatId}` };
              const isRunning = runningChatsRef.current.has(targetChatId);
              const recentLogs = (targetChat.traceLogs || []).slice(-25);
              const delegatedAgents = Array.from(new Map(
                recentLogs
                  .filter((log: any) => log.subAgent || log.agentName)
                  .map((log: any) => {
                    const name = String(log.subAgent || log.agentName);
                    return [name, {
                      name,
                      id: log.subAgentId || log.subAgentChatId,
                      status: log.status || (log.isStreaming ? 'working' : undefined),
                    }] as const;
                  })
              ).values());
              return {
                chatId: targetChatId,
                chatTitle: targetChat.title || 'Untitled',
                isRunning,
                isActive: targetChatId === activeChatIdRef.current,
                isLiveOwner: targetChatId === currentChatId,
                delegatedAgents,
                recentLogsSummary: recentLogs.map((log: any) => ({
                  type: log.type,
                  text: (log.text || log.secondary || '').slice(0, 160),
                  agent: log.subAgent || log.agentName,
                  tool: log.toolName || log.tool,
                  status: log.status,
                  isStreaming: Boolean(log.isStreaming),
                }))
              };
            }

            if (action === 'control_app_ui') {
              if (args.view && ['chat', 'agents', 'channels', 'projects'].includes(String(args.view))) {
                setActiveView(args.view as ActiveView);
              }
              if (args.action === 'open_pet') {
                openPetWidget();
              } else if (args.action === 'open_agent_builder') {
                handleOpenAgentBuilder('');
              } else if (args.action === 'set_mode' && args.mode) {
                handleAgentModeChange(args.mode as any);
              } else if (args.action === 'set_thinking_level' && args.thinkingLevel) {
                setThinkingLevel(args.thinkingLevel as any);
              }
              return { success: true, message: 'App UI controls updated.' };
            }

            if (action === 'stop_main_agent_run') {
              const targetChatId = String(args.chat_id || args.chatId || currentChatId);
              const stopped = await stopChatAgent(targetChatId);
              return stopped
                ? { success: true, chatId: targetChatId, message: 'Main-agent task stopped.' }
                : { error: 'No running task was stopped in that chat.' };
            }

            return { error: 'Unknown app control action' };
          },
          onInterrupted: (metadata) => {
            if (!isCurrentSession()) return;
            if (metadata?.systemEvent) {
              clearLiveTurn();
              return;
            }
            commitLiveTurn(
              liveInputTextRef.current,
              liveRichResponseRef.current || liveOutputTextRef.current,
              liveCommandsRef.current
            );
            clearLiveTurn();
          },
          onError: (error) => {
            if (!isCurrentSession()) return;
            console.error('[LiveSession] Error:', error);
            commitLiveTurn(
              liveInputTextRef.current,
              liveRichResponseRef.current || liveOutputTextRef.current,
              liveCommandsRef.current
            );
            clearLiveTurn();
            setLiveError(error);
            setLiveState('error');
            setTimeout(() => {
              if (!isCurrentSession()) return;
              liveSessionTokenRef.current = null;
              liveSessionRef.current?.disconnect();
              liveSessionRef.current = null;
              liveChatIdRef.current = null;
              setLiveChatId(null);
              discardEphemeralLiveRoom(currentChatId);
              setLiveState('idle');
              setLiveError(null);
            }, 4000);
          },
        },
        {
          thinkingLevel: storedLiveSettings.liveConvoLatencyMode === 'ultra-low'
            ? 'minimal'
            : storedLiveSettings.liveConvoLatencyMode === 'balanced'
              ? 'medium'
              : 'high',
          includeThoughts: true,
          voice: resolvedLiveVoice,
          audioInputEnabled: storedLiveSettings.liveConvoAudioInput !== false,
          audioOutputEnabled: storedLiveSettings.liveConvoAudioOutput !== false,
          interactionPolicy: {
            notificationLevel: ['all', 'important', 'critical'].includes(storedLiveSettings.liveConvoNotificationLevel)
              ? storedLiveSettings.liveConvoNotificationLevel
              : 'important',
            responseDetail: ['brief', 'balanced', 'detailed'].includes(storedLiveSettings.liveConvoResponseDetail)
              ? storedLiveSettings.liveConvoResponseDetail
              : 'balanced',
            proactiveUpdates: storedLiveSettings.liveConvoProactiveUpdates !== false,
            silenceUntilImportant:
              storedLiveSettings.liveConvoSilenceUntilImportant === true ||
              storedLiveSettings.liveConvoNotificationLevel === 'critical',
            autoFollowThrough: storedLiveSettings.liveConvoAutoFollowThrough !== false,
          },
          initialContext: {
            pastMemories,
            chatHistory,
            workspacePath: activeWorkspacePath || undefined,
            systemNotes: [
              defaultLiveWorker
                ? `Default Live worker model: ${defaultLiveWorker.provider}/${defaultLiveWorker.modelId}. For substantive research, coding, creation, or multi-step action, call send_prompt_to_main_agent without inventing another model ID; the app will route to this configured worker unless the user explicitly selects a different model.`
                : 'No default external Live worker model was resolved. Use list_available_models before delegating substantial work.',
              String(storedLiveSettings.liveConvoSystemInstruction || '').trim(),
            ].filter(Boolean).join('\n\n'),
          }
        }
      );

      if (!isCurrentSession()) {
        session.disconnect();
        return;
      }
      liveSessionRef.current = session;
      await session.connect();
      if (!isCurrentSession()) {
        session.disconnect();
        return;
      }

    } catch (error: any) {
      if (!isCurrentSession()) return;
      console.error('[LiveSession] Failed to start:', error);
      setLiveError(error.message || 'Failed to start Live API');
      setLiveState('error');
      setTimeout(() => {
        if (!isCurrentSession()) return;
        liveSessionTokenRef.current = null;
        liveSessionRef.current?.disconnect();
        liveSessionRef.current = null;
        liveChatIdRef.current = null;
        setLiveChatId(null);
        discardEphemeralLiveRoom(currentChatId);
        setLiveState('idle');
        setLiveError(null);
      }, 4000);
    }
  }, [activeChatId, activeRunLocation, activeWorkspacePath, discardEphemeralLiveRoom, revealNetworkBanner, syncLiveMissionTask, updateLiveMission, upsertLiveMissionEntry]);

  const stopLiveSession = useCallback(() => {
    const stoppedChatId = liveChatIdRef.current;
    const discardEmptyRoom = Boolean(
      stoppedChatId &&
      liveEphemeralChatIdRef.current === stoppedChatId
    );
    const hadPendingTurn = Boolean(
      liveInputTextRef.current.trim() ||
      liveOutputTextRef.current.trim() ||
      liveRichResponseRef.current?.trim() ||
      liveCommandsRef.current.length > 0
    );
    if (hadPendingTurn) {
      liveCommitTurnRef.current?.(
        liveInputTextRef.current,
        liveRichResponseRef.current || liveOutputTextRef.current,
        liveCommandsRef.current
      );
    }
    liveSessionTokenRef.current = null;
    liveCommitTurnRef.current = null;
    if (liveSessionRef.current) {
      liveSessionRef.current.disconnect();
      liveSessionRef.current = null;
    }
    liveChatIdRef.current = null;
    setLiveChatId(null);

    setLiveState('idle');
    setLiveInputText('');
    setLiveOutputText('');
    setLiveSpokenText('');
    setLiveActiveTool(null);
    setLiveCameraEnabled(false);
    setLiveScreenShareEnabled(false);
    setLiveActivityLabel(null);
    liveActiveActivityIdRef.current = null;
    setLiveCommands([]);
    setLiveMicVolume(0);
    setLiveModelVolume(0);
    setLiveError(null);
    liveInputTextRef.current = '';
    liveOutputTextRef.current = '';
    liveCommandsRef.current = [];
    liveTurnIdRef.current = null;
    if (!hadPendingTurn || !lastLiveLogsSnapshotRef.current.commitKey) {
      lastLiveLogsSnapshotRef.current = { chatId: null, turnId: null, commitKey: null, logs: [] };
    }

    if (discardEmptyRoom) discardEphemeralLiveRoom(stoppedChatId);
  }, [discardEphemeralLiveRoom]);

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

  const toggleLiveCamera = useCallback(async () => {
    const session = liveSessionRef.current;
    if (!session) return;
    if (session.isCameraEnabled()) {
      session.stopCamera();
      return;
    }
    const result = await session.startCamera('user');
    setLiveError(result.success ? null : result.message);
  }, []);

  const toggleLiveScreenShare = useCallback(async () => {
    const session = liveSessionRef.current;
    if (!session) return;
    if (session.isScreenShareEnabled()) {
      session.stopScreenShare();
      return;
    }
    const result = await session.startScreenShare();
    setLiveError(result.success ? null : result.message);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !(window as any).electronAPI?.onPetReply) return;

    const unsubscribe = (window as any).electronAPI.onPetReply((rawMessage: string) => {
      try {
        const data = typeof rawMessage === 'string' && rawMessage.startsWith('{') ? JSON.parse(rawMessage) : { action: rawMessage };
        if (data.action === 'toggle-mic') {
          if (typeof data.muted === 'boolean') {
            setLiveMicMuted(data.muted);
            liveSessionRef.current?.setMicMuted(data.muted);
          } else {
            toggleLiveMicMute();
          }
        } else if (data.action === 'toggle-speaker') {
          if (typeof data.muted === 'boolean') {
            setLiveSpeakerMuted(data.muted);
            liveSessionRef.current?.setSpeakerMuted(data.muted);
          } else {
            toggleLiveSpeakerMute();
          }
        } else if (data.action === 'toggle-camera') {
          void toggleLiveCamera();
        } else if (data.action === 'toggle-screen-share') {
          void toggleLiveScreenShare();
        } else if (data.action === 'stop' || data.action === 'close') {
          stopLiveSession();
        }
      } catch (e) {
        console.warn('Failed to parse pet reply', e);
      }
    });

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [toggleLiveCamera, toggleLiveMicMute, toggleLiveScreenShare, toggleLiveSpeakerMute, stopLiveSession]);

  const getLiveTraceLogs = useCallback(() => {
    if (
      liveState === 'idle' ||
      liveState === 'error' ||
      !liveChatId ||
      activeChatId !== liveChatId
    ) return [];

    const logs: any[] = [];
    const turnId = liveTurnIdRef.current;
    if (!turnId) return logs;
    if (liveInputText) {
      logs.push({
        type: 'user_action',
        text: liveInputText,
        chatId: liveChatId,
        isLive: true,
        runId: turnId,
        turnId,
      });
    }

    if (liveCommands.length > 0) {
      logs.push(...liveCommands.map(command => ({
        ...command,
        chatId: liveChatId,
        isLive: true,
        runId: turnId,
        turnId,
      })));
    }

    const visibleOutputText = liveOutputText.trim() || liveSpokenText.trim();
    if (visibleOutputText) {
      logs.push({
        type: 'answer',
        text: visibleOutputText,
        chatId: liveChatId,
        spokenText: liveSpokenText,
        isLive: true,
        isLiveTyping: true,
        runId: turnId,
        turnId,
      });
    }

    return logs;
  }, [activeChatId, liveChatId, liveState, liveInputText, liveOutputText, liveSpokenText, liveCommands]);

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
    if (restoredActiveChatRef.current) return;
    restoredActiveChatRef.current = true;
    let cancelled = false;
    let localChats: ChatSession[] = [];
    let localSavedAt = 0;

    const applyRestoredChats = (
      restoredChats: ChatSession[],
      preserveMetadataOnlyChats = false
    ) => {
      if (cancelled) return;
      const cleanChats = (preserveMetadataOnlyChats
        ? restoredChats
        : removeGeneratedEmptyChats(restoredChats))
        .map(enforceChatTraceOwnership);
      setChats(cleanChats);
      const savedActiveChatId = localStorage.getItem(ACTIVE_CHAT_STORAGE_KEY);
      const restoredActiveChat = cleanChats.find(chat => chat.id === savedActiveChatId);
      if (restoredActiveChat) {
        activeChatIdRef.current = restoredActiveChat.id;
        setActiveChatId(restoredActiveChat.id);
        setTraceLogs(restoredActiveChat.traceLogs || []);
        setActiveWorkspacePath(restoredActiveChat.workspacePath || null);
        applyComposerState(composerStates[restoredActiveChat.id]);
      }
    };

    try {
      const saved = localStorage.getItem('eterx_chats');
      const savedIndex = localStorage.getItem(CHAT_INDEX_STORAGE_KEY);
      localSavedAt = Number(localStorage.getItem('eterx_chats_saved_at') || 0);
      const cachedChats = saved ? JSON.parse(saved) : [];
      const parsedIndex = savedIndex ? JSON.parse(savedIndex) : [];
      const indexedChats = Array.isArray(parsedIndex) ? parsedIndex : parsedIndex?.chats;
      localSavedAt = Math.max(localSavedAt, Number(parsedIndex?.savedAt || 0));
      if (Array.isArray(cachedChats) || Array.isArray(indexedChats)) {
        const localById = new Map<string, ChatSession>();
        if (Array.isArray(indexedChats)) {
          for (const chat of indexedChats) {
            if (chat?.id) localById.set(chat.id, { ...chat, traceLogs: [] });
          }
        }
        if (Array.isArray(cachedChats)) {
          for (const chat of cachedChats) {
            if (chat?.id) localById.set(chat.id, chat);
          }
        }
        localChats = sortChats(Array.from(localById.values()));
        applyRestoredChats(localChats, true);
      }
    } catch { }

    const desktopLoad = (window as any).electronAPI?.loadChatSnapshot;
    const restoreRequest = desktopLoad
      ? desktopLoad()
      : fetch('/api/chats', { cache: 'no-store' })
          .then(response => response.ok ? response.json() : Promise.reject(new Error(`Chat restore HTTP ${ response.status }`)));

    void restoreRequest
      .then((snapshot: any) => {
        if (cancelled) return;
        const appDataChats = Array.isArray(snapshot?.chats)
          ? removeGeneratedEmptyChats(sortChats(snapshot.chats)).filter(
              chat => !pendingChatDeletionIdsRef.current.has(chat.id)
            )
          : [];
        hydratedChatIdsRef.current = new Set(appDataChats.map(chat => chat.id));
        const appDataSavedAt = Number(snapshot?.savedAt || 0);
        lastChatSnapshotAtRef.current = Math.max(localSavedAt, appDataSavedAt, Date.now());

        const mergedById = new Map(appDataChats.map(chat => [chat.id, chat]));
        const currentLocalChats = chatsRef.current.length > 0 ? chatsRef.current : localChats;
        for (const cachedChat of currentLocalChats) {
          const durableChat = mergedById.get(cachedChat.id);
          if (!durableChat) {
            mergedById.set(cachedChat.id, cachedChat);
          } else if (
            localSavedAt > appDataSavedAt ||
            cachedChat.updatedAt > durableChat.updatedAt ||
            cachedChat.title !== durableChat.title ||
            cachedChat.isFavorite !== durableChat.isFavorite ||
            cachedChat.workspacePath !== durableChat.workspacePath ||
            cachedChat.runLocation !== durableChat.runLocation ||
            (cachedChat.traceLogs?.length || 0) > (durableChat.traceLogs?.length || 0) ||
            chatHasLogsMissingFromDurable(durableChat, cachedChat)
          ) {
            mergedById.set(cachedChat.id, mergeCachedChatIntoDurable(durableChat, cachedChat));
          }
        }
        const restoredChats = removeGeneratedEmptyChats(sortChats(Array.from(mergedById.values())));
        chatSnapshotReadyRef.current = true;
        applyRestoredChats(restoredChats);
        persistChats(restoredChats);
      })
      .catch(() => { /* Keep the fast local cache; retry durable hydration on next launch. */ });

    return () => { cancelled = true; };
  }, [applyComposerState, composerStates]);

  useEffect(() => {
    try {
      if (activeChatId) localStorage.setItem(ACTIVE_CHAT_STORAGE_KEY, activeChatId);
      else localStorage.removeItem(ACTIVE_CHAT_STORAGE_KEY);
    } catch { }
  }, [activeChatId]);

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

  const AGENT_CONNECTION_NOTE_ID = 'eterx-agent-connection';
  const isAgentConnectionLog = (log: any) =>
    !!log && (log._connection === true || (log.type === 'work_note' && log.noteId === AGENT_CONNECTION_NOTE_ID));
  const stripAgentConnectionLogs = (logs: any[] = []) => logs.filter(log => !isAgentConnectionLog(log));
  const getConsoleOutputText = (log: any) => String(log?.output ?? log?.content ?? log?.outputPreview ?? '');
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
      traceLogs: (chat.traceLogs || [])
        .filter(log => !log?.chatId || log.chatId === chat.id)
        .map(stripTraceLogForStorage)
    }));
  const stripChatsForBrowserCache = (chatList: ChatSession[]) =>
    chatList.slice(0, 50).map(chat => ({
      ...chat,
      // AppData owns full history. Browser storage is only a fast/offline cache
      // and must stay bounded to avoid synchronous localStorage stalls.
      traceLogs: (chat.traceLogs || [])
        .filter(log => !log?.chatId || log.chatId === chat.id)
        .slice(-300)
        .map(stripTraceLogForStorage),
    }));
  const stripChatsForBrowserIndex = (chatList: ChatSession[]) =>
    chatList.slice(0, 2000).map(chat => ({
      id: chat.id,
      title: chat.title,
      updatedAt: chat.updatedAt,
      isFavorite: chat.isFavorite,
      workspacePath: chat.workspacePath,
      runLocation: chat.runLocation,
    }));
  const persistChats = async (chatList: ChatSession[], keepalive = false): Promise<void> => {
    const persistenceSignature = (chat: ChatSession) => {
      const logs = chat.traceLogs || [];
      const tailSignature = logs.slice(-12).map((log: any) => {
        const text = String(log?.text || log?.output || log?.content || '');
        return [log?.id || '', log?._traceIdx ?? '', log?.type || '', log?.status || '', text.length, text.slice(-64)].join(':');
      }).join('~');
      return [
        chat.updatedAt, chat.title, chat.isFavorite ? 1 : 0, chat.workspacePath || '', chat.runLocation || '',
        logs.length, tailSignature,
      ].join('|');
    };
    const nextSignatures = new Map(chatList.map(chat => [chat.id, persistenceSignature(chat)]));
    const previousSignatures = persistedChatSignaturesRef.current;
    const changedChats = chatList.filter(chat => previousSignatures.get(chat.id) !== nextSignatures.get(chat.id));
    const hasDeletion = Array.from(previousSignatures.keys()).some(id => !nextSignatures.has(id));
    if (changedChats.length === 0 && !hasDeletion) return;

    const stripped = stripChatsForStorage(changedChats);
    const chatIds = chatList.map(chat => chat.id);
    const savedAt = Math.max(Date.now(), lastChatSnapshotAtRef.current + 1);
    lastChatSnapshotAtRef.current = savedAt;
    try {
      localStorage.setItem(CHAT_INDEX_STORAGE_KEY, JSON.stringify({
        version: 1,
        savedAt,
        chats: stripChatsForBrowserIndex(chatList),
      }));
    } catch { }
    try {
      localStorage.setItem('eterx_chats', JSON.stringify(stripChatsForBrowserCache(chatList)));
      localStorage.setItem('eterx_chats_saved_at', String(savedAt));
    } catch { }
    // Before the authoritative AppData snapshot is merged, some sidebar rows
    // contain metadata or bounded cache tails only. Never let those replace a
    // complete durable transcript.
    if (!chatSnapshotReadyRef.current) return;
    const desktopSave = (window as any).electronAPI?.saveChatSnapshot;
    if (desktopSave) {
      const saved = await desktopSave({ savedAt, chats: stripped, chatIds, partial: true })
        .then(() => true)
        .catch(() => false);
      if (saved) persistedChatSignaturesRef.current = nextSignatures;
      return;
    }
    const saved = await fetch('/api/chats', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ savedAt, chats: stripped, chatIds, partial: true }),
      keepalive,
    }).then(response => response.ok).catch(() => false);
    if (saved) persistedChatSignaturesRef.current = nextSignatures;
  };
  useEffect(() => {
    const flushChatSnapshot = () => {
      if (localStorageTimerRef.current) {
        clearTimeout(localStorageTimerRef.current);
        localStorageTimerRef.current = null;
      }
      pendingLocalStorageWrite.current = false;
      void persistChats(chatsRef.current, true);
    };
    window.addEventListener('pagehide', flushChatSnapshot);
    window.addEventListener('beforeunload', flushChatSnapshot);
    return () => {
      window.removeEventListener('pagehide', flushChatSnapshot);
      window.removeEventListener('beforeunload', flushChatSnapshot);
    };
  }, []);
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
  const interAgentMessageLog = (message: any, agentNameOverride?: string, subAgentIdentity?: string) => {
    const at = normalizeClientTraceTime(message?.timestamp, Date.now());
    const agentName = agentNameOverride || (message?.to && message.to !== '*' && message.to !== 'Main' ? message.to : message?.from);
    const resolvedSubAgentChatId = message?.subAgentChatId || message?.metadata?.subAgentChatId || subAgentIdentity;
    const resolvedSubAgentId = message?.subAgentId || message?.metadata?.subAgentId || subAgentIdentity;
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
      subAgentId: agentName && agentName !== 'Main' ? resolvedSubAgentId : undefined,
      subAgentChatId: agentName && agentName !== 'Main' ? resolvedSubAgentChatId : undefined,
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
  const agentStatusLog = (
    status: 'stopped' | 'failed' | 'warning',
    title: string,
    detail: string,
    at = Date.now(),
  ) => ({
    type: 'agent_status',
    status,
    title,
    text: detail,
    detail,
    timestamp: at,
    startTime: at,
    endTime: at,
  });

  const removeRunningChat = (chatId: string) => {
    // Mark as stopping so reconcileDetachedPollers won't re-add during the cleanup race window
    stoppingChatsRef.current.add(chatId);
    setTimeout(() => stoppingChatsRef.current.delete(chatId), 4000);
    setRunningChats(prev => {
      if (!prev.has(chatId)) return prev;
      const next = new Set(prev);
      next.delete(chatId);
      return next;
    });
    if (activeChatIdRef.current === chatId) {
      clearUnreadChat(chatId);
    }
    setPendingSteering(previous => previous.filter(message => message.chatId !== chatId));
  };

  const setChatLogsById = (
    chatId: string,
    nextLogsOrUpdater: any[] | ((prev: any[]) => any[]),
    options: { touchUpdatedAt?: boolean } = {}
  ) => {
    if (activeChatIdRef.current === chatId) {
      setTraceLogs(prevLogs => {
        if (activeChatIdRef.current !== chatId) return prevLogs;
        return typeof nextLogsOrUpdater === 'function'
          ? nextLogsOrUpdater(prevLogs)
          : nextLogsOrUpdater;
      });
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
      persistChats(sorted);
      return sorted;
    });
  };

  const clearAgentConnectionStatus = (chatId: string) => {
    setChatLogsById(chatId, logs => stripAgentConnectionLogs(logs));
  };

  const hydrateChatHistory = (chatId: string) => {
    if (hydratedChatIdsRef.current.has(chatId)) return;
    if (chatDetailRequestsRef.current.has(chatId)) return;

    const desktopLoad = (window as any).electronAPI?.loadChatSnapshot;
    const detailRequest = desktopLoad
      ? desktopLoad(chatId)
      : fetch(`/api/chats?id=${ encodeURIComponent(chatId) }`, { cache: 'no-store' })
          .then(response => response.ok ? response.json() : Promise.reject(new Error(`Chat load HTTP ${ response.status }`)));

    const request = detailRequest
      .then((payload: any) => {
        const durableChat = payload?.chat as ChatSession | null;
        if (!durableChat?.id || durableChat.id !== chatId) return;
        hydratedChatIdsRef.current.add(chatId);

        const currentChat = chatsRef.current.find(chat => chat.id === chatId);
        const hydratedChat = enforceChatTraceOwnership(currentChat
          ? mergeCachedChatIntoDurable(durableChat, currentChat)
          : durableChat);
        setChats(currentChats => currentChats.map(currentChat => {
          if (currentChat.id !== chatId) return currentChat;
          return enforceChatTraceOwnership(
            mergeCachedChatIntoDurable(hydratedChat, currentChat)
          );
        }));

        if (activeChatIdRef.current === chatId) {
          setTraceLogs(currentLogs => {
            if (activeChatIdRef.current !== chatId) return currentLogs;
            return mergeCachedChatIntoDurable(
              hydratedChat,
              { ...hydratedChat, traceLogs: currentLogs }
            ).traceLogs || [];
          });
          setActiveWorkspacePath(hydratedChat.workspacePath || null);
        }
      })
      .catch(() => {
        // The bounded browser cache remains usable while AppData is temporarily
        // unavailable. A later open retries because the ID is not marked hydrated.
      })
      .finally(() => {
        chatDetailRequestsRef.current.delete(chatId);
      });

    chatDetailRequestsRef.current.set(chatId, request);
  };

  const loadChat = (id: string) => {
    // Read through the live ref so a sidebar callback from an earlier render
    // cannot hydrate the chat with an older in-memory stream snapshot.
    let chat = chatsRef.current.find(c => c.id === id);
    if (chat) chat = enforceChatTraceOwnership(chat);

    const queuedUpdates = backgroundChatUpdatesRef.current.get(id);
    if (chat && queuedUpdates?.length) {
      let latestLogs = chat.traceLogs || [];
      for (const update of queuedUpdates) latestLogs = update(latestLogs);
      chat = { ...chat, traceLogs: latestLogs };
      backgroundChatUpdatesRef.current.delete(id);
      setChats(current => current.map(item => item.id === id ? chat! : item));
    }

    if (chat) {
      // Sub-agent tabs are scoped to a chat/turn, never globally across chats.
      setActiveSubAgentTab(null);
      setSubAgentDockOpen(false);
      setOverflowDropdownOpen(false);
      setAgentTeamOpen(false);
      activeChatIdRef.current = id;
      setActiveChatId(id);
      try { localStorage.setItem(ACTIVE_CHAT_STORAGE_KEY, id); } catch { }
      setTraceLogs(chat.traceLogs || []);
      hydrateChatHistory(id);
      setActiveWorkspacePath(chat.workspacePath || null);
      if (typeof window !== 'undefined') {
        if (chat.workspacePath) {
          localStorage.setItem('eterx_active_workspace_path', chat.workspacePath);
        } else {
          localStorage.removeItem('eterx_active_workspace_path');
        }
      }
      const storedState = composerStates[id];
      applyComposerState(storedState || (chat.runLocation ? {
        inputValue: '',
        runLocation: chat.runLocation,
        selectedAgent: composerRuntimeSelectionRef.current.selectedAgent,
        agentMode: composerRuntimeSelectionRef.current.agentMode,
        thinkingLevel: composerRuntimeSelectionRef.current.thinkingLevel,
        attachments: [],
        pinnedItems: [],
        chatModelSelection: composerRuntimeSelectionRef.current.modelSelection,
      } : undefined));
      clearUnreadChat(id);
      if (window.innerWidth < 960) setSidebarOpen(false);

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
        // Already polling — the poller itself manages runningChats lifecycle.
        // Do NOT blindly re-add here; it creates a race with removeRunningChat.
      } else {
        // No poller — check server for a running agent
        fetchAgentPoll(id, -1, 5000)
          .then(data => {
            const currentChat = chatsRef.current.find(candidate => candidate.id === id);
            if (!currentChat) return;

            if (data.status === 'running') {
              // Agent is running! Merge server traces into the current turn.
              if (data.traces && data.traces.length > 0) {
                const mergedLogs = mergeServerRunLogs(currentChat.traceLogs || [], data.traces, {
                  runId: data.runId,
                  startedAt: data.startedAt,
                });

                if (activeChatIdRef.current === id) {
                  setTraceLogs(mergedLogs);
                }
                setChats(prev => {
                  const updated = prev.map(c => c.id === id ? { ...c, traceLogs: mergedLogs } : c);
                  persistChats(updated);
                  return updated;
                });
              }
              setRunningChats(prev => new Set(prev).add(id));
              startPolling(id, data.maxIndex ?? (data.totalTraces - 1), data.startedAt, data.runId);
            }
          })
          .catch(() => { /* offline — just show local state */ });
      }

      setTimeout(() => {
        const container = document.getElementById('chat-container');
        if (container) {
          const savedScroll = chatScrollPositionsRef.current[id];
          if (savedScroll !== undefined) {
            container.scrollTop = savedScroll;
          } else {
            container.scrollTop = container.scrollHeight;
          }
        }
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
        persistChats(updated);
        return updated;
      });
    }
  }, [activeChatId]);

  const handleRunLocationChange = useCallback((location: 'local' | 'sandbox') => {
    setActiveRunLocation(location);
    updateComposerState(state => ({ ...state, runLocation: location }));
    if (activeChatId) {
      setChats(prev => {
        const updated = prev.map(chat => chat.id === activeChatId ? { ...chat, runLocation: location } : chat);
        persistChats(updated);
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
        chatsRef.current = updated;
        persistChats(updated);
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
    if (activeChatIdRef.current?.startsWith('agent_builder_')) {
      activeChatIdRef.current = null;
      setActiveChatId(null);
      setTraceLogs([]);
      setMonitorOpen(false);
    }
    handleAgentChange(agentId, agentName);
    setBuildingAgentId(null);
    setActiveView('chat');
    updateInputValue('');
  }, [handleAgentChange, updateInputValue]);

  const createNewChat = useCallback(() => {
    setChats(previous => {
      const updated = removeGeneratedEmptyChats(previous);
      if (updated.length === previous.length) return previous;
      persistChats(updated);
      return updated;
    });
    setActiveSubAgentTab(null);
    setSubAgentDockOpen(false);
    setOverflowDropdownOpen(false);
    setAgentTeamOpen(false);
    activeChatIdRef.current = null;
    setActiveChatId(null);
    setMonitorOpen(false);
    setTraceLogs([]);
    const storedState = composerStates['new_chat'];
    const hasSavedDraft = Boolean(storedState?.inputValue?.trim() || storedState?.attachments?.length);
    if (storedState && !hasSavedDraft) {
      const defaultModelSelection = readRuntimeChatModelSelection();
      const refreshedState: ChatComposerState = {
        ...storedState,
        selectedAgent: readSelectedAgentState(),
        chatModelSelection: defaultModelSelection,
        agentMode: readRuntimeAgentMode(storedState.agentMode || 'think', defaultModelSelection),
      };
      applyComposerState(refreshedState);
      updateComposerState(() => refreshedState);
    } else {
      applyComposerState(storedState);
    }
    setBuildingAgentId(null);
    setTimeout(() => {
      const container = document.getElementById('chat-container');
      if (container) {
        const savedScroll = chatScrollPositionsRef.current['new_chat'];
        if (savedScroll !== undefined) {
          container.scrollTop = savedScroll;
        } else {
          container.scrollTop = container.scrollHeight;
        }
      }
    }, 50);
  }, [composerStates, applyComposerState, updateComposerState]);

  const deleteChats = useCallback((ids: string[]) => {
    const idsToDelete = [...new Set(ids)].filter(Boolean);
    if (idsToDelete.length === 0) return;

    const deleteSet = new Set(idsToDelete);
    idsToDelete.forEach(chatId => pendingChatDeletionIdsRef.current.add(chatId));
    if (liveChatIdRef.current && deleteSet.has(liveChatIdRef.current)) {
      stopLiveSession();
    }
    const deletingActiveChat = !!activeChatId && deleteSet.has(activeChatId);
    if (deletingActiveChat) activeChatIdRef.current = null;

    if (localStorageTimerRef.current) {
      clearTimeout(localStorageTimerRef.current);
      localStorageTimerRef.current = null;
    }
    pendingLocalStorageWrite.current = false;

    idsToDelete.forEach(chatId => {
      pendingTitleRequestsRef.current.delete(chatId);
      const timeoutId = pollingIntervalsRef.current.get(chatId);
      if (timeoutId) clearTimeout(timeoutId);
      pollingIntervalsRef.current.delete(chatId);
      pollCursorsRef.current.delete(chatId);
      pollRunStartRef.current.delete(chatId);
      pollRunIdRef.current.delete(chatId);
      pollGenerationRef.current.set(chatId, (pollGenerationRef.current.get(chatId) || 0) + 1);
      catchUpPollersRef.current.delete(chatId);
      notifiedChatIdsRef.current.delete(chatId);
      abortControllersRef.current.get(chatId)?.abort();
      abortControllersRef.current.delete(chatId);
      fetch('/api/agent/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId })
      }).catch(() => { });
    });

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
      persistChats(updated);
      return updated;
    });

    if (deletingActiveChat) {
      setActiveChatId(null);
      setTraceLogs([]);
      setBuildingAgentId(null);
    }
  }, [activeChatId, stopLiveSession]);

  const deleteChat = useCallback((id: string) => {
    deleteChats([id]);
  }, [deleteChats]);

  const renameChat = useCallback((id: string, newTitle: string) => {
    setChats(prev => {
      const updated = prev.map(c =>
        c.id === id ? { ...c, title: newTitle, updatedAt: Date.now() } : c
      );
      const sorted = sortChats(updated);
      persistChats(sorted);
      return sorted;
    });
  }, []);

  const toggleFavorite = useCallback((id: string) => {
    setChats(prev => {
      const updated = prev.map(c =>
        c.id === id ? { ...c, isFavorite: !c.isFavorite } : c
      );
      const sorted = sortChats(updated);
      persistChats(sorted);
      return sorted;
    });
  }, []);

  const fetchGeneratedTitle = async (history: any[], currentTitle?: string, mode: MainAgentMode = agentMode): Promise<string | null> => {
    const res = await fetch('/api/chat/title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        history,
        currentTitle: currentTitle || DEFAULT_CHAT_TITLE,
        mode
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
          persistChats(sorted);
          return sorted;
        });
      }
    } catch (e) {
      console.warn('[Naming] Background naming failed:', e);
    }
  };

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    const key = activeChatId || 'new_chat';
    chatScrollPositionsRef.current[key] = scrollTop;
    const next = scrollHeight - scrollTop - clientHeight > 100;
    setShowScrollBottom(prev => prev === next ? prev : next);
  }, [activeChatId]);

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
      persistChats(sorted);
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
  const orderServerTraces = (items: any[]) => items
    .map((trace, inputOrder) => ({ trace, inputOrder }))
    .sort((left, right) => {
      const leftIndex = Number(left.trace?._traceIdx);
      const rightIndex = Number(right.trace?._traceIdx);
      const leftHasIndex = Number.isFinite(leftIndex);
      const rightHasIndex = Number.isFinite(rightIndex);
      if (leftHasIndex && rightHasIndex && leftIndex !== rightIndex) return leftIndex - rightIndex;

      const leftTime = Number(left.trace?.startTime ?? left.trace?.timestamp ?? left.trace?.endTime);
      const rightTime = Number(right.trace?.startTime ?? right.trace?.timestamp ?? right.trace?.endTime);
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
        if (leftTime !== rightTime) return leftTime - rightTime;
        if (leftHasIndex !== rightHasIndex) return left.inputOrder - right.inputOrder;
      }
      if (leftHasIndex !== rightHasIndex) return leftHasIndex ? -1 : 1;
      return left.inputOrder - right.inputOrder;
    })
    .map(entry => entry.trace);

  const isSameOptimisticUserBoundary = (localLog: any, incomingLog: any) => {
    if (localLog?.type !== 'user_action' || incomingLog?.type !== 'user_action') return false;
    if (localLog._traceIdx !== undefined && localLog._traceIdx !== null) return false;
    const localRunId = String(localLog.runId || localLog.turnId || '').trim();
    const incomingRunId = String(incomingLog.runId || incomingLog.turnId || '').trim();
    if (!localRunId || localRunId !== incomingRunId) return false;

    // A Proxy directive can add another visible user boundary without changing
    // the server run ID. Text/source equality is therefore required before a
    // server event may replace the locally-created optimistic user bubble.
    const localText = String(localLog.text || '').replace(/\r\n/g, '\n').trim();
    const incomingText = String(incomingLog.text || '').replace(/\r\n/g, '\n').trim();
    if (!localText || localText !== incomingText) return false;
    const localSource = String(localLog.source || 'human').trim().toLowerCase();
    const incomingSource = String(incomingLog.source || 'human').trim().toLowerCase();
    return localSource === incomingSource;
  };

  const processServerTraces = (traces: any[], existingLogs: any[] = []): any[] => {
    const logs: any[] = Array.isArray(existingLogs) ? [...existingLogs] : [];
    const lastUserIdx = existingLogs.reduceRight((found, l, i) => found === -1 && l.type === 'user_action' ? i : found, -1);
    const currentTurnStart = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
    const incomingRunId = String(
      traces.find((trace: any) => trace?.runId || trace?.turnId)?.runId ||
      traces.find((trace: any) => trace?.runId || trace?.turnId)?.turnId ||
      ''
    ).trim();
    // Proxy guidance creates another visible user boundary inside the same
    // server run. Trace indices remain run-scoped, so catch-up snapshots must
    // deduplicate against the whole run rather than only the latest bubble.
    const dedupScope = incomingRunId
      ? existingLogs.filter((log: any) => String(log?.runId || log?.turnId || '').trim() === incomingRunId)
      : lastUserIdx >= 0 ? existingLogs.slice(lastUserIdx) : existingLogs;
    const seenTraceIdx = new Set(
      dedupScope
        .map((log: any) => log?._traceIdx)
        .filter((idx: any) => idx !== undefined && idx !== null)
    );
    for (const trace of orderServerTraces(traces)) {
      // Trace indices restart between runs but remain stable across all
      // delegated turns inside one run.
      if (trace._traceIdx !== undefined && trace._traceIdx !== null) {
        if (seenTraceIdx.has(trace._traceIdx)) continue;
        seenTraceIdx.add(trace._traceIdx);
      }

      let processedLog = withTraceTiming(trace);
      const traceAt = processedLog.endTime;
      closeThoughtStreamsForBoundary(logs, processedLog);
      if (processedLog.type === 'user_action') {
        const traceRunId = String(processedLog.runId || processedLog.turnId || '').trim();
        const traceUserId = String(processedLog.id || '').trim();
        const traceIndex = processedLog._traceIdx;
        const existingUserIdx = logs.findIndex((log: any) => {
          if (log?.type !== 'user_action') return false;
          const sameEventId = traceUserId && String(log.id || '').trim() === traceUserId;
          const sameTraceIndex = traceIndex !== undefined && traceIndex !== null && log._traceIdx === traceIndex;
          const optimisticRunMatch = traceRunId && isSameOptimisticUserBoundary(log, processedLog);
          return Boolean(sameEventId || sameTraceIndex || optimisticRunMatch);
        });
        if (existingUserIdx >= 0) {
          const optimisticUserLog = logs[existingUserIdx];
          logs[existingUserIdx] = {
            ...processedLog,
            ...optimisticUserLog,
            id: processedLog.id || optimisticUserLog.id,
            source: processedLog.source || optimisticUserLog.source,
            delegatedBy: processedLog.delegatedBy || optimisticUserLog.delegatedBy,
            _traceIdx: processedLog._traceIdx,
          };
          continue;
        }
      }

      // Preserve isLive status if this trace matches a local log that was marked as live
      if (trace.type === 'command' || trace.type === 'answer') {
        const localMatch = dedupScope.find(l =>
          l.type === trace.type &&
          (l.text === trace.text || (trace._traceIdx !== undefined && l._traceIdx === trace._traceIdx))
        );
        if (localMatch?.isLive) {
          processedLog.isLive = true;
        }
      }

      if (trace.type === 'answer_cancel') {
        const answerId = String(trace.answerId || '').trim();
        for (let i = logs.length - 1; i >= 0; i--) {
          if (logs[i].type === 'user_action') break;
          if (
            logs[i].type === 'answer' &&
            (logs[i].isStreaming || logs[i].isLiveTyping) &&
            (!answerId || String(logs[i].answerId || '') === answerId)
          ) {
            logs.splice(i, 1);
            break;
          }
        }
        continue;
      }

      if (trace.type === 'work_note_cancel') {
        const subAgent = trace.subAgent || null;
        const subAgentIdentity = trace.subAgentChatId || trace.subAgentId || subAgent;
        const noteId = trace.noteId || null;
        // Mark rather than splice — prevents flash when final work_note follows
        for (let i = logs.length - 1; i >= 0; i--) {
          if (logs[i].type === 'user_action') break;
          if (
            logs[i].type === 'work_note' &&
            (logs[i].subAgentChatId || logs[i].subAgentId || logs[i].subAgent || null) === subAgentIdentity &&
            (!noteId || logs[i].noteId === noteId)
          ) {
            const existingTraceIdx = Number(logs[i]._traceIdx);
            const cancellationTraceIdx = Number(trace._traceIdx);
            if (
              Number.isFinite(existingTraceIdx) &&
              Number.isFinite(cancellationTraceIdx) &&
              cancellationTraceIdx < existingTraceIdx
            ) {
              break;
            }
            logs[i] = { ...logs[i], _streamingCancelled: true };
            break;
          }
        }
        continue;
      }

      if (trace.type === 'thought_stream') {
        mergeThoughtStreamTrace(logs, processedLog);
      } else if (trace.type === 'work_note') {
        const subAgent = trace.subAgent || null;
        const subAgentIdentity = trace.subAgentChatId || trace.subAgentId || subAgent;
        const noteId = trace.noteId || null;
        const incomingIsFinal = trace.isStreaming === false || trace.isDelta === false;
        const noteText = formatVisibleWorkNote(String(trace.text || ''));
        if (!noteText) continue;
        let mergeIdx = -1;
        let duplicateIdx = -1;
        for (let i = logs.length - 1; i >= 0; i--) {
          if (logs[i].type === 'user_action') break;
          if (
            logs[i].type === 'work_note' &&
            (logs[i].subAgentChatId || logs[i].subAgentId || logs[i].subAgent || null) === subAgentIdentity
          ) {
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
            const existingIsStreaming =
              logs[i].isStreaming === true ||
              logs[i].isLiveTyping === true ||
              logs[i].isDelta === true;
            if (
              (!noteId || !logs[i].noteId) &&
              (existingIsStreaming || !incomingIsFinal)
            ) {
              mergeIdx = i;
              break;
            }
          }
        }
        if (duplicateIdx >= 0) continue;
        if (mergeIdx >= 0) {
          const existingTraceIdx = Number(logs[mergeIdx]._traceIdx);
          const incomingTraceIdx = Number(trace._traceIdx);
          if (
            Number.isFinite(existingTraceIdx) &&
            Number.isFinite(incomingTraceIdx) &&
            incomingTraceIdx < existingTraceIdx
          ) {
            continue;
          }
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

        const existingAsk = dedupScope.find((l: any) =>
          l.type === 'ask_user' &&
          (responseKey ? l.responseKey === responseKey : String(l.question || '').trim() === question)
        );

        const nextAskLog = {
          ...processedLog,
          ...trace,
          type: 'ask_user',
          question,
          responseKey: responseKey || processedLog.responseKey,
          timestamp: Number(trace.timestamp || processedLog.timestamp || traceAt),
          startTime: processedLog.startTime,
          endTime: traceAt,
          answeredWith: existingAsk?.answeredWith || trace.answeredWith,
          answeredAt: existingAsk?.answeredAt || trace.answeredAt,
        };

        if (askIdx >= 0) {
          logs[askIdx] = {
            ...logs[askIdx],
            ...nextAskLog,
            answeredWith: nextAskLog.answeredWith || logs[askIdx].answeredWith,
            answeredAt: nextAskLog.answeredAt || logs[askIdx].answeredAt,
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
          const existingTraceIdx = Number(logs[answerIdx]._traceIdx);
          const incomingTraceIdx = Number(trace._traceIdx);
          if (
            Number.isFinite(existingTraceIdx) &&
            Number.isFinite(incomingTraceIdx) &&
            incomingTraceIdx < existingTraceIdx
          ) {
            continue;
          }
          const incomingIsStreaming = trace.isStreaming === true || trace.isLiveTyping === true;
          logs[answerIdx] = {
            ...logs[answerIdx],
            ...processedLog,
            text: trace.text,
            _traceIdx: trace._traceIdx,
            isLive: processedLog.isLive,
            isStreaming: incomingIsStreaming,
            isLiveTyping: incomingIsStreaming,
            wasStreaming: Boolean(
              logs[answerIdx].wasStreaming ||
              logs[answerIdx].isStreaming ||
              logs[answerIdx].isLiveTyping ||
              trace.wasStreaming ||
              incomingIsStreaming
            ),
          };
        } else {
          logs.push(processedLog);
        }
      } else if (trace.type === 'file_preview') {
        const stablePreviewRelativeIdx = logs.slice(currentTurnStart).findLastIndex((l: any) =>
          l.type === 'file_preview' && (
            (trace._traceIdx !== undefined && trace._traceIdx !== null && l._traceIdx === trace._traceIdx) ||
            (trace.traceId && l.traceId === trace.traceId) ||
            (trace.id && l.id === trace.id)
          )
        );
        const stablePreviewIdx = stablePreviewRelativeIdx >= 0
          ? currentTurnStart + stablePreviewRelativeIdx
          : -1;
        if (stablePreviewIdx >= 0) {
          logs[stablePreviewIdx] = { ...processedLog, startTime: logs[stablePreviewIdx].startTime || processedLog.startTime, endTime: traceAt };
        } else {
          const tracePreviewPath = String(trace.filepath || trace.filename || '');
          const existingIdx = trace.ownerTraceId
            ? (() => {
              const relativeIdx = logs.slice(currentTurnStart).findLastIndex((l: any) =>
                l.type === 'file_preview' &&
                l.ownerTraceId === trace.ownerTraceId &&
                (!tracePreviewPath || String(l.filepath || l.filename || '') === tracePreviewPath)
              );
              return relativeIdx >= 0 ? currentTurnStart + relativeIdx : -1;
            })()
            : trace.dedupe !== false
              ? (() => {
                const relativeIdx = logs.slice(currentTurnStart).findLastIndex((l: any) =>
                  l.type === 'file_preview' && l.filepath === trace.filepath && l.dedupe !== false
                );
                return relativeIdx >= 0 ? currentTurnStart + relativeIdx : -1;
              })()
              : -1;
          if (existingIdx >= 0) {
            logs[existingIdx] = { ...processedLog, startTime: logs[existingIdx].startTime || processedLog.startTime, endTime: traceAt };
          } else {
            logs.push(processedLog);
          }
        }
      } else if (trace.type === 'console_output') {
        const currentTurnLogs = logs.slice(currentTurnStart);
        const relativeMergeIdx = findMergeableConsoleOutputIndex(currentTurnLogs, trace);
        const mergeIdx = relativeMergeIdx >= 0 ? currentTurnStart + relativeMergeIdx : -1;
        if (mergeIdx >= 0) {
          logs[mergeIdx] = {
            ...logs[mergeIdx],
            ...processedLog,
            _traceIdx: trace._traceIdx ?? logs[mergeIdx]._traceIdx,
            startTime: logs[mergeIdx].startTime || processedLog.startTime,
            endTime: traceAt,
            timestamp: traceAt,
          };
        } else if (!isDuplicateConsoleOutput(currentTurnLogs, trace)) {
          logs.push(processedLog);
        }
      } else if (trace.type === 'done') {
        // Skip — handled by polling completion
      } else if (trace.type === 'error') {
        logs.push({ type: 'thought_stream', text: `Error: ${ trace.data || trace.text || 'Unknown error' }`, _traceIdx: trace._traceIdx, timestamp: traceAt, startTime: traceAt, endTime: traceAt });
      } else {
        // When a real (non-instant) action trace arrives, remove any preceding _instant preview
        if (!trace._instant && (trace.type === 'command' || trace.type === 'file_edit' || trace.type === 'exploration')) {
          const relativeInstantIdx = logs.slice(currentTurnStart).findIndex(l => l._instant && l.type === trace.type);
          const instantIdx = relativeInstantIdx >= 0 ? currentTurnStart + relativeInstantIdx : -1;
          if (instantIdx >= 0) logs.splice(instantIdx, 1);
        }
        // Skip _instant traces if a real trace of same type already exists
        if (trace._instant && logs.slice(currentTurnStart).some(l => !l._instant && (l.type === 'command' || l.type === 'file_edit' || l.type === 'exploration'))) {
          continue;
        }
        logs.push(processedLog);
      }
    }
    return logs;
  };

  const canMergeServerRunIntoLatestTurn = (
    existingLogs: any[],
    runIdentity: { runId?: string; startedAt?: number } = {}
  ) => {
    const latestUserLog = [...existingLogs].reverse().find((log: any) => log?.type === 'user_action');
    if (!latestUserLog) return true;

    const latestRunId = String(latestUserLog.runId || latestUserLog.turnId || '').trim();
    const serverRunId = String(runIdentity.runId || '').trim();
    const turnStartedAt = Number(latestUserLog.startTime || latestUserLog.timestamp || latestUserLog.endTime || 0);
    const serverStartedAt = Number(runIdentity.startedAt || 0);

    // New UI turns always have a run ID. A matching ID is authoritative; a
    // missing ID must still prove freshness through its server start time.
    if (latestRunId) {
      if (serverRunId) return latestRunId === serverRunId;
      if (turnStartedAt > 0 && serverStartedAt > 0) return serverStartedAt >= turnStartedAt;
      return false;
    }

    // Legacy saved turns may predate run IDs, so use strict chronological
    // ownership. Client and task-store timestamps share the same local clock.
    return !(turnStartedAt > 0 && serverStartedAt > 0 && serverStartedAt < turnStartedAt);
  };

  const filterServerTracesForRun = (traces: any[], expectedRunId?: string): any[] => {
    if (!Array.isArray(traces)) return [];
    const ownerRunId = String(expectedRunId || '').trim();
    if (!ownerRunId) return traces;
    return traces.filter((trace: any) => {
      const traceRunId = String(trace?.runId || trace?.turnId || '').trim();
      // Once a poll declares a run owner, unowned payloads are unsafe. Current
      // registry/task-store events always carry this ID; silently accepting a
      // missing one can splice legacy or malformed data into the active turn.
      return traceRunId === ownerRunId;
    });
  };

  const mergeServerRunLogs = (
    existingLogs: any[],
    traces: any[],
    runIdentity: { runId?: string; startedAt?: number } = {}
  ) => {
    const scopedTraces = filterServerTracesForRun(traces, runIdentity.runId);
    if (scopedTraces.length === 0) return Array.isArray(existingLogs) ? [...existingLogs] : [];
    const incomingUserLog = scopedTraces.find((trace: any) => trace?.type === 'user_action');
    const incomingRunId = String(
      runIdentity.runId || incomingUserLog?.runId || incomingUserLog?.turnId || ''
    ).trim();
    // Poll/recovery snapshots are per-run, while trace indices restart at zero.
    // A successor autonomous run is authoritative only when its own snapshot
    // includes the user-action boundary that created it. Process that snapshot
    // in isolation so trace indices restarted at zero cannot collide with the
    // preceding run, then append it as a new conversation turn.
    if (!canMergeServerRunIntoLatestTurn(existingLogs, runIdentity)) {
      if (incomingUserLog && incomingRunId) {
        const alreadyPresent = existingLogs.some((log: any) =>
          log?.type === 'user_action' &&
          String(log.runId || log.turnId || '').trim() === incomingRunId
        );
        const successorTraces = scopedTraces.map((trace: any) => ({
          ...trace,
          runId: incomingRunId,
          turnId: incomingRunId,
        }));
        if (alreadyPresent) {
          return processServerTraces(successorTraces, existingLogs);
        }
        return [
          ...(Array.isArray(existingLogs) ? existingLogs : []),
          ...processServerTraces(successorTraces, []),
        ];
      }
      return Array.isArray(existingLogs) ? [...existingLogs] : [];
    }
    // Catch-up endpoints return a full run snapshot. Feed that snapshot through
    // the same semantic upsert rules as live polling so streaming thoughts,
    // work notes, answers, previews, and console output retain one stable row.
    const latestUserLog = [...existingLogs].reverse().find((log: any) => log?.type === 'user_action');
    const turnId = String(latestUserLog?.turnId || latestUserLog?.runId || runIdentity.runId || '').trim();
    const ownedTraces = scopedTraces.map((trace: any) => ({
      ...trace,
      ...(runIdentity.runId ? { runId: runIdentity.runId } : {}),
      ...(turnId ? { turnId } : {}),
    }));
    return processServerTraces(ownedTraces, existingLogs);
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
          persistChats(currentChats);
          return currentChats; // Don't modify state
        });
      }
    }, 4000); // Durable task traces save every 500ms; snapshot the heavy UI state less often.
  };

  const flushBackgroundChatUpdates = () => {
    if (backgroundUpdateTimerRef.current !== null) {
      window.clearTimeout(backgroundUpdateTimerRef.current);
      backgroundUpdateTimerRef.current = null;
    }
    if (backgroundChatUpdatesRef.current.size === 0) return;
    const pending = new Map(backgroundChatUpdatesRef.current);
    backgroundChatUpdatesRef.current.clear();
    setChats(currentChats => {
      let changed = false;
      const updated = currentChats.map(chat => {
        const updaters = pending.get(chat.id);
        if (!updaters?.length) return chat;
        let logs = chat.traceLogs || [];
        for (const update of updaters) logs = update(logs);
        changed = true;
        return { ...chat, traceLogs: logs };
      });
      return changed ? updated : currentChats;
    });
  };

  const queueBackgroundChatUpdate = (chatId: string, updater: (logs: any[]) => any[]) => {
    const queued = backgroundChatUpdatesRef.current.get(chatId) || [];
    queued.push(updater);
    backgroundChatUpdatesRef.current.set(chatId, queued);
    if (backgroundUpdateTimerRef.current === null) {
      backgroundUpdateTimerRef.current = window.setTimeout(flushBackgroundChatUpdates, 120);
    }
  };

  useEffect(() => () => {
    if (backgroundUpdateTimerRef.current !== null) window.clearTimeout(backgroundUpdateTimerRef.current);
    backgroundUpdateTimerRef.current = null;
    backgroundChatUpdatesRef.current.clear();
  }, []);

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
  const startPolling = (
    chatId: string,
    initialCursor: number = -1,
    runStartedAfter?: number,
    expectedRunId?: string
  ) => {
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
    if (expectedRunId) {
      pollRunIdRef.current.set(chatId, expectedRunId);
    }

    pollCursorsRef.current.set(chatId, initialCursor);
    let idleCount = 0; // Track consecutive idle responses
    let errorBackoff = 0; // Exponential backoff on errors (0 = no error)
    let lastHadData = false; // Track if last poll had new data
    let pollInFlight = false;

    const finishDisconnectedStart = (message: string) => {
      stopPolling(chatId);
      clearAgentConnectionStatus(chatId);
      removeRunningChat(chatId);
      markChatUnreadIfBackground(chatId);
      setChatLogsById(chatId, logs => [
        ...stripAgentConnectionLogs(logs),
        agentStatusLog('failed', 'Agent unavailable', message)
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
      if (errorBackoff > 0) {
        delay = Math.min(5000, 500 * Math.pow(2, errorBackoff - 1)); // 500ms, 1s, 2s, 4s, 5s cap
      } else {
        // PERFORMANCE: Adaptive poll delay.
        // Very long active chats receive events in slightly larger batches so
        // React does not rebuild thousands of timeline entries five times/sec.
        const isActive = activeChatIdRef.current === chatId;
        const isLargeActiveChat = isActive && traceLogsLengthRef.current > 1500;
        const concurrentRuns = runningChatsRef.current.size;
        if (!isActive) {
          delay = concurrentRuns > 4
            ? (lastHadData ? 750 : 1500)
            : (lastHadData ? 400 : 900);
        } else {
          delay = isLargeActiveChat
            ? (lastHadData ? 250 : 600)
            : (lastHadData ? 120 : 350);
        }
      }

      const timeoutId = setTimeout(pollOnce, delay);
      pollingIntervalsRef.current.set(chatId, timeoutId as any);
    };

    // Reference to the poll function — registered with catchUpPollersRef so the
    // page visibility handler can trigger an immediate catch-up when user returns
    // (fixes the "UI burst" bug where all buffered traces appear at once)
    const pollOnce = async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      try {

        // Safety: if we were stopped while waiting, don't run
        if (!pollingIntervalsRef.current.has(chatId) || pollGenerationRef.current.get(chatId) !== pollGeneration) return;
        try {
          const cursor = pollCursorsRef.current.get(chatId) ?? -1;
          const data = await fetchAgentPoll(chatId, cursor);

          // The request may have been replaced while awaiting the response.
          if (!pollingIntervalsRef.current.has(chatId) || pollGenerationRef.current.get(chatId) !== pollGeneration) return;

          // Reset error backoff on successful fetch
          errorBackoff = 0;

          const expectedRunId = pollRunIdRef.current.get(chatId);
          const serverRunId = typeof data.runId === 'string' ? data.runId : '';
          const expectedRunStart = pollRunStartRef.current.get(chatId) || 0;
          const serverRunStart = typeof data.startedAt === 'number' ? data.startedAt : 0;
          if (expectedRunId && serverRunId !== expectedRunId) {
            // A queued or Proxy-started successor keeps the same chat ID but
            // receives a new internal run ID. Adopt a demonstrably newer run
            // instead of leaving the old poller waiting forever for its run.
            if (serverRunId && serverRunStart && serverRunStart >= expectedRunStart) {
              pollRunIdRef.current.set(chatId, serverRunId);
              pollRunStartRef.current.set(chatId, serverRunStart);
              pollCursorsRef.current.set(chatId, -1);
              lastHadData = false;
              scheduleNextPoll();
              return;
            }
            if (!handleStartPending()) return;
            return;
          }

          const isStaleServerRun = !!(expectedRunStart && serverRunStart && serverRunStart + 1000 < expectedRunStart);

          if (isStaleServerRun) {
            if (!handleStartPending()) return;
            return;
          }

          // Contain every incremental response to its declared run before any
          // dedupe or UI merge can erase the original ownership metadata.
          data.traces = filterServerTracesForRun(
            Array.isArray(data.traces) ? data.traces : [],
            serverRunId || expectedRunId,
          );

          // Track idle responses — stop after 30 seconds of continuous idle
          // (agent never started, or server restarted)
          for (const trace of data.traces) {
            const traceIdentity = String(
              trace?.id || trace?._traceIdx || trace?.responseKey || trace?.timestamp || Date.now()
            );
            if (trace?.type === 'ask_user') {
              announceLiveTaskEvent(
                chatId,
                'blocked',
                String(trace.question || trace.text || 'The task needs your input to continue.'),
                `${ serverRunId || expectedRunId || 'run' }_${ traceIdentity }`,
              );
            } else if (trace?.type === 'sub_agent_complete') {
              const agentName = String(trace.agentName || trace.subAgent || 'A delegated agent');
              announceLiveTaskEvent(
                chatId,
                'progress',
                `${ agentName } finished its part of the task. ${ String(trace.text || trace.summary || '') }`,
                `${ serverRunId || expectedRunId || 'run' }_${ traceIdentity }`,
              );
            } else if (trace?.type === 'progress') {
              const progressText = String(trace.text || trace.summary || '').trim();
              const lastAnnouncementAt = liveProgressAnnouncementAtRef.current.get(chatId) || 0;
              if (progressText && Date.now() - lastAnnouncementAt >= 45000) {
                liveProgressAnnouncementAtRef.current.set(chatId, Date.now());
                announceLiveTaskEvent(
                  chatId,
                  'progress',
                  progressText,
                  `${ serverRunId || expectedRunId || 'run' }_${ traceIdentity }`,
                );
              }
            }
          }

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
              const activeRunId = serverRunId || expectedRunId || '';
              const latestExistingUser = [...logs].reverse().find((log: any) => log?.type === 'user_action');
              const latestExistingRunId = String(latestExistingUser?.runId || latestExistingUser?.turnId || '').trim();
              const hasAuthoritativeSuccessorTurn = Boolean(
                activeRunId &&
                latestExistingRunId &&
                activeRunId !== latestExistingRunId &&
                data.traces.some((trace: any) => trace?.type === 'user_action')
              );
              if (hasAuthoritativeSuccessorTurn) {
                return mergeServerRunLogs(logs, data.traces, {
                  runId: activeRunId,
                  startedAt: serverRunStart,
                });
              }
              // Find start of current turn (after last user_action) for dedup scoping
              const lastUserIdx = logs.reduceRight((found, l, i) => found === -1 && l.type === 'user_action' ? i : found, -1);
              const currentTurnStart = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
              const currentTurnLogs = lastUserIdx >= 0 ? logs.slice(lastUserIdx) : logs;
              const currentUserLog = lastUserIdx >= 0 ? logs[lastUserIdx] : null;
              const currentTurnId = String(currentUserLog?.turnId || currentUserLog?.runId || activeRunId || '').trim();
              const activeRunLogs = activeRunId
                ? logs.filter((log: any) => String(log?.runId || log?.turnId || '').trim() === activeRunId)
                : currentTurnLogs;
              const seenTraceIdx = new Set(
                activeRunLogs
                  .map((log: any) => log?._traceIdx)
                  .filter((idx: any) => idx !== undefined && idx !== null)
              );
              for (const trace of orderServerTraces(data.traces)) {
                // One run may contain several Proxy-originated user turns.
                // Deduplicate server indices across that whole run.
                if (trace._traceIdx !== undefined && trace._traceIdx !== null) {
                  if (seenTraceIdx.has(trace._traceIdx)) continue;
                  seenTraceIdx.add(trace._traceIdx);
                }
                const timedTrace = withTraceTiming({
                  ...trace,
                  ...(activeRunId ? { runId: activeRunId } : {}),
                  ...(currentTurnId ? { turnId: currentTurnId } : {}),
                });
                const traceAt = timedTrace.endTime;
                closeThoughtStreamsForBoundary(logs, timedTrace);
                if (timedTrace.type === 'user_action') {
                  const traceRunId = String(timedTrace.runId || timedTrace.turnId || '').trim();
                  const traceUserId = String(timedTrace.id || '').trim();
                  const traceIndex = timedTrace._traceIdx;
                  const existingUserIdx = logs.findIndex((log: any) => {
                    if (log?.type !== 'user_action') return false;
                    const sameEventId = traceUserId && String(log.id || '').trim() === traceUserId;
                    const sameTraceIndex = traceIndex !== undefined && traceIndex !== null && log._traceIdx === traceIndex;
                    const optimisticRunMatch = traceRunId && isSameOptimisticUserBoundary(log, timedTrace);
                    return Boolean(sameEventId || sameTraceIndex || optimisticRunMatch);
                  });
                  if (existingUserIdx >= 0) {
                    const optimisticUserLog = logs[existingUserIdx];
                    logs[existingUserIdx] = {
                      ...timedTrace,
                      ...optimisticUserLog,
                      id: timedTrace.id || optimisticUserLog.id,
                      source: timedTrace.source || optimisticUserLog.source,
                      delegatedBy: timedTrace.delegatedBy || optimisticUserLog.delegatedBy,
                      _traceIdx: timedTrace._traceIdx,
                    };
                    continue;
                  }
                }

                if (trace.type === 'answer_cancel') {
                  const answerId = String(trace.answerId || '').trim();
                  for (let i = logs.length - 1; i >= 0; i--) {
                    if (logs[i].type === 'user_action') break;
                    if (
                      logs[i].type === 'answer' &&
                      (logs[i].isStreaming || logs[i].isLiveTyping) &&
                      (!answerId || String(logs[i].answerId || '') === answerId)
                    ) {
                      logs.splice(i, 1);
                      break;
                    }
                  }
                  continue;
                }

                if (trace.type === 'work_note_cancel') {
                  const subAgent = trace.subAgent || null;
                  const subAgentIdentity = trace.subAgentChatId || trace.subAgentId || subAgent;
                  const noteId = trace.noteId || null;
                  // Mark the streaming worknote as cancelled rather than removing it.
                  // This preserves its DOM position so the final permanent work_note
                  // merges into it in-place — preventing the flash/re-animate bug.
                  for (let i = logs.length - 1; i >= 0; i--) {
                    if (logs[i].type === 'user_action') break;
                    if (
                      logs[i].type === 'work_note' &&
                      (logs[i].subAgentChatId || logs[i].subAgentId || logs[i].subAgent || null) === subAgentIdentity &&
                      (!noteId || logs[i].noteId === noteId)
                    ) {
                      const existingTraceIdx = Number(logs[i]._traceIdx);
                      const cancellationTraceIdx = Number(trace._traceIdx);
                      if (
                        Number.isFinite(existingTraceIdx) &&
                        Number.isFinite(cancellationTraceIdx) &&
                        cancellationTraceIdx < existingTraceIdx
                      ) {
                        break;
                      }
                      logs[i] = { ...logs[i], _streamingCancelled: true };
                      break;
                    }
                  }
                  continue;
                }

                if (trace.type === 'thought_stream') {
                  mergeThoughtStreamTrace(logs, timedTrace);
                } else if (trace.type === 'work_note') {
                  const subAgent = trace.subAgent || null;
                  const subAgentIdentity = trace.subAgentChatId || trace.subAgentId || subAgent;
                  const noteId = trace.noteId || null;
                  const incomingIsFinal = trace.isStreaming === false || trace.isDelta === false;
                  const noteText = formatVisibleWorkNote(String(trace.text || ''));
                  if (!noteText) continue;
                  let mergeIdx = -1;
                  let duplicateIdx = -1;
                  for (let i = logs.length - 1; i >= 0; i--) {
                    if (logs[i].type === 'user_action') break;
                    if (
                      logs[i].type === 'work_note' &&
                      (logs[i].subAgentChatId || logs[i].subAgentId || logs[i].subAgent || null) === subAgentIdentity
                    ) {
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
                      const existingIsStreaming =
                        logs[i].isStreaming === true ||
                        logs[i].isLiveTyping === true ||
                        logs[i].isDelta === true;
                      if (
                        (!noteId || !logs[i].noteId) &&
                        (existingIsStreaming || !incomingIsFinal)
                      ) {
                        mergeIdx = i;
                        break;
                      }
                    }
                  }
                  if (duplicateIdx >= 0) continue;
                  if (mergeIdx >= 0) {
                    const existingTraceIdx = Number(logs[mergeIdx]._traceIdx);
                    const incomingTraceIdx = Number(trace._traceIdx);
                    if (
                      Number.isFinite(existingTraceIdx) &&
                      Number.isFinite(incomingTraceIdx) &&
                      incomingTraceIdx < existingTraceIdx
                    ) {
                      continue;
                    }
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
                      answeredWith: nextAskLog.answeredWith ?? logs[askIdx].answeredWith,
                      answeredAt: nextAskLog.answeredAt ?? logs[askIdx].answeredAt,
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
                    const existingTraceIdx = Number(logs[answerIdx]._traceIdx);
                    const incomingTraceIdx = Number(trace._traceIdx);
                    if (
                      Number.isFinite(existingTraceIdx) &&
                      Number.isFinite(incomingTraceIdx) &&
                      incomingTraceIdx < existingTraceIdx
                    ) {
                      continue;
                    }
                    const incomingIsStreaming = trace.isStreaming === true || trace.isLiveTyping === true;
                    logs[answerIdx] = {
                      ...logs[answerIdx],
                      ...timedTrace,
                      text: trace.text,
                      _traceIdx: trace._traceIdx,
                      isStreaming: incomingIsStreaming,
                      isLiveTyping: incomingIsStreaming,
                      wasStreaming: Boolean(
                        logs[answerIdx].wasStreaming ||
                        logs[answerIdx].isStreaming ||
                        logs[answerIdx].isLiveTyping ||
                        trace.wasStreaming ||
                        incomingIsStreaming
                      ),
                    };
                  } else {
                    logs.push(timedTrace);
                  }
                } else if (trace.type === 'file_preview') {
                  const stablePreviewRelativeIdx = logs.slice(currentTurnStart).findLastIndex((l: any) =>
                    l.type === 'file_preview' && (
                      (trace._traceIdx !== undefined && trace._traceIdx !== null && l._traceIdx === trace._traceIdx) ||
                      (trace.traceId && l.traceId === trace.traceId) ||
                      (trace.id && l.id === trace.id)
                    )
                  );
                  const stablePreviewIdx = stablePreviewRelativeIdx >= 0
                    ? currentTurnStart + stablePreviewRelativeIdx
                    : -1;
                  if (stablePreviewIdx >= 0) {
                    logs[stablePreviewIdx] = { ...timedTrace, startTime: logs[stablePreviewIdx].startTime || timedTrace.startTime, endTime: traceAt };
                  } else {
                    const tracePreviewPath = String(trace.filepath || trace.filename || '');
                    const existingIdx = trace.ownerTraceId
                      ? (() => {
                        const relativeIdx = logs.slice(currentTurnStart).findLastIndex((l: any) =>
                          l.type === 'file_preview' &&
                          l.ownerTraceId === trace.ownerTraceId &&
                          (!tracePreviewPath || String(l.filepath || l.filename || '') === tracePreviewPath)
                        );
                        return relativeIdx >= 0 ? currentTurnStart + relativeIdx : -1;
                      })()
                      : trace.dedupe !== false
                        ? (() => {
                          const relativeIdx = logs.slice(currentTurnStart).findLastIndex((l: any) =>
                            l.type === 'file_preview' && l.filepath === trace.filepath && l.dedupe !== false
                          );
                          return relativeIdx >= 0 ? currentTurnStart + relativeIdx : -1;
                        })()
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
                  const currentOutputLogs = logs.slice(currentTurnStart);
                  const relativeMergeIdx = findMergeableConsoleOutputIndex(currentOutputLogs, trace);
                  const mergeIdx = relativeMergeIdx >= 0 ? currentTurnStart + relativeMergeIdx : -1;
                  if (mergeIdx >= 0) {
                    logs[mergeIdx] = {
                      ...logs[mergeIdx],
                      ...timedTrace,
                      _traceIdx: trace._traceIdx ?? logs[mergeIdx]._traceIdx,
                      startTime: logs[mergeIdx].startTime || timedTrace.startTime,
                      endTime: traceAt,
                      timestamp: traceAt,
                    };
                  } else if (!isDuplicateConsoleOutput(currentOutputLogs, trace)) {
                    logs.push(timedTrace);
                  }
                } else if (trace.type === 'done' || trace.type === 'error') {
                  // Skip — handled by status check below
                } else {
                  // ALL other types (command, exploration, file_edit, etc.) — deduplicated by _traceIdx above
                  // Replace _instant preview with real trace
                  if (!trace._instant && (trace.type === 'command' || trace.type === 'file_edit' || trace.type === 'exploration')) {
                    const relativeInstantIdx = logs.slice(currentTurnStart).findIndex(l => l._instant && l.type === trace.type);
                    const instantIdx = relativeInstantIdx >= 0 ? currentTurnStart + relativeInstantIdx : -1;
                    if (instantIdx >= 0) logs.splice(instantIdx, 1);
                  }
                  if (trace._instant && logs.slice(currentTurnStart).some(l => !l._instant && (l.type === 'command' || l.type === 'file_edit' || l.type === 'exploration'))) {
                    continue;
                  }
                  logs.push(timedTrace);
                }
              }
              return logs;
            };

            if (isActiveChat) {
              // Keep the visible feed and stored chat independently current.
              // Each updater owns only this chat, so a concurrent navigation
              // cannot apply this response to the newly opened conversation.
              setTraceLogs(prevLogs => {
                if (activeChatIdRef.current !== chatId) return prevLogs;
                return processTraces(prevLogs);
              });
              setChats(currentChats =>
                currentChats.map(chat =>
                  chat.id === chatId
                    ? { ...chat, traceLogs: processTraces(chat.traceLogs || []) }
                    : chat
                )
              );
            } else {
              // BACKGROUND chat — only update chats state, DON'T touch traceLogs
              queueBackgroundChatUpdate(chatId, processTraces);
            }

            // Debounced localStorage write — strip large content fields to avoid quota overflow
            debouncedSaveToLocalStorage();
          }

          const isTerminalPollStatus =
            data.status === 'completed' ||
            data.status === 'failed' ||
            data.status === 'stopped';
          if (isTerminalPollStatus && activeChatIdRef.current !== chatId) {
            flushBackgroundChatUpdates();
          }

          // A provider can finish after persisting finalAnswer but before its
          // last answer trace is durably flushed. Recover that text only when
          // the latest visible turn has the exact same run owner.
          if (data.status === 'completed' && String(data.finalAnswer || '').trim()) {
            const terminalRunId = String(serverRunId || expectedRunId || '').trim();
            setChatLogsById(chatId, previous => {
              const latestUserIndex = previous.findLastIndex((log: any) => log?.type === 'user_action');
              if (latestUserIndex < 0) return previous;
              const latestUser = previous[latestUserIndex];
              const latestTurnId = String(latestUser.runId || latestUser.turnId || '').trim();
              if (terminalRunId && latestTurnId && terminalRunId !== latestTurnId) return previous;
              const currentTurn = previous.slice(latestUserIndex + 1);
              if (currentTurn.some((log: any) => log?.type === 'answer' && String(log.text || '').trim())) {
                return previous;
              }
              return [
                ...previous,
                withTraceTiming({
                  type: 'answer',
                  text: String(data.finalAnswer),
                  runId: terminalRunId || latestTurnId,
                  turnId: latestTurnId || terminalRunId,
                  isStreaming: false,
                  isLiveTyping: false,
                }, data.completedAt),
              ];
            });
          }

          // CRITICAL: Only stop on TERMINAL states, NOT 'idle'
          // 'idle' means agent hasn't started yet (race condition)
          if (data.status === 'failed') {
            if (activeChatIdRef.current !== chatId) flushBackgroundChatUpdates();
            // Show error trace so UI doesn't silently drop — this was causing the
            // 'UI gets off while running' appearance (agent failed, no feedback)
            const errMsg = data.finalAnswer || data.error || 'All API attempts exhausted or agent encountered a fatal error.';
            setChatLogsById(chatId, previous => [
              ...stripAgentConnectionLogs(previous),
              agentStatusLog('failed', 'Run ended with an error', errMsg.slice(0, 200), normalizeClientTraceTime(data.completedAt))
            ]);
          }
          const hasQueuedProxySuccessor =
            data.status !== 'stopped' &&
            Number(data.pendingProxyTaskCount || 0) > 0;
          if (
            hasQueuedProxySuccessor &&
            (data.status === 'completed' || data.status === 'failed')
          ) {
            // The registry starts queued Proxy work immediately after the
            // current run settles. Keep this poller attached across that small
            // handoff window; stopping here loses the successor's delegated
            // user turn and makes Main look idle in the visible transcript.
            pollCursorsRef.current.set(chatId, -1);
            lastHadData = false;
            if (pollingIntervalsRef.current.has(chatId) && pollGenerationRef.current.get(chatId) === pollGeneration) {
              pollingIntervalsRef.current.delete(chatId);
              scheduleNextPoll();
            }
            return;
          }
          if (data.status === 'completed' || data.status === 'failed' || data.status === 'stopped') {
            if (activeChatIdRef.current !== chatId) flushBackgroundChatUpdates();
            // Check if it's already stopped by a overlapping async fetch
            const shouldNotify = pollingIntervalsRef.current.has(chatId);

            clearAgentConnectionStatus(chatId);
            stopPolling(chatId);
            removeRunningChat(chatId);
            liveProgressAnnouncementAtRef.current.delete(chatId);
            markChatUnreadIfBackground(chatId);
            if (data.status === 'completed' || data.status === 'failed') {
              announceLiveTaskEvent(
                chatId,
                data.status,
                String(data.finalAnswer || data.error || ''),
                String(serverRunId || expectedRunId || ''),
              );
            }

            // Title generation uses the same provider credentials as agents.
            // Run it only after execution ends so a cosmetic request never
            // competes with Main or sub-agents for latency/quota.
            const pendingTitle = pendingTitleRequestsRef.current.get(chatId);
            if (pendingTitle) {
              pendingTitleRequestsRef.current.delete(chatId);
              window.setTimeout(() => {
                void generateTitle(chatId, pendingTitle.history, pendingTitle.currentTitle, pendingTitle.mode);
              }, 500);
            }

            // TRIGGER DESKTOP NOTIFICATION (Outside setState to prevent React.StrictMode double-firing!)
            if (shouldNotify && data.status === 'completed' && 'Notification' in window) {
              // Ensure exactly ONE notification per agent run - solves the 2-3x duplicate bug
              if (!notifiedChatIdsRef.current.has(chatId)) {
                notifiedChatIdsRef.current.add(chatId);

                try {
                  const svd = localStorage.getItem('eterx_settings');
                  const settings = svd ? JSON.parse(svd) : {};
                  if (settings.desktopNotifications !== false) {
                    const cht = chatsRef.current.find((c: any) => c.id === chatId);
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
              persistChats(currentChats);
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
      } finally {
        pollInFlight = false;
      }
    };

    // Kick off the first poll AND register for visibility catch-up
    catchUpPollersRef.current.set(chatId, () => {
      if (pollGenerationRef.current.get(chatId) !== pollGeneration) return;
      if (pollInFlight) return;
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
    const getWatchedChatIds = () => {
      const ids = new Set<string>();
      if (activeChatId) ids.add(activeChatId);
      // Read the live ref inside the interval. Capturing `runningChats` here
      // leaves newly started background chats outside the recovery safety net.
      runningChatsRef.current.forEach(id => ids.add(id));
      return ids;
    };

    if (getWatchedChatIds().size === 0) return;

    let cancelled = false;
    const reconcileDetachedPollers = async () => {
      const ids = getWatchedChatIds();
      for (const chatId of ids) {
        if (cancelled) return;
        if (pollingIntervalsRef.current.has(chatId)) continue;
        // Skip chats being explicitly stopped — avoids re-adding them during the cleanup race window
        if (stoppingChatsRef.current.has(chatId)) continue;

        try {
          const data = await fetchAgentPoll(chatId, -1, 5000);
          if (cancelled) return;

          if (data.traces && data.traces.length > 0) {
            setChatLogsById(chatId, previousLogs => mergeServerRunLogs(previousLogs, data.traces, {
              runId: data.runId,
              startedAt: data.startedAt,
            }));
            debouncedSaveToLocalStorage();
          }

          if (data.status === 'running') {
            setRunningChats(prev => {
              if (prev.has(chatId)) return prev;
              const next = new Set(prev);
              next.add(chatId);
              return next;
            });

            startPolling(chatId, data.maxIndex ?? (data.totalTraces - 1), data.startedAt, data.runId);
          } else if (isTerminalAgentStatus(data.status) || (data.status === 'idle' && runningChatsRef.current.has(chatId))) {
            removeRunningChat(chatId);
            liveProgressAnnouncementAtRef.current.delete(chatId);
            if (isTerminalAgentStatus(data.status)) {
              markChatUnreadIfBackground(chatId);
              if (data.status === 'completed' || data.status === 'failed') {
                announceLiveTaskEvent(
                  chatId,
                  data.status,
                  String(data.finalAnswer || data.error || ''),
                  String(data.runId || ''),
                );
              }
            }
          }
        } catch {
          // Keep the UI quiet here; the normal poller/backoff path will recover.
        }
      }
    };

    reconcileDetachedPollers();
    const interval = window.setInterval(reconcileDetachedPollers, 8000); // Safety net only — 8s is plenty
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeChatId]); // eslint-disable-line react-hooks/exhaustive-deps — intentionally excludes runningChats to prevent self-reinforcing re-fire loop

  const stopChatAgent = (chatId: string): Promise<boolean> => {
    if (!chatId || !runningChatsRef.current.has(chatId)) return Promise.resolve(false);
    const existingRequest = stopRequestsRef.current.get(chatId);
    if (existingRequest) return existingRequest;
    const queuedMessages = queuedFollowUps.filter(message => message.chatId === chatId);
    const steeringMessages = pendingSteering.filter(message => message.chatId === chatId);
    const stopRunId = pollRunIdRef.current.get(chatId) || String(
      [...(chatsRef.current.find(chat => chat.id === chatId)?.traceLogs || [])]
        .reverse()
        .find((log: any) => log?.type === 'user_action')
        ?.runId || ''
    ).trim();
    setQueuedFollowUps(previous => previous.filter(message => message.chatId !== chatId));
    setPendingSteering(previous => previous.filter(message => message.chatId !== chatId));
    const stopRequest = (async () => {
      try {
        await runStartReadinessRef.current.get(chatId);
        const response = await fetch('/api/agent/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId, runId: stopRunId || undefined }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.success !== true) {
          throw new Error(payload.error || payload.message || `Stop failed (${ response.status })`);
        }
        abortControllersRef.current.get(chatId)?.abort();
        abortControllersRef.current.delete(chatId);
        stopPolling(chatId);
        removeRunningChat(chatId);
        liveProgressAnnouncementAtRef.current.delete(chatId);
        notifiedChatIdsRef.current.delete(chatId);
        setChatLogsById(chatId, previous => {
          const cleared = previous.map((log, index, logs) => {
            if (index === logs.length - 1 && log.type === 'answer' && (log.isStreaming || log.isLiveTyping)) {
              return { ...log, isStreaming: false, isLiveTyping: false };
            }
            return log;
          });
          const clean = stripAgentConnectionLogs(cleared);
          const alreadyMarked = clean.some(log =>
            (log.type === 'agent_status' && log.status === 'stopped') ||
            (log.type === 'thought' && String(log.text || '').includes('Generation stopped by user.'))
          );
          return alreadyMarked ? clean : [...clean, agentStatusLog('stopped', 'Run stopped', 'Stopped by you.')];
        });
        return true;
      } catch (error: any) {
        setQueuedFollowUps(previous => {
          const existingIds = new Set(previous.map(message => message.id));
          return [...previous, ...queuedMessages.filter(message => !existingIds.has(message.id))];
        });
        setPendingSteering(previous => {
          const existingIds = new Set(previous.map(message => message.id));
          return [...previous, ...steeringMessages.filter(message => !existingIds.has(message.id))];
        });
        setChatLogsById(chatId, previous => [
          ...stripAgentConnectionLogs(previous),
          agentStatusLog('warning', 'Stop request failed', String(error?.message || error).slice(0, 180)),
        ]);
        return false;
      } finally {
        stopRequestsRef.current.delete(chatId);
      }
    })();
    stopRequestsRef.current.set(chatId, stopRequest);
    return stopRequest;
  };

  const handleStop = (): Promise<boolean> => {
    const chatId = activeChatIdRef.current;
    return chatId ? stopChatAgent(chatId) : Promise.resolve(false);
  };

  // Remove pending steering messages when they appear in traceLogs
  useEffect(() => {
    if (pendingSteering.length === 0) return;

    const lastUserIdx = traceLogs.reduceRight((found, l, i) => found === -1 && l.type === 'user_action' ? i : found, -1);
    const currentTurnLogs = lastUserIdx >= 0 ? traceLogs.slice(lastUserIdx) : traceLogs;

    const receivedIds = new Set(
      currentTurnLogs
        .filter(l => l.type === 'steering_received')
        .map(l => String(l.steeringId || ''))
        .filter(Boolean)
    );
    const receivedTexts = new Set(
      currentTurnLogs
        .filter(l => l.type === 'steering_received')
        .map(l => l.text)
    );

    if (receivedIds.size > 0 || receivedTexts.size > 0) {
      setPendingSteering(prev => prev.filter(p =>
        p.chatId !== activeChatId || (!receivedIds.has(p.id) && !receivedTexts.has(p.text))
      ));
    }
  }, [activeChatId, traceLogs, pendingSteering.length]);

  /**
   * handleSteer - sends a live steering comment to the running agent.
   * The message is queued server-side and injected into the model context
   * at the next free ReAct iteration (non-disruptive, agent is never paused).
   */
  const sendSteeringMessageToChat = useCallback(async (targetChatId: string, message: string) => {
    const steerMessage = message.trim();
    if (!targetChatId || !steerMessage || steeringAdmissionsRef.current.has(targetChatId)) return false;
    steeringAdmissionsRef.current.add(targetChatId);
    const newSteering = { id: crypto.randomUUID(), text: steerMessage, chatId: targetChatId };
    const targetLogs = chatsRef.current.find(chat => chat.id === targetChatId)?.traceLogs || [];
    const targetUserLog = [...targetLogs].reverse().find((log: any) => log?.type === 'user_action');
    const targetRunId = String(targetUserLog?.runId || targetUserLog?.turnId || '').trim();
    setPendingSteering(prev => [...prev, newSteering]);

    try {
      const res = await fetch('/api/agent/steer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: targetChatId,
          message: steerMessage,
          id: newSteering.id,
          runId: targetRunId || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.warn('[handleSteer] Steer failed:', err.reason || res.status);
        setPendingSteering(prev => prev.filter(item => item.id !== newSteering.id));
        if (activeChatIdRef.current === newSteering.chatId) {
          updateInputValue(current => current.trim() ? current : steerMessage);
        }
        return false;
      } else {
        console.log('[handleSteer] Steering message sent:', steerMessage.substring(0, 60));
        return true;
      }
    } catch (e: any) {
      console.warn('[handleSteer] Network error:', e?.message);
      setPendingSteering(prev => prev.filter(item => item.id !== newSteering.id));
      if (activeChatIdRef.current === newSteering.chatId) {
        updateInputValue(current => current.trim() ? current : steerMessage);
      }
      return false;
    } finally {
      steeringAdmissionsRef.current.delete(targetChatId);
    }
  }, [revealNetworkBanner, updateInputValue]);

  const sendSteeringMessage = useCallback(async (message: string) => {
    const targetChatId = activeChatIdRef.current;
    return targetChatId ? sendSteeringMessageToChat(targetChatId, message) : false;
  }, [sendSteeringMessageToChat]);

  const handleSteer = async () => {
    if (!inputValue.trim() && attachments.length === 0) return;
    const steerMessage = inputValue.trim();
    let followUpBehavior: 'queue' | 'steer' = 'steer';
    try {
      const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
      const settings = saved ? JSON.parse(saved) : null;
      if (settings?.followUpBehavior === 'queue') followUpBehavior = 'queue';
    } catch { }

    // Attachments cannot be safely injected into an in-flight model turn.
    // Preserve the complete composer payload as the next turn instead.
    if (followUpBehavior === 'queue' || attachments.length > 0) {
      if (!activeChatId) return;
      if (queuedFollowUpAdmissionsRef.current.has(activeChatId)) return;
      queuedFollowUpAdmissionsRef.current.add(activeChatId);
      setQueuedFollowUps(previous => [
        ...previous,
        {
          id: crypto.randomUUID(),
          chatId: activeChatId,
          text: steerMessage,
          attachments: [...attachments],
          createdAt: Date.now(),
        },
      ]);
      updateInputValue('');
      updateAttachments([]);
      window.setTimeout(() => queuedFollowUpAdmissionsRef.current.delete(activeChatId), 0);
      return;
    }

    if (activeChatId && steeringAdmissionsRef.current.has(activeChatId)) return;
    updateInputValue('');
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

  const handleOpenAgentTeam = useCallback((agentNameOrId?: string) => {
    if (agentNameOrId) {
      // Switch to that agent's tab in the header
      if (agentNameOrId === 'Main') {
        setActiveSubAgentTab(null);
      } else {
        const activeLogs = chatsRef.current.find(chat => chat.id === activeChatIdRef.current)?.traceLogs || [];
        const matchingLog = [...activeLogs].reverse().find((log: any) => {
          const name = log?.agentName || log?.subAgent;
          const identity = String(log?.subAgentChatId || log?.subAgentId || name || '');
          return identity === agentNameOrId || name === agentNameOrId;
        });
        setActiveSubAgentTab(String(
          matchingLog?.subAgentChatId ||
          matchingLog?.subAgentId ||
          agentNameOrId
        ));
      }
      setSubAgentDockOpen(true);
    }
    setAgentTeamOpen(true);
  }, []);

  const announceLiveTaskEvent = useCallback((
    chatId: string,
    status: 'completed' | 'failed' | 'blocked' | 'progress',
    summary: string,
    runId?: string,
  ) => {
    const chat = chatsRef.current.find(item => item.id === chatId);
    const cleanSummary = String(summary || '').replace(/<[^>]*>?/gm, '').replace(/[*#_`]/g, '').trim();
    syncLiveMissionTask(
      chatId,
      chat?.title || 'Background task',
      cleanSummary,
      status === 'completed'
        ? 'done'
        : status === 'progress'
          ? 'active'
          : 'blocked',
    );
    const session = liveSessionRef.current;
    if (!session) return false;
    return session.announceSystemEvent({
      id: `agent_${ chatId }_${ runId || status }_${ status }`,
      type: status === 'completed'
        ? 'task_completed'
        : status === 'blocked'
          ? 'task_blocked'
          : status === 'progress'
            ? 'task_progress'
            : 'task_failed',
      sourceChatId: chatId,
      sourceChatTitle: chat?.title || 'Background task',
      summary: cleanSummary.slice(0, 600) || (
        status === 'completed'
          ? 'The requested work is complete and ready to review.'
          : status === 'blocked'
            ? 'The task needs additional input before it can continue.'
            : status === 'progress'
              ? 'A meaningful part of the task has finished.'
            : 'The task ended with an error and needs attention.'
      ),
    });
  }, [syncLiveMissionTask]);

  const handleSendSubAgentMessage = useCallback(async () => {
    const selectedAgentLog = [...traceLogs].reverse().find((log: any) => {
      const name = log?.agentName || log?.subAgent;
      const identity = String(log?.subAgentChatId || log?.subAgentId || name || '');
      return identity === activeSubAgentTab;
    });
    const agentName = selectedAgentLog?.agentName || selectedAgentLog?.subAgent || activeSubAgentTab;
    const subAgentIdentity = activeSubAgentTab;
    const chatId = activeChatId;
    if (!agentName || !chatId) return;
    const admissionKey = `${ chatId }:${ subAgentIdentity || agentName }`;
    if (subAgentSendAdmissionsRef.current.has(admissionKey)) return;

    if (isRecording && mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
    if (!inputValue.trim() && attachments.length === 0) return;
    subAgentSendAdmissionsRef.current.add(admissionKey);
    const originalInput = inputValue;
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

    clearDraftComposerState(activeChatId);

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
          subAgentId: selectedAgentLog?.subAgentId,
          subAgentChatId: subAgentIdentity,
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
      const log = interAgentMessageLog(message, agentName, subAgentIdentity || undefined);
      setChatLogsById(chatId, previousLogs => {
        const existingIds = new Set(previousLogs.map((item: any) => item.messageId || item.id).filter(Boolean));
        if (existingIds.has(log.messageId) || existingIds.has(log.id)) return previousLogs;
        return [...previousLogs, log];
      }, { touchUpdatedAt: true });
    } catch (error: any) {
      if (activeChatIdRef.current === chatId) {
        updateInputValue(current => current.trim() ? current : originalInput);
        updateAttachments(current => current.length > 0 ? current : currentAttachments);
      }
      const failureLog = systemThoughtLog(`Failed to send message to ${ agentName }: ${ error?.message || 'Unknown error' }`, Date.now());
      setChatLogsById(chatId, previousLogs => [...previousLogs, failureLog], { touchUpdatedAt: true });
    } finally {
      subAgentSendAdmissionsRef.current.delete(admissionKey);
    }
  }, [activeChatId, activeSubAgentTab, attachments, inputValue, isRecording, revealNetworkBanner, traceLogs, updateAttachments, updateInputValue]);

  const handleSend = async (
    overridePrompt?: string,
    overrideAttachments?: ComposerAttachment[],
    targetChatIdOverride?: string,
    runOptionsOverride?: {
      modelSelection?: string;
      selectedAgent?: SelectedAgentState;
      thinkingLevel?: MainAgentThinkingLevel;
      createNewChat?: boolean;
      backgroundChat?: boolean;
      initialTitle?: string;
    },
  ) => {
    if (isRecording && mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
    const promptText = (typeof overridePrompt === 'string' ? overridePrompt : inputValue).trim();
    const requestedAttachments = overrideAttachments ?? attachments;
    if (!promptText && requestedAttachments.length === 0) return false;
    const targetChatIdAtSend = targetChatIdOverride || activeChatIdRef.current;
    const targetChatExists = targetChatIdAtSend
      ? chatsRef.current.some(chat => chat.id === targetChatIdAtSend)
      : false;
    const shouldCreateTargetChat = Boolean(runOptionsOverride?.createNewChat && targetChatIdAtSend && !targetChatExists);
    if (targetChatIdOverride && !targetChatExists && !shouldCreateTargetChat) return false;
    const targetHasLiveSession =
      targetChatIdAtSend !== null &&
      targetChatIdAtSend === liveChatIdRef.current &&
      liveState !== 'idle' &&
      liveState !== 'error' &&
      !liveMainDispatchRef.current;
    if (
      (targetChatIdAtSend && runningChatsRef.current.has(targetChatIdAtSend)) ||
      targetHasLiveSession
    ) return false;
    // React state does not update synchronously. This latch closes the gap in
    // which a double click/Enter can launch two requests before isThinking flips.
    const admissionKey = targetChatIdAtSend || '__new_chat__';
    const admittedAt = sendAdmissionsRef.current.get(admissionKey) || 0;
    if (Date.now() - admittedAt < 30_000) return false;
    sendAdmissionsRef.current.set(admissionKey, Date.now());

    // Request notification permissions implicitly during this user gesture
    try {
      const saved = localStorage.getItem('eterx_settings');
      const settings = saved ? JSON.parse(saved) : {};
      if (settings.desktopNotifications !== false && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    } catch { }

    const runModelSelection = runOptionsOverride?.modelSelection || composerRuntimeSelectionRef.current.modelSelection;
    const explicitRunModelEntry = parseModelEntryKey(runModelSelection);
    const autoRunModelEntry = explicitRunModelEntry
      ? null
      : pickAutoModelEntry(readRuntimeModelEntries(), readRuntimeBaseApiKeys(), readRuntimeModelApiKeys());
    const runModelEntry = explicitRunModelEntry || autoRunModelEntry;
    const runAgentMode = runModelEntry
      ? MODEL_PROVIDER_MODE[runModelEntry.provider]
      : readRuntimeAgentMode(composerRuntimeSelectionRef.current.agentMode, runModelSelection);
    const fallbackRunModel = MAIN_AGENT_MODEL_OPTIONS.find(option => option.id === runAgentMode) || MAIN_AGENT_MODEL_OPTIONS[0];
    const contextBudgetModelEntry = runModelEntry || {
      provider: fallbackRunModel.provider,
      modelId: fallbackRunModel.modelName,
    };
    const runThinkingLevel = runOptionsOverride?.thinkingLevel || composerRuntimeSelectionRef.current.thinkingLevel;
    const runSelectedAgent = runOptionsOverride?.selectedAgent || composerRuntimeSelectionRef.current.selectedAgent;
    const runSelectedAgentId = runSelectedAgent.agentId;
    const runSelectedAgentName = runSelectedAgent.agentName;
    const currentAttachments = [...requestedAttachments];
    const userLogAttachments = currentAttachments.map(serializeComposerAttachment);
    const runStartedAt = Date.now();
    const clientRunId = crypto.randomUUID();
    const userLog = {
      type: 'user_action',
      text: promptText,
      attachments: userLogAttachments,
      runId: clientRunId,
      turnId: clientRunId,
      startTime: runStartedAt,
      endTime: runStartedAt,
    };
    const historySourceLogs = targetChatIdAtSend && !shouldCreateTargetChat
      ? stripAgentConnectionLogs(chatsRef.current.find(chat => chat.id === targetChatIdAtSend)?.traceLogs || [])
      : [];
    lastLiveLogsSnapshotRef.current = { chatId: null, turnId: null, commitKey: null, logs: [] };
    clearDraftComposerState(targetChatIdAtSend);

    let chatIdToUse = targetChatIdAtSend;

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

    if (!chatIdToUse || shouldCreateTargetChat) {
      chatIdToUse = chatIdToUse || crypto.randomUUID();
      try {
        localStorage.setItem(`eterx_proxy_controls_${ chatIdToUse }`, JSON.stringify({ enabled: proxyEnabled, intervention: proxyIntervention }));
        localStorage.setItem(`eterx_proxy_manager_model_${ chatIdToUse }`, proxyModelSelection);
        localStorage.setItem(`eterx_proxy_runtime_model_${ chatIdToUse }`, proxyRuntimeModelSelection);
      } catch { }
      if (!runOptionsOverride?.backgroundChat) {
        activeChatIdRef.current = chatIdToUse;
        setActiveChatId(chatIdToUse);
      }
      const createdComposerState: ChatComposerState = {
        inputValue: '',
        runLocation: activeRunLocation,
        selectedAgent: runSelectedAgent,
        agentMode: runAgentMode,
        thinkingLevel: runThinkingLevel,
        attachments: [],
        pinnedItems: [...pinnedItems],
        chatModelSelection: runModelSelection,
      };
      setComposerStates(previous => {
        const next = { ...previous, [chatIdToUse!]: createdComposerState };
        try { localStorage.setItem('eterx_chat_composer_states', JSON.stringify(next)); } catch { }
        return next;
      });

      const initialTitle = String(runOptionsOverride?.initialTitle || '').trim() || fallbackTitleFromPrompt(promptText);
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
        chatsRef.current = updated;
        persistChats(updated);
        return updated;
      });
      if (!runOptionsOverride?.backgroundChat) setTraceLogs([userLog]);

      const titleChatId = chatIdToUse;
      const initialTitleHistory = [{ role: 'user', parts: [{ text: promptText }] }];
      pendingTitleRequestsRef.current.set(titleChatId, {
        history: initialTitleHistory,
        currentTitle: DEFAULT_CHAT_TITLE,
        mode: runAgentMode,
      });
    } else {
      const storedTargetLogs = chatsRef.current.find(chat => chat.id === chatIdToUse)?.traceLogs;
      const baseTargetLogs = storedTargetLogs || (chatIdToUse === activeChatId ? traceLogs : []);
      const updatedLogs = [...stripAgentConnectionLogs(baseTargetLogs), userLog];
      setChatLogsById(chatIdToUse, updatedLogs, { touchUpdatedAt: true });

      // Adaptive renaming logic (every 5 messages)
      const userMessageCount = updatedLogs.filter(l => l.type === 'user_action').length;
      if (userMessageCount > 1 && userMessageCount % 5 === 0) {
        const chatHistory = updatedLogs
          .filter(log => log.type === 'user_action' || log.type === 'thought' || log.type === 'answer')
          .slice(-80)
          .map(log => ({
            role: log.type === 'user_action' ? 'user' : 'model',
            parts: [{ text: log.text }]
          }));
        pendingTitleRequestsRef.current.set(chatIdToUse, {
          history: chatHistory,
          currentTitle: chatsRef.current.find(chat => chat.id === chatIdToUse)?.title || DEFAULT_CHAT_TITLE,
          mode: runAgentMode,
        });
      }
    }

    if (!runOptionsOverride?.backgroundChat) clearUnreadChat(chatIdToUse);

    if (!runOptionsOverride?.backgroundChat && window.innerWidth < 960) setSidebarOpen(false);

    // Mark this chat as running
    setRunningChats(prev => new Set(prev).add(chatIdToUse!));

    // Build chat history for context
    const chatHistory = buildBoundedAgentHistory(historySourceLogs);

    const isBuilderChat = !!chatIdToUse && chatIdToUse.startsWith('agent_builder_');
    const builderAgentId = isBuilderChat ? chatIdToUse!.replace('agent_builder_', '') : null;
    const selectedCustomRuntimeId = runSelectedAgentId && runSelectedAgentId !== 'coding' && runSelectedAgentId !== 'autonomous' && !isBuilderChat
      ? runSelectedAgentId
      : null;
    // The legacy runner remains in this file only for a staged migration, but
    // all live custom-agent and flow runs use the shared AgentRegistry below.
    const isCustomAgentRun = false;

    if (isCustomAgentRun) {
      const controller = new AbortController();
      abortControllersRef.current.set(chatIdToUse!, controller);
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
          agentName: runSelectedAgentName,
          customAgentId: runSelectedAgentId,
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

      const appendCustomAgentStatus = (text: string, agentName = runSelectedAgentName) => {
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
          runSelectedAgentName,
          `custom_work_${ runStartedAt }_${ customWorkNoteSeq++ }`,
          Date.now(),
        );
        pendingCustomText = '';
        if (noteLog) appendCustomAgentTrace(noteLog);
      };

      const customToolTraceKey = (event: any) => `${ String(event?.agentName || runSelectedAgentName) }:${ String(event?.toolName || '') }`;

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
        const runLocationVal = activeRunLocation;
        const response = await fetch('/api/agents/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: runSelectedAgentId,
            chatId: chatIdToUse,
            messages: runnerMessages,
            mode: runAgentMode,
            runLocation: runLocationVal,
            pinnedContext: {
              terminalShell: readStoredTerminalShell(),
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
            agentStatusLog('failed', 'Custom agent unavailable', message),
          ], { touchUpdatedAt: true });
          return false;
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
            appendCustomAgentStatus(String(event.text || ''), String(event.agentName || runSelectedAgentName));
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
            const actionLog = createCustomToolActionLog(event, String(event.agentName || runSelectedAgentName), at);
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
              agentStatusLog('failed', 'Custom agent run failed', message.slice(0, 240)),
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
            agentStatusLog('failed', 'Custom agent connection failed', String(error.message || error).slice(0, 180)),
          ], { touchUpdatedAt: true });
        }
      } finally {
        sendAdmissionsRef.current.delete(admissionKey);
        if (abortControllersRef.current.get(chatIdToUse!) === controller) {
          abortControllersRef.current.delete(chatIdToUse!);
        }
        removeRunningChat(chatIdToUse!);
        markChatUnreadIfBackground(chatIdToUse!);
      }
      return true;
    }

    // ═══════════════════════════════════════════════════════════════
    // FIRE-AND-FORGET: Start the SSE stream (backward compatible)
    // The agent runs via AgentRegistry on the server. Even if this
    // SSE stream drops, the agent keeps running. We also start
    // a polling loop as backup/primary for trace updates.
    // ═══════════════════════════════════════════════════════════════

    const requestPinnedContext = {
      terminalShell: readStoredTerminalShell(),
      contextCompaction: readContextCompactionSettings(contextBudgetModelEntry, chatIdToUse),
      ...(!runSelectedAgentId && !isBuilderChat ? {
        disableSubAgents: true,
        allowAgentSpawning: false,
      } : {}),
      ...(pinnedItems.length > 0 ? { paths: pinnedItems.map(p => p.path) } : {}),
      ...(isBuilderChat ? { agentRuntime: 'agent_builder', agentId: builderAgentId } : {}),
      ...(runSelectedAgentId === 'coding' && !isBuilderChat ? { agentRuntime: 'main_coding_agent', agentProfile: 'eterx-code' } : {}),
      ...(runSelectedAgentId === 'autonomous' && !isBuilderChat ? {
        agentRuntime: 'autonomy_v1',
        autonomy: {
          enabled: proxyEnabled,
          collaboration: 'user_proxy',
          initiative: 'high',
          verification: 'adaptive',
          intervention: proxyIntervention,
          proxyModelSelection: proxyRuntimeModelSelection,
        },
      } : {}),
      ...(activeWorkspacePath ? {
        paths: [activeWorkspacePath, ...(pinnedItems.length > 0 ? pinnedItems.map(p => p.path) : [])],
        workspacePath: activeWorkspacePath,
        isFocusedWorkspace: true
      } : {}),
    };
    const hasPinnedContext = Object.keys(requestPinnedContext).length > 0;

    const controller = new AbortController();
    abortControllersRef.current.set(chatIdToUse!, controller);
    let resolveRunStart!: () => void;
    const runStartReady = new Promise<void>(resolve => { resolveRunStart = resolve; });
    runStartReadinessRef.current.set(chatIdToUse!, runStartReady);
    let runStartSettled = false;
    const settleRunStart = () => {
      if (runStartSettled) return;
      runStartSettled = true;
      resolveRunStart();
    };

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
        headers: {
          'Content-Type': 'application/json',
          // The UI consumes traces through its resilient per-chat poller. Ask
          // the server not to also run a redundant 100ms SSE polling loop.
          'Prefer': 'respond-async',
        },
        body: JSON.stringify({
          prompt: promptText,
          history: chatHistory,
          mediaAttachments,
          userId: 'default',
          projectId: chatIdToUse,
          mode: runAgentMode,
          thinkingLevel: runThinkingLevel,
          modelThinkingCapability: readRuntimeModelThinkingCapability(
            runModelEntry ? modelEntryKey(runModelEntry.provider, runModelEntry.modelId) : runModelSelection
          ),
          selectedModel: runModelEntry ? { provider: runModelEntry.provider, modelId: runModelEntry.modelId } : null,
          strictModelSelection: Boolean(explicitRunModelEntry),
          pinnedContext: hasPinnedContext ? requestPinnedContext : null,
          runLocation: runLocationVal,
          customAgentId: selectedCustomRuntimeId,
          customAgentName: selectedCustomRuntimeId ? runSelectedAgentName : null,
          runId: clientRunId,
        }),
        signal: controller.signal
      });
      settleRunStart();

      if (!response.ok) {
        let message = `Agent start failed (${ response.status }).`;
        try {
          const errorPayload = await response.json();
          message = errorPayload.error || errorPayload.details || message;
        } catch { }

        stopPolling(chatIdToUse!);
        pendingTitleRequestsRef.current.delete(chatIdToUse!);
        removeRunningChat(chatIdToUse!);
        markChatUnreadIfBackground(chatIdToUse!);
        setChatLogsById(chatIdToUse!, prev => [
          ...stripAgentConnectionLogs(prev),
          agentStatusLog('failed', 'Agent unavailable', message)
        ]);
        return false;
      }

      serverAccepted = true;
      sendAdmissionsRef.current.delete(admissionKey);
      startPolling(chatIdToUse!, -1, runStartedAt, clientRunId);

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
      settleRunStart();
      if (error.name !== 'AbortError') {
        if (!serverAccepted) {
          stopPolling(chatIdToUse!);
          pendingTitleRequestsRef.current.delete(chatIdToUse!);
          removeRunningChat(chatIdToUse!);
          markChatUnreadIfBackground(chatIdToUse!);
          setChatLogsById(chatIdToUse!, prev => [
            ...stripAgentConnectionLogs(prev),
            agentStatusLog('failed', 'Agent connection failed', String(error.message || error).slice(0, 180))
          ]);
          return false;
        }
        // SSE failed but agent is still running on server!
        // Polling will continue getting updates.
        console.warn('[handleSend] SSE stream disconnected — polling continues:', error.message);
      }
    } finally {
      settleRunStart();
      if (runStartReadinessRef.current.get(chatIdToUse!) === runStartReady) {
        runStartReadinessRef.current.delete(chatIdToUse!);
      }
      sendAdmissionsRef.current.delete(admissionKey);
      if (abortControllersRef.current.get(chatIdToUse!) === controller) {
        abortControllersRef.current.delete(chatIdToUse!);
      }
    }
    return serverAccepted;
  };
  const handleSendLatestRef = useRef(handleSend);
  handleSendLatestRef.current = handleSend;
  const scheduledRunContextRef = useRef({ activeWorkspacePath, activeRunLocation });
  scheduledRunContextRef.current = { activeWorkspacePath, activeRunLocation };

  // Queue mode creates real follow-up turns rather than injecting text into an
  // in-flight response. Process one item at a time after the current run has
  // fully left the running state so history and trace ownership stay ordered.
  useEffect(() => {
    const next = queuedFollowUps.find(item => !runningChats.has(item.chatId));
    if (!next || queuedFollowUpDispatchRef.current.has(next.id)) return;

    queuedFollowUpDispatchRef.current.add(next.id);
    setQueuedFollowUps(previous => previous.filter(item => item.id !== next.id));
    window.setTimeout(() => {
      void handleSend(next.text, next.attachments, next.chatId).finally(() => {
        queuedFollowUpDispatchRef.current.delete(next.id);
      });
    }, 0);
  }, [queuedFollowUps, runningChats]); // eslint-disable-line react-hooks/exhaustive-deps

  // Automated real-time agent execution when scheduled task triggers
  useEffect(() => {
    const handleTriggerTask = (e: CustomEvent<{ task: any }>) => {
      const rawTask = e.detail?.task;
      if (!rawTask?.id) return;
      const task = normalizeScheduledTask(rawTask);
      if (scheduledTaskRunAdmissionsRef.current.has(task.id)) return;
      scheduledTaskRunAdmissionsRef.current.add(task.id);

      const taskChatId = crypto.randomUUID();
      const taskRunId = `scheduled_run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const runStartedAt = Date.now();
      const sourceContext = task.sources.length > 0
        ? `\n\nScheduled task sources:\n${task.sources.map(source => `- ${source.name}: ${source.path}`).join('\n')}`
        : '';
      const taskPrompt = `${task.description || task.title}${sourceContext}`;
      const scheduledRunContext = scheduledRunContextRef.current;
      const updateStoredTask = (mutate: (target: ScheduledTaskRecord, run: ScheduledTaskRun | undefined) => void) => {
        try {
          const parsed = JSON.parse(localStorage.getItem('eterx_scheduled_tasks') || '[]');
          const tasks = Array.isArray(parsed) ? parsed.map(normalizeScheduledTask) : [];
          const target = tasks.find(item => item.id === task.id);
          if (!target) return;
          mutate(target, target.history?.find(run => run.id === taskRunId));
          target.updatedAt = Date.now();
          localStorage.setItem('eterx_scheduled_tasks', JSON.stringify(tasks));
          window.dispatchEvent(new CustomEvent('eterx_scheduled_tasks_updated'));
        } catch { }
      };
      updateStoredTask(target => {
        const run: ScheduledTaskRun = {
          id: taskRunId,
          chatId: taskChatId,
          status: 'running',
          startedAt: runStartedAt,
          model: task.model,
          agentId: task.agentId,
          agentName: task.agentName,
        };
        target.status = 'running';
        target.chatId = taskChatId;
        target.lastError = undefined;
        target.history = [...(target.history || []), run].slice(-100);
        target.runCount = (target.runCount || 0) + 1;
      });

      const newChatSession: ChatSession = {
        id: taskChatId,
        title: task.title || fallbackTitleFromPrompt(taskPrompt),
        updatedAt: Date.now(),
        traceLogs: [],
        workspacePath: scheduledRunContext.activeWorkspacePath,
        runLocation: scheduledRunContext.activeRunLocation,
      };

      setChats(prev => {
        const updated = [newChatSession, ...prev.filter(c => c.id !== taskChatId)];
        chatsRef.current = updated;
        persistChats(updated);
        return updated;
      });

      const resolvedModel = task.model || AUTO_MODEL_SELECTION;
      const dispatchPromise = handleSendLatestRef.current(taskPrompt, [], taskChatId, {
        modelSelection: resolvedModel,
        selectedAgent: {
          agentId: task.agentId || null,
          agentName: task.agentName || 'General',
        },
        thinkingLevel: task.thinkingLevel,
      });

      let hasStartedRunning = false;
      let settled = false;
      const finishRun = (status: 'completed' | 'failed', error?: string) => {
        if (settled) return;
        settled = true;
        clearInterval(checkInterval);
        scheduledTaskIntervalsRef.current.delete(task.id);
        updateStoredTask((target, run) => {
          const completedAt = Date.now();
          if (run) {
            run.status = status;
            run.completedAt = completedAt;
            run.error = error;
          }
          target.executedAt = completedAt;
          target.chatId = taskChatId;
          target.lastError = error;
          const nextRun = status === 'completed'
            ? computeNextScheduledRun(target.recurrence, completedAt)
            : null;
          if (nextRun !== null) {
            target.status = 'scheduled';
            target.scheduledTimestamp = nextRun;
            const nextDate = new Date(nextRun);
            target.triggerTime = nextDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
            target.customDate = [
              nextDate.getFullYear(),
              String(nextDate.getMonth() + 1).padStart(2, '0'),
              String(nextDate.getDate()).padStart(2, '0'),
            ].join('-');
            target.dateOption = 'custom';
          } else {
            target.status = status;
          }
        });
        scheduledTaskRunAdmissionsRef.current.delete(task.id);
      };
      const checkInterval = window.setInterval(() => {
        const isRunning = runningChatsRef.current?.has(taskChatId);
        if (isRunning) {
          hasStartedRunning = true;
        } else if (hasStartedRunning) {
          const taskChat = chatsRef.current.find(chat => chat.id === taskChatId);
          const terminalLog = [...(taskChat?.traceLogs || [])].reverse().find((log: any) =>
            log?.type === 'agent_status' ||
            ['completed', 'failed', 'error', 'stopped', 'cancelled', 'blocked'].includes(String(log?.status || '').toLowerCase())
          );
          const terminalStatus = String(terminalLog?.status || '').toLowerCase();
          const failed = ['failed', 'error', 'stopped', 'cancelled', 'blocked'].includes(terminalStatus);
          finishRun(
            failed ? 'failed' : 'completed',
            failed ? String(terminalLog?.secondary || terminalLog?.text || `Task ${terminalStatus}.`) : undefined,
          );
        }
      }, 500);
      scheduledTaskIntervalsRef.current.set(task.id, checkInterval);
      void dispatchPromise
        .then(accepted => {
          if (!accepted) finishRun('failed', 'The scheduled agent run was not accepted.');
        })
        .catch(error => {
          finishRun('failed', String(error?.message || error || 'Scheduled execution failed.'));
        });
    };

    window.addEventListener('eterx_trigger_scheduled_task', handleTriggerTask as EventListener);
    return () => {
      window.removeEventListener('eterx_trigger_scheduled_task', handleTriggerTask as EventListener);
      scheduledTaskIntervalsRef.current.forEach(intervalId => window.clearInterval(intervalId));
      scheduledTaskIntervalsRef.current.clear();
      scheduledTaskRunAdmissionsRef.current.clear();
    };
  }, []);

  // ═══════════════════════════════════════════════════════════════
  // STARTUP REHYDRATION: On page load, check for running agents
  // ═══════════════════════════════════════════════════════════════
  useEffect(() => {
    const rehydrate = async () => {
      try {
        let cachedChats: ChatSession[] = [];
        try {
          cachedChats = JSON.parse(localStorage.getItem('eterx_chats') || '[]');
        } catch { }
        let appDataChats: ChatSession[] = [];
        try {
          const response = await fetch('/api/chats', { cache: 'no-store' });
          if (response.ok) {
            const snapshot = await response.json();
            if (Array.isArray(snapshot?.chats)) appDataChats = snapshot.chats;
          }
        } catch { }
        const savedById = new Map<string, ChatSession>();
        for (const chat of [...appDataChats, ...cachedChats, ...chatsRef.current]) {
          if (chat?.id) savedById.set(chat.id, chat);
        }
        const savedChats = sortChats(Array.from(savedById.values()));
        if (savedChats.length === 0) return;

        // Reconcile recent chats with persisted task traces. This also restores
        // the final UI state of work interrupted by an application restart.
        for (const chat of savedChats.slice(0, 100)) {
          try {
            const data = await fetchAgentPoll(chat.id, -1, 5000);

            if ((data.traces && data.traces.length > 0) || isTerminalAgentStatus(data.status)) {
              setChats(prev => {
                const updated = prev.map(c => {
                  if (c.id !== chat.id) return c;
                  const runIdentity = { runId: data.runId, startedAt: data.startedAt };
                  const ownsLatestTurn = canMergeServerRunIntoLatestTurn(c.traceLogs || [], runIdentity);
                  let restoredLogs = mergeServerRunLogs(c.traceLogs || [], data.traces, {
                    runId: data.runId,
                    startedAt: data.startedAt,
                  });
                  if (ownsLatestTurn && data.status === 'completed' && data.finalAnswer) {
                    const lastUserIndex = restoredLogs.findLastIndex((log: any) => log?.type === 'user_action');
                    const currentTurn = lastUserIndex >= 0 ? restoredLogs.slice(lastUserIndex + 1) : restoredLogs;
                    if (!currentTurn.some((log: any) => log?.type === 'answer')) {
                      const latestUserLog = lastUserIndex >= 0 ? restoredLogs[lastUserIndex] : null;
                      restoredLogs = [...restoredLogs, withTraceTiming({
                        type: 'answer',
                        text: data.finalAnswer,
                        runId: data.runId,
                        turnId: latestUserLog?.turnId || latestUserLog?.runId || data.runId,
                      }, data.completedAt)];
                    }
                  } else if (ownsLatestTurn && data.status === 'failed' && data.finalAnswer) {
                    const interruptionText = String(data.finalAnswer);
                    if (!restoredLogs.some((log: any) => String(log?.text || '').includes(interruptionText))) {
                      restoredLogs = [
                        ...restoredLogs,
                        agentStatusLog('failed', 'Run ended with an error', interruptionText, normalizeClientTraceTime(data.completedAt)),
                      ];
                    }
                  } else if (ownsLatestTurn && data.status === 'stopped') {
                    const alreadyStopped = restoredLogs.some((log: any) =>
                      (log?.type === 'agent_status' && log?.status === 'stopped') ||
                      /generation stopped by user|agent stopped/i.test(String(log?.text || ''))
                    );
                    if (!alreadyStopped) {
                      restoredLogs = [
                        ...restoredLogs,
                        agentStatusLog(
                          'stopped',
                          'Run stopped',
                          String(data.finalAnswer || 'The agent was stopped.'),
                          normalizeClientTraceTime(data.completedAt),
                        ),
                      ];
                    }
                  }
                  return { ...c, traceLogs: restoredLogs };
                });
                persistChats(updated);
                if (activeChatIdRef.current === chat.id) {
                  const active = updated.find(c => c.id === chat.id);
                  if (active) setTraceLogs(active.traceLogs || []);
                }
                return updated;
              });
            }

            if (data.status === 'running') {
              console.log(`[Rehydrate] Found running agent for chat "${ chat.title }" (${ chat.id.substring(0, 8) }...)`);
              setRunningChats(prev => new Set(prev).add(chat.id));
              // Start polling for this chat
              startPolling(chat.id, data.maxIndex ?? (data.totalTraces - 1), data.startedAt, data.runId);
            } else if (isTerminalAgentStatus(data.status)) {
              removeRunningChat(chat.id);
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
      if (document.visibilityState === 'visible' && activeChatId) {
        const targetChatId = activeChatId;
        // User returned to tab — check if active chat's agent is still running
        fetchAgentPoll(targetChatId, -1, 5000)
          .then(data => {
            if (!chatsRef.current.some(chat => chat.id === targetChatId)) return;
            if (data.status === 'running' && !pollingIntervalsRef.current.has(targetChatId)) {
              // Agent is running but we're not polling! Restart polling.
              console.log('[Visibility] Reconnecting to running agent...');
              setRunningChats(prev => new Set(prev).add(targetChatId));

              if (data.traces && data.traces.length > 0) {
                setChatLogsById(targetChatId, previousLogs => mergeServerRunLogs(previousLogs, data.traces, {
                  runId: data.runId,
                  startedAt: data.startedAt,
                }));
              }

              startPolling(targetChatId, data.maxIndex ?? (data.totalTraces - 1), data.startedAt, data.runId);
            } else if (isTerminalAgentStatus(data.status) || data.status === 'idle') {
              removeRunningChat(targetChatId);
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
    { icon: <span className="w-4 h-4 inline-block"><img src="/logo-black.png" alt="Logo" className="w-full h-full object-contain dark:hidden" /><img src="/logo-white.png" alt="Logo" className="hidden w-full h-full object-contain dark:block" /></span>, text: "EterX's choice" }
  ];
  // No longer use full-screen initializing state — always show ChatFeed immediately
  const isInitializingChat = false;
  // FLASH FIX: snapshot the last non-empty live logs so they survive the 1-frame
  // gap between liveState going 'idle' and the polling loop committing the answer
  // into traceLogs. Without this, both the live answer AND all live action logs
  // disappear simultaneously for one render frame, causing the visible flash.
  const displayTraceLogs = useMemo(() => {
    const ownedTraceLogs = traceLogs.filter(
      log => !log?.chatId || log.chatId === activeChatId
    );
    const baseLogs = ownedTraceLogs.filter(log =>
      !(log?.isLive && (log.type === 'thought_stream' || log.type === 'work_note'))
    );

    // Filter out sub-agent details when we are in the main view
    const filteredLogs = baseLogs.filter(l => {
      if (!l) return false;
      const logAgentName = l.subAgent || l.agentName;
      const isSubAgentLifecycle = /^sub_agent_/.test(String(l.type || ''));
      const hasChildIdentity = Boolean(l.subAgentChatId || l.subAgentId);
      const isSubAgentLog = hasChildIdentity
        || (l.subAgent && l.subAgent !== 'Main')
        || (isSubAgentLifecycle && logAgentName && logAgentName !== 'Main');
      if (isSubAgentLog) {
        // Keep ONLY sub_agent_spawn in the main timeline
        return l.type === 'sub_agent_spawn';
      }
      return true;
    });

    const freshLiveLogs = isLiveSessionActive ? getLiveTraceLogs() : [];
    const freshLiveTurnId = String(
      freshLiveLogs[0]?.turnId || freshLiveLogs[0]?.runId || ''
    ).trim();

    // Update snapshot whenever we get non-empty live logs
    if (
      freshLiveLogs.length > 0 &&
      activeChatId &&
      activeChatId === liveChatId &&
      !(
        lastLiveLogsSnapshotRef.current.commitKey &&
        lastLiveLogsSnapshotRef.current.turnId === freshLiveTurnId
      )
    ) {
      const freshTurnId = freshLiveTurnId;
      const previousSnapshot = lastLiveLogsSnapshotRef.current;
      const canMerge = previousSnapshot.chatId === activeChatId &&
        previousSnapshot.turnId === freshTurnId &&
        !previousSnapshot.commitKey;
      const previousLogs = canMerge ? previousSnapshot.logs : [];
      const pickStableTextLog = (type: string) => {
        const incoming = freshLiveLogs.find(log => log?.type === type);
        const previous = previousLogs.find(log => log?.type === type);
        if (!incoming) return previous;
        if (!previous) return incoming;
        return String(incoming.text || '').length >= String(previous.text || '').length
          ? incoming
          : previous;
      };
      const userLog = pickStableTextLog('user_action');
      const answerLog = pickStableTextLog('answer');
      const incomingActions = freshLiveLogs.filter(
        log => log?.type !== 'user_action' && log?.type !== 'answer'
      );
      const actionLogs = incomingActions.length > 0
        ? incomingActions
        : previousLogs.filter(log => log?.type !== 'user_action' && log?.type !== 'answer');
      lastLiveLogsSnapshotRef.current = {
        chatId: activeChatId,
        turnId: freshTurnId || null,
        commitKey: null,
        logs: [
          ...(userLog ? [userLog] : []),
          ...actionLogs,
          ...(answerLog ? [answerLog] : []),
        ],
      };
    }

    // Check if traceLogs already has the committed answer for this turn.
    // Only then drop the snapshot — otherwise hold it to avoid the flash.
    const snapshot = lastLiveLogsSnapshotRef.current;
    const hasCommittedSnapshot = Boolean(
      snapshot.commitKey &&
      ownedTraceLogs.some(log => log?._liveCommitKey === snapshot.commitKey)
    );

    // Determine which live logs to append
    let liveLogs: any[];
    if (freshLiveLogs.length > 0) {
      // Fresh live data — use it directly
      liveLogs = lastLiveLogsSnapshotRef.current.logs;
    } else if (
      !hasCommittedSnapshot &&
      lastLiveLogsSnapshotRef.current.chatId === activeChatId &&
      lastLiveLogsSnapshotRef.current.logs.length > 0
    ) {
      // Live session ended but traceLogs hasn't committed answer yet — hold snapshot
      liveLogs = lastLiveLogsSnapshotRef.current.logs;
    } else {
      // traceLogs has the answer — safe to drop the snapshot
      if (lastLiveLogsSnapshotRef.current.chatId === activeChatId) {
        lastLiveLogsSnapshotRef.current = { chatId: null, turnId: null, commitKey: null, logs: [] };
      }
      liveLogs = [];
    }

    return [...filteredLogs, ...liveLogs];
  }, [activeChatId, liveChatId, isLiveSessionActive, traceLogs, getLiveTraceLogs]);

  const activeTurnTraceLogs = useMemo(() => {
    for (let i = traceLogs.length - 1; i >= 0; i--) {
      if (traceLogs[i]?.type === 'user_action') return traceLogs.slice(i);
    }
    return traceLogs;
  }, [traceLogs]);

  const currentSubAgents = useMemo(() => {
    const agentMap = new Map<string, any>();
    const getSubAgentIdentity = (log: any, name: string) =>
      String(log?.subAgentChatId || log?.subAgentId || name);
    const findLatestAgentKeyByName = (name: string) =>
      [...agentMap.entries()].reverse().find(([, agent]) => agent?.name === name)?.[0];
    const getTraceEventTime = (log: any) => {
      const at = Number(log?.startTime || log?.timestamp || log?.endTime || 0);
      return Number.isFinite(at) && at > 0 ? at : 0;
    };
    let firstTraceAt = Date.now();
    // Subagent tabs represent the whole chat, not only the newest user turn.
    // This keeps previously used agents available after the next message.
    for (const log of traceLogs) {
      const at = getTraceEventTime(log);
      if (at) {
        firstTraceAt = at;
        break;
      }
    }

    // Add Main agent if running or if we have trace logs for it
    if (isThinking) {
      let mainStatus = 'working';
      let mainStartedAt = 0;
      for (const log of activeTurnTraceLogs) {
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
        id: 'Main',
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
        // Main's live status is calculated from the active turn above. Historic
        // pause/close events must not overwrite the current run's state.
        continue;
      }

      // Polling can deliver an action/completion before its spawn event. Create
      // the tab from any real sub-agent lifecycle event so it never vanishes or
      // misses the first updates.
      const explicitIdentity = log.subAgentChatId || log.subAgentId;
      const agentIdentity = explicitIdentity
        ? getSubAgentIdentity(log, name)
        : findLatestAgentKeyByName(name) || name;

      if (!agentMap.has(agentIdentity) && /^sub_agent_(?:spawn|action|complete|error|pause|resume|close)$/.test(String(log.type || ''))) {
        agentMap.set(agentIdentity, {
          id: agentIdentity,
          subAgentId: log.subAgentId,
          subAgentChatId: log.subAgentChatId,
          name,
          status: log.type === 'sub_agent_complete' ? 'completed'
            : log.type === 'sub_agent_error' ? 'error'
              : log.type === 'sub_agent_pause' ? 'paused'
                : log.type === 'sub_agent_close' ? 'closed'
                  : 'working',
          task: log.task || log.secondary || (log.type === 'sub_agent_spawn' ? log.text : '') || '',
          stepCount: 0,
          durationMs: 0,
          startedAt: getTraceEventTime(log) || firstTraceAt,
        });
      }

      if (log.type === 'sub_agent_spawn') {
        const existing = agentMap.get(agentIdentity);
        agentMap.set(agentIdentity, {
          id: agentIdentity,
          subAgentId: log.subAgentId || existing?.subAgentId,
          subAgentChatId: log.subAgentChatId || existing?.subAgentChatId,
          name, status: existing?.status === 'closed' ? 'closed' : 'working', task: log.task || log.secondary || log.text || '',
          stepCount: 0, durationMs: 0, startedAt: existing?.startedAt || getTraceEventTime(log) || firstTraceAt,
        });
      } else if (log.type === 'sub_agent_action') {
        const a = agentMap.get(agentIdentity);
        if (a && a.status !== 'closed') { a.status = 'working'; a.currentAction = log.text?.substring(0, 80); a.stepCount = log.agentStep || (a.stepCount + 1); }
      } else if (log.type === 'sub_agent_complete') {
        const a = agentMap.get(agentIdentity);
        if (a) { a.status = 'completed'; a.durationMs = log.durationMs || 0; a.stepCount = log.stepCount || a.stepCount; }
      } else if (log.type === 'sub_agent_error') {
        const a = agentMap.get(agentIdentity);
        if (a) { a.status = 'error'; }
      } else if (log.type === 'sub_agent_pause') {
        const a = agentMap.get(agentIdentity);
        if (a) { a.status = 'paused'; }
      } else if (log.type === 'sub_agent_resume') {
        const a = agentMap.get(agentIdentity);
        if (a) { a.status = 'working'; }
      } else if (log.type === 'sub_agent_close') {
        const a = agentMap.get(agentIdentity);
        if (a) { a.status = 'closed'; }
      }
    }
    return Array.from(agentMap.values());
  }, [activeTurnTraceLogs, traceLogs, isThinking]);

  const realSubAgents = useMemo(
    () => currentSubAgents.filter((agent: any) => agent?.name && agent.name !== 'Main'),
    [currentSubAgents]
  );
  const activeSubAgentInfo = useMemo(
    () => activeSubAgentTab
      ? currentSubAgents.find((agent: any) => (agent.id || agent.name) === activeSubAgentTab) || null
      : null,
    [activeSubAgentTab, currentSubAgents],
  );

  useEffect(() => {
    if (realSubAgents.length > 0) return;
    setSubAgentDockOpen(false);
    setActiveSubAgentTab(null);
    setOverflowDropdownOpen(false);
  }, [realSubAgents.length]);

  useEffect(() => {
    const agentIds = realSubAgents.map((a: any) => a.id || a.name);
    setSubAgentOrder(prev => {
      const existing = prev.filter(id => agentIds.includes(id));
      const brandNew = agentIds.filter(id => !prev.includes(id));
      return [...existing, ...brandNew];
    });
  }, [realSubAgents]);

  const orderedRealSubAgents = useMemo(() => {
    return [...realSubAgents].sort((a, b) => {
      const indexA = subAgentOrder.indexOf(a.id || a.name);
      const indexB = subAgentOrder.indexOf(b.id || b.name);
      const finalA = indexA === -1 ? 9999 : indexA;
      const finalB = indexB === -1 ? 9999 : indexB;
      return finalA - finalB;
    });
  }, [realSubAgents, subAgentOrder]);

  const headerSubAgentTabs = useMemo(() => {
    const maxVisibleTabs = activeSubAgentTab ? 3 : 4;
    if (orderedRealSubAgents.length <= maxVisibleTabs) return orderedRealSubAgents;

    const activeIndex = orderedRealSubAgents.findIndex((agent: any) => (agent.id || agent.name) === activeSubAgentTab);
    if (activeIndex === -1 || activeIndex < maxVisibleTabs) {
      return orderedRealSubAgents.slice(0, maxVisibleTabs);
    }

    const result = orderedRealSubAgents.slice(0, maxVisibleTabs - 1);
    result.push(orderedRealSubAgents[activeIndex]);
    return result;
  }, [activeSubAgentTab, orderedRealSubAgents]);

  const hiddenSubAgents = useMemo(() => {
    const visibleIds = headerSubAgentTabs.map((a: any) => a.id || a.name);
    return orderedRealSubAgents.filter((agent: any) => !visibleIds.includes(agent.id || agent.name));
  }, [orderedRealSubAgents, headerSubAgentTabs]);

  const visibleAgentNames = useMemo(() => {
    return headerSubAgentTabs.map((agent: any) => agent.id || agent.name);
  }, [headerSubAgentTabs]);

  const handleReorderVisible = (newVisibleOrder: string[]) => {
    setSubAgentOrder(prev => {
      const currentVisibleIds = headerSubAgentTabs.map((agent: any) => agent.id || agent.name);
      const hiddenIds = prev.filter(id => !currentVisibleIds.includes(id));
      return [...newVisibleOrder, ...hiddenIds];
    });
  };

  const handleSelectHiddenAgent = (agentId: string) => {
    const maxVisibleTabs = activeSubAgentTab ? 3 : 4;
    setSubAgentOrder(prev => {
      const visibleNames = prev.slice(0, maxVisibleTabs);
      const activeIdx = visibleNames.indexOf(activeSubAgentTab || '');
      const swapTargetIdx = activeIdx !== -1 ? activeIdx : (maxVisibleTabs - 1);

      const newOrder = [...prev];
      const targetAgentName = newOrder[swapTargetIdx];
      const hiddenAgentIdx = newOrder.indexOf(agentId);

      if (hiddenAgentIdx !== -1 && swapTargetIdx < newOrder.length) {
        newOrder[swapTargetIdx] = agentId;
        newOrder[hiddenAgentIdx] = targetAgentName;
      }
      return newOrder;
    });
    setActiveSubAgentTab(agentId);
  };

  useEffect(() => {
    if (!activeChatId || !activeSubAgentTab) return;
    let cancelled = false;
    const chatId = activeChatId;
    const agentName = activeSubAgentInfo?.name || activeSubAgentTab;

    const syncSubAgentHistory = async () => {
      try {
        const params = new URLSearchParams({
          action: 'history',
          projectId: chatId,
          agentName,
          subAgentChatId: activeSubAgentTab,
          limit: '80',
        });
        const res = await fetch(`/api/agents/comm?${ params.toString() }`, { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const data = await res.json().catch(() => null);
        if (!data?.success || !Array.isArray(data.messages) || cancelled) return;

        const incomingLogs = data.messages
          .map((message: any) => interAgentMessageLog(message, agentName, activeSubAgentTab))
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
    const intervalId = window.setInterval(syncSubAgentHistory, 5000); // Sub-agent history — 5s cadence is sufficient
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeChatId, activeSubAgentInfo?.name, activeSubAgentTab]);

  const hiddenHeaderSubAgentCount = hiddenSubAgents.length;

  useEffect(() => {
    if (!activeSubAgentTab) return;
    if (!realSubAgents.some((agent: any) => (agent.id || agent.name) === activeSubAgentTab)) {
      setActiveSubAgentTab(null);
    }
  }, [activeSubAgentTab, realSubAgents]);

  // Per-sub-agent trace logs — filters the main traceLogs for the selected sub-agent tab
  const subAgentDisplayLogs = useMemo(() => {
    if (!activeSubAgentTab) return [];
    const selectedAgent = currentSubAgents.find(agent => (agent.id || agent.name) === activeSubAgentTab);
    const selectedAgentName = selectedAgent?.name || activeSubAgentTab;
    const filtered = traceLogs.filter(log => {
      if (!log) return false;
      const agentName = log.agentName || log.subAgent;
      const agentIdentity = String(log.subAgentChatId || log.subAgentId || agentName || '');
      return agentIdentity === activeSubAgentTab ||
        (!log.subAgentChatId && !log.subAgentId && agentName === selectedAgentName);
    });

    // Prepend a synthetic user_action log with the sub-agent's full task brief
    const agentInfo = selectedAgent;
    if (agentInfo && agentInfo.task) {
      return [
        {
          type: 'user_action',
          text: agentInfo.task,
          timestamp: agentInfo.startedAt || Date.now(),
          agentName: selectedAgentName,
          subAgent: selectedAgentName,
          subAgentId: agentInfo.id,
          subAgentChatId: agentInfo.id,
        },
        ...filtered
      ];
    }
    return filtered;
  }, [traceLogs, activeSubAgentTab, currentSubAgents]);

  // Which logs to show in ChatFeed — main or sub-agent
  const autonomousSelected = selectedAgent === 'autonomous';
  const effectiveDisplayLogs = activeSubAgentTab && !autonomousSelected ? subAgentDisplayLogs : displayTraceLogs;
  const composerContextUsage = useMemo(() => {
    // Keep the empty New Chat surface clean. The indicator begins with the
    // first real user boundary and remains isolated to this active chat.
    if (!traceLogs.some((log: any) => log?.type === 'user_action')) return null;

    const explicitEntry = parseModelEntryKey(activeModelSelection);
    const autoEntry = explicitEntry
      ? null
      : pickAutoModelEntry(proxyModelEntries, readRuntimeBaseApiKeys(), readRuntimeModelApiKeys()) || proxyModelEntries[0] || null;
    const selectedEntry = explicitEntry || autoEntry;
    const fallbackConfig = MAIN_AGENT_MODEL_OPTIONS.find(option => option.id === agentMode) || MAIN_AGENT_MODEL_OPTIONS[0];
    const provider = selectedEntry?.provider || fallbackConfig.provider;
    const modelId = selectedEntry?.modelId || fallbackConfig.modelName;

    let contextWindow = 0;
    try {
      const discovered = JSON.parse(localStorage.getItem(MODEL_CONTEXT_WINDOWS_STORAGE_KEY) || '{}');
      contextWindow = Number(discovered?.[modelEntryKey(provider, modelId)] || 0);
    } catch { }
    if (!Number.isFinite(contextWindow) || contextWindow < 16_000) {
      contextWindow = resolveClientContextWindow(provider, modelId);
    }
    try {
      const savedSettings = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}');
      let budgetSelection = String(savedSettings.contextWindowSizeSelection || '258000');
      if (activeChatId) {
        const chatOverrides = JSON.parse(localStorage.getItem(CHAT_CONTEXT_WINDOW_OVERRIDES_STORAGE_KEY) || '{}');
        const chatBudget = String(chatOverrides?.[activeChatId] || '').trim();
        if (chatBudget) budgetSelection = chatBudget;
      }
      const requestedBudget = budgetSelection === 'model_max'
        ? contextWindow
        : Number(budgetSelection || 258_000);
      if (Number.isFinite(requestedBudget) && requestedBudget >= 16_000) {
        contextWindow = Math.min(contextWindow, Math.floor(requestedBudget));
      }
    } catch {
      contextWindow = Math.min(contextWindow, 258_000);
    }
    const configuredContextWindow = contextWindow;

    const ownedLogs = traceLogs.filter((log: any) =>
      (!log?.ownerChatId || !activeChatId || log.ownerChatId === activeChatId)
      && log?.auxiliaryRuntime !== true
    );
    let displayTokens = 0;
    let authoritative: any = null;
    const estimatedByIdentity = new Map<string, number>();

    // Authoritative measurements describe the current model payload, not a
    // lifetime total for the chat. Estimates only fill the gap between those
    // measurements so bounded history and a new run can lower the live count.
    for (const log of ownedLogs) {
      if (log?.type === 'context_compaction' && log?.phase === 'compacted') {
        if (log?.chatId && activeChatId && log.chatId !== activeChatId) continue;
        const compactedTokens = Number(log?.afterTokens);
        if (Number.isFinite(compactedTokens) && compactedTokens >= 0) {
          displayTokens = compactedTokens;
        }
        continue;
      }

      if (log?.type === 'context_usage') {
        if (log?.chatId && activeChatId && log.chatId !== activeChatId) continue;
        const measuredTokens = Number(log?.usedTokens);
        if (!Number.isFinite(measuredTokens) || measuredTokens < 0) continue;
        displayTokens = measuredTokens;
        authoritative = log;
        continue;
      }

      const estimate = estimateLiveTraceTokens(log);
      if (estimate <= 0) continue;
      const identity = contextTraceEstimateIdentity(log);
      if (!identity) {
        displayTokens += estimate;
        continue;
      }
      const previousEstimate = estimatedByIdentity.get(identity) || 0;
      if (estimate > previousEstimate) {
        displayTokens += estimate - previousEstimate;
        estimatedByIdentity.set(identity, estimate);
      }
    }

    const authoritativeWindow = Number(authoritative?.contextWindow || 0);
    // While a run is active, its pinned server window is authoritative. Once
    // idle, use the current setting so increasing a chat budget is reflected
    // immediately instead of remaining stuck at an older smaller window.
    if (isThinking && Number.isFinite(authoritativeWindow) && authoritativeWindow >= 16_000) {
      contextWindow = authoritativeWindow;
    } else {
      contextWindow = configuredContextWindow;
    }
    const draftTokens = inputValue.trim() ? Math.ceil(inputValue.length / 4) + 4 : 0;
    const usedTokens = Math.max(0, Math.round(displayTokens + draftTokens));

    return {
      usedTokens,
      contextWindow,
      utilizationPct: contextWindow > 0 ? Math.max(0, Math.min(100, (usedTokens / contextWindow) * 100)) : 0,
      isEstimated: !authoritative,
    };
  }, [activeChatId, activeModelSelection, agentMode, contextSettingsRevision, inputValue, isThinking, proxyModelEntries, traceLogs]);
  // Compute effective thinking state
  const effectiveIsThinking = activeSubAgentTab && !autonomousSelected
    ? currentSubAgents.some(a => (a.id || a.name) === activeSubAgentTab && a.status === 'working')
    : isThinking && (!currentSubAgents.some(a => a.name === 'Main' && a.status === 'paused'));
  const handleStopSelectedFeed = (): Promise<boolean> => {
    const selectedSubAgent = activeSubAgentTab
      ? currentSubAgents.find(agent => (agent.id || agent.name) === activeSubAgentTab)
      : null;
    const agentName = activeSubAgentTab && !autonomousSelected
      ? selectedSubAgent?.name || activeSubAgentTab
      : null;
    if (!agentName) return handleStop();

    const chatId = activeChatIdRef.current;
    if (!chatId) return Promise.resolve(false);

    const requestKey = `${ chatId }:sub-agent:${ activeSubAgentTab }`;
    const existingRequest = stopRequestsRef.current.get(requestKey);
    if (existingRequest) return existingRequest;

    const stopRequest = (async () => {
      try {
        const response = await fetch('/api/agent/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'close',
            projectId: chatId,
            agentName,
            agentId: selectedSubAgent?.subAgentId,
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.success !== true || payload?.closed !== true) {
          throw new Error(payload?.error || `Stop failed (${ response.status })`);
        }
        setChatLogsById(chatId, previous => {
          const identity = selectedSubAgent?.subAgentChatId || selectedSubAgent?.subAgentId || activeSubAgentTab;
          const alreadyClosed = previous.some(log =>
            log?.type === 'sub_agent_close' &&
            String(log.subAgentChatId || log.subAgentId || log.agentName || log.subAgent || '') === String(identity)
          );
          if (alreadyClosed) return previous;
          return [...previous, {
            type: 'sub_agent_close',
            text: `${ agentName } stopped`,
            timestamp: Date.now(),
            agentName,
            subAgent: agentName,
            subAgentId: selectedSubAgent?.subAgentId,
            subAgentChatId: selectedSubAgent?.subAgentChatId || activeSubAgentTab,
            agentStatus: 'closed',
          }];
        });
        return true;
      } catch (error) {
        console.error(`[AgentControl] Failed to stop selected feed "${ agentName }":`, error);
        return false;
      } finally {
        stopRequestsRef.current.delete(requestKey);
      }
    })();

    stopRequestsRef.current.set(requestKey, stopRequest);
    return stopRequest;
  };
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

    if (activeWorkspacePath) {
      try {
        const response = await fetch('/api/code/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: `git checkout ${ branchName }`, cwd: activeWorkspacePath }),
        });
        const data = await response.json();
        if (data.stderr && data.stderr.includes('error:')) {
          setGitError(data.stderr);
        }
      } catch (err) {
        console.error('Failed to checkout branch:', err);
      }
    }

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

    if (activeWorkspacePath) {
      try {
        const response = await fetch('/api/code/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: `git checkout -b ${ newName }`, cwd: activeWorkspacePath }),
        });
        const data = await response.json();
        if (data.stderr && data.stderr.includes('error:')) {
          setGitError(data.stderr);
        }
      } catch (err) {
        console.error('Failed to create branch:', err);
      }
    }

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

  const loadRecentCommits = useCallback(() => {
    if (!activeWorkspacePath) return;
    setIsCommitsLoading(true);
    fetch('/api/code/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'git log -n 5 --oneline', cwd: activeWorkspacePath }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.stdout) {
          const parsed = data.stdout
            .split('\n')
            .filter(Boolean)
            .map((line: string) => {
              const parts = line.split(' ');
              const hash = parts[0];
              const msg = parts.slice(1).join(' ');
              return { hash, msg };
            });
          setRecentCommits(parsed);
        }
        setIsCommitsLoading(false);
      })
      .catch(() => {
        setIsCommitsLoading(false);
      });
  }, [activeWorkspacePath]);

  const loadGitStatus = useCallback(() => {
    if (!activeWorkspacePath) return;
    fetch('/api/code/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'git status -s', cwd: activeWorkspacePath }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.stdout) {
          const parsed = data.stdout
            .split('\n')
            .filter(Boolean)
            .map((line: string) => {
              const status = line.substring(0, 2).trim();
              const path = line.substring(3).trim();
              return { status, path };
            });
          setGitStatusList(parsed);
        } else {
          setGitStatusList([]);
        }
      })
      .catch(() => setGitStatusList([]));
  }, [activeWorkspacePath]);

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
    text: getLatestPetMonitorText(displayTraceLogs, isThinking) || '',
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
      // Main's task monitor and Live share the native overlay window. Main
      // becoming idle must never close an active Live orb.
      if (liveState === 'idle' || liveState === 'error') {
        (window as any).electronAPI?.closePetWindow?.();
      }
    }
  }, [isThinking, liveState]);

  useEffect(() => {
    if (!nativePetAvailable || !petWidgetOpen || !isThinking) return;
    (window as any).electronAPI?.updatePetWindow?.(petMonitorStatus);
  }, [isThinking, nativePetAvailable, petMonitorStatus, petWidgetOpen]);

  useEffect(() => {
    const api = (window as any).electronAPI;
    const unsubscribeReply = api?.onPetReply?.((message: string) => {
      const msgStr = String(message || '').trim();
      // Filter out internal control action JSON objects so they are not typed into the chat bar
      if (msgStr.startsWith('{')) {
        try {
          const parsed = JSON.parse(msgStr);
          if (parsed && parsed.action) return;
        } catch { }
      }
      void sendSteeringMessage(msgStr);
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
      {/* Global Window Drag Bar (Independent Layer) */}
      <div className="pointer-events-none absolute top-0 left-0 right-[150px] h-[var(--eterx-shell-topbar-height)] z-[998] [-webkit-app-region:drag]" />

      {/* Global Top Bar UI Container */}
      <div className="pointer-events-none absolute top-0 left-0 right-[150px] h-[var(--eterx-shell-topbar-height)] z-[999] flex items-center overflow-hidden">
        {/* Drag spacer — pointer-events-none so sidebar toggle clicks pass through */}
        <div className="eterx-topbar-sidebar-spacer shrink-0 pointer-events-none transition-[width] duration-300" />

        {/* Action buttons — API | Models | Theme | Help | Updates */}
        <div className="pointer-events-auto flex items-center gap-0 min-w-0 overflow-hidden [-webkit-app-region:no-drag]">
          {/* API */}
          <button type="button"
            onClick={() => { setSettingsInitialTab('api'); setIsSettingsOpen(true); }}
            className="eterx-topbar-btn px-[10px] h-full text-[13px] font-normal tracking-[0.01em] cursor-pointer select-none outline-none bg-transparent border-0 transition-colors duration-150"
            style={{ color: 'var(--sidebar-muted-text, #9A9590)' }}>
            API
          </button>

          {/* Models */}
          <button type="button"
            onClick={() => { setSettingsInitialTab('models'); setIsSettingsOpen(true); }}
            className="eterx-topbar-btn px-[10px] h-full text-[13px] font-normal tracking-[0.01em] cursor-pointer select-none outline-none bg-transparent border-0 transition-colors duration-150"
            style={{ color: 'var(--sidebar-muted-text, #9A9590)' }}>
            Models
          </button>

          {/* Theme toggle — light/dark dropdown (Powered by Radix UI Portal) */}
          <div className="relative flex items-center">
            <DropdownMenu.Root open={topbarThemeOpen} onOpenChange={(open) => setActiveTopbarMenu(open ? 'theme' : null)}>
              <DropdownMenu.Trigger asChild>
                <button type="button"
                  className="eterx-topbar-btn px-[10px] h-full text-[13px] font-normal tracking-[0.01em] cursor-pointer select-none outline-none bg-transparent border-0 transition-colors duration-150"
                  style={{ color: 'var(--sidebar-muted-text, #9A9590)' }}>
                  Theme
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={6}
                  className="w-[110px] flex flex-col gap-[2px] rounded-[10px] p-[4px] z-[9999] pointer-events-auto [-webkit-app-region:no-drag]"
                  style={{
                    background: 'var(--eterx-dropdown-bg, var(--sidebar-bg, #F0EDE8))',
                    border: '1px solid var(--eterx-dropdown-border, var(--sidebar-border, rgba(0,0,0,0.1)))',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06)',
                  }}
                >
                  {([
                    { value: 'light', label: 'Light', icon: Sun },
                    { value: 'dark', label: 'Dark', icon: Moon },
                  ] as const).map(({ value, label, icon: Icon }) => {
                    const currentTheme = (() => {
                      try {
                        return document.documentElement.getAttribute('data-theme') || 'light';
                      } catch {
                        return 'light';
                      }
                    })();
                    const isActive = currentTheme === value;
                    return (
                      <DropdownMenu.Item
                        key={value}
                        asChild
                        onSelect={(e) => {
                          e.preventDefault();
                          handleThemeChange(value as 'light' | 'dark');
                          setActiveTopbarMenu(null);
                        }}
                      >
                        <button
                          type="button"
                          className="flex items-center justify-between gap-[8px] w-full px-[8px] py-[6px] text-[12px] font-medium rounded-[6px] text-left transition-all duration-150 outline-none border-0 cursor-pointer pointer-events-auto"
                          style={{
                            background: isActive ? 'var(--sidebar-hover-bg, rgba(0,0,0,0.06))' : 'transparent',
                            color: 'var(--sidebar-strong-text, currentColor)',
                            opacity: isActive ? 1 : 0.65,
                          }}
                          onMouseEnter={e => {
                            if (!isActive) {
                              e.currentTarget.style.background = 'var(--sidebar-hover-bg, rgba(0,0,0,0.03))';
                              e.currentTarget.style.opacity = '0.9';
                            }
                          }}
                          onMouseLeave={e => {
                            if (!isActive) {
                              e.currentTarget.style.background = 'transparent';
                              e.currentTarget.style.opacity = '0.65';
                            }
                          }}
                        >
                          <div className="flex items-center gap-[6px]">
                            <Icon size={14} strokeWidth={isActive ? 2 : 1.5} />
                            <span>{label}</span>
                          </div>
                          {isActive && <Check size={14} strokeWidth={2.5} />}
                        </button>
                      </DropdownMenu.Item>
                    );
                  })}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>

          {/* Help dropdown */}
          <div className="relative flex items-center">
            <DropdownMenu.Root open={topbarHelpOpen} onOpenChange={(open) => setActiveTopbarMenu(open ? 'help' : null)}>
              <DropdownMenu.Trigger asChild>
                <button type="button"
                  className="eterx-topbar-btn px-[10px] h-full text-[13px] font-normal tracking-[0.01em] cursor-pointer select-none outline-none bg-transparent border-0 transition-colors duration-150"
                  style={{ color: 'var(--sidebar-muted-text, #9A9590)' }}>
                  Help
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={6}
                  className="w-[180px] flex flex-col gap-[2px] rounded-[10px] p-[4px] z-[9999] pointer-events-auto [-webkit-app-region:no-drag]"
                  style={{
                    background: 'var(--eterx-dropdown-bg, var(--sidebar-bg, #F0EDE8))',
                    border: '1px solid var(--eterx-dropdown-border, var(--sidebar-border, rgba(0,0,0,0.1)))',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06)',
                  }}
                >
                  <DropdownMenu.Item
                    asChild
                    onSelect={async (e) => {
                      e.preventDefault();
                      setActiveTopbarMenu(null);
                      await persistChats(chatsRef.current, true);
                      if ((window as any).electronAPI?.restartApp) {
                        await (window as any).electronAPI.restartApp();
                      } else {
                        window.location.reload();
                      }
                    }}
                  >
                    <button
                      type="button"
                      className="flex items-center gap-[8px] w-full px-[8px] py-[6px] text-[12px] font-medium rounded-[6px] text-left transition-all duration-150 outline-none border-0 cursor-pointer pointer-events-auto"
                      style={{
                        background: 'transparent',
                        color: 'var(--sidebar-strong-text, currentColor)',
                        opacity: 0.8,
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.background = 'var(--sidebar-hover-bg, rgba(0,0,0,0.03))';
                        e.currentTarget.style.opacity = '1';
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.opacity = '0.8';
                      }}
                    >
                      <RefreshCw size={14} />
                      <span>Restart</span>
                    </button>
                  </DropdownMenu.Item>

                  <DropdownMenu.Item
                    asChild
                    onSelect={async (e) => {
                      e.preventDefault();
                      setActiveTopbarMenu(null);
                      await persistChats(chatsRef.current, true);
                      if ((window as any).electronAPI?.closeApp) {
                        await (window as any).electronAPI.closeApp();
                      } else {
                        window.close();
                      }
                    }}
                  >
                    <button
                      type="button"
                      className="flex items-center gap-[8px] w-full px-[8px] py-[6px] text-[12px] font-medium rounded-[6px] text-left transition-all duration-150 outline-none border-0 cursor-pointer pointer-events-auto"
                      style={{
                        background: 'transparent',
                        color: 'var(--sidebar-strong-text, currentColor)',
                        opacity: 0.8,
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.background = 'var(--sidebar-hover-bg, rgba(0,0,0,0.03))';
                        e.currentTarget.style.opacity = '1';
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.opacity = '0.8';
                      }}
                    >
                      <Power size={14} />
                      <span>Close Completely</span>
                    </button>
                  </DropdownMenu.Item>

                  <DropdownMenu.Item
                    asChild
                    onSelect={(e) => {
                      e.preventDefault();
                      setActiveTopbarMenu(null);
                      const email = 'harshilsoni5666@gmail.com';
                      const subject = encodeURIComponent('Feedback / Found A Bug - EterX Agent');
                      const body = encodeURIComponent('Hi Harshil,\n\nI found a bug / have some feedback:\n\n[Describe the bug or feedback here]');
                      const mailtoUrl = `mailto:${ email }?subject=${ subject }&body=${ body }`;
                      if ((window as any).electronAPI?.openExternal) {
                        (window as any).electronAPI.openExternal(mailtoUrl);
                      } else {
                        window.location.href = mailtoUrl;
                      }
                    }}
                  >
                    <button
                      type="button"
                      className="flex items-center gap-[8px] w-full px-[8px] py-[6px] text-[12px] font-medium rounded-[6px] text-left transition-all duration-150 outline-none border-0 cursor-pointer pointer-events-auto"
                      style={{
                        background: 'transparent',
                        color: 'var(--sidebar-strong-text, currentColor)',
                        opacity: 0.8,
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.background = 'var(--sidebar-hover-bg, rgba(0,0,0,0.03))';
                        e.currentTarget.style.opacity = '1';
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.opacity = '0.8';
                      }}
                    >
                      <Bug size={14} />
                      <span>Feedback / Found A Bug</span>
                    </button>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>

          {/* Updates */}
          <button type="button"
            onClick={() => openSettingsWindow('updates')}
            className="eterx-topbar-btn px-[10px] h-full text-[13px] font-normal tracking-[0.01em] cursor-pointer select-none outline-none bg-transparent border-0 transition-colors duration-150"
            style={{ color: 'var(--sidebar-muted-text, #9A9590)' }}>
            Updates
          </button>
        </div>
        {/* Right drag fill */}
        <div className="flex-1" />
      </div>
      <FloatingPetMonitor
        open={petWidgetOpen && !nativePetAvailable}
        isThinking={isThinking}
        title={petMonitorTitle}
        logs={displayTraceLogs}
        onClose={() => setPetWidgetOpen(false)}
        onReply={sendSteeringMessage}
      />

      {sidebarOpen && (
        <>
          {/* Responsive backdrop overlay to close sidebar on click-away */}
          <div
            onClick={() => setSidebarOpen(false)}
            className="eterx-sidebar-overlay-backdrop fixed inset-0 bg-black/40 z-[199] transition-opacity duration-300"
          />
          <Sidebar
            isOpen={sidebarOpen}
            setIsOpen={setSidebarOpen}
            createNewChat={createNewChat}
            chats={nonBuilderChats}
            activeChatId={activeChatId}
            loadChat={loadChat}
            deleteChat={deleteChat}
            deleteChats={deleteChats}
            renameChat={renameChat}
            toggleFavorite={toggleFavorite}
            onSearchClick={() => setCmdPaletteOpen(true)}
            activeView={activeView}
            setActiveView={setActiveView}
            runningChats={sidebarRunningChats}
            unreadChats={unreadChatIds}
            onSettingsClick={openSettingsWindow}
            isThinking={isThinking}
          />
        </>
      )}

      <SettingsPanel isOpen={isSettingsOpen} initialTab={settingsInitialTab as any} onClose={() => setIsSettingsOpen(false)} />
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
        </>
      )}

      <div className="eterx-workspace-shell flex-1 flex flex-col relative overflow-hidden z-10 transition-colors duration-300">
        {/* Absolute Header (Draggable Region for Electron) */}
        <>
          <div className={`eterx-main-panel ${ !sidebarOpen ? 'eterx-main-panel-sidebar-closed' : '' } flex-1 flex flex-col relative overflow-hidden`}>
            <div className="eterx-main-header relative z-50 flex h-[var(--eterx-main-header-height)] shrink-0 items-center justify-between gap-4 border-b border-[var(--border)] pl-3 pr-6 [-webkit-app-region:drag]">
              <div className="flex min-w-0 flex-1 overflow-visible items-center gap-2 pointer-events-auto [-webkit-app-region:no-drag]">
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
                  const titleText = activeChat
                    ? activeChat.title
                    : isLiveSessionActive
                      ? 'Live Conversation'
                      : DEFAULT_CHAT_TITLE;

                  return (
                    <div className="relative z-[70] min-w-0 overflow-visible [-webkit-app-region:no-drag]">
                      <div
                        data-open={headerMenuOpen ? 'true' : 'false'}
                        onClick={() => {
                          if (!isEditingChatTitle) {
                            setChatActionMenuOpen(false);
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
                                setChatActionMenuOpen(false);
                                setHeaderMenuOpen(!headerMenuOpen);
                              }
                            }}
                            className="w-[24px] h-[24px] flex items-center justify-center rounded-full hover:bg-white/10 active:bg-white/15 text-[#555350] hover:text-white transition-all duration-150"
                          >
                            <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${ headerMenuOpen ? 'rotate-180 text-white' : '' }`} strokeWidth={1.6} />
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
                              className="eterx-thread-switcher absolute left-0 top-[calc(100%+8px)] w-[300px] z-[80] bg-[#1E1E1E]/95 backdrop-blur-xl border border-white/[0.08] rounded-xl shadow-[0_12px_36px_rgba(0,0,0,0.5)] p-1.5 flex flex-col max-h-[400px]"
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
                              <div className="overflow-y-auto eterx-scrollbar flex-1 space-y-[2px]">
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
              {subAgentDockOpen && realSubAgents.length > 0 && activeView === 'chat' && activeChatId && !autonomousSelected && (
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
                        initial={{ opacity: 0, scale: 0.92 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="eterx-agent-tab-active-bg"
                        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                      />
                    )}
                    <span className="eterx-agent-tab-label max-w-[120px] truncate">
                      {selectedAgent ? selectedAgentName : 'Main'}
                    </span>
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
                      const agentIdentity = agent.id || agent.name;
                      const isActive = activeSubAgentTab === agentIdentity;
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
                          key={agentIdentity}
                          value={agentIdentity}
                          as="div"
                          // Reorder.Item's onTap is unreliable when the item is
                          // also draggable (especially after a drag or on touch).
                          // Use the native click event so selecting a tab always
                          // updates the active workspace.
                          onClick={(event: React.MouseEvent) => {
                            event.stopPropagation();
                            setActiveSubAgentTab(agentIdentity);
                            setOverflowDropdownOpen(false);
                          }}
                          onPointerDown={(event: React.PointerEvent) => {
                            if (event.button !== 0) return;
                            setActiveSubAgentTab(agentIdentity);
                            setOverflowDropdownOpen(false);
                          }}
                          onKeyDown={(event: React.KeyboardEvent) => {
                            if (event.key !== 'Enter' && event.key !== ' ') return;
                            event.preventDefault();
                            setActiveSubAgentTab(agentIdentity);
                            setOverflowDropdownOpen(false);
                          }}
                          role="tab"
                          tabIndex={0}
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
                              initial={{ opacity: 0, scale: 0.92 }}
                              animate={{ opacity: 1, scale: 1 }}
                              className="eterx-agent-tab-active-bg"
                              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                            />
                          )}
                          <SubAgentAvatar name={agent.name} status={agent.status} size="xs" />
                          <Shimmer active={isWorking} className="eterx-agent-tab-label min-w-0 truncate">{agent.name}</Shimmer>
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
                                key={agent.id || agent.name}
                                type="button"
                                onClick={() => {
                                  handleSelectHiddenAgent(agent.id || agent.name);
                                  setOverflowDropdownOpen(false);
                                }}
                                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] font-medium text-white/70 transition-all hover:bg-white/5 hover:text-white active:scale-[0.98]"
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

              <div className="flex shrink-0 items-center gap-1 pointer-events-auto [-webkit-app-region:no-drag] ml-auto">
                {isHeaderGitRepo && !!activeChatId && (
                  <div className="relative group">
                    <button
                      type="button"
                      aria-label={`Git branch ${ currentBranch }`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setGithubDropdownOpen(!githubDropdownOpen);
                        setEnvDropdownOpen(false);
                      }}
                      className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-transparent bg-transparent text-[var(--sidebar-muted-text)] transition-colors duration-150 hover:bg-[var(--sidebar-toggle-hover-bg)] hover:text-[var(--sidebar-hover-text)] active:bg-[var(--sidebar-toggle-active-bg)] focus-visible:outline-none ${ githubDropdownOpen ? 'text-white bg-[var(--sidebar-toggle-hover-bg)]' : '' }`}
                    >
                      <svg viewBox="0 0 16 16" className="h-[17px] w-[17px] fill-current">
                        <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                      </svg>
                    </button>
                    {/* Tooltip on hover */}
                    {!githubDropdownOpen && (
                      <div className="absolute right-0 top-[calc(100%+8px)] hidden group-hover:block z-[90] bg-[#1E1E1E]/95 border border-white/[0.08] backdrop-blur-xl rounded-md px-2 py-1 text-[11px] font-semibold text-white/90 whitespace-nowrap shadow-lg select-none pointer-events-none">
                        Branch: {currentBranch}
                      </div>
                    )}
                    <AnimatePresence>
                      {githubDropdownOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => { setGithubDropdownOpen(false); setHoveredSubmenu(null); }} />
                          <motion.div
                            ref={githubDropdownRef}
                            initial={{ opacity: 0, y: 8, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 8, scale: 0.98 }}
                            transition={{ duration: 0.15, ease: "easeOut" }}
                            className="absolute right-0 top-[calc(100%+10px)] z-50 flex w-[236px] flex-col rounded-xl border border-white/[0.08] bg-[#1A1A1A]/95 backdrop-blur-2xl p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.68),inset_0_1px_0_rgba(255,255,255,0.04)] text-[#F4F1EA]"
                            onClick={(e) => e.stopPropagation()}
                            onMouseLeave={() => setHoveredSubmenu(null)}
                          >
                            <div
                              className="px-2.5 py-1 text-[9px] font-bold text-[#6A6460] tracking-wider select-none mb-1"
                              onMouseEnter={() => setHoveredSubmenu(null)}
                            >
                              Git Workspace
                            </div>

                            {/* Branch Selection (Submenu) */}
                            <div className="relative">
                              <button
                                type="button"
                                className={`w-full text-left px-2.5 py-1.5 text-[12px] font-semibold rounded-lg transition-all flex items-center justify-between ${ hoveredSubmenu === 'branch' ? 'text-white bg-white/5' : 'text-white/75 hover:text-white hover:bg-white/5' }`}
                                onMouseEnter={() => {
                                  setHoveredSubmenu('branch');
                                  fetchGitInfo();
                                }}
                              >
                                <div className="flex items-center gap-2 truncate pr-1">
                                  <GitBranch className="h-3.5 w-3.5 text-white/75" />
                                  <span className="truncate">Branch: {currentBranch}</span>
                                </div>
                                <ChevronLeft className="h-3.5 w-3.5 text-white/40" />
                              </button>
                            </div>

                            {/* Create Branch Form */}
                            {isCreatingBranch ? (
                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  handleCreateBranchSubmit();
                                }}
                                className="flex items-center gap-2 border border-white/10 rounded-lg px-2.5 py-1 bg-white/[0.02] mt-1 mx-0.5"
                                onMouseEnter={() => setHoveredSubmenu(null)}
                              >
                                <GitBranch className="h-3.5 w-3.5 text-white/50" />
                                <input
                                  autoFocus
                                  value={newBranchName}
                                  onChange={(e) => setNewBranchName(e.target.value)}
                                  placeholder="Branch name..."
                                  className="bg-transparent text-[12px] text-white placeholder-white/30 outline-none w-full font-medium"
                                  onBlur={() => {
                                    if (!newBranchName.trim()) {
                                      setIsCreatingBranch(false);
                                    }
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Escape') {
                                      setIsCreatingBranch(false);
                                      setNewBranchName('');
                                    }
                                  }}
                                />
                              </form>
                            ) : (
                              <button
                                type="button"
                                className="w-full text-left px-2.5 py-1.5 text-[12px] font-semibold text-white/75 hover:text-white hover:bg-white/5 rounded-lg transition-all flex items-center gap-2"
                                onMouseEnter={() => setHoveredSubmenu(null)}
                                onClick={() => {
                                  setIsCreatingBranch(true);
                                  setNewBranchName('');
                                }}
                              >
                                <Plus className="h-3.5 w-3.5 text-white/75" />
                                <span>Create Branch</span>
                              </button>
                            )}

                            <div className="h-px bg-white/[0.06] my-1.5 mx-1" onMouseEnter={() => setHoveredSubmenu(null)} />

                            {/* Recent Commits (Submenu Button) */}
                            <div className="relative">
                              <button
                                type="button"
                                className={`w-full text-left px-2.5 py-1.5 text-[12px] font-semibold rounded-lg transition-all flex items-center justify-between ${ hoveredSubmenu === 'commits' ? 'text-white bg-white/5' : 'text-white/75 hover:text-white hover:bg-white/5' }`}
                                onMouseEnter={() => {
                                  setHoveredSubmenu('commits');
                                  loadRecentCommits();
                                }}
                              >
                                <div className="flex items-center gap-2">
                                  <Clock3 className="h-3.5 w-3.5" />
                                  <span>Recent Commits</span>
                                </div>
                                <ChevronLeft className="h-3.5 w-3.5 text-white/40" />
                              </button>
                            </div>

                            {/* Floating Side Submenu Panel */}
                            <AnimatePresence>
                              {hoveredSubmenu && (
                                <motion.div
                                  initial={{ opacity: 0, x: 6, scale: 0.98 }}
                                  animate={{ opacity: 1, x: 0, scale: 1 }}
                                  exit={{ opacity: 0, x: 6, scale: 0.98 }}
                                  transition={{ duration: 0.15, ease: "easeOut" }}
                                  onMouseEnter={() => setHoveredSubmenu(hoveredSubmenu)}
                                  onMouseLeave={() => setHoveredSubmenu(null)}
                                  className="absolute right-full mr-0.5 top-0 z-50 flex w-[245px] flex-col rounded-xl border border-white/[0.08] bg-[#1A1A1A]/95 backdrop-blur-2xl p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.68),inset_0_1px_0_rgba(255,255,255,0.04)] text-[#F4F1EA] pointer-events-auto"
                                >
                                  {hoveredSubmenu === 'branch' && (
                                    <>
                                      <div className="px-2.5 py-1 text-[9px] font-bold text-[#6A6460] tracking-wider select-none mb-1">
                                        Select Branch
                                      </div>
                                      <div className="flex flex-col gap-0.5 max-h-[220px] overflow-y-auto eterx-scrollbar">
                                        {gitBranches.map(b => {
                                          const isCurrent = b.name === currentBranch;
                                          return (
                                            <button
                                              key={b.name}
                                              type="button"
                                              className={`group/item flex items-center justify-between px-2.5 py-1.5 text-[12px] font-semibold rounded-lg transition-colors leading-none ${ isCurrent ? 'bg-white/[0.08] text-white' : 'text-white/60 hover:text-white hover:bg-white/5' }`}
                                              onClick={() => {
                                                handleCheckoutBranch(b.name);
                                                setGithubDropdownOpen(false);
                                                setHoveredSubmenu(null);
                                              }}
                                            >
                                              <span className="truncate pr-1 text-left">{b.name}</span>
                                              {isCurrent && <Check className="h-3 w-3 shrink-0" />}
                                            </button>
                                          );
                                        })}
                                      </div>
                                    </>
                                  )}

                                  {hoveredSubmenu === 'commits' && (
                                    <>
                                      <div className="px-2.5 py-1 flex items-center justify-between mb-1 select-none">
                                        <span className="text-[9px] font-bold text-[#6A6460] tracking-wider">
                                          Commit History
                                        </span>
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            loadRecentCommits();
                                          }}
                                          className="p-1 rounded hover:bg-white/5 text-white/40 hover:text-white transition-colors"
                                          title="Refresh commits"
                                        >
                                          <RefreshCw className={`h-3 w-3 ${ isCommitsLoading ? 'animate-spin' : '' }`} />
                                        </button>
                                      </div>

                                      {isCommitsLoading ? (
                                        <div className="flex flex-col items-center justify-center py-6 select-none">
                                          <RefreshCw className="h-4 w-4 animate-spin text-white/40" />
                                          <span className="text-[10px] text-white/30 mt-2 font-medium">Loading commits...</span>
                                        </div>
                                      ) : recentCommits.length === 0 ? (
                                        <div className="px-2.5 py-2 text-[11px] text-white/40 font-medium text-center">No commits found</div>
                                      ) : (
                                        <div className="flex flex-col gap-0.5 max-h-[220px] overflow-y-auto eterx-scrollbar">
                                          {recentCommits.map((c, idx) => (
                                            <button
                                              key={idx}
                                              type="button"
                                              onClick={() => {
                                                navigator.clipboard.writeText(c.hash);
                                                alert(`Copied hash ${ c.hash } to clipboard!`);
                                              }}
                                              className="text-left px-2 py-1.5 rounded-lg hover:bg-white/5 transition-all flex items-center gap-2"
                                              title="Click to copy hash"
                                            >
                                              <span className="text-[10px] font-mono font-bold text-white/50 bg-white/[0.04] px-1.5 py-0.5 rounded border border-white/[0.06] shrink-0 leading-none">
                                                {c.hash}
                                              </span>
                                              <span className="text-[11.5px] text-white/80 truncate font-semibold flex-1 leading-none">
                                                {c.msg}
                                              </span>
                                            </button>
                                          ))}
                                        </div>
                                      )}
                                    </>
                                  )}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </motion.div>
                        </>
                      )}
                    </AnimatePresence>
                  </div>
                )}
                {canUseMonitor && realSubAgents.length > 0 && !autonomousSelected && (
                  <button
                    type="button"
                    aria-label={subAgentDockOpen ? 'Close subagent tabs' : 'Open subagent tabs'}
                    title={subAgentDockOpen ? 'Close subagent tabs' : `Open subagent tabs (${ realSubAgents.length })`}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSubAgentDockOpen(previous => {
                        const next = !previous;
                        if (!next) {
                          setActiveSubAgentTab(null);
                          setOverflowDropdownOpen(false);
                        }
                        return next;
                      });
                    }}
                    className={`relative eterx-header-icon-button flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-transparent bg-transparent transition-colors duration-150 hover:bg-[var(--sidebar-toggle-hover-bg)] hover:text-[var(--sidebar-hover-text)] active:bg-[var(--sidebar-toggle-active-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus-ring)] ${ subAgentDockOpen ? 'bg-[var(--sidebar-toggle-hover-bg)] text-[var(--sidebar-hover-text)]' : 'text-[var(--sidebar-muted-text)]' }`}
                  >
                    <AnimatePresence mode="wait" initial={false}>
                      {subAgentDockOpen ? (
                        <motion.span
                          key="close-subagent-tabs"
                          initial={{ opacity: 0, rotate: -45, scale: 0.75 }}
                          animate={{ opacity: 1, rotate: 0, scale: 1 }}
                          exit={{ opacity: 0, rotate: 45, scale: 0.75 }}
                          transition={{ duration: 0.14 }}
                          className="flex items-center justify-center"
                        >
                          <X className="h-[17px] w-[17px]" strokeWidth={2.15} />
                        </motion.span>
                      ) : (
                        <motion.span
                          key="open-subagent-tabs"
                          initial={{ opacity: 0, rotate: 30, scale: 0.75 }}
                          animate={{ opacity: 1, rotate: 0, scale: 1 }}
                          exit={{ opacity: 0, rotate: -30, scale: 0.75 }}
                          transition={{ duration: 0.14 }}
                          className="flex items-center justify-center"
                        >
                          <GitFork className="h-[17px] w-[17px]" strokeWidth={2.05} />
                          <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-[#111] bg-[#E8E6E3] px-0.5 text-[8px] font-bold leading-none text-[#111]">
                            {realSubAgents.length > 9 ? '9+' : realSubAgents.length}
                          </span>
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </button>
                )}
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
                      className={`relative eterx-header-icon-button flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 ${ envDropdownOpen ? 'border-white/10 bg-white/[0.12] text-white shadow-[0_2px_8px_rgba(0,0,0,0.25)]' : 'border-transparent bg-transparent text-[var(--sidebar-muted-text)] hover:bg-[var(--sidebar-toggle-hover-bg)] hover:text-[var(--sidebar-hover-text)] active:bg-[var(--sidebar-toggle-active-bg)]' }`}
                    >
                      <ListTodo className="h-[17px] w-[17px]" strokeWidth={2.15} />
                    </button>
                    <AnimatePresence>
                      {envDropdownOpen && (
                        <motion.div
                          ref={envDropdownRef}
                          initial={{ opacity: 0, y: -5, scale: 0.98 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -5, scale: 0.98 }}
                          transition={{ duration: 0.15, ease: "easeOut" }}
                          onMouseLeave={() => setActiveSubmenu(null)}
                          className="eterx-work-menu absolute right-0 top-[calc(100%+10px)] z-[70] flex flex-col"
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <div className="eterx-work-menu-content flex-1 overflow-y-auto eterx-scrollbar">
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
                                      className="eterx-work-menu-list eterx-scrollbar mb-1"
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
                                                <Shimmer active={activeWorking} className={`truncate flex-1 ${ step.status === 'done' ? 'line-through text-white/45' : activeWorking ? 'text-white font-medium' : 'text-white/70' }`}>
                                                  {step.name || `Task ${ step.step }`}
                                                </Shimmer>
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
                                      className="eterx-work-menu-list eterx-scrollbar"
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
                                              <img src={iconPath} alt="" className="eterx-work-menu-row-icon object-contain" />
                                              <span className="min-w-0 flex-1 truncate">{item.name}</span>
                                              {item.isPinned && <Pin className="h-3 w-3 shrink-0 text-white/30" />}
                                              {item.status && (
                                                <span className="shrink-0 text-[9px] font-semibold text-white/35">{item.status}</span>
                                              )}
                                              {((item.additions || 0) > 0 || (item.deletions || 0) > 0) && (
                                                <div className="flex shrink-0 items-center gap-1 text-[10px] font-medium">
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
                                      className="eterx-work-menu-list eterx-scrollbar"
                                    >
                                      {realSubAgents.length > 0 ? (
                                        realSubAgents.map((agent) => {
                                          const isClosed = agent.status === 'closed';
                                          return (
                                            <div
                                              key={agent.id || agent.name}
                                              className="eterx-work-menu-row group"
                                              onClick={() => {
                                                handleOpenAgentTeam(agent.id || agent.name);
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
                        )}
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
                  onOpenChat={(chatId) => {
                    setActiveView('chat');
                    loadChat(chatId);
                  }}
                />
              ) : (
                <>
                  {/* Chat Container */}
                  <div
                    className={`eterx-chat-column flex flex-col relative h-full min-w-0 ${ sidebarOpen && autonomousSelected && activeChatId ? '[&_.eterx-chat-feed-content]:-translate-x-[80px] [&_.eterx-chat-input-dock]:-translate-x-[80px]' : '' } ${ hasOpenFiles ? `shrink-0 min-w-[320px] ${ isResizingPanels ? 'transition-none' : 'transition-[width,flex-basis] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]' }` : 'w-full transition-all duration-300' }`}
                    data-proxy-active={sidebarOpen && autonomousSelected && activeChatId ? 'true' : 'false'}
                    style={hasOpenFiles ? { width: chatPanelWidth ?? undefined, flexBasis: chatPanelWidth === null ? `${ DEFAULT_CHAT_PANEL_RATIO * 100 }%` : undefined } : undefined}
                  >
                    {autonomousSelected && activeChatId && (
                      <div className="eterx-proxy-dock pointer-events-none absolute right-6 top-1/2 z-[60] w-[224px] -translate-y-1/2 transition-all duration-300 ease-in-out">
                        <div ref={proxyCardRef} className="eterx-proxy-card pointer-events-auto flex h-fit flex-col gap-2 rounded-[20px] border border-white/[0.10] bg-[#252525]/95 px-3 pb-3 pt-3 shadow-[0_18px_44px_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl select-none">
                          {/* Professional Header */}
                          <div className="pt-1 pb-1 shrink-0 flex items-center justify-center w-full">
                            <span className="eterx-proxy-title text-[14px] font-semibold tracking-[0.02em] text-white/95 text-center">Proxy-Agent</span>
                          </div>

                          {/* UNIFIED JOINED CONTROL GROUP (All 4 Controls Joined) */}
                          <div className="eterx-proxy-group-block w-full flex flex-col rounded-2xl border border-white/[0.08] bg-white/[0.03] shrink-0">
                            {/* 1. Pause / Resume Proxy Button (Top Item) */}
                            <button
                              type="button"
                              onClick={handleProxyToggle}
                              className="eterx-proxy-group-item w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-t-2xl text-[12px] font-medium text-white/85 hover:bg-white/[0.06] hover:text-white transition-colors shrink-0"
                            >
                              {proxyEnabled ? (
                                <>
                                  <Pause className="h-3.5 w-3.5 text-white/60" />
                                  <span>Pause Proxy</span>
                                </>
                              ) : (
                                <>
                                  <Play className="h-3.5 w-3.5 text-white/60" />
                                  <span>Resume Proxy</span>
                                </>
                              )}
                            </button>

                            <div className="h-[1px] w-full bg-white/[0.06] eterx-proxy-group-divider" />

                            {/* 2. Proxy Model Row */}
                            <div className="group relative">
                              <div
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setShowProxyInterventionMenu(false);
                                  setShowProxyRuntimeModelMenu(value => !value);
                                }}
                                className="eterx-proxy-group-item w-full flex min-w-0 items-center justify-between gap-2 px-3 py-2.5 text-[12px] font-medium text-white/85 hover:bg-white/[0.06] cursor-pointer transition-colors"
                              >
                                <span className="text-white/50 shrink-0 text-[12px]">Proxy model</span>
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setShowProxyInterventionMenu(false);
                                    setShowProxyRuntimeModelMenu(value => !value);
                                  }}
                                  className="flex min-w-0 max-w-[115px] items-center justify-end gap-1 px-1.5 py-0.5 rounded-lg text-white/90 font-semibold bg-transparent hover:bg-white/[0.08] active:bg-white/[0.12] transition-colors"
                                  title="Model used by the live runtime Proxy-Agent"
                                >
                                  <span className="truncate text-[12px]">
                                    {proxyRuntimeModelSelection === AUTO_MODEL_SELECTION
                                      ? 'Auto'
                                      : (proxyModelEntries.find(entry => modelEntryKey(entry.provider, entry.modelId) === proxyRuntimeModelSelection)?.modelId || 'Auto')}
                                  </span>
                                  <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-white/35 transition-transform duration-200 ${ showProxyRuntimeModelMenu ? 'rotate-180' : '' }`} />
                                </button>
                              </div>
                              {showProxyRuntimeModelMenu && (
                                <div className="eterx-proxy-runtime-model-menu eterx-scrollbar absolute right-0 top-full z-[110] mt-1.5 w-[220px] max-h-[260px] overflow-y-auto rounded-2xl border border-white/[0.10] bg-[#252525] p-1.5 shadow-2xl">
                                  <button
                                    type="button"
                                    onClick={() => { handleProxyRuntimeModelSelectionChange(AUTO_MODEL_SELECTION); setShowProxyRuntimeModelMenu(false); }}
                                    className={`w-full rounded-xl px-2.5 py-2 text-left transition-colors ${ proxyRuntimeModelSelection === AUTO_MODEL_SELECTION ? 'eterx-proxy-model-item-active bg-white/[0.08] text-white' : 'text-white/60 hover:bg-white/[0.05] hover:text-white' }`}
                                  >
                                    <span className="block text-[12px] font-medium">Auto</span>
                                    <span className="block text-[9.5px] text-white/30">Use the settings model priority</span>
                                  </button>
                                  {proxyModelEntries.map(entry => {
                                    const optionKey = modelEntryKey(entry.provider, entry.modelId);
                                    const selected = proxyRuntimeModelSelection === optionKey;
                                    return (
                                      <button
                                        key={`runtime-proxy-${ optionKey }`}
                                        type="button"
                                        onClick={() => { handleProxyRuntimeModelSelectionChange(optionKey); setShowProxyRuntimeModelMenu(false); }}
                                        className={`w-full rounded-xl px-2.5 py-2 text-left transition-colors ${ selected ? 'eterx-proxy-model-item-active bg-white/[0.08] text-white' : 'text-white/60 hover:bg-white/[0.05] hover:text-white' }`}
                                      >
                                        <span className="block truncate text-[12px] font-medium">{entry.modelId}</span>
                                        <span className="block text-[9.5px] text-white/30">{entry.provider}</span>
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>

                            <div className="h-[1px] w-full bg-white/[0.06] eterx-proxy-group-divider" />

                            {/* 3. Intervention Row */}
                            <div className="group relative">
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setShowProxyRuntimeModelMenu(false);
                                  setShowProxyInterventionMenu(value => !value);
                                }}
                                className="eterx-proxy-group-item w-full flex items-center justify-between gap-2 px-3 py-2.5 text-[12px] font-medium text-white/85 hover:bg-white/[0.06] cursor-pointer transition-colors"
                              >
                                <span className="text-white/50 shrink-0 text-[12px]">Intervention</span>
                                <div className="flex shrink-0 items-center gap-1.5">
                                  <span className="capitalize text-[12px] text-white/90 font-semibold">
                                    {proxyIntervention}
                                  </span>
                                  <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-white/35 group-hover:text-white/70 transition-transform duration-200 ${ showProxyInterventionMenu ? 'rotate-90' : '' }`} />
                                </div>
                              </button>

                              {/* Pop-out Dropdown to the Left */}
                              <div className={`absolute right-full top-1/2 -translate-y-1/2 z-[110] w-[158px] pr-2 transition-all duration-200 ${ showProxyInterventionMenu ? 'pointer-events-auto opacity-100 translate-x-0' : 'pointer-events-none opacity-0 translate-x-2' }`}>
                                <div className="eterx-proxy-popout rounded-2xl border border-white/[0.08] bg-[#252525] shadow-2xl p-1.5 flex flex-col gap-1 w-full">
                                  {(['minimal', 'normal', 'high'] as const).map((level) => {
                                    const isSelected = proxyIntervention === level;
                                    const subtitle = level === 'minimal' ? 'Observe more' : level === 'normal' ? 'Balanced' : 'Best Efforts';
                                    return (
                                      <button
                                        key={level}
                                        type="button"
                                        onClick={() => {
                                          handleProxyInterventionChange(level);
                                          setShowProxyInterventionMenu(false);
                                        }}
                                        className={`eterx-proxy-popout-item w-full flex flex-col items-start rounded-xl px-2.5 py-1 text-left transition-colors relative pr-6 ${ isSelected
                                            ? 'eterx-proxy-popout-item-active bg-white/[0.08] text-white'
                                            : 'text-white/50 hover:bg-white/[0.04] hover:text-white/85'
                                          }`}
                                      >
                                        <span className="text-[12px] font-medium capitalize">{level}</span>
                                        <span className="text-[9.5px] text-white/30 font-normal leading-normal">{subtitle}</span>
                                        {isSelected && (
                                          <span className="absolute right-2 top-1/2 -translate-y-1/2">
                                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                                          </span>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>

                            <div className="h-[1px] w-full bg-white/[0.06] eterx-proxy-group-divider" />

                            {/* 4. Talk with proxy Button (Bottom Item) */}
                            <button
                              type="button"
                              onClick={() => {
                                setShowProxyRuntimeModelMenu(false);
                                setShowProxyInterventionMenu(false);
                                setShowProxyChat(!showProxyChat);
                              }}
                              className={`eterx-proxy-group-item w-full flex items-center justify-center gap-1.5 px-3 py-2.5 text-[12px] font-medium transition-colors rounded-b-2xl shrink-0 ${ showProxyChat
                                  ? 'bg-white/[0.08] text-white'
                                  : 'text-white/80 hover:bg-white/[0.06] hover:text-white'
                                }`}
                            >
                              <MessageSquare className="h-3.5 w-3.5 text-white/60" />
                              <span>Talk with Proxy</span>
                            </button>
                          </div>
                        </div>

                        {/* Floating Chat Container */}
                        {showProxyChat && (() => {
                          const modelOptions = proxyModelEntries.map(entry => {
                            const mode = MODEL_PROVIDER_MODE[entry.provider];
                            return {
                              optionKey: modelEntryKey(entry.provider, entry.modelId),
                              id: mode,
                              provider: entry.provider,
                              label: entry.modelId,
                              compactLabel: entry.modelId,
                              modelName: entry.modelId,
                              modelId: entry.modelId,
                              isAuto: false,
                            };
                          });
                          const autoModelOption = {
                            optionKey: AUTO_MODEL_SELECTION,
                            id: 'auto',
                            provider: 'auto',
                            label: 'Auto',
                            compactLabel: 'Auto',
                            modelName: 'Auto',
                            isAuto: true,
                          };
                          const modelProviderLabels: Record<string, string> = {
                            gemini: 'Google Gemini',
                            mistral: 'Mistral',
                            openai: 'OpenAI',
                            openrouter: 'OpenRouter',
                            groq: 'Groq',
                            anthropic: 'Anthropic',
                          };
                          const allModelOptions = [autoModelOption, ...modelOptions];
                          const selectedModel = allModelOptions.find(option => option.optionKey === proxyModelSelection) || autoModelOption;
                          const proxyRunStatus = String(proxyManagerContext?.run?.status || 'idle');
                          const proxySupervisorStatus = String(proxyManagerContext?.proxy?.status || (proxyEnabled ? 'ready' : 'paused'));
                          const proxyPendingTasks = Number(proxyManagerContext?.proxyControl?.pendingTaskCount || 0);
                          const proxyCapabilityCount = Number(proxyManagerContext?.capabilities?.total || 0);
                          const sideCapabilities = Array.isArray(proxyManagerContext?.sideAgent?.capabilities)
                            ? proxyManagerContext.sideAgent.capabilities
                            : [];
                          const operationLabels: Record<string, string> = {
                            brief_proxy: 'Supervisor briefed',
                            guide_adaptively: 'Guidance staged',
                            watch_condition: 'Condition watched',
                            before_completion: 'Completion gate added',
                            queue_after_current: 'Task queued',
                            start_main: 'Main awakened',
                            schedule_workflow: 'Workflow scheduled',
                            replace_queued_task: 'Queue updated',
                            interrupt_main: 'Main redirected',
                            stop_main: 'Stop requested',
                          };

                          return (
                            <div
                              ref={proxyChatWindowRef}
                              className="eterx-proxy-chat-window pointer-events-auto fixed right-6 bottom-20 z-[9990] max-h-[calc(100vh-32px)] max-w-[calc(100vw-24px)] overflow-hidden rounded-[24px] border border-white/[0.12] bg-[#171717] shadow-[0_20px_60px_rgba(0,0,0,0.52),inset_0_1px_0_rgba(255,255,255,0.035)] flex flex-col transition-[box-shadow] duration-200"
                              style={{
                                width: proxyChatWindow.width,
                                height: proxyChatWindow.height,
                                transform: `translate(${ proxyChatWindow.x }px, ${ proxyChatWindow.y }px)`,
                              }}
                            >
                              {/* Header */}
                              <div
                                onPointerDown={(event) => startProxyWindowInteraction('drag', event)}
                                className="eterx-proxy-chat-header flex min-h-[56px] cursor-grab items-center justify-between rounded-t-[24px] border-b border-white/[0.06] bg-[#191919] px-5 py-3 shrink-0 active:cursor-grabbing select-none touch-none"
                              >
                                <div className="flex min-w-0 items-center gap-2.5">
                                  <div className="truncate text-[13.5px] font-semibold tracking-[-0.01em] text-white/90">Talk with Proxy</div>
                                </div>
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={toggleProxyExpanded}
                                    className="h-7 w-7 rounded-full flex items-center justify-center hover:bg-white/[0.07] text-white/35 hover:text-white/80 transition-colors"
                                    title={isProxyExpanded ? 'Compact view' : 'Expand workspace'}
                                  >
                                    {isProxyExpanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                                  </button>
                                  <button
                                    type="button"
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={() => setShowProxyChat(false)}
                                    className="h-7 w-7 rounded-full flex items-center justify-center hover:bg-white/[0.07] text-white/35 hover:text-white/80 transition-colors"
                                  >
                                    <Minus className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </div>

                              {isProxyExpanded && (
                                <div className="eterx-proxy-context-panel shrink-0 border-b border-white/[0.06] bg-white/[0.018] px-4 py-3">
                                  <div className="flex items-center gap-3 text-[10px] text-white/38">
                                    <span><span className="text-white/66">Main</span> · {proxyRunStatus}</span>
                                    <span className="h-3 w-px bg-white/[0.07]" />
                                    <span><span className="text-white/66">Supervisor</span> · {proxySupervisorStatus.replace(/_/g, ' ')}</span>
                                    <span className="h-3 w-px bg-white/[0.07]" />
                                    <span><span className="text-white/66">Queue</span> · {proxyPendingTasks}</span>
                                  </div>
                                  <div className="mt-2 truncate text-[9.5px] leading-4 text-white/28">
                                    {sideCapabilities.join(' · ')}
                                    {proxyCapabilityCount > 0 ? ` · Main: ${proxyCapabilityCount} tools` : ''}
                                  </div>
                                </div>
                              )}

                              {/* Message Feed */}
                              <div ref={proxyMessageFeedRef} className="eterx-proxy-message-feed relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 flex flex-col gap-3 eterx-scrollbar overscroll-contain bg-[#171717] [scrollbar-gutter:stable]">
                                {visibleProxyChatMessages.length === 0 ? (
                                  <div className="flex-1 flex flex-col items-center justify-center text-center p-4">
                                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.035]">
                                      <Sparkles className="h-4 w-4 text-white/38" />
                                    </div>
                                    <span className="mt-3 text-[14px] font-semibold text-white/70">Coordinate the work</span>
                                    <span className="mt-1 max-w-[250px] text-[10.5px] leading-4 text-white/30">
                                      Add a goal, correct the active run, schedule what comes next, or ask for a grounded status update.
                                    </span>
                                  </div>
                                ) : (
                                  visibleProxyChatMessages.map((msg, idx) => (
                                    <div
                                      key={msg.id || idx}
                                      className={`flex min-w-0 max-w-[92%] flex-col ${ msg.sender === 'user' ? 'self-end items-end' : 'self-start items-start'
                                        }`}
                                    >
                                      <div
                                        className={`eterx-proxy-message-bubble min-w-0 max-w-full [overflow-wrap:anywhere] text-[11.5px] leading-relaxed ${ msg.sender === 'user'
                                            ? 'rounded-xl border border-white/[0.08] bg-[#242424] px-3 py-2 text-white/90 shadow-[0_5px_18px_rgba(0,0,0,0.16)] whitespace-pre-wrap'
                                            : 'rounded-none border-0 bg-transparent px-0 py-0 text-white/78'
                                          }`}
                                      >
                                        {msg.sender === 'proxy' ? (
                                          <div className="min-w-0 max-w-full">
                                            {Array.isArray(msg.work) && msg.work.length > 0 && (
                                              <div className="mb-3 flex flex-col gap-1.5">
                                                {msg.work.map((item, workIndex) => {
                                                  const WorkIcon = item.tool.includes('search')
                                                    ? Search
                                                    : item.tool.includes('workspace') || item.tool.includes('parse_')
                                                      ? FileText
                                                      : Sparkles;
                                                  return (
                                                    <div key={`${item.tool}-${workIndex}`} className="flex min-w-0 items-center gap-2 text-[10.5px] text-white/38">
                                                      <WorkIcon className="h-3.5 w-3.5 shrink-0 text-white/28" />
                                                      <span className="truncate">{item.text}</span>
                                                    </div>
                                                  );
                                                })}
                                              </div>
                                            )}
                                            {msg.operation && msg.operation !== 'none' && (
                                              <div className="mb-2 flex items-center gap-2 text-[10.5px] text-white/42">
                                                <Check className="h-3.5 w-3.5 text-white/34" />
                                                <span className="font-medium text-white/52">{operationLabels[msg.operation] || msg.operation.replace(/_/g, ' ')}</span>
                                                {msg.delivery && msg.delivery !== 'none' && (
                                                  <span className="text-white/22">{msg.delivery}</span>
                                                )}
                                              </div>
                                            )}
                                            <div className="proxy-manager-markdown max-w-full min-w-0 break-words">
                                              <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={proxyManagerMarkdownComponents}>
                                                {formatProxyManagerMarkdown(msg.text)}
                                              </ReactMarkdown>
                                            </div>
                                          </div>
                                        ) : msg.text}
                                      </div>
                                      <span className="mt-1 px-1 text-[8.5px] text-white/20">
                                        {msg.time}
                                      </span>
                                    </div>
                                  ))
                                )}
                                {proxyLiveTurn?.chatId === activeChatId && (
                                  <div role="status" aria-live="polite" className="self-start flex max-w-[94%] flex-col gap-1.5 px-0 py-1">
                                    {proxyLiveTurn.events.map((event, eventIndex) => {
                                      const EventIcon = event.tool?.includes('search')
                                        ? Search
                                        : event.tool?.includes('workspace') || event.tool?.includes('parse_')
                                          ? FileText
                                          : event.phase === 'routing'
                                            ? ChevronRight
                                            : Sparkles;
                                      const isLast = eventIndex === proxyLiveTurn.events.length - 1;
                                      return (
                                        <div key={`${event.timestamp}-${eventIndex}`} className="flex min-w-0 items-start gap-2 text-[10.5px] leading-4 text-white/38">
                                          <EventIcon className="mt-[1px] h-3.5 w-3.5 shrink-0 text-white/28" />
                                          {isLast && proxyChatLoading
                                            ? <Shimmer>{event.text}</Shimmer>
                                            : <span className="break-words">{event.text}</span>}
                                        </div>
                                      );
                                    })}
                                    {proxyLiveTurn.events.length === 0 && (
                                      <div className="flex items-center gap-2 text-[10.5px] text-white/38">
                                        <Sparkles className="h-3.5 w-3.5 text-white/28" />
                                        <Shimmer>Connecting the side agent</Shimmer>
                                      </div>
                                    )}
                                  </div>
                                )}
                                {proxyChatLoading && proxyLiveTurn?.chatId !== activeChatId && (
                                  <div className="self-start flex items-center gap-2 px-0 py-1 text-[10.5px] text-white/42">
                                    <Sparkles className="h-3.5 w-3.5 text-white/28" />
                                    <Shimmer>Restoring live work</Shimmer>
                                  </div>
                                )}
                                <div ref={proxyMessagesEndRef} className="h-px shrink-0" />
                              </div>

                              {/* Redesigned Input Form matching the upload */}
                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  handleSendProxyMessage();
                                }}
                                className="eterx-proxy-composer border-t border-white/[0.045] bg-[#171717] p-3 pt-3 shrink-0 outline-none shadow-none"
                              >
                                <div className="eterx-proxy-input-wrapper relative rounded-2xl border border-white/[0.08] bg-[#262626] flex flex-col p-2 gap-1.5">
                                    {/* Interactive Top Height Resizer Drag Handle */}
                                    <div
                                      onPointerDown={startInputHeightResize}
                                      onDoubleClick={() => setCustomInputHeight(null)}
                                      title="Drag up/down to adjust height (Double click to reset)"
                                      className="group absolute -top-2 inset-x-0 mx-auto w-16 h-3 flex items-center justify-center cursor-ns-resize z-30 select-none touch-none"
                                    >
                                      <div className="w-9 h-1 rounded-full bg-white/20 group-hover:bg-white/60 group-active:bg-white/90 transition-colors shadow-sm" />
                                    </div>

                                    <input ref={proxyFileInputRef} type="file" multiple className="hidden" onChange={handleProxyFileSelect} />
                                    <input ref={proxyPinInputRef} type="file" multiple className="hidden" onChange={handleProxyPinSelect} />

                                    {(proxyAttachments.length > 0 || proxyPinnedItems.length > 0) && (
                                       <div className="flex items-center gap-2 px-1 pt-0.5 pb-1 overflow-x-auto overflow-y-hidden select-none whitespace-nowrap [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                                         {proxyPinnedItems.map((pin, idx) => (
                                           <div key={`proxy-pin-${idx}`} className="group relative inline-flex shrink-0 items-center gap-2 rounded-xl border border-white/[0.12] bg-[#222222]/90 p-1 pr-2.5 shadow-sm backdrop-blur-md select-none mt-1">
                                             <div className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-white/[0.08] border border-white/[0.06]">
                                               <img src="/icons/ui/pin.png" alt="Pin" className="h-3 w-3 object-contain eterx-popout-icon-img" />
                                             </div>
                                             <div className="flex flex-col min-w-0 pr-0.5">
                                               <span className="max-w-[105px] truncate text-[10.5px] font-medium leading-tight text-white/90">{pin.name}</span>
                                             </div>
                                             <button
                                               type="button"
                                               onClick={() => setProxyPinnedItems(prev => prev.filter((_, i) => i !== idx))}
                                               className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white text-black shadow-md transition-transform hover:scale-110 active:scale-95 z-10"
                                             >
                                               <X className="h-2 w-2 stroke-[3]" />
                                             </button>
                                           </div>
                                         ))}

                                         {proxyAttachments.map((att, idx) => {
                                           const fileName = att.name || att.file?.name || 'File';
                                           const ext = fileName.includes('.') ? fileName.split('.').pop()?.toUpperCase() : 'FILE';
                                           return (
                                             <div key={`proxy-att-${att.id || idx}`} className="group relative inline-flex shrink-0 items-center gap-2 rounded-xl border border-white/[0.12] bg-[#222222]/90 p-1 pr-2.5 shadow-sm backdrop-blur-md select-none mt-1">
                                               {att.preview ? (
                                                 <img src={att.preview} alt={fileName} className="h-6.5 w-6.5 rounded-lg object-cover shrink-0 border border-white/10" />
                                               ) : (
                                                 <div className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-white/[0.08] border border-white/[0.06] text-white/70">
                                                   <FileText className="h-3 w-3" />
                                                 </div>
                                               )}
                                               <div className="flex flex-col min-w-0 pr-0.5">
                                                 <span className="max-w-[105px] truncate text-[10.5px] font-medium leading-tight text-white/90">{fileName}</span>
                                                 <span className="text-[8.5px] font-semibold uppercase tracking-wider text-white/40 mt-0.5">{ext}</span>
                                               </div>
                                               <button
                                                 type="button"
                                                 onClick={() => setProxyAttachments(prev => prev.filter((_, i) => i !== idx))}
                                                 className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white text-black shadow-md transition-transform hover:scale-110 active:scale-95 z-10"
                                               >
                                                 <X className="h-2 w-2 stroke-[3]" />
                                               </button>
                                             </div>
                                           );
                                         })}
                                       </div>
                                     )}
                                  <textarea
                                    value={proxyChatInput}
                                    onChange={(e) => {
                                      setProxyChatInput(e.target.value);
                                      if (!customInputHeight) {
                                        e.target.style.height = 'auto';
                                        e.target.style.height = `${Math.min(e.target.scrollHeight, 240)}px`;
                                      }
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' && !e.shiftKey) {
                                        e.preventDefault();
                                        handleSendProxyMessage();
                                      }
                                    }}
                                    placeholder="Do anything"
                                    style={customInputHeight ? { height: `${customInputHeight}px` } : undefined}
                                    className="eterx-proxy-textarea w-full bg-transparent text-white text-[12.5px] leading-relaxed outline-none placeholder-white/30 resize-none px-1 py-1 min-h-[32px] max-h-[360px] eterx-scrollbar"
                                  />
                                  <div className="flex items-center justify-between mt-0.5 px-0.5 min-w-0">
                                    <div ref={proxyAttachMenuRef} className="relative flex items-center shrink-0">
                                      <button
                                        type="button"
                                        onClick={() => setShowProxyAttachMenu(prev => !prev)}
                                        className={`h-7 w-7 rounded-full flex-none aspect-square shrink-0 flex items-center justify-center text-white/40 hover:text-white/80 hover:bg-white/[0.06] active:bg-white/[0.12] transition-colors focus:outline-none ${ showProxyAttachMenu ? 'bg-white/[0.10] text-white' : '' }`}
                                      >
                                        <Plus className={`h-4 w-4 transition-transform duration-200 ${ showProxyAttachMenu ? 'rotate-45 text-white' : '' }`} />
                                      </button>

                                      {/* + Dropdown Menu */}
                                      {showProxyAttachMenu && (
                                        <div className="eterx-proxy-attach-menu absolute bottom-[calc(100%+8px)] left-0 z-[130] flex w-[136px] flex-col gap-0.5 rounded-xl border border-white/[0.10] bg-[#1E1E1E]/95 p-1 text-[#F4F1EA] shadow-[0_12px_36px_rgba(0,0,0,0.52)] backdrop-blur-2xl animate-in fade-in zoom-in-95 duration-150 select-none">
                                          <button
                                            type="button"
                                            onClick={() => { setShowProxyAttachMenu(false); proxyPinInputRef.current?.click(); }}
                                            className="group flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[12px] font-medium text-white/85 transition-all hover:bg-white/[0.08] hover:text-white active:scale-[0.98]"
                                          >
                                            <img src="/icons/ui/pin.png" alt="Pin" className="h-4 w-4 shrink-0 object-contain eterx-popout-icon-img" />
                                            <span>Pin</span>
                                          </button>

                                          <button
                                            type="button"
                                            onClick={() => { setShowProxyAttachMenu(false); handleProxyTakeScreenshot(); }}
                                            className="group flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[12px] font-medium text-white/85 transition-all hover:bg-white/[0.08] hover:text-white active:scale-[0.98]"
                                          >
                                            <img src="/icons/ui/screenshot.png" alt="Screenshot" className="h-4 w-4 shrink-0 object-contain eterx-popout-icon-img" />
                                            <span>Screenshot</span>
                                          </button>

                                          <button
                                            type="button"
                                            onClick={() => { setShowProxyAttachMenu(false); proxyFileInputRef.current?.click(); }}
                                            className="group flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[12px] font-medium text-white/85 transition-all hover:bg-white/[0.08] hover:text-white active:scale-[0.98]"
                                          >
                                            <img src="/icons/ui/attach.png" alt="Attach" className="h-4 w-4 shrink-0 object-contain eterx-popout-icon-img" />
                                            <span>Attach</span>
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-1.5 min-w-0 shrink-0">
                                      {/* Model selector — matches the main chat composer */}
                                      <div ref={proxyModelMenuRef} className="eterx-model-selector relative min-w-0">
                                        <div
                                          onClick={() => setShowProxyModelMenu(!showProxyModelMenu)}
                                          className={`eterx-model-button mr-0 flex h-[32px] min-w-0 max-w-[110px] items-center justify-between gap-1 rounded-full border border-transparent bg-transparent px-2 text-[#F4F4F4] transition-colors hover:bg-white/[0.06] hover:text-white active:bg-white/[0.10] group cursor-pointer ${ showProxyModelMenu ? '!bg-white/[0.10] !text-white' : '' }`}
                                        >
                                          <span className="eterx-selector-label min-w-0 truncate text-[12px] font-medium tracking-normal text-white/60">
                                            {selectedModel.label}
                                          </span>
                                          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[#F0F0F0] transition-all duration-150 group-hover:text-white">
                                            <ChevronDown className={`eterx-selector-chevron h-3.5 w-3.5 text-[#F0F0F0] transition-all duration-200 group-hover:text-white ${ showProxyModelMenu ? 'rotate-180' : 'group-hover:translate-y-px' }`} strokeWidth={2.1} />
                                          </span>
                                        </div>

                                        {/* Dropdown Menu */}
                                        {showProxyModelMenu && (
                                          <div className="eterx-composer-popout eterx-scrollbar absolute bottom-[calc(100%+8px)] right-0 z-[130] flex max-h-[184px] w-[232px] max-w-[calc(100vw-24px)] flex-col overflow-y-auto rounded-xl border border-white/[0.08] bg-[#1E1E1E]/95 p-1 text-[#F4F1EA] shadow-[0_12px_36px_rgba(0,0,0,0.5)] backdrop-blur-xl">
                                            {allModelOptions.map((option) => {
                                              const isCurrent = option.optionKey === selectedModel.optionKey;
                                              return (
                                                <button
                                                  key={option.optionKey}
                                                  type="button"
                                                  onClick={() => {
                                                    handleProxyModelSelectionChange(option.optionKey);
                                                    setShowProxyModelMenu(false);
                                                  }}
                                                  className={`group flex min-h-[36px] w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors ${ isCurrent
                                                      ? 'eterx-proxy-model-item-active bg-white/[0.08] text-[#F4F1EA] font-normal shadow-sm'
                                                      : 'text-[#D0D0D0] hover:bg-white/[0.05] active:bg-white/[0.12]'
                                                    }`}
                                                  aria-pressed={isCurrent}
                                                >
                                                  <span className="flex h-4 w-4 shrink-0 items-center justify-center text-white/95">
                                                    {isCurrent && <Check className="h-3.5 w-3.5" strokeWidth={2.05} />}
                                                  </span>
                                                  <span className="flex min-w-0 flex-1 flex-col">
                                                    <span className="truncate text-[12px] leading-4">{option.label}</span>
                                                    <span className="truncate text-[10px] leading-3 text-[#A3A19E]">
                                                      {option.isAuto ? 'Use the Settings model priority list' : modelProviderLabels[option.provider] || option.provider}
                                                    </span>
                                                  </span>
                                                </button>
                                              );
                                            })}
                                            {allModelOptions.length === 1 && (
                                              <div className="px-2 pb-2 pt-1 text-[10.5px] leading-4 text-[#A3A19E]">
                                                Add models in Settings to make exact choices available here.
                                              </div>
                                            )}
                                          </div>
                                        )}
                                      </div>

                                      {/* Speech (Mic) Icon */}
                                      <button
                                        type="button"
                                        className="h-7 w-7 rounded-full flex items-center justify-center text-white/40 hover:text-white/80 hover:bg-white/[0.06] active:bg-white/[0.12] transition-colors focus:outline-none"
                                      >
                                        <Mic className="h-4 w-4" />
                                      </button>
                                      {/* Send button */}
                                      <button
                                        type="submit"
                                        disabled={proxyChatLoading || (!proxyChatInput.trim() && proxyAttachments.length === 0 && proxyPinnedItems.length === 0) || !activeChatId}
                                        className="h-7 w-7 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10 text-white/80 flex items-center justify-center transition-colors focus:outline-none"
                                      >
                                        <ArrowUp className="h-4 w-4" />
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              </form>
                              <div
                                role="separator"
                                aria-label="Resize proxy chat"
                                onPointerDown={(event) => startProxyWindowInteraction('resize', event)}
                                className="absolute bottom-2 right-2 z-20 h-5 w-5 cursor-nwse-resize flex items-end justify-end opacity-40 transition-opacity hover:opacity-100 touch-none"
                                title="Resize proxy chat"
                              >
                                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-white/60">
                                  <path d="M2 10 C 6 10, 10 6, 10 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                </svg>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    )}

                    <ChatFeed
                      key={activeChatId || 'new-chat'}
                      chatId={activeChatId}
                      traceLogs={effectiveDisplayLogs}
                      isThinking={effectiveIsThinking}
                      messagesEndRef={messagesEndRef}
                      setSidebarOpen={setSidebarOpen}
                      sidebarOpen={sidebarOpen}
                      handleScroll={handleScroll}
                      showScrollBottom={showScrollBottom}
                      isCompressed={isRightPanelVisible}
                      onAnswerAskUser={handleAnswerAskUser}
                      onEditUserMessage={updateInputValue}
                      onOpenAgentTeam={handleOpenAgentTeam}
                      isSubAgentTab={!!activeSubAgentTab}
                      liveState={isLiveSessionActive ? liveState : 'idle'}
                    />

                    {!activeSubAgentTab && queuedFollowUps.some(message => message.chatId === activeChatId) && (
                      <div className={`eterx-chat-auxiliary-stack px-4 ${ isRightPanelVisible ? 'sm:px-4' : 'sm:px-12' } w-full max-w-[760px] mx-auto flex flex-col gap-2 pb-2`}>
                        <div className="text-xs text-neutral-500 font-medium px-1">Queued follow-ups</div>
                        {queuedFollowUps.filter(message => message.chatId === activeChatId).map(message => (
                          <div key={message.id} className="bg-[#242424] rounded-xl py-2.5 px-3.5 flex items-center gap-3 text-sm text-neutral-200 shadow-sm border border-white/[0.04]">
                            <span className="min-w-0 flex-1 truncate">{message.text || `${ message.attachments.length } attachment${ message.attachments.length === 1 ? '' : 's' }`}</span>
                            <button
                              type="button"
                              onClick={() => setQueuedFollowUps(previous => previous.filter(item => item.id !== message.id))}
                              className="shrink-0 text-[11px] text-neutral-500 hover:text-neutral-200 transition-colors"
                              aria-label="Remove queued follow-up"
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {activeSubAgentTab && (
                      <div className={`eterx-chat-auxiliary-stack px-4 ${ isRightPanelVisible ? 'sm:px-4' : 'sm:px-12' } w-full max-w-[760px] mx-auto pb-2`}>
                        <div className="flex min-h-[34px] items-center justify-between gap-3 rounded-[8px] border border-white/[0.07] bg-[#181818]/88 px-3 py-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
                          <span className="flex min-w-0 items-center gap-2">
                            <MessageSquare className="h-3.5 w-3.5 shrink-0 text-white/48" strokeWidth={2.1} />
                            <span className="min-w-0 truncate text-[12px] font-semibold text-white/82">{activeSubAgentInfo?.name || activeSubAgentTab}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            <span className={`h-1.5 w-1.5 rounded-full ${ effectiveIsThinking ? 'bg-emerald-300/80' : 'bg-white/28' }`} />
                            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/38">
                              {effectiveIsThinking ? <Shimmer>Working</Shimmer> : 'Ready'} - deferred
                            </span>
                          </span>
                        </div>
                      </div>
                    )}

                    {showScrollBottom && traceLogs.length > 0 && (
                      <div>
                        <button
                          type="button"
                          aria-label="Jump to latest message"
                          onClick={() => {
                            const container = document.getElementById('chat-container');
                            if (container) {
                              container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
                            } else if (messagesEndRef.current) {
                              messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
                            }
                          }}
                          className="eterx-chat-scroll-latest fixed bottom-[90px] right-14 z-[9999] flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-[#252525]/95 text-white/70 shadow-[0_8px_20px_rgba(0,0,0,0.35)] backdrop-blur-xl transition-all hover:bg-[#333333] hover:text-white hover:scale-105 active:scale-95 cursor-pointer"
                        >
                          <ChevronDown className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                    <ChatInput
                      inputValue={inputValue}
                      setInputValue={updateInputValue}
                      isThinking={effectiveIsThinking}
                      isRecording={isRecording}
                      handleSend={activeSubAgentTab ? handleSendSubAgentMessage : handleSend}
                      handleStop={handleStopSelectedFeed}
                      handleSteer={activeSubAgentTab ? handleSendSubAgentMessage : handleSteer}
                      toggleSpeech={toggleSpeech}
                      attachments={attachments}
                      setAttachments={updateAttachments}
                      greeting={greeting}
                      traceLogsLength={traceLogs.length}
                      isProcessingVoice={isProcessingVoice}
                      audioVolume={audioVolume}
                      cancelVoice={cancelVoice}
                      acceptVoice={acceptVoice}
                      agentMode={agentMode}
                      onModeChange={handleAgentModeChange}
                      thinkingLevel={thinkingLevel}
                      onThinkingLevelChange={setThinkingLevel}
                      pinnedItems={pinnedItems}
                      setPinnedItems={updatePinnedItems}
                      liveState={activeChatId === liveChatId ? liveState : 'idle'}
                      hasBackgroundLiveSession={hasBackgroundLiveSession}
                      liveError={liveError}
                      onLiveStart={() => {
                        if (hasBackgroundLiveSession && liveChatId) {
                          loadChat(liveChatId);
                          return;
                        }
                        startLiveSession();
                      }}
                      onLiveStop={stopLiveSession}
                      onLiveSendText={(text) => liveSessionRef.current?.sendText(text)}
                      liveOutputText={activeChatId === liveChatId ? liveOutputText : ''}
                      liveInputText={activeChatId === liveChatId ? liveInputText : ''}
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
                      buildingAgentId={buildingAgentId}
                      onOpenAgentBuilder={handleOpenAgentBuilder}
                      selectedAgent={selectedAgent}
                      selectedAgentName={activeSubAgentInfo?.name || activeSubAgentTab || selectedAgentName}
                      composerPlaceholder={activeSubAgentTab ? `Message ${ activeSubAgentInfo?.name || 'sub-agent' }` : undefined}
                      onAgentChange={handleAgentChange}
                      onOpenPet={openPetWidget}
                      workspacePath={activeWorkspacePath}
                      onWorkspacePathChange={handleWorkspacePathChange}
                      runLocation={activeRunLocation}
                      onRunLocationChange={handleRunLocationChange}
                      chatModelSelection={activeModelSelection}
                      onModelSelectionChange={handleModelSelectionChange}
                      contextUsage={composerContextUsage}
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
                    {traceLogs.length === 0 && !isThinking && !isLiveSessionActive && (
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
                        className="eterx-agent-team-panel absolute top-[42px] right-4 z-50 w-[320px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-white/[0.09] bg-[#151515]/95 shadow-[0_24px_80px_rgba(0,0,0,0.55)] backdrop-blur-xl pointer-events-auto"
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
                        <div className="max-h-[420px] overflow-y-auto p-2 space-y-1.5 eterx-scrollbar">
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
                                    body: JSON.stringify({
                                      action,
                                      projectId: activeChatId,
                                      agentName: agent.name,
                                      agentId: agent.subAgentId,
                                    }),
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
                                <div key={agent.id || agent.name} className={`rounded-[12px] border border-white/[0.07] bg-[linear-gradient(180deg,rgba(255,255,255,0.055),rgba(255,255,255,0.026))] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] ${ isClosed ? 'opacity-45' : '' }`}>
                                  <div className="flex items-center gap-2.5">
                                    <SubAgentAvatar name={agent.name} status={status} size="md" />
                                    {/* Name + status */}
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-2">
                                        <span className="truncate text-[12px] font-semibold text-white/86">{agent.name}</span>
                                        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider ${ statusBadge.bg }`}>
                                          {isWorking ? <Shimmer>{statusBadge.label}</Shimmer> : statusBadge.label}
                                        </span>
                                      </div>
                                      <div className="mt-0.5 line-clamp-1 text-[10.5px] leading-4 text-white/40">
                                        {isWorking
                                          ? <Shimmer>{agent.currentAction || agent.task || 'Working'}</Shimmer>
                                          : agent.currentAction || agent.task || 'Waiting...'}
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

      <LiveMissionStrip
        mission={liveMission}
        visible={isLiveSessionActive}
        onOpenChat={(chatId) => {
          loadChat(chatId);
          setActiveView('chat');
        }}
      />

      <FloatingLiveWidget
        liveState={liveState}
        liveMicVolume={liveMicVolume}
        liveModelVolume={liveModelVolume}
        isMicMuted={liveMicMuted}
        isSpeakerMuted={liveSpeakerMuted}
        isCameraEnabled={liveCameraEnabled}
        isScreenSharing={liveScreenShareEnabled}
        liveActiveTool={liveActiveTool}
        liveActivityLabel={liveActivityLabel}
        onToggleMicMute={toggleLiveMicMute}
        onToggleSpeakerMute={toggleLiveSpeakerMute}
        onToggleCamera={toggleLiveCamera}
        onToggleScreenShare={toggleLiveScreenShare}
        onLiveStop={stopLiveSession}
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

