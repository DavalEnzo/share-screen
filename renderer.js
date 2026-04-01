// ─── Config ───────────────────────────────────────────────────────────────────
// 🔧 APRÈS déploiement sur Railway, remplace cette URL par la tienne :
//    ex: wss://screenshare-signaling.up.railway.app
// En local (développement), le serveur local sur port 8765 est utilisé en fallback.
const REMOTE_SIGNALING_URL = 'wss://share-screen-production.up.railway.app';
const USE_REMOTE = !REMOTE_SIGNALING_URL.includes('TON-PROJET');

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  mode: USE_REMOTE ? 'remote' : 'local',
  selectedSourceId: null,
  resolution: 1080,
  fps: 60,
  bitrate: 8000000,
  localStream: null,
  peerConnections: new Map(),
  signalingWs: null,
  roomCode: null,
  signalingPort: 8765,
  localIp: 'localhost',
  isSharing: false,
  peerCount: 0,
  // Receiver
  receiverPc: null,
  receiverWs: null,
  receiverTargetId: null,
};

// ─── ICE config (STUN public + TURN Metered.ca gratuit) ──────────────────────
// 🔧 Après inscription sur https://www.metered.ca/tools/openrelay/
//    remplace les credentials TURN ci-dessous par les tiens.
const ICE_CONFIG = {
  iceServers: [
    // STUN Google (fonctionne pour ~70% des connexions)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // TURN OpenRelay (Metered.ca — gratuit 500MB/mois)
    // Décommenter après avoir créé un compte sur metered.ca :
    // {
    //   urls: 'turn:openrelay.metered.ca:80',
    //   username: 'openrelayproject',
    //   credential: 'openrelayproject',
    // },
    // {
    //   urls: 'turn:openrelay.metered.ca:443',
    //   username: 'openrelayproject',
    //   credential: 'openrelayproject',
    // },
    // {
    //   urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    //   username: 'openrelayproject',
    //   credential: 'openrelayproject',
    // },
  ]
};

