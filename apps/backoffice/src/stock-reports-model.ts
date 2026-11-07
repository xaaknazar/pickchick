/*
 * Stock reports of the cabinet (lane bo-ui2 step 4, Ск4; design-bo-ui.md §9.4): the views of GET
 * .../ops/stock?view=balances|reorder and the `turnover` of view=movement, the honest banners
 * while sales are not written off, the reorder rule in words, the CSV files (tenge under
 * «Сумма, ₸») and the lines of a supply request prefilled from «К заказу». Pure functions; the
 * page is inventory.ts. Used only while GET branches/:id reports capabilities.stock_reports;
 * without it the cabinet asks for none of this and the stock page is the bo-ui one.
 */
import { almatyDateTime } from './ui-fixes.js';
import { csvTenge, csvTextCell } from './sales-report-model.js';
import { csvQuantity, displayQuantity } from './inventory-model.js';
import { stallText, type ConsumptionBacklog } from './autoconsume-model.js';
import {
  REQUEST_KINDS,
  editorQuantity,
  type RequestForm,
  type RequestKind,
} from './supply-model.js';

type Data = Record<string, unknown>;
const isObject = (v: unknown): v is Data =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);
function invalid(): never {
  throw new Error('INVALID_RESPONSE');
}
const whole = (v: unknown) => typeof v === 'string' && /^-?(0|[1-9][0-9]*)$/.test(v);

/** The stock reports (BACKOFFICE_STOCK_REPORTS_ENABLED with stock v2) answer on this server. */
export const stockReportsAvailable = (data: { capabilities?: unknown } | null | undefined) =>
  Boolean(
    data?.capabilities &&
    typeof data.capabilities === 'object' &&
    (data.capabilities as Data)['stock_reports'] === true,
  );

export type StockConsumption = {
  mode: 'off' | 'dry_run' | 'on' | 'unavailable';
  start_at: string | null;
  backlog: (ConsumptionBacklog & { stall_minutes?: number }) | null;
  sales_included: boolean;
};
function consumptionOf(value: unknown): StockConsumption {
  if (
    !isObject(value) ||
    !['off', 'dry_run', 'on', 'unavailable'].includes(String(value['mode'])) ||
    typeof value['sales_included'] !== 'boolean'
  )
    invalid();
  return value as StockConsumption;
}
/**
 * The banner of the reports while sales are not in their numbers (design-bo-ui §9.4), or null
 * when the automatic consumption writes them off and keeps up.
 */
export function salesBanner(c: StockConsumption, asOf: string): string | null {
  if (c.mode === 'on' && c.sales_included) return null;
  if (c.mode === 'on') {
    const stall = stallText(c.backlog, 'on', asOf);
    return (
      (stall ?? 'Списание по продажам отстаёт.') +
      ' Остатки, движение и расход здесь - без этих продаж.'
    );
  }
  if (c.mode === 'dry_run')
    return 'Списание по продажам работает в режиме проверки: продажи со склада не списываются. Остатки, движение и расход здесь - без продаж.';
  return 'Продажи не списываются со склада автоматически: остатки, движение и расход здесь - без продаж.';
}
/** «С 19.11.2026 10:00 продажи списываются автоматически.» while they are, or null. */
export const salesSince = (c: StockConsumption) =>
  c.mode === 'on' && c.sales_included && c.start_at
    ? `Продажи списываются со склада автоматически с ${almatyDateTime(c.start_at)}.`
    : null;

// ------------------------------------------------------------------------- balances ----

