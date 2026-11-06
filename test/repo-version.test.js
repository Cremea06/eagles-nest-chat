// CHG-164: tests for lib/repoVersion.js (GET /api/repo-version). Fetch is mocked; no real GitHub calls. Run: npm test.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createRepoVersion, parseCommit, shortSha } = require('../lib/repoVersion');

function serve(opts = {}) {
  const app = express();
  const rv = createRepoVersion(Object.assign({ trustProxy: false }, opts));
  app.all('/api/repo-version', (req, res) => rv.handler(req, res));
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({ s, rv, close: () => {
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      return new Promise((r) => s.close(r));
    }}));
  });
}
const url = (s) => 'http://127.0.0.1:' + s.address().port + '/api/repo-version';

const SAMPLE = {
  sha: '3ef11c95b31fecfcdaf4d8b60363484f37c6cc96',
  html_url: 'https://github.com/Cremea06/eagles-nest-chat/commit/3ef11c95b31fecfcdaf4d8b60363484f37c6cc96',
  commit: { committer: { date: '2026-11-05T22:54:00Z' }, author: { date: '2026-11-05T22:50:00Z' } }
};

function okFetch(body) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => body
  });
}

test('shortSha and parseCommit shape', () => {
  assert.strictEqual(shortSha('abc'), null);
  assert.strictEqual(shortSha(SAMPLE.sha), '3ef11c9');
  const p = parseCommit(SAMPLE);
  assert.deepStrictEqual(p, {
    available: true,
    sha: '3ef11c9',
    date: '2026-11-05T22:54:00Z',
    url: SAMPLE.html_url
  });
  assert.strictEqual(parseCommit(null), null);
  assert.strictEqual(parseCommit({ sha: 'deadbeef' }), null);
});

test('GET returns only sha/date/url when available; no full sha leak beyond short', async () => {
  const { s, close } = await serve({ fetch: okFetch(SAMPLE) });
  const r = await fetch(url(s));
  const j = await r.json();
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(j, {
    available: true,
    sha: '3ef11c9',
    date: '2026-11-05T22:54:00Z',
    url: SAMPLE.html_url
  });
  assert.strictEqual(j.sha.length, 7); // response sha is short; full sha may appear only inside url
  assert.ok(j.url.includes(SAMPLE.sha));
  assert.strictEqual(r.headers.get('x-powered-by'), null);
  assert.match(r.headers.get('cache-control'), /no-store/);
  await close();
});

test('cache: second call within cache window does not re-fetch', async () => {
  let calls = 0;
  let t = 1000;
  const fetchFn = async () => { calls += 1; return okFetch(SAMPLE)(); };
  const { s, rv, close } = await serve({ fetch: fetchFn, now: () => t, cacheMs: 60 * 60 * 1000 });
  assert.deepStrictEqual(await (await fetch(url(s))).json(), {
    available: true, sha: '3ef11c9', date: '2026-11-05T22:54:00Z', url: SAMPLE.html_url
  });
  assert.strictEqual(calls, 1);
  t += 30 * 60 * 1000;
  assert.strictEqual((await (await fetch(url(s))).json()).sha, '3ef11c9');
  assert.strictEqual(calls, 1);
  t += 31 * 60 * 1000; // past 1 h
  assert.strictEqual((await (await fetch(url(s))).json()).sha, '3ef11c9');
  assert.strictEqual(calls, 2);
  assert.strictEqual(rv.CACHE_MS, 60 * 60 * 1000);
  await close();
});

test('failure with no prior cache -> {available:false}', async () => {
  const { s, close } = await serve({
    fetch: async () => ({ ok: false, status: 503, json: async () => ({ message: 'down' }) })
  });
  assert.deepStrictEqual(await (await fetch(url(s))).json(), { available: false });
  await close();
});

test('failure after a good value keeps last good', async () => {
  let n = 0;
  const fetchFn = async () => {
    n += 1;
    if (n === 1) return okFetch(SAMPLE)();
    throw new Error('network');
  };
  let t = 0;
  const { s, close } = await serve({ fetch: fetchFn, now: () => t, cacheMs: 1000 });
  assert.strictEqual((await (await fetch(url(s))).json()).available, true);
  t = 2000; // expire cache
  const j = await (await fetch(url(s))).json();
  assert.deepStrictEqual(j, {
    available: true,
    sha: '3ef11c9',
    date: '2026-11-05T22:54:00Z',
    url: SAMPLE.html_url
  });
  assert.strictEqual(n, 2);
  await close();
});

test('throwing fetch with empty cache -> available false', async () => {
  const { s, close } = await serve({ fetch: async () => { throw new Error('boom'); } });
  assert.deepStrictEqual(await (await fetch(url(s))).json(), { available: false });
  await close();
});

test('rate limit: 30/min then 429 with Retry-After', async () => {
  const { s, close } = await serve({ fetch: okFetch(SAMPLE) });
  for (let i = 0; i < 30; i++) assert.strictEqual((await fetch(url(s))).status, 200);
  const r = await fetch(url(s));
  assert.strictEqual(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  await close();
});

test('POST is 405; OPTIONS is 204', async () => {
  const { s, close } = await serve({ fetch: okFetch(SAMPLE) });
  assert.strictEqual((await fetch(url(s), { method: 'POST' })).status, 405);
  assert.strictEqual((await fetch(url(s), { method: 'OPTIONS' })).status, 204);
  await close();
});
