import type { DatabaseClient } from '@pickchick/database';
import { menuKdsSlugs, parseKdsLayout } from './kds.js';
import type { KdsLayoutData, KdsSlugs } from './kds.js';

type Queryable = Pick<DatabaseClient, 'query'>;
export type KdsShiftMode = 'morning' | 'normal' | 'peak';
export type KdsLayoutState =
  | { enabled: false }
  | { enabled: true; version: number; mode: KdsShiftMode; layout: KdsLayoutData };

/**
 * The switch of the point (contracts section 6.1): enabled only while edge 027 is installed and
 * readable by this database role, kds_settings.layout_enabled is true and the active layout is
 * usable. Anything else is today's kitchen flow. Read-only; never locks a row, so the roles
 * without UPDATE on kds_settings (runtime, fulfillment worker) can call it in any transaction.
 */
export async function readKdsLayout(client: Queryable, branchId: string): Promise<KdsLayoutState> {
  const ready = (
    await client.query<{ ready: boolean }>(
      `SELECT CASE WHEN to_regclass('kds_settings') IS NULL OR to_regclass('kds_layouts') IS NULL
         THEN false ELSE has_table_privilege(to_regclass('kds_settings'),'SELECT')
           AND has_table_privilege(to_regclass('kds_layouts'),'SELECT') END AS ready`,
    )
  ).rows[0]!.ready;
  if (!ready) return { enabled: false };
  const row = (
    await client.query<{
      layout_enabled: boolean;
      shift_mode: KdsShiftMode;
      version: number | null;
      layout: unknown;
    }>(
      `SELECT s.layout_enabled,s.shift_mode,l.version,l.layout FROM kds_settings s
       LEFT JOIN kds_layouts l ON l.branch_id=s.branch_id AND l.version=s.active_layout_version
       WHERE s.branch_id=$1`,
      [branchId],
    )
  ).rows[0];
  if (!row?.layout_enabled || row.version === null) return { enabled: false };
  const layout = parseKdsLayout(row.layout, branchId, row.version);
  return layout
    ? { enabled: true, version: row.version, mode: row.shift_mode, layout }
    : { enabled: false };
}

// Menu snapshots are immutable (trigger menu_snapshots_immutable): slugs of a release never change.
const slugCache = new Map<string, KdsSlugs>();
/**
 * Slugs of the active cashier menu, or null when it is not readable. Cached per release; the
 * cache keeps the last few releases only.
 */
export async function readMenuKdsSlugs(
  client: Queryable,
  branchId: string,
): Promise<KdsSlugs | null> {
  // Separate statements: PostgreSQL checks the rights on every table a statement names.
  const ready = (
    await client.query<{ ready: boolean }>(
      `SELECT CASE WHEN to_regclass('active_menu') IS NULL OR to_regclass('menu_snapshots') IS NULL
         THEN false ELSE has_table_privilege(to_regclass('active_menu'),'SELECT')
           AND has_table_privilege(to_regclass('menu_snapshots'),'SELECT') END AS ready`,
    )
  ).rows[0]!.ready;
  if (!ready) return null;
  const active = (
    await client.query<{ release_id: string }>(
      'SELECT release_id FROM active_menu WHERE branch_id=$1',
      [branchId],
    )
  ).rows[0]?.release_id;
  if (!active) return null;
  const key = branchId + ':' + active;
  const cached = slugCache.get(key);
  if (cached) return cached;
  const row = (
    await client.query<{ payload: unknown }>(
      'SELECT payload FROM menu_snapshots WHERE id=$1 AND branch_id=$2',
      [active, branchId],
    )
  ).rows[0];
  if (!row) return null;
  const slugs = menuKdsSlugs(row.payload);
  slugCache.set(key, slugs);
  while (slugCache.size > 8) slugCache.delete(slugCache.keys().next().value!);
  return slugs;
}
