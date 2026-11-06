import {
  PosPaymentMethodSchema,
  PosShiftReportSchema,
  SalesChannelSchema,
  UuidSchema,
} from '@pickchick/contracts';
import type { PosShiftReport } from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { authenticateStaff, requirePermission } from './staff.js';
import type { StaffAuth } from './staff.js';
import { lockBranch } from './commands.js';
import { posSalesInstalled } from './approvals.js';
import { OrderError } from './errors.js';

/** @internal Cash of a sales shift (schema026 pos_shift_cash): sales net of change, refunds paid out. */
export async function shiftCash(client: DatabaseClient, shiftId: string) {
  return (
    await client.query<{ cash_sales_minor: string; cash_refunds_minor: string }>(
      `SELECT cash_sales_minor::text AS cash_sales_minor,cash_refunds_minor::text AS cash_refunds_minor
       FROM pos_shift_cash($1)`,
      [shiftId],
    )
  ).rows[0]!;
}

/** @internal Pending receipts of the sales and refunds of one shift (schema026 pos_shift_pending_fiscal). */
export async function pendingShiftReceipts(
  client: DatabaseClient,
  branchId: string,
  shiftId: string,
) {
  return (
    await client.query<{ count: number; amount_minor: string }>(
      `SELECT count(*)::integer AS count,coalesce(sum(f.amount_minor),0)::text AS amount_minor
       FROM pos_fiscal_receipts f WHERE f.branch_id=$1 AND f.state='pending' AND (
         (f.kind='sale' AND EXISTS(SELECT 1 FROM pos_sales s WHERE s.order_id=f.order_id AND s.shift_id=$2))
         OR (f.kind='refund' AND EXISTS(SELECT 1 FROM pos_refunds r WHERE r.id=f.refund_id AND r.shift_id=$2)))`,
      [branchId, shiftId],
    )
  ).rows[0]!;
}

/**
 * @internal ShiftReport of a sales shift (contracts 5.1), computed now. Per method: the tenders of
 * the shift's sales (`sales_minor`, `count` = payments) and the refund parts paid at this shift
 * (`refunds_minor`), all eight methods in contract order; per channel: the shift's sales, voided
 * ones included (their void is a refund of the shift that made it); receipts of the shift's sales
 * and refunds by state. expected = opening + in - out + cash_sales - cash_refunds;
 * terminal_discrepancy = terminal_reported - (kaspi_terminal sales - refunds).
 */
