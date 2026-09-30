import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { provisionDevice, revokeDevice } from '@pickchick/menu-sync';
import { createPool } from '@pickchick/database';
import { fulfillmentTransportGrants } from '../../../infra/staging/fulfillment-transport-grants.mjs';
import {
  provisionFulfillmentTransport,
  pullFulfillment,
  acknowledgeFulfillment,
  receiveFulfillment,
} from '../dist/cloud.js';
import { fixture, code } from './cloud-fixture.mjs';

test('real device admission is atomic, durable and replay-safe; no payment means no kitchen command', () =>
  fixture(async (f) => {
    const v = await f.reserve();
    const receipts = await Promise.all(
      Array.from({ length: 8 }, () => receiveFulfillment(f.pool, f.auth, v.event)),
    );
    assert.deepEqual(receipts, Array(8).fill({ eventId: v.event.eventId, acknowledged: true }));
    assert.equal(
      (await f.pool.query('SELECT count(*) FROM cloud_fulfillment_inbox')).rows[0].count,
      '1',
    );
    assert.equal(
      (await f.pool.query('SELECT count(*) FROM commerce_edge_inbox')).rows[0].count,
      '1',
    );
    const order = await f.commerce.readOrder(f.scope, v.orderId);
    assert.equal(order.state, 'awaiting_payment');
    assert.equal(
      (await f.pool.query('SELECT admission_device_id FROM commerce_orders')).rows[0]
        .admission_device_id,
      f.auth.deviceId,
    );
    await f.ack(v.delivery);
    assert.equal((await f.pull()).event, null);
    assert.equal(
      (await f.pool.query('SELECT state FROM cloud_fulfillment_projection')).rows[0].state,
      'held',
    );
    await assert.rejects(
      f.pool.query("UPDATE cloud_fulfillment_inbox SET request_hash=repeat('a',64)"),
      code('23514'),
    );
  }));

test('a failure writing transport inbox rolls back the actual commercial admission too', () =>
  fixture(async (f) => {
    const v = await f.reserve();
    await f.pool.query(
      "CREATE FUNCTION fail_transport() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic fault' USING ERRCODE='23514'; END $$",
    );
    await f.pool.query(
      'CREATE TRIGGER fail_transport BEFORE INSERT ON cloud_fulfillment_inbox FOR EACH ROW EXECUTE FUNCTION fail_transport()',
    );
    await assert.rejects(receiveFulfillment(f.pool, f.auth, v.event), code('23514'));
    assert.equal(
      (await f.pool.query('SELECT admission_reservation_id FROM commerce_orders')).rows[0]
        .admission_reservation_id,
      null,
    );
    for (const table of [
      'commerce_edge_inbox',
      'cloud_fulfillment_versions',
      'cloud_fulfillment_projection',
    ])
      assert.equal((await f.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '0');
    await f.pool.query('DROP TRIGGER fail_transport ON cloud_fulfillment_inbox');
    await receiveFulfillment(f.pool, f.auth, v.event);
    assert.equal(
      (await f.pool.query('SELECT admission_reservation_id FROM commerce_orders')).rows[0]
        .admission_reservation_id,
      v.reserved.reservationId,
    );
  }));

test('pull/ack are pinned to actual device and lease; legacy worker cannot steal enabled commands', () =>
  fixture(async (f) => {
    const value = await f.create();
    assert.deepEqual(
      await f.commerce.claimOutbox(f.manager, {
        workerId: randomUUID(),
        limit: 20,
        leaseSeconds: 15,
      }),
      [],
    );
    const deliveries = await Promise.all(Array.from({ length: 8 }, () => f.pull()));
    assert.equal(deliveries.filter((x) => x.event).length, 1);
    const d = deliveries.find((x) => x.event).event;
    await assert.rejects(
      acknowledgeFulfillment(f.pool, f.auth, {
        eventId: d.command.eventId,
        workerId: randomUUID(),
        leaseToken: d.leaseToken,
      }),
      code('CONFLICT'),
    );
    await assert.rejects(
      f.commerce.acknowledgeOutbox(f.manager, {
        eventId: d.command.eventId,
        workerId: f.workerId,
        leaseToken: d.leaseToken,
      }),
      code('CONFLICT'),
    );
    const other = randomUUID(),
      otherBranch = randomUUID();
    await f.pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'OTHER','Synthetic other')",
      [otherBranch, f.scope.organizationId, f.legal],
    );
    await f.pool.query(
      "INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES($1,$2,$3,'edge','Synthetic other')",
      [other, otherBranch, f.scope.organizationId],
    );
    const credential = await provisionDevice(f.pool, other),
      auth = { deviceId: other, token: credential.token };
    await assert.rejects(f.pull(auth), code('FORBIDDEN'));
    await assert.rejects(f.ack(d, auth), code('FORBIDDEN'));
    await f.pool.query(
      "UPDATE commerce_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [d.command.eventId],
    );
    await assert.rejects(f.ack(d), code('CONFLICT'));
    const retry = (await f.pull()).event;
    assert.equal(retry.command.eventId, d.command.eventId);
    assert.notEqual(retry.leaseToken, d.leaseToken);
    await assert.rejects(f.ack(d), code('CONFLICT'));
    await f.ack(retry);
    await f.ack(retry);
    assert.equal((await f.pull()).event, null);
    assert.equal(retry.command.payload.orderId, value.orderId);
    await f.pool.query('UPDATE fulfillment_transport_bindings SET active=false');
    await f.create();
    assert.equal(
      (
        await f.commerce.claimOutbox(f.manager, {
          workerId: randomUUID(),
          limit: 20,
          leaseSeconds: 15,
        })
      ).length,
      0,
    );
  }));

