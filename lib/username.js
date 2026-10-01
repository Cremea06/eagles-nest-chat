// CHG-051 — one server-side rule for NEW display names (registration). Existing stored names are never
// re-checked or rewritten (login, /auth, cookie restore, /nest keep working for legacy names).
// check(raw, opts) -> { ok: true, name } with the normalized name, or { ok: false, reason } (plain text for the user).
//   opts.email           : the account email, for owner-only names (see OWNER_EMAIL_SHA256)
//   opts.serverGenerated : server-made names (Guest-User NNNN) skip the reserved check; every other rule applies
const crypto = require('crypto');

const MIN = 2;
const MAX = 24; // code points, after normalizing; fits the roster, chips and the /nest handle

// Reserved keys, compared after fold() as whole keys ('Sandy', 'Adminton', 'Systemic' stay allowed).
// neagle (AI speaker), server (private-pane speaker), anonymous (fallback speaker), plus admin, operator, system,
// andy, guestuser. guestuser is a PREFIX: no new name may start with the guest prefix ('Guest User 1234').
const RESERVED = ['neagle', 'admin', 'operator', 'system', 'andy', 'guestuser', 'server', 'anonymous'];
const PREFIX = ['guestuser'];
// Owner-only keys: allowed when the account email (trimmed, lowercase) hashes to this. Only the hash is in the code.
const OWNER_EMAIL_SHA256 = { andy: '40bd86f9700ab0711bfe4e4cbdbe97215fec4fd833ef7f28659beaa39a7ea2fb' };

// Format chars (zero-width, bidi controls, BOM, word joiner…: Unicode Cf), lone surrogates, private use, and
// blank-looking fillers. Checked on the raw input, before whitespace collapsing (JS \s would turn U+FEFF into a space).
const HIDDEN = /[\p{Cf}\p{Cs}\p{Co}\u115F\u1160\u3164\uFFA0\u2800]/u;
const CONTROL = /\p{Cc}/u; // C0, DEL, C1 left after collapsing (tab/newline runs become one space first)
const MARKUP = /[<>&"'`]/;

// Lookalike skeleton for the reserved compare only (stored names are untouched). Greek, Cyrillic, IPA g;
// i/l/1/| and 0/o are compared as one letter each, and 'rn' as 'm'.
const SKELETON = {
  'ν': 'n', 'α': 'a', 'ε': 'e', 'ο': 'o', 'ι': 'l', 'κ': 'k', 'μ': 'm', 'ρ': 'p', 'τ': 't', 'υ': 'y', 'χ': 'x',
  'β': 'b', 'ζ': 'z', 'η': 'h',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'l', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd',
  'т': 't', 'н': 'h', 'к': 'k', 'м': 'm', 'в': 'b', 'ӏ': 'l', 'ɡ': 'g', 'ց': 'g', 'ı': 'l',
  'i': 'l', '1': 'l', '|': 'l', 'ǀ': 'l', '0': 'o'
};
const SKELETON_RE = new RegExp('[' + Object.keys(SKELETON).join('') + ']', 'gu');

function fold(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD').replace(/\p{M}/gu, '')        // accents: 'Néagle' -> 'neagle'
    .replace(SKELETON_RE, (c) => SKELETON[c])
    .replace(/[\s\p{P}\p{S}\p{Cf}_-]/gu, '')        // whitespace, punctuation (incl. _ and -), symbols, format chars
    .replace(/rn/g, 'm');
}
const KEYS = new Map(RESERVED.map((k) => [fold(k), k]));

// -> the reserved key a name collides with, or ''.
function reservedKey(name) {
  const f = fold(name);
  if (KEYS.has(f)) return KEYS.get(f);
  for (const p of PREFIX) if (f.startsWith(fold(p))) return p;
  return '';
}

function isOwnerEmail(key, email) {
  const want = OWNER_EMAIL_SHA256[key];
  if (!want || typeof email !== 'string' || !email.trim()) return false;
  return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex') === want;
}

function normalize(raw) {
  return String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
}

function check(raw, opts) {
  const o = opts || {};
  const fail = (reason, extra) => Object.assign({ ok: false, reason }, extra);
  if (HIDDEN.test(String(raw == null ? '' : raw))) return fail('Name cannot contain hidden or invisible characters.');
  const name = normalize(raw);
  if (MARKUP.test(name)) return fail('Name cannot contain < > & " \' or `.');
  if (CONTROL.test(name)) return fail('Name cannot contain control characters.');
  const len = Array.from(name).length;
  if (len < MIN || len > MAX) return fail('Name must be ' + MIN + ' to ' + MAX + ' characters.');
  if (!/[\p{L}\p{N}]/u.test(name)) return fail('Name must include a letter or number.');
  if (!o.serverGenerated) {
    const key = reservedKey(name);
    // ownerOnly: everything else passed; the name is allowed once the owner's email is known (register email step)
    if (key && !isOwnerEmail(key, o.email)) return fail('That name is reserved.', { name, ownerOnly: key in OWNER_EMAIL_SHA256 });
  }
  return { ok: true, name };
}

module.exports = { check, normalize, fold, reservedKey, RESERVED, MIN, MAX };
