import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import {
  assertSyncRelationRights,
  reviewedSyncRights,
} from '../../infra/windows/native-pos-sync-db.mjs';
import { posSyncWorkerGrants } from '../../infra/windows/pos-sync-worker-grants.mjs';
import { posSalesWorkerGrants } from '../../infra/windows/pos-sales-grants.mjs';

// Cutover CR cloud-2 section 2 (integration): the POS sync worker role of the native installer
// (install-native-pos-sync.ps1 -> native-pos-sync-db.mjs prepare/verify) knows the exact posSales
// sender set of edge 026. Before 026 the reviewed set and the grants stay the pre-cutover ones;
// on 026 prepare grants and verify requires exactly WORKER_PRIVILEGES on top of them, the set
// pos-sales-upgrade-db.mjs grants to an existing worker role in window C4.

const connection =
  process.env.EDGE_FULFILLMENT_TEST_DATABASE_URL ??
  'postgresql://pickchick_local:pickchick_local_only@127.0.0.1:55433/pickchick_edge';
const checked = new URL(connection);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(checked.hostname), 'Local PostgreSQL only');
assert.match(checked.pathname, /^\/pickchick_(edge|test)$/);
const edgeDir = fileURLToPath(new URL('../../db/edge/migrations/', import.meta.url));

