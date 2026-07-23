/**
 * ═══════════════════════════════════════════════════════════════
 * ETERX COMPUTER USE ENGINE — Full Human-Like Computer Control
 * ═══════════════════════════════════════════════════════════════
 *
 * This is the brain behind EterX's real-time computer control.
 * It provides the complete SEE → THINK → ACT → VERIFY loop that
 * makes the agent behave like a human operating a computer.
 *
 * Capabilities:
 *  • Screenshot any screen / app window / region
 *  • Feed screenshot BACK to the vision model for reasoning
 *  • OCR: read text from screen at any coordinates
 *  • Find UI elements by visual description
 *  • Verify actions succeeded by comparing before/after screenshots
 *  • Stream live screenshots to the monitor panel in real-time
 *  • Full mouse + keyboard + window control (all apps, not just browser)
 *  • Automatic retry loop when actions fail
 *  • App state tracking (what's open, what's focused)
 * ═══════════════════════════════════════════════════════════════
 */

import path from 'path';
import fs from 'fs-extra';
import { exec } from 'child_process';
import { promisify } from 'util';
import { monitorEmitter } from '../monitor/emitter';

const execAsync = promisify(exec);
const SCREENSHOTS_DIR = path.resolve(process.cwd(), '.workspaces', 'temp', 'screenshots');

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveUnder(parent: string, ...segments: string[]): string {
  const resolved = path.resolve(parent, ...segments);
  if (!isPathInside(parent, resolved)) {
    throw new Error(`Resolved path escapes expected directory: ${resolved}`);
  }
  return resolved;
}

function safeArtifactLabel(label: string, fallback = 'view'): string {
  return String(label || fallback)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 60) || fallback;
}

// ─── PowerShell Preamble (shared with desktop_control.ts) ────────────────────
// Minimal version — full version is in desktop_control.ts
const PS_BASE = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
`.trim();

const PS_DC_PREAMBLE = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;
public class DCE {
  public static void CaptureFullScreen(string filePath) {
    var bounds = Screen.PrimaryScreen.Bounds;
    var bmp = new Bitmap(bounds.Width, bounds.Height);
    var g = Graphics.FromImage(bmp);
    g.CopyFromScreen(bounds.Location, System.Drawing.Point.Empty, bounds.Size);
    g.Dispose();
    bmp.Save(filePath, ImageFormat.Png);
    bmp.Dispose();
  }
  public static void CaptureWindow(IntPtr hwnd, string filePath) {
    RECT r = new RECT();
    GetWindowRect(hwnd, out r);
    int w = r.Right - r.Left;
    int h = r.Bottom - r.Top;
    if(w <= 0 || h <= 0) { CaptureFullScreen(filePath); return; }
    var bmp = new Bitmap(w, h);
    var g = Graphics.FromImage(bmp);
    g.CopyFromScreen(r.Left, r.Top, 0, 0, new Size(w, h));
    g.Dispose();
    bmp.Save(filePath, ImageFormat.Png);
    bmp.Dispose();
  }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@;
`.trim();

async function runPS(script: string, timeout = 12000): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error(`Windows UI automation is unavailable on ${process.platform}.`);
  }
  try {
    const { stdout } = await execAsync(script, { shell: 'powershell.exe', timeout });
    return stdout.trim();
  } catch (e: any) {
    return `ERROR: ${e.message?.substring(0, 200)}`;
  }
}

// ─── Core Screenshot Function ─────────────────────────────────────────────────

export interface ScreenshotResult {
  path: string;
  base64: string;
  width?: number;
  height?: number;
  ts: number;
  source: 'desktop' | 'window' | 'region';
}

