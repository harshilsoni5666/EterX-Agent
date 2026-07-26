import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listPackage } = require('@electron/asar');
const searchRoot = path.resolve(process.argv[2] || 'dist');

function findArchives(root) {
  const archives = [];
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isFile() && entry.name === 'app.asar') archives.push(target);
    }
  }
  return archives;
}

const archives = findArchives(searchRoot);
if (archives.length === 0) {
  throw new Error(`No packaged app.asar was found under ${searchRoot}.`);
}

const requiredFiles = [
  'runtime/server.js',
  'runtime/modules/next/package.json',
  'runtime/modules/@swc/helpers/package.json',
  'runtime/modules/electron-updater/package.json',
  'runtime/.next/BUILD_ID',
  'runtime/assets/skills',
  'runtime/assets/agent-prompts/prompts',
];
const forbiddenPrefixes = [
  'runtime/src/',
  'runtime/coding-agent/',
  'runtime/docs/',
  'runtime/node_modules/',
];

for (const archive of archives) {
  const entries = new Set(
    listPackage(archive).map((entry) => entry.replaceAll('\\', '/').replace(/^\/+/, '')),
  );
  for (const required of requiredFiles) {
    if (![...entries].some((entry) => entry === required || entry.startsWith(`${required}/`))) {
      throw new Error(`${archive} is missing required packaged runtime entry: ${required}`);
    }
  }
  for (const forbidden of forbiddenPrefixes) {
    if ([...entries].some((entry) => entry.startsWith(forbidden))) {
      throw new Error(`${archive} exposes forbidden source content: ${forbidden}`);
    }
  }
  console.log(`[EterX release] Verified packaged runtime contract: ${archive}`);
}
