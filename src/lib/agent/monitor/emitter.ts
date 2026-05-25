/**
 * ═══════════════════════════════════════════════════════════════
 * ETERX REAL-TIME MONITOR — Global Event Emitter v2
 * Broadcasts every agent action to the SSE stream in real-time.
 * Fire-and-forget. Never blocks the agent loop.
 * Supports: browser, desktop, terminal, files, thoughts, live stream
 * ═══════════════════════════════════════════════════════════════
 */

import { EventEmitter } from 'events';

export type MonitorEventType =
  | 'tool_start'
  | 'tool_end'
  | 'tool_error'
  | 'thought'
  | 'message'
  | 'browser_nav'
  | 'browser_screenshot'
  | 'desktop_screenshot'      // NEW: desktop screen capture
  | 'desktop_action'          // NEW: mouse/keyboard action on desktop
  | 'app_connected'           // NEW: agent connected to an app
  | 'app_disconnected'        // NEW: agent left an app
  | 'app_state'               // NEW: app state change
  | 'user_takeover'           // NEW: user took control
  | 'agent_takeover'          // NEW: agent took back control
  | 'live_frame'              // NEW: live stream frame (compressed)
  | 'terminal_cmd'
  | 'terminal_output'
  | 'file_write'
  | 'file_read'
  | 'file_delete'
  | 'task_start'
  | 'task_done'
  | 'task_failed'
  | 'milestone'
  | 'error'
  | 'heartbeat'
  | 'context_compress'
  | 'continue_signal'
  | 'model_switch'
  | 'search_query'
  | 'search_result'
  | 'api_call'
  | 'memory_recall'
  | 'session_start'
  | 'session_end';

export interface MonitorEvent {
  id: string;
  type: MonitorEventType;
  ts: number;
  chatId?: string;
  tool?: string;
  args?: Record<string, any>;
  result?: any;
  text?: string;
  url?: string;
  screenshot?: string;      // base64 PNG
  cmd?: string;
  output?: string;
  filePath?: string;
  domain?: string;
  durationMs?: number;
  success?: boolean;
  error?: string;
  // App connector
  appName?: string;
  appPid?: number;
  appTitle?: string;
  // Live stream
  frameData?: string;       // compressed base64 JPEG frame
  frameWidth?: number;
  frameHeight?: number;
  frameQuality?: number;
  // Action tracking
  actionCount?: number;
  meta?: Record<string, any>;
}

// ─── Global action counter (persists for session) ─────────────────────────────
let _globalActionCount = 0;
let _currentAppName: string | null = null;
let _isUserInControl = false;

class AgentMonitorEmitter extends EventEmitter {
  private static instance: AgentMonitorEmitter;
  private subscribers = new Set<(event: MonitorEvent) => void>();
  private recentEvents: MonitorEvent[] = [];
  private readonly MAX_RECENT = 1000;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  private constructor() {
    super();
    this.setMaxListeners(500);
    this.startHeartbeat();
  }

