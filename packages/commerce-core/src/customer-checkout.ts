import {
  TipTopPayHostedSessions,
  CheckoutPaymentMethodSchema,
  type TipTopPayCheckoutOptions,
} from './tiptoppay-checkout.js';
import { readCheckoutOrder } from './order-view.js';
import {
  RestaurantHoursSchema,
  restaurantHoursFromEnv,
  restaurantOrderingOpen,
  assertRestaurantOrderingOpen,
} from './restaurant-hours.js';
import {
  branchAvailability,
  assertBranchItemsAvailable,
  snapshotAvailabilityItems,
} from './availability.js';
import { localSelectionIds } from '@pickchick/menu-sync';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { transaction, type DatabasePool } from '@pickchick/database';
import {
  CatalogPricing,
  CatalogPricingError,
  CatalogMobileStorefrontSchema,
} from '@pickchick/catalog-pricing';
import { CommerceRepository } from './repository.js';
import { CommerceError, digest, parse, UUIDSchema } from './model.js';

/** Server-owned audience; all-customer access still requires a verified active identity. */
export const CheckoutOptionsSchema = z.strictObject({
  organizationId: z.uuid(),
  branchId: z.uuid(),
  paymentAccountId: z.uuid(),
  customerIds: z.array(z.uuid()).min(1).max(10),
  publishedCatalogEnabled: z.boolean().optional(),
  repeatOrdersEnabled: z.boolean().optional(),
  allVerifiedCustomers: z.boolean().optional(),
  maxOrderMinor: z
    .string()
    .regex(/^[1-9][0-9]{0,8}$/)
    .default('10000'),
  approvalReference: z.string().trim().min(3).max(250),
  hours: RestaurantHoursSchema.optional(),
});
export type CheckoutOptions = z.infer<typeof CheckoutOptionsSchema>;
export function customerCheckoutOptions(env: NodeJS.ProcessEnv): CheckoutOptions | null {
  if (env.CUSTOMER_KASPI_PILOT_ENABLED !== 'true') return null;
  return parse(CheckoutOptionsSchema, {
    organizationId: env.CUSTOMER_KASPI_ORGANIZATION_ID,
    branchId: env.CUSTOMER_KASPI_BRANCH_ID,
    paymentAccountId: env.KASPI_REMOTE_ACCOUNT_ID,
    customerIds: env.CUSTOMER_KASPI_PILOT_CUSTOMER_IDS?.split(','),
    publishedCatalogEnabled: env.CATALOG_MOBILE_STOREFRONT_ENABLED === 'true',
    repeatOrdersEnabled: env.CUSTOMER_KASPI_PILOT_REPEAT_ORDERS === 'true',
    allVerifiedCustomers: env.CUSTOMER_KASPI_ALL_VERIFIED_CUSTOMERS === 'true',
    maxOrderMinor: env.CUSTOMER_KASPI_PILOT_MAX_MINOR ?? '10000',
    approvalReference: env.CUSTOMER_KASPI_FISCAL_DEFERRAL_REFERENCE,
    hours: restaurantHoursFromEnv(env),
  });
}
const QuoteInput = z.strictObject({
  key: z.uuid(),
  branchId: z.uuid(),
  catalog_version: z.int().positive().optional(),
  serviceMode: z.enum(['takeaway', 'dine_in']),
  kitchenComment: z
    .string()
    .trim()
    .max(60)
    .transform((value) => value || undefined)
    .optional(),
  items: z
    .array(
      z.strictObject({
        productId: z.string().min(1).max(160),
        quantity: z.int().min(1).max(40),
        selections: z
          .array(
            z.strictObject({
              group_id: z.string().min(1).max(40),
              option_id: z.string().min(1).max(40),
              quantity: z.int().min(1).max(40),
            }),
          )
          .max(40),
      }),
    )
    .min(1)
    .max(50),
});
const CreateInput = z.strictObject({ key: z.uuid(), quoteId: z.uuid() });
const keyFor = (orderId: string) => {
  const hex = createHash('sha256').update(`customer-kaspi:${orderId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export class CustomerCheckout {
  readonly repository: CommerceRepository;
  constructor(
    private readonly pool: DatabasePool,
    private readonly options: CheckoutOptions | null,
    private readonly now: () => Date = () => new Date(),
    private readonly tipTop: TipTopPayCheckoutOptions | null = null,
  ) {
    this.repository = new CommerceRepository(pool, options ?? undefined);
  }
  private async scope(customerId: string) {
    parse(UUIDSchema, customerId);
    if (!this.options) throw new CommerceError('FORBIDDEN');
    if (this.options.allVerifiedCustomers) {
      // Identity rows are created only after OTP verification. The HTTP controller
      // independently requires a live bearer session; arbitrary UUIDs are not users.
      const identity = await this.pool.query(
        'SELECT 1 FROM identity_customers WHERE id=$1 AND deleted_at IS NULL',
        [customerId],
      );
      if (!identity.rowCount) throw new CommerceError('FORBIDDEN');
    } else if (!this.options.customerIds.includes(customerId)) throw new CommerceError('FORBIDDEN');
    return {
      organizationId: this.options.organizationId,
      branchId: this.options.branchId,
      principalId: customerId,
      role: 'sales' as const,
    };
  }
  async catalog() {
    if (!this.options?.publishedCatalogEnabled) throw new CommerceError('NOT_FOUND');
    const row = (
      await this.pool.query<{
        branch: unknown;
        version: number;
        published_at: Date;
        payload: unknown;
      }>(
        `SELECT jsonb_build_object('id',b.id,'code',b.code,'name',b.name,'timezone',b.timezone,'ordering_enabled',b.ordering_enabled) branch,p.version,p.published_at,p.payload
       FROM branches b JOIN catalog_branch_heads h ON h.branch_id=b.id AND h.organization_id=b.organization_id
       JOIN catalog_publications p ON p.branch_id=h.branch_id AND p.organization_id=h.organization_id AND p.version=h.published_version
       WHERE b.id=$1 AND b.organization_id=$2`,
        [this.options.branchId, this.options.organizationId],
      )
    ).rows[0];
    if (!row) throw new CommerceError('NOT_READY');
    return CatalogMobileStorefrontSchema.parse({
      branch: row.branch,
      channel: 'mobile',
      version: row.version,
      published_at: row.published_at.toISOString(),
      payload: row.payload,
    });
  }
  async availability() {
    if (!this.options) return { enabled: false, fresh: false, signature: 'disabled', products: [] };
    const branchId = this.options.branchId;
    const state = await branchAvailability(this.pool, branchId);
    const stopped = new Set(state.stoppedIds);
    const row = (
      await this.pool.query<{
        payload: {
          products: {
            id: string;
            available: boolean;
            modifier_groups: { id: string; options: { id: string; available: boolean }[] }[];
          }[];
        };
      }>(
        `SELECT p.payload FROM catalog_branch_heads h JOIN catalog_publications p ON p.branch_id=h.branch_id AND p.organization_id=h.organization_id AND p.version=h.published_version WHERE h.branch_id=$1`,
        [branchId],
      )
    ).rows[0];
    const products = (row?.payload.products ?? []).map((p) => ({
      id: p.id,
      available:
        p.available &&
        !localSelectionIds(branchId, p.id, []).some((id) => stopped.has(id)) &&
        !stopped.has(p.id),
      stoppedOptions: p.modifier_groups.flatMap((g) =>
        g.options
          .filter(
            (o) =>
              !o.available ||
              localSelectionIds(branchId, p.id, [{ group_id: g.id, option_id: o.id }])
                .slice(1)
                .some((id) => stopped.has(id)),
          )
          .map((o) => ({ groupId: g.id, optionId: o.id })),
      ),
    }));
    const value = {
      enabled: true,
      branchId,
      fresh: state.fresh,
      products,
      ...(this.options.hours
        ? {
            orderingOpen: restaurantOrderingOpen(this.options.hours, this.now()),
            hours: this.options.hours,
          }
        : {}),
    };
    return { ...value, signature: digest(value) };
  }
  async config(customerId: string) {
    const scope = await this.scope(customerId);
    const row = (
      await this.pool.query<{ name: string; ready: boolean }>(
        `
      SELECT b.name, (b.ordering_enabled AND
        EXISTS(SELECT 1 FROM catalog_branch_heads h JOIN catalog_publications p
          ON p.branch_id=h.branch_id AND p.organization_id=h.organization_id AND p.version=h.published_version
          WHERE h.branch_id=b.id) AND
        EXISTS(SELECT 1 FROM commerce_provider_accounts a WHERE a.id=$3 AND a.branch_id=b.id
          AND a.organization_id=b.organization_id AND a.legal_entity_id=b.legal_entity_id
          AND a.kind='payment' AND a.provider='kaspi-remote' AND a.enabled) AND
        EXISTS(SELECT 1 FROM fulfillment_transport_bindings t JOIN devices d ON d.id=t.device_id
          WHERE t.branch_id=b.id AND t.active AND d.status='active')) ready
      FROM branches b WHERE b.id=$1 AND b.organization_id=$2`,
        [scope.branchId, scope.organizationId, this.options!.paymentAccountId],
      )
    ).rows[0];
    if (!row) throw new CommerceError('NOT_READY');
    const tipTopReady = this.tipTop
      ? await this.pool.query(
          `SELECT 1 FROM commerce_provider_accounts p JOIN branches b ON b.id=p.branch_id AND b.organization_id=p.organization_id AND b.legal_entity_id=p.legal_entity_id WHERE p.id=$1 AND p.provider='tiptoppay' AND p.kind='payment' AND p.external_reference=$2 AND p.enabled AND p.branch_id=$3 AND p.organization_id=$4`,
          [this.tipTop.accountId, this.tipTop.publicId, scope.branchId, scope.organizationId],
        )
      : null;
    return {
      enabled: row.ready,
      paymentMethods: ['kaspi', ...(tipTopReady?.rowCount ? this.tipTop!.methods : [])],
      orderCommentEnabled: true,
      branchId: scope.branchId,
      restaurant: row.name,
      fiscalPolicy: 'deferred_pilot' as const,
    };
  }
  async quote(customerId: string, input: unknown) {
    const scope = await this.scope(customerId),
      request = parse(QuoteInput, input);
    if (request.branchId !== scope.branchId) throw new CommerceError('FORBIDDEN');
    if (this.options!.publishedCatalogEnabled && request.catalog_version === undefined)
      throw new CommerceError('CATALOG_UPGRADE_REQUIRED');
    assertRestaurantOrderingOpen(this.options!.hours, this.now());
    await assertBranchItemsAvailable(this.pool, scope.branchId, request.items);
    if (!(await this.config(customerId)).enabled) throw new CommerceError('NOT_READY');
    const head = (
      await this.pool.query<{
        version: number;
        payload: {
          products: { id: string; sku: string; channel_prices_minor?: { mobile?: string } }[];
        };
        legal_entity_id: string;
      }>(
        `
      SELECT p.version,p.payload,b.legal_entity_id FROM branches b
      JOIN catalog_branch_heads h ON h.branch_id=b.id AND h.organization_id=b.organization_id
      JOIN catalog_publications p ON p.branch_id=h.branch_id AND p.organization_id=h.organization_id AND p.version=h.published_version
      WHERE b.id=$1 AND b.organization_id=$2`,
        [scope.branchId, scope.organizationId],
      )
    ).rows[0];
    if (!head) throw new CommerceError('NOT_READY');
    // Disabling the rollout cannot make an old client order an undisplayed override.
    if (
      request.catalog_version === undefined &&
      head.payload.products.some((product) => product.channel_prices_minor?.mobile !== undefined)
    )
      throw new CommerceError('CATALOG_UPGRADE_REQUIRED');
    if (request.catalog_version !== undefined && request.catalog_version !== head.version)
      throw new CommerceError('CONFLICT');
    try {
      const priced = await new CatalogPricing(this.pool).price(
        {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          customerId,
          channel: 'mobile',
        },
        {
          catalog_version: head.version,
          service_mode: request.serviceMode,
          items: request.items.map((item) => {
            const sku = head.payload.products.find((p) => p.id === item.productId)?.sku;
            if (!sku) throw new CommerceError('CONFLICT');
            return { sku, quantity: item.quantity, selections: item.selections };
          }),
        },
      );
      if (BigInt(priced.totalMinor) > BigInt(this.options!.maxOrderMinor))
        throw new CommerceError('NOT_READY');
      const quote = await this.repository.issueQuote(scope, request.key, {
        ...priced,
        ...(request.kitchenComment ? { kitchenComment: request.kitchenComment } : {}),
        taxBinding: {
          legalEntityId: head.legal_entity_id,
          approvalReference: this.options!.approvalReference,
          version: 1,
        },
        // This is not a tax classification and may never be submitted to Webkassa.
        lines: priced.lines.map((line) => ({ ...line, taxCode: 'PENDING_PILOT' })),
      });
      return {
        quoteId: quote.quoteId,
        totalMinor: quote.snapshot.totalMinor,
        expiresAt: quote.expiresAt,
        serviceMode: request.serviceMode,
        kitchenComment: quote.snapshot.kitchenComment ?? null,
      };
    } catch (error) {
      if (error instanceof CatalogPricingError) throw new CommerceError('CONFLICT');
      throw error;
    }
  }
  async create(customerId: string, input: unknown) {
    const scope = await this.scope(customerId),
      request = parse(CreateInput, input);
    const quote = (
      await this.pool.query<{
        total_minor: string;
        order_id: string | null;
        fiscal_deferral_reference: string | null;
      }>(
        `SELECT q.total_minor,o.id AS order_id,o.fiscal_deferral_reference FROM commerce_quotes q
       LEFT JOIN commerce_orders o ON o.quote_id=q.id
       WHERE q.id=$1 AND q.organization_id=$2 AND q.branch_id=$3 AND q.principal_id=$4 AND q.customer_id=$4 AND q.snapshot->>'channel'='mobile'`,
        [request.quoteId, scope.organizationId, scope.branchId, customerId],
      )
    ).rows[0];
    if (!quote) throw new CommerceError('NOT_FOUND');
    if (!quote.order_id) assertRestaurantOrderingOpen(this.options!.hours, this.now());
    // A quote issued before a limit reduction must not authorize a larger new charge.
    if (!quote.order_id && BigInt(quote.total_minor) > BigInt(this.options!.maxOrderMinor))
      throw new CommerceError('NOT_READY');
    // A retry may recover an existing order even if the restaurant is now offline.
    // A persisted order owns its original approval reference. Changing the server
    // rollout policy must not change the idempotency digest of its create command.
    // This quote lookup is already scoped to the authenticated customer's branch.
    const repository =
      quote.order_id && quote.fiscal_deferral_reference
        ? new CommerceRepository(this.pool, {
            ...this.options!,
            approvalReference: quote.fiscal_deferral_reference,
          })
        : this.repository;
    const created = await repository.createDeferredFiscalOrder(scope, request.key, request.quoteId);
    return this.read(customerId, created.orderId);
  }
  async paymentMethod(customerId: string, orderId: string, input: unknown) {
    const scope = await this.scope(customerId);
    await this.assertMobileOrder(scope, orderId);
    const { method } = parse(z.strictObject({ method: CheckoutPaymentMethodSchema }), input);
    if (!this.tipTop && method === 'kaspi') return this.read(customerId, orderId);
    if (method !== 'kaspi' && !this.tipTop?.methods.includes(method))
      throw new CommerceError('NOT_READY');
    await transaction(this.pool, async (client) => {
      await client.query('SELECT id FROM commerce_orders WHERE id=$1 FOR UPDATE', [orderId]);
      const current = (
        await client.query<{ method: string; locked_at: Date | null }>(
          'SELECT method,locked_at FROM commerce_checkout_payment_methods WHERE order_id=$1',
          [orderId],
        )
      ).rows[0];
      const started = (
        await client.query('SELECT 1 FROM commerce_payment_attempts WHERE order_id=$1', [orderId])
      ).rowCount;
      if ((started || current?.locked_at) && (current?.method ?? 'kaspi') !== method)
        throw new CommerceError('CONFLICT');
      await client.query(
        `INSERT INTO commerce_checkout_payment_methods(order_id,method) VALUES($1,$2)
        ON CONFLICT(order_id) DO UPDATE SET method=EXCLUDED.method,updated_at=clock_timestamp()`,
        [orderId, method],
      );
    });
    return this.read(customerId, orderId);
  }
  async hostedPayment(customerId: string, orderId: string) {
    if (!this.tipTop) throw new CommerceError('NOT_READY');
    const eligible = await this.pool.query(
      `SELECT 1 FROM commerce_orders o JOIN branches b ON b.id=o.branch_id
      JOIN commerce_provider_accounts p ON p.id=$3 AND p.organization_id=o.organization_id AND p.branch_id=o.branch_id
       AND p.legal_entity_id=b.legal_entity_id AND p.provider='tiptoppay' AND p.external_reference=$4 AND p.enabled
      WHERE o.id=$1 AND o.customer_id=$2 AND o.principal_id=$2 AND o.fiscal_policy='deferred_pilot'
       AND o.fiscal_deferral_reference=$5`,
      [
        orderId,
        customerId,
        this.tipTop.accountId,
        this.tipTop.publicId,
        this.tipTop.approvalReference,
      ],
    );
    if (!eligible.rowCount) throw new CommerceError('NOT_READY');
    await this.pay(customerId, orderId, true);
    return new TipTopPayHostedSessions(this.pool, this.tipTop).issue(customerId, orderId);
  }
  async pay(customerId: string, orderId: string, hosted = false) {
    const scope = await this.scope(customerId);
    await this.assertMobileOrder(scope, orderId);
    const current = await this.repository.readOrder(scope, orderId);
    if (current.attempts.length || BigInt(current.money.captured) > 0n)
      return this.read(customerId, orderId);
    assertRestaurantOrderingOpen(this.options!.hours, this.now());
    await assertBranchItemsAvailable(
      this.pool,
      scope.branchId,
      snapshotAvailabilityItems(current.snapshot),
    );
    const method = this.tipTop
      ? await transaction(this.pool, async (client) => {
          await client.query('SELECT id FROM commerce_orders WHERE id=$1 FOR UPDATE', [orderId]);
          const selected =
            (
              await client.query<{ method: string }>(
                'SELECT method FROM commerce_checkout_payment_methods WHERE order_id=$1',
                [orderId],
              )
            ).rows[0]?.method ?? 'kaspi';
          if (
            (selected !== 'kaspi') !== hosted ||
            (hosted &&
              !this.tipTop?.methods.includes(selected as 'card' | 'apple_pay' | 'google_pay'))
          )
            throw new CommerceError('NOT_READY');
          await client.query(
            `INSERT INTO commerce_checkout_payment_methods(order_id,method,locked_at) VALUES($1,$2,clock_timestamp())
        ON CONFLICT(order_id) DO UPDATE SET locked_at=COALESCE(commerce_checkout_payment_methods.locked_at,clock_timestamp())`,
            [orderId, selected],
          );
          return selected;
        })
      : 'kaspi';
    // A single stable command per order. Unknown responses never create a fresh attempt.
    await this.repository.startPaymentAttempt(scope, keyFor(orderId), {
      orderId,
      providerAccountId:
        method === 'kaspi' ? this.options!.paymentAccountId : this.tipTop!.accountId,
    });
    return this.read(customerId, orderId);
  }
  async listFeedback(customerId: string) {
    const scope = await this.scope(customerId);
    const rows = await this.pool.query<{
      order_id: string;
      rating: number;
      comment: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT f.* FROM commerce_order_feedback f JOIN commerce_orders o ON o.id=f.order_id
       WHERE o.principal_id=$1 AND o.organization_id=$2 AND o.branch_id=$3
       AND o.customer_id=$1 AND o.snapshot->>'channel'='mobile'
       ORDER BY o.created_at DESC,o.id DESC LIMIT 30`,
      [customerId, scope.organizationId, scope.branchId],
    );
    return {
      feedback: rows.rows.map((f) => ({
        orderId: f.order_id,
        rating: f.rating,
        comment: f.comment,
        createdAt: f.created_at.toISOString(),
        updatedAt: f.updated_at.toISOString(),
      })),
    };
  }
  async feedback(customerId: string, orderId: string) {
    const scope = await this.scope(customerId);
    const id = parse(UUIDSchema, orderId);
    return transaction(this.pool, async (client) => {
      const order = (
        await client.query<{ total_minor: string; attention_required: boolean }>(
          `SELECT total_minor::text,attention_required FROM commerce_orders
         WHERE id=$1 AND principal_id=$2 AND organization_id=$3 AND branch_id=$4 AND customer_id=$2 AND snapshot->>'channel'='mobile' FOR UPDATE`,
          [id, customerId, scope.organizationId, scope.branchId],
        )
      ).rows[0];
      if (!order) throw new CommerceError('NOT_FOUND');
      return this.feedbackState(client, id, order);
    });
  }
  async submitFeedback(customerId: string, orderId: string, input: unknown) {
    const scope = await this.scope(customerId);
    const id = parse(UUIDSchema, orderId);
    const request = parse(
      z.strictObject({
        rating: z.int().min(1).max(5),
        comment: z.string().trim().max(500).optional(),
      }),
      input,
    );
    return transaction(this.pool, async (client) => {
      // The same aggregate lock serializes feedback with captures/refunds and other reviews.
      const order = (
        await client.query<{ total_minor: string; attention_required: boolean }>(
          `SELECT total_minor::text,attention_required FROM commerce_orders
         WHERE id=$1 AND principal_id=$2 AND organization_id=$3 AND branch_id=$4 AND customer_id=$2 AND snapshot->>'channel'='mobile' FOR UPDATE`,
          [id, customerId, scope.organizationId, scope.branchId],
        )
      ).rows[0];
      if (!order) throw new CommerceError('NOT_FOUND');
      if (!(await this.feedbackState(client, id, order)).enabled)
        throw new CommerceError('CONFLICT');
      await client.query(
        `INSERT INTO commerce_order_feedback(order_id,rating,comment) VALUES($1,$2,$3)
         ON CONFLICT(order_id) DO UPDATE SET rating=EXCLUDED.rating,comment=EXCLUDED.comment,updated_at=clock_timestamp()
         WHERE (commerce_order_feedback.rating,commerce_order_feedback.comment)
           IS DISTINCT FROM (EXCLUDED.rating,EXCLUDED.comment)`,
        [id, request.rating, request.comment || null],
      );
      return this.feedbackState(client, id, order);
    });
  }
  private async feedbackState(
    client: import('@pickchick/database').DatabaseClient,
    orderId: string,
    order: { total_minor: string; attention_required: boolean },
  ) {
    const state = (
      await client.query<{
        state: string | null;
        captured: string;
        refunded: string;
        pending_refund: boolean;
      }>(
        `SELECT (SELECT state FROM cloud_fulfillment_projection WHERE order_id=$1) state,
       COALESCE((SELECT sum(amount_minor) FROM commerce_captures WHERE order_id=$1),0)::text captured,
       COALESCE((SELECT sum(amount_minor) FROM commerce_refund_effects WHERE order_id=$1),0)::text refunded,
       EXISTS(SELECT 1 FROM commerce_refunds WHERE order_id=$1 AND state IN ('pending','unknown')) pending_refund`,
        [orderId],
      )
    ).rows[0]!;
    const saved = (
      await client.query<{
        rating: number;
        comment: string | null;
        created_at: Date;
        updated_at: Date;
      }>(
        'SELECT rating,comment,created_at,updated_at FROM commerce_order_feedback WHERE order_id=$1',
        [orderId],
      )
    ).rows[0];
    return {
      orderId,
      enabled:
        !order.attention_required &&
        state.state === 'handed_over' &&
        state.captured === order.total_minor &&
        state.refunded === '0' &&
        !state.pending_refund,
      feedback: saved
        ? {
            rating: saved.rating,
            comment: saved.comment,
            createdAt: saved.created_at.toISOString(),
            updatedAt: saved.updated_at.toISOString(),
          }
        : null,
      // Cloud has receipt times only. Never report those as actual kitchen action times.
      preparationStartedAt: null,
      readyAt: null,
    };
  }
  async list(customerId: string) {
    const scope = await this.scope(customerId);
    const rows = await this.pool.query<{ id: string }>(
      `SELECT o.id FROM commerce_orders o JOIN commerce_payment_intents p ON p.order_id=o.id
       WHERE o.principal_id=$1 AND o.organization_id=$2 AND o.branch_id=$3
       AND o.customer_id=$1 AND o.snapshot->>'channel'='mobile'
       AND (p.state<>'failed' OR o.attention_required
         OR EXISTS(SELECT 1 FROM commerce_captures c WHERE c.order_id=o.id))
       ORDER BY o.created_at DESC,o.id DESC LIMIT 30`,
      [customerId, scope.organizationId, scope.branchId],
    );
    return { orders: await Promise.all(rows.rows.map((row) => this.read(customerId, row.id))) };
  }
  private async assertMobileOrder(scope: import('./model.js').CommerceScope, orderId: string) {
    parse(UUIDSchema, orderId);
    const row = await this.pool.query(
      "SELECT 1 FROM commerce_orders WHERE id=$1 AND organization_id=$2 AND branch_id=$3 AND principal_id=$4 AND customer_id=$4 AND snapshot->>'channel'='mobile'",
      [orderId, scope.organizationId, scope.branchId, scope.principalId],
    );
    if (!row.rowCount) throw new CommerceError('NOT_FOUND');
  }
  async read(customerId: string, orderId: string) {
    const scope = await this.scope(customerId);
    await this.assertMobileOrder(scope, orderId);
    return readCheckoutOrder(this.pool, this.repository, scope, orderId, !!this.tipTop);
  }
}
