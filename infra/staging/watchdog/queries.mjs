// Read-only SQL of the watchdog. Every column referenced here must be granted by
// infra/staging/watchdog-grants.mjs (WATCHDOG_COLUMNS); nothing else is readable.

export const WATCHDOG_SQL = Object.freeze({
  clock: 'SELECT clock_timestamp() AS now',
  // Cashier/edge device identities (device_credentials, 30-day lifetime). Never token_hash.
  identities: `SELECT d.id::text AS device_id, d.kind, d.name, c.expires_at,
      floor(extract(epoch FROM c.expires_at - clock_timestamp()))::bigint::text AS remaining_seconds
    FROM devices d JOIN device_credentials c ON c.device_id = d.id
    WHERE d.status = 'active' ORDER BY c.expires_at, d.id LIMIT 100`,
  // Same join as branchAvailability(): only the active binding's device counts as alive.
  heartbeats: `SELECT b.branch_id::text AS branch_id, b.device_id::text AS device_id, d.name,
      a.observed_at,
      floor(extract(epoch FROM clock_timestamp() - a.observed_at))::bigint::text AS age_seconds
    FROM fulfillment_transport_bindings b
    JOIN devices d ON d.id = b.device_id AND d.status = 'active'
    LEFT JOIN cloud_branch_availability a ON a.branch_id = b.branch_id AND a.device_id = b.device_id
    WHERE b.active ORDER BY b.branch_id LIMIT 100`,
  // Identical predicate to KaspiRemoteProcessor/KioskKaspiQrProcessor unknownOverdue().
  unknownOverdue: `SELECT
      (SELECT count(*) FROM commerce_kaspi_invoices WHERE state IN ('issuing','unknown')
        AND issue_started_at < clock_timestamp() - interval '5 minutes')::int AS kaspi_remote,
      (SELECT count(*) FROM commerce_kiosk_kaspi_qr WHERE state IN ('issuing','unknown')
        AND issue_started_at < clock_timestamp() - interval '5 minutes')::int AS kiosk_qr`,
  // Payment submissions the Kaspi workers have not sent to the bank (silent deferral covers a
  // rejected session pre-check, a stale restaurant heartbeat or a stopped worker). Bounded to the
  // last hour so abandoned history cannot keep an alert open forever.
  paymentBacklog: `SELECT p.provider, count(DISTINCT e.order_id)::int AS orders
    FROM commerce_outbox e
    JOIN commerce_orders o ON o.id = e.order_id AND NOT o.attention_required
    JOIN commerce_payment_attempts a ON a.order_id = e.order_id AND a.state = 'pending'
    JOIN commerce_provider_accounts p ON p.id = a.account_id
      AND p.provider IN ('kaspi-remote','kaspi-qr') AND p.kind = 'payment' AND p.enabled
    WHERE e.event_type = 'payment.submit_requested' AND e.acknowledged_at IS NULL
      AND e.created_at < clock_timestamp() - make_interval(mins => $1::int)
      AND e.created_at > clock_timestamp() - interval '60 minutes'
      AND NOT EXISTS (SELECT 1 FROM commerce_cancellation_intents i WHERE i.order_id = e.order_id)
    GROUP BY p.provider ORDER BY p.provider`,
  // Kitchen admission health from the database, wherever the fulfillment worker runs (the
  // Windows cashier service logs are not visible here): events the cashier edge has not taken.
  // Bounded to six hours so abandoned history cannot keep an alert open forever.
  kitchenBacklog: `SELECT
      count(*) FILTER (WHERE e.event_type = 'edge.kitchen_admission_requested')::int AS kitchen,
      count(*) FILTER (WHERE e.event_type = 'edge.admission_requested')::int AS admission,
      COALESCE(floor(extract(epoch FROM clock_timestamp() - min(e.created_at))), 0)::bigint::text
        AS oldest_seconds
    FROM commerce_outbox e
    JOIN commerce_orders o ON o.id = e.order_id AND NOT o.attention_required
    WHERE e.event_type IN ('edge.kitchen_admission_requested', 'edge.admission_requested')
      AND e.acknowledged_at IS NULL
      AND e.created_at < clock_timestamp() - make_interval(mins => $1::int)
      AND e.created_at > clock_timestamp() - interval '6 hours'
      AND NOT EXISTS (SELECT 1 FROM commerce_cancellation_intents i WHERE i.order_id = e.order_id)`,
  // Manager review cases (reconciliation issues): a refused or overdue kitchen admission, money
  // after a cancellation, capture/refund mismatches. Such orders carry attention_required and
  // leave the backlogs above, so this is their only alert. Issues are immutable and have no
  // resolved state, hence the time window. Codes only: never details, order or payment data.
  // newest_at marks a new case while the alert is already open (dedup "update").
  reviews: `SELECT code, count(*)::int AS issues,
      floor(extract(epoch FROM clock_timestamp() - max(created_at)))::bigint::text AS newest_seconds,
      max(created_at) AS newest_at
    FROM commerce_reconciliation_issues
    WHERE created_at > clock_timestamp() - make_interval(hours => $1::int)
    GROUP BY code ORDER BY count(*) DESC, code LIMIT 20`,
  // PITR option: archive_command health. pg_stat_archiver is readable without table grants.
  archiver: `SELECT current_setting('archive_mode') AS mode, archived_count::text,
      failed_count::text, last_archived_time, last_failed_time FROM pg_stat_archiver`,
});

