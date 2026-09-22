import { ReleaseCommandSchema, ReleaseResultSchema } from './model.js';
import type { ReleaseResult } from './model.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction } from '@pickchick/database';
import type { DatabasePool, DatabaseClient } from '@pickchick/database';
import { authenticateStaff, audit } from '@pickchick/local-orders';
import type { StaffAuth } from '@pickchick/local-orders';
import { boundary } from './setup.js';
import {
  parse,
  digest,
  CloudScopeSchema,
  CloudCommandSchema,
  StaffCommandSchema,
  RoutingSchema,
  taskPlan,
  FulfillmentError,
  LeaseSchema,
  AckSchema,
} from './model.js';
import type { TrustedCloud } from './model.js';

import { view, emit, advance } from './records.js';
import type { Reservation, Task, State } from './records.js';
const fail = (code: ConstructorParameters<typeof FulfillmentError>[0]): never => {
  throw new FulfillmentError(code);
};
async function lock(client: DatabaseClient, key: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
}
async function order(client: DatabaseClient, branchId: string, id: string) {
  const row = (
    await client.query<Reservation>(
      'SELECT * FROM fulfillment_reservations WHERE order_id=$1 AND branch_id=$2 FOR UPDATE',
      [id, branchId],
    )
  ).rows[0];
  return row ?? fail('NOT_FOUND');
}
async function readReservation(client: DatabaseClient, branchId: string, id: string) {
  const row = (
    await client.query<Reservation>(
      'SELECT * FROM fulfillment_reservations WHERE order_id=$1 AND branch_id=$2',
      [id, branchId],
    )
  ).rows[0];
  return row ?? fail('NOT_FOUND');
}
async function stationPermission(
  client: DatabaseClient,
  branch: string,
  staff: { staff_id: string; role: string },
  station: string,
) {
  if (staff.role === 'shift_manager') return;
  if (staff.role !== 'kitchen') fail('FORBIDDEN');
  if (
    !(
      await client.query(
        'SELECT 1 FROM fulfillment_station_grants WHERE branch_id=$1 AND staff_id=$2 AND station_id=$3 FOR SHARE',
        [branch, staff.staff_id, station],
      )
    ).rowCount
  )
    fail('FORBIDDEN');
}
async function tasks(client: DatabaseClient, row: Reservation) {
  return (
    await client.query<Task>(
      'SELECT * FROM fulfillment_tasks WHERE branch_id=$1 AND order_id=$2 ORDER BY id',
      [row.branch_id, row.order_id],
    )
  ).rows;
}

