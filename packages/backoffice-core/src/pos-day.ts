import { z } from 'zod';
import type { DatabaseClient } from '@pickchick/database';
import { parse, periodWindow } from './model.js';
import { NO_REVENUE_METHODS, SALES_REPORT_METHODS, averageMinor } from './sales-report.js';
import { edgeStaffNames, type EdgeStaffName } from './edge-staff.js';

/**
 * «Касса» of the back office (lane bo-ui, design-bo-ui.md 5.1; iiko-gap P0-1, P0-2, P0-3, P0-5).
 *
 * GET .../ops/pos-day?date=YYYY-MM-DD[&terminal_id=uuid], behind BACKOFFICE_POS_DAY_ENABLED
 * (default off). One Almaty business day of the cashier edge, read only: the cash shifts with
 * their Z, every receipt with its tenders, voids, refunds and Webkassa numbers, the Webkassa
 * totals the accountant compares with the Webkassa cabinet, and the names of the cashier staff.
 *
 * Data: the cloud073 projections the posSales receiver writes (cloud_pos_*, CC-4) and the
 * cashier reports (cloud_cashier_shifts, cloud033) for shifts that have no Z yet. Without the
 * cloud073 tables or SELECT on them the view answers coverage.pos_tables=false with no receipts
 * and no totals (null, never zeros); the shifts of the cashier reports are still listed.
 *
 * How a day is cut (the UI repeats it under «Как считается»):
 * - A cash shift belongs to the Almaty day it was opened, also when it closes after midnight, and
 *   so does every sale of it. A sale whose shift the cloud does not know (no Z, no cashier report)
 *   belongs to its business_date (the Almaty date of the sale).
 * - A void or a refund belongs to the day of the shift it was made in (its own Almaty date when
 *   that shift is unknown), like the Z report of that shift. A refund made today of an earlier
 *   receipt lists that receipt with of_day=false; its money is not in today's sales.
 * - A Webkassa receipt of a sale belongs to the sale's day, the receipt of a refund to the
 *   refund's day.
 * - Sales are every receipt of the day, voided ones included, like the Z report; revenue = sales -
 *   voids - refunds of the day. Staff meals and marketing are never revenue: they are their own
 *   block and their own two methods. A check is a revenue receipt of the day that was not voided
 *   within the day; the average check is their sum / their number, half up, before refunds.
 * Money is whole tiyn in strings; sums are PostgreSQL numeric and BigInt, never floats.
 */

type Db = Pick<DatabaseClient, 'query'>;
type Row = Record<string, unknown>;

/** The cloud073 projections the view reads; all must exist and be readable (else pos_tables=false). */
export const POS_DAY_TABLES = Object.freeze([
  'cloud_pos_sales',
  'cloud_pos_tenders',
  'cloud_pos_refunds',
  'cloud_pos_refund_tenders',
  'cloud_pos_fiscal_receipts',
  'cloud_pos_shift_reports',
]);
/** Receipts of the day, and earlier receipts refunded within it (owner question 4: 2000). */
export const POS_DAY_LIMITS = Object.freeze({ sales: 2000, earlier_sales: 200 });
/** Cashier channels as the sales report names them (hall split by the cashier's service mode). */
export const POS_DAY_CHANNELS = ['hall_dine_in', 'hall_takeaway', 'yandex_eda', 'glovo'] as const;

const calendarDay = z.iso.date().refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return (
    value >= '2000-01-01' &&
    value <= '2099-12-31' &&
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
});
/** One Almaty calendar day and optionally one cash desk; nothing else. */
export const PosDayQuery = z.strictObject({ date: calendarDay, terminal_id: z.uuid().optional() });
export type PosDayQueryInput = z.infer<typeof PosDayQuery>;

/** cloud073 is applied and the current role may read every projection the view needs. */
export async function posDayReadable(db: Db): Promise<boolean> {
  const r = await db.query<{ ok: boolean | null }>(
    `SELECT bool_and(to_regclass(t) IS NOT NULL AND has_table_privilege(current_user, to_regclass(t), 'SELECT')) AS ok
     FROM unnest($1::text[]) t`,
    [POS_DAY_TABLES],
  );
  return r.rows[0]?.ok === true;
}
/** The cashier reports (cloud033) exist and are readable. */
export async function cashierReportsReadable(db: Db): Promise<boolean> {
  const r = await db.query<{ ok: boolean | null }>(
    `SELECT bool_and(to_regclass(t) IS NOT NULL AND has_table_privilege(current_user, to_regclass(t), 'SELECT')) AS ok
     FROM unnest(ARRAY['cloud_cashier_shifts','cloud_cashier_orders']) t`,
  );
  return r.rows[0]?.ok === true;
}

/**
 * `{name}` placeholders to $n with only the values the statement uses (node-postgres refuses a
 * bind with more values than the statement has).
 */