export type LastPurchase = {
  quantity: string;
  value_minor: string;
  at: string;
  document_id: string;
};
export type BalanceRow = {
  ingredient_id: string;
  name: string;
  unit: string;
  active: boolean;
  group: string | null;
  supply_kind: string | null;
  meat: boolean;
  quantity: string;
  value_minor: string;
  minimum: string;
  below_minimum: boolean;
  counted_at: string | null;
  last_movement_at: string | null;
  last_purchase: LastPurchase | null;
  value_last_price_minor: string | null;
  revision: number;
};
export type StockBalancesView = {
  view: 'balances';
  as_of: string;
  rows: BalanceRow[];
  totals: {
    items: number;
    active: number;
    below_minimum: number;
    value_minor: string;
    value_last_price_minor: string;
    unpriced: number;
  };
  counted_at_known: boolean;
  consumption: StockConsumption;
  truncated: { rows: boolean };
};
function envelope(value: unknown, branch: string, view: string): Data {
  if (
    !isObject(value) ||
    value['schema_version'] !== 1 ||
    value['branch_id'] !== branch ||
    value['view'] !== view ||
    typeof value['as_of'] !== 'string' ||
    !Array.isArray(value['rows']) ||
    !isObject(value['totals']) ||
    !isObject(value['truncated'])
  )
    invalid();
  consumptionOf(value['consumption']);
  return value;
}
/** GET .../ops/stock?view=balances as the page reads it; anything else is an invalid answer. */
export function stockBalancesView(value: unknown, branch: string): StockBalancesView {
  const v = envelope(value, branch, 'balances');
  for (const r of v['rows'] as unknown[])
    if (
      !isObject(r) ||
      typeof r['ingredient_id'] !== 'string' ||
      typeof r['name'] !== 'string' ||
      !whole(r['quantity']) ||
      !whole(r['value_minor']) ||
      !whole(r['minimum']) ||
      typeof r['below_minimum'] !== 'boolean' ||
      (r['value_last_price_minor'] !== null && !whole(r['value_last_price_minor']))
    )
      invalid();
  return v as unknown as StockBalancesView;
}
export type BalanceFilter = 'active' | 'low' | 'zero' | 'inactive' | 'all';
/** The filter of «Остатки» on the rows of the server (the bo-ui filter of the snapshot rows). */
export function balanceRows(view: StockBalancesView, query: string, filter: BalanceFilter) {
  const q = query.trim().toLocaleLowerCase('ru-RU');
  return view.rows.filter(
    (r) =>
      (!q || r.name.toLocaleLowerCase('ru-RU').includes(q)) &&
      (filter === 'all' ||
        ((filter === 'inactive' ? !r.active : r.active) &&
          (filter !== 'low' || r.below_minimum) &&
          (filter !== 'zero' || r.quantity === '0'))),
  );
}
/** The state of a balance in words (never colour alone). */
export function balanceState(r: Pick<BalanceRow, 'active' | 'quantity' | 'below_minimum'>) {
  if (!r.active) return 'Не используется';
  if (r.quantity === '0') return 'Нет запаса';
  return r.below_minimum ? 'Ниже минимума' : 'В наличии';
}
/** «Остатки» CSV: quantities in kg, l or pcs, money in tenge. */
export function balancesCsv(rows: readonly BalanceRow[], asOf: string): string[][] {
  return [
    ['Остатки на', almatyDateTime(asOf)],
    [
      'Ингредиент',
      'Остаток',
      'Единица',
      'Минимум',
      'Состояние',
      'Последний подсчёт',
      'Последнее движение',
      'Сумма, ₸',
      'По последней цене закупки, ₸',
    ],
    ...rows.map((r) => [
      csvTextCell(r.name),
      ...csvQuantity(r.quantity, r.unit),
      csvQuantity(r.minimum, r.unit)[0],
      balanceState(r),
      r.counted_at ? almatyDateTime(r.counted_at) : '',
      r.last_movement_at ? almatyDateTime(r.last_movement_at) : '',
      csvTenge(r.value_minor),
      r.value_last_price_minor === null ? '' : csvTenge(r.value_last_price_minor),
    ]),
  ];
}

// ------------------------------------------------------------------------- movement ----

export const TURNOVER_KINDS = [
  'receipts',
  'production_in',
  'consumption',
  'waste',
  'production_out',
  'counts',
  'reversals',
  'transfers',
] as const;
export type TurnoverKind = (typeof TURNOVER_KINDS)[number];
export const TURNOVER_LABELS: Record<TurnoverKind | 'opening' | 'in' | 'out' | 'closing', string> =
  {
    opening: 'На начало',
    receipts: 'Поставки',
    production_in: 'Выпуск производства',
    consumption: 'Списано по продажам',
    waste: 'Списания',
    production_out: 'В производство',
    counts: 'Инвентаризация',
    reversals: 'Сторно',
    transfers: 'Перемещения',
    in: 'Пришло',
    out: 'Ушло',
    closing: 'На конец',
  };
