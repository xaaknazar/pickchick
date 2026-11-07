import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { allowedPath } from '../../apps/backoffice/dist/api.js';
import { posDayAvailable } from '../../apps/backoffice/dist/operations-model.js';
import {
  CONFIRMATION_LABELS,
  FISCAL_STATE_LABELS,
  POS_DAY_CHANNELS,
  POS_DAY_METHODS,
  POS_DAY_RULES,
  SHIFT_STATE_LABELS,
  filterReceipts,
  posDay,
  receiptName,
  receiptsCsv,
  staffLabel,
  terminalLabel,
  waitingText,
  webkassaCsv,
  webkassaRows,
  webkassaText,
  zCsv,
  methodLineText,
  methodLines,
  shiftKeyLine,
} from '../../apps/backoffice/dist/pos-day-model.js';
import { freshnessText } from '../../apps/backoffice/dist/pos-day.js';
import { salesCsvText } from '../../apps/backoffice/dist/sales-report-model.js';
import { allowed } from '../../apps/backoffice/server.mjs';
import {
  POS_DAY_CHANNELS as SERVER_CHANNELS,
  SALES_REPORT_METHODS,
} from '../../packages/backoffice-core/dist/index.js';
import * as contracts from '../../packages/contracts/dist/index.js';

/**
 * Lane bo-ui «Касса» in the cabinet: allowlists (cabinet, operator proxy, public gateway), the
 * parser, the names, the receipt filters and the three CSV exports. Synthetic data only.
 */
const branch = randomUUID();
const LONG_DASH = /[–—]/;
const desk = { one: randomUUID(), two: randomUUID() };
const staff = { cashier: randomUUID(), stranger: randomUUID() };

test('allowlists: ops/pos-day takes one date and an optional cash desk, nothing else', async () => {
  const cabinet = (q) => allowedPath(`operations/branches/${branch}/ops/pos-day?${q}`);
  const proxy = (q) => allowed('GET', `/v1/admin/backoffice/branches/${branch}/ops/pos-day?${q}`);
  for (const check of [cabinet, proxy]) {
    assert.equal(check('date=2026-11-19'), true);
    assert.equal(check(`date=2026-11-19&terminal_id=${desk.one}`), true);
    assert.equal(check(`terminal_id=${desk.one}&date=2026-11-19`), true);
    for (const q of [
      '',
      'date=19.11.2026',
      'date=2026-11-19&date=2026-11-20',
      'date=2026-11-19&terminal_id=desk-1',
      `date=2026-11-19&terminal_id=${desk.one}&terminal_id=${desk.two}`,
      'date=2026-11-19&start_date=2026-11-19',
      'date=2026-11-19&format=csv',
    ])
      assert.equal(check(q), false, q);
  }
  assert.equal(allowed('POST', `/v1/admin/backoffice/branches/${branch}/ops/pos-day`), false);
  assert.equal(allowed('GET', `/v1/admin/backoffice/branches/${branch}/ops/pos-day`), false);
  assert.equal(allowedPath(`operations/branches/${branch}/ops/pos-day`), false);
  // The routes of the cloud lane are unchanged.
  assert.equal(
    allowed(
      'GET',
      `/v1/admin/backoffice/branches/${branch}/ops/sales?start_date=2026-11-19&end_date=2026-11-19`,
    ),
    true,
  );
  // Step 5 adds ops/consumption and ops/menu-links (autoconsume-ui.test.mjs), step 6
  // ops/manager-shifts and ops/staff-roster (manager-shift-ui.test.mjs); others stay out.
  assert.equal(
    allowed('GET', `/v1/admin/backoffice/branches/${branch}/ops/consumption?date=2026-11-19`),
    true,
  );
  assert.equal(
    allowed('GET', `/v1/admin/backoffice/branches/${branch}/ops/manager-shifts?date=2026-11-19`),
    true,
  );
  // Step 7 adds ops/discounts (discounts-ui.test.mjs); others stay out.
  assert.equal(allowed('GET', `/v1/admin/backoffice/branches/${branch}/ops/discounts`), true);
  assert.equal(allowed('GET', `/v1/admin/backoffice/branches/${branch}/ops/vouchers`), false);
  // The public gateway regex lets the view through and nothing new besides it.
  const caddy = await readFile(
    new URL('../../infra/public-staging/gateway.Caddyfile', import.meta.url),
    'utf8',
  );
  const regex = new RegExp(/path_regexp backoffice_get (\S+)/.exec(caddy)[1]);
  const base = `/v1/admin/backoffice/branches/${branch}`;
  for (const path of [
    base,
    `${base}/ops/pos-day`,
    `${base}/ops/sales`,
    `${base}/ops/stock`,
    `${base}/ops/menu-links`,
    `${base}/ops/consumption`,
    `${base}/ops/manager-shifts`,
    `${base}/ops/staff-roster`,
    `${base}/ops/discounts`,
    // Review: the order registry on the server (audit F10, orders-registry-ui.test.mjs).
    `${base}/ops/orders`,
    `${base}/finance`,
  ])
    assert.equal(regex.test(path), true, path);
  for (const path of [
    `${base}/ops/vouchers`,
    `${base}/ops/discounts/x`,
    `${base}/ops/pos-day/x`,
    `${base}/ops/consumption/x`,
    `${base}/ops/orders/x`,
    `${base}/ops/`,
  ])
    assert.equal(regex.test(path), false, path);
});

