import { z } from 'zod';
import type { DatabaseClient } from '@pickchick/database';
import { BackofficeError, parse } from './model.js';
import { readable, type BackofficeOptions } from './stops.js';
import { P1_FEATURE_RELATIONS, p1RelationsReady } from './p1-flags.js';

/**
 * Discounts of the back office (КС7 data; lane bo-ui step 7, owner decision 05.11; contracts 00
 * item 2, design-bo-ui.md 3, 4, 5.8).
 *
 * Discounts are created and edited only here, by the manager (`discounts.write`). At launch there
 * are none, and the POS does not apply them yet (P1 of the pos lane, with the shift manager's
 * PIN): nothing here is published to the edge, written to bo_publications or bo_delivery_outbox,
 * or added to a menu payload. Everything runs only behind BACKOFFICE_DISCOUNTS_ENABLED and only
 * while the API role holds the cloud075 rights of the P1 grants helper (discountsAvailable):
 *
 * - GET .../ops/discounts[?id=] lists the discounts of the branch with the head catalog names
 *   (and the revisions of one discount with `id`);
 * - POST .../commands takes `discount_save` (create at expected_revision 0, or edit) and
 *   `discount_state` (draft, active, archived) through the P1 schema of stock-p1.ts, so with the
 *   flag off both are unknown commands. Each runs in the shared envelope (request_id, digest,
 *   bo_audit, branch lock) and checks `expected_revision`; every stored revision is copied to
 *   bo_discount_revisions by the cloud075 owner trigger.
 *
 * Rules (the cashier picks a discount by name, P1):
 * - percent in basis points 100..10000 (1 % to 100 %) or a fixed amount in whole tiyn up to
 *   1 000 000 ₸; never both;
 * - scope: catalog categories and products (both empty = the whole menu) of the head catalog, and
 *   at least one channel of DISCOUNT_CHANNELS;
 * - schedule: an optional period [start_at, end_at), at least one ISO weekday (1 = Monday) and up
 *   to four non-overlapping daily windows in Almaty time (none = all day);
 * - requires_manager_pin defaults to true, combinable to false;
 * - two live (not archived) discounts of a branch never share a name, whatever the case;
 * - an edit that changes anything returns the discount to draft: a live discount is never changed
 *   silently, the manager switches it on again; an archived discount is final.
 */

type Db = Pick<DatabaseClient, 'query'>;

/**
 * Where a discount may apply: the hall, the aggregators entered at the cash desk, ChocoFood (a
 * hall sale paid by the ChocoFood method), the app and the kiosk. The POS lane applies the cash
 * desk channels in P1; the app and the kiosk are cloud channels (later).
 */
export const DISCOUNT_CHANNELS = [
  'hall',
  'yandex_eda',
  'glovo',
  'chocofood',
  'mobile',
  'kiosk',
] as const;
export type DiscountChannel = (typeof DISCOUNT_CHANNELS)[number];
export const DISCOUNT_KINDS = ['percent', 'amount'] as const;
export const DISCOUNT_STATES = ['draft', 'active', 'archived'] as const;
export type DiscountState = (typeof DISCOUNT_STATES)[number];
/** 1 % to 100 % in basis points (10000 = 100 %). */
export const DISCOUNT_PERCENT_MIN_BP = 100;
export const DISCOUNT_PERCENT_MAX_BP = 10000;
/** A fixed amount is at most 1 000 000 ₸ (a typing slip, not a discount, beyond that). */
export const DISCOUNT_AMOUNT_MAX_MINOR = 100000000n;
export const DISCOUNT_NAME_MAX = 80;
export const DISCOUNT_HOUR_WINDOWS = 4;
/** GET .../ops/discounts lists at most this many discounts (live ones first). */
export const DISCOUNT_LIST_LIMIT = 200;
/** ... and at most this many revisions of the discount asked for with `id`. */
export const DISCOUNT_HISTORY_LIMIT = 100;

