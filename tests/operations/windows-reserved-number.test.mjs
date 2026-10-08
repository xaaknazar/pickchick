import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, copyFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { reserveOrderNumberMigration } from '../../infra/windows/reserve-order-number-db.mjs';

test('numbering upgrade preserves schema014 data/ACL/sequences, checks branch and refuses repeat migration', async () => {
  const appRoot = fileURLToPath(new URL('../../', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-numbering-'));
  try {
    const source = join(appRoot, 'db/edge/migrations');
    const candidateRoot = join(dir, 'candidate');
    const candidateMigrations = join(candidateRoot, 'db/edge/migrations');
    await mkdir(candidateMigrations, { recursive: true });
    for (const name of (await readdir(source)).filter((n) => n.endsWith('.sql') && n < '016'))
      await copyFile(join(source, name), join(candidateMigrations, name));
    for (const name of (await readdir(source)).filter((n) => n.endsWith('.sql') && n < '015'))
      await copyFile(join(source, name), join(dir, name));
    await withSyncDatabases(
      async (f) => {
        const client = await f.edge.pool.connect();
        try {
          const options = {
            mode: 'inspect',
            appRoot: candidateRoot,
            branchId: f.branch,
            schema: f.edge.schema,
          };
          await assert.rejects(
            reserveOrderNumberMigration(client, { ...options, appRoot }),
            /Expected unchanged schema014/,
          );
          await assert.rejects(
            reserveOrderNumberMigration(client, { ...options, branchId: 'wrong' }),
            /Branch differs/,
          );
          const before = await reserveOrderNumberMigration(client, options);
          assert.equal(before.migrations, 14);
          const after = await reserveOrderNumberMigration(client, { ...options, mode: 'apply' });
          assert.equal(after.migrations, 15);
          assert.equal(after.fingerprint, before.fingerprint);
          assert.equal(
            (await client.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n,
            15,
          );
          await assert.rejects(
            reserveOrderNumberMigration(client, { ...options, mode: 'apply' }),
            /Expected unchanged schema014/,
          );
        } finally {
          client.release();
        }
      },
      { edgeMigrationDirectory: dir },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stop-list runtime update only grants seven read columns and preserves every row and sequence', async () => {
  const { grantStopAvailability } = await import('../../infra/windows/grant-stop-availability.mjs');
  const candidateRoot = await mkdtemp(join(tmpdir(), 'pickchick-stop-availability-'));
  const migrations = join(candidateRoot, 'db/edge/migrations');
  await mkdir(migrations, { recursive: true });
  const source = fileURLToPath(new URL('../../db/edge/migrations/', import.meta.url));
  try {
    for (const name of (await readdir(source)).filter((n) => n.endsWith('.sql') && n < '016'))
      await copyFile(join(source, name), join(migrations, name));
    await withSyncDatabases(
      async (f) => {
        const client = await f.edge.pool.connect();
        const role = 'stops_' + f.branch.replaceAll('-', '');
        try {
          await client.query(`CREATE ROLE ${role}`);
          const options = {
            mode: 'inspect',
            appRoot: candidateRoot,
            branchId: f.branch,
            schema: f.edge.schema,
            role,
          };
          const before = await grantStopAvailability(client, options);
          const after = await grantStopAvailability(client, { ...options, mode: 'apply' });
          assert.equal(before.fingerprint, after.fingerprint);
          assert.equal(after.migrations, 15);
          const privileges = await client.query(
            `SELECT has_column_privilege($1,'local_stops','variant_id','SELECT') readable, has_table_privilege($1,'local_stops','UPDATE') writable, has_table_privilege($1,'local_cash_shifts','SELECT') cash`,
            [role],
          );
          assert.equal(privileges.rows[0].readable, true);
          assert.equal(privileges.rows[0].writable, false);
          assert.equal(privileges.rows[0].cash, false);
        } finally {
          await client.query(`DROP OWNED BY ${role}`);
          await client.query(`DROP ROLE ${role}`);
          client.release();
        }
      },
      { edgeMigrationDirectory: migrations },
    );
  } finally {
    await rm(candidateRoot, { recursive: true, force: true });
  }
});

// The existing CI entry point includes the subsequent guarded kiosk upgrade.
import './windows-kiosk-upgrade.test.mjs';
