/**
 * Pure calculations of «Расходы»: the P&L (ОПУ), the share of company expenses by revenue and the
 * cash reconciliation of a branch day (owner request 11.11.2026, sections 4 and 6). No database
 * here: expenses.ts reads the facts and these functions give the numbers, so the tests check the
 * arithmetic directly. Money is BigInt tiyn; strings outside.
 */
import {
  EXPENSE_CATEGORIES,
  EXPENSE_GROUPS,
  REVENUE_TYPES,
  expenseCategory,
  expenseGroup,
  PAYROLL_GROUP,
  RENT_CATEGORY,
  type RevenueType,
} from './expenses-catalog.js';

/** Column key of the company expenses (no branch). */
export const COMPANY = 'company';
export type EntryFact = {
  /** Branch id or COMPANY. */
  location: string;
  /** YYYY-MM of the P&L. */
  month: string;
  category: string;
  amount_minor: bigint;
};
export type RevenueFact = {
  location: string;
  month: string;
  type: RevenueType;
  amount_minor: bigint;
};
export type CogsFact = { location: string; month: string; amount_minor: bigint };
export type PnlOptions = {
  columns: 'locations' | 'months';
  /** Raw-material cost: by the technological cards (sold) or by the payments to suppliers. */
  cogs: 'ttk' | 'payments';
  /** Share the company expenses among the branches by their revenue of the month. */
  allocate: boolean;
  /** Branch ids in display order (columns of the locations view). */
  locations: readonly string[];
  /** YYYY-MM months of the period in order (columns of the months view). */
  months: readonly string[];
};
export type PnlLine = {
  key: string;
  label: string;
  kind: 'header' | 'line' | 'total' | 'reference' | 'percent';
  /** Categories whose records make the amount (for «open the records»). */
  categories?: string[];
  values: Record<string, string>;
};

const COGS_PAID = ['suppliers', 'workshop'];
/**
 * Splits `amount` between keys in proportion to `weights` (non-negative). Largest remainder, so
 * the parts sum to the amount exactly; ties go to the earlier key. Null when the weights are 0.
 */
export function shareByWeight(
  amount: bigint,
  weights: ReadonlyArray<readonly [string, bigint]>,
): Map<string, bigint> | null {
  const positive = weights.filter(([, w]) => w > 0n);
  const total = positive.reduce((s, [, w]) => s + w, 0n);
  if (total === 0n) return null;
  const sign = amount < 0n ? -1n : 1n;
  const abs = amount * sign;
  const parts = positive.map(([k, w], i) => ({ k, i, q: (abs * w) / total, r: (abs * w) % total }));
  let rest = abs - parts.reduce((s, p) => s + p.q, 0n);
  for (const p of [...parts].sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1))) {
    if (rest === 0n) break;
    p.q += 1n;
    rest -= 1n;
  }
  return new Map(parts.map((p) => [p.k, p.q * sign]));
}

type Cell = Map<string, bigint>;
const add = (m: Cell, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);

/**
 * The P&L. Columns: one per branch plus COMPANY (when not allocated) and `total`, or one per month
 * plus `total`. Expenses are taken by their P&L month. Money movement is never in it.
 */
