import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApi } from '@pickchick/api';
import { createPool } from '@pickchick/database';
import { fulfillmentWorkerGrants } from '../../../infra/windows/fulfillment-worker-grants.mjs';
import { applyEdgeRuntimeGrants } from '../../../infra/windows/edge-runtime-grants.mjs';
import { createEdge } from '@pickchick/edge';
import { provisionDevice } from '@pickchick/menu-sync';
import {
  createQuote,
  createLocalOrder,
  cancelLocalOrder,
  fenceRestoredEdge,
} from '@pickchick/local-orders';
import { provisionCloudPosSync, provisionEdgePosSync, syncPosOrdersOnce } from '../dist/index.js';
import { withOrderDesk, staffAuth } from '../../../tests/helpers/orders.mjs';
import { running, headersFor } from '../../../tests/helpers/sync.mjs';

const GAP = 1_000_000_000n;
async function fixture(run) {
  await withOrderDesk(async (ctx) => {
    const identity = await provisionDevice(ctx.cloud.pool, ctx.device);
    const scope = await provisionEdgePosSync(ctx.edge.pool, {
      organizationId: ctx.org,
      branchId: ctx.branch,
      deviceId: ctx.device,
    });
    await provisionCloudPosSync(ctx.cloud.pool, scope);
    const cloud = await running(createApi, { ...ctx.cloud.config, posOrderSyncEnabled: true });
    const options = { enabled: true, branchId: ctx.branch, origin: cloud.url, identity };
    try {
      await run({ ...ctx, identity, scope, cloudServer: cloud, options });
    } finally {
      await cloud.app.close();
    }
  });
}
async function order(ctx) {
  const quote = await createQuote(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), ctx.cart);
  return createLocalOrder(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), randomUUID(), {
    quote_id: quote.quote_id,
  });
}
async function drain(ctx) {
  const states = [];
  for (let i = 0; i < 10; i++) {
    await ctx.edge.pool.query('UPDATE pos_order_sync_state SET retry_after=NULL');
    const { state } = await syncPosOrdersOnce(ctx.edge.pool, ctx.options);
    states.push(state);
    if (state !== 'delivered') break;
  }
  return states;
}
const envelope = async (ctx, orderId) => {
  const row = (
    await ctx.edge.pool.query(
      "SELECT * FROM outbox_events WHERE aggregate_id=$1 AND event_type='order.created'",
      [orderId],
    )
  ).rows[0];
  return {
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
  };
};
const post = (ctx, event) =>
  fetch(ctx.cloudServer.url + '/internal/v1/edge/pos-orders/events', {
    method: 'POST',
    headers: headersFor(ctx.identity),
    body: JSON.stringify(event),
  });
/**
 * A backup is restored: the cloud already holds sequence N+1 from the lost timeline while the
 * restored edge stream stops at N. Modelled by delivering a lost-timeline event the edge never
 * stored, and by appending the backup's database identity to the restored ledger.
 */
async function loseTimeline(ctx) {
  const kept = await order(ctx);
  assert.deepEqual(await drain(ctx), ['delivered', 'idle']);
  // An order the lost timeline created and delivered: its own quote, the next sequence.
  const quote = await createQuote(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), ctx.cart);
  const base = await envelope(ctx, kept.order_id),
    id = randomUUID();
  const lost = {
    ...base,
    event_id: randomUUID(),
    producer_sequence: String(BigInt(base.producer_sequence) + 1n),
    aggregate_id: id,
    correlation_id: id,
    payload: { ...base.payload, order_id: id, quote_id: quote.quote_id, snapshot: quote },
  };
  assert.equal((await post(ctx, lost)).status, 200, 'cloud accepted the lost-timeline event');
  return { kept, lost };
}
const restoredIdentity = (ctx) =>
  ctx.edge.pool.query(
    `INSERT INTO edge_database_epochs(epoch,system_identifier,database_oid,reason,sequence_gap)
     SELECT max(epoch)+1, 1, 1, 'initial', 0 FROM edge_database_epochs`,
  );

