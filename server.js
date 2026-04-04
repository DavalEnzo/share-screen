/**
 * ScreenShare Pro — Serveur de signalisation WebSocket
 * Déployable sur Railway, Render, Fly.io (gratuit)
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const authStore = require('./authStore');
const crypto = require('crypto');

const PORT = process.env.PORT || 8765;
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_TTL = parseInt(process.env.TURN_TTL || '3600', 10); // en secondes

// ─── Serveur HTTP de base (requis par Railway pour le health check) ──────────
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      rooms: rooms.size,
      clients: wss ? wss.clients.size : 0,
      uptime: Math.floor(process.uptime()),
    }));
    return;
  }

  if (req.url && req.url.startsWith('/api/turn-credentials')) {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Méthode non autorisée' }));
      return;
    }

    if (!TURN_SECRET) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'TURN_SECRET non configuré sur le serveur' }));
      return;
    }

    try {
      const timestamp = Math.floor(Date.now() / 1000) + TURN_TTL;
      // Pour le mode REST de coturn, le username doit contenir le timestamp
      // d'expiration en première partie. Ici on n'ajoute aucun identifiant
      // utilisateur : la route génère des credentials anonymes éphémères.
      const username = String(timestamp);
      const password = crypto
        .createHmac('sha1', TURN_SECRET)
        .update(username)
        .digest('base64');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ username, password, ttl: TURN_TTL }));
    } catch (err) {
      console.error('Erreur /api/turn-credentials:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erreur serveur TURN credentials' }));
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ScreenShare Pro — Signaling Server\n');
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

// rooms : Map<roomCode, Set<{ws, role, id}>>
const rooms = new Map();

// Presence : username -> { online, sharing, roomCode, host, mode }
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

    // Si la relation n'est pas mutuelle, masquer le statut / partage
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

// Nettoyage des rooms vides toutes les 5 minutes
setInterval(() => {
  for (const [code, members] of rooms) {
    if (members.size === 0) rooms.delete(code);
  }
}, 5 * 60 * 1000);

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const clientId = Math.random().toString(36).slice(2, 8);
  let clientRoom = null;
  let clientRole = null;
   let username = null;
  let initialized = false;

  console.log(`[+] Client ${clientId} connecté (${ip})`);

  // Timeout : déconnecter si aucun message reçu dans les 10 secondes
  const joinTimeout = setTimeout(() => {
    if (!initialized) {
      ws.close(1008, 'Init timeout');
    }
  }, 10_000);

  function bindUser(newUsername) {
    // Détacher l'ancienne association le cas échéant
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
      return; // Ignore les messages invalides
    }

    if (!initialized) {
      initialized = true;
      clearTimeout(joinTimeout);
    }

    switch (msg.type) {

      // ─── Authentification & contacts ──────────────────────────────────────
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
        // Informer le contact de l'état courant de l'utilisateur
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

        // Rafraîchir les listes de demandes pour les deux utilisateurs
        notifyFriendRequests(username);
        notifyFriendRequests(targetName);

        // Notifier l'expéditeur
        ws.send(JSON.stringify({ type: 'friend-request-sent', to: targetName, autoAccepted: !!res.autoAccepted }));

        // Notifier le destinataire en temps réel
        broadcastToUserSessions(targetName, (client) => {
          client.send(JSON.stringify({ type: 'friend-request-incoming', from: username }));
        });

        // Si la demande a été auto-acceptée (croisée), mettre à jour les contacts
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

        // Notifier uniquement en temps réel : la persistance est gérée par l'API FastAPI
        broadcastToUserSessions(targetName, (client) => {
          client.send(JSON.stringify({ type: 'friend-request-incoming', from: username }));
        });
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

        // Rafraîchir les contacts des deux côtés
        broadcastToUserSessions(username, (client) => {
          sendContactsList(username, client);
        });
        broadcastToUserSessions(fromName, (client) => {
          sendContactsList(fromName, client);
        });

        // Notifier les deux utilisateurs
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
        // Rafraîchir aussi la liste de contacts de l'autre côté et la présence
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

        // Limiter à 1 broadcaster + 10 viewers max
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

        // Informer les autres membres
        broadcast(code, ws, { type: 'peer-joined', role: clientRole, id: clientId });

        // Si viewer : informer les broadcasters pour qu'ils initient l'offre
        if (clientRole === 'viewer') {
          broadcastTo(code, 'broadcaster', ws, { type: 'viewer-ready', viewerId: clientId });
        }

        console.log(`[=] ${clientId} (${clientRole}) → room "${code}" (${room.size} membres)`);

        // Mettre à jour le statut de partage pour les contacts
        if (clientRole === 'broadcaster' && username) {
          updatePresenceSharing(username, true, code);
          notifyContactsOfStatus(username);
        }
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        // Relay vers le destinataire ciblé ou broadcast
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

    // Nettoyage des sessions utilisateur / présence
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

    // Trouver et supprimer ce client
    for (const member of room) {
      if (member.id === clientId) {
        room.delete(member);
        break;
      }
    }

    broadcast(clientRoom, ws, { type: 'peer-left', role: clientRole, id: clientId });
    console.log(`[-] ${clientId} (${clientRole}) quitte "${clientRoom}" (${room.size} restants)`);

    // Si c'était un diffuseur, mettre à jour son statut de partage
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

  // ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ Signaling server démarré sur le port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM reçu, fermeture propre...');
  wss.clients.forEach(client => client.close(1001, 'Server shutting down'));
  server.close(() => process.exit(0));
});
