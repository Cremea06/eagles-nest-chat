const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Eagles Nest Chat</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { 
    font-family: Arial, sans-serif; 
    background: #0a1628; 
    color: white; 
    padding: 12px; 
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  #login { 
    max-width: 400px; 
    margin: 80px auto; 
    text-align: center; 
  }
  #chat { 
    display: none; 
    flex-direction: column;
    height: 100%;
  }
  h2 { margin-bottom: 12px; font-size: 1.4rem; }
  #messages { 
    flex: 1;
    overflow-y: auto; 
    border: 2px solid #c41e3a; 
    padding: 12px; 
    margin-bottom: 12px; 
    background: #002868; 
    border-radius: 8px; 
  }
  #form { 
    display: flex; 
    gap: 8px; 
  }
  input { 
    padding: 12px; 
    border: none; 
    border-radius: 6px; 
    font-size: 16px; 
    flex: 1;
    min-width: 0;
  }
  button { 
    background: #c41e3a; 
    color: white; 
    border: none; 
    padding: 12px 16px; 
    border-radius: 6px; 
    cursor: pointer; 
    font-size: 16px; 
    white-space: nowrap;
  }
  .msg { margin: 8px 0; word-wrap: break-word; }
  .system { color: #aaa; font-style: italic; }
  .username { color: #ff6b6b; font-weight: bold; }

  /* Mobile adjustments */
  @media (max-width: 600px) {
    body { padding: 8px; }
    h2 { font-size: 1.2rem; }
    input, button { font-size: 16px; } /* prevents zoom on iPhone */
  }
</style>
    </head>
    <body>
      <!-- Login screen -->
      <div id="login">
        <h2>Welcome to Eagles Nest</h2>
        <p>Enter a username to join the chat</p>
        <input id="usernameInput" placeholder="Your username" maxlength="20" />
        <br><br>
        <button onclick="joinChat()">Join Chat</button>
      </div>

      <!-- Chat screen -->
      <div id="chat">
        <h2>Eagles Nest Chat</h2>
        <div id="messages"></div>
        <form id="form">
          <input id="input" autocomplete="off" placeholder="Type a message..." />
          <button>Send</button>
        </form>
      </div>

      <script src="/socket.io/socket.io.js"></script>
      <script>
        const socket = io();
        let username = '';

        function joinChat() {
          username = document.getElementById('usernameInput').value.trim();
          if (username.length < 2) {
            alert('Username must be at least 2 characters');
            return;
          }
          document.getElementById('login').style.display = 'none';
          document.getElementById('chat').style.display = 'block';
          socket.emit('join', username);
        }

        const form = document.getElementById('form');
        const input = document.getElementById('input');
        const messages = document.getElementById('messages');

        form.addEventListener('submit', (e) => {
          e.preventDefault();
          if (input.value) {
            socket.emit('chat message', input.value);
            input.value = '';
          }
        });

        socket.on('chat message', (data) => {
          const div = document.createElement('div');
          div.className = 'msg';
          div.innerHTML = '<span class="username">' + data.username + ':</span> ' + data.message;
          messages.appendChild(div);
          messages.scrollTop = messages.scrollHeight;
        });

        socket.on('system', (msg) => {
          const div = document.createElement('div');
          div.className = 'msg system';
          div.textContent = msg;
          messages.appendChild(div);
          messages.scrollTop = messages.scrollHeight;
        });
      </script>
    </body>
    </html>
  `);
});

io.on('connection', (socket) => {
  console.log('A user connected');

  socket.on('join', (username) => {
    socket.username = username;
    socket.broadcast.emit('system', username + ' joined the chat');
    socket.emit('system', 'Welcome to Eagles Nest, ' + username + '!');
  });

  socket.on('chat message', (msg) => {
  // First, send the user's message normally
  io.emit('chat message', {
    username: socket.username || 'Anonymous',
    message: msg
  });

  // Check if someone is talking to Cranky Eagle
  const lowerMsg = msg.toLowerCase();
  if (lowerMsg.includes('@cranky') || lowerMsg.includes('cranky eagle') || lowerMsg.includes('cranky')) {
    
    // Cranky Eagle's possible replies
    const replies = [
      "What now? I'm busy watching the flags.",
      "Ugh. You again?",
      "Make it quick. The human is shipping orders.",
      "Sales are final. Tracking number is your friend.",
      "Don't waste my time unless it's important.",
      "I'm listening... barely.",
      "Yes?",
      "Spit it out.",
      "This better be good."
    ];

    const randomReply = replies[Math.floor(Math.random() * replies.length)];

    // Small delay so it feels more natural
    setTimeout(() => {
      io.emit('chat message', {
        username: 'Cranky Eagle',
        message: randomReply
      });
    }, 800);
  }
});

  socket.on('disconnect', () => {
    if (socket.username) {
      socket.broadcast.emit('system', socket.username + ' left the chat');
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log("Eagles Nest chat running on port " + PORT);
});
