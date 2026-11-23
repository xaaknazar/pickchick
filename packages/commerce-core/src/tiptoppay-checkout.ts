import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { transaction, type DatabasePool } from '@pickchick/database';
import { z } from 'zod';
import { CommerceError, parse, UUIDSchema } from './model.js';
import { CommerceRepository } from './repository.js';
import {
  TIPTOPPAY_API,
  TipTopPayMethodSchema,
  findGooglePayGateway,
  holderMessage,
  operationId,
  tipTopPayCall,
  type ChargeModel,
  type TipTopPayFetch,
  type TipTopPayMethod,
} from './tiptoppay-test-checkout.js';
import { tipTopPayMinor } from './tiptoppay.js';

/**
 * TipTopPay LIVE checkout of the mobile app (owner 23.11.2026: TipTopPay switched site 8194419 to
 * live mode; «делай сейчас и чтобы было готово это все»). Unlike the TEST sandbox
 * (tiptoppay-test-checkout.ts) a live payment pays a real order: the same order, admission and
 * kitchen path as a Kaspi payment, only the attempt belongs to the TipTopPay payment account.
 *
 * Money truth comes only from the bank:
 * - the synchronous answer of payments/cards/charge or post3ds (our API secret, TLS),
 * - the signed Pay / Fail notifications (TipTopPayReceiver, Content-HMAC),
 * - payments/find by InvoiceId (= our attempt id) for anything still open (reconcile()).
 * Each of them becomes a provider observation (CommerceRepository.observePayment): the inbox,
 * ledger and outbox transaction that also hands a paid order to the kitchen. The card cryptogram
 * or wallet token is sent to the bank once and never stored.
 *
 * Refunds (refunds()): a manager's refund request (refund.submit_requested on this account) is
 * sent to payments/refund once per refund id (X-Request-ID); a missing answer stays «unknown»
 * for a manager, never a second refund.
 */
export interface TipTopPayCheckoutOptions {
  /** commerce_provider_accounts.id of the live TipTopPay payment account. */
  accountId: string;
  publicId: string;
  apiSecret: string;
  origin: string;
  methods: TipTopPayMethod[];
  googlePayGateway?: string;
}

/**
 * TIPTOPPAY_CHECKOUT_ENABLED=true opens live TipTopPay payments. It needs the live receiver
 * (TIPTOPPAY_MODE=live, TIPTOPPAY_WEBHOOKS_ENABLED=true, keys and account) and the methods.
 */
export function tipTopPayCheckoutOptions(env: NodeJS.ProcessEnv): TipTopPayCheckoutOptions | null {
  if (env.TIPTOPPAY_CHECKOUT_ENABLED === undefined || env.TIPTOPPAY_CHECKOUT_ENABLED === 'false')
    return null;
  if (env.TIPTOPPAY_CHECKOUT_ENABLED !== 'true') throw new CommerceError('INVALID');
  const publicId = env.TIPTOPPAY_PUBLIC_ID ?? '',
    apiSecret = env.TIPTOPPAY_API_SECRET ?? '';
  if (
    env.TIPTOPPAY_MODE !== 'live' ||
    env.TIPTOPPAY_WEBHOOKS_ENABLED !== 'true' ||
    !/^pk_[a-zA-Z0-9]+$/.test(publicId) ||
    apiSecret.length < 16 ||
    env.TIPTOPPAY_TEST_CHECKOUT_ENABLED === 'true'
  )
    throw new CommerceError('NOT_READY');
  const origin = new URL(env.TIPTOPPAY_CHECKOUT_ORIGIN ?? '');
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new CommerceError('INVALID');
  const methods = z
    .array(TipTopPayMethodSchema)
    .min(1)
    .max(3)
    .parse((env.TIPTOPPAY_CHECKOUT_METHODS ?? 'card').split(',').map((m) => m.trim()));
  if (new Set(methods).size !== methods.length) throw new CommerceError('INVALID');
  if (methods.includes('apple_pay') && env.TIPTOPPAY_APPLE_PAY_CERTIFICATE_READY !== 'true')
    throw new CommerceError('NOT_READY');
  return {
    accountId: parse(UUIDSchema, env.TIPTOPPAY_ACCOUNT_ID),
    publicId,
    apiSecret,
    origin: origin.origin,
    methods,
    ...(env.TIPTOPPAY_GOOGLE_PAY_GATEWAY
      ? {
          googlePayGateway: z
            .string()
            .regex(/^[a-z0-9_-]{2,60}$/i)
            .parse(env.TIPTOPPAY_GOOGLE_PAY_GATEWAY),
        }
      : {}),
  };
}

