import assert from 'node:assert/strict';
import test from 'node:test';
import {
  POS_SYNC_REPEAT_LOG_MS,
  runPosStreamsLoop,
  syncErrorCode,
} from '../../infra/windows/native-pos-sync-worker.mjs';

const identity = { device_id: 'device', branch_id: 'branch', token: 'f'.repeat(64) };
const coded = (code, message = 'driver text') => Object.assign(new Error(message), { code });
function harness() {
  const lines = { log: [], fail: [] };
  return {
    lines,
    base: {
      pool: {},
      branchId: 'branch',
      origin: 'http://127.0.0.1:43110',
      log: (line) => lines.log.push(JSON.parse(line)),
      fail: (line) => lines.fail.push(JSON.parse(line)),
    },
  };
}

test('only a whitelisted error code is ever logged', () => {
  assert.equal(syncErrorCode(coded('FORBIDDEN')), 'FORBIDDEN');
  assert.equal(syncErrorCode(coded('42501')), '42501');
  assert.equal(syncErrorCode(coded('ECONNREFUSED')), 'ECONNREFUSED');
  // The code of the cause, then the error class: different code-less failures stay apart.
  assert.equal(
    syncErrorCode(Object.assign(new Error('wrapped'), { cause: coded('ECONNRESET') })),
    'ECONNRESET',
  );
  assert.equal(syncErrorCode(new TypeError('postgresql://user:secret@127.0.0.1/db')), 'TypeError');
  assert.equal(syncErrorCode(Object.assign(new Error('x'), { name: 'ZodError' })), 'ZodError');
  for (const error of [
    new Error('postgresql://user:secret@127.0.0.1/db'),
    coded('postgresql://user:secret@127.0.0.1/db'),
    coded(identity.token),
    coded('A'.repeat(41)),
    coded(42501),
  ])
    assert.equal(syncErrorCode(error), 'Error');
  for (const error of [
    null,
    undefined,
    'text',
    Object.assign(new Error('x'), { name: 'postgresql://user:secret@127.0.0.1/db' }),
    { name: identity.token + '!' },
  ])
    assert.equal(syncErrorCode(error), 'UNKNOWN');
});

test('an order stream that throws on every pass never stops the kitchen stream', async () => {
  const { lines, base } = harness();
  const stop = new AbortController();
  let orders = 0,
    kitchen = 0;
  await runPosStreamsLoop({
    ...base,
    sync: {
      syncPosOrdersOnce: async () => {
        orders += 1;
        throw coded('42501', `permission denied ${identity.token}`);
      },
      syncPosKitchenOnce: async (pool, input) => {
        kitchen += 1;
        assert.deepEqual(input, {
          enabled: true,
          branchId: 'branch',
          origin: 'http://127.0.0.1:43110',
          identity,
        });
        return { state: 'idle' };
      },
    },
    identity: async () => identity,
    once: false,
    signal: stop.signal,
    pause: async () => {
      if (kitchen >= 3) stop.abort();
    },
  });
  assert.equal(orders, 3);
  assert.equal(kitchen, 3);
  // The same failure on every pass is one line, not one per second.
  assert.deepEqual(lines.fail, [
    { event: 'native_pos_sync_failed', stream: 'pos_order_sync', code: '42501', retrying: true },
  ]);
  assert.ok(!JSON.stringify(lines).includes(identity.token));
  assert.ok(!JSON.stringify(lines).includes('permission denied'));
});

test('--once runs both streams once and reports a failed stream in the exit code', async () => {
  const { lines, base } = harness();
  const exitCode = process.exitCode;
  try {
    process.exitCode = 0;
    await runPosStreamsLoop({
      ...base,
      sync: {
        syncPosOrdersOnce: async () => ({ state: 'idle' }),
        syncPosKitchenOnce: async () => {
          throw coded('NOT_FOUND');
        },
      },
      identity: async () => identity,
      once: true,
      signal: new AbortController().signal,
      pause: () => assert.fail('no pause in --once'),
    });
    assert.equal(process.exitCode, 1);
    assert.deepEqual(lines.log, [{ event: 'pos_order_sync', state: 'idle' }]);
    assert.deepEqual(lines.fail, [
      {
        event: 'native_pos_sync_failed',
        stream: 'pos_kitchen_sync',
        code: 'NOT_FOUND',
        retrying: false,
      },
    ]);
    // An unreadable identity: no stream runs, the failure names the identity.
    lines.fail.length = 0;
    process.exitCode = 0;
    await runPosStreamsLoop({
      ...base,
      sync: {
        syncPosOrdersOnce: () => assert.fail('no stream without an identity'),
        syncPosKitchenOnce: () => assert.fail('no stream without an identity'),
      },
      identity: async () => {
        throw coded('IDENTITY_EXPIRED');
      },
      once: true,
      signal: new AbortController().signal,
    });
    assert.equal(process.exitCode, 1);
    assert.deepEqual(lines.fail, [
      {
        event: 'native_pos_sync_failed',
        stream: 'identity',
        code: 'IDENTITY_EXPIRED',
        retrying: false,
      },
    ]);
  } finally {
    process.exitCode = exitCode;
  }
});

