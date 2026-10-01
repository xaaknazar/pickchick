/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createPool } from '@pickchick/database';
import { EdgeFulfillment, provisionFulfillment, digest } from '../dist/index.js';
import { fixture, errorCode } from './fixture.mjs';

test('durable admission deduplicates concurrent deliveries; hash/quote/owner changes fail', () =>
  fixture(async (f) => {
    const c = f.admission(true);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => f.repo.acceptCloud(f.scope, c)),
    );
    assert.equal(new Set(results.map((r) => r.reservationId)).size, 1);
    assert.equal(await f.count('fulfillment_reservations'), 1);
    assert.equal(await f.count('fulfillment_inbox'), 1);
    assert.equal(await f.count('fulfillment_outbox'), 1);
    assert.equal(await f.count('fulfillment_tasks'), 0);
    assert.equal(results[0].state, 'held');
    await assert.rejects(
      f.pool.query(
        'UPDATE fulfillment_reservations SET display_number=display_number+1,version=version+1',
      ),
    );
    assert.equal(
      (await f.pool.query('SELECT authorized_event_id FROM fulfillment_reservations')).rows[0]
        .authorized_event_id,
      null,
    );
    assert.match(results[0].displayNumber, /^[1-9][0-9]*$/);
    assert.equal(new Set(results.map((r) => r.displayNumber)).size, 1);
    await assert.rejects(
      f.repo.acceptCloud(f.scope, { ...c, payload: { ...c.payload, quoteId: randomUUID() } }),
      errorCode('CONFLICT'),
    );
    await assert.rejects(
      f.repo.acceptCloud({ ...f.scope, producerId: randomUUID() }, c),
      errorCode('FORBIDDEN'),
    );
    await assert.rejects(
      f.repo.acceptCloud({ ...f.scope, deviceId: randomUUID() }, c),
      errorCode('FORBIDDEN'),
    );
    await assert.rejects(
      f.repo.acceptCloud({ ...f.scope, branchId: randomUUID() }, c),
      errorCode('FORBIDDEN'),
    );
    await assert.rejects(
      f.repo.acceptCloud(f.scope, {
        ...c,
        eventId: randomUUID(),
        payload: { ...c.payload, orderId: randomUUID() },
      }),
      errorCode('CONFLICT'),
    );
    const modified = structuredClone(c);
    modified.eventId = randomUUID();
    modified.payload.snapshot.lines[0].quantity = 3;
    await assert.rejects(f.repo.acceptCloud(f.scope, modified), errorCode('CONFLICT'));
    const next = await f.repo.acceptCloud(f.scope, { ...c, eventId: randomUUID() });
    assert.equal(next.reservationId, results[0].reservationId);
    assert.equal(await f.count('fulfillment_outbox'), 1);
    const columns = (
      await f.pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='fulfillment_reservations'",
      )
    ).rows.map((r) => r.column_name);
    assert.ok(!columns.some((s) => /expires|ttl/.test(s)));
    await assert.rejects(f.pool.query("UPDATE fulfillment_inbox SET request_hash=repeat('0',64)"));
    await assert.rejects(
      f.pool.query(
        "UPDATE fulfillment_reservations SET quote_hash=repeat('0',64),version=version+1",
      ),
    );
  }));

