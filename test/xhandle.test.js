// CHG-140: claimed X handle. Unit tests for lib/xhandle.js (validation), the profile API allow-list (lib/profile.js)
// and the profile page script (public/profile.js run against a tiny fake DOM). No network beyond 127.0.0.1; nothing
// here (or in the feature) ever talks to X. Run: npm test.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');
const X = require('../lib/xhandle');
const P = require('../lib/profile');

const ROOT = path.join(__dirname, '..');
const ok = (raw) => { const r = X.normalize(raw); assert.ok(r.ok, 'expected valid: ' + JSON.stringify(raw)); return r.handle; };
const bad = (raw, reason) => { const r = X.normalize(raw); assert.strictEqual(r.ok, false, 'expected invalid: ' + JSON.stringify(raw)); if (reason) assert.strictEqual(r.reason, reason, JSON.stringify(raw)); };

test('x1. valid handles keep their typed case', () => {
  assert.strictEqual(ok('Andy'), 'Andy');
  assert.strictEqual(ok('a'), 'a');
  assert.strictEqual(ok('_'), '_');
  assert.strictEqual(ok('__init__'), '__init__');
  assert.strictEqual(ok('Patriot_Pete99'), 'Patriot_Pete99');
  assert.strictEqual(ok('MiXeD_cAsE'), 'MiXeD_cAsE');
  assert.strictEqual(ok('123456789012345'), '123456789012345'); // 15 digits
});

test('x2. one leading @ is stripped; only one', () => {
  assert.strictEqual(ok('@Andy'), 'Andy');
  assert.strictEqual(ok('@a'), 'a');
  assert.strictEqual(ok('  @Andy  '), 'Andy');
  bad('@@Andy', 'invalid');
  bad('Andy@', 'invalid');
  bad('An@dy', 'invalid');
  bad('@ Andy', 'invalid');
});

test('x3. length: 1 to 15 characters', () => {
  assert.strictEqual(ok('abcdefghijklmno'), 'abcdefghijklmno'); // 15
  bad('abcdefghijklmnop', 'invalid');                           // 16
  bad('@abcdefghijklmnop', 'invalid');
  bad('x'.repeat(200), 'invalid');
  assert.strictEqual(X.MAX_LEN, 15);
});

test('x4. empty and non-strings', () => {
  bad('', 'empty'); bad('   ', 'empty'); bad('@', 'empty'); bad(' @ ', 'empty');
  bad(undefined, 'invalid'); bad(null, 'invalid'); bad(42, 'invalid'); bad({}, 'invalid'); bad(['a'], 'invalid');
});

test('x5. bad characters', () => {
  for (const s of ['has space', 'dash-ed', 'dot.ted', 'comma,', 'quo"te', "ap'os", 'a<b', 'a>b', 'a&b', 'a%41', 'a\\b', 'a/b', 'a:b', 'a;b', 'a#b', 'a?b', 'a=b', 'a+b', 'a$b', 'a!b', 'a*b', 'a(b', 'a`b', '<script>', 'tab\there', 'new\nline', 'nul\u0000l', 'a\u200bb', '\u200bab']) bad(s, 'invalid');
  assert.strictEqual(ok('abc\n'), 'abc'); // surrounding whitespace is trimmed; an inner newline is not allowed (above)
});

test('x6. unicode lookalikes and non-ASCII are refused (ASCII only)', () => {
  bad('\u0410ndy', 'invalid');          // Cyrillic A
  bad('\u0391ndy', 'invalid');          // Greek Alpha
  bad('\uFF21ndy', 'invalid');          // fullwidth A
  bad('\uFF3Fndy', 'invalid');          // fullwidth low line
  bad('caf\u00e9', 'invalid');          // accent
  bad('na\u0131ve', 'invalid');         // dotless i
  bad('\u212Aelvin', 'invalid');        // Kelvin sign (folds to K)
  bad('a\u0301bc', 'invalid');          // combining accent
  bad('\u{1D5D4}ndy', 'invalid');       // mathematical sans-serif bold A
  bad('\u202Eandy', 'invalid');         // right-to-left override
  bad('\u{1F985}eagle', 'invalid');     // emoji
  bad('\u4e2d\u6587', 'invalid');
  // none of these is ever "fixed up" by normalisation
  assert.strictEqual(X.normalize('\uFF21ndy').handle, undefined);
});

test('x7. URL and markup attempts are refused', () => {
  for (const s of ['https://x.com/Andy', 'http://evil.example', 'x.com/Andy', 'twitter.com/Andy', '@https://x.com/a', 'javascript:alert(1)', 'data:text/html,<b>', '//evil.example', 'Andy/status/1', 'Andy?ref=1', 'Andy#top', '@Andy.com', 'a@b.co', '"><img src=x onerror=alert(1)>', '<a href=x>', 'Andy%0d%0a', '../../etc/passwd', 'Andy\\..\\x']) bad(s, 'invalid');
});

