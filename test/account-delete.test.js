// CHG-138: /delete helpers (lib/accountDelete.js and the purge hooks in lib/clips.js, lib/last5.js, lib/username.js).
// Fake clocks and temp files only; nothing is sent anywhere. The socket-level flow is in account-delete.server.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const A = require('../lib/accountDelete');
const clips = require('../lib/clips');
const { createLast5 } = require('../lib/last5');
const username = require('../lib/username');

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'chg138-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('delete code: single use, 5 tries then void, 10 minute expiry, new request replaces', () => {
  let t = 1000;
  const c = A.createDeleteCodes({ now: () => t, makeCode: (() => { let n = 100000; return () => String(n++); })() });
  assert.strictEqual(A.CODE_TTL_MS, 10 * 60 * 1000);
  assert.strictEqual(A.MAX_TRIES, 5);
  assert.strictEqual(c.check('al', '100000'), 'none');
  const code = c.issue('al');
  assert.strictEqual(code, '100000');
  assert.strictEqual(c.check('al', '000000'), 'wrong');
  assert.strictEqual(c.check('al', code), 'ok');
  assert.strictEqual(c.check('al', code), 'none', 'single use');
  // five wrong tries void the code, even for the right one afterwards
  const c2 = c.issue('al');
  for (let i = 0; i < 4; i++) assert.strictEqual(c.check('al', '999999'), 'wrong');
  assert.strictEqual(c.check('al', '999999'), 'locked');
  assert.strictEqual(c.check('al', c2), 'none');
  // a new request replaces the old code and resets the tries
  const c3 = c.issue('al'); const c4 = c.issue('al');
  assert.notStrictEqual(c3, c4);
  assert.strictEqual(c.check('al', c3), 'wrong');
  assert.strictEqual(c.check('al', c4), 'ok');
  // expiry: valid at 10:00 minus 1 ms, gone at exactly 10:00
  const c5 = c.issue('al'); t += 10 * 60 * 1000 - 1;
  assert.strictEqual(c.check('al', '000000'), 'wrong');
  t += 1;
  assert.strictEqual(c.check('al', c5), 'expired');
  assert.strictEqual(c.check('al', c5), 'none');
  // accounts do not share codes
  const x = c.issue('x'); c.issue('y');
  assert.strictEqual(c.check('y', x), 'wrong');
});

test('tombstones: hold a name 90 days (lookalikes too), persist, no email, expire', () => {
  const dir = tmp(); const file = path.join(dir, 'tombstones.json'); let t = 5000;
  const ts = A.createTombstones({ file, now: () => t });
  assert.strictEqual(A.TOMBSTONE_MS, 90 * 24 * 60 * 60 * 1000);
  assert.strictEqual(ts.has('Bob'), false);
  ts.add('Bob');
  assert.strictEqual(ts.has('Bob'), true);
  assert.strictEqual(ts.has('bob'), true);
  assert.strictEqual(ts.has('B0b'), true, 'lookalike folds to the same key');
  assert.strictEqual(ts.has('Bobby'), false);
  assert.ok(!/@/.test(fs.readFileSync(file, 'utf8')));
  assert.strictEqual((fs.statSync(file).mode & 0o777), 0o600);
  // a new process (reload) still holds it
  const again = A.createTombstones({ file, now: () => t + 89 * 86400000 });
  assert.strictEqual(again.has('Bob'), true);
  const later = A.createTombstones({ file, now: () => t + 90 * 86400000 });
  assert.strictEqual(later.has('Bob'), false);
  // cannot persist -> add() throws and holds nothing
  const bad = A.createTombstones({ file: path.join(dir, 'no', 'such', 'dir', 't.json'), now: () => t });
  assert.throws(() => bad.add('Zed'));
  assert.strictEqual(bad.has('Zed'), false);
});

test('backupFileAtomic copies via a temp file and replaces the old backup', () => {
  const dir = tmp(); const src = path.join(dir, 'users.json'); const dest = src + '.bak-delete';
  assert.strictEqual(A.backupFileAtomic(src, dest), false, 'nothing to back up');
  fs.writeFileSync(src, '[1]'); assert.strictEqual(A.backupFileAtomic(src, dest), true);
  fs.writeFileSync(src, '[2]'); A.backupFileAtomic(src, dest);
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), '[2]');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['users.json', 'users.json.bak-delete']);
  assert.strictEqual((fs.statSync(dest).mode & 0o777), 0o600);
});

test('nameMatcher: Name, WV Name, Name (flagholder); not other names or non-state prefixes', () => {
  const m = A.nameMatcher('Alice');
  for (const s of ['Alice', 'alice', 'WV Alice', 'wv alice', 'Alice (flagholder)', 'TX Alice (flagholder)']) assert.ok(m(s), s);
  for (const s of ['Alicia', 'Bob', 'XX Alice', 'Neagle', 'Alice B', 'Guest-User 1234', '', null]) assert.ok(!m(s), String(s));
});

