import {
  getGeminiThinkingConfig, getModelThinkingOptions,
  type MainAgentThinkingLevel, type ModelThinkingCapabilities,
} from '../agent/model-routing';

const canonicalModel = (model: unknown): string => String(model || '').trim().toLowerCase()
  .replace(/^models\//, '').replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-preview$/, '');

export const isGeminiExtendedThinkingModel = (model: unknown): boolean =>
  canonicalModel(model) === 'gemini-3.8-live-extended-thinking';

export const getGeminiLiveThinkingLevels = (
  model: string,
  capabilities?: ModelThinkingCapabilities | null,
): MainAgentThinkingLevel[] => {
  const id = canonicalModel(model);
  // Live and generateContent are separate contracts. Generic catalog flags
  // must not enable unsupported configuration on the fixed-latency model.
  if (id === 'gemini-3.8-live') return [];
  if (isGeminiExtendedThinkingModel(id)) return ['low', 'medium', 'high'];
  if (id === 'gemini-3.1-flash-live') return ['minimal', 'low', 'medium', 'high'];
  return getModelThinkingOptions('gemini', model, capabilities).map(option => option.id);
};

/** This adapter sends raw protobuf JSON over WebSocket, unlike the SDK-based
 * chat adapter. Enum values must use their documented uppercase wire names.
 * https://ai.google.dev/gemini-api/docs/live-api/thinking */
export const getGeminiLiveThinkingConfig = (
  model: string,
  requested: MainAgentThinkingLevel = 'low',
  includeThoughts = false,
  capabilities?: ModelThinkingCapabilities | null,
): Record<string, unknown> | null => {
  const levels = getGeminiLiveThinkingLevels(model, capabilities);
  if (!levels.length) return null;
  const level = levels.includes(requested) ? requested
    : requested === 'minimal' || requested === 'off' ? levels[0]
    : levels.includes('medium') ? 'medium' : levels[0];
  const id = canonicalModel(model);
  const config = isGeminiExtendedThinkingModel(id) || id === 'gemini-3.1-flash-live'
    ? { thinkingLevel: level, includeThoughts }
    : getGeminiThinkingConfig(level, model, includeThoughts, capabilities);
  if (!config) return null;
  return typeof config.thinkingLevel === 'string'
    ? { ...config, thinkingLevel: config.thinkingLevel.toUpperCase() }
    : config;
};
