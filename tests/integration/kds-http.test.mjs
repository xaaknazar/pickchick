// Cutover lane kds, KDS-2 and KDS-4 over HTTP (contracts section 5.4): GET fulfillment/layout and
// GET fulfillment/kds/breading, the KDS keys of the kitchen API only while the layout is on, the
// guest board without aggregator orders and without new keys, and the courier handover marks.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CourierIncidentListSchema,
  CourierIncidentSchema,
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
  managedScreen,
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
    await run(async (path, actor, body, key = randomUUID()) => {
      const response = await fetch(url + prefix + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: 'Bearer ' + actor.token,
          'X-Staff-Session-Id': actor.session_id,
          'X-Terminal-Id': actor.terminal_id,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
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
const MARKS = Object.freeze({ numberMatched: true, courierAccepted: true, photoTaken: true });
// The edge sends HANDOVER_MARKS_REQUIRED; the error filter passes it once ErrorSchema lists the
// code (CR kds-6, owner cloud), until then it answers the generic 400 code.
const MARKS_CODE = ErrorSchema.shape.code.options.includes('HANDOVER_MARKS_REQUIRED')
  ? 'HANDOVER_MARKS_REQUIRED'
  : 'INVALID_REQUEST';
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
      // Courier incidents exist only with the layout on.
      assert.equal(errorOf(await call('/incidents?scope=open', ctx.packer), 404), 'NOT_FOUND');
      assert.equal(
        errorOf(
          await call('/incidents', ctx.manager, {
            provider: 'glovo',
            kind: 'other',
            description: 'Курьер отказался',
          }),
          404,
        ),
        'NOT_FOUND',
      );
      assert.equal(await ctx.count('courier_incidents'), 0);
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
      // KDS-4: courier marks belong to delivery orders only; a hall order refuses them.
      assert.equal(
        errorOf(
          await call('/orders/' + order.orderId + '/actions', ctx.packer, {
            action: 'handoff',
            expectedVersion: ready.version,
            handover: MARKS,
          }),
          400,
        ),
        'INVALID_REQUEST',
      );

      // KDS-4: a courier refusal at station 3 is recorded once and shows on the banner.
      const refusal = {
        orderId: agg.order_id,
        provider: 'glovo',
        claimedNumber: 'g-4568',
        kind: 'number_mismatch',
        description: 'Номер в приложении курьера другой',
      };
      const incidentKey = randomUUID();
      const recorded = await call('/incidents', ctx.packer, refusal, incidentKey);
      const incident = exact(CourierIncidentSchema, recorded, 201);
      assert.deepEqual(
        [incident.incidentId, incident.claimedNumber, incident.provider],
        [incidentKey, 'G-4568', 'glovo'],
      );
      assert.equal(
        incident.displayNumber,
        (
          await ctx.pool.query(
            'SELECT display_number FROM fulfillment_reservations WHERE order_id=$1',
            [agg.order_id],
          )
        ).rows[0].display_number,
      );
      assert.equal(
        (await call('/incidents', ctx.packer, refusal, incidentKey)).text,
        recorded.text,
      );
      assert.equal(
        errorOf(
          await call('/incidents', ctx.packer, { ...refusal, kind: 'no_photo' }, incidentKey),
          409,
        ),
        'CONFLICT',
      );
      assert.equal(
        errorOf(await call('/incidents', ctx.packer, { ...refusal, phone: '0' }), 400),
        'INVALID_REQUEST',
      );
      // No phone numbers in the journal, whichever field carries one (synthetic all-zero).
      for (const phone of [
        { claimedNumber: '87000000000' },
        { description: 'Курьер просил звонить +7 700 000 00 00' },
      ])
        assert.equal(
          errorOf(await call('/incidents', ctx.packer, { ...refusal, ...phone }), 400),
          'INVALID_REQUEST',
        );
      assert.equal(
        (await ctx.pool.query('SELECT count(*)::int AS n FROM courier_incidents')).rows[0].n,
        1,
      );
      assert.equal(errorOf(await call('/incidents', ctx.cashier, refusal), 403), 'FORBIDDEN');
      // A kitchen login without access to the order's finishing station.
      assert.equal(errorOf(await call('/incidents', ctx.cook, refusal), 403), 'FORBIDDEN');
      const banner = exact(
        CourierIncidentListSchema,
        await call('/incidents?scope=open', ctx.packer),
      );
      assert.deepEqual(banner.items, [incident]);
      assert.equal(errorOf(await call('/incidents', ctx.packer), 400), 'INVALID_REQUEST');
      assert.equal(errorOf(await call('/incidents?scope=all', ctx.packer), 400), 'INVALID_REQUEST');
      assert.equal(errorOf(await call('/incidents?scope=open', ctx.cashier), 403), 'FORBIDDEN');

      // KDS-4: the aggregator order at station 3 - no marks, refused; three marks, handed over
      // with its journal row; the same key and body replay the same answer.
      let courier = exact(
        FulfillmentOrderSchema,
        await call('/orders/' + agg.order_id, ctx.manager),
      );
      for (const fn of ['issue', 'assembly_delivery', 'delivery_handover'])
        courier = exact(
          FulfillmentSummarySchema,
          await call('/orders/' + agg.order_id + '/actions', ctx.packer, {
            action: 'complete_station',
            expectedVersion: courier.version,
            stationId: S(fn),
          }),
        );
      assert.equal(courier.state, 'ready');
      const handoffBody = { action: 'handoff', expectedVersion: courier.version };
      assert.equal(
        errorOf(await call('/orders/' + agg.order_id + '/actions', ctx.packer, handoffBody), 400),
        MARKS_CODE,
      );
      assert.equal(
        errorOf(
          await call('/orders/' + agg.order_id + '/actions', ctx.packer, {
            ...handoffBody,
            handover: { ...MARKS, photoTaken: false },
          }),
          400,
        ),
        'INVALID_REQUEST',
      );
      assert.equal(await ctx.count('delivery_handovers'), 0);
      const key = randomUUID();
      const handed = await call(
        '/orders/' + agg.order_id + '/actions',
        ctx.packer,
        { ...handoffBody, handover: MARKS },
        key,
      );
      assert.equal(exact(FulfillmentSummarySchema, handed).state, 'handed_over');
      const replayed = await call(
        '/orders/' + agg.order_id + '/actions',
        ctx.packer,
        { ...handoffBody, handover: MARKS },
        key,
      );
      assert.equal(replayed.text, handed.text);
      assert.equal(
        errorOf(
          await call('/orders/' + agg.order_id + '/actions', ctx.packer, handoffBody, key),
          409,
        ),
        'CONFLICT',
      );
      assert.deepEqual(
        (
          await ctx.pool.query(
            'SELECT order_id,command_id,provider,external_number,station_id,staff_id,terminal_id FROM delivery_handovers',
          )
        ).rows,
        [
          {
            order_id: agg.order_id,
            command_id: key,
            provider: 'glovo',
            external_number: 'G-4567',
            station_id: S('delivery_handover'),
            staff_id: ctx.packer.staff_id,
            terminal_id: ctx.packer.terminal_id,
          },
        ],
      );
      // Handed over: the banner is clear, the journal of the day keeps the refusal.
      assert.deepEqual(
        exact(CourierIncidentListSchema, await call('/incidents?scope=open', ctx.manager)).items,
        [],
      );
      assert.deepEqual(
        exact(CourierIncidentListSchema, await call('/incidents?scope=today', ctx.cook)).items,
        [incident],
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

test('KDS-4 managed screens: marks refused first while the layout is off, courier work only on assembly screens', () =>
  fixture(async (ctx) => {
    const b = ctx.scope.branchId;
    const S = (fn) => kdsStationId(b, fn);
    const desk = await cashierDesk(ctx);
    await writeKdsLayout(ctx.pool, b, kdsTestLayout(b), { enable: false });
    const prep = await managedScreen(ctx, 'prep'),
      assembly = await managedScreen(ctx, 'assembly');
    const prior = process.env.EDGE_DEVICE_ACCESS_ENABLED;
    process.env.EDGE_DEVICE_ACCESS_ENABLED = 'true';
    const app = await createEdge({
      service: 'edge',
      environment: 'test',
      databaseUrl: ctx.url,
      branchId: b,
      edgeDeviceId: ctx.scope.deviceId,
      edgeFulfillmentEnabled: true,
      port: 0,
    });
    try {
      await app.listen(0, '127.0.0.1');
      const url = await app.getUrl();
      const call = async (path, screen, body) => {
        const response = await fetch(url + prefix + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Authorization: 'Bearer ' + screen.token,
            'X-Staff-Session-Id': screen.session_id,
            'X-Terminal-Id': screen.terminal_id,
            'X-Terminal-Key': screen.terminalKey,
            'Content-Type': 'application/json',
            'Idempotency-Key': randomUUID(),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(5000),
        });
        return { status: response.status, text: await response.text() };
      };
      await switchKdsLayout(ctx.pool, b, true);
      const local = await desk.order({
        delivery: { provider: 'glovo', externalNumber: 'G-900' },
        burgers: 0,
      });
      let current = await ctx.read(local.order_id);
      for (const fn of ['issue', 'assembly_delivery', 'delivery_handover'])
        current = await ctx.act(current, 'complete_station', ctx.manager, { stationId: S(fn) });
      assert.equal(current.state, 'ready');
      const path = '/orders/' + local.order_id + '/actions';
      const withMarks = { action: 'handoff', expectedVersion: current.version, handover: MARKS };
      // Layout off: a body with marks is refused before anything else, as before the contract
      // allowed the key - even from a prep screen that may not hand over at all.
      await switchKdsLayout(ctx.pool, b, false);
      assert.equal(errorOf(await call(path, prep, withMarks), 400), 'INVALID_REQUEST');
      assert.equal(errorOf(await call(path, assembly, withMarks), 400), 'INVALID_REQUEST');
      // Layout on: a prep screen cannot hand over; the assembly screen needs the marks.
      await switchKdsLayout(ctx.pool, b, true);
      assert.equal(errorOf(await call(path, prep, withMarks), 403), 'FORBIDDEN');
      assert.equal(
        errorOf(await call(path, assembly, { ...withMarks, handover: undefined }), 400),
        MARKS_CODE,
      );
      const refusal = { provider: 'glovo', kind: 'courier_refused', description: 'Курьер уехал' };
      assert.equal(errorOf(await call('/incidents', prep, refusal), 403), 'FORBIDDEN');
      const incident = exact(
        CourierIncidentSchema,
        await call('/incidents', assembly, refusal),
        201,
      );
      assert.deepEqual(
        exact(CourierIncidentListSchema, await call('/incidents?scope=open', prep)).items,
        [incident],
      );
      assert.equal(
        exact(FulfillmentSummarySchema, await call(path, assembly, withMarks)).state,
        'handed_over',
      );
      assert.deepEqual((await ctx.pool.query('SELECT terminal_id FROM delivery_handovers')).rows, [
        { terminal_id: assembly.terminal_id },
      ]);
    } finally {
      await app.close();
      if (prior === undefined) delete process.env.EDGE_DEVICE_ACCESS_ENABLED;
      else process.env.EDGE_DEVICE_ACCESS_ENABLED = prior;
    }
  }));
