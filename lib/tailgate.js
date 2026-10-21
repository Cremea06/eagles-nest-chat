// CHG-133 — Tailgate Party mode for the Broadcast card.
// Site mode is 'normal' (exactly the pre-CHG-133 card) or 'tailgate' (card shows Nick Fuentes's Rumble live stream).
// mode = override 'on' -> tailgate; 'off' -> normal; 'auto' (default) -> tailgate only while the detector confirms
// the channel is live (state is dropped back to normal after STALE_MS with no successful confirmation).
// GET  /api/tailgate -> {mode, override, live, embedId}  (public, no secrets, 30/min per client)
// POST /api/tailgate {mode:'auto'|'on'|'off', embedId?|embedUrl?}  Authorization: Bearer $TAILGATE_TOKEN
//      (constant-time compare, 401 otherwise; 404 when TAILGATE_TOKEN is unset/short; 10/min per client)
// Override persisted to a small gitignored json file so pm2 restarts keep it.
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { rateKey } = require('./safeLink');
const { createRateLimiter } = require('./serverStats');

const EMBED_RE = /^[a-z0-9]+$/i;
const OVERRIDES = new Set(['auto', 'on', 'off']);
const POLL_MS = 2 * 60 * 1000;
const STALE_MS = 10 * 60 * 1000;
const DEFAULT_EMBED = null;

function validEmbedId(id) { return typeof id === 'string' && id.length >= 3 && id.length <= 32 && EMBED_RE.test(id); }

// Accepts a bare id ("v7endym") or https://rumble.com/embed/<id>/ ; anything else -> null.
function parseEmbed(v) {
  if (typeof v !== 'string') return null;
  v = v.trim();
  if (validEmbedId(v)) return v;
  const m = /^https:\/\/rumble\.com\/embed\/([a-z0-9]+)\/?(?:\?.*)?$/i.exec(v);
  return m && validEmbedId(m[1]) ? m[1] : null;
}
function embedSrc(id) { return validEmbedId(id) ? 'https://rumble.com/embed/' + id + '/' : null; }

function tokenOk(header, secret) {
  if (typeof secret !== 'string' || secret.length < 16 || typeof header !== 'string') return false;
  const m = /^Bearer\s+(\S+)$/.exec(header);
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

function createTailgateState(opts = {}) {
  const file = opts.file || null;
  const now = opts.now || Date.now;
  const listeners = new Set();
  let override = 'auto';
  let manualEmbed = null;
  let det = { live: false, embedId: null, at: 0 };   // last successful detector answer
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (OVERRIDES.has(j.override)) override = j.override;
      if (validEmbedId(j.embedId)) manualEmbed = j.embedId;
    } catch (e) { /* no file yet / unreadable -> defaults */ }
  }
  function save() {
    if (!file) return;
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ override, embedId: manualEmbed, updatedAt: new Date(now()).toISOString() }) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) { console.error('[tailgate] could not save override:', e.message); }
  }
  function detLive() { return det.live && now() - det.at <= STALE_MS; }
  function get() {
    const live = detLive();
    let mode = 'normal'; let embedId = null;
    if (override === 'on') { embedId = manualEmbed || (live && det.embedId) || DEFAULT_EMBED; mode = embedId ? 'tailgate' : 'normal'; }
    else if (override === 'auto' && live && det.embedId) { mode = 'tailgate'; embedId = det.embedId; }
    return { mode, override, live, embedId: mode === 'tailgate' ? embedId : null };
  }
  let last = JSON.stringify(get());
  function changed() {
    const s = get(); const k = JSON.stringify(s);
    if (k !== last) { last = k; for (const fn of listeners) { try { fn(s); } catch (e) {} } }
    return s;
  }
  return {
    get,
    onChange(fn) { listeners.add(fn); },
    setOverride(mode, embedId) {
      if (!OVERRIDES.has(mode)) throw new Error('bad_mode');
      override = mode;
      if (mode === 'on') manualEmbed = embedId || null; else manualEmbed = null;
      save(); return changed();
    },
    // detector result: {live:boolean, embedId?:string}; null/undefined = failed check (keep last, let it go stale)
    report(r) {
      if (r && typeof r.live === 'boolean') det = { live: r.live && validEmbedId(r.embedId), embedId: validEmbedId(r.embedId) ? r.embedId : null, at: now() };
      return changed();
    },
    tick: () => changed(),   // re-evaluate staleness
  };
}

// ---- Rumble detector ----------------------------------------------------------------------------------------
// The channel page (https://rumble.com/c/nickjfuentes) embeds JSON objects for its videos:
//   {"object_type":"video",...,"url":"https://rumble.com/v...html","by":{... "url":"https://rumble.com/c/nickjfuentes"},
//    ..."live":false,"live_placeholder":false,...,"livestream_status":0,...}
// A video that is live right now has "live":true (and not a "live_placeholder" scheduled slot). The watch-page url is
// turned into the embed id with Rumble's public oEmbed (https://rumble.com/api/Media/oembed.json?url=...), whose
// html is <iframe src="https://rumble.com/embed/<id>/">.
const UA = 'EaglesNest-Tailgate/1.0 (+https://chat.afirstflag.com; polls every 2 min)';
const CHANNEL = 'https://rumble.com/c/nickjfuentes';

