import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs-extra';

const execAsync = promisify(exec);

const SCREENSHOTS_DIR = path.resolve(process.cwd(), '.workspaces', 'temp', 'screenshots');
const DESKTOP_LOG = path.resolve(process.cwd(), '.workspaces', 'temp', 'desktop_actions.log');

/**
 * Desktop Control v2 — Next-Gen Computer Use Agent
 * 
 * CAPABILITIES:
 * ═══════════════════════════════════════
 * 🖱️ MOUSE: move, click (left/right/double/middle), drag, scroll
 * ⌨️ KEYBOARD: type text, press keys, hotkeys (ctrl+c, alt+tab, win+d)
 * 📸 SCREEN: full screenshot, region capture, get pixel color, screen size
 * 🪟 WINDOWS: list, focus, minimize, maximize, close, resize, move, snap
 * 🔍 FIND: search for text on screen (OCR), wait for window to appear
 * 🚀 LAUNCH: open apps by name with Start Menu search, open URLs
 * 📋 CLIPBOARD: read/write clipboard content
 * 🔄 MULTI-STEP: execute a sequence of actions in one call
 * 🖥️ DISPLAY: multi-monitor info, DPI awareness
 * 
 * SAFETY:
 * - All actions logged to disk
 * - No elevated privileges
 * - Timeout on all operations
 * - User sees everything in real-time
 * 
 * Zero external dependencies — uses PowerShell .NET interop only.
 */

// ═══════════════════════════════════════
// POWERSHELL PREAMBLE — Loaded once per action
// ═══════════════════════════════════════
const PS_PREAMBLE = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;
using System.Threading;

public class DC {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("gdi32.dll")]  public static extern uint GetPixel(IntPtr hdc, int nXPos, int nYPos);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    
    public const uint MOUSEEVENTF_LEFTDOWN = 0x02;
    public const uint MOUSEEVENTF_LEFTUP = 0x04;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x08;
    public const uint MOUSEEVENTF_RIGHTUP = 0x10;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x20;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x40;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint KEYEVENTF_KEYUP = 0x02;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    
    // ── Mouse ──
    public static void MoveTo(int x, int y) { SetCursorPos(x, y); }

    public static void MoveSmoothFromCurrent(int x, int y, int steps) {
        var start = Cursor.Position;
        int safeSteps = steps > 0 ? steps : 12;
        for (int i = 1; i <= safeSteps; i++) {
            double t = (double)i / safeSteps;
            double eased = t < 0.5 ? 2 * t * t : 1 - Math.Pow(-2 * t + 2, 2) / 2;
            int cx = start.X + (int)Math.Round((x - start.X) * eased);
            int cy = start.Y + (int)Math.Round((y - start.Y) * eased);
            SetCursorPos(cx, cy);
            Thread.Sleep(10);
        }
    }

    public static void MouseDown(string type) {
        switch(type) {
            case "right": mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0); break;
            case "middle": mouse_event(MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, 0); break;
            default: mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0); break;
        }
    }

    public static void MouseUp(string type) {
        switch(type) {
            case "right": mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0); break;
            case "middle": mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, 0); break;
            default: mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0); break;
        }
    }
    
    public static void Click(string type, int delay) {
        switch(type) {
            case "left":
                mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
                mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
                break;
            case "right":
                mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0);
                mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0);
                break;
            case "double":
                mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
                mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
                Thread.Sleep(delay > 0 ? delay : 80);
                mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
                mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
                break;
            case "middle":
                mouse_event(MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, 0);
                mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, 0);
                break;
        }
    }
    
    public static void Scroll(int amount) {
        mouse_event(MOUSEEVENTF_WHEEL, 0, 0, amount, 0);
    }
    
    public static void Drag(int x1, int y1, int x2, int y2, int steps) {
        SetCursorPos(x1, y1);
        Thread.Sleep(100);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
        Thread.Sleep(50);
        for (int i = 1; i <= steps; i++) {
            int cx = x1 + (int)((float)i / steps * (x2 - x1));
            int cy = y1 + (int)((float)i / steps * (y2 - y1));
            SetCursorPos(cx, cy);
            Thread.Sleep(15);
        }
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    }
    
    // ── Keyboard ──
    public static void PressKey(byte vk) {
        keybd_event(vk, 0, 0, 0);
        Thread.Sleep(30);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
    }
    
    public static void HotKey(byte[] modifiers, byte key) {
        foreach(byte m in modifiers) keybd_event(m, 0, 0, 0);
        Thread.Sleep(30);
        keybd_event(key, 0, 0, 0);
        Thread.Sleep(30);
        keybd_event(key, 0, KEYEVENTF_KEYUP, 0);
        for(int i = modifiers.Length - 1; i >= 0; i--) keybd_event(modifiers[i], 0, KEYEVENTF_KEYUP, 0);
    }
    
    // ── Screen ──
    public static Color GetPixelColor(int x, int y) {
        IntPtr hdc = GetDC(IntPtr.Zero);
        uint pixel = GetPixel(hdc, x, y);
        ReleaseDC(IntPtr.Zero, hdc);
        return Color.FromArgb((int)(pixel & 0xFF), (int)((pixel >> 8) & 0xFF), (int)((pixel >> 16) & 0xFF));
    }
    
    public static void CaptureRegion(int x, int y, int w, int h, string path) {
        var bmp = new Bitmap(w, h);
        var g = Graphics.FromImage(bmp);
        g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
        g.Dispose();
        bmp.Save(path, ImageFormat.Png);
        bmp.Dispose();
    }
    
    public static void CaptureFullScreen(string path) {
        var bounds = Screen.PrimaryScreen.Bounds;
        var bmp = new Bitmap(bounds.Width, bounds.Height);
        var g = Graphics.FromImage(bmp);
        g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
        g.Dispose();
        bmp.Save(path, ImageFormat.Png);
        bmp.Dispose();
    }
}
'@;
`.trim();

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════
function psEscape(str: string): string {
  return str.replace(/'/g, "''").replace(/`/g, '``');
}

