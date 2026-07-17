import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const source = path.join(root, '.next', 'standalone');
const destination = path.join(root, 'desktop-runtime');

// Next's standalone tracing can pull unrelated sibling projects and local state
// into the output when an agent module uses dynamic filesystem access. The
// application server needs its compiled output and traced node_modules only;
// public assets and source are copied explicitly by electron-builder.
const excludedRootEntries = new Set([
  '.git',
  '.temp',
  '.workspaces',
  'coding-agent',
  'desktop-runtime',
  'dist',
  'gaia',
  'public',
  'src',
]);

if (!existsSync(source)) {
  throw new Error('Missing .next/standalone. Run `npm run build` before preparing the desktop runtime.');
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });

cpSync(source, destination, {
  recursive: true,
  dereference: true,
  filter: (entry) => {
    const relative = path.relative(source, entry);
    if (!relative) return true;
    const firstSegment = relative.split(path.sep)[0];
    return !excludedRootEntries.has(firstSegment);
  },
});

if (!existsSync(path.join(destination, 'server.js'))) {
  throw new Error('Prepared desktop runtime is invalid: server.js was not copied.');
}

console.log(`Prepared desktop runtime at ${destination}`);