test('x8. publicHandle only passes a stored value that still meets the rule', () => {
  assert.strictEqual(X.publicHandle('Andy'), 'Andy');
  for (const v of [undefined, null, '', 5, {}, [], '@Andy', 'Andy ', 'abc\n', 'a b', 'x'.repeat(16), 'https://x.com/a', '\u0410ndy', '"><script>']) assert.strictEqual(X.publicHandle(v), null);
});

// ---- profile API ----
function fixture() {
  return [
    { username: 'Patriot_Pete', email: 'pete@test.invalid', createdAt: '2026-09-01T14:00:00.000Z', verified: true, tokenVersion: 3, rep: 'WV', flagholder: true, xHandle: 'AndyHandle' },
    { username: 'NoHandle', email: 'nh@test.invalid', createdAt: '2026-09-02T00:00:00.000Z', verified: true },
    { username: 'EmptyHandle', email: 'eh@test.invalid', createdAt: '2026-09-03T00:00:00.000Z', verified: true, xHandle: '' },
    { username: 'EvilHandle', email: 'ev@test.invalid', createdAt: '2026-09-04T00:00:00.000Z', verified: true, xHandle: '"><img src=x onerror=alert(1)>' },
    { username: 'UrlHandle', email: 'uh@test.invalid', createdAt: '2026-09-05T00:00:00.000Z', verified: true, xHandle: 'https://evil.example/x' },
    { username: 'LongHandle', email: 'lh@test.invalid', createdAt: '2026-09-06T00:00:00.000Z', verified: true, xHandle: 'abcdefghijklmnop' },
    { username: 'NumHandle', email: 'nu@test.invalid', createdAt: '2026-09-07T00:00:00.000Z', verified: true, xHandle: 12345 },
    { username: 'Pending', email: 'pp@test.invalid', createdAt: '2026-09-08T00:00:00.000Z', verified: false, pendingCode: '123456', xHandle: 'ShouldBeHidden' },
    // every private field present at once, to prove none leaks
    { username: 'Loaded', email: 'loaded@test.invalid', createdAt: '2026-09-09T00:00:00.000Z', verified: true, tokenVersion: 9, rep: 'TX', flagholder: true, pendingCode: undefined, deleteCode: '999', secretNote: 'nope', xHandle: 'Loaded_1', xToken: 'tok', xUserId: '123', xFollowers: 99 },
  ];
}
function serve(users) {
  const app = express();
  const route = P.profileRoute(() => users, { trustProxy: false, limit: 1000 });
  app.get('/api/profile/:username', route.handler);
  return new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res({ s, route })); });
}
async function get(s, name) {
  const r = await fetch('http://127.0.0.1:' + s.address().port + '/api/profile/' + name);
  const text = await r.text();
  return { status: r.status, text, j: JSON.parse(text) };
}

test('x9. profile API: xHandle + xVerified:false only when set (typed case kept)', async (t) => {
  const { s } = await serve(fixture()); t.after(() => s.close());
  const r = await get(s, 'Patriot_Pete');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.j, { username: 'Patriot_Pete', tier: 'Member', joined: '2026-09-01', xHandle: 'AndyHandle', xVerified: false });
  for (const bad of ['email', 'tokenVersion', 'flagholder', 'rep', 'pete@test']) assert.ok(!r.text.includes(bad), bad);
});

test('x10. profile API: no handle -> no xHandle and no xVerified (output unchanged)', async (t) => {
  const { s } = await serve(fixture()); t.after(() => s.close());
  assert.deepStrictEqual((await get(s, 'NoHandle')).j, { username: 'NoHandle', tier: 'Member', joined: '2026-09-02' });
  assert.deepStrictEqual((await get(s, 'EmptyHandle')).j, { username: 'EmptyHandle', tier: 'Member', joined: '2026-09-03' });
});

test('x11. profile API: a hand-edited or corrupt stored value is never echoed (re-validated on output)', async (t) => {
  const { s } = await serve(fixture()); t.after(() => s.close());
  for (const n of ['EvilHandle', 'UrlHandle', 'LongHandle', 'NumHandle']) {
    const r = await get(s, n);
    assert.strictEqual(r.status, 200, n);
    assert.deepStrictEqual(Object.keys(r.j), ['username', 'tier', 'joined'], n);
    assert.ok(!/script|evil|img|abcdefg/.test(r.text.replace(n, '')), n);
  }
  assert.strictEqual((await get(s, 'Pending')).status, 404, 'unfinished sign-up stays hidden, handle and all');
});