// ─── Signaling URL helper ─────────────────────────────────────────────────────
function getSignalingUrl(host) {
  // Si on a configuré un serveur distant, l'utiliser
  if (USE_REMOTE) return REMOTE_SIGNALING_URL;
  // Sinon : serveur local (LAN / développement)
  const h = host || 'localhost';
  return `ws://${h}:${state.signalingPort}`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const [ip, port] = await Promise.all([
    window.electronAPI.getLocalIp(),
    window.electronAPI.getSignalingPort(),
  ]);
  state.localIp = ip;
  state.signalingPort = port;

  document.getElementById('localIpField').value = USE_REMOTE ? 'Serveur distant' : ip;
  document.getElementById('localIpDisplay').textContent = USE_REMOTE ? 'Mode: distant' : `IP: ${ip}`;
  document.getElementById('settingsIp').textContent = USE_REMOTE ? REMOTE_SIGNALING_URL : ip;
  document.getElementById('settingsPort').textContent = USE_REMOTE ? 'WSS/443' : port;

  // Pré-remplir le champ host côté récepteur
  if (USE_REMOTE) {
    const joinHostEl = document.getElementById('joinHostInput');
    joinHostEl.value = 'Automatique (serveur distant)';
    joinHostEl.readOnly = true;
    joinHostEl.style.opacity = '0.5';
  } else {
    document.getElementById('joinHostInput').placeholder = `${ip} ou localhost`;
  }

  // Afficher le mode actif
  if (USE_REMOTE) {
    notify('Mode distant actif — serveur Railway connecté', 'success');
  } else {
    notify('Mode local — configurez REMOTE_SIGNALING_URL pour accès public', 'info');
  }

  generateRoomCode();
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${name}`).classList.add('active');
  document.getElementById(`nav-${name}`).classList.add('active');
}

// ─── Room code ────────────────────────────────────────────────────────────────
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    if (i === 3) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  state.roomCode = code;
  document.getElementById('roomCodeDisplay').textContent = code;
}

function copyRoomCode() {
  navigator.clipboard.writeText(state.roomCode);
  notify('Code copié dans le presse-papier !', 'success');
}

// ─── Mode selector ────────────────────────────────────────────────────────────
function selectMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('selected'));
  document.getElementById(`mode-${mode}`).classList.add('selected');
}

// ─── Quality selectors ────────────────────────────────────────────────────────
function selectRes(el) {
  document.querySelectorAll('#resPills .quality-pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  state.resolution = parseInt(el.dataset.res);
}

function selectFps(el) {
  document.querySelectorAll('#fpsPills .quality-pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  state.fps = parseInt(el.dataset.fps);
}

function selectBitrate(el) {
  document.querySelectorAll('#bitratePills .quality-pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  state.bitrate = parseInt(el.dataset.bitrate);
}

// ─── Sources ──────────────────────────────────────────────────────────────────
async function loadSources() {
  const grid = document.getElementById('sourcesGrid');
  grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--text-dim);font-family:var(--mono);font-size:12px">Chargement...</div>';

  try {
    const sources = await window.electronAPI.getSources();
    grid.innerHTML = '';

    sources.forEach(src => {
      const div = document.createElement('div');
      div.className = 'source-item';
      div.dataset.id = src.id;
      const thumbSrc = src.thumbnail || src.appIcon || '';
      div.innerHTML = `
        <img class="source-thumb" src="${thumbSrc}" alt="${src.name}">
        <div class="source-name">${src.name}</div>
      `;
      const img = div.querySelector('.source-thumb');
      if (!thumbSrc) {
        img.style.objectFit = 'contain';
        img.style.padding = '20px';
      }
      img.onerror = () => {
        img.style.background = 'var(--surface2)';
        img.style.objectFit = 'contain';
      };
      div.onclick = () => {
        document.querySelectorAll('.source-item').forEach(s => s.classList.remove('selected'));
        div.classList.add('selected');
        state.selectedSourceId = src.id;
      };
      grid.appendChild(div);
    });

    if (sources.length === 0) {
      grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--text-dim);font-family:var(--mono);font-size:12px">Aucune source trouvée</div>';
    }
  } catch (e) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--red);font-family:var(--mono);font-size:12px">Erreur lors du chargement</div>';
    notify('Erreur : ' + e.message, 'error');
  }
}

// ─── Capture ──────────────────────────────────────────────────────────────────
async function getCaptureStream() {
  const resMap = { 720: 1280, 1080: 1920, 1440: 2560 };
  const width = resMap[state.resolution] || 1920;
  const height = state.resolution;
  const wantAudio = document.getElementById('captureAudio').checked;

  if (state.selectedSourceId) {
    // Electron 20+ : getUserMedia avec chromeMediaSource pour la source choisie manuellement.
    // Le setDisplayMediaRequestHandler dans main.js a déjà accordé la permission.
    return await navigator.mediaDevices.getUserMedia({
      audio: wantAudio ? {
        mandatory: { chromeMediaSource: 'desktop' }
      } : false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: state.selectedSourceId,
          minWidth: width,
          maxWidth: width,
          minHeight: height,
          maxHeight: height,
          minFrameRate: state.fps,
          maxFrameRate: state.fps,
        }
      }
    });
  }

  // Aucune source sélectionnée → getDisplayMedia standard.
  // Le setDisplayMediaRequestHandler dans main.js répond automatiquement
  // avec la première source disponible (pas de dialog natif).
  return await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: state.fps },
    },
    audio: wantAudio,
  });
}

// ─── Share ─────────────────────────────────────────────────────────────────────
async function startSharing() {
  try {
    updateTitle('Démarrage...');
    notify('Démarrage de la capture...', 'info');

    state.localStream = await getCaptureStream();

    // Apply video constraints for quality
    const videoTrack = state.localStream.getVideoTracks()[0];
    if (videoTrack) {
      const resMap = { 720: 1280, 1080: 1920, 1440: 2560 };
      await videoTrack.applyConstraints({
        width: { ideal: resMap[state.resolution] },
        height: { ideal: state.resolution },
        frameRate: { ideal: state.fps },
      }).catch(() => {}); // Ignore if not supported
    }

    // Show preview
    const preview = document.getElementById('previewVideo');
    preview.srcObject = state.localStream;

    // Connect to signaling
    connectSignaling('broadcaster');

    // Update UI
    state.isSharing = true;
    document.getElementById('startBtn').style.display = 'none';
    document.getElementById('stopBtn').style.display = '';
    document.getElementById('previewCard').style.display = '';
    document.getElementById('statRes').textContent = `${state.resolution}p`;
    document.getElementById('statFps').textContent = state.fps;

    // Handle stream end
    if (videoTrack) {
      videoTrack.onended = () => stopSharing();
    }

    updateStatus('Partage en cours', 'green');
    updateTitle(`📡 Partage actif — ${state.roomCode}`);
    notify('Partage démarré ! Partagez le code de session.', 'success');

  } catch (e) {
    notify('Erreur capture : ' + e.message, 'error');
    updateTitle('Erreur');
    console.error(e);
  }
}

function stopSharing() {
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }

  state.peerConnections.forEach(pc => pc.close());
  state.peerConnections.clear();

  if (state.signalingWs) {
    state.signalingWs.close();
    state.signalingWs = null;
  }

  state.isSharing = false;
  state.peerCount = 0;

  document.getElementById('startBtn').style.display = '';
  document.getElementById('stopBtn').style.display = 'none';
  document.getElementById('previewCard').style.display = 'none';
  document.getElementById('previewVideo').srcObject = null;
  document.getElementById('statPeers').textContent = '0';

  updateStatus('Déconnecté', 'off');
  updateTitle('Prêt');
  notify('Partage arrêté.', 'info');
}

// ─── Signaling (broadcaster) ──────────────────────────────────────────────────
function connectSignaling(role) {
  // Utilise le serveur distant si configuré, sinon localhost
  const wsUrl = getSignalingUrl();
  state.signalingWs = new WebSocket(wsUrl);

  state.signalingWs.onopen = () => {
    state.signalingWs.send(JSON.stringify({ type: 'join', room: state.roomCode, role }));
  };

  state.signalingWs.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'error') {
      notify(`Erreur serveur : ${msg.message}`, 'error');
      return;
    }

    // Nouveau protocole: le serveur envoie 'viewer-ready' quand un viewer rejoint.
    if (msg.type === 'viewer-ready') {
      const peerId = msg.viewerId || msg.id || Date.now().toString();
      if (!state.peerConnections.has(peerId)) {
        await createBroadcasterPeer(peerId);
      }
    }

    if (msg.type === 'answer') {
      // Matcher la réponse au bon peer via fromId
      const pc = msg.fromId
        ? state.peerConnections.get(msg.fromId)
        : [...state.peerConnections.values()][state.peerConnections.size - 1];
      if (pc && msg.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
      }
    }

    if (msg.type === 'ice-candidate' && msg.candidate) {
      const pc = msg.fromId
        ? state.peerConnections.get(msg.fromId)
        : null;
      if (pc) {
        try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
      } else {
        // Fallback : essayer tous les peers
        state.peerConnections.forEach(async p => {
          try { await p.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
        });
      }
    }

    if (msg.type === 'peer-left') {
      state.peerCount = Math.max(0, state.peerCount - 1);
      document.getElementById('statPeers').textContent = state.peerCount;
    }
  };

  state.signalingWs.onerror = () => {
    notify('Erreur de connexion au serveur de signalisation.', 'error');
  };
}

async function createBroadcasterPeer(peerId) {
  const pc = new RTCPeerConnection(ICE_CONFIG);
  state.peerConnections.set(peerId, pc);

  // Add all tracks
  if (state.localStream) {
    state.localStream.getTracks().forEach(track => {
      pc.addTrack(track, state.localStream);
    });
  }

  // Set encoding parameters for quality
  pc.getSenders().forEach(sender => {
    if (sender.track && sender.track.kind === 'video') {
      const params = sender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      params.encodings[0].maxBitrate = state.bitrate;
      params.encodings[0].maxFramerate = state.fps;
      sender.setParameters(params).catch(() => {});
    }
  });

  pc.onicecandidate = ({ candidate }) => {
    if (candidate && state.signalingWs) {
      state.signalingWs.send(JSON.stringify({ type: 'ice-candidate', candidate, targetId: peerId }));
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      state.peerCount++;
      document.getElementById('statPeers').textContent = state.peerCount;
      notify('Un spectateur a rejoint la session !', 'success');
    }
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      state.peerConnections.delete(peerId);
    }
  };

  const offer = await pc.createOffer({ offerToReceiveVideo: false, offerToReceiveAudio: false });
  await pc.setLocalDescription(offer);

  state.signalingWs.send(JSON.stringify({ type: 'offer', sdp: offer.sdp, targetId: peerId }));
}

// ─── Receive ──────────────────────────────────────────────────────────────────
async function joinSession() {
  const code = document.getElementById('joinCodeInput').value.trim();
  const host = document.getElementById('joinHostInput').value.trim() || 'localhost';

  if (!code) { notify('Entrez un code de session.', 'error'); return; }

  document.getElementById('joinBtn').disabled = true;
  document.getElementById('joinBtn').textContent = 'Connexion...';

  updateReceiveStatus('connecting');

  try {
    // Utilise le serveur distant si configuré, sinon le host saisi manuellement
    const wsUrl = getSignalingUrl(host);
    state.receiverWs = new WebSocket(wsUrl);

    state.receiverWs.onopen = () => {
      state.receiverWs.send(JSON.stringify({ type: 'join', room: code, role: 'viewer' }));
    };

    state.receiverWs.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'offer') {
        await handleReceiverOffer(msg);
      }

      if (msg.type === 'ice-candidate' && msg.candidate) {
        if (state.receiverPc) {
          try { await state.receiverPc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
        }
      }

      if (msg.type === 'peer-left') {
        notify('Le diffuseur a quitté la session.', 'error');
        leaveSession();
      }
    };

    state.receiverWs.onerror = () => {
      notify('Impossible de se connecter au serveur.', 'error');
      document.getElementById('joinBtn').disabled = false;
      document.getElementById('joinBtn').textContent = '📥 Rejoindre la session';
      updateReceiveStatus('idle');
    };

    state.receiverWs.onclose = () => {
      if (!state.receiverPc || state.receiverPc.connectionState !== 'connected') {
        document.getElementById('joinBtn').disabled = false;
        document.getElementById('joinBtn').textContent = '📥 Rejoindre la session';
        updateReceiveStatus('idle');
      }
    };

    // Timeout
    setTimeout(() => {
      if (!state.receiverPc) {
        notify('Timeout : aucune offre reçue. Vérifiez le code.', 'error');
        leaveSession();
      }
    }, 10000);

  } catch (e) {
    notify('Erreur : ' + e.message, 'error');
    document.getElementById('joinBtn').disabled = false;
    document.getElementById('joinBtn').textContent = '📥 Rejoindre la session';
    updateReceiveStatus('idle');
  }
}

async function handleReceiverOffer(offer) {
  state.receiverTargetId = offer.fromId || null;
  state.receiverPc = new RTCPeerConnection(ICE_CONFIG);

  state.receiverPc.ontrack = (event) => {
    const video = document.getElementById('remoteVideo');
    if (!video.srcObject) video.srcObject = event.streams[0];
    video.play().catch(() => {});

    // Show remote card
    document.getElementById('remoteCard').style.display = '';

    // Start measuring
    startRecvStats(event.streams[0]);
  };

  state.receiverPc.onicecandidate = ({ candidate }) => {
    if (candidate && state.receiverWs) {
      state.receiverWs.send(JSON.stringify({ type: 'ice-candidate', candidate, targetId: state.receiverTargetId }));
    }
  };

  state.receiverPc.onconnectionstatechange = () => {
    if (state.receiverPc.connectionState === 'connected') {
      updateReceiveStatus('connected');
      document.getElementById('joinBtn').textContent = '✓ Connecté';
      notify('Flux reçu avec succès !', 'success');
    }
    if (['disconnected', 'failed'].includes(state.receiverPc.connectionState)) {
      updateReceiveStatus('idle');
      notify('Connexion perdue.', 'error');
    }
  };

  await state.receiverPc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await state.receiverPc.createAnswer();
  await state.receiverPc.setLocalDescription(answer);

  state.receiverWs.send(JSON.stringify({ type: 'answer', sdp: answer.sdp, targetId: state.receiverTargetId }));
}

function leaveSession() {
  if (state.receiverWs) { state.receiverWs.close(); state.receiverWs = null; }
  if (state.receiverPc) { state.receiverPc.close(); state.receiverPc = null; }
  state.receiverTargetId = null;

  if (document.body.classList.contains('remote-fullscreen')) {
    setRemoteFullscreen(false);
  }

  const video = document.getElementById('remoteVideo');
  video.srcObject = null;
  document.getElementById('remoteCard').style.display = 'none';

  document.getElementById('joinBtn').disabled = false;
  document.getElementById('joinBtn').textContent = '📥 Rejoindre la session';
  updateReceiveStatus('idle');
}

async function setRemoteFullscreen(enabled) {
  document.body.classList.toggle('remote-fullscreen', enabled);
  const btn = document.getElementById('fullscreenBtn');
  if (btn) btn.textContent = enabled ? '🡼 Quitter le plein écran' : '⛶ Plein écran';

  // Prefer native Electron fullscreen to avoid DOM fullscreen inconsistencies.
  if (window.electronAPI?.setFullscreenWindow) {
    await window.electronAPI.setFullscreenWindow(enabled);
    return;
  }

  const container = document.getElementById('remoteContainer');
  if (!document.fullscreenElement) {
    if (enabled && container?.requestFullscreen) {
      container.requestFullscreen().catch(() => {});
    }
  } else if (!enabled && document.exitFullscreen) {
    document.exitFullscreen();
  }
}

function toggleFullscreen() {
  const enabled = !document.body.classList.contains('remote-fullscreen');
  setRemoteFullscreen(enabled).catch(() => {});
}

// ─── Stats (receiver) ─────────────────────────────────────────────────────────
function startRecvStats(stream) {
  const video = document.getElementById('remoteVideo');
  let lastTime = Date.now();

  const interval = setInterval(() => {
    if (!stream.active) { clearInterval(interval); return; }

    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w && h) {
      document.getElementById('recvRes').textContent = `${w}×${h}`;
    }

    // Rough FPS from WebRTC stats
    if (state.receiverPc) {
      state.receiverPc.getStats().then(stats => {
        stats.forEach(report => {
          if (report.type === 'inbound-rtp' && report.mediaType === 'video') {
            document.getElementById('recvFps').textContent = Math.round(report.framesPerSecond || 0);
          }
          if (report.type === 'candidate-pair' && report.nominated) {
            const rtt = report.currentRoundTripTime;
            if (rtt !== undefined) {
              document.getElementById('recvLatency').textContent = `${Math.round(rtt * 1000)}ms`;
            }
          }
        });
      }).catch(() => {});
    }
  }, 1000);
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function updateStatus(text, type) {
  const dot = document.getElementById('connDot');
  const label = document.getElementById('connStatus');
  label.textContent = text;
  dot.className = 'status-dot';
  if (type === 'green') { dot.classList.add('green'); dot.classList.add('pulse'); }
  else if (type === 'red') dot.classList.add('red');
}

function updateTitle(text) {
  document.getElementById('titleStatusText').textContent = text;
}

function updateReceiveStatus(status) {
  const el = document.getElementById('receiveStatus');
  if (status === 'connecting') {
    el.innerHTML = `
      <div style="text-align:center; padding:16px 0">
        <div class="connecting-anim" style="justify-content:center;margin-bottom:10px">
          <div class="dot-anim"></div><div class="dot-anim"></div><div class="dot-anim"></div>
        </div>
        <div style="color:var(--accent);font-family:var(--mono);font-size:12px">Connexion en cours...</div>
      </div>
    `;
  } else if (status === 'connected') {
    el.innerHTML = `
      <div class="info-row"><span class="info-key">État</span><span class="info-val" style="color:var(--green)">✓ Connecté</span></div>
      <div class="info-row"><span class="info-key">Code</span><span class="info-val accent">${document.getElementById('joinCodeInput').value.trim()}</span></div>
    `;
  } else {
    el.innerHTML = `
      <div style="text-align:center; padding:16px 0">
        <div style="font-size:32px; opacity:0.3">📡</div>
        <div style="margin-top:8px;font-size:12px">En attente de connexion...</div>
      </div>
    `;
  }
}

// ─── Notifications ────────────────────────────────────────────────────────────
function notify(message, type = 'info') {
  const stack = document.getElementById('notifStack');
  const div = document.createElement('div');
  div.className = `notif ${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}`;
  div.textContent = message;
  stack.appendChild(div);
  setTimeout(() => { div.style.opacity = '0'; div.style.transition = 'opacity 0.3s'; setTimeout(() => div.remove(), 300); }, 3500);
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
init();
