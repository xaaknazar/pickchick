import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '@pickchick/database';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';
import { provisionCatalogManager } from '../../catalog-admin/dist/index.js';
import {
  Backoffice,
  BackofficeError,
  EDGE_STAFF_ID_VECTOR,
  EDGE_STAFF_ROLES,
  POS_DAY_LIMITS,
  POS_DAY_TABLES,
  PosDayQuery,
  designateBackoffice,
  edgeStaffId,
  edgeStaffNames,
  grantBackoffice,
  posDayReadable,
  readPosDay,
} from '../dist/index.js';
import * as contracts from '../../contracts/dist/index.js';
import { POS_DAY_TABLES as GRANTED_TABLES } from '../../../infra/staging/backoffice-p1-grants.mjs';
import { receivePosSales } from '../../pos-order-sync/dist/index.js';
import { stream, withPosSalesDatabases } from '../../pos-order-sync/tests/sales-cloud-fixture.mjs';
import {
  DAY,
  EMPLOYEE,
  NAMES,
  ONE_METHODS,
  SHIFT,
  STAFF,
  TERMINAL,
  at,
  cashierShift,
  employees,
  receipt,
  sale,
  seedDay,
} from './pos-day-fixture.mjs';

/**
 * Lane bo-ui step 2: GET .../ops/pos-day («Касса», design-bo-ui.md 5.1) over synthetic cashier
 * rows (cloud073 as the posSales receiver writes them, cloud033 cashier reports) and the
 * edgeStaffId names (5.7). The day is 19.11.2026, Asia/Almaty (UTC+5); everything is synthetic.
 */
const MIGRATIONS = fileURLToPath(new URL('../../../db/cloud/migrations/', import.meta.url));
const is = (code, reason) => (error) =>
  error instanceof BackofficeError && error.code === code && error.reason === reason;
const pick = (rows, key, value) => rows.find((r) => r[key] === value);

// ------------------------------------------------------------------------------ pure ----

test('edgeStaffId: version 8 uuid of the pinned vector, roles are the edge staff roles', () => {
  assert.deepEqual([...EDGE_STAFF_ROLES], contracts.StaffRoleSchema.options);
  for (const role of EDGE_STAFF_ROLES) {
    const id = edgeStaffId(EDGE_STAFF_ID_VECTOR.employee_id, role);
    assert.equal(id, EDGE_STAFF_ID_VECTOR.ids[role], role);
    assert.equal(contracts.UuidSchema.safeParse(id).success, true, role);
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // An independent rendering of the formula of design-bo-ui.md 5.7.
    const hex = createHash('sha256')
      .update(`pickchick-edge-staff-v1:${EDGE_STAFF_ID_VECTOR.employee_id}:${role}`)
      .digest('hex');
    assert.equal(id.replaceAll('-', '').slice(0, 12), hex.slice(0, 12));
    assert.equal(id.replaceAll('-', '').slice(17), hex.slice(17, 32));
  }
  // Case of the card id never changes the edge id; roles give three different ids.
  const upper = EDGE_STAFF_ID_VECTOR.employee_id.toUpperCase();
  assert.equal(edgeStaffId(upper, 'cashier'), EDGE_STAFF_ID_VECTOR.ids.cashier);
  assert.equal(new Set(Object.values(EDGE_STAFF_ID_VECTOR.ids)).size, 3);
  assert.throws(() => edgeStaffId('not-a-uuid', 'cashier'), is('INVALID_REQUEST'));
  assert.throws(
    () => edgeStaffId(EDGE_STAFF_ID_VECTOR.employee_id, 'manager'),
    is('INVALID_REQUEST'),
  );
  const employee = randomUUID();
  const names = edgeStaffNames(
    [
      { id: employee, name: 'Синтетическая кассир' },
      { id: 'broken', name: 'Без номера' },
    ],
    [edgeStaffId(employee, 'shift_manager'), randomUUID(), null],
  );
  assert.deepEqual(names, {
    [edgeStaffId(employee, 'shift_manager')]: {
      name: 'Синтетическая кассир',
      employee_id: employee,
      role: 'shift_manager',
    },
  });
  assert.deepEqual(edgeStaffNames([{ id: employee, name: 'x' }], []), {});
});

test('pos-day query: one Almaty date and an optional cash desk, nothing else', () => {
  const terminal = randomUUID();
  assert.deepEqual(PosDayQuery.parse({ date: DAY }), { date: DAY });
  assert.deepEqual(PosDayQuery.parse({ date: DAY, terminal_id: terminal }), {
    date: DAY,
    terminal_id: terminal,
  });
  for (const bad of [
    {},
    { date: '19.11.2026' },
    { date: '2026-02-30' },
    { date: '1999-12-31' },
    { date: DAY, terminal_id: 'desk-1' },
    { date: DAY, start_date: DAY },
    { date: DAY, view: 'pos-day' },
  ])
    assert.equal(PosDayQuery.safeParse(bad).success, false, JSON.stringify(bad));
  // The grants helper gives SELECT on exactly the tables the view requires.
  assert.deepEqual([...POS_DAY_TABLES], [...GRANTED_TABLES]);
  assert.deepEqual(POS_DAY_LIMITS, { sales: 2000, earlier_sales: 200 });
});

