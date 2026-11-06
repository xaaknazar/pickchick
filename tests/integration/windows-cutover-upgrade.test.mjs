import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPool } from '@pickchick/database';
import { applyMenu, publishMenu } from '@pickchick/menu-sync';
import {
  cancelLocalOrder,
  createLocalOrder,
  createQuote,
  openCashShift,
  provisionStaff,
  setOrdering,
} from '@pickchick/local-orders';
import {
  grantStation,
  localUnpaidExecution,
  provisionFulfillment,
} from '@pickchick/edge-fulfillment';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';
import { fulfillmentWorkerGrants } from '../../infra/windows/fulfillment-worker-grants.mjs';
import { posSyncWorkerGrants } from '../../infra/windows/pos-sync-worker-grants.mjs';
import {
  RUNTIME_PRIVILEGES,
  WORKER_PRIVILEGES,
  assertPosSalesPrivileges,
  posSalesGrantees,
} from '../../infra/windows/pos-sales-grants.mjs';
import {
  FENCE_QUEUES_023,
  FENCE_QUEUES_026,
  POS_SALES_MIGRATION,
  POS_SALES_SHA256,
  posSalesMigration,
} from '../../infra/windows/pos-sales-upgrade-db.mjs';
import {
  KDS_TABLES,
  assertKdsRuntimePrivileges,
  assertKdsWorkerPrivileges,
  kdsTableGrantees,
} from '../../infra/windows/kds-grants.mjs';
import {
  KDS_MIGRATION,
  KDS_SHA256,
  KDS_UPGRADE_WORKER_ROLES,
  kdsMigration,
  routingSupportsKdsStations,
} from '../../infra/windows/kds-upgrade-db.mjs';
import { KDS_RUNTIME_ROLES, KDS_WORKER_ROLES } from '../../infra/windows/kds-switch.mjs';
import { withSyncDatabases } from '../helpers/sync.mjs';
import { staffAuth } from '../helpers/orders.mjs';

// Contracts 3.2, 5.9, 6.2 step 3 and 7.3 (integration): the guarded Windows tool for edge 026 on
// a copy of a populated 025 edge with the installed runtime, FulfillmentWorker and POS sync
// worker roles. Exact privileges, refusals and a refused repeat.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const edgeDir = join(repoRoot, 'db/edge/migrations');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function migrationsBefore(root, limit) {
  const target = join(root, 'db/edge/migrations');
  await mkdir(target, { recursive: true });
  for (const file of await readdir(edgeDir))
    if (/^\d{3}_[a-z_]+\.sql$/.test(file) && file < limit)
      await copyFile(join(edgeDir, file), join(target, file));
  return target;
}

