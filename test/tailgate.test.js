// CHG-133: tests for lib/tailgate.js (state logic, auth, validation, persistence, detector parsing). No network beyond 127.0.0.1.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const T = require('../lib/tailgate');

const TOKEN = 'a'.repeat(64);
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-')), 'tailgate.json');
function serve(state, opts = {}) {
  const app = express();
  app.all('/api/tailgate', T.tailgateRoute(state, Object.assign({ trustProxy: false, token: TOKEN }, opts)));
  return new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
}
const url = (s) => 'http://127.0.0.1:' + s.address().port + '/api/tailgate';
const post = (s, body, auth = 'Bearer ' + TOKEN) => fetch(url(s), { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth ? { Authorization: auth } : {}), body: typeof body === 'string' ? body : JSON.stringify(body) });

test('default is auto + normal', () => {
  assert.deepStrictEqual(T.createTailgateState().get(), { mode: 'normal', override: 'auto', live: false, embedId: null });
});

test('auto follows detector; stale after 10 min without confirmation; failures keep last state', () => {
  let t = 0; const st = T.createTailgateState({ now: () => t });
  assert.strictEqual(st.report({ live: true, embedId: 'v7endym' }).mode, 'tailgate');
  t += 5 * 60000; assert.strictEqual(st.report(null).mode, 'tailgate');           // failed check: keep
  t += 5 * 60000 + 1; assert.strictEqual(st.tick().mode, 'normal');              // >10 min since confirmation
  assert.strictEqual(st.report({ live: true, embedId: 'v7endym' }).mode, 'tailgate');
  assert.strictEqual(st.report({ live: false }).mode, 'normal');
  assert.strictEqual(st.report({ live: true, embedId: 'bad id!' }).mode, 'normal'); // invalid id never used
});

test('on / off override beat the detector; on without any embed id stays normal', () => {
  const st = T.createTailgateState();
  st.report({ live: true, embedId: 'v7endym' });
  assert.strictEqual(st.setOverride('off').mode, 'normal');
  assert.deepStrictEqual(st.setOverride('on').embedId, 'v7endym');
  assert.deepStrictEqual(st.setOverride('on', 'abc123').embedId, 'abc123');
  st.report({ live: false });
  assert.strictEqual(st.setOverride('on').mode, 'normal');
  assert.strictEqual(st.setOverride('on', 'abc123').mode, 'tailgate');
  assert.throws(() => st.setOverride('maybe'));
});

test('onChange fires only on real changes', () => {
  const st = T.createTailgateState(); const seen = [];
  st.onChange((s) => seen.push(s.mode));
  st.report({ live: false }); st.report({ live: true, embedId: 'x1y2z3' }); st.report({ live: true, embedId: 'x1y2z3' }); st.setOverride('off');
  assert.deepStrictEqual(seen, ['tailgate', 'normal']);
});

test('override persists across restarts; corrupt file -> defaults', () => {
  const f = tmpFile();
  T.createTailgateState({ file: f }).setOverride('on', 'v7endym');
  const again = T.createTailgateState({ file: f }).get();
  assert.deepStrictEqual(again, { mode: 'tailgate', override: 'on', live: false, embedId: 'v7endym' });
  assert.ok(!/token/i.test(fs.readFileSync(f, 'utf8')));
  fs.writeFileSync(f, '{nope'); assert.strictEqual(T.createTailgateState({ file: f }).get().override, 'auto');
  fs.writeFileSync(f, JSON.stringify({ override: 'evil', embedId: '"><script>' }));
  assert.deepStrictEqual(T.createTailgateState({ file: f }).get(), { mode: 'normal', override: 'auto', live: false, embedId: null });
});

test('embed validation', () => {
  assert.strictEqual(T.parseEmbed('v7endym'), 'v7endym');
  assert.strictEqual(T.parseEmbed('https://rumble.com/embed/v7endym/'), 'v7endym');
  assert.strictEqual(T.parseEmbed('https://rumble.com/embed/v7endym/?pub=4'), 'v7endym');
  for (const bad of ['http://rumble.com/embed/v7endym/', 'https://evil.com/embed/v7endym/', 'https://rumble.com.evil.com/embed/abc/', 'v7-endym', 'javascript:alert(1)', '"><img>', '', 'a'.repeat(40), 5, null])
    assert.strictEqual(T.parseEmbed(bad), null, String(bad));
  assert.strictEqual(T.embedSrc('v7endym'), 'https://rumble.com/embed/v7endym/');
  assert.strictEqual(T.embedSrc('../x'), null);
});

test('token compare', () => {
  assert.ok(T.tokenOk('Bearer ' + TOKEN, TOKEN));
  assert.ok(!T.tokenOk('Bearer ' + TOKEN + 'x', TOKEN));
  assert.ok(!T.tokenOk(TOKEN, TOKEN));
  assert.ok(!T.tokenOk(undefined, TOKEN));
  assert.ok(!T.tokenOk('Bearer short', 'short'));   // secret under 16 chars never accepted
});

