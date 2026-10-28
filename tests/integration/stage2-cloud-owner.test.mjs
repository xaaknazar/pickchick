// Stage 2 integration: guarded owner step for cloud 070 (station plans) and 071 (daily
// reconciliation) on the VPS ledger, which has no 069 (push) yet, plus the per-flag grants.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, copyFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '@pickchick/database';
import { withSyncDatabases } from '../helpers/sync.mjs';
import {
  CHECKSUMS,
  MIGRATIONS,
  PUSH_MIGRATION,
  STATION_PLAN_READ,
  STATION_PLAN_WRITE,
  deployStage2,
  parseArguments,
  reconciliationPrivileges,
  setStage2Flag,
} from '../../infra/staging/stage2-cloud-owner.mjs';
import { OwnerGuardError, runtimePrivileges } from '../../infra/staging/unified-menu-owner.mjs';
import { backofficeGrants } from '../../infra/staging/backoffice-grants.mjs';
import { stationPlanGrants } from '../../infra/staging/station-plan-grants.mjs';
import { reconciliationGrants } from '../../infra/staging/reconciliation-grants.mjs';

const source = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));
const FLAGS_OFF = { stationPlanDelivery: false, reconciliation: false, push: false };

/** Copies the reviewed cloud files accepted by `keep` into a fresh directory. */
async function copyMigrations(prefix, keep) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  for (const f of await readdir(source))
    if (f.endsWith('.sql') && keep(f)) await copyFile(join(source, f), join(dir, f));
  return dir;
}

