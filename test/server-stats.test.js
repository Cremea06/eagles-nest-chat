// CHG-081: tests for lib/serverStats.js and the /api/server-stats route. No new dependency:
// node:test + assert, and the app's own express. Run: npm test (or node --test test/server-stats.test.js).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const S = require('../lib/serverStats');

const STAT = 'cpu  100 0 50 800 50 0 0 30 0 0\ncpu0 100 0 50 800 50 0 0 30 0 0\nintr 1 2 3\n';

test('parseProcStat: busy excludes idle, iowait and steal', () => {
  assert.deepStrictEqual(S.parseProcStat(STAT), { busy: 150, total: 1000 });
  assert.strictEqual(S.parseProcStat('nothing here'), null);
  assert.strictEqual(S.parseProcStat('cpu  a b c d'), null);
  assert.deepStrictEqual(S.parseProcStat('cpu  10 0 10 80'), { busy: 20, total: 100 }); // old kernels: 4 fields
});

test('cpuPercent: deltas, rounding, bad deltas', () => {
  assert.strictEqual(S.cpuPercent({ busy: 0, total: 0 }, { busy: 25, total: 100 }), 25);
  assert.strictEqual(S.cpuPercent({ busy: 0, total: 0 }, { busy: 1, total: 3 }), 33.3);
  assert.strictEqual(S.cpuPercent({ busy: 0, total: 0 }, { busy: 100, total: 100 }), 100);
  assert.strictEqual(S.cpuPercent({ busy: 5, total: 100 }, { busy: 5, total: 100 }), null);  // no time passed
  assert.strictEqual(S.cpuPercent({ busy: 50, total: 100 }, { busy: 40, total: 200 }), null); // counter went back
  assert.strictEqual(S.cpuPercent(null, { busy: 1, total: 2 }), null);
});

