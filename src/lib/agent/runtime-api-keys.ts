import { apiKeyPool } from './api-key-pool';
import { DEFAULT_API_RETRIES, normalizeApiRetries } from './api-retry';

export type RuntimeApiKeyProvider =
  | 'gemini'
  | 'mistral'
  | 'openrouter'
  | 'anthropic'
  | 'openai'
  | 'groq'
  | 'deepseek'
  | 'grok'
  | 'cerebras'
  | 'together'
  | 'fireworks'
  | 'sambanova'
  | 'perplexity'
  | 'deepinfra'
  | 'huggingface'
  | 'nvidia'
  | 'cloudflare'
  | 'ollama'
  | 'lmstudio'
  | 'vllm'
  | 'llamacpp'
  | 'novita'
  | 'qwen'
  | 'mimo'
  | 'tokenhub'
  | 'zai'
  | 'kimi'
  | 'stepfun'
  | 'minimax'
  | 'ollamacloud'
  | 'arcee'
  | 'gmi'
  | 'kilo'
  | 'opencode'
  | 'upstage'
  | 'custom'
  | 'tavily'
  | 'github';

export type RuntimeApiKeyPayload = Partial<Record<RuntimeApiKeyProvider, string | string[]>>;
export type RuntimeModelProvider = Exclude<RuntimeApiKeyProvider, 'tavily' | 'github'>;
export type RuntimeModelOverridePayload = Partial<Record<RuntimeModelProvider, string>>;

export type RuntimeApiKeyProviderStatus = {
  provider: RuntimeApiKeyProvider;
  accepted: boolean;
  count: number;
  reason?: string;
};

export type RuntimeApiKeyApplyResult = {
  acceptedCount: number;
  rejectedCount: number;
  providers: RuntimeApiKeyProviderStatus[];
  preferredGeminiApiKey?: string;
};

export type RuntimeModelOverrideStatus = {
  provider: RuntimeModelProvider;
  accepted: boolean;
  model?: string;
  reason?: string;
};

export type ScopedRuntimeSettings = {
  apiRetries: number;
  apiKeys: Record<RuntimeApiKeyProvider, string[]>;
  modelOverrides: Record<RuntimeModelProvider, string>;
  apiKeyResult: RuntimeApiKeyApplyResult;
  modelOverrideStatuses: RuntimeModelOverrideStatus[];
  preferredGeminiApiKey?: string;
};

const PROVIDERS: RuntimeApiKeyProvider[] = [
  'gemini',
  'mistral',
  'openrouter',
  'anthropic',
  'openai',
  'groq',
  'deepseek',
  'grok',
  'cerebras',
  'together',
  'fireworks',
  'sambanova',
  'perplexity',
  'deepinfra',
  'huggingface',
  'nvidia',
  'cloudflare',
  'ollama',
  'lmstudio',
  'vllm',
  'llamacpp',
  'novita',
  'qwen',
  'mimo',
  'tokenhub',
  'zai',
  'kimi',
  'stepfun',
  'minimax',
  'ollamacloud',
  'arcee',
  'gmi',
  'kilo',
  'opencode',
  'upstage',
  'custom',
  'tavily',
  'github',
];

const globalForRuntimeKeys = globalThis as typeof globalThis & {
  __eterxRuntimeApiKeys?: Record<RuntimeApiKeyProvider, string[]>;
  __eterxRuntimeApiKeyCursor?: Record<RuntimeApiKeyProvider, number>;
  __eterxRuntimeApiRetries?: number;
};

globalForRuntimeKeys.__eterxRuntimeApiRetries ??= DEFAULT_API_RETRIES;

const runtimeApiKeys: Record<RuntimeApiKeyProvider, string[]> =
  globalForRuntimeKeys.__eterxRuntimeApiKeys ||
  (globalForRuntimeKeys.__eterxRuntimeApiKeys = PROVIDERS.reduce((acc, provider) => {
    acc[provider] = [];
    return acc;
  }, {} as Record<RuntimeApiKeyProvider, string[]>));

