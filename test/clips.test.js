// CHG-134: tests for lib/clips.js (ids, server-side lines only, caps, rate limits, votes, permissions, escaping, PNG, OG, delete/hide).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const C = require('../lib/clips');
const { createRateLimiter } = require('../lib/serverStats');

const ADMIN = 'b'.repeat(40);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clips-'));
// fake sessions: header X-Clip-Session 'm-<name>' = member, 'g-<name>' = guest
function whoami(req) {
  const t = req.get('x-clip-session') || '';
  const m = /^([mg])-(.+)$/.exec(t); if (!m) return null;
  return { name: m[2], member: m[1] === 'm', key: m[1] + ':' + m[2].toLowerCase() };
}
function setup(o = {}) {
  const dir = tmp();
  const buffer = C.createRecentBuffer();
  const store = C.createClipStore({ file: path.join(dir, 'clips.json'), cap: o.cap });
  const events = [];
  let ctx = o.ctx || { kind: 'room', title: 'Milliway' };
  const app = express();
  app.use(C.clipsRouter(Object.assign({ store, buffer, whoami, getContext: () => ctx, imgDir: path.join(dir, 'img'), trustProxy: false,
    adminToken: () => ADMIN, membersOnly: () => !!o.membersOnly, onSaved: (c) => events.push(['new', c.id]), onVote: (id, v) => events.push(['vote', id, v]) }, o.route || {})));
  return new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res({ s, buffer, store, events, dir, setCtx: (c) => { ctx = c; }, base: 'http://127.0.0.1:' + s.address().port })); });
}
const req = (env, method, p, { who, body, auth } = {}) => fetch(env.base + p, { method, headers: Object.assign({}, who ? { 'X-Clip-Session': who } : {}, body ? { 'Content-Type': 'application/json' } : {}, auth ? { Authorization: auth } : {}), body: body ? JSON.stringify(body) : undefined });
const fill = (b, n, user = 'Patron') => { const out = []; for (let i = 1; i <= n; i++) out.push(b.add(user + i, 'line ' + i)); return out; };

test('id gen: 8 url-safe chars, unique', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) { const id = C.newId(); assert.match(id, /^[A-Za-z0-9_-]{8}$/); seen.add(id); }
  assert.strictEqual(seen.size, 2000);
});

test('recent buffer: 30 s window, cap 25, contiguous ranges only', () => {
  let t = 0; const b = C.createRecentBuffer({ now: () => t });
  b.add('Old', 'gone soon'); t = 31000; fill(b, 30);
  const r = b.recent(); assert.strictEqual(r.length, 25); assert.ok(r.every((l) => l.user !== 'Old'));
  assert.strictEqual(b.range(r[0].id, r[24].id).length, 25);
  assert.strictEqual(b.range(r[0].id - 1, r[24].id), null);       // 26 lines
  assert.strictEqual(b.range(5, 4), null); assert.strictEqual(b.range('1', 2), null); assert.strictEqual(b.range(1000, 1001), null);
  t += 6 * 60000; b.add('x', 'y'); assert.strictEqual(b.range(2, 3), null); // expired after 5 min
});

test('caption sanitizing', () => {
  assert.deepStrictEqual(C.sanitizeCaption('  the room\nlost it \u202e😂 '), { ok: true, caption: 'the room lost it 😂' });
  assert.deepStrictEqual(C.sanitizeCaption(undefined), { ok: true, caption: '' });
  assert.strictEqual(C.sanitizeCaption('x'.repeat(81)).ok, false);
  assert.strictEqual(C.sanitizeCaption('😂'.repeat(80)).ok, true);
  assert.strictEqual(C.sanitizeCaption({}).ok, false);
});

