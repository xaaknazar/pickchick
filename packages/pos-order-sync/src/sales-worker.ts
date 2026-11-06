import { TextDecoder } from 'node:util';
import { DeviceIdentitySchema, UuidSchema } from '@pickchick/contracts';
import type { DeviceIdentity } from '@pickchick/contracts';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { transaction } from '@pickchick/database';
import { hashJson } from '@pickchick/menu-sync';
import { PosSyncError } from './model.js';
import { posCloudOrigin } from './http.js';
import { posRetryDelayMs } from './worker.js';
import {
  MAX_POS_SALE_BATCH,
  MAX_POS_SALE_BATCH_BYTES,
  POS_SALES_SYNC_PATH,
  PosSaleBatchResultSchema,
  parsePosSaleEvent,
  posSaleReceiptFor,
} from './sales-model.js';
import type { PosSaleBatch, PosSaleBatchResult, PosSaleEvent } from './sales-model.js';

/**
 * Edge sender of the posSales stream (contracts 5.6, lane cloud CC-4): its own loop in the POS
 * sync worker, next to and independent of the order_commercial and kitchen streams. It reads
 * pos_sale_outbox (edge schema026, written by the pos lane in the transaction of each sale, void,
 * refund, receipt record and shift close) strictly in sequence order, posts batches of at most
 * 50 events and marks acknowledged exactly the receipts the cloud returned after its COMMIT.
 *
 * - 404/503: the cloud does not support posSales (older cloud, CLOUD_POS_SALES_SYNC_ENABLED off,
 *   schema073 missing): nothing changes in the outbox, the next attempt is in 10 minutes.
 * - Other failures: own exponential backoff (2 s .. 60 s) kept in this worker's schedule.
 * - While the outbox is empty it sends the empty probe `{events: []}` every 10 minutes.
 * - Every valid 200 (batch or probe) stores pos_sale_sync_state.last_supported_at, the
 *   precondition of `pos-sales-setup.mjs enable` (contracts 6.2 step 6).
 * - `rejected` (CONFLICT or INVALID_EVENT): the event is parked with last_error
 *   `rejected:<code>` and the stream stops in front of it until the owner calls
 *   retryPosSalesDelivery after the cause is repaired. Later events are never sent past it.
 * The worker role writes only acknowledged_at, attempts and last_error of the outbox and the
 * pos_sale_sync_state row (infra/windows/pos-sales-grants.mjs WORKER_PRIVILEGES). On an edge
 * without schema026 or without these grants the loop only rechecks every 10 minutes.
 */
export const POS_SALES_UNSUPPORTED_RETRY_MS = 600_000;
export const POS_SALES_PROBE_INTERVAL_MS = 600_000;
export const POS_SALES_NOT_INSTALLED_RETRY_MS = 600_000;
/** A parked stream is looked at again after this pause (the owner may have released it). */
export const POS_SALES_PARKED_RECHECK_MS = 60_000;
export const POS_SALES_REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
/** pos_sale_outbox.last_error of a parked event. */
const PARKED = 'rejected:';

export class PosSalesHttpError extends Error {
  constructor(
    readonly code: 'UNSUPPORTED' | 'HTTP_REJECTED' | 'NETWORK_UNKNOWN' | 'INVALID_RESPONSE',
    readonly status?: number,
  ) {
    super(code);
  }
}
export interface PosSalesIo {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Clock of the schedule (tests); defaults to Date.now. */
  now?: () => number;
}

