// ─── Config ───────────────────────────────────────────────────────────────────
// 🔧 APRÈS déploiement sur Railway, remplace cette URL par la tienne :
//    ex: wss://screenshare-signaling.up.railway.app
// En local (développement), le serveur local sur port 8765 est utilisé en fallback.
const DEFAULT_REMOTE_SIGNALING_URL = 'wss://share-screen-production.up.railway.app';
let remoteSignalingUrl = DEFAULT_REMOTE_SIGNALING_URL;

function useRemoteSignaling() {
  return Boolean(remoteSignalingUrl && !remoteSignalingUrl.includes('TON-PROJET'));
}

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  mode: 'local',
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
  signalingShouldReconnect: false,
  signalingReconnectAttempts: 0,
  signalingReconnectTimer: null,
  // Receiver
  receiverPc: null,
  receiverWs: null,
  receiverTargetId: null,
  receiverShouldReconnect: false,
  receiverReconnectAttempts: 0,
  receiverReconnectTimer: null,
  receiverOfferTimeout: null,
  receiverJoinCode: '',
  receiverJoinHost: 'localhost',
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
  if (useRemoteSignaling()) return remoteSignalingUrl;
  // Sinon : serveur local (LAN / développement)
  const h = host || 'localhost';
  return `ws://${h}:${state.signalingPort}`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const runtimeConfig = window.electronAPI.getRuntimeConfig ? window.electronAPI.getRuntimeConfig() : {};
  if (runtimeConfig.remoteSignalingUrl) {
    remoteSignalingUrl = runtimeConfig.remoteSignalingUrl.trim();
  }

  const [ip, port] = await Promise.all([
    window.electronAPI.getLocalIp(),
    window.electronAPI.getSignalingPort(),
  ]);
  state.localIp = ip;
  state.signalingPort = port;
  state.mode = useRemoteSignaling() ? 'remote' : 'local';

  document.getElementById('localIpField').value = useRemoteSignaling() ? 'Serveur distant' : ip;
  document.getElementById('localIpDisplay').textContent = useRemoteSignaling() ? 'Mode: distant' : `IP: ${ip}`;
  document.getElementById('settingsIp').textContent = useRemoteSignaling() ? remoteSignalingUrl : ip;
  document.getElementById('settingsPort').textContent = useRemoteSignaling() ? 'WSS/443' : port;

  // Pré-remplir le champ host côté récepteur
  if (useRemoteSignaling()) {
    const joinHostEl = document.getElementById('joinHostInput');
    joinHostEl.value = 'Automatique (serveur distant)';
    joinHostEl.readOnly = true;
    joinHostEl.style.opacity = '0.5';
  } else {
    document.getElementById('joinHostInput').placeholder = `${ip} ou localhost`;
  }

  // Afficher le mode actif
  if (useRemoteSignaling()) {
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

async function copyRoomCode() {
  const value = String(state.roomCode || '').trim();
  if (!value) {
    notify('Aucun code de session à copier.', 'error');
    return;
  }

  let copied = false;

  try {
    if (window.electronAPI?.copyToClipboard) {
      const ok = await window.electronAPI.copyToClipboard(value);
      copied = Boolean(ok);
    }

    if (!copied && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      copied = true;
    }

    if (!copied) {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.pointerEvents = 'none';
      document.body.appendChild(textarea);
      textarea.select();
      copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (!copied) throw new Error('execCommand copy failed');
    }

    notify('Code copié dans le presse-papier !', 'success');
  } catch (error) {
    console.error('Clipboard copy failed:', error);
    notify('Copie impossible. Essayez Ctrl+C sur le code.', 'error');
  }
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
  const wantSystemAudio = document.getElementById('captureAudio').checked;
  const wantMic = document.getElementById('captureMic').checked;
  const showCursor = document.getElementById('showCursor').checked;

  if (state.selectedSourceId) {
    // Electron 20+ : getUserMedia avec chromeMediaSource pour la source choisie manuellement.
    // Le setDisplayMediaRequestHandler dans main.js a déjà accordé la permission.
    const desktopStream = await navigator.mediaDevices.getUserMedia({
      audio: wantSystemAudio ? {
        mandatory: { chromeMediaSource: 'desktop' }
      } : false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: state.selectedSourceId,
          cursor: showCursor ? 'always' : 'never',
          minWidth: width,
          maxWidth: width,
          minHeight: height,
          maxHeight: height,
          minFrameRate: state.fps,
          maxFrameRate: state.fps,
        }
      }
    });

    if (wantMic) {
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false,
        });
        micStream.getAudioTracks().forEach(track => desktopStream.addTrack(track));
      } catch (e) {
        notify('Micro non disponible, audio système uniquement.', 'info');
      }
    }

    return desktopStream;
  }

  // Aucune source sélectionnée → getDisplayMedia standard.
  // Le setDisplayMediaRequestHandler dans main.js répond automatiquement
  // avec la première source disponible (pas de dialog natif).
  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: state.fps },
      cursor: showCursor ? 'always' : 'never',
    },
    audio: wantSystemAudio,
  });

  if (wantMic) {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      micStream.getAudioTracks().forEach(track => displayStream.addTrack(track));
    } catch (e) {
      notify('Micro non disponible, audio système uniquement.', 'info');
    }
  }

  return displayStream;
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
  state.signalingShouldReconnect = false;
  state.signalingReconnectAttempts = 0;
  if (state.signalingReconnectTimer) {
    clearTimeout(state.signalingReconnectTimer);
    state.signalingReconnectTimer = null;
  }

  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }

  state.peerConnections.forEach(pc => pc.close());
  state.peerConnections.clear();

  if (state.signalingWs) {
    state.signalingWs.onopen = null;
    state.signalingWs.onmessage = null;
    state.signalingWs.onerror = null;
    state.signalingWs.onclose = null;
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
  state.signalingShouldReconnect = true;
  state.signalingReconnectAttempts = 0;
  openBroadcasterSignaling(role, false);
}

