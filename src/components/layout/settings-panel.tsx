'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Key, Zap, Shield, ChevronRight, Monitor,
  Cpu, Eye, EyeOff,
  Copy, Check, Globe,
  FolderOpen, RefreshCw, Lock,
  Search, PlugZap, Plus, Trash2, GripVertical, Info
} from 'lucide-react';
import { MAIN_AGENT_MODEL_OPTIONS, type MainAgentMode, type MainAgentProvider } from '../../lib/agent/model-routing';
import {
  AUTO_MODEL_SELECTION,
  CHAT_MODEL_SELECTION_STORAGE_KEY,
  MODEL_API_KEYS_STORAGE_KEY,
  MODEL_CATALOG_STORAGE_KEY,
  MODEL_OVERRIDE_STORAGE_KEY,
  MODEL_PROVIDER_MODE,
  MODEL_PROVIDER_ORDER,
  MODEL_SELECTOR_STORAGE_KEY,
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
  }>;
  error?: string;
};

type ModelDirectory = Record<string, ModelDirectoryProvider>;
type ModelOverrides = Record<string, string>;
type ModelCatalog = Record<string, string[]>;
type ProviderModelOption = { id: string; label: string; source: 'selected' | 'saved' | 'official' | 'live' };

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
  anthropic: 'Anthropic',
};
const PROVIDER_MODE: Record<MainAgentProvider, MainAgentMode> = MODEL_PROVIDER_MODE;
const PROVIDER_ACCENT: Record<string, string> = {
  gemini: 'text-zinc-200 border-white/[0.10] bg-white/[0.045]',
  mistral: 'text-zinc-200 border-white/[0.10] bg-white/[0.045]',
  openai: 'text-zinc-200 border-white/[0.10] bg-white/[0.045]',
  openrouter: 'text-zinc-200 border-white/[0.10] bg-white/[0.045]',
  anthropic: 'text-zinc-200 border-white/[0.10] bg-white/[0.045]',
};

const PROVIDER_ICON_PATH: Record<string, string> = {
  gemini: '/icons/providers/gemini.svg',
  mistral: '/icons/providers/mistral.svg',
  openai: '/icons/providers/openai.svg',
  openrouter: '/icons/providers/openrouter.svg',
  anthropic: '/icons/providers/anthropic.svg',
};

const PROVIDER_ICON_COLOR: Record<string, string> = {
  gemini: '#8AB4F8',
  mistral: '#FFAF00',
};

const PROVIDER_ICON_MASK_SIZE: Record<string, string> = {
  gemini: '76%',
  mistral: '82%',
  openai: '86%',
  openrouter: '84%',
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
      { name: 'Mistral Small 4', id: 'mistral-small-2603', note: 'Efficient hybrid instruct, reasoning, and coding model' },
      { name: 'Mistral Large 3', id: 'mistral-large-2512', note: 'High-capability open-weight multimodal model' },
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
      { name: 'Claude Opus 4.8', id: 'claude-opus-4-8', note: 'Most capable Claude model for complex reasoning and agentic coding' },
      { name: 'Claude Sonnet 4.6', id: 'claude-sonnet-4-6', note: 'Balanced speed, intelligence, and extended thinking' },
      { name: 'Claude Haiku 4.5', id: 'claude-haiku-4-5-20251001', note: 'Fastest near-frontier Claude model' },
      { name: 'Claude Opus 4.7', id: 'claude-opus-4-7', note: 'Previous Opus fallback for high autonomy work' },
    ],
  },
  openai: {
    source: 'OpenAI Platform',
    keySource: 'OpenAI project API key',
    endpoint: 'GET /v1/models',
    docsUrl: 'platform.openai.com/docs/models',
    families: [
      { name: 'GPT-5.5', id: 'gpt-5.5', note: 'Flagship model for complex reasoning, coding, and professional workflows' },
      { name: 'GPT-5.4', id: 'gpt-5.4', note: 'More affordable model for coding and professional work' },
      { name: 'GPT-5.4 mini', id: 'gpt-5.4-mini', note: 'Fast option for coding, computer use, and sub-agents' },
      { name: 'GPT-5.4 nano', id: 'gpt-5.4-nano', note: 'Lowest latency and cost' },
      { name: 'GPT Image / Realtime / Transcribe', note: 'Specialized image, speech, and realtime model families' },
    ],
  },
  openrouter: {
    source: 'OpenRouter',
    keySource: 'OpenRouter API key',
    endpoint: 'GET /api/v1/models',
    docsUrl: 'openrouter.ai/docs',
    families: [
      { name: 'GPT-5.5', id: 'openai/gpt-5.5', note: 'OpenAI flagship through OpenRouter' },
      { name: 'Claude Opus 4.8', id: 'anthropic/claude-opus-4.8', note: 'Anthropic flagship through OpenRouter' },
      { name: 'Gemini 3.5 Flash', id: 'google/gemini-3.5-flash', note: 'Google Gemini routed through OpenRouter' },
      { name: 'Mistral Medium 3.5', id: 'mistralai/mistral-medium-3-5', note: 'Mistral frontier model through OpenRouter' },
      { name: 'Full OpenRouter catalog', note: 'Live endpoint loads hundreds of provider models automatically' },
    ],
  },
};

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: Tab | LegacyTab;
  standalone?: boolean;
}

