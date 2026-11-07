import { z } from 'zod';
import type { DatabaseClient } from '@pickchick/database';
import {
  BackofficeError,
  StockReceiptMetaSchema,
  parse,
  periodWindow,
  type StockReceiptMeta,
} from './model.js';
import { stockWindowValid } from './stock-v2.js';

/**
 * Suppliers, their prices and supply requests (Ск6, Ск3; lane bo-ui2 step 2, owner decision 06.11;
 * design-bo-ui.md «Вторая волна» §9.2-§9.4, design-backoffice.md section 2 Ск6).
 *
 * Everything here runs only behind BACKOFFICE_SUPPLY_ENABLED (with stock v2) and only while the
 * API role holds the cloud076 rights of infra/staging/backoffice-supply-grants.mjs and writes the
 * cloud074 receipt columns (p2-flags.ts supplyAvailable). The commands are parsed by their own
 * schema (p2-commands.ts), so with the flag off they stay unknown commands, and each runs in the
 * shared envelope of index.ts (request_id, digest, bo_audit with before and after, the branch
 * lock) and checks `expected_revision`.
 *
 * - Suppliers: name 1..120 (spaces collapsed), unique in the branch regardless of case, kind
 *   supplier | central_kitchen | bakery fixed at creation, archived with active=false (never
 *   deleted; an archived supplier takes no new price and no new request).
 * - Prices: one purchase unit (g, kg, ml, l, pcs) of an ingredient from a supplier from an Almaty
 *   day on; the unit must measure the ingredient (kg and g for grams, ...). The price in force on
 *   day D is the row with the greatest valid_from <= D. A correction raises the revision; the
 *   audit keeps the price before it.
 * - Requests: to the central kitchen, the bakery, for household goods or to a supplier. A request
 *   is a draft until it is submitted; the server writes each line's unit, the balance at the
 *   moment, the hint «минимум - остаток» (null without a minimum) and, with a supplier, the
 *   expected amount by the price in force today (half up, one rounding per line). Submitting
 *   takes the balances and prices of that moment and freezes the lines. Nothing is sent anywhere:
 *   the cabinet prints and copies the text. Receiving posts the stock v2 receipt of the request
 *   in the same transaction (where from = the request kind, the supplier's name, the invoice
 *   number and date; the actual quantities and amounts, which may differ from the request) and
 *   links it exactly once; cancelling keeps the reason in the audit.
 */

type Db = Pick<DatabaseClient, 'query'>;
export const SUPPLIER_KINDS = ['supplier', 'central_kitchen', 'bakery'] as const;
export type SupplierKind = (typeof SUPPLIER_KINDS)[number];
export const SUPPLY_REQUEST_KINDS = ['central_kitchen', 'bakery', 'household', 'supplier'] as const;
export type SupplyRequestKind = (typeof SUPPLY_REQUEST_KINDS)[number];
export const SUPPLY_REQUEST_STATES = ['draft', 'submitted', 'received', 'cancelled'] as const;
export type SupplyRequestState = (typeof SUPPLY_REQUEST_STATES)[number];
export const SUPPLIER_PRICE_UNITS = ['g', 'kg', 'ml', 'l', 'pcs'] as const;
export type SupplierPriceUnit = (typeof SUPPLIER_PRICE_UNITS)[number];
/** Accounting units (the ingredient's unit) in one purchase unit. */
export const PRICE_UNIT_FACTOR: Readonly<Record<SupplierPriceUnit, bigint>> = Object.freeze({
  g: 1n,
  kg: 1000n,
  ml: 1n,
  l: 1000n,
  pcs: 1n,
});
/** The ingredient unit a purchase unit measures. */
export const PRICE_UNIT_MEASURES: Readonly<Record<SupplierPriceUnit, 'g' | 'ml' | 'pcs'>> =
  Object.freeze({ g: 'g', kg: 'g', ml: 'ml', l: 'ml', pcs: 'pcs' });
/** Who delivers a request of a kind (cloud076 guard_bo_supply_request). */
export const supplierKindFor = (kind: SupplyRequestKind): SupplierKind =>
  kind === 'central_kitchen' || kind === 'bakery' ? kind : 'supplier';
export const SUPPLIER_LIST_LIMIT = 500;
export const SUPPLIER_PRICE_LIMIT = 1000;
export const SUPPLIER_IMPORT_LIMIT = 50;
export const SUPPLY_REQUEST_LIMIT = 200;
export const SUPPLY_REQUEST_LINES = 100;
export const SUPPLY_NOTE_MAX = 500;
export const SUPPLIER_NAME_MAX = 120;

const revision = z.number().int().min(0).max(2147483646);
const positive = z.string().regex(/^[1-9][0-9]{0,14}$/);
const amount = z.string().regex(/^(0|[1-9][0-9]{0,14})$/);
/** An Almaty calendar day within the cloud076 bounds. */
const day = z.iso
  .date()
  .refine(
    (v) =>
      v >= '2024-01-01' &&
      v <= '2099-12-31' &&
      new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v,
  );
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const NOTE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const distinct = (values: readonly unknown[]) => new Set(values).size === values.length;
/** A supplier name: spaces collapsed and trimmed, 1..120, no control characters. */
export const SupplierNameSchema = z
  .string()
  .max(1000)
  .transform((v) => v.replace(/\s+/g, ' ').trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(SUPPLIER_NAME_MAX)
      .refine((v) => !CONTROL.test(v)),
  );
export const SupplierPayloadSchema = z.strictObject({
  name: SupplierNameSchema,
  kind: z.enum(SUPPLIER_KINDS),
  active: z.boolean(),
});
/** Create (expected_revision 0, a new id from the cabinet), edit or archive a supplier. */
export const SupplierSaveCommand = z.strictObject({
  type: z.literal('supplier_save'),
  id: z.uuid(),
  expected_revision: revision,
  payload: SupplierPayloadSchema,
});
/**
 * Enter the price of one purchase unit from `valid_from` on (expected_revision 0), or correct
 * that row (its revision).
 */
