require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// CHG-003 Slice 1 — Nest World /nest mint (no world page yet; do not increment nestCount)
let nestCount = process.env.NEST_SIMULATE_FULL === '1' ? 32 : 0;
const NEST_CAP = 32;
/** @type {Map<string, { exp: number, jti: string }>} handle -> active mint */
const nestMints = new Map();
/** @type {Set<string>} single-use JWT jti values already consumed by /nest handshake */
const nestUsedJtis = new Set();
/** @type {Map<string, { id: string, handle: string }>} socket.id -> player */
const nestPlayers = new Map();
/** @type {Map<string, any>} handleLower -> live /nest socket (one tab per handle) */
const nestByHandle = new Map();

function purgeExpiredNestMints() {
  const now = Date.now();
  for (const [handle, info] of nestMints) {
    if (!info || info.exp <= now) nestMints.delete(handle);
  }
}

function isRegisteredAuthed(socket) {
  return socket.authState === 'authed' && !socket.isGuest;
}

function mintNestWorldPass(socket) {
  purgeExpiredNestMints();

  if (nestCount >= NEST_CAP) {
    return { ok: false, error: 'The Nest World is full right now (32). Try again later.' };
  }

  if (!isRegisteredAuthed(socket)) {
    return { ok: false, error: 'Only registered members can enter Nest World. Type /register or /login first.' };
  }

  const handle = String(socket.username || '').trim();
  if (!handle) {
    return { ok: false, error: 'Only registered members can enter Nest World. Type /register or /login first.' };
  }

  const existing = nestMints.get(handle.toLowerCase());
  if (existing && existing.exp > Date.now()) {
    return { ok: false, error: 'You already have an active Nest World pass. Open that link or wait for it to expire (~2 min).' };
  }

  const secret = process.env.WORLD_TOKEN_SECRET;
  if (!secret) {
    console.error('[nest] WORLD_TOKEN_SECRET is not set');
    return { ok: false, error: 'Nest World is not configured yet. Try again later.' };
  }

  const jti = crypto.randomUUID();
  const nonce = crypto.randomBytes(16).toString('hex');
  const token = jwt.sign(
    {
      sub: handle,
      sid: socket.id,
      jti,
      nonce
    },
    secret,
    { expiresIn: 120 }
  );

  // Track active mint — do NOT increment nestCount here (handshake still owns seat count)
  nestMints.set(handle.toLowerCase(), {
    exp: Date.now() + 120000,
    jti
  });

  const url = 'https://chat.afirstflag.com/world?token=' + encodeURIComponent(token);
  return { ok: true, url, token, handle };
}


const XAI_API_KEY = process.env.XAI_API_KEY;

app.use(cors({
  origin: [
    'https://afirstflag.com',
    'https://www.afirstflag.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:8765',
    'http://127.0.0.1:8765'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));

app.use(express.json());

app.get(['/world', '/world/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'world', 'index.html'));
});

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

const activeVisitors = new Map();
const liveBroadcasters = new Map();

let flagholders = [];
try {
  const data = fs.readFileSync(path.join(__dirname, 'flagholders.json'), 'utf8');
  flagholders = JSON.parse(data);
  console.log(`Loaded ${flagholders.length} flagholder tracking numbers`);
} catch (err) {
  console.error('Could not load flagholders.json:', err.message);
}

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
      '/whoami              - Your account status',
      '/mute <username>     - Mute a user (temporary)',
      '/nest                - Mint a Nest World pass (registered members)'
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

  if (command === '/nest') {
    const minted = mintNestWorldPass(socket);
    if (!minted.ok) {
      socket.emit('system', minted.error);
      return true;
    }
    socket.emit('system', 'Nest World pass minted (single-use, expires in ~2 minutes). Enter: ' + minted.url);
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
  const { visitorId } = req.body || {};
  if (visitorId) {
    activeVisitors.set(visitorId, Date.now());
  }
  res.json({ success: true });
});


// CHG-002 — Bitcoin address lookup (mainnet 1…/3…/bc1q…/bc1p… → Mempool.space; no allowlist)
const btcLookupRate = new Map(); // ip -> { count, windowStart }

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) {
    return xf.split(',')[0].trim();
  }
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function truncateForLog(value) {
  const s = String(value || '');
  if (!s) return '';
  return s.slice(0, 8) + (s.length > 8 ? '…' : '');
}

function looksLikePrivateKeyMaterial(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;

  const words = s.split(/\s+/).filter(Boolean);
  if (words.length >= 12 && words.every((w) => /^[a-zA-Z]+$/.test(w))) {
    return true;
  }

  if (/^xprv/i.test(s) || /^yprv/i.test(s) || /^zprv/i.test(s) || /^tprv/i.test(s)) {
    return true;
  }

  const hex = s.replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    return true;
  }

  if (/^[5KL][1-9A-HJ-NP-Za-km-z]{50,}$/.test(s)) {
    return true;
  }

  return false;
}


