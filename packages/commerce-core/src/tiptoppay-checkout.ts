import { createHash, randomBytes } from 'node:crypto';
import { transaction, type DatabasePool } from '@pickchick/database';
import { z } from 'zod';
import { CommerceError, parse, UUIDSchema } from './model.js';

export const CheckoutPaymentMethodSchema = z.enum(['kaspi', 'card', 'apple_pay', 'google_pay']);
export type CheckoutPaymentMethod = z.infer<typeof CheckoutPaymentMethodSchema>;
export interface TipTopPayCheckoutOptions {
  accountId: string;
  publicId: string;
  origin: string;
  approvalReference: string;
  methods: Exclude<CheckoutPaymentMethod, 'kaspi'>[];
}
export function tipTopPayCheckoutOptions(env: NodeJS.ProcessEnv): TipTopPayCheckoutOptions | null {
  if (env.TIPTOPPAY_CHECKOUT_ENABLED !== 'true') return null;
  // The terminal and its merchant must be independently verified before any bank authorization.
  if (
    env.TIPTOPPAY_MODE !== 'live' ||
    env.TIPTOPPAY_LIVE_VERIFIED !== 'true' ||
    env.TIPTOPPAY_WEBHOOKS_ENABLED !== 'true' ||
    env.TIPTOPPAY_METHOD_ROUTING_VERIFIED !== 'true' ||
    env.TIPTOPPAY_RECONCILE_ENABLED !== 'true'
  )
    throw new CommerceError('NOT_READY');
  const origin = new URL(env.TIPTOPPAY_CHECKOUT_ORIGIN ?? '');
  const methods = z
    .array(z.enum(['card', 'apple_pay', 'google_pay']))
    .min(1)
    .max(3)
    .parse(env.TIPTOPPAY_CHECKOUT_METHODS?.split(','));
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !/^pk_[a-zA-Z0-9]+$/.test(env.TIPTOPPAY_PUBLIC_ID ?? '') ||
    new Set(methods).size !== methods.length ||
    (methods.includes('apple_pay') && env.TIPTOPPAY_APPLE_PAY_DOMAIN_VERIFIED !== 'true')
  )
    throw new CommerceError('INVALID');
  return {
    accountId: parse(UUIDSchema, env.TIPTOPPAY_ACCOUNT_ID),
    publicId: env.TIPTOPPAY_PUBLIC_ID!,
    origin: origin.origin,
    methods,
    approvalReference: z
      .string()
      .trim()
      .min(3)
      .max(250)
      .parse(env.TIPTOPPAY_FISCAL_DEFERRAL_REFERENCE),
  };
}
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const widgetMethod = { card: 'Card', apple_pay: 'ApplePay', google_pay: 'GooglePay' } as const;

