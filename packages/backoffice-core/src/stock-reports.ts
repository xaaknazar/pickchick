import { z } from 'zod';
import type { DatabaseClient } from '@pickchick/database';
import { parse, periodWindow } from './model.js';
import { stockV2Readable } from './stock-v2.js';
import {
  autoconsumeAvailable,
  consumptionBacklog,
  readStockSettings,
  type ConsumptionBacklog,
} from './consumption-store.js';
import { SUPPLY_REQUEST_KINDS, almatyDay } from './supply.js';
import type { BackofficeOptions } from './stops.js';

/**
 * Stock reports of the back office (lane bo-ui2 step 4, Ск4; design-bo-ui.md §9.4), only while
 * BACKOFFICE_STOCK_REPORTS_ENABLED is on with stock v2 (loadConfig requires it) and the cloud074
 * columns are readable (stockReportsAvailable). They live under GET .../ops/stock, beside the
 * cloud lane and bo-ui views:
 *
 * - `view=balances`: every ingredient with its balance, unit, minimum, «ниже минимума», the time
 *   of its last count (cloud075 counted_at) and last movement, and the value of the balance at the
 *   last purchase price (the newest receipt line with a value that was not reversed) beside the
 *   value at average cost.
 * - `view=movement` (the existing view) gains `turnover`: per ingredient the balance at the start
 *   of the window, every kind of movement of the window with its sign and the balance at the end.
 *   The start is the balance after the last movement before the window (movements are immutable,
 *   cloud017), the end = start + the movements of the window, and the end is checked against the
 *   balance after the last movement of the window (`mismatches`, normally empty).
 * - `view=reorder`: the active ingredients below or near their target with the average daily use
 *   of the last 7 and 14 full days, «хватит на N дней» and the suggested quantity
 *   max(0, target - balance). The target is the minimum; for an ingredient marked «Мясо» it is
 *   3 days of the larger of the two averages, never below the minimum.
 *
 * Every view carries `consumption` = the automatic consumption mode of bo-ui (off, dry_run, on or
 * unavailable) with its backlog: unless it is `on` (and keeps up), sales are not in these numbers
 * and the cabinet says so. Without the flag none of this runs: the views are refused exactly as
 * before (INVALID_REQUEST of the strict query) and view=movement answers as before.
 */

type Db = Pick<DatabaseClient, 'query'>;

/** The views the flag adds to GET .../ops/stock (view=movement exists and gains `turnover`). */
export const STOCK_REPORT_VIEWS = ['balances', 'reorder'] as const;
export const StockBalancesQuery = z.strictObject({ view: z.literal('balances') });
export const StockReorderQuery = z.strictObject({ view: z.literal('reorder') });
/** At most this many ingredients per answer (GET branches/:id lists 2000 records too). */
export const STOCK_REPORT_ROW_LIMIT = 2000;
/** «Мясо»: the target is this many days of the average daily use (never below the minimum). */
export const REORDER_MEAT_DAYS = 3;
/** «Рядом с минимумом»: the balance is at most the target plus this share (percent). */
export const REORDER_NEAR_PERCENT = 20;
/** The average daily use is taken over this many full Almaty days before today. */
export const REORDER_USE_DAYS = [7, 14] as const;

/**
 * Second-wave fields of an ingredient card (design-bo-ui.md §9.2): `supply_kind` - where it
 * usually comes from (groups the order hint and prefills the request kind), with
 * BACKOFFICE_SUPPLY_ENABLED; `meat` - the reorder target is 3 days of use, with the stock
 * reports. Each is accepted only while its flag is on; otherwise the card keeps a stored value
 * (the rollback rule of stock P1, review BOUI-R3) and refuses a new one, as before.
 */
