/**
 * ═══════════════════════════════════════════════════════════════
 * ETERX LIVE STREAM ENGINE v4 — Persistent C# Screen Streaming
 * ═══════════════════════════════════════════════════════════════
 * • Warm C# persistent capture process (zero-process-spawn overhead)
 * • Hardware accelerated GDI BitBlt captures in 5-15ms
 * • Adaptive fps: 1–12fps — fast when screen changes, slow when idle
 * • Lightweight: ~15-40KB per frame at 1280px wide / 80 JPEG quality
 * • Auto-starts when the agent uses the computer-control surface
 * ═══════════════════════════════════════════════════════════════
 */

import path from 'path';
import fs from 'fs-extra';
import { spawn, execFile, ChildProcessWithoutNullStreams } from 'child_process';
import { promisify } from 'util';
import { monitorEmitter } from '../monitor/emitter';
import {
  getComputerCaptureTarget,
  isUnsafeHostControlEnabled,
} from './computer-session';
import { captureManagedFrame } from './managed-computer';
import { capturePlatformScreen } from './platform-screen';
import { getEterxAppRoot, getEterxExecutableAssetPath, getEterxWorkspaceDir } from '../storage-paths';

const execFileAsync = promisify(execFile);

// ─── Stream config ────────────────────────────────────────────────────────────
export interface StreamConfig {
  fps?: number;       // target fps cap (1–12), adaptive below this
  quality?: number;   // JPEG quality 1–95 (default 80)
  maxWidth?: number;  // resize to this width (default 1280)
  chatId?: string;
  targetTitle?: string;
  captureProvider?: 'native' | 'cua';
}

export interface LiveStreamHandle {
  stop: () => void;
  setConfig: (cfg: Partial<StreamConfig>) => void;
  getStats: () => { fps: number; framesSent: number; kbStreamed: number; activeTitle: string };
}

// ─── Global persistent process state ──────────────────────────────────────────
let _child: ChildProcessWithoutNullStreams | null = null;
let _pendingFrameResolve: ((frame: string | null) => void) | null = null;
let _pendingTitleResolve: ((title: string) => void) | null = null;
let _stdoutBuffer = '';

// Ensure compiled binary exists
async function ensureBinary(): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error(`The Windows native stream binary is unavailable on ${process.platform}; the cross-platform screenshot stream fallback should be used instead.`);
  }
  const bundledBinary = getEterxExecutableAssetPath('native', 'win', 'EterXScreenStream.exe');
  if (await fs.pathExists(bundledBinary)) return bundledBinary;

  const srcPath = path.resolve(getEterxAppRoot(), 'src', 'lib', 'agent', 'computer', 'EterXScreenStream.cs');
  const outDir = getEterxWorkspaceDir('temp', 'screen-stream');
  const exePath = path.join(outDir, 'EterXScreenStream.exe');

  await fs.ensureDir(outDir);

  const exeExists = await fs.pathExists(exePath);
  const needsCompile = !exeExists || (await fs.stat(srcPath)).mtimeMs > (await fs.stat(exePath)).mtimeMs;
  if (!needsCompile) {
    return exePath;
  }

  const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  if (!await fs.pathExists(cscPath)) {
    throw new Error(`C# compiler not found at ${cscPath}`);
  }

  try {
    await execFileAsync(cscPath, [
      '/r:System.Windows.Forms.dll,System.Drawing.dll',
      `/out:${exePath}`,
      srcPath
    ]);
    return exePath;
  } catch (e: any) {
    console.error('[live-stream] Failed to compile EterXScreenStream.cs:', e.message);
    throw e;
  }
}

// Clean up child process and resolve pending promises
function cleanupChild() {
  if (_child) {
    try {
      _child.stdin.write('QUIT\n');
    } catch {}
    try {
      _child.kill();
    } catch {}
    _child = null;
  }

  if (_pendingFrameResolve) {
    const resolve = _pendingFrameResolve;
    _pendingFrameResolve = null;
    resolve(null);
  }

  if (_pendingTitleResolve) {
    const resolve = _pendingTitleResolve;
    _pendingTitleResolve = null;
    resolve('');
  }

  _stdoutBuffer = '';
}

