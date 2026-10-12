// CHG-115: tests for lib/profile.js (GET /api/profile/:username), /u/:username in the real server.js, the profile
// page script and the chat 'My profile' link. No network beyond 127.0.0.1. Run: npm test.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const P = require('../lib/profile');
const { rateKey } = require('../lib/safeLink');

const ROOT = path.join(__dirname, '..');
const ANDY_EMAIL = 'andycremeans@yahoo.com'; // matches lib/username.js OWNER_EMAIL_SHA256.andy
function fixture() {
  return [
    { username: 'Andy', email: ANDY_EMAIL, createdAt: '2026-09-01T14:00:00.000Z', flagholder: true, tokenVersion: 3, rep: 'WV', verified: true },
    { username: 'Patriot_Pete', email: 'pete@example.com', createdAt: '2026-09-20T09:30:00.000Z', verified: true },
    { username: 'OldTimer', email: 'old@example.com' },                                   // no createdAt, /register path (no verified field)
    { username: 'BadDate', email: 'bd@example.com', createdAt: 'not a date' },
    { username: 'Pending Paul', email: 'pp@example.com', createdAt: '2026-10-11T00:00:00Z', verified: false, pendingCode: '123456', pendingUntil: 1 },
    { username: 'Twin-One', email: 't1@example.com', createdAt: '2026-09-02T00:00:00Z' }, // folds to 'twlnone'
    { username: 'twin one', email: 't2@example.com', createdAt: '2026-09-03T00:00:00Z' }, // same fold -> both hidden
    { username: 'bad<name>', email: 'x@example.com', createdAt: '2026-09-04T00:00:00Z' }, // legacy, fails CHG-051 today
    { username: 'Zero\u200bWidth', email: 'z@example.com', createdAt: '2026-09-05T00:00:00Z' },
    { username: 'ThisNameIsWayTooLongForTheRules', email: 'l@example.com', createdAt: '2026-09-06T00:00:00Z' },
    { username: 'Admin', email: 'a@example.com', createdAt: '2026-09-07T00:00:00Z' }      // reserved, not owner -> hidden
  ];
}

function serve(users, opts = {}) {
  const app = express();
  const route = P.profileRoute(() => users, Object.assign({ trustProxy: false }, opts));
  app.get('/api/profile/:username', route.handler);
  return new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res({ s, route })); });
}
async function get(s, name, headers = {}) {
  const r = await fetch('http://127.0.0.1:' + s.address().port + '/api/profile/' + name, { headers });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  return { status: r.status, h: r.headers, j, text };
}

test('1. known member: 200 with exactly username, tier, joined (no private fields)', async (t) => {
  const { s } = await serve(fixture()); t.after(() => s.close());
  const r = await get(s, 'Andy');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.j, { username: 'Andy', tier: 'Member', joined: '2026-09-01' });
  for (const bad of ['email', 'pendingCode', 'tokenVersion', 'flagholder', 'rep', 'verified', '@', 'yahoo']) assert.ok(!r.text.includes(bad), bad);
  assert.strictEqual(r.h.get('x-content-type-options'), 'nosniff');
});

test('2. missing or garbage createdAt: 200 without joined', async (t) => {
  const { s } = await serve(fixture()); t.after(() => s.close());
  assert.deepStrictEqual((await get(s, 'OldTimer')).j, { username: 'OldTimer', tier: 'Member' });
  assert.deepStrictEqual((await get(s, 'BadDate')).j, { username: 'BadDate', tier: 'Member' });
});

test('3. unknown, hidden and ambiguous names: identical plain 404', async (t) => {
  const { s } = await serve(fixture()); t.after(() => s.close());
  const a = await get(s, 'nobody-here');
  assert.strictEqual(a.status, 404); assert.strictEqual(a.text, '{"error":"not_found"}');
  for (const n of ['Andi', 'Pending%20Paul', 'Twin-One', 'Admin']) {
    const r = await get(s, n);
    assert.strictEqual(r.status, 404, n); assert.strictEqual(r.text, a.text, n);
  }
});

