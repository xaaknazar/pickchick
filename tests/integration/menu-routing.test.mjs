/* global structuredClone */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { applyMenu, publishMenu } from '@pickchick/menu-sync';
import { createQuote, createLocalOrder } from '@pickchick/local-orders';
import {
  provisionFulfillment,
  EdgeFulfillment,
  localUnpaidExecution,
  RoutingSchema,
  taskPlan,
  digest,
} from '@pickchick/edge-fulfillment';
import { withOrderDesk, staffAuth } from '../helpers/orders.mjs';

const text = (ru) => ({ ru, kk: ru });

/** Edge with unpaid POS service, two stations and routing v1 for the installed item only. */
async function kitchenDesk(run) {
  await withOrderDesk(async (base) => {
    const prep = randomUUID(),
      assembly = randomUUID(),
      producerId = randomUUID();
    const scope = {
      organizationId: base.org,
      branchId: base.branch,
      deviceId: base.device,
      producerId,
    };
    const installed = base.release.items[0];
    await provisionFulfillment(base.edge.pool, {
      ...scope,
      stations: [
        { id: prep, kind: 'prep', name: 'Synthetic prep' },
        { id: assembly, kind: 'assembly', name: 'Synthetic assembly' },
      ],
      routing: {
        version: 1,
        assemblyStationId: assembly,
        routes: [{ productId: installed.product_id, stationId: prep, kind: 'prep' }],
      },
    });
    await base.edge.pool.query(
      "UPDATE branch_config SET pos_service_mode='unpaid_service' WHERE id=$1",
      [base.branch],
    );
    const port = localUnpaidExecution({ enabled: true, deviceId: base.device });
    const order = async (release, variantId) => {
      const quote = await createQuote(base.edge.pool, base.branch, staffAuth(base.cashier), {
        release_id: release.release_id,
        service_mode: 'takeaway',
        items: [{ variant_id: variantId, quantity: 1 }],
      });
      return createLocalOrder(
        base.edge.pool,
        base.branch,
        staffAuth(base.cashier),
        randomUUID(),
        { quote_id: quote.quote_id, kitchen_admission: 'unpaid' },
        port,
      );
    };
    const routing = async () => {
      const config = (
        await base.edge.pool.query('SELECT active_routing_version FROM fulfillment_config')
      ).rows[0];
      const row = (
        await base.edge.pool.query(
          'SELECT payload, payload_hash FROM fulfillment_routing WHERE version=$1',
          [config.active_routing_version],
        )
      ).rows[0];
      return { version: config.active_routing_version, ...row };
    };
    await run({
      ...base,
      prep,
      assembly,
      scope,
      installed,
      port,
      order,
      routing,
      repo: new EdgeFulfillment(base.edge.pool),
    });
  });
}

/** Unified publication: the installed item gains a slug; a new item and an unexpanded combo. */
function unifiedMenu(ctx, version) {
  const release = structuredClone(ctx.menu(version));
  const category = release.items[0].category_id;
  release.items[0] = {
    ...release.items[0],
    source_id: 'installed-item',
    kind: 'item',
    kitchen: { route: 'prep' },
  };
  release.items.push(
    {
      product_id: randomUUID(),
      variant_id: randomUUID(),
      category_id: category,
      name: text('Новый ролл'),
      price_minor: '199000',
      currency: 'KZT',
      source_id: 'new-wrap',
      kind: 'item',
      kitchen: { route: 'prep' },
    },
    {
      product_id: randomUUID(),
      variant_id: randomUUID(),
      category_id: category,
      name: text('Новый бокс'),
      price_minor: '499000',
      currency: 'KZT',
      source_id: 'new-box',
      kind: 'combo',
      kitchen: { route: 'assembly_item', unexpanded_combo: 'whole_product' },
    },
  );
  return release;
}

function cloudAdmission(ctx, line) {
  const snapshot = {
    organizationId: ctx.org,
    branchId: ctx.branch,
    channel: 'mobile',
    serviceMode: 'takeaway',
    currency: 'KZT',
    totalMinor: '199000',
    lines: [
      {
        lineId: randomUUID(),
        title: 'Synthetic line',
        description: '',
        quantity: 1,
        ...line,
      },
    ],
  };
  return {
    eventId: randomUUID(),
    type: 'edge.admission_requested',
    payload: {
      orderId: randomUUID(),
      branchId: ctx.branch,
      quoteId: randomUUID(),
      quoteDigest: digest(snapshot),
      snapshot,
      owner: 'cloud',
    },
  };
}

