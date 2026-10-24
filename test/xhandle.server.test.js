// CHG-140: the /x (claimed X handle) flow against a REAL server process, on temp data only (same harness as the CHG-138
// /delete server test; /delete is used once here to prove the handle goes with the purged record).
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chg140-srv-'));
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


const xLine = (h) => 'Your X handle is now @' + h + ' (claimed, not verified). It shows on your profile page.';
const getJson = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* html */ } resolve({ status: res.statusCode, j, body: b, headers: res.headers }); }); }).on('error', reject);
});
const rec = (name) => usersNow().find((u) => u.username === name);
// send a chat line, return the first system reply that is not the join greeting (the greeting can land after the join)
async function ask(c, text, re) { const from = c.mark(); c.send('chat message', text); return (await c.wait('system', (t) => !/^Welcome to Milliway|joined the chat/.test(String(t)) && (!re || re.test(String(t))), 4000, from)).data; }

test('guest /x: harmless message, nothing written, no echo to the room', async () => {
  const g = await join();
  const before = JSON.stringify(usersNow());
  for (const line of ['/x @Guesty', '/x', '/x clear']) {
    const t = await ask(g, line);
    assert.strictEqual(t, 'Only signed-in members can use /x. Type /login to sign in first.');
  }
  await sleep(200);
  assert.strictEqual(JSON.stringify(usersNow()), before);
  assert.ok(!usersNow().some((u) => 'xHandle' in u));
  assert.ok(!g.events.some((e) => e.name === 'chat message'), 'commands are not room lines');
  g.close();
});

test('/help lists /x', async () => {
  const g = await join();
  const t = await ask(g, '/help', /Available commands/);
  assert.match(t, /\/x @handle\s+- Show a claimed X handle on your profile, e\.g\. \/x @handle; \/x clear removes it \(members\)/);
  assert.match(t, /\/delete\s+- Delete your account/);
  g.close();
});

test('member: /x with no args shows usage, then set (with and without @, case kept), show, same value, change', async () => {
  const bob = await join({ cookie: cookieFor('Bob', 3) });
  assert.strictEqual(await ask(bob, '/x'), 'Usage: /x @handle to show your X handle on your profile (claimed, not verified), or /x clear to remove it. You have not set one.');
  assert.strictEqual(await ask(bob, '/x clear'), 'You have no X handle set.');
  assert.ok(!('xHandle' in rec('Bob')));
  const n = mail.length;
  assert.strictEqual(await ask(bob, '/x @Bob_Rules'), xLine('Bob_Rules'));
  assert.strictEqual(rec('Bob').xHandle, 'Bob_Rules', 'typed case kept, @ stripped');
  // other fields of the record untouched
  assert.deepStrictEqual(Object.keys(rec('Bob')).sort(), ['createdAt', 'email', 'tokenVersion', 'username', 'verified', 'xHandle']);
  assert.strictEqual(await ask(bob, '/x'), 'Your claimed X handle is @Bob_Rules (not verified). /x @handle changes it, /x clear removes it.');
  assert.strictEqual(await ask(bob, '/x Bob_Rules'), 'Your X handle is already @Bob_Rules.');
  assert.strictEqual(await ask(bob, '/x bob_new'), xLine('bob_new'), 'no @ needed');
  assert.strictEqual(rec('Bob').xHandle, 'bob_new');
  assert.strictEqual(await ask(bob, '/X @BOB_NEW'), xLine('BOB_NEW'), 'command is case-insensitive; a case-only change is a change');
  assert.strictEqual(rec('Bob').xHandle, 'BOB_NEW');
  assert.strictEqual(mail.length, n, 'no mail');
  assert.ok(!bob.events.some((e) => e.name === 'chat message'), 'replies go to the sender only, never the room');
  assert.ok(!logs.some((l) => /bob@test\.invalid|\[x\].*BOB_NEW/i.test(l)), 'no email / handle in the log');
  assert.ok(logs.some((l) => l === '[x] set Bob'));
  bob.close();
});

test('invalid input: clear message, nothing stored, does not use up the rate limit', async () => {
  const kim = await join({ cookie: cookieFor('Kim') });
  const MSG = 'That is not a valid X handle. Use 1-15 letters, numbers or underscores, e.g. /x @handle.';
  for (const line of ['/x @abcdefghijklmnop', '/x bad-name', '/x @bad.name', '/x https://x.com/jack', '/x @@jack', '/x @', '/x \u0410ndy', '/x caf\u00e9', '/x <b>', '/x "><img', '/x @a%20b', '/x javascript:alert(1)', '/x x.com/jack']) {
    const t = await ask(kim, line);
    assert.ok(t === MSG || t.startsWith('Usage: /x'), line + ' -> ' + t);
  }
  assert.strictEqual(await ask(kim, '/x @'), MSG);
  assert.strictEqual(await ask(kim, '/x two words'), 'Usage: /x @handle to show your X handle on your profile (claimed, not verified), or /x clear to remove it.');
  assert.strictEqual(await ask(kim, '/x @' + 'a'.repeat(300)), MSG);
  assert.ok(!('xHandle' in rec('Kim')));
  for (let i = 1; i <= 5; i++) assert.strictEqual(await ask(kim, '/x @ok' + i), xLine('ok' + i)); // all 5 still allowed
  kim.close();
});

