const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectFiles: () => ipcRenderer.invoke('select-files'),
  getFileIcon: (path) => ipcRenderer.invoke('get-file-icon', path),
  convertDocxToPdf: (path) => ipcRenderer.invoke('convert-docx-to-pdf', path),
  listFolder: (path) => ipcRenderer.invoke('list-folder', path),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  showNotification: (title, body) => ipcRenderer.invoke('show-notification', title, body),
  setNativeTheme: (theme) => ipcRenderer.send('native-theme-set', theme),
  getNativeTheme: () => ipcRenderer.invoke('native-theme-get'),
  getSecureRuntimeSettings: () => ipcRenderer.invoke('secure-runtime-settings-get'),
  saveSecureRuntimeSettings: (settings) => ipcRenderer.invoke('secure-runtime-settings-save', settings),
  clearSecureRuntimeSettings: () => ipcRenderer.invoke('secure-runtime-settings-clear'),
  openPetWindow: (status) => ipcRenderer.invoke('pet-window-open', status),
  updatePetWindow: (status) => ipcRenderer.send('pet-window-status', status),
  closePetWindow: () => ipcRenderer.send('pet-window-close'),
  resizePetWindow: (options) => ipcRenderer.send('pet-window-resize', options),
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
