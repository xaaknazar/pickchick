import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { transaction, type DatabasePool } from '@pickchick/database';
import { z } from 'zod';
import { CommerceError, parse, UUIDSchema } from './model.js';
import { verifyTipTopPayForm, parseTipTopPayPayment, TipTopPayError } from './tiptoppay.js';
import { tipTopPayHostedHtml } from './tiptoppay-checkout.js';
const methodSchema = z.enum(['card', 'apple_pay', 'google_pay']);
export interface TipTopPayTestOptions {
  organizationId: string;
  branchId: string;
  maxMinor: string;
  publicId: string;
  apiSecret: string;
  origin: string;
  methods: z.infer<typeof methodSchema>[];
  routingVerified: boolean;
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
  const routingVerified = env.TIPTOPPAY_METHOD_ROUTING_VERIFIED === 'true';
  const methods = routingVerified
    ? z
        .array(methodSchema)
        .min(1)
        .max(3)
        .parse((env.TIPTOPPAY_TEST_CHECKOUT_METHODS ?? 'card').split(','))
    : ['card' as const];
  if (methods.includes('apple_pay') && env.TIPTOPPAY_APPLE_PAY_DOMAIN_VERIFIED !== 'true')
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
    routingVerified,
  };
}
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
type TestRow = {
  id: string;
  quote_id: string;
  customer_id: string;
  public_id: string;
  amount_minor: string;
  method: z.infer<typeof methodSchema>;
  state: 'pending' | 'paid' | 'failed';
  expires_at: Date;
  opened_at: Date | null;
  operation_id: string | null;
  paid_operation_id: string | null;
};
const view = (row: TestRow) => ({
  id: row.id,
  quoteId: row.quote_id,
  amountMinor: row.amount_minor,
  method: row.method,
  state:
    row.state === 'pending' && row.expires_at.getTime() <= Date.now()
      ? ('expired' as const)
      : row.state,
  expiresAt: row.expires_at.toISOString(),
});
/** No CommerceRepository or commercial financial effects are reachable from this sandbox. */
export class TipTopPayTestCheckout {
  constructor(
    private readonly pool: DatabasePool,
    private readonly options: TipTopPayTestOptions | null,
  ) {}
  async create(customerId: string, input: unknown) {
    if (!this.options) throw new CommerceError('NOT_READY');
    const request = parse(z.strictObject({ quoteId: UUIDSchema, method: methodSchema }), input);
    if (!this.options.methods.includes(request.method)) throw new CommerceError('NOT_READY');
    return transaction(this.pool, async (client) => {
      const quote = (
        await client.query<{
          organization_id: string;
          branch_id: string;
          total_minor: string;
          snapshot: unknown;
          expires_at: Date;
        }>(
          `SELECT organization_id,branch_id,total_minor::text,snapshot,expires_at FROM commerce_quotes WHERE id=$1 AND customer_id=$2 AND principal_id=$2 AND snapshot->>'channel'='mobile' AND organization_id=$3 AND branch_id=$4 FOR UPDATE`,
          [request.quoteId, customerId, this.options!.organizationId, this.options!.branchId],
        )
      ).rows[0];
      if (!quote) throw new CommerceError('NOT_FOUND');
      let row = (
        await client.query<TestRow>(
          'SELECT *,amount_minor::text FROM commerce_tiptoppay_test_payments WHERE quote_id=$1 FOR UPDATE',
          [request.quoteId],
        )
      ).rows[0];
      if (
        row &&
        (row.customer_id !== customerId ||
          row.method !== request.method ||
          row.public_id !== this.options!.publicId)
      )
        throw new CommerceError('CONFLICT');
      if (
        row &&
        (row.opened_at || row.state !== 'pending' || row.expires_at.getTime() <= Date.now())
      )
        return view(row);
      if (!row && BigInt(quote.total_minor) > BigInt(this.options!.maxMinor))
        throw new CommerceError('NOT_READY');
      if (!row && quote.expires_at.getTime() <= Date.now()) throw new CommerceError('EXPIRED');
      const token = randomBytes(32).toString('hex');
      if (!row)
        row = (
          await client.query<TestRow>(
            `INSERT INTO commerce_tiptoppay_test_payments(id,quote_id,customer_id,organization_id,branch_id,public_id,amount_minor,method,snapshot,token_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+interval '10 minutes') RETURNING *,amount_minor::text`,
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
              hash(token),
            ],
          )
        ).rows[0]!;
      else
        await client.query(
          'UPDATE commerce_tiptoppay_test_payments SET token_hash=$2 WHERE id=$1',
          [row.id, hash(token)],
        );
      return {
        ...view(row),
        checkoutUrl: `${this.options!.origin}/v1/integrations/tiptoppay/test-checkout#${token}`,
      };
    });
  }
  async read(customerId: string, id: string) {
    parse(UUIDSchema, id);
    const row = (
      await this.pool.query<TestRow>(
        'SELECT *,amount_minor::text FROM commerce_tiptoppay_test_payments WHERE id=$1 AND customer_id=$2',
        [id, customerId],
      )
    ).rows[0];
    if (!row) throw new CommerceError('NOT_FOUND');
    return view(row);
  }
  async open(token: unknown) {
    if (!this.options || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
      throw new CommerceError('NOT_FOUND');
    return transaction(this.pool, async (client) => {
      const row = (
        await client.query<TestRow>(
          `SELECT *,amount_minor::text FROM commerce_tiptoppay_test_payments WHERE token_hash=$1 AND public_id=$2 AND state='pending' AND expires_at>clock_timestamp() AND opened_at IS NULL FOR UPDATE`,
          [hash(token), this.options!.publicId],
        )
      ).rows[0];
      if (!row || !this.options!.methods.includes(row.method)) throw new CommerceError('NOT_FOUND');
      await client.query(
        'UPDATE commerce_tiptoppay_test_payments SET opened_at=clock_timestamp() WHERE id=$1',
        [row.id],
      );
      const selected = { card: 'Card', apple_pay: 'ApplePay', google_pay: 'GooglePay' }[row.method];
      return {
        publicTerminalId: row.public_id,
        amount: Number(row.amount_minor) / 100,
        currency: 'KZT',
        paymentSchema: 'Single',
        culture: 'ru-RU',
        description: 'PickChick TEST - без реального списания',
        externalId: row.id,
        userInfo: { accountId: row.customer_id },
        tokenize: false,
        retryPayment: false,
        ...(this.options!.routingVerified
          ? {
              restrictedPaymentMethods: ['Card', 'ApplePay', 'GooglePay', 'InstallmentKz'].filter(
                (m) => m !== selected,
              ),
              paymentMethodSequence: [selected],
            }
          : {}),
      };
    });
  }
  async status(token: unknown) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
      throw new CommerceError('NOT_FOUND');
    const row = (
      await this.pool.query<TestRow>(
        `SELECT *,amount_minor::text FROM commerce_tiptoppay_test_payments WHERE token_hash=$1 AND expires_at>clock_timestamp()-interval '30 minutes'`,
        [hash(token)],
      )
    ).rows[0];
    if (!row) throw new CommerceError('NOT_FOUND');
    return { status: row.state === 'paid' ? 'observed' : 'checking' };
  }
  async receive(event: string, raw: Buffer, signature: string | undefined) {
    if (!this.options) throw new TipTopPayError('DISABLED');
    if (!['check', 'pay', 'fail'].includes(event)) throw new TipTopPayError('INVALID');
    const fields = verifyTipTopPayForm(raw, signature, this.options.apiSecret);
    if (fields.TestMode !== '1') throw new TipTopPayError('MODE');
    const payment = parseTipTopPayPayment(
      { ...fields, TestMode: '0' },
      event as 'check' | 'pay' | 'fail',
    );
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
          row.expires_at.getTime() <= Date.now() ||
          (row.operation_id && row.operation_id !== payment.operationId)
        )
          return { code: 13 };
        await client.query(
          'UPDATE commerce_tiptoppay_test_payments SET operation_id=$2,updated_at=clock_timestamp() WHERE id=$1',
          [row.id, payment.operationId],
        );
      } else if (event === 'pay') {
        if (row.paid_operation_id && row.paid_operation_id !== payment.operationId)
          throw new TipTopPayError('BINDING');
        await client.query(
          "UPDATE commerce_tiptoppay_test_payments SET state='paid',paid_operation_id=$2,updated_at=clock_timestamp() WHERE id=$1 AND state<>'paid'",
          [row.id, payment.operationId],
        );
      } else if (row.state !== 'paid') {
        await client.query(
          "UPDATE commerce_tiptoppay_test_payments SET state='failed',reason_code=$2,updated_at=clock_timestamp() WHERE id=$1",
          [row.id, fields.ReasonCode],
        );
      }
      return { code: 0 };
    });
  }
}
export const tipTopPayTestHostedHtml = tipTopPayHostedHtml
  .replaceAll('checkout-session', 'test-checkout-session')
  .replaceAll('checkout-status', 'test-checkout-status')
  .replace('Оплата PickChick', 'TEST-оплата PickChick')
  .replace(
    'Продолжите оплату в защищённой форме.',
    'Тестовый терминал. Реальные деньги не списываются. Заказ не отправляется на кухню.',
  )
  .replace(
    'Вернитесь в приложение. Результат оплаты проверяется сервером.',
    'Тест завершён. Вернитесь в приложение для проверки TEST-результата.',
  );
