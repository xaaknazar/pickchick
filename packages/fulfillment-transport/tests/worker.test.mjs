import assert from 'node:assert/strict';
import test from 'node:test';
import { provisionFulfillment, digest, localUnpaidExecution } from '@pickchick/edge-fulfillment';
import { randomUUID } from 'node:crypto';
import { fixture } from './worker-fixture.mjs';
import { syncFulfillmentOnce } from '../dist/index.js';
import { createPool, transaction } from '@pickchick/database';
import { fulfillmentWorkerGrants } from '../../../infra/windows/fulfillment-worker-grants.mjs';

async function restrictedWorker(f, run) {
  const role = 'transport_' + randomUUID().replaceAll('-', '');
  const schema = (await f.pool.query('SELECT current_schema() AS name')).rows[0].name;
  await f.pool.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  let pool;
  try {
    await f.pool.query(fulfillmentWorkerGrants(role, schema));
    const url = new URL(f.url);
    url.searchParams.set('options', `-c search_path=${schema} -c role=${role}`);
    pool = createPool(url.toString(), 4);
    assert.equal((await pool.query('SELECT current_user AS name')).rows[0].name, role);
    await run(pool, () => syncFulfillmentOnce(pool, f.options));
  } finally {
    if (pool) await pool.end();
    await f.pool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
  }
}

test('commercial transport leaves local cashier events untouched while delivering mobile order', () =>
  fixture(async (f) => {
    const branch = f.scope.branchId,
      orderId = randomUUID(),
      quoteId = randomUUID(),
      release = randomUUID();
    const quote = {
      quote_id: quoteId,
      branch_id: branch,
      release_id: release,
      currency: 'KZT',
      total_minor: '10000',
      service_mode: 'dine_in',
      lines: [{ product_id: 'burger', name: { ru: 'Synthetic POS' }, quantity: 1 }],
    };
    await transaction(f.pool, async (c) => {
      await c.query("UPDATE branch_config SET pos_service_mode='unpaid_service'");
      const menu = {
        release_id: release,
        branch_id: branch,
        schema_version: 1,
        version: 1,
        items: [],
      };
      await c.query(
        'INSERT INTO menu_snapshots(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,1,1,$3,$4,now())',
        [release, branch, menu, digest(menu)],
      );
      await c.query(
        "INSERT INTO checkout_quotes(id,branch_id,staff_id,terminal_id,release_id,total_minor,snapshot,created_at,expires_at) VALUES($1,$2,$3,$4,$5,10000,$6,now(),now()+interval '5 minutes')",
        [quoteId, branch, f.cashier.staff_id, f.cashier.terminal_id, release, quote],
      );
      const shiftId = randomUUID();
      await c.query(
        'INSERT INTO local_cash_shifts(id,branch_id,staff_id,terminal_id,opening_cash_minor) VALUES($1,$2,$3,$4,0)',
        [shiftId, branch, f.cashier.staff_id, f.cashier.terminal_id],
      );
      await c.query(
        "INSERT INTO local_orders(id,branch_id,quote_id,total_minor,execution_mode,cash_shift_id) VALUES($1,$2,$3,10000,'unpaid_service',$4)",
        [orderId, branch, quoteId, shiftId],
      );
      await localUnpaidExecution({ enabled: true, deviceId: f.scope.deviceId }).admit(
        c,
        { orderId, branchId: branch, quote },
        { staff_id: f.cashier.staff_id },
        randomUUID(),
      );
    });
    const before = (
      await f.pool.query('SELECT * FROM fulfillment_outbox WHERE order_id=$1', [orderId])
    ).rows;
    assert.equal(before.length, 1);
    await restrictedWorker(f, async (_pool, tick) => {
      assert.equal((await tick()).state, 'applied');
      assert.equal((await tick()).state, 'acknowledged');
      assert.equal((await tick()).state, 'idle');
    });
    assert.deepEqual(
      (await f.pool.query('SELECT * FROM fulfillment_outbox WHERE order_id=$1', [orderId])).rows,
      before,
    );
    assert.equal(await f.counts(f.pool, 'fulfillment_transport_reverse_failures'), '0');
    assert.equal(
      (
        await f.cloud.query('SELECT count(*) FROM cloud_fulfillment_projection WHERE order_id=$1', [
          orderId,
        ])
      ).rows[0].count,
      '0',
    );
  }));

