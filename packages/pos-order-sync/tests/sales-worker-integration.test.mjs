import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '@pickchick/api';
import { createPool } from '@pickchick/database';
import { hashJson, provisionDevice } from '@pickchick/menu-sync';
import {
  createQuote,
  createLocalOrder,
  cancelLocalOrder,
  fenceRestoredEdge,
} from '@pickchick/local-orders';
import {
  MAX_POS_SALE_BATCH_BYTES,
  POS_SALES_PROBE_INTERVAL_MS,
  POS_SALES_UNSUPPORTED_RETRY_MS,
  createPosSalesSchedule,
  posSaleReceiptFor,
  provisionCloudPosSync,
  provisionEdgePosSync,
  receivePosSales,
  retryPosSalesDelivery,
  syncPosOrdersOnce,
  syncPosSalesOnce,
} from '../dist/index.js';
import { running, authFor } from '../../../tests/helpers/sync.mjs';
import { posSalesWorkerGrants } from '../../../infra/windows/pos-sales-grants.mjs';
import {
  posSyncReceiverGrants,
  posSyncWorkerGrants,
} from '../../../infra/windows/pos-sync-worker-grants.mjs';
import { cloudPosSalesGrants } from '../../../infra/staging/pos-sales-grants.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import { grantBackoffice } from '../../backoffice-core/dist/index.js';
import { withOrderDesk, staffAuth } from '../../../tests/helpers/orders.mjs';
import {
  cashSale,
  enqueue,
  migrationsUpTo,
  sentAs,
  stream,
  vectorEvent,
  withPosSalesDatabases,
  zReportFor,
} from './sales-cloud-fixture.mjs';

// Edge sender of posSales (contracts 5.6, CC-4) on PostgreSQL with edge schema026 and the real
// cloud receiver: order, batches, ACK after the cloud's COMMIT, old cloud 404, probe, parking on
// CONFLICT, duplicate delivery and independence from the order and kitchen streams.
const ON = { posOrderSyncEnabled: true, posSalesSyncEnabled: true };
const START = Date.parse('2026-11-19T06:00:00.000Z');

async function harness(ctx, flags) {
  const api = await running(createApi, { ...ctx.cloud.config, ...flags });
  let clock = START;
  const requests = [];
  const schedule = createPosSalesSchedule();
  const io = {
    now: () => clock,
    fetch: async (url, options) => {
      requests.push(JSON.parse(options.body));
      return fetch(url, options);
    },
  };
  const step = (override = {}) =>
    syncPosSalesOnce(
      ctx.edge.pool,
      {
        enabled: true,
        branchId: ctx.branch,
        origin: override.origin ?? api.url,
        identity: ctx.identity,
      },
      schedule,
      {
        ...io,
        ...(override.fetch
          ? {
              fetch: async (url, options) => {
                requests.push(JSON.parse(options.body));
                return override.fetch(url, options);
              },
            }
          : {}),
      },
    );
  return { api, requests, schedule, step, advance: (ms) => (clock += ms), now: () => clock };
}
async function withSender(run, { flags = ON, ...options } = {}) {
  await withPosSalesDatabases(async (ctx) => {
    const h = await harness(ctx, flags);
    try {
      await run({ ...ctx, ...h });
    } finally {
      await h.api.app.close();
    }
  }, options);
}
const outbox = async (pool) =>
  (
    await pool.query(
      `SELECT o.event_id,o.sequence::text AS sequence,o.acknowledged_at,o.attempts,o.last_error
       FROM pos_sale_outbox o ORDER BY o.sequence`,
    )
  ).rows;
const syncState = async (pool, branch) =>
  (
    await pool.query(
      'SELECT last_supported_at,last_error FROM pos_sale_sync_state WHERE branch_id=$1',
      [branch],
    )
  ).rows[0];
const cloudCount = async (pool, table) => {
  assert.match(table, /^cloud_pos_[a-z_]+$/);
  return Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
};
const json = (value) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('the outbox goes in sequence order, batches of at most 50, acknowledged only by receipts', async () => {
  await withSender(async (ctx) => {
    const events = Array.from({ length: 120 }, (_, index) =>
      cashSale(ctx.branch, index + 1, index + 1),
    );
    const rows = await enqueue(ctx.edge.pool, events);
    const results = [];
    for (let index = 0; index < 5; index += 1) {
      const result = await ctx.step();
      results.push(result);
      if (!result.more) break;
    }
    assert.deepEqual(results, [
      { state: 'delivered', count: 50, more: true },
      { state: 'delivered', count: 50, more: true },
      { state: 'delivered', count: 20, more: false },
    ]);
    assert.deepEqual(
      ctx.requests.map((batch) => batch.events.length),
      [50, 50, 20],
    );
    assert.ok(
      ctx.requests.every(
        (batch) => Buffer.byteLength(JSON.stringify(batch)) <= MAX_POS_SALE_BATCH_BYTES,
      ),
    );
    const sent = ctx.requests.flatMap((batch) => batch.events);
    assert.deepEqual(
      sent.map((event) => event.sequence),
      rows.map((row) => row.sequence),
    );
    assert.deepEqual(
      sent,
      events.map((event, index) => sentAs(event, rows[index])),
    );
    const edge = await outbox(ctx.edge.pool);
    assert.ok(edge.every((row) => row.acknowledged_at && row.attempts === 1 && !row.last_error));
    assert.equal(await cloudCount(ctx.cloud.pool, 'cloud_pos_sales'), 120);
    const cloud = (
      await ctx.cloud.pool.query(
        'SELECT i.sequence::text AS sequence FROM cloud_pos_sale_inbox i ORDER BY i.sequence',
      )
    ).rows.map((row) => row.sequence);
    assert.deepEqual(
      cloud,
      rows.map((row) => row.sequence),
    );
    const state = await syncState(ctx.edge.pool, ctx.branch);
    assert.ok(state.last_supported_at instanceof Date);
    assert.equal(state.last_error, null);
    // The queue is empty and the cloud answered just now: no probe yet.
    assert.deepEqual(await ctx.step(), { state: 'idle' });
    assert.equal(ctx.requests.length, 3);
  });
});

