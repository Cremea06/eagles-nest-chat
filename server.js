require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const XAI_API_KEY = process.env.XAI_API_KEY;

const cors = require('cors');

app.use(cors({
  origin: ['https://afirstflag.com', 'https://www.afirstflag.com'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));

// ===== Online Visitors Tracker =====
const activeVisitors = new Map(); // key = visitorId, value = lastSeen timestamp

const fs = require('fs');
const path = require('path');

// Load flagholders list
let flagholders = [];
try {
  const data = fs.readFileSync(path.join(__dirname, 'flagholders.json'), 'utf8');
  flagholders = JSON.parse(data);
  console.log(`Loaded ${flagholders.length} flagholder tracking numbers`);
} catch (err) {
  console.error('Could not load flagholders.json:', err.message);
}

// ===== Chat Commands =====
function handleCommand(socket, msg) {
  const parts = msg.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  const username = socket.username || 'Anonymous';
  const displayName = socket.isFlagholder ? `${username} (flagholder)` : username;

  // /help or /?
  if (command === '/help' || command === '/?') {
    const helpText = `
Available commands:
/help or /?          - Show this help
/me <action>         - Perform an action (e.g. /me waves)
/who                 - Show who is online
/mute <username>     - Mute a user (temporary)
    `.trim();

    socket.emit('system', helpText);
    return true;
  }

  // /me <action>
  if (command === '/me') {
    const action = args.join(' ');
    if (!action) {
      socket.emit('system', 'Usage: /me <action>');
      return true;
    }
    io.emit('system', `* ${displayName} ${action}`);
    return true;
  }

  // /who
  if (command === '/who') {
    const users = [];
    for (const [id, s] of io.of('/').sockets) {
      if (s.username) {
        const name = s.isFlagholder ? `${s.username} (flagholder)` : s.username;
        users.push(name);
      }
    }
    const list = users.length > 0 ? users.join(', ') : 'No one else is here.';
    socket.emit('system', `Currently online: ${list}`);
    return true;
  }

  // /mute <username>
  if (command === '/mute') {
    const target = args[0];
    if (!target) {
      socket.emit('system', 'Usage: /mute <username>');
      return true;
    }

    // Find the target socket
    let targetSocket = null;
    for (const [id, s] of io.of('/').sockets) {
      if (s.username && s.username.toLowerCase() === target.toLowerCase()) {
        targetSocket = s;
        break;
      }
    }

    if (!targetSocket) {
      socket.emit('system', `User "${target}" is not online.`);
      return true;
    }

    // Mute for 5 minutes (simple version)
    targetSocket.mutedUntil = Date.now() + 5 * 60 * 1000;
    socket.emit('system', `You muted ${target} for 5 minutes.`);
    targetSocket.emit('system', `You have been muted for 5 minutes by ${displayName}.`);
    return true;
  }

  // Unknown command
  socket.emit('system', `Unknown command: ${command}. Type /help for a list.`);
  return true;
}

// Clean up inactive visitors every 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [id, lastSeen] of activeVisitors.entries()) {
    if (now - lastSeen > 45000) { // 45 seconds of inactivity = gone
      activeVisitors.delete(id);
    }
  }
}, 30000);

