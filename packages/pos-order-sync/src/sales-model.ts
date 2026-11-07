import { z } from 'zod';
import {
  ManagerApprovalActionSchema,
  POS_PAYMENT_METHOD_POLICY,
  PosFiscalReceiptSchema,
  PosPaymentConfirmationSchema,
  PosPaymentMethodSchema,
  PosRefundKindSchema,
  PosRefundReasonSchema,
  PosRevenueKindSchema,
  PosShiftReportSchema,
  QuoteSchema,
  SalesChannelSchema,
} from '@pickchick/contracts';
import { hashJson } from '@pickchick/menu-sync';
import { MAX_EVENT_BYTES, PosSyncError } from './model.js';

/**
 * posSales wire (contracts 5.6, lane pos): the edge writes these events into pos_sale_outbox in
 * the transaction of the sale, void, refund, receipt record or shift close; the cloud lane's
 * sender (sales-worker.ts) posts them in sequence order to POS_SALES_SYNC_PATH and its receiver
 * (sales-cloud.ts) projects them into cloud_pos_* (cloud073). Disabled by default
 * (CLOUD_POS_SALES_SYNC_ENABLED): an older cloud answers 404 and the outbox keeps the events.
 */
export const POS_SALES_SYNC_PATH = '/internal/v1/edge/pos-orders/sales';
/** Events per request; an empty batch is the support probe. */
export const MAX_POS_SALE_BATCH = 50;
/** JSON body budget of one request: under the 100 KiB default HTTP limit of the API. */
export const MAX_POS_SALE_BATCH_BYTES = 96 * 1024;

const uuid = z.uuid();
const datetime = z.iso.datetime();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sequence = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine(
    (value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
    'Exceeds PostgreSQL bigint',
  );
const money = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine(
    (value) => /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n,
    'Exceeds PostgreSQL bigint',
  );
const positiveMoney = money.refine((value) => /^[1-9]\d{0,18}$/.test(value), 'Must be positive');
const reference = z.string().trim().min(1).max(40);

export const PosSaleEventKindSchema = z.enum(['sale', 'void', 'refund', 'fiscal', 'shift_report']);
export const PosSaleWireTenderSchema = z.strictObject({
  tender_id: uuid,
  method: PosPaymentMethodSchema,
  amount_minor: positiveMoney,
  confirmation: PosPaymentConfirmationSchema,
  reference: reference.nullable(),
});
/** `sale`: the paid order with its priced quote (QuoteLine[], release and menu version). */
export const PosSaleSalePayloadSchema = z.strictObject({
  order_id: uuid,
  quote: QuoteSchema,
  shift_id: uuid,
  terminal_id: uuid,
  cashier_staff_id: uuid,
  display_number: z.number().int().min(1).max(2147483647),
  sales_channel: SalesChannelSchema,
  external_order_ref: z
    .string()
    .regex(/^[A-Z0-9-]{3,40}$/)
    .nullable(),
  service_mode: z.enum(['dine_in', 'takeaway']),
  revenue_kind: PosRevenueKindSchema,
  total_minor: positiveMoney,
  cash_tendered_minor: positiveMoney.nullable(),
  change_minor: money.nullable(),
  beneficiary: z.string().trim().min(1).max(100).nullable(),
  reason: z.string().trim().min(3).max(300).nullable(),
  approval: z
    .strictObject({
      approval_id: uuid,
      manager_staff_id: uuid,
      action: ManagerApprovalActionSchema,
    })
    .nullable(),
  tenders: z.array(PosSaleWireTenderSchema).min(1).max(2),
  created_at: datetime,
});
/** `void` and `refund` (the payload kind repeats the event kind). */
export const PosSaleRefundPayloadSchema = z.strictObject({
  refund_id: uuid,
  order_id: uuid,
  kind: PosRefundKindSchema,
  shift_id: uuid,
  terminal_id: uuid,
  staff_id: uuid,
  approved_by_staff_id: uuid,
  approval_id: uuid,
  amount_minor: positiveMoney,
  reason_code: PosRefundReasonSchema,
  reason: z.string().trim().min(3).max(300),
  tenders: z
    .array(
      z.strictObject({
        tender_id: uuid,
        method: PosPaymentMethodSchema,
        amount_minor: positiveMoney,
      }),
    )
    .min(1)
    .max(2),
  created_at: datetime,
});
/** `fiscal`: the full receipt record after each change (newer version replaces older). */
export const PosSaleFiscalPayloadSchema = PosFiscalReceiptSchema;
/** `shift_report`: the frozen Z report of a closed sales shift. */
export const PosSaleShiftReportPayloadSchema = z.strictObject({
  shift_id: uuid,
  terminal_id: uuid,
  report: PosShiftReportSchema,
});
const envelope = { event_id: uuid, branch_id: uuid, sequence, occurred_at: datetime };
export const PosSaleEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...envelope, kind: z.literal('sale'), payload: PosSaleSalePayloadSchema }),
  z.strictObject({ ...envelope, kind: z.literal('void'), payload: PosSaleRefundPayloadSchema }),
  z.strictObject({ ...envelope, kind: z.literal('refund'), payload: PosSaleRefundPayloadSchema }),
  z.strictObject({ ...envelope, kind: z.literal('fiscal'), payload: PosSaleFiscalPayloadSchema }),
  z.strictObject({
    ...envelope,
    kind: z.literal('shift_report'),
    payload: PosSaleShiftReportPayloadSchema,
  }),
]);
/** POST body; `{events: []}` is the support probe (any 200 = the cloud supports posSales). */
export const PosSaleBatchSchema = z.strictObject({
  events: z.array(PosSaleEventSchema).max(MAX_POS_SALE_BATCH),
});
export const PosSaleEventReceiptSchema = z.strictObject({
  event_id: uuid,
  sequence,
  payload_hash: hash,
  acknowledged: z.literal(true),
});
/**
 * The receiver accepts a prefix of the batch in order and ACKs only after COMMIT. CONFLICT: the
 * event id or (device, sequence) is known with another payload hash; INVALID_EVENT: the event
 * fails this model (arithmetic, identity). Either way the edge parks the stream with last_error.
 */
