"use client";

import React, { startTransition, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Sidebar } from '../components/layout/sidebar';
import { CommandPalette } from '../components/layout/command-palette';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { transitionEterxTheme, broadcastEterxSettingsUpdate } from '../components/theme/theme-bridge';
import { ChatInput } from '../components/layout/chat-input';
import { ChatFeed } from '../components/chat/chat-feed';
import { FloatingLiveWidget } from '../components/chat/FloatingLiveWidget';
import {
  type LiveMissionEntry,
  type LiveMissionState,
} from '../components/chat/LiveMissionStrip';
// @ts-ignore — react-markdown's runtime types vary between desktop bundles.
import ReactMarkdown from 'react-markdown';
import { markdownComponents, normalizeMarkdownForRendering, remarkPlugins, rehypePlugins } from '../components/chat/markdown-renderer';
import { LocalFileLinkChip, decodeLocalFileHref } from '../components/chat/local-file-link';
import { Maximize2, Minimize2, AlertTriangle, CheckCircle2, ChevronDown, Sun, Moon, Clock3, Code2, GraduationCap, List, MessageSquare, Pencil, PenTool, SendHorizontal, SquarePen, Search, X, ArrowLeft, ListTodo, ChevronRight, Monitor, GitFork, Terminal, GitBranch, GitCommit, PlusSquare, Check, FileCode, FileText, MoreHorizontal, Sparkles, Pin, PinOff, Archive, Split, Calendar, ExternalLink, Copy, ChevronLeft, History, RefreshCw, Plus, Pause, Play, SlidersHorizontal, ShieldCheck, Minus, ArrowUp, Mic, Power, LifeBuoy, Bug, Mail, Paperclip, Camera } from 'lucide-react';
import { Tooltip } from '../components/ui/tooltip';
import { safeCopyTextToClipboard } from '../components/ui/copy-button';
import { getNativeFilePath } from '../lib/path-utils';
import { Shimmer } from '../components/ui/shimmer';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import { InteractiveGrid } from '../components/ui/interactive-grid';
import { LiveSessionState, type LiveSession } from '../lib/live/agent-live';
import { createLiveSession } from '../lib/live/provider-live';
import { DEFAULT_GEMINI_LIVE_MODEL, getDefaultLiveVoice, getLiveModelOptions, isLiveModelForProvider, normalizeLiveProvider } from '../lib/live/live-provider';
import {
  MAIN_AGENT_MODEL_OPTIONS,
  MAIN_AGENT_THINKING_LEVEL_STORAGE_KEY,
  normalizeModelThinkingCapabilities,
  normalizeMainAgentThinkingLevel,
  normalizeThinkingLevelForModel,
  type MainAgentMode,
  type MainAgentThinkingLevel,
  type ModelThinkingCapabilities,
} from '../lib/agent/model-routing';
import {
  AUTO_MODEL_SELECTION,
  API_KEY_PRESENCE_STORAGE_KEY,
  CHAT_CONTEXT_WINDOW_OVERRIDES_STORAGE_KEY,
  CHAT_MODEL_SELECTION_STORAGE_KEY,
  MODEL_API_KEY_PRESENCE_STORAGE_KEY,
  MODEL_CATALOG_STORAGE_KEY,
  MODEL_CONTEXT_WINDOWS_STORAGE_KEY,
  MODEL_OVERRIDE_STORAGE_KEY,
  MODEL_PROVIDER_MODE,
  MODEL_SELECTOR_STORAGE_KEY,
  MODEL_THINKING_CAPABILITIES_STORAGE_KEY,
  modelEntryKey,
  isEmbeddedModelLabel,
  isModelProvider,
  normalizeModelSelectorEntries,
  parseModelEntryKey,
  pickAutoModelEntry,
  type ModelSelectorEntry,
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
import { isPrivateReasoningTrace } from '../lib/agent/trace-visibility';
import { getToolDisplayLabel, normalizeToolTraceName, normalizeToolTraceText } from '../lib/agent/tool-trace';
import { canonicalizeThoughtStreamLogs, closeThoughtStreamsForBoundary, mergeThoughtStreamTrace } from '../lib/thought-stream-lifecycle';
import { agentIdentitiesOverlap, isTurnWorkActive, orderFeedTimelineLogs } from '../lib/chat-feed-lifecycle';
import { resolveChatSendTarget } from '../lib/chat-send-lifecycle';
import {
  GENERAL_AGENT_SELECTION,
  normalizeChatAgentSelection,
  shouldQueueForAgentSwitch,
  type ChatAgentSelection,
} from '../lib/chat-agent-selection';
import { mergeStreamingText } from '../lib/streaming-lifecycle';
import { FilePanelProvider, useGlobalFilePanel } from '../contexts/FilePanelContext';
import { isProjectFile, getFileIconPath } from '../lib/utils/file-icon-utils';
import { appStorage, appStorageReady, flushAppStorage, flushDurableState, registerDurableFlush, FOLDER_STORAGE_READY_EVENT } from '../lib/client-storage';
import { isLocalModelProvider } from '../lib/agent/provider-runtime';
import { WorkMenuSectionButton, WorkMenuEmptyState, WorkMenuStatusIndicator } from '../components/layout/WorkMenuHelpers';
import { FloatingPetMonitor, PetThinkingLabel, getLatestPetMonitorText } from '../components/chat/FloatingPetMonitor';
import { SubAgentIdentityIcon } from '../components/chat/agent-icons';
import {
  computeNextScheduledRun,
  normalizeScheduledTask,
  SCHEDULED_TASKS_STORAGE_KEY,
  SCHEDULED_TASKS_UPDATED_EVENT,
  type ScheduledTaskRecord,
  type ScheduledTaskRun,
} from '../lib/scheduled-tasks';
import { flushScheduledTaskWrites, persistScheduledTasks as persistScheduledTaskRecords } from '../lib/scheduled-task-sync';
import {
  buildSubAgentPinnedContext,
  DEFAULT_SUB_AGENT_RUNTIME_SETTINGS,
  normalizeSubAgentRuntimeSettings,
} from '../lib/agent/sub-agent-settings';
import { PollingConcurrencyGate } from '../lib/agent/polling-coordinator';

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

// Builder runs used to wrap the real prompt with routing metadata before it
// reached the registry. Older traces can still contain that envelope, so keep
// it out of both the transcript and the next model-history request.
const AGENT_BUILDER_INTERNAL_REQUEST_PATTERN = /^\[AGENT BUILDER REQUEST\]\s*\r?\nTarget agent ID:[^\r\n]*\r?\n\s*\r?\n\[USER REQUEST\]\s*\r?\n?([\s\S]*)$/i;

const WORK_NOTE_PHASE_BOUNDARY_TYPES = new Set([
  'command',
  'tool_call',
  'exploration',
  'file_edit',
  'browser',
  'communication',
  'progress',
  'ask_user',
  'steering_received',
  'sub_agent_spawn',
  'sub_agent_action',
  'sub_agent_complete',
  'sub_agent_error',
  'answer',
]);

const isOpenWorkNoteTrace = (log: any): boolean => {
  if (!log || log.type !== 'work_note' || log._streamingCancelled === true) return false;
  if (
    log.final === true ||
    log.done === true ||
    log.isStreaming === false ||
    log.streamState === 'closed' ||
    ['completed', 'complete', 'failed', 'error', 'stopped', 'cancelled', 'canceled', 'closed'].includes(String(log.status || '').toLowerCase())
  ) return false;
  return log.isStreaming === true ||
    log.isLiveTyping === true ||
    log.isDelta === true ||
    log.streamState === 'open' ||
    ['running', 'working', 'pending', 'streaming'].includes(String(log.status || '').toLowerCase());
};

const stableWorkNoteTraceIndex = (previous: any, incoming: any) =>
  previous !== undefined && previous !== null ? previous : incoming;

const getVisibleUserActionText = (log: any): string => {
  const text = String(log?.text || '');
  const match = log?.type === 'user_action'
    ? text.match(AGENT_BUILDER_INTERNAL_REQUEST_PATTERN)
    : null;
  return match ? String(match[1] || '').trim() : text;
};

const normalizeBuilderUserActionLogs = (logs: any[] = []): any[] => {
  const source = Array.isArray(logs) ? logs : [];
  const visibleRunIds = new Set(
    source
      .filter(log => log?.type === 'user_action' && !AGENT_BUILDER_INTERNAL_REQUEST_PATTERN.test(String(log.text || '')))
      .map(log => String(log.runId || log.turnId || '').trim())
      .filter(Boolean),
  );

  return source.reduce<any[]>((next, log) => {
    if (log?.type !== 'user_action') {
      next.push(log);
      return next;
    }

    const rawText = String(log.text || '');
    const visibleText = getVisibleUserActionText(log);
    const runId = String(log.runId || log.turnId || '').trim();
    const isInternalEnvelope = visibleText !== rawText;
    // If the optimistic human turn is present, discard only the older
    // server-side envelope. If it is the only boundary, preserve the turn but
    // replace its text with the actual request.
    if (isInternalEnvelope && runId && visibleRunIds.has(runId)) return next;
    next.push(isInternalEnvelope ? { ...log, text: visibleText } : log);
    return next;
  }, []);
};

const isInjectedProxyBoundary = (log: any) =>
  log?.type === 'user_action' &&
  (log.source === 'user_proxy' || log.source === 'proxy_manager') &&
  Boolean(log.steeringId || (Array.isArray(log.steeringIds) && log.steeringIds.length > 0));

const buildBoundedAgentHistory = (logs: any[]) => {
  const visibleLogs = normalizeBuilderUserActionLogs(logs);
  const newestFirst: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  const excludedProxyTurnIndexes = new Set<number>();
  let excludeCurrentTurn = false;
  visibleLogs.forEach((log, index) => {
    if (log?.type === 'user_action') excludeCurrentTurn = isInjectedProxyBoundary(log);
    if (excludeCurrentTurn && (log?.type === 'user_action' || log?.type === 'answer')) {
      excludedProxyTurnIndexes.add(index);
    }
  });
  let remainingChars = MAX_AGENT_HISTORY_TOTAL_CHARS;

  for (let index = visibleLogs.length - 1; index >= 0 && newestFirst.length < MAX_AGENT_HISTORY_MESSAGES && remainingChars > 0; index--) {
    const log = visibleLogs[index];
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
  status?: 'MOD' | 'ADD' | 'DEL';
  additions?: number;
  deletions?: number;
};



const SubAgentAvatar = React.memo(({
  name,
  status,
  size = 'sm',
  assetIndex,
}: {
  name?: string;
  status?: string;
  size?: 'xs' | 'sm' | 'md';
  assetIndex?: number;
}) => {
  const displayName = String(name || 'Agent').trim() || 'Agent';
  const sizePx = size === 'md' ? 28 : size === 'xs' ? 22 : 24;
  return <SubAgentIdentityIcon name={displayName} status={status} size={sizePx} assetIndex={assetIndex} title={displayName} />;
});

const TaskStatusGlyphMini = React.memo(({ status, active }: { status?: string; active?: boolean }) => {
  if (status === 'done') {
    return (
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-[#A9A9A9] text-[#1F1F1F] shadow-none">
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
  mimeType?: string;
  size?: number;
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
  admissionKey?: string;
  runId?: string;
  attachmentCount?: number;
  serverBacked?: boolean;
  runOptions?: QueuedRunOptions;
};

type QueuedRunOptions = {
  modelSelection: string;
  selectedAgent: SelectedAgentState;
  thinkingLevel: MainAgentThinkingLevel;
  pinnedItems: PinnedItem[];
};

const makeFollowUpAdmissionKey = (
  targetChatId: string,
  message: string,
  nextAttachments: ComposerAttachment[] = [],
  selectedAgent?: SelectedAgentState | null,
) => JSON.stringify([
  targetChatId,
  message.trim(),
  nextAttachments.map(attachment => String(
    attachment.id || attachment.name || attachment.file?.name || ''
  )),
  selectedAgent ? normalizeChatAgentSelection(selectedAgent).agentId : undefined,
  selectedAgent?.chatMode === true,
]);

const speechWordKey = (word: string) => word.toLocaleLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

const getSpeechWordOverlap = (existingWords: string[], incomingWords: string[]) => {
  const maximumOverlap = Math.min(existingWords.length, incomingWords.length, 24);
  for (let size = maximumOverlap; size > 0; size -= 1) {
    const existingTail = existingWords.slice(-size).map(speechWordKey);
    const incomingHead = incomingWords.slice(0, size).map(speechWordKey);
    if (existingTail.every((word, index) => word && word === incomingHead[index])) return size;
  }
  return 0;
};

const mergeSpeechText = (existingText: string, incomingText: string) => {
  const existing = String(existingText || '').trim();
  const incoming = String(incomingText || '').trim();
  if (!existing) return incoming;
  if (!incoming) return existing;

  const existingWords = existing.split(/\s+/);
  const incomingWords = incoming.split(/\s+/);
  const overlap = getSpeechWordOverlap(existingWords, incomingWords);

  return [...existingWords, ...incomingWords.slice(overlap)].join(' ');
};

const appendSpeechToDraft = (draftText: string, speechText: string) => {
  const draft = String(draftText || '');
  const speech = String(speechText || '').trim();
  if (!speech) return draft;
  if (!draft) return speech;
  const incomingWords = speech.split(/\s+/);
  const draftWords = draft.trim().split(/\s+/);
  const newSpeech = incomingWords.slice(getSpeechWordOverlap(draftWords, incomingWords)).join(' ');
  if (!newSpeech) return draft;
  if (/\s$/.test(draft)) return `${draft}${newSpeech}`;
  return `${draft} ${newSpeech}`;
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
          <div className="group pointer-events-auto relative flex min-h-[58px] w-full max-w-[520px] items-center gap-3 overflow-hidden rounded-[18px] border border-white/[0.12] bg-[#141414]/95 px-4 py-3 pr-12 text-[#F2F0EC] shadow-none backdrop-blur-2xl">
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
              className="absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.09] bg-white/[0.055] text-white/70 opacity-0 shadow-none transition-all duration-200 hover:bg-white/[0.11] hover:text-white focus:opacity-100 focus:outline-none group-hover:opacity-100"
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
  const mimeType = att.mimeType || att.file?.type || 'application/octet-stream';
  return {
    id: att.id,
    name: fileName,
    preview: att.preview,
    uploadStatus: att.uploadStatus,
    localPath: att.localPath,
    fileUri: undefined,
    mimeType,
    size: att.size || att.file?.size || 0,
    file: {
      name: att.file?.name || fileName,
      type: mimeType,
      size: att.size || att.file?.size || 0,
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
const CHAT_SYNC_CHANNEL = 'eterx-chats';
const API_KEY_STORAGE_KEY = API_KEY_PRESENCE_STORAGE_KEY;

const notifyDurableChatSync = (savedAt: number) => {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(CHAT_SYNC_CHANNEL);
    channel.postMessage({ type: 'chats-updated', savedAt });
    channel.close();
  } catch { }
};

const readStoredTerminalShell = (): string => {
  if (typeof window === 'undefined') return 'auto';
  try {
    const saved = appStorage.getItem(SETTINGS_STORAGE_KEY);
    const value = String(saved ? JSON.parse(saved)?.terminalShell || '' : '').trim().toLowerCase();
    return ['auto', 'powershell', 'cmd', 'git-bash', 'wsl', 'zsh', 'bash', 'fish', 'sh'].includes(value)
      ? value
      : 'auto';
  } catch {
    return 'auto';
  }
};

const readStoredBrowserAccess = (): boolean => {
  if (typeof window === 'undefined') return true;
  try {
    const saved = appStorage.getItem(SETTINGS_STORAGE_KEY);
    const settings = saved ? JSON.parse(saved) : {};
    return settings?.browserAccess !== false;
  } catch {
    return true;
  }
};

const readStoredComputerUse = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    const saved = appStorage.getItem(SETTINGS_STORAGE_KEY);
    const settings = saved ? JSON.parse(saved) : {};
    return settings?.computerUse === true;
  } catch {
    return false;
  }
};

const readStoredMainAgentMode = (): MainAgentMode | null => {
  if (typeof window === 'undefined') return null;
  try {
    const saved = appStorage.getItem(SETTINGS_STORAGE_KEY);
    const settings = saved ? JSON.parse(saved) : {};
    const mode = typeof settings?.agentMode === 'string' ? settings.agentMode.trim() : '';
    return MAIN_AGENT_MODEL_OPTIONS.some(option => option.id === mode) ? mode as MainAgentMode : null;
  } catch {
    return null;
  }
};

const readStoredSynapseGraphEnabled = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    const saved = appStorage.getItem(SETTINGS_STORAGE_KEY);
    const settings = saved ? JSON.parse(saved) : {};
    return settings?.synapseGraphEnabled === true;
  } catch {
    return false;
  }
};

const readStoredSelfImprovementEnabled = (): boolean => {
  if (typeof window === 'undefined') return true;
  try {
    const saved = appStorage.getItem(SETTINGS_STORAGE_KEY);
    const settings = saved ? JSON.parse(saved) : {};
    return settings?.selfImprovementEnabled !== false;
  } catch {
    return true;
  }
};

const readStoredSubAgentSettings = (): { enabled: boolean; maxSubAgents: number; maxRetries: number } => {
  if (typeof window === 'undefined') return DEFAULT_SUB_AGENT_RUNTIME_SETTINGS;
  try {
    const saved = appStorage.getItem(SETTINGS_STORAGE_KEY);
    return normalizeSubAgentRuntimeSettings(saved ? JSON.parse(saved) : {});
  } catch {
    return DEFAULT_SUB_AGENT_RUNTIME_SETTINGS;
  }
};

const readStringRecord = (storageKey: string): Record<string, string> => {
  if (typeof window === 'undefined') return {};
  try {
    const saved = appStorage.getItem(storageKey);
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

const readRuntimeModelApiKeys = (): Record<string, string> => readStringRecord(MODEL_API_KEY_PRESENCE_STORAGE_KEY);

const readRuntimeModelEntries = () => {
  if (typeof window === 'undefined') return [];
  try {
    const savedEntries = JSON.parse(appStorage.getItem(MODEL_SELECTOR_STORAGE_KEY) || '[]');
    const savedCatalog = JSON.parse(appStorage.getItem(MODEL_CATALOG_STORAGE_KEY) || '{}');
    return normalizeModelSelectorEntries(savedEntries, savedCatalog);
  } catch {
    return [];
  }
};

const readRuntimeChatModelSelection = () => {
  if (typeof window === 'undefined') return AUTO_MODEL_SELECTION;
  const selection = appStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) || AUTO_MODEL_SELECTION;
  const resolved = resolveRuntimeModelSelection(selection);
  if (resolved !== selection) appStorage.setItem(CHAT_MODEL_SELECTION_STORAGE_KEY, resolved);
  return resolved;
};

const readRuntimeModelThinkingCapability = (selection = readRuntimeChatModelSelection()): ModelThinkingCapabilities | null => {
  if (typeof window === 'undefined') return null;
  const entry = parseModelEntryKey(selection);
  if (!entry) return null;
  try {
    const raw = JSON.parse(appStorage.getItem(MODEL_THINKING_CAPABILITIES_STORAGE_KEY) || '{}');
    return normalizeModelThinkingCapabilities(raw?.[modelEntryKey(entry.provider, entry.modelId)]);
  } catch {
    return null;
  }
};

const readRuntimeModelOverrides = (): Record<string, string> => {
  if (typeof window === 'undefined') return {};
  const selection = readRuntimeChatModelSelection();
  const exactEntry = parseModelEntryKey(selection);
  if (exactEntry) return { [exactEntry.provider]: exactEntry.modelId };
  const autoEntry = pickAutoModelEntry(readRuntimeModelEntries(), readRuntimeBaseApiKeys(), readRuntimeModelApiKeys());
  if (autoEntry) return { [autoEntry.provider]: autoEntry.modelId };

  try {
    const saved = appStorage.getItem(MODEL_OVERRIDE_STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : {};
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : ''])
        .filter(([, value]) => Boolean(value) && !isEmbeddedModelLabel(value)),
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

type SelectedAgentState = ChatAgentSelection;

const readRuntimeUsableModelEntries = () => {
  const entries = readRuntimeModelEntries();
  const providerKeys = readRuntimeBaseApiKeys();
  const modelKeys = readRuntimeModelApiKeys();
  return entries.filter(entry => (
    isLocalModelProvider(entry.provider)
    || Boolean(providerKeys[entry.provider])
    || Boolean(modelKeys[modelEntryKey(entry.provider, entry.modelId)])
  ));
};

const resolveRuntimeModelSelection = (selection: unknown): string => {
  const requested = String(selection || '');
  const usableEntries = readRuntimeUsableModelEntries();
  const parsed = parseModelEntryKey(requested);
  if (parsed && usableEntries.some(entry =>
    modelEntryKey(entry.provider, entry.modelId) === requested
  )) return requested;
  return usableEntries[0]
    ? modelEntryKey(usableEntries[0].provider, usableEntries[0].modelId)
    : AUTO_MODEL_SELECTION;
};

const isDefaultChatTitle = (title?: string | null) => {
  const normalized = String(title || '').trim();
  return !normalized ||
    normalized.toLowerCase() === DEFAULT_CHAT_TITLE.toLowerCase() ||
    /^[*#\-\s]*(?:input\s*:\s*)?current\s+title$/i.test(normalized);
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
    <div className="eterx-markdown-table-wrap eterx-scrollbar my-3 w-full max-w-full overflow-x-auto rounded-xl border border-white/[0.10] bg-[#1E1E1E] shadow-none">
      <table className="eterx-markdown-table w-full min-w-full border-collapse text-left text-[12px]" {...props} />
    </div>
  ),
  thead: ({ ...props }: any) => <thead className="eterx-markdown-thead bg-white/[0.06] border-b border-white/10" {...props} />,
  th: ({ ...props }: any) => <th className="eterx-markdown-th border-b border-r border-white/[0.08] last:border-r-0 px-3 py-2 text-left font-bold text-white text-[12px] bg-white/[0.03]" {...props} />,
  td: ({ ...props }: any) => <td className="eterx-markdown-td border-b border-r border-white/[0.05] last:border-r-0 px-3 py-2 align-top text-white/85 text-[12px] leading-relaxed" {...props} />,
  tr: ({ ...props }: any) => <tr className="eterx-markdown-tr transition-colors hover:bg-white/[0.04] even:bg-white/[0.015]" {...props} />,
  a: ({ node, href, children, ...props }: any) => {
    const localPath = decodeLocalFileHref(href);
    if (localPath) return <LocalFileLinkChip filePath={localPath} compact />;
    return <a className="text-[#E2765A] font-medium underline-offset-2 hover:underline" target="_blank" rel="noopener noreferrer" href={href} {...props}>{children}</a>;
  },
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

type ProxyChatMessage = {
  id?: string;
  sender: 'user' | 'proxy';
  text: string;
  time: string;
  createdAt: number;
  optimistic?: boolean;
  delivery?: string;
  operation?: string;
  work?: Array<{ text: string; tool: string }>;
};

const normalizeProxyHistoryMessages = (items: any[]): ProxyChatMessage[] =>
  (Array.isArray(items) ? items : []).map((item: any, index) => {
    const createdAt = Number(item?.createdAt) || index + 1;
    return {
      id: String(item?.id || ''),
      sender: item?.role === 'user' ? 'user' : 'proxy',
      text: String(item?.text || ''),
      time: new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      createdAt,
      delivery: item?.delivery,
      operation: item?.operation,
      work: Array.isArray(item?.work) ? item.work : [],
    };
  });

const reconcileProxyChatMessages = (
  existing: ProxyChatMessage[],
  canonical: ProxyChatMessage[],
): ProxyChatMessage[] => {
  const canonicalIds = new Set(canonical.map(message => message.id).filter(Boolean));
  const pending = existing.filter(message => {
    if (message.id && canonicalIds.has(message.id)) return false;
    if (!message.optimistic) return false;
    return !canonical.some(serverMessage =>
      serverMessage.sender === message.sender &&
      serverMessage.text === message.text &&
      Math.abs(serverMessage.createdAt - message.createdAt) <= 120_000
    );
  });
  return [...canonical, ...pending]
    .map((message, index) => ({ message, index }))
    .sort((left, right) =>
      left.message.createdAt - right.message.createdAt || left.index - right.index
    )
    .map(entry => entry.message);
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
    const saved = appStorage.getItem(SETTINGS_STORAGE_KEY);
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
      const contextWindows = JSON.parse(appStorage.getItem(MODEL_CONTEXT_WINDOWS_STORAGE_KEY) || '{}');
      const discoveredMaximum = Number(contextWindows?.[modelEntryKey(activeModelEntry.provider, activeModelEntry.modelId)] || 0);
      const modelMaximum = Number.isFinite(discoveredMaximum) && discoveredMaximum >= 16_000
        ? Math.floor(discoveredMaximum)
        : resolveClientContextWindow(activeModelEntry.provider, activeModelEntry.modelId);
      let budgetSelection = String(settings.contextWindowSizeSelection || '258000');
      if (chatId) {
        try {
          const chatOverrides = JSON.parse(appStorage.getItem(CHAT_CONTEXT_WINDOW_OVERRIDES_STORAGE_KEY) || '{}');
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
    log => {
      const owners = [log?.chatId, log?.ownerChatId]
        .map(value => String(value || '').trim())
        .filter(Boolean);
      return owners.length === 0 || owners.includes(chat.id);
    }
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

const LIVE_POLL_STATUSES = new Set(['idle', 'running', 'completed', 'failed', 'stopped']);

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

  // Keep the first render identical on the server and client. Browser-stored
  // model preferences are applied by the settings effect after hydration.
  const [activeModelSelection, setActiveModelSelection] = useState<string>(AUTO_MODEL_SELECTION);
  const composerRuntimeSelectionRef = useRef({
    modelSelection: activeModelSelection,
    // Keep the complete composer selection stable during SSR hydration. The
    // saved agent, mode, and model are applied by the browser-only settings
    // effect after the first render.
    selectedAgent: { agentId: null, agentName: 'General', chatMode: false } as SelectedAgentState,
    agentMode: 'think' as MainAgentMode,
    thinkingLevel: 'low' as MainAgentThinkingLevel,
  });
  const [proxyModelEntries, setProxyModelEntries] = useState(() => readRuntimeUsableModelEntries());
  const [contextSettingsRevision, setContextSettingsRevision] = useState(0);
  const [proxyModelSelection, setProxyModelSelection] = useState<string>(AUTO_MODEL_SELECTION);
  const [proxyRuntimeModelSelection, setProxyRuntimeModelSelection] = useState<string>(AUTO_MODEL_SELECTION);
  const [showProxyAttachMenu, setShowProxyAttachMenu] = useState(false);
  const [copiedProxyMsgId, setCopiedProxyMsgId] = useState<string | null>(null);
  const proxyMessageFeedRef = useRef<HTMLDivElement | null>(null);

  const [composerStates, setComposerStates] = useState<Record<string, ChatComposerState>>(() => {
    if (typeof window !== 'undefined') {
      try {
        return JSON.parse(appStorage.getItem('eterx_chat_composer_states') || '{}');
      } catch {
        return {};
      }
    }
    return {};
  });
  const composerStatesRef = useRef(composerStates);
  composerStatesRef.current = composerStates;
  const activeComposerSurfaceRef = useRef('main');
  const composerStateKey = (chatId: string, surface: string) =>
    surface === 'main' ? chatId : `${chatId}::agent-composer::${encodeURIComponent(surface)}`;

  useEffect(() => {
    void appStorageReady.then(() => {
      try {
        const stored = JSON.parse(appStorage.getItem('eterx_chat_composer_states') || '{}');
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
        setComposerStates(current => ({ ...stored, ...current }));
      } catch { }
    });
  }, []);

  const updateComposerStateAtKey = useCallback((
    key: string,
    updater: (prev: ChatComposerState) => ChatComposerState,
  ) => {
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
      // Navigation can happen before React commits this update. Keep the
      // imperative snapshot current so the next chat load never reads an old
      // draft or writes this update into the newly selected chat.
      composerStatesRef.current = nextStates;
      try { appStorage.setItem('eterx_chat_composer_states', JSON.stringify(nextStates)); } catch { }
      return nextStates;
    });
  }, []);

  const updateComposerState = useCallback((updater: (prev: ChatComposerState) => ChatComposerState) => {
    const chatKey = activeChatIdRef.current || 'new_chat';
    const key = composerStateKey(chatKey, activeComposerSurfaceRef.current);
    updateComposerStateAtKey(key, updater);
  }, [updateComposerStateAtKey]);

  const clearDraftComposerState = useCallback((targetChatId?: string | null) => {
    const visibleComposerKey = activeChatIdRef.current || 'new_chat';
    const targetChatKey = targetChatId || visibleComposerKey;
    const targetSurface = targetChatKey === visibleComposerKey ? activeComposerSurfaceRef.current : 'main';
    const targetComposerKey = composerStateKey(targetChatKey, targetSurface);
    // A background or queued send may target a different chat. Never erase
    // the draft currently visible in another chat while clearing that target.
    if (targetChatKey === visibleComposerKey) {
      setInputValue('');
      setAttachments([]);
    }
    setComposerStates(prevStates => {
      const nextStates = { ...prevStates };
      const existing = nextStates[targetComposerKey] || {
        inputValue: '',
        runLocation: 'local',
        selectedAgent: composerRuntimeSelectionRef.current.selectedAgent,
        agentMode: composerRuntimeSelectionRef.current.agentMode,
        thinkingLevel: composerRuntimeSelectionRef.current.thinkingLevel,
        attachments: [],
        pinnedItems: [],
        chatModelSelection: composerRuntimeSelectionRef.current.modelSelection,
      };
      nextStates[targetComposerKey] = {
        ...existing,
        inputValue: '',
        attachments: [],
      };
      composerStatesRef.current = nextStates;
      try { appStorage.setItem('eterx_chat_composer_states', JSON.stringify(nextStates)); } catch { }
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
    const requestedStoredSelection = String(state?.chatModelSelection || '');
    const storedConcreteSelection = parseModelEntryKey(requestedStoredSelection) &&
      readRuntimeUsableModelEntries().some(entry =>
        modelEntryKey(entry.provider, entry.modelId) === requestedStoredSelection
      )
      ? requestedStoredSelection
      : readRuntimeChatModelSelection();
    const target: ChatComposerState = {
      ...defaultState,
      ...(state || {}),
      selectedAgent: state?.selectedAgent || defaultState.selectedAgent,
      pinnedItems: state?.pinnedItems || defaultState.pinnedItems,
      attachments: state?.attachments || defaultState.attachments,
      chatModelSelection: storedConcreteSelection || defaultState.chatModelSelection,
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
    const chatKey = activeChatIdRef.current || 'new_chat';
    const key = composerStateKey(chatKey, activeComposerSurfaceRef.current);
    setInputValue(prev => {
      const resolved = typeof value === 'function' ? value(prev) : value;
      updateComposerStateAtKey(key, state => ({ ...state, inputValue: resolved }));
      return resolved;
    });
  }, [updateComposerStateAtKey]);

  const updateAttachments = useCallback((value: ComposerAttachment[] | ((prev: ComposerAttachment[]) => ComposerAttachment[])) => {
    const chatKey = activeChatIdRef.current || 'new_chat';
    const key = composerStateKey(chatKey, activeComposerSurfaceRef.current);
    setAttachments(prev => {
      const resolved = typeof value === 'function' ? value(prev) : value;
      updateComposerStateAtKey(key, state => ({ ...state, attachments: resolved }));
      return resolved;
    });
  }, [updateComposerStateAtKey]);

  const updatePinnedItems = useCallback((value: PinnedItem[] | ((prev: PinnedItem[]) => PinnedItem[])) => {
    const chatKey = activeChatIdRef.current || 'new_chat';
    const key = composerStateKey(chatKey, activeComposerSurfaceRef.current);
    setPinnedItems(prev => {
      const resolved = typeof value === 'function' ? value(prev) : value;
      updateComposerStateAtKey(key, state => ({ ...state, pinnedItems: resolved }));
      return resolved;
    });
  }, [updateComposerStateAtKey]);

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
    const option = proxyModelEntries.map(entry => ({
        optionKey: modelEntryKey(entry.provider, entry.modelId),
        provider: entry.provider,
        modelId: entry.modelId,
      })).find(candidate => candidate.optionKey === selection);
    if (!option) return;

    setProxyModelSelection(option.optionKey);
  }, [proxyModelEntries]);

  const handleProxyRuntimeModelSelectionChange = useCallback((selection: string) => {
    const valid = proxyModelEntries.some(entry => modelEntryKey(entry.provider, entry.modelId) === selection);
    if (!valid) return;
    setProxyRuntimeModelSelection(selection);
    try {
      appStorage.setItem(`eterx_proxy_runtime_model_${ activeChatIdRef.current || 'new_chat' }`, selection);
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
      setProxyModelEntries(readRuntimeUsableModelEntries());
      setContextSettingsRevision(revision => revision + 1);
    };
    window.addEventListener('focus', refreshProxyModels);
    window.addEventListener('eterx-settings-updated', refreshProxyModels);
    window.addEventListener(FOLDER_STORAGE_READY_EVENT, refreshProxyModels);
    window.addEventListener('eterx-folder-storage-updated', refreshProxyModels);
    void appStorageReady.then(refreshProxyModels);
    return () => {
      window.removeEventListener('focus', refreshProxyModels);
      window.removeEventListener('eterx-settings-updated', refreshProxyModels);
      window.removeEventListener(FOLDER_STORAGE_READY_EVENT, refreshProxyModels);
      window.removeEventListener('eterx-folder-storage-updated', refreshProxyModels);
    };
  }, []);
  const [selectedProjectSection, setSelectedProjectSection] = useState('new-tasks');
  const [pendingSteering, setPendingSteering] = useState<{ id: string, text: string, chatId: string, runId: string }[]>([]);
  const [queuedFollowUps, setQueuedFollowUps] = useState<QueuedFollowUp[]>([]);
  const queuedFollowUpDispatchRef = useRef<Set<string>>(new Set());
  const queuedFollowUpIdsRef = useRef<Map<string, string>>(new Map());
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
  const reconcileServerQueuedFollowUps = useCallback((chatId: string, items: unknown) => {
    if (!chatId || !Array.isArray(items)) return;
    setQueuedFollowUps(previous => {
      const previousForChat = new Map(
        previous.filter(item => item.chatId === chatId).map(item => [item.id, item]),
      );
      const remoteItems: QueuedFollowUp[] = items
        .filter((item: any) => item && typeof item.id === 'string')
        .map((item: any) => {
          const existing = previousForChat.get(item.id);
          return {
            id: String(item.id),
            chatId,
            text: String(item.text || ''),
            attachments: existing?.attachments || [],
            createdAt: Number(item.createdAt || existing?.createdAt || Date.now()),
            admissionKey: existing?.admissionKey,
            runId: typeof item.runId === 'string' ? item.runId : existing?.runId,
            attachmentCount: Number(item.attachmentCount || existing?.attachmentCount || existing?.attachments?.length || 0),
            serverBacked: true,
          };
        });
      const remoteIds = new Set(remoteItems.map(item => item.id));
      for (const removed of previousForChat.values()) {
        if (removed.serverBacked !== true || remoteIds.has(removed.id)) continue;
        if (removed.admissionKey) {
          queuedFollowUpAdmissionsRef.current.delete(removed.admissionKey);
          queuedFollowUpIdsRef.current.delete(removed.admissionKey);
        }
        queuedFollowUpDispatchRef.current.delete(removed.id);
      }
      const pendingLocal = previous.filter(item =>
        item.chatId === chatId && item.serverBacked === false && !remoteIds.has(item.id)
      );
      return [
        ...previous.filter(item => item.chatId !== chatId),
        ...remoteItems,
        ...pendingLocal,
      ];
    });
  }, []);

  useEffect(() => {
    const onlyModelSelection = proxyModelEntries.length === 1
      ? modelEntryKey(proxyModelEntries[0].provider, proxyModelEntries[0].modelId)
      : AUTO_MODEL_SELECTION;
    if (!proxyModelEntries.some(entry => modelEntryKey(entry.provider, entry.modelId) === proxyModelSelection)
      && proxyModelSelection !== onlyModelSelection) {
      setProxyModelSelection(onlyModelSelection);
    }
    if (!proxyModelEntries.some(entry => modelEntryKey(entry.provider, entry.modelId) === proxyRuntimeModelSelection)
      && proxyRuntimeModelSelection !== onlyModelSelection) {
      setProxyRuntimeModelSelection(onlyModelSelection);
    }
  }, [proxyModelEntries, proxyModelSelection, proxyRuntimeModelSelection]);
  const subAgentSendAdmissionsRef = useRef<Set<string>>(new Set());
  // Per-chat thinking state: Set of chatIds that have running agents
  const [runningChats, setRunningChats] = useState<Set<string>>(new Set());
  const [unreadChatIds, setUnreadChatIds] = useState<Set<string>>(new Set());
  // Terminal updates can arrive through both the primary poller and recovery
  // polling. Keep a bounded per-chat event ledger so the same completed/error
  // event cannot recreate an unread dot after it has already been seen.
  const handledUnreadEventsRef = useRef<Map<string, Set<string>>>(new Map());
  // Completion/failure notifications can be emitted by both the primary
  // poller and detached-poller recovery. Deduplicate them by chat, run, and
  // terminal status without suppressing a later run in the same chat.
  const handledTerminalAnnouncementsRef = useRef<Map<string, Set<string>>>(new Map());
  const [traceLogs, setTraceLogs] = useState<any[]>([]);
  const traceLogsLengthRef = useRef(0);
  useEffect(() => {
    traceLogsLengthRef.current = traceLogs.length;
  }, [traceLogs.length]);
  const [greeting, setGreeting] = useState("Initializing...");

  const [chats, setChats] = useState<ChatSession[]>([]);
  const sidebarChatsRef = useRef<ChatSession[]>([]);
  const nonBuilderChats = useMemo(() => {
    // Sidebar rows need metadata only. Keep this array referentially stable
    // during trace streaming so hundreds of chat rows do not rerender merely
    // because one agent appended a work event.
    const next = chats
      .filter(chat => !chat.id.startsWith('agent_builder_'))
      .map(chat => ({
        id: chat.id,
        title: chat.title,
        updatedAt: chat.updatedAt,
        traceLogs: [],
        isFavorite: chat.isFavorite,
        workspacePath: chat.workspacePath,
        runLocation: chat.runLocation,
      }));
    const previous = sidebarChatsRef.current;
    const unchanged = previous.length === next.length && next.every((chat, index) => {
      const prior = previous[index];
      return prior?.id === chat.id
        && prior.title === chat.title
        && prior.updatedAt === chat.updatedAt
        && prior.isFavorite === chat.isFavorite
        && prior.workspacePath === chat.workspacePath
        && prior.runLocation === chat.runLocation;
    });
    if (unchanged) return previous;
    sidebarChatsRef.current = next;
    return next;
  }, [chats]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [buildingAgentId, setBuildingAgentId] = useState<string | null>(null);
  const [buildingAgentName, setBuildingAgentName] = useState<string | null>(null);

  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [desktopPlatform, setDesktopPlatform] = useState<'windows' | 'macos' | 'linux' | 'web'>('web');
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
  const [gatewayScreen, setGatewayScreen] = useState(false);
  useEffect(() => {
    const onGatewayScreen = (event: Event) => setGatewayScreen(Boolean((event as CustomEvent).detail));
    window.addEventListener('eterx_gateway_screen', onGatewayScreen);
    return () => window.removeEventListener('eterx_gateway_screen', onGatewayScreen);
  }, []);
  const [agentMode, setAgentMode] = useState<MainAgentMode>(() => composerRuntimeSelectionRef.current.agentMode);
  const [thinkingLevel, setThinkingLevelState] = useState<MainAgentThinkingLevel>(() => composerRuntimeSelectionRef.current.thinkingLevel);
  const [selectedAgentState, setSelectedAgentState] = useState<SelectedAgentState>(() => composerRuntimeSelectionRef.current.selectedAgent);

  useEffect(() => {
    const platform = (window as any).electronAPI?.platform;
    if (platform === 'windows' || platform === 'macos' || platform === 'linux') {
      setDesktopPlatform(platform);
    }
  }, []);

  useEffect(() => {
    const restoreSelectedAgent = () => {
      try {
      // The global value is only a migration/default for the untouched New
      // chat surface. Once a real chat is open, its composer state is the sole
      // owner; late desktop-storage hydration must never replace it.
      if (activeChatIdRef.current) return;
      const savedDraft = composerStatesRef.current.new_chat;
      const hasSavedDraft = Boolean(savedDraft?.inputValue?.trim() || savedDraft?.attachments?.length);
      const restoredSelection = hasSavedDraft
        ? normalizeChatAgentSelection(savedDraft?.selectedAgent)
        : { ...GENERAL_AGENT_SELECTION };
      composerRuntimeSelectionRef.current.selectedAgent = restoredSelection;
      setSelectedAgentState(restoredSelection);
      } catch {}
    };
    restoreSelectedAgent();
    void appStorageReady.then(restoreSelectedAgent);
  }, []);
  const [proxyEnabled, setProxyEnabled] = useState(true);
  const [proxyIntervention, setProxyIntervention] = useState<'minimal' | 'normal' | 'high'>('normal');
  const [proxyDropdownOpen, setProxyDropdownOpen] = useState(false);
  const [showProxyChat, setShowProxyChat] = useState(false);
  const [proxyChatInput, setProxyChatInput] = useState('');
  const [showProxyModelMenu, setShowProxyModelMenu] = useState(false);
  const [showProxyRuntimeModelMenu, setShowProxyRuntimeModelMenu] = useState(false);
  const [showProxyInterventionMenu, setShowProxyInterventionMenu] = useState(false);
  const [proxyChatMessages, setProxyChatMessages] = useState<ProxyChatMessage[]>([]);
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
  const [settingsInitialTab, setSettingsInitialTab] = useState<string>('general');
  const [hasUnreadUpdate, setHasUnreadUpdate] = useState(false);
  const [activeTopbarMenu, setActiveTopbarMenu] = useState<'theme' | 'help' | null>(null);
  const topbarThemeOpen = activeTopbarMenu === 'theme';
  const topbarHelpOpen = activeTopbarMenu === 'help';
  const setTopbarThemeOpen = (v: boolean) => setActiveTopbarMenu(v ? 'theme' : null);
  const setTopbarHelpOpen = (v: boolean) => setActiveTopbarMenu(v ? 'help' : null);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [subAgentDockOpen, setSubAgentDockOpen] = useState(false);
  const [activeSubAgentTab, setActiveSubAgentTab] = useState<string | null>(null);
  const [subAgentOrder, setSubAgentOrder] = useState<string[]>([]);
  const [subAgentMessageTarget, setSubAgentMessageTarget] = useState<'selected' | 'team'>('selected');
  const [subAgentControlPending, setSubAgentControlPending] = useState<{ agentIdentity: string; action: 'pause' | 'resume' | 'close' } | null>(null);

  useEffect(() => {
    const nextSurface = activeSubAgentTab || 'main';
    if (activeComposerSurfaceRef.current === nextSurface) return;
    activeComposerSurfaceRef.current = nextSurface;
    const chatKey = activeChatIdRef.current || 'new_chat';
    const saved = composerStatesRef.current[composerStateKey(chatKey, nextSurface)];
    // Only the draft payload is run-specific. Model, mode, workspace, and
    // pinned project context remain properties of the parent chat.
    setInputValue(saved?.inputValue || '');
    setAttachments(saved?.attachments || []);
  }, [activeChatId, activeSubAgentTab]);
  const autoOpenedAgentDockChatsRef = useRef<Set<string>>(new Set());
  const [overflowDropdownOpen, setOverflowDropdownOpen] = useState(false);
  const [petWidgetOpen, setPetWidgetOpen] = useState(false);
  const [nativePetAvailable, setNativePetAvailable] = useState(false);
  const canUseMonitor = activeView === 'chat' && !!activeChatId;
  const closedSidebarDragStartRef = useRef<number | null>(null);
  const closedSidebarDragOpenedRef = useRef(false);
  const dragConstraintsRef = useRef<HTMLDivElement>(null);
  const selectedAgent = selectedAgentState.agentId;
  const selectedAgentName = selectedAgentState.agentName;
  const chatMode = selectedAgentState.chatMode === true;
  const runningChatsRef = useRef<Set<string>>(new Set());
  // Tracks chats that were explicitly stopped — prevents reconcile from re-adding them during the cleanup window
  const stoppingChatsRef = useRef<Set<string>>(new Set());
  const activeViewRef = useRef<ActiveView>('chat');
  const isNetworkPaused = false;

  // Poll Git repository status, active branch, and list of branches
  useEffect(() => {
    let active = true;
    let checkInFlight = false;
    const checkGitStatus = () => {
      if (checkInFlight) return;
      if (!activeWorkspacePath) {
        if (active) {
          setIsHeaderGitRepo(false);
          setCurrentBranch('main');
          setGitBranches([{ name: 'main', uncommitted: null }]);
        }
        return;
      }
      checkInFlight = true;
      const workspacePathAtCheck = activeWorkspacePath;

      // Get current active branch name
      fetch('/api/code/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'git branch --show-current', cwd: workspacePathAtCheck }),
      })
        .then(r => r.json())
        .then(data => {
          if (!active || activeWorkspacePath !== workspacePathAtCheck) return;
          if (data.stdout?.trim() && !data.stdout.includes('Sandbox') && !data.stdout.includes(' ') && !data.stdout.includes('error:')) {
            const activeBranch = data.stdout.trim();
            setCurrentBranch(activeBranch);
            setIsHeaderGitRepo(true);

            // Get all local branches
            return fetch('/api/code/execute', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ command: 'git branch', cwd: workspacePathAtCheck }),
            })
              .then(r2 => r2.json())
              .then(data2 => {
                if (!active || activeWorkspacePath !== workspacePathAtCheck) return;
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
          if (!active || activeWorkspacePath !== workspacePathAtCheck) return;
          setIsHeaderGitRepo(false);
          setCurrentBranch('main');
        })
        .finally(() => { checkInFlight = false; });
    };

    const checkGitStatusWhenVisible = () => {
      if (document.visibilityState !== 'visible') return;
      checkGitStatus();
    };
    checkGitStatusWhenVisible();
    // A repository status refresh starts two shell commands. Refresh promptly
    // when the app regains focus, with a quiet safety cadence while visible,
    // instead of waking the disk and server every four seconds forever.
    const interval = setInterval(checkGitStatusWhenVisible, 15000);
    window.addEventListener('focus', checkGitStatusWhenVisible);
    document.addEventListener('visibilitychange', checkGitStatusWhenVisible);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener('focus', checkGitStatusWhenVisible);
      document.removeEventListener('visibilitychange', checkGitStatusWhenVisible);
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
      setBuildingAgentName(null);
    }
    if (view !== 'chat') {
      setHeaderMenuOpen(false);
      setHeaderSearchOpen(false);
      setHeaderSearchQuery("");
    }
    setActiveViewState(view);
  }, []);
  const handleThemeChange = useCallback((newTheme: 'light' | 'dark') => {
    const saved = appStorage.getItem(SETTINGS_STORAGE_KEY);
    const settings = saved ? JSON.parse(saved) : {};
    settings.theme = newTheme;
    appStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    transitionEterxTheme(newTheme);
    broadcastEterxSettingsUpdate(settings);
    setTopbarThemeOpen(false);
  }, []);
  const openSettingsWindow = useCallback((tab?: any) => {
    if (tab && typeof tab === 'string') {
      setSettingsInitialTab(tab);
      if (tab === 'updates') {
        setHasUnreadUpdate(false);
        void (window as any)?.electronAPI?.markUpdateViewed?.();
      }
    } else {
      setSettingsInitialTab('general');
    }
    setIsSettingsOpen(true);
  }, [setSettingsInitialTab, setIsSettingsOpen]);

  useEffect(() => {
    const desktopApi = (window as any)?.electronAPI;
    if (typeof desktopApi?.getUpdateState !== 'function') return;
    const applyUpdateState = (state: any) => setHasUnreadUpdate(state?.updateAvailableUnread === true);
    const unsubscribe = typeof desktopApi.onUpdateState === 'function'
      ? desktopApi.onUpdateState(applyUpdateState)
      : undefined;
    desktopApi.getUpdateState().then(applyUpdateState).catch(() => {});
    return () => unsubscribe?.();
  }, []);

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

    const applyStoredSettings = (event?: Event) => {
      applyStoredAgentMode();
      const detail = (event as CustomEvent | undefined)?.detail;
      const requestedSelection = typeof detail?.chatModelSelection === 'string'
        ? detail.chatModelSelection
        : readRuntimeChatModelSelection();
      if (requestedSelection && requestedSelection !== composerRuntimeSelectionRef.current.modelSelection) {
        composerRuntimeSelectionRef.current.modelSelection = requestedSelection;
        setActiveModelSelection(requestedSelection);
        updateComposerState(state => ({ ...state, chatModelSelection: requestedSelection }));
      }
    };

    applyStoredSettings();
    window.addEventListener('focus', applyStoredSettings);
    window.addEventListener('eterx-settings-updated', applyStoredSettings as EventListener);
    window.addEventListener(FOLDER_STORAGE_READY_EVENT, applyStoredSettings as EventListener);
    window.addEventListener('eterx-folder-storage-updated', applyStoredSettings as EventListener);
    void appStorageReady.then(() => applyStoredSettings());

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(SETTINGS_CHANNEL);
      channel.onmessage = () => applyStoredSettings();
    } catch {
      channel = null;
    }

    return () => {
      window.removeEventListener('focus', applyStoredSettings);
      window.removeEventListener('eterx-settings-updated', applyStoredSettings as EventListener);
      window.removeEventListener(FOLDER_STORAGE_READY_EVENT, applyStoredSettings as EventListener);
      window.removeEventListener('eterx-folder-storage-updated', applyStoredSettings as EventListener);
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
  const liveMicMutedRef = useRef(false);
  const liveSpeakerMutedRef = useRef(false);
  const liveCameraTogglePendingRef = useRef(false);
  const liveScreenTogglePendingRef = useRef(false);
  const [liveCameraEnabled, setLiveCameraEnabled] = useState(false);
  const [liveScreenShareEnabled, setLiveScreenShareEnabled] = useState(false);
  const [liveActivityLabel, setLiveActivityLabel] = useState<string | null>(null);
  const liveMissionRef = useRef<LiveMissionState | null>(null);
  const liveActiveActivityIdRef = useRef<string | null>(null);
  const liveSessionRef = useRef<LiveSession | null>(null);
  const liveSessionTokenRef = useRef<string | null>(null);
  const liveBootstrapAbortRef = useRef<AbortController | null>(null);
  const liveCommitTurnRef = useRef<((userText: string, modelText: string, commands: any[]) => void) | null>(null);
  const liveProgressAnnouncementAtRef = useRef<Map<string, number>>(new Map());
  const liveMainDispatchRef = useRef(false);
  // A Live provider can repeat a turn-complete event during reconnects or
  // transcript handoff. Keep commits idempotent so one spoken turn becomes
  // one visible user/assistant pair.
  const committedLiveTurnIdsRef = useRef<Set<string>>(new Set());
  const recentLiveCommitSignaturesRef = useRef<Map<string, number>>(new Map());
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
    liveMissionRef.current = updater(liveMissionRef.current);
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
  // Chat-mode requests use their own API path and never register as agent
  // executions. This lets stop/reconcile logic leave the existing agent path
  // unchanged while still using the same composer lifecycle.
  const directChatRunsRef = useRef<Set<string>>(new Set());
  // Per-chat polling intervals: Map<chatId, intervalId>
  const pollingIntervalsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  // Timer presence is not liveness: a timer is removed while its request is
  // running, and visibility/recovery can replace timers at any time. Keep a
  // separate authoritative set so those races cannot detach a live poller.
  const activePollersRef = useRef<Set<string>>(new Set());
  // Bound renderer/server pressure when many chats are live at once. The
  // queue is fair, abortable, and intentionally shared by every chat.
  const pollingGateRef = useRef<PollingConcurrencyGate | null>(null);
  // Long-poll requests are dormant until a trace arrives, so a larger fair
  // pool keeps many simultaneous agents genuinely live without generating
  // the empty-request storm that the old rapid polling loop caused.
  if (!pollingGateRef.current) pollingGateRef.current = new PollingConcurrencyGate(32);
  // Abort the active HTTP poll when a run is replaced or stopped. Generation
  // checks still protect state, but cancellation prevents old requests from
  // occupying a connection slot while a successor catches up.
  const pollAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
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
    selectedModel?: ModelSelectorEntry;
  }>>(new Map());
  // Invalidates in-flight poll callbacks when a poller is restarted or stopped.
  const pollGenerationRef = useRef<Map<string, number>>(new Map());
  const backgroundChatUpdatesRef = useRef<Map<string, Array<{
    apply: (logs: any[]) => any[];
    touchUpdatedAt: boolean;
  }>>>(new Map());
  const backgroundUpdateTimerRef = useRef<number | null>(null);
  // CRITICAL: Ref for activeChatId so polling closures always see the latest value
  const activeChatIdRef = useRef<string | null>(null);
  const durableSnapshotTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingDurableSnapshotWrite = useRef(false);
  const lastChatSnapshotAtRef = useRef(0);
  const persistedChatSignaturesRef = useRef<Map<string, string>>(new Map());
  const chatObjectSignaturesRef = useRef<WeakMap<object, string>>(new WeakMap());
  const durableChatWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const chatSnapshotReadyRef = useRef(false);
  const pendingChatRestoreRevisionRef = useRef(0);
  const requestChatRestoreRef = useRef<(() => void) | null>(null);
  const pendingChatDeletionIdsRef = useRef<Set<string>>(new Set());
  const hydratedChatIdsRef = useRef<Set<string>>(new Set());
  const chatDetailRequestsRef = useRef<Map<string, Promise<void>>>(new Map());
  const chatsRef = useRef<ChatSession[]>([]);
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

  const markChatUnreadIfBackground = useCallback((chatId: string, eventKey: string) => {
    if (!chatId || !eventKey) return;

    const handledForChat = handledUnreadEventsRef.current.get(chatId) ?? new Set<string>();
    if (handledForChat.has(eventKey)) return;
    handledForChat.add(eventKey);
    if (handledForChat.size > 64) {
      const oldest = handledForChat.values().next().value;
      if (oldest) handledForChat.delete(oldest);
    }
    handledUnreadEventsRef.current.set(chatId, handledForChat);

    // Record before checking visibility: a duplicate poll response must remain
    // seen even if it arrives after the user navigates away.
    if (isChatCurrentlyVisible(chatId)) return;
    setUnreadChatIds(prev => {
      if (prev.has(chatId)) return prev;
      const next = new Set(prev);
      next.add(chatId);
      return next;
    });
  }, [isChatCurrentlyVisible]);

  const claimTerminalAnnouncement = useCallback((chatId: string, status: 'completed' | 'failed', runKey: string) => {
    if (!chatId || !status) return false;
    const handledForChat = handledTerminalAnnouncementsRef.current.get(chatId) ?? new Set<string>();
    const eventKey = `${ String(runKey || 'terminal').trim() || 'terminal' }:${ status }`;
    if (handledForChat.has(eventKey)) return false;
    handledForChat.add(eventKey);
    if (handledForChat.size > 64) {
      const oldest = handledForChat.values().next().value;
      if (oldest) handledForChat.delete(oldest);
    }
    handledTerminalAnnouncementsRef.current.set(chatId, handledForChat);
    return true;
  }, []);

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
    let checking = false;
    const checkTasks = async () => {
      if (checking) return;
      if (document.visibilityState === 'hidden' && appStorage.getItem('eterx_background_scheduled_tasks') === 'false') return;
      checking = true;
      try {
        const raw = appStorage.getItem(SCHEDULED_TASKS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        let tasks: ScheduledTaskRecord[] = Array.isArray(parsed) ? parsed.map(normalizeScheduledTask) : [];
        try {
          const pendingLocalWriteAt = Number(appStorage.getItem('eterx_scheduled_tasks_sync_pending') || 0);
          if (pendingLocalWriteAt && Date.now() - pendingLocalWriteAt < 15_000) throw new Error('Local schedule write is still syncing.');
          if (pendingLocalWriteAt) appStorage.removeItem('eterx_scheduled_tasks_sync_pending');
          const response = await fetch('/api/scheduled-tasks', { cache: 'no-store' });
          if (response.ok) {
            const snapshot = await response.json();
            const durable = Array.isArray(snapshot?.tasks) ? snapshot.tasks.map(normalizeScheduledTask) : [];
            if (durable.length > 0 || tasks.length === 0 || Number(snapshot?.savedAt || 0) > 0) {
              tasks = durable;
              appStorage.setItem(SCHEDULED_TASKS_STORAGE_KEY, JSON.stringify(tasks));
            } else if (tasks.length > 0) {
              void persistScheduledTaskRecords(tasks);
            }
          }
        } catch { }
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
              const recoveredNextRun = computeNextScheduledRun(task.recurrence, now);
              task.status = recoveredNextRun === null ? 'failed' : 'scheduled';
              if (recoveredNextRun !== null) {
                task.scheduledTimestamp = recoveredNextRun;
                const nextDate = new Date(recoveredNextRun);
                task.triggerTime = `${String(nextDate.getHours()).padStart(2, '0')}:${String(nextDate.getMinutes()).padStart(2, '0')}`;
                task.customDate = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;
                task.dateOption = 'custom';
              }
              task.updatedAt = now;
              task.lastError = latestRun.error;
              updated = true;
            }
          }
        });

        if (updated) {
          persistScheduledTaskRecords(tasks);
        }
        dueTasks.forEach(task => {
          window.dispatchEvent(new CustomEvent('eterx_trigger_scheduled_task', { detail: { task } }));
        });
      } catch { }
      finally { checking = false; }
    };

    const initializeScheduler = async () => {
      try {
        const desktopApi = (window as any).electronAPI;
        const state = await desktopApi?.getGatewayState?.();
        if (state?.config) {
          appStorage.setItem('eterx_background_active_chats', String(Boolean(state.config.enabled && state.config.keepActiveChatsOnClose !== false)));
          appStorage.setItem('eterx_background_scheduled_tasks', String(Boolean(state.config.enabled && state.config.runScheduledTasksInBackground !== false)));
        }
      } catch { }
      await checkTasks();
    };
    void initializeScheduler();
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
      const savedThinkingLevel = appStorage.getItem(MAIN_AGENT_THINKING_LEVEL_STORAGE_KEY);
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
      appStorage.setItem(MAIN_AGENT_THINKING_LEVEL_STORAGE_KEY, safeLevel);
    } catch { }
  }, [updateComposerState]);

  const handleAgentChange = useCallback((agentId: string | null, agentName: string, isChatMode = false) => {
    const next: SelectedAgentState = {
      agentId: isChatMode ? null : agentId?.trim() ? agentId.trim() : null,
      agentName: isChatMode ? 'Chat' : agentId?.trim() ? (agentName?.trim() || agentId.trim()) : 'General',
      chatMode: isChatMode,
    };
    composerRuntimeSelectionRef.current.selectedAgent = next;
    setSelectedAgentState(next);
    // A sub-agent tab belongs to the previously selected main agent. Keeping it
    // selected after changing the main agent makes the composer and timeline
    // point at two different runtimes.
    setActiveSubAgentTab(null);
    setSubAgentDockOpen(false);
    setOverflowDropdownOpen(false);
    updateComposerState(state => ({ ...state, selectedAgent: next }));
    try {
      appStorage.setItem(SELECTED_AGENT_STORAGE_KEY, JSON.stringify(next));
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
    try { appStorage.setItem(`eterx_proxy_controls_${ activeChatId || 'new_chat' }`, JSON.stringify({ enabled: nextEnabled, intervention: proxyIntervention })); } catch { }
    if (activeChatId) await updateProxyControl(nextEnabled ? 'resume' : 'pause');
  }, [activeChatId, proxyEnabled, proxyIntervention, updateProxyControl]);

  const handleProxyInterventionChange = useCallback(async (level: 'minimal' | 'normal' | 'high') => {
    const previousLevel = proxyIntervention;
    setProxyIntervention(level);
    try { appStorage.setItem(`eterx_proxy_controls_${ activeChatId || 'new_chat' }`, JSON.stringify({ enabled: proxyEnabled, intervention: level })); } catch { }
    if (activeChatId && !await updateProxyControl('intervention', level)) {
      setProxyIntervention(previousLevel);
      try { appStorage.setItem(`eterx_proxy_controls_${ activeChatId }`, JSON.stringify({ enabled: proxyEnabled, intervention: previousLevel })); } catch { }
    }
  }, [activeChatId, proxyEnabled, proxyIntervention, updateProxyControl]);

  useEffect(() => {
    const key = `eterx_proxy_controls_${ activeChatId || 'new_chat' }`;
    const restoreProxyControls = () => {
      try {
        const saved = JSON.parse(appStorage.getItem(key) || '{}');
        setProxyEnabled(saved.enabled !== false);
        setProxyIntervention(['minimal', 'normal', 'high'].includes(saved.intervention) ? saved.intervention : 'normal');
      } catch {
        setProxyEnabled(true);
        setProxyIntervention('normal');
      }
    };
    restoreProxyControls();
    void appStorageReady.then(restoreProxyControls);
  }, [activeChatId]);

  useEffect(() => {
    if (!showProxyChat || !activeChatId) return;
    const targetChatId = activeChatId;
    let cancelled = false;
    let refreshInFlight = false;
    const refreshProxyContext = async () => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      try {
        const response = await fetch(`/api/agent/proxy-manager?chatId=${encodeURIComponent(targetChatId)}`, {
          cache: 'no-store',
        });
        const data = response.ok ? await response.json() : null;
        if (cancelled || activeChatIdRef.current !== targetChatId || !data?.context) return;
        setProxyManagerContext(data.context);
      } catch { }
      finally { refreshInFlight = false; }
    };
    void refreshProxyContext();
    const interval = window.setInterval(refreshProxyContext, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeChatId, showProxyChat]);

  useEffect(() => {
    const restoreProxyRuntimeModel = () => {
      try {
      setProxyRuntimeModelSelection(appStorage.getItem(`eterx_proxy_runtime_model_${ activeChatId || 'new_chat' }`) || AUTO_MODEL_SELECTION);
      } catch {
        setProxyRuntimeModelSelection(AUTO_MODEL_SELECTION);
      }
    };
    restoreProxyRuntimeModel();
    void appStorageReady.then(restoreProxyRuntimeModel);
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
        path: getNativeFilePath(file) || relPath || file.name,
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
    const restoreProxyManagerModel = () => {
      try {
        setProxyModelSelection(appStorage.getItem(`eterx_proxy_manager_model_${ activeChatId }`) || AUTO_MODEL_SELECTION);
      } catch { setProxyModelSelection(AUTO_MODEL_SELECTION); }
    };
    restoreProxyManagerModel();
    void appStorageReady.then(restoreProxyManagerModel);
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
        const canonicalMessages = normalizeProxyHistoryMessages(data.messages);
        setProxyChatMessages(previous => reconcileProxyChatMessages(previous, canonicalMessages));
        setProxyChatHistoryChatId(activeChatId);
      })
      .catch(() => { /* Keep any optimistic/live messages already on screen. */ });
    return () => { cancelled = true; };
  }, [activeChatId]);

  useEffect(() => {
    if (!activeChatId) return;
    try { appStorage.setItem(`eterx_proxy_manager_model_${ activeChatId }`, proxyModelSelection); } catch { }
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
    const parsedModel = parseModelEntryKey(proxyModelSelection);
    if (!parsedModel || !proxyModelEntries.some(entry => modelEntryKey(entry.provider, entry.modelId) === proxyModelSelection)) {
      const createdAt = Date.now();
      setProxyChatMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        sender: 'proxy',
        text: 'Select a configured model before messaging the Proxy Manager.',
        time: new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        createdAt,
        delivery: 'unavailable',
      }]);
      return;
    }
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
    const sentAt = Date.now();
    setProxyChatHistoryChatId(requestChatId);
    setProxyChatMessages(prev => [...prev, {
      id: optimisticId,
      sender: 'user',
      text: fullText,
      time: new Date(sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      createdAt: sentAt,
      optimistic: true,
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
        const canonicalMessages = normalizeProxyHistoryMessages(historyArr);
        setProxyChatMessages(previous => reconcileProxyChatMessages(previous, canonicalMessages));
        } else if (data.reply) {
        // Server returned only the reply (no full history) — append it
        const createdAt = Date.now();
        setProxyChatMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          sender: 'proxy' as const,
          text: String(data.reply || ''),
          time: new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          createdAt,
        }]);
        }
      }
      if (data.wakeRequested) {
        const connectProxyRun = async (attempt = 0) => {
          if (activePollersRef.current.has(requestChatId)) {
            catchUpPollersRef.current.get(requestChatId)?.();
            return;
          }
          const observedPollGeneration = pollGenerationRef.current.get(requestChatId) || 0;
          try {
            const poll = await fetchAgentPoll(requestChatId, -1, 5000);
            if (
              activePollersRef.current.has(requestChatId) ||
              (pollGenerationRef.current.get(requestChatId) || 0) !== observedPollGeneration
            ) return;
            if (poll.status !== 'running') {
              if (attempt < 11) window.setTimeout(() => connectProxyRun(attempt + 1), 500);
              return;
            }
            setRunningChats(previous => new Set(previous).add(requestChatId));
            if (poll.traces?.length) {
              setChatLogsById(requestChatId, previous => mergeServerRunLogs(previous, poll.traces, {
                chatId: requestChatId,
                runId: poll.runId,
                startedAt: poll.startedAt,
              }));
            }
            startPolling(requestChatId, getPollCursor(poll), poll.startedAt, poll.runId);
          } catch {
            if (attempt < 11) window.setTimeout(() => connectProxyRun(attempt + 1), 700);
          }
        };
        window.setTimeout(() => connectProxyRun(), 250);
      }
      // else: server sent empty history + no reply → keep optimistic user msg
    } catch (error: any) {
      if (activeChatIdRef.current === requestChatId) {
        const createdAt = Date.now();
        setProxyChatMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          sender: 'proxy',
          text: String(error?.message || 'Proxy Manager is temporarily unavailable.'),
          time: new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          createdAt,
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
  }, [activeChatId, proxyAttachments, proxyChatInput, proxyChatLoading, proxyModelEntries, proxyModelSelection, proxyPinnedItems]);

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
      appStorage.setItem(SPLIT_CHAT_WIDTH_KEY, String(nextWidth));
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
      appStorage.setItem(SPLIT_CHAT_WIDTH_KEY, String(nextWidth));
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
        appStorage.setItem(SPLIT_CHAT_WIDTH_KEY, String(latestChatPanelWidthRef.current));
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
      const savedWidth = Number(appStorage.getItem(SPLIT_CHAT_WIDTH_KEY));
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
  const gatewayReplyRunIdsRef = useRef<Set<string>>(new Set());

  // Dictation stays live until the user turns it off. Chromium desktop builds
  // use the prefixed constructor while newer browsers expose the standard one.
  const speechRecognitionRef = useRef<any>(null);
  const dictationShouldRunRef = useRef(false);
  const dictationRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dictationBaseTextRef = useRef('');
  const dictationCommittedTextRef = useRef('');
  const lastDictationRenderRef = useRef<string | null>(null);
  const dictationRenderedValuesRef = useRef<Set<string>>(new Set());
  const inputValueRef = useRef(inputValue);

  const rememberDictationRender = useCallback((value: string) => {
    const renderedValues = dictationRenderedValuesRef.current;
    renderedValues.add(value);
    while (renderedValues.size > 12) {
      const oldest = renderedValues.values().next().value;
      if (typeof oldest !== 'string') break;
      renderedValues.delete(oldest);
    }
  }, []);

  useEffect(() => {
    inputValueRef.current = inputValue;
    if (dictationRenderedValuesRef.current.delete(inputValue)) return;
    if (
      dictationShouldRunRef.current &&
      lastDictationRenderRef.current !== null &&
      inputValue !== lastDictationRenderRef.current
    ) {
      // The user edited the composer while dictation was active. Make that
      // exact draft the new base so a later speech event cannot restore an old
      // value or erase the edit.
      dictationBaseTextRef.current = inputValue;
      dictationCommittedTextRef.current = '';
      lastDictationRenderRef.current = inputValue;
    }
  }, [inputValue]);

  const stopSpeechDictation = useCallback(() => {
    dictationShouldRunRef.current = false;
    if (dictationRestartTimerRef.current) {
      clearTimeout(dictationRestartTimerRef.current);
      dictationRestartTimerRef.current = null;
    }
    const recognition = speechRecognitionRef.current;
    speechRecognitionRef.current = null;
    if (recognition) {
      recognition.onend = null;
      try { recognition.stop(); } catch { }
    }
    void (window as any).electronAPI?.stopSpeechDictation?.();
    lastDictationRenderRef.current = null;
    dictationRenderedValuesRef.current.clear();
    setIsRecording(false);
  }, []);

  useEffect(() => () => stopSpeechDictation(), [stopSpeechDictation]);

  useEffect(() => {
    const desktopApi = (window as any).electronAPI;
    if (typeof desktopApi?.onSpeechDictationEvent !== 'function') return;

    const applyNativeTranscript = (speechText: string) => {
      const nextText = appendSpeechToDraft(dictationBaseTextRef.current, speechText);
      inputValueRef.current = nextText;
      lastDictationRenderRef.current = nextText;
      rememberDictationRender(nextText);
      updateInputValue(nextText);
    };

    return desktopApi.onSpeechDictationEvent((event: any) => {
      if (!dictationShouldRunRef.current) return;
      const type = String(event?.type || '');
      const text = String(event?.text || '');

      if (type === 'partial') {
        applyNativeTranscript(mergeSpeechText(dictationCommittedTextRef.current, text));
        return;
      }
      if (type === 'final') {
        dictationCommittedTextRef.current = mergeSpeechText(dictationCommittedTextRef.current, text);
        applyNativeTranscript(dictationCommittedTextRef.current);
        return;
      }
      if (type === 'error') {
        dictationShouldRunRef.current = false;
        lastDictationRenderRef.current = null;
        setIsRecording(false);
        alert(text || 'Voice dictation could not start. Check your microphone and installed speech language.');
        return;
      }
      if (type === 'stopped') {
        dictationShouldRunRef.current = false;
        lastDictationRenderRef.current = null;
        setIsRecording(false);
      }
    });
  }, [rememberDictationRender, updateInputValue]);

  // ═══════════════════════════════════════════════════════════════
  // AGENT LIVE — provider-specific realtime voice conversations
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
    liveBootstrapAbortRef.current?.abort();
    const bootstrapController = new AbortController();
    liveBootstrapAbortRef.current = bootstrapController;
    const bootstrapTimeout = setTimeout(() => {
      bootstrapController.abort(new Error('Live startup timed out while contacting the configured provider.'));
    }, 30_000);
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
      // The desktop storage bridge may still be hydrating when the first
      // composer click arrives. Wait for it so Live reads the normalized
      // provider/model settings instead of racing the folder-backed store.
      await appStorageReady;
      let storedLiveSettings: any = {};
      try {
        storedLiveSettings = JSON.parse(appStorage.getItem(SETTINGS_STORAGE_KEY) || '{}');
      } catch {}
      if (!isCurrentSession()) return;
      const configuredMicMuted = storedLiveSettings.liveConvoAudioInput === false;
      const configuredSpeakerMuted = storedLiveSettings.liveConvoAudioOutput === false;
      liveMicMutedRef.current = configuredMicMuted;
      liveSpeakerMutedRef.current = configuredSpeakerMuted;
      setLiveMicMuted(configuredMicMuted);
      setLiveSpeakerMuted(configuredSpeakerMuted);
      if (storedLiveSettings.liveConvoEnabled === false) {
        throw new Error('Live Convo is disabled in Settings.');
      }
      const configuredLiveProviderOption = normalizeLiveProvider(storedLiveSettings.liveConvoProvider);
      const configuredLiveProvider = configuredLiveProviderOption.provider;
      const configuredLiveProviderId = configuredLiveProviderOption.value;
      const storedLiveModel = String(storedLiveSettings.liveConvoModel || 'auto').trim() || 'auto';
      const configuredLiveModel = isLiveModelForProvider(configuredLiveProviderId, storedLiveModel)
        ? storedLiveModel
        : 'auto';
      let resolvedLiveMediaModel = configuredLiveModel === 'auto' ? '' : configuredLiveModel;
      let resolvedLiveThinkingCapabilities: ModelThinkingCapabilities | null = null;

      // Auto is resolved from a fresh provider catalog at the moment a Live
      // session starts. The stored preference remains "auto", so future model
      // launches automatically follow provider catalog changes.
      if (configuredLiveModel === 'auto') {
        try {
          const catalogResponse = await fetch('/api/live/models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: bootstrapController.signal,
            body: JSON.stringify({ provider: configuredLiveProviderId }),
          });
          const catalogPayload = await catalogResponse.json();
          if (!isCurrentSession()) return;
          const currentModels = catalogPayload?.models;
          const firstUsableModel = Array.isArray(currentModels)
            ? currentModels.find((model: any) => String(model?.id || '').trim() && String(model.id).trim() !== 'auto')
            : null;
          if (catalogResponse.ok && firstUsableModel?.id) {
            const liveModel = firstUsableModel;
            resolvedLiveMediaModel = String(liveModel.id);
            resolvedLiveThinkingCapabilities = normalizeModelThinkingCapabilities(liveModel.thinking);
          }
        } catch {}
      }
      if (!resolvedLiveMediaModel) {
        resolvedLiveMediaModel = getLiveModelOptions(configuredLiveProviderId)
          .find(option => option.value !== 'auto')?.value || DEFAULT_GEMINI_LIVE_MODEL;
      }
      if (!resolvedLiveThinkingCapabilities && resolvedLiveMediaModel) {
        resolvedLiveThinkingCapabilities = readRuntimeModelThinkingCapability(
          modelEntryKey(configuredLiveProvider, resolvedLiveMediaModel),
        );
      }
      const defaultLiveWorkerEntry = readRuntimeModelEntries().find(entry =>
        entry.provider === configuredLiveProvider && !/live|native-audio/i.test(entry.modelId),
      );
      const defaultLiveWorker = defaultLiveWorkerEntry
        ? {
            provider: defaultLiveWorkerEntry.provider,
            modelId: defaultLiveWorkerEntry.modelId,
            selection: modelEntryKey(defaultLiveWorkerEntry.provider, defaultLiveWorkerEntry.modelId),
          }
        : null;
      const configuredLiveVoice = String(storedLiveSettings.liveConvoVoice || 'auto').trim() || 'auto';
      const providerDefaultLiveVoice = getDefaultLiveVoice(configuredLiveProviderId);
      let resolvedLiveVoice = configuredLiveVoice === 'auto' ? providerDefaultLiveVoice : configuredLiveVoice;
      try {
        const voiceResponse = await fetch('/api/settings/live-voices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: bootstrapController.signal,
          body: JSON.stringify({
            provider: configuredLiveProviderId,
            modelId: resolvedLiveMediaModel || configuredLiveModel,
          }),
        });
        const voicePayload = await voiceResponse.json();
        if (!isCurrentSession()) return;
        const availableVoices = Array.isArray(voicePayload?.voices)
          ? voicePayload.voices
              .map((voice: any) => String(voice?.value || voice?.id || '').trim())
              .filter(Boolean)
          : [];
        const defaultVoice = String(
          voicePayload?.defaultVoice ||
          voicePayload?.voices?.find((voice: any) => String(voice?.value || voice?.id || '') !== 'auto')?.value ||
          providerDefaultLiveVoice,
        ).trim() || providerDefaultLiveVoice;
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

      // Fetch the dedicated Agent Live API key.
      const res = await fetch('/api/live/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: bootstrapController.signal,
            body: JSON.stringify({ provider: configuredLiveProviderId, chatId: currentChatId })
      });
      if (!isCurrentSession()) return;

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to get API key');
      }

      const keyPayload = await res.json();
      const apiKey = String(keyPayload?.apiKey || '');
      if (!apiKey && keyPayload?.available !== true) {
        throw new Error(`No ${configuredLiveProviderOption.label} Live credential is available.`);
      }
      if (!isCurrentSession()) return;

      // Pre-load past memories & current chat history for instant context
      let pastMemories: string[] = [];
      try {
      const localMemStr = appStorage.getItem(`eterx_live_mem_${currentChatId}`);
        const localMem = localMemStr ? JSON.parse(localMemStr) : [];
      const globalMemStr = appStorage.getItem(`eterx_global_memories`);
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
      const chatHistory = normalizeBuilderUserActionLogs(targetChatObj?.traceLogs || [])
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
        const committedTurnKey = `${ currentChatId }:${ liveTurnId }`;
        if (committedLiveTurnIdsRef.current.has(committedTurnKey)) return;
        // Reconnects can replay the completed payload with a fresh provider
        // turn id. Treat an identical payload received within the handoff
        // window as the same turn, while still allowing the user to repeat a
        // message naturally later in the conversation.
        const livePayloadSignature = [
          cleanUserText.replace(/\s+/g, ' '),
          cleanModelText.replace(/\s+/g, ' '),
          commands.map(command => `${ command.type || '' }:${ command.toolCallId || command.noteId || '' }:${ command.text || '' }`).join('|'),
        ].join('\u0000');
        const now = Date.now();
        for (const [signature, committedAt] of recentLiveCommitSignaturesRef.current) {
          if (now - committedAt > 15000) recentLiveCommitSignaturesRef.current.delete(signature);
        }
        if (recentLiveCommitSignaturesRef.current.has(livePayloadSignature)) return;
        recentLiveCommitSignaturesRef.current.set(livePayloadSignature, now);
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
          committedLiveTurnIdsRef.current.add(committedTurnKey);
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
            id: `live-user-${ turnId }`,
            type: 'user_action',
            text: cleanUserText,
            source: 'human',
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
            id: `live-answer-${ turnId }`,
            answerId: `live-answer-${ turnId }`,
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

        committedLiveTurnIdsRef.current.add(committedTurnKey);
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
                  traceLogs: canonicalizeClientTraceLogs([...(chat.traceLogs || []), ...newTraceLogs]),
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
              ? canonicalizeClientTraceLogs([...previous, ...newTraceLogs])
              : previous
          );
        }
        if (cleanModelText) {
          markChatUnreadIfBackground(currentChatId, `live:${liveTurnId}:answer`);
        }
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

      const session = createLiveSession(
        apiKey,
        currentChatId,
        configuredLiveProviderOption,
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
            const liveToolName = normalizeToolTraceName(activity.toolName);
            const liveLabel = normalizeToolTraceText(activity.label) || getToolDisplayLabel(liveToolName);
            const liveDetail = normalizeToolTraceText(activity.resultSummary || activity.detail);
            const isActive = activity.phase === 'started' || activity.phase === 'running';
            const activityTurnId = liveTurnIdRef.current || (isActive ? ensureLiveTurnId() : null);
            if (isActive) {
              liveActiveActivityIdRef.current = activity.id;
              setLiveActivityLabel(
                activity.kind === 'thinking'
                  ? liveDetail || liveLabel
                  : liveLabel
              );
            } else if (liveActiveActivityIdRef.current === activity.id) {
              liveActiveActivityIdRef.current = null;
              setLiveActivityLabel(null);
            }
            if (!activityTurnId) return;
            const isThinkingActivity = activity.kind === 'thinking';
            const trace = {
              type: isThinkingActivity ? 'thought_stream' : 'command',
              text: isThinkingActivity ? (liveDetail || liveLabel) : liveLabel,
              secondary: liveDetail || undefined,
              tool: liveToolName,
              toolName: liveToolName,
              iconCategory: liveToolName === 'manage_scheduled_tasks'
                ? 'clock'
                : activity.kind === 'delegation'
                  ? 'agent'
                  : 'computer',
              toolCallId: activity.id,
              ...(isThinkingActivity
                ? { thoughtId: activity.id, noteId: activity.id, streamState: isActive ? 'open' : 'closed' }
                : {}),
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
              label: liveLabel,
              detail: liveDetail,
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
              // Keep enough of the current turn for the shared thought
              // sequence; thinking updates reuse one id and do not grow this.
              return next.slice(-12);
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
            if (metadata?.systemEvent || metadata?.internalEvent) {
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
              const boundedLogs = normalizeBuilderUserActionLogs(targetChat.traceLogs || []).slice(-160);
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
                  const queueId = crypto.randomUUID();
                  const queued = await queueFollowUpForChat(dispatchChatId, prompt, [], queueId, false);
                  if (!queued) {
                    return { error: `The follow-up could not be queued for "${dispatchChat?.title || 'Untitled'}".` };
                  }
                  syncLiveMissionTask(
                    dispatchChatId,
                    dispatchChat?.title || 'Queued background task',
                    prompt,
                    'queued',
                  );
                  return {
                    success: true,
                    mode: 'queued_next_run',
                    queueId,
                    chatId: dispatchChatId,
                    chatTitle: dispatchChat?.title || 'Untitled',
                    message: `Follow-up queued after the active run in "${dispatchChat?.title || 'Untitled'}".`,
                  };
                }
                const steered = await sendSteeringMessageToChat(dispatchChatId, prompt, undefined, false);
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
                    const steered = await sendSteeringMessageToChat(dispatchChatId, prompt, undefined, false);
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
                DEFAULT_CHAT_TITLE;
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
              const requestedOperation = String(args.operation || 'list').toLowerCase();
              const operation = requestedOperation === 'rename' ? 'update' : requestedOperation;
              let tasks: ScheduledTaskRecord[] = [];
              try {
                const saved = JSON.parse(appStorage.getItem(SCHEDULED_TASKS_STORAGE_KEY) || '[]');
                tasks = Array.isArray(saved) ? saved.map(normalizeScheduledTask) : [];
              } catch {
                tasks = [];
              }
              if (!appStorage.getItem('eterx_scheduled_tasks_sync_pending')) {
                try {
                  const response = await fetch('/api/scheduled-tasks', { cache: 'no-store' });
                  if (response.ok) {
                    const snapshot = await response.json();
                    if (Array.isArray(snapshot?.tasks)) {
                      tasks = snapshot.tasks.map(normalizeScheduledTask);
                      appStorage.setItem(SCHEDULED_TASKS_STORAGE_KEY, JSON.stringify(tasks));
                    }
                  }
                } catch { }
              }
              const saveScheduledTasks = (next: ScheduledTaskRecord[]) => {
                persistScheduledTaskRecords(next);
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
              const resolveTaskAgent = async (requestedId: unknown, requestedName: unknown) => {
                const agentId = String(requestedId || '').trim();
                if (!agentId || agentId === 'general') return { agentId: null, agentName: 'General' };
                if (agentId === 'coding') return { agentId, agentName: 'Coding' };
                if (agentId === 'autonomous') return { agentId, agentName: 'Autonomous' };
                try {
                  const response = await fetch('/api/agents/list', { cache: 'no-store' });
                  const payload = response.ok ? await response.json() : {};
                  const match = (Array.isArray(payload?.agents) ? payload.agents : [])
                    .find((agent: any) => String(agent.agentId || '') === agentId && agent.status === 'ready');
                  return match
                    ? { agentId, agentName: String(match.name || requestedName || agentId) }
                    : { error: `Ready custom agent not found for ID: ${agentId}` };
                } catch {
                  return { error: `Could not load the ready custom agent from app storage: ${agentId}` };
                }
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
                const resolvedAgent = await resolveTaskAgent(args.agentId, args.agentName);
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
                  workspacePath: activeWorkspacePath,
                  runLocation: activeRunLocation,
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
                if (requestedOperation === 'rename' && !String(args.title || '').trim()) return { error: 'A new title is required to rename a task.' };
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
                  const resolvedAgent = await resolveTaskAgent(args.agentId, args.agentName);
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
              if (operation === 'pause') {
                if (existingTask.status === 'running') return { error: 'A running scheduled task cannot be paused. Stop its chat run first or wait for completion.' };
                existingTask.status = 'paused';
                existingTask.updatedAt = Date.now();
                saveScheduledTasks(tasks);
                return { success: true, taskId, task: existingTask, message: `Paused "${existingTask.title}".` };
              }
              if (operation === 'resume') {
                existingTask.status = existingTask.scheduledTimestamp <= Date.now() ? 'queued' : 'scheduled';
                existingTask.updatedAt = Date.now();
                saveScheduledTasks(tasks);
                if (existingTask.status === 'queued') {
                  window.dispatchEvent(new CustomEvent('eterx_trigger_scheduled_task', { detail: { task: existingTask } }));
                }
                return { success: true, taskId, task: existingTask, message: `Resumed "${existingTask.title}".` };
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
              let serverAgents: any[] = [];
              try {
                const response = await fetch('/api/agents/list', { cache: 'no-store' });
                const payload = response.ok ? await response.json() : {};
                serverAgents = Array.isArray(payload.agents) ? payload.agents : [];
              } catch { }
              const agentsById = new Map<string, any>();
              for (const agent of serverAgents) {
                const id = String(agent.agentId || agent.id || '').trim();
                if (!id) continue;
                agentsById.set(id, {
                    ...agent,
                    id,
                    name: agent.name || id,
                    description: agent.mission || '',
                    isSetup: agent.status === 'ready',
                    kind: agent.kind,
                    stepCount: agent.stepCount,
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
                    kind: agent.kind,
                    stepCount: agent.stepCount,
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
                handleOpenAgentBuilder(agentId, String(args.agentName || requestedAgent?.name || '').trim() || undefined);
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
                  .filter((log: any) => {
                    const type = String(log?.type || '');
                    return Boolean(
                      log?.subAgentId
                      || log?.subAgentChatId
                      || log?.auxiliaryRuntime
                      || /^sub_agent_/.test(type)
                      || ['inter_agent_comm', 'inter_agent_message'].includes(type)
                      || (log?.subAgent && !log?.customAgentId && log.subAgent !== 'Main'),
                    );
                  })
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
               liveMicMutedRef.current = false;
               liveSpeakerMutedRef.current = false;
               setLiveMicMuted(false);
               setLiveSpeakerMuted(false);
               setLiveState('idle');
              setLiveError(null);
            }, 4000);
          },
        },
        {
          provider: configuredLiveProvider,
          agentId: String(storedLiveSettings.liveConvoAgentId || '').trim() || undefined,
          thinkingLevel: configuredLiveProvider === 'gemini'
            ? normalizeThinkingLevelForModel(
                storedLiveSettings.liveConvoLatencyMode === 'ultra-low'
                  ? 'minimal'
                  : storedLiveSettings.liveConvoLatencyMode === 'balanced'
                    ? 'medium'
                    : 'high',
                'gemini',
                resolvedLiveMediaModel,
                resolvedLiveThinkingCapabilities,
              ) as 'minimal' | 'low' | 'medium' | 'high'
            : 'medium',
          thinkingCapabilities: configuredLiveProvider === 'gemini' ? resolvedLiveThinkingCapabilities : null,
          model: resolvedLiveMediaModel,
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
      session.setMicMuted(liveMicMutedRef.current);
      session.setSpeakerMuted(liveSpeakerMutedRef.current);
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
         liveMicMutedRef.current = false;
         liveSpeakerMutedRef.current = false;
         setLiveMicMuted(false);
         setLiveSpeakerMuted(false);
         setLiveState('idle');
        setLiveError(null);
      }, 4000);
    } finally {
      clearTimeout(bootstrapTimeout);
      if (liveBootstrapAbortRef.current === bootstrapController) {
        liveBootstrapAbortRef.current = null;
      }
    }
  }, [activeChatId, activeRunLocation, activeWorkspacePath, discardEphemeralLiveRoom, revealNetworkBanner, syncLiveMissionTask, updateLiveMission, upsertLiveMissionEntry]);

  const stopLiveSession = useCallback(() => {
    liveBootstrapAbortRef.current?.abort();
    liveBootstrapAbortRef.current = null;
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
     liveMicMutedRef.current = false;
     liveSpeakerMutedRef.current = false;
     setLiveMicMuted(false);
     setLiveSpeakerMuted(false);
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
    const next = !liveMicMutedRef.current;
    const session = liveSessionRef.current;
    session?.setMicMuted(next);
    const applied = session?.isMicMuted() ?? next;
    liveMicMutedRef.current = applied;
    setLiveMicMuted(applied);
    setLiveError(null);
  }, []);

  const toggleLiveSpeakerMute = useCallback(() => {
    const next = !liveSpeakerMutedRef.current;
    const session = liveSessionRef.current;
    session?.setSpeakerMuted(next);
    const applied = session?.isSpeakerMuted() ?? next;
    liveSpeakerMutedRef.current = applied;
    setLiveSpeakerMuted(applied);
    setLiveError(null);
  }, []);

  const toggleLiveCamera = useCallback(async () => {
    if (liveCameraTogglePendingRef.current) return;
    const session = liveSessionRef.current;
    if (!session) {
      setLiveError('Live session is still connecting.');
      return;
    }
    liveCameraTogglePendingRef.current = true;
    try {
      if (session.isCameraEnabled()) {
        session.stopCamera();
        setLiveCameraEnabled(false);
        setLiveError(null);
        return;
      }
      setLiveError('Waiting for camera permission…');
      const result = await session.startCamera('user');
      if (liveSessionRef.current !== session) return;
      setLiveError(result.success ? null : result.message);
    } finally {
      liveCameraTogglePendingRef.current = false;
    }
  }, []);

  const toggleLiveScreenShare = useCallback(async () => {
    if (liveScreenTogglePendingRef.current) return;
    const session = liveSessionRef.current;
    if (!session) {
      setLiveError('Live session is still connecting.');
      return;
    }
    liveScreenTogglePendingRef.current = true;
    try {
      if (session.isScreenShareEnabled()) {
        session.stopScreenShare();
        setLiveScreenShareEnabled(false);
        setLiveError(null);
        return;
      }
      setLiveError('Waiting for screen permission…');
      const result = await session.startScreenShare();
      if (liveSessionRef.current !== session) return;
      setLiveError(result.success ? null : result.message);
    } finally {
      liveScreenTogglePendingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !(window as any).electronAPI?.onPetReply) return;

    const unsubscribe = (window as any).electronAPI.onPetReply((rawMessage: string) => {
      try {
        const data = typeof rawMessage === 'string' && rawMessage.startsWith('{') ? JSON.parse(rawMessage) : { action: rawMessage };
        if (data.action === 'toggle-mic') {
          if (typeof data.muted === 'boolean') {
            const session = liveSessionRef.current;
            session?.setMicMuted(data.muted);
            const applied = session?.isMicMuted() ?? data.muted;
            liveMicMutedRef.current = applied;
            setLiveMicMuted(applied);
            setLiveError(null);
          } else {
            toggleLiveMicMute();
          }
        } else if (data.action === 'toggle-speaker') {
          if (typeof data.muted === 'boolean') {
            const session = liveSessionRef.current;
            session?.setSpeakerMuted(data.muted);
            const applied = session?.isSpeakerMuted() ?? data.muted;
            liveSpeakerMutedRef.current = applied;
            setLiveSpeakerMuted(applied);
            setLiveError(null);
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
        id: `live-user-${ turnId }`,
        type: 'user_action',
        text: liveInputText,
        source: 'human',
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
        id: `live-answer-${ turnId }`,
        answerId: `live-answer-${ turnId }`,
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
    let cancelled = false;
    let restoreInFlight = false;
    let lastRestoreAt = 0;
    let restoreRetryTimer: number | null = null;

    const applyRestoredChats = (
      restoredChats: ChatSession[],
      preserveMetadataOnlyChats = false
    ) => {
      if (cancelled) return;
        const cleanChats = (preserveMetadataOnlyChats
          ? restoredChats
          : removeGeneratedEmptyChats(restoredChats))
        .map(chat => enforceChatTraceOwnership({
          ...chat,
          traceLogs: canonicalizeClientTraceLogs(chat.traceLogs || [], chat.id),
        }));
      setChats(cleanChats);
    };

    const restoreChats = async (force = false, persistRestoredSnapshot = true) => {
      if (cancelled || restoreInFlight || (!force && chatSnapshotReadyRef.current)) return;
      if (force && Date.now() - lastRestoreAt < 1500) return;
      restoreInFlight = true;
      lastRestoreAt = Date.now();

      try {
        let snapshot: any = null;
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const response = await fetch('/api/chats', { cache: 'no-store' });
            if (!response.ok) throw new Error(`Chat restore HTTP ${ response.status }`);
            snapshot = await response.json();
            if (!Array.isArray(snapshot?.chats)) throw new Error('Chat restore returned an invalid snapshot');
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < 2) {
              await new Promise(resolve => window.setTimeout(resolve, 250 * (attempt + 1)));
            }
          }
        }

        if (lastError || cancelled) {
          if (lastError && !cancelled) {
            console.error('[Chats] Durable restore failed:', lastError);
            if (restoreRetryTimer === null) {
              restoreRetryTimer = window.setTimeout(() => {
                restoreRetryTimer = null;
                void restoreChats(true);
              }, 2000);
            }
          }
          return;
        }

        const appDataChats = removeGeneratedEmptyChats(sortChats(snapshot.chats)).filter(
          chat => !pendingChatDeletionIdsRef.current.has(chat.id)
        );
        hydratedChatIdsRef.current = new Set(appDataChats.map(chat => chat.id));
        const appDataSavedAt = Number(snapshot?.savedAt || 0);
        // Keep the durable revision supplied by the store. Using Date.now()
        // here makes a slow restore appear newer than a write that happened
        // in another window while this request was in flight, so the next
        // BroadcastChannel update gets incorrectly ignored.
        lastChatSnapshotAtRef.current = Math.max(
          lastChatSnapshotAtRef.current,
          Number.isFinite(appDataSavedAt) ? appDataSavedAt : 0,
        );

        const mergedById = new Map(appDataChats.map(chat => [chat.id, chat]));
        // Preserve only in-memory changes made while the folder snapshot was
        // loading; the filesystem snapshot is the durable source of truth.
        for (const currentChat of chatsRef.current) {
          if (!mergedById.has(currentChat.id)) mergedById.set(currentChat.id, currentChat);
        }
        const restoredChats = removeGeneratedEmptyChats(sortChats(Array.from(mergedById.values())));
        chatSnapshotReadyRef.current = true;
        applyRestoredChats(restoredChats);
        if (persistRestoredSnapshot) persistChats(restoredChats);
      } finally {
        restoreInFlight = false;
        const pendingRevision = pendingChatRestoreRevisionRef.current;
        if (!cancelled && pendingRevision > lastChatSnapshotAtRef.current && restoreRetryTimer === null) {
          pendingChatRestoreRevisionRef.current = 0;
          restoreRetryTimer = window.setTimeout(() => {
            restoreRetryTimer = null;
            void restoreChats(true, false);
          }, 1600);
        }
      }
    };

    // The update coordinator can ask for a restore when the app was launched
    // while the local server was still warming up. Keep that recovery path
    // explicit instead of making the updater treat an unhydrated chat cache as
    // a data-loss risk forever.
    requestChatRestoreRef.current = () => { void restoreChats(true, false); };

    const retryRestoreOnFocus = () => { void restoreChats(true); };
    window.addEventListener('focus', retryRestoreOnFocus);
    let chatChannel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        chatChannel = new BroadcastChannel(CHAT_SYNC_CHANNEL);
        chatChannel.onmessage = event => {
          const savedAt = Number(event?.data?.savedAt || 0);
          if (event?.data?.type !== 'chats-updated' || !Number.isFinite(savedAt)) return;
          if (savedAt <= lastChatSnapshotAtRef.current) return;
          if (restoreInFlight || pendingDurableSnapshotWrite.current) {
            pendingChatRestoreRevisionRef.current = Math.max(
              pendingChatRestoreRevisionRef.current,
              savedAt,
            );
            return;
          }
          void restoreChats(true, false);
        };
      } catch { chatChannel = null; }
    }
    void restoreChats();

    return () => {
      cancelled = true;
      if (restoreRetryTimer !== null) {
        window.clearTimeout(restoreRetryTimer);
        restoreRetryTimer = null;
      }
      window.removeEventListener('focus', retryRestoreOnFocus);
      chatChannel?.close();
      requestChatRestoreRef.current = null;
    };
  // Chat restoration is a startup operation. It must be safe for React Strict
  // Mode's setup -> cleanup -> setup cycle: the first cancelled request must
  // never prevent the second setup from loading the AppData snapshot.
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
    // The native title is intentionally visible only on macOS. Windows and
    // Linux already expose their window controls in the overlay, so mirroring
    // document.title there creates a duplicate EterX wordmark beside them.
    if (desktopPlatform !== 'macos') {
      document.title = '\u200B';
      return;
    }
    if (activeChatId) {
      const activeChat = chats.find(c => c.id === activeChatId);
      if (activeChat && !isDefaultChatTitle(activeChat.title)) {
        document.title = activeChat.title;
        return;
      }
    }
    document.title = "EterX";
  }, [activeChatId, chats, desktopPlatform]);

  useEffect(() => {
    if (activeView === 'chat' && activeChatId) clearUnreadChat(activeChatId);
  }, [activeChatId, activeView, clearUnreadChat]);

  const AGENT_CONNECTION_NOTE_ID = 'eterx-agent-connection';
  const isAgentConnectionLog = (log: any) =>
    !!log && (log._connection === true || (log.type === 'work_note' && log.noteId === AGENT_CONNECTION_NOTE_ID));
  const stripAgentConnectionLogs = (logs: any[] = []) => logs.filter(log => !isAgentConnectionLog(log));
  const normalizeSelfOwnedRuntimeLogs = (logs: any[] = [], ownerChatId?: string) => logs.map((log: any) => {
    if (!log || typeof log !== 'object') return log;
    const type = String(log.type || '');
    const hasRealChildIdentity = Boolean(
      log.subAgentId
      || log.subAgentChatId
      || log.auxiliaryRuntime
      || /^sub_agent_/.test(type)
      || ['inter_agent_comm', 'inter_agent_message'].includes(type),
    );
    const isCustomRuntime = log.agentRuntime === 'custom_agent' || Boolean(log.customAgentId);
    const isBuilderRuntime = log.agentRuntime === 'agent_builder'
      || String(ownerChatId || '').startsWith('agent_builder_')
      || /^builder_(?:note|answer)_/.test(String(log.noteId || log.answerId || ''));
    if (hasRealChildIdentity || (!isCustomRuntime && !isBuilderRuntime)) return log;

    // Older custom and Builder traces used `subAgent` for the selected
    // runtime itself. That field is reserved for actual delegated workers.
    const { subAgent: _ownedSubAgent, ...ownedLog } = log;
    return {
      ...ownedLog,
      ...(log.agentName || log.subAgent ? { agentName: log.agentName || log.subAgent } : {}),
      ...(isCustomRuntime && !log.agentRuntime ? { agentRuntime: 'custom_agent' } : {}),
      ...(isBuilderRuntime && !log.agentRuntime ? { agentRuntime: 'agent_builder' } : {}),
    };
  });
  const canonicalizeClientTraceLogs = (logs: any[] = [], ownerChatId?: string) => {
    const canonicalLogs = canonicalizeThoughtStreamLogs(
      normalizeBuilderUserActionLogs(normalizeSelfOwnedRuntimeLogs(logs, ownerChatId)),
    );
    const transcriptIndexes = new Map<string, number>();
    const reconciledLogs: any[] = [];
    canonicalLogs.forEach(log => {
      if (log?.type !== 'user_action' && log?.type !== 'answer') {
        reconciledLogs.push(log);
        return;
      }
      const turnId = String(log.turnId || log.runId || '').trim();
      const text = String(log.text || '').trim();
      const stableId = String(log.id || log.answerId || '').trim();
      if (!turnId || (!stableId && (!log?.isLive || !text))) {
        reconciledLogs.push(log);
        return;
      }
      const key = stableId
        ? `${ turnId }:${ log.type }:id:${ stableId }`
        : `${ turnId }:${ log.type }:text:${ text }`;
      const previousIndex = transcriptIndexes.get(key);
      if (previousIndex === undefined) {
        transcriptIndexes.set(key, reconciledLogs.length);
        reconciledLogs.push(log);
        return;
      }

      const previous = reconciledLogs[previousIndex];
      const previousText = String(previous?.text || '');
      const previousSettled =
        previous?.type === 'user_action' ||
        previous?.isStreaming === false ||
        (
          previous?.type === 'answer' &&
          previous?.isStreaming !== true &&
          previous?.isLiveTyping !== true &&
          previous?.streamState !== 'open' &&
          previous?.isLive !== true
        );
      const incomingOpen = log?.isStreaming === true || log?.isLiveTyping === true;
      reconciledLogs[previousIndex] = {
        ...previous,
        ...log,
        text: text.length >= previousText.length ? log.text : previous.text,
        startTime: previous.startTime || previous.timestamp || log.startTime || log.timestamp,
        ...(previousSettled && incomingOpen
          ? { isStreaming: false, isLiveTyping: false, isLive: false, streamState: 'closed' }
          : {}),
      };
    });
    return orderFeedTimelineLogs(reconciledLogs);
  };
  const getConsoleOutputText = (log: any) => {
    const candidates = [log?.output, log?.content, log?.outputPreview];
    const populated = candidates.find(value => value !== undefined && value !== null && String(value).length > 0);
    const defined = populated ?? candidates.find(value => value !== undefined && value !== null);
    return String(defined ?? '');
  };
  const compactLiveConsoleOutput = (value: string, maxChars = 750_000) => {
    if (value.length <= maxChars) return value;
    const headChars = Math.min(100_000, Math.floor(maxChars * 0.2));
    let marker = '\n...[terminal output omitted from the live UI]...\n';
    let tailChars = Math.max(0, maxChars - headChars - marker.length);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const omitted = Math.max(0, value.length - headChars - tailChars);
      marker = `\n...[${ omitted } terminal output chars omitted from the live UI]...\n`;
      tailChars = Math.max(0, maxChars - headChars - marker.length);
    }
    return `${ value.slice(0, headChars) }${ marker }${ value.slice(-tailChars) }`;
  };
  const mergeConsoleOutputTrace = (existing: any, incoming: any) => {
    const previousText = getConsoleOutputText(existing);
    const incomingText = getConsoleOutputText(incoming);
    const previousEnd = Number(existing?.outputEnd);
    const incomingEnd = Number(incoming?.outputEnd);
    const isStaleDelta = incoming?.isDelta === true
      && Number.isFinite(previousEnd)
      && Number.isFinite(incomingEnd)
      && incomingEnd <= previousEnd;
    let mergedOutput: string;

    if (incoming?.isDelta === true) {
      const incomingStart = Number(incoming?.outputStart);
      if (Number.isFinite(previousEnd) && Number.isFinite(incomingStart) && Number.isFinite(incomingEnd)) {
        if (incomingEnd <= previousEnd) {
          mergedOutput = previousText;
        } else {
          const overlap = Math.max(0, previousEnd - incomingStart);
          const gap = incomingStart > previousEnd
            ? `\n...[${ incomingStart - previousEnd } terminal output chars missed during reconnect]...\n`
            : '';
          mergedOutput = `${ previousText }${ gap }${ incomingText.slice(overlap) }`;
        }
      } else {
        mergedOutput = mergeStreamingText(previousText, incomingText, true);
      }
    } else {
      const compactFinalMatchesCurrentStream = incoming?._contentStripped === true
        && Number.isFinite(previousEnd)
        && Number.isFinite(incomingEnd)
        && previousEnd === incomingEnd
        && previousText.length > incomingText.length;
      mergedOutput = compactFinalMatchesCurrentStream
        ? previousText
        : mergeStreamingText(previousText, incomingText, false);
    }

    return {
      ...existing,
      ...incoming,
      output: compactLiveConsoleOutput(mergedOutput),
      content: undefined,
      outputPreview: undefined,
      outputStart: existing?.outputStart ?? incoming?.outputStart,
      outputEnd: Math.max(Number(existing?.outputEnd || 0), Number(incoming?.outputEnd || 0)) || incoming?.outputEnd,
      isStreaming: isStaleDelta ? existing?.isStreaming : incoming?.isStreaming ?? existing?.isStreaming,
      isDelta: isStaleDelta ? existing?.isDelta : incoming?.isDelta ?? existing?.isDelta,
      status: isStaleDelta ? existing?.status : incoming?.status ?? existing?.status,
      exitCode: isStaleDelta ? existing?.exitCode : incoming?.exitCode ?? existing?.exitCode,
      durationMs: isStaleDelta ? existing?.durationMs : incoming?.durationMs ?? existing?.durationMs,
    };
  };
  const compactConsoleLogForStorage = (log: any) => {
    if (log?.type !== 'console_output') return log;
    const output = getConsoleOutputText(log);
    const wasCompacted = output.length > 120_000;
    const compactOutput = compactLiveConsoleOutput(output, 120_000);
    return {
      ...log,
      output: compactOutput,
      content: undefined,
      outputPreview: undefined,
      _contentStripped: log?._contentStripped === true || wasCompacted,
    };
  };
  const findMergeableConsoleOutputIndex = (logs: any[], trace: any) => {
    const streamId = String(trace?.streamId || '');
    const taskId = String(trace?.taskId || trace?.backgroundTaskId || '');
    const ownerTraceId = String(trace?.ownerTraceId || '');
    if (!streamId && !taskId && !ownerTraceId) return -1;
    for (let i = logs.length - 1; i >= 0; i -= 1) {
      const log = logs[i];
      if (log?.type === 'user_action') break;
      if (log?.type !== 'console_output') continue;
      const sameStream = streamId && String(log.streamId || '') === streamId;
      const sameTask = taskId && String(log.taskId || log.backgroundTaskId || '') === taskId;
      const sameOwner = ownerTraceId && String(log.ownerTraceId || '') === ownerTraceId && String(log.command || '') === String(trace.command || '');
      if (sameStream || sameTask || sameOwner) return i;
    }
    return -1;
  };
  const isDuplicateConsoleOutput = (logs: any[], trace: any) => {
    const traceText = getConsoleOutputText(trace);
    const traceStreamId = String(trace?.streamId || '');
    const traceTaskId = String(trace?.taskId || trace?.backgroundTaskId || '');
    return logs.some((log: any) =>
      log?.type === 'console_output' &&
      (
        (traceStreamId && String(log.streamId || '') === traceStreamId) ||
        (!traceStreamId && traceTaskId && String(log.taskId || log.backgroundTaskId || '') === traceTaskId) ||
        (!traceStreamId && !traceTaskId && log.command === trace.command)
      ) &&
      getConsoleOutputText(log) === traceText
    );
  };
  const stripChatsForStorage = (chatList: ChatSession[]) =>
    chatList.map(chat => ({
      ...chat,
      traceLogs: canonicalizeClientTraceLogs(
        (chat.traceLogs || [])
          .filter(log => {
            const owners = [log?.chatId, log?.ownerChatId]
              .map(value => String(value || '').trim())
              .filter(Boolean);
            return owners.length === 0 || owners.includes(chat.id);
          })
          .map(compactConsoleLogForStorage),
        chat.id,
      ),
    }));
  const persistChats = async (chatList: ChatSession[], keepalive = false, forceFull = false): Promise<boolean> => {
    const persistenceSignature = (chat: ChatSession) => {
      const cached = chatObjectSignaturesRef.current.get(chat);
      if (cached) return cached;
      const serialized = JSON.stringify(chat);
      let first = 2166136261;
      let second = 2246822519;
      for (let index = 0; index < serialized.length; index += 1) {
        const code = serialized.charCodeAt(index);
        first = Math.imul(first ^ code, 16777619);
        second = Math.imul(second ^ code, 3266489917);
      }
      const signature = `${serialized.length}:${first >>> 0}:${second >>> 0}`;
      chatObjectSignaturesRef.current.set(chat, signature);
      return signature;
    };
    const nextSignatures = new Map(chatList.map(chat => [chat.id, persistenceSignature(chat)]));
    const previousSignatures = persistedChatSignaturesRef.current;
    const changedChats = chatList.filter(chat => previousSignatures.get(chat.id) !== nextSignatures.get(chat.id));
    const hasDeletion = Array.from(previousSignatures.keys()).some(id => !nextSignatures.has(id));
    // Never report a successful flush before the authoritative AppData
    // snapshot has been restored. This matters when the app is closed during
    // the first render and a new chat was created before the GET completed.
    if (!chatSnapshotReadyRef.current) return false;
    if (!forceFull && changedChats.length === 0 && !hasDeletion) return true;

    const stripped = stripChatsForStorage(forceFull ? chatList : changedChats);
    const chatIds = chatList.map(chat => chat.id);
    const chatIdSet = new Set(chatIds);
    const deletedChatIds = Array.from(pendingChatDeletionIdsRef.current)
      .filter(chatId => !chatIdSet.has(chatId));
    const savedAt = Math.max(Date.now(), lastChatSnapshotAtRef.current + 1);
    lastChatSnapshotAtRef.current = savedAt;
    const mutationId = crypto.randomUUID();
    // State updaters can schedule several writes in one turn. Serialize
    // filesystem writes so an older request cannot finish after a newer one
    // and erase a freshly-created chat.
    const write = async () => {
      const body = JSON.stringify({
        savedAt,
        mutationId,
        chats: stripped,
        chatIds,
        partial: true,
        deletedChatIds,
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await fetch('/api/chats', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive,
        }).catch(() => null);
        const payload = response ? await response.json().catch(() => ({})) : {};
        const durableSavedAt = Number(payload?.savedAt);
        const saved = Boolean(response?.ok) && payload?.applied !== false
          && Number.isFinite(durableSavedAt) && durableSavedAt >= savedAt;
        if (saved) {
          lastChatSnapshotAtRef.current = Math.max(lastChatSnapshotAtRef.current, durableSavedAt);
          persistedChatSignaturesRef.current = nextSignatures;
          deletedChatIds.forEach(chatId => pendingChatDeletionIdsRef.current.delete(chatId));
          notifyDurableChatSync(durableSavedAt);
          window.dispatchEvent(new CustomEvent('eterx_chats_updated', { detail: { savedAt: durableSavedAt, durable: true } }));
          return true;
        }
        if (attempt < 2) await new Promise(resolve => window.setTimeout(resolve, 250 * (attempt + 1)));
      }
      return false;
    };
    const queuedWrite = durableChatWriteChainRef.current.then(write, write);
    durableChatWriteChainRef.current = queuedWrite.then(() => undefined, () => undefined);
    return queuedWrite;
  };
  useEffect(() => {
    const flushChatSnapshot = () => {
      if (durableSnapshotTimerRef.current) {
        clearTimeout(durableSnapshotTimerRef.current);
        durableSnapshotTimerRef.current = null;
      }
      pendingDurableSnapshotWrite.current = false;
      const flushedChats = flushBackgroundChatUpdates();
      void persistChats(flushedChats, true, true);
      void flushAppStorage();
      void flushScheduledTaskWrites();
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
    const senderSubAgentChatId = message?.subAgentChatId || message?.metadata?.subAgentChatId;
    const senderSubAgentId = message?.subAgentId || message?.metadata?.subAgentId;
    const recipientSubAgentChatId = message?.recipientSubAgentChatId || message?.metadata?.recipientSubAgentChatId;
    const recipientAgentId = message?.recipientAgentId || message?.metadata?.recipientAgentId;
    const explicitIdentity = String(subAgentIdentity || '').trim();
    const resolvedSubAgentChatId = explicitIdentity.includes('::sub-agent::')
      ? explicitIdentity
      : recipientSubAgentChatId || senderSubAgentChatId;
    const resolvedSubAgentId = recipientAgentId || senderSubAgentId ||
      (explicitIdentity && !explicitIdentity.includes('::sub-agent::') ? explicitIdentity : undefined);
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
      senderSubAgentId,
      senderSubAgentChatId,
      recipientAgentId,
      recipientSubAgentChatId,
      broadcastRecipientRuns: message?.broadcastRecipientRuns || message?.metadata?.broadcastRecipientRuns,
      broadcast: message?.broadcast === true || message?.metadata?.broadcast === true || message?.to === '*',
      optimistic: message?.optimistic === true,
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
    const currentRunningChats = new Set(runningChatsRef.current);
    currentRunningChats.delete(chatId);
    runningChatsRef.current = currentRunningChats;
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
    queueBackgroundChatUpdate(
      chatId,
      previousLogs => canonicalizeClientTraceLogs(
        typeof nextLogsOrUpdater === 'function'
          ? nextLogsOrUpdater(previousLogs)
          : nextLogsOrUpdater,
        chatId,
      ),
      options.touchUpdatedAt === true,
    );
  };

  const clearAgentConnectionStatus = (chatId: string) => {
    setChatLogsById(chatId, logs => stripAgentConnectionLogs(logs));
  };

  const hydrateChatHistory = (chatId: string) => {
    if (hydratedChatIdsRef.current.has(chatId)) return;
    if (chatDetailRequestsRef.current.has(chatId)) return;

    const detailRequest = fetch(`/api/chats?id=${ encodeURIComponent(chatId) }`, { cache: 'no-store' })
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
          const merged = mergeCachedChatIntoDurable(hydratedChat, currentChat);
          return enforceChatTraceOwnership({
            ...merged,
            traceLogs: canonicalizeClientTraceLogs(merged.traceLogs || [], chatId),
          });
        }));

        if (activeChatIdRef.current === chatId) {
          setTraceLogs(currentLogs => {
            if (activeChatIdRef.current !== chatId) return currentLogs;
            const merged = mergeCachedChatIntoDurable(
              hydratedChat,
              { ...hydratedChat, traceLogs: currentLogs }
            );
            return canonicalizeClientTraceLogs(merged.traceLogs || [], chatId);
          });
          setActiveWorkspacePath(hydratedChat.workspacePath || null);
        }
      })
      .catch(() => {
        // A later open retries because the folder-backed detail was not marked
        // hydrated.
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
      let touchUpdatedAt = false;
      for (const update of queuedUpdates) {
        latestLogs = update.apply(latestLogs);
        touchUpdatedAt ||= update.touchUpdatedAt;
      }
      chat = { ...chat, traceLogs: latestLogs, ...(touchUpdatedAt ? { updatedAt: Date.now() } : {}) };
      backgroundChatUpdatesRef.current.delete(id);
      setChats(current => {
        const updated = current.map(item => item.id === id ? chat! : item);
        return touchUpdatedAt ? sortChats(updated) : updated;
      });
    }

    if (chat) {
      // Sub-agent tabs are scoped to a chat/turn, never globally across chats.
      setActiveSubAgentTab(null);
      setSubAgentDockOpen(false);
      setOverflowDropdownOpen(false);
      activeChatIdRef.current = id;
      setActiveChatId(id);
      setTraceLogs(canonicalizeClientTraceLogs(chat.traceLogs || [], id));
      hydrateChatHistory(id);
      setActiveWorkspacePath(chat.workspacePath || null);
      const storedState = composerStatesRef.current[id];
      applyComposerState(storedState || (chat.runLocation ? {
        inputValue: '',
        runLocation: chat.runLocation,
        selectedAgent: { ...GENERAL_AGENT_SELECTION },
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
        setBuildingAgentName(null);
      } else {
        // If it IS a builder chat, extract the agentId from the chatId
        const agentId = id.replace('agent_builder_', '');
        setBuildingAgentId(agentId);
        const builderChat = chatsRef.current.find(chat => chat.id === id);
        const titleMatch = builderChat?.title?.match(/^Building Agent:\s*(.+)$/);
        setBuildingAgentName(titleMatch?.[1]?.trim() || null);
      }

      // ALL pollers run at the same speed — no restart needed on chat switch.
      // Just check if this chat has an active agent that isn't being polled yet.
      if (activePollersRef.current.has(id)) {
        // Already polling — the poller itself manages runningChats lifecycle.
        // Do NOT blindly re-add here; it creates a race with removeRunningChat.
      } else {
        // No poller — check server for a running agent
        const observedPollGeneration = pollGenerationRef.current.get(id) || 0;
        fetchAgentPoll(id, -1, 5000)
          .then(data => {
            const currentChat = chatsRef.current.find(candidate => candidate.id === id);
            if (!currentChat) return;
            reconcileServerQueuedFollowUps(id, data.queuedFollowUps);
            if (
              activePollersRef.current.has(id) ||
              (pollGenerationRef.current.get(id) || 0) !== observedPollGeneration
            ) return;

            if (data.status === 'running') {
              // Agent is running! Merge server traces into the current turn.
              if (data.traces && data.traces.length > 0) {
                if (activeChatIdRef.current === id) {
                  setTraceLogs(previousLogs =>
                    activeChatIdRef.current === id
                        ? mergeServerRunLogs(previousLogs, data.traces, {
                          chatId: id,
                          runId: data.runId,
                          startedAt: data.startedAt,
                        })
                      : previousLogs
                  );
                }
                setChats(prev => {
                  const updated = prev.map(c => c.id === id
                    ? {
                        ...c,
                        traceLogs: mergeServerRunLogs(c.traceLogs || [], data.traces, {
                          chatId: id,
                          runId: data.runId,
                          startedAt: data.startedAt,
                        }),
                      }
                    : c);
                  persistChats(updated);
                  return updated;
                });
              }
              setRunningChats(prev => new Set(prev).add(id));
              startPolling(id, getPollCursor(data), data.startedAt, data.runId);
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

  const handleOpenAgentBuilder = (id: string = '', displayName?: string) => {
    const requestedId = String(id || '').trim();
    const builderId = requestedId || `eterxagent-live-${Date.now()}`;
    let resolvedName = String(displayName || '').trim();

    setBuildingAgentId(builderId);
    setBuildingAgentName(resolvedName || null);
    setActiveView('chat');
    setActiveSubAgentTab(null);
    setSubAgentDockOpen(false);
    setOverflowDropdownOpen(false);
    const builderChatId = `agent_builder_${ builderId }`;
    let chat = chatsRef.current.find(c => c.id === builderChatId);
    if (!chat) {
      chat = {
        id: builderChatId,
        title: `Building Agent: ${ resolvedName || builderId }`,
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
      if (resolvedName && chat.title !== resolvedName && chat.title !== `Building Agent: ${ resolvedName }`) {
        const nextTitle = `Building Agent: ${ resolvedName }`;
        setChats(previous => {
          const updated = previous.map(item => item.id === builderChatId ? { ...item, title: nextTitle, updatedAt: Date.now() } : item);
          chatsRef.current = updated;
          persistChats(updated);
          return updated;
        });
      }
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
    setBuildingAgentName(null);
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
    activeChatIdRef.current = null;
    setActiveChatId(null);
    setMonitorOpen(false);
    setTraceLogs([]);
    const storedState = composerStatesRef.current['new_chat'];
    const hasSavedDraft = Boolean(storedState?.inputValue?.trim() || storedState?.attachments?.length);
    if (storedState && !hasSavedDraft) {
      const defaultModelSelection = readRuntimeChatModelSelection();
      const refreshedState: ChatComposerState = {
        ...storedState,
        // Agent identity is chat-scoped. New chat begins on General unless it
        // contains an actual saved draft whose intended runtime must survive.
        selectedAgent: { ...GENERAL_AGENT_SELECTION },
        chatModelSelection: defaultModelSelection,
        agentMode: readRuntimeAgentMode(storedState.agentMode || 'think', defaultModelSelection),
      };
      applyComposerState(refreshedState);
      updateComposerState(() => refreshedState);
    } else if (storedState && hasSavedDraft) {
      applyComposerState(storedState);
    } else {
      applyComposerState({
        inputValue: '',
        runLocation: 'local',
        selectedAgent: { ...GENERAL_AGENT_SELECTION },
        agentMode: readRuntimeAgentMode('think'),
        thinkingLevel: composerRuntimeSelectionRef.current.thinkingLevel,
        attachments: [],
        pinnedItems: [],
        chatModelSelection: readRuntimeChatModelSelection(),
      });
    }
    setBuildingAgentId(null);
    setBuildingAgentName(null);
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
    setQueuedFollowUps(previous => {
      for (const message of previous) {
        if (!deleteSet.has(message.chatId)) continue;
        queuedFollowUpDispatchRef.current.delete(message.id);
        if (message.admissionKey) {
          queuedFollowUpAdmissionsRef.current.delete(message.admissionKey);
          queuedFollowUpIdsRef.current.delete(message.admissionKey);
        }
      }
      return previous.filter(message => !deleteSet.has(message.chatId));
    });
    idsToDelete.forEach(chatId => pendingChatDeletionIdsRef.current.add(chatId));
    if (liveChatIdRef.current && deleteSet.has(liveChatIdRef.current)) {
      stopLiveSession();
    }
    const deletingActiveChat = !!activeChatId && deleteSet.has(activeChatId);
    if (deletingActiveChat) activeChatIdRef.current = null;

    if (durableSnapshotTimerRef.current) {
      clearTimeout(durableSnapshotTimerRef.current);
      durableSnapshotTimerRef.current = null;
    }
    pendingDurableSnapshotWrite.current = false;

    idsToDelete.forEach(chatId => {
      pendingTitleRequestsRef.current.delete(chatId);
      const timeoutId = pollingIntervalsRef.current.get(chatId);
      if (timeoutId) clearTimeout(timeoutId);
      pollingIntervalsRef.current.delete(chatId);
      activePollersRef.current.delete(chatId);
      pollCursorsRef.current.delete(chatId);
      pollRunStartRef.current.delete(chatId);
      pollRunIdRef.current.delete(chatId);
      pollGenerationRef.current.set(chatId, (pollGenerationRef.current.get(chatId) || 0) + 1);
      catchUpPollersRef.current.delete(chatId);
      pollAbortControllersRef.current.get(chatId)?.abort();
      pollAbortControllersRef.current.delete(chatId);
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
    idsToDelete.forEach(chatId => {
      handledUnreadEventsRef.current.delete(chatId);
      handledTerminalAnnouncementsRef.current.delete(chatId);
      appStorage.removeItem(`eterx_proxy_controls_${chatId}`);
      appStorage.removeItem(`eterx_proxy_manager_model_${chatId}`);
      appStorage.removeItem(`eterx_proxy_runtime_model_${chatId}`);
      appStorage.removeItem(`eterx_live_mem_${chatId}`);
    });

    setComposerStates(previous => {
      const next = { ...previous };
      idsToDelete.forEach(chatId => delete next[chatId]);
      appStorage.setItem('eterx_chat_composer_states', JSON.stringify(next));
      return next;
    });
    try {
      const goals = JSON.parse(appStorage.getItem('eterx_chat_goals') || '{}');
      if (goals && typeof goals === 'object' && !Array.isArray(goals)) {
        idsToDelete.forEach(chatId => delete goals[chatId]);
        appStorage.setItem('eterx_chat_goals', JSON.stringify(goals));
      }
    } catch { }

    setChats(prev => {
      const updated = prev.filter(c => !deleteSet.has(c.id));
      persistChats(updated, false, true);
      return updated;
    });

    if (deletingActiveChat) {
      setActiveChatId(null);
      setActiveWorkspacePath(null);
      setTraceLogs([]);
      setBuildingAgentId(null);
      setBuildingAgentName(null);
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

  const fetchGeneratedTitle = async (
    history: any[],
    currentTitle?: string,
    mode: MainAgentMode = agentMode,
    selectedModel?: ModelSelectorEntry,
  ): Promise<{ title: string; provider?: string; model?: string; usage?: Record<string, number> } | null> => {
    const res = await fetch('/api/chat/title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        history,
        currentTitle: currentTitle || DEFAULT_CHAT_TITLE,
        mode,
        selectedModel: selectedModel || null,
      })
    });

    if (!res.ok) return null;

    const data = await res.json();
    const title = String(data.title || '').trim();
    return title && !isDefaultChatTitle(title) ? { ...data, title } : null;
  };

  const generateTitle = async (
    chatId: string,
    history: any[],
    currentTitle?: string,
    mode: MainAgentMode = agentMode,
    selectedModel?: ModelSelectorEntry,
  ) => {
    try {
      // Use passed title or fall back to finding in current state (for background updates)
      const existingTitle = currentTitle || chats.find(c => c.id === chatId)?.title || DEFAULT_CHAT_TITLE;

      const generated = await fetchGeneratedTitle(history, existingTitle, mode, selectedModel);
      if (generated) {
        setChats(prev => {
          const updated = prev.map(c => {
            if (c.id !== chatId) return c;
            const totalTokens = Number(generated.usage?.totalTokens || 0);
            const latestUser = [...(c.traceLogs || [])].reverse().find((log: any) => log?.type === 'user_action');
            const usageLog = totalTokens > 0 ? {
              type: 'model_usage',
              usageId: `usage_title_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
              source: 'provider',
              provider: generated.provider,
              model: generated.model,
              ...(generated.usage || {}),
              phase: 'chat_title',
              runId: latestUser?.runId || latestUser?.turnId,
              turnId: latestUser?.turnId || latestUser?.runId,
              timestamp: Date.now(),
            } : null;
            return {
              ...c,
              title: generated.title !== existingTitle ? generated.title : c.title,
              updatedAt: Date.now(),
              traceLogs: usageLog ? [...(c.traceLogs || []), usageLog] : c.traceLogs,
            };
          });
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

  const getPollCursor = (data: any): number => {
    const maxIndex = Number(data?.maxIndex);
    if (Number.isFinite(maxIndex) && maxIndex >= -1) return Math.floor(maxIndex);
    const totalTraces = Number(data?.totalTraces);
    if (Number.isFinite(totalTraces) && totalTraces > 0) return Math.floor(totalTraces) - 1;
    return -1;
  };

  const fetchAgentPoll = async (
    chatId: string,
    after: number,
    timeoutMs = 8000,
    externalSignal?: AbortSignal,
  ) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    const forwardAbort = () => controller.abort();
    if (externalSignal?.aborted) {
      controller.abort();
    } else {
      externalSignal?.addEventListener('abort', forwardAbort, { once: true });
    }
    let releasePollSlot: (() => void) | null = null;
    try {
      // Gate every poll request, including reconnect/recovery probes. This
      // keeps startup and visibility bursts from bypassing the live poller
      // capacity limit.
      releasePollSlot = await pollingGateRef.current!.acquire(controller.signal);
      const res = await fetch(`/api/agent/poll?chatId=${ encodeURIComponent(chatId) }&after=${ after }&wait=1200`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Poll HTTP ${ res.status }`);
      const payload = await res.json();
      if (
        !payload ||
        typeof payload !== 'object' ||
        typeof payload.status !== 'string' ||
        !LIVE_POLL_STATUSES.has(payload.status) ||
        !Array.isArray(payload.traces)
      ) {
        throw new Error('Poll returned an invalid trace payload.');
      }
      return {
        ...payload,
        status: payload.status as 'idle' | 'running' | 'completed' | 'failed' | 'stopped',
        maxIndex: Number.isFinite(Number(payload.maxIndex)) ? Math.floor(Number(payload.maxIndex)) : -1,
        totalTraces: Number.isFinite(Number(payload.totalTraces)) ? Math.max(0, Math.floor(Number(payload.totalTraces))) : 0,
        traces: payload.traces.filter((trace: any) => trace && typeof trace === 'object'),
      };
    } finally {
      releasePollSlot?.();
      window.clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', forwardAbort);
    }
  };

  const runPendingTitleGeneration = async (chatId: string) => {
    const pendingTitle = pendingTitleRequestsRef.current.get(chatId);
    if (!pendingTitle) return;
    pendingTitleRequestsRef.current.delete(chatId);
    await generateTitle(
      chatId,
      pendingTitle.history,
      pendingTitle.currentTitle,
      pendingTitle.mode,
      pendingTitle.selectedModel,
    );
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
    const localText = getVisibleUserActionText(localLog).replace(/\r\n/g, '\n').trim();
    const incomingText = getVisibleUserActionText(incomingLog).replace(/\r\n/g, '\n').trim();
    if (!localText || localText !== incomingText) return false;
    const localSource = String(localLog.source || 'human').trim().toLowerCase();
    const incomingSource = String(incomingLog.source || 'human').trim().toLowerCase();
    return localSource === incomingSource;
  };

  const processServerTraces = (
    traces: any[],
    existingLogs: any[] = [],
    ownerChatId?: string,
  ): any[] => {
    const baseLogs = Array.isArray(existingLogs) ? existingLogs : [];
    const logs: any[] = canonicalizeThoughtStreamLogs(
      normalizeBuilderUserActionLogs(baseLogs),
    );
    const lastUserIdx = logs.reduceRight((found, l, i) => found === -1 && l.type === 'user_action' ? i : found, -1);
    const incomingRunId = String(
      traces.find((trace: any) => trace?.runId || trace?.turnId)?.runId ||
      traces.find((trace: any) => trace?.runId || trace?.turnId)?.turnId ||
      ''
    ).trim();
    let currentTurnStart = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
    let currentTurnId = String(
      (lastUserIdx >= 0 ? logs[lastUserIdx]?.turnId || logs[lastUserIdx]?.runId : incomingRunId) || ''
    ).trim();
    // Proxy guidance creates another visible user boundary inside the same
    // server run. Trace indices remain run-scoped, so catch-up snapshots must
    // deduplicate against the whole run rather than only the latest bubble.
    const dedupScope = incomingRunId
      ? logs.filter((log: any) => String(log?.runId || log?.turnId || '').trim() === incomingRunId)
      : lastUserIdx >= 0 ? logs.slice(lastUserIdx) : logs;
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

      const traceTurnId = String(
        trace?.type === 'user_action'
          ? trace?.turnId || trace?.id || trace?.runId || currentTurnId || incomingRunId
      : trace?.turnId || trace?.runId || currentTurnId || incomingRunId || ''
      ).trim();
      let processedLog = withTraceTiming({
        ...trace,
        ...(ownerChatId ? { ownerChatId } : {}),
        ...(trace?.type === 'user_action' ? { text: getVisibleUserActionText(trace) } : {}),
        ...(traceTurnId ? { turnId: traceTurnId } : {}),
      });
      if (isPrivateReasoningTrace(processedLog)) continue;
      if (processedLog.type === 'inter_agent_message' && processedLog.messageId) {
        const existingMessageIndex = logs.findIndex((log: any) =>
          log?.type === 'inter_agent_message' && log?.messageId === processedLog.messageId
        );
        if (existingMessageIndex >= 0) {
          const existingMessage = logs[existingMessageIndex];
          logs[existingMessageIndex] = {
            ...existingMessage,
            ...processedLog,
            agentName: existingMessage.agentName || processedLog.agentName,
            subAgent: existingMessage.subAgent || processedLog.subAgent,
            subAgentId: existingMessage.subAgentId || processedLog.subAgentId,
            subAgentChatId: existingMessage.subAgentChatId || processedLog.subAgentChatId,
          };
          continue;
        }
      }
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
            ...optimisticUserLog,
            ...processedLog,
            attachments: processedLog.attachments || optimisticUserLog.attachments,
            selectedAgentId: processedLog.selectedAgentId || optimisticUserLog.selectedAgentId,
            selectedAgentName: processedLog.selectedAgentName || optimisticUserLog.selectedAgentName,
            chatMode: processedLog.chatMode ?? optimisticUserLog.chatMode,
            id: processedLog.id || optimisticUserLog.id,
            source: processedLog.source || optimisticUserLog.source,
            delegatedBy: processedLog.delegatedBy || optimisticUserLog.delegatedBy,
            _traceIdx: processedLog._traceIdx,
          };
          currentTurnStart = existingUserIdx + 1;
          currentTurnId = String(
            logs[existingUserIdx]?.turnId || logs[existingUserIdx]?.runId || currentTurnId
          ).trim();
          continue;
        }
      }

      // The polled payload is authoritative for liveness. Carrying a local
      // optimistic isLive marker onto the settled server event leaves a ghost
      // action in the live-only lane after the command has completed.

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
            // A delayed cancellation belongs only to an open placeholder. It
            // must never hide the settled note that already replaced it.
            if (!isOpenWorkNoteTrace(logs[i])) {
              if (noteId && logs[i].noteId === noteId) break;
              continue;
            }
            logs[i] = {
              ...logs[i],
              _streamingCancelled: true,
              _cancelTraceIdx: trace._traceIdx,
              _cancelledAt: processedLog.timestamp,
            };
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
        // Work notes are settled by default. Only an explicitly open stream
        // may keep mutating; many provider adapters emit a one-shot note with
        // no streaming flags at all.
        const incomingIsFinal = !isOpenWorkNoteTrace({ ...trace, type: 'work_note' });
        const noteText = formatVisibleWorkNote(String(trace.text || ''));
        if (!noteText) continue;
        let mergeIdx = -1;
        let ignoreCancelledUpdate = false;
        let crossedPhaseBoundary = false;
        for (let i = logs.length - 1; i >= 0; i--) {
          if (logs[i].type === 'user_action') break;
          if (WORK_NOTE_PHASE_BOUNDARY_TYPES.has(String(logs[i].type || ''))) {
            crossedPhaseBoundary = true;
            continue;
          }
          if (
            logs[i].type === 'work_note' &&
            (logs[i].subAgentChatId || logs[i].subAgentId || logs[i].subAgent || null) === subAgentIdentity
          ) {
            const existingText = String(logs[i].text || '').trim();
            if (noteId && logs[i].noteId && logs[i].noteId === noteId) {
              if (logs[i]._streamingCancelled && !incomingIsFinal) {
                ignoreCancelledUpdate = true;
                break;
              }
              mergeIdx = i;
              break;
            }
            const cancellationTraceIdx = Number(logs[i]._cancelTraceIdx);
            const incomingTraceIdx = Number(trace._traceIdx);
            const cancelledAt = Number(logs[i]._cancelledAt || logs[i].endTime || logs[i].timestamp || 0);
            const incomingAt = Number(processedLog.startTime || processedLog.timestamp || 0);
            const orderedCancellation =
              !Number.isFinite(cancellationTraceIdx) ||
              !Number.isFinite(incomingTraceIdx) ||
              incomingTraceIdx >= cancellationTraceIdx;
            const closeInTime = !cancelledAt || !incomingAt || Math.abs(incomingAt - cancelledAt) <= 15_000;
            const isAdjacentCancelledPlaceholder = Boolean(
              logs[i]._streamingCancelled &&
              incomingIsFinal &&
              !crossedPhaseBoundary &&
              i === logs.length - 1 &&
              orderedCancellation &&
              closeInTime
            );
            if (isAdjacentCancelledPlaceholder) {
              mergeIdx = i;
              break;
            }
            if (existingText === noteText) {
              if (!crossedPhaseBoundary && incomingIsFinal && isOpenWorkNoteTrace(logs[i])) {
                mergeIdx = i;
              }
              break;
            }
            if (
              !crossedPhaseBoundary &&
              (!noteId || !logs[i].noteId) &&
              isOpenWorkNoteTrace(logs[i])
            ) {
              mergeIdx = i;
              break;
            }
          }
        }
        if (ignoreCancelledUpdate) continue;
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
            text: incomingIsFinal && trace.isDelta !== true
              ? noteText
              : mergeStreamingText(logs[mergeIdx].text, noteText, trace.isDelta === true),
            subAgent: subAgent ?? logs[mergeIdx].subAgent ?? null,
            noteId: noteId || logs[mergeIdx].noteId || null,
            _traceIdx: stableWorkNoteTraceIndex(logs[mergeIdx]._traceIdx, trace._traceIdx),
            timestamp: Math.max(Number(logs[mergeIdx].timestamp || 0), traceAt),
            startTime: logs[mergeIdx].startTime || processedLog.startTime,
            endTime: Math.max(Number(logs[mergeIdx].endTime || 0), traceAt),
            _streamingCancelled: undefined,
            _cancelTraceIdx: undefined,
            _cancelledAt: undefined,
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
      } else if (trace.type === 'model_usage') {
        // Chat-mode streams provider-measured usage through this same merge
        // path. Keep one record per usage id so a late stream boundary cannot
        // hide the token count from the feed summary.
        const usageId = String(trace.usageId || '').trim();
        const existingUsageIdx = usageId
          ? logs.findIndex((log: any) => log?.type === 'model_usage' && String(log.usageId || '').trim() === usageId)
          : -1;
        if (existingUsageIdx >= 0) {
          logs[existingUsageIdx] = { ...logs[existingUsageIdx], ...processedLog };
        } else {
          logs.push(processedLog);
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
          const incomingIsStreaming =
            trace.isStreaming === true ||
            trace.isLiveTyping === true ||
            trace.isDelta === true ||
            trace.streamState === 'open';
          logs[answerIdx] = {
            ...logs[answerIdx],
            ...processedLog,
            text: mergeStreamingText(logs[answerIdx].text, trace.text, trace.isDelta === true),
            _traceIdx: trace._traceIdx ?? logs[answerIdx]._traceIdx,
            isLive: processedLog.isLive,
            isStreaming: incomingIsStreaming,
            isLiveTyping: incomingIsStreaming,
            startTime: logs[answerIdx].startTime || processedLog.startTime,
            endTime: Math.max(Number(logs[answerIdx].endTime || 0), traceAt),
            timestamp: Math.max(Number(logs[answerIdx].timestamp || 0), traceAt),
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
            ...mergeConsoleOutputTrace(logs[mergeIdx], processedLog),
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
        logs.push({
          ...processedLog,
          type: 'thought_stream',
          text: `Error: ${ trace.data || trace.text || 'Unknown error' }`,
          _traceIdx: trace._traceIdx,
          timestamp: traceAt,
          startTime: traceAt,
          endTime: traceAt,
        });
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

      if (processedLog.type === 'user_action') {
        const boundaryIndex = logs.findLastIndex((log: any) => log?.type === 'user_action');
        currentTurnStart = boundaryIndex >= 0 ? boundaryIndex + 1 : 0;
        currentTurnId = String(processedLog.turnId || processedLog.runId || currentTurnId).trim();
      }
    }
    return orderFeedTimelineLogs(canonicalizeThoughtStreamLogs(logs));
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
    runIdentity: { chatId?: string; runId?: string; startedAt?: number } = {}
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
          ...(incomingRunId && !String(trace?.runId || '').trim() ? { runId: incomingRunId } : {}),
          ...(incomingRunId && !String(trace?.turnId || '').trim() ? { turnId: incomingRunId } : {}),
        }));
        if (alreadyPresent) {
          return processServerTraces(successorTraces, existingLogs, runIdentity.chatId);
        }
        return [
          ...(Array.isArray(existingLogs) ? existingLogs : []),
          ...processServerTraces(successorTraces, [], runIdentity.chatId),
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
      ...(runIdentity.chatId ? { ownerChatId: runIdentity.chatId } : {}),
      ...(runIdentity.runId && !String(trace?.runId || '').trim() ? { runId: runIdentity.runId } : {}),
      ...(turnId && !String(trace?.turnId || '').trim() ? { turnId } : {}),
    }));
    return processServerTraces(ownedTraces, existingLogs, runIdentity.chatId);
  };

  // Debounced folder snapshot writer — prevents rapid concurrent writes.
  const debouncedSaveToFolder = () => {
    pendingDurableSnapshotWrite.current = true;
    if (durableSnapshotTimerRef.current) return; // Already scheduled
    durableSnapshotTimerRef.current = setTimeout(() => {
      durableSnapshotTimerRef.current = null;
      if (pendingDurableSnapshotWrite.current) {
        pendingDurableSnapshotWrite.current = false;
        // Read current chats state and write to the folder-backed store.
        setChats(currentChats => {
          persistChats(currentChats);
          return currentChats; // Don't modify state
        });
        if (pendingChatRestoreRevisionRef.current > lastChatSnapshotAtRef.current) {
          // A second window may have committed while this local debounce was
          // protecting an in-flight trace write. Reconcile it after the local
          // write has been queued so the remote revision is not stranded in
          // the pending marker.
          window.setTimeout(() => requestChatRestoreRef.current?.(), 0);
        }
      }
    }, 4000); // Durable task traces save every 500ms; snapshot the heavy UI state less often.
  };

  const flushBackgroundChatUpdates = (): ChatSession[] => {
    if (backgroundUpdateTimerRef.current !== null) {
      window.clearTimeout(backgroundUpdateTimerRef.current);
      backgroundUpdateTimerRef.current = null;
    }
    if (backgroundChatUpdatesRef.current.size === 0) return chatsRef.current;
    const pending = new Map(backgroundChatUpdatesRef.current);
    backgroundChatUpdatesRef.current.clear();
    const currentChats = chatsRef.current;
    let changed = false;
    let shouldSort = false;
    let visibleChatLogs: any[] | null = null;
    const updated = currentChats.map(chat => {
      const updaters = pending.get(chat.id);
      if (!updaters?.length) return chat;
      let logs = chat.traceLogs || [];
      let touchUpdatedAt = false;
      for (const update of updaters) {
        logs = update.apply(logs);
        touchUpdatedAt ||= update.touchUpdatedAt;
      }
      changed = true;
      shouldSort ||= touchUpdatedAt;
      if (activeChatIdRef.current === chat.id) visibleChatLogs = logs;
      return { ...chat, traceLogs: logs, ...(touchUpdatedAt ? { updatedAt: Date.now() } : {}) };
    });
    if (changed) {
      const committed = shouldSort ? sortChats(updated) : updated;
      // Advance authoritative state synchronously. Rendering a potentially
      // large streaming feed is non-urgent, so interaction work (typing,
      // scrolling, resizing and menus) can preempt superseded feed frames.
      chatsRef.current = committed;
      // The active feed is the user's live surface. Commit it immediately so
      // a continuous stream cannot starve it behind superseded transitions.
      // Keep the heavier all-chat state update interruptible.
      if (visibleChatLogs && activeChatIdRef.current) setTraceLogs(visibleChatLogs);
      startTransition(() => {
        setChats(committed);
      });
      debouncedSaveToFolder();
      return committed;
    }
    return currentChats;
  };

  useEffect(() => {
    const desktopApi = (window as any)?.electronAPI;
    if (typeof desktopApi?.onPrepareForQuit !== 'function') return;
    const unregisterDurableFlush = registerDurableFlush(async () => {
      if (!chatSnapshotReadyRef.current) {
        requestChatRestoreRef.current?.();
        const deadline = Date.now() + 10_000;
        while (!chatSnapshotReadyRef.current && Date.now() < deadline) {
          await new Promise(resolve => window.setTimeout(resolve, 200));
        }
      }
      const flushedChats = flushBackgroundChatUpdates();
      // The normal chat write queue already tracks every changed/deleted chat.
      // Do not force a full-history rewrite during an update: a long-lived
      // workspace can contain a very large trace log and make the renderer
      // miss the update flush deadline even when no new data is pending.
      const chatsSaved = await persistChats(flushedChats, false, false);
      const preferencesSaved = await flushAppStorage();
      const scheduledTasksSaved = await flushScheduledTaskWrites();
      return chatsSaved && preferencesSaved && scheduledTasksSaved;
    });
    const unsubscribe = desktopApi.onPrepareForQuit(async () => {
      // Persistence already runs continuously. Give the final coordinated
      // flush a bounded window so a suspended API route or stale renderer can
      // never deadlock a verified desktop update.
      let timeoutId: number | undefined;
      const timeout = new Promise<boolean>(resolve => {
        timeoutId = window.setTimeout(() => resolve(false), 12_000);
      });
      try {
        return await Promise.race([flushDurableState(), timeout]);
      } finally {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      }
    });
    return () => {
      unregisterDurableFlush();
      unsubscribe?.();
    };
  }, []);

  const queueBackgroundChatUpdate = (
    chatId: string,
    updater: (logs: any[]) => any[],
    touchUpdatedAt = false,
  ) => {
    const queued = backgroundChatUpdatesRef.current.get(chatId) || [];
    queued.push({ apply: updater, touchUpdatedAt });
    backgroundChatUpdatesRef.current.set(chatId, queued);
    if (backgroundUpdateTimerRef.current === null) {
      // One short frame keeps adjacent trace events smooth without making the
      // active feed wait for a large burst to finish.
      backgroundUpdateTimerRef.current = window.setTimeout(flushBackgroundChatUpdates, 32);
    }
  };

  useEffect(() => () => {
    if (backgroundUpdateTimerRef.current !== null) window.clearTimeout(backgroundUpdateTimerRef.current);
    backgroundUpdateTimerRef.current = null;
    backgroundChatUpdatesRef.current.clear();
  }, []);

  /**
   * Start incremental polling for a specific chat.
   * Each chat has its own live request loop — fully independent.
   * 
   * DESIGN: ALL chats poll at the SAME full speed. No background slowdown.
   * - The server wakes a long poll immediately when new traces arrive
   * - Short reconnect delay after responses; no high-frequency empty spin
   * - Exponential backoff on network errors (caps at 5s), auto-recovers
   * - Agent runs at full speed whether user is on screen or not
   * - Does NOT stop on 'idle' status (race: agent hasn't started yet)
   * - Does NOT update updatedAt (prevents sidebar reordering chaos)
   * - Debounces folder snapshot writes (prevents data corruption)
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
    if (activePollersRef.current.has(chatId) || pollingIntervalsRef.current.has(chatId) || pollAbortControllersRef.current.has(chatId)) {
      stopPolling(chatId, false);
    }
    const pollGeneration = (pollGenerationRef.current.get(chatId) || 0) + 1;
    pollGenerationRef.current.set(chatId, pollGeneration);
    if (typeof runStartedAfter === 'number') {
      pollRunStartRef.current.set(chatId, runStartedAfter);
    } else {
      pollRunStartRef.current.delete(chatId);
    }
    if (expectedRunId) {
      pollRunIdRef.current.set(chatId, expectedRunId);
    } else {
      pollRunIdRef.current.delete(chatId);
    }
    activePollersRef.current.add(chatId);

    const normalizedInitialCursor = Number.isFinite(Number(initialCursor))
      ? Math.max(-1, Math.floor(Number(initialCursor)))
      : -1;
    pollCursorsRef.current.set(chatId, normalizedInitialCursor);
    let idleCount = 0; // Track consecutive idle responses
    let errorBackoff = 0; // Exponential backoff on errors (0 = no error)
    let lastHadData = false; // Track if last poll had new data
    let pollInFlight = false;
    const pendingStartAt = Date.now();

    const finishDisconnectedStart = (message: string) => {
      stopPolling(chatId);
      clearAgentConnectionStatus(chatId);
      removeRunningChat(chatId);
      markChatUnreadIfBackground(
        chatId,
        `run:${expectedRunId || pollRunIdRef.current.get(chatId) || runStartedAfter || 'pending'}:start-error`,
      );
      setChatLogsById(chatId, logs => [
        ...stripAgentConnectionLogs(logs),
        agentStatusLog('failed', 'Agent unavailable', message)
      ]);
    };

    const handleStartPending = () => {
      idleCount++;
      lastHadData = false;
      // Use wall-clock time rather than response count. A network outage can
      // back off individual requests to five seconds; a response-count limit
      // would otherwise leave a dead startup poller alive for many minutes.
      if (Date.now() - pendingStartAt >= 120_000) {
        finishDisconnectedStart('Agent connection did not start. Please retry this message.');
        return false;
      }
      scheduleNextPoll();
      return true;
    };

    const scheduleNextPoll = () => {
      if (!activePollersRef.current.has(chatId) || pollGenerationRef.current.get(chatId) !== pollGeneration) return;
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
        // Keep every chat near-real-time, including background chats. Only a
        // very large visible feed receives a slightly wider batch window.
        // The request itself waits for new traces, so this delay is only the
        // reconnect yield between long-poll responses. All chats remain live
        // and equally current without a tight HTTP spin loop.
        delay = isLargeActiveChat
          ? (lastHadData ? 48 : 80)
          : (lastHadData ? 20 : 48);
      }

      // A visibility catch-up or a recovery pass may have left an older
      // timeout behind. One poller owns one future tick at most.
      const previousTimeout = pollingIntervalsRef.current.get(chatId);
      if (previousTimeout) clearTimeout(previousTimeout);
      const jitter = errorBackoff === 0 && activePollersRef.current.size > 1
        ? Math.floor(Math.random() * 24)
        : 0;
      const timeoutId = setTimeout(pollOnce, delay + jitter);
      pollingIntervalsRef.current.set(chatId, timeoutId as any);
    };

    // Reference to the poll function — registered with catchUpPollersRef so the
    // page visibility handler can trigger an immediate catch-up when user returns
    // (fixes the "UI burst" bug where all buffered traces appear at once)
    const pollOnce = async () => {
      if (pollInFlight) return;
      if (!activePollersRef.current.has(chatId) || pollGenerationRef.current.get(chatId) !== pollGeneration) return;
      // The timeout that invoked this function has fired. Do not use timer
      // presence as liveness, and do not let a later catch-up clear the only
      // state that says this poller is still active.
      pollingIntervalsRef.current.delete(chatId);
      pollInFlight = true;
      try {

        // Safety: if we were stopped while waiting, don't run
        if (!activePollersRef.current.has(chatId) || pollGenerationRef.current.get(chatId) !== pollGeneration) return;
        const requestController = new AbortController();
        pollAbortControllersRef.current.set(chatId, requestController);
        try {
          const cursor = pollCursorsRef.current.get(chatId) ?? -1;
          const data = await fetchAgentPoll(chatId, cursor, 8000, requestController.signal);

          // The request may have been replaced while awaiting the response.
          if (!activePollersRef.current.has(chatId) || pollGenerationRef.current.get(chatId) !== pollGeneration) return;
          reconcileServerQueuedFollowUps(chatId, data.queuedFollowUps);

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

          // If the producer restarted or compacted its in-memory buffer, its
          // max index can move behind the renderer cursor. Replay the current
          // authoritative buffer once instead of polling forever past its end.
          const serverMaxIndex = Number(data.maxIndex);
          if (
            data.status === 'running' &&
            Number.isFinite(serverMaxIndex) &&
            serverMaxIndex < cursor
          ) {
            pollCursorsRef.current.set(chatId, -1);
            lastHadData = false;
            scheduleNextPoll();
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
            pollCursorsRef.current.set(chatId, getPollCursor(data));

            // CRITICAL: Check if this poll is for the CURRENTLY ACTIVE chat
            const isActiveChat = activeChatIdRef.current === chatId;

            // ═══════════════════════════════════════════
            // UNIFIED TRACE PROCESSOR — used for BOTH active and background chats
            // Prevents duplicate action containers by deduplicating on _traceIdx
            // ═══════════════════════════════════════════
            const processTraces = (existingLogs: any[]): any[] => {
              const activeRunId = serverRunId || expectedRunId || '';
              const hasRunScopedSnapshot = Boolean(activeRunId) && data.traces.every((trace: any) =>
                String(trace?.runId || trace?.turnId || '').trim() === activeRunId
              );
              // Current task-store snapshots are run-scoped. Route them through
              // the shared semantic upsert so active/background polling cannot
              // drift into different feed behavior. The legacy processor below
              // remains only for old unscoped persisted traces.
              if (hasRunScopedSnapshot) {
                return mergeServerRunLogs(stripAgentConnectionLogs(existingLogs), data.traces, {
                  chatId,
                  runId: activeRunId,
                  startedAt: serverRunStart,
                });
              }
              let logs = canonicalizeThoughtStreamLogs(
                normalizeBuilderUserActionLogs(stripAgentConnectionLogs([...existingLogs])),
              );
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
                  chatId,
                  runId: activeRunId,
                  startedAt: serverRunStart,
                });
              }
              // Find start of current turn (after last user_action) for dedup scoping
              const lastUserIdx = logs.reduceRight((found, l, i) => found === -1 && l.type === 'user_action' ? i : found, -1);
              let currentTurnStart = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
              let currentTurnId = String(
                (lastUserIdx >= 0
                  ? logs[lastUserIdx]?.turnId || logs[lastUserIdx]?.runId
                  : activeRunId) || ''
              ).trim();
              const activeRunLogs = activeRunId
                ? logs.filter((log: any) => String(log?.runId || log?.turnId || '').trim() === activeRunId)
                : logs.slice(currentTurnStart);
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
                const traceTurnId = String(
                  trace?.type === 'user_action'
                    ? trace?.turnId || trace?.id || trace?.runId || currentTurnId || activeRunId || ''
                  : trace?.turnId || trace?.runId || currentTurnId || activeRunId || ''
                ).trim();
                const timedTrace = withTraceTiming({
                  ...trace,
                  ownerChatId: chatId,
                  ...(trace?.type === 'user_action' ? { text: getVisibleUserActionText(trace) } : {}),
                  ...(activeRunId && !String(trace?.runId || '').trim() ? { runId: activeRunId } : {}),
                  ...(traceTurnId ? { turnId: traceTurnId } : {}),
                });
                if (timedTrace.type === 'inter_agent_message' && timedTrace.messageId) {
                  const existingMessageIndex = logs.findIndex((log: any) =>
                    log?.type === 'inter_agent_message' && log?.messageId === timedTrace.messageId
                  );
                  if (existingMessageIndex >= 0) {
                    const existingMessage = logs[existingMessageIndex];
                    logs[existingMessageIndex] = {
                      ...existingMessage,
                      ...timedTrace,
                      agentName: existingMessage.agentName || timedTrace.agentName,
                      subAgent: existingMessage.subAgent || timedTrace.subAgent,
                      subAgentId: existingMessage.subAgentId || timedTrace.subAgentId,
                      subAgentChatId: existingMessage.subAgentChatId || timedTrace.subAgentChatId,
                    };
                    continue;
                  }
                }
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
                      ...optimisticUserLog,
                      ...timedTrace,
                      attachments: timedTrace.attachments || optimisticUserLog.attachments,
                      selectedAgentId: timedTrace.selectedAgentId || optimisticUserLog.selectedAgentId,
                      selectedAgentName: timedTrace.selectedAgentName || optimisticUserLog.selectedAgentName,
                      chatMode: timedTrace.chatMode ?? optimisticUserLog.chatMode,
                      id: timedTrace.id || optimisticUserLog.id,
                      source: timedTrace.source || optimisticUserLog.source,
                      delegatedBy: timedTrace.delegatedBy || optimisticUserLog.delegatedBy,
                      _traceIdx: timedTrace._traceIdx,
                    };
                    currentTurnId = String(timedTrace.turnId || timedTrace.runId || activeRunId || '').trim();
                    currentTurnStart = existingUserIdx + 1;
                    continue;
                  }
                  // Proxy-backed runs may contain more than one user boundary.
                  // Preserve each boundary's own turn id and reset per-turn
                  // dedupe scopes instead of stamping every later trace with
                  // the first user turn's identity.
                  currentTurnId = String(timedTrace.turnId || timedTrace.runId || activeRunId || '').trim();
                  logs.push(timedTrace);
                  currentTurnStart = logs.length;
                  continue;
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
                      // Ignore a late cancellation once the durable note has
                      // already settled in this row.
                      if (!isOpenWorkNoteTrace(logs[i])) {
                        if (noteId && logs[i].noteId === noteId) break;
                        continue;
                      }
                      logs[i] = {
                        ...logs[i],
                        _streamingCancelled: true,
                        _cancelTraceIdx: trace._traceIdx,
                        _cancelledAt: timedTrace.timestamp,
                      };
                      break;
                    }
                  }
                  continue;
                }

                if (isPrivateReasoningTrace(timedTrace)) {
                  continue;
                } else if (trace.type === 'work_note') {
                  const subAgent = trace.subAgent || null;
                  const subAgentIdentity = trace.subAgentChatId || trace.subAgentId || subAgent;
                  const noteId = trace.noteId || null;
                  // One-shot notes omit stream flags and are authoritative
                  // settled events, not another provisional chunk.
                  const incomingIsFinal = !isOpenWorkNoteTrace({ ...trace, type: 'work_note' });
                  const noteText = formatVisibleWorkNote(String(trace.text || ''));
                  if (!noteText) continue;
                  let mergeIdx = -1;
                  let ignoreCancelledUpdate = false;
                  let crossedPhaseBoundary = false;
                  for (let i = logs.length - 1; i >= 0; i--) {
                    if (logs[i].type === 'user_action') break;
                    if (WORK_NOTE_PHASE_BOUNDARY_TYPES.has(String(logs[i].type || ''))) {
                      crossedPhaseBoundary = true;
                      continue;
                    }
                    if (
                      logs[i].type === 'work_note' &&
                      (logs[i].subAgentChatId || logs[i].subAgentId || logs[i].subAgent || null) === subAgentIdentity
                    ) {
                      const existingText = String(logs[i].text || '').trim();
                      if (noteId && logs[i].noteId && logs[i].noteId === noteId) {
                        if (logs[i]._streamingCancelled && !incomingIsFinal) {
                          ignoreCancelledUpdate = true;
                          break;
                        }
                        mergeIdx = i;
                        break;
                      }
                      const cancellationTraceIdx = Number(logs[i]._cancelTraceIdx);
                      const incomingTraceIdx = Number(trace._traceIdx);
                      const cancelledAt = Number(logs[i]._cancelledAt || logs[i].endTime || logs[i].timestamp || 0);
                      const incomingAt = Number(timedTrace.startTime || timedTrace.timestamp || 0);
                      const orderedCancellation =
                        !Number.isFinite(cancellationTraceIdx) ||
                        !Number.isFinite(incomingTraceIdx) ||
                        incomingTraceIdx >= cancellationTraceIdx;
                      const closeInTime = !cancelledAt || !incomingAt || Math.abs(incomingAt - cancelledAt) <= 15_000;
                      if (
                        logs[i]._streamingCancelled &&
                        incomingIsFinal &&
                        !crossedPhaseBoundary &&
                        i === logs.length - 1 &&
                        orderedCancellation &&
                        closeInTime
                      ) {
                        mergeIdx = i;
                        break;
                      }
                      if (existingText === noteText) {
                        if (!crossedPhaseBoundary && incomingIsFinal && isOpenWorkNoteTrace(logs[i])) {
                          mergeIdx = i;
                        }
                        break;
                      }
                      if (
                        !crossedPhaseBoundary &&
                        (!noteId || !logs[i].noteId) &&
                        isOpenWorkNoteTrace(logs[i])
                      ) {
                        mergeIdx = i;
                        break;
                      }
                    }
                  }
                  if (ignoreCancelledUpdate) continue;
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
                      text: incomingIsFinal && trace.isDelta !== true
                        ? noteText
                        : mergeStreamingText(logs[mergeIdx].text, noteText, trace.isDelta === true),
                      subAgent: subAgent ?? logs[mergeIdx].subAgent ?? null,
                      noteId: noteId || logs[mergeIdx].noteId || null,
                      _traceIdx: stableWorkNoteTraceIndex(logs[mergeIdx]._traceIdx, trace._traceIdx),
                      timestamp: Math.max(Number(logs[mergeIdx].timestamp || 0), traceAt),
                      startTime: logs[mergeIdx].startTime || timedTrace.startTime,
                      endTime: Math.max(Number(logs[mergeIdx].endTime || 0), traceAt),
                      _streamingCancelled: undefined,
                      _cancelTraceIdx: undefined,
                      _cancelledAt: undefined,
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
                } else if (trace.type === 'model_usage') {
                  // Usage is a first-class measured event. Replace only the
                  // same provider usage id; never merge different model turns.
                  const usageId = String(trace.usageId || '').trim();
                  const existingUsageIdx = usageId
                    ? logs.findIndex((log: any) => log?.type === 'model_usage' && String(log.usageId || '').trim() === usageId)
                    : -1;
                  if (existingUsageIdx >= 0) {
                    logs[existingUsageIdx] = { ...logs[existingUsageIdx], ...timedTrace };
                  } else {
                    logs.push(timedTrace);
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
                    const incomingIsStreaming =
                      trace.isStreaming === true ||
                      trace.isLiveTyping === true ||
                      trace.isDelta === true ||
                      trace.streamState === 'open';
                    logs[answerIdx] = {
                      ...logs[answerIdx],
                      ...timedTrace,
                      text: mergeStreamingText(logs[answerIdx].text, trace.text, trace.isDelta === true),
                      _traceIdx: trace._traceIdx ?? logs[answerIdx]._traceIdx,
                      isStreaming: incomingIsStreaming,
                      isLiveTyping: incomingIsStreaming,
                      startTime: logs[answerIdx].startTime || timedTrace.startTime,
                      endTime: Math.max(Number(logs[answerIdx].endTime || 0), traceAt),
                      timestamp: Math.max(Number(logs[answerIdx].timestamp || 0), traceAt),
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
                  // Keep one offset-aware row per shell stream. Parallel
                  // commands remain separate through stream/task ownership.
                  const currentOutputLogs = logs.slice(currentTurnStart);
                  const relativeMergeIdx = findMergeableConsoleOutputIndex(currentOutputLogs, trace);
                  const mergeIdx = relativeMergeIdx >= 0 ? currentTurnStart + relativeMergeIdx : -1;
                  if (mergeIdx >= 0) {
                    logs[mergeIdx] = {
                      ...mergeConsoleOutputTrace(logs[mergeIdx], timedTrace),
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
              return orderFeedTimelineLogs(canonicalizeThoughtStreamLogs(logs));
            };

            if (isActiveChat) {
              // Keep the visible feed and stored chat independently current.
              // Each updater owns only this chat, so a concurrent navigation
              // cannot apply this response to the newly opened conversation.
              queueBackgroundChatUpdate(chatId, processTraces);
            } else {
              // BACKGROUND chat — only update chats state, DON'T touch traceLogs
              queueBackgroundChatUpdate(chatId, processTraces);
            }

            // Debounced folder snapshot write — strip large content fields before persistence
            debouncedSaveToFolder();
          }

          const isTerminalPollStatus =
            data.status === 'completed' ||
            data.status === 'failed' ||
            data.status === 'stopped';
          if (isTerminalPollStatus) {
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
            // Show error trace so UI doesn't silently drop — this was causing the
            // 'UI gets off while running' appearance (agent failed, no feedback)
            const errMsg = data.finalAnswer || data.error || 'All API attempts exhausted or agent encountered a fatal error.';
            const failureRunId = String(data.runId || serverRunId || expectedRunId || '').trim();
            const failureText = String(errMsg).slice(0, 200);
            const failureAt = normalizeClientTraceTime(data.completedAt);
            setChatLogsById(chatId, previous => {
              const alreadyMarked = previous.some((log: any) =>
                log?.type === 'agent_status' &&
                log?.status === 'failed' &&
                (failureRunId
                  ? String(log.runId || log.turnId || '').trim() === failureRunId
                  : String(log.text || '').trim() === failureText && Number(log.timestamp || 0) === failureAt)
              );
              if (alreadyMarked) return previous;
              return [
                ...stripAgentConnectionLogs(previous),
                {
                  ...agentStatusLog('failed', 'Run ended with an error', failureText, failureAt),
                  ...(failureRunId ? { runId: failureRunId, turnId: failureRunId } : {}),
                },
              ];
            });
          }
          // The final answer/failure row above is queued through the same
          // lightweight commit path; flush it before a queued successor can
          // hand control to the next turn.
          if (isTerminalPollStatus) flushBackgroundChatUpdates();
          const hasQueuedSuccessor =
            data.status !== 'stopped' &&
            (Number(data.pendingProxyTaskCount || 0) > 0 || Number(data.pendingFollowUpCount || 0) > 0);
          if (
            hasQueuedSuccessor &&
            (data.status === 'completed' || data.status === 'failed')
          ) {
            // The registry starts queued Proxy work immediately after the
            // current run settles. Keep this poller attached across that small
            // handoff window; stopping here loses the successor's delegated
            // user turn and makes Main look idle in the visible transcript.
            pollCursorsRef.current.set(chatId, -1);
            lastHadData = false;
            if (activePollersRef.current.has(chatId) && pollGenerationRef.current.get(chatId) === pollGeneration) {
              pollingIntervalsRef.current.delete(chatId);
              scheduleNextPoll();
            }
            return;
          }
          if (data.status === 'completed' || data.status === 'failed' || data.status === 'stopped') {
            // Flush traces and terminal fallback/status rows before cleanup or
            // persistence can observe the previous live snapshot.
            flushBackgroundChatUpdates();
            // Check if it's already stopped by a overlapping async fetch
            const shouldNotify = activePollersRef.current.has(chatId);

            clearAgentConnectionStatus(chatId);
            stopPolling(chatId);
            removeRunningChat(chatId);
            liveProgressAnnouncementAtRef.current.delete(chatId);
            const terminalRunKey = String(
              data.runId || data.completedAt || data.finalAnswer || data.error || serverRunId || expectedRunId || 'terminal',
            ).trim();
            if (data.status === 'completed' || data.status === 'failed') {
              markChatUnreadIfBackground(chatId, `run:${terminalRunKey}:${data.status}`);
              if (claimTerminalAnnouncement(chatId, data.status, terminalRunKey)) {
                announceLiveTaskEvent(
                  chatId,
                  data.status,
                  String(data.finalAnswer || data.error || ''),
                  terminalRunKey,
                );
              }
            }

            // Channel conversations retain the adapter's reply target. Deliver
            // the final agent answer once per run through the desktop daemon,
            // which owns platform credentials and outbound API details.
            if (data.status === 'completed' && String(data.finalAnswer || '').trim() && chatId.startsWith('gateway_')) {
              const gatewayRunKey = String(serverRunId || expectedRunId || `${chatId}:${data.completedAt || Date.now()}`);
              if (!gatewayReplyRunIdsRef.current.has(gatewayRunKey)) {
                gatewayReplyRunIdsRef.current.add(gatewayRunKey);
                try {
                  const targets = JSON.parse(appStorage.getItem('eterx_gateway_reply_targets') || '{}');
                  const reply = targets?.[chatId];
                  if (reply?.platform && reply?.target && reply.operatingMode === 'autonomous' && reply.sendPolicy === 'autonomous') {
                    // Assist and manual profiles keep the completed answer as
                    // a draft. Only an explicitly autonomous profile publishes.
                    void (window as any).electronAPI?.sendGatewayMessage?.(
                      reply.platform,
                      reply.target,
                      String(data.finalAnswer),
                    ).catch((error: any) => {
                      gatewayReplyRunIdsRef.current.delete(gatewayRunKey);
                      console.error('[EterX Gateway] Could not deliver channel reply:', error);
                    });
                  }
                } catch (error) {
                  gatewayReplyRunIdsRef.current.delete(gatewayRunKey);
                  console.error('[EterX Gateway] Could not read channel reply target:', error);
                }
              }
            }

            // TRIGGER DESKTOP NOTIFICATION (Outside setState to prevent React.StrictMode double-firing!)
            if (shouldNotify && data.status === 'completed' && 'Notification' in window) {
              // Ensure exactly ONE notification per agent run - solves the 2-3x duplicate bug
              if (!notifiedChatIdsRef.current.has(chatId)) {
                notifiedChatIdsRef.current.add(chatId);

                try {
                  const svd = appStorage.getItem('eterx_settings');
                  const settings = svd ? JSON.parse(svd) : {};
                  const completionPreference = ['always', 'important', 'never'].includes(settings.completionNotifications)
                    ? settings.completionNotifications
                    : 'always';
                  const importantCompletion = document.hidden || activeChatIdRef.current !== chatId;
                  if (
                    settings.desktopNotifications !== false &&
                    completionPreference !== 'never' &&
                    (completionPreference === 'always' || importantCompletion)
                  ) {
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

            // Final folder snapshot save (immediate, not debounced).
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
        } finally {
          if (pollAbortControllersRef.current.get(chatId) === requestController) {
            pollAbortControllersRef.current.delete(chatId);
          }
        }

        // Schedule next poll (only if still active)
        if (activePollersRef.current.has(chatId) && pollGenerationRef.current.get(chatId) === pollGeneration) {
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
      if (!activePollersRef.current.has(chatId) || pollGenerationRef.current.get(chatId) !== pollGeneration) return;
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
    activePollersRef.current.delete(chatId);
    pollAbortControllersRef.current.get(chatId)?.abort();
    pollAbortControllersRef.current.delete(chatId);
    pollCursorsRef.current.delete(chatId);
    if (clearRunIdentity) {
      pollRunStartRef.current.delete(chatId);
      pollRunIdRef.current.delete(chatId);
    }
    catchUpPollersRef.current.delete(chatId);
    pollGenerationRef.current.set(chatId, (pollGenerationRef.current.get(chatId) || 0) + 1);
  };

  // Pollers belong to this page. Clean timers and in-flight requests if the
  // page is torn down so no stale callback can outlive the UI.
  useEffect(() => () => {
    const chatIds = new Set([
      ...activePollersRef.current,
      ...pollingIntervalsRef.current.keys(),
      ...pollAbortControllersRef.current.keys(),
    ]);
    chatIds.forEach(chatId => stopPolling(chatId));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const getWatchedChatIds = () => {
      const ids = new Set<string>();
      if (activeChatId) ids.add(activeChatId);
      // Read the live ref inside the interval. Capturing `runningChats` here
      // leaves newly started background chats outside the recovery safety net.
      runningChatsRef.current.forEach(id => ids.add(id));
      return ids;
    };

    let cancelled = false;
    let reconcileInFlight = false;
    const reconcileDetachedPollers = async () => {
      if (cancelled || reconcileInFlight) return;
      reconcileInFlight = true;
      const ids = getWatchedChatIds();
      try {
        for (const chatId of ids) {
        if (cancelled) return;
        if (activePollersRef.current.has(chatId)) continue;
        // Skip chats being explicitly stopped — avoids re-adding them during the cleanup race window
        if (stoppingChatsRef.current.has(chatId)) continue;

        try {
          const observedPollGeneration = pollGenerationRef.current.get(chatId) || 0;
          const data = await fetchAgentPoll(chatId, -1, 5000);
          if (cancelled) return;
          if (
            activePollersRef.current.has(chatId) ||
            (pollGenerationRef.current.get(chatId) || 0) !== observedPollGeneration ||
            stoppingChatsRef.current.has(chatId)
          ) continue;
          reconcileServerQueuedFollowUps(chatId, data.queuedFollowUps);

          if (data.traces && data.traces.length > 0) {
            setChatLogsById(chatId, previousLogs => mergeServerRunLogs(previousLogs, data.traces, {
              chatId,
              runId: data.runId,
              startedAt: data.startedAt,
            }));
            debouncedSaveToFolder();
          }

          if (data.status === 'running') {
            setRunningChats(prev => {
              if (prev.has(chatId)) return prev;
              const next = new Set(prev);
              next.add(chatId);
              return next;
            });

            startPolling(chatId, getPollCursor(data), data.startedAt, data.runId);
          } else if (isTerminalAgentStatus(data.status)) {
            removeRunningChat(chatId);
            liveProgressAnnouncementAtRef.current.delete(chatId);
            if (isTerminalAgentStatus(data.status)) {
              if (data.status === 'completed' || data.status === 'failed') {
                const unreadRunKey = String(
                  data.runId || data.completedAt || data.finalAnswer || data.error || pollRunIdRef.current.get(chatId) || 'terminal',
                );
                markChatUnreadIfBackground(chatId, `run:${unreadRunKey}:${data.status}`);
                if (claimTerminalAnnouncement(chatId, data.status, unreadRunKey)) {
                  announceLiveTaskEvent(
                    chatId,
                    data.status,
                    String(data.finalAnswer || data.error || ''),
                    unreadRunKey,
                  );
                }
              }
            }
          } else if (data.status === 'idle' && runningChatsRef.current.has(chatId)) {
            // Preserve startup races. The primary poller applies its bounded
            // pending-start timeout instead of losing the run here.
            startPolling(
              chatId,
              -1,
              pollRunStartRef.current.get(chatId),
              pollRunIdRef.current.get(chatId),
            );
          }
        } catch {
          // Keep the UI quiet here; the normal poller/backoff path will recover.
        }
        }
      } finally {
        reconcileInFlight = false;
      }
    };

    reconcileDetachedPollers();
    const interval = window.setInterval(reconcileDetachedPollers, 8000); // Safety net only — 8s is plenty
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeChatId]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopChatAgent = (chatId: string): Promise<boolean> => {
    if (!chatId || !runningChatsRef.current.has(chatId)) return Promise.resolve(false);
    const existingRequest = stopRequestsRef.current.get(chatId);
    if (existingRequest) return existingRequest;
    const queuedMessages = queuedFollowUps.filter(message => message.chatId === chatId);
    const steeringMessages = pendingSteering.filter(message => message.chatId === chatId);
    const releaseQueuedAdmissions = () => {
      for (const message of queuedMessages) {
        queuedFollowUpDispatchRef.current.delete(message.id);
        if (message.admissionKey) {
          queuedFollowUpAdmissionsRef.current.delete(message.admissionKey);
          queuedFollowUpIdsRef.current.delete(message.admissionKey);
        }
      }
    };
    const stopRunId = pollRunIdRef.current.get(chatId) || String(
      [...(chatsRef.current.find(chat => chat.id === chatId)?.traceLogs || [])]
        .reverse()
        .find((log: any) => log?.type === 'user_action')
        ?.runId || ''
    ).trim();
    setQueuedFollowUps(previous => previous.filter(message => message.chatId !== chatId));
    setPendingSteering(previous => previous.filter(message => message.chatId !== chatId));

    if (directChatRunsRef.current.has(chatId)) {
      abortControllersRef.current.get(chatId)?.abort();
      abortControllersRef.current.delete(chatId);
      directChatRunsRef.current.delete(chatId);
      pendingTitleRequestsRef.current.delete(chatId);
      removeRunningChat(chatId);
      setChatLogsById(chatId, previous => {
        const clean = stripAgentConnectionLogs(previous);
        const alreadyMarked = clean.some(log => log?.type === 'agent_status' && log.status === 'stopped');
        return alreadyMarked ? clean : [...clean, agentStatusLog('stopped', 'Chat stopped', 'Stopped by you.')];
      });
      releaseQueuedAdmissions();
      return Promise.resolve(true);
    }

    const stopRequest = (async () => {
      try {
        const startReadiness = runStartReadinessRef.current.get(chatId);
        if (startReadiness) {
          // A wedged start response must not leave the Stop button spinning
          // forever. The backend records a run-scoped cancellation tombstone
          // when Stop reaches it before registration, so this timeout remains
          // safe even for a request that arrives late.
          await Promise.race([
            startReadiness,
            new Promise<void>(resolve => window.setTimeout(resolve, 8000)),
          ]);
        }
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
        releaseQueuedAdmissions();
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

    const receivedSteeringLogs = currentTurnLogs.filter(l => l.type === 'steering_received');
    const receivedIds = new Set(
      receivedSteeringLogs
        .map(l => String(l.steeringId || ''))
        .filter(Boolean)
    );
    const receivedLegacyKeys = new Set(
      receivedSteeringLogs
        .filter(l => !String(l.steeringId || '').trim())
        .map(l => `${ String(l.runId || l.turnId || '').trim() }::${ String(l.text || '') }`)
    );

    if (receivedIds.size > 0 || receivedLegacyKeys.size > 0) {
      setPendingSteering(prev => prev.filter(p =>
        p.chatId !== activeChatId || (
          !receivedIds.has(p.id) &&
          !receivedLegacyKeys.has(`${ p.runId }::${ p.text }`)
        )
      ));
    }
  }, [activeChatId, traceLogs, pendingSteering.length]);

  /**
   * handleSteer - sends a live steering comment to the running agent.
   * The message is queued server-side and injected into the model context
   * at the next free ReAct iteration (non-disruptive, agent is never paused).
   */
  const sendSteeringMessageToChat = useCallback(async (
    targetChatId: string,
    message: string,
    expectedRunId?: string,
    clearComposer = true,
  ) => {
    const steerMessage = message.trim();
    const admissionKey = makeFollowUpAdmissionKey(targetChatId, steerMessage);
    if (!targetChatId || !steerMessage || steeringAdmissionsRef.current.has(admissionKey)) return false;
    steeringAdmissionsRef.current.add(admissionKey);
    const targetLogs = chatsRef.current.find(chat => chat.id === targetChatId)?.traceLogs || [];
    const targetUserLog = [...targetLogs].reverse().find((log: any) => log?.type === 'user_action');
    const targetRunId = String(
      expectedRunId ||
      pollRunIdRef.current.get(targetChatId) ||
      targetUserLog?.runId ||
      targetUserLog?.turnId ||
      ''
    ).trim();
    const newSteering = {
      id: crypto.randomUUID(),
      text: steerMessage,
      chatId: targetChatId,
      runId: targetRunId,
    };
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
        if (clearComposer && activeChatIdRef.current === newSteering.chatId) {
          updateInputValue(current => current.trim() ? current : steerMessage);
        }
        return false;
      } else {
        console.log('[handleSteer] Steering message sent:', steerMessage.substring(0, 60));
        if (clearComposer) clearDraftComposerState(targetChatId);
        return true;
      }
    } catch (e: any) {
      console.warn('[handleSteer] Network error:', e?.message);
      setPendingSteering(prev => prev.filter(item => item.id !== newSteering.id));
      if (clearComposer && activeChatIdRef.current === newSteering.chatId) {
        updateInputValue(current => current.trim() ? current : steerMessage);
      }
      return false;
    } finally {
      steeringAdmissionsRef.current.delete(admissionKey);
    }
  }, [clearDraftComposerState, revealNetworkBanner, updateInputValue]);

  const sendSteeringMessage = useCallback(async (message: string) => {
    const targetChatId = activeChatIdRef.current;
    return targetChatId ? sendSteeringMessageToChat(targetChatId, message, undefined, false) : false;
  }, [sendSteeringMessageToChat]);

  const readFollowUpBehavior = (): 'queue' | 'steer' => {
    try {
      const saved = appStorage.getItem(SETTINGS_STORAGE_KEY);
      const settings = saved ? JSON.parse(saved) : null;
      return settings?.followUpBehavior === 'queue' ? 'queue' : 'steer';
    } catch {
      return 'steer';
    }
  };

  const queueFollowUpForChat = async (
    targetChatId: string,
    message: string,
    nextAttachments: ComposerAttachment[] = [],
    requestedQueueId?: string,
    clearComposer = true,
    runOptions?: QueuedRunOptions,
    forceRendererQueue = false,
  ): Promise<boolean> => {
    const queuedMessage = message.trim();
    if (!targetChatId || (!queuedMessage && nextAttachments.length === 0)) return false;
    const admissionKey = makeFollowUpAdmissionKey(targetChatId, queuedMessage, nextAttachments, runOptions?.selectedAgent);
    if (queuedFollowUpAdmissionsRef.current.has(admissionKey)) return false;

    queuedFollowUpAdmissionsRef.current.add(admissionKey);
    const queuedId = requestedQueueId || queuedFollowUpIdsRef.current.get(admissionKey) || crypto.randomUUID();
    queuedFollowUpIdsRef.current.set(admissionKey, queuedId);
    const createdAt = Date.now();
    setQueuedFollowUps(previous => [
      ...previous,
      {
        id: queuedId,
        chatId: targetChatId,
        text: queuedMessage,
        attachments: [...nextAttachments],
        createdAt,
        admissionKey,
        attachmentCount: nextAttachments.length,
        serverBacked: false,
        ...(runOptions ? { runOptions } : {}),
      },
    ]);

    // Direct-chat streams intentionally do not enter AgentRegistry. Keep their
    // next turn local to the renderer that owns that stream; full agent queues
    // continue through the durable backend path below.
    if (forceRendererQueue || directChatRunsRef.current.has(targetChatId)) {
      if (clearComposer) clearDraftComposerState(targetChatId);
      return true;
    }

    const mediaAttachments = nextAttachments.map(attachment => ({
      id: attachment.id,
      name: attachment.name || attachment.file?.name || 'attachment',
      path: attachment.localPath || getNativeFilePath(attachment.file) || undefined,
      mimeType: attachment.mimeType || attachment.file?.type || 'application/octet-stream',
      size: attachment.size || attachment.file?.size || 0,
      fileUri: undefined,
    }));

    try {
      const response = await fetch('/api/agent/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enqueue',
          chatId: targetChatId,
          id: queuedId,
          prompt: queuedMessage,
          mediaAttachments,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.success !== true) {
        throw new Error(payload?.message || payload?.error || `Queue request failed (${ response.status })`);
      }
      if (Array.isArray(payload?.items)) {
        if (payload.items.some((item: any) => String(item?.id || '') === queuedId)) {
          reconcileServerQueuedFollowUps(targetChatId, payload.items);
        } else {
          // An idempotent retry may arrive after the backend has already
          // promoted this item into a real run. It is accepted, but no longer
          // belongs in the visible queue rail.
          setQueuedFollowUps(previous => previous.filter(item => item.id !== queuedId));
          queuedFollowUpAdmissionsRef.current.delete(admissionKey);
          queuedFollowUpIdsRef.current.delete(admissionKey);
        }
      } else {
        setQueuedFollowUps(previous => previous.map(item => item.id === queuedId
          ? {
              ...item,
              runId: payload?.item?.runId || item.runId,
              attachmentCount: Number(payload?.item?.attachmentCount || item.attachmentCount || 0),
              serverBacked: true,
            }
          : item));
      }
      if (clearComposer) clearDraftComposerState(targetChatId);
      return true;
    } catch (error: any) {
      setQueuedFollowUps(previous => previous.filter(item => item.id !== queuedId));
      queuedFollowUpAdmissionsRef.current.delete(admissionKey);
      console.warn('[Queue] Could not queue follow-up:', error?.message || error);
      setChatLogsById(targetChatId, previous => [
        ...stripAgentConnectionLogs(previous),
        agentStatusLog(
          'warning',
          'Follow-up not queued',
          String(error?.message || error || 'The queue request was not accepted.').slice(0, 180),
        ),
      ]);
      return false;
    }
  };

  const deliverFollowUpToRunningChat = async (
    targetChatId: string,
    message: string,
    nextAttachments: ComposerAttachment[] = [],
    expectedRunId?: string,
    clearComposer = true,
    runOptions?: QueuedRunOptions,
    forceRendererQueue = false,
  ) => {
    const followUpMessage = message.trim();
    if (!targetChatId || (!followUpMessage && nextAttachments.length === 0)) return false;
    const admissionKey = makeFollowUpAdmissionKey(targetChatId, followUpMessage, nextAttachments, runOptions?.selectedAgent);
    if (
      steeringAdmissionsRef.current.has(admissionKey) ||
      queuedFollowUpAdmissionsRef.current.has(admissionKey)
    ) return false;

    // Attachments must become a real next turn. Text-only guidance can be
    // injected into the current ReAct loop when the user prefers steering.
    if (forceRendererQueue || nextAttachments.length > 0 || readFollowUpBehavior() === 'queue') {
      return queueFollowUpForChat(
        targetChatId,
        followUpMessage,
        nextAttachments,
        undefined,
        clearComposer,
        runOptions,
        forceRendererQueue,
      );
    }

    const steered = await sendSteeringMessageToChat(targetChatId, followUpMessage, expectedRunId, clearComposer);
    if (steered) {
      return true;
    }

    // The run can finish between the client state check and the steering
    // request. Keep the user's intent instead of dropping it in that race;
    // the backend queue will dispatch it once the run is genuinely idle.
    return queueFollowUpForChat(targetChatId, followUpMessage, nextAttachments, undefined, clearComposer);
  };

  const handleSteer = async () => {
    if (!inputValue.trim() && attachments.length === 0) return;
    const steerMessage = inputValue.trim();
    const targetChatId = activeChatIdRef.current;
    if (!targetChatId) return;
    const admissionKey = makeFollowUpAdmissionKey(targetChatId, steerMessage, attachments);
    if (steeringAdmissionsRef.current.has(admissionKey) || queuedFollowUpAdmissionsRef.current.has(admissionKey)) return;
    await deliverFollowUpToRunningChat(targetChatId, steerMessage, attachments);
  };

  const toggleSpeech = async () => {
    if (dictationShouldRunRef.current) {
      stopSpeechDictation();
      return;
    }

    const desktopApi = (window as any).electronAPI;
    const desktopPermission = await desktopApi?.requestLiveMediaPermissions?.();
    if (['denied', 'restricted'].includes(String(desktopPermission?.microphone || ''))) {
      alert('Microphone access is blocked. Allow EterX to use the microphone in your system settings, restart the app, and try again.');
      return;
    }

    const startingText = inputValue && !/\s$/.test(inputValue) ? `${inputValue} ` : inputValue;
    dictationBaseTextRef.current = startingText;
    dictationCommittedTextRef.current = '';
    inputValueRef.current = startingText;
    lastDictationRenderRef.current = startingText;
    dictationRenderedValuesRef.current.clear();
    rememberDictationRender(startingText);
    dictationShouldRunRef.current = true;
    setIsRecording(true);

    const startNativeDictation = async () => {
      if (typeof desktopApi?.startSpeechDictation !== 'function') return false;
      try {
        const nativeResult = await desktopApi.startSpeechDictation(navigator.language || 'en-US');
        if (!dictationShouldRunRef.current) {
          if (nativeResult?.started) void desktopApi.stopSpeechDictation?.();
          return false;
        }
        if (nativeResult?.started) return true;
        if (nativeResult?.supported !== false) {
          throw new Error(nativeResult?.error || 'Native voice dictation could not start.');
        }
      } catch (error: any) {
        if (desktopApi?.platform === 'windows') {
          throw error;
        }
      }
      return false;
    };

    const browserWindow = window as typeof window & {
      SpeechRecognition?: new () => any;
      webkitSpeechRecognition?: new () => any;
    };
    const SpeechRecognitionConstructor =
      browserWindow.SpeechRecognition || browserWindow.webkitSpeechRecognition;

    if (!SpeechRecognitionConstructor) {
      try {
        if (await startNativeDictation()) return;
      } catch (error: any) {
        dictationShouldRunRef.current = false;
        lastDictationRenderRef.current = null;
        setIsRecording(false);
        alert(String(error?.message || error || 'Native voice dictation could not start.'));
        return;
      }
      dictationShouldRunRef.current = false;
      lastDictationRenderRef.current = null;
      setIsRecording(false);
      alert('Live voice dictation is unavailable on this device. Install an on-device speech language and try again.');
      return;
    }

    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        permissionStream.getTracks().forEach(track => track.stop());
      } catch {
        dictationShouldRunRef.current = false;
        setIsRecording(false);
        alert('Microphone access was not granted. Allow microphone access and try again.');
        return;
      }
    }

    const recognitionLanguage = navigator.language || 'en-US';
    let useOnDeviceRecognition = false;
    const SpeechRecognitionApi = SpeechRecognitionConstructor as any;
    if (typeof SpeechRecognitionApi.available === 'function') {
      try {
        let availability = await SpeechRecognitionApi.available({
          langs: [recognitionLanguage],
          processLocally: true,
        });
        if (availability === 'downloadable' && typeof SpeechRecognitionApi.install === 'function') {
          const installed = await SpeechRecognitionApi.install({ langs: [recognitionLanguage] });
          if (installed) {
            availability = await SpeechRecognitionApi.available({
              langs: [recognitionLanguage],
              processLocally: true,
            });
          }
        }
        useOnDeviceRecognition = availability === 'available';
      } catch {
        // Older engines can expose the constructor without supporting local
        // language packs. Their normal recognition path remains the fallback.
      }
    }

    const startRecognition = () => {
      if (!dictationShouldRunRef.current) return;

      const recognition = new SpeechRecognitionConstructor();
      speechRecognitionRef.current = recognition;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.lang = recognitionLanguage;
      if (useOnDeviceRecognition && 'processLocally' in recognition) {
        recognition.processLocally = true;
      }

      recognition.onresult = (event: any) => {
        let finalText = '';
        let interimText = '';

        for (let index = 0; index < event.results.length; index++) {
          const result = event.results[index];
          const transcript = String(result?.[0]?.transcript || '');
          if (result.isFinal) finalText += transcript;
          else interimText += transcript;
        }

        const recognizedText = mergeSpeechText(finalText, interimText);
        const nextText = appendSpeechToDraft(dictationBaseTextRef.current, recognizedText);
        inputValueRef.current = nextText;
        lastDictationRenderRef.current = nextText;
        rememberDictationRender(nextText);
        updateInputValue(nextText);
      };

      recognition.onerror = (event: any) => {
        const error = String(event?.error || '');
        if (error === 'no-speech' || error === 'aborted') return;

        if (error === 'network' || error === 'service-not-allowed') {
          recognition.onend = null;
          speechRecognitionRef.current = null;
          void startNativeDictation()
            .then(started => {
              if (started || !dictationShouldRunRef.current) return;
              dictationShouldRunRef.current = false;
              lastDictationRenderRef.current = null;
              setIsRecording(false);
              alert('No working on-device speech recognizer is available. Install a system speech language and try again.');
            })
            .catch((nativeError: any) => {
              dictationShouldRunRef.current = false;
              lastDictationRenderRef.current = null;
              setIsRecording(false);
              alert(String(nativeError?.message || nativeError || 'On-device voice dictation could not start.'));
            });
          return;
        }

        dictationShouldRunRef.current = false;
        speechRecognitionRef.current = null;
        lastDictationRenderRef.current = null;
        setIsRecording(false);

        if (error === 'not-allowed') {
          alert('Microphone or speech-recognition access is blocked. Allow access, then try again.');
        } else if (error === 'audio-capture') {
          alert('No working microphone was found. Check your selected input device and try again.');
        } else if (error === 'language-not-supported' || error === 'language-unavailable') {
          alert('Speech recognition is not installed for your current system language.');
        } else {
          alert('This browser could not reach its speech-recognition service. Try the EterX desktop app or install an on-device speech language.');
        }
      };

      recognition.onend = () => {
        speechRecognitionRef.current = null;
        if (!dictationShouldRunRef.current) {
          setIsRecording(false);
          return;
        }

        dictationBaseTextRef.current = inputValueRef.current;
        dictationRestartTimerRef.current = setTimeout(() => {
          dictationRestartTimerRef.current = null;
          startRecognition();
        }, 150);
      };

      try {
        recognition.start();
      } catch {
        recognition.onend = null;
        void startNativeDictation()
          .then(started => {
            if (started || !dictationShouldRunRef.current) return;
            dictationShouldRunRef.current = false;
            lastDictationRenderRef.current = null;
            setIsRecording(false);
            alert('Voice dictation could not start on this device.');
          })
          .catch((nativeError: any) => {
            dictationShouldRunRef.current = false;
            lastDictationRenderRef.current = null;
            setIsRecording(false);
            alert(String(nativeError?.message || nativeError || 'On-device voice dictation could not start.'));
          });
      }
    };

    startRecognition();
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
          return agentIdentitiesOverlap(log, agentNameOrId) ||
            String(name || '').toLowerCase() === String(agentNameOrId).toLowerCase();
        });
        setActiveSubAgentTab(String(
          matchingLog?.subAgentChatId ||
          matchingLog?.subAgentId ||
          agentNameOrId
        ));
      }
      setSubAgentDockOpen(true);
    }
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
    const latestSelectedLifecycle = [...traceLogs].reverse().find((log: any) => {
      if (!/^sub_agent_(?:spawn|action|answer|result|complete|error|pause|resume|close)$/.test(String(log?.type || ''))) return false;
      return agentIdentitiesOverlap(log, activeSubAgentTab);
    });
    const latestSelectedStatus = String(latestSelectedLifecycle?.agentStatus || '').toLowerCase();
    if (
      ['completed', 'failed', 'error', 'closed', 'cancelled'].includes(latestSelectedStatus) ||
      ['sub_agent_answer', 'sub_agent_result', 'sub_agent_complete', 'sub_agent_error', 'sub_agent_close'].includes(String(latestSelectedLifecycle?.type || ''))
    ) return;
    const selectedAgentLog = [...traceLogs].reverse().find((log: any) => {
      return agentIdentitiesOverlap(log, activeSubAgentTab);
    });
    const selectedAgentDetail = [...traceLogs].reverse().flatMap((log: any) =>
      Array.isArray(log?.agentDetails) ? log.agentDetails : []
    ).find((detail: any) =>
      agentIdentitiesOverlap(detail, activeSubAgentTab)
    );
    const selectedAgentRun = selectedAgentLog || selectedAgentDetail;
    const agentName = selectedAgentRun?.agentName || selectedAgentRun?.subAgent || selectedAgentRun?.name || activeSubAgentTab;
    const selectedTabIdentity = String(activeSubAgentTab || '').trim();
    const subAgentChatId = String(
      selectedAgentRun?.subAgentChatId ||
      (selectedTabIdentity.includes('::sub-agent::') ? selectedTabIdentity : '')
    ).trim();
    const selectedRunId = String(
      selectedAgentRun?.subAgentId || selectedAgentRun?.agentId ||
      (selectedTabIdentity.includes('::sub-agent::') ? selectedTabIdentity.split('::sub-agent::').pop() : selectedTabIdentity) || ''
    ).trim();
    const subAgentIdentity = subAgentChatId || selectedRunId || selectedTabIdentity;
    const broadcastToTeam = subAgentMessageTarget === 'team';
    const recipient = broadcastToTeam ? '*' : agentName;
    const chatId = activeChatId;
    if (!agentName || !chatId) return;
    const admissionKey = `${ chatId }:${ broadcastToTeam ? 'team' : subAgentIdentity || agentName }`;
    if (subAgentSendAdmissionsRef.current.has(admissionKey)) return;

    if (dictationShouldRunRef.current) stopSpeechDictation();
    if (!inputValue.trim() && attachments.length === 0) return;
    subAgentSendAdmissionsRef.current.add(admissionKey);
    const originalInput = inputValue;
    const sentAt = Date.now();
    const scheduledMessage = parseScheduledAgentMessage(inputValue.trim());
    const currentAttachments = [...attachments];
    const filePaths = currentAttachments
      .map(att => (att as any).localPath || getNativeFilePath(att.file) || att.name || att.file?.name)
      .filter(Boolean);
    const attachmentContext = currentAttachments.length > 0
      ? `\n\n[Attachments]\n${ currentAttachments.map(att => {
        const name = att.name || att.file?.name || 'attachment';
        const path = (att as any).localPath || getNativeFilePath(att.file);
        return `- ${ name }${ path ? ` (${ path })` : '' }`;
      }).join('\n') }`
      : '';
    const body = `${ scheduledMessage.text }${ attachmentContext }`.trim();
    const optimisticMessageId = `pending_${ sentAt }_${ Math.random().toString(36).slice(2, 8) }`;
    const optimisticMessage = {
      id: optimisticMessageId,
      from: 'Main',
      to: recipient,
      type: 'coordination',
      subject: scheduledMessage.deliverAfterMs
        ? `Scheduled ${ broadcastToTeam ? 'team update' : 'Main instruction' } (${ scheduledMessage.label })`
        : broadcastToTeam ? 'Main team update' : 'Main instruction',
      body,
      priority: broadcastToTeam ? 'normal' : 'high',
      deliveryMode: broadcastToTeam ? 'defer' : 'interrupt',
      scheduled: !!scheduledMessage.deliverAfterMs,
      deliverAfter: scheduledMessage.deliverAfterMs ? sentAt + scheduledMessage.deliverAfterMs : undefined,
      filePaths,
      timestamp: sentAt,
      recipientAgentId: broadcastToTeam ? undefined : selectedRunId || undefined,
      recipientSubAgentChatId: broadcastToTeam ? undefined : subAgentChatId || undefined,
      optimistic: true,
    };
    const optimisticLog = interAgentMessageLog(
      optimisticMessage,
      agentName,
      broadcastToTeam ? undefined : subAgentIdentity || undefined,
    );

    setChatLogsById(chatId, previousLogs => [...previousLogs, optimisticLog], { touchUpdatedAt: true });

    clearDraftComposerState(activeChatId);

    try {
      const res = await fetch('/api/agents/comm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: scheduledMessage.deliverAfterMs ? 'schedule' : broadcastToTeam ? 'broadcast' : 'send',
          projectId: chatId,
          from: 'Main',
          to: recipient,
          type: 'coordination',
          subject: scheduledMessage.deliverAfterMs
            ? `Scheduled ${ broadcastToTeam ? 'team update' : 'Main instruction' } (${ scheduledMessage.label })`
            : broadcastToTeam ? 'Main team update' : 'Main instruction',
          body,
          priority: broadcastToTeam ? 'normal' : 'high',
          deliveryMode: broadcastToTeam ? 'defer' : 'interrupt',
          requiresResponse: !broadcastToTeam,
          deliverAfterMs: scheduledMessage.deliverAfterMs,
          filePaths,
          tags: ['ui', 'sub-agent-chat'],
          recipientAgentId: broadcastToTeam ? undefined : selectedRunId || undefined,
          recipientSubAgentChatId: broadcastToTeam ? undefined : subAgentChatId || undefined,
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
        to: recipient,
        type: 'coordination',
        subject: scheduledMessage.deliverAfterMs
          ? `Scheduled ${ broadcastToTeam ? 'team update' : 'Main instruction' } (${ scheduledMessage.label })`
          : broadcastToTeam ? 'Main team update' : 'Main instruction',
        body,
        priority: broadcastToTeam ? 'normal' : 'high',
        deliveryMode: broadcastToTeam ? 'defer' : 'interrupt',
        scheduled: !!scheduledMessage.deliverAfterMs,
        deliverAfter: scheduledMessage.deliverAfterMs ? sentAt + scheduledMessage.deliverAfterMs : undefined,
        filePaths,
        timestamp: sentAt,
      };
      const log = interAgentMessageLog(message, agentName, broadcastToTeam ? undefined : subAgentIdentity || undefined);
      setChatLogsById(chatId, previousLogs => {
        const withoutOptimistic = previousLogs.filter((item: any) => item.messageId !== optimisticMessageId);
        const existingIds = new Set(withoutOptimistic.map((item: any) => item.messageId || item.id).filter(Boolean));
        if (existingIds.has(log.messageId) || existingIds.has(log.id)) return withoutOptimistic;
        return [...withoutOptimistic, log];
      }, { touchUpdatedAt: true });
    } catch (error: any) {
      setChatLogsById(chatId, previousLogs => previousLogs.filter((item: any) => item.messageId !== optimisticMessageId));
      if (activeChatIdRef.current === chatId && activeComposerSurfaceRef.current === subAgentIdentity) {
        updateInputValue(current => current.trim() ? current : originalInput);
        updateAttachments(current => current.length > 0 ? current : currentAttachments);
      }
      const failureLog = {
        ...systemThoughtLog(`Failed to send message to ${ broadcastToTeam ? 'the agent team' : agentName }: ${ error?.message || 'Unknown error' }`, Date.now()),
        agentName: broadcastToTeam ? undefined : agentName,
        subAgent: broadcastToTeam ? undefined : agentName,
        subAgentId: broadcastToTeam ? undefined : selectedRunId || undefined,
        subAgentChatId: broadcastToTeam ? undefined : subAgentChatId || undefined,
      };
      setChatLogsById(chatId, previousLogs => [...previousLogs, failureLog], { touchUpdatedAt: true });
    } finally {
      subAgentSendAdmissionsRef.current.delete(admissionKey);
    }
  }, [activeChatId, activeSubAgentTab, attachments, inputValue, isRecording, subAgentMessageTarget, traceLogs, updateAttachments, updateInputValue]);

  const restoreComposerDraftIfEmpty = (
    targetChatId: string | null,
    originalInput: string,
    originalAttachments: ComposerAttachment[],
  ) => {
    // A failed request must not erase the draft. Only restore when the user is
    // still looking at the same chat and has not already started a replacement
    // message while the request was in flight.
    if (activeChatIdRef.current !== targetChatId) return;
    updateInputValue(current => current.trim() ? current : originalInput);
    updateAttachments(current => current.length > 0 ? current : originalAttachments);
  };

  const handleSend = async (
    overridePrompt?: string,
    overrideAttachments?: ComposerAttachment[],
    targetChatIdOverride?: string,
    runOptionsOverride?: {
      modelSelection?: string;
      selectedAgent?: SelectedAgentState;
      thinkingLevel?: MainAgentThinkingLevel;
      /** Explicit execution target for background/gateway/scheduled dispatches. */
      workspacePath?: string | null;
      runLocation?: 'local' | 'sandbox';
      createNewChat?: boolean;
      backgroundChat?: boolean;
      initialTitle?: string;
      pinnedItems?: PinnedItem[];
    },
  ) => {
    if (dictationShouldRunRef.current) stopSpeechDictation();
    const promptText = (typeof overridePrompt === 'string' ? overridePrompt : inputValue).trim();
    const requestedAttachments = overrideAttachments ?? attachments;
    const shouldRestoreComposer = typeof overridePrompt !== 'string' && !runOptionsOverride?.backgroundChat;
    const originalComposerInput = inputValue;
    const originalComposerAttachments = [...attachments];
    if (!promptText && requestedAttachments.length === 0) return false;
    // Reserve a real ID before admission. A shared `__new_chat__` key made a
    // still-streaming send from an earlier fresh chat silently reject sends
    // after the user returned to New chat.
    const sendTarget = resolveChatSendTarget(
      targetChatIdOverride,
      activeChatIdRef.current,
      () => crypto.randomUUID(),
    );
    const targetChatIdAtSend = sendTarget.chatId;
    const targetChatExists = targetChatIdAtSend
      ? chatsRef.current.some(chat => chat.id === targetChatIdAtSend)
      : false;
    const targetChat = targetChatIdAtSend
      ? chatsRef.current.find(chat => chat.id === targetChatIdAtSend)
      : undefined;
    const targetComposerState = targetChatIdAtSend
      ? composerStatesRef.current[targetChatIdAtSend]
      : undefined;
    // A dispatch to an existing background chat must not inherit the selected
    // model/agent/device from whichever chat the user is viewing now. New
    // chats intentionally inherit the current composer unless the caller
    // supplies an explicit execution target.
    const useActiveComposerContext = !sendTarget.hasExplicitTarget ||
      targetChatIdAtSend === activeChatIdRef.current ||
      (!targetChatExists && !runOptionsOverride?.workspacePath && !runOptionsOverride?.runLocation);
    const composerContext = useActiveComposerContext
      ? composerRuntimeSelectionRef.current
      : {
          modelSelection: resolveRuntimeModelSelection(targetComposerState?.chatModelSelection),
          selectedAgent: targetComposerState?.selectedAgent || { agentId: null, agentName: 'General' } as SelectedAgentState,
          agentMode: targetComposerState?.agentMode || 'think' as MainAgentMode,
          thinkingLevel: targetComposerState?.thinkingLevel || 'low' as MainAgentThinkingLevel,
        };
    const executionWorkspacePath = runOptionsOverride?.workspacePath ??
      targetChat?.workspacePath ??
      (useActiveComposerContext ? activeWorkspacePath : null);
    const executionRunLocation = runOptionsOverride?.runLocation ||
      targetComposerState?.runLocation ||
      targetChat?.runLocation ||
      (useActiveComposerContext ? activeRunLocation : 'local');
    const targetProxyControls = targetChatIdAtSend && !useActiveComposerContext
      ? (() => {
          try {
            const stored = JSON.parse(appStorage.getItem(`eterx_proxy_controls_${targetChatIdAtSend}`) || '{}');
            return {
              enabled: stored.enabled !== false,
              intervention: ['minimal', 'normal', 'high'].includes(stored.intervention) ? stored.intervention as 'minimal' | 'normal' | 'high' : 'normal',
              runtimeModel: appStorage.getItem(`eterx_proxy_runtime_model_${targetChatIdAtSend}`) || AUTO_MODEL_SELECTION,
            };
          } catch {
            return null;
          }
        })()
      : null;
    const executionProxyEnabled = targetProxyControls?.enabled ?? proxyEnabled;
    const executionProxyIntervention = targetProxyControls?.intervention ?? proxyIntervention;
    const executionProxyRuntimeModelSelection = targetProxyControls?.runtimeModel || proxyRuntimeModelSelection;
    const shouldCreateTargetChat = Boolean(
      !targetChatExists &&
      (!sendTarget.hasExplicitTarget || runOptionsOverride?.createNewChat)
    );
    if (sendTarget.hasExplicitTarget && !targetChatExists && !shouldCreateTargetChat) return false;
    const targetHasLiveSession =
      targetChatIdAtSend !== null &&
      targetChatIdAtSend === liveChatIdRef.current &&
      liveState !== 'idle' &&
      liveState !== 'error' &&
      !liveMainDispatchRef.current;
    const targetRunIsActive = Boolean(
      (targetChatIdAtSend && runningChatsRef.current.has(targetChatIdAtSend)) ||
      targetHasLiveSession
    );
    if (targetRunIsActive) {
      // A stale renderer flag or a second submit can reach this handler even
      // though the chat already owns a real backend execution. Deliver it as
      // the configured steer/queue follow-up instead of silently dropping it.
      if (!targetChatIdAtSend) return false;
      const requestedSelection = normalizeChatAgentSelection(
        runOptionsOverride?.selectedAgent || composerContext.selectedAgent,
      );
      const targetLogs = targetChat?.traceLogs
        || (targetChatIdAtSend === activeChatIdRef.current ? traceLogs : []);
      const runtimeChanged = shouldQueueForAgentSwitch(
        targetLogs,
        pollRunIdRef.current.get(targetChatIdAtSend),
        requestedSelection,
      );
      const queuedRunOptions: QueuedRunOptions = {
        modelSelection: runOptionsOverride?.modelSelection || composerContext.modelSelection,
        selectedAgent: requestedSelection,
        thinkingLevel: runOptionsOverride?.thinkingLevel || composerContext.thinkingLevel,
        pinnedItems: [...(runOptionsOverride?.pinnedItems || targetComposerState?.pinnedItems || pinnedItems)],
      };
      return deliverFollowUpToRunningChat(
        targetChatIdAtSend,
        promptText,
        requestedAttachments,
        undefined,
        shouldRestoreComposer,
        queuedRunOptions,
        runtimeChanged,
      );
    }
    // React state does not update synchronously. This latch closes the gap in
    // which a double click/Enter can launch two requests before isThinking flips.
    const admissionKey = targetChatIdAtSend;
    const admittedAt = sendAdmissionsRef.current.get(admissionKey) || 0;
    if (Date.now() - admittedAt < 30_000) return false;
    sendAdmissionsRef.current.set(admissionKey, Date.now());

    // Request notification permissions implicitly during this user gesture
    try {
      const saved = appStorage.getItem('eterx_settings');
      const settings = saved ? JSON.parse(saved) : {};
      const completionPreference = ['always', 'important', 'never'].includes(settings.completionNotifications)
        ? settings.completionNotifications
        : 'always';
      if (completionPreference !== 'never' && settings.desktopNotifications !== false && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    } catch { }

    const runModelSelection = runOptionsOverride?.modelSelection || composerContext.modelSelection;
    const runtimeEntries = readRuntimeModelEntries();
    const runtimeProviderKeys = readRuntimeBaseApiKeys();
    const runtimeModelKeys = readRuntimeModelApiKeys();
    const requestedRunModelEntry = parseModelEntryKey(runModelSelection)
      || (runModelSelection === AUTO_MODEL_SELECTION
        ? pickAutoModelEntry(runtimeEntries, runtimeProviderKeys, runtimeModelKeys)
        : null);
    const requestedRunModelSelection = requestedRunModelEntry
      ? modelEntryKey(requestedRunModelEntry.provider, requestedRunModelEntry.modelId)
      : runModelSelection;
    const runModelEntry = requestedRunModelEntry
      && runtimeEntries.some(entry => modelEntryKey(entry.provider, entry.modelId) === requestedRunModelSelection)
      && (
        isLocalModelProvider(requestedRunModelEntry.provider)
        || Boolean(runtimeProviderKeys[requestedRunModelEntry.provider])
        || Boolean(runtimeModelKeys[requestedRunModelSelection])
      )
      ? requestedRunModelEntry
      : null;
    if (!runModelEntry) {
      sendAdmissionsRef.current.delete(admissionKey);
      return false;
    }
    const runAgentMode = MODEL_PROVIDER_MODE[runModelEntry.provider];
    const contextBudgetModelEntry = runModelEntry;
    const runThinkingLevel = runOptionsOverride?.thinkingLevel || composerContext.thinkingLevel;
    const runSelectedAgent = runOptionsOverride?.selectedAgent || composerContext.selectedAgent;
    const runPinnedItems = runOptionsOverride?.pinnedItems || (useActiveComposerContext ? pinnedItems : targetComposerState?.pinnedItems || []);
    const runSelectedAgentId = runSelectedAgent.agentId;
    const runSelectedAgentName = runSelectedAgent.agentName;
    const currentAttachments = [...requestedAttachments];
    const userLogAttachments = currentAttachments.map(serializeComposerAttachment);
    const runStartedAt = Date.now();
    const clientRunId = crypto.randomUUID();
    const userLog = {
      id: `user-turn-${ clientRunId }`,
      type: 'user_action',
      text: promptText,
      source: 'human',
      attachments: userLogAttachments,
      runId: clientRunId,
      turnId: clientRunId,
      startTime: runStartedAt,
      endTime: runStartedAt,
      selectedAgentId: runSelectedAgentId,
      selectedAgentName: runSelectedAgentName,
      chatMode: runSelectedAgent.chatMode === true,
    };
    const historySourceLogs = targetChatIdAtSend && !shouldCreateTargetChat
      ? stripAgentConnectionLogs(
          chatsRef.current.find(chat => chat.id === targetChatIdAtSend)?.traceLogs
          || (targetChatIdAtSend === activeChatIdRef.current ? traceLogs : [])
        )
      : [];
    lastLiveLogsSnapshotRef.current = { chatId: null, turnId: null, commitKey: null, logs: [] };
    // The reserved ID is not the composer state key until the chat is
    // committed. Clear `new_chat` for a visible fresh send, while background
    // and existing-chat sends continue clearing only their own drafts.
    clearDraftComposerState(sendTarget.fromFreshComposer ? null : targetChatIdAtSend);

    let chatIdToUse = targetChatIdAtSend;

    // Reset notification state for this chat run
    if (chatIdToUse) notifiedChatIdsRef.current.delete(chatIdToUse);

    // Use pre-uploaded media data from background uploads (already done when attached)
    const mediaAttachments: any[] = currentAttachments.map(att => ({
      id: att.id,
      name: att.name || att.file?.name || 'attachment',
      path: (att as any).localPath || getNativeFilePath(att.file) || undefined,
      mimeType: att.mimeType || att.file?.type || 'application/octet-stream',
      size: att.size || att.file?.size || 0,
      // Gemini file URIs are API-key scoped. The agent must upload with its
      // leased key instead of using any pre-send URI from the UI.
      fileUri: undefined,
    }));

    if (shouldCreateTargetChat) {
      try {
        appStorage.setItem(`eterx_proxy_controls_${ chatIdToUse }`, JSON.stringify({ enabled: proxyEnabled, intervention: proxyIntervention }));
        appStorage.setItem(`eterx_proxy_manager_model_${ chatIdToUse }`, proxyModelSelection);
        appStorage.setItem(`eterx_proxy_runtime_model_${ chatIdToUse }`, proxyRuntimeModelSelection);
      } catch { }
      if (!runOptionsOverride?.backgroundChat) {
        activeChatIdRef.current = chatIdToUse;
        setActiveChatId(chatIdToUse);
      }
      const createdComposerState: ChatComposerState = {
        inputValue: '',
        runLocation: executionRunLocation,
        selectedAgent: runSelectedAgent,
        agentMode: runAgentMode,
        thinkingLevel: runThinkingLevel,
        attachments: [],
        pinnedItems: [...runPinnedItems],
        chatModelSelection: requestedRunModelSelection,
      };
      setComposerStates(previous => {
        const next = { ...previous, [chatIdToUse!]: createdComposerState };
        try { appStorage.setItem('eterx_chat_composer_states', JSON.stringify(next)); } catch { }
        return next;
      });

      const requestedInitialTitle = String(runOptionsOverride?.initialTitle || '').trim();
      const initialTitle = !isDefaultChatTitle(requestedInitialTitle)
        ? requestedInitialTitle
        : DEFAULT_CHAT_TITLE;
      const newChat: ChatSession = {
        id: chatIdToUse,
        title: initialTitle,
        updatedAt: Date.now(),
        traceLogs: [userLog],
        workspacePath: executionWorkspacePath,
        runLocation: executionRunLocation,
      };

      setChats(prev => {
        const updated = [newChat, ...prev];
        chatsRef.current = updated;
        persistChats(updated, false, true);
        return updated;
      });
      if (!runOptionsOverride?.backgroundChat) setTraceLogs([userLog]);

      const titleChatId = chatIdToUse;
      const initialTitleHistory = [{ role: 'user', parts: [{ text: promptText }] }];
      pendingTitleRequestsRef.current.set(titleChatId, {
        history: initialTitleHistory,
        currentTitle: DEFAULT_CHAT_TITLE,
        mode: runAgentMode,
        selectedModel: runModelEntry || undefined,
      });
    } else {
      const storedTargetLogs = chatsRef.current.find(chat => chat.id === chatIdToUse)?.traceLogs;
      const baseTargetLogs = storedTargetLogs || (chatIdToUse === activeChatId ? traceLogs : []);
      const updatedLogs = [...stripAgentConnectionLogs(baseTargetLogs), userLog];
      setChatLogsById(chatIdToUse, updatedLogs, { touchUpdatedAt: true });

      // Adaptive renaming logic (every 5 messages)
      const userMessageCount = updatedLogs.filter(l => l.type === 'user_action').length;
      const targetChat = chatsRef.current.find(chat => chat.id === chatIdToUse);
      const isFirstMessageInUntitledChat = userMessageCount === 1 && (
        isDefaultChatTitle(targetChat?.title) || isGeneratedEmptyChat(targetChat)
      );
      if (isFirstMessageInUntitledChat || (userMessageCount > 1 && userMessageCount % 5 === 0)) {
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
          selectedModel: runModelEntry || undefined,
        });
      }
    }

    if (!runOptionsOverride?.backgroundChat) clearUnreadChat(chatIdToUse);

    if (!runOptionsOverride?.backgroundChat && window.innerWidth < 960) setSidebarOpen(false);

    // The user turn owns the chat as soon as it is committed. Reflect that in
    // both the synchronous lifecycle ref and React state before doing any
    // optional work, so Stop and follow-up steering work immediately.
    runningChatsRef.current = new Set(runningChatsRef.current).add(chatIdToUse!);
    setRunningChats(prev => new Set(prev).add(chatIdToUse!));

    // Naming is independent metadata. Never hold agent startup, Send, Stop, or
    // steering behind a slow title provider request.
    void runPendingTitleGeneration(chatIdToUse!);

    // Build chat history for context
    const chatHistory = buildBoundedAgentHistory(historySourceLogs);

    const isBuilderChat = !!chatIdToUse && chatIdToUse.startsWith('agent_builder_');
    const builderAgentId = isBuilderChat ? chatIdToUse!.replace('agent_builder_', '') : null;
    const runChatMode = runSelectedAgent.chatMode === true && !isBuilderChat;

    // Chat mode has a deliberately separate backend path. It receives the
    // same bounded history and media context as the normal chat request, but
    // never enters AgentRegistry, AgentOrchestrator, or an agent prompt path.
    if (runChatMode) {
      const controller = new AbortController();
      directChatRunsRef.current.add(chatIdToUse!);
      abortControllersRef.current.set(chatIdToUse!, controller);

      try {
        const response = await fetch('/api/chat/direct', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: promptText,
            history: chatHistory,
            mediaAttachments,
            projectId: chatIdToUse,
            mode: runAgentMode,
            thinkingLevel: runThinkingLevel,
            modelThinkingCapability: readRuntimeModelThinkingCapability(
              runModelEntry ? modelEntryKey(runModelEntry.provider, runModelEntry.modelId) : runModelSelection
            ),
            runId: clientRunId,
            selectedModel: runModelEntry
              ? { provider: runModelEntry.provider, modelId: runModelEntry.modelId }
              : null,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload?.error || `Chat request failed (${ response.status }).`);
        }
        if (!response.body) throw new Error('No readable stream from Chat.');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let streamCompleted = false;
        let streamAnswerText = '';
        const handleDirectEvent = (event: any) => {
          if (!event || typeof event !== 'object') return;
          if (event.type === 'trace' && event.data && typeof event.data === 'object') {
            const trace = {
              ...event.data,
              runId: clientRunId,
              turnId: clientRunId,
            };
            if (trace.type === 'answer') {
              streamAnswerText = mergeStreamingText(
                streamAnswerText,
                String(trace.text || ''),
                trace.isDelta === true,
              );
            }
            setChatLogsById(
              chatIdToUse!,
              previousLogs => processServerTraces([trace], previousLogs, chatIdToUse!),
              { touchUpdatedAt: true },
            );
          } else if (event.type === 'error') {
            throw new Error(String(event.error || 'Chat stream failed.'));
          } else if (event.type === 'done') {
            streamCompleted = true;
            const finalText = String(event.data?.text || '').trim();
            // A provider should emit answer deltas, but retain a defensive
            // final answer for adapters that finish without text chunks.
            if (!streamAnswerText.trim() && finalText) {
              setChatLogsById(
                chatIdToUse!,
                previousLogs => processServerTraces([{
                  type: 'answer',
                  answerId: `direct_answer_fallback_${ clientRunId }`,
                  text: finalText,
                  isDelta: true,
                  isStreaming: true,
                  isLiveTyping: true,
                  runId: clientRunId,
                  turnId: clientRunId,
                  timestamp: Date.now(),
                }], previousLogs, chatIdToUse!),
                { touchUpdatedAt: true },
              );
            }
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() || '';
          for (const frame of frames) {
            const dataLines = frame
              .split(/\r?\n/)
              .filter(line => line.startsWith('data:'))
              .map(line => line.slice(5).replace(/^ /, ''));
            if (!dataLines.length) continue;
            handleDirectEvent(JSON.parse(dataLines.join('\n')));
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
          const dataLines = buffer
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, ''));
          if (dataLines.length) handleDirectEvent(JSON.parse(dataLines.join('\n')));
        }
        if (!streamCompleted) throw new Error('Chat stream ended before completion.');
        if (runOptionsOverride?.backgroundChat) {
          markChatUnreadIfBackground(chatIdToUse!, `direct:${clientRunId}:completed`);
        }
        return true;
      } catch (error: any) {
        pendingTitleRequestsRef.current.delete(chatIdToUse!);
        if (error?.name === 'AbortError') return false;
        setChatLogsById(chatIdToUse!, previous => [
          ...stripAgentConnectionLogs(previous),
          agentStatusLog('failed', 'Chat failed', String(error?.message || error).slice(0, 240)),
        ], { touchUpdatedAt: true });
        if (shouldRestoreComposer) {
          restoreComposerDraftIfEmpty(chatIdToUse, originalComposerInput, originalComposerAttachments);
        }
        if (runOptionsOverride?.backgroundChat) {
          markChatUnreadIfBackground(chatIdToUse!, `direct:${clientRunId}:failed`);
        }
        return false;
      } finally {
        directChatRunsRef.current.delete(chatIdToUse!);
        if (abortControllersRef.current.get(chatIdToUse!) === controller) {
          abortControllersRef.current.delete(chatIdToUse!);
        }
        removeRunningChat(chatIdToUse!);
        sendAdmissionsRef.current.delete(admissionKey);
      }
    }

    const subAgentSettings = readStoredSubAgentSettings();
    const selectedCustomRuntimeId = runSelectedAgentId && runSelectedAgentId !== 'coding' && runSelectedAgentId !== 'autonomous' && !isBuilderChat
      ? runSelectedAgentId
      : null;
    // Custom agents use the same provider-aware Main Agent transport as every
    // other runtime. The selected custom ID/name is sent below and /api/chat
    // loads the profile into the shared registry, so history, work notes,
    // tools, stopping, polling, recovery, and persistence all follow one
    // lifecycle instead of diverging through a Gemini-only side channel.
    const useLegacyCustomAgentRunner = false;

    if (useLegacyCustomAgentRunner) {
      const controller = new AbortController();
      abortControllersRef.current.set(chatIdToUse!, controller);
      const answerLogId = `custom_agent_answer_${ runStartedAt }`;
      let pendingCustomText = '';
      let customTraceSeq = 0;
      let customWorkNoteSeq = 0;
      let customOutcome: 'completed' | 'failed' | null = null;
      let customStreamCompleted = false;
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
          isStreaming: isLive,
          isLiveTyping: isLive,
          streamState: isLive ? 'open' : 'closed',
          final: !isLive,
          wasStreaming: true,
          runId: clientRunId,
          turnId: clientRunId,
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
        // setChatLogsById updates both the active-feed state and the durable
        // chat map. React may invoke either updater more than once in
        // development, so allocate identity metadata before entering the
        // updater; otherwise the two copies can receive different trace IDs.
        const hasRealChildIdentity = Boolean(
          log?.subAgentId
          || log?.subAgentChatId
          || log?.auxiliaryRuntime
          || /^sub_agent_/.test(String(log?.type || ''))
          || ['inter_agent_comm', 'inter_agent_message'].includes(String(log?.type || '')),
        );
        // A custom agent is the owner of its own work notes and tool cards.
        // Older adapters stamped the selected custom name into `subAgent`,
        // which made the main feed open a delegated-agent view for normal
        // custom work. Preserve that field only for an actual child run.
        const { subAgent: _ownedSubAgent, ...customLog } = log || {};
        const enriched = {
          ...(hasRealChildIdentity ? log : customLog),
          runId: log.runId || clientRunId,
          turnId: log.turnId || clientRunId,
          customAgentId: runSelectedAgentId,
          agentName: hasRealChildIdentity
            ? String(log.agentName || log.subAgent || runSelectedAgentName)
            : runSelectedAgentName,
          agentRuntime: 'custom_agent',
          _traceIdx: customTraceSeq++,
        };
        setChatLogsById(chatIdToUse!, logs => {
          const cleanLogs = stripAgentConnectionLogs(logs);

          if (enriched.type === 'console_output') {
            const existingIdx = findMergeableConsoleOutputIndex(cleanLogs, enriched);
            if (existingIdx >= 0) {
              const next = [...cleanLogs];
              next[existingIdx] = {
                ...mergeConsoleOutputTrace(next[existingIdx], enriched),
                _traceIdx: next[existingIdx]._traceIdx ?? enriched._traceIdx,
                startTime: next[existingIdx].startTime || enriched.startTime,
              };
              return next;
            }
          }

          return [...cleanLogs, enriched];
        }, { touchUpdatedAt: true });
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
        const noteLog = createCustomWorkNoteLog(
          cleanText,
          agentName,
          `custom_status_${at}_${Math.random().toString(36).slice(2, 8)}`,
          at,
        );
        if (noteLog) appendCustomAgentTrace(noteLog);
      };

      const failCustomAgent = (title: string, message: string) => {
        if (customOutcome === 'failed' || customOutcome === 'completed') return;
        customOutcome = 'failed';
        if (pendingCustomText.trim()) {
          setCustomAgentAnswer(pendingCustomText, false);
          pendingCustomText = '';
        }
        setChatLogsById(chatIdToUse!, logs => [
          ...stripAgentConnectionLogs(logs),
          agentStatusLog('failed', title, String(message || 'Custom agent failed.').slice(0, 240)),
        ], { touchUpdatedAt: true });
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

      const customToolTraceKey = (event: any) => String(event?.toolCallId || `${ String(event?.agentName || runSelectedAgentName) }:${ String(event?.toolName || '') }`);

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
        const runLocationVal = executionRunLocation;
        const response = await fetch('/api/agents/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: runSelectedAgentId,
            chatId: chatIdToUse,
            messages: runnerMessages,
            mode: runAgentMode,
            model: runModelEntry?.modelId,
            runLocation: runLocationVal,
            pinnedContext: {
              terminalShell: readStoredTerminalShell(),
              allowBrowserControl: readStoredBrowserAccess(),
              allowHostControl: readStoredComputerUse(),
              computerUseEnabled: readStoredComputerUse(),
              synapseGraphEnabled: readStoredSynapseGraphEnabled(),
              selfImprovementEnabled: readStoredSelfImprovementEnabled(),
              disableSubAgents: !subAgentSettings.enabled,
              allowAgentSpawning: subAgentSettings.enabled,
              maxSubAgents: subAgentSettings.maxSubAgents,
              maxRetries: subAgentSettings.maxRetries,
              ...(runPinnedItems.length > 0 ? { paths: runPinnedItems.map(item => item.path) } : {}),
              ...(executionWorkspacePath ? {
                paths: [executionWorkspacePath, ...runPinnedItems.map(item => item.path)],
                workspacePath: executionWorkspacePath,
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
          failCustomAgent('Custom agent unavailable', message);
          if (shouldRestoreComposer) {
            restoreComposerDraftIfEmpty(chatIdToUse, originalComposerInput, originalComposerAttachments);
          }
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
            if (pendingCustomText.trim()) setCustomAgentAnswer(pendingCustomText, true);
          } else if (event.type === 'work_note') {
            const noteLog = createCustomWorkNoteLog(
              String(event.text || ''),
              String(event.agentName || runSelectedAgentName),
              `custom_work_${runStartedAt}_${customWorkNoteSeq++}`,
              Number(event.timestamp || Date.now()),
            );
            if (noteLog) appendCustomAgentTrace(noteLog);
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
              toolCallId: event.toolCallId ? String(event.toolCallId) : undefined,
              toolName: String(actionLog.tool || event.toolName || ''),
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
          } else if (event.type === 'console_output') {
            // Terminal tools stream authoritative output through the runner's
            // tool context. Preserve it in custom-agent chats instead of
            // waiting for the tool_result event, which may arrive much later.
            const at = Number(event.timestamp || Date.now());
            appendCustomAgentTrace({
              ...event,
              id: String(event.id || `custom_console_${at}_${Math.random().toString(36).slice(2, 8)}`),
              type: 'console_output',
              startTime: event.startTime || at,
              endTime: event.endTime || (event.isStreaming ? undefined : at),
              timestamp: at,
            });
          } else if (event.type === 'error') {
            failCustomAgent('Custom agent run failed', String(event.text || event.error || 'Custom agent failed.'));
          } else if (event.type === 'done') {
            customStreamCompleted = true;
            if (pendingCustomText.trim()) {
              setCustomAgentAnswer(pendingCustomText, false);
              pendingCustomText = '';
              if (customOutcome !== 'failed') customOutcome = 'completed';
            } else if (customOutcome !== 'failed') {
              failCustomAgent('Custom agent returned no answer', 'The custom agent completed without a final response.');
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
            } catch {
              failCustomAgent('Custom agent protocol error', 'The custom agent returned malformed stream data.');
            }
          }
        }

        if (buffer.trim()) {
          try {
            handleRunnerEvent(JSON.parse(buffer.trim()));
          } catch {
            failCustomAgent('Custom agent protocol error', 'The custom agent returned malformed stream data.');
          }
        }
        if (!customStreamCompleted && customOutcome !== 'failed' && !controller.signal.aborted) {
          failCustomAgent('Custom agent stream incomplete', 'The custom agent stream ended before its completion event.');
        }
        if (pendingCustomText.trim() && customOutcome === 'failed') {
          setCustomAgentAnswer(pendingCustomText, false);
          pendingCustomText = '';
        }
      } catch (error: any) {
        if (error.name !== 'AbortError') {
          failCustomAgent('Custom agent connection failed', String(error.message || error));
          if (shouldRestoreComposer) {
            restoreComposerDraftIfEmpty(chatIdToUse, originalComposerInput, originalComposerAttachments);
          }
        } else if (pendingCustomText.trim()) {
          setCustomAgentAnswer(pendingCustomText, false);
          pendingCustomText = '';
        }
      } finally {
        sendAdmissionsRef.current.delete(admissionKey);
        if (abortControllersRef.current.get(chatIdToUse!) === controller) {
          abortControllersRef.current.delete(chatIdToUse!);
        }
        removeRunningChat(chatIdToUse!);
        // The dedicated custom runner does not have Main's server poller to
        // perform the terminal snapshot flush. Commit the complete current
        // chat after every custom turn so prior turns, work notes, tool cards,
        // and the final answer survive navigation or an app restart.
        setChats(currentChats => {
          void persistChats(currentChats, false, true);
          return currentChats;
        });
        if (customOutcome) {
          markChatUnreadIfBackground(chatIdToUse!, `custom:${clientRunId}:${customOutcome}`);
        }
      }
      return customOutcome === 'completed';
    }

    // ═══════════════════════════════════════════════════════════════
    // FIRE-AND-FORGET: Start the SSE stream (backward compatible)
    // The agent runs via AgentRegistry on the server. Even if this
    // SSE stream drops, the agent keeps running. We also start
    // a polling loop as backup/primary for trace updates.
    // ═══════════════════════════════════════════════════════════════

    const requestPinnedContext = {
      terminalShell: readStoredTerminalShell(),
      allowBrowserControl: readStoredBrowserAccess(),
      allowHostControl: readStoredComputerUse(),
      computerUseEnabled: readStoredComputerUse(),
      contextCompaction: readContextCompactionSettings(contextBudgetModelEntry, chatIdToUse),
      synapseGraphEnabled: readStoredSynapseGraphEnabled(),
      selfImprovementEnabled: readStoredSelfImprovementEnabled(),
      // Relay the live Settings > Sub-agents values for General as well as
      // Autonomous/custom runs. readStoredSubAgentSettings reads appStorage
      // at send time, so a recent panel change cannot be stale in this run.
      ...buildSubAgentPinnedContext(subAgentSettings),
      ...(runPinnedItems.length > 0 ? { paths: runPinnedItems.map(p => p.path) } : {}),
      ...(isBuilderChat ? {
        agentRuntime: 'agent_builder',
        agentId: builderAgentId,
        ...(buildingAgentName ? { agentName: buildingAgentName } : {}),
      } : {}),
      ...(runSelectedAgentId === 'coding' && !isBuilderChat ? { agentRuntime: 'main_coding_agent', agentProfile: 'eterx-code' } : {}),
      ...(runSelectedAgentId === 'autonomous' && !isBuilderChat ? {
        agentRuntime: 'autonomy_v1',
        autonomy: {
          enabled: executionProxyEnabled,
          collaboration: 'user_proxy',
          initiative: 'high',
          verification: 'adaptive',
          intervention: executionProxyIntervention,
          proxyModelSelection: executionProxyRuntimeModelSelection === AUTO_MODEL_SELECTION
            ? requestedRunModelSelection
            : executionProxyRuntimeModelSelection,
        },
      } : {}),
      ...(executionWorkspacePath ? {
        paths: [executionWorkspacePath, ...(runPinnedItems.length > 0 ? runPinnedItems.map(p => p.path) : [])],
        workspacePath: executionWorkspacePath,
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
      const runLocationVal = executionRunLocation;
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
          // Auto resolves to the concrete model entry chosen from the live
          // selector catalog. Keep that primary exact model authoritative too;
          // do not silently replace it with a stale/static fallback name.
          strictModelSelection: Boolean(runModelEntry),
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
        let errorPayload: any = {};
        try {
          errorPayload = await response.json();
          message = errorPayload.error || errorPayload.details || message;
        } catch { }

        if (errorPayload?.status === 'cancelled') {
          stopPolling(chatIdToUse!);
          pendingTitleRequestsRef.current.delete(chatIdToUse!);
          removeRunningChat(chatIdToUse!);
          return false;
        }

        const alreadyRunning = errorPayload?.status === 'already_running' ||
          /already running for this chat|previous run is still shutting down/i.test(String(message));
        if (alreadyRunning && chatIdToUse) {
          const existingRunId = String(errorPayload?.runId || '').trim();
          if (existingRunId) {
            // The conflict response is authoritative. Replace the attempted
            // run ownership before reconnecting the poller to the real run.
            pollRunStartRef.current.delete(chatIdToUse);
            pollRunIdRef.current.set(chatIdToUse, existingRunId);
            setRunningChats(previous => new Set(previous).add(chatIdToUse!));
            startPolling(chatIdToUse, -1, undefined, existingRunId);
          }

          // The optimistic user boundary belongs to the attempted fresh run.
          // Remove it before steering/queueing so a queued follow-up is not
          // rendered twice and a steer appears as one acknowledged update.
          setChatLogsById(chatIdToUse, previous => previous.filter(log =>
            !(log?.type === 'user_action' && String(log.runId || log.turnId || '') === clientRunId)
          ));
          pendingTitleRequestsRef.current.delete(chatIdToUse);
          const delivered = await deliverFollowUpToRunningChat(
            chatIdToUse,
            promptText,
            currentAttachments,
            existingRunId || undefined,
            shouldRestoreComposer,
          );
          if (delivered) {
            sendAdmissionsRef.current.delete(admissionKey);
            return true;
          }

          // Preserve the message in the composer if the backend run changed
          // again before either delivery path could accept it.
          if (activeChatIdRef.current === chatIdToUse) {
            updateInputValue(current => current.trim() ? current : promptText);
            updateAttachments(current => current.length > 0 ? current : currentAttachments);
          }
          return false;
        }

        stopPolling(chatIdToUse!);
        pendingTitleRequestsRef.current.delete(chatIdToUse!);
        removeRunningChat(chatIdToUse!);
        markChatUnreadIfBackground(chatIdToUse!, `run:${clientRunId}:start-error`);
        setChatLogsById(chatIdToUse!, prev => [
          ...stripAgentConnectionLogs(prev),
          agentStatusLog('failed', 'Agent unavailable', message)
        ]);
        if (shouldRestoreComposer) {
          restoreComposerDraftIfEmpty(chatIdToUse, originalComposerInput, originalComposerAttachments);
        }
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
        const messages = sseBuffer.split(/\r?\n\r?\n/);
        sseBuffer = messages.pop() || '';

        for (const chunk of messages) {
          const trimmed = chunk.trim();
          const dataLines = trimmed
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, ''));
          if (!dataLines.length) continue;
          try {
            const parsed = JSON.parse(dataLines.join('\n'));

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
          markChatUnreadIfBackground(chatIdToUse!, `run:${clientRunId}:connection-error`);
          setChatLogsById(chatIdToUse!, prev => [
            ...stripAgentConnectionLogs(prev),
            agentStatusLog('failed', 'Agent connection failed', String(error.message || error).slice(0, 180))
          ]);
          if (shouldRestoreComposer) {
            restoreComposerDraftIfEmpty(chatIdToUse, originalComposerInput, originalComposerAttachments);
          }
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

  const sendQueuedFollowUp = async (item: QueuedFollowUp): Promise<boolean> => {
    const targetChatId = item.chatId;
    if (!targetChatId || !item.id) return false;
    if (queuedFollowUpDispatchRef.current.has(item.id)) return false;

    queuedFollowUpDispatchRef.current.add(item.id);
    try {
      if (item.serverBacked === false) {
        setQueuedFollowUps(previous => {
          const sameChat = previous.filter(message => message.chatId === targetChatId);
          const selected = sameChat.find(message => message.id === item.id);
          if (!selected) return previous;
          return [
            ...previous.filter(message => message.chatId !== targetChatId),
            selected,
            ...sameChat.filter(message => message.id !== item.id),
          ];
        });
        return true;
      }
      const response = await fetch('/api/agent/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'prioritize', chatId: targetChatId, id: item.id }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.success !== true) return false;
      reconcileServerQueuedFollowUps(targetChatId, payload.items || []);
      return true;
    } finally {
      queuedFollowUpDispatchRef.current.delete(item.id);
    }
  };

  const removeQueuedFollowUp = async (item: QueuedFollowUp): Promise<boolean> => {
    if (!item.chatId || !item.id) return false;
    if (item.serverBacked === false) {
      setQueuedFollowUps(previous => previous.filter(message => message.id !== item.id));
      if (item.admissionKey) {
        queuedFollowUpAdmissionsRef.current.delete(item.admissionKey);
        queuedFollowUpIdsRef.current.delete(item.admissionKey);
      }
      return true;
    }
    try {
      const response = await fetch('/api/agent/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', chatId: item.chatId, id: item.id }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 404) return false;
      setQueuedFollowUps(previous => previous.filter(message => message.id !== item.id));
      if (item.admissionKey) {
        queuedFollowUpAdmissionsRef.current.delete(item.admissionKey);
        queuedFollowUpIdsRef.current.delete(item.admissionKey);
      }
      if (Array.isArray(payload?.items)) reconcileServerQueuedFollowUps(item.chatId, payload.items);
      return true;
    } catch {
      return false;
    }
  };

  const handleSendLatestRef = useRef(handleSend);
  handleSendLatestRef.current = handleSend;
  const scheduledRunContextRef = useRef({ activeWorkspacePath, activeRunLocation });
  scheduledRunContextRef.current = { activeWorkspacePath, activeRunLocation };

  // The Electron gateway owns transport connections and durable dedupe state.
  // The renderer stays alive (hidden to tray) and turns normalized channel
  // inputs into ordinary EterX chats so they use the same agent lifecycle,
  // policies, memory, and monitor surface as user-created work.
  useEffect(() => {
    const desktopApi = (window as any).electronAPI;
    if (!desktopApi?.onGatewayInput) return;

    // Preserve message order within one conversation, but never let a slow
    // terminal command in one gateway chat block unrelated conversations.
    const dispatchChains = new Map<string, Promise<void>>();
    const processGatewayInput = async (input: any) => {
      if (!input?.id || !input?.conversationId) return;
      try {
        const gatewayState = await desktopApi.getGatewayState?.();
        if (gatewayState?.config?.autoDispatch !== true) return;

        const channelAgentConfig = gatewayState?.config?.channelAgent;
        if (channelAgentConfig?.enabled !== true) return;
        const profiles = Array.isArray(channelAgentConfig?.profiles) ? channelAgentConfig.profiles : [];
        const selectedChannelProfile = profiles.find((profile: any) => Array.isArray(profile?.channels) && profile.channels.includes(String(input.platform || '').toLowerCase()))
          || profiles.find((profile: any) => profile?.id === channelAgentConfig?.defaultProfileId)
          || profiles[0];
        // A connected transport may keep receiving in the background, but a
        // manual profile must never turn those events into agent runs.
        if (!selectedChannelProfile || selectedChannelProfile.operatingMode === 'manual') return;

        const safeConversationId = String(input.conversationId)
          .replace(/[^a-zA-Z0-9_-]+/g, '_')
          .slice(0, 120);
        const gatewayChatId = `gateway_${safeConversationId}`;
        const platformName = String(input.platform || 'channel');
        const actorName = input.actor?.displayName || input.actor?.username || 'Channel user';
        const attachmentContext = Array.isArray(input.attachments) && input.attachments.length > 0
          ? `\n\nAttachments received:\n${input.attachments.map((item: any) => `- ${item.name || item.type || 'attachment'}${item.url || item.path ? `: ${item.url || item.path}` : ''}`).join('\n')}`
          : '';
        const policyHint = selectedChannelProfile
          ? `\n\nBefore drafting, call channel_agent with action=prepare_reply, profile_id=${selectedChannelProfile.id}, and conversation_id=${input.conversationId}. Load its policy on demand. Do not call send_reply for this event; the background delivery layer will send only when this profile is explicitly autonomous.`
          : '';
        const prompt = `[Incoming ${platformName} message from ${actorName}]\n\n${String(input.text || '').trim() || 'The user sent an attachment.'}${attachmentContext}${policyHint}`;
        const existing = chatsRef.current.find((chat) => chat.id === gatewayChatId);
        const session: ChatSession = existing
          ? { ...existing, updatedAt: Date.now(), title: existing.title || `${actorName} · ${platformName}` }
          : {
              id: gatewayChatId,
              title: `${actorName} · ${platformName}`,
              updatedAt: Date.now(),
              traceLogs: [],
              workspacePath: scheduledRunContextRef.current.activeWorkspacePath,
              runLocation: scheduledRunContextRef.current.activeRunLocation,
            };

        try {
          const replyTargets = JSON.parse(appStorage.getItem('eterx_gateway_reply_targets') || '{}');
          replyTargets[gatewayChatId] = { platform: input.platform, target: input.replyTarget, profileId: selectedChannelProfile?.id, operatingMode: selectedChannelProfile?.operatingMode || 'manual', sendPolicy: selectedChannelProfile?.sendPolicy || 'direct', updatedAt: Date.now() };
          appStorage.setItem('eterx_gateway_reply_targets', JSON.stringify(replyTargets));
        } catch { }

        setChats((previous) => {
          const next = [session, ...previous.filter((chat) => chat.id !== gatewayChatId)];
          chatsRef.current = next;
          persistChats(next);
          return next;
        });
        const accepted = await handleSendLatestRef.current(prompt, [], gatewayChatId, {
          // Keep gateway conversations pinned to their own device/workspace
          // even when the visible UI has switched to another chat.
          workspacePath: session.workspacePath ?? scheduledRunContextRef.current.activeWorkspacePath,
          runLocation: session.runLocation ?? scheduledRunContextRef.current.activeRunLocation,
        });
        if (accepted) await desktopApi.acknowledgeGatewayInput?.(input.id);
      } catch (error) {
        console.error('[EterX Gateway] Could not dispatch normalized input:', error);
      }
    };

    const enqueue = (input: any) => {
      const key = String(input?.conversationId || 'unknown');
      const previous = dispatchChains.get(key) || Promise.resolve();
      let next!: Promise<void>;
      next = previous
        .catch(() => undefined)
        .then(() => processGatewayInput(input))
        .finally(() => {
          if (dispatchChains.get(key) === next) dispatchChains.delete(key);
        });
      dispatchChains.set(key, next);
    };
    const unsubscribe = desktopApi.onGatewayInput(enqueue);
    const claimPending = () => void desktopApi.claimGatewayInputs?.(50).then((pending: any[]) => {
      for (const input of Array.isArray(pending) ? pending : []) enqueue(input);
    }).catch(() => undefined);
    claimPending();

    // Native events are the fast path. This reconciliation pass makes delivery
    // durable if an IPC event is missed while the window is hidden or waking.
    // The selected profile interval is respected without injecting its full
    // operating prompt into every chat.
    let lastReconciliationAt = 0;
    const reconciliationTimer = window.setInterval(() => {
      void desktopApi.getGatewayState?.().then((state: any) => {
        const config = state?.config;
        const channelAgent = config?.channelAgent;
        const activeProfiles = Array.isArray(channelAgent?.profiles)
          ? channelAgent.profiles.filter((profile: any) => profile?.operatingMode === 'assist' || profile?.operatingMode === 'autonomous')
          : [];
        if (config?.autoDispatch !== true || channelAgent?.enabled !== true || activeProfiles.length === 0) return;
        const intervalMinutes = Math.max(1, Math.min(...activeProfiles.map((profile: any) => Number(profile?.pollIntervalMinutes) || 5)));
        const now = Date.now();
        if (now - lastReconciliationAt < intervalMinutes * 60_000) return;
        lastReconciliationAt = now;
        claimPending();
      }).catch(() => undefined);
    }, 60_000);

    return () => {
      window.clearInterval(reconciliationTimer);
      unsubscribe?.();
    };
  }, [markChatUnreadIfBackground]);

  // Queued follow-ups are owned and dispatched by AgentRegistry. The renderer
  // only mirrors the authoritative queue returned by the poll/queue APIs, so a
  // tab reload or hidden desktop window cannot strand the next turn.
  useEffect(() => {
    const next = queuedFollowUps.find(item =>
      item.serverBacked === false &&
      !runningChats.has(item.chatId) &&
      !queuedFollowUpDispatchRef.current.has(item.id)
    );
    if (!next) return;
    queuedFollowUpDispatchRef.current.add(next.id);
    let started = false;
    const timer = window.setTimeout(() => {
      started = true;
      void handleSend(next.text, next.attachments, next.chatId, next.runOptions).then(accepted => {
        if (!accepted) return;
        setQueuedFollowUps(previous => previous.filter(item => item.id !== next.id));
        if (next.admissionKey) {
          queuedFollowUpAdmissionsRef.current.delete(next.admissionKey);
          queuedFollowUpIdsRef.current.delete(next.admissionKey);
        }
      }).finally(() => {
        queuedFollowUpDispatchRef.current.delete(next.id);
      });
    }, 0);
    return () => {
      if (started) return;
      window.clearTimeout(timer);
      queuedFollowUpDispatchRef.current.delete(next.id);
    };
  }, [queuedFollowUps, runningChats]); // eslint-disable-line react-hooks/exhaustive-deps

  // Automated real-time agent execution when scheduled task triggers
  useEffect(() => {
    const handleTriggerTask = (e: CustomEvent<{ task: any }>) => {
      const rawTask = e.detail?.task;
      if (!rawTask?.id) return;
      const task = normalizeScheduledTask(rawTask);
      if (scheduledTaskRunAdmissionsRef.current.has(task.id)) return;
      scheduledTaskRunAdmissionsRef.current.add(task.id);

      const taskChatId = task.chatId || crypto.randomUUID();
      const taskRunId = `scheduled_run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const runStartedAt = Date.now();
      const sourceContext = task.sources.length > 0
        ? `\n\nScheduled task sources:\n${task.sources.map(source => `- ${source.name}: ${source.path}`).join('\n')}`
        : '';
      const taskPrompt = `${task.description || task.title}${sourceContext}`;
      const updateStoredTask = (mutate: (target: ScheduledTaskRecord, run: ScheduledTaskRun | undefined) => void) => {
        try {
          const parsed = JSON.parse(appStorage.getItem(SCHEDULED_TASKS_STORAGE_KEY) || '[]');
          const tasks = Array.isArray(parsed) ? parsed.map(normalizeScheduledTask) : [];
          const target = tasks.find(item => item.id === task.id);
          if (!target) return;
          mutate(target, target.history?.find(run => run.id === taskRunId));
          target.updatedAt = Date.now();
          persistScheduledTaskRecords(tasks);
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

      const resolvedModel = task.model || AUTO_MODEL_SELECTION;
      const taskChatExists = chatsRef.current.some(chat => chat.id === taskChatId);
      const dispatchPromise = handleSendLatestRef.current(taskPrompt, [], taskChatId, {
        modelSelection: resolvedModel,
        selectedAgent: {
          agentId: task.agentId || null,
          agentName: task.agentName || 'General',
        },
        thinkingLevel: task.thinkingLevel,
        createNewChat: !taskChatExists,
        backgroundChat: true,
        initialTitle: task.title || DEFAULT_CHAT_TITLE,
        workspacePath: task.workspacePath ?? scheduledRunContextRef.current.activeWorkspacePath,
        runLocation: task.runLocation ?? scheduledRunContextRef.current.activeRunLocation,
        pinnedItems: task.sources.map(source => ({
          id: source.id,
          type: source.type === 'folder' ? 'folder' as const : 'file' as const,
          path: source.path,
          name: source.name,
        })),
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
          const nextRun = computeNextScheduledRun(target.recurrence, completedAt);
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
        let appDataChats: ChatSession[] = [];
        let snapshot: any = null;
        try {
          const response = await fetch('/api/chats', { cache: 'no-store' });
          if (response.ok) {
            snapshot = await response.json();
            if (Array.isArray(snapshot?.chats)) appDataChats = snapshot.chats;
          }
        } catch { }
        if (!Array.isArray(snapshot?.chats)) return;
        const savedById = new Map<string, ChatSession>();
        for (const chat of appDataChats) {
          if (chat?.id) savedById.set(String(chat.id), chat);
        }
        // Preserve a local mutation made while the fallback request was in
        // flight, but never let an older in-memory record hide a newer durable
        // record. This fallback is intentionally safe when the primary
        // restore request lost a race with the local server startup.
        for (const chat of chatsRef.current) {
          if (!chat?.id) continue;
          const durable = savedById.get(String(chat.id));
          if (!durable || Number(chat.updatedAt || 0) >= Number(durable.updatedAt || 0)) {
            savedById.set(String(chat.id), chat);
          }
        }
        const savedChats = sortChats(Array.from(savedById.values()));
        const fallbackSavedAt = Number(snapshot?.savedAt || 0);
        lastChatSnapshotAtRef.current = Math.max(
          lastChatSnapshotAtRef.current,
          Number.isFinite(fallbackSavedAt) ? fallbackSavedAt : 0,
        );

        // The delayed fallback used to reconcile running agents only. If the
        // first restore request failed during Next.js warm-up, it could fetch
        // a valid snapshot here and still leave the sidebar empty because no
        // trace/status update happened to call setChats. Install the snapshot
        // before asking the agent registry for running work.
        chatSnapshotReadyRef.current = true;
        if (savedChats.length > 0) {
          setChats(currentChats => {
            const merged = new Map(savedChats.map(chat => [chat.id, chat]));
            for (const currentChat of currentChats) {
              const durableChat = merged.get(currentChat.id);
              if (!durableChat || Number(currentChat.updatedAt || 0) > Number(durableChat.updatedAt || 0)) {
                merged.set(currentChat.id, currentChat);
              }
            }
            return sortChats(Array.from(merged.values()));
          });
        }
        if (savedChats.length === 0) return;

        // Reconcile recent chats with persisted task traces. This also restores
        // the final UI state of work interrupted by an application restart.
        for (const chat of savedChats.slice(0, 100)) {
          try {
            const data = await fetchAgentPoll(chat.id, -1, 5000);
            reconcileServerQueuedFollowUps(chat.id, data.queuedFollowUps);

            if ((data.traces && data.traces.length > 0) || isTerminalAgentStatus(data.status)) {
              setChats(prev => {
                const updated = prev.map(c => {
                  if (c.id !== chat.id) return c;
                  const runIdentity = { runId: data.runId, startedAt: data.startedAt };
                  const ownsLatestTurn = canMergeServerRunIntoLatestTurn(c.traceLogs || [], runIdentity);
                  let restoredLogs = mergeServerRunLogs(c.traceLogs || [], data.traces, {
                    chatId: chat.id,
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
              startPolling(chat.id, getPollCursor(data), data.startedAt, data.runId);
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
        if (activePollersRef.current.has(targetChatId)) {
          catchUpPollersRef.current.get(targetChatId)?.();
          return;
        }
        const observedPollGeneration = pollGenerationRef.current.get(targetChatId) || 0;
        // User returned to tab — check if active chat's agent is still running
        fetchAgentPoll(targetChatId, -1, 5000)
          .then(data => {
            if (!chatsRef.current.some(chat => chat.id === targetChatId)) return;
            reconcileServerQueuedFollowUps(targetChatId, data.queuedFollowUps);
            if (
              activePollersRef.current.has(targetChatId) ||
              (pollGenerationRef.current.get(targetChatId) || 0) !== observedPollGeneration
            ) return;
            if (data.status === 'running') {
              // Agent is running but we're not polling! Restart polling.
              console.log('[Visibility] Reconnecting to running agent...');
              setRunningChats(prev => new Set(prev).add(targetChatId));

              if (data.traces && data.traces.length > 0) {
                setChatLogsById(targetChatId, previousLogs => mergeServerRunLogs(previousLogs, data.traces, {
                  chatId: targetChatId,
                  runId: data.runId,
                  startedAt: data.startedAt,
                }));
              }

              startPolling(targetChatId, getPollCursor(data), data.startedAt, data.runId);
            } else if (isTerminalAgentStatus(data.status)) {
              removeRunningChat(targetChatId);
            } else if (data.status === 'idle' && runningChatsRef.current.has(targetChatId)) {
              // Keep a pending startup alive; the poller owns the bounded
              // timeout and will surface a failure if the run never appears.
              startPolling(
                targetChatId,
                -1,
                pollRunStartRef.current.get(targetChatId),
                pollRunIdRef.current.get(targetChatId),
              );
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
      log => {
        const owners = [log?.chatId, log?.ownerChatId]
          .map(value => String(value || '').trim())
          .filter(Boolean);
        return owners.length === 0 || owners.includes(String(activeChatId || '').trim());
      }
    );
    // Live thought rows are already the complete cumulative stream produced by
    // the agent. Keep them in the main feed; getLiveTraceLogs only reconstructs
    // the current voice/session turn around those rows.
    const baseLogs = ownedTraceLogs.filter(log =>
      !(log?.isLive && log.type === 'work_note')
    );

    // Filter out sub-agent details when we are in the main view
    const filteredLogs = baseLogs.filter(l => {
      if (!l) return false;
      const logAgentName = l.subAgent || l.agentName;
      const isSubAgentLifecycle = /^sub_agent_/.test(String(l.type || ''));
      const hasChildIdentity = Boolean(l.subAgentChatId || l.subAgentId);
      const isCustomAgentMainLog = Boolean(l.customAgentId) && !hasChildIdentity;
      const isSubAgentLog = hasChildIdentity
        || (l.subAgent && l.subAgent !== 'Main')
        || (isSubAgentLifecycle && logAgentName && logAgentName !== 'Main');
      if (isCustomAgentMainLog) return true;
      if (isSubAgentLog) {
        if (l.type === 'inter_agent_message') {
          return l.to === 'Main' || l.to === '*' || l.broadcast === true;
        }
        // Main keeps compact lifecycle/reporting boundaries while detailed
        // worker actions remain isolated in the exact child-run tab.
        return ['sub_agent_spawn', 'sub_agent_answer', 'sub_agent_result', 'sub_agent_complete', 'sub_agent_error', 'sub_agent_pause', 'sub_agent_resume', 'sub_agent_close'].includes(String(l.type || ''));
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

    return canonicalizeClientTraceLogs([...filteredLogs, ...liveLogs], activeChatId || undefined);
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
      String(log?.subAgentChatId || log?.subAgentId || log?.agentId || name);
    const findLatestAgentKeyByName = (name: string) =>
      [...agentMap.entries()].reverse().find(([, agent]) => String(agent?.name || '').toLowerCase() === name.toLowerCase())?.[0];
    const findExistingAgentKey = (log: any, name: string) =>
      [...agentMap.entries()].reverse().find(([key, agent]) =>
        agentIdentitiesOverlap(
          { ...agent, id: key },
          { ...log, agentName: name, subAgent: name },
        )
      )?.[0];
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
        const reportedStatus = String(log.agentStatus || '').trim().toLowerCase();
        if (log.type === 'sub_agent_pause' || reportedStatus === 'paused') {
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
      if (log.type === 'sub_agent_spawn' && Array.isArray(log.agentDetails)) {
        for (const detail of log.agentDetails) {
          const detailName = String(detail?.name || '').trim();
          if (!detailName) continue;
          const detailIdentity = String(detail?.subAgentChatId || detail?.subAgentId || detail?.agentId || detailName);
          const existing = agentMap.get(detailIdentity);
          agentMap.set(detailIdentity, {
            id: detailIdentity,
            subAgentId: detail?.subAgentId || detail?.agentId || existing?.subAgentId,
            subAgentChatId: detail?.subAgentChatId || existing?.subAgentChatId,
            name: detailName,
            status: ['completed', 'error', 'closed', 'paused'].includes(String(existing?.status))
              ? existing.status
              : String(detail?.status || 'working'),
            task: detail?.task || existing?.task || '',
            unreadCount: Number(existing?.unreadCount || 0),
            stepCount: Number(existing?.stepCount || 0),
            durationMs: Number(existing?.durationMs || 0),
            startedAt: existing?.startedAt || getTraceEventTime(log) || firstTraceAt,
          });
        }
      }
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
      const existingAgentKey = findExistingAgentKey(log, name);
      const agentIdentity = existingAgentKey || (explicitIdentity
        ? getSubAgentIdentity(log, name)
        : findLatestAgentKeyByName(name) || name);
      const hasSubAgentIdentity = Boolean(log.subAgentChatId || log.subAgentId || log.subAgent);

      if (!agentMap.has(agentIdentity) && (
        /^sub_agent_(?:spawn|action|answer|result|complete|error|pause|resume|close)$/.test(String(log.type || '')) ||
        hasSubAgentIdentity
      )) {
        agentMap.set(agentIdentity, {
          id: agentIdentity,
          subAgentId: log.subAgentId,
          subAgentChatId: log.subAgentChatId,
          name,
          status: ['sub_agent_answer', 'sub_agent_result', 'sub_agent_complete'].includes(log.type) ? 'completed'
            : log.type === 'sub_agent_error' ? 'error'
              : log.type === 'sub_agent_pause' ? 'paused'
                : log.type === 'sub_agent_close' ? 'closed'
                  : 'working',
          task: log.task || log.secondary || (log.type === 'sub_agent_spawn' ? log.text : '') || '',
          unreadCount: Number(log.unreadCount || 0),
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
          name,
          status: ['completed', 'error', 'closed', 'paused'].includes(String(existing?.status)) ? existing.status : 'working',
          task: log.task || log.secondary || log.text || '',
          unreadCount: Number(log.unreadCount ?? existing?.unreadCount ?? 0),
          stepCount: 0, durationMs: 0, startedAt: existing?.startedAt || getTraceEventTime(log) || firstTraceAt,
        });
      } else if (log.type === 'sub_agent_action') {
        const a = agentMap.get(agentIdentity);
        const reportedStatus = String(log.agentStatus || '').trim().toLowerCase();
        if (a && !['completed', 'error', 'closed', 'paused'].includes(String(a.status)) && reportedStatus !== 'paused') {
          a.status = 'working';
          a.currentAction = log.text?.substring(0, 80);
          a.stepCount = log.agentStep || (log._teamPollSignature ? a.stepCount : a.stepCount + 1);
          a.unreadCount = Number(log.unreadCount ?? a.unreadCount ?? 0);
        } else if (a && reportedStatus === 'paused') {
          a.status = 'paused';
        }
      } else if (['sub_agent_answer', 'sub_agent_result', 'sub_agent_complete'].includes(log.type)) {
        const a = agentMap.get(agentIdentity);
        if (a) { a.status = 'completed'; a.durationMs = log.durationMs || 0; a.stepCount = log.stepCount || a.stepCount; a.unreadCount = Number(log.unreadCount ?? a.unreadCount ?? 0); }
      } else if (log.type === 'sub_agent_error') {
        const a = agentMap.get(agentIdentity);
        if (a) { a.status = 'error'; a.unreadCount = Number(log.unreadCount ?? a.unreadCount ?? 0); }
      } else if (log.type === 'sub_agent_pause') {
        const a = agentMap.get(agentIdentity);
        if (a) { a.status = 'paused'; a.unreadCount = Number(log.unreadCount ?? a.unreadCount ?? 0); }
      } else if (log.type === 'sub_agent_resume') {
        const a = agentMap.get(agentIdentity);
        if (a && !['completed', 'error', 'closed'].includes(String(a.status))) { a.status = 'working'; a.unreadCount = Number(log.unreadCount ?? a.unreadCount ?? 0); }
      } else if (log.type === 'sub_agent_close') {
        const a = agentMap.get(agentIdentity);
        if (a) { a.status = 'closed'; a.unreadCount = Number(log.unreadCount ?? a.unreadCount ?? 0); }
      } else if (String(log.agentStatus || '').trim().toLowerCase() === 'paused') {
        const a = agentMap.get(agentIdentity);
        if (a) { a.status = 'paused'; }
      } else {
        const a = agentMap.get(agentIdentity);
        if (a && !['completed', 'error', 'closed', 'paused'].includes(String(a.status))) {
          a.currentAction = String(log.text || log.secondary || log.toolName || '').substring(0, 80);
          if (log.agentStep) a.stepCount = log.agentStep;
          a.unreadCount = Number(log.unreadCount ?? a.unreadCount ?? 0);
        }
      }
    }
    return Array.from(agentMap.values());
  }, [activeTurnTraceLogs, traceLogs, isThinking]);

  const realSubAgents = useMemo(
    () => currentSubAgents.filter((agent: any) => agent?.name && agent.name !== 'Main'),
    [currentSubAgents]
  );
  const hasActiveSubAgentRuns = useMemo(
    () => realSubAgents.some((agent: any) => ['planned', 'spawning', 'running', 'working', 'paused'].includes(String(agent?.status || '').toLowerCase())),
    [realSubAgents],
  );
  const activeSubAgentInfo = useMemo(
    () => activeSubAgentTab
      ? currentSubAgents.find((agent: any) => agentIdentitiesOverlap(agent, activeSubAgentTab)) || null
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
    if (!activeChatId || realSubAgents.length === 0 || autoOpenedAgentDockChatsRef.current.has(activeChatId)) return;
    autoOpenedAgentDockChatsRef.current.add(activeChatId);
    setSubAgentDockOpen(true);
  }, [activeChatId, realSubAgents.length]);

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

  const subAgentAssetIndexes = useMemo(() => {
    const indexes: Record<string, number> = {};
    orderedRealSubAgents.forEach((agent: any, index: number) => {
      const name = String(agent?.name || '').trim();
      const identity = String(agent?.id || name).trim();
      if (name) {
        indexes[name] = index;
        indexes[name.toLowerCase()] = index;
      }
      if (identity) indexes[identity] = index;
    });
    return indexes;
  }, [orderedRealSubAgents]);

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
    let syncInFlight = false;
    const chatId = activeChatId;
    const agentName = activeSubAgentInfo?.name || activeSubAgentTab;

    const syncSubAgentHistory = async () => {
      if (syncInFlight) return;
      syncInFlight = true;
      try {
        const params = new URLSearchParams({
          action: 'history',
          projectId: chatId,
          agentName,
          subAgentChatId: String(activeSubAgentInfo?.subAgentChatId || activeSubAgentInfo?.subAgentId || activeSubAgentTab),
          limit: '80',
        });
        const res = await fetch(`/api/agents/comm?${ params.toString() }`, { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const data = await res.json().catch(() => null);
        if (!data?.success || !Array.isArray(data.messages) || cancelled) return;

        const selectedIdentity = activeSubAgentInfo?.subAgentChatId || activeSubAgentInfo?.subAgentId || activeSubAgentTab;
        const incomingLogs = data.messages
          .map((message: any) => interAgentMessageLog(message, agentName, selectedIdentity))
          .filter((log: any) => log.messageId);

        if (incomingLogs.length > 0) {
          setChatLogsById(chatId, previousLogs => {
            const existingIds = new Set(previousLogs.map((log: any) => log.messageId || log.id).filter(Boolean));
            const additions = incomingLogs.filter((log: any) => !existingIds.has(log.messageId) && !existingIds.has(log.id));
            return additions.length > 0 ? [...previousLogs, ...additions] : previousLogs;
          });
        }

        // History reads do not mutate the mailbox. Acknowledge only after the
        // conversation has been accepted into the local feed.
        void fetch('/api/agents/comm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'markRead', projectId: chatId, agentName }),
        }).catch(() => undefined);
      } catch {
        // History polling is best-effort; normal agent polling still owns run state.
      } finally { syncInFlight = false; }
    };

    syncSubAgentHistory();
    const intervalId = window.setInterval(syncSubAgentHistory, 5000); // Sub-agent history — 5s cadence is sufficient
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeChatId, activeSubAgentInfo?.name, activeSubAgentInfo?.subAgentChatId, activeSubAgentInfo?.subAgentId, activeSubAgentTab]);

  useEffect(() => {
    if (!activeChatId || realSubAgents.length === 0) return;
    const chatId = activeChatId;
    let cancelled = false;
    let syncInFlight = false;

    const syncMainAgentHistory = async () => {
      if (syncInFlight) return;
      syncInFlight = true;
      try {
        const params = new URLSearchParams({
          action: 'history',
          projectId: chatId,
          agentName: 'Main',
          limit: '100',
        });
        const response = await fetch(`/api/agents/comm?${ params.toString() }`, { cache: 'no-store' });
        if (!response.ok || cancelled) return;
        const payload = await response.json().catch(() => null);
        if (!payload?.success || !Array.isArray(payload.messages) || cancelled) return;
        const incomingLogs = payload.messages
          .map((message: any) => interAgentMessageLog(message))
          .filter((log: any) => log.messageId);
        if (incomingLogs.length === 0) return;

        setChatLogsById(chatId, previousLogs => {
          const existingIds = new Set(previousLogs.map((log: any) => log.messageId || log.id).filter(Boolean));
          const additions = incomingLogs.filter((log: any) => !existingIds.has(log.messageId) && !existingIds.has(log.id));
          return additions.length > 0 ? [...previousLogs, ...additions] : previousLogs;
        });
      } catch {
        // Mailbox history is a recovery channel for reports that arrive after
        // Main's model loop; live traces continue independently.
      } finally { syncInFlight = false; }
    };

    void syncMainAgentHistory();
    const intervalId = window.setInterval(syncMainAgentHistory, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeChatId, realSubAgents.length]);

  useEffect(() => {
    if (!activeChatId || (!isThinking && !hasActiveSubAgentRuns)) return;
    const chatId = activeChatId;
    let cancelled = false;
    let syncInFlight = false;
    const seenSnapshots = new Map<string, string>();

    const syncAgentTeam = async () => {
      if (syncInFlight) return;
      syncInFlight = true;
      try {
        const params = new URLSearchParams({ action: 'status', projectId: chatId });
        const response = await fetch(`/api/agents/comm?${ params.toString() }`, { cache: 'no-store' });
        if (!response.ok || cancelled) return;
        const payload = await response.json().catch(() => null);
        if (!payload?.success || !Array.isArray(payload.agents) || cancelled) return;

        const updates = payload.agents.flatMap((agent: any) => {
          const agentName = String(agent?.agentName || '').trim();
          if (!agentName || agentName.toLowerCase() === 'main') return [];
          const agentId = String(agent?.agentId || '').trim();
          const subAgentChatId = String(agent?.subAgentChatId || (agentId ? `${ chatId }::sub-agent::${ agentId }` : '')).trim();
          const identity = subAgentChatId || agentId || agentName;
          const rawStatus = String(agent?.status || 'registered').toLowerCase();
          if (rawStatus === 'registered' && !agentId && !agent?.task) return [];
          const status = rawStatus === 'running' ? 'working'
            : rawStatus === 'cancelled' ? 'closed'
              : rawStatus;
          const signature = [identity, status, agent?.progress || '', agent?.task || '', agent?.unreadCount || 0].join('|');
          if (seenSnapshots.get(identity) === signature) return [];
          seenSnapshots.set(identity, signature);

          const type = status === 'completed' ? 'sub_agent_complete'
            : status === 'failed' || status === 'error' ? 'sub_agent_error'
              : status === 'closed' ? 'sub_agent_close'
                : status === 'paused' ? 'sub_agent_pause'
                  : status === 'planned' || status === 'spawning' ? 'sub_agent_spawn'
                    : 'sub_agent_action';
          return [{
            type,
            text: String(agent?.progress || (status === 'working' ? `${ agentName } working` : `${ agentName } ${ status }`)),
            secondary: String(agent?.task || '').substring(0, 160),
            task: agent?.task,
            timestamp: Number(agent?.updatedAt || agent?.registeredAt || Date.now()),
            agentName,
            subAgent: agentName,
            subAgentId: agentId || undefined,
            subAgentChatId: subAgentChatId || undefined,
            agentStatus: status,
            unreadCount: Number(agent?.unreadCount || 0),
            _teamPollSignature: signature,
          }];
        });
        if (updates.length === 0) return;

        setChatLogsById(chatId, previousLogs => {
          const existingSignatures = new Set(previousLogs.map((log: any) => log?._teamPollSignature).filter(Boolean));
          const nextLogs = [...previousLogs];
          let changed = false;
          for (const update of updates) {
            if (existingSignatures.has(update._teamPollSignature)) continue;
            const latestIndex = nextLogs.findLastIndex((log: any) =>
              /^sub_agent_(?:spawn|action|answer|result|complete|error|pause|resume|close)$/.test(String(log?.type || '')) &&
              agentIdentitiesOverlap(log, update)
            );
            const latest = latestIndex >= 0 ? nextLogs[latestIndex] : null;
            const latestStatus = String(latest?.agentStatus || '').toLowerCase();
            const incomingStatus = String(update.agentStatus || '').toLowerCase();
            const latestIsTerminal = ['completed', 'failed', 'error', 'closed', 'cancelled'].includes(latestStatus) ||
              ['sub_agent_answer', 'sub_agent_result', 'sub_agent_complete', 'sub_agent_error', 'sub_agent_close'].includes(String(latest?.type || ''));
            if (latestIsTerminal && latest && !latest._teamPollSignature) {
              if (Number(latest.unreadCount || 0) !== Number(update.unreadCount || 0)) {
                nextLogs[latestIndex] = { ...latest, unreadCount: update.unreadCount };
                changed = true;
              }
              continue;
            }
            if (latestIsTerminal && !['completed', 'failed', 'error', 'closed', 'cancelled'].includes(incomingStatus)) {
              continue;
            }

            if (latest && latestStatus === incomingStatus) {
              const unreadChanged = Number(latest.unreadCount || 0) !== Number(update.unreadCount || 0);
              // Keep authoritative trace text/results intact. A roster snapshot
              // may refresh the badge, while replacing only an older roster
              // snapshot when it is the sole source of progress.
              if (latest._teamPollSignature) {
                nextLogs[latestIndex] = { ...latest, ...update };
                changed = true;
              } else if (unreadChanged) {
                nextLogs[latestIndex] = { ...latest, unreadCount: update.unreadCount };
                changed = true;
              }
              continue;
            }

            nextLogs.push(update);
            existingSignatures.add(update._teamPollSignature);
            changed = true;
          }
          return changed ? nextLogs : previousLogs;
        });
      } catch {
        // Live trace transport remains authoritative; roster polling repairs
        // missed/reconnected updates without disrupting the current run.
      } finally { syncInFlight = false; }
    };

    void syncAgentTeam();
    const intervalId = window.setInterval(syncAgentTeam, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeChatId, hasActiveSubAgentRuns, isThinking]);

  const hiddenHeaderSubAgentCount = hiddenSubAgents.length;

  useEffect(() => {
    if (!activeSubAgentTab) return;
    const matchingAgent = realSubAgents.find((agent: any) =>
      agentIdentitiesOverlap(agent, activeSubAgentTab) ||
      String(agent?.name || '').toLowerCase() === String(activeSubAgentTab).toLowerCase()
    );
    if (matchingAgent) {
      const canonicalIdentity = String(matchingAgent.id || matchingAgent.name);
      if (canonicalIdentity !== activeSubAgentTab) setActiveSubAgentTab(canonicalIdentity);
      return;
    }
    setActiveSubAgentTab(null);
  }, [activeSubAgentTab, realSubAgents]);

  useEffect(() => {
    setSubAgentMessageTarget('selected');
  }, [activeChatId, activeSubAgentTab]);

  // Per-sub-agent trace logs — filters the main traceLogs for the selected sub-agent tab
  const subAgentDisplayLogs = useMemo(() => {
    if (!activeSubAgentTab) return [];
    const selectedAgent = currentSubAgents.find(agent => agentIdentitiesOverlap(agent, activeSubAgentTab));
    const selectedAgentName = selectedAgent?.name || activeSubAgentTab;
    const filtered = traceLogs.filter(log => {
      if (!log) return false;
      const agentName = log.agentName || log.subAgent;
      if (log.type === 'inter_agent_message') {
        const selectedIds = new Set([
          String(activeSubAgentTab || ''),
          String(activeSubAgentTab || '').includes('::sub-agent::')
            ? String(activeSubAgentTab).split('::sub-agent::').pop() || ''
            : '',
        ].filter(Boolean));
        const participantIds = [
          log.subAgentId,
          log.subAgentChatId,
          log.senderSubAgentId,
          log.senderSubAgentChatId,
          log.recipientAgentId,
          log.recipientSubAgentChatId,
        ].map((value: unknown) => String(value || '')).filter(Boolean);
        if (log.to === '*' || log.broadcast === true) {
          const broadcastRecipients = Array.isArray(log.broadcastRecipientRuns) ? log.broadcastRecipientRuns : [];
          if (broadcastRecipients.length === 0) return true;
          if (broadcastRecipients.some((recipient: any) => {
            const recipientIds = [recipient?.agentId, recipient?.subAgentChatId].map((value: unknown) => String(value || '')).filter(Boolean);
            return recipientIds.some((identity: string) => selectedIds.has(identity));
          })) return true;
          return false;
        }
        if (participantIds.some((identity: string) => selectedIds.has(identity))) return true;
      }
      return agentIdentitiesOverlap(
        log,
        selectedAgent || { id: activeSubAgentTab, name: selectedAgentName },
      ) || (
        !log.subAgentChatId &&
        !log.subAgentId &&
        String(agentName || '').toLowerCase() === String(selectedAgentName || '').toLowerCase()
      );
    });

    // Prepend a synthetic user_action log with the sub-agent's full task brief
    const agentInfo = selectedAgent;
    if (
      agentInfo &&
      agentInfo.task &&
      !filtered.some(log =>
        log?.type === 'user_action' &&
        String(log?.text || '').trim() === String(agentInfo.task || '').trim()
      )
    ) {
      const taskTurnId = `subagent-task:${ String(agentInfo.id || activeSubAgentTab) }`;
      const taskTimestamp = Number(agentInfo.startedAt) ||
        Number(filtered.find(log => Number(log?.startTime || log?.timestamp || 0) > 0)?.startTime ||
          filtered.find(log => Number(log?.timestamp || 0) > 0)?.timestamp || 1);
      return [
        {
          type: 'user_action',
          text: agentInfo.task,
          id: taskTurnId,
          runId: taskTurnId,
          turnId: taskTurnId,
          timestamp: taskTimestamp,
          startTime: taskTimestamp,
          endTime: taskTimestamp,
          agentName: selectedAgentName,
          subAgent: selectedAgentName,
          subAgentId: agentInfo.subAgentId || (String(agentInfo.id || '').includes('::sub-agent::') ? String(agentInfo.id).split('::sub-agent::').pop() : agentInfo.id),
          subAgentChatId: agentInfo.subAgentChatId || (String(agentInfo.id || '').includes('::sub-agent::') ? agentInfo.id : undefined),
        },
        ...filtered
      ];
    }
    return filtered;
  }, [traceLogs, activeSubAgentTab, currentSubAgents]);

  // Which logs to show in ChatFeed — main or sub-agent
  const autonomousSelected = selectedAgent === 'autonomous';
  const effectiveDisplayLogs = activeSubAgentTab && !autonomousSelected ? subAgentDisplayLogs : displayTraceLogs;
  const mainTurnWorkActive = useMemo(() => {
    let latestUserIndex = -1;
    for (let index = displayTraceLogs.length - 1; index >= 0; index -= 1) {
      const log = displayTraceLogs[index];
      if (log?.type === 'user_action' && !isInjectedProxyBoundary(log)) {
        latestUserIndex = index;
        break;
      }
    }
    const currentTurnLogs = displayTraceLogs.slice(latestUserIndex >= 0 ? latestUserIndex : 0);
    const latestRunId = [...currentTurnLogs]
      .reverse()
      .map((log: any) => String(log?.runId || log?.turnId || '').trim())
      .find(Boolean);
    const activeRunLogs = latestRunId
      ? currentTurnLogs.filter((log: any) => {
        const runId = String(log?.runId || log?.turnId || '').trim();
        return !runId || runId === latestRunId;
      })
      : currentTurnLogs;
    const hasFinalAnswer = activeRunLogs.some((log: any) =>
      log?.type === 'answer' &&
      String(log.text || '').trim().length > 0 &&
      log.isStreaming !== true &&
      log.isLiveTyping !== true
    );
    return isTurnWorkActive(isThinking, hasFinalAnswer, activeRunLogs);
  }, [displayTraceLogs, isThinking]);
  const composerContextUsage = useMemo(() => {
    // Keep the empty New Chat surface clean. The indicator begins with the
    // first real user boundary and remains isolated to this active chat.
    if (!traceLogs.some((log: any) => log?.type === 'user_action')) return null;

    const explicitEntry = parseModelEntryKey(activeModelSelection);
    const autoEntry = explicitEntry
      ? null
      : pickAutoModelEntry(proxyModelEntries, readRuntimeBaseApiKeys(), readRuntimeModelApiKeys());
    const selectedEntry = explicitEntry || autoEntry;
    const fallbackConfig = MAIN_AGENT_MODEL_OPTIONS.find(option => option.id === agentMode) || MAIN_AGENT_MODEL_OPTIONS[0];
    const provider = selectedEntry?.provider || fallbackConfig.provider;
    const modelId = selectedEntry?.modelId || fallbackConfig.modelName;

    let contextWindow = 0;
    try {
      const discovered = JSON.parse(appStorage.getItem(MODEL_CONTEXT_WINDOWS_STORAGE_KEY) || '{}');
      contextWindow = Number(discovered?.[modelEntryKey(provider, modelId)] || 0);
    } catch { }
    if (!Number.isFinite(contextWindow) || contextWindow < 16_000) {
      contextWindow = resolveClientContextWindow(provider, modelId);
    }
    try {
      const savedSettings = JSON.parse(appStorage.getItem(SETTINGS_STORAGE_KEY) || '{}');
      let budgetSelection = String(savedSettings.contextWindowSizeSelection || '258000');
      if (activeChatId) {
        const chatOverrides = JSON.parse(appStorage.getItem(CHAT_CONTEXT_WINDOW_OVERRIDES_STORAGE_KEY) || '{}');
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
      (() => {
        const owners = [log?.chatId, log?.ownerChatId]
          .map(value => String(value || '').trim())
          .filter(Boolean);
        return (owners.length === 0 || !activeChatId || owners.includes(activeChatId)) &&
          log?.auxiliaryRuntime !== true;
      })()
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
  const mainAgentState = currentSubAgents.find(agent => agent.name === 'Main');
  const selectedSubAgentState = activeSubAgentTab && !autonomousSelected
    ? currentSubAgents.find(agent => agentIdentitiesOverlap(agent, activeSubAgentTab))
    : null;
  const mainAgentPaused = mainAgentState?.status === 'paused';
  const selectedSubAgentStatus = String(selectedSubAgentState?.status || '').toLowerCase();
  const selectedSubAgentActive = ['planned', 'spawning', 'running', 'working'].includes(selectedSubAgentStatus);
  const selectedSubAgentTerminal = ['completed', 'failed', 'error', 'closed', 'cancelled'].includes(selectedSubAgentStatus);
  const selectedSubAgentTerminalLabel = selectedSubAgentStatus === 'completed'
    ? 'Run completed'
    : selectedSubAgentStatus === 'closed' || selectedSubAgentStatus === 'cancelled'
      ? 'Run closed'
      : 'Run ended with an error';
  const selectedFeedPaused = activeSubAgentTab && !autonomousSelected
    ? !selectedSubAgentActive
    : mainAgentPaused;
  const canStopSelectedFeed = activeSubAgentTab && !autonomousSelected
    ? ['working', 'spawning', 'paused'].includes(String(selectedSubAgentState?.status || ''))
    : mainTurnWorkActive;
  const effectiveIsThinking = activeSubAgentTab && !autonomousSelected
    ? Boolean(selectedSubAgentActive)
    : mainTurnWorkActive && !mainAgentPaused;
  const handleSelectedSubAgentControl = (action: 'pause' | 'resume' | 'close'): Promise<boolean> => {
    const selectedSubAgent = activeSubAgentTab
      ? currentSubAgents.find(agent => agentIdentitiesOverlap(agent, activeSubAgentTab))
      : null;
    const agentName = selectedSubAgent?.name || null;
    const rawAgentId = String(selectedSubAgent?.subAgentId || selectedSubAgent?.subAgentChatId || '');
    const selectedSubAgentId = selectedSubAgent?.subAgentId ||
      (rawAgentId.includes('::sub-agent::') ? rawAgentId.split('::sub-agent::').pop() : undefined);
    if (!agentName || !activeSubAgentTab) return Promise.resolve(false);

    const chatId = activeChatIdRef.current;
    if (!chatId) return Promise.resolve(false);

    const agentIdentity = String(selectedSubAgent?.id || activeSubAgentTab);
    const requestKey = `${ chatId }:sub-agent:${ agentIdentity }:${ action }`;
    const existingRequest = stopRequestsRef.current.get(requestKey);
    if (existingRequest) return existingRequest;

    const controlRequest = (async () => {
      setSubAgentControlPending({ agentIdentity, action });
      try {
        const response = await fetch('/api/agent/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            projectId: chatId,
            agentName,
            agentId: selectedSubAgentId,
          }),
        });
        const payload = await response.json().catch(() => ({}));
        const actionSucceeded = action === 'pause' ? payload?.paused === true
          : action === 'resume' ? payload?.resumed === true
            : payload?.closed === true;
        if (!response.ok || payload?.success !== true || !actionSucceeded) {
          throw new Error(payload?.error || `${ action } failed (${ response.status })`);
        }
        setChatLogsById(chatId, previous => {
          const identity = selectedSubAgent?.subAgentChatId || selectedSubAgent?.subAgentId || activeSubAgentTab;
          const eventType = `sub_agent_${ action }`;
          const latestControlEvent = [...previous].reverse().find(log =>
            /^sub_agent_(?:pause|resume|close)$/.test(String(log?.type || '')) &&
            agentIdentitiesOverlap(log, selectedSubAgent || identity)
          );
          if (latestControlEvent?.type === eventType) return previous;
          const nextStatus = action === 'pause' ? 'paused' : action === 'resume' ? 'working' : 'closed';
          return [...previous, {
            type: eventType,
            text: `${ agentName } ${ action === 'close' ? 'stopped' : action === 'pause' ? 'paused' : 'resumed' }`,
            timestamp: Date.now(),
            agentName,
            subAgent: agentName,
            subAgentId: selectedSubAgentId,
            subAgentChatId: selectedSubAgent?.subAgentChatId ||
              (String(activeSubAgentTab).includes('::sub-agent::') ? activeSubAgentTab : undefined),
            agentStatus: nextStatus,
          }];
        });
        return true;
      } catch (error: any) {
        console.error(`[AgentControl] Failed to ${ action } "${ agentName }":`, error);
        setChatLogsById(chatId, previous => [
          ...previous,
          systemThoughtLog(`Could not ${ action } ${ agentName }: ${ String(error?.message || error) }`, Date.now()),
        ]);
        return false;
      } finally {
        stopRequestsRef.current.delete(requestKey);
        setSubAgentControlPending(current => current?.agentIdentity === agentIdentity && current.action === action ? null : current);
      }
    })();

    stopRequestsRef.current.set(requestKey, controlRequest);
    return controlRequest;
  };
  const handleStopSelectedFeed = (): Promise<boolean> => {
    if (!activeSubAgentTab || autonomousSelected) return handleStop();
    return handleSelectedSubAgentControl('close');
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

  const hasRealTodoItems = Boolean((lastTaskTracker || currentTaskTracker)?.steps?.length);

  const chatChangeStats = useMemo(() => {
    const fileStatusMap = new Map<string, { path: string; status: 'MOD' | 'ADD' | 'DEL' }>();
    const fileDiffsMap = new Map<string, { additions: number; deletions: number }>();

    for (const log of traceLogs) {
      if (!log) continue;

      // Only process file_edit logs to calculate changes, avoiding duplicate count from file_preview logs
      if (log.type !== 'file_edit') {
        continue;
      }

      const args = log.toolArgs || {};
      const text = String(log.text || log.content || log.secondary || '').toLowerCase();
      const rawResult = log.toolResult ?? log.result;
      let structuredResult = rawResult;
      if (typeof rawResult === 'string') {
        try { structuredResult = JSON.parse(rawResult); } catch { structuredResult = null; }
      }
      const structuredChanges = Array.isArray(structuredResult?.changes) ? structuredResult.changes : [];
      if (structuredChanges.length > 0) {
        for (const change of structuredChanges) {
          const filePath = String(change?.path || '').trim();
          if (!filePath || !isProjectFile(filePath)) continue;
          const key = getBasename(filePath).toLowerCase();
          const status: 'MOD' | 'ADD' | 'DEL' = change?.action === 'created' ? 'ADD' : change?.action === 'deleted' ? 'DEL' : 'MOD';
          fileStatusMap.set(key, { path: filePath, status });
          const existing = fileDiffsMap.get(key) || { additions: 0, deletions: 0 };
          fileDiffsMap.set(key, {
            additions: existing.additions + (Number(change?.additions) || 0),
            deletions: existing.deletions + (Number(change?.deletions) || 0),
          });
        }
        continue;
      }

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
        let fileStatus: 'MOD' | 'ADD' | 'DEL' = 'MOD';
        if (
          text.includes('created file') ||
          text.includes('new file') ||
          text.includes('wrote file')
        ) {
          fileStatus = 'ADD';
        } else if (text.includes('deleted file') || text.includes('deleting file')) {
          fileStatus = 'DEL';
        }

        const existingStatus = fileStatusMap.get(key);
        // Prefer absolute path if available (contains slashes)
        const pathVal = (targetFile.includes('/') || targetFile.includes('\\')) ? targetFile : (existingStatus?.path || targetFile);
        if (!existingStatus || fileStatus === 'ADD' || fileStatus === 'DEL') {
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
    <div data-active-view={activeView} data-sidebar-open={sidebarOpen ? 'true' : 'false'} data-platform={desktopPlatform} className="eterx-app-shell flex h-screen font-sans overflow-hidden selection:bg-[#E2765A]/30 transition-colors relative">
      {/* Global Window Drag Bar (Independent Layer) */}
      <div className="eterx-window-drag-layer pointer-events-none absolute top-0 h-[var(--eterx-shell-topbar-height)] z-[998] [-webkit-app-region:drag]" />

      {/* Global Top Bar UI Container */}
      <div className="eterx-global-topbar pointer-events-none absolute top-0 h-[var(--eterx-shell-topbar-height)] z-[999] flex items-center overflow-hidden">
        {/* Drag spacer — pointer-events-none so sidebar toggle clicks pass through */}
        <div className="eterx-topbar-sidebar-spacer shrink-0 pointer-events-none transition-[width] duration-300" />

        {/* Action buttons — API | Models | Theme | Help | Updates */}
        <div className="pointer-events-auto flex items-center gap-0 min-w-0 overflow-hidden [-webkit-app-region:no-drag]">
          {/* API */}
          <button type="button"
            onClick={() => { setSettingsInitialTab('api'); setIsSettingsOpen(true); }}
            className="eterx-topbar-btn px-[10px] h-full text-[13px] font-normal tracking-[0.01em] cursor-pointer select-none outline-none bg-transparent border-0 transition-colors duration-150"
            style={{ color: 'var(--eterx-topbar-text, #9A9590)' }}>
            API
          </button>

          {/* Models */}
          <button type="button"
            onClick={() => { setSettingsInitialTab('models'); setIsSettingsOpen(true); }}
            className="eterx-topbar-btn px-[10px] h-full text-[13px] font-normal tracking-[0.01em] cursor-pointer select-none outline-none bg-transparent border-0 transition-colors duration-150"
            style={{ color: 'var(--eterx-topbar-text, #9A9590)' }}>
            Models
          </button>

          {/* Theme toggle — light/dark dropdown (Powered by Radix UI Portal) */}
          <div className="relative flex items-center">
            <DropdownMenu.Root open={topbarThemeOpen} onOpenChange={(open) => setActiveTopbarMenu(open ? 'theme' : null)}>
              <DropdownMenu.Trigger asChild>
                <button type="button"
                  className="eterx-topbar-btn px-[10px] h-full text-[13px] font-normal tracking-[0.01em] cursor-pointer select-none outline-none bg-transparent border-0 transition-colors duration-150"
                  style={{ color: 'var(--eterx-topbar-text, #9A9590)' }}>
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
                    boxShadow: 'none',
                  }}
                >
                  {([
                    { value: 'light', label: 'Light', icon: Sun },
                    { value: 'dark', label: 'Dark', icon: Moon },
                  ] as const).map(({ value, label, icon: Icon }) => {
                    const currentTheme = (() => {
                      try {
                        return document.documentElement.getAttribute('data-theme') || 'dark';
                      } catch {
                        return 'dark';
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
                  style={{ color: 'var(--eterx-topbar-text, #9A9590)' }}>
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
                    boxShadow: 'none',
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

          {/* Updates stays in its existing position after Help. */}
          <button type="button"
            onClick={() => openSettingsWindow('updates')}
            className="eterx-topbar-btn relative px-[10px] h-full text-[13px] font-normal tracking-[0.01em] cursor-pointer select-none outline-none bg-transparent border-0 transition-colors duration-150"
            style={{ color: 'var(--eterx-topbar-text, #9A9590)' }}>
            Updates
            {hasUnreadUpdate && (
              <span
                aria-label="Update available"
                className="absolute right-[3px] top-[6px] h-[6px] w-[6px] rounded-full bg-[#3B82F6]"
                style={{ boxShadow: 'none' }}
              />
            )}
          </button>
        </div>
        {/* Keep the center draggable while the macOS app title stays at the far right. */}
        <div className="flex-1 pointer-events-none" />
        <div className="eterx-global-brand pointer-events-none flex h-full shrink-0 items-center px-3 text-[19px] font-bold tracking-[0.01em] leading-none select-none">
          EterX
        </div>
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
                        activeChatIdRef.current = null;
                        setActiveChatId(null);
                        setTraceLogs([]);
                        setBuildingAgentId(null);
                        setBuildingAgentName(null);
                        setActiveView('agents');
                      }}
                      className="flex items-center gap-2 px-3 py-1.5 bg-white/[0.05] border border-white/5 hover:border-white/10 hover:bg-white/[0.08] text-[#E8E6E3] hover:text-white transition-all rounded-lg group shadow-none active:scale-95 mr-2"
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
                  if (activeView === 'agents' && buildingAgentId) return null;
                  if (activeView === 'projects' || activeView === 'channels' || (activeView === 'agents' && !buildingAgentId)) {
                    const headerLabel = activeView === 'projects' ? 'Tasks' : activeView === 'channels' ? (gatewayScreen ? 'Gateway' : 'Channels') : 'Agents';
                    return (
                      <div className="relative min-w-0 [-webkit-app-region:no-drag] pl-3.5 py-1">
                        {activeView === 'channels' && gatewayScreen && <button type="button" aria-label="Back to Channels" onClick={() => window.dispatchEvent(new CustomEvent('eterx_gateway_back'))} className="group -ml-2 mr-2 inline-flex h-9 w-9 items-center justify-center rounded-xl border border-black/10 bg-white text-black/75 shadow-none transition hover:-translate-x-0.5 hover:bg-black/[0.04] hover:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1d8cff]/40 dark:border-white/10 dark:bg-white/[0.06] dark:text-white/85 dark:hover:bg-white/10"><ArrowLeft className="h-5 w-5 stroke-[2.5] transition-transform group-hover:-translate-x-0.5" /></button>}
                        <span className={`eterx-view-header-label ${gatewayScreen && activeView === 'channels' ? 'text-[24px]' : 'text-[20px]'} font-bold text-white tracking-tight select-none`}>{headerLabel}</span>
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
                        aria-expanded={headerMenuOpen}
                        aria-haspopup="menu"
                        onClick={() => {
                          if (!isEditingChatTitle) {
                            setChatActionMenuOpen(false);
                            setHeaderMenuOpen(!headerMenuOpen);
                          }
                        }}
                        className={`eterx-thread-tab flex min-w-0 items-center gap-1.5 px-1.5 py-1 text-[13px] font-medium transition-colors duration-150 hover:bg-[var(--sidebar-toggle-hover-bg)] hover:text-[var(--sidebar-hover-text)] active:bg-[var(--sidebar-toggle-active-bg)] ${ headerMenuOpen ? 'bg-[var(--sidebar-toggle-hover-bg)] text-[var(--sidebar-hover-text)]' : '' } ${ isEditingChatTitle ? 'cursor-default' : 'cursor-pointer' }`}
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
                        {!isEditingChatTitle && (
                          <ChevronDown
                            aria-hidden="true"
                            className={`eterx-thread-tab-chevron ml-0.5 h-3.5 w-3.5 shrink-0 ${headerMenuOpen ? 'rotate-180' : ''}`}
                            strokeWidth={2}
                          />
                        )}
                        <div className="relative flex items-center justify-center">
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
                                  className="eterx-chat-action-menu absolute right-0 top-[calc(100%+8px)] w-[180px] z-50 bg-[#1E1E1E]/95 backdrop-blur-xl border border-white/[0.08] rounded-xl shadow-none p-1.5 flex flex-col gap-0.5"
                                >
                                  <button
                                    onClick={() => {
                                      setChatActionMenuOpen(false);
                                      if (activeChatId) toggleFavorite(activeChatId);
                                    }}
                                    className="eterx-chat-action-menu-item flex items-center text-left px-2.5 py-1.5 text-[12px] font-normal text-[#E8E6E3] hover:bg-white/[0.05] rounded-md transition-colors"
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
                                    className="eterx-chat-action-menu-item flex items-center text-left px-2.5 py-1.5 text-[12px] font-normal text-[#E8E6E3] hover:bg-white/[0.05] rounded-md transition-colors"
                                  >
                                    <Pencil className="w-3.5 h-3.5 mr-2.5 shrink-0 text-[#A3A19E]" strokeWidth={1.5} />
                                    <span>Rename task</span>
                                  </button>

                                  <div className="eterx-chat-action-menu-divider my-1 h-px bg-white/[0.06]" />

                                  <button
                                    onClick={() => setChatActionMenuOpen(false)}
                                    className="eterx-chat-action-menu-item flex items-center text-left px-2.5 py-1.5 text-[12px] font-normal text-[#E8E6E3] hover:bg-white/[0.05] rounded-md transition-colors"
                                  >
                                    <Calendar className="w-3.5 h-3.5 mr-2.5 shrink-0 text-[#A3A19E]" strokeWidth={1.5} />
                                    <span>Schedule task...</span>
                                  </button>

                                  <div className="eterx-chat-action-menu-divider my-1 h-px bg-white/[0.06]" />

                                  <button
                                    onClick={() => setChatActionMenuOpen(false)}
                                    className="eterx-chat-action-menu-item flex items-center text-left px-2.5 py-1.5 text-[12px] font-normal text-[#E8E6E3] hover:bg-white/[0.05] rounded-md transition-colors"
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
                              className="eterx-thread-switcher absolute left-0 top-[calc(100%+8px)] z-[80] flex max-h-[400px] w-[300px] flex-col rounded-xl border border-white/[0.08] bg-[#1E1E1E]/95 p-1.5 shadow-none backdrop-blur-xl"
                            >
                              <div className="flex items-center justify-between px-2.5 mb-2 mt-1 h-6">
                                {!headerSearchOpen ? (
                                  <>
                                    <div className="eterx-thread-switcher-title text-[11.5px] font-semibold text-white/50">Threads</div>
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
                                    className="eterx-thread-search flex items-center gap-2 w-full bg-white/5 rounded-md px-2 py-1 h-full"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <Search className="w-3 h-3 text-[#A3A19E]" strokeWidth={1.6} />
                                    <input
                                      type="text"
                                      autoFocus
                                      placeholder="Search threads..."
                                      value={headerSearchQuery}
                                      onChange={(e) => setHeaderSearchQuery(e.target.value)}
                                      className="eterx-thread-search-input bg-transparent border-none outline-none text-[12px] text-[#E8E6E3] placeholder:text-white/20 w-full font-normal"
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
                                    return <div className="eterx-thread-switcher-empty px-2.5 py-2 text-[12px] text-white/30 italic">No threads found</div>;
                                  }

                                  return filteredChats.map(chat => {
                                    const isActive = activeChatId === chat.id;
                                    const isWorking = sidebarRunningChats.has(chat.id);
                                    return (
                                      <div
                                        key={chat.id}
                                        onClick={() => {
                                          loadChat(chat.id);
                                          setHeaderMenuOpen(false);
                                        }}
                                        className={`eterx-thread-switcher-item w-full text-left px-2.5 py-1.5 text-[12px] rounded-md truncate transition-all duration-150 flex items-center group cursor-pointer border border-transparent active:scale-[0.98] ${ isActive ? 'bg-white/[0.08] text-white font-medium shadow-none' : 'text-[#A3A19E] hover:bg-white/[0.05] active:bg-white/10 hover:text-[#E8E6E3]' }`}
                                      >
                                        <MessageSquare className="w-3.5 h-3.5 mr-2.5 shrink-0 text-white/40 group-hover:text-white/60 transition-colors" strokeWidth={1.5} />
                                        <span className="min-w-0 flex-1 truncate font-normal">{chat.title}</span>
                                        {isWorking && (
                                          <span
                                            className="eterx-splash-spinner eterx-thread-running-indicator ml-2 shrink-0"
                                            aria-label={isActive ? 'Loading active chat' : 'Agent working'}
                                          />
                                        )}
                                      </div>
                                    );
                                  });
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
                    {isThinking && !mainAgentPaused && (
                      <svg className="h-3.5 w-3.5 shrink-0 animate-spin text-white/75" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-label="Main working">
                        <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                        <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    )}
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
                    {headerSubAgentTabs.map((agent: any, index: number) => {
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
                            boxShadow: 'none',
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
                          title={`${agent.name} · run ${agent.subAgentId || agentIdentity}`}
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
                          <SubAgentAvatar name={agent.name} status={agent.status} size="xs" assetIndex={subAgentAssetIndexes[agent.name] ?? index} />
                          <Shimmer active={isWorking} className="eterx-agent-tab-label min-w-0 truncate">{agent.name}</Shimmer>
                          {Number(agent.unreadCount || 0) > 0 && (
                            <span
                              className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-sky-400/15 px-1 text-[8px] font-bold text-sky-200/90"
                              title={`${ agent.unreadCount } unread internal message${ Number(agent.unreadCount) === 1 ? '' : 's' }`}
                            >
                              {Number(agent.unreadCount) > 9 ? '9+' : agent.unreadCount}
                            </span>
                          )}
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
                            ? 'border-white/25 bg-white/12 text-white shadow-none'
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
                          <div className="absolute right-0 top-[calc(100%+6px)] min-w-[170px] z-50 bg-[#000000]/95 backdrop-blur-xl border border-white/12 rounded-xl shadow-none p-1.5 flex flex-col gap-0.5 pointer-events-auto">
                            <div className="px-2.5 py-1 text-[9px] font-bold text-[#6A6460] uppercase tracking-wider select-none">
                              Hidden Agents
                            </div>
                            {hiddenSubAgents.map((agent: any, index: number) => (
                              <button
                                key={agent.id || agent.name}
                                type="button"
                                onClick={() => {
                                  handleSelectHiddenAgent(agent.id || agent.name);
                                  setOverflowDropdownOpen(false);
                                }}
                                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] font-medium text-white/70 transition-all hover:bg-white/5 hover:text-white active:scale-[0.98]"
                                title={`${agent.name} · run ${agent.subAgentId || agent.id || agent.name}`}
                              >
                                <SubAgentAvatar name={agent.name} status={agent.status} size="xs" assetIndex={subAgentAssetIndexes[agent.name] ?? headerSubAgentTabs.length + index} />
                                <span className="truncate flex-1">{agent.name}</span>
                                {Number(agent.unreadCount || 0) > 0 && (
                                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-sky-400/15 px-1 text-[8px] font-bold text-sky-200/90">
                                    {Number(agent.unreadCount) > 9 ? '9+' : agent.unreadCount}
                                  </span>
                                )}
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
                      <div className="absolute right-0 top-[calc(100%+8px)] hidden group-hover:block z-[90] bg-[#1E1E1E]/95 border border-white/[0.08] backdrop-blur-xl rounded-md px-2 py-1 text-[11px] font-semibold text-white/90 whitespace-nowrap shadow-none select-none pointer-events-none">
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
                            className="absolute right-0 top-[calc(100%+10px)] z-50 flex w-[236px] flex-col rounded-xl border border-white/[0.08] bg-[#1A1A1A]/95 backdrop-blur-2xl p-1.5 shadow-none text-[#F4F1EA]"
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
                                  className="absolute right-full mr-0.5 top-0 z-50 flex w-[245px] flex-col rounded-xl border border-white/[0.08] bg-[#1A1A1A]/95 backdrop-blur-2xl p-1.5 shadow-none text-[#F4F1EA] pointer-events-auto"
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
                                              onClick={async () => {
                                                const didCopy = await safeCopyTextToClipboard(c.hash);
                                                if (didCopy) alert(`Copied hash ${ c.hash } to clipboard!`);
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
                  <Tooltip
                    text={subAgentDockOpen ? 'Close subagent tabs' : `Open subagent tabs (${ realSubAgents.length })`}
                    side="bottom"
                    delay={450}
                  >
                    <button
                      type="button"
                      aria-label={subAgentDockOpen ? 'Close subagent tabs' : 'Open subagent tabs'}
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
                  </Tooltip>
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
                      className={`relative eterx-header-icon-button flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 ${ envDropdownOpen ? 'border-white/10 bg-white/[0.12] text-white shadow-none' : 'border-transparent bg-transparent text-[var(--sidebar-muted-text)] hover:bg-[var(--sidebar-toggle-hover-bg)] hover:text-[var(--sidebar-hover-text)] active:bg-[var(--sidebar-toggle-active-bg)]' }`}
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
                              {hasRealTodoItems && (
                                <>
                                  <WorkMenuSectionButton
                                    title="Todo"
                                    meta={todoCounterText}
                                    open={todoSectionOpen}
                                    onMouseEnter={() => setActiveSubmenu(null)}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setTodoSectionOpen(!todoSectionOpen);
                                    }}
                                  />

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
                                          {(lastTaskTracker || currentTaskTracker)?.steps?.map((step) => {
                                            const tracker = lastTaskTracker || currentTaskTracker;
                                            const activeWorking = step.status === 'in_progress' || (step.status === 'pending' && tracker?.activeStepName === step.name);
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
                                          })}
                                        </div>
                                      </motion.div>
                                    )}
                                  </AnimatePresence>

                                  <div
                                    onMouseEnter={() => setActiveSubmenu(null)}
                                    className="eterx-work-menu-divider"
                                  />
                                </>
                              )}

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
                                        realSubAgents.map((agent, index) => {
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
                                              <SubAgentAvatar name={agent.name} status={agent.status} size="xs" assetIndex={subAgentAssetIndexes[agent.name] ?? index} />
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
                  onOpenSettingsTab={openSettingsWindow}
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
                        <div ref={proxyCardRef} className="eterx-proxy-card pointer-events-auto flex h-fit flex-col gap-2 rounded-[20px] border border-white/[0.10] bg-[#252525]/95 px-3 pb-3 pt-3 shadow-none backdrop-blur-xl select-none">
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
                                      ? 'Use active model'
                                      : (proxyModelEntries.find(entry => modelEntryKey(entry.provider, entry.modelId) === proxyRuntimeModelSelection)?.modelId || 'Select model')}
                                  </span>
                                  <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-white/35 transition-transform duration-200 ${ showProxyRuntimeModelMenu ? 'rotate-180' : '' }`} />
                                </button>
                              </div>
                              {showProxyRuntimeModelMenu && (
                                <div className="eterx-proxy-runtime-model-menu eterx-scrollbar absolute right-0 top-full z-[110] mt-1.5 w-[220px] max-h-[260px] overflow-y-auto rounded-2xl border border-white/[0.10] bg-[#252525] p-1.5 shadow-none">
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
                                  {proxyModelEntries.length === 0 && (
                                    <div className="px-2.5 py-3 text-center text-[11px] text-white/45">Add an API key and save a real model in Settings.</div>
                                  )}
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
                                <div className="eterx-proxy-popout rounded-2xl border border-white/[0.08] bg-[#252525] shadow-none p-1.5 flex flex-col gap-1 w-full">
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
                          const modelProviderLabels: Record<string, string> = {
                            gemini: 'Google Gemini',
                            mistral: 'Mistral',
                            openai: 'OpenAI',
                            openrouter: 'OpenRouter',
                            groq: 'Groq',
                            anthropic: 'Anthropic',
                          };
                          const allModelOptions = modelOptions;
                          const selectedModel = allModelOptions.find(option => option.optionKey === proxyModelSelection) || allModelOptions[0];
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
                              className="eterx-proxy-chat-window pointer-events-auto fixed right-6 bottom-20 z-[9990] max-h-[calc(100vh-32px)] max-w-[calc(100vw-24px)] overflow-hidden rounded-[24px] border border-white/[0.12] bg-[#171717] shadow-none flex flex-col transition-[box-shadow] duration-200"
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
                                  <div className="flex flex-1 flex-col items-center justify-center px-5 py-8 text-center">
                                    <span className="text-[14px] font-semibold leading-5 text-white/72">Coordinate the work</span>
                                    <span className="mt-2 max-w-[270px] text-[12px] leading-[1.55] text-white/42">
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
                                            ? 'rounded-xl border border-white/[0.08] bg-[#242424] px-3 py-2 text-white/90 shadow-none whitespace-pre-wrap'
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
                                            ? <Shimmer className="text-[var(--eterx-ui-working-text)]">{event.text}</Shimmer>
                                            : <span className="break-words">{event.text}</span>}
                                        </div>
                                      );
                                    })}
                                    {proxyLiveTurn.events.length === 0 && (
                                      <div className="flex items-center gap-2 text-[10.5px] text-white/38">
                                        <Sparkles className="h-3.5 w-3.5 text-white/28" />
                                        <Shimmer className="text-[var(--eterx-ui-working-text)]">Connecting the side agent</Shimmer>
                                      </div>
                                    )}
                                  </div>
                                )}
                                {proxyChatLoading && proxyLiveTurn?.chatId !== activeChatId && (
                                  <div className="self-start flex items-center gap-2 px-0 py-1 text-[10.5px] text-white/42">
                                    <Sparkles className="h-3.5 w-3.5 text-white/28" />
                                    <Shimmer className="text-[var(--eterx-ui-working-text)]">Restoring live work</Shimmer>
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
                                      <div className="w-9 h-1 rounded-full bg-white/20 group-hover:bg-white/60 group-active:bg-white/90 transition-colors shadow-none" />
                                    </div>

                                    <input ref={proxyFileInputRef} type="file" multiple className="hidden" onChange={handleProxyFileSelect} />
                                    <input ref={proxyPinInputRef} type="file" multiple className="hidden" onChange={handleProxyPinSelect} />

                                    {(proxyAttachments.length > 0 || proxyPinnedItems.length > 0) && (
                                       <div className="flex items-center gap-2 px-1 pt-0.5 pb-1 overflow-x-auto overflow-y-hidden select-none whitespace-nowrap [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                                         {proxyPinnedItems.map((pin, idx) => (
                                           <div key={`proxy-pin-${idx}`} className="group relative inline-flex shrink-0 items-center gap-2 rounded-xl border border-white/[0.12] bg-[#222222]/90 p-1 pr-2.5 shadow-none backdrop-blur-md select-none mt-1">
                                             <div className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-white/[0.08] border border-white/[0.06]">
                                               <img src="/icons/ui/pin.png" alt="Pin" className="h-3 w-3 object-contain eterx-popout-icon-img" />
                                             </div>
                                             <div className="flex flex-col min-w-0 pr-0.5">
                                               <span className="max-w-[105px] truncate text-[10.5px] font-medium leading-tight text-white/90">{pin.name}</span>
                                             </div>
                                             <button
                                               type="button"
                                               onClick={() => setProxyPinnedItems(prev => prev.filter((_, i) => i !== idx))}
                                               className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white text-black shadow-none transition-transform hover:scale-110 active:scale-95 z-10"
                                             >
                                               <X className="h-2 w-2 stroke-[3]" />
                                             </button>
                                           </div>
                                         ))}

                                         {proxyAttachments.map((att, idx) => {
                                           const fileName = att.name || att.file?.name || 'File';
                                           const ext = fileName.includes('.') ? fileName.split('.').pop()?.toUpperCase() : 'FILE';
                                           return (
                                             <div key={`proxy-att-${att.id || idx}`} className="group relative inline-flex shrink-0 items-center gap-2 rounded-xl border border-white/[0.12] bg-[#222222]/90 p-1 pr-2.5 shadow-none backdrop-blur-md select-none mt-1">
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
                                                 className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white text-black shadow-none transition-transform hover:scale-110 active:scale-95 z-10"
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
                                        <div className="eterx-proxy-attach-menu absolute bottom-[calc(100%+8px)] left-0 z-[130] flex w-[136px] flex-col gap-0.5 rounded-xl border border-white/[0.10] bg-[#1E1E1E]/95 p-1 text-[#F4F1EA] shadow-none backdrop-blur-2xl animate-in fade-in zoom-in-95 duration-150 select-none">
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
                                          onClick={() => {
                                            if (allModelOptions.length === 0) {
                                              setShowProxyModelMenu(false);
                                              openSettingsWindow('api');
                                              return;
                                            }
                                            setShowProxyModelMenu(!showProxyModelMenu);
                                          }}
                                          className={`eterx-model-button mr-0 flex h-[32px] min-w-0 max-w-[110px] items-center justify-between gap-1 rounded-full border border-transparent bg-transparent px-2 text-[#F4F4F4] transition-colors hover:bg-white/[0.06] hover:text-white active:bg-white/[0.10] group cursor-pointer ${ showProxyModelMenu ? '!bg-white/[0.10] !text-white' : '' }`}
                                        >
                                          <span className="eterx-selector-label min-w-0 truncate text-[12px] font-medium tracking-normal text-white/60">
                                            {selectedModel?.label || 'Add API to load models'}
                                          </span>
                                          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[#F0F0F0] transition-all duration-150 group-hover:text-white">
                                            <ChevronDown className={`eterx-selector-chevron h-3.5 w-3.5 text-[#F0F0F0] transition-all duration-200 group-hover:text-white ${ showProxyModelMenu ? 'rotate-180' : 'group-hover:translate-y-px' }`} strokeWidth={2.1} />
                                          </span>
                                        </div>

                                        {/* Dropdown Menu */}
                                        {showProxyModelMenu && (
                                          <div className="eterx-composer-popout eterx-scrollbar absolute bottom-[calc(100%+8px)] right-0 z-[130] flex max-h-[184px] w-[232px] max-w-[calc(100vw-24px)] flex-col overflow-y-auto rounded-xl border border-white/[0.08] bg-[#1E1E1E]/95 p-1 text-[#F4F1EA] shadow-none backdrop-blur-xl">
                                            {allModelOptions.map((option) => {
                                              const isCurrent = option.optionKey === selectedModel?.optionKey;
                                              return (
                                                <button
                                                  key={option.optionKey}
                                                  type="button"
                                                  onClick={() => {
                                                    handleProxyModelSelectionChange(option.optionKey);
                                                    setShowProxyModelMenu(false);
                                                  }}
                                                  className={`group flex min-h-[36px] w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors ${ isCurrent
                                                      ? 'eterx-proxy-model-item-active bg-white/[0.08] text-[#F4F1EA] font-normal shadow-none'
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
                                                      {modelProviderLabels[option.provider] || option.provider}
                                                    </span>
                                                  </span>
                                                </button>
                                              );
                                            })}
                                            {allModelOptions.length === 0 && (
                                              <div className="px-2 pb-2 pt-1 text-[10.5px] leading-4 text-[#A3A19E]">
                                                Add an API key and save a real model in Settings.
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
                                        disabled={proxyChatLoading || !selectedModel || (!proxyChatInput.trim() && proxyAttachments.length === 0 && proxyPinnedItems.length === 0) || !activeChatId}
                                        className="eterx-proxy-send-button h-7 w-7 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10 text-white/80 flex items-center justify-center transition-colors focus:outline-none"
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
                      key={`${activeChatId || 'new-chat'}::${activeSubAgentTab || 'main'}`}
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
                      subAgentAssetIndexes={subAgentAssetIndexes}
                      isFeedActivityPaused={Boolean(selectedFeedPaused)}
                      isSubAgentTab={!!activeSubAgentTab}
                      liveState={isLiveSessionActive ? liveState : 'idle'}
                    />

                    {activeSubAgentTab && (
                      <div className={`eterx-chat-auxiliary-stack px-4 ${ isRightPanelVisible ? 'sm:px-4' : 'sm:px-12' } w-full max-w-[760px] mx-auto pb-2`}>
                        <div className="flex min-h-[38px] flex-wrap items-center justify-between gap-2 rounded-[8px] border border-white/[0.07] bg-[#181818]/88 px-3 py-1.5 shadow-none">
                          <span className="flex min-w-0 items-center gap-2">
                            <MessageSquare className="h-3.5 w-3.5 shrink-0 text-white/48" strokeWidth={2.1} />
                            <span className="min-w-0 truncate text-[12px] font-semibold text-white/82">{activeSubAgentInfo?.name || activeSubAgentTab}</span>
                            {activeSubAgentInfo?.subAgentId && (
                              <span className="shrink-0 font-mono text-[8px] text-white/25" title={activeSubAgentInfo.subAgentId}>
                                #{String(activeSubAgentInfo.subAgentId).slice(-6)}
                              </span>
                            )}
                          </span>
                          <span className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                            <span className={`h-1.5 w-1.5 rounded-full ${ effectiveIsThinking ? 'bg-emerald-300/80' : selectedSubAgentStatus === 'completed' ? 'bg-emerald-300/55' : ['failed', 'error'].includes(selectedSubAgentStatus) ? 'bg-red-300/65' : selectedSubAgentStatus === 'paused' ? 'bg-amber-300/65' : 'bg-white/28' }`} />
                            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/38">
                              {selectedSubAgentState?.status === 'paused'
                                ? 'Paused'
                                : selectedSubAgentState?.status === 'closed'
                                  ? 'Closed'
                                  : selectedSubAgentTerminal
                                    ? selectedSubAgentTerminalLabel
                                  : effectiveIsThinking
                                    ? <Shimmer className="text-[var(--eterx-ui-working-text)]">Working</Shimmer>
                                    : selectedSubAgentState?.status || 'Ready'}
                            </span>
                            <span className="mx-0.5 h-4 w-px bg-white/10" />
                            {!selectedSubAgentTerminal && <button
                              type="button"
                              onClick={() => setSubAgentMessageTarget(current => current === 'selected' ? 'team' : 'selected')}
                              className={`rounded-md border px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.06em] transition ${ subAgentMessageTarget === 'team' ? 'border-sky-300/25 bg-sky-300/10 text-sky-200/90' : 'border-white/10 bg-white/[0.035] text-white/55 hover:text-white/80' }`}
                              title={subAgentMessageTarget === 'team' ? 'Send an update to every running and planned agent' : 'Send guidance to this exact worker run at its next safe boundary'}
                            >
                              {subAgentMessageTarget === 'team' ? 'All agents' : 'This agent'}
                            </button>}
                            {['working', 'spawning', 'paused'].includes(String(selectedSubAgentState?.status || '')) && (
                              <>
                                <button
                                  type="button"
                                  disabled={Boolean(subAgentControlPending)}
                                  onClick={() => void handleSelectedSubAgentControl(selectedSubAgentState?.status === 'paused' ? 'resume' : 'pause')}
                                  className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/[0.035] text-white/55 transition hover:bg-white/[0.07] hover:text-white/85 disabled:cursor-wait disabled:opacity-35"
                                  aria-label={selectedSubAgentState?.status === 'paused' ? `Resume ${activeSubAgentInfo?.name || 'agent'}` : `Pause ${activeSubAgentInfo?.name || 'agent'}`}
                                  title={selectedSubAgentState?.status === 'paused' ? 'Resume exact agent run' : 'Pause at the next safe boundary'}
                                >
                                  {selectedSubAgentState?.status === 'paused' ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                                </button>
                                <button
                                  type="button"
                                  disabled={Boolean(subAgentControlPending)}
                                  onClick={() => void handleSelectedSubAgentControl('close')}
                                  className="flex h-6 w-6 items-center justify-center rounded-md border border-red-300/15 bg-red-400/[0.045] text-red-200/55 transition hover:bg-red-400/10 hover:text-red-100/90 disabled:cursor-wait disabled:opacity-35"
                                  aria-label={`Stop ${activeSubAgentInfo?.name || 'agent'}`}
                                  title="Stop exact agent run"
                                >
                                  <Power className="h-3 w-3" />
                                </button>
                              </>
                            )}
                          </span>
                        </div>
                      </div>
                    )}

                    {selectedSubAgentTerminal ? (
                      <div className={`w-full px-4 pb-3 ${ isRightPanelVisible ? 'sm:px-4' : 'sm:px-12' }`}>
                        <div className="mx-auto flex min-h-[58px] w-full max-w-[760px] items-center gap-3 rounded-[14px] border border-white/[0.075] bg-[#171717]/92 px-4 py-3 shadow-none">
                          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${ selectedSubAgentStatus === 'completed' ? 'border-emerald-300/15 bg-emerald-400/[0.07] text-emerald-200/75' : selectedSubAgentStatus === 'closed' || selectedSubAgentStatus === 'cancelled' ? 'border-white/10 bg-white/[0.035] text-white/45' : 'border-red-300/15 bg-red-400/[0.06] text-red-200/75' }`}>
                            {selectedSubAgentStatus === 'completed' ? <CheckCircle2 className="h-4 w-4" /> : selectedSubAgentStatus === 'closed' || selectedSubAgentStatus === 'cancelled' ? <Power className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-[12px] font-semibold text-white/82">{selectedSubAgentTerminalLabel}</span>
                            <span className="mt-0.5 block text-[10.5px] text-white/38">This worker conversation is read-only. Its complete activity and messages remain available above.</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => setActiveSubAgentTab(null)}
                            className="shrink-0 rounded-[8px] border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[10px] font-semibold text-white/58 transition hover:bg-white/[0.075] hover:text-white/88"
                          >
                            Return to Main
                          </button>
                        </div>
                      </div>
                    ) : (
                    <ChatInput
                      inputValue={inputValue}
                      setInputValue={updateInputValue}
                      isThinking={effectiveIsThinking}
                      canStop={Boolean(canStopSelectedFeed)}
                      isRecording={isRecording}
                      handleSend={activeSubAgentTab ? handleSendSubAgentMessage : handleSend}
                      handleStop={handleStopSelectedFeed}
                      handleSteer={activeSubAgentTab ? handleSendSubAgentMessage : handleSteer}
                      toggleSpeech={toggleSpeech}
                      attachments={attachments}
                      setAttachments={updateAttachments}
                      greeting={greeting}
                      traceLogsLength={traceLogs.length}
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
                      showComposerControls={!Boolean(activeSubAgentTab)}
                      taskTracker={currentTaskTracker}
                      activeChatId={activeChatId}
                      buildingAgentId={buildingAgentId}
                      onOpenAgentBuilder={handleOpenAgentBuilder}
                      selectedAgent={selectedAgent}
                      selectedAgentName={activeSubAgentInfo?.name || activeSubAgentTab || selectedAgentName}
                      chatMode={chatMode && !activeSubAgentTab}
                      composerPlaceholder={buildingAgentId
                        ? 'Tell Agent Builder what to create or change'
                        : activeSubAgentTab
                          ? subAgentMessageTarget === 'team'
                            ? 'Broadcast an update to all agents'
                            : `Send guidance to ${ activeSubAgentInfo?.name || 'this worker' }`
                          : undefined}
                      onAgentChange={handleAgentChange}
                      onOpenPet={openPetWidget}
                      workspacePath={activeWorkspacePath}
                      onWorkspacePathChange={handleWorkspacePathChange}
                      runLocation={activeRunLocation}
                      onRunLocationChange={handleRunLocationChange}
                      chatModelSelection={activeModelSelection}
                      onModelSelectionChange={handleModelSelectionChange}
                      onOpenSettingsTab={openSettingsWindow}
                      contextUsage={composerContextUsage}
                      onOpenAgents={() => {
                        setBuildingAgentId(null);
                        setBuildingAgentName(null);
                        setActiveView('agents');
                      }}
                       onOpenProjects={() => {
                         setBuildingAgentId(null);
                         setBuildingAgentName(null);
                         setActiveView('projects');
                       }}
                       queuedFollowUps={activeSubAgentTab ? [] : queuedFollowUps.filter(message => message.chatId === activeChatId)}
                        onSendQueuedFollowUp={(item) => sendQueuedFollowUp({
                          id: item.id,
                          chatId: item.chatId || activeChatId || '',
                          text: item.text,
                          attachments: Array.isArray(item.attachments) ? item.attachments as ComposerAttachment[] : [],
                          createdAt: Date.now(),
                          admissionKey: (item as any).admissionKey,
                        })}
                       onRemoveQueuedFollowUp={async (id) => {
                         const item = queuedFollowUps.find(message => message.id === id);
                         return item ? removeQueuedFollowUp(item) : false;
                       }}
                       showScrollBottom={showScrollBottom}
                       onScrollToBottom={() => {
                         const container = document.getElementById('chat-container');
                         if (container) {
                           container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
                         } else if (messagesEndRef.current) {
                           messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
                         }
                       }}
                     />
                    )}

                    {/* Disclaimer Text */}
                    {traceLogs.length === 0 && !isThinking && !isLiveSessionActive && (
                      <div className="absolute bottom-6 left-0 right-0 flex flex-col items-center pointer-events-none z-40">
                        <div className="select-none text-center text-[12px] text-black/60 font-medium tracking-wide mix-blend-overlay">
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
                      <span className={`relative flex h-16 w-[9px] items-center justify-center rounded-full border shadow-none transition-all duration-200 ${ isResizingPanels ? 'border-white/25 bg-[#303030]' : 'border-white/[0.08] bg-[#1D1D1D]/90 group-hover:border-white/[0.18] group-hover:bg-[#272727]' }`}>
                        <span className={`h-8 w-[2px] rounded-full transition-colors duration-200 ${ isResizingPanels ? 'bg-white/90' : 'bg-[#777] group-hover:bg-white/80 group-focus-visible:bg-white/90' }`} />
                      </span>
                    </button>
                  )}

                  {/* Right Panel Container */}
                  {isRightPanelVisible && (
                    <IdePanel />
                  )}

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
        chats={chats}
        loadChat={loadChat}
        runningChats={sidebarRunningChats}
        activeChatId={activeChatId}
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
        controlMessage={liveError}
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

