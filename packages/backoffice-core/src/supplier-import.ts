import { z } from 'zod';
import type { DatabaseClient } from '@pickchick/database';
import { BackofficeError, parse } from './model.js';
import {
  PRICE_UNIT_MEASURES,
  SUPPLIER_KINDS,
  SUPPLIER_PRICE_UNITS,
  SupplierNameSchema,
  type SupplierKind,
} from './supply.js';

/**
 * The import of suppliers and purchase prices from the owner's iiko export (Д6; lane bo-ui2
 * step 3, design-bo-ui.md §9.4). scripts/supplier-prices-import.mjs reads the file, matches the
 * rows against the live suppliers, ingredients and prices, writes the plan with its SHA-256 and a
 * Russian report, and with --apply --expected-plan sends the plan as `supplier_prices_import`
 * commands. Everything here runs only behind BACKOFFICE_SUPPLY_ENABLED (with stock v2) and the
 * 076 rights (p2-flags.ts supplyAvailable), in the shared command envelope of index.ts.
 *
 * A plan becomes one batch (bo_supplier_price_imports, UNIQUE(branch_id, plan_sha256)). The API
 * takes at most 100 KiB of JSON per command (packages/platform/src/http.ts), so a plan of up to
 * 5000 rows is sent in parts: part 1 creates the batch with the report (`summary`), every part
 * creates its new suppliers and inserts its prices, each in its own transaction under the branch
 * lock. The import only adds: it never deletes and never changes an existing supplier or price.
 * A price that already exists with the same value counts as unchanged; one with another value,
 * a supplier name taken since the plan, an archived supplier or a switched-off ingredient means
 * the plan no longer fits (CONFLICT/IMPORT_STALE, nothing of that part is written). A part that is
 * already in under another request id is CONFLICT/IMPORT_ALREADY_APPLIED; the same request again
 * is answered from bo_commands.
 */

type Db = Pick<DatabaseClient, 'query'>;
export const IMPORT_REPORT_SCHEMA = 'pickchick.supplier-prices-report/v1' as const;
export const IMPORT_SOURCES = ['iiko_export', 'csv'] as const;
export const IMPORT_PROFILES = ['iiko', 'csv', 'custom'] as const;
/** Rows of one file (bo_supplier_price_imports.row_count). */
export const IMPORT_ROWS_MAX = 5000;
export const IMPORT_PARTS_MAX = 50;
/** Prices and new suppliers of one part (one command under the 100 KiB body limit). */
export const IMPORT_PART_PRICES = 500;
export const IMPORT_PART_SUPPLIERS = 200;
/** The stored report: at most this many bytes of JSON (the script cuts the issue list). */
export const IMPORT_SUMMARY_BYTES = 24 * 1024;
export const IMPORT_SUMMARY_ISSUES = 300;
export const SUPPLIER_IMPORTS_LIMIT = 20;
/**
 * Why a row of the file was not loaded (or a note on a loaded row), by report category:
 * invalid - a cell the script cannot read; not_found - no ingredient by that code or name;
 * ambiguous - several ingredients or suppliers fit, or the code and the name disagree;
 * unit_mismatch - an unknown unit or one that does not measure the ingredient; duplicates -
 * the same supplier, ingredient, unit and day twice; conflicts - another price for that day is
 * already in PickChick (never overwritten); inactive - a switched-off ingredient or an archived
 * supplier; notes - the row is loaded, something in it was ignored.
 */