test('routing is mandatory and pinned before payment; later routing does not change tasks', () =>
  fixture(async (f) => {
    const c = f.admission(true),
      r = await f.repo.acceptCloud(f.scope, c);
    const next = structuredClone(f.setup);
    next.routing.version = 2;
    next.routing.routes.find((r) => r.productId === 'burger').stationId = f.assembly;
    next.routing.routes.find((r) => r.productId === 'burger').kind = 'assembly_item';
    await provisionFulfillment(f.pool, next);
    const o = await f.repo.acceptCloud(f.scope, f.authorize(c, r));
    assert.equal(o.routingVersion, 1);
    assert.equal(o.displayNumber, r.displayNumber);
    const view = await f.read(o.orderId);
    assert.equal(view.tasks.length, 3);
    assert.equal(view.tasks.find((t) => t.details.productId === 'burger').station_id, f.prep);
    assert.equal(view.tasks.find((t) => t.details.productId === 'fries').details.quantity, 4);
    assert.equal(view.tasks.find((t) => t.details.productId === 'drink').kind, 'assembly_item');
    const missing = f.admission();
    missing.payload.snapshot.lines[0].productId = 'unrouted';
    missing.payload.quoteDigest = digest(missing.payload.snapshot);
    await assert.rejects(f.repo.acceptCloud(f.scope, missing), errorCode('ROUTING_MISSING'));
    assert.equal(await f.count('fulfillment_reservations'), 1);
    await assert.rejects(
      provisionFulfillment(f.pool, {
        ...next,
        routing: { ...next.routing, routes: next.routing.routes.slice(1) },
      }),
      errorCode('CONFLICT'),
    );
    await f.pool.query('UPDATE branch_config SET ordering_enabled=false');
    await assert.rejects(f.repo.acceptCloud(f.scope, f.admission()), errorCode('NOT_READY'));
    // Existing authorized order and reservation remain usable when new admissions are stopped.
    assert.equal((await f.repo.acceptCloud(f.scope, f.authorize(c, r))).state, 'accepted');
  }));

test('authorize once; station roles, task/aggregate versions, assembly and public LED', () =>
  fixture(async (f) => {
    const x = await f.accepted(true);
    await Promise.all(Array.from({ length: 8 }, () => f.repo.acceptCloud(f.scope, x.auth)));
    await f.repo.acceptCloud(f.scope, { ...x.auth, eventId: randomUUID() });
    assert.equal(await f.count('fulfillment_tasks'), 3);
    assert.equal(await f.count('fulfillment_outbox'), 2);
    let current = await f.read(x.order.orderId);
    await assert.rejects(f.act(current, 'ready', f.packer), errorCode('NOT_READY'));
    const prep = current.tasks.find((t) => t.station_id === f.prep);
    await assert.rejects(
      f.act(current, 'start_task', f.cashier, { taskId: prep.id, expectedTaskVersion: 1 }),
      errorCode('FORBIDDEN'),
    );
    await assert.rejects(
      f.act(current, 'start_task', f.packer, { taskId: prep.id, expectedTaskVersion: 1 }),
      errorCode('FORBIDDEN'),
    );
    const cmd = {
      commandId: randomUUID(),
      orderId: current.orderId,
      expectedVersion: current.version,
      action: 'start_task',
      taskId: prep.id,
      expectedTaskVersion: 1,
    };
    const repeated = await Promise.all(
      Array.from({ length: 6 }, () => f.repo.act(f.scope.branchId, f.cook.auth, cmd)),
    );
    assert.ok(repeated.every((o) => o.version === 3));
    await assert.rejects(
      f.repo.act(f.scope.branchId, f.cook.auth, { ...cmd, action: 'complete_task' }),
      errorCode('CONFLICT'),
    );
    await assert.rejects(
      f.act(current, 'complete_task', f.cook, { taskId: prep.id, expectedTaskVersion: 2 }),
      errorCode('CONFLICT'),
    );
    current = await f.read(current.orderId);
    for (const t of current.tasks) {
      const actor = t.station_id === f.prep ? f.cook : f.packer;
      let version = t.version;
      if (t.state === 'queued') {
        current = await f.act(current, 'start_task', actor, {
          taskId: t.id,
          expectedTaskVersion: version,
        });
        version++;
      }
      current = await f.act(current, 'complete_task', actor, {
        taskId: t.id,
        expectedTaskVersion: version,
      });
    }
    await assert.rejects(f.act(current, 'ready', f.cook), errorCode('FORBIDDEN'));
    current = await f.act(current, 'ready', f.packer);
    const display = await f.repo.readDisplay(f.scope.branchId);
    assert.deepEqual(display, {
      items: [{ number: current.displayNumber, state: 'ready' }],
      nextAfterNumber: null,
    });
    assert.ok(!JSON.stringify(display).includes('customer'));
    assert.ok(!JSON.stringify(display).includes('Synthetic'));
    await assert.rejects(f.repo.acceptCloud(f.scope, f.cancel(current)), errorCode('NOT_READY'));
    current = await f.act(current, 'handoff', f.packer);
    assert.deepEqual((await f.repo.readDisplay(f.scope.branchId)).items, []);
    await assert.rejects(f.act(current, 'handoff', f.packer), errorCode('NOT_READY'));
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*) FROM fulfillment_outbox WHERE event_type='edge.fulfillment_handed_over'",
        )
      ).rows[0].count,
      '1',
    );
    await f.pool.query('UPDATE staff_sessions SET revoked=true WHERE id=$1', [f.cook.session_id]);
    await assert.rejects(f.repo.act(f.scope.branchId, f.cook.auth, cmd), errorCode('UNAUTHORIZED'));
  }));

