import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, type DatabaseClient, type DatabasePool } from '@pickchick/database';
import { BackofficeError, parse, periodWindow, stockEffect } from './model.js';
import { readable, type BackofficeOptions } from './stops.js';
import { P1_FEATURE_RELATIONS, p1RelationsReady } from './p1-flags.js';
import { stockP1Ready } from './stock-p1.js';
import {
  MAX_RECIPE_DEPTH,
  MenuLinkLineSchema,
  catalogHas,
  catalogIndex,
  catalogKey,
  cloudOrderLines,
  lineTarget,
  menuLinkItems,
  posOrderLines,
  recipesByOutput,
  resolveOrder,
  roundHalfUp,
  type AutoconsumeMode,
  type CatalogIndex,
  type ConsumptionRetryCommand,
  type ConsumptionSkipCommand,
  type MenuLink,
  type MenuLinkSaveCommand,
  type MenuLinksApproveCommand,
  type OrderLine,
  type Problem,
  type ResolveContext,
  type StockSettingsCommand,
} from './consumption.js';

/**
 * Automatic consumption by sales (Ск2; lane bo-ui, design-bo-ui.md 3, 5.3, 5.5;
 * design-backoffice.md 4): database part.
 *
 * - Menu-stock links (bo_menu_stock_links) live under stock P1 (BACKOFFICE_STOCK_V2_ENABLED with
 *   cloud075 and its rights): GET .../ops/menu-links, menu_link_save, menu_links_approve.
 * - The queue (bo_consumption_items), the branch mode (bo_stock_settings) and the worker live
 *   under BACKOFFICE_STOCK_AUTOCONSUME_ENABLED on top of that: GET .../ops/consumption,
 *   stock_settings, consumption_retry, consumption_skip and runStockConsumption.
 *
 * Selection: a paid POS sale (cloud073 cloud_pos_sales) or a captured cloud order sold at or
 * after start_at, once the kitchen started it (in_production, ready, handed_over) or, for the
 * rest, at the day-close pass (03:00 Almaty of the next day). One item per order (primary key).
 *
 * Application, per item, under the branch lock of the back-office commands (bo:branch:<id>) and
 * in one transaction: the order's own catalog version (POS release -> catalog_menu_deliveries,
 * cloud snapshot catalogReference), the current approved links and recipes, then
 * - void or full refund before the kitchen started, a manual consumption: not_required;
 * - a problem (no link, draft link, unknown item, recipe error): blocked with the reasons;
 * - an ingredient counted at or after the sale (counted_at >= sold_at) is absorbed by that count;
 * - dry_run: previewed with the needs, no document;
 * - on: blocked on a shortage, otherwise exactly one `consumption` document of this order
 *   (source_ref pos:<id> or cloud:<id>, unique in cloud075) with stockEffect('waste') movements
 *   and the item applied. A final item never changes again (cloud075 trigger); a wrong
 *   consumption is corrected by stock_reverse, the item stays applied.
 * Refunds after the kitchen started are not reversed: the queue shows them.
 */

type Db = Pick<DatabaseClient, 'query'>;
const STARTED = `('in_production','ready','handed_over')`;
/** Due items processed per branch and tick; the rest follow on the next tick, in sale order. */
export const CONSUMPTION_BATCH = 200;
/** Retry delays of a blocked item in minutes, by attempt (the last one repeats). */
export const CONSUMPTION_BACKOFF_MINUTES = [1, 2, 5, 15, 30, 60] as const;
/** GET .../ops/consumption lists at most this many items. */
export const CONSUMPTION_LIST_LIMIT = 200;
/** Coverage of the last days: share of sold lines whose links are all approved. */
export const COVERAGE_DAYS = 7;
const COVERAGE_SALES_LIMIT = 5000;

/**
 * The automatic consumption can run for the current database role: the flags, stock P1 (links)
 * and SELECT, INSERT, UPDATE on bo_stock_settings and bo_consumption_items (P1 grants helper).
 */
export async function autoconsumeAvailable(db: Db, options: BackofficeOptions) {
  return (
    options.stockAutoconsumeEnabled === true &&
    options.stockV2Enabled === true &&
    (await stockP1Ready(db)) &&
    (await p1RelationsReady(db, P1_FEATURE_RELATIONS.stock_autoconsume))
  );
}

// ------------------------------------------------------------------------- settings ----

export type StockSettings = {
  autoconsume_mode: AutoconsumeMode;
  start_at: string | null;
  revision: number;
  updated_by: string | null;
  updated_by_name: string | null;
  updated_at: string | null;
};
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null ? null : String(v));
/**
 * A command result as its JSON replay from bo_commands returns it (times as ISO strings), so the
 * first answer and an exact replay are equal.
 */
const plain = <T extends Record<string, unknown> | undefined>(row: T) =>
  (row
    ? Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]),
      )
    : row) as T;
/** The branch mode; no row = off (cloud075). */
export async function readStockSettings(db: Db, branch: string, lock = false) {
  const row = (
    await db.query<{
      autoconsume_mode: AutoconsumeMode;
      start_at: Date | null;
      revision: number;
      updated_by: string;
      updated_by_name: string | null;
      updated_at: Date;
    }>(
      `SELECT s.autoconsume_mode,s.start_at,s.revision,s.updated_by,m.name updated_by_name,s.updated_at
       FROM bo_stock_settings s LEFT JOIN catalog_managers m ON m.id=s.updated_by
       WHERE s.branch_id=$1${lock ? ' FOR UPDATE OF s' : ''}`,
      [branch],
    )
  ).rows[0];
  const settings: StockSettings = row
    ? {
        autoconsume_mode: row.autoconsume_mode,
        start_at: iso(row.start_at),
        revision: row.revision,
        updated_by: row.updated_by,
        updated_by_name: row.updated_by_name,
        updated_at: iso(row.updated_at),
      }
    : {
        autoconsume_mode: 'off',
        start_at: null,
        revision: 0,
        updated_by: null,
        updated_by_name: null,
        updated_at: null,
      };
  return settings;
}
/** stock_settings (manager): the mode and start_at at the revision the screen showed. */
export async function saveStockSettings(
  db: Db,
  branch: string,
  actor: string,
  c: z.infer<typeof StockSettingsCommand>,
) {
  const old = await readStockSettings(db, branch, true);
  if (old.revision !== c.expected_revision) throw new BackofficeError('CONFLICT');
  if (old.revision === 0)
    await db.query(
      'INSERT INTO bo_stock_settings(branch_id,autoconsume_mode,start_at,revision,updated_by) VALUES($1,$2,$3,1,$4)',
      [branch, c.autoconsume_mode, c.start_at, actor],
    );
  else
    await db.query(
      'UPDATE bo_stock_settings SET autoconsume_mode=$2,start_at=$3,revision=revision+1,updated_by=$4,updated_at=clock_timestamp() WHERE branch_id=$1',
      [branch, c.autoconsume_mode, c.start_at, actor],
    );
  return readStockSettings(db, branch);
}

