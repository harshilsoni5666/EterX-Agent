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
import os from 'os';
import fs from 'fs-extra';
import { execFile, execFileSync, spawn } from 'child_process';
import { promisify } from 'util';
import net from 'net';
import { randomUUID } from 'crypto';
import { buildTerminalShellInvocation } from '../tools/core/shell_resolver';
import { getEterxWorkspaceDir } from '../storage-paths';

const execFileAsync = promisify(execFile);

async function runPowerShellCommand(script: string, timeout = 8000, maxBuffer = 5 * 1024 * 1024): Promise<{ stdout: string; stderr: string }> {
  const invocation = buildTerminalShellInvocation(script, 'powershell');
  return execFileAsync(invocation.file, invocation.args, {
    timeout,
    maxBuffer,
    windowsHide: true,
  });
}

function findExecutableOnPath(candidate: string): string | null {
  if (!candidate) return null;
  const executable = (file: string) => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return true;
    } catch { return false; }
  };
  if (path.isAbsolute(candidate)) return executable(candidate) ? candidate : null;
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const resolved = path.join(directory.replace(/^"|"$/g, ''), extension && path.extname(candidate) ? candidate : `${candidate}${extension}`);
      if (executable(resolved)) return resolved;
    }
  }
  return null;
}

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
  // Browser control is a user-facing desktop capability. Keep an explicit
  // opt-out for managed deployments, but do not require a hidden environment
  // flag before the app can use the browser the user deliberately opened.
  return process.env.ETERX_ALLOW_USER_CHROME !== '0';
}

function shouldRunHeadless(requested?: boolean): boolean {
  return requested === true && process.env.ETERX_BROWSER_ALLOW_HEADLESS === '1';
}

function allowCustomUserDataDir(): boolean {
  return process.env.ETERX_BROWSER_ALLOW_CUSTOM_USER_DATA_DIR === '1';
}

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
    throw new Error(`Blocked browser path traversal: ${resolved}`);
  }
  return resolved;
}

// ═══════════════════════════════════════
// TYPES
// ═══════════════════════════════════════

