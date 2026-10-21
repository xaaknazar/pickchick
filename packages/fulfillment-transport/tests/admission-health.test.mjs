// Release fixes 2026-10-19 (audit 1.0, 1.1, 1.6): one refused order never blocks the branch.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { branchAvailability } from '@pickchick/commerce-core';
import { fixture } from './worker-fixture.mjs';
import { syncFulfillmentOnce } from '../dist/index.js';
import { fulfillmentWorkerGrants } from '../../../infra/windows/fulfillment-worker-grants.mjs';

const state = async (f) =>
  (await f.pool.query('SELECT * FROM fulfillment_transport_state')).rows[0];
const expireCloud = (f) =>
  f.cloud.query(
    "UPDATE commerce_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE acknowledged_at IS NULL",
  );
const ordering = (f, enabled) =>
  f.pool.query('UPDATE branch_config SET ordering_enabled=$2 WHERE id=$1', [
    f.scope.branchId,
    enabled,
  ]);
const cloudAvailability = async (f) =>
  (await f.cloud.query('SELECT * FROM cloud_branch_availability')).rows[0];
const reservation = async (f, orderId) =>
  (await f.pool.query('SELECT state FROM fulfillment_reservations WHERE order_id=$1', [orderId]))
    .rows[0]?.state;

async function restricted(f, run) {
  const role = 'transport_' + randomUUID().replaceAll('-', '');
  const schema = (await f.pool.query('SELECT current_schema() AS name')).rows[0].name;
  await f.pool.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  let pool;
  try {
    await f.pool.query(fulfillmentWorkerGrants(role, schema));
    const url = new URL(f.url);
    url.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
    pool = createPool(url.toString(), 4);
    await run(() => syncFulfillmentOnce(pool, f.options));
  } finally {
    if (pool) await pool.end();
    await f.pool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
  }
}

test('a cashier that closed ordering defers only that admission; a paid order still reaches the kitchen', () =>
  fixture(async (f) => {
    assert.equal((await f.tick()).state, 'applied');
    assert.equal(await reservation(f, f.order.orderId), 'held');
    await ordering(f, false);
    const later = await f.createAdditional('fries');
    // Before the fix this turn kept the order pending forever and never pulled again.
    const refused = await f.tick();
    assert.equal(refused.state, 'deferred');
    assert.equal(refused.error, 'LOCAL_NOT_READY');
    assert.equal(refused.reason, 'NOT_READY');
    assert.equal(refused.reported, true);
    assert.equal((await state(f)).pending_cloud, null);
    // The closed cashier reached the cloud: kiosk and mobile stop selling with it.
    assert.equal((await cloudAvailability(f)).ordering_closed, true);
    assert.equal((await branchAvailability(f.cloud, f.scope.branchId)).fresh, false);
    // An unpaid refusal is not a manager case.
    assert.equal(
      (await f.commerce.readOrder(f.commercialScope, later.orderId)).state,
      'awaiting_admission',
    );
    const { sale } = await f.pay();
    await f.fiscalize(sale);
    const admitted = await f.tick();
    assert.equal(admitted.state, 'applied');
    assert.equal(await reservation(f, f.order.orderId), 'accepted');
    assert.equal(await reservation(f, later.orderId), undefined);
    await ordering(f, true);
    await expireCloud(f);
    assert.equal((await f.tick()).state, 'applied');
    assert.equal(await reservation(f, later.orderId), 'held');
    assert.equal((await cloudAvailability(f)).ordering_closed, false);
    assert.equal((await branchAvailability(f.cloud, f.scope.branchId)).fresh, true);
  }));

test('a paid order the cashier can no longer admit is reported and becomes a manager case', () =>
  fixture(async (f) => {
    assert.equal((await f.tick()).state, 'applied');
    assert.equal((await f.tick()).state, 'acknowledged');
    const { sale } = await f.pay();
    await f.fiscalize(sale);
    // The cashier database was restored from a backup older than this reservation.
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role=replica');
      for (const table of ['fulfillment_outbox', 'fulfillment_inbox', 'fulfillment_reservations'])
        await client.query(`DELETE FROM ${table}`);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const refused = await f.tick();
    assert.equal(refused.state, 'deferred');
    assert.equal(refused.reason, 'NOT_FOUND');
    assert.equal(refused.reported, true);
    const order = await f.commerce.readOrder(f.commercialScope, f.order.orderId);
    assert.equal(order.state, 'attention_required');
    const issue = (
      await f.cloud.query(
        'SELECT code,details FROM commerce_reconciliation_issues WHERE order_id=$1',
        [f.order.orderId],
      )
    ).rows;
    assert.deepEqual(issue, [
      {
        code: 'KITCHEN_ADMISSION_REFUSED',
        details: { reason: 'NOT_FOUND', eventType: 'edge.kitchen_admission_requested' },
      },
    ]);
    // Never delivered again on its own; the branch keeps working.
    await expireCloud(f);
    assert.equal((await f.tick()).state, 'idle');
    const other = await f.createAdditional('fries');
    assert.equal((await f.tick()).state, 'applied');
    assert.equal(await reservation(f, other.orderId), 'held');
  }));

