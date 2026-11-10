import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@pickchick/database';
import { edgeInstallConfig } from '../../scripts/edge-migrate.mjs';

/**
 * Read-only preflight before the first PickChickPosSync Install (issue #312, step 4). Once the
 * worker runs, every unacknowledged `order_commercial` event of the point's producer and every
 * unacknowledged `edge_pos` kitchen event is delivered to the cloud, oldest first, including
 * test or old orders created before the cutover. This report lets the owner see that backlog
 * before deciding; it changes nothing and has no "skip" mode (the source rows are immutable,
 * migration 008).
 *
 *   node --env-file=<owner.env> infra/windows/pos-sync-backlog.mjs
 *
 * Output: one JSON line of counts, sums in minor units and time bounds only. No order, event,
 * staff or device identifier, payload or item is printed.
 */
const iso = (value) => (value instanceof Date ? value.toISOString() : null);

export function backlogConfig(env = process.env) {
  const config = edgeInstallConfig(env);
  const url = new URL(config.databaseUrl);
  if (
    config.environment !== 'local' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55433' ||
    url.pathname !== '/pickchick_edge'
  )
    throw new Error('Local point database environment required');
  return config;
}

/** One READ ONLY transaction over the point database of `branchId`. */
export async function posSyncBacklog(pool, branchId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const one = async (sql, args = [branchId]) => (await client.query(sql, args)).rows[0];
    const ledger = await one(
      "SELECT count(*)::int AS migrations, max(version) AS latest FROM schema_migrations WHERE scope='edge'",
      [],
    );
    const stream = await one(
      'SELECT producer_id, last_sequence::text AS last_sequence FROM local_order_streams WHERE branch_id=$1',
    );
    const sync = await one(
      `SELECT active, pending_event_id IS NOT NULL AS pending, failure_count, last_error
         FROM pos_order_sync_state WHERE branch_id=$1`,
    );
    const orders = await one(
      `SELECT count(*)::int AS total,
         count(*) FILTER(WHERE state='awaiting_payment')::int AS awaiting_payment,
         count(*) FILTER(WHERE state='cancelled')::int AS cancelled,
         coalesce(sum(total_minor),0)::text AS total_minor,
         min(created_at) AS first_at, max(created_at) AS last_at
       FROM local_orders WHERE branch_id=$1`,
    );
    const events = await one(
      `SELECT count(*) FILTER(WHERE acknowledged_at IS NULL)::int AS unacknowledged,
         count(*) FILTER(WHERE acknowledged_at IS NULL AND event_type='order.created')::int AS created,
         count(*) FILTER(WHERE acknowledged_at IS NULL AND event_type='order.cancelled')::int AS cancelled,
         count(*) FILTER(WHERE acknowledged_at IS NOT NULL)::int AS acknowledged,
         count(DISTINCT producer_id) FILTER(WHERE acknowledged_at IS NULL)::int AS producers,
         count(*) FILTER(WHERE acknowledged_at IS NULL AND producer_id IS DISTINCT FROM $2)::int AS foreign_producer,
         min(occurred_at) FILTER(WHERE acknowledged_at IS NULL) AS first_at,
         max(occurred_at) FILTER(WHERE acknowledged_at IS NULL) AS last_at
       FROM outbox_events WHERE branch_id=$1 AND aggregate_type='order_commercial'
         AND event_type IN('order.created','order.cancelled')`,
      [branchId, stream?.producer_id ?? null],
    );
    const kitchenInstalled = (
      await one(
        `SELECT to_regclass('pos_kitchen_sync_state') IS NOT NULL AND to_regclass('fulfillment_outbox') IS NOT NULL AS ok`,
        [],
      )
    ).ok;
    const kitchen = kitchenInstalled
      ? await one(
          `SELECT count(*) FILTER(WHERE acknowledged_at IS NULL)::int AS unacknowledged,
             min(occurred_at) FILTER(WHERE acknowledged_at IS NULL) AS first_at,
             max(occurred_at) FILTER(WHERE acknowledged_at IS NULL) AS last_at,
             (SELECT count(*)::int FROM pos_kitchen_sync_state WHERE branch_id=$1) AS sync_rows
           FROM fulfillment_outbox WHERE branch_id=$1 AND payload->>'commercialOwner'='edge_pos'`,
        )
      : null;
    await client.query('COMMIT');
    const wouldSend = events.unacknowledged + (kitchen?.unacknowledged ?? 0);
    return {
      event: 'pos_sync_backlog',
      checked_at: new Date().toISOString(),
      migrations: ledger.migrations,
      latest_migration: ledger.latest,
      producer_stream: stream ? { last_sequence: stream.last_sequence } : null,
      order_sync: sync
        ? {
            bound: true,
            active: sync.active,
            pending: sync.pending,
            failure_count: sync.failure_count,
            last_error: sync.last_error,
          }
        : { bound: false },
      local_orders: {
        total: orders.total,
        awaiting_payment: orders.awaiting_payment,
        cancelled: orders.cancelled,
        total_minor: orders.total_minor,
        first_at: iso(orders.first_at),
        last_at: iso(orders.last_at),
      },
      order_events: {
        unacknowledged: events.unacknowledged,
        created: events.created,
        cancelled: events.cancelled,
        acknowledged: events.acknowledged,
        producers: events.producers,
        foreign_producer: events.foreign_producer,
        first_at: iso(events.first_at),
        last_at: iso(events.last_at),
      },
      kitchen_events: kitchen
        ? {
            unacknowledged: kitchen.unacknowledged,
            sync_rows: kitchen.sync_rows,
            first_at: iso(kitchen.first_at),
            last_at: iso(kitchen.last_at),
          }
        : null,
      would_send_on_install: wouldSend,
      decision_required: wouldSend > 0,
      changed: false,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main(env = process.env) {
  let pool;
  try {
    if (process.argv.length > 2) throw new Error('No arguments');
    const config = backlogConfig(env);
    pool = createPool(config.databaseUrl, 1);
    console.log(JSON.stringify(await posSyncBacklog(pool, config.branchId)));
  } catch {
    // Never the connection string, SQL or driver text.
    console.error(JSON.stringify({ event: 'pos_sync_backlog_failed', changed: false }));
    process.exitCode = 1;
  } finally {
    await pool?.end().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
