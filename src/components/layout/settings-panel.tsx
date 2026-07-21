'use client';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { MAIN_AGENT_MODEL_OPTIONS, normalizeModelThinkingCapabilities, type MainAgentMode, type MainAgentProvider, type ModelThinkingCapabilities } from '../../lib/agent/model-routing';
import {
  AUTO_MODEL_SELECTION,
  CHAT_MODEL_SELECTION_STORAGE_KEY,
  MODEL_API_KEYS_STORAGE_KEY,
  MODEL_CATALOG_STORAGE_KEY,
  MODEL_OVERRIDE_STORAGE_KEY,
  MODEL_PROVIDER_MODE,
  MODEL_PROVIDER_ORDER,
  MODEL_SELECTOR_STORAGE_KEY,
  MODEL_THINKING_CAPABILITIES_STORAGE_KEY,
  composeApiKeysForSelection,
  entriesToModelCatalog,
  ensureModelSelectorEntry,
  isModelProvider,
  modelEntryKey,
  normalizeModelSelectorEntries,
  parseModelEntryKey,
  removeModelSelectorEntry,
  type ModelSelectorEntry,
} from '../../lib/agent/model-selector-store';
import { applyEterxTheme, broadcastEterxSettingsUpdate } from '../theme/theme-bridge';

type SettingsGlyphProps = React.SVGProps<SVGSVGElement> & { strokeWidth?: number };

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
);

const Key = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <circle cx="8.2" cy="12" r="3.2" />
    <path d="M11.4 12h7.4M15.6 12v2.2M18.8 12v-2.2" />
  </SettingsGlyph>
);

const Zap = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <path d="m13.4 2.9-7.1 10h5.05l-.75 8.2 7.1-10h-5.05l.75-8.2Z" />
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

const FolderOpen = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <path d="M3.9 8.2c0-1.25 1-2.25 2.25-2.25h4l1.75 1.9h5.95c1.25 0 2.25 1 2.25 2.25v1.3H3.9V8.2Z" />
    <path d="M4.95 11.4h14.1c1 0 1.75.92 1.55 1.9l-.88 4.35a2.3 2.3 0 0 1-2.25 1.85H6.53a2.3 2.3 0 0 1-2.25-1.85L3.4 13.3c-.2-.98.55-1.9 1.55-1.9Z" />
  </SettingsGlyph>
);

const RefreshCw = (props: SettingsGlyphProps) => (
  <SettingsGlyph {...props}>
    <path d="M19.2 7.3a7.7 7.7 0 0 0-13.05-1.2L4.4 8.1M4.8 16.7a7.7 7.7 0 0 0 13.05 1.2l1.75-2" />
    <path d="M4.1 4.7v3.7h3.7M19.9 19.3v-3.7h-3.7" />
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
export interface AppSettings {
  // General
  theme: 'dark' | 'light' | 'system';
  userName: string;
  customInstructions: string;
  fontSize: 'compact' | 'default' | 'comfortable';
  workMode: 'specialist' | 'everyday';
  openDestination: 'eterx' | 'workspace' | 'last';
  terminalShell: 'powershell' | 'cmd' | 'git-bash' | 'wsl';
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
  groundingSearch: boolean;
  streamResponses: boolean;
  maxRetries: number;
  defaultPermissions: boolean;
  autoReview: boolean;
  fullAccess: boolean;
  shellIntegration: boolean;
  autoOpenEditedFiles: boolean;

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
  archiveRetention: '30' | '90' | 'forever';
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  userName: 'Developer',
  customInstructions: '',
  fontSize: 'default',
  workMode: 'everyday',
  openDestination: 'eterx',
  terminalShell: 'powershell',
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
  groundingSearch: true,
  streamResponses: true,
  maxRetries: 2,
  defaultPermissions: true,
  autoReview: true,
  fullAccess: false,
  shellIntegration: true,
  autoOpenEditedFiles: true,
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
  archiveRetention: '90',
};

type Tab =
  | 'general'
  | 'profile'
  | 'appearance'
  | 'configuration'
  | 'personalization'
  | 'shortcuts'
  | 'mcp'
  | 'hooks'
  | 'models'
  | 'api'
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
  error?: string;
};

type ModelDirectory = Record<string, ModelDirectoryProvider>;
type ModelOverrides = Record<string, string>;
type ModelCatalog = Record<string, string[]>;
type ProviderModelOption = { id: string; label: string; source: 'selected' | 'saved' | 'official' | 'live' };
type DesktopUpdateState = {
  status: 'idle' | 'development' | 'checking' | 'downloading' | 'current' | 'ready' | 'error';
  currentVersion: string;
  availableVersion?: string | null;
  percent: number;
  message: string;
};

const splitApiKeyPool = (value: string | undefined) =>
  String(value || '')
    .split(/[\n,]/)
    .map(key => key.trim())
    .filter(Boolean);

const serializeApiKeyPool = (keys: string[]) =>
  keys.map(key => key.trim()).filter(Boolean).join('\n');

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
  return value.length >= 12;
};

const PROVIDER_LABEL: Record<string, string> = {
  gemini: 'Google Gemini',
  mistral: 'Mistral',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  anthropic: 'Anthropic',
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

const PROVIDER_ICON_PATH: Record<string, string> = {
  gemini: '/icons/providers/gemini.svg',
  mistral: '/icons/providers/mistral.svg',
  openai: '/icons/providers/openai.svg',
  openrouter: '/icons/providers/openrouter.svg',
  groq: '/icons/providers/groq.svg',
  anthropic: '/icons/providers/anthropic.svg',
};

const PROVIDER_ICON_COLOR: Record<string, string> = {
  gemini: '#8AB4F8',
  mistral: '#FFAF00',
  groq: '#F55036',
};

const PROVIDER_ICON_MASK_SIZE: Record<string, string> = {
  gemini: '76%',
  mistral: '82%',
  openai: '86%',
  openrouter: '84%',
  groq: '86%',
  anthropic: '82%',
};

const OFFICIAL_PROVIDER_GUIDE: Record<string, {
  source: string;
  keySource: string;
  endpoint: string;
  docsUrl: string;
  families: Array<{ name: string; id?: string; note: string }>;
}> = {
  gemini: {
    source: 'Google AI Studio / Gemini API',
    keySource: 'Google AI Studio API key',
    endpoint: 'GET /v1beta/models',
    docsUrl: 'ai.google.dev/api/models',
    families: [
      { name: 'Gemini 3.5 Flash', id: 'gemini-3.5-flash', note: 'Stable frontier model for sustained agent and coding work' },
      { name: 'Gemini 3.1 Pro Preview', id: 'gemini-3.1-pro-preview', note: 'Advanced reasoning, multimodal work, and high-autonomy tasks' },
      { name: 'Gemini 3 Flash Preview', id: 'gemini-3-flash-preview', note: 'Preview 3-series model for fast, capable agent runs' },
      { name: 'Gemini 3.1 Flash-Lite', id: 'gemini-3.1-flash-lite', note: 'Fast low-cost 3-series option for routine tasks' },
      { name: 'Gemini 2.5 Pro', id: 'gemini-2.5-pro', note: 'Stable complex reasoning, coding, and multimodal understanding' },
      { name: 'Gemini 2.5 Flash', id: 'gemini-2.5-flash', note: 'Stable price-performance fallback with thinking support' },
      { name: 'Gemini 3.1 Flash Live', id: 'gemini-3.1-flash-live-preview', note: 'Low-latency Live API model for voice-first flows' },
    ],
  },
  mistral: {
    source: 'Mistral AI Platform',
    keySource: 'Mistral API key',
    endpoint: 'GET /v1/models',
    docsUrl: 'docs.mistral.ai/models',
    families: [
      { name: 'Mistral Medium 3.5', id: 'mistral-medium-3-5', note: 'Frontier multimodal model optimized for agentic and coding use cases' },
      { name: 'Mistral Medium (latest)', id: 'mistral-medium-2508', note: 'Proven medium-tier model' },
      { name: 'Mistral Large 3', id: 'mistral-large-2512', note: 'High-capability open-weight multimodal model' },
      { name: 'Mistral Small 4', id: 'mistral-small-2603', note: 'Efficient hybrid instruct, reasoning, and coding model' },
      { name: 'Ministral 3 14B', id: 'ministral-14b-2512', note: 'Vision-capable efficient generalist model' },
      { name: 'Codestral', id: 'codestral-2508', note: 'Code completion and developer workflow model' },
    ],
  },
  anthropic: {
    source: 'Anthropic Console / Claude API',
    keySource: 'Anthropic Console workspace key',
    endpoint: 'GET /v1/models',
    docsUrl: 'docs.anthropic.com',
    families: [
      { name: 'Claude Sonnet 5', id: 'claude-sonnet-5', note: 'Balanced speed, intelligence, and extended thinking' },
      { name: 'Claude Fable 5', id: 'claude-fable-5', note: 'Preview frontier model for high-autonomy coding' },
      { name: 'Claude Mythos 5', id: 'claude-mythos-5', note: 'Approved customer preview model via Project Glasswing' },
      { name: 'Claude Opus 4.8', id: 'claude-opus-4-8', note: 'Most capable Claude model for complex reasoning and agentic coding' },
      { name: 'Claude Haiku 4.5', id: 'claude-haiku-4-5', note: 'Fastest 4.5-series model with high intelligence' },
      { name: 'Claude Sonnet 4.6', id: 'claude-sonnet-4-6', note: 'Previous Sonnet fallback' },
    ],
  },
  openai: {
    source: 'OpenAI Platform',
    keySource: 'OpenAI project API key',
    endpoint: 'GET /v1/models',
    docsUrl: 'platform.openai.com/docs/models',
    families: [
      { name: 'GPT-5.6 Sol', id: 'gpt-5.6-sol', note: 'Flagship model for complex professional reasoning, coding, and general tasks' },
      { name: 'GPT-5.6 Luna Pro', id: 'gpt-5.6-luna-pro', note: 'Affordable high-context flagship model' },
      { name: 'GPT-5.6 Luna', id: 'gpt-5.6-luna', note: 'More affordable flagship model for coding' },
      { name: 'GPT-5.6 Terra Pro', id: 'gpt-5.6-terra-pro', note: 'Fast option for coding, computer use, and sub-agents' },
      { name: 'GPT-5.6 Terra', id: 'gpt-5.6-terra', note: 'Low latency fallback model' },
      { name: 'GPT-5.5', id: 'gpt-5.5', note: 'Stable 5-series model' },
      { name: 'OpenAI o3-pro', id: 'o3-pro', note: 'Flagship deep reasoning model' },
      { name: 'OpenAI o3', id: 'o3', note: 'Standard deep reasoning model' },
      { name: 'OpenAI o4-mini', id: 'o4-mini', note: 'High-speed mini reasoning model' },
      { name: 'GPT-5.4 Pro', id: 'gpt-5.4-pro', note: 'Precision coding model' },
      { name: 'GPT-5.4 mini', id: 'gpt-5.4-mini', note: 'Strongest mini model for computer/agent use' },
      { name: 'GPT-4o', id: 'gpt-4o', note: 'Stable legacy fallback model' },
    ],
  },
  openrouter: {
    source: 'OpenRouter',
    keySource: 'OpenRouter API key',
    endpoint: 'GET /api/v1/models',
    docsUrl: 'openrouter.ai/docs',
    families: [
      { name: 'GPT-5.6 Luna', id: 'openai/gpt-5.6-luna', note: 'OpenAI flagship through OpenRouter' },
      { name: 'GPT-5.6 Terra', id: 'openai/gpt-5.6-terra', note: 'OpenAI fast model through OpenRouter' },
      { name: 'Claude Sonnet 5', id: 'anthropic/claude-sonnet-5', note: 'Anthropic flagship through OpenRouter' },
      { name: 'Claude Fable 5', id: 'anthropic/claude-fable-5', note: 'Anthropic preview flagship through OpenRouter' },
      { name: 'Gemini 3.5 Flash', id: 'google/gemini-3.5-flash', note: 'Google Gemini routed through OpenRouter' },
      { name: 'Grok 4.5', id: 'x-ai/grok-4.5', note: 'xAI flagship through OpenRouter' },
      { name: 'Full OpenRouter catalog', note: 'Live endpoint loads hundreds of provider models automatically' },
    ],
  },
  groq: {
    source: 'GroqCloud',
    keySource: 'Groq API key',
    endpoint: 'GET /openai/v1/models',
    docsUrl: 'console.groq.com/docs/models',
    families: [
      { name: 'Llama 3.3 70B Versatile', id: 'llama-3.3-70b-versatile', note: 'Production Llama model with a large context window' },
      { name: 'Llama 3.1 8B Instant', id: 'llama-3.1-8b-instant', note: 'Production ultra-fast small model for quick tasks' },
    ],
  },
};

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: Tab | LegacyTab;
  standalone?: boolean;
}

