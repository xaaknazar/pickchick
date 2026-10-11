import type { KioskProduct } from '../model';
/** Design v3 rail (03-menu.png, SPEC.md): five tiles, extras and drinks separate. */
export const categoryKeys = ['combo', 'duo', 'sets', 'extras', 'drinks'] as const;
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
/** Russian catalog category names (the classifier key) of the fixed rail tiles. */
const named: Partial<Record<Category, string>> = {
  combo: 'Комбо',
  duo: 'На двоих',
  sets: 'На компанию',
  drinks: 'Напитки',
};
const namedValues = Object.values(named);
/** Products of a tile; any other catalog category falls into extras, so nothing is hidden. */
export const inCategory = (product: KioskProduct, category: Category) =>
  category === 'extras'
    ? !namedValues.includes(product.category)
    : product.category === named[category];
/** Single items (extras and drinks) rather than meal sets. */
export const isSingleItem = (product: KioskProduct) =>
  inCategory(product, 'extras') || inCategory(product, 'drinks');