// Get or spawn the warm C# process
async function getChildProcess(): Promise<ChildProcessWithoutNullStreams | null> {
  if (_child && _child.pid && !_child.killed) {
    return _child;
  }

  cleanupChild();

  try {
    const exePath = await ensureBinary();

    _child = spawn(exePath, [], {
      stdio: 'pipe',
      windowsHide: true,
    });

    _stdoutBuffer = '';

    _child.stdout.on('data', (chunk) => {
      _stdoutBuffer += chunk.toString('utf8');

      while (true) {
        const titleIdx = _stdoutBuffer.indexOf('[TITLE]');
        const frameIdx = _stdoutBuffer.indexOf('[FRAME_END]');
        if (titleIdx === -1 && frameIdx === -1) break;

        if (frameIdx !== -1 && (titleIdx === -1 || frameIdx < titleIdx)) {
          const frameContent = _stdoutBuffer.substring(0, frameIdx).trim();
          _stdoutBuffer = _stdoutBuffer.substring(frameIdx + '[FRAME_END]'.length).replace(/^\r?\n/, '');

          if (_pendingFrameResolve) {
            const resolve = _pendingFrameResolve;
            _pendingFrameResolve = null;
            resolve(frameContent.startsWith('ERROR') ? null : frameContent);
          }
          continue;
        }

        const nextNewline = _stdoutBuffer.indexOf('\n', titleIdx);
        if (nextNewline === -1) break;
        const titleLine = _stdoutBuffer.substring(titleIdx + '[TITLE]'.length, nextNewline).trim();
        _stdoutBuffer = _stdoutBuffer.substring(nextNewline + 1);
        if (_pendingTitleResolve) {
          const resolve = _pendingTitleResolve;
          _pendingTitleResolve = null;
          resolve(titleLine);
        }
      }
    });

    _child.on('error', (err) => {
      console.error('[live-stream] C# process error:', err);
      cleanupChild();
    });

    _child.on('exit', () => {
      cleanupChild();
    });

    return _child;
  } catch (e: any) {
    console.error('[live-stream] Failed to start C# process:', e.message);
    return null;
  }
}

// ─── Single frame capture via warm child process ─────────────────────────────
async function captureFrame(cfg: Required<StreamConfig>): Promise<string | null> {
  if (cfg.captureProvider === 'cua') {
    const { captureCuaPreview } = await import('./cua-driver');
    return (await captureCuaPreview(cfg.chatId))?.vision?.inlineData.data || null;
  }
  if (_pendingFrameResolve) return null;

  if (process.platform !== 'win32') {
    const captured = await capturePlatformScreen('live', { target: 'fullscreen' });
    return captured?.base64 || null;
  }

  if (!isUnsafeHostControlEnabled()) {
    return captureManagedFrame(cfg.quality, cfg.maxWidth, cfg.chatId);
  }

  let targetTitle = cfg.targetTitle || getComputerCaptureTarget(cfg.chatId);

  const child = await getChildProcess();
  if (!child) return null;

  return new Promise<string | null>((resolve) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        _pendingFrameResolve = null;
        resolve(null);
      }
    }, 4000);

    _pendingFrameResolve = (frame) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(frame);
      }
    };

    try {
      if (targetTitle) {
        const encodedTarget = Buffer.from(targetTitle, 'utf8').toString('base64');
        child.stdin.write(`CAP_WINDOW_B64 ${cfg.quality} ${cfg.maxWidth} ${encodedTarget}\n`);
      } else {
        child.stdin.write(`CAP ${cfg.quality} ${cfg.maxWidth}\n`);
      }
    } catch {
      cleanupChild();
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(null);
      }
    }
  });
}

// Register one process listener set across dev-server module reloads. The
// callback pointer is refreshed so the current module instance is cleaned up.
const globalForLiveStream = globalThis as typeof globalThis & {
  __eterxLiveStreamCleanup?: () => void;
  __eterxLiveStreamExitListeners?: boolean;
};
globalForLiveStream.__eterxLiveStreamCleanup?.();
globalForLiveStream.__eterxLiveStreamCleanup = cleanupChild;

if (typeof process !== 'undefined' && !globalForLiveStream.__eterxLiveStreamExitListeners) {
  globalForLiveStream.__eterxLiveStreamExitListeners = true;
  process.on('exit', () => globalForLiveStream.__eterxLiveStreamCleanup?.());
  process.on('SIGINT', () => { globalForLiveStream.__eterxLiveStreamCleanup?.(); process.exit(); });
  process.on('SIGTERM', () => { globalForLiveStream.__eterxLiveStreamCleanup?.(); process.exit(); });
}

// ─── Global singleton stream state ───────────────────────────────────────────
let _stream: {
  active: boolean;
  timer: NodeJS.Timeout | null;
  cfg: Required<StreamConfig>;
  stats: { fps: number; framesSent: number; kbStreamed: number; activeTitle: string };
  lastHash: string;
  staleFrames: number;
  currentFps: number;
  stop: () => void;
} | null = null;

// ─── Quick visual hash (for changed-frame detection) ─────────────────────────
function quickHash(b64: string): string {
  const len = b64.length;
  const step = Math.max(1, Math.floor(len / 160));
  let h = 0;
  for (let i = 0; i < len; i += step) h = (Math.imul(31, h) + b64.charCodeAt(i)) | 0;
  return h.toString(36) + len.toString(36);
}

