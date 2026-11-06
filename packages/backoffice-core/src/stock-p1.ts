import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseClient } from '@pickchick/database';
import { BackofficeError, Ingredient, parse, periodWindow } from './model.js';
import { STOCK_OPS_DOCUMENT_LIMIT, StockOpsQuery } from './stock-v2.js';
import type { BackofficeP1Permission } from './roles.js';
import {
  ConsumptionRetryCommand,
  ConsumptionSkipCommand,
  MenuLinkSaveCommand,
  MenuLinksApproveCommand,
  StockSettingsCommand,
} from './consumption.js';
import {
  ManagerShiftCloseCommand,
  ManagerShiftOpenCommand,
  ManagerShiftSaveCommand,
  ManagerShiftTemplateCommand,
} from './manager-shifts.js';
import { StaffPositionsSaveCommand } from './positions.js';

/**
 * Stock P1 of the back office (lane bo-ui, owner decision 05.11; design-bo-ui.md sections 2, 3,
 * 5.2, 5.4; design-backoffice.md section 2 Ск1, Ск5).
 *
 * Everything here runs only behind the existing BACKOFFICE_STOCK_V2_ENABLED and only on a database
 * where cloud075 is applied and the API role holds its stock rights (stockP1Ready: the
 * infra/staging/backoffice-p1-grants.mjs helper with stock v2). Then, and only then:
 *
 * - GET branches/:id reports capabilities.stock_p1 (the key is absent otherwise, so the answer is
 *   the cloud lane's), the stock rows carry `counted_at` and the documents carry their reason,
 *   receipt details and storno links;
 * - POST .../commands accepts `stock_reverse` (storno of a whole document) through its own schema,
 *   so the shared Command union is unchanged; without the flag it is an unknown command;
 * - an ingredient may carry `quick_waste` (a tile of the waste dialog);
 * - a count moves `counted_at` of its ingredients forward;
 * - GET .../ops/stock reports storno: a reversal of a waste is a negative entry of the waste report
 *   on the day it was made, under the reason and author of the waste it reverses.
 */

type Db = Pick<DatabaseClient, 'query'>;
const revision = z.number().int().min(0).max(2147483646);
/** A positive whole amount (the regex alone: a zod refine also runs on a string that failed it). */
const positive = z.string().regex(/^[1-9][0-9]{0,14}$/);
const LIMIT = 999999999999999n;

/**
 * cloud075 is applied and the current role may use its stock part: the reversal and source
 * columns of bo_stock_documents (INSERT, SELECT), bo_stock_balances.counted_at (SELECT, UPDATE)
 * and bo_menu_stock_links (SELECT, INSERT, UPDATE). The last one is granted only by the P1 grants
 * helper with stock v2 on, so a database that only has the migration stays at the cloud lane.
 */
export async function stockP1Ready(db: Db): Promise<boolean> {
  const r = await db.query<{ ok: boolean | null }>(
    `SELECT coalesce(
       (SELECT count(*) = 2
          AND bool_and(has_column_privilege(a.attrelid, a.attnum, 'INSERT')
            AND has_column_privilege(a.attrelid, a.attnum, 'SELECT'))
        FROM pg_attribute a WHERE a.attrelid = to_regclass('bo_stock_documents')
          AND a.attname IN ('source_ref','reverses_document_id') AND NOT a.attisdropped)
       AND (SELECT count(*) = 1
          AND bool_and(has_column_privilege(a.attrelid, a.attnum, 'UPDATE')
            AND has_column_privilege(a.attrelid, a.attnum, 'SELECT'))
        FROM pg_attribute a WHERE a.attrelid = to_regclass('bo_stock_balances')
          AND a.attname = 'counted_at' AND NOT a.attisdropped)
       AND to_regclass('bo_menu_stock_links') IS NOT NULL
       AND has_table_privilege(current_user, to_regclass('bo_menu_stock_links'), 'SELECT')
       AND has_table_privilege(current_user, to_regclass('bo_menu_stock_links'), 'INSERT')
       AND has_table_privilege(current_user, to_regclass('bo_menu_stock_links'), 'UPDATE'),
     false) AS ok`,
  );
  return r.rows[0]?.ok === true;
}

/**
 * Quick waste tile of an ingredient (design-bo-ui 5.4, design-backoffice 5 «Остатки»): the label on
 * the tile («Фингерсы из шкафа») and how much one press adds, in the ingredient's base unit.
 */
