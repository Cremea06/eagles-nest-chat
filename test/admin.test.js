// CHG-173: unit tests for lib/adminAudit.js and lib/adminConsole.js (gate, overview shape, git commit reader,
// message rate). No network beyond 127.0.0.1. Run: npm test.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { createAudit, cleanDetail } = require('../lib/adminAudit');
const { createAdminConsole, createMessageRate, readGitCommit } = require('../lib/adminConsole');
const usernameRule = require('../lib/username');

const ROOT = path.join(__dirname, '..');

test('audit: ring keeps the newest 200, newest first, fixed types only', () => {
  let t = 1000;
  const a = createAudit({ now: () => t++ });
  for (let i = 0; i < 230; i++) a.add('chat_pause', { paused: i % 2 === 0, by: 'N' + i });
  assert.strictEqual(a.size(), 200);
  const l = a.list();
  assert.strictEqual(l.length, 200);
  assert.strictEqual(l[0].detail.by, 'N229');
  assert.strictEqual(l[199].detail.by, 'N30');
  assert.ok(l[0].seq > l[1].seq);
  assert.strictEqual(a.add('not_a_type', {}), null);
  assert.strictEqual(a.list(3).length, 3);
});

test('audit: only whitelisted short fields survive (no chat text, whisper, email, token)', () => {
  const d = cleanDetail({
    paused: true, by: 'Guest-User 1234\u0000\u200b', text: 'a secret whisper', message: 'hello', email: 'a@b.c',
    token: 'tok-1234567890abcdef', socketId: 'abc', ip: '1.2.3.4', name: 'x'.repeat(500), mode: 7, live: 'yes'
  });
  assert.deepStrictEqual(Object.keys(d).sort(), ['by', 'mode', 'name', 'paused']);
  assert.strictEqual(d.by, 'Guest-User 1234');
  assert.strictEqual(d.name.length, 64);
  assert.strictEqual(d.mode, '7');
  const a = createAudit();
  a.add('tailgate', { message: 'nope', mode: 'tailgate', embedId: 'v7abc' });
  assert.ok(!JSON.stringify(a.list()).includes('nope'));
});

test('message rate: counts timestamps only, per minute, 5 minute and 15 minute series', () => {
  let t = 10 * 60 * 1000;
  const m = createMessageRate({ now: () => t });
  m.note('human'); m.note('human'); m.note('neagle');
  t += 30 * 1000; m.note('human');
  let s = m.summary();
  assert.strictEqual(s.perMinute, 3);
  assert.strictEqual(s.last5min, 3);
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.neagleTotal, 1);
  assert.strictEqual(s.series.length, 15);
  t += 4 * 60 * 1000;
  s = m.summary();
  assert.strictEqual(s.perMinute, 0);
  assert.strictEqual(s.last5min, 3);
  t += 20 * 60 * 1000;
  assert.strictEqual(m.summary().last5min, 0);
  assert.strictEqual(m.summary().total, 3);
  assert.deepStrictEqual(Object.keys(m).sort(), ['note', 'summary']); // nothing that could hold a line
});

test('readGitCommit: loose ref, packed ref, detached HEAD, no .git', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'chg173-git-'));
  try {
    assert.strictEqual(readGitCommit(d), null);
    fs.mkdirSync(path.join(d, '.git', 'refs', 'heads'), { recursive: true });
    const sha = '82adb0f90082072333c5c08ffc6caf6bf6a6755d';
    fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    assert.strictEqual(readGitCommit(d), null); // ref missing
    fs.writeFileSync(path.join(d, '.git', 'packed-refs'), '# pack-refs\n' + sha + ' refs/heads/main\n');
    assert.strictEqual(readGitCommit(d), '82adb0f');
    fs.writeFileSync(path.join(d, '.git', 'refs', 'heads', 'main'), '9943e5e000000000000000000000000000000000\n');
    assert.strictEqual(readGitCommit(d), '9943e5e');
    fs.writeFileSync(path.join(d, '.git', 'HEAD'), sha + '\n');
    assert.strictEqual(readGitCommit(d), '82adb0f');
    fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'ref: refs/../../etc/passwd\n');
    assert.strictEqual(readGitCommit(d), null);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// A tiny app: the console router in front of the express default 404, like server.js.
