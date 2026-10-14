/**
 * ═══════════════════════════════════════════════════════════════
 * UNIVERSAL MODEL REGISTRY — API-Change Proof Routing
 * ═══════════════════════════════════════════════════════════════
 *
 * NEVER hardcode model names. All model resolution goes through here.
 * If Google/Mistral renames a model, you only change .env.local — zero code changes.
 *
 * User turns must carry a concrete model selected from a live provider
 * catalog. Environment/scoped overrides remain for explicit automation
 * configuration; this module never invents or substitutes a model id.
 */

import {
  getRuntimeModelOverrides,
  getScopedModelOverride,
  type ScopedRuntimeSettings,
} from './runtime-api-keys';
import { getDocumentedThinkingCapabilities } from './model-thinking-contracts';
export { getDocumentedThinkingCapabilities } from './model-thinking-contracts';
// Compatibility export for existing callers; this no longer guesses support.
export { getDocumentedThinkingCapabilities as inferModelThinkingCapabilities } from './model-thinking-contracts';

export type MainAgentProvider =
  | 'gemini' | 'mistral' | 'openai' | 'openrouter' | 'anthropic' | 'groq'
  | 'deepseek' | 'grok' | 'cerebras' | 'together' | 'fireworks' | 'sambanova'
  | 'perplexity' | 'deepinfra' | 'huggingface' | 'nvidia' | 'cloudflare'
  | 'ollama' | 'lmstudio' | 'vllm' | 'llamacpp' | 'novita' | 'qwen'
  | 'mimo' | 'tokenhub' | 'zai' | 'kimi' | 'stepfun' | 'minimax'
  | 'ollamacloud' | 'arcee' | 'gmi' | 'kilo' | 'opencode' | 'upstage' | 'custom';
export type MainAgentMode = 'think' | 'fast' | Exclude<MainAgentProvider, 'gemini'>;
/**
 * A provider-neutral value persisted by the composer.  Individual providers
 * expose only the values that their selected model actually accepts.
 */
export type MainAgentThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ModelThinkingOption = {
  id: MainAgentThinkingLevel;
  label: string;
};

export type ModelThinkingParameter =
  | 'thinkingLevel'
  | 'thinkingBudget'
  | 'thinking_level'
  | 'thinking_budget'
  | 'thinking.type'
  | 'enable_thinking'
  | 'reasoning.enabled'
  | 'chat_template_kwargs.enable_thinking'
  | 'chat_template_kwargs.thinking'
  | 'reasoning_effort'
  | 'reasoning'
  | 'thinking.budget_tokens'
  | 'chat_template_kwargs.reasoning_effort'
  | 'output_config.effort';

/** Capability metadata returned by a provider's live model catalog. */
export type ModelThinkingCapabilities = {
  provider?: MainAgentProvider;
  modelId?: string;
  updatedAt?: number;
  levels: MainAgentThinkingLevel[];
  defaultLevel?: MainAgentThinkingLevel;
  parameter?: ModelThinkingParameter;
  wireValues?: Partial<Record<MainAgentThinkingLevel, string>>;
  kind?: 'toggle' | 'effort' | 'budget';
  /** Some APIs require a separate switch as well as an effort value. */
  toggleParameter?: 'thinking.type' | 'enable_thinking' | 'reasoning.enabled' | 'chat_template_kwargs.enable_thinking';
  /** Omit the effort field for these levels (for example, provider-default On). */
  omitLevels?: MainAgentThinkingLevel[];
  source?: 'provider' | 'documented' | 'inferred';
};

export type MainAgentModelConfig = {
  id: MainAgentMode;
  provider: MainAgentProvider;
  label: string;
  compactLabel: string;
  modelName: string;
  selectable: boolean;
};

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
 * Reads only explicit scoped or environment configuration. A previously
 * successful model is telemetry, never an implicit selection.
 */