// ------------------------------------------------------------------------- fixtures ----

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
    accountant: await person('Синтетический бухгалтер', 'analyst'),
    outsider: await person('Синтетический посторонний', null),
  };
}
const on = (c, extra = {}) => new Backoffice(c.cloud.pool, true, { posDayEnabled: true, ...extra });

// ------------------------------------------------------------------------- PostgreSQL ----

test('one day: shifts by opening day, sums by method equal tenders, refunds and no-revenue apart', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    await seedDay(c);
    const r = await on(c).ops(p.manager.token, c.branch, 'pos-day', { date: DAY });
    assert.equal(r.schema_version, 1);
    assert.equal(r.view, 'pos-day');
    assert.equal(r.date, DAY);
    assert.equal(r.terminal_id, null);
    assert.equal(r.timezone, 'Asia/Almaty');
    assert.equal(r.day_start, '2026-11-18T19:00:00.000Z');
    assert.equal(r.day_end, '2026-11-19T19:00:00.000Z');
    assert.equal(r.coverage.pos_tables, true);
    assert.equal(r.coverage.cashier_reports, true);
    assert.ok(r.coverage.last_received_at);
    assert.ok(r.coverage.cashier_reports_at);
    // Cash desks: by their first shift; a desk known only from sales comes last.
    assert.deepEqual(
      r.terminals.map((t) => [t.terminal_id, t.label]),
      [
        [TERMINAL.one, 'Касса 1'],
        [TERMINAL.two, 'Касса 2'],
        [TERMINAL.three, 'Касса 3'],
      ],
    );

    // Day totals (revenue only): sales 18 000 ₸, the Glovo void 2 000 ₸, refunds 7 500 ₸ (of
    // them 7 000 ₸ for the 18.11 receipt №9, refunded on the 19th in today's shift).
    assert.deepEqual(r.totals, {
      sales_count: 11,
      voided_count: 1,
      checks: 8,
      sales_minor: '1800000',
      voids_minor: '200000',
      refunds_minor: '750000',
      revenue_minor: '850000',
      average_check_minor: '200000',
      no_revenue: {
        checks: 2,
        total_minor: '150000',
        kinds: [
          { revenue_kind: 'staff_meal', checks: 1, total_minor: '90000' },
          { revenue_kind: 'marketing', checks: 1, total_minor: '60000' },
        ],
      },
    });
    assert.deepEqual(
      r.channels.map((v) => [
        v.channel,
        v.checks,
        v.sales_minor,
        v.voids_minor,
        v.refunds_minor,
        v.revenue_minor,
        v.average_check_minor,
      ]),
      [
        ['hall_dine_in', 5, '720000', '0', '700000', '20000', '144000'],
        ['hall_takeaway', 2, '480000', '0', '50000', '430000', '240000'],
        ['yandex_eda', 1, '400000', '0', '0', '400000', '400000'],
        ['glovo', 0, '200000', '200000', '0', '0', '0'],
      ],
    );
    assert.deepEqual(
      r.methods.map((m) => [
        m.method,
        m.revenue,
        m.payments,
        m.sales_minor,
        m.voids_minor,
        m.refunds_minor,
        m.net_minor,
      ]),
      [
        ['cash', true, 5, '700000', '0', '700000', '0'],
        ['kaspi_terminal', true, 1, '200000', '0', '50000', '150000'],
        ['kaspi_manual', true, 1, '120000', '0', '0', '120000'],
        ['aggregator_yandex_eda', true, 1, '400000', '0', '0', '400000'],
        ['aggregator_glovo', true, 1, '200000', '200000', '0', '0'],
        ['chocofood', true, 1, '180000', '0', '0', '180000'],
        ['staff_meal', false, 1, '90000', '0', '0', '90000'],
        ['marketing', false, 1, '60000', '0', '0', '60000'],
      ],
    );
    const net = (rows) => rows.reduce((a, m) => a + BigInt(m.net_minor), 0n).toString();
    assert.equal(net(r.methods.filter((m) => m.revenue)), r.totals.revenue_minor);
    assert.equal(net(r.methods.filter((m) => !m.revenue)), r.totals.no_revenue.total_minor);
    // Sums by method equal the tenders of the listed receipts of the day, method by method.
    const day = r.sales.filter((s) => s.of_day);
    assert.equal(day.length, 11);
    for (const m of r.methods) {
      const tendered = day
        .flatMap((s) => s.tenders)
        .filter((t) => t.method === m.method)
        .reduce((a, t) => a + BigInt(t.amount_minor), 0n);
      assert.equal(tendered.toString(), m.sales_minor, m.method);
      const returned = r.sales
        .flatMap((s) => s.refunds.filter((x) => x.in_day))
        .flatMap((x) => x.tenders)
        .filter((t) => t.method === m.method)
        .reduce((a, t) => a + BigInt(t.amount_minor), 0n);
      assert.equal(
        returned.toString(),
        (BigInt(m.voids_minor) + BigInt(m.refunds_minor)).toString(),
        m.method,
      );
    }

    // Shifts: desk one closes after midnight and keeps its 00:10 sale; desk two is open; the
    // shift without any report is listed from its sales.
    assert.deepEqual(
      r.shifts.map((s) => [s.shift_id, s.terminal_id, s.source, s.state]),
      [
        [SHIFT.one, TERMINAL.one, 'z', 'closed'],
        [SHIFT.two, TERMINAL.two, 'cashier_report', 'open'],
        [SHIFT.unknown, TERMINAL.three, 'sales', 'unknown'],
      ],
    );
    const one = pick(r.shifts, 'shift_id', SHIFT.one);
    assert.equal(one.opened_at, at(DAY, '09:00:00').toISOString());
    assert.equal(one.closed_at, at('2026-11-20', '00:30:00').toISOString());
    assert.deepEqual(one.cash, {
      opening_cash_minor: '1000000',
      cash_in_minor: '0',
      cash_out_minor: '0',
      cash_sales_minor: '500000',
      cash_refunds_minor: '700000',
      expected_cash_minor: '800000',
      counted_cash_minor: '795000',
      discrepancy_minor: '-5000',
    });
    assert.deepEqual(one.terminal, {
      expected_minor: '150000',
      reported_minor: '140000',
      discrepancy_minor: '-10000',
    });
    assert.deepEqual(one.flags, {
      cash_discrepancy: true,
      terminal_discrepancy: true,
      fiscal_pending: 3,
    });
    assert.deepEqual(one.fiscal, { pending: 3, recorded: 2, not_required: 4 });
    assert.equal(one.received.sales_count, 7);
    assert.equal(one.received.voided_count, 1);
    assert.equal(one.received.sales_minor, '1450000');
    assert.equal(one.received.refunds_minor, '950000');
    // The received methods are the Z methods of the shift, row by row.
    for (const row of ONE_METHODS)
      assert.deepEqual(pick(one.received.methods, 'method', row.method), row, row.method);
    assert.deepEqual(one.z.methods, ONE_METHODS);
    const two = pick(r.shifts, 'shift_id', SHIFT.two);
    assert.equal(two.z, null);
    assert.equal(two.closed_at, null);
    assert.equal(two.opened_by_staff_id, STAFF.second);
    assert.deepEqual(two.cash, {
      opening_cash_minor: '500000',
      cash_in_minor: '0',
      cash_out_minor: '0',
      cash_sales_minor: '150000',
      cash_refunds_minor: '0',
      expected_cash_minor: '650000',
      counted_cash_minor: null,
      discrepancy_minor: null,
    });
    assert.deepEqual(two.terminal, {
      expected_minor: '0',
      reported_minor: null,
      discrepancy_minor: null,
    });
    assert.deepEqual(two.flags, {
      cash_discrepancy: false,
      terminal_discrepancy: false,
      fiscal_pending: 1,
    });
    assert.deepEqual(
      two.received.methods.filter((m) => m.count).map((m) => [m.method, m.sales_minor]),
      [
        ['cash', '150000'],
        ['kaspi_manual', '120000'],
        ['chocofood', '180000'],
      ],
    );
    assert.deepEqual(two.cashier_staff_ids, [STAFF.second, STAFF.stranger].sort());
    const unknown = pick(r.shifts, 'shift_id', SHIFT.unknown);
    assert.equal(unknown.opened_at, null);
    assert.equal(unknown.cash, null);
    assert.equal(unknown.received.sales_minor, '50000');

    // Receipts: newest first, three receipts №1 on three desks, then the earlier refunded one.
    assert.deepEqual(
      r.sales.map((s) => [s.display_number, s.terminal_id, s.of_day]),
      [
        [7, TERMINAL.one, true],
        [1, TERMINAL.three, true],
        [3, TERMINAL.two, true],
        [6, TERMINAL.one, true],
        [5, TERMINAL.one, true],
        [4, TERMINAL.one, true],
        [3, TERMINAL.one, true],
        [2, TERMINAL.two, true],
        [2, TERMINAL.one, true],
        [1, TERMINAL.two, true],
        [1, TERMINAL.one, true],
        [9, TERMINAL.one, false],
      ],
    );
    const ones = r.sales.filter((s) => s.display_number === 1);
    assert.equal(new Set(ones.map((s) => s.terminal_id)).size, 3);
    const first = r.sales.find((s) => s.display_number === 1 && s.terminal_id === TERMINAL.one);
    assert.equal(first.cash_tendered_minor, '300000');
    assert.equal(first.change_minor, '50000');
    assert.equal(first.channel, 'hall_dine_in');
    assert.deepEqual(first.lines, [
      {
        name: 'Синтетический бургер',
        quantity: 1,
        unit_price_minor: '250000',
        total_minor: '250000',
        modifiers: [{ group: 'Соус', name: 'Сырный', quantity: 1, price_minor: '0' }],
      },
    ]);
    assert.deepEqual(
      first.fiscal.map((f) => [f.kind, f.state, f.receipt_number, f.recorded_by_staff_id]),
      [['sale', 'recorded', 'SYN-0001', STAFF.cashier]],
    );
    const glovo = r.sales.find((s) => s.display_number === 6);
    assert.equal(glovo.state, 'voided');
    assert.equal(glovo.external_order_ref, 'GL-777');
    assert.equal(glovo.refunded_minor, '200000');
    assert.deepEqual(
      glovo.refunds.map((x) => [
        x.kind,
        x.amount_minor,
        x.reason_code,
        x.approved_by_staff_id,
        x.in_day,
      ]),
      [['void', '200000', 'aggregator_cancelled', STAFF.manager, true]],
    );
    const mixed = r.sales.find((s) => s.display_number === 2 && s.terminal_id === TERMINAL.one);
    assert.deepEqual(
      mixed.tenders.map((t) => [t.method, t.amount_minor]),
      [
        ['cash', '100000'],
        ['kaspi_terminal', '200000'],
      ],
    );
    assert.deepEqual(
      mixed.fiscal.map((f) => [f.kind, f.state, f.receipt_number, f.in_day]),
      [
        ['sale', 'pending', null, true],
        ['refund', 'recorded', 'SYN-0002', true],
      ],
    );
    const meal = r.sales.find((s) => s.display_number === 4);
    assert.equal(meal.revenue_kind, 'staff_meal');
    assert.equal(meal.beneficiary, 'Синтетический сотрудник');
    assert.equal(meal.approval_manager_staff_id, STAFF.manager);
    assert.equal(r.sales.find((s) => s.display_number === 5).reason, 'Дегустация для партнёра');
    const manual = r.sales.find((s) => s.display_number === 1 && s.terminal_id === TERMINAL.two);
    assert.equal(manual.tenders[0].reference, 'KM-55');
    // №9 of 18.11: its money is the 18th, its refund (in shift «one») the 19th.
    const nine = r.sales.find((s) => !s.of_day);
    assert.equal(nine.business_date, '2026-11-18');
    assert.deepEqual(
      nine.refunds.map((x) => [x.kind, x.amount_minor, x.shift_id, x.in_day]),
      [['refund', '700000', SHIFT.one, true]],
    );
    assert.deepEqual(
      nine.fiscal.map((f) => [f.kind, f.state, f.in_day]),
      [
        ['sale', 'recorded', false],
        ['refund', 'pending', true],
      ],
    );

    // Webkassa of the day: sale receipts of its receipts, refund receipts of its refunds.
    assert.deepEqual(r.fiscal_summary, {
      pending: { count: 5, amount_minor: '1350000' },
      recorded: { count: 3, sales_minor: '370000', refunds_minor: '50000', net_minor: '320000' },
      not_required: {
        count: 5,
        amount_minor: '930000',
        methods: [
          { method: 'aggregator_yandex_eda', count: 1, amount_minor: '400000' },
          { method: 'aggregator_glovo', count: 1, amount_minor: '200000' },
          { method: 'chocofood', count: 1, amount_minor: '180000' },
          { method: 'staff_meal', count: 1, amount_minor: '90000' },
          { method: 'marketing', count: 1, amount_minor: '60000' },
        ],
      },
    });
    const listedReceipts = r.sales.flatMap((s) => s.fiscal.filter((f) => f.in_day));
    assert.equal(listedReceipts.length, 13);
    assert.equal(listedReceipts.filter((f) => f.state === 'pending').length, 5);

    // Names: every linked edge id is named, the stranger is not.
    assert.deepEqual(r.staff, {
      ...Object.fromEntries(
        [
          [STAFF.cashier, 'cashier', 'cashier'],
          [STAFF.manager, 'manager', 'shift_manager'],
          [STAFF.second, 'second', 'cashier'],
        ]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, key, role]) => [id, { name: NAMES[key], employee_id: EMPLOYEE[key], role }]),
      ),
    });
    assert.equal(STAFF.stranger in r.staff, false);
    assert.deepEqual(r.truncated, { sales: false, earlier_sales: false });
    assert.deepEqual(r.limits, { sales: 2000, earlier_sales: 200 });
  }));

