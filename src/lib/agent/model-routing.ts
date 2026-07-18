/**
 * ═══════════════════════════════════════════════════════════════
 * UNIVERSAL MODEL REGISTRY — API-Change Proof Routing
 * ═══════════════════════════════════════════════════════════════
 *
 * NEVER hardcode model names. All model resolution goes through here.
 * If Google/Mistral renames a model, you only change .env.local — zero code changes.
 *
 * Resolution Order (highest priority first):
 *   1. Environment variable (ETERX_THINK_MODEL, ETERX_FAST_MODEL, etc.)
 *   2. Detected live model from last successful call (proven model cache)
 *   3. Static fallback chain (newest → oldest known-stable)
 *
 * Fallback chains are tried automatically when any model returns
 * 404 / 501 / "model not found" / "model deprecated" errors.
 */

import {
  getRuntimeModelOverrides,
  getScopedModelOverride,
  type ScopedRuntimeSettings,
} from './runtime-api-keys';

export type MainAgentProvider = 'gemini' | 'mistral' | 'openai' | 'openrouter' | 'anthropic' | 'groq';
export type MainAgentMode = 'think' | 'fast' | 'mistral' | 'openai' | 'openrouter' | 'anthropic' | 'groq';
/**
 * A provider-neutral value persisted by the composer.  Individual providers
 * expose only the values that their selected model actually accepts.
 */
export type MainAgentThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ModelThinkingOption = {
  id: MainAgentThinkingLevel;
  label: string;
};

/** Capability metadata returned by a provider's live model catalog. */
export type ModelThinkingCapabilities = {
  levels: MainAgentThinkingLevel[];
  defaultLevel?: MainAgentThinkingLevel;
  parameter?: 'thinkingLevel' | 'reasoning_effort' | 'reasoning' | 'output_config.effort';
  source?: 'provider';
};

export type MainAgentModelConfig = {
  id: MainAgentMode;
  provider: MainAgentProvider;
  label: string;
  compactLabel: string;
  modelName: string;
  selectable: boolean;
};

// ─── Static fallback chains (newest → oldest stable) ─────────────────────────
// These are tried IN ORDER when the primary model fails with a model-not-found error.
export const GEMINI_THINK_FALLBACK_CHAIN: readonly string[] = [
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
  'gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
];

export const GEMINI_FAST_FALLBACK_CHAIN: readonly string[] = [
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
];

export const MISTRAL_FALLBACK_CHAIN: readonly string[] = [
  'mistral-medium-3-5',
  'mistral-medium-2508',
  'mistral-large-2512',
  'mistral-small-2603',
  'ministral-14b-2512',
  'ministral-8b-2512',
  'codestral-2508',
];

export const OPENAI_FALLBACK_CHAIN: readonly string[] = [
  'gpt-5.6-sol',
  'gpt-5.6-luna-pro',
  'gpt-5.6-luna',
  'gpt-5.6-terra-pro',
  'gpt-5.6-terra',
  'gpt-5.5',
  'o3-pro',
  'o3',
  'o4-mini',
  'gpt-5.4-pro',
  'gpt-5.4-mini',
  'gpt-4o',
  'gpt-4o-mini',
];

export const OPENROUTER_FALLBACK_CHAIN: readonly string[] = [
  'openai/gpt-5.6-sol',
  'openai/gpt-5.6-luna',
  'openai/gpt-5.6-terra',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-fable-5',
  'google/gemini-3.5-flash',
  'x-ai/grok-4.5',
];

export const ANTHROPIC_FALLBACK_CHAIN: readonly string[] = [
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-4-8',
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
];

export const GROQ_FALLBACK_CHAIN: readonly string[] = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
];

// ─── Proven model cache — survives the entire process lifetime ────────────────
// When a model call succeeds, we record it here so the next call uses the proven name.
const _provenModels: Map<string, string> = new Map();

export function recordProvenModel(mode: MainAgentMode, modelName: string): void {
  _provenModels.set(mode, modelName);
}

export function getProvenModel(mode: MainAgentMode): string | undefined {
  return _provenModels.get(mode);
}

