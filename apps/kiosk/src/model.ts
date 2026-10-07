import type { TestCompleteCatalog, TestSelection } from '@pickchick/test-order-flow/contracts';

export type KioskProduct = Omit<TestCompleteCatalog['products'][number], 'nutrition_provenance'> & {
  sku?: string;
  available?: boolean;
  nutrition_provenance: string;
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
export interface KioskState {
  commercial?: boolean;
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
  openUpsell(): void;
  openCart(): void;
  goLoyalty(): void;
  setInvoicePhone?(value: string): void;
  setPaymentMethod(method: KioskPaymentMethod): void;
  addToCart(productId: string, selections: KioskSelection[], quantity?: number): Promise<boolean>;
  updateQuantity(lineId: string, quantity: number): Promise<boolean>;
  beginPayment(method?: KioskPaymentMethod): Promise<boolean>;
  pay(outcome: 'approved' | 'declined' | 'unknown'): Promise<boolean>;
  cancelOrder(): Promise<boolean>;
  recover(): Promise<boolean>;
  refresh(): Promise<void>;
  newGuest(): Promise<boolean>;
  touch(): void;
  stay(): void;
}
