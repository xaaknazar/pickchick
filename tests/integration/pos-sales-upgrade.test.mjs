import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPool, migrate } from '@pickchick/database';
import { createApi } from '@pickchick/api';
import { applyMenu, publishMenu, provisionDevice } from '@pickchick/menu-sync';
import {
  cancelLocalOrder,
  closeCashShift,
  createLocalOrder,
  createQuote,
  fenceRestoredEdge,
  listCashShifts,
  listLocalOrders,
  moveCash,
  openCashShift,
  provisionStaff,
  readCashShift,
  readLocalOrder,
  setOrdering,
} from '@pickchick/local-orders';
import {
  EdgeFulfillment,
  grantStation,
  localUnpaidExecution,
  provisionFulfillment,
} from '@pickchick/edge-fulfillment';
import { CashierReportSchema } from '../../packages/fulfillment-transport/dist/cashier-reports.js';
import {
  provisionCloudPosSync,
  provisionEdgePosSync,
  syncPosKitchenOnce,
  syncPosOrdersOnce,
} from '@pickchick/pos-order-sync';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';
import { fulfillmentWorkerGrants } from '../../infra/windows/fulfillment-worker-grants.mjs';
import { posSalesRuntimeGrants } from '../../infra/windows/pos-sales-grants.mjs';
import { withSyncDatabases, running } from '../helpers/sync.mjs';
import { staffAuth } from '../helpers/orders.mjs';

// Contracts 3.2 and 7.3: 026 on a populated 025 edge and 073 on a populated 072 cloud change no
// existing byte, guard or report, and today's unpaid flow (code and grants of the installed
// runtime) keeps working on the new schema.
const edgeDir = fileURLToPath(new URL('../../db/edge/migrations/', import.meta.url));
const cloudDir = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));
const EDGE_026 = '026_edge_pos_sales.sql';
const CLOUD_073 = '073_cloud_pos_sales_sync.sql';

/** A migration directory holding the repo files strictly before `limit` (and nothing later). */
async function upTo(root, name, directory, limit) {
  const target = join(root, name);
  await mkdir(target);
  for (const file of await readdir(directory))
    if (/^\d{3}_[a-z_]+\.sql$/.test(file) && file < limit)
      await copyFile(join(directory, file), join(target, file));
  return target;
}
const rows = async (pool, table, order) =>
  (await pool.query(`SELECT row_to_json(t) AS r FROM ${table} t ORDER BY ${order}`)).rows.map(
    (row) => row.r,
  );
const without = (value, keys) =>
  JSON.parse(JSON.stringify(value), (key, item) => (keys.includes(key) ? undefined : item));