export function resolveModelName(mode: MainAgentMode, runtimeSettings?: ScopedRuntimeSettings | null): string {
  const overrides = getRuntimeModelOverrides();
  if (!['think', 'fast', 'mistral', 'openai', 'openrouter', 'anthropic', 'groq'].includes(mode)) {
    const provider = mode as MainAgentProvider;
    const scopedOverride = getScopedModelOverride(runtimeSettings, provider);
    if (scopedOverride) return scopedOverride;
    if (overrides[provider]) return overrides[provider];
    return '';
  }
  switch (mode) {
    case 'think': {
      const scopedOverride = getScopedModelOverride(runtimeSettings, 'gemini');
      if (scopedOverride) return scopedOverride;
      if (overrides.gemini) return overrides.gemini;
      return '';
    }
    case 'fast': {
      const scopedOverride = getScopedModelOverride(runtimeSettings, 'gemini');
      if (scopedOverride) return scopedOverride;
      if (overrides.gemini) return overrides.gemini;
      return '';
    }
    case 'mistral': {
      const scopedOverride = getScopedModelOverride(runtimeSettings, 'mistral');
      if (scopedOverride) return scopedOverride;
      if (overrides.mistral) return overrides.mistral;
      return '';
    }
    case 'openai': {
      const scopedOverride = getScopedModelOverride(runtimeSettings, 'openai');
      if (scopedOverride) return scopedOverride;
      if (overrides.openai) return overrides.openai;
      return '';
    }
    case 'openrouter': {
      const scopedOverride = getScopedModelOverride(runtimeSettings, 'openrouter');
      if (scopedOverride) return scopedOverride;
      if (overrides.openrouter) return overrides.openrouter;
      return '';
    }
    case 'anthropic': {
      const scopedOverride = getScopedModelOverride(runtimeSettings, 'anthropic');
      if (scopedOverride) return scopedOverride;
      if (overrides.anthropic) return overrides.anthropic;
      return '';
    }
    case 'groq': {
      const scopedOverride = getScopedModelOverride(runtimeSettings, 'groq');
      if (scopedOverride) return scopedOverride;
      if (overrides.groq) return overrides.groq;
      return '';
    }
    default:
      return '';
  }
}

// ─── Static mode config (display labels etc.) ────────────────────────────────

