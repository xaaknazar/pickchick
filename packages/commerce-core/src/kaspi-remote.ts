import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { transaction } from '@pickchick/database';
import type { DatabasePool } from '@pickchick/database';
import { CommerceRepository } from './repository.js';
import { UUIDSchema } from './model.js';

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
}

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
  const ttl = Number(env.KASPI_INVOICE_TTL_SECONDS ?? '600');
  if (
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

export class KaspiBridgeClient {
  constructor(
    private readonly config: Pick<KaspiRemoteConfig, 'bridgeUrl' | 'requestTimeoutMs' | 'session'>,
    private readonly fetcher: FetchLike = fetch,
  ) {}

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

// Application-side message budget. The bridge does not declare a bank limit.
// Keep the recovery marker first and intact even when product names are shortened.
const INVOICE_COMMENT_MAX_LENGTH = 255;
const InvoiceItemsSchema = z.object({
  lines: z.array(z.object({ title: z.string(), quantity: z.number().int().positive() })),
});

export function kaspiInvoiceComment(reference: string, snapshot: unknown): string {
  const marker = `PickChick ${reference}`;
  const parsed = InvoiceItemsSchema.safeParse(snapshot);
  if (!parsed.success || !parsed.data.lines.length) return marker;
  const items = parsed.data.lines.map(({ title, quantity }) => {
    const name = title
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    return { name: name || 'Позиция', quantity };
  });
  const prefix = `${marker}: `;
  const parts: string[] = [];
  for (const [index, entry] of items.entries()) {
    const quantity = ` ×${entry.quantity}`;
    const item = entry.name + quantity;
    const remaining = items.length - index - 1;
    const suffix = remaining ? `; ещё ${remaining} поз.` : '';
    const separator = parts.length ? '; ' : '';
    const used = prefix.length + parts.join('; ').length + separator.length;
    if (used + item.length + suffix.length > INVOICE_COMMENT_MAX_LENGTH) {
      if (parts.length) return `${prefix}${parts.join('; ')}; ещё ${items.length - index} поз.`;
      const budget = INVOICE_COMMENT_MAX_LENGTH - used - suffix.length - quantity.length - 1;
      let shortened = '';
      for (const character of entry.name) {
        if (shortened.length + character.length > budget) break;
        shortened += character;
      }
      return `${prefix}${shortened.trimEnd()}…${quantity}${suffix}`;
    }
    parts.push(item);
  }
  return prefix + parts.join('; ');
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
}
export interface KaspiTickResult {
  submitted: number;
  checked: number;
  errors: number;
  sessionProblem: boolean;
  /** Invoices whose existence is unknown for over 5 minutes: need manual check in Kaspi Pay. */
  unknownOverdue: number;
}

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const reference = () =>
  Array.from({ length: 10 }, () => REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)]).join(
    '',
  );
const SELECT_ROW = `SELECT k.*,k.amount_minor::text amount_minor,k.paid_minor::text paid_minor,
  p.organization_id,p.branch_id FROM commerce_kaspi_invoices k
  JOIN commerce_provider_accounts p ON p.id=k.account_id`;

export class KaspiRemoteProcessor {
  private readonly repo: CommerceRepository;
  private readonly workerId = randomUUID();
  private submissionsPaused = false;
  constructor(
    private readonly pool: DatabasePool,
    private readonly config: KaspiRemoteConfig,
    private readonly client: KaspiBridgeClient,
    private readonly phone: PhoneResolver,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.repo = new CommerceRepository(pool);
  }

