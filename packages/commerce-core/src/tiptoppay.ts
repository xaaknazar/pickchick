import { createHmac, timingSafeEqual } from 'node:crypto';
import { transaction, type DatabasePool } from '@pickchick/database';
import { CommerceRepository } from './repository.js';
import { tipTopPayCheckoutOptions } from './tiptoppay-checkout.js';
import { MAX_MINOR, UUIDSchema } from './model.js';

export class TipTopPayError extends Error {
  constructor(public readonly code: 'DISABLED' | 'SIGNATURE' | 'INVALID' | 'MODE' | 'BINDING') {
    super(code);
  }
}
export interface TipTopPayConfig {
  publicId: string;
  apiSecret: string;
  accountId: string;
  acceptNewPayments: boolean;
  approvalReference?: string;
}

// Receiving real bank observations and initiating new charges are separate switches.
// The current commercial ledger must never receive emulated sandbox captures.
export function tipTopPayConfig(env: NodeJS.ProcessEnv): TipTopPayConfig | null {
  if (env.TIPTOPPAY_WEBHOOKS_ENABLED !== 'true') return null;
  const publicId = env.TIPTOPPAY_PUBLIC_ID ?? '';
  const apiSecret = env.TIPTOPPAY_API_SECRET ?? '';
  const accountId = env.TIPTOPPAY_ACCOUNT_ID ?? '';
  if (
    !/^pk_[a-zA-Z0-9]+$/.test(publicId) ||
    apiSecret.length < 16 ||
    !UUIDSchema.safeParse(accountId).success ||
    env.TIPTOPPAY_MODE !== 'live'
  )
    throw new TipTopPayError('INVALID');
  // New payments stay disabled until the independent checkout/fiscal rollout.
  const checkout = tipTopPayCheckoutOptions(env);
  return {
    publicId,
    apiSecret,
    accountId,
    acceptNewPayments: !!checkout,
    ...(checkout ? { approvalReference: checkout.approvalReference } : {}),
  };
}

export function verifyTipTopPayForm(raw: Buffer, signature: string | undefined, secret: string) {
  if (!raw.length || raw.length > 16 * 1024) throw new TipTopPayError('INVALID');
  // Content-HMAC covers the original URL-encoded bytes. Never reserialize parsed fields,
  // and never substitute X-Content-HMAC (decoded form) for this header.
  if (!signature || !/^[A-Za-z0-9+/]{43}=$/.test(signature) || !secret)
    throw new TipTopPayError('SIGNATURE');
  const actual = Buffer.from(signature, 'base64');
  const expected = createHmac('sha256', secret).update(raw).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new TipTopPayError('SIGNATURE');
  const params = new URLSearchParams(raw.toString('utf8'));
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of params) {
    if (Object.hasOwn(fields, key)) throw new TipTopPayError('INVALID');
    fields[key] = value;
  }
  return fields;
}

export function tipTopPayMinor(amount: string | undefined): string {
  if (!amount || !/^(0|[1-9][0-9]{0,13})(\.[0-9]{1,2})?$/.test(amount))
    throw new TipTopPayError('INVALID');
  const [whole, fraction = ''] = amount.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor <= 0n || minor > MAX_MINOR) throw new TipTopPayError('INVALID');
  return minor.toString();
}

export function parseTipTopPayPayment(
  fields: Record<string, string>,
  event: 'check' | 'pay' | 'fail',
) {
  if (fields.TestMode !== '0') throw new TipTopPayError('MODE');
  if (
    fields.Currency !== 'KZT' ||
    fields.OperationType !== 'Payment' ||
    (event !== 'fail' && fields.Status !== 'Completed') ||
    (event === 'fail' && !/^[1-9][0-9]{3}$/.test(fields.ReasonCode ?? '')) ||
    !UUIDSchema.safeParse(fields.InvoiceId).success ||
    !UUIDSchema.safeParse(fields.AccountId).success ||
    !/^[1-9][0-9]{0,18}$/.test(fields.TransactionId ?? '')
  )
    throw new TipTopPayError('INVALID');
  const value = fields.DateTime ?? '';
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new TipTopPayError('INVALID');
  const date = new Date(value.replace(' ', 'T') + 'Z');
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 19) !== value.replace(' ', 'T')
  )
    throw new TipTopPayError('INVALID');
  return {
    eventId: `tiptoppay:${event}:${fields.TransactionId}`,
    attemptId: fields.InvoiceId!,
    customerId: fields.AccountId!,
    operationId: fields.TransactionId!,
    amountMinor: tipTopPayMinor(fields.Amount),
    occurredAt: date.toISOString(),
  };
}

export class TipTopPayReceiver {
  constructor(
    private readonly pool: DatabasePool,
    private readonly config: TipTopPayConfig | null,
  ) {}

