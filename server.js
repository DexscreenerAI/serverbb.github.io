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

// PINs de protection par room (7777 par défaut)
const ROOM_PINS = { 'room_1': '0104', 'room_2': '1986', 'room_3': '2211', 'room_10': '0910', 'room_13': '0102', 'room_15': '0095', 'room_18': '2026', 'room_19': '1203', 'room_20': '0410' };
const DEFAULT_PIN = '7777';
const RECONNECT_DELAY_MS = 5000;
const TOTAL_ROOMS = 20;

// ================= CONFIG FIVEM =================
const FIVEM_API_BASE = 'http://109.205.8.57:9999';
const FIVEM_JOIN_LINK = 'fivem://connect/cfx.re/join/ylmo5k';
const CFX_CODE = 'ylmo5k';

let actionsConfig = {};
const ACTIONS_CONFIG_FILE = path.join(DATA_DIR, 'fivem_actions.json');

const AVAILABLE_ACTIONS = [
    { id: 'vehicle_panto', name: '🚗 Panto', type: 'vehicle', model: 'panto' },
    { id: 'vehicle_adder', name: '🏎️ Adder (Supercar)', type: 'vehicle', model: 'adder' },
    { id: 'vehicle_zentorno', name: '🏎️ Zentorno', type: 'vehicle', model: 'zentorno' },
    { id: 'vehicle_insurgent', name: '🚙 Insurgent', type: 'vehicle', model: 'insurgent' },
    { id: 'vehicle_dump', name: '🚛 Dump (Camion géant)', type: 'vehicle', model: 'dump' },
    { id: 'vehicle_blazer', name: '🏍️ Blazer (Quad)', type: 'vehicle', model: 'blazer' },
    { id: 'vehicle_bmx', name: '🚲 BMX', type: 'vehicle', model: 'bmx' },
    { id: 'vehicle_buzzard', name: '🚁 Buzzard (Hélico)', type: 'vehicle', model: 'buzzard' },
    { id: 'vehicle_hydra', name: '✈️ Hydra (Jet)', type: 'vehicle', model: 'hydra' },
    { id: 'vehicle_rhino', name: '🛡️ Rhino (Tank)', type: 'vehicle', model: 'rhino' },
    { id: 'vehicle_bati', name: '🏍️ Bati 801', type: 'vehicle', model: 'bati' },
    { id: 'vehicle_faggio', name: '🛵 Faggio', type: 'vehicle', model: 'faggio' },
    { id: 'vehicle_bus', name: '🚌 Bus', type: 'vehicle', model: 'bus' },
    { id: 'vehicle_stretch', name: '🚗 Limousine', type: 'vehicle', model: 'stretch' },
    { id: 'vehicle_monster', name: '🚗 Monster Truck', type: 'vehicle', model: 'monster' },
    { id: 'action_superjump', name: '🚀 Super Jump', type: 'action', endpoint: '/SuperJump' },
    { id: 'action_resetrampe', name: '🔄 Reset Rampe', type: 'action', endpoint: '/ResetRampe' },
    { id: 'action_tptop', name: '⬆️ TP Top Rampe', type: 'action', endpoint: '/RampeTpTop' },
    { id: 'action_spawnmoto', name: '🏍️ Spawn Moto Rampe', type: 'action', endpoint: '/RampeSpawnMoto' },
    { id: 'prop_barrel', name: '🛢️ Baril explosif', type: 'prop', model: 'prop_barrel_exp_01a' },
    { id: 'prop_cone', name: '🔶 Cône', type: 'prop', model: 'prop_roadcone02a' },
    { id: 'prop_ramp', name: '📐 Rampe', type: 'prop', model: 'prop_mp_ramp_01' },
    { id: 'prop_ball', name: '⚽ Ballon', type: 'prop', model: 'prop_beach_ball_01' },
    { id: 'prop_tire', name: '🛞 Pneu', type: 'prop', model: 'prop_wheel_01' },
];

const TIKTOK_GIFTS = [
    { id: 'rose', name: '🌹 Rose', diamonds: 1 },
    { id: 'tiktok', name: '✨ TikTok', diamonds: 1 },
    { id: 'heart', name: '❤️ Cœur', diamonds: 5 },
    { id: 'ice_cream', name: '🍦 Glace', diamonds: 1 },
    { id: 'finger_heart', name: '🫰 Finger Heart', diamonds: 5 },
    { id: 'weights', name: '🏋️ Haltères', diamonds: 1 },
    { id: 'perfume', name: '💐 Parfum', diamonds: 20 },
    { id: 'doughnut', name: '🍩 Donut', diamonds: 30 },
    { id: 'gamepad', name: '🎮 Gamepad', diamonds: 10 },
    { id: 'cap', name: '🧢 Casquette', diamonds: 99 },
    { id: 'hand_heart', name: '💕 Hand Heart', diamonds: 100 },
    { id: 'paper_crane', name: '🦢 Paper Crane', diamonds: 99 },
    { id: 'tiny_diny', name: '🦖 Tiny Diny', diamonds: 5 },
    { id: 'star', name: '⭐ Étoile', diamonds: 99 },
    { id: 'love_you', name: '💗 Love You', diamonds: 25 },
    { id: 'corgi', name: '🐕 Corgi', diamonds: 30 },
    { id: 'duck', name: '🦆 Canard', diamonds: 1 },
    { id: 'birthday_cake', name: '🎂 Gâteau', diamonds: 150 },
    { id: 'gem', name: '💎 Gem', diamonds: 1 },
    { id: 'sunglasses', name: '😎 Lunettes', diamonds: 199 },
    { id: 'applause', name: '👏 Applause', diamonds: 1 },
    { id: 'galaxy', name: '🌌 Galaxy', diamonds: 1000 },
    { id: 'universe', name: '🌍 Universe', diamonds: 34999 },
    { id: 'lion', name: '🦁 Lion', diamonds: 29999 },
    { id: 'rocket', name: '🚀 Rocket', diamonds: 20000 },
    { id: 'airplane', name: '✈️ Avion', diamonds: 4888 },
    { id: 'sports_car', name: '🏎️ Sports Car', diamonds: 7000 },
    { id: 'train', name: '🚂 Train', diamonds: 899 },
    { id: 'rosa_nebula', name: '🌸 Rosa Nebula', diamonds: 1500 },
    { id: 'whale', name: '🐋 Whale', diamonds: 2150 },
];

function loadActionsConfig() {
    if (!useFileStorage) return;
    try {
        if (fs.existsSync(ACTIONS_CONFIG_FILE)) {
            actionsConfig = JSON.parse(fs.readFileSync(ACTIONS_CONFIG_FILE, 'utf-8'));
            console.log('🎮 Config FiveM chargée');
        }
    } catch (e) { console.warn('⚠️ Erreur chargement config FiveM:', e.message); }
}

function saveActionsConfig() {
    if (!useFileStorage) return;
    try { fs.writeFileSync(ACTIONS_CONFIG_FILE, JSON.stringify(actionsConfig, null, 2), 'utf-8'); } catch (e) {}
}

async function executeFiveM(action, quantity) {
    try {
        let fiveUrl = FIVEM_API_BASE;
        if (action.type === 'vehicle' || action.type === 'custom_vehicle') fiveUrl += '/' + action.model + '/' + quantity;
        else if (action.type === 'prop' || action.type === 'custom_prop') fiveUrl += '/prop/' + action.model + '/' + quantity;
        else if (action.type === 'action') fiveUrl += action.endpoint;
        console.log('🎮 FiveM Action:', fiveUrl);
        await fetch(fiveUrl, { method: 'GET' });
        return { success: true, url: fiveUrl };
    } catch (error) {
        console.error('❌ FiveM Error:', error.message);
        return { success: false, error: error.message };
    }
}

async function handleGiftAction(roomId, giftName, giftData) {
    const roomConfig = actionsConfig[roomId];
    if (!roomConfig || !roomConfig.enabled) return;
    const giftNameLower = giftName.toLowerCase();
    const mapping = roomConfig.mappings && roomConfig.mappings.find(function(m) {
        return m.giftName.toLowerCase() === giftNameLower || m.giftId === giftNameLower;
    });
    if (!mapping) return;
    const action = AVAILABLE_ACTIONS.find(function(a) { return a.id === mapping.actionId; });
    if (!action && !mapping.customAction) return;
    const actionToExecute = action || mapping.customAction;
    const quantity = mapping.quantity || 1;
    console.log('🎁 ' + roomId + ': ' + giftName + ' → ' + actionToExecute.name + ' x' + quantity);
    const result = await executeFiveM(actionToExecute, quantity);
    const room = rooms.get(roomId);
    if (room) {
        sendToRoom(room, 'INFO', 'FIVEM_ACTION', { gift: giftName, action: actionToExecute.name, quantity: quantity, success: result.success, user: giftData.user });
    }
    return result;
}

// ================= INITIALISATION =================
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ================= STORAGE =================
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

// ================= ROOMS CONFIG =================
let roomsConfig = { rooms: {} };
const ROOMS_CONFIG_FILE = path.join(DATA_DIR, 'rooms_config.json');

function loadRoomsConfig() {
    if (!useFileStorage) return;
    try {
        if (fs.existsSync(ROOMS_CONFIG_FILE)) {
            roomsConfig = JSON.parse(fs.readFileSync(ROOMS_CONFIG_FILE, 'utf-8'));
        }
    } catch (e) {
        console.warn('⚠️ Erreur chargement config rooms:', e.message);
    }
    // Initialiser les 20 rooms avec noms par défaut
    for (let i = 1; i <= TOTAL_ROOMS; i++) {
        const roomId = 'room_' + i;
        if (!roomsConfig.rooms[roomId]) {
            roomsConfig.rooms[roomId] = { name: 'Room ' + i, createdAt: new Date().toISOString() };
        }
    }
    saveRoomsConfig();
}

function saveRoomsConfig() {
    if (!useFileStorage) return;
    try {
        fs.writeFileSync(ROOMS_CONFIG_FILE, JSON.stringify(roomsConfig, null, 2), 'utf-8');
    } catch (e) {
        console.warn('⚠️ Erreur sauvegarde config rooms:', e.message);
    }
}

loadRoomsConfig();
loadActionsConfig();

// ================= MULTI-SESSIONS : ROOMS =================
const rooms = new Map();

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
        totalComments: 0,
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
    if (!roomId) return null;

    // Vérifier que c'est une room valide (room_1 à room_20)
    const match = roomId.match(/^room_(\d+)$/);
    if (!match || parseInt(match[1]) < 1 || parseInt(match[1]) > TOTAL_ROOMS) return null;

    if (!rooms.has(roomId)) {
        console.log('🏠 Room activée:', roomId);
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
    const filePath = path.join(DATA_DIR, `${room.id}.json`);
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const saved = JSON.parse(raw);
            room.state = { ...createEmptyState(), ...saved };
            console.log('📂 ' + room.id + ' : données restaurées');
        }
    } catch (e) {
        console.warn('⚠️ Erreur chargement ' + room.id + ':', e.message);
    }
}

