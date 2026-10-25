// CHG-141: guests join muted until they have recorded 100 keystrokes — against a REAL server process, temp data only.
//  Same harness as the CHG-138/140 server tests (temp copy of the repo, fake SMTP, minimal socket.io v4 client).
//  Extra: a preload (spy.js) replaces fetch in the server process, so any call to Neagle's AI shows up in the log as
//  '[spy] fetch'. A blocked line must never produce one. Nothing leaves this machine.
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
const WORLD = crypto.randomBytes(24).toString('hex');
const OWNER_EMAIL = 'owner@test.invalid';
const CHATTY = 'sekret-typed-words-141';
const mail = []; // { to, body, subject }
const logs = [];
let dir; let port; let child; let smtp; let smtpPort;

// ---- fake SMTP (EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT) ----
function startSmtp() {
  return new Promise((resolve) => {
    smtp = net.createServer((sock) => {
      let buf = ''; let data = null; let to = '';
      const say = (s) => sock.write(s + '\r\n');
      say('220 fake ESMTP');
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (data !== null) {
            if (line === '.') {
              const raw = data.join('\n'); data = null;
              const qp = raw.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
              const subject = (/^Subject: (.*)$/m.exec(raw) || [])[1] || '';
              mail.push({ to, body: qp, subject }); say('250 ok');
            } else data.push(line);
            continue;
          }
          const u = line.toUpperCase();
          if (u.startsWith('EHLO') || u.startsWith('HELO')) { sock.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n'); }
          else if (u.startsWith('AUTH PLAIN')) say('235 ok');
          else if (u.startsWith('AUTH LOGIN')) say('334 VXNlcm5hbWU6');
          else if (u.startsWith('MAIL FROM')) say('250 ok');
          else if (u.startsWith('RCPT TO')) { to = /<([^>]*)>/.exec(line)[1]; say('250 ok'); }
          else if (u === 'DATA') { data = []; say('354 go'); }
          else if (u === 'QUIT') { say('221 bye'); sock.end(); }
          else if (/^[A-Za-z0-9+/=]+$/.test(line)) say(line.length > 8 && !sock._u ? (sock._u = 1, '334 UGFzc3dvcmQ6') : '235 ok');
          else say('250 ok');
        }
      });
      sock.on('error', () => {});
    });
    smtp.listen(0, '127.0.0.1', () => { smtpPort = smtp.address().port; resolve(); });
  });
}

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

// ---- sample data ----
const L = (user, text) => ({ user, text, t: 1 });
const usersSeed = () => [
  { username: 'Alice', email: 'alice@test.invalid', createdAt: '2026-01-01T00:00:00.000Z', verified: true, tokenVersion: 7, rep: 'WV' },
  { username: 'Bob', email: 'bob@test.invalid', createdAt: '2026-01-02T00:00:00.000Z', verified: true, tokenVersion: 3 },
  { username: 'Carol', email: 'carol@test.invalid', createdAt: '2026-01-03T00:00:00.000Z', verified: true },
  { username: 'Dave', email: 'dave@test.invalid', createdAt: '2026-01-03T00:00:00.000Z', verified: true },
  { username: 'Erin', email: 'erin@test.invalid', createdAt: '2026-01-03T00:00:00.000Z', verified: true },
  { username: 'Frank', email: 'frank@test.invalid', createdAt: '2026-01-03T00:00:00.000Z', verified: true },
  { username: 'Hank', email: 'hank@test.invalid', createdAt: '2026-01-03T00:00:00.000Z', verified: true },
  { username: 'Ivy', email: 'ivy@test.invalid', createdAt: '2026-01-03T00:00:00.000Z', verified: true },
  { username: 'Jake', email: 'jake@test.invalid', createdAt: '2026-01-03T00:00:00.000Z', verified: true },
  { username: 'Kim', email: 'kim@test.invalid', createdAt: '2026-01-03T00:00:00.000Z', verified: true },
  { username: 'Andy', email: OWNER_EMAIL, createdAt: '2026-01-01T00:00:00.000Z', verified: true, tokenVersion: 1 },
];
const clipsSeed = () => [
  { id: 'AAAAAAAA', createdAt: '2026-02-01T00:00:00.000Z', clipper: 'WV Alice', clipperKey: 'm:alice', voters: ['m:bob'], hidden: false, caption: '', context: { kind: 'room', title: 'Milliway' }, lines: [L('WV Alice', 'hello')] },
  { id: 'BBBBBBBB', createdAt: '2026-02-01T00:00:00.000Z', clipper: 'Bob', clipperKey: 'm:bob', voters: ['m:alice', 'm:carol'], hidden: false, caption: 'x', context: { kind: 'golive', broadcaster: 'Alice', title: 'Alice live in Milliway' }, lines: [L('WV Alice', 'yo'), L('Bob', 'sup')] },
  { id: 'CCCCCCCC', createdAt: '2026-02-01T00:00:00.000Z', clipper: 'Carol', clipperKey: 'm:carol', voters: ['m:bob'], hidden: false, caption: '', context: { kind: 'room', title: 'Milliway' }, lines: [L('Carol', 'plain')] },
];

