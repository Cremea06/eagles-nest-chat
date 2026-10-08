// CHG-081: GET /api/server-stats, a small read-only "Task Manager" feed for the afirstflag.com Live-state panel.
//
// A background sampler (every INTERVAL_MS, timer unref'd) reads the aggregate "cpu" line of /proc/stat and
// /proc/meminfo (two small in-memory kernel files, no disk I/O) and keeps a ring of the last SAMPLES CPU
// readings. The JSON answer is built once per tick, so a request only sends a ready string: requests never
// read /proc and never trigger a measurement.
//
// CPU % = busy / (busy + idle) over the last interval, where busy = user + nice + system + irq + softirq and
// idle = idle + iowait. steal (time the host gave to other guests) and guest/guest_nice (already counted in
// user/nice) are left out, so a fully busy VPS reads about 100% even on a noisy host. Without /proc (not
// Linux, e.g. a Windows dev PC) it falls back to the sum of os.cpus() times.
// Memory % = (MemTotal - MemAvailable) / MemTotal, like "in use" in Task Manager (cache does not count).
//
// The answer holds numbers only: no process names, versions, hostnames, IPs, usernames, paths or env.
// CORS: only the two homepage origins, no credentials. Rate limit: fixed window per client address.
const fs = require('fs');
const os = require('os');

const INTERVAL_MS = 2000;
const SAMPLES = 60;                       // 60 x 2 s = the last 2 minutes
const RATE_LIMIT = 60;                    // requests per client per window (the panel polls about 24 a minute)
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_KEYS = 5000;               // memory cap for the limiter map (oldest key dropped first)
const ALLOWED_ORIGINS = new Set(['https://afirstflag.com', 'https://www.afirstflag.com']);

function round1(n) { return Math.round(n * 10) / 10; }
function clampPct(n) { return n < 0 ? 0 : n > 100 ? 100 : n; }

// "cpu  user nice system idle iowait irq softirq steal guest guest_nice" -> { busy, total } (jiffies), or null.
function parseProcStat(text) {
  const line = String(text || '').split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1).map(Number);
  if (f.length < 4 || f.slice(0, 4).some((v) => !Number.isFinite(v))) return null;
  const v = (i) => (Number.isFinite(f[i]) ? f[i] : 0);
  const busy = v(0) + v(1) + v(2) + v(5) + v(6);
  const idle = v(3) + v(4);
  return { busy, total: busy + idle };
}

// /proc/meminfo -> used % (0..100, one decimal) or null.
function parseMeminfo(text) {
  const kb = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) kb[m[1]] = Number(m[2]);
  }
  const total = kb.MemTotal;
  if (!(total > 0)) return null;
  const avail = kb.MemAvailable != null ? kb.MemAvailable : (kb.MemFree || 0) + (kb.Buffers || 0) + (kb.Cached || 0);
  return round1(clampPct(((total - avail) / total) * 100));
}

// Fallback without /proc: sum of all cores' times from os.cpus() (same busy / idle split; no steal there).
function osCpuTimes() {
  let busy = 0, idle = 0;
  for (const c of os.cpus()) {
    busy += c.times.user + c.times.nice + c.times.sys + c.times.irq;
    idle += c.times.idle;
  }
  return busy + idle > 0 ? { busy, total: busy + idle } : null;
}

// Two { busy, total } readings -> CPU % (0..100, one decimal), or null when the counters did not move or went back.
function cpuPercent(prev, cur) {
  if (!prev || !cur) return null;
  const dt = cur.total - prev.total;
  const db = cur.busy - prev.busy;
  if (!(dt > 0) || db < 0 || db > dt) return null;
  return round1(clampPct((db / dt) * 100));
}

