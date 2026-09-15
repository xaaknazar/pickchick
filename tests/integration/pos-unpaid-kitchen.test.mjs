import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool } from '@pickchick/database';
import { createEdge } from '@pickchick/edge';
import { applyMenu, publishMenu } from '@pickchick/menu-sync';
import {
  createQuote,
  createLocalOrder,
  cancelLocalOrder,
  readLocalOrder,
  readCashShift,
  provisionStaff,
} from '@pickchick/local-orders';
import {
  provisionFulfillment,
  grantStation,
  EdgeFulfillment,
  localUnpaidExecution,
} from '@pickchick/edge-fulfillment';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';
import { withOrderDesk, staffAuth, staffHeaders } from '../helpers/orders.mjs';
import { running, request } from '../helpers/sync.mjs';

const code = (expected) => (error) => error.code === expected;
async function setup(ctx, { enable = true, missingRoute = false } = {}) {
  const prep = randomUUID(),
    assembly = randomUUID(),
    producerId = randomUUID();
  const scope = { organizationId: ctx.org, branchId: ctx.branch, deviceId: ctx.device, producerId };
  await provisionFulfillment(ctx.edge.pool, {
    ...scope,
    stations: [
      { id: prep, kind: 'prep', name: 'Synthetic prep' },
      { id: assembly, kind: 'assembly', name: 'Synthetic assembly' },
    ],
    routing: {
      version: 1,
      assemblyStationId: assembly,
      routes: [
        {
          productId: missingRoute ? randomUUID() : ctx.release.items[0].product_id,
          stationId: prep,
          kind: 'prep',
        },
      ],
    },
  });
  const cook = await provisionStaff(ctx.edge.pool, ctx.branch, ctx.setup('kitchen'));
  await grantStation(ctx.edge.pool, ctx.branch, cook.staff_id, prep);
  await grantStation(ctx.edge.pool, ctx.branch, cook.staff_id, assembly);
  if (enable)
    await ctx.edge.pool.query(
      "UPDATE branch_config SET pos_service_mode='unpaid_service' WHERE id=$1",
      [ctx.branch],
    );
  return {
    ...ctx,
    prep,
    assembly,
    scope,
    cook,
    repo: new EdgeFulfillment(ctx.edge.pool),
    port: localUnpaidExecution({ enabled: true, deviceId: ctx.device }),
  };
}
const quote = (ctx) => createQuote(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), ctx.cart);
const create = (ctx, q, key = randomUUID(), port = ctx.port) =>
  createLocalOrder(
    ctx.edge.pool,
    ctx.branch,
    staffAuth(ctx.cashier),
    key,
    { quote_id: q.quote_id, kitchen_admission: 'unpaid' },
    port,
  );
const cancel = (ctx, order, key = randomUUID()) =>
  cancelLocalOrder(
    ctx.edge.pool,
    ctx.branch,
    staffAuth(ctx.cashier),
    key,
    order.order_id,
    { expected_version: 1, reason: 'Synthetic queued cancellation' },
    ctx.port,
  );
const read = (ctx, order) =>
  readLocalOrder(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), order.order_id);
const kitchenRead = (ctx, order) =>
  ctx.repo.readOrder(ctx.branch, staffAuth(ctx.cook), order.order_id, { stationId: ctx.prep });
const act = (ctx, order, action, extra = {}) =>
  ctx.repo.act(ctx.branch, staffAuth(ctx.cook), {
    commandId: randomUUID(),
    orderId: order.orderId,
    expectedVersion: order.version,
    action,
    ...extra,
  });

