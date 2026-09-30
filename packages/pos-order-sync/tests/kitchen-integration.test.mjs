import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPool } from '@pickchick/database';
import { createApi } from '@pickchick/api';
import { provisionDevice, hashJson, revokeDevice } from '@pickchick/menu-sync';
import {
  createQuote,
  createLocalOrder,
  cancelLocalOrder,
  provisionStaff,
} from '@pickchick/local-orders';
import {
  EdgeFulfillment,
  localUnpaidExecution,
  provisionFulfillment,
  grantStation,
} from '@pickchick/edge-fulfillment';
import { Backoffice, grantBackoffice } from '../../backoffice-core/dist/index.js';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import { withOrderDesk, staffAuth } from '../../../tests/helpers/orders.mjs';
import { running, headersFor } from '../../../tests/helpers/sync.mjs';
import {
  posSyncWorkerGrants,
  posSyncReceiverGrants,
} from '../../../infra/windows/pos-sync-worker-grants.mjs';
import {
  provisionEdgePosSync,
  provisionCloudPosSync,
  syncPosOrdersOnce,
  syncPosKitchenOnce,
  parseKitchenEvent,
  kitchenReceiptFor,
  receivePosKitchen,
  receivePosOrder,
  retryPosKitchenDelivery,
} from '../dist/index.js';

async function fixture(run) {
  await withOrderDesk(async (ctx) => {
    const prep = randomUUID(),
      assembly = randomUUID();
    await provisionFulfillment(ctx.edge.pool, {
      organizationId: ctx.org,
      branchId: ctx.branch,
      deviceId: ctx.device,
      producerId: randomUUID(),
      stations: [
        { id: prep, kind: 'prep', name: 'Synthetic prep' },
        { id: assembly, kind: 'assembly', name: 'Synthetic assembly' },
      ],
      routing: {
        version: 1,
        assemblyStationId: assembly,
        routes: [{ productId: ctx.release.items[0].product_id, stationId: prep, kind: 'prep' }],
      },
    });
    const cook = await provisionStaff(ctx.edge.pool, ctx.branch, ctx.setup('kitchen'));
    await grantStation(ctx.edge.pool, ctx.branch, cook.staff_id, prep);
    await grantStation(ctx.edge.pool, ctx.branch, cook.staff_id, assembly);
    await ctx.edge.pool.query(
      "UPDATE branch_config SET pos_service_mode='unpaid_service' WHERE id=$1",
      [ctx.branch],
    );
    const identity = await provisionDevice(ctx.cloud.pool, ctx.device),
      scope = await provisionEdgePosSync(ctx.edge.pool, {
        organizationId: ctx.org,
        branchId: ctx.branch,
        deviceId: ctx.device,
      });
    await provisionCloudPosSync(ctx.cloud.pool, scope);
    const server = await running(createApi, { ...ctx.cloud.config, posOrderSyncEnabled: true });
    const full = {
      ...ctx,
      prep,
      assembly,
      cook,
      identity,
      scope,
      server,
      repo: new EdgeFulfillment(ctx.edge.pool),
      port: localUnpaidExecution({ enabled: true, deviceId: ctx.device }),
      options: { enabled: true, branchId: ctx.branch, origin: server.url, identity },
    };
    try {
      await run(full);
    } finally {
      await server.app.close();
    }
  });
}
async function order(ctx) {
  const quote = await createQuote(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), ctx.cart);
  return createLocalOrder(
    ctx.edge.pool,
    ctx.branch,
    staffAuth(ctx.cashier),
    randomUUID(),
    { quote_id: quote.quote_id, kitchen_admission: 'unpaid' },
    ctx.port,
  );
}
async function finish(ctx, o) {
  let current = await ctx.repo.readOrder(ctx.branch, staffAuth(ctx.cook), o.order_id, {
    stationId: ctx.prep,
  });
  const act = (action, extra = {}) =>
    ctx.repo.act(ctx.branch, staffAuth(ctx.cook), {
      commandId: randomUUID(),
      orderId: current.orderId,
      expectedVersion: current.version,
      action,
      ...extra,
    });
  for (const task of current.tasks) {
    current = await act('start_task', { taskId: task.id, expectedTaskVersion: task.version });
    current = await act('complete_task', {
      taskId: task.id,
      expectedTaskVersion: task.version + 1,
    });
  }
  current = await act('ready');
  current = await act('handoff');
  return current;
}
async function events(ctx) {
  return (
    await ctx.edge.pool.query(
      "SELECT * FROM fulfillment_outbox WHERE payload->>'commercialOwner'='edge_pos' ORDER BY sequence",
    )
  ).rows.map((r) =>
    parseKitchenEvent({
      event_id: r.event_id,
      producer_id: ctx.scope.producerId,
      producer_sequence: r.sequence,
      aggregate_type: r.aggregate_type,
      aggregate_id: r.order_id,
      aggregate_version: r.aggregate_version,
      event_type: r.event_type,
      schema_version: 1,
      branch_id: r.branch_id,
      occurred_at: r.occurred_at.toISOString(),
      correlation_id: r.order_id,
      causation_id: null,
      payload: r.payload,
    }),
  );
}
const post = (ctx, event, identity = ctx.identity) =>
  fetch(ctx.server.url + '/internal/v1/edge/pos-orders/events', {
    method: 'POST',
    headers: headersFor(identity),
    body: JSON.stringify(event),
  });
