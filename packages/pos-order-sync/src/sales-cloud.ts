import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { transaction } from '@pickchick/database';
import { authenticateDevice, hashJson } from '@pickchick/menu-sync';
import type { DeviceAuth } from '@pickchick/menu-sync';
import { PosSyncError } from './model.js';
import {
  PosSaleBatchResultSchema,
  parsePosSaleBatch,
  parsePosSaleEvent,
  posSalePayloadHash,
  posSaleReceiptFor,
} from './sales-model.js';
import type { PosSaleBatchResult, PosSaleEvent } from './sales-model.js';

/**
 * Cloud receiver of the posSales stream (contracts 5.6, lane cloud CC-4). The edge owns sales,
 * tenders, refunds, receipts and Z reports; this module only projects what the stream delivers
 * into cloud_pos_* (cloud073) and never changes a commercial aggregate of its own.
 *
 * One request is `{events: PosSaleEvent[0..50]}` in edge sequence order; `{events: []}` is the
 * support probe. Every event runs in its own transaction and gets its receipt only after that
 * transaction committed, so the answer is the accepted prefix in order. The first event that
 * cannot be accepted ends the batch as `rejected`: CONFLICT when its event id or (device,
 * sequence) is already known with another identity or payload hash, INVALID_EVENT when it fails
 * the wire model or the arithmetic against the stored projection (tender sums, change, refunds
 * per tender, void of the whole sale, receipt amounts and versions, Z cash against the shift's
 * sales and refunds). The edge then parks the stream; nothing of the rejected event is stored.
 * Without schema073 (or the receiver grants) the route answers 404, like a cloud before CC-4.
 */

export type PosSaleRejectCode = 'CONFLICT' | 'INVALID_EVENT';
/** Diagnostic of a rejected event: ids and a fixed reason token, never payload text. */
export interface PosSaleRejection {
  event_id: string;
  kind: string;
  code: PosSaleRejectCode;
  reason: string;
}
export interface ReceivePosSalesOptions {
  onRejected?: (rejection: PosSaleRejection) => void;
}

class Rejection extends Error {
  constructor(
    readonly code: PosSaleRejectCode,
    readonly reason: string,
  ) {
    super(code);
  }
}
function invalid(reason: string): never {
  throw new Rejection('INVALID_EVENT', reason);
}
const id = (value: string) => value.toLowerCase();

/** Whether schema073 is installed and this role may receive (else the route is a 404). */
async function receiverReady(client: DatabaseClient) {
  const row = (
    await client.query<{ ready: boolean }>(
      `SELECT CASE WHEN to_regclass('cloud_pos_sale_inbox') IS NULL OR to_regclass('cloud_pos_shift_reports') IS NULL
         THEN false ELSE (
           has_table_privilege('cloud_pos_sale_inbox','SELECT') AND has_table_privilege('cloud_pos_sale_inbox','INSERT') AND
           has_table_privilege('cloud_pos_sales','SELECT') AND has_table_privilege('cloud_pos_sales','INSERT') AND
           has_column_privilege('cloud_pos_sales','state','UPDATE') AND
           has_column_privilege('cloud_pos_sales','voided_at','UPDATE') AND
           has_column_privilege('cloud_pos_sales','last_sequence','UPDATE') AND
           has_table_privilege('cloud_pos_tenders','SELECT') AND has_table_privilege('cloud_pos_tenders','INSERT') AND
           has_table_privilege('cloud_pos_refunds','SELECT') AND has_table_privilege('cloud_pos_refunds','INSERT') AND
           has_table_privilege('cloud_pos_refund_tenders','SELECT') AND
           has_table_privilege('cloud_pos_refund_tenders','INSERT') AND
           has_table_privilege('cloud_pos_fiscal_receipts','SELECT') AND
           has_table_privilege('cloud_pos_fiscal_receipts','INSERT') AND
           has_column_privilege('cloud_pos_fiscal_receipts','state','UPDATE') AND
           has_column_privilege('cloud_pos_fiscal_receipts','version','UPDATE') AND
           has_table_privilege('cloud_pos_shift_reports','SELECT') AND
           has_table_privilege('cloud_pos_shift_reports','INSERT')) END AS ready`,
    )
  ).rows[0];
  return row?.ready === true;
}

/**
 * The device is an active edge with an active POS sync binding of its branch (the same trusted
 * operator binding as the order and kitchen streams). The row lock serializes the deliveries of
 * one branch, so a repeated request always sees the committed inbox of the previous one.
 */
