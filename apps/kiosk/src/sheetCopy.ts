import { copy, type Locale } from './i18n.ts';
/**
 * Strings of the simple-product sheet over the menu (kiosk redesign 2026-10-13,
 * product-and-payment.md §3). Wording the shared `i18n.ts` table already carries (to cart,
 * close, the KBJU words and units, the cart limits, the quantity buttons) is taken from it, so
 * there is one source per string; only the sheet's own words live here. Plain hyphens only (owner
 * rule). An unknown locale falls back to Russian.
 */
const table = {
  ru: {
    /** Title over the size tiles. */
    size: 'Размер',
    /** The add button of a product stopped while the sheet is open. */
    unavailable: 'Нет в наличии',
    /** Spoken name of the sheet. */
    sheet: 'Карточка товара',
    /** «КБЖУ» opens the protein, fat and carbs line; this hides it again. */
    hideNutrition: 'Скрыть КБЖУ',
    /** «230 ккал на 100 г» when the catalog gives nutrition per 100 g. */
    per100g: 'на 100 г',
  },
  kk: {
    size: 'Өлшемі',
    unavailable: 'Қазір жоқ',
    sheet: 'Тағам картасы',
    hideNutrition: 'КБЖУ жасыру',
    per100g: '100 г үшін',
  },
  en: {
    size: 'Size',
    unavailable: 'Not available',
    sheet: 'Product card',
    hideNutrition: 'Hide nutrition',
    per100g: 'per 100 g',
  },
} as const;
type Own = (typeof table)['ru'] | (typeof table)['kk'] | (typeof table)['en'];
export type SheetCopy = Own & {
  toCart: string;
  close: string;
  nutrition: string;
  kcal: string;
  protein: string;
  fat: string;
  carbs: string;
  grams: string;
  limitLine: string;
  decrease: string;
  increase: string;
};
export const sheetCopy = (locale: string): SheetCopy => {
  const known: Locale = locale === 'kk' || locale === 'en' ? locale : 'ru';
  const t = copy(known);
  return {
    ...table[known],
    toCart: t.toCart,
    close: t.close,
    nutrition: t.nutrition,
    kcal: t.kcal,
    protein: t.protein,
    fat: t.fat,
    carbs: t.carbs,
    grams: t.grams,
    limitLine: t.limitLine,
    decrease: t.decrease,
    increase: t.increase,
  };
};
/** The sheet's own strings in every locale, for the copy checks. */
export const sheetTableForTest = table;
