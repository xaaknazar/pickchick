import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrate } from '@pickchick/database';
import { applyMenu, publishMenu } from '@pickchick/menu-sync';
import { inspectPreview } from '../../infra/windows/native-upgrade-db.mjs';
import { withSyncDatabases } from '../helpers/sync.mjs';

test('read-only preview verifier preserves all old table fingerprints through 009 to 010 and rejects wrong scope', async () => {
  const directory = fileURLToPath(new URL('../../db/edge/migrations/', import.meta.url));
  const old = await mkdtemp(join(tmpdir(), 'pickchick-native-upgrade-'));
  const target = await mkdtemp(join(tmpdir(), 'pickchick-native-upgrade-010-'));
  try {
    const migrations = [];
    for (const name of (await readdir(directory))
      .filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name) && name < '011')
      .sort()) {
      migrations.push({
        name,
        checksum: createHash('sha256')
          .update(await readFile(join(directory, name)))
          .digest('hex'),
      });
      await copyFile(join(directory, name), join(target, name));
      if (name < '010') await copyFile(join(directory, name), join(old, name));
    }
    await withSyncDatabases(
      async (ctx) => {
        await applyMenu(ctx.edge.pool, ctx.branch, await publishMenu(ctx.cloud.pool, ctx.menu()));
        const role = (await ctx.edge.pool.query('SELECT current_user AS role')).rows[0].role;
        const options = {
          branchId: ctx.branch,
          migrations: migrations.slice(0, 9),
          role,
          schema: ctx.edge.schema,
        };
        const before = await inspectPreview(ctx.edge.pool, options);
        assert.equal(before.migrations, 9);
        assert.equal(Object.keys(before.fingerprints).length, 29);
        await assert.rejects(inspectPreview(ctx.edge.pool, { ...options, role: 'wrong_role' }));
        await assert.rejects(
          inspectPreview(ctx.edge.pool, {
            ...options,
            branchId: '00000000-0000-4000-8000-000000000000',
          }),
        );
        await assert.rejects(
          inspectPreview(ctx.edge.pool, { ...options, schema: 'public;drop schema public' }),
        );
        await ctx.edge.pool.query('UPDATE branch_config SET ordering_enabled=true');
        await assert.rejects(inspectPreview(ctx.edge.pool, options));
        await ctx.edge.pool.query('UPDATE branch_config SET ordering_enabled=false');
        await migrate(ctx.edge.pool, target, 'edge');
        const after = await inspectPreview(ctx.edge.pool, { ...options, migrations });
        assert.equal(after.migrations, 10);
        assert.deepEqual(after.fingerprints, before.fingerprints);
        await assert.rejects(inspectPreview(ctx.edge.pool, options));
        const changed = migrations.map((row) => ({ ...row }));
        changed[9].checksum = '0'.repeat(64);
        await assert.rejects(inspectPreview(ctx.edge.pool, { ...options, migrations: changed }));
      },
      { edgeMigrationDirectory: old },
    );
  } finally {
    await rm(old, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});
