const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  getLocalIp: () => ipcRenderer.invoke('get-local-ip'),
  getSignalingPort: () => ipcRenderer.invoke('get-signaling-port'),
  getRuntimeConfig: () => ({
    remoteSignalingUrl: process.env.REMOTE_SIGNALING_URL || ''
  }),
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard-write-text', String(text || '')),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  toggleFullscreenWindow: () => ipcRenderer.send('window-toggle-fullscreen'),
  setFullscreenWindow: (enabled) => ipcRenderer.invoke('window-set-fullscreen', !!enabled),
});
