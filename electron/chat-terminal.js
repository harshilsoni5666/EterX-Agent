const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { chatWorkspacePaths, isAbsoluteHostPath } = require('./workspace-layout');
const { createHostEnvironment } = require('./host-environment');
const { resolveHostShell } = require('./terminal-shell');
const { resolvePythonRuntime, applyWorkspaceEnvironment } = require('./python-runtime');
const { workspaceRoot } = require('./storage-layout');
const { acquireWorkspaceLease } = require('./managed-workspaces');

function shellForPlatform(platform = process.platform, env = process.env, preference = 'auto') {
  const file = resolveHostShell(preference, env, platform);
  const name = path.basename(file).toLowerCase();
  const args = /^(?:powershell|pwsh)(?:\.exe)?$/.test(name) ? ['-NoLogo'] : /^cmd(?:\.exe)?$/.test(name) ? ['/d'] : /^wsl(?:\.exe)?$/.test(name) ? [] : /^(?:bash|zsh|fish)(?:\.exe)?$/.test(name) ? ['-l'] : ['-i'];
  return { file, args, label: /powershell|pwsh/.test(name) ? 'PowerShell' : path.basename(file) };
}

function loadChatPty(app) {
  if (!app.isPackaged) return require('node-pty');
  // Keep the manifest, JS workers, native bindings, and macOS spawn-helper
  // together on disk. Resolving through dependencies.asar first can fail on
  // its unpacked package.json before we can select the physical entry point.
  return require(path.join(process.resourcesPath, 'runtime', 'terminal', 'node-pty'));
}

