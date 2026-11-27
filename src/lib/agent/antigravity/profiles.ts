import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AntigravityAccount, AntigravityState } from '../../antigravity-contract';
import { getEterxDataDir } from '../storage-paths';
import { antigravityBinaryName } from './installation';

const LEGACY_PROFILE = 'legacy';
const APP_DATA = 'antigravity-acp';
const root = () => path.join(getEterxDataDir(), 'antigravity');
const settings = () => path.join(root(), 'connection.json');
export const setupWorkspace = () => path.join(root(), 'setup');
export const binDir = () => path.join(root(), 'runtime');
export const binary = () => path.join(binDir(), antigravityBinaryName);

const profile = (id: string) => id === LEGACY_PROFILE ? path.join(root(), 'profile') : path.join(root(), 'profiles', id);
const profileData = (id: string) => path.join(profile(id), APP_DATA);
export const nativeProfileArgs = (id: string) => ['--gemini-dir', profile(id), '--app-data-dir', APP_DATA];
export const nativeProfileHome = profile;
export const NO_MEDIA: AntigravityState['capabilities'] = { image: false, audio: false, embeddedContext: false };

export type SavedAccount = Pick<AntigravityAccount, 'id' | 'label' | 'connected' | 'allowance' | 'allowanceUpdatedAt'> &
  Pick<AntigravityState, 'models' | 'capabilities'>;
export type SavedAntigravity = { version: string | null; activeAccountId: string | null; accounts: SavedAccount[] };

export function newAntigravityAccount(id: string, label: string): SavedAccount {
  return { id, label, connected: false, models: [], capabilities: NO_MEDIA, allowance: [], allowanceUpdatedAt: null };
}

export function isAntigravityAccountId(value: unknown): value is string {
  return typeof value === 'string' && (value === LEGACY_PROFILE || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value));
}

/** Check only that the native profile owns a credential file. Google reads and refreshes its contents. */
export function hasProfileSignIn(id: string): boolean {
  return ['antigravity-oauth-token', 'acp_token.json'].some(filename => {
    try {
      const file = lstatSync(path.join(profileData(id), filename));
      return file.isFile() && file.size > 0;
    } catch { return false; }
  });
}

export function readAntigravityProfiles(): SavedAntigravity {
  try {
    const saved = JSON.parse(readFileSync(settings(), 'utf8'));
    const version = typeof saved?.version === 'string' && /^\d+\.\d+\.\d+$/.test(saved.version) && existsSync(binary()) ? saved.version : null;
    // Keep existing single-account profiles in place during migration.
    const accounts: unknown[] = Array.isArray(saved?.accounts) ? saved.accounts
      : saved?.connected || hasProfileSignIn(LEGACY_PROFILE) ? [{ ...saved, id: LEGACY_PROFILE, label: 'Google account' }] : [];
    const profiles = new Map<string, SavedAccount>();
    for (const value of accounts) {
      const account = value as Partial<SavedAccount> | null;
      if (!isAntigravityAccountId(account?.id) || profiles.has(account.id)) continue;
      const next = newAntigravityAccount(account.id, typeof account.label === 'string' && account.label.trim() ? account.label.slice(0, 80) : 'Google account');
      if (account.connected === true && hasProfileSignIn(account.id)) {
        next.connected = true;
        next.models = Array.isArray(account.models) ? account.models : [];
        next.capabilities = account.capabilities || NO_MEDIA;
        next.allowance = Array.isArray(account.allowance) ? account.allowance : [];
        next.allowanceUpdatedAt = typeof account.allowanceUpdatedAt === 'number' ? account.allowanceUpdatedAt : null;
      }
      profiles.set(account.id, next);
    }
    const list = [...profiles.values()];
    const active = Array.isArray(saved?.accounts)
      ? list.find(account => account.id === saved.activeAccountId)
      : list.find(account => account.connected);
    return { version, activeAccountId: active?.id ?? null, accounts: list };
  } catch { return { version: null, activeAccountId: null, accounts: [] }; }
}

export async function writeAntigravityProfiles(saved: SavedAntigravity) {
  const temporary = `${settings()}.${randomUUID()}.tmp`;
  try {
    await mkdir(root(), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(saved), { flag: 'wx', mode: 0o600 });
    await rename(temporary, settings());
  } finally { await unlink(temporary).catch(() => undefined); }
}

export async function prepareAntigravityProfile(id: string) {
  const directory = profileData(id);
  await Promise.all([mkdir(directory, { recursive: true, mode: 0o700 }), mkdir(setupWorkspace(), { recursive: true, mode: 0o700 })]);
  // Route native commands and mutations through the ACP permission callback.
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify({
    auth: { type: 'oauth-personal' }, agentMode: '', toolPermission: 'request-review',
    permissions: { ask: ['command(*)', 'write_file(*)', 'execute_url(*)', 'mcp(*)'] },
  }), { flag: 'wx', mode: 0o600 })
    .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
}

export function antigravityUsageFile(id: string, sessionId: string) {
  return /^[a-z\d_-]{1,100}$/i.test(sessionId) ? path.join(profileData(id), 'conversations', `${sessionId}.db`) : undefined;
}
