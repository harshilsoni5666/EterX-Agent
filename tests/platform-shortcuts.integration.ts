import assert from 'node:assert/strict';
import { getPlatformShortcut, normalizeShortcutForPlatform } from '../src/lib/agent/computer/platform-shortcuts';

assert.equal(getPlatformShortcut('copy', 'darwin'), 'cmd+c');
assert.equal(getPlatformShortcut('paste', 'win32'), 'ctrl+v');
assert.equal(getPlatformShortcut('close_window', 'linux'), 'alt+f4');
assert.equal(getPlatformShortcut('close_window', 'darwin'), 'cmd+w');

assert.equal(normalizeShortcutForPlatform('ctrl+shift+c', 'darwin'), 'cmd+shift+c');
assert.equal(normalizeShortcutForPlatform('cmd+v', 'win32'), 'ctrl+v');
// `control+...` is explicit on macOS and must not be rewritten as Cmd.
assert.equal(normalizeShortcutForPlatform('control+c', 'darwin'), 'control+c');

console.log('platform-shortcuts integration tests passed');
