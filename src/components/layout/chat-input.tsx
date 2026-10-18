'use client';

import { refreshSavedModelCatalog } from '../../lib/model-catalog-client';
import { readChatPlanMode, writeChatPlanMode, readChatSwarmMode, writeChatSwarmMode, type summarizeChatUsage } from '../../lib/chat-command-state';
import { formatModelName, groupModelsByProvider } from '../../lib/agent/model-presentation';
import { PASTED_TEXT_MIME, shouldAttachPaste } from '../../lib/pasted-text';
import { AttachmentTextPreviewHost } from '../chat/attachment-text-preview';
import { QueuedMessageAttachments, type QueuedMessageAttachment } from '../chat/queued-message-attachments';
import type { ChatMediaItem } from '../chat/chat-media';
import { requestJson } from '../../lib/request-json';
import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Info, ChevronLeft, BookText, BarChart3, Route, FolderCog, Network, Lightbulb } from 'lucide-react';
import { CODING_MODES, getCodingMode, type CodingAgentId } from '../../lib/code/coding-modes';
import { CodingModeDetails } from './coding-mode-details';
import { motion, AnimatePresence } from 'framer-motion';
import { FileText, X, Check, Activity, CheckCircle2, XCircle, Folder, FolderClosed, File as FileIcon, ChevronDown, ChevronRight, Image as ImageIcon, AlertCircle, ListTodo, ArrowUpRight, LaptopMinimal, GitBranch, Search, FolderPlus, FolderOpen, Cloud, CloudOff, ExternalLink, Gauge, Plus, Minus, RotateCcw, Download, Copy, CircleSlash, GitFork, Terminal, Bot } from 'lucide-react';
import { PremiumMic, PremiumSend, PremiumPlus, PremiumAudioLines, PremiumVolume2, PremiumVolumeX, PremiumMicOff } from '../ui/premium-icons';
import { Tooltip } from '../ui/tooltip';
import { DictationButton } from '../ui/dictation-button';
import type { DictationPhase } from '../../lib/microphone';
import { Shimmer } from '../ui/shimmer';
import { AdaptiveMenu } from '../ui/adaptive-menu';
import { safeCopyPngToClipboard, safeCopyTextToClipboard, safeReadImageFromClipboard, safeReadTextFromClipboard } from '../ui/copy-button';
import { ConnectorsModal } from './connectors-modal';
import { AgentFace } from '../chat/agent-face';
import { notifyAgentFaceFiles, notifyAgentFaceInputChange, notifyAgentFaceSend } from '../chat/agent-face-controller';
import {
  getModelThinkingOptions,
  normalizeModelThinkingCapabilities,
  normalizeMainAgentThinkingLevel,
  normalizeThinkingLevelForModel,
  type MainAgentProvider,
  type MainAgentMode,
  type MainAgentThinkingLevel,
  type ModelThinkingCapabilities,
} from '../../lib/agent/model-routing';
import {
  AUTO_MODEL_SELECTION,
  API_KEY_PRESENCE_STORAGE_KEY,
  CHAT_MODEL_SELECTION_STORAGE_KEY,
  MODEL_API_KEY_PRESENCE_STORAGE_KEY,
  MODEL_CATALOG_STORAGE_KEY,
  MODEL_OVERRIDE_STORAGE_KEY,
  MODEL_PROVIDER_MODE,
  MODEL_SELECTOR_STORAGE_KEY,
  MODEL_THINKING_CAPABILITIES_STORAGE_KEY,
  MODEL_WIRE_CAPABILITIES_STORAGE_KEY,
  MODEL_THINKING_LEVELS_STORAGE_KEY,
  entriesToModelCatalog,
  ensureModelSelectorEntry,
  isEmbeddedModelLabel,
  modelEntryKey,
  normalizeModelSelectorEntries,
  parseModelEntryKey,
  type ModelSelectorEntry,
} from '../../lib/agent/model-selector-store';
import { appStorage, appStorageReady, FOLDER_STORAGE_READY_EVENT } from '../../lib/client-storage';
import { useManagedWorkspace } from '../../lib/use-managed-workspace';
import { WorkspaceLocationMenu } from './workspace-location-menu';
import { GitBranchControl } from './git-branch-control';
import type { RunLocation } from '../../lib/managed-workspaces';
import { isLocalModelProvider } from '../../lib/agent/provider-runtime';
import { formatExactContextTokens } from '../../lib/context-window-policy';
import { buildFilePreviewUrl, getNativeFilePath } from '../../lib/path-utils';
import { getFileIconPath } from '../../lib/utils/file-icon-utils';
import {
  CONTEXT_USAGE_CATEGORIES,
  formatContextUsageTokenCount,
  normalizeContextUsageBreakdown,
  type ContextUsageBreakdown,
} from '../../lib/context-usage-breakdown';

const MODEL_API_KEY_STORAGE_KEY = API_KEY_PRESENCE_STORAGE_KEY;
const SETTINGS_CHANNEL = 'eterx-settings';

// Model selection is configuration, not a chat credential payload. Keep its
// server update on the single Settings gateway used for all runtime config.
const syncRuntimeModelOverrides = (modelOverrides: Record<string, string>) => {
  void fetch('/api/settings/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelOverrides }),
  }).catch(() => {});
};

type StoredModelSettings = {
  apiKeys: Partial<Record<MainAgentProvider, string>>;
  modelOverrides: Partial<Record<MainAgentProvider, string>>;
  modelCatalog: Partial<Record<MainAgentProvider, string[]>>;
  modelEntries: ModelSelectorEntry[];
  modelApiKeys: Record<string, string>;
  thinkingCapabilities: Record<string, ModelThinkingCapabilities>;
  chatModelSelection: string;
};

type ChatModelOption = {
  optionKey: string;
  id: MainAgentMode;
  provider: MainAgentProvider;
  label: string;
  compactLabel: string;
  modelName: string;
  modelId?: string;
};

const MODEL_PROVIDER_LABEL: Record<MainAgentProvider, string> = {
  gemini: 'Google Gemini',
  mistral: 'Mistral',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek', grok: 'xAI Grok', cerebras: 'Cerebras', together: 'Together AI',
  fireworks: 'Fireworks AI', sambanova: 'SambaNova', perplexity: 'Perplexity',
  deepinfra: 'DeepInfra', huggingface: 'Hugging Face', nvidia: 'NVIDIA NIM',
  cloudflare: 'Cloudflare Workers AI', ollama: 'Ollama Local', lmstudio: 'LM Studio',
  vllm: 'vLLM', llamacpp: 'llama.cpp',
  novita: 'Novita AI', qwen: 'Qwen Cloud', mimo: 'Xiaomi MiMo',
  tokenhub: 'Tencent TokenHub', zai: 'Z.AI / GLM', kimi: 'Kimi / Moonshot',
  stepfun: 'StepFun', minimax: 'MiniMax', ollamacloud: 'Ollama Cloud',
  arcee: 'Arcee AI', gmi: 'GMI Cloud', kilo: 'Kilo Gateway',
  opencode: 'OpenCode Zen', upstage: 'Upstage Solar', custom: 'Custom endpoint',
};

const readStringRecord = (storageKey: string): Record<string, string> => {
  if (typeof window === 'undefined') return {};
  try {
    const storage = appStorage;
    const parsed = JSON.parse(storage.getItem(storageKey) || '{}');
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

const readStringArrayRecord = (storageKey: string): Record<string, string[]> => {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(appStorage.getItem(storageKey) || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([key, value]) => {
          const values = Array.isArray(value)
            ? value
            : typeof value === 'string'
              ? value.split(/[\n,]/)
              : [];
          return [
            key,
            Array.from(new Set(
              values
                .map(item => String(item || '').trim())
                .filter(Boolean),
            )),
          ];
        })
        .filter(([, value]) => value.length > 0),
    );
  } catch {
    return {};
  }
};

const readThinkingCapabilityRecord = (): Record<string, ModelThinkingCapabilities> => {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(appStorage.getItem(MODEL_THINKING_CAPABILITIES_STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([key, value]) => [key, normalizeModelThinkingCapabilities(value)] as const)
        .filter(([, value]) => Boolean(value)),
    ) as Record<string, ModelThinkingCapabilities>;
  } catch {
    return {};
  }
};

const readStoredModelSettings = (): StoredModelSettings => {
  const apiKeys = readStringRecord(MODEL_API_KEY_STORAGE_KEY) as Partial<Record<MainAgentProvider, string>>;
  const storedModelOverrides = readStringRecord(MODEL_OVERRIDE_STORAGE_KEY) as Partial<Record<MainAgentProvider, string>>;
  const modelCatalog = readStringArrayRecord(MODEL_CATALOG_STORAGE_KEY) as Partial<Record<MainAgentProvider, string[]>>;
  const savedEntries = typeof window !== 'undefined'
    ? (() => {
      try {
        return JSON.parse(appStorage.getItem(MODEL_SELECTOR_STORAGE_KEY) || '[]');
      } catch {
        return [];
      }
    })()
    : [];
  const storedChatModelSelection = typeof window !== 'undefined'
    ? (appStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) || AUTO_MODEL_SELECTION)
    : AUTO_MODEL_SELECTION;
  const parsedStoredChatModel = parseModelEntryKey(storedChatModelSelection);
  const modelEntries = normalizeModelSelectorEntries(savedEntries, modelCatalog);
  const modelOverrides = Object.fromEntries(
    Object.entries(storedModelOverrides).filter(([provider, modelId]) =>
      modelEntries.some(entry => entry.provider === provider && entry.modelId === modelId)
    ),
  ) as Partial<Record<MainAgentProvider, string>>;
  const modelApiKeys = readStringRecord(MODEL_API_KEY_PRESENCE_STORAGE_KEY);
  const thinkingCapabilities = readThinkingCapabilityRecord();
  const usableEntries = modelEntries.filter(entry =>
    isLocalModelProvider(entry.provider)
    || Boolean(apiKeys[entry.provider])
    || Boolean(modelApiKeys[modelEntryKey(entry.provider, entry.modelId)])
  );
  const chatModelSelection = parsedStoredChatModel && usableEntries.some(entry =>
    modelEntryKey(entry.provider, entry.modelId) === storedChatModelSelection
  )
    ? storedChatModelSelection
    : AUTO_MODEL_SELECTION;

  return {
    apiKeys,
    modelOverrides,
    modelCatalog,
    modelEntries,
    modelApiKeys,
    thinkingCapabilities,
    chatModelSelection,
  };
};

const emitModelSettingsUpdate = (detail: unknown) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('eterx-settings-updated', { detail }));
  try {
    const channel = new BroadcastChannel(SETTINGS_CHANNEL);
    channel.postMessage({ type: 'settings-updated', settings: detail });
    channel.close();
  } catch { }
};

const writeStoredAgentMode = (mode: MainAgentMode) => {
  if (typeof window === 'undefined') return;
  try {
    const saved = appStorage.getItem('eterx_settings');
    const settings = saved ? JSON.parse(saved) : {};
    appStorage.setItem('eterx_settings', JSON.stringify({ ...settings, agentMode: mode }));
  } catch { }
};

// ─── Connector State Hook ────────────────────────────────
const useConnectors = () => {
  const [connectedApps, setConnectedApps] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/connectors/status');
      if (res.ok) {
        const data = await res.json();
        const apps: Record<string, boolean> = {};
        // API returns { connectors: { slack: { connected: bool, ... } } }
        const conns = data.connectors || data;
        Object.entries(conns).forEach(([k, v]: [string, any]) => {
          if (v?.connected) apps[k] = true;
        });
        setConnectedApps(apps);
      }
    } catch { }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => {
    let t: NodeJS.Timeout;
    if (open) t = setInterval(fetchStatus, 15000); // Connector status rarely changes — 15s is enough
    return () => clearInterval(t);
  }, [open, fetchStatus]);

  const handleConnect = (id: string) => {
    if (id === 'slack') {
      const clientId = process.env.NEXT_PUBLIC_SLACK_CLIENT_ID || '10978886718263.11022632946720';
      const redirectUri = encodeURIComponent('http://localhost:3000/api/auth/callback/slack');
      const userScopes = encodeURIComponent('channels:read,channels:history,chat:write,users:read,files:write,reactions:write,im:read,im:write,im:history,groups:read,groups:history');
      const url = `https://slack.com/oauth/v2/authorize?client_id=${ clientId }&user_scope=${ userScopes }&redirect_uri=${ redirectUri }`;
      if ((window as any).electronAPI?.openExternal) {
        (window as any).electronAPI.openExternal(url);
      } else {
        window.open(url, 'slack_oauth', 'width=620,height=700');
      }
      return;
    }
    // Non-OAuth connectors are verified and persisted by the modal. Keep the
    // renderer state in sync after that API call succeeds.
    setConnectedApps(prev => ({ ...prev, [id]: true }));
  };

  const handleDisconnect = async (id: string) => {
    try {
      // Optimistic update immediately
      setConnectedApps(prev => ({ ...prev, [id]: false }));
      // API expects { platform } in JSON body
      await fetch('/api/connectors/status', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: id }),
      });
    } catch { }
  };

  return { open, setOpen, connectedApps, handleConnect, handleDisconnect, fetchStatus };
};


interface Attachment {
  id?: string;
  file: File;
  name?: string;
  preview: string;
  mimeType?: string;
  size?: number;
  uploadStatus?: 'uploading' | 'done' | 'error';
  fileUri?: string;
  localPath?: string;
}

interface TaskTrackerStep {
  id?: string;
  step: number;
  name: string;
  description?: string;
  status: 'pending' | 'blocked' | 'in_progress' | 'done' | 'skipped' | 'failed';
  tools?: string[];
  done_when?: string;
  step_type?: string;
  expected_output?: string;
  risk?: string;
  artifacts?: string[];
}

interface TaskTrackerState {
  goal?: string;
  phase?: 'generating' | 'generated' | 'progress' | 'complete' | 'failed';
  status?: 'generating' | 'in_progress' | 'completed' | 'failed' | 'stopped';
  complexity?: string;
  estimatedMinutes?: number;
  completedSteps?: number;
  totalSteps?: number;
  activeStepName?: string | null;
  steps?: TaskTrackerStep[];
}

interface QueuedFollowUpItem {
  id: string;
  chatId?: string;
  text: string;
  attachments?: QueuedMessageAttachment[];
  attachmentCount?: number;
  rendererOwned?: boolean;
  serverBacked?: boolean;
  deliveryState?: 'pending' | 'uncertain' | 'rejected';
}

interface ChatInputProps {
  showVoiceControls?: boolean;
  inputValue: string;
  inputValueRevision?: number;
  setInputValue: React.Dispatch<React.SetStateAction<string>>;
  onInputValueChange?: (value: string) => void;
  isThinking: boolean;
  canStop?: boolean;
  isRecording: boolean;
  dictationPhase?: DictationPhase;
  handleSend: () => void;
  handleStop: () => void | Promise<boolean>;
  handleSteer?: () => void;  // Send live steering to running agent
  toggleSpeech: () => void;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  greeting: string;
  traceLogsLength: number;
  agentMode?: MainAgentMode;
  onModeChange?: (mode: MainAgentMode) => void;
  thinkingLevel?: MainAgentThinkingLevel;
  onThinkingLevelChange?: (level: MainAgentThinkingLevel) => void;
  pinnedItems?: any[];
  setPinnedItems?: React.Dispatch<React.SetStateAction<any[]>>;
  // ═══ Gemini Live Session ═══
  liveState?: 'idle' | 'connecting' | 'connected' | 'listening' | 'thinking' | 'speaking' | 'error';
  hasBackgroundLiveSession?: boolean;
  onLiveStart?: () => void;
  onLiveSendText?: (text: string) => void;
  onLiveStop?: () => void;
  liveOutputText?: string;
  liveInputText?: string;
  liveError?: string | null;
  liveMicVolume?: number;
  liveModelVolume?: number | number[];
  liveActiveTool?: string | null;
  isMicMuted?: boolean;
  onToggleMicMute?: () => void;
  isSpeakerMuted?: boolean;
  onToggleSpeakerMute?: () => void;
  isCompressed?: boolean;
  showComposerControls?: boolean;
  executionContextLocked?: boolean;
  allowModelSelectionWhileThinking?: boolean;
  modelSelectionScope?: 'global' | 'surface';
  taskTracker?: TaskTrackerState | null;
  isNetworkPaused?: boolean;
  onNetworkPausedAction?: () => void;
  onOpenAgents?: () => void;
  onOpenProjects?: () => void;
  onOpenAgentBuilder?: (id: string) => void;
  onOpenPet?: () => void;
  buildingAgentId?: string | null;
  activeChatId?: string | null;
  selectedAgent?: string | null;
  selectedAgentName?: string;
  chatMode?: boolean;
  proxyEnabled?: boolean;
  onProxyToggle?: () => void | Promise<void>;
  composerPlaceholder?: string;
  onAgentChange?: (agentId: string | null, agentName: string, chatMode?: boolean) => void;
  workspacePath?: string | null;
  onWorkspacePathChange?: (path: string | null) => void;
  workspaceOwnerId?: string;
  runLocation?: RunLocation;
  onRunLocationChange?: (location: RunLocation) => void;
  chatModelSelection?: string;
  onModelSelectionChange?: (selection: string) => void;
  onOpenSettingsTab?: (tab: 'api' | 'models') => void;
  chatTitle?: string;
  chatUsage?: ReturnType<typeof summarizeChatUsage>;
  onCompact?: () => Promise<void>;
  compacting?: boolean;
  onPlanModeChange?: (enabled: boolean) => Promise<void>;
  onSwarmModeChange?: (enabled: boolean) => Promise<void>;
  contextUsage?: {
    usedTokens: number;
    contextWindow: number;
    contextLimitNote?: string;
    measurementNote?: string;
    utilizationPct: number;
    breakdown?: ContextUsageBreakdown;
    cacheStatus?: { label: string; detail: string };
    providerMetrics?: {
      cacheHitRatio?: number;
      cachedInputTokens?: number;
      uncachedInputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      cacheWriteTokens?: number;
    };
    aggregateSource?: 'provider' | 'provider_plus_live_estimate' | 'runtime_estimate';
    breakdownSource?: 'serialized_payload' | 'unavailable';
    providerInputTokens?: number;
    localEstimatedTokens?: number;
    draftTokens?: number;
    liveEstimateTokens?: number;
    providerName?: string;
    modelName?: string;
    updatedAt?: number;
    compaction?: {
      phase?: 'compacting' | 'retrying' | 'compacted' | 'failed';
      beforeTokens?: number;
      beforeTokensEstimated?: boolean;
      afterTokens?: number;
      modelProvider?: string;
      modelName?: string;
      failureTier?: number;
      nextAttemptTokens?: number;
      nextContextWindow?: number;
      summary?: string;
      timestamp?: number;
    };
    isEstimated?: boolean;
    awaitingSelectedModelMeasurement?: boolean;
  } | null;
  queuedFollowUps?: QueuedFollowUpItem[];
  chatMedia?: ChatMediaItem[];
  onSendQueuedFollowUp?: (item: QueuedFollowUpItem) => Promise<boolean> | boolean;
  onRemoveQueuedFollowUp?: (id: string, chatId?: string) => boolean | void | Promise<boolean>;
  showScrollBottom?: boolean;
  onScrollToBottom?: () => void;
}

type ComposerTextareaProps = Omit<
  React.ComponentProps<typeof motion.textarea>,
  'value' | 'defaultValue' | 'onChange'
> & {
  ownerKey: string;
  revision: number | string;
  value: string;
  onValueChange: (value: string, selectionStart: number | null) => void;
  onValueCommitted?: (textarea: HTMLTextAreaElement) => void;
};

// Keep the keystroke-owned state next to the native textarea. The surrounding
// composer contains menus, previews, model controls, and animated status UI;
// rebuilding all of it for every character makes the desktop renderer fall
// behind the native caret. External value changes still flow in immediately
// for chat switches, dictation, edits, Send clears, and failed-send restores.
const ComposerTextarea = React.memo(React.forwardRef<HTMLTextAreaElement, ComposerTextareaProps>(({
  ownerKey,
  revision,
  value,
  onValueChange,
  onValueCommitted,
  ...props
}, forwardedRef) => {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const elementRef = useRef<HTMLTextAreaElement | null>(null);
  const attachRef = useCallback((element: HTMLTextAreaElement | null) => {
    elementRef.current = element;
    if (typeof forwardedRef === 'function') forwardedRef(element);
    else if (forwardedRef) forwardedRef.current = element;
  }, [forwardedRef]);

  // Commit a chat switch or cleared draft before the parent measures the
  // native scrollHeight. A passive update could measure the previous chat's
  // long text and leave this empty composer stuck at its maximum height.
  React.useLayoutEffect(() => {
    if (draftRef.current === value) return;
    draftRef.current = value;
    setDraft(value);
  }, [ownerKey, revision]);

  // External updates first synchronize the local draft above. Measure only
  // after that draft reaches the DOM, including dictation and Send clears.
  React.useLayoutEffect(() => {
    if (elementRef.current && draft === draftRef.current) {
      onValueCommitted?.(elementRef.current);
    }
  }, [draft, ownerKey, revision, onValueCommitted]);

  return (
    <motion.textarea
      {...props}
      ref={attachRef}
      value={draft}
      onChange={(event) => {
        const nextValue = event.currentTarget.value;
        draftRef.current = nextValue;
        setDraft(nextValue);
        onValueChange(nextValue, event.currentTarget.selectionStart);
      }}
    />
  );
}));

ComposerTextarea.displayName = 'ComposerTextarea';

const formatContextTokenCount = (value: number) => {
  const safeValue = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  if (safeValue < 1_000) return safeValue.toLocaleString();
  if (safeValue >= 1_000_000) return `${(safeValue / 1_000_000).toFixed(safeValue >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  return `${(safeValue / 1_000).toFixed(safeValue >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
};

const readModelThinkingLevels = (): Record<string, MainAgentThinkingLevel> => {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(appStorage.getItem(MODEL_THINKING_LEVELS_STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const validLevels = new Set<MainAgentThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([key, value]) => Boolean(parseModelEntryKey(key)) && validLevels.has(value as MainAgentThinkingLevel))
        .map(([key, value]) => [key, value as MainAgentThinkingLevel] as const),
    );
  } catch {
    return {};
  }
};

const persistModelThinkingLevels = (levels: Record<string, MainAgentThinkingLevel>) => {
  try {
    appStorage.setItem(MODEL_THINKING_LEVELS_STORAGE_KEY, JSON.stringify(levels));
  } catch { }
};

const inferFileExtension = (mimeType: string) => {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
  };
  return map[mimeType] || 'file';
};

const getAttachmentName = (file: File) => {
  const existing = file.name?.trim();
  if (existing) return existing;
  const ext = inferFileExtension(file.type || '');
  return `${ file.type?.startsWith('image/') ? 'pasted-image' : 'pasted-file' }-${ Date.now() }.${ ext }`;
};

const clipboardDataUrlToFile = async (dataUrl: string, fileName: string): Promise<File | null> => {
  try {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    if (!blob.size) return null;
    return new File([blob], fileName, {
      type: blob.type || 'image/png',
      lastModified: Date.now(),
    });
  } catch {
    return null;
  }
};

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const getAttachmentMimeType = (fileName: string, suppliedMimeType?: string) => {
  const mimeType = String(suppliedMimeType || '').trim().toLowerCase();
  if (mimeType && mimeType !== 'application/octet-stream' && mimeType !== 'binary/octet-stream') {
    return mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;
  }
  const extension = `.${ String(fileName || '').split('.').pop()?.toLowerCase() || '' }`;
  return MIME_BY_EXTENSION[extension] || mimeType || 'application/octet-stream';
};

