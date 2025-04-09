const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const fetch = (...args) => import('node-fetch').then(mod => mod.default(...args));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.static('public'));
app.use(express.json());

const usernameToSocket = {}; // { username: socket.id }
const socketToUsername = {}; // { socket.id: username }
const activeRooms = new Set();

app.post('/ask-ai', async (req, res) => {
  const prompt = req.body.prompt;

  try {
    const aiRes = await fetch("https://api.cohere.ai/v1/chat", {
      method: "POST",
      headers: {
        "Authorization": "Bearer 2U7OM34GiH8lSiaq6k59EXEZNHcWJgB1wLE0NvVy",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: prompt,
        model: "command-r",
        temperature: 0.7
      })
    });

    const data = await aiRes.json();
    res.json({ reply: data.text || "⚠️ AI returned no message." });
  } catch (err) {
    res.json({ reply: "⚠️ Server error: " + err.message });
  }
});

io.on('connection', (socket) => {
  let username = null;

  socket.on('join', ({ name }, callback) => {
    if (usernameToSocket[name]) {
      return callback({ success: false, message: 'Username taken' });
    }

    username = name;
    usernameToSocket[username] = socket.id;
    socketToUsername[socket.id] = username;
    callback({ success: true });

    socket.broadcast.emit('message', `${username} joined the public chat`);

    socket.on('chat', (msg) => {
      io.emit('message', msg);
    });

    socket.on('handle-room', ({ room, action }, callback) => {
      if (action === 'create') {
        if (activeRooms.has(room)) {
          return callback({ success: false, message: 'Room already exists' });
        }
        activeRooms.add(room);
      } else if (!activeRooms.has(room)) {
        return callback({ success: false, message: 'Room does not exist' });
      }

      socket.join(room);
      callback({ success: true });
    });

    socket.on('private-chat', ({ room, type, content }) => {
      const msg = { from: username, type, content };
      socket.to(room).emit('private-message', msg);
      socket.emit('private-message', msg); // echo back to sender
    });

    socket.on('join-room', (room) => {
      socket.join(room);
    });

    // VOICE CHAT
    socket.on('join-voice', ({ room, username }) => {
      socket.join(room);
      socketToUsername[socket.id] = username;

      const clientsInRoom = Array.from(io.sockets.adapter.rooms.get(room) || []);
      clientsInRoom.forEach(id => {
        if (id !== socket.id) {
          socket.emit('new-user', { id, name: socketToUsername[id] || "User" });
        }
      });

      socket.to(room).emit('new-user', { id: socket.id, name: username });

      socket.on('offer', ({ id, offer }) => {
        io.to(id).emit('offer', { id: socket.id, offer, name: username });
      });

      socket.on('answer', ({ id, answer }) => {
        io.to(id).emit('answer', { id: socket.id, answer });
      });

      socket.on('candidate', ({ id, candidate }) => {
        io.to(id).emit('candidate', { id: socket.id, candidate });
      });
    });

    socket.on('disconnect', () => {
      const name = socketToUsername[socket.id];
      delete usernameToSocket[name];
      delete socketToUsername[socket.id];
      io.emit('message', `${name} left the chat`);
      socket.broadcast.emit('user-disconnected', socket.id);
    });
  });
});

server.listen(3000, () => {
  console.log("🚀 Server running on http://localhost:3000");
});
