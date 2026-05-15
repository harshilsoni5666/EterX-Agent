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
    this.profilesDir = path.resolve(process.cwd(), '.workspaces', 'browser_profiles');
    this.stateDir = path.resolve(process.cwd(), '.workspaces', 'browser_state');
  }

  // ─── Profile Management ───

  /**
   * Create a new named profile.
   */
  async createProfile(name: string, notes?: string): Promise<BrowserProfile> {
    const profileDir = path.join(this.profilesDir, name);
    await fs.ensureDir(profileDir);

    const profile: BrowserProfile = {
      name,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      userDataDir: profileDir,
      cookies: 0,
      notes,
    };

    await fs.writeJson(path.join(profileDir, 'profile.json'), profile, { spaces: 2 });
    console.log(`[BrowserSession] 📁 Created profile: ${name}`);
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
      const profilePath = path.join(this.profilesDir, dir, 'profile.json');
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
            userDataDir: path.join(this.profilesDir, dir),
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
    const profilePath = path.join(this.profilesDir, name, 'profile.json');
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
    const profilePath = path.join(this.profilesDir, name, 'profile.json');
    try {
      if (await fs.pathExists(profilePath)) {
        const profile = await fs.readJson(profilePath);
        profile.lastUsed = Date.now();
        await fs.writeJson(profilePath, profile, { spaces: 2 });
      }
    } catch {}
  }

  /**
   * Delete a profile and its data.
   */
  async deleteProfile(name: string): Promise<boolean> {
    const profileDir = path.join(this.profilesDir, name);
    try {
      if (await fs.pathExists(profileDir)) {
        await fs.remove(profileDir);
        console.log(`[BrowserSession] 🗑️ Deleted profile: ${name}`);
        return true;
      }
    } catch {}
    return false;
  }

  /**
   * Get the user data directory for a profile.
   */
  getProfileDir(name: string): string {
    return path.join(this.profilesDir, name);
  }

  // ─── Cookie Management ───

  /**
   * Export cookies from the browser context.
   */
  async exportCookies(context: any, profile?: string): Promise<CookieData[]> {
    try {
      const cookies = await context.cookies();
      
      if (profile) {
        const cookiePath = path.join(this.stateDir, `${profile}_cookies.json`);
        await fs.ensureDir(this.stateDir);
        await fs.writeJson(cookiePath, cookies, { spaces: 2 });
        
        // Update profile metadata
        const profilePath = path.join(this.profilesDir, profile, 'profile.json');
        if (await fs.pathExists(profilePath)) {
          const p = await fs.readJson(profilePath);
          p.cookies = cookies.length;
          p.lastUsed = Date.now();
          await fs.writeJson(profilePath, p, { spaces: 2 });
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
      const cookiePath = path.join(this.stateDir, `${profile}_cookies.json`);
      if (!(await fs.pathExists(cookiePath))) return 0;
      
      const cookies = await fs.readJson(cookiePath);
      
      // Filter out expired cookies
      const now = Math.floor(Date.now() / 1000);
      const validCookies = cookies.filter((c: any) => !c.expires || c.expires > now);
      
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
      return allCookies.filter((c: any) => c.domain.includes(domain));
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

      await fs.ensureDir(this.stateDir);
      await fs.writeJson(
        path.join(this.stateDir, `${profile}_state.json`),
        state,
        { spaces: 2 }
      );

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
      const statePath = path.join(this.stateDir, `${profile}_state.json`);
      if (!(await fs.pathExists(statePath))) return false;

      const state: SessionState = await fs.readJson(statePath);

      // Restore cookies
      if (state.cookies.length > 0) {
        const now = Math.floor(Date.now() / 1000);
        const validCookies = state.cookies.filter((c: any) => !c.expires || c.expires > now);
        if (validCookies.length > 0) {
          await context.addCookies(validCookies);
        }
      }

      // Navigate to the saved URL
      if (state.url && state.url !== 'about:blank') {
        await page.goto(state.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

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