test('release/cancel tombstones reject delayed authorization; cancellation while cooking requires station stop and manager decision', () =>
  fixture(async (f) => {
    const c = f.admission(),
      r = await f.repo.acceptCloud(f.scope, c);
    const release = f.cancel(r, 'edge.admission_release_requested');
    const released = await f.repo.acceptCloud(f.scope, release);
    assert.equal(released.state, 'released');
    await assert.rejects(f.repo.acceptCloud(f.scope, f.authorize(c, r)), errorCode('CONFLICT'));
    await assert.rejects(
      f.repo.acceptCloud(f.scope, { ...c, eventId: randomUUID() }),
      errorCode('CONFLICT'),
    );
    const x = await f.accepted(true);
    let current = await f.read(x.order.orderId);
    const task = current.tasks.find((t) => t.station_id === f.prep);
    current = await f.act(current, 'start_task', f.cook, {
      taskId: task.id,
      expectedTaskVersion: 1,
    });
    current = await f.repo.acceptCloud(f.scope, f.cancel(current));
    assert.equal(current.state, 'cancel_requested');
    await assert.rejects(
      f.act(current, 'complete_task', f.cook, { taskId: task.id, expectedTaskVersion: 3 }),
      errorCode('NOT_READY'),
    );
    await assert.rejects(
      f.act(current, 'confirm_cancel', f.manager, {
        reason: 'Synthetic waste review',
        inventoryDisposition: 'requires_inventory_review',
      }),
      errorCode('NOT_READY'),
    );
    current = await f.act(current, 'confirm_stop', f.cook, {
      taskId: task.id,
      expectedTaskVersion: 3,
    });
    await assert.rejects(
      f.act(current, 'confirm_cancel', f.packer, {
        reason: 'Synthetic waste review',
        inventoryDisposition: 'requires_inventory_review',
      }),
      errorCode('FORBIDDEN'),
    );
    current = await f.act(current, 'confirm_cancel', f.manager, {
      reason: 'Synthetic waste review',
      inventoryDisposition: 'requires_inventory_review',
    });
    assert.equal(current.state, 'cancelled');
    await assert.rejects(
      f.repo.acceptCloud(f.scope, { ...x.auth, eventId: randomUUID() }),
      errorCode('CONFLICT'),
    );
    assert.equal((await f.read(current.orderId)).inventoryDisposition, 'requires_inventory_review');
    assert.ok(
      (
        await f.pool.query(
          "SELECT payload FROM fulfillment_outbox WHERE event_type='edge.fulfillment_cancelled'",
        )
      ).rows.every((r) => r.payload.inventoryEffect === 'none'),
    );
  }));

