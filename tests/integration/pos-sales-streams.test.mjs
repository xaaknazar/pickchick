import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { transaction } from '@pickchick/database';
import { createApi } from '@pickchick/api';
import { applyMenu, hashJson, provisionDevice, publishMenu } from '@pickchick/menu-sync';
import {
  cancelLocalOrder,
  closeCashShift,
  createLocalOrder,
  createPosSale,
  createQuote,
  fenceRestoredEdge,
  moveCash,
  openCashShift,
  provisionStaff,
  readCashShift,
  recordFiscalReceipt,
  refundPosSale,
  requestManagerApproval,
  setOrdering,
  setStaffPin,
  voidPosSale,
} from '@pickchick/local-orders';
import {
  EdgeFulfillment,
  grantStation,
  localUnpaidExecution,
  provisionFulfillment,
} from '@pickchick/edge-fulfillment';
import { PosPaymentMethodSchema } from '@pickchick/contracts';
import {
  parseEvent,
  parseKitchenEvent,
  parsePosSaleBatch,
  provisionCloudPosSync,
  provisionEdgePosSync,
  syncPosKitchenOnce,
  syncPosOrdersOnce,
} from '@pickchick/pos-order-sync';
import {
  CashierReportReceiptSchema,
  CashierReportsSchema,
  acknowledgeCashierReports,
  pendingCashierReports,
  receiveCashierReports,
} from '../../packages/fulfillment-transport/dist/cashier-reports.js';
import { Backoffice, grantBackoffice } from '../../packages/backoffice-core/dist/index.js';
import { provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import { running, withSyncDatabases } from '../helpers/sync.mjs';
import { staffAuth } from '../helpers/orders.mjs';

// POS-6 (contracts 5.6 end): a paid POS day reaches the cloud through the three old streams
// (order_commercial, kitchen, cashier reports) next to the posSales outbox; with pos_sale off
// those streams stay byte-identical. Synthetic data only: menu, staff, PIN and numbers are made up.
const PIN = '2468';
const cloudDir = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));

/**
 * Frozen D0 cashier report shapes (5b212949, cashier-reports.ts:10-77): the exact payload keys
 * and the enums that POS-6 widened. Value formats are unchanged and checked by the real parser.
 */