test('dedicated Windows transport role reserves and admits only after trusted capture/fiscal gate; no staff or POS privileges', () =>
  fixture(async (f) =>
    restrictedWorker(f, async (pool, tick) => {
      for (const sql of [
        'SELECT * FROM local_staff_pins',
        'SELECT * FROM staff_sessions',
        'SELECT * FROM local_orders',
        'UPDATE branch_config SET ordering_enabled=false',
        'UPDATE fulfillment_config SET cloud_producer_id=gen_random_uuid()',
        'DELETE FROM fulfillment_reservations',
      ])
        await assert.rejects(pool.query(sql), (e) => e.code === '42501');
      assert.equal((await tick()).state, 'applied');
      assert.equal((await tick()).state, 'acknowledged');
      assert.equal(await f.counts(f.pool, 'fulfillment_tasks'), '0');
      const { sale } = await f.pay();
      assert.equal((await tick()).state, 'idle');
      await f.fiscalize(sale);
      assert.equal((await tick()).state, 'applied');
      assert.equal((await tick()).state, 'acknowledged');
      assert.equal(await f.counts(f.pool, 'fulfillment_tasks'), '1');
      assert.equal((await tick()).state, 'idle');
      assert.equal(await f.counts(f.pool, 'fulfillment_reservations'), '1');
    }),
  ));

test('dedicated Windows transport role persists unpaid release results and returns them to cloud', () =>
  fixture(async (f) =>
    restrictedWorker(f, async (_pool, tick) => {
      await tick();
      await tick();
      await f.commerce.requestUnpaidCancellation(
        { ...f.commercialScope, role: 'manager' },
        randomUUID(),
        {
          orderId: f.order.orderId,
          reason: 'Synthetic cancellation',
        },
      );
      assert.equal((await tick()).state, 'applied');
      await tick();
      await tick();
      assert.equal(
        (
          await f.commerce.readUnpaidCancellation(
            { ...f.commercialScope, role: 'manager' },
            f.order.orderId,
          )
        ).state,
        'cancelled',
      );
      assert.equal(await f.counts(f.pool, 'fulfillment_release_results'), '1');
      assert.equal(await f.counts(f.pool, 'fulfillment_tasks'), '0');
    }),
  ));
const body = (r) => r.json();
const pending = async (f) =>
  (await f.pool.query('SELECT * FROM fulfillment_transport_state')).rows[0];
const expireCloud = async (f) =>
  f.cloud.query(
    "UPDATE commerce_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE acknowledged_at IS NULL",
  );
const expireEdge = async (f) => {
  await f.pool.query(
    "UPDATE fulfillment_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE acknowledged_at IS NULL",
  );
  await f.pool.query(
    "UPDATE fulfillment_transport_reverse_failures SET retry_after=clock_timestamp()-interval '1 second' WHERE resolved_at IS NULL",
  );
};
const post = (f, path, value, identity = f.identity) =>
  fetch(f.origin + '/internal/v1/edge/fulfillment/' + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + identity.token,
      'X-Device-Id': identity.device_id,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(value),
  });