function openBroadcasterSignaling(role, isReconnect) {
  const wsUrl = getSignalingUrl();

  if (state.signalingWs) {
    state.signalingWs.onopen = null;
    state.signalingWs.onmessage = null;
    state.signalingWs.onerror = null;
    state.signalingWs.onclose = null;
    try { state.signalingWs.close(); } catch {}
  }

  state.signalingWs = new WebSocket(wsUrl);

  state.signalingWs.onopen = () => {
    state.signalingReconnectAttempts = 0;
    if (state.signalingReconnectTimer) {
      clearTimeout(state.signalingReconnectTimer);
      state.signalingReconnectTimer = null;
    }

    if (isReconnect) {
      state.peerConnections.forEach(pc => pc.close());
      state.peerConnections.clear();
      state.peerCount = 0;
      document.getElementById('statPeers').textContent = '0';
      notify('Signalisation rétablie. Les spectateurs peuvent se reconnecter.', 'success');
    }

    state.signalingWs.send(JSON.stringify({ type: 'join', room: state.roomCode, role }));
  };

  state.signalingWs.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'error') {
      notify(`Erreur serveur : ${msg.message}`, 'error');
      return;
    }

    if (msg.type === 'viewer-ready') {
      const peerId = msg.viewerId || msg.id || Date.now().toString();
      if (!state.peerConnections.has(peerId)) {
        await createBroadcasterPeer(peerId);
      }
    }

    if (msg.type === 'answer') {
      const pc = msg.fromId
        ? state.peerConnections.get(msg.fromId)
        : [...state.peerConnections.values()][state.peerConnections.size - 1];
      if (pc && msg.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
      }
    }

    if (msg.type === 'ice-candidate' && msg.candidate) {
      const pc = msg.fromId ? state.peerConnections.get(msg.fromId) : null;
      if (pc) {
        try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
      } else {
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
    if (state.signalingShouldReconnect && state.isSharing) {
      notify('Connexion signalisation instable. Tentative de reprise...', 'error');
    }
  };

  state.signalingWs.onclose = () => {
    if (!state.signalingShouldReconnect || !state.isSharing) return;
    scheduleBroadcasterReconnect(role);
  };
}