export const INGREDIENT_P2_FIELDS = Object.freeze({
  supply_kind: z.enum(SUPPLY_REQUEST_KINDS).optional(),
  meat: z.boolean().optional(),
});
export const INGREDIENT_P2_KEYS = ['supply_kind', 'meat'] as const;
export type IngredientP2Key = (typeof INGREDIENT_P2_KEYS)[number];
/** Which second-wave ingredient fields this server accepts (`on`) and which it only keeps. */
export function ingredientP2Keys(options: BackofficeOptions): {
  on: IngredientP2Key[];
  off: IngredientP2Key[];
} {
  const accepted = {
    supply_kind: options.supplyEnabled === true && options.stockV2Enabled === true,
    meat: options.stockReportsEnabled === true && options.stockV2Enabled === true,
  };
  return {
    on: INGREDIENT_P2_KEYS.filter((k) => accepted[k]),
    off: INGREDIENT_P2_KEYS.filter((k) => !accepted[k]),
  };
}
/** The ingredient schema (Ingredient or IngredientP1) with the accepted second-wave fields. */
export function withIngredientP2<T extends z.ZodObject>(base: T, on: readonly IngredientP2Key[]) {
  if (!on.length) return base;
  return base.extend(Object.fromEntries(on.map((k) => [k, INGREDIENT_P2_FIELDS[k]])));
}

/** The stock reports can run: the flag, stock v2 and the cloud074 columns readable. */
export async function stockReportsAvailable(db: Db, options: BackofficeOptions) {
  return (
    options.stockReportsEnabled === true &&
    options.stockV2Enabled === true &&
    (await stockV2Readable(db))
  );
}

/** One cloud075 column exists and the current role may read it (075 is not required here). */
async function columnReadable(db: Db, table: string, column: string) {
  const r = await db.query<{ ok: boolean | null }>(
    `SELECT coalesce((SELECT has_column_privilege(a.attrelid, a.attnum, 'SELECT') FROM pg_attribute a
       WHERE a.attrelid = to_regclass($1) AND a.attname = $2 AND NOT a.attisdropped), false) AS ok`,
    [table, column],
  );
  return r.rows[0]?.ok === true;
}