export const PosSaleRejectCodeSchema = z.enum(['CONFLICT', 'INVALID_EVENT']);
export const PosSaleBatchResultSchema = z.strictObject({
  receipts: z.array(PosSaleEventReceiptSchema).max(MAX_POS_SALE_BATCH),
  rejected: z.strictObject({ event_id: uuid, code: PosSaleRejectCodeSchema }).optional(),
});
export type PosSaleEvent = z.infer<typeof PosSaleEventSchema>;
export type PosSaleBatch = z.infer<typeof PosSaleBatchSchema>;
export type PosSaleBatchResult = z.infer<typeof PosSaleBatchResultSchema>;

/** payload_hash of an outbox row and of its receipt: hashJson(payload) (canonical JSON). */
export const posSalePayloadHash = (event: Pick<PosSaleEvent, 'payload'>) => hashJson(event.payload);
export const posSaleReceiptFor = (event: PosSaleEvent) => ({
  event_id: event.event_id,
  sequence: event.sequence,
  payload_hash: posSalePayloadHash(event),
  acknowledged: true as const,
});

const sum = (values: readonly string[]) => values.reduce((total, v) => total + BigInt(v), 0n);
const unique = (values: readonly string[]) => new Set(values).size === values.length;

function saleViolation(event: PosSaleEvent & { kind: 'sale' }) {
  const p = event.payload,
    q = p.quote,
    methods = p.tenders.map((tender) => tender.method),
    cash = p.tenders.filter((tender) => tender.method === 'cash');
  if (
    q.branch_id !== event.branch_id ||
    q.total_minor !== p.total_minor ||
    BigInt(q.subtotal_minor) - BigInt(q.discount_minor) !== BigInt(q.total_minor) ||
    q.service_mode !== p.service_mode ||
    (q.sales_channel ?? 'hall') !== p.sales_channel ||
    sum(q.lines.map((line) => line.total_minor)) !== BigInt(q.subtotal_minor) ||
    q.lines.some(
      (line) => BigInt(line.unit_price_minor) * BigInt(line.quantity) !== BigInt(line.total_minor),
    )
  )
    return 'quote';
  if (
    !unique(p.tenders.map((tender) => tender.tender_id)) ||
    sum(p.tenders.map((tender) => tender.amount_minor)) !== BigInt(p.total_minor)
  )
    return 'tender_sum';
  if (
    p.tenders.some((tender) => {
      const policy = POS_PAYMENT_METHOD_POLICY[tender.method];
      return (
        policy.confirmation !== tender.confirmation ||
        !policy.channels.includes(p.sales_channel) ||
        (tender.method === 'kaspi_terminal' && BigInt(tender.amount_minor) % 100n !== 0n)
      );
    })
  )
    return 'tender_method';
  if (
    methods.length === 2 &&
    (cash.length > 1 || methods.some((method) => !POS_PAYMENT_METHOD_POLICY[method].allow_in_mix))
  )
    return 'mix';
  const numbered = p.sales_channel !== 'hall' || methods.includes('chocofood');
  if (
    numbered !== (p.external_order_ref !== null) ||
    (p.sales_channel !== 'hall' && p.service_mode !== 'takeaway')
  )
    return 'external_order_ref';
  const kind = methods.includes('staff_meal')
    ? 'staff_meal'
    : methods.includes('marketing')
      ? 'marketing'
      : 'revenue';
  if (
    p.revenue_kind !== kind ||
    (kind !== 'revenue' && p.approval?.action !== kind) ||
    (kind === 'staff_meal' && p.beneficiary === null) ||
    (kind === 'marketing' && p.reason === null)
  )
    return 'revenue_kind';
  const cashAmount = cash[0] ? BigInt(cash[0].amount_minor) : null;
  if (
    (cashAmount === null) !== (p.cash_tendered_minor === null) ||
    (p.cash_tendered_minor === null) !== (p.change_minor === null) ||
    (cashAmount !== null &&
      (BigInt(p.cash_tendered_minor!) < cashAmount ||
        BigInt(p.change_minor!) !== BigInt(p.cash_tendered_minor!) - cashAmount))
  )
    return 'cash';
  return null;
}

