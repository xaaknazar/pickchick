import { z } from 'zod';
import type { DatabaseClient } from '@pickchick/database';
import { parse, periodWindow } from './model.js';

/**
 * Sales report (cutover CC-7; contracts 5.7, R6; design-backoffice 2 «Отчёты»).
 *
 * GET .../ops/sales?start_date&end_date, behind BACKOFFICE_SALES_REPORT_ENABLED (default off).
 * One report for every channel: the cashier edge (cloud_pos_* of cloud073, written by the
 * posSales receiver) and the cloud app and kiosk orders (commerce captures and refund effects).
 * Without the cloud073 tables, or without SELECT on them, the report has only the cloud channels
 * and coverage.pos=false; it never fails because the cashier data is missing.
 *
 * How it counts (the UI shows the same text under «Как считается»):
 * - Days are Asia/Almaty calendar days. A cashier sale belongs to its business_date (the Almaty
 *   date of sold_at); a cloud payment to the Almaty date of its capture. Voids and refunds belong
 *   to the day they were made, not to the day of the sale.
 * - `sales_minor` is every sale of the period, voided ones included, exactly like the cashier Z
 *   report; a void is a refund of the whole sale (`voids_minor`), a refund of a part is
 *   `refunds_minor`; revenue = sales - voids - refunds.
 * - A check is a sale of the period that was not voided before the period ended. Average check =
 *   sum of those checks / their number, before refunds, rounded half up to a tiyn. A void made
 *   after the end (23:55 sale, 00:05 void) belongs to the next day's voids_minor and never
 *   changes the checks, hours, shifts or top items of the period it closed: a closed day's
 *   figures stay as they were.
 * - Staff meals and marketing are «Без выручки»: never in revenue, channels or average check;
 *   they have their own block and their own payment methods.
 * - Every one of the eight cashier payment methods is its own row; the cloud channels are paid
 *   online (`online`). Discounts are a P1 mechanism: discount_minor is reported and is 0 today.
 * Money is whole tiyn in strings; arithmetic is BigInt.
 */

type Db = Pick<DatabaseClient, 'query'>;

/** Verbatim copy of PosPaymentMethodSchema (packages/contracts/src/cutover-enums.ts, cloud073). */
export const POS_PAYMENT_METHODS = [
  'cash',
  'kaspi_terminal',
  'aggregator_yandex_eda',
  'aggregator_glovo',
  'staff_meal',
  'marketing',
  'kaspi_manual',
  'chocofood',
] as const;
export type PosPaymentMethod = (typeof POS_PAYMENT_METHODS)[number];
/** Row order of the report: the owner's list (contracts section 00, item 1). */
export const SALES_REPORT_METHODS = [
  'cash',
  'kaspi_terminal',
  'kaspi_manual',
  'aggregator_yandex_eda',
  'aggregator_glovo',
  'chocofood',
  'staff_meal',
  'marketing',
] as const satisfies readonly PosPaymentMethod[];
/** Methods of the sales without revenue (staff meal, marketing). */
export const NO_REVENUE_METHODS: readonly PosPaymentMethod[] = Object.freeze([
  'staff_meal',
  'marketing',
]);
/** Report channels (contracts 5.7). The hall is split by the cashier's service mode. */
export const SALES_REPORT_CHANNELS = [
  'hall_dine_in',
  'hall_takeaway',
  'yandex_eda',
  'glovo',
  'mobile',
  'kiosk',
] as const;
export type SalesReportChannel = (typeof SALES_REPORT_CHANNELS)[number];
const POS_CHANNELS: readonly SalesReportChannel[] = [
  'hall_dine_in',
  'hall_takeaway',
  'yandex_eda',
  'glovo',
];
const CLOUD_CHANNELS: readonly SalesReportChannel[] = ['mobile', 'kiosk'];
/** The cloud073 projections the report reads; all of them must be present and readable. */
export const SALES_REPORT_POS_TABLES = Object.freeze([
  'cloud_pos_sales',
  'cloud_pos_tenders',
  'cloud_pos_refunds',
  'cloud_pos_refund_tenders',
  'cloud_pos_shift_reports',
]);
export const SALES_REPORT_MAX_DAYS = 92;
export const SALES_REPORT_LIMITS = Object.freeze({
  refunds: 200,
  no_revenue: 200,
  shifts: 50,
  top_items: 20,
});