export function clearProvenModel(mode: MainAgentMode): void {
  _provenModels.delete(mode);
}

// ─── Live model resolution ────────────────────────────────────────────────────

/**
 * Resolve the active model name for a mode.
 * Reads env vars first, then proven cache, then first chain entry.
 */
export function resolveModelName(mode: MainAgentMode, runtimeSettings?: ScopedRuntimeSettings | null): string {
  const overrides = getRuntimeModelOverrides();
  switch (mode) {
    case 'think': {
      const scopedOverride = getScopedModelOverride(runtimeSettings, 'gemini');
      if (scopedOverride) return scopedOverride;
      if (overrides.gemini) return overrides.gemini;
      return getProvenModel('think') || GEMINI_THINK_FALLBACK_CHAIN[0];
    }
    case 'fast': {
      const scopedOverride = getScopedModelOverride(runtimeSettings, 'gemini');
      if (scopedOverride) return scopedOverride;
      if (overrides.gemini) return overrides.gemini;
      return getProvenModel('fast') || GEMINI_FAST_FALLBACK_CHAIN[0];
    }
    case 'mistral': {
      const scopedOverride = getScopedModelOverride(runtimeSettings, 'mistral');
      if (scopedOverride) return scopedOverride;
      if (overrides.mistral) return overrides.mistral;
      return getProvenModel('mistral') || MISTRAL_FALLBACK_CHAIN[0];
    }
    case 'openai': {
      const scopedOverride = getScopedModelOverride(runtimeSettings, 'openai');
      if (scopedOverride) return scopedOverride;
      if (overrides.openai) return overrides.openai;
      return getProvenModel('openai') || OPENAI_FALLBACK_CHAIN[0];
    }
    case 'openrouter': {
      const scopedOverride = getScopedModelOverride(runtimeSettings, 'openrouter');
      if (scopedOverride) return scopedOverride;
      if (overrides.openrouter) return overrides.openrouter;
      return getProvenModel('openrouter') || OPENROUTER_FALLBACK_CHAIN[0];
    }
    case 'anthropic': {
      const scopedOverride = getScopedModelOverride(runtimeSettings, 'anthropic');
      if (scopedOverride) return scopedOverride;
      if (overrides.anthropic) return overrides.anthropic;
      return getProvenModel('anthropic') || ANTHROPIC_FALLBACK_CHAIN[0];
    }
    case 'groq': {
      const scopedOverride = getScopedModelOverride(runtimeSettings, 'groq');
      if (scopedOverride) return scopedOverride;
      if (overrides.groq) return overrides.groq;
      return getProvenModel('groq') || GROQ_FALLBACK_CHAIN[0];
    }
    default:
      return GEMINI_THINK_FALLBACK_CHAIN[0];
  }
}

/**
 * Get the full fallback chain for a mode.
 * Used by GeminiAgentClient to try next model when primary fails.
 */
export function getFallbackChain(mode: MainAgentMode, runtimeSettings?: ScopedRuntimeSettings | null): string[] {
  const primary = resolveModelName(mode, runtimeSettings);
  switch (mode) {
    case 'think': {
      const chain = GEMINI_THINK_FALLBACK_CHAIN.filter(m => m !== primary);
      return [primary, ...chain];
    }
    case 'fast': {
      const chain = GEMINI_FAST_FALLBACK_CHAIN.filter(m => m !== primary);
      return [primary, ...chain];
    }
    case 'mistral': {
      const chain = MISTRAL_FALLBACK_CHAIN.filter(m => m !== primary);
      return [primary, ...chain];
    }
    case 'openai': {
      const chain = OPENAI_FALLBACK_CHAIN.filter(m => m !== primary);
      return [primary, ...chain];
    }
    case 'openrouter': {
      const chain = OPENROUTER_FALLBACK_CHAIN.filter(m => m !== primary);
      return [primary, ...chain];
    }
    case 'anthropic': {
      const chain = ANTHROPIC_FALLBACK_CHAIN.filter(m => m !== primary);
      return [primary, ...chain];
    }
    case 'groq': {
      const chain = GROQ_FALLBACK_CHAIN.filter(m => m !== primary);
      return [primary, ...chain];
    }
    default:
      return [primary];
  }
}