test('ready/cancel and release/authorize races cannot produce two terminal effects', () =>
  fixture(async (f) => {
    for (let i = 0; i < 8; i++) {
      const x = await f.accepted(),
        current = await f.complete(x.order);
      const results = await Promise.allSettled([
        f.act(current, 'ready', f.packer),
        f.repo.acceptCloud(f.scope, f.cancel(current)),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const row = await f.read(current.orderId);
      assert.ok(['ready', 'cancel_requested'].includes(row.state));
      if (row.state === 'ready')
        await assert.rejects(f.repo.acceptCloud(f.scope, f.cancel(row)), errorCode('NOT_READY'));
    }
    for (let i = 0; i < 8; i++) {
      const c = f.admission(),
        r = await f.repo.acceptCloud(f.scope, c);
      const results = await Promise.allSettled([
        f.repo.acceptCloud(f.scope, f.cancel(r, 'edge.admission_release_requested')),
        f.repo.acceptCloud(f.scope, f.authorize(c, r)),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const row = await f.read(r.orderId);
      assert.ok(['accepted', 'released'].includes(row.state));
      assert.equal(row.tasks.length, row.state === 'accepted' ? 1 : 0);
    }
  }));

test('commit lost at process exit survives restart; disconnected mid-transaction rolls back ticket and inbox together', () =>
  fixture(async (f) => {
    const c = f.admission(true),
      r = await f.repo.acceptCloud(f.scope, c),
      a = f.authorize(c, r);
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {createPool} from '@pickchick/database';import {EdgeFulfillment} from './packages/edge-fulfillment/dist/index.js';const p=createPool(process.env.LOCAL_FIXTURE_URL);await new EdgeFulfillment(p).acceptCloud(JSON.parse(process.env.LOCAL_FIXTURE_SCOPE),JSON.parse(process.env.LOCAL_FIXTURE_COMMAND));process.exit(23);`,
      ],
      {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: {
          ...process.env,
          LOCAL_FIXTURE_URL: f.url,
          LOCAL_FIXTURE_SCOPE: JSON.stringify(f.scope),
          LOCAL_FIXTURE_COMMAND: JSON.stringify(a),
        },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    assert.equal(child.status, 23, child.stderr);
    const restartedPool = createPool(f.url, 4);
    try {
      const restarted = new EdgeFulfillment(restartedPool);
      assert.equal((await restarted.acceptCloud(f.scope, a)).state, 'accepted');
      assert.equal(await f.count('fulfillment_tasks'), 3);
    } finally {
      await restartedPool.end();
    }
    const c2 = f.admission(),
      r2 = await f.repo.acceptCloud(f.scope, c2),
      a2 = f.authorize(c2, r2);
    await f.pool.query(
      `CREATE FUNCTION synthetic_disconnect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='edge.fulfillment_accepted' AND NEW.order_id='${r2.orderId}'::uuid THEN PERFORM pg_terminate_backend(pg_backend_pid()); END IF; RETURN NEW; END; $$; CREATE TRIGGER synthetic_disconnect BEFORE INSERT ON fulfillment_outbox FOR EACH ROW EXECUTE FUNCTION synthetic_disconnect()`,
    );
    const interrupted = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {createPool} from '@pickchick/database';import {EdgeFulfillment} from './packages/edge-fulfillment/dist/index.js';const p=createPool(process.env.LOCAL_FIXTURE_URL);try{await new EdgeFulfillment(p).acceptCloud(JSON.parse(process.env.LOCAL_FIXTURE_SCOPE),JSON.parse(process.env.LOCAL_FIXTURE_COMMAND));process.exit(0)}catch{await p.end();process.exit(24)}`,
      ],
      {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: {
          ...process.env,
          LOCAL_FIXTURE_URL: f.url,
          LOCAL_FIXTURE_SCOPE: JSON.stringify(f.scope),
          LOCAL_FIXTURE_COMMAND: JSON.stringify(a2),
        },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    // The application must reject the failed transaction, not crash from an
    // unhandled pg Client error. This regression requires the database fix.
    assert.equal(
      interrupted.status,
      24,
      'Injected disconnection must reject cleanly: ' + interrupted.stderr,
    );
    await f.pool.query(
      'DROP TRIGGER synthetic_disconnect ON fulfillment_outbox;DROP FUNCTION synthetic_disconnect()',
    );
    assert.equal((await f.read(r2.orderId)).state, 'held');
    assert.equal((await f.read(r2.orderId)).tasks.length, 0);
    const retry = await f.repo.acceptCloud(f.scope, a2);
    assert.equal(retry.state, 'accepted');
    assert.equal(await f.count('fulfillment_tasks'), 4);
  }));

test('outbox competing leases and expired acknowledgements recover without mutating events', () =>
  fixture(async (f) => {
    await f.accepted();
    await f.accepted();
    const wa = randomUUID(),
      wb = randomUUID();
    const [a, b] = await Promise.all([
      f.repo.claimOutbox(f.scope, { workerId: wa, limit: 2, leaseSeconds: 5 }),
      f.repo.claimOutbox(f.scope, { workerId: wb, limit: 2, leaseSeconds: 5 }),
    ]);
    assert.equal(a.length + b.length, 4);
    assert.equal(new Set([...a, ...b].map((v) => v.event_id)).size, 4);
    const e = a[0];
    await assert.rejects(
      f.repo.acknowledgeOutbox(f.scope, {
        eventId: e.event_id,
        workerId: wb,
        leaseToken: e.lease_token,
      }),
      errorCode('CONFLICT'),
    );
    await f.pool.query(
      "UPDATE fulfillment_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE event_id=$1",
      [e.event_id],
    );
    await assert.rejects(
      f.repo.acknowledgeOutbox(f.scope, {
        eventId: e.event_id,
        workerId: wa,
        leaseToken: e.lease_token,
      }),
      errorCode('CONFLICT'),
    );
    const [again] = await f.repo.claimOutbox(f.scope, { workerId: wb, limit: 2, leaseSeconds: 30 });
    assert.equal(again.event_id, e.event_id);
    assert.equal(again.attempts, 2);
    const ack = { eventId: again.event_id, workerId: wb, leaseToken: again.lease_token };
    await f.repo.acknowledgeOutbox(f.scope, ack);
    await f.repo.acknowledgeOutbox(f.scope, ack);
    await assert.rejects(
      f.pool.query("UPDATE fulfillment_outbox SET payload='{}' WHERE event_id=$1", [e.event_id]),
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*) FROM fulfillment_outbox WHERE acknowledged_at IS NOT NULL',
        )
      ).rows[0].count,
      '1',
    );
  }));

test('1000 resident orders: bounded concurrent replay, paginated KDS/LED and restart without duplicate tickets', () =>
  fixture(async (f) => {
    const count = 1000,
      commands = Array.from({ length: count }, () => f.admission(true));
    let next = 0;
    const latencies = [];
    const started = performance.now();
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        while (next < count) {
          const c = commands[next++],
            t = performance.now();
          const r = await f.repo.acceptCloud(f.scope, c),
            a = f.authorize(c, r);
          await f.repo.acceptCloud(f.scope, a);
          await f.repo.acceptCloud(f.scope, a);
          latencies.push(performance.now() - t);
        }
      }),
    );
    assert.equal(await f.count('fulfillment_reservations'), 1000);
    assert.equal(await f.count('fulfillment_tasks'), 3000);
    assert.equal(await f.count('fulfillment_inbox'), 2000);
    assert.equal(await f.count('fulfillment_outbox'), 2000);
    assert.equal(
      (await f.pool.query('SELECT count(DISTINCT display_number) FROM fulfillment_reservations'))
        .rows[0].count,
      '1000',
    );
    const restarted = new EdgeFulfillment(f.pool);
    let cursor,
      seen = new Set();
    do {
      const page = await restarted.listKitchen(f.scope.branchId, f.manager.auth, {
        limit: 83,
        ...(cursor ? { afterOrderId: cursor } : {}),
      });
      for (const o of page.items) {
        assert.equal(o.tasks.length, 3);
        assert.ok(!seen.has(o.orderId));
        seen.add(o.orderId);
      }
      cursor = page.nextAfterOrderId;
    } while (cursor);
    assert.equal(seen.size, 1000);
    cursor = undefined;
    seen = new Set();
    do {
      const page = await restarted.readDisplay(f.scope.branchId, {
        limit: 77,
        ...(cursor ? { afterNumber: cursor } : {}),
      });
      for (const v of page.items) {
        assert.deepEqual(Object.keys(v), ['number', 'state']);
        assert.ok(!seen.has(v.number));
        seen.add(v.number);
      }
      cursor = page.nextAfterNumber;
    } while (cursor);
    assert.equal(seen.size, 1000);
    const first = await f.read(commands[0].payload.orderId),
      last = await f.read(commands.at(-1).payload.orderId);
    const blocker = await f.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT order_id FROM fulfillment_reservations WHERE order_id=$1 FOR UPDATE',
      [first.orderId],
    );
    try {
      await f.act(last, 'start_task', f.manager, {
        taskId: last.tasks[0].id,
        expectedTaskVersion: 1,
      });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    latencies.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        scenario: 'local-edge-domain-only',
        orders: count,
        tasks: 3000,
        concurrency: 16,
        durationMs: Math.round(performance.now() - started),
        reserveAuthorizeReplayP50Ms: Math.round(latencies[499] * 100) / 100,
        reserveAuthorizeReplayP95Ms: Math.round(latencies[949] * 100) / 100,
        errors: 0,
        physicalKitchenAcceptance: false,
      }),
    );
  }));

