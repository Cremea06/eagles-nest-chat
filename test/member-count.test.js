// CHG-132: tests for lib/memberCount.js (GET /api/member-count). No network beyond 127.0.0.1. Run: npm test.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { memberCountRoute, countUsers } = require('../lib/memberCount');

function tmpUsers(data) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')), 'users.json');
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}
function serve(p, opts = {}) {
  const app = express();
  const r = memberCountRoute(p, Object.assign({ trustProxy: false }, opts));
  app.all('/api/member-count', r.handler);
  return new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res({ s, r })); });
}
const url = (s) => 'http://127.0.0.1:' + s.address().port + '/api/member-count';
const U = [
  { username: 'Andy', email: 'andy@example.com' }, { username: 'Pete', email: 'pete@example.com' },
  { username: 'Sam', email: 'sam@example.com' }, { username: 'Liz', email: 'liz@example.com' }
];

test('countUsers handles array, map and wrapper shapes', () => {
  assert.strictEqual(countUsers(U), 4);
  assert.strictEqual(countUsers({ andy: U[0], pete: U[1] }), 2);
  assert.strictEqual(countUsers({ users: U }), 4);
  assert.strictEqual(countUsers([U[0], null, 'x', 3]), 1);
  assert.strictEqual(countUsers(null), 0);
  assert.strictEqual(countUsers([]), 0);
});

test('GET returns only {members: N}, no names or emails, cache headers', async () => {
  const { s } = await serve(tmpUsers(U));
  const r = await fetch(url(s));
  const t = await r.text();
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(JSON.parse(t), { members: 4 });
  assert.ok(!/andy|pete|example/i.test(t));
  assert.match(r.headers.get('cache-control'), /max-age=60/);
  assert.strictEqual(r.headers.get('x-powered-by'), null);
  s.close();
});

test('CORS only for the two homepage origins, never credentials', async () => {
  const { s } = await serve(tmpUsers(U));
  for (const o of ['https://afirstflag.com', 'https://www.afirstflag.com']) {
    const r = await fetch(url(s), { headers: { Origin: o } });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), o);
    assert.strictEqual(r.headers.get('access-control-allow-credentials'), null);
    const p = await fetch(url(s), { method: 'OPTIONS', headers: { Origin: o } });
    assert.strictEqual(p.status, 204);
    assert.strictEqual(p.headers.get('access-control-allow-methods'), 'GET');
  }
  const bad = await fetch(url(s), { headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(bad.headers.get('access-control-allow-origin'), null);
  const post = await fetch(url(s), { method: 'POST' });
  assert.strictEqual(post.status, 405);
  s.close();
});

test('object-shaped users.json', async () => {
  const { s } = await serve(tmpUsers({ andy: U[0], pete: U[1], sam: U[2] }));
  assert.deepStrictEqual(await (await fetch(url(s))).json(), { members: 3 });
  s.close();
});

test('60 s cache, invalidate(), 503 when users.json was never readable', async () => {
  let t = 1000;
  const p = tmpUsers(U);
  const { s } = await serve(p, { now: () => t });
  assert.strictEqual((await (await fetch(url(s))).json()).members, 4);
  fs.writeFileSync(p, JSON.stringify(U.concat([{ username: 'New' }])));
  t += 30000; assert.strictEqual((await (await fetch(url(s))).json()).members, 4);
  t += 31000; assert.strictEqual((await (await fetch(url(s))).json()).members, 5);
  s.close();
  const p2 = path.join(path.dirname(p), 'missing.json');
  const { s: s2 } = await serve(p2);
  assert.strictEqual((await fetch(url(s2))).status, 503);
  s2.close();
});

test('rate limit: 30/min per client then 429 with Retry-After', async () => {
  const { s } = await serve(tmpUsers(U));
  for (let i = 0; i < 30; i++) assert.strictEqual((await fetch(url(s))).status, 200);
  const r = await fetch(url(s));
  assert.strictEqual(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  s.close();
});