export const SupplierPriceSaveCommand = z.strictObject({
  type: z.literal('supplier_price_save'),
  supplier_id: z.uuid(),
  ingredient_id: z.uuid(),
  unit: z.enum(SUPPLIER_PRICE_UNITS),
  valid_from: day,
  price_minor: positive,
  expected_revision: revision,
});
const NoteSchema = z
  .string()
  .trim()
  .max(SUPPLY_NOTE_MAX)
  .refine((v) => !NOTE_CONTROL.test(v))
  .nullable()
  .default(null)
  .transform((v) => (v === '' ? null : v));
export const SupplyRequestLineInput = z.strictObject({ ingredient_id: z.uuid(), qty: positive });
export const SupplyRequestPayloadSchema = z.strictObject({
  kind: z.enum(SUPPLY_REQUEST_KINDS),
  supplier_id: z.uuid().nullable().default(null),
  needed_by: day.nullable().default(null),
  note: NoteSchema,
  lines: z
    .array(SupplyRequestLineInput)
    .max(SUPPLY_REQUEST_LINES)
    .refine((v) => distinct(v.map((l) => l.ingredient_id.toLowerCase()))),
});
export type SupplyRequestPayload = z.infer<typeof SupplyRequestPayloadSchema>;
/** Create (expected_revision 0) or edit a draft request; the kind is fixed at creation. */
export const SupplyRequestSaveCommand = z.strictObject({
  type: z.literal('supply_request_save'),
  id: z.uuid(),
  expected_revision: revision,
  payload: SupplyRequestPayloadSchema,
});
export const SupplyRequestSubmitCommand = z.strictObject({
  type: z.literal('supply_request_submit'),
  id: z.uuid(),
  expected_revision: revision.min(1),
});
/** The reason is the command's `reason` (kept in bo_audit and shown with the request). */
export const SupplyRequestCancelCommand = z.strictObject({
  type: z.literal('supply_request_cancel'),
  id: z.uuid(),
  expected_revision: revision.min(1),
});
/**
 * Receive a submitted request: the stock receipt with the actual quantities (accounting units)
 * and the amounts of each line in whole tiyn, with the balance revision the dialog showed, like
 * the lines of the stock command. Lines may differ from the request (a partial delivery).
 */
export const SupplyRequestReceiveCommand = z.strictObject({
  type: z.literal('supply_request_receive'),
  id: z.uuid(),
  expected_revision: revision.min(1),
  reference: z.string().trim().min(1).max(200),
  document_date: day,
  lines: z
    .array(
      z.strictObject({
        ingredient_id: z.uuid(),
        quantity: positive,
        value_minor: amount,
        expected_revision: revision,
      }),
    )
    .min(1)
    .max(SUPPLY_REQUEST_LINES)
    .refine((v) => distinct(v.map((l) => l.ingredient_id.toLowerCase()))),
});
export type SupplyCommandInput =
  | z.infer<typeof SupplierSaveCommand>
  | z.infer<typeof SupplierPriceSaveCommand>
  | z.infer<typeof SupplyRequestSaveCommand>
  | z.infer<typeof SupplyRequestSubmitCommand>
  | z.infer<typeof SupplyRequestCancelCommand>
  | z.infer<typeof SupplyRequestReceiveCommand>;
export type SupplyReceiveLine = z.infer<typeof SupplyRequestReceiveCommand>['lines'][number];
/**
 * Posts the stock receipt of a request (index.ts: the stock command's own code, so the movements
 * and the average cost are exactly those of a «Поставка»). Answers the new document id.
 */
export type SupplyReceipt = (
  reference: string,
  lines: SupplyReceiveLine[],
  meta: StockReceiptMeta,
) => Promise<{ id: string }>;

// --------------------------------------------------------------------------- helpers ----

/** The Almaty calendar day of an instant (YYYY-MM-DD). */
export function almatyDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Almaty',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}
/** The expected amount of a line: quantity × price of one purchase unit, half up, once. */
export function expectedAmount(qty: string, price: string, unit: SupplierPriceUnit): bigint {
  const factor = PRICE_UNIT_FACTOR[unit];
  return (2n * BigInt(qty) * BigInt(price) + factor) / (2n * factor);
}
/** «минимум - остаток», never below zero; null when the ingredient has no minimum. */
export function supplyHint(minimum: string, balance: string): string | null {
  const m = BigInt(minimum);
  if (m <= 0n) return null;
  const b = BigInt(balance);
  return (m > b ? m - b : 0n).toString();
}
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null ? null : String(v));
/** JSON with sorted object keys (jsonb reorders keys), for "nothing changed". */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value === undefined ? null : value);
}

// ------------------------------------------------------------------------- suppliers ----

type SupplierRow = {
  id: string;
  name: string;
  kind: SupplierKind;
  active: boolean;
  revision: number;
  prices: number;
  last_valid_from: string | null;
  created_by_name: string | null;
  created_at: Date;
  updated_by_name: string | null;
  updated_at: Date;
};
const SUPPLIER_COLUMNS = `s.id,s.name,s.kind,s.active,s.revision,
  (SELECT count(*)::int FROM bo_supplier_prices p WHERE p.supplier_id=s.id AND p.branch_id=s.branch_id) prices,
  (SELECT max(p.valid_from)::text FROM bo_supplier_prices p WHERE p.supplier_id=s.id AND p.branch_id=s.branch_id) last_valid_from,
  c.name created_by_name,s.created_at,u.name updated_by_name,s.updated_at
  FROM bo_suppliers s LEFT JOIN catalog_managers c ON c.id=s.created_by
  LEFT JOIN catalog_managers u ON u.id=s.updated_by`;
