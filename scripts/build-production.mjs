import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const nextCli = new URL('../node_modules/next/dist/bin/next', import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildHome = path.join(repositoryRoot, '.eterx-build-home');
const workspaceRoot = path.join(repositoryRoot, '.workspaces');
const heldWorkspaceRoot = path.join(
  path.dirname(repositoryRoot),
  `.${path.basename(repositoryRoot)}-build-workspaces`,
);

// Next's Windows file tracer expands dynamic filesystem paths before its
// exclusion rules run. A user's workspace may contain protected profile
// junctions (for example INetCache), so keep durable runtime state entirely
// outside the trace root while compiling and restore it afterwards.
if (fs.existsSync(heldWorkspaceRoot) && !fs.existsSync(workspaceRoot)) {
  fs.renameSync(heldWorkspaceRoot, workspaceRoot);
}
if (fs.existsSync(heldWorkspaceRoot) && fs.existsSync(workspaceRoot)) {
  throw new Error(`Cannot build while both workspace paths exist: ${workspaceRoot} and ${heldWorkspaceRoot}`);
}
if (fs.existsSync(workspaceRoot)) {
  fs.renameSync(workspaceRoot, heldWorkspaceRoot);
}

let workspaceRestored = false;
function restoreWorkspace() {
  if (workspaceRestored) return;
  workspaceRestored = true;
  if (fs.existsSync(heldWorkspaceRoot) && !fs.existsSync(workspaceRoot)) {
    fs.renameSync(heldWorkspaceRoot, workspaceRoot);
  }
}

for (const directory of ['Desktop', 'Documents', 'Downloads']) {
  fs.mkdirSync(path.join(buildHome, directory), { recursive: true });
}
const child = spawn(process.execPath, [fileURLToPath(nextCli), 'build'], {
  cwd: repositoryRoot,
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    ETERX_BUILD_TARGET: process.env.ETERX_BUILD_TARGET || 'desktop',
    // Some server tools intentionally expose user folders at runtime. During
    // Next.js file tracing, isolate those dynamic home paths inside the
    // repository so the tracer never walks protected OS profile junctions.
    HOME: buildHome,
    USERPROFILE: buildHome,
    HOMEDRIVE: path.parse(buildHome).root.replace(/[\\/]$/, ''),
    HOMEPATH: buildHome.slice(path.parse(buildHome).root.length - 1),
  },
});

child.once('error', (error) => {
  restoreWorkspace();
  console.error(`[EterX build] Could not start Next.js: ${error.message}`);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  restoreWorkspace();
  if (signal) {
    console.error(`[EterX build] Next.js stopped by ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    restoreWorkspace();
    if (!child.killed) child.kill(signal);
  });
}
