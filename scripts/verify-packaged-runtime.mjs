import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractFile, listPackage } = require('@electron/asar');
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
  'runtime/server-launcher.js',
  'runtime/.next/BUILD_ID',
  'runtime/assets/skills',
];
const requiredDependencies = [
  'node_modules/next/package.json',
  'node_modules/@swc/helpers/package.json',
  'node_modules/electron-updater/package.json',
  'node_modules/ws/package.json',
  'node_modules/complex.js/dist/complex.js',
  'node_modules/mathjs/lib/cjs/index.js',
  'node_modules/fraction.js/fraction.js',
];
const swcPackageByTarget = {
  'win32:x64': 'node_modules/@next/swc-win32-x64-msvc/package.json',
  'win32:arm64': 'node_modules/@next/swc-win32-arm64-msvc/package.json',
  'darwin:x64': 'node_modules/@next/swc-darwin-x64/package.json',
  'darwin:arm64': 'node_modules/@next/swc-darwin-arm64/package.json',
  'linux:x64': 'node_modules/@next/swc-linux-x64-gnu/package.json',
  'linux:arm64': 'node_modules/@next/swc-linux-arm64-gnu/package.json',
};
for (const target of String(process.env.ETERX_RUNTIME_TARGETS || '').split(',').map((value) => value.trim()).filter(Boolean)) {
  const swcPackage = swcPackageByTarget[target];
  if (!swcPackage) throw new Error(`Unknown ETERX_RUNTIME_TARGETS entry: ${target}`);
  requiredDependencies.push(swcPackage);
}
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
  const dependencyArchive = path.join(path.dirname(archive), 'runtime', 'dependencies.asar');
  if (!fs.existsSync(dependencyArchive)) {
    throw new Error(`${archive} is missing its external dependency archive.`);
  }
  const dependencyEntries = new Set(
    listPackage(dependencyArchive).map((entry) => entry.replaceAll('\\', '/').replace(/^\/+/, '')),
  );
  for (const required of requiredDependencies) {
    if (!dependencyEntries.has(required)) {
      throw new Error(`${dependencyArchive} is missing required dependency entry: ${required}`);
    }
  }
  const launcherSource = extractFile(archive, 'runtime/server-launcher.js').toString('utf8');
  for (const contractToken of ['ETERX_RUNTIME_MODULES', 'Module._initPaths()', "require.resolve('next/package.json')"]) {
    if (!launcherSource.includes(contractToken)) {
      throw new Error(`${archive} has an invalid packaged runtime launcher; missing ${contractToken}.`);
    }
  }
  console.log(`[EterX release] Verified packaged runtime contract: ${archive}`);
}
