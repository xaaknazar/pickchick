import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { customerCanCancel } from '../../apps/mobile/src/order-cancellation.ts';

const order = (state, payment_state) => ({ state, payment_state });

test('customer can cancel only an unpaid unfinished order (owner decision 2026-10-11)', () => {
  assert.equal(customerCanCancel(order('awaiting_test_payment', 'not_started')), true);
  assert.equal(customerCanCancel(order('awaiting_test_payment', 'simulated_declined')), true);
  assert.equal(customerCanCancel(order('preparing', 'not_started')), true, 'unpaid test order');
  for (const state of ['awaiting_test_payment', 'preparing', 'ready'])
    assert.equal(customerCanCancel(order(state, 'simulated_approved')), false, `paid ${state}`);
  assert.equal(customerCanCancel(order('awaiting_test_payment', 'simulated_unknown')), false);
  assert.equal(customerCanCancel(order('fulfilled', 'not_started')), false);
  assert.equal(customerCanCancel(order('cancelled', 'not_started')), false);
});

test('order screen gates every cancel control on the shared rule', () => {
  const screen = readFileSync(
    new URL('../../apps/mobile/src/screens/ConnectedOrderScreens.tsx', import.meta.url),
    'utf8',
  );
  assert.match(screen, /const cancellable = customerCanCancel\(order\)/);
  assert.match(screen, /cancel && cancellable \? \(\s*<Button\s+testID="test-cancel-order"/);
  assert.match(screen, /!cancel && cancellable \? \(\s*<NavRow[^>]*title="Отменить заказ"/);
  assert.match(screen, /testID="test-cancel-unavailable"/);
});
