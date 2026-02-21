const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Настройка CORS для Socket.IO [citation:4]
const io = new Server(server, {
  cors: {
    origin: "*", // В продакшене лучше указать конкретный домен
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'] // Поддержка обоих транспортов
});

// Раздаем статические файлы из папки public
app.use(express.static(path.join(__dirname, 'public')));

// Хранилище для комнат и пользователей (в реальном проекте лучше использовать БД)
const rooms = {
  main: { name: 'Общая', users: [], messages: [] },
  work: { name: 'Работа', users: [], messages: [] },
  games: { name: 'Игры', users: [], messages: [] }
};

// Обработка подключений Socket.IO
io.on('connection', (socket) => {
  console.log('Новый пользователь подключен:', socket.id);

  // Регистрация пользователя
  socket.on('user:register', (userData) => {
    socket.userData = userData;
    console.log(`Пользователь ${userData.name} зарегистрирован`);
  });

  // Подключение к комнате
  socket.on('room:join', (roomId, callback) => {
    // Выходим из предыдущей комнаты
    if (socket.currentRoom) {
      socket.leave(socket.currentRoom);
      if (rooms[socket.currentRoom]) {
        rooms[socket.currentRoom].users = rooms[socket.currentRoom].users.filter(
          u => u.id !== socket.id
        );
      }
    }

    // Подключаемся к новой комнате
    socket.join(roomId);
    socket.currentRoom = roomId;

    // Добавляем пользователя в комнату
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

    // Отправляем историю сообщений и список пользователей
    callback({
      messages: rooms[roomId].messages || [],
      users: rooms[roomId].users
    });

    // Уведомляем всех в комнате о новом пользователе
    socket.to(roomId).emit('user:joined', socket.userData?.name);
    
    // Обновляем счетчик онлайн
    io.to(roomId).emit('online:update', rooms[roomId].users.length);
  });

  // Отправка сообщения
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
    
    // Отправляем сообщение всем в комнате, включая отправителя
    io.to(socket.currentRoom).emit('message:new', message);
  });

  // Отключение пользователя
  socket.on('disconnect', () => {
    if (socket.currentRoom && rooms[socket.currentRoom]) {
      // Удаляем пользователя из комнаты
      rooms[socket.currentRoom].users = rooms[socket.currentRoom].users.filter(
        u => u.id !== socket.id
      );
      
      // Уведомляем остальных
      socket.to(socket.currentRoom).emit('user:left', socket.userData?.name);
      io.to(socket.currentRoom).emit('online:update', rooms[socket.currentRoom].users.length);
    }
    console.log('Пользователь отключен:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});