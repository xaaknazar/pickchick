import type { Locale } from './i18n';
import type { KioskHealthFacts } from './kiosk-health';
import type { TestCompleteCatalog, TestSelection } from '@pickchick/test-order-flow/contracts';

/** Uploaded photo of a published product (catalog media map); image_id stays the bundled key. */
export interface KioskMedia {
  sha256: string;
  card: string;
  hero: string;
  thumb: string;
  tile_color?: string;
  cutout?: boolean;
}
export type KioskProduct = Omit<TestCompleteCatalog['products'][number], 'nutrition_provenance'> & {
  sku?: string;
  available?: boolean;
  nutrition_provenance: string;
  media?: KioskMedia;
};
export type KioskSelection = TestSelection;
export type KioskModifierGroup = KioskProduct['modifier_groups'][number];
export type KioskMode = 'takeaway' | 'dine_in';
export type KioskPaymentMethod = 'kaspi' | 'kaspi_invoice' | 'card';
export type KioskStep =
  | 'start'
  | 'mode'
  | 'menu'
  | 'product'
  | 'upsell'
  | 'cart'
  | 'loyalty'
  | 'payment'
  | 'order'
  | 'recovery';
export interface KioskCartLine {
  lineId: string;
  productId: string;
  quantity: number;
  selections: KioskSelection[];
  product: KioskProduct;
  unitPriceMinor: string;
  lineTotalMinor: string;
}
export interface KioskOrderView {
  order_id: string;
  number: string;
  state: string;
  payment_state: string;
  snapshot: { total_minor: string };
}
export type KioskCatalog = Omit<
  TestCompleteCatalog,
  'catalog_version' | 'branch_id' | 'synthetic' | 'namespace' | 'products'
> & { catalog_version: string; branch_id: string; products: KioskProduct[] };
/**
 * ADR-0018: what the guest sees of a payment on the kiosk's Kaspi Smart POS.
 * starting - the payment is being sent to the terminal; waiting - pay on the terminal;
 * checking - the terminal does not know the result yet; paid - paid, passing the order on;
 * failed / cancelled - the terminal declined, or the guest cancelled on it; not_started - the
 * terminal did not start it (busy with a previous operation, unreachable...): nothing was paid;
 * lost - sent without an answer: staff checks the terminal, the guest must not pay again.
 */
export interface TerminalPaymentView {
  phase:
    'starting' | 'waiting' | 'checking' | 'paid' | 'failed' | 'cancelled' | 'not_started' | 'lost';
  /** Why it did not start (not_started). */
  reason: 'busy' | 'blocked' | 'token' | 'unreachable' | 'refused' | null;
  /** The last status read did not reach the terminal or the server; it is retried. */
  offline: boolean;
  /** The terminal's subStatus (WaitUser, ProcessingCard...), for staff. */
  subStatus: string | null;
}
/** Outcome of the last staff action in the terminal setup. */
export type TerminalSetupResult =
  | 'linked'
  | 'ok'
  | 'unlinked'
  | 'host'
  | 'unreachable'
  | 'denied'
  | 'pending'
  | 'taken'
  | 'cloud'
  | 'mismatch'
  | 'busy';
/** Staff terminal setup (ADR-0018), opened after the staff code. */
export interface TerminalSetupView {
  /** The staff code was accepted and the setup is open. */
  open: boolean;
  /** register was sent: the terminal shows «Разрешить». */
  confirming: boolean;
  result: TerminalSetupResult | null;
  /** The terminal linked on this iPad, if any. */
  link: { terminalId: string; serial: string; host: string } | null;
  /** The cloud knows this same terminal for this kiosk. */
  cloudLinked: boolean;
  /** The cloud allows payments on the terminal (KIOSK_KASPI_TERMINAL_ENABLED). */
  enabled: boolean;
}
/** Why a staff code was not accepted (audit 19.10); shown under the code field. */
export type StaffPinError = 'wrong' | 'locked' | 'unavailable' | 'network';
/** Guest-facing error kinds; the screen shows them in the guest's language (i18n `err*`). */
export type KioskErrorCode =
  | 'PRICE_CHANGED'
  | 'CART_CHANGED'
  | 'NOT_ACCEPTING'
  | 'DEVICE'
  | 'KITCHEN_OFFLINE'
  | 'PHONE'
  | 'CART_LIMIT_LINE'
  | 'RETRY_PAYMENT'
  | 'PAYMENT_UNKNOWN'
  | 'MENU_LOAD'
  | 'NETWORK'
  | 'CONNECTION'
  | 'OFFLINE'
  /** The kiosk cannot start a new guest without staff (finding 3.1, neutral text). */
  | 'STAFF'
  /** ADR-0019: this point pays on the Kaspi terminal only, and none is linked on this iPad. */
  | 'TERMINAL';
