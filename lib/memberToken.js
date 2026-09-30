// CHG-047 — member token: keeps a signed-in Milliway member signed in between visits.
//
// Format: "mt1.<base64url(JSON claims)>.<base64url(HMAC-SHA256(secret, 'mt1.' + body))>"
// Claims: u (username), tv (per-user token version, for revocation), iat, exp (seconds).
// No email or other personal data. Node's built-in crypto only (no dependency).
//
// verify() never throws: anything malformed, tampered, expired or signed with another
// secret returns null, and the caller treats that as "guest".

const crypto = require('crypto');

const PREFIX = 'mt1';
const MAX_LEN = 1024;
const SKEW_MS = 60 * 1000; // accept an iat at most 60 s in the future

function mac(secret, body) {
  return crypto.createHmac('sha256', secret).update(PREFIX + '.' + body).digest();
}

function sign(secret, claims, ttlMs, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({
    u: String(claims.u),
    tv: Number(claims.tv) || 0,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ttlMs) / 1000)
  })).toString('base64url');
  return PREFIX + '.' + body + '.' + mac(secret, body).toString('base64url');
}

function verify(secret, token, now = Date.now()) {
  try {
    if (!secret || typeof token !== 'string' || !token || token.length > MAX_LEN) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return null;
    const want = mac(secret, parts[1]);
    const got = Buffer.from(parts[2], 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!c || typeof c.u !== 'string' || !c.u) return null;
    if (!Number.isInteger(c.tv) || !Number.isInteger(c.iat) || !Number.isInteger(c.exp)) return null;
    if (c.exp * 1000 <= now) return null;
    if (c.iat * 1000 > now + SKEW_MS) return null;
    return c;
  } catch {
    return null;
  }
}

// Minimal Cookie header reader (no cookie-parser dependency). Returns the value, or null if absent.
function parseCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      const value = part.slice(i + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value; // undecodable: hand it back so verify() rejects it and it gets cleared
      }
    }
  }
  return null;
}

module.exports = { sign, verify, parseCookie };
