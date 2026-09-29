import { z } from 'zod';
import type { DatabasePool } from '@pickchick/database';
import { CatalogPricing, CatalogPricingError, CartInputSchema } from '@pickchick/catalog-pricing';
import { CommerceError, parse } from './model.js';
import type { CommerceScope } from './model.js';
import type { CommerceRepository } from './repository.js';

/**
 * Commercial mobile checkout paid by a Kaspi invoice (счёт на номер клиента).
 *
 * Server adapter only: the customer id comes from the authenticated identity
 * session, prices from the published catalog, the branch, fiscal and payment
 * accounts and the tax binding from server configuration. The invoice itself is
 * issued asynchronously by KaspiRemoteProcessor from `payment.submit_requested`;
 * nothing here talks to the bank or decides that money was received.
 */
export interface CustomerCheckoutConfig {
  organizationId: string;
  branchId: string;
  fiscalAccountId: string;
  paymentAccountId: string;
  taxApprovalReference: string;
  taxVersion: number;
  taxCode: string;
}

const Uuid = z.uuid();
const Flag = z.enum(['true', 'false']);

/** Disabled (null) unless explicitly enabled; enabled with bad values fails fast. */
export function customerCheckoutConfig(
  env: Record<string, string | undefined>,
): CustomerCheckoutConfig | null {
  const enabled = Flag.safeParse(env.CUSTOMER_KASPI_CHECKOUT_ENABLED ?? 'false');
  if (!enabled.success) throw new Error('CUSTOMER_KASPI_CHECKOUT_ENABLED must be true or false');
  if (enabled.data !== 'true') return null;
  const read = <T>(name: string, schema: z.ZodType<T>): T => {
    const value = schema.safeParse(env[name]);
    if (!value.success) throw new Error(`${name} is missing or invalid`);
    return value.data;
  };
  return {
    organizationId: read('CUSTOMER_CHECKOUT_ORGANIZATION_ID', Uuid),
    branchId: read('CUSTOMER_CHECKOUT_BRANCH_ID', Uuid),
    fiscalAccountId: read('CUSTOMER_CHECKOUT_FISCAL_ACCOUNT_ID', Uuid),
    // The same account the Kaspi worker serves; enabled/disabled in the database.
    paymentAccountId: read('KASPI_REMOTE_ACCOUNT_ID', Uuid),
    // Tax data is an approved business input, never a default invented in code.
    taxApprovalReference: read(
      'CUSTOMER_CHECKOUT_TAX_APPROVAL_REFERENCE',
      z.string().trim().min(3).max(250),
    ),
    taxVersion: read(
      'CUSTOMER_CHECKOUT_TAX_VERSION',
      z
        .string()
        .regex(/^[1-9][0-9]{0,8}$/)
        .transform(Number),
    ),
    taxCode: read('CUSTOMER_CHECKOUT_TAX_CODE', z.string().trim().min(1).max(32)),
  };
}

export const CustomerCartSchema = z.strictObject({
  service_mode: CartInputSchema.shape.service_mode,
  items: CartInputSchema.shape.items,
});
export type CustomerCart = z.infer<typeof CustomerCartSchema>;

export type CustomerCheckoutStage =
  | 'accepting' // the restaurant has not reserved the order yet
  | 'ready_to_pay' // accepted, no invoice requested
  | 'sending_invoice' // requested; the bank has not confirmed an invoice yet
  | 'invoice_sent' // the invoice exists in Kaspi
  | 'checking' // result is being confirmed (never shown as paid)
  | 'invoice_closed' // expired, cancelled, rejected or not issued; a new one is allowed
  | 'unconfirmed' // the result could not be established; no new invoice
  | 'paid'
  | 'attention'; // staff must resolve the order

export type InvoiceClosedReason = 'expired' | 'cancelled' | 'rejected' | 'failed';

export interface CustomerCheckoutView {
  order_id: string;
  stage: CustomerCheckoutStage;
  total_minor: string;
  currency: 'KZT';
  service_mode: 'takeaway' | 'dine_in';
  lines: { title: string; quantity: number; total_minor: string }[];
  invoice: {
    expires_at: string | null;
    closed_reason: InvoiceClosedReason | null;
  } | null;
  can_retry: boolean;
  kitchen_queued: boolean;
}

interface OrderFacts {
  state: string;
  attentionRequired: boolean;
  totalMinor: string;
  kitchenEffectId: string | null;
  money: { captured: string };
  attempts: { id: string; state: string }[];
}
interface InvoiceFacts {
  state: string;
  remote_status: string | null;
  expires_at: Date | string | null;
  /** Issued within the recovery window; an unknown result is still being searched for. */
  recent?: boolean;
}

