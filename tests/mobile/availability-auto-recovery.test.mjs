import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import {
  CONFIRMATION_DELAY_MS,
  createAvailabilityRecovery,
} from '../../apps/mobile/src/availability-recovery.ts';
import { availabilityStatus, availabilityMessage } from '../../apps/mobile/src/availability.ts';
import { recoveryRetryDelay } from '../../apps/mobile/src/catalog-recovery.ts';
const snapshot = (fresh = true) => ({
  enabled: true,
  fresh,
  signature: (fresh ? 'a' : 'b').repeat(64),
  products: [{ id: 'cola', available: false, stoppedOptions: [] }],
});

test('cold offline, successful stale restaurant and restored connection stay distinct', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let mode = 'offline';
  let state = { data: null, status: 'checking' };
  const reads = [];
  const recovery = createAvailabilityRecovery({
    random: () => 1,
    onChecking: () => {},
    read: async (_signal, signature) => {
      reads.push(signature);
      if (mode === 'offline') throw new Error('Network request failed');
      return snapshot(mode === 'fresh');
    },
    onSuccess: (data) => {
      state = { data, status: 'online' };
    },
    onFailure: (_e, retrying) => {
      state = { ...state, status: retrying ? 'offline' : 'error' };
    },
  });
  t.after(() => recovery.stop());
  recovery.setActive(true);
  await flush();
  assert.equal(availabilityStatus(state), 'offline');
  assert.match(availabilityMessage('offline'), /сервером/);
  mode = 'stale';
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(availabilityStatus(state), 'stale');
  assert.match(availabilityMessage('stale'), /от ресторана/);
  assert.equal(state.data.products[0].available, false);
  mode = 'fresh';
  t.mock.timers.tick(100);
  await flush();
  assert.equal(availabilityStatus(state), 'current');
  assert.equal(availabilityMessage('current'), null);
  assert.deepEqual(reads, ['', '', 'b'.repeat(64)]);
});

test('foreground cancels old long poll before a new read, and discards its late result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = [];
  const values = [];
  const recovery = createAvailabilityRecovery({
    random: () => 1,
    onChecking: () => {},
    onFailure: () => {},
    onSuccess: (v) => values.push(v),
    read: (signal, signature) =>
      new Promise((resolve) => pending.push({ signal, signature, resolve })),
  });
  t.after(() => recovery.stop());
  recovery.setActive(true);
  recovery.setActive(false);
  recovery.setActive(true);
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending.length, 1);
  pending[0].resolve(snapshot(false));
  await flush();
  assert.equal(pending.length, 2);
  assert.equal(pending[1].signature, '');
  assert.equal(values.length, 0);
  pending[1].resolve(snapshot());
  await flush();
  assert.deepEqual(values, [snapshot()]);
  recovery.stop();
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(pending.length, 2);
});

test('disabled capability polls slowly, malformed payload stops until an explicit lifecycle retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let invalid = false;
  const errors = [];
  const recovery = createAvailabilityRecovery({
    read: async () => {
      calls++;
      if (invalid) throw Error('INVALID_AVAILABILITY');
      return { enabled: false, fresh: false, signature: 'disabled', products: [] };
    },
    onChecking: () => {},
    onSuccess: () => {},
    onFailure: (e, retry) => errors.push([e.message, retry]),
  });
  t.after(() => recovery.stop());
  recovery.setActive(true);
  await flush();
  t.mock.timers.tick(14999);
  await flush();
  assert.equal(calls, 1);
  invalid = true;
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(errors, [['INVALID_AVAILABILITY', false]]);
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(calls, 2);
  recovery.setActive(false);
  invalid = false;
  recovery.setActive(true);
  await flush();
  assert.equal(calls, 3);
});

test('jitter is bounded and does not grow without limit', () => {
  for (const count of [1, 2, 3, 4, 100000]) {
    const low = recoveryRetryDelay(count, () => 0),
      high = recoveryRetryDelay(count, () => 1);
    assert.ok(low >= 1600);
    assert.ok(high <= 30000);
    assert.equal(low, high * 0.8);
  }
});

test('permanent HTTP rejection stops while server overload retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { AvailabilityRequestError } =
    await import('../../apps/mobile/src/availability-recovery.ts');
  let status = 503;
  let calls = 0;
  const failures = [];
  const recovery = createAvailabilityRecovery({
    random: () => 1,
    read: async () => {
      calls++;
      throw new AvailabilityRequestError(status);
    },
    onChecking: () => {},
    onSuccess: () => assert.fail(),
    onFailure: (_error, retrying) => failures.push(retrying),
  });
  t.after(() => recovery.stop());
  recovery.setActive(true);
  await flush();
  status = 403;
  t.mock.timers.tick(2000);
  await flush();
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(calls, 2);
  assert.deepEqual(failures, [true, false]);
});

