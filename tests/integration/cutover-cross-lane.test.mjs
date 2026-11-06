// Cutover 19.11.2026, integration (contracts 7.3 "integration"; CR kds-8 section 2, CR client-3
// section 3, CR client-4 section 5, CR cloud-2 section 5). One cashier edge goes through window
// C4 (025 -> 026 -> 027) with the guarded Windows tools and its installed runtime, POS sync and
// FulfillmentWorker logins; the operator then switches the KDS layout and paid POS sales on with
// the real operator commands, and a paid day runs through the real edge HTTP routes of the cash
// desk and the kitchen screens: the real local-pos.ts admission with buildKitchenPlan (not the
// seamCashierPort stub of the kds lane), the cascade from the tables, the courier handover. Every
// request passes the LAN gateway profile of its client. Every event of order_commercial, the POS
// kitchen stream, cashier reports and posSales reaches the new cloud (receivePosOrder,
// receivePosKitchen, receiveCashierReports, receivePosSales). A twin desk proves that with every
// flag off the old clients get byte-identical answers and stream payloads after the upgrade.
// Synthetic data only: menu, staff, PIN, order and receipt numbers are made up.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPool, transaction } from '@pickchick/database';
import { createApi } from '@pickchick/api';
import { createEdge } from '@pickchick/edge';
import { applyMenu, hashJson, provisionDevice, publishMenu } from '@pickchick/menu-sync';
import { provisionStaff, setOrdering, setStaffPin } from '@pickchick/local-orders';
import {
  EdgeFulfillment,
  digest,
  grantStation,
  kdsStationId,
  provisionFulfillment,
} from '@pickchick/edge-fulfillment';
import {
  CashShiftCurrentSchema,
  CashShiftSchema,
  ErrorSchema,
  FulfillmentKitchenSchema,
  FulfillmentOrderSchema,
  ManagerApprovalSchema,
  PosConfigSchema,
  PosFiscalPendingSchema,
  PosPaymentMethodSchema,
  PosSaleResultSchema,
  PosSaleSchema,
  PosShiftReportSchema,
} from '@pickchick/contracts';
import {
  createPosSalesSchedule,
  parseEvent,
  parseKitchenEvent,
  parsePosSaleBatch,
  provisionCloudPosSync,
  provisionEdgePosSync,
  receivePosKitchen,
  receivePosOrder,
  receivePosSales,
  syncPosKitchenOnce,
  syncPosOrdersOnce,
  syncPosSalesOnce,
} from '@pickchick/pos-order-sync';
import {
  CashierReportReceiptSchema,
  CashierReportsSchema,
  acknowledgeCashierReports,
  pendingCashierReports,
  receiveCashierReports,
} from '../../packages/fulfillment-transport/dist/cashier-reports.js';
import { TransportEdgeEventSchema } from '../../packages/fulfillment-transport/dist/index.js';
import { assertStrictEvents } from '../../packages/edge-fulfillment/tests/kds-fixture.mjs';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';
import { fulfillmentWorkerGrants } from '../../infra/windows/fulfillment-worker-grants.mjs';
import { posSyncWorkerGrants } from '../../infra/windows/pos-sync-worker-grants.mjs';
import {
  RUNTIME_PRIVILEGES,
  WORKER_PRIVILEGES,
  assertPosSalesPrivileges,
} from '../../infra/windows/pos-sales-grants.mjs';
import {
  assertKdsRuntimePrivileges,
  assertKdsWorkerPrivileges,
} from '../../infra/windows/kds-grants.mjs';
import { posSalesMigration } from '../../infra/windows/pos-sales-upgrade-db.mjs';
import { kdsMigration } from '../../infra/windows/kds-upgrade-db.mjs';
import {
  applyKdsLayout,
  buildKdsLayout,
  setKdsLayoutEnabled,
} from '../../infra/windows/kds-switch.mjs';
import { PROFILES } from '../../infra/windows/lan-route-profiles.mjs';
import { enablePosSales, posSalesStatus } from '../../scripts/pos-sales-setup.mjs';
import { running, withSyncDatabases } from '../helpers/sync.mjs';

const PIN = '2468';
const MARKS = { numberMatched: true, courierAccepted: true, photoTaken: true };
const DESK_BUILD = 'pos-desktop-0.5.0';
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const edgeDir = join(repoRoot, 'db/edge/migrations');
const staffAuth = (credential) => ({ sessionId: credential.session_id, token: credential.token });

async function migrationsBefore(root, limit) {
  const target = join(root, 'db/edge/migrations');
  await mkdir(target, { recursive: true });
  for (const file of await readdir(edgeDir))
    if (/^\d{3}_[a-z_]+\.sql$/.test(file) && file < limit)
      await copyFile(join(edgeDir, file), join(target, file));
  return target;
}

