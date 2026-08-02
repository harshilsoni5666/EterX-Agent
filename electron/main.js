const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

function logToFile(msg) {
  try {
    const logPath = path.join(app.getPath('userData'), 'eterx-desktop.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch (e) { }
}

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
const { app, BrowserWindow, ipcMain, dialog, shell, screen, desktopCapturer, Menu, nativeImage, safeStorage, Tray } = require('electron');
const { GatewayDaemon, DEFAULT_CONFIG: DEFAULT_GATEWAY_CONFIG, mergeConfig: normalizeGatewayConfig } = require('../src/lib/agent/gateways/daemon.cjs');
// Disable HTTP Cache globally in development to prevent aggressive cache storage of stylesheets and scripts
app.commandLine.appendSwitch('disable-http-cache');
app.setName('EterX');

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

// Keep installed-app state out of the source folder, Desktop, and roaming
// profile. Local AppData is the standard Windows location for machine-local
// runtime copies, logs, cache, encrypted credentials, and agent work data.
const LEGACY_USER_DATA_PATH = app.getPath('userData');
if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
  const localUserData = path.join(process.env.LOCALAPPDATA, 'EterX');
  app.setPath('userData', localUserData);
  app.setPath('sessionData', path.join(localUserData, 'session'));
}
Menu.setApplicationMenu(null);

let mainWindow;
let petWindow;
let backgroundTray;
let gatewayDaemon;
let latestPetStatus = null;
const DEFAULT_BOOT_TIMEOUT_MS = 45000;
const MIN_SPLASH_MS = 3600;
const DEFAULT_PET_WINDOW_SIZE = 'normal';
const PET_WINDOW_SIZES = {
  small: { width: 292, height: 90, replyHeight: 162 },
  normal: { width: 326, height: 100, replyHeight: 178 },
  large: { width: 384, height: 116, replyHeight: 198 },
};
let activeBootId = 0;
let bootRetryTimer = null;
let bootFailureCount = 0;

// A production install runs its immutable Next.js server directly from the
// packaged application archive. AppData contains durable user state only.
let packagedRuntimeRoot = null;
let packagedServer = null;
let packagedServerUrl = null;
let isQuitting = false;
let desktopAutoUpdater = null;
let desktopUpdateCheckPromise = null;
let desktopUpdateState = {
  status: app.isPackaged ? 'idle' : 'development',
  currentVersion: app.getVersion(),
  availableVersion: null,
  percent: 0,
  message: app.isPackaged ? 'Ready to check for updates' : 'Updates are available in packaged builds',
  automaticChecks: false,
  manualInstall: true,
  lastCheckedAt: null,
};
const launchInBackground = process.argv.includes('--background');

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

const APP_ICON_PNG = app.isPackaged
  ? path.join(process.resourcesPath, 'logo.png')
  : path.join(__dirname, '../public/logo.png');

const APP_ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.ico')
  : (process.platform === 'win32' && fs.existsSync(path.join(__dirname, '../public/icon.ico'))
    ? path.join(__dirname, '../public/icon.ico')
    : APP_ICON_PNG);

const NATIVE_THEME_FILE = 'eterx-native-theme.json';
const SECURE_RUNTIME_SETTINGS_FILE = 'eterx-runtime-settings.bin';
const SECURE_GATEWAY_SETTINGS_FILE = 'eterx-gateway-settings.bin';
const SECURE_RUNTIME_SETTINGS_PROVIDERS = new Set([
  'gemini', 'mistral', 'openrouter', 'anthropic', 'openai', 'groq', 'deepseek', 'grok',
  'cerebras', 'together', 'fireworks', 'sambanova', 'perplexity', 'deepinfra',
  'huggingface', 'nvidia', 'cloudflare', 'ollama', 'lmstudio', 'vllm', 'llamacpp',
  'novita', 'qwen', 'mimo', 'tokenhub', 'zai', 'kimi', 'stepfun', 'minimax',
  'ollamacloud', 'arcee', 'gmi', 'kilo', 'opencode', 'upstage', 'custom',
  'tavily', 'github',
]);
const SECURE_RUNTIME_MODEL_PROVIDERS = new Set([
  ...SECURE_RUNTIME_SETTINGS_PROVIDERS,
]);
const DESKTOP_RUNTIME_SETTING_ENV_KEYS = new Set([
  'GEMINI_API_KEY',
  'MISTRAL_API_KEY',
  'MISTRAL_AI_API_KEY',
  'MISTRALAI_API_KEY',
  'OPENROUTER_API_KEY',
  'VITE_OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'CEREBRAS_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'SAMBANOVA_API_KEY',
  'PERPLEXITY_API_KEY',
  'DEEPINFRA_API_KEY',
  'HUGGINGFACE_API_KEY',
  'NVIDIA_API_KEY',
  'CLOUDFLARE_API_KEY',
  'OLLAMA_API_KEY',
  'LMSTUDIO_API_KEY',
  'VLLM_API_KEY',
  'LLAMACPP_API_KEY',
  'NOVITA_API_KEY',
  'DASHSCOPE_API_KEY',
  'MIMO_API_KEY',
  'TOKENHUB_API_KEY',
  'ZAI_API_KEY',
  'MOONSHOT_API_KEY',
  'STEPFUN_API_KEY',
  'MINIMAX_API_KEY',
  'OLLAMA_CLOUD_API_KEY',
  'ARCEE_API_KEY',
  'GMI_API_KEY',
  'KILO_API_KEY',
  'OPENCODE_API_KEY',
  'UPSTAGE_API_KEY',
  'CUSTOM_API_KEY',
  'TAVILY_API_KEY',
  'VITE_TAVILY_API_KEY',
  'GITHUB_TOKEN',
  'ETERX_THINK_MODEL',
  'GEMINI_THINK_MODEL',
  'MISTRAL_MODEL',
  'MISTRAL_MODEL_NAME',
  'OPENAI_MODEL',
  'OPENAI_MODEL_NAME',
  'OPENROUTER_MODEL',
  'OPENROUTER_MODEL_NAME',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_MODEL_NAME',
  'CLAUDE_MODEL',
  'GROQ_MODEL',
  'GROQ_MODEL_NAME',
  'DEEPSEEK_MODEL',
  'XAI_MODEL',
  'CEREBRAS_MODEL',
  'TOGETHER_MODEL',
  'FIREWORKS_MODEL',
  'SAMBANOVA_MODEL',
  'PERPLEXITY_MODEL',
  'DEEPINFRA_MODEL',
  'HUGGINGFACE_MODEL',
  'NVIDIA_MODEL',
  'CLOUDFLARE_MODEL',
  'OLLAMA_MODEL',
  'LMSTUDIO_MODEL',
  'VLLM_MODEL',
  'LLAMACPP_MODEL',
  'NOVITA_MODEL',
  'QWEN_MODEL',
  'MIMO_MODEL',
  'TOKENHUB_MODEL',
  'ZAI_MODEL',
  'KIMI_MODEL',
  'STEPFUN_MODEL',
  'MINIMAX_MODEL',
  'OLLAMA_CLOUD_MODEL',
  'ARCEE_MODEL',
  'GMI_MODEL',
  'KILO_MODEL',
  'OPENCODE_MODEL',
  'UPSTAGE_MODEL',
  'CUSTOM_MODEL',
]);
const NATIVE_FRAME_HEIGHT = 38;
const nativeThemedWindows = new Set();

function publishDesktopUpdateState(patch = {}) {
  desktopUpdateState = { ...desktopUpdateState, ...patch, currentVersion: app.getVersion() };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('desktop-update-state', desktopUpdateState);
  }
  logToFile(`[update] ${desktopUpdateState.status}: ${desktopUpdateState.message || ''}`);
  return desktopUpdateState;
}