async function authorize(client: DatabaseClient, auth: DeviceAuth, branchId: string | null) {
  const branch = await authenticateDevice(client, auth);
  const binding = (
    await client.query<{ active: boolean }>(
      `SELECT b.active FROM pos_order_sync_bindings b JOIN devices d ON d.id=b.device_id
       WHERE b.branch_id=$1 AND b.device_id=$2 AND d.organization_id=b.organization_id FOR UPDATE OF b`,
      [branch, auth.deviceId],
    )
  ).rows[0];
  if (!binding?.active || (branchId !== null && id(branchId) !== branch))
    throw new PosSyncError('FORBIDDEN');
  return branch;
}

type SaleRow = {
  order_id: string;
  branch_id: string;
  device_id: string;
  state: 'paid' | 'voided';
  total_minor: string;
  last_sequence: string;
};
async function storedSale(client: DatabaseClient, branch: string, device: string, order: string) {
  const sale = (
    await client.query<SaleRow>(
      `SELECT order_id,branch_id,device_id,state,total_minor::text AS total_minor,
       last_sequence::text AS last_sequence FROM cloud_pos_sales WHERE order_id=$1 FOR UPDATE`,
      [order],
    )
  ).rows[0];
  // Another branch or device never sees or moves this sale.
  if (!sale || sale.branch_id !== branch || sale.device_id !== device)
    return invalid('sale_unknown');
  return sale;
}

