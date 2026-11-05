// Cutover lane kds, KDS-2 over HTTP (contracts section 5.4): GET fulfillment/layout and
// GET fulfillment/kds/breading, the KDS keys of the kitchen API only while the layout is on, and
// the guest board without aggregator orders and without new keys.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  ErrorSchema,
  FulfillmentDisplaySchema,
  FulfillmentKitchenSchema,
  FulfillmentLayoutSchema,
  FulfillmentOrderSchema,
  FulfillmentSummarySchema,
  KdsBreadingSchema,
} from '@pickchick/contracts';
import { grantStation, kdsStationId } from '@pickchick/edge-fulfillment';
import { createEdge } from '../../services/edge/dist/index.js';
import { fixture } from '../../packages/edge-fulfillment/tests/fixture.mjs';
import {
  cashierDesk,
  kdsTestLayout,
  switchKdsLayout,
  writeKdsLayout,
} from '../../packages/edge-fulfillment/tests/kds-fixture.mjs';

const prefix = '/edge/v1/fulfillment';
async function lan(ctx, run) {
  const app = await createEdge({
    service: 'edge',
    environment: 'test',
    databaseUrl: ctx.url,
    branchId: ctx.scope.branchId,
    edgeDeviceId: ctx.scope.deviceId,
    edgeFulfillmentEnabled: true,
    port: 0,
  });
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  try {
    await run(async (path, actor, body) => {
      const response = await fetch(url + prefix + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: 'Bearer ' + actor.token,
          'X-Staff-Session-Id': actor.session_id,
          'X-Terminal-Id': actor.terminal_id,
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, text: await response.text() };
    });
  } finally {
    await app.close();
  }
}
/** The body is exactly what the strict schema serialises (no extra or reordered key). */
const exact = (schema, response, status = 200) => {
  assert.equal(response.status, status, response.text);
  const parsed = schema.parse(JSON.parse(response.text));
  assert.equal(JSON.stringify(parsed), response.text);
  return parsed;
};
const errorOf = (response, status) => {
  assert.equal(response.status, status, response.text);
  return ErrorSchema.parse(JSON.parse(response.text)).code;
};

test('KDS HTTP: layout off answers {enabled:false}, breading 404, tickets without KDS keys', () =>
  fixture(async (ctx) => {
    const b = ctx.scope.branchId;
    await writeKdsLayout(ctx.pool, b, kdsTestLayout(b), { enable: false });
    await ctx.accepted(true);
    await lan(ctx, async (call) => {
      const layout = await call('/layout', ctx.packer);
      assert.equal(layout.status, 200);
      assert.equal(layout.text, '{"enabled":false}');
      assert.equal(errorOf(await call('/kds/breading', ctx.manager), 404), 'NOT_FOUND');
      const page = await call('/kitchen', ctx.manager);
      exact(FulfillmentKitchenSchema, page);
      for (const key of ['"kds"', '"delivery"', '"upstreamOf"'])
        assert.ok(!page.text.includes(key));
      assert.equal(errorOf(await call('/layout?x=1', ctx.packer), 400), 'INVALID_REQUEST');
      assert.equal(errorOf(await call('/layout', ctx.cashier), 403), 'FORBIDDEN');
    });
  }));

