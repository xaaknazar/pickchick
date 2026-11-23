import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  createWatchCursor,
  wait,
  watchCommerceOrder,
  watchRetryDelay,
} from '../../apps/mobile/src/commerce-watch.ts';
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

test('a poll delay ends at once on abort and leaves no listener on the signal (audit 23.11 #10)', async () => {
  const signal = {
    aborted: false,
    listeners: new Set(),
    added: 0,
    addEventListener(type, listener, options) {
      assert.equal(type, 'abort');
      assert.deepEqual(options, { once: true });
      this.added += 1;
      this.listeners.add(listener);
    },
    removeEventListener(type, listener) {
      this.listeners.delete(listener);
    },
  };
  // A poll loop waits on the same signal many times: nothing accumulates on it.
  for (let i = 0; i < 5; i += 1) await wait(1, signal);
  assert.equal(signal.added, 5);
  assert.equal(signal.listeners.size, 0);
  // Abort during the delay ends it without waiting for the timer.
  const controller = new AbortController();
  const started = Date.now();
  const pending = wait(60_000, controller.signal);
  controller.abort();
  await pending;
  // Already aborted: no delay at all.
  await wait(60_000, controller.signal);
  assert.ok(Date.now() - started < 1000);
  // The TipTopPay status polls use this delay instead of their own.
  const checkout = readFileSync(
    new URL('../../apps/mobile/src/useTipTopPayCheckout.tsx', import.meta.url),
    'utf8',
  );
  assert.match(checkout, /import \{ wait as sleep \} from '\.\/commerce-watch';/);
  assert.doesNotMatch(checkout, /const sleep = /);
});

test('the read after an accepted answer asks with the new revision (audit 23.11 #9)', async () => {
  const shown = { orderId: 'o1', revision: 'r1' };
  const cursor = createWatchCursor(shown);
  const controller = new AbortController();
  const asked = [];
  await watchCommerceOrder({
    signal: controller.signal,
    read: async () => {
      asked.push(cursor.after());
      return { orderId: 'o1', revision: `r${asked.length + 1}` };
    },
    accept: async (next) => {
      cursor.accepted(next);
      if (asked.length === 3) controller.abort();
    },
    onError: () => assert.fail('no error'),
    onRecovered: () => {},
  });
  // Before: r1, r1, r1 - the server answered each repeat at once.
  assert.deepEqual(asked, ['r1', 'r2', 'r3']);
  // Review 23.11: the cursor starts from what the screen shows and moves only with answers of
  // this watch. A newer copy of the order kept elsewhere (a ref left from an earlier screen) or
  // another order never moves it, so the watch cannot wait while the screen stays old.
  const reopened = createWatchCursor({ orderId: 'o1', revision: 'old' });
  assert.equal(reopened.after(), 'old');
  reopened.accepted({ orderId: 'o2', revision: 'other' });
  assert.equal(reopened.after(), 'old');
  reopened.accepted({ orderId: 'o1', revision: 'new' });
  assert.equal(reopened.after(), 'new');
  const screen = readFileSync(
    new URL('../../apps/mobile/src/screens/KaspiCheckoutScreen.tsx', import.meta.url),
    'utf8',
  );
  assert.match(screen, /const cursor = createWatchCursor\(order\);/);
  assert.match(screen, /watch\?after=\$\{cursor\.after\(\)\}/);
  assert.match(screen, /cursor\.accepted\(await acceptRef\.current\(next, false\)\);/);
  assert.doesNotMatch(screen, /watch\?after=\$\{[^}]*orderRef/);
  // One watch follows the order through its revisions: an answer does not restart it.
  assert.match(
    screen,
    /\}, \[request, order\?\.orderId, order\?\.phase, foreground, watchRun\]\);/,
  );
  // An order opened from the list is the order the ref holds too.
  assert.equal(screen.match(/orderRef\.current = item;\n\s+setOrder\(item\);/g)?.length, 2);
  assert.doesNotMatch(screen, /(?<!orderRef\.current = item;\n\s+)setOrder\(item\);/);
});
