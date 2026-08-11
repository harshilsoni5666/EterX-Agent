import { spawn } from 'node:child_process';
import { URL } from 'node:url';
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
  const parsed = new URL(value, baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Connector URLs must use HTTP or HTTPS.');
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
    body: hasBody ? (typeof input.body === 'string' ? input.body : JSON.stringify(input.body)) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const raw = await response.text();
  const data = parseBody(response, raw);
  if (!response.ok) {
    const message = typeof data === 'object' && data ? (data as any).message || (data as any).error : data;
    throw new Error(`${record.id} API returned ${response.status}: ${String(message || raw || response.statusText).slice(0, 500)}`);
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

async function httpMcpRpc(server: ReturnType<typeof getMcpServerRecord>, method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<{ result: any; sessionId?: string }> {
  if (!server?.endpoint) throw new Error('MCP server endpoint is missing.');
  const id = cryptoRandomId();
  const response = await fetch(assertSafeUrl(server.endpoint), {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(server.headers || {}), ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`MCP server returned ${response.status}: ${raw.slice(0, 500)}`);
  const payload = findRpcPayload(raw, id) || (() => { try { return JSON.parse(raw); } catch { return null; } })();
  if (!payload) throw new Error('MCP server returned no JSON-RPC response.');
  if (payload.error) jsonRpcError(payload);
  return { result: payload.result, sessionId: response.headers.get('mcp-session-id') || undefined };
}

function cryptoRandomId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function stdioMcpRpc(server: ReturnType<typeof getMcpServerRecord>, requests: Array<{ id: string; method: string; params?: Record<string, unknown> }>): Promise<JsonRpcResponse[]> {
  if (!server?.command) throw new Error('stdio MCP server command is missing.');
  const command = process.platform === 'win32' && server.command === 'npx' ? 'npx.cmd' : server.command;
  const child = spawn(command, server.args || [], { shell: false, windowsHide: true, env: { ...process.env, ...(server.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const expected = new Set(requests.map((request) => request.id));
  const responses = new Map<string, JsonRpcResponse>();
  let stdout = '';
  let stderr = '';
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP stdio server timed out.')); }, 30000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      for (const line of stdout.split(/\r?\n/).slice(0, -1)) {
        try {
          const payload = JSON.parse(line);
          if (expected.has(String(payload?.id))) responses.set(String(payload.id), payload);
        } catch { /* ignore server logs on stdout */ }
      }
      stdout = stdout.split(/\r?\n/).pop() || '';
      if (responses.size === expected.size) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      if (responses.size !== expected.size) { clearTimeout(timer); reject(new Error(stderr.trim() || `MCP stdio server exited (${code ?? 'unknown'}).`)); }
    });
  });
  for (const request of requests) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...request })}\n`);
  await done;
  child.kill();
  return requests.map((request) => responses.get(request.id)!).filter(Boolean);
}

async function mcpRpc(serverId: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const server = getMcpServerRecord(serverId);
  if (!server?.enabled) throw new Error(`MCP server ${serverId} is not enabled.`);
  if (server.transport === 'stdio') {
    const initializeId = cryptoRandomId();
    const requestId = cryptoRandomId();
    const responses = await stdioMcpRpc(server, [
      { id: initializeId, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'eterx-agent', version: ETERX_CLIENT_VERSION } } },
      { id: requestId, method, params },
    ]);
    const response = responses.find((item) => String(item.id) === requestId);
    if (!response) throw new Error('MCP stdio server returned no response.');
    if (response.error) jsonRpcError(response);
    return response.result;
  }
  const initialize = await httpMcpRpc(server, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'eterx-agent', version: ETERX_CLIENT_VERSION } });
  const response = await httpMcpRpc(server, method, params, initialize.sessionId);
  return response.result;
}

export async function listConnectedMcpTools(serverId: string): Promise<any> {
  return mcpRpc(serverId, 'tools/list', {});
}

export async function callConnectedMcpTool(serverId: string, name: string, args: Record<string, unknown>): Promise<any> {
  return mcpRpc(serverId, 'tools/call', { name, arguments: args });
}

export function listConnectorRuntimeStatus(): Array<Record<string, unknown>> {
  return listMcpServerRecords().map(redactConnector);
}

export { DEFAULT_CONNECTOR_ENDPOINTS, WRITE_METHODS, authHeaders, connectorBaseUrl };
