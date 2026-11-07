import { z } from 'zod';
import type { DatabaseClient } from '@pickchick/database';
import { parse, periodWindow } from './model.js';
import { readable } from './stops.js';
import { cashierReportsReadable, posDayReadable, posTerminals } from './pos-day.js';

/**
 * The order registry on the server (audit F10 remainder; lane bo-ui, behind
 * BACKOFFICE_POS_DAY_ENABLED): GET .../ops/orders?start_date&end_date[&q&channel&terminal_id&sort
 * &page]. GET branches/:id lists the newest 200 orders per source of the period; this view
 * searches, sorts and pages every order of an Almaty date window on the server and totals the
 * whole selection, also by cash desk.
 *
 * One row per order, the three sources of the registry: app and kiosk orders (commerce_orders),
 * cashier report orders (cloud_cashier_orders, where a paid POS sale is paid, CR pos-4 section 2)
 * and the other POS orders (pos_order_sync_projection). The cash desk of a POS order comes from
 * the sale (cloud073) or the cashier shift. A row is live unless cancelled or voided; the totals
 * count live orders only, in tiyn.
 */
type Db = Pick<DatabaseClient, 'query'>;
export const ORDERS_PAGE_SIZE = 100;
/** The longest window, as GET branches/:id (a year). */
export const ORDERS_MAX_DAYS = 366;
const day = z.iso.date().refine((v) => v >= '2020-01-01' && v <= '2099-12-31');
export const OrdersQuery = z
  .strictObject({
    start_date: day,
    end_date: day,
    /** An order number («117», «№117») or the start of the order id. */
    q: z
      .string()
      .trim()
      .max(40)
      .regex(/^[0-9a-fA-F№\s-]*$/)
      .optional(),
    channel: z.enum(['mobile', 'kiosk', 'pos']).optional(),
    terminal_id: z.uuid().optional(),
    sort: z.enum(['new', 'old', 'number', 'amount']).default('new'),
    page: z
      .string()
      .regex(/^[1-9][0-9]{0,3}$/)
      .transform(Number)
      .default(1),
  })
  .refine(
    (q) =>
      q.start_date <= q.end_date &&
      Date.parse(q.end_date) - Date.parse(q.start_date) < ORDERS_MAX_DAYS * 86400000,
  );
export type OrdersQueryInput = z.input<typeof OrdersQuery>;

const ORDER_BY = {
  new: 'r.created_at DESC,r.id',
  old: 'r.created_at ASC,r.id',
  number: 'r.number ASC NULLS LAST,r.terminal_id NULLS FIRST,r.created_at DESC,r.id',
  amount: 'r.total_minor DESC,r.created_at DESC,r.id',
} as const;

