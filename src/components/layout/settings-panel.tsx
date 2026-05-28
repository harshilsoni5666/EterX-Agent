'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Settings, Bot, Key, Zap, User, Shield, Palette,
  ChevronRight, ToggleLeft, ToggleRight, Monitor, Moon, Sun,
  Database, Brain, Cpu, Activity, Gauge, Sliders, Eye, EyeOff,
  Copy, Check, Info, AlertTriangle, Sparkles, Volume2, Globe,
  FileCode, FolderOpen, Terminal, Layers, RefreshCw, Lock
} from 'lucide-react';
import { MAIN_AGENT_MODEL_OPTIONS, type MainAgentMode } from '../../lib/agent/model-routing';

// ─── Settings Shape ────────────────────────────────────
export interface AppSettings {
  // General
  theme: 'dark' | 'light' | 'system';
  userName: string;
  fontSize: 'compact' | 'default' | 'comfortable';
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

  // Advanced
  debugMode: boolean;
  telemetry: boolean;
  experimentalFeatures: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  userName: 'Developer',
  fontSize: 'default',
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
  debugMode: false,
  telemetry: false,
  experimentalFeatures: false,
};

type Tab = 'general' | 'agent' | 'api' | 'advanced' | 'account';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

// ─── Custom Toggle ─────────────────────────────────────
const Toggle: React.FC<{ enabled: boolean; onChange: (v: boolean) => void; disabled?: boolean }> = ({ enabled, onChange, disabled }) => (
  <button
    onClick={() => !disabled && onChange(!enabled)}
    className={`relative w-[42px] h-[24px] rounded-full transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] shrink-0 ${ disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
      } ${ enabled ? 'bg-[#E2765A] shadow-[0_0_12px_rgba(226,118,90,0.3)]' : 'bg-white/10 hover:bg-white/15' }`}
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
      className="flex-1 h-1 bg-white/10 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#E2765A] [&::-webkit-slider-thumb]:shadow-[0_0_8px_rgba(226,118,90,0.4)] [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-125"
    />
    <span className="text-[13px] font-mono text-[#E2765A] min-w-[28px] text-right">{value}</span>
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
  <div className={`flex items-center justify-between py-4 px-1 group ${ danger ? '' : 'border-b border-white/[0.04]' }`}>
    <div className="flex items-start gap-3 flex-1 min-w-0 mr-4">
      <div className={`mt-0.5 p-1.5 rounded-lg shrink-0 ${ danger ? 'bg-red-500/10 text-red-400' : 'bg-white/[0.04] text-[#8C8A88] group-hover:text-[#E8E6E3]' } transition-colors`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className={`text-[13.5px] font-medium ${ danger ? 'text-red-400' : 'text-[#E8E6E3]' }`}>{title}</div>
        <div className="text-[12px] text-[#666] mt-0.5 leading-relaxed">{description}</div>
      </div>
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

// ─── Section Header ────────────────────────────────────
const SectionHeader: React.FC<{ title: string; badge?: string }> = ({ title, badge }) => (
  <div className="flex items-center gap-2 mb-1 mt-6 first:mt-0">
    <span className="text-[10px] font-bold text-[#555350] uppercase tracking-[0.2em]">{title}</span>
    {badge && (
      <span className="text-[9px] font-bold bg-[#E2765A]/15 text-[#E2765A] px-1.5 py-0.5 rounded-full tracking-wider uppercase">{badge}</span>
    )}
    <div className="flex-1 h-px bg-white/[0.04]" />
  </div>
);

// ─── API Key Row ───────────────────────────────────────
const ApiKeyRow: React.FC<{ name: string; icon: React.ReactNode; keyValue: string; onUpdate: (v: string) => void }> = ({ name, icon, keyValue, onUpdate }) => {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(keyValue);

  const handleCopy = () => {
    navigator.clipboard.writeText(keyValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="py-3.5 px-1 border-b border-white/[0.04]">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg bg-white/[0.04] text-[#8C8A88]">{icon}</div>
          <span className="text-[13.5px] font-medium text-[#E8E6E3]">{name}</span>
        </div>
        <div className="flex items-center gap-1">
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
            className="flex-1 bg-white/[0.04] border border-white/10 rounded-lg px-3 py-2 text-[12px] font-mono text-[#E8E6E3] outline-none focus:border-[#E2765A]/40 transition-colors"
            placeholder="Enter API key..."
          />
          <button onClick={() => { onUpdate(draft); setEditing(false); }} className="px-3 py-2 bg-[#E2765A]/20 text-[#E2765A] rounded-lg text-[12px] font-medium hover:bg-[#E2765A]/30 transition-colors">Save</button>
        </div>
      ) : (
        <div
          onClick={() => setEditing(true)}
          className="bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2 text-[12px] font-mono text-[#555] cursor-pointer hover:border-white/10 transition-colors"
        >
          {keyValue ? (visible ? keyValue : '•'.repeat(Math.min(keyValue.length, 40))) : <span className="text-[#444] italic">Click to add key...</span>}
        </div>
      )}
    </div>
  );
};


// ═══════════════════════════════════════════════════════
// MAIN SETTINGS PANEL
// ═══════════════════════════════════════════════════════
export const SettingsPanel: React.FC<SettingsPanelProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<Tab>('general');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
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

  // Load settings from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem('eterx_settings');
      if (saved) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(saved) });
      const savedKeys = localStorage.getItem('eterx_api_keys');
      if (savedKeys) setApiKeys(JSON.parse(savedKeys));
    } catch { }
  }, [isOpen]);

  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      localStorage.setItem('eterx_settings', JSON.stringify(next));
      // Notify other components (e.g., page.tsx userName sync)
      window.dispatchEvent(new Event('eterx-settings-updated'));
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
    applyTheme(settings.theme);

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
      const next = { ...prev, [name]: value };
      localStorage.setItem('eterx_api_keys', JSON.stringify(next));
      return next;
    });
    setHasChanges(true);
  }, []);

  // Close on escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    if (isOpen) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'general', label: 'General', icon: <Settings className="w-[16px] h-[16px]" /> },
    { id: 'agent', label: 'Agent', icon: <Bot className="w-[16px] h-[16px]" /> },
    { id: 'api', label: 'API Keys', icon: <Key className="w-[16px] h-[16px]" /> },
    { id: 'advanced', label: 'Advanced', icon: <Zap className="w-[16px] h-[16px]" /> },
    { id: 'account', label: 'Account', icon: <User className="w-[16px] h-[16px]" /> },
  ];

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
            className="fixed inset-0 z-[99999] flex items-center justify-center"
          >
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/60 backdrop-blur-md" onClick={onClose} />

            {/* Panel */}
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.98 }}
              transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
              className="relative w-[820px] max-w-[92vw] h-[600px] max-h-[85vh] rounded-2xl overflow-hidden flex flex-col sm:flex-row shadow-[0_25px_80px_rgba(0,0,0,0.7)] border border-white/[0.08]"
            >
              {/* Glass Background */}
              <div className="absolute inset-0 bg-[#0E0E0E]/95 backdrop-blur-3xl" />
              {/* Subtle accent glow top-left */}
              <div className="absolute -top-20 -left-20 w-60 h-60 bg-[#E2765A]/[0.04] rounded-full blur-[80px] pointer-events-none" />

              {/* ─── Sidebar Tabs ─── */}
              <div className="relative w-full sm:w-[200px] shrink-0 border-b sm:border-b-0 sm:border-r border-white/[0.06] flex flex-col bg-white/[0.01]">
                <div className="p-4 pb-2 sm:p-5 sm:pb-3">
                  <h2 className="text-[15px] font-semibold text-[#E8E6E3] tracking-tight">Settings</h2>
                  <p className="text-[11px] text-[#555] mt-0.5">Configure EterX</p>
                </div>
                <nav className="flex gap-1 overflow-x-auto px-2 pb-2 sm:block sm:flex-1 sm:space-y-[2px] sm:overflow-visible sm:pb-0">
                  {tabs.map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`shrink-0 sm:w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] font-medium transition-all duration-300 ${ activeTab === tab.id
                        ? 'bg-white/[0.08] text-[#E8E6E3] shadow-sm border border-white/[0.08]'
                        : 'text-[#8C8A88] hover:text-[#E8E6E3] hover:bg-white/[0.03] border border-transparent'
                        }`}
                    >
                      <span className={`transition-colors ${ activeTab === tab.id ? 'text-[#E2765A]' : '' }`}>{tab.icon}</span>
                      {tab.label}
                    </button>
                  ))}
                </nav>
                {/* Version footer */}
                <div className="hidden sm:block p-4 pt-2 border-t border-white/[0.04]">
                  <div className="text-[10px] text-[#444] font-mono">EterX Agent v2.4.0</div>
                  <div className="text-[10px] text-[#333] font-mono mt-0.5">Build 2026.04.11</div>
                </div>
              </div>

              {/* ─── Content ─── */}
              <div className="relative flex-1 flex flex-col min-w-0">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] shrink-0">
                  <div>
                    <h3 className="text-[14px] font-semibold text-[#E8E6E3]">{tabs.find(t => t.id === activeTab)?.label}</h3>
                    <p className="text-[11px] text-[#555] mt-0.5">
                      {activeTab === 'general' && 'Appearance, behavior, and preferences'}
                      {activeTab === 'agent' && 'Agent reasoning, memory, and execution'}
                      {activeTab === 'api' && 'Manage your API keys and integrations'}
                      {activeTab === 'advanced' && 'Developer tools and experimental features'}
                      {activeTab === 'account' && 'Profile, usage, and subscription'}
                    </p>
                  </div>
                  <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/5 text-[#555] hover:text-[#E8E6E3] transition-colors">
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Scrollable Body */}
                <div className="flex-1 overflow-y-auto eterx-scrollbar px-6 py-2">
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={activeTab}
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                      transition={{ duration: 0.2 }}
                    >

                      {/* ═══ GENERAL TAB ═══ */}
                      {activeTab === 'general' && (
                        <div>
                          <SectionHeader title="Appearance" />
                          <SettingRow icon={<Palette className="w-4 h-4" />} title="Theme" description="Choose your preferred color mode">
                            <div className="flex bg-white/[0.04] rounded-lg p-0.5 border border-white/[0.06]">
                              {(['dark', 'light', 'system'] as const).map(t => (
                                <button
                                  key={t}
                                  onClick={() => updateSetting('theme', t)}
                                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-all ${ settings.theme === t
                                    ? 'bg-white/10 text-[#E8E6E3] shadow-sm'
                                    : 'text-[#666] hover:text-[#A3A19E]'
                                    }`}
                                >
                                  {t === 'dark' && <Moon className="w-3 h-3" />}
                                  {t === 'light' && <Sun className="w-3 h-3" />}
                                  {t === 'system' && <Monitor className="w-3 h-3" />}
                                  {t.charAt(0).toUpperCase() + t.slice(1)}
                                </button>
                              ))}
                            </div>
                          </SettingRow>

                          <SettingRow icon={<Sliders className="w-4 h-4" />} title="Display Density" description="Adjust spacing and text size">
                            <div className="flex bg-white/[0.04] rounded-lg p-0.5 border border-white/[0.06]">
                              {(['compact', 'default', 'comfortable'] as const).map(s => (
                                <button
                                  key={s}
                                  onClick={() => updateSetting('fontSize', s)}
                                  className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-all ${ settings.fontSize === s
                                    ? 'bg-white/10 text-[#E8E6E3] shadow-sm'
                                    : 'text-[#666] hover:text-[#A3A19E]'
                                    }`}
                                >
                                  {s.charAt(0).toUpperCase() + s.slice(1)}
                                </button>
                              ))}
                            </div>
                          </SettingRow>

                          <SectionHeader title="Behavior" />
                          <SettingRow icon={<Sparkles className="w-4 h-4" />} title="Animations" description="Enable smooth UI transitions and effects">
                            <Toggle enabled={settings.animationsEnabled} onChange={v => updateSetting('animationsEnabled', v)} />
                          </SettingRow>

                          <SettingRow icon={<Volume2 className="w-4 h-4" />} title="Sound Effects" description="Play audio cues for agent events">
                            <Toggle enabled={settings.soundEnabled} onChange={v => updateSetting('soundEnabled', v)} />
                          </SettingRow>

                          <SettingRow icon={<Database className="w-4 h-4" />} title="Auto-save Conversations" description="Persist chat sessions automatically to local storage">
                            <Toggle enabled={settings.autoSave} onChange={v => updateSetting('autoSave', v)} />
                          </SettingRow>

                          <SettingRow icon={<Globe className="w-4 h-4" />} title="Language" description="Interface language preference">
                            <select
                              value={settings.language}
                              onChange={(e) => updateSetting('language', e.target.value)}
                              className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-[12px] text-[#E8E6E3] outline-none cursor-pointer hover:border-white/15 transition-colors appearance-none pr-6"
                            >
                              <option value="en">English</option>
                              <option value="hi">Hindi</option>
                              <option value="es">Spanish</option>
                              <option value="fr">French</option>
                              <option value="de">German</option>
                              <option value="ja">Japanese</option>
                              <option value="zh">Chinese</option>
                            </select>
                          </SettingRow>
                        </div>
                      )}

                      {/* ═══ AGENT TAB ═══ */}
                      {activeTab === 'agent' && (
                        <div>
                          <SectionHeader title="Reasoning Engine" />
                          <SettingRow icon={<Brain className="w-4 h-4" />} title="Agent Model" description="Selected model is used for the next main-agent run and helper planning calls.">
                            <div className="flex bg-white/[0.04] rounded-lg p-0.5 border border-white/[0.06]">
                              {MAIN_AGENT_MODEL_OPTIONS.map(option => (
                                <button
                                  key={option.id}
                                  onClick={() => updateSetting('agentMode', option.id)}
                                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-all ${ settings.agentMode === option.id
                                    ? 'bg-white/10 text-[#E8E6E3] shadow-sm'
                                    : 'text-[#666] hover:text-[#A3A19E]'
                                    }`}
                                >
                                  {option.provider === 'mistral' ? <Cpu className="w-3 h-3" /> : <Brain className="w-3 h-3" />}
                                  {option.label}
                                </button>
                              ))}
                            </div>
                          </SettingRow>

                          <SettingRow icon={<Shield className="w-4 h-4" />} title="Critic Verification" description="Runs a hostile auditor to verify agent output quality before delivery">
                            <Toggle enabled={settings.criticEnabled} onChange={v => updateSetting('criticEnabled', v)} />
                          </SettingRow>

                          <SettingRow icon={<Activity className="w-4 h-4" />} title="Stream Responses" description="Stream agent output in real-time as it generates">
                            <Toggle enabled={settings.streamResponses} onChange={v => updateSetting('streamResponses', v)} />
                          </SettingRow>

                          <SectionHeader title="Sub-Agents" />
                          <SettingRow icon={<Layers className="w-4 h-4" />} title="Auto Sub-Agent Spawning" description="Allow the orchestrator to spin up parallel agents automatically">
                            <Toggle enabled={settings.autoSubAgents} onChange={v => updateSetting('autoSubAgents', v)} />
                          </SettingRow>

                          <SettingRow icon={<Cpu className="w-4 h-4" />} title="Max Concurrent Sub-Agents" description="Maximum number of parallel agents that can run simultaneously">
                            <SettingSlider value={settings.maxSubAgents} min={1} max={10} onChange={v => updateSetting('maxSubAgents', v)} label="" />
                          </SettingRow>

                          <SettingRow icon={<RefreshCw className="w-4 h-4" />} title="Max Retry Attempts" description="How many times the agent will retry on failure before giving up">
                            <SettingSlider value={settings.maxRetries} min={0} max={5} onChange={v => updateSetting('maxRetries', v)} label="" />
                          </SettingRow>

                          <SectionHeader title="Memory & Context" />
                          <SettingRow icon={<Database className="w-4 h-4" />} title="Memory Hydration" description="Load past memories, preferences, and error patterns from disk on startup">
                            <Toggle enabled={settings.memoryHydration} onChange={v => updateSetting('memoryHydration', v)} />
                          </SettingRow>

                          <SettingRow icon={<Globe className="w-4 h-4" />} title="Google Search Grounding" description="Enable real-time web search to ground agent responses in facts">
                            <Toggle enabled={settings.groundingSearch} onChange={v => updateSetting('groundingSearch', v)} />
                          </SettingRow>
                        </div>
                      )}

                      {/* ═══ API KEYS TAB ═══ */}
                      {activeTab === 'api' && (
                        <div>
                          <SectionHeader title="Model Providers" />
                          <div className="bg-white/[0.02] rounded-xl border border-white/[0.04] p-4 mb-4">
                            <div className="flex items-start gap-2.5 mb-3">
                              <Info className="w-4 h-4 text-[#E2765A] mt-0.5 shrink-0" />
                              <p className="text-[12px] text-[#666] leading-relaxed">
                                API keys are stored <span className="text-[#A3A19E] font-medium">locally</span> in your browser and never sent to external servers.
                                The agent auto-discovers keys from your <span className="font-mono text-[#E2765A]/80">.env.local</span> file on the server side.
                              </p>
                            </div>
                          </div>

                          <ApiKeyRow
                            name="Google Gemini"
                            icon={<Sparkles className="w-4 h-4" />}
                            keyValue={apiKeys['gemini'] || ''}
                            onUpdate={(v) => updateApiKey('gemini', v)}
                          />
                          <ApiKeyRow
                            name="OpenRouter"
                            icon={<Globe className="w-4 h-4" />}
                            keyValue={apiKeys['openrouter'] || ''}
                            onUpdate={(v) => updateApiKey('openrouter', v)}
                          />
                          <ApiKeyRow
                            name="Anthropic Claude"
                            icon={<Brain className="w-4 h-4" />}
                            keyValue={apiKeys['anthropic'] || ''}
                            onUpdate={(v) => updateApiKey('anthropic', v)}
                          />
                          <ApiKeyRow
                            name="OpenAI"
                            icon={<Cpu className="w-4 h-4" />}
                            keyValue={apiKeys['openai'] || ''}
                            onUpdate={(v) => updateApiKey('openai', v)}
                          />

                          <SectionHeader title="Services" />
                          <ApiKeyRow
                            name="Tavily Search"
                            icon={<Globe className="w-4 h-4" />}
                            keyValue={apiKeys['tavily'] || ''}
                            onUpdate={(v) => updateApiKey('tavily', v)}
                          />
                          <ApiKeyRow
                            name="GitHub Token"
                            icon={<FileCode className="w-4 h-4" />}
                            keyValue={apiKeys['github'] || ''}
                            onUpdate={(v) => updateApiKey('github', v)}
                          />
                        </div>
                      )}

                      {/* ═══ ADVANCED TAB ═══ */}
                      {activeTab === 'advanced' && (
                        <div>
                          <SectionHeader title="Developer" />
                          <SettingRow icon={<Terminal className="w-4 h-4" />} title="Debug Mode" description="Show detailed internal logs, tool calls, and reasoning traces in console">
                            <Toggle enabled={settings.debugMode} onChange={v => updateSetting('debugMode', v)} />
                          </SettingRow>

                          <SettingRow icon={<Activity className="w-4 h-4" />} title="Performance Telemetry" description="Collect anonymous performance metrics to improve agent speed">
                            <Toggle enabled={settings.telemetry} onChange={v => updateSetting('telemetry', v)} />
                          </SettingRow>

                          <SectionHeader title="Experimental" badge="BETA" />
                          <SettingRow icon={<Sparkles className="w-4 h-4" />} title="Experimental Features" description="Enable cutting-edge capabilities that may be unstable">
                            <Toggle enabled={settings.experimentalFeatures} onChange={v => updateSetting('experimentalFeatures', v)} />
                          </SettingRow>

                          <SectionHeader title="Data" />
                          <SettingRow icon={<Database className="w-4 h-4" />} title="Clear Agent Memory" description="Wipe all stored memories, preferences, and error patterns from disk">
                            <button
                              onClick={() => {
                                if (confirm('This will permanently delete all agent memory. Continue?')) {
                                  localStorage.removeItem('eterx_settings');
                                  localStorage.removeItem('eterx_api_keys');
                                  setSettings(DEFAULT_SETTINGS);
                                  setApiKeys({});
                                }
                              }}
                              className="px-3 py-1.5 bg-red-500/10 text-red-400 rounded-lg text-[12px] font-medium hover:bg-red-500/20 border border-red-500/20 transition-colors"
                            >
                              Clear Data
                            </button>
                          </SettingRow>
                          <SettingRow icon={<FolderOpen className="w-4 h-4" />} title="Export All Settings" description="Download your complete configuration as a JSON file" danger={false}>
                            <button
                              onClick={() => {
                                const data = JSON.stringify({ settings, apiKeys }, null, 2);
                                const blob = new Blob([data], { type: 'application/json' });
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url; a.download = 'eterx-settings.json'; a.click();
                                URL.revokeObjectURL(url);
                              }}
                              className="px-3 py-1.5 bg-white/[0.04] text-[#A3A19E] rounded-lg text-[12px] font-medium hover:bg-white/[0.08] border border-white/[0.08] transition-colors"
                            >
                              Export
                            </button>
                          </SettingRow>
                        </div>
                      )}

                      {/* ═══ ACCOUNT TAB ═══ */}
                      {activeTab === 'account' && (
                        <div>
                          <SectionHeader title="Profile" />
                          <div className="bg-white/[0.02] rounded-xl border border-white/[0.05] p-5 flex items-center gap-4 mb-4">
                            <div className="w-14 h-14 rounded-full bg-gradient-to-br from-[#32312F] to-[#1C1B1A] flex items-center justify-center text-[#E8E6E3] font-bold text-xl border border-white/10 shadow-inner shrink-0">
                              {settings.userName?.charAt(0).toUpperCase() || 'U'}
                            </div>
                            <div className="flex-1 min-w-0">
                              <input
                                value={settings.userName || ''}
                                onChange={(e) => updateSetting('userName', e.target.value)}
                                className="bg-transparent border-b border-white/[0.1] focus:border-[#E2765A] outline-none text-[15px] font-semibold text-[#E8E6E3] w-full pb-0.5 mb-1 transition-colors"
                              />
                              <div className="text-[12px] text-[#666] mt-0.5">Local workspace · Desktop Agent</div>
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
