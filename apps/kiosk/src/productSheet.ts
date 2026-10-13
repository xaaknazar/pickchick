/**
 * Simple products open as a sheet over the menu (kiosk redesign 2026-10-13,
 * docs/design/kiosk-redesign-2026-10-13/product-and-payment.md §3). Pure rules; the menu and
 * `components/ProductSheet` only draw them.
 *
 * A product is "simple" when it is a single item (the «Допы» and «Напитки» tiles; sauces and any
 * other catalog category fall into «Допы») and it either has no modifier group at all, or exactly
 * one group that is a required single size/volume choice of at most four options (the sheet's
 * row of four tiles). Combos, duos and company sets, a product with any other choice (a flavour,
 * optional add-ons, a size with more than four options) keep the product page, so no choice is
 * ever hidden from the guest.
 *
 * Adding from the sheet uses exactly the product page's model call: `addToCart(productId,
 * selections, quantity)`, with the selections of a single-choice group as the page builds them
 * (`{ group_id, option_id, quantity: 1 }`) and the quantity capped by the cart's room for that
 * very line (20 of one line, 11 different lines).
 */
import { LINE_LIMIT, LINES_LIMIT, testLineId } from './cart.ts';
import { isSingleItem } from './components/categories.ts';
import type { KioskModifierGroup, KioskProduct, KioskSelection } from './model';

/** The sheet shows one row of four size tiles at most. */
export const SHEET_SIZES = 4;
type Option = KioskModifierGroup['options'][number];

const SIZE_WORD = /size|volume|размер|объ[её]м|өлшем|көлем/i;
/** «60 мл», «0,3 л», «0.5 L», «250 г»: a bare measure. */
const MEASURE = /^\s*\d+(?:[.,]\d+)?\s*(?:мл|л|г|кг|ml|l|cl|g|kg|oz)\.?\s*$/i;

/**
 * A required single choice that is a size or volume: its id or title says so, or every option
 * is a bare measure. At most four options (one row of tiles).
 */
export function isSizeGroup(group: KioskModifierGroup): boolean {
  if (group.min !== 1 || group.max !== 1) return false;
  if (!group.options.length || group.options.length > SHEET_SIZES) return false;
  return (
    SIZE_WORD.test(group.id) ||
    SIZE_WORD.test(group.title) ||
    group.options.every((option) => MEASURE.test(option.label))
  );
}

/** The size group the sheet offers, or null for a product without any choice. */
export function sheetSizeGroup(product: KioskProduct): KioskModifierGroup | null {
  const [group] = product.modifier_groups;
  return product.modifier_groups.length === 1 && group && isSizeGroup(group) ? group : null;
}

/** True when the product opens as the sheet over the menu instead of the product page. */
export function opensInSheet(product: KioskProduct): boolean {
  if (!isSingleItem(product)) return false;
  return !product.modifier_groups.length || sheetSizeGroup(product) !== null;
}

/**
 * The size chosen when the sheet opens or when the chosen one is stopped: the catalog's default
 * if it is available, else the first available size; null when there is no size to choose.
 */
export function initialSize(group: KioskModifierGroup | null): string | null {
  if (!group) return null;
  const available = group.options.filter((option) => option.available);
  return (available.find((option) => option.default_quantity > 0) ?? available[0])?.id ?? null;
}

/** The product page's selections for this choice: none, or one unit of the chosen size. */
export function sheetSelections(product: KioskProduct, sizeId: string | null): KioskSelection[] {
  const group = sheetSizeGroup(product);
  return group && sizeId ? [{ group_id: group.id, option_id: sizeId, quantity: 1 }] : [];
}

/** One unit's price (minor units) with the size's surcharge. */
export function sheetUnitMinor(product: KioskProduct, sizeId: string | null): string {
  const option = sheetSizeGroup(product)?.options.find((o) => o.id === sizeId);
  return (BigInt(product.price_minor) + BigInt(option?.price_delta_minor ?? '0')).toString();
}

/**
 * How many more of this exact line the cart takes, as on the product page: what the cart already
 * holds of the line counts, and a new line needs a free one of the 11. `limit` names the rule
 * that leaves no room.
 */
export function sheetRoom(
  lineId: string,
  cart: readonly { lineId: string; quantity: number }[],
  lineCount: number,
): { room: number; limit: 'line' | 'lines' | null } {
  const inCart = cart.find((line) => line.lineId === lineId)?.quantity ?? 0;
  if (!inCart && lineCount >= LINES_LIMIT) return { room: 0, limit: 'lines' };
  const room = Math.max(0, LINE_LIMIT - inCart);
  return { room, limit: room ? null : 'line' };
}

/** The cart line id the sheet's choice becomes (the controller sorts selections the same way). */
export const sheetLineId = (product: KioskProduct, sizeId: string | null) =>
  testLineId(product.id, sheetSelections(product, sizeId));

export interface SheetFacts {
  /** «60 г» (the catalog's serving), or the chosen size's label; null when unknown. */
  serving: string | null;
  /** Energy for the shown portion; null when it cannot be told for the chosen size. */
  kcal: number | null;
  /** The catalog gives energy per 100 g rather than per portion. */
  per100g: boolean;
  /** Protein, fat and carbs (grams) for the same basis; null with `kcal`. */
  macros: { protein: number; fat: number; carbs: number } | null;
}

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * The line under the description («60 г · 230 ккал · КБЖУ»), from catalog data only. The
 * catalog's serving and nutrition describe the default size; another size shows its own label,
 * and its energy only when the catalog gives that size's `nutrition_multiplier` (a per-100-g
 * basis needs none). Missing parts are omitted, never guessed.
 */
export function sheetFacts(product: KioskProduct, sizeId: string | null): SheetFacts {
  const option: Option | undefined = sheetSizeGroup(product)?.options.find((o) => o.id === sizeId);
  const base = !option || option.default_quantity > 0;
  const serving = base
    ? product.serving_label && product.serving_label.trim() !== '-'
      ? product.serving_label.trim()
      : null
    : option.label;
  const n = product.nutrition as KioskProduct['nutrition'] | null | undefined;
  if (!n || !Number.isFinite(n.energy_kcal))
    return { serving, kcal: null, per100g: false, macros: null };
  const per100g = n.basis === 'per_100_g';
  const factor = per100g || base ? 1 : option.nutrition_multiplier;
  if (factor === undefined) return { serving, kcal: null, per100g, macros: null };
  return {
    serving,
    kcal: Math.round(n.energy_kcal * factor),
    per100g,
    macros: {
      protein: round(n.protein_g * factor),
      fat: round(n.fat_g * factor),
      carbs: round(n.carbs_g * factor),
    },
  };
}