type Amount = { quantity: string; value_minor: string };
export type TurnoverRow = { ingredient_id: string; name: string; unit: string } & Record<
  TurnoverKind | 'opening' | 'in' | 'out' | 'closing',
  Amount
>;
export type Turnover = {
  rows: TurnoverRow[];
  totals: Record<TurnoverKind | 'opening' | 'in' | 'out' | 'closing', { value_minor: string }>;
  mismatches: string[];
  truncated: { rows: boolean };
};
/**
 * The turnover of a view=movement answer, null on a server without the stock reports (the bo-ui
 * answer has no such key). A malformed one is an invalid answer.
 */
export function turnoverOf(
  report: unknown,
): { turnover: Turnover; consumption: StockConsumption } | null {
  if (!isObject(report) || report['turnover'] === undefined) return null;
  const t = report['turnover'];
  if (
    !isObject(t) ||
    !Array.isArray(t['rows']) ||
    !isObject(t['totals']) ||
    !Array.isArray(t['mismatches'])
  )
    invalid();
  for (const r of t['rows'] as unknown[]) {
    if (!isObject(r) || typeof r['ingredient_id'] !== 'string') invalid();
    for (const k of ['opening', ...TURNOVER_KINDS, 'in', 'out', 'closing'])
      if (
        !isObject(r[k]) ||
        !whole((r[k] as Data)['quantity']) ||
        !whole((r[k] as Data)['value_minor'])
      )
        invalid();
  }
  return { turnover: t as unknown as Turnover, consumption: consumptionOf(report['consumption']) };
}
/** opening + in - out = closing of a row, in quantity and value (the server's identity). */
export function rowReconciles(r: TurnoverRow) {
  return (['quantity', 'value_minor'] as const).every(
    (k) => BigInt(r.opening[k]) + BigInt(r.in[k]) - BigInt(r.out[k]) === BigInt(r.closing[k]),
  );
}
const dmy = (day: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : day;
};
/** «Движение по позициям» CSV: per ingredient quantity and «Сумма, ₸» of every column. */
export function turnoverCsv(
  turnover: Turnover,
  window: { start_date: string; end_date: string },
): string[][] {
  const columns = ['opening', ...TURNOVER_KINDS, 'in', 'out', 'closing'] as const;
  return [
    ['Движение по позициям за период', `${dmy(window.start_date)} - ${dmy(window.end_date)}`],
    [
      'Ингредиент',
      'Единица',
      ...columns.flatMap((k) => [TURNOVER_LABELS[k], `${TURNOVER_LABELS[k]}: Сумма, ₸`]),
    ],
    ...turnover.rows.map((r) => [
      csvTextCell(r.name),
      csvQuantity(0, r.unit)[1],
      ...columns.flatMap((k) => [
        csvQuantity(r[k].quantity, r.unit)[0],
        csvTenge(r[k].value_minor),
      ]),
    ]),
    [],
    ['Итого', '', ...columns.flatMap((k) => ['', csvTenge(turnover.totals[k].value_minor)])],
  ];
}

// -------------------------------------------------------------------------- reorder ----