test('neighbour days and one cash desk: a shift after midnight stays on its opening day', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    await seedDay(c);
    const bo = on(c);
    const view = (q) => bo.ops(p.manager.token, c.branch, 'pos-day', q);
    const desk = await view({ date: DAY, terminal_id: TERMINAL.two });
    assert.equal(desk.terminal_id, TERMINAL.two);
    assert.deepEqual(
      desk.shifts.map((s) => s.shift_id),
      [SHIFT.two],
    );
    assert.deepEqual(
      desk.sales.map((s) => s.display_number),
      [3, 2, 1],
    );
    assert.equal(desk.totals.revenue_minor, '450000');
    assert.equal(desk.totals.sales_count, 3);
    assert.deepEqual(desk.fiscal_summary.pending, { count: 1, amount_minor: '150000' });
    // The picker still names every desk.
    assert.equal(desk.terminals.length, 3);
    const deskOne = await view({ date: DAY, terminal_id: TERMINAL.one });
    assert.equal(deskOne.totals.refunds_minor, '750000');
    assert.equal(deskOne.sales.filter((s) => !s.of_day).length, 1);
    // 18.11: the earlier shift with №9; its refund is the 19th's, not the 18th's.
    const before = await view({ date: '2026-11-18' });
    assert.deepEqual(
      before.shifts.map((s) => [s.shift_id, s.source]),
      [[SHIFT.earlier, 'z']],
    );
    assert.deepEqual(
      before.sales.map((s) => [s.display_number, s.of_day]),
      [[9, true]],
    );
    assert.equal(before.totals.revenue_minor, '700000');
    assert.equal(before.totals.refunds_minor, '0');
    assert.equal(before.sales[0].refunds[0].in_day, false);
    assert.deepEqual(before.fiscal_summary.recorded, {
      count: 1,
      sales_minor: '700000',
      refunds_minor: '0',
      net_minor: '700000',
    });
    // 20.11: №7 (00:10) belongs to shift «one» of the 19th; only the unknown 20.11 shift is here.
    const after = await view({ date: '2026-11-20' });
    assert.deepEqual(
      after.shifts.map((s) => [s.shift_id, s.source]),
      [[SHIFT.next, 'sales']],
    );
    assert.deepEqual(
      after.sales.map((s) => [s.display_number, s.total_minor]),
      [[1, '30000']],
    );
    // A day without anything: honest zeros only because the tables are there.
    const empty = await view({ date: '2026-11-25' });
    assert.deepEqual(empty.shifts, []);
    assert.deepEqual(empty.sales, []);
    assert.equal(empty.totals.sales_count, 0);
    assert.deepEqual(empty.staff, {});
  }));