export async function captureScreen(label: string = 'view', chatId?: string): Promise<ScreenshotResult | null> {
  await fs.ensureDir(SCREENSHOTS_DIR);
  const filePath = resolveUnder(SCREENSHOTS_DIR, `desktop_${safeArtifactLabel(label)}_${Date.now()}.png`);
  try {
    await runPS(`${PS_DC_PREAMBLE}\n[DCE]::CaptureFullScreen('${filePath.replace(/\\/g, '\\\\')}');`, 12000);
    if (!await fs.pathExists(filePath)) return null;

    const buf = await fs.readFile(filePath);
    const base64 = buf.toString('base64');
    const result: ScreenshotResult = { path: filePath, base64, ts: Date.now(), source: 'desktop' };

    // Stream to monitor in real-time
    monitorEmitter.desktopScreenshot(base64, filePath, chatId);

    return result;
  } catch {
    return null;
  }
}

export async function captureWindow(windowTitle: string, label: string = 'window', chatId?: string): Promise<ScreenshotResult | null> {
  await fs.ensureDir(SCREENSHOTS_DIR);
  const filePath = resolveUnder(SCREENSHOTS_DIR, `window_${safeArtifactLabel(label, 'window')}_${Date.now()}.png`);
  try {
    await runPS(`
      ${PS_DC_PREAMBLE}
      $proc = Get-Process | Where-Object {$_.MainWindowTitle -like '*${windowTitle.replace(/'/g, "''")}*'} | Select-Object -First 1;
      if($proc){ [DCE]::CaptureWindow($proc.MainWindowHandle, '${filePath.replace(/\\/g, '\\\\')}') }
    `, 12000);
    if (!await fs.pathExists(filePath)) return null;
    const buf = await fs.readFile(filePath);
    const base64 = buf.toString('base64');
    const result: ScreenshotResult = { path: filePath, base64, ts: Date.now(), source: 'window' };
    monitorEmitter.desktopScreenshot(base64, filePath, chatId);
    return result;
  } catch {
    return null;
  }
}

// ─── Screen Text Reading (OCR via clipboard trick + PowerShell) ───────────────

export async function readScreenText(x: number, y: number, w: number, h: number): Promise<string> {
  // Captures a region and attempts to extract visible text using Windows OCR engine
  const tmpImg = resolveUnder(SCREENSHOTS_DIR, `ocr_${Date.now()}.png`);
  const txtOut = resolveUnder(SCREENSHOTS_DIR, `ocr_${Date.now()}.txt`);
  try {
    await runPS(`
      ${PS_DC_PREAMBLE}
      $bmp = New-Object System.Drawing.Bitmap(${w}, ${h});
      $g = [System.Drawing.Graphics]::FromImage($bmp);
      $g.CopyFromScreen(${x}, ${y}, 0, 0, (New-Object System.Drawing.Size(${w}, ${h})));
      $g.Dispose();
      $bmp.Save('${tmpImg.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png);
      $bmp.Dispose();
    `);

    // Use Windows OCR (Windows.Media.Ocr) via PowerShell
    const ocrResult = await runPS(`
      Add-Type -AssemblyName System.Runtime.WindowsRuntime;
      $null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime];
      $null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime];
      $null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime];
      function Await($WinRTTask) {
        $asTask = [System.WindowsRuntimeSystemExtensions].GetMethod('AsTask', [type[]]@($WinRTTask.GetType())).Invoke($null, @($WinRTTask));
        $asTask.GetAwaiter().GetResult();
      }
      $file = Await([Windows.Storage.StorageFile]::GetFileFromPathAsync('${tmpImg.replace(/\\/g, '\\\\')}'));
      $stream = Await($file.OpenAsync([Windows.Storage.FileAccessMode]::Read));
      $decoder = Await([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream));
      $bitmap = Await($decoder.GetSoftwareBitmapAsync());
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages();
      $result = Await($engine.RecognizeAsync($bitmap));
      $result.Text
    `, 15000);

    return ocrResult.startsWith('ERROR') ? '' : ocrResult;
  } catch {
    return '';
  } finally {
    fs.remove(tmpImg).catch(() => {});
    fs.remove(txtOut).catch(() => {});
  }
}

// ─── Find UI Element by Description ──────────────────────────────────────────

export interface UIElement {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  name?: string;
  controlType?: string;
  processName?: string;
}