// ---------------------------------------------------------------------------- links ----

type LinkRow = MenuLink & {
  updated_by_name: string;
  updated_at: Date;
  approved_by_name: string | null;
  approved_at: Date | null;
};
async function readLinks(db: Db, branch: string): Promise<Map<string, LinkRow>> {
  const rows = (
    await db.query<{
      catalog_key: string;
      effect: 'consume' | 'none';
      lines: unknown;
      status: 'draft' | 'approved';
      revision: number;
      updated_by_name: string;
      updated_at: Date;
      approved_by_name: string | null;
      approved_at: Date | null;
    }>(
      `SELECT l.catalog_key,l.effect,l.lines,l.status,l.revision,u.name updated_by_name,l.updated_at,
         a.name approved_by_name,l.approved_at
       FROM bo_menu_stock_links l JOIN catalog_managers u ON u.id=l.updated_by
       LEFT JOIN catalog_managers a ON a.id=l.approved_by
       WHERE l.branch_id=$1 ORDER BY l.catalog_key`,
      [branch],
    )
  ).rows;
  const out = new Map<string, LinkRow>();
  for (const row of rows) {
    const lines = z.array(MenuLinkLineSchema).safeParse(row.lines);
    // A stored line the command never writes cannot be trusted: such a link counts as a draft.
    out.set(row.catalog_key, {
      ...row,
      lines: lines.success ? lines.data : [],
      status: lines.success ? row.status : 'draft',
    });
  }
  return out;
}
type Catalog = { version: number; published_at: Date; payload: unknown };
/** The head publication of the branch; null before the first one or without read access. */
async function headCatalog(db: Db, branch: string): Promise<Catalog | null> {
  if (!(await readable(db, 'catalog_publications'))) return null;
  return (
    (
      await db.query<Catalog>(
        `SELECT p.version,p.published_at,p.payload FROM catalog_branch_heads h
         JOIN catalog_publications p ON p.branch_id=h.branch_id AND p.version=h.published_version
         WHERE h.branch_id=$1`,
        [branch],
      )
    ).rows[0] ?? null
  );
}
type StockItem = { id: string; name: string; unit: string };
async function stockItems(db: Db, branch: string) {
  const rows = (
    await db.query<{ id: string; name: string; unit: string }>(
      "SELECT id,payload->>'name' AS name,payload->>'unit' AS unit FROM bo_records WHERE branch_id=$1 AND kind='ingredient'",
      [branch],
    )
  ).rows;
  return new Map<string, StockItem>(rows.map((r) => [r.id, r]));
}
async function recipeRecords(db: Db, branch: string) {
  return (
    await db.query<{ id: string; revision: number; payload: unknown }>(
      "SELECT id,revision,payload FROM bo_records WHERE branch_id=$1 AND kind='recipe' ORDER BY id",
      [branch],
    )
  ).rows;
}
/**
 * Outputs of production recipes that a sale reaches through an approved menu link: the
 * `recipe_output_id` lines of the approved links and, through recipes not kept as stock, the
 * nested outputs of their lines. `produce` refuses a recipe of such an output while its
 * stock_policy is not chosen (RECIPE_POLICY_UNSET, review BOUI-R1).
 */
export async function linkedOutputs(db: Db, branch: string): Promise<Set<string>> {
  const links = await readLinks(db, branch);
  const recipes = recipesByOutput(await recipeRecords(db, branch));
  const out = new Set<string>();
  const visit = (output: string, depth: number) => {
    if (out.has(output) || depth > MAX_RECIPE_DEPTH) return;
    out.add(output);
    const list = recipes.get(output);
    if (list?.length !== 1 || list[0]!.recipe.stock_policy === 'stock') return;
    for (const line of list[0]!.recipe.lines)
      if (recipes.has(line.ingredient_id)) visit(line.ingredient_id, depth + 1);
  };
  for (const link of links.values())
    if (link.status === 'approved')
      for (const line of link.lines)
        if ('recipe_output_id' in line) visit(line.recipe_output_id, 0);
  return out;
}
/**
 * menu_link_save (manager): the link of one catalog product or option of the head publication.
 * A new or changed effect or lines is a draft again; a save that changes nothing keeps an approval.
 */