test('flag, access and roles: 404 like an unknown view when off, every reading role when on', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    await seedDay(c);
    const q = { date: DAY };
    const off = new Backoffice(c.cloud.pool, true, {
      rolesEnabled: true,
      salesReportEnabled: true,
    });
    await assert.rejects(off.ops(p.manager.token, c.branch, 'pos-day', q), is('NOT_FOUND'));
    assert.equal('pos_day' in (await off.read(p.manager.token, c.branch)).capabilities, false);
    const bo = on(c, { rolesEnabled: true });
    assert.equal((await bo.read(p.manager.token, c.branch)).capabilities.pos_day, true);
    await designateBackoffice(
      c.cloud.pool,
      p.shift.actor_id,
      c.branch,
      'shift_manager',
      'Т7: смена',
    );
    await designateBackoffice(
      c.cloud.pool,
      p.accountant.actor_id,
      c.branch,
      'accountant',
      'Т7: сверка',
    );
    for (const who of [p.manager, p.analyst, p.shift, p.accountant]) {
      const r = await bo.ops(who.token, c.branch, 'pos-day', q);
      assert.equal(r.totals.revenue_minor, '850000');
      assert.equal(r.sales.length, 12);
    }
    await assert.rejects(bo.ops(p.outsider.token, c.branch, 'pos-day', q), is('FORBIDDEN'));
    await assert.rejects(bo.ops('0'.repeat(64), c.branch, 'pos-day', q), is('UNAUTHORIZED'));
    for (const bad of [
      {},
      { date: '2026-11-31' },
      { ...q, terminal_id: 'one' },
      { ...q, extra: '1' },
    ])
      await assert.rejects(
        bo.ops(p.manager.token, c.branch, 'pos-day', bad),
        is('INVALID_REQUEST'),
      );
    await assert.rejects(
      new Backoffice(c.cloud.pool, false, { posDayEnabled: true }).ops(
        p.manager.token,
        c.branch,
        'pos-day',
        q,
      ),
      is('SERVICE_UNAVAILABLE'),
    );
    // Another branch of the same organization never sees these receipts.
    const other = randomUUID();
    await c.cloud.pool.query(
      "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES ($1,$2,$3,'SYN2','Synthetic 2')",
      [other, c.org, c.legal],
    );
    const elsewhere = await provisionCatalogManager(c.cloud.pool, {
      organization_id: c.org,
      name: 'Синтетический управляющий 2',
      branch_ids: [other],
    });
    await grantBackoffice(c.cloud.pool, elsewhere.actor_id, other, 'manager');
    const foreign = await bo.ops(elsewhere.token, other, 'pos-day', q);
    assert.deepEqual(foreign.sales, []);
    assert.deepEqual(foreign.shifts, []);
    assert.deepEqual(foreign.terminals, []);
    assert.equal(foreign.totals.sales_count, 0);
    await assert.rejects(bo.ops(elsewhere.token, c.branch, 'pos-day', q), is('FORBIDDEN'));
  }));

