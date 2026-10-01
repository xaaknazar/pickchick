import { randomUUID } from 'node:crypto';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { authenticateDevice } from '@pickchick/menu-sync';
import type { DeviceAuth } from '@pickchick/menu-sync';
import { CommerceRepository } from '@pickchick/commerce-core';
import { digest } from '@pickchick/edge-fulfillment';
import {
  parse,
  TransportError,
  TransportScopeSchema,
  PullRequestSchema,
  PullResponseSchema,
  TransportAckSchema,
  EdgeEventSchema,
  ReleaseResultEventSchema,
} from './model.js';
import type { TransportScope } from './model.js';

interface Binding {
  organization_id: string;
  branch_id: string;
  device_id: string;
  producer_id: string;
  active: boolean;
}
function fail(code: ConstructorParameters<typeof TransportError>[0]): never {
  throw new TransportError(code);
}
const scopeOf = (b: Binding): TransportScope => ({
  organizationId: b.organization_id,
  branchId: b.branch_id,
  deviceId: b.device_id,
  producerId: b.producer_id,
});
async function binding(client: DatabaseClient, auth: DeviceAuth) {
  const branch = await authenticateDevice(client, auth);
  const row = (
    await client.query<Binding>(
      'SELECT * FROM fulfillment_transport_bindings WHERE branch_id=$1 AND device_id=$2 AND active FOR SHARE',
      [branch, auth.deviceId],
    )
  ).rows[0];
  return row ?? fail('FORBIDDEN');
}

/** Trusted local provisioning only. There is deliberately no HTTP setup route. */
export async function provisionFulfillmentTransport(pool: DatabasePool, input: unknown) {
  const scope = parse(TransportScopeSchema, input);
  return transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'transport-setup:' + scope.branchId,
    ]);
    const device = await client.query(
      "SELECT 1 FROM devices WHERE id=$1 AND branch_id=$2 AND organization_id=$3 AND kind='edge' AND status='active' FOR SHARE",
      [scope.deviceId, scope.branchId, scope.organizationId],
    );
    if (!device.rowCount) fail('FORBIDDEN');
    const old = (
      await client.query<Binding>(
        'SELECT * FROM fulfillment_transport_bindings WHERE branch_id=$1 FOR UPDATE',
        [scope.branchId],
      )
    ).rows[0];
    if (old) {
      if (digest(scopeOf(old)) !== digest(scope)) fail('CONFLICT');
      if (!old.active) fail('FORBIDDEN');
      return scope;
    }
    const used = await client.query(
      'SELECT 1 FROM fulfillment_transport_bindings WHERE device_id=$1 OR producer_id=$2',
      [scope.deviceId, scope.producerId],
    );
    if (used.rowCount) fail('CONFLICT');
    await client.query(
      'INSERT INTO fulfillment_transport_bindings(organization_id,branch_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
      [scope.organizationId, scope.branchId, scope.deviceId, scope.producerId],
    );
    return scope;
  });
}

