import { createHash } from 'node:crypto';
import { z } from 'zod';
import { KITCHEN_ACTIONS } from '@pickchick/fulfillment-state';

export type CloudKitchenCode =
  'INVALID' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'NOT_READY' | 'ROUTING_MISSING';
export type CloudKitchenReason = 'NOT_PAID' | 'NUMBERS_EXHAUSTED';
export class CloudKitchenError extends Error {
  constructor(
    readonly code: CloudKitchenCode,
    readonly reason?: CloudKitchenReason,
  ) {
    super(code);
  }
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new CloudKitchenError('INVALID');
  return result.data;
}

function canonical(v: unknown): string {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)
    return (
      '{' +
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, c]) => JSON.stringify(k) + ':' + canonical(c))
        .join(',') +
      '}'
    );
  throw new CloudKitchenError('INVALID');
}
/** Same canonical JSON digest as commerce and edge fulfillment. */
export function digest(value: unknown): string {
  const text = canonical(value);
  if (Buffer.byteLength(text) > 1_100_000) throw new CloudKitchenError('INVALID');
  return createHash('sha256').update(text).digest('hex');
}

const uuid = z.uuid();
const ref = z.string().min(1).max(160);
const label = z.string().min(1).max(250);
const bilingual = z.object({ ru: label, kk: z.string().max(250) });
const quantity = z.int().min(1).max(1_000_000);

/** Same shape as edge `RoutingSchema` (edge 005): explicit routes, no inferred station. */
export const RoutingSchema = z.strictObject({
  version: z.int().positive(),
  assemblyStationId: uuid,
  routes: z
    .array(
      z.strictObject({
        productId: ref,
        stationId: uuid,
        kind: z.enum(['prep', 'assembly_item']),
        unexpandedCombo: z.literal('whole_product').optional(),
      }),
    )
    .min(1)
    .max(2000),
});
export const SetupSchema = z.strictObject({
  branchId: uuid,
  stations: z
    .array(
      z.strictObject({
        id: uuid,
        kind: z.enum(['prep', 'assembly']),
        name: z.string().min(1).max(100),
      }),
    )
    .min(1)
    .max(100),
  routing: RoutingSchema,
});
const DetailsSchema = z
  .object({
    kind: z.enum(['item', 'combo', 'set']),
    modifiers: z
      .array(
        z
          .object({
            groupId: ref,
            groupTitle: bilingual,
            optionId: ref,
            label: bilingual,
            quantity,
            linkedProductId: ref.nullable(),
          })
          .passthrough(),
      )
      .max(100),
    components: z
      .array(
        z
          .object({
            productId: ref,
            quantity,
            name: bilingual,
            description: z.object({ ru: z.string().max(2000), kk: z.string().max(2000) }),
          })
          .passthrough(),
      )
      .max(100),
  })
  .passthrough();
/** Commerce order snapshot as copied from the quote (same fields edge admission accepts). */
export const SnapshotSchema = z
  .object({
    organizationId: uuid,
    branchId: uuid,
    channel: z.enum(['mobile', 'kiosk']),
    serviceMode: z.enum(['takeaway', 'dine_in']),
    displayName: z.string().max(14).optional(),
    kitchenComment: z.string().max(60).optional(),
    currency: z.literal('KZT'),
    totalMinor: z.string().regex(/^[1-9][0-9]{0,15}$/),
    lines: z
      .array(
        z
          .object({
            lineId: uuid,
            productId: ref,
            title: label,
            description: z.string().max(2000),
            quantity: z.int().min(1).max(1000),
            selectedDetails: DetailsSchema.optional(),
          })
          .passthrough(),
      )
      .min(1)
      .max(200),
  })
  .passthrough();
