import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '@pickchick/database';
import { CommerceRepository } from './repository.js';
import {
  kaspiRemoteConfig,
  kaspiMinor,
  KaspiBridgeClient,
  type KaspiRemoteConfig,
} from './kaspi-remote.js';
import { assertBranchItemsAvailable, snapshotAvailabilityItems } from './availability.js';

export const KIOSK_KASPI_QR_PROVIDER = 'kaspi-qr';
export type KioskKaspiQrConfig = KaspiRemoteConfig & { latitude: number; longitude: number };
/** Separate opt-in and account. Shared session credentials remain private to the bridge host. */
export function kioskKaspiQrConfig(env: NodeJS.ProcessEnv): KioskKaspiQrConfig | null {
  if (env.KIOSK_KASPI_QR_ENABLED === undefined || env.KIOSK_KASPI_QR_ENABLED === 'false')
    return null;
  if (env.KIOSK_KASPI_QR_ENABLED !== 'true') throw new Error('INVALID_KIOSK_QR_CONFIG');
  const latitude = Number(env.KIOSK_KASPI_QR_LATITUDE),
    longitude = Number(env.KIOSK_KASPI_QR_LONGITUDE);
  if (
    !env.KIOSK_KASPI_QR_LATITUDE?.trim() ||
    !env.KIOSK_KASPI_QR_LONGITUDE?.trim() ||
    !Number.isFinite(latitude) ||
    Math.abs(latitude) > 90 ||
    !Number.isFinite(longitude) ||
    Math.abs(longitude) > 180
  )
    throw new Error('INVALID_KIOSK_QR_CONFIG');
  const base = kaspiRemoteConfig({
    ...env,
    KASPI_REMOTE_ENABLED: 'true',
    KASPI_REMOTE_ACCOUNT_ID: env.KIOSK_KASPI_QR_ACCOUNT_ID,
    KASPI_BRIDGE_WEBHOOK_SECRET: env.KASPI_BRIDGE_WEBHOOK_SECRET ?? 'x'.repeat(32),
    KASPI_INVOICE_TTL_SECONDS: '180',
  })!;
  if (env.KASPI_REMOTE_ACCOUNT_ID && base.accountId === env.KASPI_REMOTE_ACCOUNT_ID)
    throw new Error('KIOSK_QR_REQUIRES_SEPARATE_ACCOUNT');
  return { ...base, latitude, longitude };
}
type Answer = { kind: 'ok'; data: Record<string, unknown> } | { kind: 'uncertain' | 'session' };
export interface KioskKaspiQrClient {
  checkSession(): Promise<boolean>;
  create(amountTenge: number, latitude: number, longitude: number): Promise<Answer>;
  status(operationId: string): Promise<Answer>;
}
export class KioskKaspiQrBridgeClient implements KioskKaspiQrClient {
  constructor(
    private readonly config: KioskKaspiQrConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  checkSession() {
    return new KaspiBridgeClient(this.config, this.fetcher).checkSession();
  }
  create(amount: number, latitude: number, longitude: number) {
    return this.call('/api/qr/create', { amount, latitude, longitude });
  }
  status(operationId: string) {
    return this.call('/api/qr/status?qrOperationId=' + operationId);
  }
  private async call(path: string, body?: object): Promise<Answer> {
    const session = this.config.session;
    if (!session) return { kind: 'session' };
    try {
      const response = await this.fetcher(this.config.bridgeUrl + path, {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        headers: {
          'X-Token-SN': session.tokenSN,
          'X-Vtoken-Secret': session.vtokenSecret,
          'X-Profile-Id': session.profileId,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 401) return { kind: 'session' };
      const envelope = (await response.json()) as { StatusCode?: unknown; Data?: unknown };
      if (
        !response.ok ||
        envelope?.StatusCode !== 0 ||
        !envelope.Data ||
        typeof envelope.Data !== 'object' ||
        Array.isArray(envelope.Data)
      )
        return { kind: 'uncertain' };
      return { kind: 'ok', data: envelope.Data as Record<string, unknown> };
    } catch {
      return { kind: 'uncertain' };
    }
  }
}
function operationId(value: unknown): string | null {
  const text =
    typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === 'string'
        ? value
        : '';
  return /^[1-9][0-9]{0,19}$/.test(text) ? text : null;
}
function payload(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'qr.kaspi.kz' &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname.length > 1
      ? value
      : null;
  } catch {
    return null;
  }
}
type QrRow = {
  attempt_id: string;
  order_id: string;
  account_id: string;
  amount_minor: string;
  state: string;
  operation_id: string | null;
  qr_payload: string | null;
  expires_at: Date;
  lease_token: string | null;
  delivered_at: Date | null;
  organization_id: string;
  branch_id: string;
  state_changed_at: Date;
  issue_revision: string;
  state_revision: string;
};
export async function readKioskQrPayment(pool: DatabasePool, orderId: string, now = new Date()) {
  const row = (
    await pool.query<QrRow>(
      'SELECT * FROM commerce_kiosk_kaspi_qr WHERE order_id=$1 ORDER BY issue_started_at DESC LIMIT 1',
      [orderId],
    )
  ).rows[0];
  const state: 'preparing' | 'pending' | 'checking' | 'paid' | 'failed' = !row
    ? 'preparing'
    : row.state === 'paid'
      ? 'paid'
      : row.state === 'failed'
        ? 'failed'
        : row.state === 'issued' && row.expires_at > now
          ? 'pending'
          : 'checking';
  return {
    kind: 'kaspi_qr' as const,
    state,
    qrPayload: state === 'pending' ? row!.qr_payload : null,
    expiresAt: row?.expires_at.toISOString() ?? null,
  };
}
/** At most one external create per durable attempt. Lost create identity requires manual reconciliation. */
export class KioskKaspiQrProcessor {
  private readonly repo: CommerceRepository;
  private readonly workerId = randomUUID();
  constructor(
    private readonly pool: DatabasePool,
    private readonly config: KioskKaspiQrConfig,
    private readonly client: KioskKaspiQrClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.repo = new CommerceRepository(pool);
  }
  async tick(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_LIMIT');
    const result = {
      submitted: 0,
      checked: 0,
      errors: 0,
      sessionProblem: false,
      unknownOverdue: 0,
    };
    const token = randomUUID();
    const events = (
      await this.pool.query<{ id: string; attempt_id: string }>(
        `WITH selected AS (
      SELECT e.id FROM commerce_outbox e JOIN commerce_orders o ON o.id=e.order_id
      JOIN commerce_payment_attempts a ON a.id=(e.payload->>'attemptId')::uuid AND a.order_id=o.id
      JOIN commerce_provider_accounts p ON p.id=a.account_id
      WHERE e.event_type='payment.submit_requested' AND e.acknowledged_at IS NULL
       AND (e.lease_until IS NULL OR e.lease_until<clock_timestamp()) AND p.id=$1
       AND p.provider='kaspi-qr' AND p.kind='payment' AND p.enabled AND a.state='pending'
       AND (e.payload->>'accountId')::uuid=p.id AND o.customer_id IS NULL AND o.snapshot->>'channel'='kiosk'
      ORDER BY e.sequence LIMIT $2 FOR UPDATE OF e SKIP LOCKED)
      UPDATE commerce_outbox e SET lease_worker=$3,lease_token=$4,lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1
      FROM selected s WHERE e.id=s.id RETURNING e.id,e.payload->>'attemptId' attempt_id`,
        [this.config.accountId, limit, this.workerId, token],
      )
    ).rows;
    for (const event of events) {
      try {
        const session = await this.submit(event, token);
        result.sessionProblem ||= session;
        result.submitted++;
      } catch {
        result.errors++;
      }
    }
    const lease = randomUUID();
    const due = (
      await this.pool.query<{ attempt_id: string }>(
        `UPDATE commerce_kiosk_kaspi_qr SET lease_token=$3,
      lease_until=clock_timestamp()+interval '60 seconds' WHERE attempt_id IN (
      SELECT attempt_id FROM commerce_kiosk_kaspi_qr WHERE account_id=$1 AND next_check_at<=clock_timestamp()
      AND (state IN ('issuing','issued','unknown') OR delivered_at IS NULL)
      AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY next_check_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING attempt_id`,
        [this.config.accountId, limit, lease],
      )
    ).rows;
    for (const item of due) {
      try {
        const session = await this.check(item.attempt_id, lease);
        result.sessionProblem ||= session;
        result.checked++;
      } catch {
        result.errors++;
      }
    }
    result.unknownOverdue = Number(
      (
        await this.pool.query<{ count: string }>(
          `SELECT count(*)::text count FROM commerce_kiosk_kaspi_qr
      WHERE account_id=$1 AND state IN ('issuing','unknown') AND issue_started_at<clock_timestamp()-interval '5 minutes'`,
          [this.config.accountId],
        )
      ).rows[0]!.count,
    );
    return result;
  }
  private async row(attempt: string) {
    return (
      await this.pool.query<QrRow>(
        `SELECT q.*,q.amount_minor::text,q.issue_started_at::text issue_revision,q.state_changed_at::text state_revision,o.organization_id,o.branch_id
      FROM commerce_kiosk_kaspi_qr q JOIN commerce_orders o ON o.id=q.order_id WHERE q.attempt_id=$1 AND q.account_id=$2`,
        [attempt, this.config.accountId],
      )
    ).rows[0];
  }
  private async submit(event: { id: string; attempt_id: string }, token: string): Promise<boolean> {
    if (await this.row(event.attempt_id)) {
      await this.ack(event.id, token);
      return false;
    }
    if (!(await this.client.checkSession())) {
      await this.defer(event.id, token);
      return true;
    }
    const source = (
      await this.pool.query<{ snapshot: unknown; branch_id: string; ready: boolean }>(
        `SELECT o.snapshot,o.branch_id,
      (b.ordering_enabled AND NOT o.attention_required AND t.active AND d.status='active' AND p.state='held'
       AND p.device_id=o.admission_device_id AND p.device_id=t.device_id AND p.reservation_id=o.admission_reservation_id
       AND NOT EXISTS(SELECT 1 FROM commerce_cancellation_intents c WHERE c.order_id=o.id)) ready
      FROM commerce_payment_attempts a JOIN commerce_orders o ON o.id=a.order_id JOIN branches b ON b.id=o.branch_id
      LEFT JOIN fulfillment_transport_bindings t ON t.branch_id=o.branch_id LEFT JOIN devices d ON d.id=t.device_id
      LEFT JOIN cloud_fulfillment_projection p ON p.order_id=o.id WHERE a.id=$1 AND a.account_id=$2`,
        [event.attempt_id, this.config.accountId],
      )
    ).rows[0];
    if (!source?.ready) {
      await this.defer(event.id, token);
      return false;
    }
    try {
      await assertBranchItemsAvailable(
        this.pool,
        source.branch_id,
        snapshotAvailabilityItems(source.snapshot),
      );
    } catch {
      await this.defer(event.id, token);
      return false;
    }
    const issuanceToken = randomUUID();
    const inserted = await this.pool.query(
      `INSERT INTO commerce_kiosk_kaspi_qr(attempt_id,order_id,account_id,amount_minor,state,issue_started_at,expires_at,lease_token,lease_until)
      SELECT a.id,a.order_id,a.account_id,a.intended_minor,'issuing',statement_timestamp(),statement_timestamp()+interval '180 seconds',$3,clock_timestamp()+interval '120 seconds'
      FROM commerce_payment_attempts a JOIN commerce_orders o ON o.id=a.order_id JOIN commerce_provider_accounts p ON p.id=a.account_id
      WHERE a.id=$1 AND a.account_id=$2 AND a.state='pending' AND a.intended_minor%100=0 AND p.provider='kaspi-qr'
       AND p.enabled AND o.customer_id IS NULL AND o.snapshot->>'channel'='kiosk'
      ON CONFLICT(attempt_id) DO NOTHING RETURNING attempt_id`,
      [event.attempt_id, this.config.accountId, issuanceToken],
    );
    if (!inserted.rowCount) {
      await this.ack(event.id, token);
      return false;
    }
    const row = (await this.row(event.attempt_id))!;
    const answer = await this.client.create(
      Number(BigInt(row.amount_minor) / 100n),
      this.config.latitude,
      this.config.longitude,
    );
    const id = answer.kind === 'ok' ? operationId(answer.data.QrOperationId) : null;
    const qr = answer.kind === 'ok' ? payload(answer.data.QrToken) : null;
    const bound = answer.kind === 'ok' && kaspiMinor(answer.data.Amount) === row.amount_minor;
    if (id && qr && bound) {
      // Keep the stricter bank expiry only when its timezone is explicit; never guess a local zone.
      const expiry =
        answer.kind === 'ok' &&
        typeof answer.data.ExpireDate === 'string' &&
        /(?:Z|[+-]\d{2}:\d{2})$/.test(answer.data.ExpireDate)
          ? Date.parse(answer.data.ExpireDate)
          : NaN;
      await this.pool.query(
        `UPDATE commerce_kiosk_kaspi_qr SET state='issued',state_changed_at=clock_timestamp(),operation_id=$2,qr_payload=$3,
        expires_at=LEAST(expires_at,COALESCE($4::timestamptz,expires_at)),next_check_at=clock_timestamp(),delivered_at=NULL,
        lease_until=CASE WHEN lease_token=$5 THEN NULL ELSE lease_until END,
        lease_token=CASE WHEN lease_token=$5 THEN NULL ELSE lease_token END
        WHERE attempt_id=$1 AND issue_started_at=$6::timestamptz AND operation_id IS NULL AND state IN ('issuing','unknown')`,
        [
          row.attempt_id,
          id,
          qr,
          Number.isFinite(expiry) ? new Date(expiry) : null,
          issuanceToken,
          row.issue_revision,
        ],
      );
    } else
      await this.pool.query(
        `UPDATE commerce_kiosk_kaspi_qr SET state='unknown',state_changed_at=clock_timestamp(),next_check_at=clock_timestamp(),delivered_at=NULL,
        lease_until=CASE WHEN lease_token=$2 THEN NULL ELSE lease_until END,
        lease_token=CASE WHEN lease_token=$2 THEN NULL ELSE lease_token END WHERE attempt_id=$1 AND state='issuing'`,
        [row.attempt_id, issuanceToken],
      );
    await this.ack(event.id, token);
    return answer.kind === 'session';
  }
  private ack(id: string, token: string) {
    return this.pool.query(
      'UPDATE commerce_outbox SET acknowledged_at=COALESCE(acknowledged_at,clock_timestamp()) WHERE id=$1 AND lease_worker=$2 AND lease_token=$3',
      [id, this.workerId, token],
    );
  }
  private defer(id: string, token: string) {
    return this.pool.query(
      "UPDATE commerce_outbox SET lease_until=clock_timestamp()+interval '5 seconds' WHERE id=$1 AND lease_worker=$2 AND lease_token=$3",
      [id, this.workerId, token],
    );
  }
  private async check(attempt: string, lease: string): Promise<boolean> {
    let row = (await this.row(attempt))!;
    if (row.lease_token !== lease) return false;
    let session = false;
    if (row.state === 'issuing') await this.state(row, 'unknown', lease);
    else if (row.operation_id && (row.state === 'issued' || row.state === 'unknown')) {
      const answer = await this.client.status(row.operation_id);
      session = answer.kind === 'session';
      if (answer.kind === 'ok') {
        const bound =
          operationId(answer.data.QrOperationId) === row.operation_id &&
          kaspiMinor(answer.data.Amount) === row.amount_minor;
        const status = answer.data.Status;
        if (bound && status === 'Processed') await this.state(row, 'paid', lease);
        else if (
          bound &&
          [
            'CancelledByUser',
            'NotConfirmedByUser',
            'CancelledByExternalSource',
            'ProcessingFailed',
            'Rejected',
            'InsufficientFunds',
            'InsufficientFundsError',
            'QrTokenDiscarded',
            'Expired',
          ].includes(String(status))
        )
          await this.state(row, 'failed', lease);
        else if (!bound || !['QrTokenCreated', 'QrTokenScanned', 'Wait'].includes(String(status)))
          await this.state(row, 'unknown', lease);
      }
    }
    row = (await this.row(attempt))!;
    if (row.lease_token !== lease) return session;
    if (!row.delivered_at && row.state !== 'issuing') {
      await this.repo.observePayment(
        { organizationId: row.organization_id, branchId: row.branch_id, accountId: row.account_id },
        {
          eventId: `kiosk-qr:${row.attempt_id}:${row.state}:${row.state_revision}`,
          attemptId: row.attempt_id,
          outcome:
            row.state === 'paid'
              ? 'captured'
              : row.state === 'failed'
                ? 'failed'
                : row.state === 'issued'
                  ? 'pending'
                  : 'unknown',
          ...(row.state === 'paid'
            ? { operationId: row.operation_id!, amountMinor: row.amount_minor }
            : {}),
          occurredAt: row.state_changed_at.toISOString(),
        },
      );
      await this.pool.query(
        'UPDATE commerce_kiosk_kaspi_qr SET delivered_at=clock_timestamp() WHERE attempt_id=$1 AND lease_token=$2 AND state=$3 AND state_changed_at=$4::timestamptz',
        [attempt, lease, row.state, row.state_revision],
      );
    }
    await this.pool.query(
      "UPDATE commerce_kiosk_kaspi_qr SET next_check_at=clock_timestamp()+interval '3 seconds',lease_token=NULL,lease_until=NULL WHERE attempt_id=$1 AND lease_token=$2",
      [attempt, lease],
    );
    return session;
  }
  private state(row: QrRow, state: string, lease: string) {
    return this.pool.query(
      "UPDATE commerce_kiosk_kaspi_qr SET state=$2,state_changed_at=clock_timestamp(),delivered_at=NULL WHERE attempt_id=$1 AND lease_token=$3 AND state=$4 AND state<>$2 AND state NOT IN ('paid','failed')",
      [row.attempt_id, state, lease, row.state],
    );
  }
}
