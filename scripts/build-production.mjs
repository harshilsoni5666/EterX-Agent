import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const nextCli = new URL('../node_modules/next/dist/bin/next', import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [fileURLToPath(nextCli), 'build'], {
  cwd: repositoryRoot,
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    ETERX_BUILD_TARGET: process.env.ETERX_BUILD_TARGET || 'desktop',
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