test('an older cloud without the new pull fields still gets the heartbeat and the deferral', () =>
  fixture(async (f) => {
    const seen = [];
    const io = {
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        if (
          url.endsWith('/pull') &&
          (body.admissionRefusals || body.availability?.orderingEnabled !== undefined)
        ) {
          seen.push('rejected');
          return new Response(
            JSON.stringify({
              code: 'INVALID_REQUEST',
              message_key: 'error.invalid_request',
              trace_id: randomUUID(),
              retryable: false,
            }),
            {
              status: 400,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        if (url.endsWith('/pull')) seen.push('plain');
        return fetch(url, init);
      },
    };
    await ordering(f, false);
    const refused = await f.tick(io);
    assert.equal(refused.state, 'deferred');
    assert.equal(refused.reported, false);
    assert.equal(seen[0], 'rejected');
    assert.ok(seen.includes('plain'));
    const availability = await cloudAvailability(f);
    assert.ok(availability);
    assert.equal(availability.ordering_closed, false);
    // The fields stay off for this cloud for a while: no more rejected requests.
    seen.length = 0;
    await expireCloud(f);
    await f.tick(io);
    assert.ok(!seen.includes('rejected'));
  }));

test('restoring the cashier database cannot rewind the heartbeat revision', () =>
  fixture(async (f) => {
    assert.equal((await f.tick()).state, 'applied');
    // The backup is taken here; hours of turns (one per second) move the counter on after it.
    const backup = (await state(f)).attempts;
    await f.pool.query('UPDATE fulfillment_transport_state SET attempts=attempts+20000');
    await f.tick();
    const before = (await cloudAvailability(f)).revision;
    // The restore brings back the old counter; the cloud last saw the cashier an hour ago.
    await f.pool.query('UPDATE fulfillment_transport_state SET attempts=$1', [backup]);
    await f.cloud.query(
      "UPDATE cloud_branch_availability SET observed_at=clock_timestamp()-interval '1 hour'",
    );
    await f.tick();
    const after = await cloudAvailability(f);
    // Before the fix the restored counter stayed below the cloud revision and was ignored.
    assert.ok(BigInt(after.revision) > BigInt(before));
    assert.equal(
      (await branchAvailability(f.cloud, f.scope.branchId)).fresh,
      true,
      'the restored cashier is fresh again at once',
    );
  }));

test('the dedicated Windows worker role can report a closed cashier and a refusal', () =>
  fixture(async (f) =>
    restricted(f, async (tick) => {
      await ordering(f, false);
      const refused = await tick();
      assert.equal(refused.state, 'deferred');
      assert.equal(refused.reported, true);
      assert.equal((await cloudAvailability(f)).ordering_closed, true);
    }),
  ));

// QA 20.10 (release-fixes-1019), audit S10 (1.0): several orders the cashier refuses for
// different reasons (a stopped item, then closed ordering) never hold back a paid order's kitchen
// admission or an unrelated new order, and a refused order keeps coming back without starving.
test('QA S10: mixed refusals never hold back a paid kitchen admission or a ready order', () =>
  fixture(async (f) => {
    const { localSelectionIds } = await import('@pickchick/menu-sync');
    assert.equal((await f.tick()).state, 'applied');
    assert.equal(await reservation(f, f.order.orderId), 'held');
    const fries = await f.createAdditional('fries');
    await f.pool.query(
      "INSERT INTO local_stops(branch_id,variant_id,stopped,version,reason) VALUES($1,$2,true,1,'QA stop')",
      [f.scope.branchId, localSelectionIds(f.scope.branchId, 'fries', [])[0]],
    );
    // The stopped order is refused and deferred alone.
    const refused = await f.tick();
    assert.equal(refused.state, 'deferred');
    assert.equal(refused.reason, 'ITEM_STOPPED');
    assert.equal((await state(f)).pending_cloud, null);
    // The guest of the held order pays meanwhile: its kitchen admission goes first.
    const { sale } = await f.pay();
    await f.fiscalize(sale);
    const burger = await f.createAdditional('burger');
    assert.equal((await f.tick()).state, 'applied');
    assert.equal(await reservation(f, f.order.orderId), 'accepted');
    // An unrelated new order is reserved while the refused one sits out its lease.
    assert.equal((await f.tick()).state, 'applied');
    assert.equal(await reservation(f, burger.orderId), 'held');
    // Leases lapse: the refused order is retried and refused again, never parked as a failure.
    await expireCloud(f);
    const again = await f.tick();
    assert.equal(again.state, 'deferred');
    assert.equal(again.reason, 'ITEM_STOPPED');
    assert.equal(again.unresolvedFailures, 0);
    assert.equal(await reservation(f, fries.orderId), undefined);
    // The cashier now closes ordering: kiosk and mobile stop selling, nothing else is blocked.
    await ordering(f, false);
    await expireCloud(f);
    const closed = await f.tick();
    assert.equal(closed.state, 'deferred');
    assert.equal((await cloudAvailability(f)).ordering_closed, true);
    assert.equal((await branchAvailability(f.cloud, f.scope.branchId)).fresh, false);
    // Unpaid refusals are never manager cases; the stop lifted and ordering reopened, it is held.
    assert.equal(
      (await f.commerce.readOrder(f.commercialScope, fries.orderId)).state,
      'awaiting_admission',
    );
    await f.pool.query('UPDATE local_stops SET stopped=false,version=2');
    await ordering(f, true);
    await expireCloud(f);
    assert.equal((await f.tick()).state, 'applied');
    assert.equal(await reservation(f, fries.orderId), 'held');
  }));
