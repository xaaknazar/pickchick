import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createEdge } from '../../services/edge/dist/index.js';
import { loadConfig } from '@pickchick/platform';
import {
  ErrorSchema,
  FulfillmentOrderSchema,
  FulfillmentKitchenSchema,
  FulfillmentDisplaySchema,
  FulfillmentSummarySchema,
  FulfillmentStationsSchema,
} from '@pickchick/contracts';
import { revokeStaff } from '@pickchick/local-orders';
import { applyMenu, hashJson } from '@pickchick/menu-sync';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { fixture } from '../../packages/edge-fulfillment/tests/fixture.mjs';
import { digest } from '@pickchick/edge-fulfillment';

const prefix = '/edge/v1/fulfillment';
const headers = (actor, key = randomUUID()) => ({
  Authorization: 'Bearer ' + actor.token,
  'X-Staff-Session-Id': actor.session_id,
  'X-Terminal-Id': actor.terminal_id,
  'Content-Type': 'application/json',
  'Idempotency-Key': key,
});
async function lan(ctx, callback, override = {}) {
  const config = {
    service: 'edge',
    environment: 'test',
    databaseUrl: ctx.url,
    branchId: ctx.scope.branchId,
    edgeDeviceId: ctx.scope.deviceId,
    edgeFulfillmentEnabled: true,
    port: 0,
    ...override,
  };
  let app = await createEdge(config);
  await app.listen(0, '127.0.0.1');
  let url = await app.getUrl();
  const call = (path, actor, body, extra = {}) =>
    fetch(url + prefix + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: actor ? headers(actor) : {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
      ...extra,
    });
  try {
    await callback({
      call,
      raw: (path, options) => fetch(url + path, { signal: AbortSignal.timeout(5000), ...options }),
      restart: async () => {
        await app.close();
        app = await createEdge(config);
        await app.listen(0, '127.0.0.1');
        url = await app.getUrl();
      },
    });
  } finally {
    await app.close();
  }
}
async function error(response, status, code) {
  assert.equal(response.status, status);
  const body = ErrorSchema.parse(await response.json());
  assert.equal(body.code, code);
  return body;
}
async function read(call, actor, id, station) {
  const response = await call('/orders/' + id + (station ? '?stationId=' + station : ''), actor);
  assert.equal(response.status, 200);
  return FulfillmentOrderSchema.parse(await response.json());
}
const taskBody = (order, task, action) => ({
  action,
  expectedVersion: order.version,
  taskId: task.taskId,
  expectedTaskVersion: task.version,
});

test('LAN fulfillment flag is edge-only, defaults off and requires explicit device binding', async () => {
  const env = {
    APP_ENV: 'test',
    EDGE_DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:55433/pickchick_edge',
    EDGE_BRANCH_ID: randomUUID(),
    REDIS_URL: 'redis://127.0.0.1:56379',
    CLOUD_DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:55432/pickchick_cloud',
  };
  assert.equal(loadConfig('edge', env).edgeFulfillmentEnabled, undefined);
  assert.throws(() => loadConfig('edge', { ...env, EDGE_FULFILLMENT_ENABLED: 'yes' }));
  assert.throws(() => loadConfig('edge', { ...env, EDGE_FULFILLMENT_ENABLED: 'true' }));
  assert.throws(() =>
    loadConfig('api', { ...env, EDGE_FULFILLMENT_ENABLED: 'true', EDGE_DEVICE_ID: randomUUID() }),
  );
  assert.equal(
    loadConfig('edge', { ...env, EDGE_FULFILLMENT_ENABLED: 'true', EDGE_DEVICE_ID: randomUUID() })
      .edgeFulfillmentEnabled,
    true,
  );
  await fixture(async (ctx) =>
    lan(
      ctx,
      async ({ call }) => {
        const config = await call('/config');
        assert.equal(config.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await config.json(), { enabled: false });
        for (const path of ['/stations', '/kitchen', '/display', '/orders/' + randomUUID()])
          await error(await call(path, ctx.manager), 404, 'NOT_FOUND');
        await error(
          await call('/orders/' + randomUUID() + '/actions', ctx.manager, {
            action: 'ready',
            expectedVersion: 1,
          }),
          404,
          'NOT_FOUND',
        );
        assert.equal(await ctx.count('fulfillment_commands'), 0);
      },
      { edgeFulfillmentEnabled: false },
    ),
  );
});

