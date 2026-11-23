import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { transaction, type DatabasePool } from '@pickchick/database';
import { z } from 'zod';
import { CommerceError, parse, UUIDSchema } from './model.js';
import { verifyTipTopPayForm, parseTipTopPayPayment, TipTopPayError } from './tiptoppay.js';

/**
 * TipTopPay TEST checkout of the mobile app (owner 18.11.2026: card, Apple Pay and Google Pay in
 * TestFlight on the TEST terminal of site 8194419, natively in the app). A TEST payment is a
 * sandbox: it charges the server quote of the customer's cart but never creates a commercial
 * order, capture, ledger effect, fiscal document, combo stamp or kitchen job. Its result lives
 * only in commerce_tiptoppay_test_payments (migration 040) and the app shows it as a test.
 *
 * Native flow: the app encrypts the card with the TipTopPay public key (card cryptogram) or gets
 * an Apple Pay / Google Pay token, and sends only that opaque packet here. The server charges it
 * with the API secret (payments/cards/charge). A card that needs 3-D Secure is confirmed in the
 * in-app browser on our page, which posts to the bank and returns to /test-3ds-return; the server
 * then calls payments/cards/post3ds. The signed Check/Pay/Fail notifications of the bank are the
 * second, independent source of the result. Card numbers, CVV and the API secret never reach our
 * database or logs.
 */
