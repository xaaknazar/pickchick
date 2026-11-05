import { randomUUID } from 'node:crypto';
import {
  PosRefundRequestSchema,
  PosSaleResultSchema,
  PosVoidRequestSchema,
  UuidSchema,
} from '@pickchick/contracts';
import type {
  LocalOrder,
  PosPaymentMethod,
  PosRefundRequest,
  PosSale,
  PosSaleResult,
  PosVoidRequest,
  StaffSession,
} from '@pickchick/contracts';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { audit } from './staff.js';
import type { StaffAuth } from './staff.js';
import { command } from './commands.js';
import { OrderError } from './errors.js';
import { loadOrder, orderEvent } from './orders.js';
import type { LocalOrderExecutionPort } from './orders.js';
import { consumeApproval } from './approvals.js';
import type { ConsumedApproval } from './approvals.js';
import { loadPosSale } from './sales.js';
import { loadCashShift } from './shifts.js';
import {
  FISCAL_RECEIPT_COLUMNS,
  appendFiscalEvent,
  appendPosSaleEvent,
  fiscalReceipt,
} from './pos-outbox.js';

/** PosSaleSchema carries at most 100 refunds per sale (the void counts as one). */
export const MAX_POS_REFUNDS_PER_SALE = 100;
/**
 * Sales the cashier edge never refunds (contracts 5.1 and section 00): an aggregator or ChocoFood
 * order is refunded in the platform's own back office; staff meal and marketing moved no money,
 * so before the kitchen starts they are voided and afterwards there is nothing to return.
 */
const NOT_REFUNDABLE: ReadonlySet<PosPaymentMethod> = new Set([
  'aggregator_yandex_eda',
  'aggregator_glovo',
  'chocofood',
  'staff_meal',
  'marketing',
]);

/** One refunded part: the sale tender, its method and the amount returned on it. */
export interface PosRefundPart {
  tender_id: string;
  method: PosPaymentMethod;
  amount_minor: string;
}

const refundedByTender = (sale: PosSale) => {
  const refunded = new Map<string, bigint>();
  for (const refund of sale.refunds)
    for (const part of refund.tenders)
      refunded.set(
        part.tender_id,
        (refunded.get(part.tender_id) ?? 0n) + BigInt(part.amount_minor),
      );
  return refunded;
};

/**
 * The money rules of one refund before anything is written (contracts 5.1, section 00): at most
 * 100 refunds per sale, aggregator/ChocoFood/staff meal/marketing sales are not refunded here,
 * every part names a tender of this sale once, never returns more than that tender still holds
 * (REFUND_LIMIT) and a Kaspi terminal part is whole tenge. The drawer limit of a cash part needs
 * the shift and is checked by the caller; schema026 checks the per-tender limit again.
 */