function safeDownloadFilename(name: string): string {
  const basename = path.basename(String(name || 'download').replace(/[\\/]+/g, path.sep));
  let cleaned = basename
    .replace(/[<>:"|?*\x00-\x1F]/g, '_')
    .replace(/^\.+$/, '')
    .slice(0, 180)
    .replace(/[. ]+$/, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`;
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
  private pageSequence: number = 0;
  private connectionQueue: Promise<unknown> = Promise.resolve();
  private connectionOptions: LaunchOptions = {};

  // Per-page state
  private consoleLogs: Map<string, ConsoleEntry[]> = new Map();
  private downloads: DownloadInfo[] = [];
  private dialogHandler: ((dialog: any) => Promise<void>) | null = null;
  private defaultDialogAction: 'accept' | 'dismiss' = 'accept';

  // Paths
  private profilesDir = getEterxWorkspaceDir('browser_profiles');
  private downloadsDir = getEterxWorkspaceDir('temp', 'downloads');

  // ─── Connection ───

  /**
   * Launch or connect to a browser based on the specified mode.
   * Priority: reuse an existing connection, attach to the signed-in default
   * browser, or launch an explicitly requested managed/remote browser.
   */
  async launch(options: LaunchOptions = {}): Promise<any> {
    const pending = this.connectionQueue.then(async () => {
      try {
        const page = await this.launchCurrent(options);
        this.connectionOptions = { ...this.connectionOptions, ...options, mode: this.connectionMode };
        return page;
      } catch (error) {
        await this.disconnectCurrent();
        throw error;
      }
    });
    this.connectionQueue = pending.catch(() => undefined);
    return pending;
  }

  private async launchCurrent(options: LaunchOptions): Promise<any> {
    this.pruneClosedPages();
    // ─── 1. REUSE existing connection if still alive ───
    if (this.isConnected && this.context) {
      try {
        const page = await this.getActivePage();
        const requestedMode = options.mode;
        const sameTarget = (['profile', 'userDataDir', 'cdpEndpoint', 'wsEndpoint'] as const).every(key => options[key] === undefined || options[key] === this.connectionOptions[key]);
        if (page && !page.isClosed() && sameTarget && (!requestedMode || requestedMode === this.connectionMode)) {
          console.log('[BrowserEngine] Reusing existing browser connection');
          return page;
        }
      } catch {}
    }

    // Keep managed and signed-in browser sessions distinct. Disconnecting a
    // CDP session only detaches EterX; it does not close the user's browser.
    if (this.context || this.browser) {
      await this.disconnectCurrent();
    }

    const mode = options.mode || 'cdp';
    const userChromeAllowed = allowUserChromeAccess();
    if (mode === 'cdp' && options.cdpEndpoint) {
      if (!userChromeAllowed) throw new Error('Signed-in browser control is disabled.');
      this.connectionMode = 'cdp';
      return this.connectCDP(options);
    }

    // Attach to the OS-default Chromium browser when control is already enabled.
    if (userChromeAllowed && mode === 'cdp') {
      try {
        const install = await this.findBrowserInstall();
        const port = await this.findDebugPortForInstall(install);
        if (port) {
          console.log(`[BrowserEngine] Found ${install.displayName} control port ${port}; connecting`);
          this.connectionMode = 'cdp';
          return await this.connectCDP({ ...options, cdpEndpoint: `http://127.0.0.1:${port}` });
        }
      } catch (err: any) {
        console.log(`[BrowserEngine] CDP auto-detect: ${err.message?.substring(0, 60)}`);
      }
    }

    // Otherwise reopen the same signed-in default-browser profile with control enabled.
    if (userChromeAllowed && mode === 'cdp') {
      try {
        const page = await this.launchUserChromeWithDebug(options);
        if (page) return page;
        throw new Error(
          'The signed-in default browser could not be opened for control. ' +
          'Confirm Chrome, Edge, or Brave is the default browser and retry.'
        );
      } catch (err: any) {
        console.log(`[BrowserEngine] Signed-in browser launch failed: ${err.message?.substring(0, 80)}`);
        throw err;
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
      // Never replace a requested signed-in or remote browser with an isolated
      // profile. That changes the account/session the user asked us to use.
      throw err;
    }
  }

  /**
   * Try to launch the user's actual default Chromium browser with a local
   * control port.
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
      console.log(`[BrowserEngine] No ${install.displayName} user data directory found`);
      return null;
    }

    // Check if the browser is already running (the signed-in profile is locked).
    let runningWithoutControl = false;
    try {
      const { stdout } = process.platform === 'win32'
        ? await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${install.processName}`, '/NH'], {
            timeout: 3000,
            windowsHide: true,
          })
        : await execFileAsync('pgrep', ['-f', install.processName.replace(/"/g, '')], {
            timeout: 3000,
          });
      
      if (process.platform === 'win32' ? stdout.toLowerCase().includes(install.processName.toLowerCase()) : Boolean(stdout.trim())) {
        // The browser is already running; check whether control is enabled.
        const port = await this.findDebugPortForInstall(install);
        if (port) {
          // It has debug port! Connect to it
          console.log(`[BrowserEngine] ${install.displayName} is already available for browser control on port ${port}`);
          this.connectionMode = 'cdp';
          return await this.connectCDP({ ...options, cdpEndpoint: `http://127.0.0.1:${port}` });
        }
        
        // Do not silently switch to a different profile.
        console.log(`[BrowserEngine] ${install.displayName} is running without browser control enabled`);
        runningWithoutControl = true;
      }
    } catch {}
    if (runningWithoutControl) {
      throw new Error(
        `${install.displayName} is open but browser control is not enabled. ` +
        `Close every ${install.displayName} window once, then retry. EterX will reopen the same signed-in profile.`
      );
    }

    // The browser is not running; launch its real profile with control enabled.
    const debugPort = await this.findAvailableDebugPort([9222, 9223, 9333, 18800, 18801, 18802]);
    if (!debugPort) {
      console.log('[BrowserEngine] No available local browser-control port found');
      return null;
    }
    console.log(`[BrowserEngine] Launching signed-in ${install.displayName} with browser control on port ${debugPort}`);

    try {
      // Launch the browser as a detached subprocess.
      await new Promise<void>((resolve, reject) => {
        const chromeProcess = spawn(chromePath, [
          `--remote-debugging-port=${debugPort}`,
          '--remote-debugging-address=127.0.0.1',
          `--user-data-dir=${userDataDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-features=TranslateUI',
          '--disable-infobars',
          '--new-window',
        ], {
          detached: true,
          stdio: 'ignore',
          shell: false,
          windowsHide: true,
        });
        chromeProcess.once('error', reject);
        chromeProcess.once('spawn', () => { chromeProcess.unref(); resolve(); });
      });

      // Poll aggressively so a fresh Chrome window becomes usable without a long blank-tab pause.
      let connected = false;
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 150));
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
        console.log(`[BrowserEngine] Signed-in ${install.displayName} is ready on port ${debugPort}`);
        this.connectionMode = 'cdp';
        return await this.connectCDP({ ...options, cdpEndpoint: `http://127.0.0.1:${debugPort}` });
      } else {
        console.log(`[BrowserEngine] ${install.displayName} did not expose its browser-control endpoint in time`);
        return null;
      }
    } catch (err: any) {
      console.log(`[BrowserEngine] Browser subprocess launch failed: ${err.message?.substring(0, 60)}`);
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

    const chromePath = await this.findChromePath(false);
    const browserLaunchOptions: Record<string, any> = {
      headless,
      args: launchArgs,
      viewport: options.viewport === null ? null : (options.viewport || { width: 1920, height: 1080 }),
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
    const page = this.selectBestExistingPage(pages) || await this.context.newPage();
    pages = this.context.pages();
    pages.forEach((p: any, i: number) => {
      const id = i === 0 ? 'main' : `tab_${Date.now()}_${i}`;
      this.registerPage(p, id);
    });
    this.activePageId = [...this.pages.entries()].find(([, candidate]) => candidate === page)?.[0] || 'main';
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
    const page = this.selectBestExistingPage(pages) || await this.context.newPage();
    pages = this.context.pages();
    
    // Register all existing pages
    pages.forEach((p: any, i: number) => {
      const id = i === 0 ? 'main' : `tab_${Date.now()}_${i}`;
      this.registerPage(p, id);
    });

    this.activePageId = [...this.pages.entries()].find(([, candidate]) => candidate === page)?.[0] || 'main';
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
      acceptDownloads: true,
    });
    this.pages.clear();
    this.consoleLogs.clear();

    this.setupContextHandlers();

    const page = await this.context.newPage();
    this.activePageId = this.registerPage(page, 'main');
    this.isConnected = true;

    console.log(`[BrowserEngine] 🌐 Connected to remote browser`);
    return page;
  }

  /**
   * Disconnect and clean up everything.
   */
  async disconnect(): Promise<void> {
    const pending = this.connectionQueue.then(() => this.disconnectCurrent());
    this.connectionQueue = pending.catch(() => undefined);
    return pending;
  }

  private async disconnectCurrent(): Promise<void> {
    this.isConnected = false;
    this.connectionOptions = {};
    // Close events clear the live fields; retain these handles until cleanup
    // completes so the remote transport is released as well as its context.
    const browser = this.browser;
    const context = this.context;
    if (this.ownsBrowserConnection) {
      try { if (context) await context.close(); } catch {}
    }
    // For CDP, Playwright's close() only releases the attachment. There is no
    // disconnect() method, and closing the user's default context is avoided.
    try { if (browser) await browser.close(); } catch {}

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
      this.activePageId = this.registerPage(newPage, 'main');
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
    const id = this.registerPage(page);
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

  async duplicatePage(id?: string): Promise<{ page: any; id: string }> {
    const source = id ? await this.getPage(id) : await this.getActivePage();
    const url = source.url();
    return this.newPage(this.isBlankUrl(url) ? undefined : url);
  }

  async closeOtherPages(keepId?: string): Promise<string[]> {
    const retained = keepId || this.activePageId;
    const closed: string[] = [];
    for (const [id, page] of [...this.pages.entries()]) {
      if (id === retained) continue;
      try {
        if (!page.isClosed()) await page.close();
        closed.push(id);
      } catch {}
      this.pages.delete(id);
      this.consoleLogs.delete(id);
    }
    if (this.pages.has(retained)) this.activePageId = retained;
    return closed;
  }

  async cyclePage(direction: 'next' | 'previous'): Promise<{ page: any; id: string }> {
    this.pruneClosedPages();
    const entries = [...this.pages.entries()];
    if (!entries.length) throw new Error('No browser tabs are open');
    const currentIndex = Math.max(0, entries.findIndex(([id]) => id === this.activePageId));
    const delta = direction === 'next' ? 1 : -1;
    const index = (currentIndex + delta + entries.length) % entries.length;
    const [id, page] = entries[index];
    this.activePageId = id;
    await page.bringToFront().catch(() => {});
    return { page, id };
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

  get connectionInfo(): {
    connected: boolean;
    mode: ConnectionMode;
    activeTabId: string;
    tabCount: number;
    ownsBrowserConnection: boolean;
  } {
    this.pruneClosedPages();
    return {
      connected: this.isConnected,
      mode: this.connectionMode,
      activeTabId: this.activePageId,
      tabCount: this.pages.size,
      ownsBrowserConnection: this.ownsBrowserConnection,
    };
  }

  get browserContext(): any {
    return this.context;
  }

  /** Read-only readiness check used by Settings before offering signed mode. */
  async getSignedBrowserReadiness(): Promise<{ available: boolean; reason: string; browser?: string }> {
    try {
      if (this.isConnected && this.connectionMode === 'managed') {
        const install = await this.findBrowserInstall(false);
        return {
          available: true,
          reason: `Signed-in ${install.displayName} is available; choosing it will switch from the isolated browser.`,
          browser: install.displayName,
        };
      }
      const install = await this.findBrowserInstall();
      const debugPort = await this.findDebugPortForInstall(install);
      if (debugPort) {
        return { available: true, reason: `${install.displayName} is already ready for signed-in control.`, browser: install.displayName };
      }

      let running = false;
      if (process.platform === 'win32') {
        const { stdout } = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${install.processName}`, '/NH'], { timeout: 3000, windowsHide: true });
        running = stdout.toLowerCase().includes(install.processName.toLowerCase());
      } else {
        const { stdout } = await execFileAsync('pgrep', ['-f', install.processName], { timeout: 3000 }).catch(error => {
          if (error.code === 1) return { stdout: '' };
          throw error;
        });
        running = Boolean(stdout.trim());
      }

      if (running) {
        return {
          available: false,
          reason: `${install.displayName} is open without browser control. Close its windows once, then retry signed-in mode.`,
          browser: install.displayName,
        };
      }

      return { available: true, reason: `${install.displayName} can be reopened with the signed-in profile.`, browser: install.displayName };
    } catch (error: any) {
      return { available: false, reason: String(error?.message || 'A supported signed-in browser was not detected.').slice(0, 240) };
    }
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

  private selectBestExistingPage(pages: any[]): any | null {
    const usable = pages.filter((page) => {
      try {
        const url = String(page.url?.() || '');
        return !page.isClosed?.() && !url.startsWith('devtools://') && !url.startsWith('chrome-extension://');
      } catch {
        return false;
      }
    });
    return usable.find((page) => !this.isBlankUrl(page.url())) || usable[0] || null;
  }

  private setupContextHandlers(): void {
    if (!this.context) return;
    const context = this.context;
    const disconnected = () => {
      if (this.context !== context) return;
      this.isConnected = false;
      this.pages.clear();
      this.consoleLogs.clear();
      this.context = null;
      this.browser = null;
      this.ownsBrowserConnection = false;
    };
    context.once('close', disconnected);
    this.browser?.once('disconnected', disconnected);

    // Track new pages opened by the app (popups, window.open, etc.)
    this.context.on('page', (page: any) => {
      if (this.context !== context) return;
      const id = this.registerPage(page);
      this.activePageId = id;
      console.log(`[BrowserEngine] 📄 New page detected: ${id} → ${page.url()}`);
    });
  }

  private registerPage(page: any, preferredId?: string): string {
    for (const [id, existing] of this.pages) if (existing === page) return id;
    const id = preferredId && !this.pages.has(preferredId) ? preferredId : `tab_${Date.now()}_${++this.pageSequence}`;
    this.pages.set(id, page);
    this.setupPageHandlers(page, id);
    return id;
  }

  private setupPageHandlers(page: any, pageId: string): void {
    try {
      void page.addInitScript('var __name = globalThis.__name = globalThis.__name || ((fn, name) => fn);').catch(() => {});
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
      
      try {
        if (this.dialogHandler) await this.dialogHandler(dialog);
        else if (this.defaultDialogAction === 'accept') await dialog.accept();
        else await dialog.dismiss();
      } catch (error: any) {
        console.warn('[BrowserEngine] Dialog could not be handled:', error?.message || error);
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
        // Keep simultaneous downloads with identical filenames separate.
        const directory = resolveUnder(this.downloadsDir, randomUUID());
        await fs.ensureDir(directory);
        const savePath = resolveUnder(directory, filename);
        await download.saveAs(savePath);
        info.path = savePath;
        const stat = await fs.stat(savePath);
        info.receivedBytes = info.totalBytes = stat.size;
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

    const checks = await Promise.all(portsToCheck.map(async port => await this.isBrowserDebugPort(port) ? port : null));

    for (const port of checks) {
      if (port) {
        console.log(`[BrowserEngine] Found Chrome debug port: ${port}`);
        return port;
      }
    }

    return null;
  }

  private async isBrowserDebugPort(port: number, expectedPath?: string): Promise<boolean> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(700) });
      if (!response.ok) return false;
      const version = await response.json();
      const endpoint = new URL(version.webSocketDebuggerUrl);
      return /^wss?:$/.test(endpoint.protocol) && endpoint.pathname.startsWith('/devtools/browser/')
        && (!expectedPath || endpoint.pathname === expectedPath);
    } catch { return false; }
  }

  /**
   * Find Chrome executable path on Windows.
   */
  private async findBrowserInstall(requireSystemDefault = true): Promise<BrowserInstall> {
    const home = os.homedir();
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const configHome = process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME) ? process.env.XDG_CONFIG_HOME : path.join(home, '.config');
    const candidates: Array<Omit<BrowserInstall, 'executablePath'> & { executablePaths: string[] }> = [
      ...(process.platform === 'darwin' ? [{
        displayName: 'Chrome',
        processName: 'Google Chrome',
        executablePaths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')],
        userDataDirCandidates: [path.join(home, 'Library', 'Application Support', 'Google', 'Chrome')],
      }, {
        displayName: 'Brave',
        processName: 'Brave Browser',
        executablePaths: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', path.join(home, 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser')],
        userDataDirCandidates: [path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser')],
      }, {
        displayName: 'Edge',
        processName: 'Microsoft Edge',
        executablePaths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', path.join(home, 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')],
        userDataDirCandidates: [path.join(home, 'Library', 'Application Support', 'Microsoft Edge')],
      }] : []),
      ...(process.platform === 'linux' ? [{
        displayName: 'Chrome',
        processName: 'chrome',
        executablePaths: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', 'google-chrome', 'google-chrome-stable'],
        userDataDirCandidates: [path.join(configHome, 'google-chrome')],
      }, {
        displayName: 'Chromium',
        processName: 'chromium',
        executablePaths: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', 'chromium', 'chromium-browser'],
        userDataDirCandidates: [path.join(configHome, 'chromium'), path.join(home, 'snap', 'chromium', 'common', 'chromium')],
      }, {
        displayName: 'Brave',
        processName: 'brave',
        executablePaths: ['/usr/bin/brave-browser', '/usr/bin/brave', 'brave-browser', 'brave'],
        userDataDirCandidates: [path.join(configHome, 'BraveSoftware', 'Brave-Browser')],
      }, {
        displayName: 'Edge',
        processName: 'msedge',
        executablePaths: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', 'microsoft-edge', 'microsoft-edge-stable'],
        userDataDirCandidates: [path.join(configHome, 'microsoft-edge')],
      }] : []),
      ...(process.platform === 'win32' ? [{
        displayName: 'Chrome',
        processName: 'chrome.exe',
        executablePaths: [
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
          'chrome.exe',
        ],
        userDataDirCandidates: [
          localAppData ? path.join(localAppData, 'Google', 'Chrome', 'User Data') : '',
        ].filter(Boolean),
      },
      {
        displayName: 'Brave',
        processName: 'brave.exe',
        executablePaths: [
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
          path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
          localAppData ? path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') : '',
          'brave.exe',
        ],
        userDataDirCandidates: [
          localAppData ? path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data') : '',
        ].filter(Boolean),
      },
      {
        displayName: 'Edge',
        processName: 'msedge.exe',
        executablePaths: [
          path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          localAppData ? path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
          'msedge.exe',
        ],
        userDataDirCandidates: [
          localAppData ? path.join(localAppData, 'Microsoft', 'Edge', 'User Data') : '',
        ].filter(Boolean),
      }] : []),
    ];

    const detectedDefaultBrowser = this.detectDefaultChromiumBrowser();
    // Browser control is allowed to use an installed supported Chromium
    // browser even when Firefox/Safari is the system default. Prefer a
    // supported default when one exists, then fall back to the first installed
    // Chrome/Edge/Brave on every desktop platform.
    const defaultBrowser = detectedDefaultBrowser === 'unsupported' ? null : detectedDefaultBrowser;
    const orderedCandidates = requireSystemDefault && defaultBrowser
      ? [...candidates].sort((a, b) => (
          Number(b.displayName.toLowerCase() === defaultBrowser) -
          Number(a.displayName.toLowerCase() === defaultBrowser)
        ))
      : candidates;

    for (const candidate of orderedCandidates) {
      for (const executablePath of candidate.executablePaths.filter(Boolean)) {
        const resolvedExecutablePath = findExecutableOnPath(executablePath);
        if (resolvedExecutablePath) {
          return {
            displayName: candidate.displayName,
            executablePath: resolvedExecutablePath,
            processName: candidate.processName,
            userDataDirCandidates: candidate.userDataDirCandidates,
          };
        }
      }
    }

    if (process.platform === 'win32') try {
      const result = execFileSync(
        'reg.exe',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe', '/ve'],
        { encoding: 'utf-8', timeout: 3000, windowsHide: true }
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

    throw new Error(
      `No supported Chromium browser was found on ${process.platform}. ` +
      'Install Chrome, Edge, or Brave, then retry browser control.'
    );
  }

  async findChromePath(requireSystemDefault = true): Promise<string> {
    return (await this.findBrowserInstall(requireSystemDefault)).executablePath;
  }

  private detectDefaultChromiumBrowser(): 'chrome' | 'chromium' | 'brave' | 'edge' | 'unsupported' | null {
    try {
      if (process.platform === 'win32') {
        const output = execFileSync(
          'reg.exe',
          ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'],
          { encoding: 'utf-8', timeout: 2500, windowsHide: true }
        ).toLowerCase();
        if (output.includes('brave')) return 'brave';
        if (output.includes('msedge') || output.includes('microsoftedge')) return 'edge';
        if (output.includes('chrome')) return 'chrome';
        if (output.includes('progid')) return 'unsupported';
      } else if (process.platform === 'darwin') {
        const output = execFileSync(
          'osascript',
          ['-e', 'id of app (path to default application for URL "https://example.com")'],
          { encoding: 'utf-8', timeout: 2500 }
        ).toLowerCase();
        if (output.includes('com.brave.browser')) return 'brave';
        if (output.includes('com.microsoft.edgemac')) return 'edge';
        if (output.includes('com.google.chrome')) return 'chrome';
        if (output.trim()) return 'unsupported';
      } else {
        const output = execFileSync('xdg-settings', ['get', 'default-web-browser'], {
          encoding: 'utf-8',
          timeout: 2500,
        }).toLowerCase();
        if (output.includes('brave')) return 'brave';
        if (output.includes('edge')) return 'edge';
        if (output.includes('chromium')) return 'chromium';
        if (output.includes('chrome')) return 'chrome';
        if (output.trim()) return 'unsupported';
      }
    } catch {
      // Use the first installed supported browser when the OS has no readable default.
    }
    return null;
  }

  private async findDebugPortForInstall(install: BrowserInstall): Promise<number | null> {
    // The profile file also covers --remote-debugging-port=0. Match its browser
    // ID so a stale file cannot attach to a different session reusing the port.
    for (const directory of install.userDataDirCandidates) {
      try {
        const [port, endpointPath] = (await fs.readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
        if (endpointPath && await this.isBrowserDebugPort(Number(port), endpointPath)) return Number(port);
      } catch {}
    }
    try {
      const { stdout } = process.platform === 'win32'
        ? await runPowerShellCommand(
            `Get-CimInstance Win32_Process -Filter "Name='${install.processName.replace(/'/g, "''")}'" | Select-Object -ExpandProperty CommandLine`,
            3000,
          )
        : await execFileAsync('ps', ['-ax', '-o', 'command='], { timeout: 3000 });
      const executableName = path.basename(install.executablePath).toLowerCase();
      const commandLines = stdout.split(/\r?\n/).filter((line) => {
        const normalized = line.toLowerCase();
        return process.platform === 'win32'
          ? true
          : normalized.includes(executableName) || normalized.includes(install.processName.toLowerCase());
      });
      for (const line of commandLines) {
        if (/--type(?:=|\s)/i.test(line)) continue;
        const dataDir = line.match(/--user-data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(.+?)(?=\s+--[a-zA-Z]|$))/i);
        if (dataDir) {
          const normalizeDirectory = (directory: string) => {
            const resolved = path.resolve(directory.trim());
            return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
          };
          const directory = normalizeDirectory(dataDir[1] || dataDir[2] || dataDir[3]);
          if (!install.userDataDirCandidates.some(candidate => normalizeDirectory(candidate) === directory)) continue;
        }
        const match = line.match(/--remote-debugging-port(?:=|\s+)(\d{2,5})/i);
        if (!match) continue;
        const port = Number(match[1]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
        if (await this.isBrowserDebugPort(port)) return port;
      }
    } catch {}
    return null;
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
    return !url || url === 'about:blank' || /^(?:chrome|edge|brave):\/\/(?:newtab|new-tab-page)(?:[/?#]|$)/i.test(url);
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

}

// ═══════════════════════════════════════
// GLOBAL SINGLETON
// ═══════════════════════════════════════
export const browserEngine = new BrowserEngine();