test('two actual PostgreSQL + HTTP worker + staff LAN: reserve, bank/fiscal gate, kitchen, ready, handoff; money unchanged by fulfillment', () =>
  fixture(async (f) => {
    assert.equal((await f.tick()).state, 'applied');
    assert.equal(await f.counts(f.pool, 'fulfillment_tasks'), '0');
    assert.equal((await f.tick()).state, 'acknowledged');
    assert.equal(
      (await f.commerce.readOrder(f.commercialScope, f.order.orderId)).state,
      'awaiting_payment',
    );
    const { sale } = await f.pay();
    assert.equal((await f.tick()).state, 'idle');
    assert.equal(await f.counts(f.pool, 'fulfillment_tasks'), '0');
    await f.fiscalize(sale);
    const financial = await f.commerce.readOrder(f.commercialScope, f.order.orderId);
    assert.equal((await f.tick()).state, 'applied');
    assert.equal((await f.tick()).state, 'acknowledged');
    let order = await body(await f.lan('/orders/' + f.order.orderId + '?stationId=' + f.assembly));
    assert.equal(order.state, 'accepted');
    assert.equal(order.tasks.length, 1);
    for (const action of ['start_task', 'complete_task']) {
      const task = order.tasks[0];
      const response = await f.lan('/orders/' + order.orderId + '/actions', {
        actor: f.cook,
        key: randomUUID(),
        body: {
          action,
          expectedVersion: order.version,
          taskId: task.taskId,
          expectedTaskVersion: task.version,
        },
      });
      assert.equal(response.status, 200);
      order = await body(await f.lan('/orders/' + order.orderId + '?stationId=' + f.assembly));
      await f.tick();
    }
    for (const action of ['ready', 'handoff']) {
      const response = await f.lan('/orders/' + order.orderId + '/actions', {
        key: randomUUID(),
        body: { action, expectedVersion: order.version },
      });
      assert.equal(response.status, 200);
      order = await body(await f.lan('/orders/' + order.orderId + '?stationId=' + f.assembly));
      await f.tick();
    }
    assert.equal(order.state, 'handed_over');
    const projection = (
      await f.cloud.query('SELECT * FROM cloud_fulfillment_projection WHERE order_id=$1', [
        order.orderId,
      ])
    ).rows[0];
    assert.equal(projection.state, 'handed_over');
    assert.deepEqual(await f.commerce.readOrder(f.commercialScope, order.orderId), financial);
    assert.equal(await f.counts(f.cloud, 'commerce_captures'), '1');
    assert.equal(await f.counts(f.cloud, 'commerce_fiscal_documents'), '1');
    assert.equal(await f.counts(f.pool, 'local_orders'), '0');
    const untouched = (
      await f.cloud.query(
        "SELECT attempts,acknowledged_at FROM commerce_outbox WHERE event_type IN ('payment.submit_requested','fiscal.submit_requested')",
      )
    ).rows;
    assert.ok(untouched.length > 0);
    assert.ok(untouched.every((r) => r.attempts === 0 && r.acknowledged_at === null));
  }));

test('lost pull response leaves cloud lease unacknowledged; restart/reclaim creates one reservation only', () =>
  fixture(async (f) => {
    let lost = false;
    assert.equal(
      (
        await f.tick({
          fetch: async (url, init) => {
            const r = await fetch(url, init);
            if (url.endsWith('/pull') && !lost) {
              lost = true;
              await r.arrayBuffer();
              throw Error('connection lost');
            }
            return r;
          },
        })
      ).error,
      'NETWORK_UNKNOWN',
    );
    assert.equal(await f.counts(f.pool, 'fulfillment_reservations'), '0');
    assert.equal((await pending(f)).pending_cloud, null);
    await expireCloud(f);
    assert.equal((await f.tick()).state, 'applied');
    await f.tick();
    assert.equal(await f.counts(f.pool, 'fulfillment_reservations'), '1');
    assert.equal(await f.counts(f.cloud, 'commerce_edge_inbox'), '1');
  }));