test('more than 2000 receipts: the list stops at 2000 with truncated, the totals stay exact', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    const day = '2026-11-21';
    const shift = randomUUID();
    await c.cloud.pool.query(
      `WITH n AS (SELECT g, gen_random_uuid() AS id FROM generate_series(1, 2001) g),
       s AS (INSERT INTO cloud_pos_sales(order_id,branch_id,device_id,shift_id,terminal_id,cashier_staff_id,
          display_number,sold_at,business_date,sales_channel,service_mode,revenue_kind,subtotal_minor,
          discount_minor,total_minor,cash_tendered_minor,change_minor,release_id,menu_version,lines,state,last_sequence)
        SELECT id,$1,$2,$3,$4,$5,g,$6::timestamptz + g * interval '10 seconds',$7::date,'hall','dine_in','revenue',
          100000,0,100000,100000,0,gen_random_uuid(),1,'[]'::jsonb,'paid',g FROM n RETURNING order_id,sold_at)
       INSERT INTO cloud_pos_tenders(tender_id,order_id,branch_id,method,amount_minor,confirmation,created_at)
       SELECT gen_random_uuid(),order_id,$1,'cash',100000,'drawer',sold_at FROM s`,
      [c.branch, c.device, shift, TERMINAL.one, STAFF.cashier, at(day, '09:00:00'), day],
    );
    const r = await on(c).ops(p.manager.token, c.branch, 'pos-day', { date: day });
    assert.equal(r.sales.length, POS_DAY_LIMITS.sales);
    assert.deepEqual(r.truncated, { sales: true, earlier_sales: false });
    assert.equal(r.sales[0].display_number, 2001);
    assert.equal(r.totals.sales_count, 2001);
    assert.equal(r.totals.revenue_minor, '200100000');
    assert.equal(pick(r.methods, 'method', 'cash').payments, 2001);
    assert.equal(r.shifts[0].received.sales_count, 2001);
  }));

