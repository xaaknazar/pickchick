import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, copyFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import {
  upgradeQueueRecoveryCloud,
  queueRecoveryPrivileges,
  MIGRATION,
} from '../../infra/staging/queue-recovery-cloud-owner.mjs';

const source = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));
for (const posSyncEnabled of [false, true])
  for (const backofficeEnabled of [false, true]) {
    test(`cloud072 transaction: existing POS=${posSyncEnabled}, BO=${backofficeEnabled}`, async (t) => {
      const url = new URL(process.env.CLOUD_DATABASE_URL);
      assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Synthetic local database only');
      assert.ok(['local', 'test'].includes(process.env.APP_ENV));
      const tag = randomUUID().replaceAll('-', '');
      const schema = 'queue_cloud_' + tag,
        role = 'queue_app_' + tag,
        other = 'queue_other_' + tag;
      const admin = createPool(url.href);
      const temp = await mkdtemp(join(tmpdir(), 'queue-cloud072-'));
      let pool, client;
      try {
        const baseline = join(temp, 'baseline'),
          migrations = join(temp, 'db/cloud/migrations');
        await mkdir(baseline);
        await mkdir(migrations, { recursive: true });
        for (const f of await readdir(source))
          if (f.endsWith('.sql') && Number(f.slice(0, 3)) <= 72) {
            await copyFile(join(source, f), join(migrations, f));
            if (Number(f.slice(0, 3)) <= 71) await copyFile(join(source, f), join(baseline, f));
          }
        await admin.query(`CREATE SCHEMA ${schema}; CREATE ROLE ${role}; CREATE ROLE ${other}`);
        url.searchParams.set('options', '-c search_path=' + schema);
        pool = createPool(url.href);
        await migrate(pool, baseline, 'cloud');
        const org = randomUUID(),
          legal = randomUUID(),
          branchId = randomUUID();
        await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic')", [org]);
        await pool.query(
          "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
          [legal, org],
        );
        await pool.query(
          "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'TEST','Synthetic')",
          [branchId, org, legal],
        );
        await pool.query(`CREATE TABLE fixture_money(id bigserial PRIMARY KEY, amount bigint NOT NULL, meta jsonb NOT NULL);
        INSERT INTO fixture_money(amount,meta) VALUES(9223372036854775000,'{"unchanged":true}');
        GRANT SELECT ON fixture_money TO ${role}`);
        if (posSyncEnabled) await pool.query(`GRANT INSERT ON pos_order_sync_inbox TO ${role}`);
        if (backofficeEnabled) await pool.query(`GRANT INSERT ON bo_commands TO ${role}`);
        client = await pool.connect();
        const options = {
          mode: 'inspect',
          appRoot: temp,
          branchId,
          runtimeRole: role,
          schema,
          posSyncEnabled,
          backofficeEnabled,
        };
        const before = await upgradeQueueRecoveryCloud(client, options);
        assert.equal(before.schema, 71);
        assert.equal(before.apiDeployed, false);
        assert.equal(before.releaseReady, false);
        await t.test(
          'inspect does not apply DDL or grants; mismatch cannot change history',
          async () => {
            assert.equal(
              (await client.query("SELECT to_regclass('pos_kitchen_restore_conflicts') AS t"))
                .rows[0].t,
              null,
            );
            await assert.rejects(
              upgradeQueueRecoveryCloud(client, {
                ...options,
                mode: 'apply',
                posSyncEnabled: !posSyncEnabled,
              }),
              /declared flags/,
            );
            await assert.rejects(
              upgradeQueueRecoveryCloud(client, { ...options, branchId: randomUUID() }),
              /Branch not present/,
            );
            await admin.query(`ALTER ROLE ${role} CREATEDB`);
            await assert.rejects(upgradeQueueRecoveryCloud(client, options), /unprivileged/);
            await admin.query(`ALTER ROLE ${role} NOCREATEDB`);
            await admin.query(`GRANT ${other} TO ${role}`);
            await assert.rejects(upgradeQueueRecoveryCloud(client, options), /unprivileged/);
            await admin.query(`REVOKE ${other} FROM ${role}`);
            await assert.rejects(
              upgradeQueueRecoveryCloud(client, { ...options, runtimeRole: 'missing_' + tag }),
              /unprivileged/,
            );
            await assert.rejects(
              upgradeQueueRecoveryCloud(client, {
                ...options,
                backofficeEnabled: !backofficeEnabled,
              }),
              /declared flags/,
            );
            const original = (
              await client.query(
                'SELECT version,checksum FROM schema_migrations ORDER BY version LIMIT 1',
              )
            ).rows[0];
            await client.query('UPDATE schema_migrations SET checksum=$1 WHERE version=$2', [
              '0'.repeat(64),
              original.version,
            ]);
            await assert.rejects(
              upgradeQueueRecoveryCloud(client, { ...options, mode: 'apply' }),
              /history differs/,
            );
            await client.query('UPDATE schema_migrations SET checksum=$1 WHERE version=$2', [
              original.checksum,
              original.version,
            ]);
            const p = join(migrations, MIGRATION);
            await appendFile(p, '\nSELECT 1/0;\n');
            await assert.rejects(
              upgradeQueueRecoveryCloud(client, { ...options, mode: 'apply' }),
              /Reviewed migration072/,
            );
            await copyFile(join(source, MIGRATION), p);
            assert.equal(
              (await upgradeQueueRecoveryCloud(client, options)).fingerprint,
              before.fingerprint,
            );
          },
        );
        await t.test(
          'unreviewed default table and function grants roll back the complete transaction',
          async () => {
            for (const [kind, privilege] of [
              ['TABLES', 'DELETE'],
              ['FUNCTIONS', 'EXECUTE'],
            ]) {
              await client.query(
                `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ${privilege} ON ${kind} TO ${other}`,
              );
              await assert.rejects(
                upgradeQueueRecoveryCloud(client, { ...options, mode: 'apply' }),
                /Unexpected review/,
              );
              await client.query(
                `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ${privilege} ON ${kind} FROM ${other}`,
              );
              assert.equal(
                (await client.query("SELECT to_regclass('pos_kitchen_restore_conflicts') AS t"))
                  .rows[0].t,
                null,
              );
              assert.equal(
                (await upgradeQueueRecoveryCloud(client, options)).fingerprint,
                before.fingerprint,
              );
            }
          },
        );
        await t.test(
          'apply preserves old money/sequence/ACL and grants only the two new review tables',
          async () => {
            const after = await upgradeQueueRecoveryCloud(client, { ...options, mode: 'apply' });
            assert.equal(after.schema, 72);
            assert.equal(after.fingerprint, before.fingerprint);
            assert.deepEqual(after.privilegesAdded, queueRecoveryPrivileges(options));
            assert.equal(after.flagsChanged, false);
            assert.deepEqual(after.privilegesRemoved, []);
            assert.equal(
              (await client.query('SELECT amount::text AS amount FROM fixture_money')).rows[0]
                .amount,
              '9223372036854775000',
            );
            assert.equal(
              (await client.query('SELECT last_value::text AS n FROM fixture_money_id_seq')).rows[0]
                .n,
              '1',
            );
            for (const [table, privilege, expected] of [
              ['pos_kitchen_restore_conflicts', 'SELECT', posSyncEnabled || backofficeEnabled],
              ['pos_kitchen_restore_conflicts', 'INSERT', posSyncEnabled],
              ['pos_kitchen_restore_decisions', 'SELECT', backofficeEnabled],
              ['pos_kitchen_restore_decisions', 'INSERT', backofficeEnabled],
              ['pos_kitchen_restore_conflicts', 'UPDATE', false],
              ['pos_kitchen_restore_decisions', 'DELETE', false],
              ['fixture_money', 'SELECT', true],
              ['fixture_money', 'UPDATE', false],
            ])
              assert.equal(
                (
                  await client.query('SELECT has_table_privilege($1,$2,$3) AS ok', [
                    role,
                    schema + '.' + table,
                    privilege,
                  ])
                ).rows[0].ok,
                expected,
              );
            assert.equal(
              (await client.query('SELECT count(*)::int AS n FROM pos_kitchen_restore_decisions'))
                .rows[0].n,
              0,
            );
          },
        );
        await t.test('repeat migration cannot rewrite history', async () => {
          await assert.rejects(
            upgradeQueueRecoveryCloud(client, { ...options, mode: 'apply' }),
            /no replay/,
          );
        });
      } finally {
        client?.release();
        await pool?.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        for (const name of [role, other])
          if ((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [name])).rowCount)
            await admin.query(`DROP OWNED BY ${name}; DROP ROLE ${name}`);
        await admin.end();
        await rm(temp, { recursive: true, force: true });
      }
    });
  }
