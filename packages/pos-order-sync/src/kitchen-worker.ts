import { randomUUID } from 'node:crypto';
import { DeviceIdentitySchema, UuidSchema } from '@pickchick/contracts';
import type { DatabasePool } from '@pickchick/database';
import { transaction } from '@pickchick/database';
import { hashJson } from '@pickchick/menu-sync';
import { PosSyncError, PosOrderReceiptSchema } from './model.js';
import { parseKitchenEvent, kitchenReceiptFor } from './kitchen-model.js';
import type { PosKitchenEvent } from './kitchen-model.js';
import { posRetryDelayMs } from './worker.js';
import { PosHttpError, posCloudOrigin, sendPosEvent } from './http.js';
import type { PosSyncIo } from './http.js';

function envelope(row: Record<string, unknown>, producerId: string) {
  return parseKitchenEvent({
    event_id: row.event_id,
    producer_id: producerId,
    producer_sequence: row.sequence,
    aggregate_type: row.aggregate_type,
    aggregate_id: row.order_id,
    aggregate_version: Number(row.aggregate_version),
    event_type: row.event_type,
    schema_version: 1,
    branch_id: row.branch_id,
    occurred_at: (row.occurred_at as Date).toISOString(),
    correlation_id: row.order_id,
    causation_id: null,
    payload: row.payload,
  });
}
export async function syncPosKitchenOnce(
  pool: DatabasePool,
  input: { enabled: boolean; branchId: string; origin: string; identity: unknown },
  io: PosSyncIo = {},
) {
  if (!input.enabled) return { state: 'disabled' as const };
  const identity = DeviceIdentitySchema.parse(input.identity),
    origin = posCloudOrigin(input.origin),
    token = randomUUID();
  if (identity.branch_id !== input.branchId) throw new PosSyncError('FORBIDDEN');
  const claimed = await transaction(pool, async (client) => {
    const binding = (
      await client.query('SELECT * FROM pos_order_sync_state WHERE branch_id=$1 FOR SHARE', [
        input.branchId,
      ])
    ).rows[0];
    if (!binding) throw new PosSyncError('NOT_FOUND');
    const delivery = (
      await client.query(
        `SELECT *,lease_until>clock_timestamp() AS busy,retry_after>clock_timestamp() AS waiting
       FROM pos_kitchen_sync_state WHERE branch_id=$1 FOR UPDATE`,
        [input.branchId],
      )
    ).rows[0];
    const row = delivery ? { ...binding, ...delivery } : undefined;
    if (!row) throw new PosSyncError('NOT_FOUND');
    if (row.device_id !== identity.device_id) throw new PosSyncError('FORBIDDEN');
    if (!row.active) return { state: 'disabled' as const };
    if (row.dead_lettered_at)
      return { state: 'dead_letter' as const, eventId: row.pending_event_id as string };
    if (row.busy) return { state: 'busy' as const };
    if (row.waiting) return { state: 'retry' as const };
    // One lease owns the whole branch stream. Never SKIP LOCKED past an unacknowledged creation.
    const source = (
      await client.query(
        `SELECT * FROM fulfillment_outbox WHERE branch_id=$1 AND payload->>'commercialOwner'='edge_pos'
      AND acknowledged_at IS NULL ORDER BY sequence LIMIT 1 FOR UPDATE`,
        [input.branchId],
      )
    ).rows[0];
    if (!source) {
      if (row.pending_event_id) throw new PosSyncError('CONFLICT');
      return { state: 'idle' as const };
    }
    const event = envelope(source, row.producer_id),
      hash = hashJson(event);
    if (event.payload.deviceId !== identity.device_id) throw new PosSyncError('FORBIDDEN');
    if (
      row.pending_event_id &&
      (row.pending_event_id !== event.event_id ||
        row.pending_hash !== hash ||
        hashJson(row.pending_envelope) !== hash)
    )
      throw new PosSyncError('CONFLICT');
    await client.query(
      `UPDATE pos_kitchen_sync_state SET lease_token=$2,lease_until=clock_timestamp()+interval '30 seconds',
      pending_event_id=$3,pending_envelope=$4,pending_hash=$5 WHERE branch_id=$1`,
      [input.branchId, token, event.event_id, event, hash],
    );
    await client.query('UPDATE fulfillment_outbox SET attempts=attempts+1 WHERE event_id=$1', [
      event.event_id,
    ]);
    return { state: 'claimed' as const, event };
  });
  if (claimed.state !== 'claimed') return claimed;
  const event: PosKitchenEvent = claimed.event;
  let deadLetter = false;
  let failure: 'NETWORK_UNKNOWN' | 'HTTP_REJECTED' | 'INVALID_RESPONSE' | undefined;
  try {
    const parsed = PosOrderReceiptSchema.safeParse(await sendPosEvent(origin, identity, event, io));
    if (!parsed.success || hashJson(parsed.data) !== hashJson(kitchenReceiptFor(event)))
      throw new PosHttpError('INVALID_RESPONSE');
  } catch (error) {
    failure = error instanceof PosHttpError ? error.code : 'NETWORK_UNKNOWN';
    deadLetter =
      error instanceof PosHttpError && error.code === 'HTTP_REJECTED' && error.status === 400;
  }
  return transaction(pool, async (client) => {
    const row = (
      await client.query('SELECT * FROM pos_kitchen_sync_state WHERE branch_id=$1 FOR UPDATE', [
        input.branchId,
      ])
    ).rows[0];
    if (
      !row ||
      row.lease_token !== token ||
      row.pending_event_id !== event.event_id ||
      row.pending_hash !== hashJson(event)
    )
      throw new PosSyncError('CONFLICT');
    if (failure) {
      const failures = Math.min(row.failure_count + 1, 1000000),
        delay = posRetryDelayMs(failures);
      await client.query(
        `UPDATE pos_kitchen_sync_state SET lease_token=NULL,lease_until=NULL,failure_count=$2,
        retry_after=clock_timestamp()+($3::text||' milliseconds')::interval,last_error=$4,
        dead_lettered_at=CASE WHEN $5 THEN clock_timestamp() ELSE NULL END WHERE branch_id=$1`,
        [input.branchId, failures, delay, failure, deadLetter],
      );
      return {
        state: deadLetter ? ('dead_letter' as const) : ('retry' as const),
        error: failure,
        eventId: event.event_id,
      };
    }
    const source = (
      await client.query('SELECT * FROM fulfillment_outbox WHERE event_id=$1 FOR UPDATE', [
        event.event_id,
      ])
    ).rows[0];
    if (
      !source ||
      hashJson(envelope(source, event.producer_id)) !== row.pending_hash ||
      source.acknowledged_at
    )
      throw new PosSyncError('CONFLICT');
    await client.query(
      'UPDATE fulfillment_outbox SET acknowledged_at=clock_timestamp() WHERE event_id=$1',
      [event.event_id],
    );
    await client.query(
      `UPDATE pos_kitchen_sync_state SET lease_token=NULL,lease_until=NULL,pending_event_id=NULL,
      pending_envelope=NULL,pending_hash=NULL,failure_count=0,retry_after=NULL,last_error=NULL,dead_lettered_at=NULL WHERE branch_id=$1`,
      [input.branchId],
    );
    return { state: 'delivered' as const, eventId: event.event_id };
  });
}

/** Owner-only retry after the receiving schema/configuration is repaired. Pending bytes stay intact. */
export async function retryPosKitchenDelivery(
  pool: DatabasePool,
  branchId: string,
  eventId: string,
) {
  if (!UuidSchema.safeParse(branchId).success || !UuidSchema.safeParse(eventId).success)
    throw new PosSyncError('INVALID_REQUEST');
  return transaction(pool, async (client) => {
    const owner = await client.query(
      "SELECT pg_get_userbyid(relowner)=current_user AS allowed FROM pg_class WHERE oid='pos_kitchen_sync_state'::regclass",
    );
    if (owner.rows[0]?.allowed !== true) throw new PosSyncError('FORBIDDEN');
    const row = await client.query(
      `UPDATE pos_kitchen_sync_state SET dead_lettered_at=NULL,retry_after=NULL,last_error=NULL
      WHERE branch_id=$1 AND pending_event_id=$2 AND dead_lettered_at IS NOT NULL AND lease_token IS NULL RETURNING pending_event_id`,
      [branchId, eventId],
    );
    if (row.rowCount !== 1) throw new PosSyncError('CONFLICT');
    return { state: 'retry' as const, eventId };
  });
}
