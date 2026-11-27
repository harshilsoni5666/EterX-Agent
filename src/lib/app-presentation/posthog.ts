import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import appPackage from '../../../package.json';
import type { MainAgentProvider } from '../agent/model-routing';
import { isModelProvider } from '../agent/model-selector-store';
import { getProviderRuntime } from '../agent/provider-runtime';
import { getEterxDataDir } from '../agent/storage-paths';
import { readPostHogConfig } from '../telemetry/posthog';
import {
  decodeDisabledProviders, decodePresentation, EMPTY_PRESENTATION, isRecord, MAX_PRESENTATION_BYTES, PRESENTATION_FLAG, releaseVersion,
  type AppPresentation,
} from './contract';

const DEFAULT_INTERVAL = 60_000;
const BADGE_MAX_AGE = 60 * 60_000;
type PresentationRead = { data: AppPresentation; refreshAfterMs: number; announcementsCurrent: boolean };
type Cache = {
  identity: string;
  data: AppPresentation;
  refreshedAt: number;
  refreshAt: number;
  failures: number;
  providerFile: string;
  persisted: string;
  pending?: Promise<void>;
};
let cache: Cache | undefined;
const providerSessions = new Map<MainAgentProvider, AbortController>();

function providerName(value: unknown): MainAgentProvider | undefined {
  const normalized = value === 'google' ? 'gemini' : value === 'xai' ? 'grok' : value;
  return isModelProvider(normalized) ? normalized : undefined;
}

export class ProviderUnavailableError extends Error {
  readonly code = 'ETERX_PROVIDER_PAUSED';
  constructor(provider: MainAgentProvider) {
    super((getProviderRuntime(provider)?.label ?? provider) + ' is temporarily unavailable in EterX. Select another provider.');
    this.name = 'ProviderUnavailableError';
  }
}

function providerFile(identity: string) {
  const scope = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return join(getEterxDataDir(), 'settings', 'provider-availability-' + scope + '.json');
}

function restorePolicy(file: string): MainAgentProvider[] {
  try {
    const json = readFileSync(file, 'utf8');
    return json.length <= 4_096 ? decodeDisabledProviders(JSON.parse(json)) ?? [] : [];
  } catch { return []; }
}

function abortDisabledSessions(disabled: MainAgentProvider[]) {
  for (const provider of disabled) {
    const session = providerSessions.get(provider);
    if (!session) continue;
    providerSessions.delete(provider);
    session.abort(new ProviderUnavailableError(provider));
  }
}

async function persistPolicy(target: Cache, policy: MainAgentProvider[]) {
  const json = JSON.stringify(policy);
  if (target.persisted === json) return;
  const file = target.providerFile;
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(temp, json, { flag: 'wx', mode: 0o600 });
    await rename(temp, file);
    target.persisted = json;
  } catch {
    await rm(temp, { force: true }).catch(() => {});
  }
}

function normalInterval() {
  const seconds = Number(process.env.ETERX_APP_UPDATES_POLL_SECONDS);
  const ms = Number.isInteger(seconds) && seconds >= 60 && seconds <= 900 ? seconds * 1_000 : DEFAULT_INTERVAL;
  return ms + Math.floor(Math.random() * ms * 0.2);
}

function retryDelay(value: string | null) {
  if (!value) return 0;
  const ms = /^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(60 * 60_000, Math.max(0, ms)) : 0;
}

