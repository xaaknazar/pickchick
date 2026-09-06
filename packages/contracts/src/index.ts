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
    'CONFLICT',
    'PAYLOAD_TOO_LARGE',
    'NOT_FOUND',
    'SERVICE_UNAVAILABLE',
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

// OpenAPI and event JSON Schema are generated from these runtime schemas.
export const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema);