function readFileOrNull(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

function defaultCpuTimes() {
  const s = readFileOrNull('/proc/stat');
  return (s && parseProcStat(s)) || osCpuTimes();
}

function defaultMemPct() {
  const s = readFileOrNull('/proc/meminfo');
  const v = s ? parseMeminfo(s) : null;
  if (v != null) return v;
  const total = os.totalmem();
  return total > 0 ? round1(clampPct(((total - os.freemem()) / total) * 100)) : null;
}

// Everything that touches the OS is injectable so tests can drive it.
function createServerStats(opts = {}) {
  const intervalMs = opts.intervalMs || INTERVAL_MS;
  const size = opts.size || SAMPLES;
  const cpuTimes = opts.cpuTimes || defaultCpuTimes;
  const memPct = opts.memPct || defaultMemPct;
  const uptime = opts.uptime || os.uptime;
  const loadavg = opts.loadavg || os.loadavg;
  const now = opts.now || Date.now;
  const cores = opts.cores || os.cpus().length || 1; // read once at start
  const samples = [];
  let prev = null;
  let body = '';
  let timer = null;
  let lastErrLog = 0;

  function build(cpu) {
    const la = loadavg() || [];
    body = JSON.stringify({
      cpu,
      cores,
      mem: { usedPct: memPct() },
      load: [0, 1, 2].map((i) => (Number.isFinite(la[i]) ? Math.round(la[i] * 100) / 100 : null)),
      uptimeSec: Math.max(0, Math.floor(uptime() || 0)),
      samples: samples.slice(),
      intervalMs,
      ts: now()
    });
  }

  // One measurement. Never throws (it runs on a timer next to the chat).
  function tick() {
    try {
      const cur = cpuTimes();
      const cpu = cpuPercent(prev, cur);
      if (cur) prev = cur;
      if (cpu != null) {
        samples.push(cpu);
        while (samples.length > size) samples.shift();
      }
      build(samples.length ? samples[samples.length - 1] : null);
    } catch (err) {
      const t = Date.now();
      if (t - lastErrLog > 60000) { lastErrLog = t; console.error('[server-stats] sample failed:', err && err.message); }
    }
  }

  function start() {
    if (timer) return;
    tick(); // first reading: the baseline (cpu stays null until the next tick)
    timer = setInterval(tick, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, body: () => body, _samples: samples };
}

// Fixed window per key, like the /api/flag-wallet-lookup limiter, plus a cap on the number of keys kept.
function createRateLimiter(opts = {}) {
  const limit = opts.limit || RATE_LIMIT;
  const windowMs = opts.windowMs || RATE_WINDOW_MS;
  const maxKeys = opts.maxKeys || RATE_MAX_KEYS;
  const now = opts.now || Date.now;
  const buckets = new Map(); // key -> { count, windowStart }

  function prune(t) {
    for (const [k, b] of buckets) if (t - b.windowStart >= windowMs) buckets.delete(k);
    while (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
  }

  // -> { ok: true } or { ok: false, retryAfterSec }
  function hit(key) {
    const t = now();
    let b = buckets.get(key);
    if (!b || t - b.windowStart >= windowMs) {
      if (b) buckets.delete(key);
      else if (buckets.size >= maxKeys) prune(t);
      b = { count: 0, windowStart: t };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.windowStart + windowMs - t) / 1000)) };
    return { ok: true };
  }

  return { hit, size: () => buckets.size };
}

function isLoopback(a) {
  return a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
}

// Rate-limit key. Behind nginx on the same box (the peer is loopback) the client address is the LAST
// X-Forwarded-For entry (the one nginx appends; earlier entries are whatever the client sent), else X-Real-IP.
// From any other peer the headers are ignored, since a direct caller could put anything in them.
function clientKey(req) {
  const peer = String((req.socket && req.socket.remoteAddress) || '');
  if (isLoopback(peer)) {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string' && xf.trim()) {
      const last = xf.split(',').pop().trim();
      if (last) return last.slice(0, 64);
    }
    const xr = req.headers['x-real-ip'];
    if (typeof xr === 'string' && xr.trim()) return xr.trim().slice(0, 64);
  }
  return peer || 'unknown';
}

// Express handler for /api/server-stats (mount with app.all, before the global cors()).
function serverStatsRoute(stats, limiter) {
  return function serverStatsHandler(req, res) {
    const origin = req.get('origin');
    const home = !!origin && ALLOWED_ORIGINS.has(origin);
    res.removeHeader('X-Powered-By'); // no framework banner on this route
    res.set({ 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
    if (home) res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Retry-After' }); // never Allow-Credentials
    if (req.method === 'OPTIONS') {
      if (home) res.set({ 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600' });
      return res.status(204).end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET, HEAD, OPTIONS');
      return res.status(405).json({ error: 'method' });
    }
    const r = limiter.hit(clientKey(req));
    if (!r.ok) {
      res.set('Retry-After', String(r.retryAfterSec));
      return res.status(429).json({ error: 'rate_limit' });
    }
    res.type('application/json').send(stats.body() || '{"cpu":null,"samples":[]}');
  };
}

module.exports = {
  createServerStats, createRateLimiter, serverStatsRoute, clientKey,
  parseProcStat, parseMeminfo, cpuPercent,
  INTERVAL_MS, SAMPLES, RATE_LIMIT, RATE_WINDOW_MS, RATE_MAX_KEYS, ALLOWED_ORIGINS
};
