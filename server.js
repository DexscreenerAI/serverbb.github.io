const { WebcastPushConnection } = require('tiktok-live-connector');
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ================= CONFIGURATION =================
const PORT = process.env.PORT || 8832;
const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT;
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const DATA_DIR = path.join(BASE_DIR, 'data');
const MAX_RECONNECT_ATTEMPTS = 4;
const RECONNECT_DELAY_MS = 5000;
const ROOM_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes d'inactivité

// ================= INITIALISATION =================
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ================= MULTI-SESSIONS : ROOMS =================
const rooms = new Map();

let useFileStorage = true;
try {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log('📁 Dossier data/ créé');
    }
} catch (e) {
    console.warn('⚠️ Stockage fichier indisponible:', e.message);
    useFileStorage = false;
}

function createEmptyState() {
    return {
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
}

function getRoom(roomId) {
    if (!roomId || roomId.length < 3) return null;
    
    if (!rooms.has(roomId)) {
        console.log('🏠 Nouvelle room créée:', roomId);
        const room = {
            id: roomId,
            connection: null,
            username: null,
            clients: new Set(),
            state: createEmptyState(),
            reconnectAttempts: 0,
            reconnectTimer: null,
            isManualDisconnect: false,
            processedEvents: new Set(),
            lastActivity: new Date(),
            saveTimeout: null
        };
        loadRoomState(room);
        rooms.set(roomId, room);
    }
    
    const room = rooms.get(roomId);
    room.lastActivity = new Date();
    return room;
}

function loadRoomState(room) {
    if (!useFileStorage) return;
    const filePath = path.join(DATA_DIR, `room_${room.id}.json`);
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const saved = JSON.parse(raw);
            room.state = { ...createEmptyState(), ...saved };
            console.log('📂 Room ' + room.id + ' : données restaurées');
        }
    } catch (e) {
        console.warn('⚠️ Erreur chargement room ' + room.id + ':', e.message);
    }
}

function saveRoomState(room) {
    if (!useFileStorage) return;
    clearTimeout(room.saveTimeout);
    room.saveTimeout = setTimeout(() => {
        try {
            room.state.lastUpdated = new Date().toISOString();
            const filePath = path.join(DATA_DIR, `room_${room.id}.json`);
            fs.writeFileSync(filePath, JSON.stringify(room.state, null, 2), 'utf-8');
        } catch (e) {
            console.warn('⚠️ Erreur sauvegarde room ' + room.id + ':', e.message);
        }
    }, 1000);
}

// Nettoyage des rooms inactives
setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of rooms) {
        if (room.clients.size === 0 && (now - room.lastActivity.getTime()) > ROOM_TIMEOUT_MS) {
            console.log('🧹 Suppression room inactive:', roomId);
            if (room.connection) {
                try { room.connection.disconnect(); } catch (e) {}
            }
            clearTimeout(room.reconnectTimer);
            clearTimeout(room.saveTimeout);
            rooms.delete(roomId);
        }
    }
}, 60000);

// ================= FONCTIONS ROOM =================
function recordGift(room, data) {
    const uid = data.user;
    if (!room.state.coinsBoard[uid]) {
        room.state.coinsBoard[uid] = { user: uid, profilePictureUrl: data.profilePictureUrl, total: 0, gifts: {} };
    }
    room.state.coinsBoard[uid].total += data.diamondCount;
    room.state.coinsBoard[uid].profilePictureUrl = data.profilePictureUrl || room.state.coinsBoard[uid].profilePictureUrl;
    const gn = data.giftName || 'Cadeau';
    room.state.coinsBoard[uid].gifts[gn] = (room.state.coinsBoard[uid].gifts[gn] || 0) + 1;
    room.state.totalCoins += data.diamondCount;
    room.state.totalGifts++;
    addViewer(room, uid);
    saveRoomState(room);
}

function recordLike(room, data) {
    const uid = data.user;
    if (!room.state.likesBoard[uid]) {
        room.state.likesBoard[uid] = { user: uid, profilePictureUrl: data.profilePictureUrl, total: 0 };
    }
    room.state.likesBoard[uid].total += data.count;
    room.state.likesBoard[uid].profilePictureUrl = data.profilePictureUrl || room.state.likesBoard[uid].profilePictureUrl;
    room.state.totalLikes += data.count;
    addViewer(room, uid);
    saveRoomState(room);
}

function recordChat(room, data) {
    room.state.chatMessages.push({ user: data.user, profilePictureUrl: data.profilePictureUrl || '', comment: data.comment, time: new Date().toISOString() });
    if (room.state.chatMessages.length > 1000) room.state.chatMessages = room.state.chatMessages.slice(-1000);
    addViewer(room, data.user);
    saveRoomState(room);
}

function addViewer(room, uid) {
    if (!room.state.viewers.includes(uid)) room.state.viewers.push(uid);
}

function sendToRoom(room, type, action, data) {
    const payload = JSON.stringify({ type, action, data });
    room.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
    });
}

// ================= RECONNEXION =================
function attemptReconnect(room) {
    if (room.isManualDisconnect || !room.username) return;
    if (room.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log('🚫 Room ' + room.id + ' : reconnexion abandonnée');
        sendToRoom(room, 'ERROR', 'RECONNECT_FAILED', { error: 'Reconnexion échouée' });
        room.reconnectAttempts = 0;
        return;
    }
    room.reconnectAttempts++;
    const delay = RECONNECT_DELAY_MS * room.reconnectAttempts;
    console.log('🔄 Room ' + room.id + ' : tentative ' + room.reconnectAttempts + '/' + MAX_RECONNECT_ATTEMPTS);
    sendToRoom(room, 'INFO', 'RECONNECTING', { attempt: room.reconnectAttempts, maxAttempts: MAX_RECONNECT_ATTEMPTS, delayMs: delay });
    clearTimeout(room.reconnectTimer);
    room.reconnectTimer = setTimeout(() => { connectToTikTok(room, room.username, true); }, delay);
}

// ================= CONNEXION TIKTOK =================
function connectToTikTok(room, username, isReconnect = false) {
    let cleanUsername = username.toString().replace('@', '').trim();

    if (!isReconnect) {
        room.reconnectAttempts = 0;
        room.isManualDisconnect = false;
        clearTimeout(room.reconnectTimer);
        room.state.sessions.push({ username: cleanUsername, startedAt: new Date().toISOString(), endedAt: null });
        saveRoomState(room);
    }

    if (room.connection) {
        try {
            room.isManualDisconnect = true;
            room.connection.disconnect();
        } catch (e) {}
        room.isManualDisconnect = false;
    }
    if (!isReconnect) room.isManualDisconnect = false;

    let options = {
        processInitialData: false,
        enableExtendedGiftInfo: false,
        enableWebsocketUpgrade: true,
        clientParams: { "display_language": "fr-FR", "device_platform": "web", "browser_name": "Mozilla" }
    };

    room.connection = new WebcastPushConnection(cleanUsername, options);
    room.username = cleanUsername;

    room.connection.connect()
        .then(st => {
            room.reconnectAttempts = 0;
            console.log('✅ Room ' + room.id + ' : CONNECTÉ @' + cleanUsername);
            sendToRoom(room, 'INFO', 'TIKTOK_CONNECTED', { username: cleanUsername, reconnected: isReconnect });
        })
        .catch(err => {
            console.error('❌ Room ' + room.id + ' :', err.message);
            if (isReconnect) { attemptReconnect(room); }
            else { sendToRoom(room, 'ERROR', 'CONNECTION_FAILED', { error: "Vérifie le pseudo et que le live est en cours !" }); }
        });

    room.connection.on('gift', (data) => {
        if (data.giftType === 1 && !data.repeatEnd) return;
        if (room.processedEvents.has(data.msgId)) return;
        room.processedEvents.add(data.msgId);
        if (room.processedEvents.size > 500) { const it = room.processedEvents.values(); room.processedEvents.delete(it.next().value); }
        let totalCoins = data.diamondCount * data.repeatCount;
        if (totalCoins < 1) totalCoins = 1;
        const giftData = { user: data.uniqueId, profilePictureUrl: data.profilePictureUrl, count: totalCoins, giftName: data.giftName, diamondCount: totalCoins };
        sendToRoom(room, 'ACTION', 'shoot_balloon', giftData);
        recordGift(room, giftData);
    });

    room.connection.on('like', (data) => {
        let count = data.likeCount ? parseInt(data.likeCount) : 1;
        const likeData = { user: data.uniqueId, profilePictureUrl: data.profilePictureUrl, count: count };
        sendToRoom(room, 'ACTION', 'like', likeData);
        recordLike(room, likeData);
    });

    room.connection.on('chat', (data) => {
        const chatData = { user: data.uniqueId, profilePictureUrl: data.profilePictureUrl, comment: data.comment };
        sendToRoom(room, 'ACTION', 'chat', chatData);
        recordChat(room, chatData);
    });

    room.connection.on('streamEnd', () => {
        const lastSession = room.state.sessions[room.state.sessions.length - 1];
        if (lastSession) lastSession.endedAt = new Date().toISOString();
        saveRoomState(room);
        sendToRoom(room, 'INFO', 'STREAM_ENDED', {});
        attemptReconnect(room);
    });

    room.connection.on('disconnected', () => { if (!room.isManualDisconnect) attemptReconnect(room); });
    room.connection.on('error', (err) => { console.error("⚠️ Room " + room.id + " erreur:", err.message); });
}

