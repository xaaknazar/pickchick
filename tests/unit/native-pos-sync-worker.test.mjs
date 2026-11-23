import assert from 'node:assert/strict';
import test from 'node:test';
import { runPosStreamsLoop, syncErrorCode } from '../../infra/windows/native-pos-sync-worker.mjs';

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
  for (const error of [
    new Error('postgresql://user:secret@127.0.0.1/db'),
    coded('postgresql://user:secret@127.0.0.1/db'),
    coded(identity.token),
    coded('A'.repeat(41)),
    coded(42501),
    null,
    undefined,
    'text',
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
  assert.deepEqual(lines.fail[0], {
    event: 'native_pos_sync_failed',
    stream: 'pos_order_sync',
    code: '42501',
    retrying: true,
  });
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
