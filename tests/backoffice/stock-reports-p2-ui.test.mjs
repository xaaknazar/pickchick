// Lane bo-ui2 step 4 stock reports in the cabinet (design-bo-ui §9.4): the gate, the allowlists of
// ops/stock?view=balances|reorder, the views as the page reads them, the honest banners, the
// reorder rule in words, the CSV files in tenge and the request prefilled from «К заказу». Pure
// functions of the built cabinet and the core, no PostgreSQL. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { allowedPath } from '../../apps/backoffice/dist/api.js';
import { allowed } from '../../apps/backoffice/server.mjs';
import {
  TURNOVER_KINDS,
  balanceRows,
  balanceState,
  balancesCsv,
  daysLeftText,
  defaultSelection,
  perDayText,
  reorderCsv,
  reorderRequest,
  reorderRuleText,
  rowReconciles,
  salesBanner,
  salesSince,
  stockBalancesView,
  stockReorderView,
  stockReportsAvailable,
  turnoverCsv,
  turnoverOf,
} from '../../apps/backoffice/dist/stock-reports-model.js';
import { requestPayload } from '../../apps/backoffice/dist/supply-model.js';
import {
  REORDER_MEAT_DAYS,
  REORDER_NEAR_PERCENT,
  REORDER_USE_DAYS,
  TURNOVER_KINDS as SERVER_KINDS,
  SupplyRequestPayloadSchema,
} from '../../packages/backoffice-core/dist/index.js';

const LONG_DASH = /[–—]/;
const branch = randomUUID();
const ids = { fillet: randomUUID(), bun: randomUUID(), box: randomUUID() };
const off = { mode: 'off', start_at: null, backlog: null, sales_included: false };
const on = {
  mode: 'on',
  start_at: '2026-11-19T05:00:00.000Z',
  backlog: { not_queued: 0, waiting: 0, since: null, stalled: false, stall_minutes: 5 },
  sales_included: true,
};
const balances = () => ({
  schema_version: 1,
  branch_id: branch,
  view: 'balances',
  timezone: 'Asia/Almaty',
  as_of: '2026-11-20T09:00:00.000Z',
  rows: [
    {
      ingredient_id: ids.fillet,
      name: 'Синтетическое филе',
      unit: 'g',
      active: true,
      group: 'raw',
      supply_kind: 'supplier',
      meat: true,
      quantity: '4400',
      value_minor: '990000',
      minimum: '1000',
      below_minimum: false,
      counted_at: null,
      last_movement_at: '2026-11-19T10:00:00.000Z',
      last_purchase: {
        quantity: '1000',
        value_minor: '230000',
        at: '2026-11-18T05:00:00.000Z',
        document_id: randomUUID(),
      },
      value_last_price_minor: '1012000',
      revision: 4,
    },
    {
      ingredient_id: ids.bun,
      name: 'Синтетическая булка',
      unit: 'pcs',
      active: true,
      group: null,
      supply_kind: null,
      meat: false,
      quantity: '0',
      value_minor: '0',
      minimum: '10',
      below_minimum: true,
      counted_at: '2026-11-20T08:00:00.000Z',
      last_movement_at: null,
      last_purchase: null,
      value_last_price_minor: null,
      revision: 1,
    },
    {
      ingredient_id: ids.box,
      name: 'Старая коробка',
      unit: 'pcs',
      active: false,
      group: null,
      supply_kind: null,
      meat: false,
      quantity: '3',
      value_minor: '300',
      minimum: '0',
      below_minimum: false,
      counted_at: null,
      last_movement_at: null,
      last_purchase: null,
      value_last_price_minor: null,
      revision: 1,
    },
  ],
  totals: {
    items: 3,
    active: 2,
    below_minimum: 1,
    value_minor: '990300',
    value_last_price_minor: '1012000',
    unpriced: 1,
  },
  counted_at_known: true,
  consumption: off,
  limits: { rows: 2000 },
  truncated: { rows: false },
});
const amount = (quantity, value_minor = '0') => ({ quantity, value_minor });
const turnoverRow = (over = {}) => ({
  ingredient_id: ids.fillet,
  name: 'Синтетическое филе',
  unit: 'g',
  opening: amount('6000', '1230000'),
  receipts: amount('0'),
  production_in: amount('0'),
  consumption: amount('-1000', '-205000'),
  waste: amount('-200', '-41000'),
  production_out: amount('-500', '-102500'),
  counts: amount('-100', '-20500'),
  reversals: amount('200', '41000'),
  transfers: amount('0'),
  in: amount('200', '41000'),
  out: amount('1800', '369000'),
  closing: amount('4400', '902000'),
  ...over,
});
const movement = (turnover) => ({
  schema_version: 1,
  branch_id: branch,
  view: 'movement',
  as_of: '2026-11-20T09:00:00.000Z',
  start_date: '2026-11-10',
  end_date: '2026-11-17',
  totals: { documents: 6, value_delta_minor: '-328000' },
  summary: { by_kind: [], by_day: [] },
  documents: [],
  truncated: false,
  ...(turnover ? { turnover, consumption: off } : {}),
});
const reorder = (rows) => ({
  schema_version: 1,
  branch_id: branch,
  view: 'reorder',
  timezone: 'Asia/Almaty',
  as_of: '2026-11-25T09:00:00.000Z',
  today: '2026-11-25',
  rule: { meat_days: 3, near_percent: 20, use_days: [7, 14] },
  periods: {
    d7: { days: 7, start_date: '2026-11-18', end_date: '2026-11-24' },
    d14: { days: 14, start_date: '2026-11-11', end_date: '2026-11-24' },
  },
  rows,
  totals: { rows: rows.length, below: 1, near: 1, hint_value_minor: '157200', unpriced: 0 },
  consumption: off,
  limits: { rows: 2000 },
  truncated: { rows: false },
});
const reorderRow = (over = {}) => ({
  ingredient_id: ids.fillet,
  name: 'Синтетическое филе',
  unit: 'g',
  group: 'raw',
  supply_kind: 'supplier',
  meat: true,
  balance: '5000',
  minimum: '2000',
  use: { d7: { quantity: '13500', days: 7 }, d14: { quantity: '20500', days: 14 } },
  rate: { quantity: '13500', days: 7 },
  days_left: '2',
  target: '5786',
  target_rule: 'meat_days',
  hint: '786',
  state: 'below',
  last_purchase: null,
  hint_value_minor: '157200',
  ...over,
});

