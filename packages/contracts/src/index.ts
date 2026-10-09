import { z } from 'zod';
import { TerminalPairRequestSchema } from './device-access.js';

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
  data_mode: z.enum(['synthetic', 'pilot']),
  ordering_enabled: z.literal(false),
  features: z.strictObject({
    phone_auth: z.boolean(),
    checkout: z.literal(false),
    payments: z.literal(false),
    fiscal: z.literal(false),
    loyalty: z.literal(false),
    test_order_flow: z.boolean(),
    unpaid_test_orders: z.boolean().optional(),
  }),
  notice: LocalizedTextSchema,
});

export const MenuModifierOptionSchema = z
  .strictObject({
    id: UuidSchema,
    name: LocalizedTextSchema,
    price_minor: MoneyMinorSchema,
    max_quantity: z.number().int().min(1).max(99).optional(),
    default_quantity: z.number().int().min(0).max(99).optional(),
    available: z.boolean().optional(),
  })
  .refine(
    (option) =>
      (option.default_quantity ?? 0) <= (option.max_quantity ?? 1) &&
      (option.available !== false || !option.default_quantity),
    'Invalid option defaults',
  );
export const MenuModifierGroupSchema = z
  .strictObject({
    id: UuidSchema,
    name: LocalizedTextSchema,
    min_selected: z.number().int().min(0).max(99),
    max_selected: z.number().int().min(1).max(99),
    options: z.array(MenuModifierOptionSchema).min(1).max(20),
  })
  .refine(
    (group) =>
      group.min_selected <= group.max_selected &&
      group.max_selected <=
        group.options.reduce((sum, option) => sum + (option.max_quantity ?? 1), 0) &&
      group.options.reduce((sum, option) => sum + (option.default_quantity ?? 0), 0) <=
        group.max_selected &&
      new Set(group.options.map((option) => option.id)).size === group.options.length,
    'Invalid modifier group',
  );

/** Catalog slug shared by the back-office, storefronts and the edge (never rehashed). */
export const MenuSourceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export const MenuSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
/** Optional long text; Kazakh may stay empty until the operator translates it. */
export const MenuDescriptionSchema = z.strictObject({
  ru: z.string().max(2000).regex(/\S/),
  kk: z.string().max(2000),
});
/** Content-addressed WebP served by the edge at the exact hash path. */
export const MenuItemImageSchema = z
  .strictObject({
    sha256: MenuSha256Schema,
    url: z.string().regex(/^\/assets\/menu\/[a-f0-9]{64}\.webp$/),
  })
  .refine((image) => image.url === `/assets/menu/${image.sha256}.webp`, 'Image URL/hash mismatch');
export const MenuKitchenRouteSchema = z.enum(['prep', 'assembly_item']);
export const MenuItemKitchenSchema = z.strictObject({
  route: MenuKitchenRouteSchema,
  unexpanded_combo: z.literal('whole_product').optional(),
});
export const MenuItemKindSchema = z.enum(['item', 'combo', 'set']);

export const MenuItemSchema = z
  .strictObject({
    product_id: UuidSchema,
    variant_id: UuidSchema,
    category_id: UuidSchema,
    name: LocalizedTextSchema,
    price_minor: MoneyMinorSchema,
    currency: z.literal('KZT'),
    image_url: z
      .string()
      .max(2048)
      .regex(/^(?:https:\/\/[^\s]+|\/(?!\/)[^\s]*)$/)
      .optional(),
    modifier_groups: z
      .array(MenuModifierGroupSchema)
      .max(20)
      .refine(
        (groups) => new Set(groups.map((group) => group.id)).size === groups.length,
        'Duplicate modifier groups',
      )
      .optional(),
    // Optional unified-menu fields: installed POS/edge parsers ignore or never receive them.
    source_id: MenuSourceIdSchema.optional(),
    sku: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
      .optional(),
    kind: MenuItemKindSchema.optional(),
    sort_order: z.number().int().min(0).max(100000).optional(),
    description: MenuDescriptionSchema.optional(),
    image: MenuItemImageSchema.optional(),
    kitchen: MenuItemKitchenSchema.optional(),
  })
  .refine(
    (item) => !item.image || item.image_url === item.image.url,
    'Published image must be the item image_url',
  );

