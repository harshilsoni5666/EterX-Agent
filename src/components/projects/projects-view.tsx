"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Plus, Mic, ArrowUp, Check, ChevronRight, ChevronLeft } from 'lucide-react';
import { PremiumSend } from '../ui/premium-icons';
import {
  MAIN_AGENT_MODEL_OPTIONS,
  MAIN_AGENT_THINKING_LEVEL_OPTIONS,
  getMainAgentModelConfig,
  normalizeMainAgentThinkingLevel,
  type MainAgentProvider,
  type MainAgentMode,
  type MainAgentThinkingLevel,
} from '../../lib/agent/model-routing';
import {
  AUTO_MODEL_SELECTION,
  CHAT_MODEL_SELECTION_STORAGE_KEY,
  MODEL_API_KEYS_STORAGE_KEY,
  MODEL_CATALOG_STORAGE_KEY,
  MODEL_OVERRIDE_STORAGE_KEY,
  MODEL_SELECTOR_STORAGE_KEY,
  MODEL_PROVIDER_MODE,
  modelEntryKey,
  normalizeModelSelectorEntries,
  type ModelSelectorEntry,
} from '../../lib/agent/model-selector-store';

const MODEL_API_KEY_STORAGE_KEY = 'eterx_api_keys';
const SETTINGS_CHANNEL = 'eterx-settings';

type StoredModelSettings = {
  apiKeys: Partial<Record<MainAgentProvider, string>>;
  modelOverrides: Partial<Record<MainAgentProvider, string>>;
  modelCatalog: Partial<Record<MainAgentProvider, string[]>>;
  modelEntries: ModelSelectorEntry[];
  modelApiKeys: Record<string, string>;
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
  isAuto?: boolean;
};

const MODEL_PROVIDER_LABEL: Record<MainAgentProvider, string> = {
  gemini: 'Google Gemini',
  mistral: 'Mistral',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  anthropic: 'Anthropic',
};