const runtimeApiKeyCursor: Record<RuntimeApiKeyProvider, number> =
  globalForRuntimeKeys.__eterxRuntimeApiKeyCursor ||
  (globalForRuntimeKeys.__eterxRuntimeApiKeyCursor = PROVIDERS.reduce((acc, provider) => {
    acc[provider] = 0;
    return acc;
  }, {} as Record<RuntimeApiKeyProvider, number>));

const MODEL_PROVIDERS: RuntimeModelProvider[] = PROVIDERS.filter(
  (provider): provider is RuntimeModelProvider => provider !== 'tavily' && provider !== 'github',
);

const runtimeModelOverrides: Record<RuntimeModelProvider, string> =
  (globalThis as typeof globalThis & { __eterxRuntimeModelOverrides?: Record<RuntimeModelProvider, string> }).__eterxRuntimeModelOverrides ||
  ((globalThis as typeof globalThis & { __eterxRuntimeModelOverrides?: Record<RuntimeModelProvider, string> }).__eterxRuntimeModelOverrides = MODEL_PROVIDERS.reduce((acc, provider) => {
    acc[provider] = '';
    return acc;
  }, {} as Record<RuntimeModelProvider, string>));

const normalizeProvider = (value: string): RuntimeApiKeyProvider | null => {
  const provider = value.toLowerCase().trim();
  return (PROVIDERS as string[]).includes(provider) ? provider as RuntimeApiKeyProvider : null;
};

const normalizeModelProvider = (value: string): RuntimeModelProvider | null => {
  const provider = value.toLowerCase().trim();
  return (MODEL_PROVIDERS as string[]).includes(provider) ? provider as RuntimeModelProvider : null;
};

const splitKeyString = (value: string): string[] =>
  value
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(Boolean);

const normalizeKeyValues = (value: unknown): string[] => {
  if (typeof value === 'string') return splitKeyString(value);
  if (!Array.isArray(value)) return [];
  return value
    .flatMap(item => typeof item === 'string' ? splitKeyString(item) : [])
    .map(item => item.trim())
    .filter(Boolean);
};

const looksLikePlaceholder = (value: string): boolean => {
  const lower = value.toLowerCase();
  return lower.includes('your_') ||
    lower.includes('paste_') ||
    lower.includes('api_key_here') ||
    lower === 'test' ||
    lower === 'none';
};

const isValidProviderKey = (provider: RuntimeApiKeyProvider, key: string): boolean => {
  if (!key || looksLikePlaceholder(key)) return false;

  switch (provider) {
    case 'gemini':
      return key.startsWith('AIza') && key.length > 20;
    case 'openai':
      return key.length >= 20 && (key.startsWith('sk-') || key.startsWith('sess-'));
    case 'anthropic':
      return key.length >= 20 && key.startsWith('sk-ant-');
    case 'openrouter':
      return key.length >= 20 && (key.startsWith('sk-or-') || key.startsWith('sk-'));
    case 'groq':
      return key.length >= 20;
    case 'mistral':
      return key.length >= 16;
    case 'ollama':
    case 'lmstudio':
    case 'vllm':
    case 'llamacpp':
      return key.length >= 1;
    case 'deepseek':
    case 'grok':
    case 'cerebras':
    case 'together':
    case 'fireworks':
    case 'sambanova':
    case 'perplexity':
    case 'deepinfra':
    case 'huggingface':
    case 'nvidia':
    case 'cloudflare':
    case 'novita':
    case 'qwen':
    case 'mimo':
    case 'tokenhub':
    case 'zai':
    case 'kimi':
    case 'stepfun':
    case 'minimax':
    case 'ollamacloud':
    case 'arcee':
    case 'gmi':
    case 'kilo':
    case 'opencode':
    case 'upstage':
    case 'custom':
      return key.length >= 8;
    case 'tavily':
      return key.length >= 12;
    case 'github':
      return key.length >= 20;
    default:
      return false;
  }
};