test('a dropped long poll is confirmed with a snapshot without flashing offline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reads = [],
    failures = [],
    values = [];
  const recovery = createAvailabilityRecovery({
    read: async (_signal, signature) => {
      reads.push(signature);
      if (signature) throw new TypeError('Network request failed');
      return snapshot();
    },
    onChecking() {},
    onSuccess: (v) => values.push(v),
    onFailure: (e) => failures.push(e),
  });
  t.after(() => recovery.stop());
  recovery.setActive(true);
  await flush();
  t.mock.timers.tick(100);
  await flush();
  // The snapshot waits a moment, off the connection that has just died (tech lead 28.10.2026).
  assert.deepEqual(reads, ['', 'a'.repeat(64)]);
  t.mock.timers.tick(CONFIRMATION_DELAY_MS - 1);
  await flush();
  assert.deepEqual(reads, ['', 'a'.repeat(64)]);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(reads, ['', 'a'.repeat(64), '']);
  assert.equal(values.length, 2);
  assert.equal(failures.length, 0);
});

test('the pause lets a single dead connection recover inside one read cycle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // The long-poll's keep-alive connection was closed by the carrier: whatever is sent in the next
  // 300 ms still goes over it and fails; after that the client has a fresh connection.
  const run = async (confirmationDelayMs) => {
    let dead = false;
    let calls = 0;
    const failures = [];
    const values = [];
    const recovery = createAvailabilityRecovery({
      confirmationDelayMs,
      random: () => 1,
      read: async (_signal, signature) => {
        calls++;
        if (dead) throw new TypeError('The network connection was lost.');
        if (signature) {
          dead = true;
          setTimeout(() => (dead = false), 300);
          throw new TypeError('The network connection was lost.');
        }
        return snapshot();
      },
      onChecking() {},
      onSuccess: (v) => values.push(v),
      onFailure: (_e, retrying) => failures.push(retrying),
    });
    recovery.setActive(true);
    await flush();
    t.mock.timers.tick(100);
    await flush();
    t.mock.timers.tick(CONFIRMATION_DELAY_MS);
    await flush();
    await flush();
    recovery.stop();
    return { calls, failures, values: values.length };
  };
  assert.equal(CONFIRMATION_DELAY_MS, 400);
  // With the pause: the drop is absorbed, nothing failed.
  assert.deepEqual(await run(undefined), { calls: 3, failures: [], values: 2 });
  // Build 25 sent the snapshot at once over the dead connection: a whole failed cycle.
  assert.deepEqual(await run(0), { calls: 3, failures: [true], values: 1 });
});

test('going to the background during the pause sends no confirmation at all', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const failures = [];
  const recovery = createAvailabilityRecovery({
    read: async () => {
      if (++calls === 1) return snapshot();
      throw new TypeError('Network request failed');
    },
    onChecking() {},
    onSuccess() {},
    onFailure: (e) => failures.push(e),
  });
  t.after(() => recovery.stop());
  recovery.setActive(true);
  await flush();
  t.mock.timers.tick(100);
  await flush();
  assert.equal(calls, 2);
  recovery.setActive(false);
  t.mock.timers.tick(CONFIRMATION_DELAY_MS);
  await flush();
  assert.equal(calls, 2);
  assert.equal(failures.length, 0);
});

test('a failed confirmation still reports offline and retries with backoff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const failures = [];
  const recovery = createAvailabilityRecovery({
    read: async () => {
      if (++calls > 1) throw new TypeError('Network request failed');
      return snapshot();
    },
    random: () => 1,
    onChecking() {},
    onSuccess() {},
    onFailure: (_, retry) => failures.push(retry),
  });
  t.after(() => recovery.stop());
  recovery.setActive(true);
  await flush();
  t.mock.timers.tick(100);
  await flush();
  assert.equal(calls, 2);
  t.mock.timers.tick(CONFIRMATION_DELAY_MS);
  await flush();
  assert.equal(calls, 3);
  assert.deepEqual(failures, [true]);
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(calls, 3);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 4);
});

test('background cancellation never launches a confirmation request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const failures = [];
  const recovery = createAvailabilityRecovery({
    read: async (signal) => {
      if (++calls === 1) return snapshot();
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new TypeError('Aborted'))),
      );
    },
    onChecking() {},
    onSuccess() {},
    onFailure: (e) => failures.push(e),
  });
  t.after(() => recovery.stop());
  recovery.setActive(true);
  await flush();
  t.mock.timers.tick(100);
  await flush();
  recovery.setActive(false);
  await flush();
  assert.equal(calls, 2);
  assert.equal(failures.length, 0);
});