export function supplierView(row: SupplierRow) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    active: row.active,
    revision: row.revision,
    prices: row.prices,
    last_valid_from: row.last_valid_from,
    created_by_name: row.created_by_name,
    created_at: iso(row.created_at),
    updated_by_name: row.updated_by_name,
    updated_at: iso(row.updated_at),
  };
}
export type SupplierView = ReturnType<typeof supplierView>;
async function supplierRow(db: Db, branch: string, id: string, lock = false) {
  return (
    await db.query<SupplierRow>(
      `SELECT ${SUPPLIER_COLUMNS} WHERE s.branch_id=$1 AND s.id=$2${lock ? ' FOR UPDATE OF s' : ''}`,
      [branch, id],
    )
  ).rows[0];
}
async function saveSupplier(
  db: Db,
  branch: string,
  actor: string,
  c: z.infer<typeof SupplierSaveCommand>,
) {
  const old = await supplierRow(db, branch, c.id, true);
  const before = old ? supplierView(old) : null;
  if ((old?.revision ?? 0) !== c.expected_revision) throw new BackofficeError('CONFLICT');
  const p = c.payload;
  // The kind never changes: the requests and prices of a supplier depend on it.
  if (old && old.kind !== p.kind) throw new BackofficeError('INVALID_REQUEST');
  if (old && old.name === p.name && old.active === p.active) return { result: before!, before };
  if (
    (
      await db.query(
        'SELECT 1 FROM bo_suppliers WHERE branch_id=$1 AND lower(name)=lower($2) AND id<>$3',
        [branch, p.name, c.id],
      )
    ).rowCount
  )
    throw new BackofficeError('CONFLICT', 'SUPPLIER_NAME_TAKEN');
  if (!old)
    await db.query(
      `INSERT INTO bo_suppliers(id,branch_id,name,kind,active,revision,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5,1,$6,$6)`,
      [c.id, branch, p.name, p.kind, p.active, actor],
    );
  else
    await db.query(
      `UPDATE bo_suppliers SET name=$3,active=$4,revision=revision+1,updated_by=$5,
         updated_at=clock_timestamp() WHERE branch_id=$1 AND id=$2`,
      [branch, c.id, p.name, p.active, actor],
    );
  return { result: supplierView((await supplierRow(db, branch, c.id))!), before };
}

type PriceRow = {
  supplier_id: string;
  ingredient_id: string;
  ingredient_name: string | null;
  ingredient_unit: string | null;
  unit: SupplierPriceUnit;
  price_minor: string;
  valid_from: string;
  in_force: boolean | null;
  source: 'manual' | 'import';
  import_batch_id: string | null;
  revision: number;
  updated_by_name: string | null;
  updated_at: Date;
};
/** $3 is the Almaty day the `in_force` mark is computed for. */
const PRICE_COLUMNS = `p.supplier_id,p.ingredient_id,r.payload->>'name' ingredient_name,
  r.payload->>'unit' ingredient_unit,p.unit,p.price_minor::text,p.valid_from::text,
  p.valid_from=(SELECT max(q.valid_from) FROM bo_supplier_prices q WHERE q.branch_id=p.branch_id
    AND q.supplier_id=p.supplier_id AND q.ingredient_id=p.ingredient_id AND q.unit=p.unit
    AND q.valid_from <= $3::date) in_force,
  p.source,p.import_batch_id,p.revision,u.name updated_by_name,p.updated_at
  FROM bo_supplier_prices p
  JOIN bo_records r ON r.branch_id=p.branch_id AND r.kind='ingredient' AND r.id=p.ingredient_id
  LEFT JOIN catalog_managers u ON u.id=p.updated_by`;
export function priceView(row: PriceRow) {
  return {
    supplier_id: row.supplier_id,
    ingredient_id: row.ingredient_id,
    ingredient_name: row.ingredient_name,
    ingredient_unit: row.ingredient_unit,
    unit: row.unit,
    price_minor: row.price_minor,
    valid_from: row.valid_from,
    in_force: row.in_force === true,
    source: row.source,
    import_batch_id: row.import_batch_id,
    revision: row.revision,
    updated_by_name: row.updated_by_name,
    updated_at: iso(row.updated_at),
  };
}
export type SupplierPriceView = ReturnType<typeof priceView>;
async function priceRow(
  db: Db,
  branch: string,
  c: Pick<
    z.infer<typeof SupplierPriceSaveCommand>,
    'supplier_id' | 'ingredient_id' | 'unit' | 'valid_from'
  >,
  today: string,
  lock = false,
) {
  return (
    await db.query<PriceRow>(
      `SELECT ${PRICE_COLUMNS} WHERE p.branch_id=$1 AND p.supplier_id=$2 AND p.ingredient_id=$4
         AND p.unit=$5 AND p.valid_from=$6::date${lock ? ' FOR UPDATE OF p' : ''}`,
      [branch, c.supplier_id, today, c.ingredient_id, c.unit, c.valid_from],
    )
  ).rows[0];
}
async function ingredientRow(db: Db, branch: string, id: string) {
  return (
    await db.query<{ id: string; payload: Record<string, unknown> }>(
      "SELECT id::text,payload FROM bo_records WHERE branch_id=$1 AND kind='ingredient' AND id=$2",
      [branch, id],
    )
  ).rows[0];
}
async function savePrice(
  db: Db,
  branch: string,
  actor: string,
  c: z.infer<typeof SupplierPriceSaveCommand>,
  today: string,
) {
  const supplier = (
    await db.query<{ active: boolean }>(
      'SELECT active FROM bo_suppliers WHERE branch_id=$1 AND id=$2 FOR SHARE',
      [branch, c.supplier_id],
    )
  ).rows[0];
  if (!supplier) throw new BackofficeError('NOT_FOUND');
  if (!supplier.active) throw new BackofficeError('CONFLICT', 'SUPPLIER_INACTIVE');
  const ingredient = await ingredientRow(db, branch, c.ingredient_id);
  if (!ingredient) throw new BackofficeError('NOT_FOUND');
  if (PRICE_UNIT_MEASURES[c.unit] !== ingredient.payload['unit'])
    throw new BackofficeError('INVALID_REQUEST', 'PRICE_UNIT_MISMATCH');
  const old = await priceRow(db, branch, c, today, true);
  const before = old ? priceView(old) : null;
  if ((old?.revision ?? 0) !== c.expected_revision) throw new BackofficeError('CONFLICT');
  if (old && old.price_minor === c.price_minor && old.source === 'manual')
    return { result: before!, before };
  if (!old)
    await db.query(
      `INSERT INTO bo_supplier_prices(branch_id,supplier_id,ingredient_id,unit,price_minor,valid_from,
         source,revision,updated_by) VALUES($1,$2,$3,$4,$5,$6::date,'manual',1,$7)`,
      [branch, c.supplier_id, c.ingredient_id, c.unit, c.price_minor, c.valid_from, actor],
    );
  // A manual correction of an imported price is a manual price from then on.
  else
    await db.query(
      `UPDATE bo_supplier_prices SET price_minor=$6,source='manual',import_batch_id=NULL,
         revision=revision+1,updated_by=$7,updated_at=clock_timestamp()
       WHERE branch_id=$1 AND supplier_id=$2 AND ingredient_id=$3 AND unit=$4 AND valid_from=$5::date`,
      [branch, c.supplier_id, c.ingredient_id, c.unit, c.valid_from, c.price_minor, actor],
    );
  return { result: priceView((await priceRow(db, branch, c, today))!), before };
}