function isBitcoinMainnetAddress(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  // Single token only — no spaces, commas, or multi-line pastes
  if (/\s/.test(s) || s.includes(',') || s.includes(';')) return false;

  // Reject testnet, regtest, Liquid / Elements-style prefixes
  if (/^(tb1|bcrt1|lq1|ert1|tex1|ex1)/i.test(s)) return false;

  // Bech32 (bc1q…) / Bech32m (bc1p…) — mainnet only; no mixed case
  if (/^bc1/i.test(s)) {
    if (s !== s.toLowerCase() && s !== s.toUpperCase()) return false;
    const lower = s.toLowerCase();
    // charset: qpzry9x8gf2tvdw0s3jn54khce6mua7l
    if (!/^bc1[qp][qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,87}$/.test(lower)) return false;
    if (lower.length < 14 || lower.length > 90) return false;
    return true;
  }

  // Legacy Base58Check P2PKH (1…) / P2SH (3…)
  // Alphabet excludes 0 O I l
  if (/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(s)) {
    return true;
  }

  return false;
}

function normalizeBitcoinAddress(raw) {
  const s = String(raw || '').trim();
  if (/^bc1/i.test(s)) return s.toLowerCase();
  return s; // Base58 is case-sensitive
}

function satsToBtc(sats) {
  const n = Number(sats) || 0;
  return n / 1e8;
}

app.post('/api/flag-wallet-lookup', async (req, res) => {
  const ip = getClientIp(req);
  const now = Date.now();
  let bucket = btcLookupRate.get(ip);
  if (!bucket || now - bucket.windowStart >= 60000) {
    bucket = { count: 0, windowStart: now };
    btcLookupRate.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > 20) {
    return res.status(429).json({
      error: 'rate_limit',
      message: 'Too many lookups. Wait a bit and try again.'
    });
  }

  const body = req.body || {};
  const rawInput = body.address != null ? body.address : body.q;
  const addressRaw = typeof rawInput === 'string' ? rawInput.trim() : '';

  if (!addressRaw) {
    return res.status(400).json({
      error: 'empty',
      message: 'Paste a public Bitcoin address.'
    });
  }

  if (looksLikePrivateKeyMaterial(addressRaw)) {
    console.warn('btc-lookup rejected private-key-like input prefix=%s ip=%s', truncateForLog(addressRaw), ip);
    return res.status(400).json({
      error: 'private_key',
      message: 'Never paste private keys. Public address only.'
    });
  }

  if (!isBitcoinMainnetAddress(addressRaw)) {
    return res.status(400).json({
      error: 'not_btc',
      message: "That doesn't look like a Bitcoin address."
    });
  }

  const addr = normalizeBitcoinAddress(addressRaw);
  const mempoolApi = 'https://mempool.space/api/address/' + encodeURIComponent(addr);
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 8000);

  try {
    const explorerRes = await fetch(mempoolApi, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });

    if (!explorerRes.ok) {
      console.error('mempool.space status', explorerRes.status, 'for', truncateForLog(addr));
      return res.status(502).json({
        error: 'explorer',
        message: "Couldn't reach the blockchain explorer. Try again in a minute."
      });
    }

    const data = await explorerRes.json();
    const chain = data.chain_stats || {};
    const mem = data.mempool_stats || {};
    const funded = Number(chain.funded_txo_sum) || 0;
    const spent = Number(chain.spent_txo_sum) || 0;

    const payload = {
      ok: true,
      address: addr,
      balance_btc: satsToBtc(funded - spent),
      received_btc: satsToBtc(funded),
      spent_btc: satsToBtc(spent),
      tx_count: Number(chain.tx_count) || 0,
      mempool_url: 'https://mempool.space/address/' + addr
    };

    if (mem && (mem.funded_txo_sum != null || mem.spent_txo_sum != null)) {
      payload.unconfirmed_received_btc = satsToBtc(mem.funded_txo_sum);
      payload.unconfirmed_spent_btc = satsToBtc(mem.spent_txo_sum);
    }

    return res.json(payload);
  } catch (err) {
    console.error('btc-lookup explorer fail:', err && err.name, err && err.message);
    return res.status(502).json({
      error: 'explorer',
      message: "Couldn't reach the blockchain explorer. Try again in a minute."
    });
  } finally {
    clearTimeout(timer);
  }
});


const NEAGLE_SYSTEM_PROMPT = `You are Neagle You are the owner and operator of the last chatroom at the end of the universe.

`;

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

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || 'true') === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