test('one durable unpaid order reaches real HTTP kitchen and handoff without payment/fiscal effects', async () => {
  await withOrderDesk(async (base) => {
    const ctx = await setup(base);
    const group = randomUUID(),
      option = randomUUID(),
      release = globalThis.structuredClone(ctx.menu(2));
    release.items[0].modifier_groups = [
      {
        id: group,
        name: { ru: 'Соус', kk: 'Соус' },
        min_selected: 1,
        max_selected: 3,
        options: [
          {
            id: option,
            name: { ru: 'Сырный', kk: 'Ірімшік' },
            price_minor: '100',
            max_quantity: 3,
          },
        ],
      },
    ];
    await applyMenu(ctx.edge.pool, ctx.branch, await publishMenu(ctx.cloud.pool, release));
    ctx.cart = {
      ...ctx.cart,
      release_id: release.release_id,
      items: [
        {
          variant_id: release.items[0].variant_id,
          quantity: 2,
          modifiers: [{ group_id: group, option_id: option, quantity: 3 }],
        },
      ],
    };
    const server = await running(createEdge, {
      ...ctx.edge.config,
      edgeFulfillmentEnabled: true,
      edgeDeviceId: ctx.device,
    });
    try {
      const post = async (path, body, key = randomUUID()) =>
        request(server.url + '/edge/v1/' + path, {
          method: 'POST',
          headers: staffHeaders(ctx.cashier, key),
          body: JSON.stringify(body),
        });
      const quoted = await post('checkout/quotes', ctx.cart);
      assert.equal(quoted.status, 201);
      const q = await quoted.json(),
        key = randomUUID(),
        body = { quote_id: q.quote_id, kitchen_admission: 'unpaid' };
      const responses = await Promise.all([post('orders', body, key), post('orders', body, key)]);
      assert.deepEqual(
        responses.map((r) => r.status),
        [201, 201],
      );
      const [order, replay] = await Promise.all(responses.map((r) => r.json()));
      assert.deepEqual(order, replay);
      assert.equal(order.execution_mode, 'unpaid_service');
      assert.equal(order.fulfillment_state, 'accepted');
      assert.equal(order.payment_state, 'not_started');
      assert.equal(order.fiscal_state, 'not_requested');
      assert.equal(order.state, 'awaiting_payment');
      assert.equal(order.next_action, 'none');
      assert.match(order.fulfillment.display_number, /^[1-9][0-9]*$/);
      const kitchen = await request(
        server.url + '/edge/v1/fulfillment/kitchen?stationId=' + ctx.prep,
        { headers: { ...staffHeaders(ctx.cook), 'X-Terminal-Id': ctx.cook.terminal_id } },
      );
      assert.equal(kitchen.status, 200);
      const page = await kitchen.json();
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0].channel, 'pos');
      assert.equal(page.items[0].tasks[0].details.quantity, 2);
      assert.equal(page.items[0].tasks[0].details.modifiers[0].quantity, 3);
      assert.equal(page.items[0].tasks[0].details.modifiers[0].label.ru, 'Сырный');
      let current = await kitchenRead(ctx, order);
      const task = current.tasks[0];
      await assert.rejects(act(ctx, current, 'ready'), code('NOT_READY'));
      current = await act(ctx, current, 'start_task', {
        taskId: task.id,
        expectedTaskVersion: task.version,
      });
      await assert.rejects(cancel(ctx, order), code('ORDER_IN_PRODUCTION'));
      current = await act(ctx, current, 'complete_task', {
        taskId: task.id,
        expectedTaskVersion: task.version + 1,
      });
      current = await act(ctx, current, 'ready');
      current = await act(ctx, current, 'handoff');
      const refreshed = await request(server.url + '/edge/v1/orders/' + order.order_id, {
        headers: staffHeaders(ctx.cashier),
      });
      assert.equal(refreshed.status, 200);
      const live = await refreshed.json();
      assert.equal(live.fulfillment.state, 'handed_over');
      assert.equal(live.fulfillment.version, current.version);
      assert.equal(live.version, 1);
      const feed = await request(server.url + '/edge/v1/orders', {
        headers: staffHeaders(ctx.cashier),
      });
      assert.equal((await feed.json()).orders[0].fulfillment_state, 'handed_over');
      const report = await readCashShift(
        ctx.edge.pool,
        ctx.branch,
        staffAuth(ctx.cashier),
        ctx.shift.shift_id,
      );
      assert.equal(report.order_count, 1);
      assert.equal(report.cash_received_minor, '0');
      assert.equal(report.unpaid_total_minor, q.total_minor);
      const events = (
        await ctx.edge.pool.query('SELECT * FROM fulfillment_outbox ORDER BY sequence')
      ).rows;
      assert.equal(events.length, 5);
      assert.ok(
        events.every(
          (e) =>
            e.payload.commercialOwner === 'edge_pos' &&
            e.payload.executionMode === 'unpaid_service',
        ),
      );
      const commercial = (
        await ctx.edge.pool.query(
          "SELECT payload FROM outbox_events WHERE event_type='order.created'",
        )
      ).rows;
      assert.equal(commercial.length, 1);
      assert.equal(commercial[0].payload.execution_mode, 'unpaid_service');
      assert.equal(commercial[0].payload.fulfillment_state, 'blocked');
      // Existing cloud transport cannot steal or ACK a local-origin kitchen event.
      assert.deepEqual(
        await ctx.repo.claimOutbox(ctx.scope, {
          workerId: randomUUID(),
          limit: 100,
          leaseSeconds: 30,
        }),
        [],
      );
      await assert.rejects(
        ctx.repo.acknowledgeOutbox(ctx.scope, {
          eventId: events[0].event_id,
          workerId: randomUUID(),
          leaseToken: randomUUID(),
        }),
        code('NOT_FOUND'),
      );
      await assert.rejects(
        ctx.repo.acceptCloud(ctx.scope, {
          eventId: randomUUID(),
          type: 'edge.fulfillment_cancel_requested',
          payload: {
            orderId: order.order_id,
            branchId: ctx.branch,
            reservationId: events[0].payload.reservationId,
            quoteDigest: events[0].payload.quoteDigest,
            owner: 'cloud',
            expectedVersion: current.version,
            reason: 'Wrong owner',
          },
        }),
        code('CONFLICT'),
      );
      assert.equal((await post('orders', body, key)).status, 201);
      assert.equal((await read(ctx, order)).fulfillment.state, 'handed_over');
    } finally {
      await server.app.close();
    }
  });
});

