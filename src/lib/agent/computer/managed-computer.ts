import path from 'path';
import fs from 'fs-extra';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process';
import { promisify } from 'util';
import { monitorEmitter } from '../monitor/emitter';
import { getEterxAppRoot, getEterxExecutableAssetPath, getEterxWorkspaceDir } from '../storage-paths';

const execFileAsync = promisify(execFile);

const GLOBAL_SESSION = 'global';

export interface ManagedWindow {
  pid: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ManagedSession {
  chatId: string;
  desktopName: string;
  child: ChildProcessWithoutNullStreams;
  stdoutBuffer: string;
  pendingLineResolve: ((line: string | null) => void) | null;
  pendingFrameResolve: ((frame: string | null) => void) | null;
  queue: Promise<unknown>;
  startedAt: number;
}

const sessions = new Map<string, ManagedSession>();

function sessionKey(chatId?: string | null) {
  return chatId || GLOBAL_SESSION;
}

function safeDesktopName(key: string) {
  const cleaned = key.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24) || 'global';
  return `EterXComputer_${process.pid}_${cleaned}`;
}

function encode(value: string) {
  return Buffer.from(value, 'utf8').toString('base64');
}

async function ensureBinary(): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error(`The isolated Windows computer backend is unavailable on ${process.platform}; use computer or screen_agent with the native platform provider.`);
  }
  const bundledBinary = getEterxExecutableAssetPath('native', 'win', 'EterXManagedComputer.exe');
  if (await fs.pathExists(bundledBinary)) return bundledBinary;

  const sourcePath = path.resolve(getEterxAppRoot(), 'src', 'lib', 'agent', 'computer', 'EterXManagedComputer.cs');
  const outDir = getEterxWorkspaceDir('temp', 'managed-computer');
  const exePath = path.join(outDir, 'EterXManagedComputer.exe');
  await fs.ensureDir(outDir);

  const exeExists = await fs.pathExists(exePath);
  const needsCompile = !exeExists || (await fs.stat(sourcePath)).mtimeMs > (await fs.stat(exePath)).mtimeMs;
  if (!needsCompile) return exePath;

  const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  if (!await fs.pathExists(cscPath)) {
    throw new Error(`C# compiler not found at ${cscPath}`);
  }

  await execFileAsync(cscPath, [
    '/nologo',
    '/r:System.Drawing.dll',
    `/out:${exePath}`,
    sourcePath,
  ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });

  return exePath;
}

function cleanupSession(key: string) {
  const session = sessions.get(key);
  if (!session) return;

  sessions.delete(key);
  try { session.child.stdin.write('QUIT\n'); } catch {}
  try { session.child.kill(); } catch {}

  if (session.pendingLineResolve) {
    const resolve = session.pendingLineResolve;
    session.pendingLineResolve = null;
    resolve(null);
  }
  if (session.pendingFrameResolve) {
    const resolve = session.pendingFrameResolve;
    session.pendingFrameResolve = null;
    resolve(null);
  }
}

function handleStdout(session: ManagedSession, chunk: Buffer) {
  session.stdoutBuffer += chunk.toString('utf8');

  while (true) {
    if (session.pendingFrameResolve) {
      const marker = session.stdoutBuffer.indexOf('[FRAME_END]');
      if (marker === -1) return;
      const frame = session.stdoutBuffer.substring(0, marker).trim();
      session.stdoutBuffer = session.stdoutBuffer.substring(marker + '[FRAME_END]'.length).replace(/^\r?\n/, '');
      const resolve = session.pendingFrameResolve;
      session.pendingFrameResolve = null;
      resolve(frame && !frame.startsWith('ERROR') ? frame : null);
      continue;
    }

    if (session.pendingLineResolve) {
      const newline = session.stdoutBuffer.indexOf('\n');
      if (newline === -1) return;
      const line = session.stdoutBuffer.substring(0, newline).trim();
      session.stdoutBuffer = session.stdoutBuffer.substring(newline + 1);
      const resolve = session.pendingLineResolve;
      session.pendingLineResolve = null;
      resolve(line);
      continue;
    }

    return;
  }
}

async function waitForLine(session: ManagedSession, timeoutMs = 4000): Promise<string | null> {
  if (session.pendingLineResolve || session.pendingFrameResolve) return null;

  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      session.pendingLineResolve = null;
      resolve(null);
    }, timeoutMs);

    session.pendingLineResolve = (line) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(line);
    };

    handleStdout(session, Buffer.alloc(0));
  });
}