export class EdgeFulfillment {
  constructor(private readonly pool: DatabasePool) {}
  /** Internal trusted transport port. Callers must authenticate producer/device before invoking.
   * The local binding is rechecked in PG. No HTTP endpoint or paid boolean exists. */
  async acceptCloud(scopeInput: TrustedCloud, input: unknown) {
    const scope = parse(CloudScopeSchema, scopeInput),
      requestHash = digest(input),
      // Own the payload before the first await; a caller cannot mutate passthrough
      // snapshot fields after their hash was checked.
      command = parse(CloudCommandSchema, JSON.parse(JSON.stringify(input)));
    if (command.payload.branchId !== scope.branchId) fail('FORBIDDEN');
    if ('snapshot' in command.payload) {
      const snapshot = command.payload.snapshot;
      if (snapshot.branchId !== scope.branchId || snapshot.organizationId !== scope.organizationId)
        fail('FORBIDDEN');
      if (digest(snapshot) !== command.payload.quoteDigest) fail('CONFLICT');
    }
    return transaction(this.pool, async (client) => {
      const config = await boundary(client, scope);
      await lock(client, 'fulfillment:inbox:' + scope.producerId + ':' + command.eventId);
      const saved = (
        await client.query<{ request_hash: string; result: ReturnType<typeof view> }>(
          'SELECT request_hash,result FROM fulfillment_inbox WHERE producer_id=$1 AND event_id=$2',
          [scope.producerId, command.eventId],
        )
      ).rows[0];
      if (saved) {
        if (saved.request_hash !== requestHash) fail('CONFLICT');
        return saved.result;
      }
      const payload = command.payload;
      await lock(client, 'fulfillment:order:' + payload.orderId);
      let row: Reservation;
      if (command.type === 'edge.admission_requested') {
        const p = command.payload;
        const existing = (
          await client.query<Reservation>(
            'SELECT * FROM fulfillment_reservations WHERE order_id=$1 FOR UPDATE',
            [p.orderId],
          )
        ).rows[0];
        const ownerHash = digest({
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          deviceId: scope.deviceId,
          owner: 'cloud',
          orderId: p.orderId,
          quoteId: p.quoteId,
          quoteDigest: p.quoteDigest,
        });
        if (existing) {
          if (
            existing.commercial_owner !== 'cloud' ||
            existing.owner_hash !== ownerHash ||
            ['cancelled', 'released'].includes(existing.state)
          )
            fail('CONFLICT');
          row = existing;
        } else {
          const branch = (
            await client.query('SELECT ordering_enabled FROM branch_config WHERE id=$1 FOR SHARE', [
              scope.branchId,
            ])
          ).rows[0];
          if (!branch?.ordering_enabled) fail('NOT_READY');
          const stored = (
            await client.query(
              'SELECT payload FROM fulfillment_routing WHERE branch_id=$1 AND version=$2',
              [scope.branchId, config.active_routing_version],
            )
          ).rows[0];
          if (!stored) fail('ROUTING_MISSING');
          const routing = parse(RoutingSchema, stored.payload),
            plan = taskPlan(p.snapshot, routing);
          // A quote may not reserve two commercial order IDs, even on concurrent deliveries.
          await lock(client, 'fulfillment:quote:' + scope.branchId + ':' + p.quoteId);
          if (
            (
              await client.query(
                'SELECT 1 FROM fulfillment_reservations WHERE branch_id=$1 AND quote_id=$2',
                [scope.branchId, p.quoteId],
              )
            ).rowCount
          )
            fail('CONFLICT');
          row = (
            await client.query<Reservation>(
              `INSERT INTO fulfillment_reservations(order_id,branch_id,reservation_id,quote_id,quote_hash,owner_hash,commercial_owner,fulfillment_owner,device_id,snapshot,routing_version,task_plan,assembly_station_id,state) VALUES($1,$2,$3,$4,$5,$6,'cloud','edge',$7,$8,$9,$10,$11,'held') RETURNING *`,
              [
                p.orderId,
                scope.branchId,
                randomUUID(),
                p.quoteId,
                p.quoteDigest,
                ownerHash,
                scope.deviceId,
                p.snapshot,
                routing.version,
                JSON.stringify(plan),
                routing.assemblyStationId,
              ],
            )
          ).rows[0]!;
          await emit(client, row, 'edge.admission_reserved');
        }
      } else {
        row = await order(client, scope.branchId, payload.orderId);
        if (
          row.commercial_owner !== 'cloud' ||
          !('reservationId' in payload) ||
          row.reservation_id !== payload.reservationId ||
          row.quote_hash !== payload.quoteDigest ||
          row.device_id !== scope.deviceId
        )
          fail('CONFLICT');
        if (command.type === 'edge.kitchen_admission_requested') {
          if (command.payload.deviceId !== scope.deviceId) fail('FORBIDDEN');
          if (row.state !== 'held') {
            if (
              !row.authorized_event_id ||
              ['released', 'cancel_requested', 'cancelled'].includes(row.state)
            )
              fail('CONFLICT');
            // A second transport event ID still cannot create a second execution.
          } else {
            row = (
              await client.query<Reservation>(
                `UPDATE fulfillment_reservations SET state='accepted',version=version+1,display_number=nextval('fulfillment_display_sequence'),business_day=(clock_timestamp() AT TIME ZONE 'Asia/Almaty')::date,authorized_event_id=$2,updated_at=clock_timestamp() WHERE order_id=$1 RETURNING *`,
                [row.order_id, command.eventId],
              )
            ).rows[0]!;
            await client.query(
              `INSERT INTO fulfillment_tasks(id,branch_id,order_id,component_key,station_id,routing_version,kind,details) SELECT gen_random_uuid(),$1,$2,p->>'componentKey',(p->>'stationId')::uuid,$3,p->>'kind',p->'details' FROM jsonb_array_elements($4::jsonb) p`,
              [row.branch_id, row.order_id, row.routing_version, JSON.stringify(row.task_plan)],
            );
            await emit(client, row, 'edge.fulfillment_accepted');
          }
        } else {
          const p = command.payload;
          if (row.version !== p.expectedVersion) fail('CONFLICT');
          if (command.type === 'edge.admission_release_requested') {
            if (row.state !== 'held') fail('NOT_READY');
            row = await advance(client, row, 'released', 'edge.admission_released', {
              reason: p.reason,
            });
          } else {
            if (!['held', 'accepted', 'in_production'].includes(row.state)) fail('NOT_READY');
            const all = await tasks(client, row);
            const started = all.some((t) => t.state !== 'queued');
            await client.query(
              `UPDATE fulfillment_tasks SET state=CASE WHEN state='in_progress' THEN 'cancel_requested' ELSE 'cancelled' END,version=version+1,updated_at=clock_timestamp() WHERE order_id=$1 AND state IN ('queued','in_progress')`,
              [row.order_id],
            );
            row = (
              await client.query<Reservation>(
                `UPDATE fulfillment_reservations SET state=$2,cancellation_reason=$3,version=version+1,updated_at=clock_timestamp() WHERE order_id=$1 RETURNING *`,
                [row.order_id, started ? 'cancel_requested' : 'cancelled', p.reason],
              )
            ).rows[0]!;
            await emit(
              client,
              row,
              started ? 'edge.cancellation_requested' : 'edge.fulfillment_cancelled',
              { reason: p.reason, inventoryEffect: 'none' },
            );
          }
        }
      }
      const result = view(row);
      await client.query(
        'INSERT INTO fulfillment_inbox(branch_id,producer_id,event_id,event_type,request_hash,result) VALUES($1,$2,$3,$4,$5,$6)',
        [scope.branchId, scope.producerId, command.eventId, command.type, requestHash, result],
      );
      return result;
    });
  }