// ================= WEBSOCKET =================
wss.on('connection', (ws, req) => {
    const params = url.parse(req.url, true).query;
    const roomId = params.room || 'default';
    
    const room = getRoom(roomId);
    if (!room) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Room ID invalide (min 3 caractères)' }));
        ws.close();
        return;
    }
    
    room.clients.add(ws);
    console.log('🔌 Room ' + roomId + ' : client connecté (Total: ' + room.clients.size + ')');

    ws.send(JSON.stringify({ type: 'INFO', message: 'Connecté à la room: ' + roomId }));

    ws.send(JSON.stringify({
        type: 'RESTORE',
        data: {
            roomId: roomId,
            coinsBoard: room.state.coinsBoard,
            likesBoard: room.state.likesBoard,
            redistributionBoard: room.state.redistributionBoard,
            totalCoins: room.state.totalCoins,
            totalLikes: room.state.totalLikes,
            totalGifts: room.state.totalGifts,
            totalRedistributed: room.state.totalRedistributed,
            totalMarketing: room.state.totalMarketing,
            totalRewards: room.state.totalRewards,
            totalWithdrawals: room.state.totalWithdrawals,
            marketingHistory: room.state.marketingHistory || [],
            rewardsHistory: room.state.rewardsHistory || [],
            withdrawalsHistory: room.state.withdrawalsHistory || [],
            viewers: room.state.viewers,
            chatMessages: room.state.chatMessages.slice(-200),
            currentUsername: room.username || null
        }
    }));

    if (room.connection && room.username) {
        ws.send(JSON.stringify({ type: 'INFO', action: 'TIKTOK_CONNECTED', data: { username: room.username } }));
    }

    ws.on('close', () => {
        room.clients.delete(ws);
        console.log('❌ Room ' + roomId + ' : client déconnecté');
    });
});

// ================= ROUTES API =================
app.get('/connect', (req, res) => {
    const username = req.query.username;
    const roomId = req.query.room || 'default';
    const room = getRoom(roomId);
    
    if (!room) return res.status(400).json({ success: false, message: "Room ID invalide" });
    if (!username) return res.status(400).json({ success: false, message: "Pseudo manquant." });
    
    connectToTikTok(room, username);
    res.json({ success: true, message: 'Connexion lancée vers @' + username });
});

app.get('/disconnect', (req, res) => {
    const roomId = req.query.room || 'default';
    const room = getRoom(roomId);
    
    if (!room) return res.status(400).json({ success: false, message: "Room ID invalide" });
    
    if (room.connection) {
        room.isManualDisconnect = true;
        clearTimeout(room.reconnectTimer);
        try { room.connection.disconnect(); } catch (e) {}
        room.connection = null;
        room.username = null;
        room.reconnectAttempts = 0;
        sendToRoom(room, 'INFO', 'STREAM_ENDED', {});
        console.log('🔌 Room ' + roomId + ' : déconnecté');
        res.json({ success: true, message: 'Déconnecté du live' });
    } else {
        res.json({ success: false, message: 'Pas de connexion active' });
    }
});

app.post('/api/redistribute', (req, res) => {
    const { user, amount, room: roomId } = req.body;
    const room = getRoom(roomId || 'default');
    if (!room) return res.status(400).json({ success: false, message: 'Room invalide' });
    if (!user || !amount || amount <= 0) return res.status(400).json({ success: false, message: 'Pseudo et montant requis' });
    
    const uid = user.toString().replace('@', '').trim();
    if (!room.state.redistributionBoard[uid]) {
        const fromCoins = room.state.coinsBoard[uid];
        const fromLikes = room.state.likesBoard[uid];
        const pic = (fromCoins && fromCoins.profilePictureUrl) || (fromLikes && fromLikes.profilePictureUrl) || '';
        room.state.redistributionBoard[uid] = { user: uid, profilePictureUrl: pic, total: 0, history: [] };
    }
    room.state.redistributionBoard[uid].total += parseInt(amount);
    room.state.redistributionBoard[uid].history.push({ amount: parseInt(amount), date: new Date().toISOString() });
    room.state.totalRedistributed += parseInt(amount);
    saveRoomState(room);
    sendToRoom(room, 'INFO', 'REDISTRIBUTION_UPDATE', { redistributionBoard: room.state.redistributionBoard, totalRedistributed: room.state.totalRedistributed });
    res.json({ success: true, message: amount + ' pièces redistribuées à @' + uid });
});

app.post('/api/marketing', (req, res) => {
    const { amount, comment, mktType, room: roomId } = req.body;
    const room = getRoom(roomId || 'default');
    if (!room) return res.status(400).json({ success: false, message: 'Room invalide' });
    const parsed = parseInt(amount);
    if (!parsed || parsed <= 0) return res.status(400).json({ success: false, message: 'Montant invalide' });
    
    room.state.marketingHistory.push({ amount: parsed, comment: comment || '', mktType: mktType || 'Manuel', date: new Date().toISOString() });
    room.state.totalMarketing += parsed;
    saveRoomState(room);
    sendToRoom(room, 'INFO', 'MARKETING_UPDATE', { marketingHistory: room.state.marketingHistory, totalMarketing: room.state.totalMarketing });
    res.json({ success: true, message: parsed + ' pièces marketing' });
});

app.post('/api/rewards', (req, res) => {
    const { amount, reason, room: roomId } = req.body;
    const room = getRoom(roomId || 'default');
    if (!room) return res.status(400).json({ success: false, message: 'Room invalide' });
    const parsed = parseInt(amount);
    if (!parsed || parsed <= 0) return res.status(400).json({ success: false, message: 'Montant invalide' });
    if (!reason || !reason.trim()) return res.status(400).json({ success: false, message: 'Raison requise' });
    
    room.state.rewardsHistory.push({ amount: parsed, reason: reason.trim(), date: new Date().toISOString() });
    room.state.totalRewards += parsed;
    saveRoomState(room);
    sendToRoom(room, 'INFO', 'REWARDS_UPDATE', { rewardsHistory: room.state.rewardsHistory, totalRewards: room.state.totalRewards });
    res.json({ success: true, message: parsed + ' pièces récompenses' });
});

