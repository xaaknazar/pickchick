import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  createDemoOrder,
  advanceDemoOrder,
  parseDemoOrder,
  REVIEW_DEMO_KEY,
} from '../../apps/mobile/src/review-demo.ts';
const lines = [{ name: 'Example combo', quantity: 2, totalMinor: '500000' }];
test('demonstration snapshots basket, restores progress and never edits the original', () => {
  const input = lines.map((line) => ({ ...line }));
  const original = createDemoOrder(input, 'takeaway');
  const preparing = advanceDemoOrder(original, 'approve');
  assert.equal(original.stage, 'payment');
  assert.equal(preparing.stage, 'preparing');
  input[0].name = 'changed';
  assert.equal(original.lines[0].name, 'Example combo');
  assert.deepEqual(parseDemoOrder(JSON.stringify(preparing)), preparing);
  const ready = advanceDemoOrder(preparing, 'ready');
  assert.equal(advanceDemoOrder(ready, 'collect').stage, 'fulfilled');
  assert.throws(() => advanceDemoOrder(original, 'collect'));
  assert.equal(advanceDemoOrder(advanceDemoOrder(original, 'decline'), 'retry').stage, 'payment');
});
test('demo rejects foreign state, corrupt totals, unsafe quantities and invalid progression', () => {
  const original = createDemoOrder(lines, 'dine_in');
  assert.equal(parseDemoOrder(null), null);
  for (const value of [
    { ...original, synthetic: false },
    { ...original, totalMinor: '1' },
    { ...original, stage: 'paid' },
    { ...original, lines: [{ ...lines[0], quantity: -1 }] },
    { ...original, lines: [{ ...lines[0], totalMinor: '1.5' }] },
    { ...original, serviceMode: 'delivery' },
  ])
    assert.throws(() => parseDemoOrder(JSON.stringify(value)));
  assert.throws(() => createDemoOrder([], 'takeaway'));
});
test('demonstration has a separate storage key and no route to bank or real order creation', () => {
  assert.match(REVIEW_DEMO_KEY, /demonstration/);
  for (const file of [
    'apps/mobile/src/review-demo.ts',
    'apps/mobile/src/screens/ReviewDemoScreen.tsx',
  ]) {
    const src = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(
      src,
      /commerceRequest|withOrderAccess|fetch\(|Linking|createCustomerRequest|setCart|clearCart|pendingPaymentKey/,
    );
  }
});
