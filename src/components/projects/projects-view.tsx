"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Plus, Mic, ArrowUp, Check, ChevronRight, ChevronLeft, Calendar, Clock, Bot, Play, Trash2, ExternalLink, AlertCircle, CheckCircle2, Loader2, Search, Pencil, Pause, RotateCcw } from 'lucide-react';
import { PremiumSend } from '../ui/premium-icons';
import { Shimmer } from '../ui/shimmer';
import { normalizeScheduledTask, SCHEDULED_TASKS_STORAGE_KEY, SCHEDULED_TASKS_UPDATED_EVENT, type ScheduledTaskRecord } from '../../lib/scheduled-tasks';
import { persistScheduledTasks } from '../../lib/scheduled-task-sync';

export type ScheduledTaskItem = ScheduledTaskRecord;
import {
  MAIN_AGENT_MODEL_OPTIONS,
  doesModelSupportThinking as modelSupportsThinking,
  getModelThinkingOptions,
  getMainAgentModelConfig,
  normalizeModelThinkingCapabilities,
  normalizeMainAgentThinkingLevel,
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
  MODEL_SELECTOR_STORAGE_KEY,
  MODEL_THINKING_CAPABILITIES_STORAGE_KEY,
  MODEL_PROVIDER_MODE,
  modelEntryKey,
  normalizeModelSelectorEntries,
  parseModelEntryKey,
  type ModelSelectorEntry,
} from '../../lib/agent/model-selector-store';
import { appStorage, appStorageReady, FOLDER_STORAGE_READY_EVENT } from '../../lib/client-storage';
import { EterxLogo } from '../chat/agent-icons';

const MODEL_API_KEY_STORAGE_KEY = API_KEY_PRESENCE_STORAGE_KEY;
const SETTINGS_CHANNEL = 'eterx-settings';

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
  isAuto?: boolean;
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
  const modelOverrides = readStringRecord(MODEL_OVERRIDE_STORAGE_KEY) as Partial<Record<MainAgentProvider, string>>;
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
  const overrideEntries = Object.entries(modelOverrides)
    .map(([provider, modelId]) => ({ provider: provider as MainAgentProvider, modelId: String(modelId || '').trim() }))
    .filter(entry => entry.modelId);
  const storedChatModelSelection = typeof window !== 'undefined'
    ? (appStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) || AUTO_MODEL_SELECTION)
    : AUTO_MODEL_SELECTION;
  const parsedStoredChatModel = parseModelEntryKey(storedChatModelSelection);
  let modelEntries = normalizeModelSelectorEntries([...normalizeModelSelectorEntries(savedEntries, modelCatalog), ...overrideEntries], modelCatalog);
  if (parsedStoredChatModel && !modelEntries.some(entry => modelEntryKey(entry.provider, entry.modelId) === storedChatModelSelection)) {
    modelEntries = normalizeModelSelectorEntries([...modelEntries, parsedStoredChatModel], modelCatalog);
  }
  const modelApiKeys = readStringRecord(MODEL_API_KEY_PRESENCE_STORAGE_KEY);
  const thinkingCapabilities = readThinkingCapabilityRecord();
  const chatModelSelection = storedChatModelSelection === AUTO_MODEL_SELECTION || parsedStoredChatModel
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

interface ProjectsViewProps {
  selectedSection: string;
  setSelectedSection: (section: string) => void;
  onOpenChat?: (chatId: string) => void;
}

