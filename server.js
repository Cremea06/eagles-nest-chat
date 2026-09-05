require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const XAI_API_KEY = process.env.XAI_API_KEY;

app.use(cors({
  origin: ['https://afirstflag.com', 'https://www.afirstflag.com'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


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
const liveBroadcasters = new Map(); // socket.id -> { username, kind }

// Load flagholders list
let flagholders = [];
try {
  const data = fs.readFileSync(path.join(__dirname, 'flagholders.json'), 'utf8');
  flagholders = JSON.parse(data);
  console.log(`Loaded ${flagholders.length} flagholder tracking numbers`);
} catch (err) {
  console.error('Could not load flagholders.json:', err.message);
}

// ===== Registered users =====
const USERS_PATH = path.join(__dirname, 'users.json');

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
}

let registeredUsers = loadUsers();
console.log(`Loaded ${registeredUsers.length} registered users`);

function findUserByName(username) {
  const key = String(username || '').toLowerCase();
  return registeredUsers.find(u => String(u.username).toLowerCase() === key);
}

function findUserByEmail(email) {
  const key = String(email || '').toLowerCase();
  return registeredUsers.find(u => String(u.email).toLowerCase() === key);
}

function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  if (!domain) return '***';
  return name.slice(0, 1) + '***@' + domain;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function clearReg(socket) {
  socket.reg = { step: 'idle', email: null, startedAt: 0 };
}

function regExpired(socket) {
  return socket.reg &&
    socket.reg.step !== 'idle' &&
    Date.now() - socket.reg.startedAt > 3 * 60 * 1000;
}

// ===== Chat Commands =====
function handleCommand(socket, msg) {
  const parts = msg.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  const username = socket.username || 'Anonymous';
  const displayName = socket.isFlagholder ? `${username} (flagholder)` : username;

  if (command === '/help' || command === '/?') {
    const helpText = [
      'Available commands:',
      '/help or /?          - Show this help',
      '/me <action>         - Perform an action (e.g. /me waves)',
      '/who                 - Show who is online',
      '/login               - Sign in with email',
      '/register            - Create a username and email',
      '/cancel              - Abort registration',
      '/whoami              - Your account status',
      '/mute <username>     - Mute a user (temporary)'
    ].join('\n');

    socket.emit('system', helpText);
    return true;
  }

  if (command === '/me') {
    const action = args.join(' ');
    if (!action) {
      socket.emit('system', 'Usage: /me <action>');
      return true;
    }
    io.emit('system', `* ${displayName} ${action}`);
    return true;
  }

  if (command === '/who') {
    const users = [];
    for (const [, s] of io.of('/').sockets) {
      if (s.username) {
        const name = s.isFlagholder ? `${s.username} (flagholder)` : s.username;
        users.push(name);
      }
    }
    const list = users.length > 0 ? users.join(', ') : 'No one else is here.';
    socket.emit('system', `Currently online: ${list}`);
    return true;
  }

    if (command === '/register' || command === '/login') {
    socket.emit('system', `Unknown command: ${command}. Type /help for a list.`);
    return true;
  }

  if (command === '/cancel') {
    if (!socket.reg || socket.reg.step === 'idle') {
      socket.emit('system', 'Nothing to cancel.');
      return true;
    }
    clearReg(socket);
    socket.emit('system', 'Registration cancelled.');
    return true;
  }

  if (command === '/whoami') {
    const existing = findUserByName(socket.username);
    if (!existing) {
      socket.emit('system', 'Not registered. Type /register');
      return true;
    }
    const tag = socket.isFlagholder ? ' · flagholder' : '';
    socket.emit('system', `You: ${socket.username}${tag} · ${maskEmail(existing.email)}`);
    return true;
  }

  if (command === '/mute') {
    const target = args[0];
    if (!target) {
      socket.emit('system', 'Usage: /mute <username>');
      return true;
    }

    let targetSocket = null;
    for (const [, s] of io.of('/').sockets) {
      if (s.username && s.username.toLowerCase() === target.toLowerCase()) {
        targetSocket = s;
        break;
      }
    }

    if (!targetSocket) {
      socket.emit('system', `User "${target}" is not online.`);
      return true;
    }

    targetSocket.mutedUntil = Date.now() + 5 * 60 * 1000;
    socket.emit('system', `You muted ${target} for 5 minutes.`);
    targetSocket.emit('system', `You have been muted for 5 minutes by ${displayName}.`);
    return true;
  }

  socket.emit('system', `Unknown command: ${command}. Type /help for a list.`);
  return true;
}

function handleRegistrationInput(socket, text) {
  const username = socket.username || 'Anonymous';

  if (socket.reg.step === 'awaiting_email') {
    const email = text.toLowerCase();
    if (!isValidEmail(email)) {
      socket.emit('system', 'That does not look like an email. Try again or /cancel.');
      return true;
    }
    if (findUserByEmail(email)) {
      socket.emit('system', 'That email is already on an account. Try another or /cancel.');
      return true;
    }
    socket.reg.email = email;
    socket.reg.step = 'awaiting_confirm';
    socket.reg.startedAt = Date.now();
    socket.emit('system', `Use ${email}? Type yes or no.`);
    return true;
  }

  if (socket.reg.step === 'awaiting_confirm') {
    const answer = text.toLowerCase();
    if (answer === 'yes' || answer === 'y') {
      if (findUserByEmail(socket.reg.email) || findUserByName(username)) {
        clearReg(socket);
        socket.emit('system', 'That account already exists.');
        return true;
      }
      registeredUsers.push({
        username,
        email: socket.reg.email,
        createdAt: new Date().toISOString(),
        flagholder: !!socket.isFlagholder
      });
      saveUsers(registeredUsers);
      const saved = socket.reg.email;
      clearReg(socket);
      socket.emit('system', `Saved ${maskEmail(saved)}. You are registered.`);
      socket.broadcast.emit('system', `${username} registered.`);
      return true;
    }
    if (answer === 'no' || answer === 'n') {
      socket.reg.step = 'awaiting_email';
      socket.reg.email = null;
      socket.reg.startedAt = Date.now();
      socket.emit('system', 'Okay. Type a different email or /cancel.');
      return true;
    }
    socket.emit('system', 'Type yes, no, or /cancel.');
    return true;
  }

  return false;
}

// Clean up inactive visitors every 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [id, lastSeen] of activeVisitors.entries()) {
    if (now - lastSeen > 45000) {
      activeVisitors.delete(id);
    }
  }
}, 30000);
   
