// CHG-173: /admin against a real local server.js on temp data (127.0.0.1 only, nothing leaves this machine).
// The owner is a test account: a preload replaces lib/username.js isOwnerAccountEmail so that owner@test.invalid
// counts as the owner (the real check is a SHA-256 of Andy's email, which must not be copied into a public test).
// Everything else (cookie parsing, readMember, routing, gate, 404s) is the production code path.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const memberToken = require('../lib/memberToken');

const ROOT = path.join(__dirname, '..');
const SECRET = crypto.randomBytes(24).toString('hex');
const TG_TOKEN = 'tgtoken-' + crypto.randomBytes(12).toString('hex');
const logs = [];
let dir, port, child;

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chg173-srv-'));
  for (const f of ['server.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for (const d of ['lib', 'public', 'assets', 'admin']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([
    { username: 'Andy', email: 'owner@test.invalid', createdAt: '2026-01-01T00:00:00.000Z', verified: true, tokenVersion: 9, rep: 'WV' },
    { username: 'Alice', email: 'alice@test.invalid', createdAt: '2026-01-02T00:00:00.000Z', verified: true, tokenVersion: 7 },
    { username: 'Bob', email: 'bob@test.invalid', createdAt: '2026-01-03T00:00:00.000Z', verified: true, tokenVersion: 3 }
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'clips.json'), JSON.stringify({ clips: [] }));
  fs.mkdirSync(path.join(dir, 'clips-img'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'spy.js'),
    "globalThis.fetch = async () => ({ json: async () => ({ choices: [{ message: { content: 'spy reply' } }], usage: { total_tokens: 1 } }) });\n" +
    "const u = require(" + JSON.stringify(path.join(dir, 'lib', 'username.js')) + ");\n" +
    "const real = u.isOwnerAccountEmail;\n" +
    "u.isOwnerAccountEmail = (e) => e === 'owner@test.invalid' || real(e);\n");
}
async function startServer(extra = {}) {
  const env = Object.assign({
    PATH: process.env.PATH, HOME: dir, NEST_PORT: String(port), MEMBER_TOKEN_SECRET: SECRET, TAILGATE_TOKEN: TG_TOKEN,
    TAILGATE_POLL: '0', FEATURED_POLL: '0', TRUST_PROXY: '1', LAST5_PATH: path.join(dir, 'data', 'last5.txt'),
    XAI_API_KEY: 'test-key-not-real', NODE_OPTIONS: '--require ' + path.join(dir, 'spy.js')
  }, extra);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  logs.length = 0;
  child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  const onData = (d) => { for (const l of d.toString().split('\n')) if (l.trim()) logs.push(l); };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  const t0 = Date.now();
  while (!logs.some((l) => l.includes('Milliway chat running'))) {
    if (Date.now() - t0 > 15000) throw new Error('server did not start: ' + logs.slice(-8).join(' | '));
    await new Promise((r) => setTimeout(r, 50));
  }
}
async function stopServer() {
  if (!child) return;
  const c = child; child = null;
  await new Promise((r) => { c.once('exit', r); c.kill('SIGTERM'); setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) {} }, 3000); });
}