export async function saveMenuLink(
  db: Db,
  branch: string,
  actor: string,
  c: z.infer<typeof MenuLinkSaveCommand>,
) {
  const catalog = await headCatalog(db, branch);
  if (!catalog) throw new BackofficeError('NOT_READY', 'CATALOG_NOT_PUBLISHED');
  const ref = {
    product_id: c.catalog_ref.product_id,
    ...(c.catalog_ref.group_id !== undefined && c.catalog_ref.option_id !== undefined
      ? { group_id: c.catalog_ref.group_id, option_id: c.catalog_ref.option_id }
      : {}),
  };
  if (!catalogHas(catalogIndex(branch, catalog.version, catalog.payload), ref))
    throw new BackofficeError('NOT_FOUND', 'CATALOG_ITEM_NOT_FOUND');
  const items = await stockItems(db, branch);
  const outputs = recipesByOutput(await recipeRecords(db, branch));
  for (const line of c.lines) {
    if (
      'ingredient_id' in line ? !items.has(line.ingredient_id) : !items.has(line.recipe_output_id)
    )
      throw new BackofficeError('INVALID_REQUEST');
    // A recipe output names exactly one production recipe of the branch.
    if ('recipe_output_id' in line && outputs.get(line.recipe_output_id)?.length !== 1)
      throw new BackofficeError('INVALID_REQUEST');
  }
  const key = catalogKey(ref);
  const old = (
    await db.query<{ revision: number }>(
      'SELECT revision FROM bo_menu_stock_links WHERE branch_id=$1 AND catalog_key=$2 FOR UPDATE',
      [branch, key],
    )
  ).rows[0];
  if ((old?.revision ?? 0) !== c.expected_revision) throw new BackofficeError('CONFLICT');
  const lines = JSON.stringify(c.lines);
  if (!old)
    await db.query(
      `INSERT INTO bo_menu_stock_links(branch_id,catalog_key,product_slug,group_slug,option_slug,effect,lines,revision,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,1,$8)`,
      [
        branch,
        key,
        ref.product_id,
        ref.group_id ?? null,
        ref.option_id ?? null,
        c.effect,
        lines,
        actor,
      ],
    );
  else {
    // Compared as jsonb (key order normalised): the SET expressions read the old row.
    await db.query(
      `UPDATE bo_menu_stock_links SET effect=$3,lines=$4::jsonb,revision=revision+1,updated_by=$5,updated_at=clock_timestamp(),
         status=CASE WHEN effect=$3 AND lines=$4::jsonb THEN status ELSE 'draft' END,
         approved_by=CASE WHEN effect=$3 AND lines=$4::jsonb THEN approved_by ELSE NULL END,
         approved_at=CASE WHEN effect=$3 AND lines=$4::jsonb THEN approved_at ELSE NULL END
       WHERE branch_id=$1 AND catalog_key=$2`,
      [branch, key, c.effect, lines, actor],
    );
  }
  return linkResult(db, branch, key);
}
async function linkResult(db: Db, branch: string, key: string) {
  return plain(
    (
      await db.query(
        `SELECT catalog_key,effect,lines,status,revision,updated_by,updated_at,approved_by,approved_at
       FROM bo_menu_stock_links WHERE branch_id=$1 AND catalog_key=$2`,
        [branch, key],
      )
    ).rows[0],
  );
}
/** menu_links_approve (manager, for the chef): every key at its revision; approved stays as is. */
export async function approveMenuLinks(
  db: Db,
  branch: string,
  actor: string,
  c: z.infer<typeof MenuLinksApproveCommand>,
) {
  const approved: unknown[] = [];
  for (const key of [...c.keys].sort()) {
    const row = (
      await db.query<{ status: string; revision: number }>(
        'SELECT status,revision FROM bo_menu_stock_links WHERE branch_id=$1 AND catalog_key=$2 FOR UPDATE',
        [branch, key],
      )
    ).rows[0];
    if (!row) throw new BackofficeError('NOT_FOUND');
    if (row.revision !== c.expected_revisions[key]) throw new BackofficeError('CONFLICT');
    if (row.status !== 'approved')
      await db.query(
        "UPDATE bo_menu_stock_links SET status='approved',approved_by=$3,approved_at=clock_timestamp(),revision=revision+1 WHERE branch_id=$1 AND catalog_key=$2",
        [branch, key, actor],
      );
    approved.push(await linkResult(db, branch, key));
  }
  return { approved };
}
const linkLineView =
  (items: Map<string, StockItem>) => (line: z.infer<typeof MenuLinkLineSchema>) => {
    const item = items.get(lineTarget(line));
    return { ...line, name: item?.name ?? null, unit: item?.unit ?? null };
  };
const linkView = (link: LinkRow, items: Map<string, StockItem>) => ({
  effect: link.effect,
  lines: link.lines.map(linkLineView(items)),
  status: link.status,
  revision: link.revision,
  updated_by_name: link.updated_by_name,
  updated_at: iso(link.updated_at),
  approved_by_name: link.approved_by_name,
  approved_at: iso(link.approved_at),
});
/** GET .../ops/menu-links (stock P1): the head catalog with the link of every product and option. */
export async function readMenuLinks(db: Db, branch: string, input: unknown) {
  parse(z.strictObject({}), input);
  const catalog = await headCatalog(db, branch);
  const links = await readLinks(db, branch);
  const items = await stockItems(db, branch);
  const index = catalog ? catalogIndex(branch, catalog.version, catalog.payload) : null;
  const rows = index
    ? menuLinkItems(index, links).map((item) => {
        const link = links.get(item.catalog_key);
        return { ...item, link: link ? linkView(link, items) : null };
      })
    : [];
  const known = new Set(rows.map((r) => r.catalog_key));
  const listed = rows.filter((r) => r.listed);
  return {
    schema_version: 1 as const,
    branch_id: branch,
    catalog: catalog ? { version: catalog.version, published_at: iso(catalog.published_at) } : null,
    items: rows,
    // Links of products and options the head catalog no longer has (a changed slug).
    orphans: [...links.values()]
      .filter((link) => !known.has(link.catalog_key))
      .map((link) => ({ catalog_key: link.catalog_key, link: linkView(link, items) })),
    coverage: {
      items: listed.length,
      linked: listed.filter((r) => r.link).length,
      approved: listed.filter((r) => r.link?.status === 'approved').length,
      without_link: listed.filter((r) => !r.link && !r.covered_without_link).length,
    },
  };
}

// ---------------------------------------------------------------------------- queue ----

type Settings = {
  autoconsume_mode: AutoconsumeMode;
  start_at: string | null;
  updated_by: string | null;
};
/** Day-close pass: 03:00 Almaty of the day after the sale. */
const dayClosed = (column: string) =>
  `((((${column}) AT TIME ZONE 'Asia/Almaty')::date + 1) + time '03:00') AT TIME ZONE 'Asia/Almaty' <= $3`;
async function bounds(db: Db, branch: string, source: 'pos' | 'cloud') {
  return (
    await db.query<{ min: Date | null; max: Date | null }>(
      'SELECT min(sold_at) min,max(sold_at) max FROM bo_consumption_items WHERE branch_id=$1 AND source=$2',
      [branch, source],
    )
  ).rows[0]!;
}
/**
 * New queue items of the branch, in sale order. Each tick looks at the sales since start_at that
 * are older than the oldest item (start_at moved back) or newer than the newest item minus seven
 * days (late kitchen states, late POS uploads); the gap between them is already queued.
 */
