/**
 * ═══════════════════════════════════════════════════════════════
 * ETERX SCREEN AGENT — The Ultimate One-Shot Computer Control Tool
 * ═══════════════════════════════════════════════════════════════
 *
 * One tool. Every action. Real human-like cursor. Enterprise grade.
 *
 * The agent calls this single tool with an `action` and gets back
 * a result + a vision screenshot of what happened. The agent literally
 * SEES and DOES everything on the computer through this tool.
 *
 * Actions:
 *   see           → Take a screenshot. See current screen state.
 *   see_region    → Screenshot a specific rectangle of screen.
 *   click         → Natural bezier move + click. Shows cursor overlay.
 *   right_click   → Right-click with natural movement.
 *   double_click  → Double-click.
 *   type          → Human-like typing (variable delays, realistic feel).
 *   key           → Press keyboard shortcut (e.g. "ctrl+c", "enter", "esc").
 *   scroll        → Scroll up/down at a point or focused element.
 *   drag          → Drag from one point to another.
 *   hover         → Move cursor to position (no click).
 *   find          → Find UI element by name/text using OCR + UIAutomation.
 *   read          → Read text from screen region via Windows OCR.
 *   wait_change   → Wait until screen content changes (diff-based).
 *   wait_text     → Wait until specific text appears on screen.
 *   wait_ms       → Sleep for N milliseconds (useful between actions).
 *   launch_app    → Open any app by name.
 *   focus_app     → Focus any running app.
 *   list_apps     → List all open applications.
 *   get_cursor    → Get current cursor X,Y position.
 *   clipboard_get → Get clipboard text content.
 *   clipboard_set → Set clipboard text content.
 *   stream_start  → Start live screen streaming to monitor panel.
 *   stream_stop   → Stop live streaming.
 *   select_all    → Ctrl+A in current app.
 *   copy          → Ctrl+C.
 *   paste         → Ctrl+V.
 *   save          → Ctrl+S.
 *   undo          → Ctrl+Z.
 *   close_window  → Alt+F4 current window.
 *   maximize      → Maximize current window.
 *   minimize      → Minimize current window.
 *   run_command   → Run a shell command and return output.
 *
 * After EVERY action: auto-screenshots and returns vision data.
 * Cursor overlay shows agent cursor on screen in real-time.
 * ═══════════════════════════════════════════════════════════════
 */

import { z } from 'zod';
import type { ToolDefinition } from '../../schemas';

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { execFile } from 'child_process';
import { monitorEmitter } from '../../monitor/emitter';
import { autoStreamPing } from '../../computer/live-stream';
import {
  assertComputerActionAllowed,
  bindActiveWindowAsComputerTarget,
  bindComputerTarget,
  isUnsafeHostControlEnabled,
  type ActiveWindowState,
} from '../../computer/computer-session';
import {
  clickManagedComputer,
  dragManagedComputer,
  focusManagedApp,
  getManagedCursor,
  launchManagedApp,
  listManagedWindows,
  moveManagedCursor,
  scrollManagedComputer,
  sendManagedKey,
  typeManagedText,
} from '../../computer/managed-computer';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ─── Paths ────────────────────────────────────────────────────────────────────
const TEMP_DIR = path.resolve(process.cwd(), '.workspaces', 'temp', 'screen-agent');

// ─── Hidden PS runner — no window flash, temp file approach ──────────────────
async function ps(script: string, timeout = 12000): Promise<string> {
  const tmp = path.join(os.tmpdir(), `eterx_sa_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`);
  try {
    await fs.writeFile(tmp, script, 'utf8');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NonInteractive', '-WindowStyle', 'Hidden', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      { timeout, maxBuffer: 80 * 1024 * 1024 }
    );
    return stdout.trim();
  } catch (e: any) {
    return `ERROR: ${String(e.message).substring(0, 300)}`;
  } finally {
    fs.remove(tmp).catch(() => {});
  }
}