export const QuickWasteSchema = z.strictObject({
  label: z.string().trim().min(1).max(40),
  quantity: positive,
});
/** The ingredient payload while stock P1 is available; without it the strict Ingredient applies. */
export const IngredientP1 = Ingredient.extend({ quick_waste: QuickWasteSchema.optional() });

/**
 * Storno of a whole stock document (Ск1). `expected_balances` holds the balance revision of every
 * ingredient the document moved, as the dialog showed them (extra keys are ignored, as for
 * `produce`): a balance changed since then is a CONFLICT and the dialog shows the new preview.
 */
export const StockReverseCommand = z.strictObject({
  type: z.literal('stock_reverse'),
  document_id: z.uuid(),
  expected_balances: z.record(z.uuid(), revision),
});
/**
 * Every P1 command (design-bo-ui 5.3-5.7). Each one exists only while its flag is on (index.ts
 * p1Request, P1_COMMAND_FLAGS), so with the flag off it stays an unknown command: the menu links
 * and the storno ride stock v2; stock_settings and the queue commands also need
 * BACKOFFICE_STOCK_AUTOCONSUME_ENABLED; the manager shift commands
 * BACKOFFICE_MANAGER_SHIFTS_ENABLED; the list of positions BACKOFFICE_STAFF_POSITIONS_ENABLED.
 */
export const P1Command = z.discriminatedUnion('type', [
  StockReverseCommand,
  MenuLinkSaveCommand,
  MenuLinksApproveCommand,
  StockSettingsCommand,
  ConsumptionRetryCommand,
  ConsumptionSkipCommand,
  ManagerShiftOpenCommand,
  ManagerShiftSaveCommand,
  ManagerShiftCloseCommand,
  ManagerShiftTemplateCommand,
  StaffPositionsSaveCommand,
]);
/** P1 commands of the automatic consumption (BACKOFFICE_STOCK_AUTOCONSUME_ENABLED). */
export const AUTOCONSUME_COMMANDS: readonly string[] = Object.freeze([
  'stock_settings',
  'consumption_retry',
  'consumption_skip',
]);
/** The permission of each P1 command (design-bo-ui 4). */
export const P1_COMMAND_PERMISSIONS: Readonly<
  Record<z.infer<typeof P1Command>['type'], BackofficeP1Permission>
> = Object.freeze({
  stock_reverse: 'stock.reverse',
  menu_link_save: 'menu_links.write',
  menu_links_approve: 'menu_links.approve',
  stock_settings: 'stock.settings',
  consumption_retry: 'consumption.write',
  consumption_skip: 'consumption.write',
  manager_shift_open: 'manager_shifts.write',
  manager_shift_save: 'manager_shifts.write',
  manager_shift_close: 'manager_shifts.write',
  manager_shift_template: 'manager_shifts.template',
  staff_positions_save: 'staff.positions',
});
/** The back-office option each P1 command needs besides its own feature checks. */
export const P1_COMMAND_FLAGS: Readonly<
  Record<
    z.infer<typeof P1Command>['type'],
    readonly (
      | 'stockV2Enabled'
      | 'stockAutoconsumeEnabled'
      | 'managerShiftsEnabled'
      | 'staffPositionsEnabled'
    )[]
  >
> = Object.freeze({
  stock_reverse: ['stockV2Enabled'],
  menu_link_save: ['stockV2Enabled'],
  menu_links_approve: ['stockV2Enabled'],
  stock_settings: ['stockV2Enabled', 'stockAutoconsumeEnabled'],
  consumption_retry: ['stockV2Enabled', 'stockAutoconsumeEnabled'],
  consumption_skip: ['stockV2Enabled', 'stockAutoconsumeEnabled'],
  manager_shift_open: ['managerShiftsEnabled'],
  manager_shift_save: ['managerShiftsEnabled'],
  manager_shift_close: ['managerShiftsEnabled'],
  manager_shift_template: ['managerShiftsEnabled'],
  staff_positions_save: ['staffPositionsEnabled'],
});
export type P1CommandInput = z.infer<typeof P1Command>;
/** POST .../commands body of a P1 command (the same envelope as Request in model.ts). */
export const P1Request = z.strictObject({
  request_id: z.uuid(),
  reason: z.string().trim().min(3).max(500),
  command: P1Command,
});
export type P1RequestInput = z.infer<typeof P1Request>;
/** Document kinds a storno accepts: a count is corrected by a new count, a storno never again. */
export const REVERSIBLE_KINDS = ['receipt', 'waste', 'production', 'consumption'] as const;