const day = z.iso.date();
/** start_date..end_date, Asia/Almaty calendar days, at most 92 days, nothing else. */
export const SalesReportQuery = z
  .strictObject({ start_date: day, end_date: day })
  .refine(
    (q) =>
      q.start_date >= '2000-01-01' &&
      q.end_date <= '2099-12-31' &&
      q.start_date <= q.end_date &&
      new Date(`${q.start_date}T00:00:00Z`).toISOString().slice(0, 10) === q.start_date &&
      new Date(`${q.end_date}T00:00:00Z`).toISOString().slice(0, 10) === q.end_date &&
      Date.parse(q.end_date) - Date.parse(q.start_date) < SALES_REPORT_MAX_DAYS * 86400000,
  );
export type SalesReportQueryInput = z.infer<typeof SalesReportQuery>;

/** cloud073 is applied and the current role may read every projection the report needs. */
export async function salesReportPosReadable(db: Db): Promise<boolean> {
  const r = await db.query<{ ok: boolean | null }>(
    `SELECT bool_and(to_regclass(t) IS NOT NULL AND has_table_privilege(current_user, to_regclass(t), 'SELECT')) AS ok
     FROM unnest($1::text[]) t`,
    [SALES_REPORT_POS_TABLES],
  );
  return r.rows[0]?.ok === true;
}

const big = (v: unknown) => BigInt(String(v ?? '0'));
/** sum / count rounded half up; '0' when there is nothing to divide. */
export function averageMinor(sum: bigint, count: number): string {
  if (count <= 0) return '0';
  const n = BigInt(count);
  return ((sum * 2n + n) / (2n * n)).toString();
}
function days(start: string, end: string) {
  const out: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86400000)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
type Money = { sales: bigint; paid: bigint; voids: bigint; refunds: bigint; discount: bigint };
const empty = (): Money => ({ sales: 0n, paid: 0n, voids: 0n, refunds: 0n, discount: 0n });
const channelExpression = `CASE WHEN s.sales_channel='hall' THEN 'hall_'||s.service_mode ELSE s.sales_channel END`;

/**
 * GET .../ops/sales?start_date&end_date (see the module comment). `now` is the as_of instant.
 */
