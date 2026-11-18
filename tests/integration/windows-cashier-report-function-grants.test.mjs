// 18.11.2026 (cutover 19.11): on a native Windows edge every function a migration creates runs
// for its owner only (native-foundation-db.mjs revokes PUBLIC EXECUTE by default), while the 016
// cashier report trigger and the 026 sales code call invoker helpers as the edge runtime and the
// fulfillment worker. The first unpaid POS order on the test cashier failed with «нет доступа к
// функции append_cashier_order_report» and was rolled back. This test rebuilds those privileges
// on a 028 edge, proves the failure as the restricted logins, then the additive tool
// cashier-report-function-grants.mjs: exact EXECUTE entries, order, kitchen and shift work again,
// replay, rollback and refusals.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createPool } from '@pickchick/database';
import { applyMenu, publishMenu } from '@pickchick/menu-sync';
import {
  closeCashShift,
  createLocalOrder,
  createQuote,
  moveCash,
  openCashShift,
  provisionStaff,
  setOrdering,
} from '@pickchick/local-orders';
import {
  EdgeFulfillment,
  grantStation,
  localUnpaidExecution,
  provisionFulfillment,
} from '@pickchick/edge-fulfillment';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';
import { fulfillmentWorkerGrants } from '../../infra/windows/fulfillment-worker-grants.mjs';
import {
  KASPI_SCHEMA_ROW,
  REPORT_FUNCTIONS,
  SALES_FUNCTIONS,
  WORKER_FUNCTIONS,
  cashierReportFunctionGrants,
} from '../../infra/windows/cashier-report-function-grants.mjs';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { staffAuth } from '../helpers/orders.mjs';

const pinned = JSON.parse(
  await readFile(new URL('../../infra/windows/native-edge-backup-ledger.json', import.meta.url)),
);

