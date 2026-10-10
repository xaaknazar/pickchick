import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSyncDatabases } from '../helpers/sync.mjs';
import {
  deployWorkforce,
  WORKFORCE_TABLES,
  DEVICE_TABLES,
  MIGRATIONS,
} from '../../infra/staging/workforce-owner.mjs';
const directory = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));
test('workforce owner migrates only additive051/052, preserves rows/ACL and leaves device tables inaccessible', async () => {
  const old = await mkdtemp(join(tmpdir(), 'workforce050-'));
  try {
    for (const n of await readdir(directory))
      if (n.endsWith('.sql') && n < '051') await copyFile(join(directory, n), join(old, n));
    await withSyncDatabases(
      async ({ cloud }) => {
        const role = 'wf_' + randomUUID().replaceAll('-', '');
        await cloud.pool.query(
          `CREATE ROLE ${role} NOLOGIN; GRANT USAGE ON SCHEMA ${cloud.schema} TO ${role};GRANT SELECT ON branches TO ${role}`,
        );
        const c = await cloud.pool.connect();
        try {
          await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          const plan = await deployWorkforce(c, { directory, role, inspect: true });
          assert.deepEqual(plan.pending, MIGRATIONS);
          await c.query('ROLLBACK');
          await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          const result = await deployWorkforce(c, { directory, role });
          assert.equal(result.existingDataPreserved, true);
          assert.deepEqual(result.applied, MIGRATIONS);
          await c.query('COMMIT');
          for (const t of DEVICE_TABLES) {
            const { rows } = await c.query(
              "SELECT has_table_privilege($1,$2,'INSERT') AS allowed",
              [role, t],
            );
            assert.equal(rows[0].allowed, WORKFORCE_TABLES.includes(t));
          }
          await c.query('BEGIN');
          await assert.rejects(deployWorkforce(c, { directory, role }), /ledger/);
          await c.query('ROLLBACK');
        } finally {
          await c.query('ROLLBACK');
          c.release();
          await cloud.pool.query(`DROP OWNED BY ${role};DROP ROLE ${role}`);
        }
      },
      { cloudMigrationDirectory: old },
    );
  } finally {
    await rm(old, { recursive: true, force: true });
  }
});