const revision = z.number().int().min(0).max(2147483646);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const distinct = (values: readonly unknown[]) => new Set(values).size === values.length;
const clock = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/);
const clockEnd = z.string().regex(/^(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/);
const instant = z.iso
  .datetime()
  .refine((v) => Number.isFinite(Date.parse(v)) && v >= '2020-01-01' && v < '2100-01-01');
const name = z
  .string()
  .trim()
  .min(1)
  .max(DISCOUNT_NAME_MAX)
  // eslint-disable-next-line no-control-regex
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v));

/** What a discount applies to. Both lists empty = the whole menu. */
export const DiscountScopeSchema = z.strictObject({
  categories: z.array(slug).max(30).refine(distinct),
  products: z.array(slug).max(100).refine(distinct),
  channels: z
    .array(z.enum(DISCOUNT_CHANNELS))
    .min(1)
    .max(DISCOUNT_CHANNELS.length)
    .refine(distinct),
});
export type DiscountScope = z.infer<typeof DiscountScopeSchema>;
/**
 * When a discount applies: [start_at, end_at) (each optional), ISO weekdays 1..7 and daily
 * windows {from, to} in Almaty time (from < to, `to` may be 24:00, no overlap; none = all day).
 */
export const DiscountScheduleSchema = z
  .strictObject({
    start_at: instant.nullable(),
    end_at: instant.nullable(),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine(distinct),
    hours: z.array(z.strictObject({ from: clock, to: clockEnd })).max(DISCOUNT_HOUR_WINDOWS),
  })
  .superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (v.start_at && v.end_at && Date.parse(v.end_at) <= Date.parse(v.start_at))
      issue('The period ends before it starts');
    const hours = [...v.hours].sort((a, b) => a.from.localeCompare(b.from));
    hours.forEach((h, i) => {
      if (h.to <= h.from) issue('A window ends before it starts');
      if (i > 0 && h.from < hours[i - 1]!.to) issue('Windows overlap');
    });
  });
export type DiscountSchedule = z.infer<typeof DiscountScheduleSchema>;
/** The editable part of a discount (discount_save payload). */
export const DiscountPayloadSchema = z
  .strictObject({
    name,
    kind: z.enum(DISCOUNT_KINDS),
    percent_bp: z
      .number()
      .int()
      .min(DISCOUNT_PERCENT_MIN_BP)
      .max(DISCOUNT_PERCENT_MAX_BP)
      .nullable()
      .default(null),
    value_minor: z
      .string()
      .regex(/^[1-9][0-9]{0,14}$/)
      .nullable()
      .default(null),
    scope: DiscountScopeSchema,
    schedule: DiscountScheduleSchema,
    requires_manager_pin: z.boolean().default(true),
    combinable: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (
      v.kind === 'percent'
        ? v.percent_bp === null || v.value_minor !== null
        : v.value_minor === null || v.percent_bp !== null
    )
      issue('A discount is a percent or an amount');
    if (
      typeof v.value_minor === 'string' &&
      /^[0-9]+$/.test(v.value_minor) &&
      BigInt(v.value_minor) > DISCOUNT_AMOUNT_MAX_MINOR
    )
      issue('The amount is too large');
  });
export type DiscountPayload = z.infer<typeof DiscountPayloadSchema>;
/** Create (expected_revision 0, a new id from the cabinet) or edit a discount. */
export const DiscountSaveCommand = z.strictObject({
  type: z.literal('discount_save'),
  id: z.uuid(),
  expected_revision: revision,
  payload: DiscountPayloadSchema,
});
/** Switch a discount on (active), off (draft) or to the archive (final). */
export const DiscountStateCommand = z.strictObject({
  type: z.literal('discount_state'),
  id: z.uuid(),
  state: z.enum(DISCOUNT_STATES),
  expected_revision: revision.min(1),
});
export const DiscountsQuery = z.strictObject({ id: z.uuid().optional() });

