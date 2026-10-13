import type { MainAgentMode, MainAgentProvider } from './model-routing';

export type ModelSelectorEntry = {
  provider: MainAgentProvider;
  modelId: string;
};

export const MODEL_OVERRIDE_STORAGE_KEY = 'eterx_model_overrides';
export const MODEL_CATALOG_STORAGE_KEY = 'eterx_model_catalog';
export const MODEL_SELECTOR_STORAGE_KEY = 'eterx_model_selector_entries';
export const MODEL_SELECTOR_SCHEMA_STORAGE_KEY = 'eterx_model_selector_schema';
export const MODEL_SELECTOR_SCHEMA_VERSION = '2';
// v3 also replaces incomplete provider metadata with native catalogs and schemas.
export const MODEL_THINKING_CAPABILITIES_STORAGE_KEY = 'eterx_model_thinking_capabilities_v3';
export const MODEL_WIRE_CAPABILITIES_STORAGE_KEY = 'eterx_model_wire_capabilities';
export const MODEL_THINKING_LEVELS_STORAGE_KEY = 'eterx-model-thinking-levels';
export const MODEL_CONTEXT_WINDOWS_STORAGE_KEY = 'eterx_model_context_windows';
export const MODEL_API_KEYS_STORAGE_KEY = 'eterx_model_api_keys';
export const API_KEY_PRESENCE_STORAGE_KEY = 'eterx_api_key_presence';
export const MODEL_API_KEY_PRESENCE_STORAGE_KEY = 'eterx_model_api_key_presence';
export const CHAT_MODEL_SELECTION_STORAGE_KEY = 'eterx_chat_model_selection';
export const CHAT_CONTEXT_WINDOW_OVERRIDES_STORAGE_KEY = 'eterx_chat_context_window_overrides';
// Legacy symbol name retained to avoid a storage-schema break. Its value is
// an empty selection, never a provider model id and never an automatic route.
export const AUTO_MODEL_SELECTION = '';

// This was an old display-only placeholder, not a provider model id. Keep it
// out of every selector/catalog migration so it cannot reappear from folder
// preferences or legacy browser settings.
export const isEmbeddedModelLabel = (value: unknown) =>
  String(value || '').trim().toLowerCase() === 'gemini 3.6 flash';

/** Provider model catalogs must contain concrete model IDs, never router/default placeholders. */
export const isConcreteModelId = (value: unknown) => {
  const id = String(value || '').trim().toLowerCase();
  return Boolean(id)
    && id !== AUTO_MODEL_SELECTION
    && id !== 'openrouter/auto'
    && !id.startsWith('kilo-auto/')
    && !/^(auto|default|latest|recommended)(?:[\s_-]|$)/i.test(id);
};

export const MODEL_PROVIDER_ORDER: MainAgentProvider[] = [
  'gemini', 'openai', 'anthropic', 'mistral', 'openrouter', 'groq',
  'deepseek', 'grok', 'cerebras', 'together', 'fireworks', 'sambanova',
  'perplexity', 'deepinfra', 'huggingface', 'nvidia', 'cloudflare',
  'ollama', 'lmstudio', 'vllm', 'llamacpp',
  'novita', 'qwen', 'mimo', 'tokenhub', 'zai', 'kimi', 'stepfun', 'minimax',
  'ollamacloud', 'arcee', 'gmi', 'kilo', 'opencode', 'upstage', 'custom',
];

export const MODEL_PROVIDER_MODE: Record<MainAgentProvider, MainAgentMode> = {
  gemini: 'think',
  mistral: 'mistral',
  openai: 'openai',
  openrouter: 'openrouter',
  groq: 'groq',
  anthropic: 'anthropic',
  deepseek: 'deepseek',
  grok: 'grok',
  cerebras: 'cerebras',
  together: 'together',
  fireworks: 'fireworks',
  sambanova: 'sambanova',
  perplexity: 'perplexity',
  deepinfra: 'deepinfra',
  huggingface: 'huggingface',
  nvidia: 'nvidia',
  cloudflare: 'cloudflare',
  ollama: 'ollama',
  lmstudio: 'lmstudio',
  vllm: 'vllm',
  llamacpp: 'llamacpp',
  novita: 'novita',
  qwen: 'qwen',
  mimo: 'mimo',
  tokenhub: 'tokenhub',
  zai: 'zai',
  kimi: 'kimi',
  stepfun: 'stepfun',
  minimax: 'minimax',
  ollamacloud: 'ollamacloud',
  arcee: 'arcee',
  gmi: 'gmi',
  kilo: 'kilo',
  opencode: 'opencode',
  upstage: 'upstage',
  custom: 'custom',
};

export const isModelProvider = (value: unknown): value is MainAgentProvider =>
  typeof value === 'string' && (MODEL_PROVIDER_ORDER as string[]).includes(value);

export const modelEntryKey = (provider: MainAgentProvider | string, modelId: string) =>
  `${String(provider).trim()}:${encodeURIComponent(String(modelId || '').trim())}`;

export const parseModelEntryKey = (value: unknown): ModelSelectorEntry | null => {
  if (typeof value !== 'string' || value === AUTO_MODEL_SELECTION) return null;
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const provider = value.slice(0, separator).trim();
  if (!isModelProvider(provider)) return null;
  const encodedModel = value.slice(separator + 1).trim();
  if (!encodedModel) return null;
  try {
    const modelId = decodeURIComponent(encodedModel).trim();
    return modelId && !isEmbeddedModelLabel(modelId) && isConcreteModelId(modelId) ? { provider, modelId } : null;
  } catch {
    return null;
  }
};