export const IMPORT_ISSUE_CATEGORIES = Object.freeze({
  SUPPLIER_REQUIRED: 'invalid',
  SUPPLIER_NAME_INVALID: 'invalid',
  PRICE_INVALID: 'invalid',
  DATE_INVALID: 'invalid',
  NAME_REQUIRED: 'invalid',
  CODE_INVALID: 'invalid',
  KIND_INVALID: 'invalid',
  NOT_FOUND: 'not_found',
  CODE_UNKNOWN: 'not_found',
  NAME_AMBIGUOUS: 'ambiguous',
  CODE_NAME_MISMATCH: 'ambiguous',
  SUPPLIER_AMBIGUOUS: 'ambiguous',
  UNIT_UNKNOWN: 'unit_mismatch',
  UNIT_MISMATCH: 'unit_mismatch',
  DUPLICATE: 'duplicates',
  DUPLICATE_CONFLICT: 'duplicates',
  PRICE_EXISTS: 'conflicts',
  INGREDIENT_INACTIVE: 'inactive',
  SUPPLIER_ARCHIVED: 'inactive',
  KIND_IGNORED: 'notes',
} as const);
export type ImportIssueCode = keyof typeof IMPORT_ISSUE_CATEGORIES;
export const IMPORT_ISSUE_CODES = Object.keys(IMPORT_ISSUE_CATEGORIES) as [
  ImportIssueCode,
  ...ImportIssueCode[],
];
/** The counts of the report, in this order. */
export const IMPORT_COUNT_KEYS = [
  'rows',
  'matched',
  'new_prices',
  'unchanged',
  'new_suppliers',
  'not_found',
  'ambiguous',
  'unit_mismatch',
  'duplicates',
  'conflicts',
  'inactive',
  'invalid',
  'notes',
] as const;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const cell = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !CONTROL.test(v));
const counter = z.number().int().min(0).max(1_000_000);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const day = z.iso
  .date()
  .refine(
    (v) =>
      v >= '2024-01-01' &&
      v <= '2099-12-31' &&
      new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v,
  );
export const ImportIssueSchema = z.strictObject({
  line: z.number().int().min(1).max(1_000_000),
  code: z.enum(IMPORT_ISSUE_CODES),
  supplier: cell(120).nullable(),
  name: cell(200).nullable(),
  text: cell(300).pipe(z.string().min(1)),
});
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
/**
 * The report of a plan as the batch keeps it (bo_supplier_price_imports.summary): the file, the
 * profile, the number of parts, the counts by category and the first rows that were not loaded
 * (issues_total is the number of all of them; the full list stays in the plan file).
 */
export const ImportSummarySchema = z
  .strictObject({
    schema: z.literal(IMPORT_REPORT_SCHEMA),
    file_name: cell(200).pipe(z.string().min(1)),
    profile: z.enum(IMPORT_PROFILES),
    parts: z.number().int().min(1).max(IMPORT_PARTS_MAX),
    counts: z.strictObject(
      Object.fromEntries(IMPORT_COUNT_KEYS.map((k) => [k, counter])) as Record<
        (typeof IMPORT_COUNT_KEYS)[number],
        typeof counter
      >,
    ),
    issues: z.array(ImportIssueSchema).max(IMPORT_SUMMARY_ISSUES),
    issues_total: counter,
  })
  .refine((v) => v.issues_total >= v.issues.length)
  .refine((v) => bytes(v) <= IMPORT_SUMMARY_BYTES);
export type ImportSummary = z.infer<typeof ImportSummarySchema>;
const ImportPriceSchema = z.strictObject({
  supplier_id: z.uuid(),
  ingredient_id: z.uuid(),
  unit: z.enum(SUPPLIER_PRICE_UNITS),
  price_minor: z.string().regex(/^[1-9][0-9]{0,14}$/),
  valid_from: day,
});
/**
 * One part of an import plan (see the module comment). `batch_id`, the new supplier ids and the
 * request ids are derived from the plan by the script, so a repeat sends the same bytes.
 * `summary` comes with part 1 only; `row_count` is the number of data rows of the file.
 */