test('LAN reads require actual staff credentials, own terminal, role and assigned station', async () => {
  await fixture(async (ctx) =>
    lan(ctx, async ({ call }) => {
      const { order } = await ctx.accepted();
      for (const path of ['/stations', '/kitchen', '/display', '/orders/' + order.orderId])
        await error(await call(path), 401, 'UNAUTHORIZED');
      await error(
        await call('/display', ctx.cook, undefined, {
          headers: { ...headers(ctx.cook), 'X-Terminal-Id': randomUUID() },
        }),
        403,
        'FORBIDDEN',
      );
      await error(await call('/display', ctx.cashier), 403, 'FORBIDDEN');
      await error(await call('/kitchen', ctx.cook), 400, 'INVALID_REQUEST');
      await error(await call('/kitchen?stationId=' + ctx.assembly, ctx.cook), 403, 'FORBIDDEN');
      await error(
        await call('/orders/' + order.orderId + '?stationId=' + ctx.assembly, ctx.cook),
        403,
        'FORBIDDEN',
      );
      const stations = FulfillmentStationsSchema.parse(
        await (await call('/stations', ctx.cook)).json(),
      );
      assert.deepEqual(
        stations.items.map((station) => station.id),
        [ctx.prep],
      );
      const assembly = FulfillmentKitchenSchema.parse(
        await (await call('/kitchen?stationId=' + ctx.assembly, ctx.packer)).json(),
      );
      assert.deepEqual(
        assembly.items.map((item) => item.orderId),
        [order.orderId],
      );
      assert.equal(assembly.items[0].assemblyStationId, ctx.assembly);
      assert.equal(
        (await read(call, ctx.packer, order.orderId, ctx.assembly)).orderId,
        order.orderId,
      );
      assert.equal((await call('/kitchen', ctx.manager)).status, 200);
      await ctx.pool.query(
        'DELETE FROM fulfillment_station_grants WHERE branch_id=$1 AND staff_id=$2',
        [ctx.scope.branchId, ctx.cook.staff_id],
      );
      await error(
        await call('/orders/' + order.orderId + '?stationId=' + ctx.prep, ctx.cook),
        403,
        'FORBIDDEN',
      );
    }),
  );
});

test('wrong branch, revoked session, revoked staff and inactive terminal fail on LED and replay', async () => {
  await fixture(async (ctx) =>
    lan(ctx, async ({ call }) => {
      await fixture(async (other) =>
        error(await call('/display', other.manager), 401, 'UNAUTHORIZED'),
      );
      await ctx.pool.query('UPDATE staff_sessions SET revoked=true WHERE id=$1', [
        ctx.cook.session_id,
      ]);
      await error(await call('/display', ctx.cook), 401, 'UNAUTHORIZED');
      await ctx.pool.query('UPDATE local_terminals SET active=false WHERE id=$1', [
        ctx.packer.terminal_id,
      ]);
      await error(await call('/display', ctx.packer), 401, 'UNAUTHORIZED');
      const { order } = await ctx.accepted();
      const current = await read(call, ctx.manager, order.orderId);
      const body = taskBody(current, current.tasks[0], 'start_task'),
        key = randomUUID();
      const options = { headers: headers(ctx.manager, key) };
      assert.equal(
        (await call('/orders/' + order.orderId + '/actions', ctx.manager, body, options)).status,
        200,
      );
      await revokeStaff(ctx.pool, ctx.scope.branchId, ctx.manager.staff_id);
      await error(
        await call('/orders/' + order.orderId + '/actions', ctx.manager, body, options),
        401,
        'UNAUTHORIZED',
      );
      await error(await call('/display', ctx.manager), 401, 'UNAUTHORIZED');
      assert.equal(await ctx.count('fulfillment_commands'), 1);
    }),
  );
});

