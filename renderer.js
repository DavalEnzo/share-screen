// ─── Config ───────────────────────────────────────────────────────────────────
// 🔧 Par défaut, on utilise le serveur local intégré (Electron).
// Pour activer un serveur distant (Railway, VPS...), définissez REMOTE_SIGNALING_URL.
//    ex: wss://votre-projet.up.railway.app
const DEFAULT_REMOTE_SIGNALING_URL = '';
let remoteSignalingUrl = DEFAULT_REMOTE_SIGNALING_URL;

const AUTH_STORAGE_TOKEN_KEY = 'screenshare.authToken';
const AUTH_STORAGE_USERNAME_KEY = 'screenshare.authUsername';

function useRemoteSignaling() {
  return Boolean(remoteSignalingUrl);
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
  // Auth & contacts
  userApiBase: '',
  authToken: null,
  authWs: null,
  authShouldReconnect: false,
  authReconnectAttempts: 0,
  authReconnectTimer: null,
  authPendingMessage: null,
  currentUser: null,
  profileAvatarDraft: undefined,
  contactProfilesByName: {},
  contactProfilesHydrating: false,
  lastContactProfilesHydrateAt: 0,
  contacts: [],
  friendIncoming: [],
  friendOutgoing: [],
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
  hasChangelog: false,
  appVersion: '',
  lastChangelog: null,
};

function getUserApiBase() {
  if (state.userApiBase) return state.userApiBase;
  // Valeur par défaut : backend distant exposé sur le port 8000
  return 'http://82.67.57.216:8000';
}

function renderChangelogIntoAbout(version, notes) {
  const aboutChangelog = document.getElementById('aboutChangelog');
  if (!aboutChangelog) return;
  const maxLen = 2000;
  const text = String(notes || '').slice(0, maxLen);
  aboutChangelog.innerHTML = '';

  const title = document.createElement('div');
  title.style.fontFamily = 'var(--mono)';
  title.style.fontSize = '12px';
  title.style.fontWeight = '700';
  title.style.marginBottom = '6px';
  title.textContent = `Nouveautés de la version v${version}`;

  const body = document.createElement('div');
  body.style.fontFamily = 'var(--mono)';
  body.style.fontSize = '11px';
  body.style.color = 'var(--text-dim)';
  body.style.whiteSpace = 'pre-wrap';
  body.innerHTML = sanitizeHtmlNotes(text);

  aboutChangelog.appendChild(title);
  aboutChangelog.appendChild(body);
}

function showChangelogModal(version, notes) {
  const overlay = document.getElementById('changelogModal');
  const subtitle = document.getElementById('changelogModalSubtitle');
  const bodyEl = document.getElementById('changelogModalBody');
  if (!overlay || !subtitle || !bodyEl) return;

  const maxLen = 2000;
  const text = String(notes || '').slice(0, maxLen);
  subtitle.textContent = `Nouveautés de la version v${version}`;
  bodyEl.innerHTML = sanitizeHtmlNotes(text);
  overlay.style.display = 'flex';
}

function hideChangelogModal() {
  const overlay = document.getElementById('changelogModal');
  if (!overlay) return;
  overlay.style.display = 'none';
}

function sanitizeHtmlNotes(raw) {
  let html = String(raw || '');
  // Retirer les balises potentiellement dangereuses
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  html = html.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  html = html.replace(/<object[\s\S]*?<\/object>/gi, '');
  html = html.replace(/<embed[\s\S]*?<\/embed>/gi, '');
  // Coller les lignes séparées uniquement par des ellipses de troncature GitHub
  // ex: "gestion des …\nellipses" -> "gestion des ellipses".
  html = html.replace(/(?:\.{3,}|…)\s*\r?\n\s*/g, ' ');
  // En pratique, pour éviter tout artefact visuel lié aux ellipses tronquées,
  // on supprime aussi tous les caractères d'ellipse restants (… ou ...).
  html = html.replace(/…/g, '');
  html = html.replace(/\.{3,}/g, '');
  return html;
}

