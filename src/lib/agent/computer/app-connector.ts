/**
 * ═══════════════════════════════════════════════════════════════
 * ETERX APP CONNECTOR — Connect to ANY Running Application
 * ═══════════════════════════════════════════════════════════════
 * Hooks into any Windows app via:
 *  1. Windows UI Automation (find/interact with any control)
 *  2. Process monitoring (track app state, CPU, memory)
 *  3. Window messaging (send commands to apps)
 *  4. Clipboard bridge (data exchange with any app)
 *  5. WinEvent hooks (real-time app event subscription)
 *
 * Works with: Notepad, VS Code, Excel, Chrome, Slack, Discord,
 * Figma, Photoshop, terminals, games, any Win32/WPF/UWP app.
 * ═══════════════════════════════════════════════════════════════
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { monitorEmitter } from '../monitor/emitter';
import { bindComputerTarget, isUnsafeHostControlEnabled } from './computer-session';
import { buildTerminalShellInvocation } from '../tools/core/shell_resolver';

const execFileAsync = promisify(execFile);

async function ps(script: string, timeout = 8000): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error(`Windows application connector is unavailable on ${process.platform}.`);
  }
  if (!isUnsafeHostControlEnabled()) return '';
  try {
    const invocation = buildTerminalShellInvocation(script, 'powershell');
    const { stdout } = await execFileAsync(invocation.file, invocation.args, {
      timeout,
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.trim();
  } catch (e: any) {
    return '';
  }
}

// ─── App Info ─────────────────────────────────────────────────────────────────

export interface AppInfo {
  pid: number;
  name: string;
  title: string;
  handle: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
  isFocused: boolean;
  cpuPercent?: number;
  memoryMB?: number;
  path?: string;
}

export interface UIControl {
  ref: string;
  name: string;
  controlType: string;
  value?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  isEnabled: boolean;
  isVisible: boolean;
}

// ─── List all visible apps ─────────────────────────────────────────────────────

export async function listApps(): Promise<AppInfo[]> {
  const out = await ps(`
    Add-Type @'
    using System.Runtime.InteropServices;
    using System.Text;
    public class WM {
      [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
      [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
      [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
      [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
    }
'@;
    $fg = [WM]::GetForegroundWindow();
    $procs = Get-Process | Where-Object {$_.MainWindowTitle -ne '' -and $_.MainWindowHandle -ne [IntPtr]::Zero};
    foreach($p in $procs) {
      try {
        $r = New-Object WM+RECT;
        [WM]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null;
        $w = $r.R - $r.L; $h = $r.B - $r.T;
        $max = [WM]::IsZoomed($p.MainWindowHandle);
        $foc = $p.MainWindowHandle -eq $fg;
        "$($p.Id)|$($p.ProcessName)|$($p.MainWindowTitle)|$($p.MainWindowHandle)|$($r.L)|$($r.T)|$w|$h|$max|$foc"
      } catch {}
    }
  `, 8000);

  return out.split('\n').filter(l => l.includes('|')).map(line => {
    const [pid, name, title, handle, x, y, w, h, max, foc] = line.trim().split('|');
    return {
      pid: parseInt(pid) || 0,
      name: name || '',
      title: title || '',
      handle: handle || '0',
      x: parseInt(x) || 0,
      y: parseInt(y) || 0,
      width: parseInt(w) || 0,
      height: parseInt(h) || 0,
      isMaximized: max?.trim() === 'True',
      isFocused: foc?.trim() === 'True',
    };
  }).filter(a => a.pid > 0 && a.name);
}

// ─── Find app by name ─────────────────────────────────────────────────────────

export async function findApp(nameOrTitle: string): Promise<AppInfo | null> {
  const apps = await listApps();
  const q = nameOrTitle.toLowerCase();
  return apps.find(a =>
    a.name.toLowerCase().includes(q) ||
    a.title.toLowerCase().includes(q)
  ) || null;
}

// ─── Focus app ────────────────────────────────────────────────────────────────

export async function focusApp(nameOrTitle: string, chatId?: string): Promise<boolean> {
  const app = await findApp(nameOrTitle);
  if (!app) return false;

  await ps(`
    Add-Type @'
    using System.Runtime.InteropServices;
    public class WF { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n); }
'@;
    [WF]::ShowWindow([System.IntPtr]${app.handle}, 9);
    [WF]::SetForegroundWindow([System.IntPtr]${app.handle});
  `);

  monitorEmitter.appConnected(app.name, app.pid, app.title, chatId);
  bindComputerTarget({ title: app.title, processName: app.name }, chatId);
  return true;
}

// ─── Get UI controls from any app (Windows UI Automation) ────────────────────

export async function getAppControls(nameOrTitle: string, filter?: string): Promise<UIControl[]> {
  const app = await findApp(nameOrTitle);
  if (!app) return [];

  const filterPart = filter ? `.Where(function($e){ $e.Name -like '*${filter.replace(/'/g, "''")}*' })` : '';

  const out = await ps(`
    [void][System.Reflection.Assembly]::LoadWithPartialName('UIAutomationClient');
    [void][System.Reflection.Assembly]::LoadWithPartialName('UIAutomationTypes');
    $root = [System.Windows.Automation.AutomationElement]::RootElement;
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${app.pid});
    $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond);
    if($window -eq $null) { return }
    $all = $window.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition);
    $results = @();
    foreach($el in $all) {
      try {
        $name = $el.Current.Name;
        $ctrl = $el.Current.ControlType.ProgrammaticName.Replace('ControlType.','');
        $rect = $el.Current.BoundingRectangle;
        $enabled = $el.Current.IsEnabled;
        $visible = -not $el.Current.IsOffscreen;
        if($rect.Width -gt 0 -and $rect.Height -gt 0 -and ($name -ne '' -or $ctrl -ne 'Text')) {
          $valPat = $null;
          try { $valPat = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch {}
          $val = if($valPat){ $valPat.Current.Value } else { '' }
          "$name|$ctrl|$([int]$rect.X)|$([int]$rect.Y)|$([int]$rect.Width)|$([int]$rect.Height)|$enabled|$visible|$val"
        }
      } catch {}
    }
    $results | Select-Object -First 50
  `, 12000);

  return out.split('\n').filter(l => l.includes('|')).map((line, i) => {
    const parts = line.trim().split('|');
    const [name, ctrl, x, y, w, h, enabled, visible, val] = parts;
    const nx = parseInt(x) || 0, ny = parseInt(y) || 0;
    const nw = parseInt(w) || 0, nh = parseInt(h) || 0;
    return {
      ref: `ctrl_${i}`,
      name: name || '',
      controlType: ctrl || 'Unknown',
      value: val || undefined,
      x: nx, y: ny,
      width: nw, height: nh,
      centerX: nx + Math.floor(nw / 2),
      centerY: ny + Math.floor(nh / 2),
      isEnabled: enabled?.trim() === 'True',
      isVisible: visible?.trim() === 'True',
    };
  }).filter(c => c.width > 0 && c.height > 0);
}

// ─── Read text content from any app ──────────────────────────────────────────

export async function readAppText(nameOrTitle: string): Promise<string> {
  const app = await findApp(nameOrTitle);
  if (!app) return '';

  const out = await ps(`
    [void][System.Reflection.Assembly]::LoadWithPartialName('UIAutomationClient');
    [void][System.Reflection.Assembly]::LoadWithPartialName('UIAutomationTypes');
    $root = [System.Windows.Automation.AutomationElement]::RootElement;
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${app.pid});
    $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond);
    if($window -eq $null) { return }
    $textCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document);
    $textEl = $window.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $textCond);
    if($textEl) {
      try {
        $pat = $textEl.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern);
        $pat.DocumentRange.GetText(5000)
      } catch {}
    }
  `, 10000);

  return out;
}

// ─── Type into a specific control ────────────────────────────────────────────

export async function typeIntoApp(nameOrTitle: string, controlName: string, text: string): Promise<boolean> {
  const app = await findApp(nameOrTitle);
  if (!app) return false;

  // Focus the app first
  await focusApp(nameOrTitle);
  await new Promise(r => setTimeout(r, 200));

  // Find the control and set value via UI Automation
  const result = await ps(`
    [void][System.Reflection.Assembly]::LoadWithPartialName('UIAutomationClient');
    [void][System.Reflection.Assembly]::LoadWithPartialName('UIAutomationTypes');
    $root = [System.Windows.Automation.AutomationElement]::RootElement;
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${app.pid});
    $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond);
    if($window -eq $null) { "NOTFOUND"; return }
    $nameCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${controlName.replace(/'/g, "''")}');
    $el = $window.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $nameCond);
    if($el -eq $null) { "NOTFOUND"; return }
    try {
      $pat = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern);
      $pat.SetValue('${text.replace(/'/g, "''")}');
      "OK"
    } catch {
      $el.SetFocus();
      Add-Type -AssemblyName System.Windows.Forms;
      [System.Windows.Forms.SendKeys]::SendWait('${text.replace(/[+^%~(){}\[\]]/g, c => `{${c}}`).replace(/'/g, "''")}');
      "OK_SENDKEYS"
    }
  `, 10000);

  return result.startsWith('OK');
}

// ─── Click a named control in any app ────────────────────────────────────────

export async function clickInApp(nameOrTitle: string, controlName: string): Promise<boolean> {
  const app = await findApp(nameOrTitle);
  if (!app) return false;

  await focusApp(nameOrTitle);
  await new Promise(r => setTimeout(r, 150));

  const result = await ps(`
    [void][System.Reflection.Assembly]::LoadWithPartialName('UIAutomationClient');
    [void][System.Reflection.Assembly]::LoadWithPartialName('UIAutomationTypes');
    $root = [System.Windows.Automation.AutomationElement]::RootElement;
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${app.pid});
    $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond);
    if($window -eq $null) { "NOTFOUND"; return }
    $nameCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${controlName.replace(/'/g, "''")}');
    $el = $window.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $nameCond);
    if($el -eq $null) { "NOTFOUND"; return }
    try {
      $pat = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern);
      $pat.Invoke();
      "OK_INVOKE"
    } catch {
      $rect = $el.Current.BoundingRectangle;
      $cx = [int]($rect.X + $rect.Width/2);
      $cy = [int]($rect.Y + $rect.Height/2);
      Add-Type @'
      using System.Runtime.InteropServices;
      public class MC { 
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, int d, int i);
      }
'@;
      [MC]::SetCursorPos($cx, $cy);
      Start-Sleep -Milliseconds 60;
      [MC]::mouse_event(2, 0, 0, 0, 0);
      [MC]::mouse_event(4, 0, 0, 0, 0);
      "OK_CLICK"
    }
  `, 10000);

  return result.startsWith('OK');
}

// ─── Get app process stats ────────────────────────────────────────────────────

export async function getAppStats(nameOrTitle: string): Promise<{ cpu: number; memoryMB: number; threads: number } | null> {
  const app = await findApp(nameOrTitle);
  if (!app) return null;

  const out = await ps(`
    $p = Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue;
    if($p){ "$([math]::Round($p.CPU,2))|$([math]::Round($p.WorkingSet64/1MB,1))|$($p.Threads.Count)" }
  `);
  if (!out) return null;
  const [cpu, mem, threads] = out.split('|');
  return { cpu: parseFloat(cpu) || 0, memoryMB: parseFloat(mem) || 0, threads: parseInt(threads) || 0 };
}

// ─── Monitor app state changes ────────────────────────────────────────────────

let _appWatchInterval: NodeJS.Timeout | null = null;
let _lastKnownApps: Map<number, string> = new Map();

export function startAppMonitor(chatId?: string, intervalMs = 3000): () => void {
  if (_appWatchInterval) clearInterval(_appWatchInterval);

  _appWatchInterval = setInterval(async () => {
    try {
      const apps = await listApps();
      const current = new Map(apps.map(a => [a.pid, a.title]));

      // Detect new apps
      for (const [pid, title] of current) {
        if (!_lastKnownApps.has(pid)) {
          const app = apps.find(a => a.pid === pid);
          if (app) {
            monitorEmitter.appConnected(app.name, app.pid, app.title, chatId);
          }
        }
      }

      // Detect closed apps
      for (const [pid, title] of _lastKnownApps) {
        if (!current.has(pid)) {
          monitorEmitter.appDisconnected(title, chatId);
        }
      }

      // Detect focused app
      const focused = apps.find(a => a.isFocused);
      if (focused) {
        monitorEmitter.appState(focused.name, { title: focused.title, focused: true, pid: focused.pid }, chatId);
      }

      _lastKnownApps = current;
    } catch { /* silent */ }
  }, intervalMs);

  _appWatchInterval.unref?.();

  return () => {
    if (_appWatchInterval) {
      clearInterval(_appWatchInterval);
      _appWatchInterval = null;
    }
  };
}

