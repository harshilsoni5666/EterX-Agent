const fs = require('fs/promises');
const path = require('path');
const os = require('os');

// Applied once per document by Chromium. No page script, polling, or scroll
// handlers are needed, and the media queries follow the native app theme.
const browserScrollbarCSS = `
  @media (forced-colors: none) {
    :root { --eterx-browser-thumb:rgba(0,0,0,.24); --eterx-browser-thumb-hover:rgba(0,0,0,.38); }
    @media (prefers-color-scheme: dark) {
      :root { --eterx-browser-thumb:rgba(255,255,255,.28); --eterx-browser-thumb-hover:rgba(255,255,255,.44); }
    }
    * { scrollbar-color:auto !important; scrollbar-width:auto !important; }
    ::-webkit-scrollbar { width:9px !important; height:9px !important; background:transparent !important; }
    ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background:transparent !important; border:0 !important; }
    ::-webkit-scrollbar-thumb { background:var(--eterx-browser-thumb) !important; border:2px solid transparent !important; background-clip:padding-box !important; border-radius:999px !important; min-height:32px !important; min-width:32px !important; box-shadow:none !important; }
    ::-webkit-scrollbar-thumb:hover, ::-webkit-scrollbar-thumb:active { background-color:var(--eterx-browser-thumb-hover) !important; }
    ::-webkit-scrollbar-button { display:none !important; width:0 !important; height:0 !important; }
    @media (pointer:coarse) { ::-webkit-scrollbar { width:12px !important; height:12px !important; } }
  }
`;