/** Lists in a fixed order and instants as ISO strings, so equal discounts compare equal. */
export function normalizeDiscount(p: DiscountPayload): DiscountPayload {
  const iso = (v: string | null) => (v === null ? null : new Date(v).toISOString());
  return {
    name: p.name,
    kind: p.kind,
    percent_bp: p.percent_bp,
    value_minor: p.value_minor,
    scope: {
      categories: [...p.scope.categories].sort(),
      products: [...p.scope.products].sort(),
      channels: DISCOUNT_CHANNELS.filter((c) => p.scope.channels.includes(c)),
    },
    schedule: {
      start_at: iso(p.schedule.start_at),
      end_at: iso(p.schedule.end_at),
      weekdays: [...p.schedule.weekdays].sort((a, b) => a - b),
      hours: [...p.schedule.hours]
        .sort((a, b) => a.from.localeCompare(b.from))
        .map((h) => ({ from: h.from, to: h.to })),
    },
    requires_manager_pin: p.requires_manager_pin,
    combinable: p.combinable,
  };
}
/** Whether the period of a discount has not started, runs, has ended, or has no bounds. */
export function discountPeriod(
  schedule: Pick<DiscountSchedule, 'start_at' | 'end_at'>,
  now: Date,
): 'always' | 'not_started' | 'running' | 'ended' {
  const t = now.getTime();
  if (!schedule.start_at && !schedule.end_at) return 'always';
  if (schedule.start_at && t < Date.parse(schedule.start_at)) return 'not_started';
  if (schedule.end_at && t >= Date.parse(schedule.end_at)) return 'ended';
  return 'running';
}

/**
 * The discount editor can run for the current database role: the flag and SELECT, INSERT,
 * UPDATE on bo_discounts with SELECT on bo_discount_revisions (P1 grants helper).
 */
export async function discountsAvailable(db: Db, options: BackofficeOptions) {
  return (
    options.discountsEnabled === true &&
    (await p1RelationsReady(db, P1_FEATURE_RELATIONS.discounts))
  );
}

// ------------------------------------------------------------------------- catalog ----

const title = z.object({ ru: z.string() });
const CatalogNames = z.object({
  categories: z.array(z.object({ id: slug, name: title })),
  products: z.array(z.object({ id: slug, name: title, category_id: slug })),
});
export type DiscountCatalog = {
  version: number;
  categories: { id: string; name: string }[];
  products: { id: string; name: string; category_id: string }[];
};
/** Names of the head catalog publication; null before the first one or without read access. */
export async function discountCatalog(db: Db, branch: string): Promise<DiscountCatalog | null> {
  if (!(await readable(db, 'catalog_publications'))) return null;
  if (!(await readable(db, 'catalog_branch_heads'))) return null;
  const row = (
    await db.query<{ version: number; payload: unknown }>(
      `SELECT p.version,p.payload FROM catalog_branch_heads h
       JOIN catalog_publications p ON p.branch_id=h.branch_id AND p.version=h.published_version
       WHERE h.branch_id=$1`,
      [branch],
    )
  ).rows[0];
  const names = row ? CatalogNames.safeParse(row.payload) : null;
  if (!row || !names?.success) return null;
  return {
    version: row.version,
    categories: names.data.categories.map((c) => ({ id: c.id, name: c.name.ru })),
    products: names.data.products.map((p) => ({
      id: p.id,
      name: p.name.ru,
      category_id: p.category_id,
    })),
  };
}
/** Categories and products of a scope that the catalog does not have. */
export function unknownItems(scope: DiscountScope, catalog: DiscountCatalog | null) {
  const categories = new Set(catalog?.categories.map((c) => c.id) ?? []);
  const products = new Set(catalog?.products.map((p) => p.id) ?? []);
  return {
    categories: scope.categories.filter((id) => !categories.has(id)),
    products: scope.products.filter((id) => !products.has(id)),
  };
}
async function assertCatalogItems(db: Db, branch: string, scope: DiscountScope) {
  if (!scope.categories.length && !scope.products.length) return;
  const catalog = await discountCatalog(db, branch);
  if (!catalog) throw new BackofficeError('NOT_READY', 'CATALOG_NOT_PUBLISHED');
  const unknown = unknownItems(scope, catalog);
  if (unknown.categories.length || unknown.products.length)
    throw new BackofficeError('NOT_FOUND', 'CATALOG_ITEM_NOT_FOUND');
}