test('parseMeminfo: MemAvailable, and the old-kernel fallback', () => {
  assert.strictEqual(S.parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 590 kB\n'), 41);
  assert.strictEqual(S.parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 100 kB\nCached: 200 kB\n'), 60);
  assert.strictEqual(S.parseMeminfo('garbage'), null);
});

test('sampler: ring of SAMPLES, first tick is only a baseline, JSON shape and nothing else', () => {
  let busy = 0, total = 0, t = 1000;
  const st = S.createServerStats({
    cpuTimes: () => ({ busy, total }), memPct: () => 41.2, uptime: () => 273600.7,
    loadavg: () => [0.123, 0.5, 1], now: () => t, cores: 2
  });
  st.tick();
  let j = JSON.parse(st.body());
  assert.strictEqual(j.cpu, null);
  assert.deepStrictEqual(j.samples, []);
  for (let i = 1; i <= 70; i++) { busy += i % 101; total += 100; t += 2000; st.tick(); }
  j = JSON.parse(st.body());
  assert.deepStrictEqual(Object.keys(j).sort(), ['cores', 'cpu', 'intervalMs', 'load', 'mem', 'samples', 'ts', 'uptimeSec']);
  assert.deepStrictEqual(Object.keys(j.mem), ['usedPct']);
  assert.strictEqual(j.samples.length, S.SAMPLES);
  assert.strictEqual(j.samples[0], 11);
  assert.strictEqual(j.cpu, 70);
  assert.strictEqual(j.cpu, j.samples[j.samples.length - 1]);
  assert.strictEqual(j.cores, 2);
  assert.strictEqual(j.mem.usedPct, 41.2);
  assert.deepStrictEqual(j.load, [0.12, 0.5, 1]);
  assert.strictEqual(j.uptimeSec, 273600);
  assert.strictEqual(j.intervalMs, 2000);
  assert.strictEqual(j.ts, t);
});

test('sampler: a throwing reader never throws out of tick, real /proc readers give sane numbers', () => {
  const st = S.createServerStats({ cpuTimes: () => { throw new Error('x'); } });
  const err = console.error; console.error = () => {};
  try { assert.doesNotThrow(() => st.tick()); } finally { console.error = err; }
  const real = S.createServerStats();
  real.tick(); real.tick();
  const j = JSON.parse(real.body());
  assert.ok(j.cores >= 1);
  assert.ok(j.mem.usedPct > 0 && j.mem.usedPct <= 100);
  assert.ok(j.uptimeSec > 0);
});

test('rate limiter: fixed window, Retry-After, key cap', () => {
  let t = 0;
  const rl = S.createRateLimiter({ limit: 3, windowMs: 60000, maxKeys: 4, now: () => t });
  for (let i = 0; i < 3; i++) assert.strictEqual(rl.hit('a').ok, true);
  t = 15000;
  assert.deepStrictEqual(rl.hit('a'), { ok: false, retryAfterSec: 45 });
  assert.strictEqual(rl.hit('b').ok, true); // other keys unaffected
  t = 60000;
  assert.strictEqual(rl.hit('a').ok, true); // new window
  for (const k of ['c', 'd', 'e', 'f', 'g']) rl.hit(k);
  assert.ok(rl.size() <= 4);
});

test('clientKey: headers trusted only from a loopback peer, last X-Forwarded-For entry wins', () => {
  const r = (peer, h) => ({ socket: { remoteAddress: peer }, headers: h || {} });
  assert.strictEqual(S.clientKey(r('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' })), '203.0.113.9');
  assert.strictEqual(S.clientKey(r('::ffff:127.0.0.1', { 'x-real-ip': '203.0.113.7' })), '203.0.113.7');
  assert.strictEqual(S.clientKey(r('198.51.100.4', { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4' })), '198.51.100.4');
  assert.strictEqual(S.clientKey(r('::1')), '::1');
});

function serve(limit) {
  const st = S.createServerStats({ cpuTimes: (() => { let n = 0; return () => ({ busy: (n += 30), total: n * 4 }); })() });
  st.tick(); st.tick();
  const app = express();
  app.all('/api/server-stats', S.serverStatsRoute(st, S.createRateLimiter({ limit })));
  app.use((req, res) => res.status(404).end());
  return new Promise((ok) => { const srv = http.createServer(app).listen(0, '127.0.0.1', () => ok(srv)); });
}

test('route: CORS only for the two homepage origins, no credentials, no-store, GET only', async () => {
  const srv = await serve(1000);
  const base = 'http://127.0.0.1:' + srv.address().port + '/api/server-stats';
  try {
    for (const o of ['https://afirstflag.com', 'https://www.afirstflag.com']) {
      const r = await fetch(base, { headers: { Origin: o } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers.get('access-control-allow-origin'), o);
      assert.strictEqual(r.headers.get('access-control-allow-credentials'), null);
      assert.strictEqual(r.headers.get('cache-control'), 'no-store');
      assert.match(r.headers.get('vary'), /Origin/);
      assert.match(r.headers.get('content-type'), /^application\/json/);
      assert.strictEqual((await r.json()).cpu, 25);
    }
    for (const o of ['http://afirstflag.com', 'https://evil.test', 'https://afirstflag.com.evil.test', 'http://localhost:3000', 'null']) {
      const r = await fetch(base, { headers: { Origin: o } });
      assert.strictEqual(r.headers.get('access-control-allow-origin'), null, o);
    }
    const pre = await fetch(base, { method: 'OPTIONS', headers: { Origin: 'https://afirstflag.com', 'Access-Control-Request-Method': 'GET' } });
    assert.strictEqual(pre.status, 204);
    assert.strictEqual(pre.headers.get('access-control-allow-methods'), 'GET');
    const preBad = await fetch(base, { method: 'OPTIONS', headers: { Origin: 'https://evil.test', 'Access-Control-Request-Method': 'GET' } });
    assert.strictEqual(preBad.headers.get('access-control-allow-origin'), null);
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await fetch(base, { method: m });
      assert.strictEqual(r.status, 405, m);
      assert.strictEqual(r.headers.get('allow'), 'GET, HEAD, OPTIONS');
    }
  } finally { srv.close(); }
});

test('route: 429 with Retry-After after the limit, per client', async () => {
  const srv = await serve(5);
  const base = 'http://127.0.0.1:' + srv.address().port + '/api/server-stats';
  try {
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await fetch(base, { headers: { 'X-Forwarded-For': '203.0.113.1' } })).status);
    assert.deepStrictEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
    const r = await fetch(base, { headers: { 'X-Forwarded-For': '203.0.113.1', Origin: 'https://afirstflag.com' } });
    assert.strictEqual(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://afirstflag.com'); // page can read the 429
    assert.strictEqual(r.headers.get('access-control-expose-headers'), 'Retry-After');
    assert.strictEqual((await fetch(base, { headers: { 'X-Forwarded-For': '203.0.113.2' } })).status, 200);
  } finally { srv.close(); }
});
