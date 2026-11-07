import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UuidSchema } from '@pickchick/contracts';
import { createPool, transaction } from '@pickchick/database';
import { PosSyncError, retryPosSalesDelivery } from '@pickchick/pos-order-sync';
import { edgeInstallConfig } from '../../scripts/edge-migrate.mjs';

/**
 * Owner tool that releases a parked posSales event on the point server (cutover 19.11.2026,
 * integration; lead decision 07.11 item 2, review R6, CR cloud-2 section 6, CR cloud-6 section 2).
 * Runs with the protected owner environment of the edge database, without WAN:
 *
 *   node --env-file=<owner.env> infra/windows/pos-sales-sync-release.mjs status
 *   ... release --event <uuid> --reason "<3-300>" --actor "<who releases>"
 *
 * `status` is read-only: the parked events of pos_sale_outbox (last_error `rejected:<code>`, the
 * stream stops in front of them) with kind, reason and age. `release` calls the sender's own
 * retryPosSalesDelivery (packages/pos-order-sync/src/sales-worker.ts): it clears last_error of
 * exactly that unacknowledged parked row and of pos_sale_sync_state; the event bytes, sequence,
 * attempts and acknowledgement stay as they are, the next attempt of the POS sync worker sends it
 * again in order, and the cloud parks it again if its cause was not repaired. There is no DDL and
 * no audit table for this (DDL freeze 10.11): the record of the operator action is the single JSON
 * line `pos_sales_sync_released` on stdout (event, previous state, reason, actor label, time),
 * which the master runbook has the operator copy into the window journal. Every refusal is one
 * JSON line on stderr, exit code 1, and changes nothing.
 */
export const SYNC_RELEASE_COMMANDS = Object.freeze(['status', 'release']);
const FLAGS = { status: [], release: ['--event', '--reason', '--actor'] };
/** pos_sale_outbox.last_error of a parked event (sales-worker.ts PARKED). */
const PARKED = 'rejected:';
const MAX_LISTED = 50;

export const SYNC_RELEASE_MESSAGES = Object.freeze({
  USAGE:
    'Использование: pos-sales-sync-release.mjs status | release --event <uuid> --reason "<3-300 символов>" --actor "<кто освобождает>"',
  EVENT_INVALID: 'Событие (--event) - event_id из pos-sales-sync-release.mjs status',
  REASON_INVALID: 'Причина (--reason) - от 3 до 300 символов в одну строку',
  ACTOR_INVALID:
    'Кто освобождает (--actor) - метка от 2 до 64 символов в одну строку, например "Codex"',
  OWNER_REQUIRED: 'Нужна защищённая среда владельца базы точки (owner env)',
  NOT_INSTALLED: 'На сервере точки нет миграции 026 (pos_sale_outbox): освобождать нечего',
  NOT_OWNER:
    'Подключение не владельца pos_sale_outbox: освобождает только владелец базы точки (роль службы не может)',
  UNKNOWN_EVENT: 'Такого события posSales нет в очереди этой точки - ничего не изменено',
  NOT_PARKED: 'Событие не припарковано - ничего не изменено',
});
const NOT_PARKED_STATES = Object.freeze({
  pending: 'Событие не припарковано: оно уже освобождено и ждёт отправки - ничего не изменено',
  delivered: 'Событие не припарковано: облако его уже подтвердило - ничего не изменено',
});

export class SyncReleaseError extends Error {
  constructor(code, { message, ...details } = {}) {
    super(message ?? SYNC_RELEASE_MESSAGES[code] ?? code);
    this.code = code;
    this.details = details;
  }
}
const refuse = (code, details) => {
  throw new SyncReleaseError(code, details);
};

// eslint-disable-next-line no-control-regex
const ONE_LINE = /^[^\u0000-\u001f\u007f]*$/;
const text = (value, min, max, code) => {
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length < min || result.length > max || !ONE_LINE.test(result)) refuse(code);
  return result;
};