  async receive(
    event: string,
    raw: Buffer,
    signature: string | undefined,
  ): Promise<{ code: number }> {
    if (!this.config) throw new TipTopPayError('DISABLED');
    if (event !== 'check' && event !== 'pay' && event !== 'fail')
      throw new TipTopPayError('INVALID');
    const fields = verifyTipTopPayForm(raw, signature, this.config.apiSecret);
    const payment = parseTipTopPayPayment(fields, event);
    const { rows } = await this.pool.query<{
      organization_id: string;
      branch_id: string;
      customer_id: string;
      intended_minor: string;
      state: string;
      order_state: string;
      enabled: boolean;
      has_capture: boolean;
    }>(
      `SELECT p.organization_id,p.branch_id,o.customer_id,a.intended_minor::text,a.state,
        o.state order_state,p.enabled,
        EXISTS(SELECT 1 FROM commerce_captures c WHERE c.order_id=o.id) has_capture
       FROM commerce_payment_attempts a
       JOIN commerce_orders o ON o.id=a.order_id
       JOIN commerce_provider_accounts p ON p.id=a.account_id
        AND p.organization_id=o.organization_id AND p.branch_id=o.branch_id
       JOIN branches b ON b.id=o.branch_id AND b.organization_id=o.organization_id
        AND o.snapshot->>'legalEntityId'=p.legal_entity_id::text
       LEFT JOIN commerce_provider_accounts f ON f.id=o.fiscal_account_id
        AND f.legal_entity_id=p.legal_entity_id AND f.kind='fiscal'
       WHERE a.id=$1 AND p.id=$2 AND p.provider='tiptoppay'
        AND p.kind='payment' AND p.external_reference=$3
        AND (f.id IS NOT NULL OR (o.fiscal_policy='deferred_pilot' AND o.snapshot->>'legalEntityId'=p.legal_entity_id::text))`,
      [payment.attemptId, this.config.accountId, this.config.publicId],
    );
    const row = rows[0];
    if (
      !row ||
      row.customer_id !== payment.customerId ||
      row.intended_minor !== payment.amountMinor
    )
      throw new TipTopPayError('BINDING');
    if (event === 'check') {
      if (
        !this.config.acceptNewPayments ||
        !row.enabled ||
        row.has_capture ||
        row.order_state !== 'awaiting_payment'
      )
        return { code: 13 };
      return transaction(this.pool, async (client) => {
        const session = (
          await client.query<{ authorized_operation_id: string | null }>(
            `SELECT s.authorized_operation_id FROM commerce_tiptoppay_sessions s
           JOIN commerce_orders o ON o.id=s.order_id JOIN commerce_payment_attempts a ON a.id=s.attempt_id
           JOIN commerce_provider_accounts p ON p.id=a.account_id AND p.enabled AND p.provider='tiptoppay' AND p.external_reference=$3
           JOIN branches b ON b.id=o.branch_id AND b.organization_id=o.organization_id AND b.legal_entity_id=p.legal_entity_id
           WHERE a.id=$1 AND a.state='pending' AND o.state='awaiting_payment' AND NOT o.attention_required
            AND s.expires_at>clock_timestamp() AND s.opened_at IS NOT NULL
            AND o.fiscal_deferral_reference=$2
            AND NOT EXISTS(SELECT 1 FROM commerce_captures c WHERE c.order_id=o.id)
           FOR UPDATE OF s,o`,
            [payment.attemptId, this.config!.approvalReference, this.config!.publicId],
          )
        ).rows[0];
        if (
          !session ||
          (session.authorized_operation_id &&
            session.authorized_operation_id !== payment.operationId)
        )
          return { code: 13 };
        await client.query(
          'UPDATE commerce_tiptoppay_sessions SET authorized_operation_id=$2 WHERE attempt_id=$1',
          [payment.attemptId, payment.operationId],
        );
        return { code: 0 };
      });
    }
    // Old/disabled accounts can still deliver late successful payments. The existing
    // transactional provider inbox deduplicates them and schedules reconciliation.
    await new CommerceRepository(this.pool).observePayment(
      {
        organizationId: row.organization_id,
        branchId: row.branch_id,
        accountId: this.config.accountId,
      },
      {
        eventId: payment.eventId,
        attemptId: payment.attemptId,
        // A provider Fail may be followed by fallback authorization. Preserve ambiguity.
        outcome: event === 'fail' ? 'unknown' : 'captured',
        ...(event === 'fail'
          ? {}
          : { operationId: payment.operationId, amountMinor: payment.amountMinor }),
        occurredAt: payment.occurredAt,
      },
    );
    // ACK only after the inbox, ledger and outbox transaction has committed.
    return { code: 0 };
  }
}