test('an old cloud (404) keeps every event, the next attempt is in 10 minutes; a supporting cloud then gets them', async () => {
  await withSender(
    async (ctx) => {
      const events = stream(ctx.branch).slice(0, 3);
      await enqueue(ctx.edge.pool, events);
      assert.deepEqual(await ctx.step(), {
        state: 'unsupported',
        retryAt: START + POS_SALES_UNSUPPORTED_RETRY_MS,
      });
      let edge = await outbox(ctx.edge.pool);
      assert.ok(edge.every((row) => !row.acknowledged_at && row.attempts === 1 && !row.last_error));
      assert.deepEqual(await syncState(ctx.edge.pool, ctx.branch), {
        last_supported_at: null,
        last_error: 'CLOUD_UNSUPPORTED',
      });
      assert.equal((await ctx.step()).state, 'waiting');
      ctx.advance(POS_SALES_UNSUPPORTED_RETRY_MS - 1);
      assert.equal((await ctx.step()).state, 'waiting');
      assert.equal(ctx.requests.length, 1);
      // 503 also means "not supported now".
      ctx.advance(1);
      assert.equal(
        (await ctx.step({ fetch: async () => new Response('busy', { status: 503 }) })).state,
        'unsupported',
      );
      assert.equal(ctx.requests.length, 2);
      // The cloud is upgraded and the flag switched on.
      const upgraded = await running(createApi, { ...ctx.cloud.config, ...ON });
      try {
        ctx.advance(POS_SALES_UNSUPPORTED_RETRY_MS);
        assert.deepEqual(await ctx.step({ origin: upgraded.url }), {
          state: 'delivered',
          count: 3,
          more: false,
        });
      } finally {
        await upgraded.app.close();
      }
      edge = await outbox(ctx.edge.pool);
      assert.ok(edge.every((row) => row.acknowledged_at && row.attempts === 3));
      const state = await syncState(ctx.edge.pool, ctx.branch);
      assert.ok(state.last_supported_at instanceof Date);
      assert.equal(state.last_error, null);
    },
    { flags: { posOrderSyncEnabled: true } },
  );
});

test('while the outbox is empty the sender probes every 10 minutes and records the supporting cloud', async () => {
  await withSender(async (ctx) => {
    assert.deepEqual(await ctx.step(), { state: 'probed' });
    assert.deepEqual(ctx.requests, [{ events: [] }]);
    const first = (await syncState(ctx.edge.pool, ctx.branch)).last_supported_at;
    assert.ok(first instanceof Date);
    assert.deepEqual(await ctx.step(), { state: 'idle' });
    ctx.advance(POS_SALES_PROBE_INTERVAL_MS - 1);
    assert.deepEqual(await ctx.step(), { state: 'idle' });
    ctx.advance(1);
    assert.deepEqual(await ctx.step(), { state: 'probed' });
    assert.equal(ctx.requests.length, 2);
    const second = (await syncState(ctx.edge.pool, ctx.branch)).last_supported_at;
    assert.ok(second > first);
  });
});

