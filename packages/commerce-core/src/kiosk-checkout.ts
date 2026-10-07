import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DatabasePool } from '@pickchick/database';
import {
  CatalogPricing,
  CatalogPricingError,
  CatalogKioskStorefrontSchema,
  readCatalogMenuDelivery,
} from '@pickchick/catalog-pricing';
import { CommerceRepository } from './repository.js';
import { CommerceError, parse, UUIDSchema, type CommerceScope } from './model.js';
import { KioskSessions } from './kiosk-sessions.js';
import { readKioskQrPayment } from './kiosk-kaspi-qr.js';
import { readCheckoutOrder } from './order-view.js';
import { localSelectionIds } from '@pickchick/menu-sync';
import {
  branchAvailability,
  assertBranchItemsAvailable,
  snapshotAvailabilityItems,
} from './availability.js';
import {
  RestaurantHoursSchema,
  restaurantHoursFromEnv,
  assertRestaurantOrderingOpen,
} from './restaurant-hours.js';

const Options = z
  .strictObject({
    organizationId: z.uuid(),
    branchId: z.uuid(),
    paymentAccountId: z.uuid(),
    paymentMethod: z.enum(['kaspi_invoice', 'kaspi_qr']).optional(),
    fiscalAccountId: z.uuid().optional(),
    fiscalPolicy: z.enum(['required', 'deferred_pilot']),
    approvalReference: z.string().trim().min(3).max(250),
    taxCode: z.string().trim().min(1).max(32),
    maxOrderMinor: z.string().regex(/^[1-9][0-9]{0,8}$/),
    hours: RestaurantHoursSchema,
  })
  .refine((o) => o.fiscalPolicy !== 'required' || !!o.fiscalAccountId);
