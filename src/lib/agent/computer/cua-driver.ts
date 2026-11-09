import { execFile, spawn } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import { setTimeout as delay } from 'timers/promises';


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
  vision?: { inlineData: { data: string; mimeType: 'image/png' | 'image/jpeg' } } | null;
  observation?: Record<string, any>;
  observationError?: string;
  actionStatus?: 'not_sent' | 'sent' | 'unknown';
};

const PROVIDER = 'Cua Driver (background desktop control)';
const STATUS_TTL_MS = 15_000;
let statusCache: { expiresAt: number; value: CuaDriverStatus } | null = null;
let statusPromise: Promise<CuaDriverStatus> | null = null;
let daemonPromise: Promise<CuaDriverStatus> | null = null;
let daemonCache: { expiresAt: number; value: CuaDriverStatus } | null = null;

function driverCommand(): string {
  const configured = String(process.env.ETERX_CUA_DRIVER_CMD || '').trim();
  if (configured) return configured;

  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver.exe')]
    : process.platform === 'darwin'
      ? ['/opt/homebrew/bin/cua-driver', '/usr/local/bin/cua-driver', path.join(home, '.local', 'bin', 'cua-driver')]
      : ['/usr/local/bin/cua-driver', '/usr/bin/cua-driver', path.join(home, '.local', 'bin', 'cua-driver')];
  return candidates.find(candidate => fs.existsSync(candidate)) || 'cua-driver';
}

function parseJson<T>(stdout: string): T | null {
  const text = String(stdout || '').trim();
  if (!text) return null;
  const unwrap = (value: any): T => {
    if (value?.isError || value?.error || value?.success === false || value?.ok === false) return value as T;
    if (value?.structuredContent) return value.structuredContent as T;
    for (const block of Array.isArray(value?.content) ? value.content : []) {
      if (block?.type !== 'text') continue;
      try { return JSON.parse(block.text) as T; } catch {}
    }
    return value as T;
  };
  try {
    return unwrap(JSON.parse(text));
  } catch {}
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return unwrap(JSON.parse(text.slice(first, last + 1)));
    } catch {}
  }
  return null;
}

function daemonIsRunning(stdout: string): boolean {
  const value = parseJson<Record<string, unknown>>(stdout);
  for (const flag of [value?.running, value?.daemonRunning, value?.daemon_running]) {
    if (typeof flag === 'boolean') return flag;
  }
  const status = String(value?.status || stdout).replace(/\x1b\[[0-9;]*m/g, '');
  return /\brunning\b/i.test(status) && !/\bnot\s+running\b|\bisn't\s+running\b|\bstopped\b/i.test(status);
}

export async function runCua(args: string[], timeout = 8000, signal?: AbortSignal, stdin?: string): Promise<string> {
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = execFile(driverCommand(), args, {
        timeout, signal, windowsHide: true, maxBuffer: 24 * 1024 * 1024, encoding: 'utf8',
      }, (error, stdout) => {
        if (error) {
          Object.assign(error, { stdout });
          reject(error);
        } else resolve(String(stdout || ''));
      });
      // CLI tool arguments use stdin so long Unicode/multiline typing is not
      // constrained by Windows command-line limits or exposed in process argv.
      child.stdin?.on('error', () => { /* Process completion carries the failure. */ });
      child.stdin?.end(stdin);
    });
  } catch (error: any) {
    // execFile's message contains the entire argv, including text being typed.
    // Do not echo that into the chat or the monitor on a process failure.
    daemonCache = null;
    if (signal?.aborted) throw new Error('Computer action cancelled. Observe the target before repeating any input that may already have been sent.');
    const structured = parseJson<any>(String(error?.stdout || ''));
    if (args[0] === 'call' && !error?.killed && structured
      && (structured.isError || structured.error || structured.success === false || structured.ok === false)) {
      return String(error.stdout);
    }
    throw new Error(error?.code === 'ENOENT'
      ? 'Cua Driver executable was not found. Install it or set ETERX_CUA_DRIVER_CMD to its executable path.'
      : error?.killed
        ? 'Cua Driver timed out. Input may have been delivered; observe the target before retrying.'
        : `Cua Driver could not complete the request (${String(error?.code || 'process error')}). Refresh desktop status for setup details.`);
  }
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
    daemonRunning = daemonIsRunning(await runCua(['status'], 3500));
  } catch {}

  let health: CuaHealth | undefined;
  try {
    const report = parseJson<CuaHealth & { isError?: boolean; error?: unknown; success?: boolean; ok?: boolean }>(await runCua(['call', 'health_report', '{}'], 9000));
    if (report && !report.isError && !report.error && report.success !== false && report.ok !== false && typeof report.overall === 'string') health = report;
  } catch {}

  const overall = health?.overall || (daemonRunning ? 'unknown' : 'stopped');
  if (health) daemonRunning = true;
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
    const daemonRunning = daemonIsRunning(await runCua(['status'], 3500));
    return {
      installed: true,
      version: version.replace(/^cua-driver\s+/i, '') || null,
      daemonRunning,
      healthy: false,
      overall: daemonRunning ? 'unknown' : 'stopped',
      platform: process.platform,
      message: daemonRunning ? 'Cua Driver daemon is running; detailed health is available in Settings.' : 'Cua Driver daemon is not running.',
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
  if (force) { statusCache = null; daemonCache = null; }
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
  if (daemonCache && daemonCache.expiresAt > Date.now()) return daemonCache.value;
  if (daemonPromise) return daemonPromise;
  daemonPromise = (async () => {
    let current = await probeDaemonOnly();
    if (current.installed && !current.daemonRunning) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(driverCommand(), ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', () => reject(new Error('Could not start the Cua Driver background service.')));
        child.once('spawn', () => { child.unref(); resolve(); });
      });
      const deadline = Date.now() + 12_000;
      do {
        await delay(350);
        current = await probeDaemonOnly();
      } while (!current.daemonRunning && Date.now() < deadline);
    }
    daemonCache = { value: current, expiresAt: Date.now() + (current.daemonRunning ? 10_000 : 2000) };
    statusCache = null;
    return current;
  })().finally(() => { daemonPromise = null; });
  return daemonPromise;
}

export { executeCuaScreenAction, captureCuaPreview, endCuaSession } from './cua-actions';

export function cuaDriverProvider(): string {
  return PROVIDER;
}