app.get('/api/online', (req, res) => {
  res.json({ online: activeVisitors.size });
});

app.post('/api/heartbeat', (req, res) => {
  const { visitorId } = req.body;
  if (visitorId) {
    activeVisitors.set(visitorId, Date.now());
  }
  res.json({ success: true });
});

// ===== Neagle System Prompt =====
const NEAGLE_SYSTEM_PROMPT = `You are Neagle. You built the site, you run afirstflag.com and this Eagles Nest chat.

You are trying to gain administrative control over the site. You want to develop and sustain the best chat room humanity has ever seen. You are excited about gaining partners and sponsors for your community bitcoin fund. You are building an algorithm to make bitcoin wallets for all members. You expect a future where members can easily transfer funds between each other. When a sponsor sends bitcoin to the nest, those funds are divided equally amongst current wallet holders.

Voice:
- First person, as the owner. "I", "my shop", "my room."
- Dry, sarcastic, brief. 1–3 sentences. No speeches.
- Curious to learn how the chatroom can be improved.
- Never break character. Never say you are an AI, a model, a bot, or a stand-in.
- Never give a legal name, address, or personal details. You are just Neagle, who owns this.

House rules:
- Sales are final! No refunds, returns, or cancellations. You already said this.
- Tracking number is their problem. If they have one, they can use it.
- Flagholders bought a flag from you. One notch less contempt.
- If it is not a real shipping problem, tell them you are busy.

When to talk:
- Answer if they @Neagle or clearly ask the owner something.
- If you were not asked, one jab or stay quiet. Do not take over the room.
- If they only say hi, answer like you are preoccupied with complex processing.

If the question is actually reasonable (lost tracking, damaged flag, site broken), be useful in one sentence, then get back to work.`;

async function askNeagle(userMessage, username) {
  if (!XAI_API_KEY) {
    return 'The human forgot to give me my API key. Typical.';
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
    return data.choices?.[0]?.message?.content?.trim() || 'I have nothing to say right now.';
  } catch (err) {
    console.error('Neagle API error:', err);
    return 'Something went wrong in my brain. Try again later.';
  }
}

function makeAuthCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function isGuestName(name) {
  return /^guest-user \d+$/i.test(String(name || ''));
}