async function sendLine(session: ManagedSession, line: string, timeoutMs = 8000): Promise<string | null> {
  return enqueue(session, async () => {
    const waiter = waitForLine(session, timeoutMs);
    session.child.stdin.write(`${line}\n`);
    return waiter;
  });
}

async function sendFrameCommand(session: ManagedSession, line: string, timeoutMs = 5000): Promise<string | null> {
  return enqueue(session, async () => {
    if (session.pendingLineResolve || session.pendingFrameResolve) return null;
    const waiter = new Promise<string | null>((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        session.pendingFrameResolve = null;
        resolve(null);
      }, timeoutMs);

      session.pendingFrameResolve = (frame) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(frame);
      };

      handleStdout(session, Buffer.alloc(0));
    });
    session.child.stdin.write(`${line}\n`);
    return waiter;
  });
}

async function enqueue<T>(session: ManagedSession, work: () => Promise<T>): Promise<T> {
  const run = session.queue.then(work, work);
  session.queue = run.catch(() => undefined);
  return run;
}

export async function ensureManagedComputer(chatId?: string | null): Promise<ManagedSession | null> {
  const key = sessionKey(chatId);
  const existing = sessions.get(key);
  if (existing && existing.child.pid && !existing.child.killed) return existing;

  cleanupSession(key);

  try {
    const exePath = await ensureBinary();
    const desktopName = safeDesktopName(key);
    const child = spawn(exePath, [desktopName], {
      stdio: 'pipe',
      windowsHide: true,
    });

    const session: ManagedSession = {
      chatId: key,
      desktopName,
      child,
      stdoutBuffer: '',
      pendingLineResolve: null,
      pendingFrameResolve: null,
      queue: Promise.resolve(),
      startedAt: Date.now(),
    };

    sessions.set(key, session);

    child.stdout.on('data', (chunk) => handleStdout(session, chunk));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) console.warn('[managed-computer]', text);
    });
    child.on('exit', () => cleanupSession(key));
    child.on('error', () => cleanupSession(key));

    const ready = await waitForLine(session, 6000);
    if (!ready?.startsWith('READY')) {
      cleanupSession(key);
      return null;
    }

    monitorEmitter.appState('EterX Computer', {
      desktopName,
      provider: 'managed_windows_desktop',
      isolated: true,
      unsafeHostControl: false,
    }, chatId || undefined);

    return session;
  } catch (error: any) {
    console.error('[managed-computer] start failed:', error?.message || error);
    cleanupSession(key);
    return null;
  }
}

export function stopManagedComputer(chatId?: string | null) {
  cleanupSession(sessionKey(chatId));
}

export async function captureManagedFrame(quality = 80, maxWidth = 1280, chatId?: string | null): Promise<string | null> {
  const session = await ensureManagedComputer(chatId);
  if (!session) return null;

  const windows = await readManagedWindows(session);
  if (windows.length === 0) return null;

  return sendFrameCommand(session, `CAP ${Math.round(quality)} ${Math.round(maxWidth)}`, 5000);
}

export async function launchManagedApp(appName: string, args?: string, chatId?: string | null) {
  const session = await ensureManagedComputer(chatId);
  if (!session) return { success: false, result: 'EterX Computer backend is not available.' };

  const command = [appName, args].filter(Boolean).join(' ').trim();
  const line = await sendLine(session, `LAUNCH_B64 ${encode(command)}`, 12000);
  const success = !!line?.startsWith('OK');
  if (success) {
    monitorEmitter.appConnected(appName, undefined, line || appName, chatId || undefined);
  }
  return { success, result: line || `Failed to launch ${appName}` };
}

export async function focusManagedApp(query: string, chatId?: string | null) {
  const session = await ensureManagedComputer(chatId);
  if (!session) return { success: false, result: 'EterX Computer backend is not available.' };
  const line = await sendLine(session, `FOCUS_B64 ${encode(query)}`, 6000);
  const success = !!line?.startsWith('OK');
  return { success, result: line || `App not found: ${query}` };
}

export async function listManagedWindows(chatId?: string | null): Promise<ManagedWindow[]> {
  const session = await ensureManagedComputer(chatId);
  if (!session) return [];
  return readManagedWindows(session);
}

async function readManagedWindows(session: ManagedSession): Promise<ManagedWindow[]> {
  const out = await sendLine(session, 'LIST', 6000);
  if (!out || out === 'EMPTY') return [];
  const payload = out.startsWith('OK_LIST ') ? out.slice('OK_LIST '.length) : out;
  return payload.split('||').map((line) => {
    const [pid, title, x, y, width, height] = line.split('|');
    return {
      pid: Number(pid) || 0,
      title: title || '',
      x: Number(x) || 0,
      y: Number(y) || 0,
      width: Number(width) || 0,
      height: Number(height) || 0,
    };
  }).filter((win) => win.title);
}

