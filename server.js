const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server);

const activeUsers = new Set();
const userToSocket = new Map();

io.on('connection', (socket) => {
  let username = null;

  socket.on('join', ({ name }, callback) => {
    if (activeUsers.has(name)) {
      return callback({ success: false, message: 'Username taken' });
    }

    username = name;
    activeUsers.add(name);
    userToSocket.set(name, socket);
    callback({ success: true });
    socket.broadcast.emit('message', `${username} joined the public chat`);

    socket.on('chat', (msg) => {
      io.emit('message', `${username}: ${msg}`);
    });

    socket.on('private-chat', ({ room, message }) => {
      socket.to(room).emit('private-message', {
        from: username,
        message
      });
    });

    socket.on('join-room', (room) => {
      socket.join(room);
    });

    socket.on('disconnect', () => {
      activeUsers.delete(username);
      userToSocket.delete(username);
      io.emit('message', `${username} left the chat`);
    });
  });
});

server.listen(3000, () => console.log('Running at http://localhost:3000'));
