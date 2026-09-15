import { z } from 'zod';
import { EventEnvelopeSchema, QuoteSchema, MoneyMinorSchema } from '@pickchick/contracts';
import { hashJson } from '@pickchick/menu-sync';

export const MAX_EVENT_BYTES = 96 * 1024;
export class PosSyncError extends Error {
  constructor(
    readonly code: 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'CONFLICT' | 'NOT_FOUND',
  ) {
    super(code);
  }
}
export const PosSyncScopeSchema = z.strictObject({
  organizationId: z.uuid(),
  branchId: z.uuid(),
  deviceId: z.uuid(),
  producerId: z.uuid(),
});
export type PosSyncScope = z.infer<typeof PosSyncScopeSchema>;
export const PosOrderEventSchema = EventEnvelopeSchema.extend({
  aggregate_type: z.literal('order_commercial'),
  aggregate_version: z.union([z.literal(1), z.literal(2)]),
  event_type: z.enum(['order.created', 'order.cancelled']),
  payload: z.strictObject({
    order_id: z.uuid(),
    quote_id: z.uuid(),
    state: z.enum(['awaiting_payment', 'cancelled']),
    payment_state: z.literal('not_started'),
    fulfillment_state: z.literal('blocked'),
    total_minor: MoneyMinorSchema,
    currency: z.literal('KZT'),
    channel: z.literal('pos'),
    service_mode: z.enum(['takeaway', 'dine_in']),
    snapshot: QuoteSchema,
  }),
});
export type PosOrderEvent = z.infer<typeof PosOrderEventSchema>;
export const PosOrderReceiptSchema = z.strictObject({
  eventId: z.uuid(),
  branchId: z.uuid(),
  producerId: z.uuid(),
  sequence: MoneyMinorSchema,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  acknowledged: z.literal(true),
});
export function parseEvent(input: unknown): PosOrderEvent {
  const parsed = PosOrderEventSchema.safeParse(input);
  if (!parsed.success) throw new PosSyncError('INVALID_REQUEST');
  const event = parsed.data,
    p = event.payload,
    q = p.snapshot;
  const created = event.event_type === 'order.created';
  if (
    Buffer.byteLength(JSON.stringify(input)) > MAX_EVENT_BYTES ||
    hashJson(input) !== hashJson(event) ||
    event.aggregate_id !== p.order_id ||
    event.correlation_id !== p.order_id ||
    event.causation_id !== null ||
    event.aggregate_version !== (created ? 1 : 2) ||
    p.state !== (created ? 'awaiting_payment' : 'cancelled') ||
    q.branch_id !== event.branch_id ||
    p.quote_id !== q.quote_id ||
    p.total_minor !== q.total_minor ||
    q.total_minor !== q.subtotal_minor ||
    p.service_mode !== q.service_mode ||
    new Set(
      q.lines.map((line) =>
        JSON.stringify([
          line.variant_id,
          (line.modifiers ?? [])
            .map((option) => [option.group_id, option.option_id, option.quantity ?? 1])
            .sort((a, b) => String(a[0] + ':' + a[1]).localeCompare(String(b[0] + ':' + b[1]))),
        ]),
      ),
    ).size !== q.lines.length ||
    q.lines.some(
      (l) =>
        BigInt(l.unit_price_minor) * BigInt(l.quantity) !== BigInt(l.total_minor) ||
        new Set((l.modifiers ?? []).map((option) => option.group_id + option.option_id)).size !==
          (l.modifiers ?? []).length ||
        (l.modifiers ?? []).reduce(
          (sum, option) => sum + BigInt(option.price_minor) * BigInt(option.quantity ?? 1),
          0n,
        ) > BigInt(l.unit_price_minor),
    ) ||
    q.lines.reduce((total, l) => total + BigInt(l.total_minor), 0n) !== BigInt(q.total_minor) ||
    Date.parse(q.expires_at) <= Date.parse(q.created_at)
  )
    throw new PosSyncError('INVALID_REQUEST');
  return event;
}
export const receiptFor = (event: PosOrderEvent) => ({
  eventId: event.event_id,
  branchId: event.branch_id,
  producerId: event.producer_id,
  sequence: event.producer_sequence,
  payloadHash: hashJson(event),
  acknowledged: true as const,
});
