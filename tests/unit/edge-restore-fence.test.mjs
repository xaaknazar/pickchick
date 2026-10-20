import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.match(migration, /SECURITY DEFINER SET search_path FROM CURRENT/);
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION edge_restore_fence\(boolean\) FROM PUBLIC;/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON edge_database_epochs/);
  assert.match(migration, /gap constant bigint := 1000000000;/);
  assert.match(migration, /ADD COLUMN restore_resync_from bigint;/);
});