test('CONFLICT parks the event and stops the stream until the owner releases it', async () => {
  await withSender(async (ctx) => {
    const events = stream(ctx.branch);
    const rows = await enqueue(ctx.edge.pool, events.slice(0, 2));
    assert.equal((await ctx.step()).state, 'delivered');
    const later = await enqueue(ctx.edge.pool, events.slice(2, 5));
    // Another event already holds the next sequence of this device in the cloud.
    await ctx.cloud.pool.query(
      `INSERT INTO cloud_pos_sale_inbox(event_id,branch_id,device_id,sequence,kind,payload_hash)
       VALUES($1,$2,$3,$4,'sale',$5)`,
      [randomUUID(), ctx.branch, ctx.device, later[0].sequence, 'f'.repeat(64)],
    );
    const parked = { state: 'parked', eventId: later[0].event_id, error: 'CONFLICT' };
    assert.deepEqual(await ctx.step(), parked);
    let edge = await outbox(ctx.edge.pool);
    assert.deepEqual(
      edge.map((row) => [!!row.acknowledged_at, row.last_error]),
      [
        [true, null],
        [true, null],
        [false, 'rejected:CONFLICT'],
        [false, null],
        [false, null],
      ],
    );
    let state = await syncState(ctx.edge.pool, ctx.branch);
    assert.equal(state.last_error, `PARKED CONFLICT ${later[0].event_id}`);
    assert.ok(state.last_supported_at instanceof Date);
    // Parked: no request at all, also after the recheck pause.
    const sent = ctx.requests.length;
    assert.equal((await ctx.step()).state, 'waiting');
    ctx.advance(60_000);
    assert.deepEqual(await ctx.step(), parked);
    assert.equal(ctx.requests.length, sent);
    // Only the owner releases exactly the parked event.
    await assert.rejects(
      retryPosSalesDelivery(ctx.edge.pool, ctx.branch, rows[0].event_id),
      /CONFLICT/,
    );
    assert.deepEqual(await retryPosSalesDelivery(ctx.edge.pool, ctx.branch, later[0].event_id), {
      state: 'retry',
      eventId: later[0].event_id,
    });
    state = await syncState(ctx.edge.pool, ctx.branch);
    assert.equal(state.last_error, null);
    ctx.advance(60_000);
    // Still conflicting in the cloud: parked again, nothing behind it was sent past it.
    assert.deepEqual(await ctx.step(), parked);
    assert.equal(ctx.requests.length, sent + 1);
    assert.deepEqual(
      ctx.requests.at(-1).events.map((event) => event.event_id),
      later.map((row) => row.event_id),
    );
    // After a repaired cloud accepts them, the stream continues in order.
    await retryPosSalesDelivery(ctx.edge.pool, ctx.branch, later[0].event_id);
    ctx.advance(60_000);
    const accept = async (_, options) =>
      json({ receipts: JSON.parse(options.body).events.map((event) => posSaleReceiptFor(event)) });
    assert.deepEqual(await ctx.step({ fetch: accept }), {
      state: 'delivered',
      count: 3,
      more: false,
    });
    edge = await outbox(ctx.edge.pool);
    assert.ok(edge.every((row) => row.acknowledged_at && !row.last_error));
  });
});

test('a lost answer is delivered again: the cloud keeps one copy and the edge acknowledges once', async () => {
  await withSender(async (ctx) => {
    const events = stream(ctx.branch).slice(0, 3);
    await enqueue(ctx.edge.pool, events);
    // The cloud commits, the answer never reaches the edge.
    const lost = async (url, options) => {
      await fetch(url, options).then((response) => response.arrayBuffer());
      throw new TypeError('connection reset');
    };
    assert.deepEqual(await ctx.step({ fetch: lost }), {
      state: 'retry',
      error: 'NETWORK_UNKNOWN',
      retryAt: START + 2000,
    });
    assert.ok((await outbox(ctx.edge.pool)).every((row) => !row.acknowledged_at));
    assert.equal(await cloudCount(ctx.cloud.pool, 'cloud_pos_sales'), 3);
    assert.equal((await syncState(ctx.edge.pool, ctx.branch)).last_error, 'NETWORK_UNKNOWN');
    ctx.advance(2000);
    assert.deepEqual(await ctx.step(), { state: 'delivered', count: 3, more: false });
    assert.ok(
      (await outbox(ctx.edge.pool)).every((row) => row.acknowledged_at && row.attempts === 2),
    );
    assert.equal(await cloudCount(ctx.cloud.pool, 'cloud_pos_sale_inbox'), 3);
    assert.equal(await cloudCount(ctx.cloud.pool, 'cloud_pos_sales'), 3);
  });
});

test('an answer that is not exactly an in-order prefix acknowledges nothing; a true prefix acknowledges only itself', async () => {
  await withSender(async (ctx) => {
    const events = [cashSale(ctx.branch, 1), cashSale(ctx.branch, 2), cashSale(ctx.branch, 3)];
    const rows = await enqueue(ctx.edge.pool, events);
    const receipt = (index, change = {}) => ({
      ...posSaleReceiptFor(sentAs(events[index], rows[index])),
      ...change,
    });
    let delay = 2000;
    for (const [answer, error] of [
      [{ receipts: [receipt(0, { payload_hash: 'e'.repeat(64) })] }, 'INVALID_RESPONSE'],
      [{ receipts: [receipt(1)] }, 'INVALID_RESPONSE'],
      [
        { receipts: [receipt(0)], rejected: { event_id: events[2].event_id, code: 'CONFLICT' } },
        'INVALID_RESPONSE',
      ],
      [{ receipts: [receipt(0), receipt(1), receipt(2), receipt(2)] }, 'INVALID_RESPONSE'],
      [{ receipts: [] }, 'NO_PROGRESS'],
    ]) {
      assert.deepEqual(await ctx.step({ fetch: async () => json(answer) }), {
        state: 'retry',
        error,
        retryAt: ctx.now() + delay,
      });
      assert.ok((await outbox(ctx.edge.pool)).every((row) => !row.acknowledged_at));
      ctx.advance(delay);
      delay *= 2;
    }
    assert.deepEqual(
      await ctx.step({ fetch: async () => json({ receipts: [receipt(0), receipt(1)] }) }),
      { state: 'delivered', count: 2, more: true },
    );
    assert.equal(ctx.schedule.failures, 0);
    assert.deepEqual(
      (await outbox(ctx.edge.pool)).map((row) => !!row.acknowledged_at),
      [true, true, false],
    );
    assert.deepEqual(await ctx.step(), { state: 'delivered', count: 1, more: false });
  });
});