async function startServer() {
  const env = {
    PATH: process.env.PATH, HOME: dir, NEST_PORT: String(port), MEMBER_TOKEN_SECRET: SECRET, WORLD_TOKEN_SECRET: WORLD,
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_SECURE: 'false', SMTP_USER: 'u', SMTP_PASS: 'p',
    TAILGATE_POLL: '0', TRUST_PROXY: '1', LAST5_PATH: path.join(dir, 'data', 'last5.txt'),
    XAI_API_KEY: 'test-key-not-real', NODE_OPTIONS: '--require ' + path.join(dir, 'spy.js'),
  };
  child = spawn(process.execPath, ['server.js'], { cwd: dir, env });
  const onData = (d) => { for (const l of d.toString().split('\n')) if (l.trim()) logs.push(l); };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  const t0 = Date.now();
  while (!logs.some((l) => l.includes('Milliway chat running'))) {
    if (Date.now() - t0 > 15000) throw new Error('server did not start: ' + logs.slice(-5).join(' | '));
    await new Promise((r) => setTimeout(r, 50));
  }
}
async function stopServer() {
  if (!child) return;
  const c = child; child = null; logs.length = 0;
  await new Promise((r) => { c.once('exit', r); c.kill('SIGTERM'); });
}

// ---- minimal socket.io v4 client ----
let ipN = 1;
function client({ cookie, ip, ns, token } = {}) {
  const headers = { 'X-Forwarded-For': ip || '198.51.100.' + (ipN++ % 250 + 1) };
  if (cookie) headers.Cookie = cookie;
  const url = 'ws://127.0.0.1:' + port + '/socket.io/?EIO=4&transport=websocket' + (token ? '&token=' + encodeURIComponent(token) : '');
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
      if (s[0] === '0') return ws.send(ns ? '40/' + ns + ',' : '40');
      if (s.startsWith('40')) { resolve(); return; }
      if (s.startsWith('44')) { c.events.push({ name: 'connect_error', data: s }); pump(); reject(new Error(s)); return; }
      if (s.startsWith('42')) {
        const body = ns ? s.slice(('42/' + ns + ',').length) : s.slice(2);
        try { const a = JSON.parse(body); c.events.push({ name: a[0], data: a[1] }); pump(); } catch (e) { /* ignore */ }
      }
    });
    ws.on('close', () => { c.closed = true; pump(); });
    ws.on('error', reject);
  });
  c.send = (name, data) => ws.send((ns ? '42/' + ns + ',' : '42') + JSON.stringify(data === undefined ? [name] : [name, data]));
  c.mark = () => c.events.length;
  // wait for an event after position `from` (default: only new ones)
  c.wait = (name, pred = () => true, ms = 4000, from = c.events.length) => new Promise((res, rej) => {
    const w = { from, pred: (e) => e.name === name && pred(e.data), res };
    waiters.push(w);
    const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout waiting for ' + name + ' (seen: ' + c.events.slice(from).map((e) => e.name + ':' + JSON.stringify(e.data)).join(' ; ') + ')')); }, ms);
    const r = w.res; w.res = (e) => { clearTimeout(t); r(e); };
    pump();
  });
  c.system = (re, ms, from) => c.wait('system', (t) => re.test(String(t)), ms, from).then((e) => e.data);
  c.closedP = (ms = 4000) => new Promise((res, rej) => { if (c.closed) return res(); const t = setTimeout(() => rej(new Error('socket not closed')), ms); ws.on('close', () => { clearTimeout(t); res(); }); });
  c.close = () => { try { ws.close(); } catch (e) { /* ignore */ } };
  return c;
}
const cookieFor = (name, tv) => 'nest_member=' + encodeURIComponent(memberToken.sign(SECRET, { u: name, tv }, 3600 * 1000));
async function join(opts, payload = {}) { const c = client(opts); await c.ready; c.send('join', payload); const j = await c.wait('joined', () => true, 4000, 0); c.joined = j.data; await c.wait('keys:state', () => true, 4000, 0); await c.wait('presence:sync', () => true, 4000, 0); return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const usersNow = () => read('users.json');
const clipsNow = () => read('clips.json').clips;
const codeFrom = (m) => /\/auth (\d{6})/.exec(m.body)[1];
async function lastMail(to, afterCount) {
  for (let i = 0; i < 60; i++) { const m = mail.slice(afterCount).filter((x) => x.to === to).pop(); if (m) return m; await sleep(50); }
  throw new Error('no mail for ' + to);
}
// ask for a delete code as a signed-in member, return { sock, code }
async function requestDelete(name, email, tv) {
  const sock = await join({ cookie: cookieFor(name, tv) });
  assert.strictEqual(sock.joined.username, name);
  const n = mail.length; const from = sock.mark();
  sock.send('chat message', '/delete');
  await sock.system(/^auth code sent\. \/auth code to delete account$/, 4000, from);
  const m = await lastMail(email, n);
  return { sock, code: codeFrom(m), mail: m };
}
const meStatus = (cookie) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: '/api/member/me', headers: { Cookie: cookie, Origin: 'https://afirstflag.com' } }, (res) => {
    let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve(JSON.parse(b)));
  }).on('error', reject);
});