test('runtime projections discard commercial and passthrough metadata; LED is strictly minimal', async () => {
  await fixture(async (ctx) =>
    lan(ctx, async ({ call }) => {
      const admission = ctx.admission(true);
      admission.payload.snapshot.privateCustomer = 'SYNTHETIC_SECRET_MARKER';
      admission.payload.snapshot.lines[0].selectedDetails.modifiers[0].privatePhone =
        'SYNTHETIC_SECRET_MARKER';
      admission.payload.snapshot.lines[0].selectedDetails.modifiers[0].unitPriceDeltaMinor =
        '99999';
      admission.payload.quoteDigest = digest(admission.payload.snapshot);
      const reservation = await ctx.repo.acceptCloud(ctx.scope, admission);
      const accepted = await ctx.repo.acceptCloud(ctx.scope, ctx.authorize(admission, reservation));
      const current = await read(call, ctx.manager, accepted.orderId);
      const body = JSON.stringify(current);
      for (const field of [
        'SYNTHETIC_SECRET_MARKER',
        'unitPriceDeltaMinor',
        'customerId',
        'quoteDigest',
        'ownerHash',
        'reservationId',
        'deviceId',
        'totalMinor',
      ])
        assert.ok(!body.includes(field), field);
      assert.equal(current.tasks.length, 3);
      assert.equal(current.tasks[0].details.modifiers.length, 1);
      const display = FulfillmentDisplaySchema.parse(
        await (await call('/display', ctx.packer)).json(),
      );
      assert.deepEqual(display, {
        items: [{ number: accepted.displayNumber, state: 'preparing' }],
        nextAfterNumber: null,
      });
    }),
  );
});

test('HTTP prepare, assemble and handoff preserve exact retries through restart', async () => {
  await fixture(async (ctx) =>
    lan(ctx, async ({ call, restart }) => {
      const { order } = await ctx.accepted();
      let current = await read(call, ctx.cook, order.orderId, ctx.prep);
      const body = taskBody(current, current.tasks[0], 'start_task'),
        key = randomUUID();
      const options = { headers: headers(ctx.cook, key) };
      await error(
        await call('/orders/' + order.orderId + '/actions', ctx.cook, {
          action: 'ready',
          expectedVersion: current.version,
        }),
        403,
        'FORBIDDEN',
      );
      const first = await call('/orders/' + order.orderId + '/actions', ctx.cook, body, options);
      assert.equal(first.status, 200);
      const result = FulfillmentSummarySchema.parse(await first.json());
      await restart();
      current = await read(call, ctx.cook, order.orderId, ctx.prep);
      assert.equal(current.tasks[0].state, 'in_progress');
      const complete = await call(
        '/orders/' + order.orderId + '/actions',
        ctx.cook,
        taskBody(current, current.tasks[0], 'complete_task'),
      );
      assert.equal(complete.status, 200);
      assert.deepEqual(
        await (await call('/orders/' + order.orderId + '/actions', ctx.cook, body, options)).json(),
        result,
      );
      await error(
        await call(
          '/orders/' + order.orderId + '/actions',
          ctx.cook,
          { ...body, expectedVersion: current.version },
          options,
        ),
        409,
        'CONFLICT',
      );
      current = await read(call, ctx.packer, order.orderId, ctx.assembly);
      assert.equal(
        (
          await call('/orders/' + order.orderId + '/actions', ctx.packer, {
            action: 'ready',
            expectedVersion: current.version,
          })
        ).status,
        200,
      );
      const display = await (await call('/display', ctx.packer)).json();
      assert.equal(display.items[0].state, 'ready');
      current = await read(call, ctx.packer, order.orderId, ctx.assembly);
      assert.equal(
        (
          await call('/orders/' + order.orderId + '/actions', ctx.packer, {
            action: 'handoff',
            expectedVersion: current.version,
          })
        ).status,
        200,
      );
      assert.deepEqual(await (await call('/display', ctx.packer)).json(), {
        items: [],
        nextAfterNumber: null,
      });
      assert.equal(await ctx.count('fulfillment_commands'), 4);
      assert.equal(
        Number(
          (
            await ctx.pool.query(
              "SELECT count(*) FROM fulfillment_outbox WHERE event_type='edge.fulfillment_handed_over'",
            )
          ).rows[0].count,
        ),
        1,
      );
    }),
  );
});