  static getInstance(): AgentMonitorEmitter {
    if (!AgentMonitorEmitter.instance) {
      AgentMonitorEmitter.instance = new AgentMonitorEmitter();
    }
    return AgentMonitorEmitter.instance;
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this.emit_event({
        type: 'heartbeat',
        meta: {
          uptime: Math.round(process.uptime()),
          subscribers: this.subscribers.size,
          actionCount: _globalActionCount,
          currentApp: _currentAppName,
          userInControl: _isUserInControl,
        },
      });
    }, 10000);
    this.heartbeatTimer.unref?.();
  }

  subscribe(cb: (event: MonitorEvent) => void): () => void {
    this.subscribers.add(cb);
    // Replay last 80 events for new subscribers
    const recent = this.recentEvents.slice(-80);
    for (const ev of recent) {
      try { cb(ev); } catch { }
    }
    return () => this.subscribers.delete(cb);
  }

  getRecent(limit = 200): MonitorEvent[] {
    return this.recentEvents.slice(-limit);
  }

  getStats() {
    return {
      actionCount: _globalActionCount,
      currentApp: _currentAppName,
      userInControl: _isUserInControl,
      subscribers: this.subscribers.size,
      recentCount: this.recentEvents.length,
    };
  }

  emit_event(partial: Omit<MonitorEvent, 'id' | 'ts'>): void {
    const event: MonitorEvent = {
      id: Math.random().toString(36).slice(2, 10),
      ts: Date.now(),
      ...partial,
      result: partial.result !== undefined ? this._truncate(partial.result, 2000) : undefined,
      text: partial.text ? String(partial.text).substring(0, 4000) : undefined,
      output: partial.output ? String(partial.output).substring(0, 3000) : undefined,
      screenshot: partial.screenshot?.substring(0, 600_000),
      frameData: partial.frameData?.substring(0, 400_000),
    };

    this.recentEvents.push(event);
    if (this.recentEvents.length > this.MAX_RECENT) {
      this.recentEvents = this.recentEvents.slice(-this.MAX_RECENT);
    }

    // Use setImmediate to never block caller
    setImmediate(() => {
      for (const cb of this.subscribers) {
        try { cb(event); } catch { }
      }
    });
  }

  private _truncate(value: any, maxLen: number): any {
    if (typeof value === 'string') return value.substring(0, maxLen);
    try {
      const str = JSON.stringify(value);
      if (str.length <= maxLen) return value;
      return str.substring(0, maxLen) + '…';
    } catch {
      return String(value).substring(0, maxLen);
    }
  }

  // ── Tool tracking ──────────────────────────────────────────────

  toolStart(tool: string, args: any, chatId?: string) {
    _globalActionCount++;
    this.emit_event({ type: 'tool_start', tool, args: this._truncate(args, 800) as any, chatId, actionCount: _globalActionCount });
  }

  toolEnd(tool: string, result: any, durationMs: number, chatId?: string) {
    this.emit_event({ type: 'tool_end', tool, result, durationMs, success: true, chatId, actionCount: _globalActionCount });
  }

  toolError(tool: string, error: string, durationMs: number, chatId?: string) {
    this.emit_event({ type: 'tool_error', tool, error, durationMs, success: false, chatId, actionCount: _globalActionCount });
  }

  // ── Thinking / messages ──────────────────────────────────────

  thought(text: string, chatId?: string) {
    this.emit_event({ type: 'thought', text, chatId });
  }

  // ── Browser ──────────────────────────────────────────────────

  browserNav(url: string, chatId?: string) {
    _currentAppName = 'Browser';
    this.emit_event({ type: 'browser_nav', url, appName: 'Browser', chatId });
  }

  browserScreenshot(base64Png: string, url?: string, chatId?: string) {
    this.emit_event({ type: 'browser_screenshot', screenshot: base64Png, url, appName: 'Browser', chatId });
  }

  // ── Desktop / any app ────────────────────────────────────────

  desktopScreenshot(base64Png: string, filePath?: string, chatId?: string) {
    this.emit_event({ type: 'desktop_screenshot', screenshot: base64Png, filePath, appName: _currentAppName || 'Desktop', chatId });
  }

  desktopAction(action: string, appName?: string, details?: Record<string, any>, chatId?: string) {
    if (appName) _currentAppName = appName;
    this.emit_event({ type: 'desktop_action', text: action, appName: appName || _currentAppName || 'Desktop', meta: details, chatId, actionCount: _globalActionCount });
  }

  // ── App connection ────────────────────────────────────────────

  appConnected(appName: string, pid?: number, title?: string, chatId?: string) {
    _currentAppName = appName;
    this.emit_event({ type: 'app_connected', appName, appPid: pid, appTitle: title, chatId });
  }

  appDisconnected(appName: string, chatId?: string) {
    if (_currentAppName === appName) _currentAppName = null;
    this.emit_event({ type: 'app_disconnected', appName, chatId });
  }

  appState(appName: string, state: Record<string, any>, chatId?: string) {
    this.emit_event({ type: 'app_state', appName, meta: state, chatId });
  }

  // ── Live stream frames ────────────────────────────────────────

  liveFrame(frameData: string, width: number, height: number, quality: number = 70, chatId?: string) {
    this.emit_event({ type: 'live_frame', frameData, frameWidth: width, frameHeight: height, frameQuality: quality, chatId });
  }

  // ── User / agent control handoff ─────────────────────────────

  userTakeover(chatId?: string) {
    _isUserInControl = true;
    this.emit_event({ type: 'user_takeover', text: 'User took control', chatId });
  }

  agentTakeover(chatId?: string) {
    _isUserInControl = false;
    this.emit_event({ type: 'agent_takeover', text: 'Agent resumed control', chatId });
  }

  isUserInControl(): boolean {
    return _isUserInControl;
  }

  // ── Terminal ──────────────────────────────────────────────────

  terminalCmd(cmd: string, chatId?: string) {
    this.emit_event({ type: 'terminal_cmd', cmd, chatId });
  }

  terminalOutput(output: string, cmd?: string, chatId?: string) {
    this.emit_event({ type: 'terminal_output', output, cmd, chatId });
  }

  // ── File system ───────────────────────────────────────────────

  fileWrite(filePath: string, chatId?: string) {
    this.emit_event({ type: 'file_write', filePath, chatId });
  }

  fileRead(filePath: string, chatId?: string) {
    this.emit_event({ type: 'file_read', filePath, chatId });
  }

  // ── Search / research ─────────────────────────────────────────

  searchQuery(text: string, chatId?: string) {
    this.emit_event({ type: 'search_query', text, chatId });
  }

  searchResult(text: string, chatId?: string) {
    this.emit_event({ type: 'search_result', text, chatId });
  }

  // ── Task tracking ─────────────────────────────────────────────

  milestone(text: string, chatId?: string) {
    this.emit_event({ type: 'milestone', text, chatId });
  }

  taskStart(text: string, chatId?: string) {
    this.emit_event({ type: 'task_start', text, chatId });
  }

  taskDone(text: string, chatId?: string) {
    this.emit_event({ type: 'task_done', text, chatId });
  }

  // ── Memory / model ────────────────────────────────────────────

  memoryRecall(text: string, chatId?: string) {
    this.emit_event({ type: 'memory_recall', text, chatId });
  }

  modelSwitch(from: string, to: string, chatId?: string) {
    this.emit_event({ type: 'model_switch', text: `${from} → ${to}`, chatId });
  }

  contextCompress(ratio: number, chatId?: string) {
    this.emit_event({ type: 'context_compress', text: `Compressed ${Math.round(ratio * 100)}%`, chatId });
  }

  // ── Global state getters ──────────────────────────────────────

  getActionCount(): number { return _globalActionCount; }
  getCurrentApp(): string | null { return _currentAppName; }
  resetSession() {
    _globalActionCount = 0;
    _currentAppName = null;
    _isUserInControl = false;
  }
}

export const monitorEmitter = AgentMonitorEmitter.getInstance();
