require('dotenv').config();
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session, clipboard } = require('electron');

// Réduire l'influence de la vsync et du throttling de fond sur le partage.
// Attention : ça ne désactive pas G-SYNC/FreeSync au niveau du driver,
// mais ça évite que la fenêtre Electron soit trop pénalisée en arrière-plan.
app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
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
      webSecurity: true,
      // Ne pas ralentir les timers / rafraîchissement quand la fenêtre est
      // minimisée ou en arrière-plan, pour garder des FPS stables côté partage.
      backgroundThrottling: false
    },
    show: false
  });

  // ── Fix "bad IPC message reason 263" ─────────────────────────────────────
  // Electron 20+ requires explicit permission grants for getUserMedia/desktop capture.

  // 1. Autoriser toutes les permissions media demandées par le renderer
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      const allowed = new Set(['media', 'display-capture', 'screen', 'audioCapture', 'videoCapture']);
      const isLocalApp = (details?.requestingUrl || '').startsWith('file://');
      callback(isLocalApp && allowed.has(permission));
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

  // rooms : Map<roomCode, Set<{ws, role, id}>>
  const rooms = new Map();

  setInterval(() => {
    for (const [code, members] of rooms) {
      if (members.size === 0) rooms.delete(code);
    }
  }, 5 * 60 * 1000);

  wss.on('connection', (ws, req) => {
    const ip = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || 'local';
    const clientId = Math.random().toString(36).slice(2, 8);
    let clientRoom = null;
    let clientRole = null;

    console.log(`[+] Client ${clientId} connecté (${ip})`);

    const joinTimeout = setTimeout(() => {
      if (!clientRoom) {
        ws.close(1008, 'Join timeout');
      }
    }, 10_000);

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case 'join': {
          clearTimeout(joinTimeout);

          const code = (msg.room || '').toUpperCase().trim();
          if (!code || code.length < 3) {
            ws.send(JSON.stringify({ type: 'error', message: 'Code invalide' }));
            return;
          }

          clientRoom = code;
          clientRole = msg.role === 'viewer' ? 'viewer' : 'broadcaster';

          if (!rooms.has(code)) rooms.set(code, new Set());
          const room = rooms.get(code);

          const broadcasters = [...room].filter(m => m.role === 'broadcaster');
          if (clientRole === 'broadcaster' && broadcasters.length >= 1) {
            ws.send(JSON.stringify({ type: 'error', message: 'Un diffuseur est déjà dans cette session' }));
            return;
          }
          if (room.size >= 11) {
            ws.send(JSON.stringify({ type: 'error', message: 'Session pleine (max 10 viewers)' }));
            return;
          }

          const member = { ws, role: clientRole, id: clientId };
          room.add(member);

          ws.send(JSON.stringify({ type: 'joined', room: code, role: clientRole, id: clientId }));
          broadcast(code, ws, { type: 'peer-joined', role: clientRole, id: clientId });

          if (clientRole === 'viewer') {
            broadcastTo(code, 'broadcaster', ws, { type: 'viewer-ready', viewerId: clientId });
          }

          console.log(`[=] ${clientId} (${clientRole}) -> room "${code}" (${room.size} membres)`);
          break;
        }

        case 'offer':
        case 'answer':
        case 'ice-candidate': {
          if (msg.targetId) {
            sendToId(clientRoom, msg.targetId, { ...msg, fromId: clientId });
          } else {
            broadcast(clientRoom, ws, { ...msg, fromId: clientId });
          }
          break;
        }

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          break;
        }

        case 'leave': {
          cleanup();
          break;
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(joinTimeout);
      cleanup();
    });

    ws.on('error', (err) => {
      console.error(`[!] Erreur client ${clientId}:`, err.message);
    });

    function cleanup() {
      if (!clientRoom || !rooms.has(clientRoom)) return;
      const room = rooms.get(clientRoom);

      for (const member of room) {
        if (member.id === clientId) {
          room.delete(member);
          break;
        }
      }

      broadcast(clientRoom, ws, { type: 'peer-left', role: clientRole, id: clientId });
      console.log(`[-] ${clientId} (${clientRole}) quitte "${clientRoom}" (${room.size} restants)`);

      if (room.size === 0) rooms.delete(clientRoom);
      clientRoom = null;
    }

    function broadcast(roomCode, sender, msg) {
      if (!roomCode || !rooms.has(roomCode)) return;
      const payload = JSON.stringify(msg);
      rooms.get(roomCode).forEach(member => {
        if (member.ws !== sender && member.ws.readyState === 1) {
          member.ws.send(payload);
        }
      });
    }

    function broadcastTo(roomCode, role, sender, msg) {
      if (!roomCode || !rooms.has(roomCode)) return;
      const payload = JSON.stringify(msg);
      rooms.get(roomCode).forEach(member => {
        if (member.ws !== sender && member.role === role && member.ws.readyState === 1) {
          member.ws.send(payload);
        }
      });
    }

    function sendToId(roomCode, targetId, msg) {
      if (!roomCode || !rooms.has(roomCode)) return;
      const payload = JSON.stringify(msg);
      rooms.get(roomCode).forEach(member => {
        if (member.id === targetId && member.ws.readyState === 1) {
          member.ws.send(payload);
        }
      });
    }
  });

  signalingServer.listen(PORT, () => {
    console.log(`Signaling server running on ws://localhost:${PORT}`);
  });

  signalingServer.on('close', () => {
    if (wss) {
      wss.clients.forEach((client) => {
        try { client.close(1001, 'Server shutting down'); } catch {}
      });
    }
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
ipcMain.handle('clipboard-write-text', (_event, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

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
