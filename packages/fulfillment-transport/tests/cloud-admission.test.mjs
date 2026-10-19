// Release fixes 2026-10-19 (audit 1.0, 1.1, 1.6): cloud side of kitchen admission health.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { branchAvailability } from '@pickchick/commerce-core';
import { pullFulfillment } from '../dist/cloud.js';
import { fixture } from './cloud-fixture.mjs';

const heartbeat = (f, revision, extra = {}, availability = {}) =>
  pullFulfillment(f.pool, f.auth, {
    workerId: randomUUID(),
    leaseSeconds: 15,
    availabilityOnly: true,
    availability: { revision, stoppedIds: [], ...availability },
    ...extra,
  });
const expire = (f) =>
  f.pool.query(
    "UPDATE commerce_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE acknowledged_at IS NULL",
  );
const issues = async (f, orderId) =>
  (
    await f.pool.query(
      'SELECT code,details FROM commerce_reconciliation_issues WHERE order_id=$1 ORDER BY code',
      [orderId],
    )
  ).rows;
/** Paid and fiscalized: the kitchen admission command is waiting for the cashier. */
async function paid(f) {
  const value = await f.reserve();
  await f.confirm(value);
  await f.issue(value);
  return value;
}

test('a paid order the cashier refused becomes a manager case at once and is never delivered again', () =>
  fixture(async (f) => {
    const value = await paid(f);
    const delivery = (await f.pull()).event;
    assert.equal(delivery.command.type, 'edge.kitchen_admission_requested');
    const refusal = { eventId: delivery.command.eventId, reason: 'NOT_FOUND' };
    assert.equal((await heartbeat(f, '10', { admissionRefusals: [refusal] })).event, null);
    // A repeated report (the command came back and was refused again) changes nothing.
    await heartbeat(f, '11', { admissionRefusals: [refusal] });
    const order = await f.commerce.readOrder(f.scope, value.orderId);
    assert.equal(order.state, 'attention_required');
    assert.equal(order.attentionRequired, true);
    assert.deepEqual(await issues(f, value.orderId), [
      {
        code: 'KITCHEN_ADMISSION_REFUSED',
        details: { reason: 'NOT_FOUND', eventType: 'edge.kitchen_admission_requested' },
      },
    ]);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM commerce_outbox WHERE order_id=$1 AND event_type='commerce.review_required'",
          [value.orderId],
        )
      ).rows[0].n,
      1,
    );
    await expire(f);
    assert.equal((await f.pull()).event, null);
  }));

test('an unpaid refused admission or a foreign command id has no commercial effect', () =>
  fixture(async (f) => {
    const value = await f.create();
    const delivery = (await f.pull()).event;
    assert.equal(delivery.command.type, 'edge.admission_requested');
    await heartbeat(f, '10', {
      admissionRefusals: [
        { eventId: delivery.command.eventId, reason: 'NOT_READY' },
        { eventId: randomUUID(), reason: 'CONFLICT' },
      ],
    });
    const order = await f.commerce.readOrder(f.scope, value.orderId);
    assert.equal(order.attentionRequired, false);
    assert.deepEqual(await issues(f, value.orderId), []);
    // Still durable: the command comes back after its lease.
    await expire(f);
    assert.equal((await f.pull()).event.command.eventId, delivery.command.eventId);
  }));

test('a paid order not admitted within the review window goes to review instead of a late kitchen', () =>
  fixture(async (f) => {
    const late = await f.reserve();
    const fresh = await f.reserve();
    for (const value of [late, fresh]) await f.confirm(value);
    for (const value of [late, fresh]) await f.issue(value);
    // Paid 20 minutes ago (captures are immutable; the test bypasses only that guard).
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role=replica');
      await client.query(
        "UPDATE commerce_captures SET received_at=clock_timestamp()-interval '20 minutes' WHERE order_id=$1",
        [late.orderId],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const pull = (minutes) =>
      pullFulfillment(
        f.pool,
        f.auth,
        { workerId: f.workerId, leaseSeconds: 15 },
        { admissionReviewMinutes: minutes, reviewIntervalMs: 0 },
      );
    // Off: the old behaviour, the late order is still delivered.
    const before = (await pull(0)).event;
    assert.equal(before.command.payload.orderId, late.orderId);
    await expire(f);
    const delivered = (await pull(15)).event;
    assert.equal(delivered.command.payload.orderId, fresh.orderId);
    assert.equal((await f.commerce.readOrder(f.scope, late.orderId)).state, 'attention_required');
    assert.deepEqual(await issues(f, late.orderId), [
      { code: 'KITCHEN_ADMISSION_OVERDUE', details: { minutes: 15 } },
    ]);
    assert.deepEqual(await issues(f, fresh.orderId), []);
    await f.ack(delivered);
    await expire(f);
    assert.equal((await pull(15)).event, null);
  }));

test('a closed cashier is not fresh for kiosk and mobile; reopening restores it', () =>
  fixture(async (f) => {
    await heartbeat(f, '10', {}, { orderingEnabled: false });
    const closed = await f.pool.query('SELECT ordering_closed FROM cloud_branch_availability');
    assert.equal(closed.rows[0].ordering_closed, true);
    assert.equal((await branchAvailability(f.pool, f.scope.branchId)).fresh, false);
    await heartbeat(f, '11');
    const open = await f.pool.query('SELECT ordering_closed FROM cloud_branch_availability');
    assert.equal(open.rows[0].ordering_closed, false);
    assert.equal((await branchAvailability(f.pool, f.scope.branchId)).fresh, true);
  }));

test('a replacement cashier device takes over the availability row; replays stay ignored', () =>
  fixture(async (f) => {
    const previous = randomUUID();
    await f.pool.query(
      "INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES($1,$2,$3,'edge','Previous')",
      [previous, f.scope.branchId, f.scope.organizationId],
    );
    await f.pool.query(
      "INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids,observed_at) VALUES($1,$2,'9000000000000000',$3,clock_timestamp()-interval '1 hour')",
      [f.scope.branchId, previous, [randomUUID()]],
    );
    await heartbeat(f, '5');
    let row = (await f.pool.query('SELECT * FROM cloud_branch_availability')).rows[0];
    assert.equal(row.device_id, f.auth.deviceId);
    assert.equal(row.revision, '5');
    assert.deepEqual(row.stopped_ids, []);
    // The bound device's own older revision is still a replay.
    await heartbeat(f, '4', {}, { stoppedIds: [randomUUID()] });
    row = (await f.pool.query('SELECT * FROM cloud_branch_availability')).rows[0];
    assert.equal(row.revision, '5');
    assert.deepEqual(row.stopped_ids, []);
  }));