export type ReorderRow = {
  ingredient_id: string;
  name: string;
  unit: string;
  group: string | null;
  supply_kind: string | null;
  meat: boolean;
  balance: string;
  minimum: string;
  use: Record<'d7' | 'd14', { quantity: string; days: number }>;
  rate: { quantity: string; days: number } | null;
  days_left: string | null;
  target: string;
  target_rule: 'minimum' | 'meat_days';
  hint: string;
  state: 'below' | 'near';
  last_purchase: LastPurchase | null;
  hint_value_minor: string | null;
};
export type UsePeriod = { days: number; start_date: string | null; end_date: string };
export type StockReorderView = {
  view: 'reorder';
  as_of: string;
  today: string;
  rule: { meat_days: number; near_percent: number; use_days: number[] };
  periods: Record<'d7' | 'd14', UsePeriod>;
  rows: ReorderRow[];
  totals: { rows: number; below: number; near: number; hint_value_minor: string; unpriced: number };
  consumption: StockConsumption;
  truncated: { rows: boolean };
};
/** GET .../ops/stock?view=reorder as the page reads it; anything else is an invalid answer. */
export function stockReorderView(value: unknown, branch: string): StockReorderView {
  const v = envelope(value, branch, 'reorder');
  if (!isObject(v['rule']) || !isObject(v['periods'])) invalid();
  for (const r of v['rows'] as unknown[])
    if (
      !isObject(r) ||
      typeof r['ingredient_id'] !== 'string' ||
      !whole(r['balance']) ||
      !whole(r['target']) ||
      !whole(r['hint']) ||
      !['below', 'near'].includes(String(r['state'])) ||
      !isObject(r['use'])
    )
      invalid();
  return v as unknown as StockReorderView;
}
const plural = (n: bigint, one: string, few: string, many: string) =>
  n % 10n === 1n && n % 100n !== 11n
    ? one
    : n % 10n >= 2n && n % 10n <= 4n && (n % 100n < 12n || n % 100n > 14n)
      ? few
      : many;
/** «3 дня», «меньше дня», «-» (no use). */
export function daysLeftText(daysLeft: string | null) {
  if (daysLeft === null) return '-';
  const n = BigInt(daysLeft);
  if (n === 0n) return 'меньше дня';
  return `${n.toString()} ${plural(n, 'день', 'дня', 'дней')}`;
}
/**
 * The average daily use in the unit of the position with one decimal: «1,93 кг в день» for
 * grams and millilitres (3 decimals of kg), «2,9 шт в день» for pieces, «нет данных» without.
 */
export function perDayText(use: { quantity: string; days: number }, unit: string) {
  if (!use.days) return 'нет полных дней';
  const q = BigInt(use.quantity),
    d = BigInt(use.days);
  if (q === 0n) return 'нет расхода';
  if (unit === 'g' || unit === 'ml') {
    const perDay = (2n * q + d) / (2n * d); // whole g or ml, half up
    return `${displayQuantity(perDay, unit)} в день`;
  }
  const tenths = (20n * q + d) / (2n * d);
  return `${(tenths / 10n).toString()}${tenths % 10n ? ',' + (tenths % 10n).toString() : ''} шт в день`;
}
/** «Как считается» of «К заказу»: the whole rule in words, from the rule the server applied. */
export function reorderRuleText(view: Pick<StockReorderView, 'rule' | 'periods'>) {
  const d7 = view.periods.d7,
    d14 = view.periods.d14;
  const period = (p: UsePeriod, n: number) =>
    p.days === n
      ? `${n} полных дней`
      : p.days === 0
        ? `${n} дней (полных дней с начала списания по продажам ещё нет)`
        : `${n} дней (с ${dmy(p.start_date ?? '')}: ${p.days} ${plural(BigInt(p.days), 'полный день', 'полных дня', 'полных дней')} с начала списания по продажам)`;
  return [
    'Как считается: цель - минимальный запас позиции из её карточки.',
    `Для позиций с отметкой «Мясо» цель - ${view.rule.meat_days} дня среднего расхода (берётся больший из средних за 7 и 14 дней), но не меньше минимума.`,
    'Заказать = цель минус остаток, если остаток меньше цели; иначе ничего.',
    `«Рядом с минимумом» - остаток не больше цели плюс ${view.rule.near_percent} %.`,
    `Средний расход - списание по продажам и расход в производство за последние ${period(d7, 7)} и ${period(d14, 14)}; сегодняшний день, списания и инвентаризации не входят, сторно уменьшает расход дня, в который его провели.`,
    '«Хватит на» - остаток, делённый на тот же средний расход, с округлением вниз.',
    'Сумма - по цене последней поставки позиции (без сторнированных).',
  ].join(' ');
}
export const REORDER_STATE_LABELS: Record<ReorderRow['state'], string> = {
  below: 'Ниже цели',
  near: 'Рядом с минимумом',
};
export const SUPPLY_KIND_LABELS: Record<string, string> = {
  central_kitchen: 'Цех',
  bakery: 'Пекарня',
  household: 'Хозтовары',
  supplier: 'Поставщик',
};
/** «Цель: 3 дня расхода» or «Цель: минимум». */
export const targetText = (r: Pick<ReorderRow, 'target' | 'target_rule' | 'unit'>, days: number) =>
  `${displayQuantity(r.target, r.unit)} (${r.target_rule === 'meat_days' ? `${days} дня расхода` : 'минимум'})`;
