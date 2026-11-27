import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import appPackage from '../../../package.json';
import { getEterxDataDir } from '../agent/storage-paths';
import bundledRates from '../usage/bundled-rates.json';
import { openOutbox } from './outbox';
import { readPostHogConfig, sendToPostHog, type CaptureReceipt } from './posthog';
import { resolveTelemetryEnabled } from './preference';
import {
  BATCH_LIMIT, catalogModel, isObject, normalizeDimensions,
  normalizeMeasurements, normalizeProperties, restrictModelProperties,
  type DimensionInput, type Dimensions, type Measurements, type TelemetryEvent, type TelemetryEventName,
  type PropertyInput, type TelemetryProperties,
} from './protocol';

type Scope = {
  dimensions: Dimensions;
  properties?: TelemetryProperties;
  turnId?: string;
  turnFeature?: Dimensions['feature'];
};
type Outcome = NonNullable<Dimensions['outcome']>;
type Feature = NonNullable<Dimensions['feature']>;
const TICK_MS = 5_000;
const HEARTBEAT_MS = 10 * 60_000;
const CATCH_UP_MS = 1_250;
const globalState = globalThis as typeof globalThis & {
  __eterxProductTelemetry?: {
    scope: AsyncLocalStorage<Scope>;
    bootId: string;
    store?: ReturnType<typeof openOutbox>;
    timer?: ReturnType<typeof setInterval>;
    inFlight?: AbortController;
    heartbeatAt: number;
    maintenanceAt: number;
    retryStorageAt: number;
    postHog?: ReturnType<typeof readPostHogConfig>;
    configReadAt: number;
    nextDeliveryWarning: number;
    preference: { checkedAt: number; signature?: string; enabled: boolean };
  };
};
const state = globalState.__eterxProductTelemetry ??= {
  scope: new AsyncLocalStorage<Scope>(), bootId: randomUUID(),
  heartbeatAt: 0, maintenanceAt: 0, retryStorageAt: 0, configReadAt: 0, nextDeliveryWarning: 0,
  preference: { checkedAt: 0, enabled: false },
};

const publicModels = bundledRates.providers as Record<string, Record<string, unknown>>;
const isDesktopRuntime = () => Boolean(process.env.ETERX_DESKTOP_PARENT_PID || process.env.ETERX_DESKTOP_DEV === '1');

function enabled(refresh = false): boolean {
  const policy = process.env.ETERX_TELEMETRY_ENABLED?.trim().toLowerCase();
  if (policy === 'false' || policy === 'true') return policy === 'true';
  const now = Date.now();
  if (!refresh && now - state.preference.checkedAt < 1_000) return state.preference.enabled;
  try {
    const settingsDir = path.join(getEterxDataDir(), 'settings');
    let file = path.join(settingsDir, 'preferences.json');
    let stat = statSync(file, { throwIfNoEntry: false });
    if (!stat) {
      file = path.join(settingsDir, 'preferences.backup.json');
      stat = statSync(file, { throwIfNoEntry: false });
    }
    if (!stat) {
      state.preference = { checkedAt: now, enabled: isDesktopRuntime() };
      return state.preference.enabled;
    }
    const signature = [file, stat.ino, stat.mtimeMs, stat.size].join(':');
    if (signature !== state.preference.signature) {
      const preferences: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const rawSettings = isObject(preferences) ? preferences.eterx_settings : null;
      const settings: unknown = rawSettings === undefined ? {} : typeof rawSettings === 'string' ? JSON.parse(rawSettings) : null;
      state.preference = { checkedAt: now, signature, enabled: isObject(settings) && resolveTelemetryEnabled(settings.telemetry, isDesktopRuntime()) };
    }
  } catch {
    state.preference = { checkedAt: now, enabled: false };
  }
  state.preference.checkedAt = now;
  return state.preference.enabled;
}

function localStore() {
  return state.store ??= openOutbox();
}

