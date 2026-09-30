import { createHash } from 'node:crypto';
import { z } from 'zod';

export class FulfillmentError extends Error {
  constructor(
    readonly code:
      'INVALID' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'NOT_READY' | 'ROUTING_MISSING',
  ) {
    super(code);
  }
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new FulfillmentError('INVALID');
  return result.data;
}
/** Same canonical JSON definition as commerce; never hash a lossy projection. */
export function digest(value: unknown): string {
  const canonical = (v: unknown): string => {
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
    throw new FulfillmentError('INVALID');
  };
  const text = canonical(value);
  if (Buffer.byteLength(text) > 1_100_000) throw new FulfillmentError('INVALID');
  return createHash('sha256').update(text).digest('hex');
}
const uuid = z.uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z.string().min(1).max(160);
const label = z.string().min(1).max(250);
const bilingual = z.object({ ru: label, kk: z.string().max(250) });
const quantity = z.int().min(1).max(1_000_000);
export const CloudScopeSchema = z.strictObject({
  organizationId: uuid,
  branchId: uuid,
  deviceId: uuid,
  producerId: uuid,
});
export type TrustedCloud = z.infer<typeof CloudScopeSchema>;
export const RoutingSchema = z.strictObject({
  version: z.int().positive(),
  assemblyStationId: uuid,
  routes: z
    .array(
      z.strictObject({
        productId: ref,
        stationId: uuid,
        kind: z.enum(['prep', 'assembly_item']),
        // Explicit local recipe handling when the catalog has no component BOM.
        // Never inferred from a combo title or enabled for every unknown product.
        unexpandedCombo: z.literal('whole_product').optional(),
      }),
    )
    .min(1)
    .max(2000),
});
export const SetupSchema = CloudScopeSchema.extend({
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
export const SnapshotSchema = z
  .object({
    organizationId: uuid,
    branchId: uuid,
    channel: z.enum(['mobile', 'pos']),
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
export const AdmissionPayloadSchema = z.strictObject({
  orderId: uuid,
  branchId: uuid,
  quoteId: uuid,
  quoteDigest: hash,
  snapshot: SnapshotSchema.extend({ channel: z.literal('mobile') }),
  owner: z.literal('cloud'),
});
export const AuthorizePayloadSchema = z.strictObject({
  orderId: uuid,
  branchId: uuid,
  reservationId: uuid,
  deviceId: uuid,
  quoteDigest: hash,
  snapshot: SnapshotSchema.extend({ channel: z.literal('mobile') }),
  owner: z.literal('cloud'),
});
export const CloudCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    eventId: uuid,
    type: z.literal('edge.admission_requested'),
    payload: AdmissionPayloadSchema,
  }),
  z.strictObject({
    eventId: uuid,
    type: z.literal('edge.kitchen_admission_requested'),
    payload: AuthorizePayloadSchema,
  }),
  z.strictObject({
    eventId: uuid,
    type: z.enum(['edge.admission_release_requested', 'edge.fulfillment_cancel_requested']),
    payload: z.strictObject({
      orderId: uuid,
      branchId: uuid,
      reservationId: uuid,
      quoteDigest: hash,
      owner: z.literal('cloud'),
      expectedVersion: z.int().positive(),
      reason: z.string().min(1).max(500),
    }),
  }),
]);
export const StaffCommandSchema = z.strictObject({
  commandId: uuid,
  orderId: uuid,
  expectedVersion: z.int().positive(),
  action: z.enum([
    'start_task',
    'complete_task',
    'complete_station',
    'confirm_stop',
    'ready',
    'handoff',
    'confirm_cancel',
  ]),
  stationId: uuid.optional(),
  taskId: uuid.optional(),
  expectedTaskVersion: z.int().positive().optional(),
  reason: z.string().min(1).max(500).optional(),
  inventoryDisposition: z.enum(['requires_inventory_review', 'recorded_elsewhere']).optional(),
});
export const LeaseSchema = z.strictObject({
  workerId: uuid,
  limit: z.int().min(1).max(100),
  leaseSeconds: z.int().min(5).max(300),
});
export const AckSchema = z.strictObject({ eventId: uuid, workerId: uuid, leaseToken: uuid });
export type Routing = z.infer<typeof RoutingSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
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
/** Explicit routes for every leaf and parent item; no inferred "default station". */
export function taskPlan(snapshot: Snapshot, routing: Routing): TaskPlan[] {
  const routes = new Map(routing.routes.map((v) => [v.productId, v]));
  if (
    routes.size !== routing.routes.length ||
    new Set(snapshot.lines.map((l) => l.lineId)).size !== snapshot.lines.length
  )
    throw new FulfillmentError('INVALID');
  const result: TaskPlan[] = [];
  for (const line of snapshot.lines) {
    const selected = line.selectedDetails;
    const components = selected?.components ?? [];
    if (new Set(components.map((c) => c.productId)).size !== components.length)
      throw new FulfillmentError('INVALID');
    const unexpandedCombo = selected && selected.kind !== 'item' && !components.length;
    if (
      unexpandedCombo &&
      (routes.get(line.productId)?.unexpandedCombo !== 'whole_product' ||
        selected.modifiers.some((modifier) => modifier.linkedProductId))
    )
      throw new FulfillmentError('ROUTING_MISSING');
    // Linked additions are already expanded by catalog-pricing. Verify a route for
    // the linked product too; nested mapping must be explicit, never guessed.
    for (const modifier of selected?.modifiers ?? [])
      if (modifier.linkedProductId && !routes.has(modifier.linkedProductId))
        throw new FulfillmentError('ROUTING_MISSING');
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
      if (!route) throw new FulfillmentError('ROUTING_MISSING');
      const count = line.quantity * part.quantity;
      if (!Number.isSafeInteger(count) || count > 1_000_000) throw new FulfillmentError('INVALID');
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
  if (!result.length || result.length > 2000) throw new FulfillmentError('INVALID');
  digest(result); // Bound the fully expanded plan, including repeated modifier instructions.
  return result;
}

export const ReleaseCommandSchema = z.strictObject({
  eventId: uuid,
  type: z.literal('edge.admission_release_requested'),
  payload: z.strictObject({
    orderId: uuid,
    branchId: uuid,
    reservationId: uuid,
    quoteDigest: hash,
    owner: z.literal('cloud'),
    expectedVersion: z.int().positive(),
    reason: z.string().min(1).max(500),
  }),
});
export const ReleaseResultSchema = z
  .strictObject({
    orderId: uuid,
    branchId: uuid,
    reservationId: uuid,
    quoteId: uuid,
    quoteDigest: hash,
    ownerHash: hash,
    commercialOwner: z.literal('cloud'),
    fulfillmentOwner: z.literal('edge'),
    deviceId: uuid,
    version: z.int().positive(),
    state: z.enum([
      'held',
      'accepted',
      'in_production',
      'ready',
      'handed_over',
      'cancel_requested',
      'cancelled',
      'released',
    ]),
    displayNumber: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    routingVersion: z.int().positive(),
    assemblyStationId: uuid,
    requestEventId: uuid,
    requestDigest: hash,
    outcome: z.enum(['applied', 'rejected']),
    rejectionCode: z.enum(['VERSION_CONFLICT', 'NOT_HELD']).nullable(),
    reason: z.string().min(1).max(500),
  })
  .superRefine((r, ctx) => {
    if (
      (r.outcome === 'applied' &&
        (r.state !== 'released' || r.rejectionCode !== null || r.displayNumber !== null)) ||
      (r.outcome === 'rejected' && r.rejectionCode === null)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid release result' });
  });
export type ReleaseResult = z.infer<typeof ReleaseResultSchema>;
