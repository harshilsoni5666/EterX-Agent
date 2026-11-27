'use client';
import { formatModelName } from '../../lib/agent/model-presentation';
import { requestJson } from '../../lib/request-json';
import { isDesktopTelemetryRenderer, resolveTelemetryEnabled } from '../../lib/telemetry/preference';
import { yieldToMainThread } from '../../lib/yield-to-main';
import { DEFAULT_GIT_PREFERENCES, normalizeGitPreferences } from '../../lib/git/preferences';
import { DEFAULT_SCRATCH_RETENTION_DAYS, normalizeScratchRetention } from '../../lib/managed-workspaces';
import { DEFAULT_APPEARANCE, normalizeAppearancePreferences, type AppearancePreferences } from '../../lib/appearance-preferences';
import type { ChatScope } from '../../lib/chat-scope';
import type { WorkspaceSource } from '../ui/workspace-avatar';
import { ScratchRetentionControl } from './scratch-retention-control';
import { WorkspaceFolderSettings } from './workspace-folder-settings';
import { ContrastControl, DiffPalettePicker } from './diff-appearance-controls';
import appearanceStyles from './appearance-controls.module.css';
import settingsPanelStyles from './settings-panel.module.css';
import {
  hasDiscoveredModelCatalog, invalidateProviderModelCatalog, isModelCatalogStorageKey,
  PROVIDER_BASE_URLS_STORAGE_KEY, readAvailableModelEntries, readSavedModelEntries, refreshSavedModelCatalog,
} from '../../lib/model-catalog-client';
import { useDesktopUpdates } from '../../lib/desktop-updates';
import { UpdateWhatsNew } from '../updates/release-notes';
import { ProviderIconAsset } from '../ui/provider-icon';
import { AgentToolsSettings } from './agent-tools-settings';
import { ComputerUseSettings } from './computer-use-settings';
import { ConnectionsSettings } from './connections-settings';
import { MicrophoneSettings } from './microphone-settings';
import { SettingsProfile } from './settings-profile';
import { SubscriptionProviders } from './subscription-providers';
import { getDesktopSubscription } from '../../lib/chatgpt-subscription-client';
import { subscriptionModelLabel, withSubscriptionModels } from '../../lib/subscription-models-client';
import { ModelBadges } from '../updates/model-badges';
import { disconnectAntigravityAccounts } from '../../lib/antigravity-client';
import { clearNativeProviderAccounts } from '../../lib/native-provider-client';
import { NATIVE_PROVIDERS } from '../../lib/native-provider-contract';
import { MODEL_FAST_PREFERENCES_KEY } from '../../lib/model-fast-preferences';
import { TokenUsageRowsSkeleton } from './settings-usage-skeleton';
import { ImportSettings } from './import-settings';
import { SettingsSearch, type SettingsSearchTabInfo } from './settings-search';
import { SETTINGS_TAB_HEADING, type SettingsSearchResult, type SettingsSearchTab } from './settings-search-index';
import searchStyles from './settings-search.module.css';
import themePreviewStyles from './theme-preview.module.css';
import { buildProfileActivity, EMPTY_PROFILE_ACTIVITY, type ProfileActivityStats } from '../../lib/profile-activity';
import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { MAIN_AGENT_MODEL_OPTIONS, type MainAgentMode, type MainAgentProvider } from '../../lib/agent/model-routing';
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
  type SubscriptionProvider,
  modelEntryKey,
  parseModelEntryKey,
  type ModelSelectorEntry,
} from '../../lib/agent/model-selector-store';
import {
  SlidersHorizontal,
  CircleUserRound,
  Palette,
  ShieldCheck,
  Wand2,
  Plug,
  Coins,
  BookText,
  BadgeCheck,
  Key,
  Mic,
  Cable,
  SquareTerminal,
  Globe,
  LaptopMinimal,
  Link2,
  RefreshCw,
  SquareCheck,
  Sparkle,
  Users,
  ArrowDownToLine,
  ArrowUp,
  PanelRight,
  Sun,
  Moon,
} from 'lucide-react';
import { transitionEterxTheme, broadcastEterxSettingsUpdate } from '../theme/theme-bridge';
import { appStorage, appStorageReady, isAppStorageLoaded, registerDurableFlush, FOLDER_STORAGE_READY_EVENT } from '../../lib/client-storage';
import { isLocalModelProvider, normalizeProviderBaseURL } from '../../lib/agent/provider-runtime';
import { isAppVisible, subscribeAppVisibility } from '../../lib/app-visibility';
import { resolveModelContextWindow } from '../../lib/agent/model-context-window';
import { readContextUsageMeter } from '../../lib/context-usage-meter';
import { contextMeasurementModel } from '../../lib/context-usage-snapshot';
import { readModelUsage, uniqueModelUsageLogs } from '../../lib/model-usage';
import { selectMainContextLogs } from '../../lib/chat-usage-scope';
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
import { getLiveVoiceOptions, getSystemLiveVoiceOptions } from '../../lib/live/voice-catalog';
import { getGeminiLiveThinkingLevels } from '../../lib/live/gemini-live-contract';
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
export interface AppSettings extends AppearancePreferences {
  // General
  theme: 'dark' | 'light' | 'system';
  userName: string;
  customInstructions: string;
  fontSize: 'compact' | 'default' | 'comfortable';
  workMode: 'specialist' | 'everyday';
  openDestination: 'eterx' | 'workspace' | 'last';
  scratchRetentionDays: number;
  terminalShell: 'auto' | 'powershell' | 'cmd' | 'git-bash' | 'wsl' | 'zsh' | 'bash' | 'fish' | 'sh';
  selfImprovementEnabled: boolean;
  requireCtrlEnter: boolean;
  followUpBehavior: 'queue' | 'steer';
  showThinkingInContainer: boolean;
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
  autoOpenWorkPanelOnSubAgentSpawn: boolean;
  maxSubAgents: number;
  memoryHydration: boolean;
  synapseGraphEnabled: boolean;
  groundingSearch: boolean;
  streamResponses: boolean;
  maxRetries: number;
  alwaysFullAccess: boolean;
  autoReview: boolean;
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
  gitWorkspaceEnabled: boolean;
  gitAutoDetect: boolean;
  gitBranchPrefix: string;
  gitConfirmPush: boolean;
  gitMergeMethod: 'merge' | 'squash';
  showPrStatus: boolean;
  isolatedEnvironments: boolean;
  worktreesEnabled: boolean;
  browserAccess: boolean;
  computerUse: boolean;
  showTokenCount: boolean;
  archiveRetention: '30' | '90' | 'forever';

  // Local microphone dictation
  dictationModel: string;
  dictationLanguage: string;
  microphoneDeviceId: string;

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
  ...DEFAULT_APPEARANCE,
  theme: 'dark',
  userName: 'Developer',
  customInstructions: '',
  fontSize: 'default',
  workMode: 'everyday',
  openDestination: 'eterx',
  scratchRetentionDays: DEFAULT_SCRATCH_RETENTION_DAYS,
  terminalShell: 'auto',
  selfImprovementEnabled: true,
  requireCtrlEnter: false,
  followUpBehavior: 'steer',
  showThinkingInContainer: true,
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
  autoOpenWorkPanelOnSubAgentSpawn: true,
  maxSubAgents: 5,
  memoryHydration: true,
  synapseGraphEnabled: false,
  groundingSearch: true,
  streamResponses: true,
  maxRetries: 0,
  alwaysFullAccess: false,
  autoReview: true,
  shellIntegration: true,
  autoOpenEditedFiles: true,
  contextCompactionEnabled: true,
  contextCompactionModelSelection: AUTO_MODEL_SELECTION,
  contextCompactionInstructions: '',
  contextWindowSizeSelection: 'model_max',
  contextWindowSizeSelectionTouched: false,
  debugMode: false,
  telemetry: isDesktopTelemetryRenderer(),
  experimentalFeatures: false,
  keyboardShortcuts: true,
  mcpServersEnabled: true,
  hooksEnabled: false,
  ...DEFAULT_GIT_PREFERENCES,
  showPrStatus: false,
  isolatedEnvironments: true,
  worktreesEnabled: false,
  browserAccess: true,
  computerUse: false,
  showTokenCount: true,
  archiveRetention: '90',
  dictationModel: 'large-v3-q5_0',
  dictationLanguage: 'auto',
  microphoneDeviceId: 'default',
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
  const next = { ...DEFAULT_SETTINGS, ...stored, ...normalizeAppearancePreferences(stored) } as AppSettings;
  next.telemetry = resolveTelemetryEnabled(stored.telemetry, DEFAULT_SETTINGS.telemetry);
  Object.assign(next, normalizeGitPreferences(stored));
  next.dictationModel = typeof stored.dictationModel === 'string' && stored.dictationModel.trim()
    ? stored.dictationModel : DEFAULT_SETTINGS.dictationModel;
  next.dictationLanguage = typeof stored.dictationLanguage === 'string' && /^(auto|[a-z]{2,3})$/.test(stored.dictationLanguage)
    ? stored.dictationLanguage : 'auto';
  next.microphoneDeviceId = typeof stored.microphoneDeviceId === 'string' && stored.microphoneDeviceId.trim()
    ? stored.microphoneDeviceId : 'default';
  next.scratchRetentionDays = normalizeScratchRetention(stored.scratchRetentionDays);
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
  next.autoOpenWorkPanelOnSubAgentSpawn = stored.autoOpenWorkPanelOnSubAgentSpawn !== false;
  next.alwaysFullAccess = stored.alwaysFullAccess === true;
  next.showTokenCount = stored.showTokenCount !== false;
  next.showThinkingInContainer = stored.showThinkingInContainer !== false;
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
      { value: 'sh', label: 'POSIX shell (sh)' },
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

type Tab = SettingsSearchTab | 'shortcuts' | 'hooks' | 'worktrees' | 'archives';

const SETTINGS_TABS: readonly SettingsSearchTabInfo[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'profile', label: 'Profile', icon: CircleUserRound },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'import', label: 'Import', icon: ArrowDownToLine },
  { id: 'configuration', label: 'Configuration', icon: ShieldCheck },
  { id: 'agents', label: 'Agents', icon: Users },
  { id: 'personalization', label: 'Personalization', icon: Wand2 },
  { id: 'mcp', label: 'MCP servers', icon: Plug },
  { id: 'tokens', label: 'Tokens', icon: Coins },
  { id: 'context', label: 'Context', icon: BookText },
  { id: 'subscription', label: 'Subscription', icon: BadgeCheck },
  { id: 'api', label: 'API', icon: Key },
  { id: 'live-convo', label: 'Live Convo', icon: Mic },
  { id: 'git', label: 'Git', icon: Cable },
  { id: 'environments', label: 'Environments', icon: SquareTerminal },
  { id: 'connections', label: 'Connections', icon: Link2 },
  { id: 'browser', label: 'External service', icon: Globe },
  { id: 'computer', label: 'Computer use', icon: LaptopMinimal },
  { id: 'updates', label: 'Updates', icon: RefreshCw },
];

type LegacyTab = 'agent' | 'advanced' | 'account' | 'models';

type ApiProviderStatus = {
  provider: string;
  accepted: boolean;
  count: number;
  reason?: string;
};

type ModelOverrides = Record<string, string>;
type LiveModelOption = { value: string; label: string; tag?: string; description?: string };
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
const PROVIDER_ACCENT: Record<string, string> = {
  gemini: 'text-zinc-200 border-white/[0.10] bg-white/[0.045]',
  mistral: 'text-zinc-200 border-white/[0.10] bg-white/[0.045]',
  openai: 'text-zinc-200 border-white/[0.10] bg-white/[0.045]',
  openrouter: 'text-zinc-200 border-white/[0.10] bg-white/[0.045]',
  groq: 'text-zinc-200 border-white/[0.10] bg-white/[0.045]',
  anthropic: 'text-zinc-200 border-white/[0.10] bg-white/[0.045]',
};

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: Tab | LegacyTab;
  initialSubscriptionProvider?: SubscriptionProvider;
  onTabChange?: (tab: Tab) => void;
  onOpenDevices?: () => void;
  workspaceSources?: readonly WorkspaceSource[];
  workspaceScope?: ChatScope;
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

type TokenUsageStatus = 'loading' | 'ready' | 'error' | 'refresh-error';

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

const EMPTY_STORED_TOKEN_METRICS: StoredTokenMetrics = {
  processedTokens: 0,
  promptTokens: 0,
  cachedTokens: 0,
  uncachedPromptTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  toolUsePromptTokens: 0,
};

const tokenMetricsForStoredLog = (log: any): StoredTokenMetrics =>
  log?.type === 'model_usage' ? readModelUsage(log) : EMPTY_STORED_TOKEN_METRICS;
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

const normalizeSettingsTab = (tab: any): Tab => {
  const validTabs: Tab[] = [
    'agents',
    'import',
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
    'subscription',
    'api',
    'live-convo',
    'git',
    'environments',
    'connections',
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
    case 'models':
    case 'api':
      return 'api';
    case 'live':
    case 'liveconvo':
    case 'live-convo':
      return 'live-convo';
    case 'advanced':
      return 'environments';
    default:
      return validTabs.includes(tab) ? tab : 'general';
  }
};