test('without a fence a restored edge reuses a sequence and its POS stream stays blocked (6.4)', async () => {
  await fixture(async (ctx) => {
    const { lost } = await loseTimeline(ctx);
    await order(ctx);
    assert.deepEqual(await drain(ctx), ['retry']);
    const state = (await ctx.edge.pool.query('SELECT * FROM pos_order_sync_state')).rows[0];
    assert.equal(state.last_error, 'HTTP_REJECTED');
    assert.equal(state.pending_envelope.producer_sequence, String(BigInt(lost.producer_sequence)));
  });
});

test('edge start fences a restored database once: POS orders, reports and kitchen events flow again (6.4)', async () => {
  await fixture(async (ctx) => {
    const { kept, lost } = await loseTimeline(ctx);
    const before = BigInt(
      (await ctx.edge.pool.query('SELECT last_sequence FROM local_order_streams')).rows[0]
        .last_sequence,
    );
    const lastValue = async (table) =>
      BigInt(
        (
          await ctx.edge.pool.query(
            `SELECT coalesce(pg_sequence_last_value(pg_get_serial_sequence($1,'sequence')::regclass),0) AS v`,
            [table],
          )
        ).rows[0].v,
      );
    const reports = await lastValue('cashier_report_outbox'),
      kitchen = await lastValue('fulfillment_outbox');
    assert.equal((await fenceRestoredEdge(ctx.edge.pool)).state, 'current');
    await restoredIdentity(ctx);
    // The edge service fences before it serves the first request.
    const edge = await running(createEdge, ctx.edge.config);
    await edge.app.close();
    const epochs = (
      await ctx.edge.pool.query(
        'SELECT reason,sequence_gap FROM edge_database_epochs ORDER BY epoch',
      )
    ).rows;
    assert.deepEqual(epochs.at(-1), { reason: 'restore', sequence_gap: String(GAP) });
    assert.equal(
      BigInt(
        (await ctx.edge.pool.query('SELECT last_sequence FROM local_order_streams')).rows[0]
          .last_sequence,
      ),
      before + GAP,
    );
    assert.equal(await lastValue('cashier_report_outbox'), reports + GAP);
    assert.equal(await lastValue('fulfillment_outbox'), kitchen + GAP);
    // Idempotent: a second start or worker check changes nothing.
    assert.equal((await fenceRestoredEdge(ctx.edge.pool)).state, 'current');
    assert.equal(await lastValue('fulfillment_outbox'), kitchen + GAP);

    const next = await order(ctx);
    await cancelLocalOrder(
      ctx.edge.pool,
      ctx.branch,
      staffAuth(ctx.cashier),
      randomUUID(),
      kept.order_id,
      { expected_version: 1, reason: 'Synthetic cancellation after restore' },
    );
    assert.deepEqual(await drain(ctx), ['delivered', 'delivered', 'idle']);
    const projections = (
      await ctx.cloud.pool.query('SELECT order_id,state FROM pos_order_sync_projection')
    ).rows;
    assert.deepEqual(Object.fromEntries(projections.map((p) => [p.order_id, p.state])), {
      [kept.order_id]: 'cancelled',
      [lost.aggregate_id]: 'awaiting_payment',
      [next.order_id]: 'awaiting_payment',
    });
    // Nothing replayed is accepted: the lost-timeline sequence still belongs to its event.
    const other = randomUUID();
    const replayed = {
      ...lost,
      event_id: randomUUID(),
      aggregate_id: other,
      correlation_id: other,
      payload: { ...lost.payload, order_id: other },
    };
    assert.equal((await post(ctx, replayed)).status, 409);
    assert.equal((await post(ctx, lost)).status, 200, 'an exact duplicate stays idempotent');
  });
});

