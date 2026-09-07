import type {
  TestCompleteCatalog,
  TestOrder,
  TestSelection,
} from '@pickchick/test-order-flow/contracts';

export type KioskProduct = TestCompleteCatalog['products'][number];
export type KioskSelection = TestSelection;
export type KioskModifierGroup = KioskProduct['modifier_groups'][number];
export type KioskMode = 'takeaway' | 'dine_in';
export type KioskPaymentMethod = 'kaspi' | 'card';
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
export interface KioskState {
  ready: boolean;
  busy: boolean;
  error: string | null;
  catalog: TestCompleteCatalog | null;
  step: KioskStep;
  mode: KioskMode | null;
  cart: KioskCartLine[];
  unavailableCartLines: { lineId: string; productId: string; quantity: number }[];
  cartValid: boolean;
  cartTotalMinor: string;
  selectedProduct: KioskProduct | null;
  paymentMethod: KioskPaymentMethod;
  order: TestOrder | null;
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