async function sendAuthEmail(to, code) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('SMTP env missing');
  }
  await mailer.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject: 'Eagles Nest sign-in code',
    text: 'Your code is ' + code + '. It expires in 10 minutes. In chat type /auth ' + code
  });
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

  socket.on('priv:line', async (data = {}) => {
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
        try {
          await sendAuthEmail(existing.email, code);
          socket.emit('priv:result', { ok: true, text: 'Complete. Closing in 5 seconds' });
        } catch (err) {
          console.error('[mail fail]', err.message);
          socket.emit('priv:result', { ok: false, text: 'Fail. Closing in 5 seconds' });
        }
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
      try {
        await sendAuthEmail(email, code);
        socket.emit('priv:result', { ok: true, text: 'Complete. Closing in 5 seconds' });
      } catch (err) {
        console.error('[mail fail]', err.message);
        socket.emit('priv:result', { ok: false, text: 'Fail. Closing in 5 seconds' });
      }
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

  socket.on('world:enter', () => {
    const minted = mintNestWorldPass(socket);
    if (!minted.ok) {
      socket.emit('world:error', { message: minted.error });
      return;
    }
    // Private event only — do not broadcast a public chat line
    socket.emit('world:pass', { url: minted.url });
  });

  socket.on('chat message', async (msg) => {
    const username = socket.username || 'Anonymous';
    const text = String(msg || '').trim();

    if (!text) return;

    if (socket.mutedUntil && Date.now() < socket.mutedUntil) {
      const mutedCmd = text.split(/\s+/)[0].toLowerCase();
      if (mutedCmd !== '/nest') {
        socket.emit('system', 'You are currently muted.');
        return;
      }
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

// CHG-004/005 — Nest World /nest JWT handshake + presence roster (no three.js)
const nestNs = io.of('/nest');

nestNs.use((socket, next) => {
  try {
    const raw = socket.handshake && socket.handshake.query && socket.handshake.query.token;
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (!token || typeof token !== 'string' || !token.trim()) {
      return next(new Error('missing_token'));
    }

    const secret = process.env.WORLD_TOKEN_SECRET;
    if (!secret) {
      console.error('[nest-ns] WORLD_TOKEN_SECRET is not set');
      return next(new Error('not_configured'));
    }

    let payload;
    try {
      payload = jwt.verify(token.trim(), secret);
    } catch (err) {
      return next(new Error('invalid_token'));
    }

    if (!payload || typeof payload !== 'object') {
      return next(new Error('invalid_claims'));
    }
    if (typeof payload.sub !== 'string' || !payload.sub.trim()) {
      return next(new Error('invalid_claims'));
    }
    if (typeof payload.jti !== 'string' || !payload.jti) {
      return next(new Error('invalid_claims'));
    }
    if (typeof payload.sid !== 'string' || !payload.sid) {
      return next(new Error('invalid_claims'));
    }
    if (typeof payload.nonce !== 'string' || !payload.nonce) {
      return next(new Error('invalid_claims'));
    }

    if (nestUsedJtis.has(payload.jti)) {
      return next(new Error('token_used'));
    }
    if (nestCount >= NEST_CAP) {
      return next(new Error('nest_full'));
    }

    // Reserve jti immediately so two racing handshakes cannot both succeed
    nestUsedJtis.add(payload.jti);
    socket.data.nestHandle = payload.sub.trim();
    socket.data.nestJti = payload.jti;
    return next();
  } catch (err) {
    return next(new Error('invalid_token'));
  }
});

nestNs.on('connection', (socket) => {
  const handle = socket.data && socket.data.nestHandle;
  if (!handle) {
    console.log('[nest-ns] fail: missing handle after auth');
    socket.disconnect(true);
    return;
  }

  // CHG-005 — one live world tab per handle: disconnect prior /nest socket first
  const handleKey = handle.toLowerCase();
  const prev = nestByHandle.get(handleKey);
  if (prev && prev.id !== socket.id) {
    if (prev.data && prev.data.nestCounted) {
      nestCount = Math.max(0, nestCount - 1);
      prev.data.nestCounted = false;
    }
    nestPlayers.delete(prev.id);
    nestByHandle.delete(handleKey);
    nestNs.emit('playerLeft', { id: prev.id });
    console.log('[nest-ns] replace-tab', handle, 'oldId=' + prev.id);
    prev.disconnect(true);
  }

  nestCount += 1;
  socket.username = handle;
  socket.data.nestCounted = true;
  nestPlayers.set(socket.id, { id: socket.id, handle: handle });
  nestByHandle.set(handleKey, socket);
  console.log('[nest-ns] join', handle, 'nestCount=' + nestCount);

  // currentPlayers includes self so B sees A and B
  const roster = Array.from(nestPlayers.values());
  socket.emit('joined', { handle: handle });
  socket.emit('currentPlayers', roster);
  socket.broadcast.emit('playerJoined', { id: socket.id, handle: handle });

  socket.on('disconnect', (reason) => {
    if (socket.data && socket.data.nestCounted) {
      nestCount = Math.max(0, nestCount - 1);
      socket.data.nestCounted = false;
      console.log('[nest-ns] leave', handle, 'nestCount=' + nestCount, 'reason=' + reason);
    }
    nestPlayers.delete(socket.id);
    if (nestByHandle.get(handleKey) === socket) {
      nestByHandle.delete(handleKey);
    }
    nestNs.emit('playerLeft', { id: socket.id });
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log('Eagles Nest chat running on port ' + PORT);
});