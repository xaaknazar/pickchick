import { z } from 'zod';
import type { DatabaseClient } from '@pickchick/database';
import { BackofficeError, parse, periodWindow, type Command } from './model.js';

/**
 * Stock documents v2 (cutover CC-6; contracts 3.3, 5.10; design-backoffice 2 Ск1, Ск5).
 *
 * Behind BACKOFFICE_STOCK_V2_ENABLED (default off) and only on a database with cloud074 the
 * stock command accepts `reason_code` (waste, then required) and `meta` (receipt supplier and
 * document date), and GET .../ops/stock reports them. With the flag off, or without 074, a
 * command that carries either field is refused with STOCK_V2_DISABLED and every other stock
 * command is written with exactly the pre-074 statement.
 */

type Db = Pick<DatabaseClient, 'query'>;
type StockCommand = Extract<z.infer<typeof Command>, { type: 'stock' }>;

async function columns(db: Db, privilege: 'INSERT' | 'SELECT') {
  const r = await db.query<{ ok: boolean | null }>(
    `SELECT count(*) = 2 AND bool_and(has_column_privilege(a.attrelid, a.attnum, $1)) AS ok
     FROM pg_attribute a
     WHERE a.attrelid = to_regclass('bo_stock_documents')
       AND a.attname IN ('reason_code','meta') AND NOT a.attisdropped`,
    [privilege],
  );
  return r.rows[0]?.ok === true;
}
/** cloud074 is applied and the current role may write the v2 columns. */
export const stockV2Writable = (db: Db) => columns(db, 'INSERT');
/** cloud074 is applied and the current role may read the v2 columns. */
export const stockV2Readable = (db: Db) => columns(db, 'SELECT');

/**
 * The v2 rules of one stock command. `available` = flag on and stockV2Writable. Pure; throws
 * BackofficeError: NOT_READY/STOCK_V2_DISABLED, INVALID_REQUEST/REASON_REQUIRED, INVALID_REQUEST.
 */
export function assertStockV2(
  command: Pick<StockCommand, 'kind' | 'reason_code' | 'meta'>,
  available: boolean,
): void {
  const v2 = command.reason_code !== undefined || command.meta !== undefined;
  if (!available) {
    if (v2) throw new BackofficeError('NOT_READY', 'STOCK_V2_DISABLED');
    return;
  }
  if (command.reason_code !== undefined && command.kind !== 'waste')
    throw new BackofficeError('INVALID_REQUEST');
  if (command.meta !== undefined && command.kind !== 'receipt')
    throw new BackofficeError('INVALID_REQUEST');
  if (command.kind === 'waste' && command.reason_code === undefined)
    throw new BackofficeError('INVALID_REQUEST', 'REASON_REQUIRED');
}

const day = z.iso.date();
/** At most 92 calendar days (Asia/Almaty), like the other cutover reports. */
export const STOCK_OPS_MAX_DAYS = 92;
export const STOCK_OPS_DOCUMENT_LIMIT = 200;
export const StockOpsQuery = z
  .strictObject({
    view: z.enum(['waste', 'movement']),
    start_date: day,
    end_date: day,
  })
  .refine(
    (q) =>
      q.start_date >= '2000-01-01' &&
      q.end_date <= '2099-12-31' &&
      q.start_date <= q.end_date &&
      new Date(`${q.start_date}T00:00:00Z`).toISOString().slice(0, 10) === q.start_date &&
      new Date(`${q.end_date}T00:00:00Z`).toISOString().slice(0, 10) === q.end_date &&
      Date.parse(q.end_date) - Date.parse(q.start_date) < STOCK_OPS_MAX_DAYS * 86400000,
  );
export type StockOpsQueryInput = z.infer<typeof StockOpsQuery>;

/**
 * GET .../ops/stock?view=waste|movement&start_date&end_date. Documents of the window (newest
 * first, at most 200) with reason_code, meta, author and movements; the summary is computed over
 * the whole window, not only the listed documents. Amounts are whole tiyn strings; a waste
 * amount is the stock value it removed (positive).
 */
