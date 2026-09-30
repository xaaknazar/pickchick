import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Resources } from '@pickchick/platform';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '@pickchick/api';
import { createEdge } from '@pickchick/edge';
import { provisionDevice, revokeDevice, hashJson } from '@pickchick/menu-sync';
import { createQuote, createLocalOrder, cancelLocalOrder } from '@pickchick/local-orders';
import {
  provisionCloudPosSync,
  provisionEdgePosSync,
  syncPosOrdersOnce,
  parseEvent,
  receiptFor,
} from '../dist/index.js';
import { withOrderDesk, staffAuth, staffHeaders } from '../../../tests/helpers/orders.mjs';
import { running, headersFor } from '../../../tests/helpers/sync.mjs';

const path = '/internal/v1/edge/pos-orders/events';
async function fixture(run, enabled = true) {
  await withOrderDesk(async (ctx) => {
    const identity = await provisionDevice(ctx.cloud.pool, ctx.device);
    const scope = await provisionEdgePosSync(ctx.edge.pool, {
      organizationId: ctx.org,
      branchId: ctx.branch,
      deviceId: ctx.device,
    });
    await provisionCloudPosSync(ctx.cloud.pool, scope);
    const cloud = await running(createApi, { ...ctx.cloud.config, posOrderSyncEnabled: enabled });
    const options = { enabled: true, branchId: ctx.branch, origin: cloud.url, identity };
    try {
      await run({ ...ctx, identity, scope, cloudServer: cloud, options });
    } finally {
      await cloud.app.close();
    }
  });
}
async function order(ctx, cancel = false) {
  const quote = await createQuote(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), ctx.cart);
  const value = await createLocalOrder(
    ctx.edge.pool,
    ctx.branch,
    staffAuth(ctx.cashier),
    randomUUID(),
    { quote_id: quote.quote_id },
  );
  if (cancel)
    await cancelLocalOrder(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.cashier),
      randomUUID(),
      value.order_id,
      { expected_version: 1, reason: 'Synthetic cancellation' },
    );
  return value;
}
async function events(ctx) {
  return (
    await ctx.edge.pool.query(
      "SELECT * FROM outbox_events WHERE aggregate_type='order_commercial' ORDER BY producer_sequence",
    )
  ).rows.map((row) =>
    parseEvent({
      event_id: row.event_id,
      producer_id: row.producer_id,
      producer_sequence: row.producer_sequence,
      aggregate_type: row.aggregate_type,
      aggregate_id: row.aggregate_id,
      aggregate_version: Number(row.aggregate_version),
      event_type: row.event_type,
      schema_version: row.schema_version,
      branch_id: row.branch_id,
      occurred_at: row.occurred_at.toISOString(),
      correlation_id: row.correlation_id,
      causation_id: row.causation_id,
      payload: row.payload,
    }),
  );
}
async function pending(ctx) {
  return Number(
    (
      await ctx.edge.pool.query(
        "SELECT count(*) FROM outbox_events WHERE aggregate_type='order_commercial' AND acknowledged_at IS NULL",
      )
    ).rows[0].count,
  );
}
async function count(ctx, table) {
  assert.ok(
    [
      'pos_order_sync_inbox',
      'pos_order_sync_projection',
      'commerce_orders',
      'commerce_payment_attempts',
      'commerce_outbox',
    ].includes(table),
  );
  return Number((await ctx.cloud.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
}
async function retryNow(ctx) {
  await ctx.edge.pool.query('UPDATE pos_order_sync_state SET retry_after=NULL');
}
async function post(ctx, event, identity = ctx.identity, suffix = '') {
  return fetch(ctx.cloudServer.url + path + suffix, {
    method: 'POST',
    headers: headersFor(identity),
    body: JSON.stringify(event),
  });
}

test('real POS HTTP creates during WAN failure; durable creation + cancellation drain on recovery exactly once', async () => {
  await fixture(async (ctx) => {
    const edge = await running(createEdge, ctx.edge.config);
    const unavailable = createServer();
    await new Promise((resolve) => unavailable.listen(0, '127.0.0.1', resolve));
    const downOrigin = `http://127.0.0.1:${unavailable.address().port}`;
    await new Promise((resolve) => unavailable.close(resolve));
    try {
      const quoteResponse = await fetch(edge.url + '/edge/v1/checkout/quotes', {
        method: 'POST',
        headers: staffHeaders(ctx.cashier),
        body: JSON.stringify(ctx.cart),
      });
      assert.equal(quoteResponse.status, 201);
      const quote = await quoteResponse.json();
      const created = await fetch(edge.url + '/edge/v1/orders', {
        method: 'POST',
        headers: staffHeaders(ctx.cashier),
        body: JSON.stringify({ quote_id: quote.quote_id }),
      });
      assert.equal(created.status, 201);
      const value = await created.json();
      assert.equal(value.payment_state, 'not_started');
      const cancelled = await fetch(edge.url + `/edge/v1/orders/${value.order_id}/cancel`, {
        method: 'POST',
        headers: staffHeaders(ctx.cashier),
        body: JSON.stringify({ expected_version: 1, reason: 'Synthetic offline cancellation' }),
      });
      assert.equal(cancelled.status, 200);
      assert.equal(await pending(ctx), 2);
      assert.equal(
        (await syncPosOrdersOnce(ctx.edge.pool, { ...ctx.options, origin: downOrigin })).state,
        'retry',
      );
      assert.equal(await pending(ctx), 2);
      assert.equal(await count(ctx, 'pos_order_sync_inbox'), 0);
      const state = (await ctx.edge.pool.query('SELECT * FROM pos_order_sync_state')).rows[0];
      assert.equal(state.failure_count, 1);
      assert.equal(state.pending_hash, hashJson(state.pending_envelope));
      assert.equal((await syncPosOrdersOnce(ctx.edge.pool, ctx.options)).state, 'retry');
      await retryNow(ctx); // Model elapsed backoff without sleeping in the test.
      assert.equal((await syncPosOrdersOnce(ctx.edge.pool, ctx.options)).state, 'delivered');
      assert.equal((await syncPosOrdersOnce(ctx.edge.pool, ctx.options)).state, 'delivered');
      assert.equal((await syncPosOrdersOnce(ctx.edge.pool, ctx.options)).state, 'idle');
      assert.equal(await pending(ctx), 0);
      const all = await events(ctx);
      for (const event of all) {
        const response = await post(ctx, event);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), receiptFor(event));
      }
      assert.equal(await count(ctx, 'pos_order_sync_inbox'), 2);
      assert.equal(await count(ctx, 'pos_order_sync_projection'), 1);
      const projection = (await ctx.cloud.pool.query('SELECT * FROM pos_order_sync_projection'))
        .rows[0];
      assert.equal(projection.version, 2);
      assert.equal(projection.state, 'cancelled');
      assert.equal(projection.payment_state, 'not_started');
      assert.equal(projection.fiscal_state, 'not_requested');
      assert.equal(projection.fulfillment_state, 'blocked');
      assert.equal(projection.commercial_owner, 'edge');
      assert.equal(await count(ctx, 'commerce_orders'), 0);
      assert.equal(await count(ctx, 'commerce_payment_attempts'), 0);
      assert.equal(await count(ctx, 'commerce_outbox'), 0);
    } finally {
      await edge.app.close();
    }
  });
});

