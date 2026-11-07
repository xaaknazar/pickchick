import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { allowedPath } from '../../apps/backoffice/dist/api.js';
import { salesReportAvailable } from '../../apps/backoffice/dist/operations-model.js';
import {
  NO_REVENUE_LABELS,
  REFUND_REASON_LABELS,
  SALES_CHANNEL_LABELS,
  SALES_METHOD_LABELS,
  SALES_REPORT_RULES,
  almatyTime,
  approverLabel,
  csvTenge,
  money,
  salesCsv,
  salesCsvText,
  salesReport,
} from '../../apps/backoffice/dist/sales-report-model.js';
import {
  NO_REVENUE_METHODS,
  SALES_REPORT_CHANNELS,
  SALES_REPORT_METHODS,
} from '../../packages/backoffice-core/dist/index.js';
import * as contracts from '../../packages/contracts/dist/index.js';

/** Cutover CC-7 in the cabinet: names, parser, CSV and allowlist of the sales report. */
const branch = randomUUID();
const LONG_DASH = /[–—]/;

test('every server code has a Russian name: six channels, eight methods and online', () => {
  assert.deepEqual(Object.keys(SALES_CHANNEL_LABELS), [...SALES_REPORT_CHANNELS]);
  assert.deepEqual(Object.keys(SALES_METHOD_LABELS), [...SALES_REPORT_METHODS, 'online']);
  assert.deepEqual(Object.keys(NO_REVENUE_LABELS), [...NO_REVENUE_METHODS]);
  assert.deepEqual(Object.keys(REFUND_REASON_LABELS), contracts.PosRefundReasonSchema.options);
  for (const text of [
    ...Object.values(SALES_CHANNEL_LABELS),
    ...Object.values(SALES_METHOD_LABELS),
    ...Object.values(REFUND_REASON_LABELS),
    ...SALES_REPORT_RULES,
  ])
    assert.doesNotMatch(text, LONG_DASH, text);
});