const retryNow = (ctx) => ctx.edge.pool.query('UPDATE pos_kitchen_sync_state SET retry_after=NULL');
async function drain(ctx) {
  for (let i = 0; i < 100; i++) {
    const result = await syncPosKitchenOnce(ctx.edge.pool, ctx.options);
    if (result.state === 'idle') return;
    assert.equal(result.state, 'delivered');
  }
  assert.fail('Bounded kitchen drain exceeded');
}
async function pending(ctx) {
  return (
    await ctx.edge.pool.query(
      "SELECT count(*)::int n FROM fulfillment_outbox WHERE payload->>'commercialOwner'='edge_pos' AND acknowledged_at IS NULL",
    )
  ).rows[0].n;
}
async function noFinance(ctx) {
  for (const table of [
    'commerce_orders',
    'commerce_captures',
    'commerce_fiscal_documents',
    'commerce_payment_attempts',
    'commerce_outbox',
  ])
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*)::int n FROM ' + table)).rows[0].n,
      0,
      table,
    );
}

test('actual unpaid POS kitchen lifecycle reaches cloud and scoped BO without financial effects', async () => {
  await fixture(async (ctx) => {
    const o = await order(ctx),
      final = await finish(ctx, o),
      all = await events(ctx);
    assert.equal(all[0].payload.quoteDigest, hashJson(o.snapshot));
    // Commercial creation is a required prerequisite, not an inferred payment.
    assert.equal((await post(ctx, all[0])).status, 409);
    assert.equal((await syncPosOrdersOnce(ctx.edge.pool, ctx.options)).state, 'delivered');
    await drain(ctx);
    assert.equal(await pending(ctx), 0);
    const projection = (await ctx.cloud.pool.query('SELECT * FROM pos_kitchen_sync_projection'))
      .rows[0];
    assert.equal(projection.state, 'handed_over');
    assert.equal(projection.version, final.version);
    assert.equal(projection.execution_mode, 'unpaid_service');
    assert.equal(
      (
        await ctx.cloud.pool.query(
          'SELECT fulfillment_state,payment_state,fiscal_state FROM pos_order_sync_projection',
        )
      ).rows[0].fulfillment_state,
      'blocked',
    );
    const manager = await provisionCatalogManager(ctx.cloud.pool, {
      organization_id: ctx.org,
      name: 'Synthetic BO observer',
      branch_ids: [ctx.branch],
    });
    await grantBackoffice(ctx.cloud.pool, manager.actor_id, ctx.branch, 'manager');
    const bo = new Backoffice(ctx.cloud.pool, true),
      view = await bo.read(manager.token, ctx.branch),
      detail = await bo.order(manager.token, ctx.branch, o.order_id);
    assert.equal(view.pos[0].kitchen_state, 'handed_over');
    assert.equal(view.kitchen[0].commercial_owner, 'edge_pos');
    assert.equal(detail.order.kitchen_version, final.version);
    assert.equal(detail.events.length, all.length + 1);
    assert.equal(
      detail.events.filter((e) => e.aggregate_type === 'order_fulfillment').length,
      all.length,
    );
    await assert.rejects(bo.order(manager.token, randomUUID(), o.order_id), /FORBIDDEN/);
    for (const event of all) {
      const response = await post(ctx, event);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), kitchenReceiptFor(event));
    }
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*)::int n FROM pos_kitchen_sync_inbox')).rows[0].n,
      all.length,
    );
    await noFinance(ctx);
  });
});

