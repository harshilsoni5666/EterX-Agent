import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import appPackage from '../../../package.json';
import { getEterxDataDir } from '../agent/storage-paths';
import bundledRates from '../usage/bundled-rates.json';
import { openOutbox } from './outbox';
import {
  BATCH_LIMIT, TELEMETRY_VERSION, catalogModel, isObject, normalizeDimensions, normalizeMeasurements, telemetryEndpoint,
  type DimensionInput, type Dimensions, type Measurements, type TelemetryEvent, type TelemetryEventName,
} from './protocol';

type Scope = { dimensions: Dimensions; turnId?: string; turnFeature?: Dimensions['feature'] };
type Outcome = NonNullable<Dimensions['outcome']>;
type Feature = NonNullable<Dimensions['feature']>;
const TICK_MS = 5_000;
const HEARTBEAT_MS = 10 * 60_000;
const CATCH_UP_MS = 1_250;
const globalState = globalThis as typeof globalThis & {
  __eterxProductTelemetry?: {
    scope: AsyncLocalStorage<Scope>;
    store?: ReturnType<typeof openOutbox>;
    timer?: ReturnType<typeof setInterval>;
    inFlight?: AbortController;
    heartbeatAt: number;
    maintenanceAt: number;
    retryStorageAt: number;
    preference: { checkedAt: number; signature?: string; enabled: boolean };
  };
};
const state = globalState.__eterxProductTelemetry ??= {
  scope: new AsyncLocalStorage<Scope>(),
  heartbeatAt: 0, maintenanceAt: 0, retryStorageAt: 0,
  preference: { checkedAt: 0, enabled: false },
};

const publicModels = bundledRates.providers as Record<string, Record<string, unknown>>;

