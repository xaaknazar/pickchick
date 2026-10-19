import { cloudChannelOrder } from './cloud-channel.js';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { transaction } from '@pickchick/database';
import type { DatabasePool } from '@pickchick/database';
import { CommerceRepository } from './repository.js';
import { UUIDSchema } from './model.js';
import {
  assertBranchItemsAvailable,
  snapshotAvailabilityItems,
  AvailabilityError,
} from './availability.js';

/**
 * Kaspi remote invoice (счёт на номер телефона) through a private local bridge
 * (tapter-dev/kaspi-pos-automation). The bridge acts as a Kaspi Pay cashier
 * session; it is NOT an official Kaspi API. Everything here treats its answers
 * conservatively: only an explicit `Processed` status is money, only explicit
 * cancel/reject/expire is a failure, anything else stays pending or unknown.
 */
export const KASPI_REMOTE_PROVIDER = 'kaspi-remote';

export class KaspiRemoteError extends Error {
  constructor(public readonly code: 'DISABLED' | 'INVALID' | 'SIGNATURE') {
    super(code);
  }
}

export interface KaspiRemoteSession {
  tokenSN: string;
  vtokenSecret: string;
  profileId: string;
}
export interface KaspiRemoteConfig {
  bridgeUrl: string;
  webhookSecret: string;
  accountId: string;
  invoiceTtlSeconds: number;
  requestTimeoutMs: number;
  session: KaspiRemoteSession | null;
  /**
   * KASPI_REMOTE_PENDING_MAX_AGE_SECONDS (default 600): a payment attempt that was never sent
   * to the bank within this age fails as invoice_not_sent. No invoice, no money.
   */
  pendingMaxAgeSeconds?: number;
}
/** Default maximum age of a never-sent attempt (PM decision 2026-10-19: 10 minutes). */
export const KASPI_PENDING_MAX_AGE_SECONDS = 600;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Disabled unless KASPI_REMOTE_ENABLED=true. The bridge must be a loopback URL:
 * its session headers grant full cashier access and never leave the host.
 * A missing session keeps webhook verification working but issues nothing.
 */
export function kaspiRemoteConfig(env: NodeJS.ProcessEnv): KaspiRemoteConfig | null {
  if (env.KASPI_REMOTE_ENABLED === undefined || env.KASPI_REMOTE_ENABLED === 'false') return null;
  if (env.KASPI_REMOTE_ENABLED !== 'true') throw new KaspiRemoteError('INVALID');
  let bridge: URL;
  try {
    bridge = new URL(env.KASPI_BRIDGE_URL ?? '');
  } catch {
    throw new KaspiRemoteError('INVALID');
  }
  const secret = env.KASPI_BRIDGE_WEBHOOK_SECRET ?? '';
  const accountId = env.KASPI_REMOTE_ACCOUNT_ID ?? '';
  const ttl = Number(env.KASPI_INVOICE_TTL_SECONDS ?? '180');
  const pendingMaxAge = Number(
    env.KASPI_REMOTE_PENDING_MAX_AGE_SECONDS ?? String(KASPI_PENDING_MAX_AGE_SECONDS),
  );
  if (
    !Number.isInteger(pendingMaxAge) ||
    pendingMaxAge < 60 ||
    pendingMaxAge > 86_400 ||
    bridge.protocol !== 'http:' ||
    !LOOPBACK.has(bridge.hostname) ||
    bridge.username ||
    bridge.password ||
    bridge.search ||
    bridge.hash ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(secret) ||
    !UUIDSchema.safeParse(accountId).success ||
    !Number.isInteger(ttl) ||
    ttl < 120 ||
    ttl > 86_400
  )
    throw new KaspiRemoteError('INVALID');
  const tokenSN = env.KASPI_SESSION_TOKEN_SN ?? '';
  const vtokenSecret = env.KASPI_SESSION_VTOKEN_SECRET ?? '';
  const profileId = env.KASPI_SESSION_PROFILE_ID ?? '';
  let session: KaspiRemoteSession | null = null;
  if (tokenSN || vtokenSecret || profileId) {
    if (
      !/^[A-Za-z0-9+/=._:-]{8,512}$/.test(tokenSN) ||
      !/^[A-Za-z0-9+/=._:-]{16,2048}$/.test(vtokenSecret) ||
      !/^[A-Za-z0-9-]{1,64}$/.test(profileId)
    )
      throw new KaspiRemoteError('INVALID');
    session = { tokenSN, vtokenSecret, profileId };
  }
  return {
    bridgeUrl: bridge.toString().replace(/\/+$/, ''),
    webhookSecret: secret,
    accountId,
    invoiceTtlSeconds: ttl,
    requestTimeoutMs: 15_000,
    session,
    pendingMaxAgeSeconds: pendingMaxAge,
  };
}

/** E.164 Kazakhstan mobile (+77XXXXXXXXX) → the bridge format 77XXXXXXXXX. */
export function kaspiPhone(e164: string): string | null {
  const match = /^\+7(7[0-9]{9})$/.exec(e164);
  return match ? '7' + match[1] : null;
}

export type KaspiOutcome = 'captured' | 'failed' | 'pending' | 'unknown';
const FAILED_STATUSES = new Set(['RemotePaymentCanceled', 'RemotePaymentRejected', 'Expired']);
/** Only statuses observed in the bridge source; everything unrecognised is unknown, never failure. */
export function kaspiInvoiceOutcome(status: unknown): KaspiOutcome {
  if (status === 'Processed') return 'captured';
  if (typeof status === 'string' && FAILED_STATUSES.has(status)) return 'failed';
  if (status === 'RemotePaymentCreated') return 'pending';
  return 'unknown';
}

/** Numeric API amounts or Kaspi's displayed KZT amount → exact tiyn string. */
export function kaspiMinor(amount: unknown): string | null {
  let text = typeof amount === 'number' ? String(amount) : amount;
  if (typeof text === 'string' && text.endsWith('₸')) {
    // Payment details return e.g. "100 ₸". Validate grouping/currency before
    // normalization; never strip arbitrary non-digits from a bank amount.
    const display =
      /^((?:0|[1-9][0-9]{0,12}|[1-9][0-9]{0,2}(?:[ \u00a0\u202f][0-9]{3}){1,4})(?:[.,][0-9]{1,2})?)[ \u00a0\u202f]₸$/.exec(
        text,
      );
    if (!display) return null;
    text = display[1]!.replace(/[ \u00a0\u202f]/g, '').replace(',', '.');
  }
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  return minor > 0n ? minor.toString() : null;
}

