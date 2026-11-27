export const BATCH_LIMIT = 100;
export const DAY_MS = 86_400_000;
export const DELIVERY_DAYS = 90;
export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

export function postHogEndpoint(host: string): URL | undefined {
  try {
    const url = new URL(host.trim());
    if (url.protocol === 'https:' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash) {
      return new URL('/i/v1/analytics/events', url);
    }
  } catch { /* A malformed address cannot receive events. */ }
}

export function isPostHogProjectToken(value: string) {
  return /^phc_[a-zA-Z0-9]{20,200}$/.test(value);
}

export const EVENT_NAMES = [
  'provider.turn.completed', 'provider.request.completed', 'mcp.tool.invoked', 'client.connected',
  'mcp.delegated_task.finished', 'client.turn.requested', 'install.owner_observed', 'feature.used',
  'client.thread.started', 'server.boot.heartbeat', 'provider.sessions.stopped_all', 'provider.turn.sent',
  'provider.session.started', 'provider.session.stopped', 'provider.runtime_mode.changed', 'provider.request.responded',
] as const;
export type TelemetryEventName = typeof EVENT_NAMES[number];
const LEGACY_EVENT_NAMES = {
  'app.started': 'server.boot.heartbeat',
  'app.heartbeat': 'server.boot.heartbeat',
  'turn.requested': 'client.turn.requested',
  'turn.finished': 'provider.turn.completed',
  'model.request': 'provider.request.completed',
} as const satisfies Record<string, TelemetryEventName>;
type LegacyEventName = keyof typeof LEGACY_EVENT_NAMES;

export function canonicalEventName(value: unknown): TelemetryEventName | undefined {
  if (typeof value !== 'string') return;
  if (Object.hasOwn(LEGACY_EVENT_NAMES, value)) return LEGACY_EVENT_NAMES[value as LegacyEventName];
  if ((EVENT_NAMES as readonly string[]).includes(value)) return value as TelemetryEventName;
}

export function formatEventId(id: string) {
  return [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join('-');
}

const PROVIDERS = [
  'gemini', 'mistral', 'openai', 'codex', 'antigravity', 'cursor', 'grok-build', 'claude-code', 'openrouter', 'anthropic', 'groq', 'deepseek', 'grok',
  'cerebras', 'together', 'fireworks', 'sambanova', 'perplexity', 'deepinfra', 'huggingface',
  'nvidia', 'cloudflare', 'ollama', 'lmstudio', 'vllm', 'llamacpp', 'novita', 'qwen', 'mimo',
  'tokenhub', 'zai', 'kimi', 'stepfun', 'minimax', 'ollamacloud', 'arcee', 'gmi', 'kilo',
  'opencode', 'upstage', 'custom', 'deepgram', 'elevenlabs', 'fal', 'krea', 'freepik', 'replicate',
  'runway', 'luma', 'tencent', 'volcengine', 'tavily', 'exa', 'brave', 'serper', 'firecrawl',
  'firecrawl_selfhosted', 'searxng', 'duckduckgo', 'linkup', 'jina', 'parallel', 'you', 'unknown',
] as const;

const PLATFORMS = ['win32', 'darwin', 'linux', 'other'] as const;
const ARCHITECTURES = ['x64', 'arm64', 'ia32', 'arm', 'other'] as const;
const OS_NAMES = ['windows', 'macos', 'linux', 'ios', 'android', 'chromeos', 'other'] as const;
const CLIENT_TYPES = ['desktop', 'web', 'gateway', 'automation'] as const;
const SURFACES = ['desktop', 'web', 'mobile', 'gateway', 'background'] as const;
const CHANNELS = ['stable', 'preview', 'development'] as const;
const REQUEST_KINDS = ['generation', 'live', 'image', 'video', 'search', 'title', 'compaction', 'builder'] as const;
const SERVICE_TIERS = ['auto', 'default', 'standard', 'flex', 'priority', 'scale', 'fast'] as const;
const TOOL_LABELS = ['external_mcp', 'computer_use', 'connector_mcp', 'spawn_sub_agent', 'agent_communicate',
  'workspace_run_command', 'file_edit', 'browser_control', 'screen_agent', 'computer', 'screenshot_capture',
  'web_search', 'ask_user', 'other'] as const;
const TERMINAL_STATUSES = ['succeeded', 'completed', 'failed', 'cancelled', 'interrupted', 'closed', 'pending'] as const;

const CATEGORIES = {
  platform: PLATFORMS,
  arch: ARCHITECTURES,
  channel: CHANNELS,
  runtime: ['desktop', 'server'],
  provider: PROVIDERS,
  mode: ['agent', 'chat'],
  effort: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  permissions: ['ask', 'review', 'full'],
  origin: ['interactive', 'scheduled', 'gateway', 'proxy', 'background'],
  role: ['main', 'child', 'auxiliary'],
  feature: ['builder', 'compaction', 'image', 'live', 'search', 'title', 'video', 'connectors', 'delegation'],
  outcome: ['succeeded', 'failed', 'cancelled', 'interrupted', 'pending'],
  error: ['rate_limit', 'authentication', 'timeout', 'network', 'upstream', 'invalid_request', 'unknown'],
  clientType: CLIENT_TYPES,
  tool: TOOL_LABELS,
  requestKind: REQUEST_KINDS,
  serviceTier: SERVICE_TIERS,
} as const;

type CategoricalDimensions = { [K in keyof typeof CATEGORIES]: typeof CATEGORIES[K][number] };
export type Dimensions = Partial<CategoricalDimensions & { version: string; model: string }>;
export type DimensionInput = Partial<Record<keyof Dimensions, unknown>>;
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
  'otherInputTokens', 'otherOutputTokens', 'childInputTokens', 'childOutputTokens',
  'providerTurns', 'nativeChildTurns', 'continuations', 'steeringRestarts',
  'attachmentCount', 'sessionCount', 'stoppedSessionCount',
  'childRequests', 'childUsageReports',
] as const;
export type Measurements = Partial<Record<typeof MEASUREMENT_NAMES[number], number>>;

