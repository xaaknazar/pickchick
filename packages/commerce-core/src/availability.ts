import { z } from 'zod';
import type { DatabasePool } from '@pickchick/database';
import { localSelectionIds } from '@pickchick/menu-sync';

export class AvailabilityError extends Error {
  constructor(readonly code: 'ITEM_STOPPED' | 'AVAILABILITY_STALE' | 'KITCHEN_OFFLINE') {
    super(code);
  }
}
/** Back-office STOP commands the edge has not answered yet block sales at once (fail closed).
 * A pending UNSTOP never does anything here: it counts only after the edge applies it. Roles
 * without the stop-command table (old schema, narrow workers) keep the edge projection only. */
async function pendingRemoteStops(pool: Pick<DatabasePool, 'query'>, branchId: string) {
  // CASE keeps the privilege lookup from resolving a table that does not exist yet.
  const readable = (
    await pool.query<{ readable: boolean }>(
      "SELECT CASE WHEN to_regclass('cloud_stop_commands') IS NULL THEN false ELSE has_table_privilege('cloud_stop_commands','SELECT') END AS readable",
    )
  ).rows[0]?.readable;
  if (!readable) return [];
  return (
    await pool.query<{ variant_id: string }>(
      `SELECT DISTINCT variant_id FROM cloud_stop_commands WHERE branch_id=$1 AND stopped
      AND state IN ('pending','delivered') AND expires_at>clock_timestamp()`,
      [branchId],
    )
  ).rows.map((r) => r.variant_id);
}
/** An offline restaurant must not acquire a new mobile payment. Keep last known stops visible. */
async function edgeBranchAvailability(pool: Pick<DatabasePool, 'query'>, branchId: string) {
  const row = (
    await pool.query<{ stopped_ids: string[]; fresh: boolean }>(
      `SELECT a.stopped_ids,
    (a.observed_at > clock_timestamp()-interval '30 seconds') fresh
    FROM cloud_branch_availability a JOIN fulfillment_transport_bindings b ON b.branch_id=a.branch_id AND b.device_id=a.device_id AND b.active
    JOIN devices d ON d.id=b.device_id AND d.status='active' WHERE a.branch_id=$1`,
      [branchId],
    )
  ).rows[0];
  const projected = row?.stopped_ids ?? [],
    pending = await pendingRemoteStops(pool, branchId);
  return {
    fresh: row?.fresh ?? false,
    stoppedIds: pending.length ? [...new Set([...projected, ...pending])].sort() : projected,
  };
}
async function readableTables(pool: Pick<DatabasePool, 'query'>, tables: readonly string[]) {
  // CASE keeps the privilege lookup from resolving a table that does not exist yet.
  return (
    await pool.query<{ readable: boolean }>(
      `SELECT bool_and(CASE WHEN to_regclass(t) IS NULL THEN false ELSE has_table_privilege(t,'SELECT') END) AS readable
      FROM unnest($1::text[]) t`,
      [tables],
    )
  ).rows[0]!.readable;
}
/** cloud054 branch mode. No row, no table (old schema) or no grant (narrow roles) is 'edge'. */
export async function branchChannelOwner(
  pool: Pick<DatabasePool, 'query'>,
  branchId: string,
): Promise<'edge' | 'cloud'> {
  if (!(await readableTables(pool, ['branch_channel_modes']))) return 'edge';
  const row = (
    await pool.query<{ owner: 'edge' | 'cloud' }>(
      'SELECT cloud_channels_owner AS owner FROM branch_channel_modes WHERE branch_id=$1',
      [branchId],
    )
  ).rows[0];
  return row?.owner ?? 'edge';
}
/** Seconds a cloud kitchen station poll keeps the KITCHEN_OFFLINE gate open (ADR-0014). */
export const KITCHEN_PRESENCE_SECONDS = 30;
const CLOUD_TABLES = [
  'cloud_channel_stops',
  'cloud_stale_stop_overrides',
  'cloud_kitchen_stations',
  'cloud_kitchen_station_presence',
  'cloud_branch_availability',
  'fulfillment_transport_bindings',
  'devices',
] as const;
/**
 * Branch in mode 'cloud' (ADR-0014 S3): a kiosk/mobile sale needs the item to be absent from
 * the back-office cloud stops AND from the last known cashier stops (fail closed, the cashier
 * may be offline for hours), unless a manager override answers that very cashier observation.
 * Pending back-office STOP commands still block at once. The gate is the cloud kitchen, not the
 * cashier: at least one assembly and one prep station polled the cloud feed within 30 s.
 * Without read access to any of the cloud tables the gate stays closed.
 */
