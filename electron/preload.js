const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
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
  restartApp: () => ipcRenderer.invoke('app-restart'),
  closeApp: () => ipcRenderer.invoke('app-close'),
  loadChatSnapshot: (chatId) => ipcRenderer.invoke('chat-snapshot-load', chatId),
  saveChatSnapshot: (snapshot) => ipcRenderer.invoke('chat-snapshot-save', snapshot),
  showNotification: (title, body) => ipcRenderer.invoke('show-notification', title, body),
  setNativeTheme: (theme) => ipcRenderer.send('native-theme-set', theme),
  getNativeTheme: () => ipcRenderer.invoke('native-theme-get'),
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
  checkForUpdates: () => ipcRenderer.invoke('desktop-update-check'),
  downloadUpdate: () => ipcRenderer.invoke('desktop-update-download'),
  installUpdate: () => ipcRenderer.invoke('desktop-update-install'),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop-update-state', listener);
    return () => ipcRenderer.removeListener('desktop-update-state', listener);
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
