import { readFileSync } from 'node:fs';
import type { PosPaymentMethod } from '@pickchick/contracts';

/**
 * Webkassa API v4 client (docs/integrations/webkassa-api.md, vendor Postman collection
 * «ИНТЕГРАТОРЫ - 2.0.4»; checked on devkkm.webkassa.kz 25.11.2026 with receipt 132524690).
 *
 * Rules of the vendor that shape this client:
 * - every call carries the `x-api-key` header; api/v4/Authorize {Login, Password} gives a Token;
 * - requests for one cash register go strictly one after another (the caller serializes them);
 * - ExternalCheckNumber makes a check idempotent: the same number again answers Code 14
 *   «уже присутствует» with the existing CheckNumber, never a second receipt;
 * - the first check of a day opens the Webkassa shift; a shift may not last over 24 h (Code 11).
 *
 * Results say exactly what is known: `unreachable` - nothing was sent, repeating is safe;
 * `lost` - the request may have reached Webkassa, the caller repeats with the SAME external number
 * (Code 14 then resolves it); `refused` - Webkassa answered with errors.
 */
export interface WebkassaAccount {
  /** https://devkkm.webkassa.kz (test) or https://kkm.webkassa.kz (production). */
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
  | { kind: 'ok'; data: Record<string, unknown>; top: Record<string, unknown> }
  | { kind: 'refused'; httpStatus: number; errors: WebkassaError[]; top: Record<string, unknown> }
  | { kind: 'unreachable'; reason: 'CONNECT' | 'TIMEOUT' }
  | { kind: 'lost'; reason: 'TIMEOUT' | 'CONNECTION' | 'ANSWER' };

/** Webkassa error codes the client acts on (vendor list «Список кодов ошибок»). */
export const WEBKASSA_CODE = Object.freeze({
  BAD_LOGIN: 1,
  SESSION_EXPIRED: 2,
  NOT_AUTHORIZED: 3,
  VALIDATION: 9,
  NOT_ACTIVATED: 10,
  SHIFT_OVER_24H: 11,
  NO_OPEN_SHIFT: 13,
  DUPLICATE_EXTERNAL: 14,
  OFFLINE_OVER_72H: 18,
});

/** The seam the edge uses; tests give a simulator, the edge gives webkassaHttp. */
export interface WebkassaTransport {
  post(
    baseUrl: string,
    path: string,
    apiKey: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<WebkassaCallResult>;
}

const MAX_ANSWER = 512 * 1024;
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
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { kind: 'lost', reason: 'ANSWER' };
  const top = body as Record<string, unknown>;
  const errors = errorsOf(top.Errors);
  if (errors.length > 0) return { kind: 'refused', httpStatus, errors, top };
  const data = top.Data;
  if (httpStatus === 200 && data && typeof data === 'object' && !Array.isArray(data))
    return { kind: 'ok', data: data as Record<string, unknown>, top };
  return { kind: 'lost', reason: 'ANSWER' };
}

/** HTTPS transport over global fetch; the base URL must be https. */
export const webkassaHttp: WebkassaTransport = {
  async post(baseUrl, path, apiKey, body, timeoutMs) {
    const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    if (url.protocol !== 'https:') return { kind: 'unreachable', reason: 'CONNECT' };
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          // The receipt's second language next to Kazakh (Ticket/PrintFormat).
          'accept-language': 'ru-RU',
        },
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

/**
 * Webkassa PaymentType by our tender method: 0 cash, 1 bank card, 4 mobile payment. Kaspi QR and
 * Kaspi transfers are mobile payments; the Kaspi Smart POS terminal takes cards and QR, so its
 * part counts as card (accountant to confirm, docs/integrations/webkassa-api.md).
 */
export const WEBKASSA_PAYMENT_TYPE: Partial<Record<PosPaymentMethod, 0 | 1 | 4>> = {
  cash: 0,
  kaspi_terminal: 1,
  kaspi_manual: 4,
};

export interface FiscalLine {
  name: string;
  /** Whole units. */
  quantity: number;
  /** Price of one unit, tiyn. */
  unitPriceMinor: bigint;
  /** Discount on the whole line, tiyn (0 when none). */
  discountMinor: bigint;
  /** Line section code in the Webkassa cabinet (optional). */
  sectionCode?: string;
}
export interface FiscalPayment {
  type: 0 | 1 | 4;
  amountMinor: bigint;
}
export interface FiscalCheck {
  operation: 'sale' | 'refund';
  /** Our receipt id: the same receipt is never issued twice under one number. */
  externalNumber: string;
  /** Our order number shown on the receipt (ExternalOrderNumber). */
  orderNumber?: string;
  lines: readonly FiscalLine[];
  payments: readonly FiscalPayment[];
  /** Refund only (protocol 2.0.3+): the sale being returned. */
  returnBasis?: {
    checkNumber: string;
    dateTime: string;
    total: bigint;
    registrationNumber: string;
    offline: boolean;
  };
  customerPhone?: string;
  customerEmail?: string;
}

/** One printable line of a receipt (Ticket/PrintFormat): Type 0 text, 2 QR; Style 1 bold. */
export interface WebkassaPrintLine {
  order: number;
  type: number;
  value: string;
  style: number;
}
export interface WebkassaIssued {
  checkNumber: string;
  dateTime: string;
  offline: boolean;
  shiftNumber: number | null;
  ticketUrl: string | null;
  registrationNumber: string | null;
  /** True when Webkassa already had this external number (Code 14). */
  duplicate: boolean;
}
export type WebkassaIssueResult =
  | { kind: 'issued'; receipt: WebkassaIssued }
  | { kind: 'refused'; errors: WebkassaError[] }
  | { kind: 'unreachable' }
  | { kind: 'lost' };

const tenge = (minor: bigint): number => {
  if (minor < 0n) throw new Error('Negative amount');
  return Number(minor) / 100;
};
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0
    ? value
    : typeof value === 'number'
      ? String(value)
      : null;

/** «25.11.2026 14:34:29» (as Webkassa returns it) -> «2026-11-25 14:34:29» (returnBasisDetails). */
export function basisDateTime(value: string): string {
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(value);
  if (!m) throw new Error('Unknown Webkassa date');
  return `${m[3]}-${m[2]}-${m[1]} ${m[4]}`;
}

/** The api/v4/check body. Prices are tenge with tiyn; no VAT (TaxType 0) unless the cabinet says. */
export function checkBody(token: string, cashbox: string, check: FiscalCheck) {
  if (check.lines.length === 0 || check.payments.length === 0) throw new Error('Empty check');
  const seen = new Set<number>();
  for (const p of check.payments) {
    if (seen.has(p.type)) throw new Error('Each payment type once');
    seen.add(p.type);
  }
  const lineTotal = check.lines.reduce(
    (sum, l) => sum + l.unitPriceMinor * BigInt(l.quantity) - l.discountMinor,
    0n,
  );
  const paid = check.payments.reduce((sum, p) => sum + p.amountMinor, 0n);
  if (lineTotal !== paid || lineTotal <= 0n) throw new Error('Payments do not match the lines');
  return {
    Token: token,
    CashboxUniqueNumber: cashbox,
    OperationType: check.operation === 'sale' ? 2 : 3,
    Positions: check.lines.map((l, index) => ({
      Count: l.quantity,
      Price: tenge(l.unitPriceMinor),
      TaxType: 0,
      TaxPercent: 0,
      Tax: 0,
      PositionName: l.name.slice(0, 200),
      PositionCode: String(index + 1),
      PositionType: 0,
      Discount: tenge(l.discountMinor),
      Markup: 0,
      UnitCode: 796,
      ...(l.sectionCode ? { SectionCode: l.sectionCode } : {}),
    })),
    Payments: check.payments.map((p) => ({ Sum: tenge(p.amountMinor), PaymentType: p.type })),
    Change: 0,
    // 0: positions and total keep tiyn; our prices are already exact.
    RoundType: 0,
    PaperKind: 0,
    ExternalCheckNumber: check.externalNumber,
    ...(check.orderNumber ? { ExternalOrderNumber: check.orderNumber } : {}),
    ...(check.customerPhone ? { CustomerPhone: check.customerPhone } : {}),
    ...(check.customerEmail ? { CustomerEmail: check.customerEmail } : {}),
    ...(check.returnBasis
      ? {
          ReturnBasisDetails: {
            CheckNumber: check.returnBasis.checkNumber,
            DateTime: basisDateTime(check.returnBasis.dateTime),
            Total: tenge(check.returnBasis.total),
            RegistrationNumber: check.returnBasis.registrationNumber,
            IsOffline: check.returnBasis.offline,
          },
        }
      : {}),
  };
}

function issuedFrom(data: Record<string, unknown>, duplicate: boolean): WebkassaIssued | null {
  const checkNumber = str(data.CheckNumber);
  if (!checkNumber) return null;
  const cashbox = (data.Cashbox ?? {}) as Record<string, unknown>;
  return {
    checkNumber,
    dateTime: str(data.DateTime) ?? '',
    offline: data.OfflineMode === true,
    shiftNumber: typeof data.ShiftNumber === 'number' ? data.ShiftNumber : null,
    ticketUrl: str(data.TicketUrl),
    registrationNumber: str(cashbox.RegistrationNumber),
    duplicate,
  };
}

export interface WebkassaClientOptions {
  transport?: WebkassaTransport;
  timeoutMs?: number;
}

/**
 * One client per register. Not reentrant: the caller runs one call at a time (vendor rule). The
 * token is kept in memory only and renewed on Code 2/3.
 */
export class WebkassaClient {
  readonly #account: WebkassaAccount;
  readonly #transport: WebkassaTransport;
  readonly #timeoutMs: number;
  #token: string | null = null;

  constructor(account: WebkassaAccount, options: WebkassaClientOptions = {}) {
    this.#account = account;
    this.#transport = options.transport ?? webkassaHttp;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  get cashbox(): string {
    return this.#account.cashboxUniqueNumber;
  }

  async #post(path: string, body: Record<string, unknown>) {
    return this.#transport.post(
      this.#account.baseUrl,
      path,
      this.#account.apiKey,
      body,
      this.#timeoutMs,
    );
  }

