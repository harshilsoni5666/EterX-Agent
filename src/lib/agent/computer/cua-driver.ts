import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

type CuaHealth = {
  schema_version?: string;
  platform?: string;
  driver_version?: string;
  overall?: 'ok' | 'degraded' | 'failed' | string;
  checks?: Array<{ name?: string; status?: string; message?: string; hint?: string }>;
};

export type CuaDriverStatus = {
  installed: boolean;
  version: string | null;
  daemonRunning: boolean;
  healthy: boolean;
  overall: string;
  platform: string;
  message: string;
  health?: CuaHealth;
};

export type CuaActionResult = {
  success: boolean;
  result: unknown;
  provider: string;
  vision?: { inlineData: { data: string; mimeType: 'image/png' } } | null;
};

const PROVIDER = 'Cua Driver (background desktop control)';
const STATUS_TTL_MS = 2500;
let statusCache: { expiresAt: number; value: CuaDriverStatus } | null = null;
let statusPromise: Promise<CuaDriverStatus> | null = null;

function driverCommand(): string {
  const configured = String(process.env.ETERX_CUA_DRIVER_CMD || '').trim();
  if (configured) return configured;

  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [path.join(home, 'AppData', 'Local', 'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver.exe')]
    : process.platform === 'darwin'
      ? ['/opt/homebrew/bin/cua-driver', '/usr/local/bin/cua-driver', path.join(home, '.local', 'bin', 'cua-driver')]
      : ['/usr/local/bin/cua-driver', '/usr/bin/cua-driver', path.join(home, '.local', 'bin', 'cua-driver')];
  return candidates.find(candidate => fs.existsSync(candidate)) || 'cua-driver';
}

function parseJson<T>(stdout: string): T | null {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text) as T; } catch {}
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)) as T; } catch {}
  }
  return null;
}

async function runCua(args: string[], timeout = 8000): Promise<string> {
  const result = await execFileAsync(driverCommand(), args, {
    timeout,
    windowsHide: true,
    maxBuffer: 12 * 1024 * 1024,
  });
  return String(result.stdout || '');
}

async function probeStatus(): Promise<CuaDriverStatus> {
  let version = '';
  try {
    version = (await runCua(['--version'], 2500)).trim();
  } catch {
    return {
      installed: false,
      version: null,
      daemonRunning: false,
      healthy: false,
      overall: 'missing',
      platform: process.platform,
      message: 'cua-driver is not installed or is not on PATH.',
    };
  }

  let daemonRunning = false;
  try {
    const status = (await runCua(['status'], 3500)).toLowerCase();
    daemonRunning = /daemon\s+is\s+running|running\s+on/.test(status) && !/not running|unhealthy/.test(status);
  } catch {}

  let health: CuaHealth | undefined;
  try {
    health = parseJson<CuaHealth>(await runCua(['call', 'health_report', '{}'], 9000)) || undefined;
  } catch {}

  const overall = health?.overall || (daemonRunning ? 'unknown' : 'stopped');
  const healthy = daemonRunning && overall === 'ok';
  const message = healthy
    ? `Driver ${health?.driver_version || version.replace(/^cua-driver\s+/i, '')} is ready.`
    : daemonRunning
      ? (health?.checks?.find(check => check.status === 'fail')?.message || 'Driver is running but needs attention.')
      : 'Driver is installed but its background daemon is not running.';

  return {
    installed: true,
    version: health?.driver_version || version.replace(/^cua-driver\s+/i, '') || null,
    daemonRunning,
    healthy,
    overall,
    platform: health?.platform || process.platform,
    message,
    health,
  };
}

async function probeDaemonOnly(): Promise<CuaDriverStatus> {
  let version = '';
  try {
    version = (await runCua(['--version'], 2500)).trim();
  } catch {
    return {
      installed: false,
      version: null,
      daemonRunning: false,
      healthy: false,
      overall: 'missing',
      platform: process.platform,
      message: 'cua-driver is not installed or is not on PATH.',
    };
  }

  try {
    const status = (await runCua(['status'], 3500)).toLowerCase();
    const daemonRunning = /daemon\s+is\s+running|running\s+on/.test(status) && !/not running|unhealthy/.test(status);
    return {
      installed: true,
      version: version.replace(/^cua-driver\s+/i, '') || null,
      daemonRunning,
      healthy: daemonRunning,
      overall: daemonRunning ? 'unknown' : 'stopped',
      platform: process.platform,
      message: daemonRunning ? 'Cua Driver daemon is ready.' : 'Cua Driver daemon is not running.',
    };
  } catch {
    return {
      installed: true,
      version: version.replace(/^cua-driver\s+/i, '') || null,
      daemonRunning: false,
      healthy: false,
      overall: 'stopped',
      platform: process.platform,
      message: 'Cua Driver is installed but its daemon is not running.',
    };
  }
}