export const MenuCategorySchema = z.strictObject({
  id: UuidSchema,
  source_id: MenuSourceIdSchema,
  name: LocalizedTextSchema,
  sort_order: z.number().int().min(0).max(100000),
});

export const MenuSnapshotSchema = z
  .strictObject({
    schema_version: z.literal(1),
    release_id: UuidSchema,
    branch_id: UuidSchema,
    version: z.number().int().positive().max(2147483647),
    published_at: z.iso.datetime(),
    items: z.array(MenuItemSchema).max(10000),
    categories: z.array(MenuCategorySchema).max(200).optional(),
  })
  .superRefine((menu, ctx) => {
    if (!menu.categories) return;
    const ids = new Set(menu.categories.map((category) => category.id));
    if (ids.size !== menu.categories.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate menu categories' });
    if (menu.items.some((item) => !ids.has(item.category_id)))
      ctx.addIssue({ code: 'custom', message: 'Item category missing from categories' });
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
    'CATALOG_UPGRADE_REQUIRED',
    'INVALID_REQUEST',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'QUOTE_EXPIRED',
    'MENU_CHANGED',
    'BRANCH_UNAVAILABLE',
    'ITEM_STOPPED',
    'CASH_SHIFT_REQUIRED',
    'SHIFT_CLOSED',
    'CONFLICT',
    'INSUFFICIENT_STOCK',
    'NOT_READY',
    'PAYLOAD_TOO_LARGE',
    'NOT_FOUND',
    'SERVICE_UNAVAILABLE',
    'RATE_LIMITED',
    'AUTH_RATE_LIMITED',
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
export const MenuAckResultSchema = z.enum(['applied', 'rejected']);
export const MenuRejectReasonSchema = z.enum([
  'ROUTING_UNRESOLVED',
  'VERSION_NOT_NEWER',
  'MEDIA_UNAVAILABLE',
  'INVALID_MENU',
]);
/**
 * `result` is optional and an absent value means `applied`. It is deliberately not
 * materialised by a zod default: applied ACKs stay byte-identical to the ACKs that
 * installed edges and clouds already hash and store (idempotent replay compares hashes).
 */
export const MenuAckSchema = z
  .strictObject({
    event_id: UuidSchema,
    producer_id: UuidSchema,
    producer_sequence: MoneyMinorSchema.refine((value) => value !== '0', 'Must be positive'),
    branch_id: UuidSchema,
    release_id: UuidSchema,
    checksum: ChecksumSchema,
    result: MenuAckResultSchema.optional(),
    reason: MenuRejectReasonSchema.optional(),
  })
  .refine(
    (ack) => (ack.result === 'rejected') === (ack.reason !== undefined),
    'A rejected menu ACK requires a reason; an applied ACK must not carry one',
  );
export function menuAckResult(ack: Pick<z.infer<typeof MenuAckSchema>, 'result'>) {
  return ack.result ?? 'applied';
}
/** Active edge menu reported by the menu worker as query params on every pull. */
const QueryInt = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^(0|[1-9][0-9]{0,9})$/)
    .transform(Number),
]);
export const EdgeMenuStateQuerySchema = z.strictObject({
  active_release_id: UuidSchema,
  active_version: QueryInt.pipe(z.number().int().positive().max(2147483647)),
});
export const AckReceiptSchema = z.strictObject({
  event_id: UuidSchema,
  acknowledged: z.literal(true),
});
export type DeviceIdentity = z.infer<typeof DeviceIdentitySchema>;
export type MenuPublished = z.infer<typeof MenuPublishedSchema>;
export type MenuAck = z.infer<typeof MenuAckSchema>;
export type MenuAckResult = z.infer<typeof MenuAckResultSchema>;
export type MenuRejectReason = z.infer<typeof MenuRejectReasonSchema>;
export type EdgeMenuStateQuery = z.infer<typeof EdgeMenuStateQuerySchema>;
export type MenuItem = z.infer<typeof MenuItemSchema>;
export type MenuCategory = z.infer<typeof MenuCategorySchema>;

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
  name: z.string().min(1).max(100).optional(),
  expires_at: z.iso.datetime(),
});
export const StaffCredentialSchema = StaffSessionSchema.extend({
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
// Passwords are deliberately never transformed or included in validation errors at HTTP boundaries.
export const StaffLoginNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/);
export const StaffPinLoginSchema = z.strictObject({
  pin: z.string().regex(/^[0-9]{4}$/),
  terminal_id: UuidSchema,
});
export const StaffPasswordSchema = z.string().min(12).max(128);
export const KitchenPasswordResetRequestSchema = z.strictObject({
  code: TerminalPairRequestSchema.shape.code,
  password: StaffPasswordSchema,
  terminal_id: UuidSchema,
});
export const StaffLoginSchema = z.strictObject({
  login: StaffLoginNameSchema,
  password: StaffPasswordSchema,
  terminal_id: UuidSchema,
});
export type StaffLogin = z.infer<typeof StaffLoginSchema>;

export const ModifierSelectionSchema = z.strictObject({
  group_id: UuidSchema,
  option_id: UuidSchema,
  quantity: z.number().int().min(1).max(99).optional(),
});
export const QuoteModifierSchema = ModifierSelectionSchema.extend({
  group_name: LocalizedTextSchema,
  name: LocalizedTextSchema,
  price_minor: MoneyMinorSchema,
});
export const PosOrderDetailsSchema = z.strictObject({
  display_name: z.string().trim().max(14),
  kitchen_comment: z.string().trim().max(60),
});
export const CartSchema = z.strictObject({
  details: PosOrderDetailsSchema.optional(),
  release_id: UuidSchema,
  service_mode: z.enum(['dine_in', 'takeaway']),
  items: z
    .array(
      z.strictObject({
        variant_id: UuidSchema,
        quantity: z.number().int().min(1).max(99),
        modifiers: z.array(ModifierSelectionSchema).max(100).optional(),
      }),
    )
    .min(1)
    .max(50),
});
export const QuoteLineSchema = z.strictObject({
  modifiers: z.array(QuoteModifierSchema).max(100).optional(),
  product_id: UuidSchema,
  variant_id: UuidSchema,
  name: LocalizedTextSchema,
  quantity: z.number().int().min(1).max(99),
  unit_price_minor: MoneyMinorSchema,
  total_minor: MoneyMinorSchema,
});
export const QuoteSchema = z.strictObject({
  details: PosOrderDetailsSchema.optional(),
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
export const CreateLocalOrderSchema = z.strictObject({
  quote_id: UuidSchema,
  kitchen_admission: z.literal('unpaid').optional(),
});
export const LocalFulfillmentStateSchema = z.enum([
  'accepted',
  'in_production',
  'ready',
  'handed_over',
  'cancel_requested',
  'cancelled',
]);
export const LocalFulfillmentSchema = z.strictObject({
  version: z.number().int().positive().max(2147483647),
  display_number: MoneyMinorSchema.refine((value) => BigInt(value) > 0n),
  state: LocalFulfillmentStateSchema,
});
export const CancelLocalOrderSchema = z.strictObject({
  expected_version: z.number().int().positive().max(2147483647),
  reason: z.string().trim().min(1).max(300),
});
export const LocalOrderSchema = z.strictObject({
  cash_shift_id: UuidSchema.nullable().optional(),
  order_id: UuidSchema,
  branch_id: UuidSchema,
  quote_id: UuidSchema,
  version: z.number().int().positive().max(2147483647),
  state: z.enum(['awaiting_payment', 'cancelled']),
  payment_state: z.literal('not_started'),
  fiscal_state: z.literal('not_requested'),
  fulfillment_state: z.union([z.literal('blocked'), LocalFulfillmentStateSchema]),
  execution_mode: z.literal('unpaid_service').optional(),
  fulfillment: LocalFulfillmentSchema.optional(),
  next_action: z.enum(['payment_not_available', 'none']),
  snapshot: QuoteSchema,
  created_at: z.iso.datetime(),
  cancellation_reason: z.string().nullable(),
});
export const OrderingCommandSchema = z.strictObject({
  expected_version: z.number().int().positive().max(2147483647),
});
export const OrderingStateSchema = z.strictObject({
  pos_service_mode: z.enum(['payment_required', 'unpaid_service']).optional(),
  branch_id: UuidSchema,
  ordering_enabled: z.boolean(),
  version: z.number().int().positive().max(2147483647),
});
export const StopCommandSchema = z.strictObject({
  duration: z.enum(['manual', 'hour', 'shift']).optional(),
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
export const StopListSchema = z.strictObject({ stops: z.array(StopStateSchema).max(10000) });
export type StaffSession = z.infer<typeof StaffSessionSchema>;
export type StaffCredential = z.infer<typeof StaffCredentialSchema>;
export type StaffRole = z.infer<typeof StaffRoleSchema>;
export type Cart = z.infer<typeof CartSchema>;
export type Quote = z.infer<typeof QuoteSchema>;
export type LocalOrder = z.infer<typeof LocalOrderSchema>;

export const CashShiftOpenSchema = z.strictObject({ opening_cash_minor: MoneyMinorSchema });
export const CashShiftCloseSchema = z.strictObject({
  expected_version: z.number().int().positive().max(2147483647),
  counted_cash_minor: MoneyMinorSchema,
  reason: z.string().trim().min(1).max(300),
});
export const CashMovementInputSchema = z.strictObject({
  direction: z.enum(['in', 'out']),
  amount_minor: MoneyMinorSchema.refine((v) => BigInt(v) > 0n),
  reason: z.string().trim().min(1).max(300),
});
export const CashMovementSchema = CashMovementInputSchema.extend({
  id: UuidSchema,
  staff_id: UuidSchema,
  created_at: z.iso.datetime(),
});
export const CashShiftSchema = z.strictObject({
  shift_id: UuidSchema,
  branch_id: UuidSchema,
  terminal_id: UuidSchema,
  staff_id: UuidSchema,
  version: z.number().int().positive().max(2147483647),
  state: z.enum(['open', 'closed']),
  opened_at: z.iso.datetime(),
  closed_at: z.iso.datetime().nullable(),
  closed_by_staff_id: UuidSchema.nullable(),
  opening_cash_minor: MoneyMinorSchema,
  expected_cash_minor: MoneyMinorSchema,
  cash_movements: z.array(CashMovementSchema).max(1000).optional(),
  counted_cash_minor: MoneyMinorSchema.nullable(),
  discrepancy_minor: z
    .string()
    .regex(/^(?:0|-?[1-9]\d{0,18})$/)
    .refine(
      (value) =>
        /^(?:0|-?[1-9]\d{0,18})$/.test(value) &&
        BigInt(value) >= -9223372036854775807n &&
        BigInt(value) <= 9223372036854775807n,
    )
    .nullable(),
  closing_reason: z.string().nullable(),
  currency: z.literal('KZT'),
  order_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  awaiting_payment_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cancelled_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  order_total_minor: MoneyMinorSchema,
  unpaid_total_minor: MoneyMinorSchema,
  cash_received_minor: z.literal('0'),
  cash_refunded_minor: z.literal('0'),
  payment_processing_available: z.literal(false),
  report_at: z.iso.datetime(),
});
export const CashShiftCurrentSchema = z.strictObject({
  shift: CashShiftSchema.nullable(),
  server_time: z.iso.datetime(),
});
export const CashShiftListSchema = z.strictObject({
  shifts: z.array(CashShiftSchema).max(50),
  server_time: z.iso.datetime(),
});
export const LocalOrderListSchema = z.strictObject({
  orders: z.array(LocalOrderSchema).max(100),
  server_time: z.iso.datetime(),
});
export type CashShift = z.infer<typeof CashShiftSchema>;

// OpenAPI and event JSON Schema are generated from these runtime schemas.
export const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema);

export * from './fulfillment.js';

export * from './customer-commerce.js';

export * from './device-access.js';
