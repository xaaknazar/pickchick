import type { Locale } from './i18n';
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
/** Guest-facing error kinds; the screen shows them in the guest's language (i18n `err*`). */
export type KioskErrorCode =
  | 'PRICE_CHANGED'
  | 'CART_CHANGED'
  | 'NOT_ACCEPTING'
  | 'DEVICE'
  | 'PHONE'
  | 'CART_LIMIT_LINE'
  | 'CART_LIMIT_LINES'
  | 'RETRY_PAYMENT'
  | 'PAYMENT_UNKNOWN'
  | 'MENU_LOAD'
  | 'NETWORK'
  | 'CONNECTION'
  | 'OFFLINE';
export interface KioskState {
  commercial?: boolean;
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
  recover(): Promise<boolean>;
  refresh(): Promise<boolean | void>;
  newGuest(): Promise<boolean>;
  touch(): void;
  stay(): void;
}
