import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '@pickchick/database';
import { WEBKASSA_CODE, WebkassaClient, readWebkassaAccount } from '@pickchick/webkassa';
import type {
  FiscalLine,
  FiscalPayment,
  WebkassaAccount,
  WebkassaError,
  WebkassaPaymentType,
} from '@pickchick/webkassa';
import { CommerceRepository } from './repository.js';
import { UUIDSchema } from './model.js';
import { KASPI_REMOTE_PROVIDER } from './kaspi-remote.js';
import { KIOSK_KASPI_QR_PROVIDER } from './kiosk-kaspi-qr.js';
import { KIOSK_KASPI_TERMINAL_PROVIDER } from './kiosk-terminal.js';

/**
 * Webkassa receipts of app and kiosk orders (docs/integrations/webkassa-api.md, stage 2).
 *
 * The cloud already queues a `commerce_fiscal_documents` sale and an outbox
 * `fiscal.submit_requested` once an order with fiscal policy `required` is paid in full. Since F-4
 * the kitchen does not wait for that receipt (kitchenBeforeReceipt). This worker is the Webkassa
 * adapter of that queue: the
 * cloud order id is the ExternalCheckNumber (one sale receipt per order) (a repeat after a lost answer resolves to the same receipt,
 * Code 14), and the outcome goes through CommerceRepository.observeFiscal like any provider event.
 *
 * The cloud has its own Webkassa cashbox (owner 27.11, audit F-3): the point server never issues
 * on it, so one sender per cashbox keeps the vendor's one-request-at-a-time rule and each side
 * closes only its own shift. A refusal is still never final here: the document stays queued and is
 * tried again after REFUSED_RETRY_MS, and the same external number can never become a second
 * receipt.
 *
 * Refund receipts (audit 26.11 P0-1): a refund document is queued only once its sale receipt is
 * issued. Its ReturnBasisDetails come from commerce_webkassa_receipts (cloud 083), which this
 * worker writes when a sale receipt is issued; the refund's own document id is its
 * ExternalCheckNumber. A sale issued without those data (a Code 14 repeat after a lost answer, or
 * before 083) cannot be named: the refund stays queued, is logged, and is retried hourly so an
 * operator can issue it by hand in the Webkassa cabinet.
 */
export const WEBKASSA_PROVIDER = 'webkassa';
export const WEBKASSA_LEASE_SECONDS = 120;
/** After a refusal (busy cashbox, offline over 72 h, no licence...) the next try is this late. */
export const REFUSED_RETRY_MS = 5 * 60_000;
/** A refund whose sale receipt data are unknown is looked at again this late. */
export const BASIS_MISSING_RETRY_MS = 60 * 60_000;
/** A document paid through a provider without a Webkassa type is looked at again this late. */
export const PAYMENT_PROVIDER_UNKNOWN_RETRY_MS = 60 * 60_000;

export interface WebkassaCloudConfig {
  /** commerce_provider_accounts row (kind fiscal, provider webkassa) of the branch. */
  accountId: string;
  account: WebkassaAccount;
}

/** Off unless both the private account file and the provider account are configured. */
export function webkassaCloudConfig(env: NodeJS.ProcessEnv): WebkassaCloudConfig | null {
  const file = env.WEBKASSA_ACCOUNT_FILE?.trim(),
    accountId = env.WEBKASSA_FISCAL_ACCOUNT_ID?.trim();
  if (!file && !accountId) return null;
  if (!file || !accountId || !file.startsWith('/') || !UUIDSchema.safeParse(accountId).success)
    throw new Error('INVALID_WEBKASSA_CONFIG');
  // WEBKASSA_REQUIRE_LIVE=true (audit 26.11 P0-2): the cloud refuses the TEST register devkkm.
  const account = readWebkassaAccount(file, { requireLive: env.WEBKASSA_REQUIRE_LIVE === 'true' });
  if (!account) throw new Error('INVALID_WEBKASSA_CONFIG');
  return { accountId, account };
}