/** The storno and source columns of a document row (GET branches/:id and ops/stock). */
const P1_LINK_COLUMNS = `d.source_ref,d.reverses_document_id,
  (SELECT r.id FROM bo_stock_documents r WHERE r.reverses_document_id=d.id AND r.branch_id=d.branch_id AND r.kind='reversal') reversed_by,
  (SELECT r.created_at FROM bo_stock_documents r WHERE r.reverses_document_id=d.id AND r.branch_id=d.branch_id AND r.kind='reversal') reversed_at,
  (SELECT jsonb_build_object('kind',o.kind,'reference',o.reference,'reason_code',o.reason_code,
     'created_at',to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   FROM bo_stock_documents o WHERE o.id=d.reverses_document_id AND o.branch_id=d.branch_id) reverses`;
const LINES = `coalesce((SELECT jsonb_agg(jsonb_build_object(
    'ingredient_id',m.ingredient_id,'name',r.payload->>'name','unit',r.payload->>'unit',
    'quantity_delta',m.quantity_delta::text,'value_delta_minor',m.value_delta_minor::text,
    'balance_after',m.balance_after::text,'value_after_minor',m.value_after_minor::text
  ) ORDER BY m.ingredient_id) FROM bo_stock_movements m
  JOIN bo_records r ON r.id=m.ingredient_id AND r.branch_id=m.branch_id AND r.kind='ingredient'
  WHERE m.document_id=d.id AND m.branch_id=d.branch_id),'[]'::jsonb) lines`;
/**
 * The last 200 documents of GET branches/:id with their P1 columns: the keys of the cloud lane's
 * list in the same order, then reason_code, meta, source_ref, reverses_document_id, reversed_by,
 * reversed_at and reverses ({kind, reference, reason_code, created_at} of the reversed document).
 */
export const P1_DOCUMENTS_SQL = `SELECT d.id,d.kind,d.reference,d.reason,d.order_id,d.created_at,d.actor_id,a.name actor_name,
  ${LINES},
  d.reason_code,d.meta,${P1_LINK_COLUMNS}
  FROM bo_stock_documents d JOIN catalog_managers a ON a.id=d.actor_id WHERE d.branch_id=$1 ORDER BY d.created_at DESC,d.id LIMIT 200`;

type Balance = { quantity: string; value_minor: string; revision: number };
async function balance(db: Db, branch: string, ingredient: string) {
  return (
    await db.query<Balance>(
      'SELECT quantity::text,value_minor::text,revision FROM bo_stock_balances WHERE branch_id=$1 AND ingredient_id=$2 FOR UPDATE',
      [branch, ingredient],
    )
  ).rows[0];
}

/**
 * Storno: one `reversal` document whose movements are exactly the opposite of the original's
 * (quantity and value). The caller holds the branch lock and the command envelope (request_id,
 * digest, audit). Throws BackofficeError:
 * NOT_FOUND (not a document of this branch), INVALID_REQUEST/REVERSAL_NOT_ALLOWED (a count, a
 * storno, a transfer or a document without movements), CONFLICT/ALREADY_REVERSED,
 * CONFLICT/COUNTED_AFTER_DOCUMENT (a count of one of its ingredients after it: the count already
 * holds the physical truth), CONFLICT (a balance changed since the dialog), INSUFFICIENT_STOCK
 * (the balance or its value is already below what the document added, e.g. a received item
 * that was used: never below zero, never a quantity of zero that still has a value).
 */