const iso = (value) => (value instanceof Date ? value.toISOString() : null);
const seconds = (value) => (value === null || value === undefined ? null : Number(value));
const label = (value) =>
  typeof value === 'string' ? value.replace(/\p{Cc}/gu, ' ').slice(0, 60) : '';
const issueCode = (value) =>
  typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,40}$/.test(value) ? value : 'OTHER';

/** Runs every watchdog query in one READ ONLY transaction on a dedicated client. */
export async function readDatabaseFacts(
  pool,
  { paymentBacklogMinutes = 5, kitchenBacklogMinutes = 5, reviewWindowHours = 6 } = {},
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const now = (await client.query(WATCHDOG_SQL.clock)).rows[0].now;
    const identities = (await client.query(WATCHDOG_SQL.identities)).rows.map((row) => ({
      deviceId: row.device_id,
      kind: row.kind,
      name: label(row.name),
      expiresAt: iso(row.expires_at),
      remainingSeconds: seconds(row.remaining_seconds),
    }));
    const heartbeats = (await client.query(WATCHDOG_SQL.heartbeats)).rows.map((row) => ({
      branchId: row.branch_id,
      deviceId: row.device_id,
      name: label(row.name),
      observedAt: iso(row.observed_at),
      ageSeconds: seconds(row.age_seconds),
    }));
    const overdue = (await client.query(WATCHDOG_SQL.unknownOverdue)).rows[0];
    const backlog = { 'kaspi-remote': 0, 'kaspi-qr': 0 };
    for (const row of (await client.query(WATCHDOG_SQL.paymentBacklog, [paymentBacklogMinutes]))
      .rows)
      backlog[row.provider] = row.orders;
    const kitchen = (await client.query(WATCHDOG_SQL.kitchenBacklog, [kitchenBacklogMinutes]))
      .rows[0];
    const reviews = { total: 0, codes: {}, newestSeconds: null, newestAt: null };
    for (const row of (await client.query(WATCHDOG_SQL.reviews, [reviewWindowHours])).rows) {
      const code = issueCode(row.code);
      reviews.total += row.issues;
      reviews.codes[code] = (reviews.codes[code] ?? 0) + row.issues;
      const newest = seconds(row.newest_seconds);
      if (newest !== null && (reviews.newestSeconds === null || newest < reviews.newestSeconds))
        reviews.newestSeconds = newest;
      // Database time of the newest case: compared run to run, independent of the watchdog clock.
      const at = iso(row.newest_at);
      if (at && (reviews.newestAt === null || at > reviews.newestAt)) reviews.newestAt = at;
    }
    const archiver = (await client.query(WATCHDOG_SQL.archiver)).rows[0];
    return {
      now: iso(now),
      identities,
      heartbeats,
      unknownOverdue: {
        'kaspi-remote-worker': overdue.kaspi_remote,
        'kiosk-qr-worker': overdue.kiosk_qr,
      },
      paymentBacklog: {
        'kaspi-remote-worker': backlog['kaspi-remote'],
        'kiosk-qr-worker': backlog['kaspi-qr'],
      },
      kitchenBacklog: {
        kitchen: kitchen.kitchen,
        admission: kitchen.admission,
        oldestSeconds: seconds(kitchen.oldest_seconds),
      },
      reviews,
      archiver: {
        mode: label(archiver.mode),
        archivedCount: Number(archiver.archived_count),
        failedCount: Number(archiver.failed_count),
        lastArchivedAt: iso(archiver.last_archived_time),
        lastFailedAt: iso(archiver.last_failed_time),
      },
    };
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** Maps a driver failure to a code; driver messages can mention hosts or roles, so they are dropped. */
export function databaseErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === '28P01' || code === '28000') return 'authentication_failed';
  if (code === '42501') return 'permission_denied';
  if (code === '57014') return 'timeout';
  if (code === '3D000' || code === '42P01') return 'schema_mismatch';
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET'].includes(code))
    return 'connection_failed';
  if (/timeout/i.test(String(error?.message ?? ''))) return 'connection_failed';
  return 'query_failed';
}
