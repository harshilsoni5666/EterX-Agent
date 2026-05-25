/**
 * ═══════════════════════════════════════════════════════════════
 * ETERX CURSOR ENGINE — Real Agent Cursor + Natural Movement
 * ═══════════════════════════════════════════════════════════════
 *
 * Makes the agent's cursor VISIBLE and HUMAN-LIKE on screen:
 *  • Transparent WinForms overlay window — sits above everything
 *  • Shows colored agent cursor (distinct from user cursor)
 *  • Ripple/pulse animation on every click
 *  • Floating action label near cursor ("Clicking...", "Typing...")
 *  • Natural bezier-curve mouse movement (no robotic straight lines)
 *  • Velocity acceleration/deceleration (ease-in-out)
 *  • Cursor position broadcast to live stream frames
 *  • Click-through: overlay never blocks user interaction
 *
 * Architecture:
 *  • C# WinForms app runs as a child process (cursor-overlay.exe)
 *  • Communicates via stdin/stdout JSON protocol
 *  • All mouse movement uses Win32 SendInput for precision
 * ═══════════════════════════════════════════════════════════════
 */

import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { monitorEmitter } from '../monitor/emitter';

const execAsync = promisify(exec);

// ─── Current cursor state (shared with live-stream for frame overlay) ─────────
export interface CursorState {
  x: number;
  y: number;
  pressing: boolean;
  label: string;
  visible: boolean;
  ts: number;
}

let _cursorState: CursorState = { x: 0, y: 0, pressing: false, label: '', visible: false, ts: 0 };
let _overlayProcess: ChildProcess | null = null;
let _overlayReady = false;

export function getCursorState(): CursorState { return { ..._cursorState }; }

// ─── PowerShell C# overlay (inline — no external exe needed) ─────────────────
const OVERLAY_CS = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
Add-Type @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.Threading;

