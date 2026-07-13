const path = require('path');
const fs = require('fs');

// Attempt to read Google API Key from Next.js local environment variables to unlock Chromium's Speech Engine
try {
  const envPath = path.join(__dirname, '../.env.local');
  if (fs.existsSync(envPath)) {
    const envFile = fs.readFileSync(envPath, 'utf8');
    const match = envFile.match(/VITE_SEARCH_API_KEY_1=([^\n\r]+)/) || envFile.match(/GEMINI_API_KEY_1=([^\n\r]+)/) || envFile.match(/VITE_API_KEY=([^\n\r]+)/);
    if (match && match[1]) {
      process.env.GOOGLE_API_KEY = match[1].trim();
      process.env.GOOGLE_DEFAULT_CLIENT_ID = 'electron-dummy';
      process.env.GOOGLE_DEFAULT_CLIENT_SECRET = 'electron-dummy';
    }
  }
} catch (e) {
  console.warn('Could not inject Google API key for Web Speech:', e);
}

const http = require('http');
const https = require('https');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, dialog, shell, screen, Menu } = require('electron');
// Disable HTTP Cache globally in development to prevent aggressive cache storage of stylesheets and scripts
app.commandLine.appendSwitch('disable-http-cache');
app.setName('EterX');
app.setAppUserModelId('EterX');
Menu.setApplicationMenu(null);

let mainWindow;
let petWindow;
let latestPetStatus = null;
const DEFAULT_BOOT_TIMEOUT_MS = 120000;
const MIN_SPLASH_MS = 3600;
const DEFAULT_PET_WINDOW_SIZE = 'normal';
const PET_WINDOW_SIZES = {
  small: { width: 292, height: 90, replyHeight: 162 },
  normal: { width: 326, height: 100, replyHeight: 178 },
  large: { width: 384, height: 116, replyHeight: 198 },
};
let activeBootId = 0;
let bootRetryTimer = null;

const APP_ICON_PATH = path.join(__dirname, '../public/logo.png');
const NATIVE_THEME_FILE = 'eterx-native-theme.json';
const NATIVE_FRAME_HEIGHT = 38;
const nativeThemedWindows = new Set();

function normalizeNativeTheme(theme) {
  return theme === 'dark' ? 'dark' : 'light';
}

function nativeThemePath() {
  return path.join(app.getPath('userData'), NATIVE_THEME_FILE);
}

function readNativeTheme() {
  try {
    const raw = fs.readFileSync(nativeThemePath(), 'utf8');
    return normalizeNativeTheme(JSON.parse(raw)?.theme);
  } catch {
    return 'light';
  }
}

function writeNativeTheme(theme) {
  const safeTheme = normalizeNativeTheme(theme);
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(nativeThemePath(), JSON.stringify({ theme: safeTheme }, null, 2), 'utf8');
  } catch (error) {
    console.warn('[EterX] Failed to persist native theme:', error);
  }
  return safeTheme;
}

function nativeThemeColors(theme) {
  const safeTheme = normalizeNativeTheme(theme);
  if (safeTheme === 'dark') {
    return {
      background: '#0F0F0F',
      titleBar: '#0F0F0F',
      titleSymbol: '#D0C8C0',
    };
  }
  return {
    background: '#F7F7F5',
    titleBar: '#F7F7F5',
    titleSymbol: '#1F1F1D',
  };
}

function applyNativeThemeToWindow(targetWindow, colors) {
  if (!targetWindow || targetWindow.isDestroyed()) return;

  try {
    targetWindow.setBackgroundColor(colors.background);
    if (typeof targetWindow.setIcon === 'function') {
      targetWindow.setIcon(APP_ICON_PATH);
    }
    if (typeof targetWindow.setTitleBarOverlay === 'function') {
      targetWindow.setTitleBarOverlay({
        color: colors.titleBar,
        symbolColor: colors.titleSymbol,
        height: NATIVE_FRAME_HEIGHT,
      });
    }
  } catch (error) {
    console.warn('[EterX] Failed to apply native window theme:', error);
  }
}

function registerNativeThemedWindow(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) return;
  nativeThemedWindows.add(targetWindow);
  targetWindow.on('closed', () => nativeThemedWindows.delete(targetWindow));
  applyNativeThemeToWindow(targetWindow, nativeThemeColors(readNativeTheme()));
}