test('context: room / tailgate / golive (allow on only)', () => {
  assert.strictEqual(C.computeContext({}).kind, 'room');
  const tg = C.computeContext({ tailgate: { mode: 'tailgate', embedId: 'v7endym' }, tgStartedAt: 1000, now: 61000 });
  assert.deepStrictEqual(tg, { kind: 'tailgate', title: 'Nick Fuentes live on Rumble', embedId: 'v7endym', url: 'https://rumble.com/embed/v7endym/', offsetSec: 60 });
  assert.strictEqual(C.computeContext({ broadcasters: [{ username: 'Bob', allowClips: false }], tailgate: { mode: 'tailgate', embedId: 'v7endym' } }).kind, 'room');
  assert.deepStrictEqual(C.computeContext({ broadcasters: [{ username: 'Bob', allowClips: true }] }), { kind: 'golive', broadcaster: 'Bob', title: 'Bob live in Milliway' });
});

test('save: guest + member can clip; server copies its own lines; client text ignored', async () => {
  const e = await setup(); const ls = fill(e.buffer, 5);
  let r = await req(e, 'POST', '/api/clips', { who: 'g-Guest-User 1234', body: { fromId: ls[1].id, toId: ls[3].id, caption: 'hi', lines: [{ user: 'Fake', text: 'invented' }] } });
  assert.strictEqual(r.status, 201); const j = await r.json();
  assert.match(j.id, C.ID_RE); assert.strictEqual(j.url, 'https://chat.afirstflag.com/c/' + j.id);
  assert.deepStrictEqual(j.clip.lines.map((l) => l.user + ':' + l.text), ['Patron2:line 2', 'Patron3:line 3', 'Patron4:line 4']);
  assert.strictEqual(j.clip.clipper, 'Guest-User 1234');
  assert.deepStrictEqual(e.events[0], ['new', j.id]);
  r = await req(e, 'POST', '/api/clips', { who: 'm-Andy', body: { fromId: 1, toId: 999 } }); assert.strictEqual(r.status, 400);
  r = await req(e, 'POST', '/api/clips', { who: 'm-Andy', body: { fromId: 1, toId: 1, caption: 'x'.repeat(90) } }); assert.strictEqual(r.status, 400);
  r = await req(e, 'POST', '/api/clips', { body: { fromId: 1, toId: 1 } }); assert.strictEqual(r.status, 401);
  r = await fetch(e.base + '/api/clips', { method: 'POST', headers: { 'X-Clip-Session': 'm-Andy', 'Content-Type': 'application/json' }, body: '{nope' }); assert.strictEqual(r.status, 400);
  const st = fs.statSync(path.join(e.dir, 'clips.json')); assert.strictEqual(st.mode & 0o777, 0o600);
  e.s.close();
});

test('members-only setting: guests 403, members ok', async () => {
  const e = await setup({ membersOnly: true }); fill(e.buffer, 2);
  assert.strictEqual((await req(e, 'POST', '/api/clips', { who: 'g-Guest-User 1', body: { fromId: 1, toId: 2 } })).status, 403);
  assert.strictEqual((await req(e, 'POST', '/api/clips', { who: 'm-Andy', body: { fromId: 1, toId: 2 } })).status, 201);
  assert.strictEqual((await req(e, 'GET', '/api/clips/recent', { who: 'g-Guest-User 1' })).status, 200); // reading still fine
  e.s.close();
});

test('rate limits: per clipper 5/10 min and per IP 3/min', async () => {
  let e = await setup({ route: { ipLimiter: createRateLimiter({ limit: 100, windowMs: 60000 }) } }); fill(e.buffer, 2);
  for (let i = 0; i < 5; i++) assert.strictEqual((await req(e, 'POST', '/api/clips', { who: 'm-Andy', body: { fromId: 1, toId: 1 } })).status, 201);
  const r = await req(e, 'POST', '/api/clips', { who: 'm-Andy', body: { fromId: 1, toId: 1 } });
  assert.strictEqual(r.status, 429); assert.ok(+r.headers.get('retry-after') > 0);
  assert.strictEqual((await req(e, 'POST', '/api/clips', { who: 'm-Bob', body: { fromId: 1, toId: 1 } })).status, 201);
  e.s.close();
  e = await setup(); fill(e.buffer, 2);
  for (const u of ['a', 'b', 'c']) assert.strictEqual((await req(e, 'POST', '/api/clips', { who: 'g-' + u, body: { fromId: 1, toId: 1 } })).status, 201);
  assert.strictEqual((await req(e, 'POST', '/api/clips', { who: 'g-d', body: { fromId: 1, toId: 1 } })).status, 429);
  e.s.close();
});