export async function findUIElements(filter?: string): Promise<UIElement[]> {
  // Use Windows UI Automation to find interactive elements
  try {
    const out = await runPS(`
      Add-Type -AssemblyName UIAutomationClient;
      Add-Type -AssemblyName UIAutomationTypes;
      $root = [System.Windows.Automation.AutomationElement]::RootElement;
      $condition = [System.Windows.Automation.Condition]::TrueCondition;
      $focusedWin = [System.Windows.Automation.AutomationElement]::FocusedElement;
      
      $elements = @();
      $scope = [System.Windows.Automation.TreeScope]::Subtree;
      
      if($focusedWin -ne $null) {
        $all = $focusedWin.FindAll($scope, $condition);
        foreach($el in $all) {
          try {
            $name = $el.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty);
            $rect = $el.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty);
            $ctrl = $el.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::ControlTypeProperty);
            if($rect.Width -gt 0 -and $rect.Height -gt 0 -and $name -ne '') {
              $nameStr = [string]$name;
              if('${filter || ''}' -eq '' -or $nameStr -like '*${filter || ''}*') {
                $elements += "${'{'}name:$nameStr,x:$([int]$rect.X),y:$([int]$rect.Y),w:$([int]$rect.Width),h:$([int]$rect.Height),ctrl:$ctrl${'}'}"
              }
            }
          } catch {}
        }
      }
      $elements | Select-Object -First 30 | Out-String
    `, 10000);
    
    // Parse results
    const elements: UIElement[] = [];
    const matches = out.matchAll(/\{name:(.*?),x:(\d+),y:(\d+),w:(\d+),h:(\d+),ctrl:(.*?)\}/g);
    for (const m of matches) {
      const [, name, x, y, w, h] = m;
      const nx = parseInt(x), ny = parseInt(y), nw = parseInt(w), nh = parseInt(h);
      elements.push({ x: nx, y: ny, width: nw, height: nh, centerX: nx + Math.floor(nw/2), centerY: ny + Math.floor(nh/2), name });
    }
    return elements;
  } catch {
    return [];
  }
}

// ─── Active Window State ──────────────────────────────────────────────────────

