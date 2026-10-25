// CHG-142: unit tests for public/keystroke-limits.js (the page limiter + countable-key rule; pure, injected times).
// Held-key auto-repeat counts, but only up to the normal OS default repeat speed; anything faster counts for nothing.
const test = require('node:test');
const assert = require('node:assert');
const L = require('../public/keystroke-limits');

// feed a held key: first press at t0, then repeats starting after `delay` ms, every `gap` ms (+/- jitter), for `ms` ms
function hold(limiter, { delay = 500, gap, ms, jitter = 0, t0 = 1000 }) {
  let counted = 0; let total = 0; let t = t0;
  if (limiter.accept(t)) counted++; total++;
  t += delay; const end = t + ms; let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  while (t < end) { if (limiter.accept(t)) counted++; total++; t += gap + (rnd() * 2 - 1) * jitter; }
  return { counted, total };
}

test('l1. constants in one place: 30 ms gap = 33.3 keys/s ceiling, burst 4 on the page, 15 on the server, reports every 250 ms', () => {
  assert.strictEqual(L.MIN_GAP_MS, 30);
  assert.ok(Math.abs(L.MAX_PER_SEC - 33.333333) < 1e-4);
  assert.strictEqual(L.CLIENT_BURST, 4);
  assert.strictEqual(L.SERVER_BURST, 15);
  assert.strictEqual(L.REPORT_MS, 250);
  assert.ok(L.SERVER_BURST >= L.CLIENT_BURST, 'the server is never stricter than the page about a burst');
  const g = require('../lib/keystrokeGate');
  assert.strictEqual(g.MAX_PER_SEC, L.MAX_PER_SEC, 'server uses the same ceiling');
  assert.strictEqual(g.BURST, L.SERVER_BURST);
});

test('l2. the first keydown always counts (at any time, even t = 0)', () => {
  for (const t of [0, 1, 123456.789, 1e9]) assert.strictEqual(L.createLimiter().accept(t), true, String(t));
});

test('l3. Windows default hold (500 ms delay, then ~33 ms repeats): every event counts', () => {
  const r = hold(L.createLimiter(), { gap: 33, ms: 5000 });
  assert.strictEqual(r.counted, r.total); assert.ok(r.total > 150);
});

test('l4. Windows hold with timing jitter (+/- 8 ms around 33 ms, so sometimes under 30 ms): still every event counts', () => {
  const r = hold(L.createLimiter(), { gap: 33, ms: 5000, jitter: 8 });
  assert.strictEqual(r.counted, r.total);
});

test('l5. other OS defaults count in full: macOS ~90 ms, X11 xset 40 ms, GNOME 30 ms', () => {
  for (const gap of [90, 40, 30]) {
    const r = hold(L.createLimiter(), { gap, ms: 4000 });
    assert.strictEqual(r.counted, r.total, 'gap ' + gap);
  }
});

test('l6. macOS default (11 per second, 90 ms) counts all, over a full second too', () => {
  const lim = L.createLimiter(); let c = 0;
  for (let i = 0; i < 11; i++) if (lim.accept(i * 90)) c++;
  assert.strictEqual(c, 11);
});

test('l7. a 5 ms synthetic flood counts only up to the ceiling: burst 4 + one per 30 ms', () => {
  const lim = L.createLimiter(); let c = 0;
  for (let t = 0; t < 1000; t += 5) if (lim.accept(t)) c++; // 200 events in 1 s
  assert.ok(c >= 33 && c <= 4 + Math.floor(1000 / 30) + 1, 'counted ' + c + ' of 200');
  // over 10 s: no more than burst + ceiling x time
  const l2 = L.createLimiter(); let c2 = 0;
  for (let t = 0; t < 10000; t += 5) if (l2.accept(t)) c2++;
  assert.ok(c2 <= L.CLIENT_BURST + L.MAX_PER_SEC * 10 + 1 && c2 >= L.MAX_PER_SEC * 10 - 2, 'counted ' + c2 + ' of 2000');
});