test('lost cloud ACK after commit retries original envelope and concurrent worker cannot skip creation', async () => {
  await fixture(async (ctx) => {
    await order(ctx, true);
    let entered, release;
    const started = new Promise((resolve) => {
        entered = resolve;
      }),
      gate = new Promise((resolve) => {
        release = resolve;
      });
    const first = syncPosOrdersOnce(ctx.edge.pool, ctx.options, {
      fetch: async (...args) => {
        const response = await fetch(...args);
        assert.equal(response.status, 200);
        await response.arrayBuffer();
        entered();
        await gate;
        throw new Error('Synthetic lost ACK');
      },
    });
    await started;
    try {
      assert.equal((await syncPosOrdersOnce(ctx.edge.pool, ctx.options)).state, 'busy');
    } finally {
      release();
    }
    assert.equal((await first).state, 'retry');
    assert.equal(await pending(ctx), 2);
    assert.equal(await count(ctx, 'pos_order_sync_inbox'), 1);
    await retryNow(ctx);
    assert.equal((await syncPosOrdersOnce(ctx.edge.pool, ctx.options)).state, 'delivered');
    assert.equal((await syncPosOrdersOnce(ctx.edge.pool, ctx.options)).state, 'delivered');
    assert.equal(await count(ctx, 'pos_order_sync_inbox'), 2);
    const attempts = (
      await ctx.edge.pool.query(
        "SELECT attempts FROM outbox_events WHERE aggregate_type='order_commercial' ORDER BY producer_sequence",
      )
    ).rows;
    assert.deepEqual(
      attempts.map((row) => row.attempts),
      [2, 1],
    );
  });
});