test('a role without SELECT on a cloud073 table, or a schema without 073: pos_tables=false', async () => {
  await withSyncDatabases(async (c) => {
    await seedDay(c);
    const role = 'posday_probe_' + randomUUID().replaceAll('-', '').slice(0, 12);
    const schema = (await c.cloud.pool.query('SELECT current_schema() s')).rows[0].s;
    await c.cloud.pool.query(`CREATE ROLE ${role} NOLOGIN`);
    try {
      await c.cloud.pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await c.cloud.pool.query(
        `GRANT SELECT ON cloud_pos_sales,cloud_pos_tenders,cloud_pos_refunds,cloud_pos_refund_tenders,
          cloud_pos_shift_reports,cloud_cashier_shifts,cloud_cashier_orders,bo_records,devices TO ${role}`,
      );
      const db = await c.cloud.pool.connect();
      try {
        await db.query('BEGIN');
        await db.query(`SET LOCAL ROLE ${role}`);
        assert.equal(await posDayReadable(db), false);
        const r = await readPosDay(db, c.branch, { date: DAY }, new Date());
        assert.equal(r.coverage.pos_tables, false);
        assert.equal(r.coverage.cashier_reports, true);
        assert.equal(r.coverage.last_received_at, null);
        assert.deepEqual(r.sales, []);
        assert.equal(r.totals, null);
        assert.equal(r.fiscal_summary, null);
        assert.deepEqual(r.methods, []);
        assert.deepEqual(r.channels, []);
        // The cashier reports still list the open shift of desk two, without receipts.
        assert.deepEqual(
          r.shifts.map((s) => [s.shift_id, s.source, s.received.sales_count]),
          [[SHIFT.two, 'cashier_report', 0]],
        );
        await db.query('ROLLBACK');
        await db.query(`GRANT SELECT ON cloud_pos_fiscal_receipts TO ${role}`);
        await db.query('BEGIN');
        await db.query(`SET LOCAL ROLE ${role}`);
        const granted = await readPosDay(db, c.branch, { date: DAY }, new Date());
        assert.equal(granted.coverage.pos_tables, true);
        assert.equal(granted.totals.revenue_minor, '850000');
        await db.query('ROLLBACK');
      } finally {
        db.release();
      }
    } finally {
      await c.cloud.pool.query(`DROP OWNED BY ${role}`);
      await c.cloud.pool.query(`DROP ROLE ${role}`);
    }
  });
  const directory = await mkdtemp(join(tmpdir(), 'pickchick-cloud-072-'));
  try {
    for (const file of await readdir(MIGRATIONS))
      if (file.endsWith('.sql') && file < '073')
        await cp(join(MIGRATIONS, file), join(directory, file));
    await withSyncDatabases(
      async (c) => {
        const p = await people(c);
        await employees(c);
        await cashierShift(c, {
          shift: SHIFT.two,
          terminal: TERMINAL.two,
          staff: STAFF.second,
          opened: at(DAY, '10:00:00'),
          opening: '500000',
          expected: '500000',
        });
        const bo = on(c);
        assert.equal((await bo.read(p.manager.token, c.branch)).capabilities.pos_day, true);
        const r = await bo.ops(p.manager.token, c.branch, 'pos-day', { date: DAY });
        assert.equal(r.coverage.pos_tables, false);
        assert.equal(r.totals, null);
        assert.deepEqual(
          r.shifts.map((s) => [s.shift_id, s.state, s.cash.cash_sales_minor]),
          [[SHIFT.two, 'open', null]],
        );
        assert.deepEqual(r.terminals, [
          {
            terminal_id: TERMINAL.two,
            label: 'Касса 1',
            first_seen_at: at(DAY, '10:00:00').toISOString(),
          },
        ]);
        // The opener's name resolves from the card even without cloud073.
        assert.equal(r.staff[STAFF.second].name, NAMES.second);
        // 073 and later arrive: the same view reads the projections.
        await migrate(c.cloud.pool, MIGRATIONS, 'cloud');
        const after = await bo.ops(p.manager.token, c.branch, 'pos-day', { date: DAY });
        assert.equal(after.coverage.pos_tables, true);
        assert.equal(after.totals.sales_count, 0);
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
    assert.equal(result.rejected, undefined);
    const p = await people(c);
    const r = await on(c).ops(p.manager.token, c.branch, 'pos-day', { date: DAY });
    const z = events.find((e) => e.kind === 'shift_report').payload.report;
    assert.equal(r.shifts.length, 1);
    const shift = r.shifts[0];
    assert.equal(shift.source, 'z');
    assert.equal(shift.shift_id, z.shift_id);
    assert.equal(shift.cash.discrepancy_minor, z.discrepancy_minor);
    assert.equal(shift.cash.expected_cash_minor, z.expected_cash_minor);
    // Every Z method row equals the received row of the same method: the receipts add up.
    for (const row of z.methods)
      assert.deepEqual(pick(shift.received.methods, 'method', row.method), row, row.method);
    assert.equal(shift.terminal.reported_minor, z.terminal_reported_minor);
    assert.equal(shift.terminal.discrepancy_minor, z.terminal_discrepancy_minor);
    // The same day in the sales report (CC-7) has the same revenue.
    const sales = await new Backoffice(c.cloud.pool, true, { salesReportEnabled: true }).ops(
      p.manager.token,
      c.branch,
      'sales',
      { start_date: DAY, end_date: DAY },
    );
    assert.equal(r.totals.revenue_minor, sales.totals.revenue_minor);
    assert.equal(r.totals.no_revenue.total_minor, sales.totals.no_revenue_minor);
    assert.equal(r.totals.average_check_minor, sales.totals.average_check_minor);
    assert.equal(r.sales.length, events.filter((e) => e.kind === 'sale').length);
    assert.equal(
      r.fiscal_summary.pending.count +
        r.fiscal_summary.recorded.count +
        r.fiscal_summary.not_required.count,
      r.sales.flatMap((s) => s.fiscal).length,
    );
  }));

// ------------------------------------------------------ registry and order card (F04, F10) ----

/** A paid POS sale in the cashier reports exactly as the pos lane's widened stream writes it. */
async function cashierSale(c) {
  await employees(c);
  const shift = SHIFT.two;
  await cashierShift(c, {
    shift,
    terminal: TERMINAL.two,
    staff: STAFF.second,
    opened: at(DAY, '10:00:00'),
    opening: '500000',
    cash_sales: '150000',
    expected: '650000',
  });
  const s = await sale(c, {
    shift,
    terminal: TERMINAL.two,
    cashier: STAFF.second,
    number: 12,
    at: at(DAY, '11:00:00'),
    tenders: [['cash', '150000', 'drawer']],
    tendered: '200000',
  });
  await receipt(c, s, { state: 'pending' });
  const payload = {
    order_id: s.id,
    cash_shift_id: shift,
    created_at: at(DAY, '11:00:00').toISOString(),
    total_minor: '150000',
    state: 'paid',
    version: 1,
    execution_mode: 'pos_sale',
    kitchen_state: 'accepted',
    display_number: '12',
    lines: [
      {
        variant_id: randomUUID(),
        name: { ru: 'Синтетический бургер', kk: '' },
        quantity: 1,
        unit_price_minor: '150000',
        total_minor: '150000',
      },
    ],
  };
  await c.cloud.pool.query(
    `INSERT INTO cloud_cashier_orders(id,branch_id,device_id,cash_shift_id,created_at,sequence,payload)
     VALUES($1,$2,$3,$4,$5,1000,$6)`,
    [s.id, c.branch, c.device, shift, payload.created_at, payload],
  );
  return { ...s, payload };
}
const stable = (state) => {
  const copy = { ...state };
  for (const key of ['as_of', 'period_start', 'period_end']) delete copy[key];
  return copy;
};

test('flag off: the registry and the order card of a paid POS sale are exactly as before', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    const s = await cashierSale(c);
    const lane = new Backoffice(c.cloud.pool, true, {});
    const read = await lane.read(p.manager.token, c.branch, {
      period: 'custom',
      start_date: DAY,
      end_date: DAY,
    });
    const row = read.cashier_orders[0];
    assert.equal(row.id, s.id);
    // The cloud lane result: a paid sale still reads not_started (CR pos-4 section 2 is behind
    // BACKOFFICE_POS_DAY_ENABLED), the key set is the payload plus the eight fixed keys.
    assert.equal(row.payment_state, 'not_started');
    assert.equal(row.fiscal_state, 'not_requested');
    assert.deepEqual(
      Object.keys(row).filter((key) => !(key in s.payload)),
      ['id', 'observed_at', 'owner', 'channel', 'source', 'payment_state', 'fiscal_state'],
    );
    assert.deepEqual(Object.keys(read.cashier_metrics), [
      'orders',
      'cancelled_orders',
      'unpaid_total_minor',
      'completed_total_minor',
    ]);
    assert.equal('pos_terminals' in read, false);
    assert.equal('pos_staff' in read, false);
    const card = await lane.order(p.manager.token, c.branch, s.id);
    assert.deepEqual(Object.keys(card), [
      'order',
      'owner',
      'source',
      'captures',
      'refunds',
      'fiscal',
      'events',
      'capabilities',
    ]);
    assert.equal(card.order.payment_state, 'not_started');
    // With every P1 option explicitly absent the payloads are the same bytes.
    const explicit = new Backoffice(c.cloud.pool, true, { posDayEnabled: false });
    assert.deepEqual(
      stable(
        await explicit.read(p.manager.token, c.branch, {
          period: 'custom',
          start_date: DAY,
          end_date: DAY,
        }),
      ),
      stable(read),
    );
    assert.deepEqual(await explicit.order(p.manager.token, c.branch, s.id), card);
  }));