public class AgentCursorOverlay : Form {
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint c, byte a, uint f);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr i, int x, int y, int cx, int cy, uint f);
  
  const int WS_EX_LAYERED = 0x80000;
  const int WS_EX_TRANSPARENT = 0x20;
  const int WS_EX_TOPMOST = 0x8;
  const int GWL_EXSTYLE = -20;
  const int LWA_ALPHA = 0x2;
  const uint SWP_NOMOVE = 0x2;
  const uint SWP_NOSIZE = 0x1;
  const uint SWP_NOACTIVATE = 0x10;
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

  int curX = 100, curY = 100;
  bool pressing = false;
  bool visible = true;
  string label = "";
  float rippleRadius = 0;
  bool rippling = false;
  Color cursorColor = Color.FromArgb(230, 99, 62);  // EterX orange
  
  Timer animTimer;
  Timer inputTimer;

  public AgentCursorOverlay() {
    this.FormBorderStyle = FormBorderStyle.None;
    this.ShowInTaskbar = false;
    this.BackColor = Color.Black;
    this.TransparencyKey = Color.Black;
    this.TopMost = true;
    
    var screen = Screen.PrimaryScreen.Bounds;
    this.Bounds = screen;
    this.DoubleBuffered = true;

    animTimer = new Timer();
    animTimer.Interval = 16; // 60fps
    animTimer.Tick += OnAnimTick;
    animTimer.Start();

    inputTimer = new Timer();
    inputTimer.Interval = 8; // poll stdin 125Hz
    inputTimer.Tick += OnInputTick;
    inputTimer.Start();
  }

  protected override CreateParams CreateParams {
    get {
      var cp = base.CreateParams;
      cp.ExStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST;
      return cp;
    }
  }

  void OnAnimTick(object s, EventArgs e) {
    if (rippling) {
      rippleRadius += 2.5f;
      if (rippleRadius > 40) { rippling = false; rippleRadius = 0; }
      this.Invalidate();
    }
    SetWindowPos(this.Handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }

  void OnInputTick(object s, EventArgs e) {
    // Non-blocking stdin read
    if (Console.In.Peek() == -1) return;
    var line = Console.ReadLine();
    if (string.IsNullOrEmpty(line)) return;
    try {
      // Protocol: "MOVE:x,y" | "CLICK" | "RCLICK" | "LABEL:text" | "HIDE" | "SHOW" | "EXIT"
      if (line.StartsWith("MOVE:")) {
        var parts = line.Substring(5).Split(',');
        curX = int.Parse(parts[0]);
        curY = int.Parse(parts[1]);
        _cursorState_x = curX; _cursorState_y = curY;
        this.Invoke(new Action(() => this.Invalidate()));
      } else if (line == "CLICK") {
        pressing = true; rippling = true; rippleRadius = 0;
        this.Invoke(new Action(() => this.Invalidate()));
        Thread.Sleep(120);
        pressing = false;
      } else if (line.StartsWith("LABEL:")) {
        label = line.Substring(6);
        this.Invoke(new Action(() => this.Invalidate()));
      } else if (line == "HIDE") {
        visible = false; this.Invoke(new Action(() => this.Invalidate()));
      } else if (line == "SHOW") {
        visible = true; this.Invoke(new Action(() => this.Invalidate()));
      } else if (line == "EXIT") {
        Application.Exit();
      }
    } catch {}
  }

  static int _cursorState_x = 0, _cursorState_y = 0;

  protected override void OnPaint(PaintEventArgs e) {
    if (!visible) return;
    var g = e.Graphics;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    
    // Ripple
    if (rippling && rippleRadius > 0) {
      var alpha = (int)(180 * (1 - rippleRadius / 40));
      using var rb = new SolidBrush(Color.FromArgb(alpha, cursorColor));
      g.FillEllipse(rb, curX - (int)rippleRadius, curY - (int)rippleRadius, (int)rippleRadius*2, (int)rippleRadius*2);
    }
    
    // Cursor ring (outer)
    int r = pressing ? 6 : 8;
    using var ringPen = new Pen(Color.FromArgb(200, cursorColor), 2.5f);
    g.DrawEllipse(ringPen, curX - r, curY - r, r*2, r*2);
    
    // Cursor dot (inner)
    int dr = pressing ? 4 : 3;
    using var dotBrush = new SolidBrush(Color.FromArgb(255, cursorColor));
    g.FillEllipse(dotBrush, curX - dr, curY - dr, dr*2, dr*2);
    
    // White center
    g.FillEllipse(Brushes.White, curX - 1, curY - 1, 3, 3);
    
    // Label bubble
    if (!string.IsNullOrEmpty(label)) {
      var font = new Font("Segoe UI", 9, FontStyle.Bold);
      var sz = g.MeasureString(label, font);
      int bx = curX + 14, by = curY - 10;
      var bgRect = new RectangleF(bx - 6, by - 3, sz.Width + 12, sz.Height + 6);
      using var bgBrush = new SolidBrush(Color.FromArgb(220, 20, 20, 20));
      g.FillRoundedRect(bgBrush, bgRect, 6);
      using var borderPen = new Pen(Color.FromArgb(80, cursorColor), 1);
      g.DrawRoundedRect(borderPen, bgRect, 6);
      g.DrawString(label, font, new SolidBrush(Color.FromArgb(230, cursorColor)), bx, by);
      font.Dispose();
    }
  }
}

// Extension methods for rounded rectangles
public static class GraphicsExt {
  public static GraphicsPath RoundRect(RectangleF r, float radius) {
    var p = new GraphicsPath();
    p.AddArc(r.X, r.Y, radius*2, radius*2, 180, 90);
    p.AddArc(r.Right-radius*2, r.Y, radius*2, radius*2, 270, 90);
    p.AddArc(r.Right-radius*2, r.Bottom-radius*2, radius*2, radius*2, 0, 90);
    p.AddArc(r.X, r.Bottom-radius*2, radius*2, radius*2, 90, 90);
    p.CloseFigure();
    return p;
  }
  public static void FillRoundedRect(this Graphics g, Brush b, RectangleF r, float radius) {
    using var p = RoundRect(r, radius); g.FillPath(b, p);
  }
  public static void DrawRoundedRect(this Graphics g, Pen pen, RectangleF r, float radius) {
    using var p = RoundRect(r, radius); g.DrawPath(pen, p);
  }
}
'@;

