// CHG-163: lib/tailgatePlay.js — site-wide Tailgate playing state + rate limits. No network.
const test = require('node:test');
const assert = require('node:assert');
const { createTailgatePlay } = require('../lib/tailgatePlay');

const tg = { modeIsTailgate: true };
const no = { modeIsTailgate: false };

test('default is not playing', () => {
  const p = createTailgatePlay({ now: () => 1000 });
  assert.deepStrictEqual(p.state(), { playing: false, by: null, since: null });
});

test('start then stop records by/since only while playing', () => {
  let t = 100;
  const p = createTailgatePlay({ now: () => t, globalCooldownMs: 0 });
  let r = p.trySet(true, 'Guest-User 1', 'sock:a', tg);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.state, { playing: true, by: 'Guest-User 1', since: 100 });
  t = 200;
  r = p.trySet(false, 'Guest-User 2', 'sock:a', tg);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.state, { playing: false, by: null, since: null });
});

test('cannot start when mode is not tailgate', () => {
  const p = createTailgatePlay({ now: () => 1, globalCooldownMs: 0 });
  const r = p.trySet(true, 'A', 'sock:a', no);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not_tailgate');
});

test('rejects non-boolean', () => {
  const p = createTailgatePlay({ now: () => 1, globalCooldownMs: 0 });
  const r = p.trySet('true', 'A', 'sock:a', tg);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'bad_input');
});

test('global cooldown blocks a fast second flip', () => {
  let t = 1000;
  const p = createTailgatePlay({ now: () => t, globalCooldownMs: 5000 });
  assert.strictEqual(p.trySet(true, 'A', 'sock:a', tg).ok, true);
  t = 3000;
  const r = p.trySet(false, 'B', 'sock:b', tg);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cooldown');
  assert.strictEqual(r.state.playing, true);
  t = 7000;
  assert.strictEqual(p.trySet(false, 'B', 'sock:b', tg).ok, true);
});

test('per-socket limit is 3 per minute', () => {
  let t = 0;
  const p = createTailgatePlay({ now: () => t, globalCooldownMs: 0, sockLimit: 3, sockWindowMs: 60000 });
  assert.strictEqual(p.trySet(true, 'A', 'sock:x', tg).ok, true);
  t = 10;
  assert.strictEqual(p.trySet(false, 'A', 'sock:x', tg).ok, true);
  t = 20;
  assert.strictEqual(p.trySet(true, 'A', 'sock:x', tg).ok, true);
  t = 30;
  const r = p.trySet(false, 'A', 'sock:x', tg);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'rate');
  assert.strictEqual(p.trySet(false, 'B', 'sock:y', tg).ok, true);
});

test('clear() resets without cooldown and is idempotent', () => {
  let t = 50;
  const p = createTailgatePlay({ now: () => t, globalCooldownMs: 5000 });
  assert.strictEqual(p.trySet(true, 'A', 'sock:a', tg).ok, true);
  const c = p.clear();
  assert.strictEqual(c.changed, true);
  assert.deepStrictEqual(c.state, { playing: false, by: null, since: null });
  assert.strictEqual(p.clear().changed, false);
});

test('same-state is unchanged', () => {
  const p = createTailgatePlay({ now: () => 1, globalCooldownMs: 0 });
  assert.strictEqual(p.trySet(false, 'A', 'sock:a', tg).unchanged, true);
});
