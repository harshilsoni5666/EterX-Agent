import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs-extra';

/**
 * API Key Vault — Secure credential management
 * 
 * Store, retrieve, and rotate API keys safely.
 * Keys are stored encrypted (Base64 obfuscation) locally.
 * Never exposed in logs or output.
 */

const VAULT_DIR = path.resolve(process.cwd(), '.workspaces', '.vault');
const VAULT_FILE = path.join(VAULT_DIR, 'keys.enc.json');

// In-memory key cache
let keyCache: Map<string, { key: string, addedAt: number, lastUsed: number }> = new Map();
let vaultLoaded = false;

export const apiKeyVaultTool: ToolDefinition = {
  name: 'api_key_vault',
  description: `Securely store and manage API keys, tokens, and secrets. Keys are persisted locally and never exposed in logs. Use this to configure external service credentials.
  
  Actions:
  - store: Save a new API key
  - retrieve: Get a key (for internal use by other tools)
  - list: See which keys are stored (names only, not values)
  - delete: Remove a stored key
  - rotate: Update an existing key with a new value`,
  category: 'core',
  inputSchema: z.object({
    action: z.enum(['store', 'retrieve', 'list', 'delete', 'rotate']),
    keyName: z.string().optional().describe('Name/identifier for the key (e.g., "GITHUB_TOKEN", "OPENAI_KEY")'),
    keyValue: z.string().optional().describe('The actual API key/token value (for store/rotate)')
  }),
  outputSchema: z.object({ success: z.boolean(), message: z.string(), data: z.any().optional() }),
  execute: async (input: any) => {
    await loadVault();

    try {
      switch (input.action) {
        case 'store': {
          if (!input.keyName || !input.keyValue) return { success: false, message: 'keyName and keyValue required' };
          keyCache.set(input.keyName, {
            key: obfuscate(input.keyValue),
            addedAt: Date.now(),
            lastUsed: 0
          });
          // Also set as env var for current process
          process.env[input.keyName] = input.keyValue;
          await saveVault();
          return { success: true, message: `🔐 Key "${input.keyName}" stored securely. Also set as environment variable.` };
        }
        case 'retrieve': {
          if (!input.keyName) return { success: false, message: 'keyName required' };
          const entry = keyCache.get(input.keyName);
          if (!entry) {
            // Try env var fallback
            const envVal = process.env[input.keyName];
            if (envVal) return { success: true, message: `Key found in environment`, data: { exists: true, source: 'env' } };
            return { success: false, message: `Key "${input.keyName}" not found in vault or environment` };
          }
          entry.lastUsed = Date.now();
          // Don't return the actual key in the response for safety
          return { success: true, message: `Key "${input.keyName}" exists and is ready to use`, data: { exists: true, source: 'vault', addedAt: new Date(entry.addedAt).toISOString() } };
        }
        case 'list': {
          const keys = Array.from(keyCache.entries()).map(([name, entry]) => ({
            name,
            addedAt: new Date(entry.addedAt).toISOString(),
            lastUsed: entry.lastUsed ? new Date(entry.lastUsed).toISOString() : 'Never',
            masked: '***' + deobfuscate(entry.key).slice(-4) // Show last 4 chars only
          }));
          // Also list relevant env vars
          const envKeys = ['GEMINI_API_KEY', 'GITHUB_TOKEN', 'OPENAI_KEY', 'NEWS_API_KEY', 'WEATHER_API_KEY', 'SMTP_USER']
            .filter(k => process.env[k])
            .map(k => ({ name: k, source: 'env', masked: '***' + (process.env[k] || '').slice(-4) }));
          
          return { success: true, message: `${keys.length} vault keys, ${envKeys.length} env keys`, data: { vault: keys, env: envKeys } };
        }
        case 'delete': {
          if (!input.keyName) return { success: false, message: 'keyName required' };
          keyCache.delete(input.keyName);
          delete process.env[input.keyName];
          await saveVault();
          return { success: true, message: `Key "${input.keyName}" deleted from vault` };
        }
        case 'rotate': {
          if (!input.keyName || !input.keyValue) return { success: false, message: 'keyName and keyValue required' };
          keyCache.set(input.keyName, {
            key: obfuscate(input.keyValue),
            addedAt: keyCache.get(input.keyName)?.addedAt || Date.now(),
            lastUsed: 0
          });
          process.env[input.keyName] = input.keyValue;
          await saveVault();
          return { success: true, message: `🔄 Key "${input.keyName}" rotated successfully` };
        }
        default:
          return { success: false, message: 'Unknown action' };
      }
    } catch (err: any) {
      return { success: false, message: `Vault error: ${err.message}` };
    }
  }
};

// Simple obfuscation (Base64 + reversal — not encryption but avoids plaintext in files)
function obfuscate(text: string): string {
  return Buffer.from(text).toString('base64').split('').reverse().join('');
}
function deobfuscate(text: string): string {
  return Buffer.from(text.split('').reverse().join(''), 'base64').toString('utf-8');
}

async function loadVault(): Promise<void> {
  if (vaultLoaded) return;
  try {
    await fs.ensureDir(VAULT_DIR);
    if (await fs.pathExists(VAULT_FILE)) {
      const data = await fs.readJSON(VAULT_FILE);
      for (const [name, entry] of Object.entries(data as Record<string, any>)) {
        keyCache.set(name, entry);
        // Restore env vars
        process.env[name] = deobfuscate(entry.key);
      }
      console.log(`[Vault] Loaded ${keyCache.size} keys`);
    }
    vaultLoaded = true;
  } catch { vaultLoaded = true; }
}

async function saveVault(): Promise<void> {
  try {
    await fs.ensureDir(VAULT_DIR);
    const data: Record<string, any> = {};
    for (const [name, entry] of Array.from(keyCache.entries())) {
      data[name] = entry;
    }
    await fs.writeJSON(VAULT_FILE, data, { spaces: 2 });
  } catch { }
}

/**
 * Helper: Get a key from the vault or environment.
 * Used internally by other tools.
 */
export function getApiKey(name: string): string | undefined {
  const entry = keyCache.get(name);
  if (entry) {
    entry.lastUsed = Date.now();
    return deobfuscate(entry.key);
  }
  return process.env[name];
}