// ─── Custom Toggle ─────────────────────────────────────
const Toggle: React.FC<{ enabled: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }> = ({ enabled, onChange, disabled, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={enabled}
    aria-label={label ?? (enabled ? 'Enabled' : 'Disabled')}
    disabled={disabled}
    onClick={() => !disabled && onChange(!enabled)}
    className={settingsPanelStyles.toggle}
  >
    <span aria-hidden="true" className={settingsPanelStyles.toggleThumb} />
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
  <div data-danger={danger || undefined} data-settings-search-target={title} tabIndex={-1} className={`eterx-setting-row mb-2 flex items-center justify-between rounded-lg border px-5 py-4 group ${ danger ? 'border-red-500/20 bg-red-500/10' : 'border-white/[0.08] bg-[#202020]' }`}>
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
  <div data-settings-search-target={title} tabIndex={-1} className="flex items-center gap-2 mb-4 mt-10 first:mt-0">
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
  searchTarget?: string;
  description?: string;
  children?: React.ReactNode;
  tall?: boolean;
  info?: string;
}> = ({ title, searchTarget = title, description, children, tall, info }) => (
  <div data-settings-search-target={searchTarget} tabIndex={-1} className={`eterx-settings-stack-row flex ${tall ? 'flex-col items-start gap-3' : 'flex-wrap items-center justify-between gap-x-6 gap-y-3'} border-b border-white/[0.07] px-5 last:border-b-0 ${tall ? 'py-4' : 'py-3.5'}`}>
    <div className={`min-w-0 ${tall ? 'w-full' : 'flex-[1_1_8rem]'}`}>
      <div className="eterx-setting-label flex items-center gap-2 text-[13px] font-medium leading-tight text-[#F1F1F1]">
        <span>{title}</span>
        {info && <InfoHint text={info} />}
      </div>
      {description && <div className="eterx-setting-description mt-1 max-w-full text-[12px] leading-relaxed text-[#A7A7A7] [overflow-wrap:anywhere]">{description}</div>}
    </div>
    {children && <div className={`flex min-w-0 max-w-full flex-wrap ${tall ? 'w-full' : 'shrink-0'} items-center justify-end gap-2 [&>*]:max-w-full`}>{children}</div>}
  </div>
);

const SelectControl: React.FC<{
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  width?: string;
  openUp?: boolean;
}> = ({ value, onChange, options, width = 'w-[240px]', openUp = false }) => (
  <div className={`relative ${width} shrink-0`}>
    <ModernSelect value={value} onChange={onChange} options={options} openUp={openUp} />
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

const ThemeWorkspacePreview: React.FC<{
  theme: 'light' | 'dark';
  split?: boolean;
}> = ({ theme, split = false }) => (
  <span className={`${themePreviewStyles.workspace} ${themePreviewStyles[theme]}${split ? ` ${themePreviewStyles.split}` : ''}`}>
    <span className={themePreviewStyles.sidebar}>
      <span className={themePreviewStyles.brand}>
        <span className={themePreviewStyles.mark}><Sparkle className={themePreviewStyles.icon} /></span>
        <span className={themePreviewStyles.bar} />
      </span>
      <span className={themePreviewStyles.newChat}>
        <Plus className={themePreviewStyles.icon} />
        <span className={themePreviewStyles.bar} />
      </span>
      <span className={themePreviewStyles.recentChats}>
        <span className={themePreviewStyles.activeChat}><span className={themePreviewStyles.bar} /></span>
        <span className={themePreviewStyles.bar} />
        <span className={themePreviewStyles.bar} />
      </span>
    </span>
    <span className={themePreviewStyles.main}>
      <span className={themePreviewStyles.toolbar}>
        <span className={themePreviewStyles.model}><span className={themePreviewStyles.bar} /></span>
        <PanelRight className={themePreviewStyles.icon} />
      </span>
      <span className={themePreviewStyles.conversation}>
        <span className={themePreviewStyles.prompt}>
          <span className={themePreviewStyles.bar} />
          <span className={themePreviewStyles.bar} />
        </span>
        <span className={themePreviewStyles.reply}>
          <span className={themePreviewStyles.mark}><Sparkle className={themePreviewStyles.icon} /></span>
          <span className={themePreviewStyles.replyLines}>
            <span className={themePreviewStyles.bar} />
            <span className={themePreviewStyles.bar} />
            <span className={themePreviewStyles.bar} />
          </span>
        </span>
      </span>
      <span className={themePreviewStyles.composer}>
        <span className={themePreviewStyles.bar} />
        <span className={themePreviewStyles.send}><ArrowUp className={themePreviewStyles.icon} /></span>
      </span>
    </span>
  </span>
);

const ThemePreviewSelector: React.FC<{
  value: AppSettings['theme'];
  onChange: (value: AppSettings['theme']) => void;
}> = ({ value, onChange }) => {
  const options = [
    { value: 'system', label: 'System', icon: LaptopMinimal },
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
  ] as const;

  return (
    <div className={themePreviewStyles.selector} role="group" aria-label="Theme">
      <div className={themePreviewStyles.options}>
        {options.map(({ value: theme, label, icon: Icon }) => {
          const selected = value === theme;
          return (
            <button
              key={theme}
              type="button"
              aria-pressed={selected}
              aria-label={`Use ${label.toLowerCase()} theme`}
              onClick={() => onChange(theme)}
              className={themePreviewStyles.option}
            >
              <span className={themePreviewStyles.thumbnail} aria-hidden="true">
                <ThemeWorkspacePreview theme={theme === 'dark' ? 'dark' : 'light'} />
                {theme === 'system' && <ThemeWorkspacePreview theme="dark" split />}
              </span>
              <span className={themePreviewStyles.label}>
                <span className={themePreviewStyles.labelText}>
                  <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
                  {label}
                </span>
                {selected && (
                  <span className={themePreviewStyles.selectionMark} aria-hidden="true">
                    <Check />
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
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
      const res = await requestJson(testEndpoint || '/api/settings/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(testEndpoint
            ? (testBody ? testBody(key.trim()) : { provider, key: key.trim(), baseURL: testBaseURL || '' })
            : { apiKeys: { [provider]: key.trim() }, providers: [provider], replaceRuntimeKeys: true, ...(testBaseURL ? { baseURLs: { [provider]: testBaseURL } } : {}) })
        }),
      });
      const data = await res.json();
      if (revision !== keyRowsRevision.current) return;
      if (res.ok && data?.ok && (testEndpoint
        ? data?.connected !== false && (data?.provider === provider || data?.provider === testProvider)
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
    <div className="w-full max-w-[520px] space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#171717] px-3 py-2">
        <div className="min-w-0 flex-[1_1_10rem]">
          <div className="text-[12px] font-semibold text-[#F1F1F1]">
            <span className="truncate">{providerLabel} pool</span>
          </div>
          <div className="mt-1 text-[11px] text-[#8F8F8F]">
            Drag rows to set priority. Valid keys sync to the local gateway in real time.
          </div>
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
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

      <div className={`${hasScroll ? 'max-h-[360px] overflow-x-hidden overflow-y-auto pr-1 eterx-scrollbar' : ''} space-y-2`}>
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
                      ? 'border-[var(--border)] bg-[var(--secondary)] text-[var(--foreground)]'
                      : 'border-white/[0.08] bg-white/[0.035] text-[#777]'
                }`}>
                  {sentenceCaseLabel(rowStatus)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={row}
                  onChange={(event) => updateRow(index, event.target.value)}
                  onPaste={(event) => { void handleKeyPaste(event, index); }}
                  data-eterx-paste-handler="controlled"
                  type={isVisible ? 'text' : 'password'}
                  spellCheck={false}
                  placeholder={index === 0 ? 'Paste provider API key' : 'Paste another key'}
                  className="h-9 min-w-0 flex-[1_1_8rem] rounded-xl border border-white/[0.08] bg-[#141414] px-3 text-[12px] font-mono text-[#F1F1F1] outline-hidden transition-colors placeholder:text-[#666] focus:border-white/[0.20]"
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

const ProviderMark: React.FC<{ provider: string; className?: string }> = ({ provider, className = '' }) => (
  <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-lg border border-white/[0.08] bg-white/[0.045] ${className}`}>
    <ProviderIconAsset provider={provider} className="h-4 w-4" />
  </span>
);

function observeSettingsScrollEdges(viewport: HTMLElement | null) {
  const frame = viewport?.parentElement;
  if (!viewport || !frame) return;

  let scrollsVertically = false;
  let scrollsHorizontally = false;
  const updateEdges = () => {
    const { clientHeight, clientWidth, scrollHeight, scrollWidth, scrollTop, scrollLeft } = viewport;
    const remainingY = scrollHeight - clientHeight - scrollTop;
    const remainingX = scrollWidth - clientWidth - scrollLeft;
    frame.toggleAttribute('data-fade-top', scrollsVertically && scrollTop > 1);
    frame.toggleAttribute('data-fade-bottom', scrollsVertically && remainingY > 1);
    frame.toggleAttribute('data-fade-left', scrollsHorizontally && scrollLeft > 1);
    frame.toggleAttribute('data-fade-right', scrollsHorizontally && remainingX > 1);
  };
  const updateLayout = () => {
    const { overflowX, overflowY } = getComputedStyle(viewport);
    scrollsVertically = overflowY === 'auto' || overflowY === 'scroll';
    scrollsHorizontally = overflowX === 'auto' || overflowX === 'scroll';
    frame.style.setProperty('--settings-scrollbar-width', `${viewport.offsetWidth - viewport.clientWidth}px`);
    frame.style.setProperty('--settings-scrollbar-height', `${viewport.offsetHeight - viewport.clientHeight}px`);
    updateEdges();
  };

  updateLayout();
  viewport.addEventListener('scroll', updateEdges, { passive: true });
  const observer = new ResizeObserver(updateLayout);
  observer.observe(viewport);
  if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
  return () => {
    observer.disconnect();
    viewport.removeEventListener('scroll', updateEdges);
  };
}

function SettingsScrollList({ children, className, frameClassName = '', enabled = true }: {
  children: React.ReactNode;
  className: string;
  frameClassName?: string;
  enabled?: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => observeSettingsScrollEdges(viewportRef.current), [enabled]);

  return (
    <div className={`eterx-settings-scroll-frame relative flex min-h-0 ${frameClassName}`}>
      <div ref={viewportRef} className={`min-w-0 flex-1 ${enabled ? 'overflow-y-auto eterx-scrollbar' : 'overflow-hidden'} ${className}`}>
        <div className={enabled ? 'flow-root' : 'flow-root h-full'}>{children}</div>
      </div>
    </div>
  );
}

const SETTINGS_DROPDOWN_OPEN_EVENT = 'eterx-settings-dropdown-open';

function ModelOptionLabel({ value, label }: { value: string; label: string }) {
  const model = parseModelEntryKey(value);
  if (!model) return <span className="block truncate">{label}</span>;
  return <span className="eterx-model-name-with-badges">
    <span className="truncate">{label}</span>
    <ModelBadges provider={model.provider} modelId={model.modelId} />
  </span>;
}

function exportModelCatalog() {
  const models = withSubscriptionModels(readAvailableModelEntries()).map(({ provider, modelId }) => ({
    provider, modelId, name: subscriptionModelLabel(provider, modelId) || formatModelName(modelId),
  }));
  const json = JSON.stringify({ schema: 'eterx-model-catalog-v1', models }, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'eterx-model-catalog.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const ModernSelect: React.FC<{
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; tag?: string; description?: string }>;
  placeholder?: string;
  className?: string;
  openUp?: boolean;
}> = ({ value, onChange, options, placeholder = 'Select', className = '', openUp = false }) => {
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
        className={`eterx-settings-select-trigger ${settingsPanelStyles.selectTrigger}`}
      >
        <span className="truncate">{selected?.label || placeholder}</span>
        <ChevronRight className={settingsPanelStyles.selectChevron} />
      </button>
      {open && (
        <div data-open-up={openUp} className={`eterx-settings-select-menu ${settingsPanelStyles.selectMenu} ${settingsPanelStyles.menuSurface}`}>
          {searchable && (
            <div className={settingsPanelStyles.selectSearch}>
              <Search className={settingsPanelStyles.selectSearchIcon} />
              <input
                autoFocus
                value={query}
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Escape') setOpen(false);
                }}
                placeholder={`Search ${options.length} options`}
                className={settingsPanelStyles.selectSearchInput}
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
              className={`eterx-settings-select-option ${settingsPanelStyles.selectOption}`}
            >
              <span className="min-w-0 flex-1">
                <ModelOptionLabel value={option.value} label={option.label} />
                {option.description && (
                  <span className={settingsPanelStyles.selectDescription}>
                    {option.description}
                  </span>
                )}
              </span>
              {value === option.value && <Check className={settingsPanelStyles.selectCheck} />}
            </button>
          ))}
          {visibleOptions.length === 0 && (
            <div className={settingsPanelStyles.selectEmpty}>No matching options</div>
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
        aria-expanded={open}
        className={`eterx-settings-select-trigger ${settingsPanelStyles.selectTrigger}`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <ProviderMark provider={value} />
          <span className="truncate">{label}</span>
        </span>
        <ChevronRight className={settingsPanelStyles.selectChevron} />
      </button>
      {open && (
        <div className={`eterx-settings-select-menu ${settingsPanelStyles.selectMenu} ${settingsPanelStyles.menuSurface}`}>
          {searchable && (
            <div className={settingsPanelStyles.selectSearch}>
              <Search className={settingsPanelStyles.selectSearchIcon} />
              <input
                autoFocus
                value={query}
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Escape') setOpen(false);
                }}
                placeholder={`Search ${providers.length} providers`}
                className={settingsPanelStyles.selectSearchInput}
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
                data-active={value === provider}
                className={`eterx-settings-select-option ${settingsPanelStyles.selectOption}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ProviderMark provider={provider} />
                  <span className="truncate">{PROVIDER_LABEL[provider] || provider}</span>
                </span>
                {value === provider && <Check className={settingsPanelStyles.selectCheck} />}
              </button>
            );
          })}
          {visibleProviders.length === 0 && (
            <div className={settingsPanelStyles.selectEmpty}>No matching providers</div>
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
            {copied ? <Check className="w-3.5 h-3.5 text-white" /> : <Copy className="w-3.5 h-3.5" />}
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
            className="flex-1 bg-[#141414] border border-white/[0.10] rounded-lg px-3 py-2 text-[12px] font-mono text-[#E8E6E3] outline-hidden focus:border-white/25 transition-colors"
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
export const SettingsPanel: React.FC<SettingsPanelProps> = React.memo(({ isOpen, onClose, initialTab = 'general', initialSubscriptionProvider = 'codex', onTabChange, onOpenDevices, workspaceSources, workspaceScope, standalone = false }) => {
  const [activeTab, setActiveTab] = useState<Tab>(normalizeSettingsTab(initialTab));
  const [subscriptionProvider, setSubscriptionProvider] = useState<SubscriptionProvider>(initialSubscriptionProvider);
  const [searchDestination, setSearchDestination] = useState<SettingsSearchResult | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [terminalPlatform, setTerminalPlatform] = useState<'unknown' | 'windows' | 'mac' | 'linux'>('unknown');

  useEffect(() => {
    if (!isOpen) {
      setSearchDestination(null);
      return;
    }
    setActiveTab(normalizeSettingsTab(initialTab));
  }, [initialTab, isOpen]);
  useEffect(() => {
    if (isOpen) setSubscriptionProvider(initialSubscriptionProvider);
  }, [initialSubscriptionProvider, isOpen]);
  const [browserRuntimeStatus, setBrowserRuntimeStatus] = useState<any>(null);
  const [browserRuntimeBusy, setBrowserRuntimeBusy] = useState(false);
  const browserRuntimeBusyRef = useRef(false);
  const browserRuntimeRequestRef = useRef(0);
  const browserRuntimeErrorRef = useRef(false);
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
  const [liveModelOptionsFromApi, setLiveModelOptionsFromApi] = useState<Record<string, LiveModelOption[]>>({});
  const [liveVoiceOptionsFromApi, setLiveVoiceOptionsFromApi] = useState<Record<string, Array<{ value: string; label: string; tag?: string; description?: string }>>>({});
  const [liveCatalogStatus, setLiveCatalogStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [liveCatalogMessage, setLiveCatalogMessage] = useState('Select a provider to load its live catalog.');
  const [modelOverrides, setModelOverrides] = useState<ModelOverrides>({});
  const [modelEntries, setModelEntries] = useState<ModelSelectorEntry[]>([]);
  const [contextChats, setContextChats] = useState<ContextChatSummary[]>([]);
  const [selectedContextChatId, setSelectedContextChatId] = useState('');
  const [activeContextChatId, setActiveContextChatId] = useState('');
  const [contextChatOverrides, setContextChatOverrides] = useState<Record<string, string>>({});
  const [contextChatsLoading, setContextChatsLoading] = useState(false);
  const [tokenStats, setTokenStats] = useState<ProfileActivityStats>(EMPTY_PROFILE_ACTIVITY);
  const [tokenChats, setTokenChats] = useState<TokenChatSummary[]>([]);
  const [tokenUsageStatus, setTokenUsageStatus] = useState<Record<'profile' | 'tokens', TokenUsageStatus>>({ profile: 'loading', tokens: 'loading' });
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
  const [modelApiKeys, setModelApiKeys] = useState<Record<string, string>>({});
  const [providerBaseURLs, setProviderBaseURLs] = useState<Record<string, string>>({});
  const [selectedApiProviderValue, setSelectedApiProviderValue] = useState<MainAgentProvider>('gemini');
  const [selectedApiModelValue, setSelectedApiModelValue] = useState('');
  const [exactModelDraft, setExactModelDraft] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [computerAccessError, setComputerAccessError] = useState('');
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showBatmanEgg] = useState(false);
  const [eggQuoteIndex] = useState(0);
  const [gatewayConfig, setGatewayConfig] = useState<any>(null);
  const [gatewayRunning, setGatewayRunning] = useState(false);
  const apiKeysRef = useRef<Record<string, string>>({});
  const settingsDialogRef = useRef<HTMLDivElement>(null);
  const settingsNavRef = useRef<HTMLElement>(null);
  const settingsBodyRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const searchSettingsRef = useRef<SearchSettings>(DEFAULT_SEARCH_SETTINGS);
  const imageSettingsRef = useRef<ImageSettings>(DEFAULT_IMAGE_SETTINGS);
  const videoSettingsRef = useRef<VideoSettings>(DEFAULT_VIDEO_SETTINGS);
  const liveApiKeysRef = useRef<Record<string, string>>({});
  const modelApiKeysRef = useRef<Record<string, string>>({});
  const modelOverridesRef = useRef<ModelOverrides>({});
  const providerBaseURLsRef = useRef<Record<string, string>>({});
  const runtimeSettingsHydratedRef = useRef(false);
  const settingsRevisionRef = useRef(0);
  const settingsRef = useRef(settings);
  const contextChatOverridesRef = useRef(contextChatOverrides);
  const runtimeSettingsWriteRef = useRef<Promise<unknown>>(Promise.resolve());
  const runtimeSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runtimeSyncPendingRef = useRef<RuntimeSettingsSnapshot | null>(null);
  const runtimeSyncChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const providerBaseURLSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const providerBaseURLSyncChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const providerBaseURLDirtyRef = useRef(false);
  const { updateState, updateActionError, updateActionPending, runUpdateAction, markUpdateViewed } = useDesktopUpdates(isOpen);
  const installResult = updateState.status === 'installing' ? null : updateState.lastInstall;
  const successfulInstallCompletedAt = installResult?.status === 'succeeded' ? installResult.completedAt : undefined;
  const quietUpdateCheck = !updateState.checkErrorVisible && !updateState.availableVersion && (
    updateState.status === 'idle' || updateState.status === 'pending' ||
    (updateState.status === 'error' && Boolean(updateState.checkError))
  );
  apiKeysRef.current = apiKeys;
  settingsRef.current = settings;
  contextChatOverridesRef.current = contextChatOverrides;
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
  const selectedSearchServices = searchSettings.enabledServices[searchSettings.provider] || [...SEARCH_SERVICE_IDS];

  const refreshBrowserRuntimeStatus = useCallback(async () => {
    if (browserRuntimeBusyRef.current) return;
    const requestId = ++browserRuntimeRequestRef.current;
    try {
      const response = await fetch('/api/browser/status', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      const payload = await response.json();
      if (requestId !== browserRuntimeRequestRef.current || browserRuntimeBusyRef.current) return;
      setBrowserRuntimeStatus(payload);
      if (!response.ok || !payload?.success) setBrowserRuntimeMessage(payload?.error || 'Browser status unavailable.');
      else if (!browserRuntimeErrorRef.current) setBrowserRuntimeMessage(payload?.browserAccess === false ? 'Browser control is disabled.' : payload?.signedBrowser ? 'Signed-in browser control is ready.' : payload?.managedBrowser ? 'Isolated browser control is ready.' : payload?.remoteBrowser ? 'Remote browser control is ready.' : payload?.preferredMode === 'managed' ? 'Isolated browser selected. It will open when the agent needs it.' : payload?.signedBrowserReason || 'Choose a browser mode.');
    } catch (error: any) {
      if (requestId !== browserRuntimeRequestRef.current || browserRuntimeBusyRef.current || browserRuntimeErrorRef.current) return;
      setBrowserRuntimeMessage(error?.name === 'TimeoutError' ? 'Browser status check timed out.' : 'Could not reach the browser runtime.');
    }
  }, []);

  const runBrowserRuntimeAction = useCallback(async (action: 'connect_signed' | 'launch_managed' | 'disconnect') => {
    if (browserRuntimeBusyRef.current) return;
    if (action !== 'disconnect' && !settingsRef.current.browserAccess) {
      browserRuntimeErrorRef.current = true;
      setBrowserRuntimeMessage('Enable browser control before connecting a browser.');
      return;
    }
    browserRuntimeBusyRef.current = true;
    browserRuntimeErrorRef.current = false;
    ++browserRuntimeRequestRef.current;
    setBrowserRuntimeBusy(true);
    setBrowserRuntimeMessage(action === 'connect_signed' ? 'Connecting to signed-in browser…' : action === 'launch_managed' ? 'Starting managed browser…' : 'Disconnecting browser…');
    try {
      // Complete a pending access-setting write before asking the server to launch.
      await runtimeSettingsWriteRef.current;
      const response = await fetch('/api/browser/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
        signal: AbortSignal.timeout(65000),
      });
      const payload = await response.json();
      setBrowserRuntimeStatus(payload);
      browserRuntimeErrorRef.current = !response.ok || !payload?.success;
      setBrowserRuntimeMessage(!browserRuntimeErrorRef.current ? payload.message || 'Browser action completed.' : payload?.error || 'Browser action failed.');
    } catch (error: any) {
      browserRuntimeErrorRef.current = true;
      setBrowserRuntimeMessage(error?.name === 'TimeoutError'
        ? 'Browser connection timed out. Refresh status before retrying.'
        : 'Browser action could not be completed.');
    } finally {
      browserRuntimeBusyRef.current = false;
      setBrowserRuntimeBusy(false);
      void refreshBrowserRuntimeStatus();
    }
  }, [refreshBrowserRuntimeStatus]);

  useEffect(() => {
    applyUiDensity(settings.fontSize);
  }, [settings.fontSize]);


  useEffect(() => {
    if (!isOpen || (activeTab !== 'browser' && activeTab !== 'computer')) return;
    let inFlight = false;
    const refreshVisibleStatus = async () => {
      if (!isAppVisible() || inFlight) return;
      inFlight = true;
      try { await refreshBrowserRuntimeStatus(); } finally { inFlight = false; }
    };
    void refreshVisibleStatus();
    const timer = window.setInterval(refreshVisibleStatus, 8000);
    const unsubscribeVisibility = subscribeAppVisibility(refreshVisibleStatus);
    return () => {
      window.clearInterval(timer);
      unsubscribeVisibility();
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
          if (!shells.includes(settingsRef.current.terminalShell)) {
            const next = { ...settingsRef.current, terminalShell: 'auto' as const };
            settingsRef.current = next;
            setSettings(next);
            try {
              const saved = JSON.parse(appStorage.getItem('eterx_settings') || '{}');
              const nextStored = { ...saved, terminalShell: 'auto' };
              appStorage.setItem('eterx_settings', JSON.stringify(nextStored));
              broadcastEterxSettingsUpdate(nextStored);
            } catch { }
          }
        }
      })
      .catch(() => {
        // If the runtime probe is unavailable, keep only the portable auto
        // choice so an unverified shell is never offered or persisted.
        setAvailableTerminalShells(['auto']);
        if (settingsRef.current.terminalShell !== 'auto') {
          const next = { ...settingsRef.current, terminalShell: 'auto' as const };
          settingsRef.current = next;
          setSettings(next);
          try {
            const saved = JSON.parse(appStorage.getItem('eterx_settings') || '{}');
            const nextStored = { ...saved, terminalShell: 'auto' };
            appStorage.setItem('eterx_settings', JSON.stringify(nextStored));
            broadcastEterxSettingsUpdate(nextStored);
          } catch { }
        }
      });
  }, []);

  useEffect(() => {
    if (!availableTerminalShells.length) return;
    setSettings(previous => availableTerminalShells.includes(previous.terminalShell)
      ? previous
      : { ...previous, terminalShell: 'auto' });
  }, [availableTerminalShells]);

  const keysChangedRef = useRef(false);

  useEffect(() => {
    if (!isOpen || activeTab !== 'updates') return;
    markUpdateViewed(successfulInstallCompletedAt);
  }, [activeTab, isOpen, markUpdateViewed, successfulInstallCompletedAt, updateState.availableVersion]);

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
      const computerUse = settingsRef.current.computerUse;
      const writes: Promise<unknown>[] = [
        fetch('/api/settings/runtime', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: { ...snapshot, computerUse, browserAccess: settingsRef.current.browserAccess } }),
          signal: AbortSignal.timeout(10_000),
        }).then(response => {
          if (!response.ok) throw new Error(`Folder runtime settings HTTP ${ response.status }`);
          if (settingsRef.current.computerUse === computerUse) setComputerAccessError('');
        }).catch(error => {
          saved = false;
          if (settingsRef.current.computerUse === computerUse) {
            setComputerAccessError('Desktop access could not be saved. Save settings again; press Escape to stop any active computer use.');
          }
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
    const controller = new AbortController();
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

    const normalizeChats = async (rawChats: any[]): Promise<ContextChatSummary[]> => {
      const summaries: ContextChatSummary[] = [];
      let batchStarted = performance.now();
      for (const chat of rawChats) {
        if (cancelled) return summaries;
        if (!chat || typeof chat.id !== 'string') continue;
        const logs = selectMainContextLogs(Array.isArray(chat.traceLogs) ? chat.traceLogs : [], chat.id);
        const selection = parseModelEntryKey(chat.modelSelection);
        const meter = readContextUsageMeter(logs, '', selection);
        const usage = meter.latestContextUsage;
        const latestModelLog = meter.latestModelLog;
        const measured = latestModelLog?.type === 'context_compaction' && latestModelLog.usage
          ? latestModelLog.usage : latestModelLog;
        const provider = selection?.provider || String(measured?.provider || '');
        const modelId = selection?.modelId || String(measured?.model || measured?.modelId || '');
        const measuredModel = contextMeasurementModel(usage);
        const measuredModelMatches = measuredModel && measuredModel === contextMeasurementModel({ provider, modelId });
        summaries.push({
          id: String(chat.id),
          title: String(chat.title || 'Untitled chat').trim() || 'Untitled chat',
          updatedAt: Number(chat.updatedAt || 0),
          usedTokens: meter.usedTokens,
          reportedWindow: measuredModelMatches ? normalizeContextWindow(meter.contextWindow) : 0,
          modelMaximum: measuredModelMatches ? normalizeContextWindow(usage?.modelContextWindow) : 0,
          provider,
          modelId,
        });
        if (performance.now() - batchStarted >= 8) {
          await yieldToMainThread();
          batchStarted = performance.now();
        }
      }
      return summaries.sort((left, right) => right.updatedAt - left.updatedAt);
    };

    const applyChats = async (rawChats: any[]) => {
      if (cancelled) return;
      const next = await normalizeChats(rawChats);
      if (cancelled) return;
      setContextChats(next);
      setSelectedContextChatId(previous => {
        if (previous && next.some(chat => chat.id === previous)) return previous;
        const currentChatId = appStorage.getItem('eterx_active_chat') || '';
        return next.find(chat => chat.id === currentChatId)?.id || next[0]?.id || '';
      });
    };

    const durableLoad = requestJson('/api/chats', { cache: 'no-store', signal: controller.signal }, 15_000)
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Unable to load chats')));
    Promise.resolve(durableLoad)
      .then(async (snapshot: any) => {
        if (Array.isArray(snapshot?.chats)) await applyChats(snapshot.chats);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setContextChatsLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeTab, isOpen]);

  useEffect(() => {
    if (!isOpen || (activeTab !== 'profile' && activeTab !== 'tokens')) return;
    const usageTab = activeTab;
    let cancelled = false;
    const controller = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshInFlight: Promise<void> | null = null;
    let lastSnapshotText: string | null = null;
    let lastStatisticsDay = '';

    const updateUsageStatus = (getStatus: (previous: TokenUsageStatus) => TokenUsageStatus) => {
      setTokenUsageStatus(previous => {
        const status = getStatus(previous[usageTab]);
        return status === previous[usageTab] ? previous : { ...previous, [usageTab]: status };
      });
    };

    const refreshTokenStats = () => {
      if (cancelled || !isAppVisible()) return;
      if (refreshInFlight) return refreshInFlight;
      refreshInFlight = (async () => {
       if (lastSnapshotText === null) updateUsageStatus(status => status === 'error' ? 'loading' : status);
       try {
      const snapshot = await requestJson('/api/chats', { cache: 'no-store', signal: controller.signal }, 15_000)
        .then(response => response.ok ? response.json() : Promise.reject(new Error('Unable to load chats')));
      if (cancelled || !isAppVisible()) return;
      const snapshotText = JSON.stringify(snapshot);
      const statisticsDay = new Date().toDateString();
      if (cancelled) return;
      if (snapshotText === lastSnapshotText && statisticsDay === lastStatisticsDay) {
        updateUsageStatus(() => 'ready');
        return;
      }
      if (!Array.isArray(snapshot?.chats)) throw new Error('Invalid chat snapshot');
      const chats = snapshot.chats;
      const uniqueProviderUsageLogs = (logs: any[]) => uniqueModelUsageLogs(logs)
        .filter(log => tokenCountForStoredLog(log) > 0);
      const nextTokenChats: TokenChatSummary[] = [];
      let batchStarted = performance.now();
      // Profile uses the activity aggregate; only the Tokens tab needs per-chat rows.
      for (const chat of activeTab === 'tokens' ? chats : []) {
          if (!chat || typeof chat.id !== 'string') continue;
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
          nextTokenChats.push({
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
          });
          if (performance.now() - batchStarted >= 8) {
            await yieldToMainThread();
            if (cancelled || !isAppVisible()) return;
            batchStarted = performance.now();
          }
      }
      await yieldToMainThread();
      if (cancelled || !isAppVisible()) return;
      if (activeTab === 'tokens') {
        nextTokenChats.sort((left, right) => right.updatedAt - left.updatedAt);
        setTokenChats(nextTokenChats);
        setSelectedTokenChatId(previous => previous && nextTokenChats.some(chat => chat.id === previous) ? previous : nextTokenChats[0]?.id || '');
      } else {
        setTokenStats(buildProfileActivity(chats));
      }
      lastSnapshotText = snapshotText;
      lastStatisticsDay = statisticsDay;
      updateUsageStatus(() => 'ready');
       } catch {
         // Keep the last successful snapshot visible during transient API or
         // desktop startup failures instead of replacing real cells with an
         // empty grid.
         if (!cancelled) updateUsageStatus(status => status === 'ready' || status === 'refresh-error' ? 'refresh-error' : 'error');
       } finally {
         refreshInFlight = null;
       }
      })();
      return refreshInFlight;
    };
    const scheduleRefresh = () => {
      if (cancelled || refreshTimer !== undefined || !isAppVisible()) return;
      // Coalesce bursts of chat/settings notifications into one history read.
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refreshTokenStats();
      }, 250);
    };
    void refreshTokenStats();
    const interval = window.setInterval(refreshTokenStats, 5000);
    window.addEventListener('eterx_chats_updated', scheduleRefresh);
    window.addEventListener('eterx-settings-updated', scheduleRefresh);
    const unsubscribeVisibility = subscribeAppVisibility(refreshTokenStats);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(refreshTimer);
      window.clearInterval(interval);
      window.removeEventListener('eterx_chats_updated', scheduleRefresh);
      window.removeEventListener('eterx-settings-updated', scheduleRefresh);
      unsubscribeVisibility();
    };
  }, [activeTab, isOpen]);

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

    } catch (error: any) {
      setApiSyncStatus('error');
      setApiSyncMessage(error?.message || 'Could not sync API keys.');
    }
  }, []);

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
    let loading = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const loadRevision = settingsRevisionRef.current;
    const loadSettings = async () => {
      if (cancelled || loading || runtimeSettingsHydratedRef.current) return;
      loading = true;
      try {
      await appStorageReady;
      // A transient storage failure must never turn an empty in-memory view
      // into a saved empty model/settings snapshot. The storage-ready event
      // below retries synchronization after the durable store recovers.
      if (!isAppStorageLoaded() || cancelled || settingsRevisionRef.current !== loadRevision) return;
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
      const savedProviderBaseURLs = appStorage.getItem(PROVIDER_BASE_URLS_STORAGE_KEY);
      const needsSelectorSchemaMigration = appStorage.getItem(MODEL_SELECTOR_SCHEMA_STORAGE_KEY) !== MODEL_SELECTOR_SCHEMA_VERSION;
      const parsedModelOverrides = savedModelOverrides ? JSON.parse(savedModelOverrides) : {};
      const parsedProviderBaseURLs = savedProviderBaseURLs ? JSON.parse(savedProviderBaseURLs) : {};
      const desktopApi = (window as any)?.electronAPI;
      const folderRuntimeResponse = await fetch('/api/settings/runtime', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      const folderRuntimePayload = await folderRuntimeResponse.json();
      if (!folderRuntimeResponse.ok || !folderRuntimePayload?.ok || !folderRuntimePayload.settings || typeof folderRuntimePayload.settings !== 'object' || Array.isArray(folderRuntimePayload.settings)) {
        throw new Error('Saved runtime settings could not be loaded.');
      }
      const folderRuntimeSettings = folderRuntimePayload.settings;
      const persistedApiRetries = Number(folderRuntimeSettings?.apiRetries);
      if (Number.isFinite(persistedApiRetries)) {
        nextSettings.maxRetries = Math.max(0, Math.min(3, Math.floor(persistedApiRetries)));
      }
      if (typeof folderRuntimeSettings?.computerUse === 'boolean') {
        nextSettings.computerUse = folderRuntimeSettings.computerUse;
      }
      if (typeof folderRuntimeSettings?.browserAccess === 'boolean') {
        nextSettings.browserAccess = folderRuntimeSettings.browserAccess;
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
        : null;
      const folderLiveApiKeys = folderRuntimeSettings?.liveApiKeys && typeof folderRuntimeSettings.liveApiKeys === 'object'
        ? folderRuntimeSettings.liveApiKeys
        : null;
      const folderModelApiKeys = folderRuntimeSettings?.modelApiKeys && typeof folderRuntimeSettings.modelApiKeys === 'object'
        ? folderRuntimeSettings.modelApiKeys
        : null;
      const folderModelOverrides = folderRuntimeSettings?.modelOverrides && typeof folderRuntimeSettings.modelOverrides === 'object'
        ? folderRuntimeSettings.modelOverrides
        : null;
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
      // The OS-encrypted copy is a migration/recovery fallback. Merging it
      // over the current file resurrects removed keys and stale endpoints.
      const parsedApiKeys = folderApiKeys ?? secureApiKeys ?? {};
      const parsedLiveApiKeys = folderLiveApiKeys ?? secureLiveApiKeys ?? {};
      const parsedModelApiKeys = folderModelApiKeys ?? secureModelApiKeys ?? {};
      const effectiveModelOverrides = folderModelOverrides ?? secureModelOverrides ?? parsedModelOverrides;
      const normalizedApiKeys = parsedApiKeys && typeof parsedApiKeys === 'object'
        ? Object.fromEntries(
          Object.entries(parsedApiKeys as Record<string, unknown>)
            .map(([key, value]) => [key, Array.isArray(value) ? value.filter(item => typeof item === 'string').join('\n') : typeof value === 'string' ? value.trim() : ''])
            .filter(([, value]) => Boolean(value)),
        )
        : {};
      const effectiveSearchSource = folderSearchSettings ?? secureSearchSettings ?? {};
      const effectiveSearchSettings = normalizeSearchSettings(
        { ...effectiveSearchSource, enabled: nextSettings.groundingSearch },
        (folderSearchSettings || secureSearchSettings) ? undefined : normalizedApiKeys.tavily,
      );
      const effectiveImageSource = folderImageSettings ?? secureImageSettings ?? {};
      const effectiveImageSettings = normalizeImageSettings(effectiveImageSource);
      const effectiveVideoSettings = normalizeVideoSettings(folderVideoSettings ?? secureVideoSettings ?? {});
      const normalizedLiveApiKeys = parsedLiveApiKeys && typeof parsedLiveApiKeys === 'object'
        ? Object.fromEntries(
          Object.entries(parsedLiveApiKeys as Record<string, unknown>)
            .map(([key, value]) => [key, Array.isArray(value) ? value.filter(item => typeof item === 'string').join('\n') : typeof value === 'string' ? value.trim() : ''])
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
              && isConcreteModelId(model)
              && !isEmbeddedModelLabel(model)
            ),
        )
        : {};
      settingsRef.current = nextSettings;
      setSettings(nextSettings);
      appStorage.setItem('eterx_settings', JSON.stringify(nextSettings));
      setModelApiKeys(normalizedModelApiKeys);
      appStorage.setItem(MODEL_OVERRIDE_STORAGE_KEY, JSON.stringify(normalizedModelOverrides));
      setModelOverrides(normalizedModelOverrides);
      setApiKeys(normalizedApiKeys);
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
      appStorage.setItem(PROVIDER_BASE_URLS_STORAGE_KEY, JSON.stringify(effectiveBaseURLs));
      setProviderBaseURLs(effectiveBaseURLs);

      if (needsSelectorSchemaMigration) {
        const savedEntries = readSavedModelEntries();
        appStorage.setItems({
          [MODEL_SELECTOR_STORAGE_KEY]: JSON.stringify(savedEntries),
          [MODEL_CATALOG_STORAGE_KEY]: JSON.stringify(entriesToModelCatalog(savedEntries)),
        });
      }
      const needsRuntimeConnectionMigration = (folderApiKeys === null && Object.keys(normalizedApiKeys).length > 0)
        || (folderBaseURLs === null && Object.keys(effectiveBaseURLs).length > 0);
      if (needsSelectorSchemaMigration || needsRuntimeConnectionMigration) {
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
        modelEntries: readAvailableModelEntries(),
      }, true);
      runtimeSettingsHydratedRef.current = true;
      void refreshSavedModelCatalog();
      } catch (error) {
        console.warn('Could not load runtime settings:', error);
        if (!cancelled && settingsRevisionRef.current === loadRevision) {
          retryTimer = setTimeout(() => { void loadSettings(); }, 3_000);
        }
      } finally {
        loading = false;
      }
    };
    const retryLoad = () => { void loadSettings(); };
    window.addEventListener(FOLDER_STORAGE_READY_EVENT, retryLoad);
    window.addEventListener('focus', retryLoad);
    void loadSettings();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      window.removeEventListener(FOLDER_STORAGE_READY_EVENT, retryLoad);
      window.removeEventListener('focus', retryLoad);
    };
  }, [persistApiKeyPresence, persistDesktopRuntimeSettings]);

  // Keep an idle Settings panel aligned with another localhost/Electron
  // window. AppData is authoritative; pending edits in this panel are never
  // replaced while the user is actively changing settings.
  useEffect(() => {
    if (hasChanges) return;
    let cancelled = false;
    let loadSequence = 0;
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
      const sequence = ++loadSequence;
      const loadRevision = settingsRevisionRef.current;
      await appStorageReady;
      if (cancelled || hasChanges || providerBaseURLDirtyRef.current || !isAppStorageLoaded() || !runtimeSettingsHydratedRef.current) return;

      const storedSettings = readJson('eterx_settings', {}) as Record<string, unknown>;
      const storedOverrides = normalizeStringMap(readJson(MODEL_OVERRIDE_STORAGE_KEY, {}));
      const storedBaseURLs = normalizeStringMap(readJson(PROVIDER_BASE_URLS_STORAGE_KEY, {}));

      let runtime: any;
      try {
        const response = await fetch('/api/settings/runtime', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
        const payload = await response.json();
        if (!response.ok || !payload?.ok || !payload.settings || typeof payload.settings !== 'object' || Array.isArray(payload.settings)) return;
        runtime = payload.settings;
      } catch { return; }
      const desktopApi = (window as any)?.electronAPI;
      let secure: any = null;
      try {
        secure = typeof desktopApi?.getSecureRuntimeSettings === 'function'
          ? await desktopApi.getSecureRuntimeSettings()
          : null;
      } catch { }
      if (cancelled || hasChanges || sequence !== loadSequence || settingsRevisionRef.current !== loadRevision) return;
      // Use whole fields from the authoritative file, including empty maps.
      // The encrypted backup must not reintroduce deleted credentials.
      runtime = { ...(secure?.available ? secure : {}), ...runtime };
      const runtimeApiKeys = normalizeStringMap(runtime.apiKeys);
      const runtimeLiveApiKeys = normalizeStringMap(runtime.liveApiKeys);
      const runtimeModelApiKeys = normalizeStringMap(runtime.modelApiKeys);
      const runtimeOverrides = normalizeStringMap(runtime.modelOverrides);
      const runtimeBaseURLs = normalizeStringMap(runtime.baseURLs);
      const runtimeSearchSettings = runtime.search || {};
      const runtimeImageSettings = runtime.image || {};
      const runtimeVideoSettings = runtime.video || {};
      const nextSearchSettings = normalizeSearchSettings(
        runtimeSearchSettings,
        (runtime.search || secure?.search) ? undefined : runtimeApiKeys.tavily,
      );
      const nextImageSettings = normalizeImageSettings(runtimeImageSettings);
      const nextVideoSettings = normalizeVideoSettings(runtimeVideoSettings);
      const nextOverrides = runtime.modelOverrides ? runtimeOverrides : storedOverrides;
      const nextBaseURLs = runtime.baseURLs ? runtimeBaseURLs : storedBaseURLs;
      for (const provider of MODEL_PROVIDER_ORDER) {
        if ((apiKeysRef.current[provider] || '') !== (runtimeApiKeys[provider] || '')
          || normalizeProviderBaseURL(provider, providerBaseURLsRef.current[provider]) !== normalizeProviderBaseURL(provider, nextBaseURLs[provider])) {
          invalidateProviderModelCatalog(provider);
        }
      }

      const nextAppSettings = normalizeAppSettings({
        ...settingsRef.current, ...storedSettings,
        ...(typeof runtime.computerUse === 'boolean' ? { computerUse: runtime.computerUse } : {}),
        ...(typeof runtime.browserAccess === 'boolean' ? { browserAccess: runtime.browserAccess } : {}),
      });
      settingsRef.current = nextAppSettings;
      setSettings(nextAppSettings);
      setApiKeys(current => JSON.stringify(current) === JSON.stringify(runtimeApiKeys) ? current : runtimeApiKeys);
      setSearchSettings(current => JSON.stringify(current) === JSON.stringify(nextSearchSettings) ? current : nextSearchSettings);
      setImageSettings(current => JSON.stringify(current) === JSON.stringify(nextImageSettings) ? current : nextImageSettings);
      setVideoSettings(current => JSON.stringify(current) === JSON.stringify(nextVideoSettings) ? current : nextVideoSettings);
      setLiveApiKeys(runtimeLiveApiKeys);
      setModelApiKeys(runtimeModelApiKeys);
      setModelOverrides(current => JSON.stringify(current) === JSON.stringify(nextOverrides) ? current : nextOverrides);
      setProviderBaseURLs(current => JSON.stringify(current) === JSON.stringify(nextBaseURLs) ? current : nextBaseURLs);
      apiKeysRef.current = runtimeApiKeys;
      searchSettingsRef.current = nextSearchSettings;
      imageSettingsRef.current = nextImageSettings;
      videoSettingsRef.current = nextVideoSettings;
      liveApiKeysRef.current = runtimeLiveApiKeys;
      modelApiKeysRef.current = runtimeModelApiKeys;
      modelOverridesRef.current = nextOverrides;
      providerBaseURLsRef.current = nextBaseURLs;
    };
    const onExternalCommit = (event: Event) => {
      const key = (event as CustomEvent).detail?.key;
      if (isModelCatalogStorageKey(key) || [
        MODEL_THINKING_CAPABILITIES_STORAGE_KEY, MODEL_WIRE_CAPABILITIES_STORAGE_KEY, MODEL_CONTEXT_WINDOWS_STORAGE_KEY,
      ].includes(key)) return;
      void syncExternalSettings();
    };
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

  useEffect(() => {
    const modelKeys = new Set([
      API_KEY_PRESENCE_STORAGE_KEY, MODEL_API_KEY_PRESENCE_STORAGE_KEY, MODEL_SELECTOR_STORAGE_KEY,
      MODEL_CATALOG_STORAGE_KEY, PROVIDER_BASE_URLS_STORAGE_KEY, MODEL_CONTEXT_WINDOWS_STORAGE_KEY,
    ]);
    const readModels = (event?: Event) => {
      const key = (event as CustomEvent | undefined)?.detail?.key;
      if (key && !modelKeys.has(key) && !isModelCatalogStorageKey(key)) return;
      setModelEntries(readAvailableModelEntries());
    };
    readModels();
    window.addEventListener(FOLDER_STORAGE_READY_EVENT, readModels);
    window.addEventListener('eterx-folder-storage-updated', readModels);
    return () => {
      window.removeEventListener(FOLDER_STORAGE_READY_EVENT, readModels);
      window.removeEventListener('eterx-folder-storage-updated', readModels);
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

  useEffect(() => {
    if (!runtimeSettingsHydratedRef.current) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      await providerBaseURLSyncChainRef.current;
      const saved = await runtimeSettingsWriteRef.current;
      if (!cancelled && saved !== false) void refreshSavedModelCatalog();
    }, 800);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [apiKeys, providerBaseURLs]);

  const updateProviderBaseURL = (provider: MainAgentProvider, value: string) => {
    settingsRevisionRef.current += 1;
    providerBaseURLDirtyRef.current = true;
    const next = { ...providerBaseURLsRef.current };
    if (value) next[provider] = value;
    else delete next[provider];
    providerBaseURLsRef.current = next;
    invalidateProviderModelCatalog(provider);
    setProviderBaseURLs(next);
  };

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
    // React may evaluate a state updater while rendering. Publish storage and
    // runtime changes from this event handler, never from that updater.
    const commitSetting = () => {
      const safeValue = key === 'followUpBehavior'
        ? (value === 'queue' ? 'queue' : 'steer')
        : value;
      const next = normalizeAppSettings({
        ...settingsRef.current,
        [key]: safeValue,
        ...(key === 'contextWindowSizeSelection' ? { contextWindowSizeSelectionTouched: true } : {}),
      });
      settingsRef.current = next;
      setSettings(next);
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
      if (key === 'browserAccess') {
        const write = async () => {
          const browserAccess = settingsRef.current.browserAccess;
          try {
            const response = await fetch('/api/settings/runtime', {
              method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ settings: { browserAccess } }),
              signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) throw new Error('Browser access could not be saved.');
            if (settingsRef.current.browserAccess === browserAccess) {
              browserRuntimeErrorRef.current = false;
              setBrowserRuntimeMessage(browserAccess ? 'Browser control enabled.' : 'Browser control disabled.');
            }
            return true;
          } catch {
            if (settingsRef.current.browserAccess === browserAccess) {
              browserRuntimeErrorRef.current = true;
              setBrowserRuntimeMessage('Browser access could not be saved. Save settings again before continuing.');
            }
            return false;
          }
        };
        runtimeSettingsWriteRef.current = runtimeSettingsWriteRef.current.then(write, write);
      }
      if (key === 'computerUse') {
        setComputerAccessError('');
        const write = async () => {
          const computerUse = settingsRef.current.computerUse;
          try {
            const response = await fetch('/api/settings/runtime', {
              method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ settings: { computerUse } }),
              signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) throw new Error('Desktop access could not be saved.');
            if (settingsRef.current.computerUse === computerUse) setComputerAccessError('');
            return true;
          } catch (error) {
            if (settingsRef.current.computerUse === computerUse) {
              setComputerAccessError('Desktop access could not be saved. Save settings again; press Escape to stop any active computer use.');
            }
            console.warn('Could not persist desktop access:', error);
            return false;
          }
        };
        runtimeSettingsWriteRef.current = runtimeSettingsWriteRef.current.then(write, write);
      }
    };
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
    const next = { ...contextChatOverridesRef.current };
    if (value === 'global') delete next[selectedContextChatId];
    else next[selectedContextChatId] = value;
    contextChatOverridesRef.current = next;
    setContextChatOverrides(next);
    appStorage.setItem(CHAT_CONTEXT_WINDOW_OVERRIDES_STORAGE_KEY, JSON.stringify(next));
    markContextBudgetEdit(selectedContextChatId);
    broadcastEterxSettingsUpdate({
      type: 'context-window-overrides-updated',
      chatId: selectedContextChatId,
      contextWindowSizeSelection: value,
    });
    setHasChanges(true);
  }, [selectedContextChatId]);

  const handleClose = useCallback(() => {
    void performSync().finally(() => setHasChanges(false));
    onClose();
  }, [performSync, onClose]);

  const openSearchResult = useCallback((result: SettingsSearchResult) => {
    if (result.tab === 'subscription') {
      const provider = NATIVE_PROVIDERS.find(name => result.target.startsWith(name + '-'));
      setSubscriptionProvider(provider ?? (result.target.startsWith('antigravity-') ? 'antigravity' : 'codex'));
    }
    setActiveTab(result.tab);
    setSearchDestination({ ...result });
    onTabChange?.(result.tab);
  }, [onTabChange]);

  const updateApiKey = useCallback((name: string, value: string) => {
    const trimmed = value.trim();
    if (trimmed === (apiKeysRef.current[name] || '')) return;
    settingsRevisionRef.current += 1;
    invalidateProviderModelCatalog(name);
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
          baseURL: imageSettingsRef.current.baseURLs[provider] || '',
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
        body: JSON.stringify({ provider, key: videoSettingsRef.current.apiKeys[provider]?.[0] || '', model: videoSettingsRef.current.modelByProvider[provider] || VIDEO_PROVIDER_META[provider].defaultModel, baseURL: videoSettingsRef.current.baseURLs[provider] || '' }),
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

  useLayoutEffect(() => {
    if (isOpen) return observeSettingsScrollEdges(settingsNavRef.current);
  }, [isOpen]);

  useLayoutEffect(() => {
    if (isOpen) return observeSettingsScrollEdges(settingsBodyRef.current);
  }, [isOpen, activeTab]);

  useLayoutEffect(() => {
    if (!isOpen || !searchDestination || searchDestination.tab !== activeTab) return;
    const body = settingsBodyRef.current;
    if (!body) return;

    const findTarget = (name: string) => body.querySelector<HTMLElement>(
      `[data-settings-search-target="${CSS.escape(name)}"]`,
    );
    const heading = findTarget(SETTINGS_TAB_HEADING);
    const exactTarget = findTarget(searchDestination.target);
    const fallback = searchDestination.fallbackTarget ? findTarget(searchDestination.fallbackTarget) : null;
    const target = exactTarget?.offsetHeight ? exactTarget : fallback || heading;
    if (!target) return;

    if (target === heading) {
      body.scrollTop = 0;
    } else {
      const targetBounds = target.getBoundingClientRect();
      const offset = targetBounds.top - body.getBoundingClientRect().top;
      body.scrollTop += offset - Math.max(12, (body.clientHeight - targetBounds.height) / 2);
      target.dataset.settingsSearchHighlight = 'true';
    }
    target.focus({ preventScroll: true });
    settingsDialogRef.current?.querySelector('.eterx-settings-tab[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    const timeout = window.setTimeout(() => setSearchDestination(null), 2200);
    return () => {
      window.clearTimeout(timeout);
      delete target.dataset.settingsSearchHighlight;
    };
  }, [activeTab, isOpen, searchDestination]);

  // Close on escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented
        && !document.querySelector('[data-import-dialog], [data-subscription-dialog]')) handleClose();
    };
    if (isOpen) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, handleClose]);

  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return;
    previouslyFocusedElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      if (settingsDialogRef.current?.contains(document.activeElement)) return;
      const firstFocusable = settingsDialogRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      firstFocusable?.focus();
    });
    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      if (document.querySelector('[data-import-dialog], [data-subscription-dialog]')) return;
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
  const liveApiKeyProvider = activeLiveProvider.keyProvider;
  const liveApiKeyLabel = activeLiveProvider.label;
  const activeLiveApiKey = liveApiKeys[liveApiKeyProvider] || '';
  const [liveCatalogRefresh, setLiveCatalogRefresh] = useState(0);

  useEffect(() => {
    if (!isOpen || activeTab !== 'live-convo') return;
    if (activeLiveProviderValue === 'model-voice') {
      const loadVoices = () => setLiveVoiceOptionsFromApi(previous => ({
        ...previous, 'model-voice': getSystemLiveVoiceOptions(),
      }));
      loadVoices();
      window.speechSynthesis?.addEventListener('voiceschanged', loadVoices);
      setLiveCatalogStatus('ready');
      setLiveCatalogMessage('Uses models from connected providers. Desktop speech recognition runs locally. Browser speech recognition may use its speech service.');
      return () => window.speechSynthesis?.removeEventListener('voiceschanged', loadVoices);
    }
    const controller = new AbortController();
    const providerValue = activeLiveProviderValue;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLiveCatalogStatus('loading');
      setLiveCatalogMessage('Loading ' + activeLiveProviderLabel + ' models and voices…');
      // An earlier key or agent must never supply choices for a new connection.
      setLiveModelOptionsFromApi(previous => ({ ...previous, [providerValue]: [] }));
      setLiveVoiceOptionsFromApi(previous => ({ ...previous, [providerValue]: [] }));
      const load = async (endpoint: string) => {
        const response = await requestJson(endpoint, {
          signal: controller.signal, method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: providerValue, ...(activeLiveApiKey.trim() ? { key: activeLiveApiKey } : {}),
            agentId: settings.liveConvoAgentId || '', modelId: settings.liveConvoModel || 'auto' }),
        }, 40_000);
        const payload = await response.json();
        if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'Catalog request failed.');
        return payload;
      };
      const [modelResult, voiceResult] = await Promise.allSettled([
        load('/api/live/models').then(payload => {
          if (!cancelled) setLiveModelOptionsFromApi(previous => ({ ...previous,
            [providerValue]: (Array.isArray(payload.models) ? payload.models : []).map((model: any) => ({
              value: String(model.id || '').trim(), label: String(model.name || model.id || '').trim(),
              tag: model.tag || (payload.source === 'live' ? 'LIVE API' : 'CATALOG'),
              description: String(model.description || model.id || ''),
            })).filter((model: LiveModelOption) => model.value),
          }));
          return payload;
        }),
        load('/api/settings/live-voices').then(payload => {
          if (!cancelled) setLiveVoiceOptionsFromApi(previous => ({ ...previous,
            [providerValue]: Array.isArray(payload.voices) ? payload.voices : [],
          }));
          return payload;
        }),
      ]);
      if (cancelled) return;
      const failures = [modelResult, voiceResult].flatMap(result => result.status === 'rejected'
        ? [result.reason instanceof Error ? result.reason.message : 'Catalog request failed.'] : []);
      setLiveCatalogStatus(failures.length ? 'error' : 'ready');
      setLiveCatalogMessage(failures.length ? Array.from(new Set(failures)).join(' ')
        : 'Models and voices loaded. Realtime access is confirmed when you start a session.');
    }, 350);
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [activeLiveApiKey, activeLiveProviderLabel, activeLiveProviderValue, activeTab, isOpen,
    settings.liveConvoModel, settings.liveConvoAgentId, liveCatalogRefresh]);

  const liveCatalogOptions = activeLiveProvider.transport === 'model-voice'
    ? [
        { value: 'auto', label: 'Use selected chat model' },
        ...modelEntries.map(entry => ({
          value: modelEntryKey(entry.provider, entry.modelId),
          label: `${entry.provider} / ${entry.modelId}`,
          description: 'Uses this exact model and its saved connection for agent work',
        })),
      ]
    : liveModelOptionsFromApi[activeLiveProvider.value] || [];
  const selectedLiveModel = settings.liveConvoModel || 'auto';
  const resolvedGeminiLiveModel = selectedLiveModel === 'auto'
    ? liveCatalogOptions.find(option => option.value !== 'auto')?.value || ''
    : selectedLiveModel;
  const geminiLiveThinkingLevels = activeLiveProvider.provider === 'gemini'
    ? getGeminiLiveThinkingLevels(resolvedGeminiLiveModel) : [];
  const geminiLiveThinkingOptions = geminiLiveThinkingLevels.length ? [
    { value: 'ultra-low', label: `${geminiLiveThinkingLevels[0][0].toUpperCase()}${geminiLiveThinkingLevels[0].slice(1)} (Lowest latency)` },
    ...(geminiLiveThinkingLevels.includes('medium') ? [{ value: 'balanced', label: 'Medium' }] : []),
    ...(geminiLiveThinkingLevels.includes('high') ? [{ value: 'high-quality', label: 'High' }] : []),
  ] : [];
  // Saved choices remain preferences, but never become available catalog entries.
  const activeLiveModelOptions = liveCatalogOptions.length ? liveCatalogOptions
    : [{ value: 'auto', label: 'Auto (Available provider model)' }];
  const displayedLiveModelOptions = selectedLiveModel !== 'auto'
    && activeLiveProvider.transport !== 'model-voice'
    && !activeLiveModelOptions.some(option => option.value === selectedLiveModel)
    ? [...activeLiveModelOptions, { value: selectedLiveModel, label: selectedLiveModel, description: 'Exact model ID; availability is resolved when connecting' }]
    : activeLiveModelOptions;
  const selectedLiveModelUnavailable = selectedLiveModel !== 'auto' && liveCatalogOptions.length > 0
    && !liveCatalogOptions.some(option => option.value === selectedLiveModel);
  const liveVoiceOptions = liveVoiceOptionsFromApi[activeLiveProvider.value] || [];
  const selectedLiveVoice = settings.liveConvoVoice || 'auto';
  const activeLiveVoiceOptions = liveVoiceOptions.length ? liveVoiceOptions
    : [{ value: 'auto', label: 'Auto (Provider default)' }];
  const selectedLiveVoiceUnavailable = selectedLiveVoice !== 'auto' && liveVoiceOptions.length > 0
    && !liveVoiceOptions.some(option => option.value === selectedLiveVoice);

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
  const selectedContextChat = contextChats.find(chat => chat.id === selectedContextChatId) || null;
  const selectedContextChatBudget = selectedContextChatId
    ? contextChatOverrides[selectedContextChatId] || 'global'
    : 'global';
  const contextChatMaximum = (chat: ContextChatSummary | null): number => {
    if (!chat) return 0;
    if (!chat.provider || !chat.modelId) return chat.modelMaximum;
    let discovered = 0;
    try {
      discovered = normalizeContextWindow(JSON.parse(appStorage.getItem(MODEL_CONTEXT_WINDOWS_STORAGE_KEY) || '{}')?.[
        modelEntryKey(chat.provider, chat.modelId)
      ]) || 0;
    } catch { }
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
  const selectedApiProvider = selectedApiProviderValue || activeProvider;
  const selectedApiProviderLabel = PROVIDER_LABEL[selectedApiProvider] || selectedApiProvider;
  const selectedApiProviderSync = providerSync(selectedApiProvider);
  const selectedApiProviderPoolValue = `provider:${selectedApiProvider}`;
  const apiPoolEntries = useMemo(() => [
    {
      value: selectedApiProviderPoolValue,
      label: 'Provider pool',
      description: `Any ${selectedApiProviderLabel} model`,
      isProviderPool: true,
    },
    ...modelEntries.filter(entry => entry.provider === selectedApiProvider).map(entry => ({
      value: modelEntryKey(entry.provider, entry.modelId),
      label: formatModelName(entry.modelId),
      description: 'Custom model pool',
      isProviderPool: false,
    })),
  ], [modelEntries, selectedApiProvider, selectedApiProviderLabel, selectedApiProviderPoolValue]);
  const selectedApiPoolEntry =
    apiPoolEntries.find(entry => entry.value === selectedApiModelValue) ||
    apiPoolEntries[0];
  const selectedApiPoolValue = selectedApiPoolEntry?.isProviderPool
    ? apiKeys[selectedApiProvider] || ''
    : modelApiKeys[selectedApiPoolEntry?.value || ''] || '';
  const showExactModel = (isLocalModelProvider(selectedApiProvider) || Boolean(apiKeys[selectedApiProvider]))
    && (selectedApiProvider === 'custom' || isLocalModelProvider(selectedApiProvider) || Boolean(providerBaseURLs[selectedApiProvider]))
    && !hasDiscoveredModelCatalog(selectedApiProvider);
  const exactModelId = exactModelDraft.trim();
  const canAddExactModel = isConcreteModelId(exactModelId) && !isEmbeddedModelLabel(exactModelId);
  const addExactModel = () => {
    if (!canAddExactModel) return;
    const entries = ensureModelSelectorEntry(readSavedModelEntries(), selectedApiProvider, exactModelId);
    appStorage.setItems({
      [MODEL_SELECTOR_STORAGE_KEY]: JSON.stringify(entries),
      [MODEL_CATALOG_STORAGE_KEY]: JSON.stringify(entriesToModelCatalog(entries)),
    });
    setExactModelDraft('');
  };

  useEffect(() => {
    if (!apiPoolEntries.some(entry => entry.value === selectedApiModelValue)) {
      setSelectedApiModelValue(selectedApiProviderPoolValue);
    }
  }, [apiPoolEntries, selectedApiProviderPoolValue, selectedApiModelValue]);

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
            {!standalone && <div className={settingsPanelStyles.backdrop} onClick={handleClose} />}

            {/* Panel */}
            <motion.div
              ref={settingsDialogRef}
              role={standalone ? undefined : 'dialog'}
              aria-label={standalone ? undefined : 'Settings'}
              aria-modal={standalone ? undefined : true}
              tabIndex={-1}
              initial={{ opacity: 0, y: standalone ? 0 : 16, scale: standalone ? 1 : 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: standalone ? 0 : 10, scale: standalone ? 1 : 0.98 }}
              transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
              data-standalone={standalone}
              className={`eterx-settings-dialog ${settingsPanelStyles.dialog} relative flex flex-col overflow-hidden ${standalone ? 'h-screen w-screen' : 'h-[min(640px,calc(100vh-40px))] w-[min(900px,calc(100vw-40px))]'}`}
            >
              <div className="relative flex min-h-0 flex-1 flex-col sm:flex-row">

              {/* ─── Sidebar Tabs ─── */}
              <div className={`${settingsPanelStyles.sidebar} relative z-10 flex w-full shrink-0 flex-col overflow-hidden border-b sm:w-[200px] sm:border-b-0 sm:border-t`}>
                <div className={`${settingsPanelStyles.sidebarHeader} pointer-events-auto flex h-11 shrink-0 items-center border-b px-2 [-webkit-app-region:no-drag]`}>
                  <button onClick={handleClose} className="eterx-settings-back-button pointer-events-auto flex h-8 w-full items-center gap-2.5 px-2.5 [-webkit-app-region:no-drag]">
                    <span className="grid h-5 w-5 shrink-0 place-items-center">
                      <ChevronRight className="h-4 w-4 rotate-180" />
                    </span>
                    <span className="text-[13px] font-medium leading-none">Back to app</span>
                  </button>
                </div>
                <div className="eterx-settings-scroll-frame eterx-settings-nav-frame relative flex min-h-0 sm:flex-1">
                  <nav ref={settingsNavRef} className="eterx-scrollbar flex w-full min-w-0 gap-1 overflow-x-auto px-2 pb-2 pt-1.5 sm:block sm:space-y-1 sm:overflow-y-auto sm:overflow-x-hidden sm:pt-2">
                    {SETTINGS_TABS.map(tab => (
                      <button
                        key={tab.id}
                        data-active={activeTab === tab.id}
                        onClick={() => {
                          setSearchDestination(null);
                          setActiveTab(tab.id);
                          onTabChange?.(tab.id);
                        }}
                        className="eterx-settings-tab flex shrink-0 items-center gap-2.5 px-2.5 text-left text-[13px] font-medium leading-none sm:w-full"
                      >
                        <span className="grid h-5 w-5 shrink-0 place-items-center text-current">
                          <tab.icon className="h-4 w-4" strokeWidth={1.9} />
                        </span>
                        <span className="min-w-0 truncate leading-5">{tab.label}</span>
                      </button>
                    ))}
                  </nav>
                </div>
              </div>

              {/* ─── Content ─── */}
              <div className={`${settingsPanelStyles.content} relative z-20 flex min-w-0 flex-1 flex-col overflow-hidden border-l border-t`}>
                <SettingsSearch tabs={SETTINGS_TABS} activeTab={activeTab} onSelect={openSearchResult} />

                {/* Scrollable Body */}
                <div className="eterx-settings-scroll-frame relative flex min-h-0 flex-1">
                  <div ref={settingsBodyRef} className={`${searchStyles.body} scrollbar-hide min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 [scrollbar-width:none]! sm:px-6 ${activeTab === 'tokens' || activeTab === 'profile' ? 'py-4' : 'py-8'}`}>
                  <div className={`mx-auto w-full ${activeTab === 'profile' || activeTab === 'tokens' || activeTab === 'subscription' ? 'max-w-[980px]' : activeTab === 'agents' ? 'max-w-[860px]' : 'max-w-[640px]'} ${activeTab === 'tokens' ? 'flex h-full flex-col' : 'pb-8'}`}>
                      <div className="mb-6 flex shrink-0 items-center justify-between gap-4">
                        <h3 data-settings-search-target={SETTINGS_TAB_HEADING} tabIndex={-1} className={`text-[22px] font-semibold leading-tight tracking-[-0.01em] text-[#F4F4F4] ${settingsPanelStyles.title}`}>
                          {SETTINGS_TABS.find(t => t.id === activeTab)?.label}
                        </h3>
                        {activeTab === 'tokens' && <div data-settings-search-target="token-count" tabIndex={-1} className="flex items-center gap-3"><span className="text-[12px] text-[#999]">Show token count</span><Toggle enabled={settings.showTokenCount} onChange={value => updateSetting('showTokenCount', value)} /></div>}
                      </div>

                      {/* ═══ GENERAL TAB ═══ */}
                      {activeTab === 'general' && (
                        <div>
                          <SectionHeader title="Work mode" />
                          <p className="-mt-2 mb-5 text-[14px] text-[#A5A5A5]">Choose how EterX handles tasks and works with your workspace.</p>
                          <div data-settings-search-target="work-mode" tabIndex={-1} className="mb-12 grid gap-4 md:grid-cols-2">
                            {[
                              { id: 'everyday' as const, title: 'General', description: 'Work directly with the agent on planning, writing, and everyday tasks.', icon: SquareCheck },
                              { id: 'specialist' as const, title: 'Autonomous', description: 'A proxy agent coordinates with the main agent to complete larger goals.', icon: Sparkle },
                            ].map(mode => {
                              const selected = settings.workMode === mode.id;
                              return (
                                <button
                                  key={mode.id}
                                  type="button"
                                  data-selected={selected}
                                  onClick={() => updateSetting('workMode', mode.id)}
                                  className={`flex min-h-[82px] items-center justify-between gap-5 rounded-lg border px-5 py-4 text-left transition-colors ${
                                    selected ? 'border-white/[0.12] bg-[#2B2B2B]' : 'border-white/[0.08] bg-[#171717] hover:bg-[#202020]'
                                  }`}
                                >
                                  <div className="flex min-w-0 items-center gap-5">
                                    <span className="grid h-6 w-6 shrink-0 place-items-center text-[#D7D7D7]">
                                      <mode.icon className="h-5 w-5" strokeWidth={1.9} />
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
                            <SettingsStackRow title="Default to full access" description="Use Full access for chats without a saved permission selection. Saved chat choices are not changed.">
                              <Toggle label="Default to full access" enabled={settings.alwaysFullAccess} onChange={value => updateSetting('alwaysFullAccess', value)} />
                            </SettingsStackRow>
                          </SettingsStack>

                          <SectionHeader title="General" />
                          <SettingsStack>
                            <SettingsStackRow title="Continue active chats in background" description="Normal chat runs keep working when the EterX window is closed or hidden." tall>
                              <div className="flex items-center gap-3">
                                <span className={`text-[11px] font-semibold ${gatewayRunning ? 'text-[color:var(--settings-text)]' : 'text-white/35'}`}>{gatewayRunning ? 'Running' : 'Off'}</span>
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
                            <SettingsStackRow title="Scratch workspace retention" description="Delete temporary workspace files after this many days from creation. Applies to new workspaces; active agents and open terminals delay cleanup. Chat history is kept." tall>
                              <ScratchRetentionControl value={settings.scratchRetentionDays} onChange={days => updateSetting('scratchRetentionDays', days)} />
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
                            <SettingsStackRow title="Show thinking in container" description="Display a separate expandable card for thinking details in chat.">
                              <Toggle label="Show thinking in container" enabled={settings.showThinkingInContainer} onChange={value => updateSetting('showThinkingInContainer', value)} />
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
                          </SettingsStack>



                          <SectionHeader title="Microphone and speech" />
                          <MicrophoneSettings
                            microphoneDeviceId={settings.microphoneDeviceId || 'default'}
                            language={settings.dictationLanguage || 'auto'}
                            modelId={settings.dictationModel || 'large-v3-q5_0'}
                            onMicrophoneChange={value => updateSetting('microphoneDeviceId', value)}
                            onLanguageChange={value => updateSetting('dictationLanguage', value)}
                            onModelChange={value => updateSetting('dictationModel', value)}
                            Select={ModernSelect}
                          />

                          <SectionHeader title="Notifications" />
                          <SettingsStack>
                            <SettingsStackRow title="Turn completion notifications" description="Get notified when long-running agent work completes.">
                              <SelectControl
                                value={settings.completionNotifications}
                                onChange={(value) => updateSetting('completionNotifications', value as AppSettings['completionNotifications'])}
                                openUp
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

                      {activeTab === 'agents' && (
                        <div data-settings-search-target="agent-tools" tabIndex={-1}><AgentToolsSettings /></div>
                      )}
                      {activeTab === 'import' && <ImportSettings />}

                      {activeTab === 'appearance' && (
                        <div className={appearanceStyles.appearance}>
                          <SettingsStack>
                            <SettingsStackRow title="Theme" description="System follows your device’s appearance." tall>
                              <ThemePreviewSelector
                                value={settings.theme}
                                onChange={(value) => updateSetting('theme', value)}
                              />
                            </SettingsStackRow>

                            <SettingsStackRow title="UI density" description="Adjust spacing and text size.">
                              <SelectControl
                                value={settings.fontSize}
                                width="w-[var(--appearance-control-width)]"
                                onChange={(value) => updateSetting('fontSize', value as AppSettings['fontSize'])}
                                options={[
                                  { value: 'compact', label: 'Compact' },
                                  { value: 'default', label: 'Default' },
                                  { value: 'comfortable', label: 'Comfortable' },
                                ]}
                              />
                            </SettingsStackRow>
                          </SettingsStack>
                          <div>
                            <SectionHeader title="Project/Folder" />
                            <SettingsStack>
                              <WorkspaceFolderSettings sources={workspaceSources} scope={workspaceScope} />
                            </SettingsStack>
                          </div>
                          <div>
                            <SectionHeader title="Readability" />
                            <SettingsStack>
                              <SettingsStackRow title="Contrast" description="Make interface text and borders more distinct.">
                                <ContrastControl value={settings.uiContrast} onChange={value => updateSetting('uiContrast', value)} />
                              </SettingsStackRow>
                              <SettingsStackRow title="Diff colors" description="Choose a palette for additions, deletions, and change counts." tall>
                                <DiffPalettePicker value={settings.diffPalette} onChange={value => updateSetting('diffPalette', value)} />
                              </SettingsStackRow>
                            </SettingsStack>
                          </div>
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
                              data-settings-search-target="compaction-instructions"
                              aria-label="Context compaction instructions"
                              value={settings.contextCompactionInstructions}
                              onChange={event => updateSetting('contextCompactionInstructions', event.target.value.slice(0, 12000))}
                              placeholder="Add details the context compactor should preserve or emphasize..."
                              rows={10}
                              className="min-h-[210px] w-full resize-y rounded-xl border border-white/[0.08] bg-[#141414] px-4 py-3 text-[13px] leading-6 text-[#F1F1F1] outline-hidden transition-colors placeholder:text-[#666] focus:border-white/[0.20]"
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
                          <div data-settings-search-target="chat-context" tabIndex={-1} className="rounded-xl border border-white/[0.09] bg-[#202020] p-4">
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
                        <div className={activeTab === 'tokens' ? 'flex min-h-0 flex-1 flex-col' : undefined}>
                          {activeTab === 'profile' ? <SettingsProfile
                            name={settings.userName || ''}
                            onNameChange={value => updateSetting('userName', value)}
                            stats={tokenStats}
                            loading={tokenUsageStatus.profile === 'loading'}
                            error={tokenUsageStatus.profile === 'error' ? 'Unable to load activity. Retrying automatically…'
                              : tokenUsageStatus.profile === 'refresh-error' ? 'Unable to refresh. Showing the last loaded activity.' : ''}
                          /> : (() => {
                              const loading = tokenUsageStatus.tokens === 'loading';
                              const loadFailed = tokenUsageStatus.tokens === 'error';
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
                              return <>
                              <span className="sr-only" role="status">{loading ? 'Loading token usage…' : ''}</span>
                              <div aria-busy={loading} className="flex min-h-[340px] flex-1 flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#171717]">
                                <div data-settings-search-target="chat-token-usage" tabIndex={-1} className="eterx-settings-token-list flex min-h-0 flex-1 flex-col border-b border-white/[0.08] p-2">
                                  <div className="px-3 py-2 text-[11px] font-medium tracking-[0.02em] text-[#777]">All chats</div>
                                  <SettingsScrollList className="pr-1" frameClassName="flex-1" enabled={!loading}>
                                    {loading ? <TokenUsageRowsSkeleton showCounts={settings.showTokenCount} />
                                      : loadFailed ? <div role="status" className="px-3 py-8 text-center text-[13px] text-[#777]">Unable to load token usage. Retrying automatically…</div>
                                      : tokenChats.length > 0 ? tokenChats.map(chat => (
                                      <button key={chat.id} type="button" onClick={event => { setSelectedTokenChatId(chat.id); hoverChat(event, chat.totalTokens, chat.recentRunUsage, chat.model, new Date(chat.updatedAt || Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), { scope: 'chat', promptTokens: chat.promptTokens, cachedTokens: chat.cachedTokens, uncachedPromptTokens: chat.uncachedPromptTokens, outputTokens: chat.outputTokens }); }} onMouseEnter={event => hoverChat(event, chat.totalTokens, chat.recentRunUsage, chat.model, new Date(chat.updatedAt || Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), { scope: 'chat', promptTokens: chat.promptTokens, cachedTokens: chat.cachedTokens, uncachedPromptTokens: chat.uncachedPromptTokens, outputTokens: chat.outputTokens })} onMouseLeave={() => setHoveredToken(null)} className={`mb-1 flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${selectedTokenChatId === chat.id ? 'bg-white/[0.10]' : 'hover:bg-white/[0.055]'}`}>
                                        <span className="min-w-0 truncate text-[13px] text-[#E8E8E8]">{chat.title}</span>
                                        {settings.showTokenCount && <span className="shrink-0 inline-flex items-center gap-2 text-[11px] text-[#888]" title="Provider-reported input and output tokens"><span>Input {formatTokenMetric(chat.promptTokens)}</span><span className="text-[#555]" aria-hidden="true">|</span><span>Output {formatTokenMetric(chat.outputTokens)}</span></span>}
                                      </button>
                                    )) : <div className="px-3 py-8 text-center text-[13px] text-[#777]">No saved chats yet.</div>}
                                  </SettingsScrollList>
                                </div>
                                <div data-settings-search-target="action-token-usage" tabIndex={-1} className="eterx-settings-token-list flex min-h-0 flex-1 flex-col p-2">
                                  <div className="flex min-h-[34px] items-center justify-between px-3 py-2"><span className="text-[11px] font-medium tracking-[0.02em] text-[#777]">Action usage</span>{!loading && !loadFailed && <span className="max-w-[55%] truncate text-[12px] text-[#888]">{selected?.title || 'Choose a chat'}</span>}</div>
                                  <SettingsScrollList className="pr-1" frameClassName="flex-1" enabled={!loading}>
                                    {loading ? <TokenUsageRowsSkeleton actions showCounts={settings.showTokenCount} />
                                      : loadFailed ? <div className="px-3 py-8 text-center text-[13px] text-[#777]">Unable to load action usage.</div>
                                      : selected?.actions?.length ? selected.actions.slice().reverse().map(action => (
                                      <button key={action.id} type="button" onClick={event => hoverChat(event, action.tokens, action.tokens, action.model, action.label, { scope: 'action', promptTokens: action.promptTokens, cachedTokens: action.cachedTokens, uncachedPromptTokens: action.uncachedPromptTokens, outputTokens: action.outputTokens })} onMouseEnter={event => hoverChat(event, action.tokens, action.tokens, action.model, action.label, { scope: 'action', promptTokens: action.promptTokens, cachedTokens: action.cachedTokens, uncachedPromptTokens: action.uncachedPromptTokens, outputTokens: action.outputTokens })} onMouseLeave={() => setHoveredToken(null)} className="mb-1 flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-white/[0.055]">
                                        <span className="min-w-0 truncate"><span className="mr-2 normal-case text-[10px] tracking-[0.04em] text-[#666]">{action.kind.charAt(0).toUpperCase() + action.kind.slice(1).toLowerCase()}</span><span className="text-[13px] text-[#D8D8D8]">{action.label}</span></span>
                                        {settings.showTokenCount && <span className="shrink-0 inline-flex items-center gap-2 text-[11px] text-[#888]" title="Provider-reported input and output tokens"><span>Input {formatTokenMetric(action.promptTokens)}</span><span className="text-[#555]" aria-hidden="true">|</span><span>Output {formatTokenMetric(action.outputTokens)}</span></span>}
                                      </button>
                                    )) : <div className="px-3 py-8 text-center text-[13px] text-[#777]">No recorded actions for this chat.</div>}
                                  </SettingsScrollList>
                                </div>
                              </div>
                              {!loading && !loadFailed && hoveredToken?.model && <div role="tooltip" className="pointer-events-none fixed z-[10000] w-max max-w-[240px] rounded-xl border border-[var(--border)] bg-[var(--input-bg)] px-3 py-2 text-[12px] text-[var(--foreground)]" style={{ left: Math.max(8, Math.min(hoveredToken.x + 10, window.innerWidth - 256)), top: Math.max(8, hoveredToken.y - 180) }}>
                                <div className="space-y-1">
                                  <div className="flex justify-between gap-6"><span>Processed</span><strong>{formatTokenMetric(hoveredToken.value)}</strong></div>
                                  {hoveredToken.scope !== 'action' && <div className="flex justify-between gap-6"><span>Recent run</span><strong>{formatTokenMetric(hoveredToken.recentRunUsage || 0)}</strong></div>}
                                  <div className="flex justify-between gap-6"><span>Input</span><strong>{formatTokenMetric(hoveredToken.promptTokens || 0)}</strong></div>
                                  <div className="flex justify-between gap-6"><span>Uncached input</span><strong>{formatTokenMetric(hoveredToken.uncachedPromptTokens || 0)}</strong></div>
                                  <div className="flex justify-between gap-6"><span>Cached input</span><strong>{formatTokenMetric(hoveredToken.cachedTokens || 0)}</strong></div>
                                  <div className="flex justify-between gap-6"><span>Output</span><strong>{formatTokenMetric(hoveredToken.outputTokens || 0)}</strong></div>
                                  <div className="flex justify-between gap-6"><span>Model</span><strong className="max-w-[140px] truncate">{formatModelName(hoveredToken.model)}</strong></div>
                                </div>
                              </div>}
                              </>;
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
                            <SettingsStackRow title="Auto-open Work Panel" description="Open the Work Panel when a sub-agent starts for quick navigation.">
                              <Toggle enabled={settings.autoOpenWorkPanelOnSubAgentSpawn} onChange={v => updateSetting('autoOpenWorkPanelOnSubAgentSpawn', v)} />
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
                                  className="w-24 rounded-md border border-white/10 bg-white/[0.06] px-2 py-1.5 text-right text-[13px] font-mono text-[#DCD8D2] outline-hidden focus:border-white/25"
                                />
                                <span className="text-[12px] text-[#8E8A84]">agents</span>
                              </div>
                            </SettingsStackRow>
                          </SettingsStack>


                        </div>
                      )}

                      {activeTab === 'subscription' && (
                        <SubscriptionProviders provider={subscriptionProvider} onSelect={setSubscriptionProvider} />
                      )}

                      {activeTab === 'api' && (
                        <div>
                          <SectionHeader
                            title="API connections"
                            badge={apiSyncStatus === 'synced' ? 'Saved' : undefined}
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
                                  setExactModelDraft('');
                                }}
                                className="w-[240px]"
                                providers={MODEL_PROVIDER_ORDER}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow
                              title="API base URL"
                              description="Use the default endpoint or enter the URL for a gateway or local server."
                            >
                              <div className="flex w-full max-w-[360px] items-center gap-2">
                                <input
                                  aria-label="API base URL"
                                  value={providerBaseURLs[selectedApiProvider] || ''}
                                  onChange={event => updateProviderBaseURL(selectedApiProvider, event.target.value)}
                                  placeholder={selectedApiProvider === 'custom' ? 'https://host.example/v1' : 'Use provider default'}
                                  spellCheck={false}
                                  className="h-9 min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-[#141414] px-3 text-[12px] font-mono text-[#F1F1F1] outline-hidden transition-colors placeholder:text-[#666] focus:border-white/[0.20]"
                                />
                                {providerBaseURLs[selectedApiProvider] && (
                                  <SoftButton onClick={() => updateProviderBaseURL(selectedApiProvider, '')}>Default</SoftButton>
                                )}
                              </div>
                            </SettingsStackRow>
                            <SettingsStackRow
                              title="API keys"
                              description="Add a provider key to load its available models automatically in the chat picker."
                              info="A model-specific key pool takes priority for that model."
                              tall
                            >
                              <ApiKeyPoolEditor
                                key={`${selectedApiProvider}-${selectedApiPoolEntry.value}`}
                                provider={selectedApiProvider}
                                testBaseURL={providerBaseURLs[selectedApiProvider] || ''}
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
                                    <InfoHint text="Choose a model to give it a separate key pool." />
                                    <ModernSelect
                                      value={selectedApiPoolEntry.value}
                                      onChange={(value) => setSelectedApiModelValue(value)}
                                      placeholder="Provider pool"
                                      className="w-[230px]"
                                      options={apiPoolEntries}
                                    />
                                  </div>
                                }
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Export model catalog" description="Download the models available in EterX, including connected subscriptions.">
                              <SoftButton onClick={exportModelCatalog}>Export model catalog</SoftButton>
                            </SettingsStackRow>
                            {showExactModel && (
                              <SettingsStackRow
                                searchTarget="exact-model"
                                title="Exact model ID"
                                description="Enter the model ID if your endpoint does not list its models."
                              >
                                <div className="flex w-full max-w-[300px] items-center gap-2">
                                  <input
                                    aria-label="Exact model ID"
                                    value={exactModelDraft}
                                    onChange={event => setExactModelDraft(event.target.value)}
                                    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addExactModel(); } }}
                                    placeholder="model-id"
                                    spellCheck={false}
                                    className="h-9 min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-[#141414] px-3 text-[12px] font-mono text-[#F1F1F1] outline-hidden transition-colors placeholder:text-[#666] focus:border-white/[0.20]"
                                  />
                                  <SoftButton onClick={addExactModel} disabled={!canAddExactModel}>Add</SoftButton>
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
                            info="Choose a native realtime provider, or speak to any configured model through the agent runtime."
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
                              description="Use a native voice provider or any model you have added in Models."
                              info="Any configured model uses local desktop dictation and system speech. Native providers use their own realtime audio transports."
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
                              description={selectedLiveModelUnavailable ? (activeLiveProvider.transport === 'model-voice' ? 'The saved model was removed. Choose another added model.' : 'This ID is not listed. The provider will resolve it when connecting.') : activeLiveProvider.transport === 'model-voice' ? 'Choose any added provider/model, including local and custom endpoints.' : 'Specific model engine active for current provider stream.'}
                              info={activeLiveProvider.transport === 'model-voice' ? 'Use selected chat model follows your chat picker selection. Tool use depends on the model and server capabilities.' : `Models are loaded for ${activeLiveProvider.label} and never fall back to another provider.`}
                            >
                              <ModernSelect
                                value={settings.liveConvoModel || 'auto'}
                                onChange={(val) => updateSetting('liveConvoModel', val)}
                                className="w-[340px]"
                                placeholder={selectedLiveModelUnavailable ? 'Model unavailable — choose another' : 'Load available models'}
                                options={displayedLiveModelOptions}
                              />
                            </SettingsStackRow>

                            {activeLiveProvider.transport !== 'model-voice' && !activeLiveProvider.requiresAgentId && (
                              <SettingsStackRow title="Exact model ID" description="Use an account-specific model or snapshot even when the provider directory omits it. Leave empty for automatic selection.">
                                <input
                                  aria-label="Exact Live model ID"
                                  value={settings.liveConvoModel === 'auto' ? '' : settings.liveConvoModel || ''}
                                  onChange={event => updateSetting('liveConvoModel', event.target.value.trim() || 'auto')}
                                  placeholder="Provider model ID"
                                  className="h-9 w-[340px] rounded-xl border border-white/[0.08] bg-[#141414] px-3 text-[13px] text-[#F1F1F1] outline-hidden focus:border-white/[0.20]"
                                />
                              </SettingsStackRow>
                            )}

                            <SettingsStackRow
                              title="Voice Persona"
                              description={selectedLiveVoiceUnavailable ? 'The saved voice is no longer available for this connection.' : 'Choose the synthesized output voice for live responses.'}
                              info={activeLiveProvider.transport === 'model-voice' ? 'Voices come from your device. The microphone pauses during spoken replies to prevent echo. Dictation model and language are configured in General.' : `Voices are loaded for the selected ${activeLiveProvider.label} model.`}
                            >
                              <ModernSelect
                                value={settings.liveConvoVoice || 'auto'}
                                onChange={(val) => updateSetting('liveConvoVoice', val)}
                                className="w-[340px]"
                                placeholder={selectedLiveVoiceUnavailable ? 'Voice unavailable — choose another' : 'Load available voices'}
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
                                  className="h-9 w-[340px] rounded-xl border border-white/[0.08] bg-[#141414] px-3 text-[13px] text-[#F1F1F1] outline-hidden transition-colors placeholder:text-[#666] focus:border-white/[0.20]"
                                />
                              </SettingsStackRow>
                            )}

                            <SettingsStackRow
                              title="Provider catalog status"
                              description="Live model and voice catalogs are refreshed whenever the provider, model, or key changes."
                              tall
                            >
                              <div className="flex w-full min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-[var(--border)] bg-[#171717] px-3 py-2">
                                <div role="status" className="flex min-w-0 flex-[1_1_12rem] items-start gap-2 text-[12px] leading-relaxed text-[var(--foreground)]">
                                  {liveCatalogStatus === 'loading' && <Spinner className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                                  <span className="min-w-0 [overflow-wrap:anywhere]">{liveCatalogMessage}</span>
                                </div>
                                <SoftButton onClick={() => setLiveCatalogRefresh(value => value + 1)}>Refresh</SoftButton>
                              </div>
                            </SettingsStackRow>

                            {activeLiveProvider.provider === 'gemini' && geminiLiveThinkingOptions.length > 0 && (
                              <SettingsStackRow
                                title="Gemini Thinking Level"
                                description="Choose a thinking level supported by the selected Live model."
                              >
                                <ModernSelect
                                  value={settings.liveConvoLatencyMode || 'ultra-low'}
                                  onChange={(val) => updateSetting('liveConvoLatencyMode', val as AppSettings['liveConvoLatencyMode'])}
                                  className="w-[220px]"
                                  options={geminiLiveThinkingOptions}
                                />
                              </SettingsStackRow>
                            )}

                            <SettingsStackRow
                              title="Audio Modalities"
                              description="Control live microphone input capture and speaker output."
                            >
                              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                                <label data-settings-search-target="mic-input" tabIndex={-1} className="flex items-center gap-2 text-[13px] text-[#E0E0E0] cursor-pointer">
                                  <Toggle
                                    enabled={settings.liveConvoAudioInput ?? true}
                                    onChange={(v) => updateSetting('liveConvoAudioInput', v)}
                                  />
                                  Mic Input
                                </label>
                                <label data-settings-search-target="speaker-output" tabIndex={-1} className="flex items-center gap-2 text-[13px] text-[#E0E0E0] cursor-pointer">
                                  <Toggle
                                    enabled={settings.liveConvoAudioOutput ?? true}
                                    onChange={(v) => updateSetting('liveConvoAudioOutput', v)}
                                  />
                                  Speaker Output
                                </label>
                              </div>
                            </SettingsStackRow>
                          </SettingsStack>

                          {activeLiveProvider.transport !== 'model-voice' && <>
                          <SectionHeader title="Live System Instructions" />
                          <p className="-mt-2 mb-4 text-[14px] leading-relaxed text-[#A5A5A5]">
                            Custom system directives sent to the live API session to define how the live agent speaks and behaves during realtime interaction.
                          </p>
                          <textarea
                            data-settings-search-target="live-instructions"
                            aria-label="Live system instructions"
                            value={settings.liveConvoSystemInstruction || ''}
                            onChange={(e) => updateSetting('liveConvoSystemInstruction', e.target.value)}
                            placeholder="e.g. You are a fast, concise live voice coding assistant. Speak directly, avoid long intros, and answer code questions immediately."
                            className="min-h-[120px] w-full resize-y rounded-xl border border-white/[0.09] bg-[#202020] px-4 py-3 text-[13px] leading-6 text-[#F1F1F1] outline-hidden transition-colors placeholder:text-[#777] focus:border-white/[0.20]"
                          />
                          </>}

                          {activeLiveProvider.transport !== 'model-voice' && <>
                            <SectionHeader title={`${activeLiveProvider.label} API Key`} />
                          <SettingsStack>
                            <SettingsStackRow
                              title="Live Convo Key Pool"
                              description={`Optional dedicated ${activeLiveProvider.label} key pool. When empty, Live uses this provider's saved connection in Models. Custom gateway credentials are kept with their configured host.`}
                              tall
                            >
                              <ApiKeyPoolEditor
                                provider={liveApiKeyProvider}
                                providerLabel={liveApiKeyLabel}
                                value={activeLiveApiKey}
                                minRows={2}
                                testEndpoint="/api/live/models"
                                testProvider={activeLiveProvider.value}
                                testBody={(key) => ({ provider: activeLiveProvider.value, key, agentId: settings.liveConvoAgentId || '', testOnly: true })}
                                onChange={(nextValue) => updateLiveApiKey(liveApiKeyProvider, nextValue)}
                              />
                            </SettingsStackRow>
                          </SettingsStack>
                          </>}
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
                                className="h-9 w-[240px] rounded-xl border border-white/[0.08] bg-[#141414] px-3 text-[13px] text-[#F1F1F1] outline-hidden transition-colors placeholder:text-[#666] focus:border-white/[0.20]"
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
                            data-settings-search-target="personal-instructions"
                            aria-label="Custom instructions"
                            value={settings.customInstructions || ''}
                            onChange={(event) => updateSetting('customInstructions', event.target.value)}
                            placeholder="Add your custom instructions..."
                            className="min-h-[260px] w-full resize-y rounded-xl border border-white/[0.09] bg-[#202020] px-4 py-3 font-mono text-[13px] leading-6 text-[#F1F1F1] outline-hidden transition-colors placeholder:text-[#777] focus:border-white/[0.20]"
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
                            <SettingsStackRow title="Git integration" description="Show the current branch and enable repository actions in the composer and Git workspace.">
                              <Toggle enabled={settings.gitIntegration} onChange={v => updateSetting('gitIntegration', v)} />
                            </SettingsStackRow>
                            <SettingsStackRow title="Git workspace tab" description="Add Git alongside Files, Review, and Terminal. Stage changes, commit, manage branches, and browse history and stashes.">
                              <Toggle enabled={settings.gitWorkspaceEnabled} onChange={v => updateSetting('gitWorkspaceEnabled', v)} />
                            </SettingsStackRow>
                            <SettingsStackRow title="Auto-refresh local status" description="Refresh while Git is visible and when returning to the app. Remote fetches, pulls, and pushes always start with your action.">
                              <Toggle enabled={settings.gitAutoDetect} onChange={v => updateSetting('gitAutoDetect', v)} />
                            </SettingsStackRow>
                            <SettingsStackRow title="Branch prefix" description="Prefill new branch names. You can edit the full name before creating a branch.">
                              <input aria-label="Git branch prefix" value={settings.gitBranchPrefix} maxLength={120} onChange={event => updateSetting('gitBranchPrefix', event.target.value)} placeholder="eterx/" className="w-36 rounded-lg border border-white/[0.08] bg-[#141414] px-3 py-2 font-mono text-[13px] text-[#CFCFCF] outline-hidden focus:border-white/30" />
                            </SettingsStackRow>
                            <SettingsStackRow title="Branch merge method" description="Merge creates or fast-forwards a commit. Squash stages the combined changes for you to review and commit.">
                              <SegmentedControl
                                value={settings.gitMergeMethod}
                                onChange={(value) => updateSetting('gitMergeMethod', value)}
                                options={[
                                  { value: 'merge', label: 'Merge' },
                                  { value: 'squash', label: 'Squash' },
                                ]}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Confirm before pushing" description="Review the repository, current branch, and destination remote before publishing commits.">
                              <Toggle enabled={settings.gitConfirmPush} onChange={v => updateSetting('gitConfirmPush', v)} />
                            </SettingsStackRow>
                          </SettingsStack>
                          <p className="mt-4 text-[13px] leading-6 text-[#A5A5A5]">Open the workspace + menu and choose Git, or use Ctrl/⌘ + Alt + G while the workspace is open. Commits include staged files only. Pull uses fast-forward only. Authentication uses your existing system Git credentials.</p>
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
                            <SettingsStackRow title="Primary provider" searchTarget="search-provider" description="This external provider runs after enabled built-in search, or first when built-in search is off. Enabled fallbacks follow in order.">
                              <ModernSelect
                                value={searchSettings.provider}
                                onChange={(value) => {
                                  if (!SEARCH_PROVIDER_IDS.includes(value as SearchProvider)) return;
                                  const provider = value as SearchProvider;
                                  updateSearchSettings(current => ({
                                    ...current,
                                    provider,
                                    fallbackProviders: [current.provider, ...current.fallbackProviders].filter(item => item !== provider),
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
                            {(
                              <SettingsStackRow
                                searchTarget="search-endpoint"
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
                                  className="h-10 w-full rounded-xl border border-white/[0.08] bg-[#141414] px-3 text-[12px] font-mono text-[#F1F1F1] outline-hidden transition-colors placeholder:text-[#666] focus:border-sky-300/35"
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
                            <SettingsStackRow title="Provider credentials" searchTarget="search-credentials" description={selectedSearchMeta.credentialDescription || (selectedSearchMeta.requiresKey ? `Up to three ${selectedSearchMeta.label} keys. Keys are tried in order and rotate after a successful request.` : 'This provider does not require a credential.')} tall>
                              {selectedSearchMeta.requiresKey || searchSettings.provider === 'firecrawl_selfhosted' ? (
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
                                  <button type="button" data-settings-search-target="test-search-connection" onClick={() => void testSearchConnection(searchSettings.provider)} disabled={searchProbe.provider === searchSettings.provider && searchProbe.status === 'testing'} className="shrink-0 rounded-lg bg-white/[0.07] px-3 py-2 text-[11px] font-semibold text-[#D8D8D8] transition-colors hover:bg-white/[0.12] disabled:opacity-40">{searchProbe.provider === searchSettings.provider && searchProbe.status === 'testing' ? 'Testing...' : 'Test connection'}</button>
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
                            <SettingsStackRow title="Primary provider" searchTarget="image-provider" description="The first real image request uses this provider and its selected model.">
                              <ModernSelect
                                value={imageSettings.provider}
                                onChange={value => {
                                  if (!IMAGE_PROVIDER_IDS.includes(value as ImageProvider)) return;
                                  const provider = value as ImageProvider;
                                  updateImageSettings(current => ({
                                    ...current,
                                    provider,
                                    fallbackProviders: [current.provider, ...current.fallbackProviders].filter(item => item !== provider),
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
                            <SettingsStackRow title="Model" searchTarget="image-model" description="Choose a suggested model or enter the exact model ID available to your account.">
                              <div className="flex w-full flex-col gap-2">
                              <ModernSelect
                                value={selectedImageModel}
                                onChange={model => updateImageSettings(current => ({ ...current, modelByProvider: { ...current.modelByProvider, [current.provider]: model } }))}
                                className="w-[360px]"
                                options={selectedImageMeta.models.map(model => ({ value: model.id, label: model.label, description: `${model.id} · ${model.description}` }))}
                              />
                              <input
                                aria-label="Image model ID"
                                value={selectedImageModel}
                                onChange={event => updateImageSettings(current => ({ ...current, modelByProvider: { ...current.modelByProvider, [current.provider]: event.target.value } }))}
                                placeholder="Exact model ID"
                                className="h-9 w-full rounded-xl border border-white/[0.08] bg-[#141414] px-3 text-[12px] font-mono text-[#F1F1F1] outline-hidden focus:border-sky-300/35"
                              />
                              </div>
                            </SettingsStackRow>
                            <SettingsStackRow title="Custom endpoint" searchTarget="image-endpoint" description="Optional base URL for your provider account or private relay." tall>
                              <input
                                aria-label="Image service endpoint"
                                value={imageSettings.baseURLs[imageSettings.provider] || ''}
                                onChange={event => updateImageSettings(current => ({ ...current, baseURLs: { ...current.baseURLs, [current.provider]: event.target.value } }))}
                                placeholder={selectedImageMeta.defaultBaseURL}
                                className="h-10 w-full rounded-xl border border-white/[0.08] bg-[#141414] px-3 text-[12px] font-mono text-[#F1F1F1] outline-hidden focus:border-sky-300/35"
                              />
                            </SettingsStackRow>
                            <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.07] px-4 py-3">
                              <span className="mr-1 text-[11px] text-[#777]">This route provides</span>
                              <span className="rounded-full border border-white/[0.09] bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium text-[#BDBDBD]">{IMAGE_CAPABILITY_LABELS.text}</span>
                              {selectedImageMeta.supportsEditing && <span className="rounded-full border border-white/[0.09] bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium text-[#BDBDBD]">{IMAGE_CAPABILITY_LABELS.edit}</span>}
                              {selectedImageMeta.supportsAspectRatio && <span className="rounded-full border border-white/[0.09] bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium text-[#BDBDBD]">{IMAGE_CAPABILITY_LABELS.ratio}</span>}
                              <span className="rounded-full border border-emerald-300/15 bg-emerald-300/[0.07] px-2.5 py-1 text-[10px] font-medium text-emerald-200">Provider-native</span>
                            </div>
                            <SettingsStackRow title="Provider credentials" searchTarget="image-credentials" description={`Up to three ${selectedImageMeta.authLabel} values. An empty pool uses a matching model-provider key when available, then environment credentials. Keys rotate after success.`} tall>
                              <ApiKeyPoolEditor
                                key={`image-${imageSettings.provider}`}
                                provider={imageSettings.provider}
                                providerLabel={selectedImageMeta.authLabel}
                                value={(imageSettings.apiKeys[imageSettings.provider] || []).join('\n')}
                                minRows={1}
                                maxRows={3}
                                testEndpoint="/api/settings/image"
                                testBody={(key) => ({ provider: imageSettings.provider, key, model: selectedImageModel, baseURL: imageSettings.baseURLs[imageSettings.provider] || '' })}
                                onChange={value => updateImageKeyPool(imageSettings.provider, value)}
                              />
                            </SettingsStackRow>
                          </SettingsStack>
                          <div data-settings-search-target="image-fallbacks" tabIndex={-1} className="mt-3 overflow-hidden rounded-xl border border-white/[0.09] bg-[#202020]">
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
                            <button type="button" data-settings-search-target="test-image-connection" onClick={() => void testImageConnection(imageSettings.provider)} disabled={imageProbe.provider === imageSettings.provider && imageProbe.status === 'testing'} className="rounded-lg bg-white/[0.07] px-3 py-2 text-[11px] font-semibold text-[#D8D8D8] transition-colors hover:bg-white/[0.12] disabled:opacity-40">{imageProbe.provider === imageSettings.provider && imageProbe.status === 'testing' ? 'Testing...' : 'Test connection'}</button>
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
                            <SettingsStackRow title="Primary provider" searchTarget="video-provider" description="The first video request uses this provider and its selected model.">
                              <ModernSelect
                                value={videoSettings.provider}
                                onChange={value => {
                                  if (!VIDEO_PROVIDER_IDS.includes(value as VideoProvider)) return;
                                  const provider = value as VideoProvider;
                                  updateVideoSettings(current => ({ ...current, provider, fallbackProviders: [current.provider, ...current.fallbackProviders].filter(item => item !== provider) }));
                                }}
                                className="w-[280px]"
                                options={VIDEO_PROVIDER_IDS.map(provider => ({ value: provider, label: VIDEO_PROVIDER_META[provider].label, description: VIDEO_PROVIDER_META[provider].description }))}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Custom endpoint" searchTarget="video-endpoint" description="Optional base URL for your provider account or private relay." tall>
                              <input
                                aria-label="Video service endpoint"
                                value={videoSettings.baseURLs[videoSettings.provider] || ''}
                                onChange={event => updateVideoSettings(current => ({ ...current, baseURLs: { ...current.baseURLs, [current.provider]: event.target.value } }))}
                                placeholder={selectedVideoMeta.defaultBaseURL}
                                className="h-10 w-full rounded-xl border border-white/[0.08] bg-[#141414] px-3 text-[12px] font-mono text-[#F1F1F1] outline-hidden focus:border-sky-300/35"
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Model" searchTarget="video-model" description="Choose a suggested model or enter an exact current model ID for FAL and Replicate catalogs.">
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
                                  className="h-9 w-full rounded-xl border border-white/[0.08] bg-[#141414] px-3 text-[12px] font-mono text-[#F1F1F1] outline-hidden transition-colors placeholder:text-[#666] focus:border-sky-300/35"
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
                            <SettingsStackRow title="Provider credentials" searchTarget="video-credentials" description={`Up to three ${selectedVideoMeta.authLabel} values. An empty pool uses a matching model-provider key when available, then environment credentials. Keys rotate after success.`} tall>
                              <ApiKeyPoolEditor
                                key={`video-${videoSettings.provider}`}
                                provider={videoSettings.provider}
                                providerLabel={selectedVideoMeta.authLabel}
                                value={(videoSettings.apiKeys[videoSettings.provider] || []).join('\n')}
                                minRows={1}
                                maxRows={3}
                                testEndpoint="/api/settings/video"
                                testBody={(key) => ({ provider: videoSettings.provider, key, model: selectedVideoModel, baseURL: videoSettings.baseURLs[videoSettings.provider] || '' })}
                                onChange={value => updateVideoKeyPool(videoSettings.provider, value)}
                              />
                            </SettingsStackRow>
                          </SettingsStack>
                          <div data-settings-search-target="video-fallbacks" tabIndex={-1} className="mt-3 overflow-hidden rounded-xl border border-white/[0.09] bg-[#202020]">
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
                            <button type="button" data-settings-search-target="test-video-connection" onClick={() => void testVideoConnection(videoSettings.provider)} disabled={videoProbe.provider === videoSettings.provider && videoProbe.status === 'testing'} className="rounded-lg bg-white/[0.07] px-3 py-2 text-[11px] font-semibold text-[#D8D8D8] transition-colors hover:bg-white/[0.12] disabled:opacity-40">{videoProbe.provider === videoSettings.provider && videoProbe.status === 'testing' ? 'Testing...' : 'Test connection'}</button>
                          </div>
                          {videoProbe.message && videoProbe.provider === videoSettings.provider && <div className={`mt-3 rounded-xl border px-4 py-3 text-[12px] leading-5 ${videoProbe.status === 'success' ? 'border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-200' : videoProbe.status === 'failed' ? 'border-red-400/20 bg-red-400/[0.06] text-red-200' : 'border-white/[0.08] bg-white/[0.03] text-[#B8B8B8]'}`}>{videoProbe.message}</div>}

                        </div>
                      )}

                      {activeTab === 'connections' && <ConnectionsSettings onOpenDevices={onOpenDevices} />}

                      {activeTab === 'computer' && (
                        <ComputerUseSettings
                          settings={settings}
                          runtime={browserRuntimeStatus}
                          runtimeBusy={browserRuntimeBusy}
                          runtimeMessage={browserRuntimeMessage}
                          accessError={computerAccessError}
                          platform={terminalPlatform}
                          onSettingChange={updateSetting}
                          onBrowserAction={runBrowserRuntimeAction}
                          onRefresh={refreshBrowserRuntimeStatus}
                        />
                      )}



                      {activeTab === 'environments' && (
                        <div>
                          <SectionHeader title="Developer" />
                          <SettingsStack>
                            <SettingsStackRow title="Debug mode" description="Show detailed internal logs, tool calls, and runtime traces in console.">
                              <Toggle enabled={settings.debugMode} onChange={v => updateSetting('debugMode', v)} />
                            </SettingsStackRow>
                            <SettingsStackRow title="Performance telemetry" description="Share usage and performance metrics with PostHog using an installation ID. On by default in the desktop app.">
                              <Toggle label="Performance telemetry" enabled={settings.telemetry} onChange={v => updateSetting('telemetry', v)} />
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
                            <SettingsStackRow title="Clear agent memory" description="Wipe stored memories, connected credentials, model overrides, and local preferences.">
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
                                    appStorage.removeItem(MODEL_FAST_PREFERENCES_KEY);
                                    appStorage.removeItem(MODEL_API_KEYS_STORAGE_KEY);
                                    appStorage.removeItem(MODEL_API_KEY_PRESENCE_STORAGE_KEY);
                                    appStorage.removeItem(MODEL_THINKING_CAPABILITIES_STORAGE_KEY);
                                    appStorage.removeItem(MODEL_WIRE_CAPABILITIES_STORAGE_KEY);
                                    appStorage.removeItem(MODEL_THINKING_LEVELS_STORAGE_KEY);
                                    appStorage.removeItem(MODEL_CONTEXT_WINDOWS_STORAGE_KEY);
                                    appStorage.removeItem(PROVIDER_BASE_URLS_STORAGE_KEY);
                                    MODEL_PROVIDER_ORDER.forEach(invalidateProviderModelCatalog);
                                    appStorage.removeItem(CHAT_CONTEXT_WINDOW_OVERRIDES_STORAGE_KEY);
                                    settingsRef.current = DEFAULT_SETTINGS;
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
                                    setModelEntries([]);
                                    setModelApiKeys({});
                                    providerBaseURLDirtyRef.current = true;
                                    setProviderBaseURLs({});
                                    setContextChatOverrides({});
                                    setSelectedApiProviderValue('gemini');
                                    setSelectedApiModelValue('');
                                    setApiSyncStatus('idle');
                                    setApiSyncMessage('Add a provider key to activate the local runtime gateway.');
                                    setApiProviderStatus([]);
                                    broadcastEterxSettingsUpdate(DEFAULT_SETTINGS);
                                    setHasChanges(false);
                                    void (async () => {
                                      try {
                                        await Promise.all([
                                          (window as any)?.electronAPI?.clearSecureRuntimeSettings?.(),
                                          getDesktopSubscription()?.disconnectAll?.(),
                                          disconnectAntigravityAccounts().catch(error => console.warn('Could not disconnect Antigravity accounts:', error)),
                                          clearNativeProviderAccounts().catch(error => console.warn('Could not disconnect local provider accounts:', error)),
                                        ]);
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
                                    modelCatalog: entriesToModelCatalog(modelEntries),
                                    modelEntries,
                                    note: 'API keys are intentionally excluded from exports. Re-enter them in Settings on the destination machine.',
                                  }, null, 2);
                                  const blob = new Blob([data], { type: 'application/json' });
                                  const url = URL.createObjectURL(blob);
                                  const a = document.createElement('a');
                                  a.href = url; a.download = 'eterx-settings.json';
                                  document.body.appendChild(a); a.click(); a.remove();
                                  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
                        <div className="flex min-h-full flex-col">
                          <SectionHeader title="Application updates" />
                          <div>
                          {installResult && (
                            <p role="status" className={`mb-4 rounded-xl border px-4 py-3 text-[12px] leading-relaxed ${
                              installResult.status === 'succeeded'
                                ? 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-400'
                                : 'border-amber-500/20 bg-amber-500/[0.06] text-amber-400'
                            }`}>
                              {installResult.message}
                            </p>
                          )}
                          <div className="mb-5 rounded-xl border border-white/[0.07] bg-white/[0.025] p-5">
                            <div className="flex items-start justify-between gap-5">
                              <div>
                                <div className="text-[15px] font-semibold text-[#F1F1F1]">EterX {updateState.currentVersion}</div>
                                {!quietUpdateCheck && updateState.message && (
                                  <div className={`mt-1.5 text-[13px] leading-relaxed ${updateState.status === 'error' ? 'text-red-400' : 'text-[#9A9A9A]'}`}>
                                    {updateState.message}
                                  </div>
                                )}
                              </div>
                              {(!quietUpdateCheck || updateState.checking) && (
                              <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                                updateState.status === 'current' || updateState.status === 'ready' || updateState.status === 'installing' ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400' :
                                updateState.status === 'available' || updateState.status === 'downloading' ? 'border-blue-500/25 bg-blue-500/10 text-blue-400' :
                                updateState.status === 'pending' ? 'border-amber-500/25 bg-amber-500/10 text-amber-400' :
                                updateState.status === 'error' ? 'border-red-500/25 bg-red-500/10 text-red-400' :
                                'border-white/[0.08] bg-white/[0.04] text-[#B8B8B8]'
                              }`}>
                                {updateState.checking ? 'Checking…' :
                                  updateState.status === 'pending' ? 'Preparing release' :
                                  updateState.status === 'current' ? 'Up to date' :
                                  updateState.status === 'ready' ? 'Ready' :
                                  updateState.status === 'installing' ? 'Restarting' :
                                  updateState.status.charAt(0).toUpperCase() + updateState.status.slice(1)}
                              </span>
                              )}
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
                                <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]" role="progressbar" aria-label="Update download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(updateState.percent)}>
                                  <div className="h-full rounded-full bg-[#168eea] transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, updateState.percent))}%` }} />
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

                            <div data-settings-search-target="update-actions" tabIndex={-1} className="flex flex-wrap gap-3">
                            {updateState.status === 'installing' ? (
                              <SoftButton disabled>Restarting to update...</SoftButton>
                            ) : updateState.status === 'ready' || (
                              updateState.status === 'error' && Boolean(updateState.availableVersion) && updateState.downloadReady
                            ) ? (
                              <SoftButton disabled={Boolean(updateActionPending)} onClick={() => void runUpdateAction('installUpdate')}>
                                {updateState.status === 'error' ? 'Retry restart and update' : 'Restart to update'}
                              </SoftButton>
                            ) : updateState.status === 'available' || (
                              updateState.status === 'error' && Boolean(updateState.availableVersion) && !updateState.downloadReady
                            ) ? (
                              <SoftButton disabled={Boolean(updateActionPending) || updateState.checking} onClick={() => void runUpdateAction('downloadUpdate')}>
                                {updateState.status === 'error' ? 'Retry download' : `Download EterX ${updateState.availableVersion}`}
                              </SoftButton>
                            ) : (
                              <SoftButton
                                disabled={Boolean(updateActionPending) || updateState.checking || updateState.status === 'checking' || updateState.status === 'downloading' || updateState.status === 'development' || updateState.status === 'unsupported'}
                                onClick={() => void runUpdateAction('checkForUpdates')}
                              >
                                {updateState.checking || updateState.status === 'checking' ? 'Checking…' : updateState.status === 'downloading' ? 'Downloading…' : updateState.status === 'unsupported' ? 'Updates unavailable' : 'Check for updates'}
                              </SoftButton>
                            )}
                            {(updateState.status === 'available' || (updateState.status === 'error' && updateState.availableVersion && !updateState.downloadReady)) && (
                              <SoftButton disabled={Boolean(updateActionPending) || updateState.checking} onClick={() => void runUpdateAction('checkForUpdates')}>
                                {updateState.checking ? 'Checking…' : 'Check again'}
                              </SoftButton>
                            )}
                            {!quietUpdateCheck && (updateState.status === 'error' || updateState.status === 'pending' || updateState.status === 'unsupported') && updateState.releasePage && (
                              <a href={updateState.releasePage} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-lg bg-white/[0.08] px-3 py-2 text-[13px] font-medium text-[#E8E6E3] hover:bg-white/[0.12]">
                                Open official releases
                              </a>
                            )}
                          </div>

                          {updateActionError && <p role="alert" className="mt-3 text-[12px] text-red-400">{updateActionError}</p>}
                          {updateState.checkErrorVisible && updateState.checkError && updateState.availableVersion && (
                            <p role="alert" className="mt-3 text-[12px] text-red-400">{updateState.checkError}</p>
                          )}

                          <p className="mt-5 text-[12px] leading-relaxed text-[#666]">
                            {updateState.automaticChecks
                              ? 'EterX checks for updates after launch, every 30 minutes while visible, and when you return after a period away. Failed checks retry automatically.'
                              : 'Automatic update checks are not active in this installation.'}
                            {' '}When available, use Check for updates to start a manual check. Download an available version and restart EterX when convenient. Your chats, workspaces, API settings, browser profiles, and preferences are preserved. The update result appears here after restart.
                          </p>
                          {updateState.releaseDate && updateState.availableVersion && (
                            <p className="mt-2 text-[11px] text-[#555]">
                              Release {updateState.releaseName || `EterX ${updateState.availableVersion}`} published {new Date(updateState.releaseDate).toLocaleString()}
                            </p>
                          )}
                          {updateState.lastCheckedAt && (
                            <p className="mt-2 text-[11px] text-[#555]">
                              Last successful check {new Date(updateState.lastCheckedAt).toLocaleString()}
                            </p>
                          )}
                          {updateState.nextCheckAt && (
                            <p className="mt-2 text-[11px] text-[#555]">Next automatic check around {new Date(updateState.nextCheckAt).toLocaleTimeString()}</p>
                          )}
                          </div>
                          <div data-settings-search-target="release-notes" tabIndex={-1}><UpdateWhatsNew state={updateState} /></div>
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
                                className="bg-transparent border-b border-white/[0.1] focus:border-white/25 outline-hidden text-[15px] font-semibold text-[#E8E6E3] w-full pb-0.5 mb-1 transition-colors"
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
                            settingsRef.current = DEFAULT_SETTINGS;
                            transitionEterxTheme(DEFAULT_SETTINGS.theme, () => {
                              flushSync(() => setSettings(DEFAULT_SETTINGS));
                            });
                            updateSetting('computerUse', DEFAULT_SETTINGS.computerUse);
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
