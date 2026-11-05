import type { DatabaseClient } from '@pickchick/database';
import type { Reservation } from './records.js';

export async function restoreReview(client: DatabaseClient, row: Reservation) {
  if (
    !(await client.query("SELECT to_regclass('fulfillment_restore_reviews') IS NOT NULL AS ok"))
      .rows[0].ok
  )
    return undefined;
  const review = (
    await client.query(
      `SELECT r.epoch,d.decision FROM fulfillment_restore_reviews r
     LEFT JOIN fulfillment_restore_decisions d USING(epoch,order_id)
     WHERE r.order_id=$1 AND r.branch_id=$2 ORDER BY r.epoch DESC LIMIT 1`,
      [row.order_id, row.branch_id],
    )
  ).rows[0];
  return review
    ? {
        epoch: Number(review.epoch),
        status: (review.decision ?? 'pending') as 'pending' | 'resume' | 'retire',
      }
    : undefined;
}
