import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '@pickchick/database';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import {
  Backoffice,
  BackofficeError,
  NO_REVENUE_METHODS,
  POS_PAYMENT_METHODS,
  SALES_REPORT_CHANNELS,
  SALES_REPORT_METHODS,
  SalesReportQuery,
  averageMinor,
  backofficeOptions,
  designateBackoffice,
  grantBackoffice,
  readSalesReport,
  salesReportPosReadable,
} from '../dist/index.js';
import * as contracts from '../../contracts/dist/index.js';
import { assertBackofficeCutoverPrivileges } from '../../../infra/staging/backoffice-cutover-grants.mjs';
import { cloudPosSalesGrants } from '../../../infra/staging/pos-sales-grants.mjs';
import { receivePosSales } from '../../pos-order-sync/dist/index.js';
import { stream, withPosSalesDatabases } from '../../pos-order-sync/tests/sales-cloud-fixture.mjs';

/**
 * Cutover CC-7: GET .../ops/sales over synthetic cashier (cloud073) and cloud (app, kiosk) data.
 * Every amount below is synthetic; the day is 19.11.2026 in Asia/Almaty (UTC+5).
 */
const MIGRATIONS = fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url));
const D = '2026-11-19';
const at = (day, time) => new Date(`${day}T${time}+05:00`);
const is = (code, reason) => (error) =>
  error instanceof BackofficeError && error.code === code && error.reason === reason;

// ------------------------------------------------------------------------------ pure ----

test('report enums: the eight cashier methods verbatim, the owner order, six channels', () => {
  assert.deepEqual([...POS_PAYMENT_METHODS], contracts.PosPaymentMethodSchema.options);
  assert.deepEqual([...SALES_REPORT_METHODS].sort(), [...POS_PAYMENT_METHODS].sort());
  assert.equal(SALES_REPORT_METHODS.length, 8);
  assert.deepEqual([...NO_REVENUE_METHODS], ['staff_meal', 'marketing']);
  assert.deepEqual(
    [...SALES_REPORT_CHANNELS],
    ['hall_dine_in', 'hall_takeaway', 'yandex_eda', 'glovo', 'mobile', 'kiosk'],
  );
  assert.deepEqual(
    SALES_REPORT_CHANNELS.slice(2, 4),
    contracts.AggregatorChannelSchema.options,
    'aggregator channels keep their sales_channel code',
  );
});

test('cloud073 CHECK lists accept every method the report shows', async () => {
  const ddl = await readFile(join(MIGRATIONS, '073_cloud_pos_sales_sync.sql'), 'utf8');
  for (const table of ['cloud_pos_tenders', 'cloud_pos_refund_tenders']) {
    const block = ddl.slice(ddl.indexOf(`CREATE TABLE ${table}`));
    const list = /method text NOT NULL CHECK\(method IN \(([^)]*)\)\)/.exec(block)[1];
    assert.deepEqual(
      list.split(',').map((v) => v.trim().replace(/^'|'$/g, '')),
      [...POS_PAYMENT_METHODS],
      table,
    );
  }
});

