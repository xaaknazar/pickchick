// Cutover lane kds, contract test of contracts section 5.2: every outbox event of every KDS path
// (both admission paths, the table cascade, the courier handover, cancellation and release)
// still passes the strict stream it travels on. Cashier orders go to the cloud through the POS
// kitchen stream (PosKitchenEventSchema, packages/pos-order-sync kitchen-model.ts); cloud orders
// through the fulfillment transport (EdgeEventSchema, packages/fulfillment-transport model.ts).
// Both real edge senders run here against a stub cloud that parses each event exactly as the
// cloud receivers do and acknowledges it; a new event shape or key would stop the stream.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  PosKitchenEventSchema,
  kitchenReceiptFor,
  parseKitchenEvent,
  provisionEdgePosSync,
  syncPosKitchenOnce,
} from '../../pos-order-sync/dist/index.js';
import {
  EdgeEventSchema,
  TransportEdgeEventSchema,
  syncFulfillmentOnce,
} from '../../fulfillment-transport/dist/index.js';
import { grantStation, kdsStationId } from '../dist/index.js';
import { fixture } from './fixture.mjs';
import { cashierDesk, kdsTestLayout, writeKdsLayout } from './kds-fixture.mjs';

const ORIGIN = 'http://127.0.0.1:9';
const MARKS = { numberMatched: true, courierAccepted: true, photoTaken: true };
/** Keys the D0 payloads carry (records.ts view() plus the per-event extras); nothing else. */
const D0_PAYLOAD_KEYS = new Set([
  'orderId',
  'branchId',
  'reservationId',
  'quoteId',
  'quoteDigest',
  'ownerHash',
  'commercialOwner',
  'executionMode',
  'fulfillmentOwner',
  'deviceId',
  'version',
  'state',
  'displayNumber',
  'createdAt',
  'updatedAt',
  'routingVersion',
  'assemblyStationId',
  'taskId',
  'taskVersion',
  'taskState',
  'stationId',
  'staffId',
  'reason',
  'inventoryDisposition',
  'inventoryEffect',
  'restoreContext',
]);
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Every KDS path on one edge, with the layout on. Returns the orders by path. */
async function kdsPaths(f) {
  const b = f.scope.branchId;
  const S = (fn) => kdsStationId(b, fn);
  const desk = await cashierDesk(f);
  await writeKdsLayout(f.pool, b, kdsTestLayout(b));
  await grantStation(f.pool, b, f.cook.staff_id, S('toasts'));
  const station = (current, fn) =>
    f.act(current, 'complete_station', f.manager, { stationId: S(fn) });
  const startToast = async (orderId) => {
    const current = await f.read(orderId);
    const toast = current.tasks.find((t) => t.station_id === S('toasts'));
    return f.act(current, 'start_task', f.cook, {
      taskId: toast.id,
      expectedTaskVersion: toast.version,
    });
  };

  // Cloud hall combo: reserved, accepted, a toast started, the table cascade, ready at issue.
  const { order: cloud } = await f.accepted(true);
  let current = await startToast(cloud.orderId);
  current = await station(current, 'assembly_hall');
  current = await station(current, 'issue');
  assert.equal(current.state, 'ready');
  assert.equal((await f.act(current, 'handoff')).state, 'handed_over');
  // Cloud release of a held reservation.
  const held = await f.repo.acceptCloud(f.scope, f.admission());
  assert.equal(
    (await f.repo.acceptCloud(f.scope, f.cancel(held, 'edge.admission_release_requested'))).state,
    'released',
  );
  // Cloud cancellation before any start, and after a toast started (stop, then confirm).
  const { order: early } = await f.accepted(true);
  assert.equal((await f.repo.acceptCloud(f.scope, f.cancel(early))).state, 'cancelled');
  const { order: late } = await f.accepted(true);
  const started = await startToast(late.orderId);
  current = await f.repo.acceptCloud(f.scope, f.cancel(started));
  assert.equal(current.state, 'cancel_requested');
  const stopping = (await f.read(late.orderId)).tasks.find((t) => t.state === 'cancel_requested');
  current = await f.act(await f.read(late.orderId), 'confirm_stop', f.manager, {
    taskId: stopping.id,
    expectedTaskVersion: stopping.version,
  });
  current = await f.act(current, 'confirm_cancel', f.manager, {
    reason: 'Отмена облачного заказа',
    inventoryDisposition: 'recorded_elsewhere',
  });
  assert.equal(current.state, 'cancelled');

  // Cashier hall order: accepted, a toast started, the table cascade, ready, handed over.
  const hall = await desk.order({ comboQuantity: 1, burgers: 1 });
  current = await startToast(hall.order_id);
  for (const fn of ['assembly_hall', 'issue']) current = await station(current, fn);
  assert.equal((await f.act(current, 'handoff')).state, 'handed_over');
  // Cashier aggregator order: table 2, drinks at issue, station 3, handover with the marks, and
  // a courier refusal before it (journal only, no event).
  const aggregator = await desk.order({
    delivery: { provider: 'yandex_eda', externalNumber: 'YA-808' },
    burgers: 0,
  });
  current = await f.read(aggregator.order_id);
  for (const fn of ['issue', 'assembly_delivery', 'delivery_handover'])
    current = await station(current, fn);
  const outbox = await f.count('fulfillment_outbox');
  await f.repo.recordIncident(b, f.manager.auth, randomUUID(), {
    orderId: aggregator.order_id,
    provider: 'yandex_eda',
    claimedNumber: 'YA-809',
    kind: 'number_mismatch',
    description: 'Номер в приложении курьера другой',
  });
  assert.equal(await f.count('fulfillment_outbox'), outbox);
  assert.equal(
    (await f.act(current, 'handoff', f.manager, { handover: MARKS })).state,
    'handed_over',
  );
  // Cashier cancellation before the kitchen started.
  const cancelled = await desk.order({ comboQuantity: 1, burgers: 0 });
  await desk.cancel(cancelled);
  return {
    cloud: [cloud.orderId, held.orderId, early.orderId, late.orderId],
    pos: [hall.order_id, aggregator.order_id, cancelled.order_id],
  };
}

