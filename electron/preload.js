const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  terminalTransfer: (from, to) => ipcRenderer.invoke('chat-terminal-transfer', from, to),
  workspaceFolderRoot: (options) => ipcRenderer.invoke('workspace-folder-root', options),
  workspaceFolderRoots: (options) => ipcRenderer.invoke('workspace-folder-roots', options),
  workspaceFolderList: (path, offset, showHidden) => ipcRenderer.invoke('workspace-folder-list', path, offset, showHidden),
  workspaceBrowserCreate: (id, theme) => ipcRenderer.invoke('workspace-browser-create', id, theme),
  workspaceBrowserCapture: (id) => ipcRenderer.invoke('workspace-browser-capture', id),
  workspaceBrowserMenu: (id, anchor) => ipcRenderer.invoke('workspace-browser-menu', id, anchor),
  workspaceBrowserPreview: (id) => ipcRenderer.invoke('workspace-browser-preview', id),
  workspaceBrowserSuggest: (id, query) => ipcRenderer.invoke('workspace-browser-suggest', id, query),
  workspaceFilesWatch: (id, path) => ipcRenderer.invoke('workspace-files-watch', id, path),
  workspaceFilesUnwatch: (id) => ipcRenderer.send('workspace-files-unwatch', id),
  workspaceOpenApps: () => ipcRenderer.invoke('workspace-open-apps'),
  workspaceOpenFile: (path, application) => ipcRenderer.invoke('workspace-open-file', path, application),
  workspaceReviewList: (root, scope, baseRef) => ipcRenderer.invoke('workspace-review-list', root, scope, baseRef),
  workspaceReviewDiff: (root, path, scope, expanded, baseRef) => ipcRenderer.invoke('workspace-review-diff', root, path, scope, expanded, baseRef),
  onWorkspaceFilesEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('workspace-files-event', listener);
    return () => ipcRenderer.removeListener('workspace-files-event', listener);
  },
  workspaceBrowserCommand: (id, command, value) => ipcRenderer.invoke('workspace-browser-command', id, command, value),
  workspaceBrowserBounds: (id, bounds) => ipcRenderer.send('workspace-browser-bounds', id, bounds),
  workspaceBrowserClose: (id) => ipcRenderer.invoke('workspace-browser-close', id),
  onWorkspaceBrowserEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('workspace-browser-event', listener);
    return () => ipcRenderer.removeListener('workspace-browser-event', listener);
  },
  terminalCreate: (options) => ipcRenderer.invoke('chat-terminal-create', options),
  terminalAttach: (id) => ipcRenderer.invoke('chat-terminal-attach', id),
  terminalClose: (id) => ipcRenderer.invoke('chat-terminal-close', id),
  terminalInput: (id, data) => ipcRenderer.send('chat-terminal-input', id, data),
  terminalResize: (id, cols, rows) => ipcRenderer.send('chat-terminal-resize', id, cols, rows),
  terminalAck: (id, count) => ipcRenderer.send('chat-terminal-ack', id, count),
  terminalVisible: (id, visible) => ipcRenderer.send('chat-terminal-visible', id, visible),
  onTerminalEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chat-terminal-event', listener);
    return () => ipcRenderer.removeListener('chat-terminal-event', listener);
  },
  // One small synchronous read keeps the first HTML paint on the same
  // profile/theme as the native window, including isolated development runs.
  initialTheme: ipcRenderer.sendSync('native-theme-bootstrap'),
  platform: process.platform === 'darwin'
    ? 'macos'
    : process.platform === 'win32'
      ? 'windows'
      : process.platform === 'linux'
        ? 'linux'
        : 'unknown',
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectFiles: () => ipcRenderer.invoke('select-files'),
  getFileIcon: (path) => ipcRenderer.invoke('get-file-icon', path),
  convertDocxToPdf: (path) => ipcRenderer.invoke('convert-docx-to-pdf', path),
  listFolder: (path) => ipcRenderer.invoke('list-folder', path),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openPath: (path) => ipcRenderer.invoke('open-path', path),
  reloadApp: () => ipcRenderer.invoke('app-reload'),
  restartApp: () => ipcRenderer.invoke('app-restart'),
  closeApp: () => ipcRenderer.invoke('app-close'),
  showNotification: (title, body) => ipcRenderer.invoke('show-notification', title, body),
  writeClipboardText: (value) => ipcRenderer.invoke('clipboard-write-text', String(value ?? '')),
  writeClipboardPng: (dataUrl) => ipcRenderer.invoke('clipboard-write-png', String(dataUrl ?? '')),
  readClipboardText: () => ipcRenderer.invoke('clipboard-read-text'),
  readClipboardImage: () => ipcRenderer.invoke('clipboard-read-image'),
  requestLiveMediaPermissions: () => ipcRenderer.invoke('live-media-permissions'),
  showMicrophonePermissionHelp: () => ipcRenderer.invoke('microphone-permission-help'),
  startSpeechDictation: (language, sessionId) => ipcRenderer.invoke('speech-dictation-start', String(language || ''), sessionId),
  stopSpeechDictation: (sessionId, discard = false) => ipcRenderer.invoke('speech-dictation-stop', sessionId, discard),
  pushSpeechDictationAudio: (samples, sessionId, revision) => ipcRenderer.send('speech-dictation-audio', samples, sessionId, revision),
  resetSpeechDictation: (sessionId, revision) => ipcRenderer.send('speech-dictation-reset', sessionId, revision),
  onSpeechDictationEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('speech-dictation-event', listener);
    return () => ipcRenderer.removeListener('speech-dictation-event', listener);
  },
  setNativeTheme: (theme) => ipcRenderer.send('native-theme-set', theme),
  getNativeTheme: () => ipcRenderer.invoke('native-theme-get'),
  getRendererPreferences: () => ipcRenderer.invoke('renderer-preferences-get'),
  updateRendererPreferences: (update) => ipcRenderer.invoke('renderer-preferences-update', update),
  getSecureRuntimeSettings: () => ipcRenderer.invoke('secure-runtime-settings-get'),
  saveSecureRuntimeSettings: (settings) => ipcRenderer.invoke('secure-runtime-settings-save', settings),
  clearSecureRuntimeSettings: () => ipcRenderer.invoke('secure-runtime-settings-clear'),
  getGatewayState: () => ipcRenderer.invoke('gateway-get-state'),
  saveTelegramBot: (bot) => ipcRenderer.invoke('telegram-bot-save', bot),
  removeTelegramBot: (id) => ipcRenderer.invoke('telegram-bot-remove', id),
  pairTelegramBot: (id) => ipcRenderer.invoke('telegram-bot-pair', id),
  saveGatewayConfig: (config) => ipcRenderer.invoke('gateway-save-config', config),
  startGateway: () => ipcRenderer.invoke('gateway-start'),
  stopGateway: () => ipcRenderer.invoke('gateway-stop'),
  listGatewayEvents: (limit) => ipcRenderer.invoke('gateway-list-events', limit),
  claimGatewayInputs: (limit) => ipcRenderer.invoke('gateway-claim-inputs', limit),
  acknowledgeGatewayInput: (eventId) => ipcRenderer.invoke('gateway-ack-input', eventId),
  listGatewayConversations: () => ipcRenderer.invoke('gateway-list-conversations'),
  markGatewayConversationRead: (conversationId) => ipcRenderer.invoke('gateway-mark-read', conversationId),
  listGatewayApprovals: () => ipcRenderer.invoke('gateway-list-approvals'),
  resolveGatewayApproval: (identityId, approved) => ipcRenderer.invoke('gateway-resolve-approval', identityId, approved),
  callGatewayBridgeTool: (name, args) => ipcRenderer.invoke('gateway-call-bridge-tool', name, args),
  getGatewayMcpConnection: () => ipcRenderer.invoke('gateway-get-mcp-connection'),
  sendGatewayMessage: (platform, target, text) => ipcRenderer.invoke('gateway-send-message', platform, target, text),
  onGatewayInput: (callback) => {
    const listener = (_event, input) => callback(input);
    ipcRenderer.on('gateway-input', listener);
    return () => ipcRenderer.removeListener('gateway-input', listener);
  },
  onGatewayStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('gateway-status', listener);
    return () => ipcRenderer.removeListener('gateway-status', listener);
  },
  getUpdateState: () => ipcRenderer.invoke('desktop-update-get-state'),
  markUpdateViewed: () => ipcRenderer.invoke('desktop-update-mark-viewed'),
  checkForUpdates: () => ipcRenderer.invoke('desktop-update-check'),
  downloadUpdate: () => ipcRenderer.invoke('desktop-update-download'),
  installUpdate: () => ipcRenderer.invoke('desktop-update-install'),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop-update-state', listener);
    return () => ipcRenderer.removeListener('desktop-update-state', listener);
  },
  onPrepareForQuit: (callback) => {
    const listener = (_event, requestId, options = {}) => {
      Promise.resolve()
        .then(() => callback(options))
        .then((ok) => ipcRenderer.send('desktop-durable-flush-complete', requestId, ok !== false))
        .catch(() => ipcRenderer.send('desktop-durable-flush-complete', requestId, false));
    };
    ipcRenderer.on('desktop-prepare-for-quit', listener);
    return () => ipcRenderer.removeListener('desktop-prepare-for-quit', listener);
  },
  onDesktopResume: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('desktop-resume', listener);
    return () => ipcRenderer.removeListener('desktop-resume', listener);
  },
  getWindowVisibility: () => ipcRenderer.invoke('desktop-window-visibility-get'),
  onWindowVisibilityChanged: (callback) => {
    const listener = (_event, visible) => callback(Boolean(visible));
    ipcRenderer.on('desktop-window-visibility-changed', listener);
    return () => ipcRenderer.removeListener('desktop-window-visibility-changed', listener);
  },
  openPetWindow: (status) => ipcRenderer.invoke('pet-window-open', status),
  updatePetWindow: (status) => ipcRenderer.send('pet-window-status', status),
  closePetWindow: () => ipcRenderer.send('pet-window-close'),
  resizePetWindow: (options) => ipcRenderer.send('pet-window-resize', options),
  movePetWindow: (pos) => ipcRenderer.send('pet-window-move', pos),
  setIgnoreMouseEvents: (ignore, options) => ipcRenderer.send('pet-window-ignore-mouse', ignore, options),
  petReply: (message) => ipcRenderer.send('pet-reply', message),
  onPetReply: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('pet-reply', listener);
    return () => ipcRenderer.removeListener('pet-reply', listener);
  },
  onPetStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('pet-status', listener);
    return () => ipcRenderer.removeListener('pet-status', listener);
  },
  onPetWindowClosed: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('pet-window-closed', listener);
    return () => ipcRenderer.removeListener('pet-window-closed', listener);
  },
  isElectron: true,
});
