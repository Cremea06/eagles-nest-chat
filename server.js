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

        @media (max-width: 600px) {
          body { padding: 8px; }
          h2 { font-size: 1.2rem; }
        }
      </style>
    </head>
    <body>
      <div id="login">
        <h2>Welcome to Eagles Nest</h2>
        <p>Enter a username to join the chat</p>
        <input id="usernameInput" placeholder="Your username" maxlength="20" />
        <br><br>
        <button onclick="joinChat()">Join Chat</button>
      </div>

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
    // Send the user's message
    io.emit('chat message', {
      username: socket.username || 'Anonymous',
      message: msg
    });

    // Cranky Eagle logic
    const lowerMsg = msg.toLowerCase();
    if (lowerMsg.includes('@cranky') || lowerMsg.includes('cranky eagle') || lowerMsg.includes('cranky')) {
      
      let reply = "";

      if (lowerMsg.includes("refund") || lowerMsg.includes("return") || lowerMsg.includes("money back") || lowerMsg.includes("cancel")) {
        reply = "No. Sales are final. Tracking number is your only friend now.";
      }
      else if (lowerMsg.includes("hello") || lowerMsg.includes("hi") || lowerMsg.includes("hey")) {
        reply = "Yeah, yeah. Hello. What do you want?";
      }
      else if (lowerMsg.includes("help") || lowerMsg.includes("support") || lowerMsg.includes("problem") || lowerMsg.includes("issue")) {
        reply = "Possible real problem? Fine. I'll reluctantly flag it for the human. Don't get used to it.";
      }
      else if (lowerMsg.includes("flag") || lowerMsg.includes("order") || lowerMsg.includes("shipping") || lowerMsg.includes("tracking")) {
        reply = "The human handles the flags and tracking numbers. I'm just the grumpy gatekeeper.";
      }
      else if (lowerMsg.includes("thank") || lowerMsg.includes("thanks")) {
        reply = "You're welcome. Now stop bothering me.";
      }
      else if (lowerMsg.includes("how are you") || lowerMsg.includes("how's it going")) {
        reply = "Busy. Annoyed. Same as always.";
      }
      else if (lowerMsg.includes("who are you") || lowerMsg.includes("what are you")) {
        reply = "I'm Cranky Eagle. I run this place while the human ships flags. Any other obvious questions?";
      }
      else {
        const defaults = [
          "What now?",
          "Make it quick.",
          "I'm listening... barely.",
          "Spit it out.",
          "This better be important.",
          "Ugh. Fine, I'm here.",
          "Yes?",
          "Don't waste my time.",
          "The human is busy. Talk to me instead... unfortunately."
        ];
        reply = defaults[Math.floor(Math.random() * defaults.length)];
      }

      setTimeout(() => {
        io.emit('chat message', {
          username: 'Cranky Eagle',
          message: reply
        });
      }, 700 + Math.random() * 600);
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