test('a head that cannot be sent as stored is parked locally, never skipped; inactive binding is disabled', async () => {
  await withSender(async (ctx) => {
    const [head] = await enqueue(ctx.edge.pool, [cashSale(ctx.branch, 1)], {
      hash: 'd'.repeat(64),
    });
    await enqueue(ctx.edge.pool, [cashSale(ctx.branch, 2)]);
    assert.deepEqual(await ctx.step(), {
      state: 'parked',
      eventId: head.event_id,
      error: 'LOCAL_INVALID',
    });
    assert.equal(ctx.requests.length, 0);
    assert.deepEqual(
      (await outbox(ctx.edge.pool)).map((row) => row.last_error),
      ['rejected:LOCAL_INVALID', null],
    );
    assert.equal(
      (await syncState(ctx.edge.pool, ctx.branch)).last_error,
      `PARKED LOCAL_INVALID ${head.event_id}`,
    );
    await ctx.edge.pool.query('UPDATE pos_order_sync_state SET active=false');
    ctx.advance(60_000);
    assert.deepEqual(await ctx.step(), { state: 'disabled' });
    assert.equal(ctx.requests.length, 0);
  });
});

test('an edge without schema026 only rechecks every 10 minutes (new runtime on the old schema)', async () => {
  const old = await migrationsUpTo('edge', 25);
  try {
    await withSender(
      async (ctx) => {
        assert.deepEqual(await ctx.step(), {
          state: 'not_installed',
          retryAt: START + 600_000,
        });
        assert.equal((await ctx.step()).state, 'waiting');
        assert.equal(ctx.requests.length, 0);
        assert.equal(
          (await ctx.edge.pool.query("SELECT to_regclass('pos_sale_outbox') AS t")).rows[0].t,
          null,
        );
      },
      { edgeMigrationDirectory: old.directory },
    );
  } finally {
    await old.remove();
  }
});

test('posSales failures and parking never touch the order_commercial stream', async () => {
  await withOrderDesk(async (ctx) => {
    const identity = await provisionDevice(ctx.cloud.pool, ctx.device);
    const scope = await provisionEdgePosSync(ctx.edge.pool, {
      organizationId: ctx.org,
      branchId: ctx.branch,
      deviceId: ctx.device,
    });
    await provisionCloudPosSync(ctx.cloud.pool, scope);
    const h = await harness({ ...ctx, identity }, ON);
    try {
      const state = async () =>
        (
          await ctx.edge.pool.query('SELECT * FROM pos_order_sync_state WHERE branch_id=$1', [
            ctx.branch,
          ])
        ).rows[0];
      await enqueue(ctx.edge.pool, [cashSale(ctx.branch, 1), cashSale(ctx.branch, 2)]);
      const before = await state();
      // The posSales cloud path is down.
      assert.equal(
        (
          await h.step({
            fetch: async () => {
              throw new TypeError('down');
            },
          })
        ).state,
        'retry',
      );
      assert.deepEqual(await state(), before);
      const quote = await createQuote(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), ctx.cart);
      const order = await createLocalOrder(
        ctx.edge.pool,
        ctx.branch,
        staffAuth(ctx.cashier),
        randomUUID(),
        {
          quote_id: quote.quote_id,
        },
      );
      const orders = { enabled: true, branchId: ctx.branch, origin: h.api.url, identity };
      assert.equal((await syncPosOrdersOnce(ctx.edge.pool, orders)).state, 'delivered');
      // posSales parked by the cloud: the order stream still drains.
      h.advance(2000);
      assert.equal(
        (
          await h.step({
            fetch: async (_, options) =>
              json({
                receipts: [],
                rejected: {
                  event_id: JSON.parse(options.body).events[0].event_id,
                  code: 'INVALID_EVENT',
                },
              }),
          })
        ).state,
        'parked',
      );
      await cancelLocalOrder(
        ctx.edge.pool,
        ctx.branch,
        staffAuth(ctx.cashier),
        randomUUID(),
        order.order_id,
        {
          expected_version: 1,
          reason: 'Synthetic cancellation',
        },
      );
      assert.equal((await syncPosOrdersOnce(ctx.edge.pool, orders)).state, 'delivered');
      const after = await state();
      assert.equal(after.failure_count, 0);
      assert.equal(after.last_error, null);
      assert.equal(
        Number(
          (
            await ctx.edge.pool.query(
              "SELECT count(*) FROM outbox_events WHERE aggregate_type='order_commercial' AND acknowledged_at IS NULL",
            )
          ).rows[0].count,
        ),
        0,
      );
    } finally {
      await h.api.app.close();
    }
  });
});

