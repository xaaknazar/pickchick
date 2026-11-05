import type { DatabasePool } from '@pickchick/database';
import { transaction } from '@pickchick/database';
import { authenticateDevice, hashJson } from '@pickchick/menu-sync';
import type { DeviceAuth } from '@pickchick/menu-sync';
import { PosSyncError } from './model.js';
import { parseKitchenEvent, kitchenReceiptFor } from './kitchen-model.js';

/** Observations only. This receiver never changes a commercial/payment/fiscal aggregate. */
export async function receivePosKitchen(pool: DatabasePool, auth: DeviceAuth, input: unknown) {
  const event = parseKitchenEvent(input),
    p = event.payload,
    hash = hashJson(event);
  try {
    return await transaction(pool, async (client) => {
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
        p.deviceId !== auth.deviceId ||
        event.producer_id !== binding.producer_id
      )
        throw new PosSyncError('FORBIDDEN');
      const restoreCapability = (
        await client.query<{ installed: boolean; ready: boolean }>(
          `SELECT to_regclass('pos_kitchen_restore_conflicts') IS NOT NULL AS installed, CASE WHEN to_regclass('pos_kitchen_restore_conflicts') IS NULL THEN false
         ELSE (has_table_privilege('pos_kitchen_restore_conflicts','SELECT') AND has_table_privilege('pos_kitchen_restore_conflicts','INSERT')) END AS ready`,
        )
      ).rows[0]!;
      const restoreReady = restoreCapability.ready;
      if (restoreCapability.installed && !restoreReady) throw new PosSyncError('CONFLICT');
      if (p.restoreContext && !restoreReady) throw new PosSyncError('CONFLICT');
      const params = [event.event_id, event.producer_id, event.producer_sequence];
      const previous = await client.query(
        `SELECT event_id,payload_hash,branch_id,device_id FROM pos_kitchen_sync_inbox
         WHERE event_id=$1 OR(producer_id=$2 AND producer_sequence=$3)` +
          (restoreReady
            ? ` UNION ALL SELECT event_id,payload_hash,branch_id,device_id
         FROM pos_kitchen_restore_conflicts WHERE event_id=$1 OR(producer_id=$2 AND producer_sequence=$3)`
            : ''),
        params,
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
        return kitchenReceiptFor(event);
      }
      const commercial = (
        await client.query('SELECT * FROM pos_order_sync_projection WHERE order_id=$1 FOR SHARE', [
          p.orderId,
        ])
      ).rows[0];
      const expectedOwner = hashJson({
        organizationId: binding.organization_id,
        branchId: branch,
        deviceId: auth.deviceId,
        owner: 'edge_pos',
        orderId: p.orderId,
        quoteId: p.quoteId,
        quoteDigest: p.quoteDigest,
      });
      if (
        !commercial ||
        // Cutover (cloud 073): a paid pos_sale follows its paid commercial projection the same way.
        commercial.execution_mode !== p.executionMode ||
        commercial.branch_id !== branch ||
        commercial.device_id !== auth.deviceId ||
        commercial.producer_id !== event.producer_id ||
        commercial.quote_id !== p.quoteId ||
        commercial.snapshot_hash !== p.quoteDigest ||
        expectedOwner !== p.ownerHash
      )
        throw new PosSyncError('CONFLICT');
      const existing = (
        await client.query(
          `SELECT p.*,i.producer_sequence AS last_sequence FROM pos_kitchen_sync_projection p
         JOIN pos_kitchen_sync_inbox i ON i.event_id=p.last_event_id WHERE p.order_id=$1 FOR UPDATE OF p`,
          [p.orderId],
        )
      ).rows[0];
      // Ownership/immutable identity must match even when we quarantine an observation.
      if (
        existing &&
        (existing.branch_id !== branch ||
          existing.device_id !== auth.deviceId ||
          existing.producer_id !== event.producer_id ||
          existing.reservation_id !== p.reservationId ||
          existing.quote_id !== p.quoteId ||
          existing.quote_digest !== p.quoteDigest ||
          existing.owner_hash !== p.ownerHash ||
          existing.display_number !== p.displayNumber ||
          existing.routing_version !== p.routingVersion ||
          existing.assembly_station_id !== p.assemblyStationId ||
          existing.execution_mode !== p.executionMode ||
          existing.created_at.toISOString() !== p.createdAt)
      )
        throw new PosSyncError('CONFLICT');
      const timeline = restoreReady
        ? (
            await client.query(
              `SELECT producer_sequence,restore_id FROM pos_kitchen_restore_conflicts
         WHERE order_id=$1 ORDER BY producer_sequence DESC LIMIT 1`,
              [p.orderId],
            )
          ).rows[0]
        : undefined;
      const collision = existing && p.version <= existing.version;
      if (collision || timeline) {
        const context = p.restoreContext;
        // A new, fenced sequence of this authenticated POS may be acknowledged only after
        // durable quarantine. An ordinary conflict, reused sequence or changed owner is rejected.
        if (
          !context ||
          !existing ||
          BigInt(context.sequenceFloor) <= BigInt(existing.last_sequence) ||
          (timeline && BigInt(event.producer_sequence) <= BigInt(timeline.producer_sequence))
        )
          throw new PosSyncError('CONFLICT');
        await client.query(
          `INSERT INTO pos_kitchen_restore_conflicts(event_id,branch_id,device_id,producer_id,
           producer_sequence,order_id,aggregate_version,restore_id,canonical_version,reason,payload_hash,envelope)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            event.event_id,
            branch,
            auth.deviceId,
            event.producer_id,
            event.producer_sequence,
            p.orderId,
            p.version,
            context.id,
            existing.version,
            timeline ? 'restore_timeline' : 'version_collision',
            hash,
            event,
          ],
        );
        return kitchenReceiptFor(event);
      }
      if (
        p.version === 1
          ? !!existing
          : !existing ||
            existing.version + 1 !== p.version ||
            BigInt(existing.last_sequence) >= BigInt(event.producer_sequence) ||
            existing.updated_at.getTime() > Date.parse(p.updatedAt)
      )
        throw new PosSyncError('CONFLICT');
      await client.query(
        `INSERT INTO pos_kitchen_sync_inbox(event_id,branch_id,device_id,producer_id,producer_sequence,order_id,aggregate_version,event_type,payload_hash,envelope)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          event.event_id,
          branch,
          auth.deviceId,
          event.producer_id,
          event.producer_sequence,
          p.orderId,
          p.version,
          event.event_type,
          hash,
          event,
        ],
      );
      if (p.version === 1)
        await client.query(
          `INSERT INTO pos_kitchen_sync_projection(order_id,branch_id,device_id,producer_id,reservation_id,quote_id,quote_digest,owner_hash,execution_mode,display_number,routing_version,assembly_station_id,version,state,created_at,updated_at,last_event_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$15,$9,$10,$11,1,'accepted',$12,$13,$14)`,
          [
            p.orderId,
            branch,
            auth.deviceId,
            event.producer_id,
            p.reservationId,
            p.quoteId,
            p.quoteDigest,
            p.ownerHash,
            p.displayNumber,
            p.routingVersion,
            p.assemblyStationId,
            p.createdAt,
            p.updatedAt,
            event.event_id,
            p.executionMode,
          ],
        );
      else
        await client.query(
          'UPDATE pos_kitchen_sync_projection SET version=$2,state=$3,updated_at=$4,observed_at=clock_timestamp(),last_event_id=$5 WHERE order_id=$1',
          [p.orderId, p.version, p.state, p.updatedAt, event.event_id],
        );
      return kitchenReceiptFor(event);
    });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      ['23505', '23514'].includes(String(error.code))
    )
      throw new PosSyncError('CONFLICT');
    throw error;
  }
}