function enabled(refresh = false): boolean {
  const policy = process.env.ETERX_TELEMETRY_ENABLED?.trim().toLowerCase();
  if (policy === 'false' || policy === 'true') return policy === 'true';
  const now = Date.now();
  if (!refresh && now - state.preference.checkedAt < 1_000) return state.preference.enabled;
  try {
    const file = path.join(getEterxDataDir(), 'settings', 'preferences.json');
    const stat = statSync(file);
    const signature = [stat.ino, stat.mtimeMs, stat.size].join(':');
    if (signature !== state.preference.signature) {
      const preferences = JSON.parse(readFileSync(file, 'utf8'));
      const settings = JSON.parse(preferences.eterx_settings || '{}');
      state.preference = { checkedAt: now, signature, enabled: settings.telemetry === true };
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

function runtimeDimensions(): Dimensions {
  const version = process.env.ETERX_APP_VERSION || appPackage.version;
  const platform = ['darwin', 'win32', 'linux'].includes(process.platform) ? process.platform : 'other';
  const arch = ['arm64', 'x64'].includes(process.arch) ? process.arch : 'other';
  return normalizeDimensions({
    platform, arch, version,
    runtime: process.env.ETERX_DESKTOP_PARENT_PID || process.env.ETERX_DESKTOP_DEV === '1' ? 'desktop' : 'server',
    channel: process.env.NODE_ENV !== 'production' ? 'development' : version.includes('-') ? 'preview' : 'stable',
  });
}

function eventId(token: string, name: TelemetryEventName, localKey?: string) {
  return localKey ? createHmac('sha256', token).update(JSON.stringify([name, localKey])).digest('hex').slice(0, 32)
    : randomBytes(16).toString('hex');
}

function makeEvent(
  token: string, name: TelemetryEventName, dimensions: Dimensions, measurements?: Measurements, localKey?: string, at = Date.now(),
): TelemetryEvent {
  return { id: eventId(token, name, localKey), at, name, dimensions: { ...runtimeDimensions(), ...dimensions }, measurements };
}

function record(name: TelemetryEventName, dimensions: Dimensions, measurements?: Measurements, localKey?: string, turnId?: string, at?: number) {
  if (!enabled()) return;
  initializeTelemetry();
  withStore(store => store.record(makeEvent(store.token, name, dimensions, measurements, localKey, at), turnId));
}

export function withTelemetryScope<T>(dimensions: DimensionInput, run: () => T): T {
  const parent = state.scope.getStore();
  return state.scope.run({ ...parent, dimensions: { ...parent?.dimensions, ...normalizeDimensions(dimensions) } }, run);
}

export function beginTelemetryTurn(localKey: string, input: DimensionInput) {
  const dimensions = normalizeDimensions({ ...input, role: 'main', model: catalogModel(publicModels, input.provider, input.model) });
  let turnId: string | undefined;
  if (enabled()) {
    initializeTelemetry();
    turnId = withStore(store => {
      const requested = makeEvent(store.token, 'turn.requested', dimensions, undefined, localKey);
      return store.beginTurn(requested, eventId(store.token, 'turn.finished', localKey)) ? requested.id : undefined;
    });
  }
  return {
    run<T>(operation: () => T): T {
      return state.scope.run({ dimensions, turnId, turnFeature: dimensions.feature }, operation);
    },
    finish(outcome: 'succeeded' | 'failed' | 'cancelled') {
      if (turnId && enabled()) {
        const id = turnId;
        withStore(store => store.finishTurn(id, outcome));
      }
    },
  };
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
  at?: number;
  outcome: Outcome;
  error?: Dimensions['error'];
  feature?: Feature;
  measurements: Measurements;
}) {
  const scope = state.scope.getStore();
  const provider = normalizeDimensions({ provider: input.provider }).provider ?? 'unknown';
  const role = scope?.dimensions.role ?? 'auxiliary';
  const feature = input.feature ?? scope?.dimensions.feature;
  const dimensions = normalizeDimensions({
    ...scope?.dimensions, provider, model: catalogModel(publicModels, provider, input.model), role,
    feature, outcome: input.outcome, error: input.error,
  });
  record('model.request', dimensions, normalizeMeasurements({
    ...input.measurements, requests: 1, durationReports: Number(input.measurements.durationMs !== undefined),
  }), input.id, role === 'main' && feature === scope?.turnFeature ? scope?.turnId : undefined, input.at);
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
    record('feature.used', dimensions, { durationMs: Math.round(performance.now() - start), durationReports: 1 });
  }
}

function acknowledgedIds(value: unknown, sent: TelemetryEvent[]) {
  if (!isObject(value) || value.version !== TELEMETRY_VERSION || !Array.isArray(value.accepted) || !Array.isArray(value.discarded)) return;
  const expected = new Set(sent.map(event => event.id));
  const ids = [...value.accepted, ...value.discarded];
  if (ids.length !== expected.size || !ids.every(id => typeof id === 'string' && expected.delete(id)) || expected.size) return;
  return ids as string[];
}

function retryDelay(failures: number, retryAfter: string | null) {
  const ceiling = Math.min(300_000, 2_000 * 2 ** Math.min(failures, 8));
  const delay = Math.round(ceiling * (0.5 + Math.random() * 0.5));
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
  const url = telemetryEndpoint(process.env.ETERX_TELEMETRY_URL, true);
  const batch = withStore(store => {
    if (now >= state.maintenanceAt) {
      store.prune(now);
      store.recoverTurns();
      state.maintenanceAt = now + 60_000;
    }
    heartbeat(store, now);
    const leased = url ? store.acquire(now) : undefined;
    return leased ? { ...leased, token: store.token } : undefined;
  });
  if (!url || !batch) return;

  const controller = new AbortController();
  state.inFlight = controller;
  let accepted: string[] | undefined;
  let retryAfter: string | null = null;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${batch.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: TELEMETRY_VERSION, events: batch.events }),
      redirect: 'error',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
    });
    retryAfter = response.headers.get('retry-after');
    if (response.ok) accepted = acknowledgedIds(await response.json(), batch.events);
    else await response.body?.cancel();
  } catch { /* An interrupted send retains the original event IDs and timestamps. */ }
  finally {
    state.inFlight = undefined;
    const failures = accepted ? 0 : Math.min(batch.failures + 1, 20);
    const catchUp = accepted && batch.events.length === BATCH_LIMIT;
    const delay = accepted ? catchUp ? CATCH_UP_MS : 0 : retryDelay(failures, retryAfter);
    withStore(store => store.release(batch.lease, accepted ?? [], Date.now() + delay, failures));
    if (catchUp) setTimeout(() => void tick(), CATCH_UP_MS + Math.random() * 750).unref();
  }
}

function heartbeat(store: ReturnType<typeof openOutbox>, now: number) {
  if (now < state.heartbeatAt) return;
  const name = state.heartbeatAt ? 'app.heartbeat' : 'app.started';
  store.record(makeEvent(store.token, name, {}));
  state.heartbeatAt = now + HEARTBEAT_MS;
}

export function initializeTelemetry() {
  if (state.timer) return;
  state.timer = setInterval(() => void tick(), TICK_MS + Math.random() * 3_000);
  state.timer.unref();
  if (enabled()) withStore(store => heartbeat(store, Date.now()));
}
