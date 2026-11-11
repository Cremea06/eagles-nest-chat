// CHG-171 — "Featured on Rumble" card: four official channels, public live badges.
// GET /api/featured -> {credit, polling, cacheSeconds, checkedAt, creators:[{id,name,channel,avatar,live,watchUrl?}]}
// Avatars are official Rumble CDN URLs (hotlinked, not copied). Credit points at https://rumble.com/.
// Live checks reuse Tailgate's findLiveVideo parser on each channel page. No oEmbed (the shared Tailgate
// is admin-controlled and is not switched from this card). Checks run on demand when the cache is stale,
// at most once per FEATURED_CACHE_MS (default 120 s, clamped 60–300 s), and only if FEATURED_POLL is not '0'.
// Channels are checked one after another. A fresh Tailgate "live" result for nickjfuentes is reused so that
// channel is not fetched twice. Failed checks keep the last known flag for that creator. 30/min per client.
const { rateKey } = require('./safeLink');
const { createRateLimiter } = require('./serverStats');
const { findLiveVideo } = require('./tailgate');

const CREDIT = { text: 'Images and channels courtesy of Rumble', href: 'https://rumble.com/' };
const UA = 'EaglesNest-Featured/1.0 (+https://chat.afirstflag.com; cached 2 min)';
const DEFAULT_CACHE_MS = 120 * 1000;
const MIN_CACHE_MS = 60 * 1000;
const MAX_CACHE_MS = 300 * 1000;
const DEFAULT_TIMEOUT_MS = 15000;
const CHANNEL_RE = /^https:\/\/rumble\.com\/c\/[A-Za-z0-9_-]+$/;
const AVATAR_RE = /^https:\/\/hugh\.cdn\.rumble\.cloud\/video\/[A-Za-z0-9/_.-]+\.(?:png|jpe?g|webp)$/;

// Official verified channels, recorded 2026-11-10 from the live rumble.com pages (and Asmongold's official site).
const CREATORS = Object.freeze([
  Object.freeze({
    id: 'nickjfuentes',
    name: 'Nicholas J. Fuentes',
    channel: 'https://rumble.com/c/nickjfuentes',
    avatar: 'https://hugh.cdn.rumble.cloud/video/z8/R/B/H/c/RBHca.baa.1-nickjfuentes-rpb4lx.png',
  }),
  Object.freeze({
    id: 'DrDisrespect',
    name: 'Dr Disrespect',
    channel: 'https://rumble.com/c/DrDisrespect',
    avatar: 'https://hugh.cdn.rumble.cloud/video/z8/R/Q/J/A/RQJAa.baa-DrDisrespect-sn5uzu.jpeg',
  }),
  Object.freeze({
    id: 'russellbrand',
    name: 'Russell Brand',
    channel: 'https://rumble.com/c/russellbrand',
    avatar: 'https://hugh.cdn.rumble.cloud/video/z8/1/B/t/e/1Btea.baa.1-russellbrand-sy4bex.jpeg',
  }),
  Object.freeze({
    id: 'Asmongold',
    name: 'Asmongold',
    channel: 'https://rumble.com/c/Asmongold',
    avatar: 'https://hugh.cdn.rumble.cloud/video/z8/I/i/a/E/IiaEa.baa-Asmongold-tbnxti.jpeg',
  }),
]);

function clampCacheMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_CACHE_MS;
  return Math.min(MAX_CACHE_MS, Math.max(MIN_CACHE_MS, Math.floor(n)));
}

function cacheMsFromEnv(env) {
  const e = env || process.env;
  return clampCacheMs(e.FEATURED_CACHE_MS);
}

function pollEnabledFromEnv(env) {
  const e = env || process.env;
  return e.FEATURED_POLL !== '0';
}

function validWatchUrl(u) {
  return typeof u === 'string' && /^https:\/\/rumble\.com\/v[A-Za-z0-9_-]+\.html$/.test(u);
}

function staticCreator(c, live, watchUrl) {
  const out = { id: c.id, name: c.name, channel: c.channel, avatar: c.avatar, live: !!live };
  if (out.live && validWatchUrl(watchUrl)) out.watchUrl = watchUrl;
  return out;
}

