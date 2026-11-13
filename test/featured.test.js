// CHG-171: Featured on Rumble card (static list, cache, poll-off, HTTP, parser reuse). No network beyond 127.0.0.1.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const F = require('../lib/featured');
const T = require('../lib/tailgate');

const vid = (o) => '{"object_type":"video","videos":[{"url":"https://rumble.com/hls-vod/x/playlist.m3u8"}],"url":"https://rumble.com/' + o.id + '-ep.html","by":{"type":"channel","url":"' + (o.ch || 'https://rumble.com/c/nickjfuentes') + '","title":"X"},"live":' + o.live + ',"live_placeholder":' + (o.ph || false) + ',"permalink_id":"' + o.id + '"}';

function serve(api) {
  const app = express();
  app.all('/api/featured', api.handler);
  return new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
}
const url = (s) => 'http://127.0.0.1:' + s.address().port + '/api/featured';

test('CREATORS: four official verified channels and Rumble CDN avatars', () => {
  assert.strictEqual(F.CREATORS.length, 4);
  const ids = F.CREATORS.map((c) => c.id);
  assert.deepStrictEqual(ids, ['nickjfuentes', 'DrDisrespect', 'russellbrand', 'Asmongold']);
  assert.deepStrictEqual(F.CREATORS.map((c) => c.name), [
    'Nicholas J. Fuentes', 'Dr Disrespect', 'Russell Brand', 'Asmongold',
  ]);
  for (const c of F.CREATORS) {
    assert.ok(F.CHANNEL_RE.test(c.channel), c.channel);
    assert.ok(F.AVATAR_RE.test(c.avatar), c.avatar);
    assert.ok(c.avatar.startsWith('https://hugh.cdn.rumble.cloud/'));
  }
  assert.strictEqual(F.CREATORS[0].channel, 'https://rumble.com/c/nickjfuentes');
  assert.strictEqual(F.CREATORS[1].channel, 'https://rumble.com/c/DrDisrespect');
  assert.strictEqual(F.CREATORS[2].channel, 'https://rumble.com/c/russellbrand');
  assert.strictEqual(F.CREATORS[3].channel, 'https://rumble.com/c/Asmongold');
  assert.strictEqual(F.CREDIT.href, 'https://rumble.com/');
  assert.match(F.CREDIT.text, /courtesy of Rumble/);
});

test('snapshot with polling off is live:false, checkedAt null, no fetches', async () => {
  const calls = [];
  const api = F.createFeatured({
    poll: false,
    fetch: async (u) => { calls.push(u); throw new Error('must not fetch'); },
  });
  const s = api.snapshot();
  assert.strictEqual(s.polling, false);
  assert.strictEqual(s.checkedAt, null);
  assert.strictEqual(s.cacheSeconds, 120);
  assert.strictEqual(s.creators.length, 4);
  for (const c of s.creators) {
    assert.strictEqual(c.live, false);
    assert.ok(!('watchUrl' in c));
    assert.ok(c.channel.startsWith('https://rumble.com/c/'));
  }
  await api.refresh();
  api.maybeRefresh();
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(api.snapshot().checkedAt, null);
});

test('refresh uses findLiveVideo; live watchUrl only; channels checked in order; cache skips rerun', async () => {
  const pages = {
    'https://rumble.com/c/nickjfuentes': vid({ id: 'v1aa', live: false }),
    'https://rumble.com/c/DrDisrespect': vid({ id: 'v9zz', live: true, ch: 'https://rumble.com/c/DrDisrespect' }),
    'https://rumble.com/c/russellbrand': vid({ id: 'v2bb', live: true, ch: 'https://rumble.com/c/other' }),
    'https://rumble.com/c/Asmongold': vid({ id: 'v3cc', live: true, ph: true, ch: 'https://rumble.com/c/Asmongold' }),
  };
  const order = [];
  const fake = async (u) => {
    order.push(u);
    const page = pages[u];
    if (!page) throw new Error('unexpected ' + u);
    return { ok: true, text: async () => page };
  };
  let t = 1000;
  const api = F.createFeatured({ poll: true, fetch: fake, now: () => t, cacheMs: 120000, timeoutMs: 1000 });
  const s = await api.refresh();
  assert.deepStrictEqual(order, F.CREATORS.map((c) => c.channel));
  assert.ok(!order.some((u) => u.includes('oembed')), 'featured must not call oEmbed');
  const byId = Object.fromEntries(s.creators.map((c) => [c.id, c]));
  assert.strictEqual(byId.nickjfuentes.live, false);
  assert.strictEqual(byId.DrDisrespect.live, true);
  assert.strictEqual(byId.DrDisrespect.watchUrl, 'https://rumble.com/v9zz-ep.html');
  assert.strictEqual(byId.russellbrand.live, false); // different channel in the video "by" url
  assert.strictEqual(byId.Asmongold.live, false);    // live_placeholder
  assert.ok(s.checkedAt);
  const before = order.length;
  t += 30 * 1000;
  api.maybeRefresh();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(order.length, before, 'fresh cache must not refetch');
  t += 91 * 1000;
  const p = api.maybeRefresh();
  assert.ok(p);
  await p;
  assert.strictEqual(order.length, before + 4);
});

