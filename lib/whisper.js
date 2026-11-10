// CHG-167 — /tell and /r private whispers. Pure helpers; the server delivers the events.
// Whispers are never written to last5.txt, the clip buffer, or the server log.
// Guests may whisper unless WHISPER_MEMBERS_ONLY=1 (checked by the server).
const { createRateLimiter } = require('./serverStats');

const SOCK_LIMIT = 10;
const SOCK_WINDOW_MS = 60 * 1000;
const MAX_LEN = 300; // code points; same cap as a clip line
const HIDDEN = /[\p{Cf}\p{Cs}\p{Co}\p{Cc}\u2028\u2029]/gu;

function foldName(s) {
  return String(s == null ? '' : s)
    .replace(/\s*\(flagholder\)\s*$/i, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function compact(s) {
  return foldName(s).replace(/[-\s]/g, '');
}

function aliases(person) {
  const set = new Set();
  function add(s) {
    const f = foldName(s);
    if (f) {
      set.add(f);
      set.add(f.replace(/[-\s]/g, ''));
    }
  }
  add(person.username);
  add(person.roomName);
  add(person.shownName);
  const g = /^guest-user (\d+)$/i.exec(String(person.username || ''));
  if (g) set.add(g[1]);
  return set;
}

function findMatches(query, people) {
  const q = foldName(query);
  if (!q) return [];
  const qCompact = q.replace(/[-\s]/g, '');
  const hits = [];
  const seen = new Set();
  for (const p of people || []) {
    const key = p.key || foldName(p.username);
    if (!key || seen.has(key)) continue;
    const als = aliases(p);
    if (als.has(q) || (qCompact && als.has(qCompact))) {
      seen.add(key);
      hits.push(p);
    }
  }
  return hits;
}

function sanitizeMessage(raw) {
  if (raw == null) return { ok: false, reason: 'empty' };
  const s = String(raw)
    .normalize('NFC')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(HIDDEN, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return { ok: false, reason: 'empty' };
  if (Array.from(s).length > MAX_LEN) return { ok: false, reason: 'too_long' };
  return { ok: true, text: s };
}

function parseTell(args, people, opts) {
  const selfKey = opts && opts.selfKey ? foldName(opts.selfKey) : '';
  if (!Array.isArray(args) || args.length < 2) return { ok: false, reason: 'usage' };
  let chosen = null;
  let rest = null;
  let ambiguousName = null;
  for (let i = args.length - 1; i >= 1; i--) {
    const name = args.slice(0, i).join(' ');
    const hits = findMatches(name, people);
    if (hits.length === 1) {
      chosen = hits[0];
      rest = args.slice(i);
      break;
    }
    if (hits.length > 1 && !ambiguousName) ambiguousName = name;
  }
  if (!chosen && ambiguousName) return { ok: false, reason: 'ambiguous', name: ambiguousName };
  if (!chosen) {
    const asName = args.join(' ');
    if (findMatches(asName, people).length) return { ok: false, reason: 'usage' };
    return { ok: false, reason: 'offline', name: args.slice(0, -1).join(' ') };
  }
  const clean = sanitizeMessage(rest.join(' '));
  if (!clean.ok) return { ok: false, reason: clean.reason === 'too_long' ? 'too_long' : 'usage' };
  const key = chosen.key || foldName(chosen.username);
  if (selfKey && key === selfKey) return { ok: false, reason: 'self' };
  return { ok: true, person: chosen, message: clean.text };
}

function payload(dir, from, to, message) {
  return { dir: dir === 'out' ? 'out' : 'in', from: String(from || ''), to: String(to || ''), message: String(message || '') };
}

function label(data) {
  if (!data) return '';
  return data.dir === 'out' ? ('To ' + data.to + ':') : (data.from + ' whispers:');
}

function membersOnlyFromEnv(env) {
  return String((env || process.env).WHISPER_MEMBERS_ONLY || '') === '1';
}

function createWhisperLimiter(opts = {}) {
  return createRateLimiter({
    limit: opts.limit != null ? opts.limit : SOCK_LIMIT,
    windowMs: opts.windowMs != null ? opts.windowMs : SOCK_WINDOW_MS,
    now: opts.now
  });
}

module.exports = {
  foldName, compact, aliases, findMatches, sanitizeMessage, parseTell,
  payload, label, membersOnlyFromEnv, createWhisperLimiter,
  SOCK_LIMIT, SOCK_WINDOW_MS, MAX_LEN
};
