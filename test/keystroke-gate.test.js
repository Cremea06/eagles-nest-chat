// CHG-141: unit tests for lib/keystrokeGate.js (pure logic, injected clock, no server).
const test = require('node:test');
const assert = require('node:assert');
const g = require('../lib/keystrokeGate');

test('k1. constants: 100 needed, 12 keys/s credited, 15 per report at most, 5 s between Neagle replies', () => {
  assert.strictEqual(g.NEED, 100);
  assert.strictEqual(g.MAX_PER_SEC, 12);
  assert.strictEqual(g.BURST, 15);
  assert.strictEqual(g.REPLY_GAP_MS, 5000);
});

test('k2. a fresh state is locked at 0 and credits a normal report in full', () => {
  const s = g.createState(0);
  assert.strictEqual(s.count, 0); assert.strictEqual(s.unlocked, false);
  const r = g.applyReport(s, 7, 1000);
  assert.deepStrictEqual([r.accepted, r.count, r.unlockedNow], [7, 7, false]);
});

test('k3. bad values change nothing: negative, float, NaN, Infinity, string, null, object, huge', () => {
  for (const v of [-1, 1.5, NaN, Infinity, -Infinity, '50', null, undefined, {}, [], true, 1e9, Number.MAX_SAFE_INTEGER, 2 ** 53]) {
    const s = g.createState(0);
    const r = g.applyReport(s, v, 10000);
    assert.strictEqual(r.accepted, 0, String(v)); assert.strictEqual(s.count, 0);
  }
});

test('k4. a report that is not above the credited count is ignored (no going back, no repeats)', () => {
  const s = g.createState(0);
  g.applyReport(s, 10, 1000);
  assert.strictEqual(g.applyReport(s, 10, 2000).accepted, 0);
  assert.strictEqual(g.applyReport(s, 3, 3000).accepted, 0);
  assert.strictEqual(s.count, 10);
});

test('k5. cannot jump to 100 in one report: at most the 15-key burst is credited', () => {
  const s = g.createState(0);
  const r = g.applyReport(s, 100, 0);
  assert.strictEqual(r.accepted, 15); assert.strictEqual(s.unlocked, false);
  assert.strictEqual(g.applyReport(s, 100, 0).accepted, 0, 'same instant: nothing more');
});

test('k6. the credit rate is 12 keys per second however often reports come', () => {
  const s = g.createState(0);
  g.applyReport(s, 15, 0); // drain the burst
  let t = 0;
  for (let i = 0; i < 100; i++) { t += 10; g.applyReport(s, 1000, t); } // 100 reports in 1 s
  assert.ok(s.count >= 15 + 11 && s.count <= 15 + 13, 'about 15 + 12, got ' + s.count);
});

test('k7. a bot at the capped rate needs about 8 seconds; a human at 8 keys/s is credited in full and unlocks at exactly 100', () => {
  const bot = g.createState(0); let t = 0;
  while (!bot.unlocked && t < 60000) { t += 100; g.applyReport(bot, 100000, t); }
  assert.ok(t >= 7000 && t <= 8000, 'bot unlocked after ' + t + ' ms');
  const h = g.createState(0); let typed = 0; t = 0; let last;
  while (!h.unlocked) { t += 1000; typed += 8; last = g.applyReport(h, typed, t); }
  assert.strictEqual(h.count, 100); assert.strictEqual(last.unlockedNow, true); assert.ok(typed >= 100);
});

test('k8. the count never passes 100 and an unlocked state ignores further reports', () => {
  const s = g.createState(0);
  let t = 0;
  while (s.count < 95) { t += 1000; g.applyReport(s, Math.min(95, s.count + 10), t); }
  const r = g.applyReport(s, 5000, t + 60000);
  assert.strictEqual(s.count, 100); assert.strictEqual(r.unlockedNow, true);
  const r2 = g.applyReport(s, 9999, t + 120000);
  assert.deepStrictEqual([r2.accepted, r2.unlockedNow, r2.unlocked, s.count], [0, false, true, 100]);
});

test('k9. a clock that goes backwards does not give free credit', () => {
  const s = g.createState(10000);
  g.applyReport(s, 15, 10000);
  assert.strictEqual(g.applyReport(s, 100, 5000).accepted, 0);
});

test('k10. Neagle replies to one guest at most once per 5 s', () => {
  const s = g.createState(0);
  assert.strictEqual(g.takeReply(s, 1000), true);
  assert.strictEqual(g.takeReply(s, 1001), false);
  assert.strictEqual(g.takeReply(s, 5999), false);
  assert.strictEqual(g.takeReply(s, 6000), true);
  assert.strictEqual(g.takeReply(s, 6001), false);
  const other = g.createState(0);
  assert.strictEqual(g.takeReply(other, 6001), true, 'per guest, not global');
});

test('k11. canned wording: names the 100, shows N/100, keeps slash commands open; unlock text exact', () => {
  assert.strictEqual(g.blockedText(37), "Welcome, guest! Before you can speak in Milliway, you are required to record 100 keystrokes (you're at 37/100). Keep typing here and I'll let you in. Slash commands like /help and /login always work.");
  assert.strictEqual(g.UNLOCKED_TEXT, 'Thank you, you may enter the conversation.');
  assert.ok(!/human|bot|verify|secur/i.test(g.blockedText(0) + g.UNLOCKED_TEXT), 'no claim that this proves a person');
});