/** argv after the script name -> {command, ...}; each option exactly once, nothing else. */
export function parseSyncReleaseArgs(argv) {
  const [command, ...rest] = Array.isArray(argv) ? argv : [];
  const allowed = Object.hasOwn(FLAGS, command ?? '') ? FLAGS[command] : null;
  if (!allowed || rest.length !== allowed.length * 2) refuse('USAGE');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    if (!allowed.includes(name) || Object.hasOwn(options, name) || typeof rest[i + 1] !== 'string')
      refuse('USAGE');
    options[name] = rest[i + 1];
  }
  if (command === 'status') return { command };
  const event = UuidSchema.safeParse(options['--event'].trim());
  if (!event.success) refuse('EVENT_INVALID');
  return {
    command,
    eventId: event.data.toLowerCase(),
    reason: text(options['--reason'], 3, 300, 'REASON_INVALID'),
    actor: text(options['--actor'], 2, 64, 'ACTOR_INVALID'),
  };
}

/** The same owner binding as kds-switch.mjs and pos-sales-upgrade-db.mjs: local owner only. */
export function syncReleaseConfig(env = process.env) {
  let config;
  try {
    config = edgeInstallConfig(env);
  } catch {
    refuse('OWNER_REQUIRED');
  }
  const url = new URL(config.databaseUrl);
  if (
    config.environment !== 'local' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55433' ||
    url.pathname !== '/pickchick_edge' ||
    decodeURIComponent(url.username) !== 'pickchick_edge_owner'
  )
    refuse('OWNER_REQUIRED');
  return config;
}

async function requireInstalled(client) {
  const row = (
    await client.query(
      `SELECT to_regclass('pos_sale_outbox') IS NOT NULL AND to_regclass('pos_sale_sync_state') IS NOT NULL AS installed`,
    )
  ).rows[0];
  if (row?.installed !== true) refuse('NOT_INSTALLED');
  return (
    await client.query(
      "SELECT pg_get_userbyid(relowner)=current_user AS owner FROM pg_class WHERE oid='pos_sale_outbox'::regclass",
    )
  ).rows[0].owner;
}
const syncStateOf = async (client, branchId) =>
  (
    await client.query(
      'SELECT last_supported_at,last_error,updated_at FROM pos_sale_sync_state WHERE branch_id=$1',
      [branchId],
    )
  ).rows[0] ?? null;
const iso = (value) => (value instanceof Date ? value.toISOString() : null);

/**
 * Read-only view of the stream: every parked event (oldest first) with its kind, reason, age,
 * whether it is the head of the stream and how many events wait behind it.
 */
