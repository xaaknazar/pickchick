import assert from 'node:assert/strict';
import test from 'node:test';
import { comboProgressView } from '../../apps/mobile/src/loyalty/combo-progress.ts';

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
test('combo progress never presents unknown, signed-out or failed data as zero', () => {
  for (const status of ['signed_out', 'loading', 'error'])
    assert.equal(comboProgressView({ status, data: null }).count, null);
  assert.equal(comboProgressView(progress(0)).count, 0);
  assert.equal(comboProgressView(undefined, true).count, 3);
});
test('seventh stamp completes the visible card; subsequent units carry to next cycle', () => {
  for (const [total, count] of [
    [1, 1],
    [6, 6],
    [7, 7],
    [8, 1],
    [14, 7],
    [15, 1],
  ]) {
    const view = comboProgressView(progress(total));
    assert.equal(view.count, count);
    assert.match(view.text, /Пробные отметки/);
  }
});