test('authenticated admission never accepts a claimed principal; expiry, rotation and revocation block replay', () =>
  fixture(async (f) => {
    const v = await f.reserve();
    const admission = {
      eventId: v.event.eventId,
      orderId: v.orderId,
      reservationId: v.reserved.reservationId,
      quoteDigest: v.quote.digest,
    };
    await assert.rejects(
      f.commerce.confirmAdmissionAuthenticated({ ...f.auth, token: 'a'.repeat(64) }, admission),
      code('UNAUTHORIZED'),
    );
    await assert.rejects(
      receiveFulfillment(f.pool, { ...f.auth, token: 'b'.repeat(64) }, v.event),
      code('UNAUTHORIZED'),
    );
    await f.pool.query(
      "UPDATE device_credentials SET issued_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second'",
    );
    await assert.rejects(f.pull(), code('UNAUTHORIZED'));
    const identity = await provisionDevice(f.pool, f.auth.deviceId, true),
      auth = { deviceId: f.auth.deviceId, token: identity.token };
    await assert.rejects(receiveFulfillment(f.pool, f.auth, v.event), code('UNAUTHORIZED'));
    await receiveFulfillment(f.pool, auth, v.event);
    await revokeDevice(f.pool, auth.deviceId);
    await assert.rejects(receiveFulfillment(f.pool, auth, v.event), code('UNAUTHORIZED'));
    await assert.rejects(f.ack(v.delivery, auth), code('UNAUTHORIZED'));
  }));

test('unknown order, wrong branch/owner/reservation and immutable event/sequence conflicts have no effect', () =>
  fixture(async (f) => {
    const v = await f.reserve(),
      clone = () => globalThis.structuredClone(v.event);
    let e = clone();
    e.payload.branchId = randomUUID();
    await assert.rejects(receiveFulfillment(f.pool, f.auth, e), code('FORBIDDEN'));
    e = clone();
    e.orderId = e.payload.orderId = randomUUID();
    await assert.rejects(receiveFulfillment(f.pool, f.auth, e), code('NOT_FOUND'));
    e = clone();
    e.payload.ownerHash = 'a'.repeat(64);
    await assert.rejects(receiveFulfillment(f.pool, f.auth, e), code('CONFLICT'));
    await receiveFulfillment(f.pool, f.auth, v.event);
    e = clone();
    e.payload.updatedAt = new Date(Date.parse(e.payload.updatedAt) + 1).toISOString();
    await assert.rejects(receiveFulfillment(f.pool, f.auth, e), code('CONFLICT'));
    e = clone();
    e.eventId = randomUUID();
    await assert.rejects(receiveFulfillment(f.pool, f.auth, e), code('CONFLICT'));
    e = clone();
    e.eventId = randomUUID();
    e.sequence = '999';
    e.payload.reservationId = randomUUID();
    await assert.rejects(receiveFulfillment(f.pool, f.auth, e), code('CONFLICT'));
    e = clone();
    e.eventId = randomUUID();
    e.sequence = '999';
    e.payload.updatedAt = new Date(Date.parse(e.payload.updatedAt) + 1).toISOString();
    await assert.rejects(receiveFulfillment(f.pool, f.auth, e), code('CONFLICT'));
    assert.equal(
      (await f.pool.query('SELECT count(*) FROM cloud_fulfillment_inbox')).rows[0].count,
      '1',
    );
  }));

