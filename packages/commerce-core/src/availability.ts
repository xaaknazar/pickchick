import { z } from 'zod';
import type { DatabasePool } from '@pickchick/database';
import { localSelectionIds } from '@pickchick/menu-sync';

export class AvailabilityError extends Error {
  constructor(readonly code: 'ITEM_STOPPED' | 'AVAILABILITY_STALE') {
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
export async function branchAvailability(pool: Pick<DatabasePool, 'query'>, branchId: string) {
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
  if (!state.fresh) throw new AvailabilityError('AVAILABILITY_STALE');
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