test('two sender processes at once (a second worker started with --once) deliver one copy and acknowledge every event', async () => {
  await withSender(async (ctx) => {
    await enqueue(ctx.edge.pool, stream(ctx.branch));
    const input = {
      enabled: true,
      branchId: ctx.branch,
      origin: ctx.api.url,
      identity: ctx.identity,
    };
    // Both processes have read the same outbox rows before either request reaches the cloud.
    let arrived = 0,
      release;
    const gate = new Promise((resolve) => (release = resolve));
    const io = {
      fetch: async (url, options) => {
        arrived += 1;
        if (arrived === 2) release();
        await gate;
        return fetch(url, options);
      },
    };
    const results = await Promise.all([
      syncPosSalesOnce(ctx.edge.pool, input, createPosSalesSchedule(), io),
      syncPosSalesOnce(ctx.edge.pool, input, createPosSalesSchedule(), io),
    ]);
    assert.deepEqual(results, [
      { state: 'delivered', count: 14, more: false },
      { state: 'delivered', count: 14, more: false },
    ]);
    const edge = await outbox(ctx.edge.pool);
    assert.equal(edge.length, 14);
    assert.ok(edge.every((row) => row.acknowledged_at && row.attempts === 2 && !row.last_error));
    assert.equal(await cloudCount(ctx.cloud.pool, 'cloud_pos_sale_inbox'), 14);
    assert.equal(await cloudCount(ctx.cloud.pool, 'cloud_pos_sales'), 8);
    assert.equal(await cloudCount(ctx.cloud.pool, 'cloud_pos_shift_reports'), 1);
    assert.equal((await syncState(ctx.edge.pool, ctx.branch)).last_error, null);
  });
});

// ------------------------------------------------------------ edge database restore ----
const GAP = 1_000_000_000n;
const EDGE_MIGRATIONS = new URL('../../../db/edge/migrations/', import.meta.url);
const OUTBOXES = "ARRAY['cashier_report_outbox', 'fulfillment_outbox']";
/**
 * A 026 without CR cloud-5 item 1 (never installed: the reviewed 026 of CR pos-6, SHA
 * 921c5263, carries the fix): the edge_restore_fence of 023 put back exactly as written, its
 * search_path pinned again by the 023 DO block (CREATE OR REPLACE resets it), its EXECUTE
 * rights untouched.
 */
