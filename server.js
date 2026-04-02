const { WebcastPushConnection } = require('tiktok-live-connector');
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// ================= CONFIGURATION =================
// Railway utilise process.env.PORT, sinon 8832 en local
const PORT = process.env.PORT || 8832;
const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT;

// Compatible pkg .exe : utiliser le dossier du .exe, pas le snapshot interne
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const DATA_DIR = path.join(BASE_DIR, 'data');
const LOG_FILE = path.join(DATA_DIR, 'live_data.json');
const MAX_RECONNECT_ATTEMPTS = 4;
const RECONNECT_DELAY_MS = 5000;

// ================= INITIALISATION =================
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let currentConnection = null;
let connectedClients = 0;
let currentUsername = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let isManualDisconnect = false;

const processedEvents = new Set();

// ================= STOCKAGE PERSISTANT SERVEUR =================
let useFileStorage = true;
try {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log('📁 Dossier data/ créé');
    }
} catch (e) {
    console.warn('⚠️ Stockage fichier indisponible (Railway mode mémoire):', e.message);
    useFileStorage = false;
}

let serverState = {
    coinsBoard: {},
    likesBoard: {},
    redistributionBoard: {},
    marketingHistory: [],
    rewardsHistory: [],
    withdrawalsHistory: [],
    chatMessages: [],
    totalCoins: 0,
    totalLikes: 0,
    totalGifts: 0,
    totalRedistributed: 0,
    totalMarketing: 0,
    totalRewards: 0,
    totalWithdrawals: 0,
    viewers: [],
    sessions: [],
    lastUpdated: null
};

function loadServerState() {
    if (!useFileStorage) {
        console.log('📦 Mode mémoire (données non persistantes)');
        return;
    }
    try {
        if (fs.existsSync(LOG_FILE)) {
            const raw = fs.readFileSync(LOG_FILE, 'utf-8');
            const saved = JSON.parse(raw);
            serverState = { ...serverState, ...saved };
            if (!serverState.redistributionBoard) serverState.redistributionBoard = {};
            if (!serverState.totalRedistributed) serverState.totalRedistributed = 0;
            if (!serverState.marketingHistory) serverState.marketingHistory = [];
            if (!serverState.totalMarketing) serverState.totalMarketing = 0;
            if (!serverState.rewardsHistory) serverState.rewardsHistory = [];
            if (!serverState.totalRewards) serverState.totalRewards = 0;
            if (!serverState.withdrawalsHistory) serverState.withdrawalsHistory = [];
            if (!serverState.totalWithdrawals) serverState.totalWithdrawals = 0;
            console.log('📂 Données restaurées (' + Object.keys(serverState.coinsBoard).length + ' donateurs)');
        }
    } catch (e) {
        console.warn('⚠️ Erreur chargement données:', e.message);
    }
}

let saveTimeout = null;
function saveServerState() {
    if (!useFileStorage) return; // Pas de sauvegarde en mode mémoire
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        try {
            serverState.lastUpdated = new Date().toISOString();
            fs.writeFileSync(LOG_FILE, JSON.stringify(serverState, null, 2), 'utf-8');
        } catch (e) {
            console.warn('⚠️ Erreur sauvegarde:', e.message);
        }
    }, 1000);
}

function recordGift(data) {
    const uid = data.user;
    if (!serverState.coinsBoard[uid]) {
        serverState.coinsBoard[uid] = { user: uid, profilePictureUrl: data.profilePictureUrl, total: 0, gifts: {} };
    }
    serverState.coinsBoard[uid].total += data.diamondCount;
    serverState.coinsBoard[uid].profilePictureUrl = data.profilePictureUrl || serverState.coinsBoard[uid].profilePictureUrl;
    const gn = data.giftName || 'Cadeau';
    serverState.coinsBoard[uid].gifts[gn] = (serverState.coinsBoard[uid].gifts[gn] || 0) + 1;
    serverState.totalCoins += data.diamondCount;
    serverState.totalGifts++;
    addViewer(uid);
    saveServerState();
}

function recordLike(data) {
    const uid = data.user;
    if (!serverState.likesBoard[uid]) {
        serverState.likesBoard[uid] = { user: uid, profilePictureUrl: data.profilePictureUrl, total: 0 };
    }
    serverState.likesBoard[uid].total += data.count;
    serverState.likesBoard[uid].profilePictureUrl = data.profilePictureUrl || serverState.likesBoard[uid].profilePictureUrl;
    serverState.totalLikes += data.count;
    addViewer(uid);
    saveServerState();
}

function recordChat(data) {
    serverState.chatMessages.push({ user: data.user, profilePictureUrl: data.profilePictureUrl || '', comment: data.comment, time: new Date().toISOString() });
    if (serverState.chatMessages.length > 1000) serverState.chatMessages = serverState.chatMessages.slice(-1000);
    addViewer(data.user);
    saveServerState();
}

function addViewer(uid) {
    if (!serverState.viewers.includes(uid)) serverState.viewers.push(uid);
}

loadServerState();

// ================= WEBSOCKET =================
wss.on('connection', (ws) => {
    connectedClients++;
    console.log('🔌 Client connecté (Total: ' + connectedClients + ')');

    ws.send(JSON.stringify({ type: 'INFO', message: 'Serveur Connecté' }));

    ws.send(JSON.stringify({
        type: 'RESTORE',
        data: {
            coinsBoard: serverState.coinsBoard,
            likesBoard: serverState.likesBoard,
            redistributionBoard: serverState.redistributionBoard,
            totalCoins: serverState.totalCoins,
            totalLikes: serverState.totalLikes,
            totalGifts: serverState.totalGifts,
            totalRedistributed: serverState.totalRedistributed,
            totalMarketing: serverState.totalMarketing,
            totalRewards: serverState.totalRewards,
            totalWithdrawals: serverState.totalWithdrawals,
            marketingHistory: serverState.marketingHistory || [],
            rewardsHistory: serverState.rewardsHistory || [],
            withdrawalsHistory: serverState.withdrawalsHistory || [],
            viewers: serverState.viewers,
            chatMessages: serverState.chatMessages.slice(-200),
            currentUsername: currentUsername || null
        }
    }));

    if (currentConnection && currentUsername) {
        ws.send(JSON.stringify({ type: 'INFO', action: 'TIKTOK_CONNECTED', data: { username: currentUsername } }));
    }

    ws.on('close', () => {
        connectedClients--;
        console.log('❌ Client déconnecté');
    });
});

function sendToClient(type, action, data) {
    const payload = JSON.stringify({ type, action, data });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
    });
}

// ================= RECONNEXION AUTOMATIQUE =================
function attemptReconnect() {
    if (isManualDisconnect || !currentUsername) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log('🚫 Reconnexion abandonnée après ' + MAX_RECONNECT_ATTEMPTS + ' tentatives');
        sendToClient('ERROR', 'RECONNECT_FAILED', { error: 'Reconnexion échouée après ' + MAX_RECONNECT_ATTEMPTS + ' tentatives.' });
        reconnectAttempts = 0;
        return;
    }
    reconnectAttempts++;
    const delay = RECONNECT_DELAY_MS * reconnectAttempts;
    console.log('🔄 Tentative de reconnexion ' + reconnectAttempts + '/' + MAX_RECONNECT_ATTEMPTS + ' dans ' + (delay / 1000) + 's...');
    sendToClient('INFO', 'RECONNECTING', { attempt: reconnectAttempts, maxAttempts: MAX_RECONNECT_ATTEMPTS, delayMs: delay });
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { connectToTikTok(currentUsername, true); }, delay);
}