/** One request; bounded time and size, no redirect, upstream text never surfaces. */
export async function sendPosSales(
  origin: string,
  identity: DeviceIdentity,
  batch: PosSaleBatch,
  io: PosSalesIo = {},
): Promise<PosSaleBatchResult> {
  const base = posCloudOrigin(origin),
    body = JSON.stringify(batch),
    timeout = io.timeoutMs ?? POS_SALES_REQUEST_TIMEOUT_MS;
  if (
    Buffer.byteLength(body) > MAX_POS_SALE_BATCH_BYTES ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > POS_SALES_REQUEST_TIMEOUT_MS
  )
    throw new PosSalesHttpError('INVALID_RESPONSE');
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new PosSalesHttpError('NETWORK_UNKNOWN'));
    }, timeout);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const response = await (io.fetch ?? fetch)(`${base}${POS_SALES_SYNC_PATH}`, {
          method: 'POST',
          redirect: 'error',
          signal: abort.signal,
          headers: {
            Authorization: `Bearer ${identity.token}`,
            'X-Device-Id': identity.device_id,
            'Content-Type': 'application/json',
          },
          body,
        });
        if (response.status === 404 || response.status === 503)
          throw new PosSalesHttpError('UNSUPPORTED', response.status);
        if (response.status !== 200) throw new PosSalesHttpError('HTTP_REJECTED', response.status);
        if (
          !response.body ||
          !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')
        )
          throw new PosSalesHttpError('INVALID_RESPONSE');
        const length = response.headers.get('content-length');
        if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES))
          throw new PosSalesHttpError('INVALID_RESPONSE');
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > MAX_RESPONSE_BYTES) throw new PosSalesHttpError('INVALID_RESPONSE');
          chunks.push(part.value);
        }
        let value: unknown;
        try {
          value = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
          );
        } catch {
          throw new PosSalesHttpError('INVALID_RESPONSE');
        }
        const parsed = PosSaleBatchResultSchema.safeParse(value);
        if (!parsed.success) throw new PosSalesHttpError('INVALID_RESPONSE');
        return parsed.data;
      })(),
    ]);
  } catch (error) {
    if (error instanceof PosSalesHttpError) throw error;
    throw new PosSalesHttpError('NETWORK_UNKNOWN');
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
    void reader?.cancel().catch(() => undefined);
  }
}

/**
 * In-memory schedule of one sender loop: next attempt, consecutive failures and the last valid
 * answer seen by this process (probe interval). A restart sends at once, which is harmless.
 */
export interface PosSalesSchedule {
  nextAttemptAt: number;
  failures: number;
  lastSupportedAt: number | null;
  running: boolean;
}
export const createPosSalesSchedule = (): PosSalesSchedule => ({
  nextAttemptAt: 0,
  failures: 0,
  lastSupportedAt: null,
  running: false,
});

export type PosSalesSyncResult =
  | { state: 'disabled' }
  | { state: 'busy' }
  | { state: 'waiting'; retryAt: number }
  | { state: 'not_installed'; retryAt: number }
  | { state: 'idle' }
  | { state: 'probed' }
  | { state: 'delivered'; count: number; more: boolean }
  | { state: 'unsupported'; retryAt: number }
  | { state: 'retry'; error: string; retryAt: number }
  | { state: 'parked'; eventId: string; error: string };

type OutboxRow = {
  event_id: string;
  sequence: string;
  branch_id: string;
  kind: string;
  payload: unknown;
  payload_hash: string;
  occurred_at: Date;
  last_error: string | null;
};
type Pending =
  | { state: 'not_installed' }
  | { state: 'disabled' }
  | { state: 'parked'; eventId: string; error: string }
  | { state: 'ready'; rows: OutboxRow[] };