test('concurrent action versions select one winner and duplicate keys produce one effect', async () => {
  await fixture(async (ctx) =>
    lan(ctx, async ({ call }) => {
      const { order } = await ctx.accepted();
      let current = await read(call, ctx.manager, order.orderId);
      const body = taskBody(current, current.tasks[0], 'start_task');
      const responses = await Promise.all([
        call('/orders/' + order.orderId + '/actions', ctx.manager, body),
        call('/orders/' + order.orderId + '/actions', ctx.manager, body),
      ]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
      current = await read(call, ctx.manager, order.orderId);
      const complete = taskBody(current, current.tasks[0], 'complete_task'),
        key = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          call('/orders/' + order.orderId + '/actions', ctx.manager, complete, {
            headers: headers(ctx.manager, key),
          }),
        ),
      );
      assert.ok(results.every((r) => r.status === 200));
      const bodies = await Promise.all(results.map((r) => r.json()));
      assert.ok(bodies.every((r) => JSON.stringify(r) === JSON.stringify(bodies[0])));
      assert.equal(await ctx.count('fulfillment_commands'), 2);
    }),
  );
});

test('only trusted cancellation enters stop workflow; HTTP confirms station stop and manager resolution', async () => {
  await fixture(async (ctx) =>
    lan(ctx, async ({ call }) => {
      const { order } = await ctx.accepted();
      let current = await read(call, ctx.cook, order.orderId, ctx.prep);
      assert.equal(
        (
          await call(
            '/orders/' + order.orderId + '/actions',
            ctx.cook,
            taskBody(current, current.tasks[0], 'start_task'),
          )
        ).status,
        200,
      );
      current = await ctx.read(order.orderId);
      await ctx.repo.acceptCloud(ctx.scope, ctx.cancel(current));
      let httpOrder = await read(call, ctx.manager, order.orderId);
      await error(
        await call('/orders/' + order.orderId + '/actions', ctx.manager, {
          action: 'confirm_cancel',
          expectedVersion: httpOrder.version,
          reason: 'Synthetic stop',
          inventoryDisposition: 'requires_inventory_review',
        }),
        409,
        'CONFLICT',
      );
      await error(
        await call(
          '/orders/' + order.orderId + '/actions',
          ctx.packer,
          taskBody(httpOrder, httpOrder.tasks[0], 'confirm_stop'),
        ),
        403,
        'FORBIDDEN',
      );
      assert.equal(
        (
          await call(
            '/orders/' + order.orderId + '/actions',
            ctx.cook,
            taskBody(httpOrder, httpOrder.tasks[0], 'confirm_stop'),
          )
        ).status,
        200,
      );
      httpOrder = await read(call, ctx.manager, order.orderId);
      const resolve = {
        action: 'confirm_cancel',
        expectedVersion: httpOrder.version,
        reason: 'Synthetic stop',
        inventoryDisposition: 'requires_inventory_review',
      };
      await error(
        await call('/orders/' + order.orderId + '/actions', ctx.cook, resolve),
        403,
        'FORBIDDEN',
      );
      assert.equal(
        (await call('/orders/' + order.orderId + '/actions', ctx.manager, resolve)).status,
        200,
      );
      assert.equal((await read(call, ctx.manager, order.orderId)).state, 'cancelled');
      assert.equal(await ctx.count('local_orders'), 0);
    }),
  );
});

test('LAN routes reject extra scope, malformed or oversized actions; cloud ingress is absent', async () => {
  await fixture(async (ctx) =>
    lan(ctx, async ({ call }) => {
      const { order } = await ctx.accepted();
      for (const query of [
        'limit=101',
        'limit=1&limit=2',
        'branchId=' + randomUUID(),
        'afterNumber=9223372036854775808',
      ])
        await error(await call('/display?' + query, ctx.manager), 400, 'INVALID_REQUEST');
      await error(
        await call('/orders/' + order.orderId + '/actions', ctx.manager, {
          action: 'ready',
          expectedVersion: 2,
          paid: true,
        }),
        400,
        'INVALID_REQUEST',
      );
      await error(
        await call('/orders/' + order.orderId + '/actions', ctx.manager, {
          action: 'ready',
          expectedVersion: 2,
          extra: 'x'.repeat(17000),
        }),
        413,
        'PAYLOAD_TOO_LARGE',
      );
      await error(
        await call(
          '/orders/' + order.orderId + '/actions',
          ctx.manager,
          { action: 'ready', expectedVersion: 2 },
          { headers: { ...headers(ctx.manager), 'Idempotency-Key': '' } },
        ),
        400,
        'INVALID_REQUEST',
      );
      for (const path of [
        '/admission',
        '/reserve',
        '/authorize',
        '/cloud',
        '/outbox',
        '/provision',
        '/orders/' + order.orderId + '/cancel',
      ])
        await error(await call(path, ctx.manager, { paid: true }), 404, 'NOT_FOUND');
      assert.equal(await ctx.count('fulfillment_commands'), 0);
    }),
  );
});