test('expired worker lease and persisted pending body recover after process death; unknown or changed ACK never acknowledges', async () => {
  await fixture(async (ctx) => {
    await order(ctx);
    const [event] = await events(ctx);
    for (const receipt of [
      { ...receiptFor(event), eventId: randomUUID() },
      { ...receiptFor(event), payloadHash: '0'.repeat(64) },
      { ...receiptFor(event), extra: true },
    ]) {
      assert.equal(
        (
          await syncPosOrdersOnce(ctx.edge.pool, ctx.options, {
            fetch: async () => Response.json(receipt),
          })
        ).state,
        'retry',
      );
      assert.equal(await pending(ctx), 1);
      await retryNow(ctx);
    }
    await ctx.edge.pool.query(
      "UPDATE pos_order_sync_state SET lease_token=$1,lease_until=clock_timestamp()-interval '1 second'",
      [randomUUID()],
    );
    assert.equal((await syncPosOrdersOnce(ctx.edge.pool, ctx.options)).state, 'delivered');
    assert.equal(await pending(ctx), 0);
    assert.equal(await count(ctx, 'pos_order_sync_inbox'), 1);
  });
});

test('scope/auth/revocation, version and immutable hash protect projection including replay', async () => {
  await fixture(async (ctx) => {
    await order(ctx, true);
    const [created, cancelled] = await events(ctx);
    assert.equal((await post(ctx, cancelled)).status, 409);
    assert.equal(await count(ctx, 'pos_order_sync_inbox'), 0);
    assert.equal(
      (await post(ctx, created, { ...ctx.identity, token: '0'.repeat(64) })).status,
      401,
    );
    assert.equal(
      (await post(ctx, created, { ...ctx.identity, device_id: randomUUID() })).status,
      401,
    );
    const branchChanged = globalThis.structuredClone(created);
    branchChanged.branch_id = randomUUID();
    branchChanged.payload.snapshot.branch_id = branchChanged.branch_id;
    assert.equal((await post(ctx, branchChanged)).status, 403);
    assert.equal((await post(ctx, { ...created, producer_id: randomUUID() })).status, 403);
    assert.equal((await post(ctx, created, ctx.identity, '?token=synthetic')).status, 400);
    assert.equal(
      (await post(ctx, { ...created, payload: { ...created.payload, payment_state: 'paid' } }))
        .status,
      400,
    );
    assert.equal((await post(ctx, created)).status, 200);
    const changed = globalThis.structuredClone(created);
    changed.payload.snapshot.lines[0].name.ru = 'Changed snapshot';
    assert.equal((await post(ctx, changed)).status, 409);
    assert.equal((await post(ctx, { ...created, event_id: randomUUID() })).status, 409);
    const reusedQuote = globalThis.structuredClone(created);
    reusedQuote.event_id = randomUUID();
    reusedQuote.aggregate_id = randomUUID();
    reusedQuote.correlation_id = reusedQuote.aggregate_id;
    reusedQuote.payload.order_id = reusedQuote.aggregate_id;
    reusedQuote.producer_sequence = '900';
    assert.equal((await post(ctx, reusedQuote)).status, 409);
    const badCancel = globalThis.structuredClone(cancelled);
    badCancel.payload.snapshot.lines[0].name.ru = 'Changed cancel';
    assert.equal((await post(ctx, badCancel)).status, 409);
    assert.equal((await post(ctx, cancelled)).status, 200);
    const otherDevice = randomUUID(),
      otherBranch = randomUUID();
    await ctx.cloud.pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'SYNC2','Synthetic other')",
      [otherBranch, ctx.org, ctx.legal],
    );
    await ctx.cloud.pool.query(
      "INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES($1,$2,$3,'edge','Synthetic other')",
      [otherDevice, otherBranch, ctx.org],
    );
    const otherIdentity = await provisionDevice(ctx.cloud.pool, otherDevice);
    assert.equal((await post(ctx, created, otherIdentity)).status, 403);
    await ctx.cloud.pool.query(
      "UPDATE device_credentials SET issued_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE device_id=$1",
      [ctx.device],
    );
    assert.equal((await post(ctx, created)).status, 401);
    await revokeDevice(ctx.cloud.pool, ctx.device);
    assert.equal((await post(ctx, created)).status, 401);
    assert.equal((await post(ctx, cancelled)).status, 401);
    assert.equal(await count(ctx, 'pos_order_sync_inbox'), 2);
  });
});