function mini(over = {}) {
  const audit = createAudit();
  const sources = Object.assign({
    presence: () => [{ id: 'sock1', name: 'WV Andy', guest: false }, { id: 'sock2', name: 'Guest-User 4821', guest: true }],
    connected: () => 3, registered: () => 12, broadcasting: () => 0, editModeOn: () => false,
    chatPause: () => ({ paused: true, by: 'WV Andy' }), tailgatePlay: () => ({ playing: false, by: null, since: null }),
    tailgate: () => ({ mode: 'tailgate', override: 'on', live: false, embedId: 'v7fznxe', source: 'rumble', twitch: false, twitchChannel: 'zackrawrr' }),
    tailgateTokenSet: () => true, tailgatePolling: () => true,
    featured: () => ({ polling: true, cacheSeconds: 120, checkedAt: '2026-11-12T20:00:00.000Z', creators: [{ id: 'a', name: 'A', live: true, avatar: 'https://x', channel: 'https://y', watchUrl: 'https://rumble.com/vabc.html' }] }),
    whisperMembersOnly: () => false
  }, over.sources || {});
  const users = { owner: { username: 'Andy', email: 'o@test.invalid' }, member: { username: 'Alice', email: 'a@test.invalid' } };
  const c = createAdminConsole(Object.assign({
    dir: ROOT, audit, msgRate: createMessageRate(),
    resolveUser: (cookie) => users[String(cookie || '').replace(/^who=/, '')] || null,
    isOwnerEmail: (e) => e === 'o@test.invalid', sources
  }, over.opts || {}));
  const app = express();
  app.use(c.router);
  return { app, audit, c };
}
function listen(app) { return new Promise((r) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => r(s)); }); }
function get(s, p, cookie, method = 'GET') {
  return new Promise((res, rej) => {
    const rq = http.request({ host: '127.0.0.1', port: s.address().port, path: p, method, headers: cookie ? { Cookie: cookie } : {} }, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b }));
    });
    rq.on('error', rej); rq.end();
  });
}

test('gate: owner 200, everyone else the plain 404 (same as an unknown path), non-GET never handled', async () => {
  const { app } = mini();
  const s = await listen(app);
  try {
    const nf = await get(s, '/no-such-page');
    assert.strictEqual(nf.status, 404);
    for (const p of ['/admin', '/admin/', '/admin/admin.js', '/admin/admin.css', '/api/admin/overview', '/api/admin/audit', '/admin/nothing']) {
      for (const cookie of [null, 'who=member', 'who=ghost']) {
        const r = await get(s, p, cookie);
        assert.strictEqual(r.status, 404, p + ' ' + cookie);
        assert.strictEqual(r.body.replace('Cannot GET ' + p, 'Cannot GET X'), nf.body.replace('Cannot GET /no-such-page', 'Cannot GET X'), 'same 404 body');
        assert.strictEqual(r.headers['content-type'], nf.headers['content-type']);
        assert.strictEqual(r.headers['x-robots-tag'], undefined);
      }
      const owner = await get(s, p, 'who=owner');
      if (p === '/admin/nothing') assert.strictEqual(owner.status, 404); else assert.strictEqual(owner.status, 200, p);
    }
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const p of ['/admin', '/api/admin/overview', '/api/admin/audit']) {
        assert.strictEqual((await get(s, p, 'who=owner', m)).status, 404, m + ' ' + p);
      }
    }
  } finally { s.close(); }
});

