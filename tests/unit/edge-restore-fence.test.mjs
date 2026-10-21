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
  const { RestoreFenceOnStart, RESTORE_FENCE_RETRY_MS } =
    await import('../../services/edge/dist/restore-fence.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const logs = [];
  for (const level of ['log', 'warn'])
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
  await fence.onApplicationBootstrap();
  t.mock.timers.tick(RESTORE_FENCE_RETRY_MS);
  await flush();
  assert.equal(starting.fenced, 0);
  starting.failure = null;
  t.mock.timers.tick(RESTORE_FENCE_RETRY_MS);
  await flush();
  assert.equal(starting.fenced, 1, 'the fence runs as soon as the database answers');
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
  await ungranted.onModuleDestroy();
});
