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

export type MainAgentProvider = 'gemini' | 'mistral' | 'openrouter';
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

// ─── Static fallback chains (newest → oldest stable) ─────────────────────────
// These are tried IN ORDER when the primary model fails with a model-not-found error.
export const GEMINI_THINK_FALLBACK_CHAIN: readonly string[] = [
  'gemini-2.5-flash-preview-05-20',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
];

export const GEMINI_FAST_FALLBACK_CHAIN: readonly string[] = [
  'gemini-2.5-flash-preview-05-20',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
];

export const MISTRAL_FALLBACK_CHAIN: readonly string[] = [
  'devstral-2512',
  'devstral-latest',
  'mistral-large-latest',
  'open-mistral-7b',
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
  switch (mode) {
    case 'think': {
      const envOverride = process.env.ETERX_THINK_MODEL || process.env.GEMINI_THINK_MODEL;
      if (envOverride) return envOverride.trim();
      return getProvenModel('think') || GEMINI_THINK_FALLBACK_CHAIN[0];
    }
    case 'fast': {
      const envOverride = process.env.ETERX_FAST_MODEL || process.env.GEMINI_FAST_MODEL;
      if (envOverride) return envOverride.trim();
      return getProvenModel('fast') || GEMINI_FAST_FALLBACK_CHAIN[0];
    }
    case 'mistral': {
      const envOverride = process.env.MISTRAL_MODEL || process.env.MISTRAL_MODEL_NAME;
      if (envOverride) return envOverride.trim();
      return getProvenModel('mistral') || MISTRAL_FALLBACK_CHAIN[0];
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
    label: 'Mistral Devstral',
    compactLabel: 'Mistral',
    get modelName() { return resolveModelName('mistral'); },
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