// ─── Core C# assembly (loaded once per PS session via inline Add-Type) ────────
// Uses GDI BitBlt for fast capture, Win32 for mouse/keyboard, Windows OCR
const CS_PREAMBLE = `
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class SA {
  // ── Win32 imports ──
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")]  public static extern bool BitBlt(IntPtr dst,int dx,int dy,int dw,int dh,IntPtr src,int sx,int sy,uint op);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,int x,int y,uint d,int i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, int extra);
  [DllImport("user32.dll")] public static extern bool OpenClipboard(IntPtr h);
  [DllImport("user32.dll")] public static extern bool CloseClipboard();
  [DllImport("user32.dll")] public static extern bool EmptyClipboard();
  [DllImport("user32.dll")] public static extern IntPtr SetClipboardData(uint fmt, IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetClipboardData(uint fmt);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalAlloc(uint flags, UIntPtr size);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr h);
  [DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr h);
  
  const uint SRCCOPY = 0x00CC0020;
  const uint ME_MOVE = 1, ME_LDOWN = 2, ME_LUP = 4, ME_RDOWN = 8, ME_RUP = 16, ME_WHEEL = 0x800;
  const byte VK_LSHIFT = 0xA0, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_LWIN = 0x5B;
  
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT  { public int L, T, R, B; }

  // ── Screenshot ──────────────────────────────────────────────────────────────
  public static string Screenshot(int quality, int maxW) {
    var scr = Screen.PrimaryScreen.Bounds;
    int w = scr.Width, h = scr.Height;
    float scale = (maxW > 0 && w > maxW) ? (float)maxW/w : 1f;
    int tw = (int)(w*scale), th = (int)(h*scale);
    var desk = GetDesktopWindow();
    var ddc  = GetWindowDC(desk);
    var bmp  = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    var g    = Graphics.FromImage(bmp);
    var bdc  = g.GetHdc();
    BitBlt(bdc, 0, 0, w, h, ddc, 0, 0, SRCCOPY);
    g.ReleaseHdc(bdc); g.Dispose();
    ReleaseDC(desk, ddc);
    Bitmap out_bmp = bmp;
    if (scale != 1f) { out_bmp = new Bitmap(bmp, tw, th); bmp.Dispose(); }
    var enc = GetJpegEncoder();
    var ps2  = new EncoderParameters(1);
    ps2.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
    using (var ms = new MemoryStream()) {
      out_bmp.Save(ms, enc, ps2);
      out_bmp.Dispose();
      return Convert.ToBase64String(ms.ToArray());
    }
  }

  // ── Screenshot region ────────────────────────────────────────────────────────
  public static string ScreenshotRegion(int rx, int ry, int rw, int rh, int quality) {
    var desk = GetDesktopWindow();
    var ddc  = GetWindowDC(desk);
    var bmp  = new Bitmap(rw, rh, PixelFormat.Format32bppArgb);
    var g    = Graphics.FromImage(bmp);
    var bdc  = g.GetHdc();
    BitBlt(bdc, 0, 0, rw, rh, ddc, rx, ry, SRCCOPY);
    g.ReleaseHdc(bdc); g.Dispose();
    ReleaseDC(desk, ddc);
    var enc = GetJpegEncoder();
    var ps2  = new EncoderParameters(1);
    ps2.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
    using (var ms = new MemoryStream()) {
      bmp.Save(ms, enc, ps2); bmp.Dispose();
      return Convert.ToBase64String(ms.ToArray());
    }
  }

  // ── Natural bezier mouse move ────────────────────────────────────────────────
  public static void MoveTo(int tx, int ty, int steps, int delayMs) {
    POINT cur; GetCursorPos(out cur);
    int sx = cur.X, sy = cur.Y;
    var rng = new Random();
    double mx = (sx+tx)/2.0 + rng.Next(-40,40);
    double my = (sy+ty)/2.0 + rng.Next(-25,25);
    for (int i = 1; i <= steps; i++) {
      double t = (double)i/steps;
      double ease = t < 0.5 ? 4*t*t*t : 1-Math.Pow(-2*t+2,3)/2;
      double x = Math.Pow(1-ease,2)*sx + 2*(1-ease)*ease*mx + ease*ease*tx;
      double y = Math.Pow(1-ease,2)*sy + 2*(1-ease)*ease*my + ease*ease*ty;
      SetCursorPos((int)x, (int)y);
      if (delayMs > 0) System.Threading.Thread.Sleep(delayMs);
    }
    SetCursorPos(tx, ty);
  }

  // ── Click actions ────────────────────────────────────────────────────────────
  public static void Click(int x, int y, int moveSteps) {
    MoveTo(x, y, moveSteps, 5);
    System.Threading.Thread.Sleep(40 + new Random().Next(30));
    mouse_event(ME_LDOWN, 0, 0, 0, 0);
    System.Threading.Thread.Sleep(50 + new Random().Next(40));
    mouse_event(ME_LUP, 0, 0, 0, 0);
  }

  public static void RightClick(int x, int y) {
    MoveTo(x, y, 30, 5);
    System.Threading.Thread.Sleep(40);
    mouse_event(ME_RDOWN, 0, 0, 0, 0);
    System.Threading.Thread.Sleep(55);
    mouse_event(ME_RUP, 0, 0, 0, 0);
  }

  public static void DoubleClick(int x, int y) {
    Click(x, y, 30);
    System.Threading.Thread.Sleep(80 + new Random().Next(50));
    mouse_event(ME_LDOWN, 0, 0, 0, 0);
    System.Threading.Thread.Sleep(55);
    mouse_event(ME_LUP, 0, 0, 0, 0);
  }

  public static void Scroll(int x, int y, int delta) {
    SetCursorPos(x, y);
    mouse_event(ME_WHEEL, 0, 0, (uint)(delta * 120), 0);
  }

  public static void Drag(int x1, int y1, int x2, int y2) {
    MoveTo(x1, y1, 25, 6);
    System.Threading.Thread.Sleep(60);
    mouse_event(ME_LDOWN, 0, 0, 0, 0);
    System.Threading.Thread.Sleep(60);
    MoveTo(x2, y2, 50, 8);
    System.Threading.Thread.Sleep(50);
    mouse_event(ME_LUP, 0, 0, 0, 0);
  }

  // ── Cursor info ──────────────────────────────────────────────────────────────
  public static string GetPos() {
    POINT p; GetCursorPos(out p);
    return p.X + "," + p.Y;
  }

  // ── Key combos ───────────────────────────────────────────────────────────────
  // Use SendKeys for complex combos
  public static void SendKey(string keys) {
    System.Windows.Forms.SendKeys.SendWait(keys);
    System.Threading.Thread.Sleep(30);
  }

  public static void PressVK(byte vk) {
    keybd_event(vk, 0, 0, 0);
    System.Threading.Thread.Sleep(30);
    keybd_event(vk, 0, 2, 0);
  }

  // ── Clipboard ────────────────────────────────────────────────────────────────
  public static string GetClipboard() {
    try {
      if (System.Windows.Forms.Clipboard.ContainsText())
        return System.Windows.Forms.Clipboard.GetText();
    } catch {}
    return "";
  }

  public static void SetClipboard(string text) {
    try { System.Windows.Forms.Clipboard.SetText(text); } catch {}
  }

  // ── Window management ────────────────────────────────────────────────────────
  public static string GetActiveTitle() {
    var h = GetForegroundWindow();
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    return sb.ToString();
  }

  public static string ListWindows() {
    var sb = new StringBuilder();
    var procs = System.Diagnostics.Process.GetProcesses();
    foreach (var p in procs) {
      try {
        if (p.MainWindowTitle != "" && p.MainWindowHandle != IntPtr.Zero)
          sb.AppendLine(p.Id + "|" + p.ProcessName + "|" + p.MainWindowTitle);
      } catch {}
    }
    return sb.ToString();
  }

  public static bool FocusWindow(string nameOrTitle) {
    var procs = System.Diagnostics.Process.GetProcesses();
    foreach (var p in procs) {
      try {
        if ((p.ProcessName.ToLower().Contains(nameOrTitle.ToLower()) ||
             p.MainWindowTitle.ToLower().Contains(nameOrTitle.ToLower()))
            && p.MainWindowHandle != IntPtr.Zero) {
          ShowWindow(p.MainWindowHandle, 9);
          SetForegroundWindow(p.MainWindowHandle);
          System.Threading.Thread.Sleep(300);
          return true;
        }
      } catch {}
    }
    return false;
  }

  // ── OCR via Windows.Media.Ocr ────────────────────────────────────────────────
  // (Called separately via PowerShell WinRT bridge — returns text)

  // ── Quick hash of screenshot for change detection ──────────────────────────
  public static string QuickHash(string b64, int samples) {
    if (string.IsNullOrEmpty(b64)) return "";
    int step = Math.Max(1, b64.Length / samples);
    long h = 0;
    for (int i = 0; i < b64.Length; i += step)
      h = (h * 31 + b64[i]) & 0x7FFFFFFF;
    return h.ToString("x") + b64.Length.ToString("x");
  }

  static ImageCodecInfo GetJpegEncoder() {
    foreach (var c in ImageCodecInfo.GetImageEncoders())
      if (c.FormatID == ImageFormat.Jpeg.Guid) return c;
    return null;
  }
}
'@;
`.trim();