async function applySale(
  client: DatabaseClient,
  branch: string,
  device: string,
  event: PosSaleEvent & { kind: 'sale' },
) {
  const p = event.payload,
    q = p.quote;
  const known = (
    await client.query<{ sales: number; tenders: number }>(
      `SELECT (SELECT count(*) FROM cloud_pos_sales WHERE order_id=$1)::integer AS sales,
       (SELECT count(*) FROM cloud_pos_tenders WHERE tender_id=ANY($2::uuid[]))::integer AS tenders`,
      [p.order_id, p.tenders.map((tender) => tender.tender_id)],
    )
  ).rows[0]!;
  if (known.sales || known.tenders) invalid('sale_identity');
  await client.query(
    `INSERT INTO cloud_pos_sales(order_id,branch_id,device_id,shift_id,terminal_id,cashier_staff_id,
     display_number,sold_at,business_date,sales_channel,service_mode,revenue_kind,external_order_ref,
     subtotal_minor,discount_minor,total_minor,cash_tendered_minor,change_minor,beneficiary,reason,
     approval_id,approval_manager_staff_id,release_id,menu_version,lines,state,last_sequence)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,($8::timestamptz AT TIME ZONE 'Asia/Almaty')::date,
     $9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb,'paid',$25)`,
    [
      p.order_id,
      branch,
      device,
      p.shift_id,
      p.terminal_id,
      p.cashier_staff_id,
      p.display_number,
      p.created_at,
      p.sales_channel,
      p.service_mode,
      p.revenue_kind,
      p.external_order_ref,
      q.subtotal_minor,
      q.discount_minor,
      p.total_minor,
      p.cash_tendered_minor,
      p.change_minor,
      p.beneficiary,
      p.reason,
      p.approval?.approval_id ?? null,
      p.approval?.manager_staff_id ?? null,
      q.release_id,
      q.menu_version,
      JSON.stringify(q.lines),
      event.sequence,
    ],
  );
  for (const tender of p.tenders)
    await client.query(
      `INSERT INTO cloud_pos_tenders(tender_id,order_id,branch_id,method,amount_minor,confirmation,
       reference,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        tender.tender_id,
        p.order_id,
        branch,
        tender.method,
        tender.amount_minor,
        tender.confirmation,
        tender.reference,
        p.created_at,
      ],
    );
}

/**
 * A void returns the whole paid sale as its only refund (edge schema026); a refund returns part
 * of tenders the sale still holds. Every part names a tender of this sale with its method and
 * never takes more than that tender paid minus what was already returned on it.
 */
async function applyRefund(
  client: DatabaseClient,
  branch: string,
  device: string,
  event: PosSaleEvent & { kind: 'void' | 'refund' },
) {
  const p = event.payload;
  const sale = await storedSale(client, branch, device, p.order_id);
  if (sale.state !== 'paid') invalid('sale_voided');
  if (
    (await client.query('SELECT 1 FROM cloud_pos_refunds WHERE refund_id=$1', [p.refund_id]))
      .rowCount
  )
    invalid('refund_identity');
  const tenders = new Map(
    (
      await client.query<{ tender_id: string; method: string; amount_minor: string }>(
        `SELECT tender_id,method,amount_minor::text AS amount_minor FROM cloud_pos_tenders
         WHERE order_id=$1 AND branch_id=$2`,
        [sale.order_id, branch],
      )
    ).rows.map((row) => [row.tender_id, row]),
  );
  const refunded = new Map(
    (
      await client.query<{ tender_id: string; amount_minor: string }>(
        `SELECT tender_id,sum(amount_minor)::text AS amount_minor FROM cloud_pos_refund_tenders
         WHERE order_id=$1 AND branch_id=$2 GROUP BY tender_id`,
        [sale.order_id, branch],
      )
    ).rows.map((row) => [row.tender_id, BigInt(row.amount_minor)]),
  );
  for (const part of p.tenders) {
    const tender = tenders.get(id(part.tender_id));
    if (!tender || tender.method !== part.method) invalid('refund_tender');
    if (
      (refunded.get(tender.tender_id) ?? 0n) + BigInt(part.amount_minor) >
      BigInt(tender.amount_minor)
    )
      invalid('refund_limit');
  }
  if (event.kind === 'void') {
    if (
      refunded.size ||
      (
        await client.query('SELECT 1 FROM cloud_pos_refunds WHERE order_id=$1 AND branch_id=$2', [
          sale.order_id,
          branch,
        ])
      ).rowCount ||
      p.tenders.length !== tenders.size ||
      p.tenders.some(
        (part) => tenders.get(id(part.tender_id))?.amount_minor !== part.amount_minor,
      ) ||
      BigInt(p.amount_minor) !== BigInt(sale.total_minor)
    )
      invalid('void_not_whole');
    if (BigInt(event.sequence) <= BigInt(sale.last_sequence)) invalid('void_sequence');
  }
  await client.query(
    `INSERT INTO cloud_pos_refunds(refund_id,order_id,branch_id,kind,amount_minor,reason_code,reason,
     staff_id,approved_by_staff_id,approval_id,terminal_id,shift_id,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      p.refund_id,
      sale.order_id,
      branch,
      p.kind,
      p.amount_minor,
      p.reason_code,
      p.reason,
      p.staff_id,
      p.approved_by_staff_id,
      p.approval_id,
      p.terminal_id,
      p.shift_id,
      p.created_at,
    ],
  );
  for (const part of p.tenders)
    await client.query(
      `INSERT INTO cloud_pos_refund_tenders(refund_id,tender_id,order_id,branch_id,method,amount_minor)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [p.refund_id, part.tender_id, sale.order_id, branch, part.method, part.amount_minor],
    );
  if (event.kind === 'void')
    await client.query(
      `UPDATE cloud_pos_sales SET state='voided',voided_at=$2,last_sequence=$3 WHERE order_id=$1`,
      [sale.order_id, p.created_at, event.sequence],
    );
}

type ReceiptRow = {
  order_id: string;
  branch_id: string;
  refund_id: string | null;
  kind: string;
  mode: string;
  state: string;
  version: number;
  amount_minor: string;
};
/**
 * The whole receipt record after each change: one receipt per sale and per refund, its amount is
 * the sale total or the refund amount, and only a newer version replaces it (cloud073 trigger:
 * never back from recorded, never out of not_required).
 */
async function applyFiscal(
  client: DatabaseClient,
  branch: string,
  device: string,
  event: PosSaleEvent & { kind: 'fiscal' },
) {
  const p = event.payload;
  const sale = await storedSale(client, branch, device, p.order_id);
  let amount = sale.total_minor;
  if (p.refund_id !== null) {
    const refund = (
      await client.query<{ amount_minor: string }>(
        `SELECT amount_minor::text AS amount_minor FROM cloud_pos_refunds
         WHERE refund_id=$1 AND order_id=$2 AND branch_id=$3`,
        [p.refund_id, sale.order_id, branch],
      )
    ).rows[0];
    if (!refund) invalid('receipt_refund_unknown');
    amount = refund.amount_minor;
  }
  if (BigInt(p.amount_minor) !== BigInt(amount)) invalid('receipt_amount');
  const existing = (
    await client.query<ReceiptRow>(
      `SELECT order_id,branch_id,refund_id,kind,mode,state,version,amount_minor::text AS amount_minor
       FROM cloud_pos_fiscal_receipts WHERE receipt_id=$1 FOR UPDATE`,
      [p.receipt_id],
    )
  ).rows[0];
  if (!existing) {
    const sibling = await client.query(
      `SELECT 1 FROM cloud_pos_fiscal_receipts WHERE order_id=$1 AND branch_id=$2 AND kind=$3
       AND refund_id IS NOT DISTINCT FROM $4::uuid`,
      [sale.order_id, branch, p.kind, p.refund_id],
    );
    if (sibling.rowCount) invalid('receipt_identity');
    await client.query(
      `INSERT INTO cloud_pos_fiscal_receipts(receipt_id,order_id,branch_id,refund_id,kind,mode,state,
       receipt_number,version,amount_minor,recorded_by_staff_id,recorded_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        p.receipt_id,
        sale.order_id,
        branch,
        p.refund_id,
        p.kind,
        p.mode,
        p.state,
        p.receipt_number,
        p.version,
        p.amount_minor,
        p.recorded_by_staff_id,
        p.recorded_at,
      ],
    );
    return;
  }
  if (
    existing.order_id !== sale.order_id ||
    existing.branch_id !== branch ||
    existing.refund_id !== (p.refund_id === null ? null : id(p.refund_id)) ||
    existing.kind !== p.kind ||
    existing.mode !== p.mode ||
    BigInt(existing.amount_minor) !== BigInt(p.amount_minor)
  )
    invalid('receipt_identity');
  if (
    p.version <= existing.version ||
    existing.state === 'not_required' ||
    (existing.state === 'recorded' && p.state !== 'recorded')
  )
    invalid('receipt_version');
  await client.query(
    `UPDATE cloud_pos_fiscal_receipts SET state=$2,receipt_number=$3,version=$4,
     recorded_by_staff_id=$5,recorded_at=$6 WHERE receipt_id=$1`,
    [p.receipt_id, p.state, p.receipt_number, p.version, p.recorded_by_staff_id, p.recorded_at],
  );
}

