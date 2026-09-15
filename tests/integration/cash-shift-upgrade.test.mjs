import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrate } from '@pickchick/database';
import { applyMenu, publishMenu, hashJson } from '@pickchick/menu-sync';
import {
  createQuote,
  createLocalOrder,
  readLocalOrder,
  provisionStaff,
  setOrdering,
  cancelLocalOrder,
} from '@pickchick/local-orders';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { staffAuth } from '../helpers/orders.mjs';

test('edge 009 to 010 preserves existing order/quote/menu bytes and allows legacy cancellation', async () => {
  const directory = fileURLToPath(new URL('../../db/edge/migrations/', import.meta.url));
  const old = await mkdtemp(join(tmpdir(), 'pickchick-shift-upgrade-'));
  try {
    for (const name of await readdir(directory))
      if (/^00\d_[a-z_]+\.sql$/.test(name)) await copyFile(join(directory, name), join(old, name));
    await withSyncDatabases(
      async (ctx) => {
        const menu = ctx.menu();
        await applyMenu(ctx.edge.pool, ctx.branch, await publishMenu(ctx.cloud.pool, menu));
        const manager = await provisionStaff(ctx.edge.pool, ctx.branch, {
          staff_id: randomUUID(),
          terminal_id: randomUUID(),
          role: 'shift_manager',
          name: 'Synthetic migration staff',
        });
        const auth = staffAuth(manager);
        await setOrdering(ctx.edge.pool, ctx.branch, auth, randomUUID(), true, {
          expected_version: 1,
        });
        const cart = {
          release_id: menu.release_id,
          service_mode: 'takeaway',
          items: [{ variant_id: menu.items[0].variant_id, quantity: 1 }],
        };
        const quote = await createQuote(ctx.edge.pool, ctx.branch, auth, cart),
          id = randomUUID();
        await ctx.edge.pool.query(
          'INSERT INTO local_orders(id,branch_id,quote_id,total_minor) VALUES($1,$2,$3,$4)',
          [id, ctx.branch, quote.quote_id, quote.total_minor],
        );
        const before = (
          await ctx.edge.pool.query(
            'SELECT version,checksum FROM schema_migrations ORDER BY version',
          )
        ).rows;
        const hashes = async () => ({
          quote: hashJson(
            (
              await ctx.edge.pool.query('SELECT snapshot FROM checkout_quotes WHERE id=$1', [
                quote.quote_id,
              ])
            ).rows[0].snapshot,
          ),
          menu: hashJson(
            (
              await ctx.edge.pool.query('SELECT payload FROM menu_snapshots WHERE id=$1', [
                menu.release_id,
              ])
            ).rows[0].payload,
          ),
        });
        const oldHashes = await hashes();
        assert.deepEqual(
          await migrate(ctx.edge.pool, directory, 'edge'),
          (await readdir(directory))
            .filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name) && name >= '010')
            .sort(),
        );
        assert.deepEqual(await migrate(ctx.edge.pool, directory, 'edge'), []);
        assert.deepEqual(
          (
            await ctx.edge.pool.query(
              'SELECT version,checksum FROM schema_migrations ORDER BY version',
            )
          ).rows.slice(0, 9),
          before,
        );
        assert.deepEqual(await hashes(), oldHashes);
        const read = await readLocalOrder(ctx.edge.pool, ctx.branch, auth, id);
        assert.equal(read.cash_shift_id, undefined);
        assert.deepEqual(read.snapshot, quote);
        assert.equal(
          (
            await cancelLocalOrder(ctx.edge.pool, ctx.branch, auth, randomUUID(), id, {
              expected_version: 1,
              reason: 'Legacy order cancel after upgrade',
            })
          ).state,
          'cancelled',
        );
        const newQuote = await createQuote(ctx.edge.pool, ctx.branch, auth, cart);
        await assert.rejects(
          createLocalOrder(ctx.edge.pool, ctx.branch, auth, randomUUID(), {
            quote_id: newQuote.quote_id,
          }),
          (error) => error.code === 'CASH_SHIFT_REQUIRED',
        );
        assert.equal(
          (await ctx.edge.pool.query('SELECT count(*) FROM local_cash_shifts')).rows[0].count,
          '0',
        );
      },
      { edgeMigrationDirectory: old },
    );
  } finally {
    await rm(old, { recursive: true, force: true });
  }
});
