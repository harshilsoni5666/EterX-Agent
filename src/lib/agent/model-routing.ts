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

import { getRuntimeModelOverrides } from './runtime-api-keys';

export type MainAgentProvider = 'gemini' | 'mistral' | 'openai' | 'openrouter' | 'anthropic' | 'groq';
export type MainAgentMode = 'think' | 'fast' | 'mistral' | 'openai' | 'openrouter' | 'anthropic' | 'groq';
export type MainAgentThinkingLevel = 'low' | 'high';

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
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
];

export const GEMINI_FAST_FALLBACK_CHAIN: readonly string[] = [
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];

export const MISTRAL_FALLBACK_CHAIN: readonly string[] = [
  'mistral-medium-3-5',
  'mistral-small-2603',
  'mistral-large-2512',
  'ministral-14b-2512',
  'ministral-8b-2512',
];

export const OPENAI_FALLBACK_CHAIN: readonly string[] = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
];

export const OPENROUTER_FALLBACK_CHAIN: readonly string[] = [
  'openai/gpt-5.5',
  'openai/gpt-5.4',
  'anthropic/claude-opus-4.8',
  'anthropic/claude-sonnet-4.6',
  'google/gemini-3.5-flash',
  'google/gemini-3-flash-preview',
  'mistralai/mistral-medium-3-5',
];

export const ANTHROPIC_FALLBACK_CHAIN: readonly string[] = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-7',
];

export const GROQ_FALLBACK_CHAIN: readonly string[] = [
  'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile',
  'groq/compound',
  'groq/compound-mini',
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
export function resolveModelName(mode: MainAgentMode): string {
  const overrides = getRuntimeModelOverrides();
  switch (mode) {
    case 'think': {
      if (overrides.gemini) return overrides.gemini;
      return getProvenModel('think') || GEMINI_THINK_FALLBACK_CHAIN[0];
    }
    case 'fast': {
      if (overrides.gemini) return overrides.gemini;
      return getProvenModel('fast') || GEMINI_FAST_FALLBACK_CHAIN[0];
    }
    case 'mistral': {
      if (overrides.mistral) return overrides.mistral;
      return getProvenModel('mistral') || MISTRAL_FALLBACK_CHAIN[0];
    }
    case 'openai': {
      if (overrides.openai) return overrides.openai;
      return getProvenModel('openai') || OPENAI_FALLBACK_CHAIN[0];
    }
    case 'openrouter': {
      if (overrides.openrouter) return overrides.openrouter;
      return getProvenModel('openrouter') || OPENROUTER_FALLBACK_CHAIN[0];
    }
    case 'anthropic': {
      if (overrides.anthropic) return overrides.anthropic;
      return getProvenModel('anthropic') || ANTHROPIC_FALLBACK_CHAIN[0];
    }
    case 'groq': {
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
export function getFallbackChain(mode: MainAgentMode): string[] {
  const primary = resolveModelName(mode);
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
    label: 'GPT-5.5',
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
    label: 'Claude Opus 4.8',
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

export const MAIN_AGENT_THINKING_LEVEL_OPTIONS: Array<{ id: MainAgentThinkingLevel; label: string }> = [
  { id: 'low', label: 'Low' },
  { id: 'high', label: 'High' },
];

export function normalizeMainAgentMode(value: unknown): MainAgentMode {
  if (typeof value !== 'string') return 'think';
  if (value in MAIN_AGENT_MODE_CONFIG) return value as MainAgentMode;
  return Object.values(MAIN_AGENT_MODE_CONFIG).find(o => o.modelName === value)?.id || 'think';
}

export function getMainAgentModelConfig(mode: unknown): MainAgentModelConfig {
  return MAIN_AGENT_MODE_CONFIG[normalizeMainAgentMode(mode)];
}

export function normalizeMainAgentThinkingLevel(value: unknown): MainAgentThinkingLevel {
  if (value === 'high' || value === 'enterprise' || value === 'extended') return 'high';
  return 'low';
}