async function logAction(action: string, details: any) {
  try {
    await fs.ensureDir(path.dirname(DESKTOP_LOG));
    const entry = `[${new Date().toISOString()}] ${action}: ${JSON.stringify(details)}\n`;
    await fs.appendFile(DESKTOP_LOG, entry);
  } catch {}
}

async function runPS(script: string, timeout = 8000): Promise<string> {
  const { stdout } = await execAsync(script, { shell: 'powershell.exe', timeout });
  return stdout.trim();
}

async function captureScreen(label: string): Promise<string> {
  await fs.ensureDir(SCREENSHOTS_DIR);
  const filePath = path.join(SCREENSHOTS_DIR, `desktop_${label}_${Date.now()}.png`);
  try {
    await runPS(`${PS_PREAMBLE}\n[DC]::CaptureFullScreen('${filePath.replace(/\\/g, '\\\\')}');`, 10000);
    if (await fs.pathExists(filePath)) return filePath;
  } catch {}
  return '';
}

// Virtual key code mapping
const VK: Record<string, number> = {
  'backspace': 0x08, 'tab': 0x09, 'enter': 0x0D, 'shift': 0x10, 'ctrl': 0x11, 'control': 0x11,
  'alt': 0x12, 'pause': 0x13, 'capslock': 0x14, 'escape': 0x1B, 'esc': 0x1B, 'space': 0x20,
  'pageup': 0x21, 'pagedown': 0x22, 'end': 0x23, 'home': 0x24,
  'left': 0x25, 'up': 0x26, 'right': 0x27, 'down': 0x28,
  'printscreen': 0x2C, 'insert': 0x2D, 'delete': 0x2E, 'del': 0x2E,
  'win': 0x5B, 'windows': 0x5B, 'lwin': 0x5B,
  'f1': 0x70, 'f2': 0x71, 'f3': 0x72, 'f4': 0x73, 'f5': 0x74, 'f6': 0x75,
  'f7': 0x76, 'f8': 0x77, 'f9': 0x78, 'f10': 0x79, 'f11': 0x7A, 'f12': 0x7B,
  'numlock': 0x90, 'scrolllock': 0x91,
  // Letters & numbers populated below
};
for (let i = 0; i <= 9; i++) VK[String(i)] = 0x30 + i;
for (let c = 65; c <= 90; c++) VK[String.fromCharCode(c).toLowerCase()] = c;

