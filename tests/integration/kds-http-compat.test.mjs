// Cutover lane kds: with the KDS layout off, the kitchen HTTP API is byte-for-byte today's
// (contracts section 10, risk 3): the same station list after the KDS stations are provisioned,
// no new keys in tickets and handover marks still refused.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  ErrorSchema,
  FulfillmentKitchenSchema,
  FulfillmentOrderSchema,
  FulfillmentStationsSchema,
} from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import { kdsStationId, provisionKdsStations } from '@pickchick/edge-fulfillment';
import { createEdge } from '../../services/edge/dist/index.js';
import { fixture } from '../../packages/edge-fulfillment/tests/fixture.mjs';
import {
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
    await run((path, actor, body) =>
      fetch(url + prefix + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: 'Bearer ' + actor.token,
          'X-Staff-Session-Id': actor.session_id,
          'X-Terminal-Id': actor.terminal_id,
          ...(actor.terminalKey ? { 'X-Terminal-Key': actor.terminalKey } : {}),
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
/** Paired screens authenticate only while device access is on; the flag is read per request. */
async function withDeviceAccess(run) {
  const prior = process.env.EDGE_DEVICE_ACCESS_ENABLED;
  process.env.EDGE_DEVICE_ACCESS_ENABLED = 'true';
  try {
    return await run();
  } finally {
    if (prior === undefined) delete process.env.EDGE_DEVICE_ACCESS_ENABLED;
    else process.env.EDGE_DEVICE_ACCESS_ENABLED = prior;
  }
}
const kitchenLogin = (ctx) =>
  ctx.pool.query(
    "INSERT INTO local_staff_passwords(staff_id,branch_id,login,salt,verifier) VALUES($1,$2,'kitchen',$3,$4)",
    [ctx.cook.staff_id, ctx.scope.branchId, 'a'.repeat(64), 'b'.repeat(64)],
  );
/** GET stations as the exact body text, checked against the strict schema. */
async function stationsText(call, actor) {
  const response = await call('/stations', actor);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(JSON.stringify(FulfillmentStationsSchema.parse(JSON.parse(text))), text);
  return text;
}
const ids = (text) => JSON.parse(text).items.map((station) => station.id);
const noKdsKeys = (text) => {
  for (const key of ['"delivery"', '"kds"', '"handover"', '"upstreamOf"'])
    assert.ok(!text.includes(key), key);
};

test('KDS stations provisioned, layout off: tickets carry no KDS keys and handover is refused', () =>
  fixture(async (ctx) => {
    await kitchenLogin(ctx);
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

test('KDS stations provisioned, layout off: GET stations is byte-for-byte today’s for every screen', () =>
  fixture(async (ctx) => {
    await kitchenLogin(ctx);
    const prep = await managedScreen(ctx, 'prep'),
      assembly = await managedScreen(ctx, 'assembly');
    await lan(ctx, async (call) => {
      // The shared kitchen login (granted the KDS stations by provisioning), a shift manager
      // (sees every station of the branch), and the paired prep and assembly screens.
      const read = async () => ({
        cook: await stationsText(call, ctx.cook),
        packer: await stationsText(call, ctx.packer),
        manager: await stationsText(call, ctx.manager),
        ...(await withDeviceAccess(async () => ({
          prep: await stationsText(call, prep),
          assembly: await stationsText(call, assembly),
        }))),
      });
      const before = await read();
      assert.deepEqual(ids(before.cook), [ctx.prep]);
      assert.deepEqual(ids(before.manager), [ctx.prep, ctx.assembly].sort());
      assert.deepEqual(ids(before.prep), [ctx.prep]);
      assert.deepEqual(ids(before.assembly), [ctx.assembly]);
      const provisioned = await transaction(ctx.pool, (client) =>
        provisionKdsStations(client, ctx.scope.branchId),
      );
      assert.equal(provisioned.stationsAdded, 6);
      assert.equal(provisioned.grantsAdded, 6);
      assert.deepEqual(await read(), before);
      // An active layout that is not enabled changes nothing either.
      await writeKdsLayout(ctx.pool, ctx.scope.branchId, kdsTestLayout(ctx.scope.branchId), {
        enable: false,
      });
      assert.deepEqual(await read(), before);
      // Enabled: the KDS stations are listed (KDS screens find their tabs by them).
      await switchKdsLayout(ctx.pool, ctx.scope.branchId, true);
      const on = await read();
      assert.equal(ids(on.cook).length, 7);
      assert.equal(ids(on.manager).length, 8);
      await switchKdsLayout(ctx.pool, ctx.scope.branchId, false);
      assert.deepEqual(await read(), before);
    });
  }));

test('kds-switch disable: stations of a started KDS order stay listed until it leaves the kitchen', () =>
  fixture(async (ctx) => {
    const b = ctx.scope.branchId;
    const S = (fn) => kdsStationId(b, fn);
    await kitchenLogin(ctx);
    await writeKdsLayout(ctx.pool, b, kdsTestLayout(b));
    const { order } = await ctx.accepted();
    let current = await ctx.read(order.orderId);
    const used = [
      ...new Set([...current.tasks.map((t) => t.station_id), current.assemblyStationId]),
    ];
    assert.deepEqual(used.sort(), [S('toasts'), S('assembly_hall'), S('issue')].sort());
    await switchKdsLayout(ctx.pool, b, false);
    await lan(ctx, async (call) => {
      const sorted = (...list) => list.sort();
      // Only the KDS stations this order still needs; never the other three.
      assert.deepEqual(ids(await stationsText(call, ctx.cook)), sorted(ctx.prep, ...used));
      assert.deepEqual(
        ids(await stationsText(call, ctx.manager)),
        sorted(ctx.prep, ctx.assembly, ...used),
      );
      current = await ctx.complete(current);
      current = await ctx.act(current, 'ready');
      assert.equal(current.state, 'ready');
      assert.deepEqual(ids(await stationsText(call, ctx.cook)), sorted(ctx.prep, ...used));
      current = await ctx.act(current, 'handoff');
      assert.equal(current.state, 'handed_over');
      assert.deepEqual(ids(await stationsText(call, ctx.cook)), [ctx.prep]);
      assert.deepEqual(ids(await stationsText(call, ctx.manager)), sorted(ctx.prep, ctx.assembly));
      // A new order while the layout is off goes to the old stations and lists nothing new.
      await ctx.accepted();
      assert.deepEqual(ids(await stationsText(call, ctx.cook)), [ctx.prep]);
    });
  }));
