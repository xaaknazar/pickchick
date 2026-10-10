import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
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
import type {
  Decision,
  OrderState,
  Step,
  TaskSnapshot,
  TaskState,
} from '@pickchick/fulfillment-state';
import {
  ActorSchema,
  CloudKitchenError,
  CommandSchema,
  IdempotencyKeySchema,
  RoutingSchema,
  SnapshotSchema,
  digest,
  parse,
  taskPlan,
} from './model.js';
import type { KitchenActor, Snapshot, TaskPlan } from './model.js';

type CloudState = Exclude<OrderState, 'held' | 'released'>;
export interface OrderRow {
  order_id: string;
  branch_id: string;
  channel: 'kiosk' | 'mobile';
  fulfillment_owner: 'cloud';
  owner_epoch: string;
  quote_digest: string;
  snapshot: Snapshot;
  routing_version: number;
  assembly_station_id: string;
  task_plan: TaskPlan[];
  display_number: number;
  number_shift_epoch: string;
  state: CloudState;
  version: number;
  cancellation_reason: string | null;
  inventory_disposition: string | null;
  created_at: Date;
  updated_at: Date;
}
export interface TaskRow {
  id: string;
  branch_id: string;
  order_id: string;
  component_key: string;
  station_id: string;
  routing_version: number;
  kind: 'prep' | 'assembly_item';
  details: TaskPlan['details'];
  version: number;
  state: TaskState;
  updated_at: Date;
}
export type AdmissionResult =
  | { outcome: 'admitted' | 'existing'; fulfillmentOwner: 'cloud'; order: OrderView }
  | { outcome: 'edge'; fulfillmentOwner: 'edge'; ownerEpoch: string };
export type OrderView = ReturnType<typeof view>;

/** Events of the cloud kitchen aggregate, one per order version. */
export const EVENT = {
  accepted: 'cloud_kitchen.accepted',
  task_changed: 'cloud_kitchen.task_changed',
  ready: 'cloud_kitchen.ready',
  handed_over: 'cloud_kitchen.handed_over',
  cancel_requested: 'cloud_kitchen.cancellation_requested',
  cancelled: 'cloud_kitchen.cancelled',
} as const;

const fail = (code: CloudKitchenError['code'], reason?: CloudKitchenError['reason']): never => {
  throw new CloudKitchenError(code, reason);
};
const decided = <T>(decision: Decision<T>): T =>
  decision.ok ? decision.value : fail(decision.code);