let ipN = 1;
function req(p, { cookie, method = 'GET', headers = {}, body } = {}) {
  return new Promise((res, rej) => {
    const h = Object.assign({ 'X-Forwarded-For': '203.0.113.' + (ipN++ % 250 + 1) }, headers);
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (x) => {
      let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => res({ status: x.statusCode, headers: x.headers, body: b }));
    });
    r.on('error', rej); r.end(body);
  });
}
function client({ cookie } = {}) {
  const headers = { 'X-Forwarded-For': '198.51.100.' + (ipN++ % 250 + 1) };
  if (cookie) headers.Cookie = cookie;
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/socket.io/?EIO=4&transport=websocket', { headers });
  const c = { events: [], ws };
  const waiters = [];
  const pump = () => { for (const w of waiters.slice()) { const e = c.events.find((x, i) => i >= w.from && w.pred(x)); if (e) { waiters.splice(waiters.indexOf(w), 1); w.res(e); } } };
  c.ready = new Promise((resolve, reject) => {
    ws.on('message', (m) => {
      const s = m.toString();
      if (s === '2') return ws.send('3');
      if (s[0] === '0') return ws.send('40');
      if (s.startsWith('40')) { resolve(); return; }
      if (s.startsWith('42')) { try { const a = JSON.parse(s.slice(2)); c.events.push({ name: a[0], data: a[1] }); pump(); } catch (e) { /* ignore */ } }
    });
    ws.on('error', reject);
  });
  c.send = (name, data) => ws.send('42' + JSON.stringify(data === undefined ? [name] : [name, data]));
  c.wait = (name, pred = () => true, ms = 4000) => new Promise((res, rej) => {
    const w = { from: 0, pred: (e) => e.name === name && pred(e.data), res };
    waiters.push(w);
    const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout waiting for ' + name)); }, ms);
    const r = w.res; w.res = (e) => { clearTimeout(t); r(e); };
    pump();
  });
  c.close = () => { try { ws.close(); } catch (e) { /* ignore */ } };
  return c;
}
const cookieFor = (name, tv) => 'nest_member=' + encodeURIComponent(memberToken.sign(SECRET, { u: name, tv }, 3600 * 1000));
async function join(opts) { const c = client(opts); await c.ready; c.send('join', {}); const j = await c.wait('joined'); c.joined = j.data; return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OWNER = () => cookieFor('Andy', 9);

test.before(async () => { setup(); port = await freePort(); await startServer(); });
test.after(async () => { await stopServer(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

const ADMIN_PATHS = ['/admin', '/admin/', '/admin/admin.js', '/admin/admin.css', '/api/admin/overview', '/api/admin/audit'];

test('guest, no cookie, other member, stale, forged and wrong-secret cookies all get the plain 404', async () => {
  const nf = await req('/no-such-page');
  assert.strictEqual(nf.status, 404);
  const forged = 'nest_member=' + encodeURIComponent(memberToken.sign('x'.repeat(40), { u: 'Andy', tv: 9 }, 3600 * 1000));
  const cookies = [null, cookieFor('Alice', 7), cookieFor('Bob', 3), cookieFor('Andy', 1) /* stale tokenVersion */, forged, 'nest_member=garbage'];
  for (const p of ADMIN_PATHS) {
    for (const cookie of cookies) {
      const r = await req(p, { cookie });
      assert.strictEqual(r.status, 404, p);
      assert.strictEqual(r.body.replace('Cannot GET ' + p, 'X'), nf.body.replace('Cannot GET /no-such-page', 'X'));
      assert.strictEqual(r.headers['content-type'], nf.headers['content-type']);
      assert.strictEqual(r.headers['x-robots-tag'], undefined);
    }
  }
  assert.ok(!fs.existsSync(path.join(dir, 'public', 'admin.html')), 'the page is not under public/ (static would serve it)');
  assert.strictEqual((await req('/admin.html')).status, 404);
  assert.strictEqual((await req('/admin/admin.html', { cookie: OWNER() })).status, 404);
});

test('owner: page, assets and both JSON endpoints answer 200 with no-store, noindex and a strict CSP', async () => {
  for (const p of ADMIN_PATHS) {
    const r = await req(p, { cookie: OWNER() });
    assert.strictEqual(r.status, 200, p);
    assert.match(r.headers['cache-control'], /no-store/);
    assert.match(r.headers['x-robots-tag'], /noindex/);
  }
  const page = await req('/admin', { cookie: OWNER() });
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.match(page.body, /Admin console/);
  const o = JSON.parse((await req('/api/admin/overview', { cookie: OWNER() })).body);
  assert.strictEqual(o.owner.name, 'Andy');
  assert.strictEqual(o.server.node, process.version);
  assert.ok(o.server.uptimeSec >= 0 && o.server.memory.rss > 0);
  assert.strictEqual(o.room.registered, 3);
  assert.strictEqual(o.tailgate.mode, 'normal');
  assert.strictEqual(o.featured.polling, false);
  assert.strictEqual(o.featured.creators.length, 4);
  assert.strictEqual(o.audit.max, 200);
});

test('no mutating verbs: POST/PUT/PATCH/DELETE on /admin and /api/admin/* are 404 even for the owner', async () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const p of ['/admin', '/api/admin/overview', '/api/admin/audit', '/api/admin/tailgate', '/api/admin/pause']) {
      const r = await req(p, { cookie: OWNER(), method: m, headers: { 'Content-Type': 'application/json' }, body: m === 'DELETE' ? undefined : '{"paused":true}' });
      assert.strictEqual(r.status, 404, m + ' ' + p);
    }
  }
});

test('room view: members vs guests, names, message rate, pause state; no chat text, whisper or email anywhere', async () => {
  const owner = await join({ cookie: OWNER() });
  const alice = await join({ cookie: cookieFor('Alice', 7) });
  const g1 = await join();
  const g2 = await join();
  assert.strictEqual(owner.joined.username, 'Andy');
  const PUB = 'zz-public-line-' + crypto.randomBytes(4).toString('hex');
  const WHIS = 'zz-whisper-secret-' + crypto.randomBytes(4).toString('hex');
  alice.send('chat message', PUB);
  await alice.wait('chat message', (m) => m && m.message === PUB);
  alice.send('chat message', '/tell Bob ' + WHIS);   // Bob is offline: the attempt must not be logged either
  g1.send('chat message', '/tell ' + g2.joined.username + ' ' + WHIS);
  await g2.wait('whisper', () => true, 4000).catch(() => null);
  g1.send('chat:pause:set', { paused: true });
  await g1.wait('chat:pause', (s) => s && s.paused === true);
  await sleep(100);

  const ov = await req('/api/admin/overview', { cookie: OWNER() });
  const au = await req('/api/admin/audit', { cookie: OWNER() });
  const o = JSON.parse(ov.body), a = JSON.parse(au.body);
  assert.strictEqual(o.room.members, 2);
  assert.strictEqual(o.room.guests, 2);
  assert.strictEqual(o.room.joined, 4);
  assert.ok(o.room.connected >= 4);
  const names = o.room.names.map((n) => n.name);
  assert.ok(names.includes('WV Andy') && names.includes('Alice') && names.includes(g1.joined.username));
  assert.strictEqual(o.room.names.filter((n) => n.guest).length, 2);
  assert.ok(o.room.messages.total >= 1);
  assert.strictEqual(o.room.messages.series.length, 15);
  assert.deepStrictEqual(o.room.chatPause, { paused: true, by: g1.joined.username });
  const ev = a.entries.find((e) => e.type === 'chat_pause');
  assert.ok(ev && ev.detail.paused === true && ev.detail.by === g1.joined.username);
  assert.ok(a.entries.some((e) => e.type === 'server_start'));
  for (const body of [ov.body, au.body, (await req('/admin', { cookie: OWNER() })).body, (await req('/admin/admin.js', { cookie: OWNER() })).body]) {
    assert.ok(!body.includes(PUB), 'public chat text not shown');
    assert.ok(!body.includes(WHIS), 'whisper text not shown');
    assert.ok(!/test\.invalid|tokenVersion|nest_member|pendingCode/.test(body), 'no email, cookie or account internals');
  }
  assert.ok(!logs.join('\n').includes(WHIS), 'whisper never reaches the server log');
  g1.send('chat:pause:set', { paused: false });
  await sleep(100);
  for (const c of [owner, alice, g1, g2]) c.close();
});

test('tailgate: state read server-side; a local flip shows in the audit; the token never appears', async () => {
  const flip = await req('/api/tailgate', { method: 'POST', headers: { Authorization: 'Bearer ' + TG_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'on', embedId: 'v7testabc' }) });
  assert.strictEqual(flip.status, 200);
  const ov = await req('/api/admin/overview', { cookie: OWNER() });
  const au = await req('/api/admin/audit', { cookie: OWNER() });
  const o = JSON.parse(ov.body);
  assert.strictEqual(o.tailgate.mode, 'tailgate');
  assert.strictEqual(o.tailgate.override, 'on');
  assert.strictEqual(o.tailgate.embedId, 'v7testabc');
  assert.strictEqual(o.tailgate.source, 'rumble');
  assert.strictEqual(o.tailgate.tokenConfigured, true);
  const ev = JSON.parse(au.body).entries.find((e) => e.type === 'tailgate');
  assert.ok(ev && ev.detail.embedId === 'v7testabc' && ev.detail.mode === 'tailgate');
  for (const p of ADMIN_PATHS) {
    const r = await req(p, { cookie: OWNER() });
    assert.ok(!r.body.includes(TG_TOKEN) && !JSON.stringify(r.headers).includes(TG_TOKEN), p + ' has no token');
  }
  await req('/api/tailgate', { method: 'POST', headers: { Authorization: 'Bearer ' + TG_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'auto' }) });
});