export async function reverseStockDocument(
  db: Db,
  branch: string,
  actor: string,
  reason: string,
  command: z.infer<typeof StockReverseCommand>,
) {
  const original = (
    await db.query<{ id: string; kind: string; reference: string; created_at: Date }>(
      'SELECT id,kind,reference,created_at FROM bo_stock_documents WHERE id=$1 AND branch_id=$2',
      [command.document_id, branch],
    )
  ).rows[0];
  if (!original) throw new BackofficeError('NOT_FOUND');
  if (!(REVERSIBLE_KINDS as readonly string[]).includes(original.kind))
    throw new BackofficeError('INVALID_REQUEST', 'REVERSAL_NOT_ALLOWED');
  if (
    (
      await db.query(
        "SELECT 1 FROM bo_stock_documents WHERE reverses_document_id=$1 AND branch_id=$2 AND kind='reversal'",
        [original.id, branch],
      )
    ).rowCount
  )
    throw new BackofficeError('CONFLICT', 'ALREADY_REVERSED');
  const moves = (
    await db.query<{ ingredient_id: string; quantity_delta: string; value_delta_minor: string }>(
      'SELECT ingredient_id,quantity_delta::text,value_delta_minor::text FROM bo_stock_movements WHERE document_id=$1 AND branch_id=$2 ORDER BY ingredient_id',
      [original.id, branch],
    )
  ).rows;
  if (!moves.length) throw new BackofficeError('INVALID_REQUEST', 'REVERSAL_NOT_ALLOWED');
  const ingredients = moves.map((m) => m.ingredient_id);
  if (
    (
      await db.query(
        `SELECT 1 FROM bo_stock_movements m JOIN bo_stock_documents d ON d.id=m.document_id AND d.branch_id=m.branch_id
         WHERE m.branch_id=$1 AND m.ingredient_id=ANY($2::uuid[]) AND d.kind='count' AND d.created_at > $3
         UNION ALL SELECT 1 FROM bo_stock_balances b
         WHERE b.branch_id=$1 AND b.ingredient_id=ANY($2::uuid[]) AND b.counted_at > $3 LIMIT 1`,
        [branch, ingredients, original.created_at],
      )
    ).rowCount
  )
    throw new BackofficeError('CONFLICT', 'COUNTED_AFTER_DOCUMENT');
  const effects: {
    ingredient: string;
    m: (typeof moves)[number];
    quantity: bigint;
    value: bigint;
  }[] = [];
  for (const m of moves) {
    const b = await balance(db, branch, m.ingredient_id);
    if (!b || b.revision !== command.expected_balances[m.ingredient_id])
      throw new BackofficeError('CONFLICT');
    const quantity = BigInt(b.quantity) - BigInt(m.quantity_delta),
      value = BigInt(b.value_minor) - BigInt(m.value_delta_minor);
    if (quantity < 0n || value < 0n || (quantity === 0n && value !== 0n))
      throw new BackofficeError('INSUFFICIENT_STOCK');
    if (quantity > LIMIT || value > LIMIT) throw new BackofficeError('INVALID_REQUEST');
    effects.push({ ingredient: m.ingredient_id, m, quantity, value });
  }
  const id = randomUUID();
  await db.query(
    "INSERT INTO bo_stock_documents(id,branch_id,actor_id,kind,reference,reason,reverses_document_id) VALUES($1,$2,$3,'reversal',$4,$5,$6)",
    [id, branch, actor, original.reference, reason, original.id],
  );
  for (const e of effects) {
    await db.query(
      'UPDATE bo_stock_balances SET quantity=$3,value_minor=$4,revision=revision+1 WHERE branch_id=$1 AND ingredient_id=$2',
      [branch, e.ingredient, e.quantity.toString(), e.value.toString()],
    );
    await db.query(
      'INSERT INTO bo_stock_movements(document_id,branch_id,ingredient_id,quantity_delta,value_delta_minor,balance_after,value_after_minor) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        id,
        branch,
        e.ingredient,
        (-BigInt(e.m.quantity_delta)).toString(),
        (-BigInt(e.m.value_delta_minor)).toString(),
        e.quantity.toString(),
        e.value.toString(),
      ],
    );
  }
  return {
    id,
    kind: 'reversal' as const,
    reference: original.reference,
    reverses_document_id: original.id,
  };
}

/**
 * A count moves counted_at of its ingredients to the time of the count document (never back: the
 * 075 trigger refuses it, greatest() keeps a later value). Stock P1 only; balance revisions are
 * not touched.
 */
export async function markCounted(db: Db, branch: string, document: string, ingredients: string[]) {
  await db.query(
    `UPDATE bo_stock_balances b SET counted_at=greatest(b.counted_at,d.created_at)
     FROM bo_stock_documents d
     WHERE d.id=$3 AND d.branch_id=$1 AND b.branch_id=$1 AND b.ingredient_id=ANY($2::uuid[])`,
    [branch, ingredients, document],
  );
}

/**
 * GET .../ops/stock with stock P1 (design-bo-ui 5.2). The same query and answer as the cloud
 * lane's readStockOps, plus:
 * - documents[] carry the P1 columns (reason_code and meta are there already, then source_ref,
 *   reverses_document_id, reversed_by, reversed_at, reverses);
 * - view=waste also takes the reversals of waste documents made in the window: each is a negative
 *   entry on the day of the storno, under the reason code and the author of the waste it reverses
 *   (so a waste reversed later stays in the closed days and the days add up to the period);
 *   `documents` counts the wastes, `reversals` the storno documents, `value_minor` is net;
 * - view=movement lists reversals as their own kind.
 */
