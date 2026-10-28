// Offline stand finding (stage 2, 24.10): under load the cashier's order creation failed with a
// bare CONFLICT. The edge refused the kitchen admission (KITCHEN_UNAVAILABLE), but the HTTP error
// filter only passes codes listed in ErrorSchema, so the POS never received the codes it has
// texts and journal rules for (apps/pos/src/api.ts, model.ts).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ErrorSchema } from '@pickchick/contracts';
import { createEdge } from '@pickchick/edge';
import { provisionFulfillment, grantStation, EdgeFulfillment } from '@pickchick/edge-fulfillment';
import { provisionStaff } from '@pickchick/local-orders';
import { withOrderDesk, staffAuth, staffHeaders } from '../helpers/orders.mjs';
import { running, request } from '../helpers/sync.mjs';

test('cashier HTTP keeps SERVICE_MODE_DISABLED, KITCHEN_UNAVAILABLE and ORDER_IN_PRODUCTION', async () => {
  await withOrderDesk(async (ctx) => {
    const server = await running(createEdge, {
      ...ctx.edge.config,
      edgeFulfillmentEnabled: true,
      edgeDeviceId: ctx.device,
    });
    try {
      const post = async (path, body) => {
        const response = await request(`${server.url}/edge/v1/${path}`, {
          method: 'POST',
          headers: staffHeaders(ctx.cashier),
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };
      const order = async () =>
        post('orders', {
          quote_id: (await post('checkout/quotes', ctx.cart)).body.quote_id,
          kitchen_admission: 'unpaid',
        });
      const refused = (result, code) => {
        assert.equal(result.status, 409);
        assert.equal(ErrorSchema.parse(result.body).code, code);
      };
      refused(await order(), 'SERVICE_MODE_DISABLED');
      await ctx.edge.pool.query("UPDATE branch_config SET pos_service_mode='unpaid_service'");
      refused(await order(), 'KITCHEN_UNAVAILABLE');
      const prep = randomUUID(),
        assembly = randomUUID();
      await provisionFulfillment(ctx.edge.pool, {
        organizationId: ctx.org,
        branchId: ctx.branch,
        deviceId: ctx.device,
        producerId: randomUUID(),
        stations: [
          { id: prep, kind: 'prep', name: 'Synthetic prep' },
          { id: assembly, kind: 'assembly', name: 'Synthetic assembly' },
        ],
        routing: {
          version: 1,
          assemblyStationId: assembly,
          routes: [{ productId: ctx.release.items[0].product_id, stationId: prep, kind: 'prep' }],
        },
      });
      const cook = await provisionStaff(ctx.edge.pool, ctx.branch, ctx.setup('kitchen'));
      await grantStation(ctx.edge.pool, ctx.branch, cook.staff_id, prep);
      const created = await order();
      assert.equal(created.status, 201);
      const repo = new EdgeFulfillment(ctx.edge.pool);
      const view = await repo.readOrder(ctx.branch, staffAuth(cook), created.body.order_id, {
        stationId: prep,
      });
      await repo.act(ctx.branch, staffAuth(cook), {
        commandId: randomUUID(),
        orderId: view.orderId,
        expectedVersion: view.version,
        action: 'start_task',
        taskId: view.tasks[0].id,
        expectedTaskVersion: view.tasks[0].version,
      });
      refused(
        await post(`orders/${created.body.order_id}/cancel`, {
          expected_version: 1,
          reason: 'Synthetic late cancellation',
        }),
        'ORDER_IN_PRODUCTION',
      );
      // A plain version conflict stays CONFLICT.
      refused(
        await post(`orders/${created.body.order_id}/cancel`, {
          expected_version: 7,
          reason: 'Synthetic stale cancellation',
        }),
        'CONFLICT',
      );
    } finally {
      await server.app.close();
    }
  });
});