test('x12. profile API output keys are exactly the allow-list; no other field (X data included) can leak', async (t) => {
  assert.deepStrictEqual([...P.PUBLIC_FIELDS], ['username', 'tier', 'joined', 'xHandle', 'xVerified']);
  const { s } = await serve(fixture()); t.after(() => s.close());
  const r = await get(s, 'Loaded');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.j).sort(), [...P.PUBLIC_FIELDS].sort());
  assert.deepStrictEqual(r.j, { username: 'Loaded', tier: 'Member', joined: '2026-09-09', xHandle: 'Loaded_1', xVerified: false });
  for (const bad of ['loaded@', 'email', 'tokenVersion', 'rep', 'flagholder', 'deleteCode', 'secretNote', 'xToken', 'xUserId', 'xFollowers', '999', 'tok']) assert.ok(!r.text.includes(bad), bad);
  // every response across the fixture only ever uses allow-listed keys
  for (const u of fixture()) {
    const x = await get(s, encodeURIComponent(u.username));
    if (x.status === 200) for (const k of Object.keys(x.j)) assert.ok(P.PUBLIC_FIELDS.includes(k), u.username + ' leaked ' + k);
  }
});

test('x13. profile cache: invalidate() shows a newly set handle at once (what saveUsers does)', async (t) => {
  const users = fixture();
  const { s, route } = await serve(users); t.after(() => s.close());
  assert.strictEqual((await get(s, 'NoHandle')).j.xHandle, undefined);
  users.find((u) => u.username === 'NoHandle').xHandle = 'Fresh_1';
  route.invalidate();
  assert.strictEqual((await get(s, 'NoHandle')).j.xHandle, 'Fresh_1');
  delete users.find((u) => u.username === 'NoHandle').xHandle;
  route.invalidate();
  assert.strictEqual((await get(s, 'NoHandle')).j.xHandle, undefined);
});

// ---- profile page: markup + script against a fake DOM ----
function runPage(apiBody, status = 200) {
  const els = {};
  const mk = (id, hidden) => (els[id] = { id, hidden: !!hidden, textContent: '', href: undefined });
  mk('name'); mk('tier', true); mk('joined'); mk('xline', true); mk('xnote', true); mk('xlink');
  const doc = { title: '', getElementById: (id) => els[id] };
  const ctx = {
    document: doc, location: { pathname: '/u/Andy' }, encodeURIComponent, decodeURIComponent,
    fetch: () => Promise.resolve({ status, json: () => Promise.resolve(apiBody) }),
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', 'profile.js'), 'utf8'), ctx);
  return new Promise((res) => setTimeout(() => res({ els, doc }), 30));
}

test('x14. profile page: handle shown as text, link built only from the checked handle', async () => {
  const { els } = await runPage({ username: 'Andy', tier: 'Member', joined: '2026-09-01', xHandle: 'AndyHandle', xVerified: false });
  assert.strictEqual(els.xline.hidden, false);
  assert.strictEqual(els.xnote.hidden, false);
  assert.strictEqual(els.xlink.textContent, '@AndyHandle');
  assert.strictEqual(els.xlink.href, 'https://x.com/AndyHandle');
});

test('x15. profile page: no handle -> no X line; hostile values are ignored (never in href or text)', async () => {
  let r = await runPage({ username: 'Andy', tier: 'Member' });
  assert.strictEqual(r.els.xline.hidden, true); assert.strictEqual(r.els.xlink.href, undefined);
  for (const h of ['"><img src=x onerror=alert(1)>', 'javascript:alert(1)', 'https://evil.example', 'a/../b', 'abcdefghijklmnop', '@Andy', '\u0410ndy', 'ab\n', '', 7, null, {}, ['a']]) {
    r = await runPage({ username: 'Andy', tier: 'Member', xHandle: h });
    assert.strictEqual(r.els.xline.hidden, true, JSON.stringify(h));
    assert.strictEqual(r.els.xlink.href, undefined, JSON.stringify(h));
    assert.strictEqual(r.els.xlink.textContent, '', JSON.stringify(h));
  }
});

test('x16. profile page markup: link has the exact rel + target, no inline script/style, explainer present', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'profile.html'), 'utf8');
  assert.match(html, /<a id="xlink" rel="nofollow noopener noreferrer ugc" target="_blank"><\/a>/);
  assert.match(html, /\(unverified\)/);
  assert.match(html, /Claimed by the member; not verified by Milliway\./);
  assert.ok(!/<script>/.test(html) && !/style=/.test(html) && !/href="http/.test(html), 'no inline script/style, no static external href');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'profile.js'), 'utf8');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) assert.ok(!js.includes(bad), bad);
  assert.match(js, /'https:\/\/x\.com\/' \+ p\.xHandle/);
  // no network call to X anywhere in the feature files
  for (const f of ['lib/xhandle.js', 'lib/profile.js', 'public/profile.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/api\.(x|twitter)\.com|require\('https?'\)|XMLHttpRequest/.test(src), f);
  }
});
