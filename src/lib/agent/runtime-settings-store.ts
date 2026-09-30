import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEterxDataDir } from './storage-paths';
import type { SearchSettings } from '../search/search-config';
import { normalizeImageSettings, type ImageSettings } from '../image/image-generation-config';
import { normalizeVideoSettings, type VideoSettings } from '../video/video-generation-config';
import { normalizeApiRetries } from './api-retry';
import { normalizeAgentToolSettings, type AgentToolSettings } from './builtin-agent-settings';

export type StoredRuntimeSettings = {
  agentTools?: AgentToolSettings;
  apiRetries?: number;
  apiKeys?: Record<string, string | string[]>;
  liveApiKeys?: Record<string, string | string[]>;
  modelApiKeys?: Record<string, string>;
  modelOverrides?: Record<string, string>;
  baseURLs?: Record<string, string>;
  search?: SearchSettings;
  image?: ImageSettings;
  video?: VideoSettings;
  selfImprovement?: {
    enabled: boolean;
  };
};

const SETTINGS_DIR = path.join(getEterxDataDir(), 'settings');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'runtime-settings.bin');
const SETTINGS_BACKUP_FILE = path.join(SETTINGS_DIR, 'runtime-settings.backup.bin');

const replaceFileWithRetry = async (temporary: string, target: string) => {
  let lastError: unknown = null;
  // Windows can briefly keep the old file open while Defender, indexing, or
  // the packaged runtime is reading it. Keep the old backup intact and retry
  // the small replace window instead of failing an otherwise safe update.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      if (process.platform === 'win32') {
        fs.rmSync(target, { force: true, maxRetries: 3, retryDelay: 100 });
      }
      fs.renameSync(temporary, target);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        await new Promise(resolve => setTimeout(resolve, 80 * (attempt + 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not atomically replace runtime settings.');
};

const fileRevision = (source: string) => {
  try {
    const stat = fs.statSync(source);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
};

/**
 * Cheap change marker used by server entry points. It lets a long-lived
 * Next/Electron process pick up a settings write from another window without
 * re-applying the key pool on every request.
 */
export function getStoredRuntimeSettingsRevision(): string {
  return `${fileRevision(SETTINGS_FILE)}|${fileRevision(SETTINGS_BACKUP_FILE)}`;
}

const runtimeSettingsGlobal = globalThis as typeof globalThis & {
  __eterxRuntimeSettingsWriteChain?: Promise<void>;
};

const preserveCorruptRuntimeSettings = (source: string) => {
  if (source !== SETTINGS_FILE || !fs.existsSync(source)) return;
  const preserved = path.join(SETTINGS_DIR, `runtime-settings.corrupt-${Date.now()}.bin`);
  try { fs.renameSync(source, preserved); } catch { }
};

const encryptionKey = () => crypto.createHash('sha256')
  .update(`EterX runtime settings\0${os.userInfo().username}\0${os.hostname()}\0${getEterxDataDir()}`)
  .digest();

const normalizeStoredSettings = (value: unknown): StoredRuntimeSettings => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return {
    agentTools: normalizeAgentToolSettings(source.agentTools),
    apiRetries: normalizeApiRetries(source.apiRetries),
    apiKeys: source.apiKeys && typeof source.apiKeys === 'object' && !Array.isArray(source.apiKeys)
      ? source.apiKeys as Record<string, string | string[]>
      : {},
    liveApiKeys: source.liveApiKeys && typeof source.liveApiKeys === 'object' && !Array.isArray(source.liveApiKeys)
      ? source.liveApiKeys as Record<string, string | string[]>
      : {},
    modelApiKeys: source.modelApiKeys && typeof source.modelApiKeys === 'object' && !Array.isArray(source.modelApiKeys)
      ? source.modelApiKeys as Record<string, string>
      : {},
    modelOverrides: source.modelOverrides && typeof source.modelOverrides === 'object' && !Array.isArray(source.modelOverrides)
      ? source.modelOverrides as Record<string, string>
      : {},
    baseURLs: source.baseURLs && typeof source.baseURLs === 'object' && !Array.isArray(source.baseURLs)
      ? source.baseURLs as Record<string, string>
      : {},
    search: source.search && typeof source.search === 'object' && !Array.isArray(source.search)
      ? source.search as SearchSettings
      : undefined,
    image: source.image && typeof source.image === 'object' && !Array.isArray(source.image)
      ? normalizeImageSettings(source.image)
      : undefined,
    video: source.video && typeof source.video === 'object' && !Array.isArray(source.video)
      ? normalizeVideoSettings(source.video)
      : undefined,
    selfImprovement: source.selfImprovement && typeof source.selfImprovement === 'object' && !Array.isArray(source.selfImprovement)
      ? { enabled: (source.selfImprovement as Record<string, unknown>).enabled !== false }
      : undefined,
  };
};

export function readStoredRuntimeSettings(): StoredRuntimeSettings {
  for (const source of [SETTINGS_FILE, SETTINGS_BACKUP_FILE]) {
    try {
      if (!fs.existsSync(source)) continue;
      const envelope = JSON.parse(fs.readFileSync(source, 'utf8'));
      if (envelope?.version !== 1) {
        preserveCorruptRuntimeSettings(source);
        continue;
      }
      const iv = Buffer.from(String(envelope.iv || ''), 'base64');
      const tag = Buffer.from(String(envelope.tag || ''), 'base64');
      const ciphertext = Buffer.from(String(envelope.data || ''), 'base64');
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
        preserveCorruptRuntimeSettings(source);
        continue;
      }
      const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      return normalizeStoredSettings(JSON.parse(plaintext));
    } catch {
      preserveCorruptRuntimeSettings(source);
    }
  }
  return {};
}

export async function updateStoredRuntimeSettings(patch: StoredRuntimeSettings | ((current: StoredRuntimeSettings) => StoredRuntimeSettings)): Promise<void> {
  const previous = runtimeSettingsGlobal.__eterxRuntimeSettingsWriteChain || Promise.resolve();
  let release!: () => void;
  runtimeSettingsGlobal.__eterxRuntimeSettingsWriteChain = new Promise<void>(resolve => {
    release = resolve;
  });
  await previous;
  let temporary: string | null = null;
  try {
    const current = readStoredRuntimeSettings();
    const next = normalizeStoredSettings({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(next), 'utf8'),
      cipher.final(),
    ]);
    const envelope = {
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    };
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    temporary = `${SETTINGS_FILE}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (fs.existsSync(SETTINGS_FILE)) {
      try { fs.copyFileSync(SETTINGS_FILE, SETTINGS_BACKUP_FILE); } catch { }
    }
    await replaceFileWithRetry(temporary, SETTINGS_FILE);
  } catch (error) {
    if (temporary) {
      try { fs.rmSync(temporary, { force: true }); } catch { }
    }
    console.warn('[EterX] Could not persist folder-backed runtime settings:', error instanceof Error ? error.message : error);
    throw error;
  } finally {
    release();
  }
}

export async function clearStoredRuntimeSettings(): Promise<void> {
  const previous = runtimeSettingsGlobal.__eterxRuntimeSettingsWriteChain || Promise.resolve();
  let release!: () => void;
  runtimeSettingsGlobal.__eterxRuntimeSettingsWriteChain = new Promise<void>(resolve => {
    release = resolve;
  });
  await previous;
  try {
    fs.rmSync(SETTINGS_FILE, { force: true });
    fs.rmSync(SETTINGS_BACKUP_FILE, { force: true });
  } catch (error) {
    console.warn('[EterX] Could not clear folder-backed runtime settings:', error instanceof Error ? error.message : error);
    throw error;
  } finally {
    release();
  }
}