test('a publication with new products activates routing v+1 for hashed and slug ids atomically', async () => {
  await kitchenDesk(async (ctx) => {
    const before = await ctx.order(ctx.release, ctx.installed.variant_id);
    assert.equal(before.fulfillment_state, 'accepted');
    const next = unifiedMenu(ctx, 2);
    const fresh = next.items[1];
    // Before the publication the new product cannot reach the kitchen on either path.
    await assert.rejects(
      ctx.repo.acceptCloud(ctx.scope, cloudAdmission(ctx, { productId: 'new-wrap' })),
      (error) => error.code === 'ROUTING_MISSING',
    );
    const ack = await applyMenu(ctx.edge.pool, ctx.branch, await publishMenu(ctx.cloud.pool, next));
    assert.equal(ack.result, undefined);
    const routing = await ctx.routing();
    assert.equal(routing.version, 2);
    const parsed = RoutingSchema.parse(routing.payload);
    assert.equal(digest(parsed), routing.payload_hash);
    const routes = new Map(parsed.routes.map((route) => [route.productId, route]));
    assert.deepEqual(routes.get(ctx.installed.product_id), {
      productId: ctx.installed.product_id,
      stationId: ctx.prep,
      kind: 'prep',
    });
    assert.equal(routes.get('installed-item').stationId, ctx.prep);
    for (const key of [fresh.product_id, 'new-wrap']) {
      assert.equal(routes.get(key).stationId, ctx.prep);
      assert.equal(routes.get(key).kind, 'prep');
    }
    for (const key of [next.items[2].product_id, 'new-box']) {
      assert.equal(routes.get(key).stationId, ctx.assembly);
      assert.equal(routes.get(key).kind, 'assembly_item');
      assert.equal(routes.get(key).unexpandedCombo, 'whole_product');
    }
    // Real planner: a synthetic POS line and a synthetic cloud line for every item.
    for (const item of next.items) {
      const base = { organizationId: ctx.org, branchId: ctx.branch, serviceMode: 'takeaway' };
      const line = (productId, kind) => ({
        lineId: randomUUID(),
        productId,
        title: item.name.ru,
        description: '',
        quantity: 1,
        selectedDetails: { kind, modifiers: [], components: [] },
      });
      const common = { ...base, currency: 'KZT', totalMinor: item.price_minor };
      assert.ok(
        taskPlan({ ...common, channel: 'pos', lines: [line(item.product_id, 'item')] }, parsed)
          .length,
      );
      assert.ok(
        taskPlan({ ...common, channel: 'mobile', lines: [line(item.source_id, item.kind)] }, parsed)
          .length,
      );
    }
    const result = (
      await ctx.edge.pool.query(
        'SELECT result, routing_version FROM menu_apply_results WHERE release_id=$1',
        [next.release_id],
      )
    ).rows;
    assert.deepEqual(result, [{ result: 'applied', routing_version: 2 }]);
    // POS unpaid admission of the new hashed product and cloud admissions by slug now succeed.
    const created = await ctx.order(next, fresh.variant_id);
    assert.equal(created.fulfillment_state, 'accepted');
    const wrap = await ctx.repo.acceptCloud(
      ctx.scope,
      cloudAdmission(ctx, { productId: 'new-wrap' }),
    );
    assert.equal(wrap.routingVersion, 2);
    const box = await ctx.repo.acceptCloud(
      ctx.scope,
      cloudAdmission(ctx, {
        productId: 'new-box',
        selectedDetails: { kind: 'combo', modifiers: [], components: [] },
      }),
    );
    assert.equal(box.routingVersion, 2);
    const pinned = (
      await ctx.edge.pool.query(
        'SELECT order_id, routing_version FROM fulfillment_reservations ORDER BY routing_version',
      )
    ).rows;
    assert.deepEqual(
      pinned.map((row) => row.routing_version),
      [1, 2, 2, 2],
    );
    assert.equal(pinned[0].order_id, before.order_id);
    const tasks = (
      await ctx.edge.pool.query('SELECT routing_version FROM fulfillment_tasks WHERE order_id=$1', [
        before.order_id,
      ])
    ).rows;
    assert.ok(tasks.length && tasks.every((task) => task.routing_version === 1));
  });
});

