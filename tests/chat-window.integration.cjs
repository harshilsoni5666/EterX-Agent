const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync('electron/main.js', 'utf8');
const start = source.indexOf("ipcMain.handle('chat-window-open'");
const end = source.indexOf('\nfunction createWindow()', start);
let handler;
const windows = [];
const chatWindows = new Set();
class Window extends EventEmitter {
  constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.isDestroyed = () => false; this.webContents.send = () => {}; this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn; }; windows.push(this); }
  setMenuBarVisibility() {}
  async loadURL(url) { this.url = url; }
  show() { this.visible = true; this.emit('show'); }
  isVisible() { return !!this.visible; }
  isMinimized() { return false; }
  isDestroyed() { return !!this.destroyed; }
  destroy() { this.destroyed = true; this.emit('closed'); }
  close() { let prevented = false; this.emit('close', { preventDefault() { prevented = true; } }); if (!prevented) this.destroy(); }
}
const flushes = [];
vm.runInNewContext(source.slice(start, end), {
  ipcMain: { handle(name, fn) { handler = fn; } }, isTrustedRenderer: sender => sender.trusted,
  nativeThemeColors: () => ({}), readNativeTheme: () => 'dark', process: { platform: 'win32' },
  NATIVE_FRAME_HEIGHT: 32, BrowserWindow: Window, getSystemIconPath: () => '', IS_DESKTOP_DEVELOPMENT: true,
  path: require('node:path'), __dirname: 'electron', chatWindows, registerNativeThemedWindow() {}, attachNativeContextMenu() {},
  shell: { openExternal() {} }, isTrustedAppUrl: url => url.startsWith('http://127.0.0.1:3000'), isQuitting: false,
  requestRendererDurableFlush: async (timeout, attempts, options) => { flushes.push(options.targetWindow); return true; },
  dialog: { showMessageBox() { throw Error('Unexpected save failure'); } }, URL, getAppTarget: () => 'http://127.0.0.1:3000',
});
(async () => {
  const frame = {};
  const event = { sender: { trusted: true, mainFrame: frame }, senderFrame: frame };
  assert.equal((await handler({ sender: { trusted: false } }, 'chat')).ok, false);
  assert.equal((await handler(event, '')).ok, false);
  assert.equal((await handler(event, 'chat with spaces/&')).ok, true);
  assert.equal((await handler(event, 'second')).ok, true);
  assert.equal(windows.length, 2);
  assert.equal(new URL(windows[0].url).searchParams.get('chat'), 'chat with spaces/&');
  assert.equal(windows[0].visible, true);
  assert.equal(windows[0].options.webPreferences.contextIsolation, true);
  assert.equal(windows[0].options.webPreferences.nodeIntegration, false);
  windows[0].close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(flushes[0], windows[0]);
  assert.equal(windows[0].isDestroyed(), true);
  assert.equal(windows[1].isDestroyed(), false);
  assert.equal(chatWindows.size, 1);
  console.log('Chat window checks passed: trusted IPC, separate windows, exact chat URL, isolated preload, independent durable close.');
})().catch(error => { console.error(error); process.exitCode = 1; });