test('large orders keep kitchen pages bounded and cursor reaches every order', () =>
  fixture(async (f) => {
    const expected = new Set();
    for (let i = 0; i < 5; i++) {
      const c = f.admission();
      const base = c.payload.snapshot.lines[0];
      c.payload.snapshot.lines = Array.from({ length: 200 }, () => ({
        ...base,
        lineId: randomUUID(),
        title: 'S'.repeat(250),
        description: 'Synthetic '.repeat(200),
      }));
      c.payload.snapshot.totalMinor = '69800000';
      c.payload.quoteDigest = digest(c.payload.snapshot);
      const r = await f.repo.acceptCloud(f.scope, c);
      await f.repo.acceptCloud(f.scope, f.authorize(c, r));
      expected.add(r.orderId);
    }
    let cursor;
    const seen = new Set();
    let pages = 0;
    do {
      const page = await f.repo.listKitchen(f.scope.branchId, f.manager.auth, {
        limit: 100,
        ...(cursor ? { afterOrderId: cursor } : {}),
      });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 2_098_000);
      for (const item of page.items) {
        assert.ok(!seen.has(item.orderId));
        seen.add(item.orderId);
        assert.equal(item.tasks.length, 200);
      }
      pages++;
      cursor = page.nextAfterOrderId;
    } while (cursor);
    assert.ok(pages > 1);
    assert.deepEqual(seen, expected);
  }));