export const TipTopPayMethodSchema = z.enum(['card', 'apple_pay', 'google_pay']);
export type TipTopPayMethod = z.infer<typeof TipTopPayMethodSchema>;
export interface TipTopPayTestOptions {
  organizationId: string;
  branchId: string;
  maxMinor: string;
  publicId: string;
  apiSecret: string;
  origin: string;
  methods: TipTopPayMethod[];
  routingVerified: boolean;
  /** Google Pay gateway name from the TipTopPay manager; read from the terminal if absent. */
  googlePayGateway?: string;
}
export function tipTopPayTestOptions(env: NodeJS.ProcessEnv): TipTopPayTestOptions | null {
  if (env.TIPTOPPAY_TEST_CHECKOUT_ENABLED !== 'true') return null;
  const publicId = env.TIPTOPPAY_PUBLIC_ID ?? '',
    apiSecret = env.TIPTOPPAY_API_SECRET ?? '';
  if (
    env.TIPTOPPAY_MODE !== 'test' ||
    env.TIPTOPPAY_TEST_WEBHOOKS_ENABLED !== 'true' ||
    !/^(pk_[a-zA-Z0-9]+|test_api_[a-zA-Z0-9]+)$/.test(publicId) ||
    apiSecret.length < 16
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
    .parse((env.TIPTOPPAY_TEST_CHECKOUT_METHODS ?? 'card').split(',').map((m) => m.trim()));
  if (new Set(methods).size !== methods.length) throw new CommerceError('INVALID');
  // Native Apple Pay needs the Payment Processing Certificate (TipTopPay CSR) uploaded to Apple
  // and TipTopPay for this terminal; until then the app does not offer Apple Pay.
  if (methods.includes('apple_pay') && env.TIPTOPPAY_APPLE_PAY_CERTIFICATE_READY !== 'true')
    throw new CommerceError('NOT_READY');
  return {
    organizationId: parse(UUIDSchema, env.CUSTOMER_KASPI_ORGANIZATION_ID),
    branchId: parse(UUIDSchema, env.CUSTOMER_KASPI_BRANCH_ID),
    maxMinor: z
      .string()
      .regex(/^[1-9][0-9]{0,8}$/)
      .parse(env.TIPTOPPAY_TEST_MAX_MINOR ?? env.CUSTOMER_KASPI_PILOT_MAX_MINOR ?? '10000'),
    publicId,
    apiSecret,
    origin: origin.origin,
    methods,
    // Opening the widget on one method needs a setting by the TipTopPay manager. Without it the
    // widget shows its general form (card plus the wallets switched on in the cabinet).
    routingVerified: env.TIPTOPPAY_METHOD_ROUTING_VERIFIED === 'true',
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
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
type TestRow = {
  id: string;
  quote_id: string;
  customer_id: string;
  public_id: string;
  amount_minor: string;
  method: TipTopPayMethod;
  state: 'pending' | 'paid' | 'failed';
  expires_at: Date;
  opened_at: Date | null;
  operation_id: string | null;
  paid_operation_id: string | null;
  reason_code: string | null;
};
const view = (row: TestRow, now: number) => ({
  id: row.id,
  quoteId: row.quote_id,
  amountMinor: row.amount_minor,
  method: row.method,
  state:
    row.state === 'pending' && row.expires_at.getTime() <= now ? ('expired' as const) : row.state,
  expiresAt: row.expires_at.toISOString(),
});

export const TIPTOPPAY_API = 'https://api.tiptoppay.kz';
export type ChargeModel = {
  TransactionId?: number | string;
  ReasonCode?: number | null;
  Status?: string;
  CardHolderMessage?: string | null;
  AcsUrl?: string | null;
  PaReq?: string | null;
  TestMode?: boolean;
  InvoiceId?: string | null;
  AccountId?: string | null;
  Amount?: number | string | null;
  Currency?: string | null;
};
export type TipTopPayFetch = typeof fetch;

/** One bounded JSON call to the TipTopPay API with Basic auth; the secret never leaves here. */
export async function tipTopPayCall(
  config: { publicId: string; apiSecret: string },
  path:
    '/payments/cards/charge' | '/payments/cards/post3ds' | '/payments/find' | '/payments/refund',
  body: Record<string, unknown>,
  requestId: string,
  request: TipTopPayFetch,
): Promise<{ Success?: boolean; Message?: string | null; Model?: ChargeModel | null }> {
  const response = await request(TIPTOPPAY_API + path, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(25000),
    headers: {
      'Content-Type': 'application/json',
      // Idempotent within the provider's 1 hour window: a retried call returns the first result.
      'X-Request-ID': requestId,
      Authorization: `Basic ${Buffer.from(`${config.publicId}:${config.apiSecret}`).toString('base64')}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok || text.length > 65536) throw new CommerceError('NOT_READY');
  return JSON.parse(text) as { Success?: boolean; Message?: string | null; Model?: ChargeModel };
}
export const operationId = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)
      ? value
      : null;
export const holderMessage = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;

export type TipTopPaySetup = {
  publicId: string;
  publicKey: { pem: string; version: number };
  googlePay: { gateway: string; gatewayMerchantId: string } | null;
  environment: 'test';
};
/** gPayGatewayName of the terminal's Google Pay method, wherever the configuration nests it. */
export function findGooglePayGateway(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      /^gpaygatewayname$/i.test(key) &&
      typeof item === 'string' &&
      /^[a-z0-9_-]{2,60}$/i.test(item)
    )
      return item;
    const nested = findGooglePayGateway(item, depth + 1);
    if (nested) return nested;
  }
  return null;
}
export type TestChargeResult = ReturnType<typeof view> & {
  /** Present while the card waits for 3-D Secure: open it in the in-app browser. */
  threeDsUrl?: string;
  /** The bank's words for a decline, shown to the customer as is. */
  message?: string;
};

const CryptogramSchema = z.string().min(16).max(16384);
const ChargeInput = z.strictObject({
  quoteId: UUIDSchema,
  method: TipTopPayMethodSchema,
  cryptogram: CryptogramSchema,
});

/** No CommerceRepository or commercial financial effect is reachable from this sandbox. */
export class TipTopPayTestCheckout {
  constructor(
    private readonly pool: DatabasePool,
    private readonly options: TipTopPayTestOptions | null,
    private readonly now: () => number = Date.now,
    private readonly request: TipTopPayFetch = (...args) => fetch(...args),
  ) {}
  /** Methods the app may offer, or null when the TEST checkout is off. */
  get methods(): TipTopPayMethod[] | null {
    return this.options ? [...this.options.methods] : null;
  }
  /** What the app needs to build a cryptogram or a wallet request (never the API secret). */
  get publicConfig() {
    return this.options ? { publicId: this.options.publicId } : null;
  }
  private setupCache: { at: number; value: TipTopPaySetup } | null = null;
  /**
   * Public key for the card cryptogram and the Google Pay gateway of this terminal, read from
   * TipTopPay (payments/publickey, merchant/configuration) and cached for 10 minutes.
   */
  async setup(): Promise<TipTopPaySetup> {
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
    const value: TipTopPaySetup = {
      publicId: this.options.publicId,
      publicKey: { pem: key.Pem, version: key.Version as number },
      googlePay: gateway ? { gateway, gatewayMerchantId: this.options.publicId } : null,
      environment: 'test',
    };
    this.setupCache = { at: this.now(), value };
    return value;
  }
  /**
   * Charges the quote once. A second call for the same quote never charges again: it reports
   * the stored state (and the 3-D Secure link while it waits).
   */
  async charge(customerId: string, input: unknown, ip: string): Promise<TestChargeResult> {
    if (!this.options) throw new CommerceError('NOT_READY');
    parse(UUIDSchema, customerId);
    const request = parse(ChargeInput, input);
    if (!this.options.methods.includes(request.method)) throw new CommerceError('NOT_READY');
    const address = isIP(ip) ? ip.replace(/^::ffff:/, '') : '127.0.0.1';
    const reserved = await transaction(this.pool, async (client) => {
      // Quotes are immutable; serialize TEST issuance without UPDATE on finance tables.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `tiptoppay-test:${request.quoteId}`,
      ]);
      const quote = (
        await client.query<{
          organization_id: string;
          branch_id: string;
          total_minor: string;
          snapshot: unknown;
          expires_at: Date;
        }>(
          `SELECT organization_id,branch_id,total_minor::text,snapshot,expires_at FROM commerce_quotes
           WHERE id=$1 AND customer_id=$2 AND principal_id=$2 AND snapshot->>'channel'='mobile'
            AND organization_id=$3 AND branch_id=$4`,
          [request.quoteId, customerId, this.options!.organizationId, this.options!.branchId],
        )
      ).rows[0];
      if (!quote) throw new CommerceError('NOT_FOUND');
      const existing = (
        await client.query<TestRow>(
          'SELECT *,amount_minor::text FROM commerce_tiptoppay_test_payments WHERE quote_id=$1 FOR UPDATE',
          [request.quoteId],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.customer_id !== customerId ||
          existing.method !== request.method ||
          existing.public_id !== this.options!.publicId
        )
          throw new CommerceError('CONFLICT');
        return { row: existing, fresh: false };
      }
      if (BigInt(quote.total_minor) <= 0n) throw new CommerceError('INVALID');
      if (BigInt(quote.total_minor) > BigInt(this.options!.maxMinor))
        throw new CommerceError('NOT_READY');
      if (quote.expires_at.getTime() <= this.now()) throw new CommerceError('EXPIRED');
      // opened_at marks "sent to the bank": the row is charged at most once.
      const row = (
        await client.query<TestRow>(
          `INSERT INTO commerce_tiptoppay_test_payments(id,quote_id,customer_id,organization_id,branch_id,public_id,amount_minor,method,snapshot,token_hash,expires_at,opened_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+interval '15 minutes',clock_timestamp()) RETURNING *,amount_minor::text`,
          [
            randomUUID(),
            request.quoteId,
            customerId,
            quote.organization_id,
            quote.branch_id,
            this.options!.publicId,
            quote.total_minor,
            request.method,
            quote.snapshot,
            hash(randomBytes(32).toString('hex')),
          ],
        )
      ).rows[0]!;
      return { row, fresh: true };
    });
    if (!reserved.fresh) return view(reserved.row, this.now());
    const row = reserved.row;
    let result;
    try {
      result = await tipTopPayCall(
        this.options,
        '/payments/cards/charge',
        {
          Amount: Number(row.amount_minor) / 100,
          Currency: 'KZT',
          IpAddress: address,
          CardCryptogramPacket: request.cryptogram,
          InvoiceId: row.id,
          AccountId: customerId,
          Description: 'PickChick: тестовая оплата',
          CultureName: 'ru-RU',
        },
        row.id,
        this.request,
      );
    } catch {
      // No answer is not a decline: the bank may still have charged. Pay/Fail settle it.
      return view(row, this.now());
    }
    return this.apply(row, result);
  }
  /** Stores the bank's answer to charge/post3ds and builds the app's view of it. */
  private async apply(
    row: TestRow,
    result: Awaited<ReturnType<typeof tipTopPayCall>>,
  ): Promise<TestChargeResult> {
    const model = result.Model ?? null;
    const transactionId = operationId(model?.TransactionId);
    if (model && model.InvoiceId && model.InvoiceId !== row.id) throw new CommerceError('CONFLICT');
    // A TEST terminal answers TestMode=true; anything else must never be treated as a sandbox.
    if (model && model.TestMode === false) throw new CommerceError('CONFLICT');
    if (result.Success === true && transactionId && model?.Status === 'Completed') {
      await this.pool.query(
        `UPDATE commerce_tiptoppay_test_payments SET state='paid',operation_id=COALESCE(operation_id,$2),
          paid_operation_id=$2,updated_at=clock_timestamp() WHERE id=$1 AND state<>'paid'`,
        [row.id, transactionId],
      );
      return { ...view({ ...row, state: 'paid' }, this.now()) };
    }
    if (result.Success === false && transactionId && model?.AcsUrl && model.PaReq) {
      const acs = new URL(model.AcsUrl);
      if (acs.protocol !== 'https:') throw new CommerceError('CONFLICT');
      await this.pool.query(
        `UPDATE commerce_tiptoppay_test_payments SET operation_id=$2,updated_at=clock_timestamp()
         WHERE id=$1 AND (operation_id IS NULL OR operation_id=$2)`,
        [row.id, transactionId],
      );
      const fragment = new URLSearchParams({
        acs: acs.toString(),
        pareq: model.PaReq,
        md: transactionId,
      }).toString();
      return {
        ...view(row, this.now()),
        threeDsUrl: `${this.options!.origin}/v1/integrations/tiptoppay/test-3ds#${fragment}`,
      };
    }
    if (result.Success === false && transactionId) {
      const reason = /^[0-9]{1,4}$/.test(String(model?.ReasonCode ?? ''))
        ? String(model!.ReasonCode)
        : null;
      await this.pool.query(
        `UPDATE commerce_tiptoppay_test_payments SET state='failed',operation_id=COALESCE(operation_id,$2),
          reason_code=$3,updated_at=clock_timestamp() WHERE id=$1 AND state='pending'`,
        [row.id, transactionId, reason],
      );
      const message = holderMessage(model?.CardHolderMessage);
      return {
        ...view({ ...row, state: 'failed' }, this.now()),
        ...(message ? { message } : {}),
      };
    }
    // The request itself was refused (no transaction): nothing was charged.
    if (result.Success === false && !model) {
      await this.pool.query(
        `UPDATE commerce_tiptoppay_test_payments SET state='failed',reason_code='request',
          updated_at=clock_timestamp() WHERE id=$1 AND state='pending' AND operation_id IS NULL`,
        [row.id],
      );
      return { ...view({ ...row, state: 'failed' }, this.now()) };
    }
    return view(row, this.now());
  }
  /** The bank's 3-D Secure answer posted to our TermUrl. Returns the final state for the page. */
  async complete3ds(md: unknown, paRes: unknown): Promise<'paid' | 'failed' | 'pending'> {
    if (!this.options) throw new CommerceError('NOT_READY');
    if (typeof md !== 'string' || !/^[1-9][0-9]{0,18}$/.test(md))
      throw new CommerceError('NOT_FOUND');
    if (typeof paRes !== 'string' || !paRes || paRes.length > 60000)
      throw new CommerceError('INVALID');
    const row = (
      await this.pool.query<TestRow>(
        `SELECT *,amount_minor::text FROM commerce_tiptoppay_test_payments
         WHERE operation_id=$1 AND public_id=$2 AND opened_at IS NOT NULL`,
        [md, this.options.publicId],
      )
    ).rows[0];
    if (!row) throw new CommerceError('NOT_FOUND');
    if (row.state !== 'pending') return row.state;
    let result;
    try {
      result = await tipTopPayCall(
        this.options,
        '/payments/cards/post3ds',
        { TransactionId: Number(md), PaRes: paRes },
        `${row.id}:3ds`,
        this.request,
      );
    } catch {
      return 'pending';
    }
    const outcome = await this.apply(row, result);
    return outcome.state === 'paid' || outcome.state === 'failed' ? outcome.state : 'pending';
  }
  async read(customerId: string, id: string) {
    parse(UUIDSchema, customerId);
    parse(UUIDSchema, id);
    const row = (
      await this.pool.query<TestRow>(
        'SELECT *,amount_minor::text FROM commerce_tiptoppay_test_payments WHERE id=$1 AND customer_id=$2',
        [id, customerId],
      )
    ).rows[0];
    if (!row) throw new CommerceError('NOT_FOUND');
    return view(row, this.now());
  }
  /** Signed bank notifications, the independent source of the result. */
  async receive(event: string, raw: Buffer, signature: string | undefined) {
    if (!this.options) throw new TipTopPayError('DISABLED');
    if (event !== 'check' && event !== 'pay' && event !== 'fail')
      throw new TipTopPayError('INVALID');
    const fields = verifyTipTopPayForm(raw, signature, this.options.apiSecret);
    // Only TEST operations of the TEST terminal reach the sandbox; LIVE ones are refused here.
    if (fields.TestMode !== '1') throw new TipTopPayError('MODE');
    const payment = parseTipTopPayPayment({ ...fields, TestMode: '0' }, event);
    return transaction(this.pool, async (client) => {
      const row = (
        await client.query<TestRow>(
          'SELECT *,amount_minor::text FROM commerce_tiptoppay_test_payments WHERE id=$1 AND public_id=$2 FOR UPDATE',
          [payment.attemptId, this.options!.publicId],
        )
      ).rows[0];
      if (
        !row ||
        row.customer_id !== payment.customerId ||
        row.amount_minor !== payment.amountMinor
      )
        throw new TipTopPayError('BINDING');
      if (event === 'check') {
        if (
          row.state !== 'pending' ||
          !row.opened_at ||
          row.expires_at.getTime() <= this.now() ||
          (row.operation_id && row.operation_id !== payment.operationId)
        )
          return { code: 13 };
        await client.query(
          'UPDATE commerce_tiptoppay_test_payments SET operation_id=$2,updated_at=clock_timestamp() WHERE id=$1',
          [row.id, payment.operationId],
        );
      } else if (event === 'pay') {
        // TEST success proves the exact operation this session sent (charge, 3DS or Check).
        if (!row.operation_id || row.operation_id !== payment.operationId)
          throw new TipTopPayError('BINDING');
        if (row.paid_operation_id && row.paid_operation_id !== payment.operationId)
          throw new TipTopPayError('BINDING');
        await client.query(
          "UPDATE commerce_tiptoppay_test_payments SET state='paid',paid_operation_id=$2,updated_at=clock_timestamp() WHERE id=$1 AND state<>'paid'",
          [row.id, payment.operationId],
        );
      } else if (row.state !== 'paid') {
        // A decline of another TransactionId may precede a successful retry.
        if (row.operation_id && row.operation_id !== payment.operationId) return { code: 0 };
        await client.query(
          "UPDATE commerce_tiptoppay_test_payments SET state='failed',operation_id=COALESCE(operation_id,$3),reason_code=$2,updated_at=clock_timestamp() WHERE id=$1",
          [row.id, fields.ReasonCode, payment.operationId],
        );
      }
      return { code: 0 };
    });
  }
}

/**
 * 3-D Secure page, opened by the app in the in-app browser. The bank's form fields travel in the
 * fragment (never sent to our server or a referrer); the page posts them to the bank's ACS with
 * our TermUrl, exactly as the bank requires.
 */
export const tipTopPay3dsPage = (
  returnPath: string,
) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>PickChick: подтверждение оплаты</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1437;color:#fff;font:17px/1.5 -apple-system,system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box}</style></head><body><p id="s">Открываем подтверждение банка…</p><form id="f" method="post"><input type="hidden" name="PaReq"><input type="hidden" name="MD"><input type="hidden" name="TermUrl"></form><script>
(function(){var p=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'',location.pathname);var acs=p.get('acs')||'',f=document.getElementById('f');
try{var u=new URL(acs);if(u.protocol!=='https:'||!p.get('pareq')||!/^[1-9][0-9]{0,18}$/.test(p.get('md')||''))throw 0;
f.action=u.toString();f.PaReq.value=p.get('pareq');f.MD.value=p.get('md');f.TermUrl.value=location.origin+'${returnPath}';f.submit();}
catch(e){document.getElementById('s').textContent='Ссылка устарела. Вернитесь в приложение.';}})();
</script></body></html>`;
export const tipTopPay3dsHtml = tipTopPay3dsPage('/v1/integrations/tiptoppay/test-3ds-return');

/** Final page after 3-D Secure: hands the customer back to the app. */
export function tipTopPay3dsResultHtml(state: 'paid' | 'failed' | 'pending') {
  const text = {
    paid: 'Оплата подтверждена. Возвращаемся в PickChick…',
    failed: 'Банк не подтвердил оплату. Возвращаемся в PickChick…',
    pending: 'Проверяем оплату. Возвращаемся в PickChick…',
  }[state];
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>PickChick</title><style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0b1437;color:#fff;font:17px/1.5 -apple-system,system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box}a{margin-top:24px;color:#fff;background:#ff6b18;border-radius:14px;padding:14px 24px;text-decoration:none;font-weight:600}</style></head><body><p>${text}</p><a href="pickchick://tiptoppay-return?state=${state}">Вернуться в PickChick</a><script>setTimeout(function(){location.href='pickchick://tiptoppay-return?state=${state}';},300);</script></body></html>`;
}
