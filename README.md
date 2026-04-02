# 🚀 TikTok Live Server - Railway

Serveur WebSocket pour jeux TikTok LIVE, déployable sur Railway.

## 📦 Déploiement sur Railway

### Étape 1 : Créer un projet Railway
1. Va sur [railway.app](https://railway.app)
2. Connecte-toi avec GitHub
3. Clique sur "New Project" → "Deploy from GitHub repo"

### Étape 2 : Upload les fichiers
Crée un repo GitHub avec ces fichiers :
- `server.js`
- `package.json`

### Étape 3 : Configurer Railway
Railway détecte automatiquement Node.js et lance `npm start`.

### Étape 4 : Obtenir l'URL publique
1. Va dans Settings → Networking
2. Clique "Generate Domain"
3. Tu auras une URL comme : `https://ton-app.up.railway.app`

## 🎮 Configuration du Jeu

Dans le jeu (Dashboard → 🌐 Serveur) :
1. Clique sur "☁️ Railway"
2. Entre ton URL : `wss://ton-app.up.railway.app`
3. Clique "Sauvegarder & Reconnecter"

**OU** ajoute le paramètre URL :
```
https://ton-jeu.github.io/?server=wss://ton-app.up.railway.app
```

## 📊 Dashboard

Le serveur inclut un dashboard accessible à :
```
https://ton-app.up.railway.app
```

Fonctionnalités :
- Connexion au Live TikTok
- Stats en temps réel (cadeaux, likes, viewers)
- Classement des donateurs
- Export des données

## ⚠️ Notes

- **Données** : Sur Railway, les données sont en mémoire (perdues au redémarrage)
- **WebSocket** : Utilise `wss://` (avec SSL) sur Railway
- **Gratuit** : Railway offre 500h/mois gratuites

## 🔧 Variables d'environnement

Railway définit automatiquement :
- `PORT` - Port du serveur
- `RAILWAY_ENVIRONMENT` - Détection Railway
- `RAILWAY_PUBLIC_DOMAIN` - URL publique
