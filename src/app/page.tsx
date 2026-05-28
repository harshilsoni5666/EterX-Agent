"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Sidebar } from '../components/layout/sidebar';
import { ChatInput } from '../components/layout/chat-input';
import { AgentTeamView } from '../components/chat/agent-team-view';
import { ChatFeed } from '../components/chat/chat-feed';
import { AlertTriangle, CheckCircle2, ChevronDown, Clock3, Code2, GraduationCap, MessageSquare, Monitor, Pencil, PenTool, PanelLeft, SendHorizontal, SquarePen, Search, X, ArrowLeft, Trash } from 'lucide-react';
import { Tooltip } from '../components/ui/tooltip';
import { motion, AnimatePresence } from 'framer-motion';
import { InteractiveGrid } from '../components/ui/interactive-grid';
import { GeminiLiveSession, LiveSessionState } from '../lib/live/gemini-live';
import {
  MAIN_AGENT_THINKING_LEVEL_STORAGE_KEY,
  normalizeMainAgentThinkingLevel,
  type MainAgentMode,
  type MainAgentThinkingLevel,
} from '../lib/agent/model-routing';
import {
  createCustomToolActionLog,
  createCustomToolResultLogs,
  createCustomWorkNoteLog,
  normalizeCustomAgentStatus,
  shouldShowCustomAgentStatus,
  type CustomToolActiveTrace,
} from '../lib/agent/custom-agent-trace-adapter';
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

const MonitorPanel = dynamic(
  () => import('../components/monitor/ModernMonitorPanel').then(mod => mod.MonitorPanel),
  { ssr: false },
);

