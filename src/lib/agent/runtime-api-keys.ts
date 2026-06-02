import { apiKeyPool } from './api-key-pool';

export type RuntimeApiKeyProvider =
  | 'gemini'
  | 'mistral'
  | 'openrouter'
  | 'anthropic'
  | 'openai'
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

const PROVIDERS: RuntimeApiKeyProvider[] = [
  'gemini',
  'mistral',
  'openrouter',
  'anthropic',
  'openai',
  'tavily',
  'github',
];

const ENV_KEYS: Record<RuntimeApiKeyProvider, string[]> = {
  gemini: ['GEMINI_API_KEY'],
  mistral: ['MISTRAL_API_KEY', 'MISTRAL_AI_API_KEY', 'MISTRALAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY', 'VITE_OPENROUTER_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  tavily: ['TAVILY_API_KEY', 'VITE_TAVILY_API_KEY'],
  github: ['GITHUB_TOKEN'],
};

const globalForRuntimeKeys = globalThis as typeof globalThis & {
  __eterxRuntimeApiKeys?: Record<RuntimeApiKeyProvider, string[]>;
  __eterxRuntimeApiKeyCursor?: Record<RuntimeApiKeyProvider, number>;
};

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

const MODEL_PROVIDERS: RuntimeModelProvider[] = ['gemini', 'mistral', 'openai', 'openrouter', 'anthropic'];

const MODEL_ENV_KEYS: Record<RuntimeModelProvider, string[]> = {
  gemini: ['ETERX_THINK_MODEL', 'GEMINI_THINK_MODEL'],
  mistral: ['MISTRAL_MODEL', 'MISTRAL_MODEL_NAME'],
  openai: ['OPENAI_MODEL', 'OPENAI_MODEL_NAME'],
  openrouter: ['OPENROUTER_MODEL', 'OPENROUTER_MODEL_NAME'],
  anthropic: ['ANTHROPIC_MODEL', 'ANTHROPIC_MODEL_NAME', 'CLAUDE_MODEL'],
};

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
    case 'mistral':
      return key.length >= 16;
    case 'tavily':
      return key.length >= 12;
    case 'github':
      return key.length >= 20;
    default:
      return false;
  }
};

const setRuntimeEnv = (envKeys: string[], values: string[]) => {
  if (values.length === 0) return;
  envKeys.forEach(envKey => {
    process.env[envKey] = values[0];
  });

  values.forEach((value, index) => {
    process.env[`${ envKeys[0] }_${ index + 1 }`] = value;
  });
};

const clearKnownRuntimeEnvKeys = () => {
  const exactKeys = new Set(Object.values(ENV_KEYS).flat());
  const indexedPrefixes = Array.from(exactKeys);

  for (const key of Object.keys(process.env)) {
    if (exactKeys.has(key) || indexedPrefixes.some(prefix => key.startsWith(`${prefix}_`))) {
      delete process.env[key];
    }
  }
};

const clearKnownRuntimeModelEnvKeys = () => {
  const exactKeys = new Set(Object.values(MODEL_ENV_KEYS).flat());
  for (const key of exactKeys) {
    delete process.env[key];
  }
};

export function getRuntimeModelOverrides(): Record<RuntimeModelProvider, string> {
  return { ...runtimeModelOverrides };
}

export function getRuntimeApiKeyValues(provider: RuntimeApiKeyProvider): string[] {
  return [...(runtimeApiKeys[provider] || [])];
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

  clearKnownRuntimeModelEnvKeys();
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

    MODEL_ENV_KEYS[provider].forEach(envKey => {
      process.env[envKey] = model;
    });
    runtimeModelOverrides[provider] = model;
    statuses.push({ provider, accepted: true, model });
  }

  return statuses;
}

export function applyRuntimeApiKeys(raw: unknown): RuntimeApiKeyApplyResult {
  const payload = normalizeRuntimeApiKeyPayload(raw);
  const providers: RuntimeApiKeyProviderStatus[] = [];
  let acceptedCount = 0;
  let rejectedCount = 0;
  let preferredGeminiApiKey = '';

  clearKnownRuntimeEnvKeys();
  PROVIDERS.forEach(provider => {
    runtimeApiKeys[provider] = [];
    runtimeApiKeyCursor[provider] = 0;
  });
  apiKeyPool.setRuntimeKeys([]);

  for (const provider of PROVIDERS) {
    const values = normalizeKeyValues(payload[provider]);
    if (values.length === 0) continue;

    const validValues = Array.from(new Set(values.filter(value => isValidProviderKey(provider, value))));
    const invalidCount = values.length - validValues.length;
    rejectedCount += invalidCount;

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
      apiKeyPool.setRuntimeKeys(validValues);
      setRuntimeEnv(ENV_KEYS.gemini, validValues);
      preferredGeminiApiKey = validValues[0];
    } else {
      runtimeApiKeys[provider] = validValues;
      setRuntimeEnv(ENV_KEYS[provider], validValues);
    }

    acceptedCount += validValues.length;
    providers.push({ provider, accepted: true, count: validValues.length });
  }

  return {
    acceptedCount,
    rejectedCount,
    providers,
    preferredGeminiApiKey: preferredGeminiApiKey || undefined,
  };
}