export const SuppliersQuery = z.strictObject({ id: z.uuid().optional() });
/**
 * GET .../ops/suppliers[?id=uuid] (design-bo-ui 9.4): the suppliers of the branch, active ones
 * first, by name. With `id` also the prices of that supplier (by ingredient, unit and day, newest
 * first; `in_force` marks the price in force today) and the imports its prices came from.
 */
export async function readSuppliers(db: Db, branch: string, input: unknown, now: Date) {
  const q = parse(SuppliersQuery, input);
  const today = almatyDay(now);
  const rows = (
    await db.query<SupplierRow>(
      `SELECT ${SUPPLIER_COLUMNS} WHERE s.branch_id=$1
       ORDER BY s.active DESC,lower(s.name),s.id LIMIT ${SUPPLIER_LIST_LIMIT + 1}`,
      [branch],
    )
  ).rows;
  let detail: Record<string, unknown> = {};
  if (q.id) {
    if (!(await supplierRow(db, branch, q.id))) throw new BackofficeError('NOT_FOUND');
    const prices = (
      await db.query<PriceRow>(
        `SELECT ${PRICE_COLUMNS} WHERE p.branch_id=$1 AND p.supplier_id=$2
         ORDER BY lower(r.payload->>'name'),p.ingredient_id,p.unit,p.valid_from DESC
         LIMIT ${SUPPLIER_PRICE_LIMIT + 1}`,
        [branch, q.id, today],
      )
    ).rows;
    const imports = (
      await db.query<{
        id: string;
        source: string;
        file_sha256: string;
        plan_sha256: string;
        row_count: number;
        summary: unknown;
        actor_name: string | null;
        applied_at: Date;
      }>(
        `SELECT i.id,i.source,i.file_sha256,i.plan_sha256,i.row_count,i.summary,m.name actor_name,i.applied_at
         FROM bo_supplier_price_imports i LEFT JOIN catalog_managers m ON m.id=i.actor_id
         WHERE i.branch_id=$1 AND i.id IN (SELECT p.import_batch_id FROM bo_supplier_prices p
           WHERE p.branch_id=$1 AND p.supplier_id=$2 AND p.import_batch_id IS NOT NULL)
         ORDER BY i.applied_at DESC,i.id LIMIT ${SUPPLIER_IMPORT_LIMIT}`,
        [branch, q.id],
      )
    ).rows;
    detail = {
      id: q.id,
      prices: prices.slice(0, SUPPLIER_PRICE_LIMIT).map(priceView),
      prices_truncated: prices.length > SUPPLIER_PRICE_LIMIT,
      imports: imports.map((i) => ({ ...i, applied_at: iso(i.applied_at) })),
    };
  }
  return {
    schema_version: 1 as const,
    branch_id: branch,
    view: 'suppliers' as const,
    timezone: 'Asia/Almaty' as const,
    as_of: now.toISOString(),
    today,
    suppliers: rows.slice(0, SUPPLIER_LIST_LIMIT).map(supplierView),
    limits: { suppliers: SUPPLIER_LIST_LIMIT, prices: SUPPLIER_PRICE_LIMIT },
    truncated: { suppliers: rows.length > SUPPLIER_LIST_LIMIT },
    ...detail,
  };
}

// -------------------------------------------------------------------------- requests ----

/** One stored line of a request (cloud076 jsonpath check). */
export type SupplyLine = {
  ingredient_id: string;
  unit: 'g' | 'ml' | 'pcs';
  qty: string;
  balance_at_request: string;
  hint: string | null;
  price_minor?: string;
};
const StoredLine = z.object({
  ingredient_id: z.string(),
  unit: z.enum(['g', 'ml', 'pcs']),
  qty: z.string(),
  balance_at_request: z.string(),
  hint: z.string().nullable().optional(),
  price_minor: z.string().optional(),
});
const storedLines = (value: unknown): SupplyLine[] => {
  const parsed = z.array(StoredLine).safeParse(value);
  return parsed.success
    ? parsed.data.map((l) => ({
        ingredient_id: l.ingredient_id,
        unit: l.unit,
        qty: l.qty,
        balance_at_request: l.balance_at_request,
        hint: l.hint ?? null,
        ...(l.price_minor === undefined ? {} : { price_minor: l.price_minor }),
      }))
    : [];
};
/**
 * The stored lines of a request: each ingredient of the branch (active), its unit, its balance
 * now, the hint and, with a supplier, the expected amount by the price in force on `today`.
 */
