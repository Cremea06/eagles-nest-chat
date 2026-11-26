// CHG-176: /api/ice-servers integration test against a real local server.js (127.0.0.1 only).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TURN_SECRET = 'turn-server-secret-' + crypto.randomBytes(16).toString('hex');
let dir, port, child, logs = [];

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chg176-srv-'));
  for (const f of ['server.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for (const d of ['lib', 'public', 'assets', 'admin']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([]));
  fs.writeFileSync(path.join(dir, 'clips.json'), JSON.stringify({ clips: [] }));
  fs.mkdirSync(path.join(dir, 'clips-img'));
  fs.mkdirSync(path.join(dir, 'data'));
}

async function startServer(extra = {}) {
  const env = Object.assign({
    PATH: process.env.PATH,
    HOME: dir,
    NEST_PORT: String(port),
    TAILGATE_POLL: '0',
    FEATURED_POLL: '0',
    TRUST_PROXY: '1',
    LAST5_PATH: path.join(dir, 'data', 'last5.txt')
  }, extra);
  logs = [];
  child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  const onData = (d) => { for (const l of d.toString().split('\n')) if (l.trim()) logs.push(l); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const t0 = Date.now();
  while (!logs.some((l) => l.includes('Milliway chat running'))) {
    if (Date.now() - t0 > 15000) throw new Error('server did not start: ' + logs.slice(-8).join(' | '));
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function stopServer() {
  if (!child) return;
  const c = child;
  child = null;
  await new Promise((r) => {
    c.once('exit', r);
    c.kill('SIGTERM');
    setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) {} }, 3000);
  });
}

let ipN = 1;
function req(p, { method = 'GET', headers = {} } = {}) {
  return new Promise((res, rej) => {
    const h = Object.assign({ 'X-Forwarded-For': '203.0.113.' + ((ipN++ % 240) + 1) }, headers);
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (x) => {
      let b = '';
      x.on('data', (d) => (b += d));
      x.on('end', () => res({ status: x.statusCode, headers: x.headers, body: b }));
    });
    r.on('error', rej);
    r.end();
  });
}

test.before(() => { setup(); });
test.after(async () => { await stopServer(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('GET /api/ice-servers returns STUN-only when TURN_SECRET is unset', async () => {
  port = await freePort();
  await startServer();
  try {
    const r = await req('/api/ice-servers');
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.turn, false);
    assert.deepStrictEqual(j.iceServers, [{ urls: 'stun:stun.l.google.com:19302' }]);
  } finally {
    await stopServer();
  }
});

test('GET /api/ice-servers issues valid HMAC-SHA1 TURN credentials when TURN_SECRET is set and rate-limits', async () => {
  port = await freePort();
  await startServer({ TURN_SECRET, TURN_HOST: 'chat.afirstflag.com', TURN_TLS: '1' });
  try {
    const r = await req('/api/ice-servers');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['cache-control'], 'no-store');
    assert.ok(!r.body.includes(TURN_SECRET));
    const j = JSON.parse(r.body);
    assert.strictEqual(j.turn, true);
    assert.strictEqual(j.tls, true);
    assert.strictEqual(j.ttlSec, 3600);
    assert.strictEqual(j.iceServers.length, 2);
    const t = j.iceServers[1];
    assert.deepStrictEqual(t.urls, [
      'turn:chat.afirstflag.com:3478?transport=udp',
      'turn:chat.afirstflag.com:3478?transport=tcp',
      'turns:chat.afirstflag.com:5349?transport=tcp'
    ]);
    const expected = crypto.createHmac('sha1', TURN_SECRET).update(t.username).digest('base64');
    assert.strictEqual(t.credential, expected);

    const foreign = await req('/api/ice-servers', { headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(foreign.status, 403);

    // Rate limit (30/min per IP)
    const fixedIp = { 'X-Forwarded-For': '198.51.100.77' };
    let limited = false;
    for (let i = 0; i < 35; i++) {
      const hit = await req('/api/ice-servers', { headers: fixedIp });
      if (hit.status === 429) { limited = true; break; }
    }
    assert.ok(limited, 'expected 429 rate limit after >30 requests');
    assert.ok(!logs.join('\n').includes(TURN_SECRET), 'server logs must never print TURN_SECRET');
  } finally {
    await stopServer();
  }
});

test('public/index.html fetches /api/ice-servers and preserves DEFAULT_RTC_CONFIG fallback', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes("fetch('/api/ice-servers'"));
  assert.ok(html.includes('DEFAULT_RTC_CONFIG'));
  assert.ok(html.includes('new RTCPeerConnection(rtcConfig)'));
});
