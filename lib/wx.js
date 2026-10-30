// CHG-145 — Weather Radio (alerts-first). GET /api/wx[?zip=NNNNN]
//  - with ?zip: weather for that ZIP; without: the server estimates the visitor's area from the client address
//    (offline DB-IP Lite City mmdb -> lat/lon -> nearest Census ZCTA centroid). The address is used once, in memory,
//    and never logged or stored. No DB / no match -> {zip:null, estimated:false}.
//  - weatherUSA Weather API (https://api.weatherusa.net, Bearer WEATHERUSA_API_KEY; the key never leaves this server):
//      v1/place?q=ZIP&exact=1 (lat/lon, fips, wxzone, fire_zone; cached 24 h), v1.2/alerts?...&data=1, v1/forecast?daily=1
//  - per-ZIP result cache 5 min; upstream budget 8 calls/min (Starter plan: 10/min, 1000/day);
//    per-visitor limit 20/min (CHG-106 rateKey: X-Forwarded-For only with TRUST_PROXY=1 and a loopback peer, last entry).
//  - CORS like /api/member-count: only the two homepage origins, never credentials, own OPTIONS.
const fs = require('fs');
const path = require('path');
const { rateKey } = require('./safeLink');
const { createRateLimiter, ALLOWED_ORIGINS } = require('./serverStats');

const ZIP_RE = /^\d{5}$/;
const TTL_MS = 5 * 60 * 1000;
const PLACE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ZIPS = 2000;
const BASE = 'https://api.weatherusa.net';
const ATTRIBUTION = { text: 'Weather data: weatherUSA', url: 'https://www.weatherusa.net' };
const DATA_DIR = path.join(__dirname, '..', 'data');

function validZip(z) { return typeof z === 'string' && ZIP_RE.test(z); }

function createTtlCache(ttlMs, max, now) {
  const m = new Map();
  return {
    get(k) { const e = m.get(k); if (!e) return undefined; if (now() - e.t >= ttlMs) { m.delete(k); return undefined; } return e.v; },
    set(k, v) { m.delete(k); m.set(k, { v, t: now() }); while (m.size > max) m.delete(m.keys().next().value); },
    size: () => m.size,
  };
}

