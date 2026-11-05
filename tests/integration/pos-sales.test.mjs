import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { createPool, transaction } from '@pickchick/database';
import { createEdge } from '@pickchick/edge';
import { applyMenu, hashJson, hashToken, publishMenu } from '@pickchick/menu-sync';
import {
  approvalSubjectHash,
  createLocalOrder,
  createPosSale,
  createQuote,
  openCashShift,
  provisionStaff,
  readLocalOrder,
  readPosConfig,
  readPosSale,
  requestManagerApproval,
  setOrdering,
  setStaffPin,
} from '@pickchick/local-orders';
import {
  EdgeFulfillment,
  RoutingSchema,
  grantStation,
  localUnpaidExecution,
  provisionFulfillment,
  taskPlan,
} from '@pickchick/edge-fulfillment';
import {
  ErrorSchema,
  LocalOrderSchema,
  ManagerApprovalSchema,
  POS_PAYMENT_METHOD_POLICY,
  PosConfigSchema,
  PosPaymentMethodSchema,
  PosSaleResultSchema,
  PosSaleSchema,
  QuoteSchema,
} from '@pickchick/contracts';
import { parsePosSaleEvent } from '@pickchick/pos-order-sync';
import { applyEdgeRuntimeGrants } from '../../infra/windows/edge-runtime-grants.mjs';
import { posSalesRuntimeGrants } from '../../infra/windows/pos-sales-grants.mjs';
import { request, running, withSyncDatabases } from '../helpers/sync.mjs';
import { staffAuth, staffHeaders } from '../helpers/orders.mjs';

// POS-2 (contracts 00, 2.2, 5.1, 5.2, 5.6): paid POS sales on the cashier edge, end to end on the
// real schema026 and runtime. Synthetic data only: menu, staff, PINs and order numbers are made up.
const ALL = PosPaymentMethodSchema.options;
const PIN = '2468';
const CASHIER_PIN = '135790';
const code = (expected) => (error) => error.code === expected;
const edgeDir = fileURLToPath(new URL('../../db/edge/migrations/', import.meta.url));