test('out-of-order task/aggregate facts converge without changing cloud money or downgrading versions', () =>
  fixture(async (f) => {
    const v = await f.accepted();
    let current = await f.edge.complete(v.accepted);
    current = await f.edge.act(current, 'ready');
    current = await f.edge.act(current, 'handoff');
    const events = await f.events(v.orderId),
      before = await f.commerce.readOrder(f.scope, v.orderId);
    for (const e of events.toReversed()) await receiveFulfillment(f.pool, f.auth, e);
    const projection = (await f.pool.query('SELECT * FROM cloud_fulfillment_projection')).rows[0];
    assert.equal(projection.state, 'handed_over');
    assert.equal(projection.version, current.version);
    const tasks = (await f.pool.query('SELECT * FROM cloud_fulfillment_observed_tasks')).rows;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].state, 'done');
    assert.equal(tasks[0].version, 3);
    assert.deepEqual(await f.commerce.readOrder(f.scope, v.orderId), before);
    assert.equal(
      (await f.pool.query('SELECT count(*) FROM cloud_fulfillment_inbox')).rows[0].count,
      String(events.length),
    );
    const task = globalThis.structuredClone(events.find((e) => e.type === 'edge.task_changed'));
    task.eventId = randomUUID();
    task.sequence = '999';
    task.aggregateVersion = task.payload.version = 99;
    task.payload.taskState = 'done';
    await assert.rejects(receiveFulfillment(f.pool, f.auth, task), code('CONFLICT'));
    assert.equal(
      (await f.pool.query('SELECT version FROM cloud_fulfillment_projection')).rows[0].version,
      current.version,
    );
  }));

test('capture alone cannot dispatch; fiscal gate, attention and refund guards remain on the real outbox', () =>
  fixture(async (f) => {
    const v = await f.reserve();
    await f.confirm(v);
    const view = await f.capture(v);
    assert.equal((await f.pull()).event, null);
    const sale = view.fiscalDocuments[0];
    await f.commerce.observeFiscal(
      { organizationId: f.scope.organizationId, branchId: f.scope.branchId, accountId: f.fiscal },
      {
        eventId: randomUUID(),
        documentId: sale.id,
        outcome: 'issued',
        providerDocumentId: randomUUID(),
        fiscalMark: 'synthetic',
        receiptUrl: 'https://example.invalid/receipt',
        amountMinor: sale.amount_minor,
        occurredAt: new Date().toISOString(),
      },
    );
    await f.pool.query('UPDATE commerce_orders SET attention_required=true WHERE id=$1', [
      v.orderId,
    ]);
    assert.equal((await f.pull()).event, null);
    await f.pool.query('UPDATE commerce_orders SET attention_required=false WHERE id=$1', [
      v.orderId,
    ]);
    const refund = await f.commerce.requestRefund(f.manager, randomUUID(), {
      orderId: v.orderId,
      captureId: view.captures[0].id,
      amountMinor: '100',
      reason: 'Synthetic refund review',
      fulfillmentPolicy: 'manager_reviewed',
    });
    assert.ok(refund);
    assert.equal((await f.pull()).event, null);
    const legacy = await f.commerce.claimOutbox(f.manager, {
      workerId: randomUUID(),
      limit: 20,
      leaseSeconds: 15,
    });
    assert.ok(legacy.some((e) => e.event_type === 'refund.submit_requested'));
    assert.ok(legacy.every((e) => !e.event_type.startsWith('edge.')));
  }));

