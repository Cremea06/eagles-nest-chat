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
      '/register            - Save an email to this username',
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

  if (command === '/register') {
    if (!socket.username) {
      socket.emit('system', 'Join with a username first.');
      return true;
    }
    const existing = findUserByName(socket.username);
    if (existing) {
      socket.emit('system', `Already registered as ${maskEmail(existing.email)}.`);
      return true;
    }
    socket.reg = { step: 'awaiting_email', email: null, startedAt: Date.now() };
    socket.emit('system', 'Registration started. Type your email. Only you see it. /cancel to abort.');
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

    .glass {
      background: rgba(255, 255, 255, 0.07);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 18px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }

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
      white-space: pre-wrap;
    }

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

          body.nest-on {
      display: grid;
      grid-template-columns: 1fr minmax(280px, 920px) 340px 1fr;
      gap: 20px;
      align-items: start;
    }

    body.nest-on #login { display: none !important; }

    body.nest-on #chat {
      display: flex;
      grid-column: 2;
      width: 100%;
      max-width: none;
      margin: 0;
    }

    #liveCard {
      display: none;
      grid-column: 3;
      padding: 12px;
      position: sticky;
      top: 16px;
    }

    body.nest-on #liveCard { display: block; }

    .live-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
      padding: 2px 4px;
    }

    .live-head h3 {
      font-size: 0.95rem;
      font-weight: 600;
    }

    .live-badge {
      display: none;
      align-items: center;
      gap: 6px;
      font-size: 0.7rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      color: #fff;
      background: #c41e3a;
      padding: 3px 8px;
      border-radius: 999px;
    }

    .live-badge.on { display: inline-flex; }

    .live-badge .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #fff;
      animation: livePulse 1.1s ease-in-out infinite;
    }

    @keyframes livePulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }

    .viewport {
      position: relative;
      background: rgba(0, 0, 0, 0.28);
      border-radius: 12px;
      overflow: hidden;
      aspect-ratio: 16 / 10;
    }

    .viewport video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: none;
      background: #07111f;
    }

    .viewport.streaming video { display: block; }

    .placeholder {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      color: #a0aec0;
      font-size: 0.85rem;
      line-height: 1.4;
      padding: 12px;
    }

    .viewport.streaming .placeholder { display: none; }

    .live-status {
      min-height: 18px;
      margin: 8px 4px 10px;
      font-size: 0.75rem;
      color: #a0aec0;
    }

    .live-status.err { color: #ff8a97; }
    .live-status.ok { color: #7dcea0; }

    .live-actions { display: grid; gap: 8px; }

    .btn-live {
      padding: 0.75rem 1rem;
      background: linear-gradient(135deg, #c41e3a 0%, #9b1b2e 100%);
      border: none;
      border-radius: 12px;
      color: white;
      font-weight: 600;
      cursor: pointer;
    }

    .btn-ghost {
      padding: 0.75rem 1rem;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 12px;
      color: #f0f4f8;
      font-weight: 600;
      cursor: pointer;
    }

    .chooser, .live-controls {
      display: none;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .chooser.open, .live-controls.on { display: grid; }

    .choice {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.15);
      color: #f0f4f8;
      border-radius: 12px;
      padding: 10px 8px;
      cursor: pointer;
      font-weight: 600;
      font-size: 0.85rem;
    }

    .choice small {
      display: block;
      font-weight: 500;
      color: #a0aec0;
      margin-top: 3px;
      font-size: 0.7rem;
    }

    @media (max-width: 1100px) {
      body.nest-on {
        grid-template-columns: 1fr minmax(280px, 920px) 1fr;
      }
      body.nest-on #liveCard {
        grid-column: 2;
        position: static;
      }
    }

    }
  </style>
</head>
<body>
  <div id="login" class="glass">
    <h2>Welcome to Eagles Nest</h2>
    <p>Enter a username to join the chat</p>
    <input id="usernameInput" placeholder="Your username" maxlength="20" />
    <input id="trackingInput" placeholder="Tracking # (optional)" maxlength="40" />
    <button onclick="joinChat()">Join Chat</button>
  </div>

    <aside id="liveCard" class="glass">
    <div class="live-head">
      <h3>Nest Stream</h3>
      <span class="live-badge" id="liveBadge"><span class="dot"></span> LIVE</span>
    </div>
    <div class="viewport" id="viewport">
      <video id="preview" autoplay playsinline></video>
      <div class="placeholder" id="placeholder">One click to go live.<br>Camera or screen, plus audio.</div>
    </div>
    <div class="live-status" id="liveStatus">Ready when you are.</div>
    <div class="live-actions">
      <button class="btn-live" id="goLiveBtn" type="button">Go Live</button>
      <div class="chooser" id="chooser">
        <button class="choice" id="camBtn" type="button">Camera<small>Face + mic</small></button>
        <button class="choice" id="screenBtn" type="button">Screen<small>Share + mic</small></button>
      </div>
      <div class="live-controls" id="liveControls">
        <button class="btn-ghost" id="muteBtn" type="button">Mute mic</button>
        <button class="btn-live" id="endBtn" type="button">End live</button>
      </div>
    </div>
  </aside>

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

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();

      <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

    let localStream = null;
    let audioTrack = null;
    let muted = false;
    let myUsername = '';
    let amLive = false;
    const peers = new Map();

    const preview = document.getElementById('preview');
    const viewport = document.getElementById('viewport');
    const liveStatus = document.getElementById('liveStatus');
    const goLiveBtn = document.getElementById('goLiveBtn');
    const chooser = document.getElementById('chooser');
    const liveControls = document.getElementById('liveControls');
    const liveBadge = document.getElementById('liveBadge');
    const muteBtn = document.getElementById('muteBtn');

    function setStatus(text, kind) {
      liveStatus.textContent = text;
      liveStatus.className = 'live-status' + (kind ? ' ' + kind : '');
    }

    function setLiveUI(on) {
      amLive = on;
      viewport.classList.toggle('streaming', on);
      liveBadge.classList.toggle('on', on);
      liveControls.classList.toggle('on', on);
      goLiveBtn.style.display = on ? 'none' : 'block';
      chooser.classList.remove('open');
    }

    function stopLocal() {
      if (localStream) localStream.getTracks().forEach(t => t.stop());
      localStream = null;
      audioTrack = null;
      preview.srcObject = null;
      preview.muted = false;
      muted = false;
      muteBtn.textContent = 'Mute mic';
      for (const pc of peers.values()) pc.close();
      peers.clear();
      if (amLive) socket.emit('end-live');
      setLiveUI(false);
      setStatus('Stream ended.');
    }

    async function getMicTracks() {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false
        });
        return mic.getAudioTracks();
      } catch {
        return [];
      }
    }

    async function startCamera() {
      setStatus('Asking for camera and microphone…');
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      audioTrack = localStream.getAudioTracks()[0] || null;
      attachLocal('camera', 'Camera is live.');
    }

    async function startScreen() {
      setStatus('Pick a screen or window…');
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true
      });
      const mics = await getMicTracks();
      mics.forEach(t => display.addTrack(t));
      localStream = display;
      audioTrack = localStream.getAudioTracks()[0] || null;
      display.getVideoTracks()[0].addEventListener('ended', stopLocal);
      attachLocal('screen', 'Screen is live.');
    }

    function attachLocal(kind, okText) {
      preview.srcObject = localStream;
      preview.muted = true;
      preview.play().catch(() => {});
      setLiveUI(true);
      setStatus(okText, 'ok');
      socket.emit('go-live', { kind });
    }

    function handlePermError(err) {
      const name = err && err.name;
      if (name === 'NotAllowedError') setStatus('Permission blocked. Allow camera/mic/screen, then try again.', 'err');
      else if (name === 'NotFoundError') setStatus('No camera or mic found.', 'err');
      else setStatus((err && err.message) || 'Could not start stream.', 'err');
      chooser.classList.remove('open');
    }

    goLiveBtn.addEventListener('click', () => {
      if (!window.isSecureContext) {
        setStatus('Go Live needs HTTPS.', 'err');
        return;
      }
      chooser.classList.toggle('open');
      setStatus(chooser.classList.contains('open') ? 'Camera or screen?' : 'Ready when you are.');
    });

    document.getElementById('camBtn').addEventListener('click', async () => {
      try { await startCamera(); } catch (err) { handlePermError(err); }
    });

    document.getElementById('screenBtn').addEventListener('click', async () => {
      try { await startScreen(); } catch (err) { handlePermError(err); }
    });

    muteBtn.addEventListener('click', () => {
      if (!audioTrack) { setStatus('No microphone on this stream.', 'err'); return; }
      muted = !muted;
      audioTrack.enabled = !muted;
      muteBtn.textContent = muted ? 'Unmute mic' : 'Mute mic';
      setStatus(muted ? 'Microphone muted.' : 'Microphone on.', muted ? '' : 'ok');
    });

    document.getElementById('endBtn').addEventListener('click', stopLocal);

    function ensurePeer(id, asOfferer) {
      if (peers.has(id)) return peers.get(id);
      const pc = new RTCPeerConnection(RTC_CONFIG);
      peers.set(id, pc);
      if (localStream) {
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
      }
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit('webrtc-signal', { targetId: id, type: 'ice', payload: e.candidate });
        }
      };
      pc.ontrack = (e) => {
        preview.srcObject = e.streams[0];
        preview.muted = false;
        viewport.classList.add('streaming');
        liveBadge.classList.add('on');
        setStatus('Watching live stream.', 'ok');
      };
      if (asOfferer) {
        pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => {
          socket.emit('webrtc-signal', { targetId: id, type: 'offer', payload: pc.localDescription });
        });
      }
      return pc;
    }

    socket.on('user-live', (info) => {
      setStatus(info.username + ' is live (' + info.kind + '). Connecting…');
      socket.emit('watch-live', { broadcasterId: info.socketId });
    });

    socket.on('live-state', (list) => {
      if (!list || !list.length || amLive) return;
      const info = list[0];
      setStatus(info.username + ' is already live.');
      socket.emit('watch-live', { broadcasterId: info.socketId });
    });

    socket.on('watch-request', (data) => {
      if (!amLive || !localStream) return;
      ensurePeer(data.viewerId, true);
    });

    socket.on('webrtc-signal', async (data) => {
      const pc = ensurePeer(data.fromId, false);
      if (data.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.payload));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc-signal', { targetId: data.fromId, type: 'answer', payload: pc.localDescription });
      } else if (data.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.payload));
      } else if (data.type === 'ice' && data.payload) {
        try { await pc.addIceCandidate(new RTCIceCandidate(data.payload)); } catch (e) {}
      }
    });

    socket.on('user-ended-live', () => {
      if (amLive) return;
      for (const pc of peers.values()) pc.close();
      peers.clear();
      preview.srcObject = null;
      viewport.classList.remove('streaming');
      liveBadge.classList.remove('on');
      setStatus('Live stream ended.');
    });

    function joinChat() {
      const username = document.getElementById('usernameInput').value.trim();
      const tracking = document.getElementById('trackingInput').value.trim();

      if (username.length < 2) {
        alert('Username must be at least 2 characters');
        return;
      }

      myUsername = username;
      document.getElementById('login').style.display = 'none';
      document.getElementById('chat').style.display = 'flex';
      document.body.classList.add('nest-on');
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

io.on('connection', (socket) => {
  console.log('A user connected');
  clearReg(socket);

  socket.on('join', (data) => {
    let username;
    let tracking = '';

    if (typeof data === 'string') {
      username = data;
    } else {
      username = data.username;
      tracking = (data.tracking || '').trim();
    }

    socket.username = username;

    const isFlagholder = tracking && flagholders.includes(tracking);
    socket.isFlagholder = isFlagholder;
    clearReg(socket);

    const displayName = isFlagholder ? `${username} (flagholder)` : username;

    socket.broadcast.emit('system', `${displayName} joined the chat`);
    socket.emit('system', `Welcome to Eagles Nest, ${displayName}! Type /help for commands.`);
    socket.emit('usage', usagePayload());
    const currentLive = [];
    for (const [id, info] of liveBroadcasters) {
      currentLive.push({ socketId: id, username: info.username, kind: info.kind });
    }
    if (currentLive.length) socket.emit('live-state', currentLive);
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

const PORT = 3000;
server.listen(PORT, () => {
  console.log('Eagles Nest chat running on port ' + PORT);
});
