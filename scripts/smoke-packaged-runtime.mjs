import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const searchRoot = path.resolve(process.argv[2] || 'dist');

function findArchive(root) {
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isFile() && entry.name === 'app.asar') return target;
    }
  }
  throw new Error(`No packaged app.asar was found under ${root}.`);
}

function getElectronBinary() {
  const electronRoot = path.resolve('node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return path.join(electronRoot, 'electron.exe');
  if (process.platform === 'darwin') {
    return path.join(electronRoot, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  }
  return path.join(electronRoot, 'electron');
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function requestReady(port) {
  return new Promise((resolve) => {
    const request = http.get(`http://127.0.0.1:${port}`, (response) => {
      response.resume();
      resolve(Boolean(response.statusCode && response.statusCode < 500));
    });
    request.setTimeout(1500, () => {
      request.destroy();
      resolve(false);
    });
    request.once('error', () => resolve(false));
  });
}

const archive = findArchive(searchRoot);
const electronBinary = getElectronBinary();
const serverEntry = path.join(archive, 'runtime', 'server.js');
const modulesRoot = path.join(archive, 'runtime', 'modules');
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eterx-release-smoke-'));
const port = await reservePort();
let output = '';

const child = spawn(electronBinary, [serverEntry], {
  cwd: stateRoot,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ETERX_APP_ROOT: path.join(archive, 'runtime'),
    ETERX_DATA_DIR: stateRoot,
    ETERX_PORT: String(port),
    HOSTNAME: '127.0.0.1',
    NODE_ENV: 'production',
    NODE_PATH: [modulesRoot, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
    PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-12000); });
child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-12000); });

let ready = false;
const deadline = Date.now() + 90000;
while (!ready && child.exitCode === null && Date.now() < deadline) {
  ready = await requestReady(port);
  if (!ready) await new Promise((resolve) => setTimeout(resolve, 500));
}

if (child.exitCode === null) child.kill();
fs.rmSync(stateRoot, { recursive: true, force: true });

if (!ready) {
  throw new Error(`Packaged EterX runtime did not become ready.\n${output}`);
}
console.log(`[EterX release] Packaged runtime served HTTP successfully on port ${port}.`);