/** One delivery per call. A bank/fiscal worker cannot claim this branch's commands. */
export async function pullFulfillment(pool: DatabasePool, auth: DeviceAuth, input: unknown) {
  const request = parse(PullRequestSchema, input),
    identity = { ...auth };
  return transaction(pool, async (client) => {
    const b = await binding(client, identity),
      token = randomUUID();
    if (request.availability) {
      const ids = [...new Set(request.availability.stoppedIds)].sort();
      await client.query(
        `INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids) VALUES($1,$2,$3,$4::uuid[])
        ON CONFLICT(branch_id) DO UPDATE SET revision=EXCLUDED.revision,stopped_ids=EXCLUDED.stopped_ids,observed_at=clock_timestamp()
        WHERE cloud_branch_availability.device_id=EXCLUDED.device_id AND cloud_branch_availability.revision<EXCLUDED.revision`,
        [b.branch_id, b.device_id, request.availability.revision, ids],
      );
    }
    if (request.availabilityOnly) {
      if (!request.availability) fail('INVALID_REQUEST');
      return parse(PullResponseSchema, { scope: scopeOf(b), event: null });
    }
    const result = await client.query<{ id: string; event_type: string; payload: unknown }>(
      `WITH selected AS (
       SELECT e.id FROM commerce_outbox e JOIN commerce_orders o ON o.id=e.order_id
       WHERE o.organization_id=$1 AND o.branch_id=$2 AND e.acknowledged_at IS NULL
       AND (e.lease_until IS NULL OR e.lease_until<clock_timestamp())
       AND (e.event_type IN ('edge.admission_requested','edge.kitchen_admission_requested') OR ($7=2 AND e.event_type='edge.admission_release_requested'))
       AND (e.event_type='edge.admission_release_requested' OR (NOT o.attention_required
       AND NOT EXISTS(SELECT 1 FROM cloud_fulfillment_projection p WHERE p.order_id=o.id AND p.state IN ('released','cancel_requested','cancelled'))))
       AND (o.admission_device_id IS NULL OR o.admission_device_id=$3)
       AND (e.event_type='edge.admission_requested' OR (e.event_type='edge.admission_release_requested'
         AND EXISTS(SELECT 1 FROM commerce_cancellation_intents i WHERE i.order_id=o.id AND i.release_event_id=e.id AND i.state IN ('release_pending','cancelled','needs_review'))
         AND NOT EXISTS(SELECT 1 FROM commerce_payment_attempts a WHERE a.order_id=o.id)
         AND o.kitchen_effect_id IS NULL
       ) OR (e.event_type='edge.kitchen_admission_requested'
         AND NOT EXISTS(SELECT 1 FROM commerce_cancellation_intents i WHERE i.order_id=o.id)
         AND o.admission_device_id=$3 AND o.admission_reservation_id IS NOT NULL
         AND EXISTS(SELECT 1 FROM cloud_fulfillment_projection p WHERE p.order_id=o.id AND p.device_id=$3 AND p.reservation_id=o.admission_reservation_id AND p.state IN ('held','accepted','in_production','ready','handed_over'))
         AND e.payload->>'deviceId'=$3::text
         AND e.payload->>'reservationId'=o.admission_reservation_id::text
         AND NOT EXISTS(SELECT 1 FROM commerce_refunds r WHERE r.order_id=o.id AND r.state<>'failed')
         AND COALESCE((SELECT SUM(amount_minor) FROM commerce_captures c WHERE c.order_id=o.id),0)=o.total_minor
         AND (o.fiscal_policy='deferred_pilot' OR EXISTS(SELECT 1 FROM commerce_fiscal_documents f WHERE f.order_id=o.id AND f.kind='sale' AND f.state='issued'))
       ))
       ORDER BY e.attempts,e.sequence LIMIT 1 FOR UPDATE OF e,o SKIP LOCKED)
       UPDATE commerce_outbox e SET lease_worker=$4,lease_token=$5,lease_until=clock_timestamp()+$6*interval '1 second',attempts=attempts+1
       FROM selected s WHERE e.id=s.id RETURNING e.id,e.event_type,e.payload`,
      [
        b.organization_id,
        b.branch_id,
        b.device_id,
        request.workerId,
        token,
        request.leaseSeconds,
        request.protocolVersion ?? 1,
      ],
    );
    const row = result.rows[0];
    return parse(PullResponseSchema, {
      scope: scopeOf(b),
      event: row
        ? {
            command: { eventId: row.id, type: row.event_type, payload: row.payload },
            leaseToken: token,
          }
        : null,
    });
  });
}

