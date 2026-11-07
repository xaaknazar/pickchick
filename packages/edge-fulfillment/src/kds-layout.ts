import type { DatabaseClient } from '@pickchick/database';
import { KDS_STATIONS, kdsStationId, menuKdsSlugs, parseKdsLayout } from './kds.js';
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

/**
 * GET fulfillment/stations with the layout off (contracts section 10, risk 3): which of the
 * listed stations are KDS stations to leave out. provisionKdsStations creates the six stations
 * and grants them to the kitchen login before the layout is ever enabled; the installed kitchen
 * screens open the first prep (or assembly) station of the list, so listing them would open an
 * empty KDS queue while the old stations still get every order. A KDS station that still has
 * live work - an order admitted while the layout was on, with a task there or finishing there,
 * and shown on its kitchen page - stays listed until that order leaves the kitchen, so
 * kds-switch disable never strands a started order. Empty while the layout is on, and no query
 * at all when none of the listed stations is a KDS station.
 */
export async function hiddenKdsStations(
  client: Queryable,
  branchId: string,
  listed: readonly string[],
): Promise<Set<string>> {
  const kds = new Set(KDS_STATIONS.map((spec) => kdsStationId(branchId, spec.function)));
  const candidates = listed.filter((id) => kds.has(id));
  if (!candidates.length || (await readKdsLayout(client, branchId)).enabled) return new Set();
  const hasReviews = (
    await client.query<{ ok: boolean }>(
      "SELECT to_regclass('fulfillment_restore_reviews') IS NOT NULL AS ok",
    )
  ).rows[0]!.ok;
  // The same visibility as GET fulfillment/kitchen?stationId= (repository listKitchen).
  const reviewFilter = hasReviews
    ? ` AND NOT EXISTS (
        SELECT 1 FROM fulfillment_restore_reviews rr JOIN fulfillment_restore_decisions d USING(epoch,order_id)
        WHERE rr.order_id=live.order_id AND d.decision='retire' AND rr.epoch=(
          SELECT max(latest.epoch) FROM fulfillment_restore_reviews latest WHERE latest.order_id=live.order_id))`
    : '';
  // Starts from the live orders (partial index fulfillment_active_idx), never from task history.
  const live = (
    await client.query<{ id: string }>(
      `SELECT DISTINCT live.station_id::text AS id FROM (
         SELECT r.order_id,r.assembly_station_id AS station_id FROM fulfillment_reservations r
          WHERE r.branch_id=$1 AND r.state IN ('accepted','in_production','ready','cancel_requested')
         UNION ALL
         SELECT r.order_id,t.station_id FROM fulfillment_reservations r
          JOIN fulfillment_tasks t ON t.order_id=r.order_id AND t.branch_id=r.branch_id
          WHERE r.branch_id=$1 AND r.state IN ('accepted','in_production','ready','cancel_requested')
       ) live WHERE live.station_id=ANY($2::uuid[])${reviewFilter}`,
      [branchId, candidates],
    )
  ).rows;
  const working = new Set(live.map((row) => row.id));
  return new Set(candidates.filter((id) => !working.has(id)));
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