test('a standing retry or dead letter is logged when it changes and then every 10 minutes', async () => {
  const { lines, base } = harness();
  const stop = new AbortController();
  // One entry per pass: [order state, kitchen state, clock].
  const passes = [
    ['retry', 'dead_letter', 0],
    ['retry', 'dead_letter', 1000],
    ['busy', 'dead_letter', 2000],
    ['retry', 'dead_letter', 3000],
    ['delivered', 'dead_letter', 4000],
    ['delivered', 'dead_letter', 5000],
    ['idle', 'idle', 6000],
    ['retry', 'disabled', 7000],
    ['retry', 'idle', 7000 + POS_SYNC_REPEAT_LOG_MS - 1],
    ['retry', 'idle', 7000 + POS_SYNC_REPEAT_LOG_MS],
  ];
  let pass = 0,
    clock = 0;
  await runPosStreamsLoop({
    ...base,
    sync: {
      syncPosOrdersOnce: async () => {
        clock = passes[pass][2];
        return { state: passes[pass][0], eventId: 'never logged' };
      },
      syncPosKitchenOnce: async () => {
        const state = passes[pass][1];
        pass += 1;
        if (pass === passes.length) stop.abort();
        return { state };
      },
    },
    identity: async () => identity,
    once: false,
    signal: stop.signal,
    now: () => clock,
    pause: async () => {},
  });
  assert.equal(pass, passes.length);
  assert.deepEqual(lines.log, [
    { event: 'pos_order_sync', state: 'retry' },
    { event: 'pos_kitchen_sync', state: 'dead_letter' },
    // One line when a stream is back to normal, here with the delivery that ended the retry.
    { event: 'native_pos_sync_recovered', stream: 'pos_order_sync' },
    { event: 'pos_order_sync', state: 'delivered' },
    { event: 'pos_order_sync', state: 'delivered' },
    { event: 'native_pos_sync_recovered', stream: 'pos_kitchen_sync' },
    { event: 'pos_order_sync', state: 'retry' },
    { event: 'pos_order_sync', state: 'retry' },
  ]);
  assert.deepEqual(lines.fail, []);
  assert.ok(!JSON.stringify(lines).includes('never logged'));
});

test('an expired identity is read again with backoff and logged once', async () => {
  const { lines, base } = harness();
  const stop = new AbortController();
  let clock = 0,
    reads = 0,
    orders = 0;
  const readAt = [];
  await runPosStreamsLoop({
    ...base,
    sync: {
      syncPosOrdersOnce: async () => {
        orders += 1;
        stop.abort();
        return { state: 'idle' };
      },
      syncPosKitchenOnce: async () => ({ state: 'idle' }),
    },
    identity: async () => {
      reads += 1;
      readAt.push(clock);
      if (reads <= 4) throw coded('IDENTITY_EXPIRED');
      return identity;
    },
    once: false,
    signal: stop.signal,
    now: () => clock,
    // One pass a second, as the service loop.
    pause: async () => {
      clock += 1000;
    },
  });
  // 2 s, 4 s, 8 s, 16 s between the reads instead of one read per pass.
  assert.deepEqual(readAt, [0, 2000, 6000, 14000, 30000]);
  assert.equal(orders, 1);
  assert.deepEqual(lines.log, [{ event: 'native_pos_sync_recovered', stream: 'identity' }]);
  assert.deepEqual(lines.fail, [
    {
      event: 'native_pos_sync_failed',
      stream: 'identity',
      code: 'IDENTITY_EXPIRED',
      retrying: true,
    },
  ]);
});