export async function acknowledgeFulfillment(pool: DatabasePool, auth: DeviceAuth, input: unknown) {
  const request = parse(TransportAckSchema, input),
    identity = { ...auth };
  return transaction(pool, async (client) => {
    const b = await binding(client, identity);
    const result = await client.query(
      `UPDATE commerce_outbox e SET acknowledged_at=COALESCE(e.acknowledged_at,clock_timestamp())
       FROM commerce_orders o WHERE e.order_id=o.id AND o.organization_id=$1 AND o.branch_id=$2
       AND (o.admission_device_id IS NULL OR o.admission_device_id=$3)
       AND e.event_type IN ('edge.admission_requested','edge.kitchen_admission_requested','edge.admission_release_requested')
       AND e.id=$4 AND e.lease_worker=$5 AND e.lease_token=$6
       AND (e.lease_until>clock_timestamp() OR e.acknowledged_at IS NOT NULL) RETURNING e.id`,
      [
        b.organization_id,
        b.branch_id,
        b.device_id,
        request.eventId,
        request.workerId,
        request.leaseToken,
      ],
    );
    if (!result.rowCount) fail('CONFLICT');
    return { eventId: request.eventId, acknowledged: true as const };
  });
}

/** Store the authenticated edge fact; never change commercial money or infer
 * task completeness. Admission and the transport receipt commit atomically. */
