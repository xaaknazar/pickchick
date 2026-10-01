import type { ImageSourcePropType } from 'react-native';
import type { TestFlowModel } from './useTestOrders';

export type ScreenId = `M${string}`;
export type CatalogMode = 'server' | 'design';
export type DiningMode = 'takeaway' | 'dine_in';
export type Locale = 'ru' | 'kk';
export interface Selection {
  group_id: string;
  option_id: string;
  quantity: number;
}
export interface ModifierGroup {
  id: string;
  title: string;
  min: number;
  max: number;
  options: {
    id: string;
    label: string;
    price_delta_minor: string;
    default_selected?: boolean;
    available?: boolean;
    default_quantity?: number;
    max_quantity?: number;
    nutrition_multiplier?: number;
  }[];
}
export type PaymentMethod = 'kaspi' | 'card';
export interface Product {
  available?: boolean;
  id: string;
  name: string;
  description: string;
  category: string;
  priceMinor: string;
  image: ImageSourcePropType;
  source: CatalogMode;
  catalogVersion?: 'mockup-v0.2' | 'mockup-v0.3';
  servingLabel?: string;
  nutrition?: {
    basis: 'per_100_g' | 'per_serving';
    energy_kcal: number;
    protein_g: number;
    fat_g: number;
    carbs_g: number;
  };
  ingredients?: string;
  allergens?: string[];
  prepMinutes?: number;
  modifierGroups?: ModifierGroup[];
}
export interface CartLine {
  product: Product;
  quantity: number;
  selections?: Selection[];
}
export interface Branch {
  id: string;
  name: string;
  ordering_enabled: boolean;
}
export interface Connection {
  status: 'loading' | 'online' | 'offline' | 'error';
  checkedAt: string | null;
  message: string | null;
}
export interface MobileModel {
  availabilityFresh?: boolean;
  products: Product[];
  cart: CartLine[];
  catalogMode: CatalogMode;
  diningMode: DiningMode;
  paymentMethod: PaymentMethod;
  upsellProductIds: string[];
  locale: Locale;
  branches: Branch[];
  branch: Branch | null;
  connection: Connection;
  selectedProduct: Product | null;
  nickname: string;
  testFlow: TestFlowModel;
  practiceScore: number | null;
  setPracticeScore(value: number | null): void;
  setNickname(value: string): void;
  setLocale(value: Locale): void;
  setDiningMode(value: DiningMode): void;
  setBranch(id: string): void;
  setCatalogMode(mode: CatalogMode): void;
  selectProduct(id: string): void;
  addToCart(id: string, selections?: Selection[], quantity?: number): void;
  appendCartLines(lines: CartLine[]): boolean;
  setPaymentMethod(method: PaymentMethod): void;
  setQuantity(id: string, quantity: number): void;
  replaceCartLine(original: CartLine, selections: Selection[], quantity: number): void;
  clearCart(expected?: { id: string; quantity: number }[]): void;
  refresh(): void;
  resetLocalData(): void;
}
export interface ScreenProps {
  screenId: ScreenId;
  model: MobileModel;
  navigate(id: ScreenId): void;
  goBack(): void;
  inTabLayout?: boolean;
  inSheet?: boolean;
  cartBottomInset?: number;
  preview: boolean;
}