/** GET .../ops/orders (lane bo-ui «Касса», audit F10): one page and the totals of the selection. */
export async function readOrdersRegistry(db: Db, branch: string, input: unknown, now: Date) {
  const q = parse(OrdersQuery, input);
  const { start, end } = periodWindow(
    { period: 'custom', start_date: q.start_date, end_date: q.end_date },
    now,
  );
  const pos = await posDayReadable(db);
  const cashier = await cashierReportsReadable(db);
  const sync = await readable(db, 'pos_order_sync_projection');
  const sale = (alias: string) =>
    pos
      ? `(SELECT s.terminal_id::text FROM cloud_pos_sales s WHERE s.order_id=${alias} AND s.branch_id=$1)`
      : 'NULL::text';
  const parts = [
    `SELECT o.id,o.created_at,o.snapshot->>'channel' AS channel,f.display_number::text AS display_number,
       o.total_minor::bigint AS total_minor,o.state::text AS state,p.state::text AS payment_state,
       f.state::text AS kitchen_state,NULL::text AS terminal_id,'cloud'::text AS source
     FROM commerce_orders o LEFT JOIN commerce_payment_intents p ON p.order_id=o.id
     LEFT JOIN cloud_fulfillment_projection f ON f.order_id=o.id
     WHERE o.branch_id=$1 AND o.created_at >= $2 AND o.created_at < $3`,
  ];
  if (cashier)
    parts.push(
      `SELECT c.id,c.created_at,'pos',c.payload->>'display_number',(c.payload->>'total_minor')::bigint,
         c.payload->>'state',
         CASE WHEN c.payload->>'execution_mode'='pos_sale' THEN 'captured' ELSE 'not_started' END,
         c.payload->>'kitchen_state',
         coalesce(${sale('c.id')},(SELECT h.payload->>'terminal_id' FROM cloud_cashier_shifts h WHERE h.id=c.cash_shift_id AND h.branch_id=c.branch_id)),
         'cashier_report'
       FROM cloud_cashier_orders c WHERE c.branch_id=$1 AND c.created_at >= $2 AND c.created_at < $3`,
    );
  if (sync)
    parts.push(
      `SELECT p.order_id,p.first_observed_at,'pos',k.display_number::text,p.total_minor::bigint,p.state::text,
         p.payment_state::text,coalesce(k.state::text,p.fulfillment_state::text),${sale('p.order_id')},'pos_sync'
       FROM pos_order_sync_projection p
       LEFT JOIN pos_kitchen_sync_projection k ON k.order_id=p.order_id AND k.branch_id=p.branch_id
       WHERE p.branch_id=$1 AND p.first_observed_at >= $2 AND p.first_observed_at < $3
       ${cashier ? 'AND NOT EXISTS(SELECT 1 FROM cloud_cashier_orders x WHERE x.id=p.order_id AND x.branch_id=p.branch_id)' : ''}`,
    );
  // «117» or «№117» is an order number (exact, every desk); anything else the start of an id.
  const search = q.q?.replace(/[№\s]/g, '').toLowerCase() || null;
  const numeric = search !== null && /^[0-9]{1,6}$/.test(search);
  const filtered = `SELECT r.*,
      CASE WHEN r.display_number ~ '^[0-9]{1,9}$' THEN r.display_number::int END AS number,
      r.state NOT IN ('cancelled','voided') AS live
    FROM (${parts.join(' UNION ALL ')}) r
    WHERE ($4::text IS NULL OR r.channel=$4)
      AND ($5::text IS NULL OR (r.channel='pos' AND lower(r.terminal_id)=lower($5)))
      AND ($6::text IS NULL OR ($7::boolean AND r.display_number=$6)
        OR (NOT $7::boolean AND lower(r.id::text) LIKE $6 || '%'))`;
  const args = [branch, start, end, q.channel ?? null, q.terminal_id ?? null, search, numeric];
  const rows = (
    await db.query(
      `SELECT r.id,r.created_at,r.channel,r.display_number,r.total_minor::text AS total_minor,r.state,
         r.payment_state,r.kitchen_state,r.terminal_id,r.source
       FROM (${filtered}) r ORDER BY ${ORDER_BY[q.sort]}
       LIMIT ${ORDERS_PAGE_SIZE} OFFSET ${(q.page - 1) * ORDERS_PAGE_SIZE}`,
      args,
    )
  ).rows;
  const totals = (
    await db.query<{ orders: number; live: number; live_total_minor: string }>(
      `SELECT count(*)::int orders,count(*) FILTER (WHERE r.live)::int live,
         coalesce(sum(r.total_minor) FILTER (WHERE r.live),0)::text live_total_minor
       FROM (${filtered}) r`,
      args,
    )
  ).rows[0]!;
  const desks = (
    await db.query<{ terminal_id: string | null; live: number; live_total_minor: string }>(
      `SELECT r.terminal_id,count(*)::int live,coalesce(sum(r.total_minor),0)::text live_total_minor
       FROM (${filtered}) r WHERE r.channel='pos' AND r.live GROUP BY r.terminal_id
       ORDER BY r.terminal_id NULLS LAST`,
      args,
    )
  ).rows;
  return {
    schema_version: 1 as const,
    branch_id: branch,
    timezone: 'Asia/Almaty' as const,
    start_date: q.start_date,
    end_date: q.end_date,
    as_of: now.toISOString(),
    filters: {
      q: q.q ?? null,
      channel: q.channel ?? null,
      terminal_id: q.terminal_id ?? null,
      sort: q.sort,
    },
    page: q.page,
    page_size: ORDERS_PAGE_SIZE,
    pages: Math.max(1, Math.ceil(totals.orders / ORDERS_PAGE_SIZE)),
    rows: rows.map((r) => ({
      ...r,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    })),
    totals: {
      orders: totals.orders,
      live_orders: totals.live,
      live_total_minor: totals.live_total_minor,
      by_terminal: desks.map((d) => ({
        terminal_id: d.terminal_id,
        live_orders: d.live,
        live_total_minor: d.live_total_minor,
      })),
    },
    terminals: await posTerminals(db, branch, { pos, cashier }),
    coverage: { pos_tables: pos, cashier_reports: cashier },
  };
}
