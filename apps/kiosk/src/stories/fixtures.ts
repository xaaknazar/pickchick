import { testCompleteCatalog } from '../../../../packages/test-order-flow/src/complete-catalog';
import { defaultSelections, selectedPriceMinor } from '../cart';
import type { KioskCartLine } from '../model';
export const catalog = testCompleteCatalog;
export const product = catalog.products.find((p) => p.id === 'pick-combo')!;
export const selections = defaultSelections(product);
export const line: KioskCartLine = {
  lineId: 'story-line',
  productId: product.id,
  quantity: 1,
  selections,
  product,
  unitPriceMinor: selectedPriceMinor(product, selections),
  lineTotalMinor: selectedPriceMinor(product, selections),
};
export const group = product.modifier_groups[0]!;
export const memory = { category: 'combo' as const, offsets: {} };
export const receipt = 'Тестовый пример. Деньги не списываются.';
