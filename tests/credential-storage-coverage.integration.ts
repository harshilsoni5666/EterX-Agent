import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MODEL_PROVIDER_ORDER } from '../src/lib/agent/model-selector-store';
import { LIVE_PROVIDER_OPTIONS } from '../src/lib/live/live-provider';
import { SEARCH_PROVIDER_IDS } from '../src/lib/search/search-config';
import { IMAGE_PROVIDER_IDS } from '../src/lib/image/image-generation-config';
import { VIDEO_PROVIDER_IDS } from '../src/lib/video/video-generation-config';

const electronMain = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
const packageManifest = fs.readFileSync(path.resolve('package.json'), 'utf8');

const readLiteralSet = (name: string): Set<string> => {
  const match = electronMain.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  assert.ok(match, `${name} must remain a literal secure-storage allowlist`);
  return new Set(Array.from(match[1].matchAll(/'([^']+)'/g), item => item[1]));
};

const runtimeProviders = readLiteralSet('SECURE_RUNTIME_SETTINGS_PROVIDERS');
const searchProviders = readLiteralSet('SECURE_RUNTIME_SEARCH_PROVIDERS');
const imageProviders = readLiteralSet('SECURE_RUNTIME_IMAGE_PROVIDERS');
const videoProviders = readLiteralSet('SECURE_RUNTIME_VIDEO_PROVIDERS');

for (const provider of MODEL_PROVIDER_ORDER) {
  assert.ok(runtimeProviders.has(provider), `Missing secure model/API provider: ${provider}`);
}
for (const provider of new Set(LIVE_PROVIDER_OPTIONS.map(option => option.keyProvider))) {
  assert.ok(runtimeProviders.has(provider), `Missing secure Live Convo provider: ${provider}`);
}
for (const provider of SEARCH_PROVIDER_IDS) {
  assert.ok(searchProviders.has(provider), `Missing secure search provider: ${provider}`);
}
for (const provider of IMAGE_PROVIDER_IDS) {
  assert.ok(imageProviders.has(provider), `Missing secure image provider: ${provider}`);
}
for (const provider of VIDEO_PROVIDER_IDS) {
  assert.ok(videoProviders.has(provider), `Missing secure video provider: ${provider}`);
}

assert.ok(runtimeProviders.has('github'), 'GitHub credentials must use secure runtime storage');
assert.match(electronMain, /safeStorage\.encryptString\(serialized\)/, 'Runtime settings must use Electron safeStorage');
assert.equal(JSON.parse(packageManifest)?.build?.nsis?.deleteAppDataOnUninstall, false, 'Desktop updates/uninstalls must preserve AppData');

console.log('credential storage coverage integration tests passed');
