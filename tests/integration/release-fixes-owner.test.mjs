import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSyncDatabases } from '../helpers/sync.mjs';
import {
  deployReleaseFixes,
  MIGRATIONS,
  OTP_FAILURE_PRIVILEGES,
} from '../../infra/staging/release-fixes-1019-owner.mjs';
import { runtimePrivileges } from '../../infra/staging/unified-menu-owner.mjs';
import { customerAuthGrants } from '../../infra/staging/customer-auth-grants.mjs';

const source = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));

/** Copies the reviewed cloud files accepted by `keep` into a fresh directory. */
async function copyMigrations(prefix, keep) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  for (const f of await readdir(source))
    if (f.endsWith('.sql') && keep(f)) await copyFile(join(source, f), join(dir, f));
  return dir;
}

async function withRole(c, run) {
  const role = 'fixes_owner_test_' + randomUUID().replaceAll('-', '');
  await c.cloud.admin.query(`CREATE ROLE ${role} NOLOGIN`);
  try {
    const client = await c.cloud.pool.connect();
    try {
      await run(client, role);
    } finally {
      client.release();
    }
  } finally {
    await c.cloud.pool.query(`DROP OWNED BY ${role}`);
    await c.cloud.admin.query(`DROP ROLE ${role}`);
  }
}

test('owner migration applies exactly 064/066/068 on schema060, keeps data and ACL, rejects replay', async () => {
  const baseline = await copyMigrations('fixes-baseline060-', (f) => +f.slice(0, 3) <= 60);
  const candidate = await copyMigrations('fixes-candidate068-', (f) => +f.slice(0, 3) <= 68);
  const future = await copyMigrations('fixes-future-', () => true);
  await writeFile(join(future, '069_cloud_future.sql'), 'SELECT 1;');
  try {
    await withSyncDatabases(
      (c) =>
        withRole(c, async (client, role) => {
          await c.cloud.pool.query(`GRANT SELECT ON identity_customers TO ${role}`);
          await c.cloud.pool.query(
            "INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids) VALUES($1,$2,1,'{}') ON CONFLICT DO NOTHING",
            [c.branch, c.device],
          );
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await assert.rejects(
            deployReleaseFixes(client, { directory: future, role, inspect: true }),
            /Exact schema060 baseline and 064\/066\/068 candidate required/,
          );
          await assert.rejects(
            deployReleaseFixes(client, { directory: baseline, role, inspect: true }),
            /Exact schema060 baseline/,
          );
          assert.deepEqual(
            await deployReleaseFixes(client, { directory: candidate, role, inspect: true }),
            {
              pending: MIGRATIONS,
              privilegesAdded: OTP_FAILURE_PRIVILEGES,
              edgeIdentityRotationEnabled: false,
            },
          );
          const result = await deployReleaseFixes(client, { directory: candidate, role });
          assert.deepEqual(result.applied, MIGRATIONS);
          assert.equal(result.existingDataPreserved, true);
          assert.deepEqual(result.privilegesAdded, OTP_FAILURE_PRIVILEGES);
          await client.query('COMMIT');
          const closed = await c.cloud.pool.query(
            'SELECT ordering_closed FROM cloud_branch_availability WHERE branch_id=$1',
            [c.branch],
          );
          assert.equal(closed.rows[0].ordering_closed, false);
          // What provision.mjs grants later must not differ from what the owner step granted.
          const granted = await runtimePrivileges(c.cloud.pool, role);
          assert.ok(OTP_FAILURE_PRIVILEGES.every((p) => granted.includes(p)));
          assert.ok(!granted.some((p) => p.startsWith('device_identity_rotations|')));
          await client.query('BEGIN');
          await assert.rejects(
            deployReleaseFixes(client, { directory: candidate, role }),
            /Exact schema060 ledger required/,
          );
          await client.query('ROLLBACK');
          await c.cloud.pool.query(customerAuthGrants(role, true));
          const provisioned = (await runtimePrivileges(c.cloud.pool, role)).filter((p) =>
            p.startsWith('identity_otp_failures|'),
          );
          assert.deepEqual(provisioned, OTP_FAILURE_PRIVILEGES);
        }),
      { cloudMigrationDirectory: baseline },
    );
  } finally {
    for (const d of [baseline, candidate, future]) await rm(d, { recursive: true, force: true });
  }
});

test('owner migration refuses a ledger without 060 and grants nothing while customer login is off', async () => {
  const before060 = await copyMigrations('fixes-before060-', (f) => +f.slice(0, 3) <= 58);
  const baseline = await copyMigrations('fixes-baseline060-', (f) => +f.slice(0, 3) <= 60);
  const candidate = await copyMigrations('fixes-candidate068-', (f) => +f.slice(0, 3) <= 68);
  try {
    await withSyncDatabases(
      (c) =>
        withRole(c, async (client, role) => {
          await client.query('BEGIN');
          await assert.rejects(
            deployReleaseFixes(client, { directory: candidate, role, inspect: true }),
            /Exact schema060 ledger required/,
          );
          await client.query('ROLLBACK');
        }),
      { cloudMigrationDirectory: before060 },
    );
    await withSyncDatabases(
      (c) =>
        withRole(c, async (client, role) => {
          const acl = await runtimePrivileges(c.cloud.pool, role);
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          const result = await deployReleaseFixes(client, { directory: candidate, role });
          assert.deepEqual(result.privilegesAdded, []);
          await client.query('ROLLBACK');
          assert.deepEqual(await runtimePrivileges(c.cloud.pool, role), acl);
          const ledger = await c.cloud.pool.query(
            'SELECT count(*)::int AS n FROM schema_migrations WHERE version = ANY($1)',
            [MIGRATIONS],
          );
          assert.equal(ledger.rows[0].n, 0, 'rolled back transaction leaves the ledger untouched');
        }),
      { cloudMigrationDirectory: baseline },
    );
  } finally {
    for (const d of [before060, baseline, candidate]) await rm(d, { recursive: true, force: true });
  }
});
