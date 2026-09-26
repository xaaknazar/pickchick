import { z } from 'zod';
import {
  CloudCommandSchema,
  CloudScopeSchema,
  ReleaseCommandSchema,
  ReleaseResultSchema,
} from '@pickchick/edge-fulfillment';

export class TransportError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'UNAUTHORIZED'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'SERVICE_UNAVAILABLE',
  ) {
    super(code);
  }
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new TransportError('INVALID_REQUEST');
  return result.data;
}
const uuid = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sequence = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((v) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n);
export const TransportScopeSchema = CloudScopeSchema;
export const PullRequestSchema = z.strictObject({
  workerId: uuid,
  leaseSeconds: z.int().min(15).max(120),
  protocolVersion: z.literal(2).optional(),
});
export const TransportCommandSchema = z.discriminatedUnion('type', [
  CloudCommandSchema.options[0],
  CloudCommandSchema.options[1],
  ReleaseCommandSchema,
]);
export const DeliverySchema = z.strictObject({ command: TransportCommandSchema, leaseToken: uuid });
export const PullResponseSchema = z.strictObject({
  scope: TransportScopeSchema,
  event: DeliverySchema.nullable(),
});
export const TransportAckSchema = z.strictObject({
  eventId: uuid,
  workerId: uuid,
  leaseToken: uuid,
});
export const TransportReceiptSchema = z.strictObject({
  eventId: uuid,
  acknowledged: z.literal(true),
});
const state = z.enum([
  'held',
  'accepted',
  'in_production',
  'ready',
  'handed_over',
  'cancel_requested',
  'cancelled',
  'released',
]);
export const EdgeEventPayloadSchema = z.strictObject({
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
  state,
  displayNumber: sequence.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  routingVersion: z.int().positive(),
  assemblyStationId: uuid.optional(),
  taskId: uuid.optional(),
  taskVersion: z.int().positive().optional(),
  taskState: z.enum(['queued', 'in_progress', 'done', 'cancel_requested', 'cancelled']).optional(),
  stationId: uuid.optional(),
  staffId: uuid.optional(),
  reason: z.string().min(1).max(500).optional(),
  inventoryDisposition: z.enum(['requires_inventory_review', 'recorded_elsewhere']).optional(),
  inventoryEffect: z.literal('none').optional(),
});
export const EdgeEventSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    eventId: uuid,
    sequence,
    orderId: uuid,
    aggregateVersion: z.int().positive(),
    type: z.enum([
      'edge.admission_reserved',
      'edge.fulfillment_accepted',
      'edge.task_changed',
      'edge.fulfillment_ready',
      'edge.fulfillment_handed_over',
      'edge.cancellation_requested',
      'edge.fulfillment_cancelled',
      'edge.admission_released',
    ]),
    payload: EdgeEventPayloadSchema,
  })
  .superRefine((e, ctx) => {
    const p = e.payload;
    const states: Record<string, string[]> = {
      'edge.admission_reserved': ['held'],
      'edge.fulfillment_accepted': ['accepted'],
      'edge.task_changed': ['in_production', 'cancel_requested'],
      'edge.fulfillment_ready': ['ready'],
      'edge.fulfillment_handed_over': ['handed_over'],
      'edge.cancellation_requested': ['cancel_requested'],
      'edge.fulfillment_cancelled': ['cancelled'],
      'edge.admission_released': ['released'],
    };
    if (
      e.orderId !== p.orderId ||
      e.aggregateVersion !== p.version ||
      !states[e.type]!.includes(p.state)
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent event identity/version/state' });
    if (
      e.type === 'edge.task_changed' &&
      (!p.taskId || !p.taskVersion || !p.taskState || !p.stationId)
    )
      ctx.addIssue({ code: 'custom', message: 'Task event requires task snapshot' });
    if (
      e.type !== 'edge.task_changed' &&
      [p.taskId, p.taskVersion, p.taskState, p.stationId].some((v) => v !== undefined)
    )
      ctx.addIssue({ code: 'custom', message: 'Unexpected task snapshot' });
    if ((p.state === 'held' || p.state === 'released') && p.displayNumber !== null)
      ctx.addIssue({ code: 'custom', message: 'Held reservation has no display number' });
    if (
      ['accepted', 'in_production', 'ready', 'handed_over', 'cancel_requested'].includes(p.state) &&
      p.displayNumber === null
    )
      ctx.addIssue({ code: 'custom', message: 'Execution requires display number' });
  });
export type TransportScope = z.infer<typeof TransportScopeSchema>;
export type EdgeEvent = z.infer<typeof EdgeEventSchema>;
export type Delivery = z.infer<typeof DeliverySchema>;

export const ReleaseResultEventSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    eventId: uuid,
    sequence,
    orderId: uuid,
    aggregateVersion: z.int().positive(),
    type: z.literal('edge.admission_release_result'),
    payload: ReleaseResultSchema,
  })
  .superRefine((event, ctx) => {
    if (event.orderId !== event.payload.orderId || event.aggregateVersion !== event.payload.version)
      ctx.addIssue({ code: 'custom', message: 'Result identity/version mismatch' });
  });
export const TransportEdgeEventSchema = z.union([EdgeEventSchema, ReleaseResultEventSchema]);