function closedReason(invoice: InvoiceFacts | null): InvoiceClosedReason {
  switch (invoice?.remote_status) {
    case 'Expired':
      return 'expired';
    case 'RemotePaymentCanceled':
      return 'cancelled';
    case 'RemotePaymentRejected':
      return 'rejected';
    default:
      return 'failed';
  }
}

/**
 * The only mapping from ledger facts to what the customer is told. "paid" comes
 * exclusively from recorded captures; an issued invoice or a returning customer
 * never implies payment.
 */
export function customerCheckoutStage(
  order: OrderFacts,
  invoice: InvoiceFacts | null,
): { stage: CustomerCheckoutStage; closedReason: InvoiceClosedReason | null } {
  if (BigInt(order.money.captured) >= BigInt(order.totalMinor))
    return { stage: 'paid', closedReason: null };
  if (order.attentionRequired || order.state === 'attention_required')
    return { stage: 'attention', closedReason: null };
  if (order.state === 'awaiting_admission') return { stage: 'accepting', closedReason: null };
  const last = order.attempts.at(-1);
  if (!last) return { stage: 'ready_to_pay', closedReason: null };
  switch (last.state) {
    case 'unknown':
      // The worker keeps looking for the invoice by reference for a while; only
      // afterwards is the customer told the result could not be confirmed.
      return { stage: invoice?.recent ? 'checking' : 'unconfirmed', closedReason: null };
    case 'failed':
      return { stage: 'invoice_closed', closedReason: closedReason(invoice) };
    case 'succeeded':
      // Partial or not yet reconciled capture: keep checking, never "paid".
      return { stage: 'checking', closedReason: null };
    default:
      if (!invoice || invoice.state === 'issuing')
        return { stage: 'sending_invoice', closedReason: null };
      if (invoice.state === 'issued') return { stage: 'invoice_sent', closedReason: null };
      return { stage: 'checking', closedReason: null };
  }
}

