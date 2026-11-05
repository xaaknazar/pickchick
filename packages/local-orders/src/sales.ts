import { randomUUID } from 'node:crypto';
import {
  POS_PAYMENT_METHOD_POLICY,
  PosSaleRequestSchema,
  PosSaleResultSchema,
  PosSaleSchema,
  QuoteSchema,
  UuidSchema,
} from '@pickchick/contracts';
import type {
  PosPaymentMethod,
  PosSale,
  PosSaleRequest,
  PosSaleResult,
  Quote,
  SalesChannel,
  StaffSession,
} from '@pickchick/contracts';
import { transaction } from '@pickchick/database';
import type { DatabaseClient, DatabasePool } from '@pickchick/database';
import { audit, authenticateStaff, requirePermission } from './staff.js';
import type { StaffAuth } from './staff.js';
import { command } from './commands.js';
import { OrderError } from './errors.js';
import {
  activeMenu,
  cartStopIds,
  checkStops,
  loadOrder,
  orderEvent,
  type LocalOrderExecutionPort,
} from './orders.js';
import { consumeApproval, posSalesInstalled } from './approvals.js';
import type { ConsumedApproval } from './approvals.js';
import { loadPaymentMethods } from './payment-methods.js';
import {
  FISCAL_RECEIPT_COLUMNS,
  appendFiscalEvent,
  appendPosSaleEvent,
  fiscalReceipt,
} from './pos-outbox.js';

const MAX_BIGINT = 9223372036854775807n;
type RevenueKind = 'revenue' | 'staff_meal' | 'marketing';
interface SalePlan {
  channel: SalesChannel;
  methods: PosPaymentMethod[];
  revenueKind: RevenueKind;
  externalOrderRef: string | null;
  cashTendered: string | null;
  change: string | null;
}

/**
 * The money rules of one sale (contracts 2.2 and section 00) before anything is written. The
 * database checks the same rules again at COMMIT (schema026 pos_sale_assert_complete).
 */
export function planPosSale(request: PosSaleRequest, quote: Quote): SalePlan {
  const channel: SalesChannel = quote.sales_channel ?? 'hall';
  const tenders = request.tenders;
  const methods = tenders.map((tender) => tender.method);
  // Each method pays only in its channels: an aggregator channel takes its own aggregator method
  // alone, and aggregator methods never pay a hall order.
  if (
    tenders.some((tender) => !POS_PAYMENT_METHOD_POLICY[tender.method].channels.includes(channel))
  )
    throw new OrderError('INVALID_REQUEST');
  if (channel !== 'hall' && quote.service_mode !== 'takeaway')
    throw new OrderError('INVALID_REQUEST');
  // A mix is exactly two parts of cash/kaspi_terminal/kaspi_manual, at most one of them cash.
  if (
    tenders.length === 2 &&
    (tenders.some((tender) => !POS_PAYMENT_METHOD_POLICY[tender.method].allow_in_mix) ||
      methods.filter((method) => method === 'cash').length > 1)
  )
    throw new OrderError('INVALID_REQUEST');
  const paid = tenders.reduce((sum, tender) => sum + BigInt(tender.amount_minor), 0n);
  if (paid !== BigInt(quote.total_minor)) throw new OrderError('TENDER_SUM_MISMATCH');
  // Kaspi Smart POS takes whole tenge only.
  if (
    tenders.some(
      (tender) => tender.method === 'kaspi_terminal' && BigInt(tender.amount_minor) % 100n !== 0n,
    )
  )
    throw new OrderError('TERMINAL_AMOUNT_NOT_WHOLE');
  // Change comes from the cash part only.
  const cash = tenders.find((tender) => tender.method === 'cash');
  let change: string | null = null;
  if (cash) {
    if (request.cash_tendered_minor === undefined) throw new OrderError('INVALID_REQUEST');
    const rest = BigInt(request.cash_tendered_minor) - BigInt(cash.amount_minor);
    if (rest < 0n) throw new OrderError('CASH_TENDERED_TOO_LOW');
    change = rest.toString();
  } else if (request.cash_tendered_minor !== undefined) throw new OrderError('INVALID_REQUEST');
  // Aggregator and ChocoFood orders carry the platform's order number, stored upper-case.
  const numbered = channel !== 'hall' || methods.includes('chocofood');
  if (numbered && request.external_order_ref === undefined)
    throw new OrderError('EXTERNAL_REF_REQUIRED');
  if (!numbered && request.external_order_ref !== undefined)
    throw new OrderError('INVALID_REQUEST');
  const revenueKind: RevenueKind = methods.includes('staff_meal')
    ? 'staff_meal'
    : methods.includes('marketing')
      ? 'marketing'
      : 'revenue';
  // Staff meal names who ate, marketing says why; both need the shift manager's approval
  // (APPROVAL_REQUIRED once the method is known to be enabled, see createPosSale).
  if (
    (revenueKind === 'staff_meal') !== (request.beneficiary !== undefined) ||
    (revenueKind === 'marketing') !== (request.reason !== undefined) ||
    (revenueKind === 'revenue' && request.approval !== undefined)
  )
    throw new OrderError('INVALID_REQUEST');
  return {
    channel,
    methods,
    revenueKind,
    externalOrderRef: request.external_order_ref?.toUpperCase() ?? null,
    cashTendered: cash ? request.cash_tendered_minor! : null,
    change,
  };
}