/**
 * The bridge signs `sha256=<hex HMAC of the raw body>`. The webhook is only a
 * hint to check sooner: its status is re-read from Kaspi before anything changes.
 */
export function verifyKaspiBridgeWebhook(
  raw: Buffer,
  signature: string | undefined,
  secret: string,
): { operationId: string } {
  if (!raw.length || raw.length > 64 * 1024) throw new KaspiRemoteError('INVALID');
  const match = /^sha256=([a-f0-9]{64})$/.exec(signature ?? '');
  if (!match || !secret) throw new KaspiRemoteError('SIGNATURE');
  const actual = Buffer.from(match[1]!, 'hex');
  const expected = createHmac('sha256', secret).update(raw).digest();
  if (!timingSafeEqual(actual, expected)) throw new KaspiRemoteError('SIGNATURE');
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new KaspiRemoteError('INVALID');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new KaspiRemoteError('INVALID');
  const value = body as { type?: unknown; paymentId?: unknown };
  const id = typeof value.paymentId === 'number' ? String(value.paymentId) : value.paymentId;
  if (value.type !== 'invoice' || typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id))
    throw new KaspiRemoteError('INVALID');
  return { operationId: id };
}

// ─── Bridge client ───

export type BridgeResult =
  | { kind: 'ok'; data: Record<string, unknown> }
  /** Kaspi answered with an error code: the operation was not performed. */
  | { kind: 'rejected'; statusCode: number }
  /** Cashier session missing, invalid or evicted: nothing was performed. */
  | { kind: 'session' }
  /** The bridge could not be reached at all: nothing was sent. */
  | { kind: 'unsent' }
  /** Timeout, bridge error or malformed answer: Kaspi may have performed it. */
  | { kind: 'uncertain' };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
const SESSION_EVICTED = -101001;

/** Result of the read-only session probe. Never contains session values. */
export type KaspiSessionStatus = 'active' | 'inactive' | 'unreachable' | 'missing';

/** What the invoice worker needs from the bridge (KaspiBridgeClient or a test double). */
export interface KaspiRemoteBridge {
  checkSession(): Promise<boolean>;
  /** Optional detailed probe; without it the worker falls back to checkSession(). */
  sessionStatus?(): Promise<KaspiSessionStatus>;
  createInvoice(phone: string, amountTenge: number, comment: string): Promise<BridgeResult>;
  details(operationId: string): Promise<BridgeResult>;
  cancel(operationId: string): Promise<BridgeResult>;
  history(maxResult?: number): Promise<BridgeResult>;
}

export class KaspiBridgeClient implements KaspiRemoteBridge {
  constructor(
    private readonly config: Pick<KaspiRemoteConfig, 'bridgeUrl' | 'requestTimeoutMs' | 'session'>,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  /** Read-only cashier authentication probe; never creates an invoice. */
  async checkSession(): Promise<boolean> {
    return (await this.sessionStatus()) === 'active';
  }

  /** Same probe with a short reason for alerts: inactive session or unreachable bridge. */
  async sessionStatus(): Promise<KaspiSessionStatus> {
    const session = this.config.session;
    if (!session) return 'missing';
    try {
      const response = await this.fetcher(this.config.bridgeUrl + '/api/session/check', {
        method: 'GET',
        headers: {
          'X-Token-SN': session.tokenSN,
          'X-Vtoken-Secret': session.vtokenSecret,
          'X-Profile-Id': session.profileId,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(this.config.requestTimeoutMs, 10000)),
      });
      if (response.status >= 500) return 'unreachable';
      if (!response.ok) return 'inactive';
      const value: unknown = await response.json();
      return typeof value === 'object' &&
        value !== null &&
        'active' in value &&
        value.active === true
        ? 'active'
        : 'inactive';
    } catch {
      return 'unreachable';
    }
  }

  createInvoice(phone: string, amountTenge: number, comment: string) {
    return this.call('POST', '/api/invoice/create', {
      phoneNumber: phone,
      amount: amountTenge,
      comment,
    });
  }
  details(operationId: string) {
    return this.call('GET', '/api/invoice/details?operationId=' + operationId);
  }
  cancel(operationId: string) {
    return this.call('POST', '/api/invoice/cancel', { operationId }, true);
  }
  /** maxResult is honoured only by the PickChick-patched bridge (upstream: last 20). */
  history(maxResult = 200) {
    return this.call('POST', '/api/invoice/history', { maxResult });
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    emptyDataIsOk = false,
  ): Promise<BridgeResult> {
    const session = this.config.session;
    if (!session) return { kind: 'session' };
    const headers: Record<string, string> = {
      'X-Token-SN': session.tokenSN,
      'X-Vtoken-Secret': session.vtokenSecret,
      'X-Profile-Id': session.profileId,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetcher(this.config.bridgeUrl + path, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (error) {
      // Only a refused local connection proves that no request left this host.
      const code = (error as { cause?: { code?: unknown } }).cause?.code;
      return code === 'ECONNREFUSED' ? { kind: 'unsent' } : { kind: 'uncertain' };
    }
    // The bridge rejects missing/undecryptable session headers before calling Kaspi.
    if (response.status === 401) return { kind: 'session' };
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { kind: 'uncertain' };
    }
    if (!response.ok || typeof json !== 'object' || json === null) return { kind: 'uncertain' };
    const value = json as { StatusCode?: unknown; Data?: unknown };
    if (value.StatusCode === SESSION_EVICTED) return { kind: 'session' };
    if (typeof value.StatusCode === 'number' && value.StatusCode !== 0)
      return { kind: 'rejected', statusCode: value.StatusCode };
    if (
      value.StatusCode === 0 &&
      emptyDataIsOk &&
      (value.Data === undefined || value.Data === null)
    )
      return { kind: 'ok', data: {} };
    if (value.StatusCode !== 0 || typeof value.Data !== 'object' || value.Data === null)
      return { kind: 'uncertain' };
    return { kind: 'ok', data: value.Data as Record<string, unknown> };
  }
}

function operationIdOf(data: Record<string, unknown>): string | null {
  for (const key of ['QrOperationId', 'OperationId', 'Id']) {
    const raw = data[key];
    const id = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw;
    if (typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id)) return id;
  }
  return null;
}

// Application-side budget, not a documented bank limit. Never include customer data.
const INVOICE_COMMENT_MAX_LENGTH = 255;
const InvoiceItemsSchema = z.object({
  lines: z.array(
    z.object({
      title: z.string(),
      quantity: z.number().int().positive(),
      selectedDetails: z
        .object({
          modifiers: z.array(
            z.object({
              label: z.object({ ru: z.string() }),
              quantity: z.number().int().positive(),
            }),
          ),
        })
        .optional(),
    }),
  ),
});
const cleanName = (value: string) =>
  value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
function fitMessage(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let result = '';
  for (const character of value) {
    if (result.length + character.length > limit - 1) break;
    result += character;
  }
  return result.trimEnd() + '…';
}
export function kaspiInvoiceComment(displayNumber: string | null, snapshot: unknown): string {
  const parsed = InvoiceItemsSchema.safeParse(snapshot);
  if (!parsed.success || !parsed.data.lines.length) throw new KaspiRemoteError('INVALID');
  if (displayNumber !== null && !/^[1-9][0-9]{0,18}$/.test(displayNumber))
    throw new KaspiRemoteError('INVALID');
  // Older edge nodes may not reserve a number until preparation is authorized.
  const prefix = displayNumber === null ? '' : `Заказ №${displayNumber}: `;
  const parts: string[] = [];
  for (const [index, line] of parsed.data.lines.entries()) {
    const name = fitMessage(cleanName(line.title) || 'Позиция', 100);
    const modifiers =
      line.selectedDetails?.modifiers
        .map((m) => `${cleanName(m.label.ru)}${m.quantity > 1 ? ` - ${m.quantity} шт.` : ''}`)
        .filter(Boolean) ?? [];
    const item = `${name} - ${line.quantity} шт.${modifiers.length ? ` (${modifiers.join(', ')})` : ''}`;
    const remaining = parsed.data.lines.length - index - 1;
    const suffix = remaining ? `; ещё ${remaining} поз.` : '';
    const used = prefix.length + parts.join('; ').length + (parts.length ? 2 : 0);
    if (used + item.length + suffix.length > INVOICE_COMMENT_MAX_LENGTH) {
      if (parts.length) return `${prefix}${parts.join('; ')}; ещё ${remaining + 1} поз.`;
      return (
        prefix +
        fitMessage(item, INVOICE_COMMENT_MAX_LENGTH - prefix.length - suffix.length) +
        suffix
      );
    }
    parts.push(item);
  }
  return prefix + parts.join('; ');
}

/** Exact persisted message only; order number alone is never sufficient. */
export function findByInvoiceComment(data: unknown, comment: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const walk = (node: unknown, depth: number) => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 500)) walk(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>,
      id = operationIdOf(record);
    // Duplicate records can disagree about amount/time. Keep them ambiguous.
    if (id && record.Comment === comment) found.push(record);
    else for (const value of Object.values(record)) walk(value, depth + 1);
  };
  walk(data, 0);
  return found;
}