test('HTTP: GET public state, POST 401s, 404 when token unset, validation, success', async () => {
  const st = T.createTailgateState({ file: tmpFile() });
  const s = await serve(st);
  const g = await fetch(url(s)); const gt = await g.text();
  assert.strictEqual(g.status, 200);
  assert.deepStrictEqual(Object.keys(JSON.parse(gt)).sort(), ['embedId', 'live', 'mode', 'override']);
  assert.ok(!gt.includes(TOKEN));
  assert.strictEqual((await post(s, { mode: 'on' }, null)).status, 401);
  assert.strictEqual((await post(s, { mode: 'on' }, 'Bearer wrong')).status, 401);
  assert.strictEqual((await post(s, { mode: 'on' }, 'Basic ' + TOKEN)).status, 401);
  assert.strictEqual(st.get().override, 'auto');
  assert.strictEqual((await post(s, { mode: 'party' })).status, 400);
  assert.strictEqual((await post(s, '{bad')).status, 400);
  assert.strictEqual((await post(s, { mode: 'on', embedId: '"><script>' })).status, 400);
  assert.strictEqual((await post(s, { mode: 'on', embedUrl: 'https://evil.com/embed/abc/' })).status, 400);
  assert.strictEqual((await post(s, { mode: 'off', embedId: 'abc123' })).status, 400);
  const ok = await post(s, { mode: 'on', embedUrl: 'https://rumble.com/embed/v7endym/' });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(await ok.json(), { mode: 'tailgate', override: 'on', live: false, embedId: 'v7endym' });
  assert.strictEqual((await (await post(s, { mode: 'auto' })).json()).mode, 'normal');
  assert.strictEqual((await fetch(url(s), { method: 'PUT' })).status, 405);
  s.close();
  for (const tok of [undefined, '', 'short']) {
    const s2 = await serve(T.createTailgateState(), { token: tok });
    assert.strictEqual((await post(s2, { mode: 'on' })).status, 404);
    assert.strictEqual((await fetch(url(s2))).status, 200);
    s2.close();
  }
});

test('HTTP: rate limits (GET 30/min, POST 10/min incl. bad tokens)', async () => {
  const s = await serve(T.createTailgateState());
  for (let i = 0; i < 10; i++) assert.strictEqual((await post(s, { mode: 'auto' }, 'Bearer nope')).status, 401);
  const r = await post(s, { mode: 'auto' });
  assert.strictEqual(r.status, 429); assert.ok(r.headers.get('retry-after'));
  for (let i = 0; i < 30; i++) assert.strictEqual((await fetch(url(s))).status, 200);
  assert.strictEqual((await fetch(url(s))).status, 429);
  s.close();
});

const vid = (o) => '{"object_type":"video","videos":[{"url":"https://rumble.com/hls-vod/x/playlist.m3u8"}],"url":"https://rumble.com/' + o.id + '-ep.html","by":{"type":"channel","url":"' + (o.ch || 'https://rumble.com/c/nickjfuentes') + '","title":"X"},"live":' + o.live + ',"live_placeholder":' + (o.ph || false) + ',"permalink_id":"' + o.id + '"}';
test('findLiveVideo: only this channel, only live, not placeholders', () => {
  assert.strictEqual(T.findLiveVideo('<html>' + vid({ id: 'v1aa', live: false }) + ',' + vid({ id: 'v2bb', live: true, ch: 'https://rumble.com/c/other' })), null);
  assert.strictEqual(T.findLiveVideo(vid({ id: 'v3cc', live: true, ph: true })), null);
  assert.strictEqual(T.findLiveVideo(vid({ id: 'v1aa', live: false }) + ',' + vid({ id: 'v4dd', live: true })), 'https://rumble.com/v4dd-ep.html');
});

test('rumbleDetector with mocked fetch: live -> oEmbed embed id; format change throws', async () => {
  const calls = [];
  const fake = (page) => async (u, o) => {
    calls.push([u, o.headers['User-Agent']]);
    if (u.includes('oembed')) return { ok: true, text: async () => JSON.stringify({ html: '<iframe src="https://rumble.com/embed/v7endym/" ></iframe>' }) };
    return { ok: true, text: async () => page };
  };
  assert.deepStrictEqual(await T.rumbleDetector({ fetch: fake(vid({ id: 'v4dd', live: true })) })(), { live: true, embedId: 'v7endym' });
  assert.ok(calls[1][0].startsWith('https://rumble.com/api/Media/oembed.json?url=https%3A%2F%2Frumble.com%2Fv4dd'));
  assert.match(calls[0][1], /EaglesNest/);
  assert.deepStrictEqual(await T.rumbleDetector({ fetch: fake(vid({ id: 'v1', live: false })) })(), { live: false });
  await assert.rejects(T.rumbleDetector({ fetch: fake('<html>captcha</html>') })(), /page_format_changed/);
  await assert.rejects(T.rumbleDetector({ fetch: async () => ({ ok: false, status: 503 }) })(), /http_503/);
});
