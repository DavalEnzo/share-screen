require('dotenv').config();
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const DEFAULT_REMOTE_SIGNALING_URL = 'wss://share-screen-production.up.railway.app';

// Utiliser des dossiers persistants explicites pour éviter les erreurs d'accès
// au cache Chromium sur Windows (ex: 0x5 Access denied).
const USER_DATA_DIR = path.join(app.getPath('appData'), 'Lunia');
const CACHE_DIR = path.join(USER_DATA_DIR, 'Cache');
const GPU_CACHE_DIR = path.join(USER_DATA_DIR, 'GPUCache');

try {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(GPU_CACHE_DIR, { recursive: true });
} catch (err) {
  console.warn('[startup] Impossible de préparer les dossiers cache:', err && err.message ? err.message : err);
}

app.setPath('userData', USER_DATA_DIR);
app.commandLine.appendSwitch('disk-cache-dir', CACHE_DIR);
app.commandLine.appendSwitch('gpu-shader-disk-cache-dir', GPU_CACHE_DIR);

// Empêche les conflits de cache/fichiers verrouillés si une seconde instance est lancée.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

// Réduire l'influence de la vsync et du throttling de fond sur le partage.
// Attention : ça ne désactive pas G-SYNC/FreeSync au niveau du driver,
// mais ça évite que la fenêtre Electron soit trop pénalisée en arrière-plan.
app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
const http = require('http');
const { Server } = require('ws');
const authStore = require('./authStore');

