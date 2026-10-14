import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const searchRoot = path.resolve(process.argv[2] || 'dist');

function findArchive(root) {
  // Exercise the host architecture when a Windows job packages both targets.
  if (process.platform === 'win32') {
    const directory = process.arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked';
    const nativeArchive = path.join(root, directory, 'resources', 'app.asar');
    if (fs.existsSync(nativeArchive)) return nativeArchive;
  }
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

function request(port, options = {}) {
  return new Promise((resolve) => {
    const body = options.body ? JSON.stringify(options.body) : '';
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: options.path || '/',
      method: options.method || 'GET',
      headers: body ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      } : undefined,
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody = `${responseBody}${chunk}`.slice(-12000); });
      response.on('end', () => resolve({
        statusCode: response.statusCode || 0,
        body: responseBody,
      }));
    });
    request.setTimeout(options.timeoutMs || 1500, () => {
      request.destroy();
      resolve({ statusCode: 0, body: '' });
    });
    request.once('error', () => resolve({ statusCode: 0, body: '' }));
    if (body) request.write(body);
    request.end();
  });
}

const archive = findArchive(searchRoot);
const electronBinary = getElectronBinary();
const serverEntry = path.join(archive, 'runtime', 'server-launcher.js');
const modulesRoot = path.join(path.dirname(archive), 'runtime', 'dependencies.asar', 'node_modules');
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eterx-release-smoke-'));
const port = await reservePort();
let output = '';

function stopChild() {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
    setTimeout(resolve, 5000);
  });
}

const child = spawn(electronBinary, [serverEntry], {
  cwd: stateRoot,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ETERX_APP_ROOT: path.join(archive, 'runtime'),
    ETERX_DATA_DIR: stateRoot,
    ETERX_RUNTIME_MODULES: modulesRoot,
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
  const rootResponse = await request(port);
  ready = rootResponse.statusCode > 0 && rootResponse.statusCode < 500;
  if (!ready) await new Promise((resolve) => setTimeout(resolve, 500));
}

if (!ready) {
  await stopChild();
  fs.rmSync(stateRoot, { recursive: true, force: true });
  throw new Error(`Packaged EterX runtime did not become ready.\n${output}`);
}

// Loading this route imports the complete agent registry and its dynamic tool
// dependency graph. GET is intentionally unsupported (405), so the check
// validates module loading without starting an external agent run.
const agentResponse = await request(port, {
  path: '/api/agent/start',
  method: 'GET',
  timeoutMs: 90000,
});

// The desktop UI polls this route continuously. It imports mathjs, cheerio,
// and their version-sensitive nested dependencies, so any 500 here blocks the
// installer even when the root page and start route are healthy.
const pollResponse = await request(port, {
  path: '/api/agent/poll?chatId=eterx-package-smoke&after=-1',
  method: 'GET',
  timeoutMs: 90000,
});

await stopChild();
fs.rmSync(stateRoot, { recursive: true, force: true });

if (agentResponse.statusCode !== 405) {
  throw new Error(
    `Packaged agent route failed its dependency smoke check `
    + `(expected 405, received ${agentResponse.statusCode}).\n`
    + `${agentResponse.body}\n${output}`,
  );
}
if (pollResponse.statusCode === 0 || pollResponse.statusCode >= 500) {
  throw new Error(
    `Packaged polling route failed its dependency smoke check `
    + `(received ${pollResponse.statusCode}).\n`
    + `${pollResponse.body}\n${output}`,
  );
}
console.log(`[EterX release] Packaged UI and agent dependency graph passed on port ${port}.`);