test('trusted binding is idempotent and cannot silently replace a pinned edge', () =>
  fixture(async (f) => {
    assert.deepEqual(await provisionFulfillmentTransport(f.pool, f.edge.scope), f.edge.scope);
    await assert.rejects(
      provisionFulfillmentTransport(f.pool, { ...f.edge.scope, producerId: randomUUID() }),
      code('CONFLICT'),
    );
    await assert.rejects(
      f.pool.query('UPDATE fulfillment_transport_bindings SET producer_id=$1', [randomUUID()]),
      code('23514'),
    );
    await assert.rejects(f.pool.query('DELETE FROM fulfillment_transport_bindings'), code('23514'));
  }));

test('restricted runtime can transport facts but cannot write captures/refunds or provision; disable revokes effects', () =>
  fixture(async (f) => {
    const role = 'transport_runtime_' + randomUUID().replaceAll('-', '');
    let limited;
    await f.admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    try {
      await f.pool.query(`GRANT USAGE ON SCHEMA ${f.schema} TO ${role}`);
      // Existing menu/device auth baseline, separate from transport grants.
      await f.pool.query(
        `GRANT SELECT ON devices,device_credentials,branches TO ${role}; GRANT UPDATE(id) ON devices TO ${role}; GRANT UPDATE(device_id) ON device_credentials TO ${role}`,
      );
      await f.pool.query(fulfillmentTransportGrants(role, true));
      const url = new URL(f.url);
      url.searchParams.set('options', `-c search_path=${f.schema} -c role=${role}`);
      limited = createPool(url.toString(), 4);
      const v = await f.create(),
        delivery = (
          await pullFulfillment(limited, f.auth, { workerId: f.workerId, leaseSeconds: 15 })
        ).event;
      await f.edge.repo.acceptCloud(f.edge.scope, delivery.command);
      const event = (await f.events(v.orderId))[0];
      await receiveFulfillment(limited, f.auth, event);
      await acknowledgeFulfillment(limited, f.auth, {
        eventId: delivery.command.eventId,
        workerId: f.workerId,
        leaseToken: delivery.leaseToken,
      });
      await f.issue(v);
      const authorization = (
        await pullFulfillment(limited, f.auth, { workerId: f.workerId, leaseSeconds: 15 })
      ).event;
      assert.equal(authorization.command.type, 'edge.kitchen_admission_requested');
      await f.edge.repo.acceptCloud(f.edge.scope, authorization.command);
      await receiveFulfillment(limited, f.auth, (await f.events(v.orderId)).at(-1));
      for (const table of [
        'commerce_captures',
        'commerce_refund_effects',
        'commerce_refunds',
        'fulfillment_transport_bindings',
      ]) {
        assert.equal(
          (
            await limited.query("SELECT has_table_privilege(current_user,$1,'INSERT') AS allowed", [
              table,
            ])
          ).rows[0].allowed,
          false,
        );
        await assert.rejects(limited.query(`INSERT INTO ${table} DEFAULT VALUES`), code('42501'));
      }
      await assert.rejects(
        limited.query('UPDATE fulfillment_transport_bindings SET active=false'),
        code('42501'),
      );
      await f.pool.query(fulfillmentTransportGrants(role, false));
      for (const table of [
        'cloud_fulfillment_inbox',
        'cloud_fulfillment_projection',
        'commerce_orders',
        'commerce_outbox',
      ]) {
        assert.equal(
          (
            await limited.query(
              "SELECT has_table_privilege(current_user,$1,'INSERT') OR has_any_column_privilege(current_user,$1,'UPDATE') AS allowed",
              [table],
            )
          ).rows[0].allowed,
          false,
        );
      }
      await assert.rejects(
        pullFulfillment(limited, f.auth, { workerId: f.workerId, leaseSeconds: 15 }),
        code('42501'),
      );
      assert.equal(
        (
          await limited.query(
            "SELECT has_table_privilege(current_user,'device_credentials','SELECT') AS allowed",
          )
        ).rows[0].allowed,
        true,
      );
    } finally {
      if (limited) await limited.end();
      await f.pool.query(`DROP OWNED BY ${role}`);
      await f.admin.query(`DROP ROLE ${role}`);
    }
  }));