const snapshotOf = (task: TaskRow): TaskSnapshot => ({
  id: task.id,
  stationId: task.station_id,
  state: task.state,
  version: task.version,
});
export function view(row: OrderRow) {
  return {
    orderId: row.order_id,
    branchId: row.branch_id,
    channel: row.channel,
    fulfillmentOwner: 'cloud' as const,
    ownerEpoch: row.owner_epoch,
    version: row.version,
    state: row.state,
    displayNumber: row.display_number,
    routingVersion: row.routing_version,
    assemblyStationId: row.assembly_station_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
async function lock(client: DatabaseClient, key: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
}
async function emit(
  client: DatabaseClient,
  row: OrderRow,
  type: (typeof EVENT)[keyof typeof EVENT],
  extra: Record<string, unknown> = {},
) {
  const id = randomUUID();
  await client.query(
    'INSERT INTO cloud_kitchen_outbox(event_id,branch_id,order_id,aggregate_version,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',
    [id, row.branch_id, row.order_id, row.version, type, { ...view(row), ...extra }],
  );
  return id;
}
async function advance(
  client: DatabaseClient,
  row: OrderRow,
  state: CloudState,
  type: (typeof EVENT)[keyof typeof EVENT],
  extra: Record<string, unknown> = {},
  fields: { cancellationReason?: string; inventoryDisposition?: string } = {},
) {
  const next = (
    await client.query<OrderRow>(
      `UPDATE cloud_kitchen_orders SET state=$2,version=version+1,updated_at=clock_timestamp(),
        cancellation_reason=COALESCE($3,cancellation_reason),inventory_disposition=COALESCE($4,inventory_disposition)
       WHERE order_id=$1 RETURNING *`,
      [row.order_id, state, fields.cancellationReason ?? null, fields.inventoryDisposition ?? null],
    )
  ).rows[0]!;
  await emit(client, next, type, extra);
  // The display number is free again once the order leaves the kitchen for good.
  if (state === 'handed_over' || state === 'cancelled')
    await client.query('SELECT channel_number_release($1)', [row.order_id]);
  return next;
}
async function lockedOrder(client: DatabaseClient, branchId: string, orderId: string) {
  return (
    (
      await client.query<OrderRow>(
        'SELECT * FROM cloud_kitchen_orders WHERE order_id=$1 AND branch_id=$2 FOR UPDATE',
        [orderId, branchId],
      )
    ).rows[0] ?? fail('NOT_FOUND')
  );
}
async function tasksOf(client: DatabaseClient, row: OrderRow) {
  return (
    await client.query<TaskRow>(
      'SELECT * FROM cloud_kitchen_tasks WHERE branch_id=$1 AND order_id=$2 ORDER BY id',
      [row.branch_id, row.order_id],
    )
  ).rows;
}
function permitStation(actor: KitchenActor, stationId: string) {
  if (!actor.manager && !actor.stationIds.includes(stationId)) fail('FORBIDDEN');
}
function taskView(task: TaskRow) {
  return {
    id: task.id,
    stationId: task.station_id,
    kind: task.kind,
    state: task.state,
    version: task.version,
    componentKey: task.component_key,
    details: task.details,
  };
}
function kitchenView(row: OrderRow, tasks: TaskRow[]) {
  return {
    ...view(row),
    serviceMode: row.snapshot.serviceMode,
    ...(row.snapshot.displayName ? { displayName: row.snapshot.displayName } : {}),
    ...(row.snapshot.kitchenComment ? { kitchenComment: row.snapshot.kitchenComment } : {}),
    tasks: tasks.map(taskView),
  };
}

/**
 * Cloud-owned kitchen aggregate for kiosk/mobile orders (ADR-0014). Every transition goes
 * through @pickchick/fulfillment-state, so cloud and edge accept and reject exactly the same
 * commands; a step is one order version and one outbox event, committed with the command
 * journal row in one transaction.
 */
export class CloudKitchen {
  constructor(private readonly pool: DatabasePool) {}

  /**
   * Fix the fulfillment owner of a paid kiosk/mobile order and, in mode 'cloud', create the
   * kitchen order, its tasks and the display number. Idempotent per order: the first decision
   * is recorded and every later call returns it, whatever the branch mode is by then.
   *
   * S5 hook point: call `admitPaidOrderInTransaction` inside the commerce capture transaction,
   * where `reconcile` (packages/commerce-core/src/repository.ts) today emits
   * `edge.kitchen_admission_requested`; in mode 'cloud' that edge event must not be emitted.
   * Not wired in S2.
   */
  async admitPaidOrder(orderId: string): Promise<AdmissionResult> {
    parse(z.uuid(), orderId);
    return transaction(this.pool, (client) => this.admitPaidOrderInTransaction(client, orderId));
  }

  async admitPaidOrderInTransaction(
    client: DatabaseClient,
    orderId: string,
  ): Promise<AdmissionResult> {
    parse(z.uuid(), orderId);
    await lock(client, 'cloud_kitchen:admission:' + orderId);
    const decision = (
      await client.query<{ fulfillment_owner: 'edge' | 'cloud'; owner_epoch: string }>(
        'SELECT fulfillment_owner,owner_epoch FROM cloud_kitchen_admissions WHERE order_id=$1',
        [orderId],
      )
    ).rows[0];
    if (decision?.fulfillment_owner === 'edge')
      return { outcome: 'edge', fulfillmentOwner: 'edge', ownerEpoch: decision.owner_epoch };
    if (decision) {
      const row = (
        await client.query<OrderRow>('SELECT * FROM cloud_kitchen_orders WHERE order_id=$1', [
          orderId,
        ])
      ).rows[0]!;
      return { outcome: 'existing', fulfillmentOwner: 'cloud', order: view(row) };
    }
    const order =
      (
        await client.query<{
          organization_id: string;
          branch_id: string;
          snapshot: unknown;
          quote_digest: string;
          total_minor: string;
          attention_required: boolean;
        }>(
          'SELECT organization_id,branch_id,snapshot,quote_digest,total_minor,attention_required FROM commerce_orders WHERE id=$1 FOR SHARE',
          [orderId],
        )
      ).rows[0] ?? fail('NOT_FOUND');
    const channel = (order.snapshot as { channel?: unknown } | null)?.channel;
    // POS and aggregator orders never reach this path; they stay with the edge.
    if (channel !== 'kiosk' && channel !== 'mobile') fail('INVALID');
    const snapshot = parse(SnapshotSchema, order.snapshot);
    if (snapshot.branchId !== order.branch_id || snapshot.organizationId !== order.organization_id)
      fail('CONFLICT');
    // Paid in full by the trusted payment adapter, with nothing that would stop production:
    // the same conditions under which commerce requests edge kitchen admission today.
    const paid = (
      await client.query<{ paid: boolean }>(
        `SELECT coalesce((SELECT sum(amount_minor) FROM commerce_captures WHERE order_id=$1),0)=$2::bigint
          AND NOT EXISTS(SELECT 1 FROM commerce_refunds WHERE order_id=$1 AND state<>'failed')
          AND NOT EXISTS(SELECT 1 FROM commerce_cancellation_intents WHERE order_id=$1) AS paid`,
        [orderId, order.total_minor],
      )
    ).rows[0]!.paid;
    if (!paid || order.attention_required) fail('NOT_READY', 'NOT_PAID');
    // Shared side of cloud_kitchen_set_mode's lock: a concurrent mode switch waits for this
    // admission, so the recorded epoch is the one in force when the owner is fixed.
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
      'channel_mode:' + order.branch_id,
    ]);
    const mode = (
      await client.query<{ cloud_channels_owner: 'edge' | 'cloud'; epoch: string }>(
        'SELECT cloud_channels_owner,epoch FROM branch_channel_modes WHERE branch_id=$1',
        [order.branch_id],
      )
    ).rows[0] ?? { cloud_channels_owner: 'edge' as const, epoch: '0' };
    if (mode.cloud_channels_owner === 'edge') {
      await client.query(
        "INSERT INTO cloud_kitchen_admissions(order_id,branch_id,channel,fulfillment_owner,owner_epoch) VALUES($1,$2,$3,'edge',$4)",
        [orderId, order.branch_id, channel, mode.epoch],
      );
      return { outcome: 'edge', fulfillmentOwner: 'edge', ownerEpoch: mode.epoch };
    }
    // Shared side of the provisioning lock; routing versions themselves are immutable.
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
      'cloud_kitchen:config:' + order.branch_id,
    ]);
    const stored =
      (
        await client.query<{ payload: unknown }>(
          'SELECT r.payload FROM cloud_kitchen_config c JOIN cloud_kitchen_routing r ON r.branch_id=c.branch_id AND r.version=c.active_routing_version WHERE c.branch_id=$1',
          [order.branch_id],
        )
      ).rows[0] ?? fail('ROUTING_MISSING');
    const routing = parse(RoutingSchema, stored.payload);
    const plan = taskPlan(snapshot, routing);
    // Idempotent per order: a number reserved before payment comes back as 'existing'.
    const number = (
      await client.query<{
        outcome: 'allocated' | 'existing' | 'not_ready';
        display_number: number | null;
        shift_epoch: string;
      }>('SELECT outcome,display_number,shift_epoch FROM channel_number_allocate($1,$2,$3)', [
        order.branch_id,
        channel,
        orderId,
      ])
    ).rows[0]!;
    if (number.outcome === 'not_ready') fail('NOT_READY', 'NUMBERS_EXHAUSTED');
    await client.query(
      "INSERT INTO cloud_kitchen_admissions(order_id,branch_id,channel,fulfillment_owner,owner_epoch) VALUES($1,$2,$3,'cloud',$4)",
      [orderId, order.branch_id, channel, mode.epoch],
    );
    const row = (
      await client.query<OrderRow>(
        `INSERT INTO cloud_kitchen_orders(order_id,branch_id,channel,owner_epoch,quote_digest,snapshot,routing_version,assembly_station_id,task_plan,display_number,number_shift_epoch,state)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'accepted') RETURNING *`,
        [
          orderId,
          order.branch_id,
          channel,
          mode.epoch,
          order.quote_digest,
          order.snapshot,
          routing.version,
          routing.assemblyStationId,
          JSON.stringify(plan),
          number.display_number,
          number.shift_epoch,
        ],
      )
    ).rows[0]!;
    await client.query(
      `INSERT INTO cloud_kitchen_tasks(id,branch_id,order_id,component_key,station_id,routing_version,kind,details)
       SELECT gen_random_uuid(),$1,$2,p->>'componentKey',(p->>'stationId')::uuid,$3,p->>'kind',p->'details'
       FROM jsonb_array_elements($4::jsonb) p`,
      [row.branch_id, row.order_id, row.routing_version, JSON.stringify(plan)],
    );
    await emit(client, row, EVENT.accepted);
    return { outcome: 'admitted', fulfillmentOwner: 'cloud', order: view(row) };
  }

  /**
   * Trusted commercial cancellation of a cloud order (same rule as edge
   * `edge.fulfillment_cancel_requested`): untouched orders cancel at once and free the number,
   * started ones wait for confirm_stop / confirm_cancel. No HTTP route; S5 wires commerce.
   */
  async requestCancel(orderId: string, input: unknown) {
    parse(z.uuid(), orderId);
    const p = parse(
      z.strictObject({
        branchId: z.uuid(),
        expectedVersion: z.int().positive(),
        reason: z.string().min(1).max(500),
      }),
      input,
    );
    return transaction(this.pool, async (client) => {
      let row = await lockedOrder(client, p.branchId, orderId);
      if (row.version !== p.expectedVersion) fail('CONFLICT');
      if (!acceptsWork(row.state)) fail('NOT_READY');
      const started = (await tasksOf(client, row)).some((t) => t.state !== 'queued');
      await client.query(
        `UPDATE cloud_kitchen_tasks SET state=CASE WHEN state='in_progress' THEN 'cancel_requested' ELSE 'cancelled' END,
          version=version+1,updated_at=clock_timestamp() WHERE order_id=$1 AND state IN ('queued','in_progress')`,
        [row.order_id],
      );
      row = await advance(
        client,
        row,
        started ? 'cancel_requested' : 'cancelled',
        started ? EVENT.cancel_requested : EVENT.cancelled,
        { reason: p.reason, inventoryEffect: 'none' },
        { cancellationReason: p.reason },
      );
      return view(row);
    });
  }

  /** One kitchen command from an authenticated device, idempotent per Idempotency-Key. */
  async act(actorInput: KitchenActor, idempotencyKey: unknown, input: unknown) {
    const actor = parse(ActorSchema, actorInput);
    const key = parse(IdempotencyKeySchema, idempotencyKey);
    const command = parse(CommandSchema, input),
      requestHash = digest(command);
    return transaction(this.pool, async (client) => {
      await lock(
        client,
        'cloud_kitchen:command:' + actor.branchId + ':' + actor.deviceId + ':' + key,
      );
      const saved = (
        await client.query<{ request_hash: string; result: OrderView }>(
          'SELECT request_hash,result FROM cloud_kitchen_commands WHERE branch_id=$1 AND device_id=$2 AND idempotency_key=$3',
          [actor.branchId, actor.deviceId, key],
        )
      ).rows[0];
      const replay = replayDecision(saved?.request_hash, requestHash);
      if (replay === 'conflict') fail('CONFLICT');
      if (replay === 'replay') return saved!.result;
      // Another branch's order is indistinguishable from a missing one.
      let row = await lockedOrder(client, actor.branchId, command.orderId);
      decided(checkVersion(row.version, command.expectedVersion));
      const shape = decided(commandShape(command));
      const audit = { deviceId: actor.deviceId };
      const apply = async (steps: Step[]) => {
        for (const step of steps) {
          if (step.kind === 'task') {
            await client.query(
              'UPDATE cloud_kitchen_tasks SET state=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1',
              [step.taskId, step.to],
            );
            row = await advance(client, row, step.order as CloudState, EVENT.task_changed, {
              taskId: step.taskId,
              taskVersion: step.taskVersion,
              taskState: step.to,
              stationId: step.stationId,
              ...audit,
            });
          } else if (step.event === 'cancelled') {
            row = await advance(
              client,
              row,
              'cancelled',
              EVENT.cancelled,
              {
                reason: command.reason,
                inventoryDisposition: command.inventoryDisposition,
                inventoryEffect: 'none',
                ...audit,
              },
              {
                cancellationReason: command.reason!,
                inventoryDisposition: command.inventoryDisposition!,
              },
            );
          } else
            row = await advance(client, row, step.order as CloudState, EVENT[step.event], audit);
        }
      };
      if (shape.kind === 'station') {
        permitStation(actor, shape.stationId);
        if (!acceptsWork(row.state)) fail('NOT_READY');
        await apply(
          decided(
            planCompleteStation({
              order: row.state,
              assemblyStationId: row.assembly_station_id,
              stationId: shape.stationId,
              tasks: (await tasksOf(client, row)).map(snapshotOf),
            }),
          ),
        );
      } else if (shape.kind === 'task') {
        const task =
          (
            await client.query<TaskRow>(
              'SELECT * FROM cloud_kitchen_tasks WHERE id=$1 AND order_id=$2 AND branch_id=$3 FOR UPDATE',
              [shape.taskId, row.order_id, actor.branchId],
            )
          ).rows[0] ?? fail('NOT_FOUND');
        permitStation(actor, task.station_id);
        await apply(
          decided(
            planTask({
              action: shape.action,
              order: row.state,
              task: snapshotOf(task),
              expectedTaskVersion: shape.expectedTaskVersion,
            }),
          ),
        );
      } else if (shape.action === 'confirm_cancel') {
        const cancel = {
          order: row.state,
          manager: actor.manager,
          reason: command.reason,
          inventoryDisposition: command.inventoryDisposition,
        };
        decided(guardConfirmCancel(cancel));
        await apply(
          decided(
            planConfirmCancel({ ...cancel, tasks: (await tasksOf(client, row)).map(snapshotOf) }),
          ),
        );
      } else {
        permitStation(actor, row.assembly_station_id);
        if (shape.action === 'ready') {
          if (!acceptsWork(row.state)) fail('NOT_READY');
          await apply(
            decided(
              planReady({
                order: row.state,
                tasks: (await tasksOf(client, row)).map(snapshotOf),
              }),
            ),
          );
        } else await apply(decided(planHandoff({ order: row.state })));
      }
      const result = view(row);
      await client.query(
        'INSERT INTO cloud_kitchen_commands(branch_id,device_id,idempotency_key,order_id,action,station_id,request_hash,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          actor.branchId,
          actor.deviceId,
          key,
          row.order_id,
          command.action,
          command.stationId ?? null,
          requestHash,
          result,
        ],
      );
      return result;
    });
  }

  /** Stations of the actor's branch and whether this device may act on them. */
  async listStations(actorInput: KitchenActor) {
    const actor = parse(ActorSchema, actorInput);
    const rows = (
      await this.pool.query<{ id: string; kind: 'prep' | 'assembly'; name: string }>(
        'SELECT id,kind,name FROM cloud_kitchen_stations WHERE branch_id=$1 ORDER BY kind,name,id',
        [actor.branchId],
      )
    ).rows;
    return {
      items: rows.map((s) => ({
        ...s,
        allowed: actor.manager || actor.stationIds.includes(s.id),
      })),
    };
  }

  async readOrder(actorInput: KitchenActor, orderId: string, input: unknown = {}) {
    const actor = parse(ActorSchema, actorInput);
    parse(z.uuid(), orderId);
    const q = parse(z.strictObject({ stationId: z.uuid().optional() }), input);
    if (q.stationId) permitStation(actor, q.stationId);
    return transaction(this.pool, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const row =
        (
          await client.query<OrderRow>(
            'SELECT * FROM cloud_kitchen_orders WHERE order_id=$1 AND branch_id=$2',
            [orderId, actor.branchId],
          )
        ).rows[0] ?? fail('NOT_FOUND');
      const tasks = await tasksOf(client, row);
      if (
        q.stationId &&
        row.assembly_station_id !== q.stationId &&
        !tasks.some((task) => task.station_id === q.stationId)
      )
        fail('FORBIDDEN');
      return {
        ...kitchenView(row, tasks),
        cancellationReason: row.cancellation_reason,
        inventoryDisposition: row.inventory_disposition,
      };
    });
  }

  /**
   * Paginated active queue, optionally for one station. A station poll records the device's
   * presence for that station (input of the KITCHEN_OFFLINE gate, S4).
   */
  async listKitchen(actorInput: KitchenActor, input: unknown = {}) {
    const actor = parse(ActorSchema, actorInput);
    const q = parse(
      z.strictObject({
        afterOrderId: z.uuid().optional(),
        limit: z.int().min(1).max(100).default(50),
        stationId: z.uuid().optional(),
      }),
      input,
    );
    if (q.stationId) {
      permitStation(actor, q.stationId);
      const seen = await this.pool.query(
        `INSERT INTO cloud_kitchen_station_presence(branch_id,device_id,station_id)
         SELECT $1,$2,id FROM cloud_kitchen_stations WHERE branch_id=$1 AND id=$3
         ON CONFLICT(branch_id,device_id,station_id) DO UPDATE SET seen_at=clock_timestamp()`,
        [actor.branchId, actor.deviceId, q.stationId],
      );
      if (!seen.rowCount) fail('NOT_FOUND');
    }
    return transaction(this.pool, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const candidates = (
        await client.query<OrderRow>(
          `SELECT * FROM cloud_kitchen_orders r WHERE branch_id=$1 AND state IN ('accepted','in_production','ready','cancel_requested')
            AND ($2::uuid IS NULL OR order_id>$2)
            AND ($4::uuid IS NULL OR r.assembly_station_id=$4 OR EXISTS(SELECT 1 FROM cloud_kitchen_tasks t WHERE t.order_id=r.order_id AND t.station_id=$4))
           ORDER BY order_id LIMIT $3`,
          [actor.branchId, q.afterOrderId ?? null, q.limit + 1, q.stationId ?? null],
        )
      ).rows;
      const items = [];
      let bytes = 0;
      for (const row of candidates.slice(0, q.limit)) {
        const item = kitchenView(row, await tasksOf(client, row));
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

  /** Customer display projection: number, optional name, preparing/ready. */
  async readDisplay(actorInput: KitchenActor, input: unknown = {}) {
    const actor = parse(ActorSchema, actorInput);
    const q = parse(
      z.strictObject({
        afterNumber: z.int().min(0).max(899).default(0),
        limit: z.int().min(1).max(100).default(50),
      }),
      input,
    );
    const rows = (
      await this.pool.query<{ display_number: number; state: CloudState; display_name: string }>(
        `SELECT display_number,state,left(coalesce(snapshot->>'displayName',''),14) AS display_name
         FROM cloud_kitchen_orders WHERE branch_id=$1 AND state IN ('accepted','in_production','ready')
          AND display_number>$2 ORDER BY display_number LIMIT $3`,
        [actor.branchId, q.afterNumber, q.limit + 1],
      )
    ).rows;
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((r) => ({
        number: r.display_number,
        ...(r.display_name ? { name: r.display_name } : {}),
        state: r.state === 'ready' ? ('ready' as const) : ('preparing' as const),
        fulfillmentOwner: 'cloud' as const,
      })),
      nextAfterNumber: rows.length > q.limit ? page.at(-1)!.display_number : null,
    };
  }

  /**
   * Freshness of kitchen consumers for the future KITCHEN_OFFLINE gate (S4): at least one
   * assembly and one prep station polled within `seconds`. Read only; not wired in S2.
   */
  async stationPresence(branchId: string, seconds = 30) {
    parse(z.uuid(), branchId);
    parse(z.int().min(1).max(3600), seconds);
    const rows = (
      await this.pool.query<{ kind: 'prep' | 'assembly'; fresh: boolean }>(
        `SELECT s.kind,bool_or(p.seen_at>clock_timestamp()-$2*interval '1 second') AS fresh
         FROM cloud_kitchen_stations s LEFT JOIN cloud_kitchen_station_presence p ON p.branch_id=s.branch_id AND p.station_id=s.id
         WHERE s.branch_id=$1 GROUP BY s.kind`,
        [branchId, seconds],
      )
    ).rows;
    const fresh = (kind: 'prep' | 'assembly') => rows.some((r) => r.kind === kind && r.fresh);
    return { assembly: fresh('assembly'), prep: fresh('prep') };
  }
}