export type TipTopPayLiveSetup = {
  publicId: string;
  publicKey: { pem: string; version: number };
  googlePay: { gateway: string; gatewayMerchantId: string } | null;
  environment: 'live';
};
/** What the charge endpoint adds to the order view for the app. */
export type TipTopPayChargeHint = {
  /** Present while the card waits for 3-D Secure: open it in the in-app browser. */
  threeDsUrl?: string;
  /** The bank's words for a decline, shown to the customer as is. */
  message?: string;
};
export type TipTopPayAttempt = {
  attemptId: string;
  orderId: string;
  organizationId: string;
  branchId: string;
  customerId: string;
  amountMinor: string;
};
const ChargeInput = z.strictObject({
  method: TipTopPayMethodSchema,
  cryptogram: z.string().min(16).max(16384),
});
type SessionRow = {
  attempt_id: string;
  order_id: string;
  method: TipTopPayMethod | null;
  opened_at: Date | null;
  authorized_operation_id: string | null;
  reconcile_attempts: number;
  created_at: Date;
  attempt_state: string;
  intended_minor: string;
  customer_id: string;
  organization_id: string;
  branch_id: string;
};
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
/** Reconciliation spacing: quick at first (3-D Secure in progress), then backing off. */
export function tipTopPayNextCheckSeconds(attempts: number): number {
  return [5, 10, 20, 30, 60, 60, 120, 300, 600, 900][Math.min(attempts, 9)]!;
}
/** An opened session the bank has never heard of after this long was not charged. */
export const TIPTOPPAY_NOT_FOUND_FAIL_MS = 20 * 60_000;
/** An attempt that never reached the bank (no session) fails after this long. */
export const TIPTOPPAY_UNSENT_FAIL_MS = 15 * 60_000;

