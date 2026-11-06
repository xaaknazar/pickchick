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
    /**
     * Cashier combo stop rule (stage 2, optional): the menu variant of the product this option
     * stands for (a combo drink or sauce). Its stop stops the option. Sent only to edges that
     * advertise the combo_stops menu feature; installed edges parse strictly and never get it.
     */
    linked_variant_id: UuidSchema.optional(),
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

/**
 * Aggregator prices of one menu item (cutover Аг4). A key is present only when the item is sold
 * in that aggregator channel; the own-channel price stays price_minor. Sent only to edges that
 * advertise the aggregator_prices menu feature; installed edges parse strictly and never get it.
 */
export const MenuAggregatorPricesSchema = z
  .strictObject({ yandex_eda: MoneyMinorSchema.optional(), glovo: MoneyMinorSchema.optional() })
  .refine((prices) => Object.keys(prices).length > 0, 'Empty aggregator prices');

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
    aggregator_prices_minor: MenuAggregatorPricesSchema.optional(),
    sku: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
      .optional(),
    kind: MenuItemKindSchema.optional(),
    sort_order: z.number().int().min(0).max(100000).optional(),
    description: MenuDescriptionSchema.optional(),
    image: MenuItemImageSchema.optional(),
    kitchen: MenuItemKitchenSchema.optional(),
    /**
     * Cashier combo stop rule (stage 2, optional): menu variants of every fixed component,
     * nested combos already flattened. A stop of any of them stops this combo. Never empty
     * (one canonical form keeps checksums stable); same delivery rule as linked_variant_id.
     */
    combo_component_variant_ids: z.array(UuidSchema).min(1).max(100).optional(),
  })
  .refine(
    (item) => !item.image || item.image_url === item.image.url,
    'Published image must be the item image_url',
  )
  .refine(
    (item) =>
      !item.combo_component_variant_ids ||
      (new Set(item.combo_component_variant_ids).size === item.combo_component_variant_ids.length &&
        !item.combo_component_variant_ids.includes(item.variant_id)),
    'Invalid combo components',
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
    'RESTAURANT_CLOSED',
    'AVAILABILITY_STALE',
    'BRANCH_UNAVAILABLE',
    'ITEM_STOPPED',
    // Cloud-mode branch whose kitchen screens stopped polling (ADR-0014). Sent only to clients
    // that list the checkout-errors-v2 profile: older bundles reject unknown codes.
    'KITCHEN_OFFLINE',
    'CASH_SHIFT_REQUIRED',
    // Cashier edge only (local-orders): the POS explains each one; without them in this list the
    // error filter answered a bare CONFLICT (offline stand finding, 24.10). Cloud routes never
    // send them, so the app and kiosk bundles see no new code.
    'SERVICE_MODE_DISABLED',
    'KITCHEN_UNAVAILABLE',
    'ORDER_IN_PRODUCTION',
    // Cashier edge pos_sale routes only (contracts 5.1, PosErrorCodeSchema in pos-sales.ts; CR
    // pos-1 section 2, CR client-4 section 1); cloud routes never send them.
    'METHOD_DISABLED',
    'TENDER_SUM_MISMATCH',
    'CASH_TENDERED_TOO_LOW',
    'TERMINAL_AMOUNT_NOT_WHOLE',
    'CHANNEL_PRICE_UNAVAILABLE',
    'EXTERNAL_REF_REQUIRED',
    'EXTERNAL_REF_DUPLICATE',
    'APPROVAL_REQUIRED',
    'APPROVAL_INVALID',
    'REFUND_LIMIT',
    'REFUND_NOT_SUPPORTED',
    'DRAWER_INSUFFICIENT',
    'FISCAL_PENDING',
    'SHIFT_CLOSED',
    // Kitchen edge only (cutover KDS-4, CR kds-6): handoff of a delivery order without the three
    // courier marks. Only kitchen clients with the KDS layout send marks; cloud routes never
    // answer it.
    'HANDOVER_MARKS_REQUIRED',
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
/**
 * Optional menu features an edge menu worker understands, sent on every pull as the
 * comma-separated query key `menu_features` (outside EdgeMenuStateQuerySchema). Installed clouds
 * ignore unknown query keys and installed edges never send it; a cloud ignores values it does
 * not know. combo_stops: the edge applies combo_component_variant_ids / linked_variant_id.
 * aggregator_prices: the edge prices aggregator channels from aggregator_prices_minor.
 */
export const EdgeMenuFeatureSchema = z.enum(['combo_stops', 'aggregator_prices']);
export const EDGE_MENU_FEATURES_QUERY_KEY = 'menu_features';
export type EdgeMenuFeature = z.infer<typeof EdgeMenuFeatureSchema>;
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
  // 4 digits, or 6 for PINs issued with staff-pin-setup --digits 6 (release fixes 19.10, 6.5).
  pin: z.string().regex(/^(?:[0-9]{4}|[0-9]{6})$/),
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
// cutover:pos - the POS region imports the shared enums and the sale schemas it extends
// (contracts 4.2: the pos lane edits only this region of index.ts; imports are hoisted).
import {
  AggregatorChannelSchema,
  PosServiceModeSchema,
  SalesChannelSchema,
} from './cutover-enums.js';
import { PosApprovalProofSchema, PosSaleSchema } from './pos-sales.js';
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
  // Cutover: aggregator quote of a pos_sale (absent = hall; hall quotes stay byte-identical).
  sales_channel: AggregatorChannelSchema.optional(),
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
  // Cutover (contracts 5.1): a pos_sale order is paid and captured from version 1; every other
  // order keeps awaiting_payment/cancelled and not_started. Receipts live in the sale, not here.
  state: z.enum(['awaiting_payment', 'cancelled', 'paid']),
  payment_state: z.enum(['not_started', 'captured']),
  fiscal_state: z.literal('not_requested'),
  fulfillment_state: z.union([z.literal('blocked'), LocalFulfillmentStateSchema]),
  execution_mode: z.enum(['unpaid_service', 'pos_sale']).optional(),
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
  pos_service_mode: PosServiceModeSchema.optional(),
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
/**
 * GET edge/v1/cloud-link: the cashier edge's last confirmed contact with the cloud (WAN), taken
 * from the fulfillment transport heartbeat. 'unknown': no transport on this edge yet or the
 * runtime role lacks the opt-in grant; installed clients that never ask are unaffected.
 */
export const EdgeCloudLinkSchema = z.strictObject({
  state: z.enum(['online', 'offline', 'unknown']),
  last_contact_at: z.iso.datetime().nullable(),
  checked_at: z.iso.datetime(),
});
export type EdgeCloudLink = z.infer<typeof EdgeCloudLinkSchema>;
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
  // Cutover (contracts 5.1): money of a sales_mode shift; every other shift keeps '0', '0', false.
  cash_received_minor: MoneyMinorSchema,
  cash_refunded_minor: MoneyMinorSchema,
  payment_processing_available: z.boolean(),
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
// cutover:pos - requests and results of contracts 5.1 that extend the schemas above. Not routed
// until the pos_sale controller; the original schemas keep serving the unpaid POS unchanged.
/** POST checkout/quotes in pos_sale: CartSchema + sales_channel ('hall' = field absent). */
export const PosQuoteRequestSchema = CartSchema.extend({
  sales_channel: SalesChannelSchema.optional(),
});
/** POST cash-shifts/{id}/close of a sales shift: Kaspi terminal total and, with pending
 * receipts, the shift_close_pending_fiscal approval. */
export const PosCashShiftCloseSchema = CashShiftCloseSchema.extend({
  terminal_reported_minor: MoneyMinorSchema.optional(),
  approval: PosApprovalProofSchema.optional(),
});
/** 201 of POST pos/sales and 200 of POST pos/sales/{orderId}/void. */
export const PosSaleResultSchema = z.strictObject({ order: LocalOrderSchema, sale: PosSaleSchema });
export type PosSaleResult = z.infer<typeof PosSaleResultSchema>;
export type CashShift = z.infer<typeof CashShiftSchema>;

// OpenAPI and event JSON Schema are generated from these runtime schemas.
export const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema);

export * from './fulfillment.js';
export * from './pos-sales.js';

export * from './customer-commerce.js';
export * from './cutover-enums.js';

export * from './device-access.js';
export * from './notifications.js';
export * from './station-plans.js';
export * from './kds.js';

export * from './combo-rewards.js';