  /** One worker iteration: issue new invoices, then re-check due ones. */
  async tick(limit = 10): Promise<KaspiTickResult> {
    const result: KaspiTickResult = {
      submitted: 0,
      checked: 0,
      errors: 0,
      sessionProblem: this.submissionsPaused,
      unknownOverdue: 0,
    };
    // One broken item must not stall the rest; its lease expires and it is retried.
    for (let i = 0; i < limit && !this.submissionsPaused; i++) {
      const [event] = await this.claimSubmissions(1);
      if (!event) break;
      try {
        if ((await this.submit(event)) === 'session') {
          this.submissionsPaused = true;
          result.sessionProblem = true;
        }
      } catch {
        result.errors++;
      }
      result.submitted++;
    }
    for (let i = 0; i < limit; i++) {
      const [row] = await this.claimDue(1);
      if (!row) break;
      try {
        if ((await this.check(row)) === 'session') {
          this.submissionsPaused = true;
          result.sessionProblem = true;
        }
      } catch {
        result.errors++;
      }
      result.checked++;
    }
    result.unknownOverdue = await this.unknownOverdue();
    return result;
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

  private async claimSubmissions(limit: number) {
    const token = randomUUID();
    const { rows } = await this.pool.query<{ id: string; attempt_id: string }>(
      `WITH selected AS (
        SELECT e.id FROM commerce_outbox e
        JOIN commerce_orders o ON o.id=e.order_id
        JOIN commerce_payment_attempts a ON a.id=(e.payload->>'attemptId')::uuid AND a.order_id=o.id
        JOIN commerce_provider_accounts p ON p.id=a.account_id
        WHERE e.event_type='payment.submit_requested' AND e.acknowledged_at IS NULL
          AND (e.lease_until IS NULL OR e.lease_until<clock_timestamp())
          AND p.id=$1 AND p.provider=$2 AND p.kind='payment' AND p.enabled
          AND (e.payload->>'accountId')::uuid=p.id AND a.state='pending'
          AND NOT o.attention_required
          AND NOT EXISTS(SELECT 1 FROM commerce_cancellation_intents i WHERE i.order_id=o.id)
        ORDER BY e.sequence LIMIT $3 FOR UPDATE OF e SKIP LOCKED)
      UPDATE commerce_outbox e SET lease_worker=$4,lease_token=$5,
        lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1
      FROM selected s WHERE e.id=s.id RETURNING e.id,e.payload->>'attemptId' attempt_id`,
      [this.config.accountId, KASPI_REMOTE_PROVIDER, limit, this.workerId, token],
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

  private async submit(event: { id: string; attempt_id: string; token: string }) {
    // Durable marker first: if the process dies after the request left, the
    // invoice is found again through its reference instead of being re-issued.
    const { rows } = await this.pool.query<{
      attempt_id: string;
      customer_id: string | null;
      snapshot: unknown;
    }>(
      `INSERT INTO commerce_kaspi_invoices(attempt_id,order_id,account_id,amount_minor,state,reference)
       SELECT a.id,a.order_id,a.account_id,a.intended_minor,'issuing',$3
       FROM commerce_payment_attempts a
       WHERE a.id=$1 AND a.account_id=$2 AND a.state='pending' AND a.intended_minor%100=0
       ON CONFLICT(attempt_id) DO NOTHING
       RETURNING attempt_id,(SELECT customer_id FROM commerce_orders WHERE id=order_id) customer_id,
         (SELECT snapshot FROM commerce_orders WHERE id=order_id) snapshot`,
      [event.attempt_id, this.config.accountId, reference()],
    );
    const created = rows[0];
    if (!created) {
      const existing = await this.row(event.attempt_id);
      // Tiyn amounts cannot be invoiced in whole tenge: fail the attempt explicitly.
      if (!existing) await this.observeWithoutInvoice(event.attempt_id);
      await this.acknowledge(event);
      return 'done';
    }
    const row = (await this.row(created.attempt_id))!;
    // A lookup failure means nothing was sent to Kaspi: a definite, retryable failure.
    const phone = created.customer_id
      ? await this.phone(created.customer_id).catch(() => null)
      : null;
    const formatted = phone ? kaspiPhone(phone) : null;
    if (!formatted) {
      await this.transition(row, 'failed', {});
      await this.acknowledge(event);
      return 'done';
    }
    const amount = Number(BigInt(row.amount_minor) / 100n);
    const answer = await this.client.createInvoice(
      formatted,
      amount,
      kaspiInvoiceComment(row.reference, created.snapshot),
    );
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
        const matches = findByReference(history.data, row.reference);
        const match = matches.length === 1 ? matches[0]! : null;
        const amount = match ? kaspiMinor(match.Amount) : null;
        if (match && amount === row.amount_minor) {
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
    // until Kaspi reports the cancellation (or a payment that raced it).
    if (row.expires_at && this.now() >= row.expires_at && !row.cancel_requested_at) {
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
