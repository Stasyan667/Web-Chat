const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Отдаем статические файлы из папки public
app.use(express.static(path.join(__dirname, 'public')));

// Главная страница - всегда отдаем index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Хранилище комнат и пользователей
const rooms = {
    'main': { name: 'Общая', users: new Set(), messages: [] },
    'work': { name: 'Работа', users: new Set(), messages: [] },
    'games': { name: 'Игры', users: new Set(), messages: [] }
};
const privateRooms = new Map();

io.on('connection', (socket) => {
    console.log('Пользователь подключился:', socket.id);
    
    // Регистрация пользователя
    socket.on('user:register', (userData) => {
        socket.data.user = userData;
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
            // Отправляем историю сообщений
            const messages = rooms[roomId].messages || [];
            callback({ 
                messages: messages,
                users: Array.from(rooms[roomId].users).map(id => ({
                    id,
                    name: io.sockets.sockets.get(id)?.data?.user?.name || 'Аноним'
                }))
            });
        } else if (privateRooms.has(roomId)) {
            const room = privateRooms.get(roomId);
            room.users.add(socket.id);
            callback({ 
                messages: room.messages || [],
                users: Array.from(room.users).map(id => ({
                    id,
                    name: io.sockets.sockets.get(id)?.data?.user?.name || 'Аноним'
                }))
            });
        }
        
        // Уведомляем всех в комнате
        io.to(roomId).emit('user:joined', socket.data.user?.name || 'Аноним');
        updateOnlineCount(roomId);
    });
    
    // Отправка сообщения
    socket.on('message:send', (messageData) => {
        const roomId = socket.data.currentRoom;
        const message = {
            author: socket.data.user?.name || 'Аноним',
            text: messageData.text,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            id: Date.now()
        };
        
        // Сохраняем в историю
        if (rooms[roomId]) {
            if (!rooms[roomId].messages) rooms[roomId].messages = [];
            rooms[roomId].messages.push(message);
        } else if (privateRooms.has(roomId)) {
            const room = privateRooms.get(roomId);
            if (!room.messages) room.messages = [];
            room.messages.push(message);
        }
        
        // Рассылаем всем
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
        
        // Удаляем из всех комнат
        for (let roomId in rooms) {
            if (rooms[roomId].users.has(socket.id)) {
                rooms[roomId].users.delete(socket.id);
                io.to(roomId).emit('user:left', socket.data.user?.name || 'Аноним');
                updateOnlineCount(roomId);
            }
        }
        for (let [roomId, room] of privateRooms) {
            if (room.users.has(socket.id)) {
                room.users.delete(socket.id);
                io.to(roomId).emit('user:left', socket.data.user?.name || 'Аноним');
                updateOnlineCount(roomId);
            }
        }
    });
});

function updateOnlineCount(roomId) {
    let count = 0;
    if (rooms[roomId]) {
        count = rooms[roomId].users.size;
    } else if (privateRooms.has(roomId)) {
        count = privateRooms.get(roomId).users.size;
    }
    io.to(roomId).emit('online:update', count);
}

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});