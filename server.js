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

// Подключение к MongoDB
mongoose.connect('mongodb+srv://Stasyan667:stasyan6111@stasyan667.etwjg3c.mongodb.net/chatdb?retryWrites=true&w=majority')
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
    blacklist: [String],
    isAdmin: Boolean,
    isDev: Boolean
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

const friendRequestSchema = new mongoose.Schema({
    fromId: String,
    toId: String,
    fromName: String,
    fromAvatar: String,
    fromCode: String,
    status: { type: String, default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});

// Модели
const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const PrivateRoom = mongoose.model('PrivateRoom', privateRoomSchema);
const FriendRequest = mongoose.model('FriendRequest', friendRequestSchema);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Хранилище данных в памяти
let onlineUsers = new Map(); // socketId -> userData
let userSockets = new Map(); // userId -> socketId
let friendCodes = new Map(); // friendCode -> userId
let rooms = {
    'main': { 
        name: 'Общая', 
        users: new Map(), 
        messages: [],
        onlineCount: 0 
    },
    'work': { 
        name: 'Работа', 
        users: new Map(), 
        messages: [],
        onlineCount: 0 
    },
    'games': { 
        name: 'Игры', 
        users: new Map(), 
        messages: [],
        onlineCount: 0 
    }
};
let privateRooms = new Map();
let messageReactions = new Map();

// Загрузка сохраненных сообщений
async function loadSavedMessages() {
    try {
        const allMessages = await Message.find().lean();
        allMessages.forEach(msg => {
            if (!rooms[msg.roomId]) {
                rooms[msg.roomId] = { 
                    name: msg.roomId, 
                    users: new Map(), 
                    messages: [],
                    onlineCount: 0 
                };
            }
            rooms[msg.roomId].messages.push(msg);
        });
        console.log('✅ Загружены сохраненные сообщения');
    } catch (err) {
        console.log('❌ Ошибка загрузки сообщений:', err);
    }
}
loadSavedMessages();

// Загрузка приватных комнат
async function loadPrivateRooms() {
    try {
        const allRooms = await PrivateRoom.find().lean();
        allRooms.forEach(room => {
            privateRooms.set(room.roomId, {
                name: room.name,
                password: room.password,
                users: new Map(),
                messages: [],
                createdBy: room.createdBy,
                onlineCount: 0
            });
        });
        console.log('✅ Загружены приватные комнаты');
    } catch (err) {
        console.log('❌ Ошибка загрузки комнат:', err);
    }
}
loadPrivateRooms();

// Функция обновления онлайн счетчика
function updateOnlineCount(roomId) {
    let count = 0;
    if (rooms[roomId]) {
        count = rooms[roomId].users.size;
        rooms[roomId].onlineCount = count;
    } else if (privateRooms.has(roomId)) {
        count = privateRooms.get(roomId).users.size;
        privateRooms.get(roomId).onlineCount = count;
    }
    io.to(roomId).emit('online:update', count);
}

// Функция обновления всех счетчиков
function updateAllOnlineCounts() {
    for (let roomId in rooms) {
        updateOnlineCount(roomId);
    }
    for (let [roomId, room] of privateRooms) {
        updateOnlineCount(roomId);
    }
}

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
                user.avatar = userData.avatar || user.avatar;
                user.avatarBackground = userData.avatarBackground || user.avatarBackground;
                user.country = userData.country || user.country;
                await user.save();
            }
            
            // Сохраняем в памяти
            let userInfo = {
                id: user._id.toString(),
                socketId: socket.id,
                name: userData.name || user.name,
                email: user.email,
                country: userData.country || user.country,
                avatar: userData.avatar || user.avatar,
                avatarBackground: userData.avatarBackground || user.avatarBackground,
                friendCode: user.friendCode,
                online: true,
                lastSeen: new Date(),
                friends: user.friends || [],
                isAdmin: user.isAdmin || false,
                isDev: user.isDev || false
            };
            
            onlineUsers.set(socket.id, userInfo);
            userSockets.set(userInfo.id, socket.id);
            friendCodes.set(user.friendCode, userInfo.id);
            
            socket.emit('user:registered', {
                friendCode: user.friendCode,
                id: userInfo.id,
                user: userInfo
            });
            
            console.log(`✅ Пользователь ${userInfo.name} зарегистрирован с кодом ${user.friendCode}`);
        } catch (err) {
            console.log('❌ Ошибка регистрации:', err);
        }
    });
    
    // Поиск пользователя по коду для добавления в друзья
    socket.on('user:findByCode', async (code) => {
        try {
            const userId = friendCodes.get(code);
            if (!userId) {
                socket.emit('user:notFound');
                return;
            }
            
            const userSocketId = userSockets.get(userId);
            const user = onlineUsers.get(userSocketId) || await User.findOne({ friendCode: code });
            
            if (user) {
                socket.emit('user:found', {
                    id: userId,
                    name: user.name,
                    avatar: user.avatar,
                    avatarBackground: user.avatarBackground,
                    online: onlineUsers.has(userSocketId)
                });
            } else {
                socket.emit('user:notFound');
            }
        } catch (err) {
            console.log('Ошибка поиска пользователя:', err);
            socket.emit('user:notFound');
        }
    });
    
    // Отправка запроса в друзья
    socket.on('friend:request', async (toCode) => {
        try {
            const fromUser = onlineUsers.get(socket.id);
            if (!fromUser) {
                socket.emit('friend:error', 'Сначала зарегистрируйтесь');
                return;
            }
            
            const toUserId = friendCodes.get(toCode);
            if (!toUserId) {
                socket.emit('friend:error', 'Пользователь не найден');
                return;
            }
            
            const toSocketId = userSockets.get(toUserId);
            
            // Проверяем, не друзья ли уже
            if (fromUser.friends && fromUser.friends.includes(toUserId)) {
                socket.emit('friend:error', 'Вы уже друзья');
                return;
            }
            
            // Создаем запрос в MongoDB
            const friendRequest = new FriendRequest({
                fromId: fromUser.id,
                toId: toUserId,
                fromName: fromUser.name,
                fromAvatar: fromUser.avatar,
                fromCode: fromUser.friendCode,
                status: 'pending'
            });
            await friendRequest.save();
            
            // Отправляем уведомление получателю, если он онлайн
            if (toSocketId && onlineUsers.has(toSocketId)) {
                io.to(toSocketId).emit('friend:request', {
                    fromId: fromUser.id,
                    fromName: fromUser.name,
                    fromAvatar: fromUser.avatar,
                    fromCode: fromUser.friendCode,
                    requestId: friendRequest._id
                });
            }
            
            socket.emit('friend:requestSent', { requestId: friendRequest._id });
            console.log(`📨 Запрос в друзья от ${fromUser.name} к ${toCode}`);
        } catch (err) {
            console.log('Ошибка отправки запроса:', err);
            socket.emit('friend:error', 'Ошибка отправки запроса');
        }
    });
    
    // Принятие запроса в друзья
    socket.on('friend:accept', async (data) => {
        try {
            const { fromId, requestId } = data;
            const toUser = onlineUsers.get(socket.id);
            
            if (!toUser) return;
            
            // Обновляем статус запроса
            await FriendRequest.findByIdAndUpdate(requestId, { status: 'accepted' });
            
            // Добавляем друг друга в списки друзей
            await User.findByIdAndUpdate(toUser.id, { $addToSet: { friends: fromId } });
            await User.findByIdAndUpdate(fromId, { $addToSet: { friends: toUser.id } });
            
            // Обновляем данные в памяти
            toUser.friends = toUser.friends || [];
            toUser.friends.push(fromId);
            
            const fromSocketId = userSockets.get(fromId);
            if (fromSocketId && onlineUsers.has(fromSocketId)) {
                const fromUser = onlineUsers.get(fromSocketId);
                fromUser.friends = fromUser.friends || [];
                fromUser.friends.push(toUser.id);
                
                // Уведомляем отправителя
                io.to(fromSocketId).emit('friend:accepted', {
                    id: toUser.id,
                    name: toUser.name,
                    avatar: toUser.avatar,
                    avatarBackground: toUser.avatarBackground,
                    online: true
                });
            }
            
            // Уведомляем получателя
            socket.emit('friend:accepted', {
                id: fromId,
                name: data.fromName,
                avatar: data.fromAvatar,
                online: true
            });
            
            console.log(`✅ ${toUser.name} принял запрос в друзья`);
        } catch (err) {
            console.log('Ошибка принятия запроса:', err);
        }
    });
    
    // Отклонение запроса
    socket.on('friend:decline', async (data) => {
        try {
            const { requestId } = data;
            await FriendRequest.findByIdAndUpdate(requestId, { status: 'declined' });
            socket.emit('friend:declined');
        } catch (err) {
            console.log('Ошибка отклонения запроса:', err);
        }
    });
    
    // Получение списка друзей
    socket.on('friends:get', async () => {
        try {
            const user = onlineUsers.get(socket.id);
            if (!user || !user.friends) return;
            
            const friendsList = [];
            for (const friendId of user.friends) {
                const friendSocketId = userSockets.get(friendId);
                const friend = onlineUsers.get(friendSocketId) || await User.findById(friendId);
                if (friend) {
                    friendsList.push({
                        id: friendId,
                        name: friend.name,
                        avatar: friend.avatar,
                        avatarBackground: friend.avatarBackground,
                        online: onlineUsers.has(friendSocketId),
                        friendCode: friend.friendCode
                    });
                }
            }
            
            socket.emit('friends:list', friendsList);
        } catch (err) {
            console.log('Ошибка получения списка друзей:', err);
        }
    });
    
    // Подключение к комнате
    socket.on('room:join', async (roomId, callback) => {
        try {
            // Выходим из предыдущих комнат
            if (socket.currentRoom) {
                socket.leave(socket.currentRoom);
                if (rooms[socket.currentRoom]) {
                    rooms[socket.currentRoom].users.delete(socket.id);
                    updateOnlineCount(socket.currentRoom);
                } else if (privateRooms.has(socket.currentRoom)) {
                    privateRooms.get(socket.currentRoom).users.delete(socket.id);
                    updateOnlineCount(socket.currentRoom);
                }
            }
            
            socket.join(roomId);
            socket.currentRoom = roomId;
            
            const user = onlineUsers.get(socket.id);
            
            // Добавляем пользователя в комнату
            if (rooms[roomId]) {
                rooms[roomId].users.set(socket.id, user);
                updateOnlineCount(roomId);
                
                // Отправляем историю сообщений
                const messages = rooms[roomId].messages || [];
                
                // Формируем список пользователей
                const usersList = [];
                for (let [sid, u] of rooms[roomId].users) {
                    if (u) {
                        usersList.push({
                            id: u.id,
                            name: u.name,
                            avatar: u.avatar,
                            avatarBackground: u.avatarBackground,
                            online: true
                        });
                    }
                }
                
                callback({
                    messages: messages,
                    users: usersList,
                    onlineCount: rooms[roomId].users.size
                });
                
            } else if (privateRooms.has(roomId)) {
                const room = privateRooms.get(roomId);
                room.users.set(socket.id, user);
                updateOnlineCount(roomId);
                
                const messages = room.messages || [];
                
                const usersList = [];
                for (let [sid, u] of room.users) {
                    if (u) {
                        usersList.push({
                            id: u.id,
                            name: u.name,
                            avatar: u.avatar,
                            avatarBackground: u.avatarBackground,
                            online: true
                        });
                    }
                }
                
                callback({
                    messages: messages,
                    users: usersList,
                    onlineCount: room.users.size
                });
            }
            
            // Уведомляем о новом пользователе
            if (user) {
                socket.to(roomId).emit('user:joined', {
                    name: user.name,
                    avatar: user.avatar,
                    avatarBackground: user.avatarBackground
                });
            }
            
        } catch (err) {
            console.log('Ошибка подключения к комнате:', err);
            callback({ error: 'Ошибка подключения' });
        }
    });
    
    // Отправка сообщения
    socket.on('message:send', async (data) => {
        try {
            const roomId = socket.currentRoom;
            const user = onlineUsers.get(socket.id);
            
            if (!user || !roomId) return;
            
            const message = {
                author: user.name,
                authorId: user.id,
                avatar: user.avatar,
                avatarBg: user.avatarBackground,
                text: data.text,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                roomId: roomId,
                reactions: {},
                timestamp: new Date()
            };
            
            // Сохраняем в MongoDB
            const newMessage = new Message(message);
            await newMessage.save();
            
            message.id = newMessage._id;
            message.timestamp = newMessage.timestamp;
            
            // Сохраняем в памяти
            if (rooms[roomId]) {
                if (!rooms[roomId].messages) rooms[roomId].messages = [];
                rooms[roomId].messages.push(message);
            } else if (privateRooms.has(roomId)) {
                const room = privateRooms.get(roomId);
                if (!room.messages) room.messages = [];
                room.messages.push(message);
            }
            
            // Отправляем всем в комнате
            io.to(roomId).emit('message:new', message);
            
            // Если был временный ID, отправляем подтверждение
            if (data.tempId) {
                socket.emit('message:saved', {
                    tempId: data.tempId,
                    realId: newMessage._id
                });
            }
            
        } catch (err) {
            console.log('Ошибка отправки сообщения:', err);
        }
    });
    
    // Добавление реакции
    socket.on('reaction:add', async (data) => {
        try {
            const { messageId, emoji } = data;
            const user = onlineUsers.get(socket.id);
            
            if (!user) return;
            
            // Обновляем в MongoDB
            const message = await Message.findById(messageId);
            if (message) {
                const reactions = message.reactions || new Map();
                const users = reactions.get(emoji) || [];
                
                if (!users.includes(user.name)) {
                    users.push(user.name);
                    reactions.set(emoji, users);
                    message.reactions = reactions;
                    await message.save();
                }
            }
            
            // Обновляем в памяти
            if (!messageReactions.has(messageId)) {
                messageReactions.set(messageId, new Map());
            }
            const msgReactions = messageReactions.get(messageId);
            const emojiUsers = msgReactions.get(emoji) || [];
            
            if (!emojiUsers.includes(user.name)) {
                emojiUsers.push(user.name);
                msgReactions.set(emoji, emojiUsers);
            }
            
            // Отправляем обновление всем в комнате
            io.to(socket.currentRoom).emit('reaction:update', {
                messageId: messageId,
                emoji: emoji,
                users: emojiUsers
            });
            
        } catch (err) {
            console.log('Ошибка добавления реакции:', err);
        }
    });
    
    // Удаление сообщения
    socket.on('message:delete', async (data) => {
        try {
            const { messageId, roomId } = data;
            const user = onlineUsers.get(socket.id);
            
            if (!user) return;
            
            // Проверяем права (своё сообщение или админ)
            const message = await Message.findById(messageId);
            if (message && (message.authorId === user.id || user.isAdmin || user.isDev)) {
                await Message.findByIdAndDelete(messageId);
                
                // Удаляем из памяти
                if (rooms[roomId] && rooms[roomId].messages) {
                    rooms[roomId].messages = rooms[roomId].messages.filter(m => m.id != messageId);
                } else if (privateRooms.has(roomId)) {
                    const room = privateRooms.get(roomId);
                    if (room.messages) {
                        room.messages = room.messages.filter(m => m.id != messageId);
                    }
                }
                
                // Уведомляем всех в комнате
                io.to(roomId).emit('message:deleted', { messageId });
            }
            
        } catch (err) {
            console.log('Ошибка удаления сообщения:', err);
        }
    });
    
    // Создание приватной комнаты
    socket.on('room:create', async ({ name, password }) => {
        try {
            const user = onlineUsers.get(socket.id);
            if (!user) return;
            
            const roomId = 'priv_' + Date.now();
            
            // Сохраняем в MongoDB
            const newRoom = new PrivateRoom({
                roomId,
                name,
                password,
                createdBy: user.id,
                users: [user.id]
            });
            await newRoom.save();
            
            // Сохраняем в памяти
            privateRooms.set(roomId, {
                name,
                password,
                users: new Map([[socket.id, user]]),
                messages: [],
                createdBy: user.id,
                onlineCount: 1
            });
            
            socket.emit('room:created', { id: roomId, name });
            console.log(`🔒 Создана приватная комната: ${name}`);
            
        } catch (err) {
            console.log('Ошибка создания комнаты:', err);
            socket.emit('room:error', 'Ошибка создания комнаты');
        }
    });
    
    // Подключение к приватной комнате
    socket.on('room:joinPrivate', async ({ name, password }) => {
        try {
            const user = onlineUsers.get(socket.id);
            if (!user) return;
            
            // Ищем комнату в памяти
            for (let [id, room] of privateRooms) {
                if (room.name === name && room.password === password) {
                    socket.emit('room:joined', { id, name: room.name });
                    return;
                }
            }
            
            // Если не нашли в памяти, ищем в MongoDB
            const dbRoom = await PrivateRoom.findOne({ name, password });
            if (dbRoom) {
                // Загружаем в память
                privateRooms.set(dbRoom.roomId, {
                    name: dbRoom.name,
                    password: dbRoom.password,
                    users: new Map([[socket.id, user]]),
                    messages: [],
                    createdBy: dbRoom.createdBy,
                    onlineCount: 1
                });
                socket.emit('room:joined', { id: dbRoom.roomId, name: dbRoom.name });
            } else {
                socket.emit('room:error', 'Комната не найдена или неверный пароль');
            }
            
        } catch (err) {
            console.log('Ошибка подключения к приватной комнате:', err);
            socket.emit('room:error', 'Ошибка подключения');
        }
    });
    
    // Отключение пользователя
    socket.on('disconnect', async () => {
        console.log('Пользователь отключился:', socket.id);
        
        const user = onlineUsers.get(socket.id);
        
        if (user) {
            // Обновляем статус в MongoDB
            await User.findOneAndUpdate(
                { socketId: socket.id },
                { online: false, lastSeen: new Date() }
            );
            
            // Удаляем из всех комнат
            for (let roomId in rooms) {
                if (rooms[roomId].users.has(socket.id)) {
                    rooms[roomId].users.delete(socket.id);
                    io.to(roomId).emit('user:left', user.name);
                    updateOnlineCount(roomId);
                }
            }
            
            for (let [roomId, room] of privateRooms) {
                if (room.users.has(socket.id)) {
                    room.users.delete(socket.id);
                    io.to(roomId).emit('user:left', user.name);
                    updateOnlineCount(roomId);
                }
            }
            
            // Удаляем из памяти
            onlineUsers.delete(socket.id);
            userSockets.delete(user.id);
            if (user.friendCode) {
                friendCodes.delete(user.friendCode);
            }
        }
        
        updateAllOnlineCounts();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});