function applyNativeWindowTheme(theme) {
  const safeTheme = writeNativeTheme(theme);
  const colors = nativeThemeColors(safeTheme);

  const windows = new Set(nativeThemedWindows);
  if (mainWindow && !mainWindow.isDestroyed()) windows.add(mainWindow);
  windows.forEach((targetWindow) => applyNativeThemeToWindow(targetWindow, colors));

  return safeTheme;
}

function applySplashWindowTheme(theme = readNativeTheme()) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const colors = nativeThemeColors(theme);

  try {
    mainWindow.setBackgroundColor(colors.background);
    if (typeof mainWindow.setTitleBarOverlay === 'function') {
      mainWindow.setTitleBarOverlay({
        color: colors.titleBar,
        symbolColor: colors.titleSymbol,
        height: NATIVE_FRAME_HEIGHT,
      });
    }
  } catch (error) {
    console.warn('[EterX] Failed to apply splash theme:', error);
  }
}

function getPetWindowHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' data:; img-src 'self' data: file:; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
    <style>
      * { box-sizing: border-box; }
      html, body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: rgba(0,0,0,0) !important;
      }
      body {
        display: block;
        padding: 0;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #f2f0ec;
        user-select: none;
        -webkit-app-region: drag;
      }
      .card {
        position: relative;
        width: 100%;
        height: 100vh;
        min-height: 100vh;
        margin: 0;
        border: 1px solid rgba(255,255,255,0.16);
        border-radius: 24px;
        background: rgba(23,23,23,0.965);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.055);
        -webkit-app-region: drag;
        overflow: hidden;
      }
      .compact { padding: 13px 16px 35px; }
      .replying { padding: 11px; }
      .hover-controls,
      .size-controls {
        position: absolute;
        z-index: 5;
        display: flex;
        gap: 6px;
        opacity: 0;
        pointer-events: none;
        transform: translateY(3px);
        transition: opacity 120ms ease, transform 120ms ease;
        -webkit-app-region: no-drag;
      }
      .hover-controls { right: 10px; bottom: 8px; }
      .size-controls { left: 10px; bottom: 8px; }
      .card:hover .hover-controls,
      .card:hover .size-controls,
      body.hovering .hover-controls,
      body.hovering .size-controls,
      .hover-controls:focus-within,
      .size-controls:focus-within {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0);
      }
      .control {
        height: 27px;
        min-width: 30px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.075);
        color: #ece9e3;
        padding: 0 10px;
        font-size: 13px;
        font-weight: 650;
        -webkit-app-region: no-drag;
      }
      .control:hover,
      .control:focus {
        background: rgba(255,255,255,0.14);
        color: #fff;
        outline: none;
      }
      .control:disabled {
        opacity: 0.38;
      }
      .replying #replyOpen { display: none; }
      .size-control { width: 30px; padding: 0; font-size: 18px; line-height: 1; }
      .head { display: flex; min-width: 0; align-items: flex-start; gap: 10px; }
      .copy { min-width: 0; flex: 1; }
      .preview {
        margin: 0;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        color: #f2f0ec;
        padding-right: 25px;
        font-size: 16px;
        line-height: 21px;
        font-weight: 700;
      }
      .hover-status {
        display: none;
        margin: 0;
        color: #f2f0ec;
        padding-right: 25px;
        font-size: 16px;
        line-height: 21px;
        font-weight: 700;
      }
      .preview, .hover-status {
        background:
          linear-gradient(102deg, transparent 0%, transparent 44%, #FFFFFF 50%, #FFFFFF 56%, transparent 62%, transparent 100%),
          linear-gradient(#9A9A98, #9A9A98);
        background-size: 245% 100%, 100% 100%;
        background-position: 260% 50%, 0 0;
        background-repeat: no-repeat, no-repeat;
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
        -webkit-text-fill-color: transparent;
        animation: petShimmer 8.4s cubic-bezier(.4, 0, .12, 1) infinite;
      }
      .card:hover:not(.replying) .preview,
      body.hovering .card:not(.replying) .preview { display: none; }
      .card:hover:not(.replying) .hover-status,
      body.hovering .card:not(.replying) .hover-status { display: block; }
      .spinner {
        position: absolute;
        right: 16px;
        top: 15px;
        width: 15px;
        height: 15px;
        border-radius: 999px;
        border: 2px solid rgba(255,255,255,0.35);
        border-top-color: white;
        animation: spin 0.82s linear infinite;
        transition: opacity 120ms ease;
      }
      .card:hover:not(.replying) .spinner,
      body.hovering .card:not(.replying) .spinner { opacity: 0; }
      .idle .spinner { display: none; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes petShimmer {
        0% { background-position: 260% 50%, 0 0; }
        28% { background-position: 260% 50%, 0 0; }
        74% { background-position: -260% 50%, 0 0; }
        100% { background-position: -260% 50%, 0 0; }
      }
      .reply-area {
        display: none;
        margin-top: 12px;
        border-top: 1px solid rgba(255,255,255,0.08);
        padding-top: 12px;
        -webkit-app-region: no-drag;
      }
      .replying .reply-area { display: block; }
      .reply-row { display: flex; align-items: center; gap: 8px; }
      input {
        min-width: 0;
        flex: 1;
        height: 40px;
        border-radius: 10px;
        border: 1px solid rgba(110,168,255,0.70);
        background: #151515;
        color: white;
        padding: 0 12px;
        font: inherit;
        font-size: 15px;
        font-weight: 500;
        outline: none;
        user-select: text;
      }
      input::placeholder { color: #8c8984; }
      .send {
        height: 40px;
        border: 0;
        border-radius: 999px;
        background: #b8b4ac;
        color: #202020;
        padding: 0 16px;
        font-size: 15px;
        font-weight: 650;
      }
      .send:disabled { opacity: 0.45; }
      button { cursor: default; font: inherit; }
    </style>
  </head>
  <body>
    <section id="card" class="card compact">
      <div class="head">
        <div class="copy">
          <div id="preview" class="preview">Thinking</div>
          <div class="hover-status">Thinking</div>
        </div>
        <div class="spinner" aria-hidden="true"></div>
      </div>
      <div class="size-controls" aria-label="Pet size">
        <button id="sizeDown" class="control size-control" type="button" aria-label="Make pet smaller">-</button>
        <button id="sizeUp" class="control size-control" type="button" aria-label="Make pet larger">+</button>
      </div>
      <div class="hover-controls">
        <button id="cancel" class="control" type="button">Cancel</button>
        <button id="replyOpen" class="control" type="button">Reply</button>
      </div>
      <div class="reply-area">
        <div class="reply-row">
          <input id="replyInput" placeholder="Reply" />
          <button id="replySend" class="send" type="button" disabled>Reply</button>
        </div>
      </div>
    </section>
    <script>
      const card = document.getElementById('card');
      const preview = document.getElementById('preview');
      const hoverStatus = document.querySelector('.hover-status');
      const cancel = document.getElementById('cancel');
      const replyOpen = document.getElementById('replyOpen');
      const replyInput = document.getElementById('replyInput');
      const replySend = document.getElementById('replySend');
      const sizeDown = document.getElementById('sizeDown');
      const sizeUp = document.getElementById('sizeUp');
      const petSizes = ['small', 'normal', 'large'];
      let petSizeIndex = 1;
      let status = { text: 'Thinking', isThinking: true };

      function render(next) {
        status = { ...status, ...(next || {}) };
        preview.textContent = status.text || 'Thinking';
        hoverStatus.textContent = status.text || 'Thinking';
        card.classList.toggle('idle', status.isThinking === false);
      }

      function setHovering(isHovering) {
        document.body.classList.toggle('hovering', isHovering);
      }

      function setReplyOpen(open) {
        card.classList.toggle('replying', open);
        card.classList.toggle('compact', !open);
        window.electronAPI.resizePetWindow?.({ size: petSizes[petSizeIndex], replying: open });
        if (open) setTimeout(() => replyInput.focus(), 0);
      }

      function setPetSize(delta) {
        petSizeIndex = Math.max(0, Math.min(petSizes.length - 1, petSizeIndex + delta));
        const size = petSizes[petSizeIndex];
        document.body.dataset.petSize = size;
        sizeDown.disabled = petSizeIndex === 0;
        sizeUp.disabled = petSizeIndex === petSizes.length - 1;
        window.electronAPI.resizePetWindow?.({ size, replying: card.classList.contains('replying') });
      }

      function sendReply() {
        const message = replyInput.value.trim();
        if (!message) return;
        window.electronAPI.petReply(message);
        replyInput.value = '';
        replySend.disabled = true;
        setReplyOpen(false);
      }

      cancel.addEventListener('click', () => window.electronAPI.closePetWindow());
      replyOpen.addEventListener('click', () => setReplyOpen(true));
      sizeDown.addEventListener('click', () => setPetSize(-1));
      sizeUp.addEventListener('click', () => setPetSize(1));
      document.body.addEventListener('mouseenter', () => setHovering(true));
      document.body.addEventListener('mousemove', () => setHovering(true));
      document.body.addEventListener('mouseleave', () => setHovering(false));
      replySend.addEventListener('click', sendReply);
      replyInput.addEventListener('input', () => { replySend.disabled = !replyInput.value.trim(); });
      replyInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); sendReply(); }
        if (event.key === 'Escape') { event.preventDefault(); setReplyOpen(false); }
      });

      window.electronAPI.onPetStatus(render);
      setPetSize(0);
      render(status);
    </script>
  </body>