type ShiftReportEvent = PosSaleEvent & { kind: 'shift_report' };
type ShiftReport = ShiftReportEvent['payload']['report'];
/** Tenders of the shift's sales and the refund parts paid at the shift, per method (cloud rows). */
interface ShiftProjection {
  sales: Map<string, { method: string; sales_minor: string; count: number }>;
  refunds: Map<string, string>;
}
async function shiftProjection(
  client: DatabaseClient,
  branch: string,
  shiftId: string,
): Promise<ShiftProjection> {
  const sales = new Map(
    (
      await client.query<{ method: string; sales_minor: string; count: number }>(
        `SELECT t.method,sum(t.amount_minor)::text AS sales_minor,count(*)::integer AS count
         FROM cloud_pos_tenders t JOIN cloud_pos_sales s ON s.order_id=t.order_id AND s.branch_id=t.branch_id
         WHERE s.branch_id=$1 AND s.shift_id=$2 GROUP BY t.method`,
        [branch, shiftId],
      )
    ).rows.map((row) => [row.method, row]),
  );
  const refunds = new Map(
    (
      await client.query<{ method: string; refunds_minor: string }>(
        `SELECT t.method,sum(t.amount_minor)::text AS refunds_minor FROM cloud_pos_refund_tenders t
         JOIN cloud_pos_refunds f ON f.refund_id=t.refund_id AND f.branch_id=t.branch_id
         WHERE f.branch_id=$1 AND f.shift_id=$2 GROUP BY t.method`,
        [branch, shiftId],
      )
    ).rows.map((row) => [row.method, row.refunds_minor]),
  );
  return { sales, refunds };
}
/** The first check of the Z against the projection that fails, or null when they agree. */
function shiftMismatch(r: ShiftReport, { sales, refunds }: ShiftProjection) {
  if (
    BigInt(r.cash_sales_minor) !== BigInt(sales.get('cash')?.sales_minor ?? '0') ||
    BigInt(r.cash_refunds_minor) !== BigInt(refunds.get('cash') ?? '0')
  )
    return 'shift_cash' as const;
  const listed = new Set<string>(r.methods.map((row) => row.method));
  if (
    r.methods.some(
      (row) =>
        BigInt(row.sales_minor) !== BigInt(sales.get(row.method)?.sales_minor ?? '0') ||
        BigInt(row.refunds_minor) !== BigInt(refunds.get(row.method) ?? '0') ||
        row.count !== (sales.get(row.method)?.count ?? 0),
    ) ||
    // A method the shift took or returned money with must have its own row in the Z report.
    [...sales.keys(), ...refunds.keys()].some((method) => !listed.has(method))
  )
    return 'shift_methods' as const;
  return null;
}
async function shiftReportStored(client: DatabaseClient, shiftId: string) {
  return !!(
    await client.query('SELECT 1 FROM cloud_pos_shift_reports WHERE shift_id=$1', [shiftId])
  ).rowCount;
}
/** The Z report row exactly as the edge wrote it. */
async function insertShiftReport(
  client: DatabaseClient,
  branch: string,
  device: string,
  event: ShiftReportEvent,
) {
  const p = event.payload,
    r = p.report;
  await client.query(
    `INSERT INTO cloud_pos_shift_reports(shift_id,branch_id,device_id,terminal_id,opened_at,closed_at,
     report,expected_cash_minor,counted_cash_minor,discrepancy_minor,terminal_reported_minor)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)`,
    [
      p.shift_id,
      branch,
      device,
      p.terminal_id,
      r.opened_at,
      r.closed_at,
      JSON.stringify(r),
      r.expected_cash_minor,
      r.counted_cash_minor,
      r.discrepancy_minor,
      r.terminal_reported_minor,
    ],
  );
}

