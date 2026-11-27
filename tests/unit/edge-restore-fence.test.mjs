import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';
import test from 'node:test';
import { edgeRuntimeGrantSql } from '../../infra/windows/edge-runtime-grants.mjs';
import { fulfillmentWorkerGrants } from '../../infra/windows/fulfillment-worker-grants.mjs';
import { menuSyncWorkerGrants } from '../../infra/windows/menu-sync-worker-grants.mjs';

const migration = readFileSync(
  new URL('../../db/edge/migrations/023_edge_restore_fence.sql', import.meta.url),
  'utf8',
);

test('restore fence grants are opt-in and give only EXECUTE on the owner-rights function (6.4)', () => {
  assert.throws(() => edgeRuntimeGrantSql('edge_runtime', { restoreFence: 'true' }));
  assert.throws(() => fulfillmentWorkerGrants('worker', 'public', { restoreFence: 1 }));
  for (const sql of [
    edgeRuntimeGrantSql('edge_runtime'),
    fulfillmentWorkerGrants('worker'),
    menuSyncWorkerGrants(),
  ])
    assert.doesNotMatch(sql, /edge_restore_fence|edge_database_epochs/);
  assert.match(
    edgeRuntimeGrantSql('edge_runtime', { restoreFence: true }),
    /GRANT EXECUTE ON FUNCTION "public"\.edge_restore_fence\(boolean\) TO "edge_runtime";/,
  );
  const worker = fulfillmentWorkerGrants('worker', 'public', { restoreFence: true });
  assert.match(
    worker,
    /GRANT EXECUTE ON FUNCTION "public"\.edge_restore_fence\(boolean\) TO "worker";/,
  );
  // Nobody gets the sequences or the ledger itself.
  for (const sql of [worker, edgeRuntimeGrantSql('edge_runtime', { restoreFence: true })])
    assert.doesNotMatch(
      sql,
      /ON SEQUENCE[^;]*(cashier_report|fulfillment_outbox)_sequence_seq[^;]*UPDATE|edge_database_epochs/,
    );
});

test('schema023 is additive, append-only, owner-rights with a pinned search_path, not PUBLIC (6.4)', () => {
  assert.doesNotMatch(migration, /\bDROP\b|\bTRUNCATE\b|ALTER COLUMN|RENAME/i);
  assert.match(migration, /LANGUAGE plpgsql SECURITY DEFINER AS/);
  // Same pinning as the cloud owner-rights functions: own schema, pg_temp searched last.
  assert.match(
    migration,
    /ALTER FUNCTION %I\.edge_restore_fence\(boolean\) SET search_path = pg_catalog, %I, pg_temp/,
  );
  assert.doesNotMatch(migration, /search_path FROM CURRENT|current_schema\(\)\s*,\s*0\)/);
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION edge_restore_fence\(boolean\) FROM PUBLIC;/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON edge_database_epochs/);
  assert.match(migration, /gap constant bigint := 1000000000;/);
  // The heartbeat revision moves with the producer sequences, or availability stays stale.
  assert.match(migration, /UPDATE fulfillment_transport_state SET attempts = attempts \+ gap;/);
  assert.match(migration, /ADD COLUMN restore_resync_from bigint;/);
});