test('UI sources of the report use the plain hyphen only', async () => {
  for (const file of ['sales-report.ts', 'sales-report-model.ts']) {
    const source = await readFile(
      new URL(`../../apps/backoffice/src/${file}`, import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(source, LONG_DASH, file);
  }
});

test('cabinet allowlist and capability: ops/sales with exactly two dates', () => {
  const path = (q) => `operations/branches/${branch}/ops/sales?${q}`;
  assert.equal(allowedPath(path('start_date=2026-11-19&end_date=2026-11-19')), true);
  for (const q of [
    'start_date=2026-11-19',
    'start_date=2026-11-19&end_date=2026-11-19&view=sales',
    'start_date=19.11.2026&end_date=2026-11-19',
    'start_date=2026-11-19&end_date=2026-11-19&start_date=2026-11-18',
  ])
    assert.equal(allowedPath(path(q)), false, q);
  assert.equal(allowedPath(`operations/branches/${branch}/ops/sales`), false);
  assert.equal(salesReportAvailable({ capabilities: { sales_report: true } }), true);
  for (const capabilities of [{}, { sales_report: 'true' }, { stock_v2: true }])
    assert.equal(salesReportAvailable({ capabilities }), false);
  assert.equal(salesReportAvailable(null), false);
});

const report = (change = {}) => ({
  schema_version: 1,
  branch_id: branch,
  view: 'sales',
  timezone: 'Asia/Almaty',
  start_date: '2026-11-19',
  end_date: '2026-11-19',
  as_of: '2026-11-19T18:00:00.000Z',
  coverage: {
    pos: true,
    cloud: true,
    pos_received_at: '2026-11-19T17:41:00.000Z',
    discounts: false,
  },
  totals: {
    checks: 2,
    voided_checks: 1,
    sales_minor: '450050',
    voids_minor: '100000',
    refunds_minor: '50000',
    revenue_minor: '300050',
    average_check_minor: '175025',
    discount_minor: '0',
    no_revenue_checks: 1,
    no_revenue_minor: '90000',
  },
  channels: [
    {
      channel: 'hall_dine_in',
      source: 'pos',
      checks: 2,
      voided_checks: 1,
      sales_minor: '450050',
      voids_minor: '100000',
      refunds_minor: '50000',
      revenue_minor: '300050',
      average_check_minor: '175025',
      discount_minor: '0',
    },
  ],
  methods: SALES_REPORT_METHODS.map((method) => ({
    method,
    source: 'pos',
    revenue: !NO_REVENUE_METHODS.includes(method),
    payments: method === 'cash' ? 2 : 0,
    sales_minor: method === 'cash' ? '450050' : '0',
    voids_minor: method === 'cash' ? '100000' : '0',
    refunds_minor: method === 'cash' ? '50000' : '0',
    net_minor: method === 'cash' ? '300050' : '0',
  })),
  by_day: [
    {
      day: '2026-11-19',
      checks: 2,
      sales_minor: '450050',
      voids_minor: '100000',
      refunds_minor: '50000',
      revenue_minor: '-50',
      no_revenue_minor: '90000',
    },
  ],
  by_hour: Array.from({ length: 24 }, (_, hour) => ({ hour, checks: 0, sales_minor: '0' })),
  no_revenue: {
    kinds: [
      { revenue_kind: 'staff_meal', checks: 1, voided_checks: 0, total_minor: '90000' },
      { revenue_kind: 'marketing', checks: 0, voided_checks: 0, total_minor: '0' },
    ],
    items: [
      {
        order_id: randomUUID(),
        display_number: 7,
        revenue_kind: 'staff_meal',
        state: 'paid',
        total_minor: '90000',
        beneficiary: '=HYPERLINK("x")',
        reason: null,
        approval_manager_staff_id: '12345678-0000-4000-8000-000000000001',
        sold_at: '2026-11-19T10:00:00.000Z',
      },
    ],
  },
  refunds: [
    {
      source: 'pos',
      refund_id: randomUUID(),
      order_id: randomUUID(),
      display_number: 3,
      channel: 'hall_dine_in',
      revenue_kind: 'revenue',
      kind: 'refund',
      amount_minor: '50000',
      reason_code: 'quality',
      reason: '-Холодный "бургер"',
      staff_id: randomUUID(),
      approved_by_staff_id: 'abcdef01-0000-4000-8000-000000000002',
      approved_by_actor_id: null,
      approved_by_name: null,
      created_at: '2026-11-19T08:00:00.000Z',
      methods: [{ method: 'cash', amount_minor: '50000' }],
    },
    {
      source: 'cloud',
      refund_id: randomUUID(),
      order_id: 'fedcba98-0000-4000-8000-000000000003',
      display_number: null,
      channel: 'mobile',
      revenue_kind: 'revenue',
      kind: 'refund',
      amount_minor: '10000',
      reason_code: null,
      reason: 'Синтетический возврат',
      staff_id: null,
      approved_by_staff_id: null,
      approved_by_actor_id: randomUUID(),
      approved_by_name: 'Синтетический управляющий',
      created_at: '2026-11-19T09:00:00.000Z',
      methods: [{ method: 'online', amount_minor: '10000' }],
    },
  ],
  shifts: [],
  top_items: [],
  truncated: { refunds: false, no_revenue: false, shifts: false },
  limits: {},
  ...change,
});

test('parser: only a sales report of this branch with whole tiyn strings', () => {
  const r = salesReport(report(), branch);
  assert.equal(r.methods.length, 8);
  for (const bad of [
    report({ branch_id: randomUUID() }),
    report({ view: 'stock' }),
    report({ schema_version: 2 }),
    report({ coverage: { pos: 'yes', pos_received_at: null } }),
    report({ channels: {} }),
    report({ truncated: { refunds: false } }),
    report({ by_day: [{ day: '2026-11-19', sales_minor: 1 }] }),
    report({ by_day: [{ day: '2026-11-19', sales_minor: '1.5' }] }),
    [],
    null,
  ])
    assert.throws(() => salesReport(bad, branch), { message: 'INVALID_RESPONSE' });
});

test('money: spaces and tiyn on screen, decimal comma in CSV, negatives kept', () => {
  assert.equal(money('1690000'), '16 900 ₸');
  assert.equal(money('150050'), '1 500,50 ₸');
  assert.equal(money('-50'), '-0,50 ₸');
  assert.equal(money(0n), '0 ₸');
  assert.equal(csvTenge('1690000'), '16900,00');
  assert.equal(csvTenge('-50'), '-0,50');
  assert.equal(csvTenge('5'), '0,05');
  assert.throws(() => money('1,5'));
  assert.equal(almatyTime('2026-11-19T08:00:00.000Z'), '19.11.2026 13:00');
  assert.equal(almatyTime(null), '-');
});

test('CSV: every block, approvers, formula-safe free text, Excel quoting', () => {
  const r = salesReport(report(), branch);
  const rows = salesCsv(r);
  assert.deepEqual(rows[0], ['Отчёт продаж PickChick', '19.11.2026 - 19.11.2026', 'Asia/Almaty']);
  assert.deepEqual(rows[1], ['Касса', 'данные получены 19.11.2026 22:41']);
  const find = (first) => rows.find((row) => row[0] === first);
  assert.deepEqual(find('Выручка, ₸'), ['Выручка, ₸', '3000,50']);
  assert.deepEqual(find('Зал'), [
    'Зал',
    '2',
    '1',
    '4500,50',
    '1000,00',
    '500,00',
    '3000,50',
    '1750,25',
  ]);
  assert.deepEqual(find('Наличные'), [
    'Наличные',
    'да',
    '2',
    '4500,50',
    '1000,00',
    '500,00',
    '3000,50',
  ]);
  assert.deepEqual(find('Маркетинг'), ['Маркетинг', 'нет', '0', '0,00', '0,00', '0,00', '0,00']);
  assert.deepEqual(find('19.11.2026'), [
    '19.11.2026',
    '2',
    '4500,50',
    '1000,00',
    '500,00',
    '-0,50',
    '900,00',
  ]);
  assert.equal(rows.filter((row) => /^\d\d:00$/.test(row[0] ?? '')).length, 24);
  const staff = find('№7');
  assert.equal(staff[4], `'=HYPERLINK("x")`);
  assert.equal(staff[6], 'PIN начальника смены, сотрудник 12345678');
  const pos = rows.find((row) => row[2] === '№3');
  assert.deepEqual(pos, [
    '19.11.2026 13:00',
    'Зал',
    '№3',
    'Возврат',
    '500,00',
    'Качество блюда',
    `'-Холодный "бургер"`,
    'PIN начальника смены, сотрудник abcdef01',
    'Наличные 500,00',
  ]);
  const cloud = rows.find((row) => row[2] === 'fedcba98');
  assert.equal(cloud[7], 'Синтетический управляющий');
  assert.equal(cloud[8], 'Онлайн - приложение и киоск 100,00');
  assert.equal(approverLabel({}), '-');
  const text = salesCsvText(rows);
  assert.ok(text.startsWith('﻿"Отчёт продаж PickChick";"19.11.2026 - 19.11.2026"'));
  assert.ok(text.includes(`"'-Холодный ""бургер"""`));
  assert.ok(text.includes('\r\n'));
  assert.doesNotMatch(text, LONG_DASH);
  // Without cashier data the CSV says so instead of showing zero cashier sales.
  const cloudOnly = salesCsv(
    salesReport(report({ coverage: { pos: false, cloud: true, pos_received_at: null } }), branch),
  );
  assert.deepEqual(cloudOnly[1], ['Касса', 'данные не поступают']);
});