test('capability: only pos_day=true shows «Касса»', () => {
  assert.equal(posDayAvailable({ capabilities: { pos_day: true } }), true);
  for (const capabilities of [{}, { pos_day: 'true' }, { sales_report: true }, { pos_day: false }])
    assert.equal(posDayAvailable({ capabilities }), false);
  assert.equal(posDayAvailable(null), false);
});

test('names: every server code is named in Russian with the plain hyphen', async () => {
  assert.deepEqual([...POS_DAY_METHODS], [...SALES_REPORT_METHODS]);
  assert.deepEqual([...POS_DAY_CHANNELS], [...SERVER_CHANNELS]);
  assert.deepEqual(
    Object.keys(CONFIRMATION_LABELS),
    contracts.PosPaymentConfirmationSchema.options,
  );
  assert.deepEqual(Object.keys(FISCAL_STATE_LABELS), ['pending', 'recorded', 'not_required']);
  assert.deepEqual(Object.keys(SHIFT_STATE_LABELS), ['open', 'closed', 'unknown']);
  for (const text of [...POS_DAY_RULES, ...Object.values(CONFIRMATION_LABELS)])
    assert.doesNotMatch(text, LONG_DASH, text);
  // operations.ts and app.ts keep older texts with long dashes (audit F19, step 7, owner question).
  for (const file of ['pos-day.ts', 'pos-day-model.ts'])
    assert.doesNotMatch(
      await readFile(new URL(`../../apps/backoffice/src/${file}`, import.meta.url), 'utf8'),
      LONG_DASH,
      file,
    );
});