function getPackagedDependencyModuleRoot() {
  const dependencyArchive = path.join(process.resourcesPath, 'runtime', 'dependencies.asar');
  if (!fs.existsSync(dependencyArchive)) return null;
  const nestedNodeModules = path.join(dependencyArchive, 'node_modules');
  return fs.existsSync(nestedNodeModules) ? nestedNodeModules : dependencyArchive;
}

async function performDesktopUpdateCheck() {
  if (!app.isPackaged || !desktopAutoUpdater) return desktopUpdateState;
  if (desktopUpdateCheckPromise) return desktopUpdateCheckPromise;
  if (desktopUpdateState.status === 'downloading' || desktopUpdateState.status === 'ready') {
    return desktopUpdateState;
  }

  desktopUpdateCheckPromise = (async () => {
    publishDesktopUpdateState({
      status: 'checking',
      percent: 0,
      message: 'Checking for updates...',
    });
    try {
      await desktopAutoUpdater.checkForUpdates();
      publishDesktopUpdateState({ lastCheckedAt: new Date().toISOString() });
    } catch (error) {
      publishDesktopUpdateState({
        status: 'error',
        lastCheckedAt: new Date().toISOString(),
        message: `Update check failed: ${error.message}`,
      });
    } finally {
      desktopUpdateCheckPromise = null;
    }
    return desktopUpdateState;
  })();
  return desktopUpdateCheckPromise;
}

function initializeDesktopUpdates() {
  if (!app.isPackaged) return publishDesktopUpdateState();
  try {
    try {
      ({ autoUpdater: desktopAutoUpdater } = require('electron-updater'));
    } catch {
      // The desktop server runtime already contains the production dependency
      // graph. Keeping the updater there avoids duplicating a second large
      // node_modules tree inside app.asar.
      const dependencyModuleRoot = getPackagedDependencyModuleRoot();
      if (dependencyModuleRoot) {
        process.env.NODE_PATH = [dependencyModuleRoot, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
        require('module').Module._initPaths();
      }
      const bundledUpdater = dependencyModuleRoot
        ? path.join(dependencyModuleRoot, 'electron-updater')
        : path.join(app.getAppPath(), 'runtime', 'modules', 'electron-updater');
      ({ autoUpdater: desktopAutoUpdater } = require(bundledUpdater));
    }
    desktopAutoUpdater.autoDownload = false;
    desktopAutoUpdater.autoInstallOnAppQuit = false;
    desktopAutoUpdater.allowDowngrade = false;
    desktopAutoUpdater.allowPrerelease = false;
    desktopAutoUpdater.fullChangelog = true;

    desktopAutoUpdater.on('checking-for-update', () => publishDesktopUpdateState({ status: 'checking', percent: 0, message: 'Checking for a newer EterX release…' }));
    desktopAutoUpdater.on('update-available', (info) => publishDesktopUpdateState({ status: 'available', availableVersion: info.version, percent: 0, message: `EterX ${info.version} is available` }));
    desktopAutoUpdater.on('update-not-available', () => publishDesktopUpdateState({ status: 'current', availableVersion: null, percent: 100, message: 'EterX is up to date', lastCheckedAt: new Date().toISOString() }));
    desktopAutoUpdater.on('download-progress', (progress) => publishDesktopUpdateState({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(progress.percent || 0))), message: `Downloading update — ${Math.round(progress.percent || 0)}%` }));
    desktopAutoUpdater.on('update-downloaded', (info) => {
      publishDesktopUpdateState({ status: 'ready', availableVersion: info.version, percent: 100, message: `EterX ${info.version} is ready - restart when convenient` });
      try {
        const { Notification } = require('electron');
        if (Notification.isSupported()) {
          new Notification({
            title: `EterX ${info.version} is ready`,
            body: 'Open Updates and choose Restart and install.',
          }).show();
        }
      } catch {}
    });
    desktopAutoUpdater.on('error', (error) => publishDesktopUpdateState({ status: 'error', percent: 0, message: `Update failed: ${error?.message || 'unknown error'}` }));

  } catch (error) {
    publishDesktopUpdateState({ status: 'error', message: `Updater unavailable: ${error.message}` });
  }
  return desktopUpdateState;
}

function normalizeNativeTheme(theme) {
  return theme === 'dark' ? 'dark' : 'light';
}

function nativeThemePath() {
  return path.join(app.getPath('userData'), NATIVE_THEME_FILE);
}

function getSplashIconDataUrl() {
  try {
    const icon = nativeImage.createFromPath(APP_ICON_PNG);
    return icon.isEmpty() ? '' : icon.toDataURL();
  } catch {
    return '';
  }
}

function secureRuntimeSettingsPath() {
  return path.join(app.getPath('userData'), SECURE_RUNTIME_SETTINGS_FILE);
}

function secureStorageAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function normalizeSecureRuntimeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const apiKeys = {};
  const modelApiKeys = {};
  const modelOverrides = {};

  for (const [provider, value] of Object.entries(source.apiKeys || {})) {
    if (!SECURE_RUNTIME_SETTINGS_PROVIDERS.has(provider) || typeof value !== 'string') continue;
    const key = value.trim();
    if (key && key.length <= 40_000) apiKeys[provider] = key;
  }

  for (const [modelKey, value] of Object.entries(source.modelApiKeys || {})) {
    const provider = String(modelKey || '').split('::', 1)[0];
    if (!SECURE_RUNTIME_SETTINGS_PROVIDERS.has(provider) || typeof value !== 'string') continue;
    const key = value.trim();
    if (key && key.length <= 40_000) modelApiKeys[modelKey] = key;
  }

  for (const [provider, value] of Object.entries(source.modelOverrides || {})) {
    if (!SECURE_RUNTIME_MODEL_PROVIDERS.has(provider) || typeof value !== 'string') continue;
    const model = value.trim();
    if (model && model.length <= 220 && !/[\r\n\t]/.test(model)) modelOverrides[provider] = model;
  }

  return { apiKeys, modelApiKeys, modelOverrides };
}

