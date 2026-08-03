export type LiveProviderOption = {
  value: 'agent-live-convo';
  provider: 'gemini';
  label: string;
  description: string;
};

/**
 * Live Convo is deliberately limited to transports implemented by the app.
 * Ordinary model providers remain available in Settings > Models/API.
 */
export const LIVE_PROVIDER_OPTIONS: LiveProviderOption[] = [
  {
    value: 'agent-live-convo',
    provider: 'gemini',
    label: 'Agent Live Convo',
    description: 'Gemini native bidirectional audio, video, and tool-calling session',
  },
];

export const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';

export const normalizeGeminiLiveModelName = (value: unknown): string => {
  const model = String(value || DEFAULT_GEMINI_LIVE_MODEL).trim();
  if (!model) return `models/${DEFAULT_GEMINI_LIVE_MODEL}`;
  return model.startsWith('models/') ? model : `models/${model}`;
};

export const normalizeLiveProvider = (value: unknown): LiveProviderOption => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'gemini-live' || normalized === 'gemini' || normalized === 'agent-live' || normalized === 'agent-live-convo') {
    return LIVE_PROVIDER_OPTIONS[0];
  }
  return LIVE_PROVIDER_OPTIONS[0];
};

export const isGeminiLiveModel = (value: unknown): boolean => {
  const model = String(value || '').trim().toLowerCase();
  if (!model || model.includes('translate') || model.includes('robotics')) return false;
  return model.includes('native-audio') || model.includes('flash-live');
};