test('KDS HTTP: layout on - screens per terminal, KDS tickets, cascade, breading and the board', () =>
  fixture(async (ctx) => {
    const b = ctx.scope.branchId;
    const S = (fn) => kdsStationId(b, fn);
    const desk = await cashierDesk(ctx);
    await writeKdsLayout(
      ctx.pool,
      b,
      kdsTestLayout(b, {
        terminals: {
          assembly_hall: [ctx.packer.terminal_id],
          issue: [ctx.packer.terminal_id],
          breading: [ctx.cook.terminal_id],
          toasts: [ctx.cook.terminal_id],
        },
      }),
    );
    for (const fn of ['assembly_hall', 'issue', 'assembly_delivery', 'delivery_handover'])
      await grantStation(ctx.pool, b, ctx.packer.staff_id, S(fn));
    await grantStation(ctx.pool, b, ctx.cook.staff_id, S('toasts'));
    const { order } = await ctx.accepted(true);
    const hall = await desk.order({ comboQuantity: 0, burgers: 1 });
    const delivery = { provider: 'glovo', externalNumber: 'G-4567' };
    const agg = await desk.order({ delivery, burgers: 0 });
    await lan(ctx, async (call) => {
      const layout = exact(FulfillmentLayoutSchema, await call('/layout', ctx.packer));
      assert.deepEqual(layout.screens, [S('assembly_hall'), S('issue')]);
      assert.deepEqual(
        layout.stations.map((s) => s.function),
        ['breading', 'toasts', 'assembly_hall', 'assembly_delivery', 'issue', 'delivery_handover'],
      );
      assert.deepEqual(exact(FulfillmentLayoutSchema, await call('/layout', ctx.cook)).screens, [
        S('breading'),
        S('toasts'),
      ]);
      assert.deepEqual(
        exact(FulfillmentLayoutSchema, await call('/layout', ctx.manager)).screens,
        [],
      );

      // Table 1 sees the cloud combo and the cashier hall order with their KDS details.
      const table = exact(
        FulfillmentKitchenSchema,
        await call('/kitchen?stationId=' + S('assembly_hall'), ctx.packer),
      );
      assert.deepEqual(
        table.items.map((i) => i.orderId).sort(),
        [order.orderId, hall.order_id].sort(),
      );
      for (const item of table.items) {
        assert.equal(item.assemblyStationId, S('issue'));
        assert.ok(!('delivery' in item));
        assert.ok(item.tasks.every((t) => t.details.kds));
      }
      // Station 5 lists the toasts with upstreamOf; the courier counter (3) lists the delivery.
      const toasts = exact(
        FulfillmentKitchenSchema,
        await call('/kitchen?stationId=' + S('toasts'), ctx.cook),
      );
      assert.equal(toasts.items.length, 3);
      const counter = exact(
        FulfillmentKitchenSchema,
        await call('/kitchen?stationId=' + S('delivery_handover'), ctx.packer),
      );
      assert.deepEqual(
        counter.items.map((i) => [i.orderId, i.delivery, i.serviceMode]),
        [[agg.order_id, delivery, 'takeaway']],
      );
      const one = exact(FulfillmentOrderSchema, await call('/orders/' + agg.order_id, ctx.manager));
      assert.deepEqual(one.delivery, delivery);
      assert.deepEqual(one.tasks.map((t) => t.details.kds.function).sort(), [
        'assembly_delivery',
        'issue',
        'toasts',
      ]);

      // Breading (6): a prep screen with access to station 6.
      assert.equal(errorOf(await call('/kds/breading', ctx.cook), 403), 'FORBIDDEN');
      await grantStation(ctx.pool, b, ctx.cook.staff_id, S('breading'));
      const breading = exact(KdsBreadingSchema, await call('/kds/breading?limit=10', ctx.cook));
      assert.deepEqual(
        breading.orders.map((o) => [o.orderId, o.fingers]),
        [
          [order.orderId, 8],
          [agg.order_id, 6],
        ],
      );
      assert.deepEqual(breading.orders[1].delivery, delivery);
      assert.equal(breading.totalFingers, 14);
      assert.equal(errorOf(await call('/kds/breading?limit=0', ctx.cook), 400), 'INVALID_REQUEST');

      // The table completes and closes its toasts; only issue makes the order ready.
      const ticket = exact(
        FulfillmentOrderSchema,
        await call('/orders/' + order.orderId, ctx.manager),
      );
      const done = exact(
        FulfillmentSummarySchema,
        await call('/orders/' + order.orderId + '/actions', ctx.packer, {
          action: 'complete_station',
          expectedVersion: ticket.version,
          stationId: S('assembly_hall'),
        }),
      );
      assert.equal(done.state, 'in_production');
      const after = exact(
        FulfillmentOrderSchema,
        await call('/orders/' + order.orderId, ctx.manager),
      );
      assert.deepEqual(
        after.tasks.filter((t) => t.state !== 'done').map((t) => t.stationId),
        [S('issue')],
      );
      const ready = exact(
        FulfillmentSummarySchema,
        await call('/orders/' + order.orderId + '/actions', ctx.packer, {
          action: 'complete_station',
          expectedVersion: done.version,
          stationId: S('issue'),
        }),
      );
      assert.equal(ready.state, 'ready');
      // Handover marks stay refused until KDS-4.
      assert.equal(
        errorOf(
          await call('/orders/' + order.orderId + '/actions', ctx.packer, {
            action: 'handoff',
            expectedVersion: ready.version,
            handover: { numberMatched: true, courierAccepted: true, photoTaken: true },
          }),
          400,
        ),
        'INVALID_REQUEST',
      );

      // Guest board: no aggregator order and only the keys it always had.
      const board = exact(FulfillmentDisplaySchema, await call('/display', ctx.manager));
      const numbers = new Map(
        (
          await ctx.pool.query(
            'SELECT order_id, display_number FROM fulfillment_reservations WHERE order_id = ANY($1)',
            [[order.orderId, hall.order_id, agg.order_id]],
          )
        ).rows.map((r) => [r.order_id, r.display_number]),
      );
      assert.deepEqual(
        board.items.map((i) => [i.number, i.state]).sort(),
        [
          [numbers.get(order.orderId), 'ready'],
          [numbers.get(hall.order_id), 'preparing'],
        ].sort(),
      );
      assert.ok(!board.items.some((i) => i.number === numbers.get(agg.order_id)));

      // Switched off: the same tickets lose every KDS key, the layout is off again.
      await switchKdsLayout(ctx.pool, b, false);
      assert.equal((await call('/layout', ctx.packer)).text, '{"enabled":false}');
      const plain = await call('/orders/' + agg.order_id, ctx.manager);
      exact(FulfillmentOrderSchema, plain);
      for (const key of ['"kds"', '"delivery"', '"upstreamOf"'])
        assert.ok(!plain.text.includes(key));
      assert.equal(errorOf(await call('/kds/breading', ctx.cook), 404), 'NOT_FOUND');
    });
  }));