$app = New-Object AgentCursorOverlay;
$app.Opacity = 0.95;
[System.Windows.Forms.Application]::Run($app);
`.trim();

// ─── Overlay lifecycle ────────────────────────────────────────────────────────

async function ensureOverlay(): Promise<boolean> {
  if (_overlayProcess && !_overlayProcess.killed) return true;
  try {
    // Write PS script to temp file and launch
    const fs = require('fs-extra') as typeof import('fs-extra');
    const path = require('path') as typeof import('path');
    const tmpDir = path.resolve(process.cwd(), '.workspaces', 'temp');
    await fs.ensureDir(tmpDir);
    const scriptPath = path.join(tmpDir, 'cursor-overlay.ps1');
    await fs.writeFile(scriptPath, OVERLAY_CS, 'utf8');

    _overlayProcess = spawn('powershell.exe', ['-NonInteractive', '-File', scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    _overlayProcess.on('error', () => { _overlayProcess = null; _overlayReady = false; });
    _overlayProcess.on('exit', () => { _overlayProcess = null; _overlayReady = false; });

    // Give it time to start
    await new Promise(r => setTimeout(r, 1200));
    _overlayReady = true;
    return true;
  } catch {
    return false;
  }
}

function sendOverlay(cmd: string) {
  if (!_overlayProcess?.stdin || _overlayProcess.killed) return;
  try { _overlayProcess.stdin.write(cmd + '\n'); } catch { }
}

export async function showCursor(): Promise<void> {
  await ensureOverlay();
  sendOverlay('SHOW');
  _cursorState.visible = true;
}

export async function hideCursor(): Promise<void> {
  sendOverlay('HIDE');
  _cursorState.visible = false;
}

export function setCursorLabel(label: string): void {
  sendOverlay(`LABEL:${label}`);
  _cursorState.label = label;
}

export function stopOverlay(): void {
  if (_overlayProcess) {
    sendOverlay('EXIT');
    setTimeout(() => { _overlayProcess?.kill(); _overlayProcess = null; }, 500);
  }
  _overlayReady = false;
}

// ─── Natural Bezier Mouse Movement ───────────────────────────────────────────

const NATURAL_MOVE_PS = `
Add-Type @'
using System;
using System.Runtime.InteropServices;