// Client strings are closed categories, public catalog models, or build versions.
// The receiver derives both identifier properties from the installation credential.
const PROPERTY_ENUMS = {
  arch: ARCHITECTURES, clientType: CLIENT_TYPES, platform: PLATFORMS, serverArch: ARCHITECTURES,
  serverMode: CATEGORIES.runtime, serverOs: OS_NAMES, telemetryChannel: CHANNELS,
  clientBrowser: ['electron', 'edge', 'chrome', 'firefox', 'safari', 'other'],
  clientDeviceModel: ['mac', 'pc', 'iphone', 'ipad', 'android'],
  clientDeviceType: ['desktop', 'phone', 'tablet', 'other'],
  clientOs: OS_NAMES, connectionMethod: ['loopback', 'direct', 'ssh', 'relay'],
  deviceModel: ['mac', 'pc', 'iphone', 'ipad', 'android'], os: OS_NAMES, surface: SURFACES,
  webDeployment: ['self_hosted', 'local'],
  observedBy: ['app_runtime', 'chat_store', 'account_service'], ownerSource: ['local_profile', 'account'],
  provider: PROVIDERS, callerProvider: PROVIDERS, targetProvider: PROVIDERS, effort: CATEGORIES.effort,
  serviceTier: SERVICE_TIERS,
  createdBy: ['user', 'agent', 'system'], creationSource: ['composer', 'agent', 'builder', 'gateway', 'scheduler', 'proxy', 'copy', 'chat_store'],
  childKind: ['subagent', 'continuation'],
  interactionMode: ['agent', 'chat', 'plan', 'live'], targetInteractionMode: ['agent', 'chat', 'plan', 'live'],
  runtimeMode: CATEGORIES.permissions, targetRuntimeMode: CATEGORIES.permissions,
  terminalStatus: TERMINAL_STATUSES,
  usageStatus: ['reported', 'partial', 'missing'], usageScope: ['request', 'turn', 'child', 'auxiliary'],
  segment: ['main', 'child', 'auxiliary', 'compaction', 'live', 'image', 'video', 'search', 'title', 'builder'],
  requestKind: REQUEST_KINDS, childUsageStatus: ['reported', 'partial', 'missing'],
  tool: TOOL_LABELS, outcome: [...CATEGORIES.outcome, 'success', 'error'], errorCode: CATEGORIES.error,
  callerOrigin: ['user', 'agent', 'system', 'gateway'], mode: ['async', 'wait', 'direct'],
  completionWake: ['notify', 'none'], status: TERMINAL_STATUSES, delivery: ['foreground', 'background', 'direct', 'gateway'],
  from: CATEGORIES.permissions, to: CATEGORIES.permissions, decision: ['approve-once', 'approve-session', 'reject'],
  feature: CATEGORIES.feature, variant: ['text', 'voice', 'image', 'video', 'standard', 'fast'],
  workspace: ['local', 'worktree', 'folder', 'none'], workspaceStrategy: ['local', 'worktree', 'folder', 'none'],
  // EterX reporting dimensions that predate the field reference.
  origin: CATEGORIES.origin, role: CATEGORIES.role,
} as const;

