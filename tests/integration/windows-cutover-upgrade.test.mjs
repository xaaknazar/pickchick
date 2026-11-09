import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createPool } from '@pickchick/database';
import { applyMenu, publishMenu } from '@pickchick/menu-sync';
import {
  cancelLocalOrder,
  createLocalOrder,
  createQuote,
  openCashShift,
  provisionStaff,
  readPosConfig,
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
  CLI_MODES,
  DESK_NUMBER_MIGRATION,
  DESK_NUMBER_PREVIOUS,
  DESK_NUMBER_SHA256,
  FENCE_QUEUES_023,
  FENCE_QUEUES_026,
  POS_SALES_MIGRATION,
  POS_SALES_SHA256,
  deskNumberMigration,
  posSalesMigration,
} from '../../infra/windows/pos-sales-upgrade-db.mjs';
import { setDeskNumber } from '../../scripts/pos-sales-setup.mjs';
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
import {
  BACKUP_ROLE,
  backupLayout,
  parseBackupKey,
  readEncryptedArchive,
  runEdgeBackup,
} from '../../infra/windows/edge-backup-lib.mjs';
import {
  assertBackupPrivileges,
  ensureBackupRole,
  grantBackupAccess,
  prepareCredential,
  prepareKey,
  readBackupRole,
} from '../../infra/windows/edge-backup-setup.mjs';
import { compareRestoredDatabase } from '../../infra/windows/edge-backup-restore.mjs';
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
  return { order, live, cook, cashier };
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
const runDesk = async (ctx, options) => {
  const client = await ctx.edge.pool.connect();
  try {
    return await deskNumberMigration(client, {
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
          // #278: the runtime grant reset refuses the live role after 026 and changes nothing.
          await assert.rejects(
            applyEdgeRuntimeGrants(pool, runtime.role, { schema, fulfillment: true }),
            /Live runtime role/,
          );
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
          // #278: the runtime grant reset refuses the live role on 027 and changes nothing.
          await assert.rejects(
            applyEdgeRuntimeGrants(pool, runtime.role, { schema, fulfillment: true }),
            /Live runtime role/,
          );
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

// ------------------------------------------------------------- edge 028: the desk number ----
// CR pos-7 section 2 p.1 (lead decision 07.11 (1)): pos-sales-upgrade-db.mjs inspect-028 and
// apply-028 in window C4 right after kds-upgrade-db.mjs (027), on the same populated edge.
test('pos-sales-upgrade-db 028: the desk number after the 026 and 027 tools on a populated edge - one nullable column, nothing else changes, the runtime reads it and cannot write it, repeat refused', async () => {
  // The 027 that 028 follows is the one the KDS tool applies (CR kds-1); 028 is the CR pos-7 file.
  assert.deepEqual(DESK_NUMBER_PREVIOUS, { version: KDS_MIGRATION, checksum: KDS_SHA256 });
  assert.equal(digest(await readFile(join(edgeDir, DESK_NUMBER_MIGRATION))), DESK_NUMBER_SHA256);
  assert.deepEqual(Object.keys(CLI_MODES), ['inspect', 'apply', 'inspect-028', 'apply-028']);
  const root = await mkdtemp(join(tmpdir(), 'pickchick-cutover-028-'));
  try {
    const edge025 = await migrationsBefore(join(root, 'edge025'), '026');
    await withSyncDatabases(
      async (ctx) => {
        const { pool, schema } = ctx.edge;
        const day = await unpaidDay(ctx);
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
        const desk = { runtimeRole: runtime.role };
        const terminals = async () =>
          (
            await pool.query('SELECT to_jsonb(t) AS row FROM local_terminals t ORDER BY id')
          ).rows.map((r) => r.row);
        try {
          // 028 only after the reviewed 027: refused on 025 and on 026.
          await assert.rejects(
            runDesk(ctx, { mode: 'inspect', ...desk }),
            /Expected unchanged schema027 and only reviewed migration028/,
          );
          await run(ctx, { mode: 'apply', runtimeRole: runtime.role, workerRole: posSync.role });
          await assert.rejects(
            runDesk(ctx, { mode: 'inspect', ...desk }),
            /Expected unchanged schema027 and only reviewed migration028/,
          );
          await runKds(ctx, {
            mode: 'apply',
            runtimeRole: runtime.role,
            workerRoles: [fulfillment.role],
          });
          const ledger027 = await ledger(pool);
          assert.equal(ledger027.length, 27);
          // An app root without 028 or with other 028 bytes, and a connected service, are refused.
          const without = join(root, 'without028');
          await migrationsBefore(without, '028');
          await assert.rejects(
            runDesk(ctx, { mode: 'apply', ...desk, appRoot: without }),
            /Expected reviewed migrations 001-027 and the reviewed migration028/,
          );
          const tampered = join(root, 'tampered028');
          await migrationsBefore(tampered, '029');
          await appendFile(join(tampered, 'db/edge/migrations', DESK_NUMBER_MIGRATION), '\n-- x\n');
          await assert.rejects(
            runDesk(ctx, { mode: 'apply', ...desk, appRoot: tampered }),
            /Expected reviewed migrations 001-027 and the reviewed migration028/,
          );
          await posSync.open().query('SELECT 1');
          await assert.rejects(
            runDesk(ctx, { mode: 'apply', ...desk }),
            /Edge services must be stopped/,
          );
          await posSync.close();
          // GET pos/config reads the whole row: a runtime without the table SELECT (or one that
          // could write a new column) is refused before anything changes.
          await pool.query(`REVOKE SELECT ON local_terminals FROM ${runtime.role}`);
          await assert.rejects(
            runDesk(ctx, { mode: 'inspect', ...desk }),
            /Runtime role cannot read the desk number/,
          );
          await pool.query(`GRANT SELECT ON local_terminals TO ${runtime.role}`);
          await pool.query(`GRANT INSERT ON local_terminals TO ${runtime.role}`);
          await assert.rejects(
            runDesk(ctx, { mode: 'apply', ...desk }),
            /Runtime role can write the desk number/,
          );
          await pool.query(`REVOKE INSERT ON local_terminals FROM ${runtime.role}`);
          assert.deepEqual(await ledger(pool), ledger027);

          const inspected = await runDesk(ctx, { mode: 'inspect', ...desk });
          assert.deepEqual(
            [
              inspected.applied,
              inspected.migrations,
              inspected.deskNumbers,
              inspected.runtimeRolePresent,
              inspected.runtimeReadsDeskNumber,
            ],
            [false, 27, 0, true, true],
          );
          const before = await stateRows(pool);
          const terminalsBefore = await terminals();
          assert.ok(terminalsBefore.length >= 2);
          assert.ok(terminalsBefore.every((row) => !('desk_number' in row)));
          const applied = await runDesk(ctx, { mode: 'apply', ...desk });
          assert.deepEqual(applied, {
            mode: 'apply',
            migration: DESK_NUMBER_MIGRATION,
            migrations: 28,
            applied: true,
            runtimeRolePresent: true,
            runtimeReadsDeskNumber: true,
            deskNumbers: 0,
            dataPreserved: true,
            fingerprint: inspected.fingerprint,
          });
          assert.deepEqual(await ledger(pool), [
            ...ledger027,
            { version: DESK_NUMBER_MIGRATION, checksum: DESK_NUMBER_SHA256 },
          ]);
          assert.deepEqual(await stateRows(pool), before);
          // Every terminal row is the same plus desk_number null (off: no desk has a number).
          assert.deepEqual(
            await terminals(),
            terminalsBefore.map((row) => ({ ...row, desk_number: null })),
          );

          // The runtime reads the column and cannot write it; today's unpaid flow goes on and
          // GET pos/config answers no number until the operator sets one (CR pos-7 section 3).
          const reader = runtime.open();
          assert.equal(
            (
              await reader.query(
                'SELECT count(*)::int AS n FROM local_terminals WHERE desk_number IS NULL',
              )
            ).rows[0].n,
            terminalsBefore.length,
          );
          await assert.rejects(
            reader.query('UPDATE local_terminals SET desk_number=1'),
            (error) => error.code === '42501',
          );
          assert.equal((await day.order(reader)).fulfillment.state, 'accepted');
          assert.equal(
            (await readPosConfig(reader, ctx.branch, staffAuth(day.cashier))).desk_number,
            null,
          );
          const numbered = await setDeskNumber(pool, ctx.branch, {
            terminal_id: day.cashier.terminal_id,
            desk_number: 1,
            reason: 'Касса 1 у входа',
          });
          assert.equal(numbered.changes.length, 1);
          assert.equal(
            (await readPosConfig(reader, ctx.branch, staffAuth(day.cashier))).desk_number,
            1,
          );
          await runtime.close();

          // A repeat never reapplies; inspect proves the installed objects and the runtime read.
          await assert.rejects(
            runDesk(ctx, { mode: 'apply', ...desk }),
            /Migration028 is already applied; nothing changed/,
          );
          const verified = await runDesk(ctx, { mode: 'inspect', ...desk });
          assert.deepEqual(
            [
              verified.applied,
              verified.migrations,
              verified.deskNumbers,
              verified.runtimeReadsDeskNumber,
              verified.fingerprint,
            ],
            [true, 28, 1, true, null],
          );
          // #278: the runtime grant reset refuses the live role on 028; the read stays, no write.
          await assert.rejects(
            applyEdgeRuntimeGrants(pool, runtime.role, { schema, fulfillment: true }),
            /Live runtime role/,
          );
          assert.equal(
            (await runDesk(ctx, { mode: 'inspect', ...desk })).runtimeReadsDeskNumber,
            true,
          );
          await pool.query(`GRANT UPDATE(desk_number) ON local_terminals TO ${runtime.role}`);
          await assert.rejects(
            runDesk(ctx, { mode: 'inspect', ...desk }),
            /Runtime role can write the desk number/,
          );
          await pool.query(`REVOKE UPDATE(desk_number) ON local_terminals FROM ${runtime.role}`);
          // A missing guard is found by inspect.
          await pool.query('DROP TRIGGER local_terminal_desk_number_guard ON local_terminals');
          await assert.rejects(
            runDesk(ctx, { mode: 'inspect', ...desk }),
            /Desk number objects differ from migration028/,
          );
          await pool.query(
            'CREATE TRIGGER local_terminal_desk_number_guard BEFORE INSERT OR UPDATE OF desk_number ON local_terminals FOR EACH ROW EXECUTE FUNCTION guard_local_terminal_desk_number()',
          );
          assert.equal((await runDesk(ctx, { mode: 'inspect', ...desk })).applied, true);
          // The 026 and 027 tools still verify their own state on 028.
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
          assert.equal(
            (
              await runKds(ctx, {
                mode: 'inspect',
                runtimeRole: runtime.role,
                workerRoles: [fulfillment.role],
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

test('pos-sales-upgrade-db 028 refuses a ledger that is not exactly 001-027 and a 028 without its ledger row, and works without an installed runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-cutover-028-ledger-'));
  try {
    const edge027 = await migrationsBefore(join(root, 'edge027'), '028');
    await withSyncDatabases(
      async (ctx) => {
        const { pool } = ctx.edge;
        const absent = { runtimeRole: 'cut_absent_runtime' };
        await assert.rejects(
          runDesk(ctx, { mode: 'inspect', ...absent, branchId: randomUUID() }),
          /Branch differs/,
        );
        // Another 027 checksum in the ledger is refused, nothing changes.
        await pool.query('UPDATE schema_migrations SET checksum=$1 WHERE version=$2', [
          '0'.repeat(64),
          KDS_MIGRATION,
        ]);
        await assert.rejects(
          runDesk(ctx, { mode: 'apply', ...absent }),
          /Expected unchanged schema027 and only reviewed migration028/,
        );
        await pool.query('UPDATE schema_migrations SET checksum=$1 WHERE version=$2', [
          KDS_SHA256,
          KDS_MIGRATION,
        ]);
        const inspected = await runDesk(ctx, { mode: 'inspect', ...absent });
        assert.deepEqual(
          [
            inspected.applied,
            inspected.migrations,
            inspected.runtimeRolePresent,
            inspected.runtimeReadsDeskNumber,
          ],
          [false, 27, false, null],
        );
        const applied = await runDesk(ctx, { mode: 'apply', ...absent });
        assert.deepEqual(
          [
            applied.applied,
            applied.migrations,
            applied.deskNumbers,
            applied.runtimeReadsDeskNumber,
          ],
          [true, 28, 0, null],
        );
        assert.equal(applied.fingerprint, inspected.fingerprint);
        // 028 objects without their ledger row (applied by hand) are never applied again.
        await pool.query('DELETE FROM schema_migrations WHERE version=$1', [DESK_NUMBER_MIGRATION]);
        await assert.rejects(
          runDesk(ctx, { mode: 'apply', ...absent }),
          /Desk number objects already exist/,
        );
      },
      { edgeMigrationDirectory: edge027 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------ C4 on a restored copy of the 025 edge ----
// Contracts 6.2 step 3 and 7.3 (integration): window C4 takes a verified backup copy before each
// step (schema025, schema026, schema027, schema028 by the reviewed ledger of
// native-edge-backup-ledger.json).
// Here the schema025 copy of a populated edge is restored into a new database and the guarded
// steps 026, 027 and 028 run on that copy with the installed logins; each result is copied again
// and restored.
// Needs pg_dump/pg_restore of the server's major version (EDGE_BACKUP_TEST_PG_BIN or the
// distribution's directory); without them the test is skipped and says so.
const pinnedLedger = JSON.parse(
  await readFile(new URL('../../infra/windows/native-edge-backup-ledger.json', import.meta.url)),
);
const exec = promisify(execFile);

async function pgTools(pool) {
  const major = Math.floor(
    Number((await pool.query("SELECT current_setting('server_version_num') AS v")).rows[0].v) /
      10000,
  );
  const dir = process.env.EDGE_BACKUP_TEST_PG_BIN ?? `/usr/lib/postgresql/${major}/bin`;
  return ['pg_dump', 'pg_restore'].every((tool) => existsSync(join(dir, tool))) ? dir : null;
}
async function dropBackupRole(admin) {
  if (await readBackupRole(admin)) {
    await admin.query(`DROP OWNED BY ${BACKUP_ROLE}`);
    await admin.query(`DROP ROLE ${BACKUP_ROLE}`);
  }
}
/** One connection as `user` to `databaseUrl` (any database of the cluster), pg Client shaped. */
async function connectAs(databaseUrl, user, password) {
  const url = new URL(databaseUrl);
  url.username = user;
  url.password = password;
  url.search = '';
  const pool = createPool(url.toString(), 1);
  const client = await pool.connect().catch(async (error) => {
    await pool.end();
    throw error;
  });
  return {
    query: (...args) => client.query(...args),
    end: async () => {
      client.release();
      await pool.end();
    },
  };
}

/**
 * The scheduled backup of edge-backup-task.mjs against one database of the test cluster: the
 * dedicated read-only role, the key and credential files, the real pg_dump/pg_restore.
 */
async function backupStand(ctx, root, bin) {
  const admin = await ctx.edge.admin.connect();
  try {
    await dropBackupRole(admin);
    const stateRoot = join(root, 'backup-state');
    const layout = backupLayout(stateRoot, posix);
    for (const dir of ['private', 'staging', 'logs', 'health'])
      await mkdir(join(stateRoot, dir), { recursive: true });
    const key = parseBackupKey(
      await prepareKey(layout.keyFile).then(() => readJson(layout.keyFile)),
    );
    const { password } = await prepareCredential(layout.credentialFile, { roleExists: false });
    await ensureBackupRole(admin, { password });
    const systemIdentifier = (
      await admin.query('SELECT system_identifier::text AS id FROM pg_control_system()')
    ).rows[0].id;
    const url = new URL(ctx.edge.config.databaseUrl);
    let copies = 0;
    /** One run on `database`; returns its status and the archive it stored. */
    const backup = async (database) => {
      await grantBackupAccess(admin, { database });
      const destination = join(root, `second-disk-${++copies}`);
      await mkdir(destination);
      const target = new URL(ctx.edge.config.databaseUrl);
      target.pathname = '/' + database;
      const { status } = await runEdgeBackup(
        {
          config: {
            branchId: ctx.branch,
            systemIdentifier,
            destination,
            retention: { hourly: 48, daily: 14 },
            timeZone: 'Asia/Almaty',
            maxAgeMinutes: 120,
            reportInHeartbeat: false,
          },
          layout,
          pinned: pinnedLedger,
          database: { host: url.hostname, port: Number(url.port), name: database },
          schema: ctx.edge.schema,
        },
        {
          connect: ({ user, password: secret }) => connectAs(target.toString(), user, secret),
          runTool: (name, args, { env, timeoutMs }) =>
            exec(join(bin, name), args, {
              env,
              timeout: timeoutMs,
              maxBuffer: 16 * 1024 * 1024,
            }).then((result) => result.stdout),
          enterMaintenance: async () => ({ release: async () => undefined }),
        },
      );
      const archive = (await readdir(destination)).find((name) => name.endsWith('.pcbak'));
      return { status, archive: archive ? join(destination, archive) : null };
    };
    /** Restores an archive into a new database of the cluster (owners and ACLs kept). */
    const restore = async (archive) => {
      const dump = join(root, `restore-${randomBytes(4).toString('hex')}.dump`);
      const read = await readEncryptedArchive({ file: archive, key, output: dump });
      const database = 'xl_copy_' + randomBytes(6).toString('hex');
      await admin.query(`CREATE DATABASE ${database}`);
      const target = new URL(ctx.edge.config.databaseUrl);
      target.pathname = '/' + database;
      target.search = '';
      await exec(
        join(bin, 'pg_restore'),
        ['--exit-on-error', '--single-transaction', '--dbname=' + target, dump],
        { env: process.env, timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
      );
      await rm(dump);
      target.searchParams.set('options', `-c search_path=${ctx.edge.schema}`);
      return { database, meta: read.meta, pool: createPool(target.toString(), 2) };
    };
    return { backup, restore, admin, password };
  } catch (error) {
    admin.release();
    throw error;
  }
}
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

test('C4 on a restored schema025 copy of a populated edge: the 026, 027 and 028 steps on the copy with exact grants, idempotent inspect, refused repeats and checksums, schema026, schema027 and schema028 copies restore', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-cutover-copy-'));
  try {
    const edge025 = await migrationsBefore(join(root, 'edge025'), '026');
    await withSyncDatabases(
      async (ctx) => {
        const bin = await pgTools(ctx.edge.pool);
        if (!bin) {
          t.skip('pg_dump/pg_restore of the server version are missing (EDGE_BACKUP_TEST_PG_BIN)');
          return;
        }
        const { pool, schema } = ctx.edge;
        const day = await unpaidDay(ctx);
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
        const pos = { runtimeRole: runtime.role, workerRole: posSync.role };
        const kds = { runtimeRole: runtime.role, workerRoles: [fulfillment.role] };
        const live = (await pool.query('SELECT current_database() AS name')).rows[0].name;
        const stand = await backupStand(ctx, root, bin);
        const copies = [];
        const tool = async (copyPool, migration, options) => {
          const client = await copyPool.connect();
          try {
            return await migration(client, {
              appRoot: repoRoot,
              branchId: ctx.branch,
              schema,
              ...options,
            });
          } finally {
            client.release();
          }
        };
        try {
          // The schema025 copy of the live edge: verified, read-only role, restorable.
          const first = await stand.backup(live);
          await assertBackupPrivileges(stand.admin, { schema, databaseDefaultsRevoked: false });
          assert.equal(first.status.state, 'ok', JSON.stringify(first.status));
          assert.equal(first.status.schema, 'schema025');
          const copy = await stand.restore(first.archive);
          copies.push(copy);
          assert.deepEqual(await compareRestoredDatabase(copy.pool, copy.meta, { schema }), []);
          const before = await stateRows(copy.pool);
          assert.deepEqual(before, await stateRows(pool));

          // A ledger that is not the reviewed 001-025 (one checksum changed) is refused by the
          // tool and by the backup alike; the copy is then put back to its reviewed bytes.
          const reviewed025 = (
            await copy.pool.query(
              "SELECT checksum FROM schema_migrations WHERE version='025_edge_kitchen_restore_review.sql'",
            )
          ).rows[0].checksum;
          await copy.pool.query(
            "UPDATE schema_migrations SET checksum=$1 WHERE version='025_edge_kitchen_restore_review.sql'",
            ['0'.repeat(64)],
          );
          await assert.rejects(
            tool(copy.pool, posSalesMigration, { mode: 'inspect', ...pos }),
            /Expected unchanged schema025 and only reviewed migration026/,
          );
          const unreviewed = await stand.backup(copy.database);
          assert.deepEqual(
            [unreviewed.status.state, unreviewed.status.error],
            ['failed', 'UNREVIEWED_SCHEMA'],
          );
          assert.equal(unreviewed.archive, null);
          await copy.pool.query(
            "UPDATE schema_migrations SET checksum=$1 WHERE version='025_edge_kitchen_restore_review.sql'",
            [reviewed025],
          );

          // 026 on the copy: inspect, apply with the installed logins, exact grants, idempotent.
          const inspected = await tool(copy.pool, posSalesMigration, { mode: 'inspect', ...pos });
          assert.deepEqual([inspected.applied, inspected.migrations], [false, 25]);
          const applied = await tool(copy.pool, posSalesMigration, { mode: 'apply', ...pos });
          assert.deepEqual(
            [applied.applied, applied.migrations, applied.fingerprint],
            [true, 26, inspected.fingerprint],
          );
          assert.deepEqual(applied.posSalesGrantedTo, [runtime.role, posSync.role].sort());
          for (const [role, privileges] of [
            [runtime.role, RUNTIME_PRIVILEGES],
            [posSync.role, WORKER_PRIVILEGES],
          ])
            assert.equal(
              (await assertPosSalesPrivileges(copy.pool, role, privileges, { schema })).verified,
              true,
            );
          assert.deepEqual(
            (await posSalesGrantees(copy.pool, { schema })).sort(),
            [runtime.role, posSync.role].sort(),
          );
          assert.deepEqual(await stateRows(copy.pool), before);
          await assert.rejects(
            tool(copy.pool, posSalesMigration, { mode: 'apply', ...pos }),
            /already applied/,
          );
          const verified = await tool(copy.pool, posSalesMigration, { mode: 'inspect', ...pos });
          assert.deepEqual(
            await tool(copy.pool, posSalesMigration, { mode: 'inspect', ...pos }),
            verified,
          );
          assert.deepEqual([verified.applied, verified.migrations], [true, 26]);
          const second = await stand.backup(copy.database);
          assert.deepEqual([second.status.state, second.status.schema], ['ok', 'schema026']);

          // 027 on the copy: refused on another 026 checksum, then exact grants, idempotent.
          await copy.pool.query(
            "UPDATE schema_migrations SET checksum=$1 WHERE version='026_edge_pos_sales.sql'",
            ['0'.repeat(64)],
          );
          await assert.rejects(
            tool(copy.pool, kdsMigration, { mode: 'inspect', ...kds }),
            /Expected unchanged schema026 and only reviewed migration027/,
          );
          await copy.pool.query(
            "UPDATE schema_migrations SET checksum=$1 WHERE version='026_edge_pos_sales.sql'",
            [POS_SALES_SHA256],
          );
          const kdsApplied = await tool(copy.pool, kdsMigration, { mode: 'apply', ...kds });
          assert.deepEqual(
            [kdsApplied.migrations, kdsApplied.stations, kdsApplied.layoutEnabled],
            [27, 6, false],
          );
          assert.equal(kdsApplied.kitchenStaffId, day.cook.staff_id);
          assert.equal(
            (await assertKdsRuntimePrivileges(copy.pool, runtime.role, schema)).verified,
            true,
          );
          assert.equal(
            (await assertKdsWorkerPrivileges(copy.pool, fulfillment.role, schema)).verified,
            true,
          );
          assert.deepEqual(
            (await kdsTableGrantees(copy.pool, schema)).sort(),
            [fulfillment.role, runtime.role].sort(),
          );
          await assert.rejects(
            tool(copy.pool, kdsMigration, { mode: 'apply', ...kds }),
            /already applied/,
          );
          const kdsVerified = await tool(copy.pool, kdsMigration, { mode: 'inspect', ...kds });
          assert.deepEqual([kdsVerified.applied, kdsVerified.migrations], [true, 27]);
          assert.deepEqual(
            await tool(copy.pool, kdsMigration, { mode: 'inspect', ...kds }),
            kdsVerified,
          );
          assert.equal(
            (await tool(copy.pool, posSalesMigration, { mode: 'inspect', ...pos })).applied,
            true,
          );
          assert.deepEqual(
            (
              await copy.pool.query(
                'SELECT version,checksum FROM schema_migrations ORDER BY version',
              )
            ).rows.slice(25),
            [
              { version: POS_SALES_MIGRATION, checksum: POS_SALES_SHA256 },
              { version: KDS_MIGRATION, checksum: KDS_SHA256 },
            ],
          );
          assert.deepEqual(await stateRows(copy.pool), before);

          // The schema027 copy is accepted by the reviewed ledger and restores to the same state.
          const third = await stand.backup(copy.database);
          assert.deepEqual([third.status.state, third.status.schema], ['ok', 'schema027']);
          const restored = await stand.restore(third.archive);
          copies.push(restored);
          assert.deepEqual(
            await compareRestoredDatabase(restored.pool, restored.meta, { schema }),
            [],
          );
          assert.equal(
            (await tool(restored.pool, kdsMigration, { mode: 'inspect', ...kds })).applied,
            true,
          );

          // 028 on the copy right after the schema027 copy (CR pos-7): refused on another 027
          // checksum, then applied off, idempotent; the schema028 copy restores to the same state.
          const desk = { runtimeRole: runtime.role };
          await copy.pool.query(
            "UPDATE schema_migrations SET checksum=$1 WHERE version='027_edge_kds_foundation.sql'",
            ['0'.repeat(64)],
          );
          await assert.rejects(
            tool(copy.pool, deskNumberMigration, { mode: 'inspect', ...desk }),
            /Expected unchanged schema027 and only reviewed migration028/,
          );
          await copy.pool.query(
            "UPDATE schema_migrations SET checksum=$1 WHERE version='027_edge_kds_foundation.sql'",
            [KDS_SHA256],
          );
          const deskApplied = await tool(copy.pool, deskNumberMigration, {
            mode: 'apply',
            ...desk,
          });
          assert.deepEqual(
            [deskApplied.migrations, deskApplied.deskNumbers, deskApplied.runtimeReadsDeskNumber],
            [28, 0, true],
          );
          await assert.rejects(
            tool(copy.pool, deskNumberMigration, { mode: 'apply', ...desk }),
            /already applied/,
          );
          assert.deepEqual(await stateRows(copy.pool), before);
          const fourth = await stand.backup(copy.database);
          assert.deepEqual([fourth.status.state, fourth.status.schema], ['ok', 'schema028']);
          const restored028 = await stand.restore(fourth.archive);
          copies.push(restored028);
          assert.deepEqual(
            await compareRestoredDatabase(restored028.pool, restored028.meta, { schema }),
            [],
          );
          const deskVerified = await tool(restored028.pool, deskNumberMigration, {
            mode: 'inspect',
            ...desk,
          });
          assert.deepEqual([deskVerified.applied, deskVerified.migrations], [true, 28]);
          for (const [migration, options] of [
            [posSalesMigration, pos],
            [kdsMigration, kds],
          ])
            assert.equal(
              (await tool(restored028.pool, migration, { mode: 'inspect', ...options })).applied,
              true,
            );

          // The live edge is untouched: still the reviewed 025, the rollback point of C4, and
          // today's runtime keeps working on it.
          assert.equal((await run(ctx, { mode: 'inspect', ...pos })).applied, false);
          assert.deepEqual(await stateRows(pool), before);
          assert.equal((await day.order(runtime.open())).fulfillment.state, 'accepted');
          await runtime.close();
        } finally {
          for (const copy of copies) {
            await copy.pool.end();
            await stand.admin.query(`DROP DATABASE ${copy.database} WITH (FORCE)`);
          }
          await dropBackupRole(stand.admin);
          stand.admin.release();
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