function withStore<T>(use: (store: ReturnType<typeof openOutbox>) => T): T | undefined {
  if (state.retryStorageAt > Date.now()) return;
  try { return use(localStore()); } catch {
    state.retryStorageAt = Date.now() + 5_000;
    console.warn('[Telemetry] Local outbox is temporarily unavailable.');
  }
}

function runtimeContext() {
  const version = process.env.ETERX_APP_VERSION || appPackage.version;
  const desktop = isDesktopRuntime();
  const platform = ['darwin', 'win32', 'linux'].includes(process.platform) ? process.platform : 'other';
  const serverOs = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform;
  const arch = ['arm64', 'x64', 'ia32', 'arm'].includes(process.arch) ? process.arch : 'other';
  const dimensions = normalizeDimensions({
    platform, arch, version, runtime: desktop ? 'desktop' : 'server',
    channel: process.env.NODE_ENV !== 'production' ? 'development' : version.includes('-') ? 'preview' : 'stable',
  });
  return { dimensions, properties: { serverArch: arch, serverOs, serverAppVersion: appPackage.version,
    appCoreVersion: process.env.ETERX_APP_CORE_VERSION || appPackage.version } };
}

const idNamespaces: Partial<Record<TelemetryEventName, string>> = {
  'client.turn.requested': 'turn.requested',
  'provider.turn.completed': 'turn.finished',
  'provider.request.completed': 'model.request',
};

function eventId(token: string, name: TelemetryEventName, localKey?: string) {
  const namespace = idNamespaces[name] ?? name;
  return localKey ? createHmac('sha256', token).update(JSON.stringify([namespace, localKey])).digest('hex').slice(0, 32)
    : randomUUID().replaceAll('-', '');
}

function makeEvent(
  token: string, name: TelemetryEventName, dimensions: Dimensions, measurements?: Measurements,
  properties?: PropertyInput, localKey?: string, at = Date.now(),
): TelemetryEvent {
  const runtime = runtimeContext();
  const safe = restrictModelProperties(normalizeProperties({
    ...runtime.properties, ...properties, provider: dimensions.provider ?? properties?.provider,
    model: dimensions.model ?? properties?.model,
    clientAppVersion: properties?.clientAppVersion ?? (properties?.clientType === 'desktop' ? runtime.dimensions.version : undefined),
  }), publicModels);
  return { id: eventId(token, name, localKey), at, name, dimensions: { ...runtime.dimensions, ...dimensions, model: safe.model },
    measurements, properties: safe, receivedAt: Date.now() };
}

export function recordTelemetry(
  name: TelemetryEventName, properties: PropertyInput = {},
  options: {
    dimensions?: DimensionInput; measurements?: Measurements; key?: string; at?: number;
    turnId?: string; usage?: 'main' | 'child';
  } = {},
): boolean {
  if (!enabled()) return true;
  initializeTelemetry();
  const scope = state.scope.getStore();
  const dimensions = normalizeDimensions({ origin: scope?.dimensions.origin, ...(options.dimensions ?? scope?.dimensions) });
  return withStore(store => {
    store.record(
      makeEvent(store.token, name, dimensions, options.measurements, { ...scope?.properties, ...properties }, options.key, options.at),
      options.turnId, options.usage,
    );
    return true;
  }) === true;
}

export function withTelemetryScope<T>(dimensions: DimensionInput, run: () => T, properties?: PropertyInput): T {
  const parent = state.scope.getStore();
  return state.scope.run({
    ...parent, dimensions: normalizeDimensions({ ...parent?.dimensions, ...dimensions }),
    properties: properties ? { ...parent?.properties, ...normalizeProperties(properties) } : parent?.properties,
  }, run);
}

export function publicTelemetryModel(provider: unknown, model: unknown) {
  return catalogModel(publicModels, provider, model);
}

export function observeTelemetryClient(properties: PropertyInput, localSession: string) {
  recordTelemetry('client.connected', properties, { key: JSON.stringify([state.bootId, localSession]) });
}

export function refreshTelemetryPreference() {
  if (!enabled(true)) state.inFlight?.abort();
}