async function buildLines(
  db: Db,
  branch: string,
  supplier: string | null,
  lines: readonly { ingredient_id: string; qty: string }[],
  today: string,
): Promise<SupplyLine[]> {
  if (!lines.length) return [];
  const ids = lines.map((l) => l.ingredient_id.toLowerCase());
  const items = new Map(
    (
      await db.query<{ id: string; payload: Record<string, unknown>; quantity: string }>(
        `SELECT r.id::text,r.payload,coalesce(b.quantity,0)::text quantity FROM bo_records r
         LEFT JOIN bo_stock_balances b ON b.branch_id=r.branch_id AND b.ingredient_id=r.id
         WHERE r.branch_id=$1 AND r.kind='ingredient' AND r.id=ANY($2::uuid[])`,
        [branch, ids],
      )
    ).rows.map((r) => [r.id, r]),
  );
  const prices = new Map(
    supplier
      ? (
          await db.query<{ ingredient_id: string; unit: SupplierPriceUnit; price_minor: string }>(
            `SELECT DISTINCT ON (ingredient_id) ingredient_id::text,unit,price_minor::text
             FROM bo_supplier_prices WHERE branch_id=$1 AND supplier_id=$2
               AND ingredient_id=ANY($3::uuid[]) AND valid_from <= $4::date
             ORDER BY ingredient_id,valid_from DESC,unit`,
            [branch, supplier, ids, today],
          )
        ).rows.map((r) => [r.ingredient_id, r])
      : [],
  );
  return lines.map((line, i) => {
    const item = items.get(ids[i]!);
    const unit = item?.payload['unit'];
    if (
      !item ||
      item.payload['active'] !== true ||
      (unit !== 'g' && unit !== 'ml' && unit !== 'pcs')
    )
      throw new BackofficeError('INVALID_REQUEST');
    const minimum = /^(0|[1-9][0-9]{0,14})$/.test(String(item.payload['minimum']))
      ? String(item.payload['minimum'])
      : '0';
    const price = prices.get(ids[i]!);
    const expected = price ? expectedAmount(line.qty, price.price_minor, price.unit) : 0n;
    return {
      ingredient_id: ids[i]!,
      unit,
      qty: line.qty,
      balance_at_request: item.quantity,
      hint: supplyHint(minimum, item.quantity),
      ...(expected > 0n ? { price_minor: expected.toString() } : {}),
    };
  });
}
type RequestRow = {
  id: string;
  number: number;
  kind: SupplyRequestKind;
  state: SupplyRequestState;
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_kind: SupplierKind | null;
  supplier_active: boolean | null;
  needed_by: string | null;
  note: string | null;
  lines: unknown;
  receipt_document_id: string | null;
  revision: number;
  created_by_name: string | null;
  created_at: Date;
  submitted_by_name: string | null;
  submitted_at: Date | null;
  closed_by_name: string | null;
  closed_at: Date | null;
};
const REQUEST_COLUMNS = `q.id,q.number,q.kind,q.state,q.supplier_id,s.name supplier_name,
  s.kind supplier_kind,s.active supplier_active,q.needed_by::text,q.note,q.lines,
  q.receipt_document_id,q.revision,c.name created_by_name,q.created_at,
  sb.name submitted_by_name,q.submitted_at,cb.name closed_by_name,q.closed_at
  FROM bo_supply_requests q
  LEFT JOIN bo_suppliers s ON s.id=q.supplier_id AND s.branch_id=q.branch_id
  LEFT JOIN catalog_managers c ON c.id=q.created_by
  LEFT JOIN catalog_managers sb ON sb.id=q.submitted_by
  LEFT JOIN catalog_managers cb ON cb.id=q.closed_by`;
type Names = Map<string, { name: string; unit: string }>;
async function ingredientNames(db: Db, branch: string, ids: readonly string[]): Promise<Names> {
  if (!ids.length) return new Map();
  return new Map(
    (
      await db.query<{ id: string; name: string; unit: string }>(
        `SELECT id::text,payload->>'name' AS name,payload->>'unit' AS unit FROM bo_records
         WHERE branch_id=$1 AND kind='ingredient' AND id=ANY($2::uuid[])`,
        [branch, [...new Set(ids)]],
      )
    ).rows.map((r) => [r.id, { name: r.name, unit: r.unit }]),
  );
}
export function requestView(row: RequestRow, names: Names, cancelReason: string | null = null) {
  const lines = storedLines(row.lines).map((l) => ({
    ingredient_id: l.ingredient_id,
    name: names.get(l.ingredient_id)?.name ?? null,
    unit: l.unit,
    qty: l.qty,
    balance_at_request: l.balance_at_request,
    hint: l.hint,
    price_minor: l.price_minor ?? null,
  }));
  const priced = lines.filter((l) => l.price_minor !== null);
  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    state: row.state,
    supplier: row.supplier_id
      ? {
          id: row.supplier_id,
          name: row.supplier_name ?? '',
          kind: row.supplier_kind ?? 'supplier',
          active: row.supplier_active === true,
        }
      : null,
    needed_by: row.needed_by,
    note: row.note,
    lines,
    /** The expected amount of the priced lines; null when no line has a price. */
    total_minor: priced.length
      ? priced.reduce((sum, l) => sum + BigInt(l.price_minor!), 0n).toString()
      : null,
    unpriced_lines: row.supplier_id ? lines.length - priced.length : null,
    receipt_document_id: row.receipt_document_id,
    revision: row.revision,
    created_by_name: row.created_by_name,
    created_at: iso(row.created_at),
    submitted_by_name: row.submitted_by_name,
    submitted_at: iso(row.submitted_at),
    closed_by_name: row.closed_by_name,
    closed_at: iso(row.closed_at),
    cancel_reason: row.state === 'cancelled' ? cancelReason : null,
  };
}
export type SupplyRequestView = ReturnType<typeof requestView>;
/** Names shown with a row of the list (the full lines come with `id`). */
export const SUPPLY_LIST_LINE_NAMES = 3;
/**
 * A request as the list shows it: everything but the lines, which come with `id` (the list of
 * 200 requests stays small, under the 1 MB the cabinet accepts): their count and the first names.
 */