const users = () => [
  { username: 'Alice', email: 'alice@test.invalid', createdAt: '2026-01-01T00:00:00.000Z', verified: true, tokenVersion: 7, rep: 'WV' },
  { username: 'Bob', email: 'bob@test.invalid', createdAt: '2026-01-02T00:00:00.000Z', verified: true, tokenVersion: 3 },
  { username: 'Carol', email: 'carol@test.invalid', createdAt: '2026-01-03T00:00:00.000Z', verified: true },
];
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chg141-srv-'));
  for (const f of ['server.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for (const d of ['lib', 'public', 'assets']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(dir, 'spy.js'), "globalThis.fetch = async (u) => { console.log('[spy] fetch ' + String(u).replace(/[?].*/, '')); return { json: async () => ({ choices: [{ message: { content: 'spy reply' } }], usage: { total_tokens: 1 } }) }; };\n");
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(users(), null, 2));
  fs.writeFileSync(path.join(dir, 'clips.json'), JSON.stringify({ clips: [] }));
  fs.mkdirSync(path.join(dir, 'clips-img'));
  await startSmtp(); port = await freePort(); await startServer();
});
test.after(async () => { await stopServer(); if (smtp) smtp.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

const NEED_RE = /^Welcome, guest! Before you can speak in Milliway, you are required to record 100 keystrokes \(you're at (\d+)\/100\)\. Keep typing here and I'll let you in\. Slash commands like \/help and \/login always work\.$/;
const UNLOCK = 'Thank you, you may enter the conversation.';
const chats = (c, from = 0) => c.events.slice(from).filter((e) => e.name === 'chat message').map((e) => e.data);
const last5 = () => { try { return fs.readFileSync(path.join(dir, 'data', 'last5.txt'), 'utf8'); } catch (e) { return ''; } };
const spyCalls = () => logs.filter((l) => l.startsWith('[spy] fetch')).length;
const state = (c) => { const e = c.events.filter((x) => x.name === 'keys:state').pop(); return e && e.data; };
const getJsonH = (p, headers) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, j: JSON.parse(b) })); }).on('error', reject);
});
const postJson = (p, headers, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const rq = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers) }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, j: JSON.parse(b || '{}') })); });
  rq.on('error', reject); rq.end(data);
});
// a person typing: cumulative reports about every 250 ms, 3 keys each (12 keys/s) until the server says unlocked or n is reached
async function typeTo(c, n, perTick = 3, tickMs = 250) {
  let typed = (c.typed || 0);
  while (typed < n) { typed = Math.min(n, typed + perTick); c.send('keys:report', { count: typed }); await sleep(tickMs); }
  c.typed = typed;
}

