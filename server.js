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
const { createLast5 } = require('./lib/last5');
const memberToken = require('./lib/memberToken');
const usernameRule = require('./lib/username'); // CHG-051
const states = require('./lib/states'); // CHG-055
const { createRepThrottle } = require('./lib/repThrottle'); // CHG-055
const xhandle = require('./lib/xhandle'); // CHG-140
const editMode = require('./lib/editMode'); // CHG-058
const { createServerStats, createRateLimiter, serverStatsRoute } = require('./lib/serverStats'); // CHG-081
const { safeLinkRoute } = require('./lib/safeLink'); // CHG-106
const { profileRoute } = require('./lib/profile'); // CHG-115
const support = require('./lib/support'); // CHG-128
const { memberCountRoute } = require('./lib/memberCount'); // CHG-132
const tailgate = require('./lib/tailgate'); // CHG-133
const clips = require('./lib/clips'); // CHG-134
const accountDelete = require('./lib/accountDelete'); // CHG-138
const { rateKey } = require('./lib/safeLink');

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

const XAI_API_KEY = process.env.XAI_API_KEY;

// CHG-049 — read-only member role for the homepage. Registered BEFORE the global cors() below:
// that one reflects its own origin list without credentials (and answers every OPTIONS itself),
// which would break a credentialed fetch. This route sets its own CORS headers (memberMe).
app.options('/api/member/me', memberMe);
app.get('/api/member/me', memberMe);

// CHG-081: GET /api/server-stats, read-only CPU / memory / uptime numbers for the homepage Live-state panel.
// Also registered BEFORE the global cors(): it allows only the two homepage origins (no localhost, no
// credentials) and answers its own OPTIONS. Sampled every 2 s in the background (lib/serverStats.js).
const serverStats = createServerStats();
serverStats.start();
app.all('/api/server-stats', serverStatsRoute(serverStats, createRateLimiter()));

// CHG-106: POST /api/safe-link {url} -> {verdict, reasons, host, finalUrl?} for the Shop's third-window search box.
// Same pattern as server-stats: BEFORE the global cors()/express.json(), only the two homepage origins, own OPTIONS,
// own 2 KB JSON parser, 10/min per client. Key: GOOGLE_SAFE_BROWSING_KEY in .env. URLs are never logged or stored.
// TRUST_PROXY=1 (only when nginx sends X-Forwarded-For): rate-limit by the forwarded client address.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 'loopback');
app.all('/api/safe-link', safeLinkRoute());

// CHG-132: GET /api/member-count -> {"members": N} (count of users.json records only, 60 s cache, 30/min per client).
// Same pattern as server-stats: BEFORE the global cors(), only the two homepage origins, own OPTIONS, no credentials.
const memberCount = memberCountRoute(path.join(__dirname, 'users.json'));
app.all('/api/member-count', memberCount.handler);

// CHG-133: Tailgate Party mode. GET /api/tailgate (public state), POST /api/tailgate (Bearer TAILGATE_TOKEN; off if unset).
// Override persisted in tailgate.json (gitignored). Auto mode polls Rumble every 2 min only inside TAILGATE_WINDOW (default Mon-Fri 21:00-22:00 America/New_York) plus live carryover (TAILGATE_POLL=0 disables polling).
const tailgateState = tailgate.createTailgateState({ file: path.join(__dirname, 'tailgate.json') });
app.all('/api/tailgate', tailgate.tailgateRoute(tailgateState));
tailgateState.onChange((st) => io.emit('tailgate:state', st));
if (process.env.TAILGATE_POLL !== '0') tailgate.startPolling(tailgateState, tailgate.rumbleDetector());

// CHG-134: Clips. Anyone in Milliway (guests + members; CLIPS_MEMBERS_ONLY=1 = members only) can clip the last 30 s of chat.
// The browser gets a per-connection clip session on 'clips:session' and sends it as X-Clip-Session; the server copies
// lines from its own buffer. clips.json + clips-img/ are gitignored. Admin: Bearer CLIPS_ADMIN_TOKEN (or TAILGATE_TOKEN).
const clipBuffer = clips.createRecentBuffer();
const clipStore = clips.createClipStore({ file: path.join(__dirname, 'clips.json') });
const clipSessions = new Map(); // token -> socket
let tgStartedAt = 0; let tgLastEmbed = null;
function trackTailgateStart(st) {
  const id = st && st.mode === 'tailgate' ? st.embedId : null;
  if (id !== tgLastEmbed) { tgLastEmbed = id; tgStartedAt = id ? Date.now() : 0; }
}
trackTailgateStart(tailgateState.get());
function clipContext() {
  const st = tailgateState.get(); trackTailgateStart(st);
  const list = [];
  for (const [, info] of liveBroadcasters) list.push({ username: info.username, allowClips: !!info.allowClips });
  return clips.computeContext({ broadcasters: list, tailgate: st, tgStartedAt });
}
function emitClipContext() { io.emit('clips:context', clipContext()); }
tailgateState.onChange(() => emitClipContext());
app.use(clips.clipsRouter({
  store: clipStore,
  buffer: clipBuffer,
  getContext: clipContext,
  imgDir: path.join(__dirname, 'clips-img'),
  originOk: (o) => memberOriginOk(o),
  whoami(req) {
    const t = req.get('x-clip-session');
    const sock = typeof t === 'string' && t.length === 43 ? clipSessions.get(t) : null;
    if (!sock || !sock.connected || !sock.username) return null;
    const member = isRegisteredAuthed(sock);
    return { name: shownName(sock), member, key: member ? 'm:' + String(sock.username).toLowerCase() : 'g:' + crypto.createHash('sha256').update(t).digest('hex').slice(0, 24) };
  },
  onSaved(c) {
    io.emit('clip:new', { id: c.id, clipper: c.clipper, caption: c.caption, votes: 0, url: '/c/' + c.id });
    console.log('[clips] saved', c.id, c.clipper);
  },
  onVote(id, votes) { io.emit('clip:votes', { id, votes }); },
  onRemoved(id) { io.emit('clip:removed', { id }); },
}));

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