export const SupplierPricesImportCommand = z
  .strictObject({
    type: z.literal('supplier_prices_import'),
    batch_id: z.uuid(),
    source: z.enum(IMPORT_SOURCES),
    file_sha256: hex64,
    plan_sha256: hex64,
    row_count: z.number().int().min(1).max(IMPORT_ROWS_MAX),
    part: z.number().int().min(1).max(IMPORT_PARTS_MAX),
    parts: z.number().int().min(1).max(IMPORT_PARTS_MAX),
    summary: ImportSummarySchema.optional(),
    suppliers: z
      .array(
        z.strictObject({ id: z.uuid(), name: SupplierNameSchema, kind: z.enum(SUPPLIER_KINDS) }),
      )
      .max(IMPORT_PART_SUPPLIERS)
      .default([]),
    prices: z.array(ImportPriceSchema).min(1).max(IMPORT_PART_PRICES),
  })
  .refine((v) => v.part <= v.parts)
  .refine((v) => (v.part === 1) === (v.summary !== undefined))
  .refine((v) => v.summary === undefined || v.summary.parts === v.parts)
  .refine((v) => v.summary === undefined || v.summary.counts.rows === v.row_count)
  .refine(
    (v) =>
      new Set(
        v.prices.map((p) =>
          [p.supplier_id.toLowerCase(), p.ingredient_id.toLowerCase(), p.unit, p.valid_from].join(
            ':',
          ),
        ),
      ).size === v.prices.length,
  )
  .refine((v) => new Set(v.suppliers.map((s) => s.id.toLowerCase())).size === v.suppliers.length)
  .refine((v) => new Set(v.suppliers.map((s) => s.name.toLowerCase())).size === v.suppliers.length);
export type SupplierPricesImportInput = z.infer<typeof SupplierPricesImportCommand>;

const stale = () => new BackofficeError('CONFLICT', 'IMPORT_STALE');
const applied = () => new BackofficeError('CONFLICT', 'IMPORT_ALREADY_APPLIED');
/** Whether this part of the batch is already in (the audit row of its command). */
async function partApplied(db: Db, branch: string, batch: string, part: number) {
  return Boolean(
    (
      await db.query(
        `SELECT 1 FROM bo_audit WHERE branch_id=$1 AND action='supplier_prices_import'
           AND entity_id=$2 AND after_value->>'part'=$3 LIMIT 1`,
        [branch, batch, String(part)],
      )
    ).rowCount,
  );
}

/**
 * One part of a price import (see the module comment). The caller holds the branch lock and the
 * command envelope. Answers the result (also the audit's after_value; entity = the batch).
 */
