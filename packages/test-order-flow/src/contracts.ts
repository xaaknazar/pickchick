import { z } from 'zod';

export const TEST_BRANCH_ID = '10000000-0000-4000-8000-000000000003';
export const TEST_CATALOG_VERSION = 'mockup-v0.2';
export const TEST_COMPLETE_CATALOG_VERSION = 'mockup-v0.3';
export const TestCatalogVersionSchema = z.enum([
  TEST_CATALOG_VERSION,
  TEST_COMPLETE_CATALOG_VERSION,
]);
export const TEST_NAMESPACE = 'pickchick-test';
// Wire sentinel for existing clients requiring an ISO timestamp. The database
// stores PostgreSQL infinity, not this finite date, for revocable permanent access.
export const TEST_ACCESS_NO_EXPIRY = '9999-12-31T23:59:59.999Z';
const Synthetic = { synthetic: z.literal(true), namespace: z.literal(TEST_NAMESPACE) };
const Uuid = z.uuid();
export const TestOrderWatchSchema = z.strictObject({
  versions: z.array(z.strictObject({ order_id: Uuid, version: z.int().min(1) })).max(20),
});
export function testOrderVersions(orders: readonly { order_id: string; version: number }[]) {
  return orders.map(({ order_id, version }) => ({ order_id, version }));
}
export function sameTestOrderVersions(
  left: readonly { order_id: string; version: number }[],
  right: readonly { order_id: string; version: number }[],
) {
  const key = (values: typeof left) =>
    values
      .map((o) => `${o.order_id}:${o.version}`)
      .sort()
      .join(',');
  return key(left) === key(right);
}
const Minor = z.string().regex(/^(0|[1-9]\d{0,15})$/);
export const TestChannelSchema = z.enum(['mobile', 'kiosk']);
export const TestRoleSchema = z.enum(['customer', 'prep', 'assembly', 'display', 'manager']);
export type TestRole = z.infer<typeof TestRoleSchema>;
export const TestSessionInputSchema = z.strictObject({ channel: TestChannelSchema });
export const TestContinueSessionInputSchema = z.strictObject({});
export const TestSessionSchema = z.strictObject({
  ...Synthetic,
  session_id: Uuid,
  token: z.string().regex(/^[a-f0-9]{64}$/),
  expires_at: z.iso.datetime(),
  channel: TestChannelSchema,
});
export const TestProductSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  price_minor: Minor,
  image_id: z.string(),
  prep_required: z.boolean(),
});
export const TestLegacyCatalogSchema = z.strictObject({
  ...Synthetic,
  branch_id: z.literal(TEST_BRANCH_ID),
  catalog_version: z.literal(TEST_CATALOG_VERSION),
  currency: z.literal('KZT'),
  products: z.array(TestProductSchema),
});
export const TestLegacyCartSchema = z
  .strictObject({
    catalog_version: z.literal(TEST_CATALOG_VERSION),
    service_mode: z.enum(['takeaway', 'dine_in']),
    items: z
      .array(
        z.strictObject({ product_id: z.string().min(1).max(40), quantity: z.int().min(1).max(20) }),
      )
      .min(1)
      .max(11),
  })
  .superRefine((cart, ctx) => {
    if (new Set(cart.items.map((item) => item.product_id)).size !== cart.items.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate product' });
  });
export const TestLineSchema = TestProductSchema.extend({
  quantity: z.int().min(1).max(20),
  line_total_minor: Minor,
});
export const TestLegacyQuoteSchema = z.strictObject({
  ...Synthetic,
  quote_id: Uuid,
  branch_id: z.literal(TEST_BRANCH_ID),
  catalog_version: z.literal(TEST_CATALOG_VERSION),
  channel: TestChannelSchema,
  service_mode: z.enum(['takeaway', 'dine_in']),
  currency: z.literal('KZT'),
  total_minor: Minor,
  lines: z.array(TestLineSchema).min(1).max(11),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
});
const CatalogId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export const TestSelectionSchema = z.strictObject({
  group_id: CatalogId,
  option_id: CatalogId,
  quantity: z.int().min(1).max(40),
});
export type TestSelection = z.infer<typeof TestSelectionSchema>;
// Delimiters cannot occur in CatalogId; ordering does not change line identity.
export function testLineId(productId: string, selections: readonly TestSelection[] = []): string {
  const selected = selections
    .map((item) => `${item.group_id}:${item.option_id}:${item.quantity}`)
    .sort();
  return selected.length ? `${productId}|${selected.join(',')}` : productId;
}
export const TestModifierGroupSchema = z.strictObject({
  id: CatalogId,
  title: z.string().min(1).max(100),
  min: z.int().min(0).max(100),
  max: z.int().min(1).max(100),
  options: z
    .array(
      z.strictObject({
        id: CatalogId,
        label: z.string().min(1).max(150),
        price_delta_minor: Minor,
        default_quantity: z.int().min(0).max(40),
        max_quantity: z.int().min(1).max(40),
        available: z.boolean(),
        nutrition_multiplier: z.number().positive().max(100).optional(),
      }),
    )
    .min(1)
    .max(20),
});
export type TestModifierGroup = z.infer<typeof TestModifierGroupSchema>;
export const TestNutritionSchema = z.strictObject({
  basis: z.enum(['per_100_g', 'per_serving']),
  energy_kcal: z.number().nonnegative().max(100000),
  protein_g: z.number().nonnegative().max(10000),
  fat_g: z.number().nonnegative().max(10000),
  carbs_g: z.number().nonnegative().max(10000),
});
export const TestCompleteProductSchema = TestProductSchema.extend({
  id: CatalogId,
  serving_label: z.string().min(1).max(100),
  ingredients: z.string().max(2000),
  allergens: z.array(z.string().min(1).max(100)).max(30),
  prep_minutes: z.int().min(1).max(120),
  nutrition: TestNutritionSchema,
  nutrition_provenance: z.enum(['source_mockup', 'demo_fixture']),
  modifier_groups: z.array(TestModifierGroupSchema).max(10),
});
const EstimatedMinutes = z.strictObject({
  min: z.int().min(1).max(120),
  max: z.int().min(1).max(120),
});
export const TestCompleteCatalogSchema = TestLegacyCatalogSchema.extend({
  catalog_version: z.literal(TEST_COMPLETE_CATALOG_VERSION),
  products: z.array(TestCompleteProductSchema).min(1).max(100),
  estimated_minutes: EstimatedMinutes,
  upsell_product_ids: z.array(CatalogId).max(20),
});
export type TestCompleteCatalog = z.infer<typeof TestCompleteCatalogSchema>;
export const TestCatalogSchema = z.union([TestLegacyCatalogSchema, TestCompleteCatalogSchema]);
export const TestCompleteCartSchema = z
  .strictObject({
    catalog_version: z.literal(TEST_COMPLETE_CATALOG_VERSION),
    service_mode: z.enum(['takeaway', 'dine_in']),
    payment_method: z.enum(['kaspi', 'card']).default('kaspi'),
    items: z
      .array(
        z.strictObject({
          product_id: CatalogId,
          quantity: z.int().min(1).max(20),
          selections: z.array(TestSelectionSchema).max(40),
        }),
      )
      .min(1)
      .max(11),
  })
  .superRefine((cart, ctx) => {
    if (
      new Set(cart.items.map((item) => testLineId(item.product_id, item.selections))).size !==
      cart.items.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate variant' });
    for (const item of cart.items) {
      if (
        new Set(item.selections.map((selection) => `${selection.group_id}:${selection.option_id}`))
          .size !== item.selections.length
      )
        ctx.addIssue({ code: 'custom', message: 'Duplicate selection' });
    }
  });
export const TestCartSchema = z.union([TestLegacyCartSchema, TestCompleteCartSchema]);
// A quote stores purchased facts, not every option that could have been chosen.
// The full modifier directory belongs only to the published catalog.
export const TestCompleteLineSchema = TestLineSchema.extend({
  serving_label: TestCompleteProductSchema.shape.serving_label,
  nutrition: TestNutritionSchema,
  nutrition_provenance: TestCompleteProductSchema.shape.nutrition_provenance,
  line_id: z.string().min(1).max(4000),
  base_price_minor: Minor,
  quantity: z.int().min(1).max(20),
  line_total_minor: Minor,
  selections: z
    .array(
      TestSelectionSchema.extend({
        group_label: z.string(),
        option_label: z.string(),
        price_delta_minor: Minor,
      }),
    )
    .max(40),
});
export const TestCompleteQuoteSchema = TestLegacyQuoteSchema.extend({
  catalog_version: z.literal(TEST_COMPLETE_CATALOG_VERSION),
  lines: z.array(TestCompleteLineSchema).min(1).max(11),
  payment_method: z.enum(['kaspi', 'card']),
  estimated_minutes: EstimatedMinutes,
});
export const TestQuoteSchema = z.union([TestLegacyQuoteSchema, TestCompleteQuoteSchema]);
export type TestQuote = z.infer<typeof TestQuoteSchema>;
export const TestCreateOrderSchema = z.strictObject({
  quote_id: Uuid,
  execution_mode: z.literal('unpaid_test').optional(),
});
export const TestVersionSchema = z.strictObject({ expected_version: z.int().min(1) });
export const TestCompleteTaskSchema = TestVersionSchema.extend({
  complete_station: z.literal(true).optional(),
});
export const TestPaymentSchema = TestVersionSchema.extend({
  outcome: z.enum(['approved', 'declined', 'unknown']),
});
export const TestResolvePaymentSchema = TestVersionSchema.extend({
  outcome: z.enum(['approved', 'declined']),
});
export const TestCancellationSchema = TestVersionSchema.extend({
  reason: z.string().trim().min(3).max(300),
});
export const TestTaskSchema = z.strictObject({
  task_id: Uuid,
  station: z.enum(['prep', 'assembly']),
  title: z.string(),
  state: z.enum(['pending', 'done']),
  mandatory: z.literal(true),
});
export const TestOrderSchema = z.strictObject({
  ...Synthetic,
  order_id: Uuid,
  number: z.string().regex(/^(?:T-\d{6,}|[1-9]\d*)$/),
  branch_id: z.literal(TEST_BRANCH_ID),
  version: z.int().min(1),
  state: z.enum(['awaiting_test_payment', 'preparing', 'ready', 'fulfilled', 'cancelled']),
  payment_state: z.enum([
    'not_started',
    'simulated_unknown',
    'simulated_approved',
    'simulated_declined',
  ]),
  payment_attempt_id: Uuid.nullable(),
  fiscal_state: z.literal('not_applicable'),
  snapshot: TestQuoteSchema,
  tasks: z.array(TestTaskSchema).max(12),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  cancellation_reason: z.string().nullable(),
});
export type TestOrder = z.infer<typeof TestOrderSchema>;
export const TestServiceShiftSchema = z.strictObject({
  shift_id: Uuid,
  number: z.string().regex(/^[1-9]\d*$/),
  state: z.enum(['open', 'closed']),
  version: z.int().positive(),
  opened_at: z.iso.datetime(),
  closed_at: z.iso.datetime().nullable(),
});
export const TestServiceShiftCurrentSchema = z.strictObject({
  ...Synthetic,
  shift: TestServiceShiftSchema.nullable(),
});
export const TestServiceShiftChangeSchema = z
  .strictObject({
    previous_shift_id: Uuid.nullable(),
    expected_version: z.int().positive().nullable(),
  })
  .refine((value) => (value.previous_shift_id === null) === (value.expected_version === null));
export const TestOrdersSchema = z.strictObject({
  ...Synthetic,
  orders: z.array(TestOrderSchema).max(2000),
});
export const TestKitchenSchema = TestOrdersSchema.extend({
  station: z.enum(['prep', 'assembly', 'manager']),
});
export const TestDisplaySchema = z.strictObject({
  ...Synthetic,
  branch_id: z.literal(TEST_BRANCH_ID),
  preparing: z
    .array(
      z.strictObject({
        number: z.string(),
        channel: TestChannelSchema,
        order_id: Uuid.optional(),
        business_date: z.iso.date().optional(),
        shift_number: z
          .string()
          .regex(/^[1-9]\d*$/)
          .optional(),
      }),
    )
    .max(2000),
  ready: z
    .array(
      z.strictObject({
        number: z.string(),
        channel: TestChannelSchema,
        order_id: Uuid.optional(),
        business_date: z.iso.date().optional(),
        shift_number: z
          .string()
          .regex(/^[1-9]\d*$/)
          .optional(),
      }),
    )
    .max(2000),
  observed_at: z.iso.datetime(),
});
export const TestActorSchema = z.strictObject({
  ...Synthetic,
  actor_id: Uuid,
  token: z.string().regex(/^[a-f0-9]{64}$/),
  role: TestRoleSchema.exclude(['customer']),
  branch_id: z.literal(TEST_BRANCH_ID),
  expires_at: z.iso.datetime(),
});
export type TestCatalog = z.infer<typeof TestCatalogSchema>;
export type TestSession = z.infer<typeof TestSessionSchema>;
export type TestDisplay = z.infer<typeof TestDisplaySchema>;
export type TestKitchen = z.infer<typeof TestKitchenSchema>;
export type TestOrders = z.infer<typeof TestOrdersSchema>;

// Customer feedback is separate from financial and fulfillment state.
export const TestFeedbackInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('review'),
    stars: z.int().min(1).max(5),
    text: z.string().trim().max(2000),
  }),
  z.strictObject({ kind: z.literal('ticket'), text: z.string().trim().min(3).max(2000) }),
]);
export const TestFeedbackSchema = z.strictObject({
  review: z
    .strictObject({ id: Uuid, stars: z.int().min(1).max(5), text: z.string().max(2000) })
    .nullable(),
  tickets: z
    .array(
      z.strictObject({
        id: Uuid,
        text: z.string().max(2000),
        status: z.enum(['new', 'in_progress', 'resolved', 'closed']),
      }),
    )
    .max(5),
});
export type TestFeedback = z.infer<typeof TestFeedbackSchema>;
export type TestFeedbackInput = z.infer<typeof TestFeedbackInputSchema>;
export const TestHistorySchema = TestOrdersSchema.extend({ has_more: z.boolean() });