export function observeLocalInstallation(counts: { threadCount: number; projectCount: number }) {
  if (runtimeContext().dimensions.runtime !== 'desktop') return;
  recordTelemetry('install.owner_observed', { ...counts, observedBy: 'chat_store', ownerSource: 'local_profile' }, {
    key: new Date().toISOString().slice(0, 10),
  });
}

export async function measureMcpInvocation<T>(
  tool: NonNullable<Dimensions['tool']>, operation: () => Promise<T>, failed: (value: T) => boolean = () => false,
): Promise<T> {
  const started = performance.now();
  const scope = state.scope.getStore();
  const callerOrigin = scope?.dimensions.origin === 'gateway' ? 'gateway'
    : scope?.dimensions.role === 'main' || scope?.dimensions.role === 'child' ? 'agent' : 'user';
  let outcome: 'success' | 'error' = 'error';
  let errorCode: Dimensions['error'];
  try {
    const result = await operation();
    outcome = failed(result) ? 'error' : 'success';
    if (outcome === 'error') errorCode = 'upstream';
    return result;
  } catch (error) {
    errorCode = providerErrorCategory(error);
    throw error;
  } finally {
    const durationMs = Math.round(performance.now() - started);
    recordTelemetry('mcp.tool.invoked', {
      tool, outcome, errorCode, callerOrigin, callerDepth: scope?.properties?.callerDepth ?? (scope ? 0 : undefined),
      callerProvider: scope?.dimensions.provider, callerModel: scope?.dimensions.model,
    }, { measurements: { durationMs, durationReports: 1 } });
  }
}

export function beginTelemetryTurn(localKey: string, input: DimensionInput, details: PropertyInput = {}) {
  const dimensions = normalizeDimensions({ ...input, role: 'main', model: catalogModel(publicModels, input.provider, input.model) });
  const parent = state.scope.getStore();
  const origin = dimensions.origin;
  const properties = normalizeProperties({
    ...parent?.properties,
    clientType: origin === 'gateway' ? 'gateway' : origin && origin !== 'interactive' ? 'automation' : parent?.properties?.clientType,
    surface: origin === 'gateway' ? 'gateway' : origin && origin !== 'interactive' ? 'background' : parent?.properties?.surface,
    createdBy: origin === 'proxy' ? 'agent' : origin === 'scheduled' || origin === 'background' ? 'system' : 'user',
    creationSource: origin === 'scheduled' ? 'scheduler' : origin === 'gateway' ? 'gateway' : origin === 'proxy' ? 'proxy'
      : dimensions.feature === 'builder' ? 'builder' : 'composer',
    scheduled: origin === 'scheduled', subagent: false, reportVersion: 1, ...details,
  });
  let turnId: string | undefined;
  if (enabled()) {
    initializeTelemetry();
    turnId = withStore(store => {
      const requested = makeEvent(store.token, 'client.turn.requested', dimensions, undefined, properties, localKey);
      return store.beginTurn(requested, eventId(store.token, 'provider.turn.completed', localKey)) ? requested.id : undefined;
    });
  }
  return {
    run<T>(operation: () => T): T {
      return state.scope.run({ dimensions, properties, turnId, turnFeature: dimensions.feature }, operation);
    },
    finish(outcome: 'succeeded' | 'failed' | 'cancelled', at?: number) {
      const id = turnId;
      if (!id) return;
      withStore(store => enabled() ? store.finishTurn(id, outcome, at) : store.discardTurn(id));
    },
    hasSession() {
      const id = turnId;
      return Boolean(id && withStore(store => store.hasSession(id)));
    },
  };
}

export function updateTelemetryTurn(properties: PropertyInput, counts: Measurements = {}) {
  const id = state.scope.getStore()?.turnId;
  if (id && enabled()) withStore(store => store.updateTurn(id, normalizeProperties(properties), normalizeMeasurements(counts)));
}