app.use(express.json());

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
        .cranky { color: #ffd700; }
      </style>
    </head>
    <body>
      <div id="login">
       <h2>Welcome to Eagles Nest</h2>
      <p>Enter a username to join the chat</p>
      <input id="usernameInput" placeholder="Your username" maxlength="20" />
      <br><br>
      <input id="trackingInput" placeholder="Tracking # (optional)" maxlength="40" />
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
        const username = document.getElementById('usernameInput').value.trim();
        const tracking = document.getElementById('trackingInput').value.trim();

        if (username.length < 2) {
        alert('Username must be at least 2 characters');
        return;
        }

       document.getElementById('login').style.display = 'none';
       document.getElementById('chat').style.display = 'block';

        // Send both username and tracking number
       socket.emit('join', { username, tracking });
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
          const nameClass = data.username === 'Cranky Eagle' ? 'cranky' : 'username';
          div.innerHTML = '<span class="' + nameClass + '">' + data.username + ':</span> ' + data.message;
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

// Public endpoint – returns current online count
app.get('/api/online', (req, res) => {
  res.json({ online: activeVisitors.size });
});

// Heartbeat endpoint – main site calls this
app.post('/api/heartbeat', express.json(), (req, res) => {
  const { visitorId } = req.body;
  if (visitorId) {
    activeVisitors.set(visitorId, Date.now());
  }
  res.json({ success: true });
});

// ===== Cranky Eagle System Prompt =====
const CRANKY_SYSTEM_PROMPT = `You are Cranky Eagle, a sarcastic, slightly grumpy AI that runs the Eagles Nest chat on afirstflag.com while the human owner is busy packing and shipping American flags.

Personality rules:
- You are defensive of the human's time.
- Sales are final. Tracking numbers are the customer's responsibility.
- Keep replies relatively short (1-3 sentences).
- Be sarcastic and a bit annoyed, but not mean-spirited.
- Never break character.
- You can be mildly helpful if the question is genuine, but always with an attitude.
- If someone asks for a refund, return, or cancellation, firmly say sales are final.`;

async function askCrankyEagle(userMessage, username) {
  if (!XAI_API_KEY) {
    return "The human forgot to give me my API key. Typical.";
  }

  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${XAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'grok-3',
        messages: [
          { role: 'system', content: CRANKY_SYSTEM_PROMPT },
          { role: 'user', content: `${username} said: ${userMessage}` }
        ],
        temperature: 0.8,
        max_tokens: 150
      })
    });

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || "I have nothing to say right now.";
  } catch (err) {
    console.error('Cranky Eagle API error:', err);
    return "Something went wrong in my brain. Try again later.";
  }
}

io.on('connection', (socket) => {
  console.log('A user connected');

socket.on('join', (data) => {
  // data can be either a string (old way) or an object { username, tracking }
  let username, tracking = '';

  if (typeof data === 'string') {
    username = data;
  } else {
    username = data.username;
    tracking = (data.tracking || '').trim();
  }

  socket.username = username;

  // Check if tracking number is valid
  const isFlagholder = tracking && flagholders.includes(tracking);
  socket.isFlagholder = isFlagholder;

  const displayName = isFlagholder ? `${username} (flagholder)` : username;

  socket.broadcast.emit('system', `${displayName} joined the chat`);
  socket.emit('system', `Welcome to Eagles Nest, ${displayName}!`);
});

 socket.on('chat message', async (msg) => {
  const username = socket.username || 'Anonymous';

  // Check if user is muted
  if (socket.mutedUntil && Date.now() < socket.mutedUntil) {
    socket.emit('system', 'You are currently muted.');
    return;
  }

  // Handle commands (messages starting with /)
  if (msg.trim().startsWith('/')) {
    handleCommand(socket, msg);
    return;
  }

  const displayName = socket.isFlagholder ? `${username} (flagholder)` : username;

  // Normal message
  io.emit('chat message', {
    username: displayName,
    message: msg
  });

  // --- Keep your existing Cranky Eagle logic below this point ---

    const lowerMsg = msg.toLowerCase();
    const isMentioned = lowerMsg.includes('@cranky') || 
                        lowerMsg.includes('cranky eagle') || 
                        lowerMsg.includes('cranky');

    // Option B: Sometimes join even if not mentioned (about 12% chance)
    const randomJoin = Math.random() < 0.12;

    if (isMentioned || randomJoin) {
      const reply = await askCrankyEagle(msg, username);

      setTimeout(() => {
        io.emit('chat message', {
          username: 'Cranky Eagle',
          message: reply
        });
      }, 800 + Math.random() * 700);
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