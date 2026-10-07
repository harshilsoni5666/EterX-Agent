/**
 * ═══════════════════════════════════════════════════════════════
 * EterX Browser Session Manager — Persistent Profiles & State
 * ═══════════════════════════════════════════════════════════════
 * 
 * Features:
 * - Named browser profiles with user data directories
 * - Cookie import/export for session reuse
 * - Cross-restart persistence (cookies/localStorage survive)
 * - Profile listing and management
 * - Session state serialization
 */

import path from 'path';
import fs from 'fs-extra';
import { getEterxWorkspaceDir } from '../storage-paths';

function safeProfileName(name: string): string {
  let cleaned = String(name || 'default')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+$/, '')
    .slice(0, 80)
    .replace(/\.+$/, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned || 'default';
}

function resolveUnder(rootPath: string, ...segments: string[]): string {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(root, resolved);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(`Blocked browser profile path traversal: ${resolved}`);
  }
  return resolved;
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.writeJson(tmpPath, data, { spaces: 2 });
  await fs.move(tmpPath, filePath, { overwrite: true });
}

// ═══════════════════════════════════════
// TYPES
// ═══════════════════════════════════════

export interface BrowserProfile {
  name: string;
  createdAt: number;
  lastUsed: number;
  userDataDir: string;
  cookies: number;       // count of stored cookies
  notes?: string;
}

export interface CookieData {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface SessionState {
  profile: string;
  url: string;
  cookies: CookieData[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  timestamp: number;
}

// ═══════════════════════════════════════
// SESSION MANAGER
// ═══════════════════════════════════════

export class BrowserSessionManager {
  private profilesDir: string;
  private stateDir: string;

  constructor() {
    this.profilesDir = getEterxWorkspaceDir('browser_profiles');
    this.stateDir = getEterxWorkspaceDir('browser_state');
  }

  private profileDir(name: string): string {
    return resolveUnder(this.profilesDir, safeProfileName(name));
  }

  private profileMetadataPath(name: string): string {
    return resolveUnder(this.profileDir(name), 'profile.json');
  }

  private stateFile(name: string, suffix: 'cookies' | 'state'): string {
    return resolveUnder(this.stateDir, `${safeProfileName(name)}_${suffix}.json`);
  }

  // ─── Profile Management ───

  /**
   * Create a new named profile.
   */
  async createProfile(name: string, notes?: string): Promise<BrowserProfile> {
    const profileName = safeProfileName(name);
    const profileDir = this.profileDir(profileName);
    await fs.ensureDir(profileDir);

    const profile: BrowserProfile = {
      name: profileName,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      userDataDir: profileDir,
      cookies: 0,
      notes,
    };

    await writeJsonAtomic(this.profileMetadataPath(profileName), profile);
    console.log(`[BrowserSession] 📁 Created profile: ${profileName}`);
    return profile;
  }

  /**
   * List all available profiles.
   */
  async listProfiles(): Promise<BrowserProfile[]> {
    await fs.ensureDir(this.profilesDir);
    const dirs = await fs.readdir(this.profilesDir);
    const profiles: BrowserProfile[] = [];

    for (const dir of dirs) {
      const profileDir = resolveUnder(this.profilesDir, dir);
      const profilePath = resolveUnder(profileDir, 'profile.json');
      try {
        if (await fs.pathExists(profilePath)) {
          const profile = await fs.readJson(profilePath);
          profiles.push(profile);
        } else {
          // Profile dir exists but no metadata — create it
          profiles.push({
            name: dir,
            createdAt: 0,
            lastUsed: 0,
            userDataDir: profileDir,
            cookies: 0,
          });
        }
      } catch {}
    }

    return profiles.sort((a, b) => b.lastUsed - a.lastUsed);
  }

  /**
   * Get profile info by name.
   */
  async getProfile(name: string): Promise<BrowserProfile | null> {
    const profilePath = this.profileMetadataPath(name);
    try {
      if (await fs.pathExists(profilePath)) {
        return await fs.readJson(profilePath);
      }
    } catch {}
    return null;
  }

  /**
   * Update profile's last used timestamp.
   */
  async touchProfile(name: string): Promise<void> {
    const profilePath = this.profileMetadataPath(name);
    try {
      if (await fs.pathExists(profilePath)) {
        const profile = await fs.readJson(profilePath);
        profile.lastUsed = Date.now();
        await writeJsonAtomic(profilePath, profile);
      }
    } catch {}
  }

  /**
   * Delete a profile and its data.
   */
  async deleteProfile(name: string): Promise<boolean> {
    const profileName = safeProfileName(name);
    const profileDir = this.profileDir(profileName);
    try {
      if (await fs.pathExists(profileDir)) {
        await fs.remove(profileDir);
        console.log(`[BrowserSession] 🗑️ Deleted profile: ${profileName}`);
        return true;
      }
    } catch {}
    return false;
  }

  /**
   * Get the user data directory for a profile.
   */
  getProfileDir(name: string): string {
    return this.profileDir(name);
  }

  // ─── Cookie Management ───

