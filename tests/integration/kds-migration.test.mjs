// Cutover lane kds, KDS-3: edge migration 027 is additive, independent of 026 and applies on an
// installed 025 (with or without 026) without changing any existing row or privilege.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { transaction } from '@pickchick/database';
import { provisionFulfillment, provisionKdsStations } from '@pickchick/edge-fulfillment';
import { KDS_TABLES, MIGRATION } from '../../infra/windows/kds-grants.mjs';
import {
  KDS_MIGRATION,
  edgeMigrationNames,
  repoMigrations,
  seedEdge,
  tableFingerprint,
  withEdgeSchema,
} from '../../packages/edge-fulfillment/tests/kds-fixture.mjs';

const exists = async (pool, name) =>
  (await pool.query('SELECT to_regclass($1) IS NOT NULL AS present', [name])).rows[0].present;
const ledger = async (pool) =>
  (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(
    (row) => row.version,
  );
const withoutKds = (fingerprint) =>
  Object.fromEntries(
    Object.entries(fingerprint)
      .filter(([name]) => !KDS_TABLES.includes(name) && name !== 'schema_migrations')
      .map(([name, value]) =>
        name === 'acl'
          ? [name, value.filter((r) => !KDS_TABLES.includes(r.relname))]
          : [name, value],
      ),
  );

test('027 is the reviewed, additive, 026-independent file of the contract', async () => {
  const names = await edgeMigrationNames();
  assert.equal(MIGRATION, KDS_MIGRATION);
  assert.ok(names.includes(KDS_MIGRATION));
  assert.match(KDS_MIGRATION, /^\d{3}_[a-z_]+\.sql$/);
  // The installed chain this upgrade follows: 001..025 (026 belongs to the pos lane).
  assert.equal(names.filter((n) => n < '026').length, 25);
  assert.equal(names.filter((n) => n < '026').at(-1), '025_edge_kitchen_restore_review.sql');
  const sql = (await readFile(join(repoMigrations, KDS_MIGRATION), 'utf8')).replace(/--.*$/gm, '');
  // Nothing of the pos lane's 026 (contracts section 3.3) is referenced.
  for (const object of [
    'pos_payment_methods',
    'pos_sales',
    'pos_sale_',
    'pos_refund',
    'pos_fiscal_receipts',
    'local_manager_approvals',
    'pos_shift_cash',
    'sales_mode',
    'pos_service_mode',
  ])
    assert.doesNotMatch(sql, new RegExp(object), object);
  // Additive only: no destructive statement, no change of an existing table or function.
  assert.doesNotMatch(
    sql,
    /\b(DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+OR\s+REPLACE)\b/i,
  );
  assert.deepEqual(
    [...sql.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]).sort(),
    [...KDS_TABLES].sort(),
  );
});

for (const with026 of [false, true])
  test(`installed 025${with026 ? ' + 026' : ''} upgrades to 027 with every existing row and ACL unchanged`, () =>
    withEdgeSchema(async ({ pool, schema, migrateWith }) => {
      const installed = await migrateWith({ below: '026', with026 });
      assert.equal(installed.applied.length, with026 ? 26 : 25);
      assert.equal(await exists(pool, 'kds_settings'), false);
      const seeded = await seedEdge(pool, { provisionFulfillment });
      // Without 027 the new runtime's provisioning refuses (schema not ready) and changes nothing.
      const before = await tableFingerprint(pool, schema);
      await assert.rejects(
        transaction(pool, (client) => provisionKdsStations(client, seeded.scope.branchId)),
        (error) => error.code === 'NOT_READY',
      );
      assert.deepEqual(await tableFingerprint(pool, schema), before);

      const upgrade = await migrateWith({ below: '026', with026, with027: true });
      assert.deepEqual(upgrade.applied, [KDS_MIGRATION]);
      const names = await ledger(pool);
      assert.equal(names.at(-1), KDS_MIGRATION);
      assert.equal(names.length, with026 ? 27 : 26);
      for (const table of KDS_TABLES) assert.equal(await exists(pool, table), true, table);
      const after = await tableFingerprint(pool, schema);
      assert.deepEqual(withoutKds(after), withoutKds(before));
      for (const table of KDS_TABLES) assert.equal(after[table].count, 0, table);
      // No grant on the new tables comes with the migration; kds-grants.mjs adds them.
      assert.deepEqual(
        after.acl.filter((row) => KDS_TABLES.includes(row.relname)).map((row) => row.relacl),
        KDS_TABLES.map(() => null),
      );
      // Re-running the same chain is a no-op.
      assert.deepEqual((await migrateWith({ below: '026', with026, with027: true })).applied, []);
      // Data step after the schema: stations, grants and the switched-off settings row.
      const result = await transaction(pool, (client) =>
        provisionKdsStations(client, seeded.scope.branchId),
      );
      assert.deepEqual(
        [result.stationsAdded, result.grantsAdded, result.kitchenStaffId, result.settingsCreated],
        [6, 6, seeded.kitchen, true],
      );
      assert.equal(
        (await pool.query('SELECT layout_enabled FROM kds_settings')).rows[0].layout_enabled,
        false,
      );
    }));

test('provisioning needs the local fulfillment configuration first', () =>
  withEdgeSchema(async ({ pool, migrateWith }) => {
    await migrateWith({ below: '026', with027: true });
    const branchId = '10000000-0000-4000-8000-000000000003';
    await pool.query(
      "INSERT INTO branch_config(id,code,name,timezone) VALUES($1,'KDS','Synthetic','Asia/Almaty')",
      [branchId],
    );
    await assert.rejects(
      transaction(pool, (client) => provisionKdsStations(client, branchId)),
      (error) => error.code === 'NOT_READY',
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM fulfillment_stations')).rows[0].n,
      0,
    );
  }));
