import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DatabasePool } from '@pickchick/database';
import { CatalogPricing, CatalogPricingError } from '@pickchick/catalog-pricing';
import { CommerceRepository } from './repository.js';
import { CommerceError, digest, parse, UUIDSchema } from './model.js';

/** Server-owned audience; all-customer access still requires a verified active identity. */
export const CheckoutOptionsSchema = z.strictObject({
  organizationId: z.uuid(),
  branchId: z.uuid(),
  paymentAccountId: z.uuid(),
  customerIds: z.array(z.uuid()).min(1).max(10),
  repeatOrdersEnabled: z.boolean().optional(),
  allVerifiedCustomers: z.boolean().optional(),
  maxOrderMinor: z
    .string()
    .regex(/^[1-9][0-9]{0,8}$/)
    .default('10000'),
  approvalReference: z.string().trim().min(3).max(250),
});
export type CheckoutOptions = z.infer<typeof CheckoutOptionsSchema>;
export function customerCheckoutOptions(env: NodeJS.ProcessEnv): CheckoutOptions | null {
  if (env.CUSTOMER_KASPI_PILOT_ENABLED !== 'true') return null;
  return parse(CheckoutOptionsSchema, {
    organizationId: env.CUSTOMER_KASPI_ORGANIZATION_ID,
    branchId: env.CUSTOMER_KASPI_BRANCH_ID,
    paymentAccountId: env.KASPI_REMOTE_ACCOUNT_ID,
    customerIds: env.CUSTOMER_KASPI_PILOT_CUSTOMER_IDS?.split(','),
    repeatOrdersEnabled: env.CUSTOMER_KASPI_PILOT_REPEAT_ORDERS === 'true',
    allVerifiedCustomers: env.CUSTOMER_KASPI_ALL_VERIFIED_CUSTOMERS === 'true',
    maxOrderMinor: env.CUSTOMER_KASPI_PILOT_MAX_MINOR ?? '10000',
    approvalReference: env.CUSTOMER_KASPI_FISCAL_DEFERRAL_REFERENCE,
  });
}
const QuoteInput = z.strictObject({
  key: z.uuid(),
  branchId: z.uuid(),
  serviceMode: z.enum(['takeaway', 'dine_in']),
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
    return {
      enabled: row.ready,
      branchId: scope.branchId,
      restaurant: row.name,
      fiscalPolicy: 'deferred_pilot' as const,
    };
  }
  async quote(customerId: string, input: unknown) {
    const scope = await this.scope(customerId),
      request = parse(QuoteInput, input);
    if (request.branchId !== scope.branchId) throw new CommerceError('FORBIDDEN');
    if (!(await this.config(customerId)).enabled) throw new CommerceError('NOT_READY');
    const head = (
      await this.pool.query<{
        version: number;
        payload: { products: { id: string; sku: string }[] };
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
       WHERE q.id=$1 AND q.organization_id=$2 AND q.branch_id=$3 AND q.principal_id=$4`,
        [request.quoteId, scope.organizationId, scope.branchId, customerId],
      )
    ).rows[0];
    if (!quote) throw new CommerceError('NOT_FOUND');
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
  async pay(customerId: string, orderId: string) {
    const scope = await this.scope(customerId);
    const current = await this.repository.readOrder(scope, orderId);
    if (current.attempts.length || BigInt(current.money.captured) > 0n)
      return this.read(customerId, orderId);
    // A single stable command per order. Unknown responses never create a fresh attempt.
    await this.repository.startPaymentAttempt(scope, keyFor(orderId), {
      orderId,
      providerAccountId: this.options!.paymentAccountId,
    });
    return this.read(customerId, orderId);
  }
  async list(customerId: string) {
    const scope = await this.scope(customerId);
    const rows = await this.pool.query<{ id: string }>(
      'SELECT id FROM commerce_orders WHERE principal_id=$1 AND organization_id=$2 AND branch_id=$3 ORDER BY created_at DESC,id DESC LIMIT 30',
      [customerId, scope.organizationId, scope.branchId],
    );
    return { orders: await Promise.all(rows.rows.map((row) => this.read(customerId, row.id))) };
  }
  async read(customerId: string, orderId: string) {
    const scope = await this.scope(customerId);
    // Ownership is checked before consulting any provider/fulfillment projection.
    const order = await this.repository.readOrder(scope, orderId);
    const [invoice, projection, branch] = await Promise.all([
      this.pool.query<{ state: string; operation_id: string | null; expires_at: Date | null }>(
        'SELECT state,operation_id,expires_at FROM commerce_kaspi_invoices WHERE order_id=$1 ORDER BY issue_started_at DESC LIMIT 1',
        [orderId],
      ),
      this.pool.query<{
        state: string;
        display_number: string | null;
        observed_at: Date;
        assembly: boolean;
      }>(
        `SELECT p.state,p.display_number::text,p.observed_at,
          EXISTS(SELECT 1 FROM cloud_fulfillment_observed_tasks t WHERE t.order_id=p.order_id
          AND t.station_id=p.assembly_station_id AND t.state IN ('in_progress','done')) assembly
         FROM cloud_fulfillment_projection p WHERE p.order_id=$1`,
        [orderId],
      ),
      this.pool.query<{ name: string }>('SELECT name FROM branches WHERE id=$1', [scope.branchId]),
    ]);
    const bank = invoice.rows[0],
      kitchen = projection.rows[0];
    const paid = order.money.captured === order.totalMinor && order.money.refunded === '0';
    const phase =
      order.attentionRequired ||
      BigInt(order.money.refunded) > 0n ||
      ['cancel_requested', 'cancelled', 'released'].includes(kitchen?.state ?? '')
        ? 'attention'
        : paid
          ? kitchen?.state === 'handed_over'
            ? 'handed_over'
            : kitchen?.state === 'ready'
              ? 'ready'
              : ['accepted', 'in_production'].includes(kitchen?.state ?? '')
                ? 'preparing'
                : 'paid'
          : bank?.state === 'unknown' || order.attempts.some((a) => a.state === 'unknown')
            ? 'checking'
            : bank?.state === 'failed' || order.attempts.some((a) => a.state === 'failed')
              ? 'failed'
              : bank?.state === 'issued' && bank.operation_id
                ? 'awaiting_payment'
                : order.attempts.length
                  ? 'sending'
                  : order.state === 'awaiting_payment'
                    ? 'ready_to_pay'
                    : 'awaiting_restaurant';
    const sale = order.fiscalDocuments.find((d) => d.kind === 'sale' && d.state === 'issued');
    // Receipt URLs are intentionally omitted until a dedicated fiscal adapter exposes a verified receipt.
    const body = {
      orderId,
      branchId: scope.branchId,
      createdAt: order.createdAt,
      updatedAt: kitchen?.observed_at.toISOString() ?? order.updatedAt,
      kitchenStage:
        paid && phase === 'preparing' ? (kitchen?.assembly ? 'assembly' : 'cooking') : null,
      restaurant: branch.rows[0]?.name ?? 'PickChick',
      displayNumber: kitchen?.display_number ?? null,
      totalMinor: order.totalMinor,
      serviceMode: order.snapshot.serviceMode as 'takeaway' | 'dine_in',
      phase,
      expiresAt: bank?.expires_at?.toISOString() ?? null,
      receipt: sale ? 'issued' : order.fiscalPolicy === 'deferred_pilot' ? 'deferred' : 'pending',
      receiptUrl: null,
      items: (
        order.snapshot.lines as {
          productId: string;
          title: string;
          quantity: number;
          totalMinor: string;
          selectedDetails?: { modifiers?: { label: { ru: string }; quantity: number }[] };
        }[]
      ).map((line) => ({
        productId: line.productId,
        title: line.title,
        quantity: line.quantity,
        totalMinor: line.totalMinor,
        modifiers:
          line.selectedDetails?.modifiers?.map(
            (m) => `${m.label.ru}${m.quantity > 1 ? ` × ${m.quantity}` : ''}`,
          ) ?? [],
      })),
    };
    return { ...body, revision: digest(body) };
  }
}
