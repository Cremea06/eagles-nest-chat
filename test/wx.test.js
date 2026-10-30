// CHG-145: tests for lib/wx.js (GET /api/wx). No network beyond 127.0.0.1 (weatherUSA is a stub). Run: npm test.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const wxlib = require('../lib/wx');
const { wxRoute, createWx, createIpLocator, validZip, nearestZip, isPublicIp, summarizeAlert, createTtlCache } = wxlib;

const KEY = 'test-key-SHOULD-NOT-LEAK-123';
function stubFetch(calls) {
  return async (url, init) => {
    calls.push({ url, auth: init && init.headers && init.headers.Authorization });
    const u = new URL(url);
    const j = (o) => ({ ok: true, status: 200, json: async () => o });
    if (u.pathname === '/v1/place') {
      if (u.searchParams.get('q') === '00000') return j({ place: [] });
      return j({ place: [{ zip: u.searchParams.get('q'), name: 'Deming', state: 'NM', lat: '32.19', lon: '-107.76', fips: '35029', wxzone: 'NMZ407', fire_zone: 'NMZ111' }] });
    }
    if (u.pathname === '/v1.2/alerts') return j({ feed: 'alerts', data: [{ id: 7, name: 'Flash Flood Warning', severity: 1, advisory_start: 1, advisory_end: 2, data: 'BULLETIN\n\n* Flash Flood Warning for...\n  Luna County.\n\n* Until 900 PM MDT.\n' }] });
    if (u.pathname === '/v1/forecast') return j([{ day_name: 'Friday', wx_str: 'Sunny', hi: 70, lo: 50, pop12: 5 }]);
    return { ok: false, status: 500, json: async () => ({}) };
  };
}
const ZCTA = { z: ['88030', '43215', '94043'], la: [32.19, 39.97, 37.42], lo: [-107.76, -83.03, -122.08] };
const stubReader = { get: (ip) => (ip === '8.8.8.8' ? { country: { iso_code: 'US' }, location: { latitude: 37.4, longitude: -122.1 } } : ip === '81.2.69.1' ? { country: { iso_code: 'GB' }, location: { latitude: 51.5, longitude: -0.1 } } : null) };

function serve(opts) {
  const app = express();
  app.all('/api/wx', wxRoute(opts));
  return new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
}
const url = (s, q = '') => 'http://127.0.0.1:' + s.address().port + '/api/wx' + q;

test('validZip accepts exactly five digits', () => {
  for (const z of ['88030', '00501']) assert.ok(validZip(z));
  for (const z of ['8803', '880300', '8803a', ' 88030', '88030-1234', '', null, 88030]) assert.ok(!validZip(z), String(z));
});

test('route rejects bad zip with 400 and never calls upstream', async () => {
  const calls = [];
  const s = await serve({ wx: createWx({ apiKey: KEY, fetch: stubFetch(calls) }), locator: createIpLocator({ reader: null, zcta: null }), trustProxy: false });
  for (const q of ['?zip=1234', '?zip=abcde', '?zip=123456', '?zip=12345%0A']) assert.strictEqual((await fetch(url(s, q))).status, 400, q);
  assert.strictEqual(calls.length, 0);
  s.close();
});

test('per-ZIP cache: second request within 5 min makes no upstream calls; expires after TTL', async () => {
  let t = 1e12; const calls = [];
  const wx = createWx({ apiKey: KEY, fetch: stubFetch(calls), now: () => t });
  const a = await wx.get('88030');
  assert.strictEqual(a.alerts[0].name, 'Flash Flood Warning');
  assert.match(a.alerts[0].summary, /Luna County/);
  assert.strictEqual(calls.length, 3);
  await wx.get('88030'); assert.strictEqual(calls.length, 3);
  t += 5 * 60 * 1000 + 1;
  await wx.get('88030'); assert.strictEqual(calls.length, 5, 'place cached 24 h, alerts+forecast refetched');
});

test('ttl cache evicts oldest beyond max', () => {
  const c = createTtlCache(1000, 2, () => 0);
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  assert.strictEqual(c.get('a'), undefined); assert.strictEqual(c.get('c'), 3);
});