/** @internal The PosSale read model of one order (contracts 5.1). */
export async function loadPosSale(
  client: DatabaseClient,
  branchId: string,
  actor: StaffSession,
  orderId: string,
): Promise<PosSale> {
  const sale = (
    await client.query(
      `SELECT s.order_id,s.shift_id,s.terminal_id,s.cashier_staff_id,s.sales_channel,
       s.external_order_ref,s.revenue_kind,s.total_minor::text AS total_minor,
       s.cash_tendered_minor::text AS cash_tendered_minor,s.change_minor::text AS change_minor,
       s.created_at,r.display_number::integer AS display_number,q.snapshot->>'service_mode' AS service_mode
       FROM pos_sales s
       JOIN checkout_quotes q ON q.id=s.quote_id AND q.branch_id=s.branch_id
       JOIN fulfillment_reservations r ON r.local_order_id=s.order_id AND r.branch_id=s.branch_id
       WHERE s.order_id=$1 AND s.branch_id=$2`,
      [orderId, branchId],
    )
  ).rows[0];
  if (!sale || (actor.role !== 'shift_manager' && sale.terminal_id !== actor.terminal_id))
    throw new OrderError('NOT_FOUND');
  const tenders = (
    await client.query(
      `SELECT id AS tender_id,method,amount_minor::text AS amount_minor,confirmation,reference
       FROM pos_sale_tenders WHERE order_id=$1 AND branch_id=$2 ORDER BY created_at,id`,
      [orderId, branchId],
    )
  ).rows;
  const refunds = (
    await client.query(
      `SELECT f.id AS refund_id,f.kind,f.amount_minor::text AS amount_minor,f.reason_code,
       f.approved_by_staff_id,f.created_at,
       (SELECT jsonb_agg(jsonb_build_object('tender_id',t.tender_id,'amount_minor',t.amount_minor::text)
         ORDER BY t.created_at,t.tender_id) FROM pos_refund_tenders t WHERE t.refund_id=f.id) AS tenders
       FROM pos_refunds f WHERE f.order_id=$1 AND f.branch_id=$2 ORDER BY f.created_at,f.id`,
      [orderId, branchId],
    )
  ).rows;
  const fiscal = (
    await client.query(
      `SELECT id AS receipt_id,kind,state,receipt_number,version,amount_minor::text AS amount_minor
       FROM pos_fiscal_receipts WHERE order_id=$1 AND branch_id=$2 ORDER BY created_at,id`,
      [orderId, branchId],
    )
  ).rows;
  const refunded = refunds.reduce((sum, refund) => sum + BigInt(refund.amount_minor), 0n);
  return PosSaleSchema.parse({
    order_id: sale.order_id,
    display_number: sale.display_number,
    pickup: sale.sales_channel === 'hall' ? 'issue' : 'delivery_handover',
    sales_channel: sale.sales_channel,
    external_order_ref: sale.external_order_ref,
    service_mode: sale.service_mode,
    revenue_kind: sale.revenue_kind,
    total_minor: sale.total_minor,
    cash_tendered_minor: sale.cash_tendered_minor,
    change_minor: sale.change_minor,
    tenders,
    refunds: refunds.map((refund) => ({ ...refund, created_at: refund.created_at.toISOString() })),
    refundable_minor: (BigInt(sale.total_minor) - refunded).toString(),
    fiscal,
    shift_id: sale.shift_id,
    terminal_id: sale.terminal_id,
    cashier_staff_id: sale.cashier_staff_id,
    created_at: sale.created_at.toISOString(),
  });
}