// ─── Start streaming ──────────────────────────────────────────────────────────
export async function startLiveStream(config: StreamConfig = {}, onStop?: () => void): Promise<LiveStreamHandle> {
  // Stop existing
  _stream?.stop();

  const cfg: Required<StreamConfig> = {
    fps:      config.captureProvider === 'cua' ? 1 : Math.min(12, Math.max(1, config.fps ?? 8)),
    quality:  Math.min(95, Math.max(40, config.quality ?? 80)),
    maxWidth: config.maxWidth ?? 1280,
    chatId:   config.chatId ?? '',
    targetTitle: config.targetTitle ?? '',
    captureProvider: config.captureProvider ?? 'native',
  };

  const state = {
    active: true,
    timer: null as NodeJS.Timeout | null,
    cfg,
    stats: { fps: cfg.fps, framesSent: 0, kbStreamed: 0, activeTitle: '' },
    lastHash: '',
    staleFrames: 0,
    currentFps: cfg.fps,
    stop: () => {},
  };
  state.stop = () => {
    if (!state.active) return;
    state.active = false;
    if (state.timer) clearTimeout(state.timer);
    if (_stream === state) _stream = null;
    onStop?.();
  };
  _stream = state;

  const tick = async () => {
    if (!state.active) return;
    const t0 = Date.now();
    state.stats.activeTitle = state.cfg.targetTitle || getComputerCaptureTarget(state.cfg.chatId);

    const frame = await captureFrame(state.cfg).catch(() => null);
    if (!frame && state.cfg.captureProvider === 'cua') {
      state.stop();
      return;
    }
    state.stats.activeTitle = state.cfg.targetTitle || getComputerCaptureTarget(state.cfg.chatId);
    if (frame && state.active) {
      const hash = quickHash(frame);
      if (hash !== state.lastHash) {
        // Screen changed — emit frame
        state.lastHash = hash;
        state.staleFrames = 0;
        state.currentFps = Math.min(cfg.fps, state.currentFps + 2);
        state.stats.framesSent++;
        state.stats.kbStreamed += Math.round(frame.length * 0.75 / 1024); // base64 → bytes → KB
        state.stats.fps = state.currentFps;
        if (cfg.captureProvider === 'cua') {
          monitorEmitter.desktopScreenshot(frame, undefined, cfg.chatId || undefined);
        } else {
          monitorEmitter.liveFrame(frame, cfg.maxWidth, Math.round(cfg.maxWidth * 0.5625), cfg.quality, cfg.chatId || undefined);
        }
      } else {
        // No change — slow down adaptively
        state.staleFrames++;
        if (state.staleFrames > 2) {
          state.currentFps = Math.max(1, state.currentFps - 1);
          state.stats.fps = state.currentFps;
        }
      }
    }

    if (!state.active) return;
    const elapsed = Date.now() - t0;
    const interval = Math.max(80, Math.round(1000 / state.currentFps) - elapsed);
    state.timer = setTimeout(tick, interval);
  };

  // Kick off immediately
  state.timer = setTimeout(tick, 0);

  return {
    stop() {
      state.stop();
      cleanupChild();
    },
    setConfig(newCfg) {
      Object.assign(state.cfg, newCfg);
      if (newCfg.fps) state.currentFps = state.cfg.captureProvider === 'cua' ? 1 : Math.min(12, newCfg.fps);
      state.staleFrames = 0;
    },
    getStats() { return { ...state.stats }; },
  };
}

// ─── Stop / status ────────────────────────────────────────────────────────────
export function stopLiveStream(chatId?: string): void {
  if (chatId && _stream?.cfg.chatId !== chatId) return;
  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }
  _stream?.stop();
  cleanupChild();
}

/** Do not let a legacy capture stream publish a different desktop's frames. */
export function stopNativeLiveStream(): void {
  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }
  if (_stream?.cfg.captureProvider === 'native') stopLiveStream();
}

export function isLiveStreaming(): boolean { return _stream?.active === true; }
export function getLiveStreamStats() { return _stream?.stats ?? null; }

// ─── AUTO-START: keeps stream active while agent is working ──────────────────
let _autoStopTimer: NodeJS.Timeout | null = null;

export function autoStreamPing(chatId: string): void {
  if (_autoStopTimer) clearTimeout(_autoStopTimer);
  _autoStopTimer = setTimeout(() => {
    stopLiveStream();
    _autoStopTimer = null;
  }, 45_000);

  if (!isLiveStreaming()) {
    startLiveStream({ fps: 8, quality: 80, maxWidth: 1280, chatId }).catch(() => {});
  } else if (_stream && chatId && _stream.cfg.chatId !== chatId) {
    stopLiveStream();
    startLiveStream({ fps: 8, quality: 80, maxWidth: 1280, chatId }).catch(() => {});
  }
}

// ─── Single frame for vision ──────────────────────────────────────────────────
export async function captureFrameForVision(quality = 82, maxWidth = 1280, chatId = ''): Promise<string | null> {
  return captureFrame({ fps: 8, quality, maxWidth, chatId, targetTitle: '', captureProvider: 'native' });
}

// ─── Active window title ──────────────────────────────────────────────────────
export async function getActiveWindowTitle(): Promise<string> {
  const child = await getChildProcess();
  if (!child) return '';

  return new Promise<string>((resolve) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        _pendingTitleResolve = null;
        resolve('');
      }
    }, 2000);

    _pendingTitleResolve = (title) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(title);
      }
    };

    try {
      child.stdin.write('TITLE\n');
    } catch {
      cleanupChild();
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve('');
      }
    }
  });
}