// --------------------------------------------------------------------------- store ----

const EMPTY_SCOPE: DiscountScope = { categories: [], products: [], channels: [] };
const EMPTY_SCHEDULE: DiscountSchedule = { start_at: null, end_at: null, weekdays: [], hours: [] };
type Row = {
  id: string;
  name: string;
  kind: 'percent' | 'amount';
  value_minor: string | null;
  percent_bp: number | null;
  scope: unknown;
  schedule: unknown;
  requires_manager_pin: boolean;
  combinable: boolean;
  state: DiscountState;
  revision: number;
  created_by_name: string | null;
  created_at: Date;
  updated_by_name: string | null;
  updated_at: Date;
};
const COLUMNS = `d.id,d.name,d.kind,d.value_minor::text value_minor,d.percent_bp,d.scope,d.schedule,
  d.requires_manager_pin,d.combinable,d.state,d.revision,c.name created_by_name,d.created_at,
  u.name updated_by_name,d.updated_at
  FROM bo_discounts d LEFT JOIN catalog_managers c ON c.id=d.created_by
  LEFT JOIN catalog_managers u ON u.id=d.updated_by`;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null ? null : String(v));
/** A stored discount as the view and the command results show it (times as ISO strings). */
export function discountView(row: Row) {
  const scope = DiscountScopeSchema.safeParse(row.scope);
  const schedule = DiscountScheduleSchema.safeParse(row.schedule);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    percent_bp: row.percent_bp,
    value_minor: row.value_minor,
    scope: scope.success ? scope.data : EMPTY_SCOPE,
    schedule: schedule.success ? schedule.data : EMPTY_SCHEDULE,
    requires_manager_pin: row.requires_manager_pin,
    combinable: row.combinable,
    state: row.state,
    revision: row.revision,
    created_by_name: row.created_by_name,
    created_at: iso(row.created_at),
    updated_by_name: row.updated_by_name,
    updated_at: iso(row.updated_at),
  };
}
export type DiscountView = ReturnType<typeof discountView>;
async function discountRow(db: Db, branch: string, id: string, lock = false) {
  return (
    await db.query<Row>(
      `SELECT ${COLUMNS} WHERE d.branch_id=$1 AND d.id=$2${lock ? ' FOR UPDATE OF d' : ''}`,
      [branch, id],
    )
  ).rows[0];
}
/** The editable fields of a stored row, in the order and form of normalizeDiscount. */
function payloadOf(row: Row): unknown {
  return {
    name: row.name,
    kind: row.kind,
    percent_bp: row.percent_bp,
    value_minor: row.value_minor,
    scope: row.scope,
    schedule: row.schedule,
    requires_manager_pin: row.requires_manager_pin,
    combinable: row.combinable,
  };
}
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
  return JSON.stringify(value);
}
async function assertNameFree(db: Db, branch: string, text: string, id: string) {
  if (
    (
      await db.query(
        "SELECT 1 FROM bo_discounts WHERE branch_id=$1 AND lower(name)=lower($2) AND state<>'archived' AND id<>$3",
        [branch, text, id],
      )
    ).rowCount
  )
    throw new BackofficeError('CONFLICT', 'DISCOUNT_NAME_TAKEN');
}
export type DiscountCommandInput =
  z.infer<typeof DiscountSaveCommand> | z.infer<typeof DiscountStateCommand>;