// --- offline IP -> ZIP -------------------------------------------------------------------------------------------
function loadZcta(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!d || !Array.isArray(d.z) || d.z.length !== d.la.length || d.z.length !== d.lo.length) return null;
    return d;
  } catch (e) { return null; }
}
function nearestZip(zcta, lat, lon) {
  if (!zcta || !isFinite(lat) || !isFinite(lon)) return null;
  const k = Math.cos(lat * Math.PI / 180);
  let best = -1, bd = Infinity;
  for (let i = 0; i < zcta.z.length; i++) {
    const dy = zcta.la[i] - lat, dx = (zcta.lo[i] - lon) * k, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  // farther than ~1.5 degrees (~165 km) from any US ZIP centroid = not a US location we can serve
  return best >= 0 && bd < 2.25 ? zcta.z[best] : null;
}
function loadMmdb(file) {
  try {
    const buf = fs.readFileSync(file);
    const { Reader } = require('mmdb-lib');
    return new Reader(buf);
  } catch (e) { return null; }
}
function isPublicIp(ip) {
  if (typeof ip !== 'string' || !ip || ip === 'unknown') return false;
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    const [a, b] = v4.split('.').map(Number);
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
  }
  const l = ip.toLowerCase();
  return l.includes(':') && !(l === '::1' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd'));
}
// lookup(ip) -> {lat, lon} | null. Stub-able in tests.
function createIpLocator(opts = {}) {
  const reader = opts.reader !== undefined ? opts.reader : loadMmdb(opts.mmdbPath || path.join(DATA_DIR, 'dbip-city-lite.mmdb'));
  const zcta = opts.zcta !== undefined ? opts.zcta : loadZcta(opts.zctaPath || path.join(DATA_DIR, 'zcta-centroids.json'));
  return {
    ready: !!(reader && zcta),
    estimateZip(ip) {
      if (!reader || !zcta || !isPublicIp(ip)) return null;
      let rec = null;
      try { rec = reader.get(ip.replace(/^::ffff:/, '')); } catch (e) { return null; }
      const loc = rec && rec.location;
      const cc = rec && rec.country && rec.country.iso_code;
      if (!loc || (cc && !['US', 'PR', 'VI', 'GU', 'AS', 'MP'].includes(cc))) return null;
      return nearestZip(zcta, Number(loc.latitude), Number(loc.longitude));
    },
  };
}

// --- weatherUSA client -----------------------------------------------------------------------------------------------
function clip(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; }
// Short spoken description from an NWS bulletin: the "* ..." bullets (WHAT/WHERE/WHEN or At ... radar ...), else body.
function summarizeAlert(text) {
  const t = String(text || '').replace(/\r/g, '');
  const bullets = t.split(/\n\s*\*\s+/).slice(1).map((b) => b.replace(/\n\s*\n[\s\S]*$/, '').replace(/\.\.\./g, ' ').trim()).filter(Boolean);
  if (bullets.length) return clip(bullets.join('. ').replace(/\.\s*\./g, '.'), 320);
  const paras = t.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !/^(BULLETIN|URGENT|National Weather Service|\d{3,4} (AM|PM))/i.test(p) && p.length > 40);
  return clip(paras[0] || '', 320);
}
function shapeAlerts(json) {
  const list = (json && Array.isArray(json.data)) ? json.data : [];
  return list.slice(0, 10).map((a) => ({
    id: String(a.id || ''),
    name: clip(a.name || a.prod || 'Weather alert', 80),
    severity: Number(a.severity) || 0,
    start: Number(a.advisory_start) || null,
    end: Number(a.advisory_end) || null,
    summary: summarizeAlert(a.data),
  }));
}
function shapeForecast(json) {
  const days = Array.isArray(json) ? json : (json && Array.isArray(json.data) ? json.data : []);
  return days.slice(0, 2).map((d) => ({
    day: clip(d.day_name || '', 12), text: clip(d.wx_str || '', 60),
    hi: isFinite(d.hi) ? Number(d.hi) : null, lo: isFinite(d.lo) ? Number(d.lo) : null,
    pop: isFinite(d.pop12) ? Number(d.pop12) : null,
  }));
}

