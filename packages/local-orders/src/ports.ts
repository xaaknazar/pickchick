/**
 * Seams for future device and fiscal adapters (cutover 19.11.2026, contracts 1.3). Types only:
 * in P0 nothing implements or calls them. The Kaspi Smart POS is marked by the cashier
 * (`confirmation='cashier_attested'`, pos_sale_tenders.attempt_id stays NULL) and Webkassa
 * receipts are punched by hand in the Webkassa cabinet, their numbers typed into the POS
 * (fiscal mode `manual_webkassa`, pos_fiscal_receipts). An adapter added later implements these
 * interfaces behind the same tables; the manual order stays the fallback. No adapter may claim a
 * payment or a receipt that its device or service did not confirm (AGENTS.md).
 */
import type { FiscalReceiptState, PosPaymentMethod } from '@pickchick/contracts';

/** One payment attempt on a card/QR terminal of a cash desk (whole tenge, one at a time). */
export interface PaymentTerminalAttempt {
  /** Edge id of the attempt; becomes pos_sale_tenders.attempt_id once the adapter exists. */
  attemptId: string;
  branchId: string;
  terminalId: string;
  kind: 'sale' | 'refund';
  /** Money in tiyn, a multiple of 100 (the terminal takes whole tenge). */
  amountMinor: string;
  method: Extract<PosPaymentMethod, 'kaspi_terminal'>;
  /** The quote of a sale or the order of a refund. */
  quoteId?: string;
  orderId?: string;
}
/** State of an attempt as the terminal reports it; `unknown` is never retried automatically. */
export type PaymentTerminalState =
  'started' | 'waiting_customer' | 'approved' | 'declined' | 'cancelled' | 'unknown';
export interface PaymentTerminalStatus {
  processId: string;
  state: PaymentTerminalState;
  /** Amount the terminal confirmed, in tiyn; null until approved. */
  approvedMinor: string | null;
  /** Terminal operation reference for the tender (1..40 characters), when it gives one. */
  reference: string | null;
}
/**
 * PaymentTerminalPort {start(attempt), status(processId), cancel(processId)}: one operation per
 * terminal at a time; a lost answer is resolved by status(), never by a second charge.
 */
export interface PaymentTerminalPort {
  start(attempt: PaymentTerminalAttempt): Promise<{ processId: string }>;
  status(processId: string): Promise<PaymentTerminalStatus>;
  cancel(processId: string): Promise<PaymentTerminalStatus>;
}

/** Fiscal mode of the branch; only the manual Webkassa order exists in P0. */
export type FiscalPortMode = 'manual_webkassa';
/** A receipt to issue: the sale or refund it covers and its amount (pos_fiscal_receipts row). */
export interface FiscalReceiptRequest {
  receiptId: string;
  branchId: string;
  terminalId: string;
  orderId: string;
  /** Set for a refund receipt. */
  refundId?: string;
  amountMinor: string;
  /** Tender methods covered by the receipt (sale tenders or refunded parts). */
  methods: readonly PosPaymentMethod[];
}
/** Result of issuing: `pending` in manual mode (the cashier types the number later). */
export interface FiscalIssueResult {
  state: FiscalReceiptState;
  receiptNumber: string | null;
}
/** Fiscal shift of one cash desk (Webkassa opens and closes it with the PickChick shift). */
export interface FiscalShiftRequest {
  branchId: string;
  terminalId: string;
  shiftId: string;
}
/** FiscalPort {issueSale, issueRefund, openShift, closeShift} (contracts 1.3). */
export interface FiscalPort {
  readonly mode: FiscalPortMode;
  issueSale(receipt: FiscalReceiptRequest): Promise<FiscalIssueResult>;
  issueRefund(receipt: FiscalReceiptRequest & { refundId: string }): Promise<FiscalIssueResult>;
  openShift(shift: FiscalShiftRequest): Promise<void>;
  closeShift(shift: FiscalShiftRequest): Promise<void>;
}