export async function importSupplierPrices(
  db: Db,
  branch: string,
  actor: string,
  c: SupplierPricesImportInput,
): Promise<{ result: unknown; before: null; entity: string }> {
  const batch = c.batch_id.toLowerCase();
  const found = (
    await db.query<{
      id: string;
      source: string;
      file_sha256: string;
      plan_sha256: string;
      row_count: number;
      summary: { parts?: unknown } | null;
    }>(
      // No row lock: the API role may only read and insert batches (the branch lock serialises).
      `SELECT id::text,source,file_sha256,plan_sha256,row_count,summary
       FROM bo_supplier_price_imports WHERE branch_id=$1 AND (plan_sha256=$2 OR id=$3)`,
      [branch, c.plan_sha256, batch],
    )
  ).rows;
  // A batch id of this branch used by another plan, or one of another branch (the primary key).
  if (
    found.some((b) => b.id !== batch || b.plan_sha256 !== c.plan_sha256) ||
    (!found.length &&
      (await db.query('SELECT 1 FROM bo_supplier_price_imports WHERE id=$1', [batch])).rowCount)
  )
    throw stale();
  if (c.part === 1) {
    if (found.length) throw applied();
    await db.query(
      `INSERT INTO bo_supplier_price_imports(id,branch_id,source,file_sha256,plan_sha256,row_count,summary,actor_id)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [
        batch,
        branch,
        c.source,
        c.file_sha256,
        c.plan_sha256,
        c.row_count,
        JSON.stringify(c.summary),
        actor,
      ],
    );
  } else {
    const b = found[0];
    // Part 1 first, and the parts of one plan only.
    if (
      !b ||
      b.source !== c.source ||
      b.file_sha256 !== c.file_sha256 ||
      b.row_count !== c.row_count ||
      b.summary?.parts !== c.parts
    )
      throw stale();
    if (await partApplied(db, branch, batch, c.part)) throw applied();
  }
  // New suppliers of this part: neither the id nor the name (regardless of case) may exist.
  const created: string[] = [];
  for (const s of c.suppliers) {
    const id = s.id.toLowerCase();
    if (
      (
        await db.query(
          'SELECT 1 FROM bo_suppliers WHERE branch_id=$1 AND (id=$2 OR lower(name)=lower($3))',
          [branch, id, s.name],
        )
      ).rowCount
    )
      throw stale();
    await db.query(
      `INSERT INTO bo_suppliers(id,branch_id,name,kind,active,revision,created_by,updated_by)
       VALUES($1,$2,$3,$4,true,1,$5,$5)`,
      [id, branch, s.name, s.kind, actor],
    );
    created.push(id);
  }
  const prices = c.prices.map((p) => ({
    ...p,
    supplier_id: p.supplier_id.toLowerCase(),
    ingredient_id: p.ingredient_id.toLowerCase(),
  }));
  // Every supplier of the prices: of this branch and not archived.
  const supplierIds = [...new Set(prices.map((p) => p.supplier_id))];
  const suppliers = (
    await db.query<{ id: string; active: boolean }>(
      'SELECT id::text,active FROM bo_suppliers WHERE branch_id=$1 AND id=ANY($2::uuid[]) FOR SHARE',
      [branch, supplierIds],
    )
  ).rows;
  if (suppliers.length !== supplierIds.length || suppliers.some((s) => !s.active)) throw stale();
  // Every ingredient: of this branch, switched on, measured by the unit of its price.
  const ingredientIds = [...new Set(prices.map((p) => p.ingredient_id))];
  const ingredients = new Map(
    (
      await db.query<{ id: string; unit: string | null; active: boolean | null }>(
        `SELECT id::text,payload->>'unit' unit,(payload->>'active')::boolean active FROM bo_records
         WHERE branch_id=$1 AND kind='ingredient' AND id=ANY($2::uuid[])`,
        [branch, ingredientIds],
      )
    ).rows.map((r) => [r.id, r]),
  );
  for (const p of prices) {
    const ingredient = ingredients.get(p.ingredient_id);
    if (!ingredient || ingredient.active !== true) throw stale();
    if (PRICE_UNIT_MEASURES[p.unit] !== ingredient.unit)
      throw new BackofficeError('INVALID_REQUEST', 'PRICE_UNIT_MISMATCH');
  }
  // Prices that exist already: the same value is unchanged, another value means a stale plan.
  const keyOf = (p: {
    supplier_id: string;
    ingredient_id: string;
    unit: string;
    valid_from: string;
  }) => [p.supplier_id, p.ingredient_id, p.unit, p.valid_from].join(':');
  const existing = new Map(
    (
      await db.query<{
        supplier_id: string;
        ingredient_id: string;
        unit: string;
        valid_from: string;
        price_minor: string;
      }>(
        `SELECT p.supplier_id::text,p.ingredient_id::text,p.unit,p.valid_from::text,p.price_minor::text
         FROM bo_supplier_prices p
         JOIN jsonb_to_recordset($2::jsonb) AS k(supplier_id uuid,ingredient_id uuid,unit text,valid_from date)
           ON p.supplier_id=k.supplier_id AND p.ingredient_id=k.ingredient_id AND p.unit=k.unit
           AND p.valid_from=k.valid_from
         WHERE p.branch_id=$1 FOR SHARE OF p`,
        [branch, JSON.stringify(prices)],
      )
    ).rows.map((r) => [keyOf(r), r.price_minor]),
  );
  const fresh = prices.filter((p) => {
    const old = existing.get(keyOf(p));
    if (old !== undefined && old !== p.price_minor) throw stale();
    return old === undefined;
  });
  if (fresh.length)
    await db.query(
      `INSERT INTO bo_supplier_prices(branch_id,supplier_id,ingredient_id,unit,price_minor,valid_from,
         source,import_batch_id,revision,updated_by)
       SELECT $1,k.supplier_id,k.ingredient_id,k.unit,k.price_minor,k.valid_from,'import',$2,1,$3
       FROM jsonb_to_recordset($4::jsonb)
         AS k(supplier_id uuid,ingredient_id uuid,unit text,price_minor bigint,valid_from date)`,
      [branch, batch, actor, JSON.stringify(fresh)],
    );
  return {
    result: {
      batch_id: batch,
      part: c.part,
      parts: c.parts,
      supplier_ids: created,
      suppliers_created: created.length,
      prices_created: fresh.length,
      unchanged: prices.length - fresh.length,
    },
    before: null,
    entity: batch,
  };
}

// ----------------------------------------------------------------------------- view ----

type BatchRow = {
  id: string;
  source: string;
  file_sha256: string;
  plan_sha256: string;
  row_count: number;
  summary: unknown;
  actor_name: string | null;
  applied_at: Date;
};
const BATCH_COLUMNS = `i.id::text,i.source,i.file_sha256,i.plan_sha256,i.row_count,i.summary,
  m.name actor_name,i.applied_at FROM bo_supplier_price_imports i
  LEFT JOIN catalog_managers m ON m.id=i.actor_id`;
const PartResult = z.object({
  part: z.number().int().min(1),
  supplier_ids: z.array(z.string()).default([]),
  suppliers_created: z.number().int().min(0),
  prices_created: z.number().int().min(0),
  unchanged: z.number().int().min(0),
});
type Parts = Map<string, z.infer<typeof PartResult>[]>;
/** The parts in force of each batch: the audit rows of their commands. */
async function partsOf(db: Db, branch: string, ids: readonly string[]): Promise<Parts> {
  const out: Parts = new Map();
  if (!ids.length) return out;
  for (const r of (
    await db.query<{ entity_id: string; after_value: unknown }>(
      `SELECT entity_id::text,after_value FROM bo_audit
       WHERE branch_id=$1 AND action='supplier_prices_import' AND entity_id=ANY($2::uuid[])
       ORDER BY created_at,id`,
      [branch, ids],
    )
  ).rows) {
    const p = PartResult.safeParse(r.after_value);
    if (!p.success) continue;
    const list = out.get(r.entity_id) ?? [];
    if (!list.some((x) => x.part === p.data.part)) list.push(p.data);
    out.set(r.entity_id, list);
  }
  return out;
}
/** The summary of a batch, or null for one that does not carry a report of this schema. */
const summaryOf = (value: unknown): ImportSummary | null => {
  const s = ImportSummarySchema.safeParse(value);
  return s.success ? s.data : null;
};
/** One batch as the list shows it: its file, author, parts and totals. */
export function importRow(row: BatchRow, parts: readonly z.infer<typeof PartResult>[]) {
  const summary = summaryOf(row.summary);
  const applied = parts.map((p) => p.part).sort((a, b) => a - b);
  const sum = (key: 'suppliers_created' | 'prices_created' | 'unchanged') =>
    parts.reduce((total, p) => total + p[key], 0);
  return {
    id: row.id,
    source: row.source,
    file_name: summary?.file_name ?? null,
    profile: summary?.profile ?? null,
    file_sha256: row.file_sha256,
    plan_sha256: row.plan_sha256,
    row_count: row.row_count,
    actor_name: row.actor_name,
    applied_at:
      row.applied_at instanceof Date ? row.applied_at.toISOString() : String(row.applied_at),
    parts: summary?.parts ?? null,
    parts_applied: applied,
    complete: summary !== null && applied.length === summary.parts,
    suppliers_created: sum('suppliers_created'),
    prices_created: sum('prices_created'),
    unchanged: sum('unchanged'),
    counts: summary?.counts ?? null,
  };
}
export type SupplierImportRow = ReturnType<typeof importRow>;

export const SupplierImportsQuery = z.strictObject({ id: z.uuid().optional() });
/**
 * GET .../ops/supplier-imports[?id=uuid] (design-bo-ui §9.4, step 3): the last 20 price imports
 * of the branch, newest first, with their parts and totals, and one of them in full (`?id`, else
 * the newest): its report, the suppliers it created or priced with the prices still from it,
 * and how many of its prices were corrected by hand since. Every role reads it (reports.read).
 */
export async function readSupplierImports(db: Db, branch: string, input: unknown, now: Date) {
  const q = parse(SupplierImportsQuery, input);
  const rows = (
    await db.query<BatchRow>(
      `SELECT ${BATCH_COLUMNS} WHERE i.branch_id=$1 ORDER BY i.applied_at DESC,i.id
       LIMIT ${SUPPLIER_IMPORTS_LIMIT + 1}`,
      [branch],
    )
  ).rows;
  const listed = rows.slice(0, SUPPLIER_IMPORTS_LIMIT);
  const wanted = q.id?.toLowerCase();
  let one = wanted ? listed.find((r) => r.id === wanted) : listed[0];
  if (wanted && !one) {
    one = (
      await db.query<BatchRow>(`SELECT ${BATCH_COLUMNS} WHERE i.branch_id=$1 AND i.id=$2`, [
        branch,
        wanted,
      ])
    ).rows[0];
    if (!one) throw new BackofficeError('NOT_FOUND');
  }
  const parts = await partsOf(db, branch, [
    ...new Set([...listed.map((r) => r.id), ...(one ? [one.id] : [])]),
  ]);
  let detail = null;
  if (one) {
    const own = parts.get(one.id) ?? [];
    const created = new Set(own.flatMap((p) => p.supplier_ids.map((id) => id.toLowerCase())));
    const suppliers = (
      await db.query<{
        id: string;
        name: string;
        kind: SupplierKind;
        active: boolean;
        prices: number;
      }>(
        `SELECT s.id::text,s.name,s.kind,s.active,
           (SELECT count(*)::int FROM bo_supplier_prices p WHERE p.branch_id=s.branch_id
              AND p.supplier_id=s.id AND p.import_batch_id=$2) prices
         FROM bo_suppliers s WHERE s.branch_id=$1 AND (s.id=ANY($3::uuid[]) OR EXISTS(
           SELECT 1 FROM bo_supplier_prices p WHERE p.branch_id=s.branch_id AND p.supplier_id=s.id
             AND p.import_batch_id=$2))
         ORDER BY lower(s.name),s.id`,
        [branch, one.id, [...created]],
      )
    ).rows;
    const kept = suppliers.reduce((total, s) => total + s.prices, 0);
    const row = importRow(one, own);
    detail = {
      ...row,
      summary: summaryOf(one.summary),
      suppliers: suppliers.map((s) => ({ ...s, created: created.has(s.id) })),
      prices_kept: kept,
      // A price corrected by hand becomes a manual price (supply.ts savePrice).
      prices_corrected: Math.max(0, row.prices_created - kept),
    };
  }
  return {
    schema_version: 1 as const,
    branch_id: branch,
    view: 'supplier-imports' as const,
    timezone: 'Asia/Almaty' as const,
    as_of: now.toISOString(),
    imports: listed.map((r) => importRow(r, parts.get(r.id) ?? [])),
    limits: { imports: SUPPLIER_IMPORTS_LIMIT },
    truncated: { imports: rows.length > SUPPLIER_IMPORTS_LIMIT },
    import: detail,
  };
}