export async function enqueueConsumption(db: Db, branch: string, settings: Settings, now: Date) {
  if (settings.autoconsume_mode === 'off' || settings.start_at === null) return 0;
  let added = 0;
  if (await readable(db, 'cloud_pos_sales')) {
    const b = await bounds(db, branch, 'pos');
    added +=
      (
        await db.query(
          `INSERT INTO bo_consumption_items(branch_id,source,order_id,sold_at,trigger_kind,revision)
           SELECT s.branch_id,'pos',s.order_id,s.sold_at,
             CASE WHEN k.state IN ${STARTED} THEN 'kitchen_started' ELSE 'day_close' END,1
           FROM cloud_pos_sales s
           LEFT JOIN pos_kitchen_sync_projection k ON k.order_id=s.order_id AND k.branch_id=s.branch_id
           WHERE s.branch_id=$1 AND s.sold_at >= $2 AND s.sold_at <= $3
             AND s.business_date >= (($2::timestamptz AT TIME ZONE 'Asia/Almaty')::date - 1)
             AND ($5::timestamptz IS NULL OR s.sold_at < $5 OR s.sold_at >= $6::timestamptz - interval '7 days')
             AND (k.state IN ${STARTED} OR ${dayClosed('s.sold_at')})
             AND NOT EXISTS(SELECT 1 FROM bo_consumption_items i WHERE i.branch_id=s.branch_id AND i.source='pos' AND i.order_id=s.order_id)
           ORDER BY s.sold_at,s.order_id LIMIT $4
           ON CONFLICT DO NOTHING`,
          [branch, settings.start_at, now, CONSUMPTION_BATCH, b.min, b.max],
        )
      ).rowCount ?? 0;
  }
  const b = await bounds(db, branch, 'cloud');
  added +=
    (
      await db.query(
        `INSERT INTO bo_consumption_items(branch_id,source,order_id,sold_at,trigger_kind,revision)
         SELECT o.branch_id,'cloud',o.id,c.sold_at,
           CASE WHEN f.state IN ${STARTED} THEN 'kitchen_started' ELSE 'day_close' END,1
         FROM commerce_orders o
         JOIN LATERAL (SELECT min(x.occurred_at) sold_at FROM commerce_captures x WHERE x.order_id=o.id) c ON c.sold_at IS NOT NULL
         LEFT JOIN cloud_fulfillment_projection f ON f.order_id=o.id
         WHERE o.branch_id=$1 AND o.created_at >= $2::timestamptz - interval '1 day'
           AND c.sold_at >= $2 AND c.sold_at <= $3
           AND ($5::timestamptz IS NULL OR c.sold_at < $5 OR c.sold_at >= $6::timestamptz - interval '7 days')
           AND (f.state IN ${STARTED} OR ${dayClosed('c.sold_at')})
           AND NOT EXISTS(SELECT 1 FROM bo_consumption_items i WHERE i.branch_id=o.branch_id AND i.source='cloud' AND i.order_id=o.id)
         ORDER BY c.sold_at,o.id LIMIT $4
         ON CONFLICT DO NOTHING`,
        [branch, settings.start_at, now, CONSUMPTION_BATCH, b.min, b.max],
      )
    ).rowCount ?? 0;
  return added;
}
type ItemKey = { source: 'pos' | 'cloud'; order_id: string };
/**
 * Items to process now, oldest sale first: pending; blocked whose retry time came or after a
 * stock document, a link or a recipe changed since the last attempt; previewed once the mode is
 * on. Only sales at or after start_at.
 */
export async function dueConsumption(
  db: Db,
  branch: string,
  settings: Settings,
  now: Date,
  limit = CONSUMPTION_BATCH,
): Promise<ItemKey[]> {
  if (settings.autoconsume_mode === 'off' || settings.start_at === null) return [];
  return (
    await db.query<ItemKey>(
      `SELECT i.source,i.order_id FROM bo_consumption_items i
       WHERE i.branch_id=$1 AND i.sold_at >= $2 AND (i.state='pending'
         OR (i.state='previewed' AND $4='on')
         OR (i.state='blocked' AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= $3
           OR EXISTS(SELECT 1 FROM bo_stock_documents d WHERE d.branch_id=i.branch_id AND d.created_at > i.updated_at AND d.kind IN ('receipt','count','production','reversal'))
           OR EXISTS(SELECT 1 FROM bo_menu_stock_links l WHERE l.branch_id=i.branch_id AND greatest(l.updated_at,l.approved_at) > i.updated_at)
           OR EXISTS(SELECT 1 FROM bo_records r WHERE r.branch_id=i.branch_id AND r.kind IN ('recipe','ingredient') AND r.updated_at > i.updated_at))))
       ORDER BY i.sold_at,i.source,i.order_id LIMIT $5`,
      [branch, settings.start_at, now, settings.autoconsume_mode, limit],
    )
  ).rows;
}

