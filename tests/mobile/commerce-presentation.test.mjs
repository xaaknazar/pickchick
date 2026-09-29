import assert from 'node:assert/strict';
import test from 'node:test';
import {
  paymentReceived,
  paymentCopy,
  checkoutError,
} from '../../apps/mobile/src/commerce-presentation.ts';
import { CustomerCommerceOrderSchema } from '../../packages/contracts/dist/index.js';

test('uncertain, failed and sent invoices never render as received money', () => {
  for (const phase of [
    'awaiting_restaurant',
    'ready_to_pay',
    'sending',
    'awaiting_payment',
    'checking',
    'failed',
    'attention',
  ]) {
    assert.equal(paymentReceived(phase), false);
    assert.ok(paymentCopy[phase].title && paymentCopy[phase].detail);
  }
  for (const phase of ['paid', 'preparing', 'ready', 'handed_over'])
    assert.equal(paymentReceived(phase), true);
  assert.match(checkoutError(new Error('QUOTE_EXPIRED')), /цен.*изменились/);
  assert.match(checkoutError(new Error('CHECKOUT_STORAGE')), /Счёт не отправлен/);
});
test('customer payment contract rejects extra financial internals and invalid phases', () => {
  const value = {
    orderId: '40000000-0000-4000-8000-000000000003',
    revision: 'a'.repeat(64),
    restaurant: 'Synthetic',
    displayNumber: null,
    totalMinor: '10000',
    serviceMode: 'takeaway',
    phase: 'checking',
    expiresAt: null,
    receipt: 'deferred',
    receiptUrl: null,
    items: [],
  };
  assert.ok(CustomerCommerceOrderSchema.safeParse(value).success);
  assert.equal(CustomerCommerceOrderSchema.safeParse({ ...value, attempts: [] }).success, false);
  assert.equal(
    CustomerCommerceOrderSchema.safeParse({ ...value, phase: 'verified' }).success,
    false,
  );
  assert.equal(CustomerCommerceOrderSchema.safeParse({ ...value, totalMinor: -1 }).success, false);
});

test('closing payment status aborts its long poll without widening the auth transport', async () => {
  const { createCustomerRequest } = await import('../../apps/mobile/src/customer-http.ts');
  const controller = new AbortController();
  let aborted = false;
  const fetcher = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(new Error('cancelled'));
        },
        { once: true },
      );
    });
  const transport = createCustomerRequest('https://example.test', fetcher, {
    allowed: /^\/v1\/customer-checkout\/orders$/,
    timeoutMs: 28000,
    maxBytes: 128000,
    signal: controller.signal,
  });
  const pending = transport('/v1/customer-checkout/orders', 'GET', undefined, 'a'.repeat(64));
  controller.abort();
  await assert.rejects(pending, /NETWORK_UNAVAILABLE/);
  assert.equal(aborted, true);
  await assert.rejects(
    createCustomerRequest('https://example.test', fetcher)('/v1/customer-checkout/orders', 'GET'),
    /INVALID_API_PATH/,
  );
});