const FROZEN = {
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
const frozenAccepts = ({ kind, payload }) =>
  Object.keys(payload).sort().join() === [...FROZEN[kind].keys].sort().join() &&
  Object.entries(FROZEN[kind].enums).every(([key, values]) => values.includes(payload[key]));

async function setting(pool, branch, subject, before, after, update) {
  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO pos_sales_setting_changes(change_id,branch_id,subject,before,after,actor,reason)
       VALUES($1,$2,$3,$4,$5,'operator','Синтетическая настройка')`,
      [randomUUID(), branch, subject, before, after],
    );
    await update(client);
  });
}

/** One cash desk with kitchen, POS sync on both sides and the cloud API (posOrderSyncEnabled). */
async function streamDesk(run, { mode = 'pos_sale', cloudMigrationDirectory } = {}) {
  await withSyncDatabases(
    async (ctx) => {
      const edge = ctx.edge.pool;
      const base = ctx.menu();
      const burger = {
        ...base.items[0],
        aggregator_prices_minor: { yandex_eda: '399000', glovo: '389000' },
      };
      const release = { ...base, items: [burger] };
      await applyMenu(edge, ctx.branch, await publishMenu(ctx.cloud.pool, release));
      const person = (role, terminal = randomUUID()) => ({
        staff_id: randomUUID(),
        terminal_id: terminal,
        name: 'Синтетический сотрудник',
        role,
      });
      const cashier = await provisionStaff(edge, ctx.branch, person('cashier'));
      const managerSetup = person('shift_manager', cashier.terminal_id);
      await setStaffPin(
        edge,
        ctx.branch,
        staffAuth(await provisionStaff(edge, ctx.branch, managerSetup)),
        PIN,
      );
      const manager = await provisionStaff(edge, ctx.branch, managerSetup);
      const cook = await provisionStaff(edge, ctx.branch, person('kitchen'));
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
          routes: [{ productId: burger.product_id, stationId: prep, kind: 'prep' }],
        },
      });
      await grantStation(edge, ctx.branch, cook.staff_id, prep);
      await grantStation(edge, ctx.branch, cook.staff_id, assembly);
      await setOrdering(edge, ctx.branch, staffAuth(manager), randomUUID(), true, {
        expected_version: 1,
      });
      if (mode === 'pos_sale') {
        await setting(
          edge,
          ctx.branch,
          'pos_service_mode',
          { pos_service_mode: 'payment_required' },
          { pos_service_mode: 'pos_sale' },
          (client) =>
            client.query("UPDATE branch_config SET pos_service_mode='pos_sale' WHERE id=$1", [
              ctx.branch,
            ]),
        );
        for (const method of PosPaymentMethodSchema.options) {
          const old = (
            await edge.query(
              'SELECT enabled,fiscal_policy FROM pos_payment_methods WHERE branch_id=$1 AND code=$2',
              [ctx.branch, method],
            )
          ).rows[0];
          await setting(edge, ctx.branch, method, old, { ...old, enabled: true }, (client) =>
            client.query(
              'UPDATE pos_payment_methods SET enabled=true WHERE branch_id=$1 AND code=$2',
              [ctx.branch, method],
            ),
          );
        }
      } else
        await edge.query('UPDATE branch_config SET pos_service_mode=$2 WHERE id=$1', [
          ctx.branch,
          mode,
        ]);
      const shift = await openCashShift(edge, ctx.branch, staffAuth(manager), randomUUID(), {
        opening_cash_minor: '500000',
      });
      const identity = await provisionDevice(ctx.cloud.pool, ctx.device);
      const scope = await provisionEdgePosSync(edge, {
        organizationId: ctx.org,
        branchId: ctx.branch,
        deviceId: ctx.device,
      });
      await provisionCloudPosSync(ctx.cloud.pool, scope);
      const server = await running(createApi, { ...ctx.cloud.config, posOrderSyncEnabled: true });
      try {
        await run({
          ...ctx,
          release,
          burger,
          cashier,
          manager,
          cook,
          prep,
          shift,
          scope,
          port: localUnpaidExecution({ enabled: true, deviceId: ctx.device }),
          repo: new EdgeFulfillment(edge),
          options: { enabled: true, branchId: ctx.branch, origin: server.url, identity },
        });
      } finally {
        await server.app.close();
      }
    },
    cloudMigrationDirectory ? { cloudMigrationDirectory } : {},
  );
}

const quote = (ctx, { channel, serviceMode = 'takeaway' } = {}) =>
  createQuote(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), {
    release_id: ctx.release.release_id,
    service_mode: serviceMode,
    items: [{ variant_id: ctx.burger.variant_id, quantity: 1 }],
    ...(channel ? { sales_channel: channel } : {}),
  });
const sell = async (ctx, extra, options) =>
  createPosSale(
    ctx.edge.pool,
    ctx.branch,
    staffAuth(ctx.cashier),
    randomUUID(),
    {
      quote_id: (await quote(ctx, options)).quote_id,
      service_mode_confirmed: true,
      order_repeated: true,
      ...extra,
    },
    ctx.port,
  );
const approve = async (ctx, action, subject) => {
  const approval = await requestManagerApproval(ctx.edge.pool, ctx.branch, staffAuth(ctx.cashier), {
    staff_id: ctx.manager.staff_id,
    pin: PIN,
    action,
    subject,
  });
  return { approval_id: approval.approval_id, token: approval.token };
};
async function cook(ctx, orderId) {
  let current = await ctx.repo.readOrder(ctx.branch, staffAuth(ctx.cook), orderId, {
    stationId: ctx.prep,
  });
  const act = (action, extra = {}) =>
    ctx.repo.act(ctx.branch, staffAuth(ctx.cook), {
      commandId: randomUUID(),
      orderId,
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
}
async function drain(sync, ctx) {
  for (let i = 0; i < 200; i++) {
    const result = await sync(ctx.edge.pool, ctx.options);
    if (result.state === 'idle') return;
    assert.equal(result.state, 'delivered', JSON.stringify(result));
  }
  assert.fail('Bounded stream drain exceeded');
}
/** The edge reader and cloud receiver of the cashier-report pull extension, without network. */
async function drainCashierReports(ctx) {
  const received = [];
  for (let i = 0; i < 20; i++) {
    const reports = await pendingCashierReports(ctx.edge.pool, ctx.branch);
    if (!reports.length) break;
    const parsed = CashierReportsSchema.parse(reports);
    // The edge sends each report as stored (acknowledge matches the stored payload exactly).
    assert.deepEqual(parsed, reports);
    const receipt = CashierReportReceiptSchema.parse(
      await transaction(ctx.cloud.pool, (client) =>
        receiveCashierReports(client, ctx.branch, ctx.device, parsed),
      ),
    );
    await acknowledgeCashierReports(ctx.edge.pool, ctx.branch, parsed, receipt);
    received.push(...parsed);
  }
  const left = (
    await ctx.edge.pool.query(
      `SELECT count(*) FILTER(WHERE acknowledged_at IS NULL)::int pending,
       count(*) FILTER(WHERE last_error IS NOT NULL)::int failed FROM cashier_report_outbox`,
    )
  ).rows[0];
  assert.deepEqual(left, { pending: 0, failed: 0 });
  return received;
}
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
const kitchenEvents = async (ctx) =>
  (
    await ctx.edge.pool.query(
      "SELECT * FROM fulfillment_outbox WHERE payload->>'commercialOwner'='edge_pos' ORDER BY sequence",
    )
  ).rows.map((row) =>
    parseKitchenEvent({
      event_id: row.event_id,
      producer_id: ctx.scope.producerId,
      producer_sequence: row.sequence,
      aggregate_type: row.aggregate_type,
      aggregate_id: row.order_id,
      aggregate_version: row.aggregate_version,
      event_type: row.event_type,
      schema_version: 1,
      branch_id: row.branch_id,
      occurred_at: row.occurred_at.toISOString(),
      correlation_id: row.order_id,
      causation_id: null,
      payload: row.payload,
    }),
  );
const byOrder = (rows) => Object.fromEntries(rows.map((row) => [row.order_id, row]));

test('a paid POS day reaches the cloud through order_commercial, kitchen, cashier reports and posSales', async () => {
  await streamDesk(async (ctx) => {
    const pool = ctx.edge.pool;
    // POS-4: a shift opened through the API in pos_sale mode is a sales shift.
    assert.equal(ctx.shift.payment_processing_available, true);
    assert.equal(
      (
        await pool.query('SELECT sales_mode FROM local_cash_shifts WHERE id=$1', [
          ctx.shift.shift_id,
        ])
      ).rows[0].sales_mode,
      true,
    );
    // A: cash with change, voided before the kitchen starts. B: cash + Kaspi terminal, cooked,
    // part of the cash refunded, receipt recorded later. C: Yandex Eda. D: staff meal.
    const a = await sell(
      ctx,
      { tenders: [{ method: 'cash', amount_minor: '349000' }], cash_tendered_minor: '500000' },
      { serviceMode: 'dine_in' },
    );
    const b = await sell(ctx, {
      tenders: [
        { method: 'cash', amount_minor: '49000' },
        { method: 'kaspi_terminal', amount_minor: '300000' },
      ],
      cash_tendered_minor: '50000',
    });
    const c = await sell(
      ctx,
      {
        tenders: [{ method: 'aggregator_yandex_eda', amount_minor: '399000' }],
        external_order_ref: 'ya-stream-1',
      },
      { channel: 'yandex_eda' },
    );
    const dQuote = await quote(ctx);
    const d = await createPosSale(
      pool,
      ctx.branch,
      staffAuth(ctx.cashier),
      randomUUID(),
      {
        quote_id: dQuote.quote_id,
        service_mode_confirmed: true,
        order_repeated: true,
        tenders: [{ method: 'staff_meal', amount_minor: '349000' }],
        beneficiary: 'Синтетический сотрудник',
        approval: await approve(ctx, 'staff_meal', {
          quote_id: dQuote.quote_id,
          amount_minor: dQuote.total_minor,
        }),
      },
      ctx.port,
    );
    await voidPosSale(
      pool,
      ctx.branch,
      staffAuth(ctx.cashier),
      randomUUID(),
      a.order.order_id,
      {
        expected_version: 1,
        reason_code: 'cashier_error',
        reason: 'Синтетическая отмена',
        fiscal_sale_issued: false,
        approval: await approve(ctx, 'void', {
          order_id: a.order.order_id,
          amount_minor: '349000',
        }),
      },
      ctx.port,
    );
    await cook(ctx, b.order.order_id);
    await refundPosSale(pool, ctx.branch, staffAuth(ctx.cashier), randomUUID(), b.order.order_id, {
      refund_id: randomUUID(),
      tenders: [
        {
          tender_id: b.sale.tenders.find((t) => t.method === 'cash').tender_id,
          amount_minor: '20000',
        },
      ],
      reason_code: 'quality',
      reason: 'Синтетический возврат',
      approval: await approve(ctx, 'refund', { order_id: b.order.order_id, amount_minor: '20000' }),
    });
    await recordFiscalReceipt(
      pool,
      ctx.branch,
      staffAuth(ctx.cashier),
      randomUUID(),
      b.sale.fiscal.find((r) => r.kind === 'sale').receipt_id,
      { expected_version: 1, receipt_number: 'SYN-WK-1' },
    );
    await moveCash(pool, ctx.branch, staffAuth(ctx.manager), randomUUID(), ctx.shift.shift_id, {
      direction: 'in',
      amount_minor: '10000',
      reason: 'Синтетический размен',
    });
    // 500000 + 10000 in + cash sales (349000 + 49000) - cash refunds (349000 + 20000).
    const open = await readCashShift(pool, ctx.branch, staffAuth(ctx.manager), ctx.shift.shift_id);
    assert.equal(open.expected_cash_minor, '539000');
    // B's return receipt is still pending in Webkassa: the close needs the PIN.
    const closed = await closeCashShift(
      pool,
      ctx.branch,
      staffAuth(ctx.manager),
      randomUUID(),
      ctx.shift.shift_id,
      {
        expected_version: open.version,
        counted_cash_minor: '539000',
        reason: 'Синтетическое закрытие',
        terminal_reported_minor: '300000',
        approval: await approve(ctx, 'shift_close_pending_fiscal', {
          shift_id: ctx.shift.shift_id,
          amount_minor: '20000',
        }),
      },
    );
    assert.equal(closed.discrepancy_minor, '0');

    // posSales: every event of the day in its transaction's order, one strictly ordered batch.
    const outbox = (await pool.query('SELECT * FROM pos_sale_outbox ORDER BY sequence')).rows;
    assert.deepEqual(
      outbox.map((row) => row.kind),
      [
        ...['sale', 'fiscal', 'sale', 'fiscal', 'sale', 'fiscal', 'sale', 'fiscal'],
        ...['void', 'fiscal', 'fiscal'],
        ...['refund', 'fiscal'],
        'fiscal',
        'shift_report',
      ],
    );
    const batch = parsePosSaleBatch({
      events: outbox.map((row) => ({
        event_id: row.event_id,
        branch_id: row.branch_id,
        sequence: row.sequence,
        kind: row.kind,
        occurred_at: row.occurred_at.toISOString(),
        payload: row.payload,
      })),
    });
    assert.equal(batch.events.length, outbox.length);
    for (const row of outbox) assert.equal(row.payload_hash, hashJson(row.payload));
    const zReport = outbox.at(-1).payload.report;
    assert.deepEqual(
      [
        zReport.kind,
        zReport.cash_sales_minor,
        zReport.cash_refunds_minor,
        zReport.expected_cash_minor,
      ],
      ['z', '398000', '369000', '539000'],
    );

    // order_commercial: the edge worker reads its own outbox and the cloud (073) projects it.
    const commercial = await commercialEvents(pool);
    assert.deepEqual(
      commercial.map((e) => [e.event_type, e.payload.state, e.payload.payment_state]),
      [
        ['order.created', 'paid', 'captured'],
        ['order.created', 'paid', 'captured'],
        ['order.created', 'paid', 'captured'],
        ['order.created', 'paid', 'captured'],
        ['order.cancelled', 'cancelled', 'captured'],
      ],
    );
    assert.ok(commercial.every((e) => e.payload.execution_mode === 'pos_sale'));
    assert.equal(
      commercial.find((e) => e.aggregate_id === c.order.order_id).payload.snapshot.sales_channel,
      'yandex_eda',
    );
    await drain(syncPosOrdersOnce, ctx);
    const orders = byOrder(
      (
        await ctx.cloud.pool.query(
          'SELECT order_id,version,state,payment_state,execution_mode,total_minor::text FROM pos_order_sync_projection',
        )
      ).rows,
    );
    assert.deepEqual(orders[a.order.order_id], {
      order_id: a.order.order_id,
      version: 2,
      state: 'cancelled',
      payment_state: 'captured',
      execution_mode: 'pos_sale',
      total_minor: '349000',
    });
    for (const sale of [b, c, d])
      assert.deepEqual(
        [orders[sale.order.order_id].version, orders[sale.order.order_id].state],
        [1, 'paid'],
      );
    assert.equal(Object.keys(orders).length, 4);

    // Kitchen: pos_sale observations follow the paid commercial projection.
    const kitchen = await kitchenEvents(ctx);
    assert.ok(kitchen.length >= 8);
    assert.ok(kitchen.every((e) => e.payload.executionMode === 'pos_sale'));
    await drain(syncPosKitchenOnce, ctx);
    const meals = byOrder(
      (
        await ctx.cloud.pool.query(
          'SELECT order_id,state,execution_mode FROM pos_kitchen_sync_projection',
        )
      ).rows,
    );
    assert.deepEqual(
      [a, b, c, d].map((sale) => meals[sale.order.order_id].state),
      ['cancelled', 'handed_over', 'accepted', 'accepted'],
    );
    assert.ok(Object.values(meals).every((row) => row.execution_mode === 'pos_sale'));

    // Cashier reports: paid and voided orders, the sales shift with its cash sales and refunds.
    const reports = await drainCashierReports(ctx);
    const shifts = reports.filter((r) => r.kind === 'shift');
    assert.ok(shifts.length >= 3);
    for (const { payload: s } of shifts) {
      assert.ok(s.cash_sales_minor !== undefined && s.cash_refunds_minor !== undefined);
      assert.equal(
        BigInt(s.opening_cash_minor) +
          BigInt(s.cash_in_minor) -
          BigInt(s.cash_out_minor) +
          BigInt(s.cash_sales_minor) -
          BigInt(s.cash_refunds_minor),
        BigInt(s.expected_cash_minor),
      );
    }
    // Installed clouds parse strictly: the frozen D0 shapes refuse every pos_sale report.
    assert.ok(reports.every((report) => !frozenAccepts(report)));
    const cloudShift = (
      await ctx.cloud.pool.query('SELECT payload FROM cloud_cashier_shifts WHERE id=$1', [
        ctx.shift.shift_id,
      ])
    ).rows[0].payload;
    assert.deepEqual(
      [
        cloudShift.state,
        cloudShift.cash_sales_minor,
        cloudShift.cash_refunds_minor,
        cloudShift.expected_cash_minor,
        cloudShift.counted_cash_minor,
        cloudShift.discrepancy_minor,
      ],
      ['closed', '398000', '369000', '539000', '539000', '0'],
    );
    const cashierOrders = byOrder(
      (
        await ctx.cloud.pool.query(
          "SELECT id AS order_id,payload->>'state' state,(payload->>'version')::int version,payload->>'execution_mode' mode FROM cloud_cashier_orders",
        )
      ).rows,
    );
    assert.deepEqual(
      [a, b, c, d].map((sale) => {
        const row = cashierOrders[sale.order.order_id];
        return [row.state, row.version, row.mode];
      }),
      [
        ['cancelled', 2, 'pos_sale'],
        ['paid', 1, 'pos_sale'],
        ['paid', 1, 'pos_sale'],
        ['paid', 1, 'pos_sale'],
      ],
    );

    // Replays stay idempotent: the receivers acknowledge the same events again.
    await ctx.edge.pool.query('UPDATE pos_order_sync_state SET retry_after=NULL');
    assert.equal((await syncPosOrdersOnce(pool, ctx.options)).state, 'idle');
    // The back office still reads the day (its labels for paid sales are CR pos-4).
    const observer = await provisionCatalogManager(ctx.cloud.pool, {
      organization_id: ctx.org,
      name: 'Synthetic BO observer',
      branch_ids: [ctx.branch],
    });
    await grantBackoffice(ctx.cloud.pool, observer.actor_id, ctx.branch, 'manager');
    const bo = new Backoffice(ctx.cloud.pool, true);
    const view = await bo.read(observer.token, ctx.branch);
    assert.equal(view.cashier_orders.length, 4);
    assert.equal(
      (await bo.order(observer.token, ctx.branch, b.order.order_id)).order.state,
      'paid',
    );
  });
});

test('pos_sale off: an unpaid day keeps the old stream payloads byte for byte on edge 026', async () => {
  await streamDesk(
    async (ctx) => {
      const pool = ctx.edge.pool;
      assert.equal(ctx.shift.payment_processing_available, false);
      const order = async () =>
        createLocalOrder(
          pool,
          ctx.branch,
          staffAuth(ctx.cashier),
          randomUUID(),
          { quote_id: (await quote(ctx)).quote_id, kitchen_admission: 'unpaid' },
          ctx.port,
        );
      const kept = await order();
      const cancelled = await order();
      await cancelLocalOrder(
        pool,
        ctx.branch,
        staffAuth(ctx.cashier),
        randomUUID(),
        cancelled.order_id,
        { expected_version: 1, reason: 'Синтетическая отмена' },
        ctx.port,
      );
      await cook(ctx, kept.order_id);
      await moveCash(pool, ctx.branch, staffAuth(ctx.manager), randomUUID(), ctx.shift.shift_id, {
        direction: 'in',
        amount_minor: '10000',
        reason: 'Синтетический размен',
      });
      const open = await readCashShift(
        pool,
        ctx.branch,
        staffAuth(ctx.manager),
        ctx.shift.shift_id,
      );
      assert.deepEqual(
        [open.expected_cash_minor, open.cash_received_minor, open.cash_refunded_minor],
        ['510000', '0', '0'],
      );
      await closeCashShift(
        pool,
        ctx.branch,
        staffAuth(ctx.manager),
        randomUUID(),
        ctx.shift.shift_id,
        {
          expected_version: open.version,
          counted_cash_minor: '510000',
          reason: 'Синтетическое закрытие',
        },
      );
      assert.equal(
        Number((await pool.query('SELECT count(*) FROM pos_sale_outbox')).rows[0].count),
        0,
      );
      const commercial = await commercialEvents(pool);
      assert.deepEqual(
        commercial.map((e) => [e.payload.state, e.payload.payment_state, e.payload.execution_mode]),
        [
          ['awaiting_payment', 'not_started', 'unpaid_service'],
          ['awaiting_payment', 'not_started', 'unpaid_service'],
          ['cancelled', 'not_started', 'unpaid_service'],
        ],
      );
      assert.ok(commercial.every((e) => e.payload.snapshot.sales_channel === undefined));
      const kitchen = await kitchenEvents(ctx);
      assert.ok(kitchen.every((e) => e.payload.executionMode === 'unpaid_service'));
      await drain(syncPosOrdersOnce, ctx);
      await drain(syncPosKitchenOnce, ctx);
      const projection = (
        await ctx.cloud.pool.query(
          'SELECT state,payment_state,execution_mode FROM pos_order_sync_projection ORDER BY state',
        )
      ).rows;
      assert.deepEqual(projection, [
        {
          state: 'awaiting_payment',
          payment_state: 'not_started',
          execution_mode: 'unpaid_service',
        },
        { state: 'cancelled', payment_state: 'not_started', execution_mode: 'unpaid_service' },
      ]);
      assert.deepEqual(
        (
          await ctx.cloud.pool.query(
            'SELECT DISTINCT execution_mode FROM pos_kitchen_sync_projection',
          )
        ).rows,
        [{ execution_mode: 'unpaid_service' }],
      );
      // Every cashier report is exactly the D0 shape (keys and enums), sent as stored.
      const reports = await drainCashierReports(ctx);
      assert.ok(reports.some((r) => r.kind === 'shift') && reports.some((r) => r.kind === 'order'));
      for (const report of reports)
        assert.ok(frozenAccepts(report), JSON.stringify(report.payload));
    },
    { mode: 'unpaid_service' },
  );
});

test('new receivers on a cloud before 073: a paid sale waits on the edge, nothing is written', async () => {
  const before073 = await mkdtemp(join(tmpdir(), 'pickchick-cloud-072-'));
  try {
    for (const name of (await readdir(cloudDir)).filter((n) => n.endsWith('.sql')))
      if (Number(name.slice(0, 3)) <= 72)
        await copyFile(join(cloudDir, name), join(before073, name));
    await streamDesk(
      async (ctx) => {
        const sale = await sell(ctx, {
          tenders: [{ method: 'cash', amount_minor: '349000' }],
          cash_tendered_minor: '349000',
        });
        const order = await syncPosOrdersOnce(ctx.edge.pool, ctx.options);
        assert.deepEqual([order.state, order.error], ['retry', 'HTTP_REJECTED']);
        const kitchen = await syncPosKitchenOnce(ctx.edge.pool, ctx.options);
        // Not a dead letter: the observation is kept and retried once the cloud is upgraded.
        assert.deepEqual([kitchen.state, kitchen.error], ['retry', 'HTTP_REJECTED']);
        for (const table of [
          'pos_order_sync_inbox',
          'pos_order_sync_projection',
          'pos_kitchen_sync_inbox',
        ])
          assert.equal(
            Number((await ctx.cloud.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count),
            0,
            table,
          );
        assert.equal(
          Number(
            (
              await ctx.edge.pool.query(
                'SELECT count(*) FROM outbox_events WHERE aggregate_id=$1 AND acknowledged_at IS NULL',
                [sale.order.order_id],
              )
            ).rows[0].count,
          ),
          1,
        );
      },
      { cloudMigrationDirectory: before073 },
    );
  } finally {
    await rm(before073, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ edge database restore ----
// CR cloud-5 item 1 on the real 026, mirroring the restore cases of the cloud lane
// (packages/pos-order-sync/tests/sales-worker-integration.test.mjs on codex/cutover-cloud). The
// cloud keeps every posSales event in cloud_pos_sale_inbox (073, UNIQUE(device_id, sequence))
// and its receiver answers CONFLICT for good when an event's id or (device, sequence) belongs to
// another event (sales-cloud.ts inboxState); that rule runs here on the real 073 table.
const GAP = 1_000_000_000n;
const lastSequence = async (pool, table) =>
  BigInt(
    (
      await pool.query(
        `SELECT coalesce(pg_sequence_last_value(pg_get_serial_sequence($1,'sequence')::regclass),0) AS v`,
        [table],
      )
    ).rows[0].v,
  );
const pendingPosSales = async (pool) =>
  (
    await pool.query(
      `SELECT o.event_id,o.branch_id,o.sequence::text AS sequence,o.kind,o.payload,o.payload_hash,
         o.occurred_at FROM pos_sale_outbox o WHERE o.acknowledged_at IS NULL ORDER BY o.sequence`,
    )
  ).rows;
/**
 * The inbox rule of the cloud receiver for `events` in order: `new` (stored), `duplicate`
 * (exactly this event is stored) or `conflict` (its id or device sequence belongs to another
 * event), which ends the delivery like the receiver ends a batch. Accepted events are
 * acknowledged on the edge unless `acknowledge` is false (a delivery of the lost timeline).
 */
async function deliverToInbox(ctx, events, { acknowledge = true } = {}) {
  const states = [];
  for (const event of events) {
    const known = (
      await ctx.cloud.pool.query(
        `SELECT event_id,device_id,sequence::text AS sequence,kind,payload_hash FROM cloud_pos_sale_inbox
         WHERE event_id=$1 OR (device_id=$2 AND sequence=$3)`,
        [event.event_id, ctx.device, event.sequence],
      )
    ).rows;
    const same = (row) =>
      row.event_id === event.event_id &&
      row.sequence === event.sequence &&
      row.kind === event.kind &&
      row.payload_hash === event.payload_hash;
    const state = !known.length
      ? 'new'
      : known.length === 1 && same(known[0])
        ? 'duplicate'
        : 'conflict';
    states.push(state);
    if (state === 'conflict') break;
    if (state === 'new')
      await ctx.cloud.pool.query(
        `INSERT INTO cloud_pos_sale_inbox(event_id,branch_id,device_id,sequence,kind,payload_hash)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [event.event_id, ctx.branch, ctx.device, event.sequence, event.kind, event.payload_hash],
      );
    if (acknowledge)
      await ctx.edge.pool.query(
        'UPDATE pos_sale_outbox SET acknowledged_at=clock_timestamp() WHERE event_id=$1 AND acknowledged_at IS NULL',
        [event.event_id],
      );
  }
  return states;
}