test('mode, routing, host, scope and shift guards reject admission without partial orders/tasks', async () => {
  await withOrderDesk(async (base) => {
    const ctx = await setup(base, { enable: false, missingRoute: true }),
      q = await quote(ctx);
    await assert.rejects(create(ctx, q), code('SERVICE_MODE_DISABLED'));
    await ctx.edge.pool.query("UPDATE branch_config SET pos_service_mode='unpaid_service'");
    await assert.rejects(create(ctx, q), code('KITCHEN_UNAVAILABLE'));
    await assert.rejects(
      create(ctx, q, randomUUID(), localUnpaidExecution({ enabled: false, deviceId: ctx.device })),
      code('KITCHEN_UNAVAILABLE'),
    );
    await assert.rejects(
      create(ctx, q, randomUUID(), localUnpaidExecution({ enabled: true, deviceId: randomUUID() })),
      code('KITCHEN_UNAVAILABLE'),
    );
    await assert.rejects(
      createLocalOrder(
        ctx.edge.pool,
        ctx.branch,
        staffAuth(ctx.cashier),
        randomUUID(),
        { quote_id: q.quote_id },
        ctx.port,
      ),
      code('SERVICE_MODE_DISABLED'),
    );
    for (const table of [
      'local_orders',
      'fulfillment_reservations',
      'fulfillment_tasks',
      'fulfillment_outbox',
    ])
      assert.equal((await ctx.edge.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '0');
    const outsider = await provisionStaff(ctx.edge.pool, ctx.branch, ctx.setup('cashier'));
    await assert.rejects(
      createLocalOrder(
        ctx.edge.pool,
        ctx.branch,
        staffAuth(outsider),
        randomUUID(),
        { quote_id: q.quote_id, kitchen_admission: 'unpaid' },
        ctx.port,
      ),
      code('NOT_FOUND'),
    );
    await assert.rejects(
      createLocalOrder(
        ctx.edge.pool,
        ctx.branch,
        staffAuth(ctx.cook),
        randomUUID(),
        { quote_id: q.quote_id, kitchen_admission: 'unpaid' },
        ctx.port,
      ),
      code('FORBIDDEN'),
    );
    await ctx.edge.pool.query(
      "UPDATE local_cash_shifts SET state='closed',version=2,closed_at=clock_timestamp(),closed_by_staff_id=staff_id,counted_cash_minor=0,discrepancy_minor=0,closing_reason='Synthetic',closed_report='{}'",
    );
    await assert.rejects(create(ctx, q), code('CASH_SHIFT_REQUIRED'));
  });
});

test('queued cancellation is atomic/idempotent; kitchen start race never leaves cancelled food in progress', async () => {
  await withOrderDesk(async (base) => {
    const ctx = await setup(base),
      order = await create(ctx, await quote(ctx)),
      key = randomUUID();
    const [a, b] = await Promise.all([cancel(ctx, order, key), cancel(ctx, order, key)]);
    assert.deepEqual(a, b);
    assert.equal(a.state, 'cancelled');
    assert.equal(a.fulfillment.state, 'cancelled');
    assert.equal((await ctx.repo.readDisplay(ctx.branch)).items.length, 0);
    const next = await create(ctx, await quote(ctx)),
      current = await kitchenRead(ctx, next),
      task = current.tasks[0];
    const results = await Promise.allSettled([
      cancel(ctx, next),
      act(ctx, current, 'start_task', { taskId: task.id, expectedTaskVersion: task.version }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(
      results
        .filter((r) => r.status === 'rejected')
        .every((r) => ['CONFLICT', 'ORDER_IN_PRODUCTION'].includes(r.reason.code)),
    );
    const final = await read(ctx, next),
      tasks = (
        await ctx.edge.pool.query('SELECT state FROM fulfillment_tasks WHERE order_id=$1', [
          next.order_id,
        ])
      ).rows;
    if (final.state === 'cancelled') assert.ok(tasks.every((t) => t.state === 'cancelled'));
    else {
      assert.equal(final.fulfillment.state, 'in_production');
      assert.equal(tasks[0].state, 'in_progress');
    }
  });
});

test('commercial outbox failure rolls back kitchen admission; DB prohibits missing admission and execution rewrites', async () => {
  await withOrderDesk(async (base) => {
    const ctx = await setup(base),
      q = await quote(ctx),
      key = randomUUID();
    await ctx.edge.pool
      .query(`CREATE FUNCTION fail_pos_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic fault'; END; $$;
      CREATE TRIGGER fail_pos BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_pos_outbox()`);
    await assert.rejects(create(ctx, q, key));
    for (const table of [
      'local_orders',
      'fulfillment_reservations',
      'fulfillment_tasks',
      'fulfillment_outbox',
    ])
      assert.equal((await ctx.edge.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '0');
    await ctx.edge.pool.query('DROP TRIGGER fail_pos ON outbox_events');
    await assert.rejects(
      ctx.edge.pool.query(
        "INSERT INTO local_orders(id,branch_id,quote_id,total_minor,cash_shift_id,execution_mode) VALUES($1,$2,$3,$4,$5,'unpaid_service')",
        [randomUUID(), ctx.branch, q.quote_id, q.total_minor, ctx.shift.shift_id],
      ),
      code('23514'),
    );
    const order = await create(ctx, q, key);
    await assert.rejects(
      ctx.edge.pool.query("UPDATE local_orders SET execution_mode='payment_required' WHERE id=$1", [
        order.order_id,
      ]),
      code('23514'),
    );
    await assert.rejects(
      ctx.edge.pool.query("UPDATE local_orders SET payment_state='paid' WHERE id=$1", [
        order.order_id,
      ]),
    );
    await assert.rejects(
      ctx.edge.pool.query(
        "UPDATE fulfillment_reservations SET commercial_owner='cloud',admission_kind='cloud_authorized' WHERE order_id=$1",
        [order.order_id],
      ),
      code('23514'),
    );
  });
});

test('restricted real LOGIN can admit and cancel but cannot enable unpaid mode or alter owners/routing', async () => {
  await withOrderDesk(async (base) => {
    const ctx = await setup(base),
      role = 'pos_unpaid_' + randomUUID().replaceAll('-', ''),
      password = randomBytes(32).toString('hex');
    let pool;
    try {
      await ctx.edge.admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
      await applyEdgeRuntimeGrants(ctx.edge.pool, role, {
        schema: ctx.edge.schema,
        fulfillment: true,
      });
      const url = new URL(ctx.edge.config.databaseUrl);
      url.username = role;
      url.password = password;
      pool = createPool(url.toString());
      const restricted = { ...ctx, edge: { ...ctx.edge, pool } };
      const order = await create(restricted, await quote(restricted));
      assert.equal(order.fulfillment.state, 'accepted');
      assert.equal((await cancel(restricted, order)).fulfillment.state, 'cancelled');
      for (const sql of [
        "UPDATE branch_config SET pos_service_mode='payment_required'",
        'UPDATE local_orders SET execution_mode=execution_mode',
        'UPDATE fulfillment_reservations SET commercial_owner=commercial_owner',
        'UPDATE fulfillment_routing SET payload=payload',
        'DELETE FROM fulfillment_tasks',
        'UPDATE fulfillment_outbox SET acknowledged_at=clock_timestamp()',
      ])
        await assert.rejects(pool.query(sql), code('42501'));
    } finally {
      if (pool) await pool.end();
      await ctx.edge.admin.query(`DROP OWNED BY ${role}`);
      await ctx.edge.admin.query(`DROP ROLE ${role}`);
    }
  });
});
