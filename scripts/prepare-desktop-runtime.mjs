import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const standaloneRoot = path.join(repositoryRoot, '.next', 'standalone');
const runtimeRoot = path.join(repositoryRoot, 'desktop-runtime');

function findStandaloneServer(root) {
  const direct = path.join(root, 'server.js');
  if (fs.existsSync(direct)) return root;

  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      if (fs.existsSync(path.join(child, 'server.js'))) return child;
      queue.push(child);
    }
  }
  return null;
}

if (!fs.existsSync(standaloneRoot)) {
  throw new Error('The Next.js standalone build is missing. Run the production build first.');
}

const applicationRoot = findStandaloneServer(standaloneRoot);
if (!applicationRoot) {
  throw new Error('The standalone build does not contain server.js.');
}

const stagingRoot = `${runtimeRoot}.staging-${process.pid}`;
fs.rmSync(stagingRoot, { recursive: true, force: true });
fs.mkdirSync(stagingRoot, { recursive: true });
fs.cpSync(applicationRoot, stagingRoot, { recursive: true, force: true });

const staticSource = path.join(repositoryRoot, '.next', 'static');
const staticTarget = path.join(stagingRoot, '.next', 'static');
if (fs.existsSync(staticSource)) {
  fs.mkdirSync(path.dirname(staticTarget), { recursive: true });
  fs.cpSync(staticSource, staticTarget, { recursive: true, force: true });
}

const publicSource = path.join(repositoryRoot, 'public');
if (fs.existsSync(publicSource)) {
  fs.cpSync(publicSource, path.join(stagingRoot, 'public'), { recursive: true, force: true });
}

// electron/main.js is intentionally tiny and excludes the repository's full
// node_modules tree. Bundle only electron-updater and its production closure so
// clean installations can update without Node.js or npm on the user's device.
const updaterVersion = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'node_modules', 'electron-updater', 'package.json'), 'utf8'),
).version;
const updaterRoot = path.join(stagingRoot, 'updater');
fs.mkdirSync(updaterRoot, { recursive: true });
fs.writeFileSync(path.join(updaterRoot, 'package.json'), `${JSON.stringify({
  name: 'eterx-desktop-updater-runtime',
  private: true,
  version: '1.0.0',
  dependencies: { 'electron-updater': updaterVersion },
}, null, 2)}\n`);

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const updaterInstall = spawnSync(npmCommand, [
  'install',
  '--omit=dev',
  '--ignore-scripts',
  '--no-audit',
  '--fund=false',
  '--package-lock=false',
], {
  cwd: updaterRoot,
  stdio: 'inherit',
  shell: false,
  env: { ...process.env, NODE_ENV: 'production' },
});
if (updaterInstall.status !== 0) {
  throw new Error(`Could not prepare the desktop updater runtime (exit ${updaterInstall.status ?? 'unknown'}).`);
}

const required = [
  'server.js',
  path.join('.next', 'BUILD_ID'),
  path.join('.next', 'server', 'app-paths-manifest.json'),
  path.join('updater', 'node_modules', 'electron-updater', 'package.json'),
];
for (const relativePath of required) {
  if (!fs.existsSync(path.join(stagingRoot, relativePath))) {
    throw new Error(`Desktop runtime is incomplete: ${relativePath} is missing.`);
  }
}

fs.writeFileSync(
  path.join(stagingRoot, 'eterx-runtime.json'),
  `${JSON.stringify({
    schema: 1,
    appVersion: JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).version,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`,
  'utf8',
);

fs.rmSync(runtimeRoot, { recursive: true, force: true });
fs.renameSync(stagingRoot, runtimeRoot);
console.log(`[EterX build] Desktop runtime prepared at ${runtimeRoot}`);
