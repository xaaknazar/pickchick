import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withSyncDatabases, running } from '../helpers/sync.mjs';
import { applyMenu, publishMenu } from '@pickchick/menu-sync';
import { provisionStaff, setStaffPin, setOrdering } from '@pickchick/local-orders';
import { provisionFulfillment, grantStation } from '@pickchick/edge-fulfillment';
import { createEdge } from '@pickchick/edge';
import { createPosServer } from '../../apps/pos/server.mjs';
const auth = (c) => ({ sessionId: c.session_id, token: c.token });
test('designer POS: real PIN, shared shifts, held order, WAN isolation, lost response recovery, kitchen and display', async () => {
  await withSyncDatabases(async (ctx) => {
    const categories = {};
    const categoryIds = new Map();
    const productData = JSON.parse(
      await readFile('infra/windows/local-pos-draft-catalog-v2.json', 'utf8'),
    ).products;
    const items = productData.map((p) => {
      if (!categoryIds.has(p.category)) {
        const id = randomUUID();
        categoryIds.set(p.category, id);
        categories[id] = p.category;
      }
      return {
        product_id: randomUUID(),
        variant_id: randomUUID(),
        category_id: categoryIds.get(p.category),
        name: { ru: p.name_ru, kk: p.name_ru },
        currency: 'KZT',
        price_minor: p.price_minor,
        image_url: p.image_url,
        modifier_groups: p.modifier_groups.map((g) => ({
          id: randomUUID(),
          name: { ru: g.name_ru, kk: g.name_ru },
          min_selected: g.min_selected,
          max_selected: g.max_selected,
          options: g.options.map((o) => ({
            id: randomUUID(),
            name: { ru: o.name_ru, kk: o.name_ru },
            price_minor: o.price_minor,
            max_quantity: o.max_quantity,
            default_quantity: o.default_quantity,
            available: o.available,
          })),
        })),
      };
    });
    const menu = {
      schema_version: 1,
      release_id: randomUUID(),
      branch_id: ctx.branch,
      version: 1,
      published_at: new Date().toISOString(),
      items,
    };
    await applyMenu(
      ctx.edge.pool,
      ctx.branch,
      await publishMenu(ctx.cloud.pool, JSON.parse(JSON.stringify(menu))),
    );
    const terminal = randomUUID();
    const manager = await provisionStaff(ctx.edge.pool, ctx.branch, {
      staff_id: randomUUID(),
      terminal_id: terminal,
      name: 'Тестовый начальник',
      role: 'shift_manager',
    });
    const cashier = await provisionStaff(ctx.edge.pool, ctx.branch, {
      staff_id: randomUUID(),
      terminal_id: terminal,
      name: 'Тестовый кассир',
      role: 'cashier',
    });
    await setOrdering(ctx.edge.pool, ctx.branch, auth(manager), randomUUID(), true, {
      expected_version: 1,
    });
    await setStaffPin(ctx.edge.pool, ctx.branch, auth(manager), '2468');
    await setStaffPin(ctx.edge.pool, ctx.branch, auth(cashier), '1357');
    const prep = randomUUID(),
      assembly = randomUUID();
    await provisionFulfillment(ctx.edge.pool, {
      branchId: ctx.branch,
      organizationId: ctx.org,
      deviceId: ctx.device,
      producerId: randomUUID(),
      stations: [
        { id: prep, kind: 'prep', name: 'Кухня' },
        { id: assembly, kind: 'assembly', name: 'Сборка' },
      ],
      routing: {
        version: 1,
        assemblyStationId: assembly,
        routes: items.map((i) => ({ productId: i.product_id, stationId: prep, kind: 'prep' })),
      },
    });
    const cook = await provisionStaff(ctx.edge.pool, ctx.branch, {
      staff_id: randomUUID(),
      terminal_id: randomUUID(),
      name: 'Тестовая кухня',
      role: 'kitchen',
    });
    await grantStation(ctx.edge.pool, ctx.branch, cook.staff_id, prep);
    await grantStation(ctx.edge.pool, ctx.branch, cook.staff_id, assembly);
    await ctx.edge.pool.query("UPDATE branch_config SET pos_service_mode='unpaid_service'");
    const edge = await running(createEdge, {
      ...ctx.edge.config,
      edgeFulfillmentEnabled: true,
      edgeDeviceId: ctx.device,
    });
    const port = Number(new URL(edge.url).port);

    const pos = createPosServer({
      edgePort: port,
      branchLabel: 'Абая 62',
      categories,
      terminalId: terminal,
    });
    await new Promise((r) => pos.listen(0, '127.0.0.1', r));
    const output = new URL('../../.local/pos-browser-v2/', import.meta.url);
    await mkdir(output, { recursive: true, mode: 0o700 });
    const temp = await mkdtemp(fileURLToPath(new URL('run-', output)));
    try {
      const file = temp + '/fixture.json';
      await writeFile(
        file,
        JSON.stringify({
          url: `http://127.0.0.1:${pos.address().port}`,
          edgeUrl: edge.url,
          prep,
          assembly,
          cook,
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
        child.stdout.on('data', (d) => process.stdout.write(d));
        child.stderr.on('data', (d) => process.stderr.write(d));
        child.on('error', reject);
        child.on('exit', resolve);
      });
      assert.equal(exit, 0, 'Browser scenarios must pass');
      const orders = (
        await ctx.edge.pool.query(
          'SELECT state,payment_state,fiscal_state,execution_mode FROM local_orders',
        )
      ).rows;
      assert.equal(orders.length, 1);
      assert.equal(orders[0].state, 'awaiting_payment');
      assert.equal(orders[0].payment_state, 'not_started');
      assert.equal(orders[0].fiscal_state, 'not_requested');
      assert.equal(orders[0].execution_mode, 'unpaid_service');
      assert.equal(
        (await ctx.edge.pool.query('SELECT state FROM fulfillment_reservations')).rows[0].state,
        'handed_over',
      );
      assert.equal(
        (await ctx.edge.pool.query('SELECT count(*) FROM local_cash_movements')).rows[0].count,
        '1',
      );
      assert.deepEqual(
        (
          await ctx.edge.pool.query(
            'SELECT state,discrepancy_minor,closing_reason FROM local_cash_shifts',
          )
        ).rows,
        [{ state: 'closed', discrepancy_minor: '-1000000', closing_reason: 'Тест' }],
      );
    } finally {
      await new Promise((r) => pos.close(r));
      await edge.app.close();
      await rm(temp, { recursive: true, force: true });
    }
  });
});