export function requestListRow(view: SupplyRequestView) {
  const { lines, ...rest } = view;
  return {
    ...rest,
    line_count: lines.length,
    line_names: lines.slice(0, SUPPLY_LIST_LINE_NAMES).map((l) => l.name),
  };
}
async function requestRow(db: Db, branch: string, id: string, lock = false) {
  return (
    await db.query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} WHERE q.branch_id=$1 AND q.id=$2${lock ? ' FOR UPDATE OF q' : ''}`,
      [branch, id],
    )
  ).rows[0];
}
/** The latest cancel reason of each listed cancelled request (bo_audit of the command). */
async function cancelReasons(db: Db, branch: string, rows: readonly RequestRow[]) {
  const ids = rows.filter((r) => r.state === 'cancelled').map((r) => r.id);
  if (!ids.length) return new Map<string, string>();
  return new Map(
    (
      await db.query<{ entity_id: string; reason: string }>(
        `SELECT DISTINCT ON (entity_id) entity_id::text,reason FROM bo_audit
         WHERE branch_id=$1 AND action='supply_request_cancel' AND entity_id=ANY($2::uuid[])
         ORDER BY entity_id,created_at DESC,id DESC`,
        [branch, ids],
      )
    ).rows.map((r) => [r.entity_id, r.reason]),
  );
}
async function viewOf(db: Db, branch: string, id: string, cancelReason: string | null = null) {
  const row = (await requestRow(db, branch, id))!;
  const names = await ingredientNames(
    db,
    branch,
    storedLines(row.lines).map((l) => l.ingredient_id),
  );
  return requestView(
    row,
    names,
    cancelReason ?? (await cancelReasons(db, branch, [row])).get(row.id) ?? null,
  );
}
/** The supplier of a request: of this branch, delivering this kind, active. */
async function assertSupplier(db: Db, branch: string, id: string, kind: SupplyRequestKind) {
  const s = (
    await db.query<{ kind: SupplierKind; active: boolean }>(
      'SELECT kind,active FROM bo_suppliers WHERE branch_id=$1 AND id=$2 FOR SHARE',
      [branch, id],
    )
  ).rows[0];
  if (!s) throw new BackofficeError('NOT_FOUND');
  if (s.kind !== supplierKindFor(kind)) throw new BackofficeError('INVALID_REQUEST');
  if (!s.active) throw new BackofficeError('CONFLICT', 'SUPPLIER_INACTIVE');
}
const lineInput = (lines: readonly SupplyLine[]) =>
  lines.map((l) => ({ ingredient_id: l.ingredient_id, qty: l.qty }));

async function saveRequest(
  db: Db,
  branch: string,
  actor: string,
  c: z.infer<typeof SupplyRequestSaveCommand>,
  today: string,
) {
  const old = await requestRow(db, branch, c.id, true);
  const before = old ? await viewOf(db, branch, c.id) : null;
  if ((old?.revision ?? 0) !== c.expected_revision) throw new BackofficeError('CONFLICT');
  if (old && old.state !== 'draft') throw new BackofficeError('CONFLICT', 'REQUEST_LOCKED');
  const p = c.payload;
  if (old && old.kind !== p.kind) throw new BackofficeError('INVALID_REQUEST');
  const supplier = p.supplier_id?.toLowerCase() ?? null;
  // Unchanged supplier, date, note and lines: nothing to do (the balances are not refreshed).
  if (
    old &&
    canonical({
      supplier: old.supplier_id,
      needed_by: old.needed_by,
      note: old.note,
      lines: lineInput(storedLines(old.lines)),
    }) ===
      canonical({
        supplier,
        needed_by: p.needed_by,
        note: p.note,
        lines: p.lines.map((l) => ({ ingredient_id: l.ingredient_id.toLowerCase(), qty: l.qty })),
      })
  )
    return { result: before!, before };
  if (supplier) await assertSupplier(db, branch, supplier, p.kind);
  const lines = await buildLines(db, branch, supplier, p.lines, today);
  if (!old) {
    const number = (
      await db.query<{ n: number }>(
        'SELECT coalesce(max(number),0)+1 AS n FROM bo_supply_requests WHERE branch_id=$1',
        [branch],
      )
    ).rows[0]!.n;
    await db.query(
      `INSERT INTO bo_supply_requests(id,branch_id,number,kind,state,supplier_id,needed_by,note,lines,
         revision,created_by,updated_by)
       VALUES($1,$2,$3,$4,'draft',$5,$6::date,$7,$8::jsonb,1,$9,$9)`,
      [c.id, branch, number, p.kind, supplier, p.needed_by, p.note, JSON.stringify(lines), actor],
    );
  } else
    await db.query(
      `UPDATE bo_supply_requests SET supplier_id=$3,needed_by=$4::date,note=$5,lines=$6::jsonb,
         revision=revision+1,updated_by=$7,updated_at=clock_timestamp()
       WHERE branch_id=$1 AND id=$2`,
      [branch, c.id, supplier, p.needed_by, p.note, JSON.stringify(lines), actor],
    );
  return { result: await viewOf(db, branch, c.id), before };
}
async function lockedRequest(
  db: Db,
  branch: string,
  c: { id: string; expected_revision: number },
  states: readonly SupplyRequestState[],
) {
  const old = await requestRow(db, branch, c.id, true);
  if (!old) throw new BackofficeError('NOT_FOUND');
  if (old.revision !== c.expected_revision) throw new BackofficeError('CONFLICT');
  if (!states.includes(old.state)) throw new BackofficeError('CONFLICT', 'REQUEST_LOCKED');
  return { old, before: await viewOf(db, branch, c.id) };
}
async function submitRequest(
  db: Db,
  branch: string,
  actor: string,
  c: z.infer<typeof SupplyRequestSubmitCommand>,
  today: string,
) {
  const { old, before } = await lockedRequest(db, branch, c, ['draft']);
  const input = lineInput(storedLines(old.lines));
  // Lines, a day not in the past and, for a request to a supplier, the supplier.
  if (
    !input.length ||
    old.needed_by === null ||
    old.needed_by < today ||
    (old.kind === 'supplier' && old.supplier_id === null)
  )
    throw new BackofficeError('INVALID_REQUEST', 'REQUEST_INCOMPLETE');
  if (old.supplier_id) await assertSupplier(db, branch, old.supplier_id, old.kind);
  // The balance, the hint and the price at the moment of submission; frozen from now on.
  const lines = await buildLines(db, branch, old.supplier_id, input, today);
  await db.query(
    `UPDATE bo_supply_requests SET state='submitted',lines=$3::jsonb,submitted_by=$4,
       submitted_at=clock_timestamp(),revision=revision+1,updated_by=$4,updated_at=clock_timestamp()
     WHERE branch_id=$1 AND id=$2`,
    [branch, c.id, JSON.stringify(lines), actor],
  );
  return { result: await viewOf(db, branch, c.id), before };
}
async function cancelRequest(
  db: Db,
  branch: string,
  actor: string,
  reason: string,
  c: z.infer<typeof SupplyRequestCancelCommand>,
) {
  const { before } = await lockedRequest(db, branch, c, ['draft', 'submitted']);
  await db.query(
    `UPDATE bo_supply_requests SET state='cancelled',closed_by=$3,closed_at=clock_timestamp(),
       revision=revision+1,updated_by=$3,updated_at=clock_timestamp() WHERE branch_id=$1 AND id=$2`,
    [branch, c.id, actor],
  );
  return { result: await viewOf(db, branch, c.id, reason), before };
}
async function receiveRequest(
  db: Db,
  branch: string,
  actor: string,
  c: z.infer<typeof SupplyRequestReceiveCommand>,
  receipt: SupplyReceipt,
) {
  const { old, before } = await lockedRequest(db, branch, c, ['submitted']);
  // Where the goods came from: the request kind and, with one, the supplier's name (also an
  // archived supplier: goods ordered before the archive still arrive).
  const meta = parse(StockReceiptMetaSchema, {
    supplier_kind: old.kind,
    ...(old.supplier_name ? { supplier_name: old.supplier_name } : {}),
    document_date: c.document_date,
  });
  const document = await receipt(c.reference, c.lines, meta);
  await db.query(
    `UPDATE bo_supply_requests SET state='received',receipt_document_id=$3,closed_by=$4,
       closed_at=clock_timestamp(),revision=revision+1,updated_by=$4,updated_at=clock_timestamp()
     WHERE branch_id=$1 AND id=$2`,
    [branch, c.id, document.id, actor],
  );
  const result = await viewOf(db, branch, c.id);
  return {
    result: { ...result, difference: supplyDifference(result.lines, receiptLines(c.lines)) },
    before,
  };
}
const receiptLines = (lines: readonly SupplyReceiveLine[]) =>
  lines.map((l) => ({ ingredient_id: l.ingredient_id.toLowerCase(), quantity: l.quantity }));

/**
 * Requested against received, per ingredient of the request and of the receipt (in the order of
 * the request, then the received extras): `difference` = received - requested, signed.
 */
export function supplyDifference(
  requested: readonly {
    ingredient_id: string;
    name?: string | null;
    unit?: string | null;
    qty: string;
  }[],
  received: readonly {
    ingredient_id: string;
    name?: string | null;
    unit?: string | null;
    quantity: string;
  }[],
) {
  const got = new Map(received.map((l) => [l.ingredient_id, l]));
  const out = requested.map((l) => {
    const r = got.get(l.ingredient_id);
    const q = r ? BigInt(r.quantity) : 0n;
    return {
      ingredient_id: l.ingredient_id,
      name: l.name ?? r?.name ?? null,
      unit: l.unit ?? r?.unit ?? null,
      requested: l.qty,
      received: q.toString(),
      difference: (q - BigInt(l.qty)).toString(),
    };
  });
  const asked = new Set(requested.map((l) => l.ingredient_id));
  for (const r of received)
    if (!asked.has(r.ingredient_id))
      out.push({
        ingredient_id: r.ingredient_id,
        name: r.name ?? null,
        unit: r.unit ?? null,
        requested: '0',
        received: r.quantity,
        difference: r.quantity,
      });
  return out;
}

/**
 * One supplier or supply command (design-bo-ui 9.4). The caller holds the branch lock and the
 * command envelope. Answers the result, the state before (the audit's before_value) and the
 * entity of the audit row. Throws BackofficeError: CONFLICT (another revision),
 * CONFLICT/SUPPLIER_NAME_TAKEN, CONFLICT/SUPPLIER_INACTIVE, CONFLICT/REQUEST_LOCKED (the request is
 * not in a state for this command), NOT_FOUND (no such supplier, ingredient or request),
 * INVALID_REQUEST (a changed kind, a supplier of another kind, an inactive or unknown ingredient),
 * INVALID_REQUEST/PRICE_UNIT_MISMATCH, INVALID_REQUEST/REQUEST_INCOMPLETE (submit without lines,
 * without «нужно к», with a past day or a request to a supplier without one), and whatever the
 * stock receipt throws (CONFLICT for a balance revision, INSUFFICIENT_STOCK, INVALID_REQUEST).
 */
export async function supplyCommand(
  db: Db,
  branch: string,
  actor: string,
  reason: string,
  c: SupplyCommandInput,
  now: Date,
  receipt: SupplyReceipt,
): Promise<{ result: unknown; before: unknown; entity: string }> {
  const today = almatyDay(now);
  switch (c.type) {
    case 'supplier_save':
      return { ...(await saveSupplier(db, branch, actor, c)), entity: c.id };
    case 'supplier_price_save':
      return { ...(await savePrice(db, branch, actor, c, today)), entity: c.supplier_id };
    case 'supply_request_save':
      return { ...(await saveRequest(db, branch, actor, c, today)), entity: c.id };
    case 'supply_request_submit':
      return { ...(await submitRequest(db, branch, actor, c, today)), entity: c.id };
    case 'supply_request_cancel':
      return { ...(await cancelRequest(db, branch, actor, reason, c)), entity: c.id };
    case 'supply_request_receive':
      return { ...(await receiveRequest(db, branch, actor, c, receipt)), entity: c.id };
  }
}

const KIND_TITLES: Readonly<Record<SupplyRequestKind, string>> = Object.freeze({
  central_kitchen: 'в цех',
  bakery: 'в пекарню',
  household: 'на хозтовары',
  supplier: 'поставщику',
});
const dmy = (value: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : value;
};
/** «1,5 кг», «250 г», «2 л», «30 шт»: grams and millilitres from 1000 up in kg and l. */
export function supplyQuantity(qty: string, unit: string): string {
  const n = BigInt(qty);
  const big = unit === 'g' ? 'кг' : unit === 'ml' ? 'л' : null;
  const small: Record<string, string> = { g: 'г', ml: 'мл', pcs: 'шт' };
  const group = (v: bigint) => v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  if (big && n >= 1000n) {
    const fraction = (n % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
    return `${group(n / 1000n)}${fraction ? ',' + fraction : ''} ${big}`;
  }
  return `${group(n)} ${small[unit] ?? unit}`;
}
/**
 * The text of a request for printing and for «Скопировать текст» (sent by hand in a messenger;
 * the system sends nothing): number, day, kind, «нужно к», supplier, note and the lines. No
 * prices: the supplier names his own.
 */
export function supplyRequestText(r: SupplyRequestView): string {
  const head = [
    `Заявка № ${r.number} от ${dmy(r.created_at ? almatyDay(new Date(r.created_at)) : '')} ${KIND_TITLES[r.kind]}${r.state === 'draft' ? ' (черновик)' : r.state === 'cancelled' ? ' (отменена)' : ''}`,
    `Нужно к: ${r.needed_by ? dmy(r.needed_by) : 'не указано'}`,
    ...(r.supplier ? [`Поставщик: ${r.supplier.name}`] : []),
    ...(r.note ? [`Примечание: ${r.note}`] : []),
  ];
  const lines = r.lines.map(
    (l, i) => `${i + 1}. ${l.name ?? 'Позиция'} - ${supplyQuantity(l.qty, l.unit)}`,
  );
  return [...head, '', ...lines, '', `Позиций: ${r.lines.length}`].join('\n');
}

export const SupplyRequestsQuery = z
  .strictObject({
    start_date: z.iso.date(),
    end_date: z.iso.date(),
    state: z.enum(SUPPLY_REQUEST_STATES).optional(),
    kind: z.enum(SUPPLY_REQUEST_KINDS).optional(),
    id: z.uuid().optional(),
  })
  .refine(stockWindowValid);
/**
 * GET .../ops/supply-requests?start_date&end_date[&state][&kind][&id] (design-bo-ui 9.4): the
 * requests created in an Almaty window of at most 92 days, newest first (at most 200, without
 * their lines: requestListRow), the counts
 * by state of the window and the open drafts and submitted requests of every day. With `id` also
 * that request (whatever its day), its text for print and copy, its receipt with the lines and
 * the difference between the request and the receipt.
 */
export async function readSupplyRequests(db: Db, branch: string, input: unknown, now: Date) {
  const q = parse(SupplyRequestsQuery, input);
  const { start, end } = periodWindow(
    { period: 'custom', start_date: q.start_date, end_date: q.end_date },
    now,
  );
  const rows = (
    await db.query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} WHERE q.branch_id=$1 AND q.created_at >= $2 AND q.created_at < $3
         AND ($4::text IS NULL OR q.state=$4) AND ($5::text IS NULL OR q.kind=$5)
       ORDER BY q.created_at DESC,q.number DESC LIMIT ${SUPPLY_REQUEST_LIMIT + 1}`,
      [branch, start, end, q.state ?? null, q.kind ?? null],
    )
  ).rows;
  const listed = rows.slice(0, SUPPLY_REQUEST_LIMIT);
  const one = q.id ? await requestRow(db, branch, q.id) : null;
  if (q.id && !one) throw new BackofficeError('NOT_FOUND');
  const all = one ? [...listed, one] : listed;
  const names = await ingredientNames(
    db,
    branch,
    all.flatMap((r) => storedLines(r.lines).map((l) => l.ingredient_id)),
  );
  const reasons = await cancelReasons(db, branch, all);
  const counts = Object.fromEntries(SUPPLY_REQUEST_STATES.map((s) => [s, 0])) as Record<
    SupplyRequestState,
    number
  >;
  for (const r of (
    await db.query<{ state: SupplyRequestState; n: number }>(
      `SELECT state,count(*)::int n FROM bo_supply_requests WHERE branch_id=$1 AND created_at >= $2
         AND created_at < $3 AND ($4::text IS NULL OR kind=$4) GROUP BY state`,
      [branch, start, end, q.kind ?? null],
    )
  ).rows)
    counts[r.state] = r.n;
  const open = { draft: 0, submitted: 0 };
  for (const r of (
    await db.query<{ state: 'draft' | 'submitted'; n: number }>(
      `SELECT state,count(*)::int n FROM bo_supply_requests WHERE branch_id=$1
         AND state IN ('draft','submitted') GROUP BY state`,
      [branch],
    )
  ).rows)
    open[r.state] = r.n;
  let detail: Record<string, unknown> = {};
  if (one) {
    const request = requestView(one, names, reasons.get(one.id) ?? null);
    const receipt = one.receipt_document_id
      ? await receiptOf(db, branch, one.receipt_document_id)
      : null;
    detail = {
      id: one.id,
      request,
      text: supplyRequestText(request),
      receipt,
      difference: receipt ? supplyDifference(request.lines, receipt.lines) : null,
    };
  }
  return {
    schema_version: 1 as const,
    branch_id: branch,
    view: 'supply-requests' as const,
    timezone: 'Asia/Almaty' as const,
    as_of: now.toISOString(),
    today: almatyDay(now),
    start_date: q.start_date,
    end_date: q.end_date,
    requests: listed.map((r) => requestListRow(requestView(r, names, reasons.get(r.id) ?? null))),
    counts,
    open,
    limits: { requests: SUPPLY_REQUEST_LIMIT, lines: SUPPLY_REQUEST_LINES },
    truncated: { requests: rows.length > SUPPLY_REQUEST_LIMIT },
    ...detail,
  };
}
/** The stock receipt of a request with its lines (what actually arrived). */
async function receiptOf(db: Db, branch: string, id: string) {
  const d = (
    await db.query<{
      id: string;
      reference: string;
      reason: string;
      meta: unknown;
      created_at: Date;
      actor_name: string | null;
    }>(
      `SELECT d.id,d.reference,d.reason,d.meta,d.created_at,a.name actor_name FROM bo_stock_documents d
       LEFT JOIN catalog_managers a ON a.id=d.actor_id WHERE d.branch_id=$1 AND d.id=$2`,
      [branch, id],
    )
  ).rows[0];
  if (!d) return null;
  const lines = (
    await db.query<{
      ingredient_id: string;
      name: string | null;
      unit: string | null;
      quantity: string;
      value_minor: string;
    }>(
      `SELECT m.ingredient_id::text,r.payload->>'name' AS name,r.payload->>'unit' AS unit,
         m.quantity_delta::text quantity,m.value_delta_minor::text value_minor
       FROM bo_stock_movements m
       JOIN bo_records r ON r.branch_id=m.branch_id AND r.kind='ingredient' AND r.id=m.ingredient_id
       WHERE m.branch_id=$1 AND m.document_id=$2 ORDER BY lower(r.payload->>'name'),m.ingredient_id`,
      [branch, id],
    )
  ).rows;
  const meta = StockReceiptMetaSchema.safeParse(d.meta);
  return {
    id: d.id,
    reference: d.reference,
    reason: d.reason,
    document_date: meta.success ? meta.data.document_date : null,
    supplier_kind: meta.success ? meta.data.supplier_kind : null,
    supplier_name: meta.success ? (meta.data.supplier_name ?? null) : null,
    created_at: iso(d.created_at),
    actor_name: d.actor_name,
    lines,
    total_minor: lines.reduce((sum, l) => sum + BigInt(l.value_minor), 0n).toString(),
  };
}
