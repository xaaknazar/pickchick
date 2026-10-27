import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMBO_STAMP_SLOTS,
  comboNextStep,
  comboProgressView,
} from '../../apps/mobile/src/loyalty/combo-progress.ts';

// The practice server contract (test builds only) still counts rounds of 7.
const progress = (total) => ({
  status: 'ready',
  data: {
    synthetic: true,
    namespace: 'pickchick-test',
    mode: 'practice',
    program_version: 'practice-single-combo-v1',
    threshold: 7,
    earned_units: total,
    current_stamps: total % 7,
    completed_cycles: Math.floor(total / 7),
    redeemable: false,
  },
});
test('the card has six stamp slots and the gift (6 + 1)', () => {
  assert.equal(COMBO_STAMP_SLOTS, 6);
});
test('combo progress never presents unknown, signed-out or failed data as zero', () => {
  for (const status of ['signed_out', 'loading', 'error'])
    assert.equal(comboProgressView({ status, data: null }).count, null);
  assert.equal(comboProgressView(progress(0)).count, 0);
  assert.deepEqual(comboProgressView(undefined, true), {
    count: 3,
    text: 'Пример: 3 из 6 комбо',
  });
  assert.equal(comboNextStep(undefined, true).title, 'Ещё 3 комбо до подарка');
});
test('sixth stamp completes the visible card; subsequent units carry to next cycle', () => {
  for (const [total, count] of [
    [1, 1],
    [5, 5],
    [6, 6],
    [7, 1],
    [12, 6],
    [13, 1],
  ]) {
    const view = comboProgressView(progress(total));
    assert.equal(view.count, count);
    assert.equal(view.text, `Пробные отметки: ${count} из 6`);
  }
});