function findLiveVideo(html, channelUrl = CHANNEL) {
  if (typeof html !== 'string') return null;
  const parts = html.split('{"object_type":"video"').slice(1);
  for (const p of parts) {
    const chunk = p.slice(0, 20000);
    const by = /"by":\{[^{}]*?"url":"([^"]+)"/.exec(chunk);
    if (!by || by[1].replace(/\\\//g, '/').toLowerCase() !== channelUrl.toLowerCase()) continue;
    if (!/"live":true/.test(chunk) || /"live_placeholder":true/.test(chunk)) continue;
    const u = /"url":"(https:(?:\\\/|\/){2}rumble\.com(?:\\\/|\/)v[a-z0-9]+-[^"]*?\.html)"/i.exec(chunk);
    if (u) return u[1].replace(/\\\//g, '/');
  }
  return null;
}

async function fetchText(url, fetchImpl, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/json' }, signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('http_' + r.status);
    const txt = await r.text();
    if (txt.length > 5 * 1024 * 1024) throw new Error('too_big');
    return txt;
  } finally { clearTimeout(t); }
}

function rumbleDetector(opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const channel = opts.channel || CHANNEL;
  const timeoutMs = opts.timeoutMs || 15000;
  return async function detect() {
    const html = await fetchText(channel, fetchImpl, timeoutMs);
    if (!/"object_type":"video"/.test(html)) throw new Error('page_format_changed');
    const watch = findLiveVideo(html, channel);
    if (!watch) return { live: false };
    const oe = JSON.parse(await fetchText('https://rumble.com/api/Media/oembed.json?url=' + encodeURIComponent(watch), fetchImpl, timeoutMs));
    const m = /src="https:\/\/rumble\.com\/embed\/([a-z0-9]+)\//i.exec(String(oe.html || ''));
    if (!m || !validEmbedId(m[1])) throw new Error('no_embed_id');
    return { live: true, embedId: m[1] };
  };
}

// Starts the 2-minute loop. detector is pluggable (tests/mocks pass their own).
function startPolling(state, detector, opts = {}) {
  const every = opts.intervalMs || POLL_MS;
  let busy = false;
  async function once() {
    if (busy) return; busy = true;
    try { state.report(await detector()); }
    catch (e) { console.warn('[tailgate] detector failed (keeping last state):', e.message); state.tick(); }
    finally { busy = false; }
  }
  const first = setTimeout(once, opts.firstDelayMs != null ? opts.firstDelayMs : 5000);
  const iv = setInterval(once, every);
  first.unref && first.unref(); iv.unref && iv.unref();
  return { once, stop() { clearTimeout(first); clearInterval(iv); } };
}

function tailgateRoute(state, opts = {}) {
  const getLim = opts.getLimiter || createRateLimiter({ limit: 30, windowMs: 60000 });
  const postLim = opts.postLimiter || createRateLimiter({ limit: 10, windowMs: 60000 });
  const trustProxy = opts.trustProxy != null ? !!opts.trustProxy : process.env.TRUST_PROXY === '1';
  const secret = () => (opts.token !== undefined ? opts.token : process.env.TAILGATE_TOKEN);
  const json = express.json({ limit: '1kb', strict: true });
  function handler(req, res) {
    res.removeHeader('X-Powered-By');
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    if (req.method === 'GET' || req.method === 'HEAD') {
      const r = getLim.hit(rateKey(req, trustProxy));
      if (!r.ok) { res.set('Retry-After', String(r.retryAfterSec)); return res.status(429).json({ error: 'rate_limit' }); }
      return res.json(state.get());
    }
    if (req.method !== 'POST') { res.set('Allow', 'GET, HEAD, POST'); return res.status(405).json({ error: 'method' }); }
    const s = secret();
    if (typeof s !== 'string' || s.length < 16) return res.status(404).json({ error: 'disabled' });
    const r = postLim.hit(rateKey(req, trustProxy));
    if (!r.ok) { res.set('Retry-After', String(r.retryAfterSec)); return res.status(429).json({ error: 'rate_limit' }); }
    if (!tokenOk(req.get('authorization'), s)) { res.set('WWW-Authenticate', 'Bearer'); return res.status(401).json({ error: 'unauthorized' }); }
    json(req, res, (err) => {
      if (err) return res.status(400).json({ error: 'bad_json' });
      const b = req.body;
      if (!b || typeof b !== 'object' || !OVERRIDES.has(b.mode)) return res.status(400).json({ error: 'bad_mode' });
      let embedId = null;
      const raw = b.embedId != null ? b.embedId : b.embedUrl;
      if (raw != null) {
        if (b.mode !== 'on') return res.status(400).json({ error: 'embed_only_with_on' });
        embedId = parseEmbed(raw);
        if (!embedId) return res.status(400).json({ error: 'bad_embed' });
      }
      const out = state.setOverride(b.mode, embedId);
      console.log('[tailgate] override ->', b.mode, embedId || '');
      return res.json(out);
    });
  }
  return handler;
}

module.exports = { createTailgateState, rumbleDetector, findLiveVideo, startPolling, tailgateRoute, tokenOk, parseEmbed, validEmbedId, embedSrc, EMBED_RE, CHANNEL, UA, POLL_MS, STALE_MS };