export function planPosRefund(
  sale: PosSale,
  request: Pick<PosRefundRequest, 'tenders'>,
): PosRefundPart[] {
  if (sale.refunds.length >= MAX_POS_REFUNDS_PER_SALE) throw new OrderError('REFUND_LIMIT');
  if (sale.tenders.some((tender) => NOT_REFUNDABLE.has(tender.method)))
    throw new OrderError('REFUND_NOT_SUPPORTED');
  const tenders = new Map(sale.tenders.map((tender) => [tender.tender_id, tender]));
  const refunded = refundedByTender(sale);
  const ids = request.tenders.map((part) => part.tender_id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw new OrderError('INVALID_REQUEST');
  return request.tenders.map((part, index) => {
    const tender = tenders.get(ids[index]!);
    if (!tender) throw new OrderError('INVALID_REQUEST');
    const amount = BigInt(part.amount_minor);
    // Kaspi Smart POS returns whole tenge only, as it takes them.
    if (tender.method === 'kaspi_terminal' && amount % 100n !== 0n)
      throw new OrderError('TERMINAL_AMOUNT_NOT_WHOLE');
    if (amount > BigInt(tender.amount_minor) - (refunded.get(tender.tender_id) ?? 0n))
      throw new OrderError('REFUND_LIMIT');
    return { tender_id: tender.tender_id, method: tender.method, amount_minor: part.amount_minor };
  });
}

/** What a void writes besides the order and kitchen cancellation. */
export interface PosVoidPlan {
  parts: PosRefundPart[];
  /** State of the refund receipt: a Webkassa return is due only for an issued sale receipt. */
  refundReceipt: 'pending' | 'not_required';
  /** The pending sale receipt was never punched: it becomes not_required. */
  saleReceiptNotRequired: boolean;
}

/**
 * A void (contracts 5.1): the paid order of this version, no refund yet (schema026: a void
 * returns the whole sale and is its only refund), every tender returned in full.
 * fiscal_sale_issued says whether the sale receipt was punched in Webkassa: then a return receipt
 * is due (pending); otherwise a pending sale receipt is no longer required and neither is the
 * return. The answer must agree with the receipt record (CONFLICT otherwise): a recorded sale
 * receipt was issued, so `false` contradicts it; a sale whose receipt was not required
 * (aggregator, ChocoFood, staff meal, marketing or a not_required method) has no Webkassa sale,
 * so `true` contradicts it and would ask for a return receipt of a sale never fiscalized.
 */
export function planPosVoid(
  sale: PosSale,
  order: Pick<LocalOrder, 'state' | 'version'>,
  request: Pick<PosVoidRequest, 'expected_version' | 'fiscal_sale_issued'>,
): PosVoidPlan {
  if (order.state !== 'paid' || order.version !== request.expected_version || sale.refunds.length)
    throw new OrderError('CONFLICT');
  const receipt = sale.fiscal.find((row) => row.kind === 'sale');
  if (
    !receipt ||
    (receipt.state === 'recorded' && !request.fiscal_sale_issued) ||
    (receipt.state === 'not_required' && request.fiscal_sale_issued)
  )
    throw new OrderError('CONFLICT');
  return {
    parts: sale.tenders.map((tender) => ({
      tender_id: tender.tender_id,
      method: tender.method,
      amount_minor: tender.amount_minor,
    })),
    refundReceipt: request.fiscal_sale_issued ? 'pending' : 'not_required',
    saleReceiptNotRequired: !request.fiscal_sale_issued && receipt.state === 'pending',
  };
}

/** The open sales shift of this cash desk takes the refund; its drawer pays the cash part. */
async function refundingShift(
  client: DatabaseClient,
  branchId: string,
  actor: StaffSession,
  parts: readonly PosRefundPart[],
) {
  const shift = (
    await client.query<{ id: string; sales_mode: boolean }>(
      `SELECT id,sales_mode FROM local_cash_shifts
       WHERE branch_id=$1 AND terminal_id=$2 AND state='open' FOR UPDATE`,
      [branchId, actor.terminal_id],
    )
  ).rows[0];
  if (!shift?.sales_mode) throw new OrderError('CASH_SHIFT_REQUIRED');
  const cash = parts
    .filter((part) => part.method === 'cash')
    .reduce((sum, part) => sum + BigInt(part.amount_minor), 0n);
  // Expected drawer cash: opening + in - out + cash sales - cash refunds (schema026 the same).
  if (
    cash > 0n &&
    BigInt((await loadCashShift(client, branchId, actor, shift.id)).expected_cash_minor) < cash
  )
    throw new OrderError('DRAWER_INSUFFICIENT');
  return shift.id;
}

/** Writes one refund (or void), its parts, its receipt and the posSales events. */
async function writeRefund(
  client: DatabaseClient,
  branchId: string,
  actor: StaffSession,
  refund: {
    refundId: string;
    orderId: string;
    kind: 'void' | 'refund';
    shiftId: string;
    approval: ConsumedApproval;
    reasonCode: string;
    reason: string;
    parts: readonly PosRefundPart[];
    receipt: 'pending' | 'not_required';
  },
) {
  const amount = refund.parts.reduce((sum, part) => sum + BigInt(part.amount_minor), 0n).toString();
  const row = (
    await client.query<{ created_at: Date }>(
      `INSERT INTO pos_refunds(id,order_id,branch_id,kind,shift_id,terminal_id,staff_id,
       approved_by_staff_id,approval_id,amount_minor,reason_code,reason)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING created_at`,
      [
        refund.refundId,
        refund.orderId,
        branchId,
        refund.kind,
        refund.shiftId,
        actor.terminal_id,
        actor.staff_id,
        refund.approval.manager_staff_id,
        refund.approval.approval_id,
        amount,
        refund.reasonCode,
        refund.reason,
      ],
    )
  ).rows[0]!;
  for (const part of refund.parts)
    await client.query(
      `INSERT INTO pos_refund_tenders(refund_id,tender_id,order_id,branch_id,method,amount_minor)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [refund.refundId, part.tender_id, refund.orderId, branchId, part.method, part.amount_minor],
    );
  const receipt = (
    await client.query(
      `INSERT INTO pos_fiscal_receipts(id,branch_id,order_id,refund_id,kind,state,amount_minor)
       VALUES($1,$2,$3,$4,'refund',$5,$6) RETURNING ${FISCAL_RECEIPT_COLUMNS}`,
      [randomUUID(), branchId, refund.orderId, refund.refundId, refund.receipt, amount],
    )
  ).rows[0];
  await appendPosSaleEvent(client, branchId, refund.kind, refund.refundId, {
    refund_id: refund.refundId,
    order_id: refund.orderId,
    kind: refund.kind,
    shift_id: refund.shiftId,
    terminal_id: actor.terminal_id,
    staff_id: actor.staff_id,
    approved_by_staff_id: refund.approval.manager_staff_id,
    approval_id: refund.approval.approval_id,
    amount_minor: amount,
    reason_code: refund.reasonCode,
    reason: refund.reason,
    tenders: refund.parts.map(({ tender_id, method, amount_minor }) => ({
      tender_id,
      method,
      amount_minor,
    })),
    created_at: row.created_at.toISOString(),
  });
  await appendFiscalEvent(client, branchId, fiscalReceipt(receipt));
}

/** The kitchen has not started: the admission is accepted and every task still queued. */
async function kitchenNotStarted(client: DatabaseClient, branchId: string, orderId: string) {
  return (
    await client.query<{ idle: boolean }>(
      `SELECT r.state='accepted' AND EXISTS(SELECT 1 FROM fulfillment_tasks t WHERE t.order_id=r.order_id)
         AND NOT EXISTS(SELECT 1 FROM fulfillment_tasks t WHERE t.order_id=r.order_id AND t.state<>'queued')
         AS idle
       FROM fulfillment_reservations r WHERE r.order_id=$1 AND r.branch_id=$2
         AND r.commercial_owner='edge_pos' AND r.admission_kind='pos_sale'`,
      [orderId, branchId],
    )
  ).rows[0]?.idle;
}

/**
 * POST pos/sales/{orderId}/void (contracts 5.1, KS3): before the kitchen starts (else
 * ORDER_IN_PRODUCTION, then a refund), with the shift manager's approval 'void' for
 * {order_id, amount_minor: total}. One transaction cancels the kitchen admission through the unpaid
 * cancel path (admission_kind pos_sale), cancels the order (version 2), records the void with every
 * tender returned in full at this desk's open sales shift (cash from its drawer), its receipt by
 * fiscal_sale_issued, and appends the void and fiscal posSales events and order.cancelled.
 */
export async function voidPosSale(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  key: string,
  orderId: string,
  input: unknown,
  execution?: LocalOrderExecutionPort,
): Promise<PosSaleResult> {
  const parsed = PosVoidRequestSchema.safeParse(input);
  if (!parsed.success || !UuidSchema.safeParse(orderId).success)
    throw new OrderError('INVALID_REQUEST');
  const request = parsed.data;
  const id = orderId.toLowerCase();
  return command(
    pool,
    branchId,
    auth,
    'checkout',
    'pos_sale.void',
    key,
    { order_id: id, ...request },
    async (client, actor, branch) => {
      if (branch.pos_service_mode !== 'pos_sale' || !execution)
        throw new OrderError('SERVICE_MODE_DISABLED');
      const sale = await loadPosSale(client, branchId, actor, id);
      const plan = planPosVoid(sale, await loadOrder(client, branchId, actor, id), request);
      const shiftId = await refundingShift(client, branchId, actor, plan.parts);
      if (!(await kitchenNotStarted(client, branchId, id)))
        throw new OrderError('ORDER_IN_PRODUCTION');
      const approval = await consumeApproval(
        client,
        branchId,
        actor,
        key,
        request.approval,
        'void',
        {
          order_id: id,
          amount_minor: sale.total_minor,
        },
      );
      // The same cancel as an unpaid order; it re-checks the queued tasks under the lock.
      await execution.cancel(client, branchId, id, actor, request.reason, 'pos_sale');
      await client.query(
        `UPDATE local_orders SET state='cancelled',version=version+1,cancellation_reason=$3
         WHERE id=$1 AND branch_id=$2`,
        [id, branchId, request.reason],
      );
      await writeRefund(client, branchId, actor, {
        refundId: randomUUID(),
        orderId: id,
        kind: 'void',
        shiftId,
        approval,
        reasonCode: request.reason_code,
        reason: request.reason,
        parts: plan.parts,
        receipt: plan.refundReceipt,
      });
      // Only after the void exists may the never-punched sale receipt become not_required.
      if (plan.saleReceiptNotRequired) {
        const receipt = (
          await client.query(
            `UPDATE pos_fiscal_receipts SET state='not_required',version=version+1
             WHERE order_id=$1 AND branch_id=$2 AND kind='sale' AND state='pending'
             RETURNING ${FISCAL_RECEIPT_COLUMNS}`,
            [id, branchId],
          )
        ).rows[0];
        await appendFiscalEvent(client, branchId, fiscalReceipt(receipt));
      }
      const order = await loadOrder(client, branchId, actor, id);
      await orderEvent(client, order, 'order.cancelled');
      await audit(client, branchId, actor.staff_id, 'pos_sale.voided', id);
      return PosSaleResultSchema.parse({
        order,
        sale: await loadPosSale(client, branchId, actor, id),
      });
    },
  );
}

/**
 * POST pos/sales/{orderId}/refunds (contracts 5.1, KS3): the full or a partial amount of each
 * tender, never above what it still holds (REFUND_LIMIT), cash never above this desk's drawer
 * (DRAWER_INSUFFICIENT), at this desk's open sales shift, with the approval 'refund' for
 * {order_id, amount_minor: the refund}. The order row does not change (the cloud keeps versions
 * 1/2); the refund gets its receipt (pending when the sale had one, else not_required) and the
 * refund and fiscal posSales events. refund_id is the cash desk's id of this refund.
 */
export async function refundPosSale(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  key: string,
  orderId: string,
  input: unknown,
): Promise<PosSale> {
  const parsed = PosRefundRequestSchema.safeParse(input);
  if (!parsed.success || !UuidSchema.safeParse(orderId).success)
    throw new OrderError('INVALID_REQUEST');
  const request = parsed.data;
  const id = orderId.toLowerCase();
  return command(
    pool,
    branchId,
    auth,
    'checkout',
    'pos_sale.refund',
    key,
    { order_id: id, ...request },
    async (client, actor, branch) => {
      if (branch.pos_service_mode !== 'pos_sale') throw new OrderError('SERVICE_MODE_DISABLED');
      const sale = await loadPosSale(client, branchId, actor, id);
      const state = (
        await client.query<{ state: string }>(
          'SELECT state FROM local_orders WHERE id=$1 AND branch_id=$2',
          [id, branchId],
        )
      ).rows[0]?.state;
      const refundId = request.refund_id.toLowerCase();
      if (
        state !== 'paid' ||
        (await client.query('SELECT 1 FROM pos_refunds WHERE id=$1', [refundId])).rowCount
      )
        throw new OrderError('CONFLICT');
      const parts = planPosRefund(sale, request);
      const shiftId = await refundingShift(client, branchId, actor, parts);
      const amount = parts.reduce((sum, part) => sum + BigInt(part.amount_minor), 0n).toString();
      const approval = await consumeApproval(
        client,
        branchId,
        actor,
        key,
        request.approval,
        'refund',
        { order_id: id, amount_minor: amount },
      );
      // The sale receipt state carries the fiscal policy of the sale's methods at sale time.
      const saleReceipt = sale.fiscal.find((row) => row.kind === 'sale');
      await writeRefund(client, branchId, actor, {
        refundId,
        orderId: id,
        kind: 'refund',
        shiftId,
        approval,
        reasonCode: request.reason_code,
        reason: request.reason,
        parts,
        receipt: saleReceipt?.state === 'not_required' ? 'not_required' : 'pending',
      });
      await audit(client, branchId, actor.staff_id, 'pos_sale.refunded', id);
      return loadPosSale(client, branchId, actor, id);
    },
  );
}