test('every KDS outbox event passes the strict POS kitchen stream or the strict cloud transport', () =>
  fixture(async (f) => {
    const b = f.scope.branchId;
    const orders = await kdsPaths(f);
    const rows = (await f.pool.query('SELECT * FROM fulfillment_outbox ORDER BY sequence')).rows;
    // No KDS key in any payload: every key is one the D0 edge already sent.
    for (const row of rows)
      for (const key of Object.keys(row.payload))
        assert.ok(D0_PAYLOAD_KEYS.has(key), row.event_type + ' ' + key);
    assert.ok(!JSON.stringify(rows.map((r) => r.payload)).match(/"(kds|delivery|handover)"/));

    // The real POS kitchen sender, against a cloud that parses like receivePosKitchen.
    const scope = await provisionEdgePosSync(f.pool, {
      organizationId: f.scope.organizationId,
      branchId: b,
      deviceId: f.scope.deviceId,
    });
    const identity = {
      device_id: f.scope.deviceId,
      branch_id: b,
      token: 'c'.repeat(64),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    };
    const posSeen = [];
    const posIo = {
      fetch: async (url, init) => {
        assert.equal(url, ORIGIN + '/internal/v1/edge/pos-orders/events');
        const raw = JSON.parse(init.body);
        PosKitchenEventSchema.parse(raw);
        const event = parseKitchenEvent(raw);
        assert.equal(event.producer_id, scope.producerId);
        posSeen.push(event);
        return json(kitchenReceiptFor(event));
      },
    };
    for (let turn = 0; turn < rows.length + 2; turn++) {
      const result = await syncPosKitchenOnce(
        f.pool,
        { enabled: true, branchId: b, origin: ORIGIN, identity },
        posIo,
      );
      if (result.state === 'idle') break;
      assert.equal(result.state, 'delivered', JSON.stringify(result));
    }

    // The real fulfillment transport worker, against a cloud that parses like recordEdgeEvent.
    const cloudSeen = [];
    const transportScope = {
      organizationId: f.scope.organizationId,
      branchId: b,
      deviceId: f.scope.deviceId,
      producerId: f.scope.producerId,
    };
    const cloudIo = {
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        if (url === ORIGIN + '/internal/v1/edge/fulfillment/events') {
          TransportEdgeEventSchema.parse(body);
          const event = EdgeEventSchema.parse(body);
          cloudSeen.push(event);
          return json({ eventId: event.eventId, acknowledged: true });
        }
        assert.equal(url, ORIGIN + '/internal/v1/edge/fulfillment/pull');
        return json({ scope: transportScope, event: null });
      },
    };
    for (let turn = 0; turn < rows.length + 2; turn++) {
      const result = await syncFulfillmentOnce(
        f.pool,
        { enabled: true, branchId: b, origin: ORIGIN, identity, protocolVersion: 2 },
        cloudIo,
      );
      if (result.state === 'idle') break;
      assert.equal(result.state, 'acknowledged', JSON.stringify(result));
    }

    // Each event went exactly once through the stream of its order, and both drained.
    const owner = new Map([
      ...orders.cloud.map((id) => [id, 'cloud']),
      ...orders.pos.map((id) => [id, 'pos']),
    ]);
    assert.equal(posSeen.length + cloudSeen.length, rows.length);
    assert.deepEqual(
      posSeen.map((e) => e.event_id),
      rows.filter((r) => owner.get(r.order_id) === 'pos').map((r) => r.event_id),
    );
    assert.deepEqual(
      cloudSeen.map((e) => e.eventId).sort(),
      rows
        .filter((r) => owner.get(r.order_id) === 'cloud')
        .map((r) => r.event_id)
        .sort(),
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int AS n FROM fulfillment_outbox WHERE acknowledged_at IS NULL',
        )
      ).rows[0].n,
      0,
    );
    // The paths really produced the KDS shapes: task events of the new stations (cascade of the
    // toasts at 5), the finishing stations 2 and 3, cancellation and release.
    const S = (fn) => kdsStationId(b, fn);
    const taskStations = new Set(
      rows.filter((r) => r.event_type === 'edge.task_changed').map((r) => r.payload.stationId),
    );
    for (const fn of ['toasts', 'assembly_hall', 'assembly_delivery', 'issue'])
      assert.ok(taskStations.has(S(fn)), fn);
    assert.deepEqual(
      [...new Set(rows.map((r) => r.payload.assemblyStationId))].sort(),
      [S('issue'), S('delivery_handover')].sort(),
    );
    const types = (stream) => [...new Set(stream.map((e) => e.event_type ?? e.type))].sort();
    assert.deepEqual(types(posSeen), [
      'edge.fulfillment_accepted',
      'edge.fulfillment_cancelled',
      'edge.fulfillment_handed_over',
      'edge.fulfillment_ready',
      'edge.task_changed',
    ]);
    assert.deepEqual(types(cloudSeen), [
      'edge.admission_released',
      'edge.admission_reserved',
      'edge.cancellation_requested',
      'edge.fulfillment_accepted',
      'edge.fulfillment_cancelled',
      'edge.fulfillment_handed_over',
      'edge.fulfillment_ready',
      'edge.task_changed',
    ]);
    assert.ok(
      cloudSeen.some((e) => e.type === 'edge.task_changed' && e.payload.taskState === 'cancelled'),
    );
    // The stub cloud is as strict as the real receivers: any KDS key in a payload stops a stream.
    const handed = posSeen.find((e) => e.event_type === 'edge.fulfillment_handed_over');
    const task = cloudSeen.find((e) => e.type === 'edge.task_changed');
    for (const extra of [
      { handover: MARKS },
      { delivery: { provider: 'yandex_eda', externalNumber: 'YA-808' } },
      { kds: { function: 'toasts' } },
      { upstreamOf: S('assembly_hall') },
    ]) {
      assert.throws(() =>
        parseKitchenEvent({ ...handed, payload: { ...handed.payload, ...extra } }),
      );
      assert.equal(
        EdgeEventSchema.safeParse({ ...task, payload: { ...task.payload, ...extra } }).success,
        false,
      );
    }
  }));