export function getRuntimeModelOverrides(): Record<RuntimeModelProvider, string> {
  return { ...runtimeModelOverrides };

}

export function getRuntimeApiKeyValues(provider: RuntimeApiKeyProvider): string[] {
  return [...(runtimeApiKeys[provider] || [])];
}

export function getRuntimeApiRetries(): number {
  return normalizeApiRetries(globalForRuntimeKeys.__eterxRuntimeApiRetries);
}

export function applyRuntimeApiRetries(raw: unknown): number {
  const next = normalizeApiRetries(raw);
  globalForRuntimeKeys.__eterxRuntimeApiRetries = next;
  return next;
}

export function getRuntimeApiKey(provider: RuntimeApiKeyProvider): string {
  const keys = runtimeApiKeys[provider] || [];
  if (keys.length === 0) return '';
  const cursor = runtimeApiKeyCursor[provider] || 0;
  const key = keys[cursor % keys.length] || keys[0];
  runtimeApiKeyCursor[provider] = (cursor + 1) % keys.length;
  return key;
}

export function getRuntimeApiKeyStatus(): Record<RuntimeApiKeyProvider, boolean> {
  return PROVIDERS.reduce((acc, provider) => {
    acc[provider] = (runtimeApiKeys[provider] || []).length > 0;
    return acc;
  }, {} as Record<RuntimeApiKeyProvider, boolean>);
}

export function normalizeRuntimeApiKeyPayload(raw: unknown): RuntimeApiKeyPayload {
  if (!raw || typeof raw !== 'object') return {};
  const source = raw as Record<string, unknown>;
  const normalized: RuntimeApiKeyPayload = {};

  for (const [rawProvider, rawValue] of Object.entries(source)) {
    const provider = normalizeProvider(rawProvider);
    if (!provider) continue;
    const values = normalizeKeyValues(rawValue);
    if (values.length > 0) normalized[provider] = values;
  }

  return normalized;
}

export function normalizeRuntimeModelOverrides(raw: unknown): RuntimeModelOverridePayload {
  if (!raw || typeof raw !== 'object') return {};
  const source = raw as Record<string, unknown>;
  const normalized: RuntimeModelOverridePayload = {};

  for (const [rawProvider, rawValue] of Object.entries(source)) {
    const provider = normalizeModelProvider(rawProvider);
    if (!provider || typeof rawValue !== 'string') continue;
    const model = rawValue.trim();
    if (model) normalized[provider] = model;
  }

  return normalized;
}

export function applyRuntimeModelOverrides(raw: unknown): RuntimeModelOverrideStatus[] {
  const overrides = normalizeRuntimeModelOverrides(raw);
  const statuses: RuntimeModelOverrideStatus[] = [];

  MODEL_PROVIDERS.forEach(provider => {
    runtimeModelOverrides[provider] = '';
  });

  for (const provider of MODEL_PROVIDERS) {
    const model = overrides[provider];
    if (!model) continue;

    if (model.length > 220 || /[\r\n\t]/.test(model)) {
      statuses.push({
        provider,
        accepted: false,
        reason: 'Invalid model id',
      });
      continue;
    }

    runtimeModelOverrides[provider] = model;
    statuses.push({ provider, accepted: true, model });
  }

  return statuses;
}

/**
 * Create a snapshot of the credentials configured through Settings.
 *
 * Deliberately do not accept request-provided keys here. Keeping credentials
 * out of normal request bodies prevents chat, live, title, and code routes
 * from becoming alternate configuration paths.
 */
