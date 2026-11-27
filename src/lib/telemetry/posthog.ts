import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv, promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { getEterxAppRoot } from '../agent/storage-paths';
import {
  DEFAULT_POSTHOG_HOST, canonicalEventName, countsAsActivity, formatEventId, isObject, isPostHogProjectToken,
  postHogEndpoint, productUserAgent, propertiesFromEvent, restrictModelProperties, type TelemetryEvent,
} from './protocol';
import bundledRates from '../usage/bundled-rates.json';

const CLIENT = 'eterx-telemetry/2.0.0';
const compress = promisify(gzip);
const release = globalThis as typeof globalThis & {
  __eterxPostHogRelease?: { token: string; host: string };
};

export function readPostHogConfig() {
  let local: Partial<Record<string, string>> = {};
  if (process.env.NODE_ENV !== 'production') {
    try { local = parseEnv(readFileSync(path.join(getEterxAppRoot(), 'telemetry', '.env.local'), 'utf8')); }
    catch { /* The local project configuration is optional. */ }
  }
  const token = (process.env.ETERX_POSTHOG_PROJECT_TOKEN ?? release.__eterxPostHogRelease?.token
    ?? local.ETERX_POSTHOG_PROJECT_TOKEN ?? '').trim();
  const host = (process.env.ETERX_POSTHOG_HOST ?? release.__eterxPostHogRelease?.host
    ?? local.ETERX_POSTHOG_HOST ?? '').trim() || DEFAULT_POSTHOG_HOST;
  const endpoint = postHogEndpoint(host);
  return endpoint && isPostHogProjectToken(token) ? { endpoint, token } : undefined;
}

type Config = NonNullable<ReturnType<typeof readPostHogConfig>>;
type Batch = { requestId: string; attempts: number; events: TelemetryEvent[]; token: string };

function installationId(token: string) {
  return createHash('sha256').update('eterx-installation\0').update(Buffer.from(token, 'hex')).digest('hex').slice(0, 32);
}

// Include the installation namespace so the same UUID is stable across every retry.
function eventUuid(installation: string, event: TelemetryEvent) {
  const bytes = createHash('sha256').update(installation).update(event.id).update(String(event.at)).digest().subarray(0, 16);
  bytes.writeUIntBE(event.at, 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatEventId(bytes.toString('hex'));
}

function utc(at: number | undefined) {
  return typeof at === 'number' && Number.isSafeInteger(at) && at > 0 && at < 253402300800000
    ? new Date(at).toISOString() : undefined;
}

function captureEvent(installation: string, event: TelemetryEvent) {
  const name = canonicalEventName(event.name);
  const timestamp = utc(event.at);
  if (!name || !timestamp) return;
  const properties = restrictModelProperties(propertiesFromEvent(event), bundledRates.providers);
  if ((event.name as string) === 'app.started') properties.boot = true;
  if ((event.name as string) === 'app.heartbeat') properties.boot = false;
  properties.installId = formatEventId(installation);
  if (name === 'install.owner_observed' && properties.ownerSource === 'local_profile' && properties.serverMode === 'desktop') {
    properties.ownerId = formatEventId(createHash('sha256').update('eterx-local-owner\0').update(installation).digest('hex').slice(0, 32));
  }
  return {
    uuid: eventUuid(installation, event), event: name, distinct_id: properties.installId, timestamp,
    options: { process_person_profile: false, disable_skew_correction: true },
    properties: {
      ...properties,
      received_at: utc(event.receivedAt), inserted_at: utc(event.insertedAt),
      user_agent: productUserAgent(properties), to_posthog: true,
      activeUse: countsAsActivity(event), $geoip_disable: true,
    },
  };
}

export type CaptureReceipt = {
  settled: string[];
  dropped: number;
  retryAfter?: string;
  failure?: string;
};

export async function sendToPostHog(config: Config, batch: Batch, signal: AbortSignal): Promise<CaptureReceipt> {
  const installation = installationId(batch.token);
  const events = new Map<string, { localId: string; event: NonNullable<ReturnType<typeof captureEvent>> }>();
  const settled: string[] = [];
  for (const local of batch.events) {
    const event = captureEvent(installation, local);
    if (event) events.set(event.uuid, { localId: local.id, event });
    else settled.push(local.id);
  }
  let dropped = settled.length;
  if (!events.size) return { settled, dropped };
  const body = await compress(JSON.stringify({
    created_at: new Date().toISOString(), batch: [...events.values()].map(item => item.event),
  }));
  const response = await fetch(config.endpoint, {
    method: 'POST', body: new Uint8Array(body), redirect: 'error', cache: 'no-store', signal,
    headers: {
      authorization: `Bearer ${config.token}`, 'content-type': 'application/json', 'content-encoding': 'gzip',
      'user-agent': CLIENT, 'posthog-sdk-info': CLIENT,
      'posthog-request-id': batch.requestId, 'posthog-attempt': String(batch.attempts),
      'posthog-request-timestamp': new Date().toISOString(),
    },
  });
  const retryAfter = response.headers.get('retry-after') ?? undefined;
  if (response.status !== 200) {
    await response.body?.cancel();
    return { settled, dropped, retryAfter, failure: `http_${response.status}` };
  }
  const receipt: unknown = await response.json();
  if (!isObject(receipt) || !isObject(receipt.results)) return { settled, dropped, retryAfter, failure: 'invalid_receipt' };
  for (const [uuid, item] of events) {
    const result = receipt.results[uuid];
    if (!isObject(result)) continue;
    if (result.result === 'ok' || result.result === 'warning' || result.result === 'drop') settled.push(item.localId);
    if (result.result === 'drop') dropped++;
  }
  return { settled, dropped, retryAfter };
}