type Item = {
  source: 'pos' | 'cloud';
  order_id: string;
  sold_at: Date;
  state: string;
  revision: number;
  attempts: number;
  detail: Record<string, unknown>;
};
type Outcome = {
  state: 'previewed' | 'applied' | 'blocked' | 'not_required';
  reason: string | null;
  detail: Record<string, unknown>;
  document_id: string | null;
};
const FINAL = ['applied', 'skipped', 'not_required'];
/** Catalog payloads by version (immutable publications), shared by the items of a tick. */
export type CatalogCache = Map<number, CatalogIndex | null>;
async function catalogOf(db: Db, branch: string, version: number, cache: CatalogCache) {
  if (!cache.has(version)) {
    const row = (
      await db.query<{ payload: unknown }>(
        'SELECT payload FROM catalog_publications WHERE branch_id=$1 AND version=$2',
        [branch, version],
      )
    ).rows[0];
    cache.set(version, row ? catalogIndex(branch, version, row.payload) : null);
  }
  return cache.get(version) ?? null;
}
async function posVersion(db: Db, branch: string, release: string) {
  return (
    (
      await db.query<{ catalog_version: number }>(
        'SELECT catalog_version FROM catalog_menu_deliveries WHERE release_id=$1 AND branch_id=$2',
        [release, branch],
      )
    ).rows[0]?.catalog_version ?? null
  );
}
type Order = {
  display_number: string | null;
  kitchen_state: string | null;
  cancelled: boolean;
  refunded: boolean;
  version: number | null;
  lines: OrderLine[];
  unknown: number;
};
async function loadOrder(
  db: Db,
  branch: string,
  item: ItemKey,
  cache: CatalogCache,
): Promise<Order | null> {
  if (item.source === 'pos') {
    const sale = (
      await db.query<{
        display_number: number;
        state: string;
        total_minor: string;
        release_id: string;
        lines: unknown;
        kitchen_state: string | null;
      }>(
        `SELECT s.display_number,s.state,s.total_minor::text,s.release_id,s.lines,k.state kitchen_state
         FROM cloud_pos_sales s LEFT JOIN pos_kitchen_sync_projection k ON k.order_id=s.order_id AND k.branch_id=s.branch_id
         WHERE s.order_id=$1 AND s.branch_id=$2`,
        [item.order_id, branch],
      )
    ).rows[0];
    if (!sale) return null;
    const refunded = (await readable(db, 'cloud_pos_refunds'))
      ? (
          await db.query<{ amount: string }>(
            "SELECT coalesce(sum(amount_minor),0)::text amount FROM cloud_pos_refunds WHERE order_id=$1 AND branch_id=$2 AND kind='refund'",
            [item.order_id, branch],
          )
        ).rows[0]!.amount
      : '0';
    const version = await posVersion(db, branch, sale.release_id);
    const catalog = version === null ? null : await catalogOf(db, branch, version, cache);
    const lines = catalog ? posOrderLines(catalog, sale.lines) : { lines: [], unknown: 0 };
    return {
      display_number: String(sale.display_number),
      kitchen_state: sale.kitchen_state,
      // Voided, or refunded in full.
      cancelled: sale.state === 'voided' || BigInt(refunded) >= BigInt(sale.total_minor),
      refunded: BigInt(refunded) > 0n,
      version: catalog ? version : null,
      lines: lines.lines,
      unknown: lines.unknown,
    };
  }
  const order = (
    await db.query<{
      snapshot: unknown;
      kitchen_state: string | null;
      display_number: string | null;
      captured: string;
      refunded: string;
    }>(
      `SELECT o.snapshot,f.state kitchen_state,f.display_number::text,
         (SELECT coalesce(sum(c.amount_minor),0)::text FROM commerce_captures c WHERE c.order_id=o.id) captured,
         (SELECT coalesce(sum(r.amount_minor),0)::text FROM commerce_refund_effects r WHERE r.order_id=o.id) refunded
       FROM commerce_orders o LEFT JOIN cloud_fulfillment_projection f ON f.order_id=o.id
       WHERE o.id=$1 AND o.branch_id=$2`,
      [item.order_id, branch],
    )
  ).rows[0];
  if (!order) return null;
  const parsed = cloudOrderLines(order.snapshot);
  const catalog =
    parsed.version === null ? null : await catalogOf(db, branch, parsed.version, cache);
  return {
    display_number: order.display_number,
    kitchen_state: order.kitchen_state,
    cancelled: BigInt(order.refunded) >= BigInt(order.captured),
    refunded: BigInt(order.refunded) > 0n,
    version: catalog ? parsed.version : null,
    lines: catalog ? parsed.lines : [],
    unknown: 0,
  };
}
const backoff = (attempts: number) =>
  CONSUMPTION_BACKOFF_MINUTES[Math.min(attempts, CONSUMPTION_BACKOFF_MINUTES.length) - 1] ??
  CONSUMPTION_BACKOFF_MINUTES[0];
/** The reason of a blocked item: a missing link first, then the first problem. */
const blockReason = (problems: Problem[]) =>
  problems.some((p) => p.code === 'NO_LINK') ? 'NO_LINK' : (problems[0]?.code ?? 'NO_LINK');

/**
 * One queue item, inside the caller's transaction that holds the branch lock (the worker per
 * item, consumption_retry inside the command envelope). Returns the item after the attempt, or
 * null when it is not due here (final, unknown, mode off, sold before start_at).
 */