export async function getCuaDriverStatus(force = false): Promise<CuaDriverStatus> {
  if (!force && statusCache && statusCache.expiresAt > Date.now()) return statusCache.value;
  if (statusPromise) return statusPromise;
  statusPromise = probeStatus().then(value => {
    statusCache = { value, expiresAt: Date.now() + STATUS_TTL_MS };
    return value;
  }).finally(() => { statusPromise = null; });
  return statusPromise;
}

export async function ensureCuaDriverDaemon(): Promise<CuaDriverStatus> {
  // Desktop actions only need a live endpoint. The detailed health report is
  // intentionally reserved for the settings/status surface so it cannot add
  // seconds of latency to every click or keystroke.
  const current = await probeDaemonOnly();
  if (!current.installed || current.daemonRunning) return current;

  const child = spawn(driverCommand(), ['serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 350 : 250));
    const next = await probeDaemonOnly();
    if (next.daemonRunning) return next;
  }
  return probeDaemonOnly();
}

async function callCuaTool(tool: string, input: Record<string, unknown> = {}, options: { timeout?: number; screenshotOutFile?: string } = {}) {
  const args = ['call', tool, JSON.stringify(input)];
  if (options.screenshotOutFile) args.push('--screenshot-out-file', options.screenshotOutFile);
  const stdout = await runCua(args, options.timeout ?? 15000);
  return parseJson<any>(stdout) ?? { raw: stdout.trim() };
}

async function captureCuaScreen(): Promise<{ data: string; mimeType: 'image/png' } | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eterx-cua-'));
  const imagePath = path.join(dir, 'screen.png');
  try {
    await callCuaTool('get_desktop_state', {}, { timeout: 15000, screenshotOutFile: imagePath });
    if (!(await fs.pathExists(imagePath))) return null;
    return { data: (await fs.readFile(imagePath)).toString('base64'), mimeType: 'image/png' };
  } finally {
    await fs.remove(dir).catch(() => {});
  }
}

async function withDesktopVision(result: unknown): Promise<CuaActionResult> {
  const vision = await captureCuaScreen();
  return { success: true, result, provider: PROVIDER, vision: vision ? { inlineData: vision } : null };
}

function actionCoordinates(input: any): Record<string, unknown> {
  return {
    scope: 'desktop',
    x: Number(input.x),
    y: Number(input.y),
  };
}

function normalizeKey(key: string): string {
  const value = key.trim().toLowerCase();
  const aliases: Record<string, string> = {
    esc: 'escape',
    enter: 'return',
    ctrl: 'control',
    page_up: 'pageup',
    page_down: 'pagedown',
  };
  return aliases[value] || value;
}

async function listWindows(): Promise<any[]> {
  const result = await callCuaTool('list_windows', {});
  return Array.isArray(result?.windows) ? result.windows : [];
}

async function resolveWindow(query: string): Promise<any | null> {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const windows = await listWindows();
  return windows.find(window => `${window.app_name || ''} ${window.title || ''}`.toLowerCase().includes(needle)) || null;
}

const CUA_ACTIONS = new Set([
  'see', 'see_region', 'click', 'right_click', 'double_click', 'drag', 'type', 'key', 'scroll', 'hover',
  'get_cursor', 'list_apps', 'focus_app', 'launch_app', 'find', 'read', 'wait_text',
  'select_all', 'copy', 'paste', 'save', 'undo', 'close_window',
]);