test('store cap drops oldest unvoted first; persists', () => {
  const dir = tmp(); const f = path.join(dir, 'clips.json');
  const st = C.createClipStore({ file: f, cap: 3 });
  const a = st.add({ clipper: 'A', lines: [] }); st.vote(a.id, 'm:x');
  const b = st.add({ clipper: 'B', lines: [] }); st.add({ clipper: 'C', lines: [] }); st.add({ clipper: 'D', lines: [] });
  assert.strictEqual(st.size(), 3); assert.ok(st.get(a.id)); assert.strictEqual(st.get(b.id), null);
  assert.strictEqual(C.createClipStore({ file: f }).size(), 3);
  fs.writeFileSync(f, '{bad'); assert.strictEqual(C.createClipStore({ file: f }).size(), 0);
});

test('vote toggle: one per user', async () => {
  const e = await setup(); fill(e.buffer, 1);
  const { id } = await (await req(e, 'POST', '/api/clips', { who: 'm-Andy', body: { fromId: 1, toId: 1 } })).json();
  const v = async (w) => (await req(e, 'POST', '/api/clips/' + id + '/vote', { who: w })).json();
  assert.deepStrictEqual(await v('m-Bob'), { votes: 1, voted: true });
  assert.deepStrictEqual(await v('m-Cat'), { votes: 2, voted: true });
  assert.deepStrictEqual(await v('m-Bob'), { votes: 1, voted: false });
  assert.strictEqual((await req(e, 'POST', '/api/clips/nope1234/vote', { who: 'm-Bob' })).status, 404);
  assert.strictEqual((await req(e, 'POST', '/api/clips/' + id + '/vote')).status, 401);
  e.s.close();
});

test('delete: own clip only; admin hide/unhide/delete; admin 404 when token unset', async () => {
  const e = await setup(); fill(e.buffer, 1);
  const { id } = await (await req(e, 'POST', '/api/clips', { who: 'm-Andy', body: { fromId: 1, toId: 1 } })).json();
  assert.strictEqual((await req(e, 'DELETE', '/api/clips/' + id, { who: 'm-Bob' })).status, 403);
  assert.strictEqual((await req(e, 'DELETE', '/api/clips/' + id, { auth: 'Bearer wrong-wrong-wrong-wrong' })).status, 401);
  assert.strictEqual((await req(e, 'DELETE', '/api/clips/' + id + '?hide=1', { auth: 'Bearer ' + ADMIN })).status, 200);
  assert.strictEqual((await fetch(e.base + '/c/' + id)).status, 404);
  assert.strictEqual((await fetch(e.base + '/c/' + id + '.png')).status, 404);
  await req(e, 'DELETE', '/api/clips/' + id + '?hide=0', { auth: 'Bearer ' + ADMIN });
  assert.strictEqual((await fetch(e.base + '/c/' + id)).status, 200);
  assert.strictEqual((await req(e, 'DELETE', '/api/clips/' + id, { who: 'm-andy' })).status, 200);   // same member key
  assert.strictEqual((await fetch(e.base + '/c/' + id)).status, 404);
  e.s.close();
  const e2 = await setup({ route: { adminToken: () => '' } });
  assert.strictEqual((await req(e2, 'DELETE', '/api/clips/abcdefgh', { auth: 'Bearer ' + ADMIN })).status, 404);
  e2.s.close();
});

test('broadcaster strip: removes stream identity, keeps clip', () => {
  const st = C.createClipStore();
  const c = st.add({ clipper: 'A', context: { kind: 'golive', broadcaster: 'Bob', title: 'Bob live in Milliway' }, lines: [] });
  st.add({ clipper: 'A', context: { kind: 'golive', broadcaster: 'Cat', title: 'x' }, lines: [] });
  assert.strictEqual(st.stripBroadcaster('Bob'), 1);
  assert.deepStrictEqual(st.get(c.id).context, { kind: 'room', title: 'Milliway' });
});