test('l8. a 15 ms flood (a terminal-tweaked fast repeat) counts about half; 1 ms flood about the same ceiling', () => {
  const lim = L.createLimiter(); let c = 0;
  for (let t = 0; t < 3000; t += 15) if (lim.accept(t)) c++;
  assert.ok(c >= 95 && c <= 105, 'counted ' + c + ' of 200');
  const l1 = L.createLimiter(); let c1 = 0;
  for (let t = 0; t < 3000; t += 1) if (l1.accept(t)) c1++;
  assert.ok(c1 <= 4 + 100 + 1, 'counted ' + c1 + ' of 3000');
});

test('l9. a fast flood costs nothing: after it stops, the very next key (after 30 ms of quiet) counts again, nothing is owed', () => {
  const lim = L.createLimiter();
  for (let t = 0; t < 500; t += 2) lim.accept(t);
  assert.strictEqual(lim.accept(500 + 31), true);
  const l2 = L.createLimiter(); for (let t = 0; t < 500; t += 2) l2.accept(t);
  assert.strictEqual(l2.accept(2000), true);
});

test('l10. rollover: up to 4 keys inside a few ms count (fast typists), the 5th inside the same few ms does not', () => {
  const lim = L.createLimiter();
  const got = [0, 6, 12, 18, 20].map((t) => lim.accept(1000 + t));
  assert.deepStrictEqual(got, [true, true, true, true, false]);
});

test('l11. a clock that goes backwards, and bad timestamps, give no credit', () => {
  const lim = L.createLimiter();
  for (const t of [1000, 1000, 1000, 1000]) lim.accept(t); // drain
  assert.strictEqual(lim.accept(500), false);
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '5', {}]) assert.strictEqual(L.createLimiter().accept(bad), false, String(bad));
});

test('l12. normal typing (about 8 keys/s, uneven) counts in full', () => {
  const lim = L.createLimiter(); let c = 0, t = 0;
  for (let i = 0; i < 200; i++) { t += 60 + (i * 37) % 200; if (lim.accept(t)) c++; }
  assert.strictEqual(c, 200);
});

test('l13. countable keys: trusted character presses and Backspace; auto-repeat included', () => {
  const ev = (o) => Object.assign({ isTrusted: true, key: 'a', ctrlKey: false, metaKey: false, repeat: false, getModifierState: () => false }, o);
  assert.strictEqual(L.isCountableKey(ev({})), true);
  assert.strictEqual(L.isCountableKey(ev({ key: ' ' })), true);
  assert.strictEqual(L.isCountableKey(ev({ key: '!' })), true);
  assert.strictEqual(L.isCountableKey(ev({ key: 'Backspace' })), true);
  assert.strictEqual(L.isCountableKey(ev({ repeat: true })), true, 'a held key (auto-repeat) is a keystroke now');
  assert.strictEqual(L.isCountableKey(ev({ key: 'Backspace', repeat: true })), true);
});

test('l14. not countable: untrusted events, Ctrl/Cmd shortcuts, bare modifiers, Enter, arrows, Tab, Escape, Delete, Unidentified, junk', () => {
  const ev = (o) => Object.assign({ isTrusted: true, key: 'a', ctrlKey: false, metaKey: false, repeat: false, getModifierState: () => false }, o);
  assert.strictEqual(L.isCountableKey(ev({ isTrusted: false })), false, 'synthetic');
  assert.strictEqual(L.isCountableKey(ev({ isTrusted: undefined })), false);
  assert.strictEqual(L.isCountableKey(ev({ ctrlKey: true })), false, 'Ctrl+a');
  assert.strictEqual(L.isCountableKey(ev({ metaKey: true })), false, 'Cmd+a');
  assert.strictEqual(L.isCountableKey(ev({ ctrlKey: true, getModifierState: (k) => k === 'AltGraph' })), true, 'AltGr produces ctrl+alt on Windows; that is typing');
  for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Enter', 'Tab', 'Escape', 'ArrowLeft', 'ArrowDown', 'Delete', 'Home', 'F5', 'Unidentified', 'Process', 'Dead', '']) {
    assert.strictEqual(L.isCountableKey(ev({ key })), false, key);
    assert.strictEqual(L.isCountableKey(ev({ key, repeat: true })), false, key + ' held');
  }
  for (const bad of [null, undefined, {}, { isTrusted: true }, { isTrusted: true, key: 5 }]) assert.strictEqual(L.isCountableKey(bad), false);
});
