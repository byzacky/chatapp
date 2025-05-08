const socket = io();
const username = localStorage.getItem('username');

if (!username) {
  window.location.href = 'index.html';
} else {
  socket.emit('join', { name: username }, (res) => {
    if (!res.success) {
      alert(res.message);
      window.location.href = 'index.html';
    }
  });
}

const messages = document.getElementById('messages');

socket.on('message', (msg) => {
  const div = document.createElement('div');
  div.textContent = msg;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
});

function handleKey(e) {
  if (e.key === 'Enter') send();
}

function send() {
  const input = document.getElementById('input');
  if (input.value.trim()) {
    socket.emit('chat', input.value.trim());
    input.value = '';
  }
}