// ─── ICE config (STUN public + TURN dynamique) ──────────────────────────────
const BASE_ICE_SERVERS = [
  // STUN Google (fonctionne pour ~70% des connexions)
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const turnStaticConfig = {
  host: '',
  port: '',
  username: '',
  password: '',
};

let cachedTurnCreds = null;
let cachedTurnCredsExpireAt = 0;

async function getIceConfig() {
  const iceServers = BASE_ICE_SERVERS.slice();

  if (!turnStaticConfig.host || !turnStaticConfig.port) {
    return { iceServers };
  }

  let username = turnStaticConfig.username || '';
  let credential = turnStaticConfig.password || '';

  // En mode distant, essayer de récupérer des credentials TURN éphémères
  if (useRemoteSignaling() && window.electronAPI?.getTurnCredentials) {
    const nowSec = Date.now() / 1000;
    if (!cachedTurnCreds || nowSec >= cachedTurnCredsExpireAt) {
      try {
        const res = await window.electronAPI.getTurnCredentials();
        if (res && res.username && (res.password || res.credential)) {
          const pwd = res.password || res.credential;
          const ttl = Number(res.ttl || 3600);
          cachedTurnCreds = { username: res.username, password: pwd, ttl };
          cachedTurnCredsExpireAt = nowSec + Math.max(60, ttl - 60);
        }
      } catch (e) {
        console.error('Erreur récupération credentials TURN:', e);
      }
    }

    if (cachedTurnCreds) {
      username = cachedTurnCreds.username;
      credential = cachedTurnCreds.password;
    }
  }

  if (username && credential) {
    iceServers.push({
      urls: [
        `turn:${turnStaticConfig.host}:${turnStaticConfig.port}?transport=udp`,
        `turn:${turnStaticConfig.host}:${turnStaticConfig.port}?transport=tcp`,
      ],
      username,
      credential,
    });
  }

  return { iceServers };
}

// URL dédiée pour l'auth/contacts
// - en mode distant : même serveur que la signalisation distante (Railway)
// - sinon : serveur local intégré Electron
function getAuthWebSocketUrl() {
  if (useRemoteSignaling() && remoteSignalingUrl) {
    return remoteSignalingUrl;
  }
  const port = state.signalingPort || 8765;
  return `ws://localhost:${port}`;
}

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

  if (runtimeConfig.userApiBase) {
    state.userApiBase = String(runtimeConfig.userApiBase).trim();
  }

  if (runtimeConfig.turnHost && runtimeConfig.turnPort) {
    turnStaticConfig.host = runtimeConfig.turnHost;
    turnStaticConfig.port = runtimeConfig.turnPort;
    turnStaticConfig.username = runtimeConfig.turnUsername || '';
    turnStaticConfig.password = runtimeConfig.turnPassword || '';
  }

  const [ip, port] = await Promise.all([
    window.electronAPI.getLocalIp(),
    window.electronAPI.getSignalingPort(),
  ]);
  state.localIp = ip;
  state.signalingPort = port;
  document.getElementById('localIpDisplay').textContent = useRemoteSignaling() ? 'Mode: distant' : `IP: ${ip}`;

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

  let appVersion = '';
  if (window.electronAPI?.getAppVersion) {
    try {
      const version = await window.electronAPI.getAppVersion();
      appVersion = String(version || '');
      const aboutEl = document.getElementById('aboutVersion');
      if (aboutEl && appVersion) {
        aboutEl.textContent = `v${appVersion} • Electron + WebRTC`;
      }
    } catch (_) {}
  }
  state.appVersion = appVersion;

  generateRoomCode();

  // Mettre à jour les infos de présence une fois l'IP locale connue
  if (state.currentUser && state.authWs && state.authWs.readyState === WebSocket.OPEN) {
    sendPresenceInfo();
  }

  // 1) Récupérer les infos de changelog stockées après une mise à jour auto (pour le modal)
  let modalShownFromUpdate = false;
  try {
    const raw = window.localStorage ? window.localStorage.getItem('lastUpdateInfo') : null;
    if (raw && appVersion) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version && parsed.notes && parsed.version === appVersion) {
        const maxLen = 2000;
        const text = String(parsed.notes).slice(0, maxLen);
        state.hasChangelog = true;
        state.lastChangelog = { version: parsed.version, notes: text };

        // Conserver un cache persistant pour les démarrages futurs
        if (window.localStorage) {
          window.localStorage.setItem('cachedChangelog', JSON.stringify({ version: parsed.version, notes: text }));
          window.localStorage.removeItem('lastUpdateInfo');
        }

        // Afficher un modal au démarrage avec les changements
        showChangelogModal(parsed.version, text);
        modalShownFromUpdate = true;
      }
    }
  } catch (_) {}

  // 2) Si aucune info de mise à jour immédiate, recharger un changelog déjà mis en cache
  if (!modalShownFromUpdate && appVersion && window.localStorage) {
    try {
      const cached = window.localStorage.getItem('cachedChangelog');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.version && parsed.notes && parsed.version === appVersion) {
          const maxLen = 2000;
          const text = String(parsed.notes).slice(0, maxLen);
          state.hasChangelog = true;
          state.lastChangelog = { version: parsed.version, notes: text };
        }
      }
    } catch (_) {}
  }

  // Mettre à jour l'état initial des boutons d'authentification
  updateAuthButtonsVisibility();

  // Restaurer automatiquement une session persistée, si disponible
  await restoreSavedAuthSession();
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function showPage(name) {
  if (name === 'profile' && !(state.currentUser && state.authToken)) {
    notify('Connectez-vous pour modifier votre profil.', 'error');
    name = 'contacts';
  }
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

// ─── Auth & contacts ────────────────────────────────────────────────────────
function setAuthStatus(text, type) {
  const el = document.getElementById('authStatusLabel');
  if (!el) return;
  el.textContent = text;
  if (type === 'error') {
    el.style.color = 'var(--red)';
  } else if (type === 'success') {
    el.style.color = 'var(--green)';
  } else {
    el.style.color = 'var(--text-dim)';
  }
}

function setProfileStatus(text, type = 'info') {
  const el = document.getElementById('profileStatusLabel');
  if (!el) return;
  el.textContent = text;
  el.style.color = type === 'error' ? 'var(--red)' : type === 'success' ? 'var(--green)' : 'var(--text-dim)';
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function setAvatarPreview(imgEl, iconEl, avatarData) {
  if (!imgEl || !iconEl) return;
  const hasAvatar = Boolean(avatarData);
  if (hasAvatar) {
    imgEl.src = avatarData;
    imgEl.style.display = 'block';
    iconEl.style.display = 'none';
  } else {
    imgEl.removeAttribute('src');
    imgEl.style.display = 'none';
    iconEl.style.display = 'block';
  }
}

function renderProfileForm(profile) {
  const usernameEl = document.getElementById('profileUsernameValue');
  const displayNameEl = document.getElementById('profileDisplayNameInput');
  const avatarImgEl = document.getElementById('profileAvatarPreviewImg');
  const avatarIconEl = document.getElementById('profileAvatarPreviewIcon');
  const createdAtEl = document.getElementById('profileCreatedAt');
  const updatedAtEl = document.getElementById('profileUpdatedAt');
  if (!usernameEl || !displayNameEl || !avatarImgEl || !avatarIconEl || !createdAtEl || !updatedAtEl) return;

  if (!profile) {
    usernameEl.textContent = '—';
    displayNameEl.value = '';
    setAvatarPreview(avatarImgEl, avatarIconEl, null);
    state.profileAvatarDraft = undefined;
    createdAtEl.textContent = '—';
    updatedAtEl.textContent = '—';
    return;
  }

  usernameEl.textContent = profile.username || '—';
  displayNameEl.value = profile.display_name || profile.username || '';
  const avatarData = state.profileAvatarDraft !== undefined
    ? state.profileAvatarDraft
    : (profile.avatar_data || null);
  setAvatarPreview(avatarImgEl, avatarIconEl, avatarData);
  createdAtEl.textContent = formatDateTime(profile.created_at);
  updatedAtEl.textContent = formatDateTime(profile.updated_at);
}

function syncProfileFromCurrentUser() {
  if (!state.currentUser) {
    renderProfileForm(null);
    setProfileStatus('Connectez-vous pour modifier votre profil.', 'info');
    return;
  }

  renderProfileForm({
    username: state.currentUser.username || '',
    display_name: state.currentUser.displayName || state.currentUser.display_name || state.currentUser.username || '',
    avatar_data: state.currentUser.avatarData || state.currentUser.avatar_data || null,
    created_at: state.currentUser.createdAt || state.currentUser.created_at || null,
    updated_at: state.currentUser.updatedAt || state.currentUser.updated_at || null,
  });
}

async function handleProfileSave() {
  if (!state.authToken || !state.currentUser) {
    notify('Connectez-vous pour modifier votre profil.', 'error');
    return;
  }

  const displayNameEl = document.getElementById('profileDisplayNameInput');
  const currentPasswordEl = document.getElementById('profileCurrentPasswordInput');
  const newPasswordEl = document.getElementById('profileNewPasswordInput');
  const confirmPasswordEl = document.getElementById('profileConfirmPasswordInput');

  if (!displayNameEl || !currentPasswordEl || !newPasswordEl || !confirmPasswordEl) return;

  const displayName = displayNameEl.value.trim();
  const currentPassword = currentPasswordEl.value;
  const newPassword = newPasswordEl.value;
  const confirmPassword = confirmPasswordEl.value;

  const payload = {
    display_name: displayName,
  };

  if (state.profileAvatarDraft !== undefined) {
    payload.avatar_data = state.profileAvatarDraft;
  }

  const wantsPasswordChange = Boolean(newPassword || currentPassword || confirmPassword);
  if (wantsPasswordChange) {
    if (!currentPassword || !newPassword || !confirmPassword) {
      notify('Pour changer le mot de passe, remplissez les trois champs.', 'error');
      return;
    }
    if (newPassword !== confirmPassword) {
      notify('Les nouveaux mots de passe ne correspondent pas.', 'error');
      return;
    }
    payload.current_password = currentPassword;
    payload.new_password = newPassword;
  }

  try {
    setProfileStatus('Enregistrement en cours...', 'info');
    const updated = await apiRequest('/api/auth/me', {
      method: 'PUT',
      body: payload,
    });

    state.currentUser = {
      ...state.currentUser,
      username: updated.username,
      displayName: updated.display_name || updated.username,
      display_name: updated.display_name || updated.username,
      avatarData: updated.avatar_data || null,
      avatar_data: updated.avatar_data || null,
      createdAt: updated.created_at || state.currentUser.createdAt || null,
      updatedAt: updated.updated_at || null,
    };

    state.profileAvatarDraft = undefined;

    renderProfileForm(updated);
    updateSidebarUserMenu();
    clearPersistedAuthSession();
    if (document.getElementById('rememberSessionToggle')?.checked) {
      persistAuthSession(state.currentUser.username, state.authToken);
    }

    currentPasswordEl.value = '';
    newPasswordEl.value = '';
    confirmPasswordEl.value = '';
    const avatarInputEl = document.getElementById('profileAvatarInput');
    if (avatarInputEl) avatarInputEl.value = '';

    setProfileStatus('Profil mis à jour.', 'success');
    notify('Profil mis à jour.', 'success');
  } catch (err) {
    const msg = err && err.message ? err.message : 'Erreur lors de la mise à jour du profil.';
    setProfileStatus(msg, 'error');
    notify(msg, 'error');
  }
}

function handleProfileReset() {
  if (!state.currentUser) {
    renderProfileForm(null);
    return;
  }

  state.profileAvatarDraft = undefined;
  syncProfileFromCurrentUser();
  const currentPasswordEl = document.getElementById('profileCurrentPasswordInput');
  const newPasswordEl = document.getElementById('profileNewPasswordInput');
  const confirmPasswordEl = document.getElementById('profileConfirmPasswordInput');
  if (currentPasswordEl) currentPasswordEl.value = '';
  if (newPasswordEl) newPasswordEl.value = '';
  if (confirmPasswordEl) confirmPasswordEl.value = '';
  const avatarInputEl = document.getElementById('profileAvatarInput');
  if (avatarInputEl) avatarInputEl.value = '';
  setProfileStatus('Formulaire réinitialisé.', 'info');
}

async function handleProfileAvatarSelected(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  if (!file.type || !file.type.startsWith('image/')) {
    notify('Sélectionnez une image valide.', 'error');
    event.target.value = '';
    return;
  }

  const maxSize = 2 * 1024 * 1024;
  if (file.size > maxSize) {
    notify('Image trop lourde. Choisissez une image de moins de 2 Mo.', 'error');
    event.target.value = '';
    return;
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Impossible de lire le fichier.'));
    reader.readAsDataURL(file);
  }).catch((error) => {
    notify(error.message || 'Impossible de lire l’image.', 'error');
    return '';
  });

  if (!dataUrl) {
    event.target.value = '';
    return;
  }

  state.profileAvatarDraft = dataUrl;
  renderProfileForm({
    username: state.currentUser?.username || '',
    display_name: state.currentUser?.displayName || state.currentUser?.display_name || state.currentUser?.username || '',
    avatar_data: state.currentUser?.avatarData || state.currentUser?.avatar_data || null,
    created_at: state.currentUser?.createdAt || state.currentUser?.created_at || null,
    updated_at: state.currentUser?.updatedAt || state.currentUser?.updated_at || null,
  });
  setProfileStatus('Photo prête à être enregistrée.', 'info');
}

function clearProfileAvatarDraft() {
  if (!state.currentUser) return;
  state.profileAvatarDraft = null;
  const avatarInputEl = document.getElementById('profileAvatarInput');
  if (avatarInputEl) avatarInputEl.value = '';
  renderProfileForm({
    username: state.currentUser.username || '',
    display_name: state.currentUser.displayName || state.currentUser.display_name || state.currentUser.username || '',
    avatar_data: state.currentUser.avatarData || state.currentUser.avatar_data || null,
    created_at: state.currentUser.createdAt || state.currentUser.created_at || null,
    updated_at: state.currentUser.updatedAt || state.currentUser.updated_at || null,
  });
  setProfileStatus('Photo retirée. Enregistrez pour appliquer le changement.', 'info');
}

function persistAuthSession(username, token) {
  if (!window.localStorage || !username || !token) return;
  try {
    window.localStorage.setItem(AUTH_STORAGE_USERNAME_KEY, String(username));
    window.localStorage.setItem(AUTH_STORAGE_TOKEN_KEY, String(token));
  } catch (_) {}
}

function clearPersistedAuthSession() {
  if (!window.localStorage) return;
  try {
    window.localStorage.removeItem(AUTH_STORAGE_USERNAME_KEY);
    window.localStorage.removeItem(AUTH_STORAGE_TOKEN_KEY);
  } catch (_) {}
}

async function restoreSavedAuthSession() {
  if (!window.localStorage) return;

  let savedUsername = '';
  let savedToken = '';

  try {
    savedUsername = (window.localStorage.getItem(AUTH_STORAGE_USERNAME_KEY) || '').trim().toLowerCase();
    savedToken = (window.localStorage.getItem(AUTH_STORAGE_TOKEN_KEY) || '').trim();
  } catch (_) {
    return;
  }

  if (!savedUsername || !savedToken) return;

  state.currentUser = { username: savedUsername };
  state.authToken = savedToken;
  setAuthStatus('Restauration de session...', 'info');

  try {
    await refreshUserProfileFromApi();
    openAuthWebSocket();
    sendPresenceInfo();

    const rememberToggle = document.getElementById('rememberSessionToggle');
    if (rememberToggle) rememberToggle.checked = true;

    updateAuthButtonsVisibility();
    setAuthStatus(`Connecté en tant que ${savedUsername}`, 'success');
  } catch (_) {
    state.currentUser = null;
    state.authToken = null;
    state.contacts = [];
    state.friendIncoming = [];
    state.friendOutgoing = [];
    clearPersistedAuthSession();
    updateAuthButtonsVisibility();
    setAuthStatus('Session expirée. Connectez-vous de nouveau.', 'error');
  }
}

async function apiRequest(path, options = {}) {
  const base = getUserApiBase();
  const url = `${base}${path}`;
  const {
    method = 'GET',
    body = null,
    form = false,
  } = options;

  const headers = {};
  if (state.authToken) {
    headers['Authorization'] = `Bearer ${state.authToken}`;
  }
  let payload;
  if (body) {
    if (form) {
      const params = new URLSearchParams();
      Object.entries(body).forEach(([k, v]) => {
        if (v !== undefined && v !== null) params.append(k, String(v));
      });
      headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
      payload = params.toString();
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }

  const res = await fetch(url, { method, headers, body: payload });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    // ignore
  }
  if (!res.ok) {
    const message = (data && (data.detail || data.message || data.error)) || `Erreur API (${res.status})`;
    throw new Error(message);
  }
  return data;
}

function canonicalContact(payload) {
  if (!payload) return null;
  const name = (payload.user || payload.name || payload.contact || payload.username || '').toString();
  if (!name) return null;
  return {
    name,
    online: Boolean(payload.online),
    sharing: Boolean(payload.sharing),
    roomCode: payload.roomCode || null,
    host: payload.host || null,
    mode: payload.mode === 'remote' ? 'remote' : 'local',
  };
}

function upsertContactFromStatus(payload) {
  const info = canonicalContact({ ...payload, user: payload.contact || payload.user || payload.name });
  if (!info) return;

  const existing = state.contacts.find(c => c.name === info.name);
  if (!existing) return;

  existing.online = info.online;
  existing.sharing = info.sharing;
  existing.roomCode = info.roomCode;
  existing.host = info.host;
  existing.mode = info.mode;
}

async function hydrateContactProfiles() {
  if (!state.authToken || !state.currentUser) return;
  if (state.contactProfilesHydrating) return;

  state.contactProfilesHydrating = true;

  try {
    const res = await apiRequest('/api/contacts/profiles');
    const profiles = Array.isArray(res?.contacts) ? res.contacts : [];
    const byName = new Map(
      profiles
        .filter((p) => p && p.username)
        .map((p) => [String(p.username).toLowerCase(), p]),
    );

    const map = {};
    byName.forEach((profile, username) => {
      map[username] = {
        displayName: profile.display_name || username,
        avatarData: profile.avatar_data || null,
      };
    });
    state.contactProfilesByName = map;

    state.contacts.forEach((contact) => {
      const profile = byName.get(String(contact.name || '').toLowerCase());
      if (!profile) return;
      contact.displayName = profile.display_name || contact.name;
      contact.avatarData = profile.avatar_data || null;
    });

    renderContactsList();
    renderFriendRequests();
  } catch (_) {
    // Non bloquant: la liste de contacts reste utilisable même sans avatars.
  } finally {
    state.contactProfilesHydrating = false;
    state.lastContactProfilesHydrateAt = Date.now();
  }
}

function ensureRequestProfilesHydrated(incoming, outgoing) {
  if (!state.authToken || !state.currentUser) return;

  const missing = [];
  const seen = new Set();
  for (const username of [...incoming, ...outgoing]) {
    const key = String(username || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!state.contactProfilesByName[key]) {
      missing.push(key);
    }
  }

  if (missing.length === 0) return;
  const now = Date.now();
  if (now - state.lastContactProfilesHydrateAt < 1500) return;
  hydrateContactProfiles();
}

function renderContactsList() {
  const listEl = document.getElementById('contactsList');
  if (!listEl) return;

  listEl.innerHTML = '';

  if (!state.currentUser) {
    listEl.innerHTML = '<div class="contact-list-empty">Connectez-vous pour voir vos contacts.</div>';
    return;
  }

  if (!state.contacts || state.contacts.length === 0) {
    listEl.innerHTML = '<div class="contact-list-empty">Aucun contact pour le moment.</div>';
    return;
  }

  const contacts = [...state.contacts].sort((a, b) => a.name.localeCompare(b.name));

  contacts.forEach(contact => {
    const row = document.createElement('div');
    row.className = 'contact-row';

    const main = document.createElement('div');
    main.className = 'contact-main';

    const avatar = document.createElement('div');
    avatar.className = 'contact-avatar';
    if (contact.avatarData) {
      const avatarImg = document.createElement('img');
      avatarImg.src = contact.avatarData;
      avatarImg.alt = `Avatar de ${contact.name}`;
      avatar.appendChild(avatarImg);
    } else {
      const avatarIcon = document.createElement('i');
      avatarIcon.className = 'fa-solid fa-user';
      avatar.appendChild(avatarIcon);
    }

    const dot = document.createElement('div');
    dot.className = 'contact-status-dot';
    if (contact.sharing) dot.classList.add('sharing');
    else if (contact.online) dot.classList.add('online');

    const nameSpan = document.createElement('div');
    nameSpan.className = 'contact-name';
    nameSpan.textContent = contact.displayName || contact.name;

    const statusSpan = document.createElement('div');
    statusSpan.className = 'contact-status-text';
    if (contact.sharing && contact.mode === 'remote') {
      statusSpan.textContent = 'En partage (distant)';
    } else if (contact.sharing) {
      statusSpan.textContent = 'En partage (LAN)';
    } else if (contact.online) {
      statusSpan.textContent = 'En ligne';
    } else {
      statusSpan.textContent = 'Hors ligne';
    }

    main.appendChild(avatar);
    main.appendChild(dot);
    main.appendChild(nameSpan);
    main.appendChild(statusSpan);

    const actions = document.createElement('div');
    actions.className = 'contact-actions';

    if (contact.sharing && contact.roomCode) {
      const joinBtn = document.createElement('button');
      joinBtn.className = 'btn btn-primary';
      joinBtn.style.padding = '4px 10px';
      joinBtn.style.fontSize = '11px';
      joinBtn.dataset.action = 'join-contact';
      joinBtn.dataset.contactName = contact.name;
      joinBtn.dataset.roomCode = contact.roomCode;
      if (contact.host) joinBtn.dataset.host = contact.host;
      joinBtn.dataset.mode = contact.mode || 'local';
      joinBtn.textContent = 'Rejoindre';
      actions.appendChild(joinBtn);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-ghost';
    removeBtn.style.padding = '4px 8px';
    removeBtn.style.fontSize = '11px';
    removeBtn.dataset.action = 'remove-contact';
    removeBtn.dataset.contactName = contact.name;
    removeBtn.textContent = '✕';
    actions.appendChild(removeBtn);

    row.appendChild(main);
    row.appendChild(actions);
    listEl.appendChild(row);
  });
}

function renderFriendRequests() {
  const incomingEl = document.getElementById('incomingRequestsList');
  const outgoingEl = document.getElementById('outgoingRequestsList');
  if (!incomingEl || !outgoingEl) return;

  incomingEl.innerHTML = '';
  outgoingEl.innerHTML = '';

  if (!state.currentUser) {
    incomingEl.innerHTML = '<div class="contact-list-empty">Connectez-vous pour voir vos demandes.</div>';
    outgoingEl.innerHTML = '<div class="contact-list-empty">Connectez-vous pour voir vos demandes.</div>';
    return;
  }

  const incoming = [...(state.friendIncoming || [])].sort((a, b) => a.localeCompare(b));
  const outgoing = [...(state.friendOutgoing || [])].sort((a, b) => a.localeCompare(b));

  ensureRequestProfilesHydrated(incoming, outgoing);

  const getProfileMeta = (username) => {
    const key = String(username || '').toLowerCase();
    return state.contactProfilesByName[key] || {
      displayName: username,
      avatarData: null,
    };
  };

  if (incoming.length === 0) {
    incomingEl.innerHTML = '<div class="contact-list-empty">Aucune demande reçue.</div>';
  } else {
    incoming.forEach(name => {
      const row = document.createElement('div');
      row.className = 'contact-row';

      const main = document.createElement('div');
      main.className = 'contact-main';

      const meta = getProfileMeta(name);

      const avatar = document.createElement('div');
      avatar.className = 'contact-avatar';
      if (meta.avatarData) {
        const avatarImg = document.createElement('img');
        avatarImg.src = meta.avatarData;
        avatarImg.alt = `Avatar de ${name}`;
        avatar.appendChild(avatarImg);
      } else {
        const avatarIcon = document.createElement('i');
        avatarIcon.className = 'fa-solid fa-user';
        avatar.appendChild(avatarIcon);
      }

      const nameSpan = document.createElement('div');
      nameSpan.className = 'contact-name';
      nameSpan.textContent = meta.displayName || name;

      const statusSpan = document.createElement('div');
      statusSpan.className = 'contact-status-text';
      statusSpan.textContent = 'Demande reçue';

      main.appendChild(avatar);
      main.appendChild(nameSpan);
      main.appendChild(statusSpan);

      const actions = document.createElement('div');
      actions.className = 'contact-actions';

      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'btn btn-primary';
      acceptBtn.style.padding = '4px 10px';
      acceptBtn.style.fontSize = '11px';
      acceptBtn.dataset.action = 'accept-request';
      acceptBtn.dataset.username = name;
      acceptBtn.textContent = 'Accepter';

      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'btn btn-ghost';
      rejectBtn.style.padding = '4px 8px';
      rejectBtn.style.fontSize = '11px';
      rejectBtn.dataset.action = 'reject-request';
      rejectBtn.dataset.username = name;
      rejectBtn.textContent = 'Refuser';

      actions.appendChild(acceptBtn);
      actions.appendChild(rejectBtn);

      row.appendChild(main);
      row.appendChild(actions);
      incomingEl.appendChild(row);
    });
  }

  if (outgoing.length === 0) {
    outgoingEl.innerHTML = '<div class="contact-list-empty">Aucune demande envoyée.</div>';
  } else {
    outgoing.forEach(name => {
      const row = document.createElement('div');
      row.className = 'contact-row';

      const main = document.createElement('div');
      main.className = 'contact-main';

      const meta = getProfileMeta(name);

      const avatar = document.createElement('div');
      avatar.className = 'contact-avatar';
      if (meta.avatarData) {
        const avatarImg = document.createElement('img');
        avatarImg.src = meta.avatarData;
        avatarImg.alt = `Avatar de ${name}`;
        avatar.appendChild(avatarImg);
      } else {
        const avatarIcon = document.createElement('i');
        avatarIcon.className = 'fa-solid fa-user';
        avatar.appendChild(avatarIcon);
      }

      const nameSpan = document.createElement('div');
      nameSpan.className = 'contact-name';
      nameSpan.textContent = meta.displayName || name;

      const statusSpan = document.createElement('div');
      statusSpan.className = 'contact-status-text';
      statusSpan.textContent = 'En attente...';

      main.appendChild(avatar);
      main.appendChild(nameSpan);
      main.appendChild(statusSpan);

      const actions = document.createElement('div');
      actions.className = 'contact-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-ghost';
      cancelBtn.style.padding = '4px 8px';
      cancelBtn.style.fontSize = '11px';
      cancelBtn.dataset.action = 'cancel-outgoing-request';
      cancelBtn.dataset.username = name;
      cancelBtn.textContent = 'Annuler';
      actions.appendChild(cancelBtn);

      row.appendChild(main);
      row.appendChild(actions);
      outgoingEl.appendChild(row);
    });
  }
}

async function refreshUserProfileFromApi() {
  if (!state.authToken) return;
  try {
    const me = await apiRequest('/api/auth/me');
    const contactNames = Array.isArray(me.contacts) ? me.contacts : [];
    const prevByName = new Map(state.contacts.map((c) => [c.name, c]));
    state.contacts = contactNames.map((name) => {
      const existing = prevByName.get(name);
      if (existing) return existing;
      return {
        name,
        displayName: name,
        avatarData: null,
        online: false,
        sharing: false,
        roomCode: null,
        host: null,
        mode: 'local',
      };
    });
    state.friendIncoming = Array.isArray(me.incoming_requests) ? me.incoming_requests : [];
    state.friendOutgoing = Array.isArray(me.outgoing_requests) ? me.outgoing_requests : [];
    state.currentUser = {
      ...state.currentUser,
      username: me.username,
      displayName: me.display_name || me.username,
      display_name: me.display_name || me.username,
      bio: me.bio || '',
      avatarData: me.avatar_data || null,
      avatar_data: me.avatar_data || null,
      createdAt: me.created_at || state.currentUser?.createdAt || null,
      updatedAt: me.updated_at || null,
    };
    renderContactsList();
    renderFriendRequests();
    await hydrateContactProfiles();
    syncProfileFromCurrentUser();
    updateSidebarUserMenu();
  } catch (err) {
    console.error('Erreur chargement profil API:', err);
    notify('Erreur lors du chargement du profil utilisateur.', 'error');
  }
}

function sendPresenceInfo() {
  if (!state.currentUser || !state.authWs || state.authWs.readyState !== WebSocket.OPEN) return;
  const msg = {
    type: 'presence-info',
    host: state.localIp || 'localhost',
    mode: useRemoteSignaling() ? 'remote' : 'local',
  };
  try {
    state.authWs.send(JSON.stringify(msg));
  } catch (_) {}
}

function openAuthWebSocket() {
  const url = getAuthWebSocketUrl();

  if (state.authWs && (state.authWs.readyState === WebSocket.OPEN || state.authWs.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const ws = new WebSocket(url);
  state.authWs = ws;
  state.authShouldReconnect = true;

  ws.onopen = () => {
    state.authReconnectAttempts = 0;
    if (state.currentUser && state.currentUser.username) {
      try {
        ws.send(JSON.stringify({ type: 'attach-user', username: state.currentUser.username }));
      } catch (_) {}
    }
    if (state.authPendingMessage) {
      try {
        ws.send(JSON.stringify(state.authPendingMessage));
      } catch (_) {}
      state.authPendingMessage = null;
    } else if (state.currentUser) {
      // Ré-envoyer les infos de présence si déjà connecté
      sendPresenceInfo();
    }
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'contact-status') {
      upsertContactFromStatus(msg);
      renderContactsList();
      return;
    }

    if (msg.type === 'friend-request-incoming') {
      const from = (msg.from || '').toString().trim().toLowerCase();
      if (from && !state.friendIncoming.includes(from)) {
        state.friendIncoming = [...state.friendIncoming, from];
        renderFriendRequests();
        hydrateContactProfiles();
        notify(`Nouvelle demande d'ami de ${from}.`, 'info');
      }
      return;
    }

    if (msg.type === 'friend-request-accepted') {
      const from = (msg.from || '').toString().trim().toLowerCase();
      if (from) {
        state.friendIncoming = state.friendIncoming.filter((u) => u !== from);
        state.friendOutgoing = state.friendOutgoing.filter((u) => u !== from);
        renderFriendRequests();
        notify(`${from} a accepté votre demande.`, 'success');
        refreshUserProfileFromApi();
      }
      return;
    }

    if (msg.type === 'friend-request-rejected') {
      const from = (msg.from || '').toString().trim().toLowerCase();
      if (from) {
        state.friendOutgoing = state.friendOutgoing.filter((u) => u !== from);
        renderFriendRequests();
        notify(`${from} a refusé votre demande.`, 'info');
      }
      return;
    }

    if (msg.type === 'friend-request-cancelled') {
      const from = (msg.from || '').toString().trim().toLowerCase();
      if (from) {
        state.friendIncoming = state.friendIncoming.filter((u) => u !== from);
        renderFriendRequests();
        notify(`${from} a annulé sa demande.`, 'info');
      }
      return;
    }
  };

  ws.onerror = () => {
    setAuthStatus('Erreur de connexion au serveur de contacts.', 'error');
  };

  ws.onclose = () => {
    state.authWs = null;
    if (!state.authShouldReconnect || !state.currentUser) return;

    const maxAttempts = 3;
    const attempt = state.authReconnectAttempts + 1;
    if (attempt > maxAttempts) {
      state.authShouldReconnect = false;
      setAuthStatus('Serveur de contacts indisponible.', 'error');
      return;
    }

    state.authReconnectAttempts = attempt;
    const delayMs = Math.min(1000 * (2 ** (attempt - 1)), 10000);
    if (state.authReconnectTimer) return;
    state.authReconnectTimer = setTimeout(() => {
      state.authReconnectTimer = null;
      openAuthWebSocket();
    }, delayMs);
  };
}

function updateAuthButtonsVisibility() {
  const loginBtn = document.getElementById('authLoginBtn');
  const registerBtn = document.getElementById('authRegisterBtn');
  const logoutBtn = document.getElementById('authLogoutBtn');
  const accountCard = document.getElementById('accountCard');
  const contactsCard = document.getElementById('contactsCard');
  const contactsGrid = document.getElementById('contactsGrid');
  const contactsLogoutRow = document.getElementById('contactsLogoutRow');
  const navProfile = document.getElementById('nav-profile');
  if (!loginBtn || !registerBtn || !logoutBtn) return;

  const isAuthenticated = Boolean(state.currentUser && state.authToken);

  if (isAuthenticated) {
    loginBtn.style.display = 'none';
    registerBtn.style.display = 'none';
    logoutBtn.style.display = '';
    if (accountCard) accountCard.style.display = 'none';
    if (contactsCard) contactsCard.style.display = '';
    if (contactsGrid) {
      // Une seule carte visible en mode connecté: forcer pleine largeur.
      contactsGrid.style.display = 'block';
      contactsGrid.style.gridTemplateColumns = '';
    }
    if (contactsLogoutRow) contactsLogoutRow.style.display = '';
    if (navProfile) navProfile.style.display = '';
  } else {
    loginBtn.style.display = 'flex';
    registerBtn.style.display = 'flex';
    logoutBtn.style.display = 'none';
    if (accountCard) accountCard.style.display = '';
    if (contactsCard) contactsCard.style.display = 'none';
    if (contactsGrid) {
      contactsGrid.style.display = 'block';
      contactsGrid.style.gridTemplateColumns = '';
    }
    if (contactsLogoutRow) contactsLogoutRow.style.display = 'none';
    if (navProfile) navProfile.style.display = 'none';
  }

  updateSidebarUserMenu();
}

function closeSidebarUserMenu() {
  const menu = document.getElementById('sidebarUserMenu');
  if (menu) menu.classList.remove('open');
}

function updateSidebarUserMenu() {
  const wrap = document.getElementById('sidebarUserWrap');
  const nameEl = document.getElementById('sidebarUserName');
  const subEl = document.getElementById('sidebarUserSub');
  const avatarImgEl = document.getElementById('sidebarUserAvatarImg');
  const avatarIconEl = document.getElementById('sidebarUserAvatarIcon');
  if (!wrap || !nameEl || !subEl || !avatarImgEl || !avatarIconEl) return;

  const isAuthenticated = Boolean(state.currentUser && state.authToken);
  if (isAuthenticated) {
    wrap.style.display = '';
    const displayName = state.currentUser.displayName || state.currentUser.display_name || state.currentUser.username || 'Utilisateur';
    nameEl.textContent = displayName;
    if (subEl) subEl.textContent = `@${state.currentUser.username || ''}`;
    setAvatarPreview(
      avatarImgEl,
      avatarIconEl,
      state.currentUser.avatarData || state.currentUser.avatar_data || null,
    );
  } else {
    wrap.style.display = 'none';
    closeSidebarUserMenu();
  }
}

async function handleAuthLogout() {
  if (!state.currentUser || !state.authToken) {
    notify('Aucun utilisateur connecté.', 'error');
    return;
  }

  const name = state.currentUser.username || '';

  state.authShouldReconnect = false;
  if (state.authReconnectTimer) {
    clearTimeout(state.authReconnectTimer);
    state.authReconnectTimer = null;
  }
  if (state.authWs) {
    try { state.authWs.close(); } catch (_) {}
    state.authWs = null;
  }

  state.authToken = null;
  state.currentUser = null;
  state.contacts = [];
  state.contactProfilesByName = {};
  state.contactProfilesHydrating = false;
  state.lastContactProfilesHydrateAt = 0;
  state.friendIncoming = [];
  state.friendOutgoing = [];
  state.profileAvatarDraft = undefined;
  clearPersistedAuthSession();
  renderContactsList();
  renderFriendRequests();
  renderProfileForm(null);

  setAuthStatus('Non connecté.', 'info');
  setProfileStatus('Connectez-vous pour modifier votre profil.', 'info');
  updateAuthButtonsVisibility();

  if (name) {
    notify(`Déconnecté de ${name}.`, 'info');
  }
}

async function handleAuthLogin() {
  const userInput = document.getElementById('authUsernameInput');
  const passInput = document.getElementById('authPasswordInput');
  if (!userInput || !passInput) return;

  if (state.currentUser && state.authToken) {
    const name = state.currentUser.username || '';
    const msg = name
      ? `Déjà connecté en tant que ${name}. Déconnectez-vous avant de changer de compte.`
      : 'Vous êtes déjà connecté. Déconnectez-vous avant de changer de compte.';
    setAuthStatus(msg, 'error');
    notify(msg, 'error');
    return;
  }

  const username = userInput.value.trim();
  const password = passInput.value;

  if (!username || !password) {
    setAuthStatus('Entrez un identifiant et un mot de passe.', 'error');
    return;
  }

  try {
    setAuthStatus('Connexion en cours...', 'info');
    const data = await apiRequest('/api/auth/login', {
      method: 'POST',
      form: true,
      body: { username, password },
    });
    state.authToken = data.access_token;
    state.currentUser = { username: username.trim().toLowerCase() };

    const rememberToggle = document.getElementById('rememberSessionToggle');
    if (rememberToggle && rememberToggle.checked) {
      persistAuthSession(state.currentUser.username, state.authToken);
    } else {
      clearPersistedAuthSession();
    }

    setAuthStatus(`Connecté en tant que ${state.currentUser.username}`, 'success');
    await refreshUserProfileFromApi();
    openAuthWebSocket();
    sendPresenceInfo();
    updateAuthButtonsVisibility();
  } catch (err) {
    const msg = err && err.message ? err.message : 'Erreur d\'authentification.';
    setAuthStatus(msg, 'error');
    notify(msg, 'error');
  }
}

async function handleAuthRegister() {
  const userInput = document.getElementById('authUsernameInput');
  const passInput = document.getElementById('authPasswordInput');
  if (!userInput || !passInput) return;

  if (state.currentUser && state.authToken) {
    const name = state.currentUser.username || '';
    const msg = name
      ? `Vous êtes déjà connecté en tant que ${name}. Déconnectez-vous pour créer un nouveau compte ou changer d'utilisateur.`
      : 'Vous êtes déjà connecté. Déconnectez-vous pour créer un nouveau compte ou changer d’utilisateur.';
    setAuthStatus(msg, 'error');
    notify(msg, 'error');
    return;
  }

  const username = userInput.value.trim();
  const password = passInput.value;

  if (!username || !password) {
    setAuthStatus('Choisissez un identifiant et un mot de passe.', 'error');
    return;
  }

  try {
    setAuthStatus('Création du compte...', 'info');
    await apiRequest('/api/auth/register', {
      method: 'POST',
      body: { username, password },
    });
    // Enchaîner avec une connexion automatique
    await handleAuthLogin();
  } catch (err) {
    const msg = err && err.message ? err.message : 'Erreur lors de la création du compte.';
    setAuthStatus(msg, 'error');
    notify(msg, 'error');
  }
}

function handleAddContact() {
  if (!state.currentUser) {
    notify('Connectez-vous avant d\'ajouter des contacts.', 'error');
    return;
  }
  const input = document.getElementById('newContactInput');
  if (!input) return;
  const name = input.value.trim().toLowerCase();
  if (!name) {
    notify('Entrez un nom d\'utilisateur à ajouter.', 'error');
    return;
  }
  sendFriendRequestViaApi(name);
  input.value = '';
}

async function sendFriendRequestViaApi(name) {
  if (!state.authToken) {
    notify('Connectez-vous avant d\'ajouter des contacts.', 'error');
    return;
  }
  try {
    const res = await apiRequest('/api/contacts/requests', {
      method: 'POST',
      body: { target_username: name },
    });
    state.friendIncoming = Array.isArray(res.incoming) ? res.incoming : [];
    state.friendOutgoing = Array.isArray(res.outgoing) ? res.outgoing : [];
    renderFriendRequests();
    notify(`Demande d'ami envoyée à ${name}.`, 'success');
    await refreshUserProfileFromApi();
    if (state.authWs && state.authWs.readyState === WebSocket.OPEN && state.currentUser && state.currentUser.username) {
      try {
        state.authWs.send(JSON.stringify({ type: 'friend-request-notify', to: name }));
      } catch (_) {}
    }
  } catch (err) {
    const msg = err && err.message ? err.message : 'Erreur lors de l\'envoi de la demande.';
    notify(msg, 'error');
  }
}

async function acceptFriendRequestViaApi(name) {
  if (!state.authToken) return;
  try {
    const res = await apiRequest(`/api/contacts/requests/${encodeURIComponent(name)}/accept`, {
      method: 'POST',
    });
    state.friendIncoming = Array.isArray(res.incoming) ? res.incoming : [];
    state.friendOutgoing = Array.isArray(res.outgoing) ? res.outgoing : [];
    renderFriendRequests();
    notify(`${name} est maintenant dans vos contacts.`, 'success');
    await refreshUserProfileFromApi();
    if (state.authWs && state.authWs.readyState === WebSocket.OPEN && state.currentUser && state.currentUser.username) {
      try {
        state.authWs.send(JSON.stringify({ type: 'friend-accept-notify', target: name }));
      } catch (_) {}
    }
  } catch (err) {
    const msg = err && err.message ? err.message : 'Erreur lors de l\'acceptation de la demande.';
    notify(msg, 'error');
  }
}

async function rejectFriendRequestViaApi(name) {
  if (!state.authToken) return;
  try {
    const res = await apiRequest(`/api/contacts/requests/${encodeURIComponent(name)}/reject`, {
      method: 'POST',
    });
    state.friendIncoming = Array.isArray(res.incoming) ? res.incoming : [];
    state.friendOutgoing = Array.isArray(res.outgoing) ? res.outgoing : [];
    renderFriendRequests();
    if (state.authWs && state.authWs.readyState === WebSocket.OPEN && state.currentUser && state.currentUser.username) {
      try {
        state.authWs.send(JSON.stringify({ type: 'friend-reject-notify', target: name }));
      } catch (_) {}
    }
  } catch (err) {
    const msg = err && err.message ? err.message : 'Erreur lors du refus de la demande.';
    notify(msg, 'error');
  }
}

async function cancelOutgoingFriendRequestViaApi(name) {
  if (!state.authToken) return;
  try {
    const res = await apiRequest(`/api/contacts/requests/${encodeURIComponent(name)}/cancel`, {
      method: 'POST',
    });
    state.friendIncoming = Array.isArray(res.incoming) ? res.incoming : [];
    state.friendOutgoing = Array.isArray(res.outgoing) ? res.outgoing : [];
    renderFriendRequests();
    if (state.authWs && state.authWs.readyState === WebSocket.OPEN && state.currentUser && state.currentUser.username) {
      try {
        state.authWs.send(JSON.stringify({ type: 'friend-cancel-notify', target: name }));
      } catch (_) {}
    }
    notify(`Demande annulée pour ${name}.`, 'info');
    await refreshUserProfileFromApi();
  } catch (err) {
    const msg = err && err.message ? err.message : 'Erreur lors de l\'annulation de la demande.';
    notify(msg, 'error');
  }
}

async function removeContactViaApi(name) {
  if (!state.authToken) return;
  try {
    const res = await apiRequest(`/api/contacts/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    const contacts = Array.isArray(res.contacts) ? res.contacts : [];
    state.contacts = contacts.map((c) => ({
      name: c.username,
      online: false,
      sharing: false,
      roomCode: null,
      host: null,
      mode: 'local',
    }));
    renderContactsList();
    notify(`${name} a été retiré de vos contacts.`, 'success');
  } catch (err) {
    const msg = err && err.message ? err.message : 'Erreur lors de la suppression du contact.';
    notify(msg, 'error');
  }
}

function handleFriendRequestsClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const username = target.dataset.username;
  if (!username || !state.currentUser) return;

  if (action === 'accept-request') {
    acceptFriendRequestViaApi(username);
  } else if (action === 'reject-request') {
    rejectFriendRequestViaApi(username);
  } else if (action === 'cancel-outgoing-request') {
    cancelOutgoingFriendRequestViaApi(username);
  }
}

function handleContactsListClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const contactName = target.dataset.contactName;
  if (!contactName) return;

  if (action === 'remove-contact') {
    if (!state.currentUser) return;
    removeContactViaApi(contactName);
    return;
  }

  if (action === 'join-contact') {
    const roomCode = target.dataset.roomCode || '';
    const host = target.dataset.host || '';
    const mode = target.dataset.mode || 'local';
    joinContactShare(contactName, roomCode, host, mode);
  }
}

function joinContactShare(contactName, roomCode, host, mode) {
  if (!roomCode) {
    notify(`Aucun partage actif pour ${contactName}.`, 'error');
    return;
  }

  if (mode === 'remote' && !useRemoteSignaling()) {
    notify('Ce contact utilise un serveur distant. Configurez REMOTE_SIGNALING_URL avant de rejoindre.', 'error');
    return;
  }

  const codeInput = document.getElementById('joinCodeInput');
  const hostInput = document.getElementById('joinHostInput');
  if (!codeInput || !hostInput) return;

  codeInput.value = roomCode;

  if (!useRemoteSignaling()) {
    hostInput.value = host || state.localIp || 'localhost';
  }

  showPage('receive');
  // Laisser le temps au DOM de basculer avant de lancer la connexion
  setTimeout(() => {
    joinSession();
  }, 50);
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

function selectPreset(el) {
  document.querySelectorAll('#presetPills .quality-pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');

  const res = parseInt(el.dataset.res || '0', 10);
  const fps = parseInt(el.dataset.fps || '0', 10);
  const bitrate = parseInt(el.dataset.bitrate || '0', 10);

  if (!Number.isNaN(res) && res > 0) {
    const resEl = document.querySelector(`#resPills .quality-pill[data-res="${res}"]`);
    if (resEl) selectRes(resEl);
  }

  if (!Number.isNaN(fps) && fps > 0) {
    const fpsEl = document.querySelector(`#fpsPills .quality-pill[data-fps="${fps}"]`);
    if (fpsEl) selectFps(fpsEl);
  }

  if (!Number.isNaN(bitrate) && bitrate > 0) {
    const brEl = document.querySelector(`#bitratePills .quality-pill[data-bitrate="${bitrate}"]`);
    if (brEl) selectBitrate(brEl);
  }

  if (Object.prototype.hasOwnProperty.call(el.dataset, 'lowlatency')) {
    const lowLatencyCheckbox = document.getElementById('lowLatencyMode');
    if (lowLatencyCheckbox) {
      lowLatencyCheckbox.checked = el.dataset.lowlatency === '1';
    }
  }
}

// ─── Sources ──────────────────────────────────────────────────────────────────
async function loadSources() {
  const grid = document.getElementById('sourcesGrid');
  grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--text-dim);font-family:var(--mono);font-size:12px">Chargement...</div>';

  try {
    const sources = await window.electronAPI.getSources();
    grid.innerHTML = '';

    sources.forEach((src, index) => {
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

      // Sélectionner automatiquement la première source au chargement
      if (index === 0) {
        div.classList.add('selected');
        state.selectedSourceId = src.id;
      }
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
        // Certains environnements ne respectent la contrainte cursor
        // qu'en dehors du bloc mandatory.
        cursor: showCursor ? 'always' : 'never',
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

      // Renforcer la contrainte de curseur au niveau de la piste
      const showCursor = document.getElementById('showCursor').checked;
      await videoTrack.applyConstraints({ cursor: showCursor ? 'always' : 'never' }).catch(() => {});
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

  updateStatus('Pas en partage', 'off');
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

    // Associer la connexion de signalisation au compte courant
    if (state.currentUser && state.currentUser.username) {
      try {
        state.signalingWs.send(JSON.stringify({ type: 'attach-user', username: state.currentUser.username }));
      } catch (_) {}
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

  const maxAttempts = 3;
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

function preferH264(pc) {
  if (typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) return;
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps || !Array.isArray(caps.codecs)) return;

  const codecs = caps.codecs;
  const h264 = codecs.filter(c => (c.mimeType || '').toLowerCase() === 'video/h264');
  if (!h264.length) return;
  const others = codecs.filter(c => (c.mimeType || '').toLowerCase() !== 'video/h264');
  const preferred = [...h264, ...others];

  pc.getTransceivers().forEach(t => {
    if (t.sender && t.sender.track && t.sender.track.kind === 'video' && typeof t.setCodecPreferences === 'function') {
      try {
        t.setCodecPreferences(preferred);
      } catch (_) {
        // Ignore if not supported
      }
    }
  });
}

async function createBroadcasterPeer(peerId) {
  const iceConfig = await getIceConfig();
  const pc = new RTCPeerConnection(iceConfig);
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

  preferH264(pc);

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
    document.getElementById('joinBtn').disabled = true;
    document.getElementById('joinBtn').textContent = isReconnect ? 'Reconnexion...' : 'Connexion...';
    if (state.currentUser && state.currentUser.username) {
      try {
        state.receiverWs.send(JSON.stringify({ type: 'attach-user', username: state.currentUser.username }));
      } catch (_) {}
    }
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

  const maxAttempts = 3;
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
  const iceConfig = await getIceConfig();
  state.receiverPc = new RTCPeerConnection(iceConfig);

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
  document.getElementById('nav-contacts')?.addEventListener('click', () => showPage('contacts'));
  document.getElementById('nav-profile')?.addEventListener('click', () => showPage('profile'));
  document.getElementById('nav-settings')?.addEventListener('click', () => showPage('settings'));
  document.getElementById('nav-info')?.addEventListener('click', () => showPage('info'));

  document.getElementById('refreshSourcesBtn')?.addEventListener('click', loadSources);
  document.getElementById('copyCodeBtn')?.addEventListener('click', copyRoomCode);
  document.getElementById('startBtn')?.addEventListener('click', startSharing);
  document.getElementById('stopBtn')?.addEventListener('click', stopSharing);
  document.getElementById('joinBtn')?.addEventListener('click', joinSession);
  document.getElementById('fullscreenBtn')?.addEventListener('click', toggleFullscreen);
  document.getElementById('leaveBtn')?.addEventListener('click', leaveSession);

  document.getElementById('authLoginBtn')?.addEventListener('click', handleAuthLogin);
  document.getElementById('authRegisterBtn')?.addEventListener('click', handleAuthRegister);
  document.getElementById('authLogoutBtn')?.addEventListener('click', handleAuthLogout);
  document.getElementById('sidebarLogoutBtn')?.addEventListener('click', async () => {
    closeSidebarUserMenu();
    await handleAuthLogout();
  });
  document.getElementById('sidebarProfileSettingsBtn')?.addEventListener('click', () => {
    closeSidebarUserMenu();
    showPage('profile');
  });
  document.getElementById('sidebarUserBtn')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = document.getElementById('sidebarUserMenu');
    if (!menu) return;
    menu.classList.toggle('open');
  });
  document.addEventListener('click', (event) => {
    const wrap = document.getElementById('sidebarUserWrap');
    if (!wrap) return;
    if (!wrap.contains(event.target)) {
      closeSidebarUserMenu();
    }
  });
  document.getElementById('addContactBtn')?.addEventListener('click', handleAddContact);
  document.getElementById('contactsList')?.addEventListener('click', handleContactsListClick);
  document.getElementById('incomingRequestsList')?.addEventListener('click', handleFriendRequestsClick);
  document.getElementById('outgoingRequestsList')?.addEventListener('click', handleFriendRequestsClick);
  document.getElementById('checkUpdatesBtn')?.addEventListener('click', async () => {
    if (!window.electronAPI?.checkForUpdates) {
      notify('Mises à jour indisponibles dans cette version.', 'error');
      return;
    }
    notify('Recherche de mises à jour...', 'info');
    try {
      const res = await window.electronAPI.checkForUpdates();
      if (!res) {
        notify('Aucune réponse du système de mise à jour.', 'error');
        return;
      }
      notify(res.message || (res.ok ? 'Recherche terminée.' : 'Erreur mise à jour.'), res.ok ? 'success' : 'error');
    } catch (e) {
      notify('Erreur lors de la recherche de mises à jour.', 'error');
    }
  });

  document.getElementById('profileSaveBtn')?.addEventListener('click', handleProfileSave);
  document.getElementById('profileResetBtn')?.addEventListener('click', handleProfileReset);
  document.getElementById('profileAvatarBtn')?.addEventListener('click', () => {
    document.getElementById('profileAvatarInput')?.click();
  });
  document.getElementById('profileAvatarClearBtn')?.addEventListener('click', clearProfileAvatarDraft);
  document.getElementById('profileAvatarInput')?.addEventListener('change', handleProfileAvatarSelected);

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
  document.querySelectorAll('#presetPills .quality-pill').forEach(el => {
    el.addEventListener('click', () => selectPreset(el));
  });

  document.getElementById('changelogModalCloseBtn')?.addEventListener('click', () => {
    hideChangelogModal();
  });
  document.getElementById('changelogModalOkBtn')?.addEventListener('click', () => {
    hideChangelogModal();
  });
  document.getElementById('changelogModal')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      hideChangelogModal();
    }
  });

  document.getElementById('showChangelogBtn')?.addEventListener('click', async () => {
    const container = document.getElementById('aboutChangelog');
    const btn = document.getElementById('showChangelogBtn');
    if (!container) return;

    // Si on n'a pas encore de changelog, tenter de le récupérer depuis GitHub
    if (!state.hasChangelog || !container.textContent.trim()) {
      if (state.lastChangelog && state.lastChangelog.version && state.lastChangelog.notes) {
        renderChangelogIntoAbout(state.lastChangelog.version, state.lastChangelog.notes);
      } else if (!window.electronAPI?.getReleaseNotes || !state.appVersion) {
        notify('Aucun changelog disponible pour cette version.', 'info');
        return;
      } else {
        try {
          const res = await window.electronAPI.getReleaseNotes(state.appVersion);
          if (!res || !res.ok || !res.notes) {
            notify(res && res.message ? res.message : 'Aucun changelog disponible pour cette version.', 'info');
            return;
          }

          const maxLen = 2000;
          const text = String(res.notes).slice(0, maxLen);
          renderChangelogIntoAbout(res.version || state.appVersion, text);
          state.hasChangelog = true;
          state.lastChangelog = { version: res.version || state.appVersion, notes: text };
          try {
            if (window.localStorage) {
              window.localStorage.setItem('cachedChangelog', JSON.stringify({ version: res.version || state.appVersion, notes: text }));
            }
          } catch (_) {}
        } catch (_) {
          notify('Erreur lors de la récupération du changelog.', 'error');
          return;
        }
      }
    }

    const isVisible = container.style.display !== 'none';
    if (isVisible) {
      container.style.display = 'none';
      if (btn) btn.textContent = 'Voir le changelog';
    } else {
      container.style.display = 'block';
      if (btn) btn.textContent = 'Masquer le changelog';
    }
  });

  if (window.electronAPI?.onUpdateDownloaded) {
    window.electronAPI.onUpdateDownloaded((info) => {
      const v = info && info.version ? String(info.version) : '';
      const notes = info && info.notes ? String(info.notes) : '';

      // Stocker les informations de changelog pour l'affichage au prochain démarrage
      try {
        if (window.localStorage && v) {
          const maxLen = 2000;
          const text = String(notes || '').slice(0, maxLen);
          window.localStorage.setItem('lastUpdateInfo', JSON.stringify({ version: v, notes: text }));
          window.localStorage.setItem('cachedChangelog', JSON.stringify({ version: v, notes: text }));
        }
      } catch (_) {}

      state.hasChangelog = true;
      state.lastChangelog = { version: v, notes };
      const container = document.getElementById('aboutChangelog');
      const btn = document.getElementById('showChangelogBtn');
      if (container && btn) {
        btn.textContent = 'Masquer le changelog';
      }

      const msg = v
        ? `Mise à jour ${v} téléchargée. L'application va redémarrer pour l'installer...`
        : 'Une mise à jour a été téléchargée. L\'application va redémarrer pour l\'installer...';
      notify(msg, 'success');
    });
  }
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
setupUiBindings();
init();
// Charger automatiquement les sources de capture au démarrage
loadSources().catch(() => {});