async function installFence023(pool) {
  const sql = await readFile(new URL('023_edge_restore_fence.sql', EDGE_MIGRATIONS), 'utf8');
  const start = sql.indexOf('CREATE FUNCTION edge_restore_fence(');
  const body = sql.slice(start, sql.indexOf('END; $$;', start) + 'END; $$;'.length);
  assert.equal(body.split(OUTBOXES).length, 2, 'the 023 fence names its two outboxes once');
  await pool.query(body.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
  const pin = sql.indexOf('DO $$ BEGIN', start);
  await pool.query(sql.slice(pin, sql.indexOf('END $$;', pin) + 'END $$;'.length));
}
/** edge_restore_fence(boolean) as installed: posSales covered, pinned search_path, PUBLIC. */
const installedFence = async (pool) =>
  (
    await pool.query(
      `SELECT pg_get_functiondef(p.oid) LIKE '%pos_sale_outbox%' AS covered,p.proconfig,
         has_function_privilege('public',p.oid,'EXECUTE') AS public
       FROM pg_proc p WHERE p.proname='edge_restore_fence' AND p.pronamespace=current_schema()::regnamespace`,
    )
  ).rows;
const lastValue = async (pool, table) =>
  BigInt(
    (
      await pool.query(
        `SELECT coalesce(pg_sequence_last_value(pg_get_serial_sequence($1,'sequence')::regclass),0) AS v`,
        [table],
      )
    ).rows[0].v,
  );
/**
 * The edge database comes back from an older copy (hourly backup, stage copy): the copy holds
 * sale 1 acknowledged and sale 2 written but not yet acknowledged; the lost timeline delivered
 * sale 2 and then sale 3, which the restored edge never stored, so the cloud already holds the
 * next sequence of this device. The restored ledger carries the identity of the database the
 * copy was taken from (modelled as in restore.test.mjs).
 */
async function restoreOlderCopy(ctx) {
  const kept = cashSale(ctx.branch, 1, 1);
  await enqueue(ctx.edge.pool, [kept]);
  assert.deepEqual(await ctx.step(), { state: 'delivered', count: 1, more: false });
  const copied = cashSale(ctx.branch, 2, 2);
  const [row] = await enqueue(ctx.edge.pool, [copied]);
  const lost = { ...cashSale(ctx.branch, 1, 3), sequence: String(BigInt(row.sequence) + 1n) };
  const delivered = await receivePosSales(ctx.cloud.pool, authFor(ctx.identity), {
    events: [sentAs(copied, row), lost],
  });
  assert.equal(delivered.receipts.length, 2, 'the cloud accepted the lost timeline');
  await ctx.edge.pool.query(
    `INSERT INTO edge_database_epochs(epoch,system_identifier,database_oid,reason,sequence_gap)
     SELECT max(epoch)+1, 1, 1, 'initial', 0 FROM edge_database_epochs`,
  );
  return { kept, copied, row, lost };
}

test('restored edge database, a 026 without CR cloud-5 item 1 (fence of 023): pos_sale_outbox is left behind, the next sale reuses a sequence and stays parked as CONFLICT', async () => {
  await withSender(async (ctx) => {
    await installFence023(ctx.edge.pool);
    assert.equal((await installedFence(ctx.edge.pool))[0].covered, false);
    const { row, lost } = await restoreOlderCopy(ctx);
    const pos = await lastValue(ctx.edge.pool, 'pos_sale_outbox');
    assert.equal((await fenceRestoredEdge(ctx.edge.pool)).state, 'restore');
    assert.equal(await lastValue(ctx.edge.pool, 'pos_sale_outbox'), pos);
    const [next] = await enqueue(ctx.edge.pool, [cashSale(ctx.branch, 1, 4)]);
    assert.equal(next.sequence, lost.sequence);
    const parked = { state: 'parked', eventId: next.event_id, error: 'CONFLICT' };
    assert.deepEqual(await ctx.step(), parked);
    // Sale 2 of the copy went again as a duplicate; the new sale holds the stream.
    assert.deepEqual(
      (await outbox(ctx.edge.pool)).map((item) => [
        item.sequence,
        !!item.acknowledged_at,
        item.last_error,
      ]),
      [
        [String(BigInt(row.sequence) - 1n), true, null],
        [row.sequence, true, null],
        [next.sequence, false, 'rejected:CONFLICT'],
      ],
    );
    // Releasing it does not help: the cloud keeps that sequence for the lost event.
    await retryPosSalesDelivery(ctx.edge.pool, ctx.branch, next.event_id);
    ctx.advance(60_000);
    assert.deepEqual(await ctx.step(), parked);
    assert.equal(await cloudCount(ctx.cloud.pool, 'cloud_pos_sales'), 3);
  });
});

/** The owner check of docs/operations/backoffice-cutover.md «Восстановление базы кассы», verbatim. */
async function runbookCheck(pool) {
  const runbook = await readFile(
    new URL('../../../docs/operations/backoffice-cutover.md', import.meta.url),
    'utf8',
  );
  const section = runbook.slice(runbook.indexOf('### Восстановление базы кассы'));
  const open = section.indexOf('```sql\n') + '```sql\n'.length;
  const block = section.slice(open, section.indexOf('```\n', open));
  // Only the check: the interim setval step of CR cloud-5 item 3 is gone (CR pos-6 section 3).
  assert.doesNotMatch(block, /setval|UPDATE|INSERT|DELETE/i);
  const result = await pool.query(block);
  assert.ok(!Array.isArray(result), 'the runbook block is one query');
  assert.deepEqual(Object.keys(result.rows[0]), ['covered']);
  return result.rows[0].covered;
}

test('restored edge database, runbook check: the reviewed 026 fence covers posSales; the fence of 023 makes the owner stop before the desk opens', async () => {
  await withSender(async (ctx) => {
    assert.equal(await runbookCheck(ctx.edge.pool), true);
    await installFence023(ctx.edge.pool);
    assert.equal(await runbookCheck(ctx.edge.pool), false);
  });
});

test('restored edge database with the posSales fence of 026 (CR cloud-5, CR pos-6): new events pass the lost timeline; a Z of a shift open across the restore is parked until the cloud owner accepts it as written', async () => {
  await withSender(async (ctx) => {
    // The reviewed 026 installs the fence itself: pos_sale_outbox in its list, search_path
    // pinned, no PUBLIC EXECUTE.
    assert.deepEqual(await installedFence(ctx.edge.pool), [
      {
        covered: true,
        proconfig: [`search_path=pg_catalog, ${ctx.edge.schema}, pg_temp`],
        public: false,
      },
    ]);
    const { kept, copied } = await restoreOlderCopy(ctx);
    const before = {
      pos: await lastValue(ctx.edge.pool, 'pos_sale_outbox'),
      kitchen: await lastValue(ctx.edge.pool, 'fulfillment_outbox'),
      reports: await lastValue(ctx.edge.pool, 'cashier_report_outbox'),
    };
    assert.equal((await fenceRestoredEdge(ctx.edge.pool)).state, 'restore');
    // The two older outboxes move exactly as before; pos_sale_outbox moves with them, once.
    assert.equal(await lastValue(ctx.edge.pool, 'fulfillment_outbox'), before.kitchen + GAP);
    assert.equal(await lastValue(ctx.edge.pool, 'cashier_report_outbox'), before.reports + GAP);
    assert.equal(await lastValue(ctx.edge.pool, 'pos_sale_outbox'), before.pos + GAP);
    assert.equal((await fenceRestoredEdge(ctx.edge.pool)).state, 'current');
    assert.equal(await lastValue(ctx.edge.pool, 'pos_sale_outbox'), before.pos + GAP);
    // The runbook check passes on this fence.
    assert.equal(await runbookCheck(ctx.edge.pool), true);
    const sale = cashSale(ctx.branch, 1, 4);
    const [next] = await enqueue(ctx.edge.pool, [sale]);
    assert.equal(BigInt(next.sequence), before.pos + GAP + 1n);
    // Sale 2 of the copy is a duplicate, the new sale is accepted.
    assert.deepEqual(await ctx.step(), { state: 'delivered', count: 2, more: false });
    assert.ok((await outbox(ctx.edge.pool)).every((item) => item.acknowledged_at));
    assert.equal(await cloudCount(ctx.cloud.pool, 'cloud_pos_sales'), 4);
    // The Z of the shift that was open across the restore lacks the lost sale 3: refused, parked
    // (runbook «Восстановление базы кассы», CR cloud-5 section 2).
    const z = vectorEvent('shift_report_z', ctx.branch, (p, event) => {
      event.event_id = randomUUID();
      p.report = zReportFor([kept, copied, sale], p.report, {
        cash_out_minor: '0',
        counted_cash_minor: '2050000',
        terminal_reported_minor: null,
        terminal_discrepancy_minor: null,
      });
    });
    assert.equal(z.payload.report.expected_cash_minor, '2050000');
    // The next shift's first sale waits behind the Z.
    const later = cashSale(ctx.branch, 1, 5);
    later.payload.shift_id = randomUUID();
    const [zRow] = await enqueue(ctx.edge.pool, [z, later]);
    const parked = { state: 'parked', eventId: zRow.event_id, error: 'INVALID_EVENT' };
    assert.deepEqual(await ctx.step(), parked);
    assert.equal(await cloudCount(ctx.cloud.pool, 'cloud_pos_shift_reports'), 0);
    // Releasing it alone does not help: the receiver refuses that Z again.
    await retryPosSalesDelivery(ctx.edge.pool, ctx.branch, zRow.event_id);
    ctx.advance(60_000);
    assert.deepEqual(await ctx.step(), parked);
    assert.equal(await cloudCount(ctx.cloud.pool, 'cloud_pos_shift_reports'), 0);

    // The only positive path: the cloud owner command (CR cloud-5 item 2, option A), run as in
    // the runbook. The parked row is exported on the edge with the runbook SQL ...
    assert.equal(await runbookExport(ctx.edge.pool, later.event_id), null, 'not parked, no file');
    const exported = await runbookExport(ctx.edge.pool, zRow.event_id);
    assert.deepEqual(exported, { ...sentAs(z, zRow), payload_hash: hashJson(z.payload) });
    const manager = await provisionCatalogManager(ctx.cloud.pool, {
      organization_id: ctx.org,
      name: 'Синтетический управляющий',
      branch_ids: [ctx.branch],
    });
    await grantBackoffice(ctx.cloud.pool, manager.actor_id, ctx.branch, 'manager');
    const directory = await mkdtemp(join(tmpdir(), 'pickchick-restored-z-'));
    try {
      const file = join(directory, 'parked-z.json');
      await writeFile(file, JSON.stringify(exported) + '\n');
      // ... and accepted with scripts/backoffice-setup.mjs and the owner URL of the cloud.
      const args = [
        '--accept-restored-z',
        '--branch',
        ctx.branch,
        '--device',
        ctx.device,
        '--actor',
        manager.actor_id,
        '--request',
        randomUUID(),
        '--event',
        file,
        '--reason',
        'Z смены через восстановление кассы (синтетика)',
      ];
      const accepted = await backofficeSetup(ctx, args);
      assert.equal(accepted.code, 0, accepted.stderr);
      const line = JSON.parse(accepted.stdout);
      assert.deepEqual(
        { ...line, methods: line.methods.filter((row) => row.method === 'cash') },
        {
          event: 'pos_sales_restored_z',
          state: 'accepted',
          event_id: zRow.event_id,
          sequence: zRow.sequence,
          shift_id: z.payload.shift_id,
          rejected_as: 'shift_cash',
          cash: {
            z_sales_minor: '1050000',
            cloud_sales_minor: '1400000',
            z_refunds_minor: '0',
            cloud_refunds_minor: '0',
          },
          methods: [
            {
              method: 'cash',
              z_sales_minor: '1050000',
              cloud_sales_minor: '1400000',
              z_refunds_minor: '0',
              cloud_refunds_minor: '0',
              z_count: 3,
              cloud_count: 4,
            },
          ],
        },
      );
      assert.doesNotMatch(accepted.stdout, /token|password|Синтетический/i);
      // The same command again is a no-op with the same answer (stored as jsonb, so the key
      // order of the line may differ).
      const replay = await backofficeSetup(ctx, args);
      assert.equal(replay.code, 0, replay.stderr);
      assert.deepEqual(JSON.parse(replay.stdout), line);
      assert.equal(await cloudCount(ctx.cloud.pool, 'cloud_pos_shift_reports'), 1);
      const written = (
        await ctx.cloud.pool.query(
          `SELECT (SELECT count(*) FROM bo_audit WHERE action='pos_sales:accept_restored_z')::int AS audit,
           (SELECT count(*) FROM bo_commands)::int AS commands,
           (SELECT report FROM cloud_pos_shift_reports WHERE shift_id=$1) AS report`,
          [z.payload.shift_id],
        )
      ).rows[0];
      assert.deepEqual(written, { audit: 1, commands: 1, report: z.payload.report });
      // An unusable file is refused like an event that fails the model; nothing is written.
      await writeFile(file, '');
      const empty = await backofficeSetup(ctx, [
        ...args.slice(0, 8),
        randomUUID(),
        ...args.slice(9),
      ]);
      assert.equal(empty.code, 1);
      assert.deepEqual(JSON.parse(empty.stderr), {
        event: 'pos_sales_restored_z_refused',
        code: 'INVALID_REQUEST',
        reason: 'model',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    // The edge owner releases the parked Z: it goes as a duplicate and the stream goes on.
    ctx.advance(60_000);
    assert.deepEqual(await ctx.step(), parked, 'parked on the edge until its owner releases it');
    await retryPosSalesDelivery(ctx.edge.pool, ctx.branch, zRow.event_id);
    ctx.advance(60_000);
    assert.deepEqual(await ctx.step(), { state: 'delivered', count: 2, more: false });
    assert.ok(
      (await outbox(ctx.edge.pool)).every((item) => item.acknowledged_at && !item.last_error),
    );
    assert.equal(await cloudCount(ctx.cloud.pool, 'cloud_pos_sales'), 5);
    assert.equal(await cloudCount(ctx.cloud.pool, 'cloud_pos_shift_reports'), 1);
    assert.equal((await syncState(ctx.edge.pool, ctx.branch)).last_error, null);
  });
});

/**
 * The edge export SQL of docs/operations/backoffice-cutover.md «Принять Z смены, открытой во
 * время восстановления», verbatim except the psql variable `:'event_id'`: the JSON row or null.
 */
async function runbookExport(pool, eventId) {
  const runbook = await readFile(
    new URL('../../../docs/operations/backoffice-cutover.md', import.meta.url),
    'utf8',
  );
  const section = runbook.slice(runbook.indexOf('#### Принять Z смены, открытой во время'));
  const open = section.indexOf('```sql\n') + '```sql\n'.length;
  const block = section.slice(open, section.indexOf('```\n', open));
  assert.equal(block.split(":'event_id'").length, 2);
  const result = await pool.query(block.replace(":'event_id'", '$1'), [eventId]);
  assert.ok(result.rowCount <= 1);
  return result.rows[0]?.json_build_object ?? null;
}
/** scripts/backoffice-setup.mjs with the owner URL of the cloud test schema. */
function backofficeSetup(ctx, args) {
  const script = fileURLToPath(new URL('../../../scripts/backoffice-setup.mjs', import.meta.url));
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      { env: { ...process.env, CLOUD_DATABASE_URL: ctx.cloud.config.databaseUrl } },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

/** A real LOGIN role holding exactly `grants` on one side's test schema. */
async function restricted(ctx, side, grants, run) {
  const role = 'pos_sales_' + randomUUID().replaceAll('-', ''),
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

test('least privilege: the POS sync worker and the receiver need exactly the 026/073 grants', async () => {
  await withSender(async (ctx) => {
    const events = stream(ctx.branch);
    await enqueue(ctx.edge.pool, events);
    const input = {
      enabled: true,
      branchId: ctx.branch,
      origin: ctx.api.url,
      identity: ctx.identity,
    };
    const receiver = (role, schema) =>
      posSyncReceiverGrants(role, schema) +
      '\n' +
      cloudPosSalesGrants(role, { receiver: true, backoffice: false }, schema);
    await restricted(ctx, 'cloud', receiver, async (cloud) => {
      // Today's POS sync worker grants only: the sender waits instead of failing.
      await restricted(ctx, 'edge', posSyncWorkerGrants, async (edge) => {
        assert.deepEqual(
          await syncPosSalesOnce(edge, input, createPosSalesSchedule(), { now: () => START }),
          { state: 'not_installed', retryAt: START + 600_000 },
        );
      });
      const worker = (role, schema) =>
        posSyncWorkerGrants(role, schema) + '\n' + posSalesWorkerGrants(role, schema);
      await restricted(ctx, 'edge', worker, async (edge) => {
        const io = {
          fetch: async (_url, options) =>
            Response.json(
              await receivePosSales(cloud, authFor(ctx.identity), JSON.parse(options.body)),
            ),
        };
        assert.deepEqual(await syncPosSalesOnce(edge, input, createPosSalesSchedule(), io), {
          state: 'delivered',
          count: 14,
          more: false,
        });
        for (const sql of [
          "UPDATE pos_sale_outbox SET payload='{}'",
          'DELETE FROM pos_sale_outbox',
          'UPDATE pos_order_sync_state SET active=true',
          "UPDATE branch_config SET pos_service_mode='pos_sale'",
        ])
          await assert.rejects(edge.query(sql), { code: '42501' }, sql);
        await assert.rejects(retryPosSalesDelivery(edge, ctx.branch, randomUUID()), /FORBIDDEN/);
      });
      for (const sql of [
        'DELETE FROM cloud_pos_sales',
        'UPDATE cloud_pos_sales SET total_minor=1',
        'UPDATE cloud_pos_sale_inbox SET kind=kind',
        'UPDATE cloud_pos_tenders SET amount_minor=1',
        'UPDATE pos_order_sync_bindings SET active=true',
      ])
        await assert.rejects(cloud.query(sql), { code: '42501' }, sql);
    });
    assert.equal(await cloudCount(ctx.cloud.pool, 'cloud_pos_sales'), 8);
    // A receiver role without the 073 grants answers like a cloud without posSales.
    await restricted(ctx, 'cloud', posSyncReceiverGrants, async (cloud) => {
      await assert.rejects(
        receivePosSales(cloud, authFor(ctx.identity), { events: [] }),
        (error) => error.code === 'NOT_FOUND',
      );
    });
  });
});
