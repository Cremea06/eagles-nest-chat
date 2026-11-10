// CHG-165: offline pure helper checks; never connects to a room.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitize, formatLine, createPauseBuffer, createKeyLimiter, parseArgs, isForwardedCommand } = require('../tools/milliway-cli');
test('sanitize removes terminal sequences, control chars, bidi and line separators', () => {
  assert.equal(sanitize('\x1b[31mred\x1b[0m\n\r\t\x07\u202e\u2028\u2029'), 'red');
  assert.equal(sanitize('\x1b]52;c;evil\x07hello'), 'hello');
  assert.equal(sanitize('\x1b]8;;https://evil.test\x1b\\link\x1b]8;;\x1b\\'), 'link');
  assert.equal(sanitize('café 🦅'), 'café 🦅');
  assert.equal(sanitize(null), '');
});
test('format lines uses local HH:MM and sanitizes every remote field', () => {
  const t = new Date(2026, 10, 6, 9, 3);
  assert.equal(formatLine('chat', { username: '\x1b[31mGuest', message: 'hi\nthere' }, t), '[09:03] Guest: hithere');
  assert.equal(formatLine('system', 'joined\r', t), '[09:03] joined');
  assert.equal(formatLine('clip', { clipper:'A', caption:'B', url:'/c/1' }, t), '[09:03] [clip] A: B /c/1');
});
test('pause holds others, systems and clips, but prints own lines immediately; flush is ordered', () => {
  const b = createPauseBuffer();
  assert.equal(b.push('system', 'welcome').length, 1);
  assert.deepEqual(b.apply({ paused:true, by:'Guest' }), []);
  for (const kind of ['chat','system','clip']) assert.deepEqual(b.push(kind, kind), []);
  assert.equal(b.push('chat', 'own', true)[0].data, 'own');
  assert.equal(b.status(), 'Chat paused by Guest · 3 new');
  assert.deepEqual(b.apply({ paused:false }).map(x => x.data), ['chat','system','clip']);
  assert.equal(b.status(), 'Chat On');
  assert.deepEqual(b.apply({ paused:false }), []);
});
test('pause buffer caps at browser 500 and resets on reconnect', () => {
  const b = createPauseBuffer(); b.apply({ paused:true });
  for(let i=0;i<501;i++) b.push('chat', i);
  assert.equal(b.status(), 'Chat paused · 500+ new');
  const items = b.apply({ paused:false });
  assert.equal(items.length, 500); assert.equal(items[0].data, 1);
  b.apply({ paused:true }); b.push('chat', 'stale'); b.reset();
  assert.equal(b.status(), 'Chat On'); assert.equal(b.apply({ paused:false }).length, 0);
});
test('key limiter matches shared browser rules and rejects fast paste', () => {
  const shared = require('../public/keystroke-limits').createLimiter();
  const local = createKeyLimiter();
  for (const t of [0,0,0,0,0,15,30,60,59,90,1000]) assert.equal(local(t), shared.accept(t));
});
test('arguments support URL only, reject names, private credentials and invalid protocols', () => {
  assert.equal(parseArgs([]).url, 'https://chat.afirstflag.com');
  assert.equal(parseArgs(['--url','http://127.0.0.1:3165']).url, 'http://127.0.0.1:3165');
  for (const args of [['--name','Andy'],['--url'],['--url','ftp://host'],['--url','https://user:pass@host']])
    assert.throws(() => parseArgs(args));
});

test('formatLine renders whisper To / whispers wording and sanitizes fields', () => {
  const t = new Date(2026, 10, 10, 18, 5);
  assert.equal(formatLine('whisper', { dir:'out', to:'\x1b[31mWV Alice', message:'hi\nthere' }, t), '[18:05] To WV Alice: hithere');
  assert.equal(formatLine('whisper', { dir:'in', from:'Guest-User 1901', message:'hello' }, t), '[18:05] Guest-User 1901 whispers: hello');
});
test('pause prints whispers immediately, like own chat', () => {
  const b = createPauseBuffer();
  b.apply({ paused:true, by:'Guest' });
  const vis = b.push('whisper', { dir:'in', from:'A', to:'B', message:'psst' }, true);
  assert.equal(vis.length, 1);
  assert.equal(vis[0].data.message, 'psst');
  assert.equal(b.status(), 'Chat paused by Guest · 0 new');
});
test('client forwards /tell and /r, still blocks other guest-unsupported commands', () => {
  assert.equal(isForwardedCommand('/tell WV Alice hello'), true);
  assert.equal(isForwardedCommand('/r thanks'), true);
  assert.equal(isForwardedCommand('/who'), true);
  assert.equal(isForwardedCommand('/mute Alice'), false);
  assert.equal(isForwardedCommand('/register'), false);
});