/** Webkassa PaymentType by the provider of the capture: TipTopPay is a card, Kaspi is mobile. */
export const WEBKASSA_CAPTURE_TYPE: Readonly<Record<string, WebkassaPaymentType>> = Object.freeze({
  tiptoppay: 1,
  [KASPI_REMOTE_PROVIDER]: 4,
  [KIOSK_KASPI_QR_PROVIDER]: 4,
});

/**
 * PaymentType of a Kaspi Smart POS terminal payment whose method has no owner decision: 'alaqan'
 * (Kaspi palm payment) and a terminal that did not report a method. Awaiting the accountant's
 * confirmation (the value documented before 28.11 is 1, a bank card); change it here, in one line.
 */
export const KASPI_TERMINAL_UNCONFIRMED_PAYMENT_TYPE: WebkassaPaymentType = 1;

/**
 * Webkassa PaymentType of one capture. A kiosk terminal capture follows the method the terminal
 * reported for that very payment (owner 28.11: the receipt names how the guest actually paid):
 * card is a bank card (1), qr is a mobile payment (4), anything else the unconfirmed value above.
 * undefined: a provider without a type, which the worker never guesses.
 */
export function webkassaCaptureType(
  provider: string,
  terminalMethod?: string | null,
): WebkassaPaymentType | undefined {
  if (provider === KIOSK_KASPI_TERMINAL_PROVIDER)
    return terminalMethod === 'card'
      ? 1
      : terminalMethod === 'qr'
        ? 4
        : KASPI_TERMINAL_UNCONFIRMED_PAYMENT_TYPE;
  return Object.hasOwn(WEBKASSA_CAPTURE_TYPE, provider)
    ? WEBKASSA_CAPTURE_TYPE[provider]
    : undefined;
}

interface SnapshotLine {
  title?: unknown;
  quantity?: unknown;
  totalMinor?: unknown;
}

/**
 * Order snapshot lines -> receipt lines whose sum is the document amount to the tiyn. A free line
 * (a gift) is not a receipt position; an order-level discount is taken off the largest lines.
 */
export function cloudFiscalLines(
  lines: readonly SnapshotLine[],
  amountMinor: bigint,
): FiscalLine[] {
  const result: FiscalLine[] = [];
  let sum = 0n;
  for (const line of lines) {
    const title = typeof line.title === 'string' ? line.title.trim() : '';
    const quantity = line.quantity;
    const total =
      typeof line.totalMinor === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(line.totalMinor)
        ? BigInt(line.totalMinor)
        : -1n;
    if (!title || typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1)
      throw new Error('FISCAL_SNAPSHOT');
    if (total < 0n) throw new Error('FISCAL_SNAPSHOT');
    if (total === 0n) continue;
    const unit = (total + BigInt(quantity) - 1n) / BigInt(quantity);
    result.push({
      name: title.slice(0, 250),
      quantity,
      unitPriceMinor: unit,
      discountMinor: unit * BigInt(quantity) - total,
    });
    sum += total;
  }
  if (!result.length || sum < amountMinor) throw new Error('FISCAL_SNAPSHOT');
  let extra = sum - amountMinor;
  for (const line of [...result].sort((a, b) =>
    a.unitPriceMinor * BigInt(a.quantity) > b.unitPriceMinor * BigInt(b.quantity) ? -1 : 1,
  )) {
    if (!extra) break;
    const room = line.unitPriceMinor * BigInt(line.quantity) - line.discountMinor - 1n;
    const take = room < extra ? room : extra;
    line.discountMinor += take;
    extra -= take;
  }
  if (extra) throw new Error('FISCAL_SNAPSHOT');
  return result;
}

interface ClaimedEvent {
  id: string;
  document_id: string;
}
interface DocumentRow {
  id: string;
  order_id: string;
  kind: 'sale' | 'refund';
  business_operation_id: string;
  original_sale_id: string | null;
  amount_minor: string;
  state: string;
  request: { snapshot?: { lines?: SnapshotLine[] } };
}
interface BasisRow {
  check_number: string;
  issued_at: string;
  registration_number: string;
  offline: boolean;
  sale_amount_minor: string;
}
const WEBKASSA_DATE = /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/;