test('sales query: two calendar dates, at most 92 days; average check rounds half up', () => {
  const q = { start_date: D, end_date: D };
  assert.deepEqual(SalesReportQuery.parse(q), q);
  assert.equal(SalesReportQuery.safeParse({ start_date: '2026-08-20', end_date: D }).success, true);
  for (const bad of [
    { start_date: '2026-08-19', end_date: D },
    { start_date: '2026-11-20', end_date: D },
    { start_date: D, end_date: '2026-11-31' },
    { start_date: D },
    { ...q, view: 'sales' },
    { start_date: '19.11.2026', end_date: D },
  ])
    assert.equal(SalesReportQuery.safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(averageMinor(470000n, 3), '156667');
  assert.equal(averageMinor(470001n, 2), '235001');
  assert.equal(averageMinor(5n, 2), '3');
  assert.equal(averageMinor(4n, 3), '1');
  assert.equal(averageMinor(0n, 0), '0');
});

test('BACKOFFICE_SALES_REPORT_ENABLED defaults off and accepts only true or false', () => {
  assert.equal(backofficeOptions({}).salesReportEnabled, false);
  assert.equal(
    backofficeOptions({ BACKOFFICE_SALES_REPORT_ENABLED: 'true' }).salesReportEnabled,
    true,
  );
  for (const value of ['1', 'TRUE', 'yes', ''])
    assert.throws(() => backofficeOptions({ BACKOFFICE_SALES_REPORT_ENABLED: value }));
});

// ------------------------------------------------------------------------- fixtures ----

const STAFF = {
  cashier: randomUUID(),
  manager: randomUUID(),
  second: randomUUID(),
};
const TERMINAL = randomUUID();
const PRODUCT = { burger: randomUUID(), wings: randomUUID() };

/** One cashier sale exactly as the posSales receiver projects it (cloud073 columns). */
async function posSale(db, c, sale) {
  const id = sale.order_id ?? randomUUID();
  const total = sale.tenders.reduce((a, [, amount]) => a + BigInt(amount), 0n).toString();
  const product = randomUUID();
  const lines = sale.lines ?? [
    {
      product_id: product,
      variant_id: product,
      name: { ru: `Синтетическая позиция ${sale.number}` },
      quantity: 1,
      unit_price_minor: total,
      total_minor: total,
    },
  ];
  const cash = sale.tenders.find(([method]) => method === 'cash');
  await db.query(
    `INSERT INTO cloud_pos_sales(order_id,branch_id,device_id,shift_id,terminal_id,cashier_staff_id,
      display_number,sold_at,business_date,sales_channel,service_mode,revenue_kind,external_order_ref,
      subtotal_minor,discount_minor,total_minor,cash_tendered_minor,change_minor,beneficiary,reason,
      approval_id,approval_manager_staff_id,release_id,menu_version,lines,state,voided_at,last_sequence)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,($8::timestamptz AT TIME ZONE 'Asia/Almaty')::date,$9,$10,$11,$12,
      $13,0,$13,$14,$15,$16,$17,$18,$19,$20,1,$21,$22,$23,$24)`,
    [
      id,
      c.branch,
      c.device,
      sale.shift,
      TERMINAL,
      STAFF.cashier,
      sale.number,
      sale.at,
      sale.channel ?? 'hall',
      sale.mode ?? (sale.channel && sale.channel !== 'hall' ? 'takeaway' : 'dine_in'),
      sale.kind ?? 'revenue',
      sale.ref ?? null,
      total,
      cash ? (sale.tendered ?? cash[1]) : null,
      cash ? (BigInt(sale.tendered ?? cash[1]) - BigInt(cash[1])).toString() : null,
      sale.beneficiary ?? null,
      sale.reason ?? null,
      sale.kind && sale.kind !== 'revenue' ? randomUUID() : null,
      sale.kind && sale.kind !== 'revenue' ? STAFF.manager : null,
      randomUUID(),
      JSON.stringify(lines),
      sale.voided ? 'voided' : 'paid',
      sale.voided ?? null,
      sale.number,
    ],
  );
  const tenders = [];
  for (const [method, amount, confirmation = 'cashier_attested'] of sale.tenders) {
    const tender = randomUUID();
    tenders.push({ tender, method, amount });
    await db.query(
      `INSERT INTO cloud_pos_tenders(tender_id,order_id,branch_id,method,amount_minor,confirmation,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [tender, id, c.branch, method, amount, confirmation, sale.at],
    );
  }
  if (sale.voided) await posRefund(db, c, { id, tenders }, 'void', sale.voided, tenders);
  return { id, tenders };
}
async function posRefund(db, c, sale, kind, when, parts, approver = STAFF.manager) {
  const refund = randomUUID();
  const amount = parts.reduce((a, p) => a + BigInt(p.amount), 0n).toString();
  await db.query(
    `INSERT INTO cloud_pos_refunds(refund_id,order_id,branch_id,kind,amount_minor,reason_code,reason,
      staff_id,approved_by_staff_id,approval_id,terminal_id,shift_id,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      refund,
      sale.id,
      c.branch,
      kind,
      amount,
      kind === 'void' ? 'aggregator_cancelled' : 'quality',
      kind === 'void' ? 'Курьер отменил заказ' : 'Гость вернул холодный заказ',
      STAFF.cashier,
      approver,
      randomUUID(),
      TERMINAL,
      sale.shift ?? randomUUID(),
      when,
    ],
  );
  for (const p of parts)
    await db.query(
      `INSERT INTO cloud_pos_refund_tenders(refund_id,tender_id,order_id,branch_id,method,amount_minor)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [refund, p.tender, sale.id, c.branch, p.method, p.amount],
    );
  return refund;
}
/**
 * Paid cloud orders without the provider flow: inserted with triggers off
 * (session_replication_role=replica) on one owner connection of the throwaway schema. The
 * report reads only these columns; the commercial flow itself is covered by test:commerce.
 */
async function cloudOrders(c, orders) {
  const db = await c.cloud.pool.connect();
  try {
    await db.query('SET session_replication_role = replica');
    for (const o of orders) {
      const id = randomUUID();
      const account = randomUUID();
      const capture = randomUUID();
      await db.query(
        `INSERT INTO commerce_orders(id,organization_id,branch_id,principal_id,quote_id,fiscal_account_id,
          snapshot,total_minor,currency,quote_digest,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'KZT',$9,$10)`,
        [
          id,
          c.org,
          c.branch,
          randomUUID(),
          randomUUID(),
          account,
          JSON.stringify({ channel: o.channel, totalMinor: o.amount, currency: 'KZT' }),
          o.amount,
          'a'.repeat(64),
          o.at,
        ],
      );
      await db.query(
        `INSERT INTO commerce_captures(id,order_id,attempt_id,account_id,operation_id,amount_minor,occurred_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [capture, id, randomUUID(), account, 'synthetic:' + capture, o.amount, o.at],
      );
      if (o.refund) {
        const refund = randomUUID();
        await db.query(
          `INSERT INTO commerce_refunds(id,order_id,capture_id,account_id,principal_id,amount_minor,reason,
            fulfillment_policy,state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'manager_reviewed','succeeded',$8)`,
          [
            refund,
            id,
            capture,
            account,
            o.refund.actor,
            o.refund.amount,
            'Синтетический возврат',
            o.refund.at,
          ],
        );
        await db.query(
          `INSERT INTO commerce_refund_effects(id,refund_id,order_id,account_id,operation_id,amount_minor,occurred_at)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [randomUUID(), refund, id, account, 'synthetic:r' + refund, o.refund.amount, o.refund.at],
        );
      }
    }
  } finally {
    await db.query('SET session_replication_role = DEFAULT');
    db.release();
  }
}
async function people(c) {
  const person = async (name, role) => {
    const m = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name,
      branch_ids: [c.branch],
    });
    if (role) await grantBackoffice(c.cloud.pool, m.actor_id, c.branch, role);
    return m;
  };
  return {
    manager: await person('Синтетический управляющий', 'manager'),
    analyst: await person('Синтетический аналитик', 'analyst'),
    shift: await person('Синтетический начальник смены', 'analyst'),
    outsider: await person('Синтетический посторонний', null),
  };
}
/** The day of the report plus its neighbours (see the expected numbers in the tests). */
async function seed(c, p) {
  const db = c.cloud.pool;
  const shift = randomUUID();
  const earlier = randomUUID();
  // 18.11 23:30, refunded on 19.11 09:00: the refund belongs to the 19th, the sale to the 18th.
  const s0 = await posSale(db, c, {
    shift: earlier,
    number: 1,
    at: at('2026-11-18', '23:30:00'),
    tenders: [['cash', '70000', 'drawer']],
  });
  await posRefund(db, c, { ...s0, shift }, 'refund', at(D, '09:00:00'), s0.tenders, STAFF.second);
  await db.query(
    `INSERT INTO cloud_pos_shift_reports(shift_id,branch_id,device_id,terminal_id,opened_at,closed_at,report,
      expected_cash_minor,counted_cash_minor,discrepancy_minor,terminal_reported_minor)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      earlier,
      c.branch,
      c.device,
      TERMINAL,
      at('2026-11-18', '09:00:00'),
      at('2026-11-18', '23:55:00'),
      JSON.stringify({ kind: 'z', shift_id: earlier, terminal_id: TERMINAL }),
      '1070000',
      '1069500',
      '-500',
      '0',
    ],
  );
  const burger = (quantity, total) => [
    {
      product_id: PRODUCT.burger,
      variant_id: PRODUCT.burger,
      name: { ru: 'Синтетический бургер' },
      quantity,
      unit_price_minor: (BigInt(total) / BigInt(quantity)).toString(),
      total_minor: total,
    },
  ];
  await posSale(db, c, {
    shift,
    number: 2,
    at: at(D, '10:15:00'),
    tenders: [['cash', '300000', 'drawer']],
    tendered: '500000',
    lines: burger(2, '300000'),
  });
  const s2 = await posSale(db, c, {
    shift,
    number: 3,
    at: at(D, '12:30:00'),
    mode: 'takeaway',
    tenders: [
      ['cash', '100000', 'drawer'],
      ['kaspi_terminal', '150000'],
    ],
  });
  await posRefund(db, c, { ...s2, shift }, 'refund', at(D, '13:00:00'), [
    { ...s2.tenders[1], amount: '50000' },
  ]);
  await posSale(db, c, {
    shift,
    number: 4,
    at: at(D, '13:05:00'),
    channel: 'yandex_eda',
    ref: 'YA-1001',
    tenders: [['aggregator_yandex_eda', '400000', 'aggregator_attested']],
    lines: [
      {
        product_id: PRODUCT.wings,
        variant_id: PRODUCT.wings,
        name: { ru: 'Синтетические крылья' },
        quantity: 4,
        unit_price_minor: '100000',
        total_minor: '400000',
      },
    ],
  });
  await posSale(db, c, {
    shift,
    number: 5,
    at: at(D, '18:40:00'),
    channel: 'glovo',
    ref: 'GL-2002',
    tenders: [['aggregator_glovo', '200000', 'aggregator_attested']],
    voided: at(D, '18:45:00'),
  });
  await posSale(db, c, {
    shift,
    number: 6,
    at: at(D, '19:00:00'),
    tenders: [['kaspi_manual', '120000']],
    lines: burger(1, '120000'),
  });
  await posSale(db, c, {
    shift,
    number: 7,
    at: at(D, '20:10:00'),
    mode: 'takeaway',
    ref: 'CHOCO-77',
    tenders: [['chocofood', '180000', 'aggregator_attested']],
  });
  await posSale(db, c, {
    shift,
    number: 8,
    at: at(D, '15:00:00'),
    kind: 'staff_meal',
    beneficiary: 'Синтетический сотрудник',
    tenders: [['staff_meal', '90000', 'manager_approved']],
  });
  await posSale(db, c, {
    shift,
    number: 9,
    at: at(D, '16:00:00'),
    kind: 'marketing',
    reason: 'Дегустация для партнёра',
    tenders: [['marketing', '60000', 'manager_approved']],
  });
  // 19.11 23:50, refunded at 00:10 on the 20th.
  const s10 = await posSale(db, c, {
    shift,
    number: 10,
    at: at(D, '23:50:00'),
    tenders: [['cash', '50000', 'drawer']],
  });
  await posRefund(db, c, { ...s10, shift }, 'refund', at('2026-11-20', '00:10:00'), s10.tenders);
  await posSale(db, c, {
    shift,
    number: 11,
    at: at('2026-11-20', '00:30:00'),
    tenders: [['cash', '100000', 'drawer']],
  });
  await cloudOrders(c, [
    { channel: 'kiosk', amount: '210000', at: at(D, '11:00:00') },
    {
      channel: 'mobile',
      amount: '330000',
      at: at(D, '14:00:00'),
      refund: { actor: p.manager.actor_id, amount: '30000', at: at(D, '14:30:00') },
    },
    { channel: 'mobile', amount: '990000', at: at('2026-11-18', '14:00:00') },
  ]);
  return { shift, earlier };
}
const pick = (rows, key, value) => rows.find((r) => r[key] === value);

// ------------------------------------------------------------------------- PostgreSQL ----

test('one day: channels, all eight methods, voids, refunds with approver, no revenue', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    const { shift, earlier } = await seed(c, p);
    const bo = new Backoffice(c.cloud.pool, true, { salesReportEnabled: true });
    const r = await bo.ops(p.manager.token, c.branch, 'sales', { start_date: D, end_date: D });
    assert.equal(r.schema_version, 1);
    assert.equal(r.view, 'sales');
    assert.equal(r.timezone, 'Asia/Almaty');
    assert.equal(r.period_start, '2026-11-18T19:00:00.000Z');
    assert.equal(r.period_end, '2026-11-19T19:00:00.000Z');
    assert.equal(r.coverage.pos, true);
    assert.equal(r.coverage.cloud, true);
    assert.equal(r.coverage.discounts, false);
    assert.ok(r.coverage.pos_received_at);
    assert.deepEqual(
      r.channels.map((v) => [
        v.channel,
        v.source,
        v.checks,
        v.voided_checks,
        v.sales_minor,
        v.voids_minor,
        v.refunds_minor,
        v.revenue_minor,
        v.average_check_minor,
      ]),
      [
        ['hall_dine_in', 'pos', 3, 0, '470000', '0', '70000', '400000', '156667'],
        ['hall_takeaway', 'pos', 2, 0, '430000', '0', '50000', '380000', '215000'],
        ['yandex_eda', 'pos', 1, 0, '400000', '0', '0', '400000', '400000'],
        ['glovo', 'pos', 0, 1, '200000', '200000', '0', '0', '0'],
        ['mobile', 'cloud', 1, 0, '330000', '0', '30000', '300000', '330000'],
        ['kiosk', 'cloud', 1, 0, '210000', '0', '0', '210000', '210000'],
      ],
    );
    assert.deepEqual(r.totals, {
      checks: 8,
      voided_checks: 1,
      sales_minor: '2040000',
      voids_minor: '200000',
      refunds_minor: '150000',
      revenue_minor: '1690000',
      average_check_minor: '230000',
      discount_minor: '0',
      no_revenue_checks: 2,
      no_revenue_minor: '150000',
    });
    assert.deepEqual(
      r.methods.map((m) => [
        m.method,
        m.source,
        m.revenue,
        m.payments,
        m.sales_minor,
        m.voids_minor,
        m.refunds_minor,
        m.net_minor,
      ]),
      [
        ['cash', 'pos', true, 3, '450000', '0', '70000', '380000'],
        ['kaspi_terminal', 'pos', true, 1, '150000', '0', '50000', '100000'],
        ['kaspi_manual', 'pos', true, 1, '120000', '0', '0', '120000'],
        ['aggregator_yandex_eda', 'pos', true, 1, '400000', '0', '0', '400000'],
        ['aggregator_glovo', 'pos', true, 1, '200000', '200000', '0', '0'],
        ['chocofood', 'pos', true, 1, '180000', '0', '0', '180000'],
        ['staff_meal', 'pos', false, 1, '90000', '0', '0', '90000'],
        ['marketing', 'pos', false, 1, '60000', '0', '0', '60000'],
        ['online', 'cloud', true, 2, '540000', '0', '30000', '510000'],
      ],
    );
    // Revenue methods add up to the revenue exactly; no-revenue methods to the no-revenue block.
    const net = (rows) => rows.reduce((a, m) => a + BigInt(m.net_minor), 0n).toString();
    assert.equal(net(r.methods.filter((m) => m.revenue)), r.totals.revenue_minor);
    assert.equal(net(r.methods.filter((m) => !m.revenue)), r.totals.no_revenue_minor);
    assert.deepEqual(r.no_revenue.kinds, [
      { revenue_kind: 'staff_meal', checks: 1, voided_checks: 0, total_minor: '90000' },
      { revenue_kind: 'marketing', checks: 1, voided_checks: 0, total_minor: '60000' },
    ]);
    assert.deepEqual(
      r.no_revenue.items.map((i) => [i.display_number, i.revenue_kind, i.beneficiary, i.reason]),
      [
        [9, 'marketing', null, 'Дегустация для партнёра'],
        [8, 'staff_meal', 'Синтетический сотрудник', null],
      ],
    );
    assert.equal(r.no_revenue.items[0].approval_manager_staff_id, STAFF.manager);
    // Newest first; the cashier approver is an edge staff id, the cloud one a named login.
    assert.deepEqual(
      r.refunds.map((v) => [
        v.source,
        v.kind,
        v.channel,
        v.display_number,
        v.amount_minor,
        v.approved_by_staff_id,
        v.approved_by_name,
        v.methods,
      ]),
      [
        [
          'pos',
          'void',
          'glovo',
          5,
          '200000',
          STAFF.manager,
          null,
          [{ method: 'aggregator_glovo', amount_minor: '200000' }],
        ],
        [
          'cloud',
          'refund',
          'mobile',
          null,
          '30000',
          null,
          'Синтетический управляющий',
          [{ method: 'online', amount_minor: '30000' }],
        ],
        [
          'pos',
          'refund',
          'hall_takeaway',
          3,
          '50000',
          STAFF.manager,
          null,
          [{ method: 'kaspi_terminal', amount_minor: '50000' }],
        ],
        [
          'pos',
          'refund',
          'hall_dine_in',
          1,
          '70000',
          STAFF.second,
          null,
          [{ method: 'cash', amount_minor: '70000' }],
        ],
      ],
    );
    assert.equal(r.refunds[1].approved_by_actor_id, p.manager.actor_id);
    assert.equal(r.refunds[0].reason_code, 'aggregator_cancelled');
    assert.equal(r.refunds[0].staff_id, STAFF.cashier);
    assert.deepEqual(r.by_day, [
      {
        day: D,
        checks: 8,
        sales_minor: '2040000',
        voids_minor: '200000',
        refunds_minor: '150000',
        revenue_minor: '1690000',
        no_revenue_minor: '150000',
      },
    ]);
    assert.equal(r.by_hour.length, 24);
    assert.deepEqual(
      r.by_hour.filter((h) => h.checks).map((h) => [h.hour, h.checks, h.sales_minor]),
      [
        [10, 1, '300000'],
        [11, 1, '210000'],
        [12, 1, '250000'],
        [13, 1, '400000'],
        [14, 1, '330000'],
        [19, 1, '120000'],
        [20, 1, '180000'],
        [23, 1, '50000'],
      ],
    );
    assert.deepEqual(r.top_items[0], {
      product_id: PRODUCT.burger,
      name: 'Синтетический бургер',
      quantity: 3,
      total_minor: '420000',
    });
    assert.equal(
      r.top_items.some((i) => i.total_minor === '200000'),
      false,
      'voided sale',
    );
    // The open shift has no Z yet; the earlier one is closed with its Z figures.
    assert.deepEqual(
      r.shifts.map((s) => [s.shift_id, s.checks, s.sales_minor, s.z === null]),
      [[shift, 6, '1500000', true]],
    );
    const both = await bo.ops(p.manager.token, c.branch, 'sales', {
      start_date: '2026-11-18',
      end_date: '2026-11-20',
    });
    const closed = pick(both.shifts, 'shift_id', earlier);
    assert.deepEqual(closed.z, {
      closed_at: at('2026-11-18', '23:55:00').toISOString(),
      expected_cash_minor: '1070000',
      counted_cash_minor: '1069500',
      discrepancy_minor: '-500',
      terminal_reported_minor: '0',
    });
    assert.deepEqual(
      both.by_day.map((d) => [d.day, d.checks, d.sales_minor, d.refunds_minor, d.revenue_minor]),
      [
        ['2026-11-18', 2, '1060000', '0', '1060000'],
        ['2026-11-19', 8, '2040000', '150000', '1690000'],
        ['2026-11-20', 1, '100000', '50000', '50000'],
      ],
    );
    assert.equal(both.totals.revenue_minor, '2800000');
    assert.equal(
      both.by_day.reduce((a, d) => a + BigInt(d.revenue_minor), 0n).toString(),
      both.totals.revenue_minor,
    );
  }));

test('flag, access and roles: 404 like an unknown view when off, reports.read when on', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    await seed(c, p);
    const q = { start_date: D, end_date: D };
    const off = new Backoffice(c.cloud.pool, true, {});
    await assert.rejects(off.ops(p.manager.token, c.branch, 'sales', q), is('NOT_FOUND'));
    await assert.rejects(off.ops(p.manager.token, c.branch, 'unknown', q), is('NOT_FOUND'));
    const stateOff = await off.read(p.manager.token, c.branch);
    assert.equal('sales_report' in stateOff.capabilities, false);
    const on = new Backoffice(c.cloud.pool, true, { salesReportEnabled: true, rolesEnabled: true });
    assert.equal((await on.read(p.manager.token, c.branch)).capabilities.sales_report, true);
    // Read access: every role that may read reports, nobody else; the query is strict.
    await designateBackoffice(
      c.cloud.pool,
      p.shift.actor_id,
      c.branch,
      'shift_manager',
      'Т7: смена',
    );
    for (const who of [p.manager, p.analyst, p.shift])
      assert.equal((await on.ops(who.token, c.branch, 'sales', q)).totals.revenue_minor, '1690000');
    await assert.rejects(on.ops(p.outsider.token, c.branch, 'sales', q), is('FORBIDDEN'));
    await assert.rejects(on.ops('0'.repeat(64), c.branch, 'sales', q), is('UNAUTHORIZED'));
    await assert.rejects(
      on.ops(p.manager.token, c.branch, 'sales', { start_date: '2026-08-19', end_date: D }),
      is('INVALID_REQUEST'),
    );
    await assert.rejects(
      on.ops(p.manager.token, c.branch, 'sales', { ...q, view: 'stock' }),
      is('INVALID_REQUEST'),
    );
    await assert.rejects(
      new Backoffice(c.cloud.pool, false, { salesReportEnabled: true }).ops(
        p.manager.token,
        c.branch,
        'sales',
        q,
      ),
      is('SERVICE_UNAVAILABLE'),
    );
    // Another branch never leaks into the report.
    const other = await on.ops(p.manager.token, c.branch, 'sales', {
      start_date: '2026-11-21',
      end_date: '2026-11-21',
    });
    assert.equal(other.totals.sales_minor, '0');
    assert.equal(other.refunds.length, 0);
  }));