export async function readSalesReport(db: Db, branch: string, input: unknown, now: Date) {
  const q = parse(SalesReportQuery, input);
  const { start, end } = periodWindow(
    { period: 'custom', start_date: q.start_date, end_date: q.end_date },
    now,
  );
  const pos = await salesReportPosReadable(db);
  const rows = async <T = Record<string, unknown>>(sql: string, args: unknown[]) =>
    (await db.query(sql, args)).rows as T[];
  // Parameter sets: $1 branch with $2/$3 either the Almaty dates (cashier business_date) or
  // the same window as instants [start, end) for everything stamped with a time; `asOfEnd`
  // adds $4 = end for the state of a sale when the period ended (cloud073: voided_at is set
  // exactly when the sale is voided).
  const dates = [branch, q.start_date, q.end_date];
  const window = [branch, start, end];
  const asOfEnd = [branch, q.start_date, q.end_date, end];
  const paidAtEnd = '(s.voided_at IS NULL OR s.voided_at >= $4)';
  const voidedAtEnd = 's.voided_at < $4';
  const channelMoney = new Map<string, Money & { checks: number; voided: number }>();
  const channel = (code: string) => {
    let v = channelMoney.get(code);
    if (!v) channelMoney.set(code, (v = { ...empty(), checks: 0, voided: 0 }));
    return v;
  };
  const dayMoney = new Map<string, Money & { checks: number; no_revenue: bigint }>();
  const dayOf = (code: string) => {
    let v = dayMoney.get(code);
    if (!v) dayMoney.set(code, (v = { ...empty(), checks: 0, no_revenue: 0n }));
    return v;
  };
  const hourMoney = new Map<number, { checks: number; paid: bigint }>();
  const hourOf = (hour: number) => {
    let v = hourMoney.get(hour);
    if (!v) hourMoney.set(hour, (v = { checks: 0, paid: 0n }));
    return v;
  };
  const methodMoney = new Map<
    string,
    { payments: number; sales: bigint; voids: bigint; refunds: bigint }
  >();
  const methodOf = (code: string) => {
    let v = methodMoney.get(code);
    if (!v) methodMoney.set(code, (v = { payments: 0, sales: 0n, voids: 0n, refunds: 0n }));
    return v;
  };
  type Refund = {
    source: 'pos' | 'cloud';
    refund_id: string;
    order_id: string;
    display_number: number | null;
    channel: string;
    revenue_kind: string;
    kind: 'void' | 'refund';
    amount_minor: string;
    reason_code: string | null;
    reason: string;
    staff_id: string | null;
    approved_by_staff_id: string | null;
    approved_by_actor_id: string | null;
    approved_by_name: string | null;
    created_at: string;
    methods: { method: string; amount_minor: string }[];
  };
  const refunds: Refund[] = [];
  let noRevenue = {
    kinds: [] as {
      revenue_kind: string;
      checks: number;
      voided_checks: number;
      total_minor: string;
    }[],
    items: [] as Record<string, unknown>[],
    truncated: false,
  };
  let shifts: Record<string, unknown>[] = [];
  let shiftsTruncated = false;
  let topItems: Record<string, unknown>[] = [];
  let posReceivedAt: string | null = null;

  if (pos) {
    const revenueSales = `FROM cloud_pos_sales s
      WHERE s.branch_id=$1 AND s.business_date BETWEEN $2::date AND $3::date AND s.revenue_kind='revenue'`;
    for (const r of await rows<{
      channel: string;
      checks: number;
      voided: number;
      sales: string;
      paid: string;
      discount: string;
    }>(
      `SELECT ${channelExpression} AS channel,count(*) FILTER(WHERE ${paidAtEnd})::int AS checks,
        count(*) FILTER(WHERE ${voidedAtEnd})::int AS voided,sum(s.total_minor)::text AS sales,
        coalesce(sum(s.total_minor) FILTER(WHERE ${paidAtEnd}),0)::text AS paid,
        sum(s.discount_minor)::text AS discount
       ${revenueSales} GROUP BY 1`,
      asOfEnd,
    )) {
      const v = channel(r.channel);
      v.checks += r.checks;
      v.voided += r.voided;
      v.sales += big(r.sales);
      v.paid += big(r.paid);
      v.discount += big(r.discount);
    }
    // Voids and refunds of revenue sales, by the day they were made.
    const posRefunds = `FROM cloud_pos_refunds r JOIN cloud_pos_sales s ON s.order_id=r.order_id AND s.branch_id=r.branch_id
      WHERE r.branch_id=$1 AND r.created_at >= $2 AND r.created_at < $3`;
    for (const r of await rows<{ channel: string; kind: string; amount: string }>(
      `SELECT ${channelExpression} AS channel,r.kind,sum(r.amount_minor)::text AS amount
       ${posRefunds} AND s.revenue_kind='revenue' GROUP BY 1,2`,
      window,
    )) {
      const v = channel(r.channel);
      if (r.kind === 'void') v.voids += big(r.amount);
      else v.refunds += big(r.amount);
    }
    for (const r of await rows<{ method: string; payments: number; sales: string }>(
      `SELECT t.method,count(*)::int AS payments,sum(t.amount_minor)::text AS sales
       FROM cloud_pos_tenders t JOIN cloud_pos_sales s ON s.order_id=t.order_id AND s.branch_id=t.branch_id
       WHERE s.branch_id=$1 AND s.business_date BETWEEN $2::date AND $3::date GROUP BY t.method`,
      dates,
    )) {
      const v = methodOf(r.method);
      v.payments += r.payments;
      v.sales += big(r.sales);
    }
    for (const r of await rows<{ method: string; kind: string; amount: string }>(
      `SELECT p.method,r.kind,sum(p.amount_minor)::text AS amount
       FROM cloud_pos_refund_tenders p JOIN cloud_pos_refunds r ON r.refund_id=p.refund_id AND r.branch_id=p.branch_id
       WHERE r.branch_id=$1 AND r.created_at >= $2 AND r.created_at < $3 GROUP BY 1,2`,
      window,
    )) {
      const v = methodOf(r.method);
      if (r.kind === 'void') v.voids += big(r.amount);
      else v.refunds += big(r.amount);
    }
    for (const r of await rows<{ day: string; checks: number; sales: string; paid: string }>(
      `SELECT s.business_date::text AS day,count(*) FILTER(WHERE ${paidAtEnd})::int AS checks,
        sum(s.total_minor)::text AS sales,coalesce(sum(s.total_minor) FILTER(WHERE ${paidAtEnd}),0)::text AS paid
       ${revenueSales} GROUP BY 1`,
      asOfEnd,
    )) {
      const v = dayOf(r.day);
      v.checks += r.checks;
      v.sales += big(r.sales);
      v.paid += big(r.paid);
    }
    for (const r of await rows<{ day: string; kind: string; amount: string }>(
      `SELECT (r.created_at AT TIME ZONE 'Asia/Almaty')::date::text AS day,r.kind,sum(r.amount_minor)::text AS amount
       ${posRefunds} AND s.revenue_kind='revenue' GROUP BY 1,2`,
      window,
    )) {
      const v = dayOf(r.day);
      if (r.kind === 'void') v.voids += big(r.amount);
      else v.refunds += big(r.amount);
    }
    for (const r of await rows<{ day: string; total: string }>(
      `SELECT s.business_date::text AS day,sum(s.total_minor)::text AS total FROM cloud_pos_sales s
       WHERE s.branch_id=$1 AND s.business_date BETWEEN $2::date AND $3::date
         AND s.revenue_kind<>'revenue' AND ${paidAtEnd} GROUP BY 1`,
      asOfEnd,
    ))
      dayOf(r.day).no_revenue += big(r.total);
    for (const r of await rows<{ hour: number; checks: number; paid: string }>(
      `SELECT extract(hour FROM s.sold_at AT TIME ZONE 'Asia/Almaty')::int AS hour,count(*)::int AS checks,
        sum(s.total_minor)::text AS paid
       ${revenueSales} AND ${paidAtEnd} GROUP BY 1`,
      asOfEnd,
    )) {
      const v = hourOf(r.hour);
      v.checks += r.checks;
      v.paid += big(r.paid);
    }
    noRevenue = {
      kinds: (
        await rows<{ revenue_kind: string; checks: number; voided: number; total: string }>(
          `SELECT s.revenue_kind,count(*) FILTER(WHERE ${paidAtEnd})::int AS checks,
            count(*) FILTER(WHERE ${voidedAtEnd})::int AS voided,
            coalesce(sum(s.total_minor) FILTER(WHERE ${paidAtEnd}),0)::text AS total
           FROM cloud_pos_sales s WHERE s.branch_id=$1 AND s.business_date BETWEEN $2::date AND $3::date
             AND s.revenue_kind<>'revenue' GROUP BY 1`,
          asOfEnd,
        )
      ).map((r) => ({
        revenue_kind: r.revenue_kind,
        checks: r.checks,
        voided_checks: r.voided,
        total_minor: r.total,
      })),
      items: [],
      truncated: false,
    };
    const items = await rows(
      `SELECT s.order_id,s.display_number,s.revenue_kind,
        CASE WHEN ${voidedAtEnd} THEN 'voided' ELSE 'paid' END AS state,s.total_minor::text AS total_minor,
        s.beneficiary,s.reason,s.approval_manager_staff_id,s.cashier_staff_id,s.shift_id,s.terminal_id,s.sold_at
       FROM cloud_pos_sales s WHERE s.branch_id=$1 AND s.business_date BETWEEN $2::date AND $3::date
         AND s.revenue_kind<>'revenue'
       ORDER BY s.sold_at DESC,s.order_id LIMIT ${SALES_REPORT_LIMITS.no_revenue + 1}`,
      asOfEnd,
    );
    noRevenue.items = items.slice(0, SALES_REPORT_LIMITS.no_revenue).map((r) => ({
      ...r,
      sold_at: (r['sold_at'] as Date).toISOString(),
    }));
    noRevenue.truncated = items.length > SALES_REPORT_LIMITS.no_revenue;
    const posRefundRows = await rows<{
      refund_id: string;
      order_id: string;
      display_number: number;
      channel: string;
      revenue_kind: string;
      kind: 'void' | 'refund';
      amount_minor: string;
      reason_code: string;
      reason: string;
      staff_id: string;
      approved_by_staff_id: string;
      created_at: Date;
      methods: { method: string; amount_minor: string }[];
    }>(
      `SELECT r.refund_id,r.order_id,s.display_number,${channelExpression} AS channel,s.revenue_kind,r.kind,
        r.amount_minor::text AS amount_minor,r.reason_code,r.reason,r.staff_id,r.approved_by_staff_id,r.created_at,
        coalesce((SELECT jsonb_agg(jsonb_build_object('method',p.method,'amount_minor',p.amount_minor::text)
          ORDER BY p.method,p.tender_id) FROM cloud_pos_refund_tenders p
          WHERE p.refund_id=r.refund_id AND p.branch_id=r.branch_id),'[]'::jsonb) AS methods
       ${posRefunds} ORDER BY r.created_at DESC,r.refund_id LIMIT ${SALES_REPORT_LIMITS.refunds + 1}`,
      window,
    );
    for (const r of posRefundRows)
      refunds.push({
        source: 'pos',
        refund_id: r.refund_id,
        order_id: r.order_id,
        display_number: r.display_number,
        channel: r.channel,
        revenue_kind: r.revenue_kind,
        kind: r.kind,
        amount_minor: r.amount_minor,
        reason_code: r.reason_code,
        reason: r.reason,
        staff_id: r.staff_id,
        approved_by_staff_id: r.approved_by_staff_id,
        approved_by_actor_id: null,
        approved_by_name: null,
        created_at: r.created_at.toISOString(),
        methods: r.methods,
      });
    const shiftRows = await rows(
      `SELECT s.shift_id,s.terminal_id,count(*) FILTER(WHERE ${paidAtEnd} AND s.revenue_kind='revenue')::int AS checks,
        coalesce(sum(s.total_minor) FILTER(WHERE s.revenue_kind='revenue'),0)::text AS sales_minor,
        min(s.sold_at) AS first_sale_at,max(s.sold_at) AS last_sale_at,
        z.closed_at,z.expected_cash_minor::text AS expected_cash_minor,z.counted_cash_minor::text AS counted_cash_minor,
        z.discrepancy_minor::text AS discrepancy_minor,z.terminal_reported_minor::text AS terminal_reported_minor
       FROM cloud_pos_sales s LEFT JOIN cloud_pos_shift_reports z ON z.shift_id=s.shift_id AND z.branch_id=s.branch_id
       WHERE s.branch_id=$1 AND s.business_date BETWEEN $2::date AND $3::date
       GROUP BY s.shift_id,s.terminal_id,z.shift_id
       ORDER BY min(s.sold_at) DESC,s.shift_id LIMIT ${SALES_REPORT_LIMITS.shifts + 1}`,
      asOfEnd,
    );
    shiftsTruncated = shiftRows.length > SALES_REPORT_LIMITS.shifts;
    shifts = shiftRows.slice(0, SALES_REPORT_LIMITS.shifts).map((r) => ({
      shift_id: r['shift_id'],
      terminal_id: r['terminal_id'],
      checks: r['checks'],
      sales_minor: r['sales_minor'],
      first_sale_at: (r['first_sale_at'] as Date).toISOString(),
      last_sale_at: (r['last_sale_at'] as Date).toISOString(),
      z:
        r['closed_at'] === null
          ? null
          : {
              closed_at: (r['closed_at'] as Date).toISOString(),
              expected_cash_minor: r['expected_cash_minor'],
              counted_cash_minor: r['counted_cash_minor'],
              discrepancy_minor: r['discrepancy_minor'],
              terminal_reported_minor: r['terminal_reported_minor'],
            },
    }));
    topItems = await rows(
      `SELECT l->>'product_id' AS product_id,coalesce(l->'name'->>'ru','') AS name,
        sum((l->>'quantity')::int)::int AS quantity,sum((l->>'total_minor')::bigint)::text AS total_minor
       FROM cloud_pos_sales s CROSS JOIN LATERAL jsonb_array_elements(s.lines) l
       WHERE s.branch_id=$1 AND s.business_date BETWEEN $2::date AND $3::date
         AND s.revenue_kind='revenue' AND ${paidAtEnd}
       GROUP BY 1,2 ORDER BY sum((l->>'total_minor')::bigint) DESC,2,1 LIMIT ${SALES_REPORT_LIMITS.top_items}`,
      asOfEnd,
    );
    const received = (
      await rows<{ at: Date | null }>(
        `SELECT greatest((SELECT max(received_at) FROM cloud_pos_sales WHERE branch_id=$1),
          (SELECT max(received_at) FROM cloud_pos_shift_reports WHERE branch_id=$1)) AS at`,
        [branch],
      )
    )[0]?.at;
    posReceivedAt = received ? received.toISOString() : null;
  }

  // Cloud app and kiosk: money confirmed by the payment provider, by the time it was captured.
  const cloudCaptures = `FROM commerce_captures c JOIN commerce_orders o ON o.id=c.order_id
    WHERE o.branch_id=$1 AND o.snapshot->>'channel' IN ('mobile','kiosk') AND c.occurred_at >= $2 AND c.occurred_at < $3`;
  const cloudRefunds = `FROM commerce_refund_effects e JOIN commerce_orders o ON o.id=e.order_id
    WHERE o.branch_id=$1 AND o.snapshot->>'channel' IN ('mobile','kiosk') AND e.occurred_at >= $2 AND e.occurred_at < $3`;
  let onlinePayments = 0;
  for (const r of await rows<{ channel: string; checks: number; payments: number; paid: string }>(
    `SELECT o.snapshot->>'channel' AS channel,count(DISTINCT o.id)::int AS checks,count(*)::int AS payments,
      sum(c.amount_minor)::text AS paid ${cloudCaptures} GROUP BY 1`,
    window,
  )) {
    const v = channel(r.channel);
    v.checks += r.checks;
    v.sales += big(r.paid);
    v.paid += big(r.paid);
    onlinePayments += r.payments;
  }
  for (const r of await rows<{ channel: string; amount: string }>(
    `SELECT o.snapshot->>'channel' AS channel,sum(e.amount_minor)::text AS amount ${cloudRefunds} GROUP BY 1`,
    window,
  ))
    channel(r.channel).refunds += big(r.amount);
  for (const r of await rows<{ day: string; checks: number; paid: string }>(
    `SELECT (c.occurred_at AT TIME ZONE 'Asia/Almaty')::date::text AS day,count(DISTINCT o.id)::int AS checks,
      sum(c.amount_minor)::text AS paid ${cloudCaptures} GROUP BY 1`,
    window,
  )) {
    const v = dayOf(r.day);
    v.checks += r.checks;
    v.sales += big(r.paid);
    v.paid += big(r.paid);
  }
  for (const r of await rows<{ day: string; amount: string }>(
    `SELECT (e.occurred_at AT TIME ZONE 'Asia/Almaty')::date::text AS day,sum(e.amount_minor)::text AS amount
     ${cloudRefunds} GROUP BY 1`,
    window,
  ))
    dayOf(r.day).refunds += big(r.amount);
  for (const r of await rows<{ hour: number; checks: number; paid: string }>(
    `SELECT extract(hour FROM c.occurred_at AT TIME ZONE 'Asia/Almaty')::int AS hour,
      count(DISTINCT o.id)::int AS checks,sum(c.amount_minor)::text AS paid ${cloudCaptures} GROUP BY 1`,
    window,
  )) {
    const v = hourOf(r.hour);
    v.checks += r.checks;
    v.paid += big(r.paid);
  }
  const cloudRefundRows = await rows<{
    refund_id: string;
    order_id: string;
    display_number: string | null;
    channel: string;
    amount_minor: string;
    reason: string;
    actor_id: string;
    actor_name: string | null;
    created_at: Date;
  }>(
    `SELECT r.id AS refund_id,o.id AS order_id,f.display_number::text AS display_number,o.snapshot->>'channel' AS channel,
      e.amount_minor::text AS amount_minor,r.reason,r.principal_id AS actor_id,m.name AS actor_name,e.occurred_at AS created_at
     FROM commerce_refund_effects e JOIN commerce_refunds r ON r.id=e.refund_id JOIN commerce_orders o ON o.id=e.order_id
     LEFT JOIN cloud_fulfillment_projection f ON f.order_id=o.id
     LEFT JOIN catalog_managers m ON m.id=r.principal_id
     WHERE o.branch_id=$1 AND o.snapshot->>'channel' IN ('mobile','kiosk') AND e.occurred_at >= $2 AND e.occurred_at < $3
     ORDER BY e.occurred_at DESC,e.id LIMIT ${SALES_REPORT_LIMITS.refunds + 1}`,
    window,
  );
  for (const r of cloudRefundRows)
    refunds.push({
      source: 'cloud',
      refund_id: r.refund_id,
      order_id: r.order_id,
      display_number: r.display_number === null ? null : Number(r.display_number),
      channel: r.channel,
      revenue_kind: 'revenue',
      kind: 'refund',
      amount_minor: r.amount_minor,
      reason_code: null,
      reason: r.reason,
      staff_id: null,
      approved_by_staff_id: null,
      approved_by_actor_id: r.actor_id,
      approved_by_name: r.actor_name,
      created_at: r.created_at.toISOString(),
      methods: [{ method: 'online', amount_minor: r.amount_minor }],
    });
  refunds.sort(
    (a, b) =>
      b.created_at.localeCompare(a.created_at) ||
      a.source.localeCompare(b.source) ||
      a.refund_id.localeCompare(b.refund_id),
  );

  const channels = [...(pos ? POS_CHANNELS : []), ...CLOUD_CHANNELS].map((code) => {
    const v = channel(code);
    return {
      channel: code,
      source: CLOUD_CHANNELS.includes(code) ? ('cloud' as const) : ('pos' as const),
      checks: v.checks,
      voided_checks: v.voided,
      sales_minor: v.sales.toString(),
      voids_minor: v.voids.toString(),
      refunds_minor: v.refunds.toString(),
      revenue_minor: (v.sales - v.voids - v.refunds).toString(),
      average_check_minor: averageMinor(v.paid, v.checks),
      discount_minor: v.discount.toString(),
    };
  });
  const sum = (key: 'sales' | 'paid' | 'voids' | 'refunds' | 'discount') =>
    [...channelMoney.entries()]
      .filter(([code]) => channels.some((c) => c.channel === code))
      .reduce((a, [, v]) => a + v[key], 0n);
  const checks = channels.reduce((a, c) => a + c.checks, 0);
  const onlineSales = CLOUD_CHANNELS.reduce((a, code) => a + channel(code).sales, 0n);
  const onlineRefunds = CLOUD_CHANNELS.reduce((a, code) => a + channel(code).refunds, 0n);
  const methods = [
    ...(pos
      ? SALES_REPORT_METHODS.map((method) => {
          const v = methodOf(method);
          return {
            method,
            source: 'pos' as const,
            revenue: !NO_REVENUE_METHODS.includes(method),
            payments: v.payments,
            sales_minor: v.sales.toString(),
            voids_minor: v.voids.toString(),
            refunds_minor: v.refunds.toString(),
            net_minor: (v.sales - v.voids - v.refunds).toString(),
          };
        })
      : []),
    {
      method: 'online' as const,
      source: 'cloud' as const,
      revenue: true,
      payments: onlinePayments,
      sales_minor: onlineSales.toString(),
      voids_minor: '0',
      refunds_minor: onlineRefunds.toString(),
      net_minor: (onlineSales - onlineRefunds).toString(),
    },
  ];
  const noRevenueTotal = noRevenue.kinds.reduce((a, k) => a + big(k.total_minor), 0n);
  return {
    schema_version: 1 as const,
    branch_id: branch,
    view: 'sales' as const,
    timezone: 'Asia/Almaty' as const,
    start_date: q.start_date,
    end_date: q.end_date,
    period_start: start.toISOString(),
    period_end: end.toISOString(),
    as_of: now.toISOString(),
    coverage: { pos, cloud: true, pos_received_at: posReceivedAt, discounts: false },
    totals: {
      checks,
      voided_checks: channels.reduce((a, c) => a + c.voided_checks, 0),
      sales_minor: sum('sales').toString(),
      voids_minor: sum('voids').toString(),
      refunds_minor: sum('refunds').toString(),
      revenue_minor: (sum('sales') - sum('voids') - sum('refunds')).toString(),
      average_check_minor: averageMinor(sum('paid'), checks),
      discount_minor: sum('discount').toString(),
      no_revenue_checks: noRevenue.kinds.reduce((a, k) => a + k.checks, 0),
      no_revenue_minor: noRevenueTotal.toString(),
    },
    channels,
    methods,
    by_day: days(q.start_date, q.end_date).map((d) => {
      const v = dayOf(d);
      return {
        day: d,
        checks: v.checks,
        sales_minor: v.sales.toString(),
        voids_minor: v.voids.toString(),
        refunds_minor: v.refunds.toString(),
        revenue_minor: (v.sales - v.voids - v.refunds).toString(),
        no_revenue_minor: v.no_revenue.toString(),
      };
    }),
    by_hour: Array.from({ length: 24 }, (_, hour) => {
      const v = hourOf(hour);
      return { hour, checks: v.checks, sales_minor: v.paid.toString() };
    }),
    no_revenue: {
      kinds: NO_REVENUE_METHODS.map((kind) => {
        const k = noRevenue.kinds.find((v) => v.revenue_kind === kind);
        return {
          revenue_kind: kind,
          checks: k?.checks ?? 0,
          voided_checks: k?.voided_checks ?? 0,
          total_minor: k?.total_minor ?? '0',
        };
      }),
      items: noRevenue.items,
    },
    refunds: refunds.slice(0, SALES_REPORT_LIMITS.refunds),
    shifts,
    top_items: topItems,
    truncated: {
      refunds: refunds.length > SALES_REPORT_LIMITS.refunds,
      no_revenue: noRevenue.truncated,
      shifts: shiftsTruncated,
    },
    limits: { ...SALES_REPORT_LIMITS },
  };
}