test('4. lookalikes resolve to the real account and return the stored name', async (t) => {
  const { s } = await serve(fixture()); t.after(() => s.close());
  for (const n of ['ANDY', 'andy', '\u0391ndy', '\u0410ndy', 'And\u0443', 'A.n-d_y', '\uff21\uff4e\uff44\uff59', 'and\u00fd', 'Patriot%20Pete', 'patriot-pete', 'PATRl0T_PETE']) {
    const r = await get(s, encodeURIComponent(decodeURIComponent(n)));
    assert.strictEqual(r.status, 200, n);
    assert.ok(r.j.username === 'Andy' || r.j.username === 'Patriot_Pete', n);
  }
});

test('5. two stored names that fold together: 404 for both spellings', async (t) => {
  const { s } = await serve(fixture()); t.after(() => s.close());
  assert.strictEqual((await get(s, 'Twin-One')).status, 404);
  assert.strictEqual((await get(s, encodeURIComponent('twin one'))).status, 404);
});

test('6. reserved keys with no matching visible account: 404', async (t) => {
  const { s } = await serve(fixture()); t.after(() => s.close());
  for (const n of ['neagle', 'admin', 'system', 'guest-user-1234', 'Guest-User%201234', 'server']) assert.strictEqual((await get(s, n)).status, 404, n);
});

test('7. unfinished sign-up hidden; /register record with no verified field shown', async (t) => {
  const { s } = await serve(fixture()); t.after(() => s.close());
  assert.strictEqual((await get(s, encodeURIComponent('Pending Paul'))).status, 404);
  assert.strictEqual((await get(s, 'OldTimer')).status, 200);
  assert.strictEqual(P.visible({ username: 'Someone', verified: true, pendingCode: 'x' }), false);
});

test('8. stored names that fail CHG-051 today: 404', async (t) => {
  const { s } = await serve(fixture()); t.after(() => s.close());
  for (const n of ['bad%3Cname%3E', 'badname', encodeURIComponent('Zero\u200bWidth'), 'ZeroWidth', 'ThisNameIsWayTooLongForTheRules'])
    assert.strictEqual((await get(s, n)).status, 404, n);
});

test('9. hostile paths: 404, no crash', async (t) => {
  const { s } = await serve(fixture()); t.after(() => s.close());
  for (const n of ['%3Cscript%3Ealert(1)%3C%2Fscript%3E', 'a'.repeat(2048), '%00', '..%2f..%2fetc%2fpasswd', '%F0%9F%A6%85'])
    assert.strictEqual((await get(s, n)).status, 404, n.slice(0, 30));
  // invisible format chars are folded away (CHG-051 fold), so 'Andy' + U+202E resolves to the real Andy, never to another account
  assert.strictEqual((await get(s, encodeURIComponent('Andy\u202e'))).j.username, 'Andy');
  assert.strictEqual((await get(s, 'Andy')).status, 200); // still alive
});

test('10. rate limit 30/min per visitor; X-Forwarded-For only with TRUST_PROXY and a loopback peer', async (t) => {
  const { s } = await serve(fixture()); t.after(() => s.close());
  for (let i = 0; i < 30; i++) assert.strictEqual((await get(s, 'Andy', { 'X-Forwarded-For': '9.9.9.' + i })).status, 200);
  const r = await get(s, 'Andy', { 'X-Forwarded-For': '8.8.8.8' }); // spoofed XFF ignored without TRUST_PROXY
  assert.strictEqual(r.status, 429); assert.ok(Number(r.h.get('retry-after')) >= 1); assert.strictEqual(r.h.get('cache-control'), 'no-store');

  const { s: s2 } = await serve(fixture(), { trustProxy: true }); t.after(() => s2.close());
  for (let i = 0; i < 30; i++) await get(s2, 'Andy', { 'X-Forwarded-For': '1.1.1.1, 2.2.2.2' });
  assert.strictEqual((await get(s2, 'Andy', { 'X-Forwarded-For': 'evil, 2.2.2.2' })).status, 429); // key = last hop
  assert.strictEqual((await get(s2, 'Andy', { 'X-Forwarded-For': '3.3.3.3' })).status, 200);       // other visitor
  const remote = { socket: { remoteAddress: '203.0.113.5' }, headers: { 'x-forwarded-for': '1.2.3.4' } };
  assert.strictEqual(rateKey(remote, true), '203.0.113.5');                                         // non-loopback peer
});