test('revocation waits for the actual authenticated receive transaction, then even replay is denied', () =>
  fixture(async (f) => {
    const v = await f.reserve();
    let entered, release;
    const reached = new Promise((resolve) => {
        entered = resolve;
      }),
      resume = new Promise((resolve) => {
        release = resolve;
      });
    const wrapped = {
      connect: async () => {
        const client = await f.pool.connect(),
          query = client.query.bind(client);
        let held = false;
        client.query = async (...args) => {
          const result = await query(...args);
          if (
            !held &&
            typeof args[0] === 'string' &&
            args[0].includes('FROM fulfillment_transport_bindings')
          ) {
            held = true;
            entered();
            await resume;
          }
          return result;
        };
        const oldRelease = client.release.bind(client);
        client.release = (...args) => {
          client.query = query;
          oldRelease(...args);
        };
        return client;
      },
    };
    const receiving = receiveFulfillment(wrapped, f.auth, v.event);
    await reached;
    const revoking = revokeDevice(f.pool, f.auth.deviceId);
    try {
      const deadline = Date.now() + 3000;
      let blocked = false;
      while (Date.now() < deadline) {
        blocked = !!(
          await f.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE query LIKE 'UPDATE devices SET status = %' AND wait_event_type='Lock' AND pid<>pg_backend_pid()",
          )
        ).rowCount;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, 'revocation must wait on the real device auth shared lock');
    } finally {
      release();
    }
    await receiving;
    await revoking;
    assert.equal(
      (await f.pool.query('SELECT count(*) FROM cloud_fulfillment_inbox')).rows[0].count,
      '1',
    );
    await assert.rejects(receiveFulfillment(f.pool, f.auth, v.event), code('UNAUTHORIZED'));
  }));

test('released admission rejects new payment; an exact previous attempt replay remains immutable', () =>
  fixture(async (f) => {
    const first = await f.reserve();
    await f.confirm(first);
    const key = randomUUID(),
      request = { orderId: first.orderId, providerAccountId: f.payment };
    const attempt = await f.commerce.startPaymentAttempt(f.scope, key, request);
    const released = await f.edge.repo.acceptCloud(
      f.edge.scope,
      f.edge.cancel(first.reserved, 'edge.admission_release_requested'),
    );
    await receiveFulfillment(f.pool, f.auth, (await f.events(first.orderId)).at(-1));
    assert.equal(released.state, 'released');
    assert.deepEqual(await f.commerce.startPaymentAttempt(f.scope, key, request), attempt);
    await assert.rejects(
      f.commerce.startPaymentAttempt(f.scope, randomUUID(), request),
      code('NOT_READY'),
    );
    const second = await f.reserve();
    await f.confirm(second);
    await f.edge.repo.acceptCloud(
      f.edge.scope,
      f.edge.cancel(second.reserved, 'edge.admission_release_requested'),
    );
    await receiveFulfillment(f.pool, f.auth, (await f.events(second.orderId)).at(-1));
    await assert.rejects(
      f.commerce.startPaymentAttempt(f.scope, randomUUID(), {
        orderId: second.orderId,
        providerAccountId: f.payment,
      }),
      code('NOT_READY'),
    );
    assert.equal(
      (await f.pool.query('SELECT count(*) FROM commerce_payment_attempts')).rows[0].count,
      '1',
    );
  }));

test('release receive owns the same order lock as payment start: a waiting attempt sees terminal admission', () =>
  fixture(async (f) => {
    const v = await f.reserve();
    await f.confirm(v);
    await f.edge.repo.acceptCloud(
      f.edge.scope,
      f.edge.cancel(v.reserved, 'edge.admission_release_requested'),
    );
    const released = (await f.events(v.orderId)).at(-1);
    let entered, release;
    const reached = new Promise((resolve) => {
        entered = resolve;
      }),
      resume = new Promise((resolve) => {
        release = resolve;
      });
    const wrapped = {
      connect: async () => {
        const client = await f.pool.connect(),
          query = client.query.bind(client);
        let held = false;
        client.query = async (...args) => {
          const result = await query(...args);
          if (
            !held &&
            typeof args[0] === 'string' &&
            args[0].includes('FROM commerce_orders') &&
            args[0].includes('FOR UPDATE')
          ) {
            held = true;
            entered();
            await resume;
          }
          return result;
        };
        const oldRelease = client.release.bind(client);
        client.release = (...args) => {
          client.query = query;
          oldRelease(...args);
        };
        return client;
      },
    };
    const receiving = receiveFulfillment(wrapped, f.auth, released);
    await reached;
    const attempt = f.commerce.startPaymentAttempt(f.scope, randomUUID(), {
      orderId: v.orderId,
      providerAccountId: f.payment,
    });
    // Attach rejection handling immediately; the rejection is the expected result.
    const result = attempt.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      const deadline = Date.now() + 3000;
      let blocked = false;
      while (Date.now() < deadline) {
        blocked = !!(
          await f.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE query LIKE 'SELECT * FROM commerce_orders%' AND wait_event_type='Lock' AND pid<>pg_backend_pid()",
          )
        ).rowCount;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, 'payment must wait for the same actual commercial order lock');
    } finally {
      release();
    }
    await receiving;
    assert.equal((await result).error?.code, 'NOT_READY');
    assert.equal(
      (await f.pool.query('SELECT count(*) FROM commerce_payment_attempts')).rows[0].count,
      '0',
    );
  }));

