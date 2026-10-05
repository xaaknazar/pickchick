import test from 'node:test';
import assert from 'node:assert/strict';
import { availablePaymentMethods } from '../../apps/mobile/src/payment-methods.ts';
const all = ['kaspi', 'card', 'apple_pay', 'google_pay'];
test('old server falls back to Kaspi; explicit empty list stays unavailable', () => {
  assert.deepEqual(availablePaymentMethods(undefined, 'ios'), ['kaspi']);
  assert.deepEqual(availablePaymentMethods([], 'ios'), []);
});
test('wallets require server admission and matching device', () => {
  assert.deepEqual(availablePaymentMethods(all, 'ios'), ['kaspi', 'card', 'apple_pay']);
  assert.deepEqual(availablePaymentMethods(all, 'android'), ['kaspi', 'card', 'google_pay']);
  assert.deepEqual(availablePaymentMethods(all, 'web'), ['kaspi', 'card']);
  assert.deepEqual(availablePaymentMethods(['card'], 'ios', { applePay: true }), ['card']);
});
test('web wallets require explicit capability; duplicate methods collapse', () => {
  assert.deepEqual(availablePaymentMethods([...all, 'card'], 'web', { applePay: true }), [
    'kaspi',
    'card',
    'apple_pay',
  ]);
});
