import type { KioskProduct } from '../model';
export const categoryKeys = ['combo', 'duo', 'sets', 'extras'] as const;
export type Category = (typeof categoryKeys)[number];
export interface MenuMemory {
  cartQuantity?: number;
  category: Category;
  offsets: Partial<Record<Category, number>>;
}
export const inCategory = (product: KioskProduct, category: Category) =>
  category === 'combo'
    ? product.category === 'Комбо'
    : category === 'duo'
      ? product.category === 'На двоих'
      : category === 'sets'
        ? product.category === 'На компанию'
        : !['Комбо', 'На двоих', 'На компанию'].includes(product.category);
