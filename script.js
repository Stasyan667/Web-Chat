const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Хранилище данных
let users = new Map();
let userCodes = new Map();
let rooms = {
    'main': { name: 'Общая', users: new Set(), messages: [] },
    'work': { name: 'Работа', users: new Set(), messages: [] },
    'games': { name: 'Игры', users: new Set(), messages: [] }
};
let privateRooms = new Map();
let friendRequests = new Map();
let friends = new Map();

io.on('connection', (socket) => {
    console.log('Пользователь подключился:', socket.id);
    
    // Регистрация пользователя
    socket.on('user:register', (userData) => {
        if (!userData.friendCode) {
            userData.friendCode = 'USR' + Math.floor(Math.random() * 10000);
        }
        
        users.set(socket.id, {
            ...userData,
            online: true,
            lastSeen: new Date()
        });
        
        userCodes.set(userData.friendCode, socket.id);
        
        socket.emit('user:registered', {
            friendCode: userData.friendCode,
            id: socket.id
        });
        
        console.log(`Пользователь ${userData.name} зарегистрирован с кодом ${userData.friendCode}`);
        
        // Обновляем онлайн счетчик во всех комнатах, где есть пользователь
        updateAllOnlineCounts();
    });
    
    // Поиск пользователя по коду
    socket.on('user:findByCode', (code) => {
        const userId = userCodes.get(code);
        if (userId && users.has(userId)) {
            const user = users.get(userId);
            socket.emit('user:found', {
                id: userId,
                name: user.name,
                avatar: user.avatar,
                online: user.online
            });
        } else {
            socket.emit('user:notFound');
        }
    });
    
    // Отправка запроса в друзья
    socket.on('friend:request', (toCode) => {
        const toId = userCodes.get(toCode);
        if (!toId || !users.has(toId)) {
            socket.emit('friend:error', 'Пользователь не найден');
            return;
        }
        
        const fromUser = users.get(socket.id);
        
        if (!friendRequests.has(toId)) {
            friendRequests.set(toId, []);
        }
        friendRequests.get(toId).push({
            fromId: socket.id,
            fromName: fromUser.name,
            fromAvatar: fromUser.avatar,
            fromCode: fromUser.friendCode
        });
        
        io.to(toId).emit('friend:request', {
            fromId: socket.id,
            fromName: fromUser.name,
            fromAvatar: fromUser.avatar,
            fromCode: fromUser.friendCode
        });
        
        socket.emit('friend:requestSent');
    });
    
    // Принятие запроса в друзья
    socket.on('friend:accept', (fromId) => {
        if (!friends.has(socket.id)) friends.set(socket.id, new Set());
        if (!friends.has(fromId)) friends.set(fromId, new Set());
        
        friends.get(socket.id).add(fromId);
        friends.get(fromId).add(socket.id);
        
        if (friendRequests.has(socket.id)) {
            const requests = friendRequests.get(socket.id).filter(r => r.fromId !== fromId);
            if (requests.length === 0) {
                friendRequests.delete(socket.id);
            } else {
                friendRequests.set(socket.id, requests);
            }
        }
        
        const fromUser = users.get(fromId);
        const toUser = users.get(socket.id);
        
        io.to(fromId).emit('friend:accepted', {
            id: socket.id,
            name: toUser.name,
            avatar: toUser.avatar,
            online: true
        });
        
        socket.emit('friend:accepted', {
            id: fromId,
            name: fromUser.name,
            avatar: fromUser.avatar,
            online: true
        });
    });
    
    // Отклонение запроса
    socket.on('friend:decline', (fromId) => {
        if (friendRequests.has(socket.id)) {
            const requests = friendRequests.get(socket.id).filter(r => r.fromId !== fromId);
            if (requests.length === 0) {
                friendRequests.delete(socket.id);
            } else {
                friendRequests.set(socket.id, requests);
            }
        }
        socket.emit('friend:declined');
    });
    
    // Подключение к комнате
    socket.on('room:join', (roomId, callback) => {
        // Выходим из предыдущих комнат
        socket.rooms.forEach(room => {
            if (room !== socket.id) socket.leave(room);
        });
        
        socket.join(roomId);
        socket.data.currentRoom = roomId;
        
        // Добавляем пользователя в список комнаты
        if (rooms[roomId]) {
            rooms[roomId].users.add(socket.id);
            const messages = rooms[roomId].messages || [];
            callback({ 
                messages: messages,
                users: Array.from(rooms[roomId].users).map(id => ({
                    id,
                    name: users.get(id)?.name || 'Аноним',
                    avatar: users.get(id)?.avatar || '👤'
                }))
            });
        } else if (privateRooms.has(roomId)) {
            const room = privateRooms.get(roomId);
            room.users.add(socket.id);
            callback({ 
                messages: room.messages || [],
                users: Array.from(room.users).map(id => ({
                    id,
                    name: users.get(id)?.name || 'Аноним',
                    avatar: users.get(id)?.avatar || '👤'
                }))
            });
        }
        
        // Уведомляем всех в комнате
        const userName = users.get(socket.id)?.name || 'Аноним';
        io.to(roomId).emit('user:joined', userName);
        updateOnlineCount(roomId);
        
        // Также обновляем онлайн счетчик для всех
        updateAllOnlineCounts();
    });
    
    // Отправка сообщения
    socket.on('message:send', (messageData) => {
        const roomId = socket.data.currentRoom;
        const user = users.get(socket.id);
        
        const message = {
            author: user?.name || 'Аноним',
            avatar: user?.avatar || '👤',
            avatarBg: user?.avatarBackground || 'theme-default',
            text: messageData.text,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            id: Date.now()
        };
        
        if (rooms[roomId]) {
            if (!rooms[roomId].messages) rooms[roomId].messages = [];
            rooms[roomId].messages.push(message);
        } else if (privateRooms.has(roomId)) {
            const room = privateRooms.get(roomId);
            if (!room.messages) room.messages = [];
            room.messages.push(message);
        }
        
        io.to(roomId).emit('message:new', message);
    });
    
    // Создание приватной комнаты
    socket.on('room:create', ({ name, password }) => {
        const roomId = 'priv_' + Date.now();
        privateRooms.set(roomId, {
            name,
            password,
            users: new Set([socket.id]),
            messages: []
        });
        socket.emit('room:created', { id: roomId, name });
    });
    
    // Подключение к приватной комнате
    socket.on('room:joinPrivate', ({ name, password }) => {
        for (let [id, room] of privateRooms) {
            if (room.name === name && room.password === password) {
                socket.emit('room:joined', { id, name: room.name });
                return;
            }
        }
        socket.emit('room:error', 'Комната не найдена или неверный пароль');
    });
    
    // Отключение пользователя
    socket.on('disconnect', () => {
        console.log('Пользователь отключился:', socket.id);
        const user = users.get(socket.id);
        
        // Удаляем из всех комнат
        for (let roomId in rooms) {
            if (rooms[roomId].users.has(socket.id)) {
                rooms[roomId].users.delete(socket.id);
                io.to(roomId).emit('user:left', user?.name || 'Аноним');
                updateOnlineCount(roomId);
            }
        }
        for (let [roomId, room] of privateRooms) {
            if (room.users.has(socket.id)) {
                room.users.delete(socket.id);
                io.to(roomId).emit('user:left', user?.name || 'Аноним');
                updateOnlineCount(roomId);
            }
        }
        
        if (user) {
            user.online = false;
            user.lastSeen = new Date();
        }
        
        // Обновляем онлайн счетчики после отключения
        updateAllOnlineCounts();
    });
});

// Функция обновления онлайн счетчика для конкретной комнаты
function updateOnlineCount(roomId) {
    let count = 0;
    if (rooms[roomId]) {
        count = rooms[roomId].users.size;
    } else if (privateRooms.has(roomId)) {
        count = privateRooms.get(roomId).users.size;
    }
    io.to(roomId).emit('online:update', count);
    console.log(`Комната ${roomId}: ${count} онлайн`);
}

// Функция обновления онлайн счетчиков для всех комнат
function updateAllOnlineCounts() {
    for (let roomId in rooms) {
        updateOnlineCount(roomId);
    }
    for (let [roomId, room] of privateRooms) {
        updateOnlineCount(roomId);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});