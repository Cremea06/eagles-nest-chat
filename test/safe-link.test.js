// CHG-106: unit + API tests for lib/brands.js and lib/safeLink.js. All network is mocked (fetch, DNS lookup,
// http request). Run: npm test. The one real Google call lives in test/safe-link.live.test.js.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { EventEmitter } = require('events');
const express = require('express');
const B = require('../lib/brands');
const L = require('../lib/safeLink');

// ---- mocks ----
const PUBLIC = '93.184.215.14';
function mkLookup(map = {}) {
  return (host, opts, cb) => {
    const v = map[host] !== undefined ? map[host] : PUBLIC;
    if (v === 'NX') { const e = new Error('nx'); e.code = 'ENOTFOUND'; return cb(e); }
    const list = (Array.isArray(v) ? v : [v]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    cb(null, opts && opts.all ? list : list[0].address, list[0].family);
  };
}
function mkFetch(badUrls = [], opts = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (opts.fail) throw new Error('network');
    if (opts.status) return { ok: false, status: opts.status, json: async () => ({}) };
    const entries = JSON.parse(init.body).threatInfo.threatEntries.map((e) => e.url);
    const matches = entries.filter((u) => badUrls.some((b) => u.includes(b))).map((u) => ({ threatType: 'SOCIAL_ENGINEERING', threat: { url: u } }));
    return { ok: true, json: async () => (matches.length ? { matches } : {}) };
  };
  f.calls = calls;
  return f;
}
// redirects: { 'https://bit.ly/x': { status: 301, location: '...' } }; records method + lookup use
function mkRequest(redirects, log = []) {
  return (u, opts, cb) => {
    const req = new EventEmitter();
    req.end = () => {
      opts.lookup(u.hostname, {}, (err) => {
        if (err) return req.emit('error', err);
        const key = u.href;
        log.push(opts.method + ' ' + key + (opts.headers.Range ? ' range' : ''));
        let r = redirects[key] || { status: 404 };
        if (typeof r === 'function') r = r(opts.method);
        if (r.hang) return;
        const res = new EventEmitter();
        res.statusCode = r.status; res.headers = r.location ? { location: r.location } : {}; res.destroy = () => {};
        cb(res);
      });
    };
    req.destroy = (e) => req.emit('error', e || new Error('destroyed'));
    return req;
  };
}
const deps = (o = {}) => Object.assign({ key: 'TESTKEY', fetch: mkFetch(), lookup: mkLookup() }, o);

// ---- brands ----
test('brands: lookalikes caught, official and unrelated domains pass', () => {
  for (const h of ['amaz0n-support.com', 'paypal-secure-login.xyz', 'appleid.apple.com.verify-account.top', 'paypa1.com',
    'rnicrosoft.com', 'arnazon.com', 'vvalmart.com', 'netflx.com', 'wellsfarg0.com', 'bankofamerca.com', 'pаypal.com',
    'usps-redelivery.info', 'irs-refund.com', 'chaseonline-help.com', 'faceb00k-login.net', 'coinbase.login-help.net']) {
    assert.ok(B.lookalike(h), h + ' should be a lookalike');
  }
  for (const h of ['paypal.com', 'www.paypal.com', 'appleid.apple.com', 'amazon.co.uk', 'smile.amazon.com', 'irs.gov',
    'afirstflag.com', 'github.com', 'wikipedia.org', 'maple.com', 'phase.com', 'upstate.com', 'cups.org', 'support.com', 'bbc.co.uk']) {
    assert.strictEqual(B.lookalike(h), null, h + ' should not be a lookalike');
  }
  assert.strictEqual(B.registrable('a.b.example.co.uk'), 'example.co.uk');
  assert.strictEqual(B.skel('vvalmart'), 'walmart');
  assert.ok(Object.keys(B.BRANDS).length >= 30);
});