async function loginRole(ctx, grant, prefix = 'cut_') {
  const role = prefix + randomUUID().replaceAll('-', '').slice(0, 24),
    password = randomBytes(32).toString('hex');
  await ctx.edge.admin.query(
    `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  const url = new URL(ctx.edge.config.databaseUrl);
  url.username = role;
  url.password = password;
  let pool = null;
  const open = () => (pool ??= createPool(url.toString(), 1));
  const close = async () => {
    if (pool) await pool.end();
    pool = null;
  };
  const drop = async () => {
    await close();
    await ctx.edge.admin.query(`DROP OWNED BY ${role}`);
    await ctx.edge.admin.query(`DROP ROLE ${role}`);
  };
  try {
    await grant(role);
  } catch (error) {
    await drop();
    throw error;
  }
  return { role, open, close, drop };
}

/** A populated 025 desk: staff, kitchen, an open shift, one unpaid order in the kitchen, one cancelled. */
async function unpaidDay(ctx) {
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
  const order = async (pool = edge) => {
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
  await openCashShift(edge, ctx.branch, staffAuth(manager), randomUUID(), {
    opening_cash_minor: '100000',
  });
  const live = await order();
  const cancelled = await order();
  await cancelLocalOrder(
    edge,
    ctx.branch,
    staffAuth(cashier),
    randomUUID(),
    cancelled.order_id,
    { expected_version: 1, reason: 'Синтетическая отмена' },
    port,
  );
  return { order, live, cook };
}

const run = async (ctx, options) => {
  const client = await ctx.edge.pool.connect();
  try {
    return await posSalesMigration(client, {
      appRoot: repoRoot,
      branchId: ctx.branch,
      schema: ctx.edge.schema,
      ...options,
    });
  } finally {
    client.release();
  }
};
const runKds = async (ctx, options) => {
  const client = await ctx.edge.pool.connect();
  try {
    return await kdsMigration(client, {
      appRoot: repoRoot,
      branchId: ctx.branch,
      schema: ctx.edge.schema,
      ...options,
    });
  } finally {
    client.release();
  }
};
const ledger = async (pool) =>
  (await pool.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows;
const stateRows = async (pool) =>
  (
    await pool.query(
      `SELECT (SELECT json_agg(t ORDER BY t.id) FROM local_orders t) AS orders,
         (SELECT json_agg(t ORDER BY t.order_id) FROM fulfillment_reservations t) AS reservations,
         (SELECT json_agg(t ORDER BY t.sequence) FROM cashier_report_outbox t) AS reports`,
    )
  ).rows[0];

test('pos-sales-upgrade-db: 026 on a populated 025 edge with the installed roles - exact grants, data kept, off, repeat refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-cutover-026-'));
  try {
    const edge025 = await migrationsBefore(join(root, 'edge025'), '026');
    await withSyncDatabases(
      async (ctx) => {
        const { pool, schema } = ctx.edge;
        const day = await unpaidDay(ctx);
        // Today's installed roles on 025: runtime (reset grants), fencing FulfillmentWorker, POS sync.
        const runtime = await loginRole(ctx, (role) =>
          applyEdgeRuntimeGrants(pool, role, { schema, fulfillment: true }),
        );
        const fulfillment = await loginRole(ctx, (role) =>
          pool.query(fulfillmentWorkerGrants(role, schema, { restoreFence: true })),
        );
        const posSync = await loginRole(ctx, (role) =>
          pool.query(posSyncWorkerGrants(role, schema)),
        );
        const roles = { runtimeRole: runtime.role, workerRole: posSync.role };
        try {
          const before = await stateRows(pool);
          const ledger025 = await ledger(pool);
          assert.equal(ledger025.length, 25);

          // A connected edge service stops the tool before any lock or change.
          await runtime.open().query('SELECT 1');
          await assert.rejects(
            run(ctx, { mode: 'apply', ...roles }),
            /Edge services must be stopped/,
          );
          await runtime.close();

          // inspect changes nothing; refusals: another branch, other 026 bytes.
          const inspected = await run(ctx, { mode: 'inspect', ...roles });
          assert.equal(inspected.migrations, 25);
          assert.equal(inspected.applied, false);
          assert.deepEqual(inspected.posSalesGrantedTo, []);
          await assert.rejects(
            run(ctx, { mode: 'apply', ...roles, branchId: randomUUID() }),
            /Branch differs/,
          );
          const tampered = join(root, 'tampered');
          await migrationsBefore(tampered, '027');
          await appendFile(join(tampered, 'db/edge/migrations', POS_SALES_MIGRATION), '\n-- x\n');
          await assert.rejects(
            run(ctx, { mode: 'apply', ...roles, appRoot: tampered }),
            /Expected reviewed migrations 001-025 and the reviewed migration026/,
          );
          assert.deepEqual(await ledger(pool), ledger025);
          assert.equal((await pool.query("SELECT to_regclass('pos_sales') AS r")).rows[0].r, null);

          const fence = async () =>
            (
              await pool.query(
                `SELECT pg_get_functiondef('edge_restore_fence(boolean)'::regprocedure) AS def,
                   p.proacl::text AS acl, p.proconfig::text AS config, p.prosecdef AS definer,
                   pg_get_userbyid(p.proowner) AS owner
                 FROM pg_proc p WHERE p.oid='edge_restore_fence(boolean)'::regprocedure`,
              )
            ).rows[0];
          const fence025 = await fence();
          assert.ok(fence025.def.includes(FENCE_QUEUES_023));

          const applied = await run(ctx, { mode: 'apply', ...roles });
          assert.equal(applied.migrations, 26);
          assert.equal(applied.applied, true);
          assert.deepEqual(applied.posSalesGrantedTo, [runtime.role, posSync.role].sort());
          assert.equal(applied.fingerprint, inspected.fingerprint);
          assert.deepEqual(await ledger(pool), [
            ...ledger025,
            { version: POS_SALES_MIGRATION, checksum: POS_SALES_SHA256 },
          ]);
          assert.equal(
            digest(await readFile(join(edgeDir, POS_SALES_MIGRATION))),
            POS_SALES_SHA256,
          );
          // Exact privileges; only the two roles reach 026; existing rows unchanged; still off.
          const options = { schema };
          assert.equal(
            (await assertPosSalesPrivileges(pool, runtime.role, RUNTIME_PRIVILEGES, options))
              .verified,
            true,
          );
          assert.equal(
            (await assertPosSalesPrivileges(pool, posSync.role, WORKER_PRIVILEGES, options))
              .verified,
            true,
          );
          assert.deepEqual(
            (await posSalesGrantees(pool, options)).sort(),
            [runtime.role, posSync.role].sort(),
          );
          assert.deepEqual(await stateRows(pool), before);
          assert.deepEqual(
            (
              await pool.query(
                `SELECT (SELECT pos_service_mode FROM branch_config) AS mode,
                   (SELECT count(*)::int FROM pos_payment_methods) AS methods,
                   (SELECT coalesce(bool_or(enabled),false) FROM pos_payment_methods) AS enabled,
                   (SELECT coalesce(bool_or(sales_mode),false) FROM local_cash_shifts) AS sales_mode`,
              )
            ).rows[0],
            { mode: 'unpaid_service', methods: 8, enabled: false, sales_mode: false },
          );
          // CR pos-6: the fence differs from 023 only by pos_sale_outbox; owner, ACL, config kept.
          const fence026 = await fence();
          assert.equal(fence026.def, fence025.def.replace(FENCE_QUEUES_023, FENCE_QUEUES_026));
          assert.deepEqual({ ...fence026, def: null }, { ...fence025, def: null });
          assert.deepEqual(
            (
              await pool.query(
                `SELECT has_function_privilege($1,'edge_restore_fence(boolean)','EXECUTE') AS runtime,
                   has_function_privilege($2,'edge_restore_fence(boolean)','EXECUTE') AS worker,
                   has_function_privilege($3,'edge_restore_fence(boolean)','EXECUTE') AS pos_sync`,
                [runtime.role, fulfillment.role, posSync.role],
              )
            ).rows[0],
            { runtime: true, worker: true, pos_sync: false },
          );

          // The installed runtime keeps today's unpaid flow on 026 with its restricted login;
          // the POS sync worker reads the posSales outbox but cannot write a sale.
          const restricted = runtime.open();
          assert.equal((await day.order(restricted)).fulfillment.state, 'accepted');
          await assert.rejects(
            restricted.query("UPDATE branch_config SET pos_service_mode='pos_sale'"),
            (error) => error.code === '42501',
          );
          await runtime.close();
          const sync = posSync.open();
          assert.equal(
            (await sync.query('SELECT count(*)::int AS n FROM pos_sale_outbox')).rows[0].n,
            0,
          );
          await assert.rejects(
            sync.query('SELECT 1 FROM pos_sales'),
            (error) => error.code === '42501',
          );
          await posSync.close();

          // A repeat never reapplies; inspect proves the installed state.
          const ledger026 = await ledger(pool);
          await assert.rejects(run(ctx, { mode: 'apply', ...roles }), /already applied/);
          assert.deepEqual(await ledger(pool), ledger026);
          const verified = await run(ctx, { mode: 'inspect', ...roles });
          assert.equal(verified.applied, true);
          assert.equal(verified.migrations, 26);
          assert.deepEqual(verified.posSalesGrantedTo, [runtime.role, posSync.role].sort());
          // A runtime grant reset after 026 keeps the reviewed set (edge-runtime-grants.mjs).
          await applyEdgeRuntimeGrants(pool, runtime.role, { schema, fulfillment: true });
          assert.equal((await run(ctx, { mode: 'inspect', ...roles })).applied, true);
          // A stray privilege is reported by inspect.
          await pool.query(`GRANT SELECT ON pos_sales TO ${fulfillment.role}`);
          await assert.rejects(
            run(ctx, { mode: 'inspect', ...roles }),
            /Unexpected role can reach POS sales relations/,
          );
          await pool.query(`REVOKE SELECT ON pos_sales FROM ${fulfillment.role}`);
        } finally {
          await posSync.drop();
          await fulfillment.drop();
          await runtime.drop();
        }
      },
      { edgeMigrationDirectory: edge025 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pos-sales-upgrade-db refuses a ledger that is not exactly 001-025 and works without installed roles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-cutover-026-ledger-'));
  try {
    const edge024 = await migrationsBefore(join(root, 'edge024'), '025');
    await withSyncDatabases(
      async (ctx) => {
        const roles = { runtimeRole: 'cut_absent_runtime', workerRole: 'cut_absent_worker' };
        await assert.rejects(
          run(ctx, { mode: 'inspect', ...roles }),
          /Expected unchanged schema025 and only reviewed migration026/,
        );
        // On the reviewed 025 a cashier without installed service roles is upgraded, grants none.
        const sql = await readFile(join(edgeDir, '025_edge_kitchen_restore_review.sql'), 'utf8');
        await ctx.edge.pool.query(sql);
        await ctx.edge.pool.query(
          "INSERT INTO schema_migrations(version,checksum,scope) VALUES('025_edge_kitchen_restore_review.sql',$1,'edge')",
          [digest(sql)],
        );
        const applied = await run(ctx, { mode: 'apply', ...roles });
        assert.equal(applied.migrations, 26);
        assert.deepEqual(applied.posSalesGrantedTo, []);
        assert.equal(applied.runtimeRolePresent, false);
        // The service mode of the branch is kept as it was (never pos_sale).
        assert.equal(applied.serviceMode, 'payment_required');
        assert.deepEqual(await posSalesGrantees(ctx.edge.pool, { schema: ctx.edge.schema }), []);
      },
      { edgeMigrationDirectory: edge024 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('kds-upgrade-db: 027 after the 026 tool on a populated edge - KDS stations off, exact runtime and worker grants, repeat refused', async () => {
  // The tool's role names are the ones kds-switch.mjs checks before enable (CR kds-3 section 4).
  assert.deepEqual([...KDS_UPGRADE_WORKER_ROLES], [...KDS_WORKER_ROLES]);
  assert.deepEqual(KDS_RUNTIME_ROLES, ['pickchick_edge_runtime']);
  assert.equal(routingSupportsKdsStations(), true);
  assert.equal(
    routingSupportsKdsStations(() => {
      throw new Error('ROUTING_UNRESOLVED');
    }),
    false,
  );
  const root = await mkdtemp(join(tmpdir(), 'pickchick-cutover-027-'));
  try {
    const edge025 = await migrationsBefore(join(root, 'edge025'), '026');
    await withSyncDatabases(
      async (ctx) => {
        const { pool, schema } = ctx.edge;
        const day = await unpaidDay(ctx);
        // The kitchen login that provisionKdsStations grants the six stations to (synthetic).
        await pool.query(
          "INSERT INTO local_staff_passwords(staff_id,branch_id,login,salt,verifier) VALUES($1,$2,'kitchen',$3,$4)",
          [day.cook.staff_id, ctx.branch, 'a'.repeat(64), 'b'.repeat(64)],
        );
        const runtime = await loginRole(ctx, (role) =>
          applyEdgeRuntimeGrants(pool, role, { schema, fulfillment: true }),
        );
        const fulfillment = await loginRole(ctx, (role) =>
          pool.query(fulfillmentWorkerGrants(role, schema, { restoreFence: true })),
        );
        const posSync = await loginRole(ctx, (role) =>
          pool.query(posSyncWorkerGrants(role, schema)),
        );
        const kdsRoles = { runtimeRole: runtime.role, workerRoles: [fulfillment.role] };
        try {
          // 027 only after the reviewed 026.
          await assert.rejects(
            runKds(ctx, { mode: 'inspect', ...kdsRoles }),
            /Expected unchanged schema026 and only reviewed migration027/,
          );
          await run(ctx, { mode: 'apply', runtimeRole: runtime.role, workerRole: posSync.role });
          const ledger026 = await ledger(pool);
          // A runtime package before KDS-2, other 027 bytes and a connected service are refused.
          await assert.rejects(
            runKds(ctx, {
              mode: 'apply',
              ...kdsRoles,
              derive: () => {
                throw new Error('ROUTING_UNRESOLVED');
              },
            }),
            /KDS-2 routing rule/,
          );
          const tampered = join(root, 'tampered027');
          await migrationsBefore(tampered, '028');
          await appendFile(join(tampered, 'db/edge/migrations', KDS_MIGRATION), '\n-- x\n');
          await assert.rejects(
            runKds(ctx, { mode: 'apply', ...kdsRoles, appRoot: tampered }),
            /Expected reviewed migrations 001-026 and the reviewed migration027/,
          );
          await fulfillment.open().query('SELECT 1');
          await assert.rejects(
            runKds(ctx, { mode: 'apply', ...kdsRoles }),
            /Edge services must be stopped/,
          );
          await fulfillment.close();
          assert.deepEqual(await ledger(pool), ledger026);

          const inspected = await runKds(ctx, { mode: 'inspect', ...kdsRoles });
          assert.equal(inspected.migrations, 26);
          assert.equal(inspected.applied, false);
          const before = await stateRows(pool);
          const applied = await runKds(ctx, { mode: 'apply', ...kdsRoles });
          assert.equal(applied.fingerprint, inspected.fingerprint);
          assert.equal(applied.migrations, 27);
          assert.deepEqual(applied.kdsGrantedTo, [fulfillment.role, runtime.role].sort());
          assert.equal(applied.stations, 6);
          assert.equal(applied.stationsAdded, 6);
          assert.equal(applied.kitchenGrantsAdded, 6);
          assert.equal(applied.kitchenStaffId, day.cook.staff_id);
          assert.equal(applied.layoutEnabled, false);
          assert.deepEqual(await ledger(pool), [
            ...ledger026,
            { version: KDS_MIGRATION, checksum: KDS_SHA256 },
          ]);
          assert.deepEqual(await stateRows(pool), before);
          assert.equal(
            (await assertKdsRuntimePrivileges(pool, runtime.role, schema)).verified,
            true,
          );
          assert.equal(
            (await assertKdsWorkerPrivileges(pool, fulfillment.role, schema)).verified,
            true,
          );
          assert.deepEqual(
            (await kdsTableGrantees(pool, schema)).sort(),
            [fulfillment.role, runtime.role].sort(),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM pg_tables WHERE schemaname=$1 AND tablename=ANY($2)',
                [schema, KDS_TABLES],
              )
            ).rows[0].n,
            5,
          );
          // Off: the worker reads the switch (cloud admission) but cannot change it; the
          // installed runtime keeps today's unpaid kitchen flow on the old stations.
          const worker = fulfillment.open();
          assert.deepEqual((await worker.query('SELECT layout_enabled FROM kds_settings')).rows, [
            { layout_enabled: false },
          ]);
          await assert.rejects(
            worker.query('UPDATE kds_settings SET layout_enabled=true'),
            (error) => error.code === '42501',
          );
          await fulfillment.close();
          assert.equal((await day.order(runtime.open())).fulfillment.state, 'accepted');
          await runtime.close();

          // A repeat never reapplies; inspect proves the installed state and refuses a worker
          // without its KDS rights (cloud orders would stay on the old stations).
          await assert.rejects(runKds(ctx, { mode: 'apply', ...kdsRoles }), /already applied/);
          const verified = await runKds(ctx, { mode: 'inspect', ...kdsRoles });
          assert.equal(verified.applied, true);
          assert.equal(verified.stations, 6);
          assert.equal(verified.layoutEnabled, false);
          await pool.query(`REVOKE SELECT ON kds_layouts FROM ${fulfillment.role}`);
          await assert.rejects(
            runKds(ctx, { mode: 'inspect', ...kdsRoles }),
            /KDS table privileges differ: kds_layouts/,
          );
          await pool.query(`GRANT SELECT ON kds_layouts TO ${fulfillment.role}`);
          // A runtime grant reset on 027 keeps the reviewed KDS set (edge-runtime-grants.mjs).
          await applyEdgeRuntimeGrants(pool, runtime.role, { schema, fulfillment: true });
          assert.equal((await runKds(ctx, { mode: 'inspect', ...kdsRoles })).applied, true);
          // The 026 tool still verifies its own state on 027.
          assert.equal(
            (
              await run(ctx, {
                mode: 'inspect',
                runtimeRole: runtime.role,
                workerRole: posSync.role,
              })
            ).applied,
            true,
          );
        } finally {
          await posSync.drop();
          await fulfillment.drop();
          await runtime.drop();
        }
      },
      { edgeMigrationDirectory: edge025 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