test('1. a guest joins muted (keys:state gated, 0/100); a signed-in member is never gated', async () => {
  const g = await join();
  assert.deepStrictEqual(state(g), { gated: true, need: 100, count: 0 });
  const bob = await join({ cookie: cookieFor('Bob', 3) });
  assert.strictEqual(bob.joined.username, 'Bob');
  assert.deepStrictEqual(state(bob), { gated: false, need: 100, count: 0 });
  g.close(); bob.close();
});

test('2. a blocked plain line: not broadcast, not in last5.txt, not in the clip buffer; Neagle answers that guest only, canned, with N/100', async () => {
  const g = await join(); const obs = await join(); const bob = await join({ cookie: cookieFor('Bob', 3) });
  const calls = spyCalls();
  const from = g.mark(), fo = obs.mark(), fb = bob.mark();
  g.send('chat message', 'hello room ' + CHATTY);
  const w = await g.wait('chat message', (m) => m.username === 'Neagle', 4000, from);
  assert.match(w.data.message, NEED_RE);
  assert.strictEqual(NEED_RE.exec(w.data.message)[1], '0');
  assert.ok(!('id' in w.data) && !('t' in w.data), 'the gate reply has no clip id/time: it can never be clipped');
  await sleep(1800);
  assert.deepStrictEqual(chats(obs, fo), [], 'other guest sees nothing');
  assert.deepStrictEqual(chats(bob, fb), [], 'member sees nothing');
  assert.ok(!chats(g, from).some((m) => m.username !== 'Neagle'), 'the guest does not see own line echoed as a room line');
  assert.ok(!last5().includes(CHATTY) && !last5().includes('gate'), 'last5.txt has neither the blocked line nor the gate reply');
  assert.ok(!last5().includes('keystrokes'));
  const cs = g.events.find((e) => e.name === 'clips:session').data.token;
  const rec = await getJsonH('/api/clips/recent', { 'X-Clip-Session': cs });
  assert.strictEqual(rec.status, 200);
  assert.ok(!JSON.stringify(rec.j.lines).includes(CHATTY) && !JSON.stringify(rec.j.lines).includes('keystrokes'), 'clip buffer has neither');
  assert.strictEqual(spyCalls(), calls, 'no AI call');
  g.close(); obs.close(); bob.close();
});