export async function processConsumptionItem(
  db: Db,
  branch: string,
  key: ItemKey,
  settings: Settings,
  actor: string,
  cache: CatalogCache = new Map(),
) {
  const item = (
    await db.query<Item>(
      `SELECT source,order_id,sold_at,state,revision,attempts,detail FROM bo_consumption_items
       WHERE branch_id=$1 AND source=$2 AND order_id=$3 FOR UPDATE`,
      [branch, key.source, key.order_id],
    )
  ).rows[0];
  if (!item || FINAL.includes(item.state)) return null;
  if (
    settings.autoconsume_mode === 'off' ||
    settings.start_at === null ||
    item.sold_at.getTime() < Date.parse(settings.start_at)
  )
    return null;
  const outcome = await attempt(db, branch, item, settings.autoconsume_mode, actor, cache);
  const retry =
    outcome.state === 'blocked'
      ? `clock_timestamp() + interval '${backoff(item.attempts + 1)} minutes'`
      : 'NULL';
  const row = (
    await db.query(
      `UPDATE bo_consumption_items SET state=$4,reason=$5,detail=$6,document_id=$7,attempts=attempts+1,
         next_attempt_at=${retry},revision=revision+1,updated_at=clock_timestamp()
       WHERE branch_id=$1 AND source=$2 AND order_id=$3
       RETURNING source,order_id,sold_at,state,reason,detail,document_id,trigger_kind,attempts,next_attempt_at,revision,updated_at`,
      [
        branch,
        item.source,
        item.order_id,
        outcome.state,
        outcome.reason,
        outcome.detail,
        outcome.document_id,
      ],
    )
  ).rows[0] as Record<string, unknown> | undefined;
  return row ? plain(row) : null;
}
async function attempt(
  db: Db,
  branch: string,
  item: Item,
  mode: 'dry_run' | 'on',
  actor: string,
  cache: CatalogCache,
): Promise<Outcome> {
  const order = await loadOrder(db, branch, item, cache);
  if (!order) return { state: 'blocked', reason: 'ORDER_UNKNOWN', detail: {}, document_id: null };
  const base = {
    display_number: order.display_number,
    catalog_version: order.version,
    kitchen_state: order.kitchen_state,
    cancelled: order.cancelled,
    refunded: order.refunded,
  };
  const started = ['in_production', 'ready', 'handed_over'].includes(order.kitchen_state ?? '');
  // Voids and full refunds before the kitchen started cost nothing.
  if (order.cancelled && !started)
    return {
      state: 'not_required',
      reason: 'CANCELLED_BEFORE_KITCHEN',
      detail: base,
      document_id: null,
    };
  if (
    item.source === 'cloud' &&
    (
      await db.query(
        "SELECT 1 FROM bo_stock_documents WHERE order_id=$1 AND branch_id=$2 AND kind='consumption'",
        [item.order_id, branch],
      )
    ).rowCount
  )
    return { state: 'not_required', reason: 'MANUAL_CONSUMPTION', detail: base, document_id: null };
  if (order.version === null)
    return { state: 'blocked', reason: 'MENU_VERSION_UNKNOWN', detail: base, document_id: null };
  const ingredients = await stockItems(db, branch);
  const links = await readLinks(db, branch);
  const context: ResolveContext = {
    catalog: (await catalogOf(db, branch, order.version, cache))!,
    links,
    recipes: recipesByOutput(await recipeRecords(db, branch)),
    ingredients: new Set(ingredients.keys()),
  };
  const resolution = resolveOrder(context, order.lines);
  const problems = [...resolution.problems];
  if (order.unknown)
    problems.unshift({ code: 'ITEM_UNKNOWN', catalog_key: null, name: null, ingredient_id: null });
  if (problems.length)
    return {
      state: 'blocked',
      reason: blockReason(problems),
      detail: { ...base, problems },
      document_id: null,
    };
  const wanted = [...resolution.needs.keys()].sort();
  const balances = new Map(
    (
      await db.query<{
        ingredient_id: string;
        quantity: string;
        value_minor: string;
        revision: number;
        counted_at: Date | null;
      }>(
        `SELECT ingredient_id,quantity::text,value_minor::text,revision,counted_at FROM bo_stock_balances
         WHERE branch_id=$1 AND ingredient_id=ANY($2::uuid[]) ORDER BY ingredient_id FOR UPDATE`,
        [branch, wanted],
      )
    ).rows.map((b) => [b.ingredient_id, b]),
  );
  const needs = wanted.map((id) => {
    const exact = resolution.needs.get(id)!;
    const b = balances.get(id);
    const absorbed = b?.counted_at ? b.counted_at.getTime() >= item.sold_at.getTime() : false;
    return {
      ingredient_id: id,
      name: ingredients.get(id)?.name ?? null,
      unit: ingredients.get(id)?.unit ?? null,
      quantity: roundHalfUp(exact).toString(),
      exact: `${exact.n}/${exact.d}`,
      available: b?.quantity ?? '0',
      absorbed_by_count: absorbed,
    };
  });
  const consume = needs.filter((n) => !n.absorbed_by_count && BigInt(n.quantity) > 0n);
  const shortages = consume
    .filter((n) => BigInt(n.quantity) > BigInt(n.available))
    .map((n) => ({
      ingredient_id: n.ingredient_id,
      name: n.name,
      unit: n.unit,
      need: n.quantity,
      have: n.available,
    }));
  const detail = {
    ...base,
    needs,
    shortages,
    links: resolution.links,
    recipes: resolution.recipes,
  };
  if (mode === 'dry_run') return { state: 'previewed', reason: null, detail, document_id: null };
  if (shortages.length)
    return { state: 'blocked', reason: 'INSUFFICIENT_STOCK', detail, document_id: null };
  if (!consume.length)
    return {
      state: 'not_required',
      reason: needs.some((n) => n.absorbed_by_count) ? 'ABSORBED_BY_COUNT' : 'NOTHING_TO_CONSUME',
      detail,
      document_id: null,
    };
  const id = randomUUID();
  const reference =
    item.source === 'pos'
      ? `Продажа кассы №${order.display_number}`
      : `Заказ ${order.display_number ? '№' + order.display_number : item.order_id.slice(0, 8)}`;
  await db.query(
    `INSERT INTO bo_stock_documents(id,branch_id,actor_id,kind,reference,reason,order_id,recipe_snapshot,source_ref)
     VALUES($1,$2,$3,'consumption',$4,$5,$6,$7,$8)`,
    [
      id,
      branch,
      actor,
      reference,
      'Автоматическое списание по продаже',
      item.source === 'cloud' ? item.order_id : null,
      JSON.stringify({
        source: item.source,
        order_id: item.order_id,
        sold_at: item.sold_at.toISOString(),
        catalog_version: order.version,
        links: resolution.links,
        recipes: resolution.recipes,
        needs,
      }),
      `${item.source}:${item.order_id}`,
    ],
  );
  for (const n of consume) {
    const b = balances.get(n.ingredient_id)!;
    const e = stockEffect('waste', b, { quantity: n.quantity, value_minor: '0' });
    await db.query(
      'UPDATE bo_stock_balances SET quantity=$3,value_minor=$4,revision=revision+1 WHERE branch_id=$1 AND ingredient_id=$2',
      [branch, n.ingredient_id, e.quantity, e.value_minor],
    );
    await db.query(
      'INSERT INTO bo_stock_movements(document_id,branch_id,ingredient_id,quantity_delta,value_delta_minor,balance_after,value_after_minor) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        id,
        branch,
        n.ingredient_id,
        e.quantity_delta,
        e.value_delta_minor,
        e.quantity,
        e.value_minor,
      ],
    );
  }
  return { state: 'applied', reason: null, detail, document_id: id };
}

