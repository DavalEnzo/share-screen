# ScreenShare Pro — Application Electron

Application de partage d'écran en 1080p60 basée sur Electron + WebRTC.

## 🚀 Installation & Lancement

```bash
# 1. Aller dans le dossier
cd screenshare-app

# 2. Installer les dépendances
npm install

# 3. Lancer l'application
npm start
```

## 📁 Structure des fichiers

```
screenshare-app/
├── main.js          → Processus principal Electron (serveur WebSocket de signalisation)
├── preload.js       → Bridge sécurisé entre main et renderer
├── index.html       → Interface utilisateur
├── renderer.js      → Logique WebRTC (capture, streaming, réception)
└── package.json     → Configuration npm
```

## 🎯 Fonctionnalités

- **Partage d'écran** jusqu'à 1080p @ 60 fps
- **Sélection de source** : écran entier ou fenêtre spécifique
- **Qualité configurable** : 720p / 1080p / 1440p, 30/60 fps, 4/8/15 Mbps
- **Audio** : son système + microphone (optionnel)
- **WebRTC P2P** : aucun serveur cloud, 100% local
- **Serveur de signalisation** intégré (WebSocket sur port 8765)
- **Code de session** pour partager facilement

## 🌐 Comment utiliser

### Côté diffuseur
1. Aller dans "Partager l'écran"
2. Cliquer "Actualiser" pour voir les sources disponibles
3. Sélectionner l'écran ou la fenêtre à partager
4. Choisir la qualité
5. Cliquer "Démarrer le partage"
6. Partager le **code de session** ou l'**adresse IP**

### Côté récepteur (même réseau)
1. Aller dans "Recevoir un flux"
2. Saisir le **code de session** + l'**IP du diffuseur**
3. Cliquer "Rejoindre la session"

## 📦 Build pour distribution

```bash
npm run build
# → Génère un exécutable dans /dist
```

## 🔧 Dépendances supplémentaires pour le serveur WebSocket

Le serveur de signalisation utilise le module `ws`. Ajoutez-le :

```bash
npm install ws
```

## ⚡ Optimisations performance

- Encodage via `getUserMedia` avec contraintes `chromeMediaSource: 'desktop'`
- Paramètres WebRTC : `maxBitrate` et `maxFramerate` sur les senders
- ICE STUN Google pour la découverte P2P
- Mode faible latence disponible dans les paramètres