const PROPERTY_BOOLEANS = [
  '$process_person_profile', 'targetChosen', 'crossProvider', 'scheduled', 'subagent', 'hasSubagents',
  'usageReported', 'restartContinuation', 'lifecycleObserved', 'childrenRunning', 'localCommand', 'mixedModels',
  'bindToCurrentThread', 'waitTimedOut', 'hasInput', 'hasCwd', 'hasModel', 'hasResumeCursor', 'boot',
] as const;
const PROPERTY_INTEGERS = [
  'clientOsMajorVersion', 'osMajorVersion', 'projectCount', 'threadCount', 'reportVersion', 'callerDepth', 'durationSeconds',
  'cachedInputTokens', 'cacheCreationTokens', ...MEASUREMENT_NAMES,
] as const;
const VERSION_FIELDS = ['serverAppVersion', 'appCoreVersion', 'appVersion', 'clientAppVersion'] as const;
const MODEL_PROVIDER_FIELDS = {
  model: 'provider', observedModel: 'provider', callerModel: 'callerProvider', targetModel: 'targetProvider',
} as const;
type ModelField = keyof typeof MODEL_PROVIDER_FIELDS;
type PropertyEnums = { [K in keyof typeof PROPERTY_ENUMS]: typeof PROPERTY_ENUMS[K][number] };
export type TelemetryProperties = Partial<PropertyEnums
  & Record<typeof PROPERTY_BOOLEANS[number], boolean>
  & Record<typeof PROPERTY_INTEGERS[number], number>
  & Record<typeof VERSION_FIELDS[number] | ModelField | 'installId' | 'ownerId', string>>;
export type PropertyInput = Partial<Record<keyof TelemetryProperties, unknown>>;

export type TelemetryEvent = {
  id: string;
  at: number;
  receivedAt?: number;
  insertedAt?: number;
  name: TelemetryEventName;
  dimensions: Dimensions;
  measurements?: Measurements;
  properties?: TelemetryProperties;
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

export function normalizeProperties(input: PropertyInput): TelemetryProperties {
  const result: Record<string, string | boolean | number> = {};
  for (const [key, choices] of Object.entries(PROPERTY_ENUMS)) {
    const value = input[key as keyof PropertyEnums];
    if (typeof value === 'string' && (choices as readonly string[]).includes(value)) result[key] = value;
  }
  for (const key of PROPERTY_BOOLEANS) {
    const value = input[key];
    if (typeof value === 'boolean') result[key] = value;
  }
  for (const key of PROPERTY_INTEGERS) {
    const value = input[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000_000) result[key] = value;
  }
  for (const key of VERSION_FIELDS) {
    const value = input[key];
    if (typeof value === 'string' && SAFE_VERSION.test(value)) result[key] = value;
  }
  for (const key of Object.keys(MODEL_PROVIDER_FIELDS) as ModelField[]) {
    const value = input[key];
    if (typeof value === 'string' && SAFE_MODEL.test(value) && !value.includes('..')) result[key] = value;
  }
  result.$process_person_profile = false;
  return result;
}

export function propertiesFromEvent(event: TelemetryEvent): TelemetryProperties {
  const { version, runtime, channel, mode, permissions, error, ...dimensions } = event.dimensions;
  const { cachedTokens, cacheWriteTokens, ...measurements } = event.measurements ?? {};
  return normalizeProperties({
    ...dimensions, ...measurements, appVersion: version, serverMode: runtime, telemetryChannel: channel,
    interactionMode: mode, runtimeMode: permissions, errorCode: error,
    cachedInputTokens: cachedTokens, cacheCreationTokens: cacheWriteTokens,
    ...event.properties,
  });
}

export function restrictModelProperties(
  properties: TelemetryProperties, catalog: Record<string, Record<string, unknown>>,
): TelemetryProperties {
  const result = { ...properties };
  for (const key of Object.keys(MODEL_PROVIDER_FIELDS) as ModelField[]) {
    const publicName = catalogModel(catalog, properties[MODEL_PROVIDER_FIELDS[key]], properties[key]);
    if (publicName) result[key] = publicName;
    else delete result[key];
  }
  return result;
}

export function productUserAgent(properties: TelemetryProperties) {
  const version = properties.clientAppVersion ?? properties.appVersion;
  return version ? 'EterX/' + version : 'EterX';
}

export function countsAsActivity(event: TelemetryEvent): boolean {
  const name = canonicalEventName(event.name);
  return (name === 'client.turn.requested' && event.dimensions.origin === 'interactive')
    || (name === 'provider.request.completed' && event.dimensions.feature === 'live' && event.dimensions.outcome === 'succeeded')
    || (name === 'feature.used' && event.dimensions.origin === 'interactive'
      && (event.dimensions.outcome === 'succeeded' || event.properties?.outcome === 'succeeded')
      && (event.dimensions.feature === 'live' || (event.dimensions.feature === 'search' && event.dimensions.mode === undefined)));
}