interface ChatSession {
  id: string;
  title: string;
  updatedAt: number;
  traceLogs: any[];
  isFavorite?: boolean;
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
  for (let i = logs.length - 1; i >= 0; i--) {
    const log = logs[i];
    if (!log || log.type === 'user_action' || log.type === 'task_plan') continue;
    const text = getPetLogText(log);
    if (text) return text;
  }
  return isThinking ? 'Thinking' : '';
};

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
  const previewText = latestText || (isThinking ? 'Thinking' : '');

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
      className={`group fixed z-[9998] w-[372px] max-w-[calc(100vw-24px)] select-none rounded-[22px] border border-white/[0.16] bg-[#171717]/96 text-[#F2F0EC] shadow-[0_18px_54px_rgba(0,0,0,0.36),inset_0_1px_0_rgba(255,255,255,0.055)] backdrop-blur-2xl ${replyOpen ? 'p-3' : 'px-4 py-3'}`}
      style={{ left: position.x, top: position.y }}
      onPointerDown={startDrag}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close pet monitor"
        className="absolute -left-2 -top-2 flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.16] bg-[#1F1F1F] text-white/72 opacity-0 shadow-[0_10px_26px_rgba(0,0,0,0.28)] transition-all duration-100 hover:bg-[#2A2A2A] hover:text-white group-hover:opacity-100 focus:opacity-100"
      >
        <X className="h-4 w-4" strokeWidth={2.3} />
      </button>

      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[20px] font-semibold leading-6 tracking-normal text-white">
            {displayTitle}
          </div>
          {replyOpen ? (
            <div className="mt-2 line-clamp-2 text-[15px] font-medium leading-5 text-[#DAD7D1]">
              {previewText}
            </div>
          ) : (
            <div className="mt-1 line-clamp-2 text-[18px] font-medium leading-6 text-[#F2F0EC] group-hover:hidden">
              {previewText}
            </div>
          )}
          {!replyOpen && (
            <div className="mt-1 hidden text-[18px] font-medium leading-6 text-[#F2F0EC] group-hover:block">
              Thinking
            </div>
          )}
        </div>

        <span className="mt-1 h-[15px] w-[15px] shrink-0 rounded-full border-2 border-white/35 border-t-white animate-spin" />
      </div>

      {!replyOpen && (
        <button
          type="button"
          onClick={() => setReplyOpen(true)}
          className="absolute bottom-3 right-4 hidden rounded-full border border-white/[0.10] bg-white/[0.055] px-4 py-1.5 text-[15px] font-medium text-[#E8E5DF] transition-colors hover:bg-white/[0.10] hover:text-white group-hover:block"
        >
          Reply
        </button>
      )}

      {replyOpen && (
        <div className="mt-3 border-t border-white/[0.08] pt-3">
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
              className="h-10 min-w-0 flex-1 select-text rounded-[10px] border border-[#6EA8FF]/70 bg-[#151515] px-3 text-[15px] font-medium text-white outline-none placeholder:text-[#8C8984] focus:border-[#8AB4FF]"
            />
            <button
              type="button"
              onClick={submitReply}
              disabled={!replyText.trim()}
              className="h-10 shrink-0 rounded-full bg-[#B8B4AC] px-4 text-[15px] font-semibold text-[#202020] transition-colors hover:bg-[#D8D4CC] disabled:cursor-default disabled:opacity-45"
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
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const latestChatPanelWidthRef = useRef<number | null>(null);
  const [chatPanelWidth, setChatPanelWidth] = useState<number | null>(null);
  const [isResizingPanels, setIsResizingPanels] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [pendingSteering, setPendingSteering] = useState<{id: string, text: string}[]>([]);
  // Per-chat thinking state: Set of chatIds that have running agents
  const [runningChats, setRunningChats] = useState<Set<string>>(new Set());
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
  const [headerSearchOpen, setHeaderSearchOpen] = useState(false);
  const [headerSearchQuery, setHeaderSearchQuery] = useState("");
  const [activeView, setActiveView] = useState<'chat' | 'code' | 'agents'>('chat');
  const [agentMode, setAgentMode] = useState<MainAgentMode>('think');
  const [thinkingLevel, setThinkingLevelState] = useState<MainAgentThinkingLevel>('low');
  const [selectedAgentState, setSelectedAgentState] = useState<SelectedAgentState>({
    agentId: null,
    agentName: 'General',
  });
  const [pinnedItems, setPinnedItems] = useState<PinnedItem[]>([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [agentTeamOpen, setAgentTeamOpen] = useState(false);
  const [petWidgetOpen, setPetWidgetOpen] = useState(false);
  const [nativePetAvailable, setNativePetAvailable] = useState(false);
  const canUseMonitor = activeView === 'chat' && !!activeChatId;
  const [networkPhase, setNetworkPhase] = useState<NetworkBannerPhase>('online');
  const [networkBannerVisible, setNetworkBannerVisible] = useState(false);
  const selectedAgent = selectedAgentState.agentId;
  const selectedAgentName = selectedAgentState.agentName;
  const networkPausedRef = useRef(false);
  const networkOutageIdRef = useRef(0);
  const networkDismissedOutageRef = useRef<number | null>(null);
  const networkRestoreTimerRef = useRef<number | null>(null);
  const networkBannerVisibleRef = useRef(false);
  const runningChatsRef = useRef<Set<string>>(new Set());
  const isNetworkPaused = networkPhase === 'offline';

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
  // CRITICAL: Ref for activeChatId so polling closures always see the latest value
  const activeChatIdRef = useRef<string | null>(null);
  const localStorageTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingLocalStorageWrite = useRef(false);
  const panelResizeCleanupRef = useRef<(() => void) | null>(null);
  // Keep ref synced with state
  activeChatIdRef.current = activeChatId;
  runningChatsRef.current = runningChats;
  networkBannerVisibleRef.current = networkBannerVisible;

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
        localStorage.setItem('eterx_chats', JSON.stringify(updated));
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
        body: JSON.stringify({ chatId: activeChatId || `live_${ Date.now() }` })
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
                localStorage.setItem('eterx_chats', JSON.stringify(updated));
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
        // Page just became visible — immediately trigger a catch-up for all running chats
        // so we deliver all accumulated traces smoothly rather than waiting for next timeout
        for (const catchUpPoll of catchUpPollersRef.current.values()) {
          catchUpPoll();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);


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
          localStorage.setItem('eterx_chats', JSON.stringify(sorted));
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
      try { localStorage.setItem('eterx_chats', JSON.stringify(sorted)); } catch { }
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
                  try { localStorage.setItem('eterx_chats', JSON.stringify(updated)); } catch { }
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

  const handleOpenAgentBuilder = (id: string) => {
    setBuildingAgentId(id);
    const builderChatId = `agent_builder_${id}`;
    let chat = chats.find(c => c.id === builderChatId);
    if (!chat) {
      chat = {
        id: builderChatId,
        title: `Building Agent: ${id}`,
        updatedAt: Date.now(),
        traceLogs: []
      };
      setChats(prev => {
        const updated = [chat!, ...prev];
        localStorage.setItem('eterx_chats', JSON.stringify(updated));
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

    setChats(prev => {
      const updatedChats = prev.filter(c => !deleteSet.has(c.id));
      try { localStorage.setItem('eterx_chats', JSON.stringify(updatedChats)); } catch { }
      return updatedChats;
    });

    if (deletingActiveChat) {
      setActiveChatId(null);
      setTraceLogs([]);
      setInputValue('');
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
      localStorage.setItem('eterx_chats', JSON.stringify(sorted));
      return sorted;
    });
  };

  const toggleFavorite = (id: string) => {
    setChats(prev => {
      const updated = prev.map(c =>
        c.id === id ? { ...c, isFavorite: !c.isFavorite } : c
      );
      const sorted = sortChats(updated);
      localStorage.setItem('eterx_chats', JSON.stringify(sorted));
      return sorted;
    });
  };

  const generateTitle = async (chatId: string, history: any[], currentTitle?: string, mode: MainAgentMode = agentMode) => {
    try {
      // Use passed title or fall back to finding in current state (for background updates)
      const existingTitle = currentTitle || chats.find(c => c.id === chatId)?.title || DEFAULT_CHAT_TITLE;

      const res = await fetch('/api/chat/title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          history,
          currentTitle: existingTitle,
          mode
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.title && !isDefaultChatTitle(data.title) && data.title !== existingTitle) {
          setChats(prev => {
            const updated = prev.map(c =>
              c.id === chatId ? { ...c, title: data.title, updatedAt: Date.now() } : c
            );
            const sorted = sortChats(updated);
            localStorage.setItem('eterx_chats', JSON.stringify(sorted));
            return sorted;
          });
        }
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

  /**
   * Process raw server trace events into the format expected by the UI.
   * Handles merging thought_stream, answer, and other events.
   */
  const processServerTraces = (traces: any[], existingLogs: any[] = []): any[] => {
    const logs: any[] = [];
    // Only dedup within current turn (after last user_action in existing logs)
    const lastUserIdx = existingLogs.reduceRight((found, l, i) => found === -1 && l.type === 'user_action' ? i : found, -1);
    const dedupScope = lastUserIdx >= 0 ? existingLogs.slice(lastUserIdx) : existingLogs;
    for (const trace of traces) {
      // Deduplicate by _traceIdx only within current turn
      if (trace._traceIdx !== undefined && dedupScope.some(l => l._traceIdx === trace._traceIdx)) continue;

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
        for (let i = logs.length - 1; i >= 0; i--) {
          if (logs[i].type === 'user_action') break;
          if (
            logs[i].type === 'work_note' &&
            (logs[i].subAgent || null) === subAgent &&
            (!noteId || logs[i].noteId === noteId)
          ) {
            logs.splice(i, 1);
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
          logs[mergeIdx] = { ...logs[mergeIdx], text: trace.text, thoughtId, _traceIdx: trace._traceIdx, timestamp: traceAt, endTime: traceAt };
        } else {
          logs.push({ type: 'thought_stream', text: trace.text, subAgent, thoughtId, _traceIdx: trace._traceIdx, timestamp: traceAt, startTime: traceAt, endTime: traceAt });
        }
      } else if (trace.type === 'work_note') {
        const subAgent = trace.subAgent || null;
        const noteId = trace.noteId || null;
        const noteText = String(trace.text || '').trim();
        if (!noteText) continue;
        const incomingIsFinal = trace.isStreaming === false || trace.isDelta === false;
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
          };
        } else {
          logs.push({ ...processedLog, type: 'work_note', text: noteText, subAgent, noteId, _traceIdx: trace._traceIdx, startTime: processedLog.startTime, endTime: traceAt });
        }
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
        // Replace existing preview for same file (post-edit update)
        const existingIdx = logs.findLastIndex((l: any) => l.type === 'file_preview' && l.filepath === trace.filepath);
        if (existingIdx >= 0) {
          logs[existingIdx] = { ...processedLog, startTime: logs[existingIdx].startTime || processedLog.startTime, endTime: traceAt };
        } else {
          logs.push(processedLog);
        }
      } else if (trace.type === 'console_output') {
        const isDup = logs.some((l: any) => l.type === 'console_output' && l.command === trace.command && l.output === trace.output);
        if (!isDup) {
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
          try { localStorage.setItem('eterx_chats', JSON.stringify(currentChats)); } catch { }
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
    if (typeof runStartedAfter === 'number') {
      pollRunStartRef.current.set(chatId, runStartedAfter);
    }

    // Don't start duplicate pollers, but do refresh their cursor/guard and
    // force an immediate catch-up. This handles reconnects and new sends cleanly.
    if (pollingIntervalsRef.current.has(chatId)) {
      pollCursorsRef.current.set(chatId, initialCursor);
      catchUpPollersRef.current.get(chatId)?.();
      return;
    }

    pollCursorsRef.current.set(chatId, initialCursor);
    let idleCount = 0; // Track consecutive idle responses
    let errorBackoff = 0; // Exponential backoff on errors (0 = no error)
    let lastHadData = false; // Track if last poll had new data

    const finishDisconnectedStart = (message: string) => {
      stopPolling(chatId);
      clearAgentConnectionStatus(chatId);
      removeRunningChat(chatId);
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
      if (!pollingIntervalsRef.current.has(chatId)) return;
      if (networkPausedRef.current) {
        errorBackoff = 0;
        lastHadData = false;
        scheduleNextPoll();
        return;
      }

      try {
        const cursor = pollCursorsRef.current.get(chatId) ?? -1;
        const data = await fetchAgentPoll(chatId, cursor);

        // Reset error backoff on successful fetch
        errorBackoff = 0;

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
            for (const trace of data.traces) {
              // DEDUP: only skip if _traceIdx already exists in the CURRENT TURN (not old questions)
              if (trace._traceIdx !== undefined && currentTurnLogs.some((l: any) => l._traceIdx === trace._traceIdx)) continue;
              const timedTrace = withTraceTiming(trace);
              const traceAt = timedTrace.endTime;

              if (trace.type === 'work_note_cancel') {
                const subAgent = trace.subAgent || null;
                const noteId = trace.noteId || null;
                for (let i = logs.length - 1; i >= 0; i--) {
                  if (logs[i].type === 'user_action') break;
                  if (
                    logs[i].type === 'work_note' &&
                    (logs[i].subAgent || null) === subAgent &&
                    (!noteId || logs[i].noteId === noteId)
                  ) {
                    logs.splice(i, 1);
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
                  logs[mergeIdx] = { ...logs[mergeIdx], text: trace.text, thoughtId, _traceIdx: trace._traceIdx, timestamp: traceAt, endTime: traceAt };
                } else {
                  logs.push({ type: 'thought_stream', text: trace.text, subAgent, thoughtId, _traceIdx: trace._traceIdx, timestamp: traceAt, startTime: traceAt, endTime: traceAt });
                }
              } else if (trace.type === 'work_note') {
                const subAgent = trace.subAgent || null;
                const noteId = trace.noteId || null;
                const noteText = String(trace.text || '').trim();
                if (!noteText) continue;
                const incomingIsFinal = trace.isStreaming === false || trace.isDelta === false;
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
                  };
                } else {
                  logs.push({ ...timedTrace, type: 'work_note', text: noteText, subAgent, noteId, _traceIdx: trace._traceIdx, startTime: timedTrace.startTime, endTime: traceAt });
                }
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
                // Dedup by filepath: replace existing preview for same file with latest post-edit version
                const existingIdx = logs.findLastIndex((l: any) => l.type === 'file_preview' && l.filepath === trace.filepath);
                if (existingIdx >= 0) {
                  logs[existingIdx] = { ...timedTrace, startTime: logs[existingIdx].startTime || timedTrace.startTime, endTime: traceAt };
                } else {
                  logs.push(timedTrace);
                }
              } else if (trace.type === 'console_output') {
                // Always push new console output — each shell execution is a unique event
                // Dedup only exact same command+output combo
                const isDup = logs.some((l: any) => l.type === 'console_output' && l.command === trace.command && l.output === trace.output);
                if (!isDup) {
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

          // Final save to localStorage (immediate, not debounced)
          // Strip large content fields (file_preview.content, console_output.output) before saving
          // to prevent localStorage quota exceeded errors
          setChats(currentChats => {
            const stripped = currentChats.map(chat => ({
              ...chat,
              traceLogs: (chat.traceLogs || []).map((log: any) => {
                if (log.type === 'file_preview' && log.content && log.content.length > 500) {
                  // Keep all metadata, just strip the large content blob
                  const { content: _c, ...rest } = log;
                  return { ...rest, _contentStripped: true };
                }
                if (log.type === 'console_output' && log.output && log.output.length > 500) {
                  const { output: _o, ...rest } = log;
                  return { ...rest, _contentStripped: true };
                }
                return log;
              })
            }));
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
      if (pollingIntervalsRef.current.has(chatId)) {
        // Remove old entry before scheduling (setTimeout returns a new ID)
        pollingIntervalsRef.current.delete(chatId);
        scheduleNextPoll();
      }
    };

    // Kick off the first poll AND register for visibility catch-up
    catchUpPollersRef.current.set(chatId, () => {
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
  const stopPolling = (chatId: string) => {
    const timeoutId = pollingIntervalsRef.current.get(chatId);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    pollingIntervalsRef.current.delete(chatId);
    pollCursorsRef.current.delete(chatId);
    pollRunStartRef.current.delete(chatId);
    catchUpPollersRef.current.delete(chatId);
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
        await fetch(`${NETWORK_PROBE_URL}?t=${Date.now()}`, {
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
    setAgentTeamOpen(true);
    // If a specific agent name is passed, the AgentTeamView will focus on it
    // via its own internal state from the traceLogs
  }, []);

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
    const runAgentMode = agentMode;
    const runThinkingLevel = thinkingLevel;
    const currentAttachments = [...attachments];
    const userLogAttachments = currentAttachments.map(serializeComposerAttachment);
    const runStartedAt = Date.now();
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

      const newChat: ChatSession = {
        id: chatIdToUse,
        title: DEFAULT_CHAT_TITLE,
        updatedAt: Date.now(),
        traceLogs: [userLog]
      };

      setChats(prev => {
        const updated = [newChat, ...prev];
        localStorage.setItem('eterx_chats', JSON.stringify(updated));
        return updated;
      });
      setTraceLogs([userLog]);

      // Initial parallel naming
      generateTitle(chatIdToUse, [{ role: 'user', parts: [{ text: promptText }] }], DEFAULT_CHAT_TITLE, runAgentMode);
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
    const isCustomAgentRun = !!selectedAgent && selectedAgent !== 'coding' && !isBuilderChat;

    if (isCustomAgentRun) {
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const answerLogId = `custom_agent_answer_${runStartedAt}`;
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

      const appendCustomAgentStatus = (text: string) => {
        const cleanText = normalizeCustomAgentStatus(text);
        if (!shouldShowCustomAgentStatus(cleanText)) return;
        const at = Date.now();
        appendCustomAgentTrace({
          id: `custom_status_${at}_${Math.random().toString(36).slice(2, 8)}`,
          type: 'thought_stream',
          text: cleanText,
          subAgent: selectedAgentName,
          startTime: at,
          endTime: at,
          timestamp: at,
        });
      };

      const flushCustomWorkNote = () => {
        const noteLog = createCustomWorkNoteLog(
          pendingCustomText,
          selectedAgentName,
          `custom_work_${runStartedAt}_${customWorkNoteSeq++}`,
          Date.now(),
        );
        pendingCustomText = '';
        if (noteLog) appendCustomAgentTrace(noteLog);
      };

      const attachmentContext = mediaAttachments.length > 0
        ? `\n\n[Attached files]\n${mediaAttachments.map(att => `- ${att.name}${att.path ? ` (${att.path})` : ''}`).join('\n')}`
        : '';

      const runnerMessages = [
        ...historySourceLogs
          .filter(log => log.type === 'user_action' || log.type === 'answer')
          .map(log => ({
            role: log.type === 'user_action' ? 'user' : 'model',
            content: String(log.text || ''),
          })),
        { role: 'user', content: `${promptText}${attachmentContext}` },
      ];

      try {
        const response = await fetch('/api/agents/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: selectedAgent,
            messages: runnerMessages,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          let message = `Custom agent start failed (${response.status}).`;
          try {
            const payload = await response.json();
            message = payload.error || message;
          } catch { }
          setChatLogsById(chatIdToUse!, logs => [
            ...stripAgentConnectionLogs(logs),
            systemThoughtLog(`\n\n*${message}*`),
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
            appendCustomAgentStatus(String(event.text || ''));
          } else if (event.type === 'tool_call') {
            const at = Date.now();
            flushCustomWorkNote();
            const actionLog = createCustomToolActionLog(event, selectedAgentName, at);
            activeCustomToolLogs.set(String(event.toolName || ''), {
              id: actionLog.id,
              toolName: String(event.toolName || ''),
              command: actionLog.command ? String(actionLog.command) : undefined,
              filename: actionLog.filename ? String(actionLog.filename) : undefined,
              toolArgs: event.toolArgs,
            });
            appendCustomAgentTrace(actionLog);
          } else if (event.type === 'tool_result') {
            const at = Date.now();
            const active = activeCustomToolLogs.get(String(event.toolName || ''));
            if (active) {
              updateCustomAgentTrace(active.id, {
                endTime: at,
                timestamp: at,
                toolResult: event.toolResult,
              });
              createCustomToolResultLogs(event, active, at).forEach(appendCustomAgentTrace);
              activeCustomToolLogs.delete(String(event.toolName || ''));
            }
          } else if (event.type === 'error') {
            const message = String(event.text || 'Custom agent failed.');
            setChatLogsById(chatIdToUse!, logs => [
              ...stripAgentConnectionLogs(logs),
              systemThoughtLog(`\n\n*${message.slice(0, 240)}*`),
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
            systemThoughtLog(`\n\n*Custom agent connection failed: ${String(error.message || error).slice(0, 180)}*`),
          ], { touchUpdatedAt: true });
        }
      } finally {
        abortControllerRef.current = null;
        removeRunningChat(chatIdToUse!);
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
    };
    const hasPinnedContext = Object.keys(requestPinnedContext).length > 0;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Reset cursor for this chat so second/third questions always stream from scratch
    pollCursorsRef.current.set(chatIdToUse!, -1);
    pollRunStartRef.current.set(chatIdToUse!, runStartedAt);
    startPolling(chatIdToUse!, -1, runStartedAt);
    let serverAccepted = false;
    // Also start SSE stream for faster real-time events (optional enhancement)
    try {
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
          pinnedContext: hasPinnedContext ? requestPinnedContext : null
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        let message = `Agent start failed (${response.status}).`;
        try {
          const errorPayload = await response.json();
          message = errorPayload.error || errorPayload.details || message;
        } catch { }

        stopPolling(chatIdToUse!);
        removeRunningChat(chatIdToUse!);
        setChatLogsById(chatIdToUse!, prev => [
          ...stripAgentConnectionLogs(prev),
          systemThoughtLog(`\n\n*${message}*`)
        ]);
        return;
      }

      serverAccepted = true;

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
      abortControllerRef.current = null;
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
                  try { localStorage.setItem('eterx_chats', JSON.stringify(updated)); } catch { }
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
  const displayTraceLogs = useMemo(() => [
    ...(liveState !== 'idle'
      ? traceLogs.filter(l => l.type !== 'thought_stream')
      : traceLogs),
    ...getLiveTraceLogs()
  ], [liveState, traceLogs, getLiveTraceLogs]);
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
  const currentSubAgents = useMemo(() => {
    const agentMap = new Map<string, any>();
    for (const log of traceLogs) {
      if (!log) continue;
      const name = log.agentName || log.subAgent;
      if (!name) continue;
      if (log.type === 'sub_agent_spawn') {
        agentMap.set(name, {
          name, status: 'spawning', task: log.secondary || log.text || '',
          stepCount: 0, durationMs: 0, startedAt: Date.now(),
        });
      } else if (log.type === 'sub_agent_action') {
        const a = agentMap.get(name);
        if (a) { a.status = 'working'; a.currentAction = log.text?.substring(0, 80); a.stepCount = log.agentStep || (a.stepCount + 1); }
      } else if (log.type === 'sub_agent_complete') {
        const a = agentMap.get(name);
        if (a) { a.status = 'completed'; a.durationMs = log.durationMs || 0; a.stepCount = log.stepCount || a.stepCount; }
      } else if (log.type === 'sub_agent_error') {
        const a = agentMap.get(name);
        if (a) { a.status = 'error'; }
      }
    }
    return Array.from(agentMap.values());
  }, [traceLogs]);
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

  return (
    <div className="eterx-app-shell flex h-screen font-sans overflow-hidden selection:bg-[#E2765A]/30 transition-colors relative">
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
      {/* Empty-state motion field: soft Gemini-style color waves behind the app shell. */}
      <div className={`absolute bottom-0 left-0 right-0 h-[45vh] pointer-events-none overflow-hidden z-0 flex items-end justify-center ${ ((traceLogs.length === 0 && liveState === 'idle') || (activeView === 'agents' && !buildingAgentId)) ? 'opacity-100 transition-all duration-[1000ms] ease-out' : 'opacity-0 transition-all duration-[1000ms] ease-in' }`}>
        <div key={`eterx-home-field-${activeChatId ?? 'new'}`} className="eterx-home-field">
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
        onSettingsClick={() => setIsSettingsOpen(true)}
      />

      <SettingsPanel isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />

      <div className="flex-1 flex flex-col relative bg-transparent overflow-hidden z-10 transition-all duration-300">
        <div className="pointer-events-none absolute left-0 right-0 top-0 z-40 h-[92px] bg-[linear-gradient(180deg,#0F0F0F_0%,rgba(15,15,15,0.98)_46%,rgba(15,15,15,0.56)_78%,transparent_100%)]" />
        {/* Absolute Header (Draggable Region for Electron) */}
        <>
            <div className="h-14 flex items-center justify-between pl-4 pr-[140px] z-50 pointer-events-none [-webkit-app-region:drag] shrink-0">
              <div className="flex items-center gap-2 pointer-events-auto [-webkit-app-region:no-drag] h-full pt-3">
                {!sidebarOpen && (
                  <div className="flex md:hidden items-center gap-1 mr-2 mt-0">
                    <Tooltip text="Open sidebar" side="bottom">
                      <div onClick={() => setSidebarOpen(true)} className="p-1.5 rounded-full hover:bg-white/10 active:bg-white/20 active:scale-95 transition-all text-[#8C8A88] hover:text-white cursor-pointer">
                        <PanelLeft className="w-[18px] h-[18px]" />
                      </div>
                    </Tooltip>
                  </div>
                )}
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
                {(() => {
                  if (activeView === 'agents' && !buildingAgentId) return null;
                  const activeChat = activeChatId ? chats.find(c => c.id === activeChatId) : null;
                  const titleText = activeChat ? activeChat.title : DEFAULT_CHAT_TITLE;

                  return (
                    <div className="relative [-webkit-app-region:no-drag]">
                      <div
                        onClick={() => {
                          setHeaderMenuOpen(!headerMenuOpen);
                        }}
                        className={`flex items-center gap-2 text-[14px] font-medium px-3 py-1.5 rounded-lg transition-all duration-300 border backdrop-blur-md ${ headerMenuOpen ? 'cursor-pointer bg-white/[0.12] border-white/[0.15] text-white shadow-sm scale-[0.98]' : 'cursor-pointer bg-white/[0.05] border-white/[0.08] text-[#E8E6E3] hover:bg-white/[0.08] hover:border-white/[0.12] active:scale-[0.98] shadow-sm' }`}
                      >
                        <span className="truncate max-w-[400px]">{titleText}</span>
                        <ChevronDown className={`w-4 h-4 text-[#555350] shrink-0 transition-transform duration-200 ${ headerMenuOpen ? 'rotate-180' : '' }`} />
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
                              className="absolute top-10 left-0 w-[300px] z-50 bg-[#1A1A1A]/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.4)] p-2 flex flex-col max-h-[400px]"
                            >
                              <div className="flex items-center justify-between px-2 mb-2 mt-1 h-6">
                                {!headerSearchOpen ? (
                                  <>
                                    <div className="text-[11px] font-semibold text-[#555350] uppercase tracking-wider">Threads</div>
                                    <Search
                                      className="w-3.5 h-3.5 text-[#555350] hover:text-[#E8E6E3] cursor-pointer transition-colors"
                                      onClick={(e) => { e.stopPropagation(); setHeaderSearchOpen(true); }}
                                    />
                                  </>
                                ) : (
                                  <motion.div
                                    initial={{ width: 0, opacity: 0 }}
                                    animate={{ width: "100%", opacity: 1 }}
                                    className="flex items-center gap-2 w-full bg-white/5 rounded-md px-2 py-1 h-full"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <Search className="w-3 h-3 text-[#A3A19E]" />
                                    <input
                                      type="text"
                                      autoFocus
                                      placeholder="Search threads..."
                                      value={headerSearchQuery}
                                      onChange={(e) => setHeaderSearchQuery(e.target.value)}
                                      className="bg-transparent border-none outline-none text-[12px] text-[#E8E6E3] placeholder:text-[#555350] w-full"
                                    />
                                    <X
                                      className="w-3 h-3 text-[#555350] hover:text-[#E8E6E3] cursor-pointer"
                                      onClick={(e) => { e.stopPropagation(); setHeaderSearchOpen(false); setHeaderSearchQuery(""); }}
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
                                    return <div className="px-2 py-2 text-[13px] text-[#555350] italic">No threads found</div>;
                                  }

                                  return filteredChats.map(chat => (
                                    <div
                                      key={chat.id}
                                      onClick={() => {
                                        loadChat(chat.id);
                                        setHeaderMenuOpen(false);
                                      }}
                                      className={`w-full text-left px-3 py-2 text-[13px] rounded-lg truncate transition-all duration-150 flex items-center group cursor-pointer border border-transparent active:scale-[0.98] ${ activeChatId === chat.id ? 'bg-white/10 text-white font-medium shadow-sm' : 'text-[#A3A19E] hover:bg-white/5 active:bg-white/10 hover:text-[#E8E6E3]' }`}
                                    >
                                      {chat.title}
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
            </div>

            
            {/* Agent Team Toggle Button */}
            {(currentSubAgents.length > 0 || isThinking) && (
              <div className="absolute top-3 right-[228px] z-50 pointer-events-auto [-webkit-app-region:no-drag]">
                <button id="agent-team-toggle-btn"
                  onClick={() => setAgentTeamOpen(o => !o)}
                  className={`flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[11px] font-semibold transition-all border shadow-[0_10px_28px_rgba(0,0,0,0.18)] ${
                    agentTeamOpen
                      ? 'bg-violet-400/[0.12] border-violet-300/30 text-violet-200 shadow-[0_0_0_1px_rgba(139,92,246,0.08),0_14px_34px_rgba(139,92,246,0.14)]'
                      : 'bg-white/[0.035] border-white/[0.085] text-white/45 hover:border-violet-300/22 hover:bg-violet-300/[0.06] hover:text-violet-100'
                  }`}
                >
                  <svg className={`w-3.5 h-3.5 ${agentTeamOpen ? 'text-violet-300' : 'text-white/45'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
                    <path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                  </svg>
                  <span className="hidden sm:inline">Team</span>
                  {currentSubAgents.filter((a: any) => a.status === 'working' || a.status === 'spawning').length > 0 && (
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse ml-0.5" />
                  )}
                </button>
              </div>
            )}

{/* Computer Toggle Button */}
            {canUseMonitor && (
              <div className="absolute top-3 right-[152px] z-50 pointer-events-auto [-webkit-app-region:no-drag]">
                <Tooltip text={monitorOpen ? 'Close Computer' : 'Open Computer'} side="bottom">
                  <button id="computer-toggle-btn"
                    onClick={() => setMonitorOpen(o => !o)}
                    className={`flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[11px] font-semibold transition-all border shadow-[0_10px_28px_rgba(0,0,0,0.18)] ${
                      monitorOpen
                        ? 'bg-sky-400/[0.12] border-sky-300/30 text-sky-200 shadow-[0_0_0_1px_rgba(125,211,252,0.08),0_14px_34px_rgba(14,165,233,0.14)]'
                        : 'bg-white/[0.035] border-white/[0.085] text-white/45 hover:border-sky-300/22 hover:bg-sky-300/[0.06] hover:text-sky-100'
                    }`}
                  >
                    <Monitor className={`w-3.5 h-3.5 ${monitorOpen ? 'text-sky-300' : 'text-white/45'}`} />
                    <span className="hidden sm:inline">Computer</span>
                    {isThinking && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse ml-0.5" />}
                  </button>
                </Tooltip>
              </div>
            )}

            {/* Split Content Area */}
            <div
              ref={splitContainerRef}
              className={`flex-1 flex overflow-hidden w-full relative ${isResizingPanels ? 'cursor-col-resize select-none' : ''}`}
            >
              {activeView === 'agents' && !buildingAgentId ? (
                <AgentsView
                  onOpenBuilder={handleOpenAgentBuilder}
                  onUseAgent={handleUseAgentInChat}
                  selectedAgentId={selectedAgent}
                />
              ) : (
                <>
                  {/* Chat Container */}
                  <div
                    className={`flex flex-col relative h-full min-w-0 ${ hasOpenFiles ? `shrink-0 min-w-[320px] ${isResizingPanels ? 'transition-none' : 'transition-[width,flex-basis] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'}` : 'w-full transition-all duration-300' }`}
                    style={hasOpenFiles ? { width: chatPanelWidth ?? undefined, flexBasis: chatPanelWidth === null ? `${DEFAULT_CHAT_PANEL_RATIO * 100}%` : undefined } : undefined}
                  >
                    <ChatFeed
                      key={activeChatId}
                      traceLogs={displayTraceLogs}
                      isThinking={isThinking}
                      messagesEndRef={messagesEndRef}
                      setSidebarOpen={setSidebarOpen}
                      sidebarOpen={sidebarOpen}
                      handleScroll={handleScroll}
                      showScrollBottom={showScrollBottom}
                      isCompressed={hasOpenFiles}
                    />

                  {/* Pending Steering Queue */}
                  {pendingSteering.length > 0 && (
                    <div className={`px-4 ${hasOpenFiles ? 'sm:px-4' : 'sm:px-12'} w-full max-w-[800px] mx-auto flex flex-col gap-2 pb-2`}>
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

                <ChatInput
                  inputValue={inputValue}
                  setInputValue={setInputValue}
                  isThinking={isThinking}
                  isRecording={isRecording}
                  handleSend={handleSend}
                  handleStop={handleStop}
                  handleSteer={handleSteer}
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
                  isCompressed={hasOpenFiles}
                  taskTracker={currentTaskTracker}
                  activeSubAgents={currentSubAgents}
                  onOpenTeamView={() => setAgentTeamOpen(true)}
                  activeChatId={activeChatId}
                  onOpenAgentBuilder={handleOpenAgentBuilder}
                  selectedAgent={selectedAgent}
                  selectedAgentName={selectedAgentName}
                  onAgentChange={handleAgentChange}
                  onOpenPet={openPetWidget}
                  onOpenAgents={() => {
                    setBuildingAgentId(null);
                    setActiveView('agents');
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

              {hasOpenFiles && (
                <button
                  type="button"
                  role="separator"
                  aria-label="Resize chat and file panels"
                  aria-orientation="vertical"
                  title="Drag to resize panels. Double-click to reset."
                  onPointerDown={handlePanelResizeStart}
                  onDoubleClick={resetPanelSplit}
                  onKeyDown={handlePanelResizeKeyDown}
                  className={`group relative z-30 flex h-full w-[16px] shrink-0 cursor-col-resize items-center justify-center outline-none transition-opacity duration-200 ${isResizingPanels ? 'opacity-100' : 'opacity-60 hover:opacity-100 focus-visible:opacity-100'}`}
                >
                  <span className="absolute inset-y-4 left-1/2 w-px -translate-x-1/2 rounded-full bg-white/[0.055] transition-colors duration-200 group-hover:bg-white/[0.14] group-focus-visible:bg-white/[0.18]" />
                  <span className={`relative flex h-16 w-[9px] items-center justify-center rounded-full border shadow-[0_14px_30px_rgba(0,0,0,0.34)] transition-all duration-200 ${isResizingPanels ? 'border-white/25 bg-[#303030]' : 'border-white/[0.08] bg-[#1D1D1D]/90 group-hover:border-white/[0.18] group-hover:bg-[#272727]'}`}>
                    <span className={`h-8 w-[2px] rounded-full transition-colors duration-200 ${isResizingPanels ? 'bg-white/90' : 'bg-[#777] group-hover:bg-white/80 group-focus-visible:bg-white/90'}`} />
                  </span>
                </button>
              )}

              {/* Right Panel Container */}
              {hasOpenFiles && (
                <IdePanel />
              )}
              
              {/* Agent Team Panel */}
              <AnimatePresence>
                {agentTeamOpen && (
                  <AgentTeamView
                    traceLogs={displayTraceLogs}
                    isThinking={isThinking}
                    onClose={() => setAgentTeamOpen(false)}
                  />
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