// ---- normalize / SSRF ----
test('normalize: adds https, only http/https, IDN both ways, length cap', () => {
  assert.strictEqual(L.normalize('example.com/a').url.href, 'https://example.com/a');
  assert.strictEqual(L.normalize('  HTTP://Example.COM ').url.href, 'http://example.com/');
  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://x.com', 'file:///etc/passwd', '', 'x'.repeat(3000), 'https://']) {
    assert.throws(() => L.normalize(bad), TypeError, bad.slice(0, 20));
  }
  const n = L.normalize('https://pаypal.com');
  assert.ok(n.ascii.startsWith('xn--'));
  assert.strictEqual(n.unicode, 'pаypal.com');
});

test('SSRF: literal private / metadata / local hosts are refused', () => {
  for (const u of ['http://127.0.0.1', 'http://169.254.169.254/latest/meta-data', 'http://10.1.2.3', 'http://192.168.1.1',
    'http://172.16.0.1', 'http://100.64.0.1', 'http://0.0.0.0', 'http://[::1]/', 'http://[fe80::1]/', 'http://[fd00::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://localhost:3000', 'http://foo.localhost',
    'http://metadata.google.internal/', 'http://printer.local', 'http://metadata/']) {
    const n = L.normalize(u);
    assert.throws(() => L.refuseLiteral(n.ascii), L.Refused, u);
  }
  assert.throws(() => L.refuseLiteral('intranet'), TypeError); // single word: not a web link (bad input, not refused)
  assert.doesNotThrow(() => L.refuseLiteral('8.8.8.8'));
  assert.doesNotThrow(() => L.refuseLiteral('example.com'));
});

test('SSRF: a DNS name resolving to a private IP is refused; check() rejects it', async () => {
  const lookup = mkLookup({ 'evil.example': ['93.184.215.14', '10.0.0.5'], 'meta.example': '169.254.169.254' });
  await assert.rejects(L.refuseResolved('evil.example', lookup), L.Refused);
  await assert.rejects(L.check('http://meta.example/', deps({ lookup })), L.Refused);
  await assert.rejects(L.check('http://169.254.169.254/', deps()), L.Refused);
  // an undefined dep (as the route passes when nothing is injected) must not knock out the default DNS lookup
  await assert.rejects(L.check('http://localhost.', deps({ lookup: undefined })), L.Refused);
  const dnsMod = require('dns'); const orig = dnsMod.lookup;
  dnsMod.lookup = mkLookup({ 'sneaky.example': '127.0.0.1' });
  try { await assert.rejects(L.check('http://sneaky.example/', { key: 'K', fetch: mkFetch(), lookup: undefined }), L.Refused); }
  finally { dnsMod.lookup = orig; }
  assert.strictEqual(await L.refuseResolved('ok.example', lookup), 'ok');
});