const normalizeLegacyCatalog = (raw: unknown): ModelSelectorEntry[] => {
  if (!raw || typeof raw !== 'object') return [];
  const source = raw as Record<string, unknown>;
  const entries: ModelSelectorEntry[] = [];

  MODEL_PROVIDER_ORDER.forEach(provider => {
    const value = source[provider];
    const models = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(/[\n,]/)
        : [];

    models
      .map(model => String(model || '').trim())
      .filter(Boolean)
      .forEach(modelId => entries.push({ provider, modelId }));
  });

  return entries;
};

export const normalizeModelSelectorEntries = (raw: unknown, legacyCatalog?: unknown): ModelSelectorEntry[] => {
  const sourceEntries: ModelSelectorEntry[] = [];
  const hasExplicitSelectorList = Array.isArray(raw);

  if (Array.isArray(raw)) {
    raw.forEach(item => {
      if (typeof item === 'string') {
        const parsed = parseModelEntryKey(item);
        if (parsed) sourceEntries.push(parsed);
        return;
      }
      if (!item || typeof item !== 'object') return;
      const source = item as Record<string, unknown>;
      const provider = String(source.provider || '').trim();
      const modelId = String(source.modelId || source.model || source.id || '').trim();
      if (isModelProvider(provider) && isConcreteModelId(modelId)) sourceEntries.push({ provider, modelId });
    });
  }

  const usableSourceEntries = sourceEntries.filter(entry => !isEmbeddedModelLabel(entry.modelId) && isConcreteModelId(entry.modelId));
  if (usableSourceEntries.length === 0 && !hasExplicitSelectorList) {
    usableSourceEntries.push(...normalizeLegacyCatalog(legacyCatalog).filter(entry => !isEmbeddedModelLabel(entry.modelId) && isConcreteModelId(entry.modelId)));
  }

  const seen = new Set<string>();
  return usableSourceEntries.filter(entry => {
    const key = modelEntryKey(entry.provider, entry.modelId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const entriesToModelCatalog = (entries: ModelSelectorEntry[]) =>
  entries.reduce((catalog, entry) => {
    const current = catalog[entry.provider] || [];
    if (!current.includes(entry.modelId)) catalog[entry.provider] = [...current, entry.modelId];
    return catalog;
  }, {} as Partial<Record<MainAgentProvider, string[]>>);

export const ensureModelSelectorEntry = (
  entries: ModelSelectorEntry[],
  provider: MainAgentProvider,
  modelId: string,
) => {
  const cleanModel = String(modelId || '').trim();
  if (!isConcreteModelId(cleanModel)) return entries;
  if (!cleanModel) return entries;
  const key = modelEntryKey(provider, cleanModel);
  if (entries.some(entry => modelEntryKey(entry.provider, entry.modelId) === key)) return entries;
  return [...entries, { provider, modelId: cleanModel }];
};

export const removeModelSelectorEntry = (
  entries: ModelSelectorEntry[],
  provider: MainAgentProvider,
  modelId: string,
) => {
  const key = modelEntryKey(provider, modelId);
  return entries.filter(entry => modelEntryKey(entry.provider, entry.modelId) !== key);
};

export const splitStoredKeyPool = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(item => splitStoredKeyPool(item));
  if (typeof value !== 'string') return [];
  return value.split(/[\n,]/).map(item => item.trim()).filter(Boolean);
};

export const composeApiKeysForSelection = (
  baseApiKeys: Record<string, string>,
  modelApiKeys: Record<string, string>,
  entries: ModelSelectorEntry[],
  selectionKey: string = AUTO_MODEL_SELECTION,
) => {
  const next: Record<string, string> = { ...baseApiKeys };
  const selectedEntry = parseModelEntryKey(selectionKey);

  if (!selectedEntry) return next;

  const selectedKey = modelEntryKey(selectedEntry.provider, selectedEntry.modelId);
  const selectedPool = modelApiKeys[selectedKey];
  if (selectedPool?.trim()) next[selectedEntry.provider] = selectedPool.trim();
  return next;
};

/**
 * Builds one server-side credential snapshot for every model that can be used
 * during a run. The first selection remains preferred, while model-specific
 * pools for secondary services (for example context compaction) are retained.
 * Keys are deduplicated without exposing model-key mappings to the run request.
 */
export const composeApiKeysForSelections = (
  baseApiKeys: Record<string, string>,
  modelApiKeys: Record<string, string>,
  entries: ModelSelectorEntry[],
  selectionKeys: string[],
) => {
  const selectedByProvider = new Map<MainAgentProvider, string[]>();

  selectionKeys.forEach(selectionKey => {
    const selectedEntry = parseModelEntryKey(selectionKey);
    if (!selectedEntry) return;
    const selectedPool = splitStoredKeyPool(modelApiKeys[modelEntryKey(selectedEntry.provider, selectedEntry.modelId)]);
    if (selectedPool.length === 0) return;
    selectedByProvider.set(
      selectedEntry.provider,
      [...(selectedByProvider.get(selectedEntry.provider) || []), ...selectedPool],
    );
  });

  const providers = new Set<string>([
    ...Object.keys(baseApiKeys),
    ...selectedByProvider.keys(),
  ]);
  const composed: Record<string, string> = {};
  providers.forEach(provider => {
    const values = [
      ...(isModelProvider(provider) ? selectedByProvider.get(provider) || [] : []),
      ...splitStoredKeyPool(baseApiKeys[provider]),
    ];
    const uniqueValues = Array.from(new Set(values));
    if (uniqueValues.length > 0) composed[provider] = uniqueValues.join('\n');
  });
  return composed;
};