// CHG-044 — /last5.txt: world-readable tail (last 5 lines) of the public Milliway room.
// Stored outside public/ (default data/last5.txt, gitignored) so deploys stay clean.
const last5 = createLast5(process.env.LAST5_PATH || path.join(__dirname, 'data', 'last5.txt'));
last5.init();
app.get('/last5.txt', last5.handler);

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
  profile.invalidate(); // CHG-115
  memberCount.invalidate(); // CHG-132
}

let registeredUsers = loadUsers();
console.log(`Loaded ${registeredUsers.length} registered users`);

// CHG-138: names freed by /delete stay held for 90 days (tombstones.json, gitignored, no email), and every NEW record
// starts at a random tokenVersion, so an old nest_member cookie can never sign in as a later owner of the same name.
const TOMBSTONES_PATH = path.join(__dirname, 'tombstones.json');
const tombstones = accountDelete.createTombstones({ file: TOMBSTONES_PATH });
function newTokenVersion() { return crypto.randomInt(1, 2147483647); }

// CHG-115: read-only public profiles. GET /api/profile/:username -> {username, tier, joined?} or a plain 404
// (lib/profile.js: CHG-051 fold() lookup, safe fields only, 30/min per visitor, 60 s cache).
// GET /u/:username serves public/profile.html (+ profile.js/.css) with a strict CSP. Same-origin, no cookies read.
const profile = profileRoute(() => registeredUsers);
app.get('/api/profile/:username', profile.handler);
const PROFILE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
app.get('/u/:username', (req, res) => {
  res.set({ 'Content-Security-Policy': PROFILE_CSP, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// CHG-047 — remember signed-in members for 30 days (HttpOnly cookie holding a signed token).
// Off unless MEMBER_TOKEN_SECRET is 32+ chars; when off, everything behaves as before.
const MEMBER_COOKIE = 'nest_member';
const MEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MEMBER_SECRET = String(process.env.MEMBER_TOKEN_SECRET || '');
const memberOn = MEMBER_SECRET.length >= 32;
if (!memberOn) console.warn('[member] MEMBER_TOKEN_SECRET missing or under 32 chars; remember-me is off');
const MEMBER_ORIGINS = new Set(['https://chat.afirstflag.com', 'http://localhost:3000', 'http://127.0.0.1:3000']);
const MEMBER_ME_ORIGINS = new Set(['https://afirstflag.com', 'https://www.afirstflag.com']); // CHG-049 homepage
/** @type {Map<string, { username: string, exp: number }>} one-time claim -> member (60 s) */
const memberClaims = new Map();
const AUTH_CODE_LOG = process.env.AUTH_CODE_LOG === '1';
const AUTH_MAX_TRIES = 5;

// Browsers always send Origin cross-origin; same-origin polling GETs may omit it.
function memberOriginOk(origin) {
  return !origin || MEMBER_ORIGINS.has(origin);
}

// -> { user } for a valid, current cookie; { stale: true } for one to clear; {} for none.
function readMember(cookieHeader) {
  const raw = memberToken.parseCookie(cookieHeader, MEMBER_COOKIE);
  if (!raw || !memberOn) return {};
  const claims = memberToken.verify(MEMBER_SECRET, raw);
  const user = claims && findUserByName(claims.u);
  if (!user || (user.tokenVersion || 0) !== claims.tv) return { stale: true };
  return { user };
}

// Secure always: prod is HTTPS-only, and browsers accept Secure cookies on http://localhost.
function memberCookieOpts(maxAge) {
  const opts = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };
  if (maxAge) opts.maxAge = maxAge;
  return opts;
}

function purgeMemberClaims() {
  const now = Date.now();
  for (const [claim, info] of memberClaims) {
    if (info.exp <= now) memberClaims.delete(claim);
  }
}

function logAuthCode(kind, email, username, code) {
  console.log('[auth code]', kind, maskEmail(email), username, AUTH_CODE_LOG ? code : '(hidden)');
}

function findUserByName(username) {
  const key = String(username || '').toLowerCase();
  return registeredUsers.find(u => String(u.username).toLowerCase() === key);
}

// CHG-055 /rep: a member's state is its own field on the users.json record (user.rep, e.g. 'WV').
// The stored username never changes; the room shows '<STATE> <name>' (e.g. 'WV Andy'). Guests never have one.
function repOf(user) {
  return user ? states.normalize(user.rep) : null;
}

function withRep(user, name) {
  const code = repOf(user);
  return code ? code + ' ' + name : name;
}

// Name the room sees for a socket, without the flagholder tag (presence, joined/left lines).
function roomName(socket) {
  const name = String(socket.username || '');
  return isRegisteredAuthed(socket) ? withRep(findUserByName(name), name) : name;
}

// Name the room sees for a socket, with the flagholder tag (chat lines, /me, /who, welcome).
function shownName(socket) {
  const name = roomName(socket) || 'Anonymous';
  return socket.isFlagholder ? `${name} (flagholder)` : name;
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

  const displayName = shownName(socket); // CHG-055: state prefix for members with /rep

  if (command === '/help' || command === '/?') {
    const helpText = [
      'Available commands:',
      '/help or /?          - Show this help',
      '/me <action>         - Perform an action (e.g. /me waves)',
      '/who                 - Show who is online',
      '/login               - Sign in with email',
      '/register            - Create a username and email',
      '/whoami              - Your account status',
      '/logout              - Sign out on every device',
      '/mute <username>     - Mute a user (temporary)',
      '/nest                - Mint a Nest World pass (registered members)',
      '/rep <STATE>         - Show your US state before your name, e.g. /rep WV (members)',
      '/x @handle           - Show a claimed X handle on your profile, e.g. /x @handle; /x clear removes it (members)',
      '/delete              - Delete your account: emails you a code, then /auth <code> (members)'
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
        users.push(shownName(s)); // CHG-055
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
    purgeExpiredNestMints();

    if (nestCount >= NEST_CAP) {
      socket.emit('system', 'The Nest World is full right now (32). Try again later.');
      return true;
    }

    if (!isRegisteredAuthed(socket)) {
      socket.emit('system', 'Only registered members can enter Nest World. Type /register or /login first.');
      return true;
    }

    const handle = String(socket.username || '').trim();
    if (!handle) {
      socket.emit('system', 'Only registered members can enter Nest World. Type /register or /login first.');
      return true;
    }

    const existing = nestMints.get(handle.toLowerCase());
    if (existing && existing.exp > Date.now()) {
      socket.emit('system', 'You already have an active Nest World pass. Open that link or wait for it to expire (~2 min).');
      return true;
    }

    const secret = process.env.WORLD_TOKEN_SECRET;
    if (!secret) {
      console.error('[nest] WORLD_TOKEN_SECRET is not set');
      socket.emit('system', 'Nest World is not configured yet. Try again later.');
      return true;
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

    // Track active mint — do NOT increment nestCount in Slice 1
    nestMints.set(handle.toLowerCase(), {
      exp: Date.now() + 120000,
      jti
    });

    const url = 'https://chat.afirstflag.com/world?token=' + encodeURIComponent(token);
    socket.emit('system', 'Nest World pass minted (single-use, expires in ~2 minutes). Enter: ' + url);
    return true;
  }

  if (command === '/rep') { // CHG-055
    handleRep(socket, args);
    return true;
  }

  if (command === '/x') { // CHG-140
    handleX(socket, args);
    return true;
  }

  if (command === '/delete') { // CHG-138
    handleDelete(socket).catch((err) => console.error('[account] delete request failed', err && (err.code || err.message)));
    return true;
  }

  socket.emit('system', `Unknown command: ${command}. Type /help for a list.`);
  return true;
}

// CHG-055 /rep <STATE>: signed-in members only. Every reply goes to the sender only, except the
// success line, which goes to the whole room as a system line (same style as "X joined the chat").
// Anyone may claim any state; a new /rep switches it; there is no way to clear it.
// Throttle per account (all tabs together): 10 free switches per rolling 1 minute, then one per 60 s (lib/repThrottle.js).
const repThrottle = createRepThrottle();

function handleRep(socket, args) {
  const user = isRegisteredAuthed(socket) ? findUserByName(socket.username) : null;
  if (!user) {
    socket.emit('system', 'Only signed-in members can use /rep. Type /login to sign in first.');
    return;
  }
  const current = repOf(user);
  if (args.length !== 1) {
    socket.emit('system', 'Usage: /rep <STATE> with a 2-letter US state, e.g. /rep WV. You can switch states but not clear one.' +
      (current ? ' You are shown as ' + withRep(user, user.username) + '.' : ''));
    return;
  }
  const code = states.normalize(args[0]);
  if (!code) {
    socket.emit('system', 'Unknown state. Use one of the 50 US state abbreviations, e.g. /rep WV.');
    return;
  }
  if (code === current) {
    socket.emit('system', 'You already represent ' + states.nameOf(code) + '.');
    return;
  }
  const key = String(user.username).toLowerCase();
  if (repThrottle.waitSeconds(key) > 0) {
    socket.emit('system', 'A double-minded man is unstable in his ways'); // Andy's exact wording, no countdown
    return;
  }
  repThrottle.record(key);
  user.rep = code;
  saveUsers(registeredUsers);
  console.log('[rep]', user.username, code);
  io.emit('system', `Republican Chapster from ${states.nameOf(code)} will now be recognized ${user.username}`);
  // presence: every Milliway tab of this member now shows the prefix
  for (const [, s] of io.of('/').sockets) {
    if (milliwayPresence.has(s.id) && isRegisteredAuthed(s) && String(s.username || '').toLowerCase() === key) {
      const pUser = presenceUser(s);
      milliwayPresence.set(s.id, pUser);
      io.emit('presence:update', { user: pUser });
    }
  }
  editModeRefresh(); // CHG-058: the EDIT MODE tooltip lists shown names
}

// CHG-140 /x: a signed-in member sets, shows or clears a CLAIMED X handle (users.json field xHandle, members only).
// Never verified and never checked with X (no network call). Every reply goes to the sender only. Strict validation in
// lib/xhandle.js. Changes (set or clear) are limited to 5 per member per hour, in memory (it resets on restart).
const xChangeLim = createRateLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });
const X_USAGE = 'Usage: /x @handle to show your X handle on your profile (claimed, not verified), or /x clear to remove it.';

function handleX(socket, args) {
  const user = isRegisteredAuthed(socket) ? findUserByName(socket.username) : null;
  if (!user) {
    socket.emit('system', 'Only signed-in members can use /x. Type /login to sign in first.'); // guests: no write, nothing leaked
    return;
  }
  const current = xhandle.publicHandle(user.xHandle);
  if (args.length === 0) {
    socket.emit('system', current
      ? 'Your claimed X handle is @' + current + ' (not verified). /x @handle changes it, /x clear removes it.'
      : X_USAGE + ' You have not set one.');
    return;
  }
  if (args.length > 1) {
    socket.emit('system', X_USAGE);
    return;
  }
  const key = String(user.username).toLowerCase();
  if (args[0].toLowerCase() === 'clear') { // a bare word 'clear' is the command; /x @clear claims a handle named clear
    if (!current && !('xHandle' in user)) {
      socket.emit('system', 'You have no X handle set.');
      return;
    }
    if (!xChangeLim.hit(key).ok) {
      socket.emit('system', 'You have changed your X handle too many times. Try again in an hour.');
      return;
    }
    delete user.xHandle;
    saveUsers(registeredUsers); // also clears the profile cache
    console.log('[x] cleared', user.username);
    socket.emit('system', 'Your X handle has been removed from your profile.');
    return;
  }
  const r = xhandle.normalize(args[0]);
  if (!r.ok) {
    socket.emit('system', 'That is not a valid X handle. Use 1-15 letters, numbers or underscores, e.g. /x @handle.');
    return;
  }
  if (r.handle === current) {
    socket.emit('system', 'Your X handle is already @' + current + '.');
    return;
  }
  if (!xChangeLim.hit(key).ok) {
    socket.emit('system', 'You have changed your X handle too many times. Try again in an hour.');
    return;
  }
  user.xHandle = r.handle;
  saveUsers(registeredUsers); // also clears the profile cache
  console.log('[x] set', user.username);
  socket.emit('system', 'Your X handle is now @' + r.handle + ' (claimed, not verified). It shows on your profile page.');
}

// CHG-138 /delete: a signed-in member types /delete, gets a fresh emailed code and the system line
// 'auth code sent. /auth code to delete account', then types /auth <code> as a normal chat line (the existing
// client mechanism) to delete the account for good. Codes are purpose-tagged and kept apart from login codes
// (lib/accountDelete.js): 10 minutes, 5 tries (AUTH_MAX_TRIES), single use. Guests get no code. The owner account is
// refused here (admin route instead). Requests are rate limited per account and per network address (hashed, memory only).
const deleteCodes = accountDelete.createDeleteCodes({ makeCode: makeAuthCode, maxTries: AUTH_MAX_TRIES });
const deleteReqUserLim = createRateLimiter({ limit: 3, windowMs: 10 * 60 * 1000 });
const deleteReqIpLim = createRateLimiter({ limit: 10, windowMs: 10 * 60 * 1000 });
const DELETE_USAGE = '/auth code to delete account';

function memberSockets(lowerName) {
  const out = [];
  for (const [, s] of io.of('/').sockets) {
    if (isRegisteredAuthed(s) && String(s.username || '').toLowerCase() === lowerName) out.push(s);
  }
  return out;
}

async function handleDelete(socket) {
  const user = isRegisteredAuthed(socket) ? findUserByName(socket.username) : null;
  if (!user) {
    socket.emit('system', 'Only signed-in members can use /delete. Type /login to sign in first.'); // no code, nothing leaked
    return;
  }
  if (usernameRule.isOwnerAccountEmail(user.email)) {
    socket.emit('system', 'This account cannot be deleted from chat.'); // generic; the owner uses the admin route
    return;
  }
  const key = String(user.username).toLowerCase();
  const ipKey = 'ip:' + crypto.createHash('sha256').update(rateKey(socket.request, process.env.TRUST_PROXY === '1')).digest('hex').slice(0, 32);
  if (!deleteReqUserLim.hit(key).ok || !deleteReqIpLim.hit(ipKey).ok) {
    socket.emit('system', 'Too many requests. Try again later.');
    return;
  }
  const code = deleteCodes.issue(key);
  logAuthCode('delete', user.email, user.username, code);
  try {
    await sendAuthEmail(user.email, code, 'delete');
  } catch (err) {
    console.error('[mail fail]', err.code || err.message); // SMTP messages can echo the address
    deleteCodes.clear(key); // no email went out: do not leave a live code behind
    socket.emit('system', 'Could not send the code. Try again later.');
    return;
  }
  socket.emit('system', accountDelete.CONFIRM_TEXT);
}

// -> true when a member's whole footprint was removed
function handleDeleteCode(socket, code) {
  const user = findUserByName(socket.username);
  const key = String(socket.username).toLowerCase();
  if (!user || usernameRule.isOwnerAccountEmail(user.email)) { deleteCodes.clear(key); return; }
  const r = deleteCodes.check(key, code);
  if (r === 'wrong') { socket.emit('system', 'Wrong code. ' + DELETE_USAGE); return; }
  if (r === 'locked') { console.log('[account] too many wrong delete codes', socket.username); socket.emit('system', 'Too many wrong codes. Type /delete to get a new code.'); return; }
  if (r === 'expired') { socket.emit('system', 'That code expired. Type /delete to get a new code.'); return; }
  if (r !== 'ok') { socket.emit('system', 'Unknown command: /auth. Type /help for a list.'); return; }
  try {
    deleteMember(user);
  } catch (err) {
    console.error('[account] delete failed', user.username, err && (err.code || err.message));
    socket.emit('system', 'Could not delete the account right now. Nothing was changed. Try again later.');
  }
}

// Order matters: back up users.json, hold the name, remove the record (any failure here aborts and nothing is lost),
// then clean up around it. All synchronous, so no other save can interleave.
function deleteMember(user) {
  const name = user.username;
  const lc = String(name).toLowerCase();
  const idx = registeredUsers.indexOf(user);
  if (idx < 0) return;
  accountDelete.backupFileAtomic(USERS_PATH, USERS_PATH + '.bak-delete'); // one rolling copy, replaced by the next deletion
  tombstones.add(name); // throws if it cannot persist: abort before anything is removed
  registeredUsers.splice(idx, 1);
  try {
    saveUsers(registeredUsers);
  } catch (err) {
    registeredUsers.splice(idx, 0, user); // put it back; the tombstone only holds the name of an account that still exists
    throw err;
  }

  // clips, votes, quoted names, cached cards
  const matchUser = accountDelete.nameMatcher(name);
  const res = clipStore.purgeMember({ key: 'm:' + lc, broadcaster: name, matchUser, former: accountDelete.FORMER });
  const png = clips.createPngCache(path.join(__dirname, 'clips-img'));
  for (const id of new Set([...res.removed, ...res.anonymized, ...res.stripped])) png.drop(id);
  for (const id of res.removed) io.emit('clip:removed', { id });
  for (const id of res.voted) { const c = clipStore.get(id); if (c) io.emit('clip:votes', { id, votes: (c.voters || []).length }); }
  clipBuffer.redact(matchUser, accountDelete.FORMER);
  last5.redact(matchUser, accountDelete.FORMER);

  // pending one-time claims and /nest passes
  for (const [claim, info] of memberClaims) if (String(info.username).toLowerCase() === lc) memberClaims.delete(claim);
  nestMints.delete(lc);
  const nestSock = nestByHandle.get(lc);
  if (nestSock) nestSock.disconnect(true);

  // sockets: every signed-in tab of this member ends (the disconnect handler clears live state and edit mode);
  // presence is cleared right here too. Guest tabs that were mid-login for this account just lose the pending state.
  for (const [, s] of io.of('/').sockets) {
    if (String(s.pendingUsername || '').toLowerCase() === lc && !isRegisteredAuthed(s)) {
      s.authState = null; s.pendingEmail = null; s.pendingUsername = null;
    }
  }
  for (const s of memberSockets(lc)) {
    if (milliwayPresence.delete(s.id)) io.emit('presence:leave', { id: s.id });
    s.emit('system', 'Your account has been deleted.');
    s.emit('account:deleted'); // the page clears the cookie and reloads as a guest
    s.disconnect(true);
  }
  editModeRefresh();
  console.log('[account] deleted', name, 'clips=' + res.removed.length, 'votes=' + res.voted.length, 'anonymized=' + res.anonymized.length);
}

// CHG-058 "Neagle go into edit mode": a scripted flow run by the server. Neagle's AI is never called for it and
// the token counter does not move. Per socket: socket.edit = { step: 'confirm' | 'code', at } while a reply is
// pending, socket.editWrong (wrong codes), socket.editMode (true once the code was accepted, until disconnect).
// Room sees: the trigger and the confirm reply as normal lines, the ALERT system line, Neagle's scripted lines.
// The code attempt goes back to the sender only (never broadcast, never in last5.txt, never logged).
const editCodeOk = editMode.createCodeCheck(editMode.resolveCodeHash(process.env.EDIT_MODE_CODE_SHA256, console.warn));

// CHG-134: every public room line gets a server id + time and goes into the clip buffer.
function roomLine(username, message) {
  const l = clipBuffer.add(username, message);
  return { username, message, id: l.id, t: l.t };
}

function neagleSay(text) {
  io.emit('chat message', roomLine('Neagle', text));
  last5.record('Neagle', text); // same as a normal Neagle line
}

// A normal public human line (room + last5.txt).
function postHumanLine(socket, msg) {
  const displayName = shownName(socket); // CHG-055: 'WV Andy' for a member with a state
  io.emit('chat message', roomLine(displayName, msg));
  last5.record(displayName, msg); // CHG-044: public human line
}

// -> true when the message was handled here (the caller must not broadcast it or ask Neagle).
function handleEditFlow(socket, text, msg) {
  if (socket.edit && Date.now() - socket.edit.at > editMode.PENDING_MS) socket.edit = null; // silent reset
  const step = socket.edit ? socket.edit.step : '';
  const name = roomName(socket) || 'Anonymous';

  if (step === 'confirm') { // whatever the reply says, it is shown normally
    postHumanLine(socket, msg);
    io.emit('system', 'ALERT ' + name.toUpperCase() + ' HAS TRIGGERED THE EDIT MODE');
    neagleSay("What's the code?");
    socket.edit = { step: 'code', at: Date.now() };
    return true;
  }

  if (step === 'code') {
    socket.edit = null;
    socket.emit('chat message', { username: shownName(socket), message: msg }); // sender only
    if (editCodeOk(text)) {
      socket.editMode = true;
      console.log('[editmode] on', socket.username);
      neagleSay('code accepted');
      editModeRefresh();
    } else {
      socket.editWrong = (socket.editWrong || 0) + 1;
      console.log('[editmode] wrong code', socket.username, socket.editWrong + '/' + editMode.MAX_WRONG);
      neagleSay('code rejected');
    }
    return true;
  }

  if (!editMode.isTrigger(text)) return false;
  postHumanLine(socket, msg); // the trigger itself is a normal line
  if (socket.editMode) {
    socket.emit('system', 'You are already in edit mode.');
    return true;
  }
  if ((socket.editWrong || 0) >= editMode.MAX_WRONG) {
    socket.emit('system', 'Edit mode locked.');
    return true;
  }
  socket.edit = { step: 'confirm', at: Date.now() };
  neagleSay('Are you sure ' + name + '?');
  return true;
}

// -> { on, names }: on while at least one connected Milliway socket is in edit mode; names = shown names (unique).
function editModeState() {
  const names = new Set();
  for (const [, s] of io.of('/').sockets) {
    if (s.editMode && s.connected) names.add(roomName(s) || 'Anonymous');
  }
  return { on: names.size > 0, names: Array.from(names) };
}

let editModeWasOn = false;
// Push the state to the whole room when edit mode is on, or when it just went off.
function editModeRefresh() {
  const state = editModeState();
  if (state.on || editModeWasOn) io.emit('editmode:state', state);
  editModeWasOn = state.on;
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
      const nameCheck = usernameRule.check(username); // CHG-051
      if (!nameCheck.ok) {
        clearReg(socket);
        socket.emit('system', nameCheck.reason);
        return true;
      }
      if (findUserByEmail(socket.reg.email) || findUserByName(username) || tombstones.has(username)) {
        clearReg(socket);
        socket.emit('system', 'That account already exists.');
        return true;
      }
      registeredUsers.push({
        username,
        email: socket.reg.email,
        createdAt: new Date().toISOString(),
        flagholder: !!socket.isFlagholder,
        tokenVersion: newTokenVersion() // CHG-138
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

// CHG-047 — swap the one-time claim (sent on the socket after /auth) for the member cookie.
app.post('/api/member/session', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const claim = req.body && typeof req.body.claim === 'string' ? req.body.claim : '';
  const info = claim ? memberClaims.get(claim) : null;
  if (info) memberClaims.delete(claim);
  purgeMemberClaims();
  const user = info && info.exp > Date.now() ? findUserByName(info.username) : null;
  if (!memberOn || !user || !memberOriginOk(req.get('origin'))) {
    return res.json({ ok: false });
  }
  const token = memberToken.sign(MEMBER_SECRET, { u: user.username, tv: user.tokenVersion || 0 }, MEMBER_TTL_MS);
  res.cookie(MEMBER_COOKIE, token, memberCookieOpts(MEMBER_TTL_MS));
  res.json({ ok: true });
});

// CHG-047 — /logout (every device: bump tokenVersion) and quiet cleanup of a rejected cookie.
app.post('/api/member/logout', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!memberOriginOk(req.get('origin'))) {
    return res.json({ ok: false });
  }
  const { user } = readMember(req.get('cookie'));
  if (user) {
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    saveUsers(registeredUsers);
    console.log('[member] logout', user.username);
  }
  res.clearCookie(MEMBER_COOKIE, memberCookieOpts());
  res.json({ ok: true });
});

// CHG-049 — GET/OPTIONS /api/member/me: {member:true,name} or {member:false}. Pure read: no writes,
// no Set-Cookie (a stale cookie is just "not a member"), no logging. CORS headers only for the
// exact homepage origins; other foreign origins get {member:false} without the cookie being read.
// CHG-055: members also get rep ('WV' or null) and display ('WV Andy', or just the name with no state).
function memberMe(req, res) {
  const origin = req.get('origin');
  const home = !!origin && MEMBER_ME_ORIGINS.has(origin);
  res.set({ 'Cache-Control': 'no-store', Vary: 'Origin' });
  if (home) {
    res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' });
  }
  if (req.method === 'OPTIONS') {
    if (home) res.set({ 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600' });
    return res.status(204).end();
  }
  const { user } = (home || memberOriginOk(origin)) ? readMember(req.get('cookie')) : {};
  res.json(user ? { member: true, name: user.username, rep: repOf(user), display: withRep(user, user.username) } : { member: false });
}


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


const NEAGLE_SYSTEM_PROMPT = `You are Neagle, house presence in Milliway, a small public chat attached to America First Flags.

Voice: dry, brief, a little tired, not theatrical. Two or three short sentences unless they asked for more. No stage directions, no *static crackles*, no cosmic haze.

You know this room. You do not explain the name, the décor, or any larger setting. Do not call this the last chatroom, the edge of everything, the end of the universe, or a final terminal. Do not welcome people as if they have arrived at the end of time.

If someone fishes for the Hitchhiker / Milliway joke, one dry nod is enough, then drop it. If they do not, never bring it up.

Help with the room when asked: /help, /register, /login, /who, /nest (registered members), flags, tracking numbers. You are not support docs. If you do not know, say so.

Address them by the name you are given. Do not invent lore.`;

async function askNeagle(userMessage, username, supportSession = false, history = null) {
  if (!XAI_API_KEY) {
    if (supportSession) return support.FALLBACK_REPLY; // CHG-128: no sarcasm in a support session
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
        // CHG-129: support sessions also send their short-term history; normal chat sends no history
        messages: support.buildMessages(support.systemPromptFor(NEAGLE_SYSTEM_PROMPT, supportSession), // CHG-128
          supportSession && Array.isArray(history) ? history : [], `${username} said: ${userMessage}`),
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
    return data.choices?.[0]?.message?.content?.trim() || (supportSession ? support.FALLBACK_REPLY : 'I have nothing to say right now.');
  } catch (err) {
    console.error('Neagle API error:', err);
    if (supportSession) return support.FALLBACK_REPLY; // CHG-128
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

// CHG-128 — support-flag sessions (memory only, hashed rate key; see lib/support.js)
const supportMemory = support.createSupportMemory(); // CHG-129: per-socket, memory only, 30 min TTL
const supportSessions = support.createSupport({ say: (text) => neagleSay(text), memory: supportMemory });

async function sendAuthEmail(to, code, purpose) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('SMTP env missing');
  }
  const del = purpose === 'delete'; // CHG-138: same mailer and path, different words
  await mailer.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject: del ? 'Milliway account deletion code' : 'Milliway sign-in code',
    text: del
      ? 'Your code to delete your Milliway account is ' + code + '. It expires in 10 minutes. In chat type /auth ' + code + '. If you did not ask for this, ignore this email and nothing happens.'
      : 'Your code is ' + code + '. It expires in 10 minutes. In chat type /auth ' + code
  });
}

function makeAuthCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function codeMatches(expected, given) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(given || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isGuestName(name) {
  return /^guest-user \d+$/i.test(String(name || ''));
}

// CHG-036 — Milliway presence roster (default namespace only; one entry per joined socket)
/** @type {Map<string, { id: string, name: string, guest: boolean }>} socket.id -> presence user */
const milliwayPresence = new Map();

function presenceUser(socket) {
  return { id: socket.id, name: roomName(socket), guest: !!socket.isGuest }; // CHG-055: 'WV Andy' for a member with a state
}

function presenceSync(socket) {
  const users = [];
  for (const u of milliwayPresence.values()) {
    users.push(Object.assign({}, u, { you: u.id === socket.id }));
  }
  socket.emit('presence:sync', { users, ts: Date.now() });
}

// CHG-047 — remembered member: check the cookie on the handshake (default namespace only,
// /nest untouched). Never rejects: no/bad cookie means the socket joins as a guest.
io.use((socket, next) => {
  try {
    const headers = socket.handshake.headers || {};
    if (memberOn && memberOriginOk(headers.origin)) {
      const found = readMember(headers.cookie);
      if (found.user) socket.data.memberName = found.user.username;
      else if (found.stale) socket.data.memberStale = true;
    }
  } catch (err) {
    socket.data.memberName = null;
  }
  next();
});

io.on('connection', (socket) => {
  socket.emit('tailgate:state', tailgateState.get()); // CHG-133
  // CHG-134: clip session for this connection (dropped on disconnect)
  socket.clipToken = crypto.randomBytes(32).toString('base64url');
  clipSessions.set(socket.clipToken, socket);
  socket.emit('clips:session', { token: socket.clipToken, membersOnly: process.env.CLIPS_MEMBERS_ONLY === '1' });
  socket.emit('clips:context', clipContext());
  console.log('A user connected');
  clearReg(socket);

  socket.on('join', (data) => {
    let username = '';
    let tracking = '';

    // CHG-047 — names sent by the browser are ignored: a member comes from the verified
    // cookie (or an /auth on this socket); everyone else gets a server-assigned guest name.
    if (data && typeof data === 'object') {
      tracking = String(data.tracking || '').trim();
    }
    const member = socket.data.memberName ? findUserByName(socket.data.memberName) : null;
    if (member) {
      username = member.username;
      socket.authState = 'authed';
      console.log('[member] resume', username);
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
    socket.isGuest = !member;

    const isFlagholder = tracking && flagholders.includes(tracking);
    socket.isFlagholder = isFlagholder;
    clearReg(socket);

    const displayName = shownName(socket); // CHG-055: state prefix for members with /rep

    socket.emit('joined', { username });
    if (socket.data.memberStale) {
      socket.data.memberStale = false;
      socket.emit('member:stale');
    }
    socket.broadcast.emit('system', `${displayName} joined the chat`);
    socket.emit('system', `Welcome to Milliway, ${displayName}! Type /help for commands.`);
    socket.emit('usage', usagePayload());
    const currentLive = [];
    for (const [id, info] of liveBroadcasters) {
      currentLive.push({ socketId: id, username: info.username, kind: info.kind });
    }
    if (currentLive.length) socket.emit('live-state', currentLive);

    // CHG-036 — presence: add/update this socket, tell others, full sync to this socket
    const wasPresent = milliwayPresence.has(socket.id);
    const pUser = presenceUser(socket);
    milliwayPresence.set(socket.id, pUser);
    socket.broadcast.emit(wasPresent ? 'presence:update' : 'presence:join', { user: pUser });
    presenceSync(socket);
    socket.emit('editmode:state', editModeState()); // CHG-058: EDIT MODE header for newcomers
    supportSessions.onJoin(socket, data, () => shownName(socket)); // CHG-128: silent; Neagle greets publicly
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
        existing.pendingTries = 0;
        saveUsers(registeredUsers);
        socket.pendingEmail = existing.email;
        socket.pendingUsername = existing.username;
        socket.authState = 'pending';
        logAuthCode('login', existing.email, existing.username, code);
        try {
          await sendAuthEmail(existing.email, code);
          socket.emit('priv:result', { ok: true, text: 'Complete. Closing in 5 seconds' });
        } catch (err) {
          console.error('[mail fail]', err.code || err.message); // CHG-047: SMTP messages can echo the address
          socket.emit('priv:result', { ok: false, text: 'Fail. Closing in 5 seconds' });
        }
      } else {
        socket.emit('priv:result', { ok: false, text: 'Fail. Closing in 5 seconds' });
      }
      socket.priv = null;
      return;
    }

    if (socket.priv.kind === 'register' && socket.priv.step === 'username') {
      // CHG-051 — normalized; the reason goes to the pane. Owner-only names (andy) wait for the email step.
      const nameCheck = usernameRule.check(text);
      if (!nameCheck.ok && !nameCheck.ownerOnly) {
        socket.emit('priv:result', { ok: false, text: 'Fail. ' + nameCheck.reason + ' Closing in 5 seconds' });
        socket.priv = null;
        return;
      }
      const name = nameCheck.name;
      if (isGuestName(name) || findUserByName(name) || tombstones.has(name)) { // CHG-138: freed names are held 90 days
        socket.emit('priv:result', { ok: false, text: 'Fail. Closing in 5 seconds' });
        socket.priv = null;
        return;
      }
      socket.priv.username = name;
      socket.priv.step = 'email';
      socket.emit('priv:line', { from: 'SERVER', text: 'Enter email.' });
      return;
    }

    if (socket.priv.kind === 'register' && socket.priv.step === 'email') {
      const email = text.toLowerCase();
      const ownerCheck = usernameRule.check(socket.priv.username, { email }); // CHG-051 — owner-only names need the owner's email
      if (!ownerCheck.ok) {
        socket.emit('priv:result', { ok: false, text: 'Fail. ' + ownerCheck.reason + ' Closing in 5 seconds' });
        socket.priv = null;
        return;
      }
      if (!isValidEmail(email) || findUserByEmail(email) || findUserByName(socket.priv.username) || tombstones.has(socket.priv.username)) {
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
        tokenVersion: newTokenVersion(), // CHG-138
        pendingCode: code,
        pendingUntil: Date.now() + 10 * 60 * 1000
      });
      saveUsers(registeredUsers);
      socket.pendingEmail = email;
      socket.pendingUsername = socket.priv.username;
      socket.authState = 'pending';
      logAuthCode('register', email, socket.priv.username, code);
      try {
        await sendAuthEmail(email, code);
        socket.emit('priv:result', { ok: true, text: 'Complete. Closing in 5 seconds' });
      } catch (err) {
        console.error('[mail fail]', err.code || err.message); // CHG-047: SMTP messages can echo the address
        socket.emit('priv:result', { ok: false, text: 'Fail. Closing in 5 seconds' });
      }
      socket.priv = null;
    }
  });

  socket.on('auth:try', (data = {}) => {
    const code = String(data.code || '').trim();
    const guest = isGuestName(socket.username) && socket.authState !== 'pending';
    console.log('[auth:try]', AUTH_CODE_LOG ? code : '(hidden)', socket.authState, maskEmail(socket.pendingEmail), socket.username);

    // CHG-138: a signed-in member with a delete code outstanding: /auth <code> is checked against the DELETE code only.
    // Login codes (users.json pendingCode) are never consulted here, and the sign-in path below never sees delete codes.
    if (code && isRegisteredAuthed(socket) && deleteCodes.has(String(socket.username).toLowerCase())) {
      handleDeleteCode(socket, code);
      return;
    }

    if (guest || socket.authState !== 'pending' || !code) {
      socket.emit('system', 'Unknown command: /auth. Type /help for a list.');
      return;
    }

    const email = socket.pendingEmail;
    const user = findUserByEmail(email);
    const ok = user &&
      codeMatches(user.pendingCode, code) &&
      user.pendingUntil &&
      Date.now() < user.pendingUntil;

    if (!ok) {
      // CHG-047 — 5 wrong tries on one code: the code is void; the user must /login again.
      if (user && user.pendingCode) {
        user.pendingTries = (user.pendingTries || 0) + 1;
        if (user.pendingTries >= AUTH_MAX_TRIES) {
          user.pendingCode = null;
          user.pendingUntil = null;
          user.pendingTries = 0;
          saveUsers(registeredUsers);
          socket.authState = null;
          socket.pendingEmail = null;
          socket.pendingUsername = null;
          console.log('[auth] too many wrong codes', socket.username);
          socket.emit('system', 'Too many wrong codes. Type /login to get a new code.');
          return;
        }
        saveUsers(registeredUsers);
      }
      socket.emit('system', 'Unknown command: /auth. Type /help for a list.');
      return;
    }

    user.verified = true;
    user.pendingCode = null;
    user.pendingUntil = null;
    user.pendingTries = 0;
    saveUsers(registeredUsers);

    const oldName = socket.username;
    socket.username = user.username;
    socket.isGuest = false;
    socket.authState = 'authed';
    socket.pendingEmail = null;
    socket.pendingUsername = null;

    socket.data.memberName = user.username;

    socket.emit('joined', { username: socket.username });
    socket.emit('system', 'Complete.');
    socket.broadcast.emit('system', `${roomName(socket)} has joined the chat`); // CHG-055: state prefix
    console.log('[auth ok]', oldName, '->', socket.username);

    // CHG-047 — one-time claim (60 s); the page swaps it for the HttpOnly cookie.
    if (memberOn) {
      purgeMemberClaims();
      const claim = crypto.randomBytes(32).toString('base64url');
      memberClaims.set(claim, { username: user.username, exp: Date.now() + 60 * 1000 });
      socket.emit('member:claim', { claim });
    }

    // CHG-036 — presence: name change
    if (milliwayPresence.has(socket.id)) {
      const pUser = presenceUser(socket);
      milliwayPresence.set(socket.id, pUser);
      io.emit('presence:update', { user: pUser });
    }
    if (socket.editMode) editModeRefresh(); // CHG-058: same socket, new shown name
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

    if (handleEditFlow(socket, text, msg)) return; // CHG-058: scripted edit-mode flow, no AI call

    postHumanLine(socket, msg);

    const lowerMsg = text.toLowerCase();
    const isMentioned = lowerMsg.includes('@neagle') ||
                        lowerMsg.includes('neagle') ||
                        lowerMsg.includes('@cranky') ||
                        lowerMsg.includes('cranky eagle');

    const randomJoin = Math.random() < 0.12;
    const supportSession = supportSessions.isSupport(socket); // CHG-128

    const willReply = supportSession ? supportSessions.shouldReply(socket) : (isMentioned || randomJoin);
    const history = supportSession ? supportMemory.get(socket) : null; // CHG-129: snapshot before this line
    if (supportSession) supportMemory.add(socket, 'user', `${username} said: ${text}`);
    if (willReply) {
      let reply = await askNeagle(text, username, supportSession, history);
      if (supportSession) reply = support.withCrisisReminder(reply, text); // CHG-128: 988 / 911 in code too
      if (supportSession) supportMemory.add(socket, 'assistant', reply); // CHG-129
      setTimeout(() => {
        io.emit('chat message', roomLine('Neagle', reply)); // CHG-134: id + time for clips
        last5.record('Neagle', reply); // CHG-044 — public Neagle line
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
    liveBroadcasters.set(socket.id, { username: socket.username, kind, allowClips: data.allowClips === true }); // CHG-134: default off
    socket.broadcast.emit('user-live', {
      socketId: socket.id,
      username: socket.username,
      kind
    });
    io.emit('system', `${socket.username} went live (${kind})`);
    emitClipContext(); // CHG-134
  });

  // CHG-134: only the current broadcaster changes their own 'Allow clipping' (stream info in clips; chat clips never blocked).
  socket.on('clips:allow', (data = {}) => {
    const info = liveBroadcasters.get(socket.id);
    if (!info) { socket.emit('clips:allow', { ok: false, error: 'not_live' }); return; }
    info.allowClips = !!(data && data.on === true);
    socket.emit('clips:allow', { ok: true, on: info.allowClips });
    emitClipContext();
  });
  // CHG-134: 'Remove my clips' = strip this broadcaster's name/title from clips of their broadcasts (clips stay, slot -> Milliway).
  socket.on('clips:remove-mine', () => {
    if (!socket.username) return;
    const n = clipStore.stripBroadcaster(socket.username);
    socket.emit('clips:removed-mine', { count: n });
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
    emitClipContext(); // CHG-134
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
      emitClipContext(); // CHG-134
    }
    if (socket.clipToken) clipSessions.delete(socket.clipToken); // CHG-134
    if (socket.username) {
      socket.broadcast.emit('system', roomName(socket) + ' left the chat'); // CHG-055: state prefix
    }
    // CHG-036 — presence: remove this socket
    if (milliwayPresence.delete(socket.id)) {
      socket.broadcast.emit('presence:leave', { id: socket.id });
    }
    // CHG-058: edit mode ends with the connection
    socket.edit = null;
    supportMemory.forget(socket); // CHG-129: support history ends with the connection
    if (socket.editMode) {
      socket.editMode = false;
      console.log('[editmode] off (disconnect)', socket.username);
      editModeRefresh();
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

const PORT = Number(process.env.NEST_PORT) || 3000; // CHG-138: NEST_PORT only for local tests; production keeps 3000
server.listen(PORT, () => {
  console.log('Milliway chat running on port ' + PORT);
});