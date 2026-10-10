// CHG-106: ONE real Google Safe Browsing call (needs GOOGLE_SAFE_BROWSING_KEY in the environment; skipped without it).
// Run: npm run test:live
const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/safeLink');
const dns = require('dns');
const key = process.env.GOOGLE_SAFE_BROWSING_KEY;
// Sandboxes with fake-IP DNS (every name -> 198.18.x.x, a reserved range) set FAKE_DNS=1 so the DNS guard
// (unit-tested separately) doesn't refuse every name. Not needed on the VPS.
const lookup = process.env.FAKE_DNS === '1'
  ? (h, o, cb) => dns.lookup(h, o, (e, a) => (e ? cb(e) : cb(null, (Array.isArray(a) ? a : [{ address: a, family: 4 }]).map((x) => ({ address: x.address.startsWith('198.18.') ? '93.184.215.14' : x.address, family: x.family })))))
  : dns.lookup;

test('live: Google test malware page is danger, afirstflag.com is not', { skip: !key && 'no GOOGLE_SAFE_BROWSING_KEY' }, async () => {
  const deps = { key, lookup };
  const bad = await L.check('http://testsafebrowsing.appspot.com/s/malware.html', deps);
  assert.strictEqual(bad.verdict, 'danger', JSON.stringify(bad.reasons));
  assert.ok(bad.threats.includes('MALWARE'));
  const good = await L.check('https://afirstflag.com/', deps);
  assert.notStrictEqual(good.verdict, 'danger');
  assert.strictEqual(good.verdict, 'safe', JSON.stringify(good.reasons));
});
