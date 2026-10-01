import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPool, migrate } from '@pickchick/database';
import { applyMenu, publishMenu } from '@pickchick/menu-sync';
import { provisionStaff } from '@pickchick/local-orders';
import {
  inspectServiceUpgrade,
  inspectServiceRuntime,
} from '../../infra/windows/native-service-upgrade-db.mjs';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';
import { withSyncDatabases } from '../helpers/sync.mjs';

test('009 to 014 verifies every recoverable migration checkpoint and rejects data, scope, mode or new-table changes', async () => {
  const directory = fileURLToPath(new URL('../../db/edge/migrations/', import.meta.url));
  const checkpoints = await mkdtemp(join(tmpdir(), 'pickchick-service-upgrade-'));
  try {
    const migrations = [];
    for (const name of (await readdir(directory))
      .filter((n) => /^\d{3}_[a-z_]+\.sql$/.test(n) && n < '015')
      .sort()) {
      migrations.push({
        name,
        checksum: createHash('sha256')
          .update(await readFile(join(directory, name)))
          .digest('hex'),
      });
      if (name < '010') await copyFile(join(directory, name), join(checkpoints, name));
    }
    assert.equal(migrations.length, 14, 'This verifier is pinned to the reviewed 014 release');
    await withSyncDatabases(
      async (ctx) => {
        await applyMenu(ctx.edge.pool, ctx.branch, await publishMenu(ctx.cloud.pool, ctx.menu()));
        const staff = await provisionStaff(ctx.edge.pool, ctx.branch, {
          staff_id: randomUUID(),
          terminal_id: randomUUID(),
          role: 'cashier',
          name: 'Synthetic untouched cashier',
        });
        const role = (await ctx.edge.pool.query('SELECT current_user AS role')).rows[0].role;
        const options = {
          branchId: ctx.branch,
          migrations: migrations.slice(0, 9),
          role,
          schema: ctx.edge.schema,
        };
        const before = await inspectServiceUpgrade(ctx.edge.pool, options);
        assert.equal(Object.keys(before.fingerprints).length, 29);
        for (const bad of [
          { role: 'wrong_role' },
          { branchId: randomUUID() },
          { schema: 'public;drop schema public' },
        ])
          await assert.rejects(inspectServiceUpgrade(ctx.edge.pool, { ...options, ...bad }));
        for (let target = 10; target <= 14; target++) {
          const migration = migrations[target - 1];
          await copyFile(join(directory, migration.name), join(checkpoints, migration.name));
          assert.deepEqual(await migrate(ctx.edge.pool, checkpoints, 'edge'), [migration.name]);
          options.migrations = migrations.slice(0, target);
          const progress = await inspectServiceUpgrade(ctx.edge.pool, options);
          assert.equal(progress.migrations, target);
          assert.equal(progress.serviceMode, 'payment_required');
          assert.deepEqual(progress.fingerprints, before.fingerprints);
          assert.deepEqual(progress.tableCounts, before.tableCounts);
        }
        assert.deepEqual(await migrate(ctx.edge.pool, checkpoints, 'edge'), []);
        const changed = migrations.map((row) => ({ ...row }));
        changed[12].checksum = '0'.repeat(64);
        await assert.rejects(
          inspectServiceUpgrade(ctx.edge.pool, { ...options, migrations: changed }),
        );
        const client = await ctx.edge.pool.connect();
        try {
          for (const sql of [
            "UPDATE branch_config SET pos_service_mode='unpaid_service'",
            'UPDATE branch_config SET ordering_enabled=true',
            'CREATE TABLE unrelated_table(id int)',
            `INSERT INTO local_staff_login_limits(terminal_id,branch_id,window_started_at,attempts) VALUES('${staff.terminal_id}','${ctx.branch}',clock_timestamp(),1)`,
          ]) {
            await client.query('BEGIN');
            await client.query(sql);
            await assert.rejects(inspectServiceUpgrade(client, options));
            await client.query('ROLLBACK');
          }
          await client.query('BEGIN');
          await client.query("UPDATE local_staff SET name='Different staff'");
          const mutated = await inspectServiceUpgrade(client, options);
          assert.notDeepEqual(mutated.fingerprints, before.fingerprints);
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
        const runtime = 'upgrade_runtime_' + randomUUID().replaceAll('-', ''),
          password = randomBytes(32).toString('hex');
        let pool;
        try {
          await ctx.edge.admin.query(
            `CREATE ROLE ${runtime} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
          );
          await applyEdgeRuntimeGrants(ctx.edge.pool, runtime, {
            schema: ctx.edge.schema,
            fulfillment: false,
          });
          const url = new URL(ctx.edge.config.databaseUrl);
          url.username = runtime;
          url.password = password;
          pool = createPool(url.toString(), 1);
          const runtimeClient = await pool.connect();
          try {
            await runtimeClient.query('BEGIN READ ONLY');
            const result = await inspectServiceRuntime(runtimeClient, {
              branchId: ctx.branch,
              role: runtime,
              schema: ctx.edge.schema,
            });
            assert.equal(result.runtimeVerified, true);
            assert.equal(result.fulfillmentEnabled, false);
            await runtimeClient.query('ROLLBACK');
            await applyEdgeRuntimeGrants(ctx.edge.pool, runtime, {
              schema: ctx.edge.schema,
              fulfillment: true,
            });
            await runtimeClient.query('BEGIN READ ONLY');
            await assert.rejects(
              inspectServiceRuntime(runtimeClient, {
                branchId: ctx.branch,
                role: runtime,
                schema: ctx.edge.schema,
              }),
            );
            await runtimeClient.query('ROLLBACK');
          } finally {
            runtimeClient.release();
          }
        } finally {
          if (pool) await pool.end();
          await ctx.edge.admin.query(`DROP OWNED BY ${runtime}`);
          await ctx.edge.admin.query(`DROP ROLE ${runtime}`);
        }
      },
      { edgeMigrationDirectory: checkpoints },
    );
  } finally {
    await rm(checkpoints, { recursive: true, force: true });
  }
});