  /** Protocol v2 internal release: deterministic domain decisions get immutable
   * results. Database errors and unknown COMMIT outcomes never become rejections. */
  async acceptRelease(scopeInput: TrustedCloud, input: unknown): Promise<ReleaseResult> {
    const scope = parse(CloudScopeSchema, scopeInput),
      command = parse(ReleaseCommandSchema, JSON.parse(JSON.stringify(input))),
      requestHash = digest(command);
    if (command.payload.branchId !== scope.branchId) fail('FORBIDDEN');
    return transaction(this.pool, async (client) => {
      await boundary(client, scope);
      await lock(client, 'fulfillment:inbox:' + scope.producerId + ':' + command.eventId);
      const saved = (
        await client.query<{ request_hash: string; result: ReleaseResult }>(
          'SELECT request_hash,result FROM fulfillment_release_results WHERE producer_id=$1 AND event_id=$2',
          [scope.producerId, command.eventId],
        )
      ).rows[0];
      if (saved) {
        if (saved.request_hash !== requestHash) fail('CONFLICT');
        return ReleaseResultSchema.parse(saved.result);
      }
      // A pre-v2 inbox says it was applied, but has no original durable decision.
      // Do not invent a result using a later order version.
      if (
        (
          await client.query(
            'SELECT 1 FROM fulfillment_inbox WHERE producer_id=$1 AND event_id=$2',
            [scope.producerId, command.eventId],
          )
        ).rowCount
      )
        fail('CONFLICT');
      await lock(client, 'fulfillment:order:' + command.payload.orderId);
      let row = await order(client, scope.branchId, command.payload.orderId);
      const p = command.payload;
      if (
        row.commercial_owner !== 'cloud' ||
        row.reservation_id !== p.reservationId ||
        row.quote_hash !== p.quoteDigest ||
        row.device_id !== scope.deviceId
      )
        fail('CONFLICT');
      const rejectionCode =
        row.version !== p.expectedVersion
          ? 'VERSION_CONFLICT'
          : row.state !== 'held'
            ? 'NOT_HELD'
            : null;
      if (!rejectionCode)
        row = await advance(client, row, 'released', 'edge.admission_released', {
          reason: p.reason,
        });
      const result = ReleaseResultSchema.parse({
        ...view(row),
        requestEventId: command.eventId,
        requestDigest: requestHash,
        outcome: rejectionCode ? 'rejected' : 'applied',
        rejectionCode,
        reason: p.reason,
      });
      const resultEventId = await emit(client, row, 'edge.admission_release_result', result);
      await client.query(
        'INSERT INTO fulfillment_release_results(producer_id,event_id,branch_id,order_id,request_hash,result,result_event_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          scope.producerId,
          command.eventId,
          scope.branchId,
          row.order_id,
          requestHash,
          result,
          resultEventId,
        ],
      );
      await client.query(
        'INSERT INTO fulfillment_inbox(branch_id,producer_id,event_id,event_type,request_hash,result) VALUES($1,$2,$3,$4,$5,$6)',
        [scope.branchId, scope.producerId, command.eventId, command.type, requestHash, result],
      );
      return result;
    });
  }
  async act(branchId: string, auth: StaffAuth, input: unknown) {
    parse(z.uuid(), branchId);
    const command = parse(StaffCommandSchema, input),
      requestHash = digest(command);
    return transaction(this.pool, async (client) => {
      const staff = await authenticateStaff(client, branchId, auth);
      if (!['kitchen', 'shift_manager'].includes(staff.role)) fail('FORBIDDEN');
      // Commercial cancellation locks branch before reservation. Take the audit
      // FK's key-share lock now as well, never after owning the reservation.
      await client.query('SELECT id FROM branch_config WHERE id=$1 FOR KEY SHARE', [branchId]);
      await lock(
        client,
        'fulfillment:staff:' + branchId + ':' + staff.staff_id + ':' + command.commandId,
      );
      const saved = (
        await client.query<{ request_hash: string; result: ReturnType<typeof view> }>(
          'SELECT request_hash,result FROM fulfillment_commands WHERE branch_id=$1 AND staff_id=$2 AND command_id=$3',
          [branchId, staff.staff_id, command.commandId],
        )
      ).rows[0];
      if (saved) {
        if (saved.request_hash !== requestHash) fail('CONFLICT');
        return saved.result;
      }
      let row = await order(client, branchId, command.orderId);
      if (row.version !== command.expectedVersion) fail('CONFLICT');
      if (['start_task', 'complete_task', 'confirm_stop'].includes(command.action)) {
        if (!command.taskId || !command.expectedTaskVersion) fail('INVALID');
        const task =
          (
            await client.query<Task>(
              'SELECT * FROM fulfillment_tasks WHERE id=$1 AND order_id=$2 AND branch_id=$3 FOR UPDATE',
              [command.taskId, row.order_id, branchId],
            )
          ).rows[0] ?? fail('NOT_FOUND');
        await stationPermission(client, branchId, staff, task.station_id);
        if (task.version !== command.expectedTaskVersion) fail('CONFLICT');
        let state: Task['state'];
        if (command.action === 'confirm_stop') {
          if (row.state !== 'cancel_requested' || task.state !== 'cancel_requested')
            fail('NOT_READY');
          state = 'cancelled';
        } else {
          if (!['accepted', 'in_production'].includes(row.state)) fail('NOT_READY');
          if (command.action === 'start_task') {
            if (task.state !== 'queued') fail('NOT_READY');
            state = 'in_progress';
          } else {
            if (task.state !== 'in_progress') fail('NOT_READY');
            state = 'done';
          }
        }
        await client.query(
          'UPDATE fulfillment_tasks SET state=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1',
          [task.id, state],
        );
        row = await advance(
          client,
          row,
          command.action === 'confirm_stop' ? 'cancel_requested' : 'in_production',
          'edge.task_changed',
          {
            taskId: task.id,
            taskVersion: task.version + 1,
            taskState: state,
            stationId: task.station_id,
            staffId: staff.staff_id,
          },
        );
      } else {
        if (command.taskId || command.expectedTaskVersion) fail('INVALID');
        if (command.action === 'confirm_cancel') {
          if (staff.role !== 'shift_manager') fail('FORBIDDEN');
          if (row.state !== 'cancel_requested' || !command.reason || !command.inventoryDisposition)
            fail('NOT_READY');
          if (
            (await tasks(client, row)).some((t) =>
              ['queued', 'in_progress', 'cancel_requested'].includes(t.state),
            )
          )
            fail('NOT_READY');
          row = (
            await client.query<Reservation>(
              `UPDATE fulfillment_reservations SET state='cancelled',version=version+1,cancellation_reason=$2,inventory_disposition=$3,updated_at=clock_timestamp() WHERE order_id=$1 RETURNING *`,
              [row.order_id, command.reason, command.inventoryDisposition],
            )
          ).rows[0]!;
          await emit(client, row, 'edge.fulfillment_cancelled', {
            reason: command.reason,
            inventoryDisposition: command.inventoryDisposition,
            inventoryEffect: 'none',
            staffId: staff.staff_id,
          });
        } else {
          await stationPermission(client, branchId, staff, row.assembly_station_id);
          if (command.action === 'ready') {
            if (!['accepted', 'in_production'].includes(row.state)) fail('NOT_READY');
            const all = await tasks(client, row);
            if (!all.length || all.some((t) => t.state !== 'done')) fail('NOT_READY');
            row = await advance(client, row, 'ready', 'edge.fulfillment_ready', {
              staffId: staff.staff_id,
            });
          } else {
            if (row.state !== 'ready') fail('NOT_READY');
            row = await advance(client, row, 'handed_over', 'edge.fulfillment_handed_over', {
              staffId: staff.staff_id,
            });
          }
        }
      }
      await audit(client, branchId, staff.staff_id, 'fulfillment.' + command.action, row.order_id);
      const result = view(row);
      await client.query(
        'INSERT INTO fulfillment_commands(branch_id,staff_id,command_id,request_hash,result) VALUES($1,$2,$3,$4,$5)',
        [branchId, staff.staff_id, command.commandId, requestHash, result],
      );
      return result;
    });
  }

  async readOrder(branchId: string, auth: StaffAuth, orderId: string, input: unknown = {}) {
    parse(z.uuid(), branchId);
    parse(z.uuid(), orderId);
    const q = parse(z.strictObject({ stationId: z.uuid().optional() }), input);
    return transaction(this.pool, async (client) => {
      // Start the MVCC snapshot before authentication. Existing staff/grant
      // share locks keep revocation semantics; orders/tasks are never locked.
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const staff = await authenticateStaff(client, branchId, auth);
      if (q.stationId) await stationPermission(client, branchId, staff, q.stationId);
      await client.query('SET TRANSACTION READ ONLY');
      const row = await readReservation(client, branchId, orderId);
      const allTasks = await tasks(client, row);
      // Station membership is pinned to this order, including its assembly-only
      // responsibility and terminal tasks. Never infer it from active routing.
      if (
        q.stationId &&
        row.assembly_station_id !== q.stationId &&
        !allTasks.some((task) => task.station_id === q.stationId)
      )
        fail('FORBIDDEN');
      return {
        ...view(row),
        channel: row.snapshot.channel,
        serviceMode: row.snapshot.serviceMode,
        tasks: allTasks,
        cancellationReason: row.cancellation_reason,
        inventoryDisposition: row.inventory_disposition,
      };
    });
  }
  /** Paginated full queue: no fixed first-100 truncation or customer snapshot. */
  async listKitchen(branchId: string, auth: StaffAuth, input: unknown = {}) {
    parse(z.uuid(), branchId);
    const q = parse(
      z.strictObject({
        afterOrderId: z.uuid().optional(),
        limit: z.int().min(1).max(100).default(50),
        stationId: z.uuid().optional(),
      }),
      input,
    );
    return transaction(this.pool, async (client) => {
      // Start the MVCC snapshot before authentication. Existing staff/grant
      // share locks keep revocation semantics; orders/tasks are never locked.
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const staff = await authenticateStaff(client, branchId, auth);
      if (!['kitchen', 'shift_manager'].includes(staff.role)) fail('FORBIDDEN');
      if (q.stationId) await stationPermission(client, branchId, staff, q.stationId);
      await client.query('SET TRANSACTION READ ONLY');
      // Fetch identities first, then one bounded order projection at a time.
      // A large combo order must not multiply the response by a 100-row page.
      const candidates = (
        await client.query<{ order_id: string }>(
          `SELECT r.order_id FROM fulfillment_reservations r WHERE branch_id=$1 AND state IN ('accepted','in_production','ready','cancel_requested') AND ($2::uuid IS NULL OR order_id>$2) AND ($4::uuid IS NULL OR r.assembly_station_id=$4 OR EXISTS(SELECT 1 FROM fulfillment_tasks t WHERE t.order_id=r.order_id AND t.station_id=$4)) ORDER BY order_id LIMIT $3`,
          [branchId, q.afterOrderId ?? null, q.limit + 1, q.stationId ?? null],
        )
      ).rows;
      const items = [];
      let bytes = 0;
      for (const candidate of candidates.slice(0, q.limit)) {
        // IDs, state/version and tasks belong to the same read-only snapshot.
        // Concurrent ready/handoff/cancel becomes visible on the next poll.
        const row = await readReservation(client, branchId, candidate.order_id);
        const item = {
          ...view(row),
          channel: row.snapshot.channel,
          serviceMode: row.snapshot.serviceMode,
          tasks: await tasks(client, row),
        };
        const size = Buffer.byteLength(JSON.stringify(item));
        if (items.length && bytes + size > 2_097_152) break;
        items.push(item);
        bytes += size;
      }
      return {
        items,
        nextAfterOrderId: candidates.length > items.length ? items.at(-1)!.orderId : null,
      };
    });
  }
  /** Safe projection for a future branch-bound display adapter; never expose another API view. */
  async readDisplay(branchId: string, input: unknown = {}) {
    parse(z.uuid(), branchId);
    const q = parse(
      z.strictObject({
        afterNumber: z
          .string()
          .regex(/^[0-9]{1,19}$/)
          .refine((value) => /^[0-9]{1,19}$/.test(value) && BigInt(value) <= 9223372036854775807n)
          .default('0'),
        limit: z.int().min(1).max(100).default(50),
      }),
      input,
    );
    const rows = (
      await this.pool.query<{ display_number: string; state: State; display_name: string }>(
        `SELECT display_number,state,left(coalesce(snapshot->>'displayName',''),14) AS display_name FROM fulfillment_reservations WHERE branch_id=$1 AND state IN ('accepted','in_production','ready') AND display_number>$2::bigint ORDER BY display_number LIMIT $3`,
        [branchId, q.afterNumber, q.limit + 1],
      )
    ).rows;
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((r) => ({
        number: r.display_number,
        ...(r.display_name ? { name: r.display_name } : {}),
        state: r.state === 'ready' ? 'ready' : 'preparing',
      })),
      nextAfterNumber: rows.length > q.limit ? page.at(-1)!.display_number : null,
    };
  }
  async claimOutbox(scope: TrustedCloud, input: unknown) {
    const req = parse(LeaseSchema, input);
    return transaction(this.pool, async (client) => {
      await boundary(client, scope);
      return (
        await client.query(
          `WITH chosen AS (SELECT event_id FROM fulfillment_outbox WHERE branch_id=$1 AND EXISTS(SELECT 1 FROM fulfillment_reservations r WHERE r.order_id=fulfillment_outbox.order_id AND r.commercial_owner='cloud') AND acknowledged_at IS NULL AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY sequence LIMIT $2 FOR UPDATE SKIP LOCKED) UPDATE fulfillment_outbox o SET lease_worker=$3,lease_token=$4,lease_until=clock_timestamp()+$5*interval '1 second',attempts=attempts+1 FROM chosen c WHERE o.event_id=c.event_id RETURNING o.*`,
          [scope.branchId, req.limit, req.workerId, randomUUID(), req.leaseSeconds],
        )
      ).rows;
    });
  }
  async acknowledgeOutbox(scope: TrustedCloud, input: unknown) {
    const req = parse(AckSchema, input);
    return transaction(this.pool, async (client) => {
      await boundary(client, scope);
      const row =
        (
          await client.query(
            "SELECT * FROM fulfillment_outbox WHERE event_id=$1 AND branch_id=$2 AND EXISTS(SELECT 1 FROM fulfillment_reservations r WHERE r.order_id=fulfillment_outbox.order_id AND r.commercial_owner='cloud') FOR UPDATE",
            [req.eventId, scope.branchId],
          )
        ).rows[0] ?? fail('NOT_FOUND');
      if (row.lease_worker !== req.workerId || row.lease_token !== req.leaseToken) fail('CONFLICT');
      if (row.acknowledged_at) return { acknowledged: true };
      const changed = await client.query(
        'UPDATE fulfillment_outbox SET acknowledged_at=clock_timestamp() WHERE event_id=$1 AND lease_until>clock_timestamp() RETURNING event_id',
        [req.eventId],
      );
      if (!changed.rowCount) fail('CONFLICT');
      return { acknowledged: true };
    });
  }
}