test('lost cloud ACK after edge commit retains exact pending event and recovers after restart', () =>
  fixture(async (f) => {
    const sent = [];
    let lost = false;
    const broken = async (url, init) => {
      if (url.endsWith('/ack')) sent.push(init.body);
      const r = await fetch(url, init);
      if (url.endsWith('/ack') && !lost) {
        lost = true;
        await r.arrayBuffer();
        throw Error('lost after cloud commit');
      }
      return r;
    };
    assert.equal((await f.tick({ fetch: broken })).error, 'NETWORK_UNKNOWN');
    assert.ok((await pending(f)).pending_cloud);
    assert.equal(await f.counts(f.pool, 'fulfillment_reservations'), '1');
    assert.equal((await f.tick({ fetch: broken })).state, 'applied');
    assert.equal(sent.length, 2);
    assert.equal(sent[0], sent[1]);
    assert.equal((await pending(f)).pending_cloud, null);
    assert.equal(await f.counts(f.pool, 'fulfillment_reservations'), '1');
    assert.equal(await f.counts(f.pool, 'fulfillment_inbox'), '1');
  }));

test('edge commit before lost ACK with expired lease reclaims immutable event; no reset or implicit reservation expiry', () =>
  fixture(async (f) => {
    assert.equal(
      (
        await f.tick({
          fetch: async (url, init) => {
            if (url.endsWith('/ack')) throw Error('offline');
            return fetch(url, init);
          },
        })
      ).state,
      'retry',
    );
    await expireCloud(f);
    assert.equal((await f.tick()).state, 'retry');
    assert.equal((await pending(f)).pending_cloud, null);
    assert.equal((await f.tick()).state, 'applied');
    assert.equal(await f.counts(f.pool, 'fulfillment_reservations'), '1');
    assert.equal(
      (await f.pool.query('SELECT state FROM fulfillment_reservations')).rows[0].state,
      'held',
    );
  }));

test('reverse cloud commit with lost response replays same event after lease expiry without second admission effect', () =>
  fixture(async (f) => {
    await f.tick();
    let lost = false;
    const sent = [];
    const broken = async (url, init) => {
      if (url.endsWith('/events')) sent.push(init.body);
      const r = await fetch(url, init);
      if (url.endsWith('/events') && !lost) {
        lost = true;
        await r.arrayBuffer();
        throw Error('lost');
      }
      return r;
    };
    assert.equal((await f.tick({ fetch: broken })).error, 'NETWORK_UNKNOWN');
    assert.equal(await f.counts(f.cloud, 'commerce_edge_inbox'), '1');
    assert.equal(
      (await f.pool.query('SELECT acknowledged_at FROM fulfillment_outbox')).rows[0]
        .acknowledged_at,
      null,
    );
    await f.pool.query(
      "UPDATE fulfillment_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE acknowledged_at IS NULL",
    );
    await f.tick({ fetch: broken });
    assert.equal(sent.length, 1, 'per-event retry_after survives early lease expiry');
    await expireEdge(f);
    assert.equal((await f.tick({ fetch: broken })).state, 'acknowledged');
    assert.equal(sent[0], sent[1]);
    assert.equal(await f.counts(f.cloud, 'commerce_edge_inbox'), '1');
    assert.equal(await f.counts(f.cloud, 'cloud_fulfillment_inbox'), '1');
  }));

test('pending storage failure prevents edge application and ACK; durable cloud event recovers', () =>
  fixture(async (f) => {
    let failed = false;
    const pool = {
      query(sql, args) {
        if (sql.includes('pending_cloud=$4') && !failed) {
          failed = true;
          throw Error('disk write failed');
        }
        return f.pool.query(sql, args);
      },
      connect: () => f.pool.connect(),
    };
    assert.equal((await syncFulfillmentOnce(pool, f.options)).error, 'LOCAL_STORAGE_UNKNOWN');
    assert.equal(await f.counts(f.pool, 'fulfillment_reservations'), '0');
    assert.equal(
      (
        await f.cloud.query(
          "SELECT acknowledged_at FROM commerce_outbox WHERE event_type='edge.admission_requested'",
        )
      ).rows[0].acknowledged_at,
      null,
    );
    await expireCloud(f);
    assert.equal((await f.tick()).state, 'applied');
  }));