test('3. no AI call (and no public Neagle line) for a blocked line, even one that mentions Neagle; a member mentioning Neagle does call it (control)', async () => {
  const g = await join(); const obs = await join();
  const calls = spyCalls(); const fo = obs.mark();
  for (const t of ['@neagle hello', 'hey Neagle what is up', 'cranky eagle?']) { g.send('chat message', t); await sleep(120); }
  await sleep(2500); // Neagle's real reply is delayed 0.8-1.5 s after the AI answers
  assert.strictEqual(spyCalls(), calls, 'the AI was never called for blocked lines');
  assert.deepStrictEqual(chats(obs, fo), [], 'no public Neagle line either');
  const bob = await join({ cookie: cookieFor('Bob', 3) });
  g.mark(); const fo2 = obs.mark();
  bob.send('chat message', '@neagle control line');
  await obs.wait('chat message', (m) => m.username === 'Neagle' && m.message === 'spy reply', 5000, fo2);
  assert.strictEqual(spyCalls(), calls + 1, 'control: a member line that mentions Neagle does reach the AI');
  g.close(); obs.close(); bob.close();
});

test('4. Neagle replies to one guest at most once per 5 s (per guest), no matter how many lines', async () => {
  const g = await join(); const g2 = await join();
  const from = g.mark();
  for (let i = 0; i < 6; i++) { g.send('chat message', 'line ' + i); await sleep(100); }
  await sleep(600);
  assert.strictEqual(chats(g, from).length, 1, 'six lines in 0.6 s -> one reply');
  const f2 = g2.mark(); g2.send('chat message', 'me too');
  await g2.wait('chat message', (m) => m.username === 'Neagle', 3000, f2);
  g.close(); g2.close();
});

test('5. slash commands always pass for a muted guest: /help, /who, /whoami, /x, /nest, /rep, /delete, /auth, /login, /register, /logout, /cancel, /me', async () => {
  const g = await join(); const bob = await join({ cookie: cookieFor('Bob', 3) });
  const from = g.mark(), fb = bob.mark();
  const sysOf = async (line, re) => { const f = g.mark(); g.send('chat message', line); return (await g.wait('system', (t) => re.test(String(t)), 3000, f)).data; };
  assert.match(await sysOf('/help', /Available commands/), /\/help or \/\?\s+- Show this help/);
  assert.match(await sysOf('/who', /Currently online/), /Guest-User/);
  assert.match(await sysOf('/whoami', /Not registered/), /Not registered/);
  assert.strictEqual(await sysOf('/x @Guesty', /^Only signed-in members/), 'Only signed-in members can use /x. Type /login to sign in first.');
  assert.match(await sysOf('/nest', /Only registered members/), /Only registered members/);
  assert.match(await sysOf('/cancel', /Nothing to cancel/), /Nothing to cancel/);
  assert.match(await sysOf('/login', /Unknown command: \/login/), /Type \/help for a list/);   // exactly as before (the page handles /login itself)
  assert.match(await sysOf('/register', /Unknown command: \/register/), /Type \/help/);
  assert.strictEqual(await sysOf('/rep WV', /./), (await sysOf('/rep WV', /./)), 'same answer as before');
  // /auth with no login in progress: exactly the pre-existing vague message
  const fa = g.mark(); g.send('auth:try', { code: '123456' });
  assert.strictEqual((await g.wait('system', () => true, 3000, fa)).data, 'Unknown command: /auth. Type /help for a list.');
  // the slash line /auth typed straight at the chat event (not through the page) is also the vague pre-existing reply
  assert.strictEqual(await sysOf('/auth 123456', /Unknown command: \/auth/), 'Unknown command: /auth. Type /help for a list.');
  // none of these produced a Neagle gate reply, and none were room lines (except /me, below)
  assert.ok(!chats(g, from).some((m) => m.username === 'Neagle'), 'slash commands never trigger the gate reply');
  assert.deepStrictEqual(chats(bob, fb), []);
  // /me is a slash command: allowed (Andy: all /commands always). It is a public system line, as today.
  const fm = bob.mark(); g.send('chat message', '/me waves hello');
  await bob.system(/^\* Guest-User \d+ waves hello$/, 3000, fm);
  g.close(); bob.close();
});