test('missing DB files -> locator loads lazily, no estimate, route returns zip:null without upstream', async () => {
  const loc = createIpLocator({ mmdbPath: '/nonexistent/x.mmdb', zctaPath: '/nonexistent/z.json' });
  assert.strictEqual(loc.loaded(), false);
  assert.strictEqual(await loc.estimateZip('8.8.8.8'), null);
  assert.strictEqual(await loc.estimateZip('8.8.4.4'), null, 'still no estimate, no crash');
  assert.strictEqual(loc.loadCount(), 1, 'missing file not re-read per request');
  const calls = [];
  const s = await serve({ wx: createWx({ apiKey: KEY, fetch: stubFetch(calls) }), locator: loc, trustProxy: false });
  const r = await fetch(url(s)); const j = await r.json();
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([j.zip, j.estimated], [null, false]);
  assert.strictEqual(calls.length, 0);
  s.close();
});

test('IP estimate path with stub reader: public US IP -> nearest ZIP; private/foreign -> null', async () => {
  const loc = createIpLocator({ reader: stubReader, zcta: ZCTA });
  assert.strictEqual(await loc.estimateZip('8.8.8.8'), '94043');
  assert.strictEqual(await loc.estimateZip('::ffff:8.8.8.8'), '94043');
  assert.strictEqual(await loc.estimateZip('81.2.69.1'), null);
  assert.strictEqual(await loc.estimateZip('10.1.2.3'), null);
  assert.strictEqual(await loc.estimateZip('127.0.0.1'), null);
  assert.ok(isPublicIp('8.8.8.8') && !isPublicIp('192.168.1.1') && !isPublicIp('unknown'));
  assert.strictEqual(nearestZip(ZCTA, 0, 0), null, 'far from every centroid');
});

test('route estimates from the LAST X-Forwarded-For entry only with trustProxy and loopback peer', async () => {
  const calls = [];
  const loc = createIpLocator({ reader: stubReader, zcta: ZCTA });
  const s = await serve({ wx: createWx({ apiKey: KEY, fetch: stubFetch(calls) }), locator: loc, trustProxy: true });
  const j = await (await fetch(url(s), { headers: { 'X-Forwarded-For': '81.2.69.1, 8.8.8.8' } })).json();
  assert.deepStrictEqual([j.zip, j.estimated], ['94043', true]);
  assert.ok(Array.isArray(j.alerts));
  const j2 = await (await fetch(url(s), { headers: { 'X-Forwarded-For': '8.8.8.8, 81.2.69.1' } })).json();
  assert.strictEqual(j2.zip, null, 'spoofed first entry ignored');
  s.close();
  const s2 = await serve({ wx: createWx({ apiKey: KEY, fetch: stubFetch([]) }), locator: loc, trustProxy: false });
  const j3 = await (await fetch(url(s2), { headers: { 'X-Forwarded-For': '8.8.8.8' } })).json();
  assert.strictEqual(j3.zip, null, 'header ignored without TRUST_PROXY');
  s2.close();
});

test('route never leaks the API key and sends it only as Bearer upstream; attribution present', async () => {
  const calls = [];
  const s = await serve({ wx: createWx({ apiKey: KEY, fetch: stubFetch(calls) }), locator: createIpLocator({ reader: null, zcta: null }), trustProxy: false });
  const r = await fetch(url(s, '?zip=88030'), { headers: { Origin: 'https://afirstflag.com' } });
  const t = await r.text();
  assert.strictEqual(r.status, 200);
  assert.ok(!t.includes(KEY));
  for (const [k, v] of r.headers) assert.ok(!String(v).includes(KEY), k);
  assert.ok(calls.length > 0 && calls.every((c) => c.auth === 'Bearer ' + KEY && !c.url.includes(KEY)));
  const j = JSON.parse(t);
  assert.deepStrictEqual(j.attribution, { text: 'Weather data: weatherUSA', url: 'https://www.weatherusa.net' });
  assert.strictEqual(j.place.name, 'Deming');
  assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://afirstflag.com');
  assert.strictEqual(r.headers.get('access-control-allow-credentials'), null);
  s.close();
});