test('the gate is capabilities.stock_reports, nothing else', () => {
  assert.equal(stockReportsAvailable(null), false);
  assert.equal(stockReportsAvailable({ capabilities: {} }), false);
  assert.equal(stockReportsAvailable({ capabilities: { stock_reports: false } }), false);
  assert.equal(stockReportsAvailable({ capabilities: { stock_reports: 'true' } }), false);
  assert.equal(stockReportsAvailable({ capabilities: { stock_reports: true } }), true);
});

test('allowlists: view=balances and view=reorder alone, the dated views as before', async () => {
  const views = {
    'view=balances': true,
    'view=reorder': true,
    'view=balances&view=balances': false,
    'view=balances&date=2026-11-20': false,
    'view=reorder&days=7': false,
    'view=turnover': false,
    'view=movement': false,
    'view=movement&start_date=2026-11-13&end_date=2026-11-19': true,
    'view=balances&start_date=2026-11-13&end_date=2026-11-19': false,
  };
  for (const [q, ok] of Object.entries(views)) {
    assert.equal(allowedPath(`operations/branches/${branch}/ops/stock?${q}`), ok, 'cabinet ' + q);
    assert.equal(
      allowed('GET', `/v1/admin/backoffice/branches/${branch}/ops/stock?${q}`),
      ok,
      'proxy ' + q,
    );
  }
  const server = await readFile(
    new URL('../../apps/backoffice/server.mjs', import.meta.url),
    'utf8',
  );
  assert.ok(server.includes("'stock-reports-model'"));
  // The gateway already passes ops/stock (the query is checked by the proxy and the API).
  const caddy = await readFile(
    new URL('../../infra/public-staging/gateway.Caddyfile', import.meta.url),
    'utf8',
  );
  assert.match(caddy, /\/ops\/\(stock\|/);
});

test('views: checked for the view asked for; an old movement answer has no turnover', () => {
  assert.equal(stockBalancesView(balances(), branch).rows.length, 3);
  assert.throws(
    () => stockBalancesView({ ...balances(), view: 'reorder' }, branch),
    /INVALID_RESPONSE/,
  );
  assert.throws(() => stockBalancesView(balances(), randomUUID()), /INVALID_RESPONSE/);
  assert.throws(
    () =>
      stockBalancesView({ ...balances(), rows: [{ ...balances().rows[0], quantity: 4 }] }, branch),
    /INVALID_RESPONSE/,
  );
  assert.throws(
    () => stockBalancesView({ ...balances(), consumption: { mode: 'maybe' } }, branch),
    /INVALID_RESPONSE/,
  );
  assert.equal(stockReorderView(reorder([reorderRow()]), branch).rows.length, 1);
  assert.throws(
    () => stockReorderView(reorder([reorderRow({ state: 'fine' })]), branch),
    /INVALID_RESPONSE/,
  );
  // A bo-ui server: no turnover, nothing to show.
  assert.equal(turnoverOf(movement(null)), null);
  const t = { rows: [turnoverRow()], totals: {}, mismatches: [], truncated: { rows: false } };
  assert.equal(turnoverOf(movement(t)).turnover.rows.length, 1);
  assert.throws(
    () => turnoverOf(movement({ ...t, rows: [turnoverRow({ closing: { quantity: 1 } })] })),
    /INVALID_RESPONSE/,
  );
  // The kinds of the cabinet are the server's, in its order.
  assert.deepEqual([...TURNOVER_KINDS], [...SERVER_KINDS]);
});

test('banners: sales not in the numbers while off, in dry_run or late; quiet when on', () => {
  assert.match(salesBanner(off, on.start_at), /^Продажи не списываются со склада автоматически/);
  assert.match(salesBanner({ ...off, mode: 'unavailable' }, on.start_at), /без продаж/);
  assert.match(
    salesBanner({ ...off, mode: 'dry_run', start_at: on.start_at }, on.start_at),
    /режиме проверки.*без продаж/,
  );
  assert.equal(salesBanner(on, on.start_at), null);
  assert.equal(salesSince(on), 'Продажи списываются со склада автоматически с 19.11.2026 10:00.');
  assert.equal(salesSince(off), null);
  const late = {
    ...on,
    sales_included: false,
    backlog: {
      not_queued: 2,
      waiting: 1,
      since: '2026-11-20T08:05:00.000Z',
      stalled: true,
      stall_minutes: 5,
    },
  };
  const text = salesBanner(late, '2026-11-20T09:00:00.000Z');
  assert.match(text, /^Списание по продажам не работает: 3 продажи не обработаны с 13:05\./);
  assert.match(text, /без этих продаж\.$/);
  for (const t of [salesBanner(off, ''), text, salesSince(on)]) assert.doesNotMatch(t, LONG_DASH);
});

test('balances: the filter, the state in words and the CSV in tenge', () => {
  const v = stockBalancesView(balances(), branch);
  assert.deepEqual(
    balanceRows(v, '', 'active').map((r) => r.name),
    ['Синтетическое филе', 'Синтетическая булка'],
  );
  assert.deepEqual(
    balanceRows(v, '', 'low').map((r) => r.ingredient_id),
    [ids.bun],
  );
  assert.deepEqual(
    balanceRows(v, '', 'zero').map((r) => r.ingredient_id),
    [ids.bun],
  );
  assert.deepEqual(
    balanceRows(v, '', 'inactive').map((r) => r.ingredient_id),
    [ids.box],
  );
  assert.deepEqual(
    balanceRows(v, 'ФИЛЕ', 'all').map((r) => r.ingredient_id),
    [ids.fillet],
  );
  assert.deepEqual(v.rows.map(balanceState), ['В наличии', 'Нет запаса', 'Не используется']);
  const csv = balancesCsv(v.rows, v.as_of);
  assert.deepEqual(csv[0], ['Остатки на', '20.11.2026 14:00']);
  assert.ok(csv[1].includes('Сумма, ₸'));
  assert.ok(csv[1].includes('По последней цене закупки, ₸'));
  assert.deepEqual(csv[2], [
    'Синтетическое филе',
    '4,4',
    'кг',
    '1',
    'В наличии',
    '',
    '19.11.2026 15:00',
    '9900,00',
    '10120,00',
  ]);
  // Without a purchase the price column stays empty, not zero.
  assert.equal(csv[3].at(-1), '');
  assert.equal(csv[3][7], '0,00');
});

test('movement: opening + in - out = closing per row, the CSV with «Сумма, ₸» for every column', () => {
  const row = turnoverRow();
  assert.equal(rowReconciles(row), true);
  assert.equal(rowReconciles(turnoverRow({ closing: amount('4300', '902000') })), false);
  const totals = Object.fromEntries(
    ['opening', ...TURNOVER_KINDS, 'in', 'out', 'closing'].map((k) => [
      k,
      { value_minor: row[k].value_minor },
    ]),
  );
  const csv = turnoverCsv(
    { rows: [row], totals, mismatches: [], truncated: { rows: false } },
    { start_date: '2026-11-10', end_date: '2026-11-17' },
  );
  assert.deepEqual(csv[0], ['Движение по позициям за период', '10.11.2026 - 17.11.2026']);
  assert.equal(csv[1][2], 'На начало');
  assert.equal(csv[1][3], 'На начало: Сумма, ₸');
  assert.equal(csv[1].at(-1), 'На конец: Сумма, ₸');
  assert.deepEqual(csv[2].slice(0, 4), ['Синтетическое филе', 'кг', '6', '12300,00']);
  assert.deepEqual(csv[2].slice(-2), ['4,4', '9020,00']);
  assert.equal(csv.at(-1)[0], 'Итого');
  assert.equal(csv.at(-1).at(-1), '9020,00');
  for (const line of csv) for (const cell of line) assert.doesNotMatch(cell, LONG_DASH);
});

test('reorder: the rule in words is the server rule, per day and days left in words', () => {
  assert.equal(REORDER_MEAT_DAYS, 3);
  assert.equal(REORDER_NEAR_PERCENT, 20);
  assert.deepEqual([...REORDER_USE_DAYS], [7, 14]);
  const v = stockReorderView(reorder([reorderRow()]), branch);
  const rule = reorderRuleText(v);
  assert.match(rule, /цель - минимальный запас позиции/);
  assert.match(
    rule,
    /«Мясо» цель - 3 дня среднего расхода \(берётся больший из средних за 7 и 14 дней\), но не меньше минимума/,
  );
  assert.match(rule, /Заказать = цель минус остаток/);
  assert.match(rule, /не больше цели плюс 20 %/);
  assert.match(rule, /последние 7 полных дней и 14 полных дней/);
  assert.match(rule, /сегодняшний день, списания и инвентаризации не входят/);
  assert.doesNotMatch(rule, LONG_DASH);
  // A fresh start of the write-off shortens the periods, and the text says so.
  const fresh = reorderRuleText({
    ...v,
    periods: {
      d7: { days: 4, start_date: '2026-11-21', end_date: '2026-11-24' },
      d14: { days: 0, start_date: null, end_date: '2026-11-24' },
    },
  });
  assert.match(fresh, /7 дней \(с 21\.11\.2026: 4 полных дня с начала списания по продажам\)/);
  assert.match(fresh, /14 дней \(полных дней с начала списания по продажам ещё нет\)/);
  assert.equal(perDayText({ quantity: '13500', days: 7 }, 'g'), '1,929 кг в день');
  assert.equal(perDayText({ quantity: '20', days: 7 }, 'pcs'), '2,9 шт в день');
  assert.equal(perDayText({ quantity: '14', days: 7 }, 'pcs'), '2 шт в день');
  assert.equal(perDayText({ quantity: '0', days: 7 }, 'pcs'), 'нет расхода');
  assert.equal(perDayText({ quantity: '5', days: 0 }, 'pcs'), 'нет полных дней');
  assert.deepEqual(['0', '1', '2', '5', '11', '21', '22', null].map(daysLeftText), [
    'меньше дня',
    '1 день',
    '2 дня',
    '5 дней',
    '11 дней',
    '21 день',
    '22 дня',
    '-',
  ]);
  const csv = reorderCsv(v);
  assert.ok(csv[1].includes('Сумма, ₸'));
  assert.deepEqual(csv[2].slice(0, 4), ['Синтетическое филе', 'кг', 'Поставщик', 'да']);
  assert.equal(csv[2].at(-1), '1572,00');
  assert.equal(csv[2][12], '3 дня расхода');
});

test('«Создать заявку»: below-target rows first, one kind, the hints as lines the server takes', () => {
  const v = stockReorderView(
    reorder([
      reorderRow(),
      reorderRow({
        ingredient_id: ids.bun,
        name: 'Синтетическая булка',
        unit: 'pcs',
        meat: false,
        supply_kind: 'supplier',
        balance: '12',
        minimum: '10',
        target: '10',
        target_rule: 'minimum',
        hint: '0',
        state: 'near',
        hint_value_minor: '0',
      }),
    ]),
    branch,
  );
  const selected = defaultSelection(v);
  assert.deepEqual([...selected], [ids.fillet]);
  let out = reorderRequest(v, selected, '2026-11-25');
  assert.equal(out.mixed, false);
  assert.equal(out.form.kind, 'supplier');
  assert.equal(out.form.needed_by, '2026-11-26');
  assert.deepEqual(out.form.lines, [{ ingredient_id: ids.fillet, quantity: '786', unit: 'g' }]);
  // The editor turns it into the payload the server's strict schema takes.
  const stock = [
    {
      id: ids.fillet,
      quantity: '5000',
      payload: { name: 'Синтетическое филе', unit: 'g', minimum: '2000', active: true },
    },
    {
      id: ids.bun,
      quantity: '12',
      payload: { name: 'Синтетическая булка', unit: 'pcs', minimum: '10', active: true },
    },
  ];
  const payload = requestPayload(out.form, stock, '2026-11-25');
  assert.deepEqual(payload.errors, []);
  assert.equal(SupplyRequestPayloadSchema.safeParse(payload.payload).success, true);
  assert.deepEqual(payload.payload.lines, [{ ingredient_id: ids.fillet, qty: '786' }]);
  // A row near its minimum joins with an empty quantity, to fill in; kinds that differ are said.
  selected.add(ids.bun);
  out = reorderRequest(v, selected, '2026-11-25');
  assert.deepEqual(out.form.lines[1], { ingredient_id: ids.bun, quantity: '', unit: 'pcs' });
  const mixed = reorderRequest(
    { ...v, rows: v.rows.map((r, i) => (i ? { ...r, supply_kind: 'bakery' } : r)) },
    selected,
    '2026-11-25',
  );
  assert.equal(mixed.mixed, true);
  assert.equal(mixed.form.kind, 'supplier');
  // Without «Откуда» on the cards the request goes to a supplier, changeable in the editor.
  const plain = reorderRequest(
    { ...v, rows: v.rows.map((r) => ({ ...r, supply_kind: null })) },
    new Set([ids.fillet]),
    '2026-11-25',
  );
  assert.equal(plain.form.kind, 'supplier');
  assert.equal(plain.mixed, false);
  // Large hints in grams become kg in the editor, as the editor shows them.
  const big = reorderRequest(
    { ...v, rows: [reorderRow({ hint: '12500' })] },
    new Set([ids.fillet]),
    '2026-11-25',
  );
  assert.deepEqual(big.form.lines, [{ ingredient_id: ids.fillet, quantity: '12,5', unit: 'kg' }]);
});