// ─── Vision result ────────────────────────────────────────────────────────────
interface VisionData {
  inlineData: { data: string; mimeType: 'image/jpeg' };
  width?: number;
  height?: number;
}

async function takeScreenshot(quality = 75, maxW = 1280, chatId = ''): Promise<VisionData | null> {
  const { captureFrameForVision } = await import('../../computer/live-stream');
  const b64 = await captureFrameForVision(quality, maxW, chatId);
  if (!b64 || b64.startsWith('ERROR') || b64.length < 100) return null;
  return { inlineData: { data: b64, mimeType: 'image/jpeg' } };
}

async function takeRegionShot(x: number, y: number, w: number, h: number, quality = 85): Promise<VisionData | null> {
  const b64 = await ps(`${CS_PREAMBLE}\n[SA]::ScreenshotRegion(${x},${y},${w},${h},${quality})`);
  if (!b64 || b64.startsWith('ERROR') || b64.length < 100) return null;
  return { inlineData: { data: b64, mimeType: 'image/jpeg' } };
}

// ─── Human-like typing ────────────────────────────────────────────────────────
async function humanType(text: string, wordsPerMinute = 180): Promise<void> {
  const msPerChar = Math.round(60000 / (wordsPerMinute * 5));

  // Escape special SendKeys chars: +^%~(){}[]
  const escape = (c: string) => {
    if ('+(^)%~{}[]'.includes(c)) return `{${c}}`;
    return c;
  };

  const chunks: string[] = [];
  let current = '';
  for (const ch of text) {
    current += escape(ch);
    // Send in small batches to allow variable timing
    if (current.length > 8 || ch === ' ') {
      chunks.push(current);
      current = '';
    }
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    const jitter = Math.floor(Math.random() * msPerChar * 0.6);
    const delay = msPerChar + jitter;
    await ps(`${CS_PREAMBLE}\n[SA]::SendKey('${chunk.replace(/'/g, "''")}')`, 5000);
    await new Promise(r => setTimeout(r, delay));
  }
}

// ─── OCR via WinRT ────────────────────────────────────────────────────────────
async function screenOCR(region?: { x: number; y: number; w: number; h: number }): Promise<string> {
  await fs.ensureDir(TEMP_DIR);
  const tmpImg = path.join(TEMP_DIR, `ocr_${Date.now()}.png`);

  const captureScript = region
    ? `
      ${CS_PREAMBLE}
      $bmp = New-Object System.Drawing.Bitmap(${region.w}, ${region.h});
      $g = [System.Drawing.Graphics]::FromImage($bmp);
      $dc = (Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr h);' -Name T -Namespace N -PassThru)::GetWindowDC([System.IntPtr]::Zero);
      $g.CopyFromScreen(${region.x}, ${region.y}, 0, 0, (New-Object System.Drawing.Size(${region.w},${region.h})));
      $g.Dispose();
      $bmp.Save('${tmpImg.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png);
      $bmp.Dispose();`
    : `
      ${CS_PREAMBLE}
      $scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
      $bmp = New-Object System.Drawing.Bitmap($scr.Width, $scr.Height);
      $g = [System.Drawing.Graphics]::FromImage($bmp);
      $g.CopyFromScreen($scr.Location, [System.Drawing.Point]::Empty, $scr.Size);
      $g.Dispose();
      $bmp.Save('${tmpImg.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png);
      $bmp.Dispose();`;

  await ps(captureScript, 8000);

  // Windows OCR via WinRT
  const ocrText = await ps(`
    Add-Type -AssemblyName System.Runtime.WindowsRuntime;
    $null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime];
    $null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime];
    $null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime];
    function Await($t){ $task=[System.WindowsRuntimeSystemExtensions].GetMethod('AsTask',[type[]]@($t.GetType())).Invoke($null,@($t)); $task.GetAwaiter().GetResult() }
    $file = Await([Windows.Storage.StorageFile]::GetFileFromPathAsync('${tmpImg.replace(/\\/g, '\\\\')}'));
    $stream = Await($file.OpenAsync([Windows.Storage.FileAccessMode]::Read));
    $dec = Await([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream));
    $bmp = Await($dec.GetSoftwareBitmapAsync());
    $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages();
    $result = Await($eng.RecognizeAsync($bmp));
    $result.Text
  `, 18000);

  fs.remove(tmpImg).catch(() => {});
  return ocrText.startsWith('ERROR') ? '' : ocrText;
}

// ─── Wait for visual change ────────────────────────────────────────────────────
async function waitForChange(timeoutMs = 8000, pollMs = 400, chatId = ''): Promise<boolean> {
  const first = await takeScreenshot(40, 800, chatId);
  if (!first) return false;

  const firstHash = first.inlineData.data.substring(0, 200);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    const next = await takeScreenshot(40, 800, chatId);
    if (!next) continue;
    if (next.inlineData.data.substring(0, 200) !== firstHash) return true;
  }
  return false;
}

