// Shared synthetic posSales fixture of the cloud lane tests (sales-cloud*, sales-worker*).
// Synthetic data only: the pinned pos lane vectors moved to the test branch of each database.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { hashJson, provisionDevice } from '@pickchick/menu-sync';
import { provisionCloudPosSync, provisionEdgePosSync } from '../dist/index.js';
import { withSyncDatabases } from '../../../tests/helpers/sync.mjs';

export const { vectors } = JSON.parse(
  await readFile(new URL('./fixtures/pos-sale-vectors.json', import.meta.url), 'utf8'),
);
export const VECTOR_NAMES = Object.keys(vectors);
export const copy = (value) => globalThis.structuredClone(value);

/** The vector event of `name` on `branch` (envelope and quote), with an optional change. */
export function vectorEvent(name, branch, change = () => {}) {
  const event = copy(vectors[name].event);
  event.branch_id = branch;
  if (event.kind === 'sale') event.payload.quote.branch_id = branch;
  change(event.payload, event);
  return event;
}
/** All 14 vectors in their pinned order (sequences 1..14). */
export const stream = (branch) => VECTOR_NAMES.map((name) => vectorEvent(name, branch));

/** A fresh cash sale (own order, quote and tender ids) for bulk ordering tests. */
export function cashSale(branch, sequence, displayNumber = 1) {
  return vectorEvent('sale_cash_with_change', branch, (payload, event) => {
    event.event_id = randomUUID();
    event.sequence = String(sequence);
    payload.order_id = randomUUID();
    payload.quote.quote_id = randomUUID();
    payload.display_number = displayNumber;
    payload.tenders[0].tender_id = randomUUID();
  });
}

const migrations = (scope) =>
  fileURLToPath(new URL(`../../../db/${scope}/migrations/`, import.meta.url));
/** A migration directory holding only the files up to `last` (older schema of a scope). */
export async function migrationsUpTo(scope, last) {
  const directory = await mkdtemp(join(tmpdir(), `pickchick-${scope}-${last}-`));
  for (const name of await readdir(migrations(scope)))
    if (/^\d{3}_[a-z_]+\.sql$/.test(name) && Number(name.slice(0, 3)) <= last)
      await symlink(join(migrations(scope), name), join(directory, name));
  return { directory, remove: () => rm(directory, { recursive: true, force: true }) };
}

/**
 * Cloud and edge schemas with a provisioned edge device, its POS sync binding on both sides
 * (the posSales stream uses the same binding) and its device identity.
 */
export async function withPosSalesDatabases(run, options = {}) {
  await withSyncDatabases(async (context) => {
    const identity = await provisionDevice(context.cloud.pool, context.device);
    const scope = await provisionEdgePosSync(context.edge.pool, {
      organizationId: context.org,
      branchId: context.branch,
      deviceId: context.device,
    });
    await provisionCloudPosSync(context.cloud.pool, scope);
    await run({ ...context, identity, scope });
  }, options);
}

/** Writes events into the edge outbox the way the pos lane does (payload_hash = hashJson). */
export async function enqueue(edgePool, events, { hash } = {}) {
  const rows = [];
  for (const event of events) {
    const entity = {
      sale: event.payload.order_id,
      void: event.payload.refund_id,
      refund: event.payload.refund_id,
      fiscal: event.payload.receipt_id,
      shift_report: event.payload.shift_id,
    }[event.kind];
    const row = (
      await edgePool.query(
        `INSERT INTO pos_sale_outbox(event_id,branch_id,kind,entity_id,payload,payload_hash,occurred_at)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING event_id,sequence::text AS sequence`,
        [
          event.event_id,
          event.branch_id,
          event.kind,
          entity,
          event.payload,
          hash ?? hashJson(event.payload),
          event.occurred_at,
        ],
      )
    ).rows[0];
    rows.push(row);
  }
  return rows;
}
/** The event the edge sends for an outbox row (its own sequence and timestamp). */
export const sentAs = (event, row) => ({ ...event, sequence: row.sequence });

export const headersFor = (identity) => ({
  Authorization: `Bearer ${identity.token}`,
  'X-Device-Id': identity.device_id,
  'Content-Type': 'application/json',
});
export const SALES_PATH = '/internal/v1/edge/pos-orders/sales';