test('a role without SELECT on cloud073 gets the cloud channels and coverage.pos=false', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    await seed(c, p);
    const role = 'sales_probe_' + randomUUID().replaceAll('-', '').slice(0, 12);
    const schema = (await c.cloud.pool.query('SELECT current_schema() s')).rows[0].s;
    await c.cloud.pool.query(`CREATE ROLE ${role} NOLOGIN`);
    try {
      await c.cloud.pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await c.cloud.pool.query(
        `GRANT SELECT ON commerce_orders,commerce_captures,commerce_refunds,commerce_refund_effects,
          cloud_fulfillment_projection,catalog_managers,cloud_pos_sales TO ${role}`,
      );
      const db = await c.cloud.pool.connect();
      try {
        await db.query('BEGIN');
        await db.query(`SET LOCAL ROLE ${role}`);
        assert.equal(await salesReportPosReadable(db), false);
        const r = await readSalesReport(db, c.branch, { start_date: D, end_date: D }, new Date());
        assert.equal(r.coverage.pos, false);
        assert.equal(r.coverage.pos_received_at, null);
        assert.deepEqual(
          r.channels.map((v) => v.channel),
          ['mobile', 'kiosk'],
        );
        assert.deepEqual(
          r.methods.map((m) => m.method),
          ['online'],
        );
        assert.equal(r.totals.revenue_minor, '510000');
        assert.deepEqual(r.no_revenue.kinds, [
          { revenue_kind: 'staff_meal', checks: 0, voided_checks: 0, total_minor: '0' },
          { revenue_kind: 'marketing', checks: 0, voided_checks: 0, total_minor: '0' },
        ]);
        assert.deepEqual(r.shifts, []);
        await db.query('ROLLBACK');
        // The provisioning path: the cloud073 reset with the back-office set, then the proof.
        await assert.rejects(
          assertBackofficeCutoverPrivileges(
            db,
            role,
            { backoffice: true, roles: false, salesReport: true },
            schema,
          ),
          /cloud_pos_refund_tenders,cloud_pos_refunds,cloud_pos_shift_reports,cloud_pos_tenders/,
        );
        await db.query(cloudPosSalesGrants(role, { receiver: false, backoffice: true }, schema));
        await assertBackofficeCutoverPrivileges(
          db,
          role,
          { backoffice: true, roles: false, salesReport: true },
          schema,
        );
        await db.query('BEGIN');
        await db.query(`SET LOCAL ROLE ${role}`);
        const granted = await readSalesReport(
          db,
          c.branch,
          { start_date: D, end_date: D },
          new Date(),
        );
        assert.equal(granted.coverage.pos, true);
        assert.equal(granted.totals.revenue_minor, '1690000');
        await db.query('ROLLBACK');
      } finally {
        db.release();
      }
    } finally {
      await c.cloud.pool.query(`DROP OWNED BY ${role}`);
      await c.cloud.pool.query(`DROP ROLE ${role}`);
    }
  }));