test('distinct orders permit filtered producer sequence gaps; source, pending and inbox cannot be rewritten', async () => {
  await fixture(async (ctx) => {
    await order(ctx);
    await ctx.edge.pool.query(
      'UPDATE local_order_streams SET last_sequence=last_sequence+9 WHERE branch_id=$1',
      [ctx.branch],
    );
    await order(ctx);
    const [a, b] = await events(ctx);
    assert.equal(BigInt(b.producer_sequence) - BigInt(a.producer_sequence), 10n);
    assert.equal((await post(ctx, b)).status, 200);
    assert.equal((await post(ctx, a)).status, 200);
    assert.equal(await count(ctx, 'pos_order_sync_projection'), 2);
    const check = (error) => error.code === '23514';
    await assert.rejects(
      ctx.edge.pool.query(
        'UPDATE outbox_events SET payload=payload||\'{"tamper":true}\'::jsonb WHERE event_id=$1',
        [a.event_id],
      ),
      check,
    );
    await assert.rejects(
      ctx.edge.pool.query('DELETE FROM outbox_events WHERE event_id=$1', [a.event_id]),
      check,
    );
    await assert.rejects(
      ctx.cloud.pool.query('UPDATE pos_order_sync_inbox SET payload_hash=$1', ['0'.repeat(64)]),
      check,
    );
    await assert.rejects(
      ctx.cloud.pool.query(
        "UPDATE pos_order_sync_projection SET state='cancelled',version=2,total_minor=0",
      ),
      check,
    );
    await syncPosOrdersOnce(ctx.edge.pool, ctx.options, {
      fetch: async () => {
        throw new Error('offline');
      },
    });
    await assert.rejects(
      ctx.edge.pool.query('UPDATE pos_order_sync_state SET pending_hash=$1', ['0'.repeat(64)]),
      check,
    );
    await assert.rejects(
      provisionEdgePosSync(ctx.edge.pool, {
        organizationId: ctx.org,
        branchId: ctx.branch,
        deviceId: randomUUID(),
      }),
      (error) => error.code === 'CONFLICT',
    );
    await assert.rejects(
      provisionCloudPosSync(ctx.cloud.pool, { ...ctx.scope, producerId: randomUUID() }),
      (error) => error.code === 'CONFLICT',
    );
    await retryNow(ctx);
    await syncPosOrdersOnce(ctx.edge.pool, ctx.options);
    await syncPosOrdersOnce(ctx.edge.pool, ctx.options);
    assert.equal(await pending(ctx), 0);
    assert.equal(await count(ctx, 'pos_order_sync_inbox'), 2);
  });
});

test('feature is disabled by default and inactive trusted binding stops even valid duplicate', async () => {
  await fixture(async (ctx) => {
    await order(ctx);
    const [event] = await events(ctx);
    assert.equal((await post(ctx, event)).status, 404);
    assert.equal(await count(ctx, 'pos_order_sync_inbox'), 0);
  }, false);
  await fixture(async (ctx) => {
    await order(ctx);
    const [event] = await events(ctx);
    assert.equal((await post(ctx, event)).status, 200);
    await provisionCloudPosSync(ctx.cloud.pool, ctx.scope, false);
    assert.equal((await post(ctx, event)).status, 403);
    await provisionEdgePosSync(
      ctx.edge.pool,
      { organizationId: ctx.org, branchId: ctx.branch, deviceId: ctx.device },
      false,
    );
    assert.equal((await syncPosOrdersOnce(ctx.edge.pool, ctx.options)).state, 'disabled');
    assert.equal(await pending(ctx), 1);
  });
});

test('projection failure rolls back cloud inbox; same pending delivery succeeds after repair', async () => {
  await fixture(async (ctx) => {
    await order(ctx);
    await ctx.cloud.pool.query(
      "CREATE FUNCTION fail_pos_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic fault' USING ERRCODE='23514'; END $$",
    );
    await ctx.cloud.pool.query(
      'CREATE TRIGGER fail_pos_projection BEFORE INSERT ON pos_order_sync_projection FOR EACH ROW EXECUTE FUNCTION fail_pos_projection()',
    );
    assert.equal((await syncPosOrdersOnce(ctx.edge.pool, ctx.options)).state, 'retry');
    assert.equal(await pending(ctx), 1);
    assert.equal(await count(ctx, 'pos_order_sync_inbox'), 0);
    await ctx.cloud.pool.query('DROP TRIGGER fail_pos_projection ON pos_order_sync_projection');
    await retryNow(ctx);
    assert.equal((await syncPosOrdersOnce(ctx.edge.pool, ctx.options)).state, 'delivered');
    assert.equal(await count(ctx, 'pos_order_sync_inbox'), 1);
  });
});