export async function posSalesParkedStatus(pool, branchId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const owner = await requireInstalled(client);
    const sync = await syncStateOf(client, branchId);
    const counts = (
      await client.query(
        `SELECT count(*) FILTER(WHERE acknowledged_at IS NULL)::int AS pending,
           count(*) FILTER(WHERE acknowledged_at IS NULL AND last_error LIKE 'rejected:%')::int AS parked,
           clock_timestamp() AS checked_at
         FROM pos_sale_outbox WHERE branch_id=$1`,
        [branchId],
      )
    ).rows[0];
    const parked = (
      await client.query(
        `SELECT o.event_id,o.sequence::text AS sequence,o.kind,o.last_error,o.attempts,o.occurred_at,
           floor(extract(epoch FROM clock_timestamp()-o.occurred_at)/60)::int AS age_minutes,
           NOT EXISTS(SELECT 1 FROM pos_sale_outbox h WHERE h.branch_id=o.branch_id
             AND h.acknowledged_at IS NULL AND h.sequence<o.sequence) AS head,
           (SELECT count(*) FROM pos_sale_outbox b WHERE b.branch_id=o.branch_id
             AND b.acknowledged_at IS NULL AND b.sequence>o.sequence)::int AS waiting_behind
         FROM pos_sale_outbox o
         WHERE o.branch_id=$1 AND o.acknowledged_at IS NULL AND o.last_error LIKE 'rejected:%'
         ORDER BY o.sequence LIMIT ${MAX_LISTED}`,
        [branchId],
      )
    ).rows;
    await client.query('COMMIT');
    return {
      branch_id: branchId,
      checked_at: iso(counts.checked_at),
      owner,
      sync: {
        last_error: sync?.last_error ?? null,
        last_supported_at: iso(sync?.last_supported_at),
      },
      pending: counts.pending,
      parked_count: counts.parked,
      parked: parked.map((row) => ({
        event_id: row.event_id,
        kind: row.kind,
        sequence: row.sequence,
        state: 'parked',
        reason: row.last_error.slice(PARKED.length),
        attempts: row.attempts,
        occurred_at: iso(row.occurred_at),
        age_minutes: row.age_minutes,
        head: row.head,
        waiting_behind: row.waiting_behind,
      })),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Releases exactly one parked event of this branch through retryPosSalesDelivery. Refused, with
 * nothing changed: no 026, a connection that does not own pos_sale_outbox, an event this branch
 * does not have, an event that is not parked (already released and pending, or delivered). A
 * second release of the same event is therefore refused as NOT_PARKED.
 */
export async function releaseParkedPosSalesEvent(
  pool,
  branchId,
  { eventId, reason, actor },
  { now = () => new Date() } = {},
) {
  const before = await transaction(pool, async (client) => {
    const owner = await requireInstalled(client);
    if (owner !== true) refuse('NOT_OWNER');
    const row = (
      await client.query(
        `SELECT event_id,sequence::text AS sequence,kind,occurred_at,acknowledged_at,attempts,last_error
         FROM pos_sale_outbox WHERE branch_id=$1 AND event_id=$2`,
        [branchId, eventId],
      )
    ).rows[0];
    if (!row) refuse('UNKNOWN_EVENT', { event_id: eventId });
    if (row.acknowledged_at || !row.last_error?.startsWith(PARKED)) {
      const state = row.acknowledged_at ? 'delivered' : 'pending';
      refuse('NOT_PARKED', { message: NOT_PARKED_STATES[state], event_id: eventId, state });
    }
    return { row, sync: await syncStateOf(client, branchId) };
  });
  try {
    await retryPosSalesDelivery(pool, branchId, eventId);
  } catch (error) {
    // Between the read and the release another owner session released it (or it was delivered).
    if (error instanceof PosSyncError && error.code === 'CONFLICT')
      refuse('NOT_PARKED', { event_id: eventId });
    if (error instanceof PosSyncError && error.code === 'FORBIDDEN') refuse('NOT_OWNER');
    throw error;
  }
  const { row, sync } = before;
  return {
    branch_id: branchId,
    event_id: row.event_id,
    kind: row.kind,
    sequence: row.sequence,
    occurred_at: iso(row.occurred_at),
    previous: {
      state: 'parked',
      reason: row.last_error.slice(PARKED.length),
      last_error: row.last_error,
      attempts: row.attempts,
      sync_last_error: sync?.last_error ?? null,
    },
    // What retryPosSalesDelivery changed, in the normal fields of the two rows.
    changed: { outbox_last_error: null, sync_last_error: null },
    state: 'pending',
    reason,
    actor,
    released_at: now().toISOString(),
  };
}

/** One command on an open pool: the stdout line (JSON, one line). */
export async function runPosSalesSyncRelease(args, { pool, branchId, now }) {
  if (args.command === 'status')
    return JSON.stringify({
      event: 'pos_sales_sync_status',
      ...(await posSalesParkedStatus(pool, branchId)),
    });
  return JSON.stringify({
    event: 'pos_sales_sync_released',
    ...(await releaseParkedPosSalesEvent(pool, branchId, args, { now })),
  });
}

/** The stderr line of a failure: own refusals with their text, anything else only a code. */
export function syncReleaseFailure(error, command = null) {
  if (error instanceof SyncReleaseError)
    return JSON.stringify({
      event: 'pos_sales_sync_release_refused',
      command,
      code: error.code,
      message: error.message,
      ...error.details,
    });
  const code = typeof error?.code === 'string' && /^[0-9A-Z_]{2,32}$/.test(error.code);
  return JSON.stringify({
    event: 'pos_sales_sync_release_failed',
    command,
    code: 'UNEXPECTED',
    ...(code ? { error_code: error.code } : {}),
    message: 'Остановлено: ошибка базы или подключения - выполнить status и проверить событие',
  });
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let pool;
  let command = SYNC_RELEASE_COMMANDS.includes(argv[0]) ? argv[0] : null;
  try {
    // Arguments and the owner URL are checked before any connection.
    const args = parseSyncReleaseArgs(argv);
    command = args.command;
    const config = syncReleaseConfig(env);
    pool = createPool(config.databaseUrl, 1);
    console.log(await runPosSalesSyncRelease(args, { pool, branchId: config.branchId }));
  } catch (error) {
    // Never the connection string, SQL or driver text.
    console.error(syncReleaseFailure(error, command));
    process.exitCode = 1;
  } finally {
    await pool?.end().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