test('clip page escapes caption and messages; OG/Twitter tags; CSP; 404 page', async () => {
  const e = await setup({ ctx: { kind: 'tailgate', title: 'Nick Fuentes live on Rumble', embedId: 'v7endym', url: 'https://rumble.com/embed/v7endym/', offsetSec: 90 } });
  e.buffer.add('<img src=x onerror=alert(1)>', '"><script>alert(2)</script>');
  const { id } = await (await req(e, 'POST', '/api/clips', { who: 'm-Andy', body: { fromId: 1, toId: 1, caption: '</title><script>alert(3)</script>' } })).json();
  const r = await fetch(e.base + '/c/' + id); const h = await r.text();
  assert.strictEqual(r.status, 200);
  assert.ok(!/<script/i.test(h)); assert.ok(!/<img/i.test(h));
  assert.ok(h.includes('&lt;script&gt;alert(2)')); assert.ok(h.includes('&lt;/title&gt;&lt;script&gt;alert(3)'));
  assert.match(h, /<meta name="twitter:card" content="summary_large_image">/);
  assert.ok(h.includes('<meta property="og:image" content="https://chat.afirstflag.com/c/' + id + '.png">'));
  assert.ok(h.includes('og:title') && h.includes('og:url'));
  assert.ok(h.includes('https://rumble.com/embed/v7endym/?start=90'));
  assert.ok(h.includes('Join the room'));
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  const n = await fetch(e.base + '/c/zzzzzzzz'); assert.strictEqual(n.status, 404); assert.match(await n.text(), /Clip not found/);
  assert.strictEqual((await fetch(e.base + '/c/..%2F..%2Fetc')).status, 404);
  e.s.close();
});