export function computePnl(
  entries: readonly EntryFact[],
  revenue: readonly RevenueFact[],
  cogsTtk: readonly CogsFact[] | null,
  o: PnlOptions,
) {
  // Revenue of a branch in a month: the weights of the allocation (auto + manual revenue).
  const monthRevenue = new Map<string, Map<string, bigint>>();
  const revenueOf = (month: string) => {
    let m = monthRevenue.get(month);
    if (!m) monthRevenue.set(month, (m = new Map()));
    return m;
  };
  for (const r of revenue) add(revenueOf(r.month), r.location, r.amount_minor);
  for (const e of entries)
    if (e.category === 'rev_manual' && e.location !== COMPANY)
      add(revenueOf(e.month), e.location, e.amount_minor);

  // Facts in P&L terms: [column, line key, amount].
  const facts: { location: string; month: string; key: string; amount: bigint }[] = [];
  for (const r of revenue)
    facts.push({
      location: r.location,
      month: r.month,
      key: 'rev:' + r.type,
      amount: r.amount_minor,
    });
  const unallocated: string[] = [];
  for (const e of entries) {
    const cat = expenseCategory(e.category);
    if (!cat || expenseGroup(cat.group)?.pl === null) continue;
    const fact = { month: e.month, key: 'cat:' + e.category, amount: e.amount_minor };
    if (e.location === COMPANY && o.allocate && o.columns === 'locations') {
      const weights = o.locations.map((l) => [l, revenueOf(e.month).get(l) ?? 0n] as const);
      const parts = shareByWeight(e.amount_minor, weights);
      if (parts) {
        for (const [l, v] of parts) facts.push({ ...fact, location: l, amount: v });
        continue;
      }
      if (!unallocated.includes(e.month)) unallocated.push(e.month);
    }
    facts.push({ ...fact, location: e.location });
  }
  if (cogsTtk)
    for (const r of cogsTtk)
      facts.push({ location: r.location, month: r.month, key: 'ttk', amount: r.amount_minor });

  const hasCompany = o.columns === 'locations' && facts.some((f) => f.location === COMPANY);
  const columns =
    o.columns === 'locations'
      ? [...o.locations, ...(hasCompany ? [COMPANY] : []), 'total']
      : [...o.months, 'total'];
  const table = new Map<string, Cell>();
  for (const f of facts) {
    let row = table.get(f.key);
    if (!row) table.set(f.key, (row = new Map()));
    add(row, o.columns === 'locations' ? f.location : f.month, f.amount);
    add(row, 'total', f.amount);
  }
  const value = (key: string, col: string) => table.get(key)?.get(col) ?? 0n;
  const sum = (keys: readonly string[], col: string) =>
    keys.reduce((s, k) => s + value(k, col), 0n);
  const values = (fn: (col: string) => bigint) =>
    Object.fromEntries(columns.map((col) => [col, String(fn(col))]));
  const catsOf = (group: string) =>
    EXPENSE_CATEGORIES.filter((c) => c.group === group && c.kind !== 'revenue_auto').map(
      (c) => c.code,
    );
  const keysOf = (codes: readonly string[]) => codes.map((c) => 'cat:' + c);

  const revenueKeys = [...REVENUE_TYPES.map((t) => 'rev:' + t.code), 'cat:rev_manual'];
  const otherIncomeKeys = keysOf(catsOf('other_income'));
  const cogsKeys = o.cogs === 'ttk' ? ['ttk'] : keysOf(COGS_PAID);
  const expenseGroups = EXPENSE_GROUPS.filter((g) => g.pl === 'expense');
  const expenseKeys = expenseGroups.flatMap((g) => keysOf(catsOf(g.code)));
  const revenueTotal = (col: string) => sum(revenueKeys, col);
  const gross = (col: string) => revenueTotal(col) + sum(otherIncomeKeys, col) - sum(cogsKeys, col);
  const expensesTotal = (col: string) => sum(expenseKeys, col);
  const ebitda = (col: string) => gross(col) - expensesTotal(col);

  const lines: PnlLine[] = [];
  const line = (
    key: string,
    label: string,
    kind: PnlLine['kind'],
    fn: (col: string) => bigint,
    categories?: string[],
  ) => lines.push({ key, label, kind, values: values(fn), ...(categories ? { categories } : {}) });
  line('revenue', 'Выручка (вкл. НДС)', 'total', revenueTotal);
  for (const t of REVENUE_TYPES)
    line('rev:' + t.code, t.name, 'line', (c) => value('rev:' + t.code, c));
  line('cat:rev_manual', 'Выручка вручную', 'line', (c) => value('cat:rev_manual', c), [
    'rev_manual',
  ]);
  line(
    'other_income',
    'Прочие поступления',
    'total',
    (c) => sum(otherIncomeKeys, c),
    catsOf('other_income'),
  );
  if (o.cogs === 'ttk') {
    line('cogs', 'Сырьевая себестоимость (по ТТК, проданное)', 'total', (c) => value('ttk', c));
    line(
      'cogs_paid',
      'Справочно: оплачено поставщикам и цеху (не в EBITDA)',
      'reference',
      (c) => sum(keysOf(COGS_PAID), c),
      COGS_PAID,
    );
  } else {
    line(
      'cogs',
      'Сырьевая себестоимость (по оплатам)',
      'total',
      (c) => sum(keysOf(COGS_PAID), c),
      COGS_PAID,
    );
    for (const code of COGS_PAID)
      line('cat:' + code, expenseCategory(code)!.name, 'line', (c) => value('cat:' + code, c), [
        code,
      ]);
  }
  line('gross', 'Валовая прибыль', 'total', gross);
  for (const g of expenseGroups) {
    const codes = catsOf(g.code);
    line('group:' + g.code, g.name, 'header', (c) => sum(keysOf(codes), c), codes);
    for (const code of codes)
      line('cat:' + code, expenseCategory(code)!.name, 'line', (c) => value('cat:' + code, c), [
        code,
      ]);
  }
  line('expenses', 'Всего расходов', 'total', expensesTotal);
  line('ebitda', 'EBITDA', 'total', ebitda);
  lines.push({
    key: 'margin',
    label: 'Рентабельность по EBITDA',
    kind: 'percent',
    values: Object.fromEntries(columns.map((c) => [c, percent(ebitda(c), revenueTotal(c))])),
  });

  const t = 'total';
  const tiles = {
    revenue_minor: String(revenueTotal(t)),
    foodcost_percent: percent(sum(cogsKeys, t), revenueTotal(t)),
    payroll_percent: percent(sum(keysOf(catsOf(PAYROLL_GROUP)), t), revenueTotal(t)),
    rent_percent: percent(value('cat:' + RENT_CATEGORY, t), revenueTotal(t)),
    expenses_minor: String(sum(cogsKeys, t) + expensesTotal(t)),
    ebitda_minor: String(ebitda(t)),
    margin_percent: percent(ebitda(t), revenueTotal(t)),
  };
  return { columns, lines, tiles, unallocated_months: unallocated };
}

