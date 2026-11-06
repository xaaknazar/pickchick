import {
  PosFiscalPendingSchema,
  PosFiscalRecordRequestSchema,
  UuidSchema,
} from '@pickchick/contracts';
import type { PosFiscalPending, PosFiscalReceipt } from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import type { DatabasePool } from '@pickchick/database';
import { audit, authenticateStaff, requirePermission } from './staff.js';
import type { StaffAuth } from './staff.js';
import { command, lockBranch } from './commands.js';
import { OrderError } from './errors.js';
import { consumeApproval, posSalesInstalled } from './approvals.js';
import { loadCashShift } from './shifts.js';
import { FISCAL_RECEIPT_COLUMNS, appendFiscalEvent, fiscalReceipt } from './pos-outbox.js';

/** The pending list carries at most this many receipts (PosFiscalPendingSchema). */
const MAX_PENDING = 1000;

/**
 * GET pos/fiscal-receipts/pending?shift_id= (contracts 5.1, Ch3): receipts still to be punched in
 * the Webkassa cabinet, oldest first. A receipt belongs to the cash desk that made its sale or
 * refund: a cashier sees that desk's, a shift manager every desk's. With shift_id: the receipts of
 * the sales and refunds of that shift (what blocks its closing). methods: the methods of the sale
 * tenders (sale receipt) or of the refunded parts (refund receipt), each once.
 */
export async function listPendingFiscalReceipts(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  shiftId?: unknown,
): Promise<PosFiscalPending> {
  if (
    shiftId !== undefined &&
    (typeof shiftId !== 'string' || !UuidSchema.safeParse(shiftId).success)
  )
    throw new OrderError('INVALID_REQUEST');
  return transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, 'read');
    if (!(await posSalesInstalled(client))) throw new OrderError('NOT_FOUND');
    await lockBranch(client, branchId);
    if (shiftId !== undefined) await loadCashShift(client, branchId, actor, shiftId);
    const rows = (
      await client.query(
        `SELECT f.id AS receipt_id,f.order_id,r.display_number::integer AS display_number,f.kind,
         f.amount_minor::text AS amount_minor,f.created_at,f.version,
         CASE WHEN f.kind='sale'
           THEN (SELECT array_agg(t.method ORDER BY t.created_at,t.id) FROM pos_sale_tenders t
             WHERE t.order_id=f.order_id AND t.branch_id=f.branch_id)
           ELSE (SELECT array_agg(p.method ORDER BY p.created_at,p.tender_id) FROM pos_refund_tenders p
             WHERE p.refund_id=f.refund_id AND p.branch_id=f.branch_id) END AS methods
         FROM pos_fiscal_receipts f
         JOIN pos_sales s ON s.order_id=f.order_id AND s.branch_id=f.branch_id
         LEFT JOIN pos_refunds x ON x.id=f.refund_id AND x.branch_id=f.branch_id
         JOIN fulfillment_reservations r ON r.local_order_id=f.order_id AND r.branch_id=f.branch_id
         WHERE f.branch_id=$1 AND f.state='pending'
           AND ($2::uuid IS NULL OR (CASE WHEN f.kind='sale' THEN s.shift_id ELSE x.shift_id END)=$2)
           AND ($3::boolean OR (CASE WHEN f.kind='sale' THEN s.terminal_id ELSE x.terminal_id END)=$4)
         ORDER BY f.created_at,f.id LIMIT $5`,
        [branchId, shiftId ?? null, actor.role === 'shift_manager', actor.terminal_id, MAX_PENDING],
      )
    ).rows;
    return PosFiscalPendingSchema.parse({
      receipts: rows.map((row) => ({
        ...row,
        methods: [...new Set(row.methods as string[])],
        created_at: row.created_at.toISOString(),
      })),
    });
  });
}

/**
 * POST pos/fiscal-receipts/{receiptId}/record (contracts 5.1, Ch3; FiscalPort mode manual): the
 * Webkassa receipt number typed by the cashier, at the sale or later, with the receipt's version.
 * A pending receipt is recorded as is (no approval); correcting a recorded number needs the shift
 * manager's approval 'fiscal_correct' for {order_id, amount_minor: the receipt's amount}. A
 * not_required receipt has nothing to record (CONFLICT). Each change is a `fiscal` posSales event.
 * Allowed after the shift closed and outside pos_sale mode: the receipt still exists.
 */
export async function recordFiscalReceipt(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  key: string,
  receiptId: string,
  input: unknown,
): Promise<PosFiscalReceipt> {
  const parsed = PosFiscalRecordRequestSchema.safeParse(input);
  if (!parsed.success || !UuidSchema.safeParse(receiptId).success)
    throw new OrderError('INVALID_REQUEST');
  const request = parsed.data;
  const id = receiptId.toLowerCase();
  return command(
    pool,
    branchId,
    auth,
    'checkout',
    'pos_fiscal.record',
    key,
    { receipt_id: id, ...request },
    async (client, actor) => {
      if (!(await posSalesInstalled(client))) throw new OrderError('NOT_FOUND');
      const row = (
        await client.query(
          `SELECT f.id,f.order_id,f.state,f.version,f.amount_minor::text AS amount_minor,
           CASE WHEN f.kind='sale' THEN s.terminal_id ELSE x.terminal_id END AS desk
           FROM pos_fiscal_receipts f
           JOIN pos_sales s ON s.order_id=f.order_id AND s.branch_id=f.branch_id
           LEFT JOIN pos_refunds x ON x.id=f.refund_id AND x.branch_id=f.branch_id
           WHERE f.id=$1 AND f.branch_id=$2 FOR UPDATE OF f`,
          [id, branchId],
        )
      ).rows[0];
      if (!row || (actor.role !== 'shift_manager' && row.desk !== actor.terminal_id))
        throw new OrderError('NOT_FOUND');
      if (row.version !== request.expected_version || row.state === 'not_required')
        throw new OrderError('CONFLICT');
      const correction = row.state === 'recorded';
      if (!correction && request.approval) throw new OrderError('INVALID_REQUEST');
      const approval = correction
        ? await consumeApproval(client, branchId, actor, key, request.approval, 'fiscal_correct', {
            order_id: row.order_id,
            amount_minor: row.amount_minor,
          })
        : null;
      const receipt = fiscalReceipt(
        (
          await client.query(
            `UPDATE pos_fiscal_receipts SET state='recorded',receipt_number=$3,version=version+1,
             recorded_by_staff_id=$4,recorded_at=clock_timestamp(),
             approval_id=CASE WHEN $5::uuid IS NULL THEN approval_id ELSE $5::uuid END
             WHERE id=$1 AND branch_id=$2 RETURNING ${FISCAL_RECEIPT_COLUMNS}`,
            [id, branchId, request.receipt_number, actor.staff_id, approval?.approval_id ?? null],
          )
        ).rows[0],
      );
      await appendFiscalEvent(client, branchId, receipt);
      await audit(
        client,
        branchId,
        actor.staff_id,
        correction ? 'pos_fiscal.corrected' : 'pos_fiscal.recorded',
        id,
      );
      return receipt;
    },
  );
}