let mainWindow;
let signalingServer;
let wss;
const PORT = 8765;

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

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

  // Presence locale : username -> { online, sharing, roomCode, host, mode }
  const presence = new Map();

  // Sessions actives : username -> Set<WebSocket>
  const userSessions = new Map();

  function ensurePresence(username) {
    let p = presence.get(username);
    if (!p) {
      p = { online: false, sharing: false, roomCode: null, host: null, mode: 'local' };
      presence.set(username, p);
    }
    return p;
  }

  function updatePresenceOnline(username) {
    const p = ensurePresence(username);
    const sessions = userSessions.get(username);
    p.online = Boolean(sessions && sessions.size > 0);
  }

  function updatePresenceSharing(username, sharing, roomCode) {
    const p = ensurePresence(username);
    p.sharing = Boolean(sharing);
    p.roomCode = sharing ? roomCode : null;
  }

  function updatePresenceMeta(username, meta) {
    const p = ensurePresence(username);
    if (Object.prototype.hasOwnProperty.call(meta, 'host')) {
      p.host = meta.host || null;
    }
    if (Object.prototype.hasOwnProperty.call(meta, 'mode')) {
      p.mode = meta.mode === 'remote' ? 'remote' : 'local';
    }
  }

  function buildStatusPayload(username) {
    const p = ensurePresence(username);
    return {
      user: username,
      online: Boolean(p.online),
      sharing: Boolean(p.sharing),
      roomCode: p.roomCode || null,
      host: p.host || null,
      mode: p.mode || 'local',
    };
  }

  function sendPresenceSnapshot(ws) {
    for (const username of presence.keys()) {
      const payload = buildStatusPayload(username);
      try {
        ws.send(JSON.stringify({
          type: 'contact-status',
          contact: username,
          online: payload.online,
          sharing: payload.sharing,
          roomCode: payload.roomCode,
          host: payload.host,
          mode: payload.mode,
        }));
      } catch (_) {}
    }
  }

  function notifyContactsOfStatus(username) {
    const payload = buildStatusPayload(username);
    const envelope = JSON.stringify({
      type: 'contact-status',
      contact: username,
      online: payload.online,
      sharing: payload.sharing,
      roomCode: payload.roomCode,
      host: payload.host,
      mode: payload.mode,
    });

    // Diffuser à toutes les sessions connectées ;
    // le client ne met à jour que les contacts déjà connus.
    for (const sessions of userSessions.values()) {
      sessions.forEach((client) => {
        if (client.readyState === 1) {
          try { client.send(envelope); } catch (_) {}
        }
      });
    }
  }

  function sendContactsList(username, ws) {
    const res = authStore.getContacts(username);
    if (!res.ok) {
      ws.send(JSON.stringify({ type: 'contacts-error', message: res.error }));
      return;
    }

    const contacts = res.contacts || [];
    const list = contacts.map((name) => {
      const payload = buildStatusPayload(name);

      const otherRes = authStore.getContacts(name);
      const otherContacts = otherRes.ok && Array.isArray(otherRes.contacts)
        ? otherRes.contacts
        : [];
      const mutual = otherContacts.includes(username);

      if (!mutual) {
        payload.online = false;
        payload.sharing = false;
        payload.roomCode = null;
        payload.host = null;
      }

      return payload;
    });
    ws.send(JSON.stringify({ type: 'contacts-list', contacts: list }));
  }

  function sendFriendRequests(username, ws) {
    const res = authStore.getFriendRequests(username);
    if (!res.ok) {
      ws.send(JSON.stringify({ type: 'friend-error', message: res.error }));
      return;
    }
    ws.send(JSON.stringify({
      type: 'friend-requests',
      incoming: res.incoming || [],
      outgoing: res.outgoing || [],
    }));
  }

  function broadcastToUserSessions(username, fn) {
    const sessions = userSessions.get(username);
    if (!sessions) return;
    sessions.forEach((client) => {
      if (client.readyState === 1) {
        try { fn(client); } catch (_) {}
      }
    });
  }

  function notifyFriendRequests(username) {
    const res = authStore.getFriendRequests(username);
    if (!res.ok) return;
    broadcastToUserSessions(username, (client) => {
      client.send(JSON.stringify({
        type: 'friend-requests',
        incoming: res.incoming || [],
        outgoing: res.outgoing || [],
      }));
    });
  }

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
    let username = null;
    let initialized = false;

    console.log(`[+] Client ${clientId} connecté (${ip})`);

    const joinTimeout = setTimeout(() => {
      if (!initialized) {
        ws.close(1008, 'Init timeout');
      }
    }, 10_000);

    function bindUser(newUsername) {
      if (username && userSessions.has(username)) {
        const sessions = userSessions.get(username);
        sessions.delete(ws);
        if (sessions.size === 0) {
          userSessions.delete(username);
        }
        updatePresenceOnline(username);
        notifyContactsOfStatus(username);
      }

      username = newUsername || null;
      if (!username) return;

      let sessions = userSessions.get(username);
      if (!sessions) {
        sessions = new Set();
        userSessions.set(username, sessions);
      }
      sessions.add(ws);
      updatePresenceOnline(username);
      notifyContactsOfStatus(username);
    }

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (!initialized) {
        initialized = true;
        clearTimeout(joinTimeout);
      }

      switch (msg.type) {

        // Authentification & contacts
        case 'attach-user': {
          const rawUser = (msg.username || msg.user || '').toString().trim().toLowerCase();
          if (!rawUser) break;

          let finalUser = rawUser;
          if (typeof authStore.getUser === 'function') {
            const existing = authStore.getUser(rawUser);
            if (existing && existing.username) {
              finalUser = existing.username;
            }
          }
          bindUser(finalUser);
          sendPresenceSnapshot(ws);
          break;
        }

        case 'register': {
          const { username: rawUser, password } = msg;
          const result = authStore.registerUser(rawUser, password);
          if (!result.ok) {
            ws.send(JSON.stringify({ type: 'auth-error', message: result.error }));
            return;
          }

          bindUser(result.user.username);

          const contacts = (result.user.contacts || []).map((name) => buildStatusPayload(name));
          ws.send(JSON.stringify({
            type: 'auth-ok',
            username: result.user.username,
            contacts,
            incomingRequests: result.user.incomingRequests || [],
            outgoingRequests: result.user.outgoingRequests || [],
            isNew: true,
          }));
          break;
        }

        case 'login': {
          const { username: rawUser, password } = msg;
          const result = authStore.validateUser(rawUser, password);
          if (!result.ok) {
            ws.send(JSON.stringify({ type: 'auth-error', message: result.error }));
            return;
          }

          bindUser(result.user.username);

          const contacts = (result.user.contacts || []).map((name) => buildStatusPayload(name));
          ws.send(JSON.stringify({
            type: 'auth-ok',
            username: result.user.username,
            contacts,
            incomingRequests: result.user.incomingRequests || [],
            outgoingRequests: result.user.outgoingRequests || [],
          }));
          break;
        }

        case 'logout': {
          if (!username) {
            ws.send(JSON.stringify({ type: 'auth-error', message: 'Non authentifié.' }));
            break;
          }
          const oldUser = username;
          bindUser(null);
          ws.send(JSON.stringify({ type: 'auth-logged-out', username: oldUser }));
          break;
        }

        case 'get-contacts': {
          if (!username) {
            ws.send(JSON.stringify({ type: 'auth-error', message: 'Non authentifié.' }));
            break;
          }
          sendContactsList(username, ws);
          break;
        }

        case 'get-friend-requests': {
          if (!username) {
            ws.send(JSON.stringify({ type: 'auth-error', message: 'Non authentifié.' }));
            break;
          }
          sendFriendRequests(username, ws);
          break;
        }

        case 'add-contact': {
          if (!username) {
            ws.send(JSON.stringify({ type: 'auth-error', message: 'Non authentifié.' }));
            break;
          }
          const contactName = msg.contact || msg.username;
          const res = authStore.addContact(username, contactName);
          if (!res.ok) {
            ws.send(JSON.stringify({ type: 'contacts-error', message: res.error }));
            break;
          }
          const contacts = (res.contacts || []).map((name) => buildStatusPayload(name));
          ws.send(JSON.stringify({ type: 'contacts-list', contacts }));
          notifyContactsOfStatus(username);
          break;
        }

        case 'friend-request': {
          if (!username) {
            ws.send(JSON.stringify({ type: 'auth-error', message: 'Non authentifié.' }));
            break;
          }
          const targetName = (msg.to || msg.target || msg.contact || msg.username || '').toString();
          if (!targetName) {
            ws.send(JSON.stringify({ type: 'friend-error', message: 'Nom de contact manquant.' }));
            break;
          }

          const res = authStore.sendFriendRequest(username, targetName);
          if (!res.ok) {
            ws.send(JSON.stringify({ type: 'friend-error', message: res.error }));
            break;
          }

          notifyFriendRequests(username);
          notifyFriendRequests(targetName);

          ws.send(JSON.stringify({ type: 'friend-request-sent', to: targetName, autoAccepted: !!res.autoAccepted }));

          broadcastToUserSessions(targetName, (client) => {
            client.send(JSON.stringify({ type: 'friend-request-incoming', from: username }));
          });

          if (res.autoAccepted) {
            broadcastToUserSessions(username, (client) => {
              sendContactsList(username, client);
            });
            broadcastToUserSessions(targetName, (client) => {
              sendContactsList(targetName, client);
            });
            notifyContactsOfStatus(username);
            notifyContactsOfStatus(targetName);
          }
          break;
        }

        case 'friend-request-notify': {
          if (!username) {
            ws.send(JSON.stringify({ type: 'auth-error', message: 'Non authentifié.' }));
            break;
          }
          const targetName = (msg.to || msg.target || msg.contact || msg.username || '').toString().trim().toLowerCase();
          if (!targetName) break;

          broadcastToUserSessions(targetName, (client) => {
            client.send(JSON.stringify({ type: 'friend-request-incoming', from: username }));
          });
          break;
        }

        case 'friend-accept-notify': {
          if (!username) {
            ws.send(JSON.stringify({ type: 'auth-error', message: 'Non authentifié.' }));
            break;
          }
          const other = (msg.target || msg.to || msg.username || msg.contact || '').toString().trim().toLowerCase();
          if (!other) break;

          broadcastToUserSessions(other, (client) => {
            client.send(JSON.stringify({ type: 'friend-request-accepted', from: username }));
          });
          // La persistance des contacts est gérée par l'API FastAPI.
          // Ici on force la synchro de présence des deux côtés immédiatement.
          broadcastToUserSessions(username, (client) => {
            sendContactsList(username, client);
          });
          broadcastToUserSessions(other, (client) => {
            sendContactsList(other, client);
          });
          notifyContactsOfStatus(username);
          notifyContactsOfStatus(other);
          break;
        }

        case 'friend-reject-notify': {
          if (!username) {
            ws.send(JSON.stringify({ type: 'auth-error', message: 'Non authentifié.' }));
            break;
          }
          const other = (msg.target || msg.to || msg.username || msg.contact || '').toString().trim().toLowerCase();
          if (!other) break;

          broadcastToUserSessions(other, (client) => {
            client.send(JSON.stringify({ type: 'friend-request-rejected', from: username }));
          });
          break;
        }

        case 'friend-cancel-notify': {
          if (!username) {
            ws.send(JSON.stringify({ type: 'auth-error', message: 'Non authentifié.' }));
            break;
          }
          const other = (msg.target || msg.to || msg.username || msg.contact || '').toString().trim().toLowerCase();
          if (!other) break;

          broadcastToUserSessions(other, (client) => {
            client.send(JSON.stringify({ type: 'friend-request-cancelled', from: username }));
          });
          break;
        }

        case 'remove-contact-notify': {
          if (!username) {
            ws.send(JSON.stringify({ type: 'auth-error', message: 'Non authentifié.' }));
            break;
          }
          const other = (msg.target || msg.to || msg.username || msg.contact || '').toString().trim().toLowerCase();
          if (!other) break;

          broadcastToUserSessions(other, (client) => {
            client.send(JSON.stringify({ type: 'contact-removed', from: username }));
          });
          notifyContactsOfStatus(username);
          notifyContactsOfStatus(other);
          break;
        }

        case 'friend-accept': {
          if (!username) {
            ws.send(JSON.stringify({ type: 'auth-error', message: 'Non authentifié.' }));
            break;
          }
          const fromName = (msg.from || msg.username || msg.contact || '').toString();
          if (!fromName) {
            ws.send(JSON.stringify({ type: 'friend-error', message: 'Nom de contact manquant.' }));
            break;
          }

          const res = authStore.acceptFriendRequest(username, fromName);
          if (!res.ok) {
            ws.send(JSON.stringify({ type: 'friend-error', message: res.error }));
            break;
          }

          notifyFriendRequests(username);
          notifyFriendRequests(fromName);

          broadcastToUserSessions(username, (client) => {
            sendContactsList(username, client);
          });
          broadcastToUserSessions(fromName, (client) => {
            sendContactsList(fromName, client);
          });

          broadcastToUserSessions(username, (client) => {
            client.send(JSON.stringify({ type: 'friend-request-accepted', from: fromName }));
          });
          broadcastToUserSessions(fromName, (client) => {
            client.send(JSON.stringify({ type: 'friend-request-accepted', from: username }));
          });

          notifyContactsOfStatus(username);
          notifyContactsOfStatus(fromName);
          break;
        }

        case 'friend-reject': {
          if (!username) {
            ws.send(JSON.stringify({ type: 'auth-error', message: 'Non authentifié.' }));
            break;
          }
          const fromName = (msg.from || msg.username || msg.contact || '').toString();
          if (!fromName) {
            ws.send(JSON.stringify({ type: 'friend-error', message: 'Nom de contact manquant.' }));
            break;
          }

          const res = authStore.rejectFriendRequest(username, fromName);
          if (!res.ok) {
            ws.send(JSON.stringify({ type: 'friend-error', message: res.error }));
            break;
          }

          notifyFriendRequests(username);
          notifyFriendRequests(fromName);

          broadcastToUserSessions(fromName, (client) => {
            client.send(JSON.stringify({ type: 'friend-request-rejected', from: username }));
          });
          break;
        }

        case 'remove-contact': {
          if (!username) {
            ws.send(JSON.stringify({ type: 'auth-error', message: 'Non authentifié.' }));
            break;
          }
          const contactName = msg.contact || msg.username;
          const res = authStore.removeContact(username, contactName);
          if (!res.ok) {
            ws.send(JSON.stringify({ type: 'contacts-error', message: res.error }));
            break;
          }
          const contacts = (res.contacts || []).map((name) => buildStatusPayload(name));
          ws.send(JSON.stringify({ type: 'contacts-list', contacts }));
          if (contactName) {
            broadcastToUserSessions(contactName, (client) => {
              sendContactsList(contactName, client);
            });
            notifyContactsOfStatus(username);
            notifyContactsOfStatus(contactName);
          }
          break;
        }

        case 'presence-info': {
          if (!username) {
            ws.send(JSON.stringify({ type: 'auth-error', message: 'Non authentifié.' }));
            break;
          }
          const meta = {
            host: msg.host || null,
            mode: msg.mode === 'remote' ? 'remote' : 'local',
          };
          updatePresenceMeta(username, meta);
          notifyContactsOfStatus(username);
          break;
        }

        case 'join': {
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
          if (clientRole === 'broadcaster' && username) {
            updatePresenceSharing(username, true, code);
            notifyContactsOfStatus(username);
          }
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

      if (username && userSessions.has(username)) {
        const sessions = userSessions.get(username);
        sessions.delete(ws);
        if (sessions.size === 0) {
          userSessions.delete(username);
        }
        updatePresenceOnline(username);
        notifyContactsOfStatus(username);
      }
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

      if (username && clientRole === 'broadcaster') {
        const p = ensurePresence(username);
        if (p.roomCode === clientRoom) {
          updatePresenceSharing(username, false, null);
          notifyContactsOfStatus(username);
        }
      }

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

ipcMain.handle('get-turn-credentials', async () => {
  const base = process.env.REMOTE_SIGNALING_URL || DEFAULT_REMOTE_SIGNALING_URL;
  if (!base) return null;

  try {
    const baseUrl = new URL(base);
    if (baseUrl.protocol === 'wss:') baseUrl.protocol = 'https:';
    else if (baseUrl.protocol === 'ws:') baseUrl.protocol = 'http:';

    baseUrl.pathname = '/api/turn-credentials';
    baseUrl.search = '';

    const res = await fetch(baseUrl.toString());
    if (!res.ok) {
      console.error('get-turn-credentials: HTTP', res.status);
      return null;
    }
    const data = await res.json();
    return data;
  } catch (err) {
    console.error('get-turn-credentials failed:', err);
    return null;
  }
});

ipcMain.handle('get-app-version', () => {
  try {
    return app.getVersion();
  } catch {
    return '';
  }
});

ipcMain.handle('get-release-notes', async (_event, versionOverride) => {
  const version = (versionOverride || app.getVersion() || '').toString();
  if (!version) {
    return { ok: false, message: 'Version inconnue.' };
  }

  const owner = 'DavalEnzo';
  const repo = 'share-screen';
  const tag = `v${version}`;
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;

  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ScreenSharePro-Updater',
      },
    });

    if (!res.ok) {
      console.error('[release-notes] HTTP', res.status, 'pour', url);
      if (res.status === 404) {
        return { ok: false, message: `Aucun changelog trouvé pour la version ${version}.` };
      }
      return { ok: false, message: 'Impossible de récupérer le changelog depuis GitHub.' };
    }

    const data = await res.json();
    const notes = (data && typeof data.body === 'string') ? data.body : '';
    if (!notes.trim()) {
      return { ok: false, message: `Aucun changelog trouvé pour la version ${version}.` };
    }

    return { ok: true, version, notes };
  } catch (err) {
    console.error('[release-notes] Erreur:', err);
    return { ok: false, message: 'Erreur lors de la récupération du changelog.' };
  }
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

ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) {
    return { ok: false, message: 'Mises à jour automatiques indisponibles en mode développement.' };
  }

  const currentVersion = app.getVersion();

  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result) {
      return { ok: true, message: `Vous utilisez déjà la dernière version (${currentVersion}).` };
    }
    const { updateInfo } = result;
    if (!updateInfo || !updateInfo.version || updateInfo.version === currentVersion) {
      return { ok: true, message: `Vous utilisez déjà la dernière version (${currentVersion}).` };
    }

    return {
      ok: true,
      message: `Version ${updateInfo.version} disponible. Le téléchargement démarre...`,
    };
  } catch (err) {
    console.error('[autoUpdater] check-for-updates (manuel) a échoué:', err);
    return { ok: false, message: 'Erreur lors de la recherche de mises à jour.' };
  }
});

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

