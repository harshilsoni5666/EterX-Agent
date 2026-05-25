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
const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
// Disable HTTP Cache globally in development to prevent aggressive cache storage of stylesheets and scripts
app.commandLine.appendSwitch('disable-http-cache');
app.setName('EterX');
app.setAppUserModelId('EterX');

let mainWindow;
let petWindow;
let latestPetStatus = null;
const DEFAULT_BOOT_TIMEOUT_MS = 120000;
const MIN_SPLASH_MS = 3600;
let activeBootId = 0;
let bootRetryTimer = null;

function getPetWindowHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' data:; img-src 'self' data: file:; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
      body {
        display: grid;
        place-items: start;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #f2f0ec;
        user-select: none;
      }
      .card {
        position: relative;
        width: 372px;
        margin: 10px;
        border: 1px solid rgba(255,255,255,0.16);
        border-radius: 23px;
        background: rgba(23,23,23,0.965);
        box-shadow: 0 18px 54px rgba(0,0,0,0.36), inset 0 1px 0 rgba(255,255,255,0.055);
        backdrop-filter: blur(24px);
        -webkit-backdrop-filter: blur(24px);
        -webkit-app-region: drag;
        overflow: visible;
      }
      .compact { padding: 12px 16px; min-height: 92px; }
      .replying { padding: 12px; min-height: 156px; }
      .close {
        position: absolute;
        left: -8px;
        top: -8px;
        width: 32px;
        height: 32px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.16);
        background: #1f1f1f;
        color: rgba(255,255,255,0.72);
        display: grid;
        place-items: center;
        opacity: 0;
        transition: opacity 100ms ease, background 100ms ease, color 100ms ease;
        -webkit-app-region: no-drag;
      }
      .card:hover .close, .close:focus { opacity: 1; }
      .close:hover { background: #2a2a2a; color: white; }
      .head { display: flex; min-width: 0; align-items: flex-start; gap: 12px; }
      .copy { min-width: 0; flex: 1; }
      .title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: white;
        font-size: 20px;
        line-height: 24px;
        font-weight: 650;
        letter-spacing: 0;
      }
      .preview {
        margin-top: 4px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        color: #f2f0ec;
        font-size: 18px;
        line-height: 24px;
        font-weight: 500;
      }
      .hover-status {
        display: none;
        margin-top: 4px;
        color: #f2f0ec;
        font-size: 18px;
        line-height: 24px;
        font-weight: 500;
      }
      .card:hover:not(.replying) .preview { display: none; }
      .card:hover:not(.replying) .hover-status { display: block; }
      .spinner {
        width: 15px;
        height: 15px;
        margin-top: 5px;
        flex: 0 0 auto;
        border-radius: 999px;
        border: 2px solid rgba(255,255,255,0.35);
        border-top-color: white;
        animation: spin 0.82s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .reply-open {
        position: absolute;
        right: 16px;
        bottom: 12px;
        display: none;
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 999px;
        background: rgba(255,255,255,0.055);
        color: #e8e5df;
        padding: 6px 16px;
        font-size: 15px;
        font-weight: 500;
        -webkit-app-region: no-drag;
      }
      .card:hover:not(.replying) .reply-open { display: block; }
      .reply-open:hover { background: rgba(255,255,255,0.10); color: white; }
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
      <button id="close" class="close" type="button" aria-label="Close">×</button>
      <div class="head">
        <div class="copy">
          <div id="title" class="title">EterX agent</div>
          <div id="preview" class="preview">Thinking</div>
          <div class="hover-status">Thinking</div>
        </div>
        <div class="spinner" aria-hidden="true"></div>
      </div>
      <button id="replyOpen" class="reply-open" type="button">Reply</button>
      <div class="reply-area">
        <div class="reply-row">
          <input id="replyInput" placeholder="Reply" />
          <button id="replySend" class="send" type="button" disabled>Reply</button>
        </div>
      </div>
    </section>
    <script>
      const card = document.getElementById('card');
      const title = document.getElementById('title');
      const preview = document.getElementById('preview');
      const replyOpen = document.getElementById('replyOpen');
      const replyInput = document.getElementById('replyInput');
      const replySend = document.getElementById('replySend');
      let status = { title: 'EterX agent', text: 'Thinking', isThinking: true };

      function render(next) {
        status = { ...status, ...(next || {}) };
        title.textContent = status.title || 'EterX agent';
        preview.textContent = status.text || 'Thinking';
      }

      function setReplyOpen(open) {
        card.classList.toggle('replying', open);
        card.classList.toggle('compact', !open);
        if (open) setTimeout(() => replyInput.focus(), 0);
      }

      function sendReply() {
        const message = replyInput.value.trim();
        if (!message) return;
        window.electronAPI.petReply(message);
        replyInput.value = '';
        replySend.disabled = true;
        setReplyOpen(false);
      }

      document.getElementById('close').addEventListener('click', () => window.electronAPI.closePetWindow());
      replyOpen.addEventListener('click', () => setReplyOpen(true));
      replySend.addEventListener('click', sendReply);
      replyInput.addEventListener('input', () => { replySend.disabled = !replyInput.value.trim(); });
      replyInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); sendReply(); }
        if (event.key === 'Escape') { event.preventDefault(); setReplyOpen(false); }
      });

      window.electronAPI.onPetStatus(render);
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
        background: #101010;
        color: #f1f1f1;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(440px, calc(100vw - 48px));
        padding: 28px;
        border: 1px solid #262626;
        border-radius: 22px;
        background: #151515;
        box-shadow: 0 24px 70px rgba(0, 0, 0, 0.44);
      }
      h1 { margin: 0 0 10px; font-size: 22px; line-height: 1.15; }
      p { margin: 0; color: #b8b8b8; line-height: 1.55; }
      code { color: #e2e2e2; word-break: break-all; }
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

  await mainWindow.loadFile(path.join(__dirname, 'splash.html'));
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

async function openPetWindow(status) {
  sendPetStatus(status);

  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.show();
    petWindow.setAlwaysOnTop(true, 'screen-saver');
    sendPetStatus(latestPetStatus);
    return;
  }

  const workArea = screen.getPrimaryDisplay().workArea;
  petWindow = new BrowserWindow({
    width: 392,
    height: 182,
    x: Math.max(workArea.x + 8, workArea.x + workArea.width - 420),
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
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0F0F0F', // Match the EterX root black
    title: 'EterX', // Defines standard Task Manager/Taskbar labeling
    icon: path.join(__dirname, '../public/logo.png'), // Explicit application taskbar Favicon mapping
    titleBarStyle: 'hidden', // Provides the modern frame-less aesthetic while preserving OS buttons
    titleBarOverlay: {
      color: '#0F0F0F',
      symbolColor: '#d1d1d1',
      height: 38
    },
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
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

ipcMain.handle('pet-window-open', async (_event, status) => {
  await openPetWindow(status);
});

ipcMain.on('pet-window-status', (_event, status) => {
  sendPetStatus(status);
});

ipcMain.on('pet-window-close', () => {
  closePetWindow();
});

ipcMain.on('pet-reply', (_event, message) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pet-reply', String(message || ''));
  }
});

app.on('ready', () => {
  const { session } = require('electron');
  
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