test('failed check keeps last known live flag; format change does not flip to false', async () => {
  let mode = 'live';
  const fake = async (u) => {
    if (mode === 'fail') return { ok: false, status: 503 };
    if (mode === 'captcha') return { ok: true, text: async () => '<html>captcha</html>' };
    const live = u.includes('DrDisrespect');
    const ch = u;
    return { ok: true, text: async () => vid({ id: live ? 'v9zz' : 'v1aa', live, ch }) };
  };
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const api = F.createFeatured({ poll: true, fetch: fake, cacheMs: 60000, timeoutMs: 1000 });
    let s = await api.refresh();
    assert.strictEqual(s.creators.find((c) => c.id === 'DrDisrespect').live, true);
    mode = 'fail';
    s = await api.refresh();
    assert.strictEqual(s.creators.find((c) => c.id === 'DrDisrespect').live, true);
    mode = 'captcha';
    s = await api.refresh();
    assert.strictEqual(s.creators.find((c) => c.id === 'DrDisrespect').live, true);
    assert.ok(warns.some((w) => /featured/.test(w)));
  } finally { console.warn = orig; }
});

test('reuses a fresh Tailgate live result for nickjfuentes and skips that fetch', async () => {
  const order = [];
  const fake = async (u) => {
    order.push(u);
    return { ok: true, text: async () => vid({ id: 'v1aa', live: false, ch: u }) };
  };
  const api = F.createFeatured({
    poll: true,
    fetch: fake,
    timeoutMs: 1000,
    getTailgate: () => ({ live: true, source: 'rumble', embedId: 'v7endym' }),
  });
  const s = await api.refresh();
  assert.strictEqual(s.creators[0].id, 'nickjfuentes');
  assert.strictEqual(s.creators[0].live, true);
  assert.ok(!order.includes('https://rumble.com/c/nickjfuentes'));
  assert.ok(order.includes('https://rumble.com/c/DrDisrespect'));
});

test('HTTP: GET shape, HEAD ok, POST 405, rate limit 30/min, poll-off does not touch Rumble', async () => {
  const calls = [];
  const api = F.createFeatured({
    poll: false,
    fetch: async (u) => { calls.push(u); throw new Error('no fetch'); },
  });
  const s = await serve(api);
  try {
    const g = await fetch(url(s));
    const gt = await g.text();
    assert.strictEqual(g.status, 200);
    assert.strictEqual(g.headers.get('cache-control'), 'no-store');
    const body = JSON.parse(gt);
    assert.deepStrictEqual(Object.keys(body).sort(), ['cacheSeconds', 'checkedAt', 'creators', 'credit', 'polling']);
    assert.strictEqual(body.polling, false);
    assert.strictEqual(body.credit.href, 'https://rumble.com/');
    assert.strictEqual(body.creators.length, 4);
    assert.ok(!/token|secret|TAILGATE/i.test(gt));
    const h = await fetch(url(s), { method: 'HEAD' });
    assert.strictEqual(h.status, 200);
    const p = await fetch(url(s), { method: 'POST' });
    assert.strictEqual(p.status, 405);
    assert.ok((p.headers.get('allow') || '').includes('GET'));
    for (let i = 0; i < 28; i++) assert.strictEqual((await fetch(url(s))).status, 200);
    assert.strictEqual((await fetch(url(s))).status, 429);
    assert.strictEqual(calls.length, 0);
  } finally { s.close(); }
});

test('cacheMs is clamped to 60–300 s; FEATURED_POLL=0 and FEATURED_CACHE_MS respected', () => {
  assert.strictEqual(F.clampCacheMs(1000), 60000);
  assert.strictEqual(F.clampCacheMs(120000), 120000);
  assert.strictEqual(F.clampCacheMs(9999999), 300000);
  assert.strictEqual(F.pollEnabledFromEnv({ FEATURED_POLL: '0' }), false);
  assert.strictEqual(F.pollEnabledFromEnv({}), true);
  assert.strictEqual(F.cacheMsFromEnv({ FEATURED_CACHE_MS: '90000' }), 90000);
  const api = F.createFeatured({ env: { FEATURED_POLL: '0', FEATURED_CACHE_MS: '90000' } });
  assert.strictEqual(api.pollEnabled(), false);
  assert.strictEqual(api.cacheMs(), 90000);
});

test('index.html has the Featured card, credit, official links, and no Tailgate POST', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="featuredCard"/);
  assert.match(html, /<h3>Featured<\/h3>/);
  assert.match(html, /Images and channels courtesy of/);
  assert.match(html, /href="https:\/\/rumble\.com\/"/);
  for (const c of F.CREATORS) {
    assert.ok(html.includes(c.channel), c.channel);
    assert.ok(html.includes(c.avatar), c.avatar);
    assert.ok(html.includes(c.name), c.name);
  }
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /\/api\/featured/);
  // Card must not change the shared Tailgate or call the admin POST
  const featStart = html.indexOf('id="featuredCard"');
  const featScript = html.slice(html.indexOf('applyFeatured') >= 0 ? html.indexOf('function applyFeatured') : featStart);
  const window = html.includes('function applyFeatured')
    ? html.slice(html.indexOf('function applyFeatured'), html.indexOf('function applyFeatured') + 2500)
    : html;
  assert.ok(!/\/api\/tailgate['"]/.test(window) || html.includes("fetch('/api/featured'"));
  assert.doesNotMatch(window, /method:\s*['"]POST['"][^\n]*tailgate/i);
  assert.doesNotMatch(html, /Watch in Tailgate/);
});

test('server.js mounts GET /api/featured and honors FEATURED_POLL', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /lib\/featured/);
  assert.match(src, /\/api\/featured/);
  assert.match(src, /FEATURED_POLL/);
  assert.doesNotMatch(src, /app\.(post|all)\(\s*['"]\/login/);
});
