import { randomUUID } from 'node:crypto';
import {
  PosTerminalPaymentListSchema,
  PosTerminalPaymentRequestSchema,
  PosTerminalPaymentSchema,
  PosTerminalReleaseRequestSchema,
  QuoteSchema,
  UuidSchema,
} from '@pickchick/contracts';
import type { PosTerminalPayment } from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { audit, authenticateStaff, requirePermission } from './staff.js';
import type { StaffAuth } from './staff.js';
import { command } from './commands.js';
import { OrderError } from './errors.js';
import { consumeApproval, posSalesInstalled } from './approvals.js';
import { loadPaymentMethods } from './payment-methods.js';
import { kaspiExpiration, kaspiPort } from './kaspi-client.js';
import type { KaspiCallResult, KaspiLink, KaspiPosPort } from './kaspi-client.js';

/**
 * ADR-0017: the cash desk sends a whole-tenge amount to its Kaspi Smart POS. The attempt is
 * written before the terminal is called and every answer is recorded as a forward transition
 * (schema029 guard). A payment is never sent twice: `unknown` is resolved by /v2/actualize only,
 * `lost` (sent, answer lost, no processId) only by a person. The POS polls GET
 * pos/terminal-payments/{id}; each poll asks the terminal once.
 */
const ATTEMPT_COLUMNS = `id,quote_id,terminal_id,staff_id,amount_minor::text AS amount_minor,state,
  sub_status,transaction_id,payment_method,message,order_id,created_at,updated_at,device_id,process_id,
  actualized_at,clock_timestamp() AS now`;
/** Edge schema030: the release of a paid attempt without an order, read with the attempt. */
const RELEASED_AT = `(SELECT r.released_at FROM kaspi_pos_attempt_releases r
  WHERE r.attempt_id=kaspi_pos_attempts.id AND r.branch_id=kaspi_pos_attempts.branch_id) AS released_at`;
const attemptColumns = async (client: DatabaseClient | DatabasePool) =>
  `${ATTEMPT_COLUMNS},${(await kaspiReleaseInstalled(client)) ? RELEASED_AT : 'NULL::timestamptz AS released_at'}`;
interface AttemptRow {
  id: string;
  quote_id: string;
  terminal_id: string;
  staff_id: string;
  amount_minor: string;
  state: PosTerminalPayment['state'];
  sub_status: string | null;
  transaction_id: string | null;
  payment_method: 'qr' | 'card' | 'alaqan' | null;
  message: string | null;
  order_id: string | null;
  created_at: Date;
  updated_at: Date;
  device_id: string;
  process_id: string | null;
  actualized_at: Date | null;
  released_at: Date | null;
  now: Date;
}
interface DeviceRow {
  id: string;
  host: string;
  port: number;
  certificate_sha256: string;
  integration_name: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: Date;
}
/** Renew the token this long before it expires (it lives 24 h). */
const RENEW_BEFORE_MS = 3 * 60 * 60 * 1000;
/** A claimed send that never recorded its answer (edge stopped mid-call) is lost after this. */
const SENDING_STALE_MS = 60 * 1000;
/** An attempt written but never claimed (edge stopped before sending) was never sent. */
const CREATED_STALE_MS = 60 * 1000;
/** Kaspi: actualize no more often than every 10 seconds. */
const ACTUALIZE_INTERVAL_MS = 10 * 1000;

const view = (row: AttemptRow): PosTerminalPayment =>
  PosTerminalPaymentSchema.parse({
    attempt_id: row.id,
    quote_id: row.quote_id,
    terminal_id: row.terminal_id,
    amount_minor: row.amount_minor,
    state: row.state,
    sub_status: row.sub_status,
    transaction_id: row.transaction_id,
    payment_method: row.payment_method,
    message: row.message,
    order_id: row.order_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    staff_id: row.staff_id,
    released_at: row.released_at?.toISOString() ?? null,
  });
const link = (device: DeviceRow): KaspiLink => ({
  host: device.host,
  port: device.port,
  certificateSha256: device.certificate_sha256,
});