test('two competing edge workers cannot concurrently claim; no transaction stays open across blocked HTTP', () =>
  fixture(async (f) => {
    let signal, release;
    const entered = new Promise((r) => (signal = r)),
      gate = new Promise((r) => (release = r));
    const first = f.tick({
      fetch: async (url, init) => {
        if (url.endsWith('/pull')) {
          signal();
          await gate;
        }
        return fetch(url, init);
      },
    });
    await entered;
    assert.equal((await f.tick()).state, 'busy');
    const activity = await f.pool.query(
      "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND query LIKE '%fulfillment_transport_state%'",
    );
    assert.equal(activity.rows[0].count, '0');
    release();
    assert.equal((await first).state, 'applied');
    assert.equal(await f.counts(f.pool, 'fulfillment_reservations'), '1');
  }));

test('durable missing-routing rejection retains event; approved routing repair can retry without issuing another order', () =>
  fixture(async (f) => {
    await f.pool.query('UPDATE branch_config SET ordering_enabled=false WHERE id=$1', [
      f.scope.branchId,
    ]);
    assert.equal((await f.tick()).error, 'LOCAL_NOT_READY');
    assert.ok((await pending(f)).pending_cloud);
    assert.equal(await f.counts(f.pool, 'fulfillment_reservations'), '0');
    await f.pool.query('UPDATE branch_config SET ordering_enabled=true WHERE id=$1', [
      f.scope.branchId,
    ]);
    assert.equal((await f.tick()).state, 'applied');
    assert.equal(await f.counts(f.pool, 'fulfillment_reservations'), '1');
  }));

test('private HTTP requires actual device, ignores no client scope, bounded body, default disabled and no unsafe routes', () =>
  fixture(async (f) => {
    const value = { workerId: randomUUID(), leaseSeconds: 30 };
    assert.equal(
      (await post(f, 'pull', value, { ...f.identity, token: 'f'.repeat(64) })).status,
      401,
    );
    assert.equal((await post(f, 'pull', { ...value, branchId: randomUUID() })).status, 400);
    assert.equal((await post(f, 'pull', { ...value, extra: 'x'.repeat(66000) })).status, 413);
    for (const path of ['reserve', 'authorize', 'provision', 'payment', 'refund'])
      assert.equal((await post(f, path, {})).status, 404);
    await f.cloud.query("UPDATE devices SET status='revoked' WHERE id=$1", [f.identity.device_id]);
    assert.equal((await post(f, 'pull', value)).status, 401);
  }));
test('disabled API cannot claim even with valid active device identity', () =>
  fixture(
    async (f) => {
      assert.equal(
        (await post(f, 'pull', { workerId: randomUUID(), leaseSeconds: 30 })).status,
        404,
      );
      assert.equal(
        (await f.cloud.query('SELECT sum(attempts) AS attempts FROM commerce_outbox')).rows[0]
          .attempts,
        '0',
      );
    },
    { enabled: false },
  ));

test('unverified proxy409 after local commit retains exact pending delivery and safely retries', () =>
  fixture(async (f) => {
    const result = await f.tick({
      fetch: async (url, init) =>
        url.endsWith('/ack')
          ? new Response('<html>Conflict</html>', { status: 409 })
          : fetch(url, init),
    });
    assert.equal(result.state, 'retry');
    const saved = (await pending(f)).pending_cloud;
    assert.ok(saved);
    assert.equal(await f.counts(f.pool, 'fulfillment_reservations'), '1');
    assert.equal((await f.tick()).state, 'applied');
    assert.equal(await f.counts(f.pool, 'fulfillment_reservations'), '1');
    assert.equal((await pending(f)).pending_cloud, null);
  }));

test('enabled readiness requires cloud014 and edge006; additive migrations are idempotent', () =>
  fixture(async (f) => {
    assert.equal((await fetch(f.origin + '/health/ready')).status, 200);
    assert.equal((await fetch(f.edgeOrigin + '/health/ready')).status, 200);
    await f.cloud.query(
      "DELETE FROM schema_migrations WHERE scope='cloud' AND version='014_cloud_fulfillment_transport.sql'",
    );
    assert.equal((await fetch(f.origin + '/health/ready')).status, 503);
    await f.pool.query(
      "DELETE FROM schema_migrations WHERE scope='edge' AND version='006_edge_fulfillment_transport.sql'",
    );
    assert.equal((await fetch(f.edgeOrigin + '/health/ready')).status, 503);
  }));