const normalizeSettingsTab = (tab: any): Tab => {
  const validTabs: Tab[] = [
    'general',
    'profile',
    'appearance',
    'configuration',
    'personalization',
    'shortcuts',
    'mcp',
    'hooks',
    'models',
    'api',
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
    onClick={() => !disabled && onChange(!enabled)}
    className={`relative w-[42px] h-[24px] rounded-full transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] shrink-0 ${ disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
      } ${ enabled ? 'bg-[#2F8BEF] shadow-[0_0_10px_rgba(47,139,239,0.22)]' : 'bg-white/10 hover:bg-white/15' }`}
  >
    <motion.div
      animate={{ x: enabled ? 20 : 2 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      className="absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white shadow-md"
    />
  </button>
);

// ─── Slider ────────────────────────────────────────────
const SettingSlider: React.FC<{ value: number; min: number; max: number; onChange: (v: number) => void; label: string }> = ({ value, min, max, onChange, label }) => (
  <div className="flex items-center gap-3 w-full">
    <input
      type="range"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(parseInt(e.target.value))}
      className="flex-1 h-1 bg-white/10 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white/85 [&::-webkit-slider-thumb]:shadow-[0_0_8px_rgba(255,255,255,0.18)] [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-125"
    />
    <span className="text-[13px] font-mono text-[#DCD8D2] min-w-[28px] text-right">{value}</span>
  </div>
);

// ─── Setting Row ───────────────────────────────────────
const SettingRow: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
  danger?: boolean;
}> = ({ icon, title, description, children, danger }) => (
  <div className={`mb-2 flex items-center justify-between rounded-lg border px-5 py-4 group ${ danger ? 'border-red-500/20 bg-red-500/10' : 'border-white/[0.08] bg-[#202020]' }`}>
    <div className="flex items-start gap-3 flex-1 min-w-0 mr-4">
      <div className={`hidden sm:flex mt-0.5 p-1.5 rounded-md shrink-0 ${ danger ? 'bg-red-500/10 text-red-400' : 'text-[#A8A8A8] group-hover:text-[#F1F1F1]' } transition-colors`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className={`text-[13.5px] font-medium ${ danger ? 'text-red-300' : 'text-[#F1F1F1]' }`}>{title}</div>
        <div className="text-[13px] text-[#A5A5A5] mt-1 leading-relaxed">{description}</div>
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
    <span className="pointer-events-none absolute left-1/2 top-[calc(100%+8px)] z-[80] w-[260px] -translate-x-1/2 rounded-xl border border-white/[0.10] bg-[#111111] px-3 py-2 text-[11.5px] font-medium leading-5 text-[#D6D6D6] opacity-0 shadow-[0_16px_42px_rgba(0,0,0,0.48)] transition-opacity duration-150 group-hover/info:opacity-100">
      {text}
    </span>
  </span>
);

const SectionHeader: React.FC<{ title: string; badge?: string; info?: string }> = ({ title, badge, info }) => (
  <div className="flex items-center gap-2 mb-4 mt-10 first:mt-0">
    <span className="text-[14px] font-semibold text-[#F1F1F1] tracking-tight">{title}</span>
    {info && <InfoHint text={info} />}
    {badge && (
      <span className="text-[10px] font-bold bg-white/[0.075] text-[#D7D7D7] px-2 py-0.5 rounded-full tracking-wider uppercase">{badge}</span>
    )}
  </div>
);

// ─── API Key Row ───────────────────────────────────────
const SettingsStack: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="overflow-visible rounded-xl border border-white/[0.09] bg-[#202020]">
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
  <div className={`flex ${tall ? 'flex-col items-start gap-3' : 'items-center justify-between gap-6'} border-b border-white/[0.07] px-5 last:border-b-0 ${tall ? 'py-4' : 'py-3.5'}`}>
    <div className={`min-w-0 ${tall ? 'w-full' : 'flex-1'}`}>
      <div className="flex items-center gap-2 text-[13px] font-medium leading-tight text-[#F1F1F1]">
        <span>{title}</span>
        {info && <InfoHint text={info} />}
      </div>
      {description && <div className="mt-1 max-w-full text-[12px] leading-relaxed text-[#A7A7A7]">{description}</div>}
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
        onClick={() => onChange(option.value)}
        className={`rounded-full px-2.5 py-1 text-[12.5px] font-medium transition-colors ${
          value === option.value ? 'bg-[#303030] text-[#F2F2F2]' : 'text-[#A7A7A7] hover:bg-white/[0.045] hover:text-[#F2F2F2]'
        }`}
      >
        {option.label}
      </button>
    ))}
  </div>
);