app.post('/api/withdrawals', (req, res) => {
    const { amount, reason, room: roomId } = req.body;
    const room = getRoom(roomId || 'default');
    if (!room) return res.status(400).json({ success: false, message: 'Room invalide' });
    const parsed = parseInt(amount);
    if (!parsed || parsed <= 0) return res.status(400).json({ success: false, message: 'Montant invalide' });
    if (!reason || !reason.trim()) return res.status(400).json({ success: false, message: 'Raison requise' });
    
    room.state.withdrawalsHistory.push({ amount: parsed, reason: reason.trim(), date: new Date().toISOString() });
    room.state.totalWithdrawals += parsed;
    saveRoomState(room);
    sendToRoom(room, 'INFO', 'WITHDRAWALS_UPDATE', { withdrawalsHistory: room.state.withdrawalsHistory, totalWithdrawals: room.state.totalWithdrawals });
    res.json({ success: true, message: parsed + ' pièces retraits' });
});

app.get('/api/export/all', (req, res) => {
    const room = getRoom(req.query.room || 'default');
    if (!room) return res.status(400).json({ success: false });
    res.setHeader('Content-Disposition', 'attachment; filename="room_' + room.id + '_export.json"');
    res.json({ exportedAt: new Date().toISOString(), roomId: room.id, ...room.state });
});

app.get('/api/export/coins/csv', (req, res) => {
    const room = getRoom(req.query.room || 'default');
    if (!room) return res.status(400).send('Room invalide');
    const sorted = Object.values(room.state.coinsBoard).sort((a, b) => b.total - a.total);
    let csv = 'Rang,Pseudo,Total,Dollars\n';
    sorted.forEach((e, i) => { csv += (i+1) + ',"' + e.user + '",' + e.total + ',' + (e.total/250).toFixed(2) + '\n'; });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="coins.csv"');
    res.send('\uFEFF' + csv);
});

app.get('/api/export/likes/csv', (req, res) => {
    const room = getRoom(req.query.room || 'default');
    if (!room) return res.status(400).send('Room invalide');
    const sorted = Object.values(room.state.likesBoard).sort((a, b) => b.total - a.total);
    let csv = 'Rang,Pseudo,Total_Likes\n';
    sorted.forEach((e, i) => { csv += (i+1) + ',"' + e.user + '",' + e.total + '\n'; });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="likes.csv"');
    res.send('\uFEFF' + csv);
});

app.get('/api/export/redist/csv', (req, res) => {
    const room = getRoom(req.query.room || 'default');
    if (!room) return res.status(400).send('Room invalide');
    const sorted = Object.values(room.state.redistributionBoard).sort((a, b) => b.total - a.total);
    let csv = 'Rang,Pseudo,Total,Dollars\n';
    sorted.forEach((e, i) => { csv += (i+1) + ',"' + e.user + '",' + e.total + ',' + (e.total/100).toFixed(2) + '\n'; });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="redistribution.csv"');
    res.send('\uFEFF' + csv);
});

app.get('/api/export/marketing/csv', (req, res) => {
    const room = getRoom(req.query.room || 'default');
    if (!room) return res.status(400).send('Room invalide');
    let csv = 'Date,Type,Montant,Commentaire\n';
    (room.state.marketingHistory || []).forEach(h => { csv += '"' + h.date + '","' + (h.mktType||'') + '",' + h.amount + ',"' + (h.comment||'') + '"\n'; });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="marketing.csv"');
    res.send('\uFEFF' + csv);
});

app.get('/api/export/rewards/csv', (req, res) => {
    const room = getRoom(req.query.room || 'default');
    if (!room) return res.status(400).send('Room invalide');
    let csv = 'Date,Raison,Montant\n';
    (room.state.rewardsHistory || []).forEach(h => { csv += '"' + h.date + '","' + (h.reason||'') + '",' + h.amount + '\n'; });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="rewards.csv"');
    res.send('\uFEFF' + csv);
});

app.get('/api/export/withdrawals/csv', (req, res) => {
    const room = getRoom(req.query.room || 'default');
    if (!room) return res.status(400).send('Room invalide');
    let csv = 'Date,Raison,Montant\n';
    (room.state.withdrawalsHistory || []).forEach(h => { csv += '"' + h.date + '","' + (h.reason||'') + '",' + h.amount + '\n'; });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="withdrawals.csv"');
    res.send('\uFEFF' + csv);
});

app.get('/api/export/balance/csv', (req, res) => {
    const room = getRoom(req.query.room || 'default');
    if (!room) return res.status(400).send('Room invalide');
    const users = {};
    Object.values(room.state.coinsBoard).forEach(e => { users[e.user] = { user: e.user, given: e.total, received: 0 }; });
    Object.values(room.state.redistributionBoard).forEach(e => {
        if (!users[e.user]) users[e.user] = { user: e.user, given: 0, received: 0 };
        users[e.user].received = e.total;
    });
    const sorted = Object.values(users).sort((a, b) => (b.given - b.received) - (a.given - a.received));
    let csv = 'Rang,Pseudo,Donne,Recu,Solde\n';
    sorted.forEach((e, i) => { csv += (i+1) + ',"' + e.user + '",' + e.given + ',' + e.received + ',' + (e.given-e.received) + '\n'; });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="balance.csv"');
    res.send('\uFEFF' + csv);
});