test('an operator fence covers a file-level restore that kept the database identity (6.4)', async () => {
  await fixture(async (ctx) => {
    await loseTimeline(ctx);
    assert.equal((await fenceRestoredEdge(ctx.edge.pool)).state, 'current');
    const forced = await fenceRestoredEdge(ctx.edge.pool, true);
    assert.equal(forced.state, 'operator');
    assert.equal(forced.sequenceGap, String(GAP));
    await order(ctx);
    assert.deepEqual(await drain(ctx), ['delivered', 'idle']);
    await assert.rejects(
      ctx.edge.pool.query('DELETE FROM edge_database_epochs'),
      /append-only/,
      'the fence ledger cannot be rewritten',
    );
  });
});

test('least-privilege roles: the runtime fences only through the owner-rights function (6.4)', async () => {
  await withOrderDesk(async (ctx) => {
    const { admin, schema, pool } = ctx.edge;
    const roles = [];
    const login = async (grant) => {
      const role = 'fence_' + randomUUID().replaceAll('-', '');
      const password = randomBytes(32).toString('hex');
      await admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
      roles.push(role);
      await grant(role);
      const url = new URL(ctx.edge.config.databaseUrl);
      url.username = role;
      url.password = password;
      url.searchParams.set('options', `-c search_path=${schema}`);
      const rolePool = createPool(url.toString(), 1);
      roles.push(rolePool);
      return rolePool;
    };
    try {
      const runtime = await login((role) =>
        applyEdgeRuntimeGrants(pool, role, { schema, fulfillment: true }),
      );
      const worker = await login((role) => pool.query(fulfillmentWorkerGrants(role, schema)));
      const fencingWorker = await login((role) =>
        pool.query(fulfillmentWorkerGrants(role, schema, { restoreFence: true })),
      );
      const sequence = "pg_get_serial_sequence('fulfillment_outbox','sequence')";
      await assert.rejects(runtime.query(`SELECT setval(${sequence}, 5)`), /permission denied/);
      await assert.rejects(fenceRestoredEdge(worker), /permission denied/);
      assert.equal((await fenceRestoredEdge(fencingWorker)).state, 'current');
      assert.equal((await fenceRestoredEdge(runtime)).state, 'current');
      // A caller's temporary table cannot stand in for the ledger: the owner-rights function
      // resolves names in its own schema and pg_temp last.
      const fenced = async () =>
        (
          await pool.query(
            `SELECT (SELECT count(*) FROM edge_database_epochs)::int AS epochs,
             coalesce(pg_sequence_last_value(${sequence}::regclass),0)::text AS kitchen`,
          )
        ).rows[0];
      const before = await fenced();
      const session = await runtime.connect();
      try {
        await session.query(
          `CREATE TEMP TABLE edge_database_epochs(epoch integer, system_identifier bigint,
           database_oid bigint, reason text, sequence_gap bigint, recorded_at timestamptz)`,
        );
        await session.query(
          "INSERT INTO pg_temp.edge_database_epochs VALUES (99, 1, 1, 'initial', 0, now())",
        );
        assert.equal((await fenceRestoredEdge(session)).state, 'current');
      } finally {
        await session.query('DROP TABLE IF EXISTS pg_temp.edge_database_epochs');
        session.release();
      }
      assert.deepEqual(await fenced(), before, 'a spoofed ledger never fences');
      await restoredIdentity({ edge: { pool } });
      assert.equal((await fenceRestoredEdge(runtime)).state, 'restore');
      assert.equal((await fenceRestoredEdge(fencingWorker)).state, 'current');
      assert.ok(
        BigInt(
          (await pool.query(`SELECT pg_sequence_last_value(${sequence}::regclass) AS v`)).rows[0].v,
        ) >= GAP,
      );
    } finally {
      for (const item of roles.reverse())
        if (typeof item === 'string') {
          await admin.query(`DROP OWNED BY ${item}`);
          await admin.query(`DROP ROLE ${item}`);
        } else await item.end();
    }
  });
});
