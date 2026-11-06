import { PosFiscalReceiptSchema } from '@pickchick/contracts';
import type { PosFiscalReceipt } from '@pickchick/contracts';
import type { DatabaseClient } from '@pickchick/database';
import { hashJson } from '@pickchick/menu-sync';

/** Kinds of the durable posSales stream (contracts 5.6, edge schema026 pos_sale_outbox). */
export type PosSaleEventKind = 'sale' | 'void' | 'refund' | 'fiscal' | 'shift_report';

/**
 * @internal Appends one posSales event in the caller's transaction (the sale, void, refund,
 * receipt record or shift close it describes). payload_hash = hashJson(payload), as the cloud
 * receiver checks it; the outbox sequence orders the stream.
 */
export async function appendPosSaleEvent(
  client: DatabaseClient,
  branchId: string,
  kind: PosSaleEventKind,
  entityId: string,
  payload: Record<string, unknown>,
) {
  await client.query(
    'INSERT INTO pos_sale_outbox(branch_id,kind,entity_id,payload,payload_hash) VALUES($1,$2,$3,$4,$5)',
    [branchId, kind, entityId, payload, hashJson(payload)],
  );
}

/** @internal Columns of one receipt row for fiscalReceipt() (RETURNING or SELECT of pos_fiscal_receipts). */
export const FISCAL_RECEIPT_COLUMNS = `id,order_id,refund_id,kind,mode,state,receipt_number,version,
  amount_minor::text AS amount_minor,recorded_by_staff_id,recorded_at`;

/** @internal The receipt record of contracts 5.6 (`fiscal` payload and POST .../record result). */
export function fiscalReceipt(row: {
  id: string;
  order_id: string;
  refund_id: string | null;
  kind: string;
  mode: string;
  state: string;
  receipt_number: string | null;
  version: number;
  amount_minor: string;
  recorded_by_staff_id: string | null;
  recorded_at: Date | null;
}): PosFiscalReceipt {
  return PosFiscalReceiptSchema.parse({
    receipt_id: row.id,
    order_id: row.order_id,
    refund_id: row.refund_id,
    kind: row.kind,
    mode: row.mode,
    state: row.state,
    receipt_number: row.receipt_number,
    version: row.version,
    amount_minor: row.amount_minor,
    recorded_by_staff_id: row.recorded_by_staff_id,
    recorded_at: row.recorded_at?.toISOString() ?? null,
  });
}

/** @internal Every receipt change is one `fiscal` event with the whole record (newer version wins). */
export async function appendFiscalEvent(
  client: DatabaseClient,
  branchId: string,
  receipt: PosFiscalReceipt,
) {
  await appendPosSaleEvent(client, branchId, 'fiscal', receipt.receipt_id, receipt);
}