</html>`;
}

function getAppTarget() {
  if (process.env.ELECTRON_URL) return process.env.ELECTRON_URL;

  const packagedIndex = path.join(app.getAppPath(), 'out', 'index.html');
  if (app.isPackaged && fs.existsSync(packagedIndex)) {
    return pathToFileURL(packagedIndex).toString();
  }

  const port = process.env.ETERX_PORT || process.env.PORT || '3000';
  return `http://localhost:${port}`;
}

function isHttpTarget(target) {
  return /^https?:\/\//i.test(target);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestTarget(target, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const client = target.startsWith('https:') ? https : http;
    const req = client.get(target, (res) => {
      res.resume();
      resolve(res.statusCode && res.statusCode < 500);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });

    req.on('error', () => resolve(false));
  });
}

async function waitForHttpTarget(target) {
  const timeoutMs = Number(process.env.ETERX_BOOT_TIMEOUT_MS || DEFAULT_BOOT_TIMEOUT_MS);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await requestTarget(target)) return;
    await delay(450);
  }

  throw new Error(`App did not become ready within ${Math.round(timeoutMs / 1000)}s`);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function showStartupFailure(error, target) {
  if (!mainWindow) return;

  const failureTheme = readNativeTheme();
  const failureColors = failureTheme === 'dark'
    ? {
        page: '#101010',
        text: '#f1f1f1',
        panel: '#151515',
        border: '#262626',
        muted: '#b8b8b8',
        code: '#e2e2e2',
        shadow: '0 24px 70px rgba(0, 0, 0, 0.44)',
      }
    : {
        page: '#FAFAF8',
        text: '#1F1F1D',
        panel: '#FFFFFF',
        border: 'rgba(31, 31, 29, 0.12)',
        muted: '#77736C',
        code: '#516B8A',
        shadow: '0 24px 70px rgba(31, 31, 29, 0.12)',
      };

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>EterX startup</title>
    <style>
      html, body { height: 100%; }
      body {
        margin: 0;
        display: grid;
        place-items: center;
        background: ${failureColors.page};
        color: ${failureColors.text};
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(440px, calc(100vw - 48px));
        padding: 28px;
        border: 1px solid ${failureColors.border};
        border-radius: 22px;
        background: ${failureColors.panel};
        box-shadow: ${failureColors.shadow};
      }
      h1 { margin: 0 0 10px; font-size: 22px; line-height: 1.15; }
      p { margin: 0; color: ${failureColors.muted}; line-height: 1.55; }
      code { color: ${failureColors.code}; word-break: break-all; }
    </style>
  </head>
  <body>
    <main>
      <h1>EterX is still starting</h1>
      <p>Could not reach <code>${escapeHtml(target)}</code>.</p>
      <p>${escapeHtml(error.message || error)}</p>
    </main>
  </body>
</html>`;

  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function clearBootRetry() {
  if (!bootRetryTimer) return;
  clearTimeout(bootRetryTimer);
  bootRetryTimer = null;
}

async function showSplashScreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const theme = readNativeTheme();

  applySplashWindowTheme(theme);
  await mainWindow.loadFile(path.join(__dirname, 'splash.html'), {
    query: { theme },
  });
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
    mainWindow.show();
  }
}

async function playSplashExit() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const currentUrl = mainWindow.webContents.getURL();
  if (!currentUrl.includes('splash.html')) return;

  try {
    await mainWindow.webContents.executeJavaScript("document.body.classList.add('is-leaving'); true;", true);
    await delay(280);
  } catch {
    // Best-effort polish only. The app should still load if the splash page has already changed.
  }
}

function scheduleBootRetry(delayMs = 900) {
  if (bootRetryTimer || !mainWindow || mainWindow.isDestroyed()) return;

  bootRetryTimer = setTimeout(() => {
    bootRetryTimer = null;
    bootApp({ showSplash: true, retryOnFailure: true });
  }, delayMs);
}

function isSettingsUrl(url = '') {
  return /\/settings(?:[?#/]|$)/.test(url);
}

function sendPetStatus(status) {
  latestPetStatus = {
    title: String(status?.title || 'EterX agent').slice(0, 160),
    text: String(status?.text || 'Thinking').slice(0, 500),
    isThinking: status?.isThinking !== false,
  };

  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet-status', latestPetStatus);
  }
}

function getRoundedRectShape(width, height, radius = 24) {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const safeRadius = Math.min(Math.round(radius), Math.floor(safeWidth / 2), Math.floor(safeHeight / 2));
  const shape = [];

  for (let y = 0; y < safeHeight; y += 1) {
    const isTop = y < safeRadius;
    const isBottom = y >= safeHeight - safeRadius;
    let inset = 0;

    if (isTop || isBottom) {
      const distanceFromEdge = isTop ? safeRadius - y - 1 : y - (safeHeight - safeRadius);
      inset = Math.max(0, Math.ceil(safeRadius - Math.sqrt((safeRadius * safeRadius) - (distanceFromEdge * distanceFromEdge))));
    }

    shape.push({
      x: inset,
      y,
      width: Math.max(1, safeWidth - (inset * 2)),
      height: 1,
    });
  }

  return shape;
}

function applyPetWindowShape(width, height) {
  if (!petWindow || petWindow.isDestroyed() || typeof petWindow.setShape !== 'function') return;
  petWindow.setShape(getRoundedRectShape(width, height));
}

function resizePetWindow(options = {}) {
  if (!petWindow || petWindow.isDestroyed()) return;

  const requestedSize = typeof options?.size === 'string' ? options.size : DEFAULT_PET_WINDOW_SIZE;
  const size = PET_WINDOW_SIZES[requestedSize] ? requestedSize : DEFAULT_PET_WINDOW_SIZE;
  const preset = PET_WINDOW_SIZES[size];
  const nextHeight = options?.replying ? preset.replyHeight : preset.height;
  const currentBounds = petWindow.getBounds();
  const workArea = screen.getDisplayMatching(currentBounds).workArea;
  const rightEdge = currentBounds.x + currentBounds.width;
  const nextX = Math.min(
    Math.max(rightEdge - preset.width, workArea.x),
    workArea.x + workArea.width - preset.width
  );
  const nextY = Math.min(
    Math.max(currentBounds.y, workArea.y),
    workArea.y + workArea.height - nextHeight
  );

  petWindow.setBounds({
    x: nextX,
    y: nextY,
    width: preset.width,
    height: nextHeight,
  });
  applyPetWindowShape(preset.width, nextHeight);
}

async function openPetWindow(status) {
  sendPetStatus(status);

  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.show();
    petWindow.setAlwaysOnTop(true, 'screen-saver');
    sendPetStatus(latestPetStatus);
    return;
  }

  const workArea = screen.getPrimaryDisplay().workArea;
  const petSize = PET_WINDOW_SIZES[DEFAULT_PET_WINDOW_SIZE];
  petWindow = new BrowserWindow({
    width: petSize.width,
    height: petSize.height,
    x: Math.max(workArea.x + 8, workArea.x + workArea.width - petSize.width - 16),
    y: workArea.y + 84,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'EterX Pet',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  applyPetWindowShape(petSize.width, petSize.height);
  petWindow.setAlwaysOnTop(true, 'screen-saver');
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getPetWindowHtml())}`);
  petWindow.once('ready-to-show', () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    petWindow.showInactive();
    sendPetStatus(latestPetStatus);
  });
  petWindow.webContents.once('did-finish-load', () => sendPetStatus(latestPetStatus));
  petWindow.on('closed', () => {
    petWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pet-window-closed');
    }
  });
}

