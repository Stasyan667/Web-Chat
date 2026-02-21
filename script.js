const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');

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

// Подключение к MongoDB Atlas
mongoose.connect('mongodb+srv://Stasyan667:Stasyan667@stasyan667.etwjg3c.mongodb.net/chatdb?retryWrites=true&w=majority')
    .then(() => console.log('✅ Подключено к MongoDB'))
    .catch(err => console.log('❌ Ошибка MongoDB:', err));

// Схемы для MongoDB
const userSchema = new mongoose.Schema({
    socketId: String,
    name: String,
    email: String,
    password: String,
    country: String,
    avatar: String,
    avatarBackground: String,
    friendCode: { type: String, unique: true },
    online: Boolean,
    lastSeen: Date,
    friends: [String],
    blacklist: [String]
});

const messageSchema = new mongoose.Schema({
    roomId: String,
    author: String,
    authorId: String,
    text: String,
    avatar: String,
    avatarBg: String,
    time: String,
    timestamp: { type: Date, default: Date.now },
    reactions: { type: Map, of: [String], default: {} }
});

const privateRoomSchema = new mongoose.Schema({
    roomId: { type: String, unique: true },
    name: String,
    password: String,
    createdBy: String,
    createdAt: { type: Date, default: Date.now },
    users: [String]
});

// Модели
const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const PrivateRoom = mongoose.model('PrivateRoom', privateRoomSchema);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Хранилище данных (временное, для онлайн-статусов)
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

// Загрузка сохраненных сообщений при старте
async function loadSavedMessages() {
    try {
        const allMessages = await Message.find().lean();
        allMessages.forEach(msg => {
            if (!rooms[msg.roomId]) {
                rooms[msg.roomId] = { name: msg.roomId, users: new Set(), messages: [] };
            }
            rooms[msg.roomId].messages.push(msg);
        });
        console.log('✅ Загружены сохраненные сообщения');
    } catch (err) {
        console.log('❌ Ошибка загрузки сообщений:', err);
    }
}
loadSavedMessages();

io.on('connection', (socket) => {
    console.log('Пользователь подключился:', socket.id);
    
    // Регистрация пользователя
    socket.on('user:register', async (userData) => {
        try {
            if (!userData.friendCode) {
                userData.friendCode = 'USR' + Math.floor(Math.random() * 10000);
            }
            
            // Сохраняем в MongoDB
            let user = await User.findOne({ friendCode: userData.friendCode });
            if (!user) {
                user = new User({
                    socketId: socket.id,
                    ...userData,
                    online: true,
                    lastSeen: new Date(),
                    friends: [],
                    blacklist: []
                });
                await user.save();
            } else {
                user.socketId = socket.id;
                user.online = true;
                user.lastSeen = new Date();
                await user.save();
            }
            
            // Сохраняем в памяти
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
            updateAllOnlineCounts();
        } catch (err) {
            console.log('Ошибка регистрации:', err);
        }
    });
    
    // Поиск пользователя по коду
    socket.on('user:findByCode', async (code) => {
        try {
            const user = await User.findOne({ friendCode: code });
            if (user) {
                socket.emit('user:found', {
                    id: user.socketId,
                    name: user.name,
                    avatar: user.avatar,
                    online: user.online
                });
            } else {
                socket.emit('user:notFound');
            }
        } catch (err) {
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
    socket.on('friend:accept', async (fromId) => {
        try {
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
            
            // Сохраняем в MongoDB
            await User.findOneAndUpdate(
                { socketId: socket.id },
                { $addToSet: { friends: fromId } }
            );
            await User.findOneAndUpdate(
                { socketId: fromId },
                { $addToSet: { friends: socket.id } }
            );
            
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
        } catch (err) {
            console.log('Ошибка принятия запроса:', err);
        }
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
    socket.on('room:join', async (roomId, callback) => {
        try {
            // Выходим из предыдущих комнат
            socket.rooms.forEach(room => {
                if (room !== socket.id) socket.leave(room);
            });
            
            socket.join(roomId);
            socket.data.currentRoom = roomId;
            
            // Загружаем историю сообщений из MongoDB
            const savedMessages = await Message.find({ roomId }).sort({ timestamp: -1 }).limit(50).lean();
            
            if (rooms[roomId]) {
                rooms[roomId].users.add(socket.id);
                callback({ 
                    messages: savedMessages.reverse(),
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
                    messages: savedMessages.reverse(),
                    users: Array.from(room.users).map(id => ({
                        id,
                        name: users.get(id)?.name || 'Аноним',
                        avatar: users.get(id)?.avatar || '👤'
                    }))
                });
            }
            
            const userName = users.get(socket.id)?.name || 'Аноним';
            io.to(roomId).emit('user:joined', userName);
            updateOnlineCount(roomId);
            updateAllOnlineCounts();
        } catch (err) {
            console.log('Ошибка подключения к комнате:', err);
        }
    });
    
    // Отправка сообщения
    socket.on('message:send', async (messageData) => {
        try {
            const roomId = socket.data.currentRoom;
            const user = users.get(socket.id);
            
            const message = {
                author: user?.name || 'Аноним',
                authorId: socket.id,
                avatar: user?.avatar || '👤',
                avatarBg: user?.avatarBackground || 'theme-default',
                text: messageData.text,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                roomId: roomId,
                reactions: {}
            };
            
            // Сохраняем в MongoDB
            const newMessage = new Message(message);
            await newMessage.save();
            
            // Добавляем ID
            message.id = newMessage._id;
            
            // Сохраняем в памяти
            if (rooms[roomId]) {
                if (!rooms[roomId].messages) rooms[roomId].messages = [];
                rooms[roomId].messages.push(message);
            } else if (privateRooms.has(roomId)) {
                const room = privateRooms.get(roomId);
                if (!room.messages) room.messages = [];
                room.messages.push(message);
            }
            
            io.to(roomId).emit('message:new', message);
        } catch (err) {
            console.log('Ошибка отправки сообщения:', err);
        }
    });
    
    // Создание приватной комнаты
    socket.on('room:create', async ({ name, password }) => {
        try {
            const roomId = 'priv_' + Date.now();
            privateRooms.set(roomId, {
                name,
                password,
                users: new Set([socket.id]),
                messages: []
            });
            
            // Сохраняем в MongoDB
            const newRoom = new PrivateRoom({
                roomId,
                name,
                password,
                createdBy: socket.id,
                users: [socket.id]
            });
            await newRoom.save();
            
            socket.emit('room:created', { id: roomId, name });
        } catch (err) {
            console.log('Ошибка создания комнаты:', err);
        }
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
    socket.on('disconnect', async () => {
        console.log('Пользователь отключился:', socket.id);
        const user = users.get(socket.id);
        
        // Обновляем статус в MongoDB
        if (user) {
            await User.findOneAndUpdate(
                { socketId: socket.id },
                { online: false, lastSeen: new Date() }
            );
        }
        
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