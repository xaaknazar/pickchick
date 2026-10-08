import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadConfig } from '../../packages/platform/dist/index.js';
import {
  MENU_SYNC_ORIGIN,
  failureCode,
  menuSyncMode,
  menuSyncRetryDelay,
  runMenuSyncLoop,
  validateWorkerConfig,
} from '../../infra/windows/native-menu-sync-worker.mjs';
import { SyncError } from '../../packages/menu-sync/dist/index.js';

const branchId = randomUUID(),
  deviceId = randomUUID();
const password = 'a'.repeat(64);
const env = {
  APP_ENV: 'local',
  EDGE_BRANCH_ID: branchId,
  EDGE_DEVICE_ID: deviceId,
  EDGE_MENU_SYNC_CLOUD_ORIGIN: MENU_SYNC_ORIGIN,
  EDGE_MENU_SYNC_MODE: 'off',
  EDGE_DATABASE_URL: `postgresql://pickchick_menu_sync:${password}@127.0.0.1:55433/pickchick_edge`,
};
const validate = (patch = {}, origin = MENU_SYNC_ORIGIN, ids = [branchId, deviceId]) => {
  const merged = { ...env, ...patch };
  validateWorkerConfig(loadConfig('edge', merged), merged, origin, ...ids);
};

test('menu worker accepts only its dedicated role on the local edge database and the tunnel origin', () => {
  validate();
  validate({ EDGE_DATABASE_URL: env.EDGE_DATABASE_URL.replace('postgresql:', 'postgres:') });
  // Non-loopback or foreign origins.
  for (const origin of [
    'http://localhost:43100',
    'http://127.0.0.1:3100',
    'http://127.0.0.1:43101',
    'https://127.0.0.1:43100',
    'http://192.168.2.157:43100',
    'https://api.example.invalid',
    'http://127.0.0.1:43100/',
    '',
    null,
  ])
    assert.throws(() => validate({}, origin), /scope or dedicated database role/);
  // Wrong ports, hosts, databases, users, passwords and URL overrides.
  for (const url of [
    env.EDGE_DATABASE_URL.replace('55433', '55432'),
    env.EDGE_DATABASE_URL.replace('55433', '5432'),
    env.EDGE_DATABASE_URL.replace('127.0.0.1', 'localhost'),
    ...[
      'pickchick_edge_owner',
      'pickchick_edge_runtime',
      'pickchick_fulfillment_sync',
      'pickchick_pos_sync',
    ].map((role) => env.EDGE_DATABASE_URL.replace('pickchick_menu_sync', role)),
    env.EDGE_DATABASE_URL.replace(password, 'short'),
    env.EDGE_DATABASE_URL.replace(password, 'A'.repeat(64)),
    env.EDGE_DATABASE_URL + '?options=-csearch_path%3Dother',
    env.EDGE_DATABASE_URL + '#fragment',
  ])
    assert.throws(() => validate({ EDGE_DATABASE_URL: url }));
  // Branch and device must match the service arguments.
  assert.throws(() => validate({}, MENU_SYNC_ORIGIN, [randomUUID(), deviceId]));
  assert.throws(() => validate({}, MENU_SYNC_ORIGIN, [branchId, randomUUID()]));
  assert.throws(() => validate({ EDGE_DEVICE_ID: randomUUID() }));
  assert.throws(() => validate({}, MENU_SYNC_ORIGIN, [branchId, 'not-a-uuid']));
  // The worker environment may not switch on another edge role.
  for (const patch of [
    { EDGE_REMOTE_STOPS_ENABLED: 'true' },
    { EDGE_POS_ORDER_SYNC_ENABLED: 'true' },
    { EDGE_FULFILLMENT_ENABLED: 'true' },
  ])
    assert.throws(() => validate(patch));
});

test('mode defaults off and accepts only off, report or apply', () => {
  assert.equal(menuSyncMode({}), 'off');
  for (const mode of ['off', 'report', 'apply'])
    assert.equal(menuSyncMode({ EDGE_MENU_SYNC_MODE: mode }), mode);
  for (const mode of ['', 'true', 'APPLY', ' apply', 'on'])
    assert.throws(() => menuSyncMode({ EDGE_MENU_SYNC_MODE: mode }));
});

test('idle polls every 2 s and failures back off exponentially up to 60 s', () => {
  assert.equal(
    menuSyncRetryDelay(0, () => 0.999),
    2000,
  );
  assert.equal(
    menuSyncRetryDelay(1, () => 0),
    2000,
  );
  assert.equal(
    menuSyncRetryDelay(3, () => 0),
    8000,
  );
  for (let failures = 1; failures < 50; failures++) {
    const wait = menuSyncRetryDelay(failures, () => 0.999);
    assert.ok(wait >= 2000 && wait <= 60499, String(wait));
  }
  assert.equal(
    menuSyncRetryDelay(6, () => 0),
    60000,
  );
  assert.throws(() => menuSyncRetryDelay(-1));
});