/** Whether schema029 is installed and readable by this role (the runtime's grants). */
export async function kaspiPosInstalled(client: DatabaseClient | DatabasePool) {
  return (
    await client.query<{ ready: boolean }>(
      `SELECT to_regclass('kaspi_pos_attempts') IS NOT NULL
         AND has_table_privilege('kaspi_pos_devices','SELECT') AS ready`,
    )
  ).rows[0]!.ready;
}
/**
 * Whether schema030 (releases of paid attempts without an order, paid sales at a closed branch) is
 * installed and readable by this role: its ledger row and its table. On an edge without it the
 * sale and the shift behave exactly as before (clean refusals, no new reads).
 */
export async function kaspiReleaseInstalled(client: DatabaseClient | DatabasePool) {
  return (
    await client.query<{ ready: boolean }>(
      `SELECT to_regclass('kaspi_pos_attempt_releases') IS NOT NULL
         AND EXISTS(SELECT 1 FROM schema_migrations
           WHERE scope='edge' AND version='030_edge_kaspi_pos_release.sql')
         AND coalesce(has_table_privilege(to_regclass('kaspi_pos_attempts'),'SELECT'),false)
         AND coalesce(has_table_privilege(to_regclass('kaspi_pos_attempt_releases'),'SELECT'),false) AS ready`,
    )
  ).rows[0]!.ready;
}
/** Paid attempts of this desk without an order that nobody released: the guest paid, nothing was sold. */
export async function countUnsoldTerminalPayments(
  client: DatabaseClient,
  branchId: string,
  terminalId: string,
) {
  if (!(await kaspiPosInstalled(client)) || !(await kaspiReleaseInstalled(client))) return 0;
  return (
    await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM kaspi_pos_attempts a
       WHERE a.branch_id=$1 AND a.terminal_id=$2 AND a.state='success' AND a.order_id IS NULL
         AND NOT EXISTS(SELECT 1 FROM kaspi_pos_attempt_releases r WHERE r.attempt_id=a.id)`,
      [branchId, terminalId],
    )
  ).rows[0]!.count;
}
/** The active terminal of a cash desk, or null (also on an edge without schema029). */
export async function activeKaspiDevice(
  client: DatabaseClient,
  branchId: string,
  terminalId: string,
  lock = false,
): Promise<DeviceRow | null> {
  if (!(await kaspiPosInstalled(client))) return null;
  return (
    (
      await client.query<DeviceRow>(
        `SELECT id,host(host) AS host,port,certificate_sha256,integration_name,access_token,
         refresh_token,token_expires_at FROM kaspi_pos_devices
         WHERE branch_id=$1 AND terminal_id=$2 AND active${lock ? ' FOR UPDATE' : ''}`,
        [branchId, terminalId],
      )
    ).rows[0] ?? null
  );
}

/** Renew the access token before it expires (/v2/revoke); a failed renewal keeps the old one. */
async function freshToken(
  pool: DatabasePool,
  branchId: string,
  deviceId: string,
  port: KaspiPosPort,
) {
  const device = (
    await pool.query<DeviceRow & { renew: boolean }>(
      `SELECT id,host(host) AS host,port,certificate_sha256,integration_name,access_token,refresh_token,
       token_expires_at, token_expires_at - clock_timestamp() < $3 * interval '1 millisecond' AS renew
       FROM kaspi_pos_devices WHERE id=$1 AND branch_id=$2`,
      [deviceId, branchId, RENEW_BEFORE_MS],
    )
  ).rows[0];
  if (!device) throw new OrderError('TERMINAL_NOT_LINKED');
  if (!device.renew) return device;
  const answer = await port.call(link(device), 'revoke', {
    name: device.integration_name,
    refreshToken: device.refresh_token,
  });
  if (answer.kind !== 'ok') return device;
  const access = answer.data.accessToken;
  const refresh = answer.data.refreshToken;
  if (typeof access !== 'string' || typeof refresh !== 'string') return device;
  // Unreadable expiry: assume the shortest sensible life so it is renewed early again.
  const expires =
    kaspiExpiration(answer.data.expirationDate) ?? new Date(Date.now() + RENEW_BEFORE_MS + 60_000);
  try {
    await pool.query(
      `UPDATE kaspi_pos_devices SET access_token=$3,refresh_token=$4,token_expires_at=$5
       WHERE id=$1 AND branch_id=$2 AND active`,
      [deviceId, branchId, access, refresh, expires],
    );
  } catch {
    return device;
  }
  return { ...device, access_token: access, refresh_token: refresh, token_expires_at: expires };
}

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
const REFUSED_TEXTS: Record<number, string> = {
  106: 'Оплаты на терминале заблокированы',
  107: 'Терминал занят прошлой операцией - завершите её на терминале',
  108: 'Терминал не смог начать оплату - попробуйте ещё раз',
};
function refusedMessage(answer: Extract<KaspiCallResult, { kind: 'refused' }>) {
  if (answer.httpStatus === 401 || answer.httpStatus === 403)
    return 'Терминал не принял ключ кассы - нужна повторная привязка терминала';
  return (
    (answer.statusCode !== null && REFUSED_TEXTS[answer.statusCode]) || 'Терминал отказал в оплате'
  );
}
const UNREACHABLE_TEXT = 'Нет связи с терминалом Kaspi - проверьте, что он включён и в сети';
const CHEQUE_KEYS = [
  'storeName',
  'city',
  'address',
  'status',
  'amount',
  'date',
  'bin',
  'terminalId',
  'method',
  'type',
  'orderNumber',
  'cardMask',
  'rrn',
  'authorizationCode',
];
function cheque(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result: Record<string, string> = {};
  for (const key of CHEQUE_KEYS) {
    const item = text((value as Record<string, unknown>)[key], 200);
    if (item !== null) result[key] = item;
  }
  return Object.keys(result).length ? result : null;
}

/** Record one terminal answer to status/actualize as the attempt's transition. */
async function applyStatus(
  pool: DatabasePool,
  row: AttemptRow,
  answer: KaspiCallResult,
  actualized: boolean,
) {
  if (answer.kind !== 'ok') {
    // No answer: nothing is known, the state stays; an unknown attempt waits for the next try.
    if (actualized)
      await pool.query(
        `UPDATE kaspi_pos_attempts SET actualized_at=clock_timestamp() WHERE id=$1 AND state='unknown'`,
        [row.id],
      );
    return;
  }
  const data = answer.data;
  const status = data.status;
  const subStatus =
    typeof data.subStatus === 'string' && /^[A-Za-z]{1,40}$/.test(data.subStatus)
      ? data.subStatus
      : null;
  const info = cheque(data.chequeInfo);
  const method =
    info?.method === 'qr' || info?.method === 'card' || info?.method === 'alaqan'
      ? info.method
      : null;
  const from = row.state;
  if (status === 'success') {
    const transaction = text(data.transactionId, 40);
    if (transaction === null) return; // A success without its operation number is not taken.
    await pool.query(
      `UPDATE kaspi_pos_attempts SET state='success',sub_status=$3,transaction_id=$4,payment_method=$5,
       cheque=$6,message=NULL,finished_at=clock_timestamp(),actualized_at=CASE WHEN $7 THEN clock_timestamp() ELSE actualized_at END
       WHERE id=$1 AND state=$2`,
      [row.id, from, subStatus, transaction, method, info, actualized],
    );
  } else if (status === 'fail') {
    await pool.query(
      `UPDATE kaspi_pos_attempts SET state='fail',sub_status=$3,message=$4,finished_at=clock_timestamp(),
       actualized_at=CASE WHEN $5 THEN clock_timestamp() ELSE actualized_at END WHERE id=$1 AND state=$2`,
      [row.id, from, subStatus, text(data.message, 300) ?? 'Оплата не прошла', actualized],
    );
  } else if (status === 'unknown') {
    await pool.query(
      `UPDATE kaspi_pos_attempts SET state='unknown',sub_status=$3,message=$4,
       actualized_at=CASE WHEN $5 THEN clock_timestamp() ELSE actualized_at END WHERE id=$1 AND state=$2`,
      [row.id, from, subStatus, text(data.message, 300), actualized],
    );
  } else if (status === 'wait' && from === 'wait' && subStatus !== row.sub_status) {
    await pool.query(`UPDATE kaspi_pos_attempts SET sub_status=$2 WHERE id=$1 AND state='wait'`, [
      row.id,
      subStatus,
    ]);
  }
}

/** Claim a created attempt and call /v2/payment once; record what is known about the answer. */
async function sendAttempt(
  pool: DatabasePool,
  branchId: string,
  attemptId: string,
  port: KaspiPosPort,
) {
  const claimed = (
    await pool.query<{ device_id: string; amount_minor: string }>(
      `UPDATE kaspi_pos_attempts SET state='sending' WHERE id=$1 AND branch_id=$2 AND state='created'
       RETURNING device_id, amount_minor::text AS amount_minor`,
      [attemptId, branchId],
    )
  ).rows[0];
  if (!claimed) return;
  let answer: KaspiCallResult;
  try {
    const device = await freshToken(pool, branchId, claimed.device_id, port);
    answer = await port.call(
      link(device),
      'payment',
      { amount: (BigInt(claimed.amount_minor) / 100n).toString() },
      { token: device.access_token },
    );
  } catch {
    // Nothing reached the terminal (bad link or token): never sent.
    answer = { kind: 'unreachable', reason: 'CONNECT' };
  }
  const processId =
    answer.kind === 'ok' &&
    (typeof answer.data.processId === 'string' || typeof answer.data.processId === 'number') &&
    /^[A-Za-z0-9_-]{1,64}$/.test(String(answer.data.processId))
      ? String(answer.data.processId)
      : null;
  if (answer.kind === 'ok' && processId !== null)
    await pool.query(
      `UPDATE kaspi_pos_attempts SET state='wait',process_id=$2,sub_status='Initialize' WHERE id=$1 AND state='sending'`,
      [attemptId, processId],
    );
  else if (answer.kind === 'refused' || answer.kind === 'unreachable')
    await pool.query(
      `UPDATE kaspi_pos_attempts SET state='send_failed',message=$2,finished_at=clock_timestamp() WHERE id=$1 AND state='sending'`,
      [attemptId, answer.kind === 'refused' ? refusedMessage(answer) : UNREACHABLE_TEXT],
    );
  else
    await pool.query(
      `UPDATE kaspi_pos_attempts SET state='lost',message=$2,finished_at=clock_timestamp() WHERE id=$1 AND state='sending'`,
      [attemptId, 'Ответ терминала потерян - проверьте операцию на терминале'],
    );
}

async function loadAttempt(
  client: DatabaseClient | DatabasePool,
  branchId: string,
  attemptId: string,
) {
  return (
    (
      await client.query<AttemptRow>(
        `SELECT ${await attemptColumns(client)} FROM kaspi_pos_attempts WHERE id=$1 AND branch_id=$2`,
        [attemptId, branchId],
      )
    ).rows[0] ?? null
  );
}

/**
 * POST pos/terminal-payments: write the attempt (one open per terminal), then send it. The answer
 * is the attempt as it stands after sending (wait, send_failed or lost). Replaying the key returns
 * the same attempt and never sends it again.
 */
export async function createTerminalPayment(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  key: string,
  input: unknown,
  port: KaspiPosPort = kaspiPort,
): Promise<PosTerminalPayment> {
  const parsed = PosTerminalPaymentRequestSchema.safeParse(input);
  if (!parsed.success) throw new OrderError('INVALID_REQUEST');
  const request = parsed.data;
  if (BigInt(request.amount_minor) % 100n !== 0n) throw new OrderError('TERMINAL_AMOUNT_NOT_WHOLE');
  const created = await command(
    pool,
    branchId,
    auth,
    'checkout',
    'kaspi_pos.payment',
    key,
    request,
    async (client, actor, branch) => {
      if (branch.pos_service_mode !== 'pos_sale' || !(await posSalesInstalled(client)))
        throw new OrderError('SERVICE_MODE_DISABLED');
      const method = (await loadPaymentMethods(client, branchId)).find(
        (m) => m.code === 'kaspi_terminal',
      );
      if (!method?.enabled) throw new OrderError('METHOD_DISABLED');
      const device = await activeKaspiDevice(client, branchId, actor.terminal_id, true);
      if (!device) throw new OrderError('TERMINAL_NOT_LINKED');
      const shift = (
        await client.query<{ sales_mode: boolean }>(
          `SELECT sales_mode FROM local_cash_shifts WHERE branch_id=$1 AND terminal_id=$2 AND state='open'`,
          [branchId, actor.terminal_id],
        )
      ).rows[0];
      if (!shift?.sales_mode) throw new OrderError('CASH_SHIFT_REQUIRED');
      const quoteRow = (
        await client.query(
          `SELECT snapshot, expires_at > clock_timestamp() AS valid FROM checkout_quotes
           WHERE id=$1 AND branch_id=$2 AND staff_id=$3 AND terminal_id=$4`,
          [request.quote_id, branchId, actor.staff_id, actor.terminal_id],
        )
      ).rows[0];
      if (!quoteRow) throw new OrderError('NOT_FOUND');
      if (
        (await client.query('SELECT 1 FROM local_orders WHERE quote_id=$1', [request.quote_id]))
          .rowCount
      )
        throw new OrderError('CONFLICT');
      if (!quoteRow.valid) throw new OrderError('QUOTE_EXPIRED');
      const quote = QuoteSchema.parse(quoteRow.snapshot);
      if ((quote.sales_channel ?? 'hall') !== 'hall') throw new OrderError('INVALID_REQUEST');
      if (BigInt(request.amount_minor) > BigInt(quote.total_minor))
        throw new OrderError('TENDER_SUM_MISMATCH');
      // A paid attempt of this quote that has no order yet is used for the sale, not paid again;
      // one released by hand (edge 030) is gone and does not stop the quote from being paid anew.
      const released = (await kaspiReleaseInstalled(client))
        ? ' AND NOT EXISTS(SELECT 1 FROM kaspi_pos_attempt_releases r WHERE r.attempt_id=a.id)'
        : '';
      if (
        (
          await client.query(
            `SELECT 1 FROM kaspi_pos_attempts a WHERE a.branch_id=$1 AND a.quote_id=$2 AND a.state='success'${released}`,
            [branchId, request.quote_id],
          )
        ).rowCount
      )
        throw new OrderError('CONFLICT');
      // Stale states of an edge that stopped mid-call (see readTerminalPayment) free the terminal.
      await settleStale(client, branchId, device.id);
      const id = randomUUID();
      try {
        await client.query('SAVEPOINT kaspi_attempt');
        await client.query(
          `INSERT INTO kaspi_pos_attempts(id,branch_id,device_id,terminal_id,staff_id,quote_id,amount_minor)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            branchId,
            device.id,
            actor.terminal_id,
            actor.staff_id,
            request.quote_id,
            request.amount_minor,
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          await client.query('ROLLBACK TO SAVEPOINT kaspi_attempt');
          throw new OrderError('TERMINAL_BUSY');
        }
        throw error;
      }
      return { attempt_id: id };
    },
  );
  await sendAttempt(pool, branchId, created.attempt_id, port);
  const row = await loadAttempt(pool, branchId, created.attempt_id);
  return view(row!);
}