async function fetchText(url, fetchImpl, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  if (typeof t.unref === 'function') t.unref();
  try {
    const r = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/json' },
      signal: ctl.signal,
      redirect: 'follow',
    });
    if (!r.ok) throw new Error('http_' + r.status);
    const txt = await r.text();
    if (txt.length > 5 * 1024 * 1024) throw new Error('too_big');
    return txt;
  } finally { clearTimeout(t); }
}

function checkChannel(creator, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  return (async () => {
    const html = await fetchText(creator.channel, fetchImpl, timeoutMs);
    if (!/"object_type":"video"/.test(html)) throw new Error('page_format_changed');
    const watch = findLiveVideo(html, creator.channel);
    if (!watch) return { live: false };
    return { live: true, watchUrl: watch };
  })();
}

function createFeatured(opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const now = opts.now || Date.now;
  const cacheMs = opts.cacheMs != null ? clampCacheMs(opts.cacheMs) : cacheMsFromEnv(opts.env);
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const poll = opts.poll != null ? !!opts.poll : pollEnabledFromEnv(opts.env);
  const getTailgate = opts.getTailgate || null;
  const limiter = opts.limiter || createRateLimiter({ limit: opts.limit || 30, windowMs: 60000 });
  const trustProxy = opts.trustProxy != null ? !!opts.trustProxy : process.env.TRUST_PROXY === '1';
  const check = opts.checkChannel || ((c) => checkChannel(c, { fetch: fetchImpl, timeoutMs }));

  const last = new Map(); // id -> {live, watchUrl?}
  let checkedAt = 0;
  let inflight = null;

  function creatorsPayload() {
    return CREATORS.map((c) => {
      const prev = last.get(c.id);
      return staticCreator(c, prev && prev.live, prev && prev.watchUrl);
    });
  }

  function snapshot() {
    return {
      credit: { text: CREDIT.text, href: CREDIT.href },
      polling: poll,
      cacheSeconds: Math.round(cacheMs / 1000),
      checkedAt: checkedAt ? new Date(checkedAt).toISOString() : null,
      creators: creatorsPayload(),
    };
  }

  function reuseTailgate(creator) {
    if (!getTailgate || creator.id !== 'nickjfuentes') return null;
    try {
      const st = getTailgate();
      if (st && st.live === true && st.source === 'rumble') return { live: true };
    } catch (e) { /* ignore */ }
    return null;
  }

  async function refresh() {
    if (!poll) return snapshot();
    for (const c of CREATORS) {
      const reused = reuseTailgate(c);
      if (reused) { last.set(c.id, reused); continue; }
      try {
        const r = await check(c);
        last.set(c.id, r && r.live ? { live: true, watchUrl: r.watchUrl } : { live: false });
      } catch (e) {
        // keep last known flag; log once per failure without dumping the body
        console.warn('[featured] check failed for', c.id + ':', e && e.message ? e.message : e);
      }
    }
    checkedAt = now();
    return snapshot();
  }

  function maybeRefresh() {
    if (!poll) return;
    if (inflight) return inflight;
    if (checkedAt && now() - checkedAt < cacheMs) return;
    inflight = refresh().catch((e) => {
      console.warn('[featured] refresh failed:', e && e.message ? e.message : e);
      return snapshot();
    }).finally(() => { inflight = null; });
    return inflight;
  }

  function handler(req, res) {
    res.removeHeader('X-Powered-By');
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET, HEAD');
      return res.status(405).json({ error: 'method' });
    }
    const r = limiter.hit(rateKey(req, trustProxy));
    if (!r.ok) {
      res.set('Retry-After', String(r.retryAfterSec));
      return res.status(429).json({ error: 'rate_limit' });
    }
    maybeRefresh(); // stale-while-revalidate: never block the response on Rumble
    return res.json(snapshot());
  }

  return {
    snapshot,
    refresh,
    maybeRefresh,
    handler,
    pollEnabled: () => poll,
    cacheMs: () => cacheMs,
  };
}

module.exports = {
  CREATORS, CREDIT, CHANNEL_RE, AVATAR_RE, UA,
  DEFAULT_CACHE_MS, MIN_CACHE_MS, MAX_CACHE_MS,
  clampCacheMs, cacheMsFromEnv, pollEnabledFromEnv,
  validWatchUrl, checkChannel, createFeatured,
};