/**
 * discount_save and discount_state (manager, design-bo-ui 5.8). The caller holds the branch lock
 * and the command envelope (request_id, digest, audit). Answers the discount after the command
 * and before it (the audit's before_value). Throws BackofficeError:
 * CONFLICT (another revision), CONFLICT/DISCOUNT_NAME_TAKEN, CONFLICT/DISCOUNT_ARCHIVED,
 * NOT_FOUND (no such discount for a state change), NOT_FOUND/CATALOG_ITEM_NOT_FOUND,
 * NOT_READY/CATALOG_NOT_PUBLISHED (a scope by categories or products without a published
 * catalog), INVALID_REQUEST (the same state again, a stored discount that no longer validates),
 * INVALID_REQUEST/DISCOUNT_PERIOD_ENDED (switching on a discount whose period is over).
 */
export async function discountCommand(
  db: Db,
  branch: string,
  actor: string,
  c: DiscountCommandInput,
  now: Date,
): Promise<{ result: DiscountView; before: DiscountView | null }> {
  const old = await discountRow(db, branch, c.id, true);
  const before = old ? discountView(old) : null;
  if (c.type === 'discount_save') {
    if ((old?.revision ?? 0) !== c.expected_revision) throw new BackofficeError('CONFLICT');
    if (old?.state === 'archived') throw new BackofficeError('CONFLICT', 'DISCOUNT_ARCHIVED');
    const p = normalizeDiscount(c.payload);
    if (old && canonical(payloadOf(old)) === canonical(p)) return { result: before!, before };
    await assertCatalogItems(db, branch, p.scope);
    await assertNameFree(db, branch, p.name, c.id);
    const values = [
      p.name,
      p.kind,
      p.value_minor,
      p.percent_bp,
      JSON.stringify(p.scope),
      JSON.stringify(p.schedule),
      p.requires_manager_pin,
      p.combinable,
      actor,
    ];
    if (!old)
      await db.query(
        `INSERT INTO bo_discounts(id,branch_id,name,kind,value_minor,percent_bp,scope,schedule,
           requires_manager_pin,combinable,state,revision,created_by,updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,'draft',1,$11,$11)`,
        [c.id, branch, ...values],
      );
    else
      await db.query(
        `UPDATE bo_discounts SET name=$3,kind=$4,value_minor=$5,percent_bp=$6,scope=$7::jsonb,
           schedule=$8::jsonb,requires_manager_pin=$9,combinable=$10,state='draft',
           revision=revision+1,updated_by=$11,updated_at=clock_timestamp()
         WHERE branch_id=$1 AND id=$2`,
        [branch, c.id, ...values],
      );
  } else {
    if (!old) throw new BackofficeError('NOT_FOUND');
    if (old.revision !== c.expected_revision) throw new BackofficeError('CONFLICT');
    if (old.state === 'archived') throw new BackofficeError('CONFLICT', 'DISCOUNT_ARCHIVED');
    if (old.state === c.state) throw new BackofficeError('INVALID_REQUEST');
    if (c.state === 'active') {
      // The stored discount still passes every rule of a save before it goes live.
      const p = parse(DiscountPayloadSchema, payloadOf(old));
      if (p.schedule.end_at && Date.parse(p.schedule.end_at) <= now.getTime())
        throw new BackofficeError('INVALID_REQUEST', 'DISCOUNT_PERIOD_ENDED');
      await assertCatalogItems(db, branch, p.scope);
    }
    await db.query(
      `UPDATE bo_discounts SET state=$3,revision=revision+1,updated_by=$4,updated_at=clock_timestamp()
       WHERE branch_id=$1 AND id=$2`,
      [branch, c.id, c.state, actor],
    );
  }
  return { result: discountView((await discountRow(db, branch, c.id))!), before };
}

