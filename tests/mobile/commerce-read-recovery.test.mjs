import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import {
  recoverCommerceRead,
  historyOrderNeedsWatch,
  checkoutReadError,
} from '../../apps/mobile/src/commerce-read-recovery.ts';
import { CustomerSessionError } from '../../apps/mobile/src/customer-session.ts';
const offline = new CustomerSessionError('NETWORK_UNAVAILABLE');

test('checkout read retries long outages, pauses background and immediately resumes foreground', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stop = new AbortController();
  let listener;
  let calls = 0;
  let connected = false;
  const errors = [];
  const result = recoverCommerceRead({
    read: async () => {
      calls++;
      if (!connected) throw offline;
      return { orders: [] };
    },
    signal: stop.signal,
    active: true,
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    onFailure: (e) => errors.push(e),
    onRecovered: () => {},
    random: () => 1,
  });
  await flush();
  for (const delay of [2000, 5000, 15000, 30000, 30000]) {
    t.mock.timers.tick(delay);
    await flush();
  }
  assert.equal(calls, 6);
  listener(false);
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(calls, 6);
  connected = true;
  listener(true);
  assert.deepEqual(await result, { orders: [] });
  assert.equal(calls, 7);
  assert.equal(listener, null);
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(calls, 7);
  assert.equal(errors.length, 6);
});

test('disabled config is only polled through reads until eligible, with no commands in the loop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let enabled = false;
  let reads = 0;
  let pending = 0;
  let accepted = false;
  const result = recoverCommerceRead({
    read: async () => {
      reads++;
      return { enabled };
    },
    accept: (v) => v.enabled,
    onPending: () => pending++,
    signal: new AbortController().signal,
    active: true,
    subscribe: () => () => {},
    onFailure: () => assert.fail(),
    onRecovered: () => {
      accepted = true;
    },
    random: () => 1,
  });
  await flush();
  assert.equal(accepted, false);
  assert.equal(pending, 1);
  enabled = true;
  t.mock.timers.tick(10000);
  await flush();
  assert.deepEqual(await result, { enabled: true });
  assert.equal(reads, 2);
});

test('authoritative account rejection never retries; cancellation rejects and suppresses late success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  await assert.rejects(
    recoverCommerceRead({
      read: async () => {
        calls++;
        throw new CustomerSessionError('FORBIDDEN', 403, true);
      },
      signal: new AbortController().signal,
      active: true,
      subscribe: () => () => {},
      onFailure: () => {},
      onRecovered: () => assert.fail(),
    }),
    /FORBIDDEN/,
  );
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(calls, 1);
  const controller = new AbortController();
  let resolve;
  let recovered = false;
  const result = recoverCommerceRead({
    read: () =>
      new Promise((r) => {
        resolve = r;
      }),
    signal: controller.signal,
    active: true,
    subscribe: () => () => {},
    onFailure: () => {},
    onRecovered: () => {
      recovered = true;
    },
  });
  controller.abort();
  await assert.rejects(result, /cancelled/);
  resolve('late');
  await flush();
  assert.equal(recovered, false);
});

test('paid kitchen phases stay watched and initial errors do not claim a persisted order or payment', () => {
  for (const phase of ['paid', 'preparing', 'ready', 'checking', 'awaiting_payment'])
    assert.equal(historyOrderNeedsWatch(phase), true);
  for (const phase of ['handed_over', 'failed', 'attention'])
    assert.equal(historyOrderNeedsWatch(phase), false);
  const message = checkoutReadError(offline, false);
  assert.match(message, /Корзина сохранена/);
  assert.doesNotMatch(message, /Заказ сохранён|оплачивать/);
  assert.match(message, /автоматически/);
  assert.doesNotMatch(checkoutReadError(new Error('bad schema'), true), /автоматически/);
});
