// CHG-162: lib/chatPause.js — site-wide Chat pause state + rate limits. No network.
const test = require('node:test');
const assert = require('node:assert');
const { createChatPause } = require('../lib/chatPause');

test('default is On (not paused)', () => {
  const cp = createChatPause({ now: () => 1000 });
  assert.deepStrictEqual(cp.state(), { paused: false, by: null });
});

test('pause then resume records by only while paused', () => {
  let t = 0;
  const cp = createChatPause({ now: () => t, globalCooldownMs: 0 });
  let r = cp.trySet(true, 'Guest-User 1234', 'sock:a');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.state, { paused: true, by: 'Guest-User 1234' });
  t = 1;
  r = cp.trySet(false, 'Guest-User 9999', 'sock:a');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.state, { paused: false, by: null });
});

test('rejects non-boolean', () => {
  const cp = createChatPause({ now: () => 1, globalCooldownMs: 0 });
  const r = cp.trySet('true', 'A', 'sock:a');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'bad_input');
  assert.strictEqual(cp.state().paused, false);
});

test('global cooldown blocks a fast second flip', () => {
  let t = 1000;
  const cp = createChatPause({ now: () => t, globalCooldownMs: 5000 });
  assert.strictEqual(cp.trySet(true, 'A', 'sock:a').ok, true);
  t = 3000;
  const r = cp.trySet(false, 'B', 'sock:b');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cooldown');
  assert.strictEqual(r.state.paused, true);
  assert.strictEqual(r.state.by, 'A');
  t = 7000;
  assert.strictEqual(cp.trySet(false, 'B', 'sock:b').ok, true);
  assert.strictEqual(cp.state().paused, false);
});

test('per-socket limit is 3 per minute', () => {
  let t = 0;
  const cp = createChatPause({ now: () => t, globalCooldownMs: 0, sockLimit: 3, sockWindowMs: 60000 });
  assert.strictEqual(cp.trySet(true, 'A', 'sock:x').ok, true);
  t = 10;
  assert.strictEqual(cp.trySet(false, 'A', 'sock:x').ok, true);
  t = 20;
  assert.strictEqual(cp.trySet(true, 'A', 'sock:x').ok, true);
  t = 30;
  const r = cp.trySet(false, 'A', 'sock:x');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'rate');
  assert.strictEqual(cp.trySet(false, 'B', 'sock:y').ok, true);
});

test('same-state flip is unchanged and does not move cooldown', () => {
  let t = 1000;
  const cp = createChatPause({ now: () => t, globalCooldownMs: 5000 });
  assert.strictEqual(cp.trySet(true, 'A', 'sock:a').ok, true);
  t = 1500;
  const r = cp.trySet(true, 'A', 'sock:a');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.unchanged, true);
  t = 2000;
  const r2 = cp.trySet(false, 'B', 'sock:b');
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'cooldown');
});

test('by is trimmed and capped', () => {
  const cp = createChatPause({ now: () => 1, globalCooldownMs: 0 });
  const long = 'X'.repeat(100);
  const r = cp.trySet(true, '  ' + long + '  ', 'sock:a');
  assert.strictEqual(r.state.by.length, 64);
});
