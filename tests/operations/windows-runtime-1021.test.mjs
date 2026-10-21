import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readdir, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { upgradeRuntimeSchema } from '../../infra/windows/runtime-schema-1021.mjs';

test('runtime020->023 is atomic, preserves rows and old ACL, grants only new capabilities and refuses replay', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const temp = await mkdtemp(join(tmpdir(), 'pickchick-runtime-1021-'));
  const installed = join(temp, 'installed'),
    candidate = join(temp, 'candidate'),
    migrations = join(candidate, 'db/edge/migrations');
  try {
    await mkdir(installed, { recursive: true });
    await mkdir(migrations, { recursive: true });
    for (const n of (await readdir(join(root, 'db/edge/migrations'))).filter((n) =>
      n.endsWith('.sql'),
    )) {
      await copyFile(join(root, 'db/edge/migrations', n), join(migrations, n));
      if (n < '021') await copyFile(join(root, 'db/edge/migrations', n), join(installed, n));
    }
    await withSyncDatabases(
      async (f) => {
        const suffix = f.branch.replaceAll('-', '').slice(0, 16),
          runtimeRole = 'runtime_' + suffix,
          workerRole = 'worker_' + suffix,
          deviceRole = 'device_' + suffix;
        const c = await f.edge.pool.connect(),
          options = {
            mode: 'inspect',
            appRoot: candidate,
            branchId: f.branch,
            schema: f.edge.schema,
            runtimeRole,
            workerRole,
            deviceRole,
          };
        try {
          for (const role of [runtimeRole, workerRole, deviceRole])
            await c.query(`CREATE ROLE ${role}`);
          const before = await upgradeRuntimeSchema(c, options);
          assert.equal(before.migrations, 20);
          await assert.rejects(
            upgradeRuntimeSchema(c, { ...options, branchId: 'wrong' }),
            /Branch differs/,
          );
          await appendFile(join(migrations, '023_edge_restore_fence.sql'), '\nSELECT 1/0;\n');
          await assert.rejects(
            upgradeRuntimeSchema(c, { ...options, mode: 'apply' }),
            /division by zero/,
          );
          assert.equal(
            (await c.query("SELECT to_regclass('terminal_presence') t")).rows[0].t,
            null,
          );
          assert.equal(
            (await c.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n,
            20,
          );
          await copyFile(
            join(root, 'db/edge/migrations/023_edge_restore_fence.sql'),
            join(migrations, '023_edge_restore_fence.sql'),
          );
          const after = await upgradeRuntimeSchema(c, { ...options, mode: 'apply' });
          assert.equal(after.migrations, 23);
          assert.equal(after.fingerprint, before.fingerprint);
          for (const [role, privilege, expected] of [
            [runtimeRole, 'SELECT', true],
            [runtimeRole, 'INSERT', true],
            [runtimeRole, 'UPDATE', true],
            [runtimeRole, 'DELETE', false],
            [deviceRole, 'SELECT', true],
            [deviceRole, 'INSERT', false],
            [workerRole, 'SELECT', false],
          ]) {
            assert.equal(
              (
                await c.query("SELECT has_table_privilege($1,'terminal_presence',$2) allowed", [
                  role,
                  privilege,
                ])
              ).rows[0].allowed,
              expected,
            );
          }
          for (const role of [runtimeRole, workerRole])
            for (const fn of ['fulfillment_display_allocate(uuid)', 'edge_restore_fence(boolean)'])
              assert.equal(
                (
                  await c.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [
                    role,
                    fn,
                  ])
                ).rows[0].allowed,
                true,
              );
          assert.equal(
            (await c.query('SELECT state FROM edge_restore_fence()')).rows[0].state,
            'current',
          );
          await assert.rejects(
            upgradeRuntimeSchema(c, { ...options, mode: 'apply' }),
            /Exact unchanged schema020/,
          );
        } finally {
          await c.query('ROLLBACK').catch(() => {});
          for (const role of [runtimeRole, workerRole, deviceRole])
            await c.query(`DROP OWNED BY ${role};DROP ROLE ${role}`).catch(() => {});
          c.release();
        }
      },
      { edgeMigrationDirectory: installed },
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