test('restored edge database on the real 026 (CR cloud-5): the fence moves posSales past the lost timeline once, the copy goes again as duplicates and no new event of the open shift reuses a sequence', async () => {
  await streamDesk(async (ctx) => {
    const pool = ctx.edge.pool;
    const cash = {
      tenders: [{ method: 'cash', amount_minor: '349000' }],
      cash_tendered_minor: '349000',
    };
    // Kept: sold and accepted by the cloud before the copy was taken.
    const kept = await sell(ctx, cash);
    assert.deepEqual(await deliverToInbox(ctx, await pendingPosSales(pool)), ['new', 'new']);
    // Copied: sold and in the copy, but not yet acknowledged when the copy was taken.
    const copied = await sell(ctx, cash);
    const copy = await pendingPosSales(pool);
    assert.deepEqual(
      copy.map((event) => event.kind),
      ['sale', 'fiscal'],
    );
    // The lost timeline (between the copy and the failure) delivered the copied events and a
    // sale the restored edge never stored, at the next sequences of this device.
    const tail = BigInt(copy.at(-1).sequence);
    const lost = ['sale', 'fiscal'].map((kind, i) => ({
      event_id: randomUUID(),
      sequence: String(tail + 1n + BigInt(i)),
      kind,
      payload_hash: hashJson({ synthetic: randomUUID() }),
    }));
    assert.deepEqual(await deliverToInbox(ctx, [...copy, ...lost], { acknowledge: false }), [
      'new',
      'new',
      'new',
      'new',
    ]);
    // The edge database comes back from that copy: its ledger carries the copy's identity.
    await pool.query(
      `INSERT INTO edge_database_epochs(epoch,system_identifier,database_oid,reason,sequence_gap)
       SELECT max(epoch)+1, 1, 1, 'initial', 0 FROM edge_database_epochs`,
    );
    // Unfenced, the next posSales number would be tail + 1, which the cloud holds for the lost
    // sale (the parked CONFLICT of the cloud lane's "fence of today (023)" case).
    assert.equal(await lastSequence(pool, 'pos_sale_outbox'), tail);
    assert.deepEqual(
      await deliverToInbox(
        ctx,
        [{ ...lost[0], event_id: randomUUID(), payload_hash: hashJson({ unfenced: true }) }],
        { acknowledge: false },
      ),
      ['conflict'],
    );
    // The check of the interim owner step (backoffice-cutover.md «Восстановление базы кассы»):
    // the installed 026 fence covers pos_sale_outbox, so the manual shift is not needed.
    assert.equal(
      (
        await pool.query(
          "SELECT pg_get_functiondef('edge_restore_fence(boolean)'::regprocedure) LIKE '%pos_sale_outbox%' AS covered",
        )
      ).rows[0].covered,
      true,
    );
    const before = {
      pos: tail,
      reports: await lastSequence(pool, 'cashier_report_outbox'),
      kitchen: await lastSequence(pool, 'fulfillment_outbox'),
      orders: BigInt(
        (await pool.query('SELECT last_sequence FROM local_order_streams')).rows[0].last_sequence,
      ),
    };
    const counters = async () => ({
      pos: await lastSequence(pool, 'pos_sale_outbox'),
      reports: await lastSequence(pool, 'cashier_report_outbox'),
      kitchen: await lastSequence(pool, 'fulfillment_outbox'),
      orders: BigInt(
        (await pool.query('SELECT last_sequence FROM local_order_streams')).rows[0].last_sequence,
      ),
    });
    // The edge start fences once: every producer sequence, posSales included, moves by the gap.
    assert.equal((await fenceRestoredEdge(pool)).state, 'restore');
    const fenced = await counters();
    assert.deepEqual(fenced, {
      pos: before.pos + GAP,
      reports: before.reports + GAP,
      kitchen: before.kitchen + GAP,
      orders: before.orders + GAP,
    });
    assert.equal((await fenceRestoredEdge(pool)).state, 'current');
    assert.deepEqual(await counters(), fenced);

    // The shift open across the restore goes on: a new sale, its receipts, the Z.
    const next = await sell(ctx, cash);
    for (const [i, sale] of [kept, copied, next].entries())
      await recordFiscalReceipt(
        pool,
        ctx.branch,
        staffAuth(ctx.cashier),
        randomUUID(),
        sale.sale.fiscal.find((receipt) => receipt.kind === 'sale').receipt_id,
        { expected_version: 1, receipt_number: `SYN-WK-R${i + 1}` },
      );
    const open = await readCashShift(pool, ctx.branch, staffAuth(ctx.manager), ctx.shift.shift_id);
    await closeCashShift(
      pool,
      ctx.branch,
      staffAuth(ctx.manager),
      randomUUID(),
      ctx.shift.shift_id,
      {
        expected_version: open.version,
        counted_cash_minor: open.expected_cash_minor,
        reason: 'Синтетическое закрытие после восстановления',
      },
    );
    const pending = await pendingPosSales(pool);
    assert.deepEqual(
      pending.map((event) => event.kind),
      ['sale', 'fiscal', 'sale', 'fiscal', 'fiscal', 'fiscal', 'fiscal', 'shift_report'],
    );
    // Every pending event is a valid wire event as stored.
    assert.equal(
      parsePosSaleBatch({
        events: pending.map((event) => ({
          event_id: event.event_id,
          branch_id: event.branch_id,
          sequence: event.sequence,
          kind: event.kind,
          occurred_at: event.occurred_at.toISOString(),
          payload: event.payload,
        })),
      }).events.length,
      pending.length,
    );
    // The copy goes again as duplicates; every new event is past the lost timeline.
    assert.deepEqual(pending.slice(0, 2), copy);
    assert.ok(pending.slice(2).every((event) => BigInt(event.sequence) > tail + GAP));
    assert.deepEqual(await deliverToInbox(ctx, pending), [
      'duplicate',
      'duplicate',
      ...Array(6).fill('new'),
    ]);
    assert.deepEqual(await pendingPosSales(pool), []);
    // The Z counts what the restored desk sold (kept, copied, next); the cloud also holds the
    // lost sale. That Z is CR cloud-5 item 2 (the cloud owner command), not a sequence matter.
    const z = pending.at(-1).payload.report;
    assert.deepEqual([z.orders.count, z.cash_sales_minor], [3, '1047000']);
    assert.equal(
      Number(
        (
          await ctx.cloud.pool.query(
            "SELECT count(*) FROM cloud_pos_sale_inbox WHERE device_id=$1 AND kind='sale'",
            [ctx.device],
          )
        ).rows[0].count,
      ),
      4,
    );
    // The order_commercial stream of the same paid day flows across the gap as well.
    await drain(syncPosOrdersOnce, ctx);
    assert.deepEqual(
      (
        await ctx.cloud.pool.query(
          'SELECT state FROM pos_order_sync_projection WHERE branch_id=$1 ORDER BY order_id',
          [ctx.branch],
        )
      ).rows.map((row) => row.state),
      ['paid', 'paid', 'paid'],
    );
  });
});