function readSecureRuntimeSettings() {
  if (!secureStorageAvailable()) return { available: false, apiKeys: {}, modelApiKeys: {}, modelOverrides: {} };

  try {
    const encrypted = fs.readFileSync(secureRuntimeSettingsPath());
    const decoded = safeStorage.decryptString(encrypted);
    return { available: true, ...normalizeSecureRuntimeSettings(JSON.parse(decoded)) };
  } catch {
    return { available: true, apiKeys: {}, modelApiKeys: {}, modelOverrides: {} };
  }
}

function writeSecureRuntimeSettings(raw) {
  if (!secureStorageAvailable()) {
    return { ok: false, available: false, error: 'OS secure storage is unavailable.' };
  }

  const settings = normalizeSecureRuntimeSettings(raw);
  const serialized = JSON.stringify(settings);
  const target = secureRuntimeSettingsPath();
  const temporary = `${target}.tmp-${process.pid}`;

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, safeStorage.encryptString(serialized), { mode: 0o600 });
    fs.rmSync(target, { force: true });
    fs.renameSync(temporary, target);
    return { ok: true, available: true, ...settings };
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { }
    return { ok: false, available: true, error: error?.message || 'Failed to save secure settings.' };
  }
}

function clearSecureRuntimeSettings() {
  try {
    fs.rmSync(secureRuntimeSettingsPath(), { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'Failed to clear secure settings.' };
  }
}

function secureGatewaySettingsPath() {
  return path.join(app.getPath('userData'), SECURE_GATEWAY_SETTINGS_FILE);
}

function readGatewaySettings() {
  if (!secureStorageAvailable()) return normalizeGatewayConfig(DEFAULT_GATEWAY_CONFIG);
  try {
    const encrypted = fs.readFileSync(secureGatewaySettingsPath());
    return normalizeGatewayConfig(JSON.parse(safeStorage.decryptString(encrypted)));
  } catch {
    return normalizeGatewayConfig(DEFAULT_GATEWAY_CONFIG);
  }
}

function writeGatewaySettings(raw) {
  if (!secureStorageAvailable()) {
    return { ok: false, error: 'OS secure storage is unavailable; gateway credentials were not saved.' };
  }
  const settings = normalizeGatewayConfig(raw);
  const target = secureGatewaySettingsPath();
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(settings)), { mode: 0o600 });
    fs.rmSync(target, { force: true });
    fs.renameSync(temporary, target);
    return { ok: true, settings };
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { }
    return { ok: false, error: error?.message || 'Failed to save gateway settings.' };
  }
}

function publishGatewayEvent(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
}

function ensureBackgroundTray() {
  if (backgroundTray || !gatewayDaemon?.config?.enabled || !gatewayDaemon?.config?.keepRunningOnClose) return;
  try {
    backgroundTray = new Tray(APP_ICON_PATH);
    backgroundTray.setToolTip('EterX background companion');
    backgroundTray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open EterX', click: showMainWindow },
      { label: 'Gateway status', enabled: false },
      { type: 'separator' },
      { label: 'Quit EterX', click: () => { isQuitting = true; app.quit(); } },
    ]));
    backgroundTray.on('double-click', showMainWindow);
  } catch (error) {
    console.warn('[EterX] Could not create background tray:', error?.message || error);
  }
}

