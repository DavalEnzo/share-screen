# 🚀 Guide de déploiement public — ScreenShare Pro

## Vue d'ensemble

```
Utilisateur A (diffuseur)          Utilisateur B (viewer)
      │                                    │
      └──────────┐         ┌───────────────┘
                 ▼         ▼
         ┌───────────────────┐
         │  Railway (gratuit) │   ← Serveur de signalisation WebSocket
         │  screenshare.railway.app │
         └───────────────────┘
                 │
         (échange offres WebRTC)
                 │
      ┌──────────┘
      ▼
  Connexion P2P directe (WebRTC)
  → Vidéo 1080p60 ne passe PAS par le serveur
```

---

## ÉTAPE 1 — Déployer le serveur de signalisation sur Railway

**1.1 Créer un compte Railway**
→ https://railway.app (gratuit, pas de CB requise)

**1.2 Créer un nouveau projet**
```
New Project → Deploy from GitHub repo
```

**1.3 Pousser le dossier `screenshare-server` sur GitHub**
```bash
cd screenshare-server
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/TON_USER/screenshare-server.git
git push -u origin main
```

**1.4 Connecter Railway à ce repo**
- Dans Railway → "New Project" → "Deploy from GitHub"
- Sélectionner le repo `screenshare-server`
- Railway détecte automatiquement Node.js et lance `npm start`

**1.5 Récupérer l'URL publique**
- Dans Railway → Settings → Networking → "Generate Domain"
- Tu obtiens une URL du type : `screenshare-server-production.up.railway.app`

**1.6 Vérifier que le serveur tourne**
```
https://screenshare-server-production.up.railway.app/health
```
Doit retourner : `{"status":"ok","rooms":0,"clients":0,"uptime":42}`

---

## ÉTAPE 2 — Configurer l'app Electron

**2.1 Ouvrir `renderer.js` et modifier la ligne 4 :**
```javascript
// AVANT :
const REMOTE_SIGNALING_URL = 'wss://TON-PROJET.up.railway.app';

// APRÈS (remplacer par ton URL Railway) :
const REMOTE_SIGNALING_URL = 'wss://screenshare-server-production.up.railway.app';
```

> ⚠️ Utiliser `wss://` (avec S) car Railway fournit le TLS automatiquement.

Alternative sans modifier le code : definir la variable d'environnement au lancement.

```powershell
$env:REMOTE_SIGNALING_URL="wss://screenshare-server-production.up.railway.app"; npm start
```

**2.2 Activer les TURN servers (optionnel mais recommandé)**

→ Créer un compte gratuit sur https://www.metered.ca/tools/openrelay/

Dans `renderer.js`, décommenter les blocs TURN :
```javascript
{
  urls: 'turn:openrelay.metered.ca:80',
  username: 'openrelayproject',
  credential: 'openrelayproject',
},
// etc.
```

---

## ÉTAPE 3 — Build et distribution

**3.1 Builder l'app**
```bash
cd screenshare-app
npm install
npm run build
```

Résultat dans `dist/` :
- `ScreenShare Pro Setup 1.0.0.exe`  → Windows
- `ScreenShare Pro-1.0.0.dmg`        → macOS
- `ScreenShare Pro-1.0.0.AppImage`   → Linux

**3.2 Publier sur GitHub Releases (gratuit)**

```bash
# Créer un repo GitHub pour l'app
git init
git add .
git commit -m "ScreenShare Pro v1.0.0"
git remote add origin https://github.com/TON_USER/screenshare-app.git
git push -u origin main

# Créer une release
# → GitHub → Releases → "Create a new release"
# → Upload les fichiers du dossier dist/
# → Les utilisateurs peuvent télécharger directement
```

**3.3 Partager avec ta communauté**
```
Lien de téléchargement :
https://github.com/TON_USER/screenshare-app/releases/latest
```

---

## ⚠️ Avertissement Windows Defender (sans signature de code)

Quand un utilisateur lance le `.exe`, Windows peut afficher :

> "Windows a protégé votre PC — Éditeur inconnu"

**Solution pour ta communauté interne :**
→ Cliquer sur "Informations complémentaires" → "Exécuter quand même"

C'est normal sans certificat de signature (qui coûte ~100€/an).
Pour macOS, même chose : clic droit → Ouvrir → Ouvrir quand même.

---

## 💸 Limites du plan gratuit Railway

| Ressource | Limite gratuite |
|---|---|
| CPU | 2 vCPU partagés |
| RAM | 512 MB |
| Bande passante (signalisation) | Illimitée* |
| Heures d'exécution | 500h/mois (~20j) |
| Mise en veille | Après 30min d'inactivité |

> *La vidéo P2P NE passe PAS par Railway — Railway ne gère que les messages de signalisation (quelques octets par connexion).

**Si Railway se met en veille :** la première connexion prend ~5s à "réveiller" le serveur. Acceptable pour une communauté interne.

---

## 🔧 Architecture finale

```
screenshare-server/   → Déployé sur Railway (serveur de signalisation)
screenshare-app/      → Distribué via GitHub Releases (app Electron)
```

C'est tout ! Aucune autre infrastructure nécessaire.
