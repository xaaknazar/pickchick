import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANY, cashDay, computePnl, percent, shareByWeight } from '../dist/expenses-report.js';
import { EXPENSE_CATEGORIES, EXPENSE_GROUPS, enterable } from '../dist/expenses-catalog.js';

const A = 'aaaaaaaa-0000-4000-8000-000000000001',
  B = 'bbbbbbbb-0000-4000-8000-000000000002';
const opts = (o = {}) => ({
  columns: 'locations',
  cogs: 'payments',
  allocate: false,
  locations: [A, B],
  months: ['2026-11'],
  ...o,
});
const e = (location, category, amount, month = '2026-11') => ({
  location,
  month,
  category,
  amount_minor: BigInt(amount),
});
const r = (location, type, amount, month = '2026-11') => ({
  location,
  month,
  type,
  amount_minor: BigInt(amount),
});
const line = (report, key) => report.lines.find((l) => l.key === key).values;

test('the catalog has one place for every article and money movement stays out of the P&L', () => {
  const codes = EXPENSE_CATEGORIES.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const c of EXPENSE_CATEGORIES) assert.ok(EXPENSE_GROUPS.some((g) => g.code === c.group));
  assert.equal(enterable('rev_cash'), false);
  assert.equal(enterable('rev_manual'), true);
  assert.equal(enterable('nope'), false);
  assert.equal(EXPENSE_GROUPS.find((g) => g.code === 'movement').pl, null);
});

test('P&L: revenue, gross profit, expense groups, EBITDA and margin', () => {
  const report = computePnl(
    [
      e(A, 'rev_manual', 10000),
      e(A, 'other_income', 500),
      e(A, 'suppliers', 3000),
      e(A, 'workshop', 1000),
      e(A, 'pay_site', 2000),
      e(A, 'rent', 1500),
      e(A, 'adj_acquiring', -100),
      e(A, 'cash_withdrawal', 99999),
      e(B, 'fee_bank', 50),
    ],
    [r(A, 'cash', 6000), r(A, 'card', 4000), r(B, 'glovo', 1000)],
    null,
    opts(),
  );
  assert.deepEqual(report.columns, [A, B, 'total']);
  assert.equal(line(report, 'revenue')[A], '20000');
  assert.equal(line(report, 'rev:cash')[A], '6000');
  assert.equal(line(report, 'cat:rev_manual')[A], '10000');
  assert.equal(line(report, 'cogs')[A], '4000');
  assert.equal(line(report, 'gross')[A], '16500');
  assert.equal(line(report, 'group:payroll')[A], '2000');
  assert.equal(line(report, 'group:adjustments')[A], '-100');
  // 2000 + 1500 - 100: money movement is never an expense.
  assert.equal(line(report, 'expenses')[A], '3400');
  assert.equal(line(report, 'ebitda')[A], '13100');
  assert.equal(line(report, 'margin')[A], '65.5');
  assert.equal(line(report, 'ebitda')[B], '950');
  assert.equal(line(report, 'ebitda').total, '14050');
  assert.equal(report.tiles.revenue_minor, '21000');
  assert.equal(report.tiles.payroll_percent, '9.5');
  assert.equal(report.tiles.rent_percent, '7.1');
  assert.equal(report.tiles.foodcost_percent, '19.0');
});

test('P&L: cost by the cards puts the supplier payments into a reference line', () => {
  const report = computePnl(
    [e(A, 'suppliers', 3000), e(A, 'rev_manual', 10000)],
    [],
    [{ location: A, month: '2026-11', amount_minor: 2500n }],
    opts({ cogs: 'ttk' }),
  );
  assert.equal(line(report, 'cogs')[A], '2500');
  assert.equal(line(report, 'cogs_paid')[A], '3000');
  assert.equal(line(report, 'gross')[A], '7500');
  assert.equal(line(report, 'ebitda')[A], '7500');
});

test('company expenses: a separate column, or shared by the revenue of the month', () => {
  const entries = [e(COMPANY, 'pay_office', 1000), e(A, 'rent', 100)];
  const revenue = [r(A, 'cash', 3000), r(B, 'cash', 1000)];
  const apart = computePnl(entries, revenue, null, opts());
  assert.deepEqual(apart.columns, [A, B, COMPANY, 'total']);
  assert.equal(line(apart, 'cat:pay_office')[COMPANY], '1000');
  assert.equal(line(apart, 'ebitda')[COMPANY], '-1000');
  const shared = computePnl(entries, revenue, null, opts({ allocate: true }));
  assert.deepEqual(shared.columns, [A, B, 'total']);
  assert.equal(line(shared, 'cat:pay_office')[A], '750');
  assert.equal(line(shared, 'cat:pay_office')[B], '250');
  assert.equal(line(shared, 'ebitda').total, line(apart, 'ebitda').total);
  // A month without revenue keeps its company expenses apart.
  const empty = computePnl([e(COMPANY, 'rent', 10, '2026-10')], [], null, opts({ allocate: true }));
  assert.deepEqual(empty.unallocated_months, ['2026-10']);
  assert.equal(line(empty, 'cat:rent')[COMPANY], '10');
});

test('the share is exact to the tiyn and keeps the sign', () => {
  const parts = shareByWeight(100n, [
    ['a', 1n],
    ['b', 1n],
    ['c', 1n],
  ]);
  assert.deepEqual([...parts.values()], [34n, 33n, 33n]);
  assert.deepEqual(
    [
      ...shareByWeight(-100n, [
        ['a', 1n],
        ['b', 3n],
      ]).values(),
    ],
    [-25n, -75n],
  );
  assert.equal(shareByWeight(5n, [['a', 0n]]), null);
});

test('P&L by months', () => {
  const report = computePnl(
    [e(A, 'rent', 100, '2026-10'), e(B, 'rent', 50, '2026-11')],
    [r(A, 'cash', 1000, '2026-10')],
    null,
    opts({ columns: 'months', months: ['2026-10', '2026-11'] }),
  );
  assert.deepEqual(report.columns, ['2026-10', '2026-11', 'total']);
  assert.equal(line(report, 'cat:rent')['2026-10'], '100');
  assert.equal(line(report, 'cat:rent').total, '150');
});

test('cash reconciliation', () => {
  const base = {
    opening_minor: null,
    previous_counted_minor: 1000n,
    cash_revenue_minor: 5000n,
    cash_income_minor: 200n,
    withdrawal_minor: 300n,
    cash_expenses_minor: 1500n,
    collection_minor: 4000n,
    counted_minor: 1000n,
  };
  const day = cashDay(base);
  assert.equal(day.opening_source, 'previous');
  assert.equal(day.expected_minor, '1000');
  assert.equal(day.difference_minor, '0');
  assert.equal(day.mismatch, false);
  const short = cashDay({ ...base, opening_minor: 1200n, counted_minor: 900n });
  assert.equal(short.opening_source, 'manual');
  assert.equal(short.expected_minor, '1200');
  assert.equal(short.difference_minor, '-300');
  assert.equal(short.mismatch, true);
  const none = cashDay({ ...base, previous_counted_minor: null, counted_minor: null });
  assert.equal(none.opening_source, 'none');
  assert.equal(none.difference_minor, null);
  assert.equal(none.mismatch, false);
});

test('percent', () => {
  assert.equal(percent(1n, 3n), '33.3');
  assert.equal(percent(2n, 3n), '66.7');
  assert.equal(percent(-1n, 8n), '-12.5');
  assert.equal(percent(1n, 0n), '');
});
