import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrate } from '@pickchick/database';
import { TestOrderFlow, TEST_BRANCH_ID, provisionTestActor } from '@pickchick/test-order-flow';
import { withSyncDatabases } from '../helpers/sync.mjs';

const directory = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));
const config = { enabled: true, environment: 'test' };
test('020 to 021 preserves issued numbers and order history, continues current counter and applies once', async () => {
  const old = await mkdtemp(join(tmpdir(), 'pickchick-service-shift-'));
  try {
    for (const name of await readdir(directory))
      if (name.endsWith('.sql') && name < '021')
        await copyFile(join(directory, name), join(old, name));
    await withSyncDatabases(
      async (ctx) => {
        const pool = ctx.cloud.pool;
        await pool.query(
          "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'TEST-ALMATY-01','Shift migration fixture')",
          [TEST_BRANCH_ID, ctx.org, ctx.legal],
        );
        const flow = new TestOrderFlow(pool, config);
        const actor = await flow.issueSession({ channel: 'mobile' });
        const manager = await provisionTestActor(pool, config, 'manager');
        const insert = async (offset) => {
          const quote = await flow.quote(actor.token, randomUUID(), {
            catalog_version: 'mockup-v0.2',
            service_mode: 'takeaway',
            items: [{ product_id: 'cola', quantity: 1 }],
          });
          const id = randomUUID();
          await pool.query(
            "INSERT INTO test_orders(id,actor_id,branch_id,quote_id,snapshot,total_minor,created_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+($7 * interval '1 day'))",
            [
              id,
              actor.session_id,
              TEST_BRANCH_ID,
              quote.quote_id,
              quote,
              quote.total_minor,
              offset,
            ],
          );
          return id;
        };
        const yesterday = await insert(-1);
        const today = await insert(0);
        await insert(0);
        const tables = [
          'test_orders',
          'test_quotes',
          'test_actors',
          'test_order_day_counters',
          'test_command_results',
          'test_outbox',
        ];
        const read = async (table) =>
          (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`))
            .rows;
        const before = new Map();
        for (const table of tables) before.set(table, await read(table));
        const numbers = (
          await pool.query(
            'SELECT order_id,branch_id,business_date,number FROM test_order_numbers ORDER BY order_id',
          )
        ).rows;
        // Keep this historical upgrade pinned to 021; later auth migrations have their own checks.
        await copyFile(
          join(directory, '021_cloud_test_service_shifts.sql'),
          join(old, '021_cloud_test_service_shifts.sql'),
        );
        assert.deepEqual(await migrate(pool, old, 'cloud'), ['021_cloud_test_service_shifts.sql']);
        assert.deepEqual(await migrate(pool, old, 'cloud'), []);
        for (const table of tables) assert.deepEqual(await read(table), before.get(table), table);
        assert.deepEqual(
          (
            await pool.query(
              'SELECT order_id,branch_id,business_date,number FROM test_order_numbers ORDER BY order_id',
            )
          ).rows,
          numbers,
        );
        assert.equal(
          (await flow.dailyNumbers(await flow.readOrder(actor.token, yesterday))).number,
          '1',
        );
        assert.equal(
          (await flow.dailyNumbers(await flow.readOrder(actor.token, today))).number,
          '1',
        );
        assert.equal(
          (await flow.dailyNumbers(await flow.readOrder(actor.token, await insert(0)))).number,
          '3',
        );
        const shift = (await flow.currentShift(manager.token)).shift;
        const closed = await flow.changeShift(manager.token, randomUUID(), 'close', {
          previous_shift_id: shift.shift_id,
          expected_version: shift.version,
        });
        await flow.changeShift(manager.token, randomUUID(), 'open', {
          previous_shift_id: closed.shift.shift_id,
          expected_version: closed.shift.version,
        });
        assert.equal(
          (await flow.dailyNumbers(await flow.readOrder(actor.token, await insert(0)))).number,
          '1',
        );
      },
      { cloudMigrationDirectory: old },
    );
  } finally {
    await rm(old, { recursive: true, force: true });
  }
});
