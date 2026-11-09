import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nextCli = path.join(repositoryRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const electronCli = path.join(repositoryRoot, 'node_modules', 'electron', 'cli.js');
const desktopDevRoot = path.join(repositoryRoot, '.workspaces', 'desktop-dev');
const desktopDevUserData = path.resolve(
  String(process.env.ETERX_DESKTOP_DEV_USER_DATA || path.join(desktopDevRoot, 'user-data')),
);
const launcherLockPath = path.join(desktopDevRoot, 'launcher.lock');
const electronSourceRoot = path.join(repositoryRoot, 'electron');
const gatewaySourceRoot = path.join(repositoryRoot, 'src', 'lib', 'agent', 'gateways');
const electronSourceExtensions = new Set(['.js', '.cjs', '.mjs', '.json', '.html']);

let nextProcess = null;
let electronProcess = null;
let electronRestartTimer = null;
let electronSourceFingerprint = null;
let electronRestartInProgress = false;
let electronRestartQueued = false;
let shuttingDown = false;
let shutdownPromise = null;
let launcherLockOwned = false;
let devEnvironment = null;
const childProcesses = new Set();
const expectedElectronExits = new WeakSet();
const sourceWatchers = [];

function logLifecycle(message) {
  console.log(`[EterX] ${message}`);
  try {
    fs.appendFileSync(path.join(desktopDevRoot, 'launcher.log'), `[${new Date().toISOString()}] ${message}\n`);
  } catch { }
}

function readElectronSourceFingerprint() {
  const hash = createHash('sha256');
  const files = fs.readdirSync(electronSourceRoot)
    .filter((name) => electronSourceExtensions.has(path.extname(name).toLowerCase()))
    .map((name) => path.join(electronSourceRoot, name));
  if (fs.existsSync(gatewaySourceRoot)) {
    files.push(...fs.readdirSync(gatewaySourceRoot)
      .filter((name) => path.extname(name).toLowerCase() === '.cjs')
      .map((name) => path.join(gatewaySourceRoot, name)));
  }
  for (const file of files.sort()) {
    hash.update(file);
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + 40; port += 1) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No free local development port found from ${startPort} to ${startPort + 39}.`);
}

async function waitForHttpTarget(target) {
  const deadline = Date.now() + 300_000;
  while (!shuttingDown && Date.now() < deadline) {
    if (childHasExited(nextProcess)) {
      throw new Error('Next.js exited before the local page became available.');
    }
    try {
      const response = await fetch(target, {
        headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(5000),
      });
      // Fetch resolves after headers, not after Next has finished streaming
      // the page. Consume the complete body before Electron opens its own
      // request, otherwise the first renderer navigation can remain stuck on
      // the splash while the pre-warm request is still active.
      const body = await response.arrayBuffer();
      if (response.ok && body.byteLength > 0) return;
    } catch {
      // Next.js can accept the socket before the first page compilation is
      // complete. Keep polling until the local page itself is available.
    }
    await delay(500);
  }
  throw new Error(shuttingDown ? 'Desktop startup cancelled.' : 'The local workspace did not become ready within five minutes.');
}

function waitForPort(port, timeoutMs = 30000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Next.js did not start on port ${port} within ${Math.round(timeoutMs / 1000)}s.`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function isEterxLauncherProcess(pid) {
  if (!isProcessRunning(pid)) return false;
  if (process.platform !== 'win32') return true;

  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CommandLine) -join ''`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (result.error || result.status !== 0) return false;

  const commandLine = result.stdout.trim();
  return commandLine.includes(repositoryRoot)
    && /(?:^|[\\/])scripts[\\/]run-desktop-dev\.mjs(?:\s|$)/i.test(commandLine);
}

function acquireLauncherLock() {
  fs.mkdirSync(desktopDevRoot, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(launcherLockPath, 'wx');
      try {
        fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
      } finally {
        fs.closeSync(descriptor);
      }
      launcherLockOwned = true;
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = Number.parseInt(fs.readFileSync(launcherLockPath, 'utf8').trim(), 10);
      if (isEterxLauncherProcess(owner)) {
        throw new Error(`A local EterX desktop session is already running (launcher PID ${owner}).`);
      }
      fs.rmSync(launcherLockPath, { force: true });
    }
  }
  throw new Error('Could not acquire the local EterX desktop launcher lock.');
}

function releaseLauncherLock() {
  if (!launcherLockOwned) return;
  launcherLockOwned = false;
  try {
    const owner = Number.parseInt(fs.readFileSync(launcherLockPath, 'utf8').trim(), 10);
    if (owner === process.pid) fs.rmSync(launcherLockPath, { force: true });
  } catch {
    // The lock may already have been cleaned up after an interrupted launch.
  }
}

function trackChild(child) {
  childProcesses.add(child);
  child.once('exit', () => childProcesses.delete(child));
  return child;
}

function childHasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

async function stopChild(child) {
  if (childHasExited(child)) return;

  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    if (process.platform === 'win32') {
      const taskkill = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      await Promise.race([
        new Promise((resolve) => taskkill.once('exit', resolve)),
        delay(3000),
      ]);
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  } catch {
    try { child.kill(); } catch { }
  }

  await Promise.race([exited, delay(3500)]);
  if (!childHasExited(child) && process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { } }
  }
}

function closeSourceWatchers() {
  if (electronRestartTimer) clearTimeout(electronRestartTimer);
  electronRestartTimer = null;
  for (const watcher of sourceWatchers.splice(0)) {
    try { watcher.close(); } catch { }
  }
}

function shutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  closeSourceWatchers();
  shutdownPromise = Promise.allSettled(Array.from(childProcesses, (child) => stopChild(child)))
    .then(() => {
      releaseLauncherLock();
      process.exitCode = exitCode;
    });
  return shutdownPromise;
}

function spawnElectron() {
  if (shuttingDown) return null;
  const child = trackChild(spawn(process.execPath, [electronCli, '.'], {
    cwd: repositoryRoot,
    env: devEnvironment,
    stdio: 'inherit',
    windowsHide: false,
    detached: process.platform !== 'win32',
  }));
  electronProcess = child;
  child.once('error', (error) => {
    if (!shuttingDown) {
      console.error(`[EterX] Electron failed to start: ${error.message || error}`);
      void shutdown(1);
    }
  });
  child.once('exit', (code, signal) => {
    if (electronProcess === child) electronProcess = null;
    if (expectedElectronExits.has(child) || shuttingDown) return;
    logLifecycle(`Electron exited (code ${code ?? 'unknown'}, signal ${signal || 'none'}).`);
    // Task Manager termination is indistinguishable from some native crashes.
    // Only an explicit source-change restart may replace the desktop process.
    // End the owned server session as well so its agents cannot run orphaned.
    void shutdown(code === 0 && !signal ? 0 : 1);
  });
  return child;
}

async function restartElectron() {
  if (shuttingDown) return;
  if (childHasExited(electronProcess)) {
    await shutdown(0);
    return;
  }
  if (electronRestartInProgress) {
    electronRestartQueued = true;
    return;
  }

  electronRestartInProgress = true;
  do {
    electronRestartQueued = false;
    const previous = electronProcess;
    if (previous && !childHasExited(previous)) {
      expectedElectronExits.add(previous);
      await stopChild(previous);
    }
    if (!shuttingDown) spawnElectron();
  } while (electronRestartQueued && !shuttingDown);
  electronRestartInProgress = false;
}

function scheduleElectronRestart(changedFile) {
  if (shuttingDown) return;
  if (electronRestartTimer) clearTimeout(electronRestartTimer);
  electronRestartTimer = setTimeout(() => {
    electronRestartTimer = null;
    let fingerprint;
    try {
      fingerprint = readElectronSourceFingerprint();
    } catch (error) {
      // Editors may temporarily remove or lock files during an atomic save.
      // Keep the existing shell alive until the source can be read again.
      logLifecycle(`Waiting for Electron source files: ${error.message || error}`);
      scheduleElectronRestart(changedFile);
      return;
    }
    if (fingerprint === electronSourceFingerprint) return;
    electronSourceFingerprint = fingerprint;
    logLifecycle(`${changedFile} changed; restarting the Electron shell...`);
    void restartElectron();
  }, 750);
}

function watchElectronSources() {
  electronSourceFingerprint = readElectronSourceFingerprint();
  const electronWatcher = fs.watch(electronSourceRoot, (_eventType, fileName) => {
    const changedFile = String(fileName || 'electron source');
    if (!fileName || electronSourceExtensions.has(path.extname(changedFile).toLowerCase())) {
      scheduleElectronRestart(path.join('electron', changedFile));
    }
  });
  electronWatcher.on('error', (error) => {
    console.warn(`[EterX] Electron source watcher stopped: ${error.message || error}`);
  });
  sourceWatchers.push(electronWatcher);

  if (fs.existsSync(gatewaySourceRoot)) {
    const gatewayWatcher = fs.watch(gatewaySourceRoot, (_eventType, fileName) => {
      const changedFile = String(fileName || 'gateway source');
      if (!fileName || path.extname(changedFile).toLowerCase() === '.cjs') {
        scheduleElectronRestart(path.relative(repositoryRoot, path.join(gatewaySourceRoot, changedFile)));
      }
    });
    gatewayWatcher.on('error', (error) => {
      console.warn(`[EterX] Gateway source watcher stopped: ${error.message || error}`);
    });
    sourceWatchers.push(gatewayWatcher);
  }
}

function createDevEnvironment(overrides = {}) {
  return {
    ...process.env,
    ...overrides,
    ETERX_DESKTOP_DEV: '1',
    ETERX_DESKTOP_DEV_USER_DATA: desktopDevUserData,
    ETERX_DATA_DIR: path.join(desktopDevUserData, 'data'),
    // Keep one reusable output directory. Next.js otherwise adds a new
    // generated type path to tsconfig.json every time the desktop command runs.
    ETERX_DEV_DIST_DIR: '.next-dev-desktop',
  };
}

async function main() {
  acquireLauncherLock();

  if (process.env.ELECTRON_URL) {
    devEnvironment = createDevEnvironment();
    watchElectronSources();
    console.log(`[EterX] Local desktop profile: ${desktopDevUserData}`);
    console.log('[EterX] Next.js handles UI hot reload; Electron sources restart the shell automatically.');
    spawnElectron();
    return;
  }

  const configuredPort = Number(process.env.ETERX_PORT || process.env.PORT || 3000);
  const startPort = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 3000;
  const port = await findAvailablePort(startPort);
  const target = `http://127.0.0.1:${port}`;
  devEnvironment = createDevEnvironment({
    HOSTNAME: '127.0.0.1',
    PORT: String(port),
    ETERX_PORT: String(port),
    ELECTRON_URL: target,
    ETERX_DEV_PREWARMED: '0',
  });

  nextProcess = trackChild(spawn(process.execPath, [nextCli, 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: repositoryRoot,
    env: devEnvironment,
    stdio: 'inherit',
    windowsHide: true,
    detached: process.platform !== 'win32',
  }));
  nextProcess.once('error', (error) => {
    if (!shuttingDown) {
      console.error(`[EterX] Next.js development server failed to start: ${error.message || error}`);
      void shutdown(1);
    }
  });
  nextProcess.once('exit', (code) => {
    if (!shuttingDown) {
      logLifecycle(`Next.js development server exited with code ${code ?? 'unknown'}; closing the local session.`);
      void shutdown(code ?? 1);
    }
  });

  await waitForPort(port);
  await waitForHttpTarget(target);
  // The complete page body is ready before Electron starts. Let the renderer
  // navigate directly instead of making the main process issue a second
  // blocking readiness request against the same development server.
  devEnvironment.ETERX_DEV_PREWARMED = '1';
  watchElectronSources();
  console.log(`[EterX] Local desktop profile: ${desktopDevUserData}`);
  console.log('[EterX] Next.js handles UI hot reload; Electron sources restart the shell automatically.');
  spawnElectron();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void shutdown(130); });
}
process.once('exit', releaseLauncherLock);

main().catch(async (error) => {
  console.error(`[EterX] Desktop development startup failed: ${error.message || error}`);
  await shutdown(1);
});
