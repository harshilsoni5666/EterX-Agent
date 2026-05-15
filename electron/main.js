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
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
app.setName('EterX');
app.setAppUserModelId('EterX');

let mainWindow;
const DEFAULT_BOOT_TIMEOUT_MS = 120000;
const MIN_SPLASH_MS = 3600;
let activeBootId = 0;
let bootRetryTimer = null;

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
    backgroundColor: '#171717', // Match the EterX root black
    title: 'EterX', // Defines standard Task Manager/Taskbar labeling
    icon: path.join(__dirname, '../public/logo.png'), // Explicit application taskbar Favicon mapping
    titleBarStyle: 'hidden', // Provides the modern frame-less aesthetic while preserving OS buttons
    titleBarOverlay: {
      color: '#171717',
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