/** A restricted login like the native ones: no flags, no memberships, its own grants only. */
async function loginRole(ctx, grant) {
  const role = 'rfg_' + randomUUID().replaceAll('-', '').slice(0, 24),
    password = randomBytes(32).toString('hex');
  await ctx.edge.admin.query(
    `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  const url = new URL(ctx.edge.config.databaseUrl);
  url.username = role;
  url.password = password;
  let pool = null;
  const login = {
    role,
    pool: () => (pool ??= createPool(url.toString(), 1)),
    async drop() {
      if (pool) await pool.end();
      pool = null;
      await ctx.edge.admin.query(`DROP OWNED BY ${role}`);
      await ctx.edge.admin.query(`DROP ROLE ${role}`);
    },
  };
  try {
    await grant(role);
  } catch (error) {
    await login.drop();
    throw error;
  }
  return login;
}

/** A 028 cash desk in unpaid service: menu, cashier, manager, a cook on the prep station. */
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
  await setOrdering(edge, ctx.branch, staffAuth(manager), randomUUID(), true, {
    expected_version: 1,
  });
  await edge.query("UPDATE branch_config SET pos_service_mode='unpaid_service' WHERE id=$1", [
    ctx.branch,
  ]);
  const port = localUnpaidExecution({ enabled: true, deviceId: ctx.device });
  const order = async (pool) => {
    const q = await createQuote(pool, ctx.branch, staffAuth(cashier), {
      release_id: release.release_id,
      service_mode: 'takeaway',
      items: [{ variant_id: release.items[0].variant_id, quantity: 2 }],
    });
    return createLocalOrder(
      pool,
      ctx.branch,
      staffAuth(cashier),
      randomUUID(),
      { quote_id: q.quote_id, kitchen_admission: 'unpaid' },
      port,
    );
  };
  const openShift = (pool) =>
    openCashShift(pool, ctx.branch, staffAuth(manager), randomUUID(), {
      opening_cash_minor: '100000',
    });
  const cashIn = (pool, shiftId) =>
    moveCash(pool, ctx.branch, staffAuth(manager), randomUUID(), shiftId, {
      direction: 'in',
      amount_minor: '5000',
      reason: 'Размен',
    });
  return { order, openShift, cashIn, cashier, manager, cook, prep };
}

/** PostgreSQL's refusal of one function, as the edge sees it inside the rolled-back request. */
const denied = (fn) => (error) =>
  error?.code === '42501' && new RegExp(`function ${fn}\\b`).test(error.message);

const counts = async (pool) =>
  (
    await pool.query(
      `SELECT (SELECT count(*)::int FROM local_orders) AS orders,
         (SELECT count(*)::int FROM checkout_quotes) AS quotes,
         (SELECT count(*)::int FROM fulfillment_reservations) AS reservations,
         (SELECT count(*)::int FROM fulfillment_tasks) AS tasks,
         (SELECT count(*)::int FROM local_cash_movements) AS movements,
         (SELECT count(*)::int FROM cashier_report_outbox) AS reports`,
    )
  ).rows[0];

/** Functions of the schema the role may run, and the full table/column ACL of the schema. */
async function rights(ctx, roles) {
  const executable = {};
  for (const role of roles)
    executable[role] = (
      await ctx.edge.pool.query(
        `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p
          WHERE p.pronamespace=$1::regnamespace AND has_function_privilege($2,p.oid,'EXECUTE')
          ORDER BY 1`,
        [ctx.edge.schema, role],
      )
    ).rows
      .map((r) => r.fn)
      .sort();
  const tables = (
    await ctx.edge.pool.query(
      `SELECT c.relname, c.relacl::text AS acl,
         (SELECT json_agg(json_build_array(a.attname, a.attacl::text) ORDER BY a.attnum)
            FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attacl IS NOT NULL) AS columns
         FROM pg_class c WHERE c.relnamespace=$1::regnamespace ORDER BY c.relname`,
      [ctx.edge.schema],
    )
  ).rows;
  const schemaAcl = (
    await ctx.edge.pool.query('SELECT nspacl::text AS acl FROM pg_namespace WHERE nspname=$1', [
      ctx.edge.schema,
    ])
  ).rows[0].acl;
  return { executable, tables, schemaAcl };
}

test('cashier-report-function-grants: native-like 028 edge - POS order, kitchen and shift fail without EXECUTE; the tool adds exactly it; replay, revoke, refusals', async () => {
  await withSyncDatabases(async (ctx) => {
    const { pool, schema, admin } = ctx.edge;
    // native-foundation-db.mjs: ALTER DEFAULT PRIVILEGES FOR ROLE pickchick_edge_owner REVOKE
    // EXECUTE ON FUNCTIONS FROM PUBLIC before the migrations; the same end state here.
    await pool.query(`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC`);
    // 028 on the cutover branch; 029 once the reviewed Kaspi migration is in this repository.
    const migrated = (await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0]
      .n;
    assert.ok([28, 29].includes(migrated), String(migrated));
    const desk = await unpaidDesk(ctx);
    const runtime = await loginRole(ctx, (role) =>
      applyEdgeRuntimeGrants(pool, role, { schema, fulfillment: true }),
    );
    const worker = await loginRole(ctx, (role) =>
      pool.query(fulfillmentWorkerGrants(role, schema, { restoreFence: true })),
    );
    const broad = 'rfg_broad_' + randomUUID().replaceAll('-', '').slice(0, 16);
    await admin.query(`CREATE ROLE ${broad} NOLOGIN CREATEDB`);
    const tool = async (options) => {
      const client = await pool.connect();
      try {
        return await cashierReportFunctionGrants(client, {
          schema,
          runtimeRole: runtime.role,
          workerRoles: [worker.role, 'rfg_absent_worker'],
          pinned,
          branchId: ctx.branch,
          ...options,
        });
      } finally {
        client.release();
      }
    };
    const kitchen = new EdgeFulfillment(runtime.pool());
    const kitchenOrder = async (localOrderId) => {
      const { order_id: orderId } = (
        await pool.query('SELECT order_id FROM fulfillment_reservations WHERE local_order_id=$1', [
          localOrderId,
        ])
      ).rows[0];
      return new EdgeFulfillment(pool).readOrder(ctx.branch, staffAuth(desk.manager), orderId);
    };
    const startPrep = (current) => {
      const task = current.tasks.find((t) => t.station_id === desk.prep);
      return kitchen.act(ctx.branch, staffAuth(desk.cook), {
        commandId: randomUUID(),
        orderId: current.orderId,
        expectedVersion: current.version,
        action: 'start_task',
        taskId: task.id,
        expectedTaskVersion: task.version,
      });
    };
    const runtimePlan = [...REPORT_FUNCTIONS, ...SALES_FUNCTIONS];
    const entries = [
      ...runtimePlan.map((fn) => `${runtime.role}|${fn}||EXECUTE`),
      ...WORKER_FUNCTIONS.map((fn) => `${worker.role}|${fn}||EXECUTE`),
    ];
    try {
      // 1. The 18.11 failure, as the restricted logins.
      await assert.rejects(desk.openShift(runtime.pool()), denied('append_cashier_shift_report'));
      const shift = await desk.openShift(pool);
      const before = await counts(pool);
      await assert.rejects(desk.order(runtime.pool()), denied('append_cashier_order_report'));
      await assert.rejects(
        desk.cashIn(runtime.pool(), shift.shift_id),
        denied('append_cashier_shift_report'),
      );
      // The kitchen screen could not take an order from the POS either.
      const earlier = await desk.order(pool);
      const afterAdmin = await counts(pool);
      await assert.rejects(
        startPrep(await kitchenOrder(earlier.order_id)),
        denied('append_cashier_order_report'),
      );
      await assert.rejects(
        runtime.pool().query('SELECT pos_shift_cash($1)', [shift.shift_id]),
        denied('pos_shift_cash'),
      );
      await assert.rejects(
        worker.pool().query('SELECT append_cashier_order_report($1)', [earlier.order_id]),
        denied('append_cashier_order_report'),
      );
      // Nothing of the refused requests was kept (only the owner's own order exists).
      assert.equal(before.orders + 1, afterAdmin.orders);
      assert.deepEqual(await counts(pool), afterAdmin);

      // 2. inspect changes nothing and names every missing entry.
      const original = await rights(ctx, [runtime.role, worker.role]);
      const inspected = await tool({ mode: 'inspect' });
      assert.deepEqual(inspected, {
        mode: 'inspect',
        schema: `schema0${migrated}`,
        runtimeRole: runtime.role,
        workerRoles: [worker.role],
        changed: false,
        granted: [],
        revoked: [],
        missing: entries,
        ready: false,
        // Reported only: display numbers (022) and the restore fence (023) come from their tools.
        ownerFunctions: {
          'edge_restore_fence(boolean)': true,
          'fulfillment_display_allocate(uuid)': true,
        },
      });
      assert.deepEqual(await rights(ctx, [runtime.role, worker.role]), original);
      // An owner-rights function the runtime lacks is shown, never granted by this tool.
      const display = 'fulfillment_display_allocate(uuid)';
      await pool.query(`REVOKE EXECUTE ON FUNCTION ${display} FROM ${runtime.role}`);
      for (const mode of ['inspect', 'apply']) {
        const result = await tool({ mode });
        assert.equal(result.ownerFunctions[display], false, mode);
        assert.equal(result.ready, mode === 'apply', mode);
        await tool({ mode: 'revoke' });
      }
      await pool.query(`GRANT EXECUTE ON FUNCTION ${display} TO ${runtime.role}`);
      assert.deepEqual(await rights(ctx, [runtime.role, worker.role]), original);

      // 3. Refusals change nothing.
      for (const [options, message] of [
        [{ mode: 'grant' }, { message: 'Invalid mode' }],
        [{ mode: 'apply', branchId: randomUUID() }, { message: 'Branch differs' }],
        [
          { mode: 'apply', pinned: pinned.slice(0, 27) },
          { message: 'Pinned edge ledger is invalid' },
        ],
        [
          {
            mode: 'apply',
            pinned: pinned.map((m, i) => (i === 4 ? { ...m, checksum: '0'.repeat(64) } : m)),
          },
          { message: 'Reviewed schema016 to schema029 required' },
        ],
        [
          { mode: 'apply', runtimeRole: 'rfg_absent_runtime' },
          { message: 'Existing restricted roles required' },
        ],
        [{ mode: 'apply', runtimeRole: broad }, { message: 'Existing restricted roles required' }],
        [
          { mode: 'apply', workerRoles: [worker.role, broad] },
          { message: 'Existing restricted roles required' },
        ],
        [{ mode: 'apply', schema: 'Public' }, { message: 'Invalid identifier' }],
      ])
        await assert.rejects(tool(options), message, JSON.stringify(options));
      await pool.query('ALTER FUNCTION append_cashier_order_report(uuid) SECURITY DEFINER');
      await assert.rejects(tool({ mode: 'apply' }), { message: 'Reviewed functions differ' });
      await pool.query('ALTER FUNCTION append_cashier_order_report(uuid) SECURITY INVOKER');
      assert.deepEqual(await rights(ctx, [runtime.role, worker.role]), original);

      // 3b. A 029 ledger (the test cashier runs the Kaspi 029) passes only with the reviewed row
      // pinned in the tool, whatever the pinned file carries in its place; the plan stays 028's.
      const kaspi = async (checksum) => {
        await pool.query('DELETE FROM schema_migrations WHERE version=$1', [
          KASPI_SCHEMA_ROW.version,
        ]);
        if (checksum)
          await pool.query(
            'INSERT INTO schema_migrations(version,checksum,scope) VALUES($1,$2,$3)',
            [KASPI_SCHEMA_ROW.version, checksum, KASPI_SCHEMA_ROW.scope],
          );
      };
      const pinned029 = (checksum) => [...pinned.slice(0, 28), { ...KASPI_SCHEMA_ROW, checksum }];
      await kaspi(KASPI_SCHEMA_ROW.checksum);
      const at029 = { ...inspected, schema: 'schema029' };
      assert.deepEqual(await tool({ mode: 'inspect' }), at029);
      assert.deepEqual(await tool({ mode: 'inspect', pinned: pinned029('f'.repeat(64)) }), at029);
      await kaspi('e'.repeat(64));
      for (const options of [
        { mode: 'apply' },
        { mode: 'apply', pinned: pinned029('e'.repeat(64)) },
      ])
        await assert.rejects(
          tool(options),
          { message: 'Reviewed schema016 to schema029 required' },
          JSON.stringify(options).slice(0, 40),
        );
      await kaspi(migrated === 29 ? KASPI_SCHEMA_ROW.checksum : null);
      assert.deepEqual(await rights(ctx, [runtime.role, worker.role]), original);

      // 4. apply: exactly the planned EXECUTE entries, no table, column or schema right.
      const applied = await tool({ mode: 'apply' });
      assert.deepEqual(applied, {
        ...inspected,
        mode: 'apply',
        changed: true,
        granted: entries,
        missing: [],
        ready: true,
      });
      const granted = await rights(ctx, [runtime.role, worker.role]);
      assert.deepEqual(granted.tables, original.tables);
      assert.equal(granted.schemaAcl, original.schemaAcl);
      assert.deepEqual(
        granted.executable[runtime.role],
        [...original.executable[runtime.role], ...runtimePlan].sort(),
      );
      assert.deepEqual(
        granted.executable[worker.role],
        [...original.executable[worker.role], ...WORKER_FUNCTIONS].sort(),
      );
      // The helpers stay invoker: each still runs with its caller's own table rights.
      assert.deepEqual(
        (
          await pool.query(
            `SELECT bool_or(prosecdef) AS definer FROM pg_proc
              WHERE oid = ANY(SELECT to_regprocedure(f) FROM unnest($1::text[]) f)`,
            [runtimePlan],
          )
        ).rows[0],
        { definer: false },
      );

      // 5. The same requests now work as the restricted logins.
      const placed = await desk.order(runtime.pool());
      const reports = async (kind, id) =>
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM cashier_report_outbox WHERE kind=$1 AND entity_id=$2',
            [kind, id],
          )
        ).rows[0].n;
      assert.ok((await reports('order', placed.order_id)) >= 1);
      await startPrep(await kitchenOrder(placed.order_id));
      assert.equal(
        (await kitchenOrder(placed.order_id)).tasks.find((t) => t.station_id === desk.prep).state,
        'in_progress',
      );
      const earlierReports = await reports('order', earlier.order_id);
      await startPrep(await kitchenOrder(earlier.order_id));
      assert.ok((await reports('order', earlier.order_id)) > earlierReports);
      const shiftReports = await reports('shift', shift.shift_id);
      await desk.cashIn(runtime.pool(), shift.shift_id);
      assert.ok((await reports('shift', shift.shift_id)) > shiftReports);
      const cash = (
        await runtime.pool().query('SELECT * FROM pos_shift_cash($1)', [shift.shift_id])
      ).rows[0];
      assert.deepEqual(cash, { cash_sales_minor: '0', cash_refunds_minor: '0' });
      assert.equal(
        (await runtime.pool().query('SELECT pos_shift_pending_fiscal($1) AS n', [shift.shift_id]))
          .rows[0].n,
        0,
      );
      await worker.pool().query('SELECT append_cashier_order_report($1)', [placed.order_id]);
      const current = (
        await pool.query('SELECT version FROM local_cash_shifts WHERE id=$1', [shift.shift_id])
      ).rows[0];
      const closed = await closeCashShift(
        runtime.pool(),
        ctx.branch,
        staffAuth(desk.manager),
        randomUUID(),
        shift.shift_id,
        { expected_version: current.version, counted_cash_minor: '105000', reason: 'Конец смены' },
      );
      assert.equal(closed.state, 'closed');
      const reopened = await desk.openShift(runtime.pool());
      assert.ok((await reports('shift', reopened.shift_id)) >= 1);
      // The worker got the order report only.
      for (const fn of ['append_cashier_shift_report(uuid)', ...SALES_FUNCTIONS])
        assert.equal(
          (
            await pool.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS ok", [
              worker.role,
              fn,
            ])
          ).rows[0].ok,
          false,
          fn,
        );

      // 6. A replay changes nothing.
      const replay = await tool({ mode: 'apply' });
      assert.deepEqual(replay, { ...applied, changed: false, granted: [] });
      assert.deepEqual(await rights(ctx, [runtime.role, worker.role]), granted);

      // 7. revoke removes exactly these entries (rollback); the order fails again; apply again.
      const revoked = await tool({ mode: 'revoke' });
      assert.deepEqual(revoked, {
        ...inspected,
        mode: 'revoke',
        changed: true,
        revoked: entries,
      });
      assert.deepEqual(await rights(ctx, [runtime.role, worker.role]), original);
      await assert.rejects(desk.order(runtime.pool()), denied('append_cashier_order_report'));
      assert.equal((await tool({ mode: 'revoke' })).changed, false);
      assert.equal((await tool({ mode: 'apply' })).ready, true);
      assert.deepEqual(await rights(ctx, [runtime.role, worker.role]), granted);
      await desk.order(runtime.pool());
    } finally {
      await runtime.drop();
      await worker.drop();
      await admin.query(`DROP ROLE IF EXISTS ${broad}`);
    }
  });
});