// Remote pages have their own sandboxed renderer and no EterX preload/IPC.
exports.registerWorkspacePanel = ({ ipcMain, app, getWindow }) => {
  const { WebContentsView, session, Menu, nativeTheme, clipboard, net } = require('electron');
  const browsers = new Map();
  const suggestionRequests = new Map();
  let browserSession;
  let observedWindow;
  const authorize = event => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Workspace access is unavailable.');
    return window;
  };
  const safeURL = input => {
    const value = String(input || '').trim();
    if (value === 'about:blank') return value;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Enter an HTTP or HTTPS address.');
    return url.href;
  };
  const hide = entry => {
    if (!entry?.attached) return;
    const window = getWindow();
    if (window && !window.isDestroyed()) window.contentView.removeChildView(entry.view);
    entry.attached = false;
  };
  const close = id => {
    suggestionRequests.get(id)?.abort(); suggestionRequests.delete(id);
    const entry = browsers.get(id);
    if (!entry) return;
    hide(entry);
    browsers.delete(id);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  };
  const cleanup = () => { for (const id of browsers.keys()) close(id); };
  // Electron 30 exposes navigationHistory for inspecting entries only. The
  // navigation methods moved from webContents onto that object in later versions.
  const navigation = wc => typeof wc.navigationHistory?.canGoBack === 'function' ? wc.navigationHistory : wc;
  const snapshot = entry => {
    const wc = entry.view.webContents;
    const history = navigation(wc);
    return { id: entry.id, url: wc.getURL(), title: wc.getTitle(), favicon: entry.favicon || '', loading: wc.isLoading(), canGoBack: history.canGoBack(), canGoForward: history.canGoForward(), error: entry.error || '' };
  };
  const emit = entry => {
    const window = getWindow();
    if (!window || window.isDestroyed() || entry.view.webContents.isDestroyed()) return;
    window.webContents.send('workspace-browser-event', snapshot(entry));
  };
  function prepare(window) {
    if (!browserSession) {
      browserSession = session.fromPartition('persist:eterx-workspace-browser');
      browserSession.setPermissionCheckHandler(() => false);
      browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      // Chromium/Electron owns the native Save dialog for downloads.
    }
    if (observedWindow !== window) {
      observedWindow = window;
      window.webContents.once('destroyed', cleanup);
      window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) cleanup(); });
    }
  }
  ipcMain.handle('workspace-browser-create', (event, id, theme = 'dark') => {
    const window = authorize(event);
    if (typeof id !== 'string' || id.length > 160) throw new Error('Invalid browser tab.');
    if (browsers.has(id)) return snapshot(browsers.get(id));
    if (browsers.size >= 12) throw new Error('Close a browser tab before opening another (12 tabs maximum).');
    prepare(window);
    nativeTheme.themeSource = theme === 'light' ? 'light' : 'dark';
    const view = new WebContentsView({ webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: true, navigateOnDragDrop: false } });
    const entry = { id, view, attached: false, error: '' };
    view.setBackgroundColor(theme === 'light' ? '#ffffff' : '#111111');
    browsers.set(id, entry);
    const wc = view.webContents;
    // Retain Chromium's real identity while removing the app-specific suffix.
    wc.setUserAgent(wc.getUserAgent().replace(/\s(?:Electron|eterx|EterX)\/[\w.-]+/g, ''));
    wc.on('dom-ready', () => { void wc.insertCSS(browserScrollbarCSS, { cssOrigin: 'user' }).catch(() => {}); });
    for (const eventName of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) wc.on(eventName, () => emit(entry));
    wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame) { entry.error = ''; if (!isInPlace) entry.favicon = ''; } });
    wc.on('page-favicon-updated', (_event, icons) => { entry.favicon = icons.find(icon => /^https?:\/\//i.test(icon)) || ''; emit(entry); });
    wc.on('did-fail-load', (_event, code, description, _url, mainFrame) => { if (mainFrame && code !== -3) { entry.error = description; emit(entry); } });
    wc.on('render-process-gone', () => { entry.error = 'This page stopped responding. Reload to recover.'; emit(entry); });
    wc.on('will-navigate', (event, url) => { try { safeURL(url); } catch { event.preventDefault(); } });
    wc.on('will-redirect', (event, url) => { try { safeURL(url); } catch { event.preventDefault(); } });
    wc.setWindowOpenHandler(({ url }) => {
      try { window.webContents.send('workspace-browser-event', { id, openUrl: safeURL(url) }); } catch { /* Unsupported external protocols stay blocked. */ }
      return { action: 'deny' };
    });
    wc.on('context-menu', (_event, params) => {
      const template = [];
      if (params.isEditable) template.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
      else if (params.selectionText) template.push({ role: 'copy' });
      if (params.linkURL) template.push({ label: 'Open link in new tab', click: () => { try { window.webContents.send('workspace-browser-event', { id, openUrl: safeURL(params.linkURL) }); } catch {} } });
      template.push({ label: 'Inspect element', click: () => wc.inspectElement(params.x, params.y) });
      Menu.buildFromTemplate(template).popup({ window });
    });
    return snapshot(entry);
  });
  ipcMain.handle('workspace-browser-command', (event, id, command, value) => {
    authorize(event);
    const entry = browsers.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) throw new Error('This browser tab is closed.');
    const wc = entry.view.webContents;
    const history = navigation(wc);
    if (command === 'navigate') { entry.error = ''; void wc.loadURL(safeURL(value)).catch(() => {}); }
    else if (command === 'back' && history.canGoBack()) history.goBack();
    else if (command === 'forward' && history.canGoForward()) history.goForward();
    else if (command === 'reload') { entry.error = ''; wc.reload(); }
    else if (command === 'stop') wc.stop();
    else if (command === 'inspect') wc.openDevTools({ mode: 'detach' });
    else if (command === 'focus') wc.focus();
    return snapshot(entry);
  });
  ipcMain.on('workspace-browser-bounds', (event, id, rect) => {
    let window;
    try { window = authorize(event); } catch { return; }
    const entry = browsers.get(id);
    if (!entry) return;
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) { hide(entry); return; }
    const zoom = window.webContents.getZoomFactor();
    const [width, height] = window.getContentSize();
    // Round inward: the native page must not paint over the DOM divider at
    // fractional application zoom or while the split pane is being resized.
    const x = Math.max(0, Math.min(width, Math.ceil(rect.x * zoom)));
    const y = Math.max(0, Math.min(height, Math.ceil(rect.y * zoom)));
    const right = Math.min(width, Math.floor((rect.x + rect.width) * zoom));
    const bottom = Math.min(height, Math.floor((rect.y + rect.height) * zoom));
    const bounds = { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
    if (bounds.width < 1 || bounds.height < 1) { hide(entry); return; }
    for (const other of browsers.values()) if (other !== entry) hide(other);
    entry.view.setBounds(bounds);
    if (!entry.attached) { window.contentView.addChildView(entry.view); entry.attached = true; }
  });
  ipcMain.handle('workspace-browser-close', (event, id) => { authorize(event); close(id); });
  ipcMain.handle('workspace-browser-menu', (event, id, anchor) => {
    const window = authorize(event);
    if (!browsers.has(id) || !anchor || ![anchor.x, anchor.y].every(Number.isFinite)) return null;
    // Native menus are composited above WebContentsView; the live page can
    // remain attached and continue drawing while the menu is open.
    return new Promise(resolve => {
      const items = [['chat', 'Side chat'], ['files', 'Files'], ['review', 'Review'], ['terminal', 'Terminal'], ['browser', 'Browser']];
      const popup = Menu.buildFromTemplate(items.map(([kind, label]) => ({ label, click: () => resolve(kind) })));
      const zoom = window.webContents.getZoomFactor();
      const [width, height] = window.getContentSize();
      popup.popup({ window, x: Math.max(0, Math.min(width - 1, Math.round(anchor.x * zoom))), y: Math.max(0, Math.min(height - 1, Math.round(anchor.y * zoom))), callback: () => resolve(null) });
    });
  });
  ipcMain.on('native-theme-set', (event, theme) => {
    try { authorize(event); } catch { return; }
    nativeTheme.themeSource = theme === 'light' ? 'light' : 'dark';
    for (const entry of browsers.values()) {
      entry.view.setBackgroundColor(theme === 'light' ? '#ffffff' : '#111111');
      const wc = entry.view.webContents;
      if (wc.isDestroyed()) continue;
      // YouTube's initial appearance can be baked into the document even when
      // Chromium's media preference changes. Update the page's DOM theme
      // marker in place, without navigating or changing account preferences.
      let host = '';
      try { host = new URL(wc.getURL()).hostname; } catch {}
      if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
        void wc.executeJavaScript(`document.documentElement.toggleAttribute('dark', ${theme !== 'light'}); document.documentElement.style.colorScheme = ${JSON.stringify(theme === 'light' ? 'light' : 'dark')};`).catch(() => {});
      }
    }
  });
  ipcMain.handle('workspace-browser-preview', async (event, id) => {
    authorize(event);
    const entry = browsers.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) return null;
    const screenshot = await entry.view.webContents.capturePage();
    return screenshot.isEmpty() ? null : screenshot.toDataURL();
  });
  ipcMain.handle('workspace-browser-capture', async (event, id) => {
    authorize(event);
    const entry = browsers.get(id);
    if (!entry || entry.view.webContents.isDestroyed() || !entry.view.webContents.getURL()) throw new Error('Open a page before taking a screenshot.');
    const screenshot = await entry.view.webContents.capturePage();
    if (screenshot.isEmpty()) throw new Error('The page has not finished drawing. Try again.');
    const directory = path.join(app.getPath('userData'), 'data', 'browser-captures');
    await fs.mkdir(directory, { recursive: true });
    const filename = `browser-${Date.now()}.png`;
    const filePath = path.join(directory, filename);
    await fs.writeFile(filePath, screenshot.toPNG());
    clipboard.writeImage(screenshot);
    return { filePath, filename, dataUrl: screenshot.toDataURL(), url: entry.view.webContents.getURL() };
  });
  const suggestionCache = new Map();
  ipcMain.handle('workspace-browser-suggest', async (event, id, query) => {
    authorize(event);
    if (!browsers.has(id)) return [];
    suggestionRequests.get(id)?.abort();
    const input = String(query || '').trim().slice(0, 160);
    if (input.length < 2 || /[/:\\]/.test(input)) return [];
    const cached = suggestionCache.get(input);
    if (cached && Date.now() - cached.at < 300000) return cached.items;
    const abort = new AbortController(); suggestionRequests.set(id, abort);
    const timer = setTimeout(() => abort.abort(), 2500);
    try {
      const response = await net.fetch(`https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(input)}`, { signal: abort.signal });
      if (!response.ok) return [];
      const result = await response.json();
      const items = Array.isArray(result[1]) ? result[1].filter(item => typeof item === 'string').slice(0, 6) : [];
      if (suggestionCache.size >= 100) suggestionCache.delete(suggestionCache.keys().next().value);
      suggestionCache.set(input, { at: Date.now(), items }); return items;
    } catch { return []; }
    finally { clearTimeout(timer); if (suggestionRequests.get(id) === abort) suggestionRequests.delete(id); }
  });
  app.on('will-quit', cleanup);
  require('./workspace-files').registerWorkspaceFiles({ ipcMain, app, getWindow, authorize });

  ipcMain.handle('workspace-folder-root', async (event, options = {}) => {
    authorize(event);
    const candidates = [options.workspacePath, ...(Array.isArray(options.candidates) ? options.candidates.slice(0, 24) : [])].filter(p => typeof p === 'string' && path.isAbsolute(p));
    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        let directory = stat.isDirectory() ? candidate : path.dirname(candidate);
        if (candidate === options.workspacePath) return directory;
        const fallback = directory;
        for (let depth = 0; depth < 10; depth++) {
          const markers = await Promise.all(['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', '.git'].map(name => fs.access(path.join(directory, name)).then(() => true, () => false)));
          if (markers.some(Boolean)) return directory;
          const parent = path.dirname(directory);
          if (parent === directory) break;
          directory = parent;
        }
        return fallback;
      } catch { /* Try the next path recorded by the agent. */ }
    }
    return os.homedir();
  });
  ipcMain.handle('workspace-folder-roots', (event, options) => {
    authorize(event);
    return require('./workspace-roots').resolveWorkspaceRoots(options);
  });
  ipcMain.handle('workspace-folder-list', async (event, directory, offset = 0, showHidden = false) => {
    authorize(event);
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Choose a folder first.');
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .filter(item => showHidden || (!item.name.startsWith('.') && !['node_modules', '__pycache__'].includes(item.name)))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    return { entries: entries.slice(start, start + 300).map(item => ({ name: item.name, path: path.join(directory, item.name), type: item.isDirectory() ? 'directory' : 'file' })), more: start + 300 < entries.length };
  });
};
