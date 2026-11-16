import type { PosPaymentMethod } from '@pickchick/contracts';

/**
 * Webkassa API client (docs/integrations/webkassa-api-plan.md): the point server issues fiscal
 * receipts on an existing Webkassa cash register (касса №2 at the test point) instead of the
 * cashier typing the Webkassa number by hand (ADR-0015 `manual_webkassa`).
 *
 * NOT YET CHECKED AGAINST THE VENDOR CONTRACT: the paths, field names and error codes below follow
 * the public Webkassa integration API as known on 16.11.2026 (POST api/Authorize, POST api/Check,
 * header X-API-KEY, OperationType 2 sale / 3 sale return, PaymentType 0 cash / 1 card / 4 mobile).
 * They are confirmed against the documentation and Postman collection the owner obtains from
 * Webkassa before anything runs against a real register; until then only the simulator calls it.
 *
 * Results say exactly what is known, like the Kaspi client: `unreachable` - nothing was sent,
 * repeating is safe; `lost` - the request may have reached Webkassa and a receipt may exist, the
 * caller reconciles by the same ExternalCheckNumber before anything else; `refused` - Webkassa
 * answered with errors, no receipt was made.
 */
export interface WebkassaAccount {
  /** https://devkkm.webkassa.kz (test) or the production address from the vendor. */
  baseUrl: string;
  apiKey: string;
  login: string;
  password: string;
  /** Заводской номер SWK… of the register the receipts go to. */
  cashboxUniqueNumber: string;
}
export interface WebkassaError {
  code: number;
  text: string;
}
export type WebkassaCallResult =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'refused'; httpStatus: number; errors: WebkassaError[] }
  | { kind: 'unreachable'; reason: 'CONNECT' | 'TIMEOUT' }
  | { kind: 'lost'; reason: 'TIMEOUT' | 'CONNECTION' | 'ANSWER' };
export type WebkassaMethod = 'api/Authorize' | 'api/Check';

/** The seam the edge uses; tests give a simulator, the edge gives webkassaHttp. */
export interface WebkassaTransport {
  post(
    baseUrl: string,
    method: WebkassaMethod,
    apiKey: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<WebkassaCallResult>;
}

const MAX_ANSWER = 256 * 1024;
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function errorsOf(value: unknown): WebkassaError[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    entry && typeof entry === 'object' && typeof (entry as { Code?: unknown }).Code === 'number'
      ? [
          {
            code: (entry as { Code: number }).Code,
            text: String((entry as { Text?: unknown }).Text ?? '').slice(0, 500),
          },
        ]
      : [],
  );
}

/** Reads a Webkassa answer: `{Data}` on success, `{Errors:[{Code,Text}]}` on refusal. */
export function readWebkassaAnswer(httpStatus: number, text: string): WebkassaCallResult {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: 'lost', reason: 'ANSWER' };
  }
  if (!body || typeof body !== 'object') return { kind: 'lost', reason: 'ANSWER' };
  const errors = errorsOf((body as { Errors?: unknown }).Errors);
  if (errors.length > 0) return { kind: 'refused', httpStatus, errors };
  const data = (body as { Data?: unknown }).Data;
  if (httpStatus === 200 && data && typeof data === 'object' && !Array.isArray(data))
    return { kind: 'ok', data: data as Record<string, unknown> };
  return { kind: 'lost', reason: 'ANSWER' };
}

/** HTTPS transport over global fetch; the base URL must be https. */
export const webkassaHttp: WebkassaTransport = {
  async post(baseUrl, method, apiKey, body, timeoutMs) {
    const url = new URL(method, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    if (url.protocol !== 'https:') return { kind: 'unreachable', reason: 'CONNECT' };
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause;
      if (cause?.code && CONNECT_CODES.has(cause.code))
        return { kind: 'unreachable', reason: 'CONNECT' };
      // A timeout or reset after the connection opened: the request may have been processed.
      return {
        kind: 'lost',
        reason: (error as { name?: string }).name === 'TimeoutError' ? 'TIMEOUT' : 'CONNECTION',
      };
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      return { kind: 'lost', reason: 'CONNECTION' };
    }
    if (text.length > MAX_ANSWER) return { kind: 'lost', reason: 'ANSWER' };
    return readWebkassaAnswer(response.status, text);
  },
};