async function unpaidDesk(ctx) {
  const edge = ctx.edge.pool;
  const release = ctx.menu();
  await applyMenu(edge, ctx.branch, await publishMenu(ctx.cloud.pool, release));
  const setup = (role, terminal = randomUUID()) => ({
    staff_id: randomUUID(),
    terminal_id: terminal,
    name: 'Synthetic staff',
    role,
  });
  const cashier = await provisionStaff(edge, ctx.branch, setup('cashier'));
  const manager = await provisionStaff(
    edge,
    ctx.branch,
    setup('shift_manager', cashier.terminal_id),
  );
  const second = await provisionStaff(edge, ctx.branch, setup('shift_manager'));
  const prep = randomUUID(),
    assembly = randomUUID();
  await provisionFulfillment(edge, {
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
      routes: [{ productId: release.items[0].product_id, stationId: prep, kind: 'prep' }],
    },
  });
  const cook = await provisionStaff(edge, ctx.branch, setup('kitchen'));
  await grantStation(edge, ctx.branch, cook.staff_id, prep);
  await grantStation(edge, ctx.branch, cook.staff_id, assembly);
  await setOrdering(edge, ctx.branch, staffAuth(manager), randomUUID(), true, {
    expected_version: 1,
  });
  await edge.query("UPDATE branch_config SET pos_service_mode='unpaid_service' WHERE id=$1", [
    ctx.branch,
  ]);
  const port = localUnpaidExecution({ enabled: true, deviceId: ctx.device });
  const cart = {
    release_id: release.release_id,
    service_mode: 'takeaway',
    items: [{ variant_id: release.items[0].variant_id, quantity: 2 }],
  };
  const order = async (pool = edge, actor = cashier) => {
    const q = await createQuote(pool, ctx.branch, staffAuth(actor), cart);
    return createLocalOrder(
      pool,
      ctx.branch,
      staffAuth(actor),
      randomUUID(),
      { quote_id: q.quote_id, kitchen_admission: 'unpaid' },
      port,
    );
  };
  const cancel = (o, pool = edge, actor = cashier) =>
    cancelLocalOrder(
      pool,
      ctx.branch,
      staffAuth(actor),
      randomUUID(),
      o.order_id,
      { expected_version: 1, reason: 'Синтетическая отмена' },
      port,
    );
  const repo = new EdgeFulfillment(edge);
  const finish = async (o) => {
    let current = await repo.readOrder(ctx.branch, staffAuth(cook), o.order_id, {
      stationId: prep,
    });
    const act = (action, extra = {}) =>
      repo.act(ctx.branch, staffAuth(cook), {
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
    return act('handoff');
  };
  return { release, cashier, manager, second, cook, prep, cart, order, cancel, finish };
}

/** Violations replayed inside one rolled-back transaction: what each guard answers. */
async function guardAnswers(ctx, desk, state) {
  const client = await ctx.edge.admin.connect();
  const answers = [];
  try {
    await client.query(`SET search_path TO ${ctx.edge.schema}`);
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    // An unused quote of the cashier, inside the rolled-back transaction (no row survives).
    const fresh = { ...state.unpaid.snapshot, quote_id: randomUUID() };
    await client.query(
      'INSERT INTO checkout_quotes(id,branch_id,staff_id,terminal_id,release_id,total_minor,snapshot,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        fresh.quote_id,
        ctx.branch,
        desk.cashier.staff_id,
        desk.cashier.terminal_id,
        fresh.release_id,
        fresh.total_minor,
        fresh,
        fresh.created_at,
        fresh.expires_at,
      ],
    );
    const probes = [
      ['UPDATE local_orders SET total_minor=total_minor+1 WHERE id=$1', [state.unpaid.order_id]],
      [
        "UPDATE local_orders SET state='cancelled',version=version+1,cancellation_reason='x' WHERE id=$1",
        [state.cancelled.order_id],
      ],
      [
        "UPDATE local_orders SET execution_mode='payment_required' WHERE id=$1",
        [state.unpaid.order_id],
      ],
      ["UPDATE local_orders SET payment_state='captured' WHERE id=$1", [state.unpaid.order_id]],
      ["UPDATE local_orders SET state='paid' WHERE id=$1", [state.unpaid.order_id]],
      ['DELETE FROM local_orders WHERE id=$1', [state.unpaid.order_id]],
      [
        "INSERT INTO local_orders(id,branch_id,quote_id,total_minor,cash_shift_id,state) VALUES($1,$2,$3,$4,$5,'cancelled')",
        [randomUUID(), ctx.branch, fresh.quote_id, fresh.total_minor, state.open.shift_id],
      ],
      [
        "INSERT INTO local_orders(id,branch_id,quote_id,total_minor,cash_shift_id,execution_mode) VALUES($1,$2,$3,$4,$5,'unpaid_service')",
        [randomUUID(), ctx.branch, fresh.quote_id, fresh.total_minor, state.open.shift_id],
      ],
      ['UPDATE local_cash_shifts SET opening_cash_minor=1 WHERE id=$1', [state.open.shift_id]],
      ["UPDATE local_cash_shifts SET state='open',version=1 WHERE id=$1", [state.closed.shift_id]],
      ['DELETE FROM local_cash_shifts WHERE id=$1', [state.open.shift_id]],
      [
        "INSERT INTO local_cash_shifts(id,branch_id,staff_id,terminal_id,opening_cash_minor,state) VALUES($1,$2,$3,$4,0,'closed')",
        [randomUUID(), ctx.branch, desk.second.staff_id, desk.second.terminal_id],
      ],
      [
        "INSERT INTO local_cash_movements(id,branch_id,shift_id,staff_id,direction,amount_minor,reason) VALUES($1,$2,$3,$4,'out','999999999','x')",
        [randomUUID(), ctx.branch, state.open.shift_id, desk.manager.staff_id],
      ],
      [
        "INSERT INTO local_cash_movements(id,branch_id,shift_id,staff_id,direction,amount_minor,reason) VALUES($1,$2,$3,$4,'in','1','x')",
        [randomUUID(), ctx.branch, state.open.shift_id, desk.cashier.staff_id],
      ],
      [
        "INSERT INTO local_cash_movements(id,branch_id,shift_id,staff_id,direction,amount_minor,reason) VALUES($1,$2,$3,$4,'in','1','x')",
        [randomUUID(), ctx.branch, state.closed.shift_id, desk.second.staff_id],
      ],
      ['UPDATE local_cash_movements SET reason=reason', []],
      [
        "UPDATE fulfillment_reservations SET admission_kind='cloud_authorized' WHERE local_order_id=$1",
        [state.unpaid.order_id],
      ],
      ["UPDATE branch_config SET pos_service_mode='payment_required'", []],
      ["UPDATE branch_config SET pos_service_mode='unpaid_service'", []],
    ];
    for (const [sql, params] of probes) {
      await client.query('SAVEPOINT probe');
      try {
        await client.query(sql, params);
        answers.push('ok');
      } catch (error) {
        answers.push({ code: error.code, message: error.message, constraint: error.constraint });
      }
      await client.query('ROLLBACK TO SAVEPOINT probe');
    }
    // Shift and order reports the 016 functions append for every existing entity.
    for (const id of [state.open.shift_id, state.closed.shift_id])
      answers.push(
        (
          await client.query(
            "SELECT append_cashier_shift_report($1), (SELECT payload::text FROM cashier_report_outbox WHERE kind='shift' AND entity_id=$1 ORDER BY sequence DESC LIMIT 1) AS payload",
            [id],
          )
        ).rows[0].payload,
      );
    for (const o of [state.unpaid, state.cancelled, state.done])
      answers.push(
        (
          await client.query(
            "SELECT append_cashier_order_report($1), (SELECT payload::text FROM cashier_report_outbox WHERE kind='order' AND entity_id=$1 ORDER BY sequence DESC LIMIT 1) AS payload",
            [o.order_id],
          )
        ).rows[0].payload,
      );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  return answers;
}

async function snapshot(ctx, desk, state) {
  const pool = ctx.edge.pool;
  const strip = (value) => without(value, ['report_at', 'server_time']);
  const reads = {
    orders: [],
    shifts: [],
    list: strip(await listLocalOrders(pool, ctx.branch, staffAuth(desk.manager))),
    shiftList: strip(await listCashShifts(pool, ctx.branch, staffAuth(desk.manager))),
  };
  for (const o of [state.unpaid, state.cancelled, state.done])
    reads.orders.push(await readLocalOrder(pool, ctx.branch, staffAuth(desk.manager), o.order_id));
  for (const s of [state.open, state.closed])
    reads.shifts.push(
      strip(await readCashShift(pool, ctx.branch, staffAuth(desk.manager), s.shift_id)),
    );
  return {
    reads,
    tables: {
      orders: await rows(pool, 'local_orders', 'created_at,id'),
      shifts: (await rows(pool, 'local_cash_shifts', 'opened_at,id')).map((row) =>
        without(row, ['sales_mode']),
      ),
      movements: await rows(pool, 'local_cash_movements', 'created_at,id'),
      reports: await rows(pool, 'cashier_report_outbox', 'sequence'),
      kitchen: await rows(pool, 'fulfillment_reservations', 'created_at,order_id'),
      commercial: await rows(pool, 'outbox_events', 'producer_sequence'),
      quotes: await rows(pool, 'checkout_quotes', 'created_at,id'),
      branch: (await rows(pool, 'branch_config', 'id')).map((row) => without(row, [])),
      ledger: await rows(pool, 'schema_migrations', 'version'),
    },
  };
}

test('026 on a populated 025 edge keeps rows, guards, reads and cashier reports byte-identical; unpaid flow and its grants keep working', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-pos-sales-upgrade-'));
  try {
    const edge025 = await upTo(root, 'edge-025', edgeDir, '026');
    const edge026 = await upTo(root, 'edge-026', edgeDir, '027');
    await withSyncDatabases(
      async (ctx) => {
        const pool = ctx.edge.pool;
        const desk = await unpaidDesk(ctx);
        // Historical 025 state with today's runtime: an open shift with movements and three
        // unpaid orders (live, cancelled, handed over) and a closed shift of a second desk.
        const open = await openCashShift(pool, ctx.branch, staffAuth(desk.manager), randomUUID(), {
          opening_cash_minor: '500000',
        });
        await moveCash(pool, ctx.branch, staffAuth(desk.manager), randomUUID(), open.shift_id, {
          direction: 'in',
          amount_minor: '20000',
          reason: 'Размен',
        });
        await moveCash(pool, ctx.branch, staffAuth(desk.manager), randomUUID(), open.shift_id, {
          direction: 'out',
          amount_minor: '7000',
          reason: 'Хозяйственные расходы',
        });
        const unpaid = await desk.order();
        const cancelled = await desk.cancel(await desk.order());
        const done = await desk.order();
        await desk.finish(done);
        const other = await openCashShift(pool, ctx.branch, staffAuth(desk.second), randomUUID(), {
          opening_cash_minor: '100000',
        });
        await moveCash(pool, ctx.branch, staffAuth(desk.second), randomUUID(), other.shift_id, {
          direction: 'out',
          amount_minor: '1000',
          reason: 'Сдача',
        });
        const closed = await closeCashShift(
          pool,
          ctx.branch,
          staffAuth(desk.second),
          randomUUID(),
          other.shift_id,
          { expected_version: 1, counted_cash_minor: '98500', reason: 'Синтетическое закрытие' },
        );
        const state = { open, closed, unpaid, cancelled, done };
        assert.equal(
          (await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,
          25,
        );
        const before = await snapshot(ctx, desk, state);
        const guards = await guardAnswers(ctx, desk, state);
        assert.equal(
          await pool.query("SELECT to_regclass('pos_sales') AS t").then((r) => r.rows[0].t),
          null,
        );

        assert.deepEqual(await migrate(pool, edge026, 'edge'), [EDGE_026]);
        assert.deepEqual(await migrate(pool, edge026, 'edge'), []);
        const after = await snapshot(ctx, desk, state);
        assert.deepEqual(after.tables.ledger.slice(0, 25), before.tables.ledger);
        assert.equal(after.tables.ledger[25].version, EDGE_026);
        assert.deepEqual(without(after, ['ledger']), without(before, ['ledger']));
        assert.deepEqual(
          (await pool.query('SELECT DISTINCT sales_mode FROM local_cash_shifts')).rows,
          [{ sales_mode: false }],
        );
        // Every guard answers with the same code, message and constraint; reports keep their bytes.
        assert.deepEqual(await guardAnswers(ctx, desk, state), guards);
        assert.ok(guards.filter((answer) => answer === 'ok').length === 2, JSON.stringify(guards));
        assert.deepEqual(
          [...new Set(guards.filter((answer) => answer.message).map((answer) => answer.message))]
            .filter((message) => !message.includes('violates'))
            .sort(),
          [
            'Cash movement requires an open shift and active manager',
            'Cash movements are append only',
            'Cash shifts cannot be deleted',
            'Cash shifts must start open',
            'Immutable fulfillment identity/version',
            'Invalid cash shift transition',
            'Invalid drawer balance',
            'Invalid initial order state',
            'Invalid local order transition',
            'Order execution mode is immutable',
            'Orders cannot be deleted',
            'Unpaid service order requires kitchen admission',
          ],
        );
        assert.equal(
          guards.filter((answer) => typeof answer === 'string' && answer.startsWith('{')).length,
          5,
        );
        // The one new answer: a pos_sale order is refused while the mode is not pos_sale.
        const q = await createQuote(pool, ctx.branch, staffAuth(desk.cashier), desk.cart);
        await assert.rejects(
          pool.query(
            "INSERT INTO local_orders(id,branch_id,quote_id,total_minor,cash_shift_id,execution_mode,state,payment_state) VALUES($1,$2,$3,$4,$5,'pos_sale','paid','captured')",
            [randomUUID(), ctx.branch, q.quote_id, q.total_minor, open.shift_id],
          ),
          (error) => error.code === '23514' && /POS sale mode is not enabled/.test(error.message),
        );
        // Off by default: mode untouched, all eight methods seeded disabled.
        assert.equal(
          (await pool.query('SELECT pos_service_mode FROM branch_config')).rows[0].pos_service_mode,
          'unpaid_service',
        );
        assert.deepEqual(
          (
            await pool.query(
              'SELECT count(*)::int AS n, bool_or(enabled) AS any FROM pos_payment_methods',
            )
          ).rows[0],
          { n: 8, any: false },
        );

        // The installed runtime (this code, with only its own grants) runs the unpaid day on 026.
        const role = 'pos_upgrade_' + randomUUID().replaceAll('-', ''),
          password = randomBytes(32).toString('hex');
        let restricted;
        try {
          await ctx.edge.admin.query(
            `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
          );
          await applyEdgeRuntimeGrants(pool, role, { schema: ctx.edge.schema, fulfillment: true });
          const url = new URL(ctx.edge.config.databaseUrl);
          url.username = role;
          url.password = password;
          restricted = createPool(url.toString());
          const fromSequence = (
            await pool.query(
              'SELECT coalesce(max(sequence),0)::text AS s FROM cashier_report_outbox',
            )
          ).rows[0].s;
          const live = await desk.order(restricted);
          assert.equal(live.fulfillment.state, 'accepted');
          assert.equal((await desk.cancel(live, restricted)).state, 'cancelled');
          await desk.finish(await desk.order(restricted));
          await moveCash(
            restricted,
            ctx.branch,
            staffAuth(desk.manager),
            randomUUID(),
            open.shift_id,
            {
              direction: 'out',
              amount_minor: '13000',
              reason: 'Инкассация',
            },
          );
          const shut = await closeCashShift(
            restricted,
            ctx.branch,
            staffAuth(desk.manager),
            randomUUID(),
            open.shift_id,
            { expected_version: 1, counted_cash_minor: '500000', reason: 'Синтетическое закрытие' },
          );
          assert.equal(shut.expected_cash_minor, '500000');
          assert.equal(shut.discrepancy_minor, '0');
          assert.equal(shut.cash_received_minor, '0');
          assert.equal(shut.payment_processing_available, false);
          await openCashShift(restricted, ctx.branch, staffAuth(desk.manager), randomUUID(), {
            opening_cash_minor: '0',
          });
          // Every report written on 026 is today's exact shape, accepted by the cloud schema.
          const fresh = (
            await pool.query(
              'SELECT event_id,sequence::text,entity_id,kind,payload FROM cashier_report_outbox WHERE sequence>$1 ORDER BY sequence',
              [fromSequence],
            )
          ).rows;
          assert.ok(fresh.length >= 8);
          for (const row of fresh) {
            CashierReportSchema.parse({
              eventId: row.event_id,
              sequence: row.sequence,
              entityId: row.entity_id,
              kind: row.kind,
              payload: row.payload,
            });
            if (row.kind === 'shift')
              assert.deepEqual(Object.keys(row.payload).sort(), [
                'cash_in_minor',
                'cash_out_minor',
                'closed_at',
                'counted_cash_minor',
                'discrepancy_minor',
                'expected_cash_minor',
                'opened_at',
                'opening_cash_minor',
                'shift_id',
                'staff_id',
                'state',
                'terminal_id',
              ]);
          }
          for (const sql of [
            'SELECT * FROM pos_sales',
            'SELECT * FROM pos_payment_methods',
            "UPDATE branch_config SET pos_service_mode='pos_sale'",
          ])
            await assert.rejects(restricted.query(sql), (error) => error.code === '42501', sql);
        } finally {
          if (restricted) await restricted.end();
          await ctx.edge.admin.query(`DROP OWNED BY ${role}`);
          await ctx.edge.admin.query(`DROP ROLE ${role}`);
        }
      },
      { edgeMigrationDirectory: edge025 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// CR cloud-5 item 1: 026 ends with edge_restore_fence of 023 plus pos_sale_outbox in its outbox
// list, its search_path pinned again (CREATE OR REPLACE resets SET) and its ACL unchanged.
const GAP = 1_000_000_000n;
const OUTBOXES_023 = "ARRAY['cashier_report_outbox', 'fulfillment_outbox']";
const OUTBOXES_026 = "ARRAY['cashier_report_outbox', 'fulfillment_outbox', 'pos_sale_outbox']";
/** edge_restore_fence(boolean) as PostgreSQL holds it: definition, owner, rights, settings. */
async function fenceFunction(pool) {
  const { rows: found } = await pool.query(
    `SELECT pg_get_functiondef(p.oid) AS definition, pg_get_userbyid(p.proowner) AS owner,
       p.proacl::text AS acl, p.proconfig, p.prosecdef, p.provolatile,
       has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
     FROM pg_proc p WHERE p.proname='edge_restore_fence' AND p.pronamespace=current_schema()::regnamespace`,
  );
  assert.equal(found.length, 1, 'one edge_restore_fence(boolean), no overload');
  return found[0];
}
const lastSequence = async (db, table) => {
  if (!(await db.query('SELECT to_regclass($1) AS t', [table])).rows[0].t) return null;
  return BigInt(
    (
      await db.query(
        `SELECT coalesce(pg_sequence_last_value(pg_get_serial_sequence($1,'sequence')::regclass),0) AS v`,
        [table],
      )
    ).rows[0].v,
  );
};
/** Every counter edge_restore_fence moves, the menu restore cursor and the fence ledger. */
async function fenceCounters(pool) {
  const one = async (sql) => (await pool.query(sql)).rows;
  return {
    streams: (await one('SELECT last_sequence FROM local_order_streams ORDER BY branch_id')).map(
      (row) => BigInt(row.last_sequence),
    ),
    reports: await lastSequence(pool, 'cashier_report_outbox'),
    kitchen: await lastSequence(pool, 'fulfillment_outbox'),
    pos: await lastSequence(pool, 'pos_sale_outbox'),
    heartbeat: (
      await one('SELECT attempts FROM fulfillment_transport_state ORDER BY branch_id')
    ).map((row) => BigInt(row.attempts)),
    menu: await one(
      'SELECT last_sequence::text,restore_resync_from::text FROM menu_sync_state ORDER BY branch_id',
    ),
    epochs: await one(
      'SELECT epoch,reason,sequence_gap::text FROM edge_database_epochs ORDER BY epoch',
    ),
  };
}
/** How far each counter moved (null where the counter does not exist). */
const moved = (before, after) => ({
  streams: after.streams.map((value, i) => value - before.streams[i]),
  reports: after.reports - before.reports,
  kitchen: after.kitchen - before.kitchen,
  pos: after.pos === null ? null : after.pos - before.pos,
  heartbeat: after.heartbeat.map((value, i) => value - before.heartbeat[i]),
  menu: after.menu,
  epochs: after.epochs.slice(before.epochs.length),
});
/** The restored ledger carries the identity of the database the copy was taken from. */
const restoredIdentity = (pool) =>
  pool.query(
    `INSERT INTO edge_database_epochs(epoch,system_identifier,database_oid,reason,sequence_gap)
     SELECT max(epoch)+1, 1, 1, 'initial', 0 FROM edge_database_epochs`,
  );
/** posSales events written the way pos-outbox.ts writes them (synthetic payloads). */
const writePosEvents = async (pool, branch, count) => {
  const written = [];
  for (let i = 0; i < count; i++) {
    const payload = { synthetic: randomUUID() };
    written.push(
      (
        await pool.query(
          `INSERT INTO pos_sale_outbox(branch_id,kind,entity_id,payload,payload_hash)
           VALUES($1,'sale',$2,$3,$4) RETURNING sequence::text AS sequence`,
          [branch, randomUUID(), payload, randomBytes(32).toString('hex')],
        )
      ).rows[0].sequence,
    );
  }
  return written.map(BigInt);
};

/** A LOGIN role with `grant`, a one-connection pool on the test schema, dropped by `close`. */
async function loginRole(ctx, grant) {
  const role = 'pos_fence_' + randomUUID().replaceAll('-', ''),
    password = randomBytes(32).toString('hex');
  await ctx.edge.admin.query(
    `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  const url = new URL(ctx.edge.config.databaseUrl);
  url.username = role;
  url.password = password;
  const pool = createPool(url.toString(), 1);
  const close = async () => {
    await pool.end();
    await ctx.edge.admin.query(`DROP OWNED BY ${role}`);
    await ctx.edge.admin.query(`DROP ROLE ${role}`);
  };
  try {
    await grant(role);
  } catch (error) {
    await close();
    throw error;
  }
  return { role, pool, close };
}

test('026 on a populated 025 edge: the restore fence moves pos_sale_outbox exactly once and the older counters exactly as 023 did; search_path pinned, no PUBLIC EXECUTE, grants kept (CR cloud-5)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-pos-sales-fence-'));
  try {
    const edge025 = await upTo(root, 'edge-025', edgeDir, '026');
    const edge026 = await upTo(root, 'edge-026', edgeDir, '027');
    await withSyncDatabases(
      async (ctx) => {
        const { pool, schema } = ctx.edge;
        const desk = await unpaidDesk(ctx);
        // A populated 025 day: order stream, kitchen events, cashier reports, transport heartbeat.
        const open = await openCashShift(pool, ctx.branch, staffAuth(desk.manager), randomUUID(), {
          opening_cash_minor: '500000',
        });
        await moveCash(pool, ctx.branch, staffAuth(desk.manager), randomUUID(), open.shift_id, {
          direction: 'in',
          amount_minor: '20000',
          reason: 'Размен',
        });
        await desk.cancel(await desk.order());
        await desk.finish(await desk.order());
        await desk.order();
        await pool.query(
          'INSERT INTO fulfillment_transport_state(branch_id,attempts) VALUES($1,7) ON CONFLICT DO NOTHING',
          [ctx.branch],
        );
        // The installed runtime and the fencing FulfillmentWorker (today's grants, schema023).
        const runtime = await loginRole(ctx, (role) =>
          applyEdgeRuntimeGrants(pool, role, { schema, fulfillment: true }),
        );
        let worker;
        try {
          worker = await loginRole(ctx, (role) =>
            pool.query(fulfillmentWorkerGrants(role, schema, { restoreFence: true })),
          );
          await fenceUpgrade(ctx, edge026, runtime, worker);
        } finally {
          await worker?.close();
          await runtime.close();
        }
      },
      { edgeMigrationDirectory: edge025 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fenceUpgrade(ctx, edge026, runtime, worker) {
  const { pool, schema } = ctx.edge;
  const executes = async () =>
    (
      await pool.query(
        `SELECT has_function_privilege($1,'edge_restore_fence(boolean)','EXECUTE') AS runtime,
           has_function_privilege($2,'edge_restore_fence(boolean)','EXECUTE') AS worker`,
        [runtime.role, worker.role],
      )
    ).rows[0];
  const covered = async () =>
    (
      await pool.query(
        "SELECT pg_get_functiondef('edge_restore_fence(boolean)'::regprocedure) LIKE '%pos_sale_outbox%' AS covered",
      )
    ).rows[0].covered;
  const before025 = await fenceCounters(pool);
  assert.ok(before025.streams[0] > 0n && before025.reports > 0n && before025.kitchen > 0n);
  assert.equal(before025.pos, null);
  assert.deepEqual(before025.heartbeat, [7n]);
  const fence023 = await fenceFunction(pool);
  assert.equal(fence023.definition.split(OUTBOXES_023).length, 2);
  assert.equal(await covered(), false);
  assert.deepEqual(await executes(), { runtime: true, worker: true });

  // Today (023): a restored copy moves the order stream, cashier reports, kitchen events and
  // the heartbeat revision by the gap, once.
  await restoredIdentity(pool);
  assert.equal((await fenceRestoredEdge(runtime.pool)).state, 'restore');
  const after025 = await fenceCounters(pool);
  const step025 = moved(before025, after025);
  assert.deepEqual(
    { ...step025, menu: null, epochs: null },
    {
      streams: [GAP],
      reports: GAP,
      kitchen: GAP,
      pos: null,
      heartbeat: [GAP],
      menu: null,
      epochs: null,
    },
  );
  // The restored ledger row (the copy's identity) and the fence's own row.
  assert.deepEqual(step025.epochs, [
    { epoch: before025.epochs.at(-1).epoch + 1, reason: 'initial', sequence_gap: '0' },
    { epoch: before025.epochs.at(-1).epoch + 2, reason: 'restore', sequence_gap: String(GAP) },
  ]);

  // 026 replaces the function and calls nothing: no epoch, no counter moves.
  assert.deepEqual(await migrate(pool, edge026, 'edge'), [EDGE_026]);
  assert.deepEqual(await fenceCounters(pool), { ...after025, pos: 0n });
  const fence026 = await fenceFunction(pool);
  // The definition differs from 023 only by the outbox list; owner, ACL, owner rights,
  // volatility and the pinned search_path are the same.
  assert.equal(fence026.definition, fence023.definition.replace(OUTBOXES_023, OUTBOXES_026));
  assert.deepEqual({ ...fence026, definition: null }, { ...fence023, definition: null });
  assert.deepEqual(fence026.proconfig, [`search_path=pg_catalog, ${schema}, pg_temp`]);
  assert.equal(fence026.prosecdef, true);
  assert.equal(fence026.public_execute, false);
  assert.deepEqual(await executes(), { runtime: true, worker: true });
  // The check of the interim owner step (backoffice-cutover.md) now answers covered.
  assert.equal(await covered(), true);
  assert.equal((await fenceRestoredEdge(runtime.pool)).state, 'current');
  assert.equal((await fenceRestoredEdge(worker.pool)).state, 'current');
  assert.deepEqual(await fenceCounters(pool), { ...after025, pos: 0n });

  // A sales day on 026 writes posSales events; the runtime draws the next number (USAGE) but
  // never sets it: the fence moves it with owner rights.
  await pool.query(posSalesRuntimeGrants(runtime.role, schema));
  assert.deepEqual(await writePosEvents(pool, ctx.branch, 3), [1n, 2n, 3n]);
  await assert.rejects(
    runtime.pool.query("SELECT setval(pg_get_serial_sequence('pos_sale_outbox','sequence'), 5)"),
    /permission denied/,
  );
  // Another restore on 026, fenced by the least-privileged runtime in a session holding a
  // temporary pos_sale_outbox: the pinned search_path (pg_temp last) moves the real one.
  await restoredIdentity(pool);
  const before026 = await fenceCounters(pool);
  const session = await runtime.pool.connect();
  let spoof;
  try {
    await session.query('CREATE TEMP TABLE pos_sale_outbox(sequence bigserial)');
    await session.query('INSERT INTO pos_sale_outbox DEFAULT VALUES');
    assert.equal((await fenceRestoredEdge(session)).state, 'restore');
    spoof = BigInt(
      (
        await session.query(
          "SELECT pg_sequence_last_value(pg_get_serial_sequence('pg_temp.pos_sale_outbox','sequence')::regclass) AS v",
        )
      ).rows[0].v,
    );
  } finally {
    await session.query('DROP TABLE IF EXISTS pg_temp.pos_sale_outbox');
    session.release();
  }
  assert.equal(spoof, 1n, 'a temporary table never stands in for the real outbox');
  const after026 = await fenceCounters(pool);
  const step026 = moved(before026, after026);
  // The older counters move exactly as 023 moved them; pos_sale_outbox moves by the gap.
  assert.deepEqual(
    { ...step026, pos: null, menu: null, epochs: null },
    { ...step025, menu: null, epochs: null },
  );
  assert.equal(step026.pos, GAP);
  assert.deepEqual(step026.epochs, [
    { epoch: after026.epochs.at(-1).epoch, reason: 'restore', sequence_gap: String(GAP) },
  ]);
  assert.deepEqual(
    after026.menu.map((row) => row.restore_resync_from),
    after026.menu.map((row) => row.last_sequence),
  );
  // Exactly once: the next start (runtime) and the worker's first cycle change nothing.
  assert.equal((await fenceRestoredEdge(runtime.pool)).state, 'current');
  assert.equal((await fenceRestoredEdge(worker.pool)).state, 'current');
  assert.deepEqual(await fenceCounters(pool), after026);
  // The next posSales event is past anything the lost timeline could have used.
  assert.deepEqual(await writePosEvents(pool, ctx.branch, 1), [3n + GAP + 1n]);
  // Rights are still exactly the 023 ones after both fences.
  assert.deepEqual(
    { ...(await fenceFunction(pool)), definition: null },
    { ...fence023, definition: null },
  );
}

test('073 on a populated 072 cloud keeps the POS projections and accepts today’s commercial and kitchen events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-pos-sales-cloud-upgrade-'));
  try {
    const cloud072 = await upTo(root, 'cloud-072', cloudDir, '073');
    const cloud073 = await upTo(root, 'cloud-073', cloudDir, '074');
    await withSyncDatabases(
      async (ctx) => {
        const desk = await unpaidDesk(ctx);
        await openCashShift(ctx.edge.pool, ctx.branch, staffAuth(desk.manager), randomUUID(), {
          opening_cash_minor: '0',
        });
        const identity = await provisionDevice(ctx.cloud.pool, ctx.device);
        const scope = await provisionEdgePosSync(ctx.edge.pool, {
          organizationId: ctx.org,
          branchId: ctx.branch,
          deviceId: ctx.device,
        });
        await provisionCloudPosSync(ctx.cloud.pool, scope);
        const server = await running(createApi, { ...ctx.cloud.config, posOrderSyncEnabled: true });
        const options = { enabled: true, branchId: ctx.branch, origin: server.url, identity };
        // Commercial events first (kitchen observations require them), each stream to idle.
        const drain = async () => {
          for (const once of [syncPosOrdersOnce, syncPosKitchenOnce]) {
            let state = 'delivered';
            for (let i = 0; i < 100 && state === 'delivered'; i++)
              state = (await once(ctx.edge.pool, options)).state;
            assert.equal(state, 'idle');
          }
        };
        try {
          // 072: one live unpaid order (accepted), one cancelled, one handed over.
          const live = await desk.order();
          const cancelled = await desk.cancel(await desk.order());
          const done = await desk.order();
          await desk.finish(done);
          await drain();
          const tables = [
            ['pos_order_sync_inbox', 'producer_sequence'],
            ['pos_order_sync_projection', 'order_id'],
            ['pos_kitchen_sync_inbox', 'producer_sequence'],
            ['pos_kitchen_sync_projection', 'order_id'],
          ];
          const capture = async () => {
            const result = {};
            for (const [table, order] of tables)
              result[table] = await rows(ctx.cloud.pool, table, order);
            return result;
          };
          const before = await capture();
          assert.equal(before.pos_order_sync_projection.length, 3);
          assert.equal(before.pos_kitchen_sync_projection.length, 3);
          const ledger = await rows(ctx.cloud.pool, 'schema_migrations', 'version');

          assert.deepEqual(await migrate(ctx.cloud.pool, cloud073, 'cloud'), [CLOUD_073]);
          assert.deepEqual(await migrate(ctx.cloud.pool, cloud073, 'cloud'), []);
          assert.deepEqual(
            (await rows(ctx.cloud.pool, 'schema_migrations', 'version')).slice(0, -1),
            ledger,
          );
          assert.deepEqual(await capture(), before);
          for (const table of [
            'cloud_pos_sale_inbox',
            'cloud_pos_sales',
            'cloud_pos_shift_reports',
          ])
            assert.equal(
              (await ctx.cloud.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
              0,
            );

          // 073: the same unpaid events keep flowing: kitchen progress of the live order, a new
          // order and its cancellation, a full kitchen lifecycle.
          await desk.finish(live);
          const late = await desk.order();
          await desk.cancel(late);
          await desk.finish(await desk.order());
          await drain();
          const projection = (
            await ctx.cloud.pool.query(
              'SELECT p.order_id,p.state,p.payment_state,p.execution_mode,k.state AS kitchen FROM pos_order_sync_projection p LEFT JOIN pos_kitchen_sync_projection k ON k.order_id=p.order_id',
            )
          ).rows;
          const byId = new Map(projection.map((row) => [row.order_id, row]));
          assert.equal(projection.length, 5);
          assert.equal(byId.get(live.order_id).kitchen, 'handed_over');
          assert.equal(byId.get(late.order_id).state, 'cancelled');
          assert.equal(byId.get(cancelled.order_id).state, 'cancelled');
          assert.ok(projection.every((row) => row.payment_state === 'not_started'));
          assert.ok(projection.every((row) => row.execution_mode === 'unpaid_service'));
          assert.equal(
            (
              await ctx.edge.pool.query(
                "SELECT (SELECT count(*) FROM outbox_events WHERE aggregate_type='order_commercial' AND acknowledged_at IS NULL)+(SELECT count(*) FROM fulfillment_outbox WHERE payload->>'commercialOwner'='edge_pos' AND acknowledged_at IS NULL) AS n",
              )
            ).rows[0].n,
            '0',
          );
        } finally {
          await server.app.close();
        }
      },
      { cloudMigrationDirectory: cloud072 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