export const MAIN_AGENT_MODE_CONFIG: Record<MainAgentMode, MainAgentModelConfig> = {
  think: {
    id: 'think',
    provider: 'gemini',
    label: 'Gemini (Think)',
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
    label: 'Mistral AI',
    compactLabel: 'Mistral',
    get modelName() { return resolveModelName('mistral'); },
    selectable: true,
  },
  openai: {
    id: 'openai',
    provider: 'openai',
    label: 'OpenAI',
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
    label: 'Anthropic Claude',
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
  deepseek: { id: 'deepseek', provider: 'deepseek', label: 'DeepSeek', compactLabel: 'DeepSeek', get modelName() { return resolveModelName('deepseek'); }, selectable: true },
  grok: { id: 'grok', provider: 'grok', label: 'xAI Grok', compactLabel: 'Grok', get modelName() { return resolveModelName('grok'); }, selectable: true },
  cerebras: { id: 'cerebras', provider: 'cerebras', label: 'Cerebras', compactLabel: 'Cerebras', get modelName() { return resolveModelName('cerebras'); }, selectable: true },
  together: { id: 'together', provider: 'together', label: 'Together AI', compactLabel: 'Together', get modelName() { return resolveModelName('together'); }, selectable: true },
  fireworks: { id: 'fireworks', provider: 'fireworks', label: 'Fireworks AI', compactLabel: 'Fireworks', get modelName() { return resolveModelName('fireworks'); }, selectable: true },
  sambanova: { id: 'sambanova', provider: 'sambanova', label: 'SambaNova', compactLabel: 'SambaNova', get modelName() { return resolveModelName('sambanova'); }, selectable: true },
  perplexity: { id: 'perplexity', provider: 'perplexity', label: 'Perplexity', compactLabel: 'Perplexity', get modelName() { return resolveModelName('perplexity'); }, selectable: true },
  deepinfra: { id: 'deepinfra', provider: 'deepinfra', label: 'DeepInfra', compactLabel: 'DeepInfra', get modelName() { return resolveModelName('deepinfra'); }, selectable: true },
  huggingface: { id: 'huggingface', provider: 'huggingface', label: 'Hugging Face', compactLabel: 'HF', get modelName() { return resolveModelName('huggingface'); }, selectable: true },
  nvidia: { id: 'nvidia', provider: 'nvidia', label: 'NVIDIA NIM', compactLabel: 'NVIDIA', get modelName() { return resolveModelName('nvidia'); }, selectable: true },
  cloudflare: { id: 'cloudflare', provider: 'cloudflare', label: 'Cloudflare Workers AI', compactLabel: 'Cloudflare', get modelName() { return resolveModelName('cloudflare'); }, selectable: true },
  ollama: { id: 'ollama', provider: 'ollama', label: 'Ollama Local', compactLabel: 'Ollama', get modelName() { return resolveModelName('ollama'); }, selectable: true },
  lmstudio: { id: 'lmstudio', provider: 'lmstudio', label: 'LM Studio Local', compactLabel: 'LM Studio', get modelName() { return resolveModelName('lmstudio'); }, selectable: true },
  vllm: { id: 'vllm', provider: 'vllm', label: 'vLLM Local', compactLabel: 'vLLM', get modelName() { return resolveModelName('vllm'); }, selectable: true },
  llamacpp: { id: 'llamacpp', provider: 'llamacpp', label: 'llama.cpp Local', compactLabel: 'llama.cpp', get modelName() { return resolveModelName('llamacpp'); }, selectable: true },
  novita: { id: 'novita', provider: 'novita', label: 'Novita AI', compactLabel: 'Novita', get modelName() { return resolveModelName('novita'); }, selectable: true },
  qwen: { id: 'qwen', provider: 'qwen', label: 'Qwen Cloud', compactLabel: 'Qwen', get modelName() { return resolveModelName('qwen'); }, selectable: true },
  mimo: { id: 'mimo', provider: 'mimo', label: 'Xiaomi MiMo', compactLabel: 'MiMo', get modelName() { return resolveModelName('mimo'); }, selectable: true },
  tokenhub: { id: 'tokenhub', provider: 'tokenhub', label: 'Tencent TokenHub', compactLabel: 'TokenHub', get modelName() { return resolveModelName('tokenhub'); }, selectable: true },
  zai: { id: 'zai', provider: 'zai', label: 'Z.AI / GLM', compactLabel: 'GLM', get modelName() { return resolveModelName('zai'); }, selectable: true },
  kimi: { id: 'kimi', provider: 'kimi', label: 'Kimi / Moonshot', compactLabel: 'Kimi', get modelName() { return resolveModelName('kimi'); }, selectable: true },
  stepfun: { id: 'stepfun', provider: 'stepfun', label: 'StepFun Step Plan', compactLabel: 'StepFun', get modelName() { return resolveModelName('stepfun'); }, selectable: true },
  minimax: { id: 'minimax', provider: 'minimax', label: 'MiniMax', compactLabel: 'MiniMax', get modelName() { return resolveModelName('minimax'); }, selectable: true },
  ollamacloud: { id: 'ollamacloud', provider: 'ollamacloud', label: 'Ollama Cloud', compactLabel: 'Ollama Cloud', get modelName() { return resolveModelName('ollamacloud'); }, selectable: true },
  arcee: { id: 'arcee', provider: 'arcee', label: 'Arcee AI', compactLabel: 'Arcee', get modelName() { return resolveModelName('arcee'); }, selectable: true },
  gmi: { id: 'gmi', provider: 'gmi', label: 'GMI Cloud', compactLabel: 'GMI', get modelName() { return resolveModelName('gmi'); }, selectable: true },
  kilo: { id: 'kilo', provider: 'kilo', label: 'Kilo Gateway', compactLabel: 'Kilo', get modelName() { return resolveModelName('kilo'); }, selectable: true },
  opencode: { id: 'opencode', provider: 'opencode', label: 'OpenCode Zen', compactLabel: 'OpenCode', get modelName() { return resolveModelName('opencode'); }, selectable: true },
  upstage: { id: 'upstage', provider: 'upstage', label: 'Upstage Solar', compactLabel: 'Upstage', get modelName() { return resolveModelName('upstage'); }, selectable: true },
  custom: { id: 'custom', provider: 'custom', label: 'Custom endpoint', compactLabel: 'Custom', get modelName() { return resolveModelName('custom'); }, selectable: true },
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

const normalizeAdvertisedThinkingLevel = (value: unknown): MainAgentThinkingLevel | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '-');
  if (['off', 'none', 'disabled', 'no-thinking'].includes(normalized)) return 'off';
  if (normalized === 'minimal' || normalized === 'min') return 'minimal';
  if (normalized === 'low') return 'low';
  if (normalized === 'medium' || normalized === 'med') return 'medium';
  if (['high', 'on', 'enabled', 'adaptive'].includes(normalized)) return 'high';
  if (normalized === 'xhigh' || normalized === 'extra-high') return 'xhigh';
  if (normalized === 'max' || normalized === 'maximum') return 'max';
  return null;
};