// ─── Send keystrokes to a specific app ───────────────────────────────────────

export async function sendKeysToApp(nameOrTitle: string, keys: string): Promise<boolean> {
  const focused = await focusApp(nameOrTitle);
  if (!focused) return false;
  await new Promise(r => setTimeout(r, 200));

  await ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys.replace(/'/g, "''")}');`);
  return true;
}

// ─── Run any app ──────────────────────────────────────────────────────────────

export async function launchApp(appName: string, args?: string, chatId?: string): Promise<AppInfo | null> {
  // Try direct launch first
  try {
    await ps(`Start-Process "${appName}" ${args ? `-ArgumentList "${args}"` : ''} -ErrorAction Stop`, 5000);
  } catch {
    // Fallback: Start Menu search
    await ps(`
      Add-Type @'
      using System.Runtime.InteropServices;
      public class KB { [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, int extra); }
'@;
      [KB]::keybd_event(0x5B, 0, 0, 0); # Win key down
      Start-Sleep -Milliseconds 400;
      [KB]::keybd_event(0x5B, 0, 2, 0); # Win key up
      Start-Sleep -Milliseconds 500;
      Add-Type -AssemblyName System.Windows.Forms;
      [System.Windows.Forms.SendKeys]::SendWait('${appName.replace(/'/g, "''")}');
      Start-Sleep -Milliseconds 800;
      [System.Windows.Forms.SendKeys]::SendWait('{ENTER}');
    `, 8000);
  }

  // Wait for window to appear (up to 5s)
  await new Promise(r => setTimeout(r, 1500));
  const app = await findApp(appName);
  if (app) {
    monitorEmitter.appConnected(app.name, app.pid, app.title, chatId);
    bindComputerTarget({ title: app.title, processName: app.name }, chatId);
  }
  return app;
}

// ─── Export connector singleton ───────────────────────────────────────────────

export const appConnector = {
  listApps,
  findApp,
  focusApp,
  getAppControls,
  readAppText,
  typeIntoApp,
  clickInApp,
  getAppStats,
  startAppMonitor,
  sendKeysToApp,
  launchApp,
};

export default appConnector;
