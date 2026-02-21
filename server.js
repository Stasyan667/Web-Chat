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
  },
  transports: ['websocket', 'polling']
});

// Раздаем статические файлы из папки public
app.use(express.static(path.join(__dirname, 'public')));

// Хранилище для комнат
const rooms = {
  main: { name: 'Общая', users: [], messages: [] },
  work: { name: 'Работа', users: [], messages: [] },
  games: { name: 'Игры', users: [], messages: [] }
};

io.on('connection', (socket) => {
  console.log('Пользователь подключен:', socket.id);

  socket.on('user:register', (userData) => {
    socket.userData = userData;
  });

  socket.on('room:join', (roomId, callback) => {
    if (socket.currentRoom) {
      socket.leave(socket.currentRoom);
    }
    
    socket.join(roomId);
    socket.currentRoom = roomId;
    
    if (!rooms[roomId]) {
      rooms[roomId] = { name: roomId, users: [], messages: [] };
    }
    
    if (socket.userData) {
      rooms[roomId].users.push({
        id: socket.id,
        name: socket.userData.name,
        avatar: socket.userData.avatar
      });
    }
    
    callback({
      messages: rooms[roomId].messages || [],
      users: rooms[roomId].users
    });
    
    socket.to(roomId).emit('user:joined', socket.userData?.name);
    io.to(roomId).emit('online:update', rooms[roomId].users.length);
  });

  socket.on('message:send', (data) => {
    const room = rooms[socket.currentRoom];
    if (!room || !socket.userData) return;
    
    const message = {
      id: Date.now(),
      author: socket.userData.name,
      text: data.text,
      time: new Date().toLocaleTimeString(),
      avatarBg: socket.userData.avatarBackground || 'theme-default'
    };
    
    room.messages.push(message);
    io.to(socket.currentRoom).emit('message:new', message);
  });

  socket.on('disconnect', () => {
    if (socket.currentRoom && rooms[socket.currentRoom]) {
      rooms[socket.currentRoom].users = rooms[socket.currentRoom].users.filter(
        u => u.id !== socket.id
      );
      socket.to(socket.currentRoom).emit('user:left', socket.userData?.name);
      io.to(socket.currentRoom).emit('online:update', rooms[socket.currentRoom].users.length);
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});