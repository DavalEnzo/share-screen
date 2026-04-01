const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session } = require('electron');
const path = require('path');
const http = require('http');
const { Server } = require('ws');

let mainWindow;
let signalingServer;
let wss;
const PORT = 8765;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      allowRunningInsecureContent: true
    },
    show: false
  });

  // ── Fix "bad IPC message reason 263" ─────────────────────────────────────
  // Electron 20+ requires explicit permission grants for getUserMedia/desktop capture.

  // 1. Autoriser toutes les permissions media demandées par le renderer
  mainWindow.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const allowed = ['media', 'display-capture', 'screen', 'audioCapture', 'videoCapture'];
      callback(allowed.includes(permission));
    }
  );

  // 2. Handler pour getDisplayMedia (Electron 17+)
  //    Retourne la source choisie via IPC plutôt que d'ouvrir le picker natif
  mainWindow.webContents.session.setDisplayMediaRequestHandler(
    (request, callback) => {
      // On laisse le renderer choisir la source via notre propre UI,
      // donc on répond avec la première source disponible comme fallback.
      // Le vrai choix est géré côté renderer via chromeMediaSourceId.
      desktopCapturer.getSources({ types: ['screen', 'window'] }).then(sources => {
        // Retourne la première source — le renderer override via contraintes
        callback({ video: sources[0], audio: 'loopback' });
      });
    },
    { useSystemPicker: false }
  );
  // ─────────────────────────────────────────────────────────────────────────

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

// Serveur de signalisation WebSocket pour WebRTC
function startSignalingServer() {
  signalingServer = http.createServer();
  wss = new Server({ server: signalingServer });

  const rooms = new Map();

  wss.on('connection', (ws) => {
    let clientRoom = null;
    let clientRole = null;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case 'join': {
            clientRoom = msg.room;
            clientRole = msg.role;
            if (!rooms.has(msg.room)) rooms.set(msg.room, new Set());
            rooms.get(msg.room).add(ws);
            ws.send(JSON.stringify({ type: 'joined', room: msg.room, role: msg.role }));
            // Informer les autres dans la room
            broadcast(msg.room, ws, { type: 'peer-joined', role: msg.role });
            break;
          }
          case 'offer':
          case 'answer':
          case 'ice-candidate': {
            broadcast(clientRoom, ws, msg);
            break;
          }
          case 'leave': {
            cleanup();
            break;
          }
        }
      } catch (e) {
        console.error('Parse error:', e);
      }
    });

    ws.on('close', () => cleanup());

    function cleanup() {
      if (clientRoom && rooms.has(clientRoom)) {
        rooms.get(clientRoom).delete(ws);
        broadcast(clientRoom, ws, { type: 'peer-left', role: clientRole });
        if (rooms.get(clientRoom).size === 0) rooms.delete(clientRoom);
      }
    }

    function broadcast(room, sender, msg) {
      if (!room || !rooms.has(room)) return;
      rooms.get(room).forEach(client => {
        if (client !== sender && client.readyState === 1) {
          client.send(JSON.stringify(msg));
        }
      });
    }
  });

  signalingServer.listen(PORT, () => {
    console.log(`Signaling server running on ws://localhost:${PORT}`);
  });
}

// IPC handlers
ipcMain.handle('get-sources', async () => {
  const primaryDisplay = screen.getPrimaryDisplay();
  const scale = primaryDisplay?.scaleFactor || 1;
  const targetWidth = Math.min(640, Math.floor((primaryDisplay?.workAreaSize?.width || 1280) * 0.35));
  const targetHeight = Math.floor(targetWidth * 9 / 16);

  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    fetchWindowIcons: true,
    thumbnailSize: {
      width: Math.max(320, Math.floor(targetWidth * scale)),
      height: Math.max(180, Math.floor(targetHeight * scale))
    }
  });
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
    appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : ''
  }));
});

ipcMain.handle('get-local-ip', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
});

ipcMain.handle('get-signaling-port', () => PORT);

ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-toggle-fullscreen', () => {
  if (!mainWindow) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
});
ipcMain.handle('window-set-fullscreen', (_event, enabled) => {
  if (!mainWindow) return false;
  mainWindow.setFullScreen(Boolean(enabled));
  return mainWindow.isFullScreen();
});
ipcMain.on('window-close', () => mainWindow.close());

app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-insecure-websocket-from-https-origin');

app.whenReady().then(() => {
  startSignalingServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (signalingServer) signalingServer.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
