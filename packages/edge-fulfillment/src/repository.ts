import { restoreReview } from './restore-review.js';
import { effectiveLocalStops, lineStopIds } from '@pickchick/local-orders';
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
  FulfillmentError,
  LeaseSchema,
  AckSchema,
  CourierIncidentInputSchema,
  CourierIncidentQuerySchema,
} from './model.js';
import type { TrustedCloud } from './model.js';
import { buildKitchenPlan } from './kds-plan.js';
import { readKdsLayout, readMenuKdsSlugs } from './kds-layout.js';
import { KDS_STATIONS, cloudKdsSlugs, kdsFunctionKind, noKdsSlugs } from './kds.js';
import type { KdsSlugs } from './kds.js';

import {
  acceptsWork,
  checkVersion,
  commandShape,
  guardConfirmCancel,
  planCompleteStation,
  planConfirmCancel,
  planHandoff,
  planReady,
  planTask,
  replayDecision,
} from '@pickchick/fulfillment-state';
import type { Decision, Step, TaskSnapshot } from '@pickchick/fulfillment-state';
import { view, emit, advance, allocateDisplayNumber } from './records.js';
import type { Reservation, Task, State } from './records.js';
const fail = (code: ConstructorParameters<typeof FulfillmentError>[0]): never => {
  throw new FulfillmentError(code);
};
const decided = <T>(decision: Decision<T>): T =>
  decision.ok ? decision.value : fail(decision.code);