function closePetWindow() {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.close();
  }
  petWindow = null;
}

async function bootApp(options = {}) {
  const { showSplash = false, retryOnFailure = false } = options;
  const target = getAppTarget();
  const startedAt = Date.now();
  const bootId = ++activeBootId;

  clearBootRetry();

  try {
    if (showSplash) {
      await showSplashScreen();
    }

    if (isHttpTarget(target)) {
      await waitForHttpTarget(target);
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_SPLASH_MS) {
      await delay(MIN_SPLASH_MS - elapsed);
    }

    if (bootId === activeBootId && mainWindow && !mainWindow.isDestroyed()) {
      await playSplashExit();
      applyNativeWindowTheme(readNativeTheme());
      await mainWindow.loadURL(target);
    }
  } catch (error) {
    console.error('[EterX] Startup failed:', error);
    if (retryOnFailure && isHttpTarget(target)) {
      await showSplashScreen().catch(() => {});
      scheduleBootRetry(1200);
      return;
    }
    await showStartupFailure(error, target);
  }
}

function createWindow() {
  const initialNativeTheme = readNativeTheme();
  const initialNativeColors = nativeThemeColors(initialNativeTheme);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 400,
    minHeight: 400,
    backgroundColor: initialNativeColors.background,
    title: 'EterX',
    icon: APP_ICON_PATH,
    titleBarStyle: 'hidden', // Provides the modern frame-less aesthetic while preserving OS buttons
    titleBarOverlay: {
      color: initialNativeColors.titleBar,
      symbolColor: initialNativeColors.titleSymbol,
      height: NATIVE_FRAME_HEIGHT
    },
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  registerNativeThemedWindow(mainWindow);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAutoHideMenuBar(true);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const colors = nativeThemeColors(readNativeTheme());
    const settingsWindow = isSettingsUrl(url);

    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        minWidth: settingsWindow ? 900 : 400,
        minHeight: settingsWindow ? 620 : 400,
        backgroundColor: colors.background,
        title: settingsWindow ? 'Settings' : 'EterX',
        icon: APP_ICON_PATH,
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: colors.titleBar,
          symbolColor: colors.titleSymbol,
          height: NATIVE_FRAME_HEIGHT,
        },
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, 'preload.js'),
        },
      },
    };
  });

  mainWindow.webContents.on('did-create-window', (childWindow, details) => {
    registerNativeThemedWindow(childWindow);
    childWindow.setMenuBarVisibility(false);
    childWindow.setAutoHideMenuBar(true);
    if (isSettingsUrl(details?.url || '')) {
      childWindow.setTitle('Settings');
    }
  });

  // Clear session cache on boot to guarantee fresh asset loading
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.session.clearCache().catch((err) => {
      console.warn('[EterX] Failed to clear web contents session cache:', err);
    });
  }

  showSplashScreen()
    .then(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    })
    .catch((error) => {
      console.error('[EterX] Could not load startup screen:', error);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    });

  bootApp({ retryOnFailure: true });

  mainWindow.webContents.on('did-fail-load', (_event, _errorCode, _errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || !isHttpTarget(validatedURL || getAppTarget())) return;
    showSplashScreen()
      .then(() => scheduleBootRetry(900))
      .catch((error) => {
        console.error('[EterX] Could not restore startup screen:', error);
        scheduleBootRetry(900);
      });
  });

  // Handle Permissions (Microphone, Camera) automatically
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'audioCapture', 'videoCapture'];
    if (allowedPermissions.includes(permission)) {
      callback(true);
    } else {
      callback(false);
    }
  });

  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    const allowedPermissions = ['media', 'audioCapture', 'videoCapture'];
    return allowedPermissions.includes(permission);
  });

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