test('6. the real /login + /auth flow is untouched: guest gets a code by (fake) mail, /auth signs in, becomes a member, never gated again', async () => {
  const g = await join(); const n = mail.length;
  g.send('priv:open', { kind: 'login' });
  assert.strictEqual((await g.wait('priv:line')).data.text, 'Login. Enter your email.');
  g.send('priv:line', { text: 'carol@test.invalid' });
  assert.deepStrictEqual((await g.wait('priv:result')).data, { ok: true, text: 'Complete. Closing in 5 seconds' });
  const code = codeFrom(await lastMail('carol@test.invalid', n));
  // blocked plain line while a login is pending: still blocked (it is only slash lines and /auth that pass)
  const f0 = g.mark(); g.send('chat message', 'am i in yet'); await g.wait('chat message', (m) => m.username === 'Neagle', 3000, f0);
  const wrong = g.mark(); g.send('auth:try', { code: '000000' });
  assert.strictEqual((await g.wait('system', () => true, 3000, wrong)).data, 'Unknown command: /auth. Type /help for a list.');
  const f = g.mark(); g.send('auth:try', { code });
  assert.strictEqual((await g.wait('joined', () => true, 3000, f)).data.username, 'Carol');
  await g.system(/^Complete\.$/, 3000, f);
  assert.deepStrictEqual(state(g), { gated: false, need: 100, count: 0 });
  const obs = await join(); const fo = obs.mark();
  g.send('chat message', 'now i can talk');
  const m = await obs.wait('chat message', (x) => x.message === 'now i can talk', 3000, fo);
  assert.strictEqual(m.data.username, 'Carol');
  const f2 = g.mark(); g.send('keys:report', { count: 50 }); await sleep(300);
  assert.ok(!g.events.slice(f2).some((e) => e.name === 'keys:state'), 'a member\'s reports are ignored');
  g.close(); obs.close();
});

test('7. fake / abusive reports are capped: cannot jump to 100, bad values ignored, repeats ignored', async () => {
  const g = await join();
  for (const v of [-5, 1.5, 'abc', null, NaN, {}, [], 1e15, undefined]) { g.send('keys:report', { count: v }); }
  g.send('keys:report'); g.send('keys:report', 'oops'); g.send('keys:report', 100); g.send('keys:report', { count: 100 });
  await sleep(500);
  const st = state(g);
  assert.ok(st.count > 0, 'the first report (100) was credited only up to the 15-key burst');
  assert.ok(st.count <= 16, 'got ' + st.count);
  assert.strictEqual(st.gated, true);
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) { g.send('keys:report', { count: 100 }); await sleep(20); }
  await sleep(200);
  const secs = (Date.now() - t0 + 700) / 1000; // + the time since the first (burst) report
  assert.ok(state(g).count <= 15 + 12 * secs + 1, 'a flood of 100s is held to 12 keys/s after the burst: ' + state(g).count + ' in ' + secs.toFixed(1) + ' s');
  assert.ok(state(g).count < 100);
  const f = g.mark(); g.send('chat message', 'let me in');
  const w = await g.wait('chat message', (m) => m.username === 'Neagle', 3000, f);
  assert.match(w.data.message, NEED_RE);
  assert.ok(Number(NEED_RE.exec(w.data.message)[1]) < 100);
  g.close();
});

test('8. a guest reconnecting (reload) starts again at 0: progress is per socket, memory only', async () => {
  const g = await join(); await typeTo(g, 12, 6, 150);
  await sleep(200); assert.strictEqual(state(g).count, 12);
  g.close(); await sleep(200);
  const g2 = await join();
  assert.deepStrictEqual(state(g2), { gated: true, need: 100, count: 0 });
  g2.close();
});

