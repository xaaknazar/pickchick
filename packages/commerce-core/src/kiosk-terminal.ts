import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, type DatabaseClient, type DatabasePool } from '@pickchick/database';
import { CommerceRepository, reviewOrderInTransaction } from './repository.js';
import { CommerceError, digest, parse, type CommerceScope } from './model.js';

/**
 * ADR-0018: an iPad kiosk paid on its own Kaspi Smart POS terminal. The iPad drives the terminal
 * over the LAN; the cloud keeps the kiosk↔terminal link and receives the kiosk-key-attested
 * outcome. Money counts only on status success with a transaction id, the attempt's exact amount
 * and the terminal linked when the attempt was created. A fail closes the attempt (a new one may
 * start); unknown, a mismatching success and an attempt without a result after 15 minutes become
 * reconciliation incidents and never reach the kitchen.
 */
export const KIOSK_KASPI_TERMINAL_PROVIDER = 'kaspi-pos';
/** An attempt without a result this long becomes an incident (ADR-0018). */
export const KIOSK_TERMINAL_RESULT_MINUTES = 15;

export type KioskTerminalConfig = { accountId: string };
/** Separate opt-in and account; 'false' or absent is off, anything else but 'true' is invalid. */
export function kioskKaspiTerminalConfig(env: NodeJS.ProcessEnv): KioskTerminalConfig | null {
  const flag = env.KIOSK_KASPI_TERMINAL_ENABLED;
  if (flag === undefined || flag === 'false') return null;
  if (flag !== 'true') throw new Error('INVALID_KIOSK_TERMINAL_CONFIG');
  const accountId = env.KIOSK_KASPI_TERMINAL_ACCOUNT_ID;
  if (!z.uuid().safeParse(accountId).success) throw new Error('INVALID_KIOSK_TERMINAL_CONFIG');
  // The terminal rail never shares an account with the QR or phone-invoice rails.
  if (accountId === env.KIOSK_KASPI_QR_ACCOUNT_ID || accountId === env.KASPI_REMOTE_ACCOUNT_ID)
    throw new Error('KIOSK_TERMINAL_REQUIRES_SEPARATE_ACCOUNT');
  return { accountId: accountId! };
}

export type KioskTerminalErrorCode =
  | 'KIOSK_TERMINAL_TAKEN'
  | 'KIOSK_TERMINAL_NOT_LINKED'
  | 'KIOSK_TERMINAL_DISABLED'
  | 'KIOSK_TERMINAL_WHOLE_TENGE';
/** Contract errors of ADR-0018; the API answers each with 409 and `{ code }`. */
export class KioskTerminalError extends Error {
  constructor(public readonly code: KioskTerminalErrorCode) {
    super(code);
  }
}

const Identifier = z
  .union([
    z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
    z
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .transform((value) => String(value)),
  ])
  .pipe(z.string());
const PrivateIpv4 = z
  .string()
  .regex(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  .refine((host) => {
    const parts = host.split('.').map(Number);
    if (parts.some((p, i) => p > 255 || String(p) !== host.split('.')[i])) return false;
    const [a, b] = parts as [number, number];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  });
export const KioskTerminalLinkSchema = z.strictObject({
  terminal_id: Identifier,
  serial: Identifier,
  host: PrivateIpv4,
});
const Text = z.string().trim().min(1).max(200);
export const KioskTerminalEventSchema = z
  .strictObject({
    attempt_id: z.uuid(),
    kind: z.enum(['started', 'result']),
    process_id: Identifier,
    terminal_id: Identifier,
    status: z.enum(['success', 'fail', 'unknown']).nullish(),
    sub_status: Text.nullish(),
    transaction_id: Identifier.nullish(),
    method: z.enum(['qr', 'card', 'alaqan']).nullish(),
    amount_tenge: z.int().positive().max(90_000_000_000_000).nullish(),
    message: Text.nullish(),
  })
  .refine((e) =>
    e.kind === 'result'
      ? e.status != null
      : e.status == null && e.transaction_id == null && e.amount_tenge == null,
  )
  .transform((e) => {
    // Absent and null are the same report; the digest sees one canonical shape.
    const out: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(e)) if (value != null) out[key] = value;
    return out as {
      attempt_id: string;
      kind: 'started' | 'result';
      process_id: string;
      terminal_id: string;
      status?: 'success' | 'fail' | 'unknown';
      sub_status?: string;
      transaction_id?: string;
      method?: 'qr' | 'card' | 'alaqan';
      amount_tenge?: number;
      message?: string;
    };
  });
