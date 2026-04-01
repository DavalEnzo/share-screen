/**
 * ScreenShare Pro — Serveur de signalisation WebSocket
 * Déployable sur Railway, Render, Fly.io (gratuit)
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8765;

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
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ScreenShare Pro — Signaling Server\n');
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

// rooms : Map<roomCode, Set<{ws, role, id}>>
const rooms = new Map();

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

  console.log(`[+] Client ${clientId} connecté (${ip})`);

  // Timeout : déconnecter si pas de 'join' dans les 10 secondes
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
      return; // Ignore les messages invalides
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