test('readiness requires edge005, all serving tables and matching local device only when enabled', async () => {
  await fixture(async (ctx) => {
    await lan(ctx, async ({ raw }) => {
      assert.equal((await raw('/health/ready')).status, 200);
      await ctx.pool.query('ALTER TABLE fulfillment_commands RENAME TO unavailable_commands');
      assert.equal((await raw('/health/ready')).status, 503);
      await ctx.pool.query('ALTER TABLE unavailable_commands RENAME TO fulfillment_commands');
      await ctx.pool.query(
        "DELETE FROM schema_migrations WHERE version='005_edge_fulfillment.sql'",
      );
      assert.equal((await raw('/health/ready')).status, 503);
    });
    await lan(ctx, async ({ raw }) => assert.equal((await raw('/health/ready')).status, 200), {
      edgeFulfillmentEnabled: false,
    });
  });
  await fixture(async (ctx) =>
    lan(
      ctx,
      async ({ call, raw }) => {
        assert.equal((await raw('/health/ready')).status, 503);
        await error(await call('/display', ctx.manager), 503, 'SERVICE_UNAVAILABLE');
      },
      { edgeDeviceId: randomUUID() },
    ),
  );
});

test('existing unpaid POS order cannot enter fulfillment through any LAN action', async () => {
  await fixture(async (ctx) =>
    lan(ctx, async ({ call, raw }) => {
      const menu = { ...fixtureMenu, branch_id: ctx.scope.branchId, release_id: randomUUID() };
      await applyMenu(ctx.pool, ctx.scope.branchId, {
        schema_version: 1,
        event_id: randomUUID(),
        producer_id: randomUUID(),
        producer_sequence: '1',
        aggregate_type: 'menu_release',
        aggregate_id: menu.release_id,
        aggregate_version: 1,
        event_type: 'menu.published',
        branch_id: ctx.scope.branchId,
        occurred_at: new Date().toISOString(),
        correlation_id: randomUUID(),
        causation_id: null,
        payload: { menu, checksum: hashJson(menu) },
      });
      const shiftResponse = await raw('/edge/v1/cash-shifts', {
        method: 'POST',
        headers: headers(ctx.cashier),
        body: JSON.stringify({ opening_cash_minor: '0' }),
      });
      assert.equal(shiftResponse.status, 201, 'Legacy POS still requires an open cashier shift');
      assert.equal((await shiftResponse.json()).state, 'open');
      const quoteResponse = await raw('/edge/v1/checkout/quotes', {
        method: 'POST',
        headers: headers(ctx.cashier),
        body: JSON.stringify({
          release_id: menu.release_id,
          service_mode: 'takeaway',
          items: [{ variant_id: menu.items[0].variant_id, quantity: 1 }],
        }),
      });
      assert.equal(quoteResponse.status, 201);
      const quote = await quoteResponse.json();
      const orderResponse = await raw('/edge/v1/orders', {
        method: 'POST',
        headers: headers(ctx.cashier),
        body: JSON.stringify({ quote_id: quote.quote_id }),
      });
      assert.equal(orderResponse.status, 201);
      const order = await orderResponse.json();
      assert.equal(order.fulfillment_state, 'blocked');
      await error(
        await call('/orders/' + order.order_id + '/actions', ctx.manager, {
          action: 'ready',
          expectedVersion: 1,
        }),
        404,
        'NOT_FOUND',
      );
      await error(
        await call('/authorize', ctx.manager, { orderId: order.order_id, paid: true }),
        404,
        'NOT_FOUND',
      );
      assert.equal(await ctx.count('fulfillment_reservations'), 0);
      assert.equal(await ctx.count('fulfillment_tasks'), 0);
      assert.equal(
        (
          await ctx.pool.query('SELECT fulfillment_state FROM local_orders WHERE id=$1', [
            order.order_id,
          ])
        ).rows[0].fulfillment_state,
        'blocked',
      );
    }),
  );
});

