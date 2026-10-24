// CHG-138 — /delete: a signed-in member deletes their own account (emailed code, then /auth <code>).
// Pure helpers only (no socket.io, no express), so they are unit-tested with fake clocks and temp files.
//   createDeleteCodes()   purpose-tagged, in-memory delete codes: 10 min, 5 tries, single use. They live in their own
//                         store and never touch the login code fields on users.json, so a login code can never delete
//                         an account and a delete code can never sign anyone in.
//   createTombstones()    names freed by a deletion stay held for 90 days (tombstones.json, gitignored, no email).
//   backupFileAtomic()    copy to a temp file, then rename (an interrupted copy never leaves a half backup).
//   nameMatcher()         recognizes a deleted member's display name in clip/chat lines ('WV Name', 'Name (flagholder)').
const crypto = require('crypto');
const fs = require('fs');
const { fold } = require('./username');
const states = require('./states');

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_TRIES = 5;
const TOMBSTONE_MS = 90 * 24 * 60 * 60 * 1000;
const FORMER = 'Former member';
const PURPOSE = 'delete';
const CONFIRM_TEXT = 'auth code sent. /auth code to delete account'; // Andy's wording (CHG-138)

function sameCode(expected, given) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(given || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createDeleteCodes(opts = {}) {
  const ttlMs = opts.ttlMs || CODE_TTL_MS;
  const maxTries = opts.maxTries || MAX_TRIES;
  const now = opts.now || Date.now;
  const makeCode = opts.makeCode || (() => String(crypto.randomInt(100000, 1000000)));
  const map = new Map(); // account key (lowercase username) -> { purpose, code, until, tries }

  function prune() { const t = now(); for (const [k, e] of map) if (e.until <= t) map.delete(k); }

  return {
    // a new request replaces any older delete code for the account and resets its tries
    issue(key) {
      prune();
      const code = makeCode();
      map.set(key, { purpose: PURPOSE, code, until: now() + ttlMs, tries: 0 });
      return code;
    },
    // an expired code still counts as outstanding until check() reports it, so the member hears 'expired' once
    has(key) { return map.has(key); },
    clear(key) { map.delete(key); },
    // -> 'none' | 'expired' | 'wrong' | 'locked' | 'ok'. 'ok' consumes the code (single use).
    check(key, given) {
      const e = map.get(key);
      if (!e || e.purpose !== PURPOSE) return 'none';
      if (e.until <= now()) { map.delete(key); return 'expired'; }
      if (!sameCode(e.code, given)) {
        e.tries += 1;
        if (e.tries >= maxTries) { map.delete(key); return 'locked'; }
        return 'wrong';
      }
      map.delete(key);
      return 'ok';
    },
  };
}

function writeAtomic(file, text, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, mode); } catch (e) { /* best effort */ }
}

function backupFileAtomic(src, dest) {
  if (!fs.existsSync(src)) return false;
  const tmp = dest + '.tmp';
  fs.copyFileSync(src, tmp);
  try { fs.chmodSync(tmp, 0o600); } catch (e) { /* best effort */ }
  fs.renameSync(tmp, dest);
  return true;
}

function createTombstones(opts = {}) {
  const file = opts.file || null;
  const ttlMs = opts.ttlMs || TOMBSTONE_MS;
  const now = opts.now || Date.now;
  let list = []; // { k: fold(name), at, until }
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && Array.isArray(j.tombstones)) list = j.tombstones.filter((x) => x && typeof x.k === 'string' && Number.isFinite(x.until));
    } catch (e) { /* none yet */ }
  }
  function prune() { const t = now(); list = list.filter((x) => x.until > t); }
  function save() { if (file) writeAtomic(file, JSON.stringify({ tombstones: list }) + '\n', 0o600); }
  prune();
  return {
    // the same fold() as the reserved-name rule, so lookalikes ('Bob' / 'B0b') are held too
    has(name) { prune(); const k = fold(name); return !!k && list.some((x) => x.k === k); },
    // throws when it cannot persist: the caller must then NOT delete the account
    add(name) {
      prune();
      const k = fold(name) || String(name).toLowerCase();
      const t = now();
      list.push({ k, at: t, until: t + ttlMs });
      try { save(); } catch (e) { list.pop(); throw e; }
    },
    size() { prune(); return list.length; },
  };
}

// Display forms of a member in the room: 'Name', 'WV Name' (/rep state), either with ' (flagholder)'.
function nameMatcher(name) {
  const want = String(name || '').toLowerCase();
  return function matches(text) {
    let s = String(text || '').toLowerCase().trim();
    if (!want) return false;
    s = s.replace(/ \(flagholder\)$/, '');
    if (s === want) return true;
    const m = /^([a-z]{2}) (.+)$/.exec(s);
    return !!m && m[2] === want && !!states.normalize(m[1]);
  };
}

module.exports = { createDeleteCodes, createTombstones, backupFileAtomic, nameMatcher, writeAtomic, CODE_TTL_MS, MAX_TRIES, TOMBSTONE_MS, FORMER, PURPOSE, CONFIRM_TEXT };