const SoftButton: React.FC<{ children: React.ReactNode; onClick?: () => void; disabled?: boolean }> = ({ children, onClick, disabled = false }) => (
  <button
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
  scopeControl?: React.ReactNode;
}> = ({ provider, providerLabel, value, sync, onChange, minRows = 1, scopeControl }) => {
  const buildRows = useCallback((rawValue: string) => {
    const parsed = splitApiKeyPool(rawValue);
    const rowCount = Math.max(minRows, parsed.length || 1);
    return Array.from({ length: rowCount }, (_, index) => parsed[index] || '');
  }, [minRows]);

  const [rows, setRows] = useState<string[]>(() => {
    const parsed = splitApiKeyPool(value);
    const rowCount = Math.max(minRows, parsed.length || 1);
    return Array.from({ length: rowCount }, (_, index) => parsed[index] || '');
  });
  const [visibleRows, setVisibleRows] = useState<Record<number, boolean>>({});
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [testingStatus, setTestingStatus] = useState<Record<number, 'idle' | 'testing' | 'success' | 'failed'>>({});

  useEffect(() => {
    setRows(buildRows(value));
  }, [buildRows, provider, value]);

  useEffect(() => {
    setVisibleRows({});
    setCopiedIndex(null);
    setDraggedIndex(null);
    setTestingStatus({});
  }, [provider]);

  const commitRows = useCallback((nextRows: string[]) => {
    onChange(serializeApiKeyPool(nextRows));
  }, [onChange]);

  const testKeyConnection = async (index: number, key: string) => {
    if (!key.trim()) return;
    setTestingStatus(prev => ({ ...prev, [index]: 'testing' }));
    try {
      const res = await fetch('/api/settings/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKeys: { [provider]: key.trim() },
          providers: [provider]
        }),
      });
      const data = await res.json();
      if (res.ok && data?.ok && data?.providers?.[provider]?.connected) {
        setTestingStatus(prev => ({ ...prev, [index]: 'success' }));
      } else {
        setTestingStatus(prev => ({ ...prev, [index]: 'failed' }));
      }
    } catch {
      setTestingStatus(prev => ({ ...prev, [index]: 'failed' }));
    }
  };

  const updateRow = (index: number, rawValue: string) => {
    setTestingStatus(prev => ({ ...prev, [index]: 'idle' }));
    const pastedKeys = splitApiKeyPool(rawValue);
    setRows(prev => {
      const next = [...prev];
      if (pastedKeys.length > 1) {
        next.splice(index, 1, ...pastedKeys);
      } else {
        next[index] = rawValue;
      }
      commitRows(next);
      return next.length ? next : buildRows('');
    });
  };

  const addRow = () => {
    setRows(prev => [...prev, '']);
  };

  const moveRow = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    setRows(prev => {
      if (fromIndex >= prev.length || toIndex >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      commitRows(next);
      return next;
    });
  };

  const removeRow = (index: number) => {
    setRows(prev => {
      const next = prev.filter((_, rowIndex) => rowIndex !== index);
      const safeNext = next.length >= minRows
        ? next
        : [...next, ...Array.from({ length: minRows - next.length }, () => '')];
      commitRows(safeNext);
      return safeNext;
    });
  };

  const clearPool = () => {
    setRows(buildRows(''));
    commitRows([]);
  };

  const copyRow = async (index: number, key: string) => {
    if (!key.trim()) return;
    try {
      await navigator.clipboard?.writeText(key.trim());
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex(null), 900);
    } catch {
      setCopiedIndex(null);
    }
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
          <button
            type="button"
            onClick={addRow}
            className="inline-flex h-8 items-center gap-1 rounded-lg bg-[#303030] px-2.5 text-[12px] font-medium text-[#F2F2F2] transition-colors hover:bg-[#393939]"
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </button>
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
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8E8E8E]">
                    Slot {String(index + 1).padStart(2, '0')}
                  </span>
                </div>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${
                  rowStatus === 'Ready'
                    ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
                    : rowStatus === 'Check' || rowStatus === 'Duplicate'
                      ? 'border-amber-500/20 bg-amber-500/10 text-amber-300'
                      : 'border-white/[0.08] bg-white/[0.035] text-[#777]'
                }`}>
                  {rowStatus}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={row}
                  onChange={(event) => updateRow(index, event.target.value)}
                  type={isVisible ? 'text' : 'password'}
                  spellCheck={false}
                  placeholder={index === 0 ? 'Paste provider API key' : 'Paste another key'}
                  className="h-9 min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-[#141414] px-3 text-[12px] font-mono text-[#F1F1F1] outline-none transition-colors placeholder:text-[#666] focus:border-white/[0.20]"
                />
                <button
                  type="button"
                  onClick={() => setVisibleRows(prev => ({ ...prev, [index]: !prev[index] }))}
                  className="grid h-9 w-9 place-items-center rounded-lg bg-white/[0.045] text-[#A7A7A7] transition-colors hover:bg-white/[0.08] hover:text-[#F1F1F1]"
                  title={isVisible ? 'Hide key' : 'Show key'}
                >
                  {isVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
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

const SettingsIconAsset: React.FC<{ name: string; className?: string }> = ({ name, className = 'h-4 w-4' }) => (
  <span
    aria-hidden="true"
    className={`inline-block shrink-0 bg-current ${className}`}
    style={{
      WebkitMask: `url(/icons/settings/${name}.svg) center / contain no-repeat`,
      mask: `url(/icons/settings/${name}.svg) center / contain no-repeat`,
    }}
  />
);

const ProviderIconAsset: React.FC<{ provider: string; className?: string }> = ({ provider, className = 'h-4 w-4' }) => {
  const iconPath = PROVIDER_ICON_PATH[provider];
  if (!iconPath) return <Key className={className} />;
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

const ModernSelect: React.FC<{
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; description?: string }>;
  placeholder?: string;
  className?: string;
}> = ({ value, onChange, options, placeholder = 'Select', className = '' }) => {
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        className="flex h-9 w-full items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#2D2D2D] px-3 text-left text-[13px] font-medium text-[#F2F2F2] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] outline-none transition-colors hover:bg-[#363636] focus:border-white/[0.20]"
      >
        <span className="truncate">{selected?.label || placeholder}</span>
        <ChevronRight className={`h-4 w-4 shrink-0 text-[#A7A7A7] transition-transform ${open ? '-rotate-90' : 'rotate-90'}`} />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 max-h-72 w-full min-w-[240px] overflow-y-auto rounded-xl border border-white/[0.10] bg-[#242424] p-1 shadow-[0_18px_48px_rgba(0,0,0,0.45)] eterx-scrollbar">
          {options.map(option => (
            <button
              key={option.value}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                onChange(option.value);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[12.5px] transition-colors ${
                value === option.value ? 'bg-white/[0.08] text-[#F4F4F4]' : 'text-[#CFCFCF] hover:bg-white/[0.055] hover:text-[#F4F4F4]'
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
  const label = PROVIDER_LABEL[value] || value || 'Select provider';

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        className="flex h-9 w-full items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#2D2D2D] px-3 text-left text-[13px] font-medium text-[#F2F2F2] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] outline-none transition-colors hover:bg-[#363636] focus:border-white/[0.20]"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ProviderMark provider={value} />
          <span className="truncate">{label}</span>
        </span>
        <ChevronRight className={`h-4 w-4 shrink-0 text-[#A7A7A7] transition-transform ${open ? '-rotate-90' : 'rotate-90'}`} />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 max-h-72 w-full min-w-[240px] overflow-y-auto rounded-xl border border-white/[0.10] bg-[#242424] p-1 shadow-[0_18px_48px_rgba(0,0,0,0.45)] eterx-scrollbar">
          {providers.map(provider => (
            <button
              key={provider}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                onChange(provider);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-[12.5px] transition-colors ${
                value === provider ? 'bg-white/[0.08] text-[#F4F4F4]' : 'text-[#CFCFCF] hover:bg-white/[0.055] hover:text-[#F4F4F4]'
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <ProviderMark provider={provider} />
                <span className="truncate">{PROVIDER_LABEL[provider] || provider}</span>
              </span>
              {value === provider && <Check className="h-3.5 w-3.5 shrink-0" />}
            </button>
          ))}
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

  const handleCopy = () => {
    if (!keyValue) return;
    navigator.clipboard.writeText(keyValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mb-2 rounded-lg border border-white/[0.08] bg-[#202020] px-5 py-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${
            rowStatus === 'ready'
              ? 'bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.28)]'
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
          <span className={`hidden sm:inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${
            rowStatus === 'ready'
              ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
              : rowStatus === 'error'
                ? 'border-red-500/20 bg-red-500/10 text-red-300'
                : 'border-white/[0.08] bg-white/[0.03] text-[#777]'
          }`}>
            {rowStatus === 'ready' ? 'Ready' : rowStatus === 'error' ? 'Check' : 'Missing'}
          </span>
          <button onClick={() => setVisible(!visible)} className="p-1.5 rounded-md hover:bg-white/5 text-[#555] hover:text-[#E8E6E3] transition-colors" title={visible ? 'Hide' : 'Show'}>
            {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
          <button onClick={handleCopy} className="p-1.5 rounded-md hover:bg-white/5 text-[#555] hover:text-[#E8E6E3] transition-colors" title="Copy">
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
          <button onClick={() => { onUpdate(draft); setEditing(false); }} className="px-3 py-2 bg-white/[0.08] text-[#E8E6E3] rounded-lg text-[12px] font-medium hover:bg-white/[0.12] transition-colors">Save</button>
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
export const SettingsPanel: React.FC<SettingsPanelProps> = ({ isOpen, onClose, initialTab = 'general', standalone = false }) => {
  const [activeTab, setActiveTab] = useState<Tab>(normalizeSettingsTab(initialTab));
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [apiSyncStatus, setApiSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'error'>('idle');
  const [apiSyncMessage, setApiSyncMessage] = useState('Runtime keys are local until synced.');
  const [apiProviderStatus, setApiProviderStatus] = useState<ApiProviderStatus[]>([]);
  const [modelDirectory, setModelDirectory] = useState<ModelDirectory>({});
  const [modelDirectoryStatus, setModelDirectoryStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [modelDirectoryUpdatedAt, setModelDirectoryUpdatedAt] = useState<number | null>(null);
  const [modelOverrides, setModelOverrides] = useState<ModelOverrides>({});
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>({});
  const [modelEntries, setModelEntries] = useState<ModelSelectorEntry[]>([]);
  const [modelThinkingCapabilities, setModelThinkingCapabilities] = useState<Record<string, ModelThinkingCapabilities>>({});
  const [modelApiKeys, setModelApiKeys] = useState<Record<string, string>>({});
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
  const [updateState, setUpdateState] = useState<DesktopUpdateState>({
    status: 'development',
    currentVersion: 'development',
    percent: 0,
    message: 'Desktop updates are available in the installed application.',
  });

  const handleToggleDefaultPerms = useCallback((v: boolean) => {
    if (!v) {
      setDefaultPermsActive(false);
      setTimeout(() => {
        setDefaultPermsActive(true);
      }, 1000);
    }
  }, []);

  const handleToggleFullAccess = useCallback((v: boolean) => {
    if (!v) {
      setFullAccessActive(false);
      setTimeout(() => {
        setFullAccessActive(true);
      }, 1000);
    }
  }, []);

  const keysChangedRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    const desktopApi = (window as any)?.electronAPI;
    let unsubscribe: undefined | (() => void);
    if (typeof desktopApi?.getUpdateState === 'function') {
      desktopApi.getUpdateState().then((state: DesktopUpdateState) => state && setUpdateState(state)).catch(() => {});
      if (typeof desktopApi.onUpdateState === 'function') unsubscribe = desktopApi.onUpdateState(setUpdateState);
    }
    return () => unsubscribe?.();
  }, [isOpen]);

  const persistDesktopRuntimeSettings = useCallback(async (
    nextApiKeys: Record<string, string>,
    nextModelApiKeys: Record<string, string>,
    nextModelOverrides: ModelOverrides,
  ) => {
    const desktopApi = (window as any)?.electronAPI;
    if (typeof desktopApi?.saveSecureRuntimeSettings !== 'function') return;
    try {
      await desktopApi.saveSecureRuntimeSettings({
        apiKeys: nextApiKeys,
        modelApiKeys: nextModelApiKeys,
        modelOverrides: nextModelOverrides,
      });
    } catch (error) {
      console.warn('Could not persist encrypted desktop API settings:', error);
    }
  }, []);

  const eggQuotes = [
    { line1: "BE A MAN.", line2: "FACE DARKNESS" },
    { line1: "NOT AVAILABLE.", line2: "ONLY DARK." },
    { line1: "LIGHT THEME?", line2: "NEVER." },
    { line1: "EMBRACE", line2: "THE VOID." },
    { line1: "LIGHT IS", line2: "FOR THE WEAK." }
  ];

  useEffect(() => {
    if (isOpen) setActiveTab(normalizeSettingsTab(initialTab));
  }, [initialTab, isOpen]);

  const hasAnyApiKey = useCallback((keys: Record<string, string>) =>
    Object.values(keys).some(value => Boolean(String(value || '').trim())), []);

  const refreshModelDirectory = useCallback(async (
    keys: Record<string, string> = composeApiKeysForSelection(apiKeys, modelApiKeys, modelEntries, AUTO_MODEL_SELECTION),
    overrides: ModelOverrides = modelOverrides,
  ) => {
    setModelDirectoryStatus('loading');
    try {
      const res = await fetch('/api/settings/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeys: keys, modelOverrides: overrides }),
      });
      const payload = await res.json();
      if (!res.ok || !payload?.ok) throw new Error(payload?.error || 'Model discovery failed');
      setModelDirectory(payload.providers || {});
      setModelDirectoryUpdatedAt(payload.updatedAt || Date.now());
      setModelDirectoryStatus('ready');
    } catch (error) {
      setModelDirectoryStatus('error');
    }
  }, [apiKeys, modelApiKeys, modelEntries, modelOverrides]);

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

    if (!hasAnyApiKey(cleanKeys) && Object.keys(cleanModelOverrides).length === 0) {
      setApiSyncStatus('idle');
      setApiSyncMessage('Add a provider key to activate the local runtime gateway.');
      setApiProviderStatus([]);
      return;
    }

    if (!silent) {
      setApiSyncStatus('syncing');
      setApiSyncMessage('Syncing keys with the local EterX runtime...');
    }

    try {
      const res = await fetch('/api/settings/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeys: cleanKeys, modelOverrides: cleanModelOverrides }),
      });
      const payload = await res.json();
      if (!res.ok || !payload?.ok) throw new Error(payload?.error || 'Key sync failed');

      setApiProviderStatus(Array.isArray(payload.providers) ? payload.providers : []);
      setApiSyncStatus('synced');
      const modelCount = Array.isArray(payload.modelOverrides)
        ? payload.modelOverrides.filter((item: any) => item?.accepted).length
        : 0;
      setApiSyncMessage(`${ payload.acceptedCount || 0 } key${ payload.acceptedCount === 1 ? '' : 's' } and ${ modelCount } model override${ modelCount === 1 ? '' : 's' } active.`);

      // Auto-refresh model catalog directory to reflect the newly synced keys!
      refreshModelDirectory(
        composeApiKeysForSelection(cleanKeys, modelApiKeys, modelEntries, AUTO_MODEL_SELECTION),
        cleanModelOverrides
      );
    } catch (error: any) {
      setApiSyncStatus('error');
      setApiSyncMessage(error?.message || 'Could not sync API keys.');
    }
  }, [hasAnyApiKey, refreshModelDirectory, modelApiKeys, modelEntries, modelOverrides]);

  const performSync = useCallback(async () => {
    if (!keysChangedRef.current) return;
    keysChangedRef.current = false;
    const selection = localStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) || AUTO_MODEL_SELECTION;
    const composed = composeApiKeysForSelection(apiKeys, modelApiKeys, modelEntries, selection);
    await syncApiKeys(composed, false, modelOverrides);
  }, [apiKeys, modelApiKeys, modelEntries, modelOverrides, syncApiKeys]);

  // Load non-sensitive preferences from localStorage and credentials only from
  // the encrypted Electron store. Existing browser-stored keys are migrated
  // once, immediately removed, and never read by normal runtime features.
  useEffect(() => {
    const loadSettings = async () => {
      try {
      const saved = localStorage.getItem('eterx_settings');
      if (saved) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(saved) });
      const savedKeys = localStorage.getItem('eterx_api_keys');
      const savedModelOverrides = localStorage.getItem(MODEL_OVERRIDE_STORAGE_KEY);
      const savedModelCatalog = localStorage.getItem(MODEL_CATALOG_STORAGE_KEY);
      const savedModelEntries = localStorage.getItem(MODEL_SELECTOR_STORAGE_KEY);
      const savedModelApiKeys = localStorage.getItem(MODEL_API_KEYS_STORAGE_KEY);
      const savedThinkingCapabilities = localStorage.getItem(MODEL_THINKING_CAPABILITIES_STORAGE_KEY);
      const parsedModelOverrides = savedModelOverrides ? JSON.parse(savedModelOverrides) : {};
      const parsedModelCatalog = savedModelCatalog ? JSON.parse(savedModelCatalog) : {};
      const legacyModelApiKeys = savedModelApiKeys ? JSON.parse(savedModelApiKeys) : {};
      const parsedThinkingCapabilities = savedThinkingCapabilities ? JSON.parse(savedThinkingCapabilities) : {};
      const migratedEntries = normalizeModelSelectorEntries(
        savedModelEntries ? JSON.parse(savedModelEntries) : [],
        parsedModelCatalog,
      );
      Object.entries(parsedModelOverrides as Record<string, unknown>).forEach(([provider, modelId]) => {
        if (isModelProvider(provider) && String(modelId || '').trim()) {
          migratedEntries.push({ provider, modelId: String(modelId).trim() });
        }
      });
      const normalizedEntries = normalizeModelSelectorEntries(migratedEntries, parsedModelCatalog);
      const normalizedCatalog = entriesToModelCatalog(normalizedEntries) as ModelCatalog;
      const desktopApi = (window as any)?.electronAPI;
      const secureSettings = typeof desktopApi?.getSecureRuntimeSettings === 'function'
        ? await desktopApi.getSecureRuntimeSettings()
        : null;
      const secureApiKeys = secureSettings?.available && secureSettings.apiKeys && typeof secureSettings.apiKeys === 'object'
        ? secureSettings.apiKeys
        : null;
      const secureModelApiKeys = secureSettings?.available && secureSettings.modelApiKeys && typeof secureSettings.modelApiKeys === 'object'
        ? secureSettings.modelApiKeys
        : null;
      const secureModelOverrides = secureSettings?.available && secureSettings.modelOverrides && typeof secureSettings.modelOverrides === 'object'
        ? secureSettings.modelOverrides
        : null;
      const parsedApiKeys = secureApiKeys || (savedKeys ? JSON.parse(savedKeys) : {});
      const parsedModelApiKeys = secureModelApiKeys || legacyModelApiKeys;
      const effectiveModelOverrides = secureModelOverrides || parsedModelOverrides;
      setModelOverrides(parsedModelOverrides);
      setModelEntries(normalizedEntries);
      setModelCatalog(normalizedCatalog);
      setModelApiKeys(
        parsedModelApiKeys && typeof parsedModelApiKeys === 'object'
          ? Object.fromEntries(
            Object.entries(parsedModelApiKeys as Record<string, unknown>)
              .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : ''])
              .filter(([, value]) => Boolean(value)),
          )
          : {},
      );
      setModelThinkingCapabilities(
        parsedThinkingCapabilities && typeof parsedThinkingCapabilities === 'object'
          ? Object.fromEntries(
            Object.entries(parsedThinkingCapabilities as Record<string, unknown>)
              .map(([key, value]) => [key, normalizeModelThinkingCapabilities(value)] as const)
              .filter(([, value]) => Boolean(value)),
          ) as Record<string, ModelThinkingCapabilities>
          : {},
      );
      localStorage.setItem(MODEL_SELECTOR_STORAGE_KEY, JSON.stringify(normalizedEntries));
      localStorage.setItem(MODEL_CATALOG_STORAGE_KEY, JSON.stringify(normalizedCatalog));
      setModelOverrides(effectiveModelOverrides);
      setApiKeys(parsedApiKeys);

      const usingLegacyBrowserKeys = !secureApiKeys && Boolean(savedKeys || savedModelApiKeys);
      if (usingLegacyBrowserKeys) {
        localStorage.removeItem('eterx_api_keys');
        localStorage.removeItem(MODEL_API_KEYS_STORAGE_KEY);
        await persistDesktopRuntimeSettings(parsedApiKeys, parsedModelApiKeys, effectiveModelOverrides);
      }

      const selection = localStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) || AUTO_MODEL_SELECTION;
      const configuredKeys = composeApiKeysForSelection(parsedApiKeys, parsedModelApiKeys, normalizedEntries, selection);
      const configuredOverrides = Object.fromEntries(
        Object.entries(effectiveModelOverrides)
          .map(([provider, model]) => [provider, String(model || '').trim()])
          .filter(([provider, model]) => isModelProvider(provider) && Boolean(model)),
      );
      if (Object.keys(configuredKeys).length > 0 || Object.keys(configuredOverrides).length > 0) {
        await fetch('/api/settings/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKeys: configuredKeys, modelOverrides: configuredOverrides }),
        });
      }
      } catch (error) {
        console.warn('Could not load runtime settings:', error);
      }
    };
    void loadSettings();
  }, [persistDesktopRuntimeSettings]);

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
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      localStorage.setItem('eterx_settings', JSON.stringify(next));
      if (key === 'theme') applyEterxTheme(value as AppSettings['theme']);
      broadcastEterxSettingsUpdate(next);
      return next;
    });
    setHasChanges(true);
  }, []);

  // Apply theme to DOM — this is what triggers the CSS variable switch
  useEffect(() => {
    const applyTheme = (theme: string) => {
      const resolvedTheme = theme === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : theme;
      const safeTheme = resolvedTheme === 'dark' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', safeTheme);
      document.documentElement.classList.toggle('dark', safeTheme === 'dark');
      document.documentElement.classList.toggle('light', safeTheme === 'light');
      document.documentElement.style.colorScheme = safeTheme;
      (window as any).electronAPI?.setNativeTheme?.(safeTheme);
    };
    const themeForPanel = settings.theme;
    applyTheme(themeForPanel);

    // Listen for OS theme changes when set to 'system'
    if (settings.theme === 'system') {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = (e: MediaQueryListEvent) => applyTheme('system');
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    }
  }, [settings.theme]);

  const handleClose = useCallback(() => {
    void performSync();
    onClose();
  }, [performSync, onClose]);

  const updateApiKey = useCallback((name: string, value: string) => {
    const trimmed = value.trim();
    const next = { ...apiKeys, [name]: trimmed };
    setApiKeys(next);
    void persistDesktopRuntimeSettings(next, modelApiKeys, modelOverrides);
    broadcastEterxSettingsUpdate({ type: 'api-keys-updated' });
    setHasChanges(true);
    keysChangedRef.current = true;
  }, [apiKeys, modelApiKeys, modelOverrides, persistDesktopRuntimeSettings]);

  // Close on escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    if (isOpen) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, handleClose]);

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'general', label: 'General', icon: 'general' },
    { id: 'profile', label: 'Profile', icon: 'profile' },
    { id: 'appearance', label: 'Appearance', icon: 'appearance' },
    { id: 'configuration', label: 'Configuration', icon: 'configuration' },
    { id: 'personalization', label: 'Personalization', icon: 'personalization' },
    { id: 'mcp', label: 'MCP servers', icon: 'mcp' },
    { id: 'models', label: 'Models', icon: 'models' },
    { id: 'api', label: 'API', icon: 'api' },
    { id: 'git', label: 'Git', icon: 'git' },
    { id: 'environments', label: 'Environments', icon: 'environments' },
    { id: 'browser', label: 'Browser', icon: 'browser' },
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
    if (isOpen && activeProvider !== selectedConnectionProvider) {
      setSelectedConnectionProvider(activeProvider);
    }
  }, [activeProvider, isOpen, selectedConnectionProvider]);

  const getProviderModelOptions = useCallback((provider: string) => {
    const seen = new Set<string>();
    const options: ProviderModelOption[] = [];
    const push = (id: unknown, label: unknown, source: ProviderModelOption['source']) => {
      const modelId = String(id || '').trim();
      if (!modelId || seen.has(modelId)) return;
      seen.add(modelId);
      options.push({
        id: modelId,
        label: String(label || modelId),
        source,
      });
    };

    push(modelOverrides[provider], modelOverrides[provider], 'selected');
    modelCatalog[provider]?.forEach(modelId => push(modelId, modelId, 'saved'));
    OFFICIAL_PROVIDER_GUIDE[provider]?.families.forEach(family => {
      if (family.id) push(family.id, family.name, 'official');
    });
    modelDirectory[provider]?.models?.forEach(model => {
      push(model.id, model.name || model.id, 'live');
    });

    return options;
  }, [modelCatalog, modelDirectory, modelOverrides]);

  const selectedProviderGuide = OFFICIAL_PROVIDER_GUIDE[selectedConnectionProvider];
  const selectedProviderDirectory = modelDirectory[selectedConnectionProvider];
  const selectedProviderMode = PROVIDER_MODE[selectedConnectionProvider];
  const selectedProviderFallbackModel = MAIN_AGENT_MODEL_OPTIONS.find(option => option.id === selectedProviderMode)?.modelName || '';
  const selectedProviderModel = modelOverrides[selectedConnectionProvider] || '';
  const selectedProviderModelOptions = getProviderModelOptions(selectedConnectionProvider);
  const selectedProviderKeyCount = providerKeyCount(selectedConnectionProvider);
  const globalSelectorCount = modelEntries.length;
  const selectedProviderStatusText = selectedProviderDirectory
    ? (selectedProviderDirectory.connected ? `${ selectedProviderDirectory.models.length } live models loaded` : selectedProviderDirectory.error || 'Not connected')
    : 'Refresh to load live models';
  const selectedProviderCapabilities = [
    selectedProviderKeyCount > 0 ? `${ selectedProviderKeyCount } key${ selectedProviderKeyCount === 1 ? '' : 's' } in pool` : 'Key not connected',
    selectedProviderDirectory?.connected ? 'Live catalog' : 'Catalog pending',
    globalSelectorCount > 0 ? `${ globalSelectorCount } chat model${ globalSelectorCount === 1 ? '' : 's' }` : 'Chat list empty',
  ];
  const selectedApiProvider = selectedApiProviderValue || activeProvider;
  const selectedApiProviderLabel = PROVIDER_LABEL[selectedApiProvider] || selectedApiProvider;
  const selectedApiProviderSync = providerSync(selectedApiProvider);
  const selectedApiProviderPoolValue = `provider:${selectedApiProvider}`;
  const selectedApiProviderModelEntries = modelEntries.filter(entry => entry.provider === selectedApiProvider);
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
      label: entry.modelId,
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
  const selectedApiProviderKeyCount = splitApiKeyPool(selectedApiPoolValue).length;

  useEffect(() => {
    if (!apiPoolEntries.some(entry => entry.value === selectedApiModelValue)) {
      setSelectedApiModelValue(selectedApiProviderPoolValue);
    }
  }, [apiPoolEntries, selectedApiProviderPoolValue, selectedApiModelValue]);

  useEffect(() => {
    setExactModelDraft(selectedProviderModel);
  }, [selectedConnectionProvider, selectedProviderModel]);

  useEffect(() => {
    if (!isOpen || activeTab !== 'models' || modelDirectoryStatus !== 'idle') return;
    void refreshModelDirectory();
  }, [activeTab, isOpen, modelDirectoryStatus, refreshModelDirectory]);

  const saveModelEntries = useCallback((nextEntries: ModelSelectorEntry[]) => {
    const normalizedEntries = normalizeModelSelectorEntries(nextEntries, {});
    const nextCatalog = entriesToModelCatalog(normalizedEntries) as ModelCatalog;
    setModelEntries(normalizedEntries);
    setModelCatalog(nextCatalog);
    localStorage.setItem(MODEL_SELECTOR_STORAGE_KEY, JSON.stringify(normalizedEntries));
    localStorage.setItem(MODEL_CATALOG_STORAGE_KEY, JSON.stringify(nextCatalog));
    broadcastEterxSettingsUpdate({
      type: 'model-selector-updated',
      modelEntries: normalizedEntries,
      modelCatalog: nextCatalog,
    });
  }, []);

  const saveModelThinkingCapability = useCallback((provider: MainAgentProvider, modelId: string) => {
    const liveCapability = modelDirectory[provider]?.models.find(model => model.id === modelId)?.thinking;
    if (!liveCapability) return;
    const key = modelEntryKey(provider, modelId);
    setModelThinkingCapabilities(previous => {
      const next = { ...previous, [key]: liveCapability };
      localStorage.setItem(MODEL_THINKING_CAPABILITIES_STORAGE_KEY, JSON.stringify(next));
      broadcastEterxSettingsUpdate({
        type: 'model-thinking-capabilities-updated',
        thinkingCapabilities: next,
      });
      return next;
    });
  }, [modelDirectory]);

  const updateModelApiKey = useCallback((modelKey: string, value: string) => {
    if (!parseModelEntryKey(modelKey)) return;
    const next = { ...modelApiKeys };
    const cleanValue = value.trim();
    if (cleanValue) next[modelKey] = cleanValue;
    else delete next[modelKey];
    setModelApiKeys(next);
    void persistDesktopRuntimeSettings(apiKeys, next, modelOverrides);
    broadcastEterxSettingsUpdate({ type: 'model-api-keys-updated' });
    setHasChanges(true);
    keysChangedRef.current = true;
  }, [apiKeys, modelApiKeys, modelOverrides, persistDesktopRuntimeSettings]);

  const selectCatalogModel = useCallback((provider: string, modelId: string) => {
    if (!isModelProvider(provider)) return;
    const next = { ...modelOverrides };
    if (modelId) {
      next[provider] = modelId;
    } else {
      delete next[provider];
    }
    setModelOverrides(next);
    localStorage.setItem(MODEL_OVERRIDE_STORAGE_KEY, JSON.stringify(next));
    void persistDesktopRuntimeSettings(apiKeys, modelApiKeys, next);
    broadcastEterxSettingsUpdate({ type: 'model-overrides-updated', modelOverrides: next });
    const nextMode = PROVIDER_MODE[provider];
    if (nextMode) updateSetting('agentMode', nextMode);
    setHasChanges(true);
    keysChangedRef.current = true;
  }, [apiKeys, modelApiKeys, modelOverrides, persistDesktopRuntimeSettings, updateSetting]);

  const addModelToSelector = useCallback((provider: string, modelId: string, activate = true) => {
    const cleanProvider = String(provider || '').trim();
    const cleanModelId = String(modelId || '').trim();
    if (!isModelProvider(cleanProvider) || !cleanModelId) return;

    const nextEntries = ensureModelSelectorEntry(modelEntries, cleanProvider, cleanModelId);
    saveModelEntries(nextEntries);
    saveModelThinkingCapability(cleanProvider, cleanModelId);
    if (activate) selectCatalogModel(cleanProvider, cleanModelId);
    setHasChanges(true);
    keysChangedRef.current = true;
  }, [modelEntries, saveModelEntries, saveModelThinkingCapability, selectCatalogModel]);

  const removeModelFromSelector = useCallback((provider: string, modelId: string) => {
    const cleanProvider = String(provider || '').trim();
    const cleanModelId = String(modelId || '').trim();
    if (!isModelProvider(cleanProvider) || !cleanModelId) return;

    const removedKey = modelEntryKey(cleanProvider, cleanModelId);
    const nextEntries = removeModelSelectorEntry(modelEntries, cleanProvider, cleanModelId);
    saveModelEntries(nextEntries);
    setModelThinkingCapabilities(previous => {
      if (!(removedKey in previous)) return previous;
      const next = { ...previous };
      delete next[removedKey];
      localStorage.setItem(MODEL_THINKING_CAPABILITIES_STORAGE_KEY, JSON.stringify(next));
      broadcastEterxSettingsUpdate({ type: 'model-thinking-capabilities-updated', thinkingCapabilities: next });
      return next;
    });
    const nextModelKeys = { ...modelApiKeys };
    delete nextModelKeys[removedKey];
    setModelApiKeys(nextModelKeys);
    void persistDesktopRuntimeSettings(apiKeys, nextModelKeys, modelOverrides);
    if (localStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) === removedKey) {
      localStorage.setItem(CHAT_MODEL_SELECTION_STORAGE_KEY, AUTO_MODEL_SELECTION);
    }
    if (modelOverrides[cleanProvider] === cleanModelId) {
      selectCatalogModel(cleanProvider, '');
      setExactModelDraft('');
    }
    setHasChanges(true);
    keysChangedRef.current = true;
  }, [apiKeys, modelApiKeys, modelEntries, modelOverrides, persistDesktopRuntimeSettings, saveModelEntries, selectCatalogModel]);

  if ((!isOpen && !showBatmanEgg) || typeof document === 'undefined') return null;

  return createPortal(
    <>
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
              className={`${ standalone ? 'h-screen w-screen rounded-none border-0' : 'h-[min(640px,calc(100vh-40px))] w-[min(900px,calc(100vw-40px))] rounded-[12px] border border-white/[0.08]' } relative overflow-hidden flex flex-col bg-[#151515] shadow-[0_20px_60px_rgba(0,0,0,0.55)]`}
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
                      onClick={() => setActiveTab(tab.id)}
                      className={`flex h-8 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] font-medium leading-none transition-colors sm:w-full ${ activeTab === tab.id
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
                <div className="flex-1 overflow-y-auto eterx-scrollbar px-6 py-8">
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={activeTab}
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                      transition={{ duration: 0.2 }}
                      className="mx-auto w-full max-w-[560px] pb-8"
                    >
                      <h3 className="mb-6 text-[22px] font-semibold leading-tight tracking-[-0.01em] text-[#F4F4F4]">{tabs.find(t => t.id === activeTab)?.label}</h3>

                      {/* ═══ GENERAL TAB ═══ */}
                      {activeTab === 'general' && (
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
                            <SettingsStackRow title="Integrated terminal shell" description="Choose which shell opens in the integrated terminal.">
                              <SelectControl
                                value={settings.terminalShell}
                                onChange={(value) => updateSetting('terminalShell', value as AppSettings['terminalShell'])}
                                options={[
                                  { value: 'powershell', label: 'PowerShell' },
                                  { value: 'cmd', label: 'Command Prompt' },
                                  { value: 'git-bash', label: 'Git Bash' },
                                  { value: 'wsl', label: 'WSL' },
                                ]}
                              />
                            </SettingsStackRow>

                            <SettingsStackRow title="Follow-up behavior" description="Queue follow-ups while EterX runs or steer the current run.">
                              <SegmentedControl
                                value={settings.followUpBehavior}
                                onChange={(value) => updateSetting('followUpBehavior', value)}
                                options={[
                                  { value: 'queue', label: 'Queue' },
                                  { value: 'steer', label: 'Steer' },
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
                              <SoftButton>View</SoftButton>
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
                            <SettingsStackRow title="Theme" description="Use light, dark, or match your system">
                              <SegmentedControl
                                value={settings.theme}
                                onChange={(value) => updateSetting('theme', value)}
                                options={[
                                  { value: 'light', label: 'Light' },
                                  { value: 'dark', label: 'Dark' },
                                  { value: 'system', label: 'System' },
                                ]}
                              />
                            </SettingsStackRow>
                            <div className="border-b border-white/[0.07] px-2 pb-2">
                              <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#141414] font-mono text-[12px] leading-7">
                                <div className="grid grid-cols-2">
                                  <div className="border-r border-white/[0.08]">
                                    {[
                                      ['1', 'const eterxTheme = {', 'text-[#C084FC]'],
                                      ['2', '  surface: "sidebar",', 'bg-red-500/18 text-[#FF8A7A]'],
                                      ['3', '  accent: "#2F8BEF",', 'bg-red-500/18 text-[#FFB86C]'],
                                      ['4', '  contrast: 42,', 'bg-red-500/18 text-[#FFB86C]'],
                                      ['5', '};', 'text-[#A7A7A7]'],
                                    ].map(([line, code, tone]) => (
                                      <div key={line} className={`grid grid-cols-[44px_1fr] px-2 ${tone}`}>
                                        <span className="text-right text-[#777]">{line}</span>
                                        <span className="pl-4">{code}</span>
                                      </div>
                                    ))}
                                  </div>
                                  <div>
                                    {[
                                      ['1', 'const eterxTheme = {', 'text-[#C084FC]'],
                                      ['2', '  surface: "panel",', 'bg-emerald-500/18 text-emerald-300'],
                                      ['3', '  accent: "#2F8BEF",', 'bg-emerald-500/18 text-[#8BE38B]'],
                                      ['4', '  contrast: 68,', 'bg-emerald-500/18 text-[#75C7FF]'],
                                      ['5', '};', 'text-[#A7A7A7]'],
                                    ].map(([line, code, tone]) => (
                                      <div key={line} className={`grid grid-cols-[44px_1fr] px-2 ${tone}`}>
                                        <span className="text-right text-[#777]">{line}</span>
                                        <span className="pl-4">{code}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </div>

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
                              <Toggle enabled={settings.groundingSearch} onChange={v => updateSetting('groundingSearch', v)} />
                            </SettingsStackRow>
                          </SettingsStack>

                          <SectionHeader title="Sub-agents" />
                          <SettingsStack>
                            <SettingsStackRow title="Auto sub-agent spawning" description="Allow EterX to run parallel helper agents when a task benefits from it.">
                              <Toggle enabled={settings.autoSubAgents} onChange={v => updateSetting('autoSubAgents', v)} />
                            </SettingsStackRow>
                            <SettingsStackRow title="Max concurrent sub-agents" description="Upper limit for parallel helper agents.">
                              <div className="w-[240px]">
                                <SettingSlider value={settings.maxSubAgents} min={1} max={10} onChange={v => updateSetting('maxSubAgents', v)} label="" />
                              </div>
                            </SettingsStackRow>
                            <SettingsStackRow title="Max retry attempts" description="How many times the runtime retries after a failed action.">
                              <div className="w-[240px]">
                                <SettingSlider value={settings.maxRetries} min={0} max={5} onChange={v => updateSetting('maxRetries', v)} label="" />
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
                            badge={apiSyncStatus === 'synced' ? 'LIVE' : undefined}
                            info="Models saved here become the exact choices shown in the chat model selector. API keys are configured separately in the API tab."
                          />
                          <SettingsStack>
                            <SettingsStackRow title="Provider" description="Choose the model provider used by the main agent runtime.">
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
                              description={selectedProviderModel ? 'Exact provider model id active for the next run.' : `Auto fallback: ${ selectedProviderFallbackModel || 'provider default' }`}
                              info="Choosing a model pins the runtime to that exact provider model and adds it to the global chat model list."
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
                                placeholder="Auto runtime default"
                                className="w-[360px]"
                                options={[
                                  { value: '', label: 'Auto runtime default', description: PROVIDER_LABEL[selectedConnectionProvider] || selectedConnectionProvider },
                                  ...selectedProviderModelOptions.map(option => ({
                                    value: option.id,
                                    label: option.id,
                                    description: PROVIDER_LABEL[selectedConnectionProvider] || selectedConnectionProvider,
                                  })),
                                ]}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow
                              title={selectedConnectionProvider === 'openrouter' ? 'Exact OpenRouter model' : selectedConnectionProvider === 'groq' ? 'Exact Groq model' : 'Exact model ID'}
                              description={selectedConnectionProvider === 'openrouter'
                                ? 'Paste any OpenRouter slug, for example openai/gpt-5.5 or anthropic/claude-opus-4.8.'
                                : selectedConnectionProvider === 'groq'
                                  ? 'Paste any Groq model id, for example openai/gpt-oss-120b or llama-3.3-70b-versatile.'
                                : 'Use a provider-specific model ID when it is not listed yet in live discovery.'}
                              info="Use this for models that are new, custom, or not returned by live discovery yet."
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
                                {selectedProviderModel && (
                                  <SoftButton onClick={() => {
                                    setExactModelDraft('');
                                    selectCatalogModel(selectedConnectionProvider, '');
                                  }}>
                                    Auto
                                  </SoftButton>
                                )}
                              </div>
                            </SettingsStackRow>
                            <SettingsStackRow
                              title="Chat model list"
                              description="This ordered list appears in the chat selector. Auto uses it as the runtime priority list."
                              info="Auto chooses from this list. A manually selected chat model always sends with that exact model id."
                              tall
                            >
                              <div className="w-[360px] rounded-xl border border-white/[0.08] bg-[#141414] p-1.5">
                                {modelEntries.length === 0 ? (
                                  <div className="px-3 py-3 text-[12px] leading-5 text-[#8C8C8C]">
                                    Add a model ID or choose one from provider discovery to make it available in chat.
                                  </div>
                                ) : (
                                  <div className="max-h-[280px] overflow-y-auto pr-1 eterx-scrollbar">
                                    {modelEntries.map(entry => {
                                      const selected = modelOverrides[entry.provider] === entry.modelId;
                                      const entryProviderLabel = PROVIDER_LABEL[entry.provider] || entry.provider;
                                      return (
                                        <div key={modelEntryKey(entry.provider, entry.modelId)} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-white/[0.04]">
                                          <div className="min-w-0 flex-1">
                                            <div className="truncate font-mono text-[11.5px] font-semibold text-[#F1F1F1]">{entry.modelId}</div>
                                            <div className="mt-0.5 truncate text-[11px] text-[#777]">
                                              {selected ? 'Active runtime target' : entryProviderLabel}
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
                                  </div>
                                )}
                              </div>
                            </SettingsStackRow>
                            <SettingsStackRow title="Live model discovery" description={selectedProviderStatusText}>
                              <SoftButton onClick={() => refreshModelDirectory()}>
                                <span className="inline-flex items-center gap-2">
                                  <RefreshCw className={`h-3.5 w-3.5 ${ modelDirectoryStatus === 'loading' ? 'animate-spin' : '' }`} />
                                  Refresh
                                </span>
                              </SoftButton>
                            </SettingsStackRow>
                          </SettingsStack>

                          <div className="mt-4 grid gap-3 md:grid-cols-3">
                            {selectedProviderCapabilities.map(capability => (
                              <div key={capability} className="rounded-xl border border-white/[0.08] bg-[#202020] px-4 py-3">
                                <div className="text-[12px] font-medium text-[#F1F1F1]">{capability}</div>
                              </div>
                            ))}
                          </div>

                          <SectionHeader title="Provider details" />
                          <SettingsStack>
                            <SettingsStackRow title={selectedProviderGuide?.source || PROVIDER_LABEL[selectedConnectionProvider] || selectedConnectionProvider} description={selectedProviderGuide?.keySource || 'Provider account key'} />
                            <SettingsStackRow title="Discovery endpoint" description={selectedProviderGuide?.endpoint || 'Live model endpoint'}>
                              <span className="rounded-lg border border-white/[0.08] bg-[#141414] px-3 py-1.5 font-mono text-[11px] text-[#CFCFCF]">
                                {selectedProviderGuide?.docsUrl || 'Provider docs'}
                              </span>
                            </SettingsStackRow>

                          </SettingsStack>

                        </div>
                      )}

                      {/* ═══ ADVANCED TAB ═══ */}
                      {activeTab === 'api' && (
                        <div>
                          <SectionHeader
                            title="API gateway"
                            badge={apiSyncStatus === 'synced' ? 'LIVE' : undefined}
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
                              title="API key pool"
                              description="Use Provider pool for all models from this provider, or choose an exact saved model for a custom model pool."
                              info="When a selected model has its own custom pool, that pool is used first. If not, EterX falls back to the provider pool."
                              tall
                            >
                              <ApiKeyPoolEditor
                                key={`${selectedApiProvider}-${selectedApiPoolEntry.value}`}
                                provider={selectedApiProvider}
                                providerLabel={selectedApiPoolEntry.isProviderPool ? `${selectedApiProviderLabel} provider pool` : selectedApiPoolEntry.label}
                                value={selectedApiPoolValue}
                                sync={selectedApiPoolEntry.isProviderPool ? selectedApiProviderSync : undefined}
                                minRows={3}
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
                          </SettingsStack>

                          <div className="mt-4 grid gap-3 md:grid-cols-3">
                            <div className="rounded-xl border border-white/[0.08] bg-[#202020] px-4 py-3">
                              <div className="text-[12px] font-medium text-[#F1F1F1]">
                                {selectedApiProviderKeyCount} configured key{selectedApiProviderKeyCount === 1 ? '' : 's'}
                              </div>
                            </div>
                            <div className="rounded-xl border border-white/[0.08] bg-[#202020] px-4 py-3">
                              <div className="text-[12px] font-medium text-[#F1F1F1]">{apiSyncMessage}</div>
                            </div>
                            <div className="rounded-xl border border-white/[0.08] bg-[#202020] px-4 py-3">
                              <div className="text-[12px] font-medium text-[#F1F1F1]">Settings is the runtime key source</div>
                            </div>
                          </div>

                          <SectionHeader title="Service APIs" />
                          <SettingsStack>
                            <SettingsStackRow title="External search" description="Tavily enables current web search for facts, docs, and research." tall>
                              <ApiKeyPoolEditor
                                provider="tavily"
                                providerLabel="Tavily search"
                                value={apiKeys.tavily || ''}
                                sync={providerSync('tavily')}
                                minRows={3}
                                onChange={(nextValue) => updateApiKey('tavily', nextValue)}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Code platform" description="GitHub token enables repository-aware actions when needed." tall>
                              <ApiKeyPoolEditor
                                provider="github"
                                providerLabel="GitHub"
                                value={apiKeys.github || ''}
                                sync={providerSync('github')}
                                minRows={3}
                                onChange={(nextValue) => updateApiKey('github', nextValue)}
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
                          <SectionHeader title="MCP servers" />
                          <SettingRow icon={<PlugZap className="w-4 h-4" />} title="Enable MCP tools" description="Allow configured MCP servers to expose tools and resources to the local agent runtime.">
                            <Toggle enabled={settings.mcpServersEnabled} onChange={v => updateSetting('mcpServersEnabled', v)} />
                          </SettingRow>
                          <div className="grid gap-3 md:grid-cols-2">
                            {[
                              ['Filesystem', 'Local workspace file tools', 'Built in'],
                              ['Browser', 'Local browser inspection and screenshots', 'Available'],
                              ['Canva', 'Design generation and editing connector', 'Connector'],
                              ['Linear', 'Issue and project workflow connector', 'Connector'],
                            ].map(([name, description, status]) => (
                              <div key={name} className="rounded-xl border border-white/[0.08] bg-[#202020] p-5">
                                <div className="flex items-center justify-between gap-3">
                                  <div className="text-[16px] font-medium text-[#F1F1F1]">{name}</div>
                                  <span className="rounded-full border border-white/[0.10] bg-white/[0.045] px-2 py-0.5 text-[10px] uppercase text-[#AFAFAF]">{status}</span>
                                </div>
                                <p className="mt-2 text-[14px] text-[#A5A5A5]">{description}</p>
                              </div>
                            ))}
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
                          <SectionHeader title="Browser" />
                          <SettingRow icon={<Globe className="w-4 h-4" />} title="Browser access" description="Allow the agent to inspect local app pages, capture screenshots, and verify UI behavior.">
                            <Toggle enabled={settings.browserAccess} onChange={v => updateSetting('browserAccess', v)} />
                          </SettingRow>
                          <SettingRow icon={<Search className="w-4 h-4" />} title="External web search" description="Enable real-time web search to ground agent responses in current facts.">
                            <Toggle enabled={settings.groundingSearch} onChange={v => updateSetting('groundingSearch', v)} />
                          </SettingRow>
                          <SettingRow icon={<Monitor className="w-4 h-4" />} title="Preview target" description="Default local app URL used by browser verification.">
                            <span className="rounded-lg border border-white/[0.10] bg-[#141414] px-3 py-2 font-mono text-[13px] text-[#CFCFCF]">http://localhost:3000</span>
                          </SettingRow>
                        </div>
                      )}

                      {activeTab === 'computer' && (
                        <div>
                          <SectionHeader title="Computer use" />
                          <SettingRow icon={<Cpu className="w-4 h-4" />} title="Enable computer use" description="Allow direct screen-level computer actions for workflows that cannot be handled through APIs.">
                            <Toggle enabled={settings.computerUse} onChange={v => updateSetting('computerUse', v)} />
                          </SettingRow>
                          <SettingRow icon={<Shield className="w-4 h-4" />} title="Require permission review" description="Review sensitive computer actions before they run.">
                            <Toggle enabled={settings.autoReview} onChange={v => updateSetting('autoReview', v)} />
                          </SettingRow>
                          <div className="rounded-xl border border-white/[0.08] bg-[#202020] p-5">
                            <div className="text-[16px] font-medium text-[#F1F1F1]">Safety boundary</div>
                            <p className="mt-2 text-[14px] leading-relaxed text-[#A5A5A5]">Computer-use actions remain disabled unless this setting is enabled and the runtime has an available tool.</p>
                          </div>
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

                          <SectionHeader title="Experimental" badge="BETA" />
                          <SettingsStack>
                            <SettingsStackRow title="Experimental features" description="Enable new capabilities that may still change.">
                              <Toggle enabled={settings.experimentalFeatures} onChange={v => updateSetting('experimentalFeatures', v)} />
                            </SettingsStackRow>
                          </SettingsStack>

                          <SectionHeader title="Data" />
                          <SettingsStack>
                            <SettingsStackRow title="Clear agent memory" description="Wipe stored memories, API keys, model overrides, and local preferences.">
                              <button
                                onClick={() => {
                                  if (confirm('This will permanently delete all agent memory. Continue?')) {
                                    localStorage.removeItem('eterx_settings');
                                    localStorage.removeItem('eterx_api_keys');
                                    localStorage.removeItem(MODEL_OVERRIDE_STORAGE_KEY);
                                    localStorage.removeItem(MODEL_CATALOG_STORAGE_KEY);
                                    localStorage.removeItem(MODEL_SELECTOR_STORAGE_KEY);
                                    localStorage.removeItem(CHAT_MODEL_SELECTION_STORAGE_KEY);
                                    setSettings(DEFAULT_SETTINGS);
                                    setApiKeys({});
                                    setModelOverrides({});
                                    setModelCatalog({});
                                    setModelEntries([]);
                                    setModelApiKeys({});
                                    setSelectedApiProviderValue('gemini');
                                    setSelectedApiModelValue('');
                                    setApiSyncStatus('idle');
                                    setApiSyncMessage('Add a provider key to activate the local runtime gateway.');
                                    setApiProviderStatus([]);
                                    setModelDirectory({});
                                    setModelDirectoryStatus('idle');
                                    setModelDirectoryUpdatedAt(null);
                                    void (async () => {
                                      try {
                                        await (window as any)?.electronAPI?.clearSecureRuntimeSettings?.();
                                        await fetch('/api/settings/keys', {
                                          method: 'POST',
                                          headers: { 'Content-Type': 'application/json' },
                                          body: JSON.stringify({ apiKeys: {}, modelOverrides: {} }),
                                        });
                                      } catch (error) {
                                        console.warn('Could not clear runtime credentials:', error);
                                      }
                                    })();
                                  }
                                }}
                                className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-[12px] font-medium text-red-400 transition-colors hover:bg-red-500/20"
                              >
                                Clear Data
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
                                updateState.status === 'ready' ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400' :
                                updateState.status === 'error' ? 'border-red-500/25 bg-red-500/10 text-red-400' :
                                'border-white/[0.08] bg-white/[0.04] text-[#B8B8B8]'
                              }`}>
                                {updateState.status === 'current' ? 'Up to date' : updateState.status === 'ready' ? 'Ready' : updateState.status}
                              </span>
                            </div>

                            {(updateState.status === 'downloading' || updateState.status === 'ready') && (
                              <div className="mt-5">
                                <div className="mb-2 flex justify-between text-[11px] text-[#777]">
                                  <span>{updateState.availableVersion ? `Version ${updateState.availableVersion}` : 'Update package'}</span>
                                  <span>{Math.round(updateState.percent)}%</span>
                                </div>
                                <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                                  <div className="h-full rounded-full bg-[#D9D9D9] transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, updateState.percent))}%` }} />
                                </div>
                              </div>
                            )}
                          </div>

                          <div className="flex gap-3">
                            {updateState.status === 'ready' ? (
                              <SoftButton onClick={() => void (window as any)?.electronAPI?.installUpdate?.()}>Restart and install</SoftButton>
                            ) : (
                              <SoftButton
                                disabled={updateState.status === 'checking' || updateState.status === 'downloading' || updateState.status === 'development'}
                                onClick={() => void (window as any)?.electronAPI?.checkForUpdates?.()}
                              >
                                {updateState.status === 'checking' ? 'Checking…' : updateState.status === 'downloading' ? 'Downloading…' : 'Check for updates'}
                              </SoftButton>
                            )}
                          </div>

                          <p className="mt-5 text-[12px] leading-relaxed text-[#666]">
                            Updates download in the background and replace only application files. Your chats, workspaces, encrypted API settings, browser profiles, and preferences remain in the device data directory.
                          </p>
                        </div>
                      )}

                      {/* ═══ ACCOUNT TAB ═══ */}
                      {activeTab === 'profile' && (
                        <div>
                          <SectionHeader title="Profile" />
                          <div className="bg-white/[0.02] rounded-xl border border-white/[0.05] p-5 flex items-center gap-4 mb-4">
                            <div className="w-14 h-14 rounded-full bg-[#2B2B2B] flex items-center justify-center text-[#E8E6E3] font-bold text-xl border border-white/10 shadow-inner shrink-0">
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
                              <div className="text-[11px] text-[#555] uppercase tracking-wider mb-1">Total Chats</div>
                              <div className="text-[24px] font-bold text-[#E8E6E3]">
                                {(() => { try { const c = localStorage.getItem('eterx_chats'); return c ? JSON.parse(c).length : 0; } catch { return 0; } })()}
                              </div>
                            </div>
                            <div className="bg-white/[0.02] rounded-xl border border-white/[0.05] p-4">
                              <div className="text-[11px] text-[#555] uppercase tracking-wider mb-1">API Keys</div>
                              <div className="text-[24px] font-bold text-[#E8E6E3]">{Object.values(apiKeys).filter(Boolean).length}</div>
                            </div>
                          </div>

                          <SectionHeader title="Workspace" />
                          <SettingRow icon={<FolderOpen className="w-4 h-4" />} title="Workspace Directory" description="Root directory for all agent workspace files">
                            <span className="text-[12px] font-mono text-[#666] truncate max-w-[200px] block">.workspaces/</span>
                          </SettingRow>
                          <SettingRow icon={<Lock className="w-4 h-4" />} title="Security" description="All operations are sandboxed to local filesystem only">
                            <span className="flex items-center gap-1.5 text-[12px] text-emerald-400/80">
                              <Shield className="w-3 h-3" /> Secured
                            </span>
                          </SettingRow>
                        </div>
                      )}

                    </motion.div>
                  </AnimatePresence>
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
                      className={`w-full max-w-[340px] rounded-2xl border p-6 text-center shadow-[0_24px_48px_rgba(0,0,0,0.4)] ${
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
                            setSettings(DEFAULT_SETTINGS);
                            localStorage.setItem('eterx_settings', JSON.stringify(DEFAULT_SETTINGS));
                            applyEterxTheme(DEFAULT_SETTINGS.theme);
                            broadcastEterxSettingsUpdate(DEFAULT_SETTINGS);
                            setHasChanges(false);
                            setShowResetConfirm(false);
                          }}
                          className="flex-1 h-9 rounded-xl bg-[#E2765A] hover:bg-[#D66548] active:bg-[#C95438] text-white font-medium text-[13px] transition-colors shadow-sm"
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
                className="text-[45px] md:text-[80px] font-black italic tracking-tighter text-white drop-shadow-[0_0_40px_rgba(255,255,255,0.3)] uppercase leading-tight"
                style={{ WebkitTextStroke: '1px black' }}
              >
                {eggQuotes[eggQuoteIndex].line1}
              </motion.h1>
              <motion.p
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 2.8, ease: "easeOut" }}
                className="text-[25px] md:text-[40px] font-black text-[#FF1A1A] uppercase tracking-[0.2em] mt-4 drop-shadow-[0_10px_25px_rgba(255,0,0,1)] mix-blend-screen"
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
};
