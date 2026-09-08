import { z } from 'zod';

export const UuidSchema = z.uuid();
export const MoneyMinorSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine(
    (value) => /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n,
    'Exceeds PostgreSQL bigint',
  );

export const LocalizedTextSchema = z.strictObject({
  ru: z.string().trim().min(1).max(300),
  kk: z.string().trim().min(1).max(300),
});

export const BranchSchema = z.strictObject({
  id: UuidSchema,
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  timezone: z.literal('Asia/Almaty'),
  ordering_enabled: z.boolean(),
});

export const CapabilitiesSchema = z.strictObject({
  schema_version: z.literal(1),
  environment: z.enum(['local', 'test', 'staging']),
  data_mode: z.literal('synthetic'),
  ordering_enabled: z.literal(false),
  features: z.strictObject({
    phone_auth: z.literal(false),
    checkout: z.literal(false),
    payments: z.literal(false),
    fiscal: z.literal(false),
    loyalty: z.literal(false),
    test_order_flow: z.boolean(),
  }),
  notice: LocalizedTextSchema,
});

export const MenuItemSchema = z.strictObject({
  product_id: UuidSchema,
  variant_id: UuidSchema,
  category_id: UuidSchema,
  name: LocalizedTextSchema,
  price_minor: MoneyMinorSchema,
  currency: z.literal('KZT'),
});

export const MenuSnapshotSchema = z.strictObject({
  schema_version: z.literal(1),
  release_id: UuidSchema,
  branch_id: UuidSchema,
  version: z.number().int().positive().max(2147483647),
  published_at: z.iso.datetime(),
  items: z.array(MenuItemSchema).max(10000),
});

export const HealthSchema = z.strictObject({
  service: z.enum(['api', 'edge']),
  alive: z.literal(true),
});

export const ReadinessSchema = z.strictObject({
  service: z.enum(['api', 'edge']),
  ready: z.boolean(),
  degraded: z.boolean(),
  dependencies: z.strictObject({
    database: z.enum(['up', 'down']),
    schema: z.enum(['up', 'down']),
    redis: z.enum(['up', 'down', 'not_required']),
  }),
});

export const ErrorSchema = z.strictObject({
  code: z.enum([
    'INVALID_REQUEST',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'QUOTE_EXPIRED',
    'MENU_CHANGED',
    'BRANCH_UNAVAILABLE',
    'ITEM_STOPPED',
    'CONFLICT',
    'INSUFFICIENT_STOCK',
    'NOT_READY',
    'PAYLOAD_TOO_LARGE',
    'NOT_FOUND',
    'SERVICE_UNAVAILABLE',
    'RATE_LIMITED',
    'INTERNAL_ERROR',
  ]),
  message_key: z.string(),
  trace_id: UuidSchema,
  retryable: z.boolean(),
});

export const EventEnvelopeSchema = z.strictObject({
  event_id: UuidSchema,
  producer_id: UuidSchema,
  producer_sequence: MoneyMinorSchema.refine((value) => value !== '0', 'Must be positive'),
  aggregate_type: z.enum(['menu_release', 'order_commercial', 'order_fulfillment']),
  aggregate_id: UuidSchema,
  aggregate_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  event_type: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
  schema_version: z.literal(1),
  branch_id: UuidSchema,
  occurred_at: z.iso.datetime(),
  correlation_id: UuidSchema,
  causation_id: UuidSchema.nullable(),
  payload: z.record(z.string(), z.unknown()),
});

export type Branch = z.infer<typeof BranchSchema>;
export type MenuSnapshot = z.infer<typeof MenuSnapshotSchema>;
export type Readiness = z.infer<typeof ReadinessSchema>;

export const ChecksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const DeviceIdentitySchema = z.strictObject({
  device_id: UuidSchema,
  branch_id: UuidSchema,
  token: z.string().regex(/^[a-f0-9]{64}$/),
  expires_at: z.iso.datetime(),
});
export const MenuPublishedSchema = EventEnvelopeSchema.extend({
  aggregate_type: z.literal('menu_release'),
  event_type: z.literal('menu.published'),
  payload: z.strictObject({ menu: MenuSnapshotSchema, checksum: ChecksumSchema }),
});
export const MenuPullSchema = z.strictObject({ event: MenuPublishedSchema.nullable() });
export const MenuAckSchema = z.strictObject({
  event_id: UuidSchema,
  producer_id: UuidSchema,
  producer_sequence: MoneyMinorSchema.refine((value) => value !== '0', 'Must be positive'),
  branch_id: UuidSchema,
  release_id: UuidSchema,
  checksum: ChecksumSchema,
});
export const AckReceiptSchema = z.strictObject({
  event_id: UuidSchema,
  acknowledged: z.literal(true),
});
export type DeviceIdentity = z.infer<typeof DeviceIdentitySchema>;
export type MenuPublished = z.infer<typeof MenuPublishedSchema>;
export type MenuAck = z.infer<typeof MenuAckSchema>;