/** +77011234567 -> +7 701 ••• •• 67. Only ever returned to the phone's owner. */
export function maskCustomerPhone(phone: string): string | null {
  const match = /^\+7(7[0-9]{2})[0-9]{5}([0-9]{2})$/.exec(phone);
  return match ? `+7 ${match[1]} ••• •• ${match[2]}` : null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class CustomerCheckout {
  private readonly pricing: CatalogPricing;
  constructor(
    private readonly pool: DatabasePool,
    private readonly repo: CommerceRepository,
    private readonly config: CustomerCheckoutConfig,
  ) {
    this.pricing = new CatalogPricing(pool);
  }

  /** Each customer is its own principal: idempotency and order reads stay per customer. */
  private scope(customerId: string): CommerceScope {
    return {
      organizationId: this.config.organizationId,
      branchId: this.config.branchId,
      principalId: parse(Uuid, customerId),
      role: 'sales',
    };
  }

  async quote(customerId: string, key: string, input: unknown) {
    const cart = parse(CustomerCartSchema, input);
    const scope = this.scope(customerId);
    const branch = (
      await this.pool.query<{ legal_entity_id: string; published_version: number | null }>(
        `SELECT b.legal_entity_id,h.published_version FROM branches b
         LEFT JOIN catalog_branch_heads h ON h.branch_id=b.id AND h.organization_id=b.organization_id
         WHERE b.id=$1 AND b.organization_id=$2`,
        [scope.branchId, scope.organizationId],
      )
    ).rows[0];
    if (!branch?.published_version) throw new CommerceError('NOT_READY');
    const priced = await this.pricing.price(
      {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        customerId: scope.principalId,
        channel: 'mobile',
      },
      { ...cart, catalog_version: branch.published_version },
    );
    const quote = await this.repo.issueQuote(scope, key, {
      ...priced,
      channel: 'mobile',
      taxBinding: {
        legalEntityId: branch.legal_entity_id,
        approvalReference: this.config.taxApprovalReference,
        version: this.config.taxVersion,
      },
      lines: priced.lines.map((line) => ({ ...line, taxCode: this.config.taxCode })),
    });
    const snapshot = quote.snapshot as {
      totalMinor: string;
      lines: { title: string; quantity: number; totalMinor: string }[];
    };
    return {
      quote_id: quote.quoteId,
      total_minor: snapshot.totalMinor,
      currency: 'KZT' as const,
      expires_at: quote.expiresAt,
      lines: snapshot.lines.map((line) => ({
        title: line.title,
        quantity: line.quantity,
        total_minor: line.totalMinor,
      })),
    };
  }

  async createOrder(customerId: string, key: string, input: unknown) {
    const request = parse(z.strictObject({ quote_id: Uuid }), input);
    const created = await this.repo.createOrder(this.scope(customerId), key, {
      quoteId: request.quote_id,
      fiscalAccountId: this.config.fiscalAccountId,
    });
    return this.read(customerId, created.orderId);
  }

  /**
   * Requests an invoice when the order is accepted and no invoice is open or
   * unresolved. Safe to repeat: while the restaurant is still accepting it only
   * reports that; an open, paid or unconfirmed payment is never duplicated.
   */
  async pay(customerId: string, key: string, orderId: string) {
    const before = await this.read(customerId, orderId);
    if (before.stage !== 'ready_to_pay' && before.stage !== 'invoice_closed') return before;
    try {
      await this.repo.startPaymentAttempt(this.scope(customerId), key, {
        orderId: before.order_id,
        providerAccountId: this.config.paymentAccountId,
      });
    } catch (error) {
      // A concurrent request or an admission change won the race; report the facts.
      if (!(error instanceof CommerceError) || error.code !== 'NOT_READY') throw error;
    }
    return this.read(customerId, orderId);
  }

  async read(customerId: string, orderId: string): Promise<CustomerCheckoutView> {
    const order = await this.repo.readOrder(this.scope(customerId), parse(Uuid, orderId));
    const last = order.attempts.at(-1) as { id: string; state: string } | undefined;
    const invoice = last
      ? ((
          await this.pool.query<InvoiceFacts>(
            `SELECT state,remote_status,expires_at,
                    issue_started_at>clock_timestamp()-interval '10 minutes' AS recent
               FROM commerce_kaspi_invoices WHERE attempt_id=$1 AND order_id=$2`,
            [last.id, order.orderId],
          )
        ).rows[0] ?? null)
      : null;
    const { stage, closedReason: reason } = customerCheckoutStage(
      {
        state: order.state,
        attentionRequired: order.attentionRequired,
        totalMinor: String(order.totalMinor),
        kitchenEffectId: order.kitchenEffectId,
        money: { captured: String(order.money.captured) },
        attempts: order.attempts as { id: string; state: string }[],
      },
      invoice,
    );
    const snapshot = order.snapshot as {
      serviceMode: 'takeaway' | 'dine_in';
      lines: { title: string; quantity: number; totalMinor: string }[];
    };
    return {
      order_id: order.orderId,
      stage,
      total_minor: String(order.totalMinor),
      currency: 'KZT',
      service_mode: snapshot.serviceMode,
      lines: snapshot.lines.map((line) => ({
        title: line.title,
        quantity: line.quantity,
        total_minor: line.totalMinor,
      })),
      invoice: invoice
        ? {
            expires_at: stage === 'invoice_sent' ? iso(invoice.expires_at) : null,
            closed_reason: reason,
          }
        : null,
      can_retry: stage === 'invoice_closed' || stage === 'ready_to_pay',
      kitchen_queued: order.kitchenEffectId !== null,
    };
  }
}

/** HTTP mapping shared by the API adapter and tests; codes exist in the public ErrorSchema. */
export function customerCheckoutError(error: unknown): { status: number; code: string } | null {
  if (error instanceof CatalogPricingError) {
    switch (error.code) {
      case 'STALE_CATALOG':
      case 'CATALOG_NOT_FOUND':
        return { status: 409, code: 'MENU_CHANGED' };
      case 'PRODUCT_UNAVAILABLE':
        return { status: 409, code: 'ITEM_STOPPED' };
      case 'BRANCH_UNAVAILABLE':
        return { status: 409, code: 'BRANCH_UNAVAILABLE' };
      default:
        return { status: 400, code: 'INVALID_REQUEST' };
    }
  }
  if (error instanceof CommerceError) {
    switch (error.code) {
      case 'INVALID':
        return { status: 400, code: 'INVALID_REQUEST' };
      case 'FORBIDDEN':
        return { status: 403, code: 'FORBIDDEN' };
      case 'NOT_FOUND':
        return { status: 404, code: 'NOT_FOUND' };
      case 'EXPIRED':
        return { status: 409, code: 'QUOTE_EXPIRED' };
      case 'NOT_READY':
        return { status: 409, code: 'NOT_READY' };
      default:
        return { status: 409, code: 'CONFLICT' };
    }
  }
  return null;
}