async function switchMode(pool, branch, from, to) {
  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO pos_sales_setting_changes(change_id,branch_id,subject,before,after,actor,reason)
       VALUES($1,$2,'pos_service_mode',$3,$4,'operator','Синтетическое переключение')`,
      [randomUUID(), branch, { pos_service_mode: from }, { pos_service_mode: to }],
    );
    await client.query('UPDATE branch_config SET pos_service_mode=$2 WHERE id=$1', [branch, to]);
  });
}
async function setMethod(pool, branch, method, change) {
  await transaction(pool, async (client) => {
    const old = (
      await client.query(
        'SELECT enabled,fiscal_policy FROM pos_payment_methods WHERE branch_id=$1 AND code=$2 FOR UPDATE',
        [branch, method],
      )
    ).rows[0];
    const next = { ...old, ...change };
    await client.query(
      `INSERT INTO pos_sales_setting_changes(change_id,branch_id,subject,before,after,actor,reason)
       VALUES($1,$2,$3,$4,$5,'operator','Синтетическая настройка')`,
      [randomUUID(), branch, method, old, next],
    );
    await client.query(
      'UPDATE pos_payment_methods SET enabled=$3,fiscal_policy=$4 WHERE branch_id=$1 AND code=$2',
      [branch, method, next.enabled, next.fiscal_policy],
    );
  });
}
/** Sales shift of one cash desk (opening a shift in pos_sale mode through the API is POS-4). */
async function salesShift(pool, branch, manager, terminal, opening = '500000') {
  const id = randomUUID();
  await pool.query(
    'INSERT INTO local_cash_shifts(id,branch_id,staff_id,terminal_id,opening_cash_minor,sales_mode) VALUES($1,$2,$3,$4,$5,true)',
    [id, branch, manager.staff_id, terminal, opening],
  );
  return id;
}
const closeShifts = (pool) =>
  pool.query(
    "UPDATE local_cash_shifts SET state='closed',version=version+1,closed_at=clock_timestamp(),closed_by_staff_id=staff_id,counted_cash_minor=0,discrepancy_minor=0,closing_reason='Синтетика',closed_report='{}' WHERE state='open'",
  );

/** Hall item with Yandex Eda and Glovo prices and a sauce option, and a hall-only drink at a
 * price with tiyn (not whole tenge). */
function salesMenu(ctx) {
  const base = ctx.menu();
  const group = randomUUID(),
    option = randomUUID();
  const burger = {
    ...base.items[0],
    aggregator_prices_minor: { yandex_eda: '399000', glovo: '389000' },
    modifier_groups: [
      {
        id: group,
        name: { ru: 'Соус', kk: 'Соус' },
        min_selected: 0,
        max_selected: 2,
        options: [
          {
            id: option,
            name: { ru: 'Сырный', kk: 'Ірімшік' },
            price_minor: '20000',
            max_quantity: 2,
          },
        ],
      },
    ],
  };
  const drink = {
    ...base.items[0],
    product_id: randomUUID(),
    variant_id: randomUUID(),
    name: { ru: 'Синтетический напиток', kk: 'Синтетикалық сусын' },
    price_minor: '125050',
  };
  return { release: { ...base, items: [burger, drink] }, burger, drink, group, option };
}

async function prepareDesk(ctx, { mode, methods }) {
  const edge = ctx.edge.pool;
  const menu = salesMenu(ctx);
  await applyMenu(edge, ctx.branch, await publishMenu(ctx.cloud.pool, menu.release));
  const setup = (role, terminal = randomUUID()) => ({
    staff_id: randomUUID(),
    terminal_id: terminal,
    name: 'Синтетический сотрудник',
    role,
  });
  const cashierSetup = setup('cashier');
  await setStaffPin(
    edge,
    ctx.branch,
    staffAuth(await provisionStaff(edge, ctx.branch, cashierSetup)),
    CASHIER_PIN,
  );
  const cashier = await provisionStaff(edge, ctx.branch, cashierSetup);
  const managerSetup = {
    ...setup('shift_manager', cashier.terminal_id),
    name: 'Синтетический менеджер',
  };
  // Enrolling a PIN revokes the bootstrap session; the desk then gets a fresh one.
  await setStaffPin(
    edge,
    ctx.branch,
    staffAuth(await provisionStaff(edge, ctx.branch, managerSetup)),
    PIN,
  );
  const manager = await provisionStaff(edge, ctx.branch, managerSetup);
  const second = await provisionStaff(edge, ctx.branch, setup('cashier'));
  const prep = randomUUID(),
    assembly = randomUUID();
  const routing = {
    version: 1,
    assemblyStationId: assembly,
    routes: menu.release.items.map((item) => ({
      productId: item.product_id,
      stationId: prep,
      kind: 'prep',
    })),
  };
  await provisionFulfillment(edge, {
    organizationId: ctx.org,
    branchId: ctx.branch,
    deviceId: ctx.device,
    producerId: randomUUID(),
    stations: [
      { id: prep, kind: 'prep', name: 'Synthetic prep' },
      { id: assembly, kind: 'assembly', name: 'Synthetic assembly' },
    ],
    routing,
  });
  await setOrdering(edge, ctx.branch, staffAuth(manager), randomUUID(), true, {
    expected_version: 1,
  });
  const shifts = {};
  if (mode === 'pos_sale') {
    await switchMode(edge, ctx.branch, 'payment_required', 'pos_sale');
    for (const method of methods) await setMethod(edge, ctx.branch, method, { enabled: true });
    shifts.first = await salesShift(edge, ctx.branch, manager, cashier.terminal_id);
    shifts.second = await salesShift(edge, ctx.branch, manager, second.terminal_id);
  } else {
    if (mode !== 'payment_required')
      await edge.query('UPDATE branch_config SET pos_service_mode=$2 WHERE id=$1', [
        ctx.branch,
        mode,
      ]);
    shifts.first = (
      await openCashShift(edge, ctx.branch, staffAuth(manager), randomUUID(), {
        opening_cash_minor: '0',
      })
    ).shift_id;
  }
  return {
    ...ctx,
    ...menu,
    setup,
    cashier,
    manager,
    second,
    prep,
    assembly,
    routing,
    shifts,
    port: localUnpaidExecution({ enabled: true, deviceId: ctx.device }),
  };
}
async function desk(run, { mode = 'pos_sale', methods = ALL, edgeMigrationDirectory } = {}) {
  await withSyncDatabases(
    async (ctx) => run(await prepareDesk(ctx, { mode, methods })),
    edgeMigrationDirectory ? { edgeMigrationDirectory } : {},
  );
}

const line = (ctx, quantity = 1, sauces = 0) => ({
  variant_id: ctx.burger.variant_id,
  quantity,
  ...(sauces
    ? { modifiers: [{ group_id: ctx.group, option_id: ctx.option, quantity: sauces }] }
    : {}),
});
const quote = (ctx, { channel, items, serviceMode = 'takeaway', actor = ctx.cashier } = {}) =>
  createQuote(ctx.edge.pool, ctx.branch, staffAuth(actor), {
    release_id: ctx.release.release_id,
    service_mode: serviceMode,
    items: items ?? [line(ctx)],
    ...(channel ? { sales_channel: channel } : {}),
  });
const sale = (q, extra) => ({
  quote_id: q.quote_id,
  service_mode_confirmed: true,
  order_repeated: true,
  ...extra,
});
const sell = (ctx, body, { key = randomUUID(), actor = ctx.cashier, port = ctx.port } = {}) =>
  createPosSale(ctx.edge.pool, ctx.branch, staffAuth(actor), key, body, port);
const approve = (
  ctx,
  action,
  subject,
  { actor = ctx.cashier, pin = PIN, staff = ctx.manager } = {},
) =>
  requestManagerApproval(ctx.edge.pool, ctx.branch, staffAuth(actor), {
    staff_id: staff.staff_id,
    pin,
    action,
    subject,
  });
const proof = (approval) => ({ approval_id: approval.approval_id, token: approval.token });
const count = async (pool, table, where = 'true', values = []) =>
  Number((await pool.query(`SELECT count(*) FROM ${table} WHERE ${where}`, values)).rows[0].count);
const SALE_TABLES = [
  'local_orders',
  'pos_sales',
  'pos_sale_tenders',
  'pos_fiscal_receipts',
  'pos_sale_outbox',
  'fulfillment_reservations',
  'fulfillment_tasks',
  'fulfillment_outbox',
];
const counts = async (pool) =>
  Object.fromEntries(
    await Promise.all(SALE_TABLES.map(async (table) => [table, await count(pool, table)])),
  );
/** The posSales events of an order, as the sender reads them (contracts 5.6), strictly parsed. */
async function saleEvents(pool, orderId) {
  const rows = (
    await pool.query(
      `SELECT e.* FROM pos_sale_outbox e WHERE e.entity_id=$1 OR e.payload->>'order_id'=$1::text
       ORDER BY e.sequence`,
      [orderId],
    )
  ).rows;
  return rows.map((row) => {
    assert.equal(row.payload_hash, hashJson(row.payload));
    return parsePosSaleEvent({
      event_id: row.event_id,
      branch_id: row.branch_id,
      sequence: row.sequence,
      kind: row.kind,
      occurred_at: row.occurred_at.toISOString(),
      payload: row.payload,
    });
  });
}
const reservation = async (pool, orderId) =>
  (await pool.query('SELECT * FROM fulfillment_reservations WHERE order_id=$1', [orderId])).rows[0];

test('cash with change: one transaction writes the paid order, kitchen admission, receipt and events', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const q = await quote(ctx, { items: [line(ctx, 2, 1)], serviceMode: 'dine_in' });
    assert.equal(q.total_minor, '738000');
    assert.equal('sales_channel' in q, false);
    const shiftReports = await count(pool, 'cashier_report_outbox', "kind='shift'");
    const key = randomUUID(),
      body = sale(q, {
        tenders: [{ method: 'cash', amount_minor: '738000' }],
        cash_tendered_minor: '1000000',
      });
    const result = await sell(ctx, body, { key });
    assert.deepEqual(PosSaleResultSchema.parse(result), result);
    const { order, sale: paid } = result;
    assert.equal(order.state, 'paid');
    assert.equal(order.payment_state, 'captured');
    assert.equal(order.execution_mode, 'pos_sale');
    assert.equal(order.fiscal_state, 'not_requested');
    assert.equal(order.fulfillment_state, 'accepted');
    assert.equal(order.next_action, 'none');
    assert.equal(order.version, 1);
    assert.equal(order.cash_shift_id, ctx.shifts.first);
    assert.deepEqual(order.snapshot, q);
    assert.deepEqual(
      { ...paid, created_at: undefined, tenders: undefined, fiscal: undefined },
      {
        order_id: order.order_id,
        display_number: Number(order.fulfillment.display_number),
        pickup: 'issue',
        sales_channel: 'hall',
        external_order_ref: null,
        service_mode: 'dine_in',
        revenue_kind: 'revenue',
        total_minor: '738000',
        cash_tendered_minor: '1000000',
        change_minor: '262000',
        refunds: [],
        refundable_minor: '738000',
        shift_id: ctx.shifts.first,
        terminal_id: ctx.cashier.terminal_id,
        cashier_staff_id: ctx.cashier.staff_id,
        created_at: undefined,
        tenders: undefined,
        fiscal: undefined,
      },
    );
    assert.deepEqual(
      paid.tenders.map(({ tender_id, ...tender }) => (assert.ok(tender_id), tender)),
      [{ method: 'cash', amount_minor: '738000', confirmation: 'drawer', reference: null }],
    );
    assert.deepEqual(
      paid.fiscal.map(({ receipt_id, ...receipt }) => (assert.ok(receipt_id), receipt)),
      [
        {
          kind: 'sale',
          state: 'pending',
          receipt_number: null,
          version: 1,
          amount_minor: '738000',
        },
      ],
    );
    // Replay with the same key and body is the stored result; reads agree with it.
    assert.deepEqual(await sell(ctx, body, { key }), result);
    assert.deepEqual(
      await readPosSale(pool, ctx.branch, staffAuth(ctx.cashier), order.order_id),
      paid,
    );
    assert.deepEqual(
      await readLocalOrder(pool, ctx.branch, staffAuth(ctx.cashier), order.order_id),
      order,
    );
    // Kitchen admission of a paid sale: pos_sale, channel pos, the hall service mode.
    const row = await reservation(pool, order.order_id);
    assert.equal(row.admission_kind, 'pos_sale');
    assert.equal(row.commercial_owner, 'edge_pos');
    assert.equal(row.local_order_id, order.order_id);
    assert.equal(row.authorized_by_staff_id, ctx.cashier.staff_id);
    assert.equal(row.snapshot.channel, 'pos');
    assert.equal(row.snapshot.serviceMode, 'dine_in');
    assert.equal('delivery' in row.snapshot, false);
    const kitchen = (
      await pool.query('SELECT payload FROM fulfillment_outbox WHERE order_id=$1', [order.order_id])
    ).rows;
    assert.equal(kitchen.length, 1);
    assert.equal(kitchen[0].payload.executionMode, 'pos_sale');
    // posSales: the sale and its receipt, parsed by the wire model with the pinned hash.
    const events = await saleEvents(pool, order.order_id);
    assert.deepEqual(
      events.map((event) => event.kind),
      ['sale', 'fiscal'],
    );
    assert.ok(BigInt(events[0].sequence) < BigInt(events[1].sequence));
    assert.deepEqual(events[0].payload, {
      order_id: order.order_id,
      quote: q,
      shift_id: ctx.shifts.first,
      terminal_id: ctx.cashier.terminal_id,
      cashier_staff_id: ctx.cashier.staff_id,
      display_number: paid.display_number,
      sales_channel: 'hall',
      external_order_ref: null,
      service_mode: 'dine_in',
      revenue_kind: 'revenue',
      total_minor: '738000',
      cash_tendered_minor: '1000000',
      change_minor: '262000',
      beneficiary: null,
      reason: null,
      approval: null,
      tenders: paid.tenders,
      created_at: paid.created_at,
    });
    assert.deepEqual(events[1].payload, {
      receipt_id: paid.fiscal[0].receipt_id,
      order_id: order.order_id,
      refund_id: null,
      kind: 'sale',
      mode: 'manual_webkassa',
      state: 'pending',
      receipt_number: null,
      version: 1,
      amount_minor: '738000',
      recorded_by_staff_id: null,
      recorded_at: null,
    });
    // order_commercial (contracts 5.6): order.created, paid and captured, version 1.
    const commercial = (
      await pool.query(
        "SELECT aggregate_version,payload FROM outbox_events WHERE aggregate_id=$1 AND event_type='order.created'",
        [order.order_id],
      )
    ).rows;
    assert.equal(commercial.length, 1);
    assert.equal(commercial[0].aggregate_version, '1');
    assert.equal(commercial[0].payload.state, 'paid');
    assert.equal(commercial[0].payload.payment_state, 'captured');
    assert.equal(commercial[0].payload.execution_mode, 'pos_sale');
    assert.equal(commercial[0].payload.total_minor, '738000');
    // A sale writes no shift report; exactly one of everything.
    assert.equal(await count(pool, 'cashier_report_outbox', "kind='shift'"), shiftReports);
    assert.deepEqual(await counts(pool), {
      local_orders: 1,
      pos_sales: 1,
      pos_sale_tenders: 1,
      pos_fiscal_receipts: 1,
      pos_sale_outbox: 2,
      fulfillment_reservations: 1,
      fulfillment_tasks: 1,
      fulfillment_outbox: 1,
    });
    assert.equal(
      await count(pool, 'local_audit', "action='pos_sale.created' AND resource_id=$1", [
        order.order_id,
      ]),
      1,
    );
  });
});

test('mixed payment: cash+terminal and cash+kaspi_manual, change only from cash, mix rules', async () => {
  await desk(async (ctx) => {
    const terminal = await sell(
      ctx,
      sale(await quote(ctx), {
        tenders: [
          { method: 'cash', amount_minor: '49000' },
          { method: 'kaspi_terminal', amount_minor: '300000', reference: 'SYN-RRN-0001' },
        ],
        cash_tendered_minor: '50000',
      }),
    );
    assert.equal(terminal.sale.change_minor, '1000');
    assert.equal(terminal.sale.cash_tendered_minor, '50000');
    assert.deepEqual(
      terminal.sale.tenders.map(({ method, amount_minor, confirmation, reference }) => ({
        method,
        amount_minor,
        confirmation,
        reference,
      })),
      [
        { method: 'cash', amount_minor: '49000', confirmation: 'drawer', reference: null },
        {
          method: 'kaspi_terminal',
          amount_minor: '300000',
          confirmation: 'cashier_attested',
          reference: 'SYN-RRN-0001',
        },
      ],
    );
    assert.equal(terminal.sale.fiscal[0].state, 'pending');
    const manual = await sell(
      ctx,
      sale(await quote(ctx), {
        tenders: [
          { method: 'cash', amount_minor: '100000' },
          { method: 'kaspi_manual', amount_minor: '249000', reference: 'SYN-OP-1' },
        ],
        cash_tendered_minor: '100000',
      }),
    );
    assert.equal(manual.sale.change_minor, '0');
    assert.deepEqual(
      manual.sale.tenders.map((t) => [t.method, t.confirmation]),
      [
        ['cash', 'drawer'],
        ['kaspi_manual', 'cashier_attested'],
      ],
    );
    // Two non-cash parts of the mix set need no cash tendered.
    const cards = await sell(
      ctx,
      sale(await quote(ctx), {
        tenders: [
          { method: 'kaspi_terminal', amount_minor: '200000' },
          { method: 'kaspi_manual', amount_minor: '149000' },
        ],
      }),
    );
    assert.equal(cards.sale.cash_tendered_minor, null);
    assert.equal(cards.sale.change_minor, null);
    for (const event of [terminal, manual, cards])
      assert.deepEqual(
        (await saleEvents(ctx.edge.pool, event.order.order_id)).map((e) => e.kind),
        ['sale', 'fiscal'],
      );
    const before = await counts(ctx.edge.pool);
    const q = await quote(ctx);
    for (const [body, expected] of [
      [
        {
          tenders: [
            { method: 'cash', amount_minor: '100000' },
            { method: 'cash', amount_minor: '249000' },
          ],
          cash_tendered_minor: '349000',
        },
        'INVALID_REQUEST',
      ],
      [
        {
          tenders: [
            { method: 'cash', amount_minor: '100000' },
            { method: 'staff_meal', amount_minor: '249000' },
          ],
          cash_tendered_minor: '100000',
          beneficiary: 'Синтетический получатель',
        },
        'INVALID_REQUEST',
      ],
      [
        {
          tenders: [
            { method: 'cash', amount_minor: '100000' },
            { method: 'kaspi_terminal', amount_minor: '200000' },
          ],
          cash_tendered_minor: '100000',
        },
        'TENDER_SUM_MISMATCH',
      ],
      [
        {
          tenders: [
            { method: 'cash', amount_minor: '149000' },
            { method: 'kaspi_terminal', amount_minor: '200000' },
          ],
          cash_tendered_minor: '100000',
        },
        'CASH_TENDERED_TOO_LOW',
      ],
      [
        {
          tenders: [
            { method: 'cash', amount_minor: '149000' },
            { method: 'kaspi_terminal', amount_minor: '200000' },
          ],
        },
        'INVALID_REQUEST',
      ],
      [
        {
          tenders: [{ method: 'kaspi_terminal', amount_minor: '349000' }],
          cash_tendered_minor: '1',
        },
        'INVALID_REQUEST',
      ],
      [
        {
          tenders: [
            { method: 'cash', amount_minor: '100000' },
            { method: 'kaspi_manual', amount_minor: '100000' },
            { method: 'kaspi_terminal', amount_minor: '149000' },
          ],
          cash_tendered_minor: '100000',
        },
        'INVALID_REQUEST',
      ],
    ])
      await assert.rejects(sell(ctx, sale(q, body)), code(expected));
    assert.deepEqual(await counts(ctx.edge.pool), before);
  });
});

test('kaspi_manual alone, receipt number at sale, terminal only in whole tenge', async () => {
  await desk(async (ctx) => {
    const manual = await sell(
      ctx,
      sale(await quote(ctx), {
        tenders: [{ method: 'kaspi_manual', amount_minor: '349000', reference: 'SYN-QR-77' }],
      }),
    );
    assert.deepEqual(
      manual.sale.tenders.map(({ method, confirmation, reference }) => ({
        method,
        confirmation,
        reference,
      })),
      [{ method: 'kaspi_manual', confirmation: 'cashier_attested', reference: 'SYN-QR-77' }],
    );
    assert.equal(manual.sale.fiscal[0].state, 'pending');
    // A Webkassa number typed with the sale records the receipt at once.
    const recorded = await sell(
      ctx,
      sale(await quote(ctx), {
        tenders: [{ method: 'kaspi_manual', amount_minor: '349000' }],
        fiscal_receipt_number: 'SYN-WK-0001',
      }),
    );
    assert.deepEqual(
      { ...recorded.sale.fiscal[0], receipt_id: undefined },
      {
        receipt_id: undefined,
        kind: 'sale',
        state: 'recorded',
        receipt_number: 'SYN-WK-0001',
        version: 1,
        amount_minor: '349000',
      },
    );
    const fiscal = (await saleEvents(ctx.edge.pool, recorded.order.order_id))[1].payload;
    assert.equal(fiscal.state, 'recorded');
    assert.equal(fiscal.recorded_by_staff_id, ctx.cashier.staff_id);
    assert.match(fiscal.recorded_at, /Z$/);
    // 1250.50 tenge: the terminal refuses the tiyn, Kaspi manual or a cash remainder take them.
    const drink = [{ variant_id: ctx.drink.variant_id, quantity: 1 }];
    const odd = await quote(ctx, { items: drink });
    assert.equal(odd.total_minor, '125050');
    const before = await counts(ctx.edge.pool);
    await assert.rejects(
      sell(ctx, sale(odd, { tenders: [{ method: 'kaspi_terminal', amount_minor: '125050' }] })),
      code('TERMINAL_AMOUNT_NOT_WHOLE'),
    );
    await assert.rejects(
      sell(
        ctx,
        sale(odd, {
          tenders: [
            { method: 'kaspi_terminal', amount_minor: '125010' },
            { method: 'cash', amount_minor: '40' },
          ],
          cash_tendered_minor: '100',
        }),
      ),
      code('TERMINAL_AMOUNT_NOT_WHOLE'),
    );
    assert.deepEqual(await counts(ctx.edge.pool), before);
    const split = await sell(
      ctx,
      sale(odd, {
        tenders: [
          { method: 'kaspi_terminal', amount_minor: '125000' },
          { method: 'cash', amount_minor: '50' },
        ],
        cash_tendered_minor: '100',
      }),
    );
    assert.equal(split.sale.change_minor, '50');
    const manualOdd = await sell(
      ctx,
      sale(await quote(ctx, { items: drink }), {
        tenders: [{ method: 'kaspi_manual', amount_minor: '125050' }],
      }),
    );
    assert.equal(manualOdd.sale.total_minor, '125050');
  });
});

test('ChocoFood: hall order with its own number, required, unique, alone', async () => {
  await desk(async (ctx) => {
    const tender = [{ method: 'chocofood', amount_minor: '349000' }];
    const q = await quote(ctx, { serviceMode: 'dine_in' });
    await assert.rejects(sell(ctx, sale(q, { tenders: tender })), code('EXTERNAL_REF_REQUIRED'));
    const paid = await sell(ctx, sale(q, { tenders: tender, external_order_ref: ' cf-1001 ' }));
    assert.equal(paid.sale.sales_channel, 'hall');
    assert.equal(paid.sale.pickup, 'issue');
    assert.equal(paid.sale.service_mode, 'dine_in');
    assert.equal(paid.sale.external_order_ref, 'CF-1001');
    assert.equal(paid.sale.tenders[0].confirmation, 'aggregator_attested');
    // Default fiscal policy of ChocoFood: no Webkassa receipt until the accountant decides.
    assert.equal(paid.sale.fiscal[0].state, 'not_required');
    const kitchen = await reservation(ctx.edge.pool, paid.order.order_id);
    assert.equal(kitchen.snapshot.serviceMode, 'dine_in');
    assert.equal('delivery' in kitchen.snapshot, false);
    const before = await counts(ctx.edge.pool);
    for (const ref of ['CF-1001', 'cf-1001'])
      await assert.rejects(
        sell(ctx, sale(await quote(ctx), { tenders: tender, external_order_ref: ref })),
        code('EXTERNAL_REF_DUPLICATE'),
      );
    await assert.rejects(
      sell(
        ctx,
        sale(await quote(ctx), {
          tenders: [
            { method: 'chocofood', amount_minor: '249000' },
            { method: 'cash', amount_minor: '100000' },
          ],
          cash_tendered_minor: '100000',
          external_order_ref: 'CF-1002',
        }),
      ),
      code('INVALID_REQUEST'),
    );
    // A number belongs only to ChocoFood or an aggregator.
    await assert.rejects(
      sell(
        ctx,
        sale(await quote(ctx), {
          tenders: [{ method: 'cash', amount_minor: '349000' }],
          cash_tendered_minor: '349000',
          external_order_ref: 'CF-1003',
        }),
      ),
      code('INVALID_REQUEST'),
    );
    assert.deepEqual(await counts(ctx.edge.pool), before);
  });
});

test('aggregators: channel prices, takeaway only, own method, required unique number, delivery', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    // Hall quote byte for byte as before; 'hall' is the absent field.
    const hall = await quote(ctx, { items: [line(ctx, 1, 2)] });
    const named = await quote(ctx, { items: [line(ctx, 1, 2)], channel: 'hall' });
    for (const q of [hall, named]) {
      assert.equal(q.total_minor, '389000');
      // The pre-cutover hall quote: same keys in the same order, no sales_channel.
      assert.deepEqual(Object.keys(q), [
        'quote_id',
        'branch_id',
        'release_id',
        'menu_version',
        'service_mode',
        'channel',
        'lines',
        'currency',
        'subtotal_minor',
        'discount_minor',
        'total_minor',
        'created_at',
        'expires_at',
      ]);
      assert.deepEqual(QuoteSchema.parse(q), q);
    }
    assert.deepEqual(
      {
        ...named,
        quote_id: hall.quote_id,
        created_at: hall.created_at,
        expires_at: hall.expires_at,
      },
      hall,
    );
    const yandex = await quote(ctx, { items: [line(ctx, 1, 2)], channel: 'yandex_eda' });
    assert.equal(yandex.sales_channel, 'yandex_eda');
    // Line at the channel price, the sauce at the hall surcharge (contracts 9 q.10).
    assert.equal(yandex.lines[0].unit_price_minor, '439000');
    assert.equal(yandex.lines[0].modifiers[0].price_minor, '20000');
    assert.equal(yandex.total_minor, '439000');
    const glovo = await quote(ctx, { channel: 'glovo' });
    assert.equal(glovo.total_minor, '389000');
    await assert.rejects(
      quote(ctx, { channel: 'glovo', items: [{ variant_id: ctx.drink.variant_id, quantity: 1 }] }),
      code('CHANNEL_PRICE_UNAVAILABLE'),
    );
    await assert.rejects(
      quote(ctx, { channel: 'yandex_eda', serviceMode: 'dine_in' }),
      code('INVALID_REQUEST'),
    );
    const before = await counts(pool);
    const own = [{ method: 'aggregator_yandex_eda', amount_minor: '439000' }];
    await assert.rejects(sell(ctx, sale(yandex, { tenders: own })), code('EXTERNAL_REF_REQUIRED'));
    for (const tenders of [
      [{ method: 'aggregator_glovo', amount_minor: '439000' }],
      [{ method: 'kaspi_terminal', amount_minor: '439000' }],
    ])
      await assert.rejects(
        sell(ctx, sale(yandex, { tenders, external_order_ref: 'YA-1' })),
        code('INVALID_REQUEST'),
      );
    // Aggregator methods never pay a hall order.
    await assert.rejects(
      sell(
        ctx,
        sale(hall, {
          tenders: [{ method: 'aggregator_yandex_eda', amount_minor: '389000' }],
          external_order_ref: 'YA-2',
        }),
      ),
      code('INVALID_REQUEST'),
    );
    assert.deepEqual(await counts(pool), before);
    const paid = await sell(ctx, sale(yandex, { tenders: own, external_order_ref: 'ya-777-abc' }));
    assert.equal(paid.sale.sales_channel, 'yandex_eda');
    assert.equal(paid.sale.pickup, 'delivery_handover');
    assert.equal(paid.sale.external_order_ref, 'YA-777-ABC');
    assert.equal(paid.sale.service_mode, 'takeaway');
    assert.equal(paid.sale.tenders[0].confirmation, 'aggregator_attested');
    assert.equal(paid.sale.fiscal[0].state, 'not_required');
    assert.equal(paid.order.snapshot.sales_channel, 'yandex_eda');
    const kitchen = await reservation(pool, paid.order.order_id);
    assert.equal(kitchen.admission_kind, 'pos_sale');
    assert.equal(kitchen.snapshot.channel, 'pos');
    assert.equal(kitchen.snapshot.serviceMode, 'takeaway');
    assert.deepEqual(kitchen.snapshot.delivery, {
      provider: 'yandex_eda',
      externalNumber: 'YA-777-ABC',
    });
    const [event] = await saleEvents(pool, paid.order.order_id);
    assert.equal(event.payload.sales_channel, 'yandex_eda');
    assert.equal(event.payload.quote.sales_channel, 'yandex_eda');
    // Unique per channel: the same number again in Yandex Eda is refused, in Glovo it is another order.
    await assert.rejects(
      sell(
        ctx,
        sale(await quote(ctx, { channel: 'yandex_eda' }), {
          tenders: [{ method: 'aggregator_yandex_eda', amount_minor: '399000' }],
          external_order_ref: 'YA-777-ABC',
        }),
      ),
      code('EXTERNAL_REF_DUPLICATE'),
    );
    const other = await sell(
      ctx,
      sale(glovo, {
        tenders: [{ method: 'aggregator_glovo', amount_minor: '389000' }],
        external_order_ref: 'YA-777-ABC',
      }),
    );
    assert.equal(other.sale.sales_channel, 'glovo');
    assert.deepEqual((await reservation(pool, other.order.order_id)).snapshot.delivery, {
      provider: 'glovo',
      externalNumber: 'YA-777-ABC',
    });
    // POST orders never takes an aggregator quote.
    await assert.rejects(
      createLocalOrder(
        pool,
        ctx.branch,
        staffAuth(ctx.cashier),
        randomUUID(),
        { quote_id: (await quote(ctx, { channel: 'glovo' })).quote_id },
        ctx.port,
      ),
      code('SERVICE_MODE_DISABLED'),
    );
  });
});

test('staff meal and marketing: approval, beneficiary or reason; without them nothing is written', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const q = await quote(ctx);
    const meal = { tenders: [{ method: 'staff_meal', amount_minor: '349000' }] };
    const before = await counts(pool);
    await assert.rejects(
      sell(ctx, sale(q, { ...meal, beneficiary: 'Синтетический повар' })),
      code('APPROVAL_REQUIRED'),
    );
    const approval = await approve(ctx, 'staff_meal', {
      quote_id: q.quote_id,
      amount_minor: '349000',
    });
    assert.deepEqual(ManagerApprovalSchema.parse(approval), approval);
    assert.deepEqual(approval.manager, {
      staff_id: ctx.manager.staff_id,
      name: 'Синтетический менеджер',
    });
    await assert.rejects(
      sell(ctx, sale(q, { ...meal, approval: proof(approval) })),
      code('INVALID_REQUEST'),
    );
    await assert.rejects(
      sell(
        ctx,
        sale(q, { ...meal, approval: proof(approval), beneficiary: 'Кто-то', reason: 'Лишнее' }),
      ),
      code('INVALID_REQUEST'),
    );
    assert.deepEqual(await counts(pool), before);
    assert.equal(await count(pool, 'local_manager_approvals', 'consumed_at IS NOT NULL'), 0);
    const key = randomUUID();
    const paid = await sell(
      ctx,
      sale(q, { ...meal, approval: proof(approval), beneficiary: 'Синтетический повар' }),
      { key },
    );
    assert.equal(paid.sale.revenue_kind, 'staff_meal');
    assert.equal(paid.sale.tenders[0].confirmation, 'manager_approved');
    assert.equal(paid.sale.fiscal[0].state, 'not_required');
    const stored = (
      await pool.query(
        'SELECT a.consumed_command_key,a.consumed_at,s.approval_id,s.beneficiary FROM local_manager_approvals a JOIN pos_sales s ON s.approval_id=a.id WHERE a.id=$1',
        [approval.approval_id],
      )
    ).rows[0];
    assert.equal(stored.consumed_command_key, key);
    assert.ok(stored.consumed_at);
    assert.equal(stored.beneficiary, 'Синтетический повар');
    const [event] = await saleEvents(pool, paid.order.order_id);
    assert.deepEqual(event.payload.approval, {
      approval_id: approval.approval_id,
      manager_staff_id: ctx.manager.staff_id,
      action: 'staff_meal',
    });
    assert.equal(event.payload.beneficiary, 'Синтетический повар');
    // Marketing: a reason and its own approval.
    const m = await quote(ctx);
    const promo = { tenders: [{ method: 'marketing', amount_minor: '349000' }] };
    await assert.rejects(
      sell(ctx, sale(m, { ...promo, reason: 'Синтетическая дегустация' })),
      code('APPROVAL_REQUIRED'),
    );
    const marketing = await approve(ctx, 'marketing', {
      quote_id: m.quote_id,
      amount_minor: '349000',
    });
    const free = await sell(
      ctx,
      sale(m, { ...promo, reason: 'Синтетическая дегустация', approval: proof(marketing) }),
    );
    assert.equal(free.sale.revenue_kind, 'marketing');
    assert.equal(
      (await saleEvents(pool, free.order.order_id))[0].payload.reason,
      'Синтетическая дегустация',
    );
    // A revenue sale never carries (and so never spends) an approval.
    const unused = await approve(ctx, 'staff_meal', {
      quote_id: m.quote_id,
      amount_minor: '349000',
    });
    await assert.rejects(
      sell(
        ctx,
        sale(await quote(ctx), {
          tenders: [{ method: 'cash', amount_minor: '349000' }],
          cash_tendered_minor: '349000',
          approval: proof(unused),
        }),
      ),
      code('INVALID_REQUEST'),
    );
  });
});

test('approval: wrong PIN, not a manager, expired, other desk, wrong action or amount, reused', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const q = await quote(ctx);
    const subject = { quote_id: q.quote_id, amount_minor: '349000' };
    const body = (approval) =>
      sale(q, {
        tenders: [{ method: 'staff_meal', amount_minor: '349000' }],
        beneficiary: 'Синтетический повар',
        approval: proof(approval),
      });
    // PIN checks (this test stays under the desk window of 10 attempts per minute).
    await assert.rejects(
      approve(ctx, 'staff_meal', subject, { pin: '9999' }),
      code('UNAUTHORIZED'),
    );
    // CR client-2 1: the desk may name itself; the PIN's owner, a shift manager, approves.
    assert.equal(
      (await approve(ctx, 'staff_meal', subject, { staff: ctx.cashier })).manager.staff_id,
      ctx.manager.staff_id,
    );
    // Naming someone else still checks that person: the manager's PIN is not theirs.
    await assert.rejects(
      approve(ctx, 'staff_meal', subject, { staff: ctx.second }),
      code('UNAUTHORIZED'),
    );
    await assert.rejects(
      approve(ctx, 'staff_meal', subject, { staff: ctx.cashier, pin: CASHIER_PIN }),
      code('FORBIDDEN'),
    );
    await assert.rejects(
      requestManagerApproval(pool, ctx.branch, staffAuth(ctx.cashier), {
        staff_id: ctx.manager.staff_id,
        pin: PIN,
        action: 'staff_meal',
        subject: { quote_id: q.quote_id },
      }),
      code('INVALID_REQUEST'),
    );
    const issued = await approve(ctx, 'staff_meal', subject);
    const row = (
      await pool.query('SELECT * FROM local_manager_approvals WHERE id=$1', [issued.approval_id])
    ).rows[0];
    assert.equal(row.terminal_id, ctx.cashier.terminal_id);
    assert.equal(row.requested_by_staff_id, ctx.cashier.staff_id);
    assert.equal(row.manager_staff_id, ctx.manager.staff_id);
    assert.equal(row.token_hash, hashToken(issued.token));
    assert.equal(row.subject_hash, approvalSubjectHash('staff_meal', subject));
    const ttl = (row.expires_at - row.created_at) / 1000;
    assert.ok(ttl > 119 && ttl <= 120, String(ttl));
    assert.equal(await count(pool, 'local_manager_approvals', 'token_hash=$1', [issued.token]), 0);
    const before = await counts(pool);
    // Another desk's approval (1 attempt on the second desk).
    const elsewhere = await approve(ctx, 'staff_meal', subject, { actor: ctx.second });
    await assert.rejects(sell(ctx, body(elsewhere)), code('APPROVAL_INVALID'));
    // Wrong action, wrong amount, wrong token.
    const marketing = await approve(ctx, 'marketing', subject);
    await assert.rejects(sell(ctx, body(marketing)), code('APPROVAL_INVALID'));
    const cheaper = await approve(ctx, 'staff_meal', { ...subject, amount_minor: '1000' });
    await assert.rejects(sell(ctx, body(cheaper)), code('APPROVAL_INVALID'));
    await assert.rejects(
      sell(ctx, body({ ...issued, token: randomBytes(32).toString('hex') })),
      code('APPROVAL_INVALID'),
    );
    // Expired: an approval of one second (the schema allows at most 120).
    const expired = { approval_id: randomUUID(), token: randomBytes(32).toString('hex') };
    await pool.query(
      `INSERT INTO local_manager_approvals(id,branch_id,terminal_id,manager_staff_id,requested_by_staff_id,
       action,subject,subject_hash,token_hash,expires_at)
       VALUES($1,$2,$3,$4,$5,'staff_meal',$6,$7,$8,clock_timestamp()+interval '1 second')`,
      [
        expired.approval_id,
        ctx.branch,
        ctx.cashier.terminal_id,
        ctx.manager.staff_id,
        ctx.cashier.staff_id,
        subject,
        approvalSubjectHash('staff_meal', subject),
        hashToken(expired.token),
      ],
    );
    await sleep(1200);
    await assert.rejects(sell(ctx, body(expired)), code('APPROVAL_INVALID'));
    // Already spent by another command.
    await pool.query(
      'UPDATE local_manager_approvals SET consumed_at=clock_timestamp(),consumed_command_key=$2 WHERE id=$1',
      [issued.approval_id, randomUUID()],
    );
    await assert.rejects(sell(ctx, body(issued)), code('APPROVAL_INVALID'));
    // A manager who lost the role after typing the PIN.
    const fired = await approve(ctx, 'staff_meal', subject);
    await pool.query('UPDATE local_staff SET active=false WHERE id=$1', [ctx.manager.staff_id]);
    await assert.rejects(sell(ctx, body(fired)), code('APPROVAL_INVALID'));
    assert.deepEqual(await counts(pool), before);
    await pool.query('UPDATE local_staff SET active=true WHERE id=$1', [ctx.manager.staff_id]);
    assert.equal((await sell(ctx, body(fired))).sale.revenue_kind, 'staff_meal');
  });
});

test('Idempotency-Key: same body replays without spending again, another body conflicts', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const q = await quote(ctx);
    const approval = await approve(ctx, 'staff_meal', {
      quote_id: q.quote_id,
      amount_minor: '349000',
    });
    const key = randomUUID();
    const body = sale(q, {
      tenders: [{ method: 'staff_meal', amount_minor: '349000' }],
      beneficiary: 'Синтетический повар',
      approval: proof(approval),
    });
    const [first, again] = await Promise.all([sell(ctx, body, { key }), sell(ctx, body, { key })]);
    assert.deepEqual(first, again);
    const spent = async () =>
      (
        await pool.query(
          'SELECT consumed_at,consumed_command_key FROM local_manager_approvals WHERE id=$1',
          [approval.approval_id],
        )
      ).rows[0];
    const once = await spent();
    assert.equal(once.consumed_command_key, key);
    assert.deepEqual(await sell(ctx, body, { key }), first);
    assert.deepEqual(await spent(), once);
    await assert.rejects(
      sell(ctx, { ...body, beneficiary: 'Другой получатель' }, { key }),
      code('CONFLICT'),
    );
    // Another key for the same quote is a second order attempt.
    await assert.rejects(sell(ctx, body), code('CONFLICT'));
    assert.equal(await count(pool, 'pos_sales'), 1);
    assert.equal(await count(pool, 'pos_sale_outbox'), 2);
  });
});

test('mode: off outside pos_sale; POST orders refused in pos_sale; open sales shift required', async () => {
  await desk(
    async (ctx) => {
      const q = await quote(ctx);
      await assert.rejects(
        sell(
          ctx,
          sale(q, {
            tenders: [{ method: 'cash', amount_minor: '349000' }],
            cash_tendered_minor: '349000',
          }),
        ),
        code('SERVICE_MODE_DISABLED'),
      );
      await assert.rejects(quote(ctx, { channel: 'yandex_eda' }), code('SERVICE_MODE_DISABLED'));
      const config = await readPosConfig(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier));
      assert.equal(config.mode, 'unpaid_service');
      assert.ok(config.methods.every((method) => !method.enabled));
      // The unpaid flow is untouched.
      const order = await createLocalOrder(
        ctx.edge.pool,
        ctx.branch,
        staffAuth(ctx.cashier),
        randomUUID(),
        { quote_id: q.quote_id, kitchen_admission: 'unpaid' },
        ctx.port,
      );
      assert.equal(order.execution_mode, 'unpaid_service');
      assert.equal(order.state, 'awaiting_payment');
      assert.equal(
        (await reservation(ctx.edge.pool, order.order_id)).admission_kind,
        'unpaid_service',
      );
      const kitchen = (
        await ctx.edge.pool.query('SELECT payload FROM fulfillment_outbox WHERE order_id=$1', [
          order.order_id,
        ])
      ).rows;
      assert.equal(kitchen[0].payload.executionMode, 'unpaid_service');
      assert.equal(await count(ctx.edge.pool, 'pos_sale_outbox'), 0);
    },
    { mode: 'unpaid_service' },
  );
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    for (const input of [{}, { kitchen_admission: 'unpaid' }])
      await assert.rejects(
        createLocalOrder(
          pool,
          ctx.branch,
          staffAuth(ctx.cashier),
          randomUUID(),
          { quote_id: (await quote(ctx)).quote_id, ...input },
          ctx.port,
        ),
        code('SERVICE_MODE_DISABLED'),
      );
    const cash = (q) =>
      sale(q, {
        tenders: [{ method: 'cash', amount_minor: '349000' }],
        cash_tendered_minor: '349000',
      });
    // Without the kitchen wiring of the host there is no paid sale.
    await assert.rejects(
      sell(ctx, cash(await quote(ctx)), { port: null }),
      code('SERVICE_MODE_DISABLED'),
    );
    const third = await provisionStaff(pool, ctx.branch, ctx.setup('cashier'));
    await assert.rejects(
      sell(ctx, cash(await quote(ctx, { actor: third })), { actor: third }),
      code('CASH_SHIFT_REQUIRED'),
    );
    // A disabled kitchen admission rolls the whole sale back.
    await assert.rejects(
      sell(ctx, cash(await quote(ctx)), {
        port: localUnpaidExecution({ enabled: false, deviceId: ctx.device }),
      }),
      code('KITCHEN_UNAVAILABLE'),
    );
    for (const table of SALE_TABLES) assert.equal(await count(pool, table), 0, table);
  });
});

test('method disabled: refused before an approval is asked; config shows methods and channels', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    await setMethod(pool, ctx.branch, 'cash', { enabled: false });
    await setMethod(pool, ctx.branch, 'staff_meal', { enabled: false });
    await setMethod(pool, ctx.branch, 'aggregator_glovo', { enabled: false });
    await setMethod(pool, ctx.branch, 'kaspi_terminal', { fiscal_policy: 'not_required' });
    await assert.rejects(
      sell(
        ctx,
        sale(await quote(ctx), {
          tenders: [{ method: 'cash', amount_minor: '349000' }],
          cash_tendered_minor: '349000',
        }),
      ),
      code('METHOD_DISABLED'),
    );
    await assert.rejects(
      sell(
        ctx,
        sale(await quote(ctx), {
          tenders: [
            { method: 'cash', amount_minor: '49000' },
            { method: 'kaspi_terminal', amount_minor: '300000' },
          ],
          cash_tendered_minor: '49000',
        }),
      ),
      code('METHOD_DISABLED'),
    );
    await assert.rejects(
      sell(
        ctx,
        sale(await quote(ctx), {
          tenders: [{ method: 'staff_meal', amount_minor: '349000' }],
          beneficiary: 'Синтетический повар',
        }),
      ),
      code('METHOD_DISABLED'),
    );
    for (const table of SALE_TABLES) assert.equal(await count(pool, table), 0, table);
    // The operator's fiscal policy decides the receipt (kaspi_terminal now needs none).
    const terminal = await sell(
      ctx,
      sale(await quote(ctx), { tenders: [{ method: 'kaspi_terminal', amount_minor: '349000' }] }),
    );
    assert.equal(terminal.sale.fiscal[0].state, 'not_required');
    const config = await readPosConfig(pool, ctx.branch, staffAuth(ctx.cashier));
    assert.deepEqual(PosConfigSchema.parse(config), config);
    assert.equal(config.mode, 'pos_sale');
    const methods = Object.fromEntries(config.methods.map(({ code: method, ...m }) => [method, m]));
    assert.deepEqual(Object.keys(methods), ALL);
    assert.equal(methods.cash.enabled, false);
    assert.equal(methods.staff_meal.enabled, false);
    assert.equal(methods.kaspi_manual.enabled, true);
    assert.equal(methods.kaspi_terminal.fiscal_policy, 'not_required');
    assert.deepEqual(config.channels, [
      { code: 'hall', enabled: true },
      { code: 'yandex_eda', enabled: true },
      { code: 'glovo', enabled: false },
    ]);
  });
});

test('two cash desks sell in parallel: each on its own shift, distinct numbers, one stream', async () => {
  await desk(async (ctx) => {
    const pool = ctx.edge.pool;
    const desks = [ctx.cashier, ctx.second, ctx.cashier, ctx.second, ctx.cashier, ctx.second];
    const quotes = await Promise.all(desks.map((actor) => quote(ctx, { actor })));
    const results = await Promise.all(
      desks.map((actor, index) =>
        sell(
          ctx,
          sale(quotes[index], {
            tenders: [{ method: 'cash', amount_minor: '349000' }],
            cash_tendered_minor: '500000',
          }),
          { actor },
        ),
      ),
    );
    results.forEach((result, index) =>
      assert.equal(
        result.sale.shift_id,
        desks[index] === ctx.cashier ? ctx.shifts.first : ctx.shifts.second,
      ),
    );
    assert.equal(new Set(results.map((r) => r.sale.display_number)).size, desks.length);
    const sequences = (
      await pool.query('SELECT sequence,kind FROM pos_sale_outbox ORDER BY sequence')
    ).rows;
    assert.equal(sequences.length, desks.length * 2);
    // Each sale's events are adjacent (sale then receipt): the branch lock serializes sales.
    for (let index = 0; index < sequences.length; index += 2)
      assert.deepEqual([sequences[index].kind, sequences[index + 1].kind], ['sale', 'fiscal']);
    // The same aggregator number typed on both desks at once is sold once.
    const both = await Promise.allSettled(
      [ctx.cashier, ctx.second].map(async (actor) =>
        sell(
          ctx,
          sale(await quote(ctx, { actor, channel: 'yandex_eda' }), {
            tenders: [{ method: 'aggregator_yandex_eda', amount_minor: '399000' }],
            external_order_ref: 'YA-DESK-1',
          }),
          { actor },
        ),
      ),
    );
    assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(both.find((r) => r.status === 'rejected').reason.code, 'EXTERNAL_REF_DUPLICATE');
    // Each desk sees its own sales; the shift manager sees both.
    await assert.rejects(
      readPosSale(pool, ctx.branch, staffAuth(ctx.second), results[0].order.order_id),
      code('NOT_FOUND'),
    );
    assert.equal(
      (await readPosSale(pool, ctx.branch, staffAuth(ctx.manager), results[1].order.order_id))
        .terminal_id,
      ctx.second.terminal_id,
    );
  });
});

test('without a KDS layout a paid sale is admitted like an unpaid order and cooked to handoff', async () => {
  await desk(
    async (ctx) => {
      const pool = ctx.edge.pool;
      const items = [line(ctx, 2, 1), { variant_id: ctx.drink.variant_id, quantity: 1 }];
      const unpaid = await createLocalOrder(
        pool,
        ctx.branch,
        staffAuth(ctx.cashier),
        randomUUID(),
        { quote_id: (await quote(ctx, { items })).quote_id, kitchen_admission: 'unpaid' },
        ctx.port,
      );
      await closeShifts(pool);
      await switchMode(pool, ctx.branch, 'unpaid_service', 'pos_sale');
      for (const method of ALL) await setMethod(pool, ctx.branch, method, { enabled: true });
      await salesShift(pool, ctx.branch, ctx.manager, ctx.cashier.terminal_id);
      const paid = await sell(
        ctx,
        sale(await quote(ctx, { items }), {
          tenders: [{ method: 'kaspi_manual', amount_minor: '863050' }],
        }),
      );
      const [a, b] = [
        await reservation(pool, unpaid.order_id),
        await reservation(pool, paid.order.order_id),
      ];
      const routing = RoutingSchema.parse(ctx.routing);
      for (const row of [a, b]) {
        assert.deepEqual(row.task_plan, taskPlan(row.snapshot, routing));
        assert.equal(row.assembly_station_id, ctx.assembly);
        assert.equal(row.routing_version, 1);
        assert.equal(row.state, 'accepted');
      }
      // Same snapshot and plan up to the fresh line ids, totals and the admission kind.
      const lineIds = (row) => row.snapshot.lines.map((l) => l.lineId);
      const normalize = (row) => {
        const ids = lineIds(row);
        return JSON.parse(
          JSON.stringify({ snapshot: row.snapshot, plan: row.task_plan }).replace(
            new RegExp(ids.join('|'), 'g'),
            (id) => `line-${ids.indexOf(id)}`,
          ),
        );
      };
      assert.deepEqual(normalize(b), normalize(a));
      assert.deepEqual([a.admission_kind, b.admission_kind], ['unpaid_service', 'pos_sale']);
      const tasks = async (orderId) =>
        (
          await pool.query(
            `SELECT station_id,kind,state,routing_version,details->>'title' AS title,
             details->'quantity' AS quantity FROM fulfillment_tasks WHERE order_id=$1 ORDER BY 5,6`,
            [orderId],
          )
        ).rows;
      assert.deepEqual(await tasks(paid.order.order_id), await tasks(unpaid.order_id));
      // The kitchen runs the paid order through its usual lifecycle.
      const cook = await provisionStaff(pool, ctx.branch, ctx.setup('kitchen'));
      await grantStation(pool, ctx.branch, cook.staff_id, ctx.prep);
      await grantStation(pool, ctx.branch, cook.staff_id, ctx.assembly);
      const repo = new EdgeFulfillment(pool);
      const act = (current, action, extra = {}) =>
        repo.act(ctx.branch, staffAuth(cook), {
          commandId: randomUUID(),
          orderId: current.orderId,
          expectedVersion: current.version,
          action,
          ...extra,
        });
      let current = await repo.readOrder(ctx.branch, staffAuth(cook), paid.order.order_id, {
        stationId: ctx.prep,
      });
      assert.equal(current.tasks.length, 2);
      for (const task of current.tasks) {
        current = await act(current, 'start_task', {
          taskId: task.id,
          expectedTaskVersion: task.version,
        });
        current = await act(current, 'complete_task', {
          taskId: task.id,
          expectedTaskVersion: task.version + 1,
        });
      }
      current = await act(current, 'ready');
      assert.equal((await act(current, 'handoff')).state, 'handed_over');
      const done = await readLocalOrder(
        pool,
        ctx.branch,
        staffAuth(ctx.cashier),
        paid.order.order_id,
      );
      assert.equal(done.state, 'paid');
      assert.equal(done.version, 1);
      assert.equal(done.fulfillment.state, 'handed_over');
      const events = (
        await pool.query(
          'SELECT event_type,payload FROM fulfillment_outbox WHERE order_id=$1 ORDER BY sequence',
          [paid.order.order_id],
        )
      ).rows;
      assert.equal(events.at(-1).event_type, 'edge.fulfillment_handed_over');
      assert.ok(events.every((event) => event.payload.executionMode === 'pos_sale'));
    },
    { mode: 'unpaid_service' },
  );
});

test('GET pos/config: 404 on an edge without schema026; fetch record per desk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pos-sales-'));
  try {
    const before026 = join(root, 'edge');
    await mkdir(before026);
    for (const file of await readdir(edgeDir))
      if (/^\d{3}_[a-z_]+\.sql$/.test(file) && file < '026')
        await copyFile(join(edgeDir, file), join(before026, file));
    await desk(
      async (ctx) => {
        const auth = staffAuth(ctx.cashier);
        await assert.rejects(readPosConfig(ctx.edge.pool, ctx.branch, auth), code('NOT_FOUND'));
        await assert.rejects(
          readPosSale(ctx.edge.pool, ctx.branch, auth, randomUUID()),
          code('NOT_FOUND'),
        );
        await assert.rejects(
          approve(ctx, 'staff_meal', { quote_id: randomUUID(), amount_minor: '1' }),
          code('NOT_FOUND'),
        );
        const q = await quote(ctx);
        assert.equal('sales_channel' in q, false);
        await assert.rejects(
          sell(
            ctx,
            sale(q, { tenders: [{ method: 'kaspi_manual', amount_minor: q.total_minor }] }),
          ),
          code('SERVICE_MODE_DISABLED'),
        );
        await assert.rejects(quote(ctx, { channel: 'glovo' }), code('SERVICE_MODE_DISABLED'));
        const server = await running(createEdge, ctx.edge.config);
        try {
          const response = await request(server.url + '/edge/v1/pos/config', {
            headers: staffHeaders(ctx.cashier),
          });
          assert.equal(response.status, 404);
          assert.equal((await response.json()).code, 'NOT_FOUND');
        } finally {
          await server.app.close();
        }
      },
      { mode: 'unpaid_service', edgeMigrationDirectory: before026 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  await desk(
    async (ctx) => {
      const pool = ctx.edge.pool;
      const config = await readPosConfig(pool, ctx.branch, staffAuth(ctx.cashier));
      assert.deepEqual(
        { ...config, server_time: undefined },
        {
          mode: 'payment_required',
          methods: ALL.map((method) => ({
            code: method,
            enabled: false,
            requires_approval: POS_PAYMENT_METHOD_POLICY[method].requires_approval,
            allow_in_mix: POS_PAYMENT_METHOD_POLICY[method].allow_in_mix,
            fiscal_policy: POS_PAYMENT_METHOD_POLICY[method].fiscal_policy,
          })),
          channels: [
            { code: 'hall', enabled: false },
            { code: 'yandex_eda', enabled: false },
            { code: 'glovo', enabled: false },
          ],
          fiscal_mode: 'manual_webkassa',
          approval_ttl_seconds: 120,
          server_time: undefined,
        },
      );
      const fetch = async () =>
        (
          await pool.query('SELECT * FROM pos_config_fetches WHERE terminal_id=$1', [
            ctx.cashier.terminal_id,
          ])
        ).rows;
      const [first] = await fetch();
      assert.equal(first.staff_id, ctx.cashier.staff_id);
      assert.equal(first.client_version, null);
      await readPosConfig(pool, ctx.branch, staffAuth(ctx.manager), 'pos-2.0.0');
      const [next] = await fetch();
      assert.equal(next.staff_id, ctx.manager.staff_id);
      assert.equal(next.client_version, 'pos-2.0.0');
      assert.ok(next.last_fetched_at >= first.last_fetched_at);
      assert.equal(next.first_fetched_at.getTime(), first.first_fetched_at.getTime());
      for (const bad of ['bad version', '', ['pos-2.0.0']])
        await assert.rejects(
          readPosConfig(pool, ctx.branch, staffAuth(ctx.cashier), bad),
          code('INVALID_REQUEST'),
        );
      const cook = await provisionStaff(pool, ctx.branch, ctx.setup('kitchen'));
      await assert.rejects(readPosConfig(pool, ctx.branch, staffAuth(cook)), code('FORBIDDEN'));
      assert.equal(await count(pool, 'pos_config_fetches'), 1);
    },
    { mode: 'payment_required' },
  );
});

test('HTTP: pos/config, approvals with the staff/pin backoff, sales, replay and error codes', async () => {
  await desk(async (ctx) => {
    const server = await running(createEdge, {
      ...ctx.edge.config,
      edgeFulfillmentEnabled: true,
      edgeDeviceId: ctx.device,
    });
    // Until CR pos-1 adds the POS codes to ErrorSchema the error filter answers CONFLICT.
    const wire = (expected) =>
      ErrorSchema.shape.code.options.includes(expected) ? expected : 'CONFLICT';
    try {
      const url = (path) => server.url + '/edge/v1/' + path;
      const post = (path, body, actor = ctx.cashier, key = randomUUID()) =>
        request(url(path), {
          method: 'POST',
          headers: staffHeaders(actor, key),
          body: JSON.stringify(body),
        });
      const config = await request(url('pos/config?client_version=pos-2.1.0'), {
        headers: staffHeaders(ctx.cashier),
      });
      assert.equal(config.status, 200);
      assert.equal(config.headers.get('cache-control'), 'no-store');
      assert.equal(PosConfigSchema.parse(await config.json()).mode, 'pos_sale');
      assert.equal(
        (
          await request(url('pos/config?client_version=bad%20one'), {
            headers: staffHeaders(ctx.cashier),
          })
        ).status,
        400,
      );
      const quoted = await post('checkout/quotes', {
        release_id: ctx.release.release_id,
        service_mode: 'takeaway',
        items: [line(ctx)],
      });
      assert.equal(quoted.status, 201);
      const q = await quoted.json();
      assert.equal('sales_channel' in q, false);
      const aggregator = await post('checkout/quotes', {
        release_id: ctx.release.release_id,
        service_mode: 'takeaway',
        items: [line(ctx)],
        sales_channel: 'glovo',
      });
      assert.equal(aggregator.status, 201);
      assert.equal((await aggregator.json()).sales_channel, 'glovo');
      // The PIN backoff of a desk is shared with staff/pin: 5 free typos, then a lock.
      const wrong = { staff_id: ctx.manager.staff_id, pin: '0000', action: 'staff_meal' };
      const subject = { quote_id: q.quote_id, amount_minor: q.total_minor };
      for (let attempt = 0; attempt < 5; attempt++)
        assert.equal(
          (await post('staff/approvals', { ...wrong, subject }, ctx.second)).status,
          401,
        );
      const locked = await post('staff/approvals', { ...wrong, pin: PIN, subject }, ctx.second);
      assert.equal(locked.status, 429);
      assert.equal((await locked.json()).code, 'AUTH_RATE_LIMITED');
      assert.match(locked.headers.get('retry-after'), /^[1-9][0-9]*$/);
      const pinLogin = await request(url('staff/pin'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: PIN, terminal_id: ctx.second.terminal_id }),
      });
      assert.equal(pinLogin.status, 429);
      // The first desk is not affected.
      const issued = await post('staff/approvals', {
        staff_id: ctx.manager.staff_id,
        pin: PIN,
        action: 'staff_meal',
        subject,
      });
      assert.equal(issued.status, 201);
      assert.equal(issued.headers.get('cache-control'), 'no-store');
      const approval = ManagerApprovalSchema.parse(await issued.json());
      const key = randomUUID();
      const body = sale(q, {
        tenders: [{ method: 'staff_meal', amount_minor: q.total_minor }],
        beneficiary: 'Синтетический повар',
        approval: proof(approval),
      });
      const created = await post('pos/sales', body, ctx.cashier, key);
      assert.equal(created.status, 201);
      const result = PosSaleResultSchema.parse(await created.json());
      const replay = await post('pos/sales', body, ctx.cashier, key);
      assert.equal(replay.status, 201);
      assert.deepEqual(await replay.json(), result);
      const conflict = await post(
        'pos/sales',
        { ...body, beneficiary: 'Другой' },
        ctx.cashier,
        key,
      );
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json()).code, 'CONFLICT');
      const read = await request(url('pos/sales/' + result.order.order_id), {
        headers: staffHeaders(ctx.cashier),
      });
      assert.equal(read.status, 200);
      assert.deepEqual(PosSaleSchema.parse(await read.json()), result.sale);
      const order = await request(url('orders/' + result.order.order_id), {
        headers: staffHeaders(ctx.cashier),
      });
      assert.deepEqual(LocalOrderSchema.parse(await order.json()), result.order);
      const q2 = await (
        await post('checkout/quotes', {
          release_id: ctx.release.release_id,
          service_mode: 'dine_in',
          items: [line(ctx)],
        })
      ).json();
      const mismatch = await post(
        'pos/sales',
        sale(q2, { tenders: [{ method: 'kaspi_manual', amount_minor: '1' }] }),
      );
      assert.equal(mismatch.status, 409);
      assert.equal((await mismatch.json()).code, wire('TENDER_SUM_MISMATCH'));
      const orders = await post('orders', { quote_id: q2.quote_id });
      assert.equal(orders.status, 409);
      assert.equal((await orders.json()).code, 'SERVICE_MODE_DISABLED');
      const invalid = await post('pos/sales', { ...sale(q2, { tenders: [] }) });
      assert.equal(invalid.status, 400);
      assert.equal((await post('staff/approvals', { pin: PIN })).status, 400);
      const anonymous = await request(url('staff/approvals'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staff_id: ctx.manager.staff_id, pin: PIN, action: 'void', subject }),
      });
      assert.equal(anonymous.status, 401);
      assert.equal(
        (await request(url('pos/sales/' + randomUUID()), { headers: staffHeaders(ctx.cashier) }))
          .status,
        404,
      );
    } finally {
      await server.app.close();
    }
  });
});

test('a restricted runtime LOGIN with the 5.9 grants sells; any failure leaves nothing behind', async () => {
  await desk(async (ctx) => {
    const role = 'pos_sale_' + randomUUID().replaceAll('-', ''),
      password = randomBytes(32).toString('hex');
    let pool;
    try {
      await ctx.edge.admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
      await applyEdgeRuntimeGrants(ctx.edge.pool, role, {
        schema: ctx.edge.schema,
        fulfillment: true,
      });
      await ctx.edge.pool.query(posSalesRuntimeGrants(role, ctx.edge.schema));
      const url = new URL(ctx.edge.config.databaseUrl);
      url.username = role;
      url.password = password;
      pool = createPool(url.toString());
      const restricted = { ...ctx, edge: { ...ctx.edge, pool } };
      assert.equal(
        (await readPosConfig(pool, ctx.branch, staffAuth(ctx.cashier))).mode,
        'pos_sale',
      );
      const q = await quote(restricted);
      const approval = await approve(restricted, 'marketing', {
        quote_id: q.quote_id,
        amount_minor: q.total_minor,
      });
      const body = sale(q, {
        tenders: [{ method: 'marketing', amount_minor: q.total_minor }],
        reason: 'Синтетическая дегустация',
        approval: proof(approval),
      });
      // An outbox fault rolls back the order, kitchen, tenders, receipt and the approval.
      await ctx.edge.pool
        .query(`CREATE FUNCTION fail_pos_sale_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Synthetic fault'; END $$;
        CREATE TRIGGER fail_pos_sale_outbox BEFORE INSERT ON pos_sale_outbox FOR EACH ROW EXECUTE FUNCTION fail_pos_sale_outbox()`);
      const key = randomUUID();
      await assert.rejects(sell(restricted, body, { key }));
      for (const table of [...SALE_TABLES, 'outbox_events'])
        assert.equal(
          await count(
            ctx.edge.pool,
            table,
            table === 'outbox_events' ? "event_type='order.created'" : 'true',
          ),
          0,
          table,
        );
      assert.equal(
        await count(ctx.edge.pool, 'local_manager_approvals', 'consumed_at IS NOT NULL'),
        0,
      );
      await ctx.edge.pool.query('DROP TRIGGER fail_pos_sale_outbox ON pos_sale_outbox');
      const paid = await sell(restricted, body, { key });
      assert.equal(paid.sale.revenue_kind, 'marketing');
      const cash = await sell(
        restricted,
        sale(await quote(restricted), {
          tenders: [{ method: 'cash', amount_minor: '349000' }],
          cash_tendered_minor: '349000',
        }),
      );
      assert.equal(cash.sale.change_minor, '0');
      assert.deepEqual(
        await readPosSale(pool, ctx.branch, staffAuth(ctx.cashier), cash.order.order_id),
        cash.sale,
      );
      // The runtime still cannot touch operator settings or rewrite history.
      for (const sql of [
        "UPDATE branch_config SET pos_service_mode='unpaid_service'",
        'UPDATE pos_payment_methods SET enabled=false',
        'UPDATE pos_sales SET total_minor=total_minor',
        'DELETE FROM pos_sale_tenders',
        'UPDATE pos_sale_outbox SET acknowledged_at=clock_timestamp()',
        'UPDATE local_manager_approvals SET expires_at=expires_at',
      ])
        await assert.rejects(pool.query(sql), code('42501'), sql);
    } finally {
      if (pool) await pool.end();
      await ctx.edge.admin.query(`DROP OWNED BY ${role}`);
      await ctx.edge.admin.query(`DROP ROLE ${role}`);
    }
  });
});
