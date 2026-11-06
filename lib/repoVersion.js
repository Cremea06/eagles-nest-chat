// CHG-164 — public latest-commit info for the "Build your own Milliway" card.
// GET /api/repo-version -> {available:true, sha, date, url} or {available:false}.
// Unauthenticated GitHub API (commits/main), 1 h in-memory cache. Never blocks startup.
// On fetch failure: last good value if any, else {available:false}. 30/min per client like GET /api/tailgate.
const { rateKey } = require('./safeLink');
const { createRateLimiter } = require('./serverStats');

const REPO = 'Cremea06/eagles-nest-chat';
const DEFAULT_URL = 'https://api.github.com/repos/' + REPO + '/commits/main';
const CACHE_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const UA = 'eagles-nest-chat (https://github.com/Cremea06/eagles-nest-chat)';

function shortSha(sha) {
  if (typeof sha !== 'string') return null;
  const s = sha.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(s)) return null;
  return s.slice(0, 7).toLowerCase();
}

function parseCommit(body) {
  if (!body || typeof body !== 'object') return null;
  const sha = shortSha(body.sha);
  const date = body.commit && (body.commit.committer && body.commit.committer.date
    || body.commit.author && body.commit.author.date);
  const url = typeof body.html_url === 'string' ? body.html_url : null;
  if (!sha || typeof date !== 'string' || !date) return null;
  // Keep ISO-ish date only (no local format from GitHub beyond ISO 8601).
  if (!/^\d{4}-\d{2}-\d{2}T/.test(date)) return null;
  return {
    available: true,
    sha,
    date,
    url: url || ('https://github.com/' + REPO + '/commit/' + sha)
  };
}

function createRepoVersion(opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const now = opts.now || Date.now;
  const cacheMs = opts.cacheMs != null ? opts.cacheMs : CACHE_MS;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : FETCH_TIMEOUT_MS;
  const apiUrl = opts.apiUrl || DEFAULT_URL;
  const limiter = opts.limiter || createRateLimiter({ limit: opts.limit || 30, windowMs: 60000 });
  const trustProxy = opts.trustProxy != null ? !!opts.trustProxy : process.env.TRUST_PROXY === '1';

  let cached = null;       // last good payload or null
  let cachedAt = 0;
  let inflight = null;     // Promise|null — coalesce concurrent refreshes

  function payload() {
    if (cached) return cached;
    return { available: false };
  }

  async function refresh() {
    if (typeof fetchFn !== 'function') return payload();
    let timer;
    try {
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      if (ac) {
        timer = setTimeout(() => ac.abort(), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
      const res = await fetchFn(apiUrl, {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        signal: ac ? ac.signal : undefined
      });
      if (!res || !res.ok) return payload();
      const body = await res.json();
      const parsed = parseCommit(body);
      if (parsed) {
        cached = parsed;
        cachedAt = now();
      }
      return payload();
    } catch (e) {
      return payload();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function ensureFresh() {
    const age = now() - cachedAt;
    if (cached && age < cacheMs) return Promise.resolve(payload());
    if (inflight) return inflight;
    inflight = refresh().finally(() => { inflight = null; });
    return inflight;
  }

  // Fire-and-forget warm (does not block callers / startup).
  function warm() {
    ensureFresh().catch(() => {});
  }

  async function handler(req, res) {
    res.removeHeader('X-Powered-By');
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    if (req.method === 'OPTIONS') {
      res.set({ Allow: 'GET, HEAD, OPTIONS' });
      return res.status(204).end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET, HEAD, OPTIONS');
      return res.status(405).json({ error: 'method' });
    }
    const r = limiter.hit(rateKey(req, trustProxy));
    if (!r.ok) {
      res.set('Retry-After', String(r.retryAfterSec));
      return res.status(429).json({ error: 'rate_limit' });
    }
    // Serve last good immediately when still fresh; otherwise await one refresh (or last good / unavailable).
    if (cached && (now() - cachedAt) < cacheMs) {
      return res.json(cached);
    }
    const out = await ensureFresh();
    return res.json(out);
  }

  return {
    handler,
    warm,
    ensureFresh,
    get: payload,
    // test helpers
    _setCache(value, at) { cached = value; cachedAt = at != null ? at : now(); },
    CACHE_MS: cacheMs
  };
}

module.exports = { createRepoVersion, parseCommit, shortSha, REPO, DEFAULT_URL, CACHE_MS, UA };