/** A LOGIN role of the installed edge (runtime, POS sync, FulfillmentWorker) with its grants. */
async function loginRole(ctx, grant, prefix) {
  const role = prefix + randomUUID().replaceAll('-', '').slice(0, 24),
    password = randomBytes(32).toString('hex');
  await ctx.edge.admin.query(
    `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  const url = new URL(ctx.edge.config.databaseUrl);
  url.username = role;
  url.password = password;
  let pool = null;
  const open = () => (pool ??= createPool(url.toString(), 2));
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
  return { role, url: url.toString(), open, close, drop };
}

/** The installed edge service as its runtime login (edge-runtime-grants.mjs), kitchen on. */
const startEdge = (ctx, runtime) =>
  running(createEdge, {
    ...ctx.edge.config,
    databaseUrl: runtime.url,
    edgeFulfillmentEnabled: true,
    edgeDeviceId: ctx.device,
  });

/**
 * One LAN client of the edge: every request must pass its gateway profile
 * (infra/windows/lan-route-profiles.mjs) and carries only the headers the gateway forwards.
 */
function lanClient(base, profile, actor, terminal) {
  const rules = PROFILES[profile];
  return async (method, path, body) => {
    assert.ok(rules.allows(method, path), `${profile} profile refuses ${method} ${path}`);
    const headers = {
      authorization: 'Bearer ' + actor.token,
      'x-staff-session-id': actor.session_id,
    };
    if (method === 'POST' && !rules.bodyless.includes(path))
      headers['idempotency-key'] = randomUUID();
    if (terminal) headers['x-terminal-id'] = terminal;
    for (const name of Object.keys(headers)) assert.ok(rules.headers.includes(name), name);
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    return { status: response.status, text, json: text ? JSON.parse(text) : null };
  };
}
const ok = (result, status = 200) => {
  assert.equal(result.status, status, result.text);
  return result.json;
};
const refused = (result, status, code) => {
  assert.equal(result.status, status, result.text);
  // The error filter passes a code only when ErrorSchema lists it (CR pos-1, CR kds-6).
  assert.ok(ErrorSchema.shape.code.options.includes(code), code);
  assert.deepEqual(ErrorSchema.parse(result.json).code, code);
};

/** The menu of the day: a burger with aggregator prices and a hall drink, both with KDS slugs. */
function cutoverMenu(ctx) {
  const base = ctx.menu();
  const burger = {
    ...base.items[0],
    source_id: 'pick-burger',
    aggregator_prices_minor: { yandex_eda: '399000', glovo: '389000' },
  };
  const drink = {
    ...base.items[0],
    product_id: randomUUID(),
    variant_id: randomUUID(),
    source_id: 'pick-drink',
    name: { ru: 'Синтетический напиток', kk: 'Синтетикалық сусын' },
    price_minor: '60000',
  };
  return { release: { ...base, items: [burger, drink] }, burger, drink };
}

/**
 * A cashier edge on 025 as it stands before C4: menu, one cash desk (cashier and shift manager
 * with a PIN), a cook with the kitchen login, the old prep and assembly stations, unpaid mode,
 * POS sync on both sides and today's installed logins with today's grants.
 */
async function edge025(ctx) {
  const edge = ctx.edge.pool,
    schema = ctx.edge.schema;
  const menu = cutoverMenu(ctx);
  await applyMenu(edge, ctx.branch, await publishMenu(ctx.cloud.pool, menu.release));
  const person = (role, terminal = randomUUID()) => ({
    staff_id: randomUUID(),
    terminal_id: terminal,
    name: 'Синтетический сотрудник',
    role,
  });
  const cashier = await provisionStaff(edge, ctx.branch, person('cashier'));
  const managerSetup = person('shift_manager', cashier.terminal_id);
  // Enrolling a PIN revokes the bootstrap session; the desk then gets a fresh one.
  await setStaffPin(
    edge,
    ctx.branch,
    staffAuth(await provisionStaff(edge, ctx.branch, managerSetup)),
    PIN,
  );
  const manager = await provisionStaff(edge, ctx.branch, managerSetup);
  const cook = await provisionStaff(edge, ctx.branch, person('kitchen'));
  // The kitchen login that provisionKdsStations (027) grants the six stations to.
  await edge.query(
    "INSERT INTO local_staff_passwords(staff_id,branch_id,login,salt,verifier) VALUES($1,$2,'kitchen',$3,$4)",
    [cook.staff_id, ctx.branch, 'a'.repeat(64), 'b'.repeat(64)],
  );
  const prep = '00000000-0000-4000-8000-0000000000a1',
    assembly = '00000000-0000-4000-8000-0000000000a2';
  // Cashier lines name the menu ids, cloud lines the catalog slugs (kds-plan.ts).
  const route = (productId, kind) => ({
    productId,
    stationId: kind === 'prep' ? prep : assembly,
    kind,
  });
  // The fulfillment transport scope of this edge (the cloud admission checks it, setup.ts).
  const kitchenScope = {
    organizationId: ctx.org,
    branchId: ctx.branch,
    deviceId: ctx.device,
    producerId: randomUUID(),
  };
  await provisionFulfillment(edge, {
    ...kitchenScope,
    stations: [
      { id: prep, kind: 'prep', name: 'Synthetic prep' },
      { id: assembly, kind: 'assembly', name: 'Synthetic assembly' },
    ],
    routing: {
      version: 1,
      assemblyStationId: assembly,
      routes: [
        route(menu.burger.product_id, 'prep'),
        route('pick-burger', 'prep'),
        route(menu.drink.product_id, 'assembly_item'),
        route('pick-drink', 'assembly_item'),
      ],
    },
  });
  await grantStation(edge, ctx.branch, cook.staff_id, prep);
  await grantStation(edge, ctx.branch, cook.staff_id, assembly);
  await setOrdering(edge, ctx.branch, staffAuth(manager), randomUUID(), true, {
    expected_version: 1,
  });
  await edge.query("UPDATE branch_config SET pos_service_mode='unpaid_service' WHERE id=$1", [
    ctx.branch,
  ]);
  const identity = await provisionDevice(ctx.cloud.pool, ctx.device);
  const scope = await provisionEdgePosSync(edge, {
    organizationId: ctx.org,
    branchId: ctx.branch,
    deviceId: ctx.device,
  });
  await provisionCloudPosSync(ctx.cloud.pool, scope);
  const runtime = await loginRole(
    ctx,
    (role) => applyEdgeRuntimeGrants(edge, role, { schema, fulfillment: true }),
    'xl_rt_',
  );
  const fulfillment = await loginRole(
    ctx,
    (role) => edge.query(fulfillmentWorkerGrants(role, schema, { restoreFence: true })),
    'xl_ff_',
  );
  const posSync = await loginRole(
    ctx,
    (role) => edge.query(posSyncWorkerGrants(role, schema)),
    'xl_ps_',
  );
  return {
    ...menu,
    cashier,
    manager,
    cook,
    prep,
    assembly,
    scope,
    kitchenScope,
    identity,
    runtime,
    fulfillment,
    posSync,
    drop: async () => {
      await posSync.drop();
      await fulfillment.drop();
      await runtime.drop();
    },
  };
}

/** Window C4 (contracts 6.2 step 3): every edge service stopped, 026 and then 027 by the tools. */
async function windowC4(ctx, desk) {
  for (const login of [desk.runtime, desk.fulfillment, desk.posSync]) await login.close();
  const tool = async (migration, options) => {
    const client = await ctx.edge.pool.connect();
    try {
      return await migration(client, {
        appRoot: repoRoot,
        branchId: ctx.branch,
        schema: ctx.edge.schema,
        ...options,
      });
    } finally {
      client.release();
    }
  };
  const pos = { runtimeRole: desk.runtime.role, workerRole: desk.posSync.role };
  const kds = { runtimeRole: desk.runtime.role, workerRoles: [desk.fulfillment.role] };
  assert.equal((await tool(posSalesMigration, { mode: 'inspect', ...pos })).applied, false);
  const sales = await tool(posSalesMigration, { mode: 'apply', ...pos });
  assert.deepEqual(
    [sales.migrations, sales.serviceMode, sales.posSalesGrantedTo],
    [26, 'unpaid_service', [desk.runtime.role, desk.posSync.role].sort()],
  );
  assert.equal((await tool(kdsMigration, { mode: 'inspect', ...kds })).applied, false);
  const kitchen = await tool(kdsMigration, { mode: 'apply', ...kds });
  assert.deepEqual(
    [kitchen.migrations, kitchen.stations, kitchen.kitchenStaffId, kitchen.layoutEnabled],
    [27, 6, desk.cook.staff_id, false],
  );
  // Contracts 5.9: exactly the reviewed privileges of each installed login.
  const options = { schema: ctx.edge.schema };
  const pool = ctx.edge.pool;
  await assertPosSalesPrivileges(pool, desk.runtime.role, RUNTIME_PRIVILEGES, options);
  await assertPosSalesPrivileges(pool, desk.posSync.role, WORKER_PRIVILEGES, options);
  await assertKdsRuntimePrivileges(pool, desk.runtime.role, ctx.edge.schema);
  await assertKdsWorkerPrivileges(pool, desk.fulfillment.role, ctx.edge.schema);
}

/** Drains one old POS stream (order_commercial or kitchen) through the cloud API. */
async function drain(sync, pool, options) {
  for (let i = 0; i < 300; i++) {
    const result = await sync(pool, options);
    if (result.state === 'idle') return;
    assert.equal(result.state, 'delivered', JSON.stringify(result));
  }
  assert.fail('Bounded stream drain exceeded');
}
/** The posSales loop of the POS sync worker until the outbox is empty (contracts 5.6). */
async function drainPosSales(pool, options, schedule, io = {}) {
  const states = [];
  for (let i = 0; i < 50; i++) {
    const result = await syncPosSalesOnce(pool, options, schedule, io);
    states.push(result.state);
    if (result.state === 'idle') return states;
    assert.ok(['delivered', 'probed'].includes(result.state), JSON.stringify(result));
  }
  assert.fail('Bounded posSales drain exceeded');
}
/** The edge reader and cloud receiver of the cashier-report pull extension, without network. */
async function drainCashierReports(ctx) {
  const received = [];
  for (let i = 0; i < 20; i++) {
    const reports = await pendingCashierReports(ctx.edge.pool, ctx.branch);
    if (!reports.length) break;
    const parsed = CashierReportsSchema.parse(reports);
    assert.deepEqual(parsed, reports);
    const receipt = CashierReportReceiptSchema.parse(
      await transaction(ctx.cloud.pool, (client) =>
        receiveCashierReports(client, ctx.branch, ctx.device, parsed),
      ),
    );
    await acknowledgeCashierReports(ctx.edge.pool, ctx.branch, parsed, receipt);
    received.push(...parsed);
  }
  assert.deepEqual(
    (
      await ctx.edge.pool.query(
        `SELECT count(*) FILTER(WHERE acknowledged_at IS NULL)::int pending,
         count(*) FILTER(WHERE last_error IS NOT NULL)::int failed FROM cashier_report_outbox`,
      )
    ).rows[0],
    { pending: 0, failed: 0 },
  );
  return received;
}
/** The order_commercial envelopes exactly as the POS sync worker sends them (worker.ts). */
const commercialEvents = async (pool) =>
  (
    await pool.query(
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
/** The POS kitchen envelopes exactly as the POS sync worker sends them (kitchen-worker.ts). */
const kitchenEvents = async (pool, producerId) =>
  (
    await pool.query(
      "SELECT * FROM fulfillment_outbox WHERE payload->>'commercialOwner'='edge_pos' ORDER BY sequence",
    )
  ).rows.map((row) =>
    parseKitchenEvent({
      event_id: row.event_id,
      producer_id: producerId,
      producer_sequence: row.sequence,
      aggregate_type: row.aggregate_type,
      aggregate_id: row.order_id,
      aggregate_version: Number(row.aggregate_version),
      event_type: row.event_type,
      schema_version: 1,
      branch_id: row.branch_id,
      occurred_at: row.occurred_at.toISOString(),
      correlation_id: row.order_id,
      causation_id: null,
      payload: row.payload,
    }),
  );
/** posSales events as the sender puts them on the wire (contracts 5.6), in sequence order. */
const posSaleEvents = async (pool) =>
  (await pool.query('SELECT * FROM pos_sale_outbox ORDER BY sequence')).rows.map((row) => {
    assert.equal(row.payload_hash, hashJson(row.payload));
    return {
      event_id: row.event_id,
      branch_id: row.branch_id,
      sequence: row.sequence,
      kind: row.kind,
      occurred_at: row.occurred_at.toISOString(),
      payload: row.payload,
    };
  });
const byOrder = (rows) => Object.fromEntries(rows.map((row) => [row.order_id, row]));
const cloudRows = async (ctx, sql) => (await ctx.cloud.pool.query(sql, [ctx.branch])).rows;

/** A cloud (mobile) order as the fulfillment transport delivers it: hold, then kitchen admission. */
async function cloudOrder(ctx, desk, pool) {
  const snapshot = {
    organizationId: ctx.org,
    branchId: ctx.branch,
    legalEntityId: ctx.legal,
    customerId: randomUUID(),
    channel: 'mobile',
    serviceMode: 'takeaway',
    currency: 'KZT',
    totalMinor: '409000',
    ttlSeconds: 300,
    lines: [
      ['pick-burger', 'Синтетический бургер', '349000'],
      ['pick-drink', 'Синтетический напиток', '60000'],
    ].map(([productId, title, price]) => ({
      lineId: randomUUID(),
      productId,
      title,
      description: '',
      quantity: 1,
      unitPriceMinor: price,
      discountMinor: '0',
      grossMinor: price,
      totalMinor: price,
      taxCode: 'SYNTHETIC',
    })),
  };
  const payload = {
    orderId: randomUUID(),
    branchId: ctx.branch,
    quoteId: randomUUID(),
    quoteDigest: digest(snapshot),
    snapshot,
    owner: 'cloud',
  };
  const repo = new EdgeFulfillment(pool);
  const scope = desk.kitchenScope;
  const held = await repo.acceptCloud(scope, {
    eventId: randomUUID(),
    type: 'edge.admission_requested',
    payload,
  });
  return repo.acceptCloud(scope, {
    eventId: randomUUID(),
    type: 'edge.kitchen_admission_requested',
    payload: {
      orderId: payload.orderId,
      branchId: ctx.branch,
      reservationId: held.reservationId,
      deviceId: ctx.device,
      quoteDigest: payload.quoteDigest,
      snapshot,
      owner: 'cloud',
    },
  });
}

/**
 * Contracts 6.2 steps 6-7 with the real operator tools: the chef's KDS layout (kds-switch
 * layout-build, layout-apply, enable with the installed logins) and pos-sales-setup enable with
 * every method, once the cloud answered posSales and the desk fetched GET pos/config.
 */
async function switchOn(ctx, desk, pos) {
  const edge = ctx.edge.pool;
  const screens = {};
  for (const fn of ['breading', 'toasts', 'assembly_hall', 'assembly_delivery', 'issue']) {
    screens[fn] = randomUUID();
    await edge.query('INSERT INTO local_terminals(id,branch_id) VALUES($1,$2)', [
      screens[fn],
      ctx.branch,
    ]);
  }
  const built = await buildKdsLayout(edge, {
    branchId: ctx.branch,
    tsv: [
      'product_slug\tfunction\tunit\tcount',
      'pick-burger\ttoasts\tburger\t1',
      'pick-burger\tassembly_hall',
      'pick-burger\tassembly_delivery',
      'pick-drink\tissue',
    ].join('\n'),
    terminalsTsv: [
      'function\tterminal_id',
      ...Object.entries(screens).map(([fn, id]) => `${fn}\t${id}`),
    ].join('\n'),
  });
  assert.deepEqual(built.report.unmapped, []);
  await applyKdsLayout(edge, {
    branchId: ctx.branch,
    layout: built.layout,
    reason: 'Раскладка шефа (синтетика)',
  });
  const enabled = await setKdsLayoutEnabled(edge, {
    branchId: ctx.branch,
    enabled: true,
    reason: 'Т9 учение KDS',
    workerRoles: [desk.fulfillment.role],
    runtimeRoles: [desk.runtime.role],
  });
  assert.equal(enabled.layout_enabled, true);
  const status = await posSalesStatus(edge, ctx.branch);
  assert.deepEqual(status.blockers, []);
  // CR client-4 section 5 item 3: the operator sees the build of every cash desk.
  assert.deepEqual(
    status.cash_desks.map((d) => [d.terminal_id, d.client_version]),
    [[desk.cashier.terminal_id, DESK_BUILD]],
  );
  const methods = PosPaymentMethodSchema.options;
  const switched = await enablePosSales(edge, ctx.branch, {
    methods,
    reason: 'Т7 пробная смена',
  });
  assert.equal(switched.mode, 'pos_sale');
  const paidConfig = PosConfigSchema.parse(
    ok(await pos('GET', `/edge/v1/pos/config?client_version=${DESK_BUILD}`)),
  );
  assert.equal(paidConfig.mode, 'pos_sale');
  assert.ok(paidConfig.methods.every((method) => method.enabled));
}

test('C4 025 -> 026 -> 027, then a paid day on the KDS layout through the real cash desk and kitchen routes reaches the new cloud on all four streams', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-cross-lane-'));
  try {
    const before026 = await migrationsBefore(root, '026');
    await withSyncDatabases(
      async (ctx) => {
        const edge = ctx.edge.pool;
        const desk = await edge025(ctx);
        let cloud = await running(createApi, { ...ctx.cloud.config, posOrderSyncEnabled: true });
        let server = null;
        try {
          const options = () => ({
            enabled: true,
            branchId: ctx.branch,
            origin: cloud.url,
            identity: desk.identity,
          });
          const S = (fn) => kdsStationId(ctx.branch, fn);

          // ---- 025: today's unpaid day on the installed runtime, streams to today's cloud.
          server = await startEdge(ctx, desk.runtime);
          let pos = lanClient(server.url, 'pos', desk.cashier);
          let boss = lanClient(server.url, 'pos', desk.manager);
          let kitchen = lanClient(server.url, 'kitchen', desk.cook, desk.cook.terminal_id);
          const unpaidShift = CashShiftSchema.parse(
            ok(await boss('POST', '/edge/v1/cash-shifts', { opening_cash_minor: '100000' }), 201),
          );
          assert.equal(unpaidShift.payment_processing_available, false);
          const unpaidQuote = ok(
            await pos('POST', '/edge/v1/checkout/quotes', {
              release_id: desk.release.release_id,
              service_mode: 'takeaway',
              items: [{ variant_id: desk.burger.variant_id, quantity: 1 }],
            }),
            201,
          );
          const unpaid = ok(
            await pos('POST', '/edge/v1/orders', {
              quote_id: unpaidQuote.quote_id,
              kitchen_admission: 'unpaid',
            }),
            201,
          );
          let ticket = ok(
            await kitchen(
              'GET',
              `/edge/v1/fulfillment/orders/${unpaid.order_id}?stationId=${desk.prep}`,
            ),
          );
          for (const task of ticket.tasks) {
            const act = (body) =>
              kitchen('POST', `/edge/v1/fulfillment/orders/${unpaid.order_id}/actions`, {
                expectedVersion: ticket.version,
                ...body,
              });
            ticket = ok(
              await act({
                action: 'start_task',
                taskId: task.taskId,
                expectedTaskVersion: task.version,
              }),
            );
            ticket = ok(
              await act({
                action: 'complete_task',
                taskId: task.taskId,
                expectedTaskVersion: task.version + 1,
              }),
            );
          }
          for (const action of ['ready', 'handoff'])
            ticket = ok(
              await kitchen('POST', `/edge/v1/fulfillment/orders/${unpaid.order_id}/actions`, {
                action,
                expectedVersion: ticket.version,
              }),
            );
          assert.equal(ticket.state, 'handed_over');
          const unpaidCurrent = CashShiftCurrentSchema.parse(
            ok(await boss('GET', '/edge/v1/cash-shifts/current')),
          ).shift;
          ok(
            await boss('POST', `/edge/v1/cash-shifts/${unpaidShift.shift_id}/close`, {
              expected_version: unpaidCurrent.version,
              counted_cash_minor: unpaidCurrent.expected_cash_minor,
              reason: 'Синтетическое закрытие до С4',
            }),
          );
          // No posSales on 025: the POS sync worker's posSales loop only rechecks later.
          const salesSchedule = createPosSalesSchedule();
          assert.equal(
            (await syncPosSalesOnce(desk.posSync.open(), options(), salesSchedule)).state,
            'not_installed',
          );
          await drain(syncPosOrdersOnce, desk.posSync.open(), options());
          await drain(syncPosKitchenOnce, desk.posSync.open(), options());
          assert.ok((await drainCashierReports(ctx)).length >= 2);
          await server.app.close();
          server = null;

          // ---- C4: the guarded tools with the installed logins, exact grants (contracts 5.9).
          await windowC4(ctx, desk);

          // ---- Cloud step 5 (16.11): CLOUD_POS_SALES_SYNC_ENABLED; the edge comes back.
          await cloud.app.close();
          cloud = await running(createApi, {
            ...ctx.cloud.config,
            posOrderSyncEnabled: true,
            posSalesSyncEnabled: true,
          });
          server = await startEdge(ctx, desk.runtime);
          pos = lanClient(server.url, 'pos', desk.cashier);
          boss = lanClient(server.url, 'pos', desk.manager);
          kitchen = lanClient(server.url, 'kitchen', desk.cook, desk.cook.terminal_id);
          const salesSync = desk.posSync.open();
          assert.deepEqual(await drainPosSales(salesSync, options(), createPosSalesSchedule()), [
            'probed',
            'idle',
          ]);
          // pos-desktop 0.5.0 asks for its mode with its build (CR client-4 section 2).
          const unpaidConfig = PosConfigSchema.parse(
            ok(await pos('GET', `/edge/v1/pos/config?client_version=${DESK_BUILD}`)),
          );
          assert.equal(unpaidConfig.mode, 'unpaid_service');
          assert.ok(unpaidConfig.methods.every((method) => !method.enabled));

          // ---- Steps 6-7: the KDS layout and paid sales switched on with the operator tools.
          await switchOn(ctx, desk, pos);

          // ---- The paid day: a sales shift, five sales through POST pos/sales.
          const shift = CashShiftSchema.parse(
            ok(await boss('POST', '/edge/v1/cash-shifts', { opening_cash_minor: '500000' }), 201),
          );
          assert.equal(shift.payment_processing_available, true);
          const quote = async (items, extra = {}) =>
            ok(
              await pos('POST', '/edge/v1/checkout/quotes', {
                release_id: desk.release.release_id,
                service_mode: 'takeaway',
                items: items.map((item) => ({ variant_id: item.variant_id, quantity: 1 })),
                ...extra,
              }),
              201,
            );
          const sell = (q, extra) =>
            pos('POST', '/edge/v1/pos/sales', {
              quote_id: q.quote_id,
              service_mode_confirmed: true,
              order_repeated: true,
              ...extra,
            });
          const approve = async (action, subject) => {
            const approval = ManagerApprovalSchema.parse(
              ok(
                await pos('POST', '/edge/v1/staff/approvals', {
                  staff_id: desk.manager.staff_id,
                  pin: PIN,
                  action,
                  subject,
                }),
                201,
              ),
            );
            return { approval_id: approval.approval_id, token: approval.token };
          };
          // G: Glovo, typed in lower case from the tablet; the courier takes it at station 3.
          const glovoQuote = await quote([desk.burger], { sales_channel: 'glovo' });
          assert.equal(glovoQuote.total_minor, '389000');
          const glovo = PosSaleResultSchema.parse(
            ok(
              await sell(glovoQuote, {
                tenders: [{ method: 'aggregator_glovo', amount_minor: '389000' }],
                external_order_ref: 'g-4242',
              }),
              201,
            ),
          );
          assert.equal(glovo.sale.external_order_ref, 'G-4242');
          // The same Glovo number again: strict 409 for the cash desk (CR client-4 section 5).
          const again = await quote([desk.burger], { sales_channel: 'glovo' });
          refused(
            await sell(again, {
              tenders: [{ method: 'aggregator_glovo', amount_minor: '389000' }],
              external_order_ref: 'G-4242',
            }),
            409,
            'EXTERNAL_REF_DUPLICATE',
          );
          // H: hall, cash with change. M: mixed cash and Kaspi terminal. V: voided before start.
          const hallQuote = await quote([desk.burger, desk.drink], { service_mode: 'dine_in' });
          const hall = PosSaleResultSchema.parse(
            ok(
              await sell(hallQuote, {
                tenders: [{ method: 'cash', amount_minor: '409000' }],
                cash_tendered_minor: '500000',
              }),
              201,
            ),
          );
          assert.equal(hall.sale.change_minor, '91000');
          const mixedQuote = await quote([desk.burger, desk.drink]);
          const mixed = PosSaleResultSchema.parse(
            ok(
              await sell(mixedQuote, {
                tenders: [
                  { method: 'cash', amount_minor: '109000' },
                  { method: 'kaspi_terminal', amount_minor: '300000' },
                ],
                cash_tendered_minor: '110000',
              }),
              201,
            ),
          );
          assert.equal(mixed.sale.change_minor, '1000');
          const voidQuote = await quote([desk.burger]);
          const voided = PosSaleResultSchema.parse(
            ok(
              await sell(voidQuote, {
                tenders: [{ method: 'cash', amount_minor: '349000' }],
                cash_tendered_minor: '349000',
              }),
              201,
            ),
          );
          // C: a cloud order admitted by the FulfillmentWorker login on the same layout.
          const fromCloud = await cloudOrder(ctx, desk, desk.fulfillment.open());
          assert.equal(fromCloud.state, 'accepted');

          // Kitchen plans: real local-pos.ts admission (pos_sale) with buildKitchenPlan.
          const reservation = async (orderId) =>
            (
              await edge.query(
                `SELECT r.admission_kind,r.assembly_station_id,r.snapshot,
                   (SELECT json_agg(json_build_array(t.details->'kds'->>'function',t.station_id,t.details->'kds'->>'upstreamOf')
                     ORDER BY t.details->'kds'->>'function') FROM fulfillment_tasks t WHERE t.order_id=r.order_id) AS tasks
                 FROM fulfillment_reservations r WHERE r.order_id=$1`,
                [orderId],
              )
            ).rows[0];
          const g = await reservation(glovo.order.order_id);
          assert.deepEqual(g.snapshot.delivery, { provider: 'glovo', externalNumber: 'G-4242' });
          assert.equal(g.admission_kind, 'pos_sale');
          assert.equal(g.assembly_station_id, S('delivery_handover'));
          assert.deepEqual(g.tasks, [
            ['assembly_delivery', S('assembly_delivery'), null],
            ['toasts', S('toasts'), S('assembly_delivery')],
          ]);
          for (const sale of [hall, mixed, voided]) {
            const row = await reservation(sale.order.order_id);
            assert.equal(row.assembly_station_id, S('issue'));
            assert.equal(row.snapshot.delivery, undefined);
          }
          assert.deepEqual((await reservation(hall.order.order_id)).tasks, [
            ['assembly_hall', S('assembly_hall'), null],
            ['issue', S('issue'), null],
            ['toasts', S('toasts'), S('assembly_hall')],
          ]);
          assert.deepEqual(
            (await reservation(fromCloud.orderId)).tasks,
            (await reservation(hall.order.order_id)).tasks,
          );

          // V is voided before the kitchen starts: its KDS tasks are cancelled with it.
          const voidResult = PosSaleResultSchema.parse(
            ok(
              await pos('POST', `/edge/v1/pos/sales/${voided.order.order_id}/void`, {
                expected_version: 1,
                reason_code: 'cashier_error',
                reason: 'Синтетическая отмена',
                fiscal_sale_issued: false,
                approval: await approve('void', {
                  order_id: voided.order.order_id,
                  amount_minor: '349000',
                }),
              }),
            ),
          );
          assert.equal(voidResult.order.state, 'cancelled');
          assert.deepEqual(
            (
              await edge.query('SELECT DISTINCT state FROM fulfillment_tasks WHERE order_id=$1', [
                voided.order.order_id,
              ])
            ).rows,
            [{ state: 'cancelled' }],
          );

          // ---- Kitchen screens over HTTP (kitchen profile, the cook's terminal).
          const station = async (fn) => {
            const text = await kitchen('GET', `/edge/v1/fulfillment/kitchen?stationId=${S(fn)}`);
            ok(text);
            assert.equal(JSON.stringify(FulfillmentKitchenSchema.parse(text.json)), text.text);
            return text.json.items;
          };
          const read = async (orderId, fn) => {
            const one = await kitchen(
              'GET',
              `/edge/v1/fulfillment/orders/${orderId}?stationId=${S(fn)}`,
            );
            ok(one);
            assert.equal(JSON.stringify(FulfillmentOrderSchema.parse(one.json)), one.text);
            return one.json;
          };
          const act = async (current, body) =>
            kitchen('POST', `/edge/v1/fulfillment/orders/${current.orderId}/actions`, {
              expectedVersion: current.version,
              ...body,
            });
          const complete = async (current, fn) =>
            ok(await act(current, { action: 'complete_station', stationId: S(fn) }));
          // Table 2 shows the Glovo ticket with its number; the guest board never shows it.
          const table2 = await station('assembly_delivery');
          assert.deepEqual(table2.find((o) => o.orderId === glovo.order.order_id).delivery, {
            provider: 'glovo',
            externalNumber: 'G-4242',
          });
          let gk = await read(glovo.order.order_id, 'assembly_delivery');
          gk = await complete(gk, 'assembly_delivery');
          gk = await complete(gk, 'delivery_handover');
          assert.equal(gk.state, 'ready');
          refused(await act(gk, { action: 'handoff' }), 400, 'HANDOVER_MARKS_REQUIRED');
          gk = ok(await act(gk, { action: 'handoff', handover: MARKS }));
          assert.equal(gk.state, 'handed_over');
          assert.deepEqual(
            (
              await edge.query(
                'SELECT order_id,provider,external_number,station_id FROM delivery_handovers',
              )
            ).rows,
            [
              {
                order_id: glovo.order.order_id,
                provider: 'glovo',
                external_number: 'G-4242',
                station_id: S('delivery_handover'),
              },
            ],
          );
          // Hall, takeaway and the cloud order: station 5 starts the toast, table 1 finishes and
          // closes it (cascade), issue makes the order ready, handoff without marks.
          for (const orderId of [hall.order.order_id, mixed.order.order_id, fromCloud.orderId]) {
            let current = await read(orderId, 'toasts');
            const toast = current.tasks.find((task) => task.stationId === S('toasts'));
            assert.equal(toast.details.kds.upstreamOf, S('assembly_hall'));
            current = ok(
              await act(current, {
                action: 'start_task',
                taskId: toast.taskId,
                expectedTaskVersion: toast.version,
              }),
            );
            current = await complete(current, 'assembly_hall');
            const afterTable = await read(orderId, 'toasts');
            assert.equal(
              afterTable.tasks.find((task) => task.taskId === toast.taskId).state,
              'done',
            );
            current = await complete(current, 'issue');
            assert.equal(current.state, 'ready');
            current = ok(await act(current, { action: 'handoff' }));
            assert.equal(current.state, 'handed_over');
          }

          // ---- Refunds of M after the kitchen: over its Kaspi part is refused (strict 409).
          const kaspi = mixed.sale.tenders.find((t) => t.method === 'kaspi_terminal');
          const cash = mixed.sale.tenders.find((t) => t.method === 'cash');
          refused(
            await pos('POST', `/edge/v1/pos/sales/${mixed.order.order_id}/refunds`, {
              refund_id: randomUUID(),
              tenders: [{ tender_id: cash.tender_id, amount_minor: '109100' }],
              reason_code: 'quality',
              reason: 'Синтетический возврат сверх оплаты',
              approval: await approve('refund', {
                order_id: mixed.order.order_id,
                amount_minor: '109100',
              }),
            }),
            409,
            'REFUND_LIMIT',
          );
          const refundedSale = PosSaleSchema.parse(
            ok(
              await pos('POST', `/edge/v1/pos/sales/${mixed.order.order_id}/refunds`, {
                refund_id: randomUUID(),
                tenders: [{ tender_id: kaspi.tender_id, amount_minor: '100000' }],
                reason_code: 'quality',
                reason: 'Синтетический возврат',
                approval: await approve('refund', {
                  order_id: mixed.order.order_id,
                  amount_minor: '100000',
                }),
              }),
              201,
            ),
          );
          assert.equal(refundedSale.refundable_minor, '309000');

          // ---- Manual Webkassa: every pending receipt of the shift is recorded, then the Z.
          const pending = PosFiscalPendingSchema.parse(
            ok(await pos('GET', `/edge/v1/pos/fiscal-receipts/pending?shift_id=${shift.shift_id}`)),
          ).receipts;
          // Cash and Kaspi terminal take a manual Webkassa receipt (026 defaults); the void of a
          // sale whose receipt was never punched needs none, Glovo needs none.
          assert.deepEqual(
            pending.map((r) => [r.order_id, r.kind, r.amount_minor]),
            [
              [hall.order.order_id, 'sale', '409000'],
              [mixed.order.order_id, 'sale', '409000'],
              [mixed.order.order_id, 'refund', '100000'],
            ],
          );
          for (const [index, receipt] of pending.entries())
            ok(
              await pos('POST', `/edge/v1/pos/fiscal-receipts/${receipt.receipt_id}/record`, {
                expected_version: receipt.version,
                receipt_number: `SYN-WK-${index + 1}`,
              }),
            );
          const open = ok(await boss('GET', `/edge/v1/cash-shifts/${shift.shift_id}`));
          // 500000 + cash sales (409000 + 109000 + 349000) - cash refunds (the void, 349000).
          assert.equal(open.expected_cash_minor, '1018000');
          ok(
            await boss('POST', `/edge/v1/cash-shifts/${shift.shift_id}/close`, {
              expected_version: open.version,
              counted_cash_minor: '1018000',
              reason: 'Синтетическое закрытие',
              terminal_reported_minor: '200000',
            }),
          );
          const z = PosShiftReportSchema.parse(
            ok(await boss('GET', `/edge/v1/cash-shifts/${shift.shift_id}/z-report`)),
          );
          assert.deepEqual(
            [
              z.kind,
              z.cash_sales_minor,
              z.cash_refunds_minor,
              z.expected_cash_minor,
              z.discrepancy_minor,
              z.terminal_discrepancy_minor,
              z.orders,
              z.fiscal.pending,
            ],
            ['z', '867000', '349000', '1018000', '0', '0', { count: 4, voided_count: 1 }, 0],
          );

          // ---- Strict streams: every kitchen event (both admission paths) and posSales event.
          const strict = await assertStrictEvents(edge);
          assert.ok(strict.pos > 0 && strict.cloud > 0, JSON.stringify(strict));
          for (const row of (
            await edge.query(
              "SELECT * FROM fulfillment_outbox WHERE payload->>'commercialOwner'<>'edge_pos' ORDER BY sequence",
            )
          ).rows)
            TransportEdgeEventSchema.parse({
              schemaVersion: 1,
              eventId: row.event_id,
              sequence: String(row.sequence),
              orderId: row.order_id,
              aggregateVersion: row.aggregate_version,
              type: row.event_type,
              payload: row.payload,
            });
          const sales = await posSaleEvents(edge);
          assert.equal(
            parsePosSaleBatch({ events: sales.slice(0, 50) }).events.length,
            Math.min(50, sales.length),
          );
          assert.deepEqual([...new Set(sales.map((event) => event.kind))].sort(), [
            'fiscal',
            'refund',
            'sale',
            'shift_report',
            'void',
          ]);

          // ---- Delivery: the POS sync worker login sends posSales, order_commercial, kitchen.
          const delivered = await drainPosSales(salesSync, options(), createPosSalesSchedule());
          assert.ok(delivered.includes('delivered') && delivered.at(-1) === 'idle');
          await drain(syncPosOrdersOnce, salesSync, options());
          await drain(syncPosKitchenOnce, salesSync, options());
          const reports = await drainCashierReports(ctx);
          assert.ok(
            reports.some((r) => r.kind === 'shift' && r.payload.cash_sales_minor === '867000'),
          );
          assert.deepEqual(
            (
              await edge.query(
                `SELECT (SELECT count(*)::int FROM pos_sale_outbox WHERE acknowledged_at IS NULL) AS sales,
                   (SELECT count(*)::int FROM outbox_events WHERE aggregate_type='order_commercial' AND acknowledged_at IS NULL) AS orders`,
              )
            ).rows[0],
            { sales: 0, orders: 0 },
          );

          // The new cloud holds the day: posSales tables (073).
          const cloudSales = byOrder(
            await cloudRows(
              ctx,
              `SELECT order_id,state,sales_channel,external_order_ref,service_mode,total_minor::text,
                 change_minor::text FROM cloud_pos_sales WHERE branch_id=$1`,
            ),
          );
          assert.deepEqual(
            [glovo, hall, mixed, voided].map((sale) => {
              const row = cloudSales[sale.order.order_id];
              return [
                row.state,
                row.sales_channel,
                row.external_order_ref,
                row.service_mode,
                row.total_minor,
                row.change_minor,
              ];
            }),
            [
              ['paid', 'glovo', 'G-4242', 'takeaway', '389000', null],
              ['paid', 'hall', null, 'dine_in', '409000', '91000'],
              ['paid', 'hall', null, 'takeaway', '409000', '1000'],
              ['voided', 'hall', null, 'takeaway', '349000', '0'],
            ],
          );
          assert.deepEqual(
            await cloudRows(
              ctx,
              `SELECT t.method,t.amount_minor::text AS amount FROM cloud_pos_tenders t
               WHERE t.branch_id=$1 AND t.order_id='${mixed.order.order_id}' ORDER BY t.method`,
            ),
            [
              { method: 'cash', amount: '109000' },
              { method: 'kaspi_terminal', amount: '300000' },
            ],
          );
          assert.deepEqual(
            await cloudRows(
              ctx,
              `SELECT r.order_id,r.kind,r.amount_minor::text AS amount,
                 (SELECT json_agg(json_build_array(x.method,x.amount_minor::text)) FROM cloud_pos_refund_tenders x
                   WHERE x.refund_id=r.refund_id) AS tenders
               FROM cloud_pos_refunds r WHERE r.branch_id=$1 ORDER BY r.kind DESC`,
            ),
            [
              {
                order_id: voided.order.order_id,
                kind: 'void',
                amount: '349000',
                tenders: [['cash', '349000']],
              },
              {
                order_id: mixed.order.order_id,
                kind: 'refund',
                amount: '100000',
                tenders: [['kaspi_terminal', '100000']],
              },
            ],
          );
          assert.deepEqual(
            await cloudRows(
              ctx,
              "SELECT count(*)::int AS n FROM cloud_pos_fiscal_receipts WHERE branch_id=$1 AND state='pending'",
            ),
            [{ n: 0 }],
          );
          assert.deepEqual(
            await cloudRows(
              ctx,
              `SELECT shift_id,expected_cash_minor::text AS expected,counted_cash_minor::text AS counted,
                 discrepancy_minor::text AS discrepancy,terminal_reported_minor::text AS terminal
               FROM cloud_pos_shift_reports WHERE branch_id=$1`,
            ),
            [
              {
                shift_id: shift.shift_id,
                expected: '1018000',
                counted: '1018000',
                discrepancy: '0',
                terminal: '200000',
              },
            ],
          );
          // The old streams: commercial projection, kitchen projection, cashier reports.
          const commercial = byOrder(
            await cloudRows(
              ctx,
              'SELECT order_id,version,state,payment_state,execution_mode FROM pos_order_sync_projection WHERE branch_id=$1',
            ),
          );
          assert.deepEqual(commercial[unpaid.order_id], {
            order_id: unpaid.order_id,
            version: 1,
            state: 'awaiting_payment',
            payment_state: 'not_started',
            execution_mode: 'unpaid_service',
          });
          assert.deepEqual(
            [glovo, hall, mixed, voided].map((sale) => {
              const row = commercial[sale.order.order_id];
              return [row.version, row.state, row.payment_state, row.execution_mode];
            }),
            [
              [1, 'paid', 'captured', 'pos_sale'],
              [1, 'paid', 'captured', 'pos_sale'],
              [1, 'paid', 'captured', 'pos_sale'],
              [2, 'cancelled', 'captured', 'pos_sale'],
            ],
          );
          const meals = byOrder(
            await cloudRows(
              ctx,
              'SELECT order_id,state,execution_mode FROM pos_kitchen_sync_projection WHERE branch_id=$1',
            ),
          );
          assert.deepEqual(
            [unpaid.order_id, ...[glovo, hall, mixed, voided].map((s) => s.order.order_id)].map(
              (id) => [meals[id].state, meals[id].execution_mode],
            ),
            [
              ['handed_over', 'unpaid_service'],
              ['handed_over', 'pos_sale'],
              ['handed_over', 'pos_sale'],
              ['handed_over', 'pos_sale'],
              ['cancelled', 'pos_sale'],
            ],
          );
          const cashierShifts = await cloudRows(
            ctx,
            "SELECT id,payload->>'state' AS state,payload->>'expected_cash_minor' AS expected FROM cloud_cashier_shifts WHERE branch_id=$1 ORDER BY payload->>'opened_at'",
          );
          assert.deepEqual(
            cashierShifts.map((row) => [row.id, row.state]),
            [
              [unpaidShift.shift_id, 'closed'],
              [shift.shift_id, 'closed'],
            ],
          );
          assert.equal(cashierShifts[1].expected, '1018000');

          // Replays reach the four receivers directly and change nothing (dedup by event).
          const auth = { deviceId: desk.identity.device_id, token: desk.identity.token };
          const inbox = () =>
            cloudRows(
              ctx,
              `SELECT (SELECT count(*)::int FROM pos_order_sync_inbox WHERE branch_id=$1) AS orders,
                 (SELECT count(*)::int FROM pos_kitchen_sync_inbox WHERE branch_id=$1) AS kitchen,
                 (SELECT count(*)::int FROM cloud_pos_sale_inbox WHERE branch_id=$1) AS sales,
                 (SELECT count(*)::int FROM cloud_cashier_orders WHERE branch_id=$1) AS reports`,
            );
          const counted = await inbox();
          assert.equal(counted[0].sales, sales.length);
          for (const event of await commercialEvents(edge))
            await receivePosOrder(ctx.cloud.pool, auth, event);
          for (const event of await kitchenEvents(edge, desk.scope.producerId))
            await receivePosKitchen(ctx.cloud.pool, auth, event);
          for (let i = 0; i < sales.length; i += 50) {
            const events = sales.slice(i, i + 50);
            const answer = await receivePosSales(ctx.cloud.pool, auth, { events });
            assert.equal(answer.rejected, undefined, JSON.stringify(answer.rejected));
            assert.deepEqual(
              answer.receipts.map((r) => r.event_id),
              events.map((e) => e.event_id),
            );
          }
          // Cashier reports travel in pages of at most 25 (CashierReportsSchema).
          for (let i = 0; i < reports.length; i += 25)
            await transaction(ctx.cloud.pool, (client) =>
              receiveCashierReports(
                client,
                ctx.branch,
                ctx.device,
                CashierReportsSchema.parse(reports.slice(i, i + 25)),
              ),
            );
          assert.deepEqual(await inbox(), counted);

          // CR client-4 section 5 item 3: the desk's bodyless logout ends its session.
          const leave = lanClient(server.url, 'pos', desk.cashier);
          assert.equal((await leave('POST', '/edge/v1/staff/logout')).status, 204);
          assert.equal((await leave('GET', '/edge/v1/session')).status, 401);
        } finally {
          if (server) await server.app.close();
          await cloud.app.close();
          await desk.drop();
        }
      },
      { edgeMigrationDirectory: before026 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------ every flag off: old clients, byte for byte ----
/**
 * Frozen D0 cashier report shapes (5b212949, cashier-reports.ts): the exact payload keys and the
 * enums POS-6 widened. An installed cloud parses them strictly.
 */
const FROZEN_REPORTS = {
  shift: {
    keys: [
      'shift_id',
      'terminal_id',
      'staff_id',
      'state',
      'opened_at',
      'closed_at',
      'opening_cash_minor',
      'cash_in_minor',
      'cash_out_minor',
      'expected_cash_minor',
      'counted_cash_minor',
      'discrepancy_minor',
    ],
    enums: { state: ['open', 'closed'] },
  },
  order: {
    keys: [
      'order_id',
      'cash_shift_id',
      'created_at',
      'total_minor',
      'state',
      'version',
      'execution_mode',
      'kitchen_state',
      'display_number',
      'lines',
    ],
    enums: {
      state: ['awaiting_payment', 'cancelled'],
      execution_mode: ['payment_required', 'unpaid_service'],
    },
  },
};
const frozenReport = ({ kind, payload }) =>
  Object.keys(payload).sort().join() === [...FROZEN_REPORTS[kind].keys].sort().join() &&
  Object.entries(FROZEN_REPORTS[kind].enums).every(([key, values]) =>
    values.includes(payload[key]),
  );

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
/**
 * The bytes of an answer with only what differs between two desks replaced: identifiers,
 * timestamps and 64-hex tokens. Keys, their order, values and array lengths stay as they are.
 */
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value instanceof Date
      ? '<time>'
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonical(item)]))
        : typeof value === 'string'
          ? UUID.test(value)
            ? '<uuid>'
            : TIME.test(value)
              ? '<time>'
              : /^[a-f0-9]{64}$/.test(value)
                ? '<hex>'
                : value
          : value;
const route = (path) =>
  path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');

/**
 * Today's clients on one edge: the installed POS (unpaid), the kitchen screens on the old
 * stations and the board, over HTTP through their gateway profiles. Returns every answer as
 * canonical bytes and the payloads of the three old streams the day wrote.
 */
async function oldClientDay(ctx, desk, server) {
  const transcript = [];
  const record = (client) => async (method, path, body) => {
    const result = await client(method, path, body);
    transcript.push([
      `${method} ${route(path)}`,
      result.status,
      JSON.stringify(canonical(result.json)),
    ]);
    return result;
  };
  const pos = record(lanClient(server.url, 'pos', desk.cashier));
  const boss = record(lanClient(server.url, 'pos', desk.manager));
  const kitchen = record(lanClient(server.url, 'kitchen', desk.cook, desk.cook.terminal_id));
  ok(await pos('GET', '/edge/v1/session'));
  ok(await pos('GET', '/edge/v1/menu'));
  ok(await pos('GET', '/edge/v1/ordering'));
  const shift = ok(
    await boss('POST', '/edge/v1/cash-shifts', { opening_cash_minor: '100000' }),
    201,
  );
  ok(await boss('GET', '/edge/v1/cash-shifts/current'));
  const order = async () => {
    const quote = ok(
      await pos('POST', '/edge/v1/checkout/quotes', {
        release_id: desk.release.release_id,
        service_mode: 'takeaway',
        items: [desk.burger, desk.drink].map((item) => ({
          variant_id: item.variant_id,
          quantity: 1,
        })),
      }),
      201,
    );
    return ok(
      await pos('POST', '/edge/v1/orders', {
        quote_id: quote.quote_id,
        kitchen_admission: 'unpaid',
      }),
      201,
    );
  };
  const kept = await order();
  ok(await pos('GET', `/edge/v1/orders/${kept.order_id}`));
  ok(await pos('GET', `/edge/v1/orders?shift_id=${shift.shift_id}`));
  ok(await kitchen('GET', '/edge/v1/fulfillment/config'));
  ok(await kitchen('GET', '/edge/v1/fulfillment/stations'));
  let ticket;
  for (const station of [desk.prep, desk.assembly]) {
    ok(await kitchen('GET', `/edge/v1/fulfillment/kitchen?stationId=${station}`));
    ticket = ok(
      await kitchen('GET', `/edge/v1/fulfillment/orders/${kept.order_id}?stationId=${station}`),
    );
    for (const task of ticket.tasks.filter((t) => t.stationId === station))
      for (const [action, version] of [
        ['start_task', task.version],
        ['complete_task', task.version + 1],
      ])
        ticket = ok(
          await kitchen('POST', `/edge/v1/fulfillment/orders/${kept.order_id}/actions`, {
            action,
            expectedVersion: ticket.version,
            taskId: task.taskId,
            expectedTaskVersion: version,
          }),
        );
  }
  for (const action of ['ready', 'handoff']) {
    ticket = ok(
      await kitchen('POST', `/edge/v1/fulfillment/orders/${kept.order_id}/actions`, {
        action,
        expectedVersion: ticket.version,
      }),
    );
    ok(await kitchen('GET', '/edge/v1/fulfillment/display'));
  }
  assert.equal(ticket.state, 'handed_over');
  const cancelled = await order();
  ok(
    await pos('POST', `/edge/v1/orders/${cancelled.order_id}/cancel`, {
      expected_version: 1,
      reason: 'Синтетическая отмена',
    }),
  );
  ok(
    await boss('POST', `/edge/v1/cash-shifts/${shift.shift_id}/movements`, {
      direction: 'in',
      amount_minor: '10000',
      reason: 'Синтетический размен',
    }),
  );
  const open = ok(await boss('GET', `/edge/v1/cash-shifts/${shift.shift_id}`));
  ok(
    await boss('POST', `/edge/v1/cash-shifts/${shift.shift_id}/close`, {
      expected_version: open.version,
      counted_cash_minor: open.expected_cash_minor,
      reason: 'Синтетическое закрытие',
    }),
  );
  ok(await boss('GET', '/edge/v1/cash-shifts'));
  ok(await pos('GET', `/edge/v1/orders?shift_id=${shift.shift_id}`));
  const rows = async (sql) => JSON.stringify(canonical((await ctx.edge.pool.query(sql)).rows));
  return {
    transcript,
    streams: {
      commercial: await rows(
        "SELECT event_type,aggregate_version,schema_version,payload FROM outbox_events WHERE aggregate_type='order_commercial' ORDER BY producer_sequence",
      ),
      kitchen: await rows(
        "SELECT event_type,aggregate_type,aggregate_version,payload FROM fulfillment_outbox WHERE payload->>'commercialOwner'='edge_pos' ORDER BY sequence",
      ),
      reports: await rows('SELECT kind,payload FROM cashier_report_outbox ORDER BY sequence'),
    },
  };
}

test('every flag off after C4: today’s POS, kitchen and board get byte-identical answers and stream payloads as on 025, and the new cloud takes them as today', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-cross-lane-off-'));
  const days = {};
  try {
    const before026 = await migrationsBefore(root, '026');
    for (const twin of ['edge025', 'edge027'])
      await withSyncDatabases(
        async (ctx) => {
          const desk = await edge025(ctx);
          const cloud = await running(createApi, {
            ...ctx.cloud.config,
            posOrderSyncEnabled: true,
          });
          let server = null;
          try {
            if (twin === 'edge027') await windowC4(ctx, desk);
            server = await startEdge(ctx, desk.runtime);
            days[twin] = await oldClientDay(ctx, desk, server);
            // The new routes say "off": pos/config needs 026 (404 keeps the old POS UI), the KDS
            // layout is off on 025 and on 027 alike.
            const pos = lanClient(server.url, 'pos', desk.cashier);
            const kitchen = lanClient(server.url, 'kitchen', desk.cook, desk.cook.terminal_id);
            const config = await pos('GET', `/edge/v1/pos/config?client_version=${DESK_BUILD}`);
            const layout = await kitchen('GET', '/edge/v1/fulfillment/layout');
            const options = {
              enabled: true,
              branchId: ctx.branch,
              origin: cloud.url,
              identity: desk.identity,
            };
            assert.deepEqual(ok(layout), { enabled: false });
            const sales = await syncPosSalesOnce(desk.posSync.open(), options);
            if (twin === 'edge025') {
              assert.equal(config.status, 404);
              assert.equal(sales.state, 'not_installed');
            } else {
              const off = PosConfigSchema.parse(ok(config));
              assert.equal(off.mode, 'unpaid_service');
              assert.ok(off.methods.every((method) => !method.enabled));
              // CLOUD_POS_SALES_SYNC_ENABLED off: the cloud does not support posSales yet.
              assert.equal(sales.state, 'unsupported');
              assert.deepEqual(
                (
                  await ctx.edge.pool.query(
                    'SELECT (SELECT count(*)::int FROM pos_sale_outbox) AS events, (SELECT last_error FROM pos_sale_sync_state) AS error',
                  )
                ).rows[0],
                { events: 0, error: 'CLOUD_UNSUPPORTED' },
              );
              assert.deepEqual(
                (
                  await ctx.edge.pool.query(
                    'SELECT count(*)::int AS n FROM fulfillment_tasks WHERE station_id=ANY($1)',
                    [
                      ['breading', 'toasts', 'assembly_hall', 'assembly_delivery', 'issue'].map(
                        (fn) => kdsStationId(ctx.branch, fn),
                      ),
                    ],
                  )
                ).rows[0].n,
                0,
              );
            }
            // Today's cloud receivers take the old streams; cashier reports keep the D0 shapes.
            await drain(syncPosOrdersOnce, desk.posSync.open(), options);
            await drain(syncPosKitchenOnce, desk.posSync.open(), options);
            const reports = await drainCashierReports(ctx);
            assert.ok(reports.length >= 3);
            for (const report of reports)
              assert.ok(frozenReport(report), JSON.stringify(report.payload));
            days[twin].cloud = JSON.stringify(
              canonical(
                await cloudRows(
                  ctx,
                  `SELECT (SELECT json_agg(json_build_array(state,payment_state,execution_mode,version) ORDER BY state)
                     FROM pos_order_sync_projection WHERE branch_id=$1) AS orders,
                   (SELECT json_agg(json_build_array(state,execution_mode) ORDER BY state)
                     FROM pos_kitchen_sync_projection WHERE branch_id=$1) AS kitchen`,
                ),
              ),
            );
          } finally {
            if (server) await server.app.close();
            await cloud.app.close();
            await desk.drop();
          }
        },
        { edgeMigrationDirectory: before026 },
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.ok(days.edge025.transcript.length > 30);
  assert.deepEqual(days.edge027.transcript, days.edge025.transcript);
  assert.deepEqual(days.edge027.streams, days.edge025.streams);
  assert.equal(days.edge027.cloud, days.edge025.cloud);
});

// ------------------------------------------------------- no WAN, then every stream catches up ----
/** The kitchen screen calls of one ticket (kitchen profile): read at a station, act, complete. */
function kdsScreen(kitchen, branch) {
  const S = (fn) => kdsStationId(branch, fn);
  const read = async (orderId, fn) =>
    FulfillmentOrderSchema.parse(
      ok(await kitchen('GET', `/edge/v1/fulfillment/orders/${orderId}?stationId=${S(fn)}`)),
    );
  const act = (current, body) =>
    kitchen('POST', `/edge/v1/fulfillment/orders/${current.orderId}/actions`, {
      expectedVersion: current.version,
      ...body,
    });
  const complete = async (current, fn) =>
    ok(await act(current, { action: 'complete_station', stationId: S(fn) }));
  return { read, act, complete };
}

test('WAN down after the switch-on: sales and the KDS kitchen go on, the four streams keep every event and catch up in order once the cloud is back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickchick-cross-lane-wan-'));
  try {
    const before026 = await migrationsBefore(root, '026');
    await withSyncDatabases(
      async (ctx) => {
        const edge = ctx.edge.pool;
        const desk = await edge025(ctx);
        await windowC4(ctx, desk);
        const cloud = await running(createApi, {
          ...ctx.cloud.config,
          posOrderSyncEnabled: true,
          posSalesSyncEnabled: true,
        });
        const server = await startEdge(ctx, desk.runtime);
        try {
          const up = {
            enabled: true,
            branchId: ctx.branch,
            origin: cloud.url,
            identity: desk.identity,
          };
          // The router of the cash desk is down: nothing listens at the cloud address.
          const down = { ...up, origin: 'http://127.0.0.1:9' };
          const sync = desk.posSync.open();
          let clock = Date.now();
          const io = { now: () => clock };
          const schedule = createPosSalesSchedule();
          assert.equal((await syncPosSalesOnce(sync, up, schedule, io)).state, 'probed');
          const pos = lanClient(server.url, 'pos', desk.cashier);
          const boss = lanClient(server.url, 'pos', desk.manager);
          const kds = kdsScreen(
            lanClient(server.url, 'kitchen', desk.cook, desk.cook.terminal_id),
            ctx.branch,
          );
          ok(await pos('GET', `/edge/v1/pos/config?client_version=${DESK_BUILD}`));
          await switchOn(ctx, desk, pos);

          // ---- No WAN: a whole paid shift with its kitchen; every sender fails and waits.
          const tried = [];
          const attempt = async () => {
            // Idle while nothing is pending and the last answer is recent; otherwise it fails.
            const sales = await syncPosSalesOnce(sync, down, schedule, io);
            assert.ok(['retry', 'waiting', 'idle'].includes(sales.state), JSON.stringify(sales));
            tried.push(sales.error ?? sales.state);
            for (const stream of [syncPosOrdersOnce, syncPosKitchenOnce]) {
              const result = await stream(sync, down);
              assert.ok(['retry', 'idle'].includes(result.state), JSON.stringify(result));
            }
            clock += 61_000;
          };
          const shift = ok(
            await boss('POST', '/edge/v1/cash-shifts', { opening_cash_minor: '500000' }),
            201,
          );
          await attempt();
          const sell = async (items, extra, body) => {
            const quote = ok(
              await pos('POST', '/edge/v1/checkout/quotes', {
                release_id: desk.release.release_id,
                service_mode: 'takeaway',
                items: items.map((item) => ({ variant_id: item.variant_id, quantity: 1 })),
                ...extra,
              }),
              201,
            );
            const sale = PosSaleResultSchema.parse(
              ok(
                await pos('POST', '/edge/v1/pos/sales', {
                  quote_id: quote.quote_id,
                  service_mode_confirmed: true,
                  order_repeated: true,
                  ...body,
                }),
                201,
              ),
            );
            await attempt();
            return sale;
          };
          const hall = await sell(
            [desk.burger, desk.drink],
            { service_mode: 'dine_in' },
            {
              tenders: [{ method: 'cash', amount_minor: '409000' }],
              cash_tendered_minor: '409000',
            },
          );
          const glovo = await sell(
            [desk.burger],
            { sales_channel: 'glovo' },
            {
              tenders: [{ method: 'aggregator_glovo', amount_minor: '389000' }],
              external_order_ref: 'G-7001',
            },
          );
          const kaspi = await sell(
            [desk.burger, desk.drink],
            {},
            {
              tenders: [{ method: 'kaspi_terminal', amount_minor: '409000' }],
            },
          );
          for (const sale of [hall, kaspi]) {
            let current = await kds.read(sale.order.order_id, 'assembly_hall');
            current = await kds.complete(current, 'assembly_hall');
            current = await kds.complete(current, 'issue');
            assert.equal(ok(await kds.act(current, { action: 'handoff' })).state, 'handed_over');
          }
          let courier = await kds.read(glovo.order.order_id, 'assembly_delivery');
          courier = await kds.complete(courier, 'assembly_delivery');
          courier = await kds.complete(courier, 'delivery_handover');
          assert.equal(
            ok(await kds.act(courier, { action: 'handoff', handover: MARKS })).state,
            'handed_over',
          );
          await attempt();
          const pending = PosFiscalPendingSchema.parse(
            ok(await pos('GET', `/edge/v1/pos/fiscal-receipts/pending?shift_id=${shift.shift_id}`)),
          ).receipts;
          for (const [index, receipt] of pending.entries())
            ok(
              await pos('POST', `/edge/v1/pos/fiscal-receipts/${receipt.receipt_id}/record`, {
                expected_version: receipt.version,
                receipt_number: `SYN-WK-OFF-${index + 1}`,
              }),
            );
          const open = ok(await boss('GET', `/edge/v1/cash-shifts/${shift.shift_id}`));
          assert.equal(open.expected_cash_minor, '909000');
          ok(
            await boss('POST', `/edge/v1/cash-shifts/${shift.shift_id}/close`, {
              expected_version: open.version,
              counted_cash_minor: '909000',
              reason: 'Синтетическое закрытие без интернета',
              terminal_reported_minor: '409000',
            }),
          );
          await attempt();
          // Nothing of the shift reached the cloud; everything waits on the edge.
          const waiting = async () =>
            (
              await edge.query(
                `SELECT (SELECT count(*)::int FROM pos_sale_outbox WHERE acknowledged_at IS NULL) AS sales,
                   (SELECT count(*)::int FROM outbox_events WHERE aggregate_type='order_commercial'
                      AND acknowledged_at IS NULL) AS orders,
                   (SELECT count(*)::int FROM fulfillment_outbox WHERE payload->>'commercialOwner'='edge_pos'
                      AND acknowledged_at IS NULL) AS kitchen,
                   (SELECT count(*)::int FROM cashier_report_outbox WHERE acknowledged_at IS NULL) AS reports`,
              )
            ).rows[0];
          assert.ok(tried.includes('NETWORK_UNKNOWN'), String(tried));
          assert.deepEqual(
            (
              await edge.query(
                `SELECT (SELECT last_error FROM pos_sale_sync_state) AS sales,
                   (SELECT last_error FROM pos_order_sync_state) AS orders,
                   (SELECT last_error FROM pos_kitchen_sync_state) AS kitchen`,
              )
            ).rows[0],
            { sales: 'NETWORK_UNKNOWN', orders: 'NETWORK_UNKNOWN', kitchen: 'NETWORK_UNKNOWN' },
          );
          const backlog = await waiting();
          const events = await posSaleEvents(edge);
          assert.equal(backlog.sales, events.length);
          assert.equal(backlog.orders, 3);
          assert.ok(backlog.kitchen > 0 && backlog.reports > 0, JSON.stringify(backlog));
          assert.deepEqual(
            await cloudRows(
              ctx,
              `SELECT (SELECT count(*)::int FROM cloud_pos_sale_inbox WHERE branch_id=$1) AS sales,
                 (SELECT count(*)::int FROM pos_order_sync_inbox WHERE branch_id=$1) AS orders`,
            ),
            [{ sales: 0, orders: 0 }],
          );

          // ---- The WAN is back after the outage: the retry pauses are over (time skip).
          clock += 3_600_000;
          await edge.query('UPDATE pos_order_sync_state SET retry_after=NULL');
          await edge.query('UPDATE pos_kitchen_sync_state SET retry_after=NULL');
          const states = await drainPosSales(sync, up, schedule, io);
          assert.ok(states.includes('delivered') && states.at(-1) === 'idle', String(states));
          await drain(syncPosOrdersOnce, sync, up);
          await drain(syncPosKitchenOnce, sync, up);
          await drainCashierReports(ctx);
          assert.deepEqual(await waiting(), { sales: 0, orders: 0, kitchen: 0, reports: 0 });
          // Exactly the edge's events, once each, in the edge's order.
          assert.deepEqual(
            (
              await cloudRows(
                ctx,
                'SELECT event_id,sequence::text AS sequence,kind FROM cloud_pos_sale_inbox WHERE branch_id=$1 ORDER BY sequence',
              )
            ).map((row) => [row.event_id, row.sequence, row.kind]),
            events.map((event) => [event.event_id, event.sequence, event.kind]),
          );
          assert.deepEqual(
            (
              await cloudRows(
                ctx,
                'SELECT state,sales_channel,total_minor::text AS total FROM cloud_pos_sales WHERE branch_id=$1 ORDER BY display_number',
              )
            ).map((row) => [row.state, row.sales_channel, row.total]),
            [
              ['paid', 'hall', '409000'],
              ['paid', 'glovo', '389000'],
              ['paid', 'hall', '409000'],
            ],
          );
          assert.deepEqual(
            await cloudRows(
              ctx,
              `SELECT (SELECT count(*)::int FROM cloud_pos_shift_reports WHERE branch_id=$1) AS z,
                 (SELECT count(*)::int FROM pos_order_sync_projection WHERE branch_id=$1 AND state='paid') AS paid,
                 (SELECT count(*)::int FROM pos_kitchen_sync_projection WHERE branch_id=$1 AND state='handed_over') AS handed,
                 (SELECT payload->>'expected_cash_minor' FROM cloud_cashier_shifts WHERE id='${shift.shift_id}') AS expected`,
            ),
            [{ z: 1, paid: 3, handed: 3, expected: '909000' }],
          );
          assert.deepEqual((await edge.query('SELECT last_error FROM pos_sale_sync_state')).rows, [
            { last_error: null },
          ]);
        } finally {
          await server.app.close();
          await cloud.app.close();
          await desk.drop();
        }
      },
      { edgeMigrationDirectory: before026 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