function createWx(opts = {}) {
  const now = opts.now || Date.now;
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : process.env.WEATHERUSA_API_KEY;
  const doFetch = opts.fetch || globalThis.fetch;
  const base = opts.baseUrl || BASE;
  const cache = createTtlCache(opts.ttlMs || TTL_MS, MAX_ZIPS, now);
  const places = createTtlCache(PLACE_TTL_MS, MAX_ZIPS, now);
  const budget = createRateLimiter({ limit: opts.upstreamPerMin || 8, windowMs: 60000, now });
  const inflight = new Map();
  let upstreamCalls = 0;

  async function call(pathq) {
    if (!budget.hit('up').ok) { const e = new Error('busy'); e.code = 'busy'; throw e; }
    upstreamCalls++;
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await doFetch(base + pathq, { headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' }, signal: ctl.signal });
      if (r.status === 404) return null;
      if (!r.ok) { const e = new Error('upstream ' + r.status); e.code = 'upstream'; throw e; }
      return await r.json();
    } finally { clearTimeout(tm); }
  }

  async function load(zip) {
    let place = places.get(zip);
    if (place === undefined) {
      const j = await call('/v1/place?exact=1&q=' + zip);
      const p = j && Array.isArray(j.place) ? j.place.find((x) => x && x.zip === zip) || j.place[0] : null;
      place = p && isFinite(p.lat) && isFinite(p.lon)
        ? { name: clip(p.name, 60), state: clip(p.state, 4), lat: Number(p.lat), lon: Number(p.lon), fips: p.fips, wxzone: p.wxzone, fire_zone: p.fire_zone }
        : null;
      places.set(zip, place);
    }
    if (!place) return { zip, found: false };
    const q = place.lat.toFixed(3) + ',' + place.lon.toFixed(3);
    const aq = new URLSearchParams({ q, data: '1' });
    if (place.fips) aq.set('fips', place.fips); if (place.wxzone) aq.set('wxzone', place.wxzone); if (place.fire_zone) aq.set('fire_zone', place.fire_zone);
    const [alerts, fc] = await Promise.all([
      call('/v1.2/alerts?' + aq.toString()),
      call('/v1/forecast?daily=1&units=e&maxtime=2d&q=' + q).catch(() => null), // forecast is optional; alerts are not
    ]);
    return { zip, found: true, place: { name: place.name, state: place.state }, alerts: shapeAlerts(alerts), forecast: shapeForecast(fc), updated: Math.floor(now() / 1000) };
  }

  async function get(zip) {
    if (!validZip(zip)) { const e = new Error('bad zip'); e.code = 'zip'; throw e; }
    if (!apiKey) { const e = new Error('not configured'); e.code = 'config'; throw e; }
    const hit = cache.get(zip); if (hit) return hit;
    if (inflight.has(zip)) return inflight.get(zip);
    const p = load(zip).then((v) => { cache.set(zip, v); return v; }).finally(() => inflight.delete(zip));
    inflight.set(zip, p);
    return p;
  }
  return { get, stats: () => ({ upstreamCalls, cached: cache.size() }) };
}

function wxRoute(opts = {}) {
  const wx = opts.wx || createWx(opts);
  const locator = opts.locator || createIpLocator(opts);
  const limiter = opts.limiter || createRateLimiter({ limit: opts.limit || 20, windowMs: 60000 });
  const trustProxy = opts.trustProxy != null ? !!opts.trustProxy : process.env.TRUST_PROXY === '1';
  const origins = opts.origins || ALLOWED_ORIGINS;
  return async function wxHandler(req, res) {
    const origin = req.get('origin');
    const home = !!origin && origins.has(origin);
    res.removeHeader('X-Powered-By');
    res.set({ 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
    if (home) res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Retry-After' }); // never credentials
    if (req.method === 'OPTIONS') {
      if (home) res.set({ 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600' });
      return res.status(204).end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.set('Allow', 'GET, HEAD, OPTIONS'); return res.status(405).json({ error: 'method' }); }
    let ip = rateKey(req, trustProxy); // in memory only for this request; never logged
    const r = limiter.hit(ip);
    if (!r.ok) { res.set('Retry-After', String(r.retryAfterSec)); return res.status(429).json({ error: 'rate_limit' }); }
    const qz = req.query && req.query.zip;
    let zip, estimated = false;
    if (qz !== undefined) {
      if (!validZip(String(qz))) return res.status(400).json({ error: 'zip' });
      zip = String(qz);
    } else {
      zip = locator.estimateZip(ip); estimated = !!zip;
    }
    ip = null;
    const body = { zip: zip || null, estimated, attribution: ATTRIBUTION };
    if (!zip) return res.json(body);
    try {
      const w = await wx.get(zip);
      return res.json(Object.assign(body, w));
    } catch (e) {
      const code = e && e.code === 'busy' ? 503 : e && e.code === 'config' ? 503 : 502;
      if (e && e.code === 'busy') res.set('Retry-After', '30');
      console.log('[wx] upstream error', e && e.code ? e.code : 'fetch'); // no IP, no key, no URL
      return res.status(code).json(Object.assign(body, { error: e && e.code === 'busy' ? 'busy' : 'unavailable' }));
    }
  };
}

module.exports = { wxRoute, createWx, createIpLocator, validZip, nearestZip, isPublicIp, summarizeAlert, shapeAlerts, shapeForecast, createTtlCache, loadZcta, ATTRIBUTION };
