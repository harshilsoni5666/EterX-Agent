import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const nextCli = new URL('../node_modules/next/dist/bin/next', import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildHome = path.join(repositoryRoot, '.eterx-build-home');
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
  console.error(`[EterX build] Could not start Next.js: ${error.message}`);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`[EterX build] Next.js stopped by ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