export async function receiveFulfillment(pool: DatabasePool, auth: DeviceAuth, input: unknown) {
  if (
    input &&
    typeof input === 'object' &&
    'type' in input &&
    input.type === 'edge.admission_release_result'
  )
    return receiveReleaseResult(pool, auth, input);
  // Clone/hash before awaiting: callers cannot mutate the event while authentication waits.
  const raw = JSON.parse(JSON.stringify(input)) as unknown;
  const event = parse(EdgeEventSchema, raw),
    requestHash = digest(raw),
    identity = { ...auth };
  const p = event.payload;
  if (event.type === 'edge.admission_reserved' && event.aggregateVersion !== 1)
    fail('INVALID_REQUEST');
  return transaction(pool, async (client) => {
    const b = await binding(client, identity);
    if (p.branchId !== b.branch_id || p.deviceId !== b.device_id) fail('FORBIDDEN');
    // Event locks protect independent ID/sequence uniqueness without a branch/global lock.
    const keys = [
      'transport-event:' + b.device_id + ':' + event.eventId,
      'transport-sequence:' + b.device_id + ':' + event.sequence,
    ].sort();
    for (const key of keys)
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
    const old = (
      await client.query<{ request_hash: string; receipt: unknown }>(
        'SELECT request_hash,receipt FROM cloud_fulfillment_inbox WHERE device_id=$1 AND event_id=$2',
        [b.device_id, event.eventId],
      )
    ).rows[0];
    if (old) {
      if (old.request_hash !== requestHash) fail('CONFLICT');
      return old.receipt;
    }
    if (
      (
        await client.query(
          'SELECT 1 FROM cloud_fulfillment_inbox WHERE device_id=$1 AND source_sequence=$2',
          [b.device_id, event.sequence],
        )
      ).rowCount
    )
      fail('CONFLICT');
    const commercial = (
      await client.query<{
        quote_id: string;
        quote_digest: string;
        admission_device_id: string | null;
        admission_reservation_id: string | null;
        kitchen_effect_id: string | null;
      }>(
        'SELECT quote_id,quote_digest,admission_device_id,admission_reservation_id,kitchen_effect_id FROM commerce_orders WHERE id=$1 AND branch_id=$2 AND organization_id=$3 FOR UPDATE',
        [event.orderId, b.branch_id, b.organization_id],
      )
    ).rows[0];
    if (!commercial) fail('NOT_FOUND');
    const ownerHash = digest({
      organizationId: b.organization_id,
      branchId: b.branch_id,
      deviceId: b.device_id,
      owner: 'cloud',
      orderId: event.orderId,
      quoteId: commercial.quote_id,
      quoteDigest: commercial.quote_digest,
    });
    if (
      p.quoteId !== commercial.quote_id ||
      p.quoteDigest !== commercial.quote_digest ||
      p.ownerHash !== ownerHash
    )
      fail('CONFLICT');
    if (
      commercial.admission_reservation_id !== null &&
      (commercial.admission_reservation_id !== p.reservationId ||
        commercial.admission_device_id !== b.device_id)
    )
      fail('CONFLICT');
    if (event.type !== 'edge.admission_reserved' && commercial.admission_reservation_id === null)
      fail('CONFLICT');
    if (
      ['accepted', 'in_production', 'ready', 'handed_over', 'cancel_requested'].includes(p.state) &&
      !commercial.kitchen_effect_id
    )
      fail('CONFLICT');
    const previous = (
      await client.query<{
        reservation_id: string;
        routing_version: number;
        assembly_station_id: string | null;
        version: number;
        display_number: string | null;
      }>('SELECT * FROM cloud_fulfillment_projection WHERE order_id=$1', [event.orderId])
    ).rows[0];
    if (
      previous &&
      (previous.reservation_id !== p.reservationId ||
        previous.routing_version !== p.routingVersion ||
        (previous.assembly_station_id !== null &&
          p.assemblyStationId !== undefined &&
          previous.assembly_station_id !== p.assemblyStationId) ||
        (previous.display_number !== null &&
          p.displayNumber !== null &&
          previous.display_number !== p.displayNumber))
    )
      fail('CONFLICT');
    const payloadHash = digest({ type: event.type, payload: p });
    const version = (
      await client.query<{ payload_hash: string }>(
        'SELECT payload_hash FROM cloud_fulfillment_versions WHERE order_id=$1 AND version=$2',
        [event.orderId, event.aggregateVersion],
      )
    ).rows[0];
    if (version && version.payload_hash !== payloadHash) fail('CONFLICT');
    if (!version)
      await client.query(
        'INSERT INTO cloud_fulfillment_versions(order_id,version,payload_hash) VALUES($1,$2,$3)',
        [event.orderId, event.aggregateVersion, payloadHash],
      );
    if (event.type === 'edge.admission_reserved' && commercial.admission_reservation_id === null) {
      await new CommerceRepository(pool).confirmAdmissionAuthenticated(
        identity,
        {
          eventId: event.eventId,
          orderId: event.orderId,
          reservationId: p.reservationId,
          quoteDigest: p.quoteDigest,
        },
        client,
      );
    }
    if (event.type === 'edge.task_changed') {
      const taskHash = digest({
        taskId: p.taskId,
        stationId: p.stationId,
        version: p.taskVersion,
        state: p.taskState,
      });
      const task = (
        await client.query<{ station_id: string }>(
          'SELECT station_id FROM cloud_fulfillment_observed_tasks WHERE order_id=$1 AND task_id=$2',
          [event.orderId, p.taskId],
        )
      ).rows[0];
      if (task && task.station_id !== p.stationId) fail('CONFLICT');
      const tv = (
        await client.query<{ payload_hash: string }>(
          'SELECT payload_hash FROM cloud_fulfillment_task_versions WHERE order_id=$1 AND task_id=$2 AND version=$3',
          [event.orderId, p.taskId, p.taskVersion],
        )
      ).rows[0];
      if (tv && tv.payload_hash !== taskHash) fail('CONFLICT');
      if (!tv)
        await client.query(
          'INSERT INTO cloud_fulfillment_task_versions(order_id,task_id,version,payload_hash) VALUES($1,$2,$3,$4)',
          [event.orderId, p.taskId, p.taskVersion, taskHash],
        );
      await client.query(
        `INSERT INTO cloud_fulfillment_observed_tasks(order_id,task_id,station_id,version,state,aggregate_version,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(order_id,task_id) DO UPDATE SET version=EXCLUDED.version,state=EXCLUDED.state,aggregate_version=EXCLUDED.aggregate_version,payload_hash=EXCLUDED.payload_hash
        WHERE cloud_fulfillment_observed_tasks.version<EXCLUDED.version`,
        [
          event.orderId,
          p.taskId,
          p.stationId,
          p.taskVersion,
          p.taskState,
          event.aggregateVersion,
          taskHash,
        ],
      );
    }
    await client.query(
      `INSERT INTO cloud_fulfillment_projection(order_id,branch_id,organization_id,device_id,reservation_id,quote_id,quote_hash,owner_hash,version,state,display_number,routing_version,assembly_station_id,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT(order_id) DO UPDATE SET version=EXCLUDED.version,state=EXCLUDED.state,display_number=EXCLUDED.display_number,
      assembly_station_id=COALESCE(cloud_fulfillment_projection.assembly_station_id,EXCLUDED.assembly_station_id),payload=EXCLUDED.payload,observed_at=clock_timestamp()
      WHERE cloud_fulfillment_projection.version<EXCLUDED.version`,
      [
        event.orderId,
        b.branch_id,
        b.organization_id,
        b.device_id,
        p.reservationId,
        p.quoteId,
        p.quoteDigest,
        p.ownerHash,
        event.aggregateVersion,
        p.state,
        p.displayNumber,
        p.routingVersion,
        p.assemblyStationId ?? null,
        p,
      ],
    );
    await new CommerceRepository(pool).scheduleUnpaidCancellation(
      client,
      { organizationId: b.organization_id, branchId: b.branch_id },
      event.orderId,
    );
    const receipt = { eventId: event.eventId, acknowledged: true as const };
    await client.query(
      `INSERT INTO cloud_fulfillment_inbox(device_id,branch_id,organization_id,event_id,source_sequence,order_id,aggregate_version,event_type,request_hash,payload,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        b.device_id,
        b.branch_id,
        b.organization_id,
        event.eventId,
        event.sequence,
        event.orderId,
        event.aggregateVersion,
        event.type,
        requestHash,
        p,
        receipt,
      ],
    );
    return receipt;
  });
}

/** A command decision has its own ledger: it is not a second order state version. */
export async function receiveReleaseResult(pool: DatabasePool, auth: DeviceAuth, input: unknown) {
  const raw = JSON.parse(JSON.stringify(input)) as unknown,
    event = parse(ReleaseResultEventSchema, raw),
    hash = digest(raw),
    identity = { ...auth },
    p = event.payload;
  return transaction(pool, async (client) => {
    const b = await binding(client, identity);
    if (p.branchId !== b.branch_id || p.deviceId !== b.device_id) fail('FORBIDDEN');
    for (const key of [
      'transport-event:' + b.device_id + ':' + event.eventId,
      'transport-sequence:' + b.device_id + ':' + event.sequence,
    ].sort())
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
    const old = (
      await client.query(
        'SELECT request_hash,receipt FROM cloud_fulfillment_inbox WHERE device_id=$1 AND event_id=$2',
        [b.device_id, event.eventId],
      )
    ).rows[0];
    if (old) {
      if (old.request_hash !== hash) fail('CONFLICT');
      return old.receipt;
    }
    if (
      (
        await client.query(
          'SELECT 1 FROM cloud_fulfillment_inbox WHERE device_id=$1 AND source_sequence=$2',
          [b.device_id, event.sequence],
        )
      ).rowCount
    )
      fail('CONFLICT');
    const order = (
      await client.query(
        'SELECT * FROM commerce_orders WHERE id=$1 AND organization_id=$2 AND branch_id=$3 FOR UPDATE',
        [event.orderId, b.organization_id, b.branch_id],
      )
    ).rows[0];
    if (!order) fail('NOT_FOUND');
    const intent = (
      await client.query(
        'SELECT * FROM commerce_cancellation_intents WHERE order_id=$1 FOR UPDATE',
        [event.orderId],
      )
    ).rows[0];
    if (
      !intent ||
      intent.state !== 'release_pending' ||
      intent.release_event_id !== p.requestEventId
    )
      fail('CONFLICT');
    const command = (
      await client.query(
        "SELECT id,event_type,payload FROM commerce_outbox WHERE id=$1 AND order_id=$2 AND event_type='edge.admission_release_requested'",
        [p.requestEventId, event.orderId],
      )
    ).rows[0];
    if (!command) fail('CONFLICT');
    const expectedDigest = digest({
      eventId: command.id,
      type: command.event_type,
      payload: command.payload,
    });
    const ownerHash = digest({
      organizationId: b.organization_id,
      branchId: b.branch_id,
      deviceId: b.device_id,
      owner: 'cloud',
      orderId: event.orderId,
      quoteId: order.quote_id,
      quoteDigest: order.quote_digest,
    });
    if (
      p.requestDigest !== expectedDigest ||
      p.quoteId !== order.quote_id ||
      p.quoteDigest !== order.quote_digest ||
      p.ownerHash !== ownerHash ||
      p.reservationId !== order.admission_reservation_id ||
      order.admission_device_id !== b.device_id ||
      p.reservationId !== intent.reservation_id ||
      p.reason !== command.payload.reason
    )
      fail('CONFLICT');
    // Routing/assembly are pinned by the original authenticated admission, even
    // though this decision is deliberately separate from state-version storage.
    const pinned = (
      await client.query(
        'SELECT routing_version,assembly_station_id,display_number FROM cloud_fulfillment_projection WHERE order_id=$1',
        [event.orderId],
      )
    ).rows[0];
    if (
      !pinned ||
      pinned.routing_version !== p.routingVersion ||
      (pinned.assembly_station_id !== null && pinned.assembly_station_id !== p.assemblyStationId) ||
      (pinned.display_number !== null &&
        p.displayNumber !== null &&
        pinned.display_number !== p.displayNumber)
    )
      fail('CONFLICT');
    if (p.outcome === 'applied' && p.version !== intent.expected_edge_version + 1) fail('CONFLICT');
    if (
      p.outcome === 'rejected' &&
      ((p.rejectionCode === 'VERSION_CONFLICT' && p.version === intent.expected_edge_version) ||
        (p.rejectionCode === 'NOT_HELD' &&
          (p.version !== intent.expected_edge_version || p.state === 'held')))
    )
      fail('CONFLICT');
    const unsafe = (
      await client.query(
        'SELECT 1 FROM commerce_payment_attempts WHERE order_id=$1 UNION ALL SELECT 1 FROM commerce_captures WHERE order_id=$1 LIMIT 1',
        [event.orderId],
      )
    ).rowCount;
    const state = p.outcome === 'applied' && !unsafe ? 'cancelled' : 'needs_review',
      code = unsafe ? 'PAYMENT_HISTORY' : p.rejectionCode;
    await client.query(
      'INSERT INTO commerce_cancellation_results(event_id,device_id,request_event_id,cancellation_id,request_digest,result_digest,payload) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [event.eventId, b.device_id, p.requestEventId, intent.id, expectedDigest, hash, p],
    );
    await client.query(
      'UPDATE commerce_cancellation_intents SET state=$2,result_event_id=$3,resolution_code=$4,updated_at=clock_timestamp() WHERE id=$1',
      [intent.id, state, event.eventId, code],
    );
    const receipt = { eventId: event.eventId, acknowledged: true as const };
    await client.query(
      'INSERT INTO cloud_fulfillment_inbox(device_id,branch_id,organization_id,event_id,source_sequence,order_id,aggregate_version,event_type,request_hash,payload,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        b.device_id,
        b.branch_id,
        b.organization_id,
        event.eventId,
        event.sequence,
        event.orderId,
        event.aggregateVersion,
        event.type,
        hash,
        p,
        receipt,
      ],
    );
    return receipt;
  });
}
