const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { BrowserWindow, screen, globalShortcut, powerMonitor, shell } = require('electron');
const overlayHtml = require('./computer-use-overlay-ui');

// A private loopback bridge lets the Node agent runtime own an activity lease
// without depending on the main app renderer being visible or responsive.
exports.startComputerUseOverlay = async function startComputerUseOverlay(dataRoot) {
  const descriptorPath = path.join(dataRoot, '.temp', 'desktop-control-bridge.json');
  const token = crypto.randomBytes(32).toString('hex');
  const overlays = new Map();
  const leases = new Map();
  const stopped = new Map();
  let showing = null;
  let hideTimer = null;
  let keyRegistered = false;
  let disposed = false;
  let visibilityGeneration = 0;

  function hide(immediate = false) {
    visibilityGeneration += 1;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    if (keyRegistered) globalShortcut.unregister('Escape');
    keyRegistered = false;
    for (const window of overlays.values()) {
      if (window.isDestroyed()) continue;
      if (immediate) window.destroy();
      else {
        void window.webContents.executeJavaScript("document.body.classList.add('leaving')").catch(() => {});
        setTimeout(() => { if (!window.isDestroyed()) window.destroy(); }, 300).unref();
      }
    }
    overlays.clear();
  }

  function stop() {
    const now = Date.now();
    for (const lease of leases.values()) stopped.set(lease.runKey, now);
    leases.clear();
    hide();
  }

  async function showDisplays() {
    if (disposed) throw new Error('Desktop overlay is shutting down.');
    const generation = visibilityGeneration;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    if (!keyRegistered) {
      keyRegistered = globalShortcut.register('Escape', stop);
      if (!keyRegistered) throw new Error('The operating system could not register Escape to stop computer use. Close any app reserving that shortcut and try again.');
    }
    const displays = screen.getAllDisplays();
    if (!displays.length) throw new Error('No interactive desktop display is available.');
    for (const [id, window] of overlays) {
      if (!displays.some(display => display.id === id)) { window.destroy(); overlays.delete(id); }
    }
    await Promise.all(displays.map(async display => {
      const existing = overlays.get(display.id);
      const top = Math.max(16, display.workArea.y - display.bounds.y + 12);
      if (existing && !existing.isDestroyed()) {
        existing.setBounds(display.bounds);
        await existing.webContents.executeJavaScript(`document.querySelector('.banner').style.top = '${Math.round(top)}px'`);
        return;
      }
      const window = new BrowserWindow({
        ...display.bounds, title: 'EterX Computer Use Overlay', show: false,
        frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
        focusable: false, skipTaskbar: true, movable: false, resizable: false,
        minimizable: false, maximizable: false, fullscreenable: false, roundedCorners: false,
        ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, devTools: false },
      });
      overlays.set(display.id, window);
      window.setIgnoreMouseEvents(true);
      window.setAlwaysOnTop(true, 'screen-saver');
      if (process.platform !== 'win32') window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      window.setContentProtection(true);
      window.setMenu(null);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('render-process-gone', stop);
      try {
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml(top))}`);
      } catch (error) {
        if (generation === visibilityGeneration && !disposed) throw error;
        return;
      }
      if (!window.isDestroyed() && !disposed && leases.size && overlays.get(display.id) === window) window.showInactive();
    }));
  }

  async function ensureVisible() {
    do {
      if (!showing) showing = showDisplays().finally(() => { showing = null; });
      await showing;
      // Escape can retire a window while it is loading. A later run needs its
      // own visible windows, not a fulfilled promise from that retired run.
    } while (!disposed && leases.size && screen.getAllDisplays().some(display => !overlays.has(display.id)));
  }

  function scheduleHide() {
    if ([...leases.values()].some(lease => !lease.ended)) return;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { leases.clear(); hide(); }, 1400);
    hideTimer.unref();
  }

  const server = http.createServer(async (request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    // Browser origins are never clients of this bridge. The private token is
    // read only by the local Node runtime from the current user's data folder.
    if (request.headers.origin || request.headers.authorization !== `Bearer ${token}` || request.method !== 'POST') {
      reply(403, { error: 'Unauthorized desktop bridge request.' }); return;
    }
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 8192) { reply(413, { error: 'Request too large.' }); return; }
      }
      const input = JSON.parse(body || '{}');
      if (!/^[a-f0-9]{32,64}$/.test(String(input.runKey || '')) || !/^[a-f0-9-]{36}$/.test(String(input.leaseId || ''))) {
        reply(400, { error: 'Invalid activity lease.' }); return;
      }
      const wasStopped = stopped.has(input.runKey);
      if (request.url === '/begin') {
        if (wasStopped) { reply(409, { stopped: true, error: 'Computer use was stopped with Escape. Start a new task to resume.' }); return; }
        for (const [id, lease] of leases) if (lease.ended && Date.now() - lease.updatedAt > 1400) leases.delete(id);
        if (leases.size >= 64) { reply(429, { error: 'Too many desktop activity leases.' }); return; }
        leases.set(input.leaseId, { runKey: input.runKey, updatedAt: Date.now(), ended: false });
        try { await ensureVisible(); }
        catch (error) { stop(); throw error; }
        if (stopped.has(input.runKey) || disposed) { reply(409, { stopped: true }); return; }
        reply(200, { active: true }); return;
      }
      const lease = leases.get(input.leaseId);
      if (lease && lease.runKey !== input.runKey) { reply(403, { error: 'Lease owner mismatch.' }); return; }
      if (request.url === '/open_target') {
        if (wasStopped || !lease || lease.ended || disposed) { reply(409, { stopped: true }); return; }
        const target = String(input.target || '').trim();
        if (!target || target.length > 4096) throw new Error('Provide a file path or web URL.');
        if (input.kind === 'url') {
          const url = new URL(target);
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs can be opened.');
          await shell.openExternal(url.href);
        } else if (input.kind === 'path') {
          if (!path.isAbsolute(target)) throw new Error('Provide an absolute file, folder or application path.');
          const error = await shell.openPath(target);
          if (error) throw new Error(error);
        } else throw new Error('Unknown desktop open action.');
        reply(200, { requested: true, message: 'The operating system accepted the open request. Observe the resulting window before acting.' }); return;
      }
      if (request.url === '/pulse') {
        if (lease && !lease.ended && !wasStopped) lease.updatedAt = Date.now();
        reply(200, { stopped: wasStopped || !lease || disposed }); return;
      }
      if (request.url === '/end') {
        if (lease) { lease.ended = true; lease.updatedAt = Date.now(); }
        scheduleHide();
        reply(200, { stopped: wasStopped }); return;
      }
      reply(404, { error: 'Unknown desktop bridge action.' });
    } catch (error) {
      reply(409, { error: String(error.message || error).slice(0, 500) });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(descriptorPath, JSON.stringify({ port: server.address().port, token, pid: process.pid }), { mode: 0o600 });

  const reconcile = () => { if (leases.size) void ensureVisible().catch(stop); };
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, reconcile);
  powerMonitor.on('suspend', stop);
  powerMonitor.on('lock-screen', stop);
  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const [key, at] of stopped) if (now - at > 24 * 60 * 60_000) stopped.delete(key);
    for (const [id, lease] of leases) {
      if (!lease.ended && now - lease.updatedAt > 5000) { stopped.set(lease.runKey, now); leases.delete(id); }
    }
    if (!leases.size && overlays.size) hide();
  }, 1000);
  watchdog.unref();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      stop(); hide(true);
      clearInterval(watchdog);
      for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(event, reconcile);
      powerMonitor.removeListener('suspend', stop);
      powerMonitor.removeListener('lock-screen', stop);
      server.close();
      server.closeAllConnections();
      try {
        if (JSON.parse(fs.readFileSync(descriptorPath, 'utf8')).token === token) fs.unlinkSync(descriptorPath);
      } catch { /* Another desktop process may already own the descriptor. */ }
    },
  };
};