  /** Signs in; `refused` with Code 1 means the login or password in the private file is wrong. */
  async authorize(): Promise<WebkassaCallResult> {
    const result = await this.#post('api/v4/Authorize', {
      Login: this.#account.login,
      Password: this.#account.password,
    });
    this.#token = result.kind === 'ok' ? str(result.data.Token) : null;
    if (result.kind === 'ok' && !this.#token) return { kind: 'lost', reason: 'ANSWER' };
    return result;
  }

  /** Calls a method with the token, signing in first or again after an expired session. */
  async call(
    path: string,
    body: Record<string, unknown> | ((token: string) => Record<string, unknown>),
  ): Promise<WebkassaCallResult> {
    for (let round = 0; round < 2; round += 1) {
      if (!this.#token) {
        const auth = await this.authorize();
        if (auth.kind !== 'ok') return auth;
      }
      const token = this.#token!;
      const payload = typeof body === 'function' ? body(token) : { Token: token, ...body };
      const result = await this.#post(path, payload);
      if (
        result.kind === 'refused' &&
        result.errors.some(
          (e) =>
            e.code === WEBKASSA_CODE.SESSION_EXPIRED || e.code === WEBKASSA_CODE.NOT_AUTHORIZED,
        )
      ) {
        this.#token = null;
        continue;
      }
      return result;
    }
    return { kind: 'lost', reason: 'ANSWER' };
  }

  /** Issues a sale or refund check. A repeat of the same external number is resolved, not doubled. */
  async issue(check: FiscalCheck): Promise<WebkassaIssueResult> {
    const result = await this.call('api/v4/check', (token) =>
      checkBody(token, this.#account.cashboxUniqueNumber, check),
    );
    if (result.kind === 'ok') {
      const receipt = issuedFrom(result.data, false);
      return receipt ? { kind: 'issued', receipt } : { kind: 'lost' };
    }
    if (result.kind === 'refused') {
      // The same external number again: Webkassa names the receipt it already made under it.
      if (result.errors.some((e) => e.code === WEBKASSA_CODE.DUPLICATE_EXTERNAL)) {
        const checkNumber = str(result.top.CheckNumber);
        return checkNumber
          ? {
              kind: 'issued',
              receipt: {
                checkNumber,
                dateTime: '',
                offline: false,
                shiftNumber: null,
                ticketUrl: null,
                registrationNumber: null,
                duplicate: true,
              },
            }
          : { kind: 'lost' };
      }
      return { kind: 'refused', errors: result.errors };
    }
    return result.kind === 'unreachable' ? { kind: 'unreachable' } : { kind: 'lost' };
  }

  /** Ticket/PrintFormat for 80 mm paper: the lines to print, QR as a line of type 2. */
  async printFormat(externalNumber: string): Promise<WebkassaPrintLine[] | null> {
    const result = await this.call('api/v4/Ticket/PrintFormat', {
      CashboxUniqueNumber: this.#account.cashboxUniqueNumber,
      ExternalCheckNumber: externalNumber,
      PaperKind: 0,
    });
    if (result.kind !== 'ok' || !Array.isArray(result.data.Lines)) return null;
    return (result.data.Lines as unknown[])
      .flatMap((line) => {
        if (!line || typeof line !== 'object') return [];
        const l = line as Record<string, unknown>;
        if (typeof l.Value !== 'string') return [];
        return [
          {
            order: typeof l.Order === 'number' ? l.Order : 0,
            type: typeof l.Type === 'number' ? l.Type : 0,
            value: l.Value.slice(0, 600),
            style: typeof l.Style === 'number' ? l.Style : 0,
          },
        ];
      })
      .sort((a, b) => a.order - b.order)
      .slice(0, 400);
  }

  /** X-report (no shift close). */
  async xReport(): Promise<WebkassaCallResult> {
    return this.call('api/v4/XReport', { CashboxUniqueNumber: this.#account.cashboxUniqueNumber });
  }

  /** Z-report: closes the Webkassa shift. */
  async zReport(): Promise<WebkassaCallResult> {
    return this.call('api/v4/ZReport', { CashboxUniqueNumber: this.#account.cashboxUniqueNumber });
  }
}

/**
 * Reads the private account file (EDGE_WEBKASSA_ACCOUNT_FILE): JSON {baseUrl, apiKey, login,
 * password, cashboxUniqueNumber}. Absent path = Webkassa off (manual mode). The file never enters
 * git, logs or the database.
 */
export function readWebkassaAccount(path: string | undefined): WebkassaAccount | null {
  if (!path) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Record<
    string,
    unknown
  >;
  const field = (name: string, pattern: RegExp): string => {
    const value = raw[name];
    if (typeof value !== 'string' || !pattern.test(value))
      throw new Error(`Webkassa account file: invalid ${name}`);
    return value;
  };
  return {
    baseUrl: field('baseUrl', /^https:\/\/(devkkm|kkm)\.webkassa\.kz\/?$/),
    apiKey: field('apiKey', /^\S{8,200}$/),
    login: field('login', /^\S{3,200}$/),
    password: field('password', /^.{1,200}$/),
    cashboxUniqueNumber: field('cashboxUniqueNumber', /^SWK\d{8}$/),
  };
}
