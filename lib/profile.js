// CHG-115 — read-only public profile: GET /api/profile/:username -> { username, tier, joined? } or a plain 404.
// Only an allow-list of fields leaves this file (never email, codes, tokens, flagholder or rep).
// Lookup uses the CHG-051 fold() (NFKC, case, accents, Greek/Cyrillic skeleton, punctuation), so a lookalike resolves
// to the real account. Hidden (404): unfinished sign-ups, names that fail today's CHG-051 check(), and fold collisions
// between two stored names. Unknown, hidden and ambiguous all get the same 404 body (no near-match hints).
// Rate limit per visitor with the CHG-106 rateKey (X-Forwarded-For only with TRUST_PROXY=1 and a loopback peer).
const usernameRule = require('./username');
const { rateKey } = require('./safeLink');
const { createRateLimiter } = require('./serverStats');

const TTL_MS = 60 * 1000;     // in-memory index rebuilt at most once a minute (or on invalidate())
const MAX_AGE = 60;           // Cache-Control seconds, 200 and 404 alike
const MAX_RAW = 64;
const NOT_FOUND = { error: 'not_found' };

function visible(u) {
  if (!u || typeof u.username !== 'string' || !u.username) return false;
  if (u.verified === false || u.pendingCode) return false;              // unfinished sign-ups
  return usernameRule.check(u.username, { email: u.email }).ok;         // fails CHG-051 today -> hidden
}

function joinedOf(u) {
  const t = typeof u.createdAt === 'string' ? Date.parse(u.createdAt) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

function profileRoute(getUsers, opts = {}) {
  const limiter = opts.limiter || createRateLimiter({ limit: opts.limit || 30, windowMs: 60000 });
  const trustProxy = opts.trustProxy != null ? !!opts.trustProxy : process.env.TRUST_PROXY === '1';
  const now = opts.now || Date.now;
  let index = null;
  let builtAt = 0;

  function build() {
    const m = new Map();                                                // fold key -> user, or null when 2+ collide
    for (const u of getUsers() || []) {
      if (!visible(u)) continue;
      const k = usernameRule.fold(u.username);
      if (!k) continue;
      m.set(k, m.has(k) ? null : u);
    }
    index = m;
    builtAt = now();
  }

  function lookup(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > MAX_RAW) return null;
    if (!index || now() - builtAt > TTL_MS) build();
    return index.get(usernameRule.fold(raw)) || null;
  }

  function handler(req, res) {
    res.removeHeader('X-Powered-By');
    res.set('X-Content-Type-Options', 'nosniff');
    const r = limiter.hit(rateKey(req, trustProxy));
    if (!r.ok) {
      res.set({ 'Retry-After': String(r.retryAfterSec), 'Cache-Control': 'no-store' });
      return res.status(429).json({ error: 'rate_limit' });
    }
    res.set('Cache-Control', 'public, max-age=' + MAX_AGE);
    const u = lookup(req.params && req.params.username);
    if (!u) return res.status(404).json(NOT_FOUND);
    const out = { username: u.username, tier: 'Member' };
    const joined = joinedOf(u);
    if (joined) out.joined = joined;
    return res.json(out);
  }

  return { handler, lookup, invalidate: () => { index = null; } };
}

module.exports = { profileRoute, visible, joinedOf };
