import { z } from 'zod';
import { EventEnvelopeSchema, MoneyMinorSchema } from '@pickchick/contracts';
import { hashJson } from '@pickchick/menu-sync';
import { MAX_EVENT_BYTES, PosSyncError } from './model.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().min(1).max(2147483647);
const positiveBigint = MoneyMinorSchema.refine((value) => BigInt(value) > 0n);
export const PosKitchenEventSchema = EventEnvelopeSchema.extend({
  aggregate_type: z.literal('order_fulfillment'),
  aggregate_version: version,
  event_type: z.enum([
    'edge.fulfillment_accepted',
    'edge.task_changed',
    'edge.fulfillment_ready',
    'edge.fulfillment_handed_over',
    'edge.fulfillment_cancelled',
  ]),
  payload: z.strictObject({
    orderId: z.uuid(),
    branchId: z.uuid(),
    reservationId: z.uuid(),
    quoteId: z.uuid(),
    quoteDigest: hash,
    ownerHash: hash,
    commercialOwner: z.literal('edge_pos'),
    fulfillmentOwner: z.literal('edge'),
    deviceId: z.uuid(),
    version,
    state: z.enum(['accepted', 'in_production', 'ready', 'handed_over', 'cancelled']),
    displayNumber: positiveBigint,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    routingVersion: version,
    assemblyStationId: z.uuid(),
    executionMode: z.literal('unpaid_service'),
    staffId: z.uuid(),
    taskId: z.uuid().optional(),
    taskVersion: version.optional(),
    taskState: z.enum(['in_progress', 'done']).optional(),
    stationId: z.uuid().optional(),
    reason: z.string().min(1).max(300).optional(),
    inventoryEffect: z.literal('none').optional(),
  }),
});
export type PosKitchenEvent = z.infer<typeof PosKitchenEventSchema>;
export function parseKitchenEvent(input: unknown): PosKitchenEvent {
  const parsed = PosKitchenEventSchema.safeParse(input);
  if (!parsed.success) throw new PosSyncError('INVALID_REQUEST');
  const event = parsed.data,
    p = event.payload,
    task = event.event_type === 'edge.task_changed',
    cancel = event.event_type === 'edge.fulfillment_cancelled';
  const state = {
    'edge.fulfillment_accepted': 'accepted',
    'edge.task_changed': 'in_production',
    'edge.fulfillment_ready': 'ready',
    'edge.fulfillment_handed_over': 'handed_over',
    'edge.fulfillment_cancelled': 'cancelled',
  };
  if (
    Buffer.byteLength(JSON.stringify(input)) > MAX_EVENT_BYTES ||
    hashJson(input) !== hashJson(event) ||
    event.aggregate_id !== p.orderId ||
    event.branch_id !== p.branchId ||
    event.correlation_id !== p.orderId ||
    event.causation_id !== null ||
    event.aggregate_version !== p.version ||
    state[event.event_type] !== p.state ||
    (p.version === 1) !== (event.event_type === 'edge.fulfillment_accepted') ||
    Date.parse(p.createdAt) > Date.parse(p.updatedAt) ||
    Date.parse(p.updatedAt) > Date.parse(event.occurred_at) ||
    [p.taskId, p.taskVersion, p.taskState, p.stationId].some(
      (value) => (value !== undefined) !== task,
    ) ||
    [p.reason, p.inventoryEffect].some((value) => (value !== undefined) !== cancel)
  )
    throw new PosSyncError('INVALID_REQUEST');
  return event;
}
export const kitchenReceiptFor = (event: PosKitchenEvent) => ({
  eventId: event.event_id,
  branchId: event.branch_id,
  producerId: event.producer_id,
  sequence: event.producer_sequence,
  payloadHash: hashJson(event),
  acknowledged: true as const,
});
