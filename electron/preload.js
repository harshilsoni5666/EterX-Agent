const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectFiles: () => ipcRenderer.invoke('select-files'),
  listFolder: (path) => ipcRenderer.invoke('list-folder', path),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  isElectron: true,
});
