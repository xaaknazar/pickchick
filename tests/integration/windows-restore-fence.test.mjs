// Release fixes 2026-10-19 (audit 6.4): reviewed edge022 -> 023 upgrade on the Windows cashier.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, copyFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { restoreFenceMigration } from '../../infra/windows/restore-fence-upgrade-db.mjs';

test('restore fence upgrade keeps schema022 data/ACL/sequences, records only the initial epoch and refuses a repeat', async () => {
  const appRoot = fileURLToPath(new URL('../../', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-restore-fence-'));
  try {
    const source = join(appRoot, 'db/edge/migrations');
    const candidateRoot = join(dir, 'candidate');
    const candidateMigrations = join(candidateRoot, 'db/edge/migrations');
    const installed = join(dir, 'installed');
    await mkdir(candidateMigrations, { recursive: true });
    await mkdir(installed, { recursive: true });
    for (const name of (await readdir(source)).filter((n) => n.endsWith('.sql'))) {
      if (name < '024') await copyFile(join(source, name), join(candidateMigrations, name));
      if (name < '023') await copyFile(join(source, name), join(installed, name));
    }
    await withSyncDatabases(
      async (f) => {
        const suffix = f.branch.replaceAll('-', '').slice(0, 20);
        const runtimeRole = 'runtime_' + suffix,
          workerRole = 'worker_' + suffix;
        const client = await f.edge.pool.connect();
        try {
          for (const role of [runtimeRole, workerRole]) await client.query(`CREATE ROLE ${role}`);
          await client.query(`GRANT USAGE ON SCHEMA ${f.edge.schema} TO ${runtimeRole}`);
          await client.query(
            'INSERT INTO menu_sync_state(branch_id,producer_id,last_sequence) VALUES($1,gen_random_uuid(),7) ON CONFLICT (branch_id) DO UPDATE SET last_sequence=7',
            [f.branch],
          );
          const options = {
            mode: 'inspect',
            appRoot: candidateRoot,
            branchId: f.branch,
            schema: f.edge.schema,
            runtimeRole,
            workerRole,
          };
          await assert.rejects(
            restoreFenceMigration(client, { ...options, appRoot: join(dir, 'missing') }),
          );
          await assert.rejects(
            restoreFenceMigration(client, { ...options, branchId: 'wrong' }),
            /Branch differs/,
          );
          const before = await restoreFenceMigration(client, options);
          assert.equal(before.migrations, 22);
          assert.equal(before.epoch, null);
          assert.equal(
            (await client.query("SELECT to_regprocedure('edge_restore_fence(boolean)') f")).rows[0]
              .f,
            null,
          );
          const after = await restoreFenceMigration(client, { ...options, mode: 'apply' });
          assert.equal(after.migrations, 23);
          assert.equal(after.epoch, 1);
          assert.equal(after.fingerprint, before.fingerprint);
          assert.deepEqual(after.fenceGrantedTo, [runtimeRole, workerRole].sort());
          for (const role of [runtimeRole, workerRole])
            assert.equal(
              (
                await client.query(
                  "SELECT has_function_privilege($1,'edge_restore_fence(boolean)','EXECUTE') ok",
                  [role],
                )
              ).rows[0].ok,
              true,
            );
          const state = await client.query(
            'SELECT last_sequence::int AS s, restore_resync_from AS r FROM menu_sync_state WHERE branch_id=$1',
            [f.branch],
          );
          assert.deepEqual(state.rows[0], { s: 7, r: null });
          // The least-privileged runtime sees the same database: the fence stays 'current'.
          await client.query(`SET ROLE ${runtimeRole}`);
          const fence = await client.query(
            `SELECT state, epoch FROM ${f.edge.schema}.edge_restore_fence(false)`,
          );
          await client.query('RESET ROLE');
          assert.deepEqual(fence.rows[0], { state: 'current', epoch: 1 });
          await assert.rejects(
            restoreFenceMigration(client, { ...options, mode: 'apply' }),
            /Expected unchanged schema022/,
          );
        } finally {
          await client.query('RESET ROLE').catch(() => {});
          await client.query('ROLLBACK').catch(() => {});
          for (const role of [runtimeRole, workerRole])
            await client.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`).catch(() => {});
          client.release();
        }
      },
      { edgeMigrationDirectory: installed },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