/** Invoices in a history answer whose text fields mention the reference. */
export function findByReference(data: unknown, reference: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const walk = (node: unknown, depth: number) => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 500)) walk(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    const mentions = Object.values(record).some(
      (v) =>
        typeof v === 'string' &&
        (v.trim() === `PickChick ${reference}` || v.trim().startsWith(`PickChick ${reference}: `)),
    );
    if (mentions && operationIdOf(record)) found.push(record);
    else for (const v of Object.values(record)) walk(v, depth + 1);
  };
  walk(data, 0);
  return found;
}

// ─── Processor ───

/** A signed bridge notification only moves the next status check forward. */
export async function hintKaspiInvoice(
  pool: DatabasePool,
  accountId: string,
  operationId: string,
): Promise<boolean> {
  const updated = await pool.query(
    `UPDATE commerce_kaspi_invoices SET next_check_at=LEAST(next_check_at,clock_timestamp())
     WHERE operation_id=$1 AND account_id=$2 AND state IN ('issued','unknown')`,
    [operationId, accountId],
  );
  return (updated.rowCount ?? 0) > 0;
}

export type PhoneResolver = (customerId: string) => Promise<string | null>;
interface InvoiceRow {
  attempt_id: string;
  order_id: string;
  account_id: string;
  amount_minor: string;
  state: 'issuing' | 'issued' | 'paid' | 'failed' | 'unknown';
  state_changed_at: Date;
  reference: string;
  invoice_comment: string | null;
  customer_id: string | null;
  operation_id: string | null;
  paid_minor: string | null;
  delivered_at: Date | null;
  lease_token: string | null;
  issue_started_at: Date;
  issued_at: Date | null;
  expires_at: Date | null;
  cancel_requested_at: Date | null;
  organization_id: string;
  branch_id: string;
  /** Edge admission state of the order; null for cloud channel orders. */
  fulfillment_state: string | null;
}
/** Short machine reason of a bank-level problem. Never contains session values. */
export type KaspiSessionReason =
  'session_inactive' | 'session_missing' | 'bridge_unreachable' | 'session_rejected';
export interface KaspiTickResult {
  submitted: number;
  checked: number;
  errors: number;
  /** The cashier session is not usable (preflight failed or the bank rejected it). */
  sessionProblem: boolean;
  sessionReason?: KaspiSessionReason;
  /** A previously failing session probe succeeded in this tick. */
  sessionRecovered?: boolean;
  /** Invoices whose existence is unknown for over 5 minutes: need manual check in Kaspi Pay. */
  unknownOverdue: number;
  /** Submissions left for a later tick: this order or the bank is not ready yet. */
  deferred: number;
  /** Never-sent attempts failed definitively in this tick (no invoice was created). */
  notSent: number;
  /** Pending attempts of this account still waiting to be sent, and the oldest age in seconds. */
  pendingUnsent: number;
  oldestUnsentSeconds: number;
}
/** Order-level reasons stored in the inbox event id of a never-sent failure. */
export type KaspiNotSentReason = 'invoice_not_sent' | 'order_not_held';
const ORDER_RELEASED = ['released', 'cancelled', 'cancel_requested'];
/** Seconds before an order-level deferral and a failed session probe are retried. */
const ORDER_RETRY_SECONDS = 5;
const SESSION_PROBE_RETRY_MS = 5_000;
const SESSION_REJECTED_RETRY_MS = 30_000;
/** Read-only re-probes while the session stays bad: 5 s, doubling up to once a minute. */
const SESSION_PROBE_MAX_RETRY_MS = 60_000;

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const reference = () =>
  Array.from({ length: 10 }, () => REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)]).join(
    '',
  );