export async function cloudChannelAvailability(
  pool: Pick<DatabasePool, 'query'>,
  branchId: string,
) {
  if (!(await readableTables(pool, CLOUD_TABLES))) {
    const edge = await edgeBranchAvailability(pool, branchId);
    return { fresh: false, stoppedIds: edge.stoppedIds, mode: 'cloud' as const };
  }
  const row = (
    await pool.query<{ stopped_ids: string[]; kitchen_online: boolean }>(
      `WITH edge AS (
        SELECT a.device_id,a.observed_at,a.stopped_ids FROM cloud_branch_availability a
        JOIN fulfillment_transport_bindings b ON b.branch_id=a.branch_id AND b.device_id=a.device_id AND b.active
        JOIN devices d ON d.id=b.device_id AND d.status='active' WHERE a.branch_id=$1),
      cashier AS (
        SELECT s.id FROM edge e CROSS JOIN LATERAL unnest(e.stopped_ids) s(id)
        WHERE NOT EXISTS (SELECT 1 FROM cloud_stale_stop_overrides o WHERE o.branch_id=$1
          AND o.variant_id=s.id AND o.edge_device_id=e.device_id AND o.edge_observed_at>=e.observed_at)),
      cloud AS (
        SELECT variant_id AS id FROM cloud_channel_stops WHERE branch_id=$1 AND stopped
        AND (expires_at IS NULL OR expires_at>clock_timestamp()))
      SELECT coalesce((SELECT array_agg(DISTINCT id ORDER BY id) FROM (SELECT id FROM cashier UNION SELECT id FROM cloud) ids),'{}'::uuid[]) AS stopped_ids,
      (SELECT count(DISTINCT s.kind)=2 FROM cloud_kitchen_station_presence p
        JOIN cloud_kitchen_stations s ON s.branch_id=p.branch_id AND s.id=p.station_id
        WHERE p.branch_id=$1 AND p.seen_at>clock_timestamp()-$2*interval '1 second') AS kitchen_online`,
      [branchId, KITCHEN_PRESENCE_SECONDS],
    )
  ).rows[0]!;
  const pending = await pendingRemoteStops(pool, branchId);
  return {
    fresh: row.kitchen_online,
    stoppedIds: [...new Set([...row.stopped_ids, ...pending])].sort(),
    mode: 'cloud' as const,
  };
}
/**
 * Sales gate and stop list of the kiosk/mobile channels. Mode 'edge' (default): cashier
 * projection plus pending back-office stops, fresh = cashier heartbeat within 30 s. Mode 'cloud':
 * see cloudChannelAvailability; fresh = cloud kitchen online. Only mode 'cloud' adds `mode`.
 */
export async function branchAvailability(pool: Pick<DatabasePool, 'query'>, branchId: string) {
  return (await branchChannelOwner(pool, branchId)) === 'cloud'
    ? cloudChannelAvailability(pool, branchId)
    : edgeBranchAvailability(pool, branchId);
}
export async function assertBranchItemsAvailable(
  pool: Pick<DatabasePool, 'query'>,
  branchId: string,
  items: { productId: string; selections: { group_id: string; option_id: string }[] }[],
) {
  const state = await branchAvailability(pool, branchId);
  const stopped = new Set(state.stoppedIds);
  if (
    items.some(
      (item) =>
        stopped.has(item.productId) ||
        localSelectionIds(branchId, item.productId, item.selections).some((id) => stopped.has(id)),
    )
  )
    throw new AvailabilityError('ITEM_STOPPED');
  if (!state.fresh)
    throw new AvailabilityError(
      'mode' in state && state.mode === 'cloud' ? 'KITCHEN_OFFLINE' : 'AVAILABILITY_STALE',
    );
}

export function snapshotAvailabilityItems(input: unknown) {
  const snapshot = z
    .object({
      lines: z.array(
        z.object({
          productId: z.string(),
          selectedDetails: z
            .object({ modifiers: z.array(z.object({ groupId: z.string(), optionId: z.string() })) })
            .optional(),
        }),
      ),
    })
    .parse(input);
  return snapshot.lines.map((line) => ({
    productId: line.productId,
    selections: (line.selectedDetails?.modifiers ?? []).map((m) => ({
      group_id: m.groupId,
      option_id: m.optionId,
    })),
  }));
}
