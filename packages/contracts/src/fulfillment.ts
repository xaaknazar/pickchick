import { z } from 'zod';

const uuid = z.uuid();
const version = z.int().positive().max(2147483647);
const reference = z.string().min(1).max(160);
const bilingual = z.strictObject({ ru: z.string().min(1).max(250), kk: z.string().max(250) });
const number = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
export const FulfillmentConfigSchema = z.strictObject({ enabled: z.boolean() });
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
    modifiers: z.array(FulfillmentModifierSchema).max(40),
  }),
});
export const FulfillmentKitchenOrderSchema = FulfillmentSummarySchema.extend({
  assemblyStationId: uuid,
  channel: z.literal('mobile'),
  serviceMode: z.enum(['takeaway', 'dine_in']),
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
  items: z.array(z.strictObject({ number, state: z.enum(['preparing', 'ready']) })).max(100),
  nextAfterNumber: number.nullable(),
});
const taskAction = z.strictObject({
  action: z.enum(['start_task', 'complete_task', 'confirm_stop']),
  expectedVersion: version,
  taskId: uuid,
  expectedTaskVersion: version,
});
export const FulfillmentActionSchema = z.discriminatedUnion('action', [
  taskAction,
  z.strictObject({ action: z.enum(['ready', 'handoff']), expectedVersion: version }),
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