async function withRole(c, run) {
  const role = 'stage2_owner_test_' + randomUUID().replaceAll('-', '');
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

const stage2Privilege = (p) =>
  /^(bo_station_plan|bo_rec_|customer_notification|customer_push)/.test(p) ||
  p.startsWith('commerce_kaspi_invoices|attempt_id|') ||
  p.startsWith('commerce_kaspi_invoices|reference|') ||
  p.startsWith('commerce_kaspi_invoices|operation_id|') ||
  /^commerce_tiptoppay_test_payments\|[a-z_]+\|/.test(p);
const ledgerVersions = async (pool) =>
  (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(
    (r) => r.version,
  );

test('the owner step pins the reviewed 069/070/071 bytes and parses only its commands', async () => {
  for (const [name, checksum] of Object.entries(CHECKSUMS))
    assert.equal(
      (await import('node:crypto'))
        .createHash('sha256')
        .update(await readFile(join(source, name)))
        .digest('hex'),
      checksum,
      name,
    );
  assert.deepEqual(parseArguments(['inspect']), { command: 'inspect', with069: false });
  assert.deepEqual(parseArguments(['deploy', '--with-069']), { command: 'deploy', with069: true });
  assert.deepEqual(parseArguments(['flag', 'reconciliation', 'true']), {
    command: 'flag',
    flag: 'reconciliation',
    enabled: true,
  });
  for (const argv of [
    [],
    ['deploy', '--with-069', '--with-069'],
    ['deploy', '--force'],
    ['flag', 'push', 'true'],
    ['flag', 'reconciliation', 'yes'],
    ['flag', 'reconciliation'],
    ['provision'],
  ])
    assert.throws(() => parseArguments(argv), OwnerGuardError, JSON.stringify(argv));
  // The command line refuses the runtime role and any other database before connecting.
  const script = fileURLToPath(
    new URL('../../infra/staging/stage2-cloud-owner.mjs', import.meta.url),
  );
  for (const url of [
    'postgresql://pickchick_app:x@127.0.0.1:1/pickchick_cloud',
    'postgresql://pickchick_owner:x@127.0.0.1:1/other',
  ])
    await assert.rejects(
      promisify(execFile)(process.execPath, [script, 'deploy'], {
        env: { PATH: process.env.PATH, CLOUD_DATABASE_URL: url },
      }),
      (error) => error.code === 1 && error.stderr.includes('Owner database required'),
    );
});

test('on exact schema069 the owner step applies 070/071 with flags off, keeps data and ACL, rejects replay; flag grants are exact', async () => {
  const baseline = await copyMigrations('stage2-baseline069-', (f) => +f.slice(0, 3) <= 69);
  const candidate = await copyMigrations('stage2-candidate-', (f) => +f.slice(0, 3) <= 71);
  const future = await copyMigrations('stage2-future-', (f) => +f.slice(0, 3) <= 71);
  await writeFile(join(future, '072_cloud_future.sql'), 'SELECT 1;');
  const tampered = await copyMigrations('stage2-tampered-', (f) => +f.slice(0, 3) <= 71);
  await writeFile(
    join(tampered, MIGRATIONS[1]),
    (await readFile(join(source, MIGRATIONS[1]), 'utf8')) + '\n-- changed\n',
  );
  try {
    await withSyncDatabases(
      (c) =>
        withRole(c, async (client, role) => {
          await c.cloud.pool.query(backofficeGrants(role, true));
          await c.cloud.pool.query(
            "INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids) VALUES($1,$2,1,'{}') ON CONFLICT DO NOTHING",
            [c.branch, c.device],
          );
          const acl = await runtimePrivileges(c.cloud.pool, role);
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await assert.rejects(
            deployStage2(client, { directory: future, role, inspect: true }),
            /Exact schema068 baseline with 069 and the 070\/071 candidate required/,
          );
          await assert.rejects(
            deployStage2(client, { directory: tampered, role, inspect: true }),
            /Reviewed migration bytes differ: 071_cloud_daily_reconciliation.sql/,
          );
          assert.deepEqual(
            await deployStage2(client, { directory: candidate, role, inspect: true }),
            {
              ledger: 'schema069',
              requires069: false,
              pending: MIGRATIONS,
              backofficeGrants: true,
              privilegesAdded: STATION_PLAN_READ,
              flags: FLAGS_OFF,
            },
          );
          await assert.rejects(
            deployStage2(client, { directory: candidate, role, with069: true }),
            /Cloud 069 is already applied/,
          );
          await client.query('ROLLBACK');
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          assert.deepEqual(await deployStage2(client, { directory: candidate, role }), {
            applied: MIGRATIONS,
            existingDataPreserved: true,
            backofficeGrants: true,
            privilegesAdded: STATION_PLAN_READ,
            privilegesRemoved: [],
            flags: FLAGS_OFF,
          });
          await client.query('COMMIT');
          const deployed = await runtimePrivileges(c.cloud.pool, role);
          assert.deepEqual(deployed.filter(stage2Privilege), STATION_PLAN_READ);
          assert.deepEqual(
            deployed.filter((p) => !stage2Privilege(p)),
            acl.filter((p) => !stage2Privilege(p)),
          );
          // The standard runner accepts the resulting ledger: nothing pending, nothing reordered.
          assert.deepEqual(await migrate(c.cloud.pool, candidate, 'cloud'), []);
          // provision.mjs with the flags off grants exactly the same.
          await c.cloud.pool.query(stationPlanGrants(role, { backoffice: true, delivery: false }));
          await c.cloud.pool.query(reconciliationGrants(role, false));
          assert.deepEqual(await runtimePrivileges(c.cloud.pool, role), deployed);

          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await assert.rejects(
            deployStage2(client, { directory: candidate, role }),
            /Exact schema069 \(or schema068 with --with-069\) ledger required/,
          );
          await client.query('ROLLBACK');

          // One flag at a time: exact grants, equal to what provision.mjs gives that flag.
          const flag = async (name, enabled) => {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
            const result = await setStage2Flag(client, { role, flag: name, enabled });
            await client.query('COMMIT');
            return result;
          };
          assert.deepEqual(await flag('station-plan-delivery', true), {
            flag: 'station-plan-delivery',
            enabled: true,
            privilegesAdded: STATION_PLAN_WRITE,
            privilegesRemoved: [],
            environment: 'BACKOFFICE_STATION_PLAN_DELIVERY_ENABLED',
          });
          const delivering = await runtimePrivileges(c.cloud.pool, role);
          await c.cloud.pool.query(stationPlanGrants(role, { backoffice: true, delivery: true }));
          assert.deepEqual(await runtimePrivileges(c.cloud.pool, role), delivering);
          const reconciling = await flag('reconciliation', true);
          assert.deepEqual(reconciling.privilegesAdded, reconciliationPrivileges(true));
          assert.equal(reconciling.environment, 'BACKOFFICE_RECONCILIATION_ENABLED');
          const both = await runtimePrivileges(c.cloud.pool, role);
          await c.cloud.pool.query(reconciliationGrants(role, true));
          assert.deepEqual(await runtimePrivileges(c.cloud.pool, role), both);
          assert.ok(!both.some((p) => p.startsWith('bo_rec_accountants||INSERT')));
          assert.deepEqual(
            (await flag('reconciliation', false)).privilegesRemoved,
            reconciliationPrivileges(true),
          );
          assert.deepEqual(
            (await flag('station-plan-delivery', false)).privilegesRemoved,
            STATION_PLAN_WRITE,
          );
          assert.deepEqual(await runtimePrivileges(c.cloud.pool, role), deployed);
        }),
      { cloudMigrationDirectory: baseline },
    );
  } finally {
    for (const d of [baseline, candidate, future, tampered])
      await rm(d, { recursive: true, force: true });
  }
});

test('on the VPS ledger (schema068, no 069) deploy refuses; only --with-069 applies 069 too, without push grants', async () => {
  const baseline = await copyMigrations('stage2-baseline068-', (f) => +f.slice(0, 3) <= 68);
  const candidate = await copyMigrations('stage2-candidate-', (f) => +f.slice(0, 3) <= 71);
  try {
    await withSyncDatabases(
      (c) =>
        withRole(c, async (client, role) => {
          const acl = await runtimePrivileges(c.cloud.pool, role);
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await assert.rejects(
            setStage2Flag(client, { role, flag: 'reconciliation', enabled: true }),
            /Run deploy \(070\/071\) first/,
          );
          await client.query('ROLLBACK');
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          assert.deepEqual(
            await deployStage2(client, { directory: candidate, role, inspect: true }),
            {
              ledger: 'schema068',
              requires069: true,
              pending: [PUSH_MIGRATION, ...MIGRATIONS],
              backofficeGrants: false,
              privilegesAdded: [],
              flags: FLAGS_OFF,
            },
          );
          await assert.rejects(
            deployStage2(client, { directory: candidate, role }),
            /Cloud 069 is not applied: apply it by its own release first, or run deploy --with-069/,
          );
          await client.query('ROLLBACK');
          assert.equal(
            (await ledgerVersions(c.cloud.pool)).at(-1),
            '068_cloud_identity_abuse_limits.sql',
          );
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          assert.deepEqual(
            await deployStage2(client, { directory: candidate, role, with069: true }),
            {
              applied: [PUSH_MIGRATION, ...MIGRATIONS],
              existingDataPreserved: true,
              backofficeGrants: false,
              privilegesAdded: [],
              privilegesRemoved: [],
              flags: FLAGS_OFF,
            },
          );
          await client.query('COMMIT');
          // Back-office off and push off: the runtime role reaches none of the new tables.
          assert.deepEqual(await runtimePrivileges(c.cloud.pool, role), acl);
          assert.deepEqual(await migrate(c.cloud.pool, candidate, 'cloud'), []);
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await assert.rejects(
            setStage2Flag(client, { role, flag: 'station-plan-delivery', enabled: true }),
            /BACKOFFICE_ENABLED grants are required first/,
          );
          await client.query('ROLLBACK');
        }),
      { cloudMigrationDirectory: baseline },
    );
  } finally {
    for (const d of [baseline, candidate]) await rm(d, { recursive: true, force: true });
  }
});

test('why 069 comes first: 070 applied before 069 makes the standard runner refuse 069 forever', async () => {
  const baseline = await copyMigrations('stage2-baseline068-', (f) => +f.slice(0, 3) <= 68);
  const skipping = await copyMigrations(
    'stage2-skip069-',
    (f) => +f.slice(0, 3) <= 70 && f !== PUSH_MIGRATION,
  );
  const candidate = await copyMigrations('stage2-candidate-', (f) => +f.slice(0, 3) <= 71);
  try {
    await withSyncDatabases(
      async (c) => {
        // 070 does not need 069's objects: it applies on schema068 ...
        assert.deepEqual(await migrate(c.cloud.pool, skipping, 'cloud'), [MIGRATIONS[0]]);
        // ... but afterwards the ordered ledger can never take 069 (nor 071 after it).
        await assert.rejects(migrate(c.cloud.pool, candidate, 'cloud'), /Out-of-order migration/);
      },
      { cloudMigrationDirectory: baseline },
    );
  } finally {
    for (const d of [baseline, skipping, candidate]) await rm(d, { recursive: true, force: true });
  }
});
