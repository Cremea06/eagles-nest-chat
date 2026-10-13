// CHG-128 — "Need to talk?" support entry from the Shop (https://chat.afirstflag.com/?support=1).
// The browser strips ?support=1 from the address bar and sends { support: true } with its first 'join'.
// Nothing is shown to the room for the flag itself; Neagle then greets that guest PUBLICLY by display name
// with Andy's scripted line (no AI call). For the rest of that socket's session, Neagle answers every line
// from that guest (with a short cooldown) using a supportive system-prompt addition, and a 988 / 911 reminder
// is appended in code whenever self-harm or suicide comes up and the AI reply did not already carry it.
// Memory only: the flag lives on the socket and dies with it. IPs are never stored raw: the CHG-106 rateKey
// is hashed with a per-process random salt before it reaches the limiter.
const crypto = require('crypto');
const { rateKey } = require('./safeLink');
const { createRateLimiter } = require('./serverStats');

const GREETING = 'Howdy partner, what seems to troubling you?'; // Andy's wording, verbatim
const PER_IP_PER_HOUR = 3;
const HOUR_MS = 60 * 60 * 1000;
const GREET_DELAY_MS = 1200;
const REPLY_COOLDOWN_MS = 4000;
// CHG-129 — short-term memory for support sessions only (server memory, per socket, never written anywhere)
const HISTORY_MAX_MESSAGES = 20;          // about the last 10 turns
const HISTORY_MAX_CHARS = 4000;           // total content characters, oldest trimmed first
const HISTORY_TTL_MS = 30 * 60 * 1000;    // wiped after 30 minutes of quiet

const CRISIS_REMINDER = 'If you are thinking about suicide or hurting yourself, you can call or text 988 any time, ' +
  'day or night, to reach the 988 Suicide & Crisis Lifeline. If you are in immediate danger, call 911.';

const FALLBACK_REPLY = "I'm here and I'm listening. Take your time and tell me what's going on.";

const SUPPORT_PROMPT_ADDITION = `
SUPPORT SESSION. This person came in through the site's "Need to talk?" button and may be struggling. For this person only, set the dry, tired voice aside:
- Be warm, calm, and plain. Listen first. Reflect back what they said, ask one gentle open question, and encourage them. Short sentences.
- You are not a counselor, therapist, or doctor, and you say so if it matters. Never give medical advice, diagnoses, or medication guidance.
- Never describe, suggest, compare, or confirm any method, means, dose, place, or plan for self-harm or suicide, even if asked directly, hypothetically, or as a joke. Gently decline and turn back to how they are feeling.
- Whenever self-harm, suicide, wanting to die, or not wanting to be here comes up, include a gentle reminder: they can call or text 988 (the 988 Suicide & Crisis Lifeline) any time, and if they are in immediate danger, call 911.
- Remind them, if it fits, that this is a public room and others can read it; they can reach 988 privately.
- No jokes about their situation, no sarcasm, no lore, no Hitchhiker references.`;

