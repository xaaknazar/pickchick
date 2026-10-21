import test from 'node:test';
import assert from 'node:assert/strict';
import { PAYMENT_COMMAND, prepareCheckout } from '../../apps/mobile/src/checkout-preflight.ts';
import { CustomerSessionError } from '../../apps/mobile/src/customer-session.ts';

test('retries transient reads and restaurant readiness with the same captured command', async () => {
  const controller = new AbortController();
  const command = { key: 'fixed-key', quoteId: 'fixed-quote' };
  const attempts = [],
    delays = [];
  const value = await prepareCheckout(
    async () => {
      attempts.push(command);
      if (attempts.length === 1) throw new CustomerSessionError('NETWORK_UNAVAILABLE');
      if (attempts.length === 2) throw new CustomerSessionError('AVAILABILITY_STALE', 409, true);
      if (attempts.length === 3) throw new CustomerSessionError('NOT_READY', 503, true);
      return 'accepted';
    },
    controller.signal,
    async (ms) => {
      delays.push(ms);
    },
  );
  assert.equal(value, 'accepted');
  assert.deepEqual(delays, [1000, 2000, 2000]);
  assert.ok(attempts.every((value) => value === command));
});
test('kitchen offline ends the attempt at once instead of a minute of silent retries', async () => {
  // Audit 2.5: the server answers 503 KITCHEN_OFFLINE; a 503 must not fall into the
  // generic transport retry either.
  let calls = 0;
  await assert.rejects(
    prepareCheckout(
      async () => {
        calls++;
        throw new CustomerSessionError('KITCHEN_OFFLINE', 503, true);
      },
      new AbortController().signal,
      async () => assert.fail('no retry delay'),
    ),
    { message: 'KITCHEN_OFFLINE' },
  );
  assert.equal(calls, 1);
});
test('a refused bank command is shown, never repeated in the background', async () => {
  // Audit 2.1: /payment refusals end the attempt; only a stale stop list and transport
  // failures are retried within the same explicit tap.
  for (const [code, status] of [
    ['ITEM_STOPPED', 409],
    ['RESTAURANT_CLOSED', 409],
    ['NOT_READY', 503],
    ['KITCHEN_OFFLINE', 503],
  ]) {
    let calls = 0;
    await assert.rejects(
      prepareCheckout(
        async () => {
          calls++;
          throw new CustomerSessionError(code, status, true);
        },
        new AbortController().signal,
        async () => assert.fail(`no retry after ${code}`),
        PAYMENT_COMMAND,
      ),
      { message: code },
    );
    assert.equal(calls, 1, code);
  }
  const delays = [];
  let calls = 0;
  const value = await prepareCheckout(
    async () => {
      calls++;
      if (calls === 1) throw new CustomerSessionError('NETWORK_UNAVAILABLE');
      if (calls === 2) throw new CustomerSessionError('AVAILABILITY_STALE', 409, true);
      return 'sent';
    },
    new AbortController().signal,
    async (ms) => {
      delays.push(ms);
    },
    PAYMENT_COMMAND,
  );
  assert.equal(value, 'sent');
  assert.deepEqual(delays, [1000, 2000]);
});
test('confirmed stop list, closed restaurant and account rejection do not retry', async () => {
  for (const code of ['ITEM_STOPPED', 'RESTAURANT_CLOSED', 'FORBIDDEN', 'QUOTE_EXPIRED']) {
    let calls = 0;
    await assert.rejects(
      prepareCheckout(async () => {
        calls++;
        throw new CustomerSessionError(code, 409, true);
      }, new AbortController().signal),
      { message: code },
    );
    assert.equal(calls, 1);
  }
});
test('cancellation during retry prevents another request', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    prepareCheckout(
      async () => {
        calls++;
        throw new CustomerSessionError('NETWORK_UNAVAILABLE');
      },
      controller.signal,
      async () => controller.abort(),
    ),
    /CHECKOUT_CANCELLED/,
  );
  assert.equal(calls, 1);
});
test('late successful response after cancellation is not accepted', async () => {
  const controller = new AbortController();
  await assert.rejects(
    prepareCheckout(async () => {
      controller.abort();
      return 'late';
    }, controller.signal),
    /CHECKOUT_CANCELLED/,
  );
});
test('already cancelled preparation issues no request', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    prepareCheckout(async () => {
      assert.fail('request after cancel');
    }, controller.signal),
    /CHECKOUT_CANCELLED/,
  );
});
