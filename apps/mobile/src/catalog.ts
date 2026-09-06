import type { MenuSnapshot } from '@pickchick/contracts';
import type { Product, Locale } from './model';
import type { TestCatalog } from '@pickchick/test-order-flow/contracts';
import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';

export const DESIGN_RELEASE = 'mockup-v0.3';
// Literal asset paths let Metro bundle the supplied originals offline.
const images: Record<string, number> = {
  'i0.jpg': require('../../../design/prototype/assets/mockup/i0.jpg'),
  'i1.jpg': require('../../../design/prototype/assets/mockup/i1.jpg'),
  'i10.jpg': require('../../../design/prototype/assets/mockup/i10.jpg'),
  'i11.jpg': require('../../../design/prototype/assets/mockup/i11.jpg'),
  'i12.jpg': require('../../../design/prototype/assets/mockup/i12.jpg'),
  'i13.jpg': require('../../../design/prototype/assets/mockup/i13.jpg'),
  'i14.jpg': require('../../../design/prototype/assets/mockup/i14.jpg'),
  'i15.jpg': require('../../../design/prototype/assets/mockup/i15.jpg'),
  'i16.jpg': require('../../../design/prototype/assets/mockup/i16.jpg'),
  'i17.jpg': require('../../../design/prototype/assets/mockup/i17.jpg'),
  'i18.jpg': require('../../../design/prototype/assets/mockup/i18.jpg'),
  'i19.jpg': require('../../../design/prototype/assets/mockup/i19.jpg'),
  'i2.jpg': require('../../../design/prototype/assets/mockup/i2.jpg'),
  'i20.jpg': require('../../../design/prototype/assets/mockup/i20.jpg'),
  'i22.jpg': require('../../../design/prototype/assets/mockup/i22.jpg'),
  'i23.jpg': require('../../../design/prototype/assets/mockup/i23.jpg'),
  'i4.jpg': require('../../../design/prototype/assets/mockup/i4.jpg'),
  'i5.jpg': require('../../../design/prototype/assets/mockup/i5.jpg'),
  'i6.jpg': require('../../../design/prototype/assets/mockup/i6.jpg'),
  'i7.jpg': require('../../../design/prototype/assets/mockup/i7.jpg'),
  'i8.jpg': require('../../../design/prototype/assets/mockup/i8.jpg'),
  'i9.jpg': require('../../../design/prototype/assets/mockup/i9.jpg'),
};
export function connectedProducts(catalog: TestCatalog): Product[] {
  return catalog.products.map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
    category: item.category,
    priceMinor: item.price_minor,
    catalogVersion: catalog.catalog_version,
    image: images[item.image_id] ?? require('../../../design/prototype/assets/mockup/logo.png'),
    source: 'server',
    ...('modifier_groups' in item
      ? {
          servingLabel: item.serving_label,
          nutrition: item.nutrition,
          ingredients: item.ingredients,
          allergens: item.allergens,
          prepMinutes: item.prep_minutes,
          modifierGroups: item.modifier_groups,
        }
      : {}),
  }));
}
export const designProducts: Product[] = connectedProducts(testCompleteCatalog).map((product) => ({
  ...product,
  source: 'design',
}));
export function serverProducts(menu: MenuSnapshot | null, locale: Locale): Product[] {
  return (menu?.items ?? []).map((item) => ({
    id: item.variant_id,
    name: item.name[locale],
    priceMinor: item.price_minor,
    category: 'Меню',
    description: 'Позиция ресторана. Оформление пока недоступно.',
    image: require('../../../design/prototype/assets/mockup/logo.png'),
    source: 'server',
  }));
}
