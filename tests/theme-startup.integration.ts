import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { readInitialThemePreference } from '../src/lib/initial-theme';

// Execute the actual inline bootstrap in a minimal DOM, before React/storage
// hydration, with deliberately conflicting server and desktop preferences.
const layout = fs.readFileSync(path.join(process.cwd(), 'src/app/layout.tsx'), 'utf8');
const bootstrap = layout.slice(layout.indexOf('const createThemeInitScript'), layout.indexOf('export default function'));
const compiled = ts.transpile(bootstrap, { target: ts.ScriptTarget.ES2020 });
for (const [server, desktop, systemDark, expected] of [
  ['light', 'dark', false, 'dark'],
  ['dark', 'light', true, 'light'],
  ['system', undefined, true, 'dark'],
  ['system', undefined, false, 'light'],
  ['light', undefined, true, 'light'],
  ['dark', 'invalid', false, 'dark'],
] as const) {
  const classes = new Set<string>();
  const attributes: Record<string, string> = {};
  const root = {
    setAttribute: (key: string, value: string) => { attributes[key] = value; },
    classList: {
      toggle: (key: string, enabled: boolean) => enabled ? classes.add(key) : classes.delete(key),
    },
    style: { colorScheme: '' },
  };
  const script = vm.runInNewContext(`${compiled}\ncreateThemeInitScript(${JSON.stringify(server)})`, { DEFAULT_THEME: 'dark' });
  vm.runInNewContext(script, {
    document: { documentElement: root },
    window: { electronAPI: { initialTheme: desktop }, matchMedia: () => ({ matches: systemDark }) },
  });
  assert.equal(attributes['data-theme'], expected);
  assert.equal(root.style.colorScheme, expected);
  assert.deepEqual([...classes], [expected]);
}
assert.ok(layout.indexOf('id="eterx-theme-init"') < layout.indexOf('<body'));

// Simulate a fresh read after restart and recovery from a damaged primary file.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eterx-theme-test-'));
const previousDataDir = process.env.ETERX_DATA_DIR;
try {
  process.env.ETERX_DATA_DIR = dataDir;
  const settingsDir = path.join(dataDir, 'settings');
  fs.mkdirSync(settingsDir);
  const primary = path.join(settingsDir, 'preferences.json');
  const backup = path.join(settingsDir, 'preferences.backup.json');
  assert.equal(readInitialThemePreference(), 'dark');
  for (const theme of ['dark', 'light', 'system'] as const) {
    const saved = JSON.stringify({ eterx_settings: JSON.stringify({ theme }) });
    fs.writeFileSync(primary, saved);
    assert.equal(readInitialThemePreference(), theme);
    fs.writeFileSync(backup, saved);
    fs.writeFileSync(primary, '{broken');
    assert.equal(readInitialThemePreference(), theme);
  }
} finally {
  if (previousDataDir === undefined) delete process.env.ETERX_DATA_DIR;
  else process.env.ETERX_DATA_DIR = previousDataDir;
  // dataDir is the absolute temporary directory created above for this test.
  assert.ok(path.basename(dataDir).startsWith('eterx-theme-test-'));
  assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log('theme-startup integration tests passed');
