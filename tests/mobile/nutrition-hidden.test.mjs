import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hasNutrition } from '../../apps/mobile/src/nutrition.ts';

// Owner 23.11.2026: КБЖУ is not filled in yet; missing or zero values are not shown at all.
test('КБЖУ shows only when it is filled in', () => {
  assert.equal(hasNutrition(undefined), false);
  assert.equal(hasNutrition(null), false);
  const zero = { basis: 'per_100_g', energy_kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 };
  assert.equal(hasNutrition(zero), false);
  assert.equal(hasNutrition({ ...zero, energy_kcal: 1240 }), true);
  assert.equal(hasNutrition({ ...zero, protein_g: 3.5 }), true);
  const source = readFileSync(
    new URL('../../apps/mobile/src/screens/PhotoProduct.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /\{nutritionKnown \? \(\s*<Pressable[\s\S]*?photo-nutrition-open/);
});
