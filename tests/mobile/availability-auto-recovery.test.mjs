import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { createAvailabilityRecovery } from '../../apps/mobile/src/availability-recovery.ts';
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