async function readPending(
  client: DatabaseClient,
  branchId: string,
  deviceId: string,
): Promise<Pending> {
  const ready = (
    await client.query<{ ready: boolean }>(
      `SELECT CASE WHEN to_regclass('pos_sale_outbox') IS NULL OR to_regclass('pos_sale_sync_state') IS NULL
         THEN false ELSE (
           has_table_privilege('pos_sale_outbox','SELECT') AND
           has_column_privilege('pos_sale_outbox','acknowledged_at','UPDATE') AND
           has_column_privilege('pos_sale_outbox','attempts','UPDATE') AND
           has_column_privilege('pos_sale_outbox','last_error','UPDATE') AND
           has_table_privilege('pos_sale_sync_state','SELECT') AND
           has_table_privilege('pos_sale_sync_state','INSERT') AND
           has_table_privilege('pos_sale_sync_state','UPDATE')) END AS ready`,
    )
  ).rows[0];
  if (ready?.ready !== true) return { state: 'not_installed' };
  // The same trusted POS sync binding as the order and kitchen streams.
  const binding = (
    await client.query<{ device_id: string; active: boolean }>(
      'SELECT device_id,active FROM pos_order_sync_state WHERE branch_id=$1',
      [branchId],
    )
  ).rows[0];
  if (!binding) throw new PosSyncError('NOT_FOUND');
  if (binding.device_id !== deviceId.toLowerCase()) throw new PosSyncError('FORBIDDEN');
  if (!binding.active) return { state: 'disabled' };
  const rows = (
    await client.query<OutboxRow>(
      // Order by the bigint column: the text alias `sequence` would sort '10' before '9'.
      `SELECT o.event_id,o.sequence::text AS sequence,o.branch_id,o.kind,o.payload,o.payload_hash,
       o.occurred_at,o.last_error FROM pos_sale_outbox o
       WHERE o.branch_id=$1 AND o.acknowledged_at IS NULL ORDER BY o.sequence LIMIT $2`,
      [branchId, MAX_POS_SALE_BATCH],
    )
  ).rows;
  const head = rows[0];
  if (head?.last_error?.startsWith(PARKED))
    return { state: 'parked', eventId: head.event_id, error: head.last_error.slice(PARKED.length) };
  return { state: 'ready', rows };
}

/** The wire event of one outbox row, or null when the row cannot be sent as it is. */
function wireEvent(row: OutboxRow): PosSaleEvent | null {
  try {
    const event = parsePosSaleEvent({
      event_id: row.event_id,
      branch_id: row.branch_id,
      sequence: row.sequence,
      kind: row.kind,
      occurred_at: row.occurred_at.toISOString(),
      payload: row.payload,
    });
    return hashJson(event.payload) === row.payload_hash ? event : null;
  } catch {
    return null;
  }
}

async function recordState(
  client: DatabaseClient,
  branchId: string,
  supported: boolean,
  error: string | null,
) {
  await client.query(
    `INSERT INTO pos_sale_sync_state(branch_id,last_supported_at,last_error)
     VALUES($1,CASE WHEN $2::boolean THEN clock_timestamp() END,$3)
     ON CONFLICT(branch_id) DO UPDATE SET last_supported_at=CASE WHEN $2::boolean
       THEN clock_timestamp() ELSE pos_sale_sync_state.last_supported_at END,
       last_error=EXCLUDED.last_error,updated_at=clock_timestamp()`,
    [branchId, supported, error],
  );
}

/** The sender parks the head itself when it could never be delivered as stored. */
async function parkLocally(pool: DatabasePool, branchId: string, eventId: string, code: string) {
  await transaction(pool, async (client) => {
    await client.query(
      `UPDATE pos_sale_outbox SET last_error=$3 WHERE branch_id=$1 AND event_id=$2 AND acknowledged_at IS NULL`,
      [branchId, eventId, PARKED + code],
    );
    await recordState(client, branchId, false, `PARKED ${code} ${eventId}`);
  });
}

/** Whether the answer is exactly an in-order prefix of the sent events (and its refusal). */
function answers(events: readonly PosSaleEvent[], result: PosSaleBatchResult) {
  const accepted = result.receipts.length;
  return (
    accepted <= events.length &&
    result.receipts.every(
      (receipt, index) => hashJson(receipt) === hashJson(posSaleReceiptFor(events[index]!)),
    ) &&
    (!result.rejected ||
      (accepted < events.length && result.rejected.event_id === events[accepted]!.event_id))
  );
}