function setGatewayLaunchAtLogin(enabled) {
  if (process.platform === 'linux') {
    // Respect XDG_CONFIG_HOME (used by many Linux desktop environments and
    // portable installations) instead of always writing to ~/.config.
    const configHome = String(process.env.XDG_CONFIG_HOME || '').trim() || path.join(app.getPath('home'), '.config');
    const directory = path.join(configHome, 'autostart');
    const target = path.join(directory, 'eterx-background.desktop');
    try {
      if (!enabled) {
        fs.rmSync(target, { force: true });
        return { ok: true };
      }
      fs.mkdirSync(directory, { recursive: true });
      const quoteDesktopArg = (value) => `"${String(value).replace(/(["`$\\])/g, '\\$1')}"`;
      const command = [process.execPath, ...(!app.isPackaged ? [app.getAppPath()] : []), '--background'].map(quoteDesktopArg).join(' ');
      const entry = `[Desktop Entry]\nType=Application\nName=EterX Background Companion\nComment=Run EterX channels and scheduled tasks in the background\nExec=${command}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
      fs.writeFileSync(target, entry, { encoding: 'utf8', mode: 0o600 });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not update Linux autostart.' };
    }
  }
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: Boolean(enabled), args: enabled ? ['--background'] : [] });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'Could not update login startup.' };
  }
}

async function initializeGatewayDaemon() {
  gatewayDaemon = new GatewayDaemon({
    dataDir: path.join(app.getPath('userData'), 'data', 'gateways'),
    config: readGatewaySettings(),
    onEvent: (event) => publishGatewayEvent('gateway-input', event),
    onStatus: (status) => publishGatewayEvent('gateway-status', status),
  });
  if (gatewayDaemon.config.launchAtLogin) setGatewayLaunchAtLogin(true);
  if (gatewayDaemon.config.keepRunningOnClose) ensureBackgroundTray();
  if (gatewayDaemon.config.enabled) {
    try { await gatewayDaemon.start(); }
    catch (error) { console.error('[EterX] Gateway daemon failed to start:', error); }
  }
}

function secureRuntimeSettingsEnvironment(settings) {
  const providerEnvironment = {
    gemini: 'GEMINI_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    groq: 'GROQ_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    grok: 'XAI_API_KEY',
    cerebras: 'CEREBRAS_API_KEY',
    together: 'TOGETHER_API_KEY',
    fireworks: 'FIREWORKS_API_KEY',
    sambanova: 'SAMBANOVA_API_KEY',
    perplexity: 'PERPLEXITY_API_KEY',
    deepinfra: 'DEEPINFRA_API_KEY',
    huggingface: 'HUGGINGFACE_API_KEY',
    nvidia: 'NVIDIA_API_KEY',
    cloudflare: 'CLOUDFLARE_API_KEY',
    ollama: 'OLLAMA_API_KEY',
    lmstudio: 'LMSTUDIO_API_KEY',
    vllm: 'VLLM_API_KEY',
    llamacpp: 'LLAMACPP_API_KEY',
    novita: 'NOVITA_API_KEY',
    qwen: 'DASHSCOPE_API_KEY',
    mimo: 'MIMO_API_KEY',
    tokenhub: 'TOKENHUB_API_KEY',
    zai: 'ZAI_API_KEY',
    kimi: 'MOONSHOT_API_KEY',
    stepfun: 'STEPFUN_API_KEY',
    minimax: 'MINIMAX_API_KEY',
    ollamacloud: 'OLLAMA_CLOUD_API_KEY',
    arcee: 'ARCEE_API_KEY',
    gmi: 'GMI_API_KEY',
    kilo: 'KILO_API_KEY',
    opencode: 'OPENCODE_API_KEY',
    upstage: 'UPSTAGE_API_KEY',
    custom: 'CUSTOM_API_KEY',
    tavily: 'TAVILY_API_KEY',
    github: 'GITHUB_TOKEN',
  };
  const modelEnvironment = {
    gemini: 'ETERX_THINK_MODEL',
    mistral: 'MISTRAL_MODEL',
    openrouter: 'OPENROUTER_MODEL',
    anthropic: 'ANTHROPIC_MODEL',
    openai: 'OPENAI_MODEL',
    groq: 'GROQ_MODEL',
    deepseek: 'DEEPSEEK_MODEL',
    grok: 'XAI_MODEL',
    cerebras: 'CEREBRAS_MODEL',
    together: 'TOGETHER_MODEL',
    fireworks: 'FIREWORKS_MODEL',
    sambanova: 'SAMBANOVA_MODEL',
    perplexity: 'PERPLEXITY_MODEL',
    deepinfra: 'DEEPINFRA_MODEL',
    huggingface: 'HUGGINGFACE_MODEL',
    nvidia: 'NVIDIA_MODEL',
    cloudflare: 'CLOUDFLARE_MODEL',
    ollama: 'OLLAMA_MODEL',
    lmstudio: 'LMSTUDIO_MODEL',
    vllm: 'VLLM_MODEL',
    llamacpp: 'LLAMACPP_MODEL',
    novita: 'NOVITA_MODEL',
    qwen: 'QWEN_MODEL',
    mimo: 'MIMO_MODEL',
    tokenhub: 'TOKENHUB_MODEL',
    zai: 'ZAI_MODEL',
    kimi: 'KIMI_MODEL',
    stepfun: 'STEPFUN_MODEL',
    minimax: 'MINIMAX_MODEL',
    ollamacloud: 'OLLAMA_CLOUD_MODEL',
    arcee: 'ARCEE_MODEL',
    gmi: 'GMI_MODEL',
    kilo: 'KILO_MODEL',
    opencode: 'OPENCODE_MODEL',
    upstage: 'UPSTAGE_MODEL',
    custom: 'CUSTOM_MODEL',
  };
  const env = {};

  const providerKeyPools = {};
  for (const [provider, key] of Object.entries(settings.apiKeys || {})) {
    if (!providerKeyPools[provider]) providerKeyPools[provider] = [];
    providerKeyPools[provider].push(key);
  }
  for (const [modelKey, key] of Object.entries(settings.modelApiKeys || {})) {
    const provider = String(modelKey || '').split('::', 1)[0];
    if (!providerKeyPools[provider]) providerKeyPools[provider] = [];
    providerKeyPools[provider].push(key);
  }

  for (const [provider, keys] of Object.entries(providerKeyPools)) {
    const name = providerEnvironment[provider];
    const keyPool = Array.from(new Set(keys.filter(Boolean))).join('\n');
    if (name && keyPool) env[name] = keyPool;
  }
  for (const [provider, model] of Object.entries(settings.modelOverrides || {})) {
    const name = modelEnvironment[provider];
    if (name && model) env[name] = model;
  }

  return env;
}

function removeDesktopRuntimeSettingEnvironment(env) {
  for (const name of Object.keys(env)) {
    const normalized = name.toUpperCase();
    const baseName = normalized.replace(/_\d+$/, '');
    if (DESKTOP_RUNTIME_SETTING_ENV_KEYS.has(normalized) || DESKTOP_RUNTIME_SETTING_ENV_KEYS.has(baseName)) {
      delete env[name];
    }
  }
  return env;
}

function migrateLegacyUserData() {
  const currentUserData = app.getPath('userData');
  if (LEGACY_USER_DATA_PATH && path.resolve(LEGACY_USER_DATA_PATH) !== path.resolve(currentUserData) && fs.existsSync(LEGACY_USER_DATA_PATH)) {
    // Migrate only durable user-owned state. The old runtime and browser cache
    // are deliberately excluded so a new install always starts from its own
    // verified packaged resources.
    const candidates = ['data', NATIVE_THEME_FILE, SECURE_RUNTIME_SETTINGS_FILE, SECURE_GATEWAY_SETTINGS_FILE];
    for (const name of candidates) {
      const source = path.join(LEGACY_USER_DATA_PATH, name);
      const destination = path.join(currentUserData, name);
      if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
      try {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.cpSync(source, destination, { recursive: true, force: false, dereference: true });
      } catch (error) {
        console.warn(`[EterX] Could not migrate legacy ${name}:`, error?.message || error);
      }
    }
  }

  migrateLegacySourceBootstrapData(currentUserData);
}

function migrateLegacySourceBootstrapData(currentUserData) {
  const home = app.getPath('home');
  // Source-bootstrap installs historically used the platform's normal
  // per-user application-data directory. Keep migration platform-aware so a
  // macOS install does not accidentally look in the Linux XDG directory and
  // leave the user's old workspaces behind.
  const sourceBase = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || currentUserData, 'EterX')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'EterX')
      : path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'eterx');
  const legacyWorkspace = path.join(sourceBase, 'data');
  const legacySource = path.join(sourceBase, 'source');
  const destinationData = path.join(currentUserData, 'data');
  const destinationWorkspace = path.join(destinationData, '.workspaces');
  const migrationMarker = path.join(destinationData, '.eterx-source-bootstrap-migrated');

  try {
    if (fs.existsSync(migrationMarker)) return;
    const markerCandidates = [
      path.join(legacyWorkspace, 'config', 'setup-meta.json'),
      path.join(legacyWorkspace, 'memory'),
      path.join(legacyWorkspace, '.memory_v2'),
    ];
    if (!markerCandidates.some((candidate) => fs.existsSync(candidate))) return;

    fs.mkdirSync(destinationWorkspace, { recursive: true });
    const excluded = new Set([
      '.workspaces', 'runtime', 'session', 'cache', 'logs',
      NATIVE_THEME_FILE, SECURE_RUNTIME_SETTINGS_FILE,
    ]);
    for (const entry of fs.readdirSync(legacyWorkspace, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const source = path.join(legacyWorkspace, entry.name);
      const destination = path.join(destinationWorkspace, entry.name);
      if (fs.existsSync(destination)) continue;
      fs.cpSync(source, destination, { recursive: true, force: false, dereference: true });
    }

    const legacyEnv = path.join(legacySource, '.env.local');
    const destinationEnv = path.join(destinationData, '.env.local');
    if (fs.existsSync(legacyEnv) && !fs.existsSync(destinationEnv)) {
      fs.mkdirSync(destinationData, { recursive: true });
      fs.copyFileSync(legacyEnv, destinationEnv, fs.constants.COPYFILE_EXCL);
    }
    fs.writeFileSync(migrationMarker, `${new Date().toISOString()}\n`, 'utf8');
    logToFile(`[migration] Imported legacy source-bootstrap data from ${legacyWorkspace}`);
  } catch (error) {
    console.warn('[EterX] Could not migrate source-bootstrap data:', error?.message || error);
    logToFile(`[migration] Legacy source-bootstrap migration skipped: ${error?.message || error}`);
  }
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
    if (process.platform !== 'darwin' && typeof targetWindow.setTitleBarOverlay === 'function') {
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
    if (process.platform !== 'darwin' && typeof mainWindow.setTitleBarOverlay === 'function') {
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

  if (app.isPackaged && packagedServerUrl) return packagedServerUrl;

  const port = process.env.ETERX_PORT || process.env.PORT || '3000';
  return `http://localhost:${port}`;
}

