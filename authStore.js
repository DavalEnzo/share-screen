const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_PATH = path.join(__dirname, 'users.json');

/**
 * Structure stockée dans users.json :
 * {
 *   "users": {
 *     "alice": { passwordHash, salt, contacts: ["bob"] }
 *   }
 * }
 */
let store = { users: {} };

function ensureUserStructure(username) {
  const u = normalizeUsername(username);
  const record = store.users[u];
  if (!record) return null;

  if (!Array.isArray(record.contacts)) {
    record.contacts = record.contacts ? Array.from(record.contacts) : [];
  }
  if (!Array.isArray(record.incomingRequests)) {
    record.incomingRequests = [];
  }
  if (!Array.isArray(record.outgoingRequests)) {
    record.outgoingRequests = [];
  }

  return record;
}

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.users && typeof parsed.users === 'object') {
        store = { users: parsed.users };
      }
    }
  } catch (err) {
    console.error('[authStore] Erreur lors du chargement de users.json:', err.message);
    store = { users: {} };
  }
}

function persistStore() {
  try {
    const data = JSON.stringify(store, null, 2);
    fs.writeFileSync(STORE_PATH, data, 'utf8');
  } catch (err) {
    console.error('[authStore] Erreur lors de l\'écriture de users.json:', err.message);
  }
}

function normalizeUsername(name) {
  return String(name || '').trim().toLowerCase();
}

function hashPassword(password, salt) {
  const buf = crypto.scryptSync(String(password), salt, 64);
  return buf.toString('hex');
}