/** A migrated edge schema (migrations below `limit`, all when absent) and a NOLOGIN role. */
async function edgeSchema(run, limit) {
  const schema = 'cutover_sync_' + randomUUID().replaceAll('-', '');
  const role = 'cutover_sync_' + randomUUID().replaceAll('-', '').slice(0, 24);
  const admin = createPool(connection, 1);
  let pool, directory;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    const url = new URL(connection);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(url.toString(), 2);
    let source = edgeDir;
    if (limit) {
      directory = await mkdtemp(join(tmpdir(), 'pickchick-sync-edge-'));
      source = join(directory, 'migrations');
      await mkdir(source);
      for (const file of await readdir(edgeDir))
        if (/^\d{3}_[a-z_]+\.sql$/.test(file) && file < limit)
          await copyFile(join(edgeDir, file), join(source, file));
    }
    await migrate(pool, source, 'edge');
    await run({ pool, schema, role });
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

const check = (pool, role, schema, requireGranted, posSales) =>
  assertSyncRelationRights(pool, { role, schema, requireGranted, posSales });

test('reviewed rights: the pre-cutover set, plus exactly WORKER_PRIVILEGES with 026', () => {
  const before = reviewedSyncRights(false);
  assert.deepEqual(Object.keys(before).sort(), [
    'fulfillment_outbox',
    'outbox_events',
    'pos_kitchen_sync_state',
    'pos_order_sync_state',
  ]);
  for (const entry of Object.values(before)) {
    assert.equal(entry.insert, false);
    assert.ok(Array.isArray(entry.update) && entry.update.length > 0);
  }
  assert.deepEqual(before.outbox_events.update, ['attempts', 'acknowledged_at']);
  const after = reviewedSyncRights(true);
  assert.deepEqual(
    Object.fromEntries(Object.entries(after).filter(([name]) => !(name in before))),
    {
      pos_sale_outbox: { insert: false, update: ['acknowledged_at', 'attempts', 'last_error'] },
      pos_sale_sync_state: { insert: true, update: true },
    },
  );
  for (const name of Object.keys(before)) assert.deepEqual(after[name], before[name]);
  for (const value of [undefined, null, 'true', 1]) assert.throws(() => reviewedSyncRights(value));
});

test('edge 025: the pre-cutover worker grants are exact; no posSales relation exists', () =>
  edgeSchema(async ({ pool, schema, role }) => {
    await check(pool, role, schema, false, false);
    await assert.rejects(check(pool, role, schema, true, false), /privileges differ/);
    await pool.query(posSyncWorkerGrants(role, schema));
    await check(pool, role, schema, true, false);
    // The installer derives posSales from the 026 ledger row, never true on 025.
    await assert.rejects(check(pool, role, schema, true, true), /Sync migrations missing/);
    // Without the 026 flag the grant SQL is the pre-cutover SQL.
    assert.equal(
      posSyncWorkerGrants(role, schema, { posSales: false }),
      posSyncWorkerGrants(role, schema),
    );
  }, '026'));

test('edge 026+027: verify requires the posSales sender set, prepare grants it, extras refused', () =>
  edgeSchema(async ({ pool, schema, role }) => {
    // A worker role prepared before 026 (pre-cutover grants only): still within the reviewed set,
    // but verify on 026 needs the sender rights the C4 upgrade tool grants.
    await pool.query(posSyncWorkerGrants(role, schema));
    await check(pool, role, schema, false, true);
    await assert.rejects(check(pool, role, schema, true, true), /table privileges differ/);
    // pos-sales-upgrade-db.mjs apply grants WORKER_PRIVILEGES to the existing worker role.
    await pool.query(posSalesWorkerGrants(role, schema));
    await check(pool, role, schema, true, true);
    // The pre-cutover check refuses the 026 set: this is why the installer needs the 026 flag.
    await assert.rejects(check(pool, role, schema, false, false), /privileges differ/);
    // prepare on 026: one grant SQL gives the same exact set.
    const fresh = 'cutover_sync_' + randomUUID().replaceAll('-', '').slice(0, 24);
    await pool.query(`CREATE ROLE ${fresh} NOLOGIN NOINHERIT`);
    try {
      await pool.query(posSyncWorkerGrants(fresh, schema, { posSales: true }));
      await check(pool, fresh, schema, true, true);
    } finally {
      await pool.query(`DROP OWNED BY ${fresh}`);
      await pool.query(`DROP ROLE ${fresh}`);
    }
    // Anything beyond the reviewed set is refused, table or column, old or new relation.
    for (const [grant, error] of [
      [`GRANT INSERT ON pos_sale_outbox TO ${role}`, /table privileges differ/],
      [`GRANT UPDATE ON pos_sale_outbox TO ${role}`, /table privileges differ/],
      [`GRANT UPDATE(payload) ON pos_sale_outbox TO ${role}`, /column privileges differ/],
      [`GRANT INSERT(last_error) ON pos_sale_outbox TO ${role}`, /column privileges differ/],
      [`GRANT DELETE ON pos_sale_sync_state TO ${role}`, /table privileges differ/],
      [`GRANT REFERENCES(branch_id) ON pos_sale_sync_state TO ${role}`, /column privileges differ/],
      [`GRANT SELECT ON pos_sales TO ${role}`, /table privileges differ/],
      [`GRANT SELECT(version) ON kds_layouts TO ${role}`, /column privileges differ/],
      [`GRANT INSERT ON pos_order_sync_state TO ${role}`, /table privileges differ/],
    ]) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(grant);
        await assert.rejects(check(client, role, schema, true, true), error, grant);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      await check(pool, role, schema, true, true);
    }
  }));

test('installer: the 026 ledger row selects the posSales set for prepare and verify', async () => {
  const source = await readFile(
    new URL('../../infra/windows/native-pos-sync-db.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /const posSales = ledger\.some\(\(r\) => r\.version === POS_SALES_MIGRATION\);/,
  );
  assert.match(source, /posSyncWorkerGrants\(syncRole, 'public', \{ posSales \}\)/);
  assert.equal(source.match(/assertRights\(owner, (false|true), posSales\)/g).length, 3);
  const installer = await readFile(
    new URL('../../infra/windows/install-native-pos-sync.ps1', import.meta.url),
    'utf8',
  );
  // native-pos-sync-db.mjs imports pos-sync-worker-grants.mjs, which imports pos-sales-grants.mjs.
  assert.match(installer, /'infra\/windows\/pos-sales-grants\.mjs'/);
});