function readEnvFile(filePath) {
  const values = {};
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) values[key] = value;
    }
  } catch {
    // A missing config file is normal on the first launch.
  }
  return values;
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + 40; port += 1) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No free local port found from ${startPort} to ${startPort + 39}.`);
}

function preparePackagedRuntime() {
  if (!app.isPackaged) return null;
  if (packagedRuntimeRoot && fs.existsSync(packagedRuntimeRoot)) return packagedRuntimeRoot;

  const runtimeRoot = path.join(app.getAppPath(), 'runtime');
  const serverEntry = path.join(runtimeRoot, 'server.js');
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`Bundled runtime is missing: ${serverEntry}`);
  }

  const dataRoot = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(path.join(dataRoot, '.workspaces'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, '.temp'), { recursive: true });
  packagedRuntimeRoot = runtimeRoot;
  return runtimeRoot;
}

function pruneOldPackagedRuntimes() {
  if (!app.isPackaged) return;
  const legacyRuntimeRoot = path.join(app.getPath('userData'), 'runtime');
  const legacySourceRoot = path.join(app.getPath('userData'), 'source');
  const dataRoot = path.join(app.getPath('userData'), 'data');
  if (!fs.existsSync(legacyRuntimeRoot) && !fs.existsSync(legacySourceRoot)) return;
  try {
    if (fs.existsSync(legacyRuntimeRoot)) {
      for (const versionEntry of fs.readdirSync(legacyRuntimeRoot, { withFileTypes: true })) {
        if (!versionEntry.isDirectory()) continue;
        const versionRoot = path.join(legacyRuntimeRoot, versionEntry.name);
        for (const stateName of ['.workspaces', '.temp']) {
          const legacyState = path.join(versionRoot, stateName);
          if (!fs.existsSync(legacyState)) continue;
          const state = fs.lstatSync(legacyState);
          if (!state.isSymbolicLink()) {
            fs.mkdirSync(path.join(dataRoot, stateName), { recursive: true });
            fs.cpSync(legacyState, path.join(dataRoot, stateName), {
              recursive: true,
              force: false,
              errorOnExist: false,
            });
          }
        }
      }
      fs.rmSync(legacyRuntimeRoot, { recursive: true, force: true });
    }
    if (fs.existsSync(legacySourceRoot)) {
      const detachedSourceRoot = path.join(
        app.getPath('userData'),
        `.eterx-retired-source-${process.pid}-${Date.now()}`,
      );
      fs.renameSync(legacySourceRoot, detachedSourceRoot);
      fs.rm(detachedSourceRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }, (error) => {
        if (error) {
          logToFile(`[runtime] Detached legacy source cleanup will retry next launch: ${error.message || error}`);
        } else {
          logToFile('[runtime] Removed detached legacy AppData source checkout.');
        }
      });
    }
    logToFile('[runtime] Removed legacy AppData application-code copies after preserving durable state.');
  } catch (error) {
    logToFile(`[runtime] Old-version cleanup skipped: ${error.message || error}`);
  }
}

async function startPackagedServer() {
  if (!app.isPackaged || process.env.ELECTRON_URL) return null;
  if (packagedServer && !packagedServer.killed) return packagedServerUrl;

  const runtimeRoot = preparePackagedRuntime();
  const startPort = Number(process.env.ETERX_PORT || process.env.PORT || 3000);
  const port = await findAvailablePort(Number.isInteger(startPort) && startPort > 0 ? startPort : 3000);
  const persistentEnv = readEnvFile(path.join(app.getPath('userData'), 'data', '.env.local'));
  const secureSettings = readSecureRuntimeSettings();
  const dataRoot = path.join(app.getPath('userData'), 'data');
  const runtimeModules = getPackagedDependencyModuleRoot() || path.join(runtimeRoot, 'modules');
  const env = removeDesktopRuntimeSettingEnvironment({
    ...process.env,
    ...persistentEnv,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    HOSTNAME: '127.0.0.1',
    PORT: String(port),
    ETERX_PORT: String(port),
    ETERX_APP_ROOT: runtimeRoot,
    ETERX_DATA_DIR: dataRoot,
    NODE_PATH: [runtimeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
  });
  Object.assign(env, secureRuntimeSettingsEnvironment(secureSettings));

  // Keep the BrowserWindow origin aligned with Next's canonical local URL.
  // The server remains bound to loopback only; using localhost here prevents
  // the desktop UI from being treated as cross-origin from its own API.
  packagedServerUrl = `http://localhost:${port}`;
  packagedServer = spawn(process.execPath, [path.join(runtimeRoot, 'server.js')], {
    cwd: dataRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  packagedServer.stdout.on('data', (chunk) => {
    const message = String(chunk).trim();
    console.log(`[EterX server] ${message}`);
    logToFile(`[EterX server] ${message}`);
  });
  packagedServer.stderr.on('data', (chunk) => {
    const message = String(chunk).trim();
    if (message) {
      console.error(`[EterX server] ${message}`);
      logToFile(`[EterX server ERR] ${message}`);
    }
  });
  packagedServer.once('error', (error) => {
    console.error('[EterX] Bundled server failed to start:', error);
    logToFile(`[EterX] Bundled server failed to start: ${error.message || error}`);
  });
  packagedServer.once('exit', (code, signal) => {
    const exitMsg = `Bundled server exited (${code ?? 'unknown'}${signal ? `, ${signal}` : ''}).`;
    if (!isQuitting) console.error(`[EterX] ${exitMsg}`);
    logToFile(`[EterX] ${exitMsg}`);
    packagedServer = null;
    packagedServerUrl = null;
  });

  return packagedServerUrl;
}

function stopPackagedServer() {
  if (!packagedServer || packagedServer.killed) return;
  try { packagedServer.kill(); } catch { }
  packagedServer = null;
  packagedServerUrl = null;
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
    if (app.isPackaged && !process.env.ELECTRON_URL && !packagedServer) {
      throw new Error('The bundled EterX runtime stopped before it became ready.');
    }
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
    query: { theme, icon: getSplashIconDataUrl() },
  });
  if (!launchInBackground && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
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
    text: String(status?.text ?? latestPetStatus?.text ?? '').slice(0, 500),
    isThinking: typeof status?.isThinking === 'boolean'
      ? status.isThinking
      : latestPetStatus?.isThinking === true,
    isMicMuted: typeof status?.isMicMuted === 'boolean'
      ? status.isMicMuted
      : latestPetStatus?.isMicMuted === true,
    isSpeakerMuted: typeof status?.isSpeakerMuted === 'boolean'
      ? status.isSpeakerMuted
      : latestPetStatus?.isSpeakerMuted === true,
    isCameraEnabled: typeof status?.isCameraEnabled === 'boolean'
      ? status.isCameraEnabled
      : latestPetStatus?.isCameraEnabled === true,
    isScreenSharing: typeof status?.isScreenSharing === 'boolean'
      ? status.isScreenSharing
      : latestPetStatus?.isScreenSharing === true,
    liveState: typeof status?.liveState === 'string'
      ? status.liveState
      : latestPetStatus?.liveState || 'listening',
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
  return; // Disabled setShape to preserve 100% per-pixel DWM alpha transparency
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

  const anchorBounds = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow.getBounds()
    : screen.getPrimaryDisplay().workArea;
  const workArea = screen.getDisplayMatching(anchorBounds).workArea;
  const windowWidth = 176;
  const windowHeight = 176;
  const preferredX = Math.round(anchorBounds.x + (anchorBounds.width - windowWidth) / 2);
  const preferredY = Math.round(anchorBounds.y + anchorBounds.height - windowHeight - 124);
  const initialX = Math.min(
    Math.max(preferredX, workArea.x),
    workArea.x + workArea.width - windowWidth
  );
  const initialY = Math.min(
    Math.max(preferredY, workArea.y),
    workArea.y + workArea.height - windowHeight
  );
  petWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: initialX,
    y: initialY,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    title: 'EterX Live Agent',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  petWindow.setAlwaysOnTop(true, 'screen-saver');
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWindow.setBackgroundColor('#00000000');
  petWindow.setIgnoreMouseEvents(true, { forward: true });
  petWindow.loadURL(`${getAppTarget()}/live-overlay`);

  petWindow.webContents.once('did-finish-load', () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    sendPetStatus(latestPetStatus);
    petWindow.showInactive();
  });

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
  const startedAt = Date.now();
  const bootId = ++activeBootId;

  clearBootRetry();

  try {
    if (showSplash) {
      await showSplashScreen();
    }

    if (app.isPackaged && !process.env.ELECTRON_URL && (!packagedServer || packagedServer.killed)) {
      await startPackagedServer();
    }

    const target = getAppTarget();

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
      bootFailureCount = 0;
      pruneOldPackagedRuntimes();
    }
  } catch (error) {
    console.error('[EterX] Startup failed:', error);
    bootFailureCount += 1;
    const target = getAppTarget();
    if (retryOnFailure && isHttpTarget(target) && bootFailureCount < 3) {
      await showSplashScreen().catch(() => { });
      scheduleBootRetry(1200);
      return;
    }
    await showStartupFailure(error, target);
  }
}