export function buildScopedRuntimeSettings(): ScopedRuntimeSettings {
  const scopedKeys = PROVIDERS.reduce((acc, provider) => {
    acc[provider] = [];
    return acc;
  }, {} as Record<RuntimeApiKeyProvider, string[]>);
  const providers: RuntimeApiKeyProviderStatus[] = [];
  let acceptedCount = 0;
  let rejectedCount = 0;
  let preferredGeminiApiKey = '';

  for (const provider of PROVIDERS) {
    const validValues = [...(runtimeApiKeys[provider] || [])];
    scopedKeys[provider] = validValues;

    if (provider === 'gemini') {
      preferredGeminiApiKey = validValues[0] || '';
    }

    if (validValues.length === 0) {
      providers.push({
        provider,
        accepted: false,
        count: 0,
        reason: 'No key configured in Settings',
      });
      continue;
    }

    acceptedCount += validValues.length;
    providers.push({ provider, accepted: true, count: validValues.length });
  }

  const modelOverrides = MODEL_PROVIDERS.reduce((acc, provider) => {
    acc[provider] = '';
    return acc;
  }, {} as Record<RuntimeModelProvider, string>);
  const modelOverrideStatuses: RuntimeModelOverrideStatus[] = [];

  for (const provider of MODEL_PROVIDERS) {
    const model = runtimeModelOverrides[provider];
    if (!model) continue;
    modelOverrides[provider] = model;
    modelOverrideStatuses.push({ provider, accepted: true, model });
  }

  return {
    apiRetries: getRuntimeApiRetries(),
    apiKeys: scopedKeys,
    modelOverrides,
    apiKeyResult: {
      acceptedCount,
      rejectedCount,
      providers,
      preferredGeminiApiKey: preferredGeminiApiKey || undefined,
    },
    modelOverrideStatuses,
    preferredGeminiApiKey: preferredGeminiApiKey || undefined,
  };
}

export function getScopedRuntimeApiKeyValues(settings: ScopedRuntimeSettings | undefined | null, provider: RuntimeApiKeyProvider): string[] {
  const scoped = settings?.apiKeys?.[provider] || [];
  return scoped.length > 0 ? [...scoped] : getRuntimeApiKeyValues(provider);
}

export function getScopedRuntimeApiKey(settings: ScopedRuntimeSettings | undefined | null, provider: RuntimeApiKeyProvider): string {
  const scoped = settings?.apiKeys?.[provider] || [];
  return scoped[0] || getRuntimeApiKey(provider);
}

export function getScopedModelOverride(settings: ScopedRuntimeSettings | undefined | null, provider: RuntimeModelProvider): string {
  return settings?.modelOverrides?.[provider] || '';
}

export function applyRuntimeApiKeys(raw: unknown): RuntimeApiKeyApplyResult {
  const payload = normalizeRuntimeApiKeyPayload(raw);
  const providers: RuntimeApiKeyProviderStatus[] = [];
  let acceptedCount = 0;
  let rejectedCount = 0;
  let preferredGeminiApiKey = '';

  PROVIDERS.forEach(provider => {
    runtimeApiKeys[provider] = [];
    runtimeApiKeyCursor[provider] = 0;
  });

  for (const provider of PROVIDERS) {
    const values = normalizeKeyValues(payload[provider]);
    const userKeys = Array.from(new Set(values.filter(value => isValidProviderKey(provider, value))));
    const invalidCount = values.length - userKeys.length;
    rejectedCount += invalidCount;

    const validValues = userKeys;

    if (validValues.length === 0) {
      providers.push({
        provider,
        accepted: false,
        count: 0,
        reason: invalidCount > 0 ? 'Invalid key format' : 'No key supplied',
      });
      continue;
    }

    if (provider === 'gemini') {
      runtimeApiKeys.gemini = validValues;
      preferredGeminiApiKey = userKeys[0] || '';
    } else {
      runtimeApiKeys[provider] = validValues;
    }

    acceptedCount += validValues.length;
    providers.push({ provider, accepted: true, count: validValues.length });
  }

  // Replace the pool once with the final set. Clearing it first discards
  // active leases/cache affinity and rejects waiting agents on every save,
  // even when the user has not changed a single Gemini key.
  apiKeyPool.setRuntimeKeys(runtimeApiKeys.gemini);

  return {
    acceptedCount,
    rejectedCount,
    providers,
    preferredGeminiApiKey: preferredGeminiApiKey || undefined,
  };
}