const readStringRecord = (storageKey: string): Record<string, string> => {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
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
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
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

const readStoredModelSettings = (): StoredModelSettings => {
  const apiKeys = readStringRecord(MODEL_API_KEY_STORAGE_KEY) as Partial<Record<MainAgentProvider, string>>;
  const modelOverrides = readStringRecord(MODEL_OVERRIDE_STORAGE_KEY) as Partial<Record<MainAgentProvider, string>>;
  const modelCatalog = readStringArrayRecord(MODEL_CATALOG_STORAGE_KEY) as Partial<Record<MainAgentProvider, string[]>>;
  const savedEntries = typeof window !== 'undefined'
    ? (() => {
      try {
        return JSON.parse(window.localStorage.getItem(MODEL_SELECTOR_STORAGE_KEY) || '[]');
      } catch {
        return [];
      }
    })()
    : [];
  const overrideEntries = Object.entries(modelOverrides)
    .map(([provider, modelId]) => ({ provider: provider as MainAgentProvider, modelId: String(modelId || '').trim() }))
    .filter(entry => entry.modelId);
  const modelEntries = normalizeModelSelectorEntries([...normalizeModelSelectorEntries(savedEntries, modelCatalog), ...overrideEntries], modelCatalog);
  const modelApiKeys = readStringRecord(MODEL_API_KEYS_STORAGE_KEY);
  const chatModelSelection = typeof window !== 'undefined'
    ? (window.localStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) || AUTO_MODEL_SELECTION)
    : AUTO_MODEL_SELECTION;

  return {
    apiKeys,
    modelOverrides,
    modelCatalog,
    modelEntries,
    modelApiKeys,
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

interface ProjectsViewProps {
  selectedSection: string;
  setSelectedSection: (section: string) => void;
}

export const ProjectsView: React.FC<ProjectsViewProps> = ({
  selectedSection,
  setSelectedSection,
}) => {
  const [inputValue, setInputValue] = useState("");
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showThinkingLevels, setShowThinkingLevels] = useState(false);
  const modelSelectorRef = useRef<HTMLDivElement>(null);
  
  const [scheduleMode, setScheduleMode] = useState('manual');
  
  // Manual scheduler reference states
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  
  // Recurrence state loaded from default localStorage
  const [recurrence, setRecurrence] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem('eterx_scheduler_default_repeat') || 'daily';
    }
    return 'daily';
  });
  
  const [priority, setPriority] = useState('medium');
  const [formModel, setFormModel] = useState(AUTO_MODEL_SELECTION);
  const [triggerTime, setTriggerTime] = useState('09:00');
  
  // Custom manual inputs
  const [customTimeVal, setCustomTimeVal] = useState('9:00');
  const [customTimePeriod, setCustomTimePeriod] = useState<'AM' | 'PM'>('AM');
  const [customRepeatVal, setCustomRepeatVal] = useState('');
  const [showCustomRepeatForm, setShowCustomRepeatForm] = useState(false);
  
  // Sources (attached file/folder pins) real state
  const [attachedPins, setAttachedPins] = useState<{ id: string; name: string; type: string; path: string }[]>([]);
  
  const [activePopover, setActivePopover] = useState<string | null>(null);
  const [showSourceMenu, setShowSourceMenu] = useState(false);
  
  const detailsRef = useRef<HTMLDivElement>(null);
  const frequencyRef = useRef<HTMLDivElement>(null);
  const sourceMenuRef = useRef<HTMLDivElement>(null);

  const [storedModelSettings, setStoredModelSettings] = useState(readStoredModelSettings);
  const [thinkingLevel, setThinkingLevel] = useState(() => {
    if (typeof window !== 'undefined') {
      return (window.localStorage.getItem('eterx_chat_thinking_level') || 'medium') as MainAgentThinkingLevel;
    }
    return 'medium' as MainAgentThinkingLevel;
  });

  const agentMode: MainAgentMode = useMemo(() => {
    if (typeof window !== 'undefined') {
      return (window.localStorage.getItem('eterx_chat_agent_mode') || 'auto') as MainAgentMode;
    }
    return 'auto' as MainAgentMode;
  }, [storedModelSettings.chatModelSelection]);

  useEffect(() => {
    const handleUpdate = () => {
      setStoredModelSettings(readStoredModelSettings());
      if (typeof window !== 'undefined') {
        setThinkingLevel((window.localStorage.getItem('eterx_chat_thinking_level') || 'medium') as MainAgentThinkingLevel);
      }
    };
    window.addEventListener('eterx-settings-updated', handleUpdate);
    return () => window.removeEventListener('eterx-settings-updated', handleUpdate);
  }, []);

  // Set selected repeat rule as default in localStorage
  const handleSetRecurrence = useCallback((val: string) => {
    setRecurrence(val);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('eterx_scheduler_default_repeat', val);
    }
  }, []);

  // Sync custom time input values when opening the time popover
  useEffect(() => {
    if (activePopover === 'time') {
      const [hStr, mStr] = triggerTime.split(':');
      const h = parseInt(hStr, 10);
      const period = h >= 12 ? 'PM' : 'AM';
      const displayHour = h % 12 === 0 ? 12 : h % 12;
      setCustomTimeVal(`${displayHour}:${mStr}`);
      setCustomTimePeriod(period);
    }
  }, [activePopover, triggerTime]);

  // Sync custom repeat value when opening the repeat popover
  useEffect(() => {
    if (activePopover === 'repeat') {
      if (recurrence.startsWith('custom:')) {
        setCustomRepeatVal(recurrence.split(':')[1]);
        setShowCustomRepeatForm(true);
      } else {
        setCustomRepeatVal('');
        setShowCustomRepeatForm(false);
      }
    }
  }, [activePopover, recurrence]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modelSelectorRef.current && !modelSelectorRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
        setShowThinkingLevels(false);
      }
      if (
        (activePopover === 'model' || activePopover === 'priority') && 
        detailsRef.current && !detailsRef.current.contains(e.target as Node)
      ) {
        setActivePopover(null);
      }
      if (
        (activePopover === 'repeat' || activePopover === 'time') && 
        frequencyRef.current && !frequencyRef.current.contains(e.target as Node)
      ) {
        setActivePopover(null);
      }
      if (sourceMenuRef.current && !sourceMenuRef.current.contains(e.target as Node)) {
        setShowSourceMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [activePopover]);

  const modelOptions = useMemo<ChatModelOption[]>(() => {
    return storedModelSettings.modelEntries.map(entry => {
      const mode = MODEL_PROVIDER_MODE[entry.provider];
      const baseOption = MAIN_AGENT_MODEL_OPTIONS.find(option => option.id === mode) || getMainAgentModelConfig(mode);
      return {
        optionKey: modelEntryKey(entry.provider, entry.modelId),
        id: mode,
        provider: entry.provider,
        label: entry.modelId || entry.provider,
        compactLabel: baseOption.compactLabel,
        modelName: entry.modelId || entry.provider,
        modelId: entry.modelId,
      };
    });
  }, [storedModelSettings.modelEntries]);

  const fallbackModelConfig = useMemo(() => getMainAgentModelConfig(agentMode), [agentMode]);
  
  const autoModelOption = useMemo<ChatModelOption>(() => ({
    optionKey: AUTO_MODEL_SELECTION,
    id: fallbackModelConfig.id,
    provider: fallbackModelConfig.provider,
    label: 'Auto',
    compactLabel: 'Auto',
    modelName: 'Auto',
    isAuto: true,
  }), [fallbackModelConfig]);

  const selectedModel = useMemo(() => {
    return storedModelSettings.chatModelSelection === AUTO_MODEL_SELECTION
      ? autoModelOption
      : modelOptions.find(option => option.optionKey === storedModelSettings.chatModelSelection) || autoModelOption;
  }, [modelOptions, autoModelOption, storedModelSettings.chatModelSelection]);

  // Set default model on catalog load
  useEffect(() => {
    setFormModel(selectedModel.optionKey);
  }, [selectedModel]);

  const allModelOptions = useMemo(() => [autoModelOption, ...modelOptions], [autoModelOption, modelOptions]);
  const safeThinkingLevel = useMemo(() => normalizeMainAgentThinkingLevel(thinkingLevel), [thinkingLevel]);
  
  const selectedThinkingLevel = useMemo(() => {
    return MAIN_AGENT_THINKING_LEVEL_OPTIONS.find(option => option.id === safeThinkingLevel) || MAIN_AGENT_THINKING_LEVEL_OPTIONS[0];
  }, [safeThinkingLevel]);

  const getModelOptionLabel = useCallback((option: ChatModelOption) => option.label, []);
  const modelDisplayLabel = getModelOptionLabel(selectedModel);

  const selectChatModelOption = useCallback((option: ChatModelOption) => {
    if (typeof window !== 'undefined') {
      if (option.isAuto) {
        window.localStorage.setItem(CHAT_MODEL_SELECTION_STORAGE_KEY, AUTO_MODEL_SELECTION);
        window.localStorage.setItem(MODEL_OVERRIDE_STORAGE_KEY, JSON.stringify({}));
        setStoredModelSettings(prev => ({
          ...prev,
          modelOverrides: {},
          chatModelSelection: AUTO_MODEL_SELECTION,
        }));
        emitModelSettingsUpdate({ chatModelSelection: AUTO_MODEL_SELECTION, modelOverrides: {} });
      } else {
        window.localStorage.setItem(CHAT_MODEL_SELECTION_STORAGE_KEY, option.optionKey);
        const nextOverrides = {
          ...storedModelSettings.modelOverrides,
          [option.provider]: option.modelId || '',
        };
        window.localStorage.setItem(MODEL_OVERRIDE_STORAGE_KEY, JSON.stringify(nextOverrides));
        setStoredModelSettings(prev => ({
          ...prev,
          modelOverrides: nextOverrides,
          chatModelSelection: option.optionKey,
        }));
        emitModelSettingsUpdate({ chatModelSelection: option.optionKey, modelOverrides: nextOverrides });
      }
      setShowModelMenu(false);
    }
  }, [storedModelSettings.modelOverrides]);

  const selectThinkingLevel = useCallback((levelId: MainAgentThinkingLevel) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('eterx_chat_thinking_level', levelId);
      emitModelSettingsUpdate({ thinkingLevel: levelId });
      setShowThinkingLevels(false);
      setShowModelMenu(false);
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim()) {
      setInputValue("");
    }
  };

  const menuItems = useMemo(() => [
    { id: 'new-tasks', label: 'New tasks' },
    { id: 'my-list', label: 'My List' },
    { id: 'queue', label: 'Queue' },
    { id: 'completed', label: 'Completed' },
  ], []);

  const getRecurrenceLabel = (value: string) => {
    if (value === 'none') return 'None';
    if (value.startsWith('custom:')) {
      return `Custom (${value.split(':')[1]})`;
    }
    switch (value) {
      case 'hourly': return 'Hourly';
      case 'daily': return 'Daily';
      case 'weekdays': return 'Weekdays';
      case 'weekly': return 'Weekly';
      case 'custom': return 'Custom';
      default: return 'Daily';
    }
  };

  const getPriorityLabel = (value: string) => {
    switch (value) {
      case 'low': return 'Low';
      case 'medium': return 'Medium';
      case 'high': return 'High';
      default: return 'Medium';
    }
  };

  // Generate 15-minute interval time options dynamically for the full day
  const timeOptions = useMemo(() => {
    const options = [];
    for (let hour = 0; hour < 24; hour++) {
      for (let min of [0, 15, 30, 45]) {
        const period = hour >= 12 ? 'PM' : 'AM';
        const displayHour = hour % 12 === 0 ? 12 : hour % 12;
        const displayMin = min.toString().padStart(2, '0');
        const val = `${hour.toString().padStart(2, '0')}:${displayMin}`;
        const label = `${displayHour}:${displayMin} ${period}`;
        options.push({ value: val, label });
      }
    }
    return options;
  }, []);

  // Format the current selected triggerTime to AM/PM display string
  const timeDisplayLabel = useMemo(() => {
    const [hStr, mStr] = triggerTime.split(':');
    const h = parseInt(hStr, 10);
    const period = h >= 12 ? 'PM' : 'AM';
    const displayHour = h % 12 === 0 ? 12 : h % 12;
    return `${displayHour}:${mStr} ${period}`;
  }, [triggerTime]);

  // Form validation condition: True if title and instructions are entered
  const isFormValid = useMemo(() => {
    return taskTitle.trim() !== "" && taskDescription.trim() !== "";
  }, [taskTitle, taskDescription]);

  // Real attachment operations using Electron desktop APIs
  const handlePinFiles = async () => {
    setShowSourceMenu(false);
    const w = window as any;
    if (w.electronAPI?.selectFiles) {
      const filePaths = await w.electronAPI.selectFiles();
      if (filePaths && filePaths.length > 0) {
        const newItems = filePaths
          .filter((fp: string) => !attachedPins.find(p => p.path === fp))
          .map((fp: string) => ({
            id: Math.random().toString(36).substr(2, 9),
            type: 'file',
            path: fp,
            name: fp.split(/[/\\]/).pop() || 'File'
          }));
        if (newItems.length > 0) {
          setAttachedPins(prev => [...prev, ...newItems]);
        }
      }
    } else {
      alert("File pinning requires the EterX desktop app.");
    }
  };

  const handlePinFolder = async () => {
    setShowSourceMenu(false);
    const w = window as any;
    if (w.electronAPI?.selectFolder) {
      const folderPath = await w.electronAPI.selectFolder();
      if (folderPath && !attachedPins.find(p => p.path === folderPath)) {
        setAttachedPins(prev => [
          ...prev,
          {
            id: Math.random().toString(36).substr(2, 9),
            type: 'folder',
            path: folderPath,
            name: folderPath.split(/[/\\]/).pop() || 'Folder'
          }
        ]);
      }
    } else {
      alert("Folder pinning requires the EterX desktop app.");
    }
  };

  // Custom Repeat input format check: e.g. "3 days", "2 hours", "15 mins", or a 5-space Cron rule
  const isCustomRepeatValid = useMemo(() => {
    const val = customRepeatVal.trim().toLowerCase();
    if (!val) return false;
    
    // Check interval pattern
    const intervalRegex = /^\d+\s*(min|mins|minute|minutes|hour|hours|day|days|week|weeks)$/i;
    if (intervalRegex.test(val)) return true;
    
    // Check cron structure (5 fields)
    const cronParts = val.split(/\s+/);
    if (cronParts.length === 5) {
      return cronParts.every(part => /^[0-9\*\/\,\-]+$/.test(part));
    }
    
    return false;
  }, [customRepeatVal]);

  return (
    <div className="eterx-agents-view flex-1 w-full h-full flex flex-col px-5 py-5 md:px-8 md:pt-6 md:pb-6 overflow-hidden relative z-20 bg-transparent select-none">
      {/* Main Content split layout stretching to very top */}
      <div className="flex flex-col md:flex-row gap-6 flex-1 min-h-0 w-full">
        
        {/* Left Side: suggestions & chat input (84% width) */}
        <div className="flex flex-col gap-3 flex-1 min-h-0 w-full md:max-w-[84%]">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="eterx-agents-library-panel flex-1 bg-[#0A0A0A]/70 backdrop-blur-sm border border-white/[0.04] rounded-[18px] p-6 w-full shadow-[inset_0_1px_1px_rgba(255,255,255,0.02)] flex flex-col items-center justify-between relative overflow-hidden"
          >
            {scheduleMode === 'agent' ? (
              <>
                {/* Centered Graphic and Description Text */}
                <div className="flex-1 flex flex-col items-center justify-center text-center w-full">
                  <motion.div
                    initial={{ scale: 0.96, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ delay: 0.1, duration: 0.3 }}
                    className="mb-5 shrink-0"
                  >
                    <img src="/logo.png" alt="App Logo" className="w-12 h-12 object-contain opacity-90 select-none pointer-events-none" />
                  </motion.div>
                  
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.2, duration: 0.3 }}
                    className="text-[20px] md:text-[22px] font-medium text-white/92 tracking-tight leading-snug max-w-[460px] select-text"
                  >
                    Just tell when and what tasks you need to kick off!
                  </motion.p>
                </div>

                {/* Bottom Custom Scheduled Input Bar (aligned to big container, form centered) */}
                <div className="w-[calc(100%+48px)] mx-[-24px] mt-auto pt-4 px-6 border-t border-white/[0.03]">
                  <div className="max-w-[680px] mx-auto w-full pb-1">
                    <form onSubmit={handleSubmit} className="w-full rounded-[18px] bg-[#242424] border border-white/[0.08] p-3 flex flex-col gap-2 shadow-[0_8px_30px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.03)] transition-all overflow-visible">
                      <div className="relative w-full">
                        <textarea
                          rows={1}
                          value={inputValue}
                          onChange={(e) => setInputValue(e.target.value)}
                          placeholder="Do anything"
                          className="w-full appearance-none border-0 bg-transparent shadow-none outline-none ring-0 text-[13.5px] font-normal text-[#F0F0F0] placeholder:text-[#8B8984] focus:border-0 focus:outline-none focus:ring-0 placeholder:font-normal min-h-[26px] max-h-[160px] resize-none leading-[1.45] py-0.5 overflow-hidden"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              if (inputValue.trim()) {
                                setInputValue("");
                              }
                            }
                          }}
                        />
                      </div>

                      {/* Bottom Row containing controls styled like screenshot */}
                      <div className="flex items-center justify-between w-full mt-1 overflow-visible relative">
                        {/* Left side actions: Plus only */}
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/5 text-white/50 hover:text-white/80 transition-all cursor-pointer"
                          >
                            <Plus className="w-[18px] h-[18px]" strokeWidth={2.2} />
                          </button>
                        </div>

                        {/* Right side actions: Model selector, Mic, Send */}
                        <div className="flex items-center gap-1 overflow-visible">
                          {/* Model Selector container */}
                          <div ref={modelSelectorRef} className="relative min-w-0 overflow-visible">
                            <button
                              type="button"
                              onClick={() => setShowModelMenu(prev => !prev)}
                              className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[#F4F4F4] bg-[#2D2D2D] hover:bg-[#333333] px-3 py-1 rounded-full cursor-pointer select-none transition-colors mr-2.5 group relative"
                            >
                              <span className="truncate max-w-[120px]">{modelDisplayLabel}</span>
                              <ChevronDown className={`w-3.5 h-3.5 text-white/40 group-hover:text-white/60 transition-transform duration-200 ${showModelMenu ? 'rotate-180' : ''}`} strokeWidth={1.8} />
                            </button>

                            <AnimatePresence>
                              {showModelMenu && (
                                <motion.div
                                  initial={{ opacity: 0, y: 8, scale: 0.98 }}
                                  animate={{ opacity: 1, y: 0, scale: 1 }}
                                  exit={{ opacity: 0, y: 8, scale: 0.98 }}
                                  transition={{ duration: 0.15, ease: "easeOut" }}
                                  className="eterx-composer-popout absolute bottom-[calc(100%+12px)] right-0 z-[130] flex w-[230px] flex-col rounded-xl border border-white/[0.08] bg-[#1E1E1E]/95 backdrop-blur-xl p-1.5 text-[#F4F1EA] shadow-[0_12px_36px_rgba(0,0,0,0.5)]"
                                  role="dialog"
                                  aria-label="Model settings"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <div className={allModelOptions.length > 4 ? 'max-h-[168px] overflow-y-auto pr-1 eterx-scrollbar' : ''}>
                                    {allModelOptions.map((option) => {
                                      const selected = option.optionKey === selectedModel.optionKey;
                                      const optionLabel = getModelOptionLabel(option);
                                      return (
                                        <button
                                          type="button"
                                          key={option.optionKey}
                                          onClick={() => selectChatModelOption(option)}
                                          className={`group flex min-h-[44px] w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors duration-150 ${ selected ? 'bg-white/[0.08] text-white font-medium shadow-sm' : 'text-[#E8E6E3] hover:bg-white/[0.05] active:bg-white/[0.12] font-normal' }`}
                                        >
                                          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-white/95">
                                            {selected && <Check className="h-3.5 w-3.5" strokeWidth={2.05} />}
                                          </span>
                                          <span className="flex min-w-0 flex-1 flex-col font-sans">
                                            <span className="truncate text-[12px] leading-4 tracking-normal font-medium">
                                              {optionLabel}
                                            </span>
                                            <span className="truncate text-[10.5px] leading-3 text-[#A3A19E]">
                                              {option.isAuto ? 'Use priority list' : MODEL_PROVIDER_LABEL[option.provider]}
                                            </span>
                                          </span>
                                        </button>
                                      );
                                    })}
                                  </div>

                                  <div className="mx-2 my-1.5 h-px bg-white/[0.09]" />

                                  <div className="px-0.5 pb-0.5 relative">
                                    <div
                                      className="relative"
                                      onMouseEnter={() => setShowThinkingLevels(true)}
                                      onMouseLeave={() => setShowThinkingLevels(false)}
                                    >
                                      <button
                                        type="button"
                                        onClick={() => setShowThinkingLevels(prev => !prev)}
                                        className={`flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-white transition-colors duration-150 hover:bg-[#242424] ${ showThinkingLevels ? 'bg-[#242424]' : '' }`}
                                      >
                                        <span className="flex min-w-0 flex-1 flex-col font-sans font-semibold">
                                          <span className="truncate text-[12.5px] leading-5 tracking-normal">
                                            Thinking level
                                          </span>
                                          <span className="truncate text-[11px] font-medium leading-4 text-white/50">
                                            {selectedThinkingLevel.label}
                                          </span>
                                        </span>
                                        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-white/50 transition-transform duration-150 ${ showThinkingLevels ? 'rotate-90' : '' }`} strokeWidth={2.2} />
                                      </button>

                                      <AnimatePresence>
                                        {showThinkingLevels && (
                                          <motion.div
                                            initial={{ opacity: 0, x: -10, scale: 0.98 }}
                                            animate={{ opacity: 1, x: 0, scale: 1 }}
                                            exit={{ opacity: 0, x: -10, scale: 0.98 }}
                                            transition={{ duration: 0.15 }}
                                            className="absolute bottom-0 right-[calc(100%+8px)] z-[140] w-[180px] overflow-hidden rounded-xl border border-white/[0.08] bg-[#111111] p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.62)]"
                                            onClick={(e) => e.stopPropagation()}
                                          >
                                            {MAIN_AGENT_THINKING_LEVEL_OPTIONS.map((level) => {
                                              const isLevelSelected = level.id === thinkingLevel;
                                              return (
                                                <button
                                                  type="button"
                                                  key={level.id}
                                                  onClick={() => selectThinkingLevel(level.id)}
                                                  className={`flex min-h-[38px] w-full items-center gap-2 rounded-md px-2 py-1 text-left text-white transition-all hover:bg-white/[0.05] ${ isLevelSelected ? 'bg-white/[0.08] font-medium' : 'font-normal' }`}
                                                >
                                                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                                                    {isLevelSelected && <Check className="h-3 w-3 text-white" strokeWidth={2.2} />}
                                                  </span>
                                                  <span className="text-[12px] font-sans">{level.label}</span>
                                                </button>
                                              );
                                            })}
                                          </motion.div>
                                        )}
                                      </AnimatePresence>
                                    </div>
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                          
                          <button
                            type="button"
                            className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/5 text-white/40 hover:text-white/70 transition-all cursor-pointer mr-1"
                          >
                            <Mic className="w-4 h-4" strokeWidth={1.8} />
                          </button>

                          <button
                            type="submit"
                            disabled={!inputValue.trim()}
                            className="w-[32px] h-[32px] rounded-full bg-white/20 disabled:bg-white/5 disabled:text-white/20 hover:bg-white/30 text-white flex items-center justify-center transition-all active:scale-[0.96] cursor-pointer"
                          >
                            <ArrowUp className="w-[16px] h-[16px]" strokeWidth={2.2} />
                          </button>
                        </div>
                      </div>
                    </form>
                  </div>
                </div>
              </>
            ) : (
              /* Manual Mode layout: Structured scheduler form without vertical scrollbars */
              <div className="flex-1 w-full flex flex-col justify-between text-left max-w-[520px] mx-auto py-1 select-text">
                
                {/* Form Fields Container */}
                <form className="w-full flex flex-col flex-1 justify-between gap-4">
                  <div className="flex flex-col gap-4 w-full">
                    
                    {/* Task Title (Borderless transparent) */}
                    <div className="w-full">
                      <input
                        type="text"
                        value={taskTitle}
                        onChange={(e) => setTaskTitle(e.target.value)}
                        placeholder="Scheduled task title"
                        className="w-full bg-transparent border-0 outline-none focus:outline-none focus:ring-0 text-[18px] font-bold text-white placeholder:text-white/25 py-2 leading-tight"
                      />
                    </div>

                    {/* Task Instructions Area (Describe what should do) */}
                    <div className="w-full">
                      <textarea
                        rows={2}
                        value={taskDescription}
                        onChange={(e) => setTaskDescription(e.target.value)}
                        placeholder="Describe what the agent should do"
                        className="w-full bg-[#181818]/60 border border-white/[0.04] rounded-xl px-3.5 py-2.5 text-[13px] text-white placeholder:text-white/25 focus:outline-none focus:border-white/10 transition-colors resize-none leading-relaxed shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)]"
                      />
                    </div>

                    {/* Details Container Card */}
                    <div className="flex flex-col gap-1 w-full">
                      <span className="text-[12px] font-semibold text-white/35 pl-1 mb-1 select-none">Details</span>
                      <div ref={detailsRef} className="w-full bg-white/[0.015] border border-white/[0.03] rounded-[16px] p-0.5 flex flex-col relative select-none">
                        
                        {/* Details - Model Row */}
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => setActivePopover(prev => prev === 'model' ? null : 'model')}
                            className="w-full flex items-center justify-between px-3.5 py-2 hover:bg-white/[0.02] transition-colors rounded-t-xl cursor-pointer"
                          >
                            <span className="text-[12.5px] text-white/50 font-medium">Model</span>
                            <div className="flex items-center gap-1">
                              <span className="text-[12.5px] text-white/90 font-medium">
                                {allModelOptions.find(o => o.optionKey === formModel)?.label || 'Auto'}
                              </span>
                              <ChevronDown className="w-3.5 h-3.5 text-white/40" />
                            </div>
                          </button>

                          <AnimatePresence>
                            {activePopover === 'model' && (
                              <motion.div
                                initial={{ opacity: 0, y: 4, scale: 0.99 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: 4, scale: 0.99 }}
                                transition={{ duration: 0.12 }}
                                className="absolute right-3.5 bottom-[calc(100%+4px)] z-[130] flex w-[200px] flex-col rounded-xl border border-white/[0.08] bg-[#161616]/95 backdrop-blur-xl p-1 shadow-[0_12px_36px_rgba(0,0,0,0.5)] max-h-[160px] overflow-y-auto eterx-scrollbar"
                              >
                                {allModelOptions.map((option) => (
                                  <button
                                    type="button"
                                    key={option.optionKey}
                                    onClick={() => {
                                      setFormModel(option.optionKey);
                                      setActivePopover(null);
                                    }}
                                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[12px] text-left transition-colors cursor-pointer ${
                                      option.optionKey === formModel 
                                        ? 'bg-white/[0.08] text-white font-medium shadow-sm' 
                                        : 'text-white/70 hover:bg-white/[0.04] hover:text-white'
                                    }`}
                                  >
                                    <span className="truncate">{option.label}</span>
                                    {option.optionKey === formModel && <Check className="w-3.5 h-3.5 text-white" strokeWidth={2.2} />}
                                  </button>
                                ))}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>

                        {/* Separator Line */}
                        <div className="h-px bg-white/[0.03] mx-3.5" />

                        {/* Details - Priority Row */}
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => setActivePopover(prev => prev === 'priority' ? null : 'priority')}
                            className="w-full flex items-center justify-between px-3.5 py-2 hover:bg-white/[0.02] transition-colors rounded-b-xl cursor-pointer"
                          >
                            <span className="text-[12.5px] text-white/50 font-medium">Priority</span>
                            <div className="flex items-center gap-1">
                              <span className="text-[12.5px] text-white/90 font-medium">{getPriorityLabel(priority)}</span>
                              <ChevronDown className="w-3.5 h-3.5 text-white/40" />
                            </div>
                          </button>

                          <AnimatePresence>
                            {activePopover === 'priority' && (
                              <motion.div
                                initial={{ opacity: 0, y: 4, scale: 0.99 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: 4, scale: 0.99 }}
                                transition={{ duration: 0.12 }}
                                className="absolute right-3.5 bottom-[calc(100%+4px)] z-[130] flex w-[160px] flex-col rounded-xl border border-white/[0.08] bg-[#161616]/95 backdrop-blur-xl p-1 shadow-[0_12px_36px_rgba(0,0,0,0.5)]"
                              >
                                {['low', 'medium', 'high'].map((lvl) => (
                                  <button
                                    type="button"
                                    key={lvl}
                                    onClick={() => {
                                      setPriority(lvl);
                                      setActivePopover(null);
                                    }}
                                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[12px] text-left transition-colors cursor-pointer ${
                                      priority === lvl 
                                        ? 'bg-white/[0.08] text-white font-medium shadow-sm' 
                                        : 'text-white/70 hover:bg-white/[0.04] hover:text-white'
                                    }`}
                                  >
                                    <span>{getPriorityLabel(lvl)}</span>
                                    {priority === lvl && <Check className="w-3.5 h-3.5 text-white" strokeWidth={2.2} />}
                                  </button>
                                ))}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>

                      </div>
                    </div>

                    {/* Frequency Container Card */}
                    <div className="flex flex-col gap-1 w-full">
                      <span className="text-[12px] font-semibold text-white/35 pl-1 mb-1 select-none">Frequency</span>
                      <div ref={frequencyRef} className="w-full bg-white/[0.015] border border-white/[0.03] rounded-[16px] p-0.5 flex flex-col relative select-none">
                        
                        {/* Frequency - Repeat Row */}
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => setActivePopover(prev => prev === 'repeat' ? null : 'repeat')}
                            className="w-full flex items-center justify-between px-3.5 py-2 hover:bg-white/[0.02] transition-colors rounded-t-xl cursor-pointer"
                          >
                            <span className="text-[12.5px] text-white/50 font-medium">Repeat</span>
                            <div className="flex items-center gap-1">
                              <span className="text-[12.5px] text-white/90 font-medium">{getRecurrenceLabel(recurrence)}</span>
                              <ChevronDown className="w-3.5 h-3.5 text-white/40" />
                            </div>
                          </button>

                          <AnimatePresence>
                            {activePopover === 'repeat' && (
                              <motion.div
                                initial={{ opacity: 0, y: 4, scale: 0.99 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: 4, scale: 0.99 }}
                                transition={{ duration: 0.12 }}
                                className="absolute right-3.5 bottom-[calc(100%+4px)] z-[130] flex w-[184px] flex-col rounded-xl border border-white/[0.08] bg-[#161616]/95 backdrop-blur-xl p-1 shadow-[0_12px_36px_rgba(0,0,0,0.5)] overflow-hidden"
                              >
                                {showCustomRepeatForm ? (
                                  /* Custom Recurrence validation input panel */
                                  <div className="p-2.5 flex flex-col gap-2.5 text-left select-none bg-white/[0.01]">
                                    <div className="flex items-center gap-1.5 shrink-0 select-none">
                                      <button
                                        type="button"
                                        onClick={() => setShowCustomRepeatForm(false)}
                                        className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-white/5 text-white/50 hover:text-white transition-colors cursor-pointer"
                                      >
                                        <ChevronLeft className="w-3.5 h-3.5" />
                                      </button>
                                      <span className="text-[10px] font-bold text-white/35 tracking-wider uppercase">Custom Repeat</span>
                                    </div>
                                    
                                    <div className="flex flex-col gap-1 mt-1">
                                      <div className="flex items-center gap-1">
                                        <input
                                          type="text"
                                          placeholder="e.g., 3 days, 2 hours, 15 mins"
                                          value={customRepeatVal}
                                          onChange={(e) => setCustomRepeatVal(e.target.value)}
                                          className={`flex-1 min-w-0 bg-[#0A0A0A]/60 border rounded-lg px-2.5 py-1 text-[11px] text-white focus:outline-none transition-colors text-center ${
                                            customRepeatVal.trim() === ""
                                              ? "border-white/[0.08] focus:border-white/20"
                                              : isCustomRepeatValid
                                                ? "border-emerald-500/30 focus:border-emerald-500/50"
                                                : "border-rose-500/30 focus:border-rose-500/50"
                                          }`}
                                        />
                                        <button
                                          type="button"
                                          disabled={!isCustomRepeatValid}
                                          onClick={() => {
                                            if (isCustomRepeatValid) {
                                              handleSetRecurrence(`custom:${customRepeatVal.trim()}`);
                                              setActivePopover(null);
                                            }
                                          }}
                                          className={`px-3 py-1 font-semibold text-[11px] rounded-lg transition-all text-center ${
                                            isCustomRepeatValid
                                              ? 'bg-white text-black hover:bg-white/90 active:scale-[0.98] cursor-pointer'
                                              : 'bg-white/5 text-white/20 cursor-not-allowed'
                                          }`}
                                        >
                                          Apply
                                        </button>
                                      </div>
                                      
                                      {/* Real-time silent inline indicator text if wrong */}
                                      {customRepeatVal.trim() !== "" && !isCustomRepeatValid && (
                                        <span className="text-[9px] text-rose-400 font-medium pl-1 mt-0.5">Invalid format</span>
                                      )}
                                    </div>
                                  </div>
                                ) : (
                                  /* Preset options list */
                                  <div className="flex flex-col p-1 text-left">
                                    {['none', 'hourly', 'daily', 'weekdays', 'weekly'].map((opt) => {
                                      const isSelected = recurrence === opt;
                                      return (
                                        <button
                                          type="button"
                                          key={opt}
                                          onClick={() => {
                                            handleSetRecurrence(opt);
                                            setActivePopover(null);
                                          }}
                                          className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[12px] text-left transition-colors cursor-pointer ${
                                            isSelected 
                                              ? 'bg-white/[0.08] text-white font-medium shadow-sm' 
                                              : 'text-[#E8E6E3] hover:bg-white/[0.04] hover:text-white'
                                          }`}
                                        >
                                          <span>{getRecurrenceLabel(opt)}</span>
                                          {isSelected && <Check className="w-3.5 h-3.5 text-white" strokeWidth={2.2} />}
                                        </button>
                                      );
                                    })}
                                    
                                    <button
                                      type="button"
                                      onClick={() => setShowCustomRepeatForm(true)}
                                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[12px] text-left transition-colors cursor-pointer text-[#E8E6E3] hover:bg-white/[0.04] hover:text-white`}
                                    >
                                      <span>Custom...</span>
                                      <ChevronRight className="w-3.5 h-3.5 text-white/40" />
                                    </button>
                                  </div>
                                )}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>

                        {/* Separator Line */}
                        <div className="h-px bg-white/[0.03] mx-3.5" />

                        {/* Frequency - At Time Row */}
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => setActivePopover(prev => prev === 'time' ? null : 'time')}
                            className="w-full flex items-center justify-between px-3.5 py-2.5 hover:bg-white/[0.02] transition-colors cursor-pointer"
                          >
                            <span className="text-[12.5px] text-white/50 font-medium">At</span>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[12.5px] font-semibold text-white/90">{timeDisplayLabel}</span>
                              <ChevronDown className="w-3.5 h-3.5 text-white/40" />
                            </div>
                          </button>

                          <AnimatePresence>
                            {activePopover === 'time' && (
                              <motion.div
                                initial={{ opacity: 0, y: 4, scale: 0.99 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: 4, scale: 0.99 }}
                                transition={{ duration: 0.12 }}
                                className="absolute right-3.5 bottom-[calc(100%+4px)] z-[130] flex w-[188px] max-h-[290px] flex-col rounded-xl border border-white/[0.08] bg-[#161616]/95 backdrop-blur-xl p-1 shadow-[0_12px_36px_rgba(0,0,0,0.5)] overflow-hidden select-none text-left"
                              >
                                {/* Precise typing custom time entry widget at the top */}
                                <div className="p-2 border-b border-white/[0.06] flex flex-col gap-2 bg-white/[0.015] shrink-0">
                                  <span className="text-[10px] font-semibold text-white/35 tracking-tight pl-0.5">Custom time</span>
                                  <div className="flex items-center gap-1">
                                    <input
                                      type="text"
                                      placeholder="09:00"
                                      value={customTimeVal}
                                      onChange={(e) => setCustomTimeVal(e.target.value)}
                                      className="flex-1 min-w-0 bg-[#0A0A0A]/60 border border-white/[0.08] rounded-lg px-2 py-1 text-[12px] text-white focus:outline-none focus:border-white/20 text-center"
                                    />
                                    <div className="flex bg-white/[0.03] p-0.5 rounded-lg border border-white/[0.04] shrink-0 select-none">
                                      {['AM', 'PM'].map((p) => {
                                        const active = customTimePeriod === p;
                                        return (
                                          <button
                                            type="button"
                                            key={p}
                                            onClick={() => setCustomTimePeriod(p as 'AM' | 'PM')}
                                            className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
                                              active ? 'bg-white text-black font-extrabold shadow-sm' : 'text-white/60 hover:text-white'
                                            }`}
                                          >
                                            {p}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      let [hStr, mStr] = customTimeVal.split(':');
                                      let h = parseInt(hStr || '9', 10);
                                      let m = parseInt(mStr || '00', 10);
                                      if (isNaN(h)) h = 9;
                                      if (isNaN(m)) m = 0;
                                      if (customTimePeriod === 'PM' && h < 12) h += 12;
                                      if (customTimePeriod === 'AM' && h === 12) h = 0;
                                      const hFormatted = h.toString().padStart(2, '0');
                                      const mFormatted = m.toString().padStart(2, '0');
                                      setTriggerTime(`${hFormatted}:${mFormatted}`);
                                      setActivePopover(null);
                                    }}
                                    className="w-full py-1.5 bg-white text-black font-semibold text-[11px] rounded-lg hover:bg-white/90 active:scale-[0.98] transition-all cursor-pointer text-center"
                                  >
                                    Apply
                                  </button>
                                </div>

                                {/* Scrollable pre-set list underneath */}
                                <div className="flex-1 overflow-y-auto pr-0.5 eterx-scrollbar max-h-[130px] mt-1">
                                  {timeOptions.map((opt) => {
                                    const isSelected = opt.value === triggerTime;
                                    return (
                                      <button
                                        type="button"
                                        key={opt.value}
                                        ref={isSelected ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                                        onClick={() => {
                                          setTriggerTime(opt.value);
                                          setActivePopover(null);
                                        }}
                                        className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[12px] text-left transition-colors cursor-pointer ${
                                          isSelected 
                                            ? 'bg-white/[0.08] text-white font-medium shadow-sm' 
                                            : 'text-[#E8E6E3] hover:bg-white/[0.04] hover:text-white'
                                        }`}
                                      >
                                        <span>{opt.label}</span>
                                        {isSelected && <Check className="w-3.5 h-3.5 text-white" strokeWidth={2.2} />}
                                      </button>
                                    );
                                  })}
                                </div>

                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>

                        {/* Separator Line */}
                        <div className="h-px bg-white/[0.03] mx-3.5" />

                        {/* Frequency - Sources Row (Pins attachment match chat composer) */}
                        <div className="w-full flex items-center justify-between px-3.5 py-2 rounded-b-xl relative">
                          <span className="text-[12.5px] text-white/50 font-medium">Sources</span>
                          <div className="flex items-center gap-1.5 overflow-x-auto py-0.5 select-none scrollbar-none max-w-[240px]">
                            {attachedPins.map((pin) => (
                              <div
                                key={pin.id}
                                className="flex items-center gap-1 bg-white/[0.04] border border-white/[0.08] hover:border-white/12 rounded-lg px-2 py-0.5 text-[11px] text-white/80 shrink-0 transition-all"
                                title={pin.path}
                              >
                                <span className="truncate max-w-[80px]">{pin.name}</span>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setAttachedPins(prev => prev.filter(p => p.id !== pin.id));
                                  }}
                                  className="text-white/40 hover:text-white/80 transition-colors p-0.5 rounded-full cursor-pointer"
                                >
                                  <Plus className="w-2.5 h-2.5 rotate-45" strokeWidth={2.5} />
                                </button>
                              </div>
                            ))}
                            {/* Dash Border circular Plus button */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowSourceMenu(prev => !prev);
                              }}
                              className="w-5 h-5 flex items-center justify-center rounded-full border border-dashed border-white/20 hover:border-white/40 text-white/40 hover:text-white/70 transition-all cursor-pointer shrink-0"
                            >
                              <Plus className="w-3 h-3" strokeWidth={2.5} />
                            </button>
                          </div>

                          {/* Source Menu Popup (Upward) */}
                          <AnimatePresence>
                            {showSourceMenu && (
                              <div ref={sourceMenuRef} className="absolute right-3.5 bottom-[calc(100%+4px)] z-[130]">
                                <motion.div
                                  initial={{ opacity: 0, y: 4, scale: 0.99 }}
                                  animate={{ opacity: 1, y: 0, scale: 1 }}
                                  exit={{ opacity: 0, y: 4, scale: 0.99 }}
                                  transition={{ duration: 0.1 }}
                                  className="flex w-[120px] flex-col rounded-xl border border-white/[0.08] bg-[#161616]/95 backdrop-blur-xl p-1 shadow-[0_12px_36px_rgba(0,0,0,0.5)] select-none text-left"
                                >
                                  <button
                                    type="button"
                                    onClick={handlePinFiles}
                                    className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-[12px] text-white/80 hover:bg-white/[0.04] hover:text-white cursor-pointer"
                                  >
                                    Add File
                                  </button>
                                  <button
                                    type="button"
                                    onClick={handlePinFolder}
                                    className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-[12px] text-white/80 hover:bg-white/[0.04] hover:text-white cursor-pointer"
                                  >
                                    Add Folder
                                  </button>
                                </motion.div>
                              </div>
                            )}
                          </AnimatePresence>
                        </div>

                      </div>
                    </div>

                  </div>

                  {/* Fixed Create Schedule Button Section at bottom */}
                  <div className="mt-1 pt-2.5 border-t border-white/[0.03] w-full flex items-center justify-end select-none shrink-0">
                    <button
                      type="submit"
                      disabled={!isFormValid}
                      onClick={(e) => {
                        e.preventDefault();
                      }}
                      className={`px-6 py-2.5 rounded-xl font-semibold text-[12.5px] transition-all duration-200 select-none ${
                        isFormValid
                          ? 'bg-white text-black hover:bg-white/90 active:scale-[0.98] cursor-pointer shadow-[0_4px_16px_rgba(255,255,255,0.15)]'
                          : 'bg-white/5 text-white/30 border border-white/[0.04] cursor-not-allowed shadow-none'
                      }`}
                    >
                      Schedule Task
                    </button>
                  </div>
                </form>
              </div>
            )}
          </motion.div>
        </div>

        {/* Right Side: vertical liquid glass menu panel (16% width) - Vertically Centered next to left panel */}
        <div className="hidden md:flex flex-col w-[16%] shrink-0 min-w-[150px] h-full justify-center">
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.35 }}
            className="bg-[#050505]/40 backdrop-blur-xl border border-white/[0.02] rounded-[22px] p-4 flex flex-col gap-6 shadow-[inset_0_1px_1px_rgba(255,255,255,0.01),0_8px_32px_rgba(0,0,0,0.2)] w-full"
          >
            {/* Section 1: Schedule */}
            <div className="flex flex-col gap-2 w-full">
              <span className="text-[11.5px] font-medium text-white/50 tracking-tight pl-1 select-none text-center">Schedule</span>
              <div className="flex flex-col gap-1 w-full bg-white/[0.02] border border-white/[0.03] rounded-[14px] p-1 shadow-[inset_0_1px_1px_rgba(255,255,255,0.01)] select-none">
                {['manual', 'agent'].map((mode) => {
                  const isActive = scheduleMode === mode;
                  const label = mode === 'manual' ? 'Manually' : 'By Agent';
                  return (
                    <button
                      type="button"
                      key={mode}
                      onClick={() => setScheduleMode(mode)}
                      className={`group flex min-h-[36px] w-full items-center justify-center px-3 py-1.5 rounded-lg text-[12px] text-center transition-all duration-150 cursor-pointer border border-transparent relative select-none ${
                        isActive
                          ? 'text-white font-semibold'
                          : 'text-[#E8E6E3] hover:bg-white/[0.03] hover:text-white font-normal'
                      }`}
                    >
                      {isActive && (
                        <motion.div
                          layoutId="activeScheduleModePill"
                          className="absolute inset-0 bg-white/[0.08] border border-white/[0.03] rounded-lg shadow-sm z-0"
                          transition={{ type: "spring", stiffness: 380, damping: 30 }}
                        />
                      )}
                      <span className="relative z-10 truncate text-center">{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Section 2: Tasks */}
            <div className="flex flex-col gap-2 w-full">
              <span className="text-[11.5px] font-medium text-white/50 tracking-tight pl-1 select-none text-center">Tasks</span>
              <div className="flex flex-col gap-1 w-full bg-white/[0.02] border border-white/[0.03] rounded-[14px] p-1 shadow-[inset_0_1px_1px_rgba(255,255,255,0.01)] select-none">
                {menuItems.map((item) => {
                  const isActive = selectedSection === item.id;
                  return (
                    <button
                      type="button"
                      key={item.id}
                      onClick={() => setSelectedSection(item.id)}
                      className={`group flex min-h-[38px] w-full items-center justify-center px-3 py-1.5 rounded-lg text-[12px] text-center transition-all duration-150 cursor-pointer border border-transparent relative select-none ${
                        isActive
                          ? 'text-white font-semibold'
                          : 'text-[#E8E6E3] hover:bg-white/[0.03] hover:text-white font-normal'
                      }`}
                    >
                      {isActive && (
                        <motion.div
                          layoutId="activeNavigationPill"
                          className="absolute inset-0 bg-white/[0.08] border border-white/[0.03] rounded-lg shadow-sm z-0"
                          transition={{ type: "spring", stiffness: 380, damping: 30 }}
                        />
                      )}
                      <span className="relative z-10 truncate text-center">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </motion.div>
        </div>
        
      </div>
    </div>
  );
};