test('CORS: foreign origin gets no ACAO; OPTIONS 204; POST 405', async () => {
  const s = await serve({ wx: createWx({ apiKey: KEY, fetch: stubFetch([]) }), locator: createIpLocator({ reader: null, zcta: null }), trustProxy: false });
  const r = await fetch(url(s), { headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
  const o = await fetch(url(s), { method: 'OPTIONS', headers: { Origin: 'https://www.afirstflag.com' } });
  assert.strictEqual(o.status, 204); assert.strictEqual(o.headers.get('access-control-allow-methods'), 'GET');
  assert.strictEqual((await fetch(url(s), { method: 'POST' })).status, 405);
  s.close();
});

test('per-visitor rate limit returns 429 with Retry-After', async () => {
  const s = await serve({ wx: createWx({ apiKey: KEY, fetch: stubFetch([]) }), locator: createIpLocator({ reader: null, zcta: null }), trustProxy: false, limit: 2 });
  await fetch(url(s)); await fetch(url(s));
  const r = await fetch(url(s));
  assert.strictEqual(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) >= 1);
  s.close();
});

test('no key configured -> 503 unavailable, unknown ZIP -> found:false, upstream errors -> 502 without details', async () => {
  const s = await serve({ wx: createWx({ apiKey: '', fetch: stubFetch([]) }), locator: createIpLocator({ reader: null, zcta: null }), trustProxy: false });
  const r = await fetch(url(s, '?zip=88030')); assert.strictEqual(r.status, 503); assert.strictEqual((await r.json()).error, 'unavailable');
  s.close();
  const wx = createWx({ apiKey: KEY, fetch: stubFetch([]) });
  assert.strictEqual((await wx.get('00000')).found, false);
  const bad = createWx({ apiKey: KEY, fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  const s2 = await serve({ wx: bad, locator: createIpLocator({ reader: null, zcta: null }), trustProxy: false });
  const r2 = await fetch(url(s2, '?zip=12345')); const t2 = await r2.text();
  assert.strictEqual(r2.status, 502); assert.ok(!t2.includes(KEY) && !t2.includes('api.weatherusa'));
  s2.close();
});

test('upstream budget caps calls per minute (Starter plan 10/min)', async () => {
  const calls = [];
  const wx = createWx({ apiKey: KEY, fetch: stubFetch(calls), upstreamPerMin: 4 });
  await wx.get('11111');
  await assert.rejects(wx.get('22222'), (e) => e.code === 'busy');
  assert.ok(calls.length <= 4);
});

test('summarizeAlert keeps it short and readable', () => {
  const s = summarizeAlert('BULLETIN\n\n* WHAT...Winds 40 mph.\n\n* WHERE...Luna County.\n' + '\n* WHEN...' + 'x '.repeat(400));
  assert.ok(s.length <= 320); assert.match(s, /^WHAT/);
  assert.strictEqual(summarizeAlert(''), '');
});

test('lazy mmdb: not loaded until the first no-zip request; zip requests never load it; concurrent firsts share one load', async () => {
  let loads = 0, release;
  const gate = new Promise((r) => { release = r; });
  const loc = createIpLocator({ zcta: ZCTA, loadReader: () => { loads++; return gate.then(() => stubReader); } });
  const s = await serve({ wx: createWx({ apiKey: KEY, fetch: stubFetch([]) }), locator: loc, trustProxy: true });
  assert.strictEqual(loc.loaded(), false, 'nothing loaded at startup');
  await fetch(url(s, '?zip=88030'), { headers: { 'X-Forwarded-For': '8.8.8.8' } });
  assert.strictEqual(loads, 0, 'zip request does not load the DB');
  const h = { headers: { 'X-Forwarded-For': '8.8.8.8' } };
  const ps = [fetch(url(s), h), fetch(url(s), h), fetch(url(s), h)];
  await new Promise((r) => setTimeout(r, 50));
  release();
  const js = await Promise.all(ps.map(async (p) => (await p).json()));
  assert.ok(js.every((j) => j.zip === '94043' && j.estimated));
  assert.strictEqual(loads, 1, 'single shared load promise');
  s.close();
});

test('real mmdb loader on a missing path resolves to no estimate (no throw)', async () => {
  const loc = createIpLocator({ mmdbPath: '/nonexistent/dbip.mmdb', zcta: ZCTA });
  assert.strictEqual(await loc.estimateZip('8.8.8.8'), null);
});

test('API key is read from process.env at call time (as dotenv fills it from .env)', async () => {
  const prev = process.env.WEATHERUSA_API_KEY;
  delete process.env.WEATHERUSA_API_KEY;
  const calls = [];
  const wx = createWx({ fetch: stubFetch(calls) });
  await assert.rejects(wx.get('88030'), (e) => e.code === 'config');
  process.env.WEATHERUSA_API_KEY = KEY;
  try { await wx.get('88030'); assert.ok(calls.every((c) => c.auth === 'Bearer ' + KEY)); }
  finally { if (prev === undefined) delete process.env.WEATHERUSA_API_KEY; else process.env.WEATHERUSA_API_KEY = prev; }
});
