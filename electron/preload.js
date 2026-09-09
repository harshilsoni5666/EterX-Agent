const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
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
