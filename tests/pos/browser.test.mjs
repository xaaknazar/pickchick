import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createEdge } from '@pickchick/edge';
import { applyMenu, publishMenu } from '@pickchick/menu-sync';
import { withOrderDesk } from '../helpers/orders.mjs';
import { running } from '../helpers/sync.mjs';
import { createPosServer } from '../../apps/pos/server.mjs';

test('browser POS uses real temporary PostgreSQL + staff API, restores lost create and fixed controls', async () => {
  await withOrderDesk(async (ctx) => {
    const categories = [randomUUID(), randomUUID(), randomUUID()];
    const menu = {
      ...ctx.menu(2),
      items: Array.from({ length: 14 }, (_, i) => ({
        ...ctx.release.items[0],
        product_id: randomUUID(),
        variant_id: randomUUID(),
        category_id: categories[i % 3],
        name: {
          ru:
            i === 0
              ? 'Тестовая порция с длинным названием для проверки кассы'
              : `Синтетическая порция ${String(i + 1).padStart(2, '0')}`,
          kk: `Сынақ порциясы ${i + 1}`,
        },
      })),
    };
    await applyMenu(ctx.edge.pool, ctx.branch, await publishMenu(ctx.cloud.pool, menu));
    const edge = await running(createEdge, ctx.edge.config);
    const proxy = createPosServer({
      edgePort: Number(new URL(edge.url).port),
      branchLabel: 'Синтетическая точка · UI-проверка',
      categories: Object.fromEntries(categories.map((id, i) => [id, `Группа ${i + 1}`])),
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const output = new URL('../../.local/pos-browser/', import.meta.url);
    await mkdir(output, { recursive: true, mode: 0o700 });
    const temp = await mkdtemp(fileURLToPath(new URL('run-', output)));
    const file = `${temp}/fixture.json`;
    try {
      await writeFile(
        file,
        JSON.stringify({
          url: `http://127.0.0.1:${proxy.address().port}`,
          cashier: ctx.cashier,
          manager: ctx.manager,
          variant: menu.items[0].variant_id,
          category: menu.items[0].category_id,
          output: fileURLToPath(output),
        }),
        { mode: 0o600 },
      );
      const exit = await new Promise((resolve, reject) => {
        const child = spawn(
          process.env.POS_TEST_PYTHON ?? 'python3',
          [fileURLToPath(new URL('browser_ui.py', import.meta.url)), file],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        child.stdout.on('data', (data) => process.stdout.write(data));
        child.stderr.on('data', (data) => process.stderr.write(data));
        child.on('error', reject);
        child.on('exit', resolve);
      });
      assert.equal(exit, 0, 'Browser flow must pass');
      const orders = (
        await ctx.edge.pool.query('SELECT state,payment_state,fulfillment_state FROM local_orders')
      ).rows;
      assert.equal(orders.length, 2);
      for (const order of orders) {
        assert.equal(order.state, 'cancelled');
        assert.equal(order.payment_state, 'not_started');
        assert.equal(order.fulfillment_state, 'blocked');
      }
      assert.equal(
        (
          await ctx.edge.pool.query(
            "SELECT count(*) FROM outbox_events WHERE event_type='order.created'",
          )
        ).rows[0].count,
        '2',
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
      await new Promise((resolve) => proxy.close(resolve));
      await edge.app.close();
    }
  });
});