test('caller mutation during async admission cannot change the hashed snapshot', () =>
  fixture(async (f) => {
    const c = f.admission();
    c.payload.snapshot.extra = { note: 'Synthetic immutable source' };
    c.payload.quoteDigest = digest(c.payload.snapshot);
    const original = structuredClone(c);
    const pending = f.repo.acceptCloud(f.scope, c);
    c.payload.snapshot.extra.note = 'Changed after invocation';
    const reserved = await pending;
    const stored = (
      await f.pool.query('SELECT snapshot FROM fulfillment_reservations WHERE order_id=$1', [
        reserved.orderId,
      ])
    ).rows[0].snapshot;
    assert.equal(stored.extra.note, 'Synthetic immutable source');
    assert.equal(digest(stored), original.payload.quoteDigest);
  }));

test('local stop refuses mobile admission; expired stop permits the same pending command', () =>
  fixture(async (f) => {
    const { localSelectionIds } = await import('@pickchick/local-orders');
    const c = f.admission(true),
      line = c.payload.snapshot.lines[0];
    const id = localSelectionIds(f.scope.branchId, line.productId, [])[0];
    await f.pool.query(
      'INSERT INTO local_stops(branch_id,variant_id,stopped,version,reason) VALUES($1,$2,true,1,$$Synthetic stop$$)',
      [f.scope.branchId, id],
    );
    await assert.rejects(f.repo.acceptCloud(f.scope, c), errorCode('NOT_READY'));
    assert.equal(await f.count('fulfillment_reservations'), 0);
    await f.pool.query("UPDATE local_stops SET expires_at=now()-interval '1 second'");
    assert.equal((await f.repo.acceptCloud(f.scope, c)).state, 'held');
  }));
