import type { DatabaseClient } from '@pickchick/database';

/**
 * Cloud channel orders (ADR-0014 S4, cloud 056). A kiosk/mobile order created while its branch
 * is in mode 'cloud' is registered in `cloud_channel_orders`: it never asks the cashier for
 * admission, carries no fiscal receipt for now ('deferred_no_receipt', owner decision
 * 2026-10-10) and is admitted into the cloud kitchen when payment is captured in full.
 *
 * Every read is guarded like the S3 availability gate: without the 054/056 tables (old schema)
 * or without a grant (narrow roles) the order is an edge order and behaves exactly as before.
 */
type Db = Pick<DatabaseClient, 'query'>;

/** Port implemented by `CloudKitchen` from @pickchick/cloud-kitchen. */
export interface CloudKitchenAdmissionPort {
  admitCloudChannelOrderInTransaction(
    client: DatabaseClient,
    orderId: string,
  ): Promise<{ outcome: string }>;
}
let admission: CloudKitchenAdmissionPort | null = null;
/**
 * Process-wide hook: the API registers the cloud kitchen at start-up when
 * CLOUD_KITCHEN_API_ENABLED is set. A process without it (for example a payment worker) still
 * commits the capture; the kitchen feed then admits the order on its next poll.
 */
export function useCloudKitchenAdmission(port: CloudKitchenAdmissionPort | null) {
  admission = port;
}
export function cloudKitchenAdmission() {
  return admission;
}

async function readable(db: Db, tables: readonly string[]) {
  // CASE keeps the privilege lookup from resolving a table that does not exist yet.
  return (
    (
      await db.query<{ readable: boolean }>(
        `SELECT bool_and(CASE WHEN to_regclass(t) IS NULL THEN false ELSE has_table_privilege(t,'SELECT') END) AS readable
        FROM unnest($1::text[]) t`,
        [tables],
      )
    ).rows[0]?.readable === true
  );
}

/** Epoch of the branch while it is in mode 'cloud', otherwise null (edge, old schema, no grant).
 * Takes the shared side of the mode-switch lock, so the answer holds for the transaction. */
export async function cloudChannelEpoch(db: Db, branchId: string): Promise<string | null> {
  if (!(await readable(db, ['branch_channel_modes', 'cloud_channel_orders']))) return null;
  await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    'channel_mode:' + branchId,
  ]);
  const row = (
    await db.query<{ epoch: string }>(
      "SELECT epoch::text FROM branch_channel_modes WHERE branch_id=$1 AND cloud_channels_owner='cloud'",
      [branchId],
    )
  ).rows[0];
  return row?.epoch ?? null;
}

export interface CloudChannelOrder {
  order_id: string;
  branch_id: string;
  channel: 'kiosk' | 'mobile';
  mode_epoch: string;
  fiscal_status: 'deferred_no_receipt' | 'reconciled';
}
export async function cloudChannelOrder(db: Db, orderId: string) {
  if (!(await readable(db, ['cloud_channel_orders']))) return null;
  return (
    (
      await db.query<CloudChannelOrder>(
        'SELECT order_id,branch_id,channel,mode_epoch::text,fiscal_status FROM cloud_channel_orders WHERE order_id=$1',
        [orderId],
      )
    ).rows[0] ?? null
  );
}
export async function registerCloudChannelOrder(
  db: Db,
  order: { orderId: string; branchId: string; channel: 'kiosk' | 'mobile'; epoch: string },
) {
  await db.query(
    'INSERT INTO cloud_channel_orders(order_id,branch_id,channel,mode_epoch) VALUES($1,$2,$3,$4)',
    [order.orderId, order.branchId, order.channel, order.epoch],
  );
}
/** Whether the channel still has a free display number (ADR-0014: none - payment stays closed). */
export async function cloudChannelNumberFree(db: Db, branchId: string, channel: string) {
  if (!(await readable(db, ['channel_number_ranges', 'channel_number_holds']))) return false;
  return (
    (
      await db.query<{ free: boolean }>(
        `SELECT (r.high-r.low+1) > (SELECT count(*) FROM channel_number_holds h
          WHERE h.branch_id=$1 AND h.channel=r.channel AND h.released_at IS NULL) AS free
         FROM channel_number_ranges r WHERE r.channel=$2`,
        [branchId, channel],
      )
    ).rows[0]?.free === true
  );
}

/**
 * Kitchen projection of a cloud channel order in the shape order-view.ts reads from
 * `cloud_fulfillment_projection` for edge orders: state, display number, last change and
 * whether the assembly station has started. Null when the order is not in the cloud kitchen.
 */
export async function cloudKitchenProjection(db: Db, orderId: string) {
  if (!(await readable(db, ['cloud_kitchen_orders', 'cloud_kitchen_tasks']))) return null;
  return (
    (
      await db.query<{
        state: string;
        display_number: string | null;
        observed_at: Date;
        assembly: boolean;
      }>(
        `SELECT o.state,o.display_number::text,o.updated_at AS observed_at,
          EXISTS(SELECT 1 FROM cloud_kitchen_tasks t WHERE t.order_id=o.order_id
           AND t.station_id=o.assembly_station_id AND t.state IN ('in_progress','done')) AS assembly
         FROM cloud_kitchen_orders o WHERE o.order_id=$1`,
        [orderId],
      )
    ).rows[0] ?? null
  );
}