export async function readStockOpsP1(db: Db, branch: string, input: unknown, now: Date) {
  const q = parse(StockOpsQuery, input);
  const { start, end } = periodWindow(
    { period: 'custom', start_date: q.start_date, end_date: q.end_date },
    now,
  );
  const args = [branch, start, end];
  const rows = async (sql: string) => (await db.query(sql, args)).rows;
  const scope =
    q.view === 'waste'
      ? `(d.kind='waste' OR (d.kind='reversal' AND EXISTS(SELECT 1 FROM bo_stock_documents w
           WHERE w.id=d.reverses_document_id AND w.branch_id=d.branch_id AND w.kind='waste')))`
      : 'true';
  const window = `d.branch_id=$1 AND d.created_at >= $2 AND d.created_at < $3 AND ${scope}`;
  const documents = await rows(
    `SELECT d.id,d.kind,d.reference,d.reason,d.reason_code,d.meta,d.order_id,d.created_at,d.actor_id,a.name actor_name,
      ${LINES},
      ${P1_LINK_COLUMNS}
     FROM bo_stock_documents d JOIN catalog_managers a ON a.id=d.actor_id
     WHERE ${window} ORDER BY d.created_at DESC,d.id LIMIT ${STOCK_OPS_DOCUMENT_LIMIT + 1}`,
  );
  // One row per document with its value effect; a reversal takes the reason and the author of
  // the document it reverses. Every summary below aggregates this set.
  const effects = `WITH docs AS (
      SELECT d.id,d.kind,(d.kind='reversal') reversal,
        coalesce(d.reason_code,o.reason_code) reason_code,coalesce(o.actor_id,d.actor_id) actor_id,
        (d.created_at AT TIME ZONE 'Asia/Almaty')::date AS day,
        coalesce((SELECT sum(m.value_delta_minor) FROM bo_stock_movements m WHERE m.document_id=d.id AND m.branch_id=d.branch_id),0) AS value_delta
      FROM bo_stock_documents d
      LEFT JOIN bo_stock_documents o ON o.id=d.reverses_document_id AND o.branch_id=d.branch_id
      WHERE ${window})`;
  const counts = `count(*) FILTER(WHERE NOT reversal)::int documents,count(*) FILTER(WHERE reversal)::int reversals`;
  const totals = (
    await rows(
      `${effects} SELECT ${counts},coalesce(sum(-value_delta),0)::text value_minor,
        coalesce(sum(value_delta),0)::text value_delta_minor,count(*)::int all_documents FROM docs`,
    )
  )[0];
  const byDay = await rows(
    `${effects} SELECT day::text AS day,${counts},count(*)::int all_documents,coalesce(sum(-value_delta),0)::text value_minor,
      coalesce(sum(value_delta),0)::text value_delta_minor FROM docs GROUP BY day ORDER BY day`,
  );
  const summary =
    q.view === 'waste'
      ? {
          by_reason: await rows(
            `${effects} SELECT reason_code,${counts},coalesce(sum(-value_delta),0)::text value_minor
             FROM docs GROUP BY reason_code ORDER BY reason_code NULLS LAST`,
          ),
          by_day: byDay.map(({ day, documents, reversals, value_minor }) => ({
            day,
            documents,
            reversals,
            value_minor,
          })),
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
            `${effects} SELECT d.actor_id,a.name actor_name,${counts},coalesce(sum(-d.value_delta),0)::text value_minor
             FROM docs d JOIN catalog_managers a ON a.id=d.actor_id GROUP BY d.actor_id,a.name ORDER BY a.name,d.actor_id`,
          ),
        }
      : {
          by_kind: await rows(
            `${effects} SELECT kind,count(*)::int documents,coalesce(sum(value_delta),0)::text value_delta_minor
             FROM docs GROUP BY kind ORDER BY kind`,
          ),
          by_day: byDay.map(({ day, all_documents, value_delta_minor }) => ({
            day,
            documents: all_documents,
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
        ? {
            documents: totals.documents,
            value_minor: totals.value_minor,
            reversals: totals.reversals,
          }
        : { documents: totals.all_documents, value_delta_minor: totals.value_delta_minor },
    summary,
    documents: documents.slice(0, STOCK_OPS_DOCUMENT_LIMIT),
    truncated: documents.length > STOCK_OPS_DOCUMENT_LIMIT,
    limits: { documents: STOCK_OPS_DOCUMENT_LIMIT },
  };
}