// IPC: Native folder dialog for Code view
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Project Folder'
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// IPC: Native files dialog
ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: 'Select Files to Pin'
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths;
});

// IPC: List folder contents for browsing
ipcMain.handle('list-folder', async (event, folderPath) => {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => {
        const full = path.join(folderPath, e.name);
        let isProject = false;
        try {
          const files = fs.readdirSync(full);
          isProject = files.some(f => ['package.json', 'Cargo.toml', 'go.mod', '.git', 'tsconfig.json', 'pyproject.toml'].includes(f));
        } catch {}
        return { name: e.name, path: full, isProject };
      })
      .sort((a, b) => (a.isProject === b.isProject ? a.name.localeCompare(b.name) : a.isProject ? -1 : 1));
  } catch { return []; }
});

// IPC: Get native OS file icon
ipcMain.handle('get-file-icon', async (event, filePath) => {
  try {
    if (!filePath) return null;
    const icon = await app.getFileIcon(filePath, { size: 'large' });
    return icon.toDataURL();
  } catch (err) {
    console.error('Failed to get file icon:', err);
    return null;
  }
});

// IPC: Convert DOCX to PDF using local Word COM Automation
ipcMain.handle('convert-docx-to-pdf', async (event, docxPath) => {
  return new Promise((resolve) => {
    try {
      if (!docxPath || !fs.existsSync(docxPath)) {
        return resolve(null);
      }
      const tempPdfPath = path.join(app.getPath('temp'), `docx_preview_${Date.now()}.pdf`);
      const escapedDocx = docxPath.replace(/'/g, "''");
      const escapedPdf = tempPdfPath.replace(/'/g, "''");
      
      const psCommand = `$word = New-Object -ComObject Word.Application; $word.Visible = $false; try { $doc = $word.Documents.Open('${escapedDocx}', $true, $true); $doc.SaveAs('${escapedPdf}', 17); $doc.Close(); } finally { $word.Quit(); }`;
      
      const { exec } = require('child_process');
      exec(`powershell.exe -NoProfile -NonInteractive -Command "${psCommand.replace(/"/g, '\\"')}"`, (err, stdout, stderr) => {
        if (err) {
          console.error('Failed to convert docx to pdf via PowerShell:', err, stderr);
          return resolve(null);
        }
        if (fs.existsSync(tempPdfPath)) {
          resolve(tempPdfPath);
        } else {
          resolve(null);
        }
      });
    } catch (err) {
      console.error('Error during docx conversion:', err);
      resolve(null);
    }
  });
});


// IPC: Native System Notifications
ipcMain.handle('show-notification', (event, title, body) => {
  const { Notification } = require('electron');
  if (Notification.isSupported()) {
    new Notification({
      title,
      body,
    }).show();
  }
});

// IPC: Open URL in system default browser
ipcMain.handle('open-external', async (event, url) => {
  await shell.openExternal(url);
});

ipcMain.handle('native-theme-get', () => readNativeTheme());

ipcMain.on('native-theme-set', (_event, theme) => {
  applyNativeWindowTheme(theme);
});

ipcMain.handle('pet-window-open', async (_event, status) => {
  await openPetWindow(status);
});

ipcMain.on('pet-window-status', (_event, status) => {
  sendPetStatus(status);
});

ipcMain.on('pet-window-close', () => {
  closePetWindow();
});

ipcMain.on('pet-window-resize', (_event, options) => {
  resizePetWindow(options);
});

ipcMain.on('pet-reply', (_event, message) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pet-reply', String(message || ''));
  }
});

app.on('ready', () => {
  const { session } = require('electron');
  Menu.setApplicationMenu(null);
  
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'microphone', 'audioCapture', 'notifications'];
    if (allowedPermissions.includes(permission)) {
      callback(true);
    } else {
      callback(false);
    }
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const allowedPermissions = ['media', 'microphone', 'audioCapture', 'notifications'];
    if (allowedPermissions.includes(permission)) {
      return true;
    }
    return false;
  });

  createWindow();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', function () {
  if (mainWindow === null) {
    createWindow();
  }
});