export async function readStockOps(db: Db, branch: string, input: unknown, now: Date) {
  const q = parse(StockOpsQuery, input);
  const { start, end } = periodWindow(
    { period: 'custom', start_date: q.start_date, end_date: q.end_date },
    now,
  );
  const kind = q.view === 'waste' ? 'waste' : null;
  const window = `d.branch_id=$1 AND d.created_at >= $2 AND d.created_at < $3 AND ($4::text IS NULL OR d.kind=$4)`;
  const args = [branch, start, end, kind];
  const rows = async (sql: string) => (await db.query(sql, args)).rows;
  const documents = await rows(
    `SELECT d.id,d.kind,d.reference,d.reason,d.reason_code,d.meta,d.order_id,d.created_at,d.actor_id,a.name actor_name,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
        'ingredient_id',m.ingredient_id,'name',r.payload->>'name','unit',r.payload->>'unit',
        'quantity_delta',m.quantity_delta::text,'value_delta_minor',m.value_delta_minor::text,
        'balance_after',m.balance_after::text,'value_after_minor',m.value_after_minor::text
      ) ORDER BY m.ingredient_id) FROM bo_stock_movements m
      JOIN bo_records r ON r.id=m.ingredient_id AND r.branch_id=m.branch_id AND r.kind='ingredient'
      WHERE m.document_id=d.id AND m.branch_id=d.branch_id),'[]'::jsonb) lines
     FROM bo_stock_documents d JOIN catalog_managers a ON a.id=d.actor_id
     WHERE ${window} ORDER BY d.created_at DESC,d.id LIMIT ${STOCK_OPS_DOCUMENT_LIMIT + 1}`,
  );
  // One row per document with its value effect; every summary below aggregates this set.
  const effects = `WITH docs AS (
      SELECT d.id,d.kind,d.reason_code,d.actor_id,(d.created_at AT TIME ZONE 'Asia/Almaty')::date AS day,
        coalesce((SELECT sum(m.value_delta_minor) FROM bo_stock_movements m WHERE m.document_id=d.id AND m.branch_id=d.branch_id),0) AS value_delta
      FROM bo_stock_documents d WHERE ${window})`;
  const totals = (
    await rows(
      `${effects} SELECT count(*)::int documents,coalesce(sum(-value_delta),0)::text value_minor,
        coalesce(sum(value_delta),0)::text value_delta_minor FROM docs`,
    )
  )[0];
  const byDay = await rows(
    `${effects} SELECT day::text AS day,count(*)::int documents,coalesce(sum(-value_delta),0)::text value_minor,
      coalesce(sum(value_delta),0)::text value_delta_minor FROM docs GROUP BY day ORDER BY day`,
  );
  const summary =
    q.view === 'waste'
      ? {
          by_reason: await rows(
            `${effects} SELECT reason_code,count(*)::int documents,coalesce(sum(-value_delta),0)::text value_minor
             FROM docs GROUP BY reason_code ORDER BY reason_code NULLS LAST`,
          ),
          by_day: byDay.map(({ day, documents, value_minor }) => ({ day, documents, value_minor })),
          by_ingredient: await rows(
            `SELECT m.ingredient_id,r.payload->>'name' AS name,r.payload->>'unit' AS unit,
              sum(-m.quantity_delta)::text quantity,sum(-m.value_delta_minor)::text value_minor
             FROM bo_stock_documents d
             JOIN bo_stock_movements m ON m.document_id=d.id AND m.branch_id=d.branch_id
             JOIN bo_records r ON r.id=m.ingredient_id AND r.branch_id=m.branch_id AND r.kind='ingredient'
             WHERE ${window} GROUP BY m.ingredient_id,r.payload->>'name',r.payload->>'unit'
             ORDER BY sum(-m.value_delta_minor) DESC,m.ingredient_id`,
          ),
          by_author: await rows(
            `${effects} SELECT d.actor_id,a.name actor_name,count(*)::int documents,coalesce(sum(-d.value_delta),0)::text value_minor
             FROM docs d JOIN catalog_managers a ON a.id=d.actor_id GROUP BY d.actor_id,a.name ORDER BY a.name,d.actor_id`,
          ),
        }
      : {
          by_kind: await rows(
            `${effects} SELECT kind,count(*)::int documents,coalesce(sum(value_delta),0)::text value_delta_minor
             FROM docs GROUP BY kind ORDER BY kind`,
          ),
          by_day: byDay.map(({ day, documents, value_delta_minor }) => ({
            day,
            documents,
            value_delta_minor,
          })),
        };
  return {
    schema_version: 1 as const,
    branch_id: branch,
    view: q.view,
    timezone: 'Asia/Almaty' as const,
    start_date: q.start_date,
    end_date: q.end_date,
    period_start: start.toISOString(),
    period_end: end.toISOString(),
    as_of: now.toISOString(),
    totals:
      q.view === 'waste'
        ? { documents: totals.documents, value_minor: totals.value_minor }
        : { documents: totals.documents, value_delta_minor: totals.value_delta_minor },
    summary,
    documents: documents.slice(0, STOCK_OPS_DOCUMENT_LIMIT),
    truncated: documents.length > STOCK_OPS_DOCUMENT_LIMIT,
    limits: { documents: STOCK_OPS_DOCUMENT_LIMIT },
  };
}
