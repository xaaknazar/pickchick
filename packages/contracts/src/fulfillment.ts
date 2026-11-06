import { z } from 'zod';
import { AggregatorChannelSchema, KdsFunctionSchema, KdsUnitSchema } from './cutover-enums.js';

const uuid = z.uuid();
const version = z.int().positive().max(2147483647);
const reference = z.string().min(1).max(160);
const bilingual = z.strictObject({ ru: z.string().min(1).max(250), kk: z.string().max(250) });
const number = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
export const FulfillmentConfigSchema = z.strictObject({
  enabled: z.boolean(),
  wholeTicketActions: z.boolean().optional(),
});
export const FulfillmentSummarySchema = z.strictObject({
  orderId: uuid,
  branchId: uuid,
  version,
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
  displayNumber: number.nullable(),
  routingVersion: version,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const FulfillmentModifierSchema = z.strictObject({
  groupId: reference,
  groupTitle: bilingual,
  optionId: reference,
  label: bilingual,
  quantity: z.int().min(1).max(1_000_000),
  linkedProductId: reference.nullable(),
});
/**
 * Cutover KDS (contracts section 5.4). Frozen into a task at admission while the edge KDS layout
 * is enabled; absent otherwise, so installed kitchen clients never see it. upstreamOf: the
 * assembly table station whose complete_station also closes this task; units/unit: toasts or
 * burgers to make at station 5; fingers: breaded fingers of this line; unmapped: the product has
 * no place in the layout and went to the table ("Нет в раскладке").
 */
export const FulfillmentTaskKdsSchema = z.strictObject({
  function: KdsFunctionSchema,
  upstreamOf: uuid.optional(),
  units: z.int().min(1).max(1_000_000).optional(),
  unit: KdsUnitSchema.optional(),
  fingers: z.int().min(1).max(1_000_000).optional(),
  unmapped: z.literal(true).optional(),
});
/** Aggregator order of a kitchen ticket (snapshot.delivery); the edge stores the number upper-case. */
export const FulfillmentDeliverySchema = z.strictObject({
  provider: AggregatorChannelSchema,
  externalNumber: z.string().regex(/^[A-Z0-9-]{3,40}$/),
});
export const FulfillmentTaskSchema = z.strictObject({
  taskId: uuid,
  stationId: uuid,
  version,
  state: z.enum(['queued', 'in_progress', 'done', 'cancel_requested', 'cancelled']),
  kind: z.enum(['prep', 'assembly_item']),
  details: z.strictObject({
    lineId: uuid,
    productId: reference,
    title: z.string().min(1).max(250),
    parentTitle: z.string().min(1).max(250),
    description: z.string().max(2000),
    quantity: z.int().min(1).max(1_000_000),
    modifiers: z.array(FulfillmentModifierSchema).max(100),
    kds: FulfillmentTaskKdsSchema.optional(),
  }),
});
export const FulfillmentKitchenOrderSchema = FulfillmentSummarySchema.extend({
  restoreReview: z
    .strictObject({ epoch: z.int().min(2), status: z.enum(['pending', 'resume', 'retire']) })
    .optional(),
  assemblyStationId: uuid,
  channel: z.enum(['mobile', 'kiosk', 'pos']),
  serviceMode: z.enum(['takeaway', 'dine_in']),
  kitchenComment: z.string().max(60).optional(),
  /** Only while the KDS layout is enabled (contracts section 5.4). */
  delivery: FulfillmentDeliverySchema.optional(),
  tasks: z.array(FulfillmentTaskSchema).max(2000),
});
export const FulfillmentOrderSchema = FulfillmentKitchenOrderSchema.extend({
  cancellationReason: z.string().min(1).max(500).nullable(),
  inventoryDisposition: z.enum(['requires_inventory_review', 'recorded_elsewhere']).nullable(),
});
export const FulfillmentKitchenSchema = z.strictObject({
  items: z.array(FulfillmentKitchenOrderSchema).max(100),
  nextAfterOrderId: uuid.nullable(),
});
export const FulfillmentStationsSchema = z.strictObject({
  branchId: uuid,
  items: z
    .array(
      z.strictObject({
        id: uuid,
        kind: z.enum(['prep', 'assembly']),
        name: z.string().min(1).max(100),
      }),
    )
    .max(100),
});
export const FulfillmentDisplaySchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        number,
        name: z.string().max(14).optional(),
        state: z.enum(['preparing', 'ready']),
      }),
    )
    .max(100),
  nextAfterNumber: number.nullable(),
});
/** The three courier handover marks; each must be confirmed (contracts section 5.4). */
export const FulfillmentHandoverSchema = z.strictObject({
  numberMatched: z.literal(true),
  courierAccepted: z.literal(true),
  photoTaken: z.literal(true),
});
const taskAction = z.strictObject({
  action: z.enum(['start_task', 'complete_task', 'confirm_stop']),
  expectedVersion: version,
  taskId: uuid,
  expectedTaskVersion: version,
});
export const FulfillmentActionSchema = z.discriminatedUnion('action', [
  taskAction,
  z.strictObject({
    action: z.literal('complete_station'),
    expectedVersion: version,
    stationId: uuid,
  }),
  z.strictObject({ action: z.literal('ready'), expectedVersion: version }),
  z.strictObject({
    action: z.literal('handoff'),
    expectedVersion: version,
    /** Courier handover protocol (Аг9); the edge requires it for a delivery order. */
    handover: FulfillmentHandoverSchema.optional(),
  }),
  z.strictObject({
    action: z.literal('confirm_cancel'),
    expectedVersion: version,
    reason: z.string().trim().min(1).max(500),
    inventoryDisposition: z.enum(['requires_inventory_review', 'recorded_elsewhere']),
  }),
]);
export type FulfillmentSummary = z.infer<typeof FulfillmentSummarySchema>;
export type FulfillmentTask = z.infer<typeof FulfillmentTaskSchema>;
export type FulfillmentOrder = z.infer<typeof FulfillmentOrderSchema>;
export type FulfillmentAction = z.infer<typeof FulfillmentActionSchema>;
export type FulfillmentTaskKds = z.infer<typeof FulfillmentTaskKdsSchema>;
export type FulfillmentDelivery = z.infer<typeof FulfillmentDeliverySchema>;
export type FulfillmentHandover = z.infer<typeof FulfillmentHandoverSchema>;

/** Manager-only reconciliation of a restored local ticket. Never authorizes payment. */
export const FulfillmentRestoreDecisionSchema = z.strictObject({
  commandId: uuid,
  epoch: z.int().min(2),
  expectedVersion: version,
  decision: z.enum(['resume', 'retire']),
  reason: z.string().trim().min(3).max(500),
});
export const FulfillmentRestoreResultSchema = z.strictObject({
  epoch: z.int().min(2),
  status: z.enum(['resume', 'retire']),
});