/** Created but never claimed: never sent. Claimed but its answer never recorded: lost. */
async function settleStale(
  client: DatabaseClient | DatabasePool,
  branchId: string,
  deviceId: string,
) {
  await client.query(
    `UPDATE kaspi_pos_attempts SET state='send_failed',message='Не отправлено на терминал',finished_at=clock_timestamp()
     WHERE branch_id=$1 AND device_id=$2 AND state='created' AND updated_at < clock_timestamp() - $3 * interval '1 millisecond'`,
    [branchId, deviceId, CREATED_STALE_MS],
  );
  await client.query(
    `UPDATE kaspi_pos_attempts SET state='lost',message='Ответ терминала потерян - проверьте операцию на терминале',
     finished_at=clock_timestamp()
     WHERE branch_id=$1 AND device_id=$2 AND state='sending' AND updated_at < clock_timestamp() - $3 * interval '1 millisecond'`,
    [branchId, deviceId, SENDING_STALE_MS],
  );
}

const inflight = new Map<string, Promise<void>>();
/** Ask the terminal once about an unfinished attempt (one request per attempt at a time). */
async function advance(pool: DatabasePool, branchId: string, row: AttemptRow, port: KaspiPosPort) {
  if (row.state === 'created' || row.state === 'sending') {
    await settleStale(pool, branchId, row.device_id);
    return;
  }
  if (row.state !== 'wait' && row.state !== 'unknown') return;
  if (
    row.state === 'unknown' &&
    row.actualized_at !== null &&
    row.now.getTime() - row.actualized_at.getTime() < ACTUALIZE_INTERVAL_MS
  )
    return;
  const running = inflight.get(row.id);
  if (running) return running;
  const work = (async () => {
    let answer: KaspiCallResult;
    try {
      const device = await freshToken(pool, branchId, row.device_id, port);
      answer = await port.call(
        link(device),
        row.state === 'unknown' ? 'actualize' : 'status',
        { processId: row.process_id! },
        { token: device.access_token },
      );
    } catch {
      answer = { kind: 'unreachable', reason: 'CONNECT' };
    }
    await applyStatus(pool, row, answer, row.state === 'unknown');
  })().finally(() => inflight.delete(row.id));
  inflight.set(row.id, work);
  return work;
}