export type StockConsumption = {
  /** `unavailable`: the automatic consumption is off on this server (flag or cloud075 rights). */
  mode: 'off' | 'dry_run' | 'on' | 'unavailable';
  start_at: string | null;
  backlog: ConsumptionBacklog | null;
  /** Sales are written off now: mode on and nothing late (review BOUI-R2). */
  sales_included: boolean;
};
/** Whether these numbers include sales: the mode of bo-ui's automatic consumption and its backlog. */
export async function stockConsumption(
  db: Db,
  branch: string,
  options: BackofficeOptions,
  now: Date,
): Promise<StockConsumption> {
  if (!(await autoconsumeAvailable(db, options)))
    return { mode: 'unavailable', start_at: null, backlog: null, sales_included: false };
  const settings = await readStockSettings(db, branch);
  const backlog = await consumptionBacklog(db, branch, settings, now);
  return {
    mode: settings.autoconsume_mode,
    start_at: settings.start_at,
    backlog,
    sales_included: settings.autoconsume_mode === 'on' && !backlog.stalled,
  };
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
/** Round half up of a non-negative a / b (b > 0). */
const half = (a: bigint, b: bigint) => (2n * a + b) / (2n * b);
type Payload = Record<string, unknown>;
const text = (p: Payload, k: string) => (typeof p[k] === 'string' ? (p[k] as string) : null);
type LastPurchase = { quantity: string; value_minor: string; at: string; document_id: string };

/** The newest receipt line with a value of every ingredient, not reversed (075), at most 1 each. */
async function lastPurchases(db: Db, branch: string, reversals: boolean) {
  const out = new Map<string, LastPurchase>();
  for (const r of (
    await db.query<{
      ingredient_id: string;
      quantity: string;
      value_minor: string;
      at: Date;
      document_id: string;
    }>(
      `SELECT DISTINCT ON (m.ingredient_id) m.ingredient_id,m.quantity_delta::text quantity,
         m.value_delta_minor::text value_minor,d.created_at at,d.id document_id
       FROM bo_stock_movements m JOIN bo_stock_documents d ON d.id=m.document_id AND d.branch_id=m.branch_id
       WHERE m.branch_id=$1 AND d.kind='receipt' AND m.quantity_delta>0 AND m.value_delta_minor>0
         ${reversals ? "AND NOT EXISTS(SELECT 1 FROM bo_stock_documents x WHERE x.reverses_document_id=d.id AND x.branch_id=d.branch_id AND x.kind='reversal')" : ''}
       ORDER BY m.ingredient_id,d.created_at DESC,d.id DESC`,
      [branch],
    )
  ).rows)
    out.set(r.ingredient_id, {
      quantity: r.quantity,
      value_minor: r.value_minor,
      at: iso(r.at)!,
      document_id: r.document_id,
    });
  return out;
}
/** A quantity at the unit price of a purchase, whole tiyn, half up. */
export function atPurchasePrice(quantity: bigint, purchase: LastPurchase | undefined) {
  if (!purchase) return null;
  return half(quantity * BigInt(purchase.value_minor), BigInt(purchase.quantity)).toString();
}

type IngredientRow = {
  ingredient_id: string;
  payload: Payload;
  quantity: string | null;
  value_minor: string | null;
  revision: number | null;
  counted_at: Date | null;
};
async function ingredients(db: Db, branch: string, counted: boolean) {
  return (
    await db.query<IngredientRow>(
      `SELECT r.id ingredient_id,r.payload,b.quantity::text,b.value_minor::text,b.revision,
         ${counted ? 'b.counted_at' : 'NULL::timestamptz counted_at'}
       FROM bo_records r LEFT JOIN bo_stock_balances b ON b.branch_id=r.branch_id AND b.ingredient_id=r.id
       WHERE r.branch_id=$1 AND r.kind='ingredient' ORDER BY r.payload->>'name',r.id
       LIMIT ${STOCK_REPORT_ROW_LIMIT + 1}`,
      [branch],
    )
  ).rows;
}
const facts = (r: IngredientRow) => ({
  ingredient_id: r.ingredient_id,
  name: String(r.payload['name'] ?? ''),
  unit: String(r.payload['unit'] ?? ''),
  active: r.payload['active'] === true,
  group: text(r.payload, 'group'),
  supply_kind: text(r.payload, 'supply_kind'),
  meat: r.payload['meat'] === true,
});

/**
 * GET .../ops/stock?view=balances: the balances now. `below_minimum` - an active ingredient with
 * a minimum whose balance is under it. `value_last_price_minor` - the balance at the unit price of
 * the last purchase (null without one); `value_minor` - at average cost, as the stock holds it.
 */
export async function readStockBalances(
  db: Db,
  branch: string,
  input: unknown,
  options: BackofficeOptions,
  now: Date,
) {
  parse(StockBalancesQuery, input);
  const reversals = await columnReadable(db, 'bo_stock_documents', 'reverses_document_id');
  const counted = await columnReadable(db, 'bo_stock_balances', 'counted_at');
  const list = await ingredients(db, branch, counted);
  const purchases = await lastPurchases(db, branch, reversals);
  const moved = new Map(
    (
      await db.query<{ ingredient_id: string; at: Date }>(
        `SELECT m.ingredient_id,max(d.created_at) at FROM bo_stock_movements m
         JOIN bo_stock_documents d ON d.id=m.document_id AND d.branch_id=m.branch_id
         WHERE m.branch_id=$1 GROUP BY m.ingredient_id`,
        [branch],
      )
    ).rows.map((r) => [r.ingredient_id, iso(r.at)]),
  );
  const rows = list.slice(0, STOCK_REPORT_ROW_LIMIT).map((r) => {
    const quantity = BigInt(r.quantity ?? '0'),
      minimum = BigInt(String(r.payload['minimum'] ?? '0')),
      f = facts(r),
      purchase = purchases.get(r.ingredient_id);
    return {
      ...f,
      quantity: quantity.toString(),
      value_minor: r.value_minor ?? '0',
      minimum: minimum.toString(),
      below_minimum: f.active && minimum > 0n && quantity < minimum,
      counted_at: iso(r.counted_at),
      last_movement_at: moved.get(r.ingredient_id) ?? null,
      last_purchase: purchase ?? null,
      value_last_price_minor: atPurchasePrice(quantity, purchase),
      revision: r.revision ?? 0,
    };
  });
  const active = rows.filter((r) => r.active);
  return {
    schema_version: 1 as const,
    branch_id: branch,
    view: 'balances' as const,
    timezone: 'Asia/Almaty' as const,
    as_of: now.toISOString(),
    rows,
    totals: {
      items: rows.length,
      active: active.length,
      below_minimum: rows.filter((r) => r.below_minimum).length,
      value_minor: rows.reduce((n, r) => n + BigInt(r.value_minor), 0n).toString(),
      // Only the rows with a known last purchase; `unpriced` says how many have none.
      value_last_price_minor: rows
        .reduce((n, r) => n + BigInt(r.value_last_price_minor ?? '0'), 0n)
        .toString(),
      unpriced: rows.filter((r) => r.value_last_price_minor === null && r.quantity !== '0').length,
    },
    counted_at_known: counted,
    consumption: await stockConsumption(db, branch, options, now),
    limits: { rows: STOCK_REPORT_ROW_LIMIT },
    truncated: { rows: list.length > STOCK_REPORT_ROW_LIMIT },
  };
}

/** The kinds of movement of the turnover, in the order of the report. */
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
type Amount = { quantity: string; value_minor: string };
const ZERO = (): { quantity: bigint; value: bigint } => ({ quantity: 0n, value: 0n });
const out = (a: { quantity: bigint; value: bigint }): Amount => ({
  quantity: a.quantity.toString(),
  value_minor: a.value.toString(),
});
/** The movement kind of one document line (the sign of production tells input from output). */
const KIND_SQL = `CASE WHEN d.kind='receipt' THEN 'receipts'
    WHEN d.kind='consumption' THEN 'consumption'
    WHEN d.kind='waste' THEN 'waste'
    WHEN d.kind='count' THEN 'counts'
    WHEN d.kind='production' AND m.quantity_delta>0 THEN 'production_in'
    WHEN d.kind='production' THEN 'production_out'
    WHEN d.kind='reversal' THEN 'reversals'
    ELSE 'transfers' END`;
/** The balance after the last movement of every ingredient before an instant. */
async function balancesBefore(db: Db, branch: string, before: Date) {
  return new Map(
    (
      await db.query<{ ingredient_id: string; quantity: string; value_minor: string }>(
        `SELECT DISTINCT ON (m.ingredient_id) m.ingredient_id,m.balance_after::text quantity,m.value_after_minor::text value_minor
         FROM bo_stock_movements m JOIN bo_stock_documents d ON d.id=m.document_id AND d.branch_id=m.branch_id
         WHERE m.branch_id=$1 AND d.created_at < $2
         ORDER BY m.ingredient_id,d.created_at DESC,d.id DESC`,
        [branch, before],
      )
    ).rows.map((r) => [
      r.ingredient_id,
      { quantity: BigInt(r.quantity), value: BigInt(r.value_minor) },
    ]),
  );
}

/**
 * The turnover of an Almaty date window (view=movement with the flag): per ingredient
 * opening + every kind (signed) = closing, and opening + in - out = closing where `in` and `out`
 * are the positive and the negative movements. Totals are values only (units differ).
 */
export async function readStockTurnover(
  db: Db,
  branch: string,
  window: { start: Date; end: Date },
) {
  const names = new Map(
    (
      await db.query<{ id: string; payload: Payload }>(
        "SELECT id,payload FROM bo_records WHERE branch_id=$1 AND kind='ingredient'",
        [branch],
      )
    ).rows.map((r) => [r.id, r.payload]),
  );
  const opening = await balancesBefore(db, branch, window.start);
  const recorded = await balancesBefore(db, branch, window.end);
  const moves = (
    await db.query<{
      ingredient_id: string;
      kind: TurnoverKind;
      quantity: string;
      value_minor: string;
      in_quantity: string;
      out_quantity: string;
      in_value: string;
      out_value: string;
    }>(
      `SELECT m.ingredient_id,${KIND_SQL} AS kind,sum(m.quantity_delta)::text quantity,sum(m.value_delta_minor)::text value_minor,
         sum(greatest(m.quantity_delta,0))::text in_quantity,sum(greatest(-m.quantity_delta,0))::text out_quantity,
         sum(greatest(m.value_delta_minor,0))::text in_value,sum(greatest(-m.value_delta_minor,0))::text out_value
       FROM bo_stock_movements m JOIN bo_stock_documents d ON d.id=m.document_id AND d.branch_id=m.branch_id
       WHERE m.branch_id=$1 AND d.created_at >= $2 AND d.created_at < $3
       GROUP BY m.ingredient_id,2`,
      [branch, window.start, window.end],
    )
  ).rows;
  type Acc = Record<
    TurnoverKind | 'opening' | 'in' | 'out' | 'closing',
    { quantity: bigint; value: bigint }
  >;
  const acc = new Map<string, Acc>();
  const row = (id: string) => {
    let a = acc.get(id);
    if (!a) {
      a = Object.fromEntries(
        [...TURNOVER_KINDS, 'opening', 'in', 'out', 'closing'].map((k) => [k, ZERO()]),
      ) as Acc;
      a.opening = { ...(opening.get(id) ?? ZERO()) };
      acc.set(id, a);
    }
    return a;
  };
  for (const [id, b] of opening) if (b.quantity !== 0n || b.value !== 0n) row(id);
  for (const m of moves) {
    const a = row(m.ingredient_id);
    a[m.kind].quantity += BigInt(m.quantity);
    a[m.kind].value += BigInt(m.value_minor);
    a.in.quantity += BigInt(m.in_quantity);
    a.out.quantity += BigInt(m.out_quantity);
    a.in.value += BigInt(m.in_value);
    a.out.value += BigInt(m.out_value);
  }
  const mismatches: string[] = [];
  const rows = [...acc.entries()].map(([id, a]) => {
    a.closing = {
      quantity: TURNOVER_KINDS.reduce((n, k) => n + a[k].quantity, a.opening.quantity),
      value: TURNOVER_KINDS.reduce((n, k) => n + a[k].value, a.opening.value),
    };
    // The chain of cloud017: the balance after the last movement of the window.
    const chain = recorded.get(id) ?? ZERO();
    if (chain.quantity !== a.closing.quantity || chain.value !== a.closing.value)
      mismatches.push(id);
    const p = names.get(id) ?? {};
    return {
      ingredient_id: id,
      name: String(p['name'] ?? ''),
      unit: String(p['unit'] ?? ''),
      opening: out(a.opening),
      ...Object.fromEntries(TURNOVER_KINDS.map((k) => [k, out(a[k])])),
      in: out(a.in),
      out: out(a.out),
      closing: out(a.closing),
    } as {
      ingredient_id: string;
      name: string;
      unit: string;
    } & Record<TurnoverKind | 'opening' | 'in' | 'out' | 'closing', Amount>;
  });
  rows.sort((x, y) =>
    x.name === y.name ? (x.ingredient_id < y.ingredient_id ? -1 : 1) : x.name < y.name ? -1 : 1,
  );
  const listed = rows.slice(0, STOCK_REPORT_ROW_LIMIT);
  const total = (k: keyof Acc) => ({
    value_minor: [...acc.values()].reduce((n, a) => n + a[k].value, 0n).toString(),
  });
  return {
    rows: listed,
    totals: Object.fromEntries(
      (['opening', ...TURNOVER_KINDS, 'in', 'out', 'closing'] as const).map((k) => [k, total(k)]),
    ) as Record<TurnoverKind | 'opening' | 'in' | 'out' | 'closing', { value_minor: string }>,
    mismatches,
    limits: { rows: STOCK_REPORT_ROW_LIMIT },
    truncated: { rows: rows.length > STOCK_REPORT_ROW_LIMIT },
  };
}

/** The Almaty day `days` before `day` (YYYY-MM-DD). */
const dayShift = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/**
 * The use of an ingredient in a window (the reorder hint): what sales wrote off (consumption
 * documents, automatic and manual) and what production used as input, each net of its storno.
 * Waste and counts are not use. A storno counts on the day it was made, like the waste report.
 */
const USE_SQL = (reversals: boolean) => `CASE
    WHEN d.kind='consumption' THEN -m.quantity_delta
    WHEN d.kind='production' AND m.quantity_delta<0 THEN -m.quantity_delta
    ${
      reversals
        ? `WHEN d.kind='reversal' AND o.kind='consumption' THEN -m.quantity_delta
    WHEN d.kind='reversal' AND o.kind='production' AND m.quantity_delta>0 THEN -m.quantity_delta`
        : ''
    }
    ELSE 0 END`;
export type UsePeriod = { days: number; start_date: string | null; end_date: string };

/**
 * The full Almaty days of an average: the `n` days before today; while the sales are written off
 * (mode on) not before the first full day since start_at, so a fresh start does not halve the use.
 */
export function usePeriod(
  today: string,
  n: number,
  consumption: Pick<StockConsumption, 'mode' | 'start_at'>,
): UsePeriod {
  const end = dayShift(today, -1);
  let start = dayShift(today, -n);
  if (consumption.mode === 'on' && consumption.start_at) {
    const at = new Date(consumption.start_at);
    const day = almatyDay(at);
    const midnight = periodWindow({ period: 'custom', start_date: day, end_date: day }, at).start;
    const first = at.getTime() === midnight.getTime() ? day : dayShift(day, 1);
    if (first > start) start = first;
  }
  if (start > end) return { days: 0, start_date: null, end_date: end };
  return {
    days: Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1,
    start_date: start,
    end_date: end,
  };
}

/**
 * The reorder rule (pure, whole numbers only). `use` - the use of each period with its days.
 * rate = the larger average of the periods with days; target = minimum, for meat
 * max(minimum, ceil(3 × rate)); hint = max(0, target - balance); days_left = floor(balance /
 * rate) when the rate is above zero; state `below` (hint > 0), `near` (balance ≤ target + 20 %)
 * or null (not listed).
 */
export function reorderRule(input: {
  balance: bigint;
  minimum: bigint;
  meat: boolean;
  use: readonly { quantity: bigint; days: number }[];
}) {
  let rate: { quantity: bigint; days: number } | null = null;
  for (const u of input.use)
    if (
      u.days > 0 &&
      (rate === null || u.quantity * BigInt(rate.days) > rate.quantity * BigInt(u.days))
    )
      rate = u;
  const used = rate !== null && rate.quantity > 0n ? rate : null;
  const days = used ? BigInt(used.days) : 1n;
  const meatTarget = used ? (BigInt(REORDER_MEAT_DAYS) * used.quantity + days - 1n) / days : null;
  const byUse = input.meat && meatTarget !== null && meatTarget > input.minimum;
  const target = byUse ? meatTarget! : input.minimum;
  const hint = target > input.balance ? target - input.balance : 0n;
  const state =
    target <= 0n
      ? null
      : hint > 0n
        ? ('below' as const)
        : input.balance * 100n <= target * BigInt(100 + REORDER_NEAR_PERCENT)
          ? ('near' as const)
          : null;
  return {
    rate: used ? { quantity: used.quantity.toString(), days: used.days } : null,
    days_left: used ? ((input.balance * days) / used.quantity).toString() : null,
    target: target.toString(),
    target_rule: byUse ? ('meat_days' as const) : ('minimum' as const),
    hint: hint.toString(),
    state,
  };
}

/**
 * GET .../ops/stock?view=reorder: the active ingredients below or near their target (reorderRule)
 * with the use of the last 7 and 14 full days, the suggested quantity and its value at the last
 * purchase price. Without sales written off (`consumption.sales_included` false) the use is that
 * of production only and the cabinet says the numbers are without sales.
 */
export async function readStockReorder(
  db: Db,
  branch: string,
  input: unknown,
  options: BackofficeOptions,
  now: Date,
) {
  parse(StockReorderQuery, input);
  const consumption = await stockConsumption(db, branch, options, now);
  const today = almatyDay(now);
  const reversals = await columnReadable(db, 'bo_stock_documents', 'reverses_document_id');
  const list = await ingredients(db, branch, false);
  const purchases = await lastPurchases(db, branch, reversals);
  const periods = REORDER_USE_DAYS.map((n) => ({ n, ...usePeriod(today, n, consumption) }));
  const use = new Map<string, bigint[]>();
  for (const [i, p] of periods.entries()) {
    if (!p.days || !p.start_date) continue;
    const w = periodWindow(
      { period: 'custom', start_date: p.start_date, end_date: p.end_date },
      now,
    );
    for (const r of (
      await db.query<{ ingredient_id: string; quantity: string }>(
        `SELECT m.ingredient_id,greatest(sum(${USE_SQL(reversals)}),0)::text quantity
         FROM bo_stock_movements m JOIN bo_stock_documents d ON d.id=m.document_id AND d.branch_id=m.branch_id
         ${reversals ? 'LEFT JOIN bo_stock_documents o ON o.id=d.reverses_document_id AND o.branch_id=d.branch_id' : ''}
         WHERE m.branch_id=$1 AND d.created_at >= $2 AND d.created_at < $3
         GROUP BY m.ingredient_id`,
        [branch, w.start, w.end],
      )
    ).rows) {
      const v = use.get(r.ingredient_id) ?? REORDER_USE_DAYS.map(() => 0n);
      v[i] = BigInt(r.quantity);
      use.set(r.ingredient_id, v);
    }
  }
  const rows = list
    .slice(0, STOCK_REPORT_ROW_LIMIT)
    .filter((r) => r.payload['active'] === true)
    .map((r) => {
      const f = facts(r),
        balance = BigInt(r.quantity ?? '0'),
        minimum = BigInt(String(r.payload['minimum'] ?? '0')),
        used = use.get(r.ingredient_id) ?? REORDER_USE_DAYS.map(() => 0n);
      const rule = reorderRule({
        balance,
        minimum,
        meat: f.meat,
        use: periods.map((p, i) => ({ quantity: used[i]!, days: p.days })),
      });
      const purchase = purchases.get(r.ingredient_id);
      return {
        ...f,
        balance: balance.toString(),
        minimum: minimum.toString(),
        use: Object.fromEntries(
          periods.map((p, i) => [`d${p.n}`, { quantity: used[i]!.toString(), days: p.days }]),
        ) as Record<'d7' | 'd14', { quantity: string; days: number }>,
        ...rule,
        last_purchase: purchase ?? null,
        hint_value_minor: rule.hint === '0' ? '0' : atPurchasePrice(BigInt(rule.hint), purchase),
        revision: r.revision ?? 0,
      };
    })
    .filter((r) => r.state !== null);
  const rank = (r: (typeof rows)[number]) => (r.state === 'below' ? 0 : 1);
  rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.days_left === null ? 1 : 0) - (b.days_left === null ? 1 : 0) ||
      (a.days_left !== null && b.days_left !== null
        ? Number(BigInt(a.days_left) - BigInt(b.days_left))
        : 0) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : a.ingredient_id < b.ingredient_id ? -1 : 1),
  );
  return {
    schema_version: 1 as const,
    branch_id: branch,
    view: 'reorder' as const,
    timezone: 'Asia/Almaty' as const,
    as_of: now.toISOString(),
    today,
    rule: {
      meat_days: REORDER_MEAT_DAYS,
      near_percent: REORDER_NEAR_PERCENT,
      use_days: [...REORDER_USE_DAYS],
    },
    periods: Object.fromEntries(
      periods.map((p) => [
        `d${p.n}`,
        { days: p.days, start_date: p.start_date, end_date: p.end_date },
      ]),
    ) as Record<'d7' | 'd14', UsePeriod>,
    rows,
    totals: {
      rows: rows.length,
      below: rows.filter((r) => r.state === 'below').length,
      near: rows.filter((r) => r.state === 'near').length,
      hint_value_minor: rows.reduce((n, r) => n + BigInt(r.hint_value_minor ?? '0'), 0n).toString(),
      unpriced: rows.filter((r) => r.hint !== '0' && r.hint_value_minor === null).length,
    },
    consumption,
    limits: { rows: STOCK_REPORT_ROW_LIMIT },
    truncated: { rows: list.length > STOCK_REPORT_ROW_LIMIT },
  };
}