export class WebkassaCloudFiscalWorker {
  private readonly repo: CommerceRepository;
  private readonly workerId = randomUUID();
  private readonly errors = new Map<string, WebkassaError>();
  constructor(
    private readonly pool: DatabasePool,
    private readonly config: WebkassaCloudConfig,
    private readonly client: WebkassaClient = new WebkassaClient(config.account),
    private readonly log: (entry: Record<string, unknown>) => void = (entry) =>
      console.log(JSON.stringify(entry)),
  ) {
    this.repo = new CommerceRepository(pool);
  }

  /** The Webkassa refusal last seen for a document still waiting (back office, tests). */
  lastError(documentId: string) {
    return this.errors.get(documentId) ?? null;
  }

  async tick(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_LIMIT');
    const provider = (
      await this.pool.query<{ organization_id: string; branch_id: string }>(
        "SELECT organization_id,branch_id FROM commerce_provider_accounts WHERE id=$1 AND kind='fiscal' AND provider=$2 AND enabled",
        [this.config.accountId, WEBKASSA_PROVIDER],
      )
    ).rows[0];
    const result = { issued: 0, refused: 0, retry: 0, errors: 0 };
    if (!provider) return result;
    const trusted = {
      organizationId: provider.organization_id,
      branchId: provider.branch_id,
      accountId: this.config.accountId,
    };
    const token = randomUUID();
    // Sales and refunds (a refund is queued only after its sale receipt); one cashbox means one
    // request at a time, so they go one by one.
    const events = (
      await this.pool.query<ClaimedEvent>(
        `WITH selected AS (
      SELECT e.id FROM commerce_outbox e JOIN commerce_orders o ON o.id=e.order_id
      JOIN commerce_fiscal_documents d ON d.id=(e.payload->>'documentId')::uuid AND d.order_id=o.id
      WHERE e.event_type='fiscal.submit_requested' AND e.acknowledged_at IS NULL
       AND (e.lease_until IS NULL OR e.lease_until<clock_timestamp())
       AND d.account_id=$1 AND (e.payload->>'accountId')::uuid=$1 AND d.kind IN ('sale','refund')
       AND d.state IN ('queued','pending') AND NOT o.attention_required
      ORDER BY e.sequence LIMIT $2 FOR UPDATE OF e SKIP LOCKED)
      UPDATE commerce_outbox e SET lease_worker=$3,lease_token=$4,
        lease_until=clock_timestamp()+$5*interval '1 second',attempts=attempts+1
      FROM selected s WHERE e.id=s.id RETURNING e.id,e.payload->>'documentId' document_id`,
        [this.config.accountId, limit, this.workerId, token, WEBKASSA_LEASE_SECONDS],
      )
    ).rows;
    for (const event of events) {
      try {
        result[await this.submit(trusted, event, token)]++;
      } catch (error) {
        result.errors++;
        this.log({
          event: 'webkassa_cloud_failed',
          documentId: event.document_id,
          message: (error as Error).message,
        });
      }
    }
    return result;
  }