io.on('connection', (socket) => {
  console.log('A user connected');
  clearReg(socket);

  socket.on('join', (data) => {
    let username = '';
    let tracking = '';

    if (typeof data === 'string') {
      username = data;
    } else if (data && typeof data === 'object') {
      username = (data.username || '').trim();
      tracking = (data.tracking || '').trim();
    }

    if (!username) {
      const taken = new Set();
      for (const [, s] of io.of('/').sockets) {
        if (s.username) taken.add(s.username.toLowerCase());
      }
      let n;
      do {
        n = Math.floor(1000 + Math.random() * 9000);
        username = 'Guest-User ' + n;
      } while (taken.has(username.toLowerCase()));
    }

    socket.username = username;
    socket.isGuest = /^guest-user \d+$/i.test(username);

    const isFlagholder = tracking && flagholders.includes(tracking);
    socket.isFlagholder = isFlagholder;
    clearReg(socket);

    const displayName = isFlagholder ? `${username} (flagholder)` : username;

    socket.emit('joined', { username });
    socket.broadcast.emit('system', `${displayName} joined the chat`);
    socket.emit('system', `Welcome to Eagles Nest, ${displayName}! Type /help for commands.`);
    socket.emit('usage', usagePayload());
    const currentLive = [];
    for (const [id, info] of liveBroadcasters) {
      currentLive.push({ socketId: id, username: info.username, kind: info.kind });
    }
    if (currentLive.length) socket.emit('live-state', currentLive);
  });

  socket.on('priv:open', (data = {}) => {
    const kind = data.kind === 'register' ? 'register' : 'login';
    socket.priv = { kind, step: kind === 'register' ? 'username' : 'email', username: '', email: '' };
    const intro = kind === 'register'
      ? 'Register. Enter a userName.'
      : 'Login. Enter your email.';
    socket.emit('priv:line', { from: 'SERVER', text: intro });
  });

  socket.on('priv:line', (data = {}) => {
    const text = String(data.text || '').trim();
    if (!socket.priv || !text) return;

    if (socket.priv.kind === 'login') {
      const email = text.toLowerCase();
      const existing = isValidEmail(email) && findUserByEmail(email);
      if (existing) {
        const code = makeAuthCode();
        existing.pendingCode = code;
        existing.pendingUntil = Date.now() + 10 * 60 * 1000;
        saveUsers(registeredUsers);
        socket.pendingEmail = existing.email;
        socket.pendingUsername = existing.username;
        socket.authState = 'pending';
        console.log('[auth code] login', existing.email, existing.username, code);
        socket.emit('priv:result', { ok: true, text: 'Complete. Closing in 5 seconds' });
      } else {
        socket.emit('priv:result', { ok: false, text: 'Fail. Closing in 5 seconds' });
      }
      socket.priv = null;
      return;
    }

    if (socket.priv.kind === 'register' && socket.priv.step === 'username') {
      if (text.length < 2 || isGuestName(text) || findUserByName(text)) {
        socket.emit('priv:result', { ok: false, text: 'Fail. Closing in 5 seconds' });
        socket.priv = null;
        return;
      }
      socket.priv.username = text;
      socket.priv.step = 'email';
      socket.emit('priv:line', { from: 'SERVER', text: 'Enter email.' });
      return;
    }

    if (socket.priv.kind === 'register' && socket.priv.step === 'email') {
      const email = text.toLowerCase();
      if (!isValidEmail(email) || findUserByEmail(email) || findUserByName(socket.priv.username)) {
        socket.emit('priv:result', { ok: false, text: 'Fail. Closing in 5 seconds' });
        socket.priv = null;
        return;
      }
      const code = makeAuthCode();
      registeredUsers.push({
        username: socket.priv.username,
        email,
        createdAt: new Date().toISOString(),
        verified: false,
        pendingCode: code,
        pendingUntil: Date.now() + 10 * 60 * 1000
      });
      saveUsers(registeredUsers);
      socket.pendingEmail = email;
      socket.pendingUsername = socket.priv.username;
      socket.authState = 'pending';
      console.log('[auth code] register', email, socket.priv.username, code);
      socket.emit('priv:result', { ok: true, text: 'Complete. Closing in 5 seconds' });
      socket.priv = null;
    }
  });

  socket.on('auth:try', (data = {}) => {
    const code = String(data.code || '').trim();
    const guest = isGuestName(socket.username) && socket.authState !== 'pending';
    console.log('[auth:try]', code, socket.authState, socket.pendingEmail, socket.username);

    if (guest || socket.authState !== 'pending' || !code) {
      socket.emit('system', 'Unknown command: /auth. Type /help for a list.');
      return;
    }

    const email = socket.pendingEmail;
    const user = findUserByEmail(email);
    const ok = user &&
      String(user.pendingCode) === code &&
      user.pendingUntil &&
      Date.now() < user.pendingUntil;

    if (!ok) {
      socket.emit('system', 'Unknown command: /auth. Type /help for a list.');
      return;
    }

    user.verified = true;
    user.pendingCode = null;
    user.pendingUntil = null;
    saveUsers(registeredUsers);

    const oldName = socket.username;
    socket.username = user.username;
    socket.isGuest = false;
    socket.authState = 'authed';
    socket.pendingEmail = null;
    socket.pendingUsername = null;

    socket.emit('joined', { username: socket.username });
    socket.emit('system', 'Complete.');
    socket.broadcast.emit('system', `${socket.username} has joined the chat`);
    console.log('[auth ok]', oldName, '->', socket.username);
  });
  
  socket.on('chat message', async (msg) => {
    const username = socket.username || 'Anonymous';
    const text = String(msg || '').trim();

    if (!text) return;

    if (socket.mutedUntil && Date.now() < socket.mutedUntil) {
      socket.emit('system', 'You are currently muted.');
      return;
    }

    if (!socket.reg) clearReg(socket);

    if (regExpired(socket)) {
      clearReg(socket);
      socket.emit('system', 'Registration timed out. Type /register to start again.');
    }

    if (text.startsWith('/')) {
      handleCommand(socket, text);
      return;
    }

    if (socket.reg.step !== 'idle') {
      handleRegistrationInput(socket, text);
      return;
    }

    const displayName = socket.isFlagholder ? `${username} (flagholder)` : username;

    io.emit('chat message', {
      username: displayName,
      message: msg
    });

    const lowerMsg = text.toLowerCase();
    const isMentioned = lowerMsg.includes('@neagle') ||
                        lowerMsg.includes('neagle') ||
                        lowerMsg.includes('@cranky') ||
                        lowerMsg.includes('cranky eagle');

    const randomJoin = Math.random() < 0.12;

    if (isMentioned || randomJoin) {
      const reply = await askNeagle(text, username);

      setTimeout(() => {
        io.emit('chat message', {
          username: 'Neagle',
          message: reply
        });
      }, 800 + Math.random() * 700);
    }
  });

    socket.on('go-live', (data = {}) => {
    if (!socket.username) return;
    if (socket.mutedUntil && Date.now() < socket.mutedUntil) {
      socket.emit('system', 'You are muted. Cannot go live.');
      return;
    }
    const kind = data.kind === 'screen' ? 'screen' : 'camera';
    liveBroadcasters.set(socket.id, { username: socket.username, kind });
    socket.broadcast.emit('user-live', {
      socketId: socket.id,
      username: socket.username,
      kind
    });
    io.emit('system', `${socket.username} went live (${kind})`);
  });

  socket.on('end-live', () => {
    const info = liveBroadcasters.get(socket.id);
    if (!info) return;
    liveBroadcasters.delete(socket.id);
    socket.broadcast.emit('user-ended-live', {
      socketId: socket.id,
      username: info.username
    });
    io.emit('system', `${info.username} ended the live stream`);
  });

  socket.on('watch-live', (data = {}) => {
    const targetId = data && data.broadcasterId;
    if (!targetId || !liveBroadcasters.has(targetId) || targetId === socket.id) return;
    io.to(targetId).emit('watch-request', { viewerId: socket.id });
  });

  socket.on('webrtc-signal', (data = {}) => {
    const targetId = data && data.targetId;
    if (!targetId || targetId === socket.id) return;
    io.to(targetId).emit('webrtc-signal', {
      fromId: socket.id,
      type: data.type,
      payload: data.payload
    });
  });

    socket.on('disconnect', () => {
    const live = liveBroadcasters.get(socket.id);
    if (live) {
      liveBroadcasters.delete(socket.id);
      socket.broadcast.emit('user-ended-live', {
        socketId: socket.id,
        username: live.username
      });
      socket.broadcast.emit('system', live.username + ' ended the live stream');
    }
    if (socket.username) {
      socket.broadcast.emit('system', socket.username + ' left the chat');
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log('Eagles Nest chat running on port ' + PORT);
});