app.get('/api/export/chat/csv', (req, res) => {
    const room = getRoom(req.query.room || 'default');
    if (!room) return res.status(400).send('Room invalide');
    let csv = 'Date,Pseudo,Message\n';
    room.state.chatMessages.forEach(m => { csv += '"' + m.time + '","' + m.user + '","' + (m.comment||'').replace(/"/g,'""') + '"\n'; });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="chat.csv"');
    res.send('\uFEFF' + csv);
});

app.post('/api/reset', (req, res) => {
    const roomId = req.body.room || 'default';
    const room = getRoom(roomId);
    if (!room) return res.status(400).json({ success: false, message: 'Room invalide' });
    
    const sessions = room.state.sessions;
    room.state = createEmptyState();
    room.state.sessions = sessions;
    saveRoomState(room);
    sendToRoom(room, 'INFO', 'DATA_RESET', {});
    res.json({ success: true, message: 'Données réinitialisées' });
});

app.post('/api/import', (req, res) => {
    const roomId = req.body.room || req.query.room || 'default';
    const room = getRoom(roomId);
    if (!room) return res.status(400).json({ success: false, message: 'Room invalide' });
    
    try {
        const data = req.body;
        if (data.coinsBoard) room.state.coinsBoard = data.coinsBoard;
        if (data.likesBoard) room.state.likesBoard = data.likesBoard;
        if (data.redistributionBoard) room.state.redistributionBoard = data.redistributionBoard;
        if (data.marketingHistory) room.state.marketingHistory = data.marketingHistory;
        if (data.rewardsHistory) room.state.rewardsHistory = data.rewardsHistory;
        if (data.withdrawalsHistory) room.state.withdrawalsHistory = data.withdrawalsHistory;
        if (data.chatMessages) room.state.chatMessages = data.chatMessages;
        if (typeof data.totalCoins === 'number') room.state.totalCoins = data.totalCoins;
        if (typeof data.totalLikes === 'number') room.state.totalLikes = data.totalLikes;
        if (typeof data.totalGifts === 'number') room.state.totalGifts = data.totalGifts;
        if (typeof data.totalRedistributed === 'number') room.state.totalRedistributed = data.totalRedistributed;
        if (typeof data.totalMarketing === 'number') room.state.totalMarketing = data.totalMarketing;
        if (typeof data.totalRewards === 'number') room.state.totalRewards = data.totalRewards;
        if (typeof data.totalWithdrawals === 'number') room.state.totalWithdrawals = data.totalWithdrawals;
        if (data.viewers) room.state.viewers = data.viewers;
        saveRoomState(room);

        sendToRoom(room, 'RESTORE', null, {
            coinsBoard: room.state.coinsBoard, likesBoard: room.state.likesBoard, redistributionBoard: room.state.redistributionBoard,
            totalCoins: room.state.totalCoins, totalLikes: room.state.totalLikes, totalGifts: room.state.totalGifts,
            totalRedistributed: room.state.totalRedistributed, totalMarketing: room.state.totalMarketing, totalRewards: room.state.totalRewards, totalWithdrawals: room.state.totalWithdrawals,
            marketingHistory: room.state.marketingHistory, rewardsHistory: room.state.rewardsHistory, withdrawalsHistory: room.state.withdrawalsHistory,
            viewers: room.state.viewers, chatMessages: room.state.chatMessages.slice(-200), currentUsername: room.username
        });

        res.json({ success: true, message: 'Sauvegarde importée' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Erreur: ' + e.message });
    }
});

app.get('/api/rooms', (req, res) => {
    const list = [];
    for (const [id, room] of rooms) {
        list.push({ id, clients: room.clients.size, username: room.username, connected: !!room.connection, totalCoins: room.state.totalCoins });
    }
    res.json({ rooms: list, total: list.length });
});

// ================= DASHBOARD HTML =================
app.get('/', (req, res) => { res.send(DASHBOARD_HTML); });

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TikTok Live Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0f;--card:#12121a;--border:#1e1e2e;--pk:#fe2c55;--cy:#25f4ee;--txt:#f0f0f5;--txt2:#6e6e80;--gold:#ffd700;--green:#22c55e}
body{background:var(--bg);color:var(--txt);font-family:'Outfit',sans-serif;min-height:100vh}
.topbar{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:14px 28px;background:rgba(10,10,15,0.9);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);flex-wrap:wrap;gap:10px}
.topbar-logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px}
.topbar-logo .dot{width:10px;height:10px;border-radius:50%;background:var(--pk);animation:pulse 2s infinite}
.topbar-logo .dot.on{background:var(--cy)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}
.pk{color:var(--pk)}.cy{color:var(--cy)}
.room-badge{padding:6px 12px;border-radius:8px;background:rgba(37,244,238,.1);border:1px solid rgba(37,244,238,.2);color:var(--cy);font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600}
.cz{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.cz input{padding:10px 16px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--txt);font-family:'JetBrains Mono',monospace;font-size:13px;width:180px;outline:none}
.cz input:focus{border-color:var(--pk)}
.btn-co{padding:10px 22px;border:none;border-radius:10px;font-weight:700;font-size:13px;cursor:pointer;background:linear-gradient(135deg,var(--pk),#d6164a);color:#fff}
.btn-co:disabled{opacity:.5}
.btn-dc{padding:10px 22px;border:none;border-radius:10px;font-weight:700;font-size:13px;cursor:pointer;background:#4b5563;color:#fff}
.btn-dc:hover{background:#ef4444}
.badge{padding:6px 14px;border-radius:20px;font-size:12px;background:rgba(254,44,85,.1);color:var(--pk);border:1px solid rgba(254,44,85,.2)}
.badge.live{background:rgba(37,244,238,.1);color:var(--cy);border-color:rgba(37,244,238,.25)}
.stats-bar{display:flex;gap:16px;padding:20px 28px;overflow-x:auto;flex-wrap:wrap}
.sc{flex:1;min-width:120px;padding:16px;background:var(--card);border:1px solid var(--border);border-radius:14px}
.sc-label{font-size:10px;text-transform:uppercase;letter-spacing:1.2px;color:var(--txt2);font-weight:600}
.sc-val{font-size:26px;font-weight:800;font-family:'JetBrains Mono',monospace}
.sc-sub{font-size:12px;color:var(--green);font-family:'JetBrains Mono',monospace}
.coins{color:var(--gold)}.likes{color:var(--pk)}.viewers{color:var(--cy)}.gifts{color:#c084fc}.redist{color:var(--green)}.marketing{color:#f97316}.rewards{color:#eab308}.withdrawals{color:#ef4444}.earned{color:#06b6d4}
.ebar{display:flex;justify-content:flex-end;padding:0 28px 8px;gap:8px;flex-wrap:wrap}
.btn-eg{padding:8px 16px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.03);color:var(--txt2);font-size:12px;font-weight:600;cursor:pointer}
.btn-eg:hover{background:rgba(37,244,238,.08);color:var(--cy)}
.btn-rst{padding:8px 16px;border:1px solid rgba(254,44,85,.2);border-radius:10px;background:rgba(254,44,85,.05);color:rgba(254,44,85,.6);font-size:12px;cursor:pointer}
.btn-rst:hover{color:var(--pk)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:0 28px 28px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.panel{background:var(--card);border:1px solid var(--border);border-radius:16px;display:flex;flex-direction:column;max-height:550px;overflow:hidden}
.ph{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 12px;border-bottom:1px solid var(--border)}
.pt{font-weight:700;font-size:15px}
.pc{font-family:'JetBrains Mono',monospace;font-size:11px;padding:3px 8px;border-radius:6px;background:rgba(255,255,255,.05);color:var(--txt2)}
.sb{padding:12px 16px}
.si{width:100%;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--txt);font-size:13px;outline:none}
.ll{flex:1;overflow-y:auto;padding:4px 8px 12px}
.ll::-webkit-scrollbar{width:4px}.ll::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
.lr{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px}
.lr:hover{background:rgba(255,255,255,.03)}
.lrk{width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;font-family:'JetBrains Mono',monospace;border-radius:8px;background:rgba(255,255,255,.04);color:var(--txt2)}
.lrk.g{background:rgba(255,215,0,.15);color:var(--gold)}.lrk.s{background:rgba(192,192,192,.12);color:#c0c0c0}.lrk.b{background:rgba(205,127,50,.12);color:#cd7f32}
.lav{width:38px;height:38px;border-radius:50%;object-fit:cover;border:2px solid var(--border);background:var(--card)}
.li{flex:1;min-width:0}.ln{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ls{font-size:11px;color:var(--txt2)}
.lv{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:14px;text-align:right}
.lv .dollar{font-size:11px;color:var(--green)}
.cl{flex:1;overflow-y:auto;padding:8px 12px}
.cm{display:flex;gap:10px;padding:8px 10px;border-radius:10px}
.cm:hover{background:rgba(255,255,255,.03)}
.ca{width:32px;height:32px;border-radius:50%;object-fit:cover;background:var(--card)}
.cc{flex:1}.cu{font-weight:600;font-size:13px;color:var(--cy)}.ct{font-size:13px;opacity:.85}.ctm{font-size:10px;color:var(--txt2)}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;color:var(--txt2);text-align:center;gap:8px;flex:1}
.empty .ei{font-size:32px;opacity:.5}
.toast{position:fixed;bottom:20px;right:20px;padding:10px 18px;border-radius:10px;font-size:12px;opacity:0;transform:translateY(10px);transition:.3s;z-index:200}
.toast.show{opacity:1;transform:translateY(0)}
.toast.success{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);color:var(--green)}
.toast.error{background:rgba(254,44,85,.1);border:1px solid rgba(254,44,85,.2);color:var(--pk)}
.redist-form{padding:12px 16px;border-bottom:1px solid var(--border)}
.rf-search-wrap{position:relative;margin-bottom:10px}
.rf-results{position:absolute;top:100%;left:0;right:0;background:var(--card);border:1px solid var(--border);border-radius:10px;max-height:200px;overflow-y:auto;z-index:30;display:none}
.rf-results.open{display:block}
.rf-item{display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer}
.rf-item:hover{background:rgba(255,255,255,.05)}
.rf-item img{width:28px;height:28px;border-radius:50%}
.rf-selected{display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(37,244,238,.05);border:1px solid rgba(37,244,238,.15);border-radius:10px;margin-bottom:10px}
.rf-selected img{width:32px;height:32px;border-radius:50%}
.rf-selected .name{flex:1;font-weight:600}
.rf-selected .rf-clear{background:none;border:none;color:var(--pk);cursor:pointer;font-size:16px;padding:4px 8px}
.rf-row{display:flex;gap:8px}
.rf-row input{flex:1;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--txt);font-family:'JetBrains Mono',monospace;font-size:13px;outline:none}
.btn-send{padding:10px 18px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--green),#16a34a);color:#fff;font-weight:700;font-size:13px;cursor:pointer}
.mkt-form,.rwd-form,.wdr-form{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:8px}
.mkt-row,.rwd-row,.wdr-row{display:flex;gap:8px}
.mkt-input,.rwd-input,.wdr-input{flex:1;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--txt);font-family:'JetBrains Mono',monospace;font-size:13px;outline:none}
.mkt-input-text,.rwd-input-text,.wdr-input-text{flex:1;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--txt);font-size:13px;outline:none}
.btn-mkt{padding:10px 18px;border:none;border-radius:10px;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;font-weight:700;cursor:pointer}
.btn-rwd{padding:10px 18px;border:none;border-radius:10px;background:linear-gradient(135deg,#eab308,#ca8a04);color:#fff;font-weight:700;cursor:pointer}
.btn-wdr{padding:10px 18px;border:none;border-radius:10px;background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;font-weight:700;cursor:pointer}
.mkt-entry,.rwd-entry,.wdr-entry{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px}
.mkt-entry:hover,.rwd-entry:hover,.wdr-entry:hover{background:rgba(255,255,255,.03)}
.mkt-icon,.rwd-icon,.wdr-icon{width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:10px;font-size:16px}
.mkt-icon{background:rgba(249,115,22,.1)}.rwd-icon{background:rgba(234,179,8,.1)}.wdr-icon{background:rgba(239,68,68,.1)}
.mkt-info,.rwd-info,.wdr-info{flex:1}
.mkt-amount{font-weight:700;color:#f97316;font-family:'JetBrains Mono',monospace}
.rwd-amount{font-weight:700;color:#eab308;font-family:'JetBrains Mono',monospace}
.wdr-amount{font-weight:700;color:#ef4444;font-family:'JetBrains Mono',monospace}
.mkt-comment,.rwd-reason,.wdr-reason{font-size:12px;color:var(--txt2)}
.mkt-date,.rwd-date,.wdr-date{font-size:11px;color:var(--txt2)}
.mkt-val,.rwd-val,.wdr-val{font-family:'JetBrains Mono',monospace;font-weight:700;color:var(--green)}
.bal-row{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px}
.bal-row:hover{background:rgba(255,255,255,.03)}
.bal-vals{text-align:right;font-family:'JetBrains Mono',monospace}
.bal-given{font-size:12px;color:var(--gold)}
.bal-received{font-size:12px;color:var(--green)}
.bal-net{font-size:14px;font-weight:700}
.bal-net.positive{color:var(--pk)}
.bal-net.negative{color:var(--green)}
.bal-tag{font-size:9px;font-weight:700;text-transform:uppercase;padding:2px 6px;border-radius:4px;margin-left:6px}
.bal-tag.owes{background:rgba(254,44,85,.12);color:var(--pk)}
.bal-tag.owed{background:rgba(34,197,94,.12);color:var(--green)}
</style>
</head>
<body>
<div class="topbar">
    <div class="topbar-logo"><div class="dot" id="dot"></div><span>Tik<span class="pk">Tok</span> <span class="cy">Live</span></span></div>
    <div class="room-badge" id="roomBadge">Room: ---</div>
    <div class="cz">
        <div class="badge" id="badge"><span id="stxt">Déconnecté</span></div>
        <input type="text" id="username" placeholder="@pseudo_en_live" spellcheck="false"/>
        <button class="btn-co" id="btnCo" onclick="doConnect()">Connexion</button>
        <button class="btn-dc" id="btnDc" onclick="doDisconnect()" style="display:none;">Déconnexion</button>
    </div>
</div>
<div class="stats-bar">
    <div class="sc"><div class="sc-label">Total Pièces</div><div class="sc-val coins" id="sCoins">0</div><div class="sc-sub" id="sCoinsDol">= $0.00</div></div>
    <div class="sc"><div class="sc-label">Redistribué</div><div class="sc-val redist" id="sRedist">0</div><div class="sc-sub" id="sRedistDol">= $0.00</div></div>
    <div class="sc"><div class="sc-label">Marketing</div><div class="sc-val marketing" id="sMarketing">0</div><div class="sc-sub" id="sMarketingDol">= $0.00</div></div>
    <div class="sc"><div class="sc-label">Récompenses</div><div class="sc-val rewards" id="sRewards">0</div><div class="sc-sub" id="sRewardsDol">= $0.00</div></div>
    <div class="sc"><div class="sc-label">Retraits</div><div class="sc-val withdrawals" id="sWithdrawals">0</div><div class="sc-sub" id="sWithdrawalsDol">= $0.00</div></div>
    <div class="sc" style="border:1px solid rgba(37,244,238,.25)"><div class="sc-label">Total Gagné</div><div class="sc-val earned" id="sEarned">0</div><div class="sc-sub" id="sEarnedDol">= $0.00</div></div>
    <div class="sc"><div class="sc-label">Likes</div><div class="sc-val likes" id="sLikes">0</div></div>
    <div class="sc"><div class="sc-label">Viewers</div><div class="sc-val viewers" id="sViewers">0</div></div>
    <div class="sc"><div class="sc-label">Cadeaux</div><div class="sc-val gifts" id="sGifts">0</div></div>
</div>
<div class="ebar">
    <button class="btn-eg" onclick="window.open('/api/export/all?room='+ROOM)">📦 Export</button>
    <button class="btn-eg" onclick="document.getElementById('importFileInput').click()">📥 Import</button>
    <input type="file" id="importFileInput" accept=".json" style="display:none" onchange="importSave(event)">
    <button class="btn-rst" onclick="resetData()">🗑 Reset</button>
</div>
<div class="grid">
    <div class="panel"><div class="ph"><div class="pt">💰 Pièces</div><div class="pc" id="cCoins">0</div></div><div class="sb"><input class="si" placeholder="Rechercher..." oninput="filterLB('coins',this.value)"/></div><div class="ll" id="lbCoins"><div class="empty"><div class="ei">🎁</div></div></div></div>
    <div class="panel"><div class="ph"><div class="pt">❤️ Likes</div><div class="pc" id="cLikes">0</div></div><div class="sb"><input class="si" placeholder="Rechercher..." oninput="filterLB('likes',this.value)"/></div><div class="ll" id="lbLikes"><div class="empty"><div class="ei">❤️</div></div></div></div>
    <div class="panel"><div class="ph"><div class="pt">💸 Redistribution</div><div class="pc" id="cRedist">0</div></div>
        <div class="redist-form"><div class="rf-search-wrap"><input class="si" id="rfSearch" placeholder="Chercher viewer..." oninput="searchViewers(this.value)" autocomplete="off"/><div class="rf-results" id="rfResults"></div></div><div id="rfSelected" style="display:none" class="rf-selected"><img id="rfSelPic" src="" onerror="this.style.display='none'"/><span class="name" id="rfSelName"></span><button class="rf-clear" onclick="clearSelection()">✕</button></div><div class="rf-row"><input type="number" id="rfAmount" placeholder="Pièces" min="1"/><button class="btn-send" onclick="sendRedist()">Envoyer</button></div></div>
        <div class="sb"><input class="si" placeholder="Rechercher..." oninput="filterLB('redist',this.value)"/></div><div class="ll" id="lbRedist"><div class="empty"><div class="ei">💸</div></div></div></div>
    <div class="panel"><div class="ph"><div class="pt">⚖️ Balance</div><div class="pc" id="cBalance">0</div></div><div class="sb"><input class="si" placeholder="Rechercher..." oninput="filterLB('balance',this.value)"/></div><div class="ll" id="lbBalance"><div class="empty"><div class="ei">⚖️</div></div></div></div>
    <div class="panel"><div class="ph"><div class="pt">📢 Marketing</div><div class="pc" id="cMarketing">0</div></div>
        <div class="mkt-form"><div class="mkt-row"><input type="number" id="mktAmount" placeholder="Pièces" class="mkt-input"/></div><div class="mkt-row"><input type="text" id="mktComment" placeholder="Commentaire" class="mkt-input-text"/><button class="btn-mkt" onclick="sendMarketing()">+ Ajouter</button></div></div>
        <div class="ll" id="lbMarketing"><div class="empty"><div class="ei">📢</div></div></div></div>
    <div class="panel"><div class="ph"><div class="pt">🏆 Récompenses</div><div class="pc" id="cRewards">0</div></div>
        <div class="rwd-form"><div class="rwd-row"><input type="text" id="rwdReason" placeholder="Raison" class="rwd-input-text"/></div><div class="rwd-row"><input type="number" id="rwdAmount" placeholder="Pièces" class="rwd-input"/><button class="btn-rwd" onclick="sendReward()">+ Ajouter</button></div></div>
        <div class="ll" id="lbRewards"><div class="empty"><div class="ei">🏆</div></div></div></div>
    <div class="panel"><div class="ph"><div class="pt">🏧 Retraits</div><div class="pc" id="cWithdrawals">0</div></div>
        <div class="wdr-form"><div class="wdr-row"><input type="text" id="wdrReason" placeholder="Raison" class="wdr-input-text"/></div><div class="wdr-row"><input type="number" id="wdrAmount" placeholder="Pièces" class="wdr-input"/><button class="btn-wdr" onclick="sendWithdrawal()">+ Ajouter</button></div></div>
        <div class="ll" id="lbWithdrawals"><div class="empty"><div class="ei">🏧</div></div></div></div>
    <div class="panel"><div class="ph"><div class="pt">💬 Chat</div><div class="pc" id="cChat">0</div></div><div class="cl" id="chatList"><div class="empty"><div class="ei">💬</div></div></div></div>
</div>
<script>
var params=new URLSearchParams(window.location.search);
var ROOM=params.get('room')||'default';
if(ROOM.length<3){ROOM='room_'+Math.random().toString(36).substr(2,8);history.replaceState(null,'','?room='+ROOM);}
document.getElementById('roomBadge').textContent='Room: '+ROOM;

var S={coinsBoard:{},likesBoard:{},redistributionBoard:{},marketingHistory:[],rewardsHistory:[],withdrawalsHistory:[],chatMessages:[],totalCoins:0,totalLikes:0,totalGifts:0,totalRedistributed:0,totalMarketing:0,totalRewards:0,totalWithdrawals:0,viewers:new Set(),connected:false,filters:{coins:'',likes:'',redist:'',balance:''},selectedUser:null};

var ws,wrt;
function initWS(){var wsProto=location.protocol==='https:'?'wss://':'ws://';ws=new WebSocket(wsProto+location.host+'/?room='+ROOM);ws.onmessage=function(e){try{handle(JSON.parse(e.data))}catch(x){}};ws.onclose=function(){clearTimeout(wrt);wrt=setTimeout(initWS,3000)};ws.onerror=function(){ws.close()};}

function handle(m){
    if(m.type==='RESTORE'&&m.data){var d=m.data;S.coinsBoard=d.coinsBoard||{};S.likesBoard=d.likesBoard||{};S.redistributionBoard=d.redistributionBoard||{};S.totalCoins=d.totalCoins||0;S.totalLikes=d.totalLikes||0;S.totalGifts=d.totalGifts||0;S.totalRedistributed=d.totalRedistributed||0;S.totalMarketing=d.totalMarketing||0;S.marketingHistory=d.marketingHistory||[];S.totalRewards=d.totalRewards||0;S.rewardsHistory=d.rewardsHistory||[];S.totalWithdrawals=d.totalWithdrawals||0;S.withdrawalsHistory=d.withdrawalsHistory||[];S.viewers=new Set(d.viewers||[]);if(d.chatMessages){S.chatMessages=d.chatMessages.map(function(c){return{user:c.user,profilePictureUrl:c.profilePictureUrl||'',comment:c.comment,time:c.time?new Date(c.time).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}):''};});renderChat();}if(d.currentUsername)document.getElementById('username').value=d.currentUsername;updStats();renderLB('coins');renderLB('likes');renderLB('redist');renderBalance();renderMarketing();renderRewards();renderWithdrawals();return;}
    if(m.type==='INFO'){if(m.action==='TIKTOK_CONNECTED'){setConn(true,m.data.username);if(m.data.reconnected)toast('success','✅ Reconnecté');}if(m.action==='STREAM_ENDED')setConn(false);if(m.action==='RECONNECTING')toast('reconnect','🔄 Reconnexion '+m.data.attempt+'/'+m.data.maxAttempts);if(m.action==='DATA_RESET'){S.coinsBoard={};S.likesBoard={};S.redistributionBoard={};S.marketingHistory=[];S.rewardsHistory=[];S.withdrawalsHistory=[];S.chatMessages=[];S.totalCoins=0;S.totalLikes=0;S.totalGifts=0;S.totalRedistributed=0;S.totalMarketing=0;S.totalRewards=0;S.totalWithdrawals=0;S.viewers=new Set();updStats();renderLB('coins');renderLB('likes');renderLB('redist');renderBalance();renderMarketing();renderRewards();renderWithdrawals();renderChat();toast('success','✅ Reset');}if(m.action==='REDISTRIBUTION_UPDATE'){S.redistributionBoard=m.data.redistributionBoard||{};S.totalRedistributed=m.data.totalRedistributed||0;updStats();renderLB('redist');renderBalance();}if(m.action==='MARKETING_UPDATE'){S.marketingHistory=m.data.marketingHistory||[];S.totalMarketing=m.data.totalMarketing||0;updStats();renderMarketing();}if(m.action==='REWARDS_UPDATE'){S.rewardsHistory=m.data.rewardsHistory||[];S.totalRewards=m.data.totalRewards||0;updStats();renderRewards();}if(m.action==='WITHDRAWALS_UPDATE'){S.withdrawalsHistory=m.data.withdrawalsHistory||[];S.totalWithdrawals=m.data.totalWithdrawals||0;updStats();renderWithdrawals();}}
    if(m.type==='ERROR')setConn(false);
    if(m.type==='ACTION'){if(m.action==='shoot_balloon')onGift(m.data);if(m.action==='like')onLike(m.data);if(m.action==='chat')onChat(m.data);}
}

function onGift(d){var u=d.user;S.viewers.add(u);if(!S.coinsBoard[u])S.coinsBoard[u]={user:u,profilePictureUrl:d.profilePictureUrl,total:0,gifts:{}};S.coinsBoard[u].total+=d.diamondCount;var g=d.giftName||'Cadeau';S.coinsBoard[u].gifts[g]=(S.coinsBoard[u].gifts[g]||0)+1;S.totalCoins+=d.diamondCount;S.totalGifts++;updStats();renderLB('coins');renderBalance();}
function onLike(d){var u=d.user;S.viewers.add(u);if(!S.likesBoard[u])S.likesBoard[u]={user:u,profilePictureUrl:d.profilePictureUrl,total:0};S.likesBoard[u].total+=d.count;S.totalLikes+=d.count;updStats();renderLB('likes');}
function onChat(d){S.viewers.add(d.user);S.chatMessages.push({user:d.user,profilePictureUrl:d.profilePictureUrl,comment:d.comment,time:new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})});if(S.chatMessages.length>200)S.chatMessages=S.chatMessages.slice(-200);updStats();renderChat();}

function fmt(n){if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return n.toString();}
function toDol(n){return(n/250).toFixed(2);}
function toRedistDol(n){return(n/100).toFixed(2);}
function esc(t){var d=document.createElement('div');d.textContent=t;return d.innerHTML;}
function safePic(url){if(!url)return'';if(url.indexOf('http')===0)return esc(url);return'';}
function rkCls(i){return i===0?'g':i===1?'s':i===2?'b':'';}

function updStats(){
    document.getElementById('sCoins').textContent=fmt(S.totalCoins);document.getElementById('sCoinsDol').textContent='= $'+toDol(S.totalCoins);
    document.getElementById('sRedist').textContent=fmt(S.totalRedistributed);document.getElementById('sRedistDol').textContent='= $'+toRedistDol(S.totalRedistributed);
    document.getElementById('sLikes').textContent=fmt(S.totalLikes);document.getElementById('sViewers').textContent=S.viewers.size;document.getElementById('sGifts').textContent=fmt(S.totalGifts);
    document.getElementById('sMarketing').textContent=fmt(S.totalMarketing);document.getElementById('sMarketingDol').textContent='= $'+toRedistDol(S.totalMarketing);
    document.getElementById('sRewards').textContent=fmt(S.totalRewards);document.getElementById('sRewardsDol').textContent='= $'+toRedistDol(S.totalRewards);
    document.getElementById('sWithdrawals').textContent=fmt(S.totalWithdrawals);document.getElementById('sWithdrawalsDol').textContent='= $'+toRedistDol(S.totalWithdrawals);
    var earnedPieces=S.totalCoins+S.totalRewards-S.totalRedistributed;var earnedDol=(S.totalCoins/250)+(S.totalRewards/100)-(S.totalRedistributed/100);
    document.getElementById('sEarned').textContent=(earnedPieces<0?'-':'')+fmt(Math.abs(earnedPieces));document.getElementById('sEarned').style.color=earnedPieces>=0?'#22c55e':'#ef4444';
    document.getElementById('sEarnedDol').textContent='= $'+Math.abs(earnedDol).toFixed(2);document.getElementById('sEarnedDol').style.color=earnedDol>=0?'#22c55e':'#ef4444';
}

function renderLB(type){var board=type==='coins'?S.coinsBoard:type==='likes'?S.likesBoard:S.redistributionBoard;var el=document.getElementById('lb'+type.charAt(0).toUpperCase()+type.slice(1));var cntEl=document.getElementById('c'+type.charAt(0).toUpperCase()+type.slice(1));var f=S.filters[type].toLowerCase();var all=Object.values(board).sort(function(a,b){return b.total-a.total});cntEl.textContent=all.length;var entries=f?all.filter(function(e){return e.user.toLowerCase().indexOf(f)!==-1}):all;if(entries.length===0){el.innerHTML='<div class="empty"><div class="ei">'+(type==='coins'?'🎁':type==='likes'?'❤️':'💸')+'</div></div>';return;}var h='';entries.forEach(function(e){var rank=all.findIndex(function(x){return x.user===e.user});var rc=rkCls(rank);h+='<div class="lr"><div class="lrk '+rc+'">'+(rank+1)+'</div><img class="lav" src="'+safePic(e.profilePictureUrl)+'" onerror="this.style.display=\\'none\\'"/><div class="li"><div class="ln">@'+esc(e.user)+'</div></div><div class="lv"><div>'+fmt(e.total)+'</div>'+(type!=='likes'?'<div class="dollar">$'+(type==='redist'?toRedistDol(e.total):toDol(e.total))+'</div>':'')+'</div></div>';});el.innerHTML=h;}

function renderBalance(){var el=document.getElementById('lbBalance');var cntEl=document.getElementById('cBalance');var f=S.filters.balance.toLowerCase();var users={};Object.values(S.coinsBoard).forEach(function(e){users[e.user]={user:e.user,profilePictureUrl:e.profilePictureUrl||'',given:e.total,received:0};});Object.values(S.redistributionBoard).forEach(function(e){if(!users[e.user])users[e.user]={user:e.user,profilePictureUrl:e.profilePictureUrl||'',given:0,received:0};users[e.user].received=e.total;});var all=Object.values(users).filter(function(u){return u.given>0||u.received>0}).sort(function(a,b){return(b.given-b.received)-(a.given-a.received)});cntEl.textContent=all.length;var entries=f?all.filter(function(e){return e.user.toLowerCase().indexOf(f)!==-1}):all;if(entries.length===0){el.innerHTML='<div class="empty"><div class="ei">⚖️</div></div>';return;}var h='';entries.forEach(function(e,i){var net=e.given-e.received;var netCls=net>0?'positive':net<0?'negative':'';var tagCls=net>0?'owes':net<0?'owed':'';var tagTxt=net>0?'Te doit':net<0?'Tu dois':'';h+='<div class="bal-row"><div class="lrk">'+(i+1)+'</div><img class="lav" src="'+safePic(e.profilePictureUrl)+'" onerror="this.style.display=\\'none\\'"/><div class="li"><div class="ln">@'+esc(e.user)+(tagTxt?' <span class="bal-tag '+tagCls+'">'+tagTxt+'</span>':'')+'</div></div><div class="bal-vals"><div class="bal-given">▲ '+fmt(e.given)+'</div><div class="bal-received">▼ '+fmt(e.received)+'</div><div class="bal-net '+netCls+'">$'+Math.abs(e.given/250-e.received/100).toFixed(2)+'</div></div></div>';});el.innerHTML=h;}

function renderChat(){var el=document.getElementById('chatList');document.getElementById('cChat').textContent=S.chatMessages.length;var msgs=S.chatMessages.slice(-50);var h='';msgs.forEach(function(m){h+='<div class="cm"><img class="ca" src="'+safePic(m.profilePictureUrl)+'" onerror="this.style.display=\\'none\\'"/><div class="cc"><div class="cu">@'+esc(m.user)+'</div><div class="ct">'+esc(m.comment)+'</div><div class="ctm">'+esc(m.time)+'</div></div></div>';});el.innerHTML=h;el.scrollTop=el.scrollHeight;}

function renderMarketing(){var el=document.getElementById('lbMarketing');var cntEl=document.getElementById('cMarketing');var hist=S.marketingHistory||[];cntEl.textContent=hist.length;if(hist.length===0){el.innerHTML='<div class="empty"><div class="ei">📢</div></div>';return;}var h='';hist.slice().reverse().forEach(function(e){var d=e.date?new Date(e.date).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'';h+='<div class="mkt-entry"><div class="mkt-icon">📢</div><div class="mkt-info"><div class="mkt-amount">+'+fmt(e.amount)+'</div>'+(e.comment?'<div class="mkt-comment">'+esc(e.comment)+'</div>':'')+'<div class="mkt-date">'+esc(d)+'</div></div><div class="mkt-val">$'+toRedistDol(e.amount)+'</div></div>';});el.innerHTML=h;}
function renderRewards(){var el=document.getElementById('lbRewards');var cntEl=document.getElementById('cRewards');var hist=S.rewardsHistory||[];cntEl.textContent=hist.length;if(hist.length===0){el.innerHTML='<div class="empty"><div class="ei">🏆</div></div>';return;}var h='';hist.slice().reverse().forEach(function(e){var d=e.date?new Date(e.date).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'';h+='<div class="rwd-entry"><div class="rwd-icon">🏆</div><div class="rwd-info"><div class="rwd-amount">+'+fmt(e.amount)+'</div><div class="rwd-reason">'+esc(e.reason)+'</div><div class="rwd-date">'+esc(d)+'</div></div><div class="rwd-val">$'+toRedistDol(e.amount)+'</div></div>';});el.innerHTML=h;}
function renderWithdrawals(){var el=document.getElementById('lbWithdrawals');var cntEl=document.getElementById('cWithdrawals');var hist=S.withdrawalsHistory||[];cntEl.textContent=hist.length;if(hist.length===0){el.innerHTML='<div class="empty"><div class="ei">🏧</div></div>';return;}var h='';hist.slice().reverse().forEach(function(e){var d=e.date?new Date(e.date).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'';h+='<div class="wdr-entry"><div class="wdr-icon">🏧</div><div class="wdr-info"><div class="wdr-amount">-'+fmt(e.amount)+'</div><div class="wdr-reason">'+esc(e.reason)+'</div><div class="wdr-date">'+esc(d)+'</div></div><div class="wdr-val">$'+toRedistDol(e.amount)+'</div></div>';});el.innerHTML=h;}

function filterLB(t,v){S.filters[t]=v;if(t==='balance')renderBalance();else renderLB(t);}

function setConn(on,user){S.connected=on;var dot=document.getElementById('dot'),badge=document.getElementById('badge'),st=document.getElementById('stxt'),btnCo=document.getElementById('btnCo'),btnDc=document.getElementById('btnDc');if(on){dot.classList.add('on');badge.classList.add('live');st.textContent='🔴 @'+user;btnCo.style.display='none';btnDc.style.display='inline-block';}else{dot.classList.remove('on');badge.classList.remove('live');st.textContent='Déconnecté';btnCo.style.display='inline-block';btnCo.textContent='Connexion';btnCo.disabled=false;btnDc.style.display='none';}}

function doConnect(){var inp=document.getElementById('username'),btn=document.getElementById('btnCo'),u=inp.value.trim();if(!u){inp.focus();return;}btn.disabled=true;btn.textContent='...';fetch('/connect?username='+encodeURIComponent(u)+'&room='+ROOM).then(function(r){return r.json()}).then(function(d){if(!d.success){setConn(false);document.getElementById('stxt').textContent=d.message||'Erreur';}}).catch(function(){setConn(false);btn.disabled=false;btn.textContent='Connexion';});}
function doDisconnect(){var btn=document.getElementById('btnDc');btn.disabled=true;fetch('/disconnect?room='+ROOM).then(function(r){return r.json()}).then(function(d){toast(d.success?'success':'error',d.message||'OK');setConn(false);}).catch(function(){setConn(false);});}
document.getElementById('username').addEventListener('keydown',function(e){if(e.key==='Enter')doConnect();});

function searchViewers(q){var res=document.getElementById('rfResults');if(!q||q.length<1){res.classList.remove('open');return;}q=q.toLowerCase().replace('@','');var all={};Object.values(S.coinsBoard).forEach(function(e){all[e.user]=e.profilePictureUrl||'';});Object.values(S.likesBoard).forEach(function(e){if(!all[e.user])all[e.user]=e.profilePictureUrl||'';});S.viewers.forEach(function(v){if(!all[v])all[v]='';});var matches=Object.keys(all).filter(function(u){return u.toLowerCase().indexOf(q)!==-1}).slice(0,8);if(matches.length===0){res.classList.remove('open');return;}var h='';matches.forEach(function(u){h+='<div class="rf-item" onclick="selectViewer(\\''+esc(u)+'\\',\\''+safePic(all[u])+'\\')"><img src="'+safePic(all[u])+'" onerror="this.style.display=\\'none\\'"/><span>@'+esc(u)+'</span></div>';});res.innerHTML=h;res.classList.add('open');}
function selectViewer(user,pic){S.selectedUser=user;document.getElementById('rfSearch').style.display='none';document.getElementById('rfResults').classList.remove('open');document.getElementById('rfSelected').style.display='flex';document.getElementById('rfSelName').textContent='@'+user;var img=document.getElementById('rfSelPic');img.src=pic||'';img.style.display=pic?'block':'none';document.getElementById('rfAmount').focus();}
function clearSelection(){S.selectedUser=null;document.getElementById('rfSelected').style.display='none';document.getElementById('rfSearch').style.display='block';document.getElementById('rfSearch').value='';}
function sendRedist(){if(!S.selectedUser){toast('error','Sélectionne un viewer');return;}var amount=parseInt(document.getElementById('rfAmount').value);if(!amount||amount<=0){toast('error','Montant invalide');return;}fetch('/api/redistribute',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:S.selectedUser,amount:amount,room:ROOM})}).then(function(r){return r.json()}).then(function(d){if(d.success){toast('success','✅ '+amount+' → @'+S.selectedUser);document.getElementById('rfAmount').value='';clearSelection();}else{toast('error',d.message);}}).catch(function(){toast('error','Erreur');});}

function sendMarketing(){var amount=parseInt(document.getElementById('mktAmount').value);if(!amount||amount<=0){toast('error','Montant invalide');return;}var comment=document.getElementById('mktComment').value.trim();fetch('/api/marketing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:amount,comment:comment,mktType:'Manuel',room:ROOM})}).then(function(r){return r.json()}).then(function(d){if(d.success){toast('success','📢 +'+amount);document.getElementById('mktAmount').value='';document.getElementById('mktComment').value='';}else{toast('error',d.message);}}).catch(function(){toast('error','Erreur');});}
function sendReward(){var reason=document.getElementById('rwdReason').value.trim();var amount=parseInt(document.getElementById('rwdAmount').value);if(!reason){toast('error','Raison requise');return;}if(!amount||amount<=0){toast('error','Montant invalide');return;}fetch('/api/rewards',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:amount,reason:reason,room:ROOM})}).then(function(r){return r.json()}).then(function(d){if(d.success){toast('success','🏆 +'+amount);document.getElementById('rwdAmount').value='';document.getElementById('rwdReason').value='';}else{toast('error',d.message);}}).catch(function(){toast('error','Erreur');});}
function sendWithdrawal(){var reason=document.getElementById('wdrReason').value.trim();var amount=parseInt(document.getElementById('wdrAmount').value);if(!reason){toast('error','Raison requise');return;}if(!amount||amount<=0){toast('error','Montant invalide');return;}fetch('/api/withdrawals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:amount,reason:reason,room:ROOM})}).then(function(r){return r.json()}).then(function(d){if(d.success){toast('success','🏧 +'+amount);document.getElementById('wdrAmount').value='';document.getElementById('wdrReason').value='';}else{toast('error',d.message);}}).catch(function(){toast('error','Erreur');});}

function resetData(){if(!confirm('Réinitialiser cette room ?'))return;fetch('/api/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:ROOM})}).then(function(r){return r.json()}).then(function(d){if(d.success)toast('success','✅ Reset');}).catch(function(){toast('error','Erreur');});}
function importSave(event){var file=event.target.files[0];if(!file)return;var reader=new FileReader();reader.onload=function(e){try{var data=JSON.parse(e.target.result);data.room=ROOM;if(!confirm('Importer ?'))return;fetch('/api/import?room='+ROOM,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(function(r){return r.json()}).then(function(d){if(d.success){toast('success','Importé');setTimeout(function(){location.reload();},1000);}else{toast('error',d.message);}}).catch(function(){toast('error','Erreur');});}catch(err){toast('error','JSON invalide');}};reader.readAsText(file);event.target.value='';}

function toast(type,msg){var t=document.getElementById('dToast');if(!t){t=document.createElement('div');t.id='dToast';t.className='toast';document.body.appendChild(t);}t.className='toast '+type;t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2500);}

initWS();
</script>
</body>
</html>`;

// ================= DÉMARRAGE =================
server.listen(PORT, '0.0.0.0', () => {
    console.log('=========================================');
    if (IS_RAILWAY) {
        console.log('🚀 SERVEUR RAILWAY MULTI-SESSIONS PRÊT');
        console.log('🌐 URL : https://' + (process.env.RAILWAY_PUBLIC_DOMAIN || 'ton-app.up.railway.app'));
        console.log('🏠 Rooms : Isolation par ?room=XXX');
    } else {
        console.log('🚀 SERVEUR LOCAL MULTI-SESSIONS : http://localhost:' + PORT);
        console.log('🏠 Rooms : Isolation par ?room=XXX');
    }
    console.log('=========================================');
});
