const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

function shellForPlatform(platform = process.platform, env = process.env) {
  if (platform === 'win32') return { file: path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'], label: 'PowerShell' };
  const file = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  return { file, args: ['-l'], label: path.basename(file) };
}

function registerChatTerminals({ ipcMain, app, getWindow, loadPty = () => require('node-pty') }) {
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
    session.dataListener.dispose();
    session.exitListener.dispose();
    try { session.pty.kill(); } catch {}
  };
  ipcMain.handle('chat-terminal-create', (event, options = {}) => {
    authorize(event);
    if (typeof options.chatId !== 'string' || !options.chatId || options.chatId.length > 200) throw new Error('Invalid chat');
    if (sessions.size >= 32 || [...sessions.values()].filter(s => s.chatId === options.chatId).length >= 8) throw new Error('Close an unused terminal before opening another (8 per chat, 32 total).');
    const cwd = options.cwd || os.homedir();
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('The project folder is unavailable. Select an existing folder.');
    const shell = shellForPlatform();
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    // Internal Electron/Node launch settings must not leak into user shells.
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
    const pty = loadPty().spawn(shell.file, shell.args, { cwd, env, cols: 100, rows: 24, name: 'xterm-256color' });
    const id = randomUUID();
    const session = { id, pty, owner: event.sender, chatId: options.chatId, pending: '', outstanding: 0, timer: null, attached: false, visible: false, paused: false, cols: 100, rows: 24 };
    const flush = () => {
      clearTimeout(session.timer);
      session.timer = null;
      if (!session.attached || !session.pending || session.owner.isDestroyed()) return;
      const data = session.pending;
      session.pending = '';
      session.owner.send('chat-terminal-event', { id, data });
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
      flush();
      if (session.attached && !session.owner.isDestroyed()) session.owner.send('chat-terminal-event', { id, exitCode });
    });
    sessions.set(id, session);
    if (!owners.has(event.sender)) {
      owners.add(event.sender);
      const disposeOwner = () => { for (const [key, item] of sessions) if (item.owner === event.sender) close(key); };
      event.sender.on('render-process-gone', disposeOwner);
      event.sender.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) disposeOwner(); });
      event.sender.once('destroyed', () => { disposeOwner(); owners.delete(event.sender); });
    }
    return { id, label: shell.label, cwd };
  });
  ipcMain.handle('chat-terminal-attach', (event, id) => {
    const session = get(event, id);
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
