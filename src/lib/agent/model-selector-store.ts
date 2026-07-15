import type { MainAgentMode, MainAgentProvider } from './model-routing';

export type ModelSelectorEntry = {
  provider: MainAgentProvider;
  modelId: string;
};

export const MODEL_OVERRIDE_STORAGE_KEY = 'eterx_model_overrides';
export const MODEL_CATALOG_STORAGE_KEY = 'eterx_model_catalog';
export const MODEL_SELECTOR_STORAGE_KEY = 'eterx_model_selector_entries';
export const MODEL_THINKING_CAPABILITIES_STORAGE_KEY = 'eterx_model_thinking_capabilities';
export const MODEL_API_KEYS_STORAGE_KEY = 'eterx_model_api_keys';
export const CHAT_MODEL_SELECTION_STORAGE_KEY = 'eterx_chat_model_selection';
export const AUTO_MODEL_SELECTION = 'auto';

export const MODEL_PROVIDER_ORDER: MainAgentProvider[] = ['gemini', 'mistral', 'openai', 'openrouter', 'groq', 'anthropic'];

export const MODEL_PROVIDER_MODE: Record<MainAgentProvider, MainAgentMode> = {
  gemini: 'think',
  mistral: 'mistral',
  openai: 'openai',
  openrouter: 'openrouter',
  groq: 'groq',
  anthropic: 'anthropic',
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
    return modelId ? { provider, modelId } : null;
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
      if (isModelProvider(provider) && modelId) sourceEntries.push({ provider, modelId });
    });
  }

  if (sourceEntries.length === 0) {
    sourceEntries.push(...normalizeLegacyCatalog(legacyCatalog));
  }

  const seen = new Set<string>();
  return sourceEntries.filter(entry => {
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
  const selectedEntry = parseModelEntryKey(selectionKey)
    || (selectionKey === AUTO_MODEL_SELECTION ? pickAutoModelEntry(entries, baseApiKeys, modelApiKeys) : null);

  if (!selectedEntry) return next;

  const selectedKey = modelEntryKey(selectedEntry.provider, selectedEntry.modelId);
  const selectedPool = modelApiKeys[selectedKey];
  if (selectedPool?.trim()) next[selectedEntry.provider] = selectedPool.trim();
  return next;
};

export const pickAutoModelEntry = (
  entries: ModelSelectorEntry[],
  apiKeys: Record<string, string>,
  modelApiKeys: Record<string, string>,
) => {
  return entries.find(entry => splitStoredKeyPool(modelApiKeys[modelEntryKey(entry.provider, entry.modelId)]).length > 0)
    || entries.find(entry => splitStoredKeyPool(apiKeys[entry.provider]).length > 0)
    || entries[0]
    || null;
};
