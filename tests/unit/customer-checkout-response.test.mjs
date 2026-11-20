import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutRepresentation } from '../../services/api/dist/customer-checkout-response.js';

test('checkout keeps old strict response shapes and immutable revision without modifying source', () => {
  const order = { orderId: 'fixture', revision: 'unchanged', kitchenComment: 'Соус отдельно' };
  assert.deepEqual(checkoutRepresentation(order), { orderId: 'fixture', revision: 'unchanged' });
  assert.deepEqual(checkoutRepresentation({ orders: [order] }), {
    orders: [{ orderId: 'fixture', revision: 'unchanged' }],
  });
  assert.deepEqual(checkoutRepresentation({ enabled: true, orderCommentEnabled: true }), {
    enabled: true,
  });
  assert.equal(order.kitchenComment, 'Соус отдельно');
});

test('new checkout profile receives comment and capability; unrelated Accept values do not opt in', () => {
  const value = { orderId: 'fixture', kitchenComment: 'Соус отдельно' };
  assert.equal(
    checkoutRepresentation(value, 'application/json; profile=pickchick.checkout-comments-v1'),
    value,
  );
  assert.deepEqual(checkoutRepresentation(value, 'application/json'), { orderId: 'fixture' });
  assert.deepEqual(checkoutRepresentation(value, 'application/json; profile="other"'), {
    orderId: 'fixture',
  });
});

test('wallet methods reach only builds that send the wallets profile', () => {
  const config = {
    enabled: true,
    orderCommentEnabled: true,
    paymentMethods: ['kaspi', 'card'],
    paymentEnvironment: 'test',
  };
  const comments = 'application/json; profile=pickchick.checkout-comments-v1';
  const wallets = 'application/json; profile=pickchick.checkout-wallets-v1';
  assert.deepEqual(checkoutRepresentation(config, comments), {
    enabled: true,
    orderCommentEnabled: true,
  });
  assert.deepEqual(checkoutRepresentation(config), { enabled: true });
  assert.equal(checkoutRepresentation(config, `${comments}, ${wallets}`), config);
  assert.deepEqual(checkoutRepresentation(config, wallets), {
    enabled: true,
    paymentMethods: ['kaspi', 'card'],
    paymentEnvironment: 'test',
  });
});
