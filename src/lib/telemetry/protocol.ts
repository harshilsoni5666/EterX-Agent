export const TELEMETRY_VERSION = 1;
export const TELEMETRY_PATH = '/v1/events';
export const BATCH_LIMIT = 100;
export const BODY_LIMIT = 128 * 1024;
export const DAY_MS = 86_400_000;
export const DELIVERY_DAYS = 90;
export const EVENT_ID = /^[0-9a-f]{32}$/;
export const INSTALL_TOKEN = /^[0-9a-f]{64}$/;

export function telemetryEndpoint(value: string | undefined, allowLoopback: boolean): URL | undefined {
  if (!value?.trim()) return;
  try {
    const url = new URL(value.trim());
    const local = allowLoopback && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol === 'https:' || local) && url.pathname === TELEMETRY_PATH
        && !url.username && !url.password && !url.search && !url.hash) return url;
  } catch { /* A malformed address cannot receive events. */ }
}

export const EVENT_NAMES = ['app.started', 'app.heartbeat', 'turn.requested', 'turn.finished', 'model.request', 'feature.used'] as const;
export type TelemetryEventName = typeof EVENT_NAMES[number];

const PROVIDERS = [
  'gemini', 'mistral', 'openai', 'codex', 'openrouter', 'anthropic', 'groq', 'deepseek', 'grok',
  'cerebras', 'together', 'fireworks', 'sambanova', 'perplexity', 'deepinfra', 'huggingface',
  'nvidia', 'cloudflare', 'ollama', 'lmstudio', 'vllm', 'llamacpp', 'novita', 'qwen', 'mimo',
  'tokenhub', 'zai', 'kimi', 'stepfun', 'minimax', 'ollamacloud', 'arcee', 'gmi', 'kilo',
  'opencode', 'upstage', 'custom', 'deepgram', 'elevenlabs', 'fal', 'krea', 'freepik', 'replicate',
  'runway', 'luma', 'tencent', 'volcengine', 'tavily', 'exa', 'brave', 'serper', 'firecrawl',
  'firecrawl_selfhosted', 'searxng', 'duckduckgo', 'linkup', 'jina', 'parallel', 'you', 'unknown',
] as const;

const CATEGORIES = {
  platform: ['win32', 'darwin', 'linux', 'other'],
  arch: ['x64', 'arm64', 'other'],
  channel: ['stable', 'preview', 'development'],
  runtime: ['desktop', 'server'],
  provider: PROVIDERS,
  mode: ['agent', 'chat'],
  effort: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  permissions: ['ask', 'review', 'full'],
  origin: ['interactive', 'scheduled', 'gateway', 'proxy', 'background'],
  role: ['main', 'child', 'auxiliary'],
  feature: ['builder', 'compaction', 'image', 'live', 'search', 'title', 'video'],
  outcome: ['succeeded', 'failed', 'cancelled', 'interrupted', 'pending'],
  error: ['rate_limit', 'authentication', 'timeout', 'network', 'upstream', 'invalid_request', 'unknown'],
} as const;

type CategoricalDimensions = { [K in keyof typeof CATEGORIES]: typeof CATEGORIES[K][number] };
export type Dimensions = Partial<CategoricalDimensions & { version: string; model: string }>;
export type DimensionInput = Partial<Record<keyof Dimensions, unknown>>;
export const DIMENSION_NAMES = [...Object.keys(CATEGORIES), 'version', 'model'];
const SAFE_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[a-z0-9.-]{1,24})?$/i;
const SAFE_MODEL = /^[a-z0-9][a-z0-9._:+/-]{0,95}$/i;
const LOCAL_OR_CUSTOM = new Set(['custom', 'ollama', 'lmstudio', 'vllm', 'llamacpp', 'opencode']);

export function catalogModel(catalog: Record<string, Record<string, unknown>>, provider: unknown, model: unknown) {
  if (typeof provider !== 'string' || typeof model !== 'string' || LOCAL_OR_CUSTOM.has(provider)) return;
  const models = catalog[provider === 'codex' ? 'openai' : provider];
  const name = provider === 'gemini' ? model.replace(/^models\//, '') : model;
  if (models && Object.hasOwn(models, name)) return name;
}

export const MEASUREMENT_NAMES = [
  'durationMs', 'durationReports', 'requests', 'usageReports', 'inputReports', 'outputReports', 'cacheReports',
  'inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'cacheWriteTokens', 'reasoningTokens',
  'audioInputTokens', 'audioOutputTokens', 'imageInputTokens', 'imageOutputTokens',
  'generatedImages', 'generatedVideoMs', 'audioMs',
] as const;
export type Measurements = Partial<Record<typeof MEASUREMENT_NAMES[number], number>>;
export type TelemetryEvent = {
  id: string;
  at: number;
  name: TelemetryEventName;
  dimensions: Dimensions;
  measurements?: Measurements;
};

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeDimensions(input: DimensionInput): Dimensions {
  const result: Record<string, string> = {};
  for (const [key, values] of Object.entries(CATEGORIES)) {
    const value = input[key as keyof CategoricalDimensions];
    if (typeof value === 'string' && (values as readonly string[]).includes(value)) result[key] = value;
  }
  const { version, model } = input;
  if (typeof version === 'string' && SAFE_VERSION.test(version)) result.version = version;
  if (result.provider && typeof model === 'string' && SAFE_MODEL.test(model) && !model.includes('..')) result.model = model;
  return result as Dimensions;
}

export function normalizeMeasurements(input: Partial<Record<string, unknown>>): Measurements {
  const result: Measurements = {};
  for (const key of MEASUREMENT_NAMES) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000_000_000) {
      result[key] = Math.round(value);
    }
  }
  return result;
}

export function parseEvent(input: unknown, now: number): TelemetryEvent | undefined {
  if (!isObject(input)) return;
  const { id, at, name, dimensions, measurements } = input;
  if (typeof id !== 'string' || !EVENT_ID.test(id) || typeof at !== 'number' || !Number.isSafeInteger(at)
      || at < now - DELIVERY_DAYS * DAY_MS || at > now + DAY_MS
      || typeof name !== 'string' || !(EVENT_NAMES as readonly string[]).includes(name)
      || !isObject(dimensions) || (measurements !== undefined && !isObject(measurements))) return;

  // Project onto the wire schema even for requests from older or unofficial clients.
  return {
    id, at, name: name as TelemetryEventName,
    dimensions: normalizeDimensions(dimensions),
    ...(measurements === undefined ? {} : { measurements: normalizeMeasurements(measurements) }),
  };
}

export function countsAsActivity(event: TelemetryEvent): boolean {
  return (event.name === 'turn.requested' && event.dimensions.origin === 'interactive')
    || (event.name === 'model.request' && event.dimensions.feature === 'live' && event.dimensions.outcome === 'succeeded')
    || (event.name === 'feature.used' && event.dimensions.feature === 'search'
      && event.dimensions.mode === undefined && event.dimensions.origin === 'interactive' && event.dimensions.outcome === 'succeeded');
}
