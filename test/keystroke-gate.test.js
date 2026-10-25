// CHG-141: unit tests for lib/keystrokeGate.js (pure logic, injected clock, no server).
// CHG-142: k1, k6 and k7 were adjusted for the new ceiling (12 keys/s -> 33.3 keys/s, one counted key per 30 ms); k12-k16 added.
const test = require('node:test');
const assert = require('node:assert');
const g = require('../lib/keystrokeGate');

test('k1. constants: 100 needed, 33.3 keys/s credited (CHG-142; was 12), 15 per report at most, 5 s between Neagle replies', () => {
  assert.strictEqual(g.NEED, 100);
  assert.ok(Math.abs(g.MAX_PER_SEC - 1000 / 30) < 1e-9);
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

test('k6. the credit rate is 33.3 keys per second however often reports come (CHG-142; was 12)', () => {
  const s = g.createState(0);
  g.applyReport(s, 15, 0); // drain the burst
  let t = 0;
  for (let i = 0; i < 100; i++) { t += 10; g.applyReport(s, 1000, t); } // 100 reports in 1 s
  assert.ok(s.count >= 15 + 32 && s.count <= 15 + 34, 'about 15 + 33, got ' + s.count);
});

test('k7. a bot at the capped rate needs about 2.6 seconds (CHG-142; was 8); a human at 8 keys/s is credited in full and unlocks at exactly 100', () => {
  const bot = g.createState(0); let t = 0;
  while (!bot.unlocked && t < 60000) { t += 100; g.applyReport(bot, 100000, t); }
  assert.ok(t >= 2600 && t <= 2800, 'bot unlocked after ' + t + ' ms');
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

test('k11. canned wording (CHG-143): "<name>, ..." with N/100 from NEED; "Guest" when no name; one plain line; unlock text exact', () => {
  assert.strictEqual(g.blockedText(37, 'Guest-User 1901'), "Guest-User 1901, I'll need some more keystrokes from you before I'll let you talk in here. You're at 37/100.");
  assert.strictEqual(g.blockedText(6, 'Guest-User 1901'), "Guest-User 1901, I'll need some more keystrokes from you before I'll let you talk in here. You're at 6/100.");
  for (const none of [undefined, null, '', '   ']) assert.strictEqual(g.blockedText(0, none), "Guest, I'll need some more keystrokes from you before I'll let you talk in here. You're at 0/100.");
  assert.strictEqual(g.blockedText(0), g.blockedText(0, ''), 'no name given falls back to Guest');
  assert.ok(!/\n/.test(g.blockedText(1, 'a\nb  c')) && g.blockedText(1, 'a\nb  c').startsWith('a b c, '), 'a name with line breaks stays one line');
  assert.ok(g.blockedText(1, '<b>x</b>').startsWith('<b>x</b>, '), 'plain text: the name is passed through unchanged (the page shows it with textContent)');
  assert.strictEqual(g.UNLOCKED_TEXT, 'Thank you, you may enter the conversation.');
  assert.ok(!/human|bot|verify|secur/i.test(g.blockedText(0, 'Guest-User 1') + g.UNLOCKED_TEXT), 'no claim that this proves a person');
});

// ---- CHG-142 ----
// a person holding a key at the fastest default: first press, 500 ms, then repeats every `gap` ms; the page reports the running
// count every 250 ms (cumulative). Returns { t: ms when the server unlocked (or null), count }.
function holdSession(gap, { delay = 500, stopAt = 15000, reportMs = 250 } = {}) {
  const s = g.createState(0); let keys = 0; let nextKey = 0; let first = true; let unlockedAt = null;
  for (let t = 0; t <= stopAt && !s.unlocked; t += 5) {
    while (nextKey <= t) { keys++; nextKey += first ? delay : gap; first = false; }
    if (t % reportMs === 0 && t > 0) { const r = g.applyReport(s, keys, t); if (r.unlockedNow) unlockedAt = t; }
  }
  return { t: unlockedAt, count: s.count, keys };
}

test('k12. a Windows-speed hold (33 ms repeats after 500 ms) is credited in full and reaches 100 in about 3.5-4 s; the server never lags the keys by more than a report', () => {
  const r = holdSession(33);
  assert.ok(r.t >= 3250 && r.t <= 4250, 'unlocked at ' + r.t + ' ms');
  const s = g.createState(0); let lag = 0;
  for (let t = 250, keys = 1; t < 3000; t += 250) { keys = 1 + Math.floor(Math.max(0, t - 500) / 33); g.applyReport(s, keys, t); lag = Math.max(lag, keys - s.count); }
  assert.ok(lag <= 9, 'server credit trails the keys by at most one report worth (' + lag + ')');
});

test('k13. a slower hold (macOS ~90 ms, X11 40 ms) is credited in full too, it just takes longer', () => {
  const mac = holdSession(90); const x = holdSession(40);
  assert.ok(mac.t >= 9500 && mac.t <= 10500, 'mac unlocked at ' + mac.t);
  assert.ok(x.t >= 3500 && x.t <= 4500, 'x11 unlocked at ' + x.t);
});

test('k14. a forged "I am at 100" can never beat elapsed time x ceiling + the 15-key burst: not before ~2.55 s', () => {
  for (const startAt of [0, 5000, 600000]) { // however long the socket has been open, the bucket is 15
    const s = g.createState(startAt); let t = startAt; let at = null;
    while (!s.unlocked && t < startAt + 20000) { t += 10; g.applyReport(s, 100, t); if (s.unlocked) at = t - startAt; }
    assert.ok(at >= 2500 && at <= 2700, 'forger unlocked after ' + at + ' ms (start ' + startAt + ')');
  }
});

test('k15. any sequence of reports is bounded: credited <= 15 + 33.3 x elapsed seconds (random fuzz)', () => {
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let run = 0; run < 200; run++) {
    const s = g.createState(0); let t = 0;
    while (!s.unlocked && t < 2400) { t += Math.floor(rnd() * 200); g.applyReport(s, Math.floor(rnd() * 5000), t); if (s.count >= 100) break; assert.ok(s.count <= 15 + (33.34 * t) / 1000 + 1e-6, 'run ' + run + ' count ' + s.count + ' at ' + t); }
  }
});

test('k16. reports at exactly the ceiling are accepted (30 ms, 33 per second sustained, per-250 ms reports); 3x the ceiling is capped to it', () => {
  const ok = g.createState(0); let keys = 0;
  for (let t = 250; t <= 2500; t += 250) { keys = Math.floor(t / 30); g.applyReport(ok, keys, t); }
  assert.ok(keys - ok.count <= 1, 'ceiling-rate claims are credited (claimed ' + keys + ', credited ' + ok.count + ')');
  const fast = g.createState(0);
  for (let t = 250; t <= 2000; t += 250) g.applyReport(fast, Math.floor(t / 10), t); // claims 100/s
  assert.ok(fast.count <= 15 + 33.34 * 2, 'credited ' + fast.count + ' of ' + 200 + ' claimed');
});
