const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

// Filtro de palabras ofensivas
const badWords = ['puto', 'puta', 'mierda', 'coño', 'joder', 'gilipollas', 'idiota', 'estúpido'];
const filterMessage = (text) => {
    let filtered = text;
    badWords.forEach(word => {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        filtered = filtered.replace(regex, '****');
    });
    return filtered;
};

const users = new Map(); // socketId -> { username, coins, language, country }
const userSockets = new Map(); // username -> socketId
const userData = new Map(); // username -> { language, country, blocked }
const privateRooms = new Map();
let globalMessages = [];
let mediaPosts = [];
const userVisits = new Map();
let pendingCoinRequests = [];

const ADMIN_PASSWORD = '2016';
const ADMIN_USERNAME = 'admin';

setInterval(() => {
    const now = Date.now();
    mediaPosts = mediaPosts.filter(post => post.expiresAt > now);
    io.emit('media posts update', mediaPosts);
}, 60000);

io.on('connection', (socket) => {
    console.log(`Conectado: ${socket.id}`);

    socket.on('set username', ({ username, language, country }, callback) => {
        if (userData.get(username)?.blocked) {
            callback(false, 'Usuario bloqueado');
            return;
        }
        if (Array.from(users.values()).some(u => u.username === username)) {
            callback(false, 'Nombre ya en uso');
            return;
        }
        let visitCount = userVisits.get(username) || 0;
        let initialCoins = visitCount === 0 ? 6 : visitCount === 1 ? 3 : visitCount === 2 ? 1 : 0;
        userVisits.set(username, visitCount + 1);

        users.set(socket.id, { username, coins: initialCoins, language, country });
        userSockets.set(username, socket.id);
        userData.set(username, { language, country, blocked: false });
        socket.username = username;
        socket.coins = initialCoins;
        socket.language = language;
        socket.join('global');

        callback(true, { coins: initialCoins });
        socket.broadcast.emit('system message', { text: `✨ ${username} (${country}) se ha unido`, timestamp: Date.now() });
        broadcastUserList();
        socket.emit('global history', globalMessages);
        socket.emit('media posts update', mediaPosts);
    });

    function broadcastUserList() {
        const list = Array.from(users.values()).map(u => ({ username: u.username, coins: u.coins, language: u.language, country: u.country }));
        io.emit('user list', list);
    }

    // Mensaje de texto (global o privado)
    socket.on('chat message', ({ text, room }) => {
        if (!socket.username) return;
        const filtered = filterMessage(text);
        const msg = {
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 6),
            type: 'text',
            username: socket.username,
            text: filtered,
            timestamp: Date.now(),
            originalLang: socket.language || 'es'
        };
        if (room && room !== 'global') {
            io.to(room).emit('private message', msg);
        } else {
            globalMessages.push(msg);
            if (globalMessages.length > 200) globalMessages.shift();
            io.emit('chat message', msg);
        }
    });

    // Subir multimedia
    socket.on('media message', ({ mediaType, content }) => {
        if (!socket.username) return;
        const postId = Date.now() + '-' + Math.random().toString(36).substr(2, 6);
        const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
        const post = {
            id: postId,
            type: mediaType,
            username: socket.username,
            content: content,
            timestamp: Date.now(),
            expiresAt: expiresAt,
            likes: 0,
            likedBy: []
        };
        mediaPosts.push(post);
        io.emit('media posts update', mediaPosts);
        io.emit('chat message', {
            id: Date.now() + '-info',
            type: 'text',
            username: 'Sistema',
            text: `📸 ${socket.username} subió ${mediaType === 'image' ? 'una imagen' : 'un video'}`,
            timestamp: Date.now()
        });
    });

    // Like
    socket.on('like content', ({ contentId }) => {
        const post = mediaPosts.find(p => p.id === contentId);
        if (!post || post.likedBy.includes(socket.username)) return;
        post.likes++;
        post.likedBy.push(socket.username);
        io.emit('media posts update', mediaPosts);
        const ownerId = userSockets.get(post.username);
        if (ownerId && post.username !== socket.username) {
            const owner = users.get(ownerId);
            if (owner) {
                const newCoins = Math.floor(post.likes / 10);
                if (newCoins > owner.coins) {
                    owner.coins = newCoins;
                    users.set(ownerId, owner);
                    io.to(ownerId).emit('coins update', owner.coins);
                    broadcastUserList();
                }
            }
        }
    });

    // Eliminar post
    socket.on('delete media', ({ postId }) => {
        const index = mediaPosts.findIndex(p => p.id === postId && p.username === socket.username);
        if (index !== -1) {
            mediaPosts.splice(index, 1);
            io.emit('media posts update', mediaPosts);
        }
    });

    // Eliminar mensaje propio
    socket.on('delete message', ({ messageId }) => {
        const index = globalMessages.findIndex(m => m.id === messageId && m.username === socket.username);
        if (index !== -1) {
            globalMessages.splice(index, 1);
            io.emit('message deleted', messageId);
        }
    });

    // ADMIN: login
    socket.on('admin login', (password, callback) => {
        if (password === ADMIN_PASSWORD) {
            socket.isAdmin = true;
            callback(true);
            socket.emit('admin pending requests', pendingCoinRequests);
        } else {
            callback(false);
        }
    });

    // ADMIN: dar monedas por nombre
    socket.on('admin give coins', ({ targetUsername, amount }, callback) => {
        if (!socket.isAdmin) {
            callback({ success: false, error: 'No autorizado' });
            return;
        }
        const targetId = userSockets.get(targetUsername);
        if (!targetId) {
            callback({ success: false, error: 'Usuario no conectado' });
            return;
        }
        const target = users.get(targetId);
        target.coins += amount;
        users.set(targetId, target);
        io.to(targetId).emit('coins update', target.coins);
        broadcastUserList();
        callback({ success: true });
    });

    // ADMIN: bloquear/desbloquear
    socket.on('admin toggle block', ({ targetUsername, block }, callback) => {
        if (!socket.isAdmin) {
            callback({ success: false, error: 'No autorizado' });
            return;
        }
        const info = userData.get(targetUsername);
        if (!info) {
            callback({ success: false, error: 'Usuario no existe' });
            return;
        }
        info.blocked = block;
        userData.set(targetUsername, info);
        if (block) {
            const targetId = userSockets.get(targetUsername);
            if (targetId) {
                io.to(targetId).emit('force logout', 'Has sido bloqueado');
                io.sockets.sockets.get(targetId)?.disconnect(true);
                userSockets.delete(targetUsername);
            }
        }
        callback({ success: true });
        broadcastUserList();
    });

    // ADMIN: resolver solicitud de monedas
    socket.on('admin resolve request', ({ requestIndex, giveCoins }) => {
        if (!socket.isAdmin) return;
        const req = pendingCoinRequests[requestIndex];
        if (!req) return;
        if (giveCoins) {
            const targetId = userSockets.get(req.from);
            if (targetId) {
                const target = users.get(targetId);
                target.coins += req.amount;
                users.set(targetId, target);
                io.to(targetId).emit('coins update', target.coins);
                io.to(targetId).emit('system message', { text: `💰 Admin te dio ${req.amount} monedas.`, timestamp: Date.now() });
                broadcastUserList();
            }
        }
        pendingCoinRequests.splice(requestIndex, 1);
        if (socket.isAdmin) {
            socket.emit('admin pending requests', pendingCoinRequests);
        }
        for (let [id, sock] of io.sockets.sockets) {
            if (sock.isAdmin) sock.emit('admin pending requests', pendingCoinRequests);
        }
    });

    // Solicitud de monedas (usuario -> admin)
    socket.on('request coins', ({ amount, message }) => {
        if (!socket.username) return;
        pendingCoinRequests.push({ from: socket.username, amount, message, timestamp: Date.now() });
        const adminId = userSockets.get(ADMIN_USERNAME);
        if (adminId) {
            io.to(adminId).emit('new coin request', pendingCoinRequests[pendingCoinRequests.length - 1]);
        }
    });

    // Videollamada
    socket.on('start call', ({ targetUsername, durationMinutes }, callback) => {
        const caller = users.get(socket.id);
        const targetId = userSockets.get(targetUsername);
        if (!targetId) {
            callback({ success: false, error: 'Usuario no conectado' });
            return;
        }
        const cost = Math.ceil(durationMinutes / 2) * 1.5;
        if (caller.coins < cost) {
            callback({ success: false, error: `Necesitas ${cost} monedas` });
            return;
        }
        caller.coins -= cost;
        users.set(socket.id, caller);
        io.to(socket.id).emit('coins update', caller.coins);
        io.to(targetId).emit('incoming call', { from: socket.username, durationMinutes, cost });
        callback({ success: true, message: `Llamada iniciada (${cost} monedas)` });
        broadcastUserList();
    });

    socket.on('accept call', ({ fromUsername }) => {
        const fromId = userSockets.get(fromUsername);
        if (fromId) {
            io.to(fromId).emit('call accepted', { message: `${socket.username} aceptó la llamada` });
            io.to(socket.id).emit('call started', { withUser: fromUsername });
        }
    });

    socket.on('reject call', ({ fromUsername }) => {
        const fromId = userSockets.get(fromUsername);
        if (fromId) {
            io.to(fromId).emit('call rejected', { message: `${socket.username} rechazó la llamada` });
        }
    });

    // Chat privado
    socket.on('start private chat', ({ targetUsername }, callback) => {
        if (!socket.username || targetUsername === socket.username) {
            callback({ success: false, error: 'No puedes chatear contigo mismo' });
            return;
        }
        const targetId = userSockets.get(targetUsername);
        if (!targetId) {
            callback({ success: false, error: 'Usuario no conectado' });
            return;
        }
        const participants = [socket.username, targetUsername].sort();
        const roomName = `private_${participants[0]}_${participants[1]}`;
        if (!privateRooms.has(roomName)) {
            privateRooms.set(roomName, { participants, createdAt: Date.now() });
        }
        socket.join(roomName);
        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) targetSocket.join(roomName);
        callback({ success: true, roomName, otherUser: targetUsername });
        io.to(targetId).emit('private chat started', { withUser: socket.username, roomName });
    });

    socket.on('leave private chat', ({ roomName }) => {
        if (roomName && socket.rooms.has(roomName)) {
            socket.leave(roomName);
            socket.emit('private chat closed', { roomName });
            setTimeout(() => {
                const roomSockets = io.sockets.adapter.rooms.get(roomName);
                if (!roomSockets || roomSockets.size === 0) privateRooms.delete(roomName);
            }, 1000);
        }
    });

    socket.on('logout', () => {
        if (socket.username) {
            users.delete(socket.id);
            userSockets.delete(socket.username);
            io.emit('system message', { text: `👋 ${socket.username} salió`, timestamp: Date.now() });
            broadcastUserList();
            socket.disconnect(true);
        }
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            users.delete(socket.id);
            userSockets.delete(socket.username);
            io.emit('system message', { text: `⚠️ ${socket.username} se desconectó`, timestamp: Date.now() });
            broadcastUserList();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