// ─── Wait for text on screen ──────────────────────────────────────────────────
async function waitForText(
  text: string,
  timeoutMs = 12000,
  pollMs = 600,
  region?: { x: number; y: number; w: number; h: number },
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const q = text.toLowerCase();

  while (Date.now() < deadline) {
    const ocrText = await screenOCR(region);
    if (ocrText.toLowerCase().includes(q)) return true;
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

// ─── Find element by text (OCR + UIAutomation hybrid) ─────────────────────────
interface FoundElement {
  x: number;
  y: number;
  w: number;
  h: number;
  centerX: number;
  centerY: number;
  text: string;
  source: 'uia' | 'ocr';
}

async function findElement(query: string, region?: { x: number; y: number; w: number; h: number }): Promise<FoundElement | null> {
  // First try Windows UI Automation (fastest, most reliable)
  const uiaResult = await ps(`
    [void][System.Reflection.Assembly]::LoadWithPartialName('UIAutomationClient');
    [void][System.Reflection.Assembly]::LoadWithPartialName('UIAutomationTypes');
    $root = [System.Windows.Automation.AutomationElement]::RootElement;
    $fw = [System.Windows.Automation.AutomationElement]::FocusedElement;
    if ($fw -eq $null) { $fw = $root }
    $all = $fw.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition);
    foreach ($el in $all) {
      try {
        $name = $el.Current.Name;
        $rect = $el.Current.BoundingRectangle;
        if ($rect.Width -gt 0 -and $name -like '*${query.replace(/'/g, "''")}*') {
          "$([int]$rect.X)|$([int]$rect.Y)|$([int]$rect.Width)|$([int]$rect.Height)|$name";
          break;
        }
      } catch {}
    }
  `, 10000);

  if (uiaResult && uiaResult.includes('|') && !uiaResult.startsWith('ERROR')) {
    const [x, y, w, h, name] = uiaResult.trim().split('|');
    const nx = parseInt(x), ny = parseInt(y), nw = parseInt(w), nh = parseInt(h);
    if (nw > 0 && nh > 0) {
      return { x: nx, y: ny, w: nw, h: nh, centerX: nx + Math.floor(nw / 2), centerY: ny + Math.floor(nh / 2), text: name, source: 'uia' };
    }
  }

  // Fallback: OCR-based search
  // Take screenshot, search for text position via OCR word bounding boxes
  const captureForOcr = region
    ? `
    $offsetX = ${region.x};
    $offsetY = ${region.y};
    $bmp = New-Object System.Drawing.Bitmap(${region.w}, ${region.h});
    $g = [System.Drawing.Graphics]::FromImage($bmp);
    $g.CopyFromScreen(${region.x}, ${region.y}, 0, 0, (New-Object System.Drawing.Size(${region.w}, ${region.h})));
    $g.Dispose();`
    : `
    $offsetX = 0;
    $offsetY = 0;
    $scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
    $bmp = New-Object System.Drawing.Bitmap($scr.Width, $scr.Height);
    $g = [System.Drawing.Graphics]::FromImage($bmp);
    $g.CopyFromScreen($scr.Location, [System.Drawing.Point]::Empty, $scr.Size);
    $g.Dispose();`;

  const ocrScript = await ps(`
    Add-Type -AssemblyName System.Runtime.WindowsRuntime;
    $null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime];
    $null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime];
    $null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime];
    function Await($t){ $task=[System.WindowsRuntimeSystemExtensions].GetMethod('AsTask',[type[]]@($t.GetType())).Invoke($null,@($t)); $task.GetAwaiter().GetResult() }

    ${CS_PREAMBLE}
    ${captureForOcr}

    $ms = New-Object System.IO.MemoryStream;
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png);
    $bmp.Dispose();
    $ms.Position = 0;

    $ref = [System.IO.MemoryStream].Assembly.GetType('System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBuffer');
    $iref = [Windows.Storage.Streams.DataWriter,Windows.Storage,ContentType=WindowsRuntime];
    $dw = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream;
    $bytes = $ms.ToArray();

    # Use BitmapDecoder from memory
    $inmem = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new();
    $writer = [Windows.Storage.Streams.DataWriter]::new($inmem);
    $writer.WriteBytes($bytes);
    Await($writer.StoreAsync()) | Out-Null;
    Await($writer.FlushAsync()) | Out-Null;
    $inmem.Seek(0);
    $dec = Await([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($inmem));
    $sft = Await($dec.GetSoftwareBitmapAsync());
    $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages();
    $ocrResult = Await($eng.RecognizeAsync($sft));

    $q = '${query.replace(/'/g, "''")}';
    foreach ($line in $ocrResult.Lines) {
      foreach ($word in $line.Words) {
        if ($word.Text -like "*$q*") {
          $b = $word.BoundingRect;
          "$([int]($b.X + $offsetX))|$([int]($b.Y + $offsetY))|$([int]$b.Width)|$([int]$b.Height)|$($word.Text)";
          break;
        }
      }
    }
  `, 20000);

  if (ocrScript && ocrScript.includes('|') && !ocrScript.startsWith('ERROR')) {
    const [x, y, w, h, name] = ocrScript.trim().split('|');
    const nx = parseInt(x), ny = parseInt(y), nw = parseInt(w), nh = parseInt(h);
    if (nw > 0 && nh > 0) {
      return { x: nx, y: ny, w: nw, h: nh, centerX: nx + Math.floor(nw / 2), centerY: ny + Math.floor(nh / 2), text: name, source: 'ocr' };
    }
  }

  return null;
}

// ─── Key map ─────────────────────────────────────────────────────────────────
const KEY_MAP: Record<string, string> = {
  'ctrl+c': '^c', 'ctrl+v': '^v', 'ctrl+x': '^x', 'ctrl+z': '^z', 'ctrl+y': '^y',
  'ctrl+a': '^a', 'ctrl+s': '^s', 'ctrl+w': '^w', 'ctrl+t': '^t', 'ctrl+r': '^r',
  'ctrl+f': '^f', 'ctrl+l': '^l', 'ctrl+n': '^n', 'ctrl+p': '^p',
  'ctrl+shift+t': '^+t', 'ctrl+shift+n': '^+n', 'ctrl+shift+p': '^+p',
  'alt+f4': '%{F4}', 'alt+tab': '%{TAB}', 'alt+enter': '%{ENTER}',
  'win': '{LWIN}', 'enter': '{ENTER}', 'esc': '{ESC}', 'escape': '{ESC}',
  'tab': '{TAB}', 'space': ' ', 'backspace': '{BACKSPACE}', 'delete': '{DELETE}',
  'up': '{UP}', 'down': '{DOWN}', 'left': '{LEFT}', 'right': '{RIGHT}',
  'home': '{HOME}', 'end': '{END}', 'pageup': '{PGUP}', 'pagedown': '{PGDN}',
  'f1': '{F1}', 'f2': '{F2}', 'f3': '{F3}', 'f4': '{F4}', 'f5': '{F5}',
  'f6': '{F6}', 'f7': '{F7}', 'f8': '{F8}', 'f9': '{F9}', 'f10': '{F10}',
  'f11': '{F11}', 'f12': '{F12}',
};

function resolveKey(key: string): string {
  return KEY_MAP[key.toLowerCase()] ?? key;
}

function activeWindowRegion(activeWindow?: ActiveWindowState | null) {
  if (!activeWindow || activeWindow.width <= 0 || activeWindow.height <= 0) return undefined;
  return {
    x: activeWindow.x,
    y: activeWindow.y,
    w: activeWindow.width,
    h: activeWindow.height,
  };
}

// ─── The Tool ────────────────────────────────────────────────────────────────

async function executeManagedScreenAction(action: string, input: any, chatId: string | undefined, quality: number) {
  const snap = async (): Promise<VisionData | null> => takeScreenshot(quality, 1280, chatId || '');

  switch (action) {
    case 'see': {
      const shot = await snap();
      return { success: !!shot, action, result: shot ? 'EterX Computer captured' : 'EterX Computer capture failed', vision: shot };
    }

    case 'see_region': {
      const shot = await snap();
      return { success: !!shot, action, result: 'Region capture is constrained to the isolated EterX Computer; full managed screen returned.', vision: shot };
    }

    case 'click':
    case 'right_click':
    case 'double_click': {
      const x = input.x ?? 0;
      const y = input.y ?? 0;
      const kind = action as 'click' | 'right_click' | 'double_click';
      const result = await clickManagedComputer(x, y, chatId, kind);
      monitorEmitter.desktopAction(`${action} (${x},${y})`, 'EterX Computer', { x, y, isolated: true }, chatId);
      return { success: result.success, action, result: result.result, vision: await snap() };
    }

    case 'hover': {
      const x = input.x ?? 0;
      const y = input.y ?? 0;
      const result = await moveManagedCursor(x, y, chatId);
      return { success: result.success, action, result: result.result, vision: await snap() };
    }

    case 'type': {
      const text = input.text ?? '';
      if (!text) return { success: false, action, result: 'No text provided', vision: null };
      const result = await typeManagedText(text, chatId);
      return { success: result.success, action, result: result.result, vision: await snap() };
    }

    case 'key': {
      const result = await sendManagedKey(input.text ?? 'enter', chatId);
      return { success: result.success, action, result: result.result, vision: await snap() };
    }

    case 'select_all':
    case 'copy':
    case 'paste':
    case 'save':
    case 'undo':
    case 'close_window': {
      const keys: Record<string, string> = {
        select_all: 'ctrl+a',
        copy: 'ctrl+c',
        paste: 'ctrl+v',
        save: 'ctrl+s',
        undo: 'ctrl+z',
        close_window: 'alt+f4',
      };
      const result = await sendManagedKey(keys[action], chatId);
      return { success: result.success, action, result: result.result, vision: await snap() };
    }

    case 'maximize':
    case 'minimize':
      return { success: false, action, result: `${action} is not available inside isolated EterX Computer yet.`, vision: await snap() };

    case 'scroll': {
      const x = input.x ?? 640;
      const y = input.y ?? 400;
      const amount = input.amount ?? 3;
      const delta = input.direction === 'up' ? amount : -amount;
      const result = await scrollManagedComputer(x, y, delta, chatId);
      return { success: result.success, action, result: result.result, vision: await snap() };
    }

    case 'drag': {
      const result = await dragManagedComputer(input.x ?? 0, input.y ?? 0, input.x2 ?? 0, input.y2 ?? 0, chatId);
      return { success: result.success, action, result: result.result, vision: await snap() };
    }

    case 'wait_change': {
      const timeout = input.timeout_ms ?? 8000;
      const changed = await waitForChange(timeout, 350, chatId || '');
      return { success: changed, action, result: changed ? 'EterX Computer changed' : `No change detected in ${timeout}ms`, vision: await snap() };
    }

    case 'wait_text':
    case 'find':
    case 'read':
      return {
        success: false,
        action,
        result: `${action} OCR/UIA is not enabled for isolated EterX Computer yet. Use the returned live screen for coordinate actions.`,
        vision: await snap(),
      };

    case 'wait_ms': {
      const ms = input.ms ?? input.timeout_ms ?? 1000;
      await new Promise(r => setTimeout(r, Math.min(ms, 30000)));
      return { success: true, action, result: `Waited ${ms}ms`, vision: await snap() };
    }

    case 'list_apps':
      return { success: true, action, result: await listManagedWindows(chatId), vision: null };

    case 'focus_app': {
      const result = await focusManagedApp(input.text ?? '', chatId);
      return { success: result.success, action, result: result.result, vision: await snap() };
    }

    case 'launch_app': {
      const result = await launchManagedApp(input.text ?? '', undefined, chatId);
      return { success: result.success, action, result: result.result, vision: await snap() };
    }

    case 'get_cursor':
      return { success: true, action, result: await getManagedCursor(chatId), vision: null };

    case 'clipboard_get':
    case 'clipboard_set':
      return { success: false, action, result: 'Clipboard access to the real host is disabled for safety in isolated EterX Computer.', vision: null };

    case 'stream_start': {
      const { startLiveStream } = await import('../../computer/live-stream');
      await startLiveStream({ fps: 8, quality: 72, maxWidth: 1280, chatId: chatId || '' });
      return { success: true, action, result: 'EterX Computer live stream started', vision: null };
    }

    case 'stream_stop': {
      const { stopLiveStream } = await import('../../computer/live-stream');
      stopLiveStream();
      return { success: true, action, result: 'EterX Computer live stream stopped', vision: null };
    }

    case 'run_command':
      return { success: false, action, result: 'screen_agent.run_command is disabled in isolated EterX Computer. Use workspace_run_command for project commands.', vision: null };

    default:
      return null;
  }
}

export const screenAgentTool = ({
  name: 'screen_agent',

  description: `🖥️ SCREEN AGENT — Full real-time human-like computer control. One tool for EVERYTHING.

The agent uses this to see, click, type, scroll, find elements, read text, wait, control any app.
After every action, a screenshot is automatically returned so you can see what happened.

ESSENTIAL WORKFLOW:
  1. Call action='see' to see current screen
  2. Decide what to do based on what you see  
  3. Click/type/scroll as needed
  4. Call action='see' again to verify result
  5. Repeat until task is complete

ACTIONS (all return a screenshot so you see the result):
  see           - Take a full screenshot now
  see_region    - Screenshot a specific area (x, y, width, height)
  click         - Click at (x, y) with natural cursor movement
  right_click   - Right-click at (x, y)
  double_click  - Double-click at (x, y)
  type          - Type text into the currently focused element
  key           - Press a key or shortcut (e.g. "enter", "ctrl+c", "esc", "tab")
  scroll        - Scroll up/down at a point
  drag          - Drag from (x1,y1) to (x2,y2)
  hover         - Move cursor to (x, y) without clicking
  find          - Find UI element by text/name → returns coordinates
  read          - OCR: read text from screen (full or region)
  wait_change   - Wait until screen changes (visual diff)
  wait_text     - Wait until specific text appears on screen
  wait_ms       - Pause for N milliseconds
  launch_app    - Open any app by name
  focus_app     - Focus a running app by name/title
  list_apps     - List all open windows
  get_cursor    - Get current cursor X,Y
  clipboard_get - Read clipboard content
  clipboard_set - Write text to clipboard
  stream_start  - Start live streaming screen to monitor panel
  stream_stop   - Stop live streaming
  select_all    - Press Ctrl+A
  copy          - Press Ctrl+C
  paste         - Press Ctrl+V
  save          - Press Ctrl+S
  undo          - Press Ctrl+Z
  close_window  - Close current window (Alt+F4)
  maximize      - Maximize current window
  minimize      - Minimize current window
  run_command   - Run a shell command and return output

SAFETY:
  - Default mode controls the isolated EterX Computer only.
  - Real host desktop control requires ETERX_ALLOW_UNSAFE_HOST_COMPUTER=1.

TIPS:
  - Always SEE first before clicking — coordinates come from what you see
  - Use find action to locate elements by text instead of guessing coordinates
  - Use wait_change after clicking buttons that trigger loading
  - use wait_text to confirm dialogs or pages have loaded
  - Clipboard is fastest for getting/setting large text in any app`,

  category: 'core',

  inputSchema: z.object({
    action: z.enum([
      'see', 'see_region', 'click', 'right_click', 'double_click',
      'type', 'key', 'scroll', 'drag', 'hover',
      'find', 'read', 'wait_change', 'wait_text', 'wait_ms',
      'launch_app', 'focus_app', 'list_apps', 'get_cursor',
      'clipboard_get', 'clipboard_set',
      'stream_start', 'stream_stop',
      'select_all', 'copy', 'paste', 'save', 'undo',
      'close_window', 'maximize', 'minimize',
      'run_command',
    ]).describe('Action to perform'),

    // Coordinates
    x: z.number().optional().describe('X coordinate on screen'),
    y: z.number().optional().describe('Y coordinate on screen'),
    x2: z.number().optional().describe('End X for drag'),
    y2: z.number().optional().describe('End Y for drag'),

    // Region
    width: z.number().optional().describe('Region width'),
    height: z.number().optional().describe('Region height'),

    // Text / query
    text: z.string().optional().describe('Text to type, key to press, app name, text to find/wait for, clipboard content, or command'),
    query: z.string().optional().describe('Element search query for find action'),

    // Scroll
    direction: z.enum(['up', 'down']).optional().describe('Scroll direction'),
    amount: z.number().optional().describe('Scroll amount (1-10)'),

    // Timing
    timeout_ms: z.number().optional().describe('Timeout for wait actions in ms (default 8000)'),
    ms: z.number().optional().describe('Milliseconds for wait_ms action'),

    // Screenshot quality
    quality: z.number().optional().describe('Screenshot JPEG quality 40-95 (default 72)'),

    // Speed
    speed: z.enum(['slow', 'normal', 'fast']).optional().describe('Action speed (affects mouse movement and typing)'),

    chatId: z.string().optional(),
  }),

  execute: async (input: any, ctx?: any) => {
    const { action } = input;
    const chatId = input.chatId || ctx?.chatId;
    const quality = input.quality ?? 72;
    const speedFactor = input.speed === 'slow' ? 1.8 : input.speed === 'fast' ? 0.5 : 1;

    // Auto-start live stream whenever screen_agent is used
    if (chatId) autoStreamPing(chatId);

    if (!isUnsafeHostControlEnabled()) {
      const managedResult = await executeManagedScreenAction(action, input, chatId, quality);
      if (managedResult) return managedResult;
      return { success: false, action, result: 'Action is not available in isolated EterX Computer.', vision: null };
    }

    const guard = await assertComputerActionAllowed(action, input, chatId);
    if (!guard.allowed) {
      return { success: false, action, result: guard.reason || 'Computer action blocked by EterX Computer boundary', vision: null };
    }

    // Helper: take post-action screenshot
    const snap = async (): Promise<VisionData | null> => takeScreenshot(quality, 1280, chatId || '');

    try {
      switch (action) {

        // ── See ────────────────────────────────────────────────────────────────
        case 'see': {
          const shot = await takeScreenshot(quality, 1280, chatId || '');
          if (!shot) return { success: false, action, result: 'Screenshot failed — check display access', vision: null };
          return { success: true, action, result: 'Current screen captured', vision: shot };
        }

        case 'see_region': {
          const rx = input.x ?? 0, ry = input.y ?? 0;
          const rw = input.width ?? 800, rh = input.height ?? 600;
          const shot = await takeRegionShot(rx, ry, rw, rh, input.quality ?? 85);
          if (!shot) return { success: false, action, result: 'Region screenshot failed', vision: null };
          return { success: true, action, result: `Region (${rx},${ry},${rw}x${rh}) captured`, vision: shot };
        }

        // ── Click ──────────────────────────────────────────────────────────────
        case 'click': {
          const x = input.x ?? 0, y = input.y ?? 0;
          const steps = Math.round(35 * speedFactor);
          monitorEmitter.desktopAction(`Click (${x},${y})`, undefined, { x, y }, chatId);
          await ps(`${CS_PREAMBLE}\n[SA]::Click(${x}, ${y}, ${steps});`, 10000);
          await new Promise(r => setTimeout(r, 200));
          const vision = await snap();
          return { success: true, action, result: `Clicked at (${x}, ${y})`, vision };
        }

        case 'right_click': {
          const x = input.x ?? 0, y = input.y ?? 0;
          monitorEmitter.desktopAction(`Right-click (${x},${y})`, undefined, { x, y }, chatId);
          await ps(`${CS_PREAMBLE}\n[SA]::RightClick(${x}, ${y});`, 8000);
          await new Promise(r => setTimeout(r, 200));
          const vision = await snap();
          return { success: true, action, result: `Right-clicked at (${x}, ${y})`, vision };
        }

        case 'double_click': {
          const x = input.x ?? 0, y = input.y ?? 0;
          monitorEmitter.desktopAction(`Double-click (${x},${y})`, undefined, { x, y }, chatId);
          await ps(`${CS_PREAMBLE}\n[SA]::DoubleClick(${x}, ${y});`, 8000);
          await new Promise(r => setTimeout(r, 250));
          const vision = await snap();
          return { success: true, action, result: `Double-clicked at (${x}, ${y})`, vision };
        }

        // ── Hover ─────────────────────────────────────────────────────────────
        case 'hover': {
          const x = input.x ?? 0, y = input.y ?? 0;
          const steps = Math.round(30 * speedFactor);
          await ps(`${CS_PREAMBLE}\n[SA]::MoveTo(${x}, ${y}, ${steps}, 5);`, 8000);
          const vision = await snap();
          return { success: true, action, result: `Cursor moved to (${x}, ${y})`, vision };
        }

        // ── Type ──────────────────────────────────────────────────────────────
        case 'type': {
          const text = input.text ?? '';
          if (!text) return { success: false, action, result: 'No text provided', vision: null };
          monitorEmitter.desktopAction(`Type: "${text.substring(0, 30)}${text.length > 30 ? '…' : ''}"`, undefined, {}, chatId);
          const wpm = input.speed === 'fast' ? 280 : input.speed === 'slow' ? 80 : 160;
          await humanType(text, wpm);
          const vision = await snap();
          return { success: true, action, result: `Typed ${text.length} characters`, vision };
        }

        // ── Key ───────────────────────────────────────────────────────────────
        case 'key': {
          const key = input.text ?? 'enter';
          const mapped = resolveKey(key);
          monitorEmitter.desktopAction(`Key: ${key}`, undefined, { key }, chatId);
          await ps(`${CS_PREAMBLE}\n[SA]::SendKey('${mapped.replace(/'/g, "''")}');`, 6000);
          await new Promise(r => setTimeout(r, 250));
          const vision = await snap();
          return { success: true, action, result: `Pressed key: ${key}`, vision };
        }

        // ── Quick shortcuts ───────────────────────────────────────────────────
        case 'select_all': { await ps(`${CS_PREAMBLE}\n[SA]::SendKey('^a');`); return { success: true, action, result: 'Selected all', vision: await snap() }; }
        case 'copy':       { await ps(`${CS_PREAMBLE}\n[SA]::SendKey('^c');`); await new Promise(r => setTimeout(r, 200)); return { success: true, action, result: 'Copied', vision: await snap() }; }
        case 'paste':      { await ps(`${CS_PREAMBLE}\n[SA]::SendKey('^v');`); await new Promise(r => setTimeout(r, 300)); return { success: true, action, result: 'Pasted', vision: await snap() }; }
        case 'save':       { await ps(`${CS_PREAMBLE}\n[SA]::SendKey('^s');`); await new Promise(r => setTimeout(r, 400)); return { success: true, action, result: 'Saved', vision: await snap() }; }
        case 'undo':       { await ps(`${CS_PREAMBLE}\n[SA]::SendKey('^z');`); await new Promise(r => setTimeout(r, 200)); return { success: true, action, result: 'Undone', vision: await snap() }; }
        case 'close_window': { await ps(`${CS_PREAMBLE}\n[SA]::SendKey('%{F4}');`); await new Promise(r => setTimeout(r, 600)); return { success: true, action, result: 'Window closed', vision: await snap() }; }
        case 'maximize':   { await ps(`Add-Type -AssemblyName System.Windows.Forms; $h = (Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();' -Name T1 -Namespace N -PassThru)::GetForegroundWindow(); (Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int n);' -Name T2 -Namespace N2 -PassThru)::ShowWindow($h, 3);`); return { success: true, action, result: 'Maximized', vision: await snap() }; }
        case 'minimize':   { await ps(`${CS_PREAMBLE}\n[SA]::SendKey('%{SPACE}n');`); return { success: true, action, result: 'Minimized', vision: null }; }

        // ── Scroll ────────────────────────────────────────────────────────────
        case 'scroll': {
          const x = input.x ?? 640, y = input.y ?? 400;
          const dir = input.direction ?? 'down';
          const amount = input.amount ?? 3;
          const delta = dir === 'up' ? amount : -amount;
          await ps(`${CS_PREAMBLE}\n[SA]::Scroll(${x}, ${y}, ${delta});`, 5000);
          monitorEmitter.desktopAction(`Scroll ${dir} at (${x},${y})`, undefined, { x, y, direction: dir }, chatId);
          const vision = await snap();
          return { success: true, action, result: `Scrolled ${dir} ${amount}x at (${x},${y})`, vision };
        }

        // ── Drag ──────────────────────────────────────────────────────────────
        case 'drag': {
          const x1 = input.x ?? 0, y1 = input.y ?? 0;
          const x2 = input.x2 ?? 0, y2 = input.y2 ?? 0;
          monitorEmitter.desktopAction(`Drag (${x1},${y1})→(${x2},${y2})`, undefined, { x1, y1, x2, y2 }, chatId);
          await ps(`${CS_PREAMBLE}\n[SA]::Drag(${x1}, ${y1}, ${x2}, ${y2});`, 15000);
          const vision = await snap();
          return { success: true, action, result: `Dragged from (${x1},${y1}) to (${x2},${y2})`, vision };
        }

        // ── Find element ──────────────────────────────────────────────────────
        case 'find': {
          const query = input.query ?? input.text ?? '';
          if (!query) return { success: false, action, result: 'No query provided', vision: null };
          const found = await findElement(query, activeWindowRegion(guard.activeWindow));
          const vision = await snap();
          if (!found) return { success: false, action, result: `Element "${query}" not found on screen`, vision };
          return {
            success: true, action,
            result: {
              text: found.text,
              center: { x: found.centerX, y: found.centerY },
              bounds: { x: found.x, y: found.y, w: found.w, h: found.h },
              source: found.source,
              tip: `Use click with x:${found.centerX} y:${found.centerY} to click this element`,
            },
            vision,
          };
        }

        // ── Read (OCR) ────────────────────────────────────────────────────────
        case 'read': {
          const hasRegion = input.x != null && input.width != null;
          const region = hasRegion ? { x: input.x!, y: input.y ?? 0, w: input.width!, h: input.height ?? 600 } : activeWindowRegion(guard.activeWindow);
          const text = await screenOCR(region);
          return {
            success: true, action,
            result: text || '(no text detected on screen)',
            vision: await snap(),
          };
        }

        // ── Wait ──────────────────────────────────────────────────────────────
        case 'wait_change': {
          const timeout = input.timeout_ms ?? 8000;
          const changed = await waitForChange(timeout, 350, chatId || '');
          const vision = await snap();
          return { success: changed, action, result: changed ? 'Screen changed' : `No change detected in ${timeout}ms`, vision };
        }

        case 'wait_text': {
          const text = input.text ?? '';
          const timeout = input.timeout_ms ?? 12000;
          if (!text) return { success: false, action, result: 'No text to wait for', vision: null };
          const found = await waitForText(text, timeout, 500, activeWindowRegion(guard.activeWindow));
          const vision = await snap();
          return { success: found, action, result: found ? `Text "${text}" appeared` : `Text "${text}" not found in ${timeout}ms`, vision };
        }

        case 'wait_ms': {
          const ms = input.ms ?? input.timeout_ms ?? 1000;
          await new Promise(r => setTimeout(r, Math.min(ms, 30000)));
          return { success: true, action, result: `Waited ${ms}ms`, vision: await snap() };
        }

        // ── Clipboard ─────────────────────────────────────────────────────────
        case 'clipboard_get': {
          const text = await ps(`${CS_PREAMBLE}\n[SA]::GetClipboard()`, 5000);
          return { success: true, action, result: text || '(clipboard empty)', vision: null };
        }

        case 'clipboard_set': {
          const text = input.text ?? '';
          await ps(`${CS_PREAMBLE}\n[SA]::SetClipboard('${text.replace(/'/g, "''")}')`, 5000);
          return { success: true, action, result: `Clipboard set (${text.length} chars)`, vision: null };
        }

        // ── App management ────────────────────────────────────────────────────
        case 'list_apps': {
          const out = await ps(`${CS_PREAMBLE}\n[SA]::ListWindows()`, 8000);
          const apps = out.split('\n').filter(l => l.includes('|')).map(line => {
            const [pid, name, title] = line.trim().split('|');
            return { pid: parseInt(pid) || 0, name, title };
          }).filter(a => a.pid > 0);
          return { success: true, action, result: apps, vision: null };
        }

        case 'focus_app': {
          const app = input.text ?? '';
          const ok = await ps(`${CS_PREAMBLE}\n[SA]::FocusWindow('${app.replace(/'/g, "''")}')`, 6000);
          await new Promise(r => setTimeout(r, 400));
          if (ok.trim() === 'True') await bindActiveWindowAsComputerTarget(chatId);
          const vision = await snap();
          monitorEmitter.appConnected(app, undefined, undefined, chatId);
          return { success: ok.trim() === 'True', action, result: ok.trim() === 'True' ? `Focused: ${app}` : `App not found: ${app}`, vision };
        }

        case 'launch_app': {
          const appName = input.text ?? '';
          await ps(`Start-Process '${appName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`, 5000);
          await new Promise(r => setTimeout(r, 1800));
          bindComputerTarget({ title: appName, processName: appName }, chatId);
          await bindActiveWindowAsComputerTarget(chatId);
          const vision = await snap();
          monitorEmitter.appConnected(appName, undefined, undefined, chatId);
          return { success: true, action, result: `Launched: ${appName}`, vision };
        }

        case 'get_cursor': {
          const pos = await ps(`${CS_PREAMBLE}\n[SA]::GetPos()`, 5000);
          const [x, y] = pos.split(',').map(Number);
          return { success: true, action, result: { x: x || 0, y: y || 0 }, vision: null };
        }

        // ── Live stream ───────────────────────────────────────────────────────
        case 'stream_start': {
          const { startLiveStream } = await import('../../computer/live-stream');
          await startLiveStream({ fps: 8, quality: 62, maxWidth: 1280, chatId: chatId || '' });
          return { success: true, action, result: 'Live stream started (8fps, q62)', vision: null };
        }

        case 'stream_stop': {
          const { stopLiveStream } = await import('../../computer/live-stream');
          stopLiveStream();
          return { success: true, action, result: 'Live stream stopped', vision: null };
        }

        // ── Shell command ─────────────────────────────────────────────────────
        case 'run_command': {
          const cmd = input.text ?? '';
          if (!cmd) return { success: false, action, result: 'No command provided', vision: null };
          monitorEmitter.terminalCmd(cmd, chatId);
          const result = await ps(cmd, 30000);
          monitorEmitter.terminalOutput(result.substring(0, 2000), cmd, chatId);
          return { success: !result.startsWith('ERROR'), action, result: result.substring(0, 4000), vision: null };
        }

        default:
          return { success: false, action, result: `Unknown action: ${action}`, vision: null };
      }
    } catch (e: any) {
      const vision = await takeScreenshot(60, 800, chatId || '').catch(() => null);
      return { success: false, action, result: `Error: ${String(e.message).substring(0, 400)}`, vision };
    }
  },
}) as unknown as ToolDefinition;