public class NaturalMouse {
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int x, int y, uint d, int i);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  
  const uint MOUSEEVENTF_MOVE = 0x0001;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  const uint MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
  const uint MOUSEEVENTF_WHEEL = 0x0800;
  const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

  public static void MoveTo(int tx, int ty, int steps, int delayMs) {
    POINT cur;
    GetCursorPos(out cur);
    int sx = cur.X, sy = cur.Y;
    
    // Bezier control point — offset from midpoint for natural arc
    Random rng = new Random();
    double mid_x = (sx + tx) / 2.0 + rng.Next(-30, 30);
    double mid_y = (sy + ty) / 2.0 + rng.Next(-20, 20);
    
    for (int i = 1; i <= steps; i++) {
      double t = (double)i / steps;
      // Ease in-out (cubic)
      double ease = t < 0.5 ? 4*t*t*t : 1-Math.Pow(-2*t+2,3)/2;
      // Quadratic bezier
      double x = Math.Pow(1-ease,2)*sx + 2*(1-ease)*ease*mid_x + ease*ease*tx;
      double y = Math.Pow(1-ease,2)*sy + 2*(1-ease)*ease*mid_y + ease*ease*ty;
      SetCursorPos((int)x, (int)y);
      if (delayMs > 0) System.Threading.Thread.Sleep(delayMs);
    }
    SetCursorPos(tx, ty);
  }
  
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(20);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    System.Threading.Thread.Sleep(60 + new Random().Next(30));
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
  }
  
  public static void RightClick(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(20);
    mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0);
    System.Threading.Thread.Sleep(50);
    mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0);
  }
  
  public static void DoubleClick(int x, int y) {
    Click(x, y);
    System.Threading.Thread.Sleep(90 + new Random().Next(40));
    Click(x, y);
  }
  
  public static void Scroll(int x, int y, int delta) {
    SetCursorPos(x, y);
    mouse_event(MOUSEEVENTF_WHEEL, 0, 0, (uint)(delta * 120), 0);
  }
  
  public static void Drag(int x1, int y1, int x2, int y2, int steps) {
    SetCursorPos(x1, y1);
    System.Threading.Thread.Sleep(30);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    System.Threading.Thread.Sleep(40);
    MoveTo(x2, y2, steps, 8);
    System.Threading.Thread.Sleep(30);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
  }
  
  public static string GetPos() {
    POINT p;
    GetCursorPos(out p);
    return p.X + "," + p.Y;
  }
}
'@;
`.trim();

// ─── Mouse Actions ────────────────────────────────────────────────────────────

export interface MoveOptions {
  steps?: number;      // 20-80, more = smoother but slower
  speedMs?: number;    // delay between steps (1-15ms)
  label?: string;      // label to show during move
}

async function psQuick(script: string): Promise<string> {
  try {
    const { stdout } = await execAsync(script, { shell: 'powershell.exe', timeout: 8000 });
    return stdout.trim();
  } catch { return ''; }
}

export async function moveTo(x: number, y: number, opts: MoveOptions = {}): Promise<void> {
  const steps = opts.steps ?? 40;
  const delay = opts.speedMs ?? 6;
  const label = opts.label ?? 'Moving';

  // Update cursor overlay
  sendOverlay(`MOVE:${x},${y}`);
  sendOverlay(`LABEL:${label}`);
  _cursorState = { x, y, pressing: false, label, visible: true, ts: Date.now() };

  await psQuick(`${NATURAL_MOVE_PS}\n[NaturalMouse]::MoveTo(${x}, ${y}, ${steps}, ${delay});`);
  sendOverlay(`MOVE:${x},${y}`);
}

export async function clickAt(x: number, y: number, label = 'Clicking'): Promise<void> {
  await moveTo(x, y, { label: 'Moving to target', steps: 35 });
  sendOverlay('CLICK');
  sendOverlay(`LABEL:${label}`);
  _cursorState = { ...cursorState(), pressing: true, label, ts: Date.now() };
  monitorEmitter.desktopAction(`click at (${x}, ${y})`, undefined, { x, y, action: 'click' });
  await psQuick(`${NATURAL_MOVE_PS}\n[NaturalMouse]::Click(${x}, ${y});`);
  _cursorState.pressing = false;
}

export async function rightClickAt(x: number, y: number): Promise<void> {
  await moveTo(x, y, { label: 'Right clicking' });
  sendOverlay('CLICK');
  await psQuick(`${NATURAL_MOVE_PS}\n[NaturalMouse]::RightClick(${x}, ${y});`);
  monitorEmitter.desktopAction(`right-click at (${x}, ${y})`, undefined, { x, y, action: 'rightclick' });
}

export async function doubleClickAt(x: number, y: number): Promise<void> {
  await moveTo(x, y, { label: 'Double clicking' });
  sendOverlay('CLICK');
  await psQuick(`${NATURAL_MOVE_PS}\n[NaturalMouse]::DoubleClick(${x}, ${y});`);
  monitorEmitter.desktopAction(`double-click at (${x}, ${y})`, undefined, { x, y, action: 'dblclick' });
}

export async function scrollAt(x: number, y: number, direction: 'up' | 'down', amount = 3): Promise<void> {
  await moveTo(x, y, { label: `Scrolling ${direction}`, steps: 20 });
  const delta = direction === 'up' ? amount : -amount;
  await psQuick(`${NATURAL_MOVE_PS}\n[NaturalMouse]::Scroll(${x}, ${y}, ${delta});`);
  monitorEmitter.desktopAction(`scroll ${direction} at (${x}, ${y})`, undefined, { x, y, direction });
}

export async function dragFromTo(x1: number, y1: number, x2: number, y2: number): Promise<void> {
  sendOverlay(`MOVE:${x1},${y1}`);
  sendOverlay('LABEL:Dragging');
  await psQuick(`${NATURAL_MOVE_PS}\n[NaturalMouse]::Drag(${x1}, ${y1}, ${x2}, ${y2}, 50);`);
  sendOverlay(`MOVE:${x2},${y2}`);
  monitorEmitter.desktopAction(`drag (${x1},${y1}) → (${x2},${y2})`, undefined, { x1, y1, x2, y2 });
}

export async function getCursorPosition(): Promise<{ x: number; y: number }> {
  const out = await psQuick(`${NATURAL_MOVE_PS}\n[NaturalMouse]::GetPos();`);
  const [x, y] = out.split(',').map(Number);
  return { x: x || 0, y: y || 0 };
}

function cursorState() { return _cursorState; }

// ─── Export ───────────────────────────────────────────────────────────────────

export const cursorEngine = {
  show: showCursor,
  hide: hideCursor,
  setLabel: setCursorLabel,
  stop: stopOverlay,
  getState: getCursorState,
  moveTo,
  clickAt,
  rightClickAt,
  doubleClickAt,
  scrollAt,
  dragFromTo,
  getPosition: getCursorPosition,
};

export default cursorEngine;
