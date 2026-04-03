const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  getLocalIp: () => ipcRenderer.invoke('get-local-ip'),
  getSignalingPort: () => ipcRenderer.invoke('get-signaling-port'),
  getRuntimeConfig: () => ({
    remoteSignalingUrl: process.env.REMOTE_SIGNALING_URL || '',
    turnHost: process.env.TURN_HOST || '',
    turnPort: process.env.TURN_PORT || '',
    turnUsername: process.env.TURN_USERNAME || '',
    turnPassword: process.env.TURN_PASSWORD || '',
  }),
  getTurnCredentials: () => ipcRenderer.invoke('get-turn-credentials'),
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard-write-text', String(text || '')),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  toggleFullscreenWindow: () => ipcRenderer.send('window-toggle-fullscreen'),
  setFullscreenWindow: (enabled) => ipcRenderer.invoke('window-set-fullscreen', !!enabled),
});
