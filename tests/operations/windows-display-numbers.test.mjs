// Release fixes 2026-10-19 (audit 1.4): reviewed edge021 -> 022 upgrade on the Windows cashier.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, copyFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { displayNumbersMigration } from '../../infra/windows/display-numbers-upgrade-db.mjs';

test('display numbers upgrade keeps schema021 data/ACL/sequences, grants only the allocator and refuses a repeat', async () => {
  const appRoot = fileURLToPath(new URL('../../', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-display-numbers-'));
  try {
    const source = join(appRoot, 'db/edge/migrations');
    const candidateRoot = join(dir, 'candidate');
    const candidateMigrations = join(candidateRoot, 'db/edge/migrations');
    const installed = join(dir, 'installed');
    await mkdir(candidateMigrations, { recursive: true });
    await mkdir(installed, { recursive: true });
    for (const name of (await readdir(source)).filter((n) => n.endsWith('.sql'))) {
      if (name < '023') await copyFile(join(source, name), join(candidateMigrations, name));
      if (name < '022') await copyFile(join(source, name), join(installed, name));
    }
    await withSyncDatabases(
      async (f) => {
        const suffix = f.branch.replaceAll('-', '').slice(0, 20);
        const runtimeRole = 'runtime_' + suffix,
          workerRole = 'worker_' + suffix;
        const client = await f.edge.pool.connect();
        try {
          for (const role of [runtimeRole, workerRole]) await client.query(`CREATE ROLE ${role}`);
          const options = {
            mode: 'inspect',
            appRoot: candidateRoot,
            branchId: f.branch,
            schema: f.edge.schema,
            runtimeRole,
            workerRole,
          };
          // The full repository has later migrations: only the exact reviewed step is accepted.
          await assert.rejects(
            displayNumbersMigration(client, { ...options, appRoot: join(dir, 'missing') }),
          );
          await assert.rejects(
            displayNumbersMigration(client, { ...options, branchId: 'wrong' }),
            /Branch differs/,
          );
          const before = await displayNumbersMigration(client, options);
          assert.equal(before.migrations, 21);
          assert.equal(
            (await client.query("SELECT to_regprocedure('fulfillment_display_allocate(uuid)') f"))
              .rows[0].f,
            null,
          );
          const after = await displayNumbersMigration(client, { ...options, mode: 'apply' });
          assert.equal(after.migrations, 22);
          assert.equal(after.fingerprint, before.fingerprint);
          assert.deepEqual(after.allocatorGrantedTo, [runtimeRole, workerRole].sort());
          for (const role of [runtimeRole, workerRole])
            assert.equal(
              (
                await client.query(
                  "SELECT has_function_privilege($1,'fulfillment_display_allocate(uuid)','EXECUTE') ok",
                  [role],
                )
              ).rows[0].ok,
              true,
            );
          await assert.rejects(
            displayNumbersMigration(client, { ...options, mode: 'apply' }),
            /Expected unchanged schema021/,
          );
        } finally {
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