export type KioskCheckoutOptions = z.infer<typeof Options>;
/** Separate opt-in: a mobile pilot never enables unattended kiosk payments. */
export function kioskCheckoutOptions(env: NodeJS.ProcessEnv): KioskCheckoutOptions | null {
  if (env.KIOSK_CHECKOUT_ENABLED !== 'true') return null;
  return parse(Options, {
    organizationId: env.KIOSK_CHECKOUT_ORGANIZATION_ID,
    branchId: env.KIOSK_CHECKOUT_BRANCH_ID,
    paymentAccountId:
      env.KIOSK_CHECKOUT_PAYMENT_METHOD === 'kaspi_qr'
        ? env.KIOSK_KASPI_QR_ACCOUNT_ID
        : env.KASPI_REMOTE_ACCOUNT_ID,
    paymentMethod: env.KIOSK_CHECKOUT_PAYMENT_METHOD ?? 'kaspi_invoice',
    fiscalAccountId: env.KIOSK_CHECKOUT_FISCAL_ACCOUNT_ID,
    fiscalPolicy: env.KIOSK_CHECKOUT_FISCAL_POLICY ?? 'required',
    approvalReference: env.KIOSK_CHECKOUT_APPROVAL_REFERENCE,
    taxCode: env.KIOSK_CHECKOUT_TAX_CODE,
    maxOrderMinor: env.KIOSK_CHECKOUT_MAX_MINOR ?? '10000',
    hours: restaurantHoursFromEnv(env),
  });
}
/** Used independently by the payment worker, even when new kiosk checkout is disabled. */
export function kioskPiiKey(env: NodeJS.ProcessEnv): Buffer | null {
  const key = env.KIOSK_CHECKOUT_PII_KEY;
  if (!key) return null;
  if (!/^[a-f0-9]{64}$/.test(key)) throw new CommerceError('INVALID');
  return Buffer.from(key, 'hex');
}
const QuoteInput = z.strictObject({
  key: z.uuid(),
  branchId: z.uuid(),
  catalog_version: z.int().positive(),
  serviceMode: z.enum(['takeaway', 'dine_in']),
  kitchenComment: z.string().trim().max(60).optional(),
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
export type KioskGuest = {
  sessionId: string;
  organizationId: string;
  branchId: string;
  deviceId: string;
};
const paymentKey = (orderId: string) => {
  const h = createHash('sha256').update(`kiosk-kaspi:${orderId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export class KioskCheckout {
  readonly repository: CommerceRepository;
  constructor(
    private readonly pool: DatabasePool,
    private readonly options: KioskCheckoutOptions | null,
    private readonly sessions: KioskSessions,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.repository = new CommerceRepository(
      pool,
      options?.fiscalPolicy === 'deferred_pilot'
        ? { ...options, repeatOrdersEnabled: true }
        : undefined,
    );
  }
  private scope(guest: KioskGuest): CommerceScope {
    if (!this.options) throw new CommerceError('NOT_READY');
    if (
      guest.organizationId !== this.options.organizationId ||
      guest.branchId !== this.options.branchId
    )
      throw new CommerceError('FORBIDDEN');
    return {
      organizationId: guest.organizationId,
      branchId: guest.branchId,
      principalId: guest.sessionId,
      role: 'sales',
    };
  }
  async catalog(guest: KioskGuest) {
    const scope = this.scope(guest);
    const row = (
      await this.pool.query<{
        id: string;
        code: string;
        name: string;
        timezone: string;
        ordering_enabled: boolean;
        version: number;
        published_at: Date;
        payload: unknown;
      }>(
        `SELECT b.id,b.code,b.name,b.timezone,b.ordering_enabled,p.version,p.published_at,p.payload
       FROM branches b JOIN catalog_branch_heads h ON h.branch_id=b.id AND h.organization_id=b.organization_id
       JOIN catalog_publications p ON p.branch_id=h.branch_id AND p.organization_id=h.organization_id AND p.version=h.published_version
       WHERE b.id=$1 AND b.organization_id=$2`,
        [scope.branchId, scope.organizationId],
      )
    ).rows[0];
    if (!row) throw new CommerceError('NOT_READY');
    return CatalogKioskStorefrontSchema.parse({
      branch: {
        id: row.id,
        code: row.code,
        name: row.name,
        timezone: row.timezone,
        ordering_enabled: row.ordering_enabled,
      },
      channel: 'kiosk',
      version: row.version,
      published_at: row.published_at.toISOString(),
      payload: row.payload,
    });
  }
  async availability(guest: KioskGuest) {
    const scope = this.scope(guest),
      catalog = await this.catalog(guest);
    const state = await branchAvailability(this.pool, scope.branchId),
      stopped = new Set(state.stoppedIds);
    return {
      fresh: state.fresh,
      products: catalog.payload.products.map((product) => ({
        productId: product.id,
        available:
          product.available &&
          !stopped.has(product.id) &&
          !localSelectionIds(scope.branchId, product.id, []).some((id) => stopped.has(id)),
        stoppedOptions: product.modifier_groups.flatMap((group) =>
          group.options
            .filter(
              (option) =>
                !option.available ||
                localSelectionIds(scope.branchId, product.id, [
                  { group_id: group.id, option_id: option.id },
                ]).some((id) => stopped.has(id)),
            )
            .map((option) => ({ group_id: group.id, option_id: option.id })),
        ),
      })),
    };
  }
  async config(guest: KioskGuest) {
    const scope = this.scope(guest),
      opt = this.options!;
    const row = (
      await this.pool.query<{ name: string; ready: boolean; version: number | null }>(
        `SELECT b.name,h.published_version version,(b.ordering_enabled AND
       EXISTS(SELECT 1 FROM commerce_provider_accounts a WHERE a.id=$3 AND a.branch_id=b.id
       AND a.organization_id=b.organization_id AND a.legal_entity_id=b.legal_entity_id
       AND a.kind='payment' AND a.provider=$5 AND a.enabled) AND
       ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM commerce_provider_accounts f WHERE f.id=$4 AND f.branch_id=b.id
       AND f.organization_id=b.organization_id AND f.legal_entity_id=b.legal_entity_id AND f.kind='fiscal' AND f.enabled))) ready
       FROM branches b LEFT JOIN catalog_branch_heads h ON h.branch_id=b.id AND h.organization_id=b.organization_id
       WHERE b.id=$1 AND b.organization_id=$2`,
        [
          scope.branchId,
          scope.organizationId,
          opt.paymentAccountId,
          opt.fiscalAccountId ?? null,
          opt.paymentMethod === 'kaspi_qr' ? 'kaspi-qr' : 'kaspi-remote',
        ],
      )
    ).rows[0];
    if (!row) throw new CommerceError('NOT_READY');
    const delivery = row.version
      ? await readCatalogMenuDelivery(this.pool, scope.branchId, row.version)
      : null;
    return {
      enabled: row.ready && delivery?.status === 'applied',
      branchId: scope.branchId,
      restaurant: row.name,
      paymentMethod: opt.paymentMethod ?? 'kaspi_invoice',
    };
  }
  async quote(guest: KioskGuest, input: unknown) {
    const scope = this.scope(guest),
      req = parse(QuoteInput, input),
      opt = this.options!;
    if (scope.branchId !== req.branchId) throw new CommerceError('FORBIDDEN');
    assertRestaurantOrderingOpen(opt.hours, this.now());
    if (!(await this.config(guest)).enabled) throw new CommerceError('NOT_READY');
    const catalog = await this.catalog(guest);
    // Availability identifiers are catalog product ids, while the pricing port accepts SKU.
    const items = req.items.map((item) => {
      const product = catalog.payload.products.find((p) => p.sku === item.productId);
      if (!product) throw new CommerceError('INVALID');
      return { productId: product.id, selections: item.selections };
    });
    await assertBranchItemsAvailable(this.pool, scope.branchId, items);
    let priced;
    try {
      priced = await new CatalogPricing(this.pool).price(
        {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          customerId: null,
          channel: 'kiosk',
        },
        {
          catalog_version: req.catalog_version,
          service_mode: req.serviceMode,
          items: req.items.map((i) => ({
            sku: i.productId,
            quantity: i.quantity,
            selections: i.selections,
          })),
        },
      );
    } catch (error) {
      if (error instanceof CatalogPricingError) throw new CommerceError('CONFLICT');
      throw error;
    }
    if (
      BigInt(priced.totalMinor) > BigInt(opt.maxOrderMinor) ||
      BigInt(priced.totalMinor) % 100n !== 0n
    )
      throw new CommerceError('INVALID');
    const legal = (
      await this.pool.query<{ legal_entity_id: string }>(
        'SELECT legal_entity_id FROM branches WHERE id=$1',
        [scope.branchId],
      )
    ).rows[0]!;
    const quote = await this.repository.issueQuote(scope, req.key, {
      ...priced,
      ...(req.kitchenComment ? { kitchenComment: req.kitchenComment } : {}),
      taxBinding: {
        legalEntityId: legal.legal_entity_id,
        approvalReference: opt.approvalReference,
        version: 1,
      },
      lines: priced.lines.map((line) => ({ ...line, taxCode: opt.taxCode })),
    });
    return {
      quoteId: quote.quoteId,
      totalMinor: quote.snapshot.totalMinor,
      expiresAt: quote.expiresAt,
      serviceMode: req.serviceMode,
    };
  }
  async create(guest: KioskGuest, input: unknown) {
    const scope = this.scope(guest),
      req = parse(z.strictObject({ key: z.uuid(), quoteId: z.uuid() }), input),
      opt = this.options!;
    const prior = (
      await this.pool.query<{ id: string; quote_id: string }>(
        "SELECT id,quote_id FROM commerce_orders WHERE organization_id=$1 AND branch_id=$2 AND principal_id=$3 AND customer_id IS NULL AND snapshot->>'channel'='kiosk'",
        [scope.organizationId, scope.branchId, scope.principalId],
      )
    ).rows[0];
    if (prior) {
      if (prior.quote_id !== req.quoteId) throw new CommerceError('CONFLICT');
      return this.read(guest, prior.id);
    }
    assertRestaurantOrderingOpen(opt.hours, this.now());
    if (!(await this.config(guest)).enabled) throw new CommerceError('NOT_READY');
    const quote = await this.pool.query(
      "SELECT 1 FROM commerce_quotes WHERE id=$1 AND principal_id=$2 AND organization_id=$3 AND branch_id=$4 AND customer_id IS NULL AND snapshot->>'channel'='kiosk'",
      [req.quoteId, scope.principalId, scope.organizationId, scope.branchId],
    );
    if (!quote.rowCount) throw new CommerceError('NOT_FOUND');
    // A valid earlier quote keeps its immutable price. New quotes require the current head.
    let order;
    try {
      order =
        opt.fiscalPolicy === 'deferred_pilot'
          ? await this.repository.createDeferredFiscalOrder(scope, req.key, req.quoteId)
          : await this.repository.createOrder(scope, req.key, {
              quoteId: req.quoteId,
              fiscalAccountId: opt.fiscalAccountId!,
            });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
        throw new CommerceError('CONFLICT');
      throw error;
    }
    return this.read(guest, order.orderId);
  }
  async pay(guest: KioskGuest, orderId: string, input: unknown) {
    const scope = this.scope(guest);
    const qr = this.options!.paymentMethod === 'kaspi_qr';
    const req = qr
      ? parse(z.strictObject({ method: z.literal('kaspi_qr') }), input)
      : parse(z.strictObject({ phone: z.string().regex(/^\+77\d{9}$/) }), input);
    parse(UUIDSchema, orderId);
    await this.assertKioskOrder(scope, orderId);
    const order = await this.repository.readOrder(scope, orderId);
    // Lock phone before enqueueing. A racing retry can never redirect the existing invoice.
    if ('phone' in req) await this.sessions.setPhone(guest.sessionId, req.phone);
    if (order.attempts.length || BigInt(order.money.captured) > 0n)
      return this.read(guest, orderId);
    assertRestaurantOrderingOpen(this.options!.hours, this.now());
    if (!(await this.config(guest)).enabled) throw new CommerceError('NOT_READY');
    await assertBranchItemsAvailable(
      this.pool,
      scope.branchId,
      snapshotAvailabilityItems(order.snapshot),
    );
    await this.repository.startPaymentAttempt(scope, paymentKey(orderId), {
      orderId,
      providerAccountId: this.options!.paymentAccountId,
    });
    return this.read(guest, orderId);
  }
  private async assertKioskOrder(scope: CommerceScope, orderId: string) {
    parse(UUIDSchema, orderId);
    const found = await this.pool.query(
      "SELECT 1 FROM commerce_orders WHERE id=$1 AND principal_id=$2 AND organization_id=$3 AND branch_id=$4 AND customer_id IS NULL AND snapshot->>'channel'='kiosk'",
      [orderId, scope.principalId, scope.organizationId, scope.branchId],
    );
    if (!found.rowCount) throw new CommerceError('NOT_FOUND');
  }
  async read(guest: KioskGuest, orderId: string) {
    await this.assertKioskOrder(this.scope(guest), orderId);
    const order = await readCheckoutOrder(this.pool, this.repository, this.scope(guest), orderId);
    if (this.options!.paymentMethod !== 'kaspi_qr') return order;
    const payment = await readKioskQrPayment(this.pool, orderId);
    // QR presentation is kiosk-only; shared mobile invoice projection stays intact.
    const phase =
      order.phase === 'sending' && payment?.state === 'pending'
        ? 'awaiting_payment'
        : order.phase === 'sending' && payment?.state === 'checking'
          ? 'checking'
          : order.phase;
    return { ...order, phase, payment };
  }
}