/**
 * POST pos/sales (contracts 5.1, 2.2, section 00): one PostgreSQL transaction turns a quote into
 * a paid, captured pos_sale order, admits it to the kitchen (admission_kind pos_sale; aggregators
 * take away with snapshot.delivery), records the tenders and the Webkassa receipt by each method's
 * fiscal policy, spends the staff meal / marketing approval and appends the posSales events
 * (sale, then the receipt) and the order_commercial event. Off unless the operator switched the
 * branch to pos_sale; replay with the same Idempotency-Key returns the stored result.
 */
export async function createPosSale(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  key: string,
  input: unknown,
  execution?: LocalOrderExecutionPort,
): Promise<PosSaleResult> {
  const parsed = PosSaleRequestSchema.safeParse(input);
  if (!parsed.success) throw new OrderError('INVALID_REQUEST');
  const request = parsed.data;
  return command(
    pool,
    branchId,
    auth,
    'checkout',
    'pos_sale.create',
    key,
    request,
    async (client, actor, branch) => {
      if (branch.pos_service_mode !== 'pos_sale' || !execution)
        throw new OrderError('SERVICE_MODE_DISABLED');
      const row = (
        await client.query(
          `SELECT *, expires_at > clock_timestamp() AS valid FROM checkout_quotes
           WHERE id=$1 AND branch_id=$2 AND staff_id=$3 AND terminal_id=$4`,
          [request.quote_id, branchId, actor.staff_id, actor.terminal_id],
        )
      ).rows[0];
      if (!row) throw new OrderError('NOT_FOUND');
      if ((await client.query('SELECT 1 FROM local_orders WHERE quote_id=$1', [row.id])).rowCount)
        throw new OrderError('CONFLICT');
      if (!row.valid) throw new OrderError('QUOTE_EXPIRED');
      if (!branch.ordering_enabled) throw new OrderError('BRANCH_UNAVAILABLE');
      const menu = await activeMenu(client, branchId);
      if (menu.release_id !== row.release_id) throw new OrderError('MENU_CHANGED');
      const quote = QuoteSchema.parse(row.snapshot);
      await checkStops(client, branchId, cartStopIds(menu, quote.lines));
      const plan = planPosSale(request, quote);
      const methods = new Map(
        (await loadPaymentMethods(client, branchId)).map((method) => [method.code, method]),
      );
      if (plan.methods.some((code) => !methods.get(code)?.enabled))
        throw new OrderError('METHOD_DISABLED');
      // The open sales shift of this cash desk takes the sale (and its drawer the cash).
      const shift = (
        await client.query<{ id: string; sales_mode: boolean }>(
          `SELECT id,sales_mode FROM local_cash_shifts
           WHERE branch_id=$1 AND terminal_id=$2 AND state='open' FOR UPDATE`,
          [branchId, actor.terminal_id],
        )
      ).rows[0];
      if (!shift?.sales_mode) throw new OrderError('CASH_SHIFT_REQUIRED');
      const shiftTotal = (
        await client.query(
          'SELECT coalesce(sum(total_minor),0)::text AS total FROM local_orders WHERE cash_shift_id=$1 AND branch_id=$2',
          [shift.id, branchId],
        )
      ).rows[0].total;
      if (BigInt(shiftTotal) + BigInt(quote.total_minor) > MAX_BIGINT)
        throw new OrderError('INVALID_REQUEST');
      // The platform's number belongs to one sale of the channel that is not voided: a voided
      // (cancelled) sale releases it for the corrected re-entry (schema026 guard_pos_sale).
      if (
        plan.externalOrderRef !== null &&
        (
          await client.query(
            `SELECT 1 FROM pos_sales s JOIN local_orders o ON o.id=s.order_id AND o.branch_id=s.branch_id
             WHERE s.branch_id=$1 AND s.sales_channel=$2 AND s.external_order_ref=$3
               AND o.state<>'cancelled'`,
            [branchId, plan.channel, plan.externalOrderRef],
          )
        ).rowCount
      )
        throw new OrderError('EXTERNAL_REF_DUPLICATE');
      let approval: ConsumedApproval | null = null;
      if (plan.revenueKind !== 'revenue')
        approval = await consumeApproval(
          client,
          branchId,
          actor,
          key,
          request.approval,
          plan.revenueKind,
          { quote_id: quote.quote_id, amount_minor: quote.total_minor },
        );
      const orderId = randomUUID();
      await client.query(
        `INSERT INTO local_orders(id,branch_id,quote_id,total_minor,cash_shift_id,execution_mode,state,payment_state)
         VALUES ($1,$2,$3,$4,$5,'pos_sale','paid','captured')`,
        [orderId, branchId, quote.quote_id, quote.total_minor, shift.id],
      );
      await execution.admit(
        client,
        {
          orderId,
          branchId,
          quote,
          kind: 'pos_sale',
          ...(plan.channel !== 'hall'
            ? { delivery: { provider: plan.channel, externalNumber: plan.externalOrderRef! } }
            : {}),
        },
        actor,
        key,
      );
      try {
        await client.query(
          `INSERT INTO pos_sales(order_id,branch_id,quote_id,shift_id,terminal_id,cashier_staff_id,
           sales_channel,external_order_ref,revenue_kind,total_minor,cash_tendered_minor,change_minor,
           beneficiary,reason,approval_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            orderId,
            branchId,
            quote.quote_id,
            shift.id,
            actor.terminal_id,
            actor.staff_id,
            plan.channel,
            plan.externalOrderRef,
            plan.revenueKind,
            quote.total_minor,
            plan.cashTendered,
            plan.change,
            request.beneficiary ?? null,
            request.reason ?? null,
            approval?.approval_id ?? null,
          ],
        );
      } catch (error) {
        // Branch commands are serialized; this is the schema026 guard behind the check above.
        if ((error as { code?: string }).code === '23505')
          throw new OrderError('EXTERNAL_REF_DUPLICATE');
        throw error;
      }
      for (const tender of request.tenders)
        await client.query(
          `INSERT INTO pos_sale_tenders(id,order_id,branch_id,method,amount_minor,confirmation,reference)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            randomUUID(),
            orderId,
            branchId,
            tender.method,
            tender.amount_minor,
            POS_PAYMENT_METHOD_POLICY[tender.method].confirmation,
            tender.reference ?? null,
          ],
        );
      // Manual Webkassa: a receipt is due when any part's method requires one; a number typed
      // with the sale records it at once.
      const receiptDue = plan.methods.some(
        (code) => methods.get(code)!.fiscal_policy === 'manual_webkassa',
      );
      const number = request.fiscal_receipt_number ?? null;
      const receipt = (
        await client.query(
          `INSERT INTO pos_fiscal_receipts(id,branch_id,order_id,kind,state,receipt_number,amount_minor,
           recorded_by_staff_id,recorded_at)
           VALUES($1,$2,$3,'sale',$4,$5,$6,$7,CASE WHEN $5::text IS NULL THEN NULL ELSE clock_timestamp() END)
           RETURNING ${FISCAL_RECEIPT_COLUMNS}`,
          [
            randomUUID(),
            branchId,
            orderId,
            number !== null ? 'recorded' : receiptDue ? 'pending' : 'not_required',
            number,
            quote.total_minor,
            number !== null ? actor.staff_id : null,
          ],
        )
      ).rows[0];
      const sale = await loadPosSale(client, branchId, actor, orderId);
      await appendPosSaleEvent(client, branchId, 'sale', orderId, {
        order_id: orderId,
        quote,
        shift_id: shift.id,
        terminal_id: actor.terminal_id,
        cashier_staff_id: actor.staff_id,
        display_number: sale.display_number,
        sales_channel: sale.sales_channel,
        external_order_ref: sale.external_order_ref,
        service_mode: sale.service_mode,
        revenue_kind: sale.revenue_kind,
        total_minor: sale.total_minor,
        cash_tendered_minor: sale.cash_tendered_minor,
        change_minor: sale.change_minor,
        beneficiary: request.beneficiary ?? null,
        reason: request.reason ?? null,
        approval,
        tenders: sale.tenders,
        created_at: sale.created_at,
      });
      await appendFiscalEvent(client, branchId, fiscalReceipt(receipt));
      const order = await loadOrder(client, branchId, actor, orderId);
      await orderEvent(client, order, 'order.created');
      await audit(client, branchId, actor.staff_id, 'pos_sale.created', orderId);
      return PosSaleResultSchema.parse({ order, sale });
    },
  );
}

/** GET pos/sales/{orderId}: the sale of this cash desk (a shift manager sees every desk). */
export async function readPosSale(
  pool: DatabasePool,
  branchId: string,
  auth: StaffAuth,
  orderId: string,
) {
  if (!UuidSchema.safeParse(orderId).success) throw new OrderError('INVALID_REQUEST');
  return transaction(pool, async (client) => {
    const actor = await authenticateStaff(client, branchId, auth);
    requirePermission(actor, 'read');
    if (!(await posSalesInstalled(client))) throw new OrderError('NOT_FOUND');
    return loadPosSale(client, branchId, actor, orderId);
  });
}