test('the edge retries the restore fence until PostgreSQL answers, but not a missing grant (6.4)', async (t) => {
  const { RestoreFenceGuard, RestoreFenceOnStart, RESTORE_FENCE_RETRY_MS } =
    await import('../../services/edge/dist/restore-fence.js');
  // The guard of every edge route, asked the way Nest asks it.
  const admits = (fence, method) => {
    try {
      return new RestoreFenceGuard(fence).canActivate({
        switchToHttp: () => ({ getRequest: () => ({ method }) }),
      });
    } catch (error) {
      assert.equal(error.getStatus(), 503);
      return false;
    }
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const logs = [];
  for (const level of ['log', 'warn', 'error'])
    t.mock.method(console, level, (line) => logs.push(JSON.parse(line)));
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const fake = (failure) => {
    const db = { failure, fenced: 0 };
    db.pool = {
      query: async (sql) => {
        if (db.failure) throw Object.assign(new Error('synthetic'), { code: db.failure });
        if (/to_regprocedure/.test(sql)) return { rows: [{ ok: true }] };
        db.fenced++;
        return { rows: [{ state: 'restore', epoch: 2, sequence_gap: '1000000000' }] };
      },
    };
    return db;
  };

  // A reboot right after a restore: PostgreSQL is not up when the edge starts.
  const starting = fake('ECONNREFUSED');
  const fence = new RestoreFenceOnStart({ pool: starting.pool });
  assert.equal(fence.pending, true);
  await fence.onApplicationBootstrap();
  t.mock.timers.tick(RESTORE_FENCE_RETRY_MS);
  await flush();
  assert.equal(starting.fenced, 0);
  // Until the fence has run the edge serves reads and health but refuses every write.
  assert.equal(fence.pending, true);
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) assert.equal(admits(fence, method), true);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', undefined])
    assert.equal(admits(fence, method), false, `${method} before the fence`);
  starting.failure = null;
  t.mock.timers.tick(RESTORE_FENCE_RETRY_MS);
  await flush();
  assert.equal(starting.fenced, 1, 'the fence runs as soon as the database answers');
  assert.equal(fence.pending, false);
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
    assert.equal(admits(fence, method), true);
  t.mock.timers.tick(RESTORE_FENCE_RETRY_MS * 3);
  await flush();
  assert.equal(starting.fenced, 1, 'and only once');
  await fence.onModuleDestroy();
  assert.deepEqual(
    logs.map((l) => l.reason ?? l.state),
    ['RETRYING', 'restore'],
    'one line per state change, no spam while retrying',
  );

  // No EXECUTE grant: a release setup problem, logged once and never retried.
  logs.length = 0;
  const denied = fake('42501');
  let queries = 0;
  const counted = { query: (sql) => (queries++, denied.pool.query(sql)) };
  const ungranted = new RestoreFenceOnStart({ pool: counted });
  await ungranted.onApplicationBootstrap();
  t.mock.timers.tick(RESTORE_FENCE_RETRY_MS * 3);
  await flush();
  assert.equal(queries, 1);
  assert.deepEqual(logs, [{ event: 'edge_restore_fence_unavailable', reason: 'NOT_GRANTED' }]);
  // A runtime without the grant keeps serving with the previous behaviour.
  assert.equal(ungranted.pending, false);
  assert.equal(admits(ungranted, 'POST'), true);
  await ungranted.onModuleDestroy();
});