function scheduleBroadcasterReconnect(role) {
  if (state.signalingReconnectTimer) return;

  const maxAttempts = 6;
  const attempt = state.signalingReconnectAttempts + 1;
  if (attempt > maxAttempts) {
    notify('Serveur de signalisation indisponible. Arrêt du partage.', 'error');
    stopSharing();
    return;
  }

  state.signalingReconnectAttempts = attempt;
  const delayMs = Math.min(1000 * (2 ** (attempt - 1)), 10000);
  notify(`Reconnexion signalisation ${attempt}/${maxAttempts} dans ${Math.round(delayMs / 1000)}s...`, 'info');

  state.signalingReconnectTimer = setTimeout(() => {
    state.signalingReconnectTimer = null;
    openBroadcasterSignaling(role, true);
  }, delayMs);
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
  const lowLatencyMode = Boolean(document.getElementById('lowLatencyMode')?.checked);
  pc.getSenders().forEach(sender => {
    if (sender.track && sender.track.kind === 'video') {
      const params = sender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      params.encodings[0].maxBitrate = lowLatencyMode ? Math.min(state.bitrate, 6000000) : state.bitrate;
      params.encodings[0].maxFramerate = state.fps;
      params.degradationPreference = lowLatencyMode ? 'maintain-framerate' : 'balanced';
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

  if (state.receiverShouldReconnect) {
    leaveSession();
  }

  state.receiverJoinCode = code;
  state.receiverJoinHost = host;
  state.receiverShouldReconnect = true;
  state.receiverReconnectAttempts = 0;

  document.getElementById('joinBtn').disabled = true;
  document.getElementById('joinBtn').textContent = 'Connexion...';

  updateReceiveStatus('connecting');

  connectReceiverSignaling(false);
}

function clearReceiverTimers() {
  if (state.receiverReconnectTimer) {
    clearTimeout(state.receiverReconnectTimer);
    state.receiverReconnectTimer = null;
  }
  if (state.receiverOfferTimeout) {
    clearTimeout(state.receiverOfferTimeout);
    state.receiverOfferTimeout = null;
  }
}

function startReceiverOfferTimeout() {
  if (state.receiverOfferTimeout) {
    clearTimeout(state.receiverOfferTimeout);
  }

  state.receiverOfferTimeout = setTimeout(() => {
    state.receiverOfferTimeout = null;
    if (!state.receiverShouldReconnect || state.receiverPc) return;
    notify('Aucune offre reçue, tentative de reconnexion...', 'error');
    if (state.receiverWs) {
      state.receiverWs.close();
    }
  }, 10000);
}

function connectReceiverSignaling(isReconnect) {
  clearReceiverTimers();

  if (state.receiverWs) {
    state.receiverWs.onopen = null;
    state.receiverWs.onmessage = null;
    state.receiverWs.onerror = null;
    state.receiverWs.onclose = null;
    try { state.receiverWs.close(); } catch {}
    state.receiverWs = null;
  }

  const wsUrl = getSignalingUrl(state.receiverJoinHost);
  state.receiverWs = new WebSocket(wsUrl);

  state.receiverWs.onopen = () => {
    if (!state.receiverShouldReconnect) return;
    state.receiverReconnectAttempts = 0;
    document.getElementById('joinBtn').disabled = true;
    document.getElementById('joinBtn').textContent = isReconnect ? 'Reconnexion...' : 'Connexion...';
    state.receiverWs.send(JSON.stringify({ type: 'join', room: state.receiverJoinCode, role: 'viewer' }));
    startReceiverOfferTimeout();
  };

  state.receiverWs.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'error') {
      notify(`Erreur serveur : ${msg.message}`, 'error');
      leaveSession();
      return;
    }

    if (msg.type === 'offer') {
      if (state.receiverOfferTimeout) {
        clearTimeout(state.receiverOfferTimeout);
        state.receiverOfferTimeout = null;
      }
      await handleReceiverOffer(msg);
    }

    if (msg.type === 'ice-candidate' && msg.candidate) {
      if (state.receiverPc) {
        try { await state.receiverPc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
      }
    }

    if (msg.type === 'peer-left') {
      notify('Le diffuseur est indisponible, reconnexion...', 'error');
      if (state.receiverWs) {
        state.receiverWs.close();
      }
    }
  };

  state.receiverWs.onerror = () => {
    if (state.receiverShouldReconnect) {
      notify('Connexion au serveur interrompue.', 'error');
    }
  };

  state.receiverWs.onclose = () => {
    if (!state.receiverShouldReconnect) return;
    scheduleReceiverReconnect();
  };
}

function scheduleReceiverReconnect() {
  if (!state.receiverShouldReconnect || state.receiverReconnectTimer) return;

  const maxAttempts = 8;
  const attempt = state.receiverReconnectAttempts + 1;
  if (attempt > maxAttempts) {
    notify('Impossible de rétablir la connexion.', 'error');
    leaveSession();
    return;
  }

  state.receiverReconnectAttempts = attempt;
  const delayMs = Math.min(1000 * (2 ** (attempt - 1)), 10000);

  if (state.receiverPc) {
    state.receiverPc.ontrack = null;
    state.receiverPc.onicecandidate = null;
    state.receiverPc.onconnectionstatechange = null;
    try { state.receiverPc.close(); } catch {}
    state.receiverPc = null;
  }
  state.receiverTargetId = null;

  const video = document.getElementById('remoteVideo');
  video.srcObject = null;
  document.getElementById('remoteCard').style.display = 'none';
  updateReceiveStatus('connecting');

  document.getElementById('joinBtn').disabled = true;
  document.getElementById('joinBtn').textContent = `Reconnexion ${attempt}/${maxAttempts}...`;

  state.receiverReconnectTimer = setTimeout(() => {
    state.receiverReconnectTimer = null;
    connectReceiverSignaling(true);
  }, delayMs);
}

async function handleReceiverOffer(offer) {
  if (state.receiverPc) {
    state.receiverPc.ontrack = null;
    state.receiverPc.onicecandidate = null;
    state.receiverPc.onconnectionstatechange = null;
    try { state.receiverPc.close(); } catch {}
    state.receiverPc = null;
  }

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
      state.receiverReconnectAttempts = 0;
      updateReceiveStatus('connected');
      document.getElementById('joinBtn').textContent = '✓ Connecté';
      notify('Flux reçu avec succès !', 'success');
    }
    if (['disconnected', 'failed', 'closed'].includes(state.receiverPc.connectionState)) {
      if (state.receiverShouldReconnect) {
        notify('Connexion perdue, reconnexion...', 'error');
        if (state.receiverWs) {
          state.receiverWs.close();
        }
      } else {
        updateReceiveStatus('idle');
      }
    }
  };

  await state.receiverPc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await state.receiverPc.createAnswer();
  await state.receiverPc.setLocalDescription(answer);

  if (state.receiverWs && state.receiverWs.readyState === WebSocket.OPEN) {
    state.receiverWs.send(JSON.stringify({ type: 'answer', sdp: answer.sdp, targetId: state.receiverTargetId }));
  }
}