const formatAttachmentSize = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${ Math.max(1, Math.round(bytes / 1024)) } KB`;
  return `${ (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) } MB`;
};

const isComposerEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('textarea, input, [contenteditable="true"], [contenteditable=""], .monaco-editor, .cm-editor'));
};

const buildLocalFilePreviewUrl = (filePath?: string) => {
  return buildFilePreviewUrl(filePath);
};

const revokeObjectPreview = (preview?: string) => {
  if (preview?.startsWith('blob:')) {
    try { URL.revokeObjectURL(preview); } catch { }
  }
};

const getCenteredPopoutOffset = (rect: DOMRect, menuWidth: number, margin = 16) => {
  const desiredLeft = rect.left + rect.width / 2 - menuWidth / 2;
  const maxLeft = Math.max(margin, window.innerWidth - margin - menuWidth);
  const clampedLeft = Math.min(Math.max(desiredLeft, margin), maxLeft);
  return Math.round(clampedLeft - desiredLeft);
};

const DocumentPreviewIframe = React.memo(({ src }: { src: string }) => {
  return (
    <iframe
      src={src}
      className="w-full h-full border-none bg-white rounded-b-[16px]"
      title="Document Preview"
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  );
});
DocumentPreviewIframe.displayName = 'DocumentPreviewIframe';

const inputControlButton = "eterx-control-button w-[38px] h-[38px] shrink-0 flex items-center justify-center rounded-full border border-white/[0.07] bg-[#2D2D2D] text-white shadow-none transition-[background-color,border-color,box-shadow,color] duration-120 ease-out active:bg-[#2F2F2F] active:shadow-none hover:text-white hover:bg-[#333333] hover:border-white/[0.10] hover:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/15 group relative overflow-hidden";
const inputControlSheen = "hidden";

type SlashTrigger = {
  start: number;
  end: number;
  query: string;
};

type SlashCommand = {
  id: string;
  label: string;
  description: string;
  prompt: string;
  iconSrc: string;
  action?: 'agents' | 'goal' | 'plan' | 'swarm' | 'pet' | 'compact' | 'usage' | 'workspace';
};

type SlashPanel = 'agents' | 'goal' | 'usage' | 'workspace' | null;
type StatusRailMenu = 'project' | 'run' | 'branch' | null;

type SavedAgentSummary = {
  id: string;
  name: string;
  description?: string;
  accessType?: string;
  isSetup?: boolean;
  kind?: 'agent' | 'flow';
  stepCount?: number;
};

type AvailableAgentSummary = {
  agentId: string;
  name: string;
  status: string;
  mission?: string;
  presentation?: {
    description?: string;
    category?: string;
    accentColor?: string;
    starterPrompts?: string[];
  };
};

const CHAT_GOALS_STORAGE_KEY = 'eterx_chat_goals';
const NEW_CHAT_GOAL_KEY = 'new-chat';

const getGoalStorageKey = (chatId?: string | null) => chatId || NEW_CHAT_GOAL_KEY;

const loadStoredAgents = async (): Promise<SavedAgentSummary[]> => {
  try {
    const response = await fetch('/api/agents/list', { cache: 'no-store' });
    if (!response.ok) return [];
    const payload = await response.json();
    return (Array.isArray(payload?.agents) ? payload.agents : [])
      .filter((agent: any) => !!agent?.agentId && !!agent?.name)
      .map((agent: any) => ({
        id: String(agent.agentId),
        name: String(agent.name),
        description: agent.presentation?.description
          ? String(agent.presentation.description)
          : agent.mission ? String(agent.mission) : '',
        accessType: agent.accessType ? String(agent.accessType) : '',
        isSetup: agent.status === 'ready',
        kind: agent.kind === 'flow' ? 'flow' : 'agent',
        stepCount: Number(agent.stepCount || 0),
      }));
  } catch {
    return [];
  }
};

const readStoredGoal = (chatId?: string | null) => {
  if (typeof window === 'undefined') return '';
  try {
    const saved = appStorage.getItem(CHAT_GOALS_STORAGE_KEY);
    if (!saved) return '';
    const parsed = JSON.parse(saved);
    const value = parsed?.[getGoalStorageKey(chatId)];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
};

const writeStoredGoal = (chatId: string | null | undefined, goal: string) => {
  if (typeof window === 'undefined') return;
  try {
    const saved = appStorage.getItem(CHAT_GOALS_STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : {};
    const key = getGoalStorageKey(chatId);
    if (goal.trim()) {
      parsed[key] = goal.trim();
    } else {
      delete parsed[key];
    }
    appStorage.setItem(CHAT_GOALS_STORAGE_KEY, JSON.stringify(parsed));
  } catch { }
};

const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'compact', label: 'Compact', description: "Compact this chat’s context", prompt: '', iconSrc: '', action: 'compact' },
  { id: 'plan-mode', label: 'Plan mode', description: 'Require a plan for each request', prompt: '', iconSrc: '/icons/agent-ui/commands/plan-mode.svg', action: 'plan' },
  { id: 'swarm-mode', label: 'Swarm Mode', description: 'Coordinate a team around the work', prompt: '', iconSrc: '', action: 'swarm' },
  { id: 'chat-usage', label: 'Chat usage', description: 'View tokens, cache hits, and current context', prompt: '', iconSrc: '', action: 'usage' },
  { id: 'workspace', label: 'Workspace', description: 'View or change this chat’s workspace', prompt: '', iconSrc: '', action: 'workspace' },
];

const PinFolderIcon = React.memo(({ className = "" }: { className?: string }) => (
  <svg viewBox="0 0 36 36" className={className} fill="none" aria-hidden="true">
    <path
      d="M7.05 15.05c0-2.33 1.89-4.22 4.22-4.22h4.86c.86 0 1.7.29 2.38.82l1.1.86c.56.44 1.25.68 1.96.68h3.28c2.28 0 4.12 1.84 4.12 4.12v7.2c0 2.33-1.89 4.22-4.22 4.22H11.27c-2.33 0-4.22-1.89-4.22-4.22v-9.46Z"
      fill="url(#pin-folder-fill)"
      stroke="currentColor"
      strokeWidth="1.95"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M8.35 15.95h19.3"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeOpacity="0.88"
    />
    <path
      d="M10.25 12.78h5.9c.62 0 1.23.2 1.72.58l1.28.99"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeOpacity="0.55"
    />
    <path
      d="M9.55 18.65v5.2c0 1.34 1.09 2.43 2.43 2.43h12.42"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeOpacity="0.26"
    />
    <path
      d="M24.2 17.7c1.04 0 1.88.84 1.88 1.88v3.58"
      stroke="currentColor"
      strokeWidth="1.15"
      strokeLinecap="round"
      strokeOpacity="0.18"
    />
    <defs>
      <linearGradient id="pin-folder-fill" x1="18" y1="9.8" x2="18" y2="28.8" gradientUnits="userSpaceOnUse">
        <stop stopColor="currentColor" stopOpacity="0.08" />
        <stop offset="1" stopColor="currentColor" stopOpacity="0.025" />
      </linearGradient>
    </defs>
  </svg>
));

const PinFileIcon = React.memo(({ className = "" }: { className?: string }) => (
  <svg viewBox="0 0 36 36" className={className} fill="none" aria-hidden="true">
    <path
      d="M12.45 6.45h7.82c.78 0 1.53.31 2.08.87l4.03 4.07c.54.55.84 1.29.84 2.06v13.88a2.42 2.42 0 0 1-2.42 2.42H12.45a2.42 2.42 0 0 1-2.42-2.42V8.87a2.42 2.42 0 0 1 2.42-2.42Z"
      fill="url(#pin-file-fill)"
      stroke="currentColor"
      strokeWidth="1.95"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M20.82 7.02v4.15c0 1.15.93 2.08 2.08 2.08h3.88"
      fill="#0F0F0F"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M14.35 17.65h7.3M14.35 21.35h5.55"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeOpacity="0.9"
    />
    <path
      d="M12.9 9.65v16.12c0 .8.65 1.45 1.45 1.45h9.26"
      stroke="currentColor"
      strokeWidth="1.18"
      strokeLinecap="round"
      strokeOpacity="0.28"
    />
    <path
      d="M14.35 13.95h3.05"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeOpacity="0.58"
    />
    <path
      d="M24.52 15.7v9.18"
      stroke="currentColor"
      strokeWidth="1.05"
      strokeLinecap="round"
      strokeOpacity="0.18"
    />
    <defs>
      <linearGradient id="pin-file-fill" x1="19.2" y1="6.35" x2="19.2" y2="29.65" gradientUnits="userSpaceOnUse">
        <stop stopColor="currentColor" stopOpacity="0.07" />
        <stop offset="1" stopColor="currentColor" stopOpacity="0.02" />
      </linearGradient>
    </defs>
  </svg>
));

const ProgressLoader = React.memo(({ className = 'h-4 w-4' }: { className?: string }) => (
  <span className={`eterx-task-progress-loader relative flex shrink-0 items-center justify-center ${ className }`} aria-hidden="true">
    <span className="absolute inset-0 rounded-full border-[2px] border-white/[0.16]" />
    <span className="absolute inset-0 rounded-full border-[2px] border-transparent border-r-white/45 border-t-white/90 animate-[spin_1.15s_linear_infinite] shadow-none" />
  </span>
));

const TaskStatusGlyph = React.memo(({ status, active }: { status?: string; active?: boolean }) => {
  if (status === 'done') {
    return (
      <motion.span
        key="done"
        initial={{ opacity: 0, scale: 0.82 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
        className="eterx-task-status-glyph flex h-4 w-4 items-center justify-center rounded-full bg-[#A9A9A9] text-[#1F1F1F] shadow-none"
        data-status="done"
      >
        <Check className="h-[11px] w-[11px]" strokeWidth={3.2} />
      </motion.span>
    );
  }

  if (status === 'skipped') {
    return (
      <span className="eterx-task-status-glyph flex h-4 w-4 items-center justify-center rounded-full border border-white/25 text-white/45" data-status="skipped">
        <CircleSlash className="h-[11px] w-[11px]" strokeWidth={2.2} />
      </span>
    );
  }

  if (status === 'failed') {
    return (
      <span className="eterx-task-status-glyph flex h-4 w-4 items-center justify-center rounded-full border border-red-400/45 text-red-300/85" data-status="failed">
        <X className="h-[11px] w-[11px]" strokeWidth={2.5} />
      </span>
    );
  }

  if (active || status === 'in_progress') {
    return <ProgressLoader />;
  }

  return <span className="eterx-task-status-glyph block h-4 w-4 rounded-full border-[2px] border-[#A9A9A9]/62" data-status="pending" />;
});

const GeneratingDots = React.memo(({ className = '' }: { className?: string }) => (
  <span className={`inline-flex w-[18px] items-center gap-[2px] pl-0.5 align-middle ${ className }`}>
    {[0, 1, 2].map(index => (
      <span
        key={index}
        className="h-[3px] w-[3px] rounded-full bg-current opacity-30 animate-[eterx-task-dot_2.4s_ease-in-out_infinite]"
        style={{ animationDelay: `${ index * 0.28 }s` }}
      />
    ))}
  </span>
));


const TaskTrackerDock = React.memo(({
  tracker,
  isThinking,
  isCompressed,
}: {
  tracker?: TaskTrackerState | null;
  isThinking: boolean;
  isCompressed: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const steps = tracker?.steps || [];
  const hasTracker = steps.length > 0;
  const generating = tracker?.phase === 'generating' || tracker?.status === 'generating';
  const completed = tracker?.completedSteps ?? steps.filter(step => step.status === 'done').length;
  const total = tracker?.totalSteps ?? steps.length;
  const activeStep = steps.find(step => step.status === 'in_progress') || steps.find(step => step.status === 'pending') || null;
  const isComplete = tracker?.status === 'completed' || (total > 0 && completed >= total);
  const currentStepName = (tracker?.activeStepName || activeStep?.name || '').trim();
  const liveHeader = !open && !isComplete && (generating || isThinking);
  const headerTitle = open ? 'Progress' : liveHeader ? (currentStepName || (generating ? 'Generating progress' : 'Working')) : 'Progress';

  useEffect(() => {
    if (!hasTracker) return;
    if (generating || tracker?.phase === 'generated') setOpen(true);
  }, [generating, hasTracker, tracker?.phase, total]);

  if (!hasTracker) return null;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10, scale: 0.992 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.992 }}
      transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
      className="eterx-task-tracker-dock relative z-0 mx-auto w-full overflow-hidden rounded-t-[20px] border border-b-0 border-white/[0.09] bg-[#202020] shadow-none"
    >
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className="eterx-task-tracker-header group flex min-h-[38px] w-full items-center gap-2 px-3.5 py-1.5 text-left transition-colors hover:bg-white/[0.025]"
        aria-expanded={open}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {liveHeader ? (
            <ProgressLoader className="h-[15px] w-[15px]" />
          ) : (
            <ListTodo className="h-[14px] w-[14px] shrink-0 text-[#F2EFEA]/82" strokeWidth={2.25} />
          )}
          <span className="flex min-w-0 items-center">
            <Shimmer active={liveHeader} className="truncate text-[12.5px] font-semibold leading-5 tracking-normal text-[#F4F1EA]">
              {headerTitle}
            </Shimmer>
            {liveHeader && <GeneratingDots className="shrink-0 text-[#D7D7D7]" />}
          </span>
        </span>

        <ChevronDown className={`h-4 w-4 shrink-0 text-white/45 transition-transform duration-200 group-hover:text-white/70 ${ open ? 'rotate-180' : '' }`} strokeWidth={2.1} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="eterx-task-tracker-body px-2.5 pb-2.5 pt-0.5">
              <div className="relative">
                  <div className="eterx-task-tracker-list relative max-h-[176px] space-y-0.5 overflow-y-auto py-1 pr-1 eterx-scrollbar">
                    {steps.map((step) => {
                      const active = step === activeStep;
                      const activeWorking = active && !isComplete && (isThinking || step.status === 'in_progress');
                      return (
                        <div
                          key={step.id || step.step}
                          data-status={step.status}
                          data-active={activeWorking ? 'true' : undefined}
                          title={step.name || `Task ${ step.step }`}
                          className="eterx-task-tracker-step relative flex items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 transition-colors hover:bg-white/[0.018]"
                        >
                          <span className="relative z-10 shrink-0">
                            <TaskStatusGlyph status={step.status} active={activeWorking} />
                          </span>
                          <span className="flex min-w-0 flex-1 items-center gap-1.5">
                            <Shimmer active={activeWorking} className="block min-w-0 truncate text-[12.5px] font-semibold leading-5 text-[#D9D6CE]">
                              {step.name || `Task ${ step.step }`}
                            </Shimmer>
                            {activeWorking && <GeneratingDots className="shrink-0 text-[#CFCFCF]" />}
                          </span>
                        </div>
                      );
                    })}
                  </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
})

export const ChatInput: React.FC<ChatInputProps> = ({
  showVoiceControls = true,
  inputValue, inputValueRevision = 0, setInputValue, onInputValueChange, isThinking, canStop = false, isRecording, dictationPhase = isRecording ? 'listening' : 'idle', handleSend, handleStop, handleSteer = () => { },
  toggleSpeech, attachments, setAttachments, greeting, traceLogsLength,
  agentMode = 'think', onModeChange = () => { },
  thinkingLevel = 'low', onThinkingLevelChange = () => { },
  pinnedItems = [], setPinnedItems = () => { },
  liveState = 'idle', hasBackgroundLiveSession = false, onLiveStart = () => { }, onLiveStop = () => { },
  liveOutputText = '', liveInputText = '',
  liveMicVolume = 0, liveModelVolume = 0, liveActiveTool = null,
  isMicMuted = false, onToggleMicMute = () => { },
  isSpeakerMuted = false, onToggleSpeakerMute = () => { },
  onLiveSendText,
  isCompressed = false,
  showComposerControls = true,
  executionContextLocked = false,
  allowModelSelectionWhileThinking = false,
  modelSelectionScope = 'global',
  taskTracker = null,
  isNetworkPaused = false,
  onNetworkPausedAction = () => { },
  onOpenAgents = () => { },
  onOpenProjects = () => { },
  onOpenAgentBuilder = () => { },
  onOpenPet = () => { },
  buildingAgentId = null,
  activeChatId = null,
  selectedAgent = null,
  selectedAgentName = 'General',
  chatMode = false,
  proxyEnabled = false,
  onProxyToggle = () => { },
  composerPlaceholder,
  onAgentChange,
  workspacePath,
  workspaceOwnerId,
  onWorkspacePathChange,
  runLocation: propRunLocation,
  onRunLocationChange,
  chatModelSelection: propChatModelSelection,
  onModelSelectionChange,
  onOpenSettingsTab,
  chatTitle = 'New chat',
  chatUsage,
  onCompact,
  compacting = false,
  onPlanModeChange,
  onSwarmModeChange,
  contextUsage = null,
  queuedFollowUps = [],
  chatMedia = [],
  onSendQueuedFollowUp,
  onRemoveQueuedFollowUp,
  showScrollBottom = false,
  onScrollToBottom = () => { },
}) => {
  const isAgentBuilder = Boolean(buildingAgentId || activeChatId?.startsWith('agent_builder_') || activeChatId?.includes('agent_builder'));
  const isLiveActive = liveState !== 'idle' && liveState !== 'error';
  const hasAnyLiveSession = isLiveActive || hasBackgroundLiveSession;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const latestInputValueRef = useRef(inputValue);
  const goalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaWidthRef = useRef(0);
  const textareaResizeFrameRef = useRef<number | null>(null);
  const slashDragFrameRef = useRef<number | null>(null);
  const modelSelectorRef = useRef<HTMLDivElement>(null);
  const modelListRef = useRef<HTMLDivElement>(null);
  const initialFocusAppliedRef = useRef(false);
  // Attachment preparation may outlive a chat switch. Scope the deferred send
  // to the composer that requested it instead of letting it fire in whichever
  // chat happens to be visible later.
  const queuedSendRef = useRef<string | null>(null);
  const [showPinMenu, setShowPinMenu] = useState(false);
  const [openPillDrop, setOpenPillDrop] = useState<'files' | 'folders' | null>(null);
  const [hasPromptText, setHasPromptText] = useState(Boolean(inputValue.trim()));
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isAtTop, setIsAtTop] = useState(true);
  const [isAtBottom, setIsAtBottom] = useState(false);
  const [isLogoHovered, setIsLogoHovered] = useState(false);
  const [stoppingChatIds, setStoppingChatIds] = useState<Set<string>>(new Set());
  const stopRequestsRef = useRef<Map<string, Promise<void>>>(new Map());
  const activeComposerChatKey = activeChatId || 'new_chat';
  const isStopping = stoppingChatIds.has(activeComposerChatKey);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [thinkingMenuModelKey, setThinkingMenuModelKey] = useState<string | null>(null);
  const [thinkingMenuPosition, setThinkingMenuPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const thinkingMenuAnchorRef = useRef<HTMLElement | null>(null);
  const thinkingMenuPortalRef = useRef<HTMLDivElement | null>(null);
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [codingDetails, setCodingDetails] = useState<CodingAgentId | null>(null);
  const [showContextUsagePanel, setShowContextUsagePanel] = useState(false);
  const [openStatusMenu, setOpenStatusMenu] = useState<StatusRailMenu>(null);
  const [projectSearch, setProjectSearch] = useState('');
  const [agentMenuXOffset, setAgentMenuXOffset] = useState(0);
  const [agentMenuMaxHeight, setAgentMenuMaxHeight] = useState(380);
  const [modelMenuXOffset, setModelMenuXOffset] = useState(0);
  const [availableAgents, setAvailableAgents] = useState<AvailableAgentSummary[]>([]);
  const agentSelectorRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerShellRef = useRef<HTMLDivElement>(null);
  const contextUsagePanelRef = useRef<HTMLElement>(null);
  const contextUsageTriggerRef = useRef<HTMLButtonElement>(null);
  const [sendingQueuedFollowUpIds, setSendingQueuedFollowUpIds] = useState<Set<string>>(new Set());
  const queueActionsRef = useRef<Set<string>>(new Set());
  const beginQueueAction = (key: string) => {
    if (queueActionsRef.current.has(key)) return false;
    queueActionsRef.current.add(key);
    setSendingQueuedFollowUpIds(new Set(queueActionsRef.current));
    return true;
  };
  const finishQueueAction = (key: string) => {
    queueActionsRef.current.delete(key);
    setSendingQueuedFollowUpIds(new Set(queueActionsRef.current));
  };
  const [showThinkingLevels, setShowThinkingLevels] = useState(false);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, MainAgentThinkingLevel>>(readModelThinkingLevels);
  const thinkingTimeoutRef = useRef<any>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [previewImages, setPreviewImages] = useState<string[]>([]);
  const [failedPreviewImage, setFailedPreviewImage] = useState<string | null>(null);
  const navigatePreviewImage = (direction: number) => {
    const index = previewImages.indexOf(previewImage || '');
    const next = index + direction;
    if (next < 0 || next >= previewImages.length) return;
    setPreviewImage(previewImages[next]);
    setFailedPreviewImage(null);
    setZoomScale(1);
    setPanPos({ x: 0, y: 0 });
    setIsDragging(false);
  };
  const [previewVideo, setPreviewVideo] = useState<{ url: string; name?: string } | null>(null);
  const [zoomScale, setZoomScale] = useState(1);
  const [panPos, setPanPos] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [copiedImage, setCopiedImage] = useState(false);

  const handleZoomIn = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setZoomScale(s => Math.min(parseFloat((s + 0.25).toFixed(2)), 5));
  };
  const handleZoomOut = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setZoomScale(s => {
      const next = Math.max(parseFloat((s - 0.25).toFixed(2)), 0.25);
      if (next <= 1) setPanPos({ x: 0, y: 0 });
      return next;
    });
  };
  const handleResetZoom = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setZoomScale(1);
    setPanPos({ x: 0, y: 0 });
  };
  const handleToggleZoom = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (zoomScale === 1) {
      setZoomScale(2);
    } else {
      setZoomScale(1);
      setPanPos({ x: 0, y: 0 });
    }
  };
  const handleDownloadImage = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!previewImage) return;
    const link = document.createElement('a');
    link.href = previewImage;
    link.download = `eterx-image-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  const handleCopyImage = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!previewImage) return;
    try {
      if (previewImage.startsWith('data:image')) {
        const res = await fetch(previewImage);
        const blob = await res.blob();
        if (!blob.type.startsWith('image/') || !await safeCopyPngToClipboard(blob)) return;
      } else {
        if (!await safeCopyTextToClipboard(previewImage)) return;
      }
      setCopiedImage(true);
      setTimeout(() => setCopiedImage(false), 2000);
    } catch {
      setCopiedImage(false);
    }
  };

  useEffect(() => {
    setPreviewImage(null);
    setPreviewImages([]);
    setPreviewVideo(null);
    setZoomScale(1);
    setPanPos({ x: 0, y: 0 });
    setIsDragging(false);
  }, [activeComposerChatKey]);

  // Buffered callers publish explicit revisions; controlled callers publish
  // the value itself (including clears, dictation, and failed-send restores).
  const composerDraftRevision = onInputValueChange ? inputValueRevision : inputValue;
  React.useLayoutEffect(() => {
    latestInputValueRef.current = inputValue;
    const nextHasPromptText = Boolean(inputValue.trim());
    setHasPromptText(previous => previous === nextHasPromptText ? previous : nextHasPromptText);
  }, [activeComposerChatKey, composerDraftRevision]);

  const [previewDocPath, setPreviewDocPath] = useState<string | null>(null);
  const [isConvertingDoc, setIsConvertingDoc] = useState(false);
  const [convertedPdfPath, setConvertedPdfPath] = useState<string | null>(null);
  const [conversionError, setConversionError] = useState(false);
  const [composerNotice, setComposerNotice] = useState<{ title: string; message: string } | null>(null);
  const [composerNoticeTarget, setComposerNoticeTarget] = useState<Element | null>(null);
  const composerNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showComposerNotice = useCallback((title: string, message: string) => {
    if (composerNoticeTimerRef.current) clearTimeout(composerNoticeTimerRef.current);
    setComposerNoticeTarget(textareaRef.current?.closest('.eterx-chat-column')?.querySelector('.eterx-conversation-pane')
      || textareaRef.current?.closest('.eterx-conversation-pane') || null);
    setComposerNotice({ title, message });
    composerNoticeTimerRef.current = setTimeout(() => {
      setComposerNotice(null);
      composerNoticeTimerRef.current = null;
    }, 5200);
  }, []);

  useEffect(() => () => {
    if (composerNoticeTimerRef.current) clearTimeout(composerNoticeTimerRef.current);
  }, []);

  useEffect(() => {
    const handlePreviewDoc = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || !detail.filePath) return;

      const filePath = detail.filePath;
      setPreviewDocPath(filePath);
      setConvertedPdfPath(null);
      setConversionError(false);

      const ext = filePath.split('.').pop()?.toLowerCase();
      if (ext === 'docx') {
        setIsConvertingDoc(true);
        try {
          const pdfPath = await (window as any).electronAPI.convertDocxToPdf(filePath);
          if (pdfPath) {
            setConvertedPdfPath(pdfPath);
          } else {
            setConversionError(true);
          }
        } catch (err) {
          console.error('Failed to convert docx:', err);
          setConversionError(true);
        } finally {
          setIsConvertingDoc(false);
        }
      }
    };

    const handlePreviewImage = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || !detail.previewUrl) return;
      setPreviewImages(Array.from(new Set<string>([...(Array.isArray(detail.images) ? detail.images.filter((url: unknown): url is string => typeof url === 'string' && Boolean(url)) : []), detail.previewUrl])));
      setFailedPreviewImage(null);
      setZoomScale(1);
      setPanPos({ x: 0, y: 0 });
      setPreviewImage(detail.previewUrl);
    };

    const handlePreviewMedia = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.previewUrl || detail.kind !== 'video') return;
      setPreviewVideo({ url: detail.previewUrl, name: detail.fileName });
    };

    window.addEventListener('eterx-preview-document', handlePreviewDoc);
    window.addEventListener('eterx-preview-image', handlePreviewImage);
    window.addEventListener('eterx-preview-media', handlePreviewMedia);
    return () => {
      window.removeEventListener('eterx-preview-document', handlePreviewDoc);
      window.removeEventListener('eterx-preview-image', handlePreviewImage);
      window.removeEventListener('eterx-preview-media', handlePreviewMedia);
    };
  }, []);

  const handleThinkingMouseEnter = () => {
    if (thinkingTimeoutRef.current) {
      clearTimeout(thinkingTimeoutRef.current);
      thinkingTimeoutRef.current = null;
    }
    setShowThinkingLevels(true);
  };

  const handleThinkingMouseLeave = () => {
    if (thinkingTimeoutRef.current) {
      clearTimeout(thinkingTimeoutRef.current);
    }
    thinkingTimeoutRef.current = setTimeout(() => {
      setShowThinkingLevels(false);
    }, 200);
  };

  const updateThinkingMenuPosition = useCallback((anchor: HTMLElement, optionCount: number) => {
    if (typeof window === 'undefined') return;
    const margin = 12;
    const gap = 8;
    const bounds = anchor.closest('.eterx-conversation-pane')?.getBoundingClientRect();
    const leftEdge = Math.max(margin, (bounds?.left ?? 0) + margin);
    const rightEdge = Math.min(window.innerWidth - margin, (bounds?.right ?? window.innerWidth) - margin);
    const topEdge = Math.max(margin, (bounds?.top ?? 0) + margin);
    const bottomEdge = Math.min(window.innerHeight - margin, (bounds?.bottom ?? window.innerHeight) - margin);
    const menuWidth = Math.max(0, Math.min(168, rightEdge - leftEdge));
    const menuHeight = Math.max(0, Math.min(optionCount * 34 + 10, bottomEdge - topEdge));
    const rect = anchor.getBoundingClientRect();
    const canOpenRight = rect.right + gap + menuWidth <= rightEdge;
    const left = canOpenRight
      ? rect.right + gap
      : Math.max(leftEdge, Math.min(rect.left - gap - menuWidth, rightEdge - menuWidth));
    const top = Math.max(
      topEdge,
      Math.min(rect.bottom - menuHeight, bottomEdge - menuHeight),
    );
    setThinkingMenuPosition({ top, left, width: menuWidth, maxHeight: menuHeight });
  }, []);

  const openThinkingMenuForRow = (optionKey: string, anchor: HTMLElement, optionCount: number) => {
    thinkingMenuAnchorRef.current = anchor;
    updateThinkingMenuPosition(anchor, optionCount);
    setThinkingMenuModelKey(optionKey);
    handleThinkingMouseEnter();
  };
  const [slashTrigger, setSlashTrigger] = useState<SlashTrigger | null>(null);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashPanel, setSlashPanel] = useState<SlashPanel>(null);
  const [storedAgents, setStoredAgents] = useState<SavedAgentSummary[]>([]);
  const [goalDraft, setGoalDraft] = useState('');
  const [slashPanelOffset, setSlashPanelOffset] = useState({ x: 0, y: 0 });
  const [planModeActive, setPlanModeState] = useState(false);
  const [swarmModeActive, setSwarmModeState] = useState(false);
  const [pendingModes, setPendingModes] = useState<Set<string>>(() => new Set());
  const modeRequestsRef = useRef(new Set<string>());
  const modeChatRef = useRef(activeChatId);
  modeChatRef.current = activeChatId;
  const setComposerMode = useCallback((kind: 'plan' | 'swarm', enabled: boolean) => {
    const chatId = activeChatId;
    const key = `${chatId || 'new_chat'}:${kind}`;
    if (modeRequestsRef.current.has(key)) return;
    const read = kind === 'plan' ? readChatPlanMode : readChatSwarmMode;
    const write = kind === 'plan' ? writeChatPlanMode : writeChatSwarmMode;
    const setState = kind === 'plan' ? setPlanModeState : setSwarmModeState;
    const update = kind === 'plan' ? onPlanModeChange : onSwarmModeChange;
    const previous = read(chatId);
    write(chatId, enabled);
    setState(enabled);
    modeRequestsRef.current.add(key);
    setPendingModes(new Set(modeRequestsRef.current));
    void Promise.resolve().then(() => update?.(enabled)).catch(error => {
      write(chatId, previous);
      if (modeChatRef.current === chatId) {
        setState(previous);
        showComposerNotice(`Could not update ${kind === 'plan' ? 'Plan' : 'Swarm'} mode`, error instanceof Error ? error.message : 'Please try again.');
      }
    }).finally(() => {
      modeRequestsRef.current.delete(key);
      setPendingModes(new Set(modeRequestsRef.current));
    });
  }, [activeChatId, onPlanModeChange, onSwarmModeChange, showComposerNotice]);
  const setPlanModeActive = useCallback((enabled: boolean) => setComposerMode('plan', enabled), [setComposerMode]);
  const setSwarmModeActive = useCallback((enabled: boolean) => setComposerMode('swarm', enabled), [setComposerMode]);
  useEffect(() => {
    const restoreModes = () => {
      setPlanModeState(readChatPlanMode(activeChatId));
      setSwarmModeState(readChatSwarmMode(activeChatId));
    };
    restoreModes();
    window.addEventListener(FOLDER_STORAGE_READY_EVENT, restoreModes);
    setSlashPanel(null);
    setSlashTrigger(null);
    return () => window.removeEventListener(FOLDER_STORAGE_READY_EVENT, restoreModes);
  }, [activeChatId]);
  const [storedModelSettings, setStoredModelSettings] = useState<StoredModelSettings>(() => ({
    apiKeys: {},
    modelOverrides: {},
    modelCatalog: {},
    modelEntries: [],
    modelApiKeys: {},
    thinkingCapabilities: {},
    chatModelSelection: AUTO_MODEL_SELECTION,
  }));
  const activeConfiguredChatModel = useMemo(() => {
    const selection = propChatModelSelection !== undefined
      ? propChatModelSelection
      : storedModelSettings.chatModelSelection;
    const entry = parseModelEntryKey(selection);
    if (!entry) return null;
    const exists = storedModelSettings.modelEntries.some(candidate =>
      modelEntryKey(candidate.provider, candidate.modelId) === selection
    );
    const hasCredential = isLocalModelProvider(entry.provider)
      || Boolean(storedModelSettings.apiKeys[entry.provider])
      || Boolean(storedModelSettings.modelApiKeys[selection]);
    return exists && hasCredential ? entry : null;
  }, [propChatModelSelection, storedModelSettings.apiKeys, storedModelSettings.chatModelSelection, storedModelSettings.modelApiKeys, storedModelSettings.modelEntries]);
  const connectors = useConnectors();
  const [localRunLocation, setLocalRunLocation] = useState<RunLocation>('local');
  const runLocation = propRunLocation !== undefined ? propRunLocation : localRunLocation;
  const handleRunLocationChange = useCallback((location: RunLocation) => {
    if (onRunLocationChange) {
      onRunLocationChange(location);
    } else {
      setLocalRunLocation(location);
    }
    setOpenStatusMenu(null);
  }, [onRunLocationChange]);

  const [localWorkspacePath, setLocalWorkspacePath] = useState<string | null>(null);
  const activeWorkspacePath = workspacePath !== undefined ? workspacePath : localWorkspacePath;
  const handleWorkspacePathChange = useCallback((path: string | null) => {
    handleRunLocationChange('local');
    if (onWorkspacePathChange) {
      onWorkspacePathChange(path);
    } else {
      setLocalWorkspacePath(path);
    }
  }, [onWorkspacePathChange, handleRunLocationChange]);

  const managedWorkspace = useManagedWorkspace(workspaceOwnerId || activeChatId || 'terminal-draft-initial', activeWorkspacePath || null, (location, path) => {
    if (onWorkspacePathChange) onWorkspacePathChange(path);
    else setLocalWorkspacePath(path);
    handleRunLocationChange(location);
  });
  const runLocationLabel = runLocation === 'worktree' ? 'Worktree' : runLocation === 'sandbox' ? 'Scratch workspace' : 'Work locally';
  useEffect(() => {
    if (managedWorkspace.error) setOpenStatusMenu('run');
  }, [managedWorkspace.error]);

  const workspaceName = useMemo(() => {
    if (!activeWorkspacePath) return "Chat workspace";
    if (managedWorkspace.workspace) return managedWorkspace.workspace.kind === 'sandbox' ? 'Scratch workspace' : `${managedWorkspace.workspace.sourcePath?.split(/[/\\]/).filter(Boolean).pop() || 'Project'} worktree`;
    return activeWorkspacePath.split(/[/\\]/).filter(Boolean).pop() || activeWorkspacePath;
  }, [activeWorkspacePath, managedWorkspace.workspace]);

  const [recentProjects, setRecentProjects] = useState<Array<{ path: string; name: string }>>([]);
  useEffect(() => {
    if (openStatusMenu === 'project' && typeof window !== 'undefined') {
      try {
      const saved = appStorage.getItem('eterx_recent_projects');
        const parsed = saved ? JSON.parse(saved) : [];
        if (Array.isArray(parsed)) {
          setRecentProjects(parsed.filter((project): project is { path: string; name: string } =>
            project && typeof project.path === 'string' && project.path.trim().length > 0
            && typeof project.name === 'string'
          ));
        }
      } catch { }
    }
  }, [openStatusMenu]);

  const filteredRecentProjects = useMemo(() => {
    const query = projectSearch.trim().toLowerCase();
    const projects = activeWorkspacePath
      ? [{ path: activeWorkspacePath, name: workspaceName }, ...recentProjects.filter(project => project.path !== activeWorkspacePath)]
      : recentProjects;
    const uniqueProjects = projects.filter((project, index) => projects.findIndex(item => item.path === project.path) === index);
    if (!query) return uniqueProjects;
    return uniqueProjects.filter(p => p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query));
  }, [recentProjects, projectSearch, activeWorkspacePath, workspaceName]);

  const looksLikePath = useMemo(() => {
    const trimmed = projectSearch.trim();
    return /^[a-zA-Z]:[\\/]/i.test(trimmed) || trimmed.includes('/') || trimmed.includes('\\');
  }, [projectSearch]);

  const handleRemoveRecentProject = useCallback((projectPath: string) => {
    if (projectPath === activeWorkspacePath) {
      handleWorkspacePathChange(null);
    }
    if (typeof window !== 'undefined') {
      try {
      const saved = appStorage.getItem('eterx_recent_projects');
        const parsed = saved ? JSON.parse(saved) : [];
        if (Array.isArray(parsed)) {
          const updated = parsed.filter((p: any) => p.path !== projectPath);
          appStorage.setItem('eterx_recent_projects', JSON.stringify(updated));
          setRecentProjects(updated);
        }
      } catch { }
    }
  }, [activeWorkspacePath, handleWorkspacePathChange]);

  const handleSelectFolderDialog = useCallback(async () => {
    const w = window as any;
    let selectedPath: string | null = null;
    try {
      if (typeof w.electronAPI?.selectFolder === 'function') {
        selectedPath = await w.electronAPI.selectFolder();
      } else {
        selectedPath = window.prompt('Paste or type your local project folder path:');
      }
    } catch {
      showComposerNotice('Folder picker unavailable', 'EterX could not open the folder picker. Try again or paste a folder path into project search.');
      return;
    }

    if (selectedPath && selectedPath.trim()) {
      const cleanPath = selectedPath.trim();
      handleWorkspacePathChange(cleanPath);

      // Save to recent projects
      if (typeof window !== 'undefined') {
        try {
      const saved = appStorage.getItem('eterx_recent_projects');
          const parsed = saved ? JSON.parse(saved) : [];
          const name = cleanPath.split(/[/\\]/).filter(Boolean).pop() || cleanPath;
          const updated = [
            { path: cleanPath, name, openedAt: Date.now() },
            ...(Array.isArray(parsed) ? parsed : []).filter((p: any) => p && typeof p.path === 'string' && typeof p.name === 'string' && p.path !== cleanPath)
          ].slice(0, 8);
          appStorage.setItem('eterx_recent_projects', JSON.stringify(updated));
          setRecentProjects(updated);
        } catch { }
      }
    }
    setOpenStatusMenu(null);
  }, [handleWorkspacePathChange, showComposerNotice]);

  const refreshStoredModelSettings = useCallback(() => {
    const loaded = readStoredModelSettings();
    const storedThinkingLevels = readModelThinkingLevels();
    const usableModelKeys = new Set(loaded.modelEntries.map(entry => modelEntryKey(entry.provider, entry.modelId)));
    const loadedThinkingLevels = Object.fromEntries(
      Object.entries(storedThinkingLevels).filter(([modelKey]) => usableModelKeys.has(modelKey)),
    ) as Record<string, MainAgentThinkingLevel>;
    const cleanOverrides = Object.fromEntries(
      Object.entries(loaded.modelOverrides).filter(([, modelId]) => !isEmbeddedModelLabel(modelId)),
    ) as Partial<Record<MainAgentProvider, string>>;
    const cleanCatalog = entriesToModelCatalog(loaded.modelEntries);
    const cleanSelection = loaded.chatModelSelection;

    // Persist the migration once so the removed placeholder cannot return
    // from the folder snapshot on the next refresh or another device.
    const durableValues: Array<[string, string]> = [
      [MODEL_SELECTOR_STORAGE_KEY, JSON.stringify(loaded.modelEntries)],
      [MODEL_CATALOG_STORAGE_KEY, JSON.stringify(cleanCatalog)],
      [MODEL_OVERRIDE_STORAGE_KEY, JSON.stringify(cleanOverrides)],
      [CHAT_MODEL_SELECTION_STORAGE_KEY, cleanSelection],
    ];
    const durableSnapshot = Object.fromEntries(durableValues);
    // This callback also runs for each storage update. Only persist an actual
    // migration change; rewriting the same snapshot from inside the storage
    // event handler can otherwise re-enter that handler while a write is
    // still pending and freeze the renderer during model selection.
    if (durableValues.some(([key, value]) => appStorage.getItem(key) !== value)) {
      appStorage.setItems(durableSnapshot);
    }
    if (JSON.stringify(storedThinkingLevels) !== JSON.stringify(loadedThinkingLevels)) {
      persistModelThinkingLevels(loadedThinkingLevels);
    }

    setStoredModelSettings({
      ...loaded,
      modelOverrides: cleanOverrides,
      modelCatalog: cleanCatalog,
      chatModelSelection: cleanSelection,
    });
    setModelThinkingLevels(previous =>
      JSON.stringify(previous) === JSON.stringify(loadedThinkingLevels)
        ? previous
        : loadedThinkingLevels
    );
  }, []);

  const refreshComposerThinkingCapabilities = useCallback(async () => {
    await refreshSavedModelCatalog();
  }, []);
  // Let the editor grow with the draft, but keep long prompts from taking over
  // the chat. Once this bound is reached, the textarea itself becomes the
  // scroll viewport and the rest of the composer stays in place.
  const textareaMinHeight = 26;
  const textareaMaxHeight = isCompressed ? 180 : 240;
  // Agent identity and model selection have different lifecycles. A worker's
  // identity stays fixed, while choosing a model during its current response
  // is a valid request for the next continuation turn.
  const isModelLocked = isThinking && !allowModelSelectionWhileThinking;
  const activeAgentDisplay = useMemo(() => {
    if (chatMode) {
      return {
        label: 'Chat',
        description: 'Direct conversation with current chat context',
        activeClass: 'border-white/[0.16] bg-white/[0.055] text-white hover:bg-white/[0.08] hover:border-white/[0.24]',
      };
    }
    if (!selectedAgent) {
      return {
        label: 'General',
        description: 'Default EterX agent',
        activeClass: 'border-white/[0.16] bg-white/[0.055] text-white hover:bg-white/[0.08] hover:border-white/[0.24]',
      };
    }
    if (selectedAgent === 'autonomous') {
      return {
        // Legacy state is migrated by the parent. Keep the fallback neutral
        // during that migration so Autonomous is never shown as the worker.
        label: 'General',
        description: 'Default EterX agent',
        activeClass: 'border-white/[0.16] bg-white/[0.055] text-white hover:bg-white/[0.08] hover:border-white/[0.24]',
      };
    }
    const codingMode = getCodingMode(selectedAgent);
    if (codingMode) {
      return {
        label: codingMode.label,
        description: codingMode.description,
        activeClass: 'border-white/[0.16] bg-white/[0.055] text-white hover:bg-white/[0.08] hover:border-white/[0.24]',
      };
    }
    const serverAgent = availableAgents.find(agent => agent.agentId === selectedAgent);
    const storedAgent = storedAgents.find(agent => agent.id === selectedAgent);
    return {
      label: serverAgent?.name || storedAgent?.name || selectedAgentName || selectedAgent,
      description: serverAgent?.presentation?.description || serverAgent?.mission || storedAgent?.description || 'Custom-built agent',
      activeClass: 'border-white/[0.18] bg-white/[0.065] text-white hover:bg-white/[0.09] hover:border-white/[0.26]',
    };
  }, [availableAgents, chatMode, selectedAgent, selectedAgentName, storedAgents]);

  const refreshAvailableAgents = useCallback(async () => {
    try {
      const response = await fetch('/api/agents/list', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      setAvailableAgents((data.agents || []).filter((agent: any) => agent.status === 'ready'));
    } catch { }
  }, []);

  useEffect(() => {
    if (showAgentMenu) refreshAvailableAgents();
  }, [refreshAvailableAgents, showAgentMenu]);

  useEffect(() => {
    if (!showModelMenu) return;
    void refreshComposerThinkingCapabilities();
  }, [refreshComposerThinkingCapabilities, showModelMenu]);


  useEffect(() => {
    refreshStoredModelSettings();

    const onSettingsUpdated = () => {
      refreshStoredModelSettings();
    };

    window.addEventListener('focus', onSettingsUpdated);
    window.addEventListener('eterx-settings-updated', onSettingsUpdated);
    window.addEventListener(FOLDER_STORAGE_READY_EVENT, onSettingsUpdated);
    window.addEventListener('eterx-folder-storage-updated', onSettingsUpdated);
    void appStorageReady.then(onSettingsUpdated);

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(SETTINGS_CHANNEL);
      channel.onmessage = onSettingsUpdated;
    } catch {
      channel = null;
    }

    return () => {
      window.removeEventListener('focus', onSettingsUpdated);
      window.removeEventListener('eterx-settings-updated', onSettingsUpdated);
      window.removeEventListener(FOLDER_STORAGE_READY_EVENT, onSettingsUpdated);
      window.removeEventListener('eterx-folder-storage-updated', onSettingsUpdated);
      channel?.close();
    };
  }, [refreshStoredModelSettings]);

  useEffect(() => {
    const handleAgentsUpdated = (event?: Event) => {
      const deletedAgentId = (event as CustomEvent | undefined)?.detail?.deletedAgentId;
      if (deletedAgentId && deletedAgentId === selectedAgent) {
        onAgentChange?.(null, 'General');
      }
      void loadStoredAgents().then(setStoredAgents);
      void refreshAvailableAgents();
    };
    window.addEventListener('focus', handleAgentsUpdated);
    window.addEventListener('eterx_agents_updated', handleAgentsUpdated as EventListener);
    return () => {
      window.removeEventListener('focus', handleAgentsUpdated);
      window.removeEventListener('eterx_agents_updated', handleAgentsUpdated as EventListener);
    };
  }, [onAgentChange, refreshAvailableAgents, selectedAgent]);

  useEffect(() => { setCodingDetails(null); }, [showAgentMenu, activeChatId]);
  const closeCodingDetails = () => {
    const modeId = codingDetails;
    setCodingDetails(null);
    requestAnimationFrame(() => agentSelectorRef.current?.querySelector<HTMLButtonElement>(`[data-coding-info="${modeId}"]`)?.focus());
  };

  // Close agent menu on outside click
  useEffect(() => {
    if (!showAgentMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (target && agentSelectorRef.current?.contains(target)) return;
      setShowAgentMenu(false);
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (codingDetails) closeCodingDetails();
      else {
        setShowAgentMenu(false);
        agentSelectorRef.current?.querySelector<HTMLButtonElement>('.eterx-agent-button')?.focus();
      }
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', escHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', escHandler);
    };
  }, [showAgentMenu, codingDetails]);

  useEffect(() => {
    setShowContextUsagePanel(false);
  }, [activeChatId]);

  useEffect(() => {
    if (!showContextUsagePanel) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (contextUsagePanelRef.current?.contains(target)) return;
      if (contextUsageTriggerRef.current?.contains(target)) return;
      setShowContextUsagePanel(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowContextUsagePanel(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [showContextUsagePanel]);

  useEffect(() => {
    if (isModelLocked) {
      setShowModelMenu(false);
      setShowThinkingLevels(false);
    }
  }, [isModelLocked]);
  useEffect(() => {
    if (executionContextLocked) setShowAgentMenu(false);
  }, [executionContextLocked]);
  useEffect(() => {
    if (!showModelMenu) {
      setShowThinkingLevels(false);
      setThinkingMenuModelKey(null);
      setThinkingMenuPosition(null);
      thinkingMenuAnchorRef.current = null;
    }
  }, [showModelMenu]);

  useEffect(() => {
    if (initialFocusAppliedRef.current) return;
    initialFocusAppliedRef.current = true;

    const focusTimer = window.setTimeout(() => {
      const activeElement = document.activeElement;
      const activeIsEditable =
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        (activeElement instanceof HTMLElement && activeElement.isContentEditable);

      if (!activeIsEditable && !isThinking && !isRecording && liveState === 'idle') {
        textareaRef.current?.focus({ preventScroll: true });
      }
    }, 250);

    return () => window.clearTimeout(focusTimer);
  }, []); // Focus only once when the input first mounts.
  useEffect(() => {
    if (!showModelMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      const selector = modelSelectorRef.current;
      const thinkingMenu = thinkingMenuPortalRef.current;
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const target = event.target as Node | null;
      if (selector && (selector.contains(target) || path.includes(selector))) return;
      if (thinkingMenu && (thinkingMenu.contains(target) || path.includes(thinkingMenu))) return;
      setShowModelMenu(false);
      setShowThinkingLevels(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowModelMenu(false);
        setShowThinkingLevels(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showModelMenu]);
  const [logoHoverText, setLogoHoverText] = useState('');

  useEffect(() => {
    if (!showAgentMenu || typeof window === 'undefined') {
      setAgentMenuXOffset(0);
      return;
    }

    const updatePosition = () => {
      const rect = agentSelectorRef.current?.getBoundingClientRect();
      if (!rect) return;

      const margin = 16;
      const menuWidth = Math.min(codingDetails ? 320 : 224, window.innerWidth - margin * 2);
      setAgentMenuXOffset(getCenteredPopoutOffset(rect, menuWidth, margin));
      const opensDown = traceLogsLength === 0 && liveState === 'idle';
      const availableHeight = opensDown ? window.innerHeight - rect.bottom - 26 : rect.top - 26;
      setAgentMenuMaxHeight(Math.max(96, Math.min(380, availableHeight)));
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [showAgentMenu, codingDetails, traceLogsLength, liveState]);

  useEffect(() => {
    if (!showModelMenu || typeof window === 'undefined') {
      setModelMenuXOffset(0);
      return;
    }

    const updatePosition = () => {
      const rect = modelSelectorRef.current?.getBoundingClientRect();
      if (!rect) return;

      const margin = 16;
      const menuWidth = Math.min(isCompressed ? 248 : 286, window.innerWidth - margin * 2);
      const xOffset = getCenteredPopoutOffset(rect, menuWidth, margin);
      const menuLeft = rect.left + rect.width / 2 - menuWidth / 2 + xOffset;
      const menuRight = menuLeft + menuWidth;

      setModelMenuXOffset(xOffset);
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isCompressed, showModelMenu]);

  const logoHoverPhrases = [
    "Awaiting your command.",
    "Ready to assist!",
    "Systems fully operational.",
    "How can I help today?",
    "Standing by for input.",
    "Ready to execute!",
    "At your service.",
    "Awaiting task parameters.",
    "Shall we begin?",
    "All systems engaged!",
    "Awaiting next directive.",
    "Ready for deployment.",
    "Standing by.",
    "How may I proceed?",
    "Fully initialized!",
    "Awaiting instructions."
  ];

  // Smart scroll position tracking for textarea fumes
  const handleTextareaScroll = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const threshold = 5; // Slightly larger tolerance for mobile/retina
    setIsAtTop(el.scrollTop <= threshold);
    setIsAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - threshold);
  }, []);

  const syncSlashTrigger = useCallback((value = latestInputValueRef.current, selectionStart?: number | null) => {
    const cursor = typeof selectionStart === 'number'
      ? selectionStart
      : textareaRef.current?.selectionStart ?? value.length;
    const beforeCursor = value.slice(0, cursor);
    const lineStart = beforeCursor.lastIndexOf('\n') + 1;
    const linePrefix = beforeCursor.slice(lineStart);
    const slashQuery = linePrefix.slice(1);

    if (!linePrefix.startsWith('/') || /\s/.test(slashQuery) || slashQuery.length > 48) {
      setSlashTrigger(null);
      return;
    }

    setSlashTrigger(prev => {
      const next = { start: lineStart, end: cursor, query: slashQuery.toLowerCase() };
      if (prev && prev.start === next.start && prev.end === next.end && prev.query === next.query) return prev;
      setSlashActiveIndex(0);
      return next;
    });
  }, []);

  const filteredSlashCommands = useMemo(() => {
    if (!slashTrigger) return [];
    const availableCommands = chatMode
      ? SLASH_COMMANDS.filter(command => command.action !== 'plan' && command.action !== 'swarm')
      : SLASH_COMMANDS;
    const query = slashTrigger.query.trim();
    if (!query) return availableCommands;

    return availableCommands.filter(command => {
      const target = `${ command.label } ${ command.description } ${ command.id }`.toLowerCase();
      return target.includes(query);
    });
  }, [chatMode, slashTrigger]);

  const closeSlashPanel = useCallback(() => setSlashPanel(null), []);

  const openSlashPanel = useCallback((panel: SlashPanel) => {
    if (panel === 'agents') {
      void loadStoredAgents().then(setStoredAgents);
    }
    if (panel === 'goal') {
      setGoalDraft(readStoredGoal(activeChatId));
    }
    setSlashPanelOffset({ x: 0, y: 0 });
    setSlashPanel(panel);
  }, [activeChatId]);

  const handleComposerDragStart = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (isComposerEditableTarget(event.target)) return;
    event.preventDefault();
  }, []);

  const startSlashPanelDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button,textarea,input,a')) return;

    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = slashPanelOffset;

    const handleMove = (moveEvent: PointerEvent) => {
      const nextOffset = {
        x: origin.x + moveEvent.clientX - startX,
        y: origin.y + moveEvent.clientY - startY,
      };

      if (slashDragFrameRef.current !== null) {
        window.cancelAnimationFrame(slashDragFrameRef.current);
      }
      slashDragFrameRef.current = window.requestAnimationFrame(() => {
        setSlashPanelOffset(nextOffset);
        slashDragFrameRef.current = null;
      });
    };

    const stopDrag = () => {
      if (slashDragFrameRef.current !== null) {
        window.cancelAnimationFrame(slashDragFrameRef.current);
        slashDragFrameRef.current = null;
      }
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
  }, [slashPanelOffset]);

  const selectSlashCommand = useCallback((command: SlashCommand) => {
    if (!slashTrigger) return;
    const currentInputValue = latestInputValueRef.current;
    if (command.action) {
      const nextValue = `${ currentInputValue.slice(0, slashTrigger.start) }${ currentInputValue.slice(slashTrigger.end) }`;
      latestInputValueRef.current = nextValue;
      setHasPromptText(Boolean(nextValue.trim()));
      notifyAgentFaceInputChange(currentInputValue, nextValue);
      setInputValue(nextValue);
      setSlashTrigger(null);
      if (command.action === 'swarm') {
        setSwarmModeActive(!swarmModeActive);
        window.requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
        return;
      }
      if (command.action === 'plan') {
        setPlanModeActive(!planModeActive);
        window.requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
        return;
      }
      if (command.action === 'pet') {
        onOpenPet();
        return;
      }
      if (command.action === 'compact') {
        if (!onCompact || compacting) return;
        void onCompact().catch((error: unknown) => {
          showComposerNotice('Could not compact context', error instanceof Error ? error.message : 'Please try again.');
        });
        return;
      }
      openSlashPanel(command.action);
      return;
    }

    const nextValue = `${ currentInputValue.slice(0, slashTrigger.start) }${ command.prompt }${ currentInputValue.slice(slashTrigger.end) }`;
    const nextCaret = slashTrigger.start + command.prompt.length;

    latestInputValueRef.current = nextValue;
    setHasPromptText(Boolean(nextValue.trim()));
    notifyAgentFaceInputChange(currentInputValue, nextValue);
    setInputValue(nextValue);
    setSlashTrigger(null);

    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  }, [onOpenPet, openSlashPanel, setInputValue, slashTrigger, onCompact, compacting, planModeActive, setPlanModeActive, swarmModeActive, setSwarmModeActive, showComposerNotice]);

  const openAgentRoomFromPanel = useCallback(() => {
    closeSlashPanel();
    onOpenAgents();
  }, [closeSlashPanel, onOpenAgents]);

  const openAgentFromPanel = useCallback((agentId: string) => {
    const agent = storedAgents.find(item => item.id === agentId);
    if (agent?.isSetup === false) {
      // Drafts are visible in Agent Room for continued setup, but selecting
      // one here would only produce a 409 at send time. Route the user back
      // to the builder instead of creating a dead chat selection.
      closeSlashPanel();
      onOpenAgents();
      return;
    }
    onAgentChange?.(agentId, agent?.name || agentId);
    closeSlashPanel();
    window.requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
  }, [closeSlashPanel, onAgentChange, onOpenAgents, storedAgents]);

  const establishGoal = useCallback(() => {
    writeStoredGoal(activeChatId, goalDraft);
    closeSlashPanel();
  }, [activeChatId, closeSlashPanel, goalDraft]);

  const syncGoalTextareaHeight = useCallback(() => {
    const textarea = goalTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 86), 176);
    textarea.style.height = `${ nextHeight }px`;
    textarea.style.overflowY = textarea.scrollHeight > 176 ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    if (slashPanel !== 'goal') return;
    window.requestAnimationFrame(syncGoalTextareaHeight);
  }, [goalDraft, slashPanel, syncGoalTextareaHeight]);

  useEffect(() => {
    return () => {
      if (slashDragFrameRef.current !== null) {
        window.cancelAnimationFrame(slashDragFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    SLASH_COMMANDS.forEach(command => {
      const image = new Image();
      image.decoding = 'sync';
      image.src = command.iconSrc;
    });
  }, []);

  useEffect(() => {
    if (slashActiveIndex >= filteredSlashCommands.length) {
      setSlashActiveIndex(Math.max(0, filteredSlashCommands.length - 1));
    }
  }, [filteredSlashCommands.length, slashActiveIndex]);

  useEffect(() => {
    if (!latestInputValueRef.current && slashTrigger) setSlashTrigger(null);
  }, [activeComposerChatKey, inputValue, slashTrigger]);

  useEffect(() => {
    if (liveState !== 'idle') {
      setSlashTrigger(null);
      setSlashPanel(null);
    }
  }, [liveState]);

  // Save pasted and dropped files as binary FormData so the renderer never
  // base64-encodes media.
  const saveFileForAgent = useCallback(async (file: File, attachmentId: string, displayName: string) => {
    try {
      const filePath = getNativeFilePath(file);
      if (filePath) {
        setAttachments(prev => prev.map(att => att.id === attachmentId ? {
          ...att,
          uploadStatus: 'done' as const,
          mimeType: getAttachmentMimeType(displayName, file.type),
          size: file.size,
          localPath: filePath,
          preview: /^(?:image|video)\//.test(getAttachmentMimeType(displayName, file.type)) ? buildLocalFilePreviewUrl(filePath) : att.preview,
        } : att));
        return;
      }

      const formData = new FormData();
      formData.append('file', file, displayName);
      formData.append('fileName', displayName);
      formData.append('mimeType', file.type || 'application/octet-stream');

      const res = await fetch('/api/media/upload', {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        setAttachments(prev => prev.map(att => att.id === attachmentId ? { ...att, uploadStatus: 'error' as const } : att));
        return;
      }

      const data = await res.json();
      if (!data?.localPath) {
        throw new Error('The upload service did not return a local attachment path.');
      }
      setAttachments(prev => prev.map(att => {
        if (att.id !== attachmentId) return att;
        const mimeType = getAttachmentMimeType(displayName, data.mimeType || file.type);
        const nextPreview = /^(?:image|video)\//.test(mimeType) && data.localPath
          ? buildLocalFilePreviewUrl(data.localPath)
          : att.preview;
        if (nextPreview !== att.preview) revokeObjectPreview(att.preview);
        return {
          ...att,
          uploadStatus: 'done' as const,
          mimeType,
          size: file.size,
          localPath: data.localPath,
          preview: nextPreview,
        };
      }));
    } catch {
      setAttachments(prev => prev.map(att => att.id === attachmentId ? { ...att, uploadStatus: 'error' as const } : att));
    }
  }, [setAttachments]);

  // Attach files instantly, then prepare only files that do not already have a local path.
  const addFilesAndUpload = useCallback((files: File[]) => {
    const validFiles = files.filter(file => file && file.size > 0);
    if (validFiles.length === 0) return;

    notifyAgentFaceFiles(validFiles);

    const newAttachments = validFiles.map((file, index) => {
      const displayName = getAttachmentName(file);
      const localPath = getNativeFilePath(file);
      const mimeType = getAttachmentMimeType(displayName, file.type);
      const isVisualMedia = /^(?:image|video)\//.test(mimeType);
      return {
        id: `${ Date.now() }-${ index }-${ Math.random().toString(36).slice(2) }`,
        file,
        name: displayName,
        mimeType,
        size: file.size,
        preview: isVisualMedia
          ? (localPath ? buildLocalFilePreviewUrl(localPath) : URL.createObjectURL(file))
          : '',
        uploadStatus: localPath ? 'done' as const : 'uploading' as const,
        localPath: localPath || undefined,
      };
    });

    setAttachments(prev => [...prev, ...newAttachments]);

    for (const att of newAttachments) {
      if (att.uploadStatus === 'uploading') {
        void saveFileForAgent(att.file, att.id, att.name);
      }
    }
  }, [setAttachments, saveFileForAgent]);

  useEffect(() => {
    const handleClickOutside = () => {
      setOpenPillDrop(null);
      setShowPinMenu(false);
      setSlashTrigger(null);
      setOpenStatusMenu(null);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpenPillDrop(null);
      setShowPinMenu(false);
      setSlashTrigger(null);
      setOpenStatusMenu(null);
    };
    if (openPillDrop || showPinMenu || slashTrigger || openStatusMenu) {
      window.addEventListener('click', handleClickOutside);
      window.addEventListener('keydown', handleEscape);
    }
    return () => {
      window.removeEventListener('click', handleClickOutside);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [openPillDrop, openStatusMenu, showPinMenu, slashTrigger]);

  const syncTextareaOverflow = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.overflowY = 'hidden';
    textarea.style.height = '0px';
    const contentHeight = Math.ceil(textarea.scrollHeight);
    const overflowing = contentHeight > textareaMaxHeight + 1;
    const nextHeight = Math.max(
      textareaMinHeight,
      Math.min(contentHeight, textareaMaxHeight),
    );

    textarea.style.height = `${ nextHeight }px`;
    textarea.style.overflowY = overflowing ? 'auto' : 'hidden';
    setIsOverflowing(overflowing);

    if (overflowing) {
      handleTextareaScroll();
    } else {
      textarea.scrollTop = 0;
      setIsAtTop(true);
      setIsAtBottom(true);
    }
  }, [handleTextareaScroll, textareaMaxHeight, textareaMinHeight]);

  const scheduleTextareaOverflowSync = useCallback(() => {
    if (textareaResizeFrameRef.current !== null) return;
    textareaResizeFrameRef.current = window.requestAnimationFrame(() => {
      textareaResizeFrameRef.current = null;
      syncTextareaOverflow();
    });
  }, [syncTextareaOverflow]);

  const handleComposerValueChange = useCallback((nextValue: string, selectionStart: number | null) => {
    const previousValue = latestInputValueRef.current;
    latestInputValueRef.current = nextValue;
    const nextHasPromptText = Boolean(nextValue.trim());
    setHasPromptText(previous => previous === nextHasPromptText ? previous : nextHasPromptText);
    notifyAgentFaceInputChange(previousValue, nextValue);
    if (onInputValueChange) onInputValueChange(nextValue);
    else setInputValue(nextValue);
    syncSlashTrigger(nextValue, selectionStart);
  }, [onInputValueChange, setInputValue, syncSlashTrigger]);

  useEffect(() => () => {
    if (textareaResizeFrameRef.current !== null) {
      window.cancelAnimationFrame(textareaResizeFrameRef.current);
      textareaResizeFrameRef.current = null;
    }
  }, []);

  const syncLiveTextareaHeight = useCallback((textarea: HTMLTextAreaElement) => {
    textarea.style.overflowY = 'hidden';
    textarea.style.height = 'auto';
    const contentHeight = textarea.scrollHeight;
    textarea.style.height = `${Math.min(contentHeight, 150)}px`;
    textarea.style.overflowY = contentHeight > 150 ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    const container = textarea?.parentElement;
    if (!container || typeof ResizeObserver === 'undefined') return;

    textareaWidthRef.current = container.getBoundingClientRect().width;
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0]?.contentRect.width || 0;
      if (Math.abs(nextWidth - textareaWidthRef.current) < 0.5) return;
      textareaWidthRef.current = nextWidth;
      syncTextareaOverflow();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [syncTextareaOverflow]);

  // Generate a random ID for items
  const genId = () => Math.random().toString(36).substr(2, 9);

  const handlePinFolder = async () => {
    setShowPinMenu(false);
    const desktopApi = (window as any).electronAPI;
    if (typeof desktopApi?.selectFolder !== 'function') {
      showComposerNotice('Desktop picker unavailable', 'Open the EterX desktop app to pin a workspace folder.');
      return;
    }

    try {
      const folderPath = await desktopApi.selectFolder();
      if (!folderPath) return;
      const sysIcon = typeof desktopApi.getFileIcon === 'function'
        ? await desktopApi.getFileIcon(folderPath).catch(() => null)
        : null;
      setPinnedItems(prev => {
        if (prev.some(item => item.path === folderPath)) return prev;
        return [...prev, {
          id: genId(),
          type: 'folder',
          path: folderPath,
          name: folderPath.split(/[/\\]/).pop() || 'Folder',
          systemIcon: sysIcon || undefined,
        }];
      });
    } catch {
      showComposerNotice('Folder picker unavailable', 'EterX could not open the desktop folder picker.');
    }
  };

  const handlePinFiles = async () => {
    setShowPinMenu(false);
    const desktopApi = (window as any).electronAPI;
    if (typeof desktopApi?.selectFiles !== 'function') {
      showComposerNotice('Desktop picker unavailable', 'Open the EterX desktop app to pin local files.');
      return;
    }

    try {
      const filePaths = await desktopApi.selectFiles();
      if (!Array.isArray(filePaths) || filePaths.length === 0) return;
      const newItems = await Promise.all(filePaths.map(async (filePath: string) => {
        const sysIcon = typeof desktopApi.getFileIcon === 'function'
          ? await desktopApi.getFileIcon(filePath).catch(() => null)
          : null;
        return {
          id: genId(),
          type: 'file',
          path: filePath,
          name: filePath.split(/[/\\]/).pop() || 'File',
          systemIcon: sysIcon || undefined,
        };
      }));

      setPinnedItems(prev => {
        const existingPaths = new Set(prev.map(item => item.path));
        const uniqueItems = newItems.filter(item => {
          if (existingPaths.has(item.path)) return false;
          existingPaths.add(item.path);
          return true;
        });
        return uniqueItems.length > 0 ? [...prev, ...uniqueItems] : prev;
      });
    } catch {
      showComposerNotice('File picker unavailable', 'EterX could not open the desktop file picker.');
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addFilesAndUpload(Array.from(e.target.files));
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedFiles = Array.from(e.clipboardData.files || []);
    const itemFiles = Array.from(e.clipboardData.items || [])
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => !!file);
    // Some macOS clipboard providers expose a zero-byte placeholder file
    // before the native image is available. Ignore placeholders so the native
    // clipboard-image fallback below can handle the real screenshot.
    const files = (pastedFiles.length > 0 ? pastedFiles : itemFiles)
      .filter(file => file && file.size > 0);

    if (files.length > 0) {
      e.preventDefault();
      addFilesAndUpload(files);
      return;
    }

    const target = e.currentTarget;
    const currentValue = target.value;
    const start = Math.max(0, Math.min(target.selectionStart ?? currentValue.length, currentValue.length));
    const end = Math.max(start, Math.min(target.selectionEnd ?? start, currentValue.length));
    const eventText = e.clipboardData.getData('text/plain') || e.clipboardData.getData('text');

    // Cancel before the first await. React does not await event handlers, so
    // waiting first would allow the native paste to run a second time.
    e.preventDefault();
    if (!eventText) {
      const nativeImage = await safeReadImageFromClipboard();
      if (nativeImage) {
        const imageFile = await clipboardDataUrlToFile(nativeImage, `pasted-image-${Date.now()}.png`);
        if (imageFile) {
          addFilesAndUpload([imageFile]);
          return;
        }
      }
    }
    const pastedText = eventText || await safeReadTextFromClipboard();
    if (!pastedText) return;
    if (shouldAttachPaste(pastedText)) {
      addFilesAndUpload([new File([pastedText], `Pasted text ${Date.now()}.txt`, { type: PASTED_TEXT_MIME })]);
      return;
    }

    const nextValue = `${currentValue.slice(0, start)}${pastedText}${currentValue.slice(end)}`;
    const previousValue = latestInputValueRef.current;
    latestInputValueRef.current = nextValue;
    setHasPromptText(Boolean(nextValue.trim()));
    notifyAgentFaceInputChange(previousValue, nextValue);
    setInputValue(nextValue);
    syncSlashTrigger(nextValue, start + pastedText.length);
    requestAnimationFrame(() => {
      if (!target.isConnected) return;
      target.focus();
      target.selectionStart = target.selectionEnd = start + pastedText.length;
    });
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) e.dataTransfer.dropEffect = 'copy';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const directFiles = Array.from(e.dataTransfer.files || []);
    const itemFiles = directFiles.length > 0
      ? []
      : Array.from(e.dataTransfer.items || [])
        .filter(item => item.kind === 'file')
        .map(item => item.getAsFile())
        .filter((file): file is File => !!file);
    const files = directFiles.length > 0 ? directFiles : itemFiles;
    if (files.length > 0) addFilesAndUpload(files);
  };

  const removeAttachment = (index: number) => {
    // Editing the attachment set cancels the deferred submission intent.
    queuedSendRef.current = null;
    setAttachments(prev => {
      const newArr = [...prev];
      revokeObjectPreview(newArr[index]?.preview);
      newArr.splice(index, 1);
      return newArr;
    });
  };

  const hasPreparingAttachments = attachments.some(att => att.uploadStatus === 'uploading');
  const hasErroredAttachments = attachments.some(att => att.uploadStatus === 'error');
  const hasComposerPayload = hasPromptText || attachments.length > 0;
  // Capability validation belongs to the provider adapter. The composer must
  // never drop or block a real file just because a model catalogue entry uses
  // an unfamiliar vision/media name; the selected provider receives the
  // original binary and returns its native validation error if necessary.
  const getAttachmentCompatibilityIssue = useCallback((): { title: string; message: string } | null => null, []);

  const handleStopClick = useCallback(() => {
    const chatKey = activeChatId || 'new_chat';
    if (stopRequestsRef.current.has(chatKey)) return;

    setStoppingChatIds(previous => new Set(previous).add(chatKey));
    const stopPromise = (async () => {
      try {
        const accepted = await handleStop();
        if (accepted === false) {
          showComposerNotice('Stop request was not accepted', 'The run may already have finished. Try again if it is still active.');
        }
      } catch (error: unknown) {
        showComposerNotice('Could not stop the run', String(error instanceof Error ? error.message : error || 'Please try again.').slice(0, 180));
      } finally {
        stopRequestsRef.current.delete(chatKey);
        setStoppingChatIds(previous => {
          if (!previous.has(chatKey)) return previous;
          const next = new Set(previous);
          next.delete(chatKey);
          return next;
        });
      }
    })();

    stopRequestsRef.current.set(chatKey, stopPromise);
  }, [activeChatId, handleStop, showComposerNotice]);

  useEffect(() => {
    if (managedWorkspace.busy || queuedSendRef.current !== activeComposerChatKey || hasPreparingAttachments || hasErroredAttachments) return;
    if (!latestInputValueRef.current.trim() && attachments.length === 0) {
      queuedSendRef.current = null;
      return;
    }
    if (isNetworkPaused) return;
    if (!isThinking && !activeConfiguredChatModel) {
      queuedSendRef.current = null;
      showComposerNotice('No model configured', 'Add an API key in Settings > API, then choose a live model in Settings > Models.');
      return;
    }
    queuedSendRef.current = null;
    const attachmentIssue = getAttachmentCompatibilityIssue();
    if (attachmentIssue) {
      showComposerNotice(attachmentIssue.title, attachmentIssue.message);
      return;
    }
    if (isThinking) {
      if (hasComposerPayload) handleSteer();
      return;
    }
    notifyAgentFaceSend();
    handleSend();
  }, [managedWorkspace.busy, activeComposerChatKey, activeConfiguredChatModel, attachments.length, getAttachmentCompatibilityIssue, handleSend, handleSteer, hasComposerPayload, hasErroredAttachments, hasPreparingAttachments, isNetworkPaused, isThinking, showComposerNotice]);

  const submitPrompt = useCallback(() => {
    if (managedWorkspace.busy) {
      showComposerNotice('Preparing workspace', 'Your workspace is still being created. Send your message once it is ready.');
      return;
    }
    const hasCurrentPayload = Boolean(latestInputValueRef.current.trim()) || attachments.length > 0;
    if (isNetworkPaused) {
      onNetworkPausedAction();
      return;
    }
    if (hasPreparingAttachments) {
      queuedSendRef.current = activeComposerChatKey;
      showComposerNotice('Preparing attachments', 'Your message will send as soon as every attachment is ready.');
      return;
    }
    if (hasErroredAttachments) {
      showComposerNotice('Attachment upload failed', 'Remove the failed attachment or add it again before sending.');
      return;
    }
    const attachmentIssue = getAttachmentCompatibilityIssue();
    if (attachmentIssue) {
      showComposerNotice(attachmentIssue.title, attachmentIssue.message);
      return;
    }

    if (isLiveActive) {
      const textToSubmit = latestInputValueRef.current.trim();
      if (textToSubmit) {
        latestInputValueRef.current = '';
        setHasPromptText(false);
        setInputValue('');
        onLiveSendText?.(textToSubmit);
      }
      return;
    }

    if (isThinking) {
      if (hasCurrentPayload) {
        handleSteer();
      }
      return;
    }
    if (!activeConfiguredChatModel) {
      showComposerNotice('No model configured', 'Add an API key in Settings > API, then choose a live model in Settings > Models.');
      return;
    }
    // Never invoke the send handler for an empty composer. This can happen
    // when Enter is pressed while the UI is transitioning between states.
    if (!hasCurrentPayload) return;
    notifyAgentFaceSend();
    handleSend();
  }, [managedWorkspace.busy, activeComposerChatKey, activeConfiguredChatModel, attachments.length, getAttachmentCompatibilityIssue, handleSend, handleSteer, hasComposerPayload, hasErroredAttachments, hasPreparingAttachments, isLiveActive, isNetworkPaused, isThinking, onLiveSendText, onNetworkPausedAction, setInputValue, showComposerNotice]);

  const handleTextareaKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter also finalizes IME composition. Do not submit while an input method
    // is still composing a character (keyCode 229 covers missing native
    // composition flags).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (slashTrigger) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashActiveIndex(index => filteredSlashCommands.length === 0 ? 0 : (index + 1) % filteredSlashCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashActiveIndex(index => filteredSlashCommands.length === 0 ? 0 : (index - 1 + filteredSlashCommands.length) % filteredSlashCommands.length);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && filteredSlashCommands.length > 0) {
        e.preventDefault();
        selectSlashCommand(filteredSlashCommands[slashActiveIndex] || filteredSlashCommands[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashTrigger(null);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitPrompt();
    }
  }, [filteredSlashCommands, selectSlashCommand, slashActiveIndex, slashTrigger, submitPrompt]);

  const liveAnimateState: any = { boxShadow: 'none' };
  const liveTransition: any = { duration: 0.2, ease: "easeOut" };

  const isEmptyHome = traceLogsLength === 0 && liveState === 'idle';
  // New chats can already have a reserved/persisted ID while still showing
  // the centered empty composer. Anchor direction follows layout, not ID.
  const isNewChatHome = isEmptyHome;
  const resolvedComposerPlaceholder = composerPlaceholder || (isLiveActive ? "Type..." : isThinking ? "Send a message while EterX works" : isNewChatHome ? "What should EterX work on?" : "Message EterX");
  const toggleStatusMenu = useCallback((event: React.MouseEvent, menu: Exclude<StatusRailMenu, null>) => {
    event.stopPropagation();
    setOpenPillDrop(null);
    setShowPinMenu(false);
    setShowAgentMenu(false);
    setShowModelMenu(false);
    setProjectSearch('');
    setOpenStatusMenu(prev => prev === menu ? null : menu);
  }, []);
  const openProjectsFromRail = useCallback(() => {
    setOpenStatusMenu(null);
    onOpenProjects();
  }, [onOpenProjects]);
  // Keep the composer visually centered with enough breathing room to match
  // the wider Codex-style input surface on desktop. The compact layout keeps
  // its existing constrained width for narrow/embedded views.
  const shellMaxWidth = isCompressed ? 'max-w-[460px]' : 'max-w-[1105px]';
  const inputSidePadding = isCompressed ? 'px-11' : 'px-5 sm:px-6';
  const composerRadius = isCompressed ? 'rounded-[24px]' : 'rounded-[26px]';
  const modelOptions = useMemo<ChatModelOption[]>(() => {
    return storedModelSettings.modelEntries
      .filter(entry =>
        isLocalModelProvider(entry.provider)
        || Boolean(storedModelSettings.apiKeys[entry.provider])
        || Boolean(storedModelSettings.modelApiKeys[modelEntryKey(entry.provider, entry.modelId)])
      )
      .map(entry => {
        const mode = MODEL_PROVIDER_MODE[entry.provider];
        return {
          optionKey: modelEntryKey(entry.provider, entry.modelId),
          id: mode,
          provider: entry.provider,
          label: formatModelName(entry.modelId),
          compactLabel: formatModelName(entry.modelId),
          modelName: entry.modelId,
          modelId: entry.modelId,
        };
      });
  }, [storedModelSettings.apiKeys, storedModelSettings.modelApiKeys, storedModelSettings.modelEntries]);
  const getModelOptionLabel = useCallback((option: ChatModelOption) => option.label, []);
  // Only show models that came from the persisted model directory/settings.
  // The static agent mode config is for request routing; it is not a real
  // selectable model and must never be rendered as one by the composer.
  const activeModelSelection = propChatModelSelection !== undefined ? propChatModelSelection : storedModelSettings.chatModelSelection;
  const selectedModel = modelOptions.find(option => option.optionKey === activeModelSelection) || null;
  
  const getThinkingTarget = useCallback((option: ChatModelOption | null) => option ? ({
    provider: option.provider,
    modelName: option.modelId || option.modelName,
    capabilities: storedModelSettings.thinkingCapabilities[option.optionKey],
  }) : null, [storedModelSettings.thinkingCapabilities]);

  const getThinkingLevelOptions = useCallback((option: ChatModelOption | null) => {
    const target = getThinkingTarget(option);
    return target ? getModelThinkingOptions(target.provider, target.modelName, target.capabilities) : [];
  }, [getThinkingTarget]);

  const allModelOptions = modelOptions;
  const activeThinkingOptions = useMemo(() => getThinkingLevelOptions(selectedModel), [selectedModel, getThinkingLevelOptions]);
  const getEffectiveThinkingLevel = useCallback((option: ChatModelOption | null) => {
    if (!option) return null;
    const target = getThinkingTarget(option);
    if (!target) return null;
    const options = getThinkingLevelOptions(option);
    if (options.length === 0) return null;
    // The selected model's level belongs to this composer/chat. The persisted
    // per-model value is only a default for models that are not active here;
    // otherwise opening chat B can rewrite chat A's reasoning level merely
    // because both use the same model.
    const composerOwnedLevel = option.optionKey === selectedModel?.optionKey
      ? thinkingLevel
      : undefined;
    const storedLevel = modelThinkingLevels[option.optionKey];
    const requestedLevel = composerOwnedLevel
      || storedLevel
      || target.capabilities?.defaultLevel
      || options.find(item => item.id === 'medium')?.id
      || options.find(item => item.id === 'low')?.id
      || options.find(item => item.id !== 'off')?.id
      || options[0].id;
    return normalizeThinkingLevelForModel(
      requestedLevel,
      target.provider,
      target.modelName,
      target.capabilities,
    );
  }, [getThinkingLevelOptions, getThinkingTarget, modelThinkingLevels, selectedModel?.optionKey, thinkingLevel]);
  const normalizedActiveThinkingLevel = useMemo(() => {
    return getEffectiveThinkingLevel(selectedModel);
  }, [getEffectiveThinkingLevel, selectedModel]);
  const selectedThinkingLevel = useMemo(() => {
    return normalizedActiveThinkingLevel
      ? activeThinkingOptions.find(option => option.id === normalizedActiveThinkingLevel) || activeThinkingOptions[0]
      : undefined;
  }, [activeThinkingOptions, normalizedActiveThinkingLevel]);
  const modelDisplayLabel = selectedModel
    ? getModelOptionLabel(selectedModel)
    : modelOptions.length > 0
      ? 'Select a model'
      : 'Set up models';

  // Normalize this composer's active level without rewriting model defaults.
  // Only an explicit thinking-level edit should persist a new default; a
  // catalog refresh or another chat rendering must not overwrite that choice.
  useEffect(() => {
    if (!selectedModel || !normalizedActiveThinkingLevel) return;
    if (normalizedActiveThinkingLevel !== normalizeMainAgentThinkingLevel(thinkingLevel)) {
      onThinkingLevelChange(normalizedActiveThinkingLevel);
    }
  }, [normalizedActiveThinkingLevel, onThinkingLevelChange, selectedModel, thinkingLevel]);

  const handleModelThinkingChange = useCallback((option: ChatModelOption, level: MainAgentThinkingLevel) => {
    const target = getThinkingTarget(option);
    if (!target) return;
    const normalizedLevel = normalizeThinkingLevelForModel(
      level,
      target.provider,
      target.modelName,
      target.capabilities,
    );
    const next = { ...readModelThinkingLevels(), [option.optionKey]: normalizedLevel };
    setModelThinkingLevels(next);
    persistModelThinkingLevels(next);
    if (option.optionKey === selectedModel?.optionKey) {
      onThinkingLevelChange(normalizedLevel);
    }
    emitModelSettingsUpdate({
      type: 'model-thinking-level-updated',
      modelKey: option.optionKey,
      thinkingLevel: normalizedLevel,
    });
  }, [getThinkingTarget, onThinkingLevelChange, selectedModel?.optionKey]);

  useEffect(() => {
    if (!showModelMenu || !showThinkingLevels || !thinkingMenuModelKey) return;
    const updatePosition = () => {
      const anchor = thinkingMenuAnchorRef.current;
      if (!anchor) return;
      const option = allModelOptions.find(item => item.optionKey === thinkingMenuModelKey) || null;
      const optionCount = getThinkingLevelOptions(option).length;
      if (optionCount > 0) updateThinkingMenuPosition(anchor, optionCount);
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [allModelOptions, getThinkingLevelOptions, showModelMenu, showThinkingLevels, thinkingMenuModelKey, updateThinkingMenuPosition]);

  useEffect(() => {
    const el = composerShellRef.current;
    if (!el) return;

    const dock = composerDockRef.current;
    let lastWidth = -1;
    const updateComposerWidth = (width: number) => {
      const rounded = Math.ceil(width);
      if (rounded === lastWidth) return;
      lastWidth = rounded;
      const layout = width < 720 ? 'compact' : 'inline';
      if (el.dataset.railLayout !== layout) el.dataset.railLayout = layout;
      dock?.style.setProperty('--eterx-composer-actual-width', `${rounded}px`);
    };

    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        const width = entry.contentRect.width;
        updateComposerWidth(width);
      }
    });

    updateComposerWidth(el.getBoundingClientRect().width);
    observer.observe(el);
    return () => {
      observer.disconnect();
      dock?.style.removeProperty('--eterx-composer-actual-width');
    };
  }, []);

  // The composer is an absolute overlay. Keep the feed's bottom inset equal
  // to the complete dock height, including the queued-follow-up rail, so the
  // overlay never hides the latest content or changes scrollbar math.
  useEffect(() => {
    const dock = composerDockRef.current;
    const column = dock?.parentElement;
    if (!dock || !column) return;

    let lastInset = '';
    let lastPadding = '';
    let insetFrame = 0;
    const updateBottomInset = () => {
      insetFrame = 0;
      const height = Math.ceil(dock.getBoundingClientRect().height);
      const padding = getComputedStyle(dock).paddingTop;
      if (padding !== lastPadding) {
        lastPadding = padding;
        dock.style.setProperty('--eterx-composer-top-padding', padding);
      }
      const inset = `${ Math.max(160, height + 12) }px`;
      if (inset === lastInset) return;
      lastInset = inset;
      column.style.setProperty('--eterx-chat-composer-inset', inset);
      column.style.setProperty('--eterx-chat-feed-bottom-space', inset);
    };
    const scheduleInset = () => { if (!insetFrame) insetFrame = requestAnimationFrame(updateBottomInset); };

    updateBottomInset();
    const observer = new ResizeObserver(scheduleInset);
    observer.observe(dock);
    window.addEventListener('resize', scheduleInset);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', scheduleInset);
      cancelAnimationFrame(insetFrame);
      column.style.removeProperty('--eterx-chat-composer-inset');
      column.style.removeProperty('--eterx-chat-feed-bottom-space');
    };
  }, [isCompressed, isEmptyHome, queuedFollowUps.length]);

  const selectChatModelOption = useCallback((option: ChatModelOption) => {
    // Resolve while the option is still inactive, so its saved level wins
    // over the previous model's composer-owned level. React batches both
    // callbacks into the same selection update, including sub-agent surfaces.
    const nextThinkingLevel = getEffectiveThinkingLevel(option);
    if (onModelSelectionChange) {
      onModelSelectionChange(option.optionKey);
    }
    if (nextThinkingLevel) {
      onThinkingLevelChange(nextThinkingLevel);
    }
    if (modelSelectionScope === 'surface') {
      setShowModelMenu(false);
      setModelSearch('');
      setShowThinkingLevels(false);
      setThinkingMenuModelKey(null);
      return;
    }
    const nextOverrides = { ...storedModelSettings.modelOverrides, [option.provider]: option.modelId || option.modelName };
    const nextEntries = ensureModelSelectorEntry(storedModelSettings.modelEntries, option.provider, option.modelId || option.modelName);
    const nextCatalog = entriesToModelCatalog(nextEntries);

    appStorage.setItems({
      [CHAT_MODEL_SELECTION_STORAGE_KEY]: option.optionKey,
      [MODEL_SELECTOR_STORAGE_KEY]: JSON.stringify(nextEntries),
      [MODEL_CATALOG_STORAGE_KEY]: JSON.stringify(nextCatalog),
      [MODEL_OVERRIDE_STORAGE_KEY]: JSON.stringify(nextOverrides),
    });
    writeStoredAgentMode(option.id);
    setStoredModelSettings(prev => ({
      ...prev,
      modelOverrides: nextOverrides,
      modelCatalog: nextCatalog,
      modelEntries: nextEntries,
      chatModelSelection: option.optionKey,
    }));
    emitModelSettingsUpdate({
      type: 'model-selection-updated',
      modelOverrides: nextOverrides,
      modelCatalog: nextCatalog,
      modelEntries: nextEntries,
      chatModelSelection: option.optionKey,
    });
    syncRuntimeModelOverrides(nextOverrides);
    onModeChange(option.id);
    setShowModelMenu(false);
    setModelSearch('');
    setShowThinkingLevels(false);
    setThinkingMenuModelKey(null);
  }, [getEffectiveThinkingLevel, onThinkingLevelChange, modelSelectionScope, onModeChange, storedModelSettings.modelEntries, storedModelSettings.modelOverrides, onModelSelectionChange]);
  useEffect(() => {
    if (isModelLocked) return;
    if (modelOptions.some(option => option.optionKey === activeModelSelection)) return;
    const nextSelection = AUTO_MODEL_SELECTION;
    if (activeModelSelection === nextSelection) return;
    if (modelSelectionScope === 'surface') {
      // A chat owns its model selection even while the folder-backed model
      // catalog/API-key snapshot is hydrating or temporarily unavailable.
      // Clearing it here made navigation and New chat show an older/default
      // model and could make Send fail before the catalog arrived. Leave the
      // durable selection intact; it becomes selectable again as soon as its
      // catalog entry is restored.
      return;
    }
    appStorage.setItem(CHAT_MODEL_SELECTION_STORAGE_KEY, nextSelection);
    setStoredModelSettings(previous => ({ ...previous, chatModelSelection: nextSelection }));
    onModelSelectionChange?.(nextSelection);
    emitModelSettingsUpdate({ type: 'model-selection-reconciled', chatModelSelection: nextSelection });
  }, [isModelLocked, modelOptions, activeModelSelection, modelSelectionScope, onModelSelectionChange]);
  const controlPopoutVerticalClass = 'bottom-[calc(100%+8px)]';
  const selectorPopoutVerticalClass = isNewChatHome ? 'top-[calc(100%+10px)]' : 'bottom-[calc(100%+10px)]';
  const selectorMenuOffset = 8;
  const agentMenuX = `calc(-50% + ${ agentMenuXOffset }px)`;
  const modelMenuX = `calc(-50% + ${ modelMenuXOffset }px)`;
  const pillPopoutVerticalClass = isEmptyHome ? 'bottom-full mb-2' : 'bottom-[calc(100%+72px)] mb-0';
  const slashMenuVisible = !!slashTrigger && !slashPanel && liveState === 'idle';
  const thinkingMenuOption = allModelOptions.find(option => option.optionKey === thinkingMenuModelKey) || null;
  const thinkingMenuOptions = getThinkingLevelOptions(thinkingMenuOption);
  const thinkingMenuSelectedId = getEffectiveThinkingLevel(thinkingMenuOption);
  const contextUsageBreakdown = (contextUsage?.breakdownSource === 'serialized_payload' || contextUsage?.breakdown) && contextUsage?.breakdown
    ? normalizeContextUsageBreakdown(contextUsage.breakdown, contextUsage.usedTokens)
    : null;
  const contextUsageRows = contextUsageBreakdown
    ? CONTEXT_USAGE_CATEGORIES
        .filter(category => category.key !== 'providerOverhead')
        .map(category => ({
          ...category,
          label: category.key === 'skills'
            ? 'Loaded skills'
            : category.key === 'subagentDefinitions' ? 'Subagent definitions' : category.label,
          tokens: contextUsageBreakdown[category.key],
        }))
    : [];
  const dockPositionClass = isEmptyHome
    ? 'top-[45%] -translate-y-1/2'
    : `eterx-chat-input-dock-active top-auto bottom-0 ${isCompressed ? 'pb-4 pt-8' : 'pb-5 pt-10'} bg-[linear-gradient(180deg,rgba(15,15,15,0)_0%,#0F0F0F_32%,#0F0F0F_100%)]`;
  const surfaceRadiusClass = isLiveActive
    ? inputValue.includes('\n') || inputValue.length > 55 ? 'rounded-[22px]' : 'rounded-full'
    : composerRadius;
  const surfacePaddingClass = isLiveActive ? 'p-1' : isCompressed ? 'pt-2 pb-2' : 'pt-2.5 pb-2';
  const surfaceBorderClass = 'border border-transparent';

  return (
    <div ref={composerDockRef} className={`eterx-chat-input-dock absolute left-0 right-0 z-30 flex w-full flex-col items-center ${dockPositionClass} ${inputSidePadding}`}
      data-home={isEmptyHome ? 'true' : 'false'}
      data-compressed={isCompressed ? 'true' : 'false'}
      onDragStart={handleComposerDragStart}
    >
        {showScrollBottom && traceLogsLength > 0 && !isEmptyHome && !showModelMenu && !showAgentMenu && !showContextUsagePanel && !slashMenuVisible && !slashPanel && (
          <button
            type="button"
            aria-label="Jump to latest message"
            onClick={onScrollToBottom}
            style={{ top: 'calc(var(--eterx-composer-top-padding, 0px) - 36px)' }}
            className="eterx-composer-scroll-latest absolute z-[70] flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-[#252525]/95 text-white/70 shadow-none backdrop-blur-xl transition-colors hover:bg-[#333333] hover:text-white cursor-pointer"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        )}

      {traceLogsLength === 0 && !isThinking && liveState === 'idle' && (
          <div
            className={`absolute bottom-full left-1/2 -translate-x-1/2 flex flex-col items-center w-full pointer-events-none ${ isCompressed ? 'mb-4 max-w-[460px]' : 'mb-6 max-w-[660px]' }`}
          >
            <div className={`flex items-center ${ isCompressed ? 'gap-3' : 'gap-5'}`}>
              <div
                className={`${ isCompressed ? 'h-[44px] w-[44px]' : 'h-[56px] w-[56px]' } shrink-0 relative group cursor-pointer pointer-events-auto transition-all duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-105`}
                onMouseEnter={() => {
                  setLogoHoverText(logoHoverPhrases[Math.floor(Math.random() * logoHoverPhrases.length)]);
                  setIsLogoHovered(true);
                }}
                onMouseLeave={() => setIsLogoHovered(false)}
              >
                <AgentFace
                  size="welcome"
                  mode="idle"
                  interactive
                  ariaLabel="EterX agent face"
                  className="transition-transform duration-500 ease-out group-hover:scale-110"
                />
                <AnimatePresence>
                  {isLogoHovered && (
                    <motion.div
                      initial={{ opacity: 0, y: 12, x: -32, scale: 0.9, filter: "blur(4px)" }}
                      animate={{ opacity: 1, y: 0, x: -32, scale: 1, filter: "blur(0px)" }}
                      exit={{ opacity: 0, y: 8, x: -32, scale: 0.95, filter: "blur(2px)" }}
                      transition={{ type: "spring", stiffness: 300, damping: 25 }}
                      className="eterx-composer-popout absolute bottom-[120%] left-1/2 whitespace-nowrap bg-[#111111]/60 backdrop-blur-[24px] px-4 py-2.5 rounded-[14px] shadow-none border border-white/10 z-50 pointer-events-none origin-[32px_bottom] flex items-center justify-center"
                    >
                      {/* Glass tail using rotated square placed behind */}
                      <div className="eterx-composer-popout-caret absolute -bottom-[5px] left-[26px] w-[12px] h-[12px] bg-[#111111]/60 backdrop-blur-[24px] border-b border-r border-white/10 rotate-45 rounded-[2px] shadow-none -z-10"></div>

                      <span className="eterx-logo-popout-text text-[13px] font-medium tracking-wide text-transparent bg-clip-text bg-gradient-to-b from-white via-white/90 to-white/50 drop-shadow-none">
                        {logoHoverText}
                      </span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              <h1 className={`eterx-home-greeting select-none font-sans tracking-tight leading-[1.2] pb-1 font-medium text-[var(--foreground)] bg-transparent shadow-none border-none ${ isCompressed ? 'max-w-[360px] truncate text-[30px]' : 'text-[44px] whitespace-nowrap'}`}>
                {greeting}
              </h1>
            </div>
          </div>
      )}

      {!isEmptyHome && queuedFollowUps.length > 0 && (
        <div
          role="region"
          aria-label="Queued follow-ups"
          className="eterx-queued-followup-rail pointer-events-auto mb-1.5 w-full max-w-full"
          style={{ width: 'var(--eterx-composer-actual-width, var(--eterx-composer-max, 680px))' }}
        >
          <div className="w-full">
            <div className="flex max-h-[180px] flex-col items-end gap-2 overflow-y-auto overscroll-contain px-0.5 pb-0.5 eterx-scrollbar">
              {queuedFollowUps.map(message => {
                const attachmentCount = message.attachments?.length || message.attachmentCount || 0;
                const fallbackLabel = `${ attachmentCount } attachment${ attachmentCount === 1 ? '' : 's' }`;
                const queueActionKey = `${message.chatId || activeComposerChatKey}:${message.id}`;
                const isSending = sendingQueuedFollowUpIds.has(queueActionKey);
                const isPending = message.deliveryState === 'pending';
                const actionLabel = message.deliveryState === 'rejected' || message.deliveryState === 'uncertain'
                  ? 'Retry' : isThinking ? message.rendererOwned ? 'Send next' : 'Steer' : 'Send now';
                return (
                  <div key={message.id} className="group/pending flex max-w-[90%] min-w-0 shrink-0 items-center gap-2 rounded-[20px] bg-[#202020] px-3.5 py-2.5 text-[13px] leading-5 text-[var(--foreground)]">
                    <div className="min-w-0 flex-1">
                      {message.text && <div className="whitespace-pre-wrap break-words">{message.text}</div>}
                      {message.attachments?.length
                        ? <QueuedMessageAttachments attachments={message.attachments} media={chatMedia} />
                        : attachmentCount > 0 && <span className="text-xs text-[var(--muted-foreground)]">{fallbackLabel}</span>}
                      {message.deliveryState && <div role="status" className="mt-1 text-[11px] text-[var(--muted-foreground)]">
                        {isPending ? 'Queuing…' : message.deliveryState === 'uncertain' ? 'Waiting for confirmation…' : 'Not sent. Retry when ready.'}
                      </div>}
                    </div>
                    <button
                      type="button"
                      disabled={!onSendQueuedFollowUp || isSending || isPending}
                      onClick={async () => {
                        if (!onSendQueuedFollowUp || isSending) return;
                        if (!beginQueueAction(queueActionKey)) return;
                        try {
                          const sent = await onSendQueuedFollowUp(message);
                          if (sent === false) showComposerNotice('Message was not sent', 'The queued message is still available. Try again.');
                        } catch {
                          showComposerNotice('Could not send queued message', 'Please try again.');
                        } finally {
                          finishQueueAction(queueActionKey);
                        }
                      }}
                      className="flex h-8 shrink-0 items-center justify-center gap-1 rounded-full px-2 text-[11px] text-white/65 transition-colors hover:bg-white/[0.08] hover:text-white/90 disabled:cursor-default disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
                      aria-label={`${actionLabel} queued message`}
                      aria-busy={isSending || isPending}
                      title={actionLabel === 'Steer' ? 'Send this message to the active agent' : actionLabel}
                    >
                      {isSending || isPending ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/25 border-t-white/80" /> : <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2.05} />}
                      <span>{actionLabel}</span>
                    </button>
                    <button
                      type="button"
                      disabled={!onRemoveQueuedFollowUp}
                      onClick={async () => {
                        if (!onRemoveQueuedFollowUp) return;
                        const removalKey = `${queueActionKey}:remove`;
                        if (!beginQueueAction(removalKey)) return;
                        try {
                          const removed = await onRemoveQueuedFollowUp(message.id, message.chatId);
                          if (removed === false) showComposerNotice('Could not remove queued message', 'The removal was not confirmed. Please try again.');
                        } catch {
                          showComposerNotice('Could not remove queued message', 'Please try again.');
                        } finally {
                          finishQueueAction(removalKey);
                        }
                      }}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/50 transition-colors hover:bg-white/[0.08] hover:text-white/80 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
                      aria-label="Remove queued follow-up"
                      title="Remove"
                    >
                      <X className="h-3.5 w-3.5" strokeWidth={2} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div
        ref={composerShellRef}
        className={`eterx-composer-shell w-full ${ shellMaxWidth } flex flex-col pointer-events-auto relative`}
         style={!isCompressed ? { width: '100%' } : undefined}
          data-compressed={isCompressed ? 'true' : undefined}
          data-composer-controls={showComposerControls ? undefined : 'hidden'}
         data-new-chat={isNewChatHome ? 'true' : undefined}
         data-status-rail={isNewChatHome || runLocation !== 'local' ? 'true' : undefined}
         data-task-tracker={taskTracker?.steps?.length ? 'true' : undefined}
         data-agent-builder={isAgentBuilder ? 'true' : undefined}
         data-typing={hasPromptText ? 'true' : undefined}
         onDragStart={handleComposerDragStart}
      >


        <TaskTrackerDock
          tracker={taskTracker}
          isThinking={isThinking}
          isCompressed={isCompressed}
        />

        <AnimatePresence>
          {showContextUsagePanel && contextUsage && contextUsage.contextWindow > 0 && (() => {
            const safeUsedTokens = Math.max(0, Math.round(contextUsage.usedTokens));
            const safeContextWindow = Math.max(1, Math.round(contextUsage.contextWindow));
            const utilization = Math.max(0, Math.min(100, (safeUsedTokens / safeContextWindow) * 100));
            const remainingTokens = Math.max(0, safeContextWindow - safeUsedTokens);
            const compaction = contextUsage.compaction;
            const compactionCancelled = compaction?.phase === 'failed'
              && /cancelled|canceled|stopped by user/i.test(compaction.summary || '');
            const compactionTitle = compaction?.phase === 'failed'
              ? compactionCancelled ? 'Context compaction stopped' : 'Failed to compact'
              : compaction?.phase === 'compacted'
                ? ''
                : compaction?.phase === 'retrying'
                  ? 'Retrying compaction'
                  : compaction?.phase === 'compacting' ? 'Compacting context' : '';
            return (
              <motion.section
                ref={contextUsagePanelRef}
                role="dialog"
                aria-label="Context usage details"
                initial={{ opacity: 0, y: 8, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 6, scale: 0.99 }}
                transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
                className="eterx-context-usage-panel absolute bottom-[calc(100%+10px)] left-0 z-[85] w-full max-h-[min(520px,calc(100vh-170px))] overflow-y-auto eterx-scrollbar rounded-[16px] border px-3.5 pb-3 pt-2 shadow-2xl"
                onClick={event => event.stopPropagation()}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="eterx-context-panel-title text-[14px] font-semibold tracking-[-0.01em]">Context usage</h2>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className="eterx-context-panel-meta text-[10.5px] font-medium tabular-nums"
                      title={contextUsage.cacheStatus?.detail || 'No provider cache measurement is available.'}
                      aria-label={contextUsage.cacheStatus?.detail || 'No provider cache measurement is available.'}
                    >
                      {contextUsage.cacheStatus?.label || 'Cache unreported'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowContextUsagePanel(false)}
                      aria-label="Close context usage"
                      className="eterx-context-panel-close flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors"
                    >
                      <X className="h-4 w-4" strokeWidth={1.9} />
                    </button>
                  </div>
                </div>

                <div className="mt-3 flex items-end justify-between gap-4 tabular-nums">
                  <div>
                    <div className="eterx-context-panel-percent text-[13px] font-semibold">{Math.round(utilization)}% used</div>
                    <div className="eterx-context-panel-meta mt-0.5 text-[10.5px] font-medium">
                      {contextUsage.awaitingSelectedModelMeasurement
                        ? 'Awaiting selected model count'
                        : <>{contextUsage.isEstimated ? '~' : ''}{formatContextUsageTokenCount(remainingTokens)} tokens available</>}
                    </div>
                  </div>
                  <div className="eterx-context-panel-total text-right text-[12px] font-medium">
                    {contextUsage.isEstimated ? '~' : ''}{formatContextUsageTokenCount(safeUsedTokens)} / {formatExactContextTokens(safeContextWindow)} tokens
                  </div>
                </div>
                {contextUsage.contextLimitNote && (
                  <div className="eterx-context-panel-meta mt-1 text-[10.5px] leading-4">
                    {contextUsage.contextLimitNote}
                  </div>
                )}
                {contextUsage.measurementNote && (
                  <div className="eterx-context-panel-meta mt-1 text-[10.5px] leading-4">
                    {contextUsage.measurementNote}
                  </div>
                )}

                <div className="eterx-context-panel-track mt-2 h-1.5 overflow-hidden rounded-full">
                  <div className="flex h-full min-w-[2px] overflow-hidden rounded-full" style={{ width: `${utilization}%` }}>
                    {contextUsageRows.length > 0
                      ? contextUsageRows.filter(row => row.tokens > 0).map(row => (
                          <span
                            key={row.key}
                            className="h-full min-w-[2px] border-r border-black/20 last:border-r-0"
                            style={{ backgroundColor: row.color, width: `${(row.tokens / Math.max(1, safeUsedTokens)) * 100}%` }}
                            aria-hidden="true"
                          />
                        ))
                      : <span className="eterx-context-panel-unclassified h-full w-full" aria-hidden="true" />}
                  </div>
                </div>

                {contextUsageRows.length > 0 && (
                  <>
                    <h3 className="eterx-context-panel-title mt-3 text-[11px] font-semibold">Request composition</h3>
                    <div className={`eterx-context-panel-rows mt-1 grid ${isCompressed ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'} gap-x-6 gap-y-0.5`}>
                      {contextUsageRows.map(row => (
                        <div key={row.key} className="eterx-context-panel-row flex h-7 items-center gap-2.5 rounded-[8px] px-1.5">
                          <span className="h-3 w-3 shrink-0 rounded-[3px]" style={{ backgroundColor: row.color }} aria-hidden="true" />
                          <span className="eterx-context-panel-row-label min-w-0 flex-1 truncate text-[12px] font-medium">{row.label}</span>
                          <span className="eterx-context-panel-row-value shrink-0 text-[12px] font-medium tabular-nums">
                            {formatContextUsageTokenCount(row.tokens, { prefixTilde: row.tokens > 0 })}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {compaction && compaction.phase !== 'compacted' && compactionTitle && (
                  <div
                    className="eterx-context-compaction-state mt-3 rounded-[10px] px-2.5 py-2"
                    data-phase={compaction.phase}
                    role={compaction.phase === 'failed' ? 'alert' : 'status'}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="eterx-context-compaction-title text-[11px] font-semibold">{compactionTitle}</span>
                      {compaction.timestamp && (
                        <span className="eterx-context-panel-meta shrink-0 text-[9.5px] font-medium">
                          {new Date(compaction.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                    <div className="eterx-context-compaction-copy mt-0.5 text-[10px] leading-[14px]">
                      {compaction.phase === 'failed' ? (
                        <>
                          Full context preserved.
                          {!compactionCancelled && compaction.nextAttemptTokens ? ` Next attempt at ${formatContextTokenCount(compaction.nextAttemptTokens)} tokens.` : ''}
                          {!compactionCancelled && compaction.nextContextWindow ? ` Chat budget raised to ${formatContextTokenCount(compaction.nextContextWindow)}.` : ''}
                        </>
                      ) : (
                        <>
                          Preserving continuity from {compaction.beforeTokensEstimated === false ? '' : 'approximately '}{formatContextTokenCount(compaction.beforeTokens || 0)} tokens.
                        </>
                      )}
                    </div>
                  </div>
                )}
              </motion.section>
            );
          })()}
        </AnimatePresence>

        {slashPanel === 'agents' && (
          <div
            className="eterx-composer-popout absolute bottom-[calc(100%+12px)] left-1/2 z-40 w-[min(320px,calc(100vw-64px))] select-none overflow-hidden rounded-[20px] border border-white/[0.10] bg-[#1C1C1C] p-1.5 text-[#F2F0EC] shadow-none"
            style={{ transform: `translate(calc(-50% + ${ slashPanelOffset.x }px), ${ slashPanelOffset.y }px)` }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="flex h-9 cursor-grab touch-none items-center justify-between gap-3 px-2 active:cursor-grabbing"
              onPointerDown={startSlashPanelDrag}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="truncate text-[13px] font-semibold tracking-normal text-white">Agents</span>
              </span>
              <button
                type="button"
                onClick={closeSlashPanel}
                aria-label="Close agents"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/52 transition-colors hover:bg-white/[0.06] hover:text-white"
              >
                <X className="h-3.5 w-3.5" strokeWidth={2.4} />
              </button>
            </div>

            <div className="max-h-[214px] overflow-y-auto pr-1 pb-1 eterx-scrollbar">
              {storedAgents.filter(agent => agent.isSetup !== false).length > 0 ? (
                storedAgents.filter(agent => agent.isSetup !== false).map(agent => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => openAgentFromPanel(agent.id)}
                    className={`group flex min-h-[40px] w-full items-center rounded-[13px] px-3 py-2 text-left transition-colors duration-75 ${ selectedAgent === agent.id ? 'bg-white/[0.08]' : 'hover:bg-white/[0.055]' }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-[#F2F0EC] group-hover:text-white">
                        {agent.name}
                      </span>
                      <span className="block truncate text-[11px] font-medium text-[#8C8984]">
                        {agent.accessType || agent.description || 'Custom agent'}
                      </span>
                    </span>
                    {selectedAgent === agent.id && <Check className="ml-2 h-3.5 w-3.5 shrink-0 text-white" strokeWidth={2.4} />}
                  </button>
                ))
              ) : (
                <button
                  type="button"
                  onClick={openAgentRoomFromPanel}
                  className="flex min-h-[112px] w-full flex-col items-center justify-center rounded-[22px] px-5 text-center transition-colors duration-75 hover:bg-white/[0.04]"
                >
                  <span className="text-[14px] font-semibold text-[#F2F0EC]">No agents found</span>
                  <span className="mt-1.5 text-[12px] font-medium leading-5 text-[#8C8984]">
                    Go to agent room and create your own agent
                  </span>
                </button>
              )}
            </div>
          </div>
        )}

        {slashPanel === 'goal' && (
          <div
            className="eterx-composer-popout absolute bottom-[calc(100%+12px)] left-1/2 z-40 w-[min(420px,calc(100vw-64px))] select-none overflow-hidden rounded-[22px] border border-white/[0.10] bg-[#242424] p-2 text-[#F2F0EC] shadow-none"
            style={{ transform: `translate(calc(-50% + ${ slashPanelOffset.x }px), ${ slashPanelOffset.y }px)` }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="flex min-h-10 cursor-grab touch-none items-center justify-between gap-2 px-2 active:cursor-grabbing"
              onPointerDown={startSlashPanelDrag}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <img src="/icons/agent-ui/commands/goal.svg" alt="" aria-hidden="true" className="eterx-agent-ui-icon h-4 w-4 shrink-0 object-contain" />
                <span className="truncate text-[14px] font-semibold tracking-normal text-white">Goal</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={closeSlashPanel}
                  className="rounded-full px-2.5 py-1.5 text-[12px] font-semibold text-[#A7A39E] transition-colors hover:bg-white/[0.055] hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={establishGoal}
                  className="rounded-full bg-[#F2EFEA] px-3 py-1.5 text-[12px] font-semibold text-black transition-colors hover:bg-white"
                >
                  Establish
                </button>
              </span>
            </div>

            <div className="px-1 pb-1 pt-1">
              <textarea
                ref={goalTextareaRef}
                value={goalDraft}
                onChange={(event) => setGoalDraft(event.target.value)}
                onInput={syncGoalTextareaHeight}
                placeholder="Write the goal for this chat..."
                className="block min-h-[86px] w-full resize-none rounded-[16px] border border-white/[0.08] bg-[#1D1D1D] px-3.5 py-3 text-[13.5px] font-medium leading-5 text-[#F2F0EC] outline-none placeholder:text-[#716E69] focus:border-white/[0.16] eterx-scrollbar select-text"
              />
            </div>
          </div>
        )}

        {(slashPanel === 'usage' || slashPanel === 'workspace') && (
          <div className={`eterx-context-usage-panel absolute bottom-[calc(100%+8px)] left-1/2 z-[85] -translate-x-1/2 w-[calc(100%-32px)] ${isCompressed ? 'max-w-[488px]' : 'max-w-[752px]'} overflow-y-auto rounded-[20px] border p-4`} role="dialog" aria-label={slashPanel === 'usage' ? 'Chat usage' : 'Workspace'} onKeyDown={event => { if (event.key === 'Escape') closeSlashPanel(); }}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="eterx-context-panel-title text-sm font-semibold">{slashPanel === 'usage' ? 'Chat usage' : 'Workspace'}</h2>
              <button type="button" autoFocus onClick={closeSlashPanel} aria-label="Close panel" className="grid h-7 w-7 place-items-center rounded-lg opacity-70 hover:bg-white/10 hover:opacity-100"><X className="h-4 w-4" /></button>
            </div>
            {slashPanel === 'usage' ? <>
              <p className="text-xs opacity-75">Total token use in <span className="font-medium text-[var(--context-panel-title,inherit)]">{chatTitle}</span></p>
              <div className="my-2 text-3xl font-semibold tabular-nums tracking-tight">{chatUsage?.receipts ? chatUsage.total.toLocaleString() : 'Not reported yet'}</div>
              <dl className="mt-4 space-y-3 text-[12.5px]">
                {[
                  ['Total input tokens', chatUsage?.inputMeasured ? chatUsage.input.toLocaleString() : 'Not reported'],
                  ['Total output tokens', chatUsage?.outputMeasured ? chatUsage.output.toLocaleString() : 'Not reported'],
                  ['Cache hit rate', chatUsage?.cacheHitRate == null ? 'Not reported' : `${(chatUsage.cacheHitRate * 100).toFixed(1)}%`],
                  ['Latest request cache hit', chatUsage?.latestCacheHitRate == null ? 'Not reported' : `${(chatUsage.latestCacheHitRate * 100).toFixed(1)}%`],
                  ['Latest request agent', chatUsage?.latestCacheOwner || 'Not reported'],
                  ['Latest request model', chatUsage?.latestCacheModel || 'Not reported'],
                  ['Cache reporting coverage', chatUsage?.cacheReportingCoverage == null ? 'Not reported' : `${(chatUsage.cacheReportingCoverage * 100).toFixed(1)}% of input tokens`],
                  ['Current context (active agent)', contextUsage && contextUsage.contextWindow > 0 ? `${contextUsage.usedTokens.toLocaleString()} / ${contextUsage.contextWindow.toLocaleString()} tokens` : 'Not measured yet'],
                ].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-4"><dt className="opacity-65">{label}</dt><dd className="text-right font-medium tabular-nums">{value}</dd></div>)}
              </dl>
              {chatUsage?.latestCacheExplanation && <p className="mt-3 text-xs leading-relaxed opacity-75">{chatUsage.latestCacheExplanation}</p>}
              <p className="mt-3 text-[11px] leading-relaxed opacity-60">Cache hit rate is cached input tokens divided by input tokens on requests with provider cache reporting. Chat totals include worker requests; a selected worker shows its own usage. Cold and post-compaction requests remain included. Cache writes and output tokens do not count as hits; missing reports are excluded. Current context belongs to the active agent.</p>
            </> : <>
              <div className="flex items-center gap-3 rounded-xl bg-white/[0.04] p-3">
                <Folder className="h-5 w-5 shrink-0 opacity-65" />
                <div className="min-w-0 flex-1"><p className="text-[13px] font-medium">{activeWorkspacePath ? workspaceName : 'No workspace selected'}</p><p className="mt-1 break-all text-xs opacity-60">{activeWorkspacePath || 'Choose a folder for this chat.'}</p></div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button type="button" disabled={executionContextLocked} onClick={() => { closeSlashPanel(); setOpenStatusMenu('project'); }} className="rounded-lg bg-white/[0.06] px-3 py-2 text-xs font-medium text-[var(--context-panel-title,inherit)] hover:bg-white/10 disabled:opacity-40">{activeWorkspacePath ? 'Change workspace' : 'Select workspace'}</button>
                <button type="button" disabled={executionContextLocked} onClick={() => { void handleSelectFolderDialog(); }} className="rounded-lg px-3 py-2 text-xs font-medium hover:bg-white/10 disabled:opacity-40">Browse folders</button>
                {activeWorkspacePath && <button type="button" disabled={executionContextLocked} onClick={() => handleWorkspacePathChange(null)} className="ml-auto rounded-lg px-3 py-2 text-xs opacity-60 hover:bg-white/10 disabled:opacity-40">Remove</button>}
              </div>
              {executionContextLocked && <p className="mt-3 text-xs opacity-60">Workspace changes are available when this run finishes.</p>}
            </>}
          </div>
        )}

        {slashMenuVisible && (
          <div
            className={`eterx-composer-popout eterx-slash-menu absolute bottom-[calc(100%+8px)] left-1/2 z-[85] -translate-x-1/2 w-[calc(100%-32px)] ${ isCompressed ? 'max-w-[488px]' : 'max-w-[752px]' } select-none overflow-hidden rounded-[20px] border border-white/[0.10] bg-[#242424] p-1.5 text-[#F2F0EC] shadow-none`}
            role="listbox"
            aria-label="Slash commands"
          >
            <div className="max-h-[270px] overflow-y-auto eterx-scrollbar">
              {filteredSlashCommands.length > 0 ? (
                filteredSlashCommands.map((command, index) => {
                  const active = index === slashActiveIndex;
                  const isModeCommand = command.action === 'plan' || command.action === 'swarm';
                  const modeEnabled = command.action === 'plan' ? planModeActive : command.action === 'swarm' ? swarmModeActive : false;
                  return (
                    <button
                      key={command.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      aria-label={isModeCommand ? `${command.label}, ${modeEnabled ? 'enabled' : 'disabled'}` : undefined}
                      data-mode-enabled={modeEnabled ? 'true' : undefined}
                      disabled={Boolean((command.action === 'plan' || command.action === 'swarm') && pendingModes.has(`${activeChatId || 'new_chat'}:${command.action}`))}
                      onMouseEnter={() => setSlashActiveIndex(index)}
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => selectSlashCommand(command)}
                      className={`${isModeCommand ? 'eterx-composer-mode-option' : ''} flex min-h-[32px] w-full items-center gap-2 rounded-[9px] px-2.5 py-1 text-left transition-colors duration-75 ${ active ? 'bg-white/[0.07] text-white' : 'text-[#D7D4CE] hover:bg-white/[0.045] hover:text-white' }`}
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                        {command.action === 'compact' ? <BookText className={`h-4 w-4 ${compacting ? 'animate-pulse' : ''}`} />
                          : command.action === 'plan' ? <Lightbulb className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                          : command.action === 'swarm' ? <Network className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                          : command.action === 'usage' ? <BarChart3 className="h-4 w-4" />
                          : command.action === 'workspace' ? <FolderCog className="h-4 w-4" /> : <Route className="h-4 w-4" />}
                      </span>
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="shrink-0 text-[12px] font-medium tracking-normal">
                          {command.label}
                        </span>
                        <span className="eterx-composer-command-description min-w-0 truncate text-[11.5px] font-normal text-[#8C8984]">
                          {command.action === 'compact' && compacting ? 'Compacting context…' : modeEnabled ? 'Enabled · click to turn off' : command.description}
                        </span>
                      </span>
                      {modeEnabled && <Check className="eterx-composer-mode-check h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
                    </button>
                  );
                })
              ) : (
                <div className="flex min-h-[42px] items-center rounded-[12px] px-2.5 text-[13px] font-medium text-[#8C8984]">
                  No matching commands
                </div>
              )}
            </div>
          </div>
        )}

        <motion.div
          animate={liveAnimateState}
          transition={liveTransition}
          className={`eterx-composer-surface eterx-composer-main relative flex w-full flex-col overflow-visible bg-[#202020] backdrop-blur-[28px] shadow-none transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${surfaceRadiusClass} ${surfacePaddingClass} ${surfaceBorderClass} ${isNewChatHome ? 'eterx-new-chat-composer-surface' : ''}`}
          style={!isCompressed ? { width: '100%', alignSelf: 'center' } : undefined}
          data-live={isLiveActive ? 'true' : undefined}
        >
          <input type="file" multiple ref={fileInputRef} onChange={handleFileSelect} className="hidden" />

          {/* ═══ LIVE MODE HEADER BANNER (Disabled per user request) ═══ */}
          {false && isLiveActive && (
            <div className="mx-3 mt-0 mb-0 px-3 py-1 flex items-center justify-between bg-white/[0.04] backdrop-blur-xl border border-white/[0.08] rounded-full shadow-none">
              <div className="flex items-center gap-1">
                <Tooltip text={isSpeakerMuted ? "Unmute system voice" : "Mute system voice"} side="top">
                  <button type="button" onClick={onToggleSpeakerMute} className={`w-7 h-7 flex items-center justify-center rounded-full transition-all ${isSpeakerMuted ? 'text-rose-400 bg-rose-500/20' : 'text-white/80 hover:bg-white/10'}`}>
                    {isSpeakerMuted ? <PremiumVolumeX className="w-3.5 h-3.5" /> : <PremiumVolume2 className="w-3.5 h-3.5" />}
                  </button>
                </Tooltip>
                <Tooltip text={isMicMuted ? "Unmute microphone" : "Mute microphone"} side="top">
                  <button type="button" onClick={onToggleMicMute} className={`w-7 h-7 flex items-center justify-center rounded-full transition-all ${isMicMuted ? 'text-rose-400 bg-rose-500/20' : 'text-white/80 hover:bg-white/10'}`}>
                    {isMicMuted ? <PremiumMicOff className="w-3.5 h-3.5" /> : <PremiumMic className="w-3.5 h-3.5" />}
                  </button>
                </Tooltip>
              </div>

              <div className="flex items-center gap-2.5">
                <div className="flex items-center gap-[3px] h-[18px]">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="w-[3px] rounded-full bg-white transition-all duration-100 ease-out" style={{ height: `${Math.max(8, Math.min(18, 8 + (liveMicVolume / 100) * 10))}px` }} />
                  ))}
                </div>
                {liveActiveTool && <Shimmer className="text-[11.5px] font-medium text-[#C8C1B8]">{(liveActiveTool ?? '').replace(/_/g, ' ')}...</Shimmer>}
              </div>

              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 text-[10.5px] font-semibold tracking-wide text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 rounded-full">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  LIVE
                </span>
                <button type="button" onClick={onLiveStop} className="w-6 h-6 flex items-center justify-center rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/30 hover:bg-rose-500/40 transition-all">
                  <CircleSlash className="w-3 h-3" />
                </button>
              </div>
            </div>
          )}

          {/* ═══ AUTO-EXPANDING LIVE TYPING BAR ═══ */}
          {isLiveActive && (
            <div className="flex items-end justify-between w-full min-h-[44px] max-h-[160px] pl-4 pr-1.5 py-1 relative transition-all duration-200">
              {liveState === 'connecting' ? (
                <div className="flex-1 flex items-center min-h-[42px] py-2 pl-1 select-none">
                  <Shimmer className="text-[14.5px] font-medium text-[#C8C1B8]">Connecting...</Shimmer>
                </div>
              ) : (
                <ComposerTextarea
                  ownerKey={`${ activeComposerChatKey }:live`}
                  revision={composerDraftRevision}
                  onValueCommitted={syncLiveTextareaHeight}
                  value={inputValue}
                  onValueChange={handleComposerValueChange}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (latestInputValueRef.current.trim()) {
                        submitPrompt();
                      }
                    }
                  }}
                  placeholder="Type..."
                  rows={1}
                  className="flex-1 bg-transparent border-0 outline-none ring-0 text-[14.5px] text-[#F0F0F0] placeholder:text-[#6B6964] font-normal pr-3 resize-none min-h-[26px] max-h-[150px] leading-[1.45] py-2 overflow-y-auto eterx-scrollbar scrollbar-no-buttons"
                  style={{ caretColor: '#F0F0F0' }}
                />
              )}
              <button
                type="button"
                onClick={submitPrompt}
                disabled={liveState === 'connecting' || !hasPromptText}
                aria-label="Send live message"
                className={`eterx-live-message-send-button w-[34px] h-[34px] mb-0.5 shrink-0 flex items-center justify-center rounded-full transition-all duration-200 ${
                  liveState !== 'connecting' && hasPromptText
                    ? 'bg-[#F2EFEA] text-black hover:bg-white shadow-none active:scale-95 cursor-pointer'
                    : 'bg-[#2D2D2D] text-[#8C8984] hover:bg-[#333333] hover:text-white cursor-pointer opacity-70'
                }`}
              >
                <PremiumSend className="w-[16px] h-[16px]" strokeWidth={2.1} />
              </button>
            </div>
          )}

          {!isLiveActive && (<div className={`eterx-composer-input-row ${ isCompressed ? 'px-4' : 'px-5' } pb-1 min-h-[42px] flex items-center relative z-10`}>
            <AnimatePresence mode="wait">
              {/* ═══ GEMINI LIVE — Modern Centered Visualization ═══ */}
              {false ? (
                <motion.div
                  key="live-overlay"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4 }}
                  className="flex items-center justify-center w-full min-h-[44px] relative"
                >
                  {/* Left Side: Mute Controls (Ultra-Aesthetic Circular Pill) */}
                  <div className="absolute left-1.5 top-1/2 -translate-y-1/2 flex items-center p-1 bg-white/[0.03] backdrop-blur-[24px] border border-white/[0.08] rounded-full shadow-none transition-all duration-300 hover:bg-white/[0.05] hover:border-white/[0.12] gap-0.5">
                    <Tooltip text={isSpeakerMuted ? "Unmute system voice" : "Mute system voice"} side="top">
                      <button
                        onClick={onToggleSpeakerMute}
                        className={`w-[34px] h-[34px] flex items-center justify-center rounded-full transition-all duration-300 group ${ isSpeakerMuted ? 'text-[#E2765A] bg-[#E2765A]/15' : 'text-[#F4F4F4] hover:bg-white/10 hover:text-white active:scale-95' }`}
                      >
                        {isSpeakerMuted ? (
                          <PremiumVolumeX className="w-[16px] h-[16px] transition-transform duration-300 group-hover:scale-110" strokeWidth={2.2} />
                        ) : (
                          <PremiumVolume2 className="w-[16px] h-[16px] transition-transform duration-300 group-hover:scale-110" strokeWidth={2.2} />
                        )}
                      </button>
                    </Tooltip>

                    <Tooltip text={isMicMuted ? "Unmute your microphone" : "Mute your microphone"} side="top">
                      <button
                        onClick={onToggleMicMute}
                        className={`w-[34px] h-[34px] flex items-center justify-center rounded-full transition-all duration-300 group ${ isMicMuted ? 'text-[#E2765A] bg-[#E2765A]/15' : 'text-[#F4F4F4] hover:bg-white/10 hover:text-white active:scale-95' }`}
                      >
                        {isMicMuted ? (
                          <PremiumMicOff className="w-[17px] h-[17px] transition-transform duration-300 group-hover:scale-110" strokeWidth={2.2} />
                        ) : (
                          <PremiumMic className="w-[17px] h-[17px] transition-transform duration-300 group-hover:scale-110" strokeWidth={2.2} />
                        )}
                      </button>
                    </Tooltip>
                  </div>

                  <motion.div
                    className="flex items-center gap-6"
                    animate={{ x: liveActiveTool ? -20 : 0 }}
                    transition={{ type: 'spring', bounce: 0.15, duration: 0.6 }}
                  >
                    {/* Centered Frequency Bar Visualizer — Lag Free & Modern */}
                    <div className="flex items-center justify-center gap-[4px] h-[36px]">
                      {Array.from({ length: 4 }).map((_, i) => {
                        const isSpeaking = liveState === 'speaking';
                        const isConnecting = liveState === 'connecting';
                        const isListening = liveState === 'listening';

                        let h = 14;
                        let baseVol = 0;

                        if (isSpeaking) {
                          if (Array.isArray(liveModelVolume)) {
                            baseVol = (liveModelVolume[i] / 100) * 24;
                            h = 14 + baseVol;
                          } else {
                            const multiplier = [0.6, 1.0, 0.85, 0.5][i];
                            baseVol = ((liveModelVolume as number) / 100) * 22;
                            h = 14 + (baseVol * multiplier);
                          }
                        } else if (isListening) {
                          const multiplier = [0.6, 1.0, 0.9, 0.7][i];
                          baseVol = (liveMicVolume / 100) * 22;
                          h = 14 + (baseVol * multiplier);
                        }

                        const targetHeight = Math.max(14, Math.min(36, h));

                        return (
                          <div
                            key={i}
                            className={`w-[14px] rounded-full bg-white transition-all duration-100 ease-out ${
                              isConnecting ? 'animate-pulse' : ''
                            }`}
                            style={{
                              height: `${targetHeight}px`,
                              opacity: isConnecting ? 0.75 : 1,
                              transform: `scaleY(${isConnecting ? 1 + (i % 2) * 0.2 : 1})`,
                            }}
                          />
                        );
                      })}
                    </div>

                    {/* Removed center tool indicator to keep bars perfectly centered */}
                  </motion.div>

                  {/* Absolute positioned End Button and Status Text on the right */}
                  <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-3">
                    <AnimatePresence mode="wait">
                      {liveState === 'connecting' ? (
                        <motion.span
                          key="connecting"
                          initial={{ opacity: 0, x: 10 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="text-[12.5px] text-[#F0F0F0] tracking-wide font-medium whitespace-nowrap"
                        >
                          <Shimmer className="text-[12.5px] font-medium text-[#C8C1B8]">Connecting...</Shimmer>
                        </motion.span>
                      ) : liveActiveTool ? (
                        <motion.span
                          key="tool"
                          initial={{ opacity: 0, x: 10 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -10 }}
                          transition={{ duration: 0.3 }}
                          className="text-[12.5px] text-[#F0F0F0] tracking-wide font-medium whitespace-nowrap"
                        >
                          <Shimmer className="text-[12.5px] font-medium text-[#C8C1B8]">
                            {(() => {
                              switch (liveActiveTool) {
                                case 'web_search': return 'Searching Web...';
                                case 'run_terminal_command': return 'Working...';
                                case 'store_chat_memory': return 'Updating Memory...';
                                case 'read_chat_memory': return 'Reading Memory...';
                                case 'change_voice': return 'Configuring Voice...';
                                case 'get_system_time': return 'Checking Time...';
                                case 'end_call': return 'Ending Call...';
                                default: return (liveActiveTool ?? '').replace(/_/g, ' ') + '...';
                              }
                            })()}
                          </Shimmer>
                        </motion.span>
                      ) : null}
                    </AnimatePresence>

                    {/* Dark live control */}
                    <button
                      type="button"
                      onClick={onLiveStop}
                      aria-label="End live conversation"
                      className="w-[42px] h-[42px] flex items-center justify-center rounded-full bg-black/40 backdrop-blur-md border border-white/10 transition-all duration-300 hover:bg-black/60 hover:scale-105 hover:border-white/20 active:scale-95 shadow-none group"
                    >
                      <span className="h-[13px] w-[13px] rounded-[3px] bg-[#E8E6E3] opacity-95 transition-all duration-200 ease-out group-hover:scale-[0.92] group-hover:bg-white" aria-hidden="true" />
                    </button>
                  </div>
                </motion.div>
              ) : (
                <div className="eterx-composer-textarea-wrap relative w-full">
                  {!chatMode && (planModeActive || swarmModeActive) && (
                    <div className="eterx-composer-mode-row" role="group" aria-label="Active modes">
                      {([{ kind: 'plan', active: planModeActive, label: 'Plan', tooltip: 'Create a plan', Icon: Lightbulb, toggle: setPlanModeActive },
                        { kind: 'swarm', active: swarmModeActive, label: 'Swarm', tooltip: 'Coordinate a team', Icon: Network, toggle: setSwarmModeActive }] as const).filter(mode => mode.active).map(mode => {
                        const pending = pendingModes.has(`${activeChatId || 'new_chat'}:${mode.kind}`);
                        return (
                          <Tooltip key={mode.kind} text={mode.tooltip} side="top" delay={350} contentHeight={30} cardClassName="eterx-composer-mode-tooltip" showOnFocus>
                            <span className="eterx-composer-mode-chip" data-mode={mode.kind} data-pending={pending ? 'true' : undefined} aria-busy={pending}>
                              <mode.Icon className="eterx-composer-mode-icon" strokeWidth={1.75} aria-hidden="true" />
                              <span className="eterx-composer-mode-label">{mode.label}</span>
                              <button
                                type="button"
                                aria-label={`Turn off ${mode.label} mode`}
                                disabled={pending}
                                onClick={() => {
                                  mode.toggle(false);
                                  window.requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
                                }}
                                className="eterx-composer-mode-remove"
                              >
                                <X className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                              </button>
                            </span>
                          </Tooltip>
                        );
                      })}
                    </div>
                  )}

                  {/* Folders, Files, and Attachments rendered in a unified upper row */}
                  {(pinnedItems.length > 0 || attachments.length > 0) && (
                    <div className="eterx-pinned-items flex flex-nowrap items-start gap-3 px-0 pt-0.5 pb-3 bg-transparent min-w-0 overflow-x-auto w-full [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                      {/* Pinned Folders and Files */}
                      {pinnedItems.map((item) => {
                        const isFolder = item.type === 'folder';
                        const iconSrc = isFolder
                          ? '/icons/agent-ui/folder.png'
                          : (item.systemIcon || getFileIconPath(item.path));

                        const getDisplayType = () => {
                          if (isFolder) return 'Folder';
                          const ext = item.path.split('.').pop()?.toLowerCase();
                          if (!ext || ext === item.path.toLowerCase()) return 'File';

                          switch (ext) {
                            case 'ts': return 'TypeScript';
                            case 'tsx': return 'React';
                            case 'js': return 'JavaScript';
                            case 'jsx': return 'React';
                            case 'py': return 'Python';
                            case 'md': return 'Markdown';
                            case 'json': return 'JSON';
                            case 'html': return 'HTML';
                            case 'css': return 'CSS';
                            case 'yaml':
                            case 'yml': return 'YAML';
                            case 'pdf': return 'PDF';
                            case 'png':
                            case 'jpg':
                            case 'jpeg':
                            case 'gif':
                            case 'webp': return 'Image';
                            case 'sh':
                            case 'bash':
                            case 'zsh': return 'Shell';
                            default: return ext.toUpperCase();
                          }
                        };

                        const displayType = getDisplayType();
                        const ext = item.path.split('.').pop()?.toLowerCase();
                        const isPreviewable = !isFolder && (ext === 'pdf' || ext === 'docx');

                        return (
                          <div
                            key={item.id}
                            onClick={() => {
                              if (isPreviewable) {
                                window.dispatchEvent(new CustomEvent('eterx-preview-document', { detail: { filePath: item.path } }));
                              }
                            }}
                            className={`relative flex items-center bg-[#1E1E1E]/92 border border-white/[0.08] rounded-[12px] pl-1.5 pr-8 py-1.5 min-w-[125px] max-w-[200px] shadow-none select-none h-[42px] shrink-0 ${ isPreviewable ? 'cursor-pointer' : 'cursor-default' }`}
                          >
                            {/* Left Icon Square Box */}
                            <div className="w-[30px] h-[30px] rounded-[8px] bg-black/40 border border-white/[0.05] flex items-center justify-center shrink-0">
                              <img
                                src={iconSrc}
                                alt=""
                                className="w-[18px] h-[18px] object-contain shrink-0"
                              />
                            </div>

                            {/* Title and Subtitle */}
                            <div className="flex flex-col ml-2 overflow-hidden justify-center min-w-0">
                              <span className="text-[11.5px] font-semibold text-white/90 truncate leading-snug">
                                {item.name}
                              </span>
                              <span className="text-[9px] font-bold text-neutral-400 tracking-wider leading-none mt-0.5">
                                {displayType}
                              </span>
                            </div>

                            {/* Delete button (top right) */}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setPinnedItems(pinnedItems.filter(i => i.id !== item.id));
                              }}
                              className="absolute top-1.5 right-1.5 w-[16px] h-[16px] flex items-center justify-center rounded-full bg-white text-black transition-colors hover:bg-neutral-200 shrink-0"
                            >
                              <X className="w-2.5 h-2.5" strokeWidth={3.5} />
                            </button>
                          </div>
                        );
                      })}

                      {/* File Attachments (Uploaded) */}
                      {attachments.map((att, i) => {
                        const mimeType = String(att.mimeType || att.file?.type || '').toLowerCase();
                        const isImage = mimeType.startsWith('image/');
                        const isVideo = mimeType.startsWith('video/');
                        const displayName = att.name || att.file.name || 'file';
                        const extension = displayName.split('.').pop()?.toUpperCase() || 'FILE';
                        const isPreparing = att.uploadStatus === 'uploading';
                        const isErrored = att.uploadStatus === 'error';

                        if (isImage || isVideo) {
                          return (
                            <div
                              key={att.id || i}
                              className={`relative w-24 h-24 shrink-0 overflow-hidden rounded-2xl bg-black/40 border ${ isErrored ? 'border-[#E2765A]/45' : 'border-white/[0.08]' } shadow-none select-none group ${ isPreparing ? 'cursor-default' : 'cursor-pointer' }`}
                              onClick={() => {
                                if (isPreparing) return;
                                if (att.preview) {
                                  setZoomScale(1);
                                  setPanPos({ x: 0, y: 0 });
                                  if (isVideo) setPreviewVideo({ url: att.preview, name: displayName });
                                  else { setPreviewImages([att.preview]); setPreviewImage(att.preview); setZoomScale(1); setPanPos({ x: 0, y: 0 }); }
                                }
                              }}
                            >
                              {isVideo ? (
                                <video src={att.preview} muted playsInline preload="metadata" className={`h-full w-full object-cover ${ isErrored ? 'opacity-40 grayscale' : 'opacity-100' }`} />
                              ) : (
                                <img
                                  src={att.preview}
                                  alt={displayName}
                                  className={`w-full h-full object-cover ${ isErrored ? 'opacity-40 grayscale' : 'opacity-100' }`}
                                />
                              )}
                              {isPreparing && (
                                <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl bg-black/25">
                                  <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white/85" />
                                </div>
                              )}
                              {isErrored && (
                                <div className="absolute inset-0 flex items-center justify-center bg-black/28 rounded-2xl">
                                  <AlertCircle className="w-6 h-6 text-[#F0B6A7]" strokeWidth={2.2} />
                                </div>
                              )}
                              {/* Delete button (top right) */}
                              <button
                                type="button"
                                aria-label={`Remove ${displayName}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeAttachment(i);
                                }}
                                className="absolute top-1.5 right-1.5 w-5 h-5 flex items-center justify-center rounded-full bg-white text-black transition-colors hover:bg-neutral-200 shrink-0 shadow-none z-10"
                              >
                                <X className="w-2.5 h-2.5" strokeWidth={3} />
                              </button>
                            </div>
                          );
                        }

                        // For non-image files, render the card layout
                        const iconSrc = getFileIconPath(displayName);
                        const isTextPreviewable = att.mimeType === PASTED_TEXT_MIME || ['TXT', 'MD', 'CSV', 'TSV', 'JSON', 'LOG'].includes(extension);
                        const isDocPreviewable = (extension === 'PDF' || extension === 'DOCX' || isTextPreviewable) && !isPreparing && !isErrored;

                        return (
                          <div
                            key={att.id || i}
                            onClick={() => {
                              if (isDocPreviewable) {
                                const targetPath = att.localPath || att.name;
                                window.dispatchEvent(new CustomEvent(isTextPreviewable ? 'eterx-preview-text' : 'eterx-preview-document', { detail: { filePath: targetPath, file: att.file, name: displayName } }));
                              }
                            }}
                            role="button"
                            tabIndex={isDocPreviewable ? 0 : -1}
                            aria-label={`Preview ${displayName}`}
                            aria-disabled={!isDocPreviewable}
                            onKeyDown={event => {
                              if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                                event.preventDefault(); event.currentTarget.click();
                              }
                            }}
                            className={`relative flex items-center bg-[var(--muted)] text-[var(--foreground)] border ${ isErrored ? 'border-[#E2765A]/45' : 'border-[var(--border)]' } rounded-[12px] pl-1.5 pr-8 py-1.5 min-w-[125px] max-w-[260px] shadow-none select-none h-[42px] shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current ${ isDocPreviewable ? 'cursor-pointer' : 'cursor-default' }`}
                          >
                            {/* Left Icon Square Box */}
                            <div className="w-[30px] h-[30px] rounded-[8px] bg-black/40 border border-white/[0.05] flex items-center justify-center shrink-0 overflow-hidden relative">
                              <img
                                src={iconSrc}
                                alt=""
                                className="w-[18px] h-[18px] object-contain shrink-0"
                              />
                              {isPreparing && (
                                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20">
                                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/25 border-t-white/80" />
                                </div>
                              )}
                              {isErrored && (
                                <div className="absolute inset-0 flex items-center justify-center bg-black/28">
                                  <AlertCircle className="w-4 h-4 text-[#F0B6A7]" strokeWidth={2.2} />
                                </div>
                              )}
                            </div>

                            {/* Title and Subtitle */}
                            <div className="flex flex-col ml-2 overflow-hidden justify-center min-w-0">
                              <span className="text-[11.5px] font-semibold text-white/90 truncate leading-snug">
                                {att.mimeType === PASTED_TEXT_MIME ? 'Pasted text' : displayName}
                              </span>
                              <span className={`text-[9px] font-bold tracking-wider leading-none mt-0.5 ${ isErrored ? 'text-[#F0B6A7]' : 'text-neutral-400' }`}>
                                {isErrored ? 'Failed' : isPreparing ? <Shimmer>Preparing</Shimmer> : att.mimeType === PASTED_TEXT_MIME ? `${formatAttachmentSize(att.size || att.file?.size || 0)} · Read on demand` : extension}
                              </span>
                            </div>

                            {/* Delete button (top right) */}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                removeAttachment(i);
                              }}
                              className="absolute top-1.5 right-1.5 w-[16px] h-[16px] flex items-center justify-center rounded-full bg-white text-black transition-colors hover:bg-neutral-200 shrink-0"
                            >
                              <X className="w-2.5 h-2.5" strokeWidth={3.5} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="relative min-w-0">
                    {isOverflowing && !isAtTop && (
                      <div className="eterx-composer-overflow-fade-top pointer-events-none absolute inset-x-0 top-0 z-10 h-4 bg-gradient-to-b from-[#2F2F2F] via-[#2F2F2F]/90 to-transparent transition-opacity duration-200" />
                    )}
                    <ComposerTextarea
                      ref={textareaRef}
                      onValueCommitted={scheduleTextareaOverflowSync}
                      key="textarea"
                      ownerKey={activeComposerChatKey}
                      revision={composerDraftRevision}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      value={inputValue}
                      onValueChange={handleComposerValueChange}
                      onKeyDown={handleTextareaKeyDown}
                      onSelect={(e) => syncSlashTrigger(latestInputValueRef.current, e.currentTarget.selectionStart)}
                      onClick={(e) => {
                        e.stopPropagation();
                        syncSlashTrigger(latestInputValueRef.current, e.currentTarget.selectionStart);
                      }}
                      onPaste={handlePaste}
                      data-eterx-paste-handler="controlled"
                      onDragOver={handleDragOver}
                      onDrop={handleDrop}
                      onScroll={handleTextareaScroll}
                      placeholder={resolvedComposerPlaceholder}
                      spellCheck={false}
                      aria-label={resolvedComposerPlaceholder}
                      className={`eterx-composer-textarea w-full appearance-none border-0 bg-transparent shadow-none outline-none ring-0 text-[14.5px] font-normal text-[#F0F0F0] placeholder:text-[#8B8984] focus:border-0 focus:outline-none focus:ring-0 min-h-[26px] max-h-[400px] resize-none leading-[1.45] selection:bg-white/15 transition-colors duration-200 relative z-0 py-1 scrollbar-no-buttons ${ isOverflowing ? 'overflow-y-auto eterx-scrollbar pr-2' : 'overflow-hidden' }`}
                      style={{
                        ['--eterx-composer-textarea-max' as any]: `${ textareaMaxHeight }px`,
                        height: hasPromptText ? undefined : textareaMinHeight,
                        caretColor: 'var(--composer-menu-ink)',
                        maxHeight: textareaMaxHeight,
                        outline: 'none',
                        boxShadow: 'none',
                        border: 0,
                      }}
                    />
                    {isOverflowing && !isAtBottom && (
                      <div className="eterx-composer-overflow-fade-bottom pointer-events-none absolute inset-x-0 bottom-0 z-10 h-4 bg-gradient-to-t from-[#242424] via-[#242424]/90 to-transparent transition-opacity duration-200" />
                    )}
                  </div>
                </div>
              )}
            </AnimatePresence>
          </div>)}

          {!isLiveActive && (
          <div className={`eterx-chat-controls ${ isCompressed ? 'px-2.5' : 'px-3.5' } mt-0 relative z-10 transition-all duration-300`}>
            <div className="eterx-chat-controls-left">
              <Tooltip text="Attach images, PDFs, Office files, code, audio, or video" side="top">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Attach files"
                  className={`${inputControlButton} eterx-composer-attach-button`}
                >
                  <div className={inputControlSheen} />
                  <PremiumPlus className="eterx-composer-control-icon w-[20px] h-[20px] text-white" strokeWidth={1.85} />
                </button>
              </Tooltip>
              <div className="relative eterx-pin-control hidden">
                <Tooltip text="Pin folder or files" side="top" disabled={showPinMenu}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenPillDrop(null);
                      setShowPinMenu(prev => !prev);
                    }}
                    className={`${ inputControlButton } ${ showPinMenu || pinnedItems.length > 0 ? '!bg-[#333333] !border-transparent !text-white' : '' }`}
                    aria-label="Pin folder or files"
                    aria-haspopup="menu"
                    aria-expanded={showPinMenu}
                  >
                    <div className={inputControlSheen} />
                    <img
                      src="/icons/agent-ui/pin.png"
                      alt="Pin"
                      className={`eterx-composer-control-icon h-[23px] w-[23px] object-contain opacity-100 invert brightness-200 ${ showPinMenu ? '-rotate-12' : '' }`}
                    />
                  </button>
                </Tooltip>

                {showPinMenu && (
                  <AdaptiveMenu preferredSide="top"
                    style={{ transform: 'translateX(-50%)' }}
                    className={`eterx-composer-popout eterx-pin-popout absolute ${ controlPopoutVerticalClass } left-1/2 z-[120] flex w-[148px] origin-bottom flex-col rounded-[14px] border border-white/[0.105] bg-[#1A1A1A]/95 backdrop-blur-2xl p-[4px] shadow-none`}
                  >
                    <span className="eterx-composer-popout-caret pointer-events-none absolute -bottom-[4px] left-1/2 z-0 h-[9px] w-[9px] -translate-x-1/2 rotate-45 border-b border-r border-white/[0.105] bg-[#1A1A1A]/95" />
                    <button type="button" onClick={handlePinFolder} className="group/menu relative z-10 flex h-[38px] w-full items-center gap-[8px] rounded-[10px] px-[8px] text-left text-white transition-all duration-150 hover:bg-white/[0.095] hover:shadow-none focus-visible:bg-white/[0.095] focus-visible:outline-none active:scale-[0.99]">
                      <span className="flex h-[23px] w-[23px] shrink-0 items-center justify-center text-white transition-colors">
                        <PinFolderIcon className="h-[22px] w-[22px]" />
                      </span>
                      <span className="min-w-0 text-[13px] font-semibold leading-none tracking-[-0.004em]">
                        Folder
                      </span>
                    </button>
                    <div className="relative z-10 mx-[8px] h-px bg-white/[0.05]" />
                    <button type="button" onClick={handlePinFiles} className="group/menu relative z-10 flex h-[38px] w-full items-center gap-[8px] rounded-[10px] px-[8px] text-left text-white transition-all duration-150 hover:bg-white/[0.095] hover:shadow-none focus-visible:bg-white/[0.095] focus-visible:outline-none active:scale-[0.99]">
                      <span className="flex h-[23px] w-[23px] shrink-0 items-center justify-center text-white transition-colors">
                        <PinFileIcon className="h-[22px] w-[22px]" />
                      </span>
                      <span className="min-w-0 text-[13px] font-semibold leading-none tracking-[-0.004em]">
                        Files
                      </span>
                    </button>
                  </AdaptiveMenu>
                )}
              </div>
            </div>

            <div className="eterx-chat-controls-right flex items-center gap-1.5">
              {/* Context usage indicator: show the current chat's configured window and usage. */}
              {contextUsage && Number.isFinite(contextUsage.contextWindow) && contextUsage.contextWindow > 0 && (() => {
                const safeContextWindow = Math.max(1, Math.round(contextUsage!.contextWindow));
                const safeUsedTokens = Math.max(0, Math.round(
                  Number.isFinite(contextUsage!.usedTokens) ? contextUsage!.usedTokens : 0,
                ));
                const exactUtilization = Math.max(0, Math.min(100, (safeUsedTokens / safeContextWindow) * 100));
                const usedPercent = Math.round(exactUtilization);
                const leftPercent = Math.max(0, 100 - usedPercent);
                return (
                <Tooltip
                  side="top"
                  delay={0}
                  contentWidth={170}
                  contentHeight={68}
                  cardClassName="eterx-context-usage-tooltip !rounded-[10px]"
                  content={(
                    <div className="flex h-[68px] w-full flex-col items-center justify-center px-2 text-center">
                      <div className="eterx-context-usage-label text-[11px] font-medium leading-[14px]">
                        {contextUsage!.awaitingSelectedModelMeasurement ? 'Awaiting model count:' : contextUsage!.isEstimated ? 'Estimated context:' : 'Context window:'}
                      </div>
                      <div className="eterx-context-usage-primary mt-px whitespace-nowrap text-[12.5px] font-semibold leading-4">
                        {usedPercent}% used <span className="eterx-context-usage-muted font-medium">({leftPercent}% left)</span>
                      </div>
                      <div className="eterx-context-usage-secondary whitespace-nowrap text-[11.5px] font-medium leading-[15px] tabular-nums">
                        {formatContextTokenCount(safeUsedTokens)} / {formatContextTokenCount(safeContextWindow)} tokens used
                      </div>
                    </div>
                  )}
                >
                  <button
                    ref={contextUsageTriggerRef}
                    type="button"
                    onClick={() => setShowContextUsagePanel(open => !open)}
                    className="eterx-context-usage-trigger relative grid h-[38px] w-[24px] shrink-0 place-items-center"
                    aria-label={`${contextUsage!.isEstimated ? 'Estimated context' : 'Context window'} ${usedPercent} percent used`}
                    aria-expanded={showContextUsagePanel}
                    aria-haspopup="dialog"
                    data-open={showContextUsagePanel ? 'true' : undefined}
                    data-phase={contextUsage!.compaction?.phase}
                    aria-busy={contextUsage!.compaction?.phase === 'compacting' || contextUsage!.compaction?.phase === 'retrying'}
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4 -rotate-90" aria-hidden="true">
                      <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="2.4" opacity="0.22" />
                      <circle
                        cx="12"
                        cy="12"
                        r="7.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        pathLength="100"
                        strokeDasharray={`${exactUtilization} 100`}
                      />
                    </svg>
                  </button>
                </Tooltip>
                );
              })()}
              {!isAgentBuilder && !executionContextLocked && (
                <div ref={agentSelectorRef} className="eterx-agent-selector relative min-w-0">
                  <button
                    type="button"
                    disabled={executionContextLocked}
                    onClick={() => {
                      if (executionContextLocked) return;
                      setShowAgentMenu(prev => !prev);
                    }}
                    aria-disabled={executionContextLocked}
                    aria-haspopup="dialog"
                    aria-expanded={showAgentMenu}
                    aria-label={`Agent: ${activeAgentDisplay.label}`}
                    title={executionContextLocked ? `${activeAgentDisplay.label} is the active worker for this tab` : isThinking ? 'Changes apply to the next turn; the active run keeps its agent.' : activeAgentDisplay.description}
                    data-open={showAgentMenu ? 'true' : undefined}
                    className={`eterx-agent-button ${ isCompressed ? 'max-w-[160px] pl-2.5 pr-1' : 'max-w-[232px] pl-3.5 pr-1' } flex h-[38px] w-full min-w-0 items-center justify-between gap-1.5 rounded-full border border-transparent bg-[#2D2D2D] text-[#F4F4F4] transition-colors duration-150 hover:bg-[#333333] hover:text-white hover:border-transparent active:bg-[#333333] group ${ executionContextLocked ? 'cursor-default' : 'cursor-pointer' } ${ showAgentMenu ? '!bg-[#333333] !border-transparent !text-white' : '' }`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="eterx-agent-ui-icon eterx-selector-icon h-4 w-4 shrink-0 opacity-90 transition-opacity duration-200 text-[#F4F4F4]"
                        >
                          <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-4.16Z" />
                          <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-4.16Z" />
                        </svg>
                        <span className="eterx-selector-label min-w-0 truncate text-[14px] font-semibold tracking-normal transition-colors text-[#F4F4F4]">
                          {activeAgentDisplay.label}
                        </span>
                    </span>
                    <span className="eterx-selector-chevron-wrapper flex h-4 w-4 shrink-0 items-center justify-center text-[#BDB8B0] transition-colors duration-100 ease-out">
                      <ChevronDown className={`eterx-selector-chevron h-3.5 w-3.5 shrink-0 transition-transform duration-150 text-[#F0F0F0] group-hover:text-white ${ showAgentMenu ? 'rotate-180' : '' }`} strokeWidth={2.1} />
                    </span>
                  </button>

                  <AnimatePresence initial={false}>
                  {showAgentMenu && !executionContextLocked && (
                    <AdaptiveMenu key="agent-selector-menu" motionProps={{
                      initial: { opacity: 0, clipPath: 'inset(5px 0px 5px 0px round 16px)' },
                      animate: { opacity: 1, clipPath: 'inset(0px round 16px)' },
                      exit: { opacity: 0, clipPath: 'inset(3px 0px 3px 0px round 16px)' },
                      transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] },
                    }} preferredSide={isNewChatHome ? 'bottom' : 'top'} allowFlip={!isNewChatHome} heightLimit={380}
                      style={{ transform: `translateX(${ agentMenuX })`, width: codingDetails ? 320 : 224, maxHeight: agentMenuMaxHeight }}
                      className={`eterx-composer-popout eterx-agent-popout absolute ${ selectorPopoutVerticalClass } left-1/2 z-[130] flex overflow-hidden max-w-[calc(100vw-32px)] flex-col rounded-xl border border-white/[0.08] bg-[#1E1E1E]/95 backdrop-blur-xl p-1.5 text-[#F4F1EA] shadow-none`}
                      role="dialog"
                       aria-label="Chat and agent selection"
                    >
                      <div className="eterx-agent-menu-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
                      {codingDetails ? <CodingModeDetails modeId={codingDetails} onBack={closeCodingDetails} /> : <>
                      {/* Header */}
                      <div className="eterx-menu-heading px-2.5 pt-1 pb-1.5">
                        <span className="text-[11.5px] font-semibold text-white/50">Agents</span>
                      </div>

                      {/* Chat (direct conversation path) */}
                      <button
                        type="button"
                        onClick={() => {
                          onAgentChange?.(null, 'Chat', true);
                          setShowAgentMenu(false);
                        }}
                        aria-pressed={chatMode}
                        className={`flex w-full items-center gap-2.5 px-2.5 py-1.5 rounded-md text-left transition-all duration-150 ${ chatMode
                          ? 'bg-white/[0.08] text-white font-medium shadow-none'
                          : 'text-[#E8E6E3] hover:bg-white/[0.05] active:bg-white/[0.12]'
                          }`}
                      >
                        <span className="text-[12px] font-normal truncate flex-1">Chat</span>
                        {chatMode && <Check className="h-3.5 w-3.5 shrink-0 text-white" strokeWidth={2.05} />}
                      </button>

                      {/* General (default) */}
                      <button
                        type="button"
                        onClick={() => {
                          onAgentChange?.(null, 'General', false);
                          setShowAgentMenu(false);
                        }}
                        aria-pressed={!chatMode && !selectedAgent}
                        className={`eterx-agent-option flex w-full items-center gap-2.5 px-2.5 py-1.5 rounded-[11px] text-left transition-all duration-150 ${ !chatMode && !selectedAgent
                          ? 'bg-white/[0.08] text-white font-medium shadow-none'
                          : 'text-[#E8E6E3] hover:bg-white/[0.055] active:bg-white/[0.12]'
                          }`}
                      >
                        <span className="text-[12px] font-normal truncate flex-1">General</span>
                        {!chatMode && !selectedAgent && <Check className="h-3.5 w-3.5 shrink-0 text-white" strokeWidth={2.05} />}
                      </button>

                      {CODING_MODES.map(mode => {
                        const selected = !chatMode && getCodingMode(selectedAgent)?.id === mode.id;
                        return <div key={mode.id} data-selected={selected} className={`eterx-coding-menu-row eterx-agent-option flex items-center rounded-[11px] ${selected ? 'bg-white/[0.08]' : ''}`}>
                          <button type="button" onClick={() => {
                            onAgentChange?.(mode.id, mode.label, false);
                            setShowAgentMenu(false);
                          }} aria-pressed={selected}
                            className="flex min-w-0 flex-1 items-center gap-2 rounded-[11px] px-2.5 py-1.5 text-left hover:bg-white/[0.055] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]">
                            <span className="flex-1 text-[12px] font-normal">{mode.label}</span>
                            {selected && <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2.05} aria-hidden="true" />}
                          </button>
                          <button type="button" aria-label={`View ${mode.label} tools`} aria-haspopup="dialog" data-coding-info={mode.id}
                            onClick={() => setCodingDetails(mode.id)}
                            className="mr-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg opacity-60 hover:bg-white/[0.055] hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]">
                            <Info className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
                          </button>
                        </div>;
                      })}

                      {/* Autonomous is a sidecar proxy toggle, not a primary agent
                          selection. Chat stays direct even when this is enabled. */}
                      <div className="eterx-agent-menu-divider mx-2 mt-1 mb-1 h-px bg-white/[0.08]" aria-hidden="true" />
                      <button
                        type="button"
                        onClick={() => {
                          void onProxyToggle();
                        }}
                        aria-pressed={proxyEnabled}
                        title={proxyEnabled ? 'Turn Autonomous off and hide Proxy' : 'Turn Autonomous on and show Proxy'}
                        className={`eterx-agent-option eterx-autonomous-agent-option group flex w-full items-center gap-2.5 rounded-[11px] px-2.5 py-1.5 text-left transition-all duration-150 ${ proxyEnabled
                          ? 'bg-white/[0.08] text-white font-medium shadow-none'
                          : 'text-[#E8E6E3] hover:bg-white/[0.055] active:bg-white/[0.12]'
                          }`}
                      >
                        <span className="min-w-0 flex-1 text-[12px] font-medium">Autonomous</span>
                        <span
                          className={`eterx-autonomous-checkbox grid h-4 w-4 shrink-0 place-items-center rounded-[6px] border transition-all duration-150 ${ proxyEnabled
                            ? 'border-white/70 bg-white text-[#202020]'
                            : 'border-white/25 bg-white/[0.04] text-transparent group-hover:border-white/45'
                            }`}
                          aria-hidden="true"
                        >
                          <Check className="h-2.5 w-2.5" strokeWidth={2.5} />
                        </span>
                        <span className="sr-only">{proxyEnabled ? 'Disable' : 'Enable'} Autonomous proxy</span>
                      </button>

                      {/* Separator + custom agents from agent room */}
                      {availableAgents.length > 0 && (
                        <>
                          <div className="eterx-agent-menu-divider mx-2 my-1 h-[1px] bg-white/[0.06]" />
                          <div className="eterx-menu-section-heading px-2.5 py-0.5">
                            <span className="text-[11px] font-semibold text-white/50">Custom agents</span>
                          </div>
                          <div>
                            {availableAgents.map(agent => (
                              <button
                                key={agent.agentId}
                                type="button"
                                onClick={() => {
                                  onAgentChange?.(agent.agentId, agent.name, false);
                                  setShowAgentMenu(false);
                                }}
                                aria-pressed={selectedAgent === agent.agentId}
                                className={`flex min-h-[32px] w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-all duration-150 ${ selectedAgent === agent.agentId
                                  ? 'bg-white/[0.08] text-white font-medium shadow-none'
                                  : 'text-[#E8E6E3] hover:bg-white/[0.05] active:bg-white/[0.12]'
                                  }`}
                              >
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-[12px] font-normal">{agent.name}</span>
                                  {(agent.presentation?.category || agent.presentation?.description || agent.mission) && (
                                    <span className="eterx-agent-option-description block truncate text-[11px] font-normal leading-[1.4] text-white/60">
                                      {agent.presentation?.category || agent.presentation?.description || agent.mission}
                                    </span>
                                  )}
                                </span>
                                {selectedAgent === agent.agentId && <Check className="h-3.5 w-3.5 shrink-0 text-white" strokeWidth={2.05} />}
                              </button>
                            ))}
                          </div>
                        </>
                      )}

                      {/* Link to Agent Room */}
                      <div className="eterx-agent-menu-divider mx-2 my-1 h-[1px] bg-white/[0.06]" />
                      <button
                        onClick={() => {
                          setShowAgentMenu(false);
                          onOpenAgents?.();
                        }}
                        className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-[#8C8A88] hover:text-[#E8E6E3] hover:bg-white/[0.05] active:bg-white/[0.12] transition-all duration-150"
                      >
                        <span className="text-[11.5px] font-normal">Go to agent room</span>
                        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-[#8C8A88]" strokeWidth={1.8} />
                      </button>
                      </>}
                      </div>
                    </AdaptiveMenu>
                  )}
                  </AnimatePresence>
                </div>
              )}

              {/* The Agent Builder uses the same turn-scoped model selection as every
                  other agent chat. Keeping this control mounted lets a builder chat
                  switch provider/model immediately for its next turn. */}
              <div ref={modelSelectorRef} className="eterx-model-selector relative min-w-0">
                <button
                  type="button"
                  disabled={isModelLocked}
                  onClick={() => {
                    if (allModelOptions.length === 0) {
                      setShowModelMenu(false);
                      onOpenSettingsTab?.('api');
                      return;
                    }
                    setShowModelMenu(prev => !prev);
                    setModelSearch('');
                  }}
                  data-open={showModelMenu ? 'true' : undefined}
                  aria-expanded={showModelMenu}
                  aria-haspopup="dialog"
                  aria-label={isModelLocked ? 'Model selection is locked while the agent is running' : `Selected model: ${modelDisplayLabel}`}
                  title={modelDisplayLabel}
                  className={`eterx-model-button ${ isCompressed ? 'mr-0 max-w-[160px] pl-2.5 pr-1' : 'mr-1 pl-3.5 pr-1' } flex h-[38px] w-full min-w-0 items-center justify-between gap-1.5 rounded-full border border-transparent bg-[#2D2D2D] text-[#F4F4F4] transition-colors duration-150 hover:bg-[#333333] hover:text-white hover:border-transparent active:bg-[#333333] group cursor-pointer disabled:cursor-not-allowed disabled:opacity-55 ${ showModelMenu ? '!bg-[#333333] !border-transparent !text-white' : '' }`}
                >
                  <div className="flex min-w-0 items-center gap-1.5"
                    onWheel={event => {
                      const label = event.currentTarget;
                      if (event.ctrlKey || label.scrollWidth <= label.clientWidth) return;
                      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
                      label.scrollLeft += delta * (event.deltaMode === 1 ? 16 : 1);
                      event.stopPropagation();
                    }}>
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="eterx-agent-ui-icon eterx-selector-icon h-4 w-4 shrink-0 opacity-90 transition-opacity duration-200 text-[#F4F4F4]"
                      >
                        <path d="m12 3-10 5 10 5 10-5-10-5Z" />
                        <path d="m2 17 10 5 10-5" />
                        <path d="m2 12 10 5 10-5" />
                      </svg>
                      <span className="eterx-selector-label min-w-0 truncate text-[14px] font-semibold tracking-normal transition-colors">
                        {modelDisplayLabel}
                      </span>
                      {selectedThinkingLevel?.label && (
                        <span className="eterx-model-thinking-closed-label shrink-0 truncate text-[13px] font-medium leading-4">
                          {selectedThinkingLevel.label}
                        </span>
                      )}
                  </div>
                  <span className="eterx-selector-chevron-wrapper flex h-4 w-4 shrink-0 items-center justify-center text-[#BDB8B0] transition-colors duration-100 ease-out">
                    <ChevronDown className={`eterx-selector-chevron h-3.5 w-3.5 text-[#F0F0F0] transition-transform duration-150 group-hover:text-white ${ showModelMenu ? 'rotate-180' : '' }`} strokeWidth={2.1} />
                  </span>
                </button>

                <AnimatePresence initial={false}>
                {showModelMenu && (
                  <AdaptiveMenu key="model-selector-menu" motionProps={{
                    initial: { opacity: 0, clipPath: 'inset(5px 0px 5px 0px)', filter: 'blur(1px)' },
                    animate: { opacity: 1, clipPath: 'inset(0px)', filter: 'blur(0px)' },
                    exit: { opacity: 0, clipPath: 'inset(3px 0px 3px 0px)', filter: 'blur(1px)' },
                    transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] },
                  }} preferredSide={isNewChatHome ? 'bottom' : 'top'} allowFlip={!isNewChatHome}
                    style={{ transform: `translateX(${ modelMenuX })` }}
                    className={`eterx-composer-popout eterx-model-menu-popout absolute ${ selectorPopoutVerticalClass } left-1/2 z-[130] flex ${ isCompressed ? 'w-[248px]' : 'w-[286px]' } max-w-[calc(100vw-32px)] flex-col rounded-[20px] border border-white/[0.10] bg-[#202020] p-1.5 text-[#F4F1EA] shadow-none`}
                    role="dialog"
                    aria-label="Model and thinking settings"
                  >
                    <div className="eterx-model-menu-title">Model</div>
                    {(
                      <div className="eterx-model-search relative mb-1.5 shrink-0 px-0.5 pt-0.5">
                        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/45" />
                        <input
                          autoFocus
                          value={modelSearch}
                          onChange={event => {
                            setModelSearch(event.target.value);
                            if (modelListRef.current) modelListRef.current.scrollTop = 0;
                            setShowThinkingLevels(false);
                            setThinkingMenuPosition(null);
                          }}
                          onKeyDown={event => {
                            if (event.key === 'Escape') setShowModelMenu(false);
                          }}
                          onClick={event => event.stopPropagation()}
                          aria-label="Search models"
                          placeholder="Search models"
                          className="h-10 w-full rounded-[12px] border border-white/[0.10] bg-[#171717] pl-9 pr-3 text-[12.5px] font-medium text-[#F4F1EA] outline-none placeholder:text-white/35 focus:border-white/[0.22] focus:bg-[#191919]"
                        />
                      </div>
                    )}
                    <div
                      ref={modelListRef}
                      data-menu-scroll-region
                      className="eterx-model-menu-list eterx-scrollbar space-y-0.5"
                      onScroll={() => {
                        setShowThinkingLevels(false);
                        setThinkingMenuPosition(null);
                      }}
                    >
                      {groupModelsByProvider(allModelOptions.filter(option => {
                        const query = modelSearch.trim().toLowerCase();
                        return !query || `${option.label} ${MODEL_PROVIDER_LABEL[option.provider]} ${option.modelName}`.toLowerCase().includes(query);
                      })).map(group => (
                        <section key={group.provider} aria-label={(MODEL_PROVIDER_LABEL[group.provider] || group.provider)} className="eterx-model-provider-group">
                          <div className="eterx-model-provider-heading">{(MODEL_PROVIDER_LABEL[group.provider] || group.provider)}</div>
                          {group.models.map(option => {
                            const selected = option.optionKey === selectedModel?.optionKey;
                            const optionLabel = getModelOptionLabel(option);
                            const optionThinkingOptions = getThinkingLevelOptions(option);
                            const optionSelectedThinkingId = getEffectiveThinkingLevel(option);
                            const optionThinkingLabel =
                              optionThinkingOptions.find(item => item.id === optionSelectedThinkingId)?.label || null;
                            const thinkingMenuOpen = thinkingMenuModelKey === option.optionKey && showThinkingLevels;
                            return (
                              <div
                                key={option.optionKey}
                                className="eterx-model-option-row relative w-full"
                                data-thinking-open={thinkingMenuOpen ? 'true' : undefined}
                                onMouseEnter={(event) => {
                                  if (!optionThinkingOptions.length) return;
                                  openThinkingMenuForRow(option.optionKey, event.currentTarget, optionThinkingOptions.length);
                                }}
                                onMouseLeave={handleThinkingMouseLeave}
                                onFocus={(event) => {
                                  if (!optionThinkingOptions.length) return;
                                  openThinkingMenuForRow(option.optionKey, event.currentTarget, optionThinkingOptions.length);
                                }}
                              >
                                <button
                                  type="button"
                                  onClick={() => selectChatModelOption(option)}
                                  className={`group flex h-full w-full items-center gap-2 rounded-[9px] border px-2 py-1 text-left transition-colors duration-150 ${ selected ? 'border-white/[0.08] bg-white/[0.10] text-white font-medium shadow-none' : 'border-transparent text-[#E8E6E3] hover:bg-white/[0.055] active:bg-white/[0.10] font-normal' }`}
                                  aria-pressed={selected}
                                >
                                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${ selected ? 'bg-white/[0.10] text-white' : 'text-white/30' }`}>
                                    {selected && <Check className="h-3 w-3" strokeWidth={2.05} />}
                                  </span>
                                  <span className="flex min-w-0 flex-1 items-center gap-2">
                                    <span className="min-w-0 truncate text-[12.5px] font-semibold leading-4 tracking-normal">
                                      {optionLabel}
                                    </span>
                                    {optionThinkingLabel && (
                                      <span className="eterx-model-thinking-label shrink-0 truncate text-[11px] font-medium leading-4 text-white/48">
                                        {optionThinkingLabel}
                                      </span>
                                    )}
                                  </span>
                                  {optionThinkingOptions.length > 0 && (
                                    <span
                                      role="button"
                                      tabIndex={0}
                                      className={`eterx-model-thinking-trigger flex h-4 w-4 shrink-0 items-center justify-center rounded text-white/45 transition-colors duration-100 hover:text-white focus-visible:text-white focus-visible:outline-none ${ thinkingMenuOpen ? 'text-white' : '' }`}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        const row = (event.currentTarget as HTMLElement).closest('.eterx-model-option-row') as HTMLElement | null;
                                        if (row) openThinkingMenuForRow(option.optionKey, row, optionThinkingOptions.length);
                                      }}
                                      onKeyDown={(event) => {
                                        if (event.key !== 'Enter' && event.key !== ' ') return;
                                        event.preventDefault();
                                        event.stopPropagation();
                                        const row = (event.currentTarget as HTMLElement).closest('.eterx-model-option-row') as HTMLElement | null;
                                        if (row) openThinkingMenuForRow(option.optionKey, row, optionThinkingOptions.length);
                                      }}
                                      aria-label={`Choose thinking level for ${optionLabel}`}
                                      aria-haspopup="menu"
                                      aria-expanded={thinkingMenuOpen}
                                    >
                                      <ChevronRight className="h-3.5 w-3.5" strokeWidth={2.1} />
                                    </span>
                                  )}
                                </button>
                              </div>
                            );
                          })}
                        </section>
                      ))}
                      {allModelOptions.length > 0 && allModelOptions.filter(option => {
                        const query = modelSearch.trim().toLowerCase();
                        return !query || `${getModelOptionLabel(option)} ${MODEL_PROVIDER_LABEL[option.provider]} ${option.modelName}`.toLowerCase().includes(query);
                      }).length === 0 && (
                        <div className="px-2.5 py-4 text-center text-[11.5px] text-[#A3A19E]">
                          No matching models
                        </div>
                      )}
                      {allModelOptions.length === 0 && (
                        <div className="px-2.5 py-4 text-center text-[11.5px] text-[#A3A19E]">
                          Add an API key in Settings &gt; API, then choose a live model in Settings &gt; Models.
                        </div>
                      )}
                    </div>

                  </AdaptiveMenu>
                )}
                </AnimatePresence>
              </div>

              {showModelMenu && showThinkingLevels && thinkingMenuOption && thinkingMenuOptions.length > 0 && thinkingMenuPosition && typeof window !== 'undefined' && createPortal(
                <div
                  ref={thinkingMenuPortalRef}
                  className="eterx-model-thinking-popout eterx-composer-popout fixed z-[10000] overflow-hidden"
                  style={{ top: thinkingMenuPosition.top, left: thinkingMenuPosition.left, width: thinkingMenuPosition.width, maxHeight: thinkingMenuPosition.maxHeight, overflowY: 'auto', zIndex: 2147483000 }}
                  onMouseEnter={handleThinkingMouseEnter}
                  onMouseLeave={handleThinkingMouseLeave}
                  role="menu"
                  aria-label={`Thinking level for ${getModelOptionLabel(thinkingMenuOption)}`}
                >
                  {thinkingMenuOptions.map(thinkingOption => {
                    const thinkingSelected = thinkingOption.id === thinkingMenuSelectedId;
                    return (
                      <button
                        key={thinkingOption.id}
                        type="button"
                        onClick={() => {
                          handleModelThinkingChange(thinkingMenuOption, thinkingOption.id);
                          setThinkingMenuModelKey(null);
                          setThinkingMenuPosition(null);
                          setShowThinkingLevels(false);
                        }}
                        className={`flex items-center gap-2 text-left transition-colors duration-100 ${ thinkingSelected ? 'bg-white/[0.10] text-white' : 'text-[#F4F1EA] hover:bg-white/[0.055]' }`}
                        role="menuitemradio"
                        aria-checked={thinkingSelected}
                      >
                        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                          {thinkingOption.label}
                        </span>
                        {thinkingSelected && <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2.1} />}
                      </button>
                    );
                  })}
                </div>,
                document.body,
              )}

              {showVoiceControls && <DictationButton phase={dictationPhase} onClick={toggleSpeech} />}
              {false && <Tooltip text={isLiveActive ? "End Live Conversation" : hasBackgroundLiveSession ? "Open Live Conversation" : isThinking ? "Wait for this run to finish" : "Start Live Conversation"} side="top">
                <button
                  onClick={isLiveActive ? onLiveStop : onLiveStart}
                  disabled={isNetworkPaused || (!hasBackgroundLiveSession && liveState === 'idle' && isThinking)}
                  className={`eterx-control-button eterx-composer-live-button w-[38px] h-[38px] shrink-0 flex items-center justify-center rounded-full border border-transparent bg-[#2D2D2D] text-white shadow-none transition-all duration-150 active:bg-[#333333] cursor-pointer group relative overflow-hidden hover:bg-[#333333] hover:border-transparent hover:text-white disabled:cursor-not-allowed disabled:opacity-45 ${ hasAnyLiveSession ? '!bg-[#252525] !text-[#10B981] !border-emerald-500/50 shadow-none' : '' }`}
                >
                  <div className={inputControlSheen} />
                  <PremiumAudioLines className={`eterx-composer-control-icon eterx-composer-live-icon w-[20px] h-[20px] transition-all duration-200 ease-out group-hover:scale-[1.04] ${ hasAnyLiveSession ? '!text-[#10B981] scale-[1.05]' : 'text-white' }`} strokeWidth={1.85} />
                </button>
              </Tooltip>}

              {/* Send / Stop / Stopping-Spinner Button — instant state changes */}
              {liveState !== 'idle' && liveState !== 'error' ? (
                null /* Cancel/Stop is already rendered in the live overlay above */
              ) : (
                <>
                  {(isStopping || isThinking || canStop) && (hasComposerPayload || isNetworkPaused) && (
                    <Tooltip text={isStopping ? 'Stopping agent' : 'Stop agent'} side="top">
                      <button
                        type="button"
                        disabled={isStopping}
                        onClick={handleStopClick}
                        aria-label={isStopping ? 'Stopping agent' : 'Stop agent'}
                        aria-busy={isStopping}
                        className="eterx-control-button eterx-composer-stop-button eterx-composer-action-stop w-[38px] h-[38px] shrink-0 flex items-center justify-center rounded-full bg-[#292929] text-white disabled:cursor-wait"
                      >
                        {isStopping ? (
                          <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden="true" />
                        ) : (
                          <span className="eterx-composer-stop-icon block h-3 w-3 rounded-[2.5px] bg-current" aria-hidden="true" />
                        )}
                      </button>
                    </Tooltip>
                  )}
                  <div className="eterx-composer-action-slot">
                    <>
                    {isNetworkPaused ? (
                    <div key="network-paused">
                      <Tooltip text="Waiting for network" side="top">
                        <button
                          onClick={onNetworkPausedAction}
                          className="eterx-control-button eterx-composer-status-button w-[38px] h-[38px] shrink-0 flex items-center justify-center rounded-full bg-[#2D2D2D] border border-transparent text-white shadow-none transition-all duration-150 hover:bg-[#333333] hover:border-transparent active:bg-[#333333]"
                        >
                          <motion.div
                            className="eterx-composer-spinner w-[18px] h-[18px] rounded-full border-[2px] border-white/20 border-t-white"
                            animate={{ rotate: 360 }}
                            transition={{ duration: 0.82, repeat: Infinity, ease: 'linear' }}
                          />
                        </button>
                      </Tooltip>
                    </div>
                  ) : (isStopping || isThinking || canStop) && !hasComposerPayload ? (
                    /* ── STOP button (agent running, draft or empty) ── */
                    <div key="stop">
                      <Tooltip text={isStopping ? "Stopping agent" : "Stop agent"} side="top">
                        <button
                          type="button"
                          disabled={isStopping}
                          onClick={handleStopClick}
                          aria-label={isStopping ? 'Stopping agent' : 'Stop agent'}
                          aria-busy={isStopping}
                          className={`eterx-control-button eterx-composer-stop-button eterx-composer-action-stop w-[38px] h-[38px] shrink-0 flex items-center justify-center rounded-full bg-[#292929] text-white transition-none shadow-none group overflow-hidden relative ${ isStopping ? 'cursor-wait' : 'cursor-pointer active:scale-[0.96]' }`}
                        >
                          <div className="absolute inset-0 bg-gradient-to-t from-black/0 to-black/5" />
                          {isStopping ? (
                            <span className="eterx-composer-stop-pending h-[12px] w-[12px] animate-spin rounded-full border-[1.75px] border-white/30 border-t-white" aria-hidden="true" />
                          ) : (
                            <span className="eterx-composer-stop-icon block h-[12px] w-[12px] rounded-[2.5px] bg-current transition-all duration-200" aria-hidden="true" />
                          )}
                        </button>
                      </Tooltip>
                    </div>
                  ) : hasComposerPayload || !showVoiceControls ? (
                    /* ── SEND button ── */
                    <div key="send">
                      <Tooltip text={!hasComposerPayload ? "Type a message to send" : hasErroredAttachments ? "Remove failed attachment" : hasPreparingAttachments ? "Preparing media" : isThinking ? "Queue or steer follow-up" : "Send message"} side="top">
                        <button
                          type="button"
                          onClick={submitPrompt}
                          disabled={!hasComposerPayload || managedWorkspace.busy}
                          aria-label={isThinking ? 'Send follow-up' : 'Send message'}
                          className={`eterx-control-button eterx-composer-send-button eterx-composer-action-send w-[38px] h-[38px] shrink-0 flex items-center justify-center rounded-full transition-none bg-[#292929] text-white shadow-none active:scale-[0.96] group relative overflow-hidden ${ hasErroredAttachments ? 'opacity-60 cursor-not-allowed' : '' }`}
                        >
                          <div className="absolute inset-0 bg-gradient-to-t from-black/0 to-black/5" />
                          <PremiumSend className="eterx-composer-control-icon w-[20px] h-[20px] text-white" strokeWidth={2.05} />
                        </button>
                      </Tooltip>
                    </div>
                  ) : (
                    /* Empty composer: live replaces send on voice-enabled surfaces. */
                    <div key="live">
                      <Tooltip text={isLiveActive ? "End Live Conversation" : hasBackgroundLiveSession ? "Open Live Conversation" : "Start Live Conversation"} side="top">
                        <button
                          onClick={isLiveActive ? onLiveStop : onLiveStart}
                          disabled={isNetworkPaused}
                          data-active={hasAnyLiveSession ? 'true' : undefined}
                          className={`eterx-control-button eterx-composer-live-button w-[38px] h-[38px] shrink-0 flex items-center justify-center rounded-full border border-transparent bg-[#292929] text-white shadow-none transition-all duration-150 active:bg-[#222222] cursor-pointer group relative overflow-hidden hover:bg-[#373737] hover:border-transparent hover:text-white disabled:cursor-not-allowed disabled:opacity-45 ${ hasAnyLiveSession ? '!bg-[#252525] !text-[#10B981] !border-emerald-500/50 shadow-none' : '' }`}
                        >
                          <div className={inputControlSheen} />
                          <PremiumAudioLines className={`eterx-composer-control-icon eterx-composer-live-icon relative z-[1] w-[20px] h-[20px] transition-all duration-200 ease-out group-hover:scale-[1.04] ${ hasAnyLiveSession ? '!text-[#10B981] scale-[1.05]' : '!text-white' }`} strokeWidth={1.85} />
                        </button>
                      </Tooltip>
                    </div>
                    )}
                    </>
                  </div>
                </>
              )}
            </div>
          </div>
          )}
        </motion.div>

        {(isNewChatHome || runLocation !== 'local') && (
          <div
            className="eterx-new-chat-status-rail"
            aria-label="Workspace status"
          >
            <div className="eterx-new-chat-status-scroll" aria-hidden={false}>
              <div className="eterx-new-chat-status-anchor">
                <button
                  type="button"
                  className={`eterx-new-chat-status-item ${ openStatusMenu === 'project' ? 'is-open' : '' }`}
                  aria-label={`Workspace ${ workspaceName }`}
                  aria-haspopup="dialog"
                  aria-expanded={openStatusMenu === 'project'}
                  title={activeWorkspacePath || 'Choose a workspace for this chat'}
                  disabled={executionContextLocked || managedWorkspace.busy || isThinking}
                  onClick={(event) => toggleStatusMenu(event, 'project')}
                >
                  <FolderClosed className="eterx-new-chat-status-icon" strokeWidth={1.9} />
                  <span>{workspaceName}</span>
                  <ChevronDown className="eterx-new-chat-status-chevron" strokeWidth={2.1} />
                </button>
                {openStatusMenu === 'project' && (
                    <AdaptiveMenu
                      className="eterx-composer-popout eterx-status-popout eterx-status-popout-project"
                      heightLimit={420}
                      role="dialog"
                      aria-label="Workspace folder selector"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.stopPropagation();
                          setOpenStatusMenu(null);
                          setProjectSearch('');
                          event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(':scope > button')?.focus();
                          return;
                        }
                        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                        event.preventDefault();
                        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('.eterx-status-menu-item:not(:disabled)'));
                        const index = items.indexOf(document.activeElement as HTMLElement);
                        const next = index < 0
                          ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
                          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                        items[next]?.focus();
                      }}
                    >
                      <label className="eterx-status-search">
                        <Search className="h-4 w-4 shrink-0" strokeWidth={2} />
                        <input
                          autoFocus
                          aria-label="Search projects by name or path"
                          value={projectSearch}
                          onChange={(event) => setProjectSearch(event.target.value)}
                          placeholder="Search projects"
                        />
                      </label>
                      <div data-menu-scroll-region className="eterx-status-menu-section flex-1 min-h-0 overflow-y-auto eterx-scrollbar">
                        {looksLikePath && (
                          <button
                            type="button"
                            className="eterx-status-menu-item bg-black/[0.04] dark:bg-white/[0.04] hover:bg-black/[0.08] dark:hover:bg-white/[0.08]"
                            onClick={() => {
                              const pathVal = projectSearch.trim();
                              handleWorkspacePathChange(pathVal);
                              try {
                                const saved = appStorage.getItem('eterx_recent_projects');
                                const parsed = saved ? JSON.parse(saved) : [];
                                const name = pathVal.split(/[/\\]/).filter(Boolean).pop() || pathVal;
                                const updated = [
                                  { path: pathVal, name, openedAt: Date.now() },
                                  ...(Array.isArray(parsed) ? parsed : []).filter((p: any) => p && typeof p.path === 'string' && typeof p.name === 'string' && p.path !== pathVal)
                                ].slice(0, 8);
                                appStorage.setItem('eterx_recent_projects', JSON.stringify(updated));
                                setRecentProjects(updated);
                              } catch { }
                              setProjectSearch('');
                              setOpenStatusMenu(null);
                            }}
                          >
                            <FolderPlus className="eterx-status-menu-icon text-[#E2765A]" strokeWidth={1.95} />
                            <div className="min-w-0 flex-1 text-left">
                              <div className="text-[12px] font-semibold text-[#E2765A] leading-none mb-0.5">Use pasted path</div>
                              <div className="truncate text-[10px] text-[var(--eterx-status-popout-muted)] font-mono leading-none">{projectSearch.trim()}</div>
                            </div>
                          </button>
                        )}
                        {filteredRecentProjects.length > 0 ? filteredRecentProjects.map(project => {
                          const selected = project.path === activeWorkspacePath;
                          return (
                            <div
                              key={project.path}
                              title={project.path}
                              className={`eterx-status-menu-item group ${ selected ? 'is-selected' : '' }`}
                              onClick={() => {
                                handleWorkspacePathChange(project.path);
                                setProjectSearch('');
                                setOpenStatusMenu(null);
                              }}
                              role="button"
                              tabIndex={0}
                              aria-pressed={selected}
                              onKeyDown={(e) => {
                                if (e.target !== e.currentTarget) return;
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  handleWorkspacePathChange(project.path);
                                  setProjectSearch('');
                                  setOpenStatusMenu(null);
                                }
                              }}
                            >
                              <span className="eterx-project-menu-leading">
                                <FolderClosed className="eterx-status-menu-icon eterx-project-menu-folder" strokeWidth={1.95} />
                                <button
                                  type="button"
                                  className="eterx-project-remove-button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRemoveRecentProject(project.path);
                                  }}
                                  title="Remove from list"
                                  aria-label={`Remove ${project.name} from recent projects`}
                                >
                                  <X className="h-3 w-3" strokeWidth={2.25} />
                                </button>
                              </span>
                              <span className="min-w-0 flex-1 truncate text-left text-[13px] font-medium">{project.name}</span>
                              {selected && <Check className="eterx-project-selected-check h-4 w-4 shrink-0" strokeWidth={2.45} />}
                            </div>
                          );
                        }) : !looksLikePath && (
                          <div className="eterx-status-empty" role="status">
                            <FolderOpen className="mx-auto mb-2 h-5 w-5" strokeWidth={1.6} />
                            <p>{projectSearch.trim() ? 'No matching projects' : 'Choose your first project'}</p>
                            <p className="eterx-project-empty-hint">{projectSearch.trim() ? 'Try another name or paste a folder path.' : 'Open a folder to give this chat a workspace.'}</p>
                          </div>
                        )}
                      </div>
                      
                      <div className="eterx-status-menu-rule" />
                      
                      <button
                        type="button"
                        className="eterx-status-menu-item eterx-project-action w-full"
                        onClick={() => {
                          handleSelectFolderDialog();
                          setOpenStatusMenu(null);
                        }}
                      >
                        <Plus className="eterx-status-menu-icon" strokeWidth={1.95} />
                        <span className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-current">New project</span>
                      </button>
                      <button
                        type="button"
                        className="eterx-status-menu-item eterx-project-action"
                        aria-pressed={!activeWorkspacePath}
                        onClick={() => {
                          handleWorkspacePathChange(null);
                          setProjectSearch('');
                          setOpenStatusMenu(null);
                        }}
                      >
                        <X className="eterx-status-menu-icon" strokeWidth={1.8} />
                        <span className="min-w-0 flex-1 truncate text-left">Don&apos;t work in a project</span>
                        {!activeWorkspacePath && <Check className="eterx-project-selected-check h-4 w-4 shrink-0" strokeWidth={2} />}
                      </button>
                    </AdaptiveMenu>
                )}
              </div>

              <div className="eterx-new-chat-status-anchor">
                <button
                  type="button"
                  className={`eterx-new-chat-status-item ${ openStatusMenu === 'run' ? 'is-open' : '' }`}
                  aria-label={runLocationLabel}
                  aria-haspopup="dialog"
                  aria-expanded={openStatusMenu === 'run'}
                  onClick={(event) => toggleStatusMenu(event, 'run')}
                >
                  {runLocation === 'local' ? (
                    <LaptopMinimal className="eterx-new-chat-status-icon" strokeWidth={1.9} />
                  ) : runLocation === 'worktree' ? (
                    <GitFork className="eterx-new-chat-status-icon" strokeWidth={1.9} />
                  ) : (
                    <Terminal className="eterx-new-chat-status-icon" strokeWidth={1.9} />
                  )}
                  <span>{managedWorkspace.busy ? 'Preparing workspace…' : runLocationLabel}</span>
                  <ChevronDown className="eterx-new-chat-status-chevron" strokeWidth={2.1} />
                </button>
                {openStatusMenu === 'run' && (
                    <AdaptiveMenu
                      className="eterx-composer-popout eterx-status-popout eterx-status-popout-run"
                      preferredSide={isNewChatHome ? 'bottom' : 'top'}
                      role="dialog"
                      aria-label="Run location menu"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <WorkspaceLocationMenu location={runLocation} workspace={managedWorkspace.workspace}
                        retentionDays={managedWorkspace.retentionDays} busy={managedWorkspace.busy} error={managedWorkspace.error}
                        locked={executionContextLocked || isThinking} choose={managedWorkspace.choose} update={managedWorkspace.update} />
                    </AdaptiveMenu>
                )}
              </div>

              {managedWorkspace.workspace?.kind === 'sandbox' && <span className="eterx-workspace-rail-expiry" title={managedWorkspace.workspace.expiresAt ? new Date(managedWorkspace.workspace.expiresAt).toLocaleString() : 'Automatic deletion is disabled for this workspace'}>
                {managedWorkspace.workspace.status === 'expired' ? 'Expired' : managedWorkspace.workspace.expiresAt ? `Expires ${new Date(managedWorkspace.workspace.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : 'Kept'}
              </span>}

              <GitBranchControl
                root={activeWorkspacePath}
                owner={workspaceOwnerId || activeChatId || 'terminal-draft-initial'}
                open={openStatusMenu === 'branch'}
                onToggle={event => toggleStatusMenu(event, 'branch')}
                onClose={() => setOpenStatusMenu(null)}
              />
            </div>
          </div>
        )}
      </div>

      <AttachmentTextPreviewHost />
      <ConnectorsModal
        open={connectors.open}
        onClose={() => connectors.setOpen(false)}
        connectedApps={connectors.connectedApps}
        onConnect={connectors.handleConnect}
        onDisconnect={connectors.handleDisconnect}
      />
      {/* Lightbox Preview Modal */}
      {composerNotice && typeof window !== 'undefined' && createPortal(
        <div className={`pointer-events-none inset-x-0 top-3 z-[11000] flex justify-center px-4 ${composerNoticeTarget ? 'absolute' : 'fixed'}`}>
        <motion.div
          initial={{ opacity: 0, y: -12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.98 }}
          role="alert"
          aria-live="assertive"
          className="eterx-composer-notice pointer-events-auto flex w-[360px] max-w-full items-start gap-3 rounded-2xl border p-4 backdrop-blur-xl"
        >
          <span className="eterx-composer-notice-icon mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border">
            <AlertCircle className="h-4 w-4" strokeWidth={2.2} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-semibold leading-5">{composerNotice.title}</span>
            <span className="eterx-composer-notice-detail mt-0.5 block break-words text-[12.5px] leading-5">{composerNotice.message}</span>
          </span>
          <button
            type="button"
            onClick={() => setComposerNotice(null)}
            className="eterx-composer-notice-dismiss grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-colors"
            aria-label="Dismiss notification"
          >
            <X className="h-4 w-4" strokeWidth={2.2} />
          </button>
        </motion.div>
        </div>,
        composerNoticeTarget || document.body,
      )}

      {previewImage && typeof window !== 'undefined' && createPortal(
        <div
          onClick={() => {
            setPreviewImage(null);
            setZoomScale(1);
            setPanPos({ x: 0, y: 0 });
            setIsDragging(false);
          }}
          onWheel={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (failedPreviewImage === previewImage) return;
            const delta = e.deltaY < 0 ? 0.2 : -0.2;
            setZoomScale(s => {
              const next = Math.min(5, Math.max(0.25, parseFloat((s + delta).toFixed(2))));
              if (next <= 1) setPanPos({ x: 0, y: 0 });
              return next;
            });
          }}
          className="eterx-image-viewer fixed inset-0 z-[100000] flex items-center justify-center overflow-hidden select-none cursor-zoom-out pointer-events-auto"
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          onKeyDown={event => {
            event.stopPropagation();
            if (event.key === 'Tab') {
              const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
              const first = buttons[0];
              const last = buttons[buttons.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setPreviewImage(null);
              setZoomScale(1);
              setPanPos({ x: 0, y: 0 });
            }
            if (failedPreviewImage !== previewImage && (event.key === '+' || event.key === '=')) {
              event.preventDefault();
              handleZoomIn();
            }
            if (failedPreviewImage !== previewImage && (event.key === '-' || event.key === '_')) {
              event.preventDefault();
              handleZoomOut();
            }
            if (event.key === '0' || event.key === 'r' || event.key === 'R') {
              event.preventDefault();
              handleResetZoom();
            }
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              navigatePreviewImage(event.key === 'ArrowLeft' ? -1 : 1);
            }
          }}
        >
          {/* Top-Right Modern Close Button */}
          {previewImages.length > 1 && (
            <span className="absolute left-5 top-16 text-xs font-medium tabular-nums opacity-70" aria-live="polite">
              {previewImages.indexOf(previewImage) + 1} / {previewImages.length}
            </span>
          )}
            <button
              type="button"
              autoFocus
              title="Close (Esc)"
              aria-label="Close image preview"
              onClick={(event) => {
                event.stopPropagation();
                setPreviewImage(null);
                setZoomScale(1);
                setPanPos({ x: 0, y: 0 });
              }}
              className="eterx-image-viewer-close absolute z-[100005] grid h-11 w-11 place-items-center rounded-full cursor-pointer pointer-events-auto transition-all active:scale-95"
            >
              <X className="h-5 w-5" strokeWidth={2} />
            </button>

          {/* Previous / Next Navigation Arrows for multi-images */}
          {previewImages.length > 1 && (
            <div className="absolute inset-x-5 top-1/2 z-[100005] flex justify-between pointer-events-none -translate-y-1/2">
              {[-1, 1].map(direction => {
                const isDisabled = direction < 0
                  ? previewImages.indexOf(previewImage) <= 0
                  : previewImages.indexOf(previewImage) >= previewImages.length - 1;
                return (
                  <button
                    key={direction}
                    type="button"
                    aria-label={direction < 0 ? 'Previous image' : 'Next image'}
                    disabled={isDisabled}
                    className="eterx-image-viewer-nav-btn pointer-events-auto grid h-10 w-10 place-items-center rounded-full text-base disabled:opacity-20 disabled:pointer-events-none cursor-pointer"
                    onClick={event => { event.stopPropagation(); navigatePreviewImage(direction); }}
                  >
                    {direction < 0 ? <ChevronLeft className="h-5 w-5" strokeWidth={2} /> : <ChevronRight className="h-5 w-5" strokeWidth={2} />}
                  </button>
                );
              })}
            </div>
          )}

          {/* Inner relative container that defines the viewing viewport of the image */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative max-w-[90vw] max-h-[82vh] flex items-center justify-center overflow-visible"
          >
            <img
              key={previewImage}
              hidden={failedPreviewImage === previewImage}
              src={previewImage}
              alt="Preview"
              onError={() => setFailedPreviewImage(previewImage)}
              onLoad={() => setFailedPreviewImage(null)}
              style={{
                transform: `translate(${ panPos.x }px, ${ panPos.y }px) scale(${ zoomScale })`,
                cursor: zoomScale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in',
                transition: isDragging ? 'none' : 'transform 0.15s cubic-bezier(0.2, 0, 0, 1)',
                transformOrigin: 'center center'
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (zoomScale > 1) {
                  setIsDragging(true);
                  setDragStart({ x: e.clientX - panPos.x, y: e.clientY - panPos.y });
                }
              }}
              onMouseMove={(e) => {
                if (isDragging) {
                  setPanPos({
                    x: e.clientX - dragStart.x,
                    y: e.clientY - dragStart.y
                  });
                }
              }}
              onMouseUp={() => setIsDragging(false)}
              onMouseLeave={() => setIsDragging(false)}
              onDoubleClick={handleToggleZoom}
              className={`${failedPreviewImage === previewImage ? 'hidden' : 'block'} max-w-[calc(100vw-112px)] max-h-[calc(100dvh-180px)] object-contain rounded-[14px] shadow-[0_20px_60px_rgba(0,0,0,0.5)] border border-white/10 select-none`}
            />
            {failedPreviewImage === previewImage && (
              <div role="status" className="eterx-image-viewer-toolbar flex w-[360px] max-w-[calc(100vw-112px)] flex-col items-center gap-3 rounded-2xl border px-6 py-7 text-center text-sm">
                <ImageIcon className="h-8 w-8 opacity-50" aria-hidden="true" />
                <span className="font-semibold">Image unavailable</span>
                <span className="text-xs leading-5 opacity-70">The source may have been moved or removed.</span>
                <button type="button" className="eterx-image-viewer-btn rounded-lg border border-current/20 px-4 py-2" onClick={() => setPreviewImage(null)}>Close preview</button>
              </div>
            )}
          </div>

          {/* Modern Floating Toolbar Island at bottom */}
          {failedPreviewImage !== previewImage && <div
            onClick={e => e.stopPropagation()}
            className="eterx-image-viewer-toolbar pointer-events-auto absolute bottom-7 left-1/2 -translate-x-1/2 flex items-center gap-1 px-3 py-1.5 rounded-full shadow-[0_12px_40px_rgba(0,0,0,0.5)] z-[100005] select-none"
          >
            {previewImages.length > 1 && (
              <>
                <span className="px-2 text-[11.5px] font-medium opacity-75 tabular-nums">
                  {previewImages.indexOf(previewImage) + 1} <span className="opacity-40">/</span> {previewImages.length}
                </span>
                <div className="eterx-image-viewer-divider h-4 w-px my-auto" />
              </>
            )}

            {/* Zoom Out Button */}
            <Tooltip text="Zoom out (-)" side="top">
              <button
                type="button"
                onClick={handleZoomOut}
                disabled={zoomScale <= 0.25}
                aria-label="Zoom out"
                className="eterx-image-viewer-btn flex h-8 w-8 items-center justify-center rounded-full transition-all active:scale-95 disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
              >
                <Minus className="h-4 w-4" strokeWidth={2} />
              </button>
            </Tooltip>

            {/* Zoom Level Indicator / Fit Toggle */}
            <Tooltip text="Click to reset (0)" side="top">
              <button
                type="button"
                onClick={handleResetZoom}
                aria-label="Reset zoom to 100%"
                className="eterx-image-viewer-pct flex h-8 min-w-[54px] items-center justify-center rounded-full px-2 text-[12px] font-semibold tabular-nums transition-all hover:bg-white/[0.08] active:scale-95 cursor-pointer"
              >
                {Math.round(zoomScale * 100)}%
              </button>
            </Tooltip>

            {/* Zoom In Button */}
            <Tooltip text="Zoom in (+)" side="top">
              <button
                type="button"
                onClick={handleZoomIn}
                disabled={zoomScale >= 5}
                aria-label="Zoom in"
                className="eterx-image-viewer-btn flex h-8 w-8 items-center justify-center rounded-full transition-all active:scale-95 disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
              >
                <Plus className="h-4 w-4" strokeWidth={2} />
              </button>
            </Tooltip>

            <div className="eterx-image-viewer-divider h-4 w-px mx-0.5 my-auto" />

            {/* Reset / Fit to Screen Button */}
            <Tooltip text="Fit to screen (R)" side="top">
              <button
                type="button"
                onClick={handleResetZoom}
                aria-label="Fit to screen"
                className="eterx-image-viewer-btn flex h-8 w-8 items-center justify-center rounded-full transition-all active:scale-95 cursor-pointer"
              >
                <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            </Tooltip>

            {/* Copy Image Button */}
            <Tooltip text={copiedImage ? "Copied!" : "Copy image"} side="top">
              <button
                type="button"
                onClick={handleCopyImage}
                aria-label="Copy image"
                className="eterx-image-viewer-btn flex h-8 w-8 items-center justify-center rounded-full transition-all active:scale-95 cursor-pointer"
              >
                {copiedImage ? <Check className="h-4 w-4 text-emerald-400" strokeWidth={2.2} /> : <Copy className="h-3.5 w-3.5" strokeWidth={2} />}
              </button>
            </Tooltip>

            {/* Download Image Button */}
            <Tooltip text="Download image" side="top">
              <button
                type="button"
                onClick={handleDownloadImage}
                aria-label="Download image"
                className="eterx-image-viewer-btn flex h-8 w-8 items-center justify-center rounded-full transition-all active:scale-95 cursor-pointer"
              >
                <Download className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            </Tooltip>
          </div>}
        </div>,
        document.body
      )}

      {previewVideo && typeof window !== 'undefined' && createPortal(
        <div
          onClick={() => setPreviewVideo(null)}
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/90 p-5 backdrop-blur-md"
        >
          <div onClick={event => event.stopPropagation()} className="relative w-full max-w-[980px] overflow-hidden rounded-[18px] border border-white/10 bg-[#0d0d0d] shadow-none">
            <video src={previewVideo.url} controls autoPlay playsInline className="max-h-[78vh] w-full bg-black object-contain" />
            <div className="flex items-center justify-between gap-3 border-t border-white/10 px-4 py-3 text-[12px] text-white/65">
              <span className="truncate">{previewVideo.name || 'Video preview'}</span>
              <button type="button" onClick={() => setPreviewVideo(null)} className="rounded-full border border-white/10 px-3 py-1 text-white/80 transition-colors hover:bg-white/10 hover:text-white">Close</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Global Document Preview Modal */}
      {previewDocPath && typeof window !== 'undefined' && createPortal(
        <div
          onClick={() => {
            setPreviewDocPath(null);
            setConvertedPdfPath(null);
            setIsConvertingDoc(false);
          }}
          className="fixed inset-0 z-[10000] bg-black/85 backdrop-blur-md flex items-center justify-center p-8 select-none"
        >

          <div
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-[85vw] h-[90vh] bg-[#1E1E1E] border border-white/[0.08] rounded-[16px] shadow-none flex flex-col overflow-hidden"
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08] bg-[#161616]">
              <div className="flex flex-col min-w-0">
                <span className="text-[14px] font-bold text-white truncate max-w-[65vw]">
                  {previewDocPath.split(/[\\/]/).pop()}
                </span>
                <span className="text-[10px] text-neutral-400 font-semibold tracking-wide mt-0.5">
                  Document Preview
                </span>
              </div>
            </div>

            {/* Modal Body */}
            <div className="flex-1 w-full h-full bg-[#181818] relative flex flex-col">
              {isConvertingDoc ? (
                <div className="flex-1 flex flex-col items-center justify-center text-white gap-3.5">
                  <svg className="animate-spin h-8 w-8 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <span className="text-[13.5px] font-medium tracking-normal text-white/70 animate-pulse">Converting Word Document to PDF...</span>
                </div>
              ) : conversionError ? (
                <div className="flex-1 flex flex-col items-center justify-center text-white/80 gap-4 p-6">
                  <span className="text-[13px] text-[#F0B6A7] font-semibold">Failed to convert Word document to PDF preview.</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPreviewDocPath(null);
                      if ((window as any).electronAPI?.openExternal) {
                        (window as any).electronAPI.openExternal(previewDocPath);
                      }
                    }}
                    className="px-4 py-2 bg-white/10 hover:bg-white/25 rounded-lg text-[12px] font-semibold text-white transition-colors cursor-pointer"
                  >
                    Open in default application
                  </button>
                </div>
              ) : (
                <DocumentPreviewIframe
                src={buildFilePreviewUrl(convertedPdfPath || previewDocPath)}
                />
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
