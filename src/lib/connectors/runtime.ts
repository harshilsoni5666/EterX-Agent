import { spawn } from 'node:child_process';
import { URL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import appPackage from '../../../package.json';
import {
  ConnectorRecord,
  getConnectorRecord,
  getMcpServerRecord,
  listMcpServerRecords,
  redactConnector,
} from './store';

type JsonRpcResponse = { id?: string | number; result?: any; error?: { message?: string; code?: number } };
const ETERX_CLIENT_VERSION = String(appPackage.version || '0.0.0');

const DEFAULT_CONNECTOR_ENDPOINTS: Record<string, { baseUrl: string; healthPath: string; authHeader?: string; tokenPrefix?: string }> = {
  github: { baseUrl: 'https://api.github.com', healthPath: '/user', tokenPrefix: 'Bearer' },
  gitlab: { baseUrl: 'https://gitlab.com/api/v4', healthPath: '/user', tokenPrefix: 'Bearer' },
  discord: { baseUrl: 'https://discord.com/api/v10', healthPath: '/users/@me', tokenPrefix: 'Bot' },
  jira: { baseUrl: '', healthPath: '/rest/api/3/myself', authHeader: 'Authorization', tokenPrefix: 'Basic' },
  linear: { baseUrl: 'https://api.linear.app', healthPath: '/graphql', tokenPrefix: 'Bearer' },
  notion: { baseUrl: 'https://api.notion.com/v1', healthPath: '/users/me', tokenPrefix: 'Bearer' },
  airtable: { baseUrl: 'https://api.airtable.com/v0', healthPath: '', tokenPrefix: 'Bearer' },
  stripe: { baseUrl: 'https://api.stripe.com/v1', healthPath: '/balance', tokenPrefix: 'Bearer' },
  shopify: { baseUrl: '', healthPath: '/admin/api/2024-10/shop.json', authHeader: 'X-Shopify-Access-Token' },
  hubspot: { baseUrl: 'https://api.hubapi.com', healthPath: '/crm/v3/objects/contacts?limit=1', tokenPrefix: 'Bearer' },
  homeassistant: { baseUrl: '', healthPath: '/api/', authHeader: 'Authorization', tokenPrefix: 'Bearer' },
  telegram: { baseUrl: 'https://api.telegram.org', healthPath: '', tokenPrefix: 'Bearer' },
  whatsapp: { baseUrl: 'https://graph.facebook.com', healthPath: '', tokenPrefix: 'Bearer' },
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function assertSafeUrl(value: string, baseUrl?: string): URL {
  // Leading-slash tool paths are relative to the configured API root. Dropping
  // /api/v4 or /v1 here made valid saved connections call the wrong endpoint.
  const base = baseUrl ? new URL(baseUrl) : null;
  const basePath = base?.pathname.replace(/\/$/, '') || '';
  const alreadyRooted = base && value.startsWith('/') && basePath && (value === basePath || value.startsWith(`${basePath}/`) || value.startsWith(`${basePath}?`));
  const parsed = alreadyRooted
    ? new URL(value, baseUrl)
    : baseUrl && !/^https?:\/\//i.test(value)
      ? new URL(value.replace(/^\/+/, ''), `${baseUrl.replace(/\/$/, '')}/`)
      : new URL(value, baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Connector URLs must use HTTP or HTTPS.');
  if (parsed.username || parsed.password) throw new Error('Use the credential fields instead of credentials in a URL.');
  if (baseUrl) {
    const base = new URL(baseUrl);
    if (parsed.origin !== base.origin) throw new Error('Connector requests must stay on the configured API origin.');
  }
  return parsed;
}

function connectorDefaults(id: string): { baseUrl: string; healthPath: string; authHeader?: string; tokenPrefix?: string } {
  return DEFAULT_CONNECTOR_ENDPOINTS[id] || { baseUrl: '', healthPath: '', authHeader: 'Authorization', tokenPrefix: 'Bearer' };
}

function connectorBaseUrl(record: ConnectorRecord): string {
  return String(record.baseUrl || connectorDefaults(record.id).baseUrl || '').replace(/\/$/, '');
}

function authHeaders(record: ConnectorRecord): Record<string, string> {
  const credentials = record.credentials || {};
  const token = credentials.token
    || credentials.apiKey
    || credentials.accessToken
    || credentials.botToken
    || credentials.authToken
    || credentials.apiToken
    || credentials.bearerToken
    || credentials.channelAccessToken
    || credentials.credential
    || '';
  const defaults = connectorDefaults(record.id);
  const header = record.authHeader || defaults.authHeader || (token ? 'Authorization' : '');
  if (!token || !header) return {};
  const prefix = record.tokenPrefix ?? defaults.tokenPrefix;
  return { [header]: prefix ? `${prefix} ${token}` : token };
}

function redactCredentialValues(message: string, record: ConnectorRecord): string {
  let redacted = String(message || 'Connector request failed.');
  const secrets = Object.values(record.credentials || {})
    .map(value => String(value || '').trim())
    .filter(value => value.length >= 4)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) redacted = redacted.split(secret).join('[redacted]');
  return redacted.slice(0, 1000);
}

function parseBody(response: Response, raw: string): unknown {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('json')) {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

export async function callConnectorApi(
  connectorId: string,
  input: { method?: string; path?: string; query?: Record<string, string | number | boolean>; body?: unknown; headers?: Record<string, string> },
  options: { allowUnverified?: boolean } = {},
): Promise<{ status: number; headers: Record<string, string>; data: unknown }> {
  const record = getConnectorRecord(connectorId);
  if (!record || (!record.connected && !options.allowUnverified)) throw new Error(`Connector ${connectorId} is not connected.`);
  const baseUrl = connectorBaseUrl(record);
  if (!baseUrl) throw new Error(`Connector ${connectorId} needs an API base URL before the agent can call it.`);
  const url = assertSafeUrl(String(input.path || '/'), baseUrl);
  for (const [key, value] of Object.entries(input.query || {})) url.searchParams.set(key, String(value));
  const method = String(input.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error(`Unsupported connector method: ${method}`);
  const headers: Record<string, string> = { accept: 'application/json, text/plain, */*', ...authHeaders(record), ...(input.headers || {}) };
  const hasBody = input.body !== undefined && input.body !== null && method !== 'GET';
  if (hasBody && !headers['content-type']) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    redirect: 'error',
    body: hasBody ? (typeof input.body === 'string' ? input.body : JSON.stringify(input.body)) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const raw = await response.text();
  const data = parseBody(response, raw);
  if (!response.ok) {
    const message = typeof data === 'object' && data ? (data as any).message || (data as any).error : data;
    throw new Error(redactCredentialValues(`${record.id} API returned ${response.status}: ${String(message || raw || response.statusText).slice(0, 500)}`, record));
  }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    data,
  };
}

export async function testConnectorRecord(record: ConnectorRecord): Promise<{ ok: boolean; status: number; message: string }> {
  const baseUrl = connectorBaseUrl(record);
  if (!baseUrl) return { ok: false, status: 0, message: 'An API base URL is required for this connector.' };
  const defaults = connectorDefaults(record.id);
  let healthPath = String(record.healthPath || defaults.healthPath || '/');
  // Token-in-path APIs are supported without ever returning the expanded URL.
  if (record.id === 'telegram' && (record.credentials?.botToken || record.credentials?.token)) {
    healthPath = `/bot${record.credentials.botToken || record.credentials.token}/getMe`;
  }
  if (record.id === 'whatsapp' && record.credentials?.phoneNumberId) {
    healthPath = `/${record.credentials.phoneNumberId}`;
  }
  try {
    const result = await callConnectorApi(record.id, { method: 'GET', path: healthPath }, { allowUnverified: true });
    const type = result.headers['content-type'] || '';
    if (/text\/html/i.test(type) || (typeof result.data === 'string' && /^\s*(?:<!doctype html|<html)/i.test(result.data))) return { ok: false, status: result.status, message: 'The endpoint returned a web page. Use an authenticated API identity endpoint.' };
    const payload = asObject(result.data);
    if (payload.ok === false || payload.success === false || payload.error || (Array.isArray(payload.errors) ? payload.errors.length > 0 : payload.errors)) return { ok: false, status: result.status, message: 'The API rejected the request. Review the credential and identity endpoint.' };
    return { ok: true, status: result.status, message: 'Connection verified.' };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: redactCredentialValues(error instanceof Error ? error.message : String(error), record),
    };
  }
}

function jsonRpcError(response: JsonRpcResponse): never {
  throw new Error(response.error?.message || `MCP request failed (${response.error?.code || 'unknown'}).`);
}

function findRpcPayload(raw: string, id: string): JsonRpcResponse | null {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const candidate = line.startsWith('data:') ? line.slice(5).trim() : line;
    try {
      const parsed = JSON.parse(candidate);
      if (String(parsed?.id) === id) return parsed;
    } catch { /* stream keep-alive or non-JSON output */ }
  }
  return null;
}

async function httpMcpRpc(server: ReturnType<typeof getMcpServerRecord>, method: string, params: Record<string, unknown> = {}, sessionId?: string, protocolVersion?: string): Promise<{ result: any; sessionId?: string }> {
  if (!server?.endpoint) throw new Error('MCP server endpoint is missing.');
  const id = cryptoRandomId();
  const notification = method === 'notifications/initialized';
  const response = await fetch(assertSafeUrl(server.endpoint), {
    method: 'POST',
    redirect: 'error',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(server.headers || {}), ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}), ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`MCP server returned HTTP ${response.status}.`); }
  if (notification) { await response.body?.cancel(); return { result: null }; }
  let payload: JsonRpcResponse | null = null;
  if (response.headers.get('content-type')?.includes('text/event-stream') && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!payload) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        if (buffer.length > 8 * 1024 * 1024) throw new Error('MCP response exceeded the supported size.');
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || '';
        if (chunk.done && buffer) events.push(buffer);
        for (const event of events) {
          const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          try { const candidate = JSON.parse(data); if (String(candidate.id) === id) payload = candidate; } catch { /* keep-alive */ }
        }
        if (chunk.done) break;
      }
    } finally { await reader.cancel().catch(() => undefined); }
  } else {
    const raw = await response.text();
    payload = findRpcPayload(raw, id) || (() => { try { const parsed = JSON.parse(raw); return String(parsed?.id) === id ? parsed : null; } catch { return null; } })();
  }
  if (!payload) throw new Error('MCP server returned no JSON-RPC response.');
  if (payload.error) jsonRpcError(payload);
  return { result: payload.result, sessionId: response.headers.get('mcp-session-id') || undefined };
}