  /**
   * Export cookies from the browser context.
   */
  async exportCookies(context: any, profile?: string): Promise<CookieData[]> {
    try {
      const cookies = await context.cookies();
      
      if (profile) {
        const cookiePath = this.stateFile(profile, 'cookies');
        await writeJsonAtomic(cookiePath, cookies);
        
        // Update profile metadata
        const profilePath = this.profileMetadataPath(profile);
        if (await fs.pathExists(profilePath)) {
          const p = await fs.readJson(profilePath);
          p.cookies = cookies.length;
          p.lastUsed = Date.now();
          await writeJsonAtomic(profilePath, p);
        }
        
        console.log(`[BrowserSession] 🍪 Exported ${cookies.length} cookies for profile: ${profile}`);
      }
      
      return cookies;
    } catch (err: any) {
      console.error(`[BrowserSession] Cookie export failed:`, err.message);
      return [];
    }
  }

  /**
   * Import cookies into the browser context.
   */
  async importCookies(context: any, profile: string): Promise<number> {
    try {
      const cookiePath = this.stateFile(profile, 'cookies');
      if (!(await fs.pathExists(cookiePath))) return 0;
      
      const cookies = await fs.readJson(cookiePath);
      
      // Filter out expired cookies
      const now = Math.floor(Date.now() / 1000);
      const validCookies = cookies.filter((c: any) => !c.expires || c.expires === -1 || c.expires > now);
      
      if (validCookies.length > 0) {
        await context.addCookies(validCookies);
        console.log(`[BrowserSession] 🍪 Imported ${validCookies.length} cookies for profile: ${profile}`);
      }
      
      return validCookies.length;
    } catch (err: any) {
      console.error(`[BrowserSession] Cookie import failed:`, err.message);
      return 0;
    }
  }

  /**
   * Get cookies for a specific domain.
   */
  async getCookiesForDomain(context: any, domain: string): Promise<CookieData[]> {
    try {
      const allCookies = await context.cookies();
      const requested = domain.toLowerCase().replace(/^\./, '');
      return allCookies.filter((c: any) => {
        const cookieDomain = String(c.domain).toLowerCase().replace(/^\./, '');
        return requested === cookieDomain || (String(c.domain).startsWith('.') && requested.endsWith('.' + cookieDomain));
      });
    } catch {
      return [];
    }
  }

  // ─── Full State Snapshots ───

  /**
   * Save complete browser state (cookies + storage) for a page.
   */
  async saveState(context: any, page: any, profile: string): Promise<void> {
    try {
      const cookies = await context.cookies();
      
      // Extract localStorage and sessionStorage
      const storage = await page.evaluate(() => {
        const ls: Record<string, string> = {};
        const ss: Record<string, string> = {};
        
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key) ls[key] = localStorage.getItem(key) || '';
          }
        } catch {}
        
        try {
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key) ss[key] = sessionStorage.getItem(key) || '';
          }
        } catch {}
        
        return { localStorage: ls, sessionStorage: ss };
      });

      const state: SessionState = {
        profile,
        url: page.url(),
        cookies,
        localStorage: storage.localStorage,
        sessionStorage: storage.sessionStorage,
        timestamp: Date.now(),
      };

      await writeJsonAtomic(this.stateFile(profile, 'state'), state);

      console.log(`[BrowserSession] 💾 Saved state for profile: ${profile} (${cookies.length} cookies, ${Object.keys(storage.localStorage).length} localStorage items)`);
    } catch (err: any) {
      console.error(`[BrowserSession] State save failed:`, err.message);
    }
  }

  /**
   * Restore browser state (cookies + storage) for a page.
   */
  async restoreState(context: any, page: any, profile: string): Promise<boolean> {
    try {
      const statePath = this.stateFile(profile, 'state');
      if (!(await fs.pathExists(statePath))) return false;

      const state: SessionState = await fs.readJson(statePath);

      // Restore cookies
      if (state.cookies.length > 0) {
        const now = Math.floor(Date.now() / 1000);
        const validCookies = state.cookies.filter((c: any) => !c.expires || c.expires === -1 || c.expires > now);
        if (validCookies.length > 0) {
          await context.addCookies(validCookies);
        }
      }

      // Navigate to the saved URL
      if (state.url && state.url !== 'about:blank') {
        await page.goto(state.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (new URL(page.url()).origin !== new URL(state.url).origin) {
          throw new Error('The saved page redirected to a different origin; its storage was not copied.');
        }

        // Restore localStorage
        if (Object.keys(state.localStorage).length > 0) {
          await page.evaluate((ls: Record<string, string>) => {
            for (const [key, value] of Object.entries(ls)) {
              try { localStorage.setItem(key, value); } catch {}
            }
          }, state.localStorage);
        }

        // Restore sessionStorage
        if (Object.keys(state.sessionStorage).length > 0) {
          await page.evaluate((ss: Record<string, string>) => {
            for (const [key, value] of Object.entries(ss)) {
              try { sessionStorage.setItem(key, value); } catch {}
            }
          }, state.sessionStorage);
        }
        if (Object.keys(state.localStorage).length || Object.keys(state.sessionStorage).length) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        }
      }

      console.log(`[BrowserSession] 🔄 Restored state for profile: ${profile}`);
      return true;
    } catch (err: any) {
      console.error(`[BrowserSession] State restore failed:`, err.message);
      return false;
    }
  }
}

// ═══════════════════════════════════════
// GLOBAL SINGLETON
// ═══════════════════════════════════════
export const browserSessionManager = new BrowserSessionManager();