test('lost ACK, competing lease, restart and invalid receipt keep the original kitchen envelope pending', async () => {
  await fixture(async (ctx) => {
    await order(ctx);
    await syncPosOrdersOnce(ctx.edge.pool, ctx.options);
    let entered, release;
    const started = new Promise((r) => {
        entered = r;
      }),
      gate = new Promise((r) => {
        release = r;
      });
    const first = syncPosKitchenOnce(ctx.edge.pool, ctx.options, {
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
      assert.equal((await syncPosKitchenOnce(ctx.edge.pool, ctx.options)).state, 'busy');
    } finally {
      release();
    }
    assert.equal((await first).state, 'retry');
    assert.equal(await pending(ctx), 1);
    const original = (
      await ctx.edge.pool.query('SELECT pending_envelope,pending_hash FROM pos_kitchen_sync_state')
    ).rows[0];
    for (const changed of [
      { ...kitchenReceiptFor(original.pending_envelope), eventId: randomUUID() },
      { ...kitchenReceiptFor(original.pending_envelope), payloadHash: '0'.repeat(64) },
    ]) {
      await retryNow(ctx);
      assert.equal(
        (
          await syncPosKitchenOnce(ctx.edge.pool, ctx.options, {
            fetch: async () => Response.json(changed),
          })
        ).state,
        'retry',
      );
      assert.deepEqual(
        (
          await ctx.edge.pool.query(
            'SELECT pending_envelope,pending_hash FROM pos_kitchen_sync_state',
          )
        ).rows[0],
        original,
      );
    }
    await ctx.edge.pool.query(
      "UPDATE pos_kitchen_sync_state SET retry_after=NULL,lease_token=$1,lease_until=clock_timestamp()-interval '1 second'",
      [randomUUID()],
    );
    const fresh = createPool(ctx.edge.config.databaseUrl);
    try {
      assert.equal((await syncPosKitchenOnce(fresh, ctx.options)).state, 'delivered');
    } finally {
      await fresh.end();
    }
    assert.equal(await pending(ctx), 0);
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*)::int n FROM pos_kitchen_sync_inbox')).rows[0].n,
      1,
    );
  });
});

test('scope, exact commercial snapshot, immutable duplicates and strict kitchen versions reject false progress', async () => {
  await fixture(async (ctx) => {
    const o = await order(ctx);
    await finish(ctx, o);
    const all = await events(ctx);
    await syncPosOrdersOnce(ctx.edge.pool, ctx.options);
    assert.equal((await post(ctx, all[1])).status, 409);
    const forged = globalThis.structuredClone(all[0]);
    forged.payload.quoteDigest = '0'.repeat(64);
    assert.equal((await post(ctx, forged)).status, 409);
    assert.equal((await post(ctx, { ...all[0], producer_id: randomUUID() })).status, 403);
    assert.equal((await post(ctx, all[0], { ...ctx.identity, token: '0'.repeat(64) })).status, 401);
    assert.equal((await post(ctx, all[0])).status, 200);
    const duplicate = globalThis.structuredClone(all[0]);
    duplicate.payload.staffId = randomUUID();
    assert.equal((await post(ctx, duplicate)).status, 409);
    assert.equal((await post(ctx, { ...all[0], event_id: randomUUID() })).status, 409);
    await drain(ctx);
    await assert.rejects(
      ctx.cloud.pool.query('UPDATE pos_kitchen_sync_inbox SET payload_hash=$1', ['0'.repeat(64)]),
      { code: '23514' },
    );
    await assert.rejects(
      ctx.cloud.pool.query(
        "UPDATE pos_kitchen_sync_projection SET state='accepted',version=version+1",
      ),
      { code: '23514' },
    );
    await assert.rejects(
      ctx.edge.pool.query(
        'UPDATE fulfillment_outbox SET payload=payload||\'{"tamper":true}\'::jsonb WHERE event_id=$1',
        [all[0].event_id],
      ),
      { code: '23514' },
    );
    await revokeDevice(ctx.cloud.pool, ctx.device);
    assert.equal((await post(ctx, all[0])).status, 401);
    await noFinance(ctx);
  });
});

test('commercial cancellation may arrive before kitchen history without losing accepted then cancelled observations', async () => {
  await fixture(async (ctx) => {
    const o = await order(ctx);
    await cancelLocalOrder(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.cashier),
      randomUUID(),
      o.order_id,
      { expected_version: 1, reason: 'Synthetic queued cancel' },
      ctx.port,
    );
    await syncPosOrdersOnce(ctx.edge.pool, ctx.options);
    await syncPosOrdersOnce(ctx.edge.pool, ctx.options);
    assert.equal(
      (await ctx.cloud.pool.query('SELECT state FROM pos_order_sync_projection')).rows[0].state,
      'cancelled',
    );
    await drain(ctx);
    assert.equal(
      (await ctx.cloud.pool.query('SELECT state,version FROM pos_kitchen_sync_projection')).rows[0]
        .state,
      'cancelled',
    );
    assert.equal(
      (await ctx.cloud.pool.query('SELECT count(*)::int n FROM pos_kitchen_sync_inbox')).rows[0].n,
      2,
    );
    await noFinance(ctx);
  });
});

