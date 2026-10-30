// CHG-147: weatherUSA no-data sentinels must not reach the drawer.
const test = require('node:test');
const assert = require('node:assert');
const { shapeForecast, tempOrNull } = require('../lib/wx');

test('tempOrNull drops sentinels and junk', () => {
  for (const v of [-9999, 9999, -999, 999, '-9999', null, undefined, '', '  ', NaN, Infinity, 'abc', true, false, {}, []]) assert.strictEqual(tempOrNull(v), null, String(v));
});
test('tempOrNull keeps real temperatures', () => {
  assert.strictEqual(tempOrNull(72), 72); assert.strictEqual(tempOrNull('48'), 48); assert.strictEqual(tempOrNull(0), 0); assert.strictEqual(tempOrNull(-20), -20); assert.strictEqual(tempOrNull(71.6), 72);
});
test('shapeForecast returns null for a missing low (and high)', () => {
  const f = shapeForecast([{ day_name: 'Friday', wx_str: 'Rain', hi: 72, lo: -9999, pop12: 80 }, { day_name: 'Saturday', wx_str: 'Cloudy', hi: 9999, lo: null, pop12: -9999 }]);
  assert.deepStrictEqual(f, [{ day: 'Friday', text: 'Rain', hi: 72, lo: null, pop: 80 }, { day: 'Saturday', text: 'Cloudy', hi: null, lo: null, pop: null }]);
});
test('shapeForecast still accepts {data:[...]}', () => {
  assert.strictEqual(shapeForecast({ data: [{ day_name: 'Mon', wx_str: 'Sunny', hi: 70, lo: 50 }] })[0].lo, 50);
});
