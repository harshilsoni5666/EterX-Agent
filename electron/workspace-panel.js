const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { dataRoot } = require('./storage-layout');

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
  const { BrowserWindow, WebContentsView, session, Menu, nativeTheme, clipboard, net, desktopCapturer, systemPreferences } = require('electron');
  const browsers = new Map();
  const suggestionRequests = new Map();
  let browserSession;
  let observedWindow;
  const authorize = event => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Workspace access is unavailable.');
    return window;
  };
  ipcMain.handle('workbench-window-sources', async event => {
    authorize(event);
    if (process.platform === 'darwin' && ['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('screen'))) {
      throw new Error('Allow EterX in macOS System Settings under Privacy & Security → Screen Recording, then reopen the workbench.');
    }
    const ownWindows = new Set(BrowserWindow.getAllWindows().map(window => window.getMediaSourceId?.()?.split(':').slice(0, 2).join(':')));
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    return sources.filter(source => source.id.startsWith('window:') && !ownWindows.has(source.id.split(':').slice(0, 2).join(':')))
      .slice(0, 100).map(source => ({ id: source.id, name: source.name }));
  });
  const safeURL = input => {
    const value = String(input || '').trim();
    if (value === 'about:blank') return value;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Enter an HTTP or HTTPS address.');
    return url.href;
  };
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
  const previewUrl = (input, window) => {
    const url = new URL(safeURL(input));
    const application = new URL(window.webContents.getURL());
    const port = value => value.port || (value.protocol === 'https:' ? '443' : '80');
    if (!loopback.has(url.hostname) || url.username || url.password || port(url) === port(application)) {
      throw new Error('Choose a development service on a separate local port.');
    }
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
  function prepare(window, development, id) {
    let browsing = development ? undefined : browserSession;
    if (!browsing) {
      browsing = session.fromPartition(development ? 'eterx-development-' + id : 'persist:eterx-workspace-browser');
      browsing.setPermissionCheckHandler(() => false);
      browsing.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      if (!development) browserSession = browsing;
      // Chromium/Electron owns the native Save dialog for downloads.
    }
    if (observedWindow !== window) {
      observedWindow = window;
      window.webContents.once('destroyed', cleanup);
      window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) cleanup(); });
    }
    return browsing;
  }
  function applyEmulation(entry) {
    const wc = entry.view.webContents;
    const metrics = entry.emulation;
    const bounds = entry.previewBounds;
    if (!metrics) {
      if (entry.emulationKey) { wc.disableDeviceEmulation(); entry.emulationKey = ''; }
      return;
    }
    if (!bounds) return;
    const scale = Math.min(1, bounds.width / metrics.width, bounds.height / metrics.height);
    const key = [metrics.width, metrics.height, scale].join(':');
    if (entry.emulationKey === key) return;
    wc.enableDeviceEmulation({ screenPosition: 'mobile', screenSize: metrics, viewSize: metrics, deviceScaleFactor: 1, scale });
    entry.emulationKey = key;
  }
  ipcMain.handle('workspace-browser-create', (event, id, theme = 'dark', developmentPreview = false) => {
    const window = authorize(event);
    if (typeof id !== 'string' || id.length > 160) throw new Error('Invalid browser tab.');
    if (browsers.has(id)) return snapshot(browsers.get(id));
    if (browsers.size >= 12) throw new Error('Close a browser tab before opening another (12 tabs maximum).');
    const browsing = prepare(window, developmentPreview === true, id);
    nativeTheme.themeSource = theme === 'light' ? 'light' : 'dark';
    const view = new WebContentsView({ webPreferences: { session: browsing, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: true, navigateOnDragDrop: false } });
    const entry = { id, view, attached: false, error: '', developmentPreview: developmentPreview === true };
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
      // Target the page explicitly: menu roles can act on the host renderer
      // after a native popup takes focus away from a WebContentsView.
      const editItem = (label, method, enabled = true) => ({ label, enabled, click: () => { if (!wc.isDestroyed()) wc[method](); } });
      if (params.isEditable) template.push(editItem('Undo', 'undo', params.editFlags.canUndo), editItem('Redo', 'redo', params.editFlags.canRedo), { type: 'separator' }, editItem('Cut', 'cut', params.editFlags.canCut), editItem('Copy', 'copy', params.editFlags.canCopy), editItem('Paste', 'paste', params.editFlags.canPaste), editItem('Select all', 'selectAll'));
      else if (params.selectionText) template.push(editItem('Copy', 'copy'));
      if (params.linkURL) template.push({ label: 'Open link in new tab', click: () => { try { window.webContents.send('workspace-browser-event', { id, openUrl: safeURL(params.linkURL) }); } catch {} } });
      if (params.linkURL) template.push({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
      if (params.srcURL && params.mediaType === 'image') template.push({ label: 'Save image as…', click: () => { if (!wc.isDestroyed()) wc.downloadURL(params.srcURL); } });
      template.push({ label: 'Inspect element', click: () => wc.inspectElement(params.x, params.y) });
      Menu.buildFromTemplate(template).popup({ window });
    });
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const primary = process.platform === 'darwin' ? input.meta : input.control;
      const key = input.key.toLowerCase();
      if (primary && !input.alt && key === 'l') {
        event.preventDefault(); window.webContents.focus();
        window.webContents.send('workspace-browser-event', { id, focusAddress: true });
      } else if ((primary && !input.alt && key === 'r') || key === 'f5') {
        event.preventDefault(); entry.error = '';
        if (input.shift) wc.reloadIgnoringCache(); else wc.reload();
      } else if (input.alt && !primary && (key === 'arrowleft' || key === 'arrowright')) {
        event.preventDefault();
        const history = navigation(wc);
        if (key === 'arrowleft' && history.canGoBack()) history.goBack();
        if (key === 'arrowright' && history.canGoForward()) history.goForward();
      }
    });
    return snapshot(entry);
  });
  ipcMain.handle('workspace-browser-command', (event, id, command, value) => {
    authorize(event);
    const entry = browsers.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) throw new Error('This browser tab is closed.');
    const wc = entry.view.webContents;
    const history = navigation(wc);
    if (command === 'navigate') {
      const url = safeURL(value);
      entry.error = '';
      entry.requestedUrl = url;
      void wc.loadURL(url).catch(() => {});
    }
    else if (command === 'back' && history.canGoBack()) history.goBack();
    else if (command === 'forward' && history.canGoForward()) history.goForward();
    else if (command === 'reload') { entry.error = ''; wc.reload(); }
    else if (command === 'stop') wc.stop();
    else if (command === 'inspect') wc.openDevTools({ mode: 'detach' });
    else if (command === 'focus') wc.focus();
    else if (command === 'emulate' && entry.developmentPreview) {
      if (value !== null && (!value || ![value.width, value.height].every(size => Number.isInteger(size) && size >= 280 && size <= 1400))) throw new Error('Unsupported preview viewport.');
      entry.emulation = value;
      applyEmulation(entry);
    }
    return snapshot(entry);
  });
  const previewKeys = {
    Tab: 'Tab', Enter: 'Enter', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Space: 'Space',
  };
  ipcMain.handle('workbench-preview-action', async (event, id, action) => {
    const window = authorize(event);
    const entry = browsers.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) return { success: false, error: 'The preview is starting.' };
    if (!entry.developmentPreview || !action || typeof action !== 'object') return { success: false, error: 'Select a development preview first.' };
    const wc = entry.view.webContents;
    try {
      if (action.kind === 'navigate') {
        const url = previewUrl(action.url, window);
        entry.error = '';
        entry.requestedUrl = url;
        void wc.loadURL(url).catch(() => {});
        return { success: true, url, loading: true, actionStatus: 'sent' };
      }
      const current = wc.getURL();
      const committed = current && current !== 'about:blank';
      const destination = committed ? current : entry.requestedUrl;
      if (!destination) return { success: false, error: 'The preview is starting.' };
      const url = previewUrl(destination, window);
      if (entry.error && !['status', 'reload'].includes(action.kind)) throw new Error(String(entry.error));
      const state = { url: url.slice(0, 4096), title: wc.getTitle().slice(0, 500), loading: wc.isLoading() };
      if (action.kind === 'status') {
        return entry.error ? { success: false, ...state, error: String(entry.error).slice(0, 1200) } : { success: true, ...state };
      }
      if (action.kind === 'reload') {
        entry.error = '';
        if (committed) wc.reload();
        else void wc.loadURL(url).catch(() => {});
        return { success: true, ...state, loading: true, actionStatus: 'sent' };
      }
      if (!entry.attached || !committed) return { success: false, error: 'The preview is starting.' };
      if (action.kind === 'snapshot') {
        const frame = await wc.capturePage();
        if (frame.isEmpty()) throw new Error('The preview has not drawn a frame yet.');
        if (wc.getURL() !== current || !entry.attached) throw new Error('The visible preview changed while capturing. Observe the selected tab again.');
        const { width, height } = frame.getSize();
        const image = Math.max(width, height) <= 1150 ? frame : frame.resize(width >= height ? { width: 1150 } : { height: 1150 });
        return { success: true, ...state, vision: { inlineData: { data: image.toJPEG(74).toString('base64'), mimeType: 'image/jpeg' } } };
      }
      if (!window.isFocused()) throw new Error('Focus the EterX window before sending input to its live preview.');
      if (action.kind === 'type') {
        if (typeof action.text !== 'string' || !action.text || action.text.length > 600 || action.text.includes('\0')) throw new Error('Invalid preview text.');
        wc.focus();
        await wc.insertText(action.text);
      } else if (action.kind === 'key') {
        if (!Object.hasOwn(previewKeys, action.key)) throw new Error('Unsupported preview key.');
        const keyCode = previewKeys[action.key];
        wc.focus();
        wc.sendInputEvent({ type: 'keyDown', keyCode });
        wc.sendInputEvent({ type: 'keyUp', keyCode });
      } else if (action.kind === 'click' || action.kind === 'scroll') {
        if (![action.x, action.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error('Use preview coordinates from 0 to 1.');
        const bounds = entry.previewBounds;
        if (!bounds) throw new Error('The visible preview is unavailable.');
        const x = Math.round(action.x * (bounds.width - 1));
        const y = Math.round(action.y * (bounds.height - 1));
        if (action.kind === 'scroll') {
          if (!Number.isInteger(action.deltaY) || Math.abs(action.deltaY) > 1600) throw new Error('Invalid scroll distance.');
          wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaY: -action.deltaY, canScroll: true });
        } else {
          wc.focus();
          wc.sendInputEvent({ type: 'mouseMove', x, y });
          wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
          wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        }
      } else {
        throw new Error('Unsupported preview action.');
      }
      return { success: true, ...state, actionStatus: 'sent' };
    } catch (error) {
      return { success: false, error: String(error?.message || error).slice(0, 1200) };
    }
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
    if (entry.developmentPreview) { entry.previewBounds = bounds; applyEmulation(entry); }
    if (!entry.attached) { window.contentView.addChildView(entry.view); entry.attached = true; }
  });
  ipcMain.handle('workspace-browser-close', (event, id) => { authorize(event); close(id); });
  ipcMain.handle('workspace-browser-menu', (event, id, anchor) => {
    const window = authorize(event);
    if (!browsers.has(id) || !anchor || ![anchor.x, anchor.y].every(Number.isFinite)) return null;
    // Native menus are composited above WebContentsView; the live page can
    // remain attached and continue drawing while the menu is open.
    return new Promise(resolve => {
      const items = [['workbench', 'Workbench'], ['chat', 'Side chat'], ['subagents', 'Sub-Agents'], ['files', 'Files'], ['review', 'Review'], ['terminal', 'Terminal'], ['browser', 'Browser']];
      if (anchor.gitEnabled === true) items.splice(5, 0, ['git', 'Git']);
      if (anchor.planAvailable === true) items.push(['plan', 'Plan']);
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
    const directory = path.join(dataRoot(), 'browser-captures');
    await fs.mkdir(directory, { recursive: true });
    const filename = `browser-${Date.now()}-${randomUUID()}.png`;
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
    const items = (await fs.readdir(directory, { withFileTypes: true }))
      .filter(item => showHidden || (!item.name.startsWith('.') && !['node_modules', '__pycache__'].includes(item.name)));
    const entries = await Promise.all(items.map(async item => {
      const filePath = path.join(directory, item.name);
      // stat follows Unix symlinks and Windows directory junctions. Broken
      // links remain visible as files so one link cannot break the listing.
      const isDirectory = item.isDirectory() || (item.isSymbolicLink() && await fs.stat(filePath).then(stat => stat.isDirectory(), () => false));
      return { name: item.name, path: filePath, type: isDirectory ? 'directory' : 'file' };
    }));
    entries.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name, undefined, { numeric: true }));
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    return { entries: entries.slice(start, start + 300), more: start + 300 < entries.length };
  });
};