export async function buildShiftReport(
  client: DatabaseClient,
  branchId: string,
  shiftId: string,
  kind: 'x' | 'z',
  terminalReported: string | null,
): Promise<PosShiftReport> {
  const shift = (
    await client.query(
      `SELECT id,terminal_id,state,opened_at,closed_at,opening_cash_minor::text AS opening_cash_minor,
       counted_cash_minor::text AS counted_cash_minor,discrepancy_minor::text AS discrepancy_minor
       FROM local_cash_shifts WHERE id=$1 AND branch_id=$2`,
      [shiftId, branchId],
    )
  ).rows[0];
  if (!shift) throw new OrderError('NOT_FOUND');
  const movements = (
    await client.query<{ cash_in: string; cash_out: string }>(
      `SELECT coalesce(sum(amount_minor) FILTER(WHERE direction='in'),0)::text AS cash_in,
       coalesce(sum(amount_minor) FILTER(WHERE direction='out'),0)::text AS cash_out
       FROM local_cash_movements WHERE branch_id=$1 AND shift_id=$2`,
      [branchId, shiftId],
    )
  ).rows[0]!;
  const cash = await shiftCash(client, shiftId);
  const sales = new Map(
    (
      await client.query<{ method: string; sales_minor: string; count: number }>(
        `SELECT t.method,sum(t.amount_minor)::text AS sales_minor,count(*)::integer AS count
         FROM pos_sale_tenders t JOIN pos_sales s ON s.order_id=t.order_id AND s.branch_id=t.branch_id
         WHERE s.branch_id=$1 AND s.shift_id=$2 GROUP BY t.method`,
        [branchId, shiftId],
      )
    ).rows.map((row) => [row.method, row]),
  );
  const refunds = new Map(
    (
      await client.query<{ method: string; refunds_minor: string }>(
        `SELECT p.method,sum(p.amount_minor)::text AS refunds_minor
         FROM pos_refund_tenders p JOIN pos_refunds r ON r.id=p.refund_id AND r.branch_id=p.branch_id
         WHERE r.branch_id=$1 AND r.shift_id=$2 GROUP BY p.method`,
        [branchId, shiftId],
      )
    ).rows.map((row) => [row.method, row.refunds_minor]),
  );
  const channels = new Map(
    (
      await client.query<{ sales_channel: string; total_minor: string; count: number }>(
        `SELECT sales_channel,sum(total_minor)::text AS total_minor,count(*)::integer AS count
         FROM pos_sales WHERE branch_id=$1 AND shift_id=$2 GROUP BY sales_channel`,
        [branchId, shiftId],
      )
    ).rows.map((row) => [row.sales_channel, row]),
  );
  const fiscal = new Map(
    (
      await client.query<{ state: string; count: number }>(
        `SELECT f.state,count(*)::integer AS count FROM pos_fiscal_receipts f WHERE f.branch_id=$1 AND (
           (f.kind='sale' AND EXISTS(SELECT 1 FROM pos_sales s WHERE s.order_id=f.order_id AND s.shift_id=$2))
           OR (f.kind='refund' AND EXISTS(SELECT 1 FROM pos_refunds r WHERE r.id=f.refund_id AND r.shift_id=$2)))
         GROUP BY f.state`,
        [branchId, shiftId],
      )
    ).rows.map((row) => [row.state, row.count]),
  );
  const orders = (
    await client.query<{ count: number; voided_count: number }>(
      `SELECT count(*)::integer AS count,count(*) FILTER(WHERE o.state='cancelled')::integer AS voided_count
       FROM pos_sales s JOIN local_orders o ON o.id=s.order_id AND o.branch_id=s.branch_id
       WHERE s.branch_id=$1 AND s.shift_id=$2`,
      [branchId, shiftId],
    )
  ).rows[0]!;
  const time = (await client.query<{ time: Date }>('SELECT clock_timestamp() AS time')).rows[0]!
    .time;
  const expected =
    BigInt(shift.opening_cash_minor) +
    BigInt(movements.cash_in) -
    BigInt(movements.cash_out) +
    BigInt(cash.cash_sales_minor) -
    BigInt(cash.cash_refunds_minor);
  const terminalNet =
    BigInt(sales.get('kaspi_terminal')?.sales_minor ?? '0') -
    BigInt(refunds.get('kaspi_terminal') ?? '0');
  return PosShiftReportSchema.parse({
    kind,
    shift_id: shift.id,
    terminal_id: shift.terminal_id,
    state: shift.state,
    opened_at: shift.opened_at.toISOString(),
    closed_at: shift.closed_at?.toISOString() ?? null,
    opening_cash_minor: shift.opening_cash_minor,
    cash_in_minor: movements.cash_in,
    cash_out_minor: movements.cash_out,
    cash_sales_minor: cash.cash_sales_minor,
    cash_refunds_minor: cash.cash_refunds_minor,
    expected_cash_minor: expected.toString(),
    counted_cash_minor: shift.counted_cash_minor,
    discrepancy_minor: shift.discrepancy_minor,
    methods: PosPaymentMethodSchema.options.map((method) => ({
      method,
      sales_minor: sales.get(method)?.sales_minor ?? '0',
      refunds_minor: refunds.get(method) ?? '0',
      count: sales.get(method)?.count ?? 0,
    })),
    channels: SalesChannelSchema.options.map((channel) => ({
      sales_channel: channel,
      total_minor: channels.get(channel)?.total_minor ?? '0',
      count: channels.get(channel)?.count ?? 0,
    })),
    terminal_reported_minor: terminalReported,
    terminal_discrepancy_minor:
      terminalReported === null ? null : (BigInt(terminalReported) - terminalNet).toString(),
    fiscal: {
      pending: fiscal.get('pending') ?? 0,
      recorded: fiscal.get('recorded') ?? 0,
      not_required: fiscal.get('not_required') ?? 0,
    },
    orders,
    report_at: time.toISOString(),
  });
}

/**
 * GET cash-shifts/{id}/x-report and .../z-report (contracts 5.1, KS2): PickChick reports of a
 * sales shift, not fiscal. X is computed now for an open or closed shift (receipts in their state
 * now; a closed shift shows its counted cash and Kaspi terminal total); Z is the report frozen at
 * closing, only for a closed shift (CONFLICT while open). A shift that did not open in pos_sale
 * mode has neither (NOT_FOUND), and so has every shift on an edge without schema026. A cashier
 * sees the shifts of this desk, a shift manager every desk.
 */
export async function readShiftReport(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  shiftId: string,
  kind: 'x' | 'z',
): Promise<PosShiftReport> {
  if (!UuidSchema.safeParse(shiftId).success) throw new OrderError('INVALID_REQUEST');
  return transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, 'read');
    if (!(await posSalesInstalled(client))) throw new OrderError('NOT_FOUND');
    // Commands lock the branch too: the report reads one consistent state of the shift.
    await lockBranch(client, branchId);
    const shift = (
      await client.query<{ id: string; state: string; sales_mode: boolean }>(
        `SELECT id,state,sales_mode FROM local_cash_shifts WHERE id=$1 AND branch_id=$2
         AND ($3::boolean OR terminal_id=$4)`,
        [shiftId, branchId, actor.role === 'shift_manager', actor.terminal_id],
      )
    ).rows[0];
    if (!shift?.sales_mode) throw new OrderError('NOT_FOUND');
    if (kind === 'x') {
      const reported =
        shift.state === 'closed'
          ? ((
              await client.query<{ terminal_reported_minor: string | null }>(
                `SELECT terminal_reported_minor::text AS terminal_reported_minor
                 FROM pos_shift_reports WHERE shift_id=$1 AND branch_id=$2`,
                [shift.id, branchId],
              )
            ).rows[0]?.terminal_reported_minor ?? null)
          : null;
      return buildShiftReport(client, branchId, shift.id, 'x', reported);
    }
    if (shift.state !== 'closed') throw new OrderError('CONFLICT');
    const frozen = (
      await client.query<{ report: unknown }>(
        'SELECT report FROM pos_shift_reports WHERE shift_id=$1 AND branch_id=$2',
        [shift.id, branchId],
      )
    ).rows[0];
    if (!frozen) throw new OrderError('NOT_FOUND');
    return PosShiftReportSchema.parse(frozen.report);
  });
}
