'use client';
import { formatModelName, groupModelsByProvider } from '../../lib/agent/model-presentation';
import { requestJson } from '../../lib/request-json';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { MAIN_AGENT_MODEL_OPTIONS, getModelThinkingOptions, normalizeModelThinkingCapabilities, type MainAgentMode, type MainAgentProvider, type ModelThinkingCapabilities } from '../../lib/agent/model-routing';
import {
  AUTO_MODEL_SELECTION,
  API_KEY_PRESENCE_STORAGE_KEY,
  CHAT_CONTEXT_WINDOW_OVERRIDES_STORAGE_KEY,
  CHAT_MODEL_SELECTION_STORAGE_KEY,
  MODEL_API_KEY_PRESENCE_STORAGE_KEY,
  MODEL_API_KEYS_STORAGE_KEY,
  MODEL_CATALOG_STORAGE_KEY,
  MODEL_CONTEXT_WINDOWS_STORAGE_KEY,
  MODEL_OVERRIDE_STORAGE_KEY,
  MODEL_PROVIDER_MODE,
  MODEL_PROVIDER_ORDER,
  MODEL_SELECTOR_SCHEMA_STORAGE_KEY,
  MODEL_SELECTOR_SCHEMA_VERSION,
  MODEL_SELECTOR_STORAGE_KEY,
  MODEL_THINKING_CAPABILITIES_STORAGE_KEY,
  MODEL_WIRE_CAPABILITIES_STORAGE_KEY,
  MODEL_THINKING_LEVELS_STORAGE_KEY,
  composeApiKeysForSelections,
  entriesToModelCatalog,
  ensureModelSelectorEntry,
  isConcreteModelId,
  isEmbeddedModelLabel,
  isModelProvider,
  modelEntryKey,
  normalizeModelSelectorEntries,
  parseModelEntryKey,
  removeModelSelectorEntry,
  type ModelSelectorEntry,
} from '../../lib/agent/model-selector-store';
import { transitionEterxTheme, broadcastEterxSettingsUpdate } from '../theme/theme-bridge';
import { appStorage, appStorageReady, registerDurableFlush, FOLDER_STORAGE_READY_EVENT } from '../../lib/client-storage';
import { isLocalModelProvider } from '../../lib/agent/provider-runtime';
import { resolveModelContextWindow } from '../../lib/agent/model-context-window';
import { readContextUsageMeter } from '../../lib/context-usage-meter';
import {
  CONTEXT_BUDGET_REVISIONS_KEY, CONTEXT_WINDOW_SIZE_OPTIONS, contextWindowLimitNote, formatExactContextTokens,
  normalizeContextWindow, resolveContextWindowBudget, resolveSavedContextBudget,
} from '../../lib/context-window-policy';
import {
  LIVE_PROVIDER_OPTIONS,
  getLiveModelOptions,
  getLiveProvider,
  isLiveModelForProvider,
  normalizeLiveProvider,
} from '../../lib/live/live-provider';
import { getLiveVoiceOptions } from '../../lib/live/voice-catalog';
import { safeCopyTextToClipboard, safeReadTextFromClipboard } from '../ui/copy-button';
import {
  DEFAULT_SEARCH_SETTINGS,
  normalizeSearchSettings,
  SEARCH_PROVIDER_IDS,
  SEARCH_PROVIDER_META,
  SEARCH_SERVICE_IDS,
  type SearchProvider,
  type SearchService,
  type SearchSettings,
} from '../../lib/search/search-config';
import {
  DEFAULT_IMAGE_SETTINGS,
  IMAGE_PROVIDER_IDS,
  IMAGE_PROVIDER_META,
  normalizeImageSettings,
  type ImageProvider,
  type ImageSettings,
} from '../../lib/image/image-generation-config';
import {
  DEFAULT_VIDEO_SETTINGS,
  VIDEO_PROVIDER_IDS,
  VIDEO_PROVIDER_META,
  normalizeVideoSettings,
  type VideoProvider,
  type VideoSettings,
} from '../../lib/video/video-generation-config';

type SettingsGlyphProps = React.SVGProps<SVGSVGElement> & { strokeWidth?: number };
const SETTINGS_CHANNEL = 'eterx-settings';
const PROVIDER_BASE_URLS_STORAGE_KEY = 'eterx_provider_base_urls';
const lightweightSettingsHoverCss = `
  /* Use the same CSS-only interaction path as the rows in All Chats search.
     This changes response timing only; each tab keeps its existing colors,
     spacing, radius, and selected state. */
  @media (hover: hover) and (pointer: fine) {
    .eterx-settings-dialog .eterx-settings-tab,
    .eterx-settings-dialog .eterx-settings-back-button {
      transition-property: background-color, border-color, color, opacity !important;
      transition-duration: 120ms !important;
      transition-timing-function: ease-out !important;
      transition-delay: 0ms !important;
      transform: none !important;
      filter: none !important;
      will-change: auto !important;
    }

    .eterx-settings-dialog .eterx-settings-tab [class*="transition-colors"],
    .eterx-settings-dialog .eterx-settings-back-button [class*="transition-colors"] {
      transition-property: background-color, border-color, color, opacity !important;
      transition-duration: 120ms !important;
      transition-timing-function: ease-out !important;
      transition-delay: 0ms !important;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .eterx-settings-dialog .eterx-settings-tab,
    .eterx-settings-dialog .eterx-settings-back-button {
      transition-duration: 0.01ms !important;
    }
  }
`;
const SEARCH_CAPABILITY_LABELS: Record<'search' | 'read' | 'crawl' | 'map', string> = {
  search: 'Search',
  read: 'Page reading',
  crawl: 'Crawl',
  map: 'Site map',
};
const SEARCH_SERVICE_META: Record<SearchService, { label: string; description: string }> = {
  search: { label: 'Web search', description: 'Find current sources and ranked results.' },
  read: { label: 'Read pages', description: 'Extract readable content from selected URLs.' },
  crawl: { label: 'Crawl websites', description: 'Follow a site and collect content across pages.' },
  map: { label: 'Map websites', description: 'Discover links without reading every page.' },
  research: { label: 'Deep research', description: 'Run multi-angle research and source synthesis.' },
};
const IMAGE_CAPABILITY_LABELS = {
  text: 'Text to image',
  edit: 'Image editing',
  ratio: 'Aspect ratio',
} as const;

const SettingsGlyph = ({
  children,
  className,
  strokeWidth = 1.9,
  ...props
}: SettingsGlyphProps & { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true" {...props}>
    <g stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </g>
  </svg>
);;

const Key = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <circle cx="8.2" cy="12" r="3.2" />
    <path d="M11.4 12h7.4M15.6 12v2.2M18.8 12v-2.2" />
  </SettingsGlyph>
);

const Shield = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <path d="M12 3.2c2.25 1.65 4.45 2.42 6.6 2.32v5.7c0 4.25-2.2 7.18-6.6 8.78-4.4-1.6-6.6-4.53-6.6-8.78v-5.7c2.15.1 4.35-.67 6.6-2.32Z" />
    <path d="m9.05 12.1 2.05 2 3.95-4.25" />
  </SettingsGlyph>
);

const ChevronRight = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <path d="m9.2 5.2 6.1 6.8-6.1 6.8" />
  </SettingsGlyph>
);

const Monitor = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <rect x="3.8" y="4.7" width="16.4" height="11.1" rx="2.2" />
    <path d="M9.2 20h5.6M12 15.8V20" />
  </SettingsGlyph>
);

const Cpu = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <rect x="6" y="6" width="12" height="12" rx="2.2" />
    <rect x="9.2" y="9.2" width="5.6" height="5.6" rx="1.1" />
    <path d="M9 3.5v2.1M15 3.5v2.1M9 18.4v2.1M15 18.4v2.1M3.5 9h2.1M3.5 15h2.1M18.4 9h2.1M18.4 15h2.1" />
  </SettingsGlyph>
);

const Eye = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <path d="M3.8 12s2.8-5.1 8.2-5.1 8.2 5.1 8.2 5.1-2.8 5.1-8.2 5.1S3.8 12 3.8 12Z" />
    <circle cx="12" cy="12" r="2.35" />
  </SettingsGlyph>
);

const EyeOff = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <path d="M4.2 4.2 19.8 19.8M9.2 6.95A8.5 8.5 0 0 1 12 6.5c5.35 0 8.2 5.5 8.2 5.5a13.2 13.2 0 0 1-2.25 3.02M14.65 14.75A3.25 3.25 0 0 1 9.25 9.35M6.6 8.2A13.2 13.2 0 0 0 3.8 12s2.85 5.5 8.2 5.5c.9 0 1.72-.15 2.48-.42" />
  </SettingsGlyph>
);

const Copy = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <rect x="8" y="8" width="11" height="11" rx="2" />
    <path d="M5 15.6V6.8c0-1 .8-1.8 1.8-1.8h8.8" />
  </SettingsGlyph>
);

const Check = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <path d="m5.3 12.4 4.1 4 9.3-9.1" />
  </SettingsGlyph>
);

const Globe = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M3.8 12h16.4M12 3.6c2.2 2.25 3.3 5.05 3.3 8.4s-1.1 6.15-3.3 8.4M12 3.6C9.8 5.85 8.7 8.65 8.7 12s1.1 6.15 3.3 8.4" />
  </SettingsGlyph>
);

const Lock = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <rect x="5" y="10.2" width="14" height="9.2" rx="2.2" />
    <path d="M8.3 10.2V7.9a3.7 3.7 0 0 1 7.4 0v2.3M12 14.1v1.6" />
  </SettingsGlyph>
);

const Search = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <circle cx="10.7" cy="10.7" r="5.6" />
    <path d="m15 15 4.1 4.1" />
  </SettingsGlyph>
);

const PlugZap = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <path d="M7.4 14.2 4.8 16.8a2.55 2.55 0 0 0 3.6 3.6l2.6-2.6M8.4 11.1 12.9 15.6M10.8 8.7l4.5 4.5" />
    <path d="M14.2 3.4 11.5 7h4.2l-2.4 3.6" />
    <path d="m14.1 13.2 3.1-3.1M10.8 9.9l3.1-3.1" />
  </SettingsGlyph>
);

const Plus = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <path d="M12 5v14M5 12h14" />
  </SettingsGlyph>
);

const BookOpen = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <path d="M4.5 5.5c2.25-.8 4.75-.35 7.5 1.35v12.1c-2.75-1.7-5.25-2.15-7.5-1.35V5.5Z" />
    <path d="M19.5 5.5c-2.25-.8-4.75-.35-7.5 1.35v12.1c2.75-1.7 5.25-2.15 7.5-1.35V5.5Z" />
    <path d="M12 6.85v12.1" />
  </SettingsGlyph>
);

const ArrowLeft = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </SettingsGlyph>
);

const Trash2 = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <path d="M5 7h14M9.1 7V5.1h5.8V7M7.1 7.2l.7 12.1h8.4l.7-12.1M10.2 10.8v5M13.8 10.8v5" />
  </SettingsGlyph>
);

const GripVertical = (props: SettingsGlyphProps) => (
  <svg viewBox="0 0 24 24" className={props.className} fill="none" aria-hidden="true">
    <circle cx="9" cy="6.5" r="1.25" fill="currentColor" />
    <circle cx="15" cy="6.5" r="1.25" fill="currentColor" />
    <circle cx="9" cy="12" r="1.25" fill="currentColor" />
    <circle cx="15" cy="12" r="1.25" fill="currentColor" />
    <circle cx="9" cy="17.5" r="1.25" fill="currentColor" />
    <circle cx="15" cy="17.5" r="1.25" fill="currentColor" />
  </svg>
);

const Info = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M12 10.8v5M12 7.8h.01" />
  </SettingsGlyph>
);

const X = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <path d="M18 6 6 18M6 6l12 12" />
  </SettingsGlyph>
);

const Spinner = ({ className, ...props }: React.SVGProps<SVGSVGElement>) => (
  <svg
    className={`animate-spin ${className || ''}`}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <circle
      className="opacity-25"
      cx="12"
      cy="12"
      r="10"
      stroke="currentColor"
      strokeWidth="4"
    />
    <path
      className="opacity-75"
      fill="currentColor"
      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
    />
  </svg>
);

// ─── Settings Shape ────────────────────────────────────
export interface AppSettings {
  // General
  theme: 'dark' | 'light' | 'system';
  userName: string;
  customInstructions: string;
  fontSize: 'compact' | 'default' | 'comfortable';
  workMode: 'specialist' | 'everyday';
  openDestination: 'eterx' | 'workspace' | 'last';
  terminalShell: 'auto' | 'powershell' | 'cmd' | 'git-bash' | 'wsl' | 'zsh' | 'bash' | 'fish' | 'sh';
  selfImprovementEnabled: boolean;
  requireCtrlEnter: boolean;
  followUpBehavior: 'queue' | 'steer';
  codeReviewMode: 'inline' | 'detached';
  defaultProjectlessChat: boolean;
  completionNotifications: 'always' | 'important' | 'never';
  reduceMotion: 'system' | 'on' | 'off';
  pointerCursors: boolean;
  diffMarkers: 'color' | 'symbols';
  animationsEnabled: boolean;
  soundEnabled: boolean;
  autoSave: boolean;
  language: string;

  // Agent
  agentMode: MainAgentMode;
  criticEnabled: boolean;
  autoSubAgents: boolean;
  maxSubAgents: number;
  memoryHydration: boolean;
  synapseGraphEnabled: boolean;
  groundingSearch: boolean;
  streamResponses: boolean;
  maxRetries: number;
  defaultPermissions: boolean;
  autoReview: boolean;
  fullAccess: boolean;
  shellIntegration: boolean;
  autoOpenEditedFiles: boolean;
  contextCompactionEnabled: boolean;
  contextCompactionModelSelection: string;
  contextCompactionInstructions: string;
  contextWindowSizeSelection: string;
  contextWindowSizeSelectionTouched: boolean;

  // Advanced
  debugMode: boolean;
  telemetry: boolean;
  experimentalFeatures: boolean;
  keyboardShortcuts: boolean;
  mcpServersEnabled: boolean;
  hooksEnabled: boolean;
  gitIntegration: boolean;
  gitAutoDetect: boolean;
  gitMergeMethod: 'merge' | 'squash';
  showPrStatus: boolean;
  isolatedEnvironments: boolean;
  worktreesEnabled: boolean;
  browserAccess: boolean;
  computerUse: boolean;
  showTokenCount: boolean;
  archiveRetention: '30' | '90' | 'forever';

  // Live Convo
  liveConvoEnabled: boolean;
  liveConvoProvider: string;
  liveConvoModel: string;
  liveConvoVoice: string;
  liveConvoLatencyMode: 'ultra-low' | 'balanced' | 'high-quality';
  liveConvoAudioInput: boolean;
  liveConvoAudioOutput: boolean;
  liveConvoAgentId: string;
  liveConvoSystemInstruction: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  userName: 'Developer',
  customInstructions: '',
  fontSize: 'default',
  workMode: 'everyday',
  openDestination: 'eterx',
  terminalShell: 'auto',
  selfImprovementEnabled: true,
  requireCtrlEnter: false,
  followUpBehavior: 'steer',
  codeReviewMode: 'inline',
  defaultProjectlessChat: false,
  completionNotifications: 'always',
  reduceMotion: 'system',
  pointerCursors: false,
  diffMarkers: 'color',
  animationsEnabled: true,
  soundEnabled: false,
  autoSave: true,
  language: 'en',
  agentMode: 'think',
  criticEnabled: true,
  autoSubAgents: true,
  maxSubAgents: 5,
  memoryHydration: true,
  synapseGraphEnabled: false,
  groundingSearch: true,
  streamResponses: true,
  maxRetries: 0,
  defaultPermissions: true,
  autoReview: true,
  fullAccess: false,
  shellIntegration: true,
  autoOpenEditedFiles: true,
  contextCompactionEnabled: true,
  contextCompactionModelSelection: AUTO_MODEL_SELECTION,
  contextCompactionInstructions: '',
  contextWindowSizeSelection: 'model_max',
  contextWindowSizeSelectionTouched: false,
  debugMode: false,
  telemetry: false,
  experimentalFeatures: false,
  keyboardShortcuts: true,
  mcpServersEnabled: true,
  hooksEnabled: false,
  gitIntegration: true,
  gitAutoDetect: true,
  gitMergeMethod: 'merge',
  showPrStatus: false,
  isolatedEnvironments: true,
  worktreesEnabled: false,
  browserAccess: true,
  computerUse: false,
  showTokenCount: true,
  archiveRetention: '90',
  liveConvoEnabled: true,
  liveConvoProvider: 'agent-live-convo',
  liveConvoModel: 'auto',
  liveConvoVoice: 'auto',
  liveConvoLatencyMode: 'ultra-low',
  liveConvoAudioInput: true,
  liveConvoAudioOutput: true,
  liveConvoAgentId: '',
  liveConvoSystemInstruction: '',
};

const API_RETRY_OPTIONS = [
  { value: '0', label: 'None', description: 'Send each provider request once.' },
  { value: '1', label: '1 retry', description: 'Retry one time after a failed request.' },
  { value: '2', label: '2 retries', description: 'Retry up to two times before failing.' },
  { value: '3', label: '3 retries', description: 'Retry up to three times before failing.' },
];

const compactTokenLabel = (tokens: number) => {
  if (!Number.isFinite(tokens) || tokens <= 0) return 'Not measured yet';
  if (tokens < 1_000) return Math.round(tokens).toLocaleString();
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
};

const normalizeAppSettings = (value: unknown): AppSettings => {
  const stored = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<AppSettings>
    : {};
  const next = { ...DEFAULT_SETTINGS, ...stored } as AppSettings;
  next.theme = stored.theme === 'dark' || stored.theme === 'system' || stored.theme === 'light'
    ? stored.theme
    : DEFAULT_SETTINGS.theme;
  // Steer is the safe default for an active run. Preserve Queue only when it
  // was explicitly selected; old/invalid preference values must not leave the
  // segmented control with no selected option.
  next.followUpBehavior = stored.followUpBehavior === 'queue' ? 'queue' : 'steer';
  const configuredRetries = Number(stored.maxRetries);
  next.maxRetries = Number.isFinite(configuredRetries)
    ? Math.max(0, Math.min(3, Math.floor(configuredRetries)))
    : DEFAULT_SETTINGS.maxRetries;
  next.selfImprovementEnabled = stored.selfImprovementEnabled !== false;
  next.showTokenCount = stored.showTokenCount !== false;
  next.contextWindowSizeSelection = resolveSavedContextBudget(stored);
  next.contextWindowSizeSelectionTouched = next.contextWindowSizeSelection !== 'model_max';
  return next;
};

const getTerminalShellOptions = (platform: 'unknown' | 'windows' | 'mac' | 'linux', availableShells: string[] = []) => {
  const filterAvailable = (options: Array<{ value: string; label: string }>) => {
    if (!availableShells.length) return options.filter(option => option.value === 'auto');
    return options.filter(option => option.value === 'auto' || availableShells.includes(option.value));
  };
  if (platform === 'mac') {
    return filterAvailable([
      { value: 'auto', label: 'Smart (auto-detect)' },
      { value: 'zsh', label: 'Z shell (zsh)' },
      { value: 'bash', label: 'Bash' },
      { value: 'fish', label: 'Fish' },
      { value: 'powershell', label: 'PowerShell (pwsh)' },
    ]);
  }
  if (platform === 'linux') {
    return filterAvailable([
      { value: 'auto', label: 'Smart (auto-detect)' },
      { value: 'bash', label: 'Bash' },
      { value: 'zsh', label: 'Z shell (zsh)' },
      { value: 'fish', label: 'Fish' },
      { value: 'sh', label: 'POSIX shell (sh)' },
      { value: 'powershell', label: 'PowerShell (pwsh)' },
    ]);
  }
  if (platform === 'windows') return filterAvailable([
    { value: 'auto', label: 'Smart (auto-detect)' },
    { value: 'powershell', label: 'PowerShell' },
    { value: 'cmd', label: 'Command Prompt' },
    { value: 'git-bash', label: 'Git Bash' },
    { value: 'wsl', label: 'WSL' },
  ]);
  return [{ value: 'auto', label: 'Smart (auto-detect)' }];
};

type Tab =
  | 'general'
  | 'profile'
  | 'appearance'
  | 'configuration'
  | 'personalization'
  | 'shortcuts'
  | 'tokens'
  | 'mcp'
  | 'hooks'
  | 'context'
  | 'models'
  | 'api'
  | 'live-convo'
  | 'git'
  | 'environments'
  | 'worktrees'
  | 'browser'
  | 'computer'
  | 'updates'
  | 'archives';

type LegacyTab = 'agent' | 'advanced' | 'account' | 'connections';

type ApiProviderStatus = {
  provider: string;
  accepted: boolean;
  count: number;
  reason?: string;
};

type ModelDirectoryProvider = {
  provider: string;
  connected: boolean;
  source: 'live' | 'unavailable';
  models: Array<{
    id: string;
    name: string;
    description?: string;
    contextLength?: number;
    inputTokenLimit?: number;
    outputTokenLimit?: number;
    capabilities?: string[];
    thinking?: ModelThinkingCapabilities;
  }>;
  excludedCount?: number;
  error?: string;
};

type ModelDirectory = Record<string, ModelDirectoryProvider>;
type ModelOverrides = Record<string, string>;
type ModelCatalog = Record<string, string[]>;
type ProviderModelOption = { id: string; label: string; source: 'selected' | 'saved' | 'live' };
type LiveModelOption = { value: string; label: string; tag?: string; description?: string };
type DesktopUpdateState = {
  revision?: number;
  status: 'idle' | 'development' | 'unsupported' | 'checking' | 'available' | 'downloading' | 'current' | 'ready' | 'installing' | 'error';
  currentVersion: string;
  availableVersion?: string | null;
  percent: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  downloadReady?: boolean;
  message: string;
  supported?: boolean;
  automaticChecks?: boolean;
  manualInstall?: boolean;
  lastCheckedAt?: string | null;
  platform?: string;
  architecture?: string;
  packageType?: string;
  updateHost?: string;
  releasePage?: string;
  releaseName?: string | null;
  releaseDate?: string | null;
  updateAvailableUnread?: boolean;
};

const formatUpdateBytes = (value?: number) => {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
};

type RuntimeSettingsSnapshot = {
  apiKeys: Record<string, string>;
  liveApiKeys?: Record<string, string>;
  modelApiKeys: Record<string, string>;
  modelOverrides: ModelOverrides;
  baseURLs?: Record<string, string>;
  modelEntries: ModelSelectorEntry[];
  selectionKeys?: string[];
  search?: SearchSettings;
  image?: ImageSettings;
};

const splitApiKeyPool = (value: string | undefined) =>
  String(value || '')
    .split(/[\n,]/)
    .map(key => key.trim())
    .filter(Boolean);

const serializeApiKeyPool = (keys: string[]) =>
  keys.map(key => key.trim()).filter(Boolean).join('\n');

const markContextBudgetEdit = (chatId?: string) => {
  let revisions: any = {};
  try { revisions = JSON.parse(appStorage.getItem(CONTEXT_BUDGET_REVISIONS_KEY) || '{}'); } catch { }
  const now = Math.max(Date.now(), Number(revisions.global || 0) + 1, Number(revisions.chats?.[chatId || ''] || 0) + 1);
  appStorage.setItem(CONTEXT_BUDGET_REVISIONS_KEY, JSON.stringify(chatId
    ? { ...revisions, chats: { ...revisions.chats, [chatId]: now } }
    : { ...revisions, global: now }));
};

const composeRuntimeApiKeys = (
  apiKeys: Record<string, string>,
  modelApiKeys: Record<string, string>,
  modelEntries: ModelSelectorEntry[],
  selectionKeys: string[] = [],
) => composeApiKeysForSelections(
  apiKeys,
  modelApiKeys,
  modelEntries,
  [
    AUTO_MODEL_SELECTION,
    ...modelEntries.map(entry => modelEntryKey(entry.provider, entry.modelId)),
    ...selectionKeys,
  ],
);

const maskApiKey = (key: string) => {
  const trimmed = key.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 12) return '•'.repeat(Math.max(8, trimmed.length));
  return `${trimmed.slice(0, 6)}${'•'.repeat(12)}${trimmed.slice(-4)}`;
};

const providerKeyLooksValid = (provider: string, key: string) => {
  const value = key.trim();
  if (!value) return false;
  if (provider === 'gemini') return value.startsWith('AIza') && value.length > 20;
  if (provider === 'openai') return value.length >= 20 && (value.startsWith('sk-') || value.startsWith('sess-'));
  if (provider === 'anthropic') return value.length >= 20 && value.startsWith('sk-ant-');
  if (provider === 'openrouter') return value.length >= 20 && (value.startsWith('sk-or-') || value.startsWith('sk-'));
  if (provider === 'groq') return value.length >= 20;
  if (provider === 'mistral') return value.length >= 16;
  if (provider === 'tavily') return value.length >= 12;
  if (provider === 'github') return value.length >= 20;
  if (['ollama', 'lmstudio', 'vllm', 'llamacpp'].includes(provider)) return value.length >= 1;
  return value.length >= 12;
};


const PROVIDER_LABEL: Record<string, string> = {
  gemini: 'Google Gemini',
  openai: 'OpenAI Platform',
  anthropic: 'Anthropic Claude',
  grok: 'xAI Grok',
  deepseek: 'DeepSeek AI',
  mistral: 'Mistral AI',
  groq: 'Groq LPU',
  cerebras: 'Cerebras Wafer',
  sambanova: 'SambaNova Systems',
  together: 'Together AI',
  fireworks: 'Fireworks AI',
  openrouter: 'OpenRouter Unified',
  perplexity: 'Perplexity AI',
  cohere: 'Cohere Enterprise',
  deepinfra: 'DeepInfra',
  replicate: 'Replicate Cloud',
  novita: 'Novita AI',
  huggingface: 'Hugging Face',
  elevenlabs: 'ElevenLabs',
  deepgram: 'Deepgram',
  hume: 'Hume AI EVI',
  cartesia: 'Cartesia Sonic',
  playht: 'PlayHT',
  ollama: 'Ollama Local',
  lmstudio: 'LM Studio',
  vllm: 'vLLM Engine',
  llamacpp: 'llama.cpp',
  cloudflare: 'Cloudflare Workers AI',
  nvidia: 'NVIDIA NIM',
  qwen: 'Qwen Cloud / DashScope',
  mimo: 'Xiaomi MiMo',
  tokenhub: 'Tencent TokenHub',
  zai: 'Z.AI / GLM',
  kimi: 'Kimi / Moonshot',
  stepfun: 'StepFun Step Plan',
  minimax: 'MiniMax',
  ollamacloud: 'Ollama Cloud',
  arcee: 'Arcee AI',
  gmi: 'GMI Cloud',
  kilo: 'Kilo Gateway',
  opencode: 'OpenCode Zen',
  upstage: 'Upstage Solar',
  custom: 'Custom endpoint',
};
const PROVIDER_MODE: Record<MainAgentProvider, MainAgentMode> = MODEL_PROVIDER_MODE;
const PROVIDER_ACCENT: Record<string, string> = {
  gemini: 'text-zinc-200 border-white/[0.10] bg-white/[0.045]',
  mistral: 'text-zinc-200 border-white/[0.10] bg-white/[0.045]',
  openai: 'text-zinc-200 border-white/[0.10] bg-white/[0.045]',
  openrouter: 'text-zinc-200 border-white/[0.10] bg-white/[0.045]',
  groq: 'text-zinc-200 border-white/[0.10] bg-white/[0.045]',
  anthropic: 'text-zinc-200 border-white/[0.10] bg-white/[0.045]',
};

// These are checked-in brand assets fetched from the providers or established
// brand libraries. Missing entries intentionally use the neutral provider glyph
// below instead of displaying an invented provider-specific logo.
const PROVIDER_ICON_PATH: Record<string, string> = {
  gemini: '/icons/providers/gemini.svg',
  openai: '/icons/providers/openai.svg',
  anthropic: '/icons/providers/anthropic.svg',
  grok: '/icons/providers/grok.svg',
  deepseek: '/icons/providers/deepseek.ico',
  mistral: '/icons/providers/mistral.ico',
  groq: '/icons/providers/groq.svg',
  cerebras: '/icons/providers/cerebras.svg',
  sambanova: '/icons/providers/sambanova.ico',
  together: '/icons/providers/together-favicon.ico',
  fireworks: '/icons/providers/fireworks.ico',
  openrouter: '/icons/providers/openrouter.svg',
  perplexity: '/icons/providers/perplexity.svg',
  cohere: '/icons/providers/cohere.ico',
  deepinfra: '/icons/providers/deepinfra.ico',
  replicate: '/icons/providers/replicate.svg',
  novita: '/icons/providers/novita.ico',
  huggingface: '/icons/providers/huggingface.ico',
  elevenlabs: '/icons/providers/elevenlabs.svg',
  deepgram: '/icons/providers/deepgram.ico',
  hume: '/icons/providers/hume.ico',
  cartesia: '/icons/providers/cartesia.ico',
  playht: '/icons/providers/playht.ico',
  ollama: '/icons/providers/ollama.svg',
  lmstudio: '/icons/providers/lmstudio.ico',
  vllm: '/icons/providers/vllm.ico',
  llamacpp: '/icons/providers/llamacpp.svg',
  cloudflare: '/icons/providers/cloudflare.svg',
  nvidia: '/icons/providers/nvidia.ico',
  qwen: '/icons/providers/qwen.svg',
  mimo: '/icons/providers/mimo.ico',
  tokenhub: '/icons/providers/tokenhub.ico',
  zai: '/icons/providers/zai.svg',
  kimi: '/icons/providers/kimi.ico',
  stepfun: '/icons/providers/stepfun.svg',
  minimax: '/icons/providers/minimax.ico',
  ollamacloud: '/icons/providers/ollama.svg',
  arcee: '/icons/providers/arcee.ico',
  gmi: '/icons/providers/gmi.ico',
  kilo: '/icons/providers/kilo.ico',
  opencode: '/icons/providers/opencode.svg',
  upstage: '/icons/providers/upstage.png',
  custom: '/icons/providers/custom.svg',
};

const PROVIDER_ICON_COLOR: Record<string, string> = {
  openai: '#10A37F',
  anthropic: '#D97757',
  grok: '#D4D4D8',
  deepseek: '#5786FE',
  mistral: '#FA520F',
  groq: '#F55036',
  openrouter: '#94A3B8',
  perplexity: '#1FB8CD',
  replicate: '#A3A3A3',
  elevenlabs: '#D4D4D8',
  ollama: '#D4D4D8',
  vllm: '#30A2FF',
  llamacpp: '#A6CE39',
  cloudflare: '#F38020',
  qwen: '#6950EF',
  kimi: '#F2488C',
  minimax: '#E73562',
  ollamacloud: '#D4D4D8',
  opencode: '#22C55E',
  custom: '#607D8B',
};

const PROVIDER_ICON_INTRINSIC_COLOR = new Set(['gemini', 'groq', 'cerebras', 'llamacpp', 'stepfun', 'zai', 'custom']);

const PROVIDER_ICON_MASK_SIZE: Record<string, string> = {
  gemini: '76%',
  mistral: '82%',
  openai: '86%',
  openrouter: '84%',
  groq: '86%',
  anthropic: '82%',
  llamacpp: '92% auto',
};


interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: Tab | LegacyTab;
  onTabChange?: (tab: Tab) => void;
  standalone?: boolean;
}

type ContextChatSummary = {
  id: string;
  title: string;
  updatedAt: number;
  usedTokens: number;
  reportedWindow: number;
  modelMaximum: number;
  provider: string;
  modelId: string;
};

const formatTokenMetric = (tokens: number) => {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return Math.round(tokens).toLocaleString();
};

const sentenceCaseLabel = (value: string) => {
  const text = String(value || '').trim();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1).toLowerCase()}` : '';
};

const applyUiDensity = (fontSize: AppSettings['fontSize']) => {
  if (typeof document === 'undefined') return;
  const values = fontSize === 'compact'
    ? { size: '13px', lineHeight: '1.38' }
    : fontSize === 'comfortable'
      ? { size: '15px', lineHeight: '1.52' }
      : { size: '14px', lineHeight: '1.45' };
  document.documentElement.style.setProperty('--eterx-ui-font-size', values.size);
  document.documentElement.style.setProperty('--eterx-ui-line-height', values.lineHeight);
};

type TokenStats = {
  lifetimeTokens: number;
  peakTokens: number;
  longestChatMinutes: number;
  currentStreak: number;
  longestStreak: number;
  daily: Record<string, number>;
};

type TokenChatSummary = {
  id: string;
  title: string;
  updatedAt: number;
  totalTokens: number;
  promptTokens: number;
  cachedTokens: number;
  uncachedPromptTokens: number;
  outputTokens: number;
  recentRunUsage: number;
  model: string;
  actions: Array<{
    id: string;
    label: string;
    kind: string;
    tokens: number;
    promptTokens: number;
    cachedTokens: number;
    uncachedPromptTokens: number;
    outputTokens: number;
    model: string;
    timestamp: number;
  }>;
};

type StoredTokenMetrics = {
  processedTokens: number;
  promptTokens: number;
  cachedTokens: number;
  uncachedPromptTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  toolUsePromptTokens: number;
};

const EMPTY_TOKEN_STATS: TokenStats = {
  lifetimeTokens: 0,
  peakTokens: 0,
  longestChatMinutes: 0,
  currentStreak: 0,
  longestStreak: 0,
  daily: {},
};

const EMPTY_STORED_TOKEN_METRICS: StoredTokenMetrics = {
  processedTokens: 0,
  promptTokens: 0,
  cachedTokens: 0,
  uncachedPromptTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  toolUsePromptTokens: 0,
};

const tokenMetricsForStoredLog = (log: any): StoredTokenMetrics => {
  if (!log || log.type !== 'model_usage') return EMPTY_STORED_TOKEN_METRICS;
  const usage = log.usageMetadata || log.usage || log;
  const optionalMetric = (...values: unknown[]): number | undefined => {
    for (const value of values) {
      if (value === undefined || value === null || value === '') continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return undefined;
  };
  const metric = (...values: unknown[]) => optionalMetric(...values) ?? 0;
  const promptTokens = metric(
    log.promptTokens, log.prompt_tokens, log.inputTokens, log.input_tokens,
    log.totalInputTokens, log.total_input_tokens,
    usage.promptTokens, usage.prompt_tokens, usage.inputTokens, usage.input_tokens,
    usage.promptTokenCount, usage.prompt_token_count, usage.inputTokenCount,
    usage.totalInputTokens, usage.total_input_tokens,
  );
  const completionTokens = metric(
    log.completionTokens, log.completion_tokens,
    usage.completionTokens, usage.completion_tokens,
  );
  const visibleOutputTokens = metric(
    log.visibleOutputTokens, log.visible_output_tokens,
    usage.visibleOutputTokens, usage.visible_output_tokens,
    usage.candidatesTokenCount, usage.candidates_token_count, usage.responseTokenCount,
  );
  const legacyOutputTokens = metric(
    log.outputTokens, log.output_tokens, log.totalOutputTokens, log.total_output_tokens,
    usage.outputTokens, usage.output_tokens, usage.outputTokenCount,
    usage.candidatesTokenCount, usage.candidates_token_count, usage.responseTokenCount,
    usage.totalOutputTokens, usage.total_output_tokens,
  );
  const total = metric(
    log.totalTokens, log.total_tokens, usage.totalTokens, usage.total_tokens,
    usage.totalTokenCount, usage.total_token_count,
  );
  const reasoning = metric(
    log.reasoningTokens, log.reasoning_tokens, usage.reasoningTokens, usage.reasoning_tokens,
    log.totalThoughtTokens, log.total_thought_tokens,
    usage.thoughtsTokenCount, usage.thoughts_token_count, usage.thoughtTokenCount,
    usage.totalThoughtTokens, usage.total_thought_tokens,
  );
  const toolUsePrompt = metric(
    log.toolUsePromptTokens, log.tool_use_prompt_tokens,
    log.totalToolUseTokens, log.total_tool_use_tokens,
    usage.toolUsePromptTokens, usage.tool_use_prompt_tokens,
    usage.toolUsePromptTokenCount, usage.tool_use_prompt_token_count,
    usage.totalToolUseTokens, usage.total_tool_use_tokens,
  );
  const measuredCachedTokens = metric(
    log.cachedTokens, log.cached_tokens, log.totalCachedTokens, log.total_cached_tokens,
    usage.cachedTokens, usage.cached_tokens, usage.cacheReadTokens,
    usage.cachedContentTokenCount, usage.cached_content_token_count,
    usage.totalCachedTokens, usage.total_cached_tokens,
  );
  const cachedTokens = promptTokens > 0
    ? Math.min(promptTokens, measuredCachedTokens)
    : measuredCachedTokens;
  const explicitUncachedPromptTokens = optionalMetric(
    log.uncachedPromptTokens, log.uncached_prompt_tokens,
    usage.uncachedPromptTokens, usage.uncached_prompt_tokens,
  );
  const uncachedPromptTokens = explicitUncachedPromptTokens
    ?? Math.max(0, promptTokens - cachedTokens);
  const generatedTokens = metric(
    log.generatedTokens, log.generated_tokens,
    usage.generatedTokens, usage.generated_tokens,
  ) || completionTokens || (visibleOutputTokens > 0
    ? visibleOutputTokens + reasoning
    : legacyOutputTokens);
  // tool-use prompt tokens are diagnostic subdivisions of provider input, not
  // a separate bucket to add again. Provider total remains authoritative.
  const fallbackTotal = promptTokens + generatedTokens;

  return {
    // Provider total is authoritative. Component arithmetic is only a fallback
    // for adapters that omit their aggregate usage field.
    processedTokens: total > 0 ? total : fallbackTotal,
    promptTokens,
    cachedTokens,
    uncachedPromptTokens,
    outputTokens: generatedTokens,
    reasoningTokens: reasoning,
    toolUsePromptTokens: toolUsePrompt,
  };
};

const tokenCountForStoredLog = (log: any): number =>
  tokenMetricsForStoredLog(log).processedTokens;

const sumStoredTokenMetrics = (logs: any[]): StoredTokenMetrics =>
  logs.reduce((totals, log) => {
    const metrics = tokenMetricsForStoredLog(log);
    totals.processedTokens += metrics.processedTokens;
    totals.promptTokens += metrics.promptTokens;
    totals.cachedTokens += metrics.cachedTokens;
    totals.uncachedPromptTokens += metrics.uncachedPromptTokens;
    totals.outputTokens += metrics.outputTokens;
    totals.reasoningTokens += metrics.reasoningTokens;
    totals.toolUsePromptTokens += metrics.toolUsePromptTokens;
    return totals;
  }, { ...EMPTY_STORED_TOKEN_METRICS });

const TOKEN_ACTIVITY_CELL_COUNT = 200;

const buildTokenActivityDates = (endAt = Date.now()) => {
  const start = new Date(endAt);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return Array.from({ length: TOKEN_ACTIVITY_CELL_COUNT }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
};

const dayKey = (value: number) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return '';
  // Runtime traces from older providers can store Unix seconds while newer
  // traces use milliseconds. Normalize both before mapping into a cell.
  const timestamp = numericValue < 10_000_000_000 ? numericValue * 1000 : numericValue;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const normalizeSettingsTab = (tab: any): Tab => {
  const validTabs: Tab[] = [
    'general',
    'profile',
    'appearance',
    'configuration',
    'personalization',
    'shortcuts',
    'tokens',
    'mcp',
    'hooks',
    'context',
    'models',
    'api',
    'live-convo',
    'git',
    'environments',
    'worktrees',
    'browser',
    'computer',
    'updates',
    'archives'
  ];

  switch (tab) {
    case 'account':
      return 'profile';
    case 'agent':
      return 'configuration';
    case 'api':
      return 'api';
    case 'live':
    case 'liveconvo':
    case 'live-convo':
      return 'live-convo';
    case 'connections':
      return 'models';
    case 'advanced':
      return 'environments';
    default:
      return validTabs.includes(tab) ? tab : 'general';
  }
};

// ─── Custom Toggle ─────────────────────────────────────
const Toggle: React.FC<{ enabled: boolean; onChange: (v: boolean) => void; disabled?: boolean }> = ({ enabled, onChange, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={enabled}
    aria-label={enabled ? 'Enabled' : 'Disabled'}
    disabled={disabled}
    onClick={() => !disabled && onChange(!enabled)}
    className={`relative w-[42px] h-[24px] rounded-full transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] shrink-0 ${ disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
      } ${ enabled ? 'bg-[#2F8BEF] shadow-none' : 'bg-[#D7D7D2] hover:bg-[#C9C9C2] dark:bg-white/10 dark:hover:bg-white/15' }`}
  >
    <motion.div
      animate={{ x: enabled ? 20 : 2 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      className="absolute left-0 top-[3px] w-[18px] h-[18px] rounded-full bg-white shadow-none"
    />
  </button>
);

// ─── Slider ────────────────────────────────────────────
// ─── Setting Row ───────────────────────────────────────
const SettingRow: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
  danger?: boolean;
}> = ({ icon, title, description, children, danger }) => (
  <div data-danger={danger || undefined} className={`eterx-setting-row mb-2 flex items-center justify-between rounded-lg border px-5 py-4 group ${ danger ? 'border-red-500/20 bg-red-500/10' : 'border-white/[0.08] bg-[#202020]' }`}>
    <div className="flex items-start gap-3 flex-1 min-w-0 mr-4">
      <div className={`hidden sm:flex mt-0.5 p-1.5 rounded-md shrink-0 ${ danger ? 'bg-red-500/10 text-red-400' : 'text-[#A8A8A8] group-hover:text-[#F1F1F1]' } transition-colors`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className={`eterx-setting-label text-[13.5px] font-medium ${ danger ? 'text-red-300' : 'text-[#F1F1F1]' }`}>{title}</div>
        <div className="eterx-setting-description text-[13px] text-[#A5A5A5] mt-1 leading-relaxed">{description}</div>
      </div>
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

// ─── Section Header ────────────────────────────────────
const InfoHint: React.FC<{ text: string; className?: string }> = ({ text, className = '' }) => (
  <span className={`group/info relative inline-flex shrink-0 items-center ${className}`}>
    <span className="grid h-5 w-5 place-items-center rounded-full border border-white/[0.08] bg-white/[0.045] text-[#A7A7A7] transition-colors hover:border-white/[0.16] hover:bg-white/[0.08] hover:text-[#F1F1F1]">
      <Info className="h-3 w-3" strokeWidth={2.2} />
    </span>
    <span className="pointer-events-none absolute left-1/2 top-[calc(100%+8px)] z-[80] w-[260px] -translate-x-1/2 rounded-xl border border-white/[0.10] bg-[#111111] px-3 py-2 text-[11.5px] font-medium leading-5 text-[#D6D6D6] opacity-0 shadow-none transition-opacity duration-150 group-hover/info:opacity-100">
      {text}
    </span>
  </span>
);

const SectionHeader: React.FC<{ title: string; badge?: string; info?: string }> = ({ title, badge, info }) => (
  <div className="flex items-center gap-2 mb-4 mt-10 first:mt-0">
    <span className="text-[14px] font-semibold text-[#F1F1F1] tracking-tight">{title}</span>
    {info && <InfoHint text={info} />}
    {badge && (
      <span className="text-[10px] font-bold bg-white/[0.075] text-[#D7D7D7] px-2 py-0.5 rounded-full tracking-wider">{sentenceCaseLabel(badge)}</span>
    )}
  </div>
);

// ─── API Key Row ───────────────────────────────────────
const SettingsStack: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="eterx-settings-stack overflow-visible rounded-xl border border-white/[0.09] bg-[#202020]">
    {children}
  </div>
);

const SettingsStackRow: React.FC<{
  title: string;
  description?: string;
  children?: React.ReactNode;
  tall?: boolean;
  info?: string;
}> = ({ title, description, children, tall, info }) => (
  <div className={`eterx-settings-stack-row flex ${tall ? 'flex-col items-start gap-3' : 'items-center justify-between gap-6'} border-b border-white/[0.07] px-5 last:border-b-0 ${tall ? 'py-4' : 'py-3.5'}`}>
    <div className={`min-w-0 ${tall ? 'w-full' : 'flex-1'}`}>
      <div className="eterx-setting-label flex items-center gap-2 text-[13px] font-medium leading-tight text-[#F1F1F1]">
        <span>{title}</span>
        {info && <InfoHint text={info} />}
      </div>
      {description && <div className="eterx-setting-description mt-1 max-w-full text-[12px] leading-relaxed text-[#A7A7A7]">{description}</div>}
    </div>
    {children && <div className={`flex ${tall ? 'w-full' : 'shrink-0'} items-center justify-end gap-2`}>{children}</div>}
  </div>
);

const SelectControl: React.FC<{
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  width?: string;
}> = ({ value, onChange, options, width = 'w-[240px]' }) => (
  <div className={`relative ${width} shrink-0`}>
    <ModernSelect value={value} onChange={onChange} options={options} />
  </div>
);

const SegmentedControl = <T extends string,>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
}) => (
  <div className="inline-flex items-center gap-1">
    {options.map(option => (
      <button
        key={option.value}
        type="button"
        onClick={() => onChange(option.value)}
        aria-pressed={value === option.value}
        className={`eterx-settings-segment rounded-full px-2.5 py-1 text-[12.5px] font-medium transition-colors ${
          value === option.value ? 'bg-[#303030] text-[#F2F2F2]' : 'text-[#A7A7A7] hover:bg-white/[0.045] hover:text-[#F2F2F2]'
        }`}
      >
        {option.label}
      </button>
    ))}
  </div>
);

const ThemePreviewSelector: React.FC<{
  value: AppSettings['theme'];
  onChange: (value: AppSettings['theme']) => void;
}> = ({ value, onChange }) => {
  const options: Array<{ value: AppSettings['theme']; label: string }> = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  const preview = (theme: AppSettings['theme']) => {
    const isSystem = theme === 'system';
    const isDark = theme === 'dark';

    return (
      <div
        className="relative aspect-[1.42/1] w-full overflow-hidden rounded-[11px]"
        style={{ background: isSystem ? 'linear-gradient(90deg, #a8a8a8 0 50%, #626262 50% 100%)' : isDark ? '#626262' : '#f3f3f3' }}
      >
        <div
          className="absolute left-[27%] top-[22%] h-[5%] w-[46%] rounded-full"
          style={{ background: isSystem ? 'linear-gradient(90deg, #dadada 0 50%, #aaa 50% 100%)' : isDark ? '#aaa' : '#d1d1d1' }}
        />
        <div
          className="absolute left-[15%] top-[30%] h-[3%] w-[70%] rounded-full"
          style={{ background: isSystem ? 'linear-gradient(90deg, #e0e0e0 0 50%, #9a9a9a 50% 100%)' : isDark ? '#9c9c9c' : '#dedede' }}
        />
        <div
          className="absolute left-[9%] top-[37%] h-[72%] w-[82%] overflow-hidden rounded-t-[14px]"
          style={{ background: isSystem ? 'linear-gradient(90deg, #f5f5f5 0 50%, #373737 50% 100%)' : '#fff' }}
        >
          {[0, 1, 2].map(index => (
            <div
              key={index}
              className="relative h-[28%] border-b"
              style={{ borderColor: isSystem ? '#686868' : '#e8e8e8' }}
            >
              <span
                className="absolute left-[5%] top-[24%] h-[20%] w-[29%] rounded-full"
                style={{ background: isSystem ? 'linear-gradient(90deg, #d8d8d8 0 50%, #727272 50% 100%)' : '#d9d9d9' }}
              />
              <span
                className="absolute left-[5%] top-[58%] h-[9%] w-[46%] rounded-full"
                style={{ background: isSystem ? 'linear-gradient(90deg, #ececec 0 50%, #505050 50% 100%)' : '#eeeeee' }}
              />
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-3">
      {options.map(option => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            aria-label={`Use ${option.label.toLowerCase()} theme`}
            onClick={() => onChange(option.value)}
            className="group min-w-0 rounded-[13px] text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2F8BEF] focus-visible:ring-offset-2 focus-visible:ring-offset-[#202020]"
          >
            <div
              className={`rounded-[13px] border-2 p-[2px] transition-all duration-200 ${selected ? 'border-[#2F8BEF]' : 'border-transparent group-hover:border-white/25'}`}
            >
              {preview(option.value)}
            </div>
            <span className={`mt-2 block text-[13px] font-medium transition-colors ${selected ? 'text-[#F4F4F4]' : 'text-[#A7A7A7] group-hover:text-[#E7E7E7]'}`}>
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
};

const SoftButton: React.FC<{ children: React.ReactNode; onClick?: () => void; disabled?: boolean }> = ({ children, onClick, disabled = false }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className="rounded-lg bg-[#303030] px-3 py-1.5 text-[12.5px] font-medium text-[#F2F2F2] transition-colors hover:bg-[#393939] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#303030]"
  >
    {children}
  </button>
);

const ApiKeyPoolEditor: React.FC<{
  provider: string;
  providerLabel: string;
  value: string;
  sync?: ApiProviderStatus;
  onChange: (value: string) => void;
  minRows?: number;
  maxRows?: number;
  scopeControl?: React.ReactNode;
  showTest?: boolean;
  testEndpoint?: string;
  testBaseURL?: string;
  testBody?: (key: string) => Record<string, unknown>;
  testProvider?: string;
}> = ({ provider, providerLabel, value, sync, onChange, minRows = 1, maxRows, scopeControl, showTest = true, testEndpoint, testBaseURL, testBody, testProvider }) => {
  const buildRows = useCallback((rawValue: string) => {
    const parsed = splitApiKeyPool(rawValue).slice(0, maxRows || Number.POSITIVE_INFINITY);
    const rowCount = Math.max(minRows, parsed.length || 1);
    return Array.from({ length: rowCount }, (_, index) => parsed[index] || '');
  }, [maxRows, minRows]);

  const [rows, setRows] = useState<string[]>(() => {
    const parsed = splitApiKeyPool(value).slice(0, maxRows || Number.POSITIVE_INFINITY);
    const rowCount = Math.max(minRows, parsed.length || 1);
    return Array.from({ length: rowCount }, (_, index) => parsed[index] || '');
  });
  const [visibleRows, setVisibleRows] = useState<Record<number, boolean>>({});
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [testingStatus, setTestingStatus] = useState<Record<number, 'idle' | 'testing' | 'success' | 'failed'>>({});
  const keyRowsRevision = useRef(0);
  const acknowledgedKeyPool = useRef(serializeApiKeyPool(splitApiKeyPool(value)));

  useEffect(() => {
    const normalizedValue = serializeApiKeyPool(splitApiKeyPool(value));
    if (normalizedValue !== acknowledgedKeyPool.current) {
      // A preference reload or another window can replace the keys too.
      // Results for the previous keys must not label the new pool as tested.
      keyRowsRevision.current += 1;
      setTestingStatus({});
      setVisibleRows({});
      setCopiedIndex(null);
    }
    acknowledgedKeyPool.current = normalizedValue;
    // Keep the focused draft/explicit empty row when the parent acknowledges
    // our own edit. Rebuilding on each keystroke shifted and collapsed rows.
    setRows(previous => serializeApiKeyPool(previous) === serializeApiKeyPool(splitApiKeyPool(value))
      ? previous : buildRows(value));
  }, [buildRows, provider, value]);

  useEffect(() => {
    keyRowsRevision.current += 1;
    setVisibleRows({});
    setCopiedIndex(null);
    setDraggedIndex(null);
    setTestingStatus({});
  }, [provider, testEndpoint, testBaseURL, testProvider]);

  const commitRows = useCallback((nextRows: string[]) => {
    const serialized = serializeApiKeyPool(nextRows);
    acknowledgedKeyPool.current = serialized;
    onChange(serialized);
  }, [onChange]);

  const testKeyConnection = async (index: number, key: string) => {
    if (!key.trim()) return;
    const revision = keyRowsRevision.current;
    setTestingStatus(prev => ({ ...prev, [index]: 'testing' }));
    try {
      const res = await fetch(testEndpoint || '/api/settings/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(testEndpoint
            ? (testBody ? testBody(key.trim()) : { provider, key: key.trim(), baseURL: testBaseURL || '' })
            : { apiKeys: { [provider]: key.trim() }, providers: [provider] })
        }),
      });
      const data = await res.json();
      if (revision !== keyRowsRevision.current) return;
      if (res.ok && data?.ok && (testEndpoint
        ? data?.provider === provider || data?.provider === testProvider
        : data?.providers?.[provider]?.connected)) {
        setTestingStatus(prev => ({ ...prev, [index]: 'success' }));
      } else {
        setTestingStatus(prev => ({ ...prev, [index]: 'failed' }));
      }
    } catch {
      if (revision === keyRowsRevision.current) setTestingStatus(prev => ({ ...prev, [index]: 'failed' }));
    }
  };

  const updateRow = (index: number, rawValue: string) => {
    keyRowsRevision.current += 1;
    // Every in-flight test belongs to the old row layout. Pasting can insert
    // several rows, so invalidate all statuses as well as their responses.
    setTestingStatus({});
    setCopiedIndex(null);
    const pastedKeys = splitApiKeyPool(rawValue);
    const next = [...rows];
    if (pastedKeys.length > 1) next.splice(index, 1, ...pastedKeys);
    else next[index] = rawValue;
    const bounded = next.slice(0, maxRows || Number.POSITIVE_INFINITY);
    setRows(bounded.length ? bounded : buildRows(''));
    commitRows(bounded);
  };

  const addRow = () => {
    if (maxRows && rows.length >= maxRows) return;
    setRows(prev => [...prev, '']);
  };

  const moveRow = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    if (fromIndex >= rows.length || toIndex >= rows.length) return;
    keyRowsRevision.current += 1;
    const next = [...rows];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setRows(next);
    setVisibleRows({});
    setTestingStatus({});
    setCopiedIndex(null);
    commitRows(next);
  };

  const removeRow = (index: number) => {
    keyRowsRevision.current += 1;
    const next = rows.filter((_, rowIndex) => rowIndex !== index);
    const safeNext = next.length >= minRows ? next : [...next, ...Array.from({ length: minRows - next.length }, () => '')];
    setRows(safeNext);
    setVisibleRows({});
    setTestingStatus({});
    setCopiedIndex(null);
    commitRows(safeNext);
  };

  const clearPool = () => {
    keyRowsRevision.current += 1;
    setRows(buildRows(''));
    setVisibleRows({});
    setTestingStatus({});
    setCopiedIndex(null);
    commitRows([]);
  };

  const copyRow = async (index: number, key: string) => {
    if (!key.trim()) return;
    const revision = keyRowsRevision.current;
    try {
      const didCopy = await safeCopyTextToClipboard(key.trim());
      if (!didCopy || revision !== keyRowsRevision.current) return;
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex(null), 900);
    } catch {
      setCopiedIndex(null);
    }
  };

  const handleKeyPaste = async (event: React.ClipboardEvent<HTMLInputElement>, index: number) => {
    const revision = keyRowsRevision.current;
    // Apply paste through the controlled value. This avoids a macOS Electron
    // renderer dropping the native paste event while keeping selection
    // replacement behavior for a single key and pool expansion for multiline
    // or comma-separated values.
    const target = event.currentTarget;
    const currentValue = target.value || rows[index] || '';
    const start = Math.max(0, Math.min(target.selectionStart ?? currentValue.length, currentValue.length));
    const end = Math.max(start, Math.min(target.selectionEnd ?? start, currentValue.length));
    const eventValue = event.clipboardData.getData('text/plain') || event.clipboardData.getData('text');

    // Cancel before awaiting the native fallback so the renderer cannot also
    // apply the browser's default paste after this controlled update.
    event.preventDefault();
    const pastedValue = eventValue || await safeReadTextFromClipboard();
    if (!pastedValue || revision !== keyRowsRevision.current) return;

    const pastedKeys = splitApiKeyPool(pastedValue);
    if (pastedKeys.length > 1) {
      updateRow(index, pastedValue);
      return;
    }
    updateRow(index, `${currentValue.slice(0, start)}${pastedValue}${currentValue.slice(end)}`);
  };

  const cleanRows = rows.map(row => row.trim());
  const configuredCount = splitApiKeyPool(value).length;
  const acceptedCount = sync?.accepted ? sync.count : 0;
  const invalidCount = Math.max(0, configuredCount - acceptedCount);
  const hasScroll = rows.length > 3;

  return (
    <div className="w-[520px] max-w-[52vw] space-y-3">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#171717] px-3 py-2">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-[#F1F1F1]">
            <span className="truncate">{providerLabel} pool</span>
          </div>
          <div className="mt-1 text-[11px] text-[#8F8F8F]">
            Drag rows to set priority. Valid keys sync to the local gateway in real time.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {scopeControl}
          <span className="rounded-full border border-white/[0.08] bg-white/[0.045] px-2 py-1 text-[11px] font-medium text-[#D8D8D8]">
            {acceptedCount || configuredCount} active
          </span>
          {(!maxRows || rows.length < maxRows) && <button
              type="button"
              onClick={addRow}
              className="inline-flex h-8 items-center gap-1 rounded-lg bg-[#303030] px-2.5 text-[12px] font-medium text-[#F2F2F2] transition-colors hover:bg-[#393939]"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>}
        </div>
      </div>

      <div className={`${hasScroll ? 'max-h-[360px] overflow-y-auto pr-1 eterx-scrollbar' : ''} space-y-2`}>
        {rows.map((row, index) => {
          const keyValue = row.trim();
          const duplicate = Boolean(keyValue) && cleanRows.findIndex(key => key === keyValue) !== index;
          const valid = providerKeyLooksValid(provider, keyValue);
          const rowStatus = !keyValue
            ? 'Empty'
            : duplicate
              ? 'Duplicate'
              : valid
                ? 'Ready'
                : 'Check';
          const isVisible = visibleRows[index] === true;

          return (
            <div
              key={`${provider}-${index}`}
              onDragOver={(event) => {
                if (draggedIndex !== null) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (draggedIndex !== null) moveRow(draggedIndex, index);
                setDraggedIndex(null);
              }}
              className={`rounded-xl border border-white/[0.08] bg-[#202020] p-2.5 transition-colors ${draggedIndex === index ? 'border-white/25 bg-[#292929]' : ''}`}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    draggable
                    onDragStart={(event) => {
                      setDraggedIndex(index);
                      event.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => setDraggedIndex(null)}
                    className="grid h-6 w-6 cursor-grab place-items-center rounded-md text-[#777] transition-colors hover:bg-white/[0.06] hover:text-[#D8D8D8] active:cursor-grabbing"
                    title="Drag to reorder key priority"
                    aria-label={`Drag API key slot ${index + 1}`}
                  >
                    <GripVertical className="h-3.5 w-3.5" />
                  </button>
                  <span className="text-[11px] font-semibold tracking-[0.08em] text-[#8E8E8E]">
                    Slot {String(index + 1).padStart(2, '0')}
                  </span>
                </div>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-[0.08em] ${
                  rowStatus === 'Ready'
                    ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
                    : rowStatus === 'Check' || rowStatus === 'Duplicate'
                      ? 'border-amber-500/20 bg-amber-500/10 text-amber-300'
                      : 'border-white/[0.08] bg-white/[0.035] text-[#777]'
                }`}>
                  {sentenceCaseLabel(rowStatus)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={row}
                  onChange={(event) => updateRow(index, event.target.value)}
                  onPaste={(event) => { void handleKeyPaste(event, index); }}
                  data-eterx-paste-handler="controlled"
                  type={isVisible ? 'text' : 'password'}
                  spellCheck={false}
                  placeholder={index === 0 ? 'Paste provider API key' : 'Paste another key'}
                  className="h-9 min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-[#141414] px-3 text-[12px] font-mono text-[#F1F1F1] outline-none transition-colors placeholder:text-[#666] focus:border-white/[0.20]"
                />
                {showTest && <button
                  type="button"
                  onClick={() => setVisibleRows(prev => ({ ...prev, [index]: !prev[index] }))}
                  className="grid h-9 w-9 place-items-center rounded-lg bg-white/[0.045] text-[#A7A7A7] transition-colors hover:bg-white/[0.08] hover:text-[#F1F1F1]"
                  title={isVisible ? 'Hide key' : 'Show key'}
                >
                  {isVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>}
                <button
                  type="button"
                  onClick={() => testKeyConnection(index, row)}
                  disabled={!keyValue || testingStatus[index] === 'testing'}
                  className={`inline-flex h-9 items-center justify-center gap-1 rounded-lg px-2 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                    testingStatus[index] === 'testing'
                      ? 'bg-white/[0.045] text-[#A7A7A7]'
                      : testingStatus[index] === 'success'
                        ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                        : testingStatus[index] === 'failed'
                          ? 'bg-red-500/10 text-red-300 border border-red-500/20'
                          : 'bg-white/[0.045] text-[#A7A7A7] hover:bg-white/[0.08] hover:text-[#F1F1F1]'
                  }`}
                  title="Test key connection"
                >
                  {testingStatus[index] === 'testing' ? (
                    <Spinner className="h-3.5 w-3.5" />
                  ) : testingStatus[index] === 'success' ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : testingStatus[index] === 'failed' ? (
                    <X className="h-3.5 w-3.5" />
                  ) : (
                    <span>Test</span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => copyRow(index, row)}
                  disabled={!keyValue}
                  className="grid h-9 w-9 place-items-center rounded-lg bg-white/[0.045] text-[#A7A7A7] transition-colors hover:bg-white/[0.08] hover:text-[#F1F1F1] disabled:cursor-not-allowed disabled:opacity-35"
                  title="Copy key"
                >
                  {copiedIndex === index ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => removeRow(index)}
                  disabled={rows.length === 1 && !keyValue}
                  className="grid h-9 w-9 place-items-center rounded-lg bg-white/[0.045] text-[#A7A7A7] transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-35"
                  title="Remove key"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {keyValue && !isVisible && (
                <div className="mt-2 truncate px-1 text-[11px] font-mono text-[#777]">
                  {maskApiKey(keyValue)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 text-[11px] text-[#8F8F8F]">
        <span>
          {invalidCount > 0 ? `${invalidCount} key${invalidCount === 1 ? '' : 's'} need review.` : 'Valid keys are synced into the local gateway only.'}
        </span>
        {configuredCount > 0 && (
          <button type="button" onClick={clearPool} className="text-[#BDBDBD] transition-colors hover:text-red-300">
            Clear pool
          </button>
        )}
      </div>
    </div>
  );
};

const SETTINGS_PNG_ICONS = new Set([
  'api', 'browser', 'computer', 'configuration', 'connections', 'context',
  'live-convo', 'mcp', 'models', 'personalization', 'profile'
]);

const SettingsIconAsset: React.FC<{ name: string; className?: string }> = ({ name, className = 'h-4 w-4' }) => {
  const isTokenIcon = name === 'tokens';
  const ext = isTokenIcon || SETTINGS_PNG_ICONS.has(name) ? 'png' : 'svg';
  const iconUrl = isTokenIcon ? '/tokens.png' : `/icons/settings/${name}.${ext}`;
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 bg-current ${className}`}
      style={{
        WebkitMask: `url(${iconUrl}) center / contain no-repeat`,
        mask: `url(${iconUrl}) center / contain no-repeat`,
      }}
    />
  );
};

const ProviderIconAsset: React.FC<{ provider: string; className?: string }> = ({ provider, className = 'h-4 w-4' }) => {
  const iconPath = PROVIDER_ICON_PATH[provider];
  if (!iconPath) return <Key className={className} />;
  if (/\.(?:ico|png|jpe?g|webp)$/i.test(iconPath) || PROVIDER_ICON_INTRINSIC_COLOR.has(provider)) {
    return <img aria-hidden="true" alt="" className={`shrink-0 object-contain ${className}`} src={iconPath} />;
  }
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 bg-current ${className}`}
      style={{
        color: PROVIDER_ICON_COLOR[provider],
        WebkitMask: `url(${iconPath}) center / ${PROVIDER_ICON_MASK_SIZE[provider] || '84%'} no-repeat`,
        mask: `url(${iconPath}) center / ${PROVIDER_ICON_MASK_SIZE[provider] || '84%'} no-repeat`,
      }}
    />
  );
};

const ProviderMark: React.FC<{ provider: string; className?: string }> = ({ provider, className = '' }) => (
  <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-white/[0.08] bg-white/[0.045] ${className}`}>
    <ProviderIconAsset provider={provider} className="h-4 w-4" />
  </span>
);

const MANUAL_GUIDES: Record<string, { title: string; intro: string; steps: Array<[string, string]>; tip: string }> = {
  'first-chat': {
    title: 'Start your first chat',
    intro: 'A good first request gives EterX-Agent a clear outcome, useful context, and a definition of what finished looks like.',
    steps: [
      ['Open a new chat', 'Return to the main workspace and start a fresh conversation when the task is unrelated to your previous work. Use a descriptive first message so the chat is easy to find later.'],
      ['Describe the outcome', 'Start with the result you want: “Prepare a launch checklist”, “Review this folder for risks”, or “Build a dashboard from this data.” Add audience, format, deadline, and constraints when they matter.'],
      ['Add context and files', 'Attach the relevant files or select the workspace that contains them. Tell the agent which files are authoritative and which files it may edit.'],
      ['Choose the model and agent', 'Use the model picker in the composer for model choice. Use the agent selector when a specialist or custom agent is better suited to the work.'],
      ['Review and steer', 'Read the plan, provide corrections early, and send follow-ups if priorities change. You can ask for a summary, a preview, or a smaller next step at any time.'],
    ],
    tip: 'The most reliable prompt pattern is: outcome + context + constraints + deliverable format.'
  },
  workspaces: {
    title: 'Workspaces, files, and changes',
    intro: 'Workspaces give the agent a safe place to understand project context and make focused changes without losing the conversation around them.',
    steps: [
      ['Choose a workspace', 'Use the workspace or folder control to select the project you want to work in. Keep unrelated projects separate so file context stays focused.'],
      ['Attach individual files', 'Attach a specific document, image, spreadsheet, or code file when the task depends on a small known set of inputs.'],
      ['Ask for inspection first', 'For unfamiliar projects, ask EterX-Agent to map the structure, identify relevant files, and summarize conventions before asking it to edit.'],
      ['Review every change', 'When files are edited, inspect the change summary and open the affected files. Ask for a diff, tests, or a rollback plan when the change is important.'],
      ['Keep generated work organized', 'Ask the agent to place outputs in a named folder and use predictable filenames. This keeps future chats and manual review simple.'],
    ],
    tip: 'For large projects, start with a scoped folder and a short task brief instead of attaching everything.'
  },
  agents: {
    title: 'Agents and work modes',
    intro: 'EterX-Agent combines a general workflow with specialist and custom agents so you can choose the right level of focus and autonomy.',
    steps: [
      ['Use General mode for everyday work', 'General mode is the best default for planning, writing, research, coding, file work, and routine questions.'],
      ['Use Autonomous mode for longer goals', 'Autonomous mode is useful when the work needs multiple steps, continued progress, or collaboration between the main agent and proxy work. Define the goal and boundaries clearly.'],
      ['Choose a specialist when useful', 'Select a configured specialist such as coding, research, design, or review when its instructions and tools match the task better than a broad general workflow.'],
      ['Build a custom agent when repeated', 'Create a custom agent when you have a stable role, tone, workflow, or tool policy you want to reuse. Give it a focused description and test it on a small request first.'],
      ['Control the handoff', 'Ask the active agent to explain what it is delegating, what evidence it received, and what remains for you to review.'],
    ],
    tip: 'Use the least specialized agent that can do the job well; add specialization when the workflow repeats or needs strict behavior.'
  },
  tasks: {
    title: 'Scheduled tasks and background work',
    intro: 'Tasks let EterX-Agent repeat work on a schedule and keep selected chats running when the main window is hidden.',
    steps: [
      ['Create a task from a clear prompt', 'Describe the recurring outcome, source context, expected output, schedule, and the agent or model it should use.'],
      ['Review the schedule', 'Confirm timezone, recurrence, next run, and whether the task should create a new chat or continue an existing one.'],
      ['Enable background operation', 'In General settings, configure the background companion and scheduled-chat behavior when you want work to continue while the window is closed or hidden.'],
      ['Inspect run history', 'Use the task history to review completed, failed, paused, and retried runs. Read the recorded output before changing the schedule.'],
      ['Pause or edit safely', 'Pause a task before changing its prompt, files, permissions, or provider settings when the next run could otherwise start with stale assumptions.'],
    ],
    tip: 'Start recurring tasks with a low-risk read-only report. Add editing or external actions only after the output is trustworthy.'
  },
  live: {
    title: 'Live conversation and voice',
    intro: 'Live Convo provides a hands-free way to talk with the agent through the selected provider’s documented native realtime transport while keeping the same app context controls.',
    steps: [
      ['Configure Live Convo', 'Open the Live Convo settings, add the selected provider’s dedicated Live key, and select a documented realtime model and voice from the catalog.'],
      ['Check the connection state', 'Wait for the provider catalog and connection status to become ready before starting. If the catalog is unavailable, check the key and endpoint first.'],
      ['Speak in short turns', 'Give one goal at a time, pause between instructions, and ask the agent to repeat important decisions before acting.'],
      ['Use app controls deliberately', 'Live tools can navigate settings, select agents, inspect tasks, and control supported app actions. Confirm consequential actions yourself.'],
      ['End or resume cleanly', 'Disconnect when finished and return to the text chat when you need files, long-form output, or a detailed review trail.'],
    ],
    tip: 'Voice is excellent for direction and exploration; text chat is better for precise specifications, code, and documents.'
  },
  'settings-guide': {
    title: 'Settings guide',
    intro: 'Settings are organized by the part of the app they control. Configure the essentials first, then tune behavior as you learn your workflow.',
    steps: [
      ['API', 'Add provider keys and verify that they sync successfully. Keys are used to connect model and external-service providers.'],
      ['Models', 'Choose a provider, load its current catalog, inspect capabilities and context limits, then add preferred models to the custom selector list.'],
      ['General', 'Set work mode, permissions, background behavior, terminal shell, destination defaults, follow-up behavior, notifications, and this manual.'],
      ['Profile and Personalization', 'Set identity, response preferences, tone, and instructions that should apply across conversations.'],
      ['Appearance and Shortcuts', 'Choose theme and density, then learn or configure keyboard shortcuts for faster navigation and common actions.'],
      ['External service, Browser, and Computer use', 'Configure web search providers and decide whether browser or computer actions are available to the agent. Review access carefully.'],
      ['Context, Tokens, and Archives', 'Inspect context usage, token reporting, older chats, and archived conversations when you need to manage history or performance.'],
    ],
    tip: 'For a new install, configure API → Models → General first. Everything else can be tuned after your first successful chat.'
  },
  troubleshooting: {
    title: 'Troubleshooting',
    intro: 'When something does not work, identify whether the issue is credentials, provider discovery, permissions, workspace context, or the running task itself.',
    steps: [
      ['No models appear', 'Confirm a valid key exists in API, the same provider is selected in Models, and the provider catalog request can reach its endpoint.'],
      ['A chat uses the wrong model', 'Check the active model in the composer, confirm the model is in the custom list, and verify that a saved model override is not taking priority.'],
      ['The agent cannot access a file', 'Confirm the correct workspace is selected, attach the file directly if needed, and check whether the requested action requires additional permissions.'],
      ['A task stopped or failed', 'Open its run history, read the first error, then check provider credentials, model availability, background settings, and the task’s file paths.'],
      ['Live Convo will not connect', 'Check the Live provider, API key, catalog status, selected model, voice availability, and network endpoint. Reconnect after changing credentials.'],
      ['The app feels slow', 'Reduce the task scope, use a faster model for exploration, archive irrelevant chats, and avoid attaching large unrelated folders.'],
    ],
    tip: 'When asking for help, include the exact screen, provider, model, action, and error message. Avoid sharing API keys or secrets.'
  },
};

type ManualDocumentSection = {
  title: string;
  paragraphs: string[];
  bullets?: string[];
  subSections?: Array<{ title: string; text: string }>;
};

const FULL_MANUAL_SECTIONS: ManualDocumentSection[] = [
  { title: 'Connecting a Model and API Provider', paragraphs: ['To connect a model and its API provider, first open the Models section and select the provider whose models you want to use.', 'By default, a provider may not display its complete or latest model list. To load all currently available models, you must add at least one API key for that provider.', 'Open the API section, select the relevant provider, and add at least one valid API key. After the API key has been added successfully, return to the Models section. The complete and updated list of models available from that provider will now appear.', 'Select the model you want to use and add it to your Custom Models list. You can add models from multiple providers and manage them together within the same custom list.', 'Once a model has been added, check the chat input bar. From there, you can select your preferred model, configure its thinking level, and adjust any other available model settings.'] },
  { title: 'Connecting External Services', paragraphs: ['External services, such as web search, image generation, and other integrations, can be configured from the Settings tab.', 'Open Settings, navigate to External Services, and select the appropriate provider for the service you want to use. Add the required API key or authentication credentials to complete the connection.', 'Once the credentials have been validated, the external service will be ready to use.', 'Depending on the selected provider, you may also be able to configure additional permissions, access controls, or provider-specific settings.'] },
  { title: 'Selecting an Agent and Operating Mode', paragraphs: ['From the chat input bar, you can select a built-in or custom agent.', 'The agent selector allows you to choose between the following operating modes:'], bullets: ['Chat Mode', 'Agent Mode', 'Autonomous Mode'], subSections: [{ title: 'Chat Mode', text: 'Chat Mode is designed for direct conversations and standard interactions with the selected model or agent.' }, { title: 'Agent Mode', text: 'Agent Mode allows the selected agent to use its available tools, instructions, memory, and connected services to complete more advanced tasks.' }, { title: 'Autonomous Mode', text: 'Autonomous Mode uses a proxy agent that works on your behalf. The proxy agent communicates with, guides, and supervises the main agent while the task is being completed. Select Autonomous Mode and send your first request; a separate proxy-agent panel will appear when the workflow begins.' }], },
  { title: 'Communicating with the Proxy Agent', paragraphs: ['You can communicate directly with the side proxy agent while working in Autonomous Mode.', 'The proxy agent manages proxy-related instructions, task supervision, preferences, and operating rules. You can provide instructions for the current task or define rules that should be followed during future workflows.', 'For example, you can tell the proxy agent:'], bullets: ['How frequently it should intervene', 'What actions require your approval', 'Which rules the main agent must always follow', 'How it should handle errors or uncertain results', 'How much autonomy the main agent should receive'], },
  { title: 'Background Tasks', paragraphs: ['To enable background task execution, open Settings, navigate to General, and turn on Background Tasks.', 'When background execution is enabled, supported tasks can continue running even after the main application window has been closed.', 'Background execution may depend on your operating system, application permissions, power settings, and the type of task being performed.'] },
  { title: 'Scheduling Tasks', paragraphs: ['To create a scheduled task, open the Tasks section within the application. Select the option to create a new task, then configure:'], bullets: ['The task instructions', 'The execution date and time', 'The recurrence schedule, if required', 'The agent or model that should perform the task', 'Any required tools, permissions, or connectors'], subSections: [{ title: 'Task management', text: 'The Tasks section allows you to view and manage active tasks, upcoming scheduled tasks, tasks that are currently running, completed tasks, task results, and execution history. Scheduled and completed tasks may also appear in the sidebar history so you can reopen and review them easily.' }] },
  { title: 'Running Multiple Agents in Parallel', paragraphs: ['The application supports running multiple agents in parallel.', 'This allows different agents to work on separate tasks or different parts of the same larger task at the same time.', 'For example, one agent may perform research while another analyzes files, writes documentation, tests code, or reviews the results. Parallel execution can help complete complex workflows more efficiently.'] },
  { title: 'Using Sub-Agents', paragraphs: ['Agents can create sub-agents to handle specialized, independent, or smaller parts of a task.', 'You can open an individual sub-agent to:'], bullets: ['View its current activity', 'Review its instructions', 'Monitor its progress', 'Communicate with it', 'Change its task', 'Stop its execution'], },
  { title: 'Creating a Custom Agent', paragraphs: ['To create your own custom agent, open the Agents section and start a conversation with the Builder Agent.', 'Describe the purpose of the agent and explain what you want it to do. You may provide information such as:'], bullets: ['The agent’s role', 'The tasks it should perform', 'Its preferred behavior', 'The tools it should use', 'The models it should access', 'Its permissions', 'Its response style', 'Its operating rules', 'Its memory and context requirements'], subSections: [{ title: 'After creation', text: 'The Builder Agent will use your instructions to create an advanced custom agent. Once created, it will appear in the agent selector and can be selected directly from the chat input bar.' }] },
  { title: 'Selecting a Custom Agent', paragraphs: ['Open the agent selector from the chat input bar and choose your custom agent from the available list.', 'After selecting the agent, choose the appropriate operating mode and send your request.', 'The custom agent will follow the tools, instructions, permissions, and behavior configured during its creation.'] },
  { title: 'Mounting and Using Connectors', paragraphs: ['The application supports conversational connectors and other service integrations.', 'Connectors allow agents to interact with supported external platforms, services, accounts, and data sources.', 'You can connect a supported service by providing the required access token, credentials, or authorization permissions. You may also ask the main agent to guide you through connector setup or complete supported parts of the connection process on your behalf.', 'Once a connector has been mounted and properly authorized, agents may use it to:'], bullets: ['Retrieve information', 'Search connected services', 'Access permitted files or data', 'Perform supported actions', 'Complete tasks across connected applications', 'Use connected information during conversations'], },
  { title: 'Connectors in Autonomous and Scheduled Tasks', paragraphs: ['When sufficient permissions are available, agents may use mounted connectors while performing autonomous, background, or scheduled tasks.', 'For example, an agent may use a connector to retrieve information, process connected data, perform an approved action, or complete a scheduled workflow.', 'Review connector permissions carefully and provide only the level of access required for the task.'] },
  { title: 'Checking for Application Updates', paragraphs: ['You can check for application updates at any time.', 'Open Settings, navigate to the Updates tab, and select Check for Updates.', 'The application will check whether a newer version is available.', 'If an update is available, the application will notify you and provide the available update options. Depending on your settings, the update may be downloaded or installed automatically, or the application may ask for your approval before continuing.', 'Follow the on-screen instructions to complete the update.'] },
  { title: 'Customizing the Application', paragraphs: ['The Settings section provides a wide range of options for customizing the application.', 'Review each settings category and adjust the application according to your preferences and workflow.', 'Changes will be applied based on the selected options, allowing you to personalize the application, agent behavior, interface, permissions, and overall workflow.'] },
];

const UserManualOverlay: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [activeSection, setActiveSection] = useState(0);
  const [query, setQuery] = useState('');
  const visibleSections = FULL_MANUAL_SECTIONS
    .map((section, index) => ({ section, index }))
    .filter(({ section }) => `${section.title} ${section.paragraphs.join(' ')} ${(section.bullets || []).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()));

  const jumpToSection = (index: number) => {
    setActiveSection(index);
    document.getElementById(`manual-section-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100001] flex items-start justify-center bg-black/55 px-3 pb-4 pt-12 backdrop-blur-md sm:px-6 sm:pb-6 sm:pt-14">
      <motion.div initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.22 }} className="relative flex h-[min(860px,calc(100vh-72px))] w-[min(1180px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl border border-white/[0.13] bg-[#151515] shadow-none">
        <header className="flex shrink-0 items-center justify-between border-b border-white/[0.09] bg-[#1B1B1B]/95 px-5 py-4 backdrop-blur-xl sm:px-7">
          <div className="min-w-0"><div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#76B9FF]">EterX-Agent documentation</div><h2 className="mt-1 truncate text-[19px] font-semibold tracking-[-0.02em] text-[#F4F4F4] sm:text-[21px]">Application Setup and Usage Guide</h2><p className="mt-1 hidden text-[12px] text-[#8F8F8F] sm:block">Everything you need to connect, configure, and operate the app.</p></div>
          <button type="button" onClick={onClose} className="ml-4 shrink-0 rounded-lg border border-white/[0.1] px-3 py-2 text-[12px] font-medium text-[#D8D8D8] transition-colors hover:bg-white/[0.07]">Close</button>
        </header>
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-[265px] shrink-0 flex-col border-r border-white/[0.08] bg-[#181818] lg:flex">
            <div className="border-b border-white/[0.07] p-4"><div className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-[#777]">Contents</div><div className="relative"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#777]" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search the manual" className="h-9 w-full rounded-lg border border-white/[0.09] bg-[#121212] pl-8 pr-3 text-[12px] text-[#F1F1F1] outline-none placeholder:text-[#666] focus:border-[#3D9BFF]/50" /></div></div>
            <nav className="eterx-scrollbar flex-1 overflow-y-auto p-3">{visibleSections.map(({ section, index }) => <button key={section.title} type="button" onClick={() => jumpToSection(index)} className={`mb-1 flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors ${activeSection === index ? 'bg-[#2B3B4D] text-[#F1F1F1]' : 'text-[#A2A2A2] hover:bg-white/[0.05] hover:text-[#F1F1F1]'}`}><span className={`mt-0.5 text-[10px] font-bold ${activeSection === index ? 'text-[#76B9FF]' : 'text-[#666]'}`}>{String(index + 1).padStart(2, '0')}</span><span className="text-[12px] leading-4">{section.title}</span></button>)}</nav>
            <div className="border-t border-white/[0.07] p-4 text-[11px] leading-5 text-[#777]">Read in order for first-time setup, then use Contents to jump to a feature.</div>
          </aside>
          <main className="eterx-scrollbar min-w-0 flex-1 overflow-y-auto px-5 py-6 sm:px-9 sm:py-8">
            <div className="mx-auto max-w-[790px]">
              <div className="mb-8 rounded-xl border border-[#3D9BFF]/20 bg-gradient-to-br from-[#203247] to-[#1C232D] px-5 py-5 sm:px-6"><div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#8CC7FF]">New here?</div><h3 className="mt-2 text-[17px] font-semibold text-[#F1F1F1]">Follow this setup path</h3><p className="mt-2 text-[13px] leading-5 text-[#BBD7EE]">Connect a provider → add a model → configure services → choose an agent mode → explore automation and customization.</p></div>
              {visibleSections.length === 0 && <div className="rounded-xl border border-white/[0.08] bg-[#1D1D1D] px-5 py-8 text-center text-[13px] text-[#999]">No matching sections. Try a different search.</div>}
              <div className="space-y-10">{visibleSections.map(({ section, index }) => <section id={`manual-section-${index}`} key={section.title} className="scroll-mt-6 border-b border-white/[0.08] pb-9 last:border-b-0"><div className="flex items-start gap-3"><span className="mt-1 rounded-md bg-[#25384A] px-2 py-1 text-[10px] font-bold tracking-[0.1em] text-[#8CC7FF]">{String(index + 1).padStart(2, '0')}</span><h3 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-[#F1F1F1]">{section.title}</h3></div><div className="mt-5 space-y-3">{section.paragraphs.map(paragraph => <p key={paragraph} className="text-[13.5px] leading-6 text-[#B0B0B0]">{paragraph}</p>)}</div>{section.bullets && <div className="mt-5 rounded-xl border border-white/[0.08] bg-[#1C1C1C] p-4"><ul className="space-y-2 text-[13px] leading-5 text-[#C4C4C4]">{section.bullets.map(item => <li key={item} className="flex gap-2.5"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#5FAFFF]" />{item}</li>)}</ul></div>}{section.subSections && <div className="mt-5 grid gap-3 sm:grid-cols-2">{section.subSections.map(sub => <div key={sub.title} className="rounded-xl border border-white/[0.08] bg-[#1C1C1C] px-4 py-3.5"><div className="text-[13px] font-semibold text-[#F1F1F1]">{sub.title}</div><p className="mt-1.5 text-[12.5px] leading-5 text-[#9F9F9F]">{sub.text}</p></div>)}</div>}</section>)}</div>
            </div>
          </main>
        </div>
      </motion.div>
    </motion.div>
  );
};

const SETTINGS_DROPDOWN_OPEN_EVENT = 'eterx-settings-dropdown-open';

const ModernSelect: React.FC<{
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; tag?: string; description?: string }>;
  placeholder?: string;
  className?: string;
}> = ({ value, onChange, options, placeholder = 'Select', className = '' }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<object>({});
  useEffect(() => {
    const closeOtherDropdowns = (event: Event) => {
      const source = (event as CustomEvent<object>).detail;
      if (source !== instanceRef.current) setOpen(false);
    };
    window.addEventListener(SETTINGS_DROPDOWN_OPEN_EVENT, closeOtherDropdowns);
    return () => window.removeEventListener(SETTINGS_DROPDOWN_OPEN_EVENT, closeOtherDropdowns);
  }, []);
  const selected = options.find(option => option.value === value);
  const searchable = options.length > 6;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = normalizedQuery
    ? options.filter(option => `${option.label} ${option.value} ${option.description || ''}`.toLowerCase().includes(normalizedQuery))
    : options;

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => {
          setOpen(prev => {
            const next = !prev;
            if (next) window.dispatchEvent(new CustomEvent(SETTINGS_DROPDOWN_OPEN_EVENT, { detail: instanceRef.current }));
            return next;
          });
          setQuery('');
        }}
        onBlur={() => window.setTimeout(() => {
          if (!rootRef.current?.contains(document.activeElement)) setOpen(false);
        }, 0)}
        aria-expanded={open}
        className="eterx-settings-select-trigger flex h-9 w-full items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#2D2D2D] px-3 text-left text-[13px] font-medium text-[#F2F2F2] shadow-none outline-none transition-colors hover:bg-[#363636] focus:border-white/[0.20]"
      >
        <span className="truncate">{selected?.label || placeholder}</span>
        <ChevronRight className={`h-4 w-4 shrink-0 text-[#A7A7A7] transition-transform ${open ? '-rotate-90' : 'rotate-90'}`} />
      </button>
      {open && (
        <div className="eterx-settings-select-menu absolute right-0 z-50 mt-2 flex max-h-72 w-full min-w-[240px] flex-col rounded-xl border border-black/10 dark:border-white/[0.10] bg-white dark:bg-[#242424] p-1 shadow-none text-neutral-900 dark:text-neutral-100">
          {searchable && (
            <div className="relative mb-1 shrink-0">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#777]" />
              <input
                autoFocus
                value={query}
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Escape') setOpen(false);
                }}
                placeholder={`Search ${options.length} options`}
                className="h-9 w-full rounded-lg border border-black/10 dark:border-white/[0.08] bg-neutral-100 dark:bg-[#191919] pl-8 pr-3 text-[12px] text-neutral-900 dark:text-[#F2F2F2] outline-none placeholder:text-neutral-400 dark:placeholder:text-[#707070] focus:border-black/20 dark:focus:border-white/[0.18]"
              />
            </div>
          )}
          <div className="min-h-0 overflow-y-auto eterx-scrollbar">
          {visibleOptions.map(option => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              data-active={value === option.value}
              className={`eterx-settings-select-option flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[12.5px] transition-colors ${
                value === option.value ? 'bg-black/5 dark:bg-white/[0.08] text-neutral-900 dark:text-[#F4F4F4] font-medium' : 'text-neutral-700 dark:text-[#CFCFCF] hover:bg-black/5 dark:hover:bg-white/[0.055] hover:text-neutral-900 dark:hover:text-[#F4F4F4]'
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{option.label}</span>
                {option.description && (
                  <span className="mt-0.5 block truncate text-[11px] font-normal text-[#8F8F8F]">
                    {option.description}
                  </span>
                )}
              </span>
              {value === option.value && <Check className="ml-2 h-3.5 w-3.5 shrink-0" />}
            </button>
          ))}
          {visibleOptions.length === 0 && (
            <div className="px-3 py-4 text-center text-[12px] text-[#888]">No matching options</div>
          )}
          </div>
        </div>
      )}
    </div>
  );
};

const ProviderSelect: React.FC<{
  value: string;
  onChange: (value: string) => void;
  providers: string[];
  className?: string;
}> = ({ value, onChange, providers, className = '' }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<object>({});
  useEffect(() => {
    const closeOtherDropdowns = (event: Event) => {
      const source = (event as CustomEvent<object>).detail;
      if (source !== instanceRef.current) setOpen(false);
    };
    window.addEventListener(SETTINGS_DROPDOWN_OPEN_EVENT, closeOtherDropdowns);
    return () => window.removeEventListener(SETTINGS_DROPDOWN_OPEN_EVENT, closeOtherDropdowns);
  }, []);
  const label = PROVIDER_LABEL[value] || value || 'Select provider';
  const searchable = providers.length > 6;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleProviders = normalizedQuery
    ? providers.filter(provider => `${PROVIDER_LABEL[provider] || provider} ${provider}`.toLowerCase().includes(normalizedQuery))
    : providers;

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => {
          setOpen(prev => {
            const next = !prev;
            if (next) window.dispatchEvent(new CustomEvent(SETTINGS_DROPDOWN_OPEN_EVENT, { detail: instanceRef.current }));
            return next;
          });
          setQuery('');
        }}
        onBlur={() => window.setTimeout(() => {
          if (!rootRef.current?.contains(document.activeElement)) setOpen(false);
        }, 0)}
        className="flex h-9 w-full items-center justify-between gap-2.5 rounded-xl border border-white/[0.08] bg-[#2D2D2D] px-3 text-left text-[13px] font-medium text-[#F2F2F2] shadow-none outline-none transition-colors hover:bg-[#363636] focus:border-white/[0.20]"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ProviderMark provider={value} />
          <span className="truncate">{label}</span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          <ChevronRight className={`h-4 w-4 shrink-0 text-[#A7A7A7] transition-transform ${open ? '-rotate-90' : 'rotate-90'}`} />
        </span>
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 flex max-h-72 w-full min-w-[280px] flex-col rounded-xl border border-black/10 dark:border-white/[0.10] bg-white dark:bg-[#242424] p-1.5 shadow-none text-neutral-900 dark:text-neutral-100">
          {searchable && (
            <div className="relative mb-1 shrink-0">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#777]" />
              <input
                autoFocus
                value={query}
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Escape') setOpen(false);
                }}
                placeholder={`Search ${providers.length} providers`}
                className="h-9 w-full rounded-lg border border-black/10 dark:border-white/[0.08] bg-neutral-100 dark:bg-[#191919] pl-8 pr-3 text-[12px] text-neutral-900 dark:text-[#F2F2F2] outline-none placeholder:text-neutral-400 dark:placeholder:text-[#707070] focus:border-black/20 dark:focus:border-white/[0.18]"
              />
            </div>
          )}
          <div className="min-h-0 overflow-y-auto eterx-scrollbar">
          {visibleProviders.map(provider => {
            return (
              <button
                key={provider}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange(provider);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[12.5px] transition-colors ${
                  value === provider ? 'bg-black/5 dark:bg-white/[0.08] text-neutral-900 dark:text-[#F4F4F4] font-medium' : 'text-neutral-700 dark:text-[#CFCFCF] hover:bg-black/5 dark:hover:bg-white/[0.055] hover:text-neutral-900 dark:hover:text-[#F4F4F4]'
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ProviderMark provider={provider} />
                  <span className="truncate">{PROVIDER_LABEL[provider] || provider}</span>
                </span>
                <span className="flex items-center gap-1.5 shrink-0">
                  {value === provider && <Check className="h-3.5 w-3.5 shrink-0 text-[#F4F4F4]" />}
                </span>
              </button>
            );
          })}
          {visibleProviders.length === 0 && (
            <div className="px-3 py-4 text-center text-[12px] text-[#888]">No matching providers</div>
          )}
          </div>
        </div>
      )}
    </div>
  );
};

const ApiKeyRow: React.FC<{
  name: string;
  description?: string;
  icon: React.ReactNode;
  keyValue: string;
  onUpdate: (v: string) => void;
  status?: 'ready' | 'missing' | 'error';
}> = ({ name, description, keyValue, onUpdate, status }) => {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(keyValue);
  const hasKey = Boolean(keyValue?.trim());
  const rowStatus = status || (hasKey ? 'ready' : 'missing');

  useEffect(() => {
    setDraft(keyValue);
  }, [keyValue]);

  const handleCopy = async () => {
    if (!keyValue) return;
    const didCopy = await safeCopyTextToClipboard(keyValue);
    if (!didCopy) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mb-2 rounded-lg border border-white/[0.08] bg-[#202020] px-5 py-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${
            rowStatus === 'ready'
              ? 'bg-emerald-300 shadow-none'
              : rowStatus === 'error'
                ? 'bg-red-400'
                : 'bg-white/18'
          }`} />
          <div className="min-w-0">
            <span className="block truncate text-[15px] font-medium text-[#F1F1F1]">{name}</span>
            {description && <span className="mt-1 block truncate text-[13px] text-[#A5A5A5]">{description}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className={`hidden sm:inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-[0.08em] ${
            rowStatus === 'ready'
              ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
              : rowStatus === 'error'
                ? 'border-red-500/20 bg-red-500/10 text-red-300'
                : 'border-white/[0.08] bg-white/[0.03] text-[#777]'
          }`}>
            {rowStatus === 'ready' ? 'Ready' : rowStatus === 'error' ? 'Check' : 'Missing'}
          </span>
          <button type="button" onClick={() => setVisible(!visible)} className="p-1.5 rounded-md hover:bg-white/5 text-[#555] hover:text-[#E8E6E3] transition-colors" title={visible ? 'Hide' : 'Show'}>
            {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
          <button type="button" onClick={handleCopy} className="p-1.5 rounded-md hover:bg-white/5 text-[#555] hover:text-[#E8E6E3] transition-colors" title="Copy">
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
      {editing ? (
        <div className="flex gap-2">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { onUpdate(draft); setEditing(false); }
              if (e.key === 'Escape') setEditing(false);
            }}
            className="flex-1 bg-[#141414] border border-white/[0.10] rounded-lg px-3 py-2 text-[12px] font-mono text-[#E8E6E3] outline-none focus:border-white/25 transition-colors"
            placeholder="Enter API key..."
          />
          <button type="button" onClick={() => { onUpdate(draft); setEditing(false); }} className="px-3 py-2 bg-white/[0.08] text-[#E8E6E3] rounded-lg text-[12px] font-medium hover:bg-white/[0.12] transition-colors">Save</button>
        </div>
      ) : (
        <div
          onClick={() => setEditing(true)}
          className="bg-[#141414] border border-white/[0.08] rounded-lg px-3 py-2 text-[12px] font-mono text-[#666] cursor-pointer hover:border-white/15 transition-colors"
        >
          {keyValue ? (visible ? keyValue : '*'.repeat(Math.min(keyValue.length, 40))) : <span className="text-[#444] italic">Click to add key...</span>}
        </div>
      )}
    </div>
  );
};


// ═══════════════════════════════════════════════════════
// MAIN SETTINGS PANEL
// ═══════════════════════════════════════════════════════
export const SettingsPanel: React.FC<SettingsPanelProps> = React.memo(({ isOpen, onClose, initialTab = 'general', onTabChange, standalone = false }) => {
  const [activeTab, setActiveTab] = useState<Tab>(normalizeSettingsTab(initialTab));
  const [manualOpen, setManualOpen] = useState(false);
  const [manualTopic, setManualTopic] = useState('model-selection');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [terminalPlatform, setTerminalPlatform] = useState<'unknown' | 'windows' | 'mac' | 'linux'>('unknown');

  useEffect(() => {
    if (!isOpen) return;
    setManualOpen(false);
    setActiveTab(normalizeSettingsTab(initialTab));
  }, [initialTab, isOpen]);
  const [browserRuntimeStatus, setBrowserRuntimeStatus] = useState<any>(null);
  const [browserRuntimeBusy, setBrowserRuntimeBusy] = useState(false);
  const [searchProbe, setSearchProbe] = useState<{ provider: SearchProvider; status: 'idle' | 'testing' | 'success' | 'failed'; message: string }>({ provider: 'tavily', status: 'idle', message: '' });
  const [browserRuntimeMessage, setBrowserRuntimeMessage] = useState('Checking browser runtime…');
  const [availableTerminalShells, setAvailableTerminalShells] = useState<string[]>([]);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [searchSettings, setSearchSettings] = useState<SearchSettings>(DEFAULT_SEARCH_SETTINGS);
  const [imageSettings, setImageSettings] = useState<ImageSettings>(DEFAULT_IMAGE_SETTINGS);
  const [imageProbe, setImageProbe] = useState<{ provider: ImageProvider; status: 'idle' | 'testing' | 'success' | 'failed'; message: string }>({ provider: 'freepik', status: 'idle', message: '' });
  const [videoSettings, setVideoSettings] = useState<VideoSettings>(DEFAULT_VIDEO_SETTINGS);
  const [videoProbe, setVideoProbe] = useState<{ provider: VideoProvider; status: 'idle' | 'testing' | 'success' | 'failed'; message: string }>({ provider: 'google', status: 'idle', message: '' });
  const [liveApiKeys, setLiveApiKeys] = useState<Record<string, string>>({});
  const [apiSyncStatus, setApiSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'error'>('idle');
  const [apiSyncMessage, setApiSyncMessage] = useState('Runtime keys are local until synced.');
  const [apiProviderStatus, setApiProviderStatus] = useState<ApiProviderStatus[]>([]);
  const [modelDirectory, setModelDirectory] = useState<ModelDirectory>({});
  const [liveModelOptionsFromApi, setLiveModelOptionsFromApi] = useState<Record<string, LiveModelOption[]>>({});
  const [liveVoiceOptionsFromApi, setLiveVoiceOptionsFromApi] = useState<Record<string, Array<{ value: string; label: string; tag?: string; description?: string }>>>({});
  const [liveCatalogStatus, setLiveCatalogStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [liveCatalogMessage, setLiveCatalogMessage] = useState('Select a provider to load its live catalog.');
  const [modelDirectoryStatus, setModelDirectoryStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [modelDirectoryUpdatedAt, setModelDirectoryUpdatedAt] = useState<number | null>(null);
  const [modelOverrides, setModelOverrides] = useState<ModelOverrides>({});
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>({});
  const [modelEntries, setModelEntries] = useState<ModelSelectorEntry[]>([]);
  const [chatModelSelection, setChatModelSelection] = useState(AUTO_MODEL_SELECTION);
  const [contextChats, setContextChats] = useState<ContextChatSummary[]>([]);
  const [selectedContextChatId, setSelectedContextChatId] = useState('');
  const [activeContextChatId, setActiveContextChatId] = useState('');
  const [contextChatOverrides, setContextChatOverrides] = useState<Record<string, string>>({});
  const [contextChatsLoading, setContextChatsLoading] = useState(false);
  const [tokenStats, setTokenStats] = useState<TokenStats>(EMPTY_TOKEN_STATS);
  const [tokenChats, setTokenChats] = useState<TokenChatSummary[]>([]);
  const [tokenStatsLoading, setTokenStatsLoading] = useState(false);
  const [selectedTokenChatId, setSelectedTokenChatId] = useState('');
  const [hoveredToken, setHoveredToken] = useState<{
    value: number;
    date: string;
    x: number;
    y: number;
    cellKey?: string;
    recentRunUsage?: number;
    model?: string;
    scope?: 'chat' | 'action';
    promptTokens?: number;
    cachedTokens?: number;
    uncachedPromptTokens?: number;
    outputTokens?: number;
  } | null>(null);
  const [modelThinkingCapabilities, setModelThinkingCapabilities] = useState<Record<string, ModelThinkingCapabilities>>({});
  const [modelApiKeys, setModelApiKeys] = useState<Record<string, string>>({});
  const [providerBaseURLs, setProviderBaseURLs] = useState<Record<string, string>>({});
  const [selectedConnectionProvider, setSelectedConnectionProvider] = useState<MainAgentProvider>('gemini');
  const [selectedApiProviderValue, setSelectedApiProviderValue] = useState<MainAgentProvider>('gemini');
  const [selectedApiModelValue, setSelectedApiModelValue] = useState('');
  const [exactModelDraft, setExactModelDraft] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showBatmanEgg] = useState(false);
  const [eggQuoteIndex] = useState(0);
  const [defaultPermsActive, setDefaultPermsActive] = useState(true);
  const [fullAccessActive, setFullAccessActive] = useState(true);
  const [gatewayConfig, setGatewayConfig] = useState<any>(null);
  const [gatewayRunning, setGatewayRunning] = useState(false);
  const apiKeysRef = useRef<Record<string, string>>({});
  const settingsDialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const searchSettingsRef = useRef<SearchSettings>(DEFAULT_SEARCH_SETTINGS);
  const imageSettingsRef = useRef<ImageSettings>(DEFAULT_IMAGE_SETTINGS);
  const videoSettingsRef = useRef<VideoSettings>(DEFAULT_VIDEO_SETTINGS);
  const liveApiKeysRef = useRef<Record<string, string>>({});
  const modelApiKeysRef = useRef<Record<string, string>>({});
  const modelOverridesRef = useRef<ModelOverrides>({});
  const modelEntriesRef = useRef<ModelSelectorEntry[]>([]);
  const providerBaseURLsRef = useRef<Record<string, string>>({});
  const runtimeSettingsHydratedRef = useRef(false);
  const settingsRevisionRef = useRef(0);
  const runtimeSettingsWriteRef = useRef<Promise<unknown>>(Promise.resolve());
  const runtimeSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runtimeSyncPendingRef = useRef<RuntimeSettingsSnapshot | null>(null);
  const runtimeSyncChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const modelDirectoryRequestChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const providerBaseURLSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const providerBaseURLSyncChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const providerBaseURLDirtyRef = useRef(false);
  const [updateState, setUpdateState] = useState<DesktopUpdateState>({
    revision: 0,
    status: 'development',
    currentVersion: 'development',
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    downloadReady: false,
    automaticChecks: false,
    message: 'Desktop updates are available in the installed application.',
  });
  const applyDesktopUpdateState = useCallback((incoming: DesktopUpdateState | null | undefined) => {
    if (!incoming || typeof incoming !== 'object') return;
    setUpdateState(current => {
      const incomingRevision = Number(incoming.revision);
      const currentRevision = Number(current.revision);
      if (Number.isFinite(incomingRevision) && Number.isFinite(currentRevision) && incomingRevision < currentRevision) {
        return current;
      }
      return incoming;
    });
  }, []);
  apiKeysRef.current = apiKeys;
  modelEntriesRef.current = modelEntries;
  searchSettingsRef.current = searchSettings;
  imageSettingsRef.current = imageSettings;
  videoSettingsRef.current = videoSettings;
  liveApiKeysRef.current = liveApiKeys;
  modelApiKeysRef.current = modelApiKeys;
  modelOverridesRef.current = modelOverrides;
  const terminalShellOptions = getTerminalShellOptions(terminalPlatform, availableTerminalShells);
  const selectedSearchMeta = SEARCH_PROVIDER_META[searchSettings.provider];
  const selectedImageMeta = IMAGE_PROVIDER_META[imageSettings.provider];
  const selectedImageModel = imageSettings.modelByProvider[imageSettings.provider] || selectedImageMeta.defaultModel;
  const selectedVideoMeta = VIDEO_PROVIDER_META[videoSettings.provider];
  const selectedVideoModel = videoSettings.modelByProvider[videoSettings.provider] || selectedVideoMeta.defaultModel;
  const computerRuntime = browserRuntimeStatus?.computer;
  const cuaDriver = computerRuntime?.cuaDriver;
  const computerState = !settings.computerUse
    ? { label: 'Off', tone: 'neutral' }
    : cuaDriver?.healthy
      ? { label: 'Ready', tone: 'good' }
      : cuaDriver?.installed
        ? { label: 'Needs setup', tone: 'warn' }
        : { label: 'Driver unavailable', tone: 'warn' };
  const selectedSearchServices = searchSettings.enabledServices[searchSettings.provider] || [...SEARCH_SERVICE_IDS];

  const refreshBrowserRuntimeStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/browser/status', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      const payload = await response.json();
      setBrowserRuntimeStatus(payload);
      if (!payload?.success) setBrowserRuntimeMessage(payload?.error || 'Browser status unavailable.');
      else setBrowserRuntimeMessage(payload?.signedBrowser ? 'Signed-in browser control is ready.' : payload?.managedBrowser ? 'Isolated browser control is ready.' : payload?.signedBrowserReason || 'Choose a browser mode.');
    } catch (error: any) {
      setBrowserRuntimeMessage(error?.name === 'TimeoutError' ? 'Browser status check timed out.' : 'Could not reach the browser runtime.');
    }
  }, []);

  const runBrowserRuntimeAction = useCallback(async (action: 'connect_signed' | 'launch_managed' | 'disconnect') => {
    setBrowserRuntimeBusy(true);
    setBrowserRuntimeMessage(action === 'connect_signed' ? 'Connecting to signed-in browser…' : action === 'launch_managed' ? 'Starting managed browser…' : 'Disconnecting browser…');
    try {
      const response = await fetch('/api/browser/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
        signal: AbortSignal.timeout(25000),
      });
      const payload = await response.json();
      setBrowserRuntimeStatus(payload);
      setBrowserRuntimeMessage(payload?.success ? payload.message || 'Browser action completed.' : payload?.error || 'Browser action failed.');
    } catch (error: any) {
      setBrowserRuntimeMessage(error?.name === 'TimeoutError'
        ? 'Browser action timed out. Close the browser once, then retry.'
        : 'Browser action could not be completed.');
    } finally {
      setBrowserRuntimeBusy(false);
      window.setTimeout(() => { void refreshBrowserRuntimeStatus(); }, 250);
    }
  }, [refreshBrowserRuntimeStatus]);

  useEffect(() => {
    applyUiDensity(settings.fontSize);
  }, [settings.fontSize]);


  useEffect(() => {
    if (!isOpen || (activeTab !== 'browser' && activeTab !== 'computer')) return;
    let inFlight = false;
    const refreshVisibleStatus = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try { await refreshBrowserRuntimeStatus(); } finally { inFlight = false; }
    };
    void refreshVisibleStatus();
    const timer = window.setInterval(refreshVisibleStatus, 8000);
    document.addEventListener('visibilitychange', refreshVisibleStatus);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisibleStatus);
    };
  }, [activeTab, isOpen, refreshBrowserRuntimeStatus]);

  useEffect(() => {
    const userAgent = `${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
    const fallbackPlatform = /mac|darwin/.test(userAgent) ? 'mac' : /win/.test(userAgent) ? 'windows' : 'linux';
    setTerminalPlatform(fallbackPlatform);

    fetch('/api/runtime/platform', { cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then(payload => {
        if (!payload) return;
        if (payload.platform === 'windows' || payload.platform === 'mac' || payload.platform === 'linux') {
          setTerminalPlatform(payload.platform);
        }
        if (Array.isArray(payload.shells)) {
          const shells = payload.shells.map(String);
          setAvailableTerminalShells(shells);
          setSettings(previous => {
            if (shells.includes(previous.terminalShell)) return previous;
            const next = { ...previous, terminalShell: 'auto' as const };
            try {
              const saved = JSON.parse(appStorage.getItem('eterx_settings') || '{}');
              const nextStored = { ...saved, terminalShell: 'auto' };
              appStorage.setItem('eterx_settings', JSON.stringify(nextStored));
              broadcastEterxSettingsUpdate(nextStored);
            } catch { }
            return next;
          });
        }
      })
      .catch(() => {
        // If the runtime probe is unavailable, keep only the portable auto
        // choice so an unverified shell is never offered or persisted.
        setAvailableTerminalShells(['auto']);
        setSettings(previous => {
          if (previous.terminalShell === 'auto') return previous;
          try {
            const saved = JSON.parse(appStorage.getItem('eterx_settings') || '{}');
            const nextStored = { ...saved, terminalShell: 'auto' };
            appStorage.setItem('eterx_settings', JSON.stringify(nextStored));
            broadcastEterxSettingsUpdate(nextStored);
          } catch { }
          return { ...previous, terminalShell: 'auto' };
        });
      });
  }, []);

  useEffect(() => {
    if (!availableTerminalShells.length) return;
    setSettings(previous => availableTerminalShells.includes(previous.terminalShell)
      ? previous
      : { ...previous, terminalShell: 'auto' });
  }, [availableTerminalShells]);

  const handleToggleDefaultPerms = useCallback((v: boolean) => {
    if (!v) {
      setDefaultPermsActive(false);
      setTimeout(() => setDefaultPermsActive(true), 1000);
    }
  }, []);

  const handleToggleFullAccess = useCallback((v: boolean) => {
    if (!v) {
      setFullAccessActive(false);
      setTimeout(() => setFullAccessActive(true), 1000);
    }
  }, []);

  const keysChangedRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    const desktopApi = (window as any)?.electronAPI;
    let unsubscribe: undefined | (() => void);
    if (typeof desktopApi?.getUpdateState === 'function') {
      // Subscribe before reading the snapshot. The revision guard prevents a
      // slower IPC response from overwriting a newer progress event.
      if (typeof desktopApi.onUpdateState === 'function') unsubscribe = desktopApi.onUpdateState(applyDesktopUpdateState);
      desktopApi.getUpdateState().then(applyDesktopUpdateState).catch(() => {});
    }
    return () => unsubscribe?.();
  }, [applyDesktopUpdateState, isOpen]);

  useEffect(() => {
    if (!isOpen || activeTab !== 'updates') return;
    const desktopApi = (window as any)?.electronAPI;
    if (typeof desktopApi?.markUpdateViewed !== 'function') return;
    desktopApi.markUpdateViewed().then(applyDesktopUpdateState).catch(() => {});
  }, [activeTab, applyDesktopUpdateState, isOpen, updateState.availableVersion]);

  useEffect(() => {
    if (!isOpen) return;
    const desktopApi = (window as any)?.electronAPI;
    if (typeof desktopApi?.getGatewayState !== 'function') return;
    desktopApi.getGatewayState().then((state: any) => {
      if (state?.config) {
        setGatewayConfig(state.config);
        appStorage.setItem('eterx_background_active_chats', String(Boolean(state.config.enabled && state.config.keepActiveChatsOnClose !== false)));
        appStorage.setItem('eterx_background_scheduled_tasks', String(Boolean(state.config.enabled && state.config.runScheduledTasksInBackground !== false)));
      }
      setGatewayRunning(Boolean(state?.status?.running));
    }).catch(() => {});
    const unsubscribe = desktopApi.onGatewayStatus?.((status: any) => setGatewayRunning(Boolean(status?.running)));
    return () => unsubscribe?.();
  }, [isOpen]);

  const saveGatewayPatch = useCallback(async (patch: Record<string, unknown>) => {
    const desktopApi = (window as any)?.electronAPI;
    if (!gatewayConfig || typeof desktopApi?.saveGatewayConfig !== 'function') return;
    const next = { ...gatewayConfig, ...patch };
    setGatewayConfig(next);
    appStorage.setItem('eterx_background_active_chats', String(Boolean(next.enabled && next.keepActiveChatsOnClose !== false)));
    appStorage.setItem('eterx_background_scheduled_tasks', String(Boolean(next.enabled && next.runScheduledTasksInBackground !== false)));
    window.dispatchEvent(new CustomEvent('eterx-background-settings-updated', { detail: next }));
    try {
      const result = await desktopApi.saveGatewayConfig(next);
      if (result?.ok === false) throw new Error(result.error || 'Could not save background settings.');
      if (result?.config) {
        setGatewayConfig(result.config);
        appStorage.setItem('eterx_background_active_chats', String(Boolean(result.config.enabled && result.config.keepActiveChatsOnClose !== false)));
        appStorage.setItem('eterx_background_scheduled_tasks', String(Boolean(result.config.enabled && result.config.runScheduledTasksInBackground !== false)));
        window.dispatchEvent(new CustomEvent('eterx-background-settings-updated', { detail: result.config }));
      }
      if (result?.status) setGatewayRunning(Boolean(result.status.running));
    } catch (error) {
      console.warn('Could not update background companion settings:', error);
      setGatewayConfig(gatewayConfig);
      appStorage.setItem('eterx_background_active_chats', String(Boolean(gatewayConfig.enabled && gatewayConfig.keepActiveChatsOnClose !== false)));
      appStorage.setItem('eterx_background_scheduled_tasks', String(Boolean(gatewayConfig.enabled && gatewayConfig.runScheduledTasksInBackground !== false)));
      window.dispatchEvent(new CustomEvent('eterx-background-settings-updated', { detail: gatewayConfig }));
    }
  }, [gatewayConfig]);

  const saveBackgroundMode = useCallback((mode: 'chats' | 'schedules', enabled: boolean) => {
    if (!gatewayConfig) return;
    const keepActiveChatsOnClose = mode === 'chats' ? enabled : gatewayConfig.keepActiveChatsOnClose !== false;
    const runScheduledTasksInBackground = mode === 'schedules' ? enabled : gatewayConfig.runScheduledTasksInBackground !== false;
    const hasEnabledChannel = Object.values(gatewayConfig.platforms || {}).some((platform: any) => Boolean(platform?.enabled));
    const companionNeeded = keepActiveChatsOnClose || runScheduledTasksInBackground || hasEnabledChannel;
    void saveGatewayPatch({
      keepActiveChatsOnClose,
      runScheduledTasksInBackground,
      enabled: companionNeeded,
      keepRunningOnClose: companionNeeded,
      launchAtLogin: companionNeeded ? Boolean(gatewayConfig.launchAtLogin) : false,
    });
  }, [gatewayConfig, saveGatewayPatch]);

  const persistDesktopRuntimeSettings = useCallback(async (
    nextApiKeys: Record<string, string>,
    nextModelApiKeys: Record<string, string>,
    nextModelOverrides: ModelOverrides,
    nextBaseURLs?: Record<string, string>,
  ) => {
    const desktopApi = (window as any)?.electronAPI;
    const snapshot = {
      apiKeys: { ...nextApiKeys },
      liveApiKeys: { ...liveApiKeysRef.current },
      modelApiKeys: { ...nextModelApiKeys },
      modelOverrides: { ...nextModelOverrides },
      baseURLs: { ...(nextBaseURLs ?? providerBaseURLsRef.current) },
      search: normalizeSearchSettings(searchSettingsRef.current),
      image: normalizeImageSettings(imageSettingsRef.current),
      video: normalizeVideoSettings(videoSettingsRef.current),
    };
    const write = async () => {
      let saved = true;
      const writes: Promise<unknown>[] = [
        fetch('/api/settings/runtime', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: snapshot }),
        }).then(response => {
          if (!response.ok) throw new Error(`Folder runtime settings HTTP ${ response.status }`);
        }).catch(error => {
          saved = false;
          console.warn('Could not persist folder-backed runtime settings:', error);
        }),
      ];
      if (typeof desktopApi?.saveSecureRuntimeSettings === 'function') {
        writes.push(
          desktopApi.saveSecureRuntimeSettings(snapshot)
            .then((result: any) => {
              // OS secure storage is an optional second copy; the encrypted
              // AppData runtime file remains authoritative on Linux systems
              // without a keyring. Treat an available-but-failed secure write
              // as a real durability failure, not an unavailable keyring.
              if (result?.ok === false && result?.available !== false) {
                saved = false;
                console.warn('Could not persist encrypted desktop API settings:', result?.error || 'secure storage unavailable');
              }
            })
            .catch((error: unknown) => {
              saved = false;
              console.warn('Could not persist encrypted desktop API settings:', error);
            }),
        );
      }
      await Promise.all(writes);
      return saved;
    };
    const queuedWrite = runtimeSettingsWriteRef.current.then(write, write);
    runtimeSettingsWriteRef.current = queuedWrite;
    return queuedWrite;
  }, []);

  const eggQuotes = [
    { line1: "BE A MAN.", line2: "FACE DARKNESS" },
    { line1: "NOT AVAILABLE.", line2: "ONLY DARK." },
    { line1: "LIGHT THEME?", line2: "NEVER." },
    { line1: "EMBRACE", line2: "THE VOID." },
    { line1: "LIGHT IS", line2: "FOR THE WEAK." }
  ];

  useEffect(() => {
    if (!isOpen || activeTab !== 'context') return;
    let cancelled = false;
    setContextChatsLoading(true);
    setActiveContextChatId(appStorage.getItem('eterx_active_chat') || '');

    try {
      const rawOverrides = JSON.parse(appStorage.getItem(CHAT_CONTEXT_WINDOW_OVERRIDES_STORAGE_KEY) || '{}');
      const validBudgetSelections = new Set(CONTEXT_WINDOW_SIZE_OPTIONS.map(option => option.value));
      setContextChatOverrides(
        rawOverrides && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides)
          ? Object.fromEntries(
              Object.entries(rawOverrides)
                .map(([chatId, value]) => [String(chatId), String(value || '')])
                .filter(([chatId, value]) => Boolean(chatId && validBudgetSelections.has(value))),
            )
          : {},
      );
    } catch {
      setContextChatOverrides({});
    }

    const normalizeChats = (rawChats: any[]): ContextChatSummary[] => rawChats
      .filter(chat => chat && typeof chat.id === 'string')
      .map(chat => {
        const logs = (Array.isArray(chat.traceLogs) ? chat.traceLogs : []).filter((log: any) =>
          !log?.subAgentId && !log?.subAgentChatId && (!log?.subAgent || log.subAgent === 'Main') && log?.auxiliaryRuntime !== true
        );
        const meter = readContextUsageMeter(logs);
        const usage = meter.latestContextUsage;
        const selection = parseModelEntryKey(chat.modelSelection);
        const measured = meter.latestProviderUsage || usage;
        const provider = selection?.provider || String(measured?.provider || '');
        const modelId = selection?.modelId || String(measured?.model || measured?.modelId || '');
        const measuredModelMatches = usage?.provider === provider && String(usage?.model || usage?.modelId || '') === modelId;
        return {
          id: String(chat.id),
          title: String(chat.title || 'Untitled chat').trim() || 'Untitled chat',
          updatedAt: Number(chat.updatedAt || 0),
          usedTokens: meter.usedTokens,
          reportedWindow: normalizeContextWindow(meter.contextWindow),
          modelMaximum: measuredModelMatches ? normalizeContextWindow(usage?.modelContextWindow) : 0,
          provider,
          modelId,
        };
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);

    const applyChats = (rawChats: any[]) => {
      if (cancelled) return;
      const next = normalizeChats(rawChats);
      setContextChats(next);
      setSelectedContextChatId(previous => {
        if (previous && next.some(chat => chat.id === previous)) return previous;
        const currentChatId = appStorage.getItem('eterx_active_chat') || '';
        return next.find(chat => chat.id === currentChatId)?.id || next[0]?.id || '';
      });
    };

    const durableLoad = fetch('/api/chats', { cache: 'no-store' })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Unable to load chats')));
    Promise.resolve(durableLoad)
      .then((snapshot: any) => {
        if (Array.isArray(snapshot?.chats)) applyChats(snapshot.chats);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setContextChatsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, isOpen]);

  useEffect(() => {
    if (!isOpen || (activeTab !== 'profile' && activeTab !== 'tokens')) return;
    let cancelled = false;
    let refreshInFlight: Promise<void> | null = null;
    let lastSnapshotText: string | null = null;
    let lastStatisticsDay = '';

    if (!appStorage.getItem('eterx_app_launch_at')) {
      appStorage.setItem('eterx_app_launch_at', String(Date.now()));
    }

    const refreshTokenStats = () => {
      if (cancelled || document.hidden) return;
      if (refreshInFlight) return refreshInFlight;
      refreshInFlight = (async () => {
       if (lastSnapshotText === null) setTokenStatsLoading(true);
       try {
      const snapshotText = await fetch('/api/chats', { cache: 'no-store' })
        .then(response => response.ok ? response.text() : Promise.reject(new Error('Unable to load chats')));
      const statisticsDay = new Date().toDateString();
      if (cancelled || (snapshotText === lastSnapshotText && statisticsDay === lastStatisticsDay)) return;
      const snapshot = JSON.parse(snapshotText);
      const chats = Array.isArray(snapshot?.chats) ? snapshot.chats : [];
      const uniqueProviderUsageLogs = (logs: any[]) => {
        const seen = new Set<string>();
        return logs.filter((log: any) => {
          if (log?.type !== 'model_usage' || tokenCountForStoredLog(log) <= 0) return false;
          const key = String(
            log.usageId ||
            log._traceIdx ||
            `${log.runId || log.turnId || ''}:${log.provider || ''}:${log.model || ''}:${log.interaction ?? ''}:${log.timestamp || log.endTime || ''}:${tokenCountForStoredLog(log)}`
          );
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      };
      const nextTokenChats: TokenChatSummary[] = chats
        .filter((chat: any) => chat && typeof chat.id === 'string')
        .map((chat: any) => {
          const logs = Array.isArray(chat.traceLogs) ? chat.traceLogs : [];
          const usageLogs = uniqueProviderUsageLogs(logs);
          const totalUsage = sumStoredTokenMetrics(usageLogs);
          const recent = usageLogs[usageLogs.length - 1] || {};
          const modelTotals = usageLogs.reduce((totals: Record<string, number>, log: any) => {
            const model = String(log.model || chat.model || 'Unknown model').trim() || 'Unknown model';
            totals[model] = (totals[model] || 0) + tokenCountForStoredLog(log);
            return totals;
          }, {});
          const dominantModel = Object.entries(modelTotals)
            .sort((left, right) => right[1] - left[1])[0]?.[0] || String(recent.model || chat.model || 'Unmeasured');
          const lastUserIndex = logs.findLastIndex((log: any) => log?.type === 'user_action');
          const recentUsageLogs = uniqueProviderUsageLogs(lastUserIndex >= 0 ? logs.slice(lastUserIndex + 1) : logs);
          const recentRunUsage = sumStoredTokenMetrics(recentUsageLogs).processedTokens;
          const actions = usageLogs
            .slice(-100)
            .map((log: any, index: number) => {
              const provider = String(log.provider || 'Provider');
              const model = String(log.model || chat.model || 'Model');
              const usageMetrics = tokenMetricsForStoredLog(log);
              const phase = log.phase === 'chat_title'
                ? 'Chat title'
                : log.phase === 'telegram_fast'
                  ? 'Telegram response'
                  : Number.isFinite(Number(log.interaction))
                    ? `Model run ${Number(log.interaction)}`
                    : 'Model run';
              return {
                id: String(log.id || `${chat.id}-${index}`),
                label: `${phase} · ${provider} · ${model}`,
                kind: 'Usage',
                tokens: usageMetrics.processedTokens,
                promptTokens: usageMetrics.promptTokens,
                cachedTokens: usageMetrics.cachedTokens,
                uncachedPromptTokens: usageMetrics.uncachedPromptTokens,
                outputTokens: usageMetrics.outputTokens,
                model,
                timestamp: Number(log.timestamp || log.endTime || log.startTime || chat.updatedAt || Date.now()),
              };
            });
          return {
            id: String(chat.id),
            title: String(chat.title || 'Untitled chat').trim() || 'Untitled chat',
            updatedAt: Number(chat.updatedAt || 0),
            totalTokens: totalUsage.processedTokens,
            promptTokens: totalUsage.promptTokens,
            cachedTokens: totalUsage.cachedTokens,
            uncachedPromptTokens: totalUsage.uncachedPromptTokens,
            outputTokens: totalUsage.outputTokens,
            recentRunUsage,
            model: dominantModel,
            actions,
          };
        })
        .sort((left: any, right: any) => right.updatedAt - left.updatedAt);
      if (cancelled) return;
      setTokenChats(nextTokenChats);
      setSelectedTokenChatId(previous => previous && nextTokenChats.some(chat => chat.id === previous) ? previous : nextTokenChats[0]?.id || '');
      const daily: Record<string, number> = {};
      let lifetimeTokens = 0;
      let peakTokens = 0;
      let longestChatMinutes = 0;

      chats.forEach((chat: any) => {
        const logs = Array.isArray(chat?.traceLogs) ? chat.traceLogs : [];
        let chatTokens = 0;
        let firstAt = Number(chat?.createdAt || chat?.updatedAt || 0);
        let lastAt = Number(chat?.updatedAt || firstAt);
        logs.forEach((log: any) => {
          const at = Number(log?.timestamp || log?.endTime || log?.startTime || 0);
          if (at > 0) {
            firstAt = firstAt > 0 ? Math.min(firstAt, at) : at;
            lastAt = Math.max(lastAt, at);
          }
        });
        uniqueProviderUsageLogs(logs).forEach((log: any) => {
          const at = Number(log?.timestamp || log?.endTime || log?.startTime || chat?.updatedAt || Date.now());
          const count = tokenCountForStoredLog(log);
          if (count <= 0) return;
          chatTokens += count;
          const key = dayKey(at || Number(chat?.updatedAt || Date.now()));
          if (key) daily[key] = (daily[key] || 0) + count;
        });
        peakTokens = Math.max(peakTokens, chatTokens);
        lifetimeTokens += chatTokens;
        if (lastAt > firstAt) longestChatMinutes = Math.max(longestChatMinutes, Math.round((lastAt - firstAt) / 60000));
      });

      const activeDays = Object.keys(daily).filter(key => daily[key] > 0).sort();
      let longestStreak = 0;
      let streak = 0;
      let previousDay = '';
      activeDays.forEach(key => {
        const current = new Date(`${key}T00:00:00Z`).getTime();
        const previous = previousDay ? new Date(`${previousDay}T00:00:00Z`).getTime() : 0;
        streak = previous && current - previous === 86400000 ? streak + 1 : 1;
        longestStreak = Math.max(longestStreak, streak);
        previousDay = key;
      });
      let currentStreak = 0;
      const today = new Date();
      for (let offset = 0; offset < activeDays.length + 1; offset += 1) {
        const date = new Date(today);
        date.setHours(0, 0, 0, 0);
        date.setDate(today.getDate() - offset);
        const key = dayKey(date.getTime());
        if (!daily[key]) break;
        currentStreak += 1;
      }
      setTokenStats({ lifetimeTokens, peakTokens, longestChatMinutes, currentStreak, longestStreak, daily });
      lastSnapshotText = snapshotText;
      lastStatisticsDay = statisticsDay;
       } catch {
         // Keep the last successful snapshot visible during transient API or
         // desktop startup failures instead of replacing real cells with an
         // empty grid.
       } finally {
         if (!cancelled) setTokenStatsLoading(false);
         refreshInFlight = null;
       }
      })();
      return refreshInFlight;
    };
    void refreshTokenStats();
    const interval = window.setInterval(refreshTokenStats, 5000);
    window.addEventListener('eterx_chats_updated', refreshTokenStats);
    window.addEventListener('eterx-settings-updated', refreshTokenStats);
    document.addEventListener('visibilitychange', refreshTokenStats);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('eterx_chats_updated', refreshTokenStats);
      window.removeEventListener('eterx-settings-updated', refreshTokenStats);
      document.removeEventListener('visibilitychange', refreshTokenStats);
    };
  }, [activeTab, isOpen]);

  const hasAnyApiKey = useCallback((keys: Record<string, string>) =>
    Object.values(keys).some(value => Boolean(String(value || '').trim())), []);

  const persistApiKeyPresence = useCallback((nextApiKeys: Record<string, string>, nextModelApiKeys: Record<string, string>) => {
    const apiKeyPresence = Object.fromEntries(
      Object.entries(nextApiKeys)
        .filter(([, value]) => splitApiKeyPool(value).length > 0)
        .map(([provider]) => [provider, 'configured']),
    );
    const modelApiKeyPresence = Object.fromEntries(
      Object.entries(nextModelApiKeys)
        .filter(([, value]) => splitApiKeyPool(value).length > 0)
        .map(([modelKey]) => [modelKey, 'configured']),
    );
    appStorage.setItem(API_KEY_PRESENCE_STORAGE_KEY, JSON.stringify(apiKeyPresence));
    appStorage.setItem(MODEL_API_KEY_PRESENCE_STORAGE_KEY, JSON.stringify(modelApiKeyPresence));
  }, []);

  const refreshModelDirectory = useCallback(async (
    keys: Record<string, string> = composeApiKeysForSelections(
      apiKeys,
      modelApiKeys,
      modelEntries,
      [AUTO_MODEL_SELECTION, ...modelEntries.map(entry => modelEntryKey(entry.provider, entry.modelId))],
    ),
    overrides: ModelOverrides = modelOverrides,
    requestedProviders?: MainAgentProvider[],
  ) => {
    const discoveryRevision = settingsRevisionRef.current;
    const providers = Array.from(new Set(
      (requestedProviders?.length
        ? requestedProviders
        : MODEL_PROVIDER_ORDER.filter(provider =>
            provider === selectedConnectionProvider
            || splitApiKeyPool(keys[provider]).length > 0
          ))
        .filter(isModelProvider),
    ));
    const runDiscovery = async () => {
      if (discoveryRevision !== settingsRevisionRef.current) return;
      setModelDirectoryStatus('loading');
      try {
      const res = await requestJson('/api/settings/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKeys: keys,
          modelOverrides: overrides,
          baseURLs: providerBaseURLsRef.current,
          replaceRuntimeKeys: true,
          providers,
        }),
      }, 180_000);
      const payload = await res.json();
      if (!res.ok || !payload?.ok) throw new Error(payload?.error || 'Model discovery failed');
      if (discoveryRevision !== settingsRevisionRef.current) return;
      const nextDirectory = payload.providers || {};
      setModelDirectory(previous => ({ ...previous, ...nextDirectory }));
      const discoveredThinkingCapabilities: Record<string, ModelThinkingCapabilities> = {};
      const discoveredWireCapabilities: Record<string, string[]> = {};
      Object.values(nextDirectory).forEach((providerValue: any) => {
        const provider = String(providerValue?.provider || '');
        (providerValue?.models || []).forEach((model: any) => {
          const thinking = normalizeModelThinkingCapabilities(model?.thinking);
          if (provider && model?.id && thinking) {
            discoveredThinkingCapabilities[modelEntryKey(provider, String(model.id))] = thinking;
          }
          if (provider && model?.id && Array.isArray(model?.capabilities)) {
            discoveredWireCapabilities[modelEntryKey(provider, String(model.id))] = Array.from(new Set(
              model.capabilities.map((value: unknown) => String(value || '').trim()).filter(Boolean),
            ));
          }
        });
      });
      let storedWireCapabilities: Record<string, string[]> = {};
      try {
        storedWireCapabilities = JSON.parse(appStorage.getItem(MODEL_WIRE_CAPABILITIES_STORAGE_KEY) || '{}');
      } catch { }
      appStorage.setItem(MODEL_WIRE_CAPABILITIES_STORAGE_KEY, JSON.stringify({
        ...storedWireCapabilities,
        ...discoveredWireCapabilities,
      }));
      setModelThinkingCapabilities(previous => {
        const next = { ...previous, ...discoveredThinkingCapabilities };
        appStorage.setItem(MODEL_THINKING_CAPABILITIES_STORAGE_KEY, JSON.stringify(next));
        broadcastEterxSettingsUpdate({
          type: 'model-thinking-capabilities-updated',
          thinkingCapabilities: next,
        });
        return next;
      });
      // Discovery is read-only with respect to the user's chat selector.
      // A live catalog must never insert a provider default, remove an exact
      // manually-added model, or change the active chat model by itself.
      const discoveredContextWindows: Record<string, number> = {};
      Object.values(payload.providers || {}).forEach((providerValue: any) => {
        const provider = String(providerValue?.provider || '');
        (providerValue?.models || []).forEach((model: any) => {
          const limit = Number(model?.inputTokenLimit || model?.contextLength || 0);
          if (provider && model?.id && Number.isFinite(limit) && limit >= 16_000 && limit <= 4_000_000) {
            discoveredContextWindows[modelEntryKey(provider, String(model.id))] = Math.floor(limit);
          }
        });
      });
      let storedContextWindows: Record<string, number> = {};
      try {
        storedContextWindows = JSON.parse(appStorage.getItem(MODEL_CONTEXT_WINDOWS_STORAGE_KEY) || '{}');
      } catch { }
      const validStoredContextWindows = Object.fromEntries(
        Object.entries(storedContextWindows).flatMap(([key, value]) => {
          const limit = Number(value);
          return key && Number.isFinite(limit) && limit >= 16_000 && limit <= 4_000_000
            ? [[key, Math.floor(limit)]]
            : [];
        }),
      );
      const nextContextWindows = { ...validStoredContextWindows, ...discoveredContextWindows };
      appStorage.setItem(MODEL_CONTEXT_WINDOWS_STORAGE_KEY, JSON.stringify(nextContextWindows));
      broadcastEterxSettingsUpdate({
        type: 'model-context-windows-updated',
        contextWindows: nextContextWindows,
      });
      setModelDirectoryUpdatedAt(payload.updatedAt || Date.now());
      setModelDirectoryStatus('ready');
      } catch (error) {
        if (discoveryRevision === settingsRevisionRef.current) setModelDirectoryStatus('error');
      }
    };
    const queued = modelDirectoryRequestChainRef.current.then(runDiscovery, runDiscovery);
    modelDirectoryRequestChainRef.current = queued;
    await queued;
  }, [apiKeys, modelApiKeys, modelEntries, modelOverrides, persistDesktopRuntimeSettings, selectedConnectionProvider]);

  const syncApiKeys = useCallback(async (keys: Record<string, string>, silent = false, overrides: ModelOverrides = {}) => {
    const cleanKeys = Object.fromEntries(
      Object.entries(keys)
        .map(([key, value]) => [key, String(value || '').trim()])
        .filter(([, value]) => Boolean(value)),
    );
    const cleanModelOverrides = Object.fromEntries(
      Object.entries(overrides)
        .map(([provider, model]) => [provider, String(model || '').trim()])
        .filter(([provider, model]) => isModelProvider(provider) && Boolean(model)),
    );

    if (!silent) {
      setApiSyncStatus('syncing');
      setApiSyncMessage('Syncing keys with the local EterX runtime...');
    }

    try {
      const res = await fetch('/api/settings/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKeys: cleanKeys,
          modelOverrides: cleanModelOverrides,
          baseURLs: providerBaseURLsRef.current,
          persist: false,
        }),
      });
      const payload = await res.json();
      if (!res.ok || !payload?.ok) throw new Error(payload?.error || 'Key sync failed');

      setApiProviderStatus(Array.isArray(payload.providers) ? payload.providers : []);
      setApiSyncStatus('synced');
      const modelCount = Array.isArray(payload.modelOverrides)
        ? payload.modelOverrides.filter((item: any) => item?.accepted).length
        : 0;
      setApiSyncMessage(`${ payload.acceptedCount || 0 } key${ payload.acceptedCount === 1 ? '' : 's' } and ${ modelCount } model override${ modelCount === 1 ? '' : 's' } active.`);

      // Auto-refresh the model catalog only when there is a live credential or
      // override to discover. An empty snapshot still reaches the runtime so
      // clearing the last key cannot leave the previous key active.
      if (hasAnyApiKey(cleanKeys) || Object.keys(cleanModelOverrides).length > 0) {
        await refreshModelDirectory(cleanKeys, cleanModelOverrides);
      }
    } catch (error: any) {
      setApiSyncStatus('error');
      setApiSyncMessage(error?.message || 'Could not sync API keys.');
    }
  }, [hasAnyApiKey, refreshModelDirectory]);

  const dispatchRuntimeSync = useCallback(() => {
    const pending = runtimeSyncPendingRef.current;
    runtimeSyncPendingRef.current = null;
    if (!pending) return;

    const selection = appStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) || AUTO_MODEL_SELECTION;
    const composed = composeRuntimeApiKeys(
      pending.apiKeys,
      pending.modelApiKeys,
      pending.modelEntries,
      [
        selection,
        settings.contextCompactionModelSelection || AUTO_MODEL_SELECTION,
        ...(pending.selectionKeys || []),
      ],
    );
    const run = () => syncApiKeys(composed, false, pending.modelOverrides);
    const queued = runtimeSyncChainRef.current.then(run, run);
    runtimeSyncChainRef.current = queued;
  }, [settings.contextCompactionModelSelection, syncApiKeys]);

  const queueRuntimeSync = useCallback((snapshot: RuntimeSettingsSnapshot, immediate = false) => {
    runtimeSyncPendingRef.current = {
      apiKeys: { ...snapshot.apiKeys },
      modelApiKeys: { ...snapshot.modelApiKeys },
      modelOverrides: { ...snapshot.modelOverrides },
      modelEntries: snapshot.modelEntries.map(entry => ({ ...entry })),
      selectionKeys: snapshot.selectionKeys ? [...snapshot.selectionKeys] : undefined,
    };
    if (runtimeSyncTimerRef.current) clearTimeout(runtimeSyncTimerRef.current);
    if (immediate) {
      dispatchRuntimeSync();
      return;
    }
    runtimeSyncTimerRef.current = setTimeout(() => {
      runtimeSyncTimerRef.current = null;
      dispatchRuntimeSync();
    }, 250);
  }, [dispatchRuntimeSync]);
  const queueRuntimeSyncRef = useRef(queueRuntimeSync);
  queueRuntimeSyncRef.current = queueRuntimeSync;

  const flushRuntimeSync = useCallback(async () => {
    if (runtimeSyncTimerRef.current) {
      clearTimeout(runtimeSyncTimerRef.current);
      runtimeSyncTimerRef.current = null;
    }
    dispatchRuntimeSync();
    await runtimeSyncChainRef.current;
  }, [dispatchRuntimeSync]);

  const performSync = useCallback(async () => {
    if (!keysChangedRef.current && !runtimeSyncPendingRef.current) return;
    keysChangedRef.current = false;
    if (!runtimeSyncPendingRef.current) {
      queueRuntimeSync({
        apiKeys: apiKeysRef.current,
        modelApiKeys: modelApiKeysRef.current,
        modelOverrides: modelOverridesRef.current,
        modelEntries,
      }, true);
    }
    await flushRuntimeSync();
  }, [flushRuntimeSync, modelEntries, queueRuntimeSync]);

  // Load preferences and runtime credentials from the AppData-backed stores.
  useEffect(() => {
    let cancelled = false;
    const loadRevision = settingsRevisionRef.current;
    const loadSettings = async () => {
      try {
      const storageLoaded = await appStorageReady;
      // A transient storage failure must never turn an empty in-memory view
      // into a saved empty model/settings snapshot. The storage-ready event
      // below retries synchronization after the durable store recovers.
      if (!storageLoaded || cancelled || settingsRevisionRef.current !== loadRevision) return;
      const saved = appStorage.getItem('eterx_settings');
      let nextSettings = normalizeAppSettings(saved ? JSON.parse(saved) : {});
      if (saved) {
        if (!['auto', 'powershell', 'cmd', 'git-bash', 'wsl', 'zsh', 'bash', 'fish', 'sh'].includes(nextSettings.terminalShell)) {
          nextSettings.terminalShell = 'auto';
        }
      }
      const normalizedLiveProvider = normalizeLiveProvider(nextSettings.liveConvoProvider);
      nextSettings.liveConvoProvider = normalizedLiveProvider.value;
      if (!isLiveModelForProvider(normalizedLiveProvider.value, nextSettings.liveConvoModel)) {
        nextSettings.liveConvoModel = 'auto';
      }
      const savedModelOverrides = appStorage.getItem(MODEL_OVERRIDE_STORAGE_KEY);
      const savedModelCatalog = appStorage.getItem(MODEL_CATALOG_STORAGE_KEY);
      const savedModelEntries = appStorage.getItem(MODEL_SELECTOR_STORAGE_KEY);
      const savedThinkingCapabilities = appStorage.getItem(MODEL_THINKING_CAPABILITIES_STORAGE_KEY);
      const savedProviderBaseURLs = appStorage.getItem(PROVIDER_BASE_URLS_STORAGE_KEY);
      const needsSelectorSchemaMigration = appStorage.getItem(MODEL_SELECTOR_SCHEMA_STORAGE_KEY) !== MODEL_SELECTOR_SCHEMA_VERSION;
      const parsedModelOverrides = savedModelOverrides ? JSON.parse(savedModelOverrides) : {};
      const parsedModelCatalog = savedModelCatalog ? JSON.parse(savedModelCatalog) : {};
      const parsedThinkingCapabilities = savedThinkingCapabilities ? JSON.parse(savedThinkingCapabilities) : {};
      const parsedProviderBaseURLs = savedProviderBaseURLs ? JSON.parse(savedProviderBaseURLs) : {};
      const migratedEntries = normalizeModelSelectorEntries(
        savedModelEntries ? JSON.parse(savedModelEntries) : undefined,
        parsedModelCatalog,
      );
      const normalizedEntries = normalizeModelSelectorEntries(migratedEntries, parsedModelCatalog);
      const normalizedCatalog = entriesToModelCatalog(normalizedEntries) as ModelCatalog;
      const desktopApi = (window as any)?.electronAPI;
      const folderRuntimeSettings = await fetch('/api/settings/runtime', { cache: 'no-store' })
        .then(response => response.ok ? response.json() : null)
        .then(payload => payload?.settings && typeof payload.settings === 'object' ? payload.settings : {})
        .catch(() => ({}));
      const persistedApiRetries = Number(folderRuntimeSettings?.apiRetries);
      if (Number.isFinite(persistedApiRetries)) {
        nextSettings.maxRetries = Math.max(0, Math.min(3, Math.floor(persistedApiRetries)));
      }
      if (
        (!saved || !Object.prototype.hasOwnProperty.call(JSON.parse(saved), 'selfImprovementEnabled'))
        && folderRuntimeSettings?.selfImprovement
        && typeof folderRuntimeSettings.selfImprovement === 'object'
      ) {
        nextSettings.selfImprovementEnabled = folderRuntimeSettings.selfImprovement.enabled !== false;
      }
      const secureSettings = typeof desktopApi?.getSecureRuntimeSettings === 'function'
        ? await desktopApi.getSecureRuntimeSettings().catch(() => null)
        : null;
      if (cancelled || settingsRevisionRef.current !== loadRevision) return;
      const secureApiKeys = secureSettings?.available && secureSettings.apiKeys && typeof secureSettings.apiKeys === 'object'
        ? secureSettings.apiKeys
        : null;
      const secureLiveApiKeys = secureSettings?.available && secureSettings.liveApiKeys && typeof secureSettings.liveApiKeys === 'object'
        ? secureSettings.liveApiKeys
        : null;
      const secureModelApiKeys = secureSettings?.available && secureSettings.modelApiKeys && typeof secureSettings.modelApiKeys === 'object'
        ? secureSettings.modelApiKeys
        : null;
      const secureModelOverrides = secureSettings?.available && secureSettings.modelOverrides && typeof secureSettings.modelOverrides === 'object'
        ? secureSettings.modelOverrides
        : null;
      const secureBaseURLs = secureSettings?.available && secureSettings.baseURLs && typeof secureSettings.baseURLs === 'object' && !Array.isArray(secureSettings.baseURLs)
        && Object.keys(secureSettings.baseURLs).length > 0
        ? secureSettings.baseURLs
        : null;
      const secureSearchSettings = secureSettings?.available && secureSettings.search && typeof secureSettings.search === 'object'
        ? secureSettings.search
        : null;
      const secureImageSettings = secureSettings?.available && secureSettings.image && typeof secureSettings.image === 'object'
        ? secureSettings.image
        : null;
      const secureVideoSettings = secureSettings?.available && secureSettings.video && typeof secureSettings.video === 'object'
        ? secureSettings.video
        : null;
      const folderApiKeys = folderRuntimeSettings?.apiKeys && typeof folderRuntimeSettings.apiKeys === 'object'
        ? folderRuntimeSettings.apiKeys
        : {};
      const folderLiveApiKeys = folderRuntimeSettings?.liveApiKeys && typeof folderRuntimeSettings.liveApiKeys === 'object'
        ? folderRuntimeSettings.liveApiKeys
        : {};
      const folderModelApiKeys = folderRuntimeSettings?.modelApiKeys && typeof folderRuntimeSettings.modelApiKeys === 'object'
        ? folderRuntimeSettings.modelApiKeys
        : {};
      const folderModelOverrides = folderRuntimeSettings?.modelOverrides && typeof folderRuntimeSettings.modelOverrides === 'object'
        ? folderRuntimeSettings.modelOverrides
        : {};
      const folderBaseURLs = folderRuntimeSettings && Object.prototype.hasOwnProperty.call(folderRuntimeSettings, 'baseURLs')
        && folderRuntimeSettings.baseURLs && typeof folderRuntimeSettings.baseURLs === 'object' && !Array.isArray(folderRuntimeSettings.baseURLs)
        ? folderRuntimeSettings.baseURLs
        : null;
      const folderSearchSettings = folderRuntimeSettings?.search && typeof folderRuntimeSettings.search === 'object'
        ? folderRuntimeSettings.search
        : null;
      const folderImageSettings = folderRuntimeSettings?.image && typeof folderRuntimeSettings.image === 'object'
        ? folderRuntimeSettings.image
        : null;
      const folderVideoSettings = folderRuntimeSettings?.video && typeof folderRuntimeSettings.video === 'object'
        ? folderRuntimeSettings.video
        : null;
      const parsedApiKeys = { ...folderApiKeys, ...(secureApiKeys || {}) };
      const parsedLiveApiKeys = { ...folderLiveApiKeys, ...(secureLiveApiKeys || {}) };
      const parsedModelApiKeys = { ...folderModelApiKeys, ...(secureModelApiKeys || {}) };
      const effectiveModelOverrides = Object.keys(folderModelOverrides).length > 0 || Object.keys(secureModelOverrides || {}).length > 0
        ? { ...folderModelOverrides, ...(secureModelOverrides || {}) }
        : parsedModelOverrides;
      const normalizedApiKeys = parsedApiKeys && typeof parsedApiKeys === 'object'
        ? Object.fromEntries(
          Object.entries(parsedApiKeys as Record<string, unknown>)
            .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : ''])
            .filter(([, value]) => Boolean(value)),
        )
        : {};
      const effectiveSearchSource = {
        ...(secureSearchSettings || {}),
        ...(folderSearchSettings || {}),
        apiKeys: {
          ...(secureSearchSettings?.apiKeys || {}),
          ...(folderSearchSettings?.apiKeys || {}),
        },
        baseURLs: {
          ...(secureSearchSettings?.baseURLs || {}),
          ...(folderSearchSettings?.baseURLs || {}),
        },
        enabledServices: {
          ...(secureSearchSettings?.enabledServices || {}),
          ...(folderSearchSettings?.enabledServices || {}),
        },
      };
      const effectiveSearchSettings = normalizeSearchSettings(
        { ...effectiveSearchSource, enabled: nextSettings.groundingSearch },
        (folderSearchSettings || secureSearchSettings) ? undefined : normalizedApiKeys.tavily,
      );
      const effectiveImageSource = {
        ...(secureImageSettings || {}),
        ...(folderImageSettings || {}),
        apiKeys: {
          ...(secureImageSettings?.apiKeys || {}),
          ...(folderImageSettings?.apiKeys || {}),
        },
        baseURLs: {
          ...(secureImageSettings?.baseURLs || {}),
          ...(folderImageSettings?.baseURLs || {}),
        },
        modelByProvider: {
          ...(secureImageSettings?.modelByProvider || {}),
          ...(folderImageSettings?.modelByProvider || {}),
        },
      };
      const effectiveImageSettings = normalizeImageSettings(effectiveImageSource);
      const effectiveVideoSettings = normalizeVideoSettings({ ...(secureVideoSettings || {}), ...(folderVideoSettings || {}), apiKeys: { ...(secureVideoSettings?.apiKeys || {}), ...(folderVideoSettings?.apiKeys || {}) }, modelByProvider: { ...(secureVideoSettings?.modelByProvider || {}), ...(folderVideoSettings?.modelByProvider || {}) } });
      const normalizedLiveApiKeys = parsedLiveApiKeys && typeof parsedLiveApiKeys === 'object'
        ? Object.fromEntries(
          Object.entries(parsedLiveApiKeys as Record<string, unknown>)
            .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : ''])
            .filter(([, value]) => Boolean(value)),
        )
        : {};
      const normalizedModelApiKeys = parsedModelApiKeys && typeof parsedModelApiKeys === 'object'
        ? Object.fromEntries(
          Object.entries(parsedModelApiKeys as Record<string, unknown>)
            .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : ''])
            .filter(([, value]) => Boolean(value)),
        )
        : {};
      const normalizedModelOverrides = effectiveModelOverrides && typeof effectiveModelOverrides === 'object'
        ? Object.fromEntries(
          Object.entries(effectiveModelOverrides as Record<string, unknown>)
            .map(([provider, model]) => [provider, typeof model === 'string' ? model.trim() : ''])
            .filter(([provider, model]) =>
              isModelProvider(provider)
              && Boolean(model)
              && !isEmbeddedModelLabel(model)
              && normalizedEntries.some(entry => entry.provider === provider && entry.modelId === model)
            ),
        )
        : {};
      const resolvedModelEntries = normalizeModelSelectorEntries(normalizedEntries, normalizedCatalog);
      const storedChatModelSelection = appStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) || AUTO_MODEL_SELECTION;
      const parsedStoredChatModel = parseModelEntryKey(storedChatModelSelection);
      const resolvedModelCatalog = entriesToModelCatalog(resolvedModelEntries) as ModelCatalog;
      const usableResolvedEntries = resolvedModelEntries.filter(entry =>
        isLocalModelProvider(entry.provider)
        || Boolean(normalizedApiKeys[entry.provider])
        || Boolean(normalizedModelApiKeys[modelEntryKey(entry.provider, entry.modelId)])
      );
      const resolvedChatModelSelection = parsedStoredChatModel && usableResolvedEntries.some(entry =>
        modelEntryKey(entry.provider, entry.modelId) === storedChatModelSelection
      )
        ? storedChatModelSelection
        : usableResolvedEntries[0]
          ? modelEntryKey(usableResolvedEntries[0].provider, usableResolvedEntries[0].modelId)
          : AUTO_MODEL_SELECTION;
      setSettings(nextSettings);
      appStorage.setItem('eterx_settings', JSON.stringify(nextSettings));
      setModelEntries(resolvedModelEntries);
      setModelCatalog(resolvedModelCatalog);
      setChatModelSelection(resolvedChatModelSelection);
      setModelApiKeys(normalizedModelApiKeys);
      setModelThinkingCapabilities(
        parsedThinkingCapabilities && typeof parsedThinkingCapabilities === 'object'
          ? Object.fromEntries(
            Object.entries(parsedThinkingCapabilities as Record<string, unknown>)
              .map(([key, value]) => [key, normalizeModelThinkingCapabilities(value)] as const)
              .filter(([, value]) => Boolean(value)),
          ) as Record<string, ModelThinkingCapabilities>
          : {},
      );
      appStorage.setItems({
        [MODEL_SELECTOR_STORAGE_KEY]: JSON.stringify(resolvedModelEntries),
        [MODEL_CATALOG_STORAGE_KEY]: JSON.stringify(resolvedModelCatalog),
        [MODEL_OVERRIDE_STORAGE_KEY]: JSON.stringify(normalizedModelOverrides),
        [CHAT_MODEL_SELECTION_STORAGE_KEY]: resolvedChatModelSelection,
      });
      setModelOverrides(normalizedModelOverrides);
      setApiKeys(normalizedApiKeys);
      modelEntriesRef.current = resolvedModelEntries;
      modelApiKeysRef.current = normalizedModelApiKeys;
      modelOverridesRef.current = normalizedModelOverrides;
      apiKeysRef.current = normalizedApiKeys;
      searchSettingsRef.current = effectiveSearchSettings;
      setSearchSettings(effectiveSearchSettings);
      imageSettingsRef.current = effectiveImageSettings;
      setImageSettings(effectiveImageSettings);
      videoSettingsRef.current = effectiveVideoSettings;
      setVideoSettings(effectiveVideoSettings);
      setLiveApiKeys(normalizedLiveApiKeys);
      liveApiKeysRef.current = normalizedLiveApiKeys;
      persistApiKeyPresence(normalizedApiKeys, normalizedModelApiKeys);
      const effectiveBaseURLSource = folderBaseURLs ?? secureBaseURLs ?? parsedProviderBaseURLs;
      const effectiveBaseURLs = effectiveBaseURLSource && typeof effectiveBaseURLSource === 'object' && !Array.isArray(effectiveBaseURLSource)
        ? Object.fromEntries(
            Object.entries(effectiveBaseURLSource as Record<string, unknown>)
              .map(([provider, value]) => [provider, typeof value === 'string' ? value.trim() : ''])
              .filter(([provider, value]) => isModelProvider(provider) && Boolean(value)),
          )
        : {};
      providerBaseURLsRef.current = effectiveBaseURLs;
      providerBaseURLDirtyRef.current = folderBaseURLs === null && secureBaseURLs === null && Object.keys(effectiveBaseURLs).length > 0;
      setProviderBaseURLs(effectiveBaseURLs);

      if (needsSelectorSchemaMigration) {
        const migrationSaved = await persistDesktopRuntimeSettings(
          normalizedApiKeys,
          normalizedModelApiKeys,
          normalizedModelOverrides,
          effectiveBaseURLs,
        );
        if (migrationSaved !== false) {
          appStorage.setItem(MODEL_SELECTOR_SCHEMA_STORAGE_KEY, MODEL_SELECTOR_SCHEMA_VERSION);
        }
      }

      if (cancelled || settingsRevisionRef.current !== loadRevision) return;
      queueRuntimeSyncRef.current({
        apiKeys: normalizedApiKeys,
        modelApiKeys: normalizedModelApiKeys,
        modelOverrides: normalizedModelOverrides,
        modelEntries: resolvedModelEntries,
      }, true);
      runtimeSettingsHydratedRef.current = true;
      } catch (error) {
        console.warn('Could not load runtime settings:', error);
      }
    };
    void loadSettings();
    return () => {
      cancelled = true;
    };
  }, [persistApiKeyPresence, persistDesktopRuntimeSettings]);

  // Keep an idle Settings panel aligned with another localhost/Electron
  // window. AppData is authoritative; pending edits in this panel are never
  // replaced while the user is actively changing settings.
  useEffect(() => {
    if (hasChanges) return;
    let cancelled = false;
    const readJson = (key: string, fallback: unknown) => {
      try {
        const raw = appStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    };
    const normalizeStringMap = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {} as Record<string, string>;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .map(([key, item]) => [key, Array.isArray(item) ? item.join('\n') : typeof item === 'string' ? item.trim() : ''])
          .filter(([, item]) => Boolean(item)),
      );
    };
    const syncExternalSettings = async () => {
      await appStorageReady;
      if (cancelled || hasChanges) return;

      const storedSettings = readJson('eterx_settings', {}) as Record<string, unknown>;
      const storedCatalog = readJson(MODEL_CATALOG_STORAGE_KEY, {}) as ModelCatalog;
      const storedEntries = readJson(MODEL_SELECTOR_STORAGE_KEY, []);
      const storedOverrides = normalizeStringMap(readJson(MODEL_OVERRIDE_STORAGE_KEY, {}));
      const storedBaseURLs = normalizeStringMap(readJson(PROVIDER_BASE_URLS_STORAGE_KEY, {}));
      const storedThinking = readJson(MODEL_THINKING_CAPABILITIES_STORAGE_KEY, {});
      const storedChatModelSelection = appStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) || AUTO_MODEL_SELECTION;
      const syncedEntries = normalizeModelSelectorEntries(storedEntries, storedCatalog);
      const syncedCatalog = entriesToModelCatalog(syncedEntries) as ModelCatalog;
      const syncedChatModelSelection = parseModelEntryKey(storedChatModelSelection)
        && syncedEntries.some(entry => modelEntryKey(entry.provider, entry.modelId) === storedChatModelSelection)
        ? storedChatModelSelection
        : syncedEntries[0]
          ? modelEntryKey(syncedEntries[0].provider, syncedEntries[0].modelId)
          : AUTO_MODEL_SELECTION;

      let runtime: any = {};
      try {
        const response = await fetch('/api/settings/runtime', { cache: 'no-store' });
        const payload = await response.json();
        if (response.ok && payload?.settings && typeof payload.settings === 'object') runtime = payload.settings;
      } catch { }
      const desktopApi = (window as any)?.electronAPI;
      let secure: any = null;
      try {
        secure = typeof desktopApi?.getSecureRuntimeSettings === 'function'
          ? await desktopApi.getSecureRuntimeSettings()
          : null;
      } catch { }
      if (cancelled || hasChanges) return;
      const runtimeApiKeys = normalizeStringMap({ ...(runtime.apiKeys || {}), ...(secure?.apiKeys || {}) });
      const runtimeLiveApiKeys = normalizeStringMap({ ...(runtime.liveApiKeys || {}), ...(secure?.liveApiKeys || {}) });
      const runtimeModelApiKeys = normalizeStringMap({ ...(runtime.modelApiKeys || {}), ...(secure?.modelApiKeys || {}) });
      const runtimeOverrides = normalizeStringMap({ ...(runtime.modelOverrides || {}), ...(secure?.modelOverrides || {}) });
      const runtimeBaseURLs = normalizeStringMap({ ...(runtime.baseURLs || {}), ...(secure?.baseURLs || {}) });
      const runtimeSearchSettings = {
        ...(secure?.search || {}),
        ...(runtime.search || {}),
        apiKeys: { ...(secure?.search?.apiKeys || {}), ...(runtime.search?.apiKeys || {}) },
        baseURLs: { ...(secure?.search?.baseURLs || {}), ...(runtime.search?.baseURLs || {}) },
        enabledServices: { ...(secure?.search?.enabledServices || {}), ...(runtime.search?.enabledServices || {}) },
      };
      const runtimeImageSettings = {
        ...(secure?.image || {}),
        ...(runtime.image || {}),
        apiKeys: { ...(secure?.image?.apiKeys || {}), ...(runtime.image?.apiKeys || {}) },
        baseURLs: { ...(secure?.image?.baseURLs || {}), ...(runtime.image?.baseURLs || {}) },
        modelByProvider: { ...(secure?.image?.modelByProvider || {}), ...(runtime.image?.modelByProvider || {}) },
      };
      const runtimeVideoSettings = {
        ...(secure?.video || {}),
        ...(runtime.video || {}),
        apiKeys: { ...(secure?.video?.apiKeys || {}), ...(runtime.video?.apiKeys || {}) },
        modelByProvider: { ...(secure?.video?.modelByProvider || {}), ...(runtime.video?.modelByProvider || {}) },
      };
      const nextSearchSettings = normalizeSearchSettings(
        runtimeSearchSettings,
        (runtime.search || secure?.search) ? undefined : runtimeApiKeys.tavily,
      );
      const nextImageSettings = normalizeImageSettings(runtimeImageSettings);
      const nextVideoSettings = normalizeVideoSettings(runtimeVideoSettings);
      const nextOverrides = Object.keys(storedOverrides).length > 0 || appStorage.getItem(MODEL_OVERRIDE_STORAGE_KEY) !== null
        ? storedOverrides
        : runtimeOverrides;
      const nextBaseURLs = Object.keys(storedBaseURLs).length > 0 || appStorage.getItem(PROVIDER_BASE_URLS_STORAGE_KEY) !== null
        ? storedBaseURLs
        : runtimeBaseURLs;
      const syncedThinking = storedThinking && typeof storedThinking === 'object' && !Array.isArray(storedThinking)
        ? Object.fromEntries(
            Object.entries(storedThinking as Record<string, unknown>)
              .map(([key, value]) => [key, normalizeModelThinkingCapabilities(value)] as const)
              .filter(([, value]) => Boolean(value)),
          ) as Record<string, ModelThinkingCapabilities>
        : {};

      setSettings(current => normalizeAppSettings({ ...current, ...storedSettings }));
      setApiKeys(runtimeApiKeys);
      setSearchSettings(current => JSON.stringify(current) === JSON.stringify(nextSearchSettings) ? current : nextSearchSettings);
      setImageSettings(current => JSON.stringify(current) === JSON.stringify(nextImageSettings) ? current : nextImageSettings);
      setVideoSettings(current => JSON.stringify(current) === JSON.stringify(nextVideoSettings) ? current : nextVideoSettings);
      setLiveApiKeys(runtimeLiveApiKeys);
      setModelApiKeys(runtimeModelApiKeys);
      setModelOverrides(current => JSON.stringify(current) === JSON.stringify(nextOverrides) ? current : nextOverrides);
      setModelEntries(syncedEntries);
      setModelCatalog(syncedCatalog);
      setChatModelSelection(syncedChatModelSelection);
      setModelThinkingCapabilities(syncedThinking);
      setProviderBaseURLs(current => JSON.stringify(current) === JSON.stringify(nextBaseURLs) ? current : nextBaseURLs);
      apiKeysRef.current = runtimeApiKeys;
      searchSettingsRef.current = nextSearchSettings;
      imageSettingsRef.current = nextImageSettings;
      videoSettingsRef.current = nextVideoSettings;
      liveApiKeysRef.current = runtimeLiveApiKeys;
      modelApiKeysRef.current = runtimeModelApiKeys;
      modelOverridesRef.current = nextOverrides;
      modelEntriesRef.current = syncedEntries;
      providerBaseURLsRef.current = nextBaseURLs;
    };
    const onExternalCommit = () => { void syncExternalSettings(); };
    window.addEventListener(FOLDER_STORAGE_READY_EVENT, onExternalCommit);
    window.addEventListener('eterx-folder-storage-updated', onExternalCommit);
    window.addEventListener('focus', onExternalCommit);
    return () => {
      cancelled = true;
      window.removeEventListener(FOLDER_STORAGE_READY_EVENT, onExternalCommit);
      window.removeEventListener('eterx-folder-storage-updated', onExternalCommit);
      window.removeEventListener('focus', onExternalCommit);
    };
  }, [hasChanges]);

  // Active model selection is small, conflict-free state. Keep it live even
  // while the panel protects other in-progress edits from a full reload.
  useEffect(() => {
    const applySelection = (detail?: unknown) => {
      const requested = detail && typeof detail === 'object'
        && typeof (detail as { chatModelSelection?: unknown }).chatModelSelection === 'string'
        ? String((detail as { chatModelSelection: string }).chatModelSelection)
        : appStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) || AUTO_MODEL_SELECTION;
      const entries = modelEntriesRef.current;
      const nextSelection = parseModelEntryKey(requested)
        && entries.some(entry => modelEntryKey(entry.provider, entry.modelId) === requested)
        ? requested
        : AUTO_MODEL_SELECTION;
      setChatModelSelection(current => current === nextSelection ? current : nextSelection);
    };
    const onLocalUpdate = (event: Event) => applySelection((event as CustomEvent).detail);
    const onStorageUpdate = () => applySelection();

    window.addEventListener('eterx-settings-updated', onLocalUpdate);
    window.addEventListener(FOLDER_STORAGE_READY_EVENT, onStorageUpdate);
    window.addEventListener('eterx-folder-storage-updated', onStorageUpdate);

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(SETTINGS_CHANNEL);
      channel.onmessage = event => applySelection(event.data?.settings);
    } catch {
      channel = null;
    }

    return () => {
      window.removeEventListener('eterx-settings-updated', onLocalUpdate);
      window.removeEventListener(FOLDER_STORAGE_READY_EVENT, onStorageUpdate);
      window.removeEventListener('eterx-folder-storage-updated', onStorageUpdate);
      channel?.close();
    };
  }, []);

  useEffect(() => {
    providerBaseURLsRef.current = providerBaseURLs;
    appStorage.setItem(PROVIDER_BASE_URLS_STORAGE_KEY, JSON.stringify(providerBaseURLs));
    if (!providerBaseURLDirtyRef.current) return;
    if (providerBaseURLSyncTimerRef.current) clearTimeout(providerBaseURLSyncTimerRef.current);
    const snapshot = { ...providerBaseURLs };
    providerBaseURLSyncTimerRef.current = setTimeout(() => {
      providerBaseURLSyncTimerRef.current = null;
      const sync = () => fetch('/api/settings/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseURLs: snapshot }),
      }).then(async response => {
        if (!response.ok) return false;
        const runtimeSaved = await persistDesktopRuntimeSettings(
          apiKeysRef.current,
          modelApiKeysRef.current,
          modelOverridesRef.current,
          snapshot,
        );
        if (runtimeSaved === false) return false;
        if (JSON.stringify(providerBaseURLsRef.current) === JSON.stringify(snapshot)) {
          providerBaseURLDirtyRef.current = false;
        }
        return true;
      }).catch(() => {
        providerBaseURLDirtyRef.current = true;
        return false;
      });
      providerBaseURLSyncChainRef.current = providerBaseURLSyncChainRef.current.then(sync, sync);
    }, 250);
    return () => {
      if (providerBaseURLSyncTimerRef.current) {
        clearTimeout(providerBaseURLSyncTimerRef.current);
        providerBaseURLSyncTimerRef.current = null;
      }
    };
  }, [persistDesktopRuntimeSettings, providerBaseURLs]);

  const flushProviderBaseURLSync = useCallback(async () => {
    const hasPendingTimer = Boolean(providerBaseURLSyncTimerRef.current);
    if (!providerBaseURLDirtyRef.current && !hasPendingTimer) {
      const result = await providerBaseURLSyncChainRef.current;
      if (result !== false) return true;
      // A previous failed request must not permanently poison future update
      // flushes. Mark it dirty and immediately retry the current snapshot.
      providerBaseURLDirtyRef.current = true;
    }
    if (providerBaseURLSyncTimerRef.current) {
      clearTimeout(providerBaseURLSyncTimerRef.current);
      providerBaseURLSyncTimerRef.current = null;
    }
    const snapshot = { ...providerBaseURLs };
    const sync = () => fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseURLs: snapshot }),
    }).then(async response => {
      if (!response.ok) return false;
      const runtimeSaved = await persistDesktopRuntimeSettings(
        apiKeysRef.current,
        modelApiKeysRef.current,
        modelOverridesRef.current,
        snapshot,
      );
      if (runtimeSaved === false) return false;
      if (JSON.stringify(providerBaseURLsRef.current) === JSON.stringify(snapshot)) {
        providerBaseURLDirtyRef.current = false;
      }
      return true;
    }).catch(() => {
      providerBaseURLDirtyRef.current = true;
      return false;
    });
    providerBaseURLSyncChainRef.current = providerBaseURLSyncChainRef.current.then(sync, sync);
    const result = await providerBaseURLSyncChainRef.current;
    return result !== false;
  }, [persistDesktopRuntimeSettings, providerBaseURLs]);

  useEffect(() => {
    return registerDurableFlush(async () => {
      // Do not write default empty refs while the initial AppData snapshot is
      // still loading. Once hydrated, always retry a complete current
      // snapshot; this recovers from an earlier localhost write failure that
      // would otherwise leave the old rejected promise in the flush chain.
      if (!runtimeSettingsHydratedRef.current) {
        const deadline = Date.now() + 10_000;
        while (!runtimeSettingsHydratedRef.current && Date.now() < deadline) {
          await new Promise(resolve => window.setTimeout(resolve, 200));
        }
      }
      if (!runtimeSettingsHydratedRef.current) return false;
      await flushRuntimeSync();
      const currentRuntimeSaved = await persistDesktopRuntimeSettings(
        apiKeysRef.current,
        modelApiKeysRef.current,
        modelOverridesRef.current,
        providerBaseURLsRef.current,
      );
      const runtimeSettingsSaved = await runtimeSettingsWriteRef.current;
      const providerURLsSaved = await flushProviderBaseURLSync();
      return currentRuntimeSaved !== false && runtimeSettingsSaved !== false && providerURLsSaved;
    });
  }, [flushProviderBaseURLSync, flushRuntimeSync, persistDesktopRuntimeSettings]);

  // Fetch active provider key connection status when panel opens
  useEffect(() => {
    if (!isOpen) return;
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/settings/keys');
        const payload = await res.json();
        if (res.ok && payload.ok) {
          setApiProviderStatus(Array.isArray(payload.providers) ? payload.providers : []);
          setApiSyncStatus('synced');
          const modelCount = Array.isArray(payload.modelOverrides)
            ? payload.modelOverrides.filter((item: any) => item?.accepted).length
            : 0;
          setApiSyncMessage(`${ payload.acceptedCount || 0 } key${ payload.acceptedCount === 1 ? '' : 's' } and ${ modelCount } model override${ modelCount === 1 ? '' : 's' } active.`);
        }
      } catch (e) {
        console.error('Failed to load key status on open:', e);
      }
    };
    void fetchStatus();
  }, [isOpen]);

  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    settingsRevisionRef.current += 1;
    const commitSetting = () => setSettings(prev => {
      const safeValue = key === 'followUpBehavior'
        ? (value === 'queue' ? 'queue' : 'steer')
        : value;
      const next = normalizeAppSettings({
        ...prev,
        [key]: safeValue,
        ...(key === 'contextWindowSizeSelection' ? { contextWindowSizeSelectionTouched: true } : {}),
      });
      appStorage.setItem('eterx_settings', JSON.stringify(next));
      if (key === 'contextWindowSizeSelection') markContextBudgetEdit();
      broadcastEterxSettingsUpdate(next);
      if (key === 'selfImprovementEnabled') {
        void fetch('/api/settings/self-improvement', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: value !== false }),
        }).catch(error => console.warn('Could not persist self-improvement setting:', error));
      }
      if (key === 'maxRetries') {
        void fetch('/api/settings/runtime', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: { apiRetries: next.maxRetries } }),
        }).catch(error => console.warn('Could not persist API retry setting:', error));
      }
      return next;
    });
    if (key === 'theme') {
      transitionEterxTheme(
        value as AppSettings['theme'],
        () => flushSync(commitSetting),
      );
    } else {
      commitSetting();
    }
    setHasChanges(true);
  }, []);

  const updateContextCompactionModelSelection = useCallback((value: string) => {
    updateSetting('contextCompactionModelSelection', value);
    const activeSelection = appStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) || AUTO_MODEL_SELECTION;
    queueRuntimeSync({
      apiKeys: apiKeysRef.current,
      modelApiKeys: modelApiKeysRef.current,
      modelOverrides: modelOverridesRef.current,
      modelEntries,
      selectionKeys: [activeSelection, value || AUTO_MODEL_SELECTION],
    }, true);
  }, [modelEntries, queueRuntimeSync, updateSetting]);

  const updateContextChatOverride = useCallback((value: string) => {
    if (!selectedContextChatId) return;
    const validSelections = new Set(['global', ...CONTEXT_WINDOW_SIZE_OPTIONS.map(option => option.value)]);
    if (!validSelections.has(value)) return;
    setContextChatOverrides(previous => {
      const next = { ...previous };
      if (value === 'global') delete next[selectedContextChatId];
      else next[selectedContextChatId] = value;
      appStorage.setItem(CHAT_CONTEXT_WINDOW_OVERRIDES_STORAGE_KEY, JSON.stringify(next));
      markContextBudgetEdit(selectedContextChatId);
      broadcastEterxSettingsUpdate({
        type: 'context-window-overrides-updated',
        chatId: selectedContextChatId,
        contextWindowSizeSelection: value,
      });
      return next;
    });
    setHasChanges(true);
  }, [selectedContextChatId]);

  const handleClose = useCallback(() => {
    void performSync().finally(() => setHasChanges(false));
    onClose();
  }, [performSync, onClose]);

  const updateApiKey = useCallback((name: string, value: string) => {
    const trimmed = value.trim();
    settingsRevisionRef.current += 1;
    const next = { ...apiKeysRef.current, [name]: trimmed };
    apiKeysRef.current = next;
    setApiKeys(next);
    persistApiKeyPresence(next, modelApiKeysRef.current);
    void persistDesktopRuntimeSettings(next, modelApiKeysRef.current, modelOverridesRef.current);
    broadcastEterxSettingsUpdate({ type: 'api-keys-updated', apiKeysUpdated: [name] });
    queueRuntimeSync({
      apiKeys: next,
      modelApiKeys: modelApiKeysRef.current,
      modelOverrides: modelOverridesRef.current,
      modelEntries,
    });
    setHasChanges(true);
    keysChangedRef.current = true;
  }, [modelEntries, persistApiKeyPresence, persistDesktopRuntimeSettings, queueRuntimeSync]);

  const updateSearchSettings = useCallback((nextValue: SearchSettings | ((current: SearchSettings) => SearchSettings)) => {
    settingsRevisionRef.current += 1;
    const current = searchSettingsRef.current;
    const next = normalizeSearchSettings(
      typeof nextValue === 'function' ? nextValue(current) : nextValue,
    );
    searchSettingsRef.current = next;
    setSearchSettings(next);
    void persistDesktopRuntimeSettings(apiKeysRef.current, modelApiKeysRef.current, modelOverridesRef.current);
    broadcastEterxSettingsUpdate({ type: 'search-settings-updated', search: next });
    setHasChanges(true);
  }, [persistDesktopRuntimeSettings]);

  const updateImageSettings = useCallback((nextValue: ImageSettings | ((current: ImageSettings) => ImageSettings)) => {
    settingsRevisionRef.current += 1;
    const current = imageSettingsRef.current;
    const next = normalizeImageSettings(typeof nextValue === 'function' ? nextValue(current) : nextValue);
    imageSettingsRef.current = next;
    setImageSettings(next);
    void persistDesktopRuntimeSettings(apiKeysRef.current, modelApiKeysRef.current, modelOverridesRef.current);
    broadcastEterxSettingsUpdate({ type: 'image-settings-updated', image: next });
    setHasChanges(true);
  }, [persistDesktopRuntimeSettings]);

  const updateImageKeyPool = useCallback((provider: ImageProvider, value: string) => {
    updateImageSettings(current => ({
      ...current,
      apiKeys: { ...current.apiKeys, [provider]: splitApiKeyPool(value).slice(0, 3) },
    }));
  }, [updateImageSettings]);

  const moveImageFallback = useCallback((provider: ImageProvider, direction: -1 | 1) => {
    updateImageSettings(current => {
      const index = current.fallbackProviders.indexOf(provider);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.fallbackProviders.length) return current;
      const fallbackProviders = [...current.fallbackProviders];
      [fallbackProviders[index], fallbackProviders[target]] = [fallbackProviders[target], fallbackProviders[index]];
      return { ...current, fallbackProviders };
    });
  }, [updateImageSettings]);

  const testImageConnection = useCallback(async (provider: ImageProvider) => {
    setImageProbe({ provider, status: 'testing', message: 'Checking live connectivity...' });
    try {
      const response = await fetch('/api/settings/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          key: imageSettingsRef.current.apiKeys[provider]?.[0] || '',
          model: imageSettingsRef.current.modelByProvider[provider] || IMAGE_PROVIDER_META[provider].defaultModel,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'Connection test failed.');
      setImageProbe({ provider, status: 'success', message: payload.result?.message || 'Provider connection is ready.' });
    } catch (error: any) {
      setImageProbe({ provider, status: 'failed', message: error?.message || 'Connection test failed.' });
    }
  }, []);

  const updateVideoSettings = useCallback((nextValue: VideoSettings | ((current: VideoSettings) => VideoSettings)) => {
    settingsRevisionRef.current += 1;
    const current = videoSettingsRef.current;
    const next = normalizeVideoSettings(typeof nextValue === 'function' ? nextValue(current) : nextValue);
    videoSettingsRef.current = next;
    setVideoSettings(next);
    void persistDesktopRuntimeSettings(apiKeysRef.current, modelApiKeysRef.current, modelOverridesRef.current);
    broadcastEterxSettingsUpdate({ type: 'video-settings-updated', video: next });
    setHasChanges(true);
  }, [persistDesktopRuntimeSettings]);

  const updateVideoKeyPool = useCallback((provider: VideoProvider, value: string) => {
    updateVideoSettings(current => ({ ...current, apiKeys: { ...current.apiKeys, [provider]: splitApiKeyPool(value).slice(0, 3) } }));
  }, [updateVideoSettings]);

  const moveVideoFallback = useCallback((provider: VideoProvider, direction: -1 | 1) => {
    updateVideoSettings(current => {
      const index = current.fallbackProviders.indexOf(provider);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.fallbackProviders.length) return current;
      const fallbackProviders = [...current.fallbackProviders];
      [fallbackProviders[index], fallbackProviders[target]] = [fallbackProviders[target], fallbackProviders[index]];
      return { ...current, fallbackProviders };
    });
  }, [updateVideoSettings]);

  const testVideoConnection = useCallback(async (provider: VideoProvider) => {
    setVideoProbe({ provider, status: 'testing', message: 'Checking live connectivity...' });
    try {
      const response = await fetch('/api/settings/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, key: videoSettingsRef.current.apiKeys[provider]?.[0] || '', model: videoSettingsRef.current.modelByProvider[provider] || VIDEO_PROVIDER_META[provider].defaultModel }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'Connection test failed.');
      setVideoProbe({ provider, status: 'success', message: payload.result?.message || 'Provider connection is ready.' });
    } catch (error: any) {
      setVideoProbe({ provider, status: 'failed', message: error?.message || 'Connection test failed.' });
    }
  }, []);

  const updateSearchKeyPool = useCallback((provider: SearchProvider, value: string) => {
    updateSearchSettings(current => ({
      ...current,
      apiKeys: { ...current.apiKeys, [provider]: splitApiKeyPool(value).slice(0, 3) },
    }));
  }, [updateSearchSettings]);

  const toggleSearchService = useCallback((provider: SearchProvider, service: SearchService) => {
    updateSearchSettings(current => {
      const currentServices = current.enabledServices[provider] || [...SEARCH_SERVICE_IDS];
      const enabledServices = currentServices.includes(service)
        ? currentServices.filter(item => item !== service)
        : [...currentServices, service];
      return {
        ...current,
        enabledServices: { ...current.enabledServices, [provider]: enabledServices },
      };
    });
  }, [updateSearchSettings]);

  const testSearchConnection = useCallback(async (provider: SearchProvider) => {
    setSearchProbe({ provider, status: 'testing', message: 'Checking live connectivity...' });
    try {
      const response = await fetch('/api/settings/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          key: searchSettingsRef.current.apiKeys[provider]?.[0] || '',
          baseURL: searchSettingsRef.current.baseURLs[provider] || '',
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'Connection test failed.');
      setSearchProbe({ provider, status: 'success', message: `${payload.result?.resultCount || 0} live result${payload.result?.resultCount === 1 ? '' : 's'} returned.` });
    } catch (error: any) {
      setSearchProbe({ provider, status: 'failed', message: error?.message || 'Connection test failed.' });
    }
  }, []);

  const toggleSearchFallback = useCallback((provider: SearchProvider) => {
    updateSearchSettings(current => ({
      ...current,
      fallbackProviders: current.fallbackProviders.includes(provider)
        ? current.fallbackProviders.filter(item => item !== provider)
        : [...current.fallbackProviders, provider],
    }));
  }, [updateSearchSettings]);

  const moveSearchFallback = useCallback((provider: SearchProvider, direction: -1 | 1) => {
    updateSearchSettings(current => {
      const index = current.fallbackProviders.indexOf(provider);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.fallbackProviders.length) return current;
      const fallbackProviders = [...current.fallbackProviders];
      [fallbackProviders[index], fallbackProviders[target]] = [fallbackProviders[target], fallbackProviders[index]];
      return { ...current, fallbackProviders };
    });
  }, [updateSearchSettings]);

  const updateLiveApiKey = useCallback((name: string, value: string) => {
    const trimmed = value.trim();
    const next = { ...liveApiKeysRef.current };
    if (trimmed) next[name] = trimmed;
    else delete next[name];
    liveApiKeysRef.current = next;
    setLiveApiKeys(next);
    void persistDesktopRuntimeSettings(apiKeysRef.current, modelApiKeysRef.current, modelOverridesRef.current);
    setHasChanges(true);
  }, [persistDesktopRuntimeSettings]);

  // Close on escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    if (isOpen) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, handleClose]);

  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return;
    previouslyFocusedElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      const firstFocusable = settingsDialogRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      firstFocusable?.focus();
    });
    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(settingsDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) || []).filter(element => element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        settingsDialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleTab);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleTab);
      previouslyFocusedElementRef.current?.focus();
      previouslyFocusedElementRef.current = null;
    };
  }, [isOpen]);

  const activeLiveProvider = getLiveProvider(settings.liveConvoProvider);
  const activeLiveProviderValue = activeLiveProvider.value;
  const activeLiveProviderLabel = activeLiveProvider.label;
  const activeLiveProviderKey = activeLiveProvider.provider;
  const liveApiKeyProvider = activeLiveProvider.keyProvider;
  const liveApiKeyLabel = `${activeLiveProvider.label}`;
  const activeLiveApiKey = liveApiKeys[liveApiKeyProvider] || '';
  const discoveredLiveModels = (modelDirectory[activeLiveProviderKey]?.models || [])
    .filter(m => /live|native-audio/i.test(m.id));

  useEffect(() => {
    if (!isOpen || activeTab !== 'live-convo') return;
    let cancelled = false;
    const providerValue = activeLiveProviderValue;
    const timer = window.setTimeout(async () => {
      setLiveCatalogStatus('loading');
      setLiveCatalogMessage(`Loading ${activeLiveProviderLabel} models and voices…`);
      try {
        const [modelResponse, voiceResponse] = await Promise.all([
          fetch('/api/live/models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: providerValue }),
          }),
          fetch('/api/settings/live-voices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: providerValue, modelId: settings.liveConvoModel || 'auto' }),
          }),
        ]);
        const modelPayload = await modelResponse.json().catch(() => null);
        const voicePayload = await voiceResponse.json().catch(() => null);
        if (cancelled) return;

        const models = Array.isArray(modelPayload?.models) ? modelPayload.models : [];
        const normalizedModels = models.map((model: any) => ({
          value: String(model?.id || '').trim(),
          label: String(model?.name || model?.id || '').trim(),
          tag: String(model?.tag || 'LIVE API'),
          description: String(model?.description || `Returned by ${activeLiveProviderLabel}`),
        })).filter((model: LiveModelOption) => model.value);
        const voices = Array.isArray(voicePayload?.voices) ? voicePayload.voices : [];
        setLiveModelOptionsFromApi(previous => ({ ...previous, [providerValue]: normalizedModels }));
        setLiveVoiceOptionsFromApi(previous => ({ ...previous, [providerValue]: voices }));
        const catalogReady = modelResponse.ok && Boolean(modelPayload?.ok) && voiceResponse.ok && Boolean(voicePayload?.ok);
        setLiveCatalogStatus(catalogReady ? 'ready' : 'error');
        const keyState = activeLiveApiKey ? 'key configured' : 'add an API key to connect';
        const catalogError = String(modelPayload?.error || voicePayload?.error || '').trim();
        setLiveCatalogMessage(catalogReady
          ? `${normalizedModels.length} model${normalizedModels.length === 1 ? '' : 's'} and ${voices.length} voice${voices.length === 1 ? '' : 's'} available · ${keyState}`
          : catalogError || `${normalizedModels.length} model${normalizedModels.length === 1 ? '' : 's'} and ${voices.length} voice${voices.length === 1 ? '' : 's'} available · ${keyState}`);
      } catch {
        if (!cancelled) {
          setLiveCatalogStatus('error');
          setLiveCatalogMessage(`Could not load the ${activeLiveProviderLabel} catalog.`);
        }
      }
    }, activeLiveApiKey ? 180 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeLiveApiKey, activeLiveProviderLabel, activeLiveProviderValue, activeTab, isOpen, settings.liveConvoModel]);

  const activeLiveModelOptions = Array.from(new Map([
    ...getLiveModelOptions(activeLiveProvider.value),
    ...(liveModelOptionsFromApi[activeLiveProvider.value] || []),
    ...discoveredLiveModels.map(m => ({
      value: m.id,
      label: m.name || m.id,
      tag: 'LIVE API',
      description: m.description || 'Returned by the Agent Live API',
    })),
  ].map(option => [option.value, option] as const)).values());
  const activeLiveVoiceOptions = liveVoiceOptionsFromApi[activeLiveProvider.value]?.length
    ? liveVoiceOptionsFromApi[activeLiveProvider.value]
    : getLiveVoiceOptions(activeLiveProvider.value);

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'general', label: 'General', icon: 'general' },
    { id: 'profile', label: 'Profile', icon: 'profile' },
    { id: 'appearance', label: 'Appearance', icon: 'appearance' },
    { id: 'configuration', label: 'Configuration', icon: 'configuration' },
    { id: 'personalization', label: 'Personalization', icon: 'personalization' },
    { id: 'mcp', label: 'MCP servers', icon: 'mcp' },
    { id: 'tokens', label: 'Tokens', icon: 'tokens' },
    { id: 'context', label: 'Context', icon: 'context' },
    { id: 'models', label: 'Models', icon: 'models' },
    { id: 'api', label: 'API', icon: 'api' },
    { id: 'live-convo', label: 'Live Convo', icon: 'live-convo' },
    { id: 'git', label: 'Git', icon: 'git' },
    { id: 'environments', label: 'Environments', icon: 'environments' },
    { id: 'browser', label: 'External service', icon: 'browser' },
    { id: 'computer', label: 'Computer use', icon: 'computer' },
    { id: 'updates', label: 'Updates', icon: 'updates' },
  ];

  const providerKeyCount = (provider: string) => {
    const providerKeys = splitApiKeyPool(apiKeys[provider]);
    const modelKeys = modelEntries
      .filter(entry => entry.provider === provider)
      .flatMap(entry => splitApiKeyPool(modelApiKeys[modelEntryKey(entry.provider, entry.modelId)]));
    return Array.from(new Set([...providerKeys, ...modelKeys])).length;
  };
  const providerReady = (provider: string) => providerKeyCount(provider) > 0;
  const providerSync = (provider: string) => apiProviderStatus.find(status => status.provider === provider);
  const selectedModelOption = MAIN_AGENT_MODEL_OPTIONS.find(option => option.id === settings.agentMode) || MAIN_AGENT_MODEL_OPTIONS[0];
  const activeProvider = (selectedModelOption?.provider || 'gemini') as MainAgentProvider;
  const activeModelOverride = modelOverrides[activeProvider];

  useEffect(() => {
    if (isOpen) setSelectedConnectionProvider(activeProvider);
  }, [activeProvider, isOpen]);

  const getProviderModelOptions = useCallback((provider: string) => {
    const seen = new Set<string>();
    const options: ProviderModelOption[] = [];
    const push = (id: unknown, label: unknown, source: ProviderModelOption['source']) => {
      const modelId = String(id || '').trim();
      if (!isConcreteModelId(modelId) || seen.has(modelId)) return;
      seen.add(modelId);
      options.push({
        id: modelId,
        label: formatModelName(modelId),
        source,
      });
    };

    push(modelOverrides[provider], modelOverrides[provider], 'selected');
    modelCatalog[provider]?.forEach(modelId => push(modelId, modelId, 'saved'));
    modelDirectory[provider]?.models?.forEach(model => {
      push(model.id, model.name || model.id, 'live');
    });

    return options;
  }, [modelCatalog, modelDirectory, modelOverrides]);

  const selectedProviderDirectory = modelDirectory[selectedConnectionProvider];
  const selectedProviderModel = modelOverrides[selectedConnectionProvider] || '';
  const selectedProviderModelOptions = getProviderModelOptions(selectedConnectionProvider);
  const selectedProviderKeyCount = providerKeyCount(selectedConnectionProvider);
  const selectedProviderCanDiscover = isLocalModelProvider(selectedConnectionProvider) || selectedProviderKeyCount > 0;
  const selectedContextChat = contextChats.find(chat => chat.id === selectedContextChatId) || null;
  const selectedContextChatBudget = selectedContextChatId
    ? contextChatOverrides[selectedContextChatId] || 'global'
    : 'global';
  const contextChatMaximum = (chat: ContextChatSummary | null): number => {
    if (!chat) return 0;
    if (!chat.provider || !chat.modelId) return chat.modelMaximum;
    const liveModel = modelDirectory[chat.provider]?.models.find(model => model.id === chat.modelId);
    let discovered = normalizeContextWindow(liveModel?.inputTokenLimit || liveModel?.contextLength);
    if (!discovered) {
      try {
        discovered = normalizeContextWindow(JSON.parse(appStorage.getItem(MODEL_CONTEXT_WINDOWS_STORAGE_KEY) || '{}')?.[
          modelEntryKey(chat.provider, chat.modelId)
        ]);
      } catch { }
    }
    return discovered || chat.modelMaximum || resolveModelContextWindow(chat.provider, chat.modelId);
  };
  const selectedChatBudget = resolveContextWindowBudget(
    resolveSavedContextBudget(settings, selectedContextChatBudget), contextChatMaximum(selectedContextChat),
  );
  const effectiveSelectedChatWindow = selectedChatBudget.configuredContextWindow;
  const selectedChatLimitNote = contextWindowLimitNote(selectedChatBudget.requestedContextWindow, selectedChatBudget.modelContextWindow);
  const activeContextChat = contextChats.find(chat => chat.id === activeContextChatId) || null;
  const globalContextBudget = resolveContextWindowBudget(resolveSavedContextBudget(settings), contextChatMaximum(activeContextChat));
  const globalContextLimitNote = contextWindowLimitNote(globalContextBudget.requestedContextWindow, globalContextBudget.modelContextWindow);
  const selectedProviderStatusText = !selectedProviderCanDiscover
    ? `Add a ${ PROVIDER_LABEL[selectedConnectionProvider] || selectedConnectionProvider } API key to load models`
    : selectedProviderDirectory
    ? (selectedProviderDirectory.connected
      ? `${ selectedProviderDirectory.models.length } agent-compatible models${ selectedProviderDirectory.excludedCount ? ` · ${ selectedProviderDirectory.excludedCount } incompatible hidden` : '' }`
      : selectedProviderDirectory.error || 'Not connected')
    : 'Open Models to load live models';
  const selectedApiProvider = selectedApiProviderValue || activeProvider;
  const selectedApiProviderLabel = PROVIDER_LABEL[selectedApiProvider] || selectedApiProvider;
  const selectedApiProviderSync = providerSync(selectedApiProvider);
  const selectedApiProviderPoolValue = `provider:${selectedApiProvider}`;
  const selectedApiProviderModelEntries = modelEntries.filter(entry => entry.provider === selectedApiProvider);
  const tokenActivityDates = useMemo(() => buildTokenActivityDates(), [tokenStats.daily]);
  const tokenActivityMax = useMemo(
    () => Math.max(1, ...Object.values(tokenStats.daily)),
    [tokenStats.daily],
  );
  const apiPoolEntries = [
    {
      value: selectedApiProviderPoolValue,
      label: 'Provider pool',
      description: `Any ${selectedApiProviderLabel} model`,
      provider: selectedApiProvider,
      providerLabel: selectedApiProviderLabel,
      modelId: '',
      isProviderPool: true,
    },
    ...selectedApiProviderModelEntries.map(entry => ({
      value: modelEntryKey(entry.provider, entry.modelId),
      label: formatModelName(entry.modelId),
      description: 'Custom model pool',
      provider: entry.provider,
      providerLabel: selectedApiProviderLabel,
      modelId: entry.modelId,
      isProviderPool: false,
    })),
  ];
  const selectedApiPoolEntry =
    apiPoolEntries.find(entry => entry.value === selectedApiModelValue) ||
    apiPoolEntries[0];
  const selectedApiPoolValue = selectedApiPoolEntry?.isProviderPool
    ? apiKeys[selectedApiProvider] || ''
    : modelApiKeys[selectedApiPoolEntry?.value || ''] || '';

  useEffect(() => {
    if (!apiPoolEntries.some(entry => entry.value === selectedApiModelValue)) {
      setSelectedApiModelValue(selectedApiProviderPoolValue);
    }
  }, [apiPoolEntries, selectedApiProviderPoolValue, selectedApiModelValue]);

  useEffect(() => {
    setExactModelDraft(selectedProviderModel);
  }, [selectedConnectionProvider, selectedProviderModel]);

  const refreshModelDirectoryRef = useRef(refreshModelDirectory);
  refreshModelDirectoryRef.current = refreshModelDirectory;

  useEffect(() => {
    if (!isOpen || (activeTab !== 'models' && activeTab !== 'api')) return;
    const discoveryProvider = activeTab === 'api' ? selectedApiProvider : selectedConnectionProvider;
    if (activeTab === 'api' && !isLocalModelProvider(discoveryProvider) && providerKeyCount(discoveryProvider) === 0) return;
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async () => {
      if (cancelled || inFlight) return;
      if (timer) clearTimeout(timer);
      timer = null;
      inFlight = true;
      try {
        await appStorageReady;
        const deadline = Date.now() + 10_000;
        while (!cancelled && !runtimeSettingsHydratedRef.current && Date.now() < deadline) {
          await new Promise(resolve => window.setTimeout(resolve, 50));
        }
        if (cancelled) return;
        if (!runtimeSettingsHydratedRef.current) {
          setModelDirectoryStatus('error');
          return;
        }
        const currentEntries = modelEntriesRef.current;
        const currentKeys = composeApiKeysForSelections(
          apiKeysRef.current,
          modelApiKeysRef.current,
          currentEntries,
          [AUTO_MODEL_SELECTION, ...currentEntries.map(entry => modelEntryKey(entry.provider, entry.modelId))],
        );
        await refreshModelDirectoryRef.current(currentKeys, modelOverridesRef.current, [discoveryProvider]);
      } catch {
        if (!cancelled) setModelDirectoryStatus('error');
      } finally {
        inFlight = false;
        // Schedule after completion so slow providers cannot build a backlog.
        if (!cancelled) timer = setTimeout(() => { void refresh(); }, 30_000);
      }
    };
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    // Let a pasted/typed key settle before discovery. Do not switch tabs or
    // choose a model simply because credentials were entered.
    timer = setTimeout(() => { void refresh(); }, activeTab === 'api' ? 800 : 0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [activeTab, isOpen, selectedConnectionProvider, selectedApiProvider, apiKeys, modelApiKeys]);

  const saveModelEntries = useCallback((nextEntries: ModelSelectorEntry[]) => {
    const normalizedEntries = normalizeModelSelectorEntries(nextEntries, {});
    const nextCatalog = entriesToModelCatalog(normalizedEntries) as ModelCatalog;
    modelEntriesRef.current = normalizedEntries;
    setModelEntries(normalizedEntries);
    setModelCatalog(nextCatalog);
    appStorage.setItems({
      [MODEL_SELECTOR_STORAGE_KEY]: JSON.stringify(normalizedEntries),
      [MODEL_CATALOG_STORAGE_KEY]: JSON.stringify(nextCatalog),
    });
    broadcastEterxSettingsUpdate({
      type: 'model-selector-updated',
      modelEntries: normalizedEntries,
      modelCatalog: nextCatalog,
    });
    return normalizedEntries;
  }, []);

  const saveModelThinkingCapability = useCallback((provider: MainAgentProvider, modelId: string) => {
    const liveCapability = modelDirectory[provider]?.models.find(model => model.id === modelId)?.thinking;
    if (!liveCapability) return;
    const key = modelEntryKey(provider, modelId);
    setModelThinkingCapabilities(previous => {
      const next = { ...previous, [key]: liveCapability };
      appStorage.setItem(MODEL_THINKING_CAPABILITIES_STORAGE_KEY, JSON.stringify(next));
      broadcastEterxSettingsUpdate({
        type: 'model-thinking-capabilities-updated',
        thinkingCapabilities: next,
      });
      return next;
    });
  }, [modelDirectory]);

  const updateModelApiKey = useCallback((modelKey: string, value: string) => {
    if (!parseModelEntryKey(modelKey)) return;
    settingsRevisionRef.current += 1;
    const next = { ...modelApiKeysRef.current };
    const cleanValue = value.trim();
    if (cleanValue) next[modelKey] = cleanValue;
    else delete next[modelKey];
    modelApiKeysRef.current = next;
    setModelApiKeys(next);
    persistApiKeyPresence(apiKeysRef.current, next);
    void persistDesktopRuntimeSettings(apiKeysRef.current, next, modelOverridesRef.current);
    broadcastEterxSettingsUpdate({ type: 'model-api-keys-updated', modelKey });
    queueRuntimeSync({
      apiKeys: apiKeysRef.current,
      modelApiKeys: next,
      modelOverrides: modelOverridesRef.current,
      modelEntries,
    });
    setHasChanges(true);
    keysChangedRef.current = true;
  }, [modelEntries, persistApiKeyPresence, persistDesktopRuntimeSettings, queueRuntimeSync]);

  const selectCatalogModel = useCallback((provider: string, modelId: string, entriesSnapshot = modelEntriesRef.current) => {
    if (!isModelProvider(provider)) return;
    settingsRevisionRef.current += 1;
    const next = { ...modelOverridesRef.current };
    const effectiveProvider = modelId ? provider : undefined;
    const effectiveModelId = modelId || '';
    if (!modelId) delete next[provider];
    if (effectiveProvider && effectiveModelId) {
      next[effectiveProvider] = effectiveModelId;
    } else {
      delete next[provider];
    }
    modelOverridesRef.current = next;
    setModelOverrides(next);
    const chatModelSelection = effectiveProvider && effectiveModelId
      ? modelEntryKey(effectiveProvider, effectiveModelId)
      : AUTO_MODEL_SELECTION;
    setChatModelSelection(chatModelSelection);
    appStorage.setItems({
      [MODEL_OVERRIDE_STORAGE_KEY]: JSON.stringify(next),
      [CHAT_MODEL_SELECTION_STORAGE_KEY]: chatModelSelection,
    });
    void persistDesktopRuntimeSettings(apiKeysRef.current, modelApiKeysRef.current, next);
    broadcastEterxSettingsUpdate({
      type: 'model-overrides-updated',
      modelOverrides: next,
      chatModelSelection,
    });
    queueRuntimeSync({
      apiKeys: apiKeysRef.current,
      modelApiKeys: modelApiKeysRef.current,
      modelOverrides: next,
      modelEntries: entriesSnapshot,
    }, true);
    const nextMode = effectiveProvider ? PROVIDER_MODE[effectiveProvider] : undefined;
    if (nextMode) updateSetting('agentMode', nextMode);
    setHasChanges(true);
    keysChangedRef.current = true;
  }, [persistDesktopRuntimeSettings, queueRuntimeSync, updateSetting]);

  const addModelToSelector = useCallback((provider: string, modelId: string, activate = true) => {
    const cleanProvider = String(provider || '').trim();
    const cleanModelId = String(modelId || '').trim();
    if (!isModelProvider(cleanProvider) || !cleanModelId) return;

    const existingEntries = modelEntriesRef.current;
    const nextEntries = saveModelEntries(ensureModelSelectorEntry(existingEntries, cleanProvider, cleanModelId));
    saveModelThinkingCapability(cleanProvider, cleanModelId);
    if (activate) selectCatalogModel(cleanProvider, cleanModelId, nextEntries);
    setHasChanges(true);
    keysChangedRef.current = true;
  }, [saveModelEntries, saveModelThinkingCapability, selectCatalogModel]);

  const removeModelFromSelector = useCallback((provider: string, modelId: string) => {
    const cleanProvider = String(provider || '').trim();
    const cleanModelId = String(modelId || '').trim();
    if (!isModelProvider(cleanProvider) || !cleanModelId) return;

    const removedKey = modelEntryKey(cleanProvider, cleanModelId);
    const nextEntries = saveModelEntries(removeModelSelectorEntry(modelEntriesRef.current, cleanProvider, cleanModelId));
    setModelThinkingCapabilities(previous => {
      if (!(removedKey in previous)) return previous;
      const next = { ...previous };
      delete next[removedKey];
      appStorage.setItem(MODEL_THINKING_CAPABILITIES_STORAGE_KEY, JSON.stringify(next));
      broadcastEterxSettingsUpdate({ type: 'model-thinking-capabilities-updated', thinkingCapabilities: next });
      return next;
    });
    try {
      const storedLevels = JSON.parse(appStorage.getItem(MODEL_THINKING_LEVELS_STORAGE_KEY) || '{}');
      if (storedLevels && typeof storedLevels === 'object' && removedKey in storedLevels) {
        delete storedLevels[removedKey];
        appStorage.setItem(MODEL_THINKING_LEVELS_STORAGE_KEY, JSON.stringify(storedLevels));
      }
    } catch { }
    settingsRevisionRef.current += 1;
    const nextModelKeys = { ...modelApiKeysRef.current };
    delete nextModelKeys[removedKey];
    modelApiKeysRef.current = nextModelKeys;
    setModelApiKeys(nextModelKeys);
    persistApiKeyPresence(apiKeysRef.current, nextModelKeys);
    void persistDesktopRuntimeSettings(apiKeysRef.current, nextModelKeys, modelOverridesRef.current);
    const currentChatModelSelection = appStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) || AUTO_MODEL_SELECTION;
    const chatModelSelection = currentChatModelSelection === removedKey
      ? AUTO_MODEL_SELECTION
      : currentChatModelSelection;
    const removedActiveOverride = modelOverridesRef.current[cleanProvider] === cleanModelId;
    if (removedActiveOverride) {
      selectCatalogModel(cleanProvider, '', nextEntries);
      setExactModelDraft('');
    } else if (currentChatModelSelection === removedKey) {
      appStorage.setItem(CHAT_MODEL_SELECTION_STORAGE_KEY, chatModelSelection);
      setChatModelSelection(chatModelSelection);
    }
    queueRuntimeSync({
      apiKeys: apiKeysRef.current,
      modelApiKeys: nextModelKeys,
      modelOverrides: modelOverridesRef.current,
      modelEntries: nextEntries,
    }, true);
    broadcastEterxSettingsUpdate({
      type: 'model-selector-updated',
      modelEntries: nextEntries,
      modelCatalog: entriesToModelCatalog(nextEntries),
      chatModelSelection,
    });
    setHasChanges(true);
    keysChangedRef.current = true;
  }, [persistApiKeyPresence, persistDesktopRuntimeSettings, queueRuntimeSync, saveModelEntries, selectCatalogModel]);

  if ((!isOpen && !showBatmanEgg) || typeof document === 'undefined') return null;

  return createPortal(
    <>
      <style suppressHydrationWarning dangerouslySetInnerHTML={{ __html: lightweightSettingsHoverCss }} />
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="eterx-settings-panel fixed inset-0 z-[99999] flex items-center justify-center"
          >
            {/* Backdrop */}
            {!standalone && <div className="absolute inset-0 bg-black/40 backdrop-blur-[3px]" onClick={handleClose} />}

            {/* Panel */}
            <motion.div
              initial={{ opacity: 0, y: standalone ? 0 : 16, scale: standalone ? 1 : 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: standalone ? 0 : 10, scale: standalone ? 1 : 0.98 }}
              transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
              className={`eterx-settings-dialog ${ standalone ? 'h-screen w-screen rounded-none border-0' : 'h-[min(640px,calc(100vh-40px))] w-[min(900px,calc(100vw-40px))] rounded-[12px] border border-white/[0.08]' } relative overflow-hidden flex flex-col bg-[#151515] shadow-none`}
            >
              {/* Glass Background */}
              <div className="absolute inset-0 bg-[#151515]" />

              <div className="relative flex min-h-0 flex-1 flex-col sm:flex-row">

              {/* ─── Sidebar Tabs ─── */}
              <div className="relative z-10 w-full sm:w-[200px] shrink-0 overflow-hidden border-b border-white/[0.08] bg-[#1D1D1D] sm:border-b-0 sm:border-t flex flex-col">
                <div className="flex h-11 shrink-0 items-center px-2 border-b border-white/[0.05] pointer-events-auto [-webkit-app-region:no-drag]">
                  <button onClick={handleClose} className="eterx-settings-back-button flex w-full h-8 items-center gap-2.5 rounded-lg px-2.5 text-[#A7A7A7] transition-colors hover:bg-white/[0.05] hover:text-[#F1F1F1] pointer-events-auto [-webkit-app-region:no-drag]">
                    <span className="grid h-5 w-5 shrink-0 place-items-center">
                      <ChevronRight className="h-4 w-4 rotate-180" />
                    </span>
                    <span className="text-[13px] font-medium leading-none">Back to app</span>
                  </button>
                </div>
                <nav className="flex gap-1 overflow-x-auto px-2 pb-2 pt-1.5 sm:pt-2 sm:block sm:flex-1 sm:space-y-1 sm:overflow-y-auto sm:overflow-x-hidden sm:pb-2 eterx-scrollbar">
                  {tabs.map(tab => (
                    <button
                      key={tab.id}
                      data-active={activeTab === tab.id}
                      onClick={() => { setManualOpen(false); setActiveTab(tab.id); onTabChange?.(tab.id); }}
                      className={`eterx-settings-tab flex h-8 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] font-medium leading-none transition-colors sm:w-full ${ activeTab === tab.id
                        ? 'bg-[#313131] text-[#F5F5F5]'
                        : 'text-[#F0F0F0] hover:bg-white/[0.045]'
                        }`}
                    >
                      <span className="grid h-5 w-5 shrink-0 place-items-center text-current">
                        <SettingsIconAsset name={tab.icon} className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 truncate leading-5">{tab.label}</span>
                    </button>
                  ))}
                </nav>
              </div>

              {/* ─── Content ─── */}
              <div className="relative z-20 flex-1 flex flex-col min-w-0 overflow-hidden border-l border-t border-white/[0.08] bg-[#151515]">
                {/* Header */}
                <div className="h-11 shrink-0 border-b border-white/[0.075] bg-[#151515]" />

                {/* Scrollable Body */}
                <div className={`flex-1 eterx-scrollbar px-6 ${activeTab === 'tokens' ? 'overflow-hidden py-4' : `overflow-y-auto ${activeTab === 'profile' ? 'py-4' : 'py-8'}`}`}>
                  <div className={`mx-auto w-full ${manualOpen || activeTab === 'profile' || activeTab === 'tokens' ? 'max-w-[980px]' : 'max-w-[560px]'} pb-8`}>
                      <div className="mb-6 flex items-center justify-between gap-4">
                        <h3 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] text-[#F4F4F4]">
                          {manualOpen ? 'User manual' : tabs.find(t => t.id === activeTab)?.label}
                          {activeTab === 'models' && (
                            <span className="ml-2 text-[11px] font-normal tracking-normal text-[#8E8A84]">
                              (For fetching models, please add at least one API key for that provider.)
                            </span>
                          )}
                        </h3>
                        {activeTab === 'tokens' && <div className="flex items-center gap-3"><span className="text-[12px] text-[#999]">Show token count</span><Toggle enabled={settings.showTokenCount} onChange={value => updateSetting('showTokenCount', value)} /></div>}
                      </div>

                      {/* ═══ GENERAL TAB ═══ */}
                      {manualOpen && activeTab === 'general' && (
                        <div className="space-y-6">
                          <button type="button" onClick={() => setManualOpen(false)} className="inline-flex items-center gap-2 rounded-lg px-1 py-1 text-[12.5px] font-medium text-[#A7A7A7] transition-colors hover:text-[#F1F1F1]">
                            <ArrowLeft className="h-4 w-4" /> Back to General settings
                          </button>
                          <div className="rounded-2xl border border-white/[0.09] bg-gradient-to-br from-[#252525] to-[#1B1B1B] p-6 sm:p-8">
                            <div className="flex max-w-[690px] items-start gap-4">
                              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-[#3D9BFF]/25 bg-[#3D9BFF]/10 text-[#76B9FF]"><BookOpen className="h-5 w-5" /></span>
                              <div><div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[#76B9FF]">Getting started</div><h4 className="mt-2 text-[25px] font-semibold tracking-[-0.02em] text-[#F4F4F4]">Welcome to EterX-Agent</h4><p className="mt-2 text-[14px] leading-6 text-[#B3B3B3]">A practical guide to setting up your workspace, starting conversations, and turning ideas into finished work.</p></div>
                            </div>
                            <div className="mt-6 grid gap-3 sm:grid-cols-3">
                              {[['01', 'Start a chat', 'Describe what you want to accomplish in plain language.'], ['02', 'Add context', 'Attach files or choose a workspace when the task needs them.'], ['03', 'Review results', 'Follow progress, steer the work, and inspect what changed.']].map(([number, title, description]) => <div key={number} className="rounded-xl border border-white/[0.08] bg-black/10 p-4"><div className="text-[11px] font-semibold tracking-[0.12em] text-[#76B9FF]">{number}</div><div className="mt-2 text-[13px] font-semibold text-[#F1F1F1]">{title}</div><div className="mt-1.5 text-[12px] leading-5 text-[#999]">{description}</div></div>)}
                            </div>
                          </div>
                          <div className="grid gap-5 md:grid-cols-[220px_1fr]">
                            <div className="space-y-1 rounded-xl border border-white/[0.08] bg-[#202020] p-2">
                              <div className="px-3 pb-2 pt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#777]">Topics</div>
                              {[
                                ['model-selection', 'Model selection'],
                                ['first-chat', 'Your first chat'],
                                ['workspaces', 'Workspaces & files'],
                                ['agents', 'Agents & work modes'],
                                ['tasks', 'Scheduled tasks'],
                                ['live', 'Live Convo'],
                                ['settings-guide', 'Settings guide'],
                                ['troubleshooting', 'Troubleshooting'],
                              ].map(([id, topic]) => <button key={id} type="button" onClick={() => setManualTopic(id)} className={`w-full rounded-lg px-3 py-2 text-left text-[12.5px] font-medium transition-colors ${manualTopic === id ? 'bg-[#303030] text-[#F1F1F1]' : 'text-[#A7A7A7] hover:bg-white/[0.045] hover:text-[#F1F1F1]'}`}>{topic}</button>)}
                            </div>
                            <article className="rounded-xl border border-white/[0.08] bg-[#202020] p-5 sm:p-7">
                              <div className="flex items-center justify-between gap-4"><div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#777]">User manual · {manualTopic === 'model-selection' ? 'Settings' : 'Guide'}</div><span className="rounded-full border border-emerald-400/15 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-300">Preview</span></div>
                              {manualTopic === 'model-selection' ? <>
                                <h4 className="mt-4 text-[21px] font-semibold tracking-[-0.015em] text-[#F1F1F1]">Choose and add a chat model</h4>
                                <p className="mt-3 text-[14px] leading-6 text-[#B0B0B0]">EterX-Agent discovers models from the provider you configure. Add a key first, load that provider’s catalog, then save the models you want in the chat model selector.</p>
                                <div className="mt-7 space-y-5">
                                  {[['1', 'Open Settings → API', 'Go to the API section and add at least one API key for the provider you want to use. Keep the key local and use the provider row that matches your account.'], ['2', 'Select the model provider', 'Open Settings → Models and choose the same provider. Once a valid API key is available, EterX-Agent can request the provider’s current model list instead of relying on an outdated preset.'], ['3', 'Load and review models', 'Use the provider catalog to fetch available models. The list can include model IDs, context limits, capabilities, and thinking support returned by that provider.'], ['4', 'Add to your custom list', 'Choose Add for a model you want to use. It becomes part of your saved model list and can then be selected from the model control in the chat composer.']].map(([number, title, description]) => <div key={number} className="flex gap-3.5"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#303030] text-[11px] font-semibold text-[#BFDFFF]">{number}</span><div><div className="text-[13px] font-semibold text-[#F1F1F1]">{title}</div><p className="mt-1 text-[13px] leading-5 text-[#9F9F9F]">{description}</p></div></div>)}
                                </div>
                                <div className="mt-7 rounded-xl border border-[#3D9BFF]/15 bg-[#3D9BFF]/[0.06] px-4 py-3 text-[12px] leading-5 text-[#AFCDF0]">Tip: if no models appear, check that the API key is valid, the provider is selected in both sections, and the provider endpoint is reachable.</div>
                              </> : (() => {
                                const guide = MANUAL_GUIDES[manualTopic] || MANUAL_GUIDES['first-chat'];
                                return <>
                                  <h4 className="mt-4 text-[21px] font-semibold tracking-[-0.015em] text-[#F1F1F1]">{guide.title}</h4>
                                  <p className="mt-3 text-[14px] leading-6 text-[#B0B0B0]">{guide.intro}</p>
                                  <div className="mt-7 space-y-5">{guide.steps.map(([title, description], index) => <div key={title} className="flex gap-3.5"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#303030] text-[11px] font-semibold text-[#BFDFFF]">{index + 1}</span><div><div className="text-[13px] font-semibold text-[#F1F1F1]">{title}</div><p className="mt-1 text-[13px] leading-5 text-[#9F9F9F]">{description}</p></div></div>)}</div>
                                  <div className="mt-7 rounded-xl border border-[#3D9BFF]/15 bg-[#3D9BFF]/[0.06] px-4 py-3 text-[12px] leading-5 text-[#AFCDF0]">{guide.tip}</div>
                                </>;
                              })()}
                            </article>
                          </div>
                        </div>
                      )}

                      {activeTab === 'general' && !manualOpen && (
                        <div>
                          <SectionHeader title="Work mode" />
                          <p className="-mt-2 mb-5 text-[14px] text-[#A5A5A5]">Choose how EterX-Agent should shape responses for your work.</p>
                          <div className="mb-12 grid gap-4 md:grid-cols-2">
                            {[
                              { id: 'everyday' as const, title: 'General', description: 'Direct user-to-agent workflows for planning, writing, and routine tasks.', icon: 'everyday' },
                              { id: 'specialist' as const, title: 'Autonomous', description: 'Proxy-agent takes responsibility and collaborates with the main agent to complete goals autonomously on your behalf.', icon: 'specialist' },
                            ].map(mode => {
                              const selected = settings.workMode === mode.id;
                              return (
                                <button
                                  key={mode.id}
                                  type="button"
                                  onClick={() => updateSetting('workMode', mode.id)}
                                  className={`flex min-h-[82px] items-center justify-between gap-5 rounded-lg border px-5 py-4 text-left transition-colors ${
                                    selected ? 'border-white/[0.12] bg-[#2B2B2B]' : 'border-white/[0.08] bg-[#171717] hover:bg-[#202020]'
                                  }`}
                                >
                                  <div className="flex min-w-0 items-center gap-5">
                                    <span className="grid h-6 w-6 shrink-0 place-items-center text-[#D7D7D7]">
                                      <SettingsIconAsset name={mode.icon} className="h-5 w-5" />
                                    </span>
                                    <div className="min-w-0">
                                      <div className="text-[14.5px] font-semibold text-[#F1F1F1]">{mode.title}</div>
                                      <div className="mt-1.5 text-[14px] leading-relaxed text-[#A5A5A5]">{mode.description}</div>
                                    </div>
                                  </div>
                                  <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${
                                    selected ? 'border-[#3D9BFF] bg-[#3D9BFF]' : 'border-white/[0.16]'
                                  }`}>
                                    {selected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                                  </span>
                                </button>
                              );
                            })}
                          </div>

                          <SectionHeader title="Permissions" />
                          <SettingsStack>
                            <SettingsStackRow title="Default permissions" description="By default, EterX can read and edit files in its workspace. It can ask for additional access when needed." tall>
                              <div className="flex items-center gap-3">
                                <span className="eterx-settings-coming-soon text-[12.5px] font-medium text-white/40 select-none">Coming Soon...</span>
                                <Toggle enabled={defaultPermsActive} onChange={handleToggleDefaultPerms} />
                              </div>
                            </SettingsStackRow>
                            <SettingsStackRow title="Full access" description="When EterX runs with full access, it can edit any file on your computer and run commands with network access." tall>
                              <div className="flex items-center gap-3">
                                <span className="eterx-settings-coming-soon text-[12.5px] font-medium text-white/40 select-none">Coming Soon...</span>
                                <Toggle enabled={fullAccessActive} onChange={handleToggleFullAccess} />
                              </div>
                            </SettingsStackRow>
                          </SettingsStack>

                          <SectionHeader title="General" />
                          <SettingsStack>
                            <SettingsStackRow title="Continue active chats in background" description="Normal chat runs keep working when the EterX window is closed or hidden." tall>
                              <div className="flex items-center gap-3">
                                <span className={`text-[11px] font-semibold ${gatewayRunning ? 'text-emerald-400' : 'text-white/35'}`}>{gatewayRunning ? 'Running' : 'Off'}</span>
                                <Toggle enabled={Boolean(gatewayConfig?.enabled && gatewayConfig?.keepActiveChatsOnClose !== false)} onChange={value => saveBackgroundMode('chats', value)} />
                              </div>
                            </SettingsStackRow>
                            <SettingsStackRow title="Run scheduled chats in background" description="Wake due tasks, create or continue their full chats, and record every run while the window is hidden." tall>
                              <Toggle enabled={Boolean(gatewayConfig?.enabled && gatewayConfig?.runScheduledTasksInBackground !== false)} onChange={value => saveBackgroundMode('schedules', value)} />
                            </SettingsStackRow>
                            <SettingsStackRow title="Start background companion at sign-in" description="Resume enabled background chats, channels, and due schedules automatically on Windows, macOS, or Linux.">
                              <Toggle enabled={Boolean(gatewayConfig?.launchAtLogin)} onChange={value => void saveGatewayPatch({
                                launchAtLogin: value,
                                ...(value && !gatewayConfig?.enabled ? {
                                  enabled: true,
                                  keepRunningOnClose: true,
                                  keepActiveChatsOnClose: true,
                                  runScheduledTasksInBackground: true,
                                } : {}),
                              })} />
                            </SettingsStackRow>
                            <SettingsStackRow title="Default open destination" description="Where files and folders open by default">
                              <SelectControl
                                value={settings.openDestination}
                                onChange={(value) => updateSetting('openDestination', value as AppSettings['openDestination'])}
                                options={[
                                  { value: 'eterx', label: 'EterX-Agent' },
                                  { value: 'workspace', label: 'Workspace' },
                                  { value: 'last', label: 'Last used' },
                                ]}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Integrated terminal shell" description="Smart automatically selects the best available shell for this operating system.">
                              <SelectControl
                                value={settings.terminalShell}
                                onChange={(value) => updateSetting('terminalShell', value as AppSettings['terminalShell'])}
                                options={terminalShellOptions}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow
                              title="Self-improvement"
                              description="Learn a durable model of how you work, plus reusable strategies, failure boundaries, tool affordances, and procedures from completed experience. Turning this off pauses both learning and learned guidance without deleting anything."
                              info="A restricted reflection model reviews observable task trajectories after a run. Learned policies are scoped, reversible guidance: they cannot rewrite EterX's core prompt, safety rules, permissions, or tools. Re-enable this later to continue from the same accumulated experience."
                            >
                              <div className="flex items-center gap-3">
                                <span className={`text-[11px] font-semibold ${settings.selfImprovementEnabled ? 'text-emerald-400' : 'text-white/35'}`}>
                                  {settings.selfImprovementEnabled ? 'Learning' : 'Paused'}
                                </span>
                                <Toggle
                                  enabled={settings.selfImprovementEnabled}
                                  onChange={value => updateSetting('selfImprovementEnabled', value)}
                                />
                              </div>
                            </SettingsStackRow>
                            <SettingsStackRow
                              title="Synapse Graph"
                              description="Optional local graph memory for topic continuity, tool evidence, and verified file changes. Existing context and memory systems continue to work when this is off."
                              info="Synapse Graph is off by default. Turn it on only if you want EterX to add its local graph-based context routing to agent runs."
                            >
                              <div className="flex items-center gap-3">
                                <span className={`text-[11px] font-semibold ${settings.synapseGraphEnabled ? 'text-emerald-400' : 'text-white/35'}`}>
                                  {settings.synapseGraphEnabled ? 'On' : 'Off'}
                                </span>
                                <Toggle enabled={settings.synapseGraphEnabled} onChange={value => updateSetting('synapseGraphEnabled', value)} />
                              </div>
                            </SettingsStackRow>

                            <SettingsStackRow title="Follow-up behavior" description="Queue follow-ups while EterX runs or steer the current run.">
                              <SegmentedControl
                                value={settings.followUpBehavior}
                                onChange={(value) => updateSetting('followUpBehavior', value)}
                                options={[
                                  { value: 'steer', label: 'Steer (default)' },
                                  { value: 'queue', label: 'Queue' },
                                ]}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Code review" description="Start review in the current chat when possible or launch a separate review chat.">
                              <SegmentedControl
                                value={settings.codeReviewMode}
                                onChange={(value) => updateSetting('codeReviewMode', value)}
                                options={[
                                  { value: 'inline', label: 'Inline' },
                                  { value: 'detached', label: 'Detached' },
                                ]}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Open source licenses" description="Third-party notices for bundled dependencies">
                              <SoftButton
                                onClick={() => {
                                  const url = 'https://github.com/harshilsoni5666/EterX-Agent/blob/main/LICENSE';
                                  if ((window as any).electronAPI?.openExternal) (window as any).electronAPI.openExternal(url);
                                  else window.open(url, '_blank', 'noopener,noreferrer');
                                }}
                              >
                                View
                              </SoftButton>
                            </SettingsStackRow>
                            <SettingsStackRow title="User manual" description="Learn how to use EterX-Agent, explore the workspace, and get the most from every feature.">
                              <SoftButton onClick={() => setManualOpen(true)}>Open manual</SoftButton>
                            </SettingsStackRow>
                          </SettingsStack>



                          <SectionHeader title="Notifications" />
                          <SettingsStack>
                            <SettingsStackRow title="Turn completion notifications" description="Get notified when long-running agent work completes.">
                              <SelectControl
                                value={settings.completionNotifications}
                                onChange={(value) => updateSetting('completionNotifications', value as AppSettings['completionNotifications'])}
                                options={[
                                  { value: 'always', label: 'Always' },
                                  { value: 'important', label: 'Important only' },
                                  { value: 'never', label: 'Never' },
                                ]}
                              />
                            </SettingsStackRow>
                          </SettingsStack>
                        </div>
                      )}

                      {activeTab === 'appearance' && (
                        <div>
                          <SectionHeader title="Appearance" />
                          <SettingsStack>
                            <SettingsStackRow title="Theme" description="Choose a theme or follow your system appearance" tall>
                              <ThemePreviewSelector
                                value={settings.theme}
                                onChange={(value) => updateSetting('theme', value)}
                              />
                            </SettingsStackRow>

                            <SettingsStackRow title="UI density" description="Adjust spacing and base text rhythm">
                              <SelectControl
                                value={settings.fontSize}
                                onChange={(value) => updateSetting('fontSize', value as AppSettings['fontSize'])}
                                options={[
                                  { value: 'compact', label: 'Compact' },
                                  { value: 'default', label: 'Default' },
                                  { value: 'comfortable', label: 'Comfortable' },
                                ]}
                              />
                            </SettingsStackRow>

                            <SettingsStackRow title="UI font size" description="Adjust the base size used for the EterX UI">
                              <span className="inline-flex h-9 items-center gap-2 rounded-xl border border-white/[0.08] bg-[#2D2D2D] px-4 text-[13px] font-medium text-[#F2F2F2]">
                                {settings.fontSize === 'compact' ? '13' : settings.fontSize === 'comfortable' ? '15' : '14'} <span className="text-[#A7A7A7]">px</span>
                              </span>
                            </SettingsStackRow>

                          </SettingsStack>
                        </div>
                      )}

                      {/* ═══ AGENT TAB ═══ */}
                      {activeTab === 'context' && (
                        <div>
                          <SectionHeader
                            title="Context compaction"
                            badge={settings.contextCompactionEnabled ? 'Active' : 'Off'}
                            info="Compaction runs only at a safe iteration boundary, creates a continuation capsule with the selected model, and resumes the same chat run automatically."
                          />
                          <SettingsStack>
                            <SettingsStackRow
                              title="Automatic compaction"
                              description="Compact a chat before its active model reaches the critical part of its context window. When disabled, history remains uncompressed until the provider limit is reached."
                            >
                              <Toggle enabled={settings.contextCompactionEnabled} onChange={value => updateSetting('contextCompactionEnabled', value)} />
                            </SettingsStackRow>
                            <SettingsStackRow
                              title="Context window size"
                              description={globalContextLimitNote
                                ? `Current chat: ${globalContextLimitNote}.`
                                : "Sets the working context budget used by the live counter and compaction thresholds. It never exceeds the selected model's actual limit."}
                              info="Untouched settings follow the active model's full supported window. Choose a smaller fixed budget only when you intentionally want a per-request context cap."
                            >
                              <ModernSelect
                                value={settings.contextWindowSizeSelection}
                                onChange={value => updateSetting('contextWindowSizeSelection', value)}
                                className="w-[360px]"
                                options={CONTEXT_WINDOW_SIZE_OPTIONS}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow
                              title="Compaction model"
                              description="Used only to create the continuation capsule. Auto follows the model selected for the active chat run."
                              info="The compaction request uses the API pool already configured for the chosen provider."
                            >
                              <ModernSelect
                                value={settings.contextCompactionModelSelection}
                                onChange={updateContextCompactionModelSelection}
                                className="w-[360px]"
                                options={[
                                  {
                                    value: AUTO_MODEL_SELECTION,
                                    label: 'Auto (active chat model)',
                                    description: 'Uses the model running the current chat unless you explicitly choose another.',
                                  },
                                  ...modelEntries.map(entry => ({
                                    value: modelEntryKey(entry.provider, entry.modelId),
                                    label: formatModelName(entry.modelId),
                                    description: PROVIDER_LABEL[entry.provider] || entry.provider,
                                  })),
                                ]}
                              />
                            </SettingsStackRow>
                          </SettingsStack>

                          <SectionHeader
                            title="Custom instructions"
                            info="These supplement the built-in loss-aware state-transfer prompt without replacing its continuity requirements."
                          />
                          <div className="rounded-xl border border-white/[0.09] bg-[#202020] p-4">
                            <textarea
                              value={settings.contextCompactionInstructions}
                              onChange={event => updateSetting('contextCompactionInstructions', event.target.value.slice(0, 12000))}
                              placeholder="Add details the context compactor should preserve or emphasize..."
                              rows={10}
                              className="min-h-[210px] w-full resize-y rounded-xl border border-white/[0.08] bg-[#141414] px-4 py-3 text-[13px] leading-6 text-[#F1F1F1] outline-none transition-colors placeholder:text-[#666] focus:border-white/[0.20]"
                            />
                            <div className="mt-2 flex items-center justify-between text-[11px] text-[#777]">
                              <span>Applied to every model-generated capsule.</span>
                              <span>{settings.contextCompactionInstructions.length.toLocaleString()} / 12,000</span>
                            </div>
                          </div>

                          <SectionHeader
                            title="Per-chat context"
                            info="Overrides are stored by exact chat ID. Selecting a larger budget here never changes any other chat."
                          />
                          <div className="rounded-xl border border-white/[0.09] bg-[#202020] p-4">
                            {contextChats.length > 0 ? (
                              <div className="space-y-4">
                                <div>
                                  <div className="mb-2 text-[11.5px] font-medium text-[#9B9B9B]">Chat</div>
                                  <ModernSelect
                                    value={selectedContextChatId}
                                    onChange={setSelectedContextChatId}
                                    className="w-full"
                                    placeholder={contextChatsLoading ? 'Loading chats…' : 'Select a chat'}
                                    options={contextChats.map(chat => ({
                                      value: chat.id,
                                      label: chat.title,
                                      description: `${compactTokenLabel(chat.usedTokens)} used${chat.id === activeContextChatId ? ' · Current chat' : ''}`,
                                    }))}
                                  />
                                </div>
                                <div>
                                  <div className="mb-2 text-[11.5px] font-medium text-[#9B9B9B]">Context budget for this chat</div>
                                  <ModernSelect
                                    value={selectedContextChatBudget}
                                    onChange={updateContextChatOverride}
                                    className="w-full"
                                    options={[
                                      {
                                        value: 'global',
                                        label: `Use global default · ${CONTEXT_WINDOW_SIZE_OPTIONS.find(option => option.value === settings.contextWindowSizeSelection)?.label || 'Model maximum · Default'}`,
                                        description: 'Automatically follows the global Context window size setting',
                                      },
                                      ...CONTEXT_WINDOW_SIZE_OPTIONS,
                                    ]}
                                  />
                                </div>
                                {selectedContextChat && (
                                  <div className="grid grid-cols-2 gap-2">
                                    <div className="rounded-xl border border-white/[0.07] bg-[#171717] px-3 py-2.5">
                                      <div className="text-[10.5px] font-medium tracking-[0.08em] text-[#707070]">Current usage</div>
                                      <div className="mt-1 text-[14px] font-medium text-[#EAEAEA]">{compactTokenLabel(selectedContextChat.usedTokens)}</div>
                                    </div>
                                    <div className="rounded-xl border border-white/[0.07] bg-[#171717] px-3 py-2.5">
                                      <div className="text-[10.5px] font-medium tracking-[0.08em] text-[#707070]">Effective budget</div>
                                      <div className="mt-1 text-[14px] font-medium text-[#EAEAEA]">
                                        {effectiveSelectedChatWindow > 0
                                          ? `${formatExactContextTokens(effectiveSelectedChatWindow)} tokens`
                                          : 'Model limit not available yet'}
                                      </div>
                                    </div>
                                  </div>
                                )}
                                <p className="text-[11.5px] leading-5 text-[#777]">
                                  {selectedChatLimitNote ? `${selectedChatLimitNote}. ` : ''}
                                  Applies at the next safe request boundary for this chat, including an active run.
                                </p>
                              </div>
                            ) : (
                              <div className="flex min-h-[96px] items-center justify-center text-center text-[12.5px] text-[#777]">
                                {contextChatsLoading ? 'Loading chats…' : 'Start a chat to configure its individual context budget.'}
                              </div>
                            )}
                          </div>

                          <SectionHeader title="Runtime behavior" />
                          <SettingsStack>
                            <SettingsStackRow title="Adaptive protection" description="Compaction normally uses the low-to-mid 90% range of the selected chat window. It starts earlier only when measured model or tool growth predicts the very next cycle would cross the 96% safety boundary." />
                            <SettingsStackRow title="Adaptive retention" description="Information-dense work keeps a larger verbatim tail. Exact references, constraints, failures, tool continuity, and next actions are preserved in the capsule." />
                            <SettingsStackRow title="Per-chat isolation" description="Capsules, locks, counters, and retry state are keyed by the exact chat ID." />
                            <SettingsStackRow title="Safe boundary" description="Compaction starts between model iterations, never during a tool call, file edit, stream, or approval." />
                            <SettingsStackRow title="Automatic resume" description="The same active run continues immediately with its capsule and recent protocol-safe tail." />
                          </SettingsStack>
                        </div>
                      )}

                      {(activeTab === 'profile' || activeTab === 'tokens') && (
                        <div>
                          {activeTab === 'profile' && <div className="flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-[#1A1A1A]/95 px-4 py-2.5">
                            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/[0.12] bg-[#1D1D1D] text-base font-semibold text-[#F1F1F1]">{settings.userName?.charAt(0).toUpperCase() || 'U'}</div>
                            <input aria-label="Profile name" value={settings.userName || ''} onChange={e => updateSetting('userName', e.target.value)} className="min-w-0 flex-1 border-b border-white/[0.10] bg-transparent pb-0.5 text-[16px] font-semibold text-[#F1F1F1] outline-none focus:border-white/[0.25]" />
                          </div>}
                          {activeTab === 'profile' ? <>
                          <div className="mb-2 mt-5"><h4 className="text-[17px] font-semibold tracking-[-0.02em] text-[#F1F1F1]">Token activity</h4></div>
                          <div className="relative z-20 overflow-visible rounded-2xl border border-white/[0.08] bg-[#171717] p-3" aria-busy={tokenStatsLoading}>
                            <div className="relative z-20 grid w-full grid-flow-col grid-rows-5 grid-cols-[repeat(40,minmax(0,1fr))] gap-x-px gap-y-px" onMouseLeave={() => setHoveredToken(null)}>
                              {tokenActivityDates.map(date => {
                                const key = dayKey(date.getTime());
                                const value = tokenStats.daily[key] || 0;
                                const intensity = value <= 0 ? 0 : Math.max(1, Math.ceil((value / tokenActivityMax) * 4));
                                return (
                                  <span
                                    key={key}
                                    aria-label={`${formatTokenMetric(value)} tokens on ${date.toLocaleDateString()}`}
                                    onMouseEnter={event => setHoveredToken({ value, date: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), cellKey: key, x: event.clientX, y: event.clientY })}
                                    className={`eterx-token-activity-cell eterx-token-activity-cell-${intensity}${hoveredToken?.cellKey === key ? ' is-hovered' : ''} h-3.5 w-3.5 justify-self-center rounded-[3px]`}
                                  />
                                );
                              })}
                            </div>
                            <div className="mt-3 grid w-full grid-cols-7 text-[11px] text-[#858585]">
                              {Array.from({ length: 7 }, (_, index) => {
                                const month = new Date(tokenActivityDates[0]);
                                month.setMonth(tokenActivityDates[0].getMonth() + index);
                                return <span key={`${month.getFullYear()}-${month.getMonth()}`}>{month.toLocaleString(undefined, { month: 'short' })}</span>;
                              })}
                            </div>
                          </div>
                          {hoveredToken && (
                            <div className="pointer-events-none fixed z-[10000] w-max max-w-[220px] whitespace-nowrap rounded-xl border border-white/[0.12] bg-[#292929] px-2.5 py-2 text-[12px] text-[#F1F1F1] shadow-none" style={{ left: Math.min(Math.max(8, hoveredToken.x + 10), window.innerWidth - 240), top: Math.max(8, hoveredToken.y - 48) }}>
                              {hoveredToken.model ? <div className="space-y-1">
                                <div className="flex justify-between gap-6"><span className="text-[#999]">Processed</span><span className="font-semibold">{formatTokenMetric(hoveredToken.value)}</span></div>
                                {hoveredToken.scope !== 'action' && <div className="flex justify-between gap-6"><span className="text-[#999]">Recent run</span><span className="font-semibold">{formatTokenMetric(hoveredToken.recentRunUsage || 0)}</span></div>}
                                <div className="flex justify-between gap-6"><span className="text-[#999]">Input</span><span className="font-semibold">{formatTokenMetric(hoveredToken.promptTokens || 0)}</span></div>
                                <div className="flex justify-between gap-6"><span className="text-[#999]">Uncached input</span><span className="font-semibold">{formatTokenMetric(hoveredToken.uncachedPromptTokens || 0)}</span></div>
                                <div className="flex justify-between gap-6"><span className="text-[#999]">Cached input</span><span className="font-semibold">{formatTokenMetric(hoveredToken.cachedTokens || 0)}</span></div>
                                <div className="flex justify-between gap-6"><span className="text-[#999]">Output</span><span className="font-semibold">{formatTokenMetric(hoveredToken.outputTokens || 0)}</span></div>
                                <div className="flex justify-between gap-6"><span className="text-[#999]">Model</span><span className="max-w-[120px] truncate font-semibold">{hoveredToken.model}</span></div>
                              </div> : `${formatTokenMetric(hoveredToken.value)} processed tokens on ${hoveredToken.date}`}
                            </div>
                          )}
                          </> : (() => {
                              const selected = tokenChats.find(chat => chat.id === selectedTokenChatId) || tokenChats[0];
                              const hoverChat = (
                                event: React.MouseEvent,
                                value: number,
                                recentRunUsage: number,
                                model: string,
                                date: string,
                                details: {
                                  scope: 'chat' | 'action';
                                  promptTokens: number;
                                  cachedTokens: number;
                                  uncachedPromptTokens: number;
                                  outputTokens: number;
                                },
                              ) => setHoveredToken({
                                value,
                                recentRunUsage,
                                model,
                                date,
                                ...details,
                                x: event.clientX,
                                y: event.clientY,
                              });
                              return <div className="mt-4 flex h-[calc(100vh-230px)] min-h-[340px] flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#171717]">
                                <div className="flex min-h-0 flex-1 flex-col border-b border-white/[0.08] p-2">
                                  <div className="px-3 py-2 text-[11px] font-medium tracking-[0.02em] text-[#777]">All chats</div>
                                  <div className="min-h-0 flex-1 overflow-y-auto eterx-scrollbar pr-1">
                                    {tokenChats.length > 0 ? tokenChats.map(chat => (
                                      <button key={chat.id} type="button" onClick={event => { setSelectedTokenChatId(chat.id); hoverChat(event, chat.totalTokens, chat.recentRunUsage, chat.model, new Date(chat.updatedAt || Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), { scope: 'chat', promptTokens: chat.promptTokens, cachedTokens: chat.cachedTokens, uncachedPromptTokens: chat.uncachedPromptTokens, outputTokens: chat.outputTokens }); }} onMouseEnter={event => hoverChat(event, chat.totalTokens, chat.recentRunUsage, chat.model, new Date(chat.updatedAt || Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), { scope: 'chat', promptTokens: chat.promptTokens, cachedTokens: chat.cachedTokens, uncachedPromptTokens: chat.uncachedPromptTokens, outputTokens: chat.outputTokens })} onMouseLeave={() => setHoveredToken(null)} className={`mb-1 flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${selectedTokenChatId === chat.id ? 'bg-white/[0.10]' : 'hover:bg-white/[0.055]'}`}>
                                        <span className="min-w-0 truncate text-[13px] text-[#E8E8E8]">{chat.title}</span>
                                        {settings.showTokenCount && <span className="shrink-0 inline-flex items-center gap-2 text-[11px] text-[#888]" title="Provider-reported input and output tokens"><span>Input {formatTokenMetric(chat.promptTokens)}</span><span className="text-[#555]" aria-hidden="true">|</span><span>Output {formatTokenMetric(chat.outputTokens)}</span></span>}
                                      </button>
                                    )) : <div className="px-3 py-8 text-center text-[13px] text-[#777]">No saved chats yet.</div>}
                                  </div>
                                </div>
                                <div className="flex min-h-0 flex-1 flex-col p-2">
                                  <div className="flex items-center justify-between px-3 py-2"><span className="text-[11px] font-medium tracking-[0.02em] text-[#777]">Action usage</span><span className="max-w-[55%] truncate text-[12px] text-[#888]">{selected?.title || 'Choose a chat'}</span></div>
                                  <div className="min-h-0 flex-1 overflow-y-auto eterx-scrollbar pr-1">
                                    {selected?.actions?.length ? selected.actions.slice().reverse().map(action => (
                                      <button key={action.id} type="button" onClick={event => hoverChat(event, action.tokens, action.tokens, action.model, action.label, { scope: 'action', promptTokens: action.promptTokens, cachedTokens: action.cachedTokens, uncachedPromptTokens: action.uncachedPromptTokens, outputTokens: action.outputTokens })} onMouseEnter={event => hoverChat(event, action.tokens, action.tokens, action.model, action.label, { scope: 'action', promptTokens: action.promptTokens, cachedTokens: action.cachedTokens, uncachedPromptTokens: action.uncachedPromptTokens, outputTokens: action.outputTokens })} onMouseLeave={() => setHoveredToken(null)} className="mb-1 flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-white/[0.055]">
                                        <span className="min-w-0 truncate"><span className="mr-2 normal-case text-[10px] tracking-[0.04em] text-[#666]">{action.kind.charAt(0).toUpperCase() + action.kind.slice(1).toLowerCase()}</span><span className="text-[13px] text-[#D8D8D8]">{action.label}</span></span>
                                        {settings.showTokenCount && <span className="shrink-0 inline-flex items-center gap-2 text-[11px] text-[#888]" title="Provider-reported input and output tokens"><span>Input {formatTokenMetric(action.promptTokens)}</span><span className="text-[#555]" aria-hidden="true">|</span><span>Output {formatTokenMetric(action.outputTokens)}</span></span>}
                                      </button>
                                    )) : <div className="px-3 py-8 text-center text-[13px] text-[#777]">No recorded actions for this chat.</div>}
                                  </div>
                                </div>
                              </div>;
                            })()}
                        </div>
                      )}

                      {activeTab === 'configuration' && (
                        <div>


                          <SectionHeader title="Runtime checks" />
                          <SettingsStack>
                            <SettingsStackRow title="Critic verification" description="Run a verification pass before delivery for higher-risk work.">
                              <Toggle enabled={settings.criticEnabled} onChange={v => updateSetting('criticEnabled', v)} />
                            </SettingsStackRow>
                            <SettingsStackRow title="Stream responses" description="Show agent output as it is generated.">
                              <Toggle enabled={settings.streamResponses} onChange={v => updateSetting('streamResponses', v)} />
                            </SettingsStackRow>
                            <SettingsStackRow title="Grounding search" description="Allow current web search when the task needs up-to-date facts.">
                            <Toggle enabled={settings.groundingSearch} onChange={v => { updateSetting('groundingSearch', v); updateSearchSettings(current => ({ ...current, enabled: v })); }} />
                            </SettingsStackRow>
                          </SettingsStack>

                          <SectionHeader title="Sub-agents" />
                          <SettingsStack>
                            <SettingsStackRow title="Auto sub-agent spawning" description="Allow EterX to run parallel helper agents when a task benefits from it.">
                              <Toggle enabled={settings.autoSubAgents} onChange={v => updateSetting('autoSubAgents', v)} />
                            </SettingsStackRow>
                            <SettingsStackRow title="Concurrent sub-agents" description="Requested helper count per parallel spawn; available resources remain the practical constraint.">
                              <div className="flex w-[240px] items-center gap-3">
                                <input
                                  type="number"
                                  min={1}
                                  max={20}
                                  step={1}
                                  value={settings.maxSubAgents}
                                  aria-label="Concurrent sub-agents"
                                  onChange={event => {
                                    const next = Number(event.target.value);
                                    if (Number.isFinite(next) && next >= 1) {
                                      updateSetting('maxSubAgents', Math.min(20, Math.floor(next)));
                                    }
                                  }}
                                  className="w-24 rounded-md border border-white/10 bg-white/[0.06] px-2 py-1.5 text-right text-[13px] font-mono text-[#DCD8D2] outline-none focus:border-white/25"
                                />
                                <span className="text-[12px] text-[#8E8A84]">agents</span>
                              </div>
                            </SettingsStackRow>
                          </SettingsStack>


                        </div>
                      )}

                      {/* ═══ API KEYS TAB ═══ */}
                      {activeTab === 'models' && (
                        <div>
                          <SectionHeader
                            title="Model connection"
                            badge={apiSyncStatus === 'synced' ? 'Live' : undefined}
                            info="Models saved here become the exact choices shown in the chat model selector. API keys are configured separately in the API tab."
                          />
                          <SettingsStack>
                            <SettingsStackRow title="Provider" description="Browse a provider and choose the exact model used by the main agent.">
                              <ProviderSelect
                                value={selectedConnectionProvider}
                                onChange={(value) => {
                                  if (!isModelProvider(value)) return;
                                  setSelectedConnectionProvider(value);
                                  const nextMode = PROVIDER_MODE[value];
                                  if (nextMode) updateSetting('agentMode', nextMode);
                                }}
                                className="w-[240px]"
                                providers={MODEL_PROVIDER_ORDER}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow
                              title="Model"
                              description={selectedProviderModel
                                ? modelEntryKey(selectedConnectionProvider, selectedProviderModel) === chatModelSelection
                                  ? 'Exact model active for the next run.'
                                  : 'Saved model for this provider. Select it to make it active.'
                                : selectedProviderCanDiscover
                                  ? 'Choose a real model returned by the provider.'
                                  : 'Add an API key first; no default or placeholder model is selected.'}
                              info="The list is built from the provider API and hides embeddings, speech, image, expired, and non-agent models."
                            >
                              <ModernSelect
                                value={selectedProviderModel}
                                onChange={(modelId) => {
                                  setExactModelDraft(modelId);
                                  if (modelId) {
                                    addModelToSelector(selectedConnectionProvider, modelId, true);
                                  } else {
                                    selectCatalogModel(selectedConnectionProvider, '');
                                  }
                                }}
                                placeholder={selectedProviderCanDiscover ? 'Select a live model' : 'Add API key to load models'}
                                className="w-[360px]"
                                options={[
                                  ...selectedProviderModelOptions.map(option => ({
                                    value: option.id,
                                    label: option.label,
                                    description: getModelThinkingOptions(
                                      selectedConnectionProvider,
                                      option.id,
                                      selectedProviderDirectory?.models.find(model => model.id === option.id)?.thinking,
                                    ).map(level => level.label).join(' / ') || 'Standard',

                                  })),
                                ]}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow
                              title="API base URL"
                              description="Optional OpenAI-compatible endpoint override. Use this for remote servers, Docker hosts, gateways, or a custom provider."
                              info="HTTP and HTTPS URLs work on Windows, macOS, and Linux. Leave blank to use the provider's official or local default."
                            >
                              <div className="flex w-[360px] items-center gap-2">
                                <input
                                  value={providerBaseURLs[selectedConnectionProvider] || ''}
                                  onChange={(event) => {
                                    const value = event.target.value;
                                    settingsRevisionRef.current += 1;
                                    providerBaseURLDirtyRef.current = true;
                                    setProviderBaseURLs(previous => {
                                      const next = { ...previous };
                                      if (value) next[selectedConnectionProvider] = value;
                                      else delete next[selectedConnectionProvider];
                                      return next;
                                    });
                                  }}
                                  placeholder={selectedConnectionProvider === 'custom' ? 'https://host.example/v1' : 'Use provider default'}
                                  spellCheck={false}
                                  className="h-9 min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-[#141414] px-3 text-[12px] font-mono text-[#F1F1F1] outline-none transition-colors placeholder:text-[#666] focus:border-white/[0.20]"
                                />
                                 {providerBaseURLs[selectedConnectionProvider] && (
                                  <SoftButton onClick={() => {
                                    settingsRevisionRef.current += 1;
                                    providerBaseURLDirtyRef.current = true;
                                    setProviderBaseURLs(previous => {
                                      const next = { ...previous };
                                      delete next[selectedConnectionProvider];
                                      return next;
                                    });
                                  }}>Default</SoftButton>
                                )}
                              </div>
                            </SettingsStackRow>
                            <SettingsStackRow
                              title={selectedConnectionProvider === 'openrouter' ? 'Exact OpenRouter model' : selectedConnectionProvider === 'groq' ? 'Exact Groq model' : 'Exact model ID'}
                              description={selectedConnectionProvider === 'openrouter'
                                ? 'Paste any OpenRouter slug, for example openai/gpt-5.5 or anthropic/claude-opus-4.8.'
                                : selectedConnectionProvider === 'groq'
                                  ? 'Paste any Groq model id, for example openai/gpt-oss-120b or llama-3.3-70b-versatile.'
                                : 'Use a provider-specific model ID when it is not listed yet in live discovery.'}
                              info="Advanced override. The runtime will use this exact ID; refresh discovery afterward to confirm the provider exposes it."
                            >
                              <div className="flex w-[280px] items-center gap-2">
                                <input
                                  value={exactModelDraft}
                                  onChange={(event) => setExactModelDraft(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                      event.preventDefault();
                                      addModelToSelector(selectedConnectionProvider, exactModelDraft.trim(), true);
                                    }
                                    if (event.key === 'Escape') setExactModelDraft(selectedProviderModel);
                                  }}
                                  placeholder={selectedConnectionProvider === 'openrouter' ? 'provider/model-id' : 'model-id'}
                                  className="h-9 min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-[#141414] px-3 text-[12px] font-mono text-[#F1F1F1] outline-none transition-colors placeholder:text-[#666] focus:border-white/[0.20]"
                                />
                                <SoftButton onClick={() => addModelToSelector(selectedConnectionProvider, exactModelDraft.trim(), true)}>Add</SoftButton>
                              </div>
                            </SettingsStackRow>
                            <SettingsStackRow
                              title="Chat model list"
                              description="Models in your chat selector, grouped by provider."
                              info="The selected chat model is sent with that exact model ID."
                              tall
                            >
                              <div className="w-[360px] rounded-xl border border-white/[0.08] bg-[#141414] p-1.5">
                                {modelEntries.length === 0 ? (
                                  <div className="px-3 py-3 text-[12px] leading-5 text-[#8C8C8C]">
                                    Add a model ID or choose one from provider discovery to make it available in chat.
                                  </div>
                                ) : (
                                  <div className="max-h-[280px] overflow-y-auto pr-1 eterx-scrollbar">
                                    {groupModelsByProvider(modelEntries).map(group => (
                                      <section key={group.provider} aria-label={(PROVIDER_LABEL[group.provider] || group.provider)}>
                                        <div className="px-2 pb-1 pt-3 text-[11px] font-semibold text-[#8F8F8F]">{(PROVIDER_LABEL[group.provider] || group.provider)}</div>
                                        {group.models.map(entry => {
                                          const entryKey = modelEntryKey(entry.provider, entry.modelId);
                                          const selected = chatModelSelection === entryKey;
                                          const entryThinkingOptions = getModelThinkingOptions(
                                            entry.provider,
                                            entry.modelId,
                                            modelThinkingCapabilities[entryKey],
                                          );
                                          return (
                                            <div key={entryKey} className={`flex items-center gap-2 rounded-lg px-2 py-2 transition-colors ${ selected ? 'bg-white/[0.055]' : 'hover:bg-white/[0.04]' }`}>
                                              <div className="min-w-0 flex-1">
                                                <div title={entry.modelId} className="truncate text-[12px] font-semibold text-[#F1F1F1]">{formatModelName(entry.modelId)}</div>
                                                <div className="mt-0.5 truncate text-[11px] text-[#777]">
                                                  {entryThinkingOptions.length ? entryThinkingOptions.map(option => option.label).join(' / ') : 'Standard'}
                                                </div>
                                              </div>
                                              <SoftButton onClick={() => selectCatalogModel(entry.provider, entry.modelId)}>
                                                {selected ? 'Current' : 'Apply'}
                                              </SoftButton>
                                              <button
                                                type="button"
                                                onClick={() => removeModelFromSelector(entry.provider, entry.modelId)}
                                                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-[#A7A7A7] transition-colors hover:border-red-400/30 hover:bg-red-500/10 hover:text-red-300"
                                                aria-label={`Remove ${entry.modelId}`}
                                              >
                                                <Trash2 className="h-3.5 w-3.5" />
                                              </button>
                                            </div>
                                          );
                                        })}
                                      </section>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </SettingsStackRow>
                            <SettingsStackRow
                              title="Live model discovery"
                              description={selectedProviderStatusText}
                            />
                          </SettingsStack>

                        </div>
                      )}

                      {/* ═══ ADVANCED TAB ═══ */}
                      {activeTab === 'api' && (
                        <div>
                          <SectionHeader
                            title="API connections"
                            badge={apiSyncStatus === 'synced' ? 'Saved' : undefined}
                            info="Provider pools are used by every model from that provider. Custom model pools override the provider pool only for one exact saved model."
                          />
                          <SettingsStack>
                            <SettingsStackRow
                              title="Provider"
                              description="Choose the API provider this key pool connects to."
                              info="This controls which provider-wide pool you are editing. For example, every Gemini model can use the Gemini provider pool."
                            >
                              <ProviderSelect
                                value={selectedApiProvider}
                                onChange={(value) => {
                                  if (!isModelProvider(value)) return;
                                  setSelectedApiProviderValue(value);
                                  setSelectedApiModelValue(`provider:${value}`);
                                }}
                                className="w-[240px]"
                                providers={MODEL_PROVIDER_ORDER}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow
                              title="API keys"
                              description="Add one or more keys. Use a custom model pool only when a model needs different credentials."
                              info="When a selected model has its own custom pool, that pool is used first. If not, EterX falls back to the provider pool."
                              tall
                            >
                              <ApiKeyPoolEditor
                                key={`${selectedApiProvider}-${selectedApiPoolEntry.value}`}
                                provider={selectedApiProvider}
                                providerLabel={selectedApiPoolEntry.isProviderPool ? `${selectedApiProviderLabel} provider pool` : selectedApiPoolEntry.label}
                                value={selectedApiPoolValue}
                                sync={selectedApiPoolEntry.isProviderPool ? selectedApiProviderSync : undefined}
                                minRows={1}
                                onChange={(nextValue) => {
                                  if (selectedApiPoolEntry.isProviderPool) {
                                    updateApiKey(selectedApiProvider, nextValue);
                                  } else {
                                    updateModelApiKey(selectedApiPoolEntry.value, nextValue);
                                  }
                                }}
                                scopeControl={
                                  <div className="flex items-center gap-2">
                                    <InfoHint text="Provider pool works for every model under this provider. Choosing a saved model creates an exact-model pool that overrides only that model." />
                                    <ModernSelect
                                      value={selectedApiPoolEntry.value}
                                      onChange={(value) => setSelectedApiModelValue(value)}
                                      placeholder="Provider pool"
                                      className="w-[230px]"
                                      options={apiPoolEntries.map(entry => ({
                                        value: entry.value,
                                        label: entry.label,
                                        description: entry.description,
                                      }))}
                                    />
                                  </div>
                                }
                              />
                            </SettingsStackRow>
                            {(providerKeyCount(selectedApiProvider) > 0 || isLocalModelProvider(selectedApiProvider)) && (
                              <SettingsStackRow
                                title="Model"
                                description={modelDirectory[selectedApiProvider]?.error
                                  || (modelDirectory[selectedApiProvider]?.connected
                                    ? 'Choose a model to add it to the chat selector.'
                                    : 'Loading models for this connection…')}
                              >
                                <div className="flex w-full max-w-[480px] flex-wrap items-center gap-2">
                                  <ModernSelect
                                    value={modelOverrides[selectedApiProvider] || ''}
                                    onChange={modelId => {
                                      if (modelId) addModelToSelector(selectedApiProvider, modelId, true);
                                    }}
                                    placeholder="Select a model"
                                    className="min-w-[220px] flex-1"
                                    options={getProviderModelOptions(selectedApiProvider).map(option => ({
                                      value: option.id, label: option.label,
                                    }))}
                                  />
                                  <SoftButton onClick={() => {
                                    setSelectedConnectionProvider(selectedApiProvider);
                                    setActiveTab('models');
                                  }}>Manage models</SoftButton>
                                </div>
                              </SettingsStackRow>
                            )}
                          </SettingsStack>

                          {apiSyncStatus === 'error' && <p className="mt-2 text-[12px] text-red-300" role="status">{apiSyncMessage}</p>}

                          <SectionHeader title="Service APIs" />
                          <SettingsStack>
                            <SettingsStackRow
                              title="API retries"
                              description="Choose how many complete passes the runtime may make through the configured provider key pool."
                              info="None makes one pass. Each retry adds one more full pass; failed keys become eligible again in the next pass."
                            >
                              <ModernSelect
                                value={String(settings.maxRetries)}
                                onChange={value => updateSetting('maxRetries', Number(value))}
                                className="w-[220px]"
                                options={API_RETRY_OPTIONS}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Code platform" description="GitHub token enables repository-aware actions when needed." tall>
                              <ApiKeyPoolEditor
                                provider="github"
                                providerLabel="GitHub"
                                value={apiKeys.github || ''}
                                sync={providerSync('github')}
                                minRows={1}
                                onChange={(nextValue) => updateApiKey('github', nextValue)}
                              />
                            </SettingsStackRow>
                          </SettingsStack>
                        </div>
                      )}

                      {/* ═══ LIVE CONVO TAB ═══ */}
                      {activeTab === 'live-convo' && (
                        <div>
                          <SectionHeader
                            title="Live Convo"
                            badge={settings.liveConvoEnabled ? 'Live' : 'Disabled'}
                            info="Configure a documented native realtime provider, its model, voice, and dedicated key pool. Client-side speech fallbacks and undocumented provider adapters are not used."
                          />
                          <SettingsStack>
                            <SettingsStackRow
                              title="Live Convo Engine"
                              description="Enable the real-time Agent Live Convo audio and streaming session."
                            >
                              <Toggle
                                enabled={settings.liveConvoEnabled ?? true}
                                onChange={(v) => updateSetting('liveConvoEnabled', v)}
                              />
                            </SettingsStackRow>

                            <SettingsStackRow
                              title="Live Provider"
                              description="Select the native realtime provider for the active Live session."
                              info="Each provider uses its documented transport and audio protocol. Long-lived keys stay server-side where the provider supports ephemeral browser credentials."
                            >
                              <ModernSelect
                                value={activeLiveProvider.value}
                                onChange={(val) => {
                                  updateSetting('liveConvoProvider', val);
                                  updateSetting('liveConvoModel', 'auto');
                                  updateSetting('liveConvoVoice', 'auto');
                                }}
                                className="w-[280px]"
                                options={LIVE_PROVIDER_OPTIONS.map(option => ({
                                  value: option.value,
                                  label: option.label,
                                  description: option.description,
                                }))}
                              />
                            </SettingsStackRow>

                            <SettingsStackRow
                              title="Live Model"
                              description="Specific model engine active for current provider stream."
                              info={`Models are loaded for ${activeLiveProvider.label} and never fall back to another provider.`}
                            >
                              <ModernSelect
                                value={settings.liveConvoModel || 'auto'}
                                onChange={(val) => updateSetting('liveConvoModel', val)}
                                className="w-[340px]"
                                options={activeLiveModelOptions}
                              />
                            </SettingsStackRow>

                            <SettingsStackRow
                              title="Voice Persona"
                              description="Choose the synthesized output voice for live responses."
                              info={`Voices are loaded for the selected ${activeLiveProvider.label} model.`}
                            >
                              <ModernSelect
                                value={settings.liveConvoVoice || 'auto'}
                                onChange={(val) => updateSetting('liveConvoVoice', val)}
                                className="w-[340px]"
                                options={activeLiveVoiceOptions}
                              />
                            </SettingsStackRow>

                            {activeLiveProvider.requiresAgentId && (
                              <SettingsStackRow
                                title="Conversational Agent ID"
                                description="Required by ElevenLabs to identify the configured Conversational AI agent."
                                info="Create and configure the agent in ElevenLabs, then paste its agent_… ID here. Private agents receive a short-lived signed WebSocket URL from EterX."
                              >
                                <input
                                  value={settings.liveConvoAgentId || ''}
                                  onChange={(event) => updateSetting('liveConvoAgentId', event.target.value.trim())}
                                  placeholder="agent_…"
                                  className="h-9 w-[340px] rounded-xl border border-white/[0.08] bg-[#141414] px-3 font-mono text-[12px] text-[#F1F1F1] outline-none transition-colors placeholder:text-[#666] focus:border-white/[0.20]"
                                />
                              </SettingsStackRow>
                            )}

                            <SettingsStackRow
                              title="Provider catalog status"
                              description="Live model and voice catalogs are refreshed whenever the provider, model, or key changes."
                            >
                              <div className={`flex min-w-[340px] items-center justify-end gap-2 text-[12px] ${
                                liveCatalogStatus === 'ready'
                                  ? 'text-emerald-300'
                                  : liveCatalogStatus === 'error'
                                    ? 'text-amber-300'
                                    : 'text-[#A5A5A5]'
                              }`}>
                                {liveCatalogStatus === 'loading' && <Spinner className="h-3.5 w-3.5" />}
                                <span>{liveCatalogMessage}</span>
                              </div>
                            </SettingsStackRow>

                            {activeLiveProvider.provider === 'gemini' && (
                              <SettingsStackRow
                                title="Gemini Thinking Level"
                                description="Choose the documented Gemini 3.1 Live thinking level used for this session."
                              >
                                <ModernSelect
                                  value={settings.liveConvoLatencyMode || 'ultra-low'}
                                  onChange={(val) => updateSetting('liveConvoLatencyMode', val as AppSettings['liveConvoLatencyMode'])}
                                  className="w-[220px]"
                                  options={[
                                    { value: 'ultra-low', label: 'Minimal (Lowest latency)' },
                                    { value: 'balanced', label: 'Medium' },
                                    { value: 'high-quality', label: 'High' },
                                  ]}
                                />
                              </SettingsStackRow>
                            )}

                            <SettingsStackRow
                              title="Audio Modalities"
                              description="Control live microphone input capture and speaker output."
                            >
                              <div className="flex items-center gap-6">
                                <label className="flex items-center gap-2 text-[13px] text-[#E0E0E0] cursor-pointer">
                                  <Toggle
                                    enabled={settings.liveConvoAudioInput ?? true}
                                    onChange={(v) => updateSetting('liveConvoAudioInput', v)}
                                  />
                                  Mic Input
                                </label>
                                <label className="flex items-center gap-2 text-[13px] text-[#E0E0E0] cursor-pointer">
                                  <Toggle
                                    enabled={settings.liveConvoAudioOutput ?? true}
                                    onChange={(v) => updateSetting('liveConvoAudioOutput', v)}
                                  />
                                  Speaker Output
                                </label>
                              </div>
                            </SettingsStackRow>
                          </SettingsStack>

                          <SectionHeader title="Live System Instructions" />
                          <p className="-mt-2 mb-4 text-[14px] leading-relaxed text-[#A5A5A5]">
                            Custom system directives sent to the live API session to define how the live agent speaks and behaves during realtime interaction.
                          </p>
                          <textarea
                            value={settings.liveConvoSystemInstruction || ''}
                            onChange={(e) => updateSetting('liveConvoSystemInstruction', e.target.value)}
                            placeholder="e.g. You are a fast, concise live voice coding assistant. Speak directly, avoid long intros, and answer code questions immediately."
                            className="min-h-[120px] w-full resize-y rounded-xl border border-white/[0.09] bg-[#202020] px-4 py-3 font-mono text-[13px] leading-6 text-[#F1F1F1] outline-none transition-colors placeholder:text-[#777] focus:border-white/[0.20]"
                          />

                            <SectionHeader title={`${activeLiveProvider.label} API Key`} />
                          <SettingsStack>
                            <SettingsStackRow
                              title="Live Convo Key Pool"
                              description={`Dedicated ${activeLiveProvider.label} key pool. It is stored separately from the provider key in Models/API and is tested against the selected provider.`}
                              tall
                            >
                              <ApiKeyPoolEditor
                                provider={liveApiKeyProvider}
                                providerLabel={liveApiKeyLabel}
                                value={activeLiveApiKey}
                                minRows={2}
                                testEndpoint="/api/live/models"
                                testProvider={activeLiveProvider.value}
                                testBody={(key) => ({ provider: activeLiveProvider.value, key, testOnly: true })}
                                onChange={(nextValue) => updateLiveApiKey(liveApiKeyProvider, nextValue)}
                              />
                            </SettingsStackRow>
                          </SettingsStack>
                        </div>
                      )}

                      {activeTab === 'personalization' && (
                        <div>
                          <SectionHeader title="Personalization" />
                          <SettingsStack>
                            <SettingsStackRow title="User name" description="Used in local prompts, workspace labels, and generated titles.">
                              <input
                                value={settings.userName || ''}
                                onChange={(e) => updateSetting('userName', e.target.value)}
                                className="h-9 w-[240px] rounded-xl border border-white/[0.08] bg-[#141414] px-3 text-[13px] text-[#F1F1F1] outline-none transition-colors placeholder:text-[#666] focus:border-white/[0.20]"
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Language" description="Interface language preference for the local app shell.">
                              <ModernSelect
                                value={settings.language}
                                onChange={(value) => updateSetting('language', value)}
                                className="w-[200px]"
                                options={[
                                  { value: 'en', label: 'English' },
                                  { value: 'hi', label: 'Hindi' },
                                  { value: 'es', label: 'Spanish' },
                                  { value: 'fr', label: 'French' },
                                  { value: 'de', label: 'German' },
                                  { value: 'ja', label: 'Japanese' },
                                  { value: 'zh', label: 'Chinese' },
                                ]}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Personality" description="Default response tone for EterX.">
                              <ModernSelect
                                value={settings.workMode}
                                onChange={(value) => updateSetting('workMode', value as AppSettings['workMode'])}
                                className="w-[200px]"
                                options={[
                                  { value: 'everyday', label: 'Everyday' },
                                  { value: 'specialist', label: 'Specialist' },
                                ]}
                              />
                            </SettingsStackRow>
                          </SettingsStack>

                          <SectionHeader title="Custom instructions" />
                          <p className="-mt-2 mb-4 text-[14px] leading-relaxed text-[#A5A5A5]">Tell EterX more about you, your workflow preferences, and how you want it to behave.</p>
                          <textarea
                            value={settings.customInstructions || ''}
                            onChange={(event) => updateSetting('customInstructions', event.target.value)}
                            placeholder="Add your custom instructions..."
                            className="min-h-[260px] w-full resize-y rounded-xl border border-white/[0.09] bg-[#202020] px-4 py-3 font-mono text-[13px] leading-6 text-[#F1F1F1] outline-none transition-colors placeholder:text-[#777] focus:border-white/[0.20]"
                          />


                        </div>
                      )}



                      {activeTab === 'mcp' && (
                        <div>
                          <SectionHeader title="MCP" />
                          <SettingRow icon={<PlugZap className="w-4 h-4" />} title="Enable MCP bridge" description="Expose the EterX gateway to an MCP client when the gateway is running.">
                            <Toggle enabled={settings.mcpServersEnabled} onChange={async v => { updateSetting('mcpServersEnabled', v); const gatewayApi = (window as any).electronAPI; const state = await gatewayApi?.getGatewayState?.(); if (state?.config && gatewayApi?.saveGatewayConfig) await gatewayApi.saveGatewayConfig({ ...state.config, mcpBridgeEnabled: v }); }} />
                          </SettingRow>
                          <div className="mt-4 rounded-xl border border-white/[0.08] bg-[#202020] px-4 py-3 text-[13px] leading-5 text-[#A5A5A5]">
                            The gateway&apos;s Advanced settings provide a secure MCP endpoint and copyable client configuration. Platform connectors are configured under Channels, so unavailable services are never shown as active here.
                          </div>
                        </div>
                      )}



                      {activeTab === 'git' && (
                        <div>
                          <SectionHeader title="Git" />
                          <SettingsStack>
                            <SettingsStackRow title="Git integration" description="Detect repository status and expose branch-aware actions inside the agent workflow.">
                              <Toggle enabled={settings.gitIntegration} onChange={v => updateSetting('gitIntegration', v)} />
                            </SettingsStackRow>
                            <SettingsStackRow title="Auto-detect changes" description="Refresh changed files and branch status while the agent edits the workspace.">
                              <Toggle enabled={settings.gitAutoDetect} onChange={v => updateSetting('gitAutoDetect', v)} />
                            </SettingsStackRow>
                            <SettingsStackRow title="Branch prefix" description="Default prefix for new EterX-created branches.">
                              <span className="rounded-lg border border-white/[0.08] bg-[#141414] px-3 py-2 font-mono text-[13px] text-[#CFCFCF]">eterx/</span>
                            </SettingsStackRow>
                            <SettingsStackRow title="Pull request merge method" description="Default merge strategy for repository workflows.">
                              <SegmentedControl
                                value={settings.gitMergeMethod}
                                onChange={(value) => updateSetting('gitMergeMethod', value)}
                                options={[
                                  { value: 'merge', label: 'Merge' },
                                  { value: 'squash', label: 'Squash' },
                                ]}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Show PR status in sidebar" description="Display repository status beside active project chats.">
                              <Toggle enabled={settings.showPrStatus} onChange={v => updateSetting('showPrStatus', v)} />
                            </SettingsStackRow>
                          </SettingsStack>
                        </div>
                      )}



                      {activeTab === 'browser' && (
                        <div>
                          <SectionHeader
                            title="External service"
                            badge={settings.groundingSearch ? 'Live' : 'Off'}
                            info="External service is the single control plane for live web search, source extraction, and deep research. Provider credentials remain local and are never placed in chat requests."
                          />

                          <SettingsStack>
                            <SettingsStackRow
                              title="Use built-in model search first"
                              description="When the active model supports native web search, use it first. If it is unavailable or fails, continue automatically through the external provider and key fallback order."
                            >
                              <Toggle enabled={searchSettings.preferModelSearch} onChange={v => updateSearchSettings(current => ({ ...current, preferModelSearch: v }))} />
                            </SettingsStackRow>
                            <SettingsStackRow
                              title="Live web intelligence"
                              description="Enable live search, source reading, and deep research through the selected route."
                            >
                              <Toggle enabled={settings.groundingSearch} onChange={v => { updateSetting('groundingSearch', v); updateSearchSettings(current => ({ ...current, enabled: v })); }} />
                            </SettingsStackRow>
                          </SettingsStack>

                          <div className="mb-4 mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-[#858585]">
                            <span>Route: <span className="font-medium text-[#D7D7D7]">{selectedSearchMeta.label}</span>{searchSettings.fallbackProviders.length ? ` + ${searchSettings.fallbackProviders.length} fallback${searchSettings.fallbackProviders.length === 1 ? '' : 's'}` : ''}</span>
                            <span>Credentials: <span className="font-medium text-[#D7D7D7]">{selectedSearchMeta.requiresKey ? `${(searchSettings.apiKeys[searchSettings.provider] || []).length}/3` : 'Not required'}</span></span>
                            <span>Research: <span className="font-medium text-[#D7D7D7]">{selectedSearchMeta.deepResearch === 'native' ? 'Provider-native' : 'Agent-led'}</span></span>
                          </div>

                          <SettingsStack>
                            <SettingsStackRow title="Primary provider" description="This provider receives the first live request. Choose another service at any time without changing the agent or research tools.">
                              <ModernSelect
                                value={searchSettings.provider}
                                onChange={(value) => {
                                  if (!SEARCH_PROVIDER_IDS.includes(value as SearchProvider)) return;
                                  const provider = value as SearchProvider;
                                  updateSearchSettings(current => ({
                                    ...current,
                                    provider,
                                    fallbackProviders: current.fallbackProviders.filter(item => item !== provider),
                                  }));
                                }}
                                className="w-[280px]"
                                options={SEARCH_PROVIDER_IDS.map(provider => ({
                                  value: provider,
                                  label: SEARCH_PROVIDER_META[provider].label,
                                  description: SEARCH_PROVIDER_META[provider].description,
                                }))}
                              />
                            </SettingsStackRow>
                            {selectedSearchMeta.requiresEndpoint && (
                              <SettingsStackRow
                                title={selectedSearchMeta.requiresEndpoint ? 'Service URL' : 'Custom endpoint'}
                                description={selectedSearchMeta.requiresEndpoint ? `Required for ${selectedSearchMeta.label}. Enter the base URL of the service instance.` : 'Only needed for a private relay or custom deployment.'}
                                tall
                              >
                                <input
                                  value={searchSettings.baseURLs[searchSettings.provider] || ''}
                                  onChange={event => updateSearchSettings(current => ({
                                    ...current,
                                    baseURLs: { ...current.baseURLs, [searchSettings.provider]: event.target.value },
                                  }))}
                                  placeholder={selectedSearchMeta.baseURLPlaceholder || selectedSearchMeta.defaultBaseURL || 'Service URL'}
                                  className="h-10 w-full rounded-xl border border-white/[0.08] bg-[#141414] px-3 text-[12px] font-mono text-[#F1F1F1] outline-none transition-colors placeholder:text-[#666] focus:border-sky-300/35"
                                />
                              </SettingsStackRow>
                            )}
                            <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.07] px-4 py-3">
                              <span className="mr-1 text-[11px] text-[#777]">This route provides</span>
                              {selectedSearchMeta.capabilities.map(capability => (
                                <span key={capability} className="rounded-full border border-white/[0.09] bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium text-[#BDBDBD]">{SEARCH_CAPABILITY_LABELS[capability]}</span>
                              ))}
                              <span className="rounded-full border border-sky-300/15 bg-sky-300/[0.07] px-2.5 py-1 text-[10px] font-medium text-sky-200">{selectedSearchMeta.deepResearch === 'native' ? 'Native research' : 'Agent-led research'}</span>
                            </div>
                            <SettingsStackRow title="Provider services" description="Choose which services this provider can receive. Changes apply to the next agent request and stay scoped to this provider." tall>
                              <div className="w-full overflow-hidden rounded-xl border border-white/[0.08] bg-[#141414]">
                                {SEARCH_SERVICE_IDS.map(service => {
                                  const enabled = selectedSearchServices.includes(service);
                                  const native = service === 'research'
                                    ? selectedSearchMeta.deepResearch === 'native'
                                    : selectedSearchMeta.capabilities.includes(service === 'read' ? 'read' : service as 'search' | 'crawl' | 'map');
                                  return (
                                    <div key={service} className="flex items-center gap-3 border-b border-white/[0.07] px-3.5 py-2.5 last:border-b-0">
                                      <Toggle enabled={enabled} onChange={() => toggleSearchService(searchSettings.provider, service)} />
                                      <div className="min-w-0 flex-1">
                                        <div className="text-[12px] font-medium text-[#E5E5E5]">{SEARCH_SERVICE_META[service].label}</div>
                                        <div className="mt-0.5 text-[10.5px] leading-4 text-[#777]">{SEARCH_SERVICE_META[service].description}</div>
                                      </div>
                                      <span className={`shrink-0 rounded-full px-2 py-1 text-[9px] font-medium ${native ? 'bg-emerald-300/10 text-emerald-200' : 'bg-white/[0.05] text-[#898989]'}`}>{native ? 'Provider route' : 'Agent fallback'}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            </SettingsStackRow>
                            <SettingsStackRow title="Provider credentials" description={selectedSearchMeta.credentialDescription || (selectedSearchMeta.requiresKey ? `Up to three ${selectedSearchMeta.label} keys. Keys are tried in order and rotate after a successful request.` : 'This provider does not require a credential.')} tall>
                              {selectedSearchMeta.requiresKey ? (
                                <ApiKeyPoolEditor
                                  key={`search-${searchSettings.provider}`}
                                  provider={searchSettings.provider}
                                  providerLabel={selectedSearchMeta.credentialLabel || selectedSearchMeta.label}
                                  value={(searchSettings.apiKeys[searchSettings.provider] || []).join('\n')}
                                  minRows={1}
                                  maxRows={3}
                                  testEndpoint="/api/settings/search"
                                  testBaseURL={searchSettings.baseURLs[searchSettings.provider] || ''}
                                  onChange={value => updateSearchKeyPool(searchSettings.provider, value)}
                                />
                              ) : (
                                <div className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#141414] px-4 py-3">
                                  <div className="flex min-w-0 items-center gap-3">
                                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-emerald-300/10 text-emerald-300"><Check className="h-4 w-4" /></div>
                                    <div className="min-w-0"><div className="text-[12px] font-medium text-[#E5E5E5]">No API key required</div><div className="mt-0.5 truncate text-[11px] text-[#777]">The endpoint and live response are the connection check.</div></div>
                                  </div>
                                  <button type="button" onClick={() => void testSearchConnection(searchSettings.provider)} disabled={searchProbe.provider === searchSettings.provider && searchProbe.status === 'testing'} className="shrink-0 rounded-lg bg-white/[0.07] px-3 py-2 text-[11px] font-semibold text-[#D8D8D8] transition-colors hover:bg-white/[0.12] disabled:opacity-40">{searchProbe.provider === searchSettings.provider && searchProbe.status === 'testing' ? 'Testing...' : 'Test connection'}</button>
                                </div>
                              )}
                            </SettingsStackRow>
                          </SettingsStack>

                          <SectionHeader title="Automatic failover" info="Every enabled provider is tried in order. Each route advertises its own search, reading, crawl, map, and research capabilities so the agent can choose the right action after settings or model changes." />
                          <div className="overflow-hidden rounded-xl border border-white/[0.09] bg-[#202020]">
                            {SEARCH_PROVIDER_IDS.filter(provider => provider !== searchSettings.provider).map(provider => {
                              const enabled = searchSettings.fallbackProviders.includes(provider);
                              const order = searchSettings.fallbackProviders.indexOf(provider);
                              return (
                                <div key={provider} className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3 last:border-b-0">
                                  <button type="button" role="switch" aria-checked={enabled} aria-label={`${enabled ? 'Disable' : 'Enable'} ${SEARCH_PROVIDER_META[provider].label} fallback`} onClick={() => toggleSearchFallback(provider)} className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${enabled ? 'bg-sky-400' : 'bg-white/[0.12]'}`}><span className={`absolute left-1 top-1 h-3 w-3 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0'}`} /></button>
                                  <ProviderMark provider={provider} />
                                  <div className="min-w-0 flex-1"><div className="truncate text-[12.5px] font-medium text-[#E9E9E9]">{SEARCH_PROVIDER_META[provider].label}</div><div className="mt-0.5 truncate text-[11px] text-[#777]">{SEARCH_PROVIDER_META[provider].description}</div><div className="mt-1 flex flex-wrap gap-1.5">{SEARCH_PROVIDER_META[provider].capabilities.map(capability => <span key={capability} className="rounded-full bg-white/[0.04] px-1.5 py-0.5 text-[9px] text-[#8F8F8F]">{SEARCH_CAPABILITY_LABELS[capability]}</span>)}<span className="rounded-full bg-white/[0.04] px-1.5 py-0.5 text-[9px] text-[#8F8F8F]">{SEARCH_PROVIDER_META[provider].deepResearch === 'native' ? 'Native research' : 'Agent-led research'}</span></div></div>
                                  {enabled && <><span className="rounded-full border border-sky-300/15 bg-sky-300/10 px-2 py-1 text-[10px] font-semibold text-sky-200">Fallback {order + 1}</span><button type="button" onClick={() => moveSearchFallback(provider, -1)} disabled={order === 0} className="rounded-md px-2 py-1 text-[11px] text-[#A7A7A7] hover:bg-white/[0.06] disabled:opacity-25">↑</button><button type="button" onClick={() => moveSearchFallback(provider, 1)} disabled={order === searchSettings.fallbackProviders.length - 1} className="rounded-md px-2 py-1 text-[11px] text-[#A7A7A7] hover:bg-white/[0.06] disabled:opacity-25">↓</button></>}
                                </div>
                              );
                            })}
                          </div>
                          {searchProbe.message && searchProbe.provider === searchSettings.provider && <div className={`mt-3 rounded-xl border px-4 py-3 text-[12px] leading-5 ${searchProbe.status === 'success' ? 'border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-200' : searchProbe.status === 'failed' ? 'border-red-400/20 bg-red-400/[0.06] text-red-200' : 'border-white/[0.08] bg-white/[0.03] text-[#B8B8B8]'}`}>{searchProbe.message}</div>}

                          <SectionHeader title="Image generation" badge={imageSettings.enabled ? 'Live' : 'Off'} info="Generate real raster images through the selected provider. The agent receives the active provider and model route, rotates keys, and fails over only after a real provider error." />
                          <SettingsStack>
                            <SettingsStackRow title="Enable image generation" description="Allow the image_generator tool to call the selected provider and save returned raster files locally.">
                              <Toggle enabled={imageSettings.enabled} onChange={v => updateImageSettings(current => ({ ...current, enabled: v }))} />
                            </SettingsStackRow>
                          </SettingsStack>
                          <div className="mb-4 mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-[#858585]">
                            <span>Route: <span className="font-medium text-[#D7D7D7]">{selectedImageMeta.label}</span>{imageSettings.fallbackProviders.length ? ` + ${imageSettings.fallbackProviders.length} fallback${imageSettings.fallbackProviders.length === 1 ? '' : 's'}` : ''}</span>
                            <span>Model: <span className="font-medium text-[#D7D7D7]">{selectedImageModel}</span></span>
                            <span>Keys: <span className="font-medium text-[#D7D7D7]">{(imageSettings.apiKeys[imageSettings.provider] || []).length}/3</span></span>
                          </div>
                          <SettingsStack>
                            <SettingsStackRow title="Primary provider" description="The first real image request uses this provider and its selected model.">
                              <ModernSelect
                                value={imageSettings.provider}
                                onChange={value => {
                                  if (!IMAGE_PROVIDER_IDS.includes(value as ImageProvider)) return;
                                  const provider = value as ImageProvider;
                                  updateImageSettings(current => ({
                                    ...current,
                                    provider,
                                    fallbackProviders: current.fallbackProviders.filter(item => item !== provider),
                                  }));
                                }}
                                className="w-[280px]"
                                options={IMAGE_PROVIDER_IDS.map(provider => ({
                                  value: provider,
                                  label: IMAGE_PROVIDER_META[provider].label,
                                  description: IMAGE_PROVIDER_META[provider].description,
                                }))}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Model" description="Choose the model sent to the selected provider. The exact model id is shown so the agent route stays transparent.">
                              <ModernSelect
                                value={selectedImageModel}
                                onChange={model => updateImageSettings(current => ({ ...current, modelByProvider: { ...current.modelByProvider, [current.provider]: model } }))}
                                className="w-[360px]"
                                options={selectedImageMeta.models.map(model => ({ value: model.id, label: model.label, description: `${model.id} · ${model.description}` }))}
                              />
                            </SettingsStackRow>
                            <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.07] px-4 py-3">
                              <span className="mr-1 text-[11px] text-[#777]">This route provides</span>
                              <span className="rounded-full border border-white/[0.09] bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium text-[#BDBDBD]">{IMAGE_CAPABILITY_LABELS.text}</span>
                              {selectedImageMeta.supportsEditing && <span className="rounded-full border border-white/[0.09] bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium text-[#BDBDBD]">{IMAGE_CAPABILITY_LABELS.edit}</span>}
                              {selectedImageMeta.supportsAspectRatio && <span className="rounded-full border border-white/[0.09] bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium text-[#BDBDBD]">{IMAGE_CAPABILITY_LABELS.ratio}</span>}
                              <span className="rounded-full border border-emerald-300/15 bg-emerald-300/[0.07] px-2.5 py-1 text-[10px] font-medium text-emerald-200">Provider-native</span>
                            </div>
                            <SettingsStackRow title="Provider credentials" description={`Up to three ${selectedImageMeta.authLabel} values. Keys are attempted in order and rotate after a successful request.`} tall>
                              <ApiKeyPoolEditor
                                key={`image-${imageSettings.provider}`}
                                provider={imageSettings.provider}
                                providerLabel={selectedImageMeta.authLabel}
                                value={(imageSettings.apiKeys[imageSettings.provider] || []).join('\n')}
                                minRows={1}
                                maxRows={3}
                                testEndpoint="/api/settings/image"
                                testBody={(key) => ({ provider: imageSettings.provider, key, model: selectedImageModel })}
                                onChange={value => updateImageKeyPool(imageSettings.provider, value)}
                              />
                            </SettingsStackRow>
                          </SettingsStack>
                          <div className="mt-3 overflow-hidden rounded-xl border border-white/[0.09] bg-[#202020]">
                            {IMAGE_PROVIDER_IDS.filter(provider => provider !== imageSettings.provider).map(provider => {
                              const enabled = imageSettings.fallbackProviders.includes(provider);
                              const order = imageSettings.fallbackProviders.indexOf(provider);
                              const meta = IMAGE_PROVIDER_META[provider];
                              return (
                                <div key={provider} className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3 last:border-b-0">
                                  <button type="button" role="switch" aria-checked={enabled} aria-label={`${enabled ? 'Disable' : 'Enable'} ${meta.label} fallback`} onClick={() => updateImageSettings(current => ({ ...current, fallbackProviders: enabled ? current.fallbackProviders.filter(item => item !== provider) : [...current.fallbackProviders, provider] }))} className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${enabled ? 'bg-sky-400' : 'bg-white/[0.12]'}`}><span className={`absolute left-1 top-1 h-3 w-3 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0'}`} /></button>
                                  <ProviderMark provider={provider} />
                                  <div className="min-w-0 flex-1"><div className="truncate text-[12.5px] font-medium text-[#E9E9E9]">{meta.label}</div><div className="mt-0.5 truncate text-[11px] text-[#777]">{meta.description}</div><div className="mt-1 text-[10px] text-[#8F8F8F]">Model: {imageSettings.modelByProvider[provider] || meta.defaultModel}</div></div>
                                  {enabled && <><span className="rounded-full border border-sky-300/15 bg-sky-300/10 px-2 py-1 text-[10px] font-semibold text-sky-200">Fallback {order + 1}</span><button type="button" onClick={() => moveImageFallback(provider, -1)} disabled={order === 0} className="rounded-md px-2 py-1 text-[11px] text-[#A7A7A7] hover:bg-white/[0.06] disabled:opacity-25">↑</button><button type="button" onClick={() => moveImageFallback(provider, 1)} disabled={order === imageSettings.fallbackProviders.length - 1} className="rounded-md px-2 py-1 text-[11px] text-[#A7A7A7] hover:bg-white/[0.06] disabled:opacity-25">↓</button></>}
                                </div>
                              );
                            })}
                          </div>
                          <div className="mt-3 flex justify-end">
                            <button type="button" onClick={() => void testImageConnection(imageSettings.provider)} disabled={imageProbe.provider === imageSettings.provider && imageProbe.status === 'testing'} className="rounded-lg bg-white/[0.07] px-3 py-2 text-[11px] font-semibold text-[#D8D8D8] transition-colors hover:bg-white/[0.12] disabled:opacity-40">{imageProbe.provider === imageSettings.provider && imageProbe.status === 'testing' ? 'Testing...' : 'Test connection'}</button>
                          </div>
                          {imageProbe.message && imageProbe.provider === imageSettings.provider && <div className={`mt-3 rounded-xl border px-4 py-3 text-[12px] leading-5 ${imageProbe.status === 'success' ? 'border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-200' : imageProbe.status === 'failed' ? 'border-red-400/20 bg-red-400/[0.06] text-red-200' : 'border-white/[0.08] bg-white/[0.03] text-[#B8B8B8]'}`}>{imageProbe.message}</div>}

                          <SectionHeader title="Video generation" badge={videoSettings.enabled ? 'Live' : 'Off'} info="Generate real video files through the selected provider. The agent receives the live provider, model, capabilities, key status, and fallback order before it chooses this tool." />
                          <SettingsStack>
                            <SettingsStackRow title="Enable video generation" description="Allow the video_generator tool to call the selected provider and save returned video files locally.">
                              <Toggle enabled={videoSettings.enabled} onChange={v => updateVideoSettings(current => ({ ...current, enabled: v }))} />
                            </SettingsStackRow>
                          </SettingsStack>
                          <div className="mb-4 mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-[#858585]">
                            <span>Route: <span className="font-medium text-[#D7D7D7]">{selectedVideoMeta.label}</span>{videoSettings.fallbackProviders.length ? ` + ${videoSettings.fallbackProviders.length} fallback${videoSettings.fallbackProviders.length === 1 ? '' : 's'}` : ''}</span>
                            <span>Model: <span className="font-medium text-[#D7D7D7]">{selectedVideoModel}</span></span>
                            <span>Keys: <span className="font-medium text-[#D7D7D7]">{(videoSettings.apiKeys[videoSettings.provider] || []).length}/3</span></span>
                          </div>
                          <SettingsStack>
                            <SettingsStackRow title="Primary provider" description="The first video request uses this provider and its selected model.">
                              <ModernSelect
                                value={videoSettings.provider}
                                onChange={value => {
                                  if (!VIDEO_PROVIDER_IDS.includes(value as VideoProvider)) return;
                                  const provider = value as VideoProvider;
                                  updateVideoSettings(current => ({ ...current, provider, fallbackProviders: current.fallbackProviders.filter(item => item !== provider) }));
                                }}
                                className="w-[280px]"
                                options={VIDEO_PROVIDER_IDS.map(provider => ({ value: provider, label: VIDEO_PROVIDER_META[provider].label, description: VIDEO_PROVIDER_META[provider].description }))}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Model" description="Choose a suggested model or enter an exact current model ID for FAL and Replicate catalogs.">
                              <div className="flex w-full flex-col gap-2">
                                <ModernSelect
                                  value={selectedVideoModel}
                                  onChange={model => updateVideoSettings(current => ({ ...current, modelByProvider: { ...current.modelByProvider, [current.provider]: model } }))}
                                  className="w-full"
                                  options={selectedVideoMeta.models.map(model => ({ value: model.id, label: model.label, description: `${model.id} · ${model.description}` }))}
                                />
                                <input
                                  value={selectedVideoModel}
                                  onChange={event => updateVideoSettings(current => ({ ...current, modelByProvider: { ...current.modelByProvider, [current.provider]: event.target.value } }))}
                                  placeholder="Exact model ID"
                                  className="h-9 w-full rounded-xl border border-white/[0.08] bg-[#141414] px-3 text-[12px] font-mono text-[#F1F1F1] outline-none transition-colors placeholder:text-[#666] focus:border-sky-300/35"
                                />
                              </div>
                            </SettingsStackRow>
                            <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.07] px-4 py-3">
                              <span className="mr-1 text-[11px] text-[#777]">This route provides</span>
                              {selectedVideoMeta.supportsTextToVideo && <span className="rounded-full border border-white/[0.09] bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium text-[#BDBDBD]">Text to video</span>}
                              {selectedVideoMeta.supportsImageInput && <span className="rounded-full border border-white/[0.09] bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium text-[#BDBDBD]">Image to video</span>}
                              {selectedVideoMeta.supportsAudioOutput && <span className="rounded-full border border-sky-300/15 bg-sky-300/[0.07] px-2.5 py-1 text-[10px] font-medium text-sky-200">Synced audio</span>}
                              <span className="rounded-full border border-emerald-300/15 bg-emerald-300/[0.07] px-2.5 py-1 text-[10px] font-medium text-emerald-200">Provider-native</span>
                            </div>
                            <SettingsStackRow title="Provider credentials" description={`Up to three ${selectedVideoMeta.authLabel} values. Keys are attempted in order and rotate after a successful request.`} tall>
                              <ApiKeyPoolEditor
                                key={`video-${videoSettings.provider}`}
                                provider={videoSettings.provider}
                                providerLabel={selectedVideoMeta.authLabel}
                                value={(videoSettings.apiKeys[videoSettings.provider] || []).join('\n')}
                                minRows={1}
                                maxRows={3}
                                testEndpoint="/api/settings/video"
                                testBody={(key) => ({ provider: videoSettings.provider, key, model: selectedVideoModel })}
                                onChange={value => updateVideoKeyPool(videoSettings.provider, value)}
                              />
                            </SettingsStackRow>
                          </SettingsStack>
                          <div className="mt-3 overflow-hidden rounded-xl border border-white/[0.09] bg-[#202020]">
                            {VIDEO_PROVIDER_IDS.filter(provider => provider !== videoSettings.provider).map(provider => {
                              const enabled = videoSettings.fallbackProviders.includes(provider);
                              const order = videoSettings.fallbackProviders.indexOf(provider);
                              const meta = VIDEO_PROVIDER_META[provider];
                              return (
                                <div key={provider} className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3 last:border-b-0">
                                  <button type="button" role="switch" aria-checked={enabled} aria-label={`${enabled ? 'Disable' : 'Enable'} ${meta.label} fallback`} onClick={() => updateVideoSettings(current => ({ ...current, fallbackProviders: enabled ? current.fallbackProviders.filter(item => item !== provider) : [...current.fallbackProviders, provider] }))} className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${enabled ? 'bg-sky-400' : 'bg-white/[0.12]'}`}><span className={`absolute left-1 top-1 h-3 w-3 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0'}`} /></button>
                                  <ProviderMark provider={provider} />
                                  <div className="min-w-0 flex-1"><div className="truncate text-[12.5px] font-medium text-[#E9E9E9]">{meta.label}</div><div className="mt-0.5 truncate text-[11px] text-[#777]">{meta.description}</div><div className="mt-1 text-[10px] text-[#8F8F8F]">Model: {videoSettings.modelByProvider[provider] || meta.defaultModel}</div></div>
                                  {enabled && <><span className="rounded-full border border-sky-300/15 bg-sky-300/10 px-2 py-1 text-[10px] font-semibold text-sky-200">Fallback {order + 1}</span><button type="button" onClick={() => moveVideoFallback(provider, -1)} disabled={order === 0} className="rounded-md px-2 py-1 text-[11px] text-[#A7A7A7] hover:bg-white/[0.06] disabled:opacity-25">↑</button><button type="button" onClick={() => moveVideoFallback(provider, 1)} disabled={order === videoSettings.fallbackProviders.length - 1} className="rounded-md px-2 py-1 text-[11px] text-[#A7A7A7] hover:bg-white/[0.06] disabled:opacity-25">↓</button></>}
                                </div>
                              );
                            })}
                          </div>
                          <div className="mt-3 flex justify-end">
                            <button type="button" onClick={() => void testVideoConnection(videoSettings.provider)} disabled={videoProbe.provider === videoSettings.provider && videoProbe.status === 'testing'} className="rounded-lg bg-white/[0.07] px-3 py-2 text-[11px] font-semibold text-[#D8D8D8] transition-colors hover:bg-white/[0.12] disabled:opacity-40">{videoProbe.provider === videoSettings.provider && videoProbe.status === 'testing' ? 'Testing...' : 'Test connection'}</button>
                          </div>
                          {videoProbe.message && videoProbe.provider === videoSettings.provider && <div className={`mt-3 rounded-xl border px-4 py-3 text-[12px] leading-5 ${videoProbe.status === 'success' ? 'border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-200' : videoProbe.status === 'failed' ? 'border-red-400/20 bg-red-400/[0.06] text-red-200' : 'border-white/[0.08] bg-white/[0.03] text-[#B8B8B8]'}`}>{videoProbe.message}</div>}

                        </div>
                      )}

                      {activeTab === 'computer' && (
                        <div>
                          <SectionHeader title="Browser control" />
                          <div className="eterx-browser-service-card mb-5">
                            <div className="eterx-browser-service-card__header">
                              <div className="min-w-0">
                                <div className="eterx-browser-runtime-card__title text-[16px] font-semibold text-[#F1F1F1]">{browserRuntimeStatus?.signedBrowser ? 'Signed-in browser connected' : browserRuntimeStatus?.managedBrowser ? 'New isolated browser connected' : 'Choose a browser mode'}</div>
                                <div className="eterx-browser-runtime-card__message mt-1 text-[12px] leading-5 text-[#A5A5A5]">{browserRuntimeMessage}</div>
                                {browserRuntimeStatus?.signedBrowserAvailable === false && <div className="eterx-browser-runtime-card__warning mt-1 text-[11px] text-amber-300">Signed-in mode is disabled: {browserRuntimeStatus.signedBrowserReason}</div>}
                              </div>
                              <div className="eterx-browser-service-card__status-text">{browserRuntimeStatus?.signedBrowser || browserRuntimeStatus?.managedBrowser ? 'Connected' : 'Needs setup'}</div>
                            </div>
                            <div className="eterx-browser-service-card__meta">
                              <div><span className="eterx-browser-service-card__meta-label">Platform</span><span className="eterx-browser-service-card__meta-value">{browserRuntimeStatus?.platform || terminalPlatform}</span></div>
                              <div><span className="eterx-browser-service-card__meta-label">Mode</span><span className="eterx-browser-service-card__meta-value">{browserRuntimeStatus?.browser?.mode || 'Not connected'}</span></div>
                              <div><span className="eterx-browser-service-card__meta-label">Screen</span><span className="eterx-browser-service-card__meta-value">{browserRuntimeStatus?.computer?.screenProvider || 'Checking'}</span></div>
                              <div><span className="eterx-browser-service-card__meta-label">Input</span><span className="eterx-browser-service-card__meta-value">{browserRuntimeStatus?.computer?.inputProvider || 'Checking'}</span></div>
                            </div>
                            <div className="eterx-browser-service-card__actions">
                              <button type="button" disabled={browserRuntimeBusy || browserRuntimeStatus?.signedBrowserAvailable === false} onClick={() => runBrowserRuntimeAction('connect_signed')} className="eterx-browser-runtime-card__button eterx-browser-runtime-card__button--signed rounded-lg border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 text-[11px] font-semibold text-emerald-200 transition-colors hover:bg-emerald-300/20 disabled:cursor-not-allowed disabled:opacity-40">Signed-in existing browser</button>
                              <button type="button" disabled={browserRuntimeBusy} onClick={() => runBrowserRuntimeAction('launch_managed')} className="eterx-browser-runtime-card__button rounded-lg border border-white/[0.10] bg-white/[0.06] px-3 py-2 text-[11px] font-semibold text-[#D8D8D8] transition-colors hover:bg-white/[0.11] disabled:opacity-50">New isolated browser</button>
                              <button type="button" disabled={browserRuntimeBusy} onClick={refreshBrowserRuntimeStatus} className="eterx-browser-runtime-card__button rounded-lg border border-white/[0.10] px-3 py-2 text-[11px] font-semibold text-[#A5A5A5] transition-colors hover:bg-white/[0.08] disabled:opacity-50">Refresh status</button>
                            </div>
                            <div className="eterx-browser-runtime-card__note mt-3 text-[11px] leading-5 text-[#777]">Uses your existing Chrome, Edge, or Brave profile. Close an unmanaged browser before reconnecting.</div>
                          </div>
                          <SettingRow icon={<Globe className="w-4 h-4" />} title="Allow browser control" description="Inspect pages and use signed-in browser sessions.">
                            <Toggle enabled={settings.browserAccess} onChange={v => updateSetting('browserAccess', v)} />
                          </SettingRow>

                          <SectionHeader title="Computer use" info="Control native apps and screens. Separate from browser control." />
                          <div className="eterx-computer-control-plane mb-5 overflow-hidden rounded-2xl border border-white/[0.12] bg-gradient-to-br from-[#202832] via-[#1B2027] to-[#171A1E] shadow-none">
                            <div className="p-5 sm:p-6">
                              <div className="eterx-computer-control-plane__header">
                                <div className="flex min-w-0 items-start gap-3.5">
                                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-sky-200/20 bg-sky-200/10 text-sky-200"><Monitor className="h-4 w-4" /></div>
                                  <div className="min-w-0">
                                    <div className="eterx-computer-control-plane__title">Desktop control</div>
                                    <p className="eterx-computer-control-plane__description">Native apps and screens on Windows, macOS, and Linux.</p>
                                  </div>
                                </div>
                                <div className={`eterx-computer-state eterx-computer-state--${computerState.tone} inline-flex shrink-0 items-center gap-2 self-start rounded-full border px-3 py-1.5 text-[11px] font-semibold`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{computerState.label}</div>
                              </div>

                              <div className="eterx-computer-toggle-row mt-5 rounded-xl border border-white/[0.10] bg-black/20 px-4 py-3.5">
                                <div className="eterx-computer-toggle-icon" aria-hidden="true"><Cpu className="eterx-computer-toggle-glyph text-sky-200" /></div>
                                <div className="eterx-computer-toggle-copy">
                                  <div className="text-[13px] font-semibold text-[#F1F1F1]">Allow computer actions</div>
                                  <div className="mt-0.5 text-[11px] leading-5 text-[#98A2AE]">Required for direct screen input.</div>
                                </div>
                                <div className="eterx-computer-toggle-control"><Toggle enabled={settings.computerUse} onChange={v => updateSetting('computerUse', v)} /></div>
                              </div>

                              <div className="eterx-computer-runtime mt-4">
                                {[
                                  ['Platform', browserRuntimeStatus?.platform || terminalPlatform || 'Checking'],
                                  ['Driver', cuaDriver?.healthy ? (cuaDriver.version ? `Cua ${cuaDriver.version}` : 'Ready') : cuaDriver?.installed ? 'Needs setup' : 'Checking'],
                                  ['Screen', computerRuntime?.screenProvider || 'Checking'],
                                  ['Input', computerRuntime?.inputProvider || 'Checking'],
                                ].map(([label, value]) => <div key={label} className="eterx-computer-runtime__item"><span className="eterx-computer-runtime__label">{label}</span><span className="eterx-computer-runtime__value">{value}</span></div>)}
                              </div>
                            </div>
                            <div className="eterx-computer-driver-note flex flex-col gap-2 border-t border-white/[0.08] bg-black/15 px-5 py-3 text-[11px] leading-5 text-[#9DA8B4] sm:flex-row sm:items-center sm:justify-between sm:px-6"><span>{cuaDriver?.healthy ? 'Desktop runtime ready.' : cuaDriver?.installed ? 'Driver installed; permissions may be required.' : 'Checking desktop runtime.'}</span><button type="button" onClick={refreshBrowserRuntimeStatus} disabled={browserRuntimeBusy} className="shrink-0 rounded-lg border border-white/[0.10] bg-white/[0.05] px-3 py-1.5 font-semibold text-[#D5DCE4] transition-colors hover:bg-white/[0.10] disabled:opacity-50">Refresh</button></div>
                          </div>

                          <SectionHeader title="Safety & permissions" />
                          <SettingRow icon={<Shield className="w-4 h-4" />} title="Permission review" description="Review sensitive desktop actions before they run.">
                            <Toggle enabled={settings.autoReview} onChange={v => updateSetting('autoReview', v)} />
                          </SettingRow>
                          <div className="eterx-computer-safety mt-4 flex items-start gap-3 rounded-xl border border-amber-300/15 bg-amber-300/[0.06] p-4"><Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-200" /><div><div className="text-[12px] font-semibold text-amber-100">Explicit approval required</div><p className="mt-1 text-[11px] leading-5 text-amber-100/65">Computer Use also requires host-control permission in the active run.</p></div></div>
                        </div>
                      )}



                      {activeTab === 'environments' && (
                        <div>
                          <SectionHeader title="Developer" />
                          <SettingsStack>
                            <SettingsStackRow title="Debug mode" description="Show detailed internal logs, tool calls, and runtime traces in console.">
                              <Toggle enabled={settings.debugMode} onChange={v => updateSetting('debugMode', v)} />
                            </SettingsStackRow>
                            <SettingsStackRow title="Performance telemetry" description="Collect anonymous performance metrics to improve agent speed.">
                              <Toggle enabled={settings.telemetry} onChange={v => updateSetting('telemetry', v)} />
                            </SettingsStackRow>
                          </SettingsStack>

                          <SectionHeader title="Experimental" badge="Beta" />
                          <SettingsStack>
                            <SettingsStackRow title="Experimental features" description="Enable new capabilities that may still change.">
                              <Toggle enabled={settings.experimentalFeatures} onChange={v => updateSetting('experimentalFeatures', v)} />
                            </SettingsStackRow>
                          </SettingsStack>

                          <SectionHeader title="Data" />
                          <SettingsStack>
                            <SettingsStackRow title="Clear agent memory" description="Wipe stored memories, API keys, model overrides, and local preferences.">
                              <button
                                type="button"
                                onClick={() => {
                                  if (confirm('This will permanently delete all agent memory. Continue?')) {
                                    settingsRevisionRef.current += 1;
                                    appStorage.removeItem('eterx_settings');
                                    appStorage.removeItem('eterx_api_keys');
                                    appStorage.removeItem(API_KEY_PRESENCE_STORAGE_KEY);
                                    appStorage.removeItem(MODEL_OVERRIDE_STORAGE_KEY);
                                    appStorage.removeItem(MODEL_CATALOG_STORAGE_KEY);
                                    appStorage.removeItem(MODEL_SELECTOR_STORAGE_KEY);
                                    appStorage.removeItem(CHAT_MODEL_SELECTION_STORAGE_KEY);
                                    appStorage.removeItem(MODEL_API_KEYS_STORAGE_KEY);
                                    appStorage.removeItem(MODEL_API_KEY_PRESENCE_STORAGE_KEY);
                                    appStorage.removeItem(MODEL_THINKING_CAPABILITIES_STORAGE_KEY);
                                    appStorage.removeItem(MODEL_THINKING_LEVELS_STORAGE_KEY);
                                    appStorage.removeItem(MODEL_CONTEXT_WINDOWS_STORAGE_KEY);
                                    appStorage.removeItem(PROVIDER_BASE_URLS_STORAGE_KEY);
                                    appStorage.removeItem(CHAT_CONTEXT_WINDOW_OVERRIDES_STORAGE_KEY);
                                    transitionEterxTheme(DEFAULT_SETTINGS.theme, () => {
                                      flushSync(() => setSettings(DEFAULT_SETTINGS));
                                    });
                                    setApiKeys({});
                                    searchSettingsRef.current = DEFAULT_SEARCH_SETTINGS;
                                    setSearchSettings(DEFAULT_SEARCH_SETTINGS);
                                    imageSettingsRef.current = DEFAULT_IMAGE_SETTINGS;
                                    setImageSettings(DEFAULT_IMAGE_SETTINGS);
                                    videoSettingsRef.current = DEFAULT_VIDEO_SETTINGS;
                                    setVideoSettings(DEFAULT_VIDEO_SETTINGS);
                                    liveApiKeysRef.current = {};
                                    setLiveApiKeys({});
                                    setModelOverrides({});
                                    setModelCatalog({});
                                    setModelEntries([]);
                                    setModelApiKeys({});
                                    setModelThinkingCapabilities({});
                                    providerBaseURLDirtyRef.current = true;
                                    setProviderBaseURLs({});
                                    setContextChatOverrides({});
                                    setSelectedApiProviderValue('gemini');
                                    setSelectedApiModelValue('');
                                    setApiSyncStatus('idle');
                                    setApiSyncMessage('Add a provider key to activate the local runtime gateway.');
                                    setApiProviderStatus([]);
                                    setModelDirectory({});
                                    setModelDirectoryStatus('idle');
                                    setModelDirectoryUpdatedAt(null);
                                    broadcastEterxSettingsUpdate(DEFAULT_SETTINGS);
                                    setHasChanges(false);
                                    void (async () => {
                                      try {
                                        await (window as any)?.electronAPI?.clearSecureRuntimeSettings?.();
                                        await fetch('/api/settings/runtime', { method: 'DELETE' });
                                        await fetch('/api/settings/keys', {
                                          method: 'POST',
                                          headers: { 'Content-Type': 'application/json' },
                                          body: JSON.stringify({ apiKeys: {}, modelOverrides: {}, baseURLs: {} }),
                                        });
                                      } catch (error) {
                                        console.warn('Could not clear runtime credentials:', error);
                                      }
                                    })();
                                  }
                                }}
                                className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-[12px] font-medium text-red-400 transition-colors hover:bg-red-500/20"
                              >
                                Clear data
                              </button>
                            </SettingsStackRow>
                            <SettingsStackRow title="Export all settings" description="Download the complete local configuration as a JSON file.">
                              <SoftButton
                                onClick={() => {
                                  const data = JSON.stringify({
                                    settings,
                                    modelOverrides,
                                    modelCatalog,
                                    modelEntries,
                                    note: 'API keys are intentionally excluded from exports. Re-enter them in Settings on the destination machine.',
                                  }, null, 2);
                                  const blob = new Blob([data], { type: 'application/json' });
                                  const url = URL.createObjectURL(blob);
                                  const a = document.createElement('a');
                                  a.href = url; a.download = 'eterx-settings.json'; a.click();
                                  URL.revokeObjectURL(url);
                                }}
                              >
                                Export
                              </SoftButton>
                            </SettingsStackRow>
                          </SettingsStack>
                        </div>
                      )}

                      {/* ═══ UPDATES TAB ═══ */}
                      {activeTab === 'updates' && (
                        <div>
                          <SectionHeader title="Application updates" />
                          <div className="mb-5 rounded-xl border border-white/[0.07] bg-white/[0.025] p-5">
                            <div className="flex items-start justify-between gap-5">
                              <div>
                                <div className="text-[15px] font-semibold text-[#F1F1F1]">EterX {updateState.currentVersion}</div>
                                <div className={`mt-1.5 text-[13px] leading-relaxed ${updateState.status === 'error' ? 'text-red-400' : 'text-[#9A9A9A]'}`}>
                                  {updateState.message}
                                </div>
                              </div>
                              <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                                updateState.status === 'ready' || updateState.status === 'installing' ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400' :
                                updateState.status === 'error' ? 'border-red-500/25 bg-red-500/10 text-red-400' :
                                'border-white/[0.08] bg-white/[0.04] text-[#B8B8B8]'
                              }`}>
                                {updateState.status === 'current' ? 'Up to date' :
                                  updateState.status === 'ready' ? 'Ready' :
                                  updateState.status === 'installing' ? 'Installing' :
                                  updateState.status.charAt(0).toUpperCase() + updateState.status.slice(1)}
                              </span>
                            </div>

                            <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#666]">
                              <span>{updateState.updateHost || 'GitHub Releases'}</span>
                              <span aria-hidden="true">|</span>
                              <span>{updateState.platform === 'win32' ? 'Windows' : updateState.platform === 'darwin' ? 'macOS' : updateState.platform === 'linux' ? 'Linux' : 'Desktop'} {updateState.architecture || ''}</span>
                              {updateState.packageType && <><span aria-hidden="true">|</span><span>{updateState.packageType}</span></>}
                              <span aria-hidden="true">|</span>
                              <span>{updateState.automaticChecks === false ? 'Manual checks' : 'Silent automatic checks'}</span>
                            </div>

                            {(updateState.status === 'downloading' || updateState.status === 'ready' || updateState.status === 'installing' || (
                              updateState.status === 'error' && Boolean(updateState.availableVersion) && updateState.percent > 0
                            )) && (
                              <div className="mt-5">
                                <div className="mb-2 flex justify-between text-[11px] text-[#777]">
                                  <span>{updateState.availableVersion ? `Version ${updateState.availableVersion}` : 'Update package'}</span>
                                  <span>{Math.round(updateState.percent)}%</span>
                                </div>
                                <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                                  <div className="h-full rounded-full bg-[#D9D9D9] transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, updateState.percent))}%` }} />
                                </div>
                                {Boolean(updateState.transferred || updateState.total || updateState.bytesPerSecond) && (
                                  <div className="mt-2 flex justify-between text-[11px] text-[#5E5E5E]">
                                    <span>{formatUpdateBytes(updateState.transferred)}{updateState.total ? ` / ${formatUpdateBytes(updateState.total)}` : ''}</span>
                                    <span>{updateState.bytesPerSecond ? `${formatUpdateBytes(updateState.bytesPerSecond)}/s` : updateState.status === 'ready' || updateState.status === 'installing' ? 'Download verified' : ''}</span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>

                          <div className="flex gap-3">
                            {updateState.status === 'installing' ? (
                              <SoftButton disabled>Installing...</SoftButton>
                            ) : updateState.status === 'ready' || (
                              updateState.status === 'error' && Boolean(updateState.availableVersion) && updateState.downloadReady
                            ) ? (
                              <SoftButton onClick={() => void (window as any)?.electronAPI?.installUpdate?.()}>
                                {updateState.status === 'error' ? 'Retry restart and update' : 'Restart to update'}
                              </SoftButton>
                            ) : updateState.status === 'available' || (
                              updateState.status === 'error' && Boolean(updateState.availableVersion) && !updateState.downloadReady
                            ) ? (
                              <SoftButton onClick={() => void (window as any)?.electronAPI?.downloadUpdate?.()}>
                                {updateState.status === 'error' ? 'Retry download' : `Download EterX ${updateState.availableVersion}`}
                              </SoftButton>
                            ) : (
                              <SoftButton
                                disabled={updateState.status === 'checking' || updateState.status === 'downloading' || updateState.status === 'development' || updateState.status === 'unsupported'}
                                onClick={() => void (window as any)?.electronAPI?.checkForUpdates?.()}
                              >
                                {updateState.status === 'checking' ? 'Checking…' : updateState.status === 'downloading' ? 'Downloading…' : updateState.status === 'unsupported' ? 'Updates unavailable' : 'Check for updates'}
                              </SoftButton>
                            )}
                            {(updateState.status === 'error' || updateState.status === 'unsupported') && updateState.releasePage && (
                              <SoftButton onClick={() => void (window as any)?.electronAPI?.openExternal?.(updateState.releasePage)}>
                                Open official releases
                              </SoftButton>
                            )}
                          </div>

                          <p className="mt-5 text-[12px] leading-relaxed text-[#666]">
                            EterX checks silently when the app opens, becomes visible again, and every 30 minutes while it remains open. Checks stop while EterX is closed or hidden. An update replaces the complete installed application—including the interface and internal runtime—while chats, workspaces, encrypted API settings, browser profiles, and preferences stay in the device data directory. Downloads and restart remain under your control. Linux in-app updates use the official AppImage package.
                          </p>
                          {updateState.releaseDate && updateState.availableVersion && (
                            <p className="mt-2 text-[11px] text-[#555]">
                              Release {updateState.releaseName || `EterX ${updateState.availableVersion}`} published {new Date(updateState.releaseDate).toLocaleString()}
                            </p>
                          )}
                          {updateState.lastCheckedAt && (
                            <p className="mt-2 text-[11px] text-[#555]">
                              Last checked {new Date(updateState.lastCheckedAt).toLocaleString()}
                            </p>
                          )}
                        </div>
                      )}

                      {/* ═══ ACCOUNT TAB ═══ */}
                      {false && activeTab === 'profile' && (
                        <div>
                          <SectionHeader title="Profile" />
                          <div className="bg-white/[0.02] rounded-xl border border-white/[0.05] p-5 flex items-center gap-4 mb-4">
                            <div className="w-14 h-14 rounded-full bg-[#2B2B2B] flex items-center justify-center text-[#E8E6E3] font-bold text-xl border border-white/10 shadow-none shrink-0">
                              {settings.userName?.charAt(0).toUpperCase() || 'U'}
                            </div>
                            <div className="flex-1 min-w-0">
                              <input
                                value={settings.userName || ''}
                                onChange={(e) => updateSetting('userName', e.target.value)}
                                className="bg-transparent border-b border-white/[0.1] focus:border-white/25 outline-none text-[15px] font-semibold text-[#E8E6E3] w-full pb-0.5 mb-1 transition-colors"
                              />
                              <div className="text-[12px] text-[#666] mt-0.5">Local workspace / Desktop Agent</div>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="px-2.5 py-1 bg-emerald-500/10 text-emerald-400 rounded-full text-[11px] font-medium border border-emerald-500/20">
                                Active
                              </span>
                            </div>
                          </div>

                          <SectionHeader title="Usage" />
                          <div className="grid grid-cols-2 gap-3 mb-4">
                            <div className="bg-white/[0.02] rounded-xl border border-white/[0.05] p-4">
                              <div className="text-[11px] text-[#555] tracking-wider mb-1">Total chats</div>
                              <div className="text-[24px] font-bold text-[#E8E6E3]">
                                {tokenChats.length}
                              </div>
                            </div>
                            <div className="bg-white/[0.02] rounded-xl border border-white/[0.05] p-4">
                              <div className="text-[11px] text-[#555] tracking-wider mb-1">API keys</div>
                              <div className="text-[24px] font-bold text-[#E8E6E3]">{Object.values(apiKeys).filter(Boolean).length}</div>
                            </div>
                          </div>

                        </div>
                      )}

                  </div>
                </div>

                {/* Footer save indicator */}
                <AnimatePresence>
                  {hasChanges && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className="px-6 py-3 border-t border-white/[0.06] flex items-center justify-between shrink-0"
                    >
                      <span className="text-[12px] text-[#555] flex items-center gap-2">
                        <Check className="w-3.5 h-3.5 text-emerald-400" /> All changes saved automatically
                      </span>
                      <button
                        onClick={() => setShowResetConfirm(true)}
                        className="text-[12px] text-[#666] hover:text-[#E8E6E3] transition-colors"
                      >
                        Reset to defaults
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              </div>
              
              <AnimatePresence>
                {showResetConfirm && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-[6px] p-4 pointer-events-auto"
                  >
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95, y: 10 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95, y: 10 }}
                      transition={{ duration: 0.2, ease: "easeOut" }}
                      className={`w-full max-w-[340px] rounded-2xl border p-6 text-center shadow-none ${
                        settings.theme === 'light'
                          ? 'border-black/5 bg-[#FDFDFD] text-[#1F1F1D]'
                          : 'border-white/10 bg-[#1A1A1A]/95 text-white'
                      }`}
                    >
                      <h4 className={`text-[17px] font-semibold mb-2 ${settings.theme === 'light' ? 'text-[#1F1F1D]' : 'text-white'}`}>Reset to defaults</h4>
                      <p className={`text-[13.5px] leading-relaxed mb-6 ${settings.theme === 'light' ? 'text-[#706F6C]' : 'text-[#A5A5A5]'}`}>Are you sure you want to reset all settings to their default values?</p>
                      <div className="flex gap-3 justify-center">
                        <button
                          type="button"
                          onClick={() => setShowResetConfirm(false)}
                          className={`flex-1 h-9 rounded-xl border font-medium text-[13px] transition-colors ${
                            settings.theme === 'light'
                              ? 'border-black/[0.08] hover:bg-black/[0.035] active:bg-black/[0.06] text-[#605E5B]'
                              : 'border-white/[0.08] hover:bg-white/[0.06] active:bg-white/[0.1] text-white/80'
                          }`}
                        >
                          Close
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            settingsRevisionRef.current += 1;
                            transitionEterxTheme(DEFAULT_SETTINGS.theme, () => {
                              flushSync(() => setSettings(DEFAULT_SETTINGS));
                            });
                            appStorage.setItem('eterx_settings', JSON.stringify(DEFAULT_SETTINGS));
                            broadcastEterxSettingsUpdate(DEFAULT_SETTINGS);
                            void fetch('/api/settings/self-improvement', {
                              method: 'PUT',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ enabled: DEFAULT_SETTINGS.selfImprovementEnabled }),
                            }).catch(() => undefined);
                            setHasChanges(false);
                            setShowResetConfirm(false);
                          }}
                          className="flex-1 h-9 rounded-xl bg-[#E2765A] hover:bg-[#D66548] active:bg-[#C95438] text-white font-medium text-[13px] transition-colors shadow-none"
                        >
                          Confirm
                        </button>
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isOpen && manualOpen && <UserManualOverlay onClose={() => setManualOpen(false)} />}
      </AnimatePresence>

      <AnimatePresence>
        {showBatmanEgg && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 1 } }}
            className="fixed inset-0 z-[100000] pointer-events-none flex items-center justify-center overflow-hidden"
          >
            {/* Chaotic rising black fumes/smog - OPTIMIZED */}
            {Array.from({ length: 8 }).map((_, i) => (
              <motion.div
                key={i}
                initial={{
                  opacity: 0,
                  scale: 0.5,
                  x: `${ (Math.random() - 0.5) * 100 }vw`,
                  y: '120vh'
                }}
                animate={{
                  opacity: [0, 1, 1],
                  scale: [1, 3, 6],
                  x: `${ (Math.random() - 0.5) * 40 }vw`,
                  y: '-80vh'
                }}
                transition={{
                  duration: 1.8 + Math.random() * 1.2,
                  delay: 0.7 + Math.random() * 0.3,
                  ease: "easeIn"
                }}
                className="absolute w-[60vh] h-[60vh] rounded-full z-10"
                style={{
                  background: 'radial-gradient(circle at center, #020202 0%, transparent 70%)',
                  willChange: 'transform, opacity'
                }}
              />
            ))}

            {/* Solid pitch black fallback that swallows the screen fully towards the end */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 1.4 }}
              className="absolute inset-0 bg-[#020202] z-0"
            />

            {/* The Text Reveal */}
            <motion.div
              className="relative z-20 text-center flex flex-col items-center justify-center pt-10"
            >
              <motion.h1
                initial={{ opacity: 0, scale: 0.9, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 1.5, ease: "easeOut" }}
                className="text-[45px] md:text-[80px] font-black italic tracking-tighter text-white drop-shadow-none uppercase leading-tight"
                style={{ WebkitTextStroke: '1px black' }}
              >
                {eggQuotes[eggQuoteIndex].line1}
              </motion.h1>
              <motion.p
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 2.8, ease: "easeOut" }}
                className="text-[25px] md:text-[40px] font-black text-[#FF1A1A] uppercase tracking-[0.2em] mt-4 drop-shadow-none mix-blend-screen"
                style={{ textShadow: "0 0 15px red, 0 0 40px darkred, 0 0 60px black" }}
              >
                {eggQuotes[eggQuoteIndex].line2}
              </motion.p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>,
    document.body
  );
});