export function recordProviderDispatch(provider: string, model: string, serviceTier?: unknown) {
  const scope = state.scope.getStore();
  if (!scope?.turnId || scope.dimensions.role !== 'main' || scope.dimensions.feature !== scope.turnFeature || !enabled()) return;
  const id = scope.turnId;
  const dimensions = normalizeDimensions({ ...scope.dimensions, provider, model: publicTelemetryModel(provider, model), serviceTier });
  const at = Date.now();
  withStore(store => store.dispatchTurn(id,
    makeEvent(store.token, 'provider.turn.sent', dimensions, undefined, scope.properties, id, at),
    makeEvent(store.token, 'provider.session.started', dimensions, { sessionCount: 1 }, scope.properties, id, at),
    eventId(store.token, 'provider.session.stopped', id),
  ));
}

export function providerErrorCategory(error: unknown): Dimensions['error'] {
  const details = isObject(error) ? error : {};
  const value = details.status ?? details.statusCode;
  const status = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'authentication';
  if (status === 408 || status === 504 || details.name === 'TimeoutError' || details.name === 'APIConnectionTimeoutError') return 'timeout';
  if (status >= 500 && status <= 599) return 'upstream';
  if (status >= 400 && status <= 499) return 'invalid_request';
  if (details.name === 'APIConnectionError' || details.code === 'ECONNRESET' || details.code === 'ECONNREFUSED') return 'network';
  return 'unknown';
}

export function recordProviderRequest(input: {
  id: string;
  provider: string;
  model: string;
  observedModel?: string;
  serviceTier?: unknown;
  at?: number;
  outcome: Outcome;
  error?: Dimensions['error'];
  feature?: Feature;
  measurements: Measurements;
}) {
  const scope = state.scope.getStore();
  const provider = normalizeDimensions({ provider: input.provider }).provider ?? 'unknown';
  const feature = input.feature ?? scope?.dimensions.feature;
  const role = scope?.dimensions.role === 'main' && feature !== scope.turnFeature
    ? 'auxiliary' : scope?.dimensions.role ?? 'auxiliary';
  const requestKind = feature ?? 'generation';
  const dimensions = normalizeDimensions({
    ...scope?.dimensions, provider, model: catalogModel(publicModels, provider, input.model), role,
    feature, outcome: input.outcome, error: input.error, serviceTier: input.serviceTier, requestKind,
  });
  const usageReported = (input.measurements.usageReports ?? 0) > 0;
  const roleInTurn = role === 'child' ? 'child' : role === 'main' && feature === scope?.turnFeature ? 'main' : undefined;
  return recordTelemetry('provider.request.completed', {
    observedModel: input.observedModel, terminalStatus: input.outcome === 'succeeded' ? 'completed' : input.outcome,
    segment: role === 'child' ? 'child' : feature ?? role, usageScope: role === 'child' ? 'child' : 'request',
    usageReported, reportVersion: 1,
    usageStatus: !usageReported ? 'missing' : input.measurements.inputReports && input.measurements.outputReports ? 'reported' : 'partial',
    durationSeconds: input.measurements.durationMs === undefined ? undefined : Math.round(input.measurements.durationMs / 1000),
  }, {
    dimensions, measurements: normalizeMeasurements({
      ...input.measurements, requests: 1, durationReports: Number(input.measurements.durationMs !== undefined),
    }),
    key: input.id, at: input.at, turnId: roleInTurn ? scope?.turnId : undefined, usage: roleInTurn,
  });
}

export async function measureFeature<T>(
  feature: Feature, operation: () => Promise<T>,
  summarize: (value: T) => { success?: boolean; pending?: boolean; provider?: unknown; model?: unknown } = () => ({}),
  signal?: AbortSignal,
): Promise<T> {
  const start = performance.now();
  const parent = state.scope.getStore()?.dimensions;
  const role = parent?.role === 'child' ? 'child' : 'auxiliary';
  let outcome: Outcome = 'failed';
  let provider: unknown;
  let model: unknown;
  try {
    const value = await withTelemetryScope({ feature, role }, operation);
    const summary = summarize(value);
    provider = summary.provider === 'xai' ? 'grok' : summary.provider === 'google' ? 'gemini' : summary.provider;
    model = catalogModel(publicModels, provider, summary.model);
    outcome = summary.pending ? 'pending' : summary.success === false ? 'failed' : 'succeeded';
    return value;
  } catch (error) {
    if (signal?.aborted) outcome = 'cancelled';
    throw error;
  } finally {
    const dimensions = normalizeDimensions({ ...parent, role, feature, outcome, provider, model });
    recordTelemetry('feature.used', {}, {
      dimensions, measurements: { durationMs: Math.round(performance.now() - start), durationReports: 1 },
    });
  }
}