const snapshot = (task: Task): TaskSnapshot => ({
  id: task.id,
  stationId: task.station_id,
  state: task.state,
  version: task.version,
  // Pinned at admission by a KDS plan only (toasts of a table); absent on every other task.
  ...(task.details.kds?.upstreamOf ? { upstreamOf: task.details.kds.upstreamOf } : {}),
});
/** KDS task details and the delivery mark leave the edge only while the layout is enabled. */
const withoutKds = (task: Task): Task => {
  if (!task.details.kds) return task;
  const { kds, ...details } = task.details;
  void kds;
  return { ...task, details };
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
/**
 * The courier handover journal row (027 delivery_handovers) of a delivery handoff, in the same
 * transaction as its handed_over step: the aggregator and number of the order, the station that
 * finished it, who handed it over on which screen, and the command (Idempotency-Key). A replay
 * of the command returns its stored result before reaching this point; another command of the
 * same order cannot get here (the order is handed_over), and a reused key conflicts.
 */
async function recordHandover(
  client: DatabaseClient,
  row: Reservation,
  staff: { staff_id: string; terminal_id: string },
  commandId: string,
  delivery: NonNullable<Reservation['snapshot']['delivery']>,
) {
  if (
    (
      await client.query('SELECT 1 FROM delivery_handovers WHERE command_id=$1 OR order_id=$2', [
        commandId,
        row.order_id,
      ])
    ).rowCount
  )
    fail('CONFLICT');
  await client.query(
    `INSERT INTO delivery_handovers(order_id,branch_id,command_id,provider,external_number,number_matched,courier_accepted,photo_taken,station_id,staff_id,terminal_id)
     VALUES($1,$2,$3,$4,$5,true,true,true,$6,$7,$8)`,
    [
      row.order_id,
      row.branch_id,
      commandId,
      delivery.provider,
      delivery.externalNumber,
      row.assembly_station_id,
      staff.staff_id,
      staff.terminal_id,
    ],
  );
}

/**
 * P0 rule of the "Менеджер вызван" banner (no incident statuses before P1 028): an incident is
 * open for this many minutes after it was recorded, while its order (if any) is still live.
 */
export const COURIER_INCIDENT_OPEN_MINUTES = 30;
interface IncidentRow {
  incident_id: string;
  branch_id: string;
  provider: 'yandex_eda' | 'glovo' | 'other';
  claimed_number: string | null;
  kind: 'number_mismatch' | 'not_accepted_in_app' | 'no_photo' | 'courier_refused' | 'other';
  description: string;
  staff_id: string;
  terminal_id: string;
  request_hash: string;
  recorded_at: Date;
  display_number: string | null;
}
const INCIDENT_SELECT = `SELECT i.incident_id,i.branch_id,i.provider,i.claimed_number,i.kind,i.description,
  i.staff_id,i.terminal_id,i.request_hash,i.recorded_at,r.display_number
  FROM courier_incidents i LEFT JOIN fulfillment_reservations r
  ON r.branch_id=i.branch_id AND r.order_id=i.order_id`;
/** CourierIncidentSchema of the contract (contracts section 5.4). */
const incidentView = (row: IncidentRow) => ({
  incidentId: row.incident_id,
  provider: row.provider,
  claimedNumber: row.claimed_number,
  kind: row.kind,
  description: row.description,
  recordedAt: row.recorded_at.toISOString(),
  ...(row.display_number !== null ? { displayNumber: row.display_number } : {}),
});

export class EdgeFulfillment {
  constructor(private readonly pool: DatabasePool) {}
  /** Human kitchen check after restore; never changes the order's canonical state or money. */
  async reviewRestore(branchId: string, auth: StaffAuth, input: unknown) {
    const c = parse(
      z.strictObject({
        commandId: z.uuid(),
        orderId: z.uuid(),
        epoch: z.int().min(2),
        expectedVersion: z.int().positive(),
        decision: z.enum(['resume', 'retire']),
        reason: z.string().trim().min(3).max(500),
      }),
      input,
    );
    return transaction(this.pool, async (client) => {
      const staff = await authenticateStaff(client, branchId, auth);
      if (staff.role !== 'shift_manager') fail('FORBIDDEN');
      await client.query('SELECT id FROM branch_config WHERE id=$1 FOR KEY SHARE', [branchId]);
      await lock(client, 'fulfillment:restore-command:' + c.commandId);
      const row = await order(client, branchId, c.orderId);
      const saved = (
        await client.query('SELECT * FROM fulfillment_restore_decisions WHERE command_id=$1', [
          c.commandId,
        ])
      ).rows[0];
      if (saved) {
        if (
          saved.order_id !== c.orderId ||
          saved.epoch !== c.epoch ||
          saved.staff_id !== staff.staff_id ||
          saved.decision !== c.decision ||
          saved.reason !== c.reason ||
          saved.expected_version !== c.expectedVersion
        )
          fail('CONFLICT');
        return { epoch: c.epoch, status: c.decision };
      }
      const review = await restoreReview(client, row);
      if (
        !review ||
        review.epoch !== c.epoch ||
        review.status !== 'pending' ||
        row.version !== c.expectedVersion
      )
        fail('CONFLICT');
      // Cloud-owned execution needs reconciliation with the cloud authority first.
      // A local human click alone cannot safely re-emit its lost versions or issue it twice.
      if (c.decision === 'resume' && row.commercial_owner !== 'edge_pos') fail('NOT_READY');
      await client.query(
        `INSERT INTO fulfillment_restore_decisions(epoch,order_id,command_id,staff_id,decision,reason,expected_version)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [c.epoch, c.orderId, c.commandId, staff.staff_id, c.decision, c.reason, c.expectedVersion],
      );
      await audit(
        client,
        branchId,
        staff.staff_id,
        'fulfillment.restore_' + c.decision,
        row.order_id,
      );
      return { epoch: c.epoch, status: c.decision };
    });
  }
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
          const stopped = new Set(await effectiveLocalStops(client, scope.branchId));
          // Same combo stop rule as kiosk and mobile: chosen options, the products they point
          // to and the fixed components of a combo stop the line too.
          for (const line of p.snapshot.lines) {
            const ids = lineStopIds(scope.branchId, {
              productId: line.productId,
              selections: (line.selectedDetails?.modifiers ?? []).map((m) => ({
                group_id: m.groupId,
                option_id: m.optionId,
                linked_product_id: m.linkedProductId,
              })),
              componentIds: (line.selectedDetails?.components ?? []).map((c) => c.productId),
            });
            if (ids.some((id) => stopped.has(id)) || stopped.has(line.productId))
              throw new FulfillmentError('NOT_READY', 'ITEM_STOPPED');
          }
          const stored = (
            await client.query(
              'SELECT payload FROM fulfillment_routing WHERE branch_id=$1 AND version=$2',
              [scope.branchId, config.active_routing_version],
            )
          ).rows[0];
          if (!stored) fail('ROUTING_MISSING');
          const routing = parse(RoutingSchema, stored.payload);
          // Contracts section 5.2: the same seam as the cashier path. Layout off: exactly
          // taskPlan(snapshot, routing) and routing.assemblyStationId.
          const kitchen = await buildKitchenPlan(client, {
            branchId: scope.branchId,
            snapshot: p.snapshot,
            routing,
          });
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
          // Reserved before payment; all numbers taken leaves a legacy unnumbered hold.
          const number = await allocateDisplayNumber(client, scope.branchId);
          row = (
            await client.query<Reservation>(
              `INSERT INTO fulfillment_reservations(order_id,branch_id,reservation_id,quote_id,quote_hash,owner_hash,commercial_owner,fulfillment_owner,device_id,snapshot,routing_version,task_plan,assembly_station_id,state,display_number,business_day) VALUES($1,$2,$3,$4,$5,$6,'cloud','edge',$7,$8,$9,$10,$11,'held',$12::bigint,CASE WHEN $12::bigint IS NULL THEN NULL ELSE (clock_timestamp() AT TIME ZONE 'Asia/Almaty')::date END) RETURNING *`,
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
                JSON.stringify(kitchen.plan),
                kitchen.assemblyStationId,
                number,
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
            const number =
              row.display_number ?? (await allocateDisplayNumber(client, row.branch_id));
            if (number === null) fail('NOT_READY');
            row = (
              await client.query<Reservation>(
                `UPDATE fulfillment_reservations SET state='accepted',version=version+1,display_number=COALESCE(display_number,$3::bigint),business_day=COALESCE(business_day,(clock_timestamp() AT TIME ZONE 'Asia/Almaty')::date),authorized_event_id=$2,updated_at=clock_timestamp() WHERE order_id=$1 RETURNING *`,
                [row.order_id, command.eventId, number],
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
      const replay = replayDecision(saved?.request_hash, requestHash);
      if (replay === 'conflict') fail('CONFLICT');
      if (replay === 'replay') return saved!.result;
      let row = await order(client, branchId, command.orderId);
      const restored = await restoreReview(client, row);
      if (restored && restored.status !== 'resume') fail('NOT_READY');
      decided(checkVersion(row.version, command.expectedVersion));
      const shape = decided(commandShape(command));
      // Courier marks belong to a handoff only (the HTTP schema already says so).
      if (command.handover && command.action !== 'handoff') fail('INVALID');
      // Each pure step is one aggregate version and one event; task steps also bump the task.
      const apply = async (steps: Step[]) => {
        for (const step of steps) {
          if (step.kind === 'task') {
            await client.query(
              'UPDATE fulfillment_tasks SET state=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1',
              [step.taskId, step.to],
            );
            row = await advance(client, row, step.order, 'edge.task_changed', {
              taskId: step.taskId,
              taskVersion: step.taskVersion,
              taskState: step.to,
              stationId: step.stationId,
              staffId: staff.staff_id,
            });
          } else if (step.event === 'ready') {
            row = await advance(client, row, 'ready', 'edge.fulfillment_ready', {
              staffId: staff.staff_id,
            });
          } else if (step.event === 'handed_over') {
            row = await advance(client, row, 'handed_over', 'edge.fulfillment_handed_over', {
              staffId: staff.staff_id,
            });
          } else {
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
          }
        }
      };
      if (shape.kind === 'station') {
        await stationPermission(client, branchId, staff, shape.stationId);
        if (!acceptsWork(row.state)) fail('NOT_READY');
        // The aggregate row is locked. All task changes, events, audit and the
        // one command receipt commit together; no HTTP loop or partial ticket.
        await apply(
          decided(
            planCompleteStation({
              order: row.state,
              assemblyStationId: row.assembly_station_id,
              stationId: shape.stationId,
              tasks: (await tasks(client, row)).map(snapshot),
            }),
          ),
        );
      } else if (shape.kind === 'task') {
        const task =
          (
            await client.query<Task>(
              'SELECT * FROM fulfillment_tasks WHERE id=$1 AND order_id=$2 AND branch_id=$3 FOR UPDATE',
              [shape.taskId, row.order_id, branchId],
            )
          ).rows[0] ?? fail('NOT_FOUND');
        await stationPermission(client, branchId, staff, task.station_id);
        await apply(
          decided(
            planTask({
              action: shape.action,
              order: row.state,
              task: snapshot(task),
              expectedTaskVersion: shape.expectedTaskVersion,
            }),
          ),
        );
      } else if (shape.action === 'confirm_cancel') {
        const cancel = {
          order: row.state,
          manager: staff.role === 'shift_manager',
          reason: command.reason,
          inventoryDisposition: command.inventoryDisposition,
        };
        decided(guardConfirmCancel(cancel));
        await apply(
          decided(
            planConfirmCancel({ ...cancel, tasks: (await tasks(client, row)).map(snapshot) }),
          ),
        );
      } else {
        await stationPermission(client, branchId, staff, row.assembly_station_id);
        if (shape.action === 'ready') {
          if (!acceptsWork(row.state)) fail('NOT_READY');
          await apply(
            decided(
              planReady({ order: row.state, tasks: (await tasks(client, row)).map(snapshot) }),
            ),
          );
        } else {
          // Courier handover protocol (Аг9, contracts section 5.4): exactly the orders whose
          // kitchen tickets carry `delivery` - an aggregator order while the KDS layout is on.
          // Layout off (or no 027): today's handoff, and marks are refused as before KDS-4.
          const protocol =
            row.snapshot.delivery !== undefined && (await readKdsLayout(client, branchId)).enabled;
          if (command.handover && !protocol) fail('INVALID');
          const steps = decided(planHandoff({ order: row.state }));
          if (protocol && !command.handover)
            throw new FulfillmentError('INVALID', 'HANDOVER_MARKS_REQUIRED');
          await apply(steps);
          if (protocol)
            await recordHandover(client, row, staff, command.commandId, row.snapshot.delivery!);
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
      const kdsOn = (await readKdsLayout(client, branchId)).enabled;
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
        restoreReview: await restoreReview(client, row),
        channel: row.snapshot.channel,
        serviceMode: row.snapshot.serviceMode,
        ...(row.snapshot.kitchenComment ? { kitchenComment: row.snapshot.kitchenComment } : {}),
        ...(kdsOn && row.snapshot.delivery ? { delivery: row.snapshot.delivery } : {}),
        tasks: kdsOn ? allTasks : allTasks.map(withoutKds),
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
      const kdsOn = (await readKdsLayout(client, branchId)).enabled;
      const hasReviews = (
        await client.query("SELECT to_regclass('fulfillment_restore_reviews') IS NOT NULL AS ok")
      ).rows[0].ok;
      const reviewFilter = hasReviews
        ? ` AND NOT EXISTS (
        SELECT 1 FROM fulfillment_restore_reviews rr JOIN fulfillment_restore_decisions d USING(epoch,order_id)
        WHERE rr.order_id=r.order_id AND d.decision='retire' AND rr.epoch=(
          SELECT max(latest.epoch) FROM fulfillment_restore_reviews latest WHERE latest.order_id=r.order_id))`
        : '';
      // Fetch identities first, then one bounded order projection at a time.
      // A large combo order must not multiply the response by a 100-row page.
      const candidates = (
        await client.query<{ order_id: string }>(
          `SELECT r.order_id FROM fulfillment_reservations r WHERE branch_id=$1 AND state IN ('accepted','in_production','ready','cancel_requested') AND ($2::uuid IS NULL OR order_id>$2) AND ($4::uuid IS NULL OR r.assembly_station_id=$4 OR EXISTS(SELECT 1 FROM fulfillment_tasks t WHERE t.order_id=r.order_id AND t.station_id=$4)) ${reviewFilter} ORDER BY order_id LIMIT $3`,
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
          restoreReview: await restoreReview(client, row),
          channel: row.snapshot.channel,
          serviceMode: row.snapshot.serviceMode,
          ...(row.snapshot.kitchenComment ? { kitchenComment: row.snapshot.kitchenComment } : {}),
          ...(kdsOn && row.snapshot.delivery ? { delivery: row.snapshot.delivery } : {}),
          tasks: kdsOn ? await tasks(client, row) : (await tasks(client, row)).map(withoutKds),
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
    const hasReviews = (
      await this.pool.query("SELECT to_regclass('fulfillment_restore_reviews') IS NOT NULL AS ok")
    ).rows[0].ok;
    const reviewFilter = hasReviews
      ? ` AND NOT EXISTS (
      SELECT 1 FROM fulfillment_restore_reviews r LEFT JOIN fulfillment_restore_decisions d USING(epoch,order_id)
      WHERE r.order_id=fulfillment_reservations.order_id AND r.epoch=(SELECT max(latest.epoch)
        FROM fulfillment_restore_reviews latest WHERE latest.order_id=r.order_id)
      AND coalesce(d.decision,'pending')<>'resume')`
      : '';
    const rows = (
      await this.pool.query<{ display_number: string; state: State; display_name: string }>(
        // An order no longer live for edge 022 numbering (untouched for 12 hours, or 'ready' for
        // 3 hours) is off the board: its number may already belong to a new order, and the
        // board never shows one number twice. Aggregator orders (snapshot.delivery, cutover
        // KDS) go to couriers, never to the guest board; the board gets no new key for them.
        `SELECT display_number,state,left(coalesce(snapshot->>'displayName',''),14) AS display_name FROM fulfillment_reservations WHERE branch_id=$1 AND state IN ('accepted','in_production','ready') AND updated_at>clock_timestamp()-CASE WHEN state='ready' THEN interval '3 hours' ELSE interval '12 hours' END AND display_number>$2::bigint AND snapshot->'delivery' IS NULL ${reviewFilter} ORDER BY display_number LIMIT $3`,
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
  /**
   * GET fulfillment/layout (contracts section 5.4). {enabled:false}: the old kitchen screen.
   * screens: the layout stations of the session's terminal (0..2, tabs); a managed terminal only
   * opens stations of its own mode.
   */
  async readLayout(branchId: string, auth: StaffAuth, terminalMode?: 'prep' | 'assembly') {
    parse(z.uuid(), branchId);
    return transaction(this.pool, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const staff = await authenticateStaff(client, branchId, auth);
      if (!['kitchen', 'shift_manager'].includes(staff.role)) fail('FORBIDDEN');
      await client.query('SET TRANSACTION READ ONLY');
      const kds = await readKdsLayout(client, branchId);
      if (!kds.enabled) return { enabled: false as const };
      const names = new Map(
        (
          await client.query<{ id: string; name: string }>(
            'SELECT id,name FROM fulfillment_stations WHERE branch_id=$1 AND id=ANY($2::uuid[])',
            [branchId, kds.layout.stations.map((s) => s.edge_station_id)],
          )
        ).rows.map((row) => [row.id, row.name]),
      );
      return {
        enabled: true as const,
        layoutVersion: kds.version,
        mode: kds.mode,
        stations: kds.layout.stations.map((s) => ({
          id: s.edge_station_id,
          function: s.function,
          name:
            names.get(s.edge_station_id) ??
            KDS_STATIONS.find((spec) => spec.function === s.function)!.name,
          kind: kdsFunctionKind(s.function),
        })),
        screens: kds.layout.stations
          .filter(
            (s) =>
              s.terminal_ids.includes(staff.terminal_id) &&
              (!terminalMode || kdsFunctionKind(s.function) === terminalMode),
          )
          .map((s) => s.edge_station_id)
          .slice(0, 2),
      };
    });
  }
  /**
   * GET fulfillment/kds/breading (contracts section 5.4, КД4): station 6 has no tasks; its screen
   * is a projection of the open table tasks whose product the layout lists for breading (or that
   * carry pinned fingers). Oldest order first; only orders the kitchen may work on. Fingers only
   * when the layout counts them. NOT_FOUND while the layout is off or has no breading station.
   */
  async readBreading(branchId: string, auth: StaffAuth, input: unknown = {}) {
    parse(z.uuid(), branchId);
    const q = parse(z.strictObject({ limit: z.int().min(1).max(100).default(50) }), input);
    return transaction(this.pool, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const staff = await authenticateStaff(client, branchId, auth);
      if (!['kitchen', 'shift_manager'].includes(staff.role)) fail('FORBIDDEN');
      const kds = await readKdsLayout(client, branchId);
      const station = kds.enabled
        ? kds.layout.stations.find((s) => s.function === 'breading')
        : undefined;
      if (!station) return fail('NOT_FOUND');
      await stationPermission(client, branchId, staff, station.edge_station_id);
      await client.query('SET TRANSACTION READ ONLY');
      const hasReviews = (
        await client.query("SELECT to_regclass('fulfillment_restore_reviews') IS NOT NULL AS ok")
      ).rows[0].ok;
      // As the guest board: a restored order counts only once the manager resumed it.
      const reviewFilter = hasReviews
        ? ` AND NOT EXISTS (
        SELECT 1 FROM fulfillment_restore_reviews rr LEFT JOIN fulfillment_restore_decisions d USING(epoch,order_id)
        WHERE rr.order_id=r.order_id AND rr.epoch=(SELECT max(latest.epoch)
          FROM fulfillment_restore_reviews latest WHERE latest.order_id=r.order_id)
        AND coalesce(d.decision,'pending')<>'resume')`
        : '';
      const open = `t.branch_id=r.branch_id AND t.order_id=r.order_id AND t.state IN ('queued','in_progress')
        AND t.details->'kds'->>'function' IN ('assembly_hall','assembly_delivery')`;
      const orders = (
        await client.query<{
          order_id: string;
          display_number: string | null;
          snapshot: { channel: string; serviceMode: 'takeaway' | 'dine_in'; delivery?: unknown };
        }>(
          `SELECT r.order_id,r.display_number,r.snapshot FROM fulfillment_reservations r
           WHERE r.branch_id=$1 AND r.state IN ('accepted','in_production')
           AND EXISTS(SELECT 1 FROM fulfillment_tasks t WHERE ${open}) ${reviewFilter}
           ORDER BY r.created_at,r.order_id LIMIT 500`,
          [branchId],
        )
      ).rows;
      const breaded = new Set(station.product_ids);
      let cashierSlugs: KdsSlugs | null | undefined;
      const result = [];
      let total = 0,
        counted = Boolean(station.counts?.length);
      for (const row of orders) {
        if (result.length >= q.limit) break;
        let slugs = cloudKdsSlugs;
        if (row.snapshot.channel === 'pos') {
          if (cashierSlugs === undefined) cashierSlugs = await readMenuKdsSlugs(client, branchId);
          slugs = cashierSlugs ?? noKdsSlugs;
        }
        const lines = (
          await client.query<{ details: Task['details'] }>(
            `SELECT t.details FROM fulfillment_tasks t JOIN fulfillment_reservations r
             ON r.branch_id=t.branch_id AND r.order_id=t.order_id WHERE r.order_id=$1 AND ${open}
             ORDER BY t.component_key`,
            [row.order_id],
          )
        ).rows
          .map((task) => task.details)
          .filter((details) => {
            const slug = slugs.product(details.productId);
            return (slug !== null && breaded.has(slug)) || details.kds?.fingers !== undefined;
          })
          .map((details) => ({
            title: details.title,
            quantity: details.quantity,
            ...(details.kds?.fingers !== undefined ? { fingers: details.kds.fingers } : {}),
          }));
        if (!lines.length) continue;
        const fingers = lines.reduce((sum, line) => sum + (line.fingers ?? 0), 0);
        if (lines.some((line) => line.fingers !== undefined)) counted = true;
        total += fingers;
        result.push({
          orderId: row.order_id,
          displayNumber: row.display_number,
          serviceMode: row.snapshot.serviceMode,
          ...(row.snapshot.delivery ? { delivery: row.snapshot.delivery } : {}),
          lines,
          ...(fingers > 0 ? { fingers } : {}),
        });
      }
      return { orders: result, ...(counted ? { totalFingers: total } : {}) };
    });
  }
  /**
   * POST fulfillment/incidents (contracts section 5.4, Аг9): a courier protocol refusal, recorded
   * at the courier counter (the order's finishing station, else station 3 of the layout, else 2)
   * by a kitchen login with access to that station or a shift manager. incidentId is the
   * client's Idempotency-Key: the same staff, terminal and request replay the stored record,
   * anything else under that id conflicts. The claimed number is stored upper-case like the
   * aggregator numbers. Insert-only journal, no outbox event (cloud report: P1).
   * NOT_FOUND while the KDS layout is off.
   */
  async recordIncident(branchId: string, auth: StaffAuth, incidentId: string, input: unknown) {
    parse(z.uuid(), branchId);
    const id = parse(z.uuid(), incidentId),
      request = parse(CourierIncidentInputSchema, input);
    const incident = {
      ...(request.orderId ? { orderId: request.orderId } : {}),
      provider: request.provider,
      ...(request.claimedNumber ? { claimedNumber: request.claimedNumber.toUpperCase() } : {}),
      kind: request.kind,
      description: request.description,
    };
    const requestHash = digest(incident);
    return transaction(this.pool, async (client) => {
      const staff = await authenticateStaff(client, branchId, auth);
      if (!['kitchen', 'shift_manager'].includes(staff.role)) fail('FORBIDDEN');
      const kds = await readKdsLayout(client, branchId);
      if (!kds.enabled) return fail('NOT_FOUND');
      await lock(client, 'fulfillment:courier-incident:' + id);
      const select = (sql: string) =>
        client.query<IncidentRow>(`${INCIDENT_SELECT} WHERE i.incident_id=$1${sql}`, [id]);
      const saved = (await select('')).rows[0];
      if (saved) {
        if (
          saved.branch_id !== branchId ||
          saved.staff_id !== staff.staff_id ||
          saved.terminal_id !== staff.terminal_id ||
          saved.request_hash !== requestHash
        )
          fail('CONFLICT');
        return incidentView(saved);
      }
      let stationId: string;
      if (incident.orderId) {
        const order = (
          await client.query<{ assembly_station_id: string }>(
            'SELECT assembly_station_id FROM fulfillment_reservations WHERE order_id=$1 AND branch_id=$2 FOR KEY SHARE',
            [incident.orderId, branchId],
          )
        ).rows[0];
        stationId = order?.assembly_station_id ?? fail('NOT_FOUND');
      } else {
        const counter =
          kds.layout.stations.find((s) => s.function === 'delivery_handover') ??
          kds.layout.stations.find((s) => s.function === 'issue')!;
        stationId = counter.edge_station_id;
      }
      await stationPermission(client, branchId, staff, stationId);
      await client.query(
        `INSERT INTO courier_incidents(incident_id,branch_id,order_id,provider,claimed_number,kind,description,station_id,staff_id,terminal_id,request_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          branchId,
          incident.orderId ?? null,
          incident.provider,
          incident.claimedNumber ?? null,
          incident.kind,
          incident.description,
          stationId,
          staff.staff_id,
          staff.terminal_id,
          requestHash,
        ],
      );
      await audit(client, branchId, staff.staff_id, 'fulfillment.courier_incident', id);
      return incidentView((await select('')).rows[0]!);
    });
  }
  /**
   * GET fulfillment/incidents?scope=open|today (contracts section 5.4): the "Менеджер вызван"
   * banner of screens 2 and 3 (open: recorded within COURIER_INCIDENT_OPEN_MINUTES, its order
   * not yet handed over, cancelled or released) and the journal of the Almaty day. Newest first.
   * NOT_FOUND while the KDS layout is off.
   */
  async listIncidents(branchId: string, auth: StaffAuth, input: unknown) {
    parse(z.uuid(), branchId);
    const q = parse(CourierIncidentQuerySchema, input);
    return transaction(this.pool, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const staff = await authenticateStaff(client, branchId, auth);
      if (!['kitchen', 'shift_manager'].includes(staff.role)) fail('FORBIDDEN');
      await client.query('SET TRANSACTION READ ONLY');
      if (!(await readKdsLayout(client, branchId)).enabled) fail('NOT_FOUND');
      const open = q.scope === 'open';
      const window = open
        ? `i.recorded_at>clock_timestamp()-$2*interval '1 minute'
           AND (i.order_id IS NULL OR r.state NOT IN ('handed_over','cancelled','released'))`
        : `i.recorded_at>=(date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Almaty') AT TIME ZONE 'Asia/Almaty')`;
      const rows = (
        await client.query<IncidentRow>(
          `${INCIDENT_SELECT} WHERE i.branch_id=$1 AND ${window}
           ORDER BY i.recorded_at DESC,i.incident_id LIMIT 200`,
          open ? [branchId, COURIER_INCIDENT_OPEN_MINUTES] : [branchId],
        )
      ).rows;
      return { items: rows.map(incidentView) };
    });
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