test('overview: owner sees counts and public names only; sources with ids/emails are not echoed', async () => {
  const { app } = mini();
  const s = await listen(app);
  try {
    const r = await get(s, '/api/admin/overview', 'who=owner');
    const o = JSON.parse(r.body);
    assert.strictEqual(o.owner.name, 'Andy');
    assert.strictEqual(o.room.members, 1);
    assert.strictEqual(o.room.guests, 1);
    assert.deepStrictEqual(o.room.names.map((n) => n.name), ['WV Andy', 'Guest-User 4821']);
    assert.deepStrictEqual(o.room.chatPause, { paused: true, by: 'WV Andy' });
    assert.strictEqual(o.tailgate.tokenConfigured, true);
    assert.deepStrictEqual(o.featured.creators, [{ id: 'a', name: 'A', live: true }]);
    assert.ok(o.server.uptimeSec >= 0 && o.server.node === process.version);
    assert.ok(!/sock1|sock2|test\.invalid|https:\/\/x|watchUrl|avatar/.test(r.body));
    assert.match(r.headers['cache-control'], /no-store/);
    assert.match(r.headers['x-robots-tag'], /noindex/);
  } finally { s.close(); }
});

test('page: owner HTML is noindex, CSP without inline script, theme.js and no link to public pages', async () => {
  const { app, audit } = mini();
  const s = await listen(app);
  try {
    const r = await get(s, '/admin', 'who=owner');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.headers['content-security-policy'], /script-src 'self'/);
    assert.doesNotMatch(r.headers['content-security-policy'], /unsafe-inline/);
    assert.match(r.headers['x-robots-tag'], /noindex/);
    assert.match(r.body, /<meta name="robots" content="noindex/);
    assert.match(r.body, /src="\/theme\.js"/);
    assert.match(r.body, /data-theme-toggle/);
    assert.doesNotMatch(r.body, /<script>|onclick=|style=/);
    assert.ok(audit.list().some((e) => e.type === 'admin_view'));
    const js = await get(s, '/admin/admin.js', 'who=owner');
    assert.match(js.headers['content-type'], /javascript/);
    assert.doesNotMatch(js.body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    assert.doesNotMatch(js.body, /method:\s*['"](POST|PUT|DELETE|PATCH)/i);
  } finally { s.close(); }
});

test('rate limit: owner gets 429 past the cap, non-owner still just 404', async () => {
  const { lim } = { lim: require('../lib/serverStats').createRateLimiter({ limit: 5, windowMs: 60000 }) };
  const { app } = mini({ opts: { limiter: lim } });
  const s = await listen(app);
  try {
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await get(s, '/api/admin/overview', 'who=owner')).status);
    assert.deepStrictEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
    assert.strictEqual((await get(s, '/api/admin/overview', 'who=member')).status, 404);
  } finally { s.close(); }
});

test('owner check is the existing lib/username.js hash check (a normal email is not the owner)', () => {
  assert.strictEqual(usernameRule.isOwnerAccountEmail('alice@test.invalid'), false);
  assert.strictEqual(usernameRule.isOwnerAccountEmail(''), false);
  assert.strictEqual(usernameRule.isOwnerAccountEmail(undefined), false);
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(src, /isOwnerEmail: \(email\) => usernameRule\.isOwnerAccountEmail\(email\)/);
  const lib = fs.readFileSync(path.join(ROOT, 'lib', 'adminConsole.js'), 'utf8');
  assert.doesNotMatch(lib, /process\.env\.(?!TRUST_PROXY)/); // no new env switch or credential
});

test('console is read-only: no mutating route or write call in the module or the page script', () => {
  const lib = fs.readFileSync(path.join(ROOT, 'lib', 'adminConsole.js'), 'utf8');
  assert.doesNotMatch(lib, /router\.(post|put|delete|patch|all)\(/);
  assert.doesNotMatch(lib, /writeFile|appendFile|unlink|rename(Sync)?\(|child_process|execSync|spawn/);
});
