// CHG-140: a member's CLAIMED X handle (proof of concept). Pure self-declared text: Milliway never calls X, never
// fetches anything from X, and shows the handle as 'unverified'. This file only validates and normalises what the
// member typed. A handle is 1-15 characters of A-Z a-z 0-9 _ (ASCII only: no Unicode lookalikes, no dots, dashes,
// slashes, colons or spaces, so a URL, an @-chain or markup can never pass). One leading '@' is allowed and removed.
// The typed case is kept (X ignores case, the profile link works either way).
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const MAX_LEN = 15;

// -> { ok: true, handle } or { ok: false, reason: 'empty' | 'invalid' }
function normalize(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid' };
  let s = raw.trim();
  if (s.startsWith('@')) s = s.slice(1);
  if (!s) return { ok: false, reason: 'empty' };
  if (!HANDLE_RE.test(s)) return { ok: false, reason: 'invalid' };
  return { ok: true, handle: s };
}

// For output paths (profile API): returns the handle only when a stored value still passes the strict rule.
function publicHandle(v) {
  return typeof v === 'string' && HANDLE_RE.test(v) ? v : null;
}

module.exports = { normalize, publicHandle, HANDLE_RE, MAX_LEN };