test('only a database that does not answer refuses writes; any other fence failure is logged and serves (6.4)', async (t) => {
  const {
    RestoreFenceOnStart,
    RESTORE_FENCE_REMINDER_MS,
    RESTORE_FENCE_RETRY_MS,
    restoreFenceFailure,
  } = await import('../../services/edge/dist/restore-fence.js');
  const coded = (code, message = 'postgresql://user:secret@127.0.0.1/db') =>
    Object.assign(new Error(message), code === undefined ? {} : { code });
  for (const code of [
    '08006',
    '08P01',
    '57P01',
    '57P03',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ECONNRESET',
  ])
    assert.deepEqual(restoreFenceFailure(coded(code)), { code, connection: true });
  // node-postgres: a dropped connection and a pool connect timeout carry no code.
  for (const message of [
    'Connection terminated unexpectedly',
    'timeout exceeded when trying to connect',
  ])
    assert.deepEqual(restoreFenceFailure(new Error(message)), {
      code: 'CONNECTION',
      connection: true,
    });
  assert.deepEqual(
    restoreFenceFailure(Object.assign(new Error('wrapped'), { cause: coded('ECONNREFUSED') })),
    { code: 'ECONNREFUSED', connection: true },
  );
  for (const [error, code] of [
    [coded('P0001'), 'P0001'],
    [coded('42883'), '42883'],
    [coded('55P03'), '55P03'],
    [new Error('Edge restore fence returned no state'), 'Error'],
    [new TypeError('postgresql://user:secret@127.0.0.1/db'), 'TypeError'],
    [coded('postgresql://user:secret@127.0.0.1/db'), 'Error'],
    [null, 'UNKNOWN'],
    ['text', 'UNKNOWN'],
  ])
    assert.deepEqual(restoreFenceFailure(error), { code, connection: false });

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const logs = [];
  for (const level of ['log', 'warn', 'error'])
    t.mock.method(console, level, (line) => logs.push({ level, ...JSON.parse(line) }));
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const step = async (ms = RESTORE_FENCE_RETRY_MS) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  const fake = (failure) => {
    const db = { failure, queries: 0, fenced: 0 };
    db.pool = {
      query: async (sql) => {
        db.queries++;
        if (db.failure) throw db.failure;
        if (/to_regprocedure/.test(sql)) return { rows: [{ ok: true }] };
        db.fenced++;
        return { rows: [{ state: 'current', epoch: 1, sequence_gap: '0' }] };
      },
    };
    return db;
  };

  // The function itself raises on every start while PostgreSQL is fine: the till keeps selling.
  const raising = fake(coded('P0001'));
  const broken = new RestoreFenceOnStart({ pool: raising.pool });
  await broken.onApplicationBootstrap();
  assert.equal(broken.pending, false, 'writes are admitted');
  for (let i = 0; i < 70; i++) await step();
  assert.equal(raising.queries, 71, 'the check is still repeated');
  assert.equal(broken.pending, false);
  assert.deepEqual(logs, [
    {
      level: 'error',
      event: 'edge_restore_fence_unavailable',
      reason: 'FAILED',
      code: 'P0001',
      writes: 'accepted',
    },
  ]);
  // Writes that were admitted are not refused later, whatever the next failure is.
  raising.failure = coded('ECONNREFUSED');
  await step();
  assert.equal(broken.pending, false);
  assert.deepEqual(logs.at(-1), {
    level: 'warn',
    event: 'edge_restore_fence_unavailable',
    reason: 'RETRYING',
    code: 'ECONNREFUSED',
    writes: 'accepted',
  });
  raising.failure = null;
  await step();
  assert.equal(raising.fenced, 1);
  assert.deepEqual(logs.at(-1), {
    level: 'log',
    event: 'edge_restore_fence_checked',
    state: 'current',
  });
  await broken.onModuleDestroy();
  assert.ok(!JSON.stringify(logs).includes('secret'));

  // PostgreSQL does not answer: writes are refused, said at once and again every 5 minutes.
  logs.length = 0;
  const down = fake(coded('57P03'));
  const waiting = new RestoreFenceOnStart({ pool: down.pool });
  await waiting.onApplicationBootstrap();
  assert.equal(waiting.pending, true);
  const refused = {
    level: 'warn',
    event: 'edge_restore_fence_unavailable',
    reason: 'RETRYING',
    code: '57P03',
    writes: 'refused',
  };
  assert.deepEqual(logs, [refused]);
  const ticks = RESTORE_FENCE_REMINDER_MS / RESTORE_FENCE_RETRY_MS;
  for (let i = 0; i < ticks - 1; i++) await step();
  assert.deepEqual(logs, [refused], 'no line per retry');
  await step();
  assert.deepEqual(logs, [refused, refused], 'the reminder after 5 minutes');
  // A different reason is said at once.
  down.failure = coded('ECONNREFUSED');
  await step();
  assert.deepEqual(logs.at(-1), { ...refused, code: 'ECONNREFUSED' });
  assert.equal(waiting.pending, true);
  down.failure = null;
  await step();
  assert.equal(waiting.pending, false, 'open as soon as the check has run');
  assert.equal(down.fenced, 1);
  await waiting.onModuleDestroy();
});

test('the edge application installs the restore fence guard on its routes (6.4)', async (t) => {
  const { randomUUID } = await import('node:crypto');
  const { loadConfig } = await import('../../packages/platform/dist/index.js');
  const { createEdge } = await import('../../services/edge/dist/index.js');
  for (const level of ['log', 'warn', 'error']) t.mock.method(console, level, () => {});
  // No database is used: nothing listens on port 1, so the fence stays pending.
  const app = await createEdge(
    loadConfig('edge', {
      APP_ENV: 'local',
      EDGE_BRANCH_ID: randomUUID(),
      EDGE_DEVICE_ID: randomUUID(),
      EDGE_DATABASE_URL: 'postgresql://user:password@127.0.0.1:1/pickchick_edge',
    }),
  );
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const health = await fetch(`${base}/health/live`);
    assert.equal(health.status, 200);
    await health.body?.cancel();
    for (const path of ['/edge/v1/orders', '/edge/v1/staff/login', '/edge/v1/pos/sales']) {
      const response = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 503, path);
      assert.equal((await response.json()).code, 'SERVICE_UNAVAILABLE');
    }
  } finally {
    await app.close();
  }
});
