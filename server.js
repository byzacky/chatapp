const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const fetch = (...args) => import('node-fetch').then(mod => mod.default(...args));
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.static('public'));
app.use(express.json());

const activeUsers = new Set();
const activeRooms = new Set();
const socketIdToUsername = {};

// ✅ Cohere AI (Chatbot API)
app.post('/ask-ai', async (req, res) => {
  const prompt = req.body.prompt;
  try {
    const aiRes = await fetch("https://api.cohere.ai/v1/chat", {
      method: "POST",
      headers: {
        "Authorization": "Bearer 2U7OM34GiH8lSiaq6k59EXEZNHcWJgB1wLE0NvVy", // Replace with your real key
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

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const dbPath = path.join(__dirname, 'log-database.json');

  if (!fs.existsSync(dbPath)) {
    return res.status(500).json({ success: false, message: 'Database not found' });
  }

  const users = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));

  if (!users[username]) {
    return res.json({ success: false, message: 'User not found' });
  }

  const user = users[username];

  if (user.password !== password) {
    return res.json({ success: false, message: 'Incorrect password' });
  }

  if (user.banned) {
    return res.json({ success: false, message: 'You have been banned from the chat.' });
  }

  return res.json({ success: true, rank: user.rank });
});


io.on('connection', (socket) => {
  let username = null;

  socket.on('join', ({ name, context = "public" }, callback) => {
    const dbPath = path.join(__dirname, 'log-database.json');
    const users = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
  
    if (!users[name]) {
      return callback({ success: false, message: 'User not found' });
    }
  
    if (users[name].banned) {
      return callback({ success: false, message: 'You have been banned from the chat.' });
    }
  
    if (activeUsers.has(name)) {
      return callback({ success: false, message: 'Username taken' });
    }
  
    username = name;
    socket.rank = users[name].rank; // <- used in ban/unban check
    activeUsers.add(name);
    socketIdToUsername[socket.id] = name;
    socket.context = context;
  
    callback({ success: true });
  
    if (context === 'public') {
      socket.broadcast.emit('message', `${username} joined the public chat`);
    }
  });
  

  // ✅ Public chat message
  socket.on('chat', (msg) => {
    // Check if it's a command
    if (typeof msg.content === 'string' && msg.content.startsWith('/')) {
      const [cmd, target] = msg.content.split(' ');
  
      const userRank = socket.rank || 'member';
      const sender = socketIdToUsername[socket.id];
  
      if ((cmd === '/ban' || cmd === '/unban') && userRank !== 'mod') {
        return; // ignore command if not a mod
      }
  
      if (cmd === '/ban') {
        const dbPath = path.join(__dirname, 'log-database.json');
        const users = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
        if (!users[target]) return;
  
        users[target].banned = true;
        fs.writeFileSync(dbPath, JSON.stringify(users, null, 2));
  
        // Kick user if online
        for (const [id, name] of Object.entries(socketIdToUsername)) {
          if (name === target) {
            io.to(id).emit('force-disconnect', { reason: `You have been banned by ${sender}` });
            io.sockets.sockets.get(id)?.disconnect(true);
          }
        }
  
        io.emit('message', {
          from: 'System',
          type: 'text',
          content: `${target} has been banned`
        });
        return;
      }
  
      if (cmd === '/unban') {
        const dbPath = path.join(__dirname, 'log-database.json');
        const users = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
        if (!users[target]) return;
  
        users[target].banned = false;
        fs.writeFileSync(dbPath, JSON.stringify(users, null, 2));
  
        io.emit('message', {
          from: 'System',
          type: 'text',
          content: `${target} has been unbanned`
        });
        return;
      }
  
      return; // prevent default sending of commands as messages
    }
  
    // Regular message
    io.emit('message', msg);
  });
  

  // ✅ Private room create/join
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
    socket.context = `private:${room}`;

    // 🔔 Notify others in the private room
    socket.to(room).emit('private-message', {
      from: "System",
      type: "text",
      content: `${username} joined the private chat`
    });

    callback({ success: true });
  });

  // ✅ Private chat messages
  socket.on('private-chat', ({ room, type, content }) => {
    const msg = { from: username, type, content };
    socket.to(room).emit('private-message', msg); // to others
    socket.emit('private-message', msg); // echo to sender
  });

  // ✅ Voice chat support
  socket.on('join-voice', ({ room, username }) => {
    socket.join(room);
    socketIdToUsername[socket.id] = username;

    const clientsInRoom = Array.from(io.sockets.adapter.rooms.get(room) || []);
    clientsInRoom.forEach(id => {
      if (id !== socket.id) {
        socket.emit('new-user', { id, name: socketIdToUsername[id] || "User" });
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

    socket.on('disconnect', () => {
      socket.to(room).emit('user-disconnected', socket.id);
    });
  });

  // ✅ Disconnect handling
  socket.on('disconnect', () => {
    if (!username) return;

    activeUsers.delete(username);
    delete socketIdToUsername[socket.id];

    // 👋 Public user left
    if (socket.context === "public") {
      io.emit('message', `${username} left the chat`);
    }

    // 👋 Private user left
    if (socket.context?.startsWith("private:")) {
      const room = socket.context.split(":")[1];
      socket.to(room).emit('private-message', {
        from: "System",
        type: "text",
        content: `${username} left the private chat`
      });
    }
  });
}); 

server.listen(3000, () => {
  console.log("🚀 Server running on http://localhost:3000");
});
