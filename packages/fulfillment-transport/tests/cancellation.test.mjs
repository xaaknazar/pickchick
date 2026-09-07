import { createPool } from '@pickchick/database';
import { fulfillmentTransportGrants } from '../../../infra/staging/fulfillment-transport-grants.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture, code } from './cloud-fixture.mjs';
import { pullFulfillment, receiveFulfillment, acknowledgeFulfillment } from '../dist/index.js';
const request = (v) => ({ orderId: v.orderId, reason: 'Synthetic guest changed their mind' });
const cancel = (f, v, key = randomUUID()) =>
  f.commerce.requestUnpaidCancellation(f.manager, key, request(v));
const pull2 = (f) =>
  pullFulfillment(f.pool, f.auth, { workerId: f.workerId, leaseSeconds: 15, protocolVersion: 2 });
const current = (f, v) => f.commerce.readUnpaidCancellation(f.manager, v.orderId);
const count = async (pool, table) =>
  Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
const attempt = (f, v, key = randomUUID()) =>
  f.commerce.startPaymentAttempt(f.scope, key, {
    orderId: v.orderId,
    providerAccountId: f.payment,
  });

test('unpaid held: immutable release, ACK is not cancellation, authenticated result is final; late state and exact replay preserve money', () =>
  fixture(async (f) => {
    const v = await f.reserve();
    await f.confirm(v);
    const before = await f.commerce.readOrder(f.scope, v.orderId),
      key = randomUUID();
    const receipt = await cancel(f, v, key);
    assert.equal(receipt.state, 'release_pending');
    assert.equal((await f.pull()).event, null, 'v1 workers never receive release');
    await assert.rejects(attempt(f, v), code('NOT_READY'));
    const d = (await pull2(f)).event;
    assert.equal(d.command.eventId, receipt.releaseEventId);
    const result = await f.edge.repo.acceptRelease(f.edge.scope, d.command);
    assert.equal(result.outcome, 'applied');
    assert.equal(result.version, 2);
    await f.ack(d);
    assert.equal((await current(f, v)).state, 'release_pending');
    const events = await f.events(v.orderId),
      state = events.find((e) => e.type === 'edge.admission_released'),
      decision = events.find((e) => e.type === 'edge.admission_release_result');
    await receiveFulfillment(f.pool, f.auth, decision);
    assert.equal((await current(f, v)).state, 'cancelled');
    assert.equal(
      await count(f.pool, 'cloud_fulfillment_versions'),
      1,
      'decision is not a second order state version',
    );
    await receiveFulfillment(f.pool, f.auth, state);
    await receiveFulfillment(f.pool, f.auth, decision);
    assert.equal(await count(f.pool, 'cloud_fulfillment_versions'), 2);
    assert.equal(await count(f.pool, 'commerce_cancellation_results'), 1);
    assert.deepEqual(await f.edge.repo.acceptRelease(f.edge.scope, d.command), result);
    assert.deepEqual(
      await cancel(f, v, key),
      receipt,
      'lost request response replays original receipt',
    );
    await assert.rejects(cancel(f, v, randomUUID()), code('CONFLICT'));
    await assert.rejects(
      f.commerce.requestUnpaidCancellation(f.manager, key, { ...request(v), reason: 'different' }),
      code('CONFLICT'),
    );
    assert.deepEqual(await f.commerce.readOrder(f.scope, v.orderId), before);
    assert.equal(await count(f.edge.pool, 'fulfillment_tasks'), 0);
    assert.equal(await count(f.pool, 'commerce_payment_attempts'), 0);
    assert.equal(await count(f.pool, 'commerce_captures'), 0);
  }));