export const ProjectsView: React.FC<ProjectsViewProps> = React.memo(({
  selectedSection,
  setSelectedSection,
  onOpenChat,
}) => {
  const [inputValue, setInputValue] = useState("");
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [showThinkingLevels, setShowThinkingLevels] = useState(false);
  const modelSelectorRef = useRef<HTMLDivElement>(null);

  const [scheduleMode, setScheduleMode] = useState('manual');

  // Manual scheduler reference states
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);

  // Recurrence state is loaded from the durable AppData-backed store.
  const [recurrence, setRecurrence] = useState(() => {
    if (typeof window !== 'undefined') {
      return appStorage.getItem('eterx_scheduler_default_repeat') || 'daily';
    }
    return 'daily';
  });

  const [priority, setPriority] = useState('medium');
  const [formModel, setFormModel] = useState(AUTO_MODEL_SELECTION);
  const [formThinkingLevel, setFormThinkingLevel] = useState<MainAgentThinkingLevel>(() => {
    if (typeof window === 'undefined') return 'medium';
    return normalizeMainAgentThinkingLevel(appStorage.getItem('eterx_chat_thinking_level') || 'medium');
  });
  const [triggerTime, setTriggerTime] = useState('09:00');

  // Agent selector state
  const [formAgent, setFormAgent] = useState<{ id: string | null; name: string }>({ id: null, name: 'General' });
  const [availableAgents, setAvailableAgents] = useState<Array<{ id: string | null; name: string }>>([
    { id: null, name: 'General' },
    { id: 'coding', name: 'Coding' },
  ]);

  // Date selector state
  const [dateOption, setDateOption] = useState<'today' | 'tomorrow' | 'custom'>('today');
  const [customDateVal, setCustomDateVal] = useState<string>(() => {
    const d = new Date();
    return d.toISOString().split('T')[0];
  });

  // Scheduled tasks storage state
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTaskItem[]>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = JSON.parse(appStorage.getItem(SCHEDULED_TASKS_STORAGE_KEY) || '[]');
        return Array.isArray(saved) ? saved.map(normalizeScheduledTask) : [];
      } catch {
        return [];
      }
    }
    return [];
  });

  // Custom manual inputs
  const [customTimeVal, setCustomTimeVal] = useState('9:00');
  const [customTimePeriod, setCustomTimePeriod] = useState<'AM' | 'PM'>('AM');
  const [customRepeatVal, setCustomRepeatVal] = useState('');
  const [showCustomRepeatForm, setShowCustomRepeatForm] = useState(false);

  // Sources (attached file/folder pins) real state
  const [attachedPins, setAttachedPins] = useState<{ id: string; name: string; type: string; path: string }[]>([]);

  const [activePopover, setActivePopover] = useState<string | null>(null);
  const [showSourceMenu, setShowSourceMenu] = useState(false);

  // Load custom agents
  useEffect(() => {
    const refreshAgents = () => {
      try {
      const custom = JSON.parse(appStorage.getItem('eterx_agents') || '[]');
        const formatted = custom
          .filter((a: any) => a.id !== 'default-1' && a.isSetup !== false)
          .map((a: any) => ({ id: a.id as string, name: a.name as string }));
        setAvailableAgents([
          { id: null, name: 'General' },
          { id: 'coding', name: 'Coding' },
          { id: 'autonomous', name: 'Autonomous' },
          ...formatted,
        ]);
      } catch { }
    };
    refreshAgents();
    window.addEventListener('eterx_agents_updated', refreshAgents);
    return () => window.removeEventListener('eterx_agents_updated', refreshAgents);
  }, []);

  // Listen for background task updates
  useEffect(() => {
    const handleSync = () => {
      try {
      const tasks = JSON.parse(appStorage.getItem(SCHEDULED_TASKS_STORAGE_KEY) || '[]');
        setScheduledTasks(Array.isArray(tasks) ? tasks.map(normalizeScheduledTask) : []);
      } catch { }
    };
    const syncDurableTasks = async () => {
      try {
      const pendingLocalWriteAt = Number(appStorage.getItem('eterx_scheduled_tasks_sync_pending') || 0);
        if (pendingLocalWriteAt && Date.now() - pendingLocalWriteAt < 15_000) return;
      if (pendingLocalWriteAt) appStorage.removeItem('eterx_scheduled_tasks_sync_pending');
        const response = await fetch('/api/scheduled-tasks', { cache: 'no-store' });
        if (!response.ok) return;
        const snapshot = await response.json();
        const durable = Array.isArray(snapshot?.tasks) ? snapshot.tasks.map(normalizeScheduledTask) : [];
      const local = JSON.parse(appStorage.getItem(SCHEDULED_TASKS_STORAGE_KEY) || '[]');
        if (durable.length === 0 && Number(snapshot?.savedAt || 0) <= 0 && Array.isArray(local) && local.length > 0) {
          void persistScheduledTasks(local.map(normalizeScheduledTask));
          return;
        }
      appStorage.setItem(SCHEDULED_TASKS_STORAGE_KEY, JSON.stringify(durable));
        setScheduledTasks(durable);
      } catch { }
    };
    window.addEventListener(SCHEDULED_TASKS_UPDATED_EVENT, handleSync);
    window.addEventListener('focus', syncDurableTasks);
    void syncDurableTasks();
    const interval = window.setInterval(syncDurableTasks, 4000);
    return () => {
      window.removeEventListener(SCHEDULED_TASKS_UPDATED_EVENT, handleSync);
      window.removeEventListener('focus', syncDurableTasks);
      window.clearInterval(interval);
    };
  }, []);

  const saveTasksState = useCallback((next: ScheduledTaskItem[]) => {
    setScheduledTasks(next);
    void persistScheduledTasks(next);
  }, []);

  const computeScheduledTimestamp = useCallback((
    timeStr: string,
    dateOpt: 'today' | 'tomorrow' | 'custom',
    customDateStr?: string
  ): number => {
    const now = new Date();
    let targetDate = new Date();

    if (dateOpt === 'tomorrow') {
      targetDate.setDate(now.getDate() + 1);
    } else if (dateOpt === 'custom' && customDateStr) {
      const [y, m, d] = customDateStr.split('-').map(Number);
      if (y && m && d) {
        targetDate = new Date(y, m - 1, d);
      }
    }

    const [hStr, mStr] = timeStr.split(':');
    const h = parseInt(hStr || '9', 10);
    const m = parseInt(mStr || '0', 10);

    targetDate.setHours(h, m, 0, 0);
    return targetDate.getTime();
  }, []);

  const getDateDisplayLabel = useCallback((opt: 'today' | 'tomorrow' | 'custom', customVal: string) => {
    if (opt === 'today') return 'Today';
    if (opt === 'tomorrow') return 'Tomorrow';
    if (customVal) {
      try {
        const [y, m, d] = customVal.split('-').map(Number);
        const dateObj = new Date(y, m - 1, d);
        return dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      } catch {
        return customVal;
      }
    }
    return 'Set date...';
  }, []);

  const formatScheduledTimeLabel = useCallback((t: ScheduledTaskItem) => {
    const scheduledDate = new Date(t.scheduledTimestamp);
    const dLabel = Number.isFinite(scheduledDate.getTime())
      ? scheduledDate.toLocaleDateString([], { month: 'short', day: 'numeric', year: scheduledDate.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined })
      : getDateDisplayLabel(t.dateOption, t.customDate || '');
    const [hStr, mStr] = (t.triggerTime || '09:00').split(':');
    let h = parseInt(hStr || '9', 10);
    const m = parseInt(mStr || '0', 10);
    const period = h >= 12 ? 'PM' : 'AM';
    const displayHour = h % 12 === 0 ? 12 : h % 12;
    const timeFormatted = `${displayHour}:${m.toString().padStart(2, '0')} ${period}`;
    return `${dLabel} at ${timeFormatted}`;
  }, [getDateDisplayLabel]);

  // Task lists filtered & sorted per specification
  const myListTasks = useMemo(() => {
    return scheduledTasks
      .filter(t => t.status === 'scheduled' || t.status === 'paused')
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [scheduledTasks]);

  const queueTasks = useMemo(() => {
    const priorityWeight: Record<string, number> = { high: 3, medium: 2, low: 1 };
    return scheduledTasks
      .filter(t => t.status === 'queued' || t.status === 'running')
      .sort((a, b) => {
        const weightDiff = (priorityWeight[b.priority] || 1) - (priorityWeight[a.priority] || 1);
        if (weightDiff !== 0) return weightDiff;
        return a.scheduledTimestamp - b.scheduledTimestamp;
      });
  }, [scheduledTasks]);

  const completedTasks = useMemo(() => {
    return scheduledTasks
      .filter(t => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')
      .sort((a, b) => (b.executedAt || b.createdAt) - (a.executedAt || a.createdAt));
  }, [scheduledTasks]);

  const renderRunHistory = useCallback((task: ScheduledTaskItem) => {
    const recentRuns = [...(task.history || [])].reverse().slice(0, 3);
    if (recentRuns.length === 0) return null;
    return (
      <div className="flex flex-col gap-1.5 pt-2 border-t border-white/[0.04]">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/35">
          Recent runs
        </span>
        {recentRuns.map(run => (
          <div key={run.id} className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.025] px-2.5 py-1.5">
            <div className="min-w-0 flex items-center gap-2">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                run.status === 'completed' ? 'bg-emerald-400' :
                run.status === 'failed' ? 'bg-rose-400' :
                'bg-amber-400'
              }`} />
              <span className="truncate text-[10.5px] text-white/55">
                {new Date(run.startedAt).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })} · {run.agentName} · {run.status}
              </span>
            </div>
            {run.chatId && onOpenChat && (
              <button
                type="button"
                onClick={() => onOpenChat(run.chatId)}
                className="shrink-0 text-[10.5px] font-medium text-white/55 hover:text-white transition-colors cursor-pointer"
              >
                Open chat
              </button>
            )}
          </div>
        ))}
      </div>
    );
  }, [onOpenChat]);

  const handleScheduleTaskSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!taskTitle.trim()) return;

    const scheduledTs = computeScheduledTimestamp(triggerTime, dateOption, customDateVal);

    const previous = editingTaskId ? scheduledTasks.find(task => task.id === editingTaskId) : undefined;
    const newTask: ScheduledTaskItem = normalizeScheduledTask({
      ...(previous || {}),
      title: taskTitle.trim(),
      description: taskDescription.trim(),
      model: formModel,
      thinkingLevel: ['minimal', 'low', 'medium', 'high'].includes(formThinkingLevel)
        ? formThinkingLevel as 'minimal' | 'low' | 'medium' | 'high'
        : undefined,
      agentId: formAgent.id,
      agentName: formAgent.name,
      priority: priority as 'low' | 'medium' | 'high',
      recurrence,
      triggerTime,
      dateOption,
      customDate: customDateVal,
      sources: [...attachedPins],
      id: previous?.id || `task_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      createdAt: previous?.createdAt || Date.now(),
      updatedAt: Date.now(),
      scheduledTimestamp: scheduledTs,
      status: 'scheduled',
    });

    saveTasksState(previous
      ? scheduledTasks.map(task => task.id === previous.id ? newTask : task)
      : [newTask, ...scheduledTasks]);

    // Reset form fields
    setTaskTitle('');
    setTaskDescription('');
    setAttachedPins([]);
    setEditingTaskId(null);

    // Automatically switch to 'my-list' tab so user immediately sees their new task!
    setSelectedSection('my-list');
  };

  const handleEditTask = useCallback((task: ScheduledTaskItem) => {
    if (task.status === 'running') return;
    setEditingTaskId(task.id);
    setTaskTitle(task.title);
    setTaskDescription(task.description);
    setFormModel(task.model || AUTO_MODEL_SELECTION);
    setFormThinkingLevel(task.thinkingLevel || 'medium');
    setFormAgent({ id: task.agentId, name: task.agentName });
    setPriority(task.priority);
    setRecurrence(task.recurrence);
    setTriggerTime(task.triggerTime);
    setDateOption(task.dateOption);
    setCustomDateVal(task.customDate || new Date(task.scheduledTimestamp).toISOString().split('T')[0]);
    setAttachedPins([...(task.sources || [])]);
    if (task.recurrence.startsWith('custom:')) {
      setCustomRepeatVal(task.recurrence.slice('custom:'.length));
      setShowCustomRepeatForm(true);
    }
    setSelectedSection('new-tasks');
  }, [setSelectedSection]);

  const handleCancelEdit = useCallback(() => {
    setEditingTaskId(null);
    setTaskTitle('');
    setTaskDescription('');
    setAttachedPins([]);
    setSelectedSection('my-list');
  }, [setSelectedSection]);

  const handleDeleteTask = useCallback((id: string) => {
    saveTasksState(scheduledTasks.filter(t => t.id !== id));
  }, [saveTasksState, scheduledTasks]);

  const handleRunTaskNow = useCallback((id: string) => {
    const updated = scheduledTasks.map(t => {
      if (t.id === id) {
        return {
          ...t,
          status: 'queued' as const,
          scheduledTimestamp: Date.now(),
        };
      }
      return t;
    });
    saveTasksState(updated);
    const target = updated.find(t => t.id === id);
    if (target) {
      window.dispatchEvent(new CustomEvent('eterx_trigger_scheduled_task', { detail: { task: target } }));
    }
    setSelectedSection('queue');
  }, [saveTasksState, scheduledTasks, setSelectedSection]);

  const handlePauseTask = useCallback((id: string) => {
    saveTasksState(scheduledTasks.map(task => task.id === id && task.status !== 'running'
      ? { ...task, status: 'paused' as const, updatedAt: Date.now() }
      : task));
    setSelectedSection('my-list');
  }, [saveTasksState, scheduledTasks, setSelectedSection]);

  const handleResumeTask = useCallback((id: string) => {
    saveTasksState(scheduledTasks.map(task => task.id === id
      ? { ...task, status: task.scheduledTimestamp <= Date.now() ? 'queued' as const : 'scheduled' as const, updatedAt: Date.now() }
      : task));
  }, [saveTasksState, scheduledTasks]);

  const detailsRef = useRef<HTMLDivElement>(null);
  const frequencyRef = useRef<HTMLDivElement>(null);
  const sourceMenuRef = useRef<HTMLDivElement>(null);
  const sourceFileInputRef = useRef<HTMLInputElement>(null);
  const sourceFolderInputRef = useRef<HTMLInputElement>(null);

  const [storedModelSettings, setStoredModelSettings] = useState(readStoredModelSettings);
  const [thinkingLevel, setThinkingLevel] = useState(() => {
    if (typeof window !== 'undefined') {
      return (appStorage.getItem('eterx_chat_thinking_level') || 'medium') as MainAgentThinkingLevel;
    }
    return 'medium' as MainAgentThinkingLevel;
  });

  const agentMode: MainAgentMode = useMemo(() => {
    if (typeof window !== 'undefined') {
      return (appStorage.getItem('eterx_chat_agent_mode') || 'auto') as MainAgentMode;
    }
    return 'auto' as MainAgentMode;
  }, [storedModelSettings.chatModelSelection]);

  useEffect(() => {
    const handleUpdate = () => {
      setStoredModelSettings(readStoredModelSettings());
      if (typeof window !== 'undefined') {
        setThinkingLevel((appStorage.getItem('eterx_chat_thinking_level') || 'medium') as MainAgentThinkingLevel);
      }
    };
    window.addEventListener('eterx-settings-updated', handleUpdate);
    window.addEventListener(FOLDER_STORAGE_READY_EVENT, handleUpdate);
    window.addEventListener('eterx-folder-storage-updated', handleUpdate);
    void appStorageReady.then(handleUpdate);
    return () => {
      window.removeEventListener('eterx-settings-updated', handleUpdate);
      window.removeEventListener(FOLDER_STORAGE_READY_EVENT, handleUpdate);
      window.removeEventListener('eterx-folder-storage-updated', handleUpdate);
    };
  }, []);

  // Set selected repeat rule in the durable AppData-backed store.
  const handleSetRecurrence = useCallback((val: string) => {
    setRecurrence(val);
    if (typeof window !== 'undefined') {
      appStorage.setItem('eterx_scheduler_default_repeat', val);
    }
  }, []);

  // Sync custom time input values when opening the time popover
  useEffect(() => {
    if (activePopover === 'time') {
      const [hStr, mStr] = triggerTime.split(':');
      const h = parseInt(hStr, 10);
      const period = h >= 12 ? 'PM' : 'AM';
      const displayHour = h % 12 === 0 ? 12 : h % 12;
      setCustomTimeVal(`${ displayHour }:${ mStr }`);
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
        (activePopover === 'model' || activePopover === 'thinking' || activePopover === 'agent' || activePopover === 'priority') &&
        detailsRef.current && !detailsRef.current.contains(e.target as Node)
      ) {
        setActivePopover(null);
      }
      if (
        (activePopover === 'repeat' || activePopover === 'time' || activePopover === 'date') &&
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
    optionKey: modelOptions[0]?.optionKey || modelEntryKey(fallbackModelConfig.provider, fallbackModelConfig.modelName),
    id: fallbackModelConfig.id,
    provider: fallbackModelConfig.provider,
    label: modelOptions[0]?.label || fallbackModelConfig.modelName,
    compactLabel: modelOptions[0]?.compactLabel || fallbackModelConfig.compactLabel,
    modelName: modelOptions[0]?.modelName || fallbackModelConfig.modelName,
    modelId: modelOptions[0]?.modelId || fallbackModelConfig.modelName,
  }), [fallbackModelConfig, modelOptions]);

  const selectedModel = useMemo(() => {
    return modelOptions.find(option => option.optionKey === storedModelSettings.chatModelSelection) || autoModelOption;
  }, [modelOptions, autoModelOption, storedModelSettings.chatModelSelection]);

  const getThinkingTarget = useCallback((option: ChatModelOption) => option.isAuto
    ? { provider: fallbackModelConfig.provider, modelName: fallbackModelConfig.modelName, capabilities: undefined }
    : {
      provider: option.provider,
      modelName: option.modelId || option.modelName,
      capabilities: storedModelSettings.thinkingCapabilities[option.optionKey],
    }, [fallbackModelConfig, storedModelSettings.thinkingCapabilities]);

  const doesModelSupportThinking = useCallback((option: ChatModelOption): boolean => {
    const target = getThinkingTarget(option);
    return modelSupportsThinking(target.provider, target.modelName, target.capabilities);
  }, [getThinkingTarget]);

  const getThinkingLevelOptions = useCallback((option: ChatModelOption) => {
    const target = getThinkingTarget(option);
    return getModelThinkingOptions(target.provider, target.modelName, target.capabilities);
  }, [getThinkingTarget]);

  // Set default model on catalog load
  useEffect(() => {
    setFormModel(selectedModel.optionKey);
  }, [selectedModel]);

  const allModelOptions = useMemo(() => modelOptions.length ? modelOptions : [autoModelOption], [autoModelOption, modelOptions]);
  const safeThinkingLevel = useMemo(() => normalizeMainAgentThinkingLevel(thinkingLevel), [thinkingLevel]);
  const activeThinkingOptions = useMemo(() => getThinkingLevelOptions(selectedModel), [selectedModel, getThinkingLevelOptions]);
  const selectedThinkingLevel = useMemo(() => {
    return activeThinkingOptions.find(option => option.id === safeThinkingLevel) || activeThinkingOptions[1] || activeThinkingOptions[0];
  }, [activeThinkingOptions, safeThinkingLevel]);

  const getModelOptionLabel = useCallback((option: ChatModelOption) => option.label, []);
  const modelDisplayLabel = getModelOptionLabel(selectedModel);
  const selectedFormModel = useMemo(
    () => allModelOptions.find(option => option.optionKey === formModel) || autoModelOption,
    [allModelOptions, autoModelOption, formModel],
  );
  const formThinkingOptions = useMemo(
    () => getThinkingLevelOptions(selectedFormModel),
    [getThinkingLevelOptions, selectedFormModel],
  );

  useEffect(() => {
    if (formThinkingOptions.some(option => option.id === formThinkingLevel)) return;
    setFormThinkingLevel(formThinkingOptions[1]?.id || formThinkingOptions[0]?.id || 'medium');
  }, [formThinkingLevel, formThinkingOptions]);

  const selectChatModelOption = useCallback((option: ChatModelOption) => {
    if (typeof window !== 'undefined') {
      if (option.isAuto) {
        appStorage.setItem(CHAT_MODEL_SELECTION_STORAGE_KEY, AUTO_MODEL_SELECTION);
        appStorage.setItem(MODEL_OVERRIDE_STORAGE_KEY, JSON.stringify({}));
        setStoredModelSettings(prev => ({
          ...prev,
          modelOverrides: {},
          chatModelSelection: AUTO_MODEL_SELECTION,
        }));
        emitModelSettingsUpdate({ chatModelSelection: AUTO_MODEL_SELECTION, modelOverrides: {} });
        syncRuntimeModelOverrides({});
      } else {
        appStorage.setItem(CHAT_MODEL_SELECTION_STORAGE_KEY, option.optionKey);
        const nextOverrides = {
          ...storedModelSettings.modelOverrides,
          [option.provider]: option.modelId || '',
        };
        appStorage.setItem(MODEL_OVERRIDE_STORAGE_KEY, JSON.stringify(nextOverrides));
        setStoredModelSettings(prev => ({
          ...prev,
          modelOverrides: nextOverrides,
          chatModelSelection: option.optionKey,
        }));
        emitModelSettingsUpdate({ chatModelSelection: option.optionKey, modelOverrides: nextOverrides });
        syncRuntimeModelOverrides(nextOverrides);
      }
      setShowModelMenu(false);
    }
  }, [storedModelSettings.modelOverrides]);

  const selectThinkingLevel = useCallback((levelId: MainAgentThinkingLevel) => {
    if (typeof window !== 'undefined') {
      appStorage.setItem('eterx_chat_thinking_level', levelId);
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
    { id: 'new-tasks', label: 'New tasks', count: 0 },
    { id: 'my-list', label: 'My List', count: myListTasks.length },
    { id: 'queue', label: 'Queue', count: queueTasks.length },
    { id: 'completed', label: 'Completed', count: completedTasks.length },
  ], [myListTasks.length, queueTasks.length, completedTasks.length]);

  const getRecurrenceLabel = (value: string) => {
    if (value === 'none' || value === 'once') return 'None';
    if (value.startsWith('custom:')) {
      return `Custom (${ value.split(':')[1] })`;
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

  // Continuous real-time system clock state
  const [nowClock, setNowClock] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNowClock(new Date()), 10000);
    return () => clearInterval(timer);
  }, []);

  const todayStr = useMemo(() => {
    const d = nowClock;
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }, [nowClock]);

  const isSelectedDateToday = useMemo(() => {
    if (dateOption === 'today') return true;
    if (dateOption === 'tomorrow') return false;
    if (dateOption === 'custom' && customDateVal) {
      return customDateVal === todayStr;
    }
    return true;
  }, [dateOption, customDateVal, todayStr]);

  // Generate 15-minute interval time options dynamically (omit past times if date is today)
  const filteredTimeOptions = useMemo(() => {
    const options = [];
    const currentMins = nowClock.getHours() * 60 + nowClock.getMinutes();

    for (let hour = 0; hour < 24; hour++) {
      for (let min of [0, 15, 30, 45]) {
        const optionMins = hour * 60 + min;
        if (isSelectedDateToday && optionMins < currentMins) {
          continue;
        }
        const period = hour >= 12 ? 'PM' : 'AM';
        const displayHour = hour % 12 === 0 ? 12 : hour % 12;
        const displayMin = min.toString().padStart(2, '0');
        const val = `${hour.toString().padStart(2, '0')}:${displayMin}`;
        const label = `${displayHour}:${displayMin} ${period}`;
        options.push({ value: val, label });
      }
    }
    return options;
  }, [nowClock, isSelectedDateToday]);

  // Auto-advance triggerTime to next available future slot if selected time has passed today
  useEffect(() => {
    if (isSelectedDateToday) {
      const [hStr, mStr] = triggerTime.split(':');
      const h = parseInt(hStr || '0', 10);
      const m = parseInt(mStr || '0', 10);
      const selMins = h * 60 + m;
      const curMins = nowClock.getHours() * 60 + nowClock.getMinutes();

      if (selMins < curMins && filteredTimeOptions.length > 0) {
        setTriggerTime(filteredTimeOptions[0].value);
      }
    }
  }, [isSelectedDateToday, triggerTime, nowClock, filteredTimeOptions]);

  // Format the current selected triggerTime to AM/PM display string
  const timeDisplayLabel = useMemo(() => {
    const [hStr, mStr] = triggerTime.split(':');
    const h = parseInt(hStr, 10);
    const period = h >= 12 ? 'PM' : 'AM';
    const displayHour = h % 12 === 0 ? 12 : h % 12;
    return `${ displayHour }:${ mStr } ${ period }`;
  }, [triggerTime]);

  // Form validation condition: True if title and instructions are entered
  const isFormValid = useMemo(() => {
    return taskTitle.trim() !== "" && taskDescription.trim() !== "";
  }, [taskTitle, taskDescription]);

  // Real attachment operations using Electron desktop APIs
  const importBrowserSources = async (files: File[]) => {
    const imported: { id: string; name: string; type: string; path: string }[] = [];
    for (const file of files.slice(0, 100)) {
      if (!file || file.size <= 0) continue;
      try {
        const formData = new FormData();
        formData.append('file', file, file.name || 'source-file');
        formData.append('fileName', file.name || 'source-file');
        formData.append('mimeType', file.type || 'application/octet-stream');
        const response = await fetch('/api/media/upload', { method: 'POST', body: formData });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload?.localPath) continue;
        imported.push({
          id: Math.random().toString(36).slice(2, 11),
          type: 'file',
          path: String(payload.localPath),
          name: file.name || String(payload.fileName || 'Source file'),
        });
      } catch { /* keep importing the remaining selected files */ }
    }
    if (imported.length) setAttachedPins(previous => [...previous, ...imported.filter(item => !previous.some(pin => pin.path === item.path))]);
  };

  const handleBrowserSourceSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length) void importBrowserSources(Array.from(event.target.files));
    event.target.value = '';
  };

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
      sourceFileInputRef.current?.click();
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
      sourceFolderInputRef.current?.click();
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
      <input type="file" multiple ref={sourceFileInputRef} onChange={handleBrowserSourceSelection} className="hidden" />
      <input
        type="file"
        multiple
        ref={sourceFolderInputRef}
        onChange={handleBrowserSourceSelection}
        className="hidden"
        {...({ webkitdirectory: '', directory: '' } as any)}
      />
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
                    <EterxLogo size={48} className="select-none pointer-events-none opacity-90" alt="EterX" />
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
                              onClick={() => {
                                setShowModelMenu(prev => !prev);
                                setModelSearch('');
                              }}
                              className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[#F4F4F4] bg-[#2D2D2D] hover:bg-[#333333] px-3 py-1 rounded-full cursor-pointer select-none transition-colors mr-2.5 group relative"
                            >
                              <span className="truncate max-w-[120px]">{modelDisplayLabel}</span>
                              <ChevronDown className={`w-3.5 h-3.5 text-white/40 group-hover:text-white/60 transition-transform duration-200 ${ showModelMenu ? 'rotate-180' : '' }`} strokeWidth={1.8} />
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
                                  {allModelOptions.length > 6 && (
                                    <div className="relative mb-1 shrink-0">
                                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#777]" />
                                      <input
                                        autoFocus
                                        value={modelSearch}
                                        onChange={event => setModelSearch(event.target.value)}
                                        onKeyDown={event => {
                                          if (event.key === 'Escape') setShowModelMenu(false);
                                        }}
                                        placeholder={`Search ${allModelOptions.length} models`}
                                        className="h-9 w-full rounded-lg border border-white/[0.08] bg-[#171717] pl-8 pr-3 text-[12px] text-[#F4F1EA] outline-none placeholder:text-[#777] focus:border-white/[0.18]"
                                      />
                                    </div>
                                  )}
                                  <div className="max-h-[280px] overflow-y-auto pr-1 eterx-scrollbar">
                                    {allModelOptions.filter(option => {
                                      const query = modelSearch.trim().toLowerCase();
                                      return !query || `${getModelOptionLabel(option)} ${MODEL_PROVIDER_LABEL[option.provider]} ${option.modelName}`.toLowerCase().includes(query);
                                    }).map((option) => {
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
                                    {allModelOptions.filter(option => {
                                      const query = modelSearch.trim().toLowerCase();
                                      return !query || `${getModelOptionLabel(option)} ${MODEL_PROVIDER_LABEL[option.provider]} ${option.modelName}`.toLowerCase().includes(query);
                                    }).length === 0 && (
                                      <div className="px-2.5 py-4 text-center text-[11px] text-[#A3A19E]">No matching models</div>
                                    )}
                                  </div>

                                  {doesModelSupportThinking(selectedModel) && (
                                    <>
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
                                                {activeThinkingOptions.map((level) => {
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
                                    </>
                                  )}
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
            ) : (selectedSection === 'new-tasks' || selectedSection === 'new_tasks' || !selectedSection) ? (
              /* Manual Mode layout: Structured scheduler form without vertical scrollbars */
              <div className="flex-1 w-full flex flex-col justify-between text-left max-w-[520px] mx-auto py-1 select-text">

                {/* Form Fields Container */}
                <form className="w-full flex flex-col flex-1 justify-between gap-4">
                  <div className="flex flex-col gap-4 w-full">

                    {/* Task Title (Borderless transparent) */}
                    <div className="relative w-full">
                      {!taskTitle && (
                        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-2 z-10 select-none text-[18px] font-bold leading-tight text-white/25">
                          Scheduled task title
                        </span>
                      )}
                      <input
                        type="text"
                        value={taskTitle}
                        onChange={(e) => setTaskTitle(e.target.value)}
                        placeholder=""
                        aria-label="Scheduled task title"
                        className="relative z-0 w-full bg-transparent border-0 outline-none focus:outline-none focus:ring-0 text-[18px] font-bold text-white py-2 leading-tight"
                      />
                    </div>

                    {/* Task Instructions Area (Describe what should do) */}
                    <div className="relative w-full">
                      {!taskDescription && (
                        <span aria-hidden="true" className="pointer-events-none absolute left-3.5 top-2.5 z-10 select-none text-[13px] leading-relaxed text-white/25">
                          Describe what the agent should do
                        </span>
                      )}
                      <textarea
                        rows={2}
                        value={taskDescription}
                        onChange={(e) => setTaskDescription(e.target.value)}
                        placeholder=""
                        aria-label="Describe what the agent should do"
                        className="relative z-0 w-full bg-[#181818]/60 border border-white/[0.04] rounded-xl px-3.5 py-2.5 text-[13px] text-white focus:outline-none focus:border-white/10 transition-colors resize-none leading-relaxed shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)]"
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
                                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[12px] text-left transition-colors cursor-pointer ${ option.optionKey === formModel
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

                        {/* Details - Thinking Row */}
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => setActivePopover(prev => prev === 'thinking' ? null : 'thinking')}
                            className="w-full flex items-center justify-between px-3.5 py-2 hover:bg-white/[0.02] transition-colors cursor-pointer"
                          >
                            <span className="text-[12.5px] text-white/50 font-medium">Thinking</span>
                            <div className="flex items-center gap-1">
                              <span className="text-[12.5px] text-white/90 font-medium capitalize">{formThinkingLevel}</span>
                              <ChevronDown className="w-3.5 h-3.5 text-white/40" />
                            </div>
                          </button>
                          <AnimatePresence>
                            {activePopover === 'thinking' && (
                              <motion.div
                                initial={{ opacity: 0, y: 4, scale: 0.99 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: 4, scale: 0.99 }}
                                transition={{ duration: 0.12 }}
                                className="absolute right-3.5 bottom-[calc(100%+4px)] z-[130] flex w-[180px] flex-col rounded-xl border border-white/[0.08] bg-[#161616]/95 backdrop-blur-xl p-1 shadow-[0_12px_36px_rgba(0,0,0,0.5)]"
                              >
                                {formThinkingOptions.map(option => (
                                  <button
                                    type="button"
                                    key={option.id}
                                    onClick={() => {
                                      setFormThinkingLevel(option.id);
                                      setActivePopover(null);
                                    }}
                                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[12px] text-left capitalize transition-colors cursor-pointer ${
                                      option.id === formThinkingLevel
                                        ? 'bg-white/[0.08] text-white font-medium'
                                        : 'text-white/70 hover:bg-white/[0.04] hover:text-white'
                                    }`}
                                  >
                                    <span>{option.label || option.id}</span>
                                    {option.id === formThinkingLevel && <Check className="w-3.5 h-3.5 text-white" strokeWidth={2.2} />}
                                  </button>
                                ))}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>

                        <div className="h-px bg-white/[0.03] mx-3.5" />

                        {/* Details - Agent Row */}
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => setActivePopover(prev => prev === 'agent' ? null : 'agent')}
                            className="w-full flex items-center justify-between px-3.5 py-2 hover:bg-white/[0.02] transition-colors cursor-pointer"
                          >
                            <span className="text-[12.5px] text-white/50 font-medium">Agent</span>
                            <div className="flex items-center gap-1">
                              <span className="text-[12.5px] text-white/90 font-medium">
                                {formAgent.name}
                              </span>
                              <ChevronDown className="w-3.5 h-3.5 text-white/40" />
                            </div>
                          </button>

                          <AnimatePresence>
                            {activePopover === 'agent' && (
                              <motion.div
                                initial={{ opacity: 0, y: 4, scale: 0.99 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: 4, scale: 0.99 }}
                                transition={{ duration: 0.12 }}
                                className="absolute right-3.5 bottom-[calc(100%+4px)] z-[130] flex w-[200px] flex-col rounded-xl border border-white/[0.08] bg-[#161616]/95 backdrop-blur-xl p-1 shadow-[0_12px_36px_rgba(0,0,0,0.5)] max-h-[180px] overflow-y-auto eterx-scrollbar"
                              >
                                {availableAgents.map((ag) => (
                                  <button
                                    type="button"
                                    key={ag.id || 'general'}
                                    onClick={() => {
                                      setFormAgent(ag);
                                      setActivePopover(null);
                                    }}
                                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[12px] text-left transition-colors cursor-pointer ${ (formAgent.id === ag.id)
                                        ? 'bg-white/[0.08] text-white font-medium shadow-sm'
                                        : 'text-white/70 hover:bg-white/[0.04] hover:text-white'
                                      }`}
                                  >
                                    <span className="truncate">{ag.name}</span>
                                    {(formAgent.id === ag.id) && <Check className="w-3.5 h-3.5 text-white" strokeWidth={2.2} />}
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
                                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[12px] text-left transition-colors cursor-pointer ${ priority === lvl
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
                                          className={`flex-1 min-w-0 bg-[#0A0A0A]/60 border rounded-lg px-2.5 py-1 text-[11px] text-white focus:outline-none transition-colors text-center ${ customRepeatVal.trim() === ""
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
                                              handleSetRecurrence(`custom:${ customRepeatVal.trim() }`);
                                              setActivePopover(null);
                                            }
                                          }}
                                          className={`px-3 py-1 font-semibold text-[11px] rounded-lg transition-all text-center ${ isCustomRepeatValid
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
                                          className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[12px] text-left transition-colors cursor-pointer ${ isSelected
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
                                            className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${ active ? 'bg-white text-black font-extrabold shadow-sm' : 'text-white/60 hover:text-white'
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
                                      setTriggerTime(`${ hFormatted }:${ mFormatted }`);
                                      setActivePopover(null);
                                    }}
                                    className="w-full py-1.5 bg-white text-black font-semibold text-[11px] rounded-lg hover:bg-white/90 active:scale-[0.98] transition-all cursor-pointer text-center"
                                  >
                                    Apply
                                  </button>
                                </div>

                                {/* Scrollable pre-set list underneath */}
                                <div className="flex-1 overflow-y-auto pr-0.5 eterx-scrollbar max-h-[130px] mt-1">
                                  {filteredTimeOptions.map((opt) => {
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
                                        className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[12px] text-left transition-colors cursor-pointer ${ isSelected
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

                        {/* Frequency - Date Row */}
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => setActivePopover(prev => prev === 'date' ? null : 'date')}
                            className="w-full flex items-center justify-between px-3.5 py-2.5 hover:bg-white/[0.02] transition-colors cursor-pointer"
                          >
                            <span className="text-[12.5px] text-white/50 font-medium">Date</span>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[12.5px] font-semibold text-white/90">
                                {getDateDisplayLabel(dateOption, customDateVal)}
                              </span>
                              <ChevronDown className="w-3.5 h-3.5 text-white/40" />
                            </div>
                          </button>

                          <AnimatePresence>
                            {activePopover === 'date' && (
                              <motion.div
                                initial={{ opacity: 0, y: 4, scale: 0.99 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: 4, scale: 0.99 }}
                                transition={{ duration: 0.12 }}
                                className="absolute right-3.5 bottom-[calc(100%+4px)] z-[130] flex w-[200px] flex-col rounded-xl border border-white/[0.08] bg-[#161616]/95 backdrop-blur-xl p-1.5 shadow-[0_12px_36px_rgba(0,0,0,0.5)] select-none text-left"
                              >
                                {['today', 'tomorrow'].map((opt) => (
                                  <button
                                    type="button"
                                    key={opt}
                                    onClick={() => {
                                      setDateOption(opt as 'today' | 'tomorrow');
                                      setActivePopover(null);
                                    }}
                                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[12px] text-left transition-colors cursor-pointer ${ dateOption === opt
                                        ? 'bg-white/[0.08] text-white font-medium shadow-sm'
                                        : 'text-[#E8E6E3] hover:bg-white/[0.04] hover:text-white'
                                      }`}
                                  >
                                    <span>{opt === 'today' ? 'Today' : 'Tomorrow'}</span>
                                    {dateOption === opt && <Check className="w-3.5 h-3.5 text-white" strokeWidth={2.2} />}
                                  </button>
                                ))}

                                <div className="my-1 h-px bg-white/[0.06]" />

                                <div className="flex flex-col gap-1 px-1 py-0.5">
                                  <span className="text-[10px] font-semibold text-white/40 tracking-wider uppercase">Set Custom Date</span>
                                  <input
                                    type="date"
                                    min={todayStr}
                                    value={customDateVal}
                                    onChange={(e) => {
                                      setCustomDateVal(e.target.value);
                                      setDateOption('custom');
                                    }}
                                    className="w-full bg-[#0A0A0A]/60 border border-white/[0.1] rounded-lg px-2.5 py-1 text-[12px] text-white focus:outline-none focus:border-white/30 transition-colors"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (customDateVal) setDateOption('custom');
                                      setActivePopover(null);
                                    }}
                                    className="mt-1 w-full py-1.5 bg-white text-black font-semibold text-[11px] rounded-lg hover:bg-white/90 active:scale-[0.98] transition-all cursor-pointer text-center"
                                  >
                                    Apply Date
                                  </button>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>

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
                  <div className="mt-1 pt-2.5 border-t border-white/[0.03] w-full flex items-center justify-between gap-3 select-none shrink-0">
                    <div className="min-w-0">
                      {editingTaskId && (
                        <button type="button" onClick={handleCancelEdit} className="text-[12px] font-medium text-white/50 transition-colors hover:text-white">
                          Cancel editing
                        </button>
                      )}
                    </div>
                    <button
                      type="submit"
                      disabled={!isFormValid}
                      onClick={handleScheduleTaskSubmit}
                      className={`px-6 py-2.5 rounded-xl font-semibold text-[12.5px] transition-all duration-200 select-none ${ isFormValid
                          ? 'bg-white text-black hover:bg-white/90 active:scale-[0.98] cursor-pointer shadow-[0_4px_16px_rgba(255,255,255,0.15)]'
                          : 'bg-white/5 text-white/30 border border-white/[0.04] cursor-not-allowed shadow-none'
                        }`}
                    >
                      {editingTaskId ? 'Save Changes' : 'Schedule Task'}
                    </button>
                  </div>
                </form>
              </div>
            ) : selectedSection === 'my-list' ? (
              /* My List View */
              <div className="flex-1 w-full flex flex-col gap-3 overflow-hidden text-left p-1 select-text">
                <div className="flex items-center justify-between pb-2 border-b border-white/[0.04] shrink-0">
                  <span className="text-[14px] font-bold text-white tracking-normal flex items-center gap-2">
                    My List <span className="text-[11.5px] font-semibold text-white/40 bg-white/[0.06] px-2 py-0.5 rounded-full">{myListTasks.length}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedSection('new-tasks')}
                    className="flex items-center gap-1.5 px-3 py-1 bg-white hover:bg-[#E8E6E3] text-black rounded-full text-[11px] font-semibold transition-all cursor-pointer shadow-sm active:scale-95"
                  >
                    <Plus className="w-3 h-3 text-black" strokeWidth={2.8} />
                    New task
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto pr-1 eterx-scrollbar flex flex-col gap-2.5">
                  {myListTasks.length === 0 ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-center py-16 text-white/35 text-[13px]">
                      No scheduled tasks in My List. Click "New task" to schedule one.
                    </div>
                  ) : (
                    myListTasks.map((t) => (
                      <div key={t.id} className="w-full bg-[#141414]/90 border border-white/[0.06] hover:border-white/[0.12] rounded-xl p-4 flex flex-col gap-2.5 transition-colors shadow-sm text-left">
                        <div className="flex items-start justify-between gap-3">
                          <span className="text-[14.5px] font-bold text-white leading-snug">{t.title}</span>
                          <div className="flex items-center gap-1.5">
                          {t.status === 'paused' && <span className="rounded-md border border-white/10 bg-white/[0.06] px-2 py-0.5 text-[10px] font-semibold text-white/55">Paused</span>}
                          <span className={`px-2 py-0.5 rounded-md text-[10px] font-semibold capitalize tracking-wider ${
                            t.priority === 'high' ? 'bg-rose-500/15 text-rose-300 border border-rose-500/20' :
                            t.priority === 'medium' ? 'bg-amber-500/15 text-amber-300 border border-amber-500/20' :
                            'bg-white/10 text-white/70 border border-white/10'
                          }`}>
                            {t.priority}
                          </span>
                          </div>
                        </div>

                        {t.description && (
                          <p className="text-[12.5px] text-white/70 leading-relaxed max-h-[60px] overflow-hidden truncate">
                            {t.description}
                          </p>
                        )}

                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          <span className="px-2.5 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-[11px] text-white/80 font-medium">
                            Agent: <strong className="text-white font-semibold">{t.agentName}</strong>
                          </span>
                          <span className="px-2.5 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-[11px] text-white/80 font-medium">
                            Model: {t.model}
                          </span>
                          {t.thinkingLevel && (
                            <span className="px-2.5 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-[11px] text-white/80 font-medium">
                              Thinking: {t.thinkingLevel}
                            </span>
                          )}
                          <span className="px-2.5 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-[11px] text-white/80 font-medium">
                            Scheduled: {formatScheduledTimeLabel(t)}
                          </span>
                          <span className="px-2.5 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-[11px] text-white/80 font-medium">
                            Repeat: {getRecurrenceLabel(t.recurrence)}
                          </span>
                          {t.sources && t.sources.length > 0 && (
                            <span className="px-2.5 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-[11px] text-white/80 font-medium">
                              Sources: {t.sources.length}
                            </span>
                          )}
                        </div>

                        {renderRunHistory(t)}

                        <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/[0.03]">
                          {t.status === 'paused' ? (
                            <button type="button" onClick={() => handleResumeTask(t.id)} className="inline-flex items-center gap-1 px-2.5 py-1 bg-white/10 hover:bg-white/20 text-white rounded-lg text-[11.5px] font-medium transition-colors">
                              <RotateCcw className="h-3 w-3" /> Resume
                            </button>
                          ) : (
                            <button type="button" onClick={() => handlePauseTask(t.id)} className="inline-flex items-center gap-1 px-2.5 py-1 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white rounded-lg text-[11.5px] transition-colors">
                              <Pause className="h-3 w-3" /> Pause
                            </button>
                          )}
                          <button type="button" onClick={() => handleEditTask(t)} className="inline-flex items-center gap-1 px-2.5 py-1 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white rounded-lg text-[11.5px] transition-colors">
                            <Pencil className="h-3 w-3" /> Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRunTaskNow(t.id)}
                            className="px-3 py-1 bg-white text-black hover:bg-[#E8E6E3] rounded-lg text-[11.5px] font-semibold transition-colors cursor-pointer active:scale-95"
                          >
                            Run Now →
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteTask(t.id)}
                            className="px-2.5 py-1 bg-white/5 hover:bg-rose-500/20 text-white/50 hover:text-rose-300 rounded-lg text-[11.5px] transition-colors cursor-pointer"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : selectedSection === 'queue' ? (
              /* Queue View — Sorted by ascending scheduled execution time (next task at top!) */
              <div className="flex-1 w-full flex flex-col gap-3 overflow-hidden text-left p-1 select-text">
                <div className="flex items-center justify-between pb-2 border-b border-white/[0.04] shrink-0">
                  <span className="text-[14px] font-bold text-white tracking-normal flex items-center gap-2">
                    Queue <span className="text-[11.5px] font-semibold text-white/40 bg-white/[0.06] px-2 py-0.5 rounded-full">{queueTasks.length}</span>
                  </span>
                  <span className="text-[11.5px] text-white/40">Sorted by priority & execution time</span>
                </div>

                <div className="flex-1 overflow-y-auto pr-1 eterx-scrollbar flex flex-col gap-2.5">
                  {queueTasks.length === 0 ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-center py-16 text-white/35 text-[13px]">
                      No tasks currently queued or running.
                    </div>
                  ) : (
                    queueTasks.map((t) => (
                      <div key={t.id} className="w-full bg-[#141414]/90 border border-white/[0.06] rounded-xl p-4 flex flex-col gap-2.5 shadow-sm text-left">
                        <div className="flex items-start justify-between gap-3">
                          <span className="text-[14.5px] font-bold text-white leading-snug">{t.title}</span>
                          <span className={`px-2.5 py-0.5 rounded-full text-[10.5px] font-semibold capitalize tracking-wider flex items-center gap-1.5 ${
                            t.status === 'running'
                              ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/20'
                              : 'bg-amber-500/15 text-amber-300 border border-amber-500/20'
                          }`}>
                            {t.status === 'running' ? (
                              <Loader2 className="w-3 h-3 text-emerald-400 animate-spin" />
                            ) : (
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                            )}
                            {t.status === 'running' ? <Shimmer>Running</Shimmer> : 'Queued'}
                          </span>
                        </div>

                        {t.description && (
                          <p className="text-[12.5px] text-white/70 leading-relaxed max-h-[60px] overflow-hidden truncate">
                            {t.description}
                          </p>
                        )}

                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          <span className="px-2.5 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-[11px] text-white/80 font-medium">
                            Agent: <strong className="text-white font-semibold">{t.agentName}</strong>
                          </span>
                          <span className="px-2.5 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-[11px] text-white/80 font-medium">
                            Model: {t.model}
                          </span>
                          {t.thinkingLevel && (
                            <span className="px-2.5 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-[11px] text-white/80 font-medium">
                              Thinking: {t.thinkingLevel}
                            </span>
                          )}
                          <span className="px-2.5 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-[11px] text-white/80 font-medium">
                            Execution Time: {formatScheduledTimeLabel(t)}
                          </span>
                        </div>

                        <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/[0.03]">
                          {t.chatId && onOpenChat && (
                            <button type="button" onClick={() => onOpenChat(t.chatId!)} className="px-2.5 py-1 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white rounded-lg text-[11.5px] transition-colors">
                              Open chat
                            </button>
                          )}
                          {t.status !== 'running' && (
                            <button type="button" onClick={() => handlePauseTask(t.id)} className="px-2.5 py-1 bg-white/5 hover:bg-amber-500/15 text-white/50 hover:text-amber-200 rounded-lg text-[11.5px] transition-colors cursor-pointer">
                              Cancel run
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : (
              /* Completed View */
              <div className="flex-1 w-full flex flex-col gap-3 overflow-hidden text-left p-1 select-text">
                <div className="flex items-center justify-between pb-2 border-b border-white/[0.04] shrink-0">
                  <span className="text-[14px] font-bold text-white tracking-normal flex items-center gap-2">
                    Completed <span className="text-[11.5px] font-semibold text-white/40 bg-white/[0.06] px-2 py-0.5 rounded-full">{completedTasks.length}</span>
                  </span>
                </div>

                <div className="flex-1 overflow-y-auto pr-1 eterx-scrollbar flex flex-col gap-2.5">
                  {completedTasks.length === 0 ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-center py-16 text-white/35 text-[13px]">
                      No completed tasks yet.
                    </div>
                  ) : (
                    completedTasks.map((t) => (
                      <div key={t.id} className="w-full bg-[#141414]/90 border border-white/[0.06] rounded-xl p-4 flex flex-col gap-2.5 shadow-sm text-left">
                        <div className="flex items-start justify-between gap-3">
                          <span className="text-[14.5px] font-bold text-white leading-snug">{t.title}</span>
                          <span className={`px-2.5 py-0.5 rounded-full text-[10.5px] font-semibold capitalize tracking-wider flex items-center gap-1.5 ${
                            t.status === 'completed'
                              ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/20'
                              : 'bg-rose-500/15 text-rose-300 border border-rose-500/20'
                          }`}>
                            {t.status === 'completed' ? 'Completed' : t.status === 'cancelled' ? 'Cancelled' : 'Failed'}
                          </span>
                        </div>

                        {t.description && (
                          <p className="text-[12.5px] text-white/70 leading-relaxed max-h-[60px] overflow-hidden truncate">
                            {t.description}
                          </p>
                        )}

                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          <span className="px-2.5 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-[11px] text-white/80 font-medium">
                            Agent: <strong className="text-white font-semibold">{t.agentName}</strong>
                          </span>
                          <span className="px-2.5 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-[11px] text-white/80 font-medium">
                            Model: {t.model}
                          </span>
                          {t.thinkingLevel && (
                            <span className="px-2.5 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-[11px] text-white/80 font-medium">
                              Thinking: {t.thinkingLevel}
                            </span>
                          )}
                          {t.executedAt && (
                            <span className="px-2.5 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-[11px] text-white/80 font-medium">
                              Executed: {new Date(t.executedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          )}
                        </div>

                        {renderRunHistory(t)}

                        <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/[0.03]">
                          {t.chatId && onOpenChat && (
                            <button type="button" onClick={() => onOpenChat(t.chatId!)} className="px-2.5 py-1 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white rounded-lg text-[11.5px] transition-colors">
                              Open chat
                            </button>
                          )}
                          <button type="button" onClick={() => handleEditTask(t)} className="inline-flex items-center gap-1 px-2.5 py-1 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white rounded-lg text-[11.5px] transition-colors">
                            <Pencil className="h-3 w-3" /> Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRunTaskNow(t.id)}
                            className="px-3 py-1 bg-white/10 hover:bg-white/20 text-white rounded-lg text-[11.5px] font-semibold transition-colors cursor-pointer"
                          >
                            Run Again
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteTask(t.id)}
                            className="px-2.5 py-1 bg-white/5 hover:bg-rose-500/20 text-white/50 hover:text-rose-300 rounded-lg text-[11.5px] transition-colors cursor-pointer"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
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
                      className={`group flex min-h-[36px] w-full items-center justify-center px-3 py-1.5 rounded-lg text-[12px] text-center transition-all duration-150 cursor-pointer border border-transparent relative select-none ${ isActive
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
                      className={`group flex min-h-[38px] w-full items-center justify-between px-3 py-1.5 rounded-lg text-[12px] transition-all duration-150 cursor-pointer border border-transparent relative select-none ${ isActive
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
                      <span className="relative z-10 truncate">{item.label}</span>
                      {item.count > 0 && (
                        <span className={`relative z-10 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0 ml-1.5 transition-colors ${
                          isActive
                            ? 'bg-white text-black font-extrabold shadow-sm'
                            : 'bg-white/10 text-white/70 border border-white/10'
                        }`}>
                          {item.count}
                        </span>
                      )}
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
});