const receipt = (state, number = null, extra = {}) => ({
  receipt_id: randomUUID(),
  kind: 'sale',
  refund_id: null,
  state,
  receipt_number: number,
  version: number ? 2 : 1,
  amount_minor: '250000',
  recorded_by_staff_id: number ? staff.cashier : null,
  recorded_at: number ? '2026-11-19T05:10:00.000Z' : null,
  in_day: true,
  ...extra,
});
const sale = (n, terminal, change = {}) => ({
  order_id: randomUUID(),
  display_number: n,
  terminal_id: terminal,
  shift_id: randomUUID(),
  device_id: randomUUID(),
  cashier_staff_id: staff.cashier,
  sold_at: '2026-11-19T05:00:00.000Z',
  business_date: '2026-11-19',
  of_day: true,
  sales_channel: 'hall',
  service_mode: 'dine_in',
  channel: 'hall_dine_in',
  revenue_kind: 'revenue',
  external_order_ref: null,
  subtotal_minor: '250000',
  discount_minor: '0',
  total_minor: '250000',
  cash_tendered_minor: '300000',
  change_minor: '50000',
  state: 'paid',
  voided_at: null,
  beneficiary: null,
  reason: null,
  approval_manager_staff_id: null,
  lines: [
    {
      name: 'Синтетический бургер',
      quantity: 1,
      unit_price_minor: '250000',
      total_minor: '250000',
      modifiers: [],
    },
  ],
  tenders: [
    {
      tender_id: randomUUID(),
      method: 'cash',
      amount_minor: '250000',
      confirmation: 'drawer',
      reference: null,
    },
  ],
  refunds: [],
  refunded_minor: '0',
  fiscal: [receipt('recorded', 'SYN-0001')],
  ...change,
});
const day = (change = {}) => ({
  schema_version: 1,
  branch_id: branch,
  view: 'pos-day',
  date: '2026-11-19',
  terminal_id: null,
  timezone: 'Asia/Almaty',
  day_start: '2026-11-18T19:00:00.000Z',
  day_end: '2026-11-19T19:00:00.000Z',
  as_of: '2026-11-19T18:41:00.000Z',
  coverage: {
    pos_tables: true,
    cashier_reports: true,
    last_received_at: '2026-11-19T18:41:00.000Z',
    cashier_reports_at: null,
  },
  terminals: [
    { terminal_id: desk.one, label: 'Касса 1', first_seen_at: null },
    { terminal_id: desk.two, label: 'Касса 2', first_seen_at: null },
  ],
  shifts: [
    {
      shift_id: randomUUID(),
      terminal_id: desk.one,
      state: 'closed',
      source: 'z',
      opened_at: '2026-11-19T04:00:00.000Z',
      closed_at: '2026-11-19T19:30:00.000Z',
      cash: {
        opening_cash_minor: '1000000',
        cash_in_minor: '0',
        cash_out_minor: '0',
        cash_sales_minor: '250000',
        cash_refunds_minor: '0',
        expected_cash_minor: '1250000',
        counted_cash_minor: '1245000',
        discrepancy_minor: '-5000',
      },
      terminal: { expected_minor: '0', reported_minor: '0', discrepancy_minor: '0' },
      received: {
        sales_count: 1,
        voided_count: 0,
        sales_minor: '250000',
        refunds_minor: '0',
        methods: SALES_REPORT_METHODS.map((method) => ({
          method,
          count: method === 'cash' ? 1 : 0,
          sales_minor: method === 'cash' ? '250000' : '0',
          refunds_minor: '0',
        })),
      },
      fiscal: { pending: 1, recorded: 1, not_required: 0 },
      flags: { cash_discrepancy: true, terminal_discrepancy: false, fiscal_pending: 1 },
    },
  ],
  totals: null,
  channels: [],
  methods: [],
  sales: [
    sale(12, desk.two, {
      sold_at: '2026-11-19T18:01:00.000Z',
      sales_channel: 'yandex_eda',
      service_mode: 'takeaway',
      channel: 'yandex_eda',
      external_order_ref: 'YA-123456',
      cashier_staff_id: staff.stranger,
      cash_tendered_minor: null,
      change_minor: null,
      tenders: [
        {
          tender_id: randomUUID(),
          method: 'aggregator_yandex_eda',
          amount_minor: '250000',
          confirmation: 'aggregator_attested',
          reference: null,
        },
      ],
      fiscal: [receipt('not_required')],
    }),
    sale(12, desk.one, {
      sold_at: '2026-11-19T17:30:00.000Z',
      fiscal: [receipt('pending')],
    }),
    sale(3, desk.one, {
      state: 'voided',
      voided_at: '2026-11-19T06:00:00.000Z',
      refunded_minor: '250000',
      refunds: [
        {
          refund_id: randomUUID(),
          kind: 'void',
          amount_minor: '250000',
          reason_code: 'cashier_error',
          reason: 'Не тот заказ',
          staff_id: staff.cashier,
          approved_by_staff_id: staff.cashier,
          shift_id: randomUUID(),
          terminal_id: desk.one,
          created_at: '2026-11-19T06:00:00.000Z',
          in_day: true,
          tenders: [],
        },
      ],
    }),
    sale(9, desk.one, {
      of_day: false,
      business_date: '2026-11-18',
      sold_at: '2026-11-18T18:30:00.000Z',
      refunded_minor: '100000',
      fiscal: [
        receipt('recorded', 'SYN-0009', { in_day: false }),
        receipt('pending', null, { kind: 'refund', refund_id: 'r9', amount_minor: '100000' }),
      ],
      refunds: [
        {
          refund_id: 'r9',
          kind: 'refund',
          amount_minor: '100000',
          reason_code: 'quality',
          reason: 'Холодный',
          staff_id: staff.cashier,
          approved_by_staff_id: staff.cashier,
          shift_id: randomUUID(),
          terminal_id: desk.one,
          created_at: '2026-11-19T04:30:00.000Z',
          in_day: true,
          tenders: [],
        },
      ],
    }),
  ],
  fiscal_summary: null,
  staff: {
    [staff.cashier]: { name: 'Синтетический кассир', employee_id: randomUUID(), role: 'cashier' },
  },
  limits: { sales: 2000, earlier_sales: 200 },
  truncated: { sales: false, earlier_sales: false },
  ...change,
});