test('PNG card: valid 1200x630, cached on disk, invalidated when hidden flips', async () => {
  const e = await setup(); e.buffer.add('Patron1', 'no way 😂😂'); e.buffer.add('Patron2', 'HAHA');
  const { id } = await (await req(e, 'POST', '/api/clips', { who: 'm-Andy', body: { fromId: 1, toId: 2, caption: 'the room lost it 😂' } })).json();
  const r = await fetch(e.base + '/c/' + id + '.png');
  assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.strictEqual(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.strictEqual(buf.readUInt32BE(16), 1200); assert.strictEqual(buf.readUInt32BE(20), 630);
  const files = fs.readdirSync(path.join(e.dir, 'img')); assert.strictEqual(files.length, 1); assert.ok(files[0].startsWith(id + '-'));
  await req(e, 'DELETE', '/api/clips/' + id + '?hide=1', { auth: 'Bearer ' + ADMIN });
  assert.strictEqual(fs.readdirSync(path.join(e.dir, 'img')).length, 0);
  e.s.close();
});

test('pngSafe strips emoji, keeps text', () => {
  assert.strictEqual(C.pngSafe('the room lost it 😂👍🏽 🇺🇸 ❤️'), 'the room lost it');
  assert.ok(!C.cardSvg({ id: 'abcdefgh', clipper: '<b>', caption: '&', lines: [{ user: '"', text: '<x>' }], context: { kind: 'room' } }).includes('<x>'));
});

// ---- CHG-135: share card keeps text out of the bottom-left (X's caption bar) + layout version in the cache key ----
function cardPixels(c) {
  const { Resvg } = require('@resvg/resvg-js');
  const FD = path.join(__dirname, '..', 'assets', 'fonts');
  const r = new Resvg(C.cardSvg(c), { fitTo: { mode: 'width', value: 1200 }, font: { fontFiles: [path.join(FD, 'DejaVuSans.ttf'), path.join(FD, 'DejaVuSans-Bold.ttf')], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' } }).render();
  return { w: r.width, h: r.height, px: r.pixels };
}
function bottomLeftBlank(c) { // X zone: x < 60 % of width, y >= 85 % of height; must be one flat colour (no glyphs)
  const { w, h, px } = cardPixels(c);
  const y0 = Math.floor(h * 0.85); const x1 = Math.floor(w * 0.6);
  const ref = [px[(y0 * w) * 4], px[(y0 * w) * 4 + 1], px[(y0 * w) * 4 + 2]];
  for (let y = y0; y < h; y++) for (let x = 0; x < x1; x++) { const i = (y * w + x) * 4; if (px[i] !== ref[0] || px[i + 1] !== ref[1] || px[i + 2] !== ref[2]) return false; }
  return true;
}
test('CHG-135: card has no text in the bottom-left (even with long names/captions/stream titles); brand is at the top, clipped-by bottom-right', () => {
  const lines = [1, 2, 3, 4, 5, 6].map((n) => ({ user: 'WWWWWWWWWWWWWWWWWWWW', text: 'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM ' + n, t: 0 }));
  const cases = [
    { id: 'aaaaaaaa', clipper: 'Guest-User 6281', caption: '', context: { kind: 'room', title: 'Milliway' }, lines: [{ user: 'Neagle', text: 'hi', t: 0 }] },
    { id: 'bbbbbbbb', clipper: 'W'.repeat(60), caption: 'Q'.repeat(80), context: { kind: 'golive', title: 'M'.repeat(80), broadcaster: 'Bob' }, lines },
    { id: 'cccccccc', clipper: 'W'.repeat(60), caption: 'a b c d e f g h i j k l m n o p', context: { kind: 'tailgate', title: 'Tailgate Party' }, lines },
  ];
  for (const c of cases) assert.ok(bottomLeftBlank(c), 'text in bottom-left for ' + c.id);
  const svg = C.cardSvg(cases[0]);
  assert.ok(!/<text x="30"/.test(svg), 'old footer text at x=30 is gone');
  assert.match(svg, /<text x="1170" y="\d+" text-anchor="end"[^>]*>chat\.afirstflag\.com<\/text>/); // brand, top-right
  assert.match(svg, /<text x="1170" y="600" text-anchor="end"[^>]*>clipped by Guest-User 6281<\/text>/);
  const m = />(clipped by [^<]*)</.exec(C.cardSvg(cases[1]));
  assert.ok(m && [...m[1]].length <= 40);
  const { w, h } = cardPixels(cases[0]); assert.deepStrictEqual([w, h], [1200, 630]);
  const png = C.renderPng(cases[0]); assert.strictEqual(png.readUInt32BE(16), 1200); assert.strictEqual(png.readUInt32BE(20), 630);
});

test('CHG-135: card layout version is in the cache key, so PNGs cached by the old layout regenerate', () => {
  const crypto = require('crypto');
  const c = { id: 'dddddddd', clipper: 'Guest-User 6281', caption: 'x', hidden: false, context: { kind: 'room', title: 'Milliway' }, lines: [{ user: 'Neagle', text: 'hi', t: 0 }] };
  const legacy = crypto.createHash('sha1').update(JSON.stringify([c.caption, c.hidden, c.context, c.lines, c.clipper])).digest('hex').slice(0, 10); // CHG-134 key
  assert.ok(C.CARD_LAYOUT >= 2);
  assert.notStrictEqual(C.cardVersion(c), legacy);
  const dir = tmp(); fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, c.id + '-' + legacy + '.png'); fs.writeFileSync(stale, 'STALE-OLD-LAYOUT');
  const cache = C.createPngCache(dir);
  const png = cache.get(c);
  assert.strictEqual(png.slice(0, 8).toString('hex'), '89504e470d0a1a0a'); // fresh PNG, not the stale bytes
  assert.ok(!fs.existsSync(stale), 'stale file removed');
  assert.deepStrictEqual(fs.readdirSync(dir), [c.id + '-' + C.cardVersion(c) + '.png']);
  assert.strictEqual(cache.get(c).equals(png), true); // second call is a cache hit with identical bytes
});