test('flag on: a paid POS sale is paid, with its cash desk, Webkassa state and receipt card', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    const s = await cashierSale(c);
    const bo = on(c);
    const read = await bo.read(p.manager.token, c.branch, {
      period: 'custom',
      start_date: DAY,
      end_date: DAY,
    });
    const row = read.cashier_orders[0];
    assert.equal(row.payment_state, 'captured');
    assert.equal(row.fiscal_state, 'pending');
    assert.equal(row.terminal_id, TERMINAL.two);
    assert.equal(read.cashier_metrics.paid_total_minor, '150000');
    assert.equal(read.cashier_metrics.unpaid_total_minor, '0');
    assert.deepEqual(read.pos_staff, {
      [STAFF.second]: { name: NAMES.second, employee_id: EMPLOYEE.second, role: 'cashier' },
    });
    assert.deepEqual(read.pos_terminals, [
      {
        terminal_id: TERMINAL.two,
        label: 'Касса 1',
        first_seen_at: at(DAY, '10:00:00').toISOString(),
      },
    ]);
    const card = await bo.order(p.manager.token, c.branch, s.id);
    assert.equal(card.order.payment_state, 'captured');
    assert.equal(card.order.fiscal_state, 'pending');
    assert.equal(card.pos_sale.order_id, s.id);
    assert.equal(card.pos_sale.change_minor, '50000');
    assert.deepEqual(
      card.pos_sale.tenders.map((t) => [t.method, t.amount_minor]),
      [['cash', '150000']],
    );
    assert.deepEqual(card.pos_terminal, read.pos_terminals[0]);
    assert.equal(card.pos_staff[STAFF.second].name, NAMES.second);
    // Without cloud073 rows for an order the card says so (null), never invents a payment.
    const unpaid = randomUUID();
    await c.cloud.pool.query(
      `INSERT INTO cloud_cashier_orders(id,branch_id,device_id,cash_shift_id,created_at,sequence,payload)
       VALUES($1,$2,$3,$4,$5,1001,$6)`,
      [
        unpaid,
        c.branch,
        c.device,
        SHIFT.two,
        at(DAY, '11:30:00'),
        {
          order_id: unpaid,
          cash_shift_id: SHIFT.two,
          created_at: at(DAY, '11:30:00').toISOString(),
          total_minor: '50000',
          state: 'awaiting_payment',
          version: 1,
          execution_mode: 'unpaid_service',
          kitchen_state: 'accepted',
          display_number: '13',
          lines: [
            {
              variant_id: randomUUID(),
              name: { ru: 'Синтетический чай', kk: '' },
              quantity: 1,
              unit_price_minor: '50000',
              total_minor: '50000',
            },
          ],
        },
      ],
    );
    const other = await bo.order(p.manager.token, c.branch, unpaid);
    assert.equal(other.order.payment_state, 'not_started');
    assert.equal(other.pos_sale, null);
    assert.deepEqual(other.pos_staff, {});
    const again = await bo.read(p.manager.token, c.branch, {
      period: 'custom',
      start_date: DAY,
      end_date: DAY,
    });
    assert.equal(pick(again.cashier_orders, 'id', unpaid).terminal_id, TERMINAL.two);
    assert.equal(again.cashier_metrics.unpaid_total_minor, '50000');
  }));

