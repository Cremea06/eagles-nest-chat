// CHG-132 — public member count: GET /api/member-count -> {"members": N}.
// N = number of account records in users.json (array, or object keyed by name). Count only: no names, emails or
// any other field ever leave this file. users.json is re-read at most once every 60 s (or after invalidate()).
// Same pattern as CHG-081 server-stats: registered BEFORE the global cors(), only the two homepage origins get CORS
// (never credentials), own OPTIONS. Rate limit per visitor with the CHG-106 rateKey (X-Forwarded-For only with
// TRUST_PROXY=1 and a loopback peer), 30/min like CHG-115 /api/profile.
const fs = require('fs');
const { rateKey } = require('./safeLink');
const { createRateLimiter, ALLOWED_ORIGINS } = require('./serverStats');

const TTL_MS = 60 * 1000;
const MAX_AGE = 60;

function countUsers(data) {
  if (Array.isArray(data)) return data.filter((u) => u && typeof u === 'object').length;
  if (data && typeof data === 'object') {
    // object shape: {users:[...]} wrapper, or a map keyed by username
    if (Array.isArray(data.users)) return countUsers(data.users);
    return Object.values(data).filter((u) => u && typeof u === 'object').length;
  }
  return 0;
}

function memberCountRoute(usersPath, opts = {}) {
  const limiter = opts.limiter || createRateLimiter({ limit: opts.limit || 30, windowMs: 60000 });
  const trustProxy = opts.trustProxy != null ? !!opts.trustProxy : process.env.TRUST_PROXY === '1';
  const now = opts.now || Date.now;
  const origins = opts.origins || ALLOWED_ORIGINS;
  let cached = null;
  let at = 0;

  function count() {
    if (cached == null || now() - at > TTL_MS) {
      try { cached = countUsers(JSON.parse(fs.readFileSync(usersPath, 'utf8'))); at = now(); }
      catch (e) { if (cached == null) return null; }   // keep the last good number on a read/parse error
    }
    return cached;
  }

  function handler(req, res) {
    const origin = req.get('origin');
    const home = !!origin && origins.has(origin);
    res.removeHeader('X-Powered-By');
    res.set({ Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
    if (home) res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Retry-After' });
    if (req.method === 'OPTIONS') {
      if (home) res.set({ 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600' });
      return res.status(204).end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set({ Allow: 'GET, HEAD, OPTIONS', 'Cache-Control': 'no-store' });
      return res.status(405).json({ error: 'method' });
    }
    const r = limiter.hit(rateKey(req, trustProxy));
    if (!r.ok) {
      res.set({ 'Retry-After': String(r.retryAfterSec), 'Cache-Control': 'no-store' });
      return res.status(429).json({ error: 'rate_limit' });
    }
    const n = count();
    if (n == null) { res.set('Cache-Control', 'no-store'); return res.status(503).json({ error: 'unavailable' }); }
    res.set('Cache-Control', 'public, max-age=' + MAX_AGE);
    return res.json({ members: n });
  }

  return { handler, count, invalidate: () => { cached = null; } };
}

module.exports = { memberCountRoute, countUsers };