test('intent before admission immediately fences payment and schedules exactly one release after actual authenticated reservation', () =>
  fixture(async (f) => {
    const v = await f.create(),
      key = randomUUID(),
      initial = await cancel(f, v, key);
    assert.equal(initial.state, 'waiting_admission');
    assert.equal(initial.releaseEventId, null);
    await assert.rejects(attempt(f, v), code('NOT_READY'));
    const d = (await f.pull()).event;
    await f.edge.repo.acceptCloud(f.edge.scope, d.command);
    const e = (await f.events(v.orderId))[0];
    await receiveFulfillment(f.pool, f.auth, e);
    await receiveFulfillment(f.pool, f.auth, e);
    await f.ack(d);
    const pending = await current(f, v);
    assert.equal(pending.state, 'release_pending');
    assert.equal(
      Number(
        (
          await f.pool.query(
            "SELECT count(*) FROM commerce_outbox WHERE event_type='edge.admission_release_requested'",
          )
        ).rows[0].count,
      ),
      1,
    );
    assert.deepEqual(await cancel(f, v, key), initial);
    const release = (await pull2(f)).event;
    await f.edge.repo.acceptRelease(f.edge.scope, release.command);
    for (const event of (await f.events(v.orderId)).slice(1))
      await receiveFulfillment(f.pool, f.auth, event);
    assert.equal((await current(f, v)).state, 'cancelled');
  }));

test('every payment attempt history, including queued, unknown and failed, refuses cancellation without deleting history', () =>
  fixture(async (f) => {
    for (const outcome of ['pending', 'unknown', 'failed']) {
      const v = await f.reserve();
      await f.confirm(v);
      const a = await attempt(f, v);
      if (outcome !== 'pending')
        await f.commerce.observePayment(
          {
            organizationId: f.scope.organizationId,
            branchId: f.scope.branchId,
            accountId: f.payment,
          },
          {
            eventId: randomUUID(),
            attemptId: a.attemptId,
            outcome,
            occurredAt: new Date().toISOString(),
          },
        );
      await assert.rejects(cancel(f, v), code('NOT_READY'));
      assert.equal((await f.commerce.readOrder(f.scope, v.orderId)).attempts.length, 1);
    }
    assert.equal(await count(f.pool, 'commerce_cancellation_intents'), 0);
  }));