export interface KioskState {
  commercial?: boolean;
  /**
   * Staff demo mode (owner decision 2026-10-11): an in-memory transport, no real orders or
   * payments; every screen shows the "ДЕМО" badge.
   */
  demo?: boolean;
  /** Kind of `error`, for the guest's language; `error` keeps the Russian fallback text. */
  errorCode?: KioskErrorCode | null;
  /** Availability is not fresh: every product shows unavailable until the edge answers. */
  menuUpdating?: boolean;
  /** The previous guest is cleared locally; ending its server session is still pending. */
  syncPending?: boolean;
  /** The cart line of the latest add (its serial grows with every add). */
  lastAdded?: { lineId: string; serial: number } | null;
  /** The cart line the product page is editing ("Изменить"): its choice and quantity. */
  editingLine?: {
    lineId: string;
    productId: string;
    selections: KioskSelection[];
    quantity: number;
  } | null;
  checkoutReady?: boolean;
  commercialPaymentMethods?: ('kaspi' | 'kaspi_invoice')[];
  qrPayment?: {
    kind: 'kaspi_qr';
    state: 'preparing' | 'pending' | 'checking' | 'paid' | 'failed';
    qrPayload: string | null;
    expiresAt: string | null;
  } | null;
  /** ADR-0018: the current payment runs on the kiosk's Kaspi terminal. */
  terminalPayment?: TerminalPaymentView | null;
  /** New payments use the kiosk's Kaspi terminal instead of the QR on screen. */
  terminalPaymentAvailable?: boolean;
  /** Staff terminal setup; absent where the kiosk cannot reach a terminal. */
  terminalSetup?: TerminalSetupView | null;
  invoicePhone?: string;
  phoneValid?: boolean;
  paymentPhase?: string;
  receiptState?: string;
  ready: boolean;
  busy: boolean;
  error: string | null;
  catalog: KioskCatalog | null;
  step: KioskStep;
  mode: KioskMode | null;
  cart: KioskCartLine[];
  unavailableCartLines: { lineId: string; productId: string; quantity: number }[];
  cartValid: boolean;
  cartTotalMinor: string;
  selectedProduct: KioskProduct | null;
  paymentMethod: KioskPaymentMethod;
  order: KioskOrderView | null;
  recoveryRequired: boolean;
  idleWarningSeconds: number | null;
  /**
   * Owner decision 2026-10-13: the Kaspi QR may offer «Начать заново» (the QR is not revoked;
   * the kiosk starts over for the next guest). True only while the commercial controller allows
   * it; absent in the simulator.
   */
  canStartOver?: boolean;
  /**
   * Audit 19.10, finding 3.3: the QR has been shown long enough to be scanned already (the server
   * cannot tell), so «Начать заново» needs a staff code.
   */
  startOverNeedsStaff?: boolean;
  /** A money-safe service reset of a stuck kiosk is available to staff (code required). */
  staffResetAvailable?: boolean;
  /** Staff actions of this build require the staff code (commercial kiosk). */
  staffPinRequired?: boolean;
  /** The last staff code check failed and why; null after a success or when closed. */
  staffPinError?: StaffPinError | null;
}
export interface KioskModel extends KioskState {
  start(): Promise<boolean>;
  setMode(mode: KioskMode): Promise<boolean>;
  goMode(): void;
  goMenu(): void;
  openProduct(productId: string): void;
  /** Leaves the product page for the step it was opened from (menu, upsell or cart). */
  closeProduct(): void;
  /** Opens the product page of a cart line with its choice; saving replaces the line. */
  editLine?(lineId: string): void;
  openUpsell(): void;
  openCart(): void;
  goLoyalty(): void;
  setInvoicePhone?(value: string): void;
  /** Commercial catalog texts in the guest's language (absent in the simulator). */
  setCatalogLocale?(locale: Locale): void;
  setPaymentMethod(method: KioskPaymentMethod): void;
  /** With `replaceLineId` the edited line is replaced by this choice and quantity. */
  addToCart(
    productId: string,
    selections: KioskSelection[],
    quantity?: number,
    replaceLineId?: string,
  ): Promise<boolean>;
  updateQuantity(lineId: string, quantity: number): Promise<boolean>;
  beginPayment(method?: KioskPaymentMethod): Promise<boolean>;
  pay(outcome: 'approved' | 'declined' | 'unknown'): Promise<boolean>;
  cancelOrder(): Promise<boolean>;
  /** Isolated demo capability only. Live QR cancellation is not supported by the bank bridge. */
  cancelPayment?(): Promise<boolean>;
  /**
   * «Начать заново» on the Kaspi QR (see `canStartOver`); nothing is cancelled or paid. With
   * `startOverNeedsStaff` the staff code is required.
   */
  startOver?(pin?: string): Promise<boolean>;
  /** Service reset of a stuck kiosk (see `staffResetAvailable`), after the staff code. */
  staffReset?(pin: string): Promise<boolean>;
  /** Terminal payment: send it again (not started) or start a new attempt (failed). */
  retryTerminal?(): Promise<boolean>;
  /** Terminal payment that failed or did not start: back to the cart to choose again. */
  leaveTerminal?(): Promise<boolean>;
  /** Staff terminal setup (ADR-0018), each behind the server-checked staff code. */
  openTerminalSetup?(pin: string): Promise<boolean>;
  closeTerminalSetup?(): void;
  linkTerminal?(host: string): Promise<boolean>;
  checkTerminal?(): Promise<boolean>;
  unlinkTerminal?(): Promise<boolean>;
  /** Clears the last staff code error (the dialog closed). */
  clearStaffError?(): void;
  /**
   * Staff-only kiosk health line (stage 2): the facts of this build once the server accepts the
   * staff code (commercial kiosk; the simulator has none), null when the code was refused.
   */
  staffHealth?(pin?: string): Promise<KioskHealthFacts | null>;
  recover(): Promise<boolean>;
  refresh(): Promise<boolean | void>;
  newGuest(): Promise<boolean>;
  touch(): void;
  stay(): void;
  /**
   * Turns the staff demo mode on (start screen only, after the staff code where
   * `staffPinRequired`) or off (no code); absent where it is unavailable.
   */
  setDemo?(on: boolean, pin?: string): Promise<boolean>;
}