async function deliver(
  pool: DatabasePool,
  branchId: string,
  origin: string,
  identity: DeviceIdentity,
  schedule: PosSalesSchedule,
  io: PosSalesIo,
  now: () => number,
): Promise<PosSalesSyncResult> {
  const pending = await transaction(pool, (client) =>
    readPending(client, branchId, identity.device_id),
  );
  if (pending.state === 'not_installed') {
    schedule.nextAttemptAt = now() + POS_SALES_NOT_INSTALLED_RETRY_MS;
    return { state: 'not_installed', retryAt: schedule.nextAttemptAt };
  }
  if (pending.state === 'disabled') return pending;
  if (pending.state === 'parked') {
    schedule.nextAttemptAt = now() + POS_SALES_PARKED_RECHECK_MS;
    return pending;
  }
  const { rows } = pending,
    events: PosSaleEvent[] = [];
  let bytes = Buffer.byteLength('{"events":[]}');
  for (const row of rows) {
    const event = wireEvent(row);
    const size = event ? Buffer.byteLength(JSON.stringify(event)) + (events.length ? 1 : 0) : 0;
    if (!event || bytes + size > MAX_POS_SALE_BATCH_BYTES) {
      if (events.length) break;
      // The head itself cannot be sent: park it rather than skip it (sequence order).
      const code = event ? 'TOO_LARGE' : 'LOCAL_INVALID';
      await parkLocally(pool, branchId, row.event_id, code);
      schedule.nextAttemptAt = now() + POS_SALES_PARKED_RECHECK_MS;
      return { state: 'parked', eventId: row.event_id, error: code };
    }
    bytes += size;
    events.push(event);
  }
  if (
    !events.length &&
    schedule.lastSupportedAt !== null &&
    now() - schedule.lastSupportedAt < POS_SALES_PROBE_INTERVAL_MS
  )
    return { state: 'idle' };
  const ids = events.map((event) => event.event_id);
  if (ids.length)
    await pool.query(
      `UPDATE pos_sale_outbox SET attempts=attempts+1 WHERE branch_id=$1 AND event_id=ANY($2::uuid[])
       AND acknowledged_at IS NULL`,
      [branchId, ids],
    );
  const fail = async (error: string): Promise<PosSalesSyncResult> => {
    schedule.failures = Math.min(schedule.failures + 1, 1_000_000);
    schedule.nextAttemptAt = now() + posRetryDelayMs(schedule.failures);
    await transaction(pool, (client) => recordState(client, branchId, false, error));
    return { state: 'retry', error, retryAt: schedule.nextAttemptAt };
  };
  let result: PosSaleBatchResult;
  try {
    result = await sendPosSales(origin, identity, { events }, io);
  } catch (error) {
    const failure = error instanceof PosSalesHttpError ? error : null;
    if (failure?.code === 'UNSUPPORTED') {
      schedule.failures = 0;
      schedule.nextAttemptAt = now() + POS_SALES_UNSUPPORTED_RETRY_MS;
      await transaction(pool, (client) =>
        recordState(client, branchId, false, 'CLOUD_UNSUPPORTED'),
      );
      return { state: 'unsupported', retryAt: schedule.nextAttemptAt };
    }
    return fail(
      failure?.code === 'HTTP_REJECTED'
        ? `HTTP_${failure.status}`
        : (failure?.code ?? 'NETWORK_UNKNOWN'),
    );
  }
  // Nothing is acknowledged unless the answer is exactly what was sent, in order.
  if (!answers(events, result)) return fail('INVALID_RESPONSE');
  const accepted = events.slice(0, result.receipts.length),
    rejected = result.rejected;
  if (events.length && !accepted.length && !rejected) return fail('NO_PROGRESS');
  await transaction(pool, async (client) => {
    if (accepted.length)
      await client.query(
        `UPDATE pos_sale_outbox SET acknowledged_at=clock_timestamp(),last_error=NULL
         WHERE branch_id=$1 AND event_id=ANY($2::uuid[]) AND acknowledged_at IS NULL`,
        [branchId, accepted.map((event) => event.event_id)],
      );
    if (rejected)
      await client.query(
        `UPDATE pos_sale_outbox SET last_error=$3 WHERE branch_id=$1 AND event_id=$2
         AND acknowledged_at IS NULL`,
        [branchId, rejected.event_id, PARKED + rejected.code],
      );
    await recordState(
      client,
      branchId,
      true,
      rejected ? `PARKED ${rejected.code} ${rejected.event_id}` : null,
    );
  });
  schedule.failures = 0;
  schedule.lastSupportedAt = now();
  if (rejected) {
    schedule.nextAttemptAt = now() + POS_SALES_PARKED_RECHECK_MS;
    return { state: 'parked', eventId: rejected.event_id, error: rejected.code };
  }
  schedule.nextAttemptAt = 0;
  if (!events.length) return { state: 'probed' };
  return {
    state: 'delivered',
    count: accepted.length,
    more: accepted.length < events.length || rows.length === MAX_POS_SALE_BATCH,
  };
}