// ------------------------------------------------------------------ audit log names (F08) ----

test('audit log (F08): names only with the flag; without it the rows keep the cloud lane keys', () =>
  withSyncDatabases(async (c) => {
    const p = await people(c);
    const lane = new Backoffice(c.cloud.pool, true, {});
    await lane.command(p.manager.token, c.branch, {
      request_id: randomUUID(),
      reason: 'Синтетическая запись журнала',
      command: {
        type: 'save',
        kind: 'ingredient',
        id: randomUUID(),
        expected_revision: 0,
        payload: { name: 'Синтетическая булка', unit: 'pcs', minimum: '0', active: true },
      },
    });
    const off = await lane.read(p.manager.token, c.branch, { period: 'day' });
    assert.equal(off.audit.length, 1);
    assert.deepEqual(Object.keys(off.audit[0]), [
      'id',
      'actor_id',
      'action',
      'entity_id',
      'reason',
      'created_at',
    ]);
    const named = await on(c).read(p.manager.token, c.branch, { period: 'day' });
    assert.deepEqual(Object.keys(named.audit[0]), [
      'id',
      'actor_id',
      'actor_name',
      'action',
      'entity_id',
      'reason',
      'created_at',
    ]);
    assert.equal(named.audit[0].actor_name, 'Синтетический управляющий');
    const { actor_name: name, ...rest } = named.audit[0];
    assert.equal(name, 'Синтетический управляющий');
    assert.deepEqual(rest, off.audit[0], 'the name is the only difference');
    // Every reading role sees the same names (the log is reports.read).
    const analyst = await on(c).read(p.analyst.token, c.branch, { period: 'day' });
    assert.equal(analyst.audit[0].actor_name, 'Синтетический управляющий');
  }));