/**
 * The frozen Z report of a closed sales shift. Its own arithmetic (expected cash, discrepancy,
 * terminal) is checked by the wire model; here its cash and every method row it lists must equal
 * the projected tenders of the shift's sales and refund parts paid at the shift, exactly as the
 * edge computed them (schema026 pos_shift_cash), and no method with projected sales or refunds
 * may be missing from it (the edge always lists all eight methods, zero rows included).
 */
async function applyShiftReport(
  client: DatabaseClient,
  branch: string,
  device: string,
  event: ShiftReportEvent,
) {
  if (await shiftReportStored(client, event.payload.shift_id)) invalid('shift_identity');
  const mismatch = shiftMismatch(
    event.payload.report,
    await shiftProjection(client, branch, event.payload.shift_id),
  );
  if (mismatch) invalid(mismatch);
  await insertShiftReport(client, branch, device, event);
}

/**
 * Where the inbox stands on this event: `new` when neither its id nor its (device, sequence) is
 * known, `duplicate` when exactly this event was accepted, `conflict` when either is held by
 * another identity or payload hash.
 */
async function inboxState(
  client: DatabaseClient,
  branch: string,
  device: string,
  event: PosSaleEvent,
  hash: string,
) {
  const previous = (
    await client.query<{
      event_id: string;
      branch_id: string;
      device_id: string;
      sequence: string;
      kind: string;
      payload_hash: string;
    }>(
      `SELECT event_id,branch_id,device_id,sequence::text AS sequence,kind,payload_hash
       FROM cloud_pos_sale_inbox WHERE event_id=$1 OR (device_id=$2 AND sequence=$3)`,
      [event.event_id, device, event.sequence],
    )
  ).rows;
  if (!previous.length) return 'new' as const;
  const row = previous[0]!;
  return previous.length !== 1 ||
    row.event_id !== id(event.event_id) ||
    row.branch_id !== branch ||
    row.device_id !== device ||
    row.sequence !== event.sequence ||
    row.kind !== event.kind ||
    row.payload_hash !== hash
    ? ('conflict' as const)
    : ('duplicate' as const);
}
async function insertInbox(
  client: DatabaseClient,
  branch: string,
  device: string,
  event: PosSaleEvent,
  hash: string,
) {
  await client.query(
    `INSERT INTO cloud_pos_sale_inbox(event_id,branch_id,device_id,sequence,kind,payload_hash)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [event.event_id, branch, device, event.sequence, event.kind, hash],
  );
}

async function receiveOne(client: DatabaseClient, auth: DeviceAuth, event: PosSaleEvent) {
  const branch = await authorize(client, auth, event.branch_id),
    device = id(auth.deviceId),
    hash = posSalePayloadHash(event);
  const known = await inboxState(client, branch, device, event, hash);
  if (known === 'conflict') throw new Rejection('CONFLICT', 'identity');
  if (known === 'duplicate') return 'duplicate' as const;
  switch (event.kind) {
    case 'sale':
      await applySale(client, branch, device, event);
      break;
    case 'void':
    case 'refund':
      await applyRefund(client, branch, device, event);
      break;
    case 'fiscal':
      await applyFiscal(client, branch, device, event);
      break;
    case 'shift_report':
      await applyShiftReport(client, branch, device, event);
      break;
  }
  await insertInbox(client, branch, device, event, hash);
  return 'accepted' as const;
}

/** Constraint and data errors of one event are its rejection; anything else is retried. */
const dataError = (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  typeof error.code === 'string' &&
  /^(?:22|23)[0-9A-Z]{3}$/.test(error.code);

/**
 * POST /internal/v1/edge/pos-orders/sales (CLOUD_POS_SALES_SYNC_ENABLED). Throws PosSyncError
 * (NOT_FOUND without schema073, INVALID_REQUEST for a malformed batch, FORBIDDEN without an
 * active binding of the batch branch) or the device SyncError UNAUTHORIZED.
 */
export async function receivePosSales(
  pool: DatabasePool,
  auth: DeviceAuth,
  input: unknown,
  options: ReceivePosSalesOptions = {},
): Promise<PosSaleBatchResult> {
  const ready = await transaction(pool, receiverReady);
  if (!ready) throw new PosSyncError('NOT_FOUND');
  const batch = parsePosSaleBatch(input);
  // The probe and the batch branch are authorized before any event is looked at.
  await transaction(pool, (client) => authorize(client, auth, batch.events[0]?.branch_id ?? null));
  const raw = (input as { events: unknown[] }).events;
  const receipts: PosSaleBatchResult['receipts'] = [];
  for (const [index, listed] of batch.events.entries()) {
    const reject = (code: PosSaleRejectCode, reason: string) => {
      options.onRejected?.({ event_id: listed.event_id, kind: listed.kind, code, reason });
      return PosSaleBatchResultSchema.parse({
        receipts,
        rejected: { event_id: listed.event_id, code },
      });
    };
    let event: PosSaleEvent;
    try {
      event = parsePosSaleEvent(raw[index]);
    } catch {
      return reject('INVALID_EVENT', 'model');
    }
    try {
      await transaction(pool, (client) => receiveOne(client, auth, event));
    } catch (error) {
      if (error instanceof Rejection) return reject(error.code, error.reason);
      if (dataError(error)) return reject('INVALID_EVENT', 'constraint');
      throw error;
    }
    // Only a committed event is acknowledged.
    receipts.push(posSaleReceiptFor(event));
  }
  return PosSaleBatchResultSchema.parse({ receipts });
}

// ------------------------------------------------- Z of a shift open across an edge restore ----

/**
 * edge_restore_fence (edge 026 after CR cloud-5 item 1; until then the owner step of the runbook
 * «Восстановление базы кассы») moves the posSales number of a restored edge by this gap. A shift
 * holding a sale whose last event is at least half of it below the Z was open while the edge
 * database came back from a copy: no shift spans 5*10^8 events of one device.
 */
const RESTORE_FENCE_GAP = 1_000_000_000n;
export type RestoredShiftReportRefusal =
  | 'request'
  | 'model'
  | 'not_shift_report'
  | 'schema'
  | 'not_owner'
  | 'request_reused'
  | 'actor'
  | 'binding'
  | 'identity'
  | 'shift_identity'
  | 'not_head'
  | 'not_parked'
  | 'not_restore';
/** A refusal of acceptRestoredShiftReport: the PosSyncError code and a fixed reason token. */
export class RestoredShiftReportError extends PosSyncError {
  constructor(
    code: PosSyncError['code'],
    readonly reason: RestoredShiftReportRefusal,
  ) {
    super(code);
  }
}
function refuse(code: PosSyncError['code'], reason: RestoredShiftReportRefusal): never {
  throw new RestoredShiftReportError(code, reason);
}
export const RestoredShiftReportRequestSchema = z.strictObject({
  branchId: z.uuid(),
  deviceId: z.uuid(),
  /** Back-office actor with the manager grant on the branch who decided it (bo_audit). */
  actorId: z.uuid(),
  /** Idempotency key of the command (bo_commands, with the digest of the request). */
  requestId: z.uuid(),
  reason: z.string().trim().min(3).max(300),
  /** payload_hash of the edge outbox row; the event must hash to it, as the sender checks. */
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** The parked shift_report event exactly as the edge sends it (pos_sale_outbox row). */
  event: z.unknown(),
});
export type RestoredShiftReportRequest = z.input<typeof RestoredShiftReportRequestSchema>;
/** Per method: what the Z says and what the cloud holds from the sales and refunds stream. */
export interface RestoredShiftReportMethod {
  method: string;
  z_sales_minor: string;
  cloud_sales_minor: string;
  z_refunds_minor: string;
  cloud_refunds_minor: string;
  z_count: number;
  cloud_count: number;
}
export type RestoredShiftReportResult =
  | {
      state: 'accepted';
      event_id: string;
      sequence: string;
      shift_id: string;
      rejected_as: 'shift_cash' | 'shift_methods';
      cash: {
        z_sales_minor: string;
        cloud_sales_minor: string;
        z_refunds_minor: string;
        cloud_refunds_minor: string;
      };
      methods: RestoredShiftReportMethod[];
    }
  | { state: 'duplicate'; event_id: string; sequence: string; shift_id: string };

function methodRows(r: ShiftReport, projection: ShiftProjection): RestoredShiftReportMethod[] {
  const listed = r.methods.map((row) => row.method as string);
  const methods = [
    ...listed,
    ...[...projection.sales.keys(), ...projection.refunds.keys()].filter(
      (method, index, all) => !listed.includes(method) && all.indexOf(method) === index,
    ),
  ];
  return methods.map((method) => {
    const row = r.methods.find((item) => item.method === method);
    return {
      method,
      z_sales_minor: BigInt(row?.sales_minor ?? '0').toString(),
      cloud_sales_minor: BigInt(projection.sales.get(method)?.sales_minor ?? '0').toString(),
      z_refunds_minor: BigInt(row?.refunds_minor ?? '0').toString(),
      cloud_refunds_minor: BigInt(projection.refunds.get(method) ?? '0').toString(),
      z_count: row?.count ?? 0,
      cloud_count: projection.sales.get(method)?.count ?? 0,
    };
  });
}

/**
 * CR cloud-5 item 2, option A (lead decision 06.11): the cloud database owner accepts, exactly as
 * the edge wrote it, the Z report of a sales shift that was open while the edge database came
 * back from a copy. The restored edge lacks the sales and refunds of the lost timeline that the
 * cloud already holds, so the receiver refuses that Z (INVALID_EVENT, shift_cash or
 * shift_methods), the edge parks it and every later event of the device waits behind it.
 *
 * Only that case is accepted. The event parses as the receiver parses it and hashes to the edge
 * outbox payload_hash; it is a shift_report of this branch and device; neither its event id nor
 * its (device, sequence) nor its shift is known yet; nothing of the device after it was accepted
 * (it heads the parked stream); the receiver would refuse it now with shift_cash or
 * shift_methods; the cloud holds at least what the Z counts in cash and in every method (the Z
 * misses events, it never has more); and a sale of the shift lies at least half a restore fence
 * gap below the Z. Voids and refunds are never accepted this way (their limits stay).
 *
 * Owner only (the owner of cloud_pos_shift_reports, like retryPosSalesDelivery on the edge: the
 * API receiver role may write these tables but never runs this). It writes the Z row and the
 * inbox row of the event, a bo_audit row (action pos_sales:accept_restored_z, the per-method
 * difference) and a bo_commands row (actor, request id, digest) in one transaction under the
 * branch binding lock the receiver takes. The same request again returns the stored result; a Z
 * already in the inbox returns `duplicate` and writes nothing. No DDL; without a call nothing
 * changes. Afterwards the owner of the edge database releases the parked event
 * (retryPosSalesDelivery): the next attempt is a duplicate for the cloud and the stream goes on.
 */
export async function acceptRestoredShiftReport(
  pool: DatabasePool,
  input: RestoredShiftReportRequest,
): Promise<RestoredShiftReportResult> {
  const parsed = RestoredShiftReportRequestSchema.safeParse(input);
  if (!parsed.success) refuse('INVALID_REQUEST', 'request');
  const req = parsed.data;
  let event: PosSaleEvent;
  try {
    event = parsePosSaleEvent(req.event);
  } catch {
    refuse('INVALID_REQUEST', 'model');
  }
  const hash = posSalePayloadHash(event);
  if (hash !== req.payloadHash) refuse('INVALID_REQUEST', 'model');
  if (event.kind !== 'shift_report') refuse('CONFLICT', 'not_shift_report');
  const z: ShiftReportEvent = event;
  const branch = id(req.branchId),
    device = id(req.deviceId),
    actor = id(req.actorId),
    requestId = id(req.requestId);
  if (id(z.branch_id) !== branch) refuse('INVALID_REQUEST', 'model');
  const digest = hashJson({
    branch_id: branch,
    device_id: device,
    event_id: id(z.event_id),
    sequence: z.sequence,
    payload_hash: hash,
    reason: req.reason,
  });
  return transaction(pool, async (client) => {
    const owner = (
      await client.query<{ installed: boolean; allowed: boolean | null }>(
        `SELECT to_regclass('cloud_pos_shift_reports') IS NOT NULL AND to_regclass('cloud_pos_sale_inbox') IS NOT NULL AS installed,
         (SELECT pg_get_userbyid(relowner)=current_user FROM pg_class
          WHERE oid=to_regclass('cloud_pos_shift_reports')) AS allowed`,
      )
    ).rows[0];
    if (!owner?.installed) refuse('NOT_FOUND', 'schema');
    if (owner?.allowed !== true) refuse('FORBIDDEN', 'not_owner');
    // As in the back-office command(): the actor first (a personal login with the manager grant
    // on the branch, not revoked), then the idempotency key (bo_commands, request id + digest).
    const manager = (
      await client.query<{ organization_id: string }>(
        `SELECT s.organization_id FROM bo_access_grants g
         JOIN catalog_manager_branches s ON s.actor_id=g.actor_id AND s.branch_id=g.branch_id
         JOIN catalog_managers m ON m.id=g.actor_id AND m.organization_id=s.organization_id
         WHERE g.actor_id=$1 AND g.branch_id=$2 AND g.role='manager' AND m.revoked_at IS NULL
         FOR SHARE OF g,s`,
        [actor, branch],
      )
    ).rows[0];
    if (!manager) refuse('FORBIDDEN', 'actor');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'bo:actor:' + actor + ':' + requestId,
    ]);
    const previous = (
      await client.query<{ digest: string; result: RestoredShiftReportResult }>(
        'SELECT digest,result FROM bo_commands WHERE actor_id=$1 AND request_id=$2',
        [actor, requestId],
      )
    ).rows[0];
    if (previous) {
      if (previous.digest !== digest) refuse('CONFLICT', 'request_reused');
      return previous.result;
    }
    // The receiver's lock: no delivery of this branch runs between the checks and the writes.
    const binding = (
      await client.query<{ active: boolean }>(
        `SELECT b.active FROM pos_order_sync_bindings b JOIN devices d ON d.id=b.device_id
         WHERE b.branch_id=$1 AND b.device_id=$2 AND d.organization_id=b.organization_id
         AND d.branch_id=b.branch_id FOR UPDATE OF b`,
        [branch, device],
      )
    ).rows[0];
    if (!binding?.active) refuse('FORBIDDEN', 'binding');
    const shiftId = z.payload.shift_id;
    const known = await inboxState(client, branch, device, z, hash);
    if (known === 'conflict') refuse('CONFLICT', 'identity');
    if (known === 'duplicate')
      return {
        state: 'duplicate',
        event_id: id(z.event_id),
        sequence: z.sequence,
        shift_id: shiftId,
      };
    if (await shiftReportStored(client, shiftId)) refuse('CONFLICT', 'shift_identity');
    const later = await client.query(
      'SELECT 1 FROM cloud_pos_sale_inbox WHERE device_id=$1 AND sequence>$2 LIMIT 1',
      [device, z.sequence],
    );
    if (later.rowCount) refuse('CONFLICT', 'not_head');
    const r = z.payload.report;
    const projection = await shiftProjection(client, branch, shiftId);
    const mismatch = shiftMismatch(r, projection);
    if (!mismatch) refuse('CONFLICT', 'not_parked');
    const methods = methodRows(r, projection);
    const cash = {
      z_sales_minor: BigInt(r.cash_sales_minor).toString(),
      cloud_sales_minor: BigInt(projection.sales.get('cash')?.sales_minor ?? '0').toString(),
      z_refunds_minor: BigInt(r.cash_refunds_minor).toString(),
      cloud_refunds_minor: BigInt(projection.refunds.get('cash') ?? '0').toString(),
    };
    const fenced = (
      await client.query<{ fenced: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM cloud_pos_sales WHERE branch_id=$1 AND device_id=$2
         AND shift_id=$3 AND last_sequence<=$4::bigint) AS fenced`,
        [branch, device, shiftId, (BigInt(z.sequence) - RESTORE_FENCE_GAP / 2n).toString()],
      )
    ).rows[0]?.fenced;
    if (
      !fenced ||
      BigInt(cash.z_sales_minor) > BigInt(cash.cloud_sales_minor) ||
      BigInt(cash.z_refunds_minor) > BigInt(cash.cloud_refunds_minor) ||
      methods.some(
        (row) =>
          BigInt(row.z_sales_minor) > BigInt(row.cloud_sales_minor) ||
          BigInt(row.z_refunds_minor) > BigInt(row.cloud_refunds_minor) ||
          row.z_count > row.cloud_count,
      )
    )
      refuse('CONFLICT', 'not_restore');
    await insertShiftReport(client, branch, device, z);
    await insertInbox(client, branch, device, z, hash);
    const result: RestoredShiftReportResult = {
      state: 'accepted',
      event_id: id(z.event_id),
      sequence: z.sequence,
      shift_id: shiftId,
      rejected_as: mismatch,
      cash,
      methods,
    };
    await client.query(
      `INSERT INTO bo_audit(id,branch_id,organization_id,actor_id,request_id,action,entity_id,reason,
       before_value,after_value) VALUES($1,$2,$3,$4,$5,'pos_sales:accept_restored_z',$6,$7,$8,$9)`,
      [
        randomUUID(),
        branch,
        manager.organization_id,
        actor,
        requestId,
        shiftId,
        req.reason,
        { device_id: device, event_id: result.event_id, sequence: result.sequence },
        result,
      ],
    );
    await client.query(
      'INSERT INTO bo_commands(actor_id,request_id,branch_id,digest,result) VALUES($1,$2,$3,$4,$5)',
      [actor, requestId, branch, digest, result],
    );
    return result;
  });
}