test('new runtime on a cloud schema without 073: cloud channels only, then 073 arrives', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-cloud-072-'));
  try {
    for (const file of await readdir(MIGRATIONS))
      if (file.endsWith('.sql') && file < '073')
        await cp(join(MIGRATIONS, file), join(directory, file));
    await withSyncDatabases(
      async (c) => {
        assert.equal(
          (await c.cloud.pool.query("SELECT to_regclass('cloud_pos_sales') t")).rows[0].t,
          null,
        );
        const p = await people(c);
        await cloudOrders(c, [{ channel: 'kiosk', amount: '210000', at: at(D, '11:00:00') }]);
        const bo = new Backoffice(c.cloud.pool, true, { salesReportEnabled: true });
        const r = await bo.ops(p.manager.token, c.branch, 'sales', { start_date: D, end_date: D });
        assert.equal(r.coverage.pos, false);
        assert.deepEqual(
          r.channels.map((v) => [v.channel, v.checks, v.revenue_minor]),
          [
            ['mobile', 0, '0'],
            ['kiosk', 1, '210000'],
          ],
        );
        assert.deepEqual(await migrate(c.cloud.pool, MIGRATIONS, 'cloud'), [
          '073_cloud_pos_sales_sync.sql',
          '074_cloud_backoffice_cutover.sql',
        ]);
        const after = await bo.ops(p.manager.token, c.branch, 'sales', {
          start_date: D,
          end_date: D,
        });
        assert.equal(after.coverage.pos, true);
        assert.equal(after.coverage.pos_received_at, null);
        assert.equal(after.channels.length, 6);
        assert.equal(after.methods.length, 9);
        assert.equal(after.totals.revenue_minor, '210000');
      },
      { cloudMigrationDirectory: directory },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('end to end: the pinned cashier vectors through the posSales receiver agree with the Z', () =>
  withPosSalesDatabases(async (c) => {
    const events = stream(c.branch);
    const result = await receivePosSales(
      c.cloud.pool,
      { deviceId: c.device, token: c.identity.token },
      { events },
    );
    assert.equal(result.receipts.length, events.length);
    assert.equal(result.rejected, undefined);
    const p = await people(c);
    const r = await new Backoffice(c.cloud.pool, true, { salesReportEnabled: true }).ops(
      p.manager.token,
      c.branch,
      'sales',
      { start_date: D, end_date: D },
    );
    assert.deepEqual(
      r.channels
        .filter((v) => v.source === 'pos')
        .map((v) => [
          v.channel,
          v.checks,
          v.voided_checks,
          v.sales_minor,
          v.voids_minor,
          v.refunds_minor,
          v.revenue_minor,
        ]),
      [
        ['hall_dine_in', 1, 1, '549000', '350000', '0', '199000'],
        ['hall_takeaway', 2, 0, '570050', '0', '100000', '470050'],
        ['yandex_eda', 1, 0, '510000', '0', '0', '510000'],
        ['glovo', 1, 0, '275000', '0', '0', '275000'],
      ],
    );
    assert.equal(r.totals.revenue_minor, '1454050');
    assert.equal(r.totals.average_check_minor, '310810');
    assert.equal(r.totals.no_revenue_minor, '270000');
    const net = (rows) => rows.reduce((a, m) => a + BigInt(m.net_minor), 0n).toString();
    assert.equal(net(r.methods.filter((m) => m.revenue)), r.totals.revenue_minor);
    assert.equal(net(r.methods.filter((m) => !m.revenue)), r.totals.no_revenue_minor);
    // Every method row of the frozen Z report equals the report's row for the same method.
    const z = events.find((e) => e.kind === 'shift_report').payload.report;
    for (const row of z.methods) {
      const m = pick(r.methods, 'method', row.method);
      assert.equal(m.sales_minor, row.sales_minor, row.method);
      assert.equal(
        (BigInt(m.voids_minor) + BigInt(m.refunds_minor)).toString(),
        row.refunds_minor,
        row.method,
      );
      assert.equal(m.payments, row.count, row.method);
    }
    assert.equal(r.shifts.length, 1);
    assert.equal(r.shifts[0].z.discrepancy_minor, z.discrepancy_minor);
    assert.equal(r.shifts[0].z.terminal_reported_minor, z.terminal_reported_minor);
    assert.deepEqual(
      r.refunds.map((v) => [v.kind, v.display_number, v.amount_minor]),
      [
        ['refund', 2, '100000'],
        ['void', 1, '350000'],
      ],
    );
  }));
