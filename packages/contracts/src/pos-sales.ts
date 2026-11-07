import { z } from 'zod';
import {
  ExternalOrderRefSchema,
  FiscalModeSchema,
  FiscalReceiptKindSchema,
  FiscalReceiptStateSchema,
  ManagerApprovalActionSchema,
  PosPaymentConfirmationSchema,
  PosPaymentMethodSchema,
  PosRefundKindSchema,
  PosRefundReasonSchema,
  PosRevenueKindSchema,
  PosServiceModeSchema,
  SalesChannelSchema,
} from './cutover-enums.js';
import type {
  AggregatorChannel,
  PosPaymentConfirmation,
  PosPaymentMethod,
  SalesChannel,
} from './cutover-enums.js';

/**
 * Cutover 19.11.2026, lane pos: paid POS sales on the cashier edge (contracts section 5.1).
 * Every route is /edge/v1/*, staff session, POST with Idempotency-Key through command(). Money is
 * a string of whole tiyn. Nothing here is served while the branch is not in pos_sale mode, and
 * an older edge answers 404 on GET pos/config (the POS then keeps its unpaid UI).
 * Schemas that extend index.ts schemas (quote request, shift close, {order, sale}) live in the
 * pos region of index.ts; this module stays free of imports from it.
 */
const uuid = z.uuid();
const datetime = z.iso.datetime();
const version = z.number().int().min(1).max(2147483647);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const money = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine(
    (value) => /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n,
    'Exceeds PostgreSQL bigint',
  );