test('large HTTP kitchen pages remain bounded and cursors recover all rich orders and LED numbers', async () => {
  await fixture(async (ctx) =>
    lan(ctx, async ({ call }) => {
      const expected = new Set();
      for (let index = 0; index < 5; index++) {
        const admission = ctx.admission();
        const line = admission.payload.snapshot.lines[0];
        admission.payload.snapshot.lines = Array.from({ length: 200 }, () => ({
          ...line,
          lineId: randomUUID(),
          title: 'S'.repeat(250),
          description: 'Synthetic '.repeat(200),
        }));
        admission.payload.snapshot.totalMinor = '69800000';
        admission.payload.quoteDigest = digest(admission.payload.snapshot);
        const reserved = await ctx.repo.acceptCloud(ctx.scope, admission);
        await ctx.repo.acceptCloud(ctx.scope, ctx.authorize(admission, reserved));
        expected.add(reserved.orderId);
      }
      const seen = new Set();
      let cursor,
        pages = 0;
      do {
        const response = await call(
          '/kitchen?limit=100' + (cursor ? '&afterOrderId=' + cursor : ''),
          ctx.manager,
        );
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.ok(Buffer.byteLength(text) <= 3 * 1024 * 1024);
        const page = FulfillmentKitchenSchema.parse(JSON.parse(text));
        for (const item of page.items) {
          assert.equal(item.tasks.length, 200);
          assert.ok(!seen.has(item.orderId));
          seen.add(item.orderId);
        }
        cursor = page.nextAfterOrderId;
        pages++;
        assert.ok(pages < 10);
      } while (cursor);
      assert.ok(pages > 1);
      assert.deepEqual(seen, expected);
      cursor = undefined;
      const numbers = new Set();
      do {
        const page = FulfillmentDisplaySchema.parse(
          await (
            await call('/display?limit=2' + (cursor ? '&afterNumber=' + cursor : ''), ctx.packer)
          ).json(),
        );
        for (const item of page.items) {
          assert.ok(!numbers.has(item.number));
          numbers.add(item.number);
        }
        cursor = page.nextAfterNumber;
      } while (cursor);
      assert.equal(numbers.size, 5);
    }),
  );
});

test('immutable pre-LAN command receipt without assembly field still returns its exact old version', async () => {
  await fixture(async (ctx) =>
    lan(ctx, async ({ call }) => {
      const { order } = await ctx.accepted();
      const current = await read(call, ctx.manager, order.orderId);
      const body = taskBody(current, current.tasks[0], 'start_task');
      const saved = await ctx.repo.act(ctx.scope.branchId, ctx.manager.auth, {
        ...body,
        orderId: order.orderId,
        commandId: randomUUID(),
      });
      // A synthetic receipt shaped exactly like the domain version before the additive read field.
      const legacy = { ...saved };
      delete legacy.assemblyStationId;
      const key = randomUUID();
      await ctx.pool.query(
        'INSERT INTO fulfillment_commands(branch_id,staff_id,command_id,request_hash,result) VALUES($1,$2,$3,$4,$5)',
        [
          ctx.scope.branchId,
          ctx.manager.staff_id,
          key,
          digest({ ...body, orderId: order.orderId, commandId: key }),
          legacy,
        ],
      );
      await ctx.act(saved, 'complete_task', ctx.manager, {
        taskId: current.tasks[0].taskId,
        expectedTaskVersion: 2,
      });
      const result = await call('/orders/' + order.orderId + '/actions', ctx.manager, body, {
        headers: headers(ctx.manager, key),
      });
      assert.equal(result.status, 200);
      const summary = FulfillmentSummarySchema.parse(await result.json());
      assert.equal(summary.version, saved.version);
      assert.equal(summary.state, 'in_production');
      assert.ok(!('assemblyStationId' in summary));
      assert.ok((await read(call, ctx.manager, order.orderId)).version > summary.version);
      assert.equal(
        (await ctx.pool.query('SELECT result FROM fulfillment_commands WHERE command_id=$1', [key]))
          .rows[0].result.assemblyStationId,
        undefined,
      );
    }),
  );
});
