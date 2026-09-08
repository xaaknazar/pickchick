import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DeviceIdentitySchema } from '@pickchick/contracts';
import type { DatabasePool } from '@pickchick/database';
import { transaction } from '@pickchick/database';
import { hashJson } from '@pickchick/menu-sync';
import { parseEvent, PosSyncError, PosOrderReceiptSchema, receiptFor } from './model.js';
import type { PosSyncScope, PosOrderEvent } from './model.js';
import { PosHttpError, posCloudOrigin, sendPosEvent } from './http.js';
import type { PosSyncIo } from './http.js';

const EdgeSetup = z.strictObject({
  organizationId: z.uuid(),
  branchId: z.uuid(),
  deviceId: z.uuid(),
});
/** Trusted local setup, preserving the producer of already existing POS events. */
export async function provisionEdgePosSync(
  pool: DatabasePool,
  input: unknown,
  active = true,
): Promise<PosSyncScope> {
  const scope = EdgeSetup.parse(input);
  if (typeof active !== 'boolean') throw new PosSyncError('INVALID_REQUEST');
  return transaction(pool, async (client) => {
    if (
      !(await client.query('SELECT 1 FROM branch_config WHERE id=$1 FOR UPDATE', [scope.branchId]))
        .rowCount
    )
      throw new PosSyncError('FORBIDDEN');
    await client.query(
      'INSERT INTO local_order_streams(branch_id,producer_id) VALUES($1,$2) ON CONFLICT(branch_id) DO NOTHING',
      [scope.branchId, randomUUID()],
    );
    const producerId = (
      await client.query(
        'SELECT producer_id FROM local_order_streams WHERE branch_id=$1 FOR SHARE',
        [scope.branchId],
      )
    ).rows[0].producer_id as string;
    await client.query(
      `INSERT INTO pos_order_sync_state(branch_id,organization_id,device_id,producer_id,active)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(branch_id) DO NOTHING`,
      [scope.branchId, scope.organizationId, scope.deviceId, producerId, active],
    );
    const old = (
      await client.query('SELECT * FROM pos_order_sync_state WHERE branch_id=$1 FOR UPDATE', [
        scope.branchId,
      ])
    ).rows[0];
    if (
      old.organization_id !== scope.organizationId ||
      old.device_id !== scope.deviceId ||
      old.producer_id !== producerId
    )
      throw new PosSyncError('CONFLICT');
    await client.query('UPDATE pos_order_sync_state SET active=$2 WHERE branch_id=$1', [
      scope.branchId,
      active,
    ]);
    return { ...scope, producerId };
  });
}
function envelope(row: Record<string, unknown>) {
  return parseEvent({
    event_id: row.event_id,
    producer_id: row.producer_id,
    producer_sequence: row.producer_sequence,
    aggregate_type: row.aggregate_type,
    aggregate_id: row.aggregate_id,
    aggregate_version: Number(row.aggregate_version),
    event_type: row.event_type,
    schema_version: row.schema_version,
    branch_id: row.branch_id,
    occurred_at: (row.occurred_at as Date).toISOString(),
    correlation_id: row.correlation_id,
    causation_id: row.causation_id,
    payload: row.payload,
  });
}
export const posRetryDelayMs = (failures: number) =>
  Math.min(60000, 1000 * 2 ** Math.min(6, Math.max(1, failures)));
export async function syncPosOrdersOnce(
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
    const row = (
      await client.query(
        `SELECT *,lease_until>clock_timestamp() AS busy,retry_after>clock_timestamp() AS waiting
      FROM pos_order_sync_state WHERE branch_id=$1 FOR UPDATE`,
        [input.branchId],
      )
    ).rows[0];
    if (!row) throw new PosSyncError('NOT_FOUND');
    if (row.device_id !== identity.device_id) throw new PosSyncError('FORBIDDEN');
    if (!row.active) return { state: 'disabled' as const };
    if (row.busy) return { state: 'busy' as const };
    if (row.waiting) return { state: 'retry' as const };
    // One lease owns the whole branch stream. Never SKIP LOCKED past an unacknowledged creation.
    const source = (
      await client.query(
        `SELECT * FROM outbox_events WHERE branch_id=$1 AND producer_id=$2
      AND aggregate_type='order_commercial' AND event_type IN('order.created','order.cancelled')
      AND acknowledged_at IS NULL ORDER BY producer_sequence LIMIT 1 FOR UPDATE`,
        [input.branchId, row.producer_id],
      )
    ).rows[0];
    if (!source) {
      if (row.pending_event_id) throw new PosSyncError('CONFLICT');
      return { state: 'idle' as const };
    }
    const event = envelope(source),
      hash = hashJson(event);
    if (
      row.pending_event_id &&
      (row.pending_event_id !== event.event_id ||
        row.pending_hash !== hash ||
        hashJson(row.pending_envelope) !== hash)
    )
      throw new PosSyncError('CONFLICT');
    await client.query(
      `UPDATE pos_order_sync_state SET lease_token=$2,lease_until=clock_timestamp()+interval '30 seconds',
      pending_event_id=$3,pending_envelope=$4,pending_hash=$5 WHERE branch_id=$1`,
      [input.branchId, token, event.event_id, event, hash],
    );
    await client.query('UPDATE outbox_events SET attempts=attempts+1 WHERE event_id=$1', [
      event.event_id,
    ]);
    return { state: 'claimed' as const, event };
  });
  if (claimed.state !== 'claimed') return claimed;
  const event: PosOrderEvent = claimed.event;
  let failure: 'NETWORK_UNKNOWN' | 'HTTP_REJECTED' | 'INVALID_RESPONSE' | undefined;
  try {
    const parsed = PosOrderReceiptSchema.safeParse(await sendPosEvent(origin, identity, event, io));
    if (!parsed.success || hashJson(parsed.data) !== hashJson(receiptFor(event)))
      throw new PosHttpError('INVALID_RESPONSE');
  } catch (error) {
    failure = error instanceof PosHttpError ? error.code : 'NETWORK_UNKNOWN';
  }
  return transaction(pool, async (client) => {
    const row = (
      await client.query('SELECT * FROM pos_order_sync_state WHERE branch_id=$1 FOR UPDATE', [
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
        `UPDATE pos_order_sync_state SET lease_token=NULL,lease_until=NULL,failure_count=$2,
        retry_after=clock_timestamp()+($3::text||' milliseconds')::interval,last_error=$4 WHERE branch_id=$1`,
        [input.branchId, failures, delay, failure],
      );
      return { state: 'retry' as const, error: failure, eventId: event.event_id };
    }
    const source = (
      await client.query('SELECT * FROM outbox_events WHERE event_id=$1 FOR UPDATE', [
        event.event_id,
      ])
    ).rows[0];
    if (!source || hashJson(envelope(source)) !== row.pending_hash || source.acknowledged_at)
      throw new PosSyncError('CONFLICT');
    await client.query(
      'UPDATE outbox_events SET acknowledged_at=clock_timestamp() WHERE event_id=$1',
      [event.event_id],
    );
    await client.query(
      `UPDATE pos_order_sync_state SET lease_token=NULL,lease_until=NULL,pending_event_id=NULL,
      pending_envelope=NULL,pending_hash=NULL,failure_count=0,retry_after=NULL,last_error=NULL WHERE branch_id=$1`,
      [input.branchId],
    );
    return { state: 'delivered' as const, eventId: event.event_id };
  });
}