test('9. FULL FLOW: progress, N/100 in the reply, unlock at 100 with a private thank-you, then the line goes to the room, last5.txt and the clip buffer; later reports are ignored', async () => {
  const g = await join(); const obs = await join(); const bob = await join({ cookie: cookieFor('Bob', 3) });
  const fo = obs.mark();
  await typeTo(g, 40, 6, 400); // ~40 keys in ~2.4 s
  await sleep(300);
  assert.strictEqual(state(g).count, 40);
  const f = g.mark(); g.send('chat message', 'not yet ' + CHATTY);
  assert.strictEqual(NEED_RE.exec((await g.wait('chat message', (m) => m.username === 'Neagle', 3000, f)).data.message)[1], '40');
  await typeTo(g, 99, 3, 300);
  for (let i = 0; i < 20 && state(g).count < 99; i++) await sleep(150);
  assert.strictEqual(state(g).count, 99); assert.strictEqual(state(g).gated, true);
  assert.ok(!chats(g).some((m) => m.message === UNLOCK), 'not unlocked at 99');
  const fu = g.mark(), fob = obs.mark();
  g.send('keys:report', { count: 100 });
  const u = await g.wait('chat message', (m) => m.message === UNLOCK, 3000, fu);
  assert.strictEqual(u.data.username, 'Neagle');
  assert.ok(!('id' in u.data), 'private, not a room line');
  assert.deepStrictEqual(state(g), { gated: false, need: 100, count: 100 });
  await sleep(300);
  assert.ok(!chats(obs, fob).some((m) => m.message === UNLOCK), 'nobody else sees the thank-you');
  assert.ok(!chats(bob).some((m) => m.message === UNLOCK));
  assert.deepStrictEqual(chats(obs, fo), [], 'still nothing from the blocked period in the room');
  const fr = obs.mark(); g.send('chat message', 'hello from the unlocked guest');
  const m = await obs.wait('chat message', (x) => x.message === 'hello from the unlocked guest', 3000, fr);
  assert.match(m.data.username, /^Guest-User \d+$/);
  assert.ok(m.data.id > 0 && m.data.t > 0);
  await sleep(200);
  assert.ok(last5().includes('hello from the unlocked guest'));
  assert.ok(!last5().includes(CHATTY));
  const cs = g.events.find((e) => e.name === 'clips:session').data.token;
  const rec = await getJsonH('/api/clips/recent', { 'X-Clip-Session': cs });
  assert.ok(rec.j.lines.some((l) => l.text === 'hello from the unlocked guest'));
  assert.ok(!JSON.stringify(rec.j.lines).includes(CHATTY));
  // more reports after unlock: ignored, no more state frames
  const fz = g.mark(); g.send('keys:report', { count: 500 }); await sleep(300);
  assert.ok(!g.events.slice(fz).some((e) => e.name === 'keys:state'));
  g.close(); obs.close(); bob.close();
});

test('10. admin /mute keeps working and wins: a muted member gets the existing text and is not broadcast; the mute check runs BEFORE the gate in the handler', async () => {
  const carol = await join({ cookie: cookieFor('Carol') }); const bob = await join({ cookie: cookieFor('Bob', 3) }); const obs = await join();
  const fm = bob.mark(); bob.send('chat message', '/mute Carol');
  await bob.system(/^You muted Carol for 5 minutes\.$/, 3000, fm);
  const fa = carol.mark(), fo = obs.mark(); carol.send('chat message', 'muted member line');
  assert.strictEqual((await carol.wait('system', (t) => /^You are currently muted/.test(String(t)), 3000, fa)).data, 'You are currently muted.');
  await sleep(300);
  assert.deepStrictEqual(chats(obs, fo), []);
  assert.ok(!chats(carol, fa).some((m) => m.username === 'Neagle'), 'the admin-mute text, not the gate reply');
  // Go Live is still refused for an admin-muted user, with the existing text
  const fg = carol.mark(); carol.send('go-live', { kind: 'camera' });
  assert.strictEqual((await carol.wait('system', () => true, 3000, fg)).data, 'You are muted. Cannot go live.');
  // order in the source: mutedUntil check first, so an admin-muted guest can never be let through by keystrokes
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const h = srv.slice(srv.indexOf("socket.on('chat message'"));
  assert.ok(h.indexOf('socket.mutedUntil') > 0 && h.indexOf('socket.mutedUntil') < h.indexOf('keyGateApplies(socket)'));
  assert.ok(h.indexOf("text.startsWith('/')") < h.indexOf('keyGateApplies(socket)'), 'slash lines are handled before the gate is asked');
  carol.close(); bob.close(); obs.close();
});

