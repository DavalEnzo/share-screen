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

  store.users[u] = { passwordHash, salt, contacts: [] };
  persistStore();

  return { ok: true, user: { username: u, contacts: [] } };
}

function validateUser(username, password) {
  const u = normalizeUsername(username);
  const pwd = String(password || '');
  const record = store.users[u];

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
  const record = store.users[u];
  if (!record) return null;
  return { username: u, contacts: [...(record.contacts || [])] };
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

  const ownerRecord = store.users[owner];
  const contactRecord = store.users[contact];

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

  const ownerRecord = store.users[owner];
  if (!ownerRecord || !ownerRecord.contacts) {
    return { ok: false, error: 'Utilisateur introuvable.' };
  }

  ownerRecord.contacts = ownerRecord.contacts.filter(c => c !== contact);
  persistStore();

  return { ok: true, contacts: [...ownerRecord.contacts] };
}

function getAllUsernames() {
  return Object.keys(store.users || {});
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
};
