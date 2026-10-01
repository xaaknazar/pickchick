import { z } from 'zod';
import type { DatabasePool } from '@pickchick/database';
import { localSelectionIds } from '@pickchick/menu-sync';

export class AvailabilityError extends Error {
  constructor(readonly code: 'ITEM_STOPPED' | 'AVAILABILITY_STALE') {
    super(code);
  }
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
  return { fresh: row?.fresh ?? false, stoppedIds: row?.stopped_ids ?? [] };
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