function registerChatTerminals({ ipcMain, app, getWindow, loadPty = () => loadChatPty(app) }) {
  const sessions = new Map();
  const owners = new Set();
  const authorize = (event) => {
    const win = getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Terminal access denied');
  };
  const get = (event, id) => {
    authorize(event);
    const session = sessions.get(id);
    if (!session || session.owner !== event.sender) throw new Error('Terminal session is unavailable');
    return session;
  };
  const close = (id) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    clearTimeout(session.timer);
    clearTimeout(session.attachTimer);
    session.dataListener?.dispose();
    session.exitListener?.dispose();
    // An exited terminal can stay visible for hours. Its PID may have been
    // reused by then, so closing that tab must never signal it again.
    if (session.exitCode === undefined) {
      try { session.pty.kill(); } catch {}
    }
    session.releaseWorkspace?.();
  };
  ipcMain.handle('chat-terminal-create', (event, options = {}) => {
    authorize(event);
    if (!options || typeof options !== 'object') throw new Error('Invalid terminal options');
    if (typeof options.chatId !== 'string' || !options.chatId || options.chatId.length > 200) throw new Error('Invalid chat');
    if (sessions.size >= 32 || [...sessions.values()].filter(s => s.chatId === options.chatId).length >= 8) throw new Error('Close an unused terminal before opening another (8 per chat, 32 total).');
    const owned = chatWorkspacePaths(workspaceRoot(), 'default', options.chatId);
    const cwd = options.cwd || owned.workspace;
    if (!options.cwd) fs.mkdirSync(cwd, { recursive: true });
    if (!isAbsoluteHostPath(cwd) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`The project folder is unavailable on this device: ${cwd}. Select its current location; the terminal was not opened elsewhere.`);
    const host = createHostEnvironment(process.env);
    const runtime = resolvePythonRuntime({ cwd, managedRoot: path.join(owned.base, 'runtime', 'python'), env: host });
    const env = applyWorkspaceEnvironment(host, { cwd, runtime, overrides: { TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
    const shell = shellForPlatform(process.platform, env, options.terminalShell);
    if (/^wsl(?:\.exe)?$/i.test(path.basename(shell.file))) shell.args = ['--cd', cwd];
    // Git Bash otherwise changes to HOME from its login profile.
    if (process.platform === 'win32' && /^bash\.exe$/i.test(path.basename(shell.file))) env.CHERE_INVOKING = '1';
    // Internal Electron/Node launch settings must not leak into user shells.
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
    let ptyModule;
    try {
      ptyModule = loadPty();
    } catch (error) {
      throw new Error(`Could not load the EterX terminal runtime on ${process.platform}/${process.arch}: ${error.message || error}`);
    }
    let pty;
    const releaseWorkspace = acquireWorkspaceLease(cwd);
    try {
      pty = ptyModule.spawn(shell.file, shell.args, { cwd, env, cols: 100, rows: 24, name: 'xterm-256color' });
      releaseWorkspace.setProcess?.(pty.pid);
    } catch (error) {
      releaseWorkspace();
      throw new Error(`Could not start ${shell.label} on ${process.platform}/${process.arch}: ${error.message || error}`);
    }
    const id = randomUUID();
    const session = { id, pty, releaseWorkspace, owner: event.sender, chatId: options.chatId, pending: '', outstanding: 0, timer: null, attached: false, visible: false, paused: false, cols: 100, rows: 24 };
    const send = (payload) => {
      if (session.owner.isDestroyed()) { close(id); return; }
      try { session.owner.send('chat-terminal-event', { id, ...payload }); }
      catch { close(id); }
    };
    const flush = () => {
      clearTimeout(session.timer);
      session.timer = null;
      if (!session.attached || !session.pending || session.owner.isDestroyed()) return;
      const data = session.pending;
      session.pending = '';
      send({ data });
    };
    session.flush = flush;
    session.dataListener = pty.onData(data => {
      session.pending += data;
      session.outstanding += data.length;
      if (session.outstanding > 262144 && !session.paused) { session.paused = true; pty.pause(); }
      // Idle sessions schedule nothing. Background output is still consumed,
      // but larger batches avoid waking the renderer for every small chunk.
      if (!session.timer && session.attached) session.timer = setTimeout(flush, session.visible ? 16 : 160);
    });
    session.exitListener = pty.onExit(({ exitCode }) => {
      session.exitCode = exitCode;
      releaseWorkspace();
      flush();
      if (session.attached) send({ exitCode });
    });
    sessions.set(id, session);
    // A renderer can disappear between create and attach without ever owning
    // a visible tab. Do not leave that shell running indefinitely.
    session.attachTimer = setTimeout(() => { if (!session.attached) close(id); }, 30_000);
    session.attachTimer.unref?.();
    if (!owners.has(event.sender)) {
      owners.add(event.sender);
      const disposeOwner = () => { for (const [key, item] of sessions) if (item.owner === event.sender) close(key); };
      event.sender.on('render-process-gone', disposeOwner);
      event.sender.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) disposeOwner(); });
      event.sender.once('destroyed', () => { disposeOwner(); owners.delete(event.sender); });
    }
    return { id, label: shell.label, cwd };
  });
  ipcMain.handle('chat-terminal-transfer', (event, from, to) => {
    authorize(event);
    if (typeof from !== 'string' || typeof to !== 'string' || !to || to.length > 200) throw new Error('Invalid terminal owner');
    for (const session of sessions.values()) if (session.owner === event.sender && session.chatId === from) session.chatId = to;
  });
  ipcMain.handle('chat-terminal-attach', (event, id) => {
    const session = get(event, id);
    clearTimeout(session.attachTimer);
    if (session.attached) return;
    session.attached = true;
    session.flush();
    if (session.exitCode !== undefined) session.owner.send('chat-terminal-event', { id, exitCode: session.exitCode });
  });
  ipcMain.handle('chat-terminal-close', (event, id) => { get(event, id); close(id); });
  ipcMain.on('chat-terminal-visible', (event, id, visible) => {
    try {
      const s = get(event, id);
      if (s.visible === Boolean(visible)) return;
      s.visible = Boolean(visible);
      if (s.visible) s.flush();
    } catch {}
  });
  ipcMain.on('chat-terminal-input', (event, id, data) => {
    try { const s = get(event, id); if (typeof data === 'string' && data.length <= 1048576 && s.exitCode === undefined) s.pty.write(data); } catch {}
  });
  ipcMain.on('chat-terminal-resize', (event, id, cols, rows) => {
    try { const s = get(event, id); if (Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && cols <= 500 && rows >= 1 && rows <= 300 && s.exitCode === undefined && (s.cols !== cols || s.rows !== rows)) { s.pty.resize(cols, rows); s.cols = cols; s.rows = rows; } } catch {}
  });
  ipcMain.on('chat-terminal-ack', (event, id, count) => {
    try { const s = get(event, id); if (Number.isInteger(count) && count > 0) { s.outstanding = Math.max(0, s.outstanding - count); if (s.paused && s.outstanding < 65536 && s.exitCode === undefined) { s.paused = false; s.pty.resume(); } } } catch {}
  });
  app.on('will-quit', () => { for (const id of sessions.keys()) close(id); });
  return { sessions, close };
}

module.exports = { registerChatTerminals, shellForPlatform };