test('11. cache headers on 200 and 404; invalidate() shows a new member at once', async (t) => {
  const users = fixture();
  const { s, route } = await serve(users); t.after(() => s.close());
  let r = await get(s, 'Andy'); assert.strictEqual(r.h.get('cache-control'), 'public, max-age=60');
  r = await get(s, 'Newbie'); assert.strictEqual(r.status, 404); assert.strictEqual(r.h.get('cache-control'), 'public, max-age=60');
  users.push({ username: 'Newbie', email: 'n@example.com', createdAt: '2026-10-12T16:00:00Z' });
  assert.strictEqual((await get(s, 'Newbie')).status, 404); // index still cached
  route.invalidate();
  assert.deepStrictEqual((await get(s, 'Newbie')).j, { username: 'Newbie', tier: 'Member', joined: '2026-10-12' });
  // TTL rebuild without invalidate
  let now = 0; const list = [];
  const r2 = P.profileRoute(() => list, { now: () => now });
  assert.strictEqual(r2.lookup('Late'), null);
  list.push({ username: 'Late', email: 'l@x.io' }); now = 61000;
  assert.strictEqual(r2.lookup('late').username, 'Late');
});

test('12. real server.js: /u/:name serves profile.html with CSP; API wired; saveUsers path untouched', async (t) => {
  const port = 3000; // server.js listens on a fixed port 3000 (not PORT from .env)
  const busy = await fetch('http://127.0.0.1:3000/').then(() => true, () => false);
  if (busy) { t.skip('port 3000 in use'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest115-'));
  for (const f of ['server.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.cpSync(path.join(ROOT, 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(fixture()));
  const env = Object.assign({}, process.env, { MEMBER_TOKEN_SECRET: '', XAI_API_KEY: '', TRUST_PROXY: '', LAST5_PATH: path.join(dir, 'last5.txt') });
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not start')), 10000);
    const on = (b) => { if (/running on port/.test(String(b))) { clearTimeout(to); res(); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
  });
  const base = 'http://127.0.0.1:' + port;
  let r = await fetch(base + '/u/Andy');
  assert.strictEqual(r.status, 200);
  const csp = r.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'none'/); assert.match(csp, /script-src 'self'/); assert.ok(!/unsafe/.test(csp));
  const html = await r.text();
  assert.match(html, /<script src="\/profile\.js"><\/script>/); assert.ok(!/<script>/.test(html) && !/style=/.test(html));
  assert.strictEqual((await fetch(base + '/u/')).status, 404);
  r = await fetch(base + '/api/profile/%CE%91ndy');
  assert.deepStrictEqual(await r.json(), { username: 'Andy', tier: 'Member', joined: '2026-09-01' });
  assert.strictEqual((await fetch(base + '/api/profile/Pending%20Paul')).status, 404);
  assert.strictEqual((await fetch(base + '/profile.js')).status, 200);
  assert.strictEqual((await fetch(base + '/api/online')).status, 200); // other routes unchanged
});

test('13. profile page script: textContent only, no innerHTML / eval / document.write', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'profile.js'), 'utf8');
  assert.ok(js.includes('textContent'));
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) assert.ok(!js.includes(bad), bad);
  assert.ok(js.includes("credentials: 'omit'"));
});

test("14. chat UI: hidden 'My profile' link, shown only for members on 'joined'", () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, /<a id="myProfile" hidden target="_blank" rel="noopener">My profile<\/a>/);
  assert.match(html, /a\.href = '\/u\/' \+ encodeURIComponent\(n\)/);
  assert.match(html, /!\/\^guest-user \\d\+\$\/i\.test\(n\)/);
});