test('historical paused binding fences generic claim and old generic ACK after local durable commit', () =>
  fixture(
    async (f) => {
      const value = await f.create();
      const workerId = randomUUID();
      const [legacy] = await f.commerce.claimOutbox(f.manager, {
        workerId,
        limit: 1,
        leaseSeconds: 30,
      });
      assert.ok(legacy);
      await provisionFulfillmentTransport(f.pool, f.edge.scope);
      await f.edge.repo.acceptCloud(f.edge.scope, {
        eventId: legacy.id,
        type: legacy.event_type,
        payload: legacy.payload,
      });
      assert.equal(await f.edge.count('fulfillment_inbox'), 1);
      await f.pool.query('UPDATE fulfillment_transport_bindings SET active=false');
      await assert.rejects(
        f.commerce.acknowledgeOutbox(f.manager, {
          eventId: legacy.id,
          workerId,
          leaseToken: legacy.lease_token,
        }),
        code('CONFLICT'),
      );
      await f.pool.query(
        "UPDATE commerce_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [legacy.id],
      );
      assert.deepEqual(
        await f.commerce.claimOutbox(f.manager, {
          workerId: randomUUID(),
          limit: 20,
          leaseSeconds: 30,
        }),
        [],
      );
      await assert.rejects(f.pull(), code('FORBIDDEN'));
      assert.equal(
        (
          await f.pool.query('SELECT acknowledged_at FROM commerce_outbox WHERE order_id=$1', [
            value.orderId,
          ])
        ).rows[0].acknowledged_at,
        null,
      );
    },
    { bind: false },
  ));

test('paused binding blocks new payment but preserves an existing exact retry', () =>
  fixture(async (f) => {
    const value = await f.reserve();
    await f.confirm(value);
    const key = randomUUID(),
      input = { orderId: value.orderId, providerAccountId: f.payment };
    const old = await f.commerce.startPaymentAttempt(f.scope, key, input);
    await f.pool.query('UPDATE fulfillment_transport_bindings SET active=false');
    assert.deepEqual(await f.commerce.startPaymentAttempt(f.scope, key, input), old);
    await assert.rejects(
      f.commerce.startPaymentAttempt(f.scope, randomUUID(), input),
      code('NOT_READY'),
    );
    assert.equal(
      (await f.pool.query('SELECT count(*) FROM commerce_payment_attempts')).rows[0].count,
      '1',
    );
  }));

test('deferred fiscal pilot still needs authenticated edge admission and actual capture to reach kitchen', () =>
  fixture(
    async (f) => {
      const v = await f.reserve();
      await f.confirm(v);
      assert.equal((await f.pull()).event, null);
      const paid = await f.capture(v);
      assert.equal(paid.fiscalDocuments.length, 0);
      const delivery = (await f.pull()).event;
      assert.equal(delivery.command.type, 'edge.kitchen_admission_requested');
      await f.edge.repo.acceptCloud(f.edge.scope, delivery.command);
      await receiveFulfillment(f.pool, f.auth, (await f.events(v.orderId)).at(-1));
      await f.ack(delivery);
      assert.equal((await f.pull()).event, null);
      assert.equal(
        (
          await f.pool.query('SELECT state FROM cloud_fulfillment_projection WHERE order_id=$1', [
            v.orderId,
          ])
        ).rows[0].state,
        'accepted',
      );
    },
    { deferred: true },
  ));