const SELECT_ROW = `SELECT k.*,k.amount_minor::text amount_minor,k.paid_minor::text paid_minor,
  p.organization_id,p.branch_id,o.customer_id,
  (SELECT f.state FROM cloud_fulfillment_projection f WHERE f.order_id=k.order_id) fulfillment_state
  FROM commerce_kaspi_invoices k
  JOIN commerce_provider_accounts p ON p.id=k.account_id
  JOIN commerce_orders o ON o.id=k.order_id`;

type SubmissionEvent = { id: string; attempt_id: string; token: string };
type SubmitOutcome = 'done' | 'session' | 'deferred' | 'bank' | 'not_sent';

/** A customer waiting longer than this for "Отправляем счёт" is an operational problem. */
export const KASPI_UNSENT_ATTENTION_SECONDS = 120;
/**
 * Worker log signal for ops (TEAM interface pay -> ops): `kaspi_remote_attention` with
 * `sessionProblem` and a short reason code, at most once per interval while a problem lasts,
 * then exactly one recovery event. Contains only counts and codes: no phone, amount or session.
 */
export class KaspiAttention {
  private alertedAt: number | null = null;
  constructor(private readonly intervalMs = 5 * 60_000) {}
  next(result: KaspiTickResult, now = Date.now()): Record<string, unknown> | null {
    const reason = result.sessionProblem
      ? (result.sessionReason ?? 'session_inactive')
      : result.unknownOverdue > 0
        ? 'unknown_overdue'
        : result.oldestUnsentSeconds >= KASPI_UNSENT_ATTENTION_SECONDS
          ? 'invoice_not_sent'
          : result.errors > 0
            ? 'worker_errors'
            : null;
    if (reason === null) {
      if (this.alertedAt === null) return null;
      this.alertedAt = null;
      return { event: 'kaspi_remote_attention', recovered: true, sessionProblem: false };
    }
    if (this.alertedAt !== null && now - this.alertedAt < this.intervalMs) return null;
    this.alertedAt = now;
    return {
      event: 'kaspi_remote_attention',
      sessionProblem: result.sessionProblem,
      // Older log readers know this field; it means the same as sessionProblem.
      sessionRejected: result.sessionProblem,
      reason,
      unknownOverdue: result.unknownOverdue,
      errors: result.errors,
      pendingUnsent: result.pendingUnsent,
      oldestUnsentSeconds: result.oldestUnsentSeconds,
    };
  }
}

export class KaspiRemoteProcessor {
  private readonly repo: CommerceRepository;
  private readonly workerId = randomUUID();
  /** Bank-level problem: no new invoice is sent until a session probe succeeds again. */
  private sessionReason: KaspiSessionReason | null = null;
  private sessionRetryAt = 0;
  private failedProbes = 0;
  constructor(
    private readonly pool: DatabasePool,
    private readonly config: KaspiRemoteConfig,
    private readonly client: KaspiRemoteBridge,
    private readonly phone: PhoneResolver,
    private readonly now: () => Date = () => new Date(),
    private readonly guestPhone?: (orderId: string) => Promise<string | null>,
  ) {
    this.repo = new CommerceRepository(pool);
  }

  private get pendingMaxAgeMs() {
    return (this.config.pendingMaxAgeSeconds ?? KASPI_PENDING_MAX_AGE_SECONDS) * 1000;
  }

  /**
   * One worker iteration: fail never-sent attempts past their maximum age, issue new invoices,
   * then re-check due ones. An order that is not ready defers only itself; a bank-level problem
   * (session) pauses new invoices until a session probe succeeds again.
   */
  async tick(limit = 10): Promise<KaspiTickResult> {
    const result: KaspiTickResult = {
      submitted: 0,
      checked: 0,
      errors: 0,
      sessionProblem: false,
      unknownOverdue: 0,
      deferred: 0,
      notSent: 0,
      pendingUnsent: 0,
      oldestUnsentSeconds: 0,
    };
    // While the session is known bad, re-probe it on its own back-off (read-only, no invoice).
    let sessionReady: boolean | undefined;
    if (this.sessionReason && this.now().getTime() >= this.sessionRetryAt) {
      const before = this.sessionReason;
      sessionReady = await this.probeSession();
      if (sessionReady && before) result.sessionRecovered = true;
    }
    // Expired never-sent attempts fail even while the bank is down: nothing was sent, no money.
    for (const event of await this.claimSubmissions(limit, true)) {
      try {
        await this.failUnsent(event, 'invoice_not_sent');
        result.notSent++;
      } catch {
        result.errors++;
      }
    }
    const ensureSession = async () => {
      if (sessionReady === undefined) {
        const before = this.sessionReason;
        sessionReady = await this.probeSession();
        if (sessionReady && before) result.sessionRecovered = true;
      }
      return sessionReady;
    };
    for (let i = 0; i < limit && !this.sessionReason; i++) {
      const [event] = await this.claimSubmissions(1, false);
      if (!event) break;
      try {
        const outcome = await this.submit(event, ensureSession);
        if (outcome === 'deferred' || outcome === 'bank') {
          result.deferred++;
          if (outcome === 'bank') break;
          continue;
        }
        if (outcome === 'not_sent') {
          result.notSent++;
          continue;
        }
        if (outcome === 'session') this.sessionRejected();
      } catch {
        result.errors++;
      }
      result.submitted++;
    }
    for (let i = 0; i < limit; i++) {
      const [row] = await this.claimDue(1);
      if (!row) break;
      try {
        if ((await this.check(row)) === 'session') this.sessionRejected();
      } catch {
        result.errors++;
      }
      result.checked++;
    }
    result.unknownOverdue = await this.unknownOverdue();
    const unsent = await this.unsent();
    result.pendingUnsent = unsent.count;
    result.oldestUnsentSeconds = unsent.oldestSeconds;
    result.sessionProblem = this.sessionReason !== null;
    if (this.sessionReason) result.sessionReason = this.sessionReason;
    return result;
  }

  /** Read-only probe. Success clears a bank-level problem; failure backs off before the next. */
  private async probeSession(): Promise<boolean> {
    const status: KaspiSessionStatus = this.client.sessionStatus
      ? await this.client.sessionStatus()
      : (await this.client.checkSession())
        ? 'active'
        : 'inactive';
    if (status === 'active') {
      this.sessionReason = null;
      this.sessionRetryAt = 0;
      this.failedProbes = 0;
      return true;
    }
    this.sessionReason =
      status === 'unreachable'
        ? 'bridge_unreachable'
        : status === 'missing'
          ? 'session_missing'
          : 'session_inactive';
    this.sessionRetryAt =
      this.now().getTime() +
      Math.min(SESSION_PROBE_RETRY_MS * 2 ** this.failedProbes, SESSION_PROBE_MAX_RETRY_MS);
    this.failedProbes++;
    return false;
  }

