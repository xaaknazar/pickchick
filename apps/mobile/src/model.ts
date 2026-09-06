import type { ImageSourcePropType } from 'react-native';
import type { TestFlowModel } from './useTestOrders';

export type ScreenId = `M${string}`;
export type CatalogMode = 'server' | 'design';
export type DiningMode = 'takeaway' | 'dine_in';
export type Locale = 'ru' | 'kk';
export interface Product {
  id: string;
  name: string;
  description: string;
  category: string;
  priceMinor: string;
  image: ImageSourcePropType;
  source: CatalogMode;
}
export interface CartLine {
  product: Product;
  quantity: number;
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
  products: Product[];
  cart: CartLine[];
  catalogMode: CatalogMode;
  diningMode: DiningMode;
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
  addToCart(id: string): void;
  setQuantity(id: string, quantity: number): void;
  clearCart(expected?: { id: string; quantity: number }[]): void;
  refresh(): void;
  resetLocalData(): void;
}
export interface ScreenProps {
  screenId: ScreenId;
  model: MobileModel;
  navigate(id: ScreenId): void;
  goBack(): void;
  preview: boolean;
}
