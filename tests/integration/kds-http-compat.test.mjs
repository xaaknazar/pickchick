// Cutover lane kds: with the KDS layout off, the kitchen HTTP API is byte-for-byte today's
// (contracts section 10, risk 3): no new keys in tickets and handover marks still refused.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  ErrorSchema,
  FulfillmentKitchenSchema,
  FulfillmentOrderSchema,
} from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import { provisionKdsStations } from '@pickchick/edge-fulfillment';
import { createEdge } from '../../services/edge/dist/index.js';
import { fixture } from '../../packages/edge-fulfillment/tests/fixture.mjs';

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
    await run((path, actor, body) =>
      fetch(url + prefix + path, {
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
      }),
    );
  } finally {
    await app.close();
  }
}
const noKdsKeys = (text) => {
  for (const key of ['"delivery"', '"kds"', '"handover"', '"upstreamOf"'])
    assert.ok(!text.includes(key), key);
};

test('KDS stations provisioned, layout off: tickets carry no KDS keys and handover is refused', () =>
  fixture(async (ctx) => {
    await ctx.pool.query(
      "INSERT INTO local_staff_passwords(staff_id,branch_id,login,salt,verifier) VALUES($1,$2,'kitchen',$3,$4)",
      [ctx.cook.staff_id, ctx.scope.branchId, 'a'.repeat(64), 'b'.repeat(64)],
    );
    await transaction(ctx.pool, (client) => provisionKdsStations(client, ctx.scope.branchId));
    const { order } = await ctx.accepted(true);
    const ready = await ctx.complete(order);
    await lan(ctx, async (call) => {
      const page = await call('/kitchen', ctx.manager);
      assert.equal(page.status, 200);
      const pageText = await page.text();
      noKdsKeys(pageText);
      assert.equal(JSON.stringify(FulfillmentKitchenSchema.parse(JSON.parse(pageText))), pageText);
      const one = await call('/orders/' + order.orderId, ctx.manager);
      const oneText = await one.text();
      noKdsKeys(oneText);
      assert.equal(JSON.stringify(FulfillmentOrderSchema.parse(JSON.parse(oneText))), oneText);
      // Tasks went to the old stations: the layout is off.
      const parsed = FulfillmentOrderSchema.parse(JSON.parse(oneText));
      assert.deepEqual(
        [...new Set(parsed.tasks.map((t) => t.stationId))].sort(),
        [ctx.prep, ctx.assembly].sort(),
      );

      const current = await ctx.read(order.orderId);
      assert.equal(current.version, ready.version);
      const commands = await ctx.count('fulfillment_commands');
      const marks = { numberMatched: true, courierAccepted: true, photoTaken: true };
      for (const body of [
        { action: 'ready', expectedVersion: current.version, handover: marks },
        { action: 'handoff', expectedVersion: current.version, handover: marks },
      ]) {
        const refused = await call('/orders/' + order.orderId + '/actions', ctx.manager, body);
        assert.equal(refused.status, 400);
        assert.equal(ErrorSchema.parse(await refused.json()).code, 'INVALID_REQUEST');
      }
      assert.equal((await ctx.read(order.orderId)).version, current.version);
      assert.equal(await ctx.count('fulfillment_commands'), commands);
      // The plain actions work exactly as today.
      const readied = await call('/orders/' + order.orderId + '/actions', ctx.manager, {
        action: 'ready',
        expectedVersion: current.version,
      });
      assert.equal(readied.status, 200);
      const summary = await readied.json();
      assert.equal(summary.state, 'ready');
      const handed = await call('/orders/' + order.orderId + '/actions', ctx.manager, {
        action: 'handoff',
        expectedVersion: summary.version,
      });
      assert.equal(handed.status, 200);
      assert.equal((await handed.json()).state, 'handed_over');
      assert.equal(await ctx.count('delivery_handovers'), 0);
    });
  }));