  /** The bank refused the session on a real call: pause new invoices, re-probe later. */
  private sessionRejected() {
    this.sessionReason = 'session_rejected';
    this.sessionRetryAt = this.now().getTime() + SESSION_REJECTED_RETRY_MS;
  }

  private async unsent(): Promise<{ count: number; oldestSeconds: number }> {
    const { rows } = await this.pool.query<{ count: number; oldest: Date | null }>(
      `SELECT count(*)::int count,min(a.created_at) oldest FROM commerce_outbox e
       JOIN commerce_payment_attempts a ON a.id=(e.payload->>'attemptId')::uuid AND a.order_id=e.order_id
       WHERE e.event_type='payment.submit_requested' AND e.acknowledged_at IS NULL
         AND (e.payload->>'accountId')::uuid=$1 AND a.account_id=$1 AND a.state='pending'`,
      [this.config.accountId],
    );
    const oldest = rows[0]?.oldest;
    return {
      count: rows[0]?.count ?? 0,
      oldestSeconds: oldest
        ? Math.max(0, Math.floor((this.now().getTime() - oldest.getTime()) / 1000))
        : 0,
    };
  }

  private async unknownOverdue(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) FROM commerce_kaspi_invoices WHERE account_id=$1
       AND state IN ('issuing','unknown') AND issue_started_at<clock_timestamp()-interval '5 minutes'`,
      [this.config.accountId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  hint(operationId: string) {
    return hintKaspiInvoice(this.pool, this.config.accountId, operationId);
  }

  /**
   * Lease unsent submissions. `expired` selects only never-sent attempts older than the maximum
   * age (any order or account state: they only fail). Otherwise the least-tried events go first,
   * so a deferred attempt never holds back newer ready ones (no head-of-line blocking).
   */
  private async claimSubmissions(limit: number, expired: boolean): Promise<SubmissionEvent[]> {
    const token = randomUUID();
    const cutoff = new Date(this.now().getTime() - this.pendingMaxAgeMs);
    const { rows } = await this.pool.query<{ id: string; attempt_id: string }>(
      `WITH selected AS (
        SELECT e.id FROM commerce_outbox e
        JOIN commerce_orders o ON o.id=e.order_id
        JOIN commerce_payment_attempts a ON a.id=(e.payload->>'attemptId')::uuid AND a.order_id=o.id
        JOIN commerce_provider_accounts p ON p.id=a.account_id
        WHERE e.event_type='payment.submit_requested' AND e.acknowledged_at IS NULL
          AND (e.lease_until IS NULL OR e.lease_until<clock_timestamp())
          AND p.id=$1 AND p.provider=$2 AND p.kind='payment'
          AND (e.payload->>'accountId')::uuid=p.id AND a.state='pending'
          AND (CASE WHEN $6::boolean
            THEN a.created_at<=$7::timestamptz
              AND NOT EXISTS(SELECT 1 FROM commerce_kaspi_invoices k WHERE k.attempt_id=a.id)
            ELSE p.enabled AND NOT o.attention_required
              AND NOT EXISTS(SELECT 1 FROM commerce_cancellation_intents i WHERE i.order_id=o.id) END)
        ORDER BY e.attempts,e.sequence LIMIT $3 FOR UPDATE OF e SKIP LOCKED)
      UPDATE commerce_outbox e SET lease_worker=$4,lease_token=$5,
        lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1
      FROM selected s WHERE e.id=s.id RETURNING e.id,e.payload->>'attemptId' attempt_id`,
      [this.config.accountId, KASPI_REMOTE_PROVIDER, limit, this.workerId, token, expired, cutoff],
    );
    return rows.map((row) => ({ ...row, token }));
  }

  private async acknowledge(event: { id: string; token: string }) {
    await this.pool.query(
      `UPDATE commerce_outbox SET acknowledged_at=COALESCE(acknowledged_at,clock_timestamp())
       WHERE id=$1 AND lease_worker=$2 AND lease_token=$3`,
      [event.id, this.workerId, event.token],
    );
  }

  /** Defer only this submission; other ready orders keep being served in the same tick. */
  private async deferSubmission<T extends 'deferred' | 'bank'>(
    event: { id: string; token: string },
    seconds: number,
    outcome: T,
  ): Promise<T> {
    await this.pool.query(
      `UPDATE commerce_outbox SET lease_until=clock_timestamp()+$4*interval '1 second'
       WHERE id=$1 AND lease_worker=$2 AND lease_token=$3`,
      [event.id, this.workerId, event.token, seconds],
    );
    return outcome;
  }

  private expired(createdAt: Date) {
    return createdAt.getTime() <= this.now().getTime() - this.pendingMaxAgeMs;
  }

  /**
   * Definite failure of an attempt that was never sent to Kaspi (no invoice row exists). The
   * reason is kept in the durable inbox event id; a held combo gift is released by the same
   * ledger rule as any other failed payment.
   */
  private async failUnsent(event: SubmissionEvent, reason: KaspiNotSentReason) {
    const row = (
      await this.pool.query<{ organization_id: string; branch_id: string }>(
        `SELECT p.organization_id,p.branch_id FROM commerce_payment_attempts a
         JOIN commerce_provider_accounts p ON p.id=a.account_id
         WHERE a.id=$1 AND a.account_id=$2 AND a.state='pending'
           AND NOT EXISTS(SELECT 1 FROM commerce_kaspi_invoices k WHERE k.attempt_id=a.id)`,
        [event.attempt_id, this.config.accountId],
      )
    ).rows[0];
    if (row)
      await this.repo.observePayment(
        {
          organizationId: row.organization_id,
          branchId: row.branch_id,
          accountId: this.config.accountId,
        },
        {
          eventId: `kaspi-remote:${event.attempt_id}:not-sent:${reason}`,
          attemptId: event.attempt_id,
          outcome: 'failed',
          occurredAt: this.now().toISOString(),
        },
      );
    await this.acknowledge(event);
  }

  private async cloudChannelAttempt(attemptId: string) {
    const order = (
      await this.pool.query<{ order_id: string }>(
        'SELECT order_id FROM commerce_payment_attempts WHERE id=$1',
        [attemptId],
      )
    ).rows[0];
    return order ? (await cloudChannelOrder(this.pool, order.order_id)) !== null : false;
  }

  private async itemsAvailable(source: { branch_id: string; snapshot: unknown }) {
    try {
      await assertBranchItemsAvailable(
        this.pool,
        source.branch_id,
        snapshotAvailabilityItems(source.snapshot),
      );
      return true;
    } catch (error) {
      if (error instanceof AvailabilityError) return false;
      throw error;
    }
  }

  private async submit(
    event: SubmissionEvent,
    sessionReady: () => Promise<boolean>,
  ): Promise<SubmitOutcome> {
    const existing = await this.row(event.attempt_id);
    // A cloud channel order (ADR-0014 S4) has no edge reservation; it is ready without one.
    const cloud = await this.cloudChannelAttempt(event.attempt_id);
    const source = (
      await this.pool.query<{
        snapshot: unknown;
        display_number: string | null;
        branch_id: string;
        created_at: Date;
        ready: boolean;
        released: boolean;
      }>(
        `SELECT o.snapshot,o.branch_id,p.display_number::text,a.created_at,
         (b.ordering_enabled AND NOT o.attention_required AND t.active AND d.status='active'
          AND ((p.state='held' AND p.device_id=o.admission_device_id
          AND p.device_id=t.device_id AND p.reservation_id=o.admission_reservation_id)
           OR ($3::boolean AND p.order_id IS NULL AND o.admission_reservation_id IS NULL))
          AND NOT EXISTS(SELECT 1 FROM commerce_cancellation_intents c WHERE c.order_id=o.id)) ready,
         COALESCE(p.state=ANY($4::text[]),false) released
       FROM commerce_payment_attempts a
       JOIN commerce_orders o ON o.id=a.order_id
       JOIN branches b ON b.id=o.branch_id
       LEFT JOIN fulfillment_transport_bindings t ON t.branch_id=o.branch_id
       LEFT JOIN devices d ON d.id=t.device_id
       LEFT JOIN cloud_fulfillment_projection p ON p.order_id=o.id
       WHERE a.id=$1 AND a.account_id=$2`,
        [event.attempt_id, this.config.accountId, cloud, ORDER_RELEASED],
      )
    ).rows[0];
    if (!source) throw new KaspiRemoteError('INVALID');
    if (!existing) {
      // Never send an invoice for an abandoned attempt: past its maximum age it fails.
      if (this.expired(source.created_at)) {
        await this.failUnsent(event, 'invoice_not_sent');
        return 'not_sent';
      }
      // The restaurant released or cancelled the held order: it can never become payable.
      if (source.released) {
        await this.failUnsent(event, 'order_not_held');
        return 'not_sent';
      }
      // Order-level readiness first: a blocked order defers itself without probing the bank.
      if (!source.ready || !(await this.itemsAvailable(source)))
        return this.deferSubmission(event, ORDER_RETRY_SECONDS, 'deferred');
      if (!(await sessionReady()))
        return this.deferSubmission(event, Math.ceil(SESSION_PROBE_RETRY_MS / 1000), 'bank');
      // Re-check after the bank probe: freshness can expire while checking Kaspi.
      if (!(await this.itemsAvailable(source)))
        return this.deferSubmission(event, ORDER_RETRY_SECONDS, 'deferred');
    }
    const comment = kaspiInvoiceComment(source.display_number, source.snapshot);
    // Persist the exact message before sending. Recovery verifies bank metadata
    // against this attempt rather than issuing another invoice. An attempt past its maximum
    // age is never inserted, even if this worker was slow.
    const { rows } = await this.pool.query<{
      attempt_id: string;
      customer_id: string | null;
    }>(
      `INSERT INTO commerce_kaspi_invoices(attempt_id,order_id,account_id,amount_minor,state,reference,invoice_comment)
       SELECT a.id,a.order_id,a.account_id,a.intended_minor,'issuing',$3,$4
       FROM commerce_payment_attempts a
       WHERE a.id=$1 AND a.account_id=$2 AND a.state='pending' AND a.intended_minor%100=0
         AND a.created_at>$5::timestamptz
       ON CONFLICT(attempt_id) DO NOTHING
       RETURNING attempt_id,(SELECT customer_id FROM commerce_orders WHERE id=order_id) customer_id`,
      [
        event.attempt_id,
        this.config.accountId,
        reference(),
        comment,
        new Date(this.now().getTime() - this.pendingMaxAgeMs),
      ],
    );
    const created = rows[0];
    if (!created) {
      const existing = await this.row(event.attempt_id);
      if (!existing && this.expired(source.created_at)) {
        await this.failUnsent(event, 'invoice_not_sent');
        return 'not_sent';
      }
      // Tiyn amounts cannot be invoiced in whole tenge: fail the attempt explicitly.
      if (!existing) await this.observeWithoutInvoice(event.attempt_id);
      await this.acknowledge(event);
      return 'done';
    }
    const row = (await this.row(created.attempt_id))!;
    // A lookup failure means nothing was sent to Kaspi: a definite, retryable failure.
    const phone = created.customer_id
      ? await this.phone(created.customer_id).catch(() => null)
      : ((await this.guestPhone?.(row.order_id).catch(() => null)) ?? null);
    const formatted = phone ? kaspiPhone(phone) : null;
    if (!formatted) {
      await this.transition(row, 'failed', {});
      await this.acknowledge(event);
      return 'done';
    }
    const amount = Number(BigInt(row.amount_minor) / 100n);
    const answer = await this.client.createInvoice(formatted, amount, row.invoice_comment!);
    let status: 'done' | 'session' = 'done';
    if (answer.kind === 'ok' && operationIdOf(answer.data)) {
      await this.transition(row, 'issued', {
        operationId: operationIdOf(answer.data)!,
        remoteStatus: answer.data.Status,
      });
    } else if (answer.kind === 'ok' || answer.kind === 'uncertain') {
      await this.transition(row, 'unknown', {});
    } else {
      if (answer.kind === 'session') status = 'session';
      await this.transition(row, 'failed', {});
    }
    await this.acknowledge(event);
    return status;
  }

  private async observeWithoutInvoice(attemptId: string) {
    const { rows } = await this.pool.query<{
      organization_id: string;
      branch_id: string;
      created_at: Date;
    }>(
      `SELECT p.organization_id,p.branch_id,a.created_at FROM commerce_payment_attempts a
       JOIN commerce_provider_accounts p ON p.id=a.account_id
       WHERE a.id=$1 AND a.account_id=$2 AND a.state='pending' AND a.intended_minor%100<>0`,
      [attemptId, this.config.accountId],
    );
    const row = rows[0];
    if (!row) return;
    await this.repo.observePayment(
      {
        organizationId: row.organization_id,
        branchId: row.branch_id,
        accountId: this.config.accountId,
      },
      {
        eventId: `kaspi-remote:${attemptId}:not-invoiceable`,
        attemptId,
        outcome: 'failed',
        occurredAt: row.created_at.toISOString(),
      },
    );
  }

  private async claimDue(limit: number): Promise<InvoiceRow[]> {
    // A separate lease: a webhook hint may move next_check_at but never frees a row
    // that another worker is checking. A crashed worker's rows return in 60s.
    const token = randomUUID();
    const { rows } = await this.pool.query<{ attempt_id: string }>(
      `UPDATE commerce_kaspi_invoices SET lease_until=clock_timestamp()+interval '60 seconds',lease_token=$3,checks=checks+1
       WHERE attempt_id IN (SELECT attempt_id FROM commerce_kaspi_invoices
         WHERE account_id=$1 AND (state IN ('issuing','issued','unknown') OR delivered_at IS NULL) AND next_check_at<=clock_timestamp()
           AND (lease_until IS NULL OR lease_until<clock_timestamp())
           AND (state<>'issuing' OR issue_started_at<clock_timestamp()-interval '60 seconds')
         ORDER BY next_check_at LIMIT $2 FOR UPDATE SKIP LOCKED)
       RETURNING attempt_id`,
      [this.config.accountId, limit, token],
    );
    const loaded = await Promise.all(rows.map((r) => this.row(r.attempt_id)));
    return loaded.filter((r): r is InvoiceRow => r !== null && r.lease_token === token);
  }

  private async row(attemptId: string): Promise<InvoiceRow | null> {
    const { rows } = await this.pool.query<InvoiceRow>(`${SELECT_ROW} WHERE k.attempt_id=$1`, [
      attemptId,
    ]);
    return rows[0] ?? null;
  }

  /** Re-check one invoice. Always re-delivers its current outcome (idempotent inbox). */
  private async check(row: InvoiceRow): Promise<'done' | 'session'> {
    if (row.state === 'paid' || row.state === 'failed') {
      await this.deliver(row);
      return this.later(row, 3, 'done');
    }
    if (row.state === 'issuing' || row.state === 'unknown') {
      const history = await this.client.history(200);
      if (history.kind === 'session') return this.later(row, 60, 'session');
      if (history.kind === 'ok') {
        // The readable message repeats across days (order numbers restart, cloud orders have
        // none). Only another attempt whose send window overlaps this one is ambiguous; never
        // guess, reissue, or credit another invoice in that case.
        const start = row.issue_started_at.getTime();
        const sentInWindow = (record: Record<string, unknown>) => {
          const rawDate = record.OrderRegDate;
          const at =
            typeof rawDate === 'string' &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(rawDate)
              ? Date.parse(rawDate)
              : NaN;
          return (
            Number.isFinite(at) &&
            at >= start - 5000 &&
            at <= start + this.config.requestTimeoutMs + 5000
          );
        };
        const overlap = this.config.requestTimeoutMs + 10_000;
        const uniqueComment =
          row.invoice_comment === null ||
          (
            await this.pool.query(
              `SELECT 1 FROM commerce_kaspi_invoices WHERE account_id=$1 AND invoice_comment=$2 AND attempt_id<>$3
               AND issue_started_at BETWEEN $4::timestamptz-$5*interval '1 millisecond'
                 AND $4::timestamptz+$5*interval '1 millisecond' LIMIT 1`,
              [row.account_id, row.invoice_comment, row.attempt_id, row.issue_started_at, overlap],
            )
          ).rowCount === 0;
        const matches = !uniqueComment
          ? []
          : row.invoice_comment === null
            ? findByReference(history.data, row.reference)
            : // Older bank records with the same text were sent at another time: not ours.
              findByInvoiceComment(history.data, row.invoice_comment).filter(sentInWindow);
        const match = matches.length === 1 ? matches[0]! : null;
        const amount = match ? kaspiMinor(match.Amount) : null;
        let identityMatches = row.invoice_comment === null;
        if (match && row.invoice_comment !== null) {
          if (sentInWindow(match)) {
            const phone = row.customer_id
              ? await this.phone(row.customer_id).catch(() => null)
              : ((await this.guestPhone?.(row.order_id).catch(() => null)) ?? null);
            const details = await this.client.details(operationIdOf(match)!);
            if (details.kind === 'session') return this.later(row, 60, 'session');
            const bankMobile =
              details.kind === 'ok' && typeof details.data.ClientMobile === 'string'
                ? details.data.ClientMobile.replace(/[ ()+-]/g, '')
                : '';
            const normalized = /^8\d{10}$/.test(bankMobile)
              ? '7' + bankMobile.slice(1)
              : bankMobile;
            identityMatches =
              !!phone &&
              normalized === kaspiPhone(phone) &&
              details.kind === 'ok' &&
              operationIdOf(details.data) === operationIdOf(match) &&
              kaspiMinor(details.data.Amount) === row.amount_minor;
          }
        }
        if (match && amount === row.amount_minor && identityMatches) {
          await this.transition(row, 'issued', {
            operationId: operationIdOf(match)!,
            remoteStatus: match.Status,
          });
          return 'done';
        }
      }
      if (row.state === 'issuing') await this.transition(row, 'unknown', {});
      else await this.deliver(row);
      return this.later(row, this.backoff(row), 'done');
    }
    await this.deliver(row);
    const answer = await this.client.details(row.operation_id!);
    if (answer.kind === 'session') return this.later(row, 60, 'session');
    if (answer.kind !== 'ok') return this.later(row, this.backoff(row), 'done');
    const returnedId = operationIdOf(answer.data);
    if (returnedId && returnedId !== row.operation_id) throw new KaspiRemoteError('INVALID');
    const status = answer.data.Status;
    const outcome = kaspiInvoiceOutcome(status);
    if (outcome === 'captured') {
      const paid = kaspiMinor(answer.data.Amount);
      // A status alone cannot establish how much money the bank received.
      if (paid === null) throw new KaspiRemoteError('INVALID');
      await this.transition(row, 'paid', { remoteStatus: status, paidMinor: paid });
      return 'done';
    }
    if (outcome === 'failed') {
      await this.transition(row, 'failed', { remoteStatus: status });
      return 'done';
    }
    await this.pool.query(
      'UPDATE commerce_kaspi_invoices SET remote_status=$2 WHERE attempt_id=$1 AND state=$3 AND lease_token=$4',
      [row.attempt_id, safeStatus(status), row.state, row.lease_token],
    );
    // A fast-food order must not wait for Kaspi's own long expiry: cancel once, then keep checking
    // until Kaspi reports the cancellation (or a payment that raced it). The same applies at once
    // when the restaurant released or cancelled the held order while the invoice was open.
    const restaurantCancelled = ORDER_RELEASED.includes(row.fulfillment_state ?? '');
    if (
      !row.cancel_requested_at &&
      ((row.expires_at && this.now() >= row.expires_at) || restaurantCancelled)
    ) {
      // Persist the intent BEFORE the network call. If the reply/process is lost,
      // the next worker only reads status; it must not send another cancellation.
      const claimed = await this.pool.query(
        `UPDATE commerce_kaspi_invoices SET cancel_requested_at=clock_timestamp()
         WHERE attempt_id=$1 AND state='issued' AND cancel_requested_at IS NULL
           AND lease_token=$2 RETURNING attempt_id`,
        [row.attempt_id, row.lease_token],
      );
      if (!claimed.rowCount) return 'done';
      const cancelled = await this.client.cancel(row.operation_id!);
      if (cancelled.kind === 'session' || cancelled.kind === 'unsent') {
        await this.pool.query(
          'UPDATE commerce_kaspi_invoices SET cancel_requested_at=NULL WHERE attempt_id=$1 AND lease_token=$2',
          [row.attempt_id, row.lease_token],
        );
        return this.later(row, 60, cancelled.kind === 'session' ? 'session' : 'done');
      }
      return this.later(row, 3, 'done');
    }
    return this.later(row, this.backoff(row), 'done');
  }

  private backoff(row: InvoiceRow): number {
    const age = (this.now().getTime() - row.issue_started_at.getTime()) / 1000;
    // Wake at the persisted deadline, including recovered invoices. A deployment
    // must not restart or silently extend a previously issued invoice's lifetime.
    if (row.state === 'issued' && row.expires_at && !row.cancel_requested_at) {
      const remaining = (row.expires_at.getTime() - this.now().getTime()) / 1000;
      if (remaining > 0) return Math.max(1, Math.min(age < 120 ? 3 : 10, remaining));
    }
    if (age < 120) return 3;
    if (age < this.config.invoiceTtlSeconds) return 10;
    if (age < 3600) return 30;
    if (age < 48 * 3600) return 300;
    return 1800;
  }

  private async later(row: InvoiceRow, seconds: number, result: 'done' | 'session') {
    await this.pool.query(
      `UPDATE commerce_kaspi_invoices SET next_check_at=clock_timestamp()+$2*interval '1 second',
       lease_until=NULL,lease_token=NULL WHERE attempt_id=$1 AND lease_token=$3`,
      [row.attempt_id, seconds, row.lease_token],
    );
    return result;
  }

  private async transition(
    row: InvoiceRow,
    state: 'issued' | 'paid' | 'failed' | 'unknown',
    values: { operationId?: string; remoteStatus?: unknown; paidMinor?: string },
  ) {
    const updated = await transaction(this.pool, async (client) => {
      const current = (
        await client.query<{ state: string; lease_token: string | null }>(
          'SELECT state,lease_token FROM commerce_kaspi_invoices WHERE attempt_id=$1 FOR UPDATE',
          [row.attempt_id],
        )
      ).rows[0];
      if (!current || (row.lease_token && current.lease_token !== row.lease_token)) return false;
      const allowed: Record<string, string[]> = {
        issuing: ['issued', 'failed', 'unknown'],
        unknown: ['issued', 'failed'],
        issued: ['paid', 'failed'],
      };
      if (!(allowed[current.state] ?? []).includes(state)) return false;
      await client.query(
        `UPDATE commerce_kaspi_invoices SET state=$2,state_changed_at=clock_timestamp(),
          operation_id=COALESCE(operation_id,$3),
          issued_at=CASE WHEN $3::text IS NOT NULL AND issued_at IS NULL THEN clock_timestamp() ELSE issued_at END,
          expires_at=CASE WHEN $3::text IS NOT NULL AND expires_at IS NULL
            THEN issue_started_at+$6*interval '1 second' ELSE expires_at END,
          remote_status=COALESCE($4,remote_status),paid_minor=$5,
          next_check_at=clock_timestamp()+interval '3 seconds',lease_until=NULL,lease_token=NULL,delivered_at=NULL
         WHERE attempt_id=$1`,
        [
          row.attempt_id,
          state,
          values.operationId ?? null,
          safeStatus(values.remoteStatus),
          values.paidMinor ?? null,
          this.config.invoiceTtlSeconds,
        ],
      );
      return true;
    });
    const fresh = await this.row(row.attempt_id);
    if (fresh && (updated || fresh.state === state)) await this.deliver(fresh);
  }

  /** Deliver the invoice's current state to the commerce ledger. Replays are no-ops. */
  private async deliver(row: InvoiceRow) {
    const provider = {
      organizationId: row.organization_id,
      branchId: row.branch_id,
      accountId: row.account_id,
    };
    const base = {
      eventId: `kaspi-remote:${row.attempt_id}:${row.state}`,
      attemptId: row.attempt_id,
      occurredAt: row.state_changed_at.toISOString(),
    };
    if (row.state === 'paid')
      await this.repo.observePayment(provider, {
        ...base,
        outcome: 'captured',
        operationId: 'kaspi:' + row.operation_id,
        amountMinor: row.paid_minor!,
      });
    else if (row.state !== 'issuing')
      await this.repo.observePayment(provider, {
        ...base,
        outcome: row.state === 'issued' ? 'pending' : row.state,
      });
    // Mark only after the ledger commits. A crash here safely replays its inbox key.
    if (row.state !== 'issuing')
      await this.pool.query(
        'UPDATE commerce_kaspi_invoices SET delivered_at=clock_timestamp() WHERE attempt_id=$1 AND state=$2',
        [row.attempt_id, row.state],
      );
  }
}

function safeStatus(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : null;
}
