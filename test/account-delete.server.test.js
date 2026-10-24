// CHG-138: the whole /delete flow against a REAL server process, on temp data only.
//  - The repo is copied to a temp dir (node_modules linked), so users.json / clips.json / clips-img / tombstones.json
//    are throwaway sample files. The copy's owner-email hash is replaced by the hash of a test address (the real owner
//    address is not known to the tests); nothing else is changed.
//  - Mail goes to a tiny fake SMTP server on 127.0.0.1 that keeps the messages in memory. Nothing is ever sent out.
//  - A minimal socket.io v4 client (over the `ws` package that socket.io already depends on) plays the browser.
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
async function join(opts) { const c = client(opts); await c.ready; c.send('join', {}); const j = await c.wait('joined'); c.joined = j.data; return c; }
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

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chg138-srv-'));
  for (const f of ['server.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for (const d of ['lib', 'public', 'assets']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const un = path.join(dir, 'lib', 'username.js'); let src = fs.readFileSync(un, 'utf8');
  const next = src.replace(/(andy: ')[0-9a-f]{64}(')/, '$1' + crypto.createHash('sha256').update(OWNER_EMAIL).digest('hex') + '$2');
  assert.notStrictEqual(next, src, 'owner hash patched in the temp copy');
  fs.writeFileSync(un, next);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(usersSeed(), null, 2));
  fs.writeFileSync(path.join(dir, 'clips.json'), JSON.stringify({ clips: clipsSeed() }));
  fs.mkdirSync(path.join(dir, 'clips-img'));
  fs.writeFileSync(path.join(dir, 'clips-img', 'AAAAAAAA-0123456789.png'), 'png');
  fs.writeFileSync(path.join(dir, 'clips-img', 'BBBBBBBB-0123456789.png'), 'png');
  fs.writeFileSync(path.join(dir, 'clips-img', 'CCCCCCCC-0123456789.png'), 'png');
  await startSmtp(); port = await freePort(); await startServer();
});
test.after(async () => { await stopServer(); if (smtp) smtp.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('guest /delete: no code, no mail, nothing changes', async () => {
  const g = await join();
  assert.match(g.joined.username, /^Guest-User \d+$/);
  const n = mail.length; const from = g.mark();
  g.send('chat message', '/delete');
  const t = await g.system(/signed-in members/, 4000, from);
  assert.ok(!/code/i.test(t));
  await sleep(300);
  assert.strictEqual(mail.length, n);
  g.send('auth:try', { code: '123456' });
  await g.system(/^Unknown command: \/auth/);
  assert.strictEqual(usersNow().length, usersSeed().length);
  g.close();
});

test('/help lists /delete', async () => {
  const g = await join(); const from = g.mark();
  g.send('chat message', '/help');
  assert.match(await g.system(/Available commands/, 4000, from), /\/delete\s+- Delete your account/);
  g.close();
});

test('member /delete: emailed delete code + the exact system line; login fields untouched; no echo to the room', async () => {
  const bob = await join({ cookie: cookieFor('Bob', 3) });
  const n = mail.length; const from = bob.mark();
  bob.send('chat message', '/delete');
  assert.strictEqual(await bob.system(/auth code sent/, 4000, from), 'auth code sent. /auth code to delete account');
  const m = await lastMail('bob@test.invalid', n);
  assert.match(m.subject, /deletion code/);
  assert.match(m.body, /delete your Milliway account/);
  assert.match(codeFrom(m), /^\d{6}$/);
  const rec = usersNow().find((u) => u.username === 'Bob');
  assert.ok(!('pendingCode' in rec) && !('deleteCode' in rec), 'no code stored on the user record');
  assert.ok(!bob.events.slice(from).some((e) => e.name === 'chat message'), 'the command is not a room line');
  bob.close();
});

test('wrong code, then 5-try lockout voids the code; account survives', async () => {
  const { sock, code } = await requestDelete('Dave', 'dave@test.invalid', 0);
  let from = sock.mark();
  sock.send('auth:try', { code: code === '111111' ? '222222' : '111111' });
  assert.match(await sock.system(/^Wrong code/, 4000, from), /auth code to delete account/);
  for (let i = 0; i < 3; i++) { from = sock.mark(); sock.send('auth:try', { code: '000000' }); await sock.system(/^Wrong code/, 4000, from); }
  from = sock.mark(); sock.send('auth:try', { code: '000000' });
  await sock.system(/^Too many wrong codes\. Type \/delete/, 4000, from); // 5th wrong try
  from = sock.mark(); sock.send('auth:try', { code }); // the right code is void now
  await sock.system(/^Unknown command: \/auth/, 4000, from);
  assert.ok(usersNow().some((u) => u.username === 'Dave'));
  assert.ok(!sock.closed);
  sock.close();
});

test('purpose mixing: a login code cannot delete, a delete code cannot sign in', async () => {
  const { sock: A, code: D } = await requestDelete('Erin', 'erin@test.invalid', 0);
  // Erin's other device is a guest that runs the normal /login flow
  const G = await join(); const n = mail.length;
  G.send('priv:open', { kind: 'login' }); await G.wait('priv:line');
  G.send('priv:line', { text: 'erin@test.invalid' });
  assert.deepStrictEqual((await G.wait('priv:result')).data, { ok: true, text: 'Complete. Closing in 5 seconds' }); // login popup text unchanged
  const L = codeFrom(await lastMail('erin@test.invalid', n));
  assert.notStrictEqual(L, D);
  // login code typed where the delete code is expected: counted as wrong, deletes nothing
  let from = A.mark(); A.send('auth:try', { code: L });
  await A.system(/^Wrong code/, 4000, from);
  assert.ok(usersNow().some((u) => u.username === 'Erin') && !A.closed);
  // delete code typed on the login side: refused, still a guest
  from = G.mark(); G.send('auth:try', { code: D });
  await G.system(/^Unknown command: \/auth/, 4000, from);
  assert.ok(!G.events.slice(from).some((e) => e.name === 'joined'));
  assert.ok(usersNow().some((u) => u.username === 'Erin'));
  // the login code still signs in normally on the login side (login flow untouched)
  from = G.mark(); G.send('auth:try', { code: L });
  await G.system(/^Complete\.$/, 4000, from);
  assert.strictEqual((await G.wait('joined', () => true, 4000, from)).data.username, 'Erin');
  // and the delete code still works for the delete side
  from = A.mark(); A.send('auth:try', { code: D });
  await A.system(/^Your account has been deleted\./, 4000, from);
  await A.closedP();
  assert.ok(!usersNow().some((u) => u.username === 'Erin'));
  await G.closedP(); // the other signed-in tab of that member ended too
  assert.ok(true);
});

test('delete request rate limits: 3 per account per 10 min, 10 per network address', async () => {
  const s = await join({ cookie: cookieFor('Frank', 0), ip: '203.0.113.50' });
  const n = mail.length;
  for (let i = 0; i < 3; i++) { const from = s.mark(); s.send('chat message', '/delete'); await s.system(/^auth code sent/, 4000, from); }
  const from = s.mark(); s.send('chat message', '/delete');
  await s.system(/^Too many requests/, 4000, from);
  assert.strictEqual(mail.length - n, 3, 'the limited request sends nothing');
  s.close();
  // per network address: 10 requests in 10 minutes across accounts (each account is still under its own 3)
  const ip = '203.0.113.60'; let sent = 0;
  for (const nm of ['Hank', 'Ivy', 'Jake']) {
    const c = await join({ cookie: cookieFor(nm, 0), ip });
    for (let i = 0; i < 3; i++) { const f = c.mark(); c.send('chat message', '/delete'); await c.system(/^auth code sent/, 4000, f); sent++; }
    c.close();
  }
  const k = await join({ cookie: cookieFor('Kim', 0), ip });
  let f = k.mark(); k.send('chat message', '/delete'); await k.system(/^auth code sent/, 4000, f); sent++; // 10th from this address
  assert.strictEqual(sent, 10);
  f = k.mark(); k.send('chat message', '/delete'); await k.system(/^Too many requests/, 4000, f); // 11th: address limit, not Kim's own
  k.close();
});

test('owner account: /delete is refused with a generic message and no mail; no code ever works', async () => {
  const o = await join({ cookie: cookieFor('Andy', 1) });
  assert.strictEqual(o.joined.username, 'Andy');
  const n = mail.length; let from = o.mark();
  o.send('chat message', '/delete');
  assert.strictEqual(await o.system(/cannot be deleted/, 4000, from), 'This account cannot be deleted from chat.');
  await sleep(300); assert.strictEqual(mail.length, n);
  from = o.mark(); o.send('auth:try', { code: '123456' });
  await o.system(/^Unknown command: \/auth/, 4000, from);
  assert.ok(usersNow().some((u) => u.username === 'Andy'));
  o.close();
});

test('successful delete: record, clips, png, votes, quoted names, sockets, presence, /nest, cookie, backup, audit; others untouched', async () => {
  const before = usersNow(); const clipsBefore = clipsNow();
  // sockets: Alice in two tabs (one live), Bob watching, Alice's /nest pass
  const cookie = cookieFor('Alice', 7);
  assert.deepStrictEqual(await meStatus(cookie), { member: true, name: 'Alice', rep: 'WV', display: 'WV Alice' });
  const bob = await join({ cookie: cookieFor('Bob', 3) });
  const tab2 = await join({ cookie });
  tab2.send('go-live', { kind: 'camera', allowClips: true });
  await bob.wait('user-live');
  const { sock: A, code } = await requestDelete('Alice', 'alice@test.invalid', 7);
  // a public line from Alice (last5 + buffer), then her /nest pass and world socket
  A.send('chat message', 'goodbye soon'); await bob.wait('chat message', (m) => /goodbye soon/.test(m.message));
  const nestFrom = A.mark(); A.send('chat message', '/nest');
  const pass = await A.system(/Nest World pass minted/, 4000, nestFrom);
  const tok = decodeURIComponent(/token=([^\s]+)/.exec(pass)[1]);
  const nest = client({ ns: 'nest', token: tok }); await nest.ready;
  await nest.wait('joined');
  const mark = bob.mark(); const aFrom = A.mark(); const t2From = tab2.mark();
  A.send('auth:try', { code });
  await A.system(/^Your account has been deleted\./, 4000, aFrom);
  await A.wait('account:deleted', () => true, 4000, aFrom);
  await Promise.all([A.closedP(), tab2.closedP(), nest.closedP()]);
  await tab2.wait('account:deleted', () => true, 4000, t2From);
  await bob.wait('presence:leave', () => true, 4000, mark);

  // record + others untouched (deep equal, nothing but Alice gone)
  const after = usersNow();
  assert.deepStrictEqual(after, before.filter((u) => u.username !== 'Alice'));
  assert.strictEqual(after.length, before.length - 1);
  // clips: Alice's clip gone, her png gone, her vote gone (tally 2 -> 1), quoted name anonymized, golive slot reset
  const c = clipsNow();
  assert.deepStrictEqual(c.map((x) => x.id), ['BBBBBBBB', 'CCCCCCCC']);
  assert.deepStrictEqual(c[0].voters, ['m:carol']);
  assert.deepStrictEqual(c[0].lines.map((l) => l.user), ['Former member', 'Bob']);
  assert.deepStrictEqual(c[0].context, { kind: 'room', title: 'Milliway' });
  assert.deepStrictEqual(c[1], clipsBefore[2], "Carol's clip is untouched");
  const imgs = fs.readdirSync(path.join(dir, 'clips-img')).sort();
  assert.deepStrictEqual(imgs, ['CCCCCCCC-0123456789.png'], 'png of the deleted clip and of the edited clip are gone');
  // live public lines no longer carry the name
  await sleep(200);
  const l5 = fs.readFileSync(path.join(dir, 'data', 'last5.txt'), 'utf8');
  assert.ok(!/Alice/.test(l5) && /Former member: goodbye soon/.test(l5), l5);
  // cookie no longer authenticates: me, and a fresh socket is a guest
  assert.deepStrictEqual(await meStatus(cookie), { member: false });
  const g = await join({ cookie });
  assert.match(g.joined.username, /^Guest-User \d+$/);
  g.close();
  // profile gone
  const prof = await new Promise((r) => http.get({ host: '127.0.0.1', port, path: '/api/profile/Alice' }, (res) => { res.resume(); r(res.statusCode); }));
  assert.strictEqual(prof, 404);
  // backup: one rolling copy of users.json made before the rewrite (with the record), mode 0600
  const bak = JSON.parse(fs.readFileSync(path.join(dir, 'users.json.bak-delete'), 'utf8'));
  assert.deepStrictEqual(bak, before);
  assert.strictEqual(fs.statSync(path.join(dir, 'users.json.bak-delete')).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(dir, 'users.json.bak-delete.tmp')) && !fs.existsSync(path.join(dir, 'users.json.tmp')));
  // audit line: counts + name, never an email or a code
  const audit = logs.filter((l) => l.startsWith('[account] deleted'));
  assert.deepStrictEqual(audit.filter((l) => /deleted Alice/.test(l)), ['[account] deleted Alice clips=1 votes=1 anonymized=1']);
  assert.ok(!logs.some((l) => /@test\.invalid/.test(l) && !/\w\*\*\*@test\.invalid/.test(l)), 'no full email in the log');
  assert.ok(!logs.some((l) => new RegExp(code).test(l)), 'delete code not logged');
  bob.close();
});

test('name tombstone: freed name cannot be registered (survives restart); expires after 90 days; new record gets a random tokenVersion; old cookie never works for the new owner', async () => {
  const oldCookie = cookieFor('Alice', 7);
  const tf = path.join(dir, 'tombstones.json');
  assert.ok(!/@/.test(fs.readFileSync(tf, 'utf8')), 'no email in tombstones');
  const tryRegister = async (name, email) => {
    const g = await join();
    g.send('priv:open', { kind: 'register' }); await g.wait('priv:line');
    const m = g.mark();
    g.send('priv:line', { text: name });
    const e = await g.wait('priv:line', () => true, 3000, m).catch(() => null); // 'Enter email.' when the name is accepted
    let result;
    if (e) { const m2 = g.mark(); g.send('priv:line', { text: email }); result = (await g.wait('priv:result', () => true, 4000, m2)).data; }
    else result = (await g.wait('priv:result', () => true, 4000, m)).data;
    g.close();
    return { result };
  };
  // blocked now (any case, and a lookalike)
  for (const nm of ['Alice', 'alice', 'Al1ce']) {
    const r = await tryRegister(nm, 'new1@test.invalid');
    assert.strictEqual(r.result.ok, false, nm);
    assert.match(r.result.text, /^Fail\./);
  }
  assert.ok(!usersNow().some((u) => /^al/i.test(u.username)));
  // blocked after a restart too (persisted)
  await stopServer(); await startServer();
  assert.strictEqual((await tryRegister('Alice', 'new1@test.invalid')).result.ok, false);
  // a different, free name still registers
  const okRes = await tryRegister('Zed Name', 'zed@test.invalid');
  assert.strictEqual(okRes.result.ok, true);
  const zed = usersNow().find((u) => u.username === 'Zed Name');
  assert.ok(Number.isInteger(zed.tokenVersion) && zed.tokenVersion > 100000 && zed.tokenVersion < 2147483647, 'random tokenVersion: ' + zed.tokenVersion);
  // expire the tombstone (90 days later), restart: the name is free, and the OLD cookie still cannot sign in as the new owner
  const ts = read('tombstones.json'); ts.tombstones.forEach((x) => { x.until = Date.now() - 1000; });
  fs.writeFileSync(tf, JSON.stringify(ts));
  await stopServer(); await startServer();
  const re = await tryRegister('Alice', 'alice2@test.invalid');
  assert.strictEqual(re.result.ok, true);
  const alice2 = usersNow().find((u) => u.username === 'Alice');
  assert.ok(alice2 && alice2.email === 'alice2@test.invalid');
  assert.ok(alice2.tokenVersion !== 7 && alice2.tokenVersion !== 0 && alice2.tokenVersion > 100000, 'new record has its own random tokenVersion');
  assert.deepStrictEqual(await meStatus(oldCookie), { member: false });
  const g = await join({ cookie: oldCookie });
  assert.match(g.joined.username, /^Guest-User \d+$/, 'old cookie is a guest, not the new Alice');
  g.close();
});