/** One stored revision (cloud075 bo_discount_revisions snapshot) in the words of the view. */
function revisionView(row: {
  revision: number;
  snapshot: Record<string, unknown>;
  changed_by_name: string | null;
  changed_at: Date;
}) {
  const s = row.snapshot;
  const value = s['value_minor'];
  return {
    revision: row.revision,
    name: typeof s['name'] === 'string' ? s['name'] : '',
    kind: s['kind'] === 'amount' ? ('amount' as const) : ('percent' as const),
    percent_bp: typeof s['percent_bp'] === 'number' ? s['percent_bp'] : null,
    value_minor: value === null || value === undefined ? null : String(value),
    scope: DiscountScopeSchema.safeParse(s['scope']).data ?? EMPTY_SCOPE,
    schedule: DiscountScheduleSchema.safeParse(s['schedule']).data ?? EMPTY_SCHEDULE,
    requires_manager_pin: s['requires_manager_pin'] === true,
    combinable: s['combinable'] === true,
    state: (DISCOUNT_STATES as readonly unknown[]).includes(s['state'])
      ? (s['state'] as DiscountState)
      : ('draft' as const),
    changed_by_name: row.changed_by_name,
    changed_at: iso(row.changed_at),
  };
}

/**
 * GET .../ops/discounts[?id=uuid] (design-bo-ui 5.8): every discount of the branch, live ones
 * first (active, then drafts, by name), with the period state, the scope items the head catalog no
 * longer has and the names of the catalog for the editor. `applied_at_pos` and
 * `published_to_edge` stay false until the pos lane applies discounts (P1). With `id`, also the
 * revisions of that discount, newest first.
 */
export async function readDiscounts(db: Db, branch: string, input: unknown, now: Date) {
  const q = parse(DiscountsQuery, input);
  const catalog = await discountCatalog(db, branch);
  const rows = (
    await db.query<Row>(
      `SELECT ${COLUMNS} WHERE d.branch_id=$1
       ORDER BY CASE d.state WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,lower(d.name),d.id
       LIMIT ${DISCOUNT_LIST_LIMIT + 1}`,
      [branch],
    )
  ).rows;
  const discounts = rows.slice(0, DISCOUNT_LIST_LIMIT).map((row) => {
    const view = discountView(row);
    return {
      ...view,
      period: discountPeriod(view.schedule, now),
      unknown_items: unknownItems(view.scope, catalog),
      valid: DiscountPayloadSchema.safeParse(payloadOf(row)).success,
    };
  });
  let history: ReturnType<typeof revisionView>[] | undefined;
  let historyTruncated = false;
  if (q.id) {
    if (!(await discountRow(db, branch, q.id))) throw new BackofficeError('NOT_FOUND');
    const revisions = (
      await db.query<{
        revision: number;
        snapshot: Record<string, unknown>;
        changed_by_name: string | null;
        changed_at: Date;
      }>(
        `SELECT r.revision,r.snapshot,m.name changed_by_name,r.changed_at FROM bo_discount_revisions r
         LEFT JOIN catalog_managers m ON m.id=r.changed_by
         WHERE r.branch_id=$1 AND r.discount_id=$2 ORDER BY r.revision DESC LIMIT ${DISCOUNT_HISTORY_LIMIT + 1}`,
        [branch, q.id],
      )
    ).rows;
    history = revisions.slice(0, DISCOUNT_HISTORY_LIMIT).map(revisionView);
    historyTruncated = revisions.length > DISCOUNT_HISTORY_LIMIT;
  }
  return {
    schema_version: 1 as const,
    branch_id: branch,
    view: 'discounts' as const,
    timezone: 'Asia/Almaty' as const,
    as_of: now.toISOString(),
    applied_at_pos: false as const,
    published_to_edge: false as const,
    channels: [...DISCOUNT_CHANNELS],
    catalog,
    discounts,
    truncated: rows.length > DISCOUNT_LIST_LIMIT,
    limits: { discounts: DISCOUNT_LIST_LIMIT, history: DISCOUNT_HISTORY_LIMIT },
    ...(q.id ? { id: q.id, history, history_truncated: historyTruncated } : {}),
  };
}