async function boundedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No remote config response.');
  const decoder = new TextDecoder();
  let size = 0;
  let json = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_PRESENTATION_BYTES * 2 + 32_768) throw new Error('Remote config response is too large.');
      json += decoder.decode(value, { stream: true });
    }
    return JSON.parse(json + decoder.decode()) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function refresh(target: Cache, config: NonNullable<ReturnType<typeof readPostHogConfig>>) {
  let retryAfter = 0;
  try {
    const response = await fetch(new URL('/flags?v=2', config.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        token: config.token,
        distinct_id: 'eterx-public-presentation',
        geoip_disable: true,
        flag_keys_to_evaluate: [PRESENTATION_FLAG],
      }),
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8_000),
    });
    retryAfter = retryDelay(response.headers.get('retry-after'));
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Remote config is unavailable.');
    }
    const envelope = await boundedJson(response);
    if (!isRecord(envelope) || !isRecord(envelope.flags) || envelope.errorsWhileComputingFlags === true
      || (Array.isArray(envelope.quotaLimited) && envelope.quotaLimited.includes('feature_flags'))) {
      throw new Error('Remote config could not be evaluated.');
    }
    const flag = envelope.flags[PRESENTATION_FLAG];
    let data = EMPTY_PRESENTATION;
    if (flag !== undefined) {
      if (!isRecord(flag) || typeof flag.enabled !== 'boolean') throw new Error('Invalid remote config flag.');
      if (flag.enabled) {
        const next = isRecord(flag.metadata) ? decodePresentation(flag.metadata.payload) : null;
        if (!next) throw new Error('Invalid remote config payload.');
        data = next;
      }
    }
    target.data = data;
    abortDisabledSessions(data.disabledProviders);
    target.refreshedAt = Date.now();
    target.refreshAt = target.refreshedAt + normalInterval();
    target.failures = 0;
    await persistPolicy(target, data.disabledProviders);
  } catch {
    target.failures = Math.min(target.failures + 1, 6);
    target.refreshAt = Date.now() + Math.max(retryAfter, Math.min(900_000, 30_000 * 2 ** (target.failures - 1)))
      + Math.floor(Math.random() * 10_000);
  }
}

export async function readAppPresentation(): Promise<PresentationRead> {
  const disabled = /^(?:0|false|off)$/i.test(process.env.ETERX_APP_UPDATES_ENABLED?.trim() ?? '');
  const config = disabled ? undefined : readPostHogConfig();
  if (!config) return { data: EMPTY_PRESENTATION, refreshAfterMs: 900_000, announcementsCurrent: true };

  const identity = config.endpoint.origin + '\n' + config.token;
  if (!cache || cache.identity !== identity) {
    const file = providerFile(identity);
    const disabledProviders = restorePolicy(file);
    cache = {
      identity, data: { ...EMPTY_PRESENTATION, disabledProviders }, refreshedAt: 0, refreshAt: 0,
      failures: 0, providerFile: file, persisted: JSON.stringify(disabledProviders),
    };
    abortDisabledSessions(disabledProviders);
  }
  const current = cache;
  if (!current.pending && Date.now() >= current.refreshAt) {
    current.pending = refresh(current, config).finally(() => { current.pending = undefined; });
  }
  await current.pending;
  const announcementsCurrent = current.failures === 0 && current.refreshedAt > 0;
  let data = announcementsCurrent ? current.data : {
    ...EMPTY_PRESENTATION,
    badges: Date.now() - current.refreshedAt <= BADGE_MAX_AGE ? current.data.badges : [],
    disabledProviders: current.data.disabledProviders,
  };
  const appVersion = releaseVersion(process.env.ETERX_APP_VERSION || appPackage.version);
  if (data.announcement && (data.announcement.paused
    || (data.announcement.versions.length > 0 && (!appVersion || !data.announcement.versions.includes(appVersion))))) {
    data = { ...data, announcement: null };
  }
  return { data, refreshAfterMs: Math.max(1_000, current.refreshAt - Date.now()), announcementsCurrent };
}

export async function providerAvailabilitySignal(value: unknown, signal?: AbortSignal) {
  const provider = providerName(value);
  if (!provider) return signal;
  const { data } = await readAppPresentation();
  if (data.disabledProviders.includes(provider)) throw new ProviderUnavailableError(provider);
  let controller = providerSessions.get(provider);
  if (!controller) {
    controller = new AbortController();
    providerSessions.set(provider, controller);
  }
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  combined.throwIfAborted();
  return combined;
}

export async function assertProviderAvailable(provider: unknown) {
  await providerAvailabilitySignal(provider);
}
