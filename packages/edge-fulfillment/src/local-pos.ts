import { restoreReview } from './restore-review.js';
import { randomUUID } from 'node:crypto';
import { OrderError, audit } from '@pickchick/local-orders';
import type { LocalOrderExecutionPort } from '@pickchick/local-orders';
import { digest, parse, RoutingSchema, FulfillmentError } from './model.js';
import type { Snapshot } from './model.js';
import { buildKitchenPlan } from './kds-plan.js';
import { emit, allocateDisplayNumber } from './records.js';
import type { Reservation } from './records.js';

/** Server wiring only; the POS request cannot grant itself this capability.
 * Both operations execute inside the local commercial command transaction.
 * Cutover (contracts 5.2): the same admission serves a paid pos_sale (order.kind) in that mode,
 * with snapshot.delivery for an aggregator; the plan comes from buildKitchenPlan for both. */
export function localUnpaidExecution(host: {
  enabled?: boolean | undefined;
  deviceId?: string | undefined;
}): LocalOrderExecutionPort {
  return {
    async admit(client, order, actor, commandId) {
      const kind = order.kind ?? 'unpaid_service';
      if (host.enabled !== true || !host.deviceId) throw new OrderError('KITCHEN_UNAVAILABLE');
      const config = (
        await client.query(
          `SELECT f.* FROM fulfillment_config f JOIN branch_config b ON b.id=f.branch_id
         WHERE f.branch_id=$1 AND f.device_id=$2 AND b.ordering_enabled
           AND b.pos_service_mode=$3 FOR SHARE OF f`,
          [order.branchId, host.deviceId, kind],
        )
      ).rows[0];
      if (!config) throw new OrderError('KITCHEN_UNAVAILABLE');
      const stored = (
        await client.query(
          'SELECT payload FROM fulfillment_routing WHERE branch_id=$1 AND version=$2',
          [order.branchId, config.active_routing_version],
        )
      ).rows[0];
      if (!stored) throw new OrderError('KITCHEN_UNAVAILABLE');
      const snapshot: Snapshot = {
        organizationId: config.organization_id,
        branchId: order.branchId,
        channel: 'pos',
        serviceMode: order.quote.service_mode,
        currency: 'KZT',
        totalMinor: order.quote.total_minor,
        ...(order.quote.details
          ? {
              displayName: order.quote.details.display_name,
              kitchenComment: order.quote.details.kitchen_comment,
            }
          : {}),
        // Aggregator order (pos_sale): provider and upper-case number for the delivery desk.
        ...(order.delivery ? { delivery: order.delivery } : {}),
        lines: order.quote.lines.map((line) => ({
          lineId: randomUUID(),
          productId: line.product_id,
          title: line.name.ru,
          description: order.quote.details?.kitchen_comment ?? '',
          quantity: line.quantity,
          selectedDetails: {
            kind: 'item',
            components: [],
            modifiers: (line.modifiers ?? []).map((modifier) => ({
              groupId: modifier.group_id,
              groupTitle: modifier.group_name,
              optionId: modifier.option_id,
              label: modifier.name,
              quantity: modifier.quantity ?? 1,
              linkedProductId: null,
            })),
          },
        })),
      };
      let routing, kitchen;
      try {
        routing = parse(RoutingSchema, stored.payload);
        kitchen = await buildKitchenPlan(client, { branchId: order.branchId, snapshot, routing });
      } catch (error) {
        if (error instanceof FulfillmentError) throw new OrderError('KITCHEN_UNAVAILABLE');
        throw error;
      }
      const quoteHash = digest(order.quote);
      // Cashier numbers 1-299 from the first order of each shift (edge 022).
      const number = await allocateDisplayNumber(client, order.branchId);
      if (number === null) throw new OrderError('KITCHEN_UNAVAILABLE');
      const row = (
        await client.query<Reservation>(
          `INSERT INTO fulfillment_reservations(order_id,branch_id,reservation_id,quote_id,
          quote_hash,owner_hash,commercial_owner,fulfillment_owner,device_id,snapshot,
          routing_version,task_plan,assembly_station_id,state,display_number,business_day,
          authorized_event_id,admission_kind,local_order_id,authorized_by_staff_id)
         VALUES($1,$2,$3,$4,$5,$6,'edge_pos','edge',$7,$8,$9,$10,$11,'accepted',
           $14::bigint,(clock_timestamp() AT TIME ZONE 'Asia/Almaty')::date,
           $12,$15,$1,$13) RETURNING *`,
          [
            order.orderId,
            order.branchId,
            randomUUID(),
            order.quote.quote_id,
            quoteHash,
            digest({
              organizationId: config.organization_id,
              branchId: order.branchId,
              deviceId: host.deviceId,
              owner: 'edge_pos',
              orderId: order.orderId,
              quoteId: order.quote.quote_id,
              quoteDigest: quoteHash,
            }),
            host.deviceId,
            snapshot,
            routing.version,
            JSON.stringify(kitchen.plan),
            kitchen.assemblyStationId,
            commandId,
            actor.staff_id,
            number,
            kind,
          ],
        )
      ).rows[0]!;
      await client.query(
        `INSERT INTO fulfillment_tasks(id,branch_id,order_id,component_key,station_id,routing_version,kind,details)
         SELECT gen_random_uuid(),$1,$2,p->>'componentKey',(p->>'stationId')::uuid,$3,p->>'kind',p->'details'
         FROM jsonb_array_elements($4::jsonb) p`,
        [order.branchId, order.orderId, routing.version, JSON.stringify(kitchen.plan)],
      );
      await emit(client, row, 'edge.fulfillment_accepted', { staffId: actor.staff_id });
      await audit(
        client,
        order.branchId,
        actor.staff_id,
        kind === 'pos_sale'
          ? 'fulfillment.local_pos_sale_admitted'
          : 'fulfillment.local_unpaid_admitted',
        order.orderId,
      );
    },
    async cancel(client, branchId, orderId, actor, reason, kind = 'unpaid_service') {
      // Kitchen commands lock this same reservation before touching tasks. A
      // simultaneous start/cancel therefore has one authoritative outcome.
      // Cutover (contracts 5.2): the void of a paid pos_sale cancels through this same path.
      const row = (
        await client.query<Reservation>(
          `SELECT * FROM fulfillment_reservations WHERE order_id=$1 AND branch_id=$2
         AND commercial_owner='edge_pos' AND admission_kind=$3 FOR UPDATE`,
          [orderId, branchId, kind],
        )
      ).rows[0];
      if (!row) throw new OrderError('KITCHEN_UNAVAILABLE');
      const review = await restoreReview(client, row);
      if (review && review.status !== 'resume') throw new OrderError('KITCHEN_UNAVAILABLE');
      const tasks = await client.query('SELECT state FROM fulfillment_tasks WHERE order_id=$1', [
        orderId,
      ]);
      if (
        row.state !== 'accepted' ||
        !tasks.rowCount ||
        tasks.rows.some((task) => task.state !== 'queued')
      )
        throw new OrderError('ORDER_IN_PRODUCTION');
      await client.query(
        `UPDATE fulfillment_tasks SET state='cancelled',version=version+1,updated_at=clock_timestamp()
         WHERE order_id=$1 AND state='queued'`,
        [orderId],
      );
      const cancelled = (
        await client.query<Reservation>(
          `UPDATE fulfillment_reservations SET state='cancelled',version=version+1,
         cancellation_reason=$2,updated_at=clock_timestamp() WHERE order_id=$1 RETURNING *`,
          [orderId, reason],
        )
      ).rows[0]!;
      await emit(client, cancelled, 'edge.fulfillment_cancelled', {
        staffId: actor.staff_id,
        reason,
        inventoryEffect: 'none',
      });
      await audit(
        client,
        branchId,
        actor.staff_id,
        kind === 'pos_sale'
          ? 'fulfillment.local_pos_sale_cancelled'
          : 'fulfillment.local_unpaid_cancelled',
        orderId,
      );
    },
  };
}