test('enabled readiness requires migration and edge binding; disabled serving stays on earlier schema', async () => {
  await fixture(async (ctx) => {
    for (const [side, version] of [
      ['cloud', '016_cloud_pos_order_sync.sql'],
      ['edge', '008_edge_pos_order_sync.sql'],
    ]) {
      const config = { ...ctx[side].config, edgeDeviceId: ctx.device };
      delete config.redisUrl;
      const on = new Resources({ ...config, posOrderSyncEnabled: true }),
        off = new Resources({ ...config, posOrderSyncEnabled: false });
      try {
        assert.equal((await on.readiness()).ready, true);
        if (side === 'edge') {
          const wrong = new Resources({
            ...config,
            edgeDeviceId: randomUUID(),
            posOrderSyncEnabled: true,
          });
          try {
            assert.equal((await wrong.readiness()).ready, false);
          } finally {
            await wrong.onApplicationShutdown();
          }
        }
        await ctx[side].pool.query('DELETE FROM schema_migrations WHERE version=$1', [version]);
        assert.equal((await on.readiness()).ready, false);
        assert.equal((await off.readiness()).ready, true);
      } finally {
        await on.onApplicationShutdown();
        await off.onApplicationShutdown();
      }
    }
  });
});

test('runtime worker handles SIGTERM and restarts pending network delivery from PostgreSQL', async () => {
  await fixture(async (ctx) => {
    await order(ctx, true);
    const directory = await mkdtemp(join(tmpdir(), 'pickchick-pos-worker-'));
    const identityPath = join(directory, '.local', 'edge-identity.json');
    await mkdir(join(directory, '.local'), { mode: 0o700 });
    await mkdir(join(directory, 'scripts'));
    // Execute unchanged worker files in an isolated fixture; never touch the operator's identity.
    for (const name of ['pos-order-sync-worker.mjs', 'private-identity.mjs'])
      await copyFile(
        new URL('../../../scripts/' + name, import.meta.url),
        join(directory, 'scripts', name),
      );
    await symlink(
      fileURLToPath(new URL('../../../node_modules', import.meta.url)),
      join(directory, 'node_modules'),
      'dir',
    );
    await writeFile(identityPath, JSON.stringify(ctx.identity), { flag: 'wx', mode: 0o600 });
    const unavailable = createServer();
    await new Promise((resolve) => unavailable.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${unavailable.address().port}`;
    await new Promise((resolve) => unavailable.close(resolve));
    let child;
    function start(origin) {
      return spawn(process.execPath, [join(directory, 'scripts', 'pos-order-sync-worker.mjs')], {
        env: {
          ...process.env,
          APP_ENV: 'test',
          EDGE_DATABASE_URL: ctx.edge.config.databaseUrl,
          EDGE_BRANCH_ID: ctx.branch,
          EDGE_DEVICE_ID: ctx.device,
          EDGE_POS_ORDER_SYNC_ENABLED: 'true',
          CLOUD_POS_ORDER_SYNC_ENABLED: 'false',
          EDGE_POS_ORDER_SYNC_CLOUD_ORIGIN: origin,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    function state(process, state, count = 1) {
      return new Promise((resolve, reject) => {
        let text = '',
          seen = 0;
        const timeout = setTimeout(() => done(new Error('Worker state timeout')), 10000);
        const data = (chunk) => {
          text += chunk.toString();
          let newline;
          while ((newline = text.indexOf('\n')) >= 0) {
            const line = text.slice(0, newline);
            text = text.slice(newline + 1);
            try {
              if (JSON.parse(line).state === state && ++seen === count) done();
            } catch {
              done(new Error('Invalid worker log'));
            }
          }
        };
        const exit = () => done(new Error('Worker exited before expected state'));
        const done = (error) => {
          clearTimeout(timeout);
          process.stdout.off('data', data);
          process.off('exit', exit);
          if (error) reject(error);
          else resolve();
        };
        process.stdout.on('data', data);
        process.once('exit', exit);
      });
    }
    async function stop() {
      const ended = once(child, 'exit');
      child.kill('SIGTERM');
      const [code] = await ended;
      assert.equal(code, 0);
      child = undefined;
    }
    try {
      child = start(origin);
      await state(child, 'retry');
      await stop();
      assert.equal(await pending(ctx), 2);
      child = start(ctx.cloudServer.url);
      await state(child, 'delivered', 2);
      await stop();
      assert.equal(await pending(ctx), 0);
      assert.equal(await count(ctx, 'pos_order_sync_inbox'), 2);
    } finally {
      if (child) {
        const ended = once(child, 'exit');
        child.kill('SIGKILL');
        await ended;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