/**
 * Detect if an error message indicates a model is deprecated/not-found.
 * These errors should trigger fallback chain traversal, NOT key rotation.
 */
export function isModelDeprecatedError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase();
  return (
    lower.includes('model not found') ||
    lower.includes('model_not_found') ||
    lower.includes('not supported') ||
    lower.includes('deprecated') ||
    lower.includes('no longer available') ||
    lower.includes('invalid model') ||
    lower.includes('unsupported model') ||
    lower.includes('does not exist') ||
    // Gemini-specific
    lower.includes('models/gemini') && lower.includes('not found') ||
    // HTTP 404 specifically on model endpoint
    (lower.includes('404') && (lower.includes('model') || lower.includes('generate')))
  );
}

// ─── Static mode config (display labels etc.) ────────────────────────────────

export const MAIN_AGENT_MODE_CONFIG: Record<MainAgentMode, MainAgentModelConfig> = {
  think: {
    id: 'think',
    provider: 'gemini',
    label: 'Gemini 3.5 Flash',
    compactLabel: 'Gemini',
    get modelName() { return resolveModelName('think'); },
    selectable: true,
  },
  fast: {
    id: 'fast',
    provider: 'gemini',
    label: 'Gemini (Fast)',
    compactLabel: 'Gemini',
    get modelName() { return resolveModelName('fast'); },
    selectable: false,
  },
  mistral: {
    id: 'mistral',
    provider: 'mistral',
    label: 'Mistral Medium 3.5',
    compactLabel: 'Mistral',
    get modelName() { return resolveModelName('mistral'); },
    selectable: true,
  },
  openai: {
    id: 'openai',
    provider: 'openai',
    label: 'GPT-5.6 Luna',
    compactLabel: 'OpenAI',
    get modelName() { return resolveModelName('openai'); },
    selectable: true,
  },
  openrouter: {
    id: 'openrouter',
    provider: 'openrouter',
    label: 'OpenRouter',
    compactLabel: 'Router',
    get modelName() { return resolveModelName('openrouter'); },
    selectable: true,
  },
  anthropic: {
    id: 'anthropic',
    provider: 'anthropic',
    label: 'Claude Sonnet 5',
    compactLabel: 'Claude',
    get modelName() { return resolveModelName('anthropic'); },
    selectable: true,
  },
  groq: {
    id: 'groq',
    provider: 'groq',
    label: 'Groq',
    compactLabel: 'Groq',
    get modelName() { return resolveModelName('groq'); },
    selectable: true,
  },
};

export const MAIN_AGENT_MODEL_OPTIONS = Object.values(MAIN_AGENT_MODE_CONFIG).filter(o => o.selectable);

export const MAIN_AGENT_THINKING_LEVEL_STORAGE_KEY = 'eterx-thinking-level';