function bind(text: string, values: Record<string, unknown>): [string, unknown[]] {
  const names: string[] = [];
  const out = text.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
    if (!(name in values)) throw new Error(`Unknown parameter ${name}`);
    let index = names.indexOf(name);
    if (index < 0) index = names.push(name) - 1;
    return '$' + (index + 1);
  });
  return [out, names.map((name) => values[name])];
}
const big = (v: unknown) => BigInt(String(v ?? '0'));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null ? null : String(v));
const almatyDate = (v: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(v);
const channelExpression = (s: string) =>
  `CASE WHEN ${s}.sales_channel='hall' THEN 'hall_'||${s}.service_mode ELSE ${s}.sales_channel END`;

export type PosTerminal = { terminal_id: string; label: string; first_seen_at: string | null };
/**
 * The cash desks of the branch with a stable name: «Касса 1», «Касса 2», ... in the order their
 * first shift opened (Z reports and cashier reports); a desk known only from sales comes after.
 * The cloud has no names of cash desks, so this order is what the manager sees in every screen.
 */
export async function posTerminals(
  db: Db,
  branch: string,
  sources: { pos: boolean; cashier: boolean },
  sales?: { from: string; to: string },
): Promise<PosTerminal[]> {
  const parts: string[] = [];
  if (sources.pos)
    parts.push(
      `SELECT terminal_id,min(opened_at) AS first_at,true AS shift FROM cloud_pos_shift_reports WHERE branch_id={branch} GROUP BY terminal_id`,
    );
  if (sources.cashier)
    parts.push(
      `SELECT (payload->>'terminal_id')::uuid,min((payload->>'opened_at')::timestamptz),true FROM cloud_cashier_shifts WHERE branch_id={branch} GROUP BY 1`,
    );
  if (sources.pos && sales)
    parts.push(
      `SELECT terminal_id,min(sold_at),false FROM cloud_pos_sales WHERE branch_id={branch} AND business_date BETWEEN {from}::date AND {to}::date GROUP BY terminal_id`,
    );
  if (!parts.length) return [];
  const [text, args] = bind(
    `SELECT terminal_id::text AS terminal_id,min(first_at) AS first_at,bool_or(shift) AS shift
     FROM (${parts.join(' UNION ALL ')}) t(terminal_id,first_at,shift) WHERE terminal_id IS NOT NULL
     GROUP BY terminal_id ORDER BY bool_or(shift) DESC,min(first_at),terminal_id`,
    { branch, from: sales?.from ?? null, to: sales?.to ?? null },
  );
  const rows = (await db.query<{ terminal_id: string; first_at: Date | null }>(text, args)).rows;
  return rows.map((r, i) => ({
    terminal_id: r.terminal_id,
    label: `Касса ${i + 1}`,
    first_seen_at: r.first_at ? r.first_at.toISOString() : null,
  }));
}

type Line = { name: string; quantity: number; unit_price_minor: string; total_minor: string };
/** QuoteLine[] of the sale, with Russian names only (the receipt card). */
function compactLines(value: unknown) {
  const lines = Array.isArray(value) ? (value as Row[]) : [];
  return lines.map((l) => {
    const name = l['name'] && typeof l['name'] === 'object' ? (l['name'] as Row)['ru'] : l['name'];
    const modifiers = Array.isArray(l['modifiers']) ? (l['modifiers'] as Row[]) : [];
    return {
      name: String(name ?? ''),
      quantity: Number(l['quantity'] ?? 1),
      unit_price_minor: String(l['unit_price_minor'] ?? '0'),
      total_minor: String(l['total_minor'] ?? '0'),
      modifiers: modifiers.map((m) => ({
        group: String(
          (m['group_name'] && typeof m['group_name'] === 'object'
            ? (m['group_name'] as Row)['ru']
            : m['group_name']) ?? '',
        ),
        name: String(
          (m['name'] && typeof m['name'] === 'object' ? (m['name'] as Row)['ru'] : m['name']) ?? '',
        ),
        quantity: Number(m['quantity'] ?? 1),
        price_minor: String(m['price_minor'] ?? '0'),
      })),
    } satisfies Line & { modifiers: unknown[] };
  });
}

const methodRank = (method: unknown) =>
  (SALES_REPORT_METHODS as readonly unknown[]).indexOf(method);
const SALE_COLUMNS = `s.order_id::text AS order_id,s.display_number,s.terminal_id::text AS terminal_id,
  s.shift_id::text AS shift_id,s.device_id::text AS device_id,s.cashier_staff_id::text AS cashier_staff_id,
  s.sold_at,s.business_date::text AS business_date,s.sales_channel,s.service_mode,s.revenue_kind,
  s.external_order_ref,s.subtotal_minor::text AS subtotal_minor,s.discount_minor::text AS discount_minor,
  s.total_minor::text AS total_minor,s.cash_tendered_minor::text AS cash_tendered_minor,
  s.change_minor::text AS change_minor,s.state,s.voided_at,s.beneficiary,s.reason,
  s.approval_manager_staff_id::text AS approval_manager_staff_id,s.lines,s.received_at`;

/**
 * Receipt cards of `orderIds` (tenders, voids and refunds with their parts, Webkassa receipts).
 * `inDayRefunds`: refund ids that belong to the viewed day (others are of another day).
 */
export async function posSaleCards(
  db: Db,
  branch: string,
  orderIds: string[],
  options: { inDayRefunds?: Set<string>; ofDay?: Set<string> } = {},
) {
  if (!orderIds.length) return [];
  const sales = (
    await db.query<Row>(
      `SELECT ${SALE_COLUMNS} FROM cloud_pos_sales s WHERE s.branch_id=$1 AND s.order_id=ANY($2::uuid[])`,
      [branch, orderIds],
    )
  ).rows;
  const tenders = (
    await db.query<Row>(
      `SELECT tender_id::text AS tender_id,order_id::text AS order_id,method,amount_minor::text AS amount_minor,
        confirmation,reference FROM cloud_pos_tenders WHERE branch_id=$1 AND order_id=ANY($2::uuid[])
       ORDER BY order_id,created_at,tender_id`,
      [branch, orderIds],
    )
  ).rows;
  const refunds = (
    await db.query<Row>(
      `SELECT r.refund_id::text AS refund_id,r.order_id::text AS order_id,r.kind,r.amount_minor::text AS amount_minor,
        r.reason_code,r.reason,r.staff_id::text AS staff_id,r.approved_by_staff_id::text AS approved_by_staff_id,
        r.shift_id::text AS shift_id,r.terminal_id::text AS terminal_id,r.created_at,
        coalesce((SELECT jsonb_agg(jsonb_build_object('tender_id',p.tender_id,'method',p.method,
          'amount_minor',p.amount_minor::text) ORDER BY p.method,p.tender_id)
          FROM cloud_pos_refund_tenders p WHERE p.refund_id=r.refund_id AND p.branch_id=r.branch_id),'[]'::jsonb) AS tenders
       FROM cloud_pos_refunds r WHERE r.branch_id=$1 AND r.order_id=ANY($2::uuid[])
       ORDER BY r.order_id,r.created_at,r.refund_id`,
      [branch, orderIds],
    )
  ).rows;
  const fiscal = (
    await db.query<Row>(
      `SELECT receipt_id::text AS receipt_id,order_id::text AS order_id,kind,refund_id::text AS refund_id,state,
        receipt_number,version,amount_minor::text AS amount_minor,recorded_by_staff_id::text AS recorded_by_staff_id,
        recorded_at FROM cloud_pos_fiscal_receipts WHERE branch_id=$1 AND order_id=ANY($2::uuid[])
       ORDER BY order_id,kind DESC,receipt_id`,
      [branch, orderIds],
    )
  ).rows;
  const by = (rows: Row[]) => {
    const map = new Map<string, Row[]>();
    for (const row of rows) {
      const key = String(row['order_id']);
      map.set(key, [...(map.get(key) ?? []), row]);
    }
    return map;
  };
  const tenderMap = by(tenders),
    refundMap = by(refunds),
    fiscalMap = by(fiscal);
  const order = new Map(orderIds.map((id, i) => [id.toLowerCase(), i]));
  return sales
    .sort(
      (a, b) => (order.get(String(a['order_id'])) ?? 0) - (order.get(String(b['order_id'])) ?? 0),
    )
    .map((s) => {
      const id = String(s['order_id']);
      const saleRefunds = (refundMap.get(id) ?? []).map((r) => ({
        refund_id: String(r['refund_id']),
        kind: r['kind'] as 'void' | 'refund',
        amount_minor: String(r['amount_minor']),
        reason_code: r['reason_code'],
        reason: r['reason'],
        staff_id: r['staff_id'],
        approved_by_staff_id: r['approved_by_staff_id'],
        shift_id: r['shift_id'],
        terminal_id: r['terminal_id'] ?? null,
        created_at: iso(r['created_at']),
        in_day: options.inDayRefunds ? options.inDayRefunds.has(String(r['refund_id'])) : true,
        tenders: r['tenders'] as Row[],
      }));
      return {
        order_id: id,
        display_number: s['display_number'],
        terminal_id: s['terminal_id'],
        shift_id: s['shift_id'],
        device_id: s['device_id'],
        cashier_staff_id: s['cashier_staff_id'],
        sold_at: iso(s['sold_at']),
        business_date: s['business_date'],
        of_day: options.ofDay ? options.ofDay.has(id) : true,
        sales_channel: s['sales_channel'],
        service_mode: s['service_mode'],
        channel:
          s['sales_channel'] === 'hall' ? `hall_${String(s['service_mode'])}` : s['sales_channel'],
        revenue_kind: s['revenue_kind'],
        external_order_ref: s['external_order_ref'] ?? null,
        subtotal_minor: s['subtotal_minor'],
        discount_minor: s['discount_minor'],
        total_minor: s['total_minor'],
        cash_tendered_minor: s['cash_tendered_minor'] ?? null,
        change_minor: s['change_minor'] ?? null,
        state: s['state'] as 'paid' | 'voided',
        voided_at: iso(s['voided_at'] ?? null),
        beneficiary: s['beneficiary'] ?? null,
        reason: s['reason'] ?? null,
        approval_manager_staff_id: s['approval_manager_staff_id'] ?? null,
        lines: compactLines(s['lines']),
        // The cloud has no tender order: the owner's method order, then the tender id.
        tenders: [...(tenderMap.get(id) ?? [])]
          .sort(
            (a, b) =>
              methodRank(a['method']) - methodRank(b['method']) ||
              String(a['tender_id']).localeCompare(String(b['tender_id'])),
          )
          .map((t) => ({
            tender_id: t['tender_id'],
            method: t['method'],
            amount_minor: t['amount_minor'],
            confirmation: t['confirmation'],
            reference: t['reference'] ?? null,
          })),
        refunds: saleRefunds,
        refunded_minor: saleRefunds.reduce((a, r) => a + big(r.amount_minor), 0n).toString(),
        fiscal: (fiscalMap.get(id) ?? []).map((f) => ({
          receipt_id: f['receipt_id'],
          kind: f['kind'] as 'sale' | 'refund',
          refund_id: f['refund_id'] ?? null,
          state: f['state'] as 'pending' | 'recorded' | 'not_required',
          receipt_number: f['receipt_number'] ?? null,
          version: f['version'],
          amount_minor: f['amount_minor'],
          recorded_by_staff_id: f['recorded_by_staff_id'] ?? null,
          recorded_at: iso(f['recorded_at'] ?? null),
          in_day:
            f['kind'] === 'sale'
              ? options.ofDay
                ? options.ofDay.has(id)
                : true
              : options.inDayRefunds
                ? options.inDayRefunds.has(String(f['refund_id']))
                : true,
        })),
      };
    });
}
export type PosSaleCard = Awaited<ReturnType<typeof posSaleCards>>[number];

/** Every staff id a list of cards and shifts mentions (for the name map). */
export function staffIds(
  cards: PosSaleCard[],
  shifts: { opened_by_staff_id: unknown; cashier_staff_ids?: string[] }[] = [],
) {
  const ids: unknown[] = shifts.flatMap((s) => [
    s.opened_by_staff_id,
    ...(s.cashier_staff_ids ?? []),
  ]);
  for (const c of cards) {
    ids.push(c.cashier_staff_id, c.approval_manager_staff_id);
    for (const r of c.refunds) ids.push(r.staff_id, r.approved_by_staff_id);
    for (const f of c.fiscal) ids.push(f.recorded_by_staff_id);
  }
  return ids.filter((v): v is string => typeof v === 'string');
}
/** Names of edge staff ids from the employee cards of the branch (edge-staff.ts). */
export async function posStaffNames(
  db: Db,
  branch: string,
  ids: string[],
): Promise<Record<string, EdgeStaffName>> {
  if (!ids.length) return {};
  const employees = (
    await db.query<{ id: string; name: string }>(
      `SELECT id::text AS id,payload->>'name' AS name FROM bo_records WHERE branch_id=$1 AND kind='employee'
       ORDER BY updated_at,id`,
      [branch],
    )
  ).rows;
  return edgeStaffNames(employees, ids);
}

type Money = { count: number; amount: bigint };
const zero = (): Money => ({ count: 0, amount: 0n });
type ShiftAgg = {
  sales_count: number;
  voided_count: number;
  sales_minor: bigint;
  refunds_minor: bigint;
  methods: Map<string, { count: number; sales: bigint; refunds: bigint }>;
  fiscal: { pending: number; recorded: number; not_required: number };
  cashiers: Set<string>;
};

/** GET .../ops/pos-day (see the module comment). `now` is the as_of instant. */
export async function readPosDay(db: Db, branch: string, input: unknown, now: Date) {
  const q = parse(PosDayQuery, input);
  const terminal = q.terminal_id?.toLowerCase() ?? null;
  const { start, end } = periodWindow(
    { period: 'custom', start_date: q.date, end_date: q.date },
    now,
  );
  const pos = await posDayReadable(db);
  const cashier = await cashierReportsReadable(db);
  const rows = async <T = Row>(text: string, values: Record<string, unknown>) => {
    const [sql, args] = bind(text, values);
    return (await db.query(sql, args)).rows as T[];
  };

  // 1. Known shifts opened this day: frozen Z reports and the cashier reports of the edge.
  type Known = {
    shift_id: string;
    terminal_id: string | null;
    device_id: string | null;
    opened_at: Date | null;
    closed_at: Date | null;
    z: Row | null;
    z_received_at: Date | null;
    cashier: Row | null;
    cashier_observed_at: Date | null;
  };
  const known = new Map<string, Known>();
  if (pos)
    for (const z of await rows<Row>(
      `SELECT shift_id::text AS shift_id,terminal_id::text AS terminal_id,device_id::text AS device_id,opened_at,
         closed_at,report,received_at FROM cloud_pos_shift_reports
       WHERE branch_id={branch} AND closed_at >= {start} AND (opened_at AT TIME ZONE 'Asia/Almaty')::date={day}::date`,
      { branch, start, day: q.date },
    ))
      known.set(String(z['shift_id']), {
        shift_id: String(z['shift_id']),
        terminal_id: String(z['terminal_id']),
        device_id: String(z['device_id']),
        opened_at: z['opened_at'] as Date,
        closed_at: z['closed_at'] as Date,
        z: z['report'] as Row,
        z_received_at: z['received_at'] as Date,
        cashier: null,
        cashier_observed_at: null,
      });
  if (cashier)
    for (const c of await rows<Row>(
      `SELECT id::text AS shift_id,device_id::text AS device_id,payload,observed_at FROM cloud_cashier_shifts
       WHERE branch_id={branch} AND ((payload->>'opened_at')::timestamptz AT TIME ZONE 'Asia/Almaty')::date={day}::date`,
      { branch, day: q.date },
    )) {
      const p = c['payload'] as Row;
      const id = String(c['shift_id']);
      const prior = known.get(id);
      known.set(id, {
        shift_id: id,
        terminal_id:
          prior?.terminal_id ?? (typeof p['terminal_id'] === 'string' ? p['terminal_id'] : null),
        device_id: prior?.device_id ?? String(c['device_id']),
        opened_at: prior?.opened_at ?? new Date(String(p['opened_at'])),
        closed_at:
          prior?.closed_at ??
          (typeof p['closed_at'] === 'string' ? new Date(p['closed_at']) : null),
        z: prior?.z ?? null,
        z_received_at: prior?.z_received_at ?? null,
        cashier: p,
        cashier_observed_at: c['observed_at'] as Date,
      });
    }
  const dayKnown = [...known.values()].filter((k) => !terminal || k.terminal_id === terminal);
  const dayKnownIds = dayKnown.map((k) => k.shift_id);
  // The last Almaty day a shift of this day can have sales or refunds on.
  let upper = q.date;
  for (const k of dayKnown) {
    const last = k.closed_at ?? (k.z || k.cashier?.['state'] === 'closed' ? k.opened_at : now);
    if (last) {
      const d = almatyDate(last);
      if (d > upper) upper = d;
    }
  }
  const upperEnd = periodWindow({ period: 'custom', start_date: q.date, end_date: upper }, now).end;
  const values = {
    branch,
    day: q.date,
    upper,
    shifts: dayKnownIds,
    start,
    end: upperEnd,
    terminal,
  };
  const knownShift = (col: string) =>
    `(EXISTS(SELECT 1 FROM cloud_pos_shift_reports kz WHERE kz.shift_id=${col} AND kz.branch_id={branch})` +
    (cashier
      ? ` OR EXISTS(SELECT 1 FROM cloud_cashier_shifts kc WHERE kc.id=${col} AND kc.branch_id={branch}))`
      : ')');
  const daySale = (
    s: string,
  ) => `(${s}.branch_id={branch} AND ${s}.business_date BETWEEN {day}::date AND {upper}::date
    AND (${s}.shift_id=ANY({shifts}::uuid[]) OR (${s}.business_date={day}::date AND NOT ${knownShift(`${s}.shift_id`)}))
    AND ({terminal}::uuid IS NULL OR ${s}.terminal_id={terminal}::uuid))`;
  const dayRefund = (
    r: string,
    s: string,
  ) => `(${r}.branch_id={branch} AND ${r}.created_at >= {start} AND ${r}.created_at < {end}
    AND (${r}.shift_id=ANY({shifts}::uuid[]) OR ((${r}.created_at AT TIME ZONE 'Asia/Almaty')::date={day}::date
      AND NOT ${knownShift(`${r}.shift_id`)}
      AND ({terminal}::uuid IS NULL OR coalesce(${r}.terminal_id,${s}.terminal_id)={terminal}::uuid))))`;

  // 2. Aggregates over the whole day (never over the truncated list).
  const shiftAgg = new Map<string, ShiftAgg>();
  const shiftOf = (id: string) => {
    let v = shiftAgg.get(id);
    if (!v)
      shiftAgg.set(
        id,
        (v = {
          sales_count: 0,
          voided_count: 0,
          sales_minor: 0n,
          refunds_minor: 0n,
          methods: new Map(),
          fiscal: { pending: 0, recorded: 0, not_required: 0 },
          cashiers: new Set(),
        }),
      );
    return v;
  };
  const shiftTerminal = new Map<string, string>();
  const channels = new Map<
    string,
    { checks: number; checks_minor: bigint; sales: bigint; voids: bigint; refunds: bigint }
  >();
  const channelOf = (code: string) => {
    let v = channels.get(code);
    if (!v)
      channels.set(code, (v = { checks: 0, checks_minor: 0n, sales: 0n, voids: 0n, refunds: 0n }));
    return v;
  };
  const noRevenue = new Map<
    string,
    { checks: number; sales: bigint; voids: bigint; refunds: bigint }
  >();
  const noRevenueOf = (kind: string) => {
    let v = noRevenue.get(kind);
    if (!v) noRevenue.set(kind, (v = { checks: 0, sales: 0n, voids: 0n, refunds: 0n }));
    return v;
  };
  const methods = new Map<
    string,
    { payments: number; sales: bigint; voids: bigint; refunds: bigint }
  >();
  const methodOf = (code: string) => {
    let v = methods.get(code);
    if (!v) methods.set(code, (v = { payments: 0, sales: 0n, voids: 0n, refunds: 0n }));
    return v;
  };
  let salesCount = 0,
    voidedCount = 0;
  const fiscalSummary = {
    pending: zero(),
    recorded: { count: 0, sales: 0n, refunds: 0n },
    not_required: zero(),
    not_required_methods: new Map<string, Money>(),
  };
  let listed: PosSaleCard[] = [];
  let truncated = { sales: false, earlier_sales: false };
  let lastReceived: Date | null = null;
  if (pos) {
    for (const r of await rows<{
      shift_id: string;
      terminal_id: string;
      channel: string;
      revenue_kind: string;
      voided_in_day: boolean;
      n: number;
      total: string;
    }>(
      `SELECT s.shift_id::text AS shift_id,s.terminal_id::text AS terminal_id,${channelExpression('s')} AS channel,
         s.revenue_kind,v.voided_in_day,count(*)::int AS n,sum(s.total_minor)::text AS total
       FROM cloud_pos_sales s CROSS JOIN LATERAL (SELECT EXISTS(SELECT 1 FROM cloud_pos_refunds r
         WHERE r.order_id=s.order_id AND r.branch_id=s.branch_id AND r.kind='void' AND ${dayRefund('r', 's')}) AS voided_in_day) v
       WHERE ${daySale('s')} GROUP BY 1,2,3,4,5`,
      values,
    )) {
      const total = big(r.total);
      salesCount += r.n;
      if (r.voided_in_day) voidedCount += r.n;
      const shift = shiftOf(r.shift_id);
      shiftTerminal.set(r.shift_id, r.terminal_id);
      shift.sales_count += r.n;
      shift.sales_minor += total;
      if (r.voided_in_day) shift.voided_count += r.n;
      if (r.revenue_kind === 'revenue') {
        const c = channelOf(r.channel);
        c.sales += total;
        if (!r.voided_in_day) {
          c.checks += r.n;
          c.checks_minor += total;
        }
      } else {
        const k = noRevenueOf(r.revenue_kind);
        k.sales += total;
        if (!r.voided_in_day) k.checks += r.n;
      }
    }
    for (const r of await rows<{ shift_id: string; cashier: string }>(
      `SELECT DISTINCT s.shift_id::text AS shift_id,s.cashier_staff_id::text AS cashier FROM cloud_pos_sales s
       WHERE ${daySale('s')}`,
      values,
    ))
      shiftOf(r.shift_id).cashiers.add(r.cashier);
    for (const r of await rows<{ shift_id: string; method: string; n: number; amount: string }>(
      `SELECT s.shift_id::text AS shift_id,t.method,count(*)::int AS n,sum(t.amount_minor)::text AS amount
       FROM cloud_pos_tenders t JOIN cloud_pos_sales s ON s.order_id=t.order_id AND s.branch_id=t.branch_id
       WHERE ${daySale('s')} GROUP BY 1,2`,
      values,
    )) {
      const m = methodOf(r.method);
      m.payments += r.n;
      m.sales += big(r.amount);
      const sm = shiftOf(r.shift_id).methods;
      const v = sm.get(r.method) ?? { count: 0, sales: 0n, refunds: 0n };
      v.count += r.n;
      v.sales += big(r.amount);
      sm.set(r.method, v);
    }
    for (const r of await rows<{
      shift_id: string;
      terminal_id: string | null;
      kind: string;
      revenue_kind: string;
      channel: string;
      amount: string;
    }>(
      `SELECT r.shift_id::text AS shift_id,coalesce(r.terminal_id,s.terminal_id)::text AS terminal_id,r.kind,
         s.revenue_kind,${channelExpression('s')} AS channel,sum(r.amount_minor)::text AS amount
       FROM cloud_pos_refunds r JOIN cloud_pos_sales s ON s.order_id=r.order_id AND s.branch_id=r.branch_id
       WHERE ${dayRefund('r', 's')} GROUP BY 1,2,3,4,5`,
      values,
    )) {
      const amount = big(r.amount);
      const shift = shiftOf(r.shift_id);
      if (r.terminal_id && !shiftTerminal.has(r.shift_id))
        shiftTerminal.set(r.shift_id, r.terminal_id);
      shift.refunds_minor += amount;
      const bucket =
        r.revenue_kind === 'revenue' ? channelOf(r.channel) : noRevenueOf(r.revenue_kind);
      if (r.kind === 'void') bucket.voids += amount;
      else bucket.refunds += amount;
    }
    for (const r of await rows<{ shift_id: string; kind: string; method: string; amount: string }>(
      `SELECT r.shift_id::text AS shift_id,r.kind,p.method,sum(p.amount_minor)::text AS amount
       FROM cloud_pos_refund_tenders p JOIN cloud_pos_refunds r ON r.refund_id=p.refund_id AND r.branch_id=p.branch_id
       JOIN cloud_pos_sales s ON s.order_id=r.order_id AND s.branch_id=r.branch_id
       WHERE ${dayRefund('r', 's')} GROUP BY 1,2,3`,
      values,
    )) {
      const amount = big(r.amount);
      const m = methodOf(r.method);
      if (r.kind === 'void') m.voids += amount;
      else m.refunds += amount;
      const sm = shiftOf(r.shift_id).methods;
      const v = sm.get(r.method) ?? { count: 0, sales: 0n, refunds: 0n };
      v.refunds += amount;
      sm.set(r.method, v);
    }
    // Webkassa receipts of the day: of its sales, and of its refunds.
    const receiptRows = [
      ...(await rows<Row>(
        `SELECT s.shift_id::text AS shift_id,f.kind,f.state,count(*)::int AS n,sum(f.amount_minor)::text AS amount,
           m.method
         FROM cloud_pos_sales s JOIN cloud_pos_fiscal_receipts f ON f.order_id=s.order_id AND f.branch_id=s.branch_id
           AND f.kind='sale'
         CROSS JOIN LATERAL (SELECT min(t.method) AS method FROM cloud_pos_tenders t
           WHERE t.order_id=s.order_id AND t.branch_id=s.branch_id) m
         WHERE ${daySale('s')} GROUP BY 1,2,3,6`,
        values,
      )),
      ...(await rows<Row>(
        `SELECT r.shift_id::text AS shift_id,f.kind,f.state,count(*)::int AS n,sum(f.amount_minor)::text AS amount,
           m.method
         FROM cloud_pos_refunds r JOIN cloud_pos_sales s ON s.order_id=r.order_id AND s.branch_id=r.branch_id
         JOIN cloud_pos_fiscal_receipts f ON f.branch_id=r.branch_id AND f.order_id=r.order_id AND f.refund_id=r.refund_id
         CROSS JOIN LATERAL (SELECT min(t.method) AS method FROM cloud_pos_tenders t
           WHERE t.order_id=s.order_id AND t.branch_id=s.branch_id) m
         WHERE ${dayRefund('r', 's')} GROUP BY 1,2,3,6`,
        values,
      )),
    ];
    for (const r of receiptRows) {
      const n = Number(r['n']),
        amount = big(r['amount']),
        state = String(r['state']) as 'pending' | 'recorded' | 'not_required';
      shiftOf(String(r['shift_id'])).fiscal[state] += n;
      if (state === 'pending') {
        fiscalSummary.pending.count += n;
        fiscalSummary.pending.amount += amount;
      } else if (state === 'recorded') {
        fiscalSummary.recorded.count += n;
        if (r['kind'] === 'refund') fiscalSummary.recorded.refunds += amount;
        else fiscalSummary.recorded.sales += amount;
      } else {
        fiscalSummary.not_required.count += n;
        fiscalSummary.not_required.amount += amount;
        const method = String(r['method'] ?? 'unknown');
        const m = fiscalSummary.not_required_methods.get(method) ?? zero();
        m.count += n;
        m.amount += amount;
        fiscalSummary.not_required_methods.set(method, m);
      }
    }

    // 3. The receipts of the day (newest first) and earlier receipts refunded within it.
    const dayIds = await rows<{ order_id: string }>(
      `SELECT s.order_id::text AS order_id FROM cloud_pos_sales s WHERE ${daySale('s')}
       ORDER BY s.sold_at DESC,s.order_id LIMIT ${POS_DAY_LIMITS.sales + 1}`,
      values,
    );
    const earlierIds = await rows<{ order_id: string }>(
      `SELECT s.order_id::text AS order_id FROM cloud_pos_sales s WHERE s.branch_id={branch}
         AND s.order_id IN (SELECT r.order_id FROM cloud_pos_refunds r JOIN cloud_pos_sales s2
           ON s2.order_id=r.order_id AND s2.branch_id=r.branch_id WHERE ${dayRefund('r', 's2')})
         AND NOT ${daySale('s')}
       ORDER BY s.sold_at DESC,s.order_id LIMIT ${POS_DAY_LIMITS.earlier_sales + 1}`,
      values,
    );
    truncated = {
      sales: dayIds.length > POS_DAY_LIMITS.sales,
      earlier_sales: earlierIds.length > POS_DAY_LIMITS.earlier_sales,
    };
    const ofDay = dayIds.slice(0, POS_DAY_LIMITS.sales).map((r) => r.order_id);
    const earlier = earlierIds.slice(0, POS_DAY_LIMITS.earlier_sales).map((r) => r.order_id);
    const inDayRefunds = new Set(
      (
        await rows<{ refund_id: string }>(
          `SELECT r.refund_id::text AS refund_id FROM cloud_pos_refunds r JOIN cloud_pos_sales s
             ON s.order_id=r.order_id AND s.branch_id=r.branch_id
           WHERE ${dayRefund('r', 's')} AND r.order_id=ANY({ids}::uuid[])`,
          { ...values, ids: [...ofDay, ...earlier] },
        )
      ).map((r) => r.refund_id),
    );
    listed = await posSaleCards(db, branch, [...ofDay, ...earlier], {
      inDayRefunds,
      ofDay: new Set(ofDay),
    });
    const received = (
      await rows<{ at: Date | null }>(
        `SELECT greatest((SELECT max(received_at) FROM cloud_pos_sales WHERE branch_id={branch}),
          (SELECT max(received_at) FROM cloud_pos_shift_reports WHERE branch_id={branch})) AS at`,
        { branch },
      )
    )[0]?.at;
    lastReceived = received ?? null;
    // Every posSales event (voids, refunds, Webkassa numbers too), when this role may read the inbox.
    if (
      (
        await db.query<{ ok: boolean }>(
          `SELECT to_regclass('cloud_pos_sale_inbox') IS NOT NULL
             AND has_table_privilege(current_user, to_regclass('cloud_pos_sale_inbox'), 'SELECT') AS ok`,
        )
      ).rows[0]?.ok
    ) {
      const inbox = (
        await rows<{ at: Date | null }>(
          `SELECT max((SELECT i.received_at FROM cloud_pos_sale_inbox i WHERE i.device_id=d.id
             ORDER BY i.sequence DESC LIMIT 1)) AS at FROM devices d WHERE d.branch_id={branch} AND d.kind='edge'`,
          { branch },
        )
      )[0]?.at;
      if (inbox && (!lastReceived || inbox > lastReceived)) lastReceived = inbox;
    }
  }
  const cashierAt = cashier
    ? ((
        await rows<{ at: Date | null }>(
          `SELECT greatest((SELECT max(observed_at) FROM cloud_cashier_orders WHERE branch_id={branch}),
            (SELECT max(observed_at) FROM cloud_cashier_shifts WHERE branch_id={branch})) AS at`,
          { branch },
        )
      )[0]?.at ?? null)
    : null;

  // 4. Shifts: known ones of the day, then shifts the cloud knows only from sales or refunds.
  const methodRows = (agg: ShiftAgg | undefined) =>
    SALES_REPORT_METHODS.map((method) => {
      const v = agg?.methods.get(method);
      return {
        method,
        count: v?.count ?? 0,
        sales_minor: (v?.sales ?? 0n).toString(),
        refunds_minor: (v?.refunds ?? 0n).toString(),
      };
    });
  const shiftView = (id: string, k: Known | null) => {
    const agg = shiftAgg.get(id);
    const z = k?.z ?? null;
    const c = k?.cashier ?? null;
    const cash = z
      ? {
          opening_cash_minor: String(z['opening_cash_minor']),
          cash_in_minor: String(z['cash_in_minor']),
          cash_out_minor: String(z['cash_out_minor']),
          cash_sales_minor: String(z['cash_sales_minor']),
          cash_refunds_minor: String(z['cash_refunds_minor']),
          expected_cash_minor: String(z['expected_cash_minor']),
          counted_cash_minor: (z['counted_cash_minor'] as string | null) ?? null,
          discrepancy_minor: (z['discrepancy_minor'] as string | null) ?? null,
        }
      : c
        ? {
            opening_cash_minor: String(c['opening_cash_minor']),
            cash_in_minor: String(c['cash_in_minor']),
            cash_out_minor: String(c['cash_out_minor']),
            cash_sales_minor: (c['cash_sales_minor'] as string | undefined) ?? null,
            cash_refunds_minor: (c['cash_refunds_minor'] as string | undefined) ?? null,
            expected_cash_minor: String(c['expected_cash_minor']),
            counted_cash_minor: (c['counted_cash_minor'] as string | null) ?? null,
            discrepancy_minor: (c['discrepancy_minor'] as string | null) ?? null,
          }
        : null;
    const terminalSales = agg?.methods.get('kaspi_terminal');
    const terminalNet = ((terminalSales?.sales ?? 0n) - (terminalSales?.refunds ?? 0n)).toString();
    const reported = z ? ((z['terminal_reported_minor'] as string | null) ?? null) : null;
    const state: 'open' | 'closed' | 'unknown' = z
      ? 'closed'
      : c
        ? c['state'] === 'closed'
          ? 'closed'
          : 'open'
        : 'unknown';
    const fiscal = agg?.fiscal ?? { pending: 0, recorded: 0, not_required: 0 };
    return {
      shift_id: id,
      terminal_id: k?.terminal_id ?? shiftTerminal.get(id) ?? null,
      device_id: k?.device_id ?? null,
      source: z ? ('z' as const) : c ? ('cashier_report' as const) : ('sales' as const),
      state,
      opened_at: k?.opened_at ? k.opened_at.toISOString() : null,
      closed_at: k?.closed_at ? k.closed_at.toISOString() : null,
      opened_by_staff_id: c && typeof c['staff_id'] === 'string' ? c['staff_id'] : null,
      cashier_staff_ids: [...(agg?.cashiers ?? [])].sort(),
      cash,
      terminal: {
        expected_minor: terminalNet,
        reported_minor: reported,
        discrepancy_minor: z ? ((z['terminal_discrepancy_minor'] as string | null) ?? null) : null,
      },
      z,
      z_received_at: k?.z_received_at ? k.z_received_at.toISOString() : null,
      cashier_report_at: k?.cashier_observed_at ? k.cashier_observed_at.toISOString() : null,
      received: {
        sales_count: agg?.sales_count ?? 0,
        voided_count: agg?.voided_count ?? 0,
        sales_minor: (agg?.sales_minor ?? 0n).toString(),
        refunds_minor: (agg?.refunds_minor ?? 0n).toString(),
        methods: methodRows(agg),
      },
      fiscal,
      flags: {
        cash_discrepancy: cash?.discrepancy_minor != null && big(cash.discrepancy_minor) !== 0n,
        terminal_discrepancy:
          z?.['terminal_discrepancy_minor'] != null && big(z['terminal_discrepancy_minor']) !== 0n,
        fiscal_pending: fiscal.pending,
      },
    };
  };
  const shifts = [
    ...dayKnown.map((k) => shiftView(k.shift_id, k)),
    ...[...shiftAgg.keys()].filter((id) => !known.has(id)).map((id) => shiftView(id, null)),
  ].sort(
    (a, b) =>
      (a.opened_at ?? '9').localeCompare(b.opened_at ?? '9') ||
      String(a.terminal_id).localeCompare(String(b.terminal_id)) ||
      a.shift_id.localeCompare(b.shift_id),
  );

  const terminals = await posTerminals(
    db,
    branch,
    { pos, cashier },
    pos ? { from: q.date, to: upper } : undefined,
  );
  const staff = await posStaffNames(db, branch, staffIds(listed, shifts));

  // 5. Day totals (revenue only) by channel and method; staff meals and marketing apart.
  const channelRows = POS_DAY_CHANNELS.map((code) => {
    const v = channelOf(code);
    return {
      channel: code,
      checks: v.checks,
      sales_minor: v.sales.toString(),
      voids_minor: v.voids.toString(),
      refunds_minor: v.refunds.toString(),
      revenue_minor: (v.sales - v.voids - v.refunds).toString(),
      average_check_minor: averageMinor(v.checks_minor, v.checks),
    };
  });
  const sum = (key: 'sales' | 'voids' | 'refunds' | 'checks_minor') =>
    POS_DAY_CHANNELS.reduce((a, code) => a + channelOf(code)[key], 0n);
  const checks = POS_DAY_CHANNELS.reduce((a, code) => a + channelOf(code).checks, 0);
  const kinds = NO_REVENUE_METHODS.map((kind) => {
    const v = noRevenueOf(kind);
    return {
      revenue_kind: kind,
      checks: v.checks,
      total_minor: (v.sales - v.voids - v.refunds).toString(),
    };
  });
  return {
    schema_version: 1 as const,
    branch_id: branch,
    view: 'pos-day' as const,
    date: q.date,
    terminal_id: terminal,
    timezone: 'Asia/Almaty' as const,
    day_start: start.toISOString(),
    day_end: end.toISOString(),
    as_of: now.toISOString(),
    coverage: {
      pos_tables: pos,
      cashier_reports: cashier,
      last_received_at: lastReceived ? lastReceived.toISOString() : null,
      cashier_reports_at: cashierAt ? cashierAt.toISOString() : null,
    },
    terminals,
    shifts,
    totals: pos
      ? {
          sales_count: salesCount,
          voided_count: voidedCount,
          checks,
          sales_minor: sum('sales').toString(),
          voids_minor: sum('voids').toString(),
          refunds_minor: sum('refunds').toString(),
          revenue_minor: (sum('sales') - sum('voids') - sum('refunds')).toString(),
          average_check_minor: averageMinor(sum('checks_minor'), checks),
          no_revenue: {
            checks: kinds.reduce((a, k) => a + k.checks, 0),
            total_minor: kinds.reduce((a, k) => a + big(k.total_minor), 0n).toString(),
            kinds,
          },
        }
      : null,
    channels: pos ? channelRows : [],
    methods: pos
      ? SALES_REPORT_METHODS.map((method) => {
          const v = methodOf(method);
          return {
            method,
            revenue: !NO_REVENUE_METHODS.includes(method),
            payments: v.payments,
            sales_minor: v.sales.toString(),
            voids_minor: v.voids.toString(),
            refunds_minor: v.refunds.toString(),
            net_minor: (v.sales - v.voids - v.refunds).toString(),
          };
        })
      : [],
    sales: listed,
    fiscal_summary: pos
      ? {
          pending: {
            count: fiscalSummary.pending.count,
            amount_minor: fiscalSummary.pending.amount.toString(),
          },
          recorded: {
            count: fiscalSummary.recorded.count,
            sales_minor: fiscalSummary.recorded.sales.toString(),
            refunds_minor: fiscalSummary.recorded.refunds.toString(),
            net_minor: (fiscalSummary.recorded.sales - fiscalSummary.recorded.refunds).toString(),
          },
          not_required: {
            count: fiscalSummary.not_required.count,
            amount_minor: fiscalSummary.not_required.amount.toString(),
            methods: [...fiscalSummary.not_required_methods.entries()]
              .sort(
                ([a], [b]) =>
                  SALES_REPORT_METHODS.indexOf(a as never) -
                  SALES_REPORT_METHODS.indexOf(b as never),
              )
              .map(([method, v]) => ({
                method,
                count: v.count,
                amount_minor: v.amount.toString(),
              })),
          },
        }
      : null,
    staff,
    limits: { ...POS_DAY_LIMITS },
    truncated,
  };
}

/**
 * What the order registry and the order card add while BACKOFFICE_POS_DAY_ENABLED is on (audit
 * F04, F10; CR pos-4 section 2): the cash desk of each POS order (by its cashier-report shift or
 * its cloud073 sale) and the Webkassa state of its sale receipt, plus the named cash desks.
 */
export async function posOrderExtras(
  db: Db,
  branch: string,
  orders: { id: string; shift_id: string | null }[],
  cashier: boolean,
) {
  const pos = await posDayReadable(db);
  const terminal = new Map<string, string>();
  const fiscal = new Map<string, string>();
  const shiftIds = [
    ...new Set(orders.map((o) => o.shift_id).filter((v): v is string => typeof v === 'string')),
  ];
  if (cashier && shiftIds.length) {
    const byShift = new Map(
      (
        await db.query<{ id: string; terminal_id: string | null }>(
          `SELECT id::text AS id,payload->>'terminal_id' AS terminal_id FROM cloud_cashier_shifts
           WHERE branch_id=$1 AND id=ANY($2::uuid[])`,
          [branch, shiftIds],
        )
      ).rows.map((r) => [r.id, r.terminal_id]),
    );
    for (const o of orders) {
      const t = o.shift_id ? byShift.get(o.shift_id) : null;
      if (t) terminal.set(o.id, t);
    }
  }
  if (pos && orders.length)
    for (const r of (
      await db.query<{ order_id: string; terminal_id: string; fiscal: string | null }>(
        `SELECT s.order_id::text AS order_id,s.terminal_id::text AS terminal_id,
           (SELECT f.state FROM cloud_pos_fiscal_receipts f WHERE f.order_id=s.order_id AND f.branch_id=s.branch_id
             AND f.kind='sale' ORDER BY f.version DESC LIMIT 1) AS fiscal
         FROM cloud_pos_sales s WHERE s.branch_id=$1 AND s.order_id=ANY($2::uuid[])`,
        [branch, orders.map((o) => o.id)],
      )
    ).rows) {
      terminal.set(r.order_id, r.terminal_id);
      if (r.fiscal) fiscal.set(r.order_id, r.fiscal);
    }
  return { pos, terminal, fiscal, terminals: await posTerminals(db, branch, { pos, cashier }) };
}

/** The receipt card of one POS order for the order dialog (null without cloud073 or no sale). */
export async function posOrderCard(db: Db, branch: string, orderId: string, cashier: boolean) {
  if (!(await posDayReadable(db))) return { pos_sale: null, pos_staff: {}, pos_terminal: null };
  const [card] = await posSaleCards(db, branch, [orderId]);
  if (!card) return { pos_sale: null, pos_staff: {}, pos_terminal: null };
  const terminals = await posTerminals(db, branch, { pos: true, cashier });
  return {
    pos_sale: card,
    pos_staff: await posStaffNames(db, branch, staffIds([card])),
    pos_terminal: terminals.find((t) => t.terminal_id === card.terminal_id) ?? null,
  };
}
