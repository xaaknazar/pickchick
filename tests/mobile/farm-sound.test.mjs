import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('combo pitch climbs a whole tone per quick repeat and stops at +50%', () => {
  // useFarmSound.ts imports native modules; the pitch rule is checked from its source.
  const source = readFileSync(
    new URL('../../apps/mobile/src/games/pick-farm/useFarmSound.ts', import.meta.url),
    'utf8',
  );
  const body = source.match(
    /export function comboRate\(streak: number\) \{\n\s*return (.+);\n\}/,
  )[1];
  const comboRate = new Function('streak', `return ${body};`);
  const rates = [0, 1, 2, 3, 6, 7, 20].map((n) => Math.round(comboRate(n) * 1000) / 1000);
  assert.deepEqual(rates.slice(0, 4), [1, 1.122, 1.26, 1.414]);
  assert.equal(rates.at(-1), 1.5);
  for (let i = 1; i < rates.length; i++) assert.ok(rates[i] >= rates[i - 1]);
});
