// CHG-167: lib/whisper.js — name matching, sanitize, parse, rate limit. No network.
const test = require('node:test');
const assert = require('node:assert');
const whisper = require('../lib/whisper');
const fs = require('fs');
const path = require('path');

function person(username, roomName, shownName) {
  return {
    key: String(username).toLowerCase(),
    username,
    roomName: roomName || username,
    shownName: shownName || roomName || username
  };
}

const alice = person('Alice', 'WV Alice', 'WV Alice (flagholder)');
const bob = person('Bob', 'Bob', 'Bob');
const guest = person('Guest-User 1901', 'Guest-User 1901', 'Guest-User 1901');
const people = [alice, bob, guest];

test('foldName strips the flagholder tag, collapses space, and is case-insensitive', () => {
  assert.strictEqual(whisper.foldName('  WV Alice (flagholder) '), 'wv alice');
  assert.strictEqual(whisper.foldName('Guest-User 1901'), 'guest-user 1901');
});

test('findMatches accepts bare name, state prefix, flagholder tag, and guest forms', () => {
  assert.deepStrictEqual(whisper.findMatches('Alice', people).map((p) => p.username), ['Alice']);
  assert.deepStrictEqual(whisper.findMatches('wv alice', people).map((p) => p.username), ['Alice']);
  assert.deepStrictEqual(whisper.findMatches('WV Alice (flagholder)', people).map((p) => p.username), ['Alice']);
  assert.deepStrictEqual(whisper.findMatches('Guest-User 1901', people).map((p) => p.username), ['Guest-User 1901']);
  assert.deepStrictEqual(whisper.findMatches('guest-user1901', people).map((p) => p.username), ['Guest-User 1901']);
  assert.deepStrictEqual(whisper.findMatches('1901', people).map((p) => p.username), ['Guest-User 1901']);
  assert.deepStrictEqual(whisper.findMatches('nobody', people), []);
});

test('ambiguous numeric query does not silently pick one person', () => {
  const numbered = person('1234', '1234', '1234');
  const g = person('Guest-User 1234', 'Guest-User 1234', 'Guest-User 1234');
  const hits = whisper.findMatches('1234', [numbered, g]);
  assert.strictEqual(hits.length, 2);
});

test('parseTell takes the longest unique name and leaves the rest as the message', () => {
  const r = whisper.parseTell(['Guest-User', '1901', 'hello', 'there'], people);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.person.username, 'Guest-User 1901');
  assert.strictEqual(r.message, 'hello there');
  const r2 = whisper.parseTell(['WV', 'Alice', 'hi'], people);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.person.username, 'Alice');
  assert.strictEqual(r2.message, 'hi');
});

test('parseTell reports usage, offline, self, and too-long', () => {
  assert.strictEqual(whisper.parseTell(['Alice'], people).reason, 'usage');
  assert.strictEqual(whisper.parseTell(['Alice', 'hello'], people, { selfKey: 'alice' }).reason, 'self');
  assert.strictEqual(whisper.parseTell(['Nope', 'hello'], people).reason, 'offline');
  assert.strictEqual(whisper.parseTell(['Nope', 'hello'], people).name, 'Nope');
  const long = 'x'.repeat(whisper.MAX_LEN + 1);
  assert.strictEqual(whisper.parseTell(['Bob', long], people).reason, 'too_long');
  assert.strictEqual(whisper.parseTell(['Guest-User', '1901'], people).reason, 'usage');
});

test('sanitizeMessage strips controls, flattens newlines, and caps length', () => {
  assert.deepStrictEqual(whisper.sanitizeMessage('  hi\nthere\t!  '), { ok: true, text: 'hi there !' });
  assert.strictEqual(whisper.sanitizeMessage('a\u0007b\u202ec').text, 'abc');
  assert.strictEqual(whisper.sanitizeMessage('   ').reason, 'empty');
  assert.strictEqual(whisper.sanitizeMessage('x'.repeat(whisper.MAX_LEN)).ok, true);
  assert.strictEqual(whisper.sanitizeMessage('x'.repeat(whisper.MAX_LEN + 1)).reason, 'too_long');
});

test('payload and label use To / whispers wording', () => {
  const out = whisper.payload('out', 'Guest-User 1', 'WV Alice', 'hello');
  const inn = whisper.payload('in', 'Guest-User 1', 'WV Alice', 'hello');
  assert.strictEqual(whisper.label(out), 'To WV Alice:');
  assert.strictEqual(whisper.label(inn), 'Guest-User 1 whispers:');
});

test('members-only switch is off unless WHISPER_MEMBERS_ONLY=1', () => {
  assert.strictEqual(whisper.membersOnlyFromEnv({}), false);
  assert.strictEqual(whisper.membersOnlyFromEnv({ WHISPER_MEMBERS_ONLY: '1' }), true);
  assert.strictEqual(whisper.membersOnlyFromEnv({ WHISPER_MEMBERS_ONLY: '0' }), false);
});

test('per-socket limiter is 10 per minute', () => {
  let t = 0;
  const lim = whisper.createWhisperLimiter({ now: () => t, limit: 10, windowMs: 60000 });
  for (let i = 0; i < 10; i++) assert.strictEqual(lim.hit('sock:a').ok, true);
  assert.strictEqual(lim.hit('sock:a').ok, false);
  assert.strictEqual(lim.hit('sock:b').ok, true);
  t = 60000;
  assert.strictEqual(lim.hit('sock:a').ok, true);
});

test('index.html styles whispers in a readable WoW-like purple and listens for the whisper event', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(/\.msg\.whisper/.test(html));
  assert.ok(/#FF80FF/i.test(html) || /#ff80ff/i.test(html));
  assert.ok(/socket\.on\('whisper'/.test(html));
  assert.ok(/AFF_renderWhisper/.test(html));
  assert.ok(/whispers:/.test(html) && /To /.test(html));
});
