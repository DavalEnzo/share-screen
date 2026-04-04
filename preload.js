const { contextBridge, ipcRenderer } = require('electron');

const DEFAULT_REMOTE_SIGNALING_URL = 'wss://share-screen-production.up.railway.app';
const DEFAULT_TURN_HOST = '82.67.57.216';
const DEFAULT_TURN_PORT = '3478';
const DEFAULT_USER_API_BASE = 'http://82.67.57.216:8000';

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  getLocalIp: () => ipcRenderer.invoke('get-local-ip'),
  getSignalingPort: () => ipcRenderer.invoke('get-signaling-port'),
  getRuntimeConfig: () => ({
    remoteSignalingUrl: process.env.REMOTE_SIGNALING_URL || DEFAULT_REMOTE_SIGNALING_URL,
    turnHost: process.env.TURN_HOST || DEFAULT_TURN_HOST,
    turnPort: process.env.TURN_PORT || DEFAULT_TURN_PORT,
    userApiBase: process.env.USER_API_BASE || DEFAULT_USER_API_BASE,
    // Credentials statiques désactivés : on utilise les credentials éphémères via TURN_SECRET
    turnUsername: '',
    turnPassword: '',
  }),
  getTurnCredentials: () => ipcRenderer.invoke('get-turn-credentials'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getReleaseNotes: (version) => ipcRenderer.invoke('get-release-notes', version || ''),
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard-write-text', String(text || '')),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  toggleFullscreenWindow: () => ipcRenderer.send('window-toggle-fullscreen'),
  setFullscreenWindow: (enabled) => ipcRenderer.invoke('window-set-fullscreen', !!enabled),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  onUpdateDownloaded: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('update-downloaded', (_event, info) => {
      try { callback(info); } catch (_) {}
    });
  },
});