test('disabled API readiness does not require transport014 serving schema', () =>
  fixture(
    async (f) => {
      await f.cloud.query(
        "DELETE FROM schema_migrations WHERE scope='cloud' AND version='014_cloud_fulfillment_transport.sql'",
      );
      assert.equal((await fetch(f.origin + '/health/ready')).status, 200);
    },
    { enabled: false },
  ));

test('unsupported SKU A cannot starve valid B even after cloud lease expiry; exact repair resolves durable failure', () =>
  fixture(async (f) => {
    await provisionFulfillment(f.pool, {
      ...f.setup,
      routing: {
        ...f.setup.routing,
        version: 2,
        routes: f.setup.routing.routes.filter((r) => r.productId !== 'burger'),
      },
    });
    const other = await f.createAdditional('fries');
    assert.equal((await f.tick()).state, 'parked');
    let failed = (await f.pool.query('SELECT * FROM fulfillment_transport_failures')).rows[0];
    assert.equal(failed.attempts, '1');
    assert.equal(failed.command.payload.orderId, f.order.orderId);
    assert.equal((await pending(f)).pending_cloud, null);
    await expireCloud(f);
    const progressed = await f.tick();
    assert.equal(progressed.state, 'applied');
    assert.equal(progressed.unresolvedFailures, 1);
    assert.equal(
      (await f.pool.query('SELECT order_id FROM fulfillment_reservations')).rows[0].order_id,
      other.orderId,
    );
    const heldCloud = (
      await f.cloud.query('SELECT acknowledged_at FROM commerce_outbox WHERE order_id=$1', [
        f.order.orderId,
      ])
    ).rows[0];
    assert.equal(heldCloud.acknowledged_at, null);
    await provisionFulfillment(f.pool, { ...f.setup, routing: { ...f.setup.routing, version: 3 } });
    assert.equal((await f.tick()).state, 'applied');
    failed = (await f.pool.query('SELECT * FROM fulfillment_transport_failures')).rows[0];
    assert.ok(failed.resolved_at);
    assert.equal(await f.counts(f.pool, 'fulfillment_reservations'), '2');
    assert.equal(await f.counts(f.pool, 'fulfillment_tasks'), '0');
  }));

test('changed body under parked event ID cannot replace durable failure or clear pending', () =>
  fixture(async (f) => {
    await provisionFulfillment(f.pool, {
      ...f.setup,
      routing: {
        ...f.setup.routing,
        version: 2,
        routes: f.setup.routing.routes.filter((r) => r.productId !== 'burger'),
      },
    });
    await f.tick();
    const failure = (await f.pool.query('SELECT * FROM fulfillment_transport_failures')).rows[0];
    const command = JSON.parse(JSON.stringify(failure.command));
    command.payload.snapshot.lines[0].description = 'Changed';
    command.payload.quoteDigest = digest(command.payload.snapshot);
    await f.pool.query(
      'UPDATE fulfillment_transport_state SET pending_cloud=$2 WHERE branch_id=$1',
      [
        f.scope.branchId,
        { scope: f.scope, delivery: { command, leaseToken: randomUUID() }, workerId: randomUUID() },
      ],
    );
    await provisionFulfillment(f.pool, { ...f.setup, routing: { ...f.setup.routing, version: 3 } });
    assert.equal((await f.tick()).error, 'LOCAL_CONFLICT');
    assert.ok((await pending(f)).pending_cloud);
    assert.equal(
      (await f.pool.query('SELECT request_hash FROM fulfillment_transport_failures')).rows[0]
        .request_hash,
      failure.request_hash,
    );
    assert.equal(
      (await f.pool.query('SELECT resolved_at FROM fulfillment_transport_failures')).rows[0]
        .resolved_at,
      null,
    );
    assert.equal(await f.counts(f.pool, 'fulfillment_reservations'), '0');
  }));