test('a price-only publication keeps the routing version; a rejected one never changes routing', async () => {
  await kitchenDesk(async (ctx) => {
    const second = unifiedMenu(ctx, 2);
    await applyMenu(ctx.edge.pool, ctx.branch, await publishMenu(ctx.cloud.pool, second));
    const routing = await ctx.routing();
    const third = structuredClone(second);
    third.release_id = randomUUID();
    third.version = 3;
    third.items[1].price_minor = '209000';
    const applied = await applyMenu(
      ctx.edge.pool,
      ctx.branch,
      await publishMenu(ctx.cloud.pool, third),
    );
    assert.equal(applied.result, undefined);
    assert.deepEqual(await ctx.routing(), routing);
    assert.equal(
      (await ctx.edge.pool.query('SELECT count(*)::int n FROM fulfillment_routing')).rows[0].n,
      2,
    );
    // A new product without the published kitchen field and without an existing route.
    const fourth = structuredClone(third);
    fourth.release_id = randomUUID();
    fourth.version = 4;
    fourth.items.push({
      product_id: randomUUID(),
      variant_id: randomUUID(),
      category_id: fourth.items[0].category_id,
      name: text('Без маршрута'),
      price_minor: '100000',
      currency: 'KZT',
      source_id: 'unrouted',
    });
    const rejected = await applyMenu(
      ctx.edge.pool,
      ctx.branch,
      await publishMenu(ctx.cloud.pool, fourth),
    );
    assert.equal(rejected.result, 'rejected');
    assert.equal(rejected.reason, 'ROUTING_UNRESOLVED');
    assert.deepEqual(await ctx.routing(), routing);
    assert.equal(
      (await ctx.edge.pool.query('SELECT release_id FROM active_menu')).rows[0].release_id,
      third.release_id,
    );
    assert.equal(
      (await ctx.edge.pool.query('SELECT last_sequence FROM menu_sync_state')).rows[0]
        .last_sequence,
      '4',
    );
    // A second prep station makes a new prep route ambiguous: rejected, never guessed.
    await ctx.edge.pool.query(
      "INSERT INTO fulfillment_stations(branch_id,id,kind,name) VALUES($1,$2,'prep','Second prep')",
      [ctx.branch, randomUUID()],
    );
    const fifth = structuredClone(third);
    fifth.release_id = randomUUID();
    fifth.version = 5;
    fifth.items.push({
      ...fourth.items.at(-1),
      variant_id: randomUUID(),
      kitchen: { route: 'prep' },
    });
    const ambiguous = await applyMenu(
      ctx.edge.pool,
      ctx.branch,
      await publishMenu(ctx.cloud.pool, fifth),
    );
    assert.equal(ambiguous.reason, 'ROUTING_UNRESOLVED');
    assert.deepEqual(await ctx.routing(), routing);
    // An assembly-only addition still resolves with two prep stations.
    const sixth = structuredClone(fifth);
    sixth.release_id = randomUUID();
    sixth.version = 6;
    sixth.items.at(-1).kitchen = { route: 'assembly_item' };
    const resolved = await applyMenu(
      ctx.edge.pool,
      ctx.branch,
      await publishMenu(ctx.cloud.pool, sixth),
    );
    assert.equal(resolved.result, undefined);
    const latest = await ctx.routing();
    assert.equal(latest.version, routing.version + 1);
    assert.equal(
      RoutingSchema.parse(latest.payload).routes.find((route) => route.productId === 'unrouted')
        .stationId,
      ctx.assembly,
    );
    assert.deepEqual(
      (
        await ctx.edge.pool.query(
          'SELECT version, result, reason, routing_version FROM menu_apply_results ORDER BY version',
        )
      ).rows,
      [
        { version: 1, result: 'applied', reason: null, routing_version: null },
        { version: 2, result: 'applied', reason: null, routing_version: 2 },
        { version: 3, result: 'applied', reason: null, routing_version: 2 },
        { version: 4, result: 'rejected', reason: 'ROUTING_UNRESOLVED', routing_version: null },
        { version: 5, result: 'rejected', reason: 'ROUTING_UNRESOLVED', routing_version: null },
        { version: 6, result: 'applied', reason: null, routing_version: 3 },
      ],
    );
  });
});

test('legacy snapshots without kitchen fields leave operator routing untouched', async () => {
  await kitchenDesk(async (ctx) => {
    const routing = await ctx.routing();
    const next = structuredClone(ctx.menu(2));
    next.items.push({
      ...next.items[0],
      product_id: randomUUID(),
      variant_id: randomUUID(),
    });
    const ack = await applyMenu(ctx.edge.pool, ctx.branch, await publishMenu(ctx.cloud.pool, next));
    assert.equal(ack.result, undefined);
    assert.deepEqual(await ctx.routing(), routing);
  });
});