export interface WindowState {
  title: string;
  processName: string;
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

export async function getActiveWindow(): Promise<WindowState | null> {
  try {
    const out = await runPS(`
      Add-Type -AssemblyName System.Windows.Forms;
      Add-Type @'
      using System.Runtime.InteropServices;
      using System.Text;
      public class WI {
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
        [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
        [DllImport("user32.dll",CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
        [StructLayout(LayoutKind.Sequential)] public struct RECT{public int L,T,R,B;}
      }
'@;
      $hwnd = [WI]::GetForegroundWindow();
      $sb = New-Object System.Text.StringBuilder(256);
      [WI]::GetWindowText($hwnd, $sb, 256) | Out-Null;
      $r = New-Object WI+RECT;
      [WI]::GetWindowRect($hwnd, [ref]$r) | Out-Null;
      $max = [WI]::IsZoomed($hwnd);
      $proc = Get-Process | Where-Object {$_.MainWindowHandle -eq $hwnd} | Select-Object -First 1;
      "$($sb.ToString())|$($proc.ProcessName)|$($proc.Id)|$($r.L)|$($r.T)|$($r.R-$r.L)|$($r.B-$r.T)|$max"
    `, 5000);
    const parts = out.split('|');
    if (parts.length < 7) return null;
    return {
      title: parts[0],
      processName: parts[1],
      pid: parseInt(parts[2]) || 0,
      x: parseInt(parts[3]) || 0,
      y: parseInt(parts[4]) || 0,
      width: parseInt(parts[5]) || 0,
      height: parseInt(parts[6]) || 0,
      isMaximized: parts[7]?.trim() === 'True',
    };
  } catch {
    return null;
  }
}

export async function listOpenWindows(): Promise<WindowState[]> {
  try {
    const out = await runPS(`
      Get-Process | Where-Object {$_.MainWindowTitle -ne '' -and $_.MainWindowHandle -ne 0} | 
      Select-Object MainWindowTitle, ProcessName, Id, MainWindowHandle |
      ForEach-Object {
        "$($_.MainWindowTitle)|$($_.ProcessName)|$($_.Id)"
      }
    `, 8000);
    return out.split('\n').filter(l => l.includes('|')).map(line => {
      const [title, processName, pid] = line.trim().split('|');
      return { title: title || '', processName: processName || '', pid: parseInt(pid) || 0, x: 0, y: 0, width: 0, height: 0, isMaximized: false };
    });
  } catch {
    return [];
  }
}

// ─── Vision-in-Loop: Screenshot → Return as Inline Data for Model ────────────

export interface VisionScreenshot {
  inlineData: {
    data: string;
    mimeType: 'image/png' | 'image/jpeg';
  };
  path: string;
  ts: number;
}

/**
 * Take a screenshot and return it in the format the Gemini vision API expects.
 * This enables the agent to SEE what's on screen and reason about it.
 */
export async function screenshotForVision(label: string = 'vision', chatId?: string): Promise<VisionScreenshot | null> {
  const { captureFrameForVision } = await import('./live-stream');
  const frame = await captureFrameForVision(82, 1280, chatId || '');
  if (!frame) return null;
  return {
    inlineData: {
      data: frame,
      mimeType: 'image/jpeg',
    },
    path: `EterX Computer:${label}`,
    ts: Date.now(),
  };
}

// ─── Auto-Screenshot After Desktop/Browser Action ────────────────────────────

const SCREENSHOT_ACTIONS = new Set([
  'desktop_control', 'screenshot_capture', 'browser_control',
]);

let _lastScreenshotTs = 0;
const MIN_SCREENSHOT_INTERVAL_MS = 800;

/**
 * Called after any tool execution that changes screen state.
 * Captures a screenshot and pushes it to the monitor + returns it for vision.
 */
export async function autoScreenshotAfterAction(
  toolName: string,
  toolOutput: any,
  chatId?: string
): Promise<VisionScreenshot | null> {
  // Only screenshot-worthy tools
  const isDesktopTool = toolName === 'desktop_control' || toolName === 'screenshot_capture';
  const isBrowserTool = toolName === 'browser_control';
  
  if (!isDesktopTool && !isBrowserTool) return null;
  
  // Rate-limit screenshots
  const now = Date.now();
  if (now - _lastScreenshotTs < MIN_SCREENSHOT_INTERVAL_MS) return null;
  _lastScreenshotTs = now;

  // For browser_control: check if toolOutput has a screenshot path
  if (isBrowserTool && toolOutput?.screenshotPath) {
    try {
      const buf = await fs.readFile(toolOutput.screenshotPath);
      const base64 = buf.toString('base64');
      monitorEmitter.browserScreenshot(base64, toolOutput.screenshotPath, chatId);
      return {
        inlineData: { data: base64, mimeType: 'image/png' },
        path: toolOutput.screenshotPath,
        ts: Date.now(),
      };
    } catch { }
  }

  // For desktop_control: if it returned a screenshotPath, use it
  if (isDesktopTool && toolOutput?.screenshotPath) {
    try {
      const buf = await fs.readFile(toolOutput.screenshotPath);
      const base64 = buf.toString('base64');
      monitorEmitter.desktopScreenshot(base64, toolOutput.screenshotPath, chatId);
      return {
        inlineData: { data: base64, mimeType: 'image/png' },
        path: toolOutput.screenshotPath,
        ts: Date.now(),
      };
    } catch { }
  }

  // Fallback: take a fresh screenshot
  if (isDesktopTool) {
    return screenshotForVision('auto_after_action', chatId);
  }

  return null;
}

// ─── Singleton Export ─────────────────────────────────────────────────────────

export const computerUseEngine = {
  captureScreen,
  captureWindow,
  readScreenText,
  findUIElements,
  getActiveWindow,
  listOpenWindows,
  screenshotForVision,
  autoScreenshotAfterAction,
};

export default computerUseEngine;
