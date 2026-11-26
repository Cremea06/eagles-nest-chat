// CHG-177: MediaMTX live token issuing, auth hook, and P2P fallback against real server.js.
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

const ROOT = path.join(__dirname, '..');
const HOOK_SECRET = 'mtx-hook-secret-' + crypto.randomBytes(12).toString('hex');
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chg177-srv-'));
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

function req(p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (x) => {
      let b = '';
      x.on('data', (d) => (b += d));
      x.on('end', () => res({ status: x.statusCode, headers: x.headers, body: b }));
    });
    r.on('error', rej);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

function client() {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/socket.io/?EIO=4&transport=websocket');
  const c = { events: [], ws };
  const waiters = [];
  let ackSeq = 1;
  const acks = new Map();
  const pump = () => {
    for (const w of waiters.slice()) {
      const e = c.events.find((x, i) => i >= w.from && w.pred(x));
      if (e) { waiters.splice(waiters.indexOf(w), 1); w.res(e); }
    }
  };
  c.ready = new Promise((resolve, reject) => {
    ws.on('message', (m) => {
      const s = m.toString();
      if (s === '2') return ws.send('3');
      if (s[0] === '0') return ws.send('40');
      if (s.startsWith('40')) { resolve(); return; }
      if (s.startsWith('43')) {
        const idx = s.indexOf('[');
        const id = Number(s.slice(2, idx));
        const args = JSON.parse(s.slice(idx));
        const fn = acks.get(id);
        if (fn) { acks.delete(id); fn(args[0]); }
        return;
      }
      if (s.startsWith('42')) {
        try { const a = JSON.parse(s.slice(2)); c.events.push({ name: a[0], data: a[1] }); pump(); } catch (e) {}
      }
    });
    ws.on('error', reject);
  });
  c.send = (name, data) => ws.send('42' + JSON.stringify(data === undefined ? [name] : [name, data]));
  c.call = (name, data) => new Promise((res, rej) => {
    const id = ackSeq++;
    const t = setTimeout(() => { acks.delete(id); rej(new Error('ack timeout ' + name)); }, 4000);
    acks.set(id, (resp) => { clearTimeout(t); res(resp); });
    ws.send('42' + id + JSON.stringify([name, data === undefined ? {} : data]));
  });
  c.wait = (name, pred = () => true, ms = 4000) => new Promise((res, rej) => {
    const w = { from: 0, pred: (e) => e.name === name && pred(e.data), res };
    waiters.push(w);
    const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout waiting for ' + name)); }, ms);
    const r = w.res;
    w.res = (e) => { clearTimeout(t); r(e); };
    pump();
  });
  c.close = () => { try { ws.close(); } catch (e) {} };
  return c;
}

async function join() {
  const c = client();
  await c.ready;
  const cfgP = c.wait('live:config');
  c.send('join', {});
  const j = await c.wait('joined');
  c.joined = j.data;
  c.liveConfig = (await cfgP).data;
  return c;
}

