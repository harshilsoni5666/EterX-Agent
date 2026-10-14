import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lockfile = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

// Importing catches configuration syntax and loading errors before native builds.
await import('../next.config.mjs');
await validateConfiguration(manifest.build, { isEnabled: false });
if (lockfile.version !== manifest.version || lockfile.packages?.['']?.version !== manifest.version) {
  throw new Error('The package and lockfile release versions must match.');
}
console.log('Next.js configuration, desktop packaging configuration, and release versions are valid.');
