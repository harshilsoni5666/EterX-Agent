import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs-extra';
import * as crypto from 'crypto';
import { enforceToolCapability } from '../security/tool_policy';
import { getEterxWorkspaceDir } from '../../storage-paths';

const VAULT_DIR = getEterxWorkspaceDir('.vault');
const VAULT_FILE = path.join(VAULT_DIR, 'keys.enc.json');
const VAULT_TMP_FILE = path.join(VAULT_DIR, 'keys.enc.json.tmp');
const VAULT_SALT = 'eterx-api-vault-v2';

type LegacyVaultEntry = {
  key: string;
  addedAt: number;
  lastUsed: number;
};

type EncryptedVaultEntry = {
  version: 2;
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
  addedAt: number;
  lastUsed: number;
};

type VaultEntry = LegacyVaultEntry | EncryptedVaultEntry;
type EncryptedPayload = Omit<EncryptedVaultEntry, 'addedAt' | 'lastUsed'>;

let keyCache: Map<string, VaultEntry> = new Map();
let vaultLoaded = false;

export const apiKeyVaultTool: ToolDefinition = {
  name: 'api_key_vault',
  description: `Securely store and manage API keys, tokens, and secrets.

Actions:
- store: Save a new API key. Requires ETERX_VAULT_MASTER_KEY for encrypted persistence.
- retrieve: Check whether a key exists for internal use by other tools. Secret values are never returned.
- list: See which keys are stored, with masked values only.
- delete: Remove a stored key from the vault.
- rotate: Replace an existing key. Requires ETERX_VAULT_MASTER_KEY.`,
  category: 'core',
  inputSchema: z.object({
    action: z.enum(['store', 'retrieve', 'list', 'delete', 'rotate']),
    keyName: z.string().optional().describe('Name/identifier for the key, e.g. GITHUB_TOKEN or OPENAI_API_KEY'),
    keyValue: z.string().optional().describe('The actual API key/token value for store/rotate'),
  }),
  outputSchema: z.object({ success: z.boolean(), message: z.string(), data: z.any().optional() }),
  execute: async (input: any, context?: any) => {
    const policy = enforceToolCapability('api_key_vault', input, context);
    if (!policy.allowed) {
      return { success: false, message: policy.reason || 'api_key_vault is not allowed in this context' };
    }

    await loadVault();

    try {
      switch (input.action) {
        case 'store': {
          const keyName = normalizeKeyName(input.keyName);
          if (!keyName || !input.keyValue) return { success: false, message: 'keyName and keyValue required' };

          const encrypted = encryptSecret(input.keyValue);
          if (!encrypted) {
            return { success: false, message: 'Set ETERX_VAULT_MASTER_KEY before storing secrets. Refusing to persist reversible obfuscation.' };
          }

          keyCache.set(keyName, {
            ...encrypted,
            addedAt: Date.now(),
            lastUsed: 0,
          });
          await saveVault();
          return { success: true, message: `Key "${keyName}" stored encrypted.` };
        }

        case 'retrieve': {
          const keyName = normalizeKeyName(input.keyName);
          if (!keyName) return { success: false, message: 'keyName required' };

          const entry = keyCache.get(keyName);
          if (entry) {
            entry.lastUsed = Date.now();
            await saveVault();
            return {
              success: true,
              message: `Key "${keyName}" exists and is ready to use`,
              data: {
                exists: true,
                source: 'vault',
                encrypted: isEncryptedEntry(entry),
                addedAt: new Date(entry.addedAt).toISOString(),
              },
            };
          }

          if (process.env[keyName]) {
            return { success: true, message: 'Key found in environment', data: { exists: true, source: 'env' } };
          }

          return { success: false, message: `Key "${keyName}" not found in vault or environment` };
        }

        case 'list': {
          const keys = Array.from(keyCache.entries()).map(([name, entry]) => ({
            name,
            addedAt: new Date(entry.addedAt).toISOString(),
            lastUsed: entry.lastUsed ? new Date(entry.lastUsed).toISOString() : 'Never',
            masked: maskSecret(decryptSecret(entry)),
            storage: isEncryptedEntry(entry) ? 'encrypted' : 'legacy_obfuscated',
          }));

          const envKeys = ['GEMINI_API_KEY', 'GITHUB_TOKEN', 'OPENAI_KEY', 'OPENAI_API_KEY', 'NEWS_API_KEY', 'WEATHER_API_KEY', 'SMTP_USER']
            .filter(k => process.env[k])
            .map(k => ({ name: k, source: 'env', masked: maskSecret(process.env[k]) }));

          return { success: true, message: `${keys.length} vault keys, ${envKeys.length} env keys`, data: { vault: keys, env: envKeys } };
        }

        case 'delete': {
          const keyName = normalizeKeyName(input.keyName);
          if (!keyName) return { success: false, message: 'keyName required' };
          keyCache.delete(keyName);
          await saveVault();
          return { success: true, message: `Key "${keyName}" deleted from vault` };
        }

        case 'rotate': {
          const keyName = normalizeKeyName(input.keyName);
          if (!keyName || !input.keyValue) return { success: false, message: 'keyName and keyValue required' };

          const encrypted = encryptSecret(input.keyValue);
          if (!encrypted) {
            return { success: false, message: 'Set ETERX_VAULT_MASTER_KEY before rotating persisted secrets.' };
          }

          keyCache.set(keyName, {
            ...encrypted,
            addedAt: keyCache.get(keyName)?.addedAt || Date.now(),
            lastUsed: 0,
          });
          await saveVault();
          return { success: true, message: `Key "${keyName}" rotated successfully` };
        }

        default:
          return { success: false, message: 'Unknown action' };
      }
    } catch (err: any) {
      return { success: false, message: `Vault error: ${err.message}` };
    }
  },
};

