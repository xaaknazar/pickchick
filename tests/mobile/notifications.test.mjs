import test from 'node:test';
import assert from 'node:assert/strict';
import {
  notificationId,
  boundedNativeRequest,
} from '../../apps/mobile/src/notifications/routing.ts';
test('push routing accepts only a notification identity and rejects arbitrary URLs and forged payment actions', () => {
  const id = '40000000-0000-4000-8000-000000000001';
  assert.equal(notificationId({ type: 'order', notificationId: id }), id);
  for (const value of [
    null,
    {},
    { type: 'payment_confirmed', notificationId: id },
    { type: 'order', notificationId: 'https://attacker.test' },
    { url: 'pickchick://checkout?paid=1' },
  ])
    assert.equal(notificationId(value), null);
});

test('an offline native token request times out without blocking later retries', async () => {
  await assert.rejects(boundedNativeRequest(new Promise(() => {}), 5), /native_push_timeout/);
  assert.equal(await boundedNativeRequest(Promise.resolve('native-token'), 5), 'native-token');
});
