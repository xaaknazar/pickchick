import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fixture } from './worker-fixture.mjs';
const manager = (f) => ({ ...f.commercialScope, role: 'manager' });
const cancel = (f) =>
  f.commerce.requestUnpaidCancellation(manager(f), randomUUID(), {
    orderId: f.order.orderId,
    reason: 'Synthetic cancellation',
  });
const current = (f) => f.commerce.readUnpaidCancellation(manager(f), f.order.orderId);
const expire = async (f) => {
  await f.pool.query(
    "UPDATE fulfillment_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE acknowledged_at IS NULL",
  );
  await f.pool.query(
    "UPDATE fulfillment_transport_reverse_failures SET retry_after=clock_timestamp()-interval '1 second' WHERE resolved_at IS NULL",
  );
};
test('actual HTTP v2 worker cancels unpaid order, no kitchen tasks/LED/financial effects; lost result response survives restart exactly', () =>
  fixture(async (f) => {
    await f.tick();
    await f.tick();
    await cancel(f);
    assert.equal((await f.tick()).state, 'applied');
    assert.equal((await current(f)).state, 'release_pending');
    // State released can arrive first and must not be mistaken for cancellation decision.
    await f.tick();
    assert.equal((await current(f)).state, 'release_pending');
    const sent = [];
    let lost = false;
    const fault = {
      fetch: async (url, init) => {
        const input = JSON.parse(init.body);
        if (input.type === 'edge.admission_release_result') sent.push(init.body);
        const response = await fetch(url, init);
        if (input.type === 'edge.admission_release_result' && !lost) {
          lost = true;
          await response.arrayBuffer();
          throw Error('Synthetic response lost');
        }
        return response;
      },
    };
    const failure = await f.tick(fault);
    assert.equal(failure.state, 'parked');
    assert.equal(failure.error, 'NETWORK_UNKNOWN');
    assert.equal((await current(f)).state, 'cancelled');
    await expire(f);
    await f.tick(fault);
    assert.equal(sent.length, 2);
    assert.equal(sent[0], sent[1]);
    assert.equal(await f.counts(f.cloud, 'commerce_cancellation_results'), '1');
    assert.equal(await f.counts(f.pool, 'fulfillment_release_results'), '1');
    for (const table of [
      'commerce_payment_attempts',
      'commerce_captures',
      'commerce_refunds',
      'commerce_fiscal_documents',
    ])
      assert.equal(await f.counts(f.cloud, table), '0');
    assert.equal(await f.counts(f.pool, 'fulfillment_tasks'), '0');
    const display = await (await f.lan('/display')).json();
    assert.deepEqual(display.items, []);
  }));

test('lost release ACK retains exact pending after terminal decision; repeated worker does not create a second release result', () =>
  fixture(async (f) => {
    await f.tick();
    await f.tick();
    await cancel(f);
    const ack = [];
    let lost = false;
    const fault = {
      fetch: async (url, init) => {
        if (url.endsWith('/ack')) ack.push(init.body);
        const response = await fetch(url, init);
        if (url.endsWith('/ack') && !lost) {
          lost = true;
          await response.arrayBuffer();
          throw Error('Synthetic ACK response lost');
        }
        return response;
      },
    };
    assert.equal((await f.tick(fault)).state, 'retry');
    assert.ok(
      (await f.pool.query('SELECT pending_cloud FROM fulfillment_transport_state')).rows[0]
        .pending_cloud,
    );
    await f.tick(fault);
    await f.tick();
    assert.equal(ack.length, 2);
    assert.equal(ack[0], ack[1]);
    assert.equal((await current(f)).state, 'cancelled');
    assert.equal(await f.counts(f.pool, 'fulfillment_release_results'), '1');
  }));

test('new worker against frozen protocol-v1 pull contract fails closed without silently downgrading or mutating edge', () =>
  fixture(async (f) => {
    const legacyPull = z
      .object({ workerId: z.uuid(), leaseSeconds: z.number().int().min(15).max(120) })
      .strict();
    let calls = 0;
    const fault = {
      fetch: async (url, init) => {
        assert.ok(url.endsWith('/pull'));
        calls++;
        const input = JSON.parse(init.body);
        assert.equal(input.protocolVersion, 2);
        assert.equal(legacyPull.safeParse(input).success, false);
        return new Response(
          JSON.stringify({
            code: 'INVALID_REQUEST',
            message_key: 'invalid_request',
            trace_id: randomUUID(),
            retryable: false,
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      },
    };
    const r = await f.tick(fault);
    assert.equal(r.state, 'retry');
    assert.equal(r.error, 'HTTP_REJECTED');
    assert.equal(calls, 1);
    assert.equal(await f.counts(f.pool, 'fulfillment_reservations'), '0');
    assert.equal(
      (await f.pool.query('SELECT pending_cloud FROM fulfillment_transport_state')).rows[0]
        .pending_cloud,
      null,
    );
    assert.equal(
      (await f.cloud.query('SELECT sum(attempts) AS count FROM commerce_outbox')).rows[0].count,
      '0',
    );
  }));

test('cloud015 and edge007 readiness are explicit; worker never touches network before edge007, off configuration stays independent', () =>
  fixture(async (f) => {
    assert.equal((await fetch(f.origin + '/health/ready')).status, 200);
    await f.cloud.query(
      "DELETE FROM schema_migrations WHERE version='015_cloud_unpaid_cancellation.sql'",
    );
    assert.equal((await fetch(f.origin + '/health/ready')).status, 503);
    await f.pool.query(
      "DELETE FROM schema_migrations WHERE version='007_edge_release_results.sql'",
    );
    assert.equal((await fetch(f.edgeOrigin + '/health/ready')).status, 503);
    const r = await f.tick({
      fetch() {
        throw Error('Network prohibited without v2 schema');
      },
    });
    assert.deepEqual(r, { state: 'blocked', error: 'SCHEMA_UNAVAILABLE' });
    assert.equal(await f.counts(f.pool, 'fulfillment_transport_state'), '0');
  }));
