import assert from 'node:assert/strict';
import test from 'node:test';
import { watchCommerceOrder, watchRetryDelay } from '../../apps/mobile/src/commerce-watch.ts';
import { CustomerSessionError } from '../../apps/mobile/src/customer-session.ts';

test('order reads recover automatically with bounded backoff and keep one request in flight', async () => {
  const controller = new AbortController(),
    delays = [],
    accepted = [],
    errors = [];
  let calls = 0,
    inFlight = 0,
    recovered = 0;
  await watchCommerceOrder({
    signal: controller.signal,
    read: async () => {
      assert.equal(++inFlight, 1);
      await Promise.resolve();
      inFlight--;
      if (++calls <= 7) throw new CustomerSessionError('NETWORK_UNAVAILABLE');
      return { phase: 'paid', revision: 'server-confirmed' };
    },
    accept: async (value) => {
      accepted.push(value);
    },
    onError: (error, retrying) => errors.push([error.code, retrying]),
    onRecovered: () => {
      recovered++;
      controller.abort();
    },
    wait: async (ms) => {
      delays.push(ms);
    },
  });
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(calls, 8);
  assert.equal(recovered, 1);
  assert.deepEqual(accepted, [{ phase: 'paid', revision: 'server-confirmed' }]);
  assert.ok(errors.every(([code, retrying]) => code === 'NETWORK_UNAVAILABLE' && retrying));
});

test('authorization, malformed replies and local storage errors never loop', async () => {
  for (const error of [
    new CustomerSessionError('UNAUTHORIZED', 401, true),
    new CustomerSessionError('FORBIDDEN', 403, true),
    new CustomerSessionError('INVALID_RESPONSE'),
    new Error('storage failed'),
  ]) {
    let calls = 0;
    await watchCommerceOrder({
      signal: new AbortController().signal,
      read: async () => {
        calls++;
        throw error;
      },
      accept: async () => assert.fail('invalid response accepted'),
      onError: (actual, retrying) => {
        assert.equal(actual, error);
        assert.equal(retrying, false);
      },
      onRecovered: () => assert.fail('reported recovery'),
      wait: async () => assert.fail('unexpected retry'),
    });
    assert.equal(calls, 1);
  }
  assert.equal(
    watchRetryDelay(new CustomerSessionError('SERVICE_UNAVAILABLE', 503, true), 1),
    1000,
  );
  assert.equal(watchRetryDelay(new CustomerSessionError('RATE_LIMITED', 429, true), 8), 30000);
});

test('background/unmount abort cancels reconnect timer and ignores late responses', async () => {
  for (const late of [false, true]) {
    const controller = new AbortController();
    let calls = 0;
    await watchCommerceOrder({
      signal: controller.signal,
      read: async () => {
        calls++;
        if (late) {
          controller.abort();
          return { phase: 'paid' };
        }
        throw new CustomerSessionError('NETWORK_UNAVAILABLE');
      },
      accept: async () => assert.fail('accepted after abort'),
      onError: () => {
        Promise.resolve().then(() => controller.abort());
      },
      onRecovered: () => assert.fail('recovered after abort'),
    });
    assert.equal(calls, 1);
  }
});

test('storage failure while accepting a trusted response stops automatic reads', async () => {
  let calls = 0;
  await watchCommerceOrder({
    signal: new AbortController().signal,
    read: async () => {
      calls++;
      return { phase: 'paid' };
    },
    accept: async () => {
      throw new Error('storage failed');
    },
    onError: (_, retrying) => assert.equal(retrying, false),
    onRecovered: () => assert.fail('not persisted'),
  });
  assert.equal(calls, 1);
});
