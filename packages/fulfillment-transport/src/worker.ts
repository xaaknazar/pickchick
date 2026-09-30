import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DeviceIdentitySchema } from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import type { DatabasePool } from '@pickchick/database';
import { EdgeFulfillment, FulfillmentError, digest } from '@pickchick/edge-fulfillment';
import {
  DeliverySchema,
  TransportEdgeEventSchema,
  PullResponseSchema,
  TransportReceiptSchema,
  TransportScopeSchema,
} from './model.js';
import { cloudTransportOrigin, transportRequest, TransportHttpError } from './http.js';
import type { TransportIo } from './http.js';

export interface FulfillmentWorkerOptions {
  enabled: boolean;
  branchId: string;
  origin: string;
  identity: unknown;
}
const PendingSchema = z.strictObject({
  scope: TransportScopeSchema,
  delivery: DeliverySchema,
  workerId: z.uuid(),
});
type Pending = z.infer<typeof PendingSchema>;
type Failure =
  | 'NETWORK_UNKNOWN'
  | 'HTTP_REJECTED'
  | 'INVALID_RESPONSE'
  | 'LOCAL_CONFLICT'
  | 'LOCAL_NOT_READY'
  | 'LOCAL_ROUTING_MISSING'
  | 'LOCAL_STORAGE_UNKNOWN'
  | 'SCOPE_MISMATCH';
const failed = (error: unknown): Failure =>
  error instanceof z.ZodError
    ? 'INVALID_RESPONSE'
    : error instanceof TransportHttpError
      ? error.code
      : error instanceof FulfillmentError
        ? error.code === 'ROUTING_MISSING'
          ? 'LOCAL_ROUTING_MISSING'
          : error.code === 'NOT_READY'
            ? 'LOCAL_NOT_READY'
            : 'LOCAL_CONFLICT'
        : 'LOCAL_STORAGE_UNKNOWN';

