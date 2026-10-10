import type { KioskProduct } from '../model';
export const categoryKeys = ['combo', 'duo', 'sets', 'extras'] as const;
export type Category = (typeof categoryKeys)[number];
export interface MenuMemory {
  cartQuantity?: number;
  /** Cart total (minor units) the menu last showed, so the bar counts up from it. */
  cartTotal?: string;
  category: Category;
  offsets: Partial<Record<Category, number>>;
  /** Serial of the last add the menu announced (toast and flight into the bag). */
  addSerial?: number;
  /** Billboard slide last shown (0 featured, 1 promo), kept across category changes. */
  billboard?: 0 | 1;
}
export const inCategory = (product: KioskProduct, category: Category) =>
  category === 'combo'
    ? product.category === 'Комбо'
    : category === 'duo'
      ? product.category === 'На двоих'
      : category === 'sets'
        ? product.category === 'На компанию'
        : !['Комбо', 'На двоих', 'На компанию'].includes(product.category);
