import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getEterxWorkspaceDir } from '../agent/storage-paths';

export type ConnectorKind = 'rest' | 'oauth' | 'native';

export type ConnectorRecord = {
  id: string;
  kind: ConnectorKind;
  connected: boolean;
  baseUrl?: string;
  healthPath?: string;
  authHeader?: string;
  tokenPrefix?: string;
  credentials?: Record<string, string>;
  metadata?: Record<string, unknown>;
  connectedAt?: number;
  lastCheckedAt?: number;
  lastError?: string;
};

export type McpServerRecord = {
  id: string;
  name: string;
  transport: 'stdio' | 'streamable-http';
  endpoint?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  enabled: boolean;
  connectedAt?: number;
  lastCheckedAt?: number;
  lastError?: string;
};

type ConnectorStoreData = {
  version: 2;
  connectors: Record<string, ConnectorRecord>;
  mcpServers: Record<string, McpServerRecord>;
};

const ENCRYPTED_FILE = '.connectors.enc.json';
const LEGACY_FILE = '.connectors.json';

function storePath(fileName: string): string {
  return path.join(getEterxWorkspaceDir(), fileName);
}

function encryptionKey(): Buffer {
  // Packaged Electron supplies a random key protected by safeStorage. The
  // deterministic fallback keeps source/dev installs portable; users should
  // set ETERX_CONNECTOR_SECRET when running a shared server in production.
  const configured = String(process.env.ETERX_CONNECTOR_SECRET || '').trim();
  const fallback = `${process.env.ETERX_DATA_DIR || getEterxWorkspaceDir()}:eterx-connector-store-v2`;
  return crypto.createHash('sha256').update(configured || fallback).digest();
}

function emptyStore(): ConnectorStoreData {
  return { version: 2, connectors: {}, mcpServers: {} };
}

function normalizeLegacy(raw: unknown): ConnectorStoreData {
  const result = emptyStore();
  if (!raw || typeof raw !== 'object') return result;
  for (const [id, value] of Object.entries(raw as Record<string, any>)) {
    if (!value || typeof value !== 'object') continue;
    const credentials: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /token|secret|password|key|credential/i.test(key)) credentials[key] = item;
    }
    result.connectors[id] = {
      id,
      kind: id === 'slack' ? 'oauth' : 'rest',
      connected: value.connected === true,
      baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : undefined,
      credentials,
      metadata: Object.fromEntries(Object.entries(value).filter(([key]) => !credentials[key] && !['connected', 'baseUrl'].includes(key))),
      connectedAt: typeof value.connectedAt === 'number' ? value.connectedAt : undefined,
    };
  }
  return result;
}

function encrypt(data: ConnectorStoreData): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
}

function decrypt(raw: string): ConnectorStoreData {
  const envelope = JSON.parse(raw);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(String(envelope.iv), 'base64'));
  decipher.setAuthTag(Buffer.from(String(envelope.tag), 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(String(envelope.data), 'base64')), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(plaintext);
  return {
    ...emptyStore(),
    ...(parsed && typeof parsed === 'object' ? parsed : {}),
    connectors: parsed?.connectors && typeof parsed.connectors === 'object' ? parsed.connectors : {},
    mcpServers: parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {},
  };
}

function readStore(): ConnectorStoreData {
  try {
    if (fs.existsSync(storePath(ENCRYPTED_FILE))) return decrypt(fs.readFileSync(storePath(ENCRYPTED_FILE), 'utf8'));
  } catch (error) {
    console.warn('[connectors] encrypted store could not be read:', error instanceof Error ? error.message : error);
  }
  try {
    if (fs.existsSync(storePath(LEGACY_FILE))) return normalizeLegacy(JSON.parse(fs.readFileSync(storePath(LEGACY_FILE), 'utf8')));
  } catch (error) {
    console.warn('[connectors] legacy store could not be read:', error instanceof Error ? error.message : error);
  }
  return emptyStore();
}

function writeStore(data: ConnectorStoreData): void {
  const target = storePath(ENCRYPTED_FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, encrypt(data), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function listConnectorRecords(): ConnectorRecord[] {
  return Object.values(readStore().connectors);
}

export function getConnectorRecord(id: string): ConnectorRecord | null {
  return readStore().connectors[String(id)] || null;
}

export function saveConnectorRecord(record: ConnectorRecord): ConnectorRecord {
  const data = readStore();
  data.connectors[record.id] = { ...record, id: record.id.trim() };
  writeStore(data);
  return data.connectors[record.id];
}

export function removeConnectorRecord(id: string): boolean {
  const data = readStore();
  const existed = Boolean(data.connectors[String(id)]);
  delete data.connectors[String(id)];
  if (existed) writeStore(data);
  return existed;
}

export function listMcpServerRecords(): McpServerRecord[] {
  return Object.values(readStore().mcpServers);
}

export function getMcpServerRecord(id: string): McpServerRecord | null {
  return readStore().mcpServers[String(id)] || null;
}

export function saveMcpServerRecord(record: McpServerRecord): McpServerRecord {
  const data = readStore();
  data.mcpServers[record.id] = { ...record, id: record.id.trim() };
  writeStore(data);
  return data.mcpServers[record.id];
}

export function removeMcpServerRecord(id: string): boolean {
  const data = readStore();
  const existed = Boolean(data.mcpServers[String(id)]);
  delete data.mcpServers[String(id)];
  if (existed) writeStore(data);
  return existed;
}

export function redactConnector(record: ConnectorRecord | McpServerRecord): Record<string, unknown> {
  const value: Record<string, unknown> = { ...record };
  delete value.credentials;
  delete value.headers;
  delete value.env;
  return value;
}

