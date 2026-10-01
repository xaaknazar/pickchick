import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
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
    for (const name of (await readdir(source)).filter((n) => n.endsWith('.sql') && n < '015'))
      await copyFile(join(source, name), join(dir, name));
    await withSyncDatabases(
      async (f) => {
        const client = await f.edge.pool.connect();
        try {
          const options = { mode: 'inspect', appRoot, branchId: f.branch, schema: f.edge.schema };
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