async function getWindowElements(query?: string): Promise<{ window: any; elements: any[] } | null> {
  const windows = (await listWindows())
    .filter(window => window?.is_on_screen !== false && Number.isFinite(Number(window?.pid)) && Number.isFinite(Number(window?.window_id)))
    .sort((a, b) => Number(b?.z_index ?? -1) - Number(a?.z_index ?? -1));
  const needle = String(query || '').trim().toLowerCase();
  const ordered = needle
    ? [...windows.filter(window => `${window.app_name || ''} ${window.title || ''}`.toLowerCase().includes(needle)), ...windows]
    : windows;
  const seen = new Set<string>();
  // A desktop may expose hundreds of installed-but-hidden apps. Semantic
  // discovery is intentionally scoped to the frontmost few visible windows;
  // callers can focus an app first when they need a different target.
  for (const window of ordered.slice(0, 4)) {
    const key = `${window.pid}:${window.window_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const state = await callCuaTool('get_window_state', {
        pid: Number(window.pid),
        window_id: Number(window.window_id),
        include_screenshot: false,
        max_depth: 12,
        max_elements: 500,
      });
      const elements = Array.isArray(state?.elements) ? state.elements : [];
      if (elements.length) return { window, elements };
    } catch {}
  }
  return null;
}

export async function executeCuaScreenAction(action: string, input: any): Promise<CuaActionResult | null> {
  if (!CUA_ACTIONS.has(action)) return null;
  const status = await ensureCuaDriverDaemon();
  if (!status.installed) return null;
  if (!status.daemonRunning) {
    return { success: false, result: `${status.message} Start the cua-driver daemon and retry.`, provider: PROVIDER, vision: null };
  }

  try {
    if (action === 'see' || action === 'see_region') {
      const vision = await captureCuaScreen();
      return vision
        ? { success: true, result: action === 'see_region' ? 'Current desktop captured; Cua Driver returns the full desktop frame.' : 'Current desktop captured', provider: PROVIDER, vision: { inlineData: vision } }
        : { success: false, result: 'Cua Driver did not return a desktop screenshot.', provider: PROVIDER, vision: null };
    }

    if (action === 'click' || action === 'right_click' || action === 'double_click') {
      const tool = action === 'right_click' ? 'right_click' : action === 'double_click' ? 'double_click' : 'click';
      const result = await callCuaTool(tool, actionCoordinates(input));
      return withDesktopVision(result?.message || `${action} dispatched through Cua Driver.`);
    }

    if (action === 'drag') {
      const result = await callCuaTool('drag', {
        from_x: Number(input.x), from_y: Number(input.y), to_x: Number(input.x2), to_y: Number(input.y2), scope: 'desktop',
      });
      return withDesktopVision(result?.message || 'Drag dispatched through Cua Driver.');
    }

    if (action === 'type') {
      if (!String(input.text || '')) return { success: false, result: 'No text provided.', provider: PROVIDER, vision: null };
      const target = input.x != null && input.y != null ? actionCoordinates(input) : { scope: 'desktop' };
      const result = await callCuaTool('type_text', { ...target, text: String(input.text) });
      return withDesktopVision(result?.message || `Typed ${String(input.text).length} characters through Cua Driver.`);
    }

    if (action === 'key') {
      const raw = String(input.text || 'enter').split('+').map(normalizeKey);
      const result = raw.length > 1
        ? await callCuaTool('hotkey', { keys: raw, scope: 'desktop' })
        : await callCuaTool('press_key', { key: raw[0], scope: 'desktop' });
      return withDesktopVision(result?.message || `Key ${String(input.text || 'enter')} dispatched through Cua Driver.`);
    }

    if (action === 'scroll') {
      const result = await callCuaTool('scroll', {
        ...actionCoordinates(input), direction: input.direction === 'up' ? 'up' : 'down', amount: Math.max(1, Math.min(50, Number(input.amount || 3))), scope: 'desktop',
      });
      return withDesktopVision(result?.message || 'Scroll dispatched through Cua Driver.');
    }

    if (action === 'hover') {
      const result = await callCuaTool('move_cursor', actionCoordinates(input));
      return withDesktopVision(result?.message || 'Cursor moved through Cua Driver.');
    }

    if (action === 'get_cursor') {
      return { success: true, result: await callCuaTool('get_cursor_position', {}), provider: PROVIDER, vision: null };
    }

    if (action === 'clipboard_get' || action === 'clipboard_set') {
      const result = await callCuaTool(action === 'clipboard_get' ? 'clipboard_read' : 'clipboard_write', action === 'clipboard_get' ? { include_text: true } : { text: String(input.text || '') });
      return { success: true, result, provider: PROVIDER, vision: null };
    }

    if (action === 'list_apps') {
      const result = await callCuaTool('list_apps', {});
      return { success: true, result: result?.apps || result, provider: PROVIDER, vision: null };
    }

    if (action === 'find' || action === 'read') {
      const query = String(input.query || input.text || '').trim().toLowerCase();
      if (action === 'find' && !query) return { success: false, result: 'No query provided.', provider: PROVIDER, vision: null };
      const found = await getWindowElements(action === 'find' ? query : undefined);
      if (!found) return { success: false, result: 'Cua Driver could not read an accessible window on the current desktop.', provider: PROVIDER, vision: null };
      const windowX = Number(found.window?.bounds?.x || 0);
      const windowY = Number(found.window?.bounds?.y || 0);
      const elements = found.elements.map(element => ({
        ...element,
        text: String(element.label || element.value || '').trim(),
        center: {
          x: windowX + Number(element.frame?.x || 0) + Math.round(Number(element.frame?.w || 0) / 2),
          y: windowY + Number(element.frame?.y || 0) + Math.round(Number(element.frame?.h || 0) / 2),
        },
      })).filter(element => element.text);
      if (action === 'read') return withDesktopVision(elements.map(element => element.text).join('\n') || '(no accessible text found)');
      const match = elements.find(element => element.text.toLowerCase().includes(query));
      if (!match) return { success: false, result: `Element "${query}" not found in the accessible desktop window.`, provider: PROVIDER, vision: null };
      return withDesktopVision({
        text: match.text,
        center: match.center,
        bounds: { x: windowX + Number(match.frame?.x || 0), y: windowY + Number(match.frame?.y || 0), w: Number(match.frame?.w || 0), h: Number(match.frame?.h || 0) },
        source: PROVIDER,
        tip: 'Use click with the returned center coordinates.',
      });
    }

    if (action === 'wait_text') {
      const wanted = String(input.text || '').trim().toLowerCase();
      if (!wanted) return { success: false, result: 'No text to wait for.', provider: PROVIDER, vision: null };
      const deadline = Date.now() + Math.min(Number(input.timeout_ms || 12000), 60000);
      while (Date.now() < deadline) {
        const result = await executeCuaScreenAction('find', { query: wanted });
        if (result?.success) return { success: true, result: `Text "${wanted}" appeared.`, provider: PROVIDER, vision: result.vision || null };
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return { success: false, result: `Text "${wanted}" did not appear before the timeout.`, provider: PROVIDER, vision: null };
    }

    if (action === 'focus_app') {
      const target = await resolveWindow(String(input.text || ''));
      if (!target?.pid) return { success: false, result: `Window not found: ${String(input.text || '')}`, provider: PROVIDER, vision: null };
      const result = await callCuaTool('bring_to_front', { pid: target.pid, window_id: target.window_id });
      return withDesktopVision(result?.message || `Focused ${String(input.text || '')}.`);
    }

    if (action === 'launch_app') {
      const needle = String(input.text || '').trim().toLowerCase();
      const apps = (await callCuaTool('list_apps', {}))?.apps || [];
      const app = apps.find((candidate: any) => String(candidate?.name || '').toLowerCase().includes(needle));
      if (!app?.bundle_id) return { success: false, result: `Installed app not found: ${String(input.text || '')}`, provider: PROVIDER, vision: null };
      const result = await callCuaTool('launch_app', { bundle_id: app.bundle_id });
      return withDesktopVision(result?.message || `Launched ${String(input.text || '')}.`);
    }

    const shortcutByAction: Record<string, string[]> = {
      select_all: ['ctrl', 'a'],
      copy: ['ctrl', 'c'],
      paste: ['ctrl', 'v'],
      save: ['ctrl', 's'],
      undo: ['ctrl', 'z'],
      close_window: ['alt', 'f4'],
    };
    if (shortcutByAction[action]) {
      const keys = process.platform === 'darwin' && shortcutByAction[action][0] === 'ctrl'
        ? ['cmd', shortcutByAction[action][1]]
        : shortcutByAction[action];
      const result = await callCuaTool('hotkey', { keys, scope: 'desktop' });
      return withDesktopVision(result?.message || `${action} dispatched through Cua Driver.`);
    }

    return null;
  } catch (error: any) {
    return { success: false, result: String(error?.message || error).replace(/\s+/g, ' ').slice(0, 500), provider: PROVIDER, vision: null };
  }
}

export function cuaDriverProvider(): string {
  return PROVIDER;
}