test('rate limit: 5 changes per member per hour (set or clear), then refused; other members unaffected; value unchanged', async () => {
  const dave = await join({ cookie: cookieFor('Dave') });
  const LIM = 'You have changed your X handle too many times. Try again in an hour.';
  for (let i = 1; i <= 4; i++) assert.strictEqual(await ask(dave, '/x @dave' + i), xLine('dave' + i));
  assert.strictEqual(await ask(dave, '/x clear'), 'Your X handle has been removed from your profile.'); // 5th change
  assert.ok(!('xHandle' in rec('Dave')));
  assert.strictEqual(await ask(dave, '/x @dave6'), LIM);
  assert.strictEqual(await ask(dave, '/x @dave7'), LIM);
  assert.ok(!('xHandle' in rec('Dave')), 'refused change was not stored');
  // a second tab of the same member shares the limit
  const dave2 = await join({ cookie: cookieFor('Dave') });
  assert.strictEqual(await ask(dave2, '/x @dave8'), LIM);
  // another member is not affected
  const erin = await join({ cookie: cookieFor('Erin') });
  assert.strictEqual(await ask(erin, '/x @erin1'), xLine('erin1'));
  // reading and invalid input still work while limited
  assert.match(await ask(dave, '/x'), /^Usage: \/x/);
  assert.match(await ask(dave, '/x bad-name'), /^That is not a valid X handle/);
  dave.close(); dave2.close(); erin.close();
});

test('/x clear removes the field from the record and the profile', async () => {
  const hank = await join({ cookie: cookieFor('Hank') });
  assert.strictEqual(await ask(hank, '/x @Hank_X'), xLine('Hank_X'));
  assert.ok('xHandle' in rec('Hank'));
  assert.strictEqual(await ask(hank, '/x clear'), 'Your X handle has been removed from your profile.');
  assert.ok(!('xHandle' in rec('Hank')), 'field removed, not set to an empty value');
  assert.deepStrictEqual((await getJson('/api/profile/Hank')).j, { username: 'Hank', tier: 'Member', joined: '2026-01-03' });
  assert.strictEqual(await ask(hank, '/x @clear'), xLine('clear'), '/x @clear claims a handle named clear (bare clear is the command)');
  hank.close();
});

test('profile API through the real server: shows xHandle + xVerified:false at once after /x, hides after clear; other members unchanged', async () => {
  const jake = await join({ cookie: cookieFor('Jake') });
  assert.deepStrictEqual((await getJson('/api/profile/Jake')).j, { username: 'Jake', tier: 'Member', joined: '2026-01-03' });
  await ask(jake, '/x @Jake_Says');
  const r = await getJson('/api/profile/Jake'); // saveUsers invalidated the profile cache
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.j, { username: 'Jake', tier: 'Member', joined: '2026-01-03', xHandle: 'Jake_Says', xVerified: false });
  assert.ok(!/@test\.invalid|tokenVersion|email/.test(r.body));
  assert.deepStrictEqual((await getJson('/api/profile/Ivy')).j, { username: 'Ivy', tier: 'Member', joined: '2026-01-03' });
  // the page itself is the same static file with the strict CSP (no inline anything)
  const page = await getJson('/u/Jake');
  assert.strictEqual(page.status, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.ok(!page.body.includes('Jake_Says'), 'the handle is never injected into the HTML, only fetched as JSON and set as text');
  await ask(jake, '/x clear');
  assert.strictEqual((await getJson('/api/profile/Jake')).j.xHandle, undefined);
  jake.close();
});

test('stored hostile value in users.json is never served by the API (hand edit / old data)', async () => {
  await stopServer();
  const us = usersNow(); us.find((u) => u.username === 'Ivy').xHandle = '"><img src=x onerror=alert(1)>'; us.find((u) => u.username === 'Frank').xHandle = 'Frank_OK';
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(us, null, 2));
  await startServer();
  assert.deepStrictEqual((await getJson('/api/profile/Ivy')).j, { username: 'Ivy', tier: 'Member', joined: '2026-01-03' });
  assert.strictEqual((await getJson('/api/profile/Frank')).j.xHandle, 'Frank_OK', 'a valid stored value survives a restart');
  const ivy = await join({ cookie: cookieFor('Ivy') });
  assert.match(await ask(ivy, '/x'), /^Usage: \/x/, 'a corrupt stored value counts as unset');
  assert.strictEqual(await ask(ivy, '/x clear'), 'Your X handle has been removed from your profile.', 'and clear removes it');
  assert.ok(!('xHandle' in rec('Ivy')));
  ivy.close();
});

test('/delete purge removes the whole record, so the xHandle goes with it (and the profile 404s)', async () => {
  const alice = await join({ cookie: cookieFor('Alice', 7) });
  assert.strictEqual(await ask(alice, '/x @Alice_X'), xLine('Alice_X'));
  assert.strictEqual(rec('Alice').xHandle, 'Alice_X');
  assert.strictEqual((await getJson('/api/profile/Alice')).j.xHandle, 'Alice_X');
  alice.close();
  const { sock, code } = await requestDelete('Alice', 'alice@test.invalid', 7);
  const from = sock.mark();
  sock.send('auth:try', { code });
  await sock.system(/^Your account has been deleted\./, 4000, from);
  await sock.closedP();
  assert.ok(!rec('Alice'), 'record gone');
  assert.ok(!JSON.stringify(usersNow()).includes('Alice_X'), 'handle appears nowhere in users.json');
  assert.strictEqual((await getJson('/api/profile/Alice')).status, 404);
  // the rolling delete backup is the only place it survives (same as every other field of the record)
  const bak = fs.readFileSync(path.join(dir, 'users.json.bak-delete'), 'utf8');
  assert.ok(bak.includes('Alice_X'));
  // a later registrant of the same name starts clean (record is new; the name is held for 90 days anyway)
  assert.ok(!usersNow().some((u) => u.xHandle === 'Alice_X'));
});
