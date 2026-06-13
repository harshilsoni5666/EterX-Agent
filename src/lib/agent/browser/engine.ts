/**
 * ═══════════════════════════════════════════════════════════════
 * EterX Browser Engine — Core CDP + Playwright Orchestration Layer
 * ═══════════════════════════════════════════════════════════════
 * 
 * Three connection modes:
 * 1. MANAGED  — Launch isolated Chromium, full control, clean state
 * 2. CDP      — Connect to user's existing Chrome (preserves sessions)
 * 3. REMOTE   — Connect to cloud browser via WebSocket
 * 
 * Features:
 * - Chrome auto-detection on Windows
 * - User data directory persistence (cookies/sessions survive restarts)
 * - Multi-page management with named tab IDs
 * - Auto-recovery on disconnect
 * - Console log/error capture per page
 * - Dialog auto-handling (alerts, confirms, prompts)
 * - Download tracking
 */

import path from 'path';
import fs from 'fs-extra';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import net from 'net';

const execAsync = promisify(exec);

// Dynamic import to bypass Next.js webpack bundling
let _pw: any = null;
function getPlaywright(): any {
  if (!_pw) {
    // eslint-disable-next-line no-eval
    _pw = eval('require')('playwright-core');
  }
  return _pw;
}

function allowUserChromeAccess(): boolean {
  return process.env.ETERX_ALLOW_USER_CHROME === '1' || process.env.ETERX_ALLOW_UNSAFE_HOST_COMPUTER === '1';
}

function shouldRunHeadless(requested?: boolean): boolean {
  return requested === true && process.env.ETERX_BROWSER_ALLOW_HEADLESS === '1';
}

function allowCustomUserDataDir(): boolean {
  return process.env.ETERX_BROWSER_ALLOW_CUSTOM_USER_DATA_DIR === '1';
}

function safeProfileName(name: string): string {
  const cleaned = String(name || 'default')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+$/, '')
    .slice(0, 80);
  return cleaned || 'default';
}

function resolveUnder(rootPath: string, ...segments: string[]): string {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(root, resolved);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(`Blocked browser path traversal: ${resolved}`);
  }
  return resolved;
}

// ═══════════════════════════════════════
// TYPES
// ═══════════════════════════════════════