function shiftReportViolation(event: PosSaleEvent & { kind: 'shift_report' }) {
  const p = event.payload,
    r = p.report,
    methods = new Map(r.methods.map((row) => [row.method, row])),
    cash = methods.get('cash'),
    terminal = methods.get('kaspi_terminal');
  if (
    r.kind !== 'z' ||
    r.state !== 'closed' ||
    r.shift_id !== p.shift_id ||
    r.terminal_id !== p.terminal_id ||
    r.closed_at === null ||
    Date.parse(r.closed_at) < Date.parse(r.opened_at) ||
    r.counted_cash_minor === null ||
    r.discrepancy_minor === null ||
    methods.size !== r.methods.length ||
    !unique(r.channels.map((row) => row.sales_channel))
  )
    return 'identity';
  if (
    BigInt(r.opening_cash_minor) +
      BigInt(r.cash_in_minor) -
      BigInt(r.cash_out_minor) +
      BigInt(r.cash_sales_minor) -
      BigInt(r.cash_refunds_minor) !==
      BigInt(r.expected_cash_minor) ||
    BigInt(r.counted_cash_minor) - BigInt(r.expected_cash_minor) !== BigInt(r.discrepancy_minor) ||
    BigInt(cash?.sales_minor ?? '0') !== BigInt(r.cash_sales_minor) ||
    BigInt(cash?.refunds_minor ?? '0') !== BigInt(r.cash_refunds_minor)
  )
    return 'cash';
  const terminalNet = BigInt(terminal?.sales_minor ?? '0') - BigInt(terminal?.refunds_minor ?? '0');
  if (
    (r.terminal_reported_minor === null) !== (r.terminal_discrepancy_minor === null) ||
    (r.terminal_reported_minor !== null &&
      BigInt(r.terminal_reported_minor) - terminalNet !== BigInt(r.terminal_discrepancy_minor!))
  )
    return 'terminal';
  return null;
}

/**
 * Invariants of one event beyond its schema (contracts 2.2, 5.6); null when it holds. Cross-event
 * limits (refunds per tender and per sale) need the receiver's stored state.
 */
export function posSaleEventViolation(event: PosSaleEvent): string | null {
  switch (event.kind) {
    case 'sale':
      return saleViolation(event);
    case 'void':
    case 'refund': {
      const p = event.payload;
      if (p.kind !== event.kind) return 'kind';
      if (
        !unique(p.tenders.map((tender) => tender.tender_id)) ||
        sum(p.tenders.map((tender) => tender.amount_minor)) !== BigInt(p.amount_minor)
      )
        return 'tender_sum';
      return null;
    }
    case 'fiscal': {
      const p = event.payload,
        recorded = p.state === 'recorded';
      if (
        (p.kind === 'refund') !== (p.refund_id !== null) ||
        recorded !== (p.receipt_number !== null) ||
        recorded !== (p.recorded_at !== null) ||
        recorded !== (p.recorded_by_staff_id !== null)
      )
        return 'receipt';
      return null;
    }
    case 'shift_report':
      return shiftReportViolation(event);
  }
}

/** Strict parse of one event: schema, canonical bytes, size and invariants. */
export function parsePosSaleEvent(input: unknown): PosSaleEvent {
  const parsed = PosSaleEventSchema.safeParse(input);
  if (
    !parsed.success ||
    Buffer.byteLength(JSON.stringify(input)) > MAX_EVENT_BYTES ||
    hashJson(input) !== hashJson(parsed.data) ||
    posSaleEventViolation(parsed.data) !== null
  )
    throw new PosSyncError('INVALID_REQUEST');
  return parsed.data;
}

/** Strict parse of a request body: one branch, unique events, strictly increasing sequences. */
export function parsePosSaleBatch(input: unknown): PosSaleBatch {
  const parsed = PosSaleBatchSchema.safeParse(input);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(input)) > MAX_POS_SALE_BATCH_BYTES)
    throw new PosSyncError('INVALID_REQUEST');
  const events = parsed.data.events;
  if (
    !unique(events.map((event) => event.event_id)) ||
    new Set(events.map((event) => event.branch_id)).size > 1 ||
    events.some(
      (event, index) => index > 0 && BigInt(event.sequence) <= BigInt(events[index - 1]!.sequence),
    )
  )
    throw new PosSyncError('INVALID_REQUEST');
  return parsed.data;
}