/** a / b in percent with one decimal, half away from zero; '' when b is 0. */
export function percent(a: bigint, b: bigint): string {
  if (b === 0n) return '';
  const neg = a < 0n !== b < 0n;
  const x = (a < 0n ? -a : a) * 1000n,
    y = b < 0n ? -b : b;
  const q = (2n * x + y) / (2n * y);
  const s = `${q / 10n}.${q % 10n}`;
  return neg && q !== 0n ? '-' + s : s;
}

export type CashDayInput = {
  /** Opening entered by hand, or null. */
  opening_minor: bigint | null;
  /** The cashier's count of the latest earlier day, or null. */
  previous_counted_minor: bigint | null;
  /** Cash revenue of the day (automatic + manual revenue paid in cash). */
  cash_revenue_minor: bigint;
  /** Other income paid in cash. */
  cash_income_minor: bigint;
  /** Money taken from an account into the cash desk. */
  withdrawal_minor: bigint;
  /** Expenses paid in cash. */
  cash_expenses_minor: bigint;
  /** Cash handed over to the bank. */
  collection_minor: bigint;
  /** The cashier's count of the day, or null. */
  counted_minor: bigint | null;
};
/**
 * Должно быть в кассе = сальдо на начало + наличная выручка + прочие поступления наличными +
 * снятие со счёта - расходы наличными - инкассация. Сальдо на начало = введённое вручную, иначе
 * остаток по отчёту кассира за прошлый день (иначе 0). Разница = по отчёту кассира - должно быть.
 */
export function cashDay(i: CashDayInput) {
  const opening = i.opening_minor ?? i.previous_counted_minor ?? 0n;
  const expected =
    opening +
    i.cash_revenue_minor +
    i.cash_income_minor +
    i.withdrawal_minor -
    i.cash_expenses_minor -
    i.collection_minor;
  const difference = i.counted_minor === null ? null : i.counted_minor - expected;
  return {
    opening_minor: String(opening),
    opening_source:
      i.opening_minor !== null ? 'manual' : i.previous_counted_minor !== null ? 'previous' : 'none',
    cash_revenue_minor: String(i.cash_revenue_minor),
    cash_income_minor: String(i.cash_income_minor),
    withdrawal_minor: String(i.withdrawal_minor),
    cash_expenses_minor: String(i.cash_expenses_minor),
    collection_minor: String(i.collection_minor),
    expected_minor: String(expected),
    counted_minor: i.counted_minor === null ? null : String(i.counted_minor),
    difference_minor: difference === null ? null : String(difference),
    mismatch: difference !== null && difference !== 0n,
  };
}