export class TipTopPayCheckout {
  private readonly repo: CommerceRepository;
  constructor(
    private readonly pool: DatabasePool,
    private readonly options: TipTopPayCheckoutOptions | null,
    private readonly now: () => number = Date.now,
    private readonly request: TipTopPayFetch = (...args) => fetch(...args),
  ) {
    this.repo = new CommerceRepository(pool);
  }
  get enabled() {
    return this.options !== null;
  }
  /** Live methods the app may offer, or null when live TipTopPay is off. */
  get methods(): TipTopPayMethod[] | null {
    return this.options ? [...this.options.methods] : null;
  }
  get accountId(): string | null {
    return this.options?.accountId ?? null;
  }
  get publicId(): string | null {
    return this.options?.publicId ?? null;
  }
  private setupCache: { at: number; value: TipTopPayLiveSetup } | null = null;
  /** Public key for the card cryptogram and the Google Pay gateway (never the API secret). */
  async setup(): Promise<TipTopPayLiveSetup> {
    if (!this.options) throw new CommerceError('NOT_READY');
    if (this.setupCache && this.now() - this.setupCache.at < 600_000) return this.setupCache.value;
    const read = async (path: string) => {
      const response = await this.request(TIPTOPPAY_API + path, {
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      const text = await response.text();
      if (!response.ok || text.length > 65536) throw new CommerceError('NOT_READY');
      return JSON.parse(text) as unknown;
    };
    const key = (await read('/payments/publickey')) as { Pem?: unknown; Version?: unknown };
    if (
      typeof key.Pem !== 'string' ||
      !key.Pem.includes('BEGIN PUBLIC KEY') ||
      key.Pem.length > 4096 ||
      !Number.isSafeInteger(key.Version)
    )
      throw new CommerceError('NOT_READY');
    let gateway = this.options.googlePayGateway ?? null;
    if (!gateway && this.options.methods.includes('google_pay')) {
      try {
        gateway = findGooglePayGateway(
          await read(
            `/merchant/configuration?terminalPublicId=${encodeURIComponent(this.options.publicId)}`,
          ),
        );
      } catch {
        gateway = null;
      }
    }
    const value: TipTopPayLiveSetup = {
      publicId: this.options.publicId,
      publicKey: { pem: key.Pem, version: key.Version as number },
      googlePay: gateway ? { gateway, gatewayMerchantId: this.options.publicId } : null,
      environment: 'live',
    };
    this.setupCache = { at: this.now(), value };
    return value;
  }
  private async session(attemptId: string): Promise<SessionRow | undefined> {
    return (
      await this.pool.query<SessionRow>(
        `SELECT s.attempt_id,s.order_id,s.method,s.opened_at,s.authorized_operation_id,
          s.reconcile_attempts,s.created_at,a.state attempt_state,a.intended_minor::text,
          o.customer_id,o.organization_id,o.branch_id
         FROM commerce_tiptoppay_sessions s
         JOIN commerce_payment_attempts a ON a.id=s.attempt_id AND a.order_id=s.order_id
         JOIN commerce_orders o ON o.id=s.order_id
         WHERE s.attempt_id=$1 AND a.account_id=$2`,
        [attemptId, this.options!.accountId],
      )
    ).rows[0];
  }
  /**
   * Charges a pending attempt (CustomerCheckout.startTipTopPayAttempt) once with the customer's
   * cryptogram or wallet token. A second call for the same attempt never charges again: the app
   * then follows the order view. Returns what the app needs besides the order view.
   */
  async charge(
    attempt: TipTopPayAttempt,
    input: unknown,
    ip: string,
  ): Promise<TipTopPayChargeHint> {
    if (!this.options) throw new CommerceError('NOT_READY');
    const request = parse(ChargeInput, input);
    if (!this.options.methods.includes(request.method)) throw new CommerceError('NOT_READY');
    const address = isIP(ip) ? ip.replace(/^::ffff:/, '') : '127.0.0.1';
    const opened = await transaction(this.pool, async (client) => {
      const row = (
        await client.query<{ state: string; intended_minor: string }>(
          `SELECT a.state,a.intended_minor::text FROM commerce_payment_attempts a
           JOIN commerce_provider_accounts p ON p.id=a.account_id
           WHERE a.id=$1 AND a.order_id=$2 AND a.account_id=$3 AND p.provider='tiptoppay'
            AND p.kind='payment' FOR UPDATE OF a`,
          [attempt.attemptId, attempt.orderId, this.options!.accountId],
        )
      ).rows[0];
      if (!row) throw new CommerceError('NOT_FOUND');
      if (row.intended_minor !== attempt.amountMinor) throw new CommerceError('CONFLICT');
      if (row.state !== 'pending') return false;
      // opened_at marks "sent to the bank": an attempt is charged at most once.
      const inserted = await client.query(
        `INSERT INTO commerce_tiptoppay_sessions(attempt_id,order_id,token_hash,expires_at,opened_at,method,next_check_at)
         VALUES($1,$2,$3,clock_timestamp()+interval '20 minutes',clock_timestamp(),$4,clock_timestamp()+interval '30 seconds')
         ON CONFLICT(attempt_id) DO NOTHING`,
        [attempt.attemptId, attempt.orderId, hash(randomBytes(32).toString('hex')), request.method],
      );
      if (!inserted.rowCount) return false;
      // The payment method of the order is frozen by the attempt (039).
      await client.query(
        `INSERT INTO commerce_checkout_payment_methods(order_id,method,locked_at) VALUES($1,$2,clock_timestamp())
         ON CONFLICT(order_id) DO UPDATE SET method=EXCLUDED.method,locked_at=EXCLUDED.locked_at,updated_at=clock_timestamp()`,
        [attempt.orderId, request.method],
      );
      // This adapter submits in the request itself; the durable submission is done.
      await client.query(
        `UPDATE commerce_outbox SET acknowledged_at=COALESCE(acknowledged_at,clock_timestamp())
         WHERE order_id=$1 AND event_type='payment.submit_requested' AND payload->>'attemptId'=$2`,
        [attempt.orderId, attempt.attemptId],
      );
      return true;
    });
    if (!opened) return {};
    let result;
    try {
      result = await tipTopPayCall(
        this.options,
        '/payments/cards/charge',
        {
          Amount: Number(attempt.amountMinor) / 100,
          Currency: 'KZT',
          IpAddress: address,
          CardCryptogramPacket: request.cryptogram,
          InvoiceId: attempt.attemptId,
          AccountId: attempt.customerId,
          Description: 'PickChick: оплата заказа',
          CultureName: 'ru-RU',
        },
        attempt.attemptId,
        this.request,
      );
    } catch {
      // No answer is not a decline: the bank may still have charged. Pay/Fail or find settle it.
      await this.observe(attempt, {
        outcome: 'unknown',
        eventId: `tiptoppay:charge-lost:${attempt.attemptId}`,
      });
      return {};
    }
    return this.apply(attempt, result, 'charge');
  }
  /** One observation of this attempt on the live account. */
  private observe(
    attempt: Pick<TipTopPayAttempt, 'attemptId' | 'organizationId' | 'branchId'>,
    event:
      | { outcome: 'captured'; eventId: string; operationId: string; amountMinor: string }
      | { outcome: 'failed' | 'unknown' | 'pending'; eventId: string },
  ) {
    return this.repo.observePayment(
      {
        organizationId: attempt.organizationId,
        branchId: attempt.branchId,
        accountId: this.options!.accountId,
      },
      {
        attemptId: attempt.attemptId,
        occurredAt: new Date(this.now()).toISOString(),
        ...event,
      },
    );
  }
  /** The bank's answer to charge / post3ds / find for this attempt. */
  private async apply(
    attempt: TipTopPayAttempt,
    result: { Success?: boolean; Message?: string | null; Model?: ChargeModel | null },
    source: 'charge' | '3ds' | 'find',
  ): Promise<TipTopPayChargeHint> {
    const model = result.Model ?? null;
    const transactionId = operationId(model?.TransactionId);
    // A foreign invoice or a sandbox answer on the live terminal is never money: a manager looks.
    if (
      (model?.InvoiceId && model.InvoiceId !== attempt.attemptId) ||
      (model && model.TestMode === true)
    ) {
      await this.observe(attempt, {
        outcome: 'unknown',
        eventId: `tiptoppay:${source}-mismatch:${attempt.attemptId}:${transactionId ?? 'none'}`,
      });
      return {};
    }
    if (transactionId && model?.Status === 'Completed') {
      let amountMinor: string | null;
      try {
        amountMinor =
          model.Amount === undefined || model.Amount === null
            ? null
            : tipTopPayMinor(String(model.Amount));
      } catch {
        amountMinor = 'invalid';
      }
      // The charge answer may omit Amount; the bank charged exactly what we asked then.
      if (amountMinor !== null && amountMinor !== attempt.amountMinor) {
        await this.observe(attempt, {
          outcome: 'unknown',
          eventId: `tiptoppay:${source}-amount:${transactionId}`,
        });
        return {};
      }
      await this.pool.query(
        'UPDATE commerce_tiptoppay_sessions SET authorized_operation_id=$2 WHERE attempt_id=$1',
        [attempt.attemptId, transactionId],
      );
      await this.observe(attempt, {
        outcome: 'captured',
        eventId: `tiptoppay:${source}:${transactionId}`,
        operationId: transactionId,
        amountMinor: attempt.amountMinor,
      });
      return {};
    }
    if (
      source !== 'find' &&
      result.Success === false &&
      transactionId &&
      model?.AcsUrl &&
      model.PaReq
    ) {
      const acs = new URL(model.AcsUrl);
      if (acs.protocol !== 'https:') throw new CommerceError('CONFLICT');
      await this.pool.query(
        `UPDATE commerce_tiptoppay_sessions SET authorized_operation_id=$2,
          next_check_at=clock_timestamp()+interval '60 seconds'
         WHERE attempt_id=$1 AND (authorized_operation_id IS NULL OR authorized_operation_id=$2)`,
        [attempt.attemptId, transactionId],
      );
      const fragment = new URLSearchParams({
        acs: acs.toString(),
        pareq: model.PaReq,
        md: transactionId,
      }).toString();
      return { threeDsUrl: `${this.options!.origin}/v1/integrations/tiptoppay/3ds#${fragment}` };
    }
    const declined =
      transactionId &&
      (model?.Status === 'Declined' ||
        model?.Status === 'Cancelled' ||
        (source !== 'find' && result.Success === false && !model?.AcsUrl));
    if (declined) {
      await this.pool.query(
        'UPDATE commerce_tiptoppay_sessions SET authorized_operation_id=COALESCE(authorized_operation_id,$2) WHERE attempt_id=$1',
        [attempt.attemptId, transactionId],
      );
      await this.observe(attempt, {
        outcome: 'failed',
        eventId: `tiptoppay:${source}-declined:${transactionId}`,
      });
      const message = holderMessage(model?.CardHolderMessage);
      return message ? { message } : {};
    }
    // The request itself was refused (no transaction): nothing was charged.
    if (source !== 'find' && result.Success === false && !model) {
      await this.observe(attempt, {
        outcome: 'failed',
        eventId: `tiptoppay:${source}-refused:${attempt.attemptId}`,
      });
      return {};
    }
    // Anything else (AwaitingAuthentication, an unfamiliar answer): still open, find settles it.
    return {};
  }
  private attemptOf(row: SessionRow): TipTopPayAttempt {
    return {
      attemptId: row.attempt_id,
      orderId: row.order_id,
      organizationId: row.organization_id,
      branchId: row.branch_id,
      customerId: row.customer_id,
      amountMinor: row.intended_minor,
    };
  }
  /** The bank's 3-D Secure answer posted to our TermUrl. Returns the state for the page. */
  async complete3ds(md: unknown, paRes: unknown): Promise<'paid' | 'failed' | 'pending'> {
    if (!this.options) throw new CommerceError('NOT_READY');
    if (typeof md !== 'string' || !/^[1-9][0-9]{0,18}$/.test(md))
      throw new CommerceError('NOT_FOUND');
    if (typeof paRes !== 'string' || !paRes || paRes.length > 60000)
      throw new CommerceError('INVALID');
    const hint = (
      await this.pool.query<{ attempt_id: string }>(
        `SELECT s.attempt_id FROM commerce_tiptoppay_sessions s
         JOIN commerce_payment_attempts a ON a.id=s.attempt_id
         WHERE s.authorized_operation_id=$1 AND a.account_id=$2 AND s.opened_at IS NOT NULL`,
        [md, this.options.accountId],
      )
    ).rows[0];
    if (!hint) throw new CommerceError('NOT_FOUND');
    const row = (await this.session(hint.attempt_id))!;
    const state = () =>
      row.attempt_state === 'succeeded'
        ? ('paid' as const)
        : row.attempt_state === 'failed'
          ? ('failed' as const)
          : ('pending' as const);
    if (row.attempt_state !== 'pending' && row.attempt_state !== 'unknown') return state();
    let result;
    try {
      result = await tipTopPayCall(
        this.options,
        '/payments/cards/post3ds',
        { TransactionId: Number(md), PaRes: paRes },
        `${row.attempt_id}:3ds`,
        this.request,
      );
    } catch {
      return 'pending';
    }
    await this.apply(this.attemptOf(row), result, '3ds');
    const after = (await this.session(hint.attempt_id))!;
    return after.attempt_state === 'succeeded'
      ? 'paid'
      : after.attempt_state === 'failed'
        ? 'failed'
        : 'pending';
  }
  /**
   * Worker tick: settles open attempts of this account.
   * - An attempt with a session (sent to the bank) is looked up with payments/find by its
   *   InvoiceId on a backing-off schedule; «Not found» long after sending means not charged.
   * - An attempt without a session never reached the bank: it fails after TIPTOPPAY_UNSENT_FAIL_MS
   *   (nothing was sent, so nothing can be charged).
   */
  async reconcile(limit = 10) {
    if (!this.options) return { checked: 0, settled: 0, errors: 0 };
    const result = { checked: 0, settled: 0, errors: 0 };
    const due = (
      await this.pool.query<{ attempt_id: string }>(
        `UPDATE commerce_tiptoppay_sessions s SET next_check_at=clock_timestamp()+interval '60 seconds'
         WHERE s.attempt_id IN (
          SELECT s2.attempt_id FROM commerce_tiptoppay_sessions s2
          JOIN commerce_payment_attempts a ON a.id=s2.attempt_id
          WHERE a.account_id=$1 AND a.state IN ('pending','unknown') AND s2.opened_at IS NOT NULL
           AND (s2.next_check_at IS NULL OR s2.next_check_at<=clock_timestamp())
          ORDER BY s2.next_check_at NULLS FIRST LIMIT $2 FOR UPDATE OF s2 SKIP LOCKED)
         RETURNING s.attempt_id`,
        [this.options.accountId, limit],
      )
    ).rows;
    for (const item of due) {
      result.checked++;
      try {
        if (await this.check(item.attempt_id)) result.settled++;
      } catch {
        result.errors++;
      }
    }
    const unsent = (
      await this.pool.query<{
        id: string;
        order_id: string;
        organization_id: string;
        branch_id: string;
      }>(
        `SELECT a.id,a.order_id,o.organization_id,o.branch_id FROM commerce_payment_attempts a
         JOIN commerce_orders o ON o.id=a.order_id
         WHERE a.account_id=$1 AND a.state='pending' AND a.created_at<$2::timestamptz
          AND NOT EXISTS(SELECT 1 FROM commerce_tiptoppay_sessions s WHERE s.attempt_id=a.id)
         ORDER BY a.created_at LIMIT $3`,
        [this.options.accountId, new Date(this.now() - TIPTOPPAY_UNSENT_FAIL_MS), limit],
      )
    ).rows;
    for (const row of unsent) {
      try {
        await this.pool.query(
          `UPDATE commerce_outbox SET acknowledged_at=COALESCE(acknowledged_at,clock_timestamp())
           WHERE order_id=$1 AND event_type='payment.submit_requested' AND payload->>'attemptId'=$2`,
          [row.order_id, row.id],
        );
        await this.observe(
          { attemptId: row.id, organizationId: row.organization_id, branchId: row.branch_id },
          { outcome: 'failed', eventId: `tiptoppay:unsent:${row.id}` },
        );
        result.settled++;
      } catch {
        result.errors++;
      }
    }
    return result;
  }
  /** One payments/find of an open attempt. True when it settled. */
  private async check(attemptId: string): Promise<boolean> {
    const row = await this.session(attemptId);
    if (!row || (row.attempt_state !== 'pending' && row.attempt_state !== 'unknown')) return false;
    const attempt = this.attemptOf(row);
    const schedule = (attempts: number) =>
      this.pool.query(
        `UPDATE commerce_tiptoppay_sessions SET reconcile_attempts=LEAST(reconcile_attempts+1,20),
          last_reconcile_at=clock_timestamp(),next_check_at=clock_timestamp()+$2*interval '1 second'
         WHERE attempt_id=$1`,
        [attemptId, tipTopPayNextCheckSeconds(attempts)],
      );
    let result;
    try {
      result = await tipTopPayCall(
        this.options!,
        '/payments/find',
        { InvoiceId: attemptId },
        `${attemptId}:find:${row.reconcile_attempts}`,
        this.request,
      );
    } catch {
      await schedule(row.reconcile_attempts);
      return false;
    }
    if (result.Success === false && !result.Model) {
      const sentAt = (row.opened_at ?? row.created_at).getTime();
      if (
        /not\s*found/i.test(result.Message ?? '') &&
        this.now() - sentAt >= TIPTOPPAY_NOT_FOUND_FAIL_MS
      ) {
        await this.observe(attempt, {
          outcome: 'failed',
          eventId: `tiptoppay:find-missing:${attemptId}`,
        });
        return true;
      }
      await schedule(row.reconcile_attempts);
      return false;
    }
    await this.apply(attempt, result, 'find');
    const after = await this.session(attemptId);
    if (after && (after.attempt_state === 'pending' || after.attempt_state === 'unknown')) {
      // Still open after many lookups: a manager sees it as unknown (attention), never failed.
      if (row.reconcile_attempts >= 12 && row.attempt_state === 'pending')
        await this.observe(attempt, {
          outcome: 'unknown',
          eventId: `tiptoppay:find-open:${attemptId}`,
        });
      await schedule(row.reconcile_attempts);
      return false;
    }
    return true;
  }
  /**
   * Worker tick: sends each pending refund of this account to payments/refund once. A bank
   * answer settles it; no answer marks it unknown for a manager (never a second refund).
   */
  async refunds(limit = 10) {
    if (!this.options) return { sent: 0, errors: 0 };
    const worker = randomUUID(),
      token = randomUUID();
    const events = (
      await this.pool.query<{ id: string; refund_id: string }>(
        `WITH selected AS (
          SELECT e.id FROM commerce_outbox e JOIN commerce_orders o ON o.id=e.order_id
          JOIN commerce_refunds r ON r.id=(e.payload->>'refundId')::uuid AND r.order_id=o.id
          JOIN commerce_provider_accounts p ON p.id=r.account_id
          WHERE e.event_type='refund.submit_requested' AND e.acknowledged_at IS NULL
           AND (e.lease_until IS NULL OR e.lease_until<clock_timestamp())
           AND p.id=$1 AND p.provider='tiptoppay' AND p.kind='payment' AND r.state='pending'
          ORDER BY e.sequence LIMIT $2 FOR UPDATE OF e SKIP LOCKED)
         UPDATE commerce_outbox e SET lease_worker=$3,lease_token=$4,
          lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1
         FROM selected s WHERE e.id=s.id RETURNING e.id,e.payload->>'refundId' refund_id`,
        [this.options.accountId, limit, worker, token],
      )
    ).rows;
    const result = { sent: 0, errors: 0 };
    for (const event of events) {
      try {
        await this.refund(event.refund_id);
        await this.pool.query(
          `UPDATE commerce_outbox SET acknowledged_at=COALESCE(acknowledged_at,clock_timestamp())
           WHERE id=$1 AND lease_worker=$2 AND lease_token=$3`,
          [event.id, worker, token],
        );
        result.sent++;
      } catch {
        result.errors++;
      }
    }
    return result;
  }
  private async refund(refundId: string) {
    const row = (
      await this.pool.query<{
        id: string;
        amount_minor: string;
        state: string;
        operation_id: string;
        organization_id: string;
        branch_id: string;
      }>(
        `SELECT r.id,r.amount_minor::text,r.state,c.operation_id,o.organization_id,o.branch_id
         FROM commerce_refunds r JOIN commerce_captures c ON c.id=r.capture_id AND c.account_id=r.account_id
         JOIN commerce_orders o ON o.id=r.order_id WHERE r.id=$1 AND r.account_id=$2`,
        [refundId, this.options!.accountId],
      )
    ).rows[0];
    if (!row || row.state !== 'pending') return;
    const provider = {
      organizationId: row.organization_id,
      branchId: row.branch_id,
      accountId: this.options!.accountId,
    };
    const at = () => new Date(this.now()).toISOString();
    let result;
    try {
      result = await tipTopPayCall(
        this.options!,
        '/payments/refund',
        { TransactionId: Number(row.operation_id), Amount: Number(row.amount_minor) / 100 },
        refundId,
        this.request,
      );
    } catch {
      // The bank may have refunded: a manager checks the cabinet; we never send it again.
      await this.repo.observeRefund(provider, {
        eventId: `tiptoppay:refund-lost:${refundId}`,
        refundId,
        outcome: 'unknown',
        occurredAt: at(),
      });
      return;
    }
    const refundOperation = operationId(result.Model?.TransactionId);
    if (result.Success === true && refundOperation) {
      await this.repo.observeRefund(provider, {
        eventId: `tiptoppay:refund:${refundOperation}`,
        refundId,
        outcome: 'succeeded',
        operationId: refundOperation,
        amountMinor: row.amount_minor,
        occurredAt: at(),
      });
      return;
    }
    await this.repo.observeRefund(provider, {
      eventId: `tiptoppay:refund-${result.Success === false ? 'refused' : 'unclear'}:${refundId}`,
      refundId,
      outcome: result.Success === false ? 'failed' : 'unknown',
      occurredAt: at(),
    });
  }
}