test('clip store purgeMember: own clips, votes (tally), Go Live slot, quoted display names; one save; others untouched', () => {
  const dir = tmp(); const file = path.join(dir, 'clips.json');
  const L = (user, text) => ({ user, text, t: 1 });
  const seed = [
    { id: 'AAAAAAAA', createdAt: 'x', clipper: 'WV Alice', clipperKey: 'm:alice', voters: ['m:bob'], hidden: false, caption: '', context: { kind: 'room' }, lines: [L('WV Alice', 'hi')] },
    { id: 'BBBBBBBB', createdAt: 'x', clipper: 'Bob', clipperKey: 'm:bob', voters: ['m:alice', 'm:carol', 'g:abc'], hidden: false, caption: 'c', context: { kind: 'golive', broadcaster: 'Alice', title: 'Alice live in Milliway' }, lines: [L('WV Alice', 'x'), L('Bob', 'Alice is great'), L('Alice (flagholder)', 'y')] },
    { id: 'CCCCCCCC', createdAt: 'x', clipper: 'Carol', clipperKey: 'm:carol', voters: ['m:bob'], hidden: false, caption: '', context: { kind: 'room' }, lines: [L('Carol', 'plain')] },
    { id: 'DDDDDDDD', createdAt: 'x', clipper: 'Guest-User 1', clipperKey: 'g:zz', voters: [], hidden: true, caption: '', context: { kind: 'room' }, lines: [L('Bob', 'ok')] },
  ];
  fs.writeFileSync(file, JSON.stringify({ clips: seed }));
  const before = JSON.parse(fs.readFileSync(file, 'utf8')).clips;
  const store = clips.createClipStore({ file });
  const r = store.purgeMember({ key: 'm:alice', broadcaster: 'Alice', matchUser: A.nameMatcher('Alice'), former: 'Former member' });
  assert.deepStrictEqual(r.removed, ['AAAAAAAA']);
  assert.deepStrictEqual(r.voted, ['BBBBBBBB']);
  assert.deepStrictEqual(r.stripped, ['BBBBBBBB']);
  assert.deepStrictEqual(r.anonymized, ['BBBBBBBB']);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8')).clips;
  assert.deepStrictEqual(disk.map((c) => c.id), ['BBBBBBBB', 'CCCCCCCC', 'DDDDDDDD']);
  const b = disk[0];
  assert.deepStrictEqual(b.voters, ['m:carol', 'g:abc']); // tally 3 -> 2
  assert.deepStrictEqual(b.context, { kind: 'room', title: 'Milliway' });
  assert.deepStrictEqual(b.lines.map((l) => l.user), ['Former member', 'Bob', 'Former member']);
  assert.strictEqual(b.lines[1].text, 'Alice is great', 'free text is left alone');
  assert.deepStrictEqual(disk[1], before[2]);
  assert.deepStrictEqual(disk[2], before[3]);
  // nothing to do -> no rewrite
  const mtime = fs.statSync(file).mtimeMs; fs.utimesSync(file, 1, 1);
  const none = store.purgeMember({ key: 'm:nobody', broadcaster: 'Nobody', matchUser: A.nameMatcher('Nobody'), former: 'Former member' });
  assert.deepStrictEqual(none, { removed: [], voted: [], anonymized: [], stripped: [] });
  assert.strictEqual(fs.statSync(file).mtimeMs, 1000);
  assert.ok(mtime > 1000);
});

test('recent-line buffer and last5 tail show a deleted member as Former member', async () => {
  const buf = clips.createRecentBuffer();
  buf.add('WV Alice', 'a'); buf.add('Bob', 'b'); buf.add('Alice', 'c');
  assert.strictEqual(buf.redact(A.nameMatcher('Alice'), 'Former member'), 2);
  assert.deepStrictEqual(buf.recent().map((l) => l.user), ['Former member', 'Bob', 'Former member']);
  const dir = tmp(); const l5 = createLast5(path.join(dir, 'last5.txt')); l5.init();
  l5.record('WV Alice', 'one: two'); l5.record('Bob', 'Alice said hi'); l5.record('Alice (flagholder)', 'x');
  assert.strictEqual(l5.redact(A.nameMatcher('Alice'), 'Former member'), 2);
  await l5.flush();
  assert.strictEqual(fs.readFileSync(path.join(dir, 'last5.txt'), 'utf8'), 'Former member: one: two\nBob: Alice said hi\nFormer member: x\n');
});

test('owner account is recognised by email hash only (no email in the code)', () => {
  // the real owner address is not known here: the rule must hold for any other address
  assert.strictEqual(username.isOwnerAccountEmail('someone@example.com'), false);
  assert.strictEqual(username.isOwnerAccountEmail(''), false);
  assert.strictEqual(username.isOwnerAccountEmail(undefined), false);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'username.js'), 'utf8');
  assert.ok(/OWNER_EMAIL_SHA256 = \{ andy: '[0-9a-f]{64}' \}/.test(src));
  assert.ok(crypto.createHash('sha256').update('x').digest('hex').length === 64);
});