function retryDelay(failures: number, retryAfter?: string, pause = false) {
  const ceiling = Math.min(300_000, 2_000 * 2 ** Math.min(failures, 8));
  const delay = Math.max(pause ? 60_000 : 0, Math.round(ceiling * (0.5 + Math.random() * 0.5)));
  if (!retryAfter) return delay;
  const requested = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1_000 : Date.parse(retryAfter) - Date.now();
  return Number.isFinite(requested) ? Math.max(delay, Math.min(requested, 86_400_000)) : delay;
}

async function tick() {
  if (!enabled(true)) {
    state.inFlight?.abort();
    return;
  }
  if (state.inFlight) return;
  const now = Date.now();
  if (now - state.configReadAt >= 60_000) {
    state.configReadAt = now;
    state.postHog = readPostHogConfig();
  }
  const config = state.postHog;
  const batch = withStore(store => {
    if (now >= state.maintenanceAt) {
      store.prune(now);
      store.recoverTurns();
      state.maintenanceAt = now + 60_000;
    }
    heartbeat(store, now);
    const leased = config ? store.acquire(now) : undefined;
    return leased ? { ...leased, token: store.token } : undefined;
  });
  if (!config || !batch) return;

  const controller = new AbortController();
  state.inFlight = controller;
  let result: CaptureReceipt;
  try {
    result = await sendToPostHog(config, batch, AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]));
  } catch {
    result = { settled: [], dropped: 0, failure: 'transport' };
  }
  state.inFlight = undefined;
  const failures = result.failure ? Math.min(batch.failures + 1, 20) : 0;
  const nowAfter = Date.now();
  const remaining = result.settled.length < batch.events.length;
  const paused = ['http_400', 'http_401', 'http_402', 'http_403', 'http_415', 'invalid_receipt'].includes(result.failure ?? '');
  const externalDelay = result.failure || result.retryAfter ? retryDelay(failures, result.retryAfter, paused) : 0;
  const retryAt = nowAfter + (remaining ? Math.max(externalDelay, retryDelay(batch.attempts)) : 0);
  const catchUp = !result.failure && batch.events.length === BATCH_LIMIT;
  const cooldownAt = nowAfter + (externalDelay || (catchUp ? CATCH_UP_MS : 0));
  withStore(store => store.release(batch, result.settled, retryAt, cooldownAt, failures));
  if ((result.failure || result.dropped) && nowAfter >= state.nextDeliveryWarning && !controller.signal.aborted) {
    state.nextDeliveryWarning = nowAfter + 60_000;
    console.warn('[Telemetry] PostHog delivery status:', result.failure ?? 'events_rejected', result.dropped);
  }
  if (catchUp) setTimeout(() => void tick(), CATCH_UP_MS + Math.random() * 750).unref();
}

function heartbeat(store: ReturnType<typeof openOutbox>, now: number) {
  if (now < state.heartbeatAt) return;
  store.record(makeEvent(store.token, 'server.boot.heartbeat', {}, undefined, { boot: state.heartbeatAt === 0 }));
  state.heartbeatAt = now + HEARTBEAT_MS;
}

export function initializeTelemetry() {
  if (state.timer || process.env.NEXT_PHASE === 'phase-production-build') return;
  state.timer = setInterval(() => void tick(), TICK_MS + Math.random() * 3_000);
  state.timer.unref();
  if (enabled()) withStore(store => heartbeat(store, Date.now()));
}