/**
 * One step of the posSales loop. Cheap while waiting (no database, no network), so the worker
 * may call it every second; an unexpected error backs the schedule off before it is rethrown.
 */
export async function syncPosSalesOnce(
  pool: DatabasePool,
  input: { enabled: boolean; branchId: string; origin: string; identity: unknown },
  schedule: PosSalesSchedule = createPosSalesSchedule(),
  io: PosSalesIo = {},
): Promise<PosSalesSyncResult> {
  if (!input.enabled) return { state: 'disabled' };
  const now = io.now ?? Date.now;
  if (schedule.running) return { state: 'busy' };
  if (now() < schedule.nextAttemptAt) return { state: 'waiting', retryAt: schedule.nextAttemptAt };
  const identity = DeviceIdentitySchema.parse(input.identity),
    origin = posCloudOrigin(input.origin);
  if (identity.branch_id !== input.branchId) throw new PosSyncError('FORBIDDEN');
  schedule.running = true;
  try {
    return await deliver(pool, input.branchId, origin, identity, schedule, io, now);
  } catch (error) {
    schedule.failures = Math.min(schedule.failures + 1, 1_000_000);
    schedule.nextAttemptAt = now() + posRetryDelayMs(schedule.failures);
    throw error;
  } finally {
    schedule.running = false;
  }
}

/**
 * Owner-only release of a parked event after its cause was repaired (cloud fixed, data
 * corrected). The event bytes stay as they are; the next attempt sends it again in order.
 */
export async function retryPosSalesDelivery(pool: DatabasePool, branchId: string, eventId: string) {
  if (!UuidSchema.safeParse(branchId).success || !UuidSchema.safeParse(eventId).success)
    throw new PosSyncError('INVALID_REQUEST');
  return transaction(pool, async (client) => {
    const owner = await client.query<{ allowed: boolean }>(
      "SELECT pg_get_userbyid(relowner)=current_user AS allowed FROM pg_class WHERE oid='pos_sale_outbox'::regclass",
    );
    if (owner.rows[0]?.allowed !== true) throw new PosSyncError('FORBIDDEN');
    const row = await client.query(
      `UPDATE pos_sale_outbox SET last_error=NULL WHERE branch_id=$1 AND event_id=$2
       AND acknowledged_at IS NULL AND last_error LIKE 'rejected:%' RETURNING event_id`,
      [branchId, eventId],
    );
    if (row.rowCount !== 1) throw new PosSyncError('CONFLICT');
    await client.query(
      'UPDATE pos_sale_sync_state SET last_error=NULL,updated_at=clock_timestamp() WHERE branch_id=$1',
      [branchId],
    );
    return { state: 'retry' as const, eventId: eventId.toLowerCase() };
  });
}