test('server health, admin page views in the audit, blocked-request counter', async () => {
  await req('/admin', { cookie: OWNER() });
  await req('/admin'); await req('/api/admin/overview', { cookie: cookieFor('Alice', 7) });
  const o = JSON.parse((await req('/api/admin/overview', { cookie: OWNER() })).body);
  const a = JSON.parse((await req('/api/admin/audit?limit=5', { cookie: OWNER() })).body);
  assert.ok(o.audit.deniedAttempts >= 2);
  assert.ok(a.entries.length <= 5);
  assert.ok(JSON.parse((await req('/api/admin/audit', { cookie: OWNER() })).body).entries.some((e) => e.type === 'admin_view'));
  assert.ok(Date.parse(o.server.startedAt) <= Date.now());
  assert.strictEqual(o.server.commit.atStart, null); // temp dir has no .git
});

test('owner requests are rate limited (429); a guest probing the same path still sees only 404', async () => {
  const ip = '203.0.113.250';
  let last = 0; let got429 = false;
  for (let i = 0; i < 130; i++) {
    const r = await req('/api/admin/overview', { cookie: OWNER(), headers: { 'X-Forwarded-For': ip } });
    last = r.status; if (r.status === 429) { got429 = true; assert.ok(r.headers['retry-after']); break; }
  }
  assert.ok(got429, 'expected a 429 after 120 requests (last ' + last + ')');
  assert.strictEqual((await req('/api/admin/overview', { headers: { 'X-Forwarded-For': ip } })).status, 404);
});

test('remember-me off (no MEMBER_TOKEN_SECRET): nobody can open /admin, not even the owner cookie', async () => {
  await stopServer();
  port = await freePort();
  await startServer({ MEMBER_TOKEN_SECRET: undefined });
  for (const p of ADMIN_PATHS) assert.strictEqual((await req(p, { cookie: OWNER() })).status, 404, p);
});
