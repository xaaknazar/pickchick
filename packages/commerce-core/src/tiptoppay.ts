import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DatabasePool } from '@pickchick/database';
import { CommerceRepository } from './repository.js';
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
  return { publicId, apiSecret, accountId, acceptNewPayments: false };
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

export function parseTipTopPayPayment(fields: Record<string, string>, event: 'check' | 'pay') {
  if (fields.TestMode !== '0') throw new TipTopPayError('MODE');
  if (
    fields.Currency !== 'KZT' ||
    fields.OperationType !== 'Payment' ||
    fields.Status !== 'Completed' ||
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
    if (event !== 'check' && event !== 'pay') throw new TipTopPayError('INVALID');
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
       JOIN commerce_provider_accounts f ON f.id=o.fiscal_account_id
        AND f.legal_entity_id=p.legal_entity_id AND f.kind='fiscal'
       WHERE a.id=$1 AND p.id=$2 AND p.provider='tiptoppay'
        AND p.kind='payment' AND p.external_reference=$3`,
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
      return {
        code:
          this.config.acceptNewPayments &&
          row.enabled &&
          !row.has_capture &&
          ['pending', 'unknown'].includes(row.state) &&
          row.order_state === 'awaiting_payment'
            ? 0
            : 13,
      };
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
        outcome: 'captured',
        operationId: payment.operationId,
        amountMinor: payment.amountMinor,
        occurredAt: payment.occurredAt,
      },
    );
    // ACK only after the inbox, ledger and outbox transaction has committed.
    return { code: 0 };
  }
}