const normalizeSettingsTab = (tab: Tab | LegacyTab | undefined): Tab => {
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
      return tab || 'general';
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
  <div className={`flex items-center justify-between gap-6 border-b border-white/[0.07] px-5 last:border-b-0 ${tall ? 'py-5' : 'py-4'}`}>
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2 text-[13.5px] font-medium leading-tight text-[#F1F1F1]">
        <span>{title}</span>
        {info && <InfoHint text={info} />}
      </div>
      {description && <div className="mt-1.5 max-w-[520px] text-[13px] leading-relaxed text-[#A7A7A7]">{description}</div>}
    </div>
    {children && <div className="flex shrink-0 items-center justify-end gap-2">{children}</div>}
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

const SoftButton: React.FC<{ children: React.ReactNode; onClick?: () => void }> = ({ children, onClick }) => (
  <button
    onClick={onClick}
    className="rounded-lg bg-[#303030] px-3 py-1.5 text-[12.5px] font-medium text-[#F2F2F2] transition-colors hover:bg-[#393939]"
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

  useEffect(() => {
    setRows(buildRows(value));
  }, [buildRows, provider, value]);

  useEffect(() => {
    setVisibleRows({});
    setCopiedIndex(null);
    setDraggedIndex(null);
  }, [provider]);

  const commitRows = useCallback((nextRows: string[]) => {
    onChange(serializeApiKeyPool(nextRows));
  }, [onChange]);

  const updateRow = (index: number, rawValue: string) => {
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
  const [modelApiKeys, setModelApiKeys] = useState<Record<string, string>>({});
  const [selectedConnectionProvider, setSelectedConnectionProvider] = useState<MainAgentProvider>('gemini');
  const [selectedApiProviderValue, setSelectedApiProviderValue] = useState<MainAgentProvider>('gemini');
  const [selectedApiModelValue, setSelectedApiModelValue] = useState('');
  const [exactModelDraft, setExactModelDraft] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [showBatmanEgg] = useState(false);
  const [eggQuoteIndex] = useState(0);

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
    } catch (error: any) {
      setApiSyncStatus('error');
      setApiSyncMessage(error?.message || 'Could not sync API keys.');
    }
  }, [hasAnyApiKey]);

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

  // Load settings from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem('eterx_settings');
      if (saved) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(saved) });
      const savedKeys = localStorage.getItem('eterx_api_keys');
      const savedModelOverrides = localStorage.getItem(MODEL_OVERRIDE_STORAGE_KEY);
      const savedModelCatalog = localStorage.getItem(MODEL_CATALOG_STORAGE_KEY);
      const savedModelEntries = localStorage.getItem(MODEL_SELECTOR_STORAGE_KEY);
      const savedModelApiKeys = localStorage.getItem(MODEL_API_KEYS_STORAGE_KEY);
      const parsedModelOverrides = savedModelOverrides ? JSON.parse(savedModelOverrides) : {};
      const parsedModelCatalog = savedModelCatalog ? JSON.parse(savedModelCatalog) : {};
      const parsedModelApiKeys = savedModelApiKeys ? JSON.parse(savedModelApiKeys) : {};
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
      localStorage.setItem(MODEL_SELECTOR_STORAGE_KEY, JSON.stringify(normalizedEntries));
      localStorage.setItem(MODEL_CATALOG_STORAGE_KEY, JSON.stringify(normalizedCatalog));
      if (savedKeys) {
        const parsedKeys = JSON.parse(savedKeys);
        setApiKeys(parsedKeys);
        void syncApiKeys(
          composeApiKeysForSelection(parsedKeys, parsedModelApiKeys, normalizedEntries, localStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) || AUTO_MODEL_SELECTION),
          true,
          parsedModelOverrides,
        );
      }
    } catch { }
  }, [isOpen, syncApiKeys]);

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

  const updateApiKey = useCallback((name: string, value: string) => {
    setApiKeys(prev => {
      const next = { ...prev, [name]: value.trim() };
      localStorage.setItem('eterx_api_keys', JSON.stringify(next));
      broadcastEterxSettingsUpdate({ type: 'api-keys-updated', apiKeys: next });
      void syncApiKeys(
        composeApiKeysForSelection(next, modelApiKeys, modelEntries, localStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) || AUTO_MODEL_SELECTION),
        false,
        modelOverrides,
      );
      return next;
    });
    setHasChanges(true);
  }, [modelApiKeys, modelEntries, modelOverrides, syncApiKeys]);

  // Close on escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    if (isOpen) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'general', label: 'General', icon: 'general' },
    { id: 'profile', label: 'Profile', icon: 'profile' },
    { id: 'appearance', label: 'Appearance', icon: 'appearance' },
    { id: 'configuration', label: 'Configuration', icon: 'configuration' },
    { id: 'personalization', label: 'Personalization', icon: 'personalization' },
    { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'shortcuts' },
    { id: 'mcp', label: 'MCP servers', icon: 'mcp' },
    { id: 'hooks', label: 'Hooks', icon: 'hooks' },
    { id: 'models', label: 'Models', icon: 'models' },
    { id: 'api', label: 'API', icon: 'api' },
    { id: 'git', label: 'Git', icon: 'git' },
    { id: 'environments', label: 'Environments', icon: 'environments' },
    { id: 'worktrees', label: 'Worktrees', icon: 'worktrees' },
    { id: 'browser', label: 'Browser', icon: 'browser' },
    { id: 'computer', label: 'Computer use', icon: 'computer' },
    { id: 'archives', label: 'Archived chats', icon: 'archives' },
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

  const syncComposedKeys = useCallback((
    nextBaseKeys: Record<string, string> = apiKeys,
    nextModelKeys: Record<string, string> = modelApiKeys,
    nextEntries: ModelSelectorEntry[] = modelEntries,
    nextOverrides: ModelOverrides = modelOverrides,
  ) => {
    const selection = localStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) || AUTO_MODEL_SELECTION;
    const composed = composeApiKeysForSelection(nextBaseKeys, nextModelKeys, nextEntries, selection);
    void syncApiKeys(composed, false, nextOverrides);
  }, [apiKeys, modelApiKeys, modelEntries, modelOverrides, syncApiKeys]);

  const updateModelApiKey = useCallback((modelKey: string, value: string) => {
    if (!parseModelEntryKey(modelKey)) return;
    setModelApiKeys(prev => {
      const next = { ...prev };
      const cleanValue = value.trim();
      if (cleanValue) next[modelKey] = cleanValue;
      else delete next[modelKey];
      localStorage.setItem(MODEL_API_KEYS_STORAGE_KEY, JSON.stringify(next));
      broadcastEterxSettingsUpdate({ type: 'model-api-keys-updated', modelApiKeys: next });
      syncComposedKeys(apiKeys, next, modelEntries, modelOverrides);
      return next;
    });
    setHasChanges(true);
  }, [apiKeys, modelEntries, modelOverrides, syncComposedKeys]);

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
    broadcastEterxSettingsUpdate({ type: 'model-overrides-updated', modelOverrides: next });
    const nextMode = PROVIDER_MODE[provider];
    if (nextMode) updateSetting('agentMode', nextMode);
    syncComposedKeys(apiKeys, modelApiKeys, modelEntries, next);
    setHasChanges(true);
  }, [apiKeys, modelApiKeys, modelEntries, modelOverrides, syncComposedKeys, updateSetting]);

  const addModelToSelector = useCallback((provider: string, modelId: string, activate = true) => {
    const cleanProvider = String(provider || '').trim();
    const cleanModelId = String(modelId || '').trim();
    if (!isModelProvider(cleanProvider) || !cleanModelId) return;

    const nextEntries = ensureModelSelectorEntry(modelEntries, cleanProvider, cleanModelId);
    saveModelEntries(nextEntries);
    syncComposedKeys(apiKeys, modelApiKeys, nextEntries, modelOverrides);
    if (activate) selectCatalogModel(cleanProvider, cleanModelId);
    setHasChanges(true);
  }, [apiKeys, modelApiKeys, modelEntries, modelOverrides, saveModelEntries, selectCatalogModel, syncComposedKeys]);

  const removeModelFromSelector = useCallback((provider: string, modelId: string) => {
    const cleanProvider = String(provider || '').trim();
    const cleanModelId = String(modelId || '').trim();
    if (!isModelProvider(cleanProvider) || !cleanModelId) return;

    const removedKey = modelEntryKey(cleanProvider, cleanModelId);
    const nextEntries = removeModelSelectorEntry(modelEntries, cleanProvider, cleanModelId);
    saveModelEntries(nextEntries);
    const nextModelKeys = { ...modelApiKeys };
    delete nextModelKeys[removedKey];
    setModelApiKeys(nextModelKeys);
    localStorage.setItem(MODEL_API_KEYS_STORAGE_KEY, JSON.stringify(nextModelKeys));
    if (localStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) === removedKey) {
      localStorage.setItem(CHAT_MODEL_SELECTION_STORAGE_KEY, AUTO_MODEL_SELECTION);
    }
    if (modelOverrides[cleanProvider] === cleanModelId) {
      selectCatalogModel(cleanProvider, '');
      setExactModelDraft('');
    }
    syncComposedKeys(apiKeys, nextModelKeys, nextEntries, modelOverrides);
    setHasChanges(true);
  }, [apiKeys, modelApiKeys, modelEntries, modelOverrides, saveModelEntries, selectCatalogModel, syncComposedKeys]);

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
            className="eterx-settings-panel fixed inset-0 z-[99999] flex items-center justify-center bg-[#151515]"
          >
            {/* Backdrop */}
            {!standalone && <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />}

            {/* Panel */}
            <motion.div
              initial={{ opacity: 0, y: standalone ? 0 : 16, scale: standalone ? 1 : 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: standalone ? 0 : 10, scale: standalone ? 1 : 0.98 }}
              transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
              className={`${ standalone ? 'h-screen w-screen rounded-none border-0' : 'h-[min(980px,calc(100vh-24px))] w-[min(1760px,calc(100vw-24px))] rounded-md border border-white/[0.08]' } relative overflow-hidden flex flex-col bg-[#151515] shadow-[0_25px_80px_rgba(0,0,0,0.7)]`}
            >
              {/* Glass Background */}
              <div className="absolute inset-0 bg-[#151515]" />

              <div className="relative flex min-h-0 flex-1 flex-col sm:flex-row">

              {/* ─── Sidebar Tabs ─── */}
              <div className="relative z-10 w-full sm:w-[300px] shrink-0 overflow-hidden border-b border-white/[0.08] bg-[#1D1D1D] sm:border-b-0 sm:border-t flex flex-col">
                <div className="flex h-11 shrink-0 items-center px-3">
                  <button onClick={onClose} className="inline-flex h-9 items-center gap-2 rounded-md px-2 text-[#A7A7A7] transition-colors hover:bg-white/[0.05] hover:text-[#F1F1F1]">
                    <span className="grid h-5 w-5 shrink-0 place-items-center">
                      <ChevronRight className="h-4 w-4 rotate-180" />
                    </span>
                    <span className="text-[13.5px] font-medium leading-5">Back to app</span>
                  </button>
                </div>
                <nav className="flex gap-1 overflow-x-auto px-2 pb-2 sm:block sm:flex-1 sm:space-y-1 sm:overflow-y-auto sm:overflow-x-hidden sm:pb-2 eterx-scrollbar">
                  {tabs.map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`flex h-10 shrink-0 items-center gap-3 rounded-lg px-3 text-left text-[14.5px] font-medium leading-none transition-colors sm:w-full ${ activeTab === tab.id
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
              <div className="relative z-20 flex-1 flex flex-col min-w-0 overflow-hidden border-l border-t border-white/[0.08] bg-[#151515] sm:-ml-[1px] sm:rounded-l-[26px]">
                {/* Header */}
                <div className="h-11 shrink-0 border-b border-white/[0.075] bg-[#151515]" />

                {/* Scrollable Body */}
                <div className="flex-1 overflow-y-auto eterx-scrollbar px-4 py-16">
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={activeTab}
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                      transition={{ duration: 0.2 }}
                      className="mx-auto w-full max-w-[672px] pb-16"
                    >
                      <h3 className="mb-14 text-[26px] font-semibold leading-tight tracking-[-0.01em] text-[#F4F4F4]">{tabs.find(t => t.id === activeTab)?.label}</h3>

                      {/* ═══ GENERAL TAB ═══ */}
                      {activeTab === 'general' && (
                        <div>
                          <SectionHeader title="Work mode" />
                          <p className="-mt-2 mb-5 text-[14px] text-[#A5A5A5]">Choose how EterX-Agent should shape responses for your work.</p>
                          <div className="mb-12 grid gap-4 md:grid-cols-2">
                            {[
                              { id: 'everyday' as const, title: 'For everyday work', description: 'Clear answers for planning, writing, and routine tasks', icon: 'everyday' },
                              { id: 'specialist' as const, title: 'For specialist work', description: 'Deeper reasoning, tool control, and implementation detail', icon: 'specialist' },
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
                              <Toggle enabled={settings.defaultPermissions} onChange={v => updateSetting('defaultPermissions', v)} />
                            </SettingsStackRow>
                            <SettingsStackRow title="Auto-review" description="EterX can automatically review requests for additional access. Auto-review can make mistakes. Learn more about elevated risks." tall>
                              <Toggle enabled={settings.autoReview} onChange={v => updateSetting('autoReview', v)} />
                            </SettingsStackRow>
                            <SettingsStackRow title="Full access" description="When EterX runs with full access, it can edit any file on your computer and run commands with network access." tall>
                              <Toggle enabled={settings.fullAccess} onChange={v => updateSetting('fullAccess', v)} />
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
                            <SettingsStackRow title="Language" description="Language for the app UI">
                              <SelectControl
                                value={settings.language}
                                onChange={(value) => updateSetting('language', value)}
                                options={[
                                  { value: 'en', label: 'Auto Detect' },
                                  { value: 'hi', label: 'Hindi' },
                                  { value: 'es', label: 'Spanish' },
                                  { value: 'fr', label: 'French' },
                                  { value: 'de', label: 'German' },
                                  { value: 'ja', label: 'Japanese' },
                                  { value: 'zh', label: 'Chinese' },
                                ]}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Require Ctrl + Enter to send long prompts" description="When enabled, multiline prompts require Ctrl + Enter to send.">
                              <Toggle enabled={settings.requireCtrlEnter} onChange={v => updateSetting('requireCtrlEnter', v)} />
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

                          <SectionHeader title="Popout Window" />
                          <SettingsStack>
                            <SettingsStackRow title="Popout Window hotkey" description="Set a global shortcut for Popout Window. Leave unset to keep it off.">
                              <span className="text-[18px] text-[#A7A7A7]">Off</span>
                              <SoftButton>Set</SoftButton>
                            </SettingsStackRow>
                            <SettingsStackRow title="Default to projectless chat" description="Start new chats without a project">
                              <Toggle enabled={settings.defaultProjectlessChat} onChange={v => updateSetting('defaultProjectlessChat', v)} />
                            </SettingsStackRow>
                          </SettingsStack>

                          <SectionHeader title="Dictation" />
                          <SettingsStack>
                            <SettingsStackRow title="Hold-to-dictate hotkey" description="Hold anywhere on desktop to dictate where your cursor is">
                              <span className="text-[18px] text-[#A7A7A7]">Off</span>
                              <SoftButton>Set</SoftButton>
                            </SettingsStackRow>
                            <SettingsStackRow title="Toggle dictation hotkey" description="Press once anywhere on desktop to dictate, then press again to stop">
                              <span className="text-[18px] text-[#A7A7A7]">Off</span>
                              <SoftButton>Set</SoftButton>
                            </SettingsStackRow>
                            <SettingsStackRow title="Dictation dictionary" description="Words or phrases dictation should recognize">
                              <ChevronRight className="h-4 w-4 rotate-90 text-[#A7A7A7]" />
                            </SettingsStackRow>
                            <SettingsStackRow title="Recent dictations" description="Your recent dictations will appear here so you can recover text if it does not land where you expected" />
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
                            <SettingsStackRow title="EterX theme" description="Modern enterprise interface preset">
                              <SoftButton>Import</SoftButton>
                              <SoftButton>Copy theme</SoftButton>
                              <ModernSelect
                                value="eterx"
                                onChange={() => undefined}
                                className="w-[170px]"
                                options={[{ value: 'eterx', label: 'EterX' }]}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Accent" description="Primary action and active-control color">
                              <span className="inline-flex h-9 min-w-[130px] items-center gap-2 rounded-xl bg-[#2F8BEF] px-3 text-[13px] font-medium text-white">
                                <span className="h-4 w-4 rounded-full border border-white/30" />
                                #2F8BEF
                              </span>
                            </SettingsStackRow>
                            <SettingsStackRow title="Background" description="Main app surface">
                              <span className="inline-flex h-9 min-w-[130px] items-center gap-2 rounded-xl border border-white/[0.08] bg-[#141414] px-3 font-mono text-[12px] text-[#F1F1F1]">
                                <span className="h-4 w-4 rounded-full border border-white/[0.12] bg-[#151515]" />
                                #151515
                              </span>
                            </SettingsStackRow>
                            <SettingsStackRow title="Foreground" description="Primary readable text">
                              <span className="inline-flex h-9 min-w-[130px] items-center gap-2 rounded-xl border border-white/[0.08] bg-white px-3 font-mono text-[12px] text-[#1f1f1d]">
                                <span className="h-4 w-4 rounded-full border border-black/10 bg-white" />
                                #FFFFFF
                              </span>
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
                            <SettingsStackRow title="Use pointer cursors" description="Change the cursor when hovering over interactive elements">
                              <Toggle enabled={settings.pointerCursors} onChange={v => updateSetting('pointerCursors', v)} />
                            </SettingsStackRow>
                            <SettingsStackRow title="Reduce motion" description="Reduce animations or match your system">
                              <SegmentedControl
                                value={settings.reduceMotion}
                                onChange={(value) => updateSetting('reduceMotion', value)}
                                options={[
                                  { value: 'system', label: 'System' },
                                  { value: 'on', label: 'On' },
                                  { value: 'off', label: 'Off' },
                                ]}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="UI font size" description="Adjust the base size used for the EterX UI">
                              <span className="inline-flex h-9 items-center gap-2 rounded-xl border border-white/[0.08] bg-[#2D2D2D] px-4 text-[13px] font-medium text-[#F2F2F2]">
                                {settings.fontSize === 'compact' ? '13' : settings.fontSize === 'comfortable' ? '15' : '14'} <span className="text-[#A7A7A7]">px</span>
                              </span>
                            </SettingsStackRow>
                            <SettingsStackRow title="Diff markers" description="Use colored bars and backgrounds or show + and - symbols">
                              <SegmentedControl
                                value={settings.diffMarkers}
                                onChange={(value) => updateSetting('diffMarkers', value)}
                                options={[
                                  { value: 'color', label: 'Color' },
                                  { value: 'symbols', label: '+/-' },
                                ]}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Auto-save conversations" description="Persist chat sessions automatically to local storage">
                              <Toggle enabled={settings.autoSave} onChange={v => updateSetting('autoSave', v)} />
                            </SettingsStackRow>
                            <SettingsStackRow title="Sound effects" description="Play audio cues for important EterX events">
                              <Toggle enabled={settings.soundEnabled} onChange={v => updateSetting('soundEnabled', v)} />
                            </SettingsStackRow>
                          </SettingsStack>
                        </div>
                      )}

                      {/* ═══ AGENT TAB ═══ */}
                      {activeTab === 'configuration' && (
                        <div>
                          <SectionHeader title="Model routing" />
                          <SettingsStack>
                            <SettingsStackRow title="Agent model" description="Active model is used for the next main-agent run and helper planning calls.">
                              <ModernSelect
                                value={settings.agentMode}
                                onChange={(value) => updateSetting('agentMode', value as MainAgentMode)}
                                className="w-[280px]"
                                options={MAIN_AGENT_MODEL_OPTIONS.map(option => ({
                                  value: option.id,
                                  label: option.label,
                                }))}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Active provider" description="Provider used by the active routing profile.">
                              <span className={`rounded-full border px-3 py-1.5 text-[11px] font-semibold uppercase ${
                                providerReady(activeProvider)
                                  ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
                                  : 'border-white/[0.08] bg-white/[0.035] text-[#A7A7A7]'
                              }`}>
                                {PROVIDER_LABEL[activeProvider] || activeProvider} / {providerReady(activeProvider) ? 'Ready' : 'Key needed'}
                              </span>
                            </SettingsStackRow>
                            <SettingsStackRow title="Active model" description="Resolved model ID from the provider hub.">
                              <span className="max-w-[280px] truncate rounded-lg border border-white/[0.08] bg-[#141414] px-3 py-2 font-mono text-[12px] text-[#CFCFCF]">
                                {activeModelOverride || selectedModelOption?.modelName || 'Provider default'}
                              </span>
                            </SettingsStackRow>
                          </SettingsStack>

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

                          <SectionHeader title="Memory & context" />
                          <SettingsStack>
                            <SettingsStackRow title="Memory hydration" description="Load saved preferences and useful context at startup.">
                              <Toggle enabled={settings.memoryHydration} onChange={v => updateSetting('memoryHydration', v)} />
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
                              title={selectedConnectionProvider === 'openrouter' ? 'Exact OpenRouter model' : 'Exact model ID'}
                              description={selectedConnectionProvider === 'openrouter'
                                ? 'Paste any OpenRouter slug, for example openai/gpt-5.5 or anthropic/claude-opus-4.8.'
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
                                  <div className={modelEntries.length > 3 ? 'max-h-[172px] overflow-y-auto pr-1 eterx-scrollbar' : ''}>
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
                            {(selectedProviderGuide?.families || []).slice(0, 5).map(family => (
                              <SettingsStackRow key={`${selectedConnectionProvider}-${family.name}`} title={family.name} description={family.note}>
                                {family.id && <SoftButton onClick={() => addModelToSelector(selectedConnectionProvider, family.id!, true)}>Add</SoftButton>}
                              </SettingsStackRow>
                            ))}
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
                                minRows={10}
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
                                minRows={10}
                                onChange={(nextValue) => updateApiKey('tavily', nextValue)}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Code platform" description="GitHub token enables repository-aware actions when needed." tall>
                              <ApiKeyPoolEditor
                                provider="github"
                                providerLabel="GitHub"
                                value={apiKeys.github || ''}
                                sync={providerSync('github')}
                                minRows={10}
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
                          <p className="-mt-2 mb-4 text-[14px] leading-relaxed text-[#A5A5A5]">Give EterX extra instructions and project context.</p>
                          <textarea
                            value={settings.customInstructions || ''}
                            onChange={(event) => updateSetting('customInstructions', event.target.value)}
                            placeholder="Add your custom instructions..."
                            className="min-h-[260px] w-full resize-y rounded-xl border border-white/[0.09] bg-[#202020] px-4 py-3 font-mono text-[13px] leading-6 text-[#F1F1F1] outline-none transition-colors placeholder:text-[#777] focus:border-white/[0.20]"
                          />

                          <SectionHeader title="Memory" />
                          <SettingsStack>
                            <SettingsStackRow title="Memory hydration" description="Load past memories, preferences, and useful project context on startup.">
                              <Toggle enabled={settings.memoryHydration} onChange={v => updateSetting('memoryHydration', v)} />
                            </SettingsStackRow>
                            <SettingsStackRow title="Sound effects" description="Play audio cues for important EterX events.">
                              <Toggle enabled={settings.soundEnabled} onChange={v => updateSetting('soundEnabled', v)} />
                            </SettingsStackRow>
                          </SettingsStack>
                        </div>
                      )}

                      {activeTab === 'shortcuts' && (
                        <div>
                          <SectionHeader title="Keyboard shortcuts" />
                          <SettingRow icon={<Key className="w-4 h-4" />} title="Enable shortcuts" description="Allow global and in-app keyboard shortcuts for frequent actions.">
                            <Toggle enabled={settings.keyboardShortcuts} onChange={v => updateSetting('keyboardShortcuts', v)} />
                          </SettingRow>
                          <div className="rounded-xl border border-white/[0.08] bg-[#202020] overflow-hidden">
                            {[
                              ['New chat', 'Ctrl + N'],
                              ['Open settings', 'Ctrl + ,'],
                              ['Search chats', 'Ctrl + K'],
                              ['Toggle sidebar', 'Ctrl + B'],
                              ['Stop generation', 'Esc'],
                            ].map(([label, shortcut]) => (
                              <div key={label} className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4 last:border-b-0">
                                <span className="text-[15px] text-[#F1F1F1]">{label}</span>
                                <span className="rounded-md border border-white/[0.10] bg-[#141414] px-2.5 py-1 font-mono text-[12px] text-[#CFCFCF]">{shortcut}</span>
                              </div>
                            ))}
                          </div>
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

                      {activeTab === 'hooks' && (
                        <div>
                          <SectionHeader title="Hooks" />
                          <SettingRow icon={<Zap className="w-4 h-4" />} title="Enable hooks" description="Run configured local hooks around agent tasks, file edits, and completion events.">
                            <Toggle enabled={settings.hooksEnabled} onChange={v => updateSetting('hooksEnabled', v)} />
                          </SettingRow>
                          <SettingRow icon={<Shield className="w-4 h-4" />} title="Require review for hooks" description="Keep hook execution reviewable when commands or network calls are involved.">
                            <Toggle enabled={settings.autoReview} onChange={v => updateSetting('autoReview', v)} />
                          </SettingRow>
                          <div className="rounded-xl border border-dashed border-white/[0.10] bg-[#171717] px-5 py-6 text-[14px] text-[#A5A5A5]">
                            Hook definitions can be added from the workspace configuration when the project exposes them.
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

                      {activeTab === 'worktrees' && (
                        <div>
                          <SectionHeader title="Worktrees" />
                          <SettingRow icon={<FolderOpen className="w-4 h-4" />} title="Enable worktrees" description="Allow separate task worktrees for isolated agent changes when supported by the repository.">
                            <Toggle enabled={settings.worktreesEnabled} onChange={v => updateSetting('worktreesEnabled', v)} />
                          </SettingRow>
                          <SettingRow icon={<Shield className="w-4 h-4" />} title="Keep current workspace protected" description="Prefer isolated working copies before editing high-risk branches.">
                            <Toggle enabled={settings.isolatedEnvironments} onChange={v => updateSetting('isolatedEnvironments', v)} />
                          </SettingRow>
                          <div className="rounded-xl border border-white/[0.08] bg-[#202020] p-5">
                            <div className="text-[16px] font-medium text-[#F1F1F1]">Current workspace</div>
                            <div className="mt-2 font-mono text-[13px] text-[#A5A5A5]">C:\Harshil projects\EterX-Agent</div>
                          </div>
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

                      {activeTab === 'archives' && (
                        <div>
                          <SectionHeader title="Archived chats" />
                          <SettingsStack>
                            <SettingsStackRow title="Archive retention" description="Choose how long archived local chats remain in storage.">
                              <ModernSelect
                                value={settings.archiveRetention}
                                onChange={(value) => updateSetting('archiveRetention', value as AppSettings['archiveRetention'])}
                                className="w-[180px]"
                                options={[
                                  { value: '30', label: '30 days' },
                                  { value: '90', label: '90 days' },
                                  { value: 'forever', label: 'Forever' },
                                ]}
                              />
                            </SettingsStackRow>
                            <SettingsStackRow title="Archived chat count" description="Number of archived conversations stored locally.">
                              <span className="text-[18px] font-semibold text-[#F1F1F1]">
                                {(() => { try { const c = localStorage.getItem('eterx_archived_chats'); return c ? JSON.parse(c).length : 0; } catch { return 0; } })()}
                              </span>
                            </SettingsStackRow>
                          </SettingsStack>
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
                                    localStorage.removeItem(MODEL_API_KEYS_STORAGE_KEY);
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
                                  const data = JSON.stringify({ settings, apiKeys, modelOverrides, modelCatalog, modelEntries, modelApiKeys }, null, 2);
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
                        onClick={() => { setSettings(DEFAULT_SETTINGS); localStorage.setItem('eterx_settings', JSON.stringify(DEFAULT_SETTINGS)); }}
                        className="text-[12px] text-[#666] hover:text-[#E8E6E3] transition-colors"
                      >
                        Reset to defaults
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              </div>
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
