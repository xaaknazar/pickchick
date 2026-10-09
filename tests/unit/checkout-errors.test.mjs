import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomerCheckoutController } from '../../services/api/dist/customer-checkout-controller.js';
import { CommerceError, MenuChangedError } from '../../packages/commerce-core/dist/index.js';

test('specific checkout causes are opt-in; installed strict clients retain their old code', async () => {
  const controller = new CustomerCheckoutController(
    { me: async () => ({ customer: { id: 'synthetic' } }) },
    { pool: {} },
    { revision: 0 },
  );
  const token = 'Bearer ' + 'a'.repeat(64);
  for (const [error, legacy, precise] of [
    [new MenuChangedError(), 'CONFLICT', 'MENU_CHANGED'],
    [new CommerceError('RESTAURANT_CLOSED'), 'CONFLICT', 'RESTAURANT_CLOSED'],
  ]) {
    controller.checkout = {
      quote: async () => {
        throw error;
      },
    };
    await assert.rejects(
      controller.quote({}, token, 'application/json'),
      (e) => e.getResponse().code === legacy && e.getStatus() === 409,
    );
    await assert.rejects(
      controller.quote({}, token, 'application/json; profile=pickchick.checkout-errors-v1'),
      (e) => e.getResponse().code === precise && e.getStatus() === 409,
    );
  }
});