export const StaffRoleSchema = z.enum(['cashier', 'shift_manager', 'kitchen']);
export const StaffSetupSchema = z.strictObject({
  staff_id: UuidSchema,
  terminal_id: UuidSchema,
  name: z.string().trim().min(1).max(100),
  role: StaffRoleSchema,
});
export const StaffSessionSchema = z.strictObject({
  session_id: UuidSchema,
  staff_id: UuidSchema,
  terminal_id: UuidSchema,
  branch_id: UuidSchema,
  role: StaffRoleSchema,
  expires_at: z.iso.datetime(),
});
export const StaffCredentialSchema = StaffSessionSchema.extend({
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
export const CartSchema = z.strictObject({
  release_id: UuidSchema,
  service_mode: z.enum(['dine_in', 'takeaway']),
  items: z
    .array(z.strictObject({ variant_id: UuidSchema, quantity: z.number().int().min(1).max(99) }))
    .min(1)
    .max(50),
});
export const QuoteLineSchema = z.strictObject({
  product_id: UuidSchema,
  variant_id: UuidSchema,
  name: LocalizedTextSchema,
  quantity: z.number().int().min(1).max(99),
  unit_price_minor: MoneyMinorSchema,
  total_minor: MoneyMinorSchema,
});
export const QuoteSchema = z.strictObject({
  quote_id: UuidSchema,
  branch_id: UuidSchema,
  release_id: UuidSchema,
  menu_version: z.number().int().positive().max(2147483647),
  service_mode: z.enum(['dine_in', 'takeaway']),
  channel: z.literal('pos'),
  lines: z.array(QuoteLineSchema).min(1).max(50),
  currency: z.literal('KZT'),
  subtotal_minor: MoneyMinorSchema,
  discount_minor: z.literal('0'),
  total_minor: MoneyMinorSchema,
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
});
export const CreateLocalOrderSchema = z.strictObject({ quote_id: UuidSchema });
export const CancelLocalOrderSchema = z.strictObject({
  expected_version: z.number().int().positive().max(2147483647),
  reason: z.string().trim().min(1).max(300),
});
export const LocalOrderSchema = z.strictObject({
  order_id: UuidSchema,
  branch_id: UuidSchema,
  quote_id: UuidSchema,
  version: z.number().int().positive().max(2147483647),
  state: z.enum(['awaiting_payment', 'cancelled']),
  payment_state: z.literal('not_started'),
  fiscal_state: z.literal('not_requested'),
  fulfillment_state: z.literal('blocked'),
  next_action: z.enum(['payment_not_available', 'none']),
  snapshot: QuoteSchema,
  created_at: z.iso.datetime(),
  cancellation_reason: z.string().nullable(),
});
export const OrderingCommandSchema = z.strictObject({
  expected_version: z.number().int().positive().max(2147483647),
});
export const OrderingStateSchema = z.strictObject({
  branch_id: UuidSchema,
  ordering_enabled: z.boolean(),
  version: z.number().int().positive().max(2147483647),
});
export const StopCommandSchema = z.strictObject({
  variant_id: UuidSchema,
  stopped: z.boolean(),
  expected_version: z.number().int().nonnegative().max(2147483647),
  reason: z.string().trim().min(1).max(300),
});
export const StopStateSchema = z.strictObject({
  variant_id: UuidSchema,
  stopped: z.boolean(),
  version: z.number().int().nonnegative().max(2147483647),
});
export type StaffSession = z.infer<typeof StaffSessionSchema>;
export type StaffCredential = z.infer<typeof StaffCredentialSchema>;
export type StaffRole = z.infer<typeof StaffRoleSchema>;
export type Cart = z.infer<typeof CartSchema>;
export type Quote = z.infer<typeof QuoteSchema>;
export type LocalOrder = z.infer<typeof LocalOrderSchema>;

// OpenAPI and event JSON Schema are generated from these runtime schemas.
export const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema);

export * from './fulfillment.js';