/** Hosted capabilities expose only server-owned payment parameters, never the API secret. */
export class TipTopPayHostedSessions {
  constructor(
    private readonly pool: DatabasePool,
    private readonly options: TipTopPayCheckoutOptions | null,
  ) {}
  async issue(customerId: string, orderId: string) {
    if (!this.options) throw new CommerceError('NOT_READY');
    const token = randomBytes(32).toString('hex');
    return transaction(this.pool, async (client) => {
      const order = (
        await client.query<{ id: string }>(
          `SELECT o.id FROM commerce_orders o JOIN branches b ON b.id=o.branch_id AND b.organization_id=o.organization_id
         JOIN commerce_provider_accounts p ON p.id=$3 AND p.branch_id=o.branch_id
          AND p.organization_id=o.organization_id AND p.legal_entity_id=b.legal_entity_id
          AND p.provider='tiptoppay' AND p.kind='payment' AND p.enabled AND p.external_reference=$4
         WHERE o.id=$1 AND o.customer_id=$2 AND o.principal_id=$2 AND o.snapshot->>'channel'='mobile'
          AND o.fiscal_policy='deferred_pilot' AND o.fiscal_deferral_reference=$5
          AND o.state='awaiting_payment' AND NOT o.attention_required
         FOR UPDATE OF o`,
          [
            orderId,
            customerId,
            this.options!.accountId,
            this.options!.publicId,
            this.options!.approvalReference,
          ],
        )
      ).rows[0];
      if (!order) throw new CommerceError('NOT_READY');
      const attempt = (
        await client.query<{ id: string; expires_at: Date | null; opened_at: Date | null }>(
          `SELECT a.id,s.expires_at,s.opened_at FROM commerce_payment_attempts a
         JOIN commerce_checkout_payment_methods m ON m.order_id=a.order_id AND m.method=ANY($3::text[])
         LEFT JOIN commerce_tiptoppay_sessions s ON s.attempt_id=a.id
         WHERE a.order_id=$1 AND a.account_id=$2 AND a.state='pending'
          AND NOT EXISTS(SELECT 1 FROM commerce_captures c WHERE c.order_id=a.order_id)`,
          [orderId, this.options!.accountId, this.options!.methods],
        )
      ).rows[0];
      if (
        !attempt ||
        attempt.opened_at ||
        (attempt.expires_at && attempt.expires_at.getTime() <= Date.now())
      )
        throw new CommerceError('NOT_READY');
      const saved = (
        await client.query<{ expires_at: Date }>(
          `INSERT INTO commerce_tiptoppay_sessions(attempt_id,order_id,token_hash,expires_at)
         VALUES($1,$2,$3,clock_timestamp()+interval '10 minutes')
         ON CONFLICT(attempt_id) DO UPDATE SET token_hash=EXCLUDED.token_hash
         RETURNING expires_at`,
          [attempt.id, orderId, hashToken(token)],
        )
      ).rows[0]!;
      return {
        orderId,
        attemptId: attempt.id,
        checkoutUrl: `${this.options!.origin}/v1/integrations/tiptoppay/checkout#${token}`,
        expiresAt: saved.expires_at.toISOString(),
      };
    });
  }
  async status(token: unknown) {
    if (!this.options || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
      throw new CommerceError('NOT_FOUND');
    const row = (
      await this.pool.query<{ captured: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM commerce_captures c WHERE c.order_id=s.order_id) captured
      FROM commerce_tiptoppay_sessions s WHERE token_hash=$1 AND expires_at>clock_timestamp()-interval '30 minutes'`,
        [hashToken(token)],
      )
    ).rows[0];
    if (!row) throw new CommerceError('NOT_FOUND');
    return { status: row.captured ? 'observed' : 'checking' };
  }
  async open(token: unknown) {
    if (!this.options || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
      throw new CommerceError('NOT_FOUND');
    return transaction(this.pool, async (client) => {
      const row = (
        await client.query<{
          attempt_id: string;
          customer_id: string;
          total_minor: string;
          method: 'card' | 'apple_pay' | 'google_pay';
        }>(
          `SELECT s.attempt_id,o.customer_id,o.total_minor::text,m.method
         FROM commerce_tiptoppay_sessions s JOIN commerce_orders o ON o.id=s.order_id
         JOIN commerce_payment_attempts a ON a.id=s.attempt_id
         JOIN commerce_checkout_payment_methods m ON m.order_id=o.id
         JOIN commerce_provider_accounts p ON p.id=a.account_id
         JOIN branches b ON b.id=o.branch_id AND b.organization_id=o.organization_id
         WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp() AND s.opened_at IS NULL
          AND a.account_id=$2 AND a.state='pending' AND p.enabled
          AND p.provider='tiptoppay' AND p.kind='payment' AND p.external_reference=$3
          AND p.organization_id=o.organization_id AND p.branch_id=o.branch_id AND p.legal_entity_id=b.legal_entity_id
          AND o.snapshot->>'legalEntityId'=p.legal_entity_id::text
          AND o.fiscal_policy='deferred_pilot' AND o.fiscal_deferral_reference=$4
          AND o.state='awaiting_payment' AND NOT o.attention_required
          AND NOT EXISTS(SELECT 1 FROM commerce_captures c WHERE c.order_id=o.id)
         FOR UPDATE OF s,o`,
          [
            hashToken(token),
            this.options!.accountId,
            this.options!.publicId,
            this.options!.approvalReference,
          ],
        )
      ).rows[0];
      if (!row || !this.options!.methods.includes(row.method)) throw new CommerceError('NOT_FOUND');
      await client.query(
        'UPDATE commerce_tiptoppay_sessions SET opened_at=clock_timestamp() WHERE attempt_id=$1',
        [row.attempt_id],
      );
      return {
        publicTerminalId: this.options!.publicId,
        amount: Number(row.total_minor) / 100,
        currency: 'KZT',
        paymentSchema: 'Single',
        culture: 'ru-RU',
        description: 'PickChick',
        externalId: row.attempt_id,
        userInfo: { accountId: row.customer_id },
        tokenize: false,
        retryPayment: false,
        restrictedPaymentMethods: ['Card', 'ApplePay', 'GooglePay', 'InstallmentKz'].filter(
          (m) => m !== widgetMethod[row.method],
        ),
        paymentMethodSequence: [widgetMethod[row.method]],
      };
    });
  }
}

export const tipTopPayHostedHtml = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>PickChick - оплата</title><style>body{margin:0;min-height:100vh;box-sizing:border-box;padding:48px 24px;background:#0b1437;color:#fff;font-family:system-ui,sans-serif;max-width:480px;margin:auto}h1{font-size:26px}p{line-height:1.5;color:#d4d8e5}button{width:100%;min-height:48px;border:0;border-radius:12px;background:#ff6b18;color:#fff;font:600 18px system-ui,sans-serif;margin-top:24px}button:disabled{opacity:.6}</style><body><h1>Оплата PickChick</h1><p id="status">Продолжите оплату в защищённой форме.</p><button id="pay">Оплатить</button><script src="https://widget.tiptoppay.kz/bundles/widget.js"></script><script>
const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);const button=document.getElementById('pay');
button.onclick=async()=>{button.disabled=true;try{const r=await fetch('/v1/integrations/tiptoppay/checkout-session',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token})});if(!r.ok)throw new Error();const params=await r.json();await new tiptop.Widget().start(params);for(let i=0;i<10;i++){const observation=await fetch('/v1/integrations/tiptoppay/checkout-status',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token})});if(observation.ok&&(await observation.json()).status==='observed')break;await new Promise(r=>setTimeout(r,2000));}document.getElementById('status').textContent='Вернитесь в приложение. Результат оплаты проверяется сервером.';}catch{document.getElementById('status').textContent='Вернитесь в приложение для проверки заказа.';}};
</script></body></html>`;

/** The old find endpoint returns the latest payment, never a refund/payout. No charge API exists here. */
export async function findTipTopPayPayment(
  config: { publicId: string; apiSecret: string },
  attemptId: string,
  request: typeof fetch = fetch,
): Promise<Record<string, string> | null> {
  parse(UUIDSchema, attemptId);
  const response = await request('https://api.tiptoppay.kz/payments/find', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${config.publicId}:${config.apiSecret}`).toString('base64')}`,
    },
    body: JSON.stringify({ InvoiceId: attemptId }),
  });
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 65536)
    throw new CommerceError('NOT_READY');
  const text = await response.text();
  if (text.length > 65536) throw new CommerceError('NOT_READY');
  const result = JSON.parse(text) as { Success?: boolean; Model?: Record<string, unknown> };
  const model = result.Model;
  if (!model) return null; // A missing bank observation never proves a failed payment.
  if (
    result.Success !== true ||
    model.PublicId !== config.publicId ||
    model.InvoiceId !== attemptId ||
    model.TestMode !== false ||
    model.Type !== 0 ||
    model.Status !== 'Completed' ||
    model.Currency !== 'KZT' ||
    (typeof model.TransactionId === 'number' && !Number.isSafeInteger(model.TransactionId))
  )
    throw new CommerceError('NOT_READY');
  const date = String(model.CreatedDateIso ?? '')
    .replace(/\.\d+(?:Z)?$/, '')
    .replace(/Z$/, '')
    .replace('T', ' ');
  return {
    TransactionId: String(model.TransactionId),
    InvoiceId: attemptId,
    AccountId: String(model.AccountId),
    Amount: String(model.Amount),
    Currency: 'KZT',
    TestMode: '0',
    OperationType: 'Payment',
    Status: 'Completed',
    DateTime: date,
  };
}