/** Attempts the point server looks at per pass of the background poll. */
export const TERMINAL_POLL_LIMIT = 20;

/**
 * P0-4 (audit 26.11): the point server finishes unfinished attempts of the branch itself, also
 * while no cash desk window polls (POS closed or restarted during a payment). Each attempt is asked
 * once per pass, through the same forward-only transitions as the POS poll; it never pays again.
 * A paid attempt stays in pos/terminal-payments/open until the cashier finishes the sale.
 * Returns how many attempts were looked at.
 */
export async function pollTerminalPayments(
  pool: DatabasePool,
  branchId: string,
  port: KaspiPosPort = kaspiPort,
): Promise<number> {
  if (!(await kaspiPosInstalled(pool))) return 0;
  const rows = (
    await pool.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS},NULL::timestamptz AS released_at FROM kaspi_pos_attempts
       WHERE branch_id=$1 AND state IN ('created','sending','wait','unknown')
         AND created_at > clock_timestamp() - interval '24 hours'
       ORDER BY created_at LIMIT $2`,
      [branchId, TERMINAL_POLL_LIMIT],
    )
  ).rows;
  for (const row of rows) await advance(pool, branchId, row, port);
  return rows.length;
}

/** GET pos/terminal-payments/{id}: the attempt of this desk, after asking the terminal once. */
export async function readTerminalPayment(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  attemptId: string,
  port: KaspiPosPort = kaspiPort,
): Promise<PosTerminalPayment> {
  if (!UuidSchema.safeParse(attemptId).success) throw new OrderError('INVALID_REQUEST');
  const row = await transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, 'checkout');
    if (!(await kaspiPosInstalled(client))) throw new OrderError('NOT_FOUND');
    const found = await loadAttempt(client, branchId, attemptId);
    if (!found || found.terminal_id !== actor.terminal_id) throw new OrderError('NOT_FOUND');
    return found;
  });
  await advance(pool, branchId, row, port);
  return view((await loadAttempt(pool, branchId, attemptId))!);
}

/**
 * GET pos/terminal-payments/open: what this desk must finish (unfinished, lost or paid without
 * order). With scope=other_desks (edge 030, a shift manager only): the payments of the OTHER desks
 * of the branch that are paid, have no order and were not released - what a manager can release
 * from this desk when theirs is broken or retired.
 */
export async function listOpenTerminalPayments(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  scope?: string,
) {
  if (scope !== undefined && scope !== 'other_desks') throw new OrderError('INVALID_REQUEST');
  return transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, 'checkout');
    if (scope === 'other_desks') {
      if (actor.role !== 'shift_manager') throw new OrderError('FORBIDDEN');
      if (!(await kaspiPosInstalled(client)) || !(await kaspiReleaseInstalled(client)))
        return PosTerminalPaymentListSchema.parse({ items: [] });
      const others = (
        await client.query<AttemptRow>(
          `SELECT ${await attemptColumns(client)} FROM kaspi_pos_attempts
           WHERE branch_id=$1 AND terminal_id<>$2 AND state='success' AND order_id IS NULL
             AND NOT EXISTS(SELECT 1 FROM kaspi_pos_attempt_releases r WHERE r.attempt_id=kaspi_pos_attempts.id)
           ORDER BY created_at DESC LIMIT 50`,
          [branchId, actor.terminal_id],
        )
      ).rows;
      return PosTerminalPaymentListSchema.parse({ items: others.map(view) });
    }
    if (!(await kaspiPosInstalled(client)))
      return PosTerminalPaymentListSchema.parse({ items: [] });
    // Edge 030: a payment that is paid, has no order and was not released stays here whatever its
    // age (the guest's money is on the terminal until a person sells or releases it); the rest of
    // the list keeps its 24 h window. Without 030 the whole list is the 24 h one, as before.
    const unsold = (await kaspiReleaseInstalled(client))
      ? `(state='success' AND order_id IS NULL
            AND NOT EXISTS(SELECT 1 FROM kaspi_pos_attempt_releases r WHERE r.attempt_id=kaspi_pos_attempts.id))
         OR (created_at > clock_timestamp() - interval '24 hours' AND state IN ('created','sending','wait','unknown','lost'))`
      : `created_at > clock_timestamp() - interval '24 hours'
         AND (state IN ('created','sending','wait','unknown','lost') OR (state='success' AND order_id IS NULL))`;
    const rows = (
      await client.query<AttemptRow>(
        `SELECT ${await attemptColumns(client)} FROM kaspi_pos_attempts
         WHERE branch_id=$1 AND terminal_id=$2 AND (${unsold})
         ORDER BY created_at DESC LIMIT 50`,
        [branchId, actor.terminal_id],
      )
    ).rows;
    return PosTerminalPaymentListSchema.parse({ items: rows.map(view) });
  });
}

/**
 * Inside POST pos/sales: the kaspi_terminal part names its paid attempt. Locks it and checks it
 * belongs to this desk and quote, is paid with exactly this amount and unused; marks it used by the
 * order. Returns the terminal's operation number for the tender reference.
 */
export async function useTerminalAttempt(
  client: DatabaseClient,
  branchId: string,
  terminalId: string,
  quoteId: string,
  attemptId: string,
  amountMinor: string,
  orderId: string | null,
): Promise<string> {
  if (!(await kaspiPosInstalled(client))) throw new OrderError('TERMINAL_ATTEMPT_INVALID');
  const row = (
    await client.query<{
      transaction_id: string | null;
      amount_minor: string;
      state: string;
      order_id: string | null;
      terminal_id: string;
      quote_id: string;
    }>(
      `SELECT transaction_id,amount_minor::text AS amount_minor,state,order_id,terminal_id,quote_id
       FROM kaspi_pos_attempts WHERE id=$1 AND branch_id=$2 FOR UPDATE`,
      [attemptId, branchId],
    )
  ).rows[0];
  if (
    !row ||
    row.state !== 'success' ||
    row.order_id !== null ||
    row.terminal_id !== terminalId ||
    row.quote_id !== quoteId ||
    row.amount_minor !== amountMinor ||
    row.transaction_id === null
  )
    throw new OrderError('TERMINAL_ATTEMPT_INVALID');
  // Edge 030: a payment released by hand (refunded on the terminal) is not used for a sale.
  if (
    (await kaspiReleaseInstalled(client)) &&
    (
      await client.query('SELECT 1 FROM kaspi_pos_attempt_releases WHERE attempt_id=$1', [
        attemptId,
      ])
    ).rowCount
  )
    throw new OrderError('TERMINAL_ATTEMPT_INVALID');
  if (orderId !== null)
    await client.query('UPDATE kaspi_pos_attempts SET order_id=$2 WHERE id=$1', [
      attemptId,
      orderId,
    ]);
  return row.transaction_id;
}

/**
 * POST pos/terminal-payments/{attemptId}/release (edge schema030, owner decision 28.11.2026): the
 * guest paid on the terminal, the order cannot be made, the refund is made by hand on the terminal.
 * The shift manager's PIN (approval terminal_release for the attempt's quote and amount) releases
 * the payment; it never reaches the terminal. Any attempt of the branch can be released: of any
 * cashier (who may have gone home) and of any desk (which may be broken or retired), from the desk
 * where the manager types the PIN; everything is read from the attempt, not from a quote or a
 * journal. Idempotent by key; a paid, unsold, unreleased attempt only, at an open sales shift.
 */
export async function releaseTerminalPayment(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  key: string,
  attemptId: string,
  input: unknown,
): Promise<PosTerminalPayment> {
  const parsed = PosTerminalReleaseRequestSchema.safeParse(input);
  if (!parsed.success || !UuidSchema.safeParse(attemptId).success)
    throw new OrderError('INVALID_REQUEST');
  const request = parsed.data;
  return command(
    pool,
    branchId,
    auth,
    'checkout',
    'kaspi_pos.release',
    key,
    { attempt_id: attemptId.toLowerCase(), ...request },
    async (client, actor) => {
      if (
        !(await posSalesInstalled(client)) ||
        !(await kaspiPosInstalled(client)) ||
        !(await kaspiReleaseInstalled(client)) ||
        !(
          await client.query<{ ok: boolean }>(
            `SELECT has_table_privilege('kaspi_pos_attempt_releases','INSERT') AS ok`,
          )
        ).rows[0]!.ok
      )
        throw new OrderError('NOT_FOUND');
      const attempt = (
        await client.query<{
          terminal_id: string;
          quote_id: string;
          staff_id: string;
          amount_minor: string;
          state: string;
          order_id: string | null;
          transaction_id: string | null;
        }>(
          `SELECT terminal_id,quote_id,staff_id,amount_minor::text AS amount_minor,state,order_id,transaction_id
           FROM kaspi_pos_attempts WHERE id=$1 AND branch_id=$2 FOR UPDATE`,
          [attemptId.toLowerCase(), branchId],
        )
      ).rows[0];
      // Any desk of this branch: the one that took the payment may be broken or retired. The
      // approval and the open sales shift are those of THIS (releasing) desk.
      if (!attempt) throw new OrderError('NOT_FOUND');
      if (
        attempt.state !== 'success' ||
        attempt.order_id !== null ||
        attempt.transaction_id === null ||
        (
          await client.query('SELECT 1 FROM kaspi_pos_attempt_releases WHERE attempt_id=$1', [
            attemptId.toLowerCase(),
          ])
        ).rowCount
      )
        throw new OrderError('TERMINAL_ATTEMPT_INVALID');
      const shift = (
        await client.query<{ id: string }>(
          `SELECT id FROM local_cash_shifts
           WHERE branch_id=$1 AND terminal_id=$2 AND state='open' AND sales_mode`,
          [branchId, actor.terminal_id],
        )
      ).rows[0];
      if (!shift) throw new OrderError('CASH_SHIFT_REQUIRED');
      const approval = await consumeApproval(
        client,
        branchId,
        actor,
        key,
        request.approval,
        'terminal_release',
        { quote_id: attempt.quote_id, amount_minor: attempt.amount_minor },
      );
      try {
        await client.query('SAVEPOINT kaspi_release');
        await client.query(
          `INSERT INTO kaspi_pos_attempt_releases(attempt_id,branch_id,attempt_terminal_id,terminal_id,
           shift_id,amount_minor,transaction_id,attempt_staff_id,released_by_staff_id,manager_staff_id,
           approval_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            attemptId.toLowerCase(),
            branchId,
            attempt.terminal_id,
            actor.terminal_id,
            shift.id,
            attempt.amount_minor,
            attempt.transaction_id,
            attempt.staff_id,
            actor.staff_id,
            approval.manager_staff_id,
            approval.approval_id,
            request.reason,
          ],
        );
      } catch (error) {
        // The schema030 guard behind the checks above (a concurrent state change).
        const sqlstate = (error as { code?: string }).code;
        if (sqlstate === '23514' || sqlstate === '23505') {
          await client.query('ROLLBACK TO SAVEPOINT kaspi_release');
          throw new OrderError('TERMINAL_ATTEMPT_INVALID');
        }
        throw error;
      }
      await audit(
        client,
        branchId,
        actor.staff_id,
        `kaspi_pos.payment_released|attempt=${attemptId.toLowerCase()}|amount=${attempt.amount_minor}|manager=${approval.manager_staff_id}|txn=${attempt.transaction_id}`,
        attemptId.toLowerCase(),
      );
      return view((await loadAttempt(client, branchId, attemptId.toLowerCase()))!);
    },
  );
}