// ─── Auto-update (electron-updater) ─────────────────────────────────────────

app.whenReady().then(() => {
  if (!app.isPackaged) {
    console.log('[autoUpdater] Désactivé en mode développement');
    return;
  }

  autoUpdater.autoDownload = true;

  autoUpdater.on('error', (err) => {
    console.error('[autoUpdater] Erreur:', err == null ? 'inconnue' : err.message || err);
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[autoUpdater] Mise à jour disponible', info.version);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[autoUpdater] Mise à jour téléchargée', info.version);
    let notes = '';
    if (typeof info.releaseNotes === 'string') {
      notes = info.releaseNotes;
    } else if (Array.isArray(info.releaseNotes)) {
      notes = info.releaseNotes.map(entry => entry && entry.note ? String(entry.note) : '').join('\n\n');
    }

    if (mainWindow && mainWindow.webContents) {
      try {
        mainWindow.webContents.send('update-downloaded', {
          version: info.version,
          notes,
        });
      } catch (_) {}
    }

    // Applique la mise à jour au prochain redémarrage après un court délai
    setTimeout(() => {
      autoUpdater.quitAndInstall(false, true);
    }, 2000);
  });

  // Vérifie immédiatement au démarrage
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[autoUpdater] checkForUpdates a échoué:', err);
  });
});