function createWindow() {
  const initialNativeTheme = readNativeTheme();
  const initialNativeColors = nativeThemeColors(initialNativeTheme);
  const windowChrome = process.platform === 'darwin'
    ? {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 14, y: 12 },
      }
    : {
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: initialNativeColors.titleBar,
          symbolColor: initialNativeColors.titleSymbol,
          height: NATIVE_FRAME_HEIGHT,
        },
      };

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 400,
    minHeight: 400,
    backgroundColor: initialNativeColors.background,
    title: 'EterX',
    icon: APP_ICON_PATH,
    ...windowChrome,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  if (process.platform === 'win32' && fs.existsSync(APP_ICON_PATH)) {
    mainWindow.setIcon(nativeImage.createFromPath(APP_ICON_PATH));
  }
  registerNativeThemedWindow(mainWindow);
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.control && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAutoHideMenuBar(true);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    const settingsWindow = isSettingsUrl(url);
    if (!settingsWindow) {
      return { action: 'deny' };
    }

    const colors = nativeThemeColors(readNativeTheme());
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 900,
        height: 650,
        minWidth: 900,
        minHeight: 620,
        backgroundColor: colors.background,
        title: 'Settings',
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
      if (!launchInBackground && mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    })
    .catch((error) => {
      console.error('[EterX] Could not load startup screen:', error);
      if (!launchInBackground && mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
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

  // Handle Live media permissions. Screen sharing still requires a visible
  // source picker or explicit confirmation at the moment capture begins.
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'audioCapture', 'videoCapture', 'display-capture'];
    if (allowedPermissions.includes(permission)) {
      callback(true);
    } else {
      callback(false);
    }
  });

  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    const allowedPermissions = ['media', 'audioCapture', 'videoCapture', 'display-capture'];
    return allowedPermissions.includes(permission);
  });

  if (typeof mainWindow.webContents.session.setDisplayMediaRequestHandler === 'function') {
    mainWindow.webContents.session.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const confirmation = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          title: 'Share your screen with EterX Live?',
          message: 'EterX Live requested visual access to your screen.',
          detail: 'Your screen is sampled only while the visible Live sharing control is active. You can stop sharing at any time.',
          buttons: ['Share screen', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (confirmation.response !== 0) {
          callback({});
          return;
        }
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
        });
        const primaryDisplay = screen.getPrimaryDisplay();
        const source = sources.find(candidate => candidate.display_id === String(primaryDisplay.id)) || sources[0];
        callback(source ? { video: source } : {});
      } catch {
        callback({});
      }
    }, { useSystemPicker: true });
  }

  mainWindow.on('close', (event) => {
    if (!isQuitting && gatewayDaemon?.config?.enabled && gatewayDaemon?.config?.keepRunningOnClose) {
      event.preventDefault();
      mainWindow.hide();
      ensureBackgroundTray();
    }
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
        } catch { }
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
      const { exec, execFile } = require('child_process');

      if (process.platform !== 'win32') {
        const commands = process.platform === 'darwin'
          ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice', 'soffice', 'libreoffice']
          : ['libreoffice', 'soffice', '/usr/bin/libreoffice', '/usr/bin/soffice'];
        const tryNext = (index) => {
          if (index >= commands.length) return resolve(null);
          execFile(commands[index], ['--headless', '--convert-to', 'pdf', '--outdir', path.dirname(tempPdfPath), docxPath], { timeout: 60000 }, (err) => {
            if (err) return tryNext(index + 1);
            const generated = path.join(path.dirname(tempPdfPath), `${path.basename(docxPath, path.extname(docxPath))}.pdf`);
            try {
              if (!fs.existsSync(generated)) return tryNext(index + 1);
              fs.renameSync(generated, tempPdfPath);
              resolve(tempPdfPath);
            } catch {
              resolve(null);
            }
          });
        };
        tryNext(0);
        return;
      }

      const escapedDocx = docxPath.replace(/'/g, "''");
      const escapedPdf = tempPdfPath.replace(/'/g, "''");

      const psCommand = `$word = New-Object -ComObject Word.Application; $word.Visible = $false; try { $doc = $word.Documents.Open('${escapedDocx}', $true, $true); $doc.SaveAs('${escapedPdf}', 17); $doc.Close(); } finally { $word.Quit(); }`;

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
ipcMain.handle('open-path', async (event, rawPath) => {
  try {
    if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0')) return false;
    const targetPath = path.resolve(rawPath.trim());
    const target = fs.existsSync(targetPath) ? targetPath : path.dirname(targetPath);
    if (!target || !fs.existsSync(target)) return false;
    const error = await shell.openPath(target);
    return !error;
  } catch {
    return false;
  }
});

ipcMain.handle('open-external', async (event, url) => {
  await shell.openExternal(url);
});

ipcMain.handle('app-restart', () => {
  stopPackagedServer();
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('app-close', () => {
  if (gatewayDaemon?.config?.enabled && gatewayDaemon?.config?.keepRunningOnClose) {
    mainWindow?.hide();
    ensureBackgroundTray();
    return { hiddenToTray: true };
  }
  isQuitting = true;
  stopPackagedServer();
  app.quit();
  return { hiddenToTray: false };
});

let desktopChatSnapshotCache = null;
let desktopChatSnapshotLoadPromise = null;
let desktopChatSnapshotGeneration = 0;

const readDesktopChatSnapshot = async () => {
  if (desktopChatSnapshotCache) return desktopChatSnapshotCache;
  if (desktopChatSnapshotLoadPromise) return desktopChatSnapshotLoadPromise;
  const chatsPath = path.join(app.getPath('userData'), 'data', 'chats', 'chats.json');
  const loadGeneration = desktopChatSnapshotGeneration;
  desktopChatSnapshotLoadPromise = fs.promises.readFile(chatsPath, 'utf8')
    .then(raw => {
      const parsed = JSON.parse(raw);
      const chats = Array.isArray(parsed?.chats)
        ? parsed.chats.filter((chat) => chat && typeof chat === 'object' && typeof chat.id === 'string').slice(0, 2000)
        : [];
      const snapshot = {
        version: 1,
        savedAt: Number.isFinite(parsed?.savedAt) ? Math.max(0, parsed.savedAt) : 0,
        chats,
      };
      if (desktopChatSnapshotGeneration === loadGeneration) {
        desktopChatSnapshotCache = snapshot;
      }
      return desktopChatSnapshotCache || snapshot;
    })
    .catch(error => {
      if (error?.code !== 'ENOENT') throw error;
      const emptySnapshot = { version: 1, savedAt: 0, chats: [] };
      if (desktopChatSnapshotGeneration === loadGeneration) {
        desktopChatSnapshotCache = emptySnapshot;
      }
      return desktopChatSnapshotCache || emptySnapshot;
    })
    .finally(() => {
      desktopChatSnapshotLoadPromise = null;
    });
  return desktopChatSnapshotLoadPromise;
};

ipcMain.handle('chat-snapshot-load', async (_event, requestedChatId) => {
  const snapshot = await readDesktopChatSnapshot();
  const chatId = typeof requestedChatId === 'string' ? requestedChatId.trim() : '';
  if (chatId) return { chat: snapshot.chats.find((chat) => chat.id === chatId) || null };
  return { ...snapshot, chats: [...snapshot.chats] };
});

ipcMain.handle('chat-snapshot-save', (_event, snapshot) => {
  const chats = Array.isArray(snapshot?.chats)
    ? snapshot.chats.filter((chat) => chat && typeof chat === 'object' && typeof chat.id === 'string').slice(0, 2000)
    : null;
  const savedAt = Number(snapshot?.savedAt);
  if (!chats || !Number.isFinite(savedAt) || savedAt <= 0) {
    throw new Error('Invalid chat snapshot.');
  }

  const chatsDir = path.join(app.getPath('userData'), 'data', 'chats');
  const chatsPath = path.join(chatsDir, 'chats.json');
  let current = desktopChatSnapshotCache;
  try {
    if (!current) current = JSON.parse(fs.readFileSync(chatsPath, 'utf8'));
    if (Number(current?.savedAt || 0) > savedAt) {
      desktopChatSnapshotCache = current;
      return { ok: true, savedAt: current.savedAt };
    }
  } catch {
    if (fs.existsSync(chatsPath)) {
      const corruptPath = path.join(chatsDir, `chats.corrupt-${Date.now()}.json`);
      try { fs.renameSync(chatsPath, corruptPath); } catch { }
    }
  }

  let chatsToWrite = chats;
  if (snapshot?.partial === true && Array.isArray(snapshot?.chatIds) && current && Array.isArray(current.chats)) {
    const safeIds = Array.from(new Set(snapshot.chatIds.filter((id) => typeof id === 'string' && id.length > 0))).slice(0, 2000);
    const byId = new Map(current.chats.map((chat) => [chat.id, chat]));
    for (const chat of chats) byId.set(chat.id, chat);
    chatsToWrite = safeIds.map((id) => byId.get(id)).filter(Boolean);
  }

  fs.mkdirSync(chatsDir, { recursive: true });
  const temporaryPath = path.join(chatsDir, `.chats.electron.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, savedAt, chats: chatsToWrite }), 'utf8');
  fs.renameSync(temporaryPath, chatsPath);
  desktopChatSnapshotGeneration += 1;
  desktopChatSnapshotCache = { version: 1, savedAt, chats: chatsToWrite };
  return { ok: true, savedAt };
});

ipcMain.handle('native-theme-get', () => readNativeTheme());

ipcMain.on('native-theme-set', (_event, theme) => {
  applyNativeWindowTheme(theme);
});

// API keys are kept out of the browser-origin localStorage when running as a
// desktop app. Electron encrypts this payload with the operating system's
// credential store, then injects it into the local runtime on the next launch.
ipcMain.handle('secure-runtime-settings-get', () => readSecureRuntimeSettings());

ipcMain.handle('secure-runtime-settings-save', (_event, settings) => writeSecureRuntimeSettings(settings));

ipcMain.handle('secure-runtime-settings-clear', () => clearSecureRuntimeSettings());

ipcMain.handle('gateway-get-state', () => ({
  available: secureStorageAvailable(),
  config: gatewayDaemon?.publicConfig() || normalizeGatewayConfig(DEFAULT_GATEWAY_CONFIG),
  status: gatewayDaemon?.status() || null,
  conversations: gatewayDaemon?.store.listConversations() || [],
  events: gatewayDaemon?.store.listEvents(100) || [],
}));

ipcMain.handle('gateway-save-config', async (_event, raw) => {
  if (!gatewayDaemon) return { ok: false, error: 'Gateway daemon is not ready.' };
  const current = readGatewaySettings();
  const incoming = raw && typeof raw === 'object' ? raw : {};
  const merged = { ...current, ...incoming, platforms: {} };
  const secretFields = ['token', 'webhookSecret', 'appSecret', 'publicKey'];
  for (const platform of ['telegram', 'whatsapp', 'discord', 'signal', 'generic']) {
    const previous = current.platforms?.[platform] || {};
    const next = incoming.platforms?.[platform] || {};
    merged.platforms[platform] = { ...previous, ...next };
    for (const field of secretFields) {
      if (typeof next[field] !== 'string' || !next[field].trim()) merged.platforms[platform][field] = previous[field];
    }
  }
  const saved = writeGatewaySettings(merged);
  if (!saved.ok) return saved;
  const startup = setGatewayLaunchAtLogin(saved.settings.launchAtLogin);
  if (!startup.ok) return startup;
  const state = await gatewayDaemon.configure(saved.settings);
  if (saved.settings.enabled && saved.settings.keepRunningOnClose) ensureBackgroundTray();
  if (!saved.settings.enabled && backgroundTray) {
    backgroundTray.destroy();
    backgroundTray = null;
  }
  return { ok: true, ...state };
});

ipcMain.handle('gateway-start', async () => gatewayDaemon?.start());
ipcMain.handle('gateway-stop', async () => gatewayDaemon?.stop());
ipcMain.handle('gateway-list-events', (_event, limit) => gatewayDaemon?.store.listEvents(Number(limit) || 100) || []);
ipcMain.handle('gateway-claim-inputs', (_event, limit) => gatewayDaemon?.store.listPending(Number(limit) || 25) || []);
ipcMain.handle('gateway-ack-input', (_event, eventId) => gatewayDaemon?.store.acknowledge(String(eventId || '')) || false);
ipcMain.handle('gateway-list-conversations', () => gatewayDaemon?.store.listConversations() || []);
ipcMain.handle('gateway-mark-read', (_event, conversationId) => gatewayDaemon?.store.markRead(String(conversationId || '')) || false);
ipcMain.handle('gateway-list-approvals', () => gatewayDaemon?.store.listApprovals() || []);
ipcMain.handle('gateway-resolve-approval', (_event, identityId, approved) => gatewayDaemon?.store.resolveApproval(String(identityId || ''), Boolean(approved)) || false);
ipcMain.handle('gateway-call-bridge-tool', async (_event, name, args) => gatewayDaemon?.callBridgeTool(String(name || ''), args || {}));
ipcMain.handle('gateway-get-mcp-connection', () => {
  if (!gatewayDaemon) return null;
  const url = `http://${gatewayDaemon.config.host}:${gatewayDaemon.config.port}/mcp`;
  return {
    name: 'eterx-gateway',
    transport: 'streamable-http',
    url,
    token: gatewayDaemon.config.controlToken,
    headers: { Authorization: `Bearer ${gatewayDaemon.config.controlToken}` },
  };
});
ipcMain.handle('gateway-send-message', async (_event, platform, target, text) => {
  if (!gatewayDaemon) throw new Error('Gateway daemon is not ready.');
  return gatewayDaemon.deliverMessage(String(platform || ''), target || {}, String(text || ''));
});

ipcMain.handle('desktop-update-get-state', () => desktopUpdateState);

ipcMain.handle('desktop-update-check', async () => {
  if (!app.isPackaged || !desktopAutoUpdater) return desktopUpdateState;
  return performDesktopUpdateCheck();
});

ipcMain.handle('desktop-update-download', async () => {
  if (!app.isPackaged || !desktopAutoUpdater || desktopUpdateState.status !== 'available') {
    return desktopUpdateState;
  }
  publishDesktopUpdateState({
    status: 'downloading',
    percent: 0,
    message: `Downloading EterX ${desktopUpdateState.availableVersion || 'update'}...`,
  });
  try {
    await desktopAutoUpdater.downloadUpdate();
  } catch (error) {
    publishDesktopUpdateState({
      status: 'error',
      percent: 0,
      message: `Update download failed: ${error.message}`,
    });
  }
  return desktopUpdateState;
});

ipcMain.handle('desktop-update-install', () => {
  if (!app.isPackaged || !desktopAutoUpdater || desktopUpdateState.status !== 'ready') return false;
  isQuitting = true;
  stopPackagedServer();
  setImmediate(() => desktopAutoUpdater.quitAndInstall(false, true));
  return true;
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

ipcMain.on('pet-window-move', (_event, pos) => {
  if (petWindow && !petWindow.isDestroyed() && pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
    try {
      const bounds = petWindow.getBounds();
      const requestedX = Math.round(pos.x);
      const requestedY = Math.round(pos.y);
      const targetDisplay = screen.getDisplayNearestPoint({
        x: requestedX + Math.round(bounds.width / 2),
        y: requestedY + Math.round(bounds.height / 2),
      });
      const workArea = targetDisplay.workArea;
      const safeX = Math.min(
        Math.max(requestedX, workArea.x),
        workArea.x + workArea.width - bounds.width
      );
      const safeY = Math.min(
        Math.max(requestedY, workArea.y),
        workArea.y + workArea.height - bounds.height
      );
      petWindow.setPosition(safeX, safeY, false);
    } catch { }
  }
});

ipcMain.on('pet-window-ignore-mouse', (_event, ignore, options) => {
  if (petWindow && !petWindow.isDestroyed()) {
    try {
      petWindow.setIgnoreMouseEvents(Boolean(ignore), options || { forward: true });
    } catch { }
  }
});

ipcMain.on('pet-reply', (_event, message) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pet-reply', String(message || ''));
  }
});

app.on('ready', async () => {
  const { session } = require('electron');
  Menu.setApplicationMenu(null);

  migrateLegacyUserData();

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

  try {
    await startPackagedServer();
  } catch (error) {
    console.error('[EterX] Could not prepare bundled server:', error);
  }

  await initializeGatewayDaemon();
  createWindow();
  initializeDesktopUpdates();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    isQuitting = true;
    stopPackagedServer();
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  void gatewayDaemon?.stop();
  stopPackagedServer();
});

app.on('activate', function () {
  if (mainWindow === null) {
    createWindow();
  }
});