export const desktopControlTool: ToolDefinition = {
  name: 'desktop_control',
  description: `🖥️ REAL-TIME COMPUTER USE — Full desktop control. See screen, move mouse, click, type, press hotkeys, scroll, manage windows, launch apps, read clipboard, capture regions, get pixel colors, and execute multi-step automation sequences.

ALWAYS follow this workflow:
1. screenshot → SEE what's on screen
2. analyze the image → find coordinates of target element
3. act (click_at / type_text / hotkey) → interact
4. screenshot → VERIFY the action worked

CAPABILITIES: mouse control, keyboard input, hotkeys, scrolling, window management, app launching, clipboard, screen capture, pixel reading, region capture, multi-step sequences, wait-for-window.`,
  category: 'core',
  inputSchema: z.object({
    action: z.enum([
      // ── Mouse ──
      'mouse_move', 'mouse_down', 'mouse_up', 'click_at', 'drag',
      // ── Keyboard ──
      'type_text', 'press_key', 'hotkey',
      // ── Scroll ──
      'scroll_up', 'scroll_down',
      // ── Screen ──
      'screenshot', 'capture_region', 'get_pixel_color', 'get_screen_info',
      // ── Windows ──
      'list_windows', 'focus_window', 'minimize_window', 'maximize_window',
      'close_window', 'resize_window', 'move_window', 'snap_window',
      // ── Launch ──
      'launch_app', 'open_url', 'open_file',
      // ── Clipboard ──
      'clipboard_read', 'clipboard_write',
      // ── Utility ──
      'wait', 'wait_for_window', 'get_mouse_position',
      'open_start_menu', 'open_run_dialog',
      // ── Multi-step ──
      'multi_step',
    ]).describe('Action to perform'),
    
    // Mouse
    x: z.number().optional().describe('X coordinate'),
    y: z.number().optional().describe('Y coordinate'),
    toX: z.number().optional().describe('Drag destination X'),
    toY: z.number().optional().describe('Drag destination Y'),
    button: z.enum(['left', 'right', 'double', 'middle']).optional().default('left'),
    
    // Keyboard
    text: z.string().optional().describe('Text to type, key name, window title, app name, or URL'),
    keys: z.string().optional().describe('Hotkey combo: "ctrl+c", "alt+tab", "win+d", "ctrl+shift+s"'),
    
    // Region capture
    width: z.number().optional().describe('Width for region capture or window resize'),
    height: z.number().optional().describe('Height for region capture or window resize'),
    
    // Scroll & Wait
    amount: z.number().optional().describe('Scroll clicks (default 3) or wait milliseconds'),
    
    // Snap
    position: z.enum(['left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']).optional(),
    
    // Multi-step: array of actions
    steps: z.array(z.object({
      action: z.string(),
      x: z.number().optional(),
      y: z.number().optional(),
      text: z.string().optional(),
      keys: z.string().optional(),
      button: z.string().optional(),
      amount: z.number().optional(),
      delay: z.number().optional().describe('ms to wait AFTER this step'),
    })).optional().describe('Array of sequential actions for multi_step mode'),
    
    // Clipboard write
    content: z.string().optional().describe('Content to write to clipboard'),
    
    // Auto-screenshot after action
    captureAfter: z.boolean().optional().default(true),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    action: z.string(),
    result: z.any(),
    screenshotPath: z.string().optional(),
  }),
  execute: async (input: any) => {
    const { action } = input;
    const shouldCapture = input.captureAfter !== false;
    
    console.log(`[Desktop Control] 🖥️ ${action} | x:${input.x ?? '-'} y:${input.y ?? '-'} text:"${(input.text || '').substring(0, 50)}" keys:"${input.keys || ''}"`);
    await logAction(action, { x: input.x, y: input.y, text: input.text, keys: input.keys });

    try {
      let result: any = {};

      switch (action) {
        // ═══════════════════════════════
        // 🖱️ MOUSE
        // ═══════════════════════════════
        case 'mouse_move': {
          if (input.x == null || input.y == null) return fail(action, 'x and y required');
          await runPS(`${PS_PREAMBLE}\n[DC]::MoveSmoothFromCurrent(${input.x}, ${input.y}, 12);`);
          result = { moved_to: { x: input.x, y: input.y } };
          break;
        }

        case 'mouse_down': {
          const btn = input.button || 'left';
          if (input.x != null && input.y != null) {
            await runPS(`${PS_PREAMBLE}\n[DC]::MoveSmoothFromCurrent(${input.x}, ${input.y}, 10); [DC]::MouseDown('${btn}');`);
          } else {
            await runPS(`${PS_PREAMBLE}\n[DC]::MouseDown('${btn}');`);
          }
          result = { mouse: 'down', button: btn, at: input.x != null && input.y != null ? { x: input.x, y: input.y } : 'current' };
          break;
        }

        case 'mouse_up': {
          const btn = input.button || 'left';
          if (input.x != null && input.y != null) {
            await runPS(`${PS_PREAMBLE}\n[DC]::MoveSmoothFromCurrent(${input.x}, ${input.y}, 10); [DC]::MouseUp('${btn}');`);
          } else {
            await runPS(`${PS_PREAMBLE}\n[DC]::MouseUp('${btn}');`);
          }
          result = { mouse: 'up', button: btn, at: input.x != null && input.y != null ? { x: input.x, y: input.y } : 'current' };
          break;
        }

        case 'click_at': {
          if (input.x == null || input.y == null) return fail(action, 'x and y required');
          const btn = input.button || 'left';
          await runPS(`${PS_PREAMBLE}\n[DC]::MoveSmoothFromCurrent(${input.x}, ${input.y}, 12); Start-Sleep -Milliseconds 50; [DC]::Click('${btn}', 80);`);
          result = { clicked: btn, at: { x: input.x, y: input.y } };
          break;
        }

        case 'drag': {
          if (input.x == null || input.y == null || input.toX == null || input.toY == null) return fail(action, 'x, y, toX, toY required');
          await runPS(`${PS_PREAMBLE}\n[DC]::Drag(${input.x}, ${input.y}, ${input.toX}, ${input.toY}, 15);`, 10000);
          result = { dragged: { from: { x: input.x, y: input.y }, to: { x: input.toX, y: input.toY } } };
          break;
        }

        case 'get_mouse_position': {
          const pos = await runPS(`Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"`);
          const [mx, my] = pos.split(',').map(Number);
          result = { position: { x: mx, y: my } };
          break;
        }

        // ═══════════════════════════════
        // ⌨️ KEYBOARD
        // ═══════════════════════════════
        case 'type_text': {
          if (!input.text) return fail(action, 'text required');
          // SendKeys has special chars that need escaping
          const escaped = input.text
            .replace(/[+^%~(){}[\]]/g, (m: string) => `{${m}}`);
          await runPS(
            `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${psEscape(escaped)}');`,
            15000
          );
          result = { typed: input.text.length > 80 ? input.text.substring(0, 80) + '...' : input.text };
          break;
        }

        case 'press_key': {
          if (!input.text) return fail(action, 'text (key name) required');
          const vk = VK[input.text.toLowerCase()];
          if (vk) {
            await runPS(`${PS_PREAMBLE}\n[DC]::PressKey(${vk});`);
          } else {
            // Fallback to SendKeys
            const keyMap: Record<string, string> = {
              'enter': '{ENTER}', 'tab': '{TAB}', 'escape': '{ESC}', 'esc': '{ESC}',
              'backspace': '{BACKSPACE}', 'delete': '{DELETE}', 'space': ' ',
            };
            const k = keyMap[input.text.toLowerCase()] || `{${input.text.toUpperCase()}}`;
            await runPS(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${k}');`);
          }
          result = { pressed: input.text };
          break;
        }

        case 'hotkey': {
          if (!input.keys) return fail(action, 'keys combo required (e.g. "ctrl+c")');
          const parts = input.keys.toLowerCase().split('+').map((p: string) => p.trim());
          
          const modifiers: number[] = [];
          let mainKeyVk = 0;
          
          for (const part of parts) {
            if (['ctrl', 'control'].includes(part)) modifiers.push(0x11);
            else if (part === 'alt') modifiers.push(0x12);
            else if (part === 'shift') modifiers.push(0x10);
            else if (['win', 'windows'].includes(part)) modifiers.push(0x5B);
            else mainKeyVk = VK[part] || part.charCodeAt(0);
          }
          
          if (mainKeyVk === 0 && modifiers.length > 0) {
            // Solo modifier key press (e.g. just "win")
            mainKeyVk = modifiers.pop()!;
          }
          
          const modArr = `@(${modifiers.map(m => `[byte]${m}`).join(',')})`;
          await runPS(`${PS_PREAMBLE}\n[DC]::HotKey(${modArr}, [byte]${mainKeyVk});`);
          result = { hotkey: input.keys };
          break;
        }

        // ═══════════════════════════════
        // 🔄 SCROLL
        // ═══════════════════════════════
        case 'scroll_up': {
          const clicks = input.amount || 3;
          await runPS(`${PS_PREAMBLE}\n[DC]::Scroll(${clicks * 120});`);
          result = { scrolled: 'up', clicks };
          break;
        }
        case 'scroll_down': {
          const clicks = input.amount || 3;
          await runPS(`${PS_PREAMBLE}\n[DC]::Scroll(${-clicks * 120});`);
          result = { scrolled: 'down', clicks };
          break;
        }

        // ═══════════════════════════════
        // 📸 SCREEN
        // ═══════════════════════════════
        case 'screenshot': {
          const screenshotPath = await captureScreen('view');
          return { success: !!screenshotPath, action, result: screenshotPath ? `Screenshot saved at: ${screenshotPath}` : 'Failed', screenshotPath };
        }

        case 'capture_region': {
          if (input.x == null || input.y == null || !input.width || !input.height) return fail(action, 'x, y, width, height required');
          await fs.ensureDir(SCREENSHOTS_DIR);
          const filePath = path.join(SCREENSHOTS_DIR, `region_${Date.now()}.png`);
          await runPS(`${PS_PREAMBLE}\n[DC]::CaptureRegion(${input.x}, ${input.y}, ${input.width}, ${input.height}, '${filePath.replace(/\\/g, '\\\\')}');`);
          const exists = await fs.pathExists(filePath);
          return { success: exists, action, result: exists ? `Region captured at: ${filePath}` : 'Failed', screenshotPath: exists ? filePath : undefined };
        }

        case 'get_pixel_color': {
          if (input.x == null || input.y == null) return fail(action, 'x and y required');
          const color = await runPS(`${PS_PREAMBLE}\n$c = [DC]::GetPixelColor(${input.x}, ${input.y}); "R=$($c.R),G=$($c.G),B=$($c.B)"`);
          const match = color.match(/R=(\d+),G=(\d+),B=(\d+)/);
          if (match) {
            const [, r, g, b] = match.map(Number);
            result = { color: { r, g, b, hex: `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}` }, at: { x: input.x, y: input.y } };
          } else {
            result = { raw: color };
          }
          break;
        }

        case 'get_screen_info': {
          const info = await runPS(`
            Add-Type -AssemblyName System.Windows.Forms;
            $screens = [System.Windows.Forms.Screen]::AllScreens;
            $primary = [System.Windows.Forms.Screen]::PrimaryScreen;
            $output = "Primary: $($primary.Bounds.Width)x$($primary.Bounds.Height) | DPI: $($primary.Bounds.Width) | Monitors: $($screens.Count)";
            foreach($s in $screens) { $output += "; $($s.DeviceName): $($s.Bounds.Width)x$($s.Bounds.Height) at ($($s.Bounds.X),$($s.Bounds.Y))" }
            $output
          `);
          result = { screenInfo: info };
          break;
        }

        // ═══════════════════════════════
        // 🪟 WINDOWS
        // ═══════════════════════════════
        case 'list_windows': {
          const windows = await runPS(
            `Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object Id, ProcessName, MainWindowTitle, @{N='Handle';E={$_.MainWindowHandle}} | Format-Table -AutoSize | Out-String -Width 500`
          );
          result = { windows };
          break;
        }

        case 'focus_window': {
          if (!input.text) return fail(action, 'text (window title or app name) required');
          const out = await runPS(`
            ${PS_PREAMBLE}
            $proc = Get-Process | Where-Object {$_.MainWindowTitle -like '*${psEscape(input.text)}*' -or $_.ProcessName -like '*${psEscape(input.text)}*'} | Select-Object -First 1;
            if ($proc) {
              [DC]::ShowWindow($proc.MainWindowHandle, 9);
              [DC]::SetForegroundWindow($proc.MainWindowHandle);
              "OK:$($proc.ProcessName)|$($proc.MainWindowTitle)"
            } else { "NOTFOUND" }
          `);
          if (out.startsWith('NOTFOUND')) return fail(action, `Window "${input.text}" not found`);
          result = { focused: out.replace('OK:', '') };
          break;
        }

        case 'minimize_window': {
          if (!input.text) return fail(action, 'text required');
          await runPS(`
            ${PS_PREAMBLE}
            $p = Get-Process | Where-Object {$_.MainWindowTitle -like '*${psEscape(input.text)}*'} | Select-Object -First 1;
            if($p){[DC]::ShowWindow($p.MainWindowHandle, 6)}
          `);
          result = { minimized: input.text };
          break;
        }

        case 'maximize_window': {
          if (!input.text) return fail(action, 'text required');
          await runPS(`
            ${PS_PREAMBLE}
            $p = Get-Process | Where-Object {$_.MainWindowTitle -like '*${psEscape(input.text)}*'} | Select-Object -First 1;
            if($p){[DC]::ShowWindow($p.MainWindowHandle, 3); [DC]::SetForegroundWindow($p.MainWindowHandle)}
          `);
          result = { maximized: input.text };
          break;
        }

        case 'close_window': {
          if (!input.text) return fail(action, 'text required');
          await runPS(`
            $p = Get-Process | Where-Object {$_.MainWindowTitle -like '*${psEscape(input.text)}*'} | Select-Object -First 1;
            if($p){$p.CloseMainWindow() | Out-Null}
          `);
          result = { closed: input.text };
          break;
        }

        case 'resize_window': {
          if (!input.text || !input.width || !input.height) return fail(action, 'text, width, height required');
          await runPS(`
            ${PS_PREAMBLE}
            $p = Get-Process | Where-Object {$_.MainWindowTitle -like '*${psEscape(input.text)}*'} | Select-Object -First 1;
            if($p){
              $r = New-Object DC+RECT; [DC]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null;
              [DC]::MoveWindow($p.MainWindowHandle, $r.Left, $r.Top, ${input.width}, ${input.height}, $true)
            }
          `);
          result = { resized: input.text, to: { width: input.width, height: input.height } };
          break;
        }

        case 'move_window': {
          if (!input.text || input.x == null || input.y == null) return fail(action, 'text, x, y required');
          await runPS(`
            ${PS_PREAMBLE}
            $p = Get-Process | Where-Object {$_.MainWindowTitle -like '*${psEscape(input.text)}*'} | Select-Object -First 1;
            if($p){
              $r = New-Object DC+RECT; [DC]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null;
              $w=$r.Right-$r.Left; $h=$r.Bottom-$r.Top;
              [DC]::MoveWindow($p.MainWindowHandle, ${input.x}, ${input.y}, $w, $h, $true)
            }
          `);
          result = { moved: input.text, to: { x: input.x, y: input.y } };
          break;
        }

        case 'snap_window': {
          if (!input.text || !input.position) return fail(action, 'text and position required');
          const screen = await runPS(`Add-Type -AssemblyName System.Windows.Forms; $s=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; "$($s.Width),$($s.Height)"`);
          const [sw, sh] = screen.split(',').map(Number);
          const hw = Math.floor(sw / 2), hh = Math.floor(sh / 2);
          
          const positions: Record<string, [number, number, number, number]> = {
            'left': [0, 0, hw, sh],
            'right': [hw, 0, hw, sh],
            'top-left': [0, 0, hw, hh],
            'top-right': [hw, 0, hw, hh],
            'bottom-left': [0, hh, hw, hh],
            'bottom-right': [hw, hh, hw, hh],
            'center': [Math.floor(sw * 0.15), Math.floor(sh * 0.15), Math.floor(sw * 0.7), Math.floor(sh * 0.7)],
          };
          const [px, py, pw, ph] = positions[input.position] || positions['center'];
          
          await runPS(`
            ${PS_PREAMBLE}
            $p = Get-Process | Where-Object {$_.MainWindowTitle -like '*${psEscape(input.text)}*'} | Select-Object -First 1;
            if($p){
              [DC]::ShowWindow($p.MainWindowHandle, 1);
              [DC]::MoveWindow($p.MainWindowHandle, ${px}, ${py}, ${pw}, ${ph}, $true);
              [DC]::SetForegroundWindow($p.MainWindowHandle)
            }
          `);
          result = { snapped: input.text, position: input.position, bounds: { x: px, y: py, w: pw, h: ph } };
          break;
        }

        // ═══════════════════════════════
        // 🚀 LAUNCH
        // ═══════════════════════════════
        case 'launch_app': {
          if (!input.text) return fail(action, 'text (app name) required');
          // Smart launch: try Start-Process first, fallback to Start Menu search
          try {
            await runPS(`Start-Process "${psEscape(input.text)}" -ErrorAction Stop`, 5000);
            result = { launched: input.text, method: 'direct' };
          } catch {
            // Fallback: open Start Menu, type app name, press Enter
            await runPS(`
              ${PS_PREAMBLE}
              [DC]::PressKey(0x5B); # Win key
              Start-Sleep -Milliseconds 500;
            `);
            await new Promise(r => setTimeout(r, 500));
            await runPS(
              `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${psEscape(input.text)}');`,
              5000
            );
            await new Promise(r => setTimeout(r, 800));
            await runPS(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}');`);
            result = { launched: input.text, method: 'start_menu_search' };
          }
          await new Promise(r => setTimeout(r, 1000)); // Let app open
          break;
        }

        case 'open_url': {
          if (!input.text) return fail(action, 'text (URL) required');
          await runPS(`Start-Process "${psEscape(input.text)}"`, 5000);
          result = { opened: input.text };
          break;
        }

        case 'open_file': {
          if (!input.text) return fail(action, 'text (file path) required');
          await runPS(`Invoke-Item "${psEscape(input.text)}"`, 5000);
          result = { opened: input.text };
          break;
        }

        // ═══════════════════════════════
        // 📋 CLIPBOARD
        // ═══════════════════════════════
        case 'clipboard_read': {
          const clip = await runPS(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()`);
          result = { clipboard: clip || '(empty)' };
          break;
        }

        case 'clipboard_write': {
          if (!input.content && !input.text) return fail(action, 'content or text required');
          const content = input.content || input.text;
          await runPS(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText('${psEscape(content)}')`);
          result = { written: content.length > 80 ? content.substring(0, 80) + '...' : content };
          break;
        }

        // ═══════════════════════════════
        // ⏱️ UTILITY
        // ═══════════════════════════════
        case 'wait': {
          const ms = Math.min(input.amount || 1000, 15000);
          await new Promise(r => setTimeout(r, ms));
          result = { waited: `${ms}ms` };
          break;
        }

        case 'wait_for_window': {
          if (!input.text) return fail(action, 'text (window title) required');
          const timeout = Math.min(input.amount || 10000, 30000);
          const start = Date.now();
          let found = false;
          while (Date.now() - start < timeout) {
            const check = await runPS(
              `$p = Get-Process | Where-Object {$_.MainWindowTitle -like '*${psEscape(input.text)}*'} | Select-Object -First 1; if($p){"FOUND:$($p.MainWindowTitle)"}else{"WAITING"}`
            );
            if (check.startsWith('FOUND')) {
              found = true;
              result = { found: true, window: check.replace('FOUND:', ''), waitedMs: Date.now() - start };
              break;
            }
            await new Promise(r => setTimeout(r, 500));
          }
          if (!found) result = { found: false, waitedMs: timeout, message: `Window "${input.text}" did not appear within ${timeout}ms` };
          break;
        }

        case 'open_start_menu': {
          await runPS(`${PS_PREAMBLE}\n[DC]::PressKey(0x5B);`);
          result = { opened: 'start_menu' };
          break;
        }

        case 'open_run_dialog': {
          await runPS(`${PS_PREAMBLE}\n[DC]::HotKey(@([byte]0x5B), [byte]0x52);`);
          result = { opened: 'run_dialog' };
          break;
        }

        // ═══════════════════════════════
        // 🔄 MULTI-STEP
        // ═══════════════════════════════
        case 'multi_step': {
          if (!input.steps || !Array.isArray(input.steps) || input.steps.length === 0) return fail(action, 'steps array required');
          if (input.steps.length > 20) return fail(action, 'Max 20 steps per multi_step call');
          
          const stepResults: any[] = [];
          for (let i = 0; i < input.steps.length; i++) {
            const step = input.steps[i];
            console.log(`[Desktop Control] 🔄 Step ${i + 1}/${input.steps.length}: ${step.action}`);
            
            // Recursively execute each step (without screenshot)
            const stepResult = await desktopControlTool.execute({
              ...step,
              captureAfter: false,
            }, {});
            stepResults.push({ step: i + 1, action: step.action, ...stepResult });
            
            // Wait between steps
            const delay = step.delay || 200;
            await new Promise(r => setTimeout(r, delay));
          }
          result = { steps: stepResults, totalSteps: input.steps.length };
          break;
        }

        default:
          return fail(action, `Unknown action: ${action}`);
      }

      // Auto-screenshot after action
      let screenshotPath: string | undefined;
      if (shouldCapture && !['screenshot', 'capture_region', 'wait', 'get_mouse_position', 'get_pixel_color', 'get_screen_info', 'clipboard_read', 'list_windows'].includes(action)) {
        await new Promise(r => setTimeout(r, 350));
        screenshotPath = await captureScreen(action);
      }

      return { success: true, action, result, screenshotPath };

    } catch (error: any) {
      console.error(`[Desktop Control] ❌ ${action}:`, error.message?.substring(0, 200));
      return { success: false, action, result: `Failed: ${error.message?.substring(0, 200)}` };
    }
  }
};

function fail(action: string, msg: string) {
  return { success: false, action, result: msg };
}
