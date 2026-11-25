import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import bundledRates from '../src/lib/usage/bundled-rates.json' with { type: 'json' };
import {
  BATCH_LIMIT, BODY_LIMIT, EVENT_ID, INSTALL_TOKEN, TELEMETRY_PATH, TELEMETRY_VERSION, catalogModel, isObject, parseEvent,
} from '../src/lib/telemetry/protocol.ts';
import { acceptEvents, initializeDatabase, openPool } from './database.mjs';
import { breakdown, installationBreakdown, overview } from './reports.mjs';

function envInteger(name, defaultValue, max) {
  const value = Number(process.env[name] ?? defaultValue);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer between 1 and ${max}`);
  return value;
}

const poolSize = envInteger('TELEMETRY_POOL_SIZE', 16, 128);
const reportConcurrency = 4;
const host = process.env.TELEMETRY_HOST || '127.0.0.1';
const port = envInteger('TELEMETRY_PORT', 4318, 65535);
const adminPort = envInteger('TELEMETRY_ADMIN_PORT', 4319, 65535);
const maxInstallsPerMinute = envInteger('TELEMETRY_INSTALLS_PER_MINUTE', 75000, 500000);
const adminSecret = process.env.TELEMETRY_ADMIN_TOKEN ?? '';
if (adminSecret.length < 32) throw new Error('TELEMETRY_ADMIN_TOKEN must contain at least 32 characters');
const adminDigest = createHash('sha256').update(adminSecret).digest();
const pool = openPool(poolSize);
const reportsPool = openPool(reportConcurrency);
const reports = new Map([
  ['/v1/analytics/overview', overview],
  ['/v1/analytics/breakdown', breakdown],
  ['/v1/analytics/installations', installationBreakdown],
]);

let inFlight = 0;
let adminInFlight = 0;
let minute = 0;
const installRequests = new Map();

function send(response, status, value, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...headers,
  });
  response.end(JSON.stringify(value));
}

function reject(request, response, status, error, headers = {}) {
  request.resume();
  send(response, status, { error }, headers);
}

function installationId(authorization) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return;
  const token = authorization.slice(7);
  if (!INSTALL_TOKEN.test(token)) return;
  return createHash('sha256').update('eterx-installation\0').update(Buffer.from(token, 'hex')).digest('hex').slice(0, 32);
}

function withinRateLimit(installation, now) {
  const bucket = Math.floor(now / 60_000);
  if (bucket !== minute) {
    minute = bucket;
    installRequests.clear();
  }
  const count = installRequests.get(installation) ?? 0;
  if (count >= 60 || (!count && installRequests.size >= maxInstallsPerMinute)) return false;
  installRequests.set(installation, count + 1);
  return true;
}

async function readBatch(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > BODY_LIMIT) return { status: 413, error: 'batch_too_large' };
    chunks.push(chunk);
  }
  try { return { value: JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) }; }
  catch { return { status: 400, error: 'invalid_json' }; }
}

async function ingest(request, response) {
  const installation = installationId(request.headers.authorization);
  if (!installation) return reject(request, response, 401, 'installation_credential_required');
  if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
      || request.headers['content-encoding']) return reject(request, response, 415, 'json_required');
  if (Number(request.headers['content-length']) > BODY_LIMIT) {
    return reject(request, response, 413, 'batch_too_large', { connection: 'close' });
  }
  if (inFlight >= poolSize * 4) return reject(request, response, 503, 'receiver_busy', { 'retry-after': '5', connection: 'close' });
  if (!withinRateLimit(installation, Date.now())) {
    return reject(request, response, 429, 'installation_rate_limit', { 'retry-after': '60', connection: 'close' });
  }

  inFlight++;
  try {
    const { status, error, value } = await readBatch(request);
    if (status) return reject(request, response, status, error, { connection: 'close' });
    if (!isObject(value)) return send(response, 400, { error: 'invalid_batch' });
    if (value.version !== TELEMETRY_VERSION) return send(response, 409, { error: 'unsupported_protocol' });
    if (!Array.isArray(value.events) || value.events.length < 1 || value.events.length > BATCH_LIMIT) {
      return send(response, 400, { error: 'invalid_batch' });
    }
    const seen = new Set();
    const accepted = [];
    const discarded = [];
    const events = [];
    const now = Date.now();
    for (const item of value.events) {
      if (!isObject(item) || typeof item.id !== 'string' || !EVENT_ID.test(item.id) || seen.has(item.id)) {
        return send(response, 400, { error: 'invalid_event_id' });
      }
      seen.add(item.id);
      const event = parseEvent(item, now);
      if (!event) {
        discarded.push(item.id);
        continue;
      }
      if (!catalogModel(bundledRates.providers, event.dimensions.provider, event.dimensions.model)) {
        delete event.dimensions.model;
      }
      accepted.push(item.id);
      events.push(event);
    }

    await acceptEvents(pool, installation, events);
    send(response, 200, { version: TELEMETRY_VERSION, accepted, discarded });
  } finally {
    inFlight--;
  }
}

async function publicRequest(request, response) {
  if (request.method === 'POST' && request.url === TELEMETRY_PATH) return ingest(request, response);
  if (request.method === 'GET' && request.url === '/healthz') return send(response, 200, { ok: true });
  if (request.method === 'GET' && request.url === '/readyz') {
    await pool.query('SELECT 1 FROM telemetry_rollup_queue LIMIT 1');
    return send(response, 200, { ok: true });
  }
  reject(request, response, 404, 'not_found');
}

async function adminRequest(request, response) {
  const authorization = request.headers.authorization ?? '';
  const digest = createHash('sha256').update(authorization.slice(7)).digest();
  if (!authorization.startsWith('Bearer ') || !timingSafeEqual(digest, adminDigest)) {
    return reject(request, response, 401, 'admin_credential_required');
  }
  const url = new URL(request.url, 'http://localhost');
  const report = reports.get(url.pathname);
  if (request.method !== 'GET' || !report) return reject(request, response, 404, 'not_found');
  if (adminInFlight >= reportConcurrency) return reject(request, response, 503, 'reports_busy', { 'retry-after': '5' });
  adminInFlight++;
  try {
    const data = await report(reportsPool, url.searchParams);
    if (!data) return send(response, 400, { error: 'invalid_report_parameters' });
    send(response, 200, data);
  } finally {
    adminInFlight--;
  }
}

function httpServer(handler) {
  return createServer({
    headersTimeout: 8_000, requestTimeout: 12_000, keepAliveTimeout: 5_000, connectionsCheckingInterval: 1_000,
    maxHeaderSize: 8_192,
  }, (request, response) => {
    void handler(request, response).catch(error => {
      if (response.destroyed || response.headersSent) return response.destroy();
      console.error('[Telemetry] Request could not complete', error.code ?? error.name);
      send(response, 503, { error: 'temporarily_unavailable' }, { 'retry-after': '5' });
    });
  });
}

function listen(server, address, listenPort) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, address, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

const receiver = httpServer(publicRequest);
const admin = httpServer(adminRequest);
async function close() {
  const closing = [receiver, admin].map(server => new Promise(resolve => server.close(resolve)));
  const timeout = setTimeout(() => {
    receiver.closeAllConnections();
    admin.closeAllConnections();
  }, 15_000);
  timeout.unref();
  await Promise.all(closing);
  clearTimeout(timeout);
  await Promise.all([pool.end(), reportsPool.end()]);
}

try {
  await initializeDatabase(pool);
  await listen(receiver, host, port);
  await listen(admin, process.env.TELEMETRY_ADMIN_HOST || host, adminPort);
  console.log(`[Telemetry] EterX receiver listening on ${port}, reports on ${adminPort}.`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void close(); });
} catch (error) {
  await close();
  throw error;
}