test.before(() => { setup(); });
test.after(async () => { await stopServer(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('when MEDIAMTX_ENABLED is unset, server reports disabled and Go Live stays on P2P', async () => {
  port = await freePort();
  await startServer();
  const c1 = await join();
  const c2 = await join();
  try {
    assert.strictEqual(c1.liveConfig.enabled, false);
    const ice = JSON.parse((await req('/api/ice-servers')).body);
    assert.strictEqual(ice.mediamtx.enabled, false);

    const prep = await c1.call('live:prepare', { kind: 'camera' });
    assert.strictEqual(prep.ok, false);
    assert.strictEqual(prep.error, 'mediamtx_disabled');

    const ulP = c2.wait('user-live');
    c1.send('go-live', { kind: 'camera', allowClips: false });
    const ul = (await ulP).data;
    assert.strictEqual(ul.mode, 'p2p');
    assert.ok(!ul.whepUrl);
  } finally {
    c1.close();
    c2.close();
    await stopServer();
  }
});

test('when MEDIAMTX_ENABLED=1, server issues per-session tokens, enforces auth hook, announces WHEP, and revokes on end/disconnect', async () => {
  port = await freePort();
  await startServer({
    MEDIAMTX_ENABLED: '1',
    MEDIAMTX_PUBLIC_BASE: '/mtx',
    MEDIAMTX_AUTH_SECRET: HOOK_SECRET
  });
  const c1 = await join();
  const c2 = await join();
  let c3 = null;
  try {
    assert.strictEqual(c1.liveConfig.enabled, true);
    assert.strictEqual(c1.liveConfig.base, '/mtx');
    const ice = JSON.parse((await req('/api/ice-servers')).body);
    assert.deepStrictEqual(ice.mediamtx, { enabled: true, base: '/mtx' });

    // Prepare session for c1
    const prep = await c1.call('live:prepare', { kind: 'camera' });
    assert.strictEqual(prep.ok, true);
    assert.ok(prep.streamPath.startsWith('live/'));
    assert.strictEqual(prep.whipUrl, '/mtx/' + prep.streamPath + '/whip');
    assert.strictEqual(prep.whepUrl, '/mtx/' + prep.streamPath + '/whep');

    // External-looking request with X-Forwarded-For gets 404
    const ext = await req('/api/mediamtx/auth?secret=' + HOOK_SECRET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.2' },
      body: JSON.stringify({ action: 'publish', path: prep.streamPath, token: prep.token })
    });
    assert.strictEqual(ext.status, 404);

    // Auth hook accepts valid publish token, rejects wrong token, allows public read on live/<key>
    const authOk = await req('/api/mediamtx/auth?secret=' + HOOK_SECRET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'publish', path: prep.streamPath, token: prep.token })
    });
    assert.strictEqual(authOk.status, 200);

    const authBad = await req('/api/mediamtx/auth?secret=' + HOOK_SECRET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'publish', path: prep.streamPath, token: 'wrong' })
    });
    assert.strictEqual(authBad.status, 401);

    const readOk = await req('/api/mediamtx/auth?secret=' + HOOK_SECRET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read', path: prep.streamPath })
    });
    assert.strictEqual(readOk.status, 200);

    // Broadcaster goes live with allowClips: true
    const ulP = c2.wait('user-live');
    const sysP = c2.wait('system', (m) => typeof m === 'string' && m.includes('went live'));
    const ctxP = c2.wait('clips:context', (c) => c && c.kind === 'golive');
    c1.send('go-live', { kind: 'camera', allowClips: true, streamKey: prep.streamKey });
    const ul = (await ulP).data;
    assert.strictEqual(ul.mode, 'mediamtx');
    assert.strictEqual(ul.whepUrl, prep.whepUrl);
    await sysP;
    const ctx = (await ctxP).data;
    assert.strictEqual(ctx.kind, 'golive');

    // Late joiner gets live-state with mode: 'mediamtx' and whepUrl
    c3 = await join();
    const ls = (await c3.wait('live-state')).data;
    assert.strictEqual(ls[0].mode, 'mediamtx');
    assert.strictEqual(ls[0].whepUrl, prep.whepUrl);

    // End live revokes publish token and notifies viewers
    const endedP = c2.wait('user-ended-live');
    c1.send('end-live');
    await endedP;
    const afterEnd = await req('/api/mediamtx/auth?secret=' + HOOK_SECRET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'publish', path: prep.streamPath, token: prep.token })
    });
    assert.strictEqual(afterEnd.status, 401);

    // Disconnect also revokes prepared token
    const prep2 = await c2.call('live:prepare', { kind: 'camera' });
    assert.strictEqual(prep2.ok, true);
    c2.close();
    await new Promise((r) => setTimeout(r, 150));
    const afterDisc = await req('/api/mediamtx/auth?secret=' + HOOK_SECRET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'publish', path: prep2.streamPath, token: prep2.token })
    });
    assert.strictEqual(afterDisc.status, 401);
  } finally {
    c1.close();
    c2.close();
    if (c3) c3.close();
    await stopServer();
  }
});