function leaveSession() {
  state.receiverShouldReconnect = false;
  state.receiverReconnectAttempts = 0;
  clearReceiverTimers();

  if (state.receiverWs) {
    state.receiverWs.onopen = null;
    state.receiverWs.onmessage = null;
    state.receiverWs.onerror = null;
    state.receiverWs.onclose = null;
    state.receiverWs.close();
    state.receiverWs = null;
  }
  if (state.receiverPc) {
    state.receiverPc.ontrack = null;
    state.receiverPc.onicecandidate = null;
    state.receiverPc.onconnectionstatechange = null;
    state.receiverPc.close();
    state.receiverPc = null;
  }
  state.receiverTargetId = null;
  state.receiverJoinCode = '';
  state.receiverJoinHost = 'localhost';

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

function setupUiBindings() {
  document.getElementById('btnMinimize')?.addEventListener('click', () => window.electronAPI.minimizeWindow());
  document.getElementById('btnMaximize')?.addEventListener('click', () => window.electronAPI.maximizeWindow());
  document.getElementById('btnClose')?.addEventListener('click', () => window.electronAPI.closeWindow());

  document.getElementById('nav-share')?.addEventListener('click', () => showPage('share'));
  document.getElementById('nav-receive')?.addEventListener('click', () => showPage('receive'));
  document.getElementById('nav-settings')?.addEventListener('click', () => showPage('settings'));
  document.getElementById('nav-info')?.addEventListener('click', () => showPage('info'));

  document.getElementById('mode-local')?.addEventListener('click', () => selectMode('local'));
  document.getElementById('mode-code')?.addEventListener('click', () => selectMode('code'));

  document.getElementById('refreshSourcesBtn')?.addEventListener('click', loadSources);
  document.getElementById('copyCodeBtn')?.addEventListener('click', copyRoomCode);
  document.getElementById('startBtn')?.addEventListener('click', startSharing);
  document.getElementById('stopBtn')?.addEventListener('click', stopSharing);
  document.getElementById('joinBtn')?.addEventListener('click', joinSession);
  document.getElementById('fullscreenBtn')?.addEventListener('click', toggleFullscreen);
  document.getElementById('leaveBtn')?.addEventListener('click', leaveSession);

  document.getElementById('joinCodeInput')?.addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase();
  });

  document.querySelectorAll('#resPills .quality-pill').forEach(el => {
    el.addEventListener('click', () => selectRes(el));
  });
  document.querySelectorAll('#fpsPills .quality-pill').forEach(el => {
    el.addEventListener('click', () => selectFps(el));
  });
  document.querySelectorAll('#bitratePills .quality-pill').forEach(el => {
    el.addEventListener('click', () => selectBitrate(el));
  });
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
setupUiBindings();
init();