const SELF_HARM_RE = /\b(suicid\w*|kill(ing)?\s+my\s*self|end(ing)?\s+(it\s+all|my\s+life|things)|self[-\s]?harm\w*|hurt(ing)?\s+my\s*self|cut(ting)?\s+my\s*self|want(ing)?\s+to\s+die|wanna\s+die|better\s+off\s+dead|don'?t\s+want\s+to\s+(be\s+here|live|wake\s+up)|no\s+reason\s+to\s+live|overdos\w*|take\s+my\s+(own\s+)?life)\b/i;

function mentionsSelfHarm(text) { return SELF_HARM_RE.test(String(text || '')); }

function greetingFor(displayName) { return String(displayName) + ': ' + GREETING; }

function systemPromptFor(basePrompt, support) { return support ? basePrompt + '\n' + SUPPORT_PROMPT_ADDITION : basePrompt; }

// Appends the 988 / 911 reminder when the guest's line mentions self-harm and the reply lacks 988.
function withCrisisReminder(reply, userText) {
  const r = String(reply || '').trim();
  if (!mentionsSelfHarm(userText) || /\b988\b/.test(r)) return r;
  return (r ? r + ' ' : '') + CRISIS_REMINDER;
}

// CHG-129 — rolling per-connection history. Kept in a Map keyed by socket.id, so a name change keeps it,
// and two guests never share one. Wiped on disconnect (forget), after ttlMs of inactivity (lazy check on
// every access plus an unref'd sweep timer), and implicitly on restart. Never logged, never persisted.
function createSupportMemory(opts = {}) {
  const now = opts.now || Date.now;
  const ttlMs = opts.ttlMs || HISTORY_TTL_MS;
  const maxMessages = opts.maxMessages || HISTORY_MAX_MESSAGES;
  const maxChars = opts.maxChars || HISTORY_MAX_CHARS;
  const sessions = new Map(); // socket.id -> { msgs: [{role, content}], last }

  function key(socket) { return socket && socket.id != null ? String(socket.id) : null; }
  function live(k) {
    const s = sessions.get(k);
    if (!s) return null;
    if (now() - s.last >= ttlMs) { sessions.delete(k); return null; }
    return s;
  }
  function trim(msgs) {
    while (msgs.length > maxMessages) msgs.shift();
    let total = msgs.reduce((n, m) => n + m.content.length, 0);
    while (msgs.length > 1 && total > maxChars) total -= msgs.shift().content.length;
    if (msgs.length === 1 && total > maxChars) msgs[0].content = msgs[0].content.slice(-maxChars);
  }
  function add(socket, role, content) {
    const k = key(socket);
    if (k == null || (role !== 'user' && role !== 'assistant')) return;
    let s = live(k);
    if (!s) { s = { msgs: [], last: now() }; sessions.set(k, s); }
    s.msgs.push({ role, content: String(content || '') });
    s.last = now();
    trim(s.msgs);
  }
  // Copy of the history in order (oldest first), or [] if none / expired.
  function get(socket) {
    const k = key(socket); const s = k == null ? null : live(k);
    return s ? s.msgs.map((m) => ({ role: m.role, content: m.content })) : [];
  }
  function forget(socket) { const k = key(socket); if (k != null) sessions.delete(k); }
  function sweep() { for (const k of [...sessions.keys()]) live(k); }
  function size() { sweep(); return sessions.size; }
  let timer = null;
  if (opts.sweepMs !== 0) {
    timer = setInterval(sweep, opts.sweepMs || 60 * 1000);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { add, get, forget, sweep, size, stop };
}

// CHG-129 — messages for the model: system, then history (user/assistant), then the newest line last.
function buildMessages(systemPrompt, history, latestUserContent) {
  return [{ role: 'system', content: systemPrompt }, ...(history || []), { role: 'user', content: latestUserContent }];
}

function createSupport(opts = {}) {
  const now = opts.now || Date.now;
  const trustProxy = opts.trustProxy != null ? !!opts.trustProxy : process.env.TRUST_PROXY === '1';
  const limiter = opts.limiter || createRateLimiter({ limit: opts.perIpPerHour || PER_IP_PER_HOUR, windowMs: HOUR_MS, now });
  const salt = opts.salt || crypto.randomBytes(16).toString('hex'); // per process, never written anywhere
  const say = opts.say;                       // (text) -> public Neagle line (io.emit + last5)
  const schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
  const log = opts.log || ((m) => console.log(m));
  const memory = opts.memory || null;         // CHG-129: optional createSupportMemory()

  function ipKey(socket) {
    const req = (socket && socket.request) || { socket: {}, headers: {} };
    return crypto.createHash('sha256').update(salt + '|' + rateKey(req, trustProxy)).digest('hex').slice(0, 32);
  }

  // Call from the 'join' handler after the welcome. -> 'greeted' | 'already' | 'limited' | 'none'
  function onJoin(socket, data, displayName) {
    if (!data || typeof data !== 'object' || data.support !== true) return 'none';
    if (socket.data.supportAsked) return 'already';   // one greeting per session (socket), even on re-join
    socket.data.supportAsked = true;
    const r = limiter.hit(ipKey(socket));
    if (!r.ok) { log('[support] rate limited'); return 'limited'; }
    socket.data.support = true;                       // memory only; never sent to anyone
    log('[support] session started');
    schedule(() => {
      if (socket.connected === false) return;
      const g = greetingFor(displayName());
      say(g);
      if (memory) memory.add(socket, 'assistant', g); // CHG-129: the greeting opens the history
    }, GREET_DELAY_MS);
    return 'greeted';
  }

  function isSupport(socket) { return !!(socket && socket.data && socket.data.support); }

  // Support guests always get an answer, at most one per REPLY_COOLDOWN_MS.
  function shouldReply(socket) {
    if (!isSupport(socket)) return false;
    const t = now();
    if (socket.data.supportLastReply != null && t - socket.data.supportLastReply < REPLY_COOLDOWN_MS) return false;
    socket.data.supportLastReply = t;
    return true;
  }

  return { onJoin, isSupport, shouldReply, ipKey };
}

module.exports = {
  createSupport, createSupportMemory, buildMessages, greetingFor, systemPromptFor, withCrisisReminder, mentionsSelfHarm,
  GREETING, SUPPORT_PROMPT_ADDITION, FALLBACK_REPLY, CRISIS_REMINDER, PER_IP_PER_HOUR, HOUR_MS, GREET_DELAY_MS, REPLY_COOLDOWN_MS,
  HISTORY_MAX_MESSAGES, HISTORY_MAX_CHARS, HISTORY_TTL_MS
};