function saveRoomState(room) {
    if (!useFileStorage) return;
    clearTimeout(room.saveTimeout);
    room.saveTimeout = setTimeout(() => {
        try {
            room.state.lastUpdated = new Date().toISOString();
            const filePath = path.join(DATA_DIR, `${room.id}.json`);
            fs.writeFileSync(filePath, JSON.stringify(room.state, null, 2), 'utf-8');
        } catch (e) {
            console.warn('⚠️ Erreur sauvegarde ' + room.id + ':', e.message);
        }
    }, 1000);
}

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
    room.state.totalComments = (room.state.totalComments || 0) + 1;
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
        console.log('🚫 ' + room.id + ' : reconnexion abandonnée');
        sendToRoom(room, 'ERROR', 'RECONNECT_FAILED', { error: 'Reconnexion échouée' });
        room.reconnectAttempts = 0;
        return;
    }
    room.reconnectAttempts++;
    const delay = RECONNECT_DELAY_MS * room.reconnectAttempts;
    console.log('🔄 ' + room.id + ' : tentative ' + room.reconnectAttempts + '/' + MAX_RECONNECT_ATTEMPTS);
    sendToRoom(room, 'INFO', 'RECONNECTING', { attempt: room.reconnectAttempts, maxAttempts: MAX_RECONNECT_ATTEMPTS });
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
            console.log('✅ ' + room.id + ' : CONNECTÉ @' + cleanUsername);
            sendToRoom(room, 'INFO', 'TIKTOK_CONNECTED', { username: cleanUsername, reconnected: isReconnect });
        })
        .catch(err => {
            console.error('❌ ' + room.id + ' :', err.message);
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
        handleGiftAction(room.id, data.giftName, giftData);
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
    room.connection.on('error', (err) => { console.error("⚠️ " + room.id + " erreur:", err.message); });
}

// ================= WEBSOCKET =================
wss.on('connection', (ws, req) => {
    const params = url.parse(req.url, true).query;
    const roomId = params.room;

    if (!roomId) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Room ID manquant' }));
        ws.close();
        return;
    }

    const room = getRoom(roomId);
    if (!room) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Room invalide' }));
        ws.close();
        return;
    }

    room.clients.add(ws);
    console.log('🔌 ' + roomId + ' : client connecté (' + room.clients.size + ')');

    const roomName = roomsConfig.rooms[roomId]?.name || roomId;
    ws.send(JSON.stringify({ type: 'INFO', message: 'Connecté', roomName: roomName }));

    ws.send(JSON.stringify({
        type: 'RESTORE',
        data: {
            roomId: roomId,
            roomName: roomName,
            coinsBoard: room.state.coinsBoard,
            likesBoard: room.state.likesBoard,
            redistributionBoard: room.state.redistributionBoard,
            totalCoins: room.state.totalCoins,
            totalLikes: room.state.totalLikes,
            totalGifts: room.state.totalGifts,
            totalComments: room.state.totalComments || 0,
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
        console.log('❌ ' + roomId + ' : client déconnecté');
    });
});

// ================= API ROOMS =================
app.get('/api/rooms', (req, res) => {
    const list = [];
    for (let i = 1; i <= TOTAL_ROOMS; i++) {
        const roomId = 'room_' + i;
        const config = roomsConfig.rooms[roomId] || { name: 'Room ' + i };
        const room = rooms.get(roomId);
        list.push({
            id: roomId,
            number: i,
            name: config.name,
            connected: room ? !!room.connection : false,
            username: room ? room.username : null,
            clients: room ? room.clients.size : 0,
            totalCoins: room ? room.state.totalCoins : 0,
            totalLikes: room ? room.state.totalLikes : 0,
            totalGifts: room ? room.state.totalGifts : 0,
            totalComments: room ? (room.state.totalComments || 0) : 0,
            totalViewers: room ? room.state.viewers.length : 0
        });
    }
    res.json({ rooms: list });
});

app.post('/api/rooms/rename', (req, res) => {
    const { roomId, name } = req.body;
    if (!roomId || !name) return res.status(400).json({ success: false, message: 'roomId et name requis' });

    const match = roomId.match(/^room_(\d+)$/);
    if (!match || parseInt(match[1]) < 1 || parseInt(match[1]) > TOTAL_ROOMS) {
        return res.status(400).json({ success: false, message: 'Room invalide' });
    }

    const cleanName = name.toString().trim().substring(0, 30);
    if (!cleanName) return res.status(400).json({ success: false, message: 'Nom invalide' });

    roomsConfig.rooms[roomId] = roomsConfig.rooms[roomId] || {};
    roomsConfig.rooms[roomId].name = cleanName;
    saveRoomsConfig();

    res.json({ success: true, message: 'Room renommée', name: cleanName });
});

// ================= STATS GLOBALES =================
app.get('/api/stats/global', (req, res) => {
    let totalCoins = 0, totalLikes = 0, totalGifts = 0, totalComments = 0, totalViewers = 0, liveRooms = 0;
    const allViewers = new Set();

    for (let i = 1; i <= TOTAL_ROOMS; i++) {
        const roomId = 'room_' + i;
        const room = rooms.get(roomId);
        if (!room) continue;
        totalCoins += room.state.totalCoins || 0;
        totalLikes += room.state.totalLikes || 0;
        totalGifts += room.state.totalGifts || 0;
        totalComments += room.state.totalComments || 0;
        if (room.state.viewers) {
            room.state.viewers.forEach(v => allViewers.add(v));
        }
        if (room.connection && room.username) liveRooms++;
    }

    res.json({
        liveRooms,
        totalCoins,
        totalLikes,
        totalGifts,
        totalComments,
        totalViewers: allViewers.size,
        totalDollars: (totalCoins / 250).toFixed(2)
    });
});

// ================= ROUTES API =================
app.get('/connect', (req, res) => {
    const username = req.query.username;
    const roomId = req.query.room;
    const room = getRoom(roomId);

    if (!room) return res.status(400).json({ success: false, message: "Room invalide" });
    if (!username) return res.status(400).json({ success: false, message: "Pseudo manquant" });

    connectToTikTok(room, username);
    res.json({ success: true, message: 'Connexion lancée vers @' + username });
});

app.get('/disconnect', (req, res) => {
    const roomId = req.query.room;
    const room = getRoom(roomId);

    if (!room) return res.status(400).json({ success: false, message: "Room invalide" });

    if (room.connection) {
        room.isManualDisconnect = true;
        clearTimeout(room.reconnectTimer);
        try { room.connection.disconnect(); } catch (e) {}
        room.connection = null;
        room.username = null;
        room.reconnectAttempts = 0;
        sendToRoom(room, 'INFO', 'STREAM_ENDED', {});
        res.json({ success: true, message: 'Déconnecté' });
    } else {
        res.json({ success: false, message: 'Pas de connexion active' });
    }
});

app.post('/api/redistribute', (req, res) => {
    const { user, amount, room: roomId } = req.body;
    const room = getRoom(roomId);
    if (!room) return res.status(400).json({ success: false, message: 'Room invalide' });
    if (!user || !amount || amount <= 0) return res.status(400).json({ success: false, message: 'Données invalides' });

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
    res.json({ success: true });
});

app.post('/api/marketing', (req, res) => {
    const { amount, comment, mktType, room: roomId } = req.body;
    const room = getRoom(roomId);
    if (!room) return res.status(400).json({ success: false, message: 'Room invalide' });
    const parsed = parseInt(amount);
    if (!parsed || parsed <= 0) return res.status(400).json({ success: false, message: 'Montant invalide' });

    room.state.marketingHistory.push({ amount: parsed, comment: comment || '', mktType: mktType || 'Manuel', date: new Date().toISOString() });
    room.state.totalMarketing += parsed;
    saveRoomState(room);
    sendToRoom(room, 'INFO', 'MARKETING_UPDATE', { marketingHistory: room.state.marketingHistory, totalMarketing: room.state.totalMarketing });
    res.json({ success: true });
});

app.post('/api/rewards', (req, res) => {
    const { amount, reason, room: roomId } = req.body;
    const room = getRoom(roomId);
    if (!room) return res.status(400).json({ success: false, message: 'Room invalide' });
    const parsed = parseInt(amount);
    if (!parsed || parsed <= 0) return res.status(400).json({ success: false, message: 'Montant invalide' });
    if (!reason || !reason.trim()) return res.status(400).json({ success: false, message: 'Raison requise' });

    room.state.rewardsHistory.push({ amount: parsed, reason: reason.trim(), date: new Date().toISOString() });
    room.state.totalRewards += parsed;
    saveRoomState(room);
    sendToRoom(room, 'INFO', 'REWARDS_UPDATE', { rewardsHistory: room.state.rewardsHistory, totalRewards: room.state.totalRewards });
    res.json({ success: true });
});

app.post('/api/withdrawals', (req, res) => {
    const { amount, reason, room: roomId } = req.body;
    const room = getRoom(roomId);
    if (!room) return res.status(400).json({ success: false, message: 'Room invalide' });
    const parsed = parseInt(amount);
    if (!parsed || parsed <= 0) return res.status(400).json({ success: false, message: 'Montant invalide' });
    if (!reason || !reason.trim()) return res.status(400).json({ success: false, message: 'Raison requise' });

    room.state.withdrawalsHistory.push({ amount: parsed, reason: reason.trim(), date: new Date().toISOString() });
    room.state.totalWithdrawals += parsed;
    saveRoomState(room);
    sendToRoom(room, 'INFO', 'WITHDRAWALS_UPDATE', { withdrawalsHistory: room.state.withdrawalsHistory, totalWithdrawals: room.state.totalWithdrawals });
    res.json({ success: true });
});

app.get('/api/export/all', (req, res) => {
    const room = getRoom(req.query.room);
    if (!room) return res.status(400).json({ success: false });
    res.setHeader('Content-Disposition', 'attachment; filename="' + room.id + '_export.json"');
    res.json({ exportedAt: new Date().toISOString(), roomId: room.id, ...room.state });
});

app.get('/api/export/coins/csv', (req, res) => {
    const room = getRoom(req.query.room);
    if (!room) return res.status(400).send('Room invalide');
    const sorted = Object.values(room.state.coinsBoard).sort((a, b) => b.total - a.total);
    let csv = 'Rang,Pseudo,Total,Dollars\n';
    sorted.forEach((e, i) => { csv += (i+1) + ',"' + e.user + '",' + e.total + ',' + (e.total/250).toFixed(2) + '\n'; });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="coins.csv"');
    res.send('\uFEFF' + csv);
});

app.get('/api/export/likes/csv', (req, res) => {
    const room = getRoom(req.query.room);
    if (!room) return res.status(400).send('Room invalide');
    const sorted = Object.values(room.state.likesBoard).sort((a, b) => b.total - a.total);
    let csv = 'Rang,Pseudo,Total_Likes\n';
    sorted.forEach((e, i) => { csv += (i+1) + ',"' + e.user + '",' + e.total + '\n'; });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="likes.csv"');
    res.send('\uFEFF' + csv);
});

app.get('/api/export/redist/csv', (req, res) => {
    const room = getRoom(req.query.room);
    if (!room) return res.status(400).send('Room invalide');
    const sorted = Object.values(room.state.redistributionBoard).sort((a, b) => b.total - a.total);
    let csv = 'Rang,Pseudo,Total,Dollars\n';
    sorted.forEach((e, i) => { csv += (i+1) + ',"' + e.user + '",' + e.total + ',' + (e.total/100).toFixed(2) + '\n'; });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="redistribution.csv"');
    res.send('\uFEFF' + csv);
});

app.post('/api/reset', (req, res) => {
    const roomId = req.body.room;
    const room = getRoom(roomId);
    if (!room) return res.status(400).json({ success: false, message: 'Room invalide' });

    const sessions = room.state.sessions;
    room.state = createEmptyState();
    room.state.sessions = sessions;
    saveRoomState(room);
    sendToRoom(room, 'INFO', 'DATA_RESET', {});
    res.json({ success: true });
});

app.post('/api/import', (req, res) => {
    const roomId = req.body.room || req.query.room;
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
        if (typeof data.totalComments === 'number') room.state.totalComments = data.totalComments;
        if (typeof data.totalRedistributed === 'number') room.state.totalRedistributed = data.totalRedistributed;
        if (typeof data.totalMarketing === 'number') room.state.totalMarketing = data.totalMarketing;
        if (typeof data.totalRewards === 'number') room.state.totalRewards = data.totalRewards;
        if (typeof data.totalWithdrawals === 'number') room.state.totalWithdrawals = data.totalWithdrawals;
        if (data.viewers) room.state.viewers = data.viewers;
        saveRoomState(room);

        sendToRoom(room, 'RESTORE', null, {
            coinsBoard: room.state.coinsBoard, likesBoard: room.state.likesBoard, redistributionBoard: room.state.redistributionBoard,
            totalCoins: room.state.totalCoins, totalLikes: room.state.totalLikes, totalGifts: room.state.totalGifts,
            totalCoins: room.state.totalCoins, totalLikes: room.state.totalLikes, totalGifts: room.state.totalGifts, totalComments: room.state.totalComments || 0,
            totalRedistributed: room.state.totalRedistributed, totalMarketing: room.state.totalMarketing, totalRewards: room.state.totalRewards, totalWithdrawals: room.state.totalWithdrawals,
            marketingHistory: room.state.marketingHistory, rewardsHistory: room.state.rewardsHistory, withdrawalsHistory: room.state.withdrawalsHistory,
            viewers: room.state.viewers, chatMessages: room.state.chatMessages.slice(-200), currentUsername: room.username
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ================= PAGE D'ACCUEIL =================
app.get('/', (req, res) => { res.send(HOME_HTML); });

const HOME_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TikTok Live - Rooms</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0f;--card:#12121a;--border:#1e1e2e;--pk:#fe2c55;--cy:#25f4ee;--txt:#f0f0f5;--txt2:#6e6e80;--green:#22c55e}
body{background:var(--bg);color:var(--txt);font-family:'Outfit',sans-serif;min-height:100vh;padding:40px 20px}
.container{max-width:800px;margin:0 auto}
.header{text-align:center;margin-bottom:40px}
.header h1{font-size:32px;font-weight:800;margin-bottom:8px}
.header h1 .pk{color:var(--pk)}.header h1 .cy{color:var(--cy)}
.header p{color:var(--txt2);font-size:14px}
.rooms-grid{display:flex;flex-direction:column;gap:12px}
.room-card{display:flex;align-items:center;gap:16px;padding:16px 20px;background:var(--card);border:1px solid var(--border);border-radius:14px;transition:all .2s}
.room-card:hover{border-color:rgba(37,244,238,.3);transform:translateX(4px)}
.room-card.live{border-color:rgba(34,197,94,.4);background:linear-gradient(90deg,rgba(34,197,94,.05),transparent)}
.room-num{width:40px;height:40px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.05);border-radius:10px;font-weight:700;font-size:16px;color:var(--txt2)}
.room-card.live .room-num{background:rgba(34,197,94,.15);color:var(--green)}
.room-info{flex:1}
.room-name{font-weight:600;font-size:16px;display:flex;align-items:center;gap:8px}
.room-name input{background:none;border:none;color:var(--txt);font-family:'Outfit',sans-serif;font-size:16px;font-weight:600;width:200px;outline:none;padding:2px 0}
.room-name input:focus{border-bottom:1px solid var(--cy)}
.room-status{font-size:12px;color:var(--txt2);margin-top:2px}
.room-status.live{color:var(--green)}
.live-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:rgba(34,197,94,.15);border-radius:20px;font-size:11px;font-weight:600;color:var(--green)}
.live-badge::before{content:'';width:6px;height:6px;background:var(--green);border-radius:50%;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.room-actions{display:flex;gap:8px}
.btn{padding:10px 20px;border:none;border-radius:10px;font-family:'Outfit',sans-serif;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s}
.btn-enter{background:linear-gradient(135deg,var(--cy),#1ad4d4);color:#000}
.btn-enter:hover{transform:translateY(-2px);box-shadow:0 4px 20px rgba(37,244,238,.3)}
.btn-rename{background:rgba(255,255,255,.05);color:var(--txt2);padding:10px 14px}
.btn-rename:hover{background:rgba(255,255,255,.1);color:var(--txt)}
.btn-save{background:var(--green);color:#fff;padding:10px 14px}
.stats{display:flex;gap:20px;margin-top:30px;justify-content:center;flex-wrap:wrap}
.stat{text-align:center;padding:16px 24px;background:var(--card);border:1px solid var(--border);border-radius:12px}
.stat-val{font-size:28px;font-weight:800;color:var(--cy)}
.stat-label{font-size:11px;color:var(--txt2);text-transform:uppercase;letter-spacing:1px;margin-top:4px}
.refresh-btn{display:block;margin:30px auto 0;padding:12px 30px;background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:10px;color:var(--txt2);font-family:'Outfit',sans-serif;font-size:13px;cursor:pointer;transition:.2s}
.refresh-btn:hover{background:rgba(255,255,255,.1);color:var(--txt)}
.global-footer{position:fixed;bottom:0;left:0;right:0;z-index:100;background:rgba(10,10,15,.95);backdrop-filter:blur(20px);border-top:1px solid var(--border);padding:14px 28px}
.global-inner{max-width:900px;margin:0 auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center}
.global-title{font-weight:700;font-size:12px;color:var(--txt2);text-transform:uppercase;letter-spacing:1px;margin-right:8px;display:flex;align-items:center;gap:6px}
.global-title .pulse-dot{width:8px;height:8px;border-radius:50%;background:var(--green);animation:pulse 1.5s infinite}
.gs{display:flex;align-items:center;gap:6px;padding:8px 14px;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:10px;transition:all .3s}
.gs:hover{border-color:rgba(37,244,238,.3);background:rgba(37,244,238,.04)}
.gs-icon{font-size:14px}
.gs-val{font-size:16px;font-weight:800;font-family:'Outfit',sans-serif;transition:color .3s}
.gs-label{font-size:10px;color:var(--txt2);text-transform:uppercase;letter-spacing:.5px}
.gs-val.coins{color:var(--gold)}.gs-val.likes{color:var(--pk)}.gs-val.comments{color:var(--cy)}.gs-val.viewers{color:#a78bfa}.gs-val.gifts{color:#c084fc}.gs-val.live{color:var(--green)}.gs-val.dollars{color:var(--green)}
.gs-flash{animation:gsFlash .5s ease}
@keyframes gsFlash{0%{transform:scale(1)}50%{transform:scale(1.1)}100%{transform:scale(1)}}
body{padding-bottom:80px}
</style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>🎮 Tik<span class="pk">Tok</span> <span class="cy">Live</span> Rooms</h1>
        <p>Choisis ta room pour commencer</p>
    </div>
    <div class="rooms-grid" id="roomsGrid"></div>
    <div class="stats" id="stats"></div>
    <button class="refresh-btn" onclick="loadRooms()">🔄 Rafraîchir</button>
</div>
<div class="global-footer">
    <div class="global-inner">
        <div class="global-title"><span class="pulse-dot"></span> STATS GLOBALES</div>
        <div class="gs"><span class="gs-icon">🟢</span><div><div class="gs-val live" id="gLive">0</div><div class="gs-label">Live</div></div></div>
        <div class="gs"><span class="gs-icon">💰</span><div><div class="gs-val coins" id="gCoins">0</div><div class="gs-label">Pièces</div></div></div>
        <div class="gs"><span class="gs-icon">💵</span><div><div class="gs-val dollars" id="gDollars">$0</div><div class="gs-label">Dollars</div></div></div>
        <div class="gs"><span class="gs-icon">❤️</span><div><div class="gs-val likes" id="gLikes">0</div><div class="gs-label">Likes</div></div></div>
        <div class="gs"><span class="gs-icon">💬</span><div><div class="gs-val comments" id="gComments">0</div><div class="gs-label">Commentaires</div></div></div>
        <div class="gs"><span class="gs-icon">🎁</span><div><div class="gs-val gifts" id="gGifts">0</div><div class="gs-label">Cadeaux</div></div></div>
        <div class="gs"><span class="gs-icon">👥</span><div><div class="gs-val viewers" id="gViewers">0</div><div class="gs-label">Viewers</div></div></div>
    </div>
</div>
<script>
var editingRoom = null;

function loadRooms() {
    fetch('/api/rooms').then(r => r.json()).then(data => {
        var grid = document.getElementById('roomsGrid');
        var liveCount = 0, totalCoins = 0;
        
        var html = '';
        data.rooms.forEach(room => {
            var isLive = room.connected && room.username;
            if (isLive) liveCount++;
            totalCoins += room.totalCoins || 0;
            
            var isEditing = editingRoom === room.id;
            
            html += '<div class="room-card' + (isLive ? ' live' : '') + '">';
            html += '<div class="room-num">' + room.number + '</div>';
            html += '<div class="room-info">';
            
            if (isEditing) {
                html += '<div class="room-name"><input type="text" id="input_' + room.id + '" value="' + escapeHtml(room.name) + '" onkeydown="if(event.key===\\'Enter\\')saveRoomName(\\'' + room.id + '\\')"/></div>';
            } else {
                html += '<div class="room-name">' + escapeHtml(room.name);
                if (isLive) html += ' <span class="live-badge">LIVE</span>';
                html += '</div>';
            }
            
            if (isLive) {
                html += '<div class="room-status live">🔴 Connecté à @' + escapeHtml(room.username) + '</div>';
            } else {
                html += '<div class="room-status">Disponible</div>';
            }
            
            html += '</div>';
            html += '<div class="room-actions">';
            
            if (isEditing) {
                html += '<button class="btn btn-save" onclick="saveRoomName(\\'' + room.id + '\\')">✓</button>';
            } else {
                html += '<button class="btn btn-rename" onclick="startEdit(\\'' + room.id + '\\')">✏️</button>';
            }
            
            html += '<button class="btn btn-enter" onclick="enterRoom(\\'' + room.id + '\\')">Entrer →</button>';
            html += '</div>';
            html += '</div>';
        });
        
        grid.innerHTML = html;
        
        document.getElementById('stats').innerHTML = 
            '<div class="stat"><div class="stat-val">' + liveCount + '</div><div class="stat-label">Rooms Live</div></div>' +
            '<div class="stat"><div class="stat-val">' + formatNum(totalCoins) + '</div><div class="stat-label">Total Pièces</div></div>';
        
        if (editingRoom) {
            var inp = document.getElementById('input_' + editingRoom);
            if (inp) { inp.focus(); inp.select(); }
        }
    });
}

function escapeHtml(t) {
    var d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
}

function formatNum(n) {
    if (n >= 1000000) return (n/1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n/1000).toFixed(1) + 'K';
    return n.toString();
}

function startEdit(roomId) {
    editingRoom = roomId;
    loadRooms();
}

function saveRoomName(roomId) {
    var inp = document.getElementById('input_' + roomId);
    if (!inp) return;
    var name = inp.value.trim();
    if (!name) return;
    
    fetch('/api/rooms/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: roomId, name: name })
    }).then(r => r.json()).then(d => {
        editingRoom = null;
        loadRooms();
    });
}

var PROTECTED_ROOMS = { 'room_1': '0104', 'room_2': '1986', 'room_3': '2211', 'room_10': '0910', 'room_13': '0102', 'room_15': '0095', 'room_18': '2026', 'room_19': '1203', 'room_20': '0410' };
var DEFAULT_ROOM_PIN = '7777';

function enterRoom(roomId) {
    var expectedPin = PROTECTED_ROOMS[roomId] || DEFAULT_ROOM_PIN;
    var pin = prompt('🔒 Code PIN requis pour ' + roomId + ' :');
    if (pin === null) return;
    if (pin !== expectedPin) {
        alert('❌ Code PIN incorrect');
        return;
    }
    var url = '/dashboard?room=' + roomId + '&pin=' + encodeURIComponent(pin);
    window.location.href = url;
}

var prevGlobal = {};

function loadGlobalStats() {
    fetch('/api/stats/global').then(function(r) { return r.json(); }).then(function(data) {
        updateGS('gLive', data.liveRooms);
        updateGS('gCoins', data.totalCoins);
        updateGS('gDollars', '$' + Math.floor(data.totalDollars || 0));
        updateGS('gLikes', data.totalLikes);
        updateGS('gComments', data.totalComments);
        updateGS('gGifts', data.totalGifts);
        updateGS('gViewers', data.totalViewers);
    }).catch(function() {});
}

function updateGS(id, val) {
    var el = document.getElementById(id);
    if (!el) return;
    var display = (typeof val === 'string') ? val : formatNum(val);
    if (el.textContent !== display) {
        el.textContent = display;
        el.classList.remove('gs-flash');
        void el.offsetWidth;
        el.classList.add('gs-flash');
    }
    prevGlobal[id] = val;
}

loadRooms();
loadGlobalStats();
setInterval(loadRooms, 10000);
setInterval(loadGlobalStats, 5000);
</script>
</body>
</html>`;

// ================= DASHBOARD =================
app.get('/dashboard', (req, res) => {
    const roomId = req.query.room;
    if (!roomId) return res.redirect('/');
    var expectedPin = ROOM_PINS[roomId] || DEFAULT_PIN;
    if (req.query.pin !== expectedPin) return res.redirect('/');
    res.send(DASHBOARD_HTML);
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TikTok Live Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0f;--card:#12121a;--border:#1e1e2e;--pk:#fe2c55;--cy:#25f4ee;--txt:#f0f0f5;--txt2:#6e6e80;--gold:#ffd700;--green:#22c55e}
body{background:var(--bg);color:var(--txt);font-family:'Outfit',sans-serif;min-height:100vh}
.topbar{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:14px 28px;background:rgba(10,10,15,0.9);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);flex-wrap:wrap;gap:10px}
.topbar-left{display:flex;align-items:center;gap:12px}
.btn-back{padding:8px 14px;background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:8px;color:var(--txt2);text-decoration:none;font-size:13px;font-weight:500;transition:.2s}
.btn-back:hover{background:rgba(255,255,255,.1);color:var(--txt)}
.topbar-logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px}
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
.sc{flex:1;min-width:100px;padding:14px;background:var(--card);border:1px solid var(--border);border-radius:14px}
.sc-label{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--txt2);font-weight:600}
.sc-val{font-size:22px;font-weight:800;font-family:'JetBrains Mono',monospace}
.sc-sub{font-size:11px;color:var(--green);font-family:'JetBrains Mono',monospace}
.coins{color:var(--gold)}.likes{color:var(--pk)}.viewers{color:var(--cy)}.gifts{color:#c084fc}.redist{color:var(--green)}.marketing{color:#f97316}.rewards{color:#eab308}.withdrawals{color:#ef4444}.earned{color:#06b6d4}
.ebar{display:flex;justify-content:flex-end;padding:0 28px 8px;gap:8px;flex-wrap:wrap}
.btn-eg{padding:8px 16px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.03);color:var(--txt2);font-size:12px;font-weight:600;cursor:pointer}
.btn-eg:hover{background:rgba(37,244,238,.08);color:var(--cy)}
.btn-rst{padding:8px 16px;border:1px solid rgba(254,44,85,.2);border-radius:10px;background:rgba(254,44,85,.05);color:rgba(254,44,85,.6);font-size:12px;cursor:pointer}
.btn-rst:hover{color:var(--pk)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:0 28px 28px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.panel{background:var(--card);border:1px solid var(--border);border-radius:16px;display:flex;flex-direction:column;max-height:500px;overflow:hidden}
.ph{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border)}
.pt{font-weight:700;font-size:14px}
.pc{font-family:'JetBrains Mono',monospace;font-size:11px;padding:3px 8px;border-radius:6px;background:rgba(255,255,255,.05);color:var(--txt2)}
.sb{padding:10px 14px}
.si{width:100%;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--txt);font-size:13px;outline:none}
.ll{flex:1;overflow-y:auto;padding:4px 8px 12px}
.ll::-webkit-scrollbar{width:4px}.ll::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
.lr{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:10px}
.lr:hover{background:rgba(255,255,255,.03)}
.lrk{width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;font-family:'JetBrains Mono',monospace;border-radius:6px;background:rgba(255,255,255,.04);color:var(--txt2)}
.lrk.g{background:rgba(255,215,0,.15);color:var(--gold)}.lrk.s{background:rgba(192,192,192,.12);color:#c0c0c0}.lrk.b{background:rgba(205,127,50,.12);color:#cd7f32}
.lav{width:34px;height:34px;border-radius:50%;object-fit:cover;border:2px solid var(--border);background:var(--card)}
.li{flex:1;min-width:0}.ln{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lv{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:13px;text-align:right}
.lv .dollar{font-size:10px;color:var(--green)}
.cl{flex:1;overflow-y:auto;padding:8px 12px}
.cm{display:flex;gap:8px;padding:6px 8px;border-radius:8px}
.cm:hover{background:rgba(255,255,255,.03)}
.ca{width:28px;height:28px;border-radius:50%;object-fit:cover;background:var(--card)}
.cc{flex:1}.cu{font-weight:600;font-size:12px;color:var(--cy)}.ct{font-size:12px;opacity:.85}.ctm{font-size:10px;color:var(--txt2)}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:30px;color:var(--txt2);text-align:center;flex:1}
.empty .ei{font-size:28px;opacity:.5}
.toast{position:fixed;bottom:20px;right:20px;padding:10px 18px;border-radius:10px;font-size:12px;opacity:0;transform:translateY(10px);transition:.3s;z-index:200}
.toast.show{opacity:1;transform:translateY(0)}
.toast.success{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);color:var(--green)}
.toast.error{background:rgba(254,44,85,.1);border:1px solid rgba(254,44,85,.2);color:var(--pk)}
.form-section{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:6px}
.form-row{display:flex;gap:6px}
.form-input{flex:1;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--txt);font-size:12px;outline:none}
.btn-form{padding:8px 14px;border:none;border-radius:8px;font-weight:600;font-size:12px;cursor:pointer;color:#fff}
.btn-green{background:linear-gradient(135deg,var(--green),#16a34a)}
.btn-orange{background:linear-gradient(135deg,#f97316,#ea580c)}
.btn-yellow{background:linear-gradient(135deg,#eab308,#ca8a04)}
.btn-red{background:linear-gradient(135deg,#ef4444,#dc2626)}
.rf-results{position:absolute;top:100%;left:0;right:0;background:var(--card);border:1px solid var(--border);border-radius:8px;max-height:150px;overflow-y:auto;z-index:30;display:none}
.rf-results.open{display:block}
.rf-item{display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;font-size:12px}
.rf-item:hover{background:rgba(255,255,255,.05)}
.rf-item img{width:24px;height:24px;border-radius:50%}
.rf-selected{display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(37,244,238,.05);border:1px solid rgba(37,244,238,.15);border-radius:8px;margin-bottom:6px;font-size:12px}
.rf-selected img{width:24px;height:24px;border-radius:50%}
.rf-selected .name{flex:1;font-weight:600}
.rf-selected .rf-clear{background:none;border:none;color:var(--pk);cursor:pointer;padding:2px 6px}
.entry-row{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;font-size:12px}
.entry-row:hover{background:rgba(255,255,255,.03)}
.entry-icon{width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:6px;font-size:14px}
.entry-info{flex:1}
.entry-amount{font-weight:700;font-family:'JetBrains Mono',monospace}
.entry-detail{font-size:11px;color:var(--txt2)}
.entry-val{font-family:'JetBrains Mono',monospace;font-weight:600;color:var(--green);font-size:11px}
</style>
</head>
<body>
<div class="topbar">
    <div class="topbar-left">
        <a href="/" class="btn-back">← Rooms</a>
        <div class="topbar-logo"><div class="dot" id="dot"></div><span>Tik<span class="pk">Tok</span> <span class="cy">Live</span></span></div>
    </div>
    <div class="room-badge" id="roomBadge">Room: ---</div>
    <div class="cz">
        <div class="badge" id="badge"><span id="stxt">Déconnecté</span></div>
        <input type="text" id="username" placeholder="@pseudo_en_live" spellcheck="false"/>
        <button class="btn-co" id="btnCo" onclick="doConnect()">Connexion</button>
        <button class="btn-dc" id="btnDc" onclick="doDisconnect()" style="display:none;">Déconnexion</button>
        <button class="btn-co" onclick="goFiveM()" style="background:linear-gradient(135deg,#ff0033,#cc0029);">🎮 FiveM</button>
    </div>
</div>
<div class="stats-bar">
    <div class="sc"><div class="sc-label">Pièces</div><div class="sc-val coins" id="sCoins">0</div><div class="sc-sub" id="sCoinsDol">$0</div></div>
    <div class="sc"><div class="sc-label">Redistribué</div><div class="sc-val redist" id="sRedist">0</div><div class="sc-sub" id="sRedistDol">$0</div></div>
    <div class="sc"><div class="sc-label">Marketing</div><div class="sc-val marketing" id="sMarketing">0</div></div>
    <div class="sc"><div class="sc-label">Récompenses</div><div class="sc-val rewards" id="sRewards">0</div></div>
    <div class="sc"><div class="sc-label">Retraits</div><div class="sc-val withdrawals" id="sWithdrawals">0</div></div>
    <div class="sc" style="border-color:rgba(37,244,238,.3)"><div class="sc-label">Gagné</div><div class="sc-val earned" id="sEarned">0</div><div class="sc-sub" id="sEarnedDol">$0</div></div>
    <div class="sc"><div class="sc-label">Likes</div><div class="sc-val likes" id="sLikes">0</div></div>
    <div class="sc"><div class="sc-label">Viewers</div><div class="sc-val viewers" id="sViewers">0</div></div>
</div>
<div class="ebar">
    <button class="btn-eg" onclick="window.open('/api/export/all?room='+ROOM)">📦 Export</button>
    <button class="btn-eg" onclick="document.getElementById('importFile').click()">📥 Import</button>
    <input type="file" id="importFile" accept=".json" style="display:none" onchange="importSave(event)">
    <button class="btn-rst" onclick="resetData()">🗑 Reset</button>
</div>
<div class="grid">
    <div class="panel"><div class="ph"><div class="pt">💰 Pièces</div><div class="pc" id="cCoins">0</div></div><div class="sb"><input class="si" placeholder="Rechercher..." oninput="filterLB('coins',this.value)"/></div><div class="ll" id="lbCoins"><div class="empty"><div class="ei">🎁</div></div></div></div>
    <div class="panel"><div class="ph"><div class="pt">❤️ Likes</div><div class="pc" id="cLikes">0</div></div><div class="sb"><input class="si" placeholder="Rechercher..." oninput="filterLB('likes',this.value)"/></div><div class="ll" id="lbLikes"><div class="empty"><div class="ei">❤️</div></div></div></div>
    <div class="panel"><div class="ph"><div class="pt">💸 Redistribution</div><div class="pc" id="cRedist">0</div></div>
        <div class="form-section"><div style="position:relative"><input class="si" id="rfSearch" placeholder="Chercher viewer..." oninput="searchViewers(this.value)" autocomplete="off"/><div class="rf-results" id="rfResults"></div></div><div id="rfSelected" style="display:none" class="rf-selected"><img id="rfSelPic" src="" onerror="this.style.display='none'"/><span class="name" id="rfSelName"></span><button class="rf-clear" onclick="clearSel()">✕</button></div><div class="form-row"><input type="number" class="form-input" id="rfAmount" placeholder="Pièces" min="1"/><button class="btn-form btn-green" onclick="sendRedist()">Envoyer</button></div></div>
        <div class="sb"><input class="si" placeholder="Rechercher..." oninput="filterLB('redist',this.value)"/></div><div class="ll" id="lbRedist"><div class="empty"><div class="ei">💸</div></div></div></div>
    <div class="panel"><div class="ph"><div class="pt">📢 Marketing</div><div class="pc" id="cMarketing">0</div></div>
        <div class="form-section"><div class="form-row"><input type="number" class="form-input" id="mktAmount" placeholder="Pièces"/><input type="text" class="form-input" id="mktComment" placeholder="Commentaire"/><button class="btn-form btn-orange" onclick="sendMkt()">+</button></div></div>
        <div class="ll" id="lbMarketing"><div class="empty"><div class="ei">📢</div></div></div></div>
    <div class="panel"><div class="ph"><div class="pt">🏆 Récompenses</div><div class="pc" id="cRewards">0</div></div>
        <div class="form-section"><div class="form-row"><input type="text" class="form-input" id="rwdReason" placeholder="Raison"/><input type="number" class="form-input" id="rwdAmount" placeholder="Pièces" style="width:80px"/><button class="btn-form btn-yellow" onclick="sendRwd()">+</button></div></div>
        <div class="ll" id="lbRewards"><div class="empty"><div class="ei">🏆</div></div></div></div>
    <div class="panel"><div class="ph"><div class="pt">🏧 Retraits</div><div class="pc" id="cWithdrawals">0</div></div>
        <div class="form-section"><div class="form-row"><input type="text" class="form-input" id="wdrReason" placeholder="Raison"/><input type="number" class="form-input" id="wdrAmount" placeholder="Pièces" style="width:80px"/><button class="btn-form btn-red" onclick="sendWdr()">+</button></div></div>
        <div class="ll" id="lbWithdrawals"><div class="empty"><div class="ei">🏧</div></div></div></div>
    <div class="panel" style="grid-column:span 2"><div class="ph"><div class="pt">💬 Chat</div><div class="pc" id="cChat">0</div></div><div class="cl" id="chatList"><div class="empty"><div class="ei">💬</div></div></div></div>
</div>
<script>
var params=new URLSearchParams(window.location.search);
var ROOM=params.get('room');
var PIN=params.get('pin')||'';
if(!ROOM){window.location.href='/';}
document.addEventListener('DOMContentLoaded',function(){document.getElementById('roomBadge').textContent=ROOM;});

var S={coinsBoard:{},likesBoard:{},redistributionBoard:{},marketingHistory:[],rewardsHistory:[],withdrawalsHistory:[],chatMessages:[],totalCoins:0,totalLikes:0,totalGifts:0,totalRedistributed:0,totalMarketing:0,totalRewards:0,totalWithdrawals:0,viewers:new Set(),filters:{coins:'',likes:'',redist:''},selectedUser:null,roomName:''};

var ws,wrt;
function initWS(){var p=location.protocol==='https:'?'wss://':'ws://';ws=new WebSocket(p+location.host+'/?room='+ROOM+'&pin='+encodeURIComponent(PIN));ws.onmessage=function(e){try{handle(JSON.parse(e.data))}catch(x){}};ws.onclose=function(){clearTimeout(wrt);wrt=setTimeout(initWS,3000)};ws.onerror=function(){ws.close()};}

function handle(m){
    if(m.type==='RESTORE'&&m.data){var d=m.data;S.roomName=d.roomName||ROOM;document.getElementById('roomBadge').textContent=S.roomName;S.coinsBoard=d.coinsBoard||{};S.likesBoard=d.likesBoard||{};S.redistributionBoard=d.redistributionBoard||{};S.totalCoins=d.totalCoins||0;S.totalLikes=d.totalLikes||0;S.totalGifts=d.totalGifts||0;S.totalRedistributed=d.totalRedistributed||0;S.totalMarketing=d.totalMarketing||0;S.marketingHistory=d.marketingHistory||[];S.totalRewards=d.totalRewards||0;S.rewardsHistory=d.rewardsHistory||[];S.totalWithdrawals=d.totalWithdrawals||0;S.withdrawalsHistory=d.withdrawalsHistory||[];S.viewers=new Set(d.viewers||[]);if(d.chatMessages){S.chatMessages=d.chatMessages.map(function(c){return{user:c.user,profilePictureUrl:c.profilePictureUrl||'',comment:c.comment,time:c.time?new Date(c.time).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}):''};});renderChat();}if(d.currentUsername)document.getElementById('username').value=d.currentUsername;updStats();renderAll();return;}
    if(m.type==='INFO'){if(m.action==='TIKTOK_CONNECTED'){setConn(true,m.data.username);}if(m.action==='STREAM_ENDED')setConn(false);if(m.action==='DATA_RESET'){S.coinsBoard={};S.likesBoard={};S.redistributionBoard={};S.marketingHistory=[];S.rewardsHistory=[];S.withdrawalsHistory=[];S.chatMessages=[];S.totalCoins=0;S.totalLikes=0;S.totalGifts=0;S.totalRedistributed=0;S.totalMarketing=0;S.totalRewards=0;S.totalWithdrawals=0;S.viewers=new Set();updStats();renderAll();renderChat();toast('success','Reset OK');}if(m.action==='REDISTRIBUTION_UPDATE'){S.redistributionBoard=m.data.redistributionBoard||{};S.totalRedistributed=m.data.totalRedistributed||0;updStats();renderLB('redist');}if(m.action==='MARKETING_UPDATE'){S.marketingHistory=m.data.marketingHistory||[];S.totalMarketing=m.data.totalMarketing||0;updStats();renderMkt();}if(m.action==='REWARDS_UPDATE'){S.rewardsHistory=m.data.rewardsHistory||[];S.totalRewards=m.data.totalRewards||0;updStats();renderRwd();}if(m.action==='WITHDRAWALS_UPDATE'){S.withdrawalsHistory=m.data.withdrawalsHistory||[];S.totalWithdrawals=m.data.totalWithdrawals||0;updStats();renderWdr();}}
    if(m.type==='ERROR')setConn(false);
    if(m.type==='ACTION'){if(m.action==='shoot_balloon')onGift(m.data);if(m.action==='like')onLike(m.data);if(m.action==='chat')onChat(m.data);}
}

function onGift(d){var u=d.user;S.viewers.add(u);if(!S.coinsBoard[u])S.coinsBoard[u]={user:u,profilePictureUrl:d.profilePictureUrl,total:0};S.coinsBoard[u].total+=d.diamondCount;S.totalCoins+=d.diamondCount;S.totalGifts++;updStats();renderLB('coins');}
function onLike(d){var u=d.user;S.viewers.add(u);if(!S.likesBoard[u])S.likesBoard[u]={user:u,profilePictureUrl:d.profilePictureUrl,total:0};S.likesBoard[u].total+=d.count;S.totalLikes+=d.count;updStats();renderLB('likes');}
function onChat(d){S.viewers.add(d.user);S.chatMessages.push({user:d.user,profilePictureUrl:d.profilePictureUrl,comment:d.comment,time:new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})});if(S.chatMessages.length>200)S.chatMessages=S.chatMessages.slice(-200);updStats();renderChat();}

function fmt(n){if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return n.toString();}
function esc(t){var d=document.createElement('div');d.textContent=t;return d.innerHTML;}
function safePic(url){if(!url)return'';if(url.indexOf('http')===0)return esc(url);return'';}
function rkCls(i){return i===0?'g':i===1?'s':i===2?'b':'';}

function updStats(){
    document.getElementById('sCoins').textContent=fmt(S.totalCoins);document.getElementById('sCoinsDol').textContent='$'+(S.totalCoins/250).toFixed(0);
    document.getElementById('sRedist').textContent=fmt(S.totalRedistributed);document.getElementById('sRedistDol').textContent='$'+(S.totalRedistributed/100).toFixed(0);
    document.getElementById('sLikes').textContent=fmt(S.totalLikes);document.getElementById('sViewers').textContent=S.viewers.size;
    document.getElementById('sMarketing').textContent=fmt(S.totalMarketing);document.getElementById('sRewards').textContent=fmt(S.totalRewards);document.getElementById('sWithdrawals').textContent=fmt(S.totalWithdrawals);
    var earned=S.totalCoins+S.totalRewards-S.totalRedistributed;document.getElementById('sEarned').textContent=fmt(Math.abs(earned));document.getElementById('sEarned').style.color=earned>=0?'#22c55e':'#ef4444';
    var earnedDol=(S.totalCoins/250)+(S.totalRewards/100)-(S.totalRedistributed/100);document.getElementById('sEarnedDol').textContent='$'+Math.abs(earnedDol).toFixed(0);document.getElementById('sEarnedDol').style.color=earnedDol>=0?'#22c55e':'#ef4444';
}

function renderAll(){renderLB('coins');renderLB('likes');renderLB('redist');renderMkt();renderRwd();renderWdr();}

function renderLB(type){var board=type==='coins'?S.coinsBoard:type==='likes'?S.likesBoard:S.redistributionBoard;var el=document.getElementById('lb'+type.charAt(0).toUpperCase()+type.slice(1));var cntEl=document.getElementById('c'+type.charAt(0).toUpperCase()+type.slice(1));var f=S.filters[type].toLowerCase();var all=Object.values(board).sort(function(a,b){return b.total-a.total});cntEl.textContent=all.length;var entries=f?all.filter(function(e){return e.user.toLowerCase().indexOf(f)!==-1}):all;if(entries.length===0){el.innerHTML='<div class="empty"><div class="ei">'+(type==='coins'?'🎁':type==='likes'?'❤️':'💸')+'</div></div>';return;}var h='';entries.slice(0,50).forEach(function(e){var rank=all.findIndex(function(x){return x.user===e.user});var rc=rkCls(rank);h+='<div class="lr"><div class="lrk '+rc+'">'+(rank+1)+'</div><img class="lav" src="'+safePic(e.profilePictureUrl)+'" onerror="this.style.display=\\'none\\'"/><div class="li"><div class="ln">@'+esc(e.user)+'</div></div><div class="lv"><div>'+fmt(e.total)+'</div>'+(type!=='likes'?'<div class="dollar">$'+(type==='redist'?(e.total/100).toFixed(0):(e.total/250).toFixed(0))+'</div>':'')+'</div></div>';});el.innerHTML=h;}

function renderChat(){var el=document.getElementById('chatList');document.getElementById('cChat').textContent=S.chatMessages.length;var msgs=S.chatMessages.slice(-30);var h='';msgs.forEach(function(m){h+='<div class="cm"><img class="ca" src="'+safePic(m.profilePictureUrl)+'" onerror="this.style.display=\\'none\\'"/><div class="cc"><div class="cu">@'+esc(m.user)+'</div><div class="ct">'+esc(m.comment)+'</div></div></div>';});el.innerHTML=h;el.scrollTop=el.scrollHeight;}

function renderMkt(){var el=document.getElementById('lbMarketing');document.getElementById('cMarketing').textContent=S.marketingHistory.length;if(!S.marketingHistory.length){el.innerHTML='<div class="empty"><div class="ei">📢</div></div>';return;}var h='';S.marketingHistory.slice().reverse().slice(0,20).forEach(function(e){h+='<div class="entry-row"><div class="entry-icon" style="background:rgba(249,115,22,.1)">📢</div><div class="entry-info"><div class="entry-amount" style="color:#f97316">+'+fmt(e.amount)+'</div><div class="entry-detail">'+esc(e.comment||'')+'</div></div><div class="entry-val">$'+(e.amount/100).toFixed(0)+'</div></div>';});el.innerHTML=h;}
function renderRwd(){var el=document.getElementById('lbRewards');document.getElementById('cRewards').textContent=S.rewardsHistory.length;if(!S.rewardsHistory.length){el.innerHTML='<div class="empty"><div class="ei">🏆</div></div>';return;}var h='';S.rewardsHistory.slice().reverse().slice(0,20).forEach(function(e){h+='<div class="entry-row"><div class="entry-icon" style="background:rgba(234,179,8,.1)">🏆</div><div class="entry-info"><div class="entry-amount" style="color:#eab308">+'+fmt(e.amount)+'</div><div class="entry-detail">'+esc(e.reason||'')+'</div></div><div class="entry-val">$'+(e.amount/100).toFixed(0)+'</div></div>';});el.innerHTML=h;}
function renderWdr(){var el=document.getElementById('lbWithdrawals');document.getElementById('cWithdrawals').textContent=S.withdrawalsHistory.length;if(!S.withdrawalsHistory.length){el.innerHTML='<div class="empty"><div class="ei">🏧</div></div>';return;}var h='';S.withdrawalsHistory.slice().reverse().slice(0,20).forEach(function(e){h+='<div class="entry-row"><div class="entry-icon" style="background:rgba(239,68,68,.1)">🏧</div><div class="entry-info"><div class="entry-amount" style="color:#ef4444">-'+fmt(e.amount)+'</div><div class="entry-detail">'+esc(e.reason||'')+'</div></div><div class="entry-val">$'+(e.amount/100).toFixed(0)+'</div></div>';});el.innerHTML=h;}

function filterLB(t,v){S.filters[t]=v;renderLB(t);}

function setConn(on,user){var dot=document.getElementById('dot'),badge=document.getElementById('badge'),st=document.getElementById('stxt'),btnCo=document.getElementById('btnCo'),btnDc=document.getElementById('btnDc');if(on){dot.classList.add('on');badge.classList.add('live');st.textContent='🔴 @'+user;btnCo.style.display='none';btnDc.style.display='inline-block';}else{dot.classList.remove('on');badge.classList.remove('live');st.textContent='Déconnecté';btnCo.style.display='inline-block';btnCo.textContent='Connexion';btnCo.disabled=false;btnDc.style.display='none';}}

function doConnect(){var inp=document.getElementById('username'),btn=document.getElementById('btnCo'),u=inp.value.trim();if(!u){inp.focus();return;}btn.disabled=true;btn.textContent='...';fetch('/connect?username='+encodeURIComponent(u)+'&room='+ROOM+'&pin='+encodeURIComponent(PIN)).then(function(r){return r.json()}).then(function(d){if(!d.success){setConn(false);document.getElementById('stxt').textContent='Erreur';}}).catch(function(){setConn(false);btn.disabled=false;btn.textContent='Connexion';});}
function doDisconnect(){fetch('/disconnect?room='+ROOM).then(function(r){return r.json()}).then(function(){setConn(false);});}
function goFiveM(){window.open('/config?room='+ROOM+'&pin='+encodeURIComponent(PIN),'_blank');}
document.getElementById('username').addEventListener('keydown',function(e){if(e.key==='Enter')doConnect();});

function searchViewers(q){var res=document.getElementById('rfResults');if(!q){res.classList.remove('open');return;}q=q.toLowerCase().replace('@','');var all={};Object.values(S.coinsBoard).forEach(function(e){all[e.user]=e.profilePictureUrl||'';});Object.values(S.likesBoard).forEach(function(e){if(!all[e.user])all[e.user]=e.profilePictureUrl||'';});var matches=Object.keys(all).filter(function(u){return u.toLowerCase().indexOf(q)!==-1}).slice(0,6);if(!matches.length){res.classList.remove('open');return;}var h='';matches.forEach(function(u){h+='<div class="rf-item" onclick="selectViewer(\\''+esc(u)+'\\',\\''+safePic(all[u])+'\\')"><img src="'+safePic(all[u])+'" onerror="this.style.display=\\'none\\'"/><span>@'+esc(u)+'</span></div>';});res.innerHTML=h;res.classList.add('open');}
function selectViewer(user,pic){S.selectedUser=user;document.getElementById('rfSearch').style.display='none';document.getElementById('rfResults').classList.remove('open');document.getElementById('rfSelected').style.display='flex';document.getElementById('rfSelName').textContent='@'+user;var img=document.getElementById('rfSelPic');img.src=pic||'';img.style.display=pic?'block':'none';document.getElementById('rfAmount').focus();}
function clearSel(){S.selectedUser=null;document.getElementById('rfSelected').style.display='none';document.getElementById('rfSearch').style.display='block';document.getElementById('rfSearch').value='';}
function sendRedist(){if(!S.selectedUser){toast('error','Sélectionne un viewer');return;}var amount=parseInt(document.getElementById('rfAmount').value);if(!amount||amount<=0){toast('error','Montant invalide');return;}fetch('/api/redistribute',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:S.selectedUser,amount:amount,room:ROOM})}).then(function(r){return r.json()}).then(function(d){if(d.success){toast('success','✅ '+amount+' → @'+S.selectedUser);document.getElementById('rfAmount').value='';clearSel();}else{toast('error','Erreur');}});}

function sendMkt(){var amount=parseInt(document.getElementById('mktAmount').value);if(!amount||amount<=0){toast('error','Montant invalide');return;}var comment=document.getElementById('mktComment').value.trim();fetch('/api/marketing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:amount,comment:comment,room:ROOM})}).then(function(r){return r.json()}).then(function(d){if(d.success){toast('success','📢 +'+amount);document.getElementById('mktAmount').value='';document.getElementById('mktComment').value='';}});}
function sendRwd(){var reason=document.getElementById('rwdReason').value.trim();var amount=parseInt(document.getElementById('rwdAmount').value);if(!reason||!amount){toast('error','Remplir les champs');return;}fetch('/api/rewards',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:amount,reason:reason,room:ROOM})}).then(function(r){return r.json()}).then(function(d){if(d.success){toast('success','🏆 +'+amount);document.getElementById('rwdAmount').value='';document.getElementById('rwdReason').value='';}});}
function sendWdr(){var reason=document.getElementById('wdrReason').value.trim();var amount=parseInt(document.getElementById('wdrAmount').value);if(!reason||!amount){toast('error','Remplir les champs');return;}fetch('/api/withdrawals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:amount,reason:reason,room:ROOM})}).then(function(r){return r.json()}).then(function(d){if(d.success){toast('success','🏧 +'+amount);document.getElementById('wdrAmount').value='';document.getElementById('wdrReason').value='';}});}

function resetData(){if(!confirm('Réinitialiser ?'))return;fetch('/api/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:ROOM})});}
function importSave(event){var file=event.target.files[0];if(!file)return;var reader=new FileReader();reader.onload=function(e){try{var data=JSON.parse(e.target.result);data.room=ROOM;fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(function(){toast('success','Importé');setTimeout(function(){location.reload();},1000);});}catch(err){toast('error','JSON invalide');}};reader.readAsText(file);event.target.value='';}

function toast(type,msg){var t=document.getElementById('dToast');if(!t){t=document.createElement('div');t.id='dToast';t.className='toast';document.body.appendChild(t);}t.className='toast '+type;t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2000);}

initWS();
</script>
</body>
</html>`;

// ================= ROUTES API FIVEM =================
app.get('/api/fivem/actions', (req, res) => {
    res.json({ actions: AVAILABLE_ACTIONS, gifts: TIKTOK_GIFTS });
});

app.get('/api/fivem/config/:roomId', (req, res) => {
    const config = actionsConfig[req.params.roomId] || { enabled: false, mappings: [] };
    res.json(config);
});

app.post('/api/fivem/config/:roomId', (req, res) => {
    const { roomId } = req.params;
    const { enabled, mappings, fivemApiBase } = req.body;
    actionsConfig[roomId] = { enabled: enabled !== false, mappings: mappings || [], fivemApiBase: fivemApiBase || FIVEM_API_BASE, updatedAt: new Date().toISOString() };
    saveActionsConfig();
    res.json({ success: true, config: actionsConfig[roomId] });
});

app.post('/api/fivem/mapping/:roomId', (req, res) => {
    const { roomId } = req.params;
    const { giftName, giftId, actionId, quantity, customAction } = req.body;
    if (!actionsConfig[roomId]) actionsConfig[roomId] = { enabled: true, mappings: [] };
    const existingIndex = actionsConfig[roomId].mappings.findIndex(m => m.giftId === giftId || m.giftName === giftName);
    const newMapping = { giftName, giftId, actionId, quantity: quantity || 1, customAction, createdAt: new Date().toISOString() };
    if (existingIndex >= 0) actionsConfig[roomId].mappings[existingIndex] = newMapping;
    else actionsConfig[roomId].mappings.push(newMapping);
    saveActionsConfig();
    res.json({ success: true, mapping: newMapping });
});

app.delete('/api/fivem/mapping/:roomId/:giftId', (req, res) => {
    const { roomId, giftId } = req.params;
    if (actionsConfig[roomId]) {
        actionsConfig[roomId].mappings = actionsConfig[roomId].mappings.filter(m => m.giftId !== giftId);
        saveActionsConfig();
    }
    res.json({ success: true });
});

app.post('/api/fivem/test', async (req, res) => {
    const { actionId, quantity, customAction } = req.body;
    let action = AVAILABLE_ACTIONS.find(a => a.id === actionId);
    if (!action && customAction) action = customAction;
    if (!action) return res.status(400).json({ success: false, message: 'Action non trouvée' });
    const result = await executeFiveM(action, quantity || 1);
    res.json(result);
});

app.get('/api/fivem/status', async (req, res) => {
    try {
        const response = await fetch('https://servers-frontend.fivem.net/api/servers/single/' + CFX_CODE);
        const data = await response.json();
        res.json({ online: true, players: data.Data?.clients || 0, maxPlayers: data.Data?.sv_maxclients || 32, hostname: data.Data?.hostname || 'Chasseur Chaos', joinLink: FIVEM_JOIN_LINK });
    } catch (error) {
        res.json({ online: false, players: 0, maxPlayers: 32, joinLink: FIVEM_JOIN_LINK });
    }
});

// ================= PAGE REJOINDRE FIVEM =================
app.get('/join', (req, res) => { res.send(FIVEM_JOIN_HTML); });

const FIVEM_JOIN_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Rejoindre Chasseur Chaos | FiveM</title><link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800;900&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}:root{--bg:#0a0a0f;--card:#12121a;--border:#1e1e2e;--red:#ff0033;--gold:#ffd700;--txt:#f0f0f5;--txt2:#6e6e80}body{background:var(--bg);color:var(--txt);font-family:'Outfit',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px}.container{text-align:center;max-width:500px}h1{font-size:48px;font-weight:900;text-transform:uppercase;letter-spacing:4px;margin-bottom:10px;background:linear-gradient(135deg,var(--red),#ff6b6b);-webkit-background-clip:text;-webkit-text-fill-color:transparent}.subtitle{font-size:16px;color:var(--txt2);margin-bottom:40px;letter-spacing:2px}.status-card{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:30px;margin-bottom:30px}.status-row{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:20px}.status-dot{width:14px;height:14px;border-radius:50%;background:#22c55e;box-shadow:0 0 20px #22c55e;animation:pulse 2s infinite}.status-dot.offline{background:#ef4444;box-shadow:0 0 20px #ef4444}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}.status-text{font-size:18px;font-weight:600}.players{font-size:42px;font-weight:900;color:var(--gold);margin-bottom:5px}.players-label{font-size:12px;color:var(--txt2);text-transform:uppercase;letter-spacing:2px}.btn-join{display:inline-block;padding:20px 60px;background:linear-gradient(135deg,var(--red),#cc0029);border:none;border-radius:16px;color:#fff;font-family:'Outfit',sans-serif;font-size:20px;font-weight:800;text-transform:uppercase;letter-spacing:3px;text-decoration:none;cursor:pointer;transition:all .3s;box-shadow:0 10px 40px rgba(255,0,51,.4)}.btn-join:hover{transform:translateY(-4px) scale(1.02);box-shadow:0 15px 50px rgba(255,0,51,.6)}.note{margin-top:20px;font-size:13px;color:var(--txt2)}.note a{color:var(--red);text-decoration:none}.features{display:flex;gap:20px;justify-content:center;margin-top:40px;flex-wrap:wrap}.feature{padding:15px 25px;background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:12px;font-size:14px}.feature-icon{font-size:24px;margin-bottom:8px}</style></head><body><div class="container"><h1>Chasseur Chaos</h1><p class="subtitle">Serveur FiveM Interactif TikTok LIVE</p><div class="status-card"><div class="status-row"><div class="status-dot" id="statusDot"></div><span class="status-text" id="statusText">Vérification...</span></div><div class="players" id="playerCount">-</div><div class="players-label">Joueurs en ligne</div></div><a href="fivem://connect/cfx.re/join/ylmo5k" class="btn-join">🎮 Rejoindre le Serveur</a><p class="note">Nécessite <a href="https://fivem.net/" target="_blank">FiveM</a> installé sur ton PC</p><div class="features"><div class="feature"><div class="feature-icon">🎁</div><div>Cadeaux = Actions</div></div><div class="feature"><div class="feature-icon">🚗</div><div>Spawn Véhicules</div></div><div class="feature"><div class="feature-icon">💥</div><div>Chaos Total</div></div></div></div><script>async function checkStatus(){try{const res=await fetch('/api/fivem/status');const data=await res.json();const dot=document.getElementById('statusDot');const text=document.getElementById('statusText');const count=document.getElementById('playerCount');if(data.online){dot.classList.remove('offline');text.textContent='Serveur en ligne';count.textContent=data.players+'/'+data.maxPlayers;}else{dot.classList.add('offline');text.textContent='Serveur hors ligne';count.textContent='-';}}catch(e){document.getElementById('statusDot').classList.add('offline');document.getElementById('statusText').textContent='Status inconnu';}}checkStatus();setInterval(checkStatus,30000);</script></body></html>`;

// ================= PAGE CONFIG FIVEM =================
app.get('/config', (req, res) => {
    const roomId = req.query.room;
    const pin = req.query.pin || '';
    if (!roomId) return res.redirect('/');
    const expectedPin = ROOM_PINS[roomId] || DEFAULT_PIN;
    if (pin !== expectedPin) return res.redirect('/');
    res.send(FIVEM_CONFIG_HTML);
});

const FIVEM_CONFIG_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Config FiveM</title><link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}:root{--bg:#0a0a0f;--card:#12121a;--border:#1e1e2e;--pk:#fe2c55;--cy:#25f4ee;--txt:#f0f0f5;--txt2:#6e6e80;--green:#22c55e;--red:#ff0033}body{background:var(--bg);color:var(--txt);font-family:'Outfit',sans-serif;min-height:100vh;padding:20px}.container{max-width:1200px;margin:0 auto}.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:30px;flex-wrap:wrap;gap:15px}.header h1{font-size:24px;font-weight:800}.nav-btns{display:flex;gap:10px}.btn{padding:10px 20px;border:none;border-radius:10px;font-family:'Outfit',sans-serif;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s;text-decoration:none;display:inline-flex;align-items:center;gap:6px}.btn-back{background:rgba(255,255,255,.05);border:1px solid var(--border);color:var(--txt2)}.btn-back:hover{background:rgba(255,255,255,.1);color:var(--txt)}.btn-primary{background:linear-gradient(135deg,var(--cy),#1ad4d4);color:#000}.btn-primary:hover{transform:translateY(-2px)}.btn-success{background:linear-gradient(135deg,var(--green),#16a34a);color:#fff}.toggle-section{display:flex;align-items:center;gap:15px;padding:20px;background:var(--card);border:1px solid var(--border);border-radius:16px;margin-bottom:20px}.toggle-label{font-weight:600;flex:1}.toggle{position:relative;width:60px;height:32px;cursor:pointer}.toggle input{display:none}.toggle-slider{position:absolute;inset:0;background:rgba(255,255,255,.1);border-radius:20px;transition:.3s}.toggle-slider::before{content:'';position:absolute;width:26px;height:26px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.3s}.toggle input:checked+.toggle-slider{background:var(--green)}.toggle input:checked+.toggle-slider::before{transform:translateX(28px)}.config-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}@media(max-width:900px){.config-grid{grid-template-columns:1fr}}.panel{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden}.panel-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border)}.panel-title{font-weight:700;font-size:16px}.panel-count{font-family:'JetBrains Mono',monospace;font-size:12px;padding:4px 10px;background:rgba(255,255,255,.05);border-radius:6px;color:var(--txt2)}.panel-body{padding:16px;max-height:400px;overflow-y:auto}.mapping-item{display:flex;align-items:center;gap:12px;padding:12px;background:rgba(255,255,255,.02);border:1px solid var(--border);border-radius:12px;margin-bottom:10px}.mapping-item:hover{border-color:rgba(37,244,238,.2)}.mapping-gift{display:flex;align-items:center;gap:8px;min-width:140px}.mapping-gift .name{font-weight:600;font-size:13px}.mapping-arrow{color:var(--txt2);font-size:18px}.mapping-action{flex:1;display:flex;align-items:center;gap:8px}.mapping-action .name{font-weight:600;font-size:13px}.mapping-qty{font-family:'JetBrains Mono',monospace;font-size:12px;padding:4px 10px;background:rgba(37,244,238,.1);border-radius:6px;color:var(--cy)}.mapping-delete{padding:8px;background:none;border:none;color:var(--txt2);cursor:pointer;border-radius:6px;transition:.2s;font-size:14px}.mapping-delete:hover{background:rgba(239,68,68,.1);color:#ef4444}.add-mapping{padding:20px;border-top:1px solid var(--border)}.add-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}.form-group{display:flex;flex-direction:column;gap:6px;flex:1;min-width:150px}.form-group label{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--txt2)}.form-group select,.form-group input{padding:12px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--txt);font-family:'Outfit',sans-serif;font-size:13px;outline:none}.form-group select:focus,.form-group input:focus{border-color:var(--cy)}.form-group select option{background:var(--card);color:var(--txt)}.action-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}.action-item{display:flex;align-items:center;gap:8px;padding:12px;background:rgba(255,255,255,.02);border:1px solid var(--border);border-radius:10px;font-size:13px}.test-section{margin-top:20px;padding:20px;background:var(--card);border:1px solid var(--border);border-radius:16px}.test-section h3{margin-bottom:15px;font-size:16px}.test-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}.toast{position:fixed;bottom:20px;right:20px;padding:12px 20px;border-radius:12px;font-size:13px;font-weight:500;opacity:0;transform:translateY(10px);transition:.3s;z-index:200}.toast.show{opacity:1;transform:translateY(0)}.toast.success{background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.3);color:var(--green)}.toast.error{background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);color:#ef4444}.status-badge{display:flex;align-items:center;gap:6px;padding:6px 12px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.2);border-radius:8px;font-size:12px;color:var(--green)}.status-badge.offline{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.2);color:#ef4444}.status-badge .dot{width:8px;height:8px;border-radius:50%;background:currentColor;animation:pulse 2s infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}</style></head><body><div class="container"><div class="header"><h1>🎮 Config FiveM - <span id="roomName">Room</span></h1><div class="nav-btns"><div class="status-badge" id="fivemStatus"><span class="dot"></span><span id="fivemStatusText">Vérification...</span></div><a href="/" class="btn btn-back">← Rooms</a><button class="btn btn-primary" onclick="goToDashboard()">Dashboard →</button></div></div><div class="toggle-section"><div class="toggle-label"><div style="font-size:16px">⚡ Activer l'intégration FiveM</div><div style="font-size:12px;color:var(--txt2);margin-top:4px">Les cadeaux TikTok déclencheront des actions dans GTA</div></div><label class="toggle"><input type="checkbox" id="enableToggle" onchange="toggleEnabled()"><span class="toggle-slider"></span></label></div><div class="config-grid"><div class="panel"><div class="panel-header"><div class="panel-title">🎁 Mappings Configurés</div><div class="panel-count" id="mappingCount">0</div></div><div class="panel-body" id="mappingsList"><div style="text-align:center;padding:40px;color:var(--txt2)"><div style="font-size:32px;margin-bottom:10px">🎯</div><div>Aucun mapping configuré</div></div></div><div class="add-mapping"><div class="add-row"><div class="form-group"><label>Cadeau TikTok</label><select id="selectGift"></select></div><div class="form-group"><label>Action FiveM</label><select id="selectAction"></select></div><div class="form-group" style="flex:0 0 80px"><label>Quantité</label><input type="number" id="inputQty" value="1" min="1" max="10"></div><button class="btn btn-success" onclick="addMapping()">+ Ajouter</button></div></div></div><div class="panel"><div class="panel-header"><div class="panel-title">⚡ Actions Disponibles</div><div class="panel-count" id="actionCount">0</div></div><div class="panel-body"><div class="action-list" id="actionsList"></div></div></div></div><div class="test-section"><h3>🧪 Tester une action</h3><div class="test-row"><div class="form-group" style="flex:0 0 200px"><label>Action à tester</label><select id="testAction"></select></div><div class="form-group" style="flex:0 0 80px"><label>Quantité</label><input type="number" id="testQty" value="1" min="1" max="5"></div><button class="btn btn-primary" onclick="testAction()" style="margin-top:auto">🚀 Tester</button></div></div></div><div class="toast" id="toast"></div><script>var params=new URLSearchParams(window.location.search);var ROOM=params.get('room');var PIN=params.get('pin')||'';if(!ROOM)window.location.href='/';var availableActions=[],tiktokGifts=[],currentConfig={enabled:false,mappings:[]};async function init(){var res=await fetch('/api/fivem/actions');var data=await res.json();availableActions=data.actions;tiktokGifts=data.gifts;var configRes=await fetch('/api/fivem/config/'+ROOM);currentConfig=await configRes.json();var roomsRes=await fetch('/api/rooms');var roomsData=await roomsRes.json();var roomInfo=roomsData.rooms.find(function(r){return r.id===ROOM});if(roomInfo)document.getElementById('roomName').textContent=roomInfo.name;renderAll();checkFiveMStatus();}function renderAll(){document.getElementById('enableToggle').checked=currentConfig.enabled;var actionsHtml='';availableActions.forEach(function(a){actionsHtml+='<div class="action-item"><span>'+a.name+'</span></div>';});document.getElementById('actionsList').innerHTML=actionsHtml;document.getElementById('actionCount').textContent=availableActions.length;var giftOptions='<option value="">Choisir...</option>';tiktokGifts.forEach(function(g){giftOptions+='<option value="'+g.id+'">'+g.name+' ('+g.diamonds+'💎)</option>';});document.getElementById('selectGift').innerHTML=giftOptions;var actionOptions='<option value="">Choisir...</option>';availableActions.forEach(function(a){actionOptions+='<option value="'+a.id+'">'+a.name+'</option>';});document.getElementById('selectAction').innerHTML=actionOptions;document.getElementById('testAction').innerHTML=actionOptions;renderMappings();}function renderMappings(){var mappings=currentConfig.mappings||[];document.getElementById('mappingCount').textContent=mappings.length;if(mappings.length===0){document.getElementById('mappingsList').innerHTML='<div style="text-align:center;padding:40px;color:var(--txt2)"><div style="font-size:32px;margin-bottom:10px">🎯</div><div>Aucun mapping configuré</div></div>';return;}var html='';mappings.forEach(function(m){var gift=tiktokGifts.find(function(g){return g.id===m.giftId})||{name:m.giftName||m.giftId};var action=availableActions.find(function(a){return a.id===m.actionId})||{name:m.actionId};html+='<div class="mapping-item"><div class="mapping-gift"><span class="name">'+gift.name+'</span></div><span class="mapping-arrow">→</span><div class="mapping-action"><span class="name">'+action.name+'</span></div><span class="mapping-qty">x'+(m.quantity||1)+'</span><button class="mapping-delete" onclick="deleteMapping(\\''+m.giftId+'\\')">🗑️</button></div>';});document.getElementById('mappingsList').innerHTML=html;}async function toggleEnabled(){currentConfig.enabled=document.getElementById('enableToggle').checked;await saveConfig();toast('success',currentConfig.enabled?'✅ FiveM activé':'⏸️ FiveM désactivé');}async function addMapping(){var giftId=document.getElementById('selectGift').value;var actionId=document.getElementById('selectAction').value;var qty=parseInt(document.getElementById('inputQty').value)||1;if(!giftId||!actionId){toast('error','Sélectionne un cadeau et une action');return;}var gift=tiktokGifts.find(function(g){return g.id===giftId});await fetch('/api/fivem/mapping/'+ROOM,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({giftId:giftId,giftName:gift?gift.name:giftId,actionId:actionId,quantity:qty})});var configRes=await fetch('/api/fivem/config/'+ROOM);currentConfig=await configRes.json();renderMappings();document.getElementById('selectGift').value='';document.getElementById('selectAction').value='';document.getElementById('inputQty').value='1';toast('success','✅ Mapping ajouté');}async function deleteMapping(giftId){await fetch('/api/fivem/mapping/'+ROOM+'/'+giftId,{method:'DELETE'});var configRes=await fetch('/api/fivem/config/'+ROOM);currentConfig=await configRes.json();renderMappings();toast('success','🗑️ Mapping supprimé');}async function saveConfig(){await fetch('/api/fivem/config/'+ROOM,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(currentConfig)});}async function testAction(){var actionId=document.getElementById('testAction').value;var qty=parseInt(document.getElementById('testQty').value)||1;if(!actionId){toast('error','Sélectionne une action');return;}toast('success','🚀 Test envoyé...');var res=await fetch('/api/fivem/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({actionId:actionId,quantity:qty})});var data=await res.json();if(data.success)toast('success','✅ Action exécutée !');else toast('error','❌ Erreur: '+(data.error||'Serveur FiveM injoignable'));}async function checkFiveMStatus(){try{var res=await fetch('/api/fivem/status');var data=await res.json();var badge=document.getElementById('fivemStatus');var text=document.getElementById('fivemStatusText');if(data.online){badge.classList.remove('offline');text.textContent='FiveM: '+data.players+'/'+data.maxPlayers;}else{badge.classList.add('offline');text.textContent='FiveM: Hors ligne';}}catch(e){document.getElementById('fivemStatus').classList.add('offline');document.getElementById('fivemStatusText').textContent='FiveM: Inconnu';}}function goToDashboard(){window.location.href='/dashboard?room='+ROOM+'&pin='+encodeURIComponent(PIN);}function toast(type,msg){var t=document.getElementById('toast');t.className='toast '+type;t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show');},2500);}init();setInterval(checkFiveMStatus,30000);</script></body></html>`;

console.log('🎮 Module FiveM chargé');

// ================= DÉMARRAGE =================
server.listen(PORT, '0.0.0.0', () => {
    console.log('=========================================');
    console.log('🚀 SERVEUR TIKTOK LIVE MULTI-ROOMS');
    console.log('🌐 http://localhost:' + PORT);
    console.log('🏠 20 rooms disponibles');
    console.log('=========================================');
});
