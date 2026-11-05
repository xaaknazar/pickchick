import { z } from 'zod';

/**
 * Cutover 19.11.2026 shared enums (docs/architecture/cutover-2026-11-contracts.md, section 2).
 * Owner: integration (D0). Lanes never edit this file; a change is a contract change request.
 */
export const SalesChannelSchema = z.enum(['hall', 'yandex_eda', 'glovo']);
export const AggregatorChannelSchema = z.enum(['yandex_eda', 'glovo']);
export const PosServiceModeSchema = z.enum(['payment_required', 'unpaid_service', 'pos_sale']);
export const PosPaymentMethodSchema = z.enum([
  'cash',
  'kaspi_terminal',
  'aggregator_yandex_eda',
  'aggregator_glovo',
  'staff_meal',
  'marketing',
  // Owner decision 05.11 (contracts section 00): full P0 methods, as in iiko without AILILLU.
  'kaspi_manual',
  'chocofood',
]);
export const PosPaymentConfirmationSchema = z.enum([
  'drawer',
  'cashier_attested',
  'aggregator_attested',
  'manager_approved',
]);
export const PosRevenueKindSchema = z.enum(['revenue', 'staff_meal', 'marketing']);
export const PosRefundKindSchema = z.enum(['void', 'refund']);
export const PosRefundReasonSchema = z.enum([
  'guest_changed_mind',
  'wrong_order',
  'quality',
  'aggregator_cancelled',
  'cashier_error',
  'other',
]);
export const ManagerApprovalActionSchema = z.enum([
  'void',
  'refund',
  'staff_meal',
  'marketing',
  'fiscal_correct',
  'shift_close_pending_fiscal',
  // P1, accepted by the database from day one:
  'discount',
  'cash_movement',
  'kds_mode',
  'courier_incident_update',
]);
export const FiscalModeSchema = z.enum(['manual_webkassa']);
export const FiscalReceiptKindSchema = z.enum(['sale', 'refund']);
export const FiscalReceiptStateSchema = z.enum(['pending', 'recorded', 'not_required']);
export const KdsFunctionSchema = z.enum([
  'breading',
  'toasts',
  'assembly_hall',
  'assembly_delivery',
  'issue',
  'delivery_handover',
]);
export const KdsUnitSchema = z.enum(['finger', 'toast', 'burger']);
export const KdsShiftModeSchema = z.enum(['morning', 'normal', 'peak']);
export const CourierIncidentKindSchema = z.enum([
  'number_mismatch',
  'not_accepted_in_app',
  'no_photo',
  'courier_refused',
  'other',
]);
export const CourierIncidentStatusSchema = z.enum([
  'open',
  'manager_on_site',
  'sent_to_aggregator',
  'resolved',
]);
export const StockWasteReasonSchema = z.enum([
  'hot_cabinet_expired',
  'meat_expired',
  'defect',
  'prep_expired',
  'damaged',
  'returned_after_cooking',
  'rework',
  'other',
]);
export const StockSupplierKindSchema = z.enum([
  'central_kitchen',
  'bakery',
  'household',
  'supplier',
]);
export const BackofficeDesignationSchema = z.enum(['shift_manager', 'accountant']);
export const BackofficeEffectiveRoleSchema = z.enum([
  'manager',
  'shift_manager',
  'accountant',
  'analyst',
]);
/** Aggregator order number typed from the aggregator tablet; the edge stores it upper-case. */
export const ExternalOrderRefSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{3,40}$/);
export const aggregatorPaymentMethod = (
  channel: z.infer<typeof AggregatorChannelSchema>,
): 'aggregator_yandex_eda' | 'aggregator_glovo' =>
  channel === 'yandex_eda' ? 'aggregator_yandex_eda' : 'aggregator_glovo';

export type SalesChannel = z.infer<typeof SalesChannelSchema>;
export type AggregatorChannel = z.infer<typeof AggregatorChannelSchema>;
export type PosServiceMode = z.infer<typeof PosServiceModeSchema>;
export type PosPaymentMethod = z.infer<typeof PosPaymentMethodSchema>;
export type PosPaymentConfirmation = z.infer<typeof PosPaymentConfirmationSchema>;
export type ManagerApprovalAction = z.infer<typeof ManagerApprovalActionSchema>;
export type FiscalReceiptState = z.infer<typeof FiscalReceiptStateSchema>;
export type KdsFunction = z.infer<typeof KdsFunctionSchema>;
export type KdsUnit = z.infer<typeof KdsUnitSchema>;
export type StockWasteReason = z.infer<typeof StockWasteReasonSchema>;
