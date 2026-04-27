const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '50mb' }));

const users = new Map();
const userSockets = new Map();
const userData = new Map();
const privateRooms = new Map();
let globalMessages = [];
let mediaPosts = [];
const userVisits = new Map();

const ADMIN_PASSWORD = '2016';

setInterval(() => {
    const now = Date.now();
    mediaPosts = mediaPosts.filter(post => post.expiresAt > now);
    io.emit('media posts update', mediaPosts);
}, 60000);

io.on('connection', (socket) => {
    console.log(`Conectado: ${socket.id}`);

    socket.on('set username', ({ username, language, country, gender }, callback) => {
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

        users.set(socket.id, { username, coins: initialCoins, language, country, gender });
        userSockets.set(username, socket.id);
        userData.set(username, { language, country, blocked: false, gender });
        socket.username = username;
        socket.coins = initialCoins;
        socket.language = language;
        socket.gender = gender;
        socket.join('global');

        callback(true, { coins: initialCoins });
        socket.broadcast.emit('system message', { text: `✨ ${username} (${country}) se ha unido`, timestamp: Date.now() });
        broadcastUserList();
        socket.emit('global history', globalMessages);
        socket.emit('media posts update', mediaPosts);
    });

    function broadcastUserList() {
        const list = Array.from(users.values()).map(u => ({ username: u.username, coins: u.coins, language: u.language, country: u.country, gender: u.gender }));
        io.emit('user list', list);
    }

    socket.on('chat message', ({ text, room }) => {
        if (!socket.username) return;
        const msg = {
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 6),
            type: 'text',
            username: socket.username,
            text: text,
            timestamp: Date.now(),
            originalLang: socket.language || 'es',
            gender: socket.gender
        };
        if (room && room !== 'global') {
            io.to(room).emit('private message', msg);
        } else {
            globalMessages.push(msg);
            if (globalMessages.length > 200) globalMessages.shift();
            io.emit('chat message', msg);
        }
    });

    socket.on('audio message', ({ audioData, room }) => {
        if (!socket.username) return;
        const msg = {
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 6),
            type: 'audio',
            username: socket.username,
            audioData: audioData,
            timestamp: Date.now(),
            originalLang: socket.language || 'es',
            gender: socket.gender
        };
        if (room && room !== 'global') {
            io.to(room).emit('audio message', msg);
        } else {
            globalMessages.push(msg);
            if (globalMessages.length > 200) globalMessages.shift();
            io.emit('audio message', msg);
        }
    });

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
            likedBy: [],
            gender: socket.gender
        };
        mediaPosts.push(post);
        io.emit('media posts update', mediaPosts);
    });

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

    socket.on('delete media', ({ postId }) => {
        const index = mediaPosts.findIndex(p => p.id === postId && p.username === socket.username);
        if (index !== -1) {
            mediaPosts.splice(index, 1);
            io.emit('media posts update', mediaPosts);
        }
    });

    socket.on('delete message', ({ messageId }) => {
        const index = globalMessages.findIndex(m => m.id === messageId && m.username === socket.username);
        if (index !== -1) {
            globalMessages.splice(index, 1);
            io.emit('message deleted', messageId);
        }
    });

    // Videollamada
    socket.on('check call cost', ({ durationMinutes }, callback) => {
        const user = users.get(socket.id);
        const cost = Math.ceil(durationMinutes / 2) * 1.5;
        callback({ canAfford: user && user.coins >= cost, cost });
    });

    socket.on('call-offer', ({ offer, targetUser, durationMinutes }) => {
        const targetId = userSockets.get(targetUser);
        if (targetId) {
            const caller = users.get(socket.id);
            const cost = Math.ceil(durationMinutes / 2) * 1.5;
            if (caller && caller.coins >= cost) {
                caller.coins -= cost;
                users.set(socket.id, caller);
                io.to(socket.id).emit('coins update', caller.coins);
                broadcastUserList();
                io.to(targetId).emit('call-offer', { offer, from: socket.username, durationMinutes });
            }
        }
    });

    socket.on('call-answer', ({ answer, to }) => {
        const toId = userSockets.get(to);
        if (toId) {
            io.to(toId).emit('call-answer', { answer });
        }
    });

    socket.on('ice-candidate', ({ candidate, targetUser }) => {
        const targetId = userSockets.get(targetUser);
        if (targetId) {
            io.to(targetId).emit('ice-candidate', { candidate });
        }
    });

    socket.on('call-reject', ({ from }) => {
        const fromId = userSockets.get(from);
        if (fromId) {
            io.to(fromId).emit('call-reject', { from: socket.username });
        }
    });

    socket.on('end-call', () => {
        socket.broadcast.emit('call-ended');
    });

    socket.on('request coins', ({ amount }) => {
        if (!socket.username) return;
    });

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
server.listen(PORT, () => console.log(`🚀 Servidor en http://localhost:${PORT}`));
