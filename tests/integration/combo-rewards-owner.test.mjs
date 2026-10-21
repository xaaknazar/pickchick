import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { deployComboRewards, MIGRATION, TABLES } from '../../infra/staging/combo-rewards-owner.mjs';
import { deployReleaseFixes } from '../../infra/staging/release-fixes-1019-owner.mjs';
import { runtimePrivileges } from '../../infra/staging/unified-menu-owner.mjs';
const source = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));
async function migrations(prefix, max) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  for (const n of await readdir(source))
    if (n.endsWith('.sql') && +n.slice(0, 3) <= max) await copyFile(join(source, n), join(path, n));
  return path;
}
async function fixture(run) {
  const baseline = await migrations('combo058-', 58),
    candidate = await migrations('combo068-', 68);
  try {
    await withSyncDatabases(
      async (c) => {
        const role = 'combo_owner_' + randomUUID().replaceAll('-', '');
        await c.cloud.admin.query(`CREATE ROLE ${role} NOLOGIN`);
        const client = await c.cloud.pool.connect();
        try {
          await c.cloud.pool.query(`GRANT SELECT ON identity_customers TO ${role}`);
          await run(c, client, { directory: candidate, role });
        } finally {
          await client.query('ROLLBACK').catch(() => {});
          client.release();
          await c.cloud.pool.query(`DROP OWNED BY ${role}`);
          await c.cloud.admin.query(`DROP ROLE ${role}`);
        }
      },
      { cloudMigrationDirectory: baseline },
    );
  } finally {
    await rm(baseline, { recursive: true, force: true });
    await rm(candidate, { recursive: true, force: true });
  }
}
test('schema-only 058 -> 060 -> 068 preserves existing rows/ACL, stays dormant and rejects replay', async () =>
  fixture(async (c, client, opts) => {
    const ledgerBefore = (await client.query('SELECT * FROM schema_migrations ORDER BY version'))
      .rows;
    const acl = await runtimePrivileges(client, opts.role);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.deepEqual(await deployComboRewards(client, { ...opts, inspect: true }), {
      pending: [MIGRATION],
      privilegesAdded: [],
      rewardsEnabled: false,
    });
    await client.query('ROLLBACK');
    assert.deepEqual(
      (await client.query('SELECT * FROM schema_migrations ORDER BY version')).rows,
      ledgerBefore,
    );
    for (const commit of [false, true]) {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const result = await deployComboRewards(client, opts);
      assert.equal(result.existingDataPreserved, true);
      assert.equal(result.rewardsEnabled, false);
      assert.deepEqual(await runtimePrivileges(client, opts.role), acl);
      for (const table of TABLES)
        assert.equal((await client.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
      assert.equal(
        (await client.query('SELECT name FROM organizations WHERE id=$1', [c.org])).rows[0].name,
        'Sync synthetic',
      );
      const fixes = await deployReleaseFixes(client, opts);
      assert.equal(fixes.edgeIdentityRotationEnabled, false);
      assert.equal(fixes.privilegesAdded.length, 4);
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      assert.ok(
        (await client.query('SELECT max(version) v FROM schema_migrations')).rows[0].v.startsWith(
          commit ? '068_' : '058_',
        ),
      );
      if (!commit) assert.deepEqual(await runtimePrivileges(client, opts.role), acl);
    }
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await assert.rejects(deployComboRewards(client, opts), /Exact schema058 ledger/);
    await client.query('ROLLBACK');
  }));
test('owner refuses unreviewed SQL, incorrect baseline/constraints, flag activation and unexpected grants', async () =>
  fixture(async (c, client, opts) => {
    await assert.rejects(deployComboRewards(client, opts), /Repeatable-read/);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await assert.rejects(deployComboRewards(client, { ...opts, enabled: true }), /remain disabled/);
    await assert.rejects(
      deployComboRewards(client, { ...opts, role: 'bad;role' }),
      /Invalid runtime role/,
    );
    await client.query(
      "UPDATE schema_migrations SET checksum=repeat('0',64) WHERE version='058_cloud_device_center.sql'",
    );
    await assert.rejects(deployComboRewards(client, opts), /Exact schema058 ledger/);
    await client.query('ROLLBACK');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query(
      'ALTER TABLE commerce_orders DROP CONSTRAINT commerce_orders_total_minor_check',
    );
    await assert.rejects(deployComboRewards(client, opts), /positive-total constraints/);
    await client.query('ROLLBACK');
    const bad = await migrations('combo-bad-', 68);
    try {
      await writeFile(join(bad, MIGRATION), 'SELECT 1;');
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await assert.rejects(deployComboRewards(client, { ...opts, directory: bad }), /checksum/);
      await writeFile(join(bad, '069_cloud_future.sql'), 'SELECT 1;');
      await assert.rejects(
        deployComboRewards(client, { ...opts, directory: bad }),
        /Exact reviewed/,
      );
      await client.query('ROLLBACK');
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${c.cloud.schema} GRANT SELECT ON TABLES TO ${opts.role}`,
    );
    await assert.rejects(deployComboRewards(client, opts), /Runtime privileges changed/);
    await client.query('ROLLBACK');
    assert.equal(
      (
        await client.query('SELECT count(*)::int n FROM schema_migrations WHERE version=$1', [
          MIGRATION,
        ])
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await client.query('SELECT to_regclass($1) name', [
          c.cloud.schema + '.combo_reward_programs',
        ])
      ).rows[0].name,
      null,
    );
  }));
