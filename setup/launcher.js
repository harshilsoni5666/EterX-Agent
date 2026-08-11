#!/usr/bin/env node
/**
 * EterX Smart Launcher
 * - Finds free port (3000+)
 * - Starts Next.js production server (or dev)
 * - Launches Electron pointing to the correct port
 * - Auto-restarts on crash (max 3 times)
 * - Single-instance guard
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const MAX_RESTARTS = 3;

// The launcher is also used by source/bootstrap installs. Keep its instance
// lock beside the app's per-user data on every supported OS so two copies of
// the checkout cannot block one another and the source tree is never used as
// durable application state.
function getUserDataRoot() {
  if (process.platform === 'win32') {
    const root = process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(root, 'EterX');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'EterX');
  }
  const root = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(root, 'EterX');
}

const LOCK_FILE = path.join(getUserDataRoot(), 'launcher.lock');

// ── Single Instance Guard ──
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`[EterX] Already running (PID ${pid}). Exiting.`);
        process.exit(0);
      } catch {
        // Process doesn't exist, stale lock
      }
    }
    const dir = path.dirname(LOCK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch {}
}

function releaseLock() {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch {}
}

// ── Port Detection ──
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, '127.0.0.1');
    server.on('listening', () => { server.close(); resolve(true); });
    server.on('error', () => resolve(false));
  });
}

async function findFreePort(start = 3000) {
  for (let p = start; p < start + 20; p++) {
    if (await isPortFree(p)) return p;
  }
  return start;
}

// ── Process Management ──
function startNextServer(port, mode = 'dev') {
  const args = mode === 'production' ? ['run', 'start', '--', '-p', String(port)]
    : ['run', 'dev', '--', '-p', String(port)];
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  console.log(`[EterX] Starting Next.js (${mode}) on port ${port}...`);

  const proc = spawn(npmCommand, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: { ...process.env, PORT: String(port) },
    detached: false,
  });

  proc.stdout.on('data', (d) => {
    const line = d.toString().trim();
    if (line) process.stdout.write(`  [next] ${line}\n`);
  });

  proc.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line && !line.includes('ExperimentalWarning')) process.stderr.write(`  [next] ${line}\n`);
  });

  return proc;
}

function waitForServer(port, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Server did not start within ${timeoutMs / 1000}s`));
      }
      const req = require('http').get(`http://127.0.0.1:${port}`, (res) => {
        if (res.statusCode < 500) resolve();
        else setTimeout(check, 500);
        res.resume();
      });
      req.on('error', () => setTimeout(check, 500));
      req.end();
    };
    check();
  });
}

function startElectron(port) {
  console.log(`[EterX] Launching Electron → 127.0.0.1:${port}`);
  const electronPath = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');

  if (!fs.existsSync(electronPath.replace('.cmd', '.exe')) && !fs.existsSync(electronPath)) {
    console.log('[EterX] Electron not found. Opening in browser instead.');
    const open = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try { execSync(`${open} http://localhost:${port}`); } catch {}
    return null;
  }

  const proc = spawn(electronPath, ['.'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ETERX_PORT: String(port), ELECTRON_URL: `http://127.0.0.1:${port}` },
  });

  return proc;
}

// ── Main ──
async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--production') ? 'production' : 'dev';
  const noBrowser = args.includes('--no-electron');

  acquireLock();
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

  console.log('\n  ⚡ EterX Agent Launcher\n');

  const port = await findFreePort(3000);
  if (port !== 3000) console.log(`  [info] Port 3000 busy, using ${port}`);

  let restarts = 0;
  let nextProc = null;
  let electronProc = null;

  const startServer = async () => {
    nextProc = startNextServer(port, mode);

    if (!noBrowser && !electronProc) {
      electronProc = startElectron(port);
      if (electronProc) {
        electronProc.on('close', () => {
          console.log('  [info] Electron closed. Shutting down...');
          if (nextProc) nextProc.kill();
          releaseLock();
          process.exit(0);
        });
      }
    }

    nextProc.on('close', async (code) => {
      if (code !== 0 && code !== null && restarts < MAX_RESTARTS) {
        restarts++;
        console.log(`  [warn] Server crashed (code ${code}). Restart ${restarts}/${MAX_RESTARTS}...`);
        await new Promise(r => setTimeout(r, 2000));
        await startServer();
      } else if (restarts >= MAX_RESTARTS) {
        console.log('  [error] Max restarts reached. Exiting.');
        releaseLock();
        process.exit(1);
      }
    });

    try {
      await waitForServer(port);
      console.log(`  ✔ Server ready on http://localhost:${port}\n`);

    } catch (err) {
      console.log(`  [error] ${err.message}`);
      if (nextProc) nextProc.kill();
      if (electronProc) electronProc.kill();
      releaseLock();
      process.exit(1);
    }
  };

  await startServer();
}

// Only run when called directly (not when require()'d)
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    releaseLock();
    process.exit(1);
  });
}

module.exports = { main };