function safeDownloadFilename(name: string): string {
  const basename = path.basename(String(name || 'download').replace(/[\\/]+/g, path.sep));
  const cleaned = basename
    .replace(/[<>:"|?*\x00-\x1F]/g, '_')
    .replace(/^\.+$/, '')
    .slice(0, 180);
  return cleaned || 'download';
}

function sanitizeLaunchArgs(args: string[] = []): string[] {
  const blockedPrefixes = new Set([
    '--user-data-dir',
    '--remote-debugging-port',
    '--remote-debugging-address',
    '--load-extension',
    '--disable-extensions-except',
    '--profile-directory',
    '--headless',
  ]);

  return args.filter((arg) => {
    const name = String(arg || '').split('=')[0].trim().toLowerCase();
    return name && !blockedPrefixes.has(name);
  });
}

export type ConnectionMode = 'managed' | 'cdp' | 'remote';

export interface LaunchOptions {
  mode?: ConnectionMode;
  headless?: boolean;
  profile?: string;        // Named profile for session persistence
  userDataDir?: string;    // Explicit user data directory
  cdpEndpoint?: string;    // For CDP mode: http://127.0.0.1:9222
  wsEndpoint?: string;     // For remote mode: ws://...
  viewport?: { width: number; height: number } | null;
  proxy?: { server: string; username?: string; password?: string };
  args?: string[];
  timeout?: number;
}

export interface PageInfo {
  id: string;
  url: string;
  title: string;
  isActive: boolean;
}

export interface ConsoleEntry {
  type: 'log' | 'warn' | 'error' | 'info' | 'debug';
  text: string;
  timestamp: number;
  url?: string;
}

export interface DownloadInfo {
  filename: string;
  url: string;
  path: string;
  state: 'in_progress' | 'completed' | 'cancelled';
  receivedBytes: number;
  totalBytes: number;
}

interface BrowserInstall {
  displayName: string;
  executablePath: string;
  processName: string;
  userDataDirCandidates: string[];
}

// ═══════════════════════════════════════
// BROWSER ENGINE — Singleton
// ═══════════════════════════════════════

export class BrowserEngine {
  private browser: any = null;
  private context: any = null;
  private pages: Map<string, any> = new Map();
  private activePageId: string = 'main';
  private connectionMode: ConnectionMode = 'managed';
  private isConnected: boolean = false;
  private ownsBrowserConnection: boolean = false;

  // Per-page state
  private consoleLogs: Map<string, ConsoleEntry[]> = new Map();
  private downloads: DownloadInfo[] = [];
  private dialogHandler: ((dialog: any) => Promise<void>) | null = null;
  private defaultDialogAction: 'accept' | 'dismiss' = 'accept';

  // Paths
  private profilesDir = path.resolve(process.cwd(), '.workspaces', 'browser_profiles');
  private downloadsDir = path.resolve(process.cwd(), '.workspaces', 'temp', 'downloads');

  // ─── Connection ───

  /**
   * Launch or connect to a browser based on the specified mode.
   * Priority: reuse existing → CDP auto-detect → user's Chrome with debug port → managed Playwright
   */
  async launch(options: LaunchOptions = {}): Promise<any> {
    this.pruneClosedPages();
    // ─── 1. REUSE existing connection if still alive ───
    if (this.isConnected && this.context) {
      try {
        const page = await this.getActivePage();
        if (page && !page.isClosed()) {
          console.log(`[BrowserEngine] ♻️ Reusing existing browser connection`);
          return page;
        }
      } catch {}
    }

    const mode = options.mode || 'managed';
    const userChromeAllowed = allowUserChromeAccess();

    // ─── 2. AUTO-DETECT: Try CDP first (user's Chrome with debug port already running) ───
    if (userChromeAllowed && mode === 'cdp') {
      try {
        const port = await this.findChromeDebugPort();
        if (port) {
          console.log(`[BrowserEngine] 🔍 Found Chrome debug port ${port}, connecting via CDP...`);
          this.connectionMode = 'cdp';
          return await this.connectCDP({ ...options, cdpEndpoint: `http://127.0.0.1:${port}` });
        }
      } catch (err: any) {
        console.log(`[BrowserEngine] CDP auto-detect: ${err.message?.substring(0, 60)}`);
      }
    }

    // ─── 3. LAUNCH USER'S CHROME with debug port (uses their actual logins!) ───
    if (userChromeAllowed && options.mode === 'cdp') {
      try {
        const page = await this.launchUserChromeWithDebug(options);
        if (page) return page;
      } catch (err: any) {
        console.log(`[BrowserEngine] User Chrome launch failed: ${err.message?.substring(0, 80)}`);
      }
    }

    // ─── 4. EXPLICIT MODE or FALLBACK ───
    this.connectionMode = mode;

    try {
      switch (mode) {
        case 'cdp':
          if (!userChromeAllowed) {
            throw new Error('Real Chrome/CDP access is disabled. Set ETERX_ALLOW_USER_CHROME=1 only when host Chrome control is intended.');
          }
          return await this.connectCDP(options);
        case 'remote':
          return await this.connectRemote(options);
        case 'managed':
        default:
          return await this.launchManaged(options);
      }
    } catch (err: any) {
      console.error(`[BrowserEngine] Launch failed (${mode}):`, err.message);
      if (mode !== 'managed') {
        console.log(`[BrowserEngine] Falling back to managed mode...`);
        return await this.launchManaged(options);
      }
      throw err;
    }
  }

  /**
   * Try to launch the user's actual Chrome with --remote-debugging-port.
   * This gives access to their real profile (logins, bookmarks, extensions, cookies).
   * Returns null if it can't be done (e.g., profile locked by already-running Chrome).
   */
  private async launchUserChromeWithDebug(options: LaunchOptions): Promise<any | null> {
    const install = await this.findBrowserInstall();
    const chromePath = install.executablePath;
    
    // Find the user's actual Chrome profile directory
    const possibleProfileDirs = install.userDataDirCandidates;

    let userDataDir = '';
    for (const dir of possibleProfileDirs) {
      if (await fs.pathExists(dir)) {
        userDataDir = dir;
        break;
      }
    }

    if (!userDataDir) {
      console.log(`[BrowserEngine] No Chrome user data directory found`);
      return null;
    }

    // Check if Chrome is already running (profile would be locked)
    try {
      const { stdout } = await execAsync(`tasklist /FI "IMAGENAME eq ${install.processName}" /NH`, {
        shell: 'cmd.exe',
        timeout: 3000,
      });
      
      if (stdout.toLowerCase().includes(install.processName.toLowerCase())) {
        // Chrome is already running — check if it has debug port
        const port = await this.findChromeDebugPort();
        if (port) {
          // It has debug port! Connect to it
          console.log(`[BrowserEngine] 🔗 Chrome already running with debug port ${port}`);
          this.connectionMode = 'cdp';
          return await this.connectCDP({ ...options, cdpEndpoint: `http://127.0.0.1:${port}` });
        }
        
        // Chrome is running but WITHOUT debug port
        // We can't use their profile (locked), fall back to our persistent profile
        console.log(`[BrowserEngine] ⚠️ Chrome is running without debug port. Using persistent profile instead.`);
        console.log(`[BrowserEngine] 💡 TIP: Close Chrome and let the agent open it, or launch Chrome with: chrome.exe --remote-debugging-port=9222`);
        return null;
      }
    } catch {}

    // Chrome is NOT running — we can launch it with their profile + debug port!
    const debugPort = await this.findAvailableDebugPort([9222, 9223, 9333, 18800, 18801, 18802]);
    if (!debugPort) {
      console.log(`[BrowserEngine] No available Chrome debug port found`);
      return null;
    }
    console.log(`[BrowserEngine] 🚀 Launching user's Chrome with debug port ${debugPort}...`);

    try {
      const extensionDir = path.resolve(process.cwd(), 'src', 'lib', 'agent', 'browser', 'extension');
      const extensionArgs = await fs.pathExists(extensionDir)
        ? [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
        : [];
      // Launch Chrome as a detached subprocess
      const { spawn } = require('child_process');
      const chromeProcess = spawn(chromePath, [
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=TranslateUI',
        '--disable-infobars',
        '--new-window',
        ...extensionArgs,
      ], {
        detached: true,
        stdio: 'ignore',
        shell: false,
      });
      chromeProcess.unref(); // Don't wait for Chrome to exit

      // Poll aggressively so a fresh Chrome window becomes usable without a long blank-tab pause.
      let connected = false;
      for (let i = 0; i < 25; i++) {
        await new Promise(r => setTimeout(r, 120));
        try {
          const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
            signal: AbortSignal.timeout(550),
          });
          if (response.ok) {
            connected = true;
            break;
          }
        } catch {}
      }

      if (connected) {
        console.log(`[BrowserEngine] ✅ User's Chrome is ready on port ${debugPort}`);
        this.connectionMode = 'cdp';
        return await this.connectCDP({ ...options, cdpEndpoint: `http://127.0.0.1:${debugPort}` });
      } else {
        console.log(`[BrowserEngine] ⏱️ Chrome didn't respond in time, falling back to managed`);
        return null;
      }
    } catch (err: any) {
      console.log(`[BrowserEngine] Chrome subprocess launch failed: ${err.message?.substring(0, 60)}`);
      return null;
    }
  }

  /**
   * Launch a managed Chromium instance with Playwright (fallback mode).
   * Uses persistent profile for session persistence + debug port for future CDP.
   */
  private async launchManaged(options: LaunchOptions): Promise<any> {
    const pw = getPlaywright();

    // ALWAYS use a persistent profile — 'default' if none specified
    const profileName = safeProfileName(options.profile || 'default');
    const customUserDataDir = options.userDataDir && allowCustomUserDataDir()
      ? path.resolve(options.userDataDir)
      : '';
    const userDataDir = customUserDataDir || resolveUnder(this.profilesDir, profileName);
    if (options.userDataDir && !customUserDataDir) {
      console.warn('[BrowserEngine] Ignoring custom userDataDir because ETERX_BROWSER_ALLOW_CUSTOM_USER_DATA_DIR is not enabled.');
    }
    await fs.ensureDir(userDataDir);

    const launchArgs = [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=TranslateUI',
      '--disable-infobars',
      '--disable-notifications',
      '--disable-popup-blocking',
      ...sanitizeLaunchArgs(options.args),
    ];

    const headless = shouldRunHeadless(options.headless);
    if (!headless) {
      launchArgs.push('--start-maximized');
    }

    const debugPort = await this.findAvailableDebugPort([9223, 9333, 18800, 18801, 18802]);
    if (debugPort) {
      launchArgs.push(`--remote-debugging-port=${debugPort}`);
    }

    const extensionDir = path.resolve(process.cwd(), 'src', 'lib', 'agent', 'browser', 'extension');
    if (!headless && await fs.pathExists(extensionDir)) {
      launchArgs.push(`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`);
    }

    const chromePath = await this.findChromePath();
    const browserLaunchOptions: Record<string, any> = {
      headless,
      args: launchArgs,
      viewport: options.viewport === null ? null : (options.viewport || { width: 1920, height: 1080 }),
      userAgent: this.getUserAgent(),
      ignoreDefaultArgs: ['--enable-automation'],
      acceptDownloads: true,
      ...(options.proxy ? { proxy: options.proxy } : {}),
    };
    if (chromePath && chromePath !== 'chrome') {
      browserLaunchOptions.executablePath = chromePath;
    } else {
      browserLaunchOptions.channel = 'chrome';
    }

    // Use persistent context — sessions/cookies persist across restarts
    this.context = await pw.chromium.launchPersistentContext(userDataDir, browserLaunchOptions);
    this.browser = null;
    this.ownsBrowserConnection = true;
    this.pages.clear();
    this.consoleLogs.clear();

    // Set up event handlers on the context
    this.setupContextHandlers();

    // Get or create the first page
    let pages = this.context.pages();
    const page = pages.length > 0 ? pages[0] : await this.context.newPage();
    pages = this.context.pages();
    pages.forEach((p: any, i: number) => {
      const id = i === 0 ? 'main' : `tab_${Date.now()}_${i}`;
      this.pages.set(id, p);
      this.setupPageHandlers(p, id);
    });
    this.activePageId = 'main';
    this.isConnected = true;
    await page.bringToFront().catch(() => {});
    
    console.log(`[BrowserEngine] 🚀 Launched Chrome with persistent profile: ${profileName}`);
    return page;
  }

  /**
   * Connect to an existing Chrome instance via CDP.
   * Preserves user's logged-in sessions.
   */
  private async connectCDP(options: LaunchOptions): Promise<any> {
    const pw = getPlaywright();

    let endpoint = options.cdpEndpoint;
    if (!endpoint) {
      // Auto-detect Chrome debug port
      const port = await this.findChromeDebugPort();
      if (!port) {
        throw new Error('No Chrome debug instance found. Launch Chrome with --remote-debugging-port=9222');
      }
      endpoint = `http://127.0.0.1:${port}`;
    }

    this.browser = await pw.chromium.connectOverCDP(endpoint, {
      timeout: options.timeout || 15000,
    });
    this.ownsBrowserConnection = false;

    const contexts = this.browser.contexts();
    this.context = contexts[0] || await this.browser.newContext();
    this.pages.clear();
    this.consoleLogs.clear();
    this.setupContextHandlers();

    let pages = this.context.pages();
    const page = pages.length > 0 ? pages[0] : await this.context.newPage();
    pages = this.context.pages();
    
    // Register all existing pages
    pages.forEach((p: any, i: number) => {
      const id = i === 0 ? 'main' : `tab_${Date.now()}_${i}`;
      this.pages.set(id, p);
      this.setupPageHandlers(p, id);
    });

    this.activePageId = 'main';
    this.isConnected = true;
    await page.bringToFront().catch(() => {});
    
    console.log(`[BrowserEngine] 🔗 Connected to Chrome CDP at ${endpoint}`);
    return page;
  }

  /**
   * Connect to a remote browser instance via WebSocket.
   */
  private async connectRemote(options: LaunchOptions): Promise<any> {
    const pw = getPlaywright();

    if (!options.wsEndpoint) {
      throw new Error('wsEndpoint required for remote connection');
    }

    this.browser = await pw.chromium.connect(options.wsEndpoint, {
      timeout: options.timeout || 30000,
    });
    this.ownsBrowserConnection = true;

    this.context = await this.browser.newContext({
      viewport: options.viewport === null ? null : (options.viewport || { width: 1920, height: 1080 }),
      userAgent: this.getUserAgent(),
      acceptDownloads: true,
    });
    this.pages.clear();
    this.consoleLogs.clear();

    this.setupContextHandlers();

    const page = await this.context.newPage();
    this.pages.set('main', page);
    this.setupPageHandlers(page, 'main');
    this.activePageId = 'main';
    this.isConnected = true;

    console.log(`[BrowserEngine] 🌐 Connected to remote browser`);
    return page;
  }

  /**
   * Disconnect and clean up everything.
   */
  async disconnect(): Promise<void> {
    this.isConnected = false;

    if (this.ownsBrowserConnection) {
      for (const [, page] of this.pages) {
        try { if (!page.isClosed()) await page.close(); } catch {}
      }

      try {
        if (this.context) await this.context.close();
      } catch {}

      try {
        if (this.browser) await this.browser.close();
      } catch {}
    } else {
      try {
        if (this.browser?.disconnect) await this.browser.disconnect();
      } catch {}
    }

    this.pages.clear();
    this.consoleLogs.clear();

    this.browser = null;
    this.context = null;
    this.ownsBrowserConnection = false;
    console.log(`[BrowserEngine] 🔌 Disconnected`);
  }

  // ─── Page Management ───

  /**
   * Get the currently active page. Auto-reconnects if needed.
   */
  async getActivePage(): Promise<any> {
    if (!this.isConnected) {
      throw new Error('Browser not connected. Use launch() first.');
    }

    const page = this.pages.get(this.activePageId);
    if (page && !page.isClosed()) return page;

    // Active page was closed, find next available
    for (const [id, p] of this.pages) {
      if (!p.isClosed()) {
        this.activePageId = id;
        return p;
      }
    }

    // No pages left, create one
    if (this.context) {
      const newPage = await this.context.newPage();
      this.pages.set('main', newPage);
      this.setupPageHandlers(newPage, 'main');
      this.activePageId = 'main';
      return newPage;
    }

    throw new Error('Browser connection lost. Reconnect required.');
  }

  /**
   * Get a specific page by ID.
   */
  async getPage(id: string): Promise<any> {
    const page = this.pages.get(id);
    if (page && !page.isClosed()) return page;
    throw new Error(`Page ${id} not found or closed`);
  }

  /**
   * Open a new tab/page.
   */
  async newPage(url?: string): Promise<{ page: any; id: string }> {
    if (!this.context) throw new Error('Browser not connected');

    const page = await this.context.newPage();
    const id = `tab_${Date.now()}`;
    this.pages.set(id, page);
    this.setupPageHandlers(page, id);
    this.activePageId = id;

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }

    console.log(`[BrowserEngine] 📑 New tab: ${id}`);
    return { page, id };
  }

  /**
   * Reuse an existing tab when the requested URL is already open.
   * This keeps browser-control fast and avoids piling up blank/new tabs.
   */
  async switchOrOpenPage(
    url: string,
    options: { match?: 'exact' | 'origin' | 'host'; navigateIfBlank?: boolean; openIfMissing?: boolean } = {}
  ): Promise<{ page: any; id: string; reused: boolean; reason: 'exact' | 'origin' | 'host' | 'blank' | 'active' | 'new' }> {
    if (!this.context) throw new Error('Browser not connected');

    this.pruneClosedPages();
    const match = options.match || 'exact';
    let blank: { id: string; page: any } | null = null;

    for (const [id, page] of this.pages) {
      if (!page || page.isClosed()) continue;
      const currentUrl = page.url();
      if (this.urlMatches(currentUrl, url, match)) {
        this.activePageId = id;
        await page.bringToFront().catch(() => {});
        return { page, id, reused: true, reason: match };
      }
      if (!blank && this.isBlankUrl(currentUrl)) {
        blank = { id, page };
      }
    }

    if (blank && options.navigateIfBlank !== false) {
      this.activePageId = blank.id;
      await blank.page.bringToFront().catch(() => {});
      await blank.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      return { page: blank.page, id: blank.id, reused: true, reason: 'blank' };
    }

    if (options.openIfMissing === false) {
      const active = await this.getActivePage();
      return { page: active, id: this.activePageId, reused: false, reason: 'active' };
    }

    const opened = await this.newPage(url);
    return { ...opened, reused: false, reason: 'new' };
  }

  /**
   * Switch active tab.
   */
  async switchPage(id: string): Promise<any> {
    const page = this.pages.get(id);
    if (!page || page.isClosed()) throw new Error(`Tab ${id} not found`);
    
    this.activePageId = id;
    await page.bringToFront();
    return page;
  }

  /**
   * Close a tab.
   */
  async closePage(id: string): Promise<boolean> {
    const page = this.pages.get(id);
    if (!page) return false;

    try {
      if (!page.isClosed()) await page.close();
    } catch {}

    this.pages.delete(id);
    this.consoleLogs.delete(id);

    // Switch to next available
    if (this.activePageId === id) {
      for (const [nextId, p] of this.pages) {
        if (!p.isClosed()) {
          this.activePageId = nextId;
          break;
        }
      }
    }

    return true;
  }

  /**
   * List all open tabs.
   */
  getPageList(): PageInfo[] {
    const list: PageInfo[] = [];
    for (const [id, page] of this.pages) {
      if (!page.isClosed()) {
        list.push({
          id,
          url: page.url(),
          title: '', // title() is async, caller should await if needed
          isActive: id === this.activePageId,
        });
      }
    }
    return list;
  }

  /**
   * Get enriched page list with titles (async).
   */
  async getPageListDetailed(): Promise<PageInfo[]> {
    const list: PageInfo[] = [];
    for (const [id, page] of this.pages) {
      if (!page.isClosed()) {
        list.push({
          id,
          url: page.url(),
          title: await page.title().catch(() => ''),
          isActive: id === this.activePageId,
        });
      }
    }
    return list;
  }

  // ─── Console & Dialog ───

  /**
   * Get captured console logs for a page.
   */
  getConsoleLogs(pageId?: string): ConsoleEntry[] {
    const id = pageId || this.activePageId;
    return this.consoleLogs.get(id) || [];
  }

  /**
   * Clear console logs for a page.
   */
  clearConsoleLogs(pageId?: string): void {
    const id = pageId || this.activePageId;
    this.consoleLogs.set(id, []);
  }

  /**
   * Set how dialogs (alerts, confirms, prompts) are handled.
   */
  setDialogAction(action: 'accept' | 'dismiss'): void {
    this.defaultDialogAction = action;
  }

  /**
   * Set a custom dialog handler.
   */
  setDialogHandler(handler: (dialog: any) => Promise<void>): void {
    this.dialogHandler = handler;
  }

  /**
   * Get download history.
   */
  getDownloads(): DownloadInfo[] {
    return [...this.downloads];
  }

  // ─── State ───

  get connected(): boolean {
    return this.isConnected;
  }

  get mode(): ConnectionMode {
    return this.connectionMode;
  }

  get activeTabId(): string {
    return this.activePageId;
  }

  get browserContext(): any {
    return this.context;
  }

  // ─── Internal Helpers ───

  private pruneClosedPages(): void {
    for (const [id, page] of this.pages) {
      try {
        if (!page || page.isClosed()) {
          this.pages.delete(id);
          this.consoleLogs.delete(id);
        }
      } catch {
        this.pages.delete(id);
        this.consoleLogs.delete(id);
      }
    }
  }

  private setupContextHandlers(): void {
    if (!this.context) return;

    // Track new pages opened by the app (popups, window.open, etc.)
    this.context.on('page', (page: any) => {
      const id = `popup_${Date.now()}`;
      this.pages.set(id, page);
      this.setupPageHandlers(page, id);
      console.log(`[BrowserEngine] 📄 New page detected: ${id} → ${page.url()}`);
    });
  }

  private setupPageHandlers(page: any, pageId: string): void {
    try {
      void page.addInitScript('var __name = globalThis.__name = globalThis.__name || ((fn, name) => fn);');
      void page.evaluate('var __name = globalThis.__name = globalThis.__name || ((fn, name) => fn);').catch(() => {});
    } catch {}

    // Console capture
    this.consoleLogs.set(pageId, []);
    page.on('console', (msg: any) => {
      const logs = this.consoleLogs.get(pageId) || [];
      logs.push({
        type: msg.type() as any,
        text: msg.text(),
        timestamp: Date.now(),
        url: page.url(),
      });
      // Keep last 200 entries
      if (logs.length > 200) logs.splice(0, logs.length - 200);
      this.consoleLogs.set(pageId, logs);
    });

    // Dialog handling (alerts, confirms, prompts)
    page.on('dialog', async (dialog: any) => {
      console.log(`[BrowserEngine] 💬 Dialog: ${dialog.type()} — "${dialog.message()}"`);
      
      if (this.dialogHandler) {
        await this.dialogHandler(dialog);
        return;
      }

      if (this.defaultDialogAction === 'accept') {
        await dialog.accept();
      } else {
        await dialog.dismiss();
      }
    });

    // Download tracking
    page.on('download', async (download: any) => {
      const filename = safeDownloadFilename(download.suggestedFilename());
      const info: DownloadInfo = {
        filename,
        url: download.url(),
        path: '',
        state: 'in_progress',
        receivedBytes: 0,
        totalBytes: 0,
      };
      this.downloads.push(info);

      try {
        await fs.ensureDir(this.downloadsDir);
        const savePath = resolveUnder(this.downloadsDir, filename);
        await download.saveAs(savePath);
        info.path = savePath;
        info.state = 'completed';
        console.log(`[BrowserEngine] 📥 Downloaded: ${info.filename}`);
      } catch {
        info.state = 'cancelled';
      }
    });

    // Page crash recovery
    page.on('crash', () => {
      console.error(`[BrowserEngine] 💥 Page ${pageId} crashed`);
      this.pages.delete(pageId);
    });

    // Track page closing
    page.on('close', () => {
      this.pages.delete(pageId);
      this.consoleLogs.delete(pageId);
    });
  }

  /**
   * Find Chrome debug port by checking common ports.
   */
  async findChromeDebugPort(): Promise<number | null> {
    const portsToCheck = [9222, 9223, 9333, 18800, 18801, 18802]; // Common debug ports

    const checks = await Promise.all(portsToCheck.map(async (port) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(650),
        });
        return response.ok ? port : null;
      } catch {}
      return null;
    }));

    for (const port of checks) {
      if (port) {
        console.log(`[BrowserEngine] Found Chrome debug port: ${port}`);
        return port;
      }
    }

    // Fallback: check netstat
    try {
      const { stdout } = await execAsync(
        'netstat -ano | findstr "LISTENING" | findstr /R ":9222 :9223 :9333"',
        { shell: 'cmd.exe', timeout: 1200 }
      );
      if (stdout.includes('9223')) return 9223;
      if (stdout.includes('9222')) return 9222;
      if (stdout.includes('9333')) return 9333;
    } catch {}

    return null;
  }

  /**
   * Find Chrome executable path on Windows.
   */
  private async findBrowserInstall(): Promise<BrowserInstall> {
    const localAppData = process.env.LOCALAPPDATA || '';
    const candidates: Array<Omit<BrowserInstall, 'executablePath'> & { executablePaths: string[] }> = [
      {
        displayName: 'Chrome',
        processName: 'chrome.exe',
        executablePaths: [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
        ],
        userDataDirCandidates: [
          localAppData ? path.join(localAppData, 'Google', 'Chrome', 'User Data') : '',
        ].filter(Boolean),
      },
      {
        displayName: 'Brave',
        processName: 'brave.exe',
        executablePaths: [
          'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
          'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
          localAppData ? path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') : '',
        ],
        userDataDirCandidates: [
          localAppData ? path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data') : '',
        ].filter(Boolean),
      },
      {
        displayName: 'Edge',
        processName: 'msedge.exe',
        executablePaths: [
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          localAppData ? path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
        ],
        userDataDirCandidates: [
          localAppData ? path.join(localAppData, 'Microsoft', 'Edge', 'User Data') : '',
        ].filter(Boolean),
      },
    ];

    for (const candidate of candidates) {
      for (const executablePath of candidate.executablePaths.filter(Boolean)) {
        if (await fs.pathExists(executablePath)) {
          return {
            displayName: candidate.displayName,
            executablePath,
            processName: candidate.processName,
            userDataDirCandidates: candidate.userDataDirCandidates,
          };
        }
      }
    }

    try {
      const result = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve',
        { encoding: 'utf-8', timeout: 3000 }
      );
      const match = result.match(/REG_SZ\s+(.+\.exe)/i);
      if (match) {
        return {
          displayName: 'Chrome',
          executablePath: match[1].trim(),
          processName: 'chrome.exe',
          userDataDirCandidates: candidates[0].userDataDirCandidates,
        };
      }
    } catch {}

    return {
      displayName: 'Chrome',
      executablePath: 'chrome',
      processName: 'chrome.exe',
      userDataDirCandidates: candidates[0].userDataDirCandidates,
    };
  }

  async findChromePath(): Promise<string> {
    return (await this.findBrowserInstall()).executablePath;
  }

  private async findAvailableDebugPort(candidates: number[]): Promise<number | null> {
    for (const port of candidates) {
      if (await this.isPortAvailable(port)) return port;
    }
    return null;
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });
  }

  private isBlankUrl(url: string): boolean {
    return !url || url === 'about:blank' || url.startsWith('chrome://newtab');
  }

  private urlMatches(current: string, target: string, match: 'exact' | 'origin' | 'host'): boolean {
    if (this.isBlankUrl(current) || this.isBlankUrl(target)) return false;

    try {
      const currentUrl = new URL(current);
      const targetUrl = new URL(target);
      if (match === 'host') return currentUrl.host === targetUrl.host;
      if (match === 'origin') return currentUrl.origin === targetUrl.origin;

      const currentHref = this.stripUrlNoise(currentUrl);
      const targetHref = this.stripUrlNoise(targetUrl);
      return currentHref === targetHref;
    } catch {
      return current === target;
    }
  }

  private stripUrlNoise(url: URL): string {
    url.hash = '';
    const href = url.href.replace(/\/$/, '');
    return href;
  }

  private getUserAgent(): string {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  }
}

// ═══════════════════════════════════════
// GLOBAL SINGLETON
// ═══════════════════════════════════════
export const browserEngine = new BrowserEngine();
