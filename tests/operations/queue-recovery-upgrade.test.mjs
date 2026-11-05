import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, copyFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { upgradeQueueRecoverySchema } from '../../infra/windows/queue-recovery-upgrade-db.mjs';

test('279 database step preserves schema024 and fails closed before committing schema025', async (t) => {
  const config = loadConfig('edge');
  assert.ok(['local', 'test'].includes(config.environment));
  const suffix = randomUUID().replaceAll('-', '');
  const schema = 'review_' + suffix,
    role = 'review_runtime_' + suffix,
    other = 'review_other_' + suffix;
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const temp = await mkdtemp(join(tmpdir(), 'queue-upgrade-'));
  const migrations = join(temp, 'db/edge/migrations');
  const admin = createPool(config.databaseUrl);
  let pool, client;
  try {
    await mkdir(migrations, { recursive: true });
    const source = join(root, 'db/edge/migrations');
    for (const name of await readdir(source))
      if (/^\d{3}_.*\.sql$/.test(name) && name < '025')
        await copyFile(join(source, name), join(migrations, name));
    await admin.query(`CREATE SCHEMA ${schema}; CREATE ROLE ${role}; CREATE ROLE ${other}`);
    const url = new URL(config.databaseUrl);
    url.searchParams.set('options', '-c search_path=' + schema);
    pool = createPool(url.href);
    await migrate(pool, migrations, 'edge');
    await copyFile(
      join(source, '025_edge_kitchen_restore_review.sql'),
      join(migrations, '025_edge_kitchen_restore_review.sql'),
    );
    const branchId = randomUUID();
    await pool.query(
      "INSERT INTO branch_config(id,code,name,timezone) VALUES($1,'REHEARSAL','Synthetic','Asia/Almaty')",
      [branchId],
    );
    await pool.query(`GRANT SELECT ON branch_config TO ${role}`);
    client = await pool.connect();
    const options = { mode: 'inspect', appRoot: temp, branchId, schema, runtimeRole: role };
    const before = await upgradeQueueRecoverySchema(client, options);
    assert.equal(before.migrations, 24);
    await t.test('inspect leaves ledger and new objects unchanged', async () => {
      assert.equal(
        (await client.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n,
        24,
      );
      assert.equal(
        (await client.query("SELECT to_regclass('fulfillment_restore_reviews') t")).rows[0].t,
        null,
      );
    });
    await t.test('wrong branch, absent role and privileged role are rejected', async () => {
      await assert.rejects(
        upgradeQueueRecoverySchema(client, { ...options, mode: 'apply', branchId: randomUUID() }),
        /Branch differs/,
      );
      await assert.rejects(
        upgradeQueueRecoverySchema(client, { ...options, runtimeRole: 'missing_' + suffix }),
        /unprivileged runtime/,
      );
      await admin.query(`ALTER ROLE ${role} CREATEDB`);
      await assert.rejects(upgradeQueueRecoverySchema(client, options), /unprivileged runtime/);
      await admin.query(`ALTER ROLE ${role} NOCREATEDB`);
    });
    await t.test('modified migration bytes are rejected before SQL executes', async () => {
      const path = join(migrations, '025_edge_kitchen_restore_review.sql');
      await appendFile(path, '\nSELECT 1/0;\n');
      await assert.rejects(
        upgradeQueueRecoverySchema(client, { ...options, mode: 'apply' }),
        /migration bytes differ/,
      );
      await copyFile(join(source, '025_edge_kitchen_restore_review.sql'), path);
    });
    await t.test('changed installed ledger is rejected', async () => {
      const version = '024_edge_station_plans.sql';
      const original = (
        await client.query('SELECT checksum FROM schema_migrations WHERE version=$1', [version])
      ).rows[0].checksum;
      await client.query('UPDATE schema_migrations SET checksum=$1 WHERE version=$2', [
        '0'.repeat(64),
        version,
      ]);
      await assert.rejects(
        upgradeQueueRecoverySchema(client, { ...options, mode: 'apply' }),
        /Exact unchanged schema024/,
      );
      await client.query('UPDATE schema_migrations SET checksum=$1 WHERE version=$2', [
        original,
        version,
      ]);
    });
    await t.test(
      'unexpected inherited grants roll back DDL, ledger and grants together',
      async () => {
        await client.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT DELETE ON TABLES TO ${other}`,
        );
        await assert.rejects(
          upgradeQueueRecoverySchema(client, { ...options, mode: 'apply' }),
          /Unexpected restore-review privileges/,
        );
        await client.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE DELETE ON TABLES FROM ${other}`,
        );
        assert.equal(
          (await client.query("SELECT to_regclass('fulfillment_restore_decisions') t")).rows[0].t,
          null,
        );
        assert.equal(
          (await upgradeQueueRecoverySchema(client, options)).fingerprint,
          before.fingerprint,
        );
      },
    );
    await t.test(
      'apply preserves old data and grants only review/read and decision/insert',
      async () => {
        const result = await upgradeQueueRecoverySchema(client, { ...options, mode: 'apply' });
        assert.equal(result.migrations, 25);
        assert.equal(result.fingerprint, before.fingerprint);
        assert.equal(result.restoreFenceExecuted, false);
        for (const [table, privilege, expected] of [
          ['branch_config', 'SELECT', true],
          ['fulfillment_restore_reviews', 'SELECT', true],
          ['fulfillment_restore_decisions', 'INSERT', true],
          ['fulfillment_restore_decisions', 'UPDATE', false],
          ['fulfillment_restore_decisions', 'DELETE', false],
          ['fulfillment_restore_reviews', 'INSERT', false],
          ['fulfillment_restore_epochs', 'SELECT', false],
        ])
          assert.equal(
            (
              await client.query('SELECT has_table_privilege($1,$2,$3) allowed', [
                role,
                schema + '.' + table,
                privilege,
              ])
            ).rows[0].allowed,
            expected,
          );
        assert.equal(
          (await client.query('SELECT count(*)::int n FROM fulfillment_restore_epochs')).rows[0].n,
          0,
        );
      },
    );
    await t.test('repeat upgrade is rejected', async () => {
      await assert.rejects(
        upgradeQueueRecoverySchema(client, { ...options, mode: 'apply' }),
        /Expected schema024/,
      );
    });
  } finally {
    client?.release();
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    for (const name of [role, other]) {
      // Drop only random roles created by this fixture, including their default-ACL dependency.
      const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [name]);
      if (exists.rowCount) await admin.query(`DROP OWNED BY ${name}; DROP ROLE ${name}`);
    }
    await admin.end();
    await rm(temp, { recursive: true, force: true });
  }
});