function normalizeKeyName(value: unknown): string {
  const keyName = String(value || '').trim();
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(keyName)) return '';
  return keyName;
}

function isEncryptedEntry(entry: VaultEntry): entry is EncryptedVaultEntry {
  return (entry as EncryptedVaultEntry).version === 2;
}

function isLegacyEntry(entry: VaultEntry): entry is LegacyVaultEntry {
  return typeof (entry as LegacyVaultEntry).key === 'string';
}

function getVaultMasterKey(): Buffer | null {
  const secret = process.env.ETERX_VAULT_MASTER_KEY;
  if (!secret || secret.length < 16) return null;
  return crypto.scryptSync(secret, VAULT_SALT, 32);
}

function encryptSecret(text: string): EncryptedPayload | null {
  const key = getVaultMasterKey();
  if (!key) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);

  return {
    version: 2,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptSecret(entry: VaultEntry | undefined): string | undefined {
  if (!entry) return undefined;

  if (isLegacyEntry(entry)) {
    return deobfuscateLegacy(entry.key);
  }

  const key = getVaultMasterKey();
  if (!key) return undefined;

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(entry.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function deobfuscateLegacy(text: string): string | undefined {
  if (process.env.ETERX_ALLOW_LEGACY_VAULT_OBFUSCATION !== '1') {
    return undefined;
  }

  try {
    return Buffer.from(text.split('').reverse().join(''), 'base64').toString('utf-8');
  } catch {
    return undefined;
  }
}

function maskSecret(value: string | undefined): string {
  if (!value) return 'unavailable';
  return `***${value.slice(-4)}`;
}

function coerceVaultEntry(value: any): VaultEntry | null {
  if (!value || typeof value !== 'object') return null;
  const addedAt = Number(value.addedAt || Date.now());
  const lastUsed = Number(value.lastUsed || 0);

  if (value.version === 2 && value.algorithm === 'aes-256-gcm' && value.iv && value.tag && value.ciphertext) {
    return {
      version: 2,
      algorithm: 'aes-256-gcm',
      iv: String(value.iv),
      tag: String(value.tag),
      ciphertext: String(value.ciphertext),
      addedAt,
      lastUsed,
    };
  }

  if (typeof value.key === 'string') {
    return { key: value.key, addedAt, lastUsed };
  }

  return null;
}

async function loadVault(): Promise<void> {
  if (vaultLoaded) return;

  try {
    await fs.ensureDir(VAULT_DIR);
    let data: unknown = null;
    for (const source of [VAULT_FILE, `${VAULT_FILE}.backup`]) {
      try {
        if (await fs.pathExists(source)) {
          data = await fs.readJSON(source);
          break;
        }
      } catch {
        if (source === VAULT_FILE) await fs.move(VAULT_FILE, `${VAULT_FILE}.corrupt-${Date.now()}`).catch(() => {});
      }
    }
    if (data) {
      if (data && typeof data === 'object') {
        for (const [name, rawEntry] of Object.entries(data as Record<string, any>)) {
          const keyName = normalizeKeyName(name);
          const entry = coerceVaultEntry(rawEntry);
          if (keyName && entry) keyCache.set(keyName, entry);
        }
      }
      console.log(`[Vault] Loaded ${keyCache.size} key metadata entries`);
    }
  } catch {
    // Vault load failures must not expose secrets or crash the agent runtime.
  } finally {
    vaultLoaded = true;
  }
}

async function saveVault(): Promise<void> {
  await fs.ensureDir(VAULT_DIR);
  const data: Record<string, VaultEntry> = {};
  for (const [name, entry] of Array.from(keyCache.entries())) {
    data[name] = entry;
  }
  await fs.writeJSON(VAULT_TMP_FILE, data, { spaces: 2 });
  if (await fs.pathExists(VAULT_FILE)) await fs.copyFile(VAULT_FILE, `${VAULT_FILE}.backup`).catch(() => {});
  await fs.move(VAULT_TMP_FILE, VAULT_FILE, { overwrite: true });
}

/**
 * Helper: Get a key from the in-memory vault or environment.
 * Call api_key_vault first in long-lived runtimes to load persisted vault metadata.
 */
export function getApiKey(name: string): string | undefined {
  const keyName = normalizeKeyName(name);
  if (!keyName) return undefined;

  const entry = keyCache.get(keyName);
  if (entry) {
    entry.lastUsed = Date.now();
    return decryptSecret(entry);
  }

  return process.env[keyName];
}