  private async submit(
    trusted: { organizationId: string; branchId: string; accountId: string },
    event: ClaimedEvent,
    token: string,
  ): Promise<'issued' | 'refused' | 'retry'> {
    const document = (
      await this.pool.query<DocumentRow>(
        'SELECT id,order_id,kind,business_operation_id,original_sale_id,amount_minor::text,state,request FROM commerce_fiscal_documents WHERE id=$1 AND account_id=$2',
        [event.document_id, this.config.accountId],
      )
    ).rows[0];
    if (!document || (document.kind !== 'sale' && document.kind !== 'refund'))
      throw new Error('FISCAL_DOCUMENT');
    const refund = document.kind === 'refund';
    const amount = BigInt(document.amount_minor);
    let basis: BasisRow | undefined;
    if (refund) {
      basis = (
        await this.pool.query<BasisRow>(
          `SELECT r.check_number,r.issued_at,r.registration_number,r.offline,s.amount_minor::text sale_amount_minor
           FROM commerce_fiscal_documents s JOIN commerce_webkassa_receipts r ON r.document_id=s.id
           WHERE s.id=$1 AND s.order_id=$2 AND s.kind='sale' AND s.state='issued'`,
          [document.original_sale_id, document.order_id],
        )
      ).rows[0];
      if (!basis) {
        await this.hold(event, token, BASIS_MISSING_RETRY_MS);
        this.log({ event: 'webkassa_cloud_refund_basis_missing', documentId: document.id });
        return 'retry';
      }
    }
    // A sale is paid by its captures; a refund goes back by the account of its refund. attempt_id
    // names the payment attempt of the capture (a refund: of the captured payment it returns).
    const captures = (
      await this.pool.query<{ provider: string; attempt_id: string; amount_minor: string }>(
        refund
          ? `SELECT a.provider,c.attempt_id,e.amount_minor::text amount_minor FROM commerce_refund_effects e
             JOIN commerce_provider_accounts a ON a.id=e.account_id
             JOIN commerce_refunds r ON r.id=e.refund_id AND r.order_id=e.order_id
             JOIN commerce_captures c ON c.id=r.capture_id AND c.order_id=r.order_id
             WHERE e.id=$1 AND e.order_id=$2`
          : `SELECT a.provider,c.attempt_id,c.amount_minor::text amount_minor FROM commerce_captures c
             JOIN commerce_provider_accounts a ON a.id=c.account_id WHERE c.order_id=$1 ORDER BY c.received_at,c.id`,
        refund ? [document.business_operation_id, document.order_id] : [document.order_id],
      )
    ).rows;
    // The Kaspi terminal reports how the guest paid (qr, card, alaqan); that is what the receipt
    // names (owner 28.11). Read only when a terminal payment is involved, so the other providers
    // never depend on the terminal tables.
    const terminalMethods = new Map<string, string | null>();
    const terminalAttempts = captures
      .filter((c) => c.provider === KIOSK_KASPI_TERMINAL_PROVIDER)
      .map((c) => c.attempt_id);
    if (terminalAttempts.length)
      for (const row of (
        await this.pool.query<{ attempt_id: string; method: string | null }>(
          `SELECT attempt_id,method FROM commerce_kiosk_terminal_events
           WHERE attempt_id=ANY($1::uuid[]) AND kind='result' AND decision='paid'`,
          [terminalAttempts],
        )
      ).rows)
        terminalMethods.set(row.attempt_id, row.method);
    // A provider without a Webkassa type is never guessed. It used to throw and come back with
    // every 120 s lease for ever; now the event is held for an hour and logged on its own, so
    // monitoring and an operator can see which provider needs a decision.
    const unknown = captures.filter(
      (c) =>
        webkassaCaptureType(c.provider, terminalMethods.get(c.attempt_id) ?? null) === undefined,
    );
    if (unknown.length) {
      await this.hold(event, token, PAYMENT_PROVIDER_UNKNOWN_RETRY_MS);
      this.log({
        event: 'webkassa_cloud_payment_provider_unknown',
        documentId: document.id,
        providers: [...new Set(unknown.map((c) => c.provider))].sort(),
      });
      return 'retry';
    }
    const payments = new Map<WebkassaPaymentType, bigint>();
    for (const capture of captures) {
      const type = webkassaCaptureType(
        capture.provider,
        terminalMethods.get(capture.attempt_id) ?? null,
      )!;
      payments.set(type, (payments.get(type) ?? 0n) + BigInt(capture.amount_minor));
    }
    const paid = [...payments.values()].reduce((a, b) => a + b, 0n);
    if (paid !== amount) {
      // Still thrown (and retried with the lease), but monitoring tells it from a network error.
      this.log({
        event: 'webkassa_cloud_payment_amount_mismatch',
        documentId: document.id,
        kind: document.kind,
      });
      throw new Error('FISCAL_PAYMENT_AMOUNT');
    }
    const lines = cloudFiscalLines(document.request.snapshot?.lines ?? [], amount);
    const list: FiscalPayment[] = [...payments].map(([type, amountMinor]) => ({
      type,
      amountMinor,
    }));
    if (document.state === 'queued')
      await this.repo.observeFiscal(trusted, {
        eventId: `webkassa:pending:${document.id}`,
        documentId: document.id,
        outcome: 'pending',
        occurredAt: new Date().toISOString(),
      });
    // A sale: the cloud order id (the cashier desk prints a kiosk receipt by it,
    // pos/kiosk-receipts). A refund: its own document id.
    const externalNumber = refund ? document.id : document.order_id;
    const answer = await this.client.issue({
      operation: refund ? 'refund' : 'sale',
      externalNumber,
      lines,
      payments: list,
      ...(basis
        ? {
            returnBasis: {
              checkNumber: basis.check_number,
              dateTime: basis.issued_at,
              total: BigInt(basis.sale_amount_minor),
              registrationNumber: basis.registration_number,
              offline: basis.offline,
            },
          }
        : {}),
    });
    if (answer.kind === 'refused') {
      const error = answer.errors[0] ?? { code: -1, text: '' };
      this.errors.set(document.id, error);
      // A Webkassa shift older than 24 h refuses every receipt: close it once, then retry.
      if (answer.errors.some((e) => e.code === WEBKASSA_CODE.SHIFT_OVER_24H))
        await this.client.zReport();
      await this.hold(event, token, REFUSED_RETRY_MS);
      this.log({ event: 'webkassa_cloud_refused', documentId: document.id, code: error.code });
      return 'refused';
    }
    if (answer.kind !== 'issued') return 'retry';
    // What a later refund receipt must name (ReturnBasisDetails); a Code 14 repeat carries none,
    // so they are kept before anything else can fail.
    if (!refund && WEBKASSA_DATE.test(answer.receipt.dateTime) && answer.receipt.registrationNumber)
      await this.pool.query(
        `INSERT INTO commerce_webkassa_receipts(document_id,check_number,issued_at,registration_number,offline)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT(document_id) DO NOTHING`,
        [
          document.id,
          answer.receipt.checkNumber,
          answer.receipt.dateTime,
          answer.receipt.registrationNumber,
          answer.receipt.offline,
        ],
      );
    // The receipt link for the guest: from the answer, else the QR line of its print form.
    const url =
      answer.receipt.ticketUrl ??
      (await this.client.printFormat(externalNumber))?.find(
        (l) => l.type === 2 && /^https:\/\//.test(l.value),
      )?.value ??
      null;
    if (!url || !/^https:\/\//.test(url)) return 'retry';
    this.errors.delete(document.id);
    await this.repo.observeFiscal(trusted, {
      eventId: `webkassa:issued:${document.id}`,
      documentId: document.id,
      outcome: 'issued',
      providerDocumentId: answer.receipt.checkNumber,
      fiscalMark: answer.receipt.checkNumber,
      receiptUrl: url,
      amountMinor: document.amount_minor,
      occurredAt: new Date().toISOString(),
    });
    await this.pool.query(
      'UPDATE commerce_outbox SET acknowledged_at=COALESCE(acknowledged_at,clock_timestamp()) WHERE id=$1 AND lease_worker=$2 AND lease_token=$3',
      [event.id, this.workerId, token],
    );
    return 'issued';
  }

  /** Keeps the event leased (not acknowledged) until the next try. */
  private async hold(event: ClaimedEvent, token: string, ms: number) {
    await this.pool.query(
      `UPDATE commerce_outbox SET lease_until=clock_timestamp()+$4*interval '1 millisecond'
       WHERE id=$1 AND lease_worker=$2 AND lease_token=$3`,
      [event.id, this.workerId, token, ms],
    );
  }
}