test('confirmed malformed rejection parks without ACK; owner retry preserves pending bytes after receiver repair', async () => {
  await fixture(async (ctx) => {
    await order(ctx);
    await syncPosOrdersOnce(ctx.edge.pool, ctx.options);
    const response = await syncPosKitchenOnce(ctx.edge.pool, ctx.options, {
      fetch: async () =>
        Response.json(
          {
            code: 'INVALID_REQUEST',
            message_key: 'errors.invalid_request',
            trace_id: randomUUID(),
            retryable: false,
          },
          { status: 400 },
        ),
    });
    assert.equal(response.state, 'dead_letter');
    assert.equal(await pending(ctx), 1);
    const old = (
      await ctx.edge.pool.query('SELECT pending_envelope,pending_hash FROM pos_kitchen_sync_state')
    ).rows[0];
    assert.equal((await syncPosKitchenOnce(ctx.edge.pool, ctx.options)).state, 'dead_letter');
    await assert.rejects(
      ctx.edge.pool.query('UPDATE pos_kitchen_sync_state SET pending_hash=$1', ['0'.repeat(64)]),
      { code: '23514' },
    );
    await retryPosKitchenDelivery(ctx.edge.pool, ctx.branch, response.eventId);
    assert.deepEqual(
      (
        await ctx.edge.pool.query(
          'SELECT pending_envelope,pending_hash FROM pos_kitchen_sync_state',
        )
      ).rows[0],
      old,
    );
    assert.equal((await syncPosKitchenOnce(ctx.edge.pool, ctx.options)).state, 'delivered');
    assert.equal(await pending(ctx), 0);
  });
});

async function restricted(ctx, side, grants, run) {
  const role = 'kitchen_sync_' + randomUUID().replaceAll('-', ''),
    secret = randomBytes(32).toString('hex');
  let pool;
  try {
    await ctx[side].admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    await ctx[side].pool.query(grants(role, ctx[side].schema));
    const url = new URL(ctx[side].config.databaseUrl);
    url.username = role;
    url.password = secret;
    pool = createPool(url.toString());
    await run(pool);
  } finally {
    await pool?.end();
    await ctx[side].admin.query(`DROP OWNED BY ${role}`);
    await ctx[side].admin.query(`DROP ROLE ${role}`);
  }
}
test('dedicated real LOGIN worker and receiver can deliver observations but cannot provision authority or money', async () => {
  await fixture(async (ctx) => {
    await order(ctx);
    await restricted(ctx, 'cloud', posSyncReceiverGrants, async (cloud) => {
      await restricted(ctx, 'edge', posSyncWorkerGrants, async (edge) => {
        const io = {
          fetch: async (_url, options) => {
            const event = JSON.parse(options.body);
            const result = await (
              event.aggregate_type === 'order_fulfillment' ? receivePosKitchen : receivePosOrder
            )(cloud, { deviceId: ctx.identity.device_id, token: ctx.identity.token }, event);
            return Response.json(result);
          },
        };
        assert.equal((await syncPosOrdersOnce(edge, ctx.options, io)).state, 'delivered');
        assert.equal((await syncPosKitchenOnce(edge, ctx.options, io)).state, 'delivered');
        for (const sql of [
          'UPDATE local_staff SET active=true',
          'UPDATE branch_config SET ordering_enabled=true',
          "UPDATE fulfillment_outbox SET payload='{}'",
          'INSERT INTO pos_kitchen_sync_state(branch_id) VALUES(gen_random_uuid())',
        ])
          await assert.rejects(edge.query(sql), { code: '42501' });
        await assert.rejects(retryPosKitchenDelivery(edge, ctx.branch, randomUUID()), /FORBIDDEN/);
      });
      for (const sql of [
        "UPDATE devices SET status='active'",
        'UPDATE device_credentials SET expires_at=clock_timestamp()',
        'UPDATE pos_order_sync_bindings SET active=true',
        'INSERT INTO commerce_captures(id) VALUES(gen_random_uuid())',
        "UPDATE pos_kitchen_sync_projection SET owner_hash=repeat('0',64)",
      ])
        await assert.rejects(cloud.query(sql), { code: '42501' });
    });
    await noFinance(ctx);
  });
});