export async function clickManagedComputer(x: number, y: number, chatId?: string | null, kind: 'click' | 'right_click' | 'double_click' = 'click') {
  const session = await ensureManagedComputer(chatId);
  if (!session) return { success: false, result: 'EterX Computer backend is not available.' };
  const command = kind === 'right_click' ? 'RIGHT_CLICK' : kind === 'double_click' ? 'DOUBLE_CLICK' : 'CLICK';
  const line = await sendLine(session, `${command} ${Math.round(x)} ${Math.round(y)}`, 5000);
  return { success: !!line?.startsWith('OK'), result: line || 'Click failed' };
}

export async function moveManagedCursor(x: number, y: number, chatId?: string | null) {
  const session = await ensureManagedComputer(chatId);
  if (!session) return { success: false, result: 'EterX Computer backend is not available.' };
  const line = await sendLine(session, `MOVE ${Math.round(x)} ${Math.round(y)}`, 3000);
  return { success: !!line?.startsWith('OK'), result: line || 'Move failed' };
}

export async function dragManagedComputer(x1: number, y1: number, x2: number, y2: number, chatId?: string | null) {
  const session = await ensureManagedComputer(chatId);
  if (!session) return { success: false, result: 'EterX Computer backend is not available.' };
  const line = await sendLine(session, `DRAG ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)}`, 8000);
  return { success: !!line?.startsWith('OK'), result: line || 'Drag failed' };
}

export async function scrollManagedComputer(x: number, y: number, amount: number, chatId?: string | null) {
  const session = await ensureManagedComputer(chatId);
  if (!session) return { success: false, result: 'EterX Computer backend is not available.' };
  const line = await sendLine(session, `SCROLL ${Math.round(x)} ${Math.round(y)} ${Math.round(amount)}`, 5000);
  return { success: !!line?.startsWith('OK'), result: line || 'Scroll failed' };
}

export async function typeManagedText(text: string, chatId?: string | null) {
  const session = await ensureManagedComputer(chatId);
  if (!session) return { success: false, result: 'EterX Computer backend is not available.' };
  const line = await sendLine(session, `TYPE_B64 ${encode(text)}`, Math.max(6000, text.length * 30));
  return { success: !!line?.startsWith('OK'), result: line || 'Type failed' };
}

export async function sendManagedKey(key: string, chatId?: string | null) {
  const session = await ensureManagedComputer(chatId);
  if (!session) return { success: false, result: 'EterX Computer backend is not available.' };
  const line = await sendLine(session, `KEY_B64 ${encode(key)}`, 4000);
  return { success: !!line?.startsWith('OK'), result: line || 'Key failed' };
}

export async function getManagedCursor(chatId?: string | null) {
  const session = await ensureManagedComputer(chatId);
  if (!session) return { x: 0, y: 0 };
  const line = await sendLine(session, 'CURSOR', 3000);
  const match = line?.match(/OK\s+(-?\d+),(-?\d+)/);
  return {
    x: match ? Number(match[1]) || 0 : 0,
    y: match ? Number(match[2]) || 0 : 0,
  };
}

export function getManagedComputerStatus(chatId?: string | null) {
  const session = sessions.get(sessionKey(chatId));
  return session ? {
    active: !!session.child.pid && !session.child.killed,
    desktopName: session.desktopName,
    startedAt: session.startedAt,
  } : {
    active: false,
    desktopName: '',
    startedAt: 0,
  };
}

const globalForManagedComputer = globalThis as typeof globalThis & {
  __eterxManagedComputerCleanup?: () => void;
  __eterxManagedComputerExitListener?: boolean;
};

// A hot reload replaces this module's local session map. Close sessions owned
// by the previous instance before updating the singleton callback.
globalForManagedComputer.__eterxManagedComputerCleanup?.();
globalForManagedComputer.__eterxManagedComputerCleanup = () => {
  for (const key of Array.from(sessions.keys())) cleanupSession(key);
};

if (typeof process !== 'undefined' && !globalForManagedComputer.__eterxManagedComputerExitListener) {
  globalForManagedComputer.__eterxManagedComputerExitListener = true;
  process.on('exit', () => globalForManagedComputer.__eterxManagedComputerCleanup?.());
}
