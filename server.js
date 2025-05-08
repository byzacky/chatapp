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

app.get('/admin-data', (req, res) => {
  const db = JSON.parse(fs.readFileSync('./log-database.json'));
  res.json({
    activeUsers: Array.from(activeUsers),
    rooms: Array.from(activeRooms),
    userDB: db
  });
});

app.get('/admin-ban-toggle', (req, res) => {
  const user = req.query.user;
  const db = JSON.parse(fs.readFileSync('./log-database.json'));

  if (db[user]) {
    db[user].banned = !db[user].banned;
    fs.writeFileSync('./log-database.json', JSON.stringify(db, null, 2));
  }

  const targetSocketId = Object.keys(socketIdToUsername).find(sid => socketIdToUsername[sid] === user);
  if (targetSocketId && io.sockets.sockets.get(targetSocketId)) {
    io.to(targetSocketId).emit('banned-by-admin', 'You have been banned by an admin.');
    io.sockets.sockets.get(targetSocketId).disconnect(true);
  }

  res.sendStatus(200);
});

app.get('/admin-rename-room', (req, res) => {
  const { old, new: newName } = req.query;
  if (activeRooms.has(old)) {
    activeRooms.delete(old);
    activeRooms.add(newName);
  }
  res.sendStatus(200);
});

app.get('/admin-delete-room', (req, res) => {
  activeRooms.delete(req.query.room);
  res.sendStatus(200);
});

app.get('/admin-delete-user', (req, res) => {
  const db = JSON.parse(fs.readFileSync('./log-database.json'));
  delete db[req.query.user];
  fs.writeFileSync('./log-database.json', JSON.stringify(db, null, 2));
  res.sendStatus(200);
});

app.post('/admin-create-user', (req, res) => {
  const { username, password, rank } = req.body;
  const db = JSON.parse(fs.readFileSync('./log-database.json'));
  db[username] = { password, rank, banned: false };
  fs.writeFileSync('./log-database.json', JSON.stringify(db, null, 2));
  res.sendStatus(200);
});

io.on('connection', (socket) => {
  let username = null;

  socket.on('join', ({ name, context = "public" }, callback) => {
    const dbPath = path.join(__dirname, 'log-database.json');
    const users = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));

    if (!users[name]) return callback({ success: false, message: 'User not found' });
    if (users[name].banned) return callback({ success: false, message: 'You have been banned from the chat.' });
    if (activeUsers.has(name)) return callback({ success: false, message: 'Username taken' });

    username = name;
    socket.rank = users[name].rank;
    activeUsers.add(name);
    socketIdToUsername[socket.id] = name;
    socket.context = context;

    callback({ success: true });

    if (context === 'public') {
      socket.broadcast.emit('message', `${username} joined the public chat`);
    }
  });

  socket.on('chat', (msg) => {
    const [cmd, target] = msg.content.split(' ');
    const sender = socketIdToUsername[socket.id];
    const userRank = socket.rank;

    if (cmd === '/ban' && userRank === 'mod') {
      const db = JSON.parse(fs.readFileSync('./log-database.json'));
      if (db[target]) {
        db[target].banned = true;
        fs.writeFileSync('./log-database.json', JSON.stringify(db, null, 2));
        for (const [id, name] of Object.entries(socketIdToUsername)) {
          if (name === target) {
            io.to(id).emit('force-disconnect', { reason: `You have been banned by ${sender}` });
            io.sockets.sockets.get(id)?.disconnect(true);
          }
        }
        io.emit('message', { from: 'System', type: 'text', content: `${target} has been banned` });
      }
    }

    if (cmd === '/unban' && userRank === 'mod') {
      const db = JSON.parse(fs.readFileSync('./log-database.json'));
      if (db[target]) {
        db[target].banned = false;
        fs.writeFileSync('./log-database.json', JSON.stringify(db, null, 2));
        io.emit('message', { from: 'System', type: 'text', content: `${target} has been unbanned` });
      }
    }

    if (!msg.content.startsWith('/')) {
      io.emit('message', msg);
    }
  });

  socket.on('handle-room', ({ room, action }, callback) => {
    if (action === 'create') {
      if (activeRooms.has(room)) return callback({ success: false, message: 'Room already exists' });
      activeRooms.add(room);
    } else if (!activeRooms.has(room)) {
      return callback({ success: false, message: 'Room does not exist' });
    }

    socket.join(room);
    socket.context = `private:${room}`;
    socket.to(room).emit('private-message', {
      from: "System",
      type: "text",
      content: `${username} joined the private chat`
    });

    callback({ success: true });
  });

  socket.on('private-chat', ({ room, type, content }) => {
    const msg = { from: username, type, content };
    socket.to(room).emit('private-message', msg);
    socket.emit('private-message', msg);
  });

  socket.on('disconnect', () => {
    if (!username) return;
    activeUsers.delete(username);
    delete socketIdToUsername[socket.id];

    if (socket.context === "public") {
      io.emit('message', `${username} left the chat`);
    }

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
