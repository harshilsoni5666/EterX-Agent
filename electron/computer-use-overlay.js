const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { BrowserWindow, screen, globalShortcut, powerMonitor, shell } = require('electron');
const overlayHtml = require('./computer-use-overlay-ui');

// A private loopback bridge lets the Node agent runtime own an activity lease
// without depending on the main app renderer being visible or responsive.
exports.startComputerUseOverlay = async function startComputerUseOverlay(dataRoot, log = () => {}) {
  const descriptorPath = path.join(dataRoot, '.temp', 'desktop-control-bridge.json');
  const token = crypto.randomBytes(32).toString('hex');
  const overlays = new Map();
  const positioningWarnings = new WeakSet();
  const leases = new Map();
  const stopped = new Map();
  let showing = null;
  let hideTimer = null;
  let keyRegistered = false;
  let disposed = false;
  let visibilityGeneration = 0;
  const leaseTimeoutMs = 15_000;
  const startupTimeoutMs = 30_000;

  function stopResult(record) {
    return { stopped: true, reason: record?.reason || 'lease_missing',
      message: record?.message || 'The desktop activity session is no longer available.',
      userInitiated: record?.reason === 'user_escape' };
  }

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

  function stop(reason = 'overlay_unavailable', message = 'Desktop stop controls became unavailable.') {
    const now = Date.now();
    for (const lease of leases.values()) stopped.set(lease.runKey, { at: now, reason, message });
    if (leases.size) log(`[computer-use] Stopped desktop control: ${reason}.`);
    leases.clear();
    hide();
  }
  const onEscape = () => stop('user_escape', 'Computer use was stopped with Escape.');
  const onSuspend = () => stop('suspended', 'Computer use stopped because the device suspended.');
  const onLock = () => stop('screen_locked', 'Computer use stopped because the screen was locked.');

  function placeOnDisplay(window, display) {
    if (window.isDestroyed()) return;
    const current = window.getBounds();
    const full = display.bounds;
    // Electron uses logical display coordinates on every platform. Keep the
    // frame on the whole monitor, including the taskbar/Dock, at any DPI.
    if (current.x !== full.x || current.y !== full.y || current.width !== full.width || current.height !== full.height) {
      window.setBounds(full, false);
    }
    window.setAlwaysOnTop(true, 'screen-saver', process.platform === 'darwin' ? 1 : 0);
    window.moveTop();
  }

  async function showDisplays() {
    if (disposed) throw new Error('Desktop overlay is shutting down.');
    const generation = visibilityGeneration;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    if (!keyRegistered) {
      keyRegistered = globalShortcut.register('Escape', onEscape);
      if (!keyRegistered) throw new Error('The operating system could not register Escape to stop computer use. Close any app reserving that shortcut and try again.');
    }
    const displays = screen.getAllDisplays();
    if (!displays.length) throw new Error('No interactive desktop display is available.');
    for (const [id, window] of overlays) {
      if (!displays.some(display => display.id === id)) { window.destroy(); overlays.delete(id); }
    }
    await Promise.all(displays.map(async display => {
      const existing = overlays.get(display.id);
      // Only the banner observes the menu-bar/notch inset; the perimeter uses
      // full display bounds even when the taskbar or Dock occupies an edge.
      const top = Math.max(14, display.workArea.y - display.bounds.y + 10);
      if (existing && !existing.isDestroyed()) {
        placeOnDisplay(existing, display);
        await existing.webContents.executeJavaScript(`document.documentElement.style.setProperty('--banner-top', '${Math.round(top)}px')`);
        return;
      }
      const window = new BrowserWindow({
        ...display.bounds, title: 'EterX Computer Use Overlay', show: false,
        frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
        focusable: false, skipTaskbar: true, movable: false, resizable: false,
        minimizable: false, maximizable: false, fullscreenable: false, roundedCorners: false,
        alwaysOnTop: true,
        ...(process.platform === 'win32' ? { thickFrame: false, backgroundMaterial: 'none', accentColor: false } : {}),
        ...(process.platform === 'darwin' ? { type: 'panel', enableLargerThanScreen: true, hiddenInMissionControl: true } : {}),
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, devTools: false, zoomFactor: 1 },
      });
      overlays.set(display.id, window);
      window.setIgnoreMouseEvents(true);
      window.setAlwaysOnTop(true, 'screen-saver', process.platform === 'darwin' ? 1 : 0);
      if (process.platform !== 'win32') window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      window.setContentProtection(true);
      window.setMenu(null);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('render-process-gone', () => {
        if (overlays.get(display.id) === window && !disposed) {
          stop('overlay_unavailable', 'The desktop indicator closed unexpectedly. Reopen the desktop app to restore stop controls.');
        }
      });
      try {
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml(top))}`);
      } catch (error) {
        if (generation === visibilityGeneration && !disposed) throw error;
        return;
      }
      if (!window.isDestroyed() && !disposed && leases.size && overlays.get(display.id) === window) {
        window.showInactive();
        // Window managers can constrain the initial rectangle to the work
        // area. Restore the full monitor after showing, without taking focus.
        placeOnDisplay(window, display);
      }
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
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if ([...leases.values()].some(lease => !lease.ended)) return;
      leases.clear();
      hide();
    }, 1400);
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
      const stopRecord = stopped.get(input.runKey);
      const wasStopped = Boolean(stopRecord);
      if (request.url === '/begin') {
        if (wasStopped) { reply(409, stopResult(stopRecord)); return; }
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        for (const [id, lease] of leases) if (lease.ended && Date.now() - lease.updatedAt > 1400) leases.delete(id);
        if (leases.size >= 64) { reply(429, { error: 'Too many desktop activity leases.' }); return; }
        const startedLease = { runKey: input.runKey, updatedAt: Date.now(), ended: false, starting: true };
        leases.set(input.leaseId, startedLease);
        try { await ensureVisible(); }
        catch (error) { stop('overlay_unavailable', String(error.message || error)); throw error; }
        if (stopped.has(input.runKey) || disposed || startedLease.ended || leases.get(input.leaseId) !== startedLease) {
          reply(409, stopResult(stopped.get(input.runKey))); return;
        }
        startedLease.starting = false;
        startedLease.updatedAt = Date.now();
        reply(200, { active: true, leaseTimeoutMs }); return;
      }
      const lease = leases.get(input.leaseId);
      if (lease && lease.runKey !== input.runKey) { reply(403, { error: 'Lease owner mismatch.' }); return; }
      if (request.url === '/open_target') {
        if (wasStopped || !lease || lease.ended || disposed) { reply(409, stopResult(stopRecord)); return; }
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
        if (wasStopped || !lease || lease.ended || disposed) {
          reply(200, stopResult(stopRecord || (lease?.ended ? { reason: 'lease_ended', message: 'Desktop activity ended.' } : null))); return;
        }
        lease.updatedAt = Date.now();
        reply(200, { active: true, stopped: false, leaseTimeoutMs }); return;
      }
      if (request.url === '/end') {
        if (lease) { lease.ended = true; lease.updatedAt = Date.now(); }
        scheduleHide();
        reply(200, { ended: true }); return;
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

  const reconcile = () => { if (leases.size) void ensureVisible().catch(error => stop('overlay_unavailable', String(error.message || error))); };
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, reconcile);
  powerMonitor.on('suspend', onSuspend);
  powerMonitor.on('lock-screen', onLock);
  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of stopped) if (now - record.at > 24 * 60 * 60_000) stopped.delete(key);
    for (const [id, lease] of leases) {
      if (lease.ended && now - lease.updatedAt > 1400) { leases.delete(id); continue; }
      if (!lease.ended && now - lease.updatedAt > (lease.starting ? startupTimeoutMs : leaseTimeoutMs)) {
        stopped.set(lease.runKey, { at: now, reason: 'heartbeat_expired', message: 'The desktop activity connection expired. Start a new task to reconnect.' });
        leases.delete(id);
        log('[computer-use] Desktop activity connection expired.');
      }
    }
    if (!leases.size && overlays.size) hide();
    if (leases.size) {
      // Shell/taskbar stacking can change as applications open. Keep the
      // transparent perimeter above it without activating an overlay window.
      for (const display of screen.getAllDisplays()) {
        const window = overlays.get(display.id);
        if (!window || window.isDestroyed() || !window.isVisible()) continue;
        try {
          placeOnDisplay(window, display);
          positioningWarnings.delete(window);
        } catch (error) {
          if (!positioningWarnings.has(window)) {
            positioningWarnings.add(window);
            log(`[computer-use] Could not position desktop indicator: ${error.message || error}`);
          }
        }
      }
    }
  }, 1000);
  watchdog.unref();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      stop('app_shutdown', 'The desktop app is shutting down.'); hide(true);
      clearInterval(watchdog);
      for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(event, reconcile);
      powerMonitor.removeListener('suspend', onSuspend);
      powerMonitor.removeListener('lock-screen', onLock);
      server.close();
      server.closeAllConnections();
      try {
        if (JSON.parse(fs.readFileSync(descriptorPath, 'utf8')).token === token) fs.unlinkSync(descriptorPath);
      } catch { /* Another desktop process may already own the descriptor. */ }
    },
  };
};
