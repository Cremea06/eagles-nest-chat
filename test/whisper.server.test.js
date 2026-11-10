// CHG-167: /tell and /r against a real local server on temp data. Nothing leaves this machine.
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
const logs = [];
let dir, port, child;

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

async function startServer(extra = {}) {
  const env = Object.assign({
    PATH: process.env.PATH, HOME: dir, NEST_PORT: String(port), MEMBER_TOKEN_SECRET: SECRET,
    TAILGATE_POLL: '0', TRUST_PROXY: '1', LAST5_PATH: path.join(dir, 'data', 'last5.txt'),
    XAI_API_KEY: 'test-key-not-real', NODE_OPTIONS: '--require ' + path.join(dir, 'spy.js')
  }, extra);
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
function client({ cookie, ip } = {}) {
  const headers = { 'X-Forwarded-For': ip || '198.51.100.' + (ipN++ % 250 + 1) };
  if (cookie) headers.Cookie = cookie;
  const url = 'ws://127.0.0.1:' + port + '/socket.io/?EIO=4&transport=websocket';
  const ws = new WebSocket(url, { headers });
  const c = { events: [], closed: false, ws, ready: null };
  const waiters = [];
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
      if (s.startsWith('44')) { c.events.push({ name: 'connect_error', data: s }); pump(); reject(new Error(s)); return; }
      if (s.startsWith('42')) {
        try { const a = JSON.parse(s.slice(2)); c.events.push({ name: a[0], data: a[1] }); pump(); } catch (e) { /* ignore */ }
      }
    });
    ws.on('close', () => { c.closed = true; pump(); });
    ws.on('error', reject);
  });
  c.send = (name, data) => ws.send('42' + JSON.stringify(data === undefined ? [name] : [name, data]));
  c.mark = () => c.events.length;
  c.wait = (name, pred = () => true, ms = 4000, from = c.events.length) => new Promise((res, rej) => {
    const w = { from, pred: (e) => e.name === name && pred(e.data), res };
    waiters.push(w);
    const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout waiting for ' + name + ' (seen: ' + c.events.slice(from).map((e) => e.name + ':' + JSON.stringify(e.data)).join(' ; ') + ')')); }, ms);
    const r = w.res; w.res = (e) => { clearTimeout(t); r(e); };
    pump();
  });
  c.system = (re, ms, from) => c.wait('system', (t) => re.test(String(t)), ms, from).then((e) => e.data);
  c.close = () => { try { ws.close(); } catch (e) { /* ignore */ } };
  return c;
}
const cookieFor = (name, tv) => 'nest_member=' + encodeURIComponent(memberToken.sign(SECRET, { u: name, tv }, 3600 * 1000));
async function join(opts) { const c = client(opts); await c.ready; c.send('join', {}); const j = await c.wait('joined'); c.joined = j.data; return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function last5() {
  const f = path.join(dir, 'data', 'last5.txt');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}
async function last5Http() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/last5.txt' }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve(b));
    }).on('error', reject);
  });
}
const spyCalls = () => logs.filter((l) => l.startsWith('[spy] fetch')).length;
function closeAll(...socks) { for (const s of socks) if (s) s.close(); }

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chg167-srv-'));
  for (const f of ['server.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for (const d of ['lib', 'public', 'assets']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([
    { username: 'Alice', email: 'alice@test.invalid', createdAt: '2026-01-01T00:00:00.000Z', verified: true, tokenVersion: 7, rep: 'WV' },
    { username: 'Bob', email: 'bob@test.invalid', createdAt: '2026-01-02T00:00:00.000Z', verified: true, tokenVersion: 3 }
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'clips.json'), JSON.stringify({ clips: [] }));
  fs.mkdirSync(path.join(dir, 'clips-img'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'spy.js'), "globalThis.fetch = async (u) => { console.log('[spy] fetch ' + String(u).replace(/[?].*/, '')); return { json: async () => ({ choices: [{ message: { content: 'spy reply' } }], usage: { total_tokens: 1 } }) }; };\n");
  port = await freePort();
  await startServer();
});
test.after(async () => { await stopServer(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('/help lists /tell and /r', async () => {
  const a = await join();
  const from = a.mark();
  a.send('chat message', '/help');
  const t = await a.system(/Available commands/, 4000, from);
  assert.match(t, /\/tell <name> <message>/);
  assert.match(t, /\/r <message>/);
  closeAll(a);
});

test('guest whisper is delivered only to the two parties; last5 and Neagle stay untouched', async () => {
  const a = await join();
  const b = await join();
  const c = await join();
  const alice = await join({ cookie: cookieFor('Alice', 7) });
  assert.strictEqual(alice.joined.username, 'Alice');
  const pubFrom = alice.mark();
  alice.send('chat message', 'public line for last5');
  await alice.wait('chat message', (m) => m && m.message === 'public line for last5', 4000, pubFrom);
  await sleep(50);
  const before = last5();
  assert.match(before, /public line for last5/);
  const httpBefore = await last5Http();
  const canary = 'WHISPERCANARY-167-SECRET';
  const calls = spyCalls();
  const fa = a.mark(), fb = b.mark(), fc = c.mark(), falice = alice.mark();
  a.send('chat message', '/tell ' + b.joined.username + ' hello ' + canary + ' neagle');
  const out = (await a.wait('whisper', () => true, 4000, fa)).data;
  const inn = (await b.wait('whisper', () => true, 4000, fb)).data;
  assert.strictEqual(out.dir, 'out');
  assert.strictEqual(out.to, b.joined.username);
  assert.strictEqual(out.message, 'hello ' + canary + ' neagle');
  assert.strictEqual(inn.dir, 'in');
  assert.strictEqual(inn.from, a.joined.username);
  assert.strictEqual(inn.message, 'hello ' + canary + ' neagle');
  await sleep(200);
  assert.ok(!c.events.slice(fc).some((e) => e.name === 'whisper'), 'observer C must not receive the whisper event');
  assert.ok(!alice.events.slice(falice).some((e) => e.name === 'whisper'), 'Alice must not receive the guest whisper');
  assert.ok(!c.events.slice(fc).some((e) => JSON.stringify(e.data).includes(canary)));
  assert.strictEqual(last5(), before);
  assert.strictEqual(await last5Http(), httpBefore);
  assert.ok(!last5().includes(canary));
  assert.strictEqual(spyCalls(), calls, 'whisper must not call Neagle');
  assert.ok(!logs.some((l) => l.includes(canary)), 'server log must not contain the whisper text');
  closeAll(a, b, c, alice);
});

test('name matching accepts WV Alice and Guest-User forms; /r replies to the last sender', async () => {
  const alice = await join({ cookie: cookieFor('Alice', 7) });
  const g = await join();
  let from = g.mark();
  g.send('chat message', '/tell WV Alice ping from guest');
  const toAlice = (await g.wait('whisper', (d) => d.dir === 'out', 4000, from)).data;
  assert.strictEqual(toAlice.to, 'WV Alice');
  const inn = (await alice.wait('whisper', (d) => d.dir === 'in' && d.message === 'ping from guest')).data;
  assert.strictEqual(inn.from, g.joined.username);
  from = alice.mark();
  const fg = g.mark();
  alice.send('chat message', '/r thanks, I got it');
  const replyOut = (await alice.wait('whisper', (d) => d.dir === 'out', 4000, from)).data;
  const replyIn = (await g.wait('whisper', (d) => d.dir === 'in', 4000, fg)).data;
  assert.strictEqual(replyOut.to, g.joined.username);
  assert.strictEqual(replyOut.message, 'thanks, I got it');
  assert.strictEqual(replyIn.from, 'WV Alice');
  assert.strictEqual(replyIn.message, 'thanks, I got it');
  closeAll(alice, g);
});

test('offline, unknown, and self targets get a private system note; usage errors too', async () => {
  const a = await join();
  let from = a.mark();
  a.send('chat message', '/tell NobodyHere hello');
  assert.match(await a.system(/not online/, 4000, from), /NobodyHere/);
  from = a.mark();
  a.send('chat message', '/tell ' + a.joined.username + ' hi me');
  await a.system(/cannot whisper yourself/, 4000, from);
  from = a.mark();
  a.send('chat message', '/tell');
  await a.system(/Usage: \/tell/, 4000, from);
  from = a.mark();
  a.send('chat message', '/r');
  await a.system(/Usage: \/r/, 4000, from);
  from = a.mark();
  a.send('chat message', '/r hello');
  await a.system(/No one has whispered you yet/, 4000, from);
  assert.ok(!a.events.some((e) => e.name === 'whisper'));
  closeAll(a);
});

test('rate limit is 10 whispers per minute per socket', async () => {
  const a = await join();
  const b = await join();
  for (let i = 0; i < 10; i++) {
    const from = a.mark();
    a.send('chat message', '/tell ' + b.joined.username + ' n' + i);
    await a.wait('whisper', (d) => d.dir === 'out' && d.message === 'n' + i, 4000, from);
  }
  const from = a.mark();
  a.send('chat message', '/tell ' + b.joined.username + ' n10');
  await a.system(/Too many whispers/, 4000, from);
  assert.ok(!a.events.slice(from).some((e) => e.name === 'whisper'));
  closeAll(a, b);
});

test('WHISPER_MEMBERS_ONLY=1 blocks guests and still allows members', async () => {
  await stopServer();
  logs.length = 0;
  port = await freePort();
  await startServer({ WHISPER_MEMBERS_ONLY: '1' });
  const g = await join();
  const alice = await join({ cookie: cookieFor('Alice', 7) });
  const bob = await join({ cookie: cookieFor('Bob', 3) });
  let from = g.mark();
  g.send('chat message', '/tell Alice hi from guest');
  const deny = await g.system(/Only signed-in members can send whispers/, 4000, from);
  assert.ok(!/code/i.test(deny));
  await sleep(80);
  assert.ok(!alice.events.some((e) => e.name === 'whisper'));
  from = alice.mark();
  const fb = bob.mark();
  alice.send('chat message', '/tell Bob members only still works');
  const out = (await alice.wait('whisper', (d) => d.dir === 'out', 4000, from)).data;
  const inn = (await bob.wait('whisper', (d) => d.dir === 'in', 4000, fb)).data;
  assert.strictEqual(out.to, 'Bob');
  assert.strictEqual(inn.from, 'WV Alice');
  assert.strictEqual(inn.message, 'members only still works');
  closeAll(g, alice, bob);
});
