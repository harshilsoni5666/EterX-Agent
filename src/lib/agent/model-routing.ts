export type MainAgentProvider = 'gemini' | 'mistral';
export type MainAgentMode = 'think' | 'fast' | 'mistral';
export type MainAgentThinkingLevel = 'low' | 'high';

export type MainAgentModelConfig = {
  id: MainAgentMode;
  provider: MainAgentProvider;
  label: string;
  compactLabel: string;
  modelName: string;
  selectable: boolean;
};

export const MAIN_AGENT_MODE_CONFIG: Record<MainAgentMode, MainAgentModelConfig> = {
  think: {
    id: 'think',
    provider: 'gemini',
    label: 'Gemini 3.5 Flash',
    compactLabel: 'Gemini',
    modelName: 'gemini-3.5-flash',
    selectable: true,
  },
  fast: {
    id: 'fast',
    provider: 'gemini',
    label: 'Gemini 3.5 Flash',
    compactLabel: 'Gemini',
    modelName: 'gemini-3.5-flash',
    selectable: false,
  },
  mistral: {
    id: 'mistral',
    provider: 'mistral',
    label: 'Mistral Devstral 2',
    compactLabel: 'Mistral',
    modelName: 'devstral-2512',
    selectable: true,
  },
};

export const MAIN_AGENT_MODEL_OPTIONS = Object.values(MAIN_AGENT_MODE_CONFIG).filter(option => option.selectable);

export const MAIN_AGENT_THINKING_LEVEL_STORAGE_KEY = 'eterx-thinking-level';

export const MAIN_AGENT_THINKING_LEVEL_OPTIONS: Array<{ id: MainAgentThinkingLevel; label: string }> = [
  { id: 'low', label: 'Low' },
  { id: 'high', label: 'High' },
];

export function normalizeMainAgentMode(value: unknown): MainAgentMode {
  if (typeof value !== 'string') return 'think';
  if (value in MAIN_AGENT_MODE_CONFIG) return value as MainAgentMode;
  return Object.values(MAIN_AGENT_MODE_CONFIG).find(option => option.modelName === value)?.id || 'think';
}

export function getMainAgentModelConfig(mode: unknown): MainAgentModelConfig {
  return MAIN_AGENT_MODE_CONFIG[normalizeMainAgentMode(mode)];
}

export function normalizeMainAgentThinkingLevel(value: unknown): MainAgentThinkingLevel {
  if (value === 'high' || value === 'enterprise' || value === 'extended') return 'high';
  return 'low';
}
