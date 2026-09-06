import { z } from 'zod';

export const TEST_BRANCH_ID = '10000000-0000-4000-8000-000000000003';
export const TEST_CATALOG_VERSION = 'mockup-v0.2';
export const TEST_NAMESPACE = 'pickchick-test';
const Synthetic = { synthetic: z.literal(true), namespace: z.literal(TEST_NAMESPACE) };
const Uuid = z.uuid();
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
export const TestCatalogSchema = z.strictObject({
  ...Synthetic,
  branch_id: z.literal(TEST_BRANCH_ID),
  catalog_version: z.literal(TEST_CATALOG_VERSION),
  currency: z.literal('KZT'),
  products: z.array(TestProductSchema),
});
export const TestCartSchema = z
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
export const TestQuoteSchema = z.strictObject({
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
export type TestQuote = z.infer<typeof TestQuoteSchema>;
export const TestCreateOrderSchema = z.strictObject({ quote_id: Uuid });
export const TestVersionSchema = z.strictObject({ expected_version: z.int().min(1) });
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
  number: z.string().regex(/^T-\d{6,}$/),
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
  preparing: z.array(z.strictObject({ number: z.string(), channel: TestChannelSchema })).max(2000),
  ready: z.array(z.strictObject({ number: z.string(), channel: TestChannelSchema })).max(2000),
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