// ---- verdicts ----
test('verdicts: safe, danger (Google), caution (lookalike, flags), unknown (Google down)', async () => {
  let r = await L.check('https://www.paypal.com/', deps());
  assert.strictEqual(r.verdict, 'safe'); assert.strictEqual(r.host, 'www.paypal.com'); assert.ok(!r.advisory);

  r = await L.check('afirstflag.com', deps());
  assert.strictEqual(r.verdict, 'safe');

  const f = mkFetch(['bad.example']);
  r = await L.check('http://bad.example/x', deps({ fetch: f }));
  assert.strictEqual(r.verdict, 'danger'); assert.strictEqual(r.advisory, 'google');
  assert.deepStrictEqual(r.threats, ['SOCIAL_ENGINEERING']);
  assert.match(r.reasons[0], /suspected/);
  const sent = f.calls[0];
  assert.strictEqual(sent.client.clientId, 'afirstflag');
  assert.deepStrictEqual(sent.threatInfo.threatTypes, ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION']);

  for (const u of ['amaz0n-support.com', 'paypal-secure-login.xyz', 'appleid.apple.com.verify-account.top']) {
    r = await L.check(u, deps());
    assert.strictEqual(r.verdict, 'caution', u);
    assert.ok(r.reasons.some((x) => /isn't the real/.test(x)), u);
  }
  r = await L.check('http://8.8.8.8/', deps());
  assert.strictEqual(r.verdict, 'caution'); assert.match(r.reasons[0], /number address/);
  r = await L.check('https://free-stuff.zip/', deps());
  assert.strictEqual(r.verdict, 'caution');
  r = await L.check('https://a.b.c.d.e.example.com/', deps());
  assert.ok(r.reasons.some((x) => /number of parts/.test(x)));
  r = await L.check('https://user@example.com/', deps());
  assert.ok(r.reasons.some((x) => /@ sign/.test(x)));
  r = await L.check('https://example.com/' + '%41'.repeat(12), deps());
  assert.ok(r.reasons.some((x) => /code characters/.test(x)));
  r = await L.check('https://example.com/?' + 'a'.repeat(250), deps());
  assert.ok(r.reasons.some((x) => /unusually long/.test(x)));
  r = await L.check('https://example.com/account/verify', deps());
  assert.ok(r.reasons.some((x) => /login/.test(x)));
  r = await L.check('https://xn--80ak6aa92e.com/', deps());
  assert.ok(r.reasons.some((x) => /alphabets/.test(x)));
  r = await L.check('https://no-such-site.example/', deps({ lookup: mkLookup({ 'no-such-site.example': 'NX' }) }));
  assert.strictEqual(r.verdict, 'caution');

  r = await L.check('https://example.com/', deps({ fetch: mkFetch([], { fail: true }) }));
  assert.strictEqual(r.verdict, 'unknown'); assert.ok(r.reasons.some((x) => /couldn't be reached/.test(x)));
  r = await L.check('https://example.com/', deps({ fetch: mkFetch([], { status: 403 }) }));
  assert.strictEqual(r.verdict, 'unknown');
  r = await L.check('https://example.com/', deps({ key: '' }));
  assert.strictEqual(r.verdict, 'unknown');
  r = await L.check('paypal-secure-login.xyz', deps({ fetch: mkFetch([], { fail: true }) }));
  assert.strictEqual(r.verdict, 'caution'); // other checks still run
});

// ---- short links ----
test('short links: HEAD, GET Range fallback, all hops to Google, finalUrl, limits, SSRF on hops', async () => {
  const log = [];
  const request = mkRequest({
    'https://bit.ly/abc': { status: 301, location: 'https://tinyurl.com/def' },
    'https://tinyurl.com/def': (m) => (m === 'HEAD' ? { status: 405 } : { status: 302, location: 'https://evil-target.example/login' })
  }, log);
  const f = mkFetch(['evil-target.example']);
  let r = await L.check('bit.ly/abc', deps({ request, fetch: f }));
  assert.strictEqual(r.verdict, 'danger');
  assert.strictEqual(r.finalUrl, 'https://evil-target.example/login');
  assert.deepStrictEqual(log, ['HEAD https://bit.ly/abc', 'HEAD https://tinyurl.com/def', 'GET https://tinyurl.com/def range']);
  assert.deepStrictEqual(f.calls[0].threatInfo.threatEntries.map((e) => e.url),
    ['https://bit.ly/abc', 'https://tinyurl.com/def', 'https://evil-target.example/login']); // target never fetched

  r = await L.check('https://bit.ly/p', deps({ request: mkRequest({ 'https://bit.ly/p': { status: 301, location: 'https://paypa1-login.com/' } }) }));
  assert.strictEqual(r.verdict, 'caution'); assert.strictEqual(r.finalUrl, 'https://paypa1-login.com/');

  // redirect to a private address -> refused
  await assert.rejects(L.check('https://bit.ly/m', deps({ request: mkRequest({ 'https://bit.ly/m': { status: 302, location: 'http://169.254.169.254/' } }) })), L.Refused);
  // a shortener whose DNS points inside -> refused before any request
  const log2 = [];
  await assert.rejects(L.check('https://is.gd/x', deps({ lookup: mkLookup({ 'is.gd': '127.0.0.1' }), request: mkRequest({}, log2) })), L.Refused);
  assert.deepStrictEqual(log2, []);

  // loop of shorteners: stops after 5 hops
  const loop = {};
  for (let i = 0; i < 10; i++) loop['https://bit.ly/' + i] = { status: 301, location: 'https://bit.ly/' + (i + 1) };
  const log3 = [];
  r = await L.check('https://bit.ly/0', deps({ request: mkRequest(loop, log3) }));
  assert.strictEqual(log3.filter((x) => x.startsWith('HEAD')).length, 5);
  assert.strictEqual(r.verdict, 'caution'); assert.ok(r.reasons.some((x) => /too many/.test(x)));

  // dead short link
  r = await L.check('https://cutt.ly/zz', deps({ request: mkRequest({}) }));
  assert.strictEqual(r.verdict, 'caution'); assert.ok(r.reasons.some((x) => /couldn't see where/.test(x)));
  assert.ok(!('finalUrl' in r));

  // non-shortener links are never fetched
  const log4 = [];
  await L.check('https://example.com/', deps({ request: mkRequest({}, log4) }));
  assert.deepStrictEqual(log4, []);
});

test('counters: by verdict per day, no URLs', () => {
  let d = new Date('2026-10-09T12:00:00Z');
  const c = L.createCounters(() => d);
  c.bump('safe'); c.bump('safe'); c.bump('danger');
  assert.deepStrictEqual(c.snapshot(), { day: '2026-10-09', counts: { safe: 2, caution: 0, danger: 1, unknown: 0, refused: 0, bad: 0 } });
  d = new Date('2026-10-10T00:00:01Z'); c.bump('caution');
  assert.strictEqual(c.snapshot().counts.safe, 0);
});

// ---- API ----
function serve(opts) {
  const app = express();
  app.all('/api/safe-link', L.safeLinkRoute(opts));
  return new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
}
async function call(s, { method = 'POST', origin, body, headers = {} } = {}) {
  const h = Object.assign({}, headers);
  if (origin) h.Origin = origin;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch('http://127.0.0.1:' + s.address().port + '/api/safe-link', { method, headers: h, body: typeof body === 'string' ? body : body && JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, h: r.headers, j };
}

test('API: CORS allow/deny, preflight, method, bad input, size, SSRF, rate limit', async (t) => {
  const s = await serve({ key: 'K', fetch: mkFetch(), lookup: mkLookup(), trustProxy: false });
  t.after(() => s.close());
  let r = await call(s, { origin: 'https://afirstflag.com', body: { url: 'paypal.com' } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.j.verdict, 'safe');
  assert.strictEqual(r.h.get('access-control-allow-origin'), 'https://afirstflag.com');
  assert.strictEqual(r.h.get('access-control-allow-credentials'), null);
  assert.strictEqual(r.h.get('cache-control'), 'no-store');
  r = await call(s, { method: 'OPTIONS', origin: 'https://www.afirstflag.com' });
  assert.strictEqual(r.status, 204); assert.strictEqual(r.h.get('access-control-allow-methods'), 'POST');
  assert.strictEqual(r.h.get('access-control-allow-headers'), 'Content-Type');
  r = await call(s, { method: 'OPTIONS', origin: 'https://evil.example' });
  assert.strictEqual(r.status, 204); assert.strictEqual(r.h.get('access-control-allow-origin'), null);
  r = await call(s, { origin: 'https://evil.example', body: { url: 'paypal.com' } });
  assert.strictEqual(r.status, 403); assert.strictEqual(r.h.get('access-control-allow-origin'), null);
  r = await call(s, { origin: 'http://localhost:8765', body: { url: 'paypal.com' } });
  assert.strictEqual(r.status, 403);
  r = await call(s, { method: 'GET' }); assert.strictEqual(r.status, 405);
  r = await call(s, { body: '{bad json' }); assert.strictEqual(r.status, 400); assert.strictEqual(r.j.error, 'bad_input');
  r = await call(s, { body: { url: 'x'.repeat(3000) } }); assert.strictEqual(r.status, 413);
  r = await call(s, { body: { nope: 1 } }); assert.strictEqual(r.status, 400);
  r = await call(s, { body: { url: 'javascript:alert(1)' } }); assert.strictEqual(r.status, 400);
  r = await call(s, { body: { url: 'http://127.0.0.1' } }); assert.strictEqual(r.status, 400); assert.strictEqual(r.j.error, 'refused');
  // 6 counted so far (403/405/OPTIONS are not); 4 more pass, the 11th is limited
  for (let i = 0; i < 4; i++) { r = await call(s, { body: { url: "http://169.254.169.254" } }); assert.strictEqual(r.status, 400); }
  r = await call(s, { body: { url: 'http://169.254.169.254' } }); assert.strictEqual(r.status, 429);
  assert.ok(Number(r.h.get('retry-after')) >= 1);
});

test('API: SSRF via DNS, lookalikes, short link, Google down', async (t) => {
  const lookup = mkLookup({ 'internal.example': '192.168.0.10' });
  const request = mkRequest({ 'https://rb.gy/q': { status: 301, location: 'https://appleid.apple.com.verify-account.top/' } });
  const s = await serve({ key: 'K', fetch: mkFetch(), lookup, request, limiter: { hit: () => ({ ok: true }) } });
  t.after(() => s.close());
  let r = await call(s, { body: { url: 'http://internal.example/' } }); assert.strictEqual(r.j.error, 'refused');
  r = await call(s, { body: { url: 'http://169.254.169.254' } }); assert.strictEqual(r.j.error, 'refused');
  for (const u of ['amaz0n-support.com', 'paypal-secure-login.xyz', 'appleid.apple.com.verify-account.top']) {
    r = await call(s, { body: { url: u } }); assert.strictEqual(r.j.verdict, 'caution', u);
  }
  r = await call(s, { body: { url: 'https://www.paypal.com' } }); assert.strictEqual(r.j.verdict, 'safe');
  r = await call(s, { body: { url: 'rb.gy/q' } });
  assert.strictEqual(r.j.verdict, 'caution'); assert.strictEqual(r.j.finalUrl, 'https://appleid.apple.com.verify-account.top/');
  assert.deepStrictEqual(Object.keys(r.j).sort(), ['finalUrl', 'host', 'reasons', 'verdict']);
});

test('rate key: X-Forwarded-For only with TRUST_PROXY and a loopback peer', () => {
  const req = (peer, xf) => ({ socket: { remoteAddress: peer }, headers: xf ? { 'x-forwarded-for': xf } : {} });
  assert.strictEqual(L.rateKey(req('127.0.0.1', '1.1.1.1, 2.2.2.2'), true), '2.2.2.2');
  assert.strictEqual(L.rateKey(req('127.0.0.1', '1.1.1.1'), false), '127.0.0.1');
  assert.strictEqual(L.rateKey(req('5.5.5.5', '1.1.1.1'), true), '5.5.5.5');
});

test('never logs: the route writes nothing to the console', async (t) => {
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const seen = [];
  for (const k of Object.keys(orig)) console[k] = (...a) => seen.push(a.join(' '));
  t.after(() => Object.assign(console, orig));
  const s = await serve({ key: 'K', fetch: mkFetch([], { fail: true }), lookup: mkLookup() });
  await call(s, { body: { url: 'https://secret-path.example/abc' } });
  s.close();
  assert.deepStrictEqual(seen, []);
});