function registerUser(username, password) {
  const u = normalizeUsername(username);
  const pwd = String(password || '');

  if (!u || pwd.length < 4) {
    return { ok: false, error: 'Identifiants invalides (4 caractères minimum).' };
  }

  if (store.users[u]) {
    return { ok: false, error: 'Nom d\'utilisateur déjà pris.' };
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(pwd, salt);

  store.users[u] = {
    passwordHash,
    salt,
    contacts: [],
    incomingRequests: [],
    outgoingRequests: [],
  };
  persistStore();

  return { ok: true, user: { username: u, contacts: [] } };
}

function validateUser(username, password) {
  const u = normalizeUsername(username);
  const pwd = String(password || '');
  const record = ensureUserStructure(u);

  if (!record) {
    return { ok: false, error: 'Utilisateur introuvable.' };
  }

  const candidateHash = hashPassword(pwd, record.salt);
  if (candidateHash !== record.passwordHash) {
    return { ok: false, error: 'Mot de passe incorrect.' };
  }

  return { ok: true, user: { username: u, contacts: [...(record.contacts || [])] } };
}

function getUser(username) {
  const u = normalizeUsername(username);
  const record = ensureUserStructure(u);
  if (!record) return null;
  return {
    username: u,
    contacts: [...(record.contacts || [])],
    incomingRequests: [...(record.incomingRequests || [])],
    outgoingRequests: [...(record.outgoingRequests || [])],
  };
}

function getContacts(username) {
  const user = getUser(username);
  if (!user) return { ok: false, error: 'Utilisateur introuvable.' };
  return { ok: true, contacts: user.contacts };
}

function addContact(ownerName, contactName) {
  const owner = normalizeUsername(ownerName);
  const contact = normalizeUsername(contactName);

  if (!owner || !contact || owner === contact) {
    return { ok: false, error: 'Contact invalide.' };
  }

  const ownerRecord = ensureUserStructure(owner);
  const contactRecord = ensureUserStructure(contact);

  if (!ownerRecord) {
    return { ok: false, error: 'Utilisateur introuvable.' };
  }
  if (!contactRecord) {
    return { ok: false, error: 'Contact introuvable.' };
  }

  ownerRecord.contacts = ownerRecord.contacts || [];
  if (!ownerRecord.contacts.includes(contact)) {
    ownerRecord.contacts.push(contact);
    persistStore();
  }

  return { ok: true, contacts: [...ownerRecord.contacts] };
}

function removeContact(ownerName, contactName) {
  const owner = normalizeUsername(ownerName);
  const contact = normalizeUsername(contactName);

  const ownerRecord = ensureUserStructure(owner);
  if (!ownerRecord || !ownerRecord.contacts) {
    return { ok: false, error: 'Utilisateur introuvable.' };
  }

  // Suppression unilatérale : seul "owner" enlève "contact" de sa liste
  ownerRecord.contacts = ownerRecord.contacts.filter(c => c !== contact);

  // Nettoyer d'éventuelles demandes d'amis côté owner
  if (ownerRecord.incomingRequests) {
    ownerRecord.incomingRequests = ownerRecord.incomingRequests.filter(u => u !== contact);
  }
  if (ownerRecord.outgoingRequests) {
    ownerRecord.outgoingRequests = ownerRecord.outgoingRequests.filter(u => u !== contact);
  }

  persistStore();

  return { ok: true, contacts: [...ownerRecord.contacts] };
}

function getAllUsernames() {
  return Object.keys(store.users || {});
}

function getFriendRequests(username) {
  const u = normalizeUsername(username);
  const record = ensureUserStructure(u);
  if (!record) return { ok: false, error: 'Utilisateur introuvable.' };
  return {
    ok: true,
    incoming: [...(record.incomingRequests || [])],
    outgoing: [...(record.outgoingRequests || [])],
  };
}

function addContactPairInternal(a, b) {
  const ra = ensureUserStructure(a);
  const rb = ensureUserStructure(b);
  if (!ra || !rb) return;

  ra.contacts = ra.contacts || [];
  rb.contacts = rb.contacts || [];

  if (!ra.contacts.includes(b)) ra.contacts.push(b);
  if (!rb.contacts.includes(a)) rb.contacts.push(a);
}

function sendFriendRequest(fromName, toName) {
  const from = normalizeUsername(fromName);
  const to = normalizeUsername(toName);

  if (!from || !to || from === to) {
    return { ok: false, error: 'Contact invalide.' };
  }

  const fromRecord = ensureUserStructure(from);
  const toRecord = ensureUserStructure(to);

  if (!fromRecord || !toRecord) {
    return { ok: false, error: 'Utilisateur ou contact introuvable.' };
  }

  fromRecord.contacts = fromRecord.contacts || [];
  toRecord.contacts = toRecord.contacts || [];

  const fromHasTo = fromRecord.contacts.includes(to);
  const toHasFrom = toRecord.contacts.includes(from);

  if (fromHasTo || toHasFrom) {
    addContactPairInternal(from, to);

    fromRecord.incomingRequests = (fromRecord.incomingRequests || []).filter(u => u !== to);
    fromRecord.outgoingRequests = (fromRecord.outgoingRequests || []).filter(u => u !== to);
    toRecord.incomingRequests = (toRecord.incomingRequests || []).filter(u => u !== from);
    toRecord.outgoingRequests = (toRecord.outgoingRequests || []).filter(u => u !== from);

    persistStore();
    return { ok: true, autoAccepted: true };
  }

  fromRecord.incomingRequests = fromRecord.incomingRequests || [];
  fromRecord.outgoingRequests = fromRecord.outgoingRequests || [];
  toRecord.incomingRequests = toRecord.incomingRequests || [];
  toRecord.outgoingRequests = toRecord.outgoingRequests || [];

  // Demande croisée déjà existante -> auto-acceptation
  const hasCrossRequest =
    fromRecord.incomingRequests.includes(to) ||
    toRecord.outgoingRequests.includes(from);

  if (hasCrossRequest) {
    fromRecord.incomingRequests = fromRecord.incomingRequests.filter(u => u !== to);
    fromRecord.outgoingRequests = fromRecord.outgoingRequests.filter(u => u !== to);
    toRecord.incomingRequests = toRecord.incomingRequests.filter(u => u !== from);
    toRecord.outgoingRequests = toRecord.outgoingRequests.filter(u => u !== from);

    addContactPairInternal(from, to);
    persistStore();
    return { ok: true, autoAccepted: true };
  }

  if (!fromRecord.outgoingRequests.includes(to)) {
    fromRecord.outgoingRequests.push(to);
  }
  if (!toRecord.incomingRequests.includes(from)) {
    toRecord.incomingRequests.push(from);
  }

  persistStore();
  return { ok: true, autoAccepted: false };
}

function acceptFriendRequest(username, fromName) {
  const u = normalizeUsername(username);
  const from = normalizeUsername(fromName);

  const userRecord = ensureUserStructure(u);
  const fromRecord = ensureUserStructure(from);
  if (!userRecord || !fromRecord) {
    return { ok: false, error: 'Utilisateur introuvable.' };
  }

  userRecord.incomingRequests = userRecord.incomingRequests || [];
  fromRecord.outgoingRequests = fromRecord.outgoingRequests || [];

  if (!userRecord.incomingRequests.includes(from)) {
    return { ok: false, error: 'Aucune demande trouvée.' };
  }

  userRecord.incomingRequests = userRecord.incomingRequests.filter(u2 => u2 !== from);
  fromRecord.outgoingRequests = fromRecord.outgoingRequests.filter(u2 => u2 !== u);

  addContactPairInternal(u, from);
  persistStore();
  return { ok: true };
}

function rejectFriendRequest(username, fromName) {
  const u = normalizeUsername(username);
  const from = normalizeUsername(fromName);

  const userRecord = ensureUserStructure(u);
  const fromRecord = ensureUserStructure(from);
  if (!userRecord || !fromRecord) {
    return { ok: false, error: 'Utilisateur introuvable.' };
  }

  userRecord.incomingRequests = (userRecord.incomingRequests || []).filter(u2 => u2 !== from);
  fromRecord.outgoingRequests = (fromRecord.outgoingRequests || []).filter(u2 => u2 !== u);

  persistStore();
  return { ok: true };
}

// Charger le store au démarrage
loadStore();

module.exports = {
  registerUser,
  validateUser,
  getUser,
  getContacts,
  addContact,
  removeContact,
  getAllUsernames,
   getFriendRequests,
   sendFriendRequest,
   acceptFriendRequest,
   rejectFriendRequest,
};