/** consumption_retry (manager, shift manager): the item is processed now, inside the command. */
export async function retryConsumption(
  db: Db,
  branch: string,
  actor: string,
  c: z.infer<typeof ConsumptionRetryCommand>,
) {
  const item = (
    await db.query<{ state: string; revision: number }>(
      'SELECT state,revision FROM bo_consumption_items WHERE branch_id=$1 AND source=$2 AND order_id=$3 FOR UPDATE',
      [branch, c.source, c.order_id],
    )
  ).rows[0];
  if (!item) throw new BackofficeError('NOT_FOUND');
  if (item.revision !== c.expected_revision || FINAL.includes(item.state))
    throw new BackofficeError('CONFLICT');
  const settings = await readStockSettings(db, branch);
  const result = await processConsumptionItem(db, branch, c, settings, actor);
  if (!result) throw new BackofficeError('NOT_READY');
  return result;
}
/** consumption_skip (manager, shift manager): never written off; the reason is the request's. */
export async function skipConsumption(
  db: Db,
  branch: string,
  actor: string,
  reason: string,
  c: z.infer<typeof ConsumptionSkipCommand>,
) {
  const item = (
    await db.query<{ state: string; revision: number; detail: Record<string, unknown> }>(
      'SELECT state,revision,detail FROM bo_consumption_items WHERE branch_id=$1 AND source=$2 AND order_id=$3 FOR UPDATE',
      [branch, c.source, c.order_id],
    )
  ).rows[0];
  if (!item) throw new BackofficeError('NOT_FOUND');
  if (item.revision !== c.expected_revision || FINAL.includes(item.state))
    throw new BackofficeError('CONFLICT');
  return plain(
    (
      await db.query(
        `UPDATE bo_consumption_items SET state='skipped',reason=$4,detail=$5,next_attempt_at=NULL,
         revision=revision+1,updated_at=clock_timestamp()
       WHERE branch_id=$1 AND source=$2 AND order_id=$3
       RETURNING source,order_id,sold_at,state,reason,detail,document_id,trigger_kind,attempts,next_attempt_at,revision,updated_at`,
        [
          branch,
          c.source,
          c.order_id,
          reason,
          { ...item.detail, skipped_by: actor, skipped_from: item.state },
        ],
      )
    ).rows[0] as Record<string, unknown>,
  );
}

/** Manual `consume` while the branch writes off automatically (dry_run or on). */
export async function assertManualConsume(db: Db, branch: string, options: BackofficeOptions) {
  if (!(await autoconsumeAvailable(db, options))) return;
  if ((await readStockSettings(db, branch)).autoconsume_mode !== 'off')
    throw new BackofficeError('CONFLICT', 'AUTOCONSUME_ACTIVE');
}

// ----------------------------------------------------------------------------- read ----