// ================= CONNEXION TIKTOK =================
function connectToTikTok(username, isReconnect = false) {
    let cleanUsername = username.toString().replace('@', '').trim();

    if (!isReconnect) {
        reconnectAttempts = 0;
        isManualDisconnect = false;
        clearTimeout(reconnectTimer);
        serverState.sessions.push({ username: cleanUsername, startedAt: new Date().toISOString(), endedAt: null });
        saveServerState();
    }

    if (currentConnection) {
        try {
            isManualDisconnect = true;
            currentConnection.disconnect();
        } catch (e) { console.log("Erreur fermeture:", e.message); }
        isManualDisconnect = false;
    }
    if (!isReconnect) isManualDisconnect = false;

    let options = {
        processInitialData: false,
        enableExtendedGiftInfo: false,
        enableWebsocketUpgrade: true,
        clientParams: {
            "display_language": "fr-FR", "device_platform": "web", "browser_name": "Mozilla",
            "browser_version": "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
    };

    currentConnection = new WebcastPushConnection(cleanUsername, options);
    currentUsername = cleanUsername;

    currentConnection.connect()
        .then(st => {
            reconnectAttempts = 0;
            console.log('✅ CONNECTÉ À @' + cleanUsername + ' (Room ID: ' + st.roomId + ')');
            sendToClient('INFO', 'TIKTOK_CONNECTED', { username: cleanUsername, reconnected: isReconnect });
        })
        .catch(err => {
            console.error('❌ ERREUR :', err.message);
            if (isReconnect) { attemptReconnect(); }
            else { sendToClient('ERROR', 'CONNECTION_FAILED', { error: "Erreur de connexion. Vérifie que le pseudo est bon et que le live est en cours !" }); }
        });

    currentConnection.on('gift', (data) => {
        if (data.giftType === 1 && !data.repeatEnd) return;
        if (processedEvents.has(data.msgId)) return;
        processedEvents.add(data.msgId);
        if (processedEvents.size > 500) { const it = processedEvents.values(); processedEvents.delete(it.next().value); }
        let totalCoins = data.diamondCount * data.repeatCount;
        if (totalCoins < 1) totalCoins = 1;
        const giftData = { user: data.uniqueId, profilePictureUrl: data.profilePictureUrl, count: totalCoins, giftName: data.giftName, diamondCount: totalCoins };
        sendToClient('ACTION', 'shoot_balloon', giftData);
        recordGift(giftData);
    });

    currentConnection.on('like', (data) => {
        let count = data.likeCount ? parseInt(data.likeCount) : 1;
        const likeData = { user: data.uniqueId, profilePictureUrl: data.profilePictureUrl, count: count };
        sendToClient('ACTION', 'like', likeData);
        recordLike(likeData);
    });

    currentConnection.on('chat', (data) => {
        const chatData = { user: data.uniqueId, profilePictureUrl: data.profilePictureUrl, comment: data.comment };
        sendToClient('ACTION', 'chat', chatData);
        recordChat(chatData);
    });

    currentConnection.on('streamEnd', () => {
        const lastSession = serverState.sessions[serverState.sessions.length - 1];
        if (lastSession) lastSession.endedAt = new Date().toISOString();
        saveServerState();
        sendToClient('INFO', 'STREAM_ENDED', {});
        attemptReconnect();
    });

    currentConnection.on('disconnected', () => { if (!isManualDisconnect) attemptReconnect(); });
    currentConnection.on('error', (err) => { console.error("⚠️ Erreur TikTok:", err.message); });
}

// ================= ROUTES API =================

// --- REDISTRIBUTION ---
app.post('/api/redistribute', (req, res) => {
    const { user, amount } = req.body;
    if (!user || !amount || amount <= 0) {
        return res.status(400).json({ success: false, message: 'Pseudo et montant requis' });
    }
    const uid = user.toString().replace('@', '').trim();
    if (!serverState.redistributionBoard[uid]) {
        const fromCoins = serverState.coinsBoard[uid];
        const fromLikes = serverState.likesBoard[uid];
        const pic = (fromCoins && fromCoins.profilePictureUrl) || (fromLikes && fromLikes.profilePictureUrl) || '';
        serverState.redistributionBoard[uid] = { user: uid, profilePictureUrl: pic, total: 0, history: [] };
    }
    serverState.redistributionBoard[uid].total += parseInt(amount);
    serverState.redistributionBoard[uid].history.push({ amount: parseInt(amount), date: new Date().toISOString() });
    serverState.totalRedistributed += parseInt(amount);
    saveServerState();

    sendToClient('INFO', 'REDISTRIBUTION_UPDATE', {
        redistributionBoard: serverState.redistributionBoard,
        totalRedistributed: serverState.totalRedistributed
    });

    console.log('💸 Redistribué ' + amount + ' pièces à @' + uid);
    res.json({ success: true, message: amount + ' pièces redistribuées à @' + uid });
});

// --- MARKETING ---
app.post('/api/marketing', (req, res) => {
    const { amount, comment, mktType } = req.body;
    const parsed = parseInt(amount);
    if (!parsed || parsed <= 0) {
        return res.status(400).json({ success: false, message: 'Montant invalide' });
    }
    const entry = {
        amount: parsed,
        comment: comment || '',
        mktType: mktType || 'Manuel',
        date: new Date().toISOString()
    };
    if (!serverState.marketingHistory) serverState.marketingHistory = [];
    serverState.marketingHistory.push(entry);
    serverState.totalMarketing = (serverState.totalMarketing || 0) + parsed;
    saveServerState();

    sendToClient('INFO', 'MARKETING_UPDATE', {
        marketingHistory: serverState.marketingHistory,
        totalMarketing: serverState.totalMarketing
    });

    console.log('📢 Marketing +' + parsed + ' pièces' + (comment ? ' (' + comment + ')' : ''));
    res.json({ success: true, message: parsed + ' pièces ajoutées au marketing' });
});

// --- RECOMPENSES HEBDOMADAIRES ---
app.post('/api/rewards', (req, res) => {
    const { amount, reason } = req.body;
    const parsed = parseInt(amount);
    if (!parsed || parsed <= 0) {
        return res.status(400).json({ success: false, message: 'Montant invalide' });
    }
    if (!reason || !reason.trim()) {
        return res.status(400).json({ success: false, message: 'Raison requise' });
    }
    const entry = {
        amount: parsed,
        reason: reason.trim(),
        date: new Date().toISOString()
    };
    if (!serverState.rewardsHistory) serverState.rewardsHistory = [];
    serverState.rewardsHistory.push(entry);
    serverState.totalRewards = (serverState.totalRewards || 0) + parsed;
    saveServerState();

    sendToClient('INFO', 'REWARDS_UPDATE', {
        rewardsHistory: serverState.rewardsHistory,
        totalRewards: serverState.totalRewards
    });

    console.log('🏆 Récompense +' + parsed + ' pièces (' + reason.trim() + ')');
    res.json({ success: true, message: parsed + ' pièces ajoutées aux récompenses' });
});

// --- RETRAITS ---
app.post('/api/withdrawals', (req, res) => {
    const { amount, reason } = req.body;
    const parsed = parseInt(amount);
    if (!parsed || parsed <= 0) {
        return res.status(400).json({ success: false, message: 'Montant invalide' });
    }
    if (!reason || !reason.trim()) {
        return res.status(400).json({ success: false, message: 'Raison requise' });
    }
    const entry = {
        amount: parsed,
        reason: reason.trim(),
        date: new Date().toISOString()
    };
    if (!serverState.withdrawalsHistory) serverState.withdrawalsHistory = [];
    serverState.withdrawalsHistory.push(entry);
    serverState.totalWithdrawals = (serverState.totalWithdrawals || 0) + parsed;
    saveServerState();

    sendToClient('INFO', 'WITHDRAWALS_UPDATE', {
        withdrawalsHistory: serverState.withdrawalsHistory,
        totalWithdrawals: serverState.totalWithdrawals
    });

    console.log('🏧 Retrait +' + parsed + ' pièces (' + reason.trim() + ')');
    res.json({ success: true, message: parsed + ' pièces ajoutées aux retraits' });
});

// --- EXPORTS ---
app.get('/api/export/all', (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="tiktok_live_export_' + Date.now() + '.json"');
    res.json({
        exportedAt: new Date().toISOString(),
        coinsBoard: serverState.coinsBoard, likesBoard: serverState.likesBoard,
        redistributionBoard: serverState.redistributionBoard,
        totalCoins: serverState.totalCoins, totalLikes: serverState.totalLikes,
        totalGifts: serverState.totalGifts, totalRedistributed: serverState.totalRedistributed,
        totalMarketing: serverState.totalMarketing, marketingHistory: serverState.marketingHistory,
        totalRewards: serverState.totalRewards, rewardsHistory: serverState.rewardsHistory,
        totalWithdrawals: serverState.totalWithdrawals, withdrawalsHistory: serverState.withdrawalsHistory,
        viewers: serverState.viewers, sessions: serverState.sessions, chatMessages: serverState.chatMessages
    });
});

app.get('/api/export/coins', (req, res) => {
    const sorted = Object.values(serverState.coinsBoard).sort((a, b) => b.total - a.total);
    res.json({ exportedAt: new Date().toISOString(), leaderboard: sorted });
});
app.get('/api/export/likes', (req, res) => {
    const sorted = Object.values(serverState.likesBoard).sort((a, b) => b.total - a.total);
    res.json({ exportedAt: new Date().toISOString(), leaderboard: sorted });
});

app.get('/api/export/coins/csv', (req, res) => {
    const sorted = Object.values(serverState.coinsBoard).sort((a, b) => b.total - a.total);
    let csv = 'Rang,Pseudo,Total_Pieces,Dollars,Cadeaux,Photo\n';
    sorted.forEach((e, i) => {
        const gs = Object.entries(e.gifts || {}).map(([n, c]) => n + 'x' + c).join(' | ');
        csv += (i+1) + ',"' + e.user + '",' + e.total + ',' + (e.total/250).toFixed(2) + ',"' + gs + '","' + (e.profilePictureUrl||'') + '"\n';
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="coins_' + Date.now() + '.csv"');
    res.send('\uFEFF' + csv);
});

app.get('/api/export/likes/csv', (req, res) => {
    const sorted = Object.values(serverState.likesBoard).sort((a, b) => b.total - a.total);
    let csv = 'Rang,Pseudo,Total_Likes,Photo\n';
    sorted.forEach((e, i) => { csv += (i+1) + ',"' + e.user + '",' + e.total + ',"' + (e.profilePictureUrl||'') + '"\n'; });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="likes_' + Date.now() + '.csv"');
    res.send('\uFEFF' + csv);
});

app.get('/api/export/redist/csv', (req, res) => {
    const sorted = Object.values(serverState.redistributionBoard).sort((a, b) => b.total - a.total);
    let csv = 'Rang,Pseudo,Total_Pieces,Dollars,Nb_Envois,Historique,Photo\n';
    sorted.forEach((e, i) => {
        const hist = (e.history || []).map(h => h.amount + ' (' + h.date + ')').join(' | ');
        csv += (i+1) + ',"' + (e.user||'').replace(/"/g,'""') + '",' + e.total + ',' + (e.total/100).toFixed(2) + ',' + (e.history||[]).length + ',"' + hist.replace(/"/g,'""') + '","' + (e.profilePictureUrl||'') + '"\n';
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="redistribution_' + Date.now() + '.csv"');
    res.send('\uFEFF' + csv);
});

app.get('/api/export/marketing/csv', (req, res) => {
    const hist = serverState.marketingHistory || [];
    let csv = 'Date,Type,Montant,Dollars,Commentaire\n';
    hist.forEach(h => {
        csv += '"' + h.date + '","' + (h.mktType||'Manuel') + '",' + h.amount + ',' + (h.amount/100).toFixed(2) + ',"' + (h.comment||'').replace(/"/g,'""') + '"\n';
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="marketing_' + Date.now() + '.csv"');
    res.send('\uFEFF' + csv);
});

app.get('/api/export/rewards/csv', (req, res) => {
    const hist = serverState.rewardsHistory || [];
    let csv = 'Date,Raison,Montant,Dollars\n';
    hist.forEach(h => {
        csv += '"' + h.date + '","' + (h.reason||'').replace(/"/g,'""') + '",' + h.amount + ',' + (h.amount/100).toFixed(2) + '\n';
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="recompenses_' + Date.now() + '.csv"');
    res.send('\uFEFF' + csv);
});

app.get('/api/export/withdrawals/csv', (req, res) => {
    const hist = serverState.withdrawalsHistory || [];
    let csv = 'Date,Raison,Montant,Dollars\n';
    hist.forEach(h => {
        csv += '"' + h.date + '","' + (h.reason||'').replace(/"/g,'""') + '",' + h.amount + ',' + (h.amount/100).toFixed(2) + '\n';
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="retraits_' + Date.now() + '.csv"');
    res.send('\uFEFF' + csv);
});

app.get('/api/export/balance/csv', (req, res) => {
    const users = {};
    Object.values(serverState.coinsBoard).forEach(e => {
        if (!users[e.user]) users[e.user] = { user: e.user, given: 0, received: 0 };
        users[e.user].given = e.total;
    });
    Object.values(serverState.redistributionBoard).forEach(e => {
        if (!users[e.user]) users[e.user] = { user: e.user, given: 0, received: 0 };
        users[e.user].received = e.total;
    });
    const sorted = Object.values(users).sort((a, b) => (b.given - b.received) - (a.given - a.received));
    let csv = 'Rang,Pseudo,Donne_Pieces,Recu_Pieces,Solde,Donne_Dollars,Recu_Dollars,Solde_Dollars,Statut\n';
    sorted.forEach((e, i) => {
        const net = e.given - e.received;
        const statut = net > 0 ? 'Te doit' : net < 0 ? 'Tu dois' : 'Equilibre';
        csv += (i+1) + ',"' + (e.user||'').replace(/"/g,'""') + '",' + e.given + ',' + e.received + ',' + net + ',' + (e.given/250).toFixed(2) + ',' + (e.received/100).toFixed(2) + ',' + (e.given/250 - e.received/100).toFixed(2) + ',"' + statut + '"\n';
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="balance_' + Date.now() + '.csv"');
    res.send('\uFEFF' + csv);
});

app.get('/api/export/chat/csv', (req, res) => {
    let csv = 'Date,Pseudo,Message\n';
    serverState.chatMessages.forEach(m => { csv += '"' + m.time + '","' + m.user + '","' + (m.comment||'').replace(/"/g,'""') + '"\n'; });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="chat_' + Date.now() + '.csv"');
    res.send('\uFEFF' + csv);
});

app.post('/api/reset', (req, res) => {
    serverState = {
        coinsBoard: {}, likesBoard: {}, redistributionBoard: {}, marketingHistory: [], rewardsHistory: [], withdrawalsHistory: [], chatMessages: [],
        totalCoins: 0, totalLikes: 0, totalGifts: 0, totalRedistributed: 0, totalMarketing: 0, totalRewards: 0, totalWithdrawals: 0, viewers: [],
        sessions: serverState.sessions, lastUpdated: new Date().toISOString()
    };
    saveServerState();
    sendToClient('INFO', 'DATA_RESET', {});
    res.json({ success: true, message: 'Données réinitialisées' });
});

// --- IMPORT SAUVEGARDE ---
app.post('/api/import', (req, res) => {
    try {
        const data = req.body;
        if (!data || typeof data !== 'object') {
            return res.status(400).json({ success: false, message: 'Fichier JSON invalide' });
        }
        if (data.coinsBoard) serverState.coinsBoard = data.coinsBoard;
        if (data.likesBoard) serverState.likesBoard = data.likesBoard;
        if (data.redistributionBoard) serverState.redistributionBoard = data.redistributionBoard;
        if (data.marketingHistory) serverState.marketingHistory = data.marketingHistory;
        if (data.rewardsHistory) serverState.rewardsHistory = data.rewardsHistory;
        if (data.withdrawalsHistory) serverState.withdrawalsHistory = data.withdrawalsHistory;
        if (data.chatMessages) serverState.chatMessages = data.chatMessages;
        if (typeof data.totalCoins === 'number') serverState.totalCoins = data.totalCoins;
        if (typeof data.totalLikes === 'number') serverState.totalLikes = data.totalLikes;
        if (typeof data.totalGifts === 'number') serverState.totalGifts = data.totalGifts;
        if (typeof data.totalRedistributed === 'number') serverState.totalRedistributed = data.totalRedistributed;
        if (typeof data.totalMarketing === 'number') serverState.totalMarketing = data.totalMarketing;
        if (typeof data.totalRewards === 'number') serverState.totalRewards = data.totalRewards;
        if (typeof data.totalWithdrawals === 'number') serverState.totalWithdrawals = data.totalWithdrawals;
        if (data.viewers) serverState.viewers = data.viewers;
        if (data.sessions) serverState.sessions = data.sessions;
        saveServerState();

        // Envoyer l'état complet à tous les clients connectés
        const restorePayload = JSON.stringify({
            type: 'RESTORE',
            data: {
                coinsBoard: serverState.coinsBoard,
                likesBoard: serverState.likesBoard,
                redistributionBoard: serverState.redistributionBoard,
                totalCoins: serverState.totalCoins,
                totalLikes: serverState.totalLikes,
                totalGifts: serverState.totalGifts,
                totalRedistributed: serverState.totalRedistributed,
                totalMarketing: serverState.totalMarketing,
                totalRewards: serverState.totalRewards,
                totalWithdrawals: serverState.totalWithdrawals,
                marketingHistory: serverState.marketingHistory || [],
                rewardsHistory: serverState.rewardsHistory || [],
                withdrawalsHistory: serverState.withdrawalsHistory || [],
                viewers: serverState.viewers,
                chatMessages: serverState.chatMessages.slice(-200),
                currentUsername: currentUsername || null
            }
        });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) client.send(restorePayload);
        });

        console.log('📥 Sauvegarde importée (' + Object.keys(serverState.coinsBoard).length + ' donateurs)');
        res.json({ success: true, message: 'Sauvegarde importée' });
    } catch (e) {
        console.warn('⚠️ Erreur import:', e.message);
        res.status(500).json({ success: false, message: 'Erreur import: ' + e.message });
    }
});

// ================= INTERFACE WEB =================
app.get('/', (req, res) => { res.send(DASHBOARD_HTML); });

app.get('/connect', (req, res) => {
    const username = req.query.username;
    if (username) { connectToTikTok(username); res.json({ success: true, message: 'Connexion lancée vers @' + username }); }
    else { res.status(400).json({ success: false, message: "Pseudo manquant." }); }
});

// ================= DASHBOARD HTML =================
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TikTok Live Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg-deep:#0a0a0f;--bg-card:#12121a;--bg-card-hover:#1a1a26;--border:#1e1e2e;--pk:#fe2c55;--cy:#25f4ee;--pk-glow:rgba(254,44,85,0.25);--cy-glow:rgba(37,244,238,0.2);--txt:#f0f0f5;--txt2:#6e6e80;--txt3:#3a3a4a;--gold:#ffd700;--silver:#c0c0c0;--bronze:#cd7f32;--green:#22c55e;--reward:#eab308}
body{background:var(--bg-deep);color:var(--txt);font-family:'Outfit',sans-serif;min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;top:-50%;left:-50%;width:200%;height:200%;background:radial-gradient(ellipse at 20% 50%,rgba(254,44,85,0.06) 0%,transparent 50%),radial-gradient(ellipse at 80% 20%,rgba(37,244,238,0.04) 0%,transparent 50%);animation:bg 20s ease-in-out infinite alternate;z-index:0;pointer-events:none}
@keyframes bg{0%{transform:translate(0,0)}100%{transform:translate(-3%,-3%) rotate(2deg)}}

.topbar{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:14px 28px;background:rgba(10,10,15,0.85);backdrop-filter:blur(20px);border-bottom:1px solid var(--border)}
.topbar-logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px}
.topbar-logo .dot{width:10px;height:10px;border-radius:50%;background:var(--pk);box-shadow:0 0 12px var(--pk-glow);animation:pulse 2s ease-in-out infinite}
.topbar-logo .dot.on{background:var(--cy);box-shadow:0 0 12px var(--cy-glow)}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(.85)}}
.topbar-logo .pk{color:var(--pk)}.topbar-logo .cy{color:var(--cy)}
.cz{display:flex;align-items:center;gap:10px}
.cz input{padding:10px 16px;border-radius:10px;border:1px solid var(--border);background:var(--bg-card);color:var(--txt);font-family:'JetBrains Mono',monospace;font-size:13px;width:200px;outline:none;transition:.3s}
.cz input:focus{border-color:var(--pk);box-shadow:0 0 0 3px var(--pk-glow)}
.cz input::placeholder{color:var(--txt3)}
.btn-co{padding:10px 22px;border:none;border-radius:10px;font-family:'Outfit',sans-serif;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.8px;cursor:pointer;transition:.3s;background:linear-gradient(135deg,var(--pk),#d6164a);color:#fff;box-shadow:0 4px 20px var(--pk-glow)}
.btn-co:hover{transform:translateY(-1px)}.btn-co:disabled{opacity:.5;cursor:not-allowed;transform:none}
.badge{display:flex;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;font-size:12px;font-weight:500;background:rgba(254,44,85,.1);color:var(--pk);border:1px solid rgba(254,44,85,.2);white-space:nowrap;transition:.4s}
.badge.live{background:rgba(37,244,238,.1);color:var(--cy);border-color:rgba(37,244,238,.25);animation:glow 3s ease-in-out infinite}
.badge.reco{background:rgba(255,165,0,.1);color:#ffa500;border-color:rgba(255,165,0,.25);animation:pulse 1s ease-in-out infinite}
@keyframes glow{0%,100%{box-shadow:0 0 8px rgba(37,244,238,.1)}50%{box-shadow:0 0 16px rgba(37,244,238,.25)}}

.stats-bar{display:flex;gap:16px;padding:20px 28px;overflow-x:auto;flex-wrap:wrap}
.sc{flex:1;min-width:120px;padding:16px 18px;background:var(--bg-card);border:1px solid var(--border);border-radius:14px;display:flex;flex-direction:column;gap:4px;transition:.3s}
.sc:hover{border-color:rgba(254,44,85,.3)}
.sc-label{font-size:10px;text-transform:uppercase;letter-spacing:1.2px;color:var(--txt2);font-weight:600}
.sc-val{font-size:26px;font-weight:800;font-family:'JetBrains Mono',monospace;letter-spacing:-1px}
.sc-sub{font-size:12px;color:var(--green);font-weight:600;font-family:'JetBrains Mono',monospace}
.sc-val.coins{color:var(--gold)}.sc-val.likes{color:var(--pk)}.sc-val.viewers{color:var(--cy)}.sc-val.gifts{color:#c084fc}.sc-val.redist{color:var(--green)}.sc-val.marketing{color:#f97316}.sc-val.rewards{color:var(--reward)}.sc-val.withdrawals{color:#ef4444}.sc-val.earned{color:#06b6d4}

.ebar{display:flex;align-items:center;justify-content:flex-end;padding:0 28px 8px;gap:8px;flex-wrap:wrap}
.btn-eg{padding:8px 16px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.03);color:var(--txt2);font-family:'Outfit',sans-serif;font-size:12px;font-weight:600;cursor:pointer;transition:.2s;display:flex;align-items:center;gap:6px}
.btn-eg:hover{background:rgba(37,244,238,.08);color:var(--cy);border-color:rgba(37,244,238,.25)}
.btn-rst{padding:8px 16px;border:1px solid rgba(254,44,85,.2);border-radius:10px;background:rgba(254,44,85,.05);color:rgba(254,44,85,.6);font-family:'Outfit',sans-serif;font-size:12px;font-weight:600;cursor:pointer;transition:.2s}
.btn-rst:hover{background:rgba(254,44,85,.12);color:var(--pk)}

.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:0 28px 28px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
@media(max-width:700px){.topbar{flex-wrap:wrap;gap:12px}.cz{width:100%;justify-content:flex-end}.cz input{flex:1}}

.panel{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;display:flex;flex-direction:column;max-height:550px;overflow:hidden}
.ph{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 12px;border-bottom:1px solid var(--border);flex-shrink:0}
.pt{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px}
.pa{display:flex;align-items:center;gap:8px}
.pc{font-family:'JetBrains Mono',monospace;font-size:11px;padding:3px 8px;border-radius:6px;background:rgba(255,255,255,.05);color:var(--txt2)}

.btn-ex{padding:5px 10px;border:1px solid var(--border);border-radius:8px;background:rgba(255,255,255,.03);color:var(--txt2);font-family:'Outfit',sans-serif;font-size:11px;font-weight:600;cursor:pointer;transition:.2s;display:flex;align-items:center;gap:4px}
.btn-ex:hover{background:rgba(255,255,255,.08);color:var(--txt)}
.exdd{position:relative;display:inline-block}
.exm{display:none;position:absolute;right:0;top:110%;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:4px;min-width:130px;box-shadow:0 8px 24px rgba(0,0,0,.4);z-index:50}
.exm.open{display:block}
.exm a{display:block;padding:8px 12px;border-radius:7px;color:var(--txt);text-decoration:none;font-size:12px;font-weight:500;transition:.15s}
.exm a:hover{background:var(--bg-card-hover)}

.sb{padding:12px 16px;flex-shrink:0}
.si{width:100%;padding:10px 14px 10px 36px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--txt);font-family:'Outfit',sans-serif;font-size:13px;outline:none;transition:.3s;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='%236e6e80' viewBox='0 0 16 16'%3E%3Cpath d='M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:12px center}
.si:focus{border-color:rgba(255,255,255,.15);box-shadow:0 0 0 3px rgba(255,255,255,.04)}
.si::placeholder{color:var(--txt3)}

.ll{flex:1;overflow-y:auto;padding:4px 8px 12px}
.ll::-webkit-scrollbar{width:4px}.ll::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
.lr{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;transition:.2s}
.lr:hover{background:var(--bg-card-hover)}
.lrk{width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;font-family:'JetBrains Mono',monospace;border-radius:8px;background:rgba(255,255,255,.04);color:var(--txt2);flex-shrink:0}
.lrk.g{background:rgba(255,215,0,.15);color:var(--gold)}.lrk.s{background:rgba(192,192,192,.12);color:var(--silver)}.lrk.b{background:rgba(205,127,50,.12);color:var(--bronze)}
.lav{width:38px;height:38px;border-radius:50%;object-fit:cover;border:2px solid var(--border);flex-shrink:0;background:var(--bg-card-hover)}
.lr:nth-child(1) .lav{border-color:var(--gold)}.lr:nth-child(2) .lav{border-color:var(--silver)}.lr:nth-child(3) .lav{border-color:var(--bronze)}
.li{flex:1;min-width:0}.ln{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ls{font-size:11px;color:var(--txt2);margin-top:1px}
.lv{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:14px;flex-shrink:0;text-align:right}
.lv .main{display:flex;align-items:center;gap:4px}
.lv .dollar{font-size:11px;color:var(--green);font-weight:600;margin-top:1px}
.lv.coins .main{color:var(--gold)}.lv.likes .main{color:var(--pk)}.lv.redist .main{color:var(--green)}

.cl{flex:1;overflow-y:auto;padding:8px 12px}
.cl::-webkit-scrollbar{width:4px}.cl::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
.cm{display:flex;gap:10px;padding:8px 10px;border-radius:10px;animation:mi .3s ease-out}
@keyframes mi{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.cm:hover{background:var(--bg-card-hover)}
.ca{width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0;background:var(--bg-card-hover)}
.cc{flex:1;min-width:0}.cu{font-weight:600;font-size:13px;color:var(--cy)}.ct{font-size:13px;opacity:.85;margin-top:2px;word-break:break-word}.ctm{font-size:10px;color:var(--txt3);margin-top:3px}

.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;color:var(--txt3);text-align:center;gap:8px;flex:1}
.empty .ei{font-size:32px;opacity:.5}.empty .et{font-size:13px}

.toast{position:fixed;bottom:20px;right:20px;padding:10px 18px;border-radius:10px;font-size:12px;font-weight:500;opacity:0;transform:translateY(10px);transition:.3s;pointer-events:none;z-index:200}
.toast.show{opacity:1;transform:translateY(0)}
.toast.success{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);color:var(--green)}
.toast.error{background:rgba(254,44,85,.1);border:1px solid rgba(254,44,85,.2);color:var(--pk)}
.toast.reconnect{background:rgba(255,165,0,.1);border:1px solid rgba(255,165,0,.25);color:#ffa500}

/* REDISTRIBUTION FORM */
.redist-form{padding:12px 16px;border-bottom:1px solid var(--border);flex-shrink:0}
.rf-search-wrap{position:relative;margin-bottom:10px}
.rf-results{position:absolute;top:100%;left:0;right:0;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;max-height:200px;overflow-y:auto;z-index:30;display:none;box-shadow:0 8px 24px rgba(0,0,0,.5)}
.rf-results.open{display:block}
.rf-item{display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;transition:.15s}
.rf-item:hover{background:var(--bg-card-hover)}
.rf-item img{width:28px;height:28px;border-radius:50%;object-fit:cover}
.rf-item span{font-size:13px;font-weight:500}
.rf-selected{display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(37,244,238,.05);border:1px solid rgba(37,244,238,.15);border-radius:10px;margin-bottom:10px}
.rf-selected img{width:32px;height:32px;border-radius:50%;object-fit:cover}
.rf-selected .name{font-weight:600;font-size:14px;flex:1}
.rf-selected .rf-clear{background:none;border:none;color:var(--pk);cursor:pointer;font-size:16px;padding:4px 8px}
.rf-row{display:flex;gap:8px}
.rf-row input{flex:1;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--txt);font-family:'JetBrains Mono',monospace;font-size:13px;outline:none}
.rf-row input:focus{border-color:var(--green);box-shadow:0 0 0 3px rgba(34,197,94,.15)}
.rf-row input::placeholder{color:var(--txt3)}
.btn-send{padding:10px 18px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--green),#16a34a);color:#fff;font-family:'Outfit',sans-serif;font-weight:700;font-size:13px;cursor:pointer;transition:.3s;white-space:nowrap}
.btn-send:hover{transform:translateY(-1px);box-shadow:0 4px 16px rgba(34,197,94,.3)}
.btn-send:disabled{opacity:.5;cursor:not-allowed;transform:none}

/* BALANCE */
.bal-row{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;transition:.2s}
.bal-row:hover{background:var(--bg-card-hover)}
.bal-vals{flex-shrink:0;text-align:right;font-family:'JetBrains Mono',monospace}
.bal-given{font-size:12px;color:var(--gold)}
.bal-received{font-size:12px;color:var(--green)}
.bal-net{font-size:14px;font-weight:700;margin-top:2px}
.bal-net.positive{color:var(--pk)}
.bal-net.negative{color:var(--green)}
.bal-net.neutral{color:var(--txt2)}
.bal-tag{display:inline-block;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;padding:2px 6px;border-radius:4px;margin-left:6px}
.bal-tag.owes{background:rgba(254,44,85,.12);color:var(--pk)}
.bal-tag.owed{background:rgba(34,197,94,.12);color:var(--green)}
.bal-tag.even{background:rgba(255,255,255,.05);color:var(--txt2)}

/* MARKETING FORM */
.mkt-form{padding:12px 16px;border-bottom:1px solid var(--border);flex-shrink:0;display:flex;flex-direction:column;gap:8px}
.mkt-row{display:flex;gap:8px}
.mkt-input{flex:1;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--txt);font-family:'JetBrains Mono',monospace;font-size:13px;outline:none;transition:.3s}
.mkt-input:focus{border-color:#f97316;box-shadow:0 0 0 3px rgba(249,115,22,.15)}
.mkt-input::placeholder{color:var(--txt3)}
.mkt-input-text{flex:1;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--txt);font-family:'Outfit',sans-serif;font-size:13px;outline:none;transition:.3s}
.mkt-input-text:focus{border-color:#f97316;box-shadow:0 0 0 3px rgba(249,115,22,.15)}
.mkt-input-text::placeholder{color:var(--txt3)}
.btn-mkt{padding:10px 18px;border:none;border-radius:10px;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;font-family:'Outfit',sans-serif;font-weight:700;font-size:13px;cursor:pointer;transition:.3s;white-space:nowrap}
.btn-mkt:hover{transform:translateY(-1px);box-shadow:0 4px 16px rgba(249,115,22,.3)}
.btn-mkt:disabled{opacity:.5;cursor:not-allowed;transform:none}
.mkt-entry{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;transition:.2s}
.mkt-entry:hover{background:var(--bg-card-hover)}
.mkt-icon{width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:10px;background:rgba(249,115,22,.1);font-size:16px;flex-shrink:0}
.mkt-info{flex:1;min-width:0}
.mkt-amount{font-weight:700;font-size:14px;color:#f97316;font-family:'JetBrains Mono',monospace}
.mkt-comment{font-size:12px;color:var(--txt2);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mkt-date{font-size:11px;color:var(--txt3);margin-top:1px}
.mkt-val{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:13px;flex-shrink:0;color:var(--green)}

/* MARKETING QUICK BUTTONS */
.mkt-section-label{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--txt2);font-weight:600;margin-bottom:6px}
.mkt-quick-row{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.mkt-qbtn{display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 8px;border:1px solid var(--border);border-radius:12px;background:rgba(255,255,255,.02);cursor:pointer;transition:all .25s ease;flex:1;min-width:52px;max-width:80px}
.mkt-qbtn:hover{transform:translateY(-3px)}
.mkt-qbtn:active{transform:scale(.92)}
.mkt-qbtn.coffre:hover{background:rgba(180,83,9,.15);border-color:rgba(217,119,6,.4);box-shadow:0 4px 20px rgba(217,119,6,.2)}
.mkt-qbtn.sac:hover{background:rgba(124,58,237,.15);border-color:rgba(139,92,246,.4);box-shadow:0 4px 20px rgba(139,92,246,.2)}
.mkt-qbtn.sending{opacity:.5;pointer-events:none;animation:mktPulse .6s ease}
@keyframes mktPulse{0%{transform:scale(1)}50%{transform:scale(.85)}100%{transform:scale(1)}}
.mkt-icon-svg{width:28px;height:28px}
.mkt-qval{font-family:'JetBrains Mono',monospace;font-weight:800;font-size:13px;color:var(--txt)}
.mkt-qbtn.coffre .mkt-qval{color:#fbbf24}
.mkt-qbtn.sac .mkt-qval{color:#a78bfa}
.mkt-divider{height:1px;background:var(--border);margin:4px 0 10px}
.mkt-entry-type{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:2px 6px;border-radius:4px;margin-right:6px}
.mkt-entry-type.coffre{background:rgba(217,119,6,.15);color:#fbbf24}
.mkt-entry-type.sac{background:rgba(124,58,237,.15);color:#a78bfa}
.mkt-entry-type.manuel{background:rgba(249,115,22,.15);color:#f97316}

/* REWARDS FORM */
.rwd-form{padding:12px 16px;border-bottom:1px solid var(--border);flex-shrink:0;display:flex;flex-direction:column;gap:8px}
.rwd-row{display:flex;gap:8px}
.rwd-input{flex:1;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--txt);font-family:'JetBrains Mono',monospace;font-size:13px;outline:none;transition:.3s}
.rwd-input:focus{border-color:var(--reward);box-shadow:0 0 0 3px rgba(234,179,8,.15)}
.rwd-input::placeholder{color:var(--txt3)}
.rwd-input-text{flex:1;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--txt);font-family:'Outfit',sans-serif;font-size:13px;outline:none;transition:.3s}
.rwd-input-text:focus{border-color:var(--reward);box-shadow:0 0 0 3px rgba(234,179,8,.15)}
.rwd-input-text::placeholder{color:var(--txt3)}
.btn-rwd{padding:10px 18px;border:none;border-radius:10px;background:linear-gradient(135deg,#eab308,#ca8a04);color:#fff;font-family:'Outfit',sans-serif;font-weight:700;font-size:13px;cursor:pointer;transition:.3s;white-space:nowrap}
.btn-rwd:hover{transform:translateY(-1px);box-shadow:0 4px 16px rgba(234,179,8,.3)}
.btn-rwd:disabled{opacity:.5;cursor:not-allowed;transform:none}
.rwd-entry{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;transition:.2s}
.rwd-entry:hover{background:var(--bg-card-hover)}
.rwd-icon{width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:10px;background:rgba(234,179,8,.1);font-size:16px;flex-shrink:0}
.rwd-info{flex:1;min-width:0}
.rwd-amount{font-weight:700;font-size:14px;color:var(--reward);font-family:'JetBrains Mono',monospace}
.rwd-reason{font-size:12px;color:var(--txt2);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rwd-date{font-size:11px;color:var(--txt3);margin-top:1px}
.rwd-val{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:13px;flex-shrink:0;color:var(--green)}

/* WITHDRAWALS FORM */
.wdr-form{padding:12px 16px;border-bottom:1px solid var(--border);flex-shrink:0;display:flex;flex-direction:column;gap:8px}
.wdr-row{display:flex;gap:8px}
.wdr-input{flex:1;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--txt);font-family:'JetBrains Mono',monospace;font-size:13px;outline:none;transition:.3s}
.wdr-input:focus{border-color:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.15)}
.wdr-input::placeholder{color:var(--txt3)}
.wdr-input-text{flex:1;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--txt);font-family:'Outfit',sans-serif;font-size:13px;outline:none;transition:.3s}
.wdr-input-text:focus{border-color:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.15)}
.wdr-input-text::placeholder{color:var(--txt3)}
.btn-wdr{padding:10px 18px;border:none;border-radius:10px;background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;font-family:'Outfit',sans-serif;font-weight:700;font-size:13px;cursor:pointer;transition:.3s;white-space:nowrap}
.btn-wdr:hover{transform:translateY(-1px);box-shadow:0 4px 16px rgba(239,68,68,.3)}
.btn-wdr:disabled{opacity:.5;cursor:not-allowed;transform:none}
.wdr-entry{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;transition:.2s}
.wdr-entry:hover{background:var(--bg-card-hover)}
.wdr-icon{width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:10px;background:rgba(239,68,68,.1);font-size:16px;flex-shrink:0}
.wdr-info{flex:1;min-width:0}
.wdr-amount{font-weight:700;font-size:14px;color:#ef4444;font-family:'JetBrains Mono',monospace}
.wdr-reason{font-size:12px;color:var(--txt2);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wdr-date{font-size:11px;color:var(--txt3);margin-top:1px}
.wdr-val{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:13px;flex-shrink:0;color:var(--green)}
</style>
</head>
<body>
<div class="topbar">
    <div class="topbar-logo"><div class="dot" id="dot"></div><span>Tik<span class="pk">Tok</span> <span class="cy">Live</span></span></div>
    <div class="cz">
        <div class="badge" id="badge"><span id="stxt">Déconnecté</span></div>
        <input type="text" id="username" placeholder="@pseudo_en_live" spellcheck="false"/>
        <button class="btn-co" id="btnCo" onclick="doConnect()">Connexion</button>
    </div>
</div>

<div class="stats-bar">
    <div class="sc"><div class="sc-label">Total Pièces</div><div class="sc-val coins" id="sCoins">0</div><div class="sc-sub" id="sCoinsDol">= $0.00</div></div>
    <div class="sc"><div class="sc-label">Redistribué</div><div class="sc-val redist" id="sRedist">0</div><div class="sc-sub" id="sRedistDol">= $0.00</div></div>
    <div class="sc"><div class="sc-label">Marketing</div><div class="sc-val marketing" id="sMarketing">0</div><div class="sc-sub" id="sMarketingDol">= $0.00</div></div>
    <div class="sc"><div class="sc-label">Récompenses Hebdo</div><div class="sc-val rewards" id="sRewards">0</div><div class="sc-sub" id="sRewardsDol">= $0.00</div></div>
    <div class="sc"><div class="sc-label">Retraits</div><div class="sc-val withdrawals" id="sWithdrawals">0</div><div class="sc-sub" id="sWithdrawalsDol">= $0.00</div></div>
    <div class="sc" style="border:1px solid rgba(37,244,238,.25)"><div class="sc-label">Total Gagné</div><div class="sc-val earned" id="sEarned">0</div><div class="sc-sub" id="sEarnedDol">= $0.00</div></div>
    <div class="sc"><div class="sc-label">Total Likes</div><div class="sc-val likes" id="sLikes">0</div></div>
    <div class="sc"><div class="sc-label">Viewers uniques</div><div class="sc-val viewers" id="sViewers">0</div></div>
    <div class="sc"><div class="sc-label">Cadeaux envoyés</div><div class="sc-val gifts" id="sGifts">0</div></div>
</div>

<div class="ebar">
    <button class="btn-eg" onclick="window.open('/api/export/all')">📦 Export Tout</button>
    <button class="btn-eg" onclick="document.getElementById('importFileInput').click()">📥 Import Sauvegarde</button>
    <input type="file" id="importFileInput" accept=".json" style="display:none" onchange="importSave(event)">
    <button class="btn-eg" onclick="window.open('/api/export/chat/csv')">💬 Export Chat</button>
    <button class="btn-rst" onclick="resetData()">🗑 Réinitialiser</button>
</div>

<div class="grid">
    <!-- COINS -->
    <div class="panel">
        <div class="ph">
            <div class="pt">💰 Classement Pièces</div>
            <div class="pa"><div class="pc" id="cCoins">0</div>
                <div class="exdd"><button class="btn-ex" onclick="togEx('coins')">⬇ Export</button>
                    <div class="exm" id="exCoins"><a href="/api/export/coins" target="_blank">📋 JSON</a><a href="/api/export/coins/csv" target="_blank">📊 CSV</a></div>
                </div>
            </div>
        </div>
        <div class="sb"><input class="si" type="text" placeholder="Rechercher..." oninput="filterLB('coins',this.value)"/></div>
        <div class="ll" id="lbCoins"><div class="empty"><div class="ei">🎁</div><div class="et">En attente de cadeaux...</div></div></div>
    </div>

    <!-- LIKES -->
    <div class="panel">
        <div class="ph">
            <div class="pt">❤️ Classement Likes</div>
            <div class="pa"><div class="pc" id="cLikes">0</div>
                <div class="exdd"><button class="btn-ex" onclick="togEx('likes')">⬇ Export</button>
                    <div class="exm" id="exLikes"><a href="/api/export/likes" target="_blank">📋 JSON</a><a href="/api/export/likes/csv" target="_blank">📊 CSV</a></div>
                </div>
            </div>
        </div>
        <div class="sb"><input class="si" type="text" placeholder="Rechercher..." oninput="filterLB('likes',this.value)"/></div>
        <div class="ll" id="lbLikes"><div class="empty"><div class="ei">❤️</div><div class="et">En attente de likes...</div></div></div>
    </div>

    <!-- REDISTRIBUTION -->
    <div class="panel">
        <div class="ph">
            <div class="pt">💸 Redistribution</div>
            <div class="pa"><div class="pc" id="cRedist">0</div>
                <div class="exdd"><button class="btn-ex" onclick="togEx('redist')">⬇ Export</button>
                    <div class="exm" id="exRedist"><a href="/api/export/redist/csv" target="_blank">📊 CSV</a></div>
                </div>
            </div>
        </div>
        <div class="redist-form">
            <div class="rf-search-wrap">
                <input class="si" type="text" id="rfSearch" placeholder="Chercher un viewer..." oninput="searchViewers(this.value)" autocomplete="off"/>
                <div class="rf-results" id="rfResults"></div>
            </div>
            <div id="rfSelected" style="display:none" class="rf-selected">
                <img id="rfSelPic" src="" onerror="this.style.display='none'"/>
                <span class="name" id="rfSelName"></span>
                <button class="rf-clear" onclick="clearSelection()">✕</button>
            </div>
            <div class="rf-row">
                <input type="number" id="rfAmount" placeholder="Nb de pièces" min="1"/>
                <button class="btn-send" id="rfBtn" onclick="sendRedist()">Envoyer</button>
            </div>
        </div>
        <div class="sb"><input class="si" type="text" placeholder="Rechercher..." oninput="filterLB('redist',this.value)"/></div>
        <div class="ll" id="lbRedist"><div class="empty"><div class="ei">💸</div><div class="et">Aucune redistribution</div></div></div>
    </div>

    <!-- BALANCE DONS vs REDISTRIBUTION -->
    <div class="panel">
        <div class="ph">
            <div class="pt">⚖️ Balance Dons vs Redistribué</div>
            <div class="pa"><div class="pc" id="cBalance">0</div>
                <div class="exdd"><button class="btn-ex" onclick="togEx('balance')">⬇ Export</button>
                    <div class="exm" id="exBalance"><a href="/api/export/balance/csv" target="_blank">📊 CSV</a></div>
                </div>
            </div>
        </div>
        <div class="sb"><input class="si" type="text" placeholder="Rechercher..." oninput="filterLB('balance',this.value)"/></div>
        <div class="ll" id="lbBalance"><div class="empty"><div class="ei">⚖️</div><div class="et">En attente de données...</div></div></div>
    </div>

    <!-- CHAT -->
    <div class="panel">
        <div class="ph">
            <div class="pt">💬 Chat en direct</div>
            <div class="pc" id="cChat">0</div>
        </div>
        <div class="cl" id="chatList"><div class="empty"><div class="ei">💬</div><div class="et">En attente de messages...</div></div></div>
    </div>

    <!-- MARKETING -->
    <div class="panel">
        <div class="ph">
            <div class="pt">📢 Marketing</div>
            <div class="pa"><div class="pc" id="cMarketing">0 entrées</div>
                <div class="exdd"><button class="btn-ex" onclick="togEx('marketing')">⬇ Export</button>
                    <div class="exm" id="exMarketing"><a href="/api/export/marketing/csv" target="_blank">📊 CSV</a></div>
                </div>
            </div>
        </div>
        <div class="mkt-form">
            <div class="mkt-section-label">🧰 Coffre</div>
            <div class="mkt-quick-row">
                <button class="mkt-qbtn coffre" onclick="quickMkt('Coffre',20)"><svg class="mkt-icon-svg" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="13" rx="2" fill="#b45309" stroke="#92400e" stroke-width="1.2"/><rect x="2" y="7" width="20" height="5" rx="1" fill="#d97706"/><rect x="10" y="10" width="4" height="4" rx="1" fill="#fbbf24" stroke="#92400e" stroke-width="0.8"/><path d="M5 7V5a7 7 0 0 1 14 0v2" fill="none" stroke="#92400e" stroke-width="1.2"/></svg><span class="mkt-qval">20</span></button>
                <button class="mkt-qbtn coffre" onclick="quickMkt('Coffre',50)"><svg class="mkt-icon-svg" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="13" rx="2" fill="#b45309" stroke="#92400e" stroke-width="1.2"/><rect x="2" y="7" width="20" height="5" rx="1" fill="#d97706"/><rect x="10" y="10" width="4" height="4" rx="1" fill="#fbbf24" stroke="#92400e" stroke-width="0.8"/><path d="M5 7V5a7 7 0 0 1 14 0v2" fill="none" stroke="#92400e" stroke-width="1.2"/></svg><span class="mkt-qval">50</span></button>
                <button class="mkt-qbtn coffre" onclick="quickMkt('Coffre',100)"><svg class="mkt-icon-svg" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="13" rx="2" fill="#b45309" stroke="#92400e" stroke-width="1.2"/><rect x="2" y="7" width="20" height="5" rx="1" fill="#d97706"/><rect x="10" y="10" width="4" height="4" rx="1" fill="#fbbf24" stroke="#92400e" stroke-width="0.8"/><path d="M5 7V5a7 7 0 0 1 14 0v2" fill="none" stroke="#92400e" stroke-width="1.2"/></svg><span class="mkt-qval">100</span></button>
                <button class="mkt-qbtn coffre" onclick="quickMkt('Coffre',200)"><svg class="mkt-icon-svg" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="13" rx="2" fill="#b45309" stroke="#92400e" stroke-width="1.2"/><rect x="2" y="7" width="20" height="5" rx="1" fill="#d97706"/><rect x="10" y="10" width="4" height="4" rx="1" fill="#fbbf24" stroke="#92400e" stroke-width="0.8"/><path d="M5 7V5a7 7 0 0 1 14 0v2" fill="none" stroke="#92400e" stroke-width="1.2"/></svg><span class="mkt-qval">200</span></button>
                <button class="mkt-qbtn coffre" onclick="quickMkt('Coffre',1000)"><svg class="mkt-icon-svg" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="13" rx="2" fill="#b45309" stroke="#92400e" stroke-width="1.2"/><rect x="2" y="7" width="20" height="5" rx="1" fill="#d97706"/><rect x="10" y="10" width="4" height="4" rx="1" fill="#fbbf24" stroke="#92400e" stroke-width="0.8"/><path d="M5 7V5a7 7 0 0 1 14 0v2" fill="none" stroke="#92400e" stroke-width="1.2"/></svg><span class="mkt-qval">1K</span></button>
            </div>
            <div class="mkt-section-label">🎒 Sac à dos</div>
            <div class="mkt-quick-row">
                <button class="mkt-qbtn sac" onclick="quickMkt('Sac à dos',5)"><svg class="mkt-icon-svg" viewBox="0 0 24 24"><rect x="5" y="6" width="14" height="16" rx="3" fill="#7c3aed" stroke="#6d28d9" stroke-width="1.2"/><rect x="5" y="6" width="14" height="5" rx="2" fill="#8b5cf6"/><rect x="8" y="14" width="8" height="4" rx="1.5" fill="#a78bfa" stroke="#6d28d9" stroke-width="0.6"/><path d="M8 6V4a4 4 0 0 1 8 0v2" fill="none" stroke="#6d28d9" stroke-width="1.4"/></svg><span class="mkt-qval">5</span></button>
                <button class="mkt-qbtn sac" onclick="quickMkt('Sac à dos',10)"><svg class="mkt-icon-svg" viewBox="0 0 24 24"><rect x="5" y="6" width="14" height="16" rx="3" fill="#7c3aed" stroke="#6d28d9" stroke-width="1.2"/><rect x="5" y="6" width="14" height="5" rx="2" fill="#8b5cf6"/><rect x="8" y="14" width="8" height="4" rx="1.5" fill="#a78bfa" stroke="#6d28d9" stroke-width="0.6"/><path d="M8 6V4a4 4 0 0 1 8 0v2" fill="none" stroke="#6d28d9" stroke-width="1.4"/></svg><span class="mkt-qval">10</span></button>
                <button class="mkt-qbtn sac" onclick="quickMkt('Sac à dos',20)"><svg class="mkt-icon-svg" viewBox="0 0 24 24"><rect x="5" y="6" width="14" height="16" rx="3" fill="#7c3aed" stroke="#6d28d9" stroke-width="1.2"/><rect x="5" y="6" width="14" height="5" rx="2" fill="#8b5cf6"/><rect x="8" y="14" width="8" height="4" rx="1.5" fill="#a78bfa" stroke="#6d28d9" stroke-width="0.6"/><path d="M8 6V4a4 4 0 0 1 8 0v2" fill="none" stroke="#6d28d9" stroke-width="1.4"/></svg><span class="mkt-qval">20</span></button>
                <button class="mkt-qbtn sac" onclick="quickMkt('Sac à dos',50)"><svg class="mkt-icon-svg" viewBox="0 0 24 24"><rect x="5" y="6" width="14" height="16" rx="3" fill="#7c3aed" stroke="#6d28d9" stroke-width="1.2"/><rect x="5" y="6" width="14" height="5" rx="2" fill="#8b5cf6"/><rect x="8" y="14" width="8" height="4" rx="1.5" fill="#a78bfa" stroke="#6d28d9" stroke-width="0.6"/><path d="M8 6V4a4 4 0 0 1 8 0v2" fill="none" stroke="#6d28d9" stroke-width="1.4"/></svg><span class="mkt-qval">50</span></button>
                <button class="mkt-qbtn sac" onclick="quickMkt('Sac à dos',100)"><svg class="mkt-icon-svg" viewBox="0 0 24 24"><rect x="5" y="6" width="14" height="16" rx="3" fill="#7c3aed" stroke="#6d28d9" stroke-width="1.2"/><rect x="5" y="6" width="14" height="5" rx="2" fill="#8b5cf6"/><rect x="8" y="14" width="8" height="4" rx="1.5" fill="#a78bfa" stroke="#6d28d9" stroke-width="0.6"/><path d="M8 6V4a4 4 0 0 1 8 0v2" fill="none" stroke="#6d28d9" stroke-width="1.4"/></svg><span class="mkt-qval">100</span></button>
            </div>
            <div class="mkt-divider"></div>
            <div class="mkt-section-label">✏️ Ajout manuel</div>
            <div class="mkt-row">
                <input type="number" id="mktAmount" placeholder="Nb de pièces" min="1" class="mkt-input"/>
            </div>
            <div class="mkt-row">
                <input type="text" id="mktComment" placeholder="Commentaire (optionnel)" class="mkt-input-text"/>
                <button class="btn-mkt" id="mktBtn" onclick="sendMarketing()">+ Ajouter</button>
            </div>
        </div>
        <div class="ll" id="lbMarketing"><div class="empty"><div class="ei">📢</div><div class="et">Aucune dépense marketing</div></div></div>
    </div>

    <!-- RECOMPENSES HEBDOMADAIRES -->
    <div class="panel">
        <div class="ph">
            <div class="pt">🏆 Récompenses Hebdo</div>
            <div class="pa"><div class="pc" id="cRewards">0 entrées</div>
                <div class="exdd"><button class="btn-ex" onclick="togEx('rewards')">⬇ Export</button>
                    <div class="exm" id="exRewards"><a href="/api/export/rewards/csv" target="_blank">📊 CSV</a></div>
                </div>
            </div>
        </div>
        <div class="rwd-form">
            <div class="rwd-row">
                <input type="text" id="rwdReason" placeholder="Raison de la récompense" class="rwd-input-text"/>
            </div>
            <div class="rwd-row">
                <input type="number" id="rwdAmount" placeholder="Nb de pièces 💎" min="1" class="rwd-input"/>
                <button class="btn-rwd" id="rwdBtn" onclick="sendReward()">+ Ajouter</button>
            </div>
        </div>
        <div class="ll" id="lbRewards"><div class="empty"><div class="ei">🏆</div><div class="et">Aucune récompense</div></div></div>
    </div>

    <!-- RETRAITS -->
    <div class="panel">
        <div class="ph">
            <div class="pt">🏧 Retraits</div>
            <div class="pa"><div class="pc" id="cWithdrawals">0 entrées</div>
                <div class="exdd"><button class="btn-ex" onclick="togEx('withdrawals')">⬇ Export</button>
                    <div class="exm" id="exWithdrawals"><a href="/api/export/withdrawals/csv" target="_blank">📊 CSV</a></div>
                </div>
            </div>
        </div>
        <div class="wdr-form">
            <div class="wdr-row">
                <input type="text" id="wdrReason" placeholder="Raison du retrait" class="wdr-input-text"/>
            </div>
            <div class="wdr-row">
                <input type="number" id="wdrAmount" placeholder="Nb de pièces 💎" min="1" class="wdr-input"/>
                <button class="btn-wdr" id="wdrBtn" onclick="sendWithdrawal()">+ Ajouter</button>
            </div>
        </div>
        <div class="ll" id="lbWithdrawals"><div class="empty"><div class="ei">🏧</div><div class="et">Aucun retrait</div></div></div>
    </div>

    <!-- CHAT -->
    <div class="panel">
        <div class="ph">
            <div class="pt">💬 Chat en direct</div>
            <div class="pc" id="cChat">0</div>
        </div>
        <div class="cl" id="chatList"><div class="empty"><div class="ei">💬</div><div class="et">En attente de messages...</div></div></div>
    </div>
</div>

<script>
var S = {
    coinsBoard:{}, likesBoard:{}, redistributionBoard:{}, marketingHistory:[], rewardsHistory:[], withdrawalsHistory:[], chatMessages:[],
    totalCoins:0, totalLikes:0, totalGifts:0, totalRedistributed:0, totalMarketing:0, totalRewards:0, totalWithdrawals:0,
    viewers:new Set(), connected:false,
    filters:{coins:'',likes:'',redist:'',balance:''},
    selectedUser:null
};

// WEBSOCKET
var ws,wrt;
function initWS(){
    var wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws=new WebSocket(wsProto+location.host);
    ws.onmessage=function(e){try{handle(JSON.parse(e.data))}catch(x){}};
    ws.onclose=function(){clearTimeout(wrt);wrt=setTimeout(initWS,3000)};
    ws.onerror=function(){ws.close()};
}

function handle(m){
    if(m.type==='RESTORE'&&m.data){
        var d=m.data;
        S.coinsBoard=d.coinsBoard||{};S.likesBoard=d.likesBoard||{};
        S.redistributionBoard=d.redistributionBoard||{};
        S.totalCoins=d.totalCoins||0;S.totalLikes=d.totalLikes||0;
        S.totalGifts=d.totalGifts||0;S.totalRedistributed=d.totalRedistributed||0;
        S.totalMarketing=d.totalMarketing||0;S.marketingHistory=d.marketingHistory||[];
        S.totalRewards=d.totalRewards||0;S.rewardsHistory=d.rewardsHistory||[];
        S.totalWithdrawals=d.totalWithdrawals||0;S.withdrawalsHistory=d.withdrawalsHistory||[];
        S.viewers=new Set(d.viewers||[]);
        if(d.chatMessages&&d.chatMessages.length>0){
            S.chatMessages=d.chatMessages.map(function(c){
                return{user:c.user,profilePictureUrl:c.profilePictureUrl||'',comment:c.comment,
                    time:c.time?new Date(c.time).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}):''};
            });
            renderChat();
        }
        if(d.currentUsername) document.getElementById('username').value=d.currentUsername;
        updStats();renderLB('coins');renderLB('likes');renderLB('redist');renderBalance();renderMarketing();renderRewards();renderWithdrawals();
        return;
    }
    if(m.type==='INFO'){
        if(m.action==='TIKTOK_CONNECTED'){setConn(true,m.data.username);if(m.data.reconnected)toast('success','✅ Reconnecté !');}
        if(m.action==='STREAM_ENDED')setConn(false);
        if(m.action==='RECONNECTING'){toast('reconnect','🔄 Reconnexion '+m.data.attempt+'/'+m.data.maxAttempts);setReco(m.data.attempt,m.data.maxAttempts);}
        if(m.action==='DATA_RESET'){
            S.coinsBoard={};S.likesBoard={};S.redistributionBoard={};S.marketingHistory=[];S.rewardsHistory=[];S.withdrawalsHistory=[];S.chatMessages=[];
            S.totalCoins=0;S.totalLikes=0;S.totalGifts=0;S.totalRedistributed=0;S.totalMarketing=0;S.totalRewards=0;S.totalWithdrawals=0;S.viewers=new Set();
            updStats();renderLB('coins');renderLB('likes');renderLB('redist');renderBalance();renderMarketing();renderRewards();renderWithdrawals();renderChat();toast('success','✅ Reset OK');
        }
        if(m.action==='REDISTRIBUTION_UPDATE'){
            S.redistributionBoard=m.data.redistributionBoard||{};
            S.totalRedistributed=m.data.totalRedistributed||0;
            updStats();renderLB('redist');renderBalance();
        }
        if(m.action==='MARKETING_UPDATE'){
            S.marketingHistory=m.data.marketingHistory||[];
            S.totalMarketing=m.data.totalMarketing||0;
            updStats();renderMarketing();
        }
        if(m.action==='REWARDS_UPDATE'){
            S.rewardsHistory=m.data.rewardsHistory||[];
            S.totalRewards=m.data.totalRewards||0;
            updStats();renderRewards();
        }
        if(m.action==='WITHDRAWALS_UPDATE'){
            S.withdrawalsHistory=m.data.withdrawalsHistory||[];
            S.totalWithdrawals=m.data.totalWithdrawals||0;
            updStats();renderWithdrawals();
        }
    }
    if(m.type==='ERROR'){setConn(false);document.getElementById('stxt').textContent=m.action==='RECONNECT_FAILED'?'Reconnexion échouée':'Erreur';}
    if(m.type==='ACTION'){
        if(m.action==='shoot_balloon')onGift(m.data);
        if(m.action==='like')onLike(m.data);
        if(m.action==='chat')onChat(m.data);
    }
}

function onGift(d){
    var u=d.user;S.viewers.add(u);
    if(!S.coinsBoard[u])S.coinsBoard[u]={user:u,profilePictureUrl:d.profilePictureUrl,total:0,gifts:{}};
    S.coinsBoard[u].total+=d.diamondCount;S.coinsBoard[u].profilePictureUrl=d.profilePictureUrl||S.coinsBoard[u].profilePictureUrl;
    var g=d.giftName||'Cadeau';S.coinsBoard[u].gifts[g]=(S.coinsBoard[u].gifts[g]||0)+1;
    S.totalCoins+=d.diamondCount;S.totalGifts++;updStats();renderLB('coins');renderBalance();
}
function onLike(d){
    var u=d.user;S.viewers.add(u);
    if(!S.likesBoard[u])S.likesBoard[u]={user:u,profilePictureUrl:d.profilePictureUrl,total:0};
    S.likesBoard[u].total+=d.count;S.likesBoard[u].profilePictureUrl=d.profilePictureUrl||S.likesBoard[u].profilePictureUrl;
    S.totalLikes+=d.count;updStats();renderLB('likes');
}
function onChat(d){
    S.viewers.add(d.user);
    S.chatMessages.push({user:d.user,profilePictureUrl:d.profilePictureUrl,comment:d.comment,time:new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})});
    if(S.chatMessages.length>200)S.chatMessages=S.chatMessages.slice(-200);
    updStats();renderChat();
}

// UTILS
function fmt(n){if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return n.toString();}
function toDol(n){return(n/250).toFixed(2);}
function toRedistDol(n){return(n/100).toFixed(2);}
function esc(t){var d=document.createElement('div');d.textContent=t;return d.innerHTML;}
function safePic(url){if(!url)return '';if(url.indexOf('http://')===0||url.indexOf('https://')===0)return esc(url);return '';}
function rkCls(i){return i===0?'g':i===1?'s':i===2?'b':'';}

function updStats(){
    document.getElementById('sCoins').textContent=fmt(S.totalCoins);
    document.getElementById('sCoinsDol').textContent='= $'+toDol(S.totalCoins);
    document.getElementById('sRedist').textContent=fmt(S.totalRedistributed);
    document.getElementById('sRedistDol').textContent='= $'+toRedistDol(S.totalRedistributed);
    document.getElementById('sLikes').textContent=fmt(S.totalLikes);
    document.getElementById('sViewers').textContent=S.viewers.size;
    document.getElementById('sGifts').textContent=fmt(S.totalGifts);
    document.getElementById('sMarketing').textContent=fmt(S.totalMarketing);
    document.getElementById('sMarketingDol').textContent='= $'+toRedistDol(S.totalMarketing);
    document.getElementById('sRewards').textContent=fmt(S.totalRewards);
    document.getElementById('sRewardsDol').textContent='= $'+toRedistDol(S.totalRewards);
    document.getElementById('sWithdrawals').textContent=fmt(S.totalWithdrawals);
    document.getElementById('sWithdrawalsDol').textContent='= $'+toRedistDol(S.totalWithdrawals);
    var earnedPieces=S.totalCoins+S.totalRewards-S.totalRedistributed;
    var earnedDol=(S.totalCoins/250)+(S.totalRewards/100)-(S.totalRedistributed/100);
    var earnedEl=document.getElementById('sEarned');
    earnedEl.textContent=(earnedPieces<0?'-':'')+fmt(Math.abs(earnedPieces));
    earnedEl.style.color=earnedPieces>=0?'#22c55e':'#ef4444';
    var earnedDolEl=document.getElementById('sEarnedDol');
    earnedDolEl.textContent='= '+(earnedDol<0?'-':'')+'$'+Math.abs(earnedDol).toFixed(2);
    earnedDolEl.style.color=earnedDol>=0?'#22c55e':'#ef4444';
}

function renderLB(type){
    var board=type==='coins'?S.coinsBoard:type==='likes'?S.likesBoard:S.redistributionBoard;
    var el=type==='coins'?document.getElementById('lbCoins'):type==='likes'?document.getElementById('lbLikes'):document.getElementById('lbRedist');

    var cntEl=type==='coins'?document.getElementById('cCoins'):type==='likes'?document.getElementById('cLikes'):document.getElementById('cRedist');
    var f=S.filters[type].toLowerCase();
    var all=Object.values(board).sort(function(a,b){return b.total-a.total});
    var label=type==='coins'?' donateurs':type==='likes'?' likers':' bénéficiaires';
    cntEl.textContent=all.length+label;
    var entries=f?all.filter(function(e){return e.user.toLowerCase().indexOf(f)!==-1}):all;

    if(entries.length===0){
        var ic=type==='coins'?'🎁':type==='likes'?'❤️':'💸';
        el.innerHTML='<div class="empty"><div class="ei">'+ic+'</div><div class="et">'+(f?'Aucun résultat':'En attente...')+'</div></div>';
        return;
    }

    var h='';
    entries.forEach(function(e){
        var rank=all.findIndex(function(x){return x.user===e.user});
        var rc=rkCls(rank);
        var sub='';
        if(type==='coins'){sub=Object.keys(e.gifts||{}).map(function(k){return esc(k)+' \\u00d7'+(e.gifts[k])}).join(', ');}
        else if(type==='likes'){sub=e.total+' likes';}
        else{
            var hist=e.history||[];
            sub=hist.length+' envoi'+(hist.length>1?'s':'');
        }

        var showDol=(type==='coins'||type==='redist');
        h+='<div class="lr">'
          +'<div class="lrk '+rc+'">'+(rank+1)+'</div>'
          +'<img class="lav" src="'+safePic(e.profilePictureUrl)+'" alt="" onerror="this.style.display=\\'none\\'" loading="lazy"/>'
          +'<div class="li"><div class="ln">@'+esc(e.user)+'</div><div class="ls">'+sub+'</div></div>'
          +'<div class="lv '+type+'"><div class="main">'+fmt(e.total)+' '+(type==='coins'?'💎':type==='likes'?'❤️':'💸')+'</div>'
          +(showDol?'<div class="dollar">$'+(type==='redist'?toRedistDol(e.total):toDol(e.total))+'</div>':'')
          +'</div></div>';
    });
    el.innerHTML=h;
}

function renderChat(){
    var el=document.getElementById('chatList');
    document.getElementById('cChat').textContent=S.chatMessages.length+' msg';
    var msgs=S.chatMessages.slice(-50);
    var h='';
    msgs.forEach(function(m){
        h+='<div class="cm"><img class="ca" src="'+safePic(m.profilePictureUrl)+'" onerror="this.style.display=\\'none\\'" loading="lazy"/>'
          +'<div class="cc"><div class="cu">@'+esc(m.user)+'</div><div class="ct">'+esc(m.comment)+'</div><div class="ctm">'+esc(m.time)+'</div></div></div>';
    });
    el.innerHTML=h;
    el.scrollTop=el.scrollHeight;
}

function filterLB(t,v){S.filters[t]=v;if(t==='balance'){renderBalance();}else{renderLB(t);}}

function renderBalance(){
    var el=document.getElementById('lbBalance');
    var cntEl=document.getElementById('cBalance');
    var f=S.filters.balance.toLowerCase();

    var users={};
    Object.values(S.coinsBoard).forEach(function(e){
        if(!users[e.user])users[e.user]={user:e.user,profilePictureUrl:e.profilePictureUrl||'',given:0,received:0};
        users[e.user].given=e.total;
        users[e.user].profilePictureUrl=e.profilePictureUrl||users[e.user].profilePictureUrl;
    });
    Object.values(S.redistributionBoard).forEach(function(e){
        if(!users[e.user])users[e.user]={user:e.user,profilePictureUrl:e.profilePictureUrl||'',given:0,received:0};
        users[e.user].received=e.total;
        users[e.user].profilePictureUrl=e.profilePictureUrl||users[e.user].profilePictureUrl;
    });

    var all=Object.values(users).filter(function(u){return u.given>0||u.received>0});
    all.sort(function(a,b){return(b.given-b.received)-(a.given-a.received)});

    var label=' utilisateurs';
    cntEl.textContent=all.length+label;

    var entries=f?all.filter(function(e){return e.user.toLowerCase().indexOf(f)!==-1}):all;

    if(entries.length===0){
        el.innerHTML='<div class="empty"><div class="ei">⚖️</div><div class="et">'+(f?'Aucun résultat':'En attente de données...')+'</div></div>';
        return;
    }

    var h='';
    entries.forEach(function(e,i){
        var net=e.given-e.received;
        var netCls=net>0?'positive':net<0?'negative':'neutral';
        var tagCls=net>0?'owes':net<0?'owed':'even';
        var tagTxt=net>0?'Te doit':net<0?'Tu dois':'Équilibré';
        var netSign=net>0?'+':'';

        h+='<div class="bal-row">'
          +'<div class="lrk">'+(i+1)+'</div>'
          +'<img class="lav" src="'+safePic(e.profilePictureUrl)+'" alt="" onerror="this.style.display=\\'none\\'" loading="lazy"/>'
          +'<div class="li"><div class="ln">@'+esc(e.user)+' <span class="bal-tag '+tagCls+'">'+tagTxt+'</span></div>'
          +'<div class="ls">Donné: '+fmt(e.given)+' 💎 · Reçu: '+fmt(e.received)+' 💸</div></div>'
          +'<div class="bal-vals">'
          +'<div class="bal-given">▲ '+fmt(e.given)+' 💎 ($'+toDol(e.given)+')</div>'
          +'<div class="bal-received">▼ '+fmt(e.received)+' 💸 ($'+toRedistDol(e.received)+')</div>'
          +'<div class="bal-net '+netCls+'">'+netSign+'$'+(Math.abs(e.given/250 - e.received/100)).toFixed(2)+'</div>'
          +'</div></div>';
    });
    el.innerHTML=h;
}

// CONNECTION
function setConn(on,user){
    S.connected=on;
    var dot=document.getElementById('dot'),badge=document.getElementById('badge'),st=document.getElementById('stxt'),btn=document.getElementById('btnCo');
    badge.classList.remove('reco');
    if(on){dot.classList.add('on');badge.classList.add('live');st.textContent='🔴 LIVE @'+user;btn.textContent='Connecté';}
    else{dot.classList.remove('on');badge.classList.remove('live');st.textContent='Déconnecté';btn.textContent='Connexion';btn.disabled=false;}
}
function setReco(a,m){document.getElementById('badge').classList.remove('live');document.getElementById('badge').classList.add('reco');document.getElementById('stxt').textContent='🔄 '+a+'/'+m;}

function doConnect(){
    var inp=document.getElementById('username'),btn=document.getElementById('btnCo'),u=inp.value.trim();
    if(!u){inp.focus();return;}
    btn.disabled=true;btn.textContent='Connexion...';document.getElementById('stxt').textContent='Connexion...';
    fetch('/connect?username='+encodeURIComponent(u)).then(function(r){return r.json()}).then(function(d){
        if(!d.success){setConn(false);document.getElementById('stxt').textContent=d.message;}
    }).catch(function(){setConn(false);document.getElementById('stxt').textContent='Erreur';btn.disabled=false;btn.textContent='Connexion';});
}
document.getElementById('username').addEventListener('keydown',function(e){if(e.key==='Enter')doConnect();});

// EXPORT MENUS
function togEx(t){
    var id=t==='coins'?'exCoins':t==='likes'?'exLikes':t==='redist'?'exRedist':t==='marketing'?'exMarketing':t==='rewards'?'exRewards':t==='withdrawals'?'exWithdrawals':'exBalance';
    var m=document.getElementById(id);
    document.querySelectorAll('.exm').forEach(function(x){if(x!==m)x.classList.remove('open')});
    m.classList.toggle('open');
}
document.addEventListener('click',function(e){if(!e.target.closest('.exdd'))document.querySelectorAll('.exm').forEach(function(x){x.classList.remove('open')})});

// REDISTRIBUTION
function searchViewers(q){
    var res=document.getElementById('rfResults');
    if(!q||q.length<1){res.classList.remove('open');return;}
    q=q.toLowerCase().replace('@','');
    var all={};
    Object.values(S.coinsBoard).forEach(function(e){all[e.user]=e.profilePictureUrl||'';});
    Object.values(S.likesBoard).forEach(function(e){if(!all[e.user])all[e.user]=e.profilePictureUrl||'';});
    S.viewers.forEach(function(v){if(!all[v])all[v]='';});

    var matches=Object.keys(all).filter(function(u){return u.toLowerCase().indexOf(q)!==-1}).slice(0,8);
    if(matches.length===0){res.classList.remove('open');return;}

    var h='';
    matches.forEach(function(u){
        var safeUser=esc(u).replace(/'/g,'&#39;');
        var safePicUrl=safePic(all[u]).replace(/'/g,'&#39;');
        h+='<div class="rf-item" data-user="'+safeUser+'" data-pic="'+safePicUrl+'" onclick="selectViewer(this.dataset.user,this.dataset.pic)">'
          +'<img src="'+safePic(all[u])+'" onerror="this.style.display=\\'none\\'"/>'
          +'<span>@'+esc(u)+'</span></div>';
    });
    res.innerHTML=h;
    res.classList.add('open');
}

function selectViewer(user,pic){
    S.selectedUser=user;
    document.getElementById('rfSearch').style.display='none';
    document.getElementById('rfResults').classList.remove('open');
    var sel=document.getElementById('rfSelected');
    sel.style.display='flex';
    document.getElementById('rfSelName').textContent='@'+user;
    var img=document.getElementById('rfSelPic');
    var cleanPic=(pic&&(pic.indexOf('http://')===0||pic.indexOf('https://')===0))?pic:'';
    img.src=cleanPic;img.style.display=cleanPic?'block':'none';
    document.getElementById('rfAmount').focus();
}

function clearSelection(){
    S.selectedUser=null;
    document.getElementById('rfSelected').style.display='none';
    document.getElementById('rfSearch').style.display='block';
    document.getElementById('rfSearch').value='';
}

function sendRedist(){
    if(!S.selectedUser){toast('error','Sélectionne un viewer');return;}
    var amount=parseInt(document.getElementById('rfAmount').value);
    if(!amount||amount<=0){toast('error','Montant invalide');return;}
    var btn=document.getElementById('rfBtn');
    btn.disabled=true;btn.textContent='Envoi...';
    fetch('/api/redistribute',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:S.selectedUser,amount:amount})})
        .then(function(r){return r.json()})
        .then(function(d){
            if(d.success){
                toast('success','✅ '+amount+' pièces → @'+S.selectedUser);
                document.getElementById('rfAmount').value='';
                clearSelection();
            } else { toast('error',d.message||'Erreur'); }
            btn.disabled=false;btn.textContent='Envoyer';
        })
        .catch(function(){toast('error','Erreur serveur');btn.disabled=false;btn.textContent='Envoyer';});
}
document.getElementById('rfAmount').addEventListener('keydown',function(e){if(e.key==='Enter')sendRedist();});

// RESET
function resetData(){
    if(!confirm('Réinitialiser toutes les données ?'))return;
    fetch('/api/reset',{method:'POST'}).then(function(r){return r.json()}).then(function(d){if(d.success)toast('success','✅ Reset OK')}).catch(function(){toast('error','Erreur')});
}

function importSave(event){
    var file=event.target.files[0];
    if(!file)return;
    toast('success','Chargement du fichier...');
    var reader=new FileReader();
    reader.onload=function(e){
        try{
            var data=JSON.parse(e.target.result);
            if(!data.coinsBoard&&!data.likesBoard){toast('error','Ce fichier ne contient pas de données valides');return;}
            if(!confirm('Importer cette sauvegarde ?\\nLes données actuelles seront remplacées.'))return;
            toast('success','Import en cours...');
            fetch('/api/import',{
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:e.target.result
            })
            .then(function(r){
                if(!r.ok)throw new Error('Erreur serveur '+r.status);
                return r.json();
            })
            .then(function(d){
                if(d.success){
                    toast('success','Sauvegarde importee !');
                    setTimeout(function(){location.reload();},1000);
                }else{toast('error',d.message||'Erreur import');}
            })
            .catch(function(err){toast('error','Erreur: '+err.message);});
        }catch(err){toast('error','Fichier JSON invalide: '+err.message);}
    };
    reader.onerror=function(){toast('error','Impossible de lire le fichier');};
    reader.readAsText(file);
    event.target.value='';
}

// TOAST
function toast(type,msg){
    var t=document.getElementById('dToast');
    if(!t){t=document.createElement('div');t.id='dToast';t.className='toast';document.body.appendChild(t);}
    t.className='toast '+type;t.textContent=msg;t.classList.add('show');
    setTimeout(function(){t.classList.remove('show')},2500);
}

// MARKETING
function quickMkt(type,amount){
    var btns=document.querySelectorAll('.mkt-qbtn');
    btns.forEach(function(b){b.classList.add('sending')});
    var comment=type+' '+amount+' pièces';
    fetch('/api/marketing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:amount,comment:comment,mktType:type})})
        .then(function(r){return r.json()})
        .then(function(d){
            if(d.success){
                toast('success','📢 '+type+' +'+amount+' pièces');
            } else { toast('error',d.message||'Erreur'); }
            btns.forEach(function(b){b.classList.remove('sending')});
        })
        .catch(function(){toast('error','Erreur serveur');btns.forEach(function(b){b.classList.remove('sending')});});
}

function sendMarketing(){
    var amount=parseInt(document.getElementById('mktAmount').value);
    if(!amount||amount<=0){toast('error','Montant invalide');return;}
    var comment=document.getElementById('mktComment').value.trim();
    var btn=document.getElementById('mktBtn');
    btn.disabled=true;btn.textContent='Envoi...';
    fetch('/api/marketing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:amount,comment:comment||'Ajout manuel '+amount+' pièces',mktType:'Manuel'})})
        .then(function(r){return r.json()})
        .then(function(d){
            if(d.success){
                toast('success','📢 +'+amount+' pièces marketing');
                document.getElementById('mktAmount').value='';
                document.getElementById('mktComment').value='';
            } else { toast('error',d.message||'Erreur'); }
            btn.disabled=false;btn.textContent='+ Ajouter';
        })
        .catch(function(){toast('error','Erreur serveur');btn.disabled=false;btn.textContent='+ Ajouter';});
}
document.getElementById('mktAmount').addEventListener('keydown',function(e){if(e.key==='Enter')sendMarketing();});
document.getElementById('mktComment').addEventListener('keydown',function(e){if(e.key==='Enter')sendMarketing();});

function renderMarketing(){
    var el=document.getElementById('lbMarketing');
    var cntEl=document.getElementById('cMarketing');
    var hist=S.marketingHistory||[];
    cntEl.textContent=hist.length+' entrée'+(hist.length>1?'s':'');
    if(hist.length===0){
        el.innerHTML='<div class="empty"><div class="ei">📢</div><div class="et">Aucune dépense marketing</div></div>';
        return;
    }
    var h='';
    var reversed=hist.slice().reverse();
    reversed.forEach(function(e){
        var d=e.date?new Date(e.date).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'';
        var t=(e.mktType||'').toLowerCase();
        var icon=t==='coffre'?'🧰':t.indexOf('sac')!==-1?'🎒':'✏️';
        var tagCls=t==='coffre'?'coffre':t.indexOf('sac')!==-1?'sac':'manuel';
        var tagTxt=t==='coffre'?'Coffre':t.indexOf('sac')!==-1?'Sac à dos':'Manuel';
        h+='<div class="mkt-entry">'
          +'<div class="mkt-icon">'+icon+'</div>'
          +'<div class="mkt-info"><div class="mkt-amount"><span class="mkt-entry-type '+tagCls+'">'+tagTxt+'</span>+'+fmt(e.amount)+' 💎</div>'
          +(e.comment?'<div class="mkt-comment">'+esc(e.comment)+'</div>':'')
          +'<div class="mkt-date">'+esc(d)+'</div></div>'
          +'<div class="mkt-val">$'+toRedistDol(e.amount)+'</div>'
          +'</div>';
    });
    el.innerHTML=h;
}

// RECOMPENSES HEBDOMADAIRES
function sendReward(){
    var reason=document.getElementById('rwdReason').value.trim();
    var amount=parseInt(document.getElementById('rwdAmount').value);
    if(!reason){toast('error','Raison requise');return;}
    if(!amount||amount<=0){toast('error','Montant invalide');return;}
    var btn=document.getElementById('rwdBtn');
    btn.disabled=true;btn.textContent='Envoi...';
    fetch('/api/rewards',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:amount,reason:reason})})
        .then(function(r){return r.json()})
        .then(function(d){
            if(d.success){
                toast('success','🏆 +'+amount+' pièces récompense');
                document.getElementById('rwdAmount').value='';
                document.getElementById('rwdReason').value='';
            } else { toast('error',d.message||'Erreur'); }
            btn.disabled=false;btn.textContent='+ Ajouter';
        })
        .catch(function(){toast('error','Erreur serveur');btn.disabled=false;btn.textContent='+ Ajouter';});
}
document.getElementById('rwdAmount').addEventListener('keydown',function(e){if(e.key==='Enter')sendReward();});
document.getElementById('rwdReason').addEventListener('keydown',function(e){if(e.key==='Enter')sendReward();});

function renderRewards(){
    var el=document.getElementById('lbRewards');
    var cntEl=document.getElementById('cRewards');
    var hist=S.rewardsHistory||[];
    cntEl.textContent=hist.length+' entrée'+(hist.length>1?'s':'');
    if(hist.length===0){
        el.innerHTML='<div class="empty"><div class="ei">🏆</div><div class="et">Aucune récompense</div></div>';
        return;
    }
    var h='';
    var reversed=hist.slice().reverse();
    reversed.forEach(function(e){
        var d=e.date?new Date(e.date).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'';
        h+='<div class="rwd-entry">'
          +'<div class="rwd-icon">🏆</div>'
          +'<div class="rwd-info"><div class="rwd-amount">+'+fmt(e.amount)+' 💎</div>'
          +'<div class="rwd-reason">'+esc(e.reason)+'</div>'
          +'<div class="rwd-date">'+esc(d)+'</div></div>'
          +'<div class="rwd-val">$'+toRedistDol(e.amount)+'</div>'
          +'</div>';
    });
    el.innerHTML=h;
}

// RETRAITS
function sendWithdrawal(){
    var reason=document.getElementById('wdrReason').value.trim();
    var amount=parseInt(document.getElementById('wdrAmount').value);
    if(!reason){toast('error','Raison requise');return;}
    if(!amount||amount<=0){toast('error','Montant invalide');return;}
    var btn=document.getElementById('wdrBtn');
    btn.disabled=true;btn.textContent='Envoi...';
    fetch('/api/withdrawals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:amount,reason:reason})})
        .then(function(r){return r.json()})
        .then(function(d){
            if(d.success){
                toast('success','🏧 +'+amount+' pièces retrait');
                document.getElementById('wdrAmount').value='';
                document.getElementById('wdrReason').value='';
            } else { toast('error',d.message||'Erreur'); }
            btn.disabled=false;btn.textContent='+ Ajouter';
        })
        .catch(function(){toast('error','Erreur serveur');btn.disabled=false;btn.textContent='+ Ajouter';});
}
document.getElementById('wdrAmount').addEventListener('keydown',function(e){if(e.key==='Enter')sendWithdrawal();});
document.getElementById('wdrReason').addEventListener('keydown',function(e){if(e.key==='Enter')sendWithdrawal();});

function renderWithdrawals(){
    var el=document.getElementById('lbWithdrawals');
    var cntEl=document.getElementById('cWithdrawals');
    var hist=S.withdrawalsHistory||[];
    cntEl.textContent=hist.length+' entrée'+(hist.length>1?'s':'');
    if(hist.length===0){
        el.innerHTML='<div class="empty"><div class="ei">🏧</div><div class="et">Aucun retrait</div></div>';
        return;
    }
    var h='';
    var reversed=hist.slice().reverse();
    reversed.forEach(function(e){
        var d=e.date?new Date(e.date).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'';
        h+='<div class="wdr-entry">'
          +'<div class="wdr-icon">🏧</div>'
          +'<div class="wdr-info"><div class="wdr-amount">-'+fmt(e.amount)+' 💎</div>'
          +'<div class="wdr-reason">'+esc(e.reason)+'</div>'
          +'<div class="wdr-date">'+esc(d)+'</div></div>'
          +'<div class="wdr-val">$'+toRedistDol(e.amount)+'</div>'
          +'</div>';
    });
    el.innerHTML=h;
}

initWS();
</script>
</body>
</html>`;

// ================= DÉMARRAGE =================
server.listen(PORT, '0.0.0.0', () => {
    console.log('=========================================');
    if (IS_RAILWAY) {
        console.log('🚀 SERVEUR RAILWAY PRÊT');
        console.log('🌐 URL : https://' + (process.env.RAILWAY_PUBLIC_DOMAIN || 'ton-app.up.railway.app'));
        console.log('📦 Mode : Mémoire (données non persistantes)');
    } else {
        console.log('🚀 SERVEUR LOCAL PRÊT : http://localhost:' + PORT);
        console.log('📁 Données : ' + LOG_FILE);
    }
    console.log('=========================================');
});