test('parser: a foreign or half answer is refused, a full one passes', () => {
  assert.equal(posDay(day(), branch).sales.length, 4);
  for (const bad of [
    { branch_id: randomUUID() },
    { view: 'sales' },
    { coverage: { pos_tables: 'yes', cashier_reports: true } },
    { truncated: { sales: false } },
    { sales: [{ ...sale(1, desk.one), total_minor: 2500 }] },
    { sales: [{ ...sale(1, desk.one), tenders: null }] },
    { staff: [] },
  ])
    assert.throws(
      () => posDay(day(bad), branch),
      /INVALID_RESPONSE/,
      JSON.stringify(Object.keys(bad)),
    );
});

test('names of desks and staff, Webkassa column, waiting time, freshness', () => {
  const d = posDay(day(), branch);
  assert.equal(terminalLabel(d, desk.two), 'Касса 2');
  assert.equal(terminalLabel(d, '9f3a0000-0000-4000-8000-000000000000'), 'Касса 9f3a');
  assert.equal(staffLabel(d, staff.cashier), 'Синтетический кассир');
  assert.equal(
    staffLabel(d, staff.stranger),
    `Сотрудник ${staff.stranger.slice(0, 8)} (нет карточки)`,
  );
  // Two receipts №12 on two desks are told apart.
  assert.deepEqual(
    d.sales.filter((s) => s.display_number === 12).map((s) => receiptName(d, s)),
    ['№12 · Касса 2', '№12 · Касса 1'],
  );
  assert.deepEqual(
    d.sales.map((s) => webkassaText(s)),
    ['не нужен', 'не оформлен', 'SYN-0001', 'SYN-0009'],
  );
  assert.equal(waitingText(5), '5 мин');
  assert.equal(waitingText(125), '2 ч 05 мин');
  assert.equal(waitingText(null), '-');
  assert.equal(freshnessText(d), 'Данные кассы получены в 23:41');
  assert.equal(
    freshnessText({
      ...d,
      coverage: { ...d.coverage, last_received_at: '2026-11-18T10:00:00.000Z' },
    }),
    'Данные кассы получены 18.11.2026 15:00',
  );
  assert.match(
    freshnessText({ ...d, coverage: { ...d.coverage, pos_tables: false } }),
    /^Облако ещё не получает продажи кассы/,
  );
  assert.equal(
    freshnessText({ ...d, coverage: { ...d.coverage, last_received_at: null } }),
    'Данные кассы в облако ещё не поступали.',
  );
});

test('receipt search and filters: order, aggregator and Webkassa numbers; method, channel, state', () => {
  const d = posDay(day(), branch);
  const f = (change) =>
    filterReceipts(d.sales, { query: '', method: '', channel: '', state: '', ...change });
  const numbers = (rows) => rows.map((s) => s.display_number);
  assert.deepEqual(numbers(f({ query: '12' })), [12, 12]);
  assert.deepEqual(numbers(f({ query: '№ 3' })), [3]);
  assert.deepEqual(numbers(f({ query: 'ya-1234' })), [12]);
  assert.deepEqual(numbers(f({ query: 'SYN-0009' })), [9]);
  assert.deepEqual(numbers(f({ query: '1' })), [], 'one digit matches exact numbers only');
  assert.deepEqual(numbers(f({ method: 'aggregator_yandex_eda' })), [12]);
  assert.deepEqual(numbers(f({ channel: 'hall_dine_in' })), [12, 3, 9]);
  assert.deepEqual(numbers(f({ state: 'voided' })), [3]);
  assert.deepEqual(numbers(f({ state: 'paid' })), [12, 12, 9]);
  assert.deepEqual(numbers(f({ state: 'refunded' })), [9]);
  assert.deepEqual(numbers(f({ state: 'fiscal_pending' })), [12, 9]);
  assert.deepEqual(numbers(f({ state: 'no_revenue' })), []);
});

test('Webkassa list: unrecorded first, longest wait first; recorded; not required last', () => {
  const d = posDay(day(), branch);
  const rows = webkassaRows(d);
  assert.deepEqual(
    rows.map((r) => [r.receipt.state, r.receipt.kind, r.sale.display_number, r.waiting_minutes]),
    [
      ['pending', 'refund', 9, 851],
      ['pending', 'sale', 12, 71],
      ['recorded', 'sale', 3, null],
      ['not_required', 'sale', 12, null],
    ],
  );
  // The 18.11 sale receipt of №9 is not of this day.
  assert.equal(
    rows.some((r) => r.receipt.receipt_number === 'SYN-0009'),
    false,
  );
});

