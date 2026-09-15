import type { DatabasePool } from '@pickchick/database';
import { transaction } from '@pickchick/database';
import { authenticateDevice, hashJson } from '@pickchick/menu-sync';
import type { DeviceAuth } from '@pickchick/menu-sync';
import { parseEvent, PosSyncError, PosSyncScopeSchema, receiptFor } from './model.js';

/** Trusted operator only. No automatic enrollment or replacement of an edge. */
export async function provisionCloudPosSync(pool: DatabasePool, input: unknown, active = true) {
  const scope = PosSyncScopeSchema.parse(input);
  if (typeof active !== 'boolean') throw new PosSyncError('INVALID_REQUEST');
  return transaction(pool, async (client) => {
    const d = await client.query(
      "SELECT 1 FROM devices WHERE id=$1 AND branch_id=$2 AND organization_id=$3 AND kind='edge' AND status='active' FOR SHARE",
      [scope.deviceId, scope.branchId, scope.organizationId],
    );
    if (!d.rowCount) throw new PosSyncError('FORBIDDEN');
    await client.query(
      `INSERT INTO pos_order_sync_bindings(branch_id,organization_id,device_id,producer_id,active)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(branch_id) DO NOTHING`,
      [scope.branchId, scope.organizationId, scope.deviceId, scope.producerId, active],
    );
    const row = (
      await client.query('SELECT * FROM pos_order_sync_bindings WHERE branch_id=$1 FOR UPDATE', [
        scope.branchId,
      ])
    ).rows[0];
    if (
      row.organization_id !== scope.organizationId ||
      row.device_id !== scope.deviceId ||
      row.producer_id !== scope.producerId
    )
      throw new PosSyncError('CONFLICT');
    await client.query('UPDATE pos_order_sync_bindings SET active=$2 WHERE branch_id=$1', [
      scope.branchId,
      active,
    ]);
    return scope;
  });
}

/** The edge remains the commercial owner; this transaction writes only sync tables. */
export async function receivePosOrder(pool: DatabasePool, auth: DeviceAuth, input: unknown) {
  const event = parseEvent(input),
    p = event.payload,
    hash = hashJson(event);
  try {
    return await transaction(pool, async (client) => {
      // Always authenticate before recognizing duplicates, including after revocation.
      const branch = await authenticateDevice(client, auth);
      const binding = (
        await client.query(
          `SELECT b.* FROM pos_order_sync_bindings b JOIN devices d ON d.id=b.device_id
         WHERE b.branch_id=$1 AND b.device_id=$2 AND d.organization_id=b.organization_id FOR UPDATE OF b`,
          [branch, auth.deviceId],
        )
      ).rows[0];
      if (
        !binding ||
        !binding.active ||
        event.branch_id !== branch ||
        event.producer_id !== binding.producer_id
      )
        throw new PosSyncError('FORBIDDEN');
      const previous = await client.query(
        `SELECT * FROM pos_order_sync_inbox WHERE event_id=$1 OR (producer_id=$2 AND producer_sequence=$3)
          OR (order_id=$4 AND aggregate_version=$5)`,
        [
          event.event_id,
          event.producer_id,
          event.producer_sequence,
          event.aggregate_id,
          event.aggregate_version,
        ],
      );
      if (previous.rowCount) {
        if (
          previous.rows.length !== 1 ||
          previous.rows[0].event_id !== event.event_id ||
          previous.rows[0].payload_hash !== hash ||
          previous.rows[0].branch_id !== branch ||
          previous.rows[0].device_id !== auth.deviceId
        )
          throw new PosSyncError('CONFLICT');
        return receiptFor(event);
      }
      const existing = (
        await client.query(
          `SELECT p.*, i.producer_sequence AS last_sequence FROM pos_order_sync_projection p
           JOIN pos_order_sync_inbox i ON i.event_id=p.last_event_id WHERE p.order_id=$1 FOR UPDATE OF p`,
          [event.aggregate_id],
        )
      ).rows[0];
      const snapshotHash = hashJson(p.snapshot);
      if (
        event.aggregate_version === 1
          ? !!existing
          : !existing ||
            existing.version !== 1 ||
            BigInt(event.producer_sequence) <= BigInt(existing.last_sequence) ||
            existing.branch_id !== branch ||
            existing.device_id !== auth.deviceId ||
            existing.producer_id !== event.producer_id ||
            existing.snapshot_hash !== snapshotHash ||
            existing.quote_id !== p.quote_id ||
            existing.total_minor !== p.total_minor ||
            (existing.execution_mode ?? undefined) !== p.execution_mode
      )
        throw new PosSyncError('CONFLICT');
      // No contiguous-global-sequence requirement: unrelated filtered stream events may create gaps.
      // Per-order v1->v2 is strict; an early cancellation is retried after its creation.
      await client.query(
        `INSERT INTO pos_order_sync_inbox(event_id,branch_id,device_id,producer_id,
        producer_sequence,order_id,aggregate_version,payload_hash,envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          event.event_id,
          branch,
          auth.deviceId,
          event.producer_id,
          event.producer_sequence,
          event.aggregate_id,
          event.aggregate_version,
          hash,
          event,
        ],
      );
      if (event.aggregate_version === 1) {
        await client.query(
          `INSERT INTO pos_order_sync_projection(order_id,branch_id,device_id,producer_id,
          quote_id,snapshot,snapshot_hash,total_minor,version,state,last_event_id,execution_mode)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,'awaiting_payment',$9,$10)`,
          [
            event.aggregate_id,
            branch,
            auth.deviceId,
            event.producer_id,
            p.quote_id,
            p.snapshot,
            snapshotHash,
            p.total_minor,
            event.event_id,
            p.execution_mode ?? null,
          ],
        );
      } else {
        await client.query(
          `UPDATE pos_order_sync_projection SET version=2,state='cancelled',last_event_id=$2,
          updated_at=clock_timestamp() WHERE order_id=$1`,
          [event.aggregate_id, event.event_id],
        );
      }
      return receiptFor(event);
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
      throw new PosSyncError('CONFLICT');
    throw error;
  }
}