/** One bounded turn; supervisor may repeat after its interval. No SQL transaction spans HTTP. */
export async function syncFulfillmentOnce(
  pool: DatabasePool,
  options: FulfillmentWorkerOptions,
  io: TransportIo = {},
) {
  if (!options.enabled) return { state: 'disabled' as const };
  // A protocol-v2 worker must never run against the pre-result edge schema.
  if (
    (
      await pool.query(
        "SELECT 1 FROM schema_migrations WHERE scope='edge' AND version='007_edge_release_results.sql'",
      )
    ).rowCount !== 1
  )
    return { state: 'blocked' as const, error: 'SCHEMA_UNAVAILABLE' as const };
  const identity = DeviceIdentitySchema.parse(options.identity),
    branchId = z.uuid().parse(options.branchId),
    origin = cloudTransportOrigin(options.origin);
  if (identity.branch_id !== branchId) throw new TransportHttpError('INVALID_RESPONSE');
  const local = (
    await pool.query(
      'SELECT organization_id,device_id,cloud_producer_id FROM fulfillment_config WHERE branch_id=$1',
      [branchId],
    )
  ).rows[0];
  if (!local || local.device_id !== identity.device_id)
    return { state: 'blocked' as const, error: 'SCOPE_MISMATCH' as const };
  const scope = TransportScopeSchema.parse({
    organizationId: local.organization_id,
    branchId,
    deviceId: local.device_id,
    producerId: local.cloud_producer_id,
  });
  const workerId = randomUUID(),
    leaseToken = randomUUID();
  const acquired = await transaction(pool, async (client) => {
    await client.query(
      'INSERT INTO fulfillment_transport_state(branch_id) VALUES($1) ON CONFLICT DO NOTHING',
      [branchId],
    );
    return (
      await client.query(
        `UPDATE fulfillment_transport_state SET worker_id=$2,lease_token=$3,lease_until=clock_timestamp()+interval '60 seconds',attempts=attempts+1,updated_at=clock_timestamp() WHERE branch_id=$1 AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING pending_cloud`,
        [branchId, workerId, leaseToken],
      )
    ).rows[0];
  });
  if (!acquired) return { state: 'busy' as const };
  const update = async (sql: string, args: unknown[] = []) => {
    const r = await pool.query(
      `UPDATE fulfillment_transport_state SET ${sql},updated_at=clock_timestamp() WHERE branch_id=$1 AND worker_id=$2 AND lease_token=$3 AND lease_until>clock_timestamp() RETURNING branch_id`,
      [branchId, workerId, leaseToken, ...args],
    );
    if (!r.rowCount) throw new TransportHttpError('NETWORK_UNKNOWN');
  };
  const diagnostic = async () => ({
    unresolvedFailures: Number(
      (
        await pool.query(
          'SELECT count(*) FROM fulfillment_transport_failures WHERE branch_id=$1 AND resolved_at IS NULL',
          [branchId],
        )
      ).rows[0].count,
    ),
    unresolvedReverseFailures: Number(
      (
        await pool.query(
          'SELECT count(*) FROM fulfillment_transport_reverse_failures WHERE branch_id=$1 AND resolved_at IS NULL',
          [branchId],
        )
      ).rows[0].count,
    ),
  });
  const park = async (pending: Pending) =>
    transaction(pool, async (client) => {
      const owned = (
        await client.query(
          'SELECT pending_cloud FROM fulfillment_transport_state WHERE branch_id=$1 AND worker_id=$2 AND lease_token=$3 AND lease_until>clock_timestamp() FOR UPDATE',
          [branchId, workerId, leaseToken],
        )
      ).rows[0];
      if (!owned || digest(owned.pending_cloud) !== digest(pending))
        throw new TransportHttpError('NETWORK_UNKNOWN');
      const hash = digest({ scope: pending.scope, command: pending.delivery.command });
      const inserted = await client.query(
        "INSERT INTO fulfillment_transport_failures(event_id,branch_id,scope,command,request_hash,reason) VALUES($1,$2,$3,$4,$5,'LOCAL_ROUTING_MISSING') ON CONFLICT DO NOTHING RETURNING event_id",
        [pending.delivery.command.eventId, branchId, pending.scope, pending.delivery.command, hash],
      );
      const saved = (
        await client.query(
          'SELECT request_hash FROM fulfillment_transport_failures WHERE event_id=$1 AND branch_id=$2 FOR UPDATE',
          [pending.delivery.command.eventId, branchId],
        )
      ).rows[0];
      if (saved?.request_hash !== hash) throw new FulfillmentError('CONFLICT');
      if (!inserted.rowCount)
        await client.query(
          'UPDATE fulfillment_transport_failures SET attempts=attempts+1,last_failed_at=clock_timestamp() WHERE event_id=$1',
          [pending.delivery.command.eventId],
        );
      await client.query(
        "UPDATE fulfillment_transport_state SET pending_cloud=NULL,last_error='LOCAL_ROUTING_MISSING',updated_at=clock_timestamp() WHERE branch_id=$1",
        [branchId],
      );
    });
  const repo = new EdgeFulfillment(pool);
  try {
    // Directions progress independently. A rejected historical reverse event must
    // not prevent reserving an unrelated new cloud order.
    const reverse = await transaction(pool, async (client) => {
      const owned = (
        await client.query(
          'SELECT 1 FROM fulfillment_transport_state WHERE branch_id=$1 AND worker_id=$2 AND lease_token=$3 AND lease_until>clock_timestamp() FOR SHARE',
          [branchId, workerId, leaseToken],
        )
      ).rowCount;
      if (!owned) throw new TransportHttpError('NETWORK_UNKNOWN');
      return (
        await client.query(
          `WITH chosen AS (SELECT o.event_id FROM fulfillment_outbox o WHERE o.branch_id=$1 AND o.acknowledged_at IS NULL AND (o.lease_until IS NULL OR o.lease_until<clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM fulfillment_transport_reverse_failures f WHERE f.event_id=o.event_id AND f.resolved_at IS NULL AND f.retry_after>clock_timestamp()) ORDER BY o.attempts,o.sequence LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE fulfillment_outbox o SET lease_worker=$2,lease_token=$3,lease_until=clock_timestamp()+interval '30 seconds',attempts=attempts+1 FROM chosen c WHERE o.event_id=c.event_id RETURNING o.*`,
          [branchId, workerId, randomUUID()],
        )
      ).rows[0];
    });
    let reverseError: Failure | null = null;
    if (reverse) {
      const raw = {
        schemaVersion: 1,
        eventId: reverse.event_id,
        sequence: reverse.sequence,
        orderId: reverse.order_id,
        aggregateVersion: reverse.aggregate_version,
        type: reverse.event_type,
        payload: reverse.payload,
      };
      const hash = digest(raw);
      try {
        const event = TransportEdgeEventSchema.parse(raw);
        const receipt = TransportReceiptSchema.parse(
          await transportRequest(origin, 'events', identity, event, io),
        );
        if (receipt.eventId !== event.eventId) throw new TransportHttpError('INVALID_RESPONSE');
        await repo.acknowledgeOutbox(scope, {
          eventId: event.eventId,
          workerId,
          leaseToken: reverse.lease_token,
        });
        await pool.query(
          'UPDATE fulfillment_transport_reverse_failures SET resolved_at=COALESCE(resolved_at,clock_timestamp()) WHERE event_id=$1 AND branch_id=$2',
          [event.eventId, branchId],
        );
      } catch (error) {
        reverseError = failed(error);
        const saved = await pool.query(
          `INSERT INTO fulfillment_transport_reverse_failures(event_id,branch_id,request_hash,last_error,retry_after) VALUES($1,$2,$3,$4,clock_timestamp()+interval '2 seconds') ON CONFLICT(event_id) DO UPDATE SET attempts=fulfillment_transport_reverse_failures.attempts+1,last_error=EXCLUDED.last_error,last_failed_at=clock_timestamp(),retry_after=clock_timestamp()+LEAST(300,power(2,LEAST(8,fulfillment_transport_reverse_failures.attempts+1)))*interval '1 second' WHERE fulfillment_transport_reverse_failures.branch_id=EXCLUDED.branch_id AND fulfillment_transport_reverse_failures.request_hash=EXCLUDED.request_hash RETURNING event_id`,
          [reverse.event_id, branchId, hash, reverseError],
        );
        if (!saved.rowCount) throw new FulfillmentError('CONFLICT');
      }
    }
    let pending: Pending | null =
      acquired.pending_cloud === null ? null : PendingSchema.parse(acquired.pending_cloud);
    if (!pending) {
      const pulled = PullResponseSchema.parse(
        await transportRequest(
          origin,
          'pull',
          identity,
          { workerId, leaseSeconds: 30, protocolVersion: 2 },
          io,
        ),
      );
      if (JSON.stringify(pulled.scope) !== JSON.stringify(scope))
        throw new TransportHttpError('INVALID_RESPONSE');
      if (!pulled.event) {
        await update('last_error=NULL,last_success_at=clock_timestamp()');
        return {
          state: reverseError
            ? ('parked' as const)
            : reverse
              ? ('acknowledged' as const)
              : ('idle' as const),
          ...(reverseError ? { error: reverseError } : {}),
          ...(await diagnostic()),
        };
      }
      pending = { scope, delivery: pulled.event, workerId };
      await update('pending_cloud=$4::jsonb', [JSON.stringify(pending)]);
    }
    if (JSON.stringify(pending.scope) !== JSON.stringify(scope)) {
      await update("last_error='SCOPE_MISMATCH'");
      return { state: 'blocked' as const, error: 'SCOPE_MISMATCH' as const };
    }
    const parked = (
      await pool.query(
        'SELECT branch_id,request_hash FROM fulfillment_transport_failures WHERE event_id=$1',
        [pending.delivery.command.eventId],
      )
    ).rows[0];
    if (
      parked &&
      (parked.branch_id !== branchId ||
        parked.request_hash !== digest({ scope: pending.scope, command: pending.delivery.command }))
    )
      throw new FulfillmentError('CONFLICT');
    // Atomic edge inbox+reservation/tasks+reverse outbox commit precedes cloud ACK.
    try {
      if (pending.delivery.command.type === 'edge.admission_release_requested')
        await repo.acceptRelease(scope, pending.delivery.command);
      else await repo.acceptCloud(scope, pending.delivery.command);
    } catch (error) {
      if (error instanceof FulfillmentError && error.code === 'ROUTING_MISSING') {
        await park(pending);
        return {
          state: 'parked' as const,
          error: 'LOCAL_ROUTING_MISSING' as const,
          ...(await diagnostic()),
        };
      }
      throw error;
    }
    await pool.query(
      'UPDATE fulfillment_transport_failures SET resolved_at=COALESCE(resolved_at,clock_timestamp()) WHERE event_id=$1 AND branch_id=$2',
      [pending.delivery.command.eventId, branchId],
    );
    try {
      const receipt = TransportReceiptSchema.parse(
        await transportRequest(
          origin,
          'ack',
          identity,
          {
            eventId: pending.delivery.command.eventId,
            workerId: pending.workerId,
            leaseToken: pending.delivery.leaseToken,
          },
          io,
        ),
      );
      if (receipt.eventId !== pending.delivery.command.eventId)
        throw new TransportHttpError('INVALID_RESPONSE');
    } catch (error) {
      if (error instanceof TransportHttpError && error.status === 409) {
        // Confirmed expired/reassigned lease. Cloud row stays unacknowledged; reclaim
        // redelivers the exact immutable event, and the existing local inbox deduplicates.
        await update("pending_cloud=NULL,last_error='HTTP_REJECTED'");
        return { state: 'retry' as const, error: 'HTTP_REJECTED' as const };
      }
      throw error;
    }
    await update('pending_cloud=NULL,last_error=NULL,last_success_at=clock_timestamp()');
    return {
      state: 'applied' as const,
      ...(reverseError ? { reverseError } : {}),
      ...(await diagnostic()),
    };
  } catch (error) {
    const reason = failed(error);
    await update('last_error=$4', [reason]);
    return { state: 'retry' as const, error: reason };
  } finally {
    await pool.query(
      'UPDATE fulfillment_transport_state SET worker_id=NULL,lease_token=NULL,lease_until=NULL WHERE branch_id=$1 AND worker_id=$2 AND lease_token=$3',
      [branchId, workerId, leaseToken],
    );
  }
}