test('three CSV exports: tenge with a comma, «Сумма, ₸», dates DD.MM.YYYY, no formulas', () => {
  const d = posDay(day(), branch);
  const receipts = receiptsCsv(d);
  assert.deepEqual(receipts[0], ['Чеки кассы PickChick', '19.11.2026', 'Asia/Almaty']);
  assert.deepEqual(receipts[1], ['Касса', 'все кассы', 'данные получены 19.11.2026 23:41']);
  const head = receipts[3];
  assert.equal(head[0], 'Дата и время');
  assert.ok(head.includes('Сумма, ₸'));
  const yandex = receipts[4];
  assert.deepEqual(
    [yandex[0], yandex[1], yandex[2], yandex[4], yandex[5], yandex[7], yandex[8], yandex[13]],
    [
      '19.11.2026 23:01',
      '12',
      'Касса 2',
      'Яндекс Еда',
      'YA-123456',
      '2500,00',
      'Яндекс Еда - оплачено агрегатором 2500,00',
      'не нужен',
    ],
  );
  const cash = receipts[5];
  assert.deepEqual([cash[9], cash[10], cash[11]], ['3000,00', '500,00', 'Оплачен']);
  assert.deepEqual([receipts[4][9], receipts[5][2]], ['', 'Касса 1']);
  assert.equal(receipts[6][11], 'Отменён');
  assert.equal(receipts[7][15], 'нет, чек 18.11.2026');
  const z = zCsv(d);
  assert.equal(z[3][0], 'Касса');
  assert.ok(z[3].includes('Расхождение, ₸'));
  assert.ok(z[3].includes('Kaspi вручную: продажи, ₸'));
  assert.deepEqual(
    [z[4][0], z[4][2], z[4][3], z[4][12], z[4][16]],
    ['Касса 1', 'Закрыта', '19.11.2026 09:00', '-50,00', '1'],
  );
  const wk = webkassaCsv(d);
  assert.deepEqual(wk[3], [
    'Номер чека',
    'Вид',
    'Сумма, ₸',
    'Номер заказа',
    'Касса',
    'Время операции',
    'Состояние',
    'Внёс',
    'Когда внесён',
  ]);
  assert.deepEqual(wk[4], [
    '',
    'Возврат',
    '1000,00',
    '9',
    'Касса 1',
    '19.11.2026 09:30',
    'Не оформлен',
    '',
    '',
  ]);
  assert.deepEqual(wk[6], [
    'SYN-0001',
    'Продажа',
    '2500,00',
    '3',
    'Касса 1',
    '19.11.2026 10:00',
    'Оформлен',
    'Синтетический кассир',
    '19.11.2026 10:10',
  ]);
  // A name or reason typed by a person never becomes a spreadsheet formula.
  const evil = posDay(
    day({
      sales: [sale(5, desk.one, { revenue_kind: 'staff_meal', beneficiary: '=HYPERLINK("x")' })],
    }),
    branch,
  );
  assert.equal(receiptsCsv(evil)[4][14], '\'=HYPERLINK("x")');
  const text = salesCsvText(receipts);
  assert.ok(text.startsWith('﻿'));
  assert.doesNotMatch(text, LONG_DASH);
});

test('phone shift card (review BOUI-R6): one line per paid method, the discrepancies first', () => {
  const methods = [
    { method: 'cash', count: 5, sales_minor: '700000', refunds_minor: '700000' },
    { method: 'kaspi_terminal', count: 1, sales_minor: '117000', refunds_minor: '0' },
    { method: 'kaspi_qr', count: 0, sales_minor: '0', refunds_minor: '0' },
    { method: 'glovo_prepaid', count: 0, sales_minor: '0', refunds_minor: '0' },
  ];
  const short = methodLines(methods);
  assert.deepEqual(short.lines.map(methodLineText), [
    'Наличные: 5 оплат, 7 000 ₸, возвраты 7 000 ₸, итого 0 ₸',
    'Kaspi терминал: 1 оплата, 1 170 ₸',
  ]);
  assert.match(short.idle, /^Без оплат: .+, .+\.$/);
  assert.equal(methodLines(methods.slice(2)).lines.length, 0);
  assert.equal(methodLines(methods.slice(0, 2)).idle, null);
  assert.equal(
    shiftKeyLine({ discrepancy_minor: '-50000' }, { discrepancy_minor: '0' }),
    'Наличные: расхождение -500 ₸ · Kaspi терминал: разница 0 ₸',
  );
  // Not sent by the cash desk: said so, never a made-up zero; no cash block, no cash part.
  assert.equal(
    shiftKeyLine(null, { discrepancy_minor: null }),
    'Kaspi терминал: разница не известна',
  );
  for (const t of [...short.lines.map(methodLineText), short.idle]) assert.doesNotMatch(t, /[—–]/);
});