/** Payment types of a Webkassa check by our tender method (accountant to confirm, plan item 4). */
export const WEBKASSA_PAYMENT_TYPE: Partial<Record<PosPaymentMethod, number>> = {
  cash: 0,
  kaspi_terminal: 1,
  kaspi_manual: 4,
};

export interface FiscalLine {
  name: string;
  /** Whole units. */
  quantity: number;
  unitPriceMinor: bigint;
  /** What the guest pays for the line after discounts, in tiyn. */
  totalMinor: bigint;
}
export interface FiscalPayment {
  method: PosPaymentMethod;
  amountMinor: bigint;
}
export interface FiscalCheck {
  operation: 'sale' | 'refund';
  /** Our pos_fiscal_receipts id: the same receipt is never issued twice under one number. */
  externalNumber: string;
  lines: readonly FiscalLine[];
  payments: readonly FiscalPayment[];
  /** Cash change given, tiyn (sale only). */
  changeMinor: bigint;
  /** VAT rate in percent the register is set up with, 0 = without VAT (accountant decides). */
  vatPercent: number;
}

export class FiscalCheckError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Tiyn to a tenge number with at most two decimals, exactly (amounts stay below 2^53 tiyn). */
export function tengeOf(minor: bigint): number {
  if (minor < 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new FiscalCheckError('AMOUNT');
  return Number(minor) / 100;
}

/**
 * The body of api/Check without the token. Checks the money before anything is sent: lines sum to
 * the paid total minus change, every payment has a Webkassa type, a refund has no change.
 */
export function buildWebkassaCheck(
  check: FiscalCheck,
  cashboxUniqueNumber: string,
): Record<string, unknown> {
  if (check.lines.length === 0 || check.payments.length === 0) throw new FiscalCheckError('EMPTY');
  if (check.operation === 'refund' && check.changeMinor !== 0n)
    throw new FiscalCheckError('CHANGE');
  if (!/^[0-9A-Za-z-]{1,64}$/.test(check.externalNumber))
    throw new FiscalCheckError('EXTERNAL_NUMBER');
  let linesTotal = 0n;
  const positions = check.lines.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity < 1)
      throw new FiscalCheckError('QUANTITY');
    const gross = line.unitPriceMinor * BigInt(line.quantity);
    if (line.totalMinor < 0n || line.totalMinor > gross) throw new FiscalCheckError('LINE');
    linesTotal += line.totalMinor;
    const name = line.name.trim().slice(0, 250);
    if (!name) throw new FiscalCheckError('NAME');
    // VAT is included in the price: tax = total * rate / (100 + rate), rounded to tiyn.
    const rate = BigInt(check.vatPercent);
    const taxMinor =
      check.vatPercent > 0
        ? (line.totalMinor * rate * 2n + (100n + rate)) / ((100n + rate) * 2n)
        : 0n;
    return {
      Count: line.quantity,
      Price: tengeOf(line.unitPriceMinor),
      Discount: tengeOf(gross - line.totalMinor),
      Markup: 0,
      PositionName: name,
      TaxType: check.vatPercent > 0 ? 100 : 0,
      TaxPercent: check.vatPercent,
      Tax: tengeOf(taxMinor),
      UnitCode: 796,
    };
  });
  let paid = 0n;
  const payments = check.payments.map((payment) => {
    const type = WEBKASSA_PAYMENT_TYPE[payment.method];
    if (type === undefined) throw new FiscalCheckError('METHOD');
    if (payment.amountMinor <= 0n) throw new FiscalCheckError('PAYMENT');
    paid += payment.amountMinor;
    return { Sum: tengeOf(payment.amountMinor), PaymentType: type };
  });
  if (paid - check.changeMinor !== linesTotal) throw new FiscalCheckError('TOTAL');
  if (
    check.changeMinor > 0n &&
    check.payments.filter((p) => p.method === 'cash').reduce((sum, p) => sum + p.amountMinor, 0n) <
      check.changeMinor
  )
    throw new FiscalCheckError('CHANGE');
  return {
    CashboxUniqueNumber: cashboxUniqueNumber,
    OperationType: check.operation === 'sale' ? 2 : 3,
    Positions: positions,
    Payments: payments,
    Change: tengeOf(check.changeMinor),
    RoundType: 2,
    ExternalCheckNumber: check.externalNumber,
  };
}