export const KioskTerminalPaymentSchema = z.strictObject({
  method: z.literal('kaspi_terminal'),
  request_id: z.uuid(),
});

export type KioskDeviceScope = { deviceId: string; organizationId: string; branchId: string };
type LinkRow = {
  id: string;
  terminal_id: string;
  serial: string;
  host: string;
  linked_at: Date;
};
type AttemptRow = {
  attempt_id: string;
  order_id: string;
  account_id: string;
  organization_id: string;
  branch_id: string;
  terminal_id: string;
  request_id: string;
  amount_minor: string;
  state: 'pending' | 'paid' | 'failed' | 'unknown';
  process_id: string | null;
  transaction_id: string | null;
  incident: string | null;
  expires_at: Date;
};
const ATTEMPT_COLUMNS = `attempt_id,order_id,account_id,organization_id,branch_id,terminal_id,request_id,
 amount_minor::text amount_minor,state,process_id,transaction_id,incident,expires_at`;

const linkView = (row: LinkRow) => ({
  terminal_id: row.terminal_id,
  serial: row.serial,
  host: row.host,
  linked_at: row.linked_at.toISOString(),
});
const attemptView = (row: AttemptRow) => ({
  attempt_id: row.attempt_id,
  amount_tenge: Number(BigInt(row.amount_minor) / 100n),
  terminal_id: row.terminal_id,
  expires_at: row.expires_at.toISOString(),
});
/** Stable command key of one payment request of one order. */
const commandKey = (orderId: string, requestId: string) => {
  const h = createHash('sha256').update(`kiosk-terminal:${orderId}:${requestId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export class KioskTerminal {
  constructor(
    private readonly pool: DatabasePool,
    private readonly config: KioskTerminalConfig | null,
    private readonly repository: CommerceRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}
  get enabled() {
    return this.config !== null;
  }
  /** KIOSK_KASPI_TERMINAL_ACCOUNT_ID, or null when the terminal is off. */
  get accountId() {
    return this.config?.accountId ?? null;
  }
  private assertEnabled(): KioskTerminalConfig {
    if (!this.config) throw new KioskTerminalError('KIOSK_TERMINAL_DISABLED');
    return this.config;
  }
  /**
   * The branch's 'kaspi-pos' account is enabled and belongs to the branch's legal entity.
   * `accountId`: the point's own account (ADR-0019); the env account by default.
   */
  async accountReady(
    scope: { organizationId: string; branchId: string },
    accountId: string | null = this.config?.accountId ?? null,
  ) {
    if (!this.config || !accountId) return false;
    return !!(
      await this.pool.query(
        `SELECT 1 FROM commerce_provider_accounts a JOIN branches b ON b.id=a.branch_id
         WHERE a.id=$1 AND a.organization_id=$2 AND a.branch_id=$3 AND a.legal_entity_id=b.legal_entity_id
          AND a.kind='payment' AND a.provider='kaspi-pos' AND a.enabled`,
        [accountId, scope.organizationId, scope.branchId],
      )
    ).rowCount;
  }
  /** Active link of this kiosk device, or null. Off: always null (tables may be unreadable). */
  async linked(deviceId: string) {
    if (!this.config) return null;
    const row = (
      await this.pool.query<LinkRow>(
        'SELECT id,terminal_id,serial,host(host) host,linked_at FROM kiosk_terminal_links WHERE device_id=$1 AND unlinked_at IS NULL',
        [deviceId],
      )
    ).rows[0];
    return row ? linkView(row) : null;
  }
  /** PUT terminal: link or refresh this kiosk's terminal. Another active kiosk keeps it: TAKEN. */
  async link(device: KioskDeviceScope, input: unknown) {
    this.assertEnabled();
    const body = parse(KioskTerminalLinkSchema, input);
    return transaction(this.pool, async (client) => {
      // One writer per terminal id and per device: the partial unique indexes back this up.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('kiosk-terminal:' || $1, 0))",
        [body.terminal_id],
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('kiosk-terminal-device:' || $1, 0))",
        [device.deviceId],
      );
      const taken = await client.query(
        'SELECT 1 FROM kiosk_terminal_links WHERE terminal_id=$1 AND unlinked_at IS NULL AND device_id<>$2',
        [body.terminal_id, device.deviceId],
      );
      if (taken.rowCount) throw new KioskTerminalError('KIOSK_TERMINAL_TAKEN');
      const current = (
        await client.query<LinkRow>(
          'SELECT id,terminal_id FROM kiosk_terminal_links WHERE device_id=$1 AND unlinked_at IS NULL FOR UPDATE',
          [device.deviceId],
        )
      ).rows[0];
      let row: LinkRow;
      if (current?.terminal_id === body.terminal_id)
        row = (
          await client.query<LinkRow>(
            `UPDATE kiosk_terminal_links SET serial=$2,host=$3::inet,updated_at=clock_timestamp()
             WHERE id=$1 RETURNING id,terminal_id,serial,host(host) host,linked_at`,
            [current.id, body.serial, body.host],
          )
        ).rows[0]!;
      else {
        if (current)
          await client.query(
            'UPDATE kiosk_terminal_links SET unlinked_at=clock_timestamp() WHERE id=$1',
            [current.id],
          );
        row = (
          await client.query<LinkRow>(
            `INSERT INTO kiosk_terminal_links(id,organization_id,branch_id,device_id,terminal_id,serial,host)
             VALUES($1,$2,$3,$4,$5,$6,$7::inet) RETURNING id,terminal_id,serial,host(host) host,linked_at`,
            [
              randomUUID(),
              device.organizationId,
              device.branchId,
              device.deviceId,
              body.terminal_id,
              body.serial,
              body.host,
            ],
          )
        ).rows[0]!;
      }
      return linkView(row);
    });
  }
  /** DELETE terminal: unlink. Idempotent; open attempts keep the terminal they were made on. */
  async unlink(device: KioskDeviceScope) {
    this.assertEnabled();
    await this.pool.query(
      'UPDATE kiosk_terminal_links SET unlinked_at=clock_timestamp() WHERE device_id=$1 AND unlinked_at IS NULL',
      [device.deviceId],
    );
    return { unlinked: true as const };
  }
  /** Latest terminal attempt of the order, for GET orders/:id. */
  async presentation(orderId: string) {
    const row = (
      await this.pool.query<AttemptRow>(
        `SELECT ${ATTEMPT_COLUMNS} FROM commerce_kiosk_terminal_attempts WHERE order_id=$1 ORDER BY created_at DESC,attempt_id LIMIT 1`,
        [orderId],
      )
    ).rows[0];
    return {
      kind: 'kaspi_terminal' as const,
      state: !row
        ? ('pending' as const)
        : row.state === 'unknown'
          ? ('checking' as const)
          : row.state,
      attempt_id: row?.attempt_id ?? null,
      amount_tenge: row ? Number(BigInt(row.amount_minor) / 100n) : null,
      terminal_id: row?.terminal_id ?? null,
      expires_at: row?.expires_at.toISOString() ?? null,
    };
  }
  /** Existing attempt of this request, else the order's open attempt, else null (no writes). */
  async existing(orderId: string, requestId: string) {
    const rows = (
      await this.pool.query<AttemptRow>(
        `SELECT ${ATTEMPT_COLUMNS} FROM commerce_kiosk_terminal_attempts
         WHERE order_id=$1 AND (request_id=$2 OR state IN ('pending','paid'))
         ORDER BY (request_id=$2) DESC,created_at DESC LIMIT 1`,
        [orderId, requestId],
      )
    ).rows[0];
    return rows ? attemptView(rows) : null;
  }
  /**
   * Creates the 'kaspi-pos' payment attempt for the exact order total, inside the caller's
   * session-locked transaction. Readiness (hours, kitchen, stops) is checked by the caller.
   */
  async begin(
    client: DatabaseClient,
    scope: CommerceScope,
    deviceId: string,
    orderId: string,
    requestId: string,
    accountId?: string,
  ) {
    const config = this.assertEnabled();
    const account = accountId ?? config.accountId;
    const order = (
      await client.query<{ total_minor: string; principal_id: string }>(
        `SELECT total_minor::text total_minor,principal_id FROM commerce_orders WHERE id=$1 AND principal_id=$2
          AND organization_id=$3 AND branch_id=$4 AND customer_id IS NULL AND snapshot->>'channel'='kiosk' FOR UPDATE`,
        [orderId, scope.principalId, scope.organizationId, scope.branchId],
      )
    ).rows[0];
    if (!order) throw new CommerceError('NOT_FOUND');
    const prior = (
      await client.query<AttemptRow>(
        `SELECT ${ATTEMPT_COLUMNS} FROM commerce_kiosk_terminal_attempts
         WHERE order_id=$1 AND (request_id=$2 OR state IN ('pending','paid'))
         ORDER BY (request_id=$2) DESC,created_at DESC LIMIT 1`,
        [orderId, requestId],
      )
    ).rows[0];
    if (prior) return attemptView(prior);
    // An unresolved result (unknown, overdue) is on reconciliation: no second payment.
    const unresolved = await client.query(
      "SELECT 1 FROM commerce_payment_attempts WHERE order_id=$1 AND state='unknown'",
      [orderId],
    );
    if (unresolved.rowCount) throw new CommerceError('CONFLICT');
    const link = (
      await client.query<LinkRow>(
        'SELECT id,terminal_id FROM kiosk_terminal_links WHERE device_id=$1 AND unlinked_at IS NULL FOR SHARE',
        [deviceId],
      )
    ).rows[0];
    if (!link) throw new KioskTerminalError('KIOSK_TERMINAL_NOT_LINKED');
    if (BigInt(order.total_minor) % 100n !== 0n)
      throw new KioskTerminalError('KIOSK_TERMINAL_WHOLE_TENGE');
    // Any unresolved attempt (an unknown terminal result, another rail) refuses a new one.
    const started = await this.repository.startKioskTerminalPaymentAttempt(
      scope,
      commandKey(orderId, requestId),
      { orderId, providerAccountId: account },
      client,
    );
    const row = (
      await client.query<AttemptRow>(
        `INSERT INTO commerce_kiosk_terminal_attempts(attempt_id,order_id,account_id,organization_id,branch_id,
          device_id,session_id,link_id,terminal_id,request_id,amount_minor)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${ATTEMPT_COLUMNS}`,
        [
          started.attemptId,
          orderId,
          account,
          scope.organizationId,
          scope.branchId,
          deviceId,
          order.principal_id,
          link.id,
          link.terminal_id,
          requestId,
          order.total_minor,
        ],
      )
    ).rows[0]!;
    // No bank worker submits a terminal payment: the iPad does. The submit request is
    // acknowledged here so no 'kaspi-pos' outbox item stays open for any consumer.
    await client.query(
      `UPDATE commerce_outbox SET acknowledged_at=clock_timestamp()
       WHERE order_id=$1 AND effect_key=$2 AND event_type='payment.submit_requested' AND acknowledged_at IS NULL`,
      [orderId, 'payment:' + started.attemptId],
    );
    return attemptView(row);
  }
  /** One kiosk-attested terminal event, inside the caller's session-locked transaction. */
  async event(
    client: DatabaseClient,
    scope: CommerceScope,
    orderId: string,
    input: unknown,
    accountId?: string,
  ) {
    const config = this.assertEnabled();
    const event = parse(KioskTerminalEventSchema, input);
    const order = await client.query(
      `SELECT 1 FROM commerce_orders WHERE id=$1 AND principal_id=$2 AND organization_id=$3 AND branch_id=$4
        AND customer_id IS NULL AND snapshot->>'channel'='kiosk' FOR UPDATE`,
      [orderId, scope.principalId, scope.organizationId, scope.branchId],
    );
    if (!order.rowCount) throw new CommerceError('NOT_FOUND');
    const attempt = (
      await client.query<AttemptRow>(
        `SELECT ${ATTEMPT_COLUMNS} FROM commerce_kiosk_terminal_attempts WHERE attempt_id=$1 AND order_id=$2 AND account_id=$3 FOR UPDATE`,
        [event.attempt_id, orderId, accountId ?? config.accountId],
      )
    ).rows[0];
    if (!attempt) throw new CommerceError('NOT_FOUND');
    const hash = digest(event);
    const replay = (
      await client.query<{ request_digest: string }>(
        'SELECT request_digest FROM commerce_kiosk_terminal_events WHERE attempt_id=$1 AND kind=$2 AND process_id=$3',
        [attempt.attempt_id, event.kind, event.process_id],
      )
    ).rows[0];
    if (replay) {
      if (replay.request_digest !== hash) throw new CommerceError('CONFLICT');
      return;
    }
    // One start and one result per attempt: a second process is never accepted.
    const recorded = await client.query(
      'SELECT 1 FROM commerce_kiosk_terminal_events WHERE attempt_id=$1 AND kind=$2',
      [attempt.attempt_id, event.kind],
    );
    if (recorded.rowCount) throw new CommerceError('CONFLICT');
    const insert = (decision: string) =>
      client.query(
        `INSERT INTO commerce_kiosk_terminal_events(id,attempt_id,kind,process_id,terminal_id,status,sub_status,
          transaction_id,method,amount_minor,message,request_digest,decision)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          randomUUID(),
          attempt.attempt_id,
          event.kind,
          event.process_id,
          event.terminal_id,
          event.status ?? null,
          event.sub_status ?? null,
          event.transaction_id ?? null,
          event.method ?? null,
          event.amount_tenge === undefined ? null : String(BigInt(event.amount_tenge) * 100n),
          event.message ?? null,
          hash,
          decision,
        ],
      );
    if (event.kind === 'started') {
      // A start from another terminal, or after the result, names a payment we did not make.
      const result = await client.query(
        "SELECT 1 FROM commerce_kiosk_terminal_events WHERE attempt_id=$1 AND kind='result'",
        [attempt.attempt_id],
      );
      if (event.terminal_id !== attempt.terminal_id || result.rowCount)
        throw new CommerceError('CONFLICT');
      await insert('started');
      if (attempt.process_id === null)
        await client.query(
          'UPDATE commerce_kiosk_terminal_attempts SET process_id=$2 WHERE attempt_id=$1',
          [attempt.attempt_id, event.process_id],
        );
      return;
    }
    const sameProcess = attempt.process_id === null || attempt.process_id === event.process_id;
    const sameTerminal = event.terminal_id === attempt.terminal_id;
    const decision =
      event.status === 'unknown'
        ? 'unknown'
        : !sameProcess || !sameTerminal
          ? 'mismatch'
          : event.status === 'fail'
            ? 'failed'
            : event.transaction_id !== undefined &&
                event.amount_tenge !== undefined &&
                BigInt(event.amount_tenge) * 100n === BigInt(attempt.amount_minor)
              ? 'paid'
              : 'mismatch';
    await insert(decision);
    const provider = {
      organizationId: attempt.organization_id,
      branchId: attempt.branch_id,
      accountId: attempt.account_id,
    };
    const occurredAt = this.now().toISOString();
    if (decision === 'paid') {
      await client.query(
        `UPDATE commerce_kiosk_terminal_attempts SET state='paid',process_id=COALESCE(process_id,$2),
          transaction_id=$3,resolved_at=COALESCE(resolved_at,clock_timestamp()) WHERE attempt_id=$1`,
        [attempt.attempt_id, event.process_id, event.transaction_id],
      );
      // The same observation a paid QR makes: capture, then the order's kitchen admission.
      await this.repository.observePaymentInTransaction(client, provider, {
        eventId: `kiosk-terminal:${attempt.attempt_id}:paid`,
        attemptId: attempt.attempt_id,
        outcome: 'captured',
        operationId: event.transaction_id!,
        amountMinor: attempt.amount_minor,
        occurredAt,
      });
      return;
    }
    if (decision === 'failed') {
      await client.query(
        `UPDATE commerce_kiosk_terminal_attempts SET state='failed',process_id=COALESCE(process_id,$2),
          resolved_at=COALESCE(resolved_at,clock_timestamp()) WHERE attempt_id=$1`,
        [attempt.attempt_id, event.process_id],
      );
      await this.repository.observePaymentInTransaction(client, provider, {
        eventId: `kiosk-terminal:${attempt.attempt_id}:failed`,
        attemptId: attempt.attempt_id,
        outcome: 'failed',
        occurredAt,
      });
      return;
    }
    await this.incident(
      client,
      attempt,
      decision === 'unknown' ? 'result_unknown' : 'result_mismatch',
      {
        process_id: event.process_id,
        terminal_id: event.terminal_id,
        status: event.status!,
        ...(event.sub_status ? { sub_status: event.sub_status } : {}),
        ...(event.transaction_id ? { transaction_id: event.transaction_id } : {}),
        ...(event.amount_tenge !== undefined ? { amount_tenge: event.amount_tenge } : {}),
      },
    );
  }
  /** Unknown: the attempt stays on reconciliation and the order never goes to the kitchen. */
  private async incident(
    client: DatabaseClient,
    attempt: AttemptRow,
    reason: 'result_unknown' | 'result_overdue' | 'result_mismatch',
    details: Record<string, unknown>,
  ) {
    if (attempt.state === 'pending')
      await client.query(
        `UPDATE commerce_kiosk_terminal_attempts SET state='unknown',incident=$2,resolved_at=clock_timestamp()
         WHERE attempt_id=$1 AND state='pending'`,
        [attempt.attempt_id, reason],
      );
    await this.repository.observePaymentInTransaction(
      client,
      {
        organizationId: attempt.organization_id,
        branchId: attempt.branch_id,
        accountId: attempt.account_id,
      },
      {
        eventId: `kiosk-terminal:${attempt.attempt_id}:${reason}`,
        attemptId: attempt.attempt_id,
        outcome: 'unknown',
        occurredAt: this.now().toISOString(),
      },
    );
    const code = {
      result_unknown: 'KIOSK_TERMINAL_RESULT_UNKNOWN',
      result_overdue: 'KIOSK_TERMINAL_RESULT_OVERDUE',
      result_mismatch: 'KIOSK_TERMINAL_RESULT_MISMATCH',
    }[reason];
    await reviewOrderInTransaction(
      client,
      attempt.order_id,
      `kiosk-terminal:${attempt.attempt_id}:${reason}`,
      code,
      {
        attemptId: attempt.attempt_id,
        terminalId: attempt.terminal_id,
        amountMinor: attempt.amount_minor,
        ...details,
      },
    );
  }
  /**
   * Attempts without a result for 15 minutes become incidents (not failures). Called by the
   * kiosk API on its reads and by a worker tick; `branchId` limits the sweep to one branch,
   * `accountId` names that point's own account (ADR-0019; the env account by default).
   */
  async reviewOverdue(branchId?: string, limit = 20, accountId?: string) {
    if (!this.config) return { overdue: 0 };
    const due = (
      await this.pool.query<{ attempt_id: string; order_id: string }>(
        `SELECT attempt_id,order_id FROM commerce_kiosk_terminal_attempts
         WHERE state='pending' AND expires_at<=clock_timestamp() AND account_id=$1
          AND ($2::uuid IS NULL OR branch_id=$2) ORDER BY expires_at LIMIT $3`,
        [accountId ?? this.config.accountId, branchId ?? null, limit],
      )
    ).rows;
    let overdue = 0;
    for (const item of due)
      await transaction(this.pool, async (client) => {
        await client.query('SELECT 1 FROM commerce_orders WHERE id=$1 FOR UPDATE', [item.order_id]);
        const attempt = (
          await client.query<AttemptRow>(
            `SELECT ${ATTEMPT_COLUMNS} FROM commerce_kiosk_terminal_attempts
             WHERE attempt_id=$1 AND state='pending' AND expires_at<=clock_timestamp() FOR UPDATE`,
            [item.attempt_id],
          )
        ).rows[0];
        if (!attempt) return;
        await this.incident(client, attempt, 'result_overdue', {
          minutes: KIOSK_TERMINAL_RESULT_MINUTES,
          process_id: attempt.process_id,
        });
        overdue++;
      });
    return { overdue };
  }
}