const positiveMoney = money.refine((value) => /^[1-9]\d{0,18}$/.test(value), 'Must be positive');
const signedMoney = z
  .string()
  .regex(/^(?:0|-?[1-9]\d{0,18})$/)
  .refine(
    (value) =>
      /^(?:0|-?[1-9]\d{0,18})$/.test(value) &&
      BigInt(value) >= -9223372036854775807n &&
      BigInt(value) <= 9223372036854775807n,
    'Exceeds PostgreSQL bigint',
  );
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
/** Typed by a cashier (terminal operation, Webkassa receipt): free text without control chars. */
const typedNumber = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine(
    (value) => [...value].every((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127),
    'Control character',
  );
/** Cashier display number of the kitchen admission (1-299 for the cashier, edge 022). */
const displayNumber = z.number().int().min(1).max(2147483647);
const serviceMode = z.enum(['dine_in', 'takeaway']);
const reasonText = z.string().trim().min(3).max(300);

export const PosFiscalPolicySchema = z.enum(['manual_webkassa', 'not_required']);
export const PosPickupSchema = z.enum(['issue', 'delivery_handover']);
export type PosFiscalPolicy = z.infer<typeof PosFiscalPolicySchema>;

/**
 * Payment method policy of contracts section 00 (owner decisions 05.11). requires_approval and
 * allow_in_mix are pinned by edge schema026 CHECKs; fiscal_policy is the default the operator may
 * change (scripts/pos-sales-setup.mjs fiscal-policy). `channels`: where the method may pay;
 * `confirmation`: how the tender is confirmed (manual marking until terminal/fiscal adapters).
 */
export const POS_PAYMENT_METHOD_POLICY: Readonly<
  Record<
    PosPaymentMethod,
    Readonly<{
      requires_approval: boolean;
      allow_in_mix: boolean;
      fiscal_policy: PosFiscalPolicy;
      confirmation: PosPaymentConfirmation;
      channels: readonly SalesChannel[];
    }>
  >
> = Object.freeze({
  cash: {
    requires_approval: false,
    allow_in_mix: true,
    fiscal_policy: 'manual_webkassa',
    confirmation: 'drawer',
    channels: ['hall'],
  },
  kaspi_terminal: {
    requires_approval: false,
    allow_in_mix: true,
    fiscal_policy: 'manual_webkassa',
    confirmation: 'cashier_attested',
    channels: ['hall'],
  },
  aggregator_yandex_eda: {
    requires_approval: false,
    allow_in_mix: false,
    fiscal_policy: 'not_required',
    confirmation: 'aggregator_attested',
    channels: ['yandex_eda'],
  },
  aggregator_glovo: {
    requires_approval: false,
    allow_in_mix: false,
    fiscal_policy: 'not_required',
    confirmation: 'aggregator_attested',
    channels: ['glovo'],
  },
  staff_meal: {
    requires_approval: true,
    allow_in_mix: false,
    fiscal_policy: 'not_required',
    confirmation: 'manager_approved',
    channels: ['hall'],
  },
  marketing: {
    requires_approval: true,
    allow_in_mix: false,
    fiscal_policy: 'not_required',
    confirmation: 'manager_approved',
    channels: ['hall'],
  },
  kaspi_manual: {
    requires_approval: false,
    allow_in_mix: true,
    fiscal_policy: 'manual_webkassa',
    confirmation: 'cashier_attested',
    channels: ['hall'],
  },
  chocofood: {
    requires_approval: false,
    allow_in_mix: false,
    fiscal_policy: 'not_required',
    confirmation: 'aggregator_attested',
    channels: ['hall'],
  },
});
/** Approval token lifetime of POST staff/approvals (edge schema026 CHECK). */
export const POS_APPROVAL_TTL_SECONDS = 120;

/** GET pos/config: what the POS may offer now. */
export const PosConfigMethodSchema = z.strictObject({
  code: PosPaymentMethodSchema,
  enabled: z.boolean(),
  requires_approval: z.boolean(),
  allow_in_mix: z.boolean(),
  fiscal_policy: PosFiscalPolicySchema,
});
export const PosConfigChannelSchema = z.strictObject({
  code: SalesChannelSchema,
  enabled: z.boolean(),
});
/** Number of a cash desk (edge schema028 local_terminals.desk_number), set by the operator. */
export const PosDeskNumberSchema = z.number().int().min(1).max(99);
export const PosConfigSchema = z.strictObject({
  mode: PosServiceModeSchema,
  methods: z.array(PosConfigMethodSchema).max(8),
  channels: z.array(PosConfigChannelSchema).max(3),
  fiscal_mode: FiscalModeSchema,
  approval_ttl_seconds: z.literal(POS_APPROVAL_TTL_SECONDS),
  server_time: datetime,
  /**
   * The session terminal's desk number (lead decision 07.11 (1), CR pos-7): null until the
   * operator sets one, and on an edge without schema028. The last key, so every earlier byte of
   * the answer stays as before; a POS reads a 026 edge's answer without it as null.
   */
  desk_number: PosDeskNumberSchema.nullable(),
});

/** One-time manager confirmation attached to a command (POST staff/approvals result). */
export const PosApprovalProofSchema = z.strictObject({ approval_id: uuid, token: hex64 });

/** POST pos/sales. Tenders sum to the quote total (rules: contracts 2.2 and section 00). */
export const PosTenderInputSchema = z.strictObject({
  method: PosPaymentMethodSchema,
  amount_minor: positiveMoney,
  reference: typedNumber.optional(),
});
export const PosSaleRequestSchema = z.strictObject({
  quote_id: uuid,
  service_mode_confirmed: z.literal(true),
  order_repeated: z.literal(true),
  external_order_ref: ExternalOrderRefSchema.optional(),
  tenders: z.array(PosTenderInputSchema).min(1).max(2),
  cash_tendered_minor: positiveMoney.optional(),
  beneficiary: z.string().trim().min(1).max(100).optional(),
  reason: reasonText.optional(),
  approval: PosApprovalProofSchema.optional(),
  fiscal_receipt_number: typedNumber.optional(),
});

/** GET pos/sales/{orderId} and the `sale` of POST pos/sales and void. */
export const PosSaleTenderSchema = z.strictObject({
  tender_id: uuid,
  method: PosPaymentMethodSchema,
  amount_minor: positiveMoney,
  confirmation: PosPaymentConfirmationSchema,
  reference: typedNumber.nullable(),
});
export const PosRefundTenderSchema = z.strictObject({
  tender_id: uuid,
  amount_minor: positiveMoney,
});
const refundTenders = z
  .array(PosRefundTenderSchema)
  .min(1)
  .max(2)
  .refine(
    (tenders) => new Set(tenders.map((tender) => tender.tender_id)).size === tenders.length,
    'Duplicate tender',
  );
export const PosSaleRefundSchema = z.strictObject({
  refund_id: uuid,
  kind: PosRefundKindSchema,
  amount_minor: positiveMoney,
  reason_code: PosRefundReasonSchema,
  approved_by_staff_id: uuid,
  created_at: datetime,
  tenders: refundTenders,
});
export const PosSaleFiscalSchema = z.strictObject({
  receipt_id: uuid,
  kind: FiscalReceiptKindSchema,
  state: FiscalReceiptStateSchema,
  receipt_number: typedNumber.nullable(),
  version,
  amount_minor: positiveMoney,
});
export const PosSaleSchema = z.strictObject({
  order_id: uuid,
  display_number: displayNumber,
  pickup: PosPickupSchema,
  sales_channel: SalesChannelSchema,
  external_order_ref: z
    .string()
    .regex(/^[A-Z0-9-]{3,40}$/)
    .nullable(),
  service_mode: serviceMode,
  revenue_kind: PosRevenueKindSchema,
  total_minor: positiveMoney,
  cash_tendered_minor: positiveMoney.nullable(),
  change_minor: money.nullable(),
  tenders: z.array(PosSaleTenderSchema).min(1).max(2),
  refunds: z.array(PosSaleRefundSchema).max(100),
  refundable_minor: money,
  fiscal: z.array(PosSaleFiscalSchema).min(1).max(101),
  shift_id: uuid,
  terminal_id: uuid,
  cashier_staff_id: uuid,
  created_at: datetime,
});

/** POST pos/sales/{orderId}/void: only before the kitchen starts (else ORDER_IN_PRODUCTION). */
export const PosVoidRequestSchema = z.strictObject({
  expected_version: version,
  reason_code: PosRefundReasonSchema,
  reason: reasonText,
  fiscal_sale_issued: z.boolean(),
  approval: PosApprovalProofSchema,
});
/** POST pos/sales/{orderId}/refunds: by tender, the full or a partial amount of each. */
export const PosRefundRequestSchema = z.strictObject({
  refund_id: uuid,
  tenders: refundTenders,
  reason_code: PosRefundReasonSchema,
  reason: reasonText,
  approval: PosApprovalProofSchema,
});

/** POST staff/approvals: the shift manager's PIN on this cash desk (terminal from the session). */
export const ManagerApprovalSubjectSchema = z.union([
  z.strictObject({ order_id: uuid, amount_minor: money }),
  z.strictObject({ quote_id: uuid, amount_minor: money }),
  z.strictObject({ shift_id: uuid, amount_minor: money }),
]);
export const ManagerApprovalRequestSchema = z.strictObject({
  staff_id: uuid,
  pin: z.string().regex(/^(?:[0-9]{4}|[0-9]{6})$/),
  action: ManagerApprovalActionSchema,
  subject: ManagerApprovalSubjectSchema,
});
export const ManagerApprovalSchema = z.strictObject({
  approval_id: uuid,
  token: hex64,
  expires_at: datetime,
  manager: z.strictObject({ staff_id: uuid, name: z.string().min(1).max(100) }),
});

/** Manual Webkassa: GET pos/fiscal-receipts/pending?shift_id= and POST .../{receiptId}/record. */
export const PosFiscalPendingQuerySchema = z.strictObject({ shift_id: uuid.optional() });
export const PosFiscalPendingItemSchema = z.strictObject({
  receipt_id: uuid,
  order_id: uuid,
  display_number: displayNumber,
  kind: FiscalReceiptKindSchema,
  amount_minor: positiveMoney,
  methods: z.array(PosPaymentMethodSchema).min(1).max(2),
  created_at: datetime,
  version,
});
export const PosFiscalPendingSchema = z.strictObject({
  receipts: z.array(PosFiscalPendingItemSchema).max(1000),
});
/** approval (fiscal_correct) is required only when the receipt is already recorded. */
export const PosFiscalRecordRequestSchema = z.strictObject({
  expected_version: version,
  receipt_number: typedNumber,
  approval: PosApprovalProofSchema.optional(),
});
/** One receipt record; also the `fiscal` payload of the posSales stream (contracts 5.6). */
export const PosFiscalReceiptSchema = z.strictObject({
  receipt_id: uuid,
  order_id: uuid,
  refund_id: uuid.nullable(),
  kind: FiscalReceiptKindSchema,
  mode: FiscalModeSchema,
  state: FiscalReceiptStateSchema,
  receipt_number: typedNumber.nullable(),
  version,
  amount_minor: positiveMoney,
  recorded_by_staff_id: uuid.nullable(),
  recorded_at: datetime.nullable(),
});

/**
 * ShiftReport (contracts 5.1): GET cash-shifts/{id}/x-report (snapshot, any state) and
 * z-report (frozen at closing, closed shifts only). Not fiscal.
 * expected = opening + in - out + cash_sales - cash_refunds, where cash_sales is the cash tender
 * of the shift's sales (tendered minus change) and cash_refunds the cash refunds paid out of this
 * drawer. methods: per method, tenders of the shift's sales and refund tenders of the refunds
 * made in it; terminal_discrepancy = terminal_reported - (kaspi_terminal sales - refunds).
 */
export const PosShiftReportMethodSchema = z.strictObject({
  method: PosPaymentMethodSchema,
  sales_minor: money,
  refunds_minor: money,
  count,
});
export const PosShiftReportChannelSchema = z.strictObject({
  sales_channel: SalesChannelSchema,
  total_minor: money,
  count,
});
export const PosShiftReportSchema = z.strictObject({
  kind: z.enum(['x', 'z']),
  shift_id: uuid,
  terminal_id: uuid,
  state: z.enum(['open', 'closed']),
  opened_at: datetime,
  closed_at: datetime.nullable(),
  opening_cash_minor: money,
  cash_in_minor: money,
  cash_out_minor: money,
  cash_sales_minor: money,
  cash_refunds_minor: money,
  expected_cash_minor: money,
  counted_cash_minor: money.nullable(),
  discrepancy_minor: signedMoney.nullable(),
  methods: z.array(PosShiftReportMethodSchema).max(8),
  channels: z.array(PosShiftReportChannelSchema).max(3),
  terminal_reported_minor: money.nullable(),
  terminal_discrepancy_minor: signedMoney.nullable(),
  fiscal: z.strictObject({ pending: count, recorded: count, not_required: count }),
  orders: z.strictObject({ count, voided_count: count }),
  report_at: datetime,
});

/** Error codes of the POS sale routes (UI texts are the client lane's; contracts 5.1, 00). */
export const PosErrorCodeSchema = z.enum([
  'SERVICE_MODE_DISABLED',
  'METHOD_DISABLED',
  'TENDER_SUM_MISMATCH',
  'CASH_TENDERED_TOO_LOW',
  'TERMINAL_AMOUNT_NOT_WHOLE',
  'CHANNEL_PRICE_UNAVAILABLE',
  'EXTERNAL_REF_REQUIRED',
  'EXTERNAL_REF_DUPLICATE',
  'APPROVAL_REQUIRED',
  'APPROVAL_INVALID',
  'ORDER_IN_PRODUCTION',
  'REFUND_LIMIT',
  'REFUND_NOT_SUPPORTED',
  'DRAWER_INSUFFICIENT',
  'FISCAL_PENDING',
]);
export type PosErrorCode = z.infer<typeof PosErrorCodeSchema>;
const POS_ERROR_TEXTS_RU: Readonly<Record<PosErrorCode, string>> = Object.freeze({
  SERVICE_MODE_DISABLED: 'Касса не принимает оплату - сообщите менеджеру',
  METHOD_DISABLED: 'Этот способ оплаты выключен',
  TENDER_SUM_MISMATCH: 'Сумма оплат не равна сумме заказа',
  CASH_TENDERED_TOO_LOW: 'Внесено меньше суммы наличными',
  TERMINAL_AMOUNT_NOT_WHOLE: 'На терминале - только целые тенге',
  // Fallback only; the POS always knows the channel (texts below).
  CHANNEL_PRICE_UNAVAILABLE: 'Нет в меню агрегатора',
  EXTERNAL_REF_REQUIRED: 'Введите номер заказа агрегатора',
  EXTERNAL_REF_DUPLICATE: 'Этот номер заказа уже пробит',
  APPROVAL_REQUIRED: 'Нужен PIN начальника смены',
  APPROVAL_INVALID: 'Подтверждение недействительно или истекло - введите PIN ещё раз',
  ORDER_IN_PRODUCTION: 'Кухня уже начала - оформите возврат',
  REFUND_LIMIT: 'Сумма больше доступной к возврату',
  REFUND_NOT_SUPPORTED: 'Возврат агрегатора оформляется в кабинете агрегатора',
  DRAWER_INSUFFICIENT: 'В кассе недостаточно наличных',
  FISCAL_PENDING: 'Есть неоформленные чеки Webkassa',
});
const POS_CHANNEL_PRICE_TEXTS_RU: Readonly<Record<AggregatorChannel, string>> = Object.freeze({
  yandex_eda: 'Нет в меню Яндекс Еды',
  glovo: 'Нет в меню Glovo',
});
/**
 * Russian text of a POS error (contracts 5.1 and section 00). `subject`: the aggregator channel of
 * CHANNEL_PRICE_UNAVAILABLE, or 'chocofood' for the ChocoFood texts of EXTERNAL_REF_REQUIRED and
 * REFUND_NOT_SUPPORTED.
 */
export function posErrorTextRu(code: PosErrorCode, subject?: AggregatorChannel | 'chocofood') {
  if (code === 'CHANNEL_PRICE_UNAVAILABLE' && (subject === 'yandex_eda' || subject === 'glovo'))
    return POS_CHANNEL_PRICE_TEXTS_RU[subject];
  if (code === 'EXTERNAL_REF_REQUIRED' && subject === 'chocofood')
    return 'Введите номер заказа ChocoFood';
  if (code === 'REFUND_NOT_SUPPORTED' && subject === 'chocofood')
    return 'Возврат ChocoFood оформляется в кабинете ChocoFood';
  return POS_ERROR_TEXTS_RU[code];
}

export type PosConfig = z.infer<typeof PosConfigSchema>;
export type PosApprovalProof = z.infer<typeof PosApprovalProofSchema>;
export type PosSaleRequest = z.infer<typeof PosSaleRequestSchema>;
export type PosSale = z.infer<typeof PosSaleSchema>;
export type PosVoidRequest = z.infer<typeof PosVoidRequestSchema>;
export type PosRefundRequest = z.infer<typeof PosRefundRequestSchema>;
export type ManagerApprovalRequest = z.infer<typeof ManagerApprovalRequestSchema>;
export type ManagerApproval = z.infer<typeof ManagerApprovalSchema>;
export type PosFiscalPending = z.infer<typeof PosFiscalPendingSchema>;
export type PosFiscalRecordRequest = z.infer<typeof PosFiscalRecordRequestSchema>;
export type PosFiscalReceipt = z.infer<typeof PosFiscalReceiptSchema>;
export type PosShiftReport = z.infer<typeof PosShiftReportSchema>;
