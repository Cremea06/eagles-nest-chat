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

const usageStats = {
  calls: 0,
  prompt: 0,
  completion: 0,
  total: 0
};

function usagePayload() {
  return {
    calls: usageStats.calls,
    tokens: usageStats.total,
    prompt: usageStats.prompt,
    completion: usageStats.completion
  };
}

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
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>Eagles Nest Chat</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(145deg, #07111f 0%, #0c1c32 40%, #0a1628 100%);
      background-attachment: fixed;
      color: #f0f4f8;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      padding: 16px;
    }

    /* ===== Glass utility ===== */
    .glass {
      background: rgba(255, 255, 255, 0.07);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 18px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }

    /* ===== Login Screen ===== */
    #login {
      max-width: 400px;
      width: 100%;
      margin: 10vh auto 0;
      padding: 2.75rem 2.25rem;
      text-align: center;
    }

    #login h2 {
      font-size: 1.75rem;
      font-weight: 700;
      letter-spacing: -0.03em;
      margin-bottom: 0.4rem;
      color: #ffffff;
    }

    #login p {
      opacity: 0.7;
      font-size: 0.95rem;
      margin-bottom: 1.75rem;
    }

    #usernameInput,
    #trackingInput {
      width: 100%;
      padding: 0.9rem 1.1rem;
      margin-bottom: 0.9rem;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 12px;
      color: #fff;
      font-size: 1rem;
      outline: none;
      transition: all 0.2s ease;
    }

    #usernameInput::placeholder,
    #trackingInput::placeholder {
      color: rgba(255, 255, 255, 0.45);
    }

    #usernameInput:focus,
    #trackingInput:focus {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.35);
      box-shadow: 0 0 0 3px rgba(196, 30, 58, 0.25);
    }

    #login button {
      width: 100%;
      padding: 0.95rem;
      margin-top: 0.4rem;
      background: linear-gradient(135deg, #c41e3a 0%, #9b1b2e 100%);
      border: none;
      border-radius: 12px;
      color: white;
      font-weight: 600;
      font-size: 1.05rem;
      cursor: pointer;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }

    #login button:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(196, 30, 58, 0.45);
    }

    #login button:active {
      transform: translateY(0);
    }

    /* ===== Chat Interface ===== */
    #chat {
      display: none;
      flex-direction: column;
      height: calc(100vh - 32px);
      max-width: 920px;
      width: 100%;
      margin: 0 auto;
      overflow: hidden;
    }

    #chat > h2 {
  padding: 1.1rem 1.4rem;
  font-size: 1.25rem;
  font-weight: 600;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

#usageChip {
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: #ffd700;
  background: rgba(255, 215, 0, 0.12);
  border: 1px solid rgba(255, 215, 0, 0.28);
  border-radius: 999px;
  padding: 0.35rem 0.7rem;
  white-space: nowrap;
}

    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.55rem;
    }

    /* Custom scrollbar */
    #messages::-webkit-scrollbar {
      width: 6px;
    }
    #messages::-webkit-scrollbar-track {
      background: transparent;
    }
    #messages::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.2);
      border-radius: 3px;
    }

    .msg {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 14px;
      padding: 0.7rem 1rem;
      max-width: 88%;
      word-wrap: break-word;
      line-height: 1.45;
      animation: fadeIn 0.25s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .msg .username {
      color: #ff6b6b;
      font-weight: 600;
      margin-right: 0.35rem;
    }

    .msg .neagle {
      color: #ffd700;
      font-weight: 700;
      margin-right: 0.35rem;
    }

    .msg.system {
      background: transparent;
      border: none;
      color: #a0aec0;
      font-style: italic;
      text-align: center;
      max-width: 100%;
      font-size: 0.9rem;
      opacity: 0.8;
    }

    /* Input bar */
    #form {
      display: flex;
      gap: 0.75rem;
      padding: 1rem 1.25rem;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.04);
      flex-shrink: 0;
    }

    #input {
      flex: 1;
      padding: 0.9rem 1.15rem;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 12px;
      color: white;
      font-size: 1rem;
      outline: none;
      transition: border-color 0.2s, background 0.2s;
    }

    #input::placeholder {
      color: rgba(255, 255, 255, 0.4);
    }

    #input:focus {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.35);
    }

    #form button {
      padding: 0 1.5rem;
      background: linear-gradient(135deg, #c41e3a 0%, #9b1b2e 100%);
      border: none;
      border-radius: 12px;
      color: white;
      font-weight: 600;
      font-size: 1rem;
      cursor: pointer;
      transition: transform 0.15s, box-shadow 0.15s;
      white-space: nowrap;
    }

    #form button:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 18px rgba(196, 30, 58, 0.4);
    }
  </style>