test('multiple rejected historical reverse events do not suppress valid forward or reverse progress', () =>
  fixture(async (f) => {
    await f.accepted();
    await f.accepted();
    const first = await f.tick();
    assert.equal(first.state, 'applied');
    assert.equal(first.reverseError, 'HTTP_REJECTED');
    assert.ok(first.unresolvedReverseFailures > 0);
    // Expired poisoned leases still lose priority to the unattempted valid event.
    for (let i = 0; i < 5; i++) {
      await expireEdge(f);
      await f.tick();
    }
    assert.equal(
      (await f.commerce.readOrder(f.commercialScope, f.order.orderId)).state,
      'awaiting_payment',
    );
    const failures = (await f.pool.query('SELECT * FROM fulfillment_transport_reverse_failures'))
      .rows;
    assert.equal(failures.length, 4);
    assert.ok(failures.every((r) => r.resolved_at === null));
    const unacked = (
      await f.pool.query(
        'SELECT count(*) FROM fulfillment_outbox WHERE order_id<>$1 AND acknowledged_at IS NULL',
        [f.order.orderId],
      )
    ).rows[0].count;
    assert.equal(unacked, '4');
    const { sale } = await f.pay();
    await f.fiscalize(sale);
    await expireEdge(f);
    assert.equal((await f.tick()).state, 'applied');
    await expireEdge(f);
    await f.tick();
    assert.equal(
      (
        await f.cloud.query('SELECT state FROM cloud_fulfillment_projection WHERE order_id=$1', [
          f.order.orderId,
        ])
      ).rows[0].state,
      'accepted',
    );
  }));

test('competing worker cannot clear pending with an unknown in-flight ACK', () =>
  fixture(async (f) => {
    let entered, release;
    const signal = new Promise((r) => (entered = r)),
      gate = new Promise((r) => (release = r));
    const first = f.tick({
      fetch: async (url, init) => {
        if (url.endsWith('/ack')) {
          entered();
          await gate;
          throw Error('unknown ACK');
        }
        return fetch(url, init);
      },
    });
    await signal;
    const exact = (await pending(f)).pending_cloud;
    assert.ok(exact);
    assert.equal((await f.tick()).state, 'busy');
    assert.deepEqual((await pending(f)).pending_cloud, exact);
    release();
    assert.equal((await first).error, 'NETWORK_UNKNOWN');
    assert.deepEqual((await pending(f)).pending_cloud, exact);
    assert.equal(await f.counts(f.pool, 'fulfillment_transport_failures'), '0');
  }));

test('a stopped order does not block another customer; the original command remains durable', () =>
  fixture(async (f) => {
    const { localSelectionIds } = await import('@pickchick/menu-sync');
    const id = localSelectionIds(f.scope.branchId, 'burger', [])[0];
    await f.pool.query(
      'INSERT INTO local_stops(branch_id,variant_id,stopped,version,reason) VALUES($1,$2,true,1,$$Synthetic stop$$)',
      [f.scope.branchId, id],
    );
    const other = await f.createAdditional('fries');
    assert.equal((await f.tick()).error, 'LOCAL_NOT_READY');
    assert.equal((await pending(f)).pending_cloud, null);
    await expireCloud(f);
    assert.equal((await f.tick()).state, 'applied');
    assert.equal(
      (await f.pool.query('SELECT order_id FROM fulfillment_reservations')).rows[0].order_id,
      other.orderId,
    );
    assert.equal(
      (
        await f.cloud.query('SELECT acknowledged_at FROM commerce_outbox WHERE order_id=$1', [
          f.order.orderId,
        ])
      ).rows[0].acknowledged_at,
      null,
    );
    await f.pool.query('UPDATE local_stops SET stopped=false');
    await expireCloud(f);
    assert.equal((await f.tick()).state, 'applied');
    assert.equal(await f.counts(f.pool, 'fulfillment_reservations'), '2');
  }));