export const MAIN_AGENT_THINKING_LEVEL_OPTIONS: ModelThinkingOption[] = [
  { id: 'off', label: 'Off' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
];

const thinkingOptions = (...levels: MainAgentThinkingLevel[]): ModelThinkingOption[] =>
  levels.map(id => MAIN_AGENT_THINKING_LEVEL_OPTIONS.find(option => option.id === id)!);

export const isOpenAIReasoningModel = (model: string) =>
  /(?:^|[/:_-])(?:o1|o3|o4)(?:$|[/:_-])|gpt-5|luna|terra|sol/i.test(model);

const isClaudeEffortModel = (model: string) =>
  /(?:claude-(?:fable|mythos|sonnet-5|opus-4-(?:6|7|8)))/i.test(model);

const isClaudeXHighModel = (model: string) =>
  /(?:claude-(?:fable|mythos|sonnet-5|opus-4-(?:7|8)))/i.test(model);

const isMistralReasoningModel = (model: string) =>
  /(?:mistral-small(?:-latest)?|mistral-medium-3-5)/i.test(model);

/**
 * Returns the exact thinking choices for a concrete provider/model pair.
 * Keep this registry client-safe: both composer UIs and server adapters use it.
 */
export function getModelThinkingOptions(
  provider: MainAgentProvider,
  modelName: string,
  discovered?: ModelThinkingCapabilities | null,
): ModelThinkingOption[] {
  if (discovered?.levels?.length) {
    return discovered.levels
      .map(level => MAIN_AGENT_THINKING_LEVEL_OPTIONS.find(option => option.id === level))
      .filter((option): option is ModelThinkingOption => Boolean(option));
  }
  const model = String(modelName || '').trim().toLowerCase();
  if (!model) return [];

  if (provider === 'gemini') {
    if (model.includes('gemini-3.1-flash-lite')) return thinkingOptions('off', 'minimal', 'high');
    if (model.includes('gemini-3.5') || model.includes('gemini-3-flash')) {
      return thinkingOptions('off', 'minimal', 'low', 'medium', 'high');
    }
    if (model.includes('gemini-3.1-pro')) return thinkingOptions('off', 'low', 'medium', 'high');
    if (model.includes('gemini-3-pro')) return thinkingOptions('off', 'low', 'high');
    if (model.includes('gemini-2.5')) return thinkingOptions('off', 'low', 'medium', 'high');
    if (model.includes('gemini-2.0-flash-thinking')) return thinkingOptions('off', 'low', 'medium', 'high');
    return [];
  }

  if (provider === 'mistral') {
    // Mistral exposes two API values: "none" and "high".
    return isMistralReasoningModel(model) ? thinkingOptions('off', 'high') : [];
  }

  if (provider === 'anthropic') {
    if (!model.includes('claude')) return [];
    return isClaudeXHighModel(model)
      ? thinkingOptions('off', 'low', 'medium', 'high', 'xhigh', 'max')
      : isClaudeEffortModel(model)
        ? thinkingOptions('off', 'low', 'medium', 'high', 'max')
        : [];
  }

  if (provider === 'openai') {
    return isOpenAIReasoningModel(model)
      ? thinkingOptions('off', 'minimal', 'low', 'medium', 'high', 'xhigh')
      : [];
  }

  if (provider === 'openrouter') {
    // OpenRouter normalizes this under its `reasoning` object.  We can infer
    // the common vendor families from the selected exact model id; unknown
    // models intentionally do not show a control rather than receive an
    // unsupported parameter.
    if (model.includes('claude')) {
      return isClaudeXHighModel(model)
        ? thinkingOptions('off', 'low', 'medium', 'high', 'xhigh', 'max')
        : isClaudeEffortModel(model)
          ? thinkingOptions('off', 'low', 'medium', 'high', 'max')
          : [];
    }
    if (model.includes('gemini')) {
      return getModelThinkingOptions('gemini', model.replace(/^google\//, ''));
    }
    if (isOpenAIReasoningModel(model) || model.includes('grok')) {
      return thinkingOptions('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max');
    }
  }

  return [];
}

export function doesModelSupportThinking(
  provider: MainAgentProvider,
  modelName: string,
  discovered?: ModelThinkingCapabilities | null,
): boolean {
  return getModelThinkingOptions(provider, modelName, discovered).length > 0;
}

export function normalizeModelThinkingCapabilities(value: unknown): ModelThinkingCapabilities | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const rawLevels = Array.isArray(source.levels)
    ? source.levels
    : Array.isArray(source.supported_efforts)
      ? source.supported_efforts
      : Array.isArray(source.supportedThinkingLevels)
        ? source.supportedThinkingLevels
        : [];
  const levels = Array.from(new Set(rawLevels
    .map(level => normalizeMainAgentThinkingLevel(level))
    .filter(level => level !== 'medium' || rawLevels.some(raw => String(raw).toLowerCase() === 'medium'))));
  if (levels.length === 0) return null;

  const rawDefault = source.defaultLevel ?? source.default_effort ?? source.defaultThinkingLevel;
  const defaultLevel = rawDefault === undefined ? undefined : normalizeMainAgentThinkingLevel(rawDefault);
  const parameter = source.parameter === 'thinkingLevel' || source.parameter === 'reasoning_effort' || source.parameter === 'reasoning' || source.parameter === 'output_config.effort'
    ? source.parameter
    : undefined;
  return { levels, ...(defaultLevel && levels.includes(defaultLevel) ? { defaultLevel } : {}), ...(parameter ? { parameter } : {}), source: 'provider' };
}

/**
 * Converts a saved/legacy selection to one the current exact model accepts.
 * This prevents a selection from one provider leaking into the next provider.
 */
export function normalizeThinkingLevelForModel(
  value: unknown,
  provider: MainAgentProvider,
  modelName: string,
  discovered?: ModelThinkingCapabilities | null,
): MainAgentThinkingLevel {
  const requested = normalizeMainAgentThinkingLevel(value);
  const options = getModelThinkingOptions(provider, modelName, discovered);
  if (options.some(option => option.id === requested)) return requested;
  return options.find(option => option.id === 'medium')?.id
    || options.find(option => option.id === 'low')?.id
    || options[0]?.id
    || requested;
}

/** Provider adapters use this to turn the persisted level into API values. */
export function toOpenAIReasoningEffort(level: MainAgentThinkingLevel): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  if (level === 'off') return 'none';
  if (level === 'max') return 'xhigh';
  return level === 'minimal' || level === 'low' || level === 'medium' || level === 'high' || level === 'xhigh'
    ? level
    : 'medium';
}

export function toMistralReasoningEffort(level: MainAgentThinkingLevel): 'none' | 'high' {
  return level === 'high' ? 'high' : 'none';
}

export function toAnthropicEffort(level: MainAgentThinkingLevel): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (level === 'minimal' || level === 'off') return 'low';
  return level === 'low' || level === 'medium' || level === 'high' || level === 'xhigh' || level === 'max'
    ? level
    : 'medium';
}