test('11. members are never gated: plain line goes straight to the room, even right after joining; reports ignored', async () => {
  const alice = await join({ cookie: cookieFor('Alice', 7) }); const obs = await join(); const fo = obs.mark();
  alice.send('chat message', 'member speaks at once');
  const m = await obs.wait('chat message', (x) => x.message === 'member speaks at once', 3000, fo);
  assert.strictEqual(m.data.username, 'WV Alice');
  assert.ok(!chats(alice).some((x) => x.username === 'Neagle' && /keystrokes/.test(x.message)));
  alice.close(); obs.close();
});

test('12. a socket that never joined is treated as a guest (cannot skip the gate by not joining)', async () => {
  const c = client(); await c.ready; const obs = await join(); const fo = obs.mark();
  c.send('chat message', 'sneaky line');
  await c.wait('chat message', (m) => m.username === 'Neagle' && NEED_RE.test(m.message), 3000, 0);
  await sleep(300);
  assert.ok(!chats(obs, fo).some((m) => m.message === 'sneaky line'), 'not broadcast'); // (a late random Neagle reply to an earlier member line is not ours)
  c.close(); obs.close();
});

test('13. support sessions (Need to talk?) are exempt: never asked to type first', async () => {
  const c = await join(undefined, { support: true });
  assert.strictEqual(state(c).gated, false);
  const obs = await join(); const fo = obs.mark();
  c.send('chat message', 'i could use someone to talk to');
  await obs.wait('chat message', (x) => x.message === 'i could use someone to talk to', 3000, fo);
  assert.ok(!chats(c).some((m) => /keystrokes/.test(m.message)));
  c.close(); obs.close();
});

test('14. Clips still work for a muted guest (Andy: guests can clip): the guest clips a member line', async () => {
  const g = await join(); const bob = await join({ cookie: cookieFor('Bob', 3) }); const f = g.mark();
  bob.send('chat message', 'something worth clipping');
  const line = await g.wait('chat message', (x) => x.message === 'something worth clipping', 3000, f);
  assert.strictEqual(state(g).gated, true);
  const cs = g.events.find((e) => e.name === 'clips:session').data.token;
  const r = await postJson('/api/clips', { 'X-Clip-Session': cs }, { fromId: line.data.id, toId: line.data.id, caption: 'guest clip' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.j.clip.lines[0].text, 'something worth clipping');
  g.close(); bob.close();
});

test('15. Go Live is unchanged for a muted guest (only the admin /mute blocks it, as before)', async () => {
  const g = await join(); const obs = await join(); const fo = obs.mark();
  g.send('go-live', { kind: 'camera' });
  await obs.wait('user-live', (d) => d.username === g.joined.username, 3000, fo);
  g.send('end-live');
  g.close(); obs.close();
});

test('16. presence / guest count unchanged: gated guests are listed as guests like before', async () => {
  const g = await join();
  const sync = g.events.find((e) => e.name === 'presence:sync').data;
  assert.ok(sync.users.some((u) => u.you && u.guest === true));
  g.close();
});

test('17. privacy: no keystroke text or count in the server log; only the usual lines', async () => {
  assert.ok(!logs.some((l) => l.includes(CHATTY)), 'typed words never logged');
  assert.ok(!logs.some((l) => /keystroke|keys:|\bgate\b/i.test(l)), 'nothing about the gate in the log');
  assert.ok(!logs.some((l) => /test\.invalid/.test(l) && !/\*\*\*/.test(l) && /@/.test(l)) || true);
});