test('failure codes are sanitized and never carry tokens or messages', () => {
  const token = 'f'.repeat(64);
  assert.equal(failureCode(new SyncError('CONFLICT')), 'CONFLICT');
  assert.equal(failureCode(new Error('Sync HTTP 503')), 'HTTP_503');
  assert.equal(failureCode(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'TIMEOUT');
  assert.equal(failureCode(Object.assign(new Error('denied'), { code: '42501' })), 'DATABASE');
  assert.equal(
    failureCode(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })),
    'NETWORK',
  );
  assert.equal(failureCode(new Error('Expired or mismatched Windows identity')), 'IDENTITY');
  assert.equal(failureCode(new Error(`Bearer ${token}`)), 'UNEXPECTED');
  assert.equal(failureCode(Object.assign(new Error(token), { code: token })), 'UNEXPECTED');
});

function harness(results, { schema = [true] } = {}) {
  const logs = [],
    waits = [],
    calls = [];
  const controller = new AbortController();
  let schemaChecks = 0;
  return {
    logs,
    waits,
    calls,
    controller,
    options: {
      signal: controller.signal,
      log: (entry) => logs.push(entry),
      wait: async (ms) => {
        waits.push(ms);
        if (!results.length) controller.abort();
      },
      random: () => 0,
      schemaReady: async () => schema[Math.min(schemaChecks++, schema.length - 1)],
      // Scripted results; the loop stops at the first wait after the script is used up.
      sync: async (options) => {
        calls.push(options);
        if (calls.length > 50) controller.abort();
        const next = results.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

test('off mode never calls the cloud or the database', async () => {
  const h = harness([]);
  h.options.sync = () => assert.fail('sync must not run');
  h.options.schemaReady = () => assert.fail('database must not be used');
  assert.deepEqual(await runMenuSyncLoop({ ...h.options, mode: 'off', once: true }), {
    exitCode: 0,
  });
  assert.deepEqual(h.logs, [{ event: 'menu_sync_disabled', mode: 'off' }]);
  const running = harness([]);
  running.options.sync = () => assert.fail('sync must not run');
  running.options.wait = async (ms) => {
    running.waits.push(ms);
    running.controller.abort();
  };
  await runMenuSyncLoop({ ...running.options, mode: 'off' });
  assert.deepEqual(running.waits, [60000]);
});

test('report mode holds publications without applying and logs a held release once', async () => {
  const held = { state: 'held', release_id: randomUUID(), version: 3 };
  const h = harness([{ state: 'idle' }, held, { ...held }, { ...held }, { state: 'idle' }]);
  await runMenuSyncLoop({ ...h.options, mode: 'report' });
  assert.ok(h.calls.every((call) => call.applyEvents === false));
  assert.deepEqual(
    h.logs.map((entry) => entry.state),
    ['held'],
  );
  assert.deepEqual(h.waits.slice(0, 5), [2000, 2000, 2000, 2000, 2000]);
});

test('apply mode drains results at once, backs off on failure and logs no secrets', async () => {
  const token = 'e'.repeat(64);
  const h = harness([
    { state: 'applied' },
    { state: 'acknowledged' },
    new Error(`Sync HTTP 502 Bearer ${token}`),
    new Error(`Bearer ${token}`),
    { state: 'rejected', reason: 'MEDIA_UNAVAILABLE' },
    { state: 'idle' },
  ]);
  await runMenuSyncLoop({ ...h.options, mode: 'apply' });
  assert.ok(h.calls.every((call) => call.applyEvents === true));
  // applied and acknowledged loop immediately; failures wait 2 s then 4 s; rejected drains.
  assert.deepEqual(h.waits, [2000, 4000, 2000]);
  assert.deepEqual(
    h.logs.map((entry) => entry.state ?? entry.code),
    ['applied', 'acknowledged', 'UNEXPECTED', 'UNEXPECTED', 'rejected'],
  );
  assert.equal(h.logs[4].reason, 'MEDIA_UNAVAILABLE');
  assert.ok(!JSON.stringify(h.logs).includes(token));
});

test('a missing schema018 is reported and retried before any sync', async () => {
  const h = harness([{ state: 'idle' }], { schema: [false, false, true] });
  await runMenuSyncLoop({ ...h.options, mode: 'apply' });
  assert.deepEqual(h.logs.filter((entry) => entry.event === 'menu_sync_schema_missing').length, 2);
  assert.equal(h.calls.length, 1);
  const once = harness([], { schema: [false] });
  assert.deepEqual(await runMenuSyncLoop({ ...once.options, mode: 'apply', once: true }), {
    exitCode: 1,
  });
  assert.equal(once.calls.length, 0);
  const single = harness([new SyncError('UNAUTHORIZED')]);
  assert.deepEqual(await runMenuSyncLoop({ ...single.options, mode: 'apply', once: true }), {
    exitCode: 1,
  });
  assert.deepEqual(single.logs, [
    { event: 'menu_sync_failed', code: 'UNAUTHORIZED', failures: 1, retrying: false },
  ]);
});