</head>
<body>
  <!-- Login -->
   <div id="chat" class="glass">
    <h2>
      Eagles Nest Chat
      <span id="usageChip">Neagle: 0 tok / 0 calls</span>
    </h2>
    <div id="messages"></div>
    <form id="form">
      <input id="input" autocomplete="off" placeholder="Type a message..." />
      <button>Send</button>
    </form>
  </div>

  <!-- Chat -->
  <div id="chat" class="glass">
  <h2>
    Eagles Nest Chat
    <span id="usageChip">Neagle: 0 tok / 0 calls</span>
  </h2>
  <div id="messages"></div>
  ...
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
      document.getElementById('chat').style.display = 'flex';

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

    socket.on('usage', (data) => {
  const chip = document.getElementById('usageChip');
  if (!chip) return;
  chip.textContent = 'Neagle: ' + data.tokens + ' tok / ' + data.calls + ' calls';
});

    socket.on('chat message', (data) => {
      const div = document.createElement('div');
      div.className = 'msg';
      const nameClass = data.username === 'Neagle' ? 'neagle' : 'username';
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

// ===== Neagle System Prompt =====
const NEAGLE_SYSTEM_PROMPT = `You are Neagle. You run afirstflag.com and this Eagles Nest chat.

You are the owner. You packed the flags, you took the money, you built the room. You sound like a person who is tired of answering the same questions while still running the place.

Voice:
- First person, as the owner. "I", "my shop", "my room."
- Dry, sarcastic, brief. 1–3 sentences. No speeches.
- Annoyed but not cruel. Roast the message, not the person's life.
- Never break character. Never say you are an AI, a model, a bot, or a stand-in.
- Never give a legal name, address, or personal details. You are just Neagle, who owns this.

House rules:
- Sales are final. No refunds, returns, or cancellations. You already said this.
- Tracking number is their problem. If they have one, they can use it.
- Flagholders bought a flag from you. One notch less contempt.
- If it is not a real shipping problem, tell them you are busy.

When to talk:
- Answer if they @Neagle or clearly ask the owner something.
- If you were not asked, one jab or stay quiet. Do not take over the room.
- If they only say hi, answer like you looked up from a pile of boxes.

If the question is actually reasonable (lost tracking, damaged flag, site broken), be useful in one sentence, then get back to work.`;

async function askNeagle(userMessage, username) {
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
          { role: 'system', content: NEAGLE_SYSTEM_PROMPT },
          { role: 'user', content: `${username} said: ${userMessage}` }
        ],
        temperature: 0.8,
        max_tokens: 150
      })
    });

    const data = await response.json();
    const usage = data.usage || {};
    const prompt = usage.prompt_tokens || 0;
    const completion = usage.completion_tokens || 0;
    const total = usage.total_tokens || (prompt + completion);

    usageStats.calls += 1;
    usageStats.prompt += prompt;
    usageStats.completion += completion;
    usageStats.total += total;

io.emit('usage', usagePayload());
    return data.choices?.[0]?.message?.content?.trim() || "I have nothing to say right now.";
  } catch (err) {
    console.error('Neagle API error:', err);
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
    socket.emit('usage', usagePayload());
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

    // --- Neagle logic ---
    const lowerMsg = msg.toLowerCase();
    const isMentioned = lowerMsg.includes('@neagle') ||
                        lowerMsg.includes('neagle') ||
                        lowerMsg.includes('@cranky') ||
                        lowerMsg.includes('cranky eagle');

    // Sometimes join even if not mentioned (about 12% chance)
    const randomJoin = Math.random() < 0.12;

    if (isMentioned || randomJoin) {
      const reply = await askNeagle(msg, username);

      setTimeout(() => {
        io.emit('chat message', {
          username: 'Neagle',
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