test('cancel and new payment serialize on order: one winner, exact attempt replay stays valid', () =>
  fixture(async (f) => {
    const v = await f.reserve();
    await f.confirm(v);
    const key = randomUUID();
    const results = await Promise.allSettled([cancel(f, v), attempt(f, v, key)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'NOT_READY');
    if (results[1].status === 'fulfilled')
      assert.deepEqual(await attempt(f, v, key), results[1].value);
    const attempts = await count(f.pool, 'commerce_payment_attempts'),
      intents = await count(f.pool, 'commerce_cancellation_intents');
    assert.equal(attempts + intents, 1);
  }));

test('release result mismatches cannot finalize intent; same-event changed result conflicts and revoked device cannot replay', () =>
  fixture(async (f) => {
    const v = await f.reserve();
    await f.confirm(v);
    await cancel(f, v);
    const d = (await pull2(f)).event;
    await f.edge.repo.acceptRelease(f.edge.scope, d.command);
    const e = (await f.events(v.orderId)).at(-1);
    for (const patch of [
      { requestDigest: '0'.repeat(64) },
      { requestEventId: randomUUID() },
      { reservationId: randomUUID() },
      { reason: 'changed' },
      { routingVersion: e.payload.routingVersion + 1 },
      { assemblyStationId: randomUUID() },
    ]) {
      await assert.rejects(
        receiveFulfillment(f.pool, f.auth, { ...e, payload: { ...e.payload, ...patch } }),
        code('CONFLICT'),
      );
    }
    assert.equal((await current(f, v)).state, 'release_pending');
    assert.equal(await count(f.pool, 'commerce_cancellation_results'), 0);
    await receiveFulfillment(f.pool, f.auth, e);
    await assert.rejects(
      receiveFulfillment(f.pool, f.auth, { ...e, payload: { ...e.payload, reason: 'changed' } }),
      code('CONFLICT'),
    );
    await f.pool.query("UPDATE devices SET status='revoked' WHERE id=$1", [f.auth.deviceId]);
    await assert.rejects(receiveFulfillment(f.pool, f.auth, e), code('UNAUTHORIZED'));
  }));

test('released state before lost command ACK does not hide durable release replay', () =>
  fixture(async (f) => {
    const v = await f.reserve();
    await f.confirm(v);
    await cancel(f, v);
    const d = (await pull2(f)).event,
      r = await f.edge.repo.acceptRelease(f.edge.scope, d.command);
    const events = await f.events(v.orderId);
    await receiveFulfillment(
      f.pool,
      f.auth,
      events.find((e) => e.type === 'edge.admission_released'),
    );
    await f.pool.query(
      "UPDATE commerce_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [d.command.eventId],
    );
    const retry = (await pull2(f)).event;
    assert.deepEqual(retry.command, d.command);
    assert.deepEqual(await f.edge.repo.acceptRelease(f.edge.scope, retry.command), r);
    await receiveFulfillment(
      f.pool,
      f.auth,
      events.find((e) => e.type === 'edge.admission_release_result'),
    );
    await f.ack(retry);
    assert.equal((await current(f, v)).state, 'cancelled');
  }));

test('edge version conflict is an immutable rejected decision, never a blind expectedVersion retry or state-version collision', () =>
  fixture(async (f) => {
    const v = await f.reserve();
    await f.confirm(v);
    await cancel(f, v);
    const d = (await pull2(f)).event;
    // Another trusted legacy release arrived first. Do not fabricate a new version.
    await f.edge.repo.acceptCloud(f.edge.scope, {
      ...d.command,
      eventId: randomUUID(),
      payload: { ...d.command.payload, reason: 'Earlier trusted release' },
    });
    const r = await f.edge.repo.acceptRelease(f.edge.scope, d.command);
    assert.equal(r.outcome, 'rejected');
    assert.equal(r.rejectionCode, 'VERSION_CONFLICT');
    assert.equal(r.version, 2);
    const e = (await f.events(v.orderId)).at(-1);
    await receiveFulfillment(f.pool, f.auth, e);
    const final = await current(f, v);
    assert.equal(final.state, 'needs_review');
    assert.equal(final.resolutionCode, 'VERSION_CONFLICT');
    assert.deepEqual(await f.edge.repo.acceptRelease(f.edge.scope, d.command), r);
    await assert.rejects(
      f.edge.repo.acceptRelease(f.edge.scope, {
        ...d.command,
        payload: { ...d.command.payload, expectedVersion: 2 },
      }),
      code('CONFLICT'),
    );
    assert.equal(await count(f.edge.pool, 'fulfillment_release_results'), 1);
    assert.equal(
      await count(f.edge.pool, 'fulfillment_outbox'),
      3,
      'reserved + released + decision only',
    );
  }));

test('same-version non-held release records NOT_HELD once without changing state; ordinary outbox versions remain unique and decisions immutable', () =>
  fixture(async (f) => {
    const v = await f.reserve();
    await f.confirm(v);
    await cancel(f, v);
    const d = (await pull2(f)).event;
    await f.edge.repo.acceptCloud(f.edge.scope, { ...d.command, eventId: randomUUID() });
    const command = {
      ...d.command,
      eventId: randomUUID(),
      payload: { ...d.command.payload, expectedVersion: 2 },
    };
    const [a, b] = await Promise.all([
      f.edge.repo.acceptRelease(f.edge.scope, command),
      f.edge.repo.acceptRelease(f.edge.scope, command),
    ]);
    assert.deepEqual(a, b);
    assert.equal(a.rejectionCode, 'NOT_HELD');
    assert.equal(a.version, 2);
    await assert.rejects(
      f.edge.pool.query(
        "INSERT INTO fulfillment_outbox(event_id,branch_id,order_id,aggregate_version,event_type,payload) SELECT $1,branch_id,order_id,aggregate_version,event_type,payload FROM fulfillment_outbox WHERE event_type='edge.admission_released'",
        [randomUUID()],
      ),
      code('23505'),
    );
    await assert.rejects(
      f.edge.pool.query('DELETE FROM fulfillment_release_results'),
      code('23514'),
    );
    await assert.rejects(
      f.edge.pool.query("UPDATE fulfillment_outbox SET payload='{}'"),
      code('23514'),
    );
  }));

test('trusted manager scope, branch, active binding and immutable cancellation ledger; runtime cannot mint cancellation intent', () =>
  fixture(async (f) => {
    const v = await f.reserve();
    await f.confirm(v);
    await assert.rejects(
      f.commerce.requestUnpaidCancellation(f.scope, randomUUID(), request(v)),
      code('FORBIDDEN'),
    );
    await assert.rejects(
      f.commerce.requestUnpaidCancellation(
        { ...f.manager, branchId: randomUUID() },
        randomUUID(),
        request(v),
      ),
      (e) => ['FORBIDDEN', 'NOT_FOUND'].includes(e.code),
    );
    await f.pool.query('UPDATE fulfillment_transport_bindings SET active=false');
    await assert.rejects(cancel(f, v), code('NOT_READY'));
    assert.equal(await count(f.pool, 'commerce_cancellation_intents'), 0);
  }));

test('restricted transport runtime schedules pre-admission intent and records decision but cannot create intent or write money', () =>
  fixture(async (f) => {
    const role = 'cancel_runtime_' + randomUUID().replaceAll('-', '');
    let limited;
    await f.admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    try {
      await f.pool.query(
        `GRANT USAGE ON SCHEMA ${f.schema} TO ${role}; GRANT SELECT ON devices,device_credentials,branches TO ${role}; GRANT UPDATE(id) ON devices TO ${role}; GRANT UPDATE(device_id) ON device_credentials TO ${role}`,
      );
      await f.pool.query(fulfillmentTransportGrants(role, true));
      const url = new URL(f.url);
      url.searchParams.set('options', `-c search_path=${f.schema} -c role=${role}`);
      limited = createPool(url.toString(), 4);
      const v = await f.create();
      await cancel(f, v);
      const pull = () =>
        pullFulfillment(limited, f.auth, {
          workerId: f.workerId,
          leaseSeconds: 15,
          protocolVersion: 2,
        });
      const ack = (d) =>
        acknowledgeFulfillment(limited, f.auth, {
          eventId: d.command.eventId,
          workerId: f.workerId,
          leaseToken: d.leaseToken,
        });
      const admission = (await pull()).event;
      await f.edge.repo.acceptCloud(f.edge.scope, admission.command);
      await receiveFulfillment(limited, f.auth, (await f.events(v.orderId))[0]);
      await ack(admission);
      assert.equal((await current(f, v)).state, 'release_pending');
      const release = (await pull()).event;
      await f.edge.repo.acceptRelease(f.edge.scope, release.command);
      await ack(release);
      for (const e of (await f.events(v.orderId)).slice(1))
        await receiveFulfillment(limited, f.auth, e);
      assert.equal((await current(f, v)).state, 'cancelled');
      for (const table of [
        'commerce_cancellation_intents',
        'commerce_captures',
        'commerce_refunds',
      ])
        await assert.rejects(limited.query(`INSERT INTO ${table} DEFAULT VALUES`), code('42501'));
      await assert.rejects(
        limited.query("UPDATE commerce_cancellation_intents SET reason='changed'"),
        code('42501'),
      );
      await assert.rejects(
        f.pool.query("UPDATE commerce_cancellation_intents SET reason='changed'"),
        code('23514'),
      );
      await assert.rejects(
        f.pool.query('DELETE FROM commerce_cancellation_results'),
        code('23514'),
      );
      await f.pool.query(fulfillmentTransportGrants(role, false));
      for (const table of ['commerce_cancellation_intents', 'commerce_cancellation_results'])
        assert.equal(
          (
            await limited.query(
              "SELECT has_table_privilege(current_user,$1,'INSERT') OR has_any_column_privilege(current_user,$1,'UPDATE') AS allowed",
              [table],
            )
          ).rows[0].allowed,
          false,
        );
    } finally {
      if (limited) await limited.end();
      await f.pool.query(`DROP OWNED BY ${role}`);
      await f.admin.query(`DROP ROLE ${role}`);
    }
  }));

test('paid/fiscalized order cannot create unpaid intent and all ledger records remain unchanged', () =>
  fixture(async (f) => {
    const v = await f.reserve();
    await f.confirm(v);
    await f.issue(v);
    const before = await f.commerce.readOrder(f.scope, v.orderId);
    await assert.rejects(cancel(f, v), code('NOT_READY'));
    assert.deepEqual(await f.commerce.readOrder(f.scope, v.orderId), before);
    assert.equal(await count(f.pool, 'commerce_cancellation_intents'), 0);
  }));