export function getAnthropicThinkingBudget(level: MainAgentThinkingLevel): number {
  switch (level) {
    case 'off': return 0;
    case 'minimal': return 1024;
    case 'low': return 2048;
    case 'medium': return 4096;
    case 'high': return 8192;
    case 'xhigh': return 16384;
    case 'max': return 32768;
  }
}

export function isAnthropicAdaptiveThinkingModel(modelName: string): boolean {
  return /(?:claude-(?:fable|mythos|sonnet-5|opus-4-(?:6|7|8)))/i.test(modelName);
}

export function isOpenAIMiniReasoningModel(modelName: string): boolean {
  const name = modelName.toLowerCase();
  return name.includes('mini') && (name.includes('gpt-5') || name.includes('o3') || name.includes('o4') || name.includes('o1'));
}

export function normalizeMainAgentMode(value: unknown): MainAgentMode {
  if (typeof value !== 'string') return 'think';
  if (value in MAIN_AGENT_MODE_CONFIG) return value as MainAgentMode;
  return Object.values(MAIN_AGENT_MODE_CONFIG).find(o => o.modelName === value)?.id || 'think';
}

export function getMainAgentModelConfig(mode: unknown, runtimeSettings?: ScopedRuntimeSettings | null): MainAgentModelConfig {
  const normalized = normalizeMainAgentMode(mode);
  const base = MAIN_AGENT_MODE_CONFIG[normalized];
  return {
    ...base,
    modelName: resolveModelName(normalized, runtimeSettings),
  };
}

export function normalizeMainAgentThinkingLevel(value: unknown): MainAgentThinkingLevel {
  if (value === 'off' || value === 'none' || value === 'disabled') return 'off';
  if (value === 'minimal') return 'minimal';
  if (value === 'high' || value === 'enterprise' || value === 'extended') return 'high';
  if (value === 'xhigh' || value === 'extra-high' || value === 'extra_high') return 'xhigh';
  if (value === 'max' || value === 'full') return 'max';
  if (value === 'low' || value === 'minimal') return 'low';
  return 'medium';
}