export const isOpenAIReasoningModel = (model: string) =>
  /(?:^|[/:_-])(?:o1|o3|o4)(?:$|[/:_-])|gpt-(?:[5-9]|[1-9]\d+)(?:[.-]|$)|gpt-oss/i.test(model);

/** Explicit live metadata wins, including an empty/unsupported contract. */
export function resolveModelThinkingCapabilities(
  provider: MainAgentProvider,
  modelName: string,
  discovered?: ModelThinkingCapabilities | null,
): ModelThinkingCapabilities | null {
  const live = normalizeModelThinkingCapabilities(discovered);
  if (live?.source === 'provider') {
    const canonicalId = (value: string) => provider === 'gemini' ? value.trim().replace(/^models\//, '') : value.trim();
    if ((live.provider && live.provider !== provider) || (live.modelId && canonicalId(live.modelId) !== canonicalId(modelName))) {
      return { levels: [], source: 'provider' };
    }
    return live;
  }
  // Never reuse old inferred lists or cached documentation after an update.
  return getDocumentedThinkingCapabilities(provider, modelName);
}

export function getModelThinkingOptions(
  provider: MainAgentProvider,
  modelName: string,
  discovered?: ModelThinkingCapabilities | null,
): ModelThinkingOption[] {
  const capability = resolveModelThinkingCapabilities(provider, modelName, discovered);
  if (!capability?.parameter) return [];
  return MAIN_AGENT_THINKING_LEVEL_OPTIONS.filter(option => capability.levels.includes(option.id)).flatMap(option => {
    const level = option.id;
    if (capability.wireValues?.[level] === 'default') return [{ ...option, label: 'On (provider default)' }];
    if (capability.kind === 'toggle' || ['enable_thinking', 'thinking.type', 'reasoning.enabled', 'chat_template_kwargs.enable_thinking', 'chat_template_kwargs.thinking'].includes(capability.parameter!)) return [{ ...option, label: level === 'off' ? 'Off' : 'On' }];
    if (capability.parameter === 'thinkingBudget' && level !== 'off') {
      const budget = level === 'low' ? 1024 : level === 'high' ? 24576 : 8192;
      return [{ ...option, label: `${option.label} (${budget.toLocaleString('en-US')} tokens)` }];
    }
    if (capability.parameter === 'thinking.budget_tokens' && level !== 'off') {
      return [{ ...option, label: `${option.label} (${getAnthropicThinkingBudget(level).toLocaleString('en-US')} tokens)` }];
    }
    return [option];
  });
}
export function doesModelSupportThinking(
  provider: MainAgentProvider,
  modelName: string,
  discovered?: ModelThinkingCapabilities | null,
): boolean {
  return getModelThinkingOptions(provider, modelName, discovered).length > 0;
}

/**
 * Build the Gemini thinking config for the selected model family.
 * Gemini 3 uses thinkingLevel; Gemini 2.5 uses thinkingBudget.
 */
export function getGeminiThinkingConfig(
  level: MainAgentThinkingLevel,
  modelName: string,
  includeThoughts: boolean,
  discovered?: ModelThinkingCapabilities | null,
): Record<string, unknown> | null {
  const model = String(modelName || '').toLowerCase();
  const options = getModelThinkingOptions('gemini', model, discovered);
  if (!options.length) return null;
  level = normalizeThinkingLevelForModel(level, 'gemini', model, discovered);

  const parameter = resolveModelThinkingCapabilities('gemini', model, discovered)?.parameter;

  if (parameter === 'thinkingBudget') {
    if (level === 'off') return { thinkingBudget: 0, includeThoughts };
    const thinkingBudget = level === 'low' ? 1024 : level === 'high' ? 24576 : 8192;
    return { thinkingBudget, includeThoughts };
  }

  if (parameter !== 'thinkingLevel') return null;
  return { thinkingLevel: resolveModelThinkingCapabilities('gemini', model, discovered)?.wireValues?.[level] ?? level, includeThoughts };
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
    .map(level => normalizeAdvertisedThinkingLevel(level))
    .filter((level): level is MainAgentThinkingLevel => Boolean(level))));
  // An explicitly empty list means unsupported, not missing metadata.
  if (levels.length === 0 && !Array.isArray(source.levels) && !Array.isArray(source.supported_efforts) && !Array.isArray(source.supportedThinkingLevels)) return null;

  const rawDefault = source.defaultLevel ?? source.default_effort ?? source.defaultThinkingLevel;
  const defaultLevel = rawDefault === undefined ? undefined : normalizeAdvertisedThinkingLevel(rawDefault);
  const parameter = source.parameter === 'thinkingLevel' || source.parameter === 'thinkingBudget' || source.parameter === 'thinking_level' || source.parameter === 'thinking_budget' || source.parameter === 'thinking.type' || source.parameter === 'enable_thinking' || source.parameter === 'reasoning.enabled' || source.parameter === 'chat_template_kwargs.enable_thinking' || source.parameter === 'chat_template_kwargs.thinking' || source.parameter === 'reasoning_effort' || source.parameter === 'reasoning' || source.parameter === 'output_config.effort' || source.parameter === 'thinking.budget_tokens' || source.parameter === 'chat_template_kwargs.reasoning_effort'
    ? source.parameter
    : undefined;
  const sourceKind = source.source === 'inferred' ? 'inferred' : source.source === 'documented' ? 'documented' : 'provider';
  const wireValues = source.wireValues && typeof source.wireValues === 'object'
    ? Object.fromEntries(Object.entries(source.wireValues).filter(([key, value]) => levels.includes(key as MainAgentThinkingLevel) && typeof value === 'string'))
    : undefined;
  const provider = typeof source.provider === 'string' && Object.values(MAIN_AGENT_MODE_CONFIG).some(config => config.provider === source.provider)
    ? source.provider as MainAgentProvider : undefined;
  const modelId = typeof source.modelId === 'string' ? source.modelId.trim() : undefined;
  const kind = source.kind === 'toggle' || source.kind === 'effort' || source.kind === 'budget' ? source.kind : undefined;
  const toggleParameter = source.toggleParameter === 'thinking.type' || source.toggleParameter === 'enable_thinking' || source.toggleParameter === 'reasoning.enabled' || source.toggleParameter === 'chat_template_kwargs.enable_thinking' ? source.toggleParameter : undefined;
  const omitLevels = Array.isArray(source.omitLevels) ? levels.filter(level => (source.omitLevels as unknown[]).includes(level)) : undefined;
  const updatedAt = typeof source.updatedAt === 'number' && Number.isFinite(source.updatedAt) ? source.updatedAt : undefined;
  return { levels, ...(provider ? { provider } : {}), ...(modelId ? { modelId } : {}), ...(updatedAt ? { updatedAt } : {}), ...(defaultLevel && levels.includes(defaultLevel) ? { defaultLevel } : {}), ...(parameter ? { parameter } : {}), ...(wireValues ? { wireValues } : {}), ...(kind ? { kind } : {}), ...(toggleParameter ? { toggleParameter } : {}), ...(omitLevels ? { omitLevels } : {}), source: sourceKind };
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
  const capability = resolveModelThinkingCapabilities(provider, modelName, discovered);
  const options = getModelThinkingOptions(provider, modelName, discovered);
  if (options.some(option => option.id === requested)) return requested;
  return (capability?.defaultLevel && options.some(option => option.id === capability.defaultLevel) ? capability.defaultLevel : undefined)
    || options.find(option => option.id === 'medium')?.id
    || options.find(option => option.id === 'low')?.id
    || options.find(option => option.id !== 'off')?.id
    || options[0]?.id
    || 'off';
}

/** Provider adapters use this to turn the persisted level into API values. */
export function toOpenAIReasoningEffort(level: MainAgentThinkingLevel): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (level === 'off') return 'none';
  return level === 'minimal' || level === 'low' || level === 'medium' || level === 'high' || level === 'xhigh' || level === 'max'
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

export function isAnthropicAdaptiveThinkingModel(modelName: string, discovered?: ModelThinkingCapabilities | null): boolean {
  const capability = resolveModelThinkingCapabilities('anthropic', modelName, discovered);
  return capability?.parameter === 'output_config.effort' && !/claude-opus-4[.-]5(?:[.-]|$)/i.test(modelName);
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
  if (value === 'low') return 'low';
  return 'medium';
}
