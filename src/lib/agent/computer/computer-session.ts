import { execFile } from 'child_process';
import { promisify } from 'util';
import { monitorEmitter } from '../monitor/emitter';

const execFileAsync = promisify(execFile);

const GLOBAL_SESSION = 'global';
const UNSAFE_HOST_CONTROL_ENV = 'ETERX_ALLOW_UNSAFE_HOST_COMPUTER';
const UNSAFE_COMMAND_ENV = 'ETERX_ALLOW_SCREEN_AGENT_COMMANDS';

export interface ComputerSession {
  chatId: string;
  targetTitle: string;
  targetProcess: string;
  updatedAt: number;
}

export interface ActiveWindowState {
  title: string;
  processName: string;
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComputerGuardResult {
  allowed: boolean;
  reason?: string;
  activeWindow?: ActiveWindowState | null;
}

const sessions = new Map<string, ComputerSession>();

function keyFor(chatId?: string | null) {
  return chatId || GLOBAL_SESSION;
}

function normalize(value?: string | null) {
  return String(value || '').trim().toLowerCase();
}

function psQuote(value: string) {
  return value.replace(/'/g, "''");
}

async function runPowerShell(script: string, timeout = 5000): Promise<string> {
  if (process.platform !== 'win32') return '';
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout, maxBuffer: 2 * 1024 * 1024 },
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

export function ensureComputerSession(chatId?: string | null): ComputerSession {
  const key = keyFor(chatId);
  const existing = sessions.get(key);
  if (existing) return existing;

  const session: ComputerSession = {
    chatId: key,
    targetTitle: '',
    targetProcess: '',
    updatedAt: Date.now(),
  };
  sessions.set(key, session);
  return session;
}

export function bindComputerTarget(target: { title?: string; processName?: string; name?: string }, chatId?: string | null): ComputerSession {
  const session = ensureComputerSession(chatId);
  session.targetTitle = target.title || session.targetTitle || '';
  session.targetProcess = target.processName || target.name || session.targetProcess || '';
  session.updatedAt = Date.now();

  monitorEmitter.appState(
    session.targetProcess || 'EterX Computer',
    {
      title: session.targetTitle,
      processName: session.targetProcess,
      bounded: true,
      scope: 'eterx_computer',
    },
    chatId || undefined,
  );

  return session;
}

export function getComputerSession(chatId?: string | null): ComputerSession {
  return ensureComputerSession(chatId);
}

export function getComputerCaptureTarget(chatId?: string | null): string {
  const session = ensureComputerSession(chatId);
  return session.targetTitle || session.targetProcess || '';
}

export function isUnsafeHostControlEnabled() {
  return process.env[UNSAFE_HOST_CONTROL_ENV] === '1';
}

export function isScreenAgentCommandEnabled() {
  return process.env[UNSAFE_COMMAND_ENV] === '1' || isUnsafeHostControlEnabled();
}

export async function getActiveWindowState(): Promise<ActiveWindowState | null> {
  const out = await runPowerShell(`
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class EW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
}
'@;
$hwnd = [EW]::GetForegroundWindow();
$r = New-Object EW+RECT;
[EW]::GetWindowRect($hwnd, [ref]$r) | Out-Null;
$sb = New-Object System.Text.StringBuilder 512;
[EW]::GetWindowText($hwnd, $sb, 512) | Out-Null;
$proc = Get-Process | Where-Object { $_.MainWindowHandle -eq $hwnd } | Select-Object -First 1;
"$($sb.ToString())|$($proc.ProcessName)|$($proc.Id)|$($r.L)|$($r.T)|$($r.R - $r.L)|$($r.B - $r.T)"
`, 5000);

  const parts = out.split('|');
  if (parts.length < 7) return null;

  return {
    title: parts[0] || '',
    processName: parts[1] || '',
    pid: parseInt(parts[2], 10) || 0,
    x: parseInt(parts[3], 10) || 0,
    y: parseInt(parts[4], 10) || 0,
    width: parseInt(parts[5], 10) || 0,
    height: parseInt(parts[6], 10) || 0,
  };
}

function activeMatchesSession(active: ActiveWindowState | null, session: ComputerSession) {
  if (!active) return false;
  const activeTitle = normalize(active.title);
  const activeProcess = normalize(active.processName);
  const targetTitle = normalize(session.targetTitle);
  const targetProcess = normalize(session.targetProcess);

  if (targetTitle && (activeTitle.includes(targetTitle) || targetTitle.includes(activeTitle))) return true;
  if (targetProcess && activeProcess.includes(targetProcess)) return true;
  return false;
}

function coordinatesInsideWindow(input: any, active: ActiveWindowState | null) {
  if (!active || input.x == null || input.y == null) return true;
  const tolerance = 8;
  const x = Number(input.x);
  const y = Number(input.y);
  return (
    x >= active.x - tolerance &&
    y >= active.y - tolerance &&
    x <= active.x + active.width + tolerance &&
    y <= active.y + active.height + tolerance
  );
}

const PASSIVE_ACTIONS = new Set([
  'see',
  'list_apps',
  'stream_start',
  'stream_stop',
  'wait_ms',
  'get_cursor',
  'clipboard_get',
]);

export async function assertComputerActionAllowed(
  action: string,
  input: any,
  chatId?: string | null,
): Promise<ComputerGuardResult> {
  ensureComputerSession(chatId);

  if (isUnsafeHostControlEnabled()) {
    return { allowed: true };
  }

  if (action === 'run_command' && !isScreenAgentCommandEnabled()) {
    return {
      allowed: false,
      reason: `screen_agent.run_command is disabled for the EterX Computer. Use workspace_run_command for project commands, or set ${UNSAFE_COMMAND_ENV}=1 only when host shell access is intended.`,
    };
  }

  if (PASSIVE_ACTIONS.has(action)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Host desktop control is disabled. Use the isolated EterX Computer backend, or set ${UNSAFE_HOST_CONTROL_ENV}=1 only when controlling the real desktop is intentional.`,
  };
}

export async function bindActiveWindowAsComputerTarget(chatId?: string | null): Promise<ComputerSession | null> {
  const active = await getActiveWindowState();
  if (!active || (!active.title && !active.processName)) return null;
  return bindComputerTarget({ title: active.title, processName: active.processName }, chatId);
}

export function escapePowerShellLiteral(value: string) {
  return psQuote(value);
}