const day = z.iso.date().refine((v) => v >= '2000-01-01' && v <= '2099-12-31');
export const CONSUMPTION_STATES = [
  'pending',
  'previewed',
  'applied',
  'blocked',
  'skipped',
  'not_required',
] as const;
export const ConsumptionQuery = z.strictObject({
  state: z.enum(CONSUMPTION_STATES).optional(),
  date: day.optional(),
});
const almatyDay = (now: Date, back = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(
    new Date(now.getTime() - back * 86400000),
  );
/**
 * Share of the sold lines of the last seven Almaty days (today included) whose every link is
 * approved, with the most frequent missing items: the 95 % rule of the runbook before `on`.
 */
async function coverage(db: Db, branch: string, now: Date) {
  const start = almatyDay(now, COVERAGE_DAYS - 1);
  const { start: from } = periodWindow(
    { period: 'custom', start_date: start, end_date: start },
    now,
  );
  const cache: CatalogCache = new Map();
  const ingredients = await stockItems(db, branch);
  const context = {
    links: await readLinks(db, branch),
    recipes: recipesByOutput(await recipeRecords(db, branch)),
    ingredients: new Set(ingredients.keys()),
  };
  let sold = 0,
    linked = 0;
  const missing = new Map<string, { catalog_key: string; name: string | null; lines: number }>();
  const count = (catalog: CatalogIndex | null, lines: OrderLine[], unknown: number) => {
    sold += lines.length + unknown;
    if (!catalog) return;
    for (const line of lines) {
      const r = resolveOrder({ ...context, catalog }, [line]);
      if (!r.problems.length) linked++;
      for (const p of r.problems.filter((p) => p.catalog_key)) {
        const m = missing.get(p.catalog_key!) ?? {
          catalog_key: p.catalog_key!,
          name: p.name,
          lines: 0,
        };
        m.lines++;
        missing.set(p.catalog_key!, m);
      }
    }
  };
  let truncated = false;
  if (await readable(db, 'cloud_pos_sales')) {
    const sales = (
      await db.query<{ release_id: string; lines: unknown }>(
        `SELECT release_id,lines FROM cloud_pos_sales WHERE branch_id=$1 AND business_date >= $2::date
         ORDER BY sold_at DESC,order_id LIMIT ${COVERAGE_SALES_LIMIT + 1}`,
        [branch, start],
      )
    ).rows;
    truncated ||= sales.length > COVERAGE_SALES_LIMIT;
    const versions = new Map<string, number | null>();
    for (const sale of sales.slice(0, COVERAGE_SALES_LIMIT)) {
      if (!versions.has(sale.release_id))
        versions.set(sale.release_id, await posVersion(db, branch, sale.release_id));
      const version = versions.get(sale.release_id) ?? null;
      const catalog = version === null ? null : await catalogOf(db, branch, version, cache);
      if (!catalog) {
        const n = Array.isArray(sale.lines) ? sale.lines.length : 1;
        sold += n;
        continue;
      }
      const lines = posOrderLines(catalog, sale.lines);
      count(catalog, lines.lines, lines.unknown);
    }
  }
  const orders = (
    await db.query<{ snapshot: unknown }>(
      `SELECT o.snapshot FROM commerce_orders o WHERE o.branch_id=$1 AND o.created_at >= $2
         AND EXISTS(SELECT 1 FROM commerce_captures c WHERE c.order_id=o.id)
       ORDER BY o.created_at DESC,o.id LIMIT ${COVERAGE_SALES_LIMIT + 1}`,
      [branch, from],
    )
  ).rows;
  truncated ||= orders.length > COVERAGE_SALES_LIMIT;
  for (const order of orders.slice(0, COVERAGE_SALES_LIMIT)) {
    const parsed = cloudOrderLines(order.snapshot);
    const catalog =
      parsed.version === null ? null : await catalogOf(db, branch, parsed.version, cache);
    count(catalog, parsed.lines, 0);
  }
  return {
    days: COVERAGE_DAYS,
    start_date: start,
    end_date: almatyDay(now),
    sold_lines: sold,
    linked_lines: linked,
    share_bp: sold ? Math.floor((linked * 10000) / sold) : null,
    missing: [...missing.values()]
      .sort((a, b) => b.lines - a.lines || a.catalog_key.localeCompare(b.catalog_key))
      .slice(0, 20),
    truncated,
  };
}
/** GET .../ops/consumption (autoconsume): mode, queue of a day or of all days, counts, coverage. */
export async function readConsumption(db: Db, branch: string, input: unknown, now: Date) {
  const q = parse(ConsumptionQuery, input);
  const window = q.date
    ? periodWindow({ period: 'custom', start_date: q.date, end_date: q.date }, now)
    : null;
  const scope = `i.branch_id=$1 AND ($2::timestamptz IS NULL OR (i.sold_at >= $2 AND i.sold_at < $3))`;
  const args = [branch, window?.start ?? null, window?.end ?? null];
  const pos = await readable(db, 'cloud_pos_sales');
  const posRefunds = await readable(db, 'cloud_pos_refunds');
  const items = (
    await db.query(
      `SELECT i.source,i.order_id,i.sold_at,i.state,i.reason,i.detail,i.document_id,i.trigger_kind,
         i.attempts,i.next_attempt_at,i.revision,i.updated_at,
         CASE WHEN i.source='pos' THEN ${pos ? '(SELECT s.display_number::text FROM cloud_pos_sales s WHERE s.order_id=i.order_id AND s.branch_id=i.branch_id)' : 'NULL'}
           ELSE (SELECT f.display_number::text FROM cloud_fulfillment_projection f WHERE f.order_id=i.order_id) END display_number,
         EXISTS(SELECT 1 FROM bo_stock_documents r WHERE r.reverses_document_id=i.document_id AND r.branch_id=i.branch_id AND r.kind='reversal') reversed,
         CASE WHEN i.source='pos' THEN ${
           pos
             ? `coalesce((SELECT s.state='voided' FROM cloud_pos_sales s WHERE s.order_id=i.order_id AND s.branch_id=i.branch_id),false)${
                 posRefunds
                   ? " OR EXISTS(SELECT 1 FROM cloud_pos_refunds x WHERE x.order_id=i.order_id AND x.branch_id=i.branch_id AND x.kind='refund')"
                   : ''
               }`
             : 'false'
         }
           ELSE EXISTS(SELECT 1 FROM commerce_refund_effects e WHERE e.order_id=i.order_id) END refunded
       FROM bo_consumption_items i WHERE ${scope}${q.state ? ' AND i.state=$4' : ''}
       ORDER BY i.sold_at DESC,i.source,i.order_id LIMIT ${CONSUMPTION_LIST_LIMIT + 1}`,
      q.state ? [...args, q.state] : args,
    )
  ).rows;
  const counts = Object.fromEntries(CONSUMPTION_STATES.map((s) => [s, 0])) as Record<
    (typeof CONSUMPTION_STATES)[number],
    number
  >;
  for (const row of (
    await db.query<{ state: (typeof CONSUMPTION_STATES)[number]; n: number }>(
      `SELECT i.state,count(*)::int n FROM bo_consumption_items i WHERE ${scope} GROUP BY i.state`,
      args,
    )
  ).rows)
    counts[row.state] = row.n;
  const settings = await readStockSettings(db, branch);
  return {
    schema_version: 1 as const,
    branch_id: branch,
    timezone: 'Asia/Almaty' as const,
    date: q.date ?? null,
    state: q.state ?? null,
    as_of: now.toISOString(),
    settings,
    items: items.slice(0, CONSUMPTION_LIST_LIMIT),
    counts,
    coverage: await coverage(db, branch, now),
    limits: { items: CONSUMPTION_LIST_LIMIT },
    truncated: { items: items.length > CONSUMPTION_LIST_LIMIT },
  };
}

// ---------------------------------------------------------------------------- worker ----

export type ConsumptionTick = {
  ready: boolean;
  branches: number;
  enqueued: number;
  processed: number;
  states: Record<string, number>;
  errors: number;
};
/**
 * One tick of the worker (services/api/src/stock-consumption-worker.ts): for every branch whose
 * mode is dry_run or on, queue the new sales, then process the due items oldest sale first, each
 * in its own transaction under the branch lock with the settings re-read inside it. An item
 * that fails is counted and left for the next tick; the others go on.
 */
export async function runStockConsumption(
  pool: DatabasePool,
  options: BackofficeOptions,
  now: () => Date = () => new Date(),
  onError: (error: unknown) => void = () => undefined,
): Promise<ConsumptionTick> {
  const tick: ConsumptionTick = {
    ready: false,
    branches: 0,
    enqueued: 0,
    processed: 0,
    states: {},
    errors: 0,
  };
  const branches = await transaction(pool, async (db) => {
    if (!(await autoconsumeAvailable(db, options))) return null;
    return (
      await db.query<{ branch_id: string }>(
        "SELECT branch_id FROM bo_stock_settings WHERE autoconsume_mode<>'off' ORDER BY branch_id",
      )
    ).rows.map((r) => r.branch_id);
  });
  if (!branches) return tick;
  tick.ready = true;
  const cache = new Map<string, CatalogCache>();
  for (const branch of branches) {
    tick.branches++;
    const catalogs = cache.get(branch) ?? new Map();
    cache.set(branch, catalogs);
    let due: ItemKey[];
    try {
      due = await transaction(pool, async (db) => {
        const settings = await readStockSettings(db, branch);
        tick.enqueued += await enqueueConsumption(db, branch, settings, now());
        return dueConsumption(db, branch, settings, now());
      });
    } catch (error) {
      tick.errors++;
      onError(error);
      continue;
    }
    for (const key of due) {
      try {
        const done = await transaction(pool, async (db) => {
          await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            'bo:branch:' + branch,
          ]);
          const settings = await readStockSettings(db, branch);
          if (!settings.updated_by) return null;
          return processConsumptionItem(db, branch, key, settings, settings.updated_by, catalogs);
        });
        if (done) {
          tick.processed++;
          const state = String((done as { state: string }).state);
          tick.states[state] = (tick.states[state] ?? 0) + 1;
        }
      } catch (error) {
        tick.errors++;
        onError(error);
      }
    }
  }
  return tick;
}