/** «К заказу» CSV: rows with their use, target, suggested quantity and its value in tenge. */
export function reorderCsv(view: StockReorderView): string[][] {
  return [
    ['К заказу на', almatyDateTime(view.as_of)],
    [
      'Ингредиент',
      'Единица',
      'Откуда',
      'Мясо',
      'Остаток',
      'Минимум',
      'Расход за 7 дней',
      'Полных дней из 7',
      'Расход за 14 дней',
      'Полных дней из 14',
      'Хватит на, дней',
      'Цель',
      'Правило цели',
      'Заказать',
      'Состояние',
      'Сумма, ₸',
    ],
    ...view.rows.map((r) => [
      csvTextCell(r.name),
      csvQuantity(0, r.unit)[1],
      r.supply_kind ? (SUPPLY_KIND_LABELS[r.supply_kind] ?? r.supply_kind) : '',
      r.meat ? 'да' : 'нет',
      csvQuantity(r.balance, r.unit)[0],
      csvQuantity(r.minimum, r.unit)[0],
      csvQuantity(r.use.d7.quantity, r.unit)[0],
      String(r.use.d7.days),
      csvQuantity(r.use.d14.quantity, r.unit)[0],
      String(r.use.d14.days),
      r.days_left ?? '',
      csvQuantity(r.target, r.unit)[0],
      r.target_rule === 'meat_days' ? `${view.rule.meat_days} дня расхода` : 'минимум',
      csvQuantity(r.hint, r.unit)[0],
      REORDER_STATE_LABELS[r.state],
      r.hint_value_minor === null ? '' : csvTenge(r.hint_value_minor),
    ]),
  ];
}
/** The rows «Создать заявку» selects first: everything below its target. */
export const defaultSelection = (view: StockReorderView) =>
  new Set(view.rows.filter((r) => r.state === 'below').map((r) => r.ingredient_id));
/**
 * The supply request prefilled from the selected rows of «К заказу»: the kind every selected row
 * shares (its «Откуда»), otherwise «Поставщик»; one line per row with the suggested quantity (an
 * empty quantity for a row near its minimum, to fill in); `mixed` when the rows come from
 * different places, so the page can say the kind was chosen for them.
 */
export function reorderRequest(
  view: StockReorderView,
  selected: ReadonlySet<string>,
  today: string,
): { form: RequestForm; mixed: boolean } {
  const rows = view.rows.filter((r) => selected.has(r.ingredient_id)).slice(0, 100);
  const kinds = new Set(rows.map((r) => r.supply_kind ?? ''));
  const only = kinds.size === 1 ? [...kinds][0]! : '';
  const kind: RequestKind = (REQUEST_KINDS as readonly string[]).includes(only)
    ? (only as RequestKind)
    : 'supplier';
  const next = new Date(`${today}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return {
    form: {
      kind,
      supplier_id: '',
      needed_by: next.toISOString().slice(0, 10),
      note: '',
      lines: rows.map((r) =>
        r.hint === '0'
          ? { ingredient_id: r.ingredient_id, quantity: '', unit: r.unit }
          : { ingredient_id: r.ingredient_id, ...editorQuantity(r.hint, r.unit) },
      ),
    },
    mixed: kinds.size > 1,
  };
}