export type Routing = z.infer<typeof RoutingSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** Kitchen command body. The idempotency key travels separately (`Idempotency-Key`). */
export const CommandSchema = z.strictObject({
  orderId: uuid,
  expectedVersion: z.int().positive(),
  action: z.enum(KITCHEN_ACTIONS),
  stationId: uuid.optional(),
  taskId: uuid.optional(),
  expectedTaskVersion: z.int().positive().optional(),
  reason: z.string().min(1).max(500).optional(),
  inventoryDisposition: z.enum(['requires_inventory_review', 'recorded_elsewhere']).optional(),
});
export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);

/**
 * Authenticated kitchen device. In S2 it only comes from the test hook; S3/S6 derive it from the
 * revocable device credential issued in the back office. `manager` allows confirm_cancel and
 * every station, mirroring the edge shift_manager.
 */
export const ActorSchema = z.strictObject({
  branchId: uuid,
  deviceId: uuid,
  stationIds: z.array(uuid).max(100),
  manager: z.boolean(),
});
export type KitchenActor = z.infer<typeof ActorSchema>;

export type TaskPlan = {
  componentKey: string;
  stationId: string;
  kind: 'prep' | 'assembly_item';
  details: {
    lineId: string;
    productId: string;
    title: string;
    quantity: number;
    parentTitle: string;
    description: string;
    modifiers: unknown[];
  };
};
/**
 * Port of edge `taskPlan` (packages/edge-fulfillment/src/model.ts) with identical rules and
 * output; tests/unit/cloud-kitchen-task-plan.test.mjs compares both on the same vectors.
 * Explicit routes for every leaf and parent item; no inferred "default station".
 */
export function taskPlan(snapshot: Pick<Snapshot, 'lines'>, routing: Routing): TaskPlan[] {
  const routes = new Map(routing.routes.map((v) => [v.productId, v]));
  if (
    routes.size !== routing.routes.length ||
    new Set(snapshot.lines.map((l) => l.lineId)).size !== snapshot.lines.length
  )
    throw new CloudKitchenError('INVALID');
  const result: TaskPlan[] = [];
  for (const line of snapshot.lines) {
    const selected = line.selectedDetails;
    const components = selected?.components ?? [];
    if (new Set(components.map((c) => c.productId)).size !== components.length)
      throw new CloudKitchenError('INVALID');
    const unexpandedCombo = selected && selected.kind !== 'item' && !components.length;
    if (
      unexpandedCombo &&
      (routes.get(line.productId)?.unexpandedCombo !== 'whole_product' ||
        selected.modifiers.some((modifier) => modifier.linkedProductId))
    )
      throw new CloudKitchenError('ROUTING_MISSING');
    for (const modifier of selected?.modifiers ?? [])
      if (modifier.linkedProductId && !routes.has(modifier.linkedProductId))
        throw new CloudKitchenError('ROUTING_MISSING');
    const parts = [
      ...(!selected || selected.kind === 'item' || unexpandedCombo
        ? [
            {
              productId: line.productId,
              quantity: 1,
              title: line.title,
              description: line.description,
              key: 'parent',
            },
          ]
        : []),
      ...components.map((c) => ({
        productId: c.productId,
        quantity: c.quantity,
        title: c.name.ru,
        description: c.description.ru,
        key: 'component:' + c.productId,
      })),
    ];
    for (const part of parts) {
      const route = routes.get(part.productId);
      if (!route) throw new CloudKitchenError('ROUTING_MISSING');
      const count = line.quantity * part.quantity;
      if (!Number.isSafeInteger(count) || count > 1_000_000) throw new CloudKitchenError('INVALID');
      result.push({
        componentKey: line.lineId + ':' + part.key,
        stationId: route.stationId,
        kind: route.kind,
        details: {
          lineId: line.lineId,
          productId: part.productId,
          title: part.title,
          quantity: count,
          parentTitle: line.title,
          description: part.description,
          modifiers: selected?.modifiers ?? [],
        },
      });
    }
  }
  if (!result.length || result.length > 2000) throw new CloudKitchenError('INVALID');
  digest(result); // Bound the fully expanded plan, including repeated modifier instructions.
  return result;
}