function cryptoRandomId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function stdioLaunch(server: NonNullable<ReturnType<typeof getMcpServerRecord>>) {
  let command = server.command || '';
  const args = [...(server.args || [])];
  if (process.platform !== 'win32') return { command, args };
  const name = path.basename(command).replace(/\.cmd$/i, '').toLowerCase();
  if (name === 'npx' || name === 'npm') {
    const directories = [path.dirname(command), path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter)];
    const cli = directories.map(directory => path.join(directory.replace(/^"|"$/g, ''), 'node_modules', 'npm', 'bin', `${name}-cli.js`)).find(candidate => existsSync(candidate));
    if (!cli) throw new Error('Could not locate the npm runtime. Install Node.js or use node.exe with the MCP server script as its first argument.');
    return { command: process.execPath, args: [cli, ...args] };
  }
  if (/\.(cmd|bat)$/i.test(command)) throw new Error('Use the executable or node.exe script behind this Windows command file. Shell command files are not supported as MCP transports.');
  return { command, args };
}

async function stdioMcpRpc(server: ReturnType<typeof getMcpServerRecord>, requests: Array<{ id: string; method: string; params?: Record<string, unknown> }>): Promise<JsonRpcResponse[]> {
  if (!server?.command) throw new Error('stdio MCP server command is missing.');
  const launch = stdioLaunch(server);
  const child = spawn(launch.command, launch.args, { shell: false, windowsHide: true, cwd: server.cwd || undefined, env: { ...process.env, ...(server.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const expected = new Set(requests.map(request => request.id));
  const responses = new Map<string, JsonRpcResponse>();
  let stdout = '';
  let initialized = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP stdio server timed out.')), 30000);
      const fail = (reason: Error) => { clearTimeout(timer); reject(reason); };
      child.stdin.on('error', fail);
      child.on('error', fail);
      child.on('exit', code => { if (responses.size !== expected.size) fail(new Error(`MCP stdio server exited before responding (${code ?? 'unknown'}).`)); });
      // Drain stderr without persisting arbitrary server output or credentials.
      child.stderr.resume();
      child.stdout.on('data', chunk => {
        stdout += String(chunk);
        if (stdout.length > 8 * 1024 * 1024) { fail(new Error('MCP response exceeded the supported size.')); return; }
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() || '';
        for (const line of lines) {
          let payload: JsonRpcResponse;
          try { payload = JSON.parse(line); } catch { continue; }
          if (!payload || !expected.has(String(payload.id))) continue;
          responses.set(String(payload.id), payload);
          if (String(payload.id) === requests[0].id && !initialized) {
            if (payload.error) { fail(new Error(payload.error.message || 'MCP initialization failed.')); return; }
            if (!['2025-06-18', '2025-03-26', '2024-11-05'].includes(payload.result?.protocolVersion)) { fail(new Error('The MCP server selected an unsupported protocol version.')); return; }
            initialized = true;
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
            for (const request of requests.slice(1)) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...request })}\n`);
          }
        }
        if (responses.size === expected.size) { clearTimeout(timer); resolve(); }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...requests[0] })}\n`);
    });
    return requests.map(request => responses.get(request.id)!).filter(Boolean);
  } finally { child.stdin.end(); child.kill(); }
}

async function mcpRpc(serverId: string, method: string, params: Record<string, unknown> = {}, allowDisabled = false): Promise<any> {
  const server = getMcpServerRecord(serverId);
  if (!server || (!server.enabled && !allowDisabled)) throw new Error(`MCP server ${serverId} is not enabled.`);
  try {
    if (server.transport === 'stdio') {
      const initializeId = cryptoRandomId();
      const requestId = cryptoRandomId();
      const responses = await stdioMcpRpc(server, [
        { id: initializeId, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'eterx-agent', version: ETERX_CLIENT_VERSION } } },
        { id: requestId, method, params },
      ]);
      const response = responses.find(item => String(item.id) === requestId);
      if (!response) throw new Error('MCP stdio server returned no response.');
      if (response.error) jsonRpcError(response);
      return response.result;
    }
    const initialize = await httpMcpRpc(server, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'eterx-agent', version: ETERX_CLIENT_VERSION } });
    const version = String(initialize.result?.protocolVersion || '');
    if (!['2025-06-18', '2025-03-26'].includes(version)) throw new Error('The MCP server selected an unsupported HTTP protocol version.');
    await httpMcpRpc(server, 'notifications/initialized', {}, initialize.sessionId, version);
    const response = await httpMcpRpc(server, method, params, initialize.sessionId, version);
    return response.result;
  } catch (reason) {
    let message = reason instanceof Error ? reason.message : String(reason);
    const secrets = [...Object.values(server.headers || {}), ...Object.values(server.env || {})];
    for (const value of secrets) {
      for (const secret of [value, value.replace(/^(?:Bearer|Basic|Bot)\s+/i, '')]) if (secret.length >= 4) message = message.split(secret).join('[redacted]');
    }
    throw new Error(message.slice(0, 1000));
  }
}

export async function listConnectedMcpTools(serverId: string, options: { allowDisabled?: boolean } = {}): Promise<any> {
  const result = await mcpRpc(serverId, 'tools/list', {}, options.allowDisabled === true);
  if (!Array.isArray(result?.tools)) throw new Error('The MCP server returned an invalid tools list.');
  return result;
}
export async function callConnectedMcpTool(serverId: string, name: string, args: Record<string, unknown>): Promise<any> {
  return mcpRpc(serverId, 'tools/call', { name, arguments: args });
}

export function listConnectorRuntimeStatus(): Array<Record<string, unknown>> {
  return listMcpServerRecords().map(redactConnector);
}

export { DEFAULT_CONNECTOR_ENDPOINTS, WRITE_METHODS, authHeaders, connectorBaseUrl };