/** What we keep from an issued receipt (the raw answer is not logged: it names the cashier). */
export interface IssuedReceipt {
  checkNumber: string;
  issuedAt: string | null;
  ticketUrl: string | null;
  offline: boolean;
  shiftNumber: number | null;
}
export function issuedReceiptOf(data: Record<string, unknown>): IssuedReceipt | null {
  const checkNumber = data.CheckNumber;
  if (typeof checkNumber !== 'string' && typeof checkNumber !== 'number') return null;
  const text = String(checkNumber).trim();
  if (!text || text.length > 64) return null;
  const url =
    typeof data.TicketUrl === 'string' && /^https:\/\//.test(data.TicketUrl)
      ? data.TicketUrl
      : null;
  return {
    checkNumber: text,
    issuedAt: typeof data.DateTime === 'string' ? data.DateTime : null,
    ticketUrl: url,
    offline: data.OfflineMode === true,
    shiftNumber: typeof data.ShiftNumber === 'number' ? data.ShiftNumber : null,
  };
}

/** Webkassa error code for an expired or unknown session token (vendor to confirm). */
const TOKEN_EXPIRED = 2;

export type WebkassaIssueResult =
  | { kind: 'issued'; receipt: IssuedReceipt }
  | { kind: 'refused'; errors: WebkassaError[] }
  | { kind: 'unreachable' }
  | { kind: 'lost' };

/**
 * One Webkassa session: authorizes lazily, re-authorizes once on an expired token, issues checks.
 * A `lost` answer is reported as is; the caller repeats the very same check (same
 * ExternalCheckNumber), which Webkassa answers with the receipt already made, never a second one.
 */
export class WebkassaSession {
  private token: string | null = null;

  constructor(
    private readonly account: WebkassaAccount,
    private readonly transport: WebkassaTransport = webkassaHttp,
    private readonly timeoutMs = 15_000,
  ) {}

  private async authorize(): Promise<WebkassaCallResult> {
    const result = await this.transport.post(
      this.account.baseUrl,
      'api/Authorize',
      this.account.apiKey,
      { Login: this.account.login, Password: this.account.password },
      this.timeoutMs,
    );
    if (result.kind === 'ok') {
      const token = result.data.Token;
      if (typeof token !== 'string' || !token) return { kind: 'lost', reason: 'ANSWER' };
      this.token = token;
    }
    return result;
  }

  async issue(check: FiscalCheck): Promise<WebkassaIssueResult> {
    const body = buildWebkassaCheck(check, this.account.cashboxUniqueNumber);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!this.token) {
        const auth = await this.authorize();
        if (auth.kind === 'refused') return { kind: 'refused', errors: auth.errors };
        // Authorize creates no receipt: a lost authorization is as safe as an unreachable one.
        if (auth.kind !== 'ok') return { kind: 'unreachable' };
      }
      const result = await this.transport.post(
        this.account.baseUrl,
        'api/Check',
        this.account.apiKey,
        { Token: this.token, ...body },
        this.timeoutMs,
      );
      if (result.kind === 'ok') {
        const receipt = issuedReceiptOf(result.data);
        return receipt ? { kind: 'issued', receipt } : { kind: 'lost' };
      }
      if (result.kind === 'refused') {
        if (attempt === 0 && result.errors.some((e) => e.code === TOKEN_EXPIRED)) {
          this.token = null;
          continue;
        }
        return { kind: 'refused', errors: result.errors };
      }
      return result.kind === 'unreachable' ? { kind: 'unreachable' } : { kind: 'lost' };
    }
    return { kind: 'lost' };
  }
}
