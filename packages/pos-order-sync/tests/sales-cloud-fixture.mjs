// Shared synthetic posSales fixture of the cloud lane tests (sales-cloud*, sales-worker*).
// Synthetic data only: the pinned pos lane vectors moved to the test branch of each database.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { PosPaymentMethodSchema, SalesChannelSchema } from '@pickchick/contracts';
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
const sum = (values) => values.reduce((total, value) => total + BigInt(value), 0n).toString();
/**
 * The Z report the edge writes for the shift of `template` (pos lane buildShiftReport,
 * packages/local-orders/src/shift-reports.ts): all eight methods and all three channels in
 * contract order, from the sales of that shift and the refunds made in it, on top of the opening
 * cash, movements, counted cash and terminal total of `template` (with `change` applied first).
 */
export function zReportFor(events, template, change = {}) {
  const r = { ...copy(template), ...change };
  const of = (kinds) =>
    events
      .filter((event) => kinds.includes(event.kind) && event.payload.shift_id === r.shift_id)
      .map((event) => event.payload);
  const sales = of(['sale']),
    refunds = of(['void', 'refund']);
  const voided = new Set(
    events.filter((event) => event.kind === 'void').map((event) => event.payload.order_id),
  );
  r.methods = PosPaymentMethodSchema.options.map((method) => {
    const paid = sales.flatMap((sale) => sale.tenders).filter((t) => t.method === method);
    const back = refunds.flatMap((refund) => refund.tenders).filter((t) => t.method === method);
    return {
      method,
      sales_minor: sum(paid.map((t) => t.amount_minor)),
      refunds_minor: sum(back.map((t) => t.amount_minor)),
      count: paid.length,
    };
  });
  const row = (method) => r.methods.find((item) => item.method === method);
  r.cash_sales_minor = row('cash').sales_minor;
  r.cash_refunds_minor = row('cash').refunds_minor;
  r.expected_cash_minor = sum([
    r.opening_cash_minor,
    r.cash_in_minor,
    `-${r.cash_out_minor}`,
    r.cash_sales_minor,
    `-${r.cash_refunds_minor}`,
  ]);
  r.discrepancy_minor = sum([r.counted_cash_minor, `-${r.expected_cash_minor}`]);
  r.channels = SalesChannelSchema.options.map((channel) => {
    const inChannel = sales.filter((sale) => sale.sales_channel === channel);
    return {
      sales_channel: channel,
      total_minor: sum(inChannel.map((sale) => sale.total_minor)),
      count: inChannel.length,
    };
  });
  if (r.terminal_reported_minor !== null)
    r.terminal_discrepancy_minor = sum([
      r.terminal_reported_minor,
      `-${row('kaspi_terminal').sales_minor}`,
      row('kaspi_terminal').refunds_minor,
    ]);
  r.orders = {
    count: sales.length,
    voided_count: sales.filter((sale) => voided.has(sale.order_id)).length,
  };
  return r;
}

/**
 * All 14 vectors in their pinned order (sequences 1..14). The pinned Z vector lists only the cash
 * and Kaspi terminal rows (it is the Z of sales 1 and 2); in the full stream it is completed the
 * way the edge writes it, every method row of the shift, with the same cash figures.
 */
export const stream = (branch) => {
  const events = VECTOR_NAMES.map((name) => vectorEvent(name, branch));
  const z = events.find((event) => event.kind === 'shift_report').payload;
  z.report = zReportFor(events, z.report);
  return events;
};
/** The pinned vectors of one shift that took only cash and Kaspi terminal: its Z as pinned. */
export const CASH_TERMINAL_VECTORS = Object.freeze([
  'sale_cash_with_change',
  'sale_mixed_cash_kaspi_terminal',
  'void_cash_sale',
  'refund_terminal_part',
  'fiscal_sale_pending',
  'fiscal_sale_recorded',
  'fiscal_refund_pending',
  'shift_report_z',
]);

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
