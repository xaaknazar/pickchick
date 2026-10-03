import { publishedProductData } from './published-catalog';
import type { CatalogMobileStorefront } from '@pickchick/catalog-admin/contracts';
import type { MenuSnapshot } from '@pickchick/contracts';
import type { Product, Locale } from './model';
import type { TestCatalog } from '@pickchick/test-order-flow/contracts';
import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';

export const DESIGN_RELEASE = 'mockup-v0.3';
// Format published menu copy for display without changing the source payload.
const displayCopy = (text: string) => text.replace(/[\u2013\u2014]/g, '-');
// Retouched source photographs, bundled locally for offline use. Provenance: assets/catalog-hd.
const images: Record<string, number> = {
  'i0.jpg': require('../assets/catalog-hd/lemonade.png'),
  'i1.jpg': require('../assets/catalog-cutouts/fuse-peach.png'),
  'i10.jpg': require('../assets/catalog-hd/solo-combo.png'),
  'i11.jpg': require('../assets/catalog-hd/finger-duo.png'),
  'i12.jpg': require('../assets/catalog-hd/burger-duo.png'),
  'i13.jpg': require('../assets/catalog-hd/mix-duo.png'),
  'i14.jpg': require('../assets/catalog-hd/fingers-25.png'),
  'i15.jpg': require('../assets/catalog-hd/fingers-50.png'),
  'i16.jpg': require('../assets/catalog-hd/fingers-75.png'),
  'i17.jpg': require('../assets/catalog-hd/fingers-100.png'),
  'i18.jpg': require('../assets/catalog-hd/sauce.png'),
  'i19.jpg': require('../assets/catalog-hd/sauce-hot.png'),
  'i2.jpg': require('../assets/catalog-hd/cola.png'),
  'i20.jpg': require('../assets/catalog-hd/wedges.png'),
  'i22.jpg': require('../assets/catalog-hd/iced-tea.png'),
  'i23.jpg': require('../assets/catalog-hd/water.png'),
  'shot.jpg': require('../assets/catalog-hd/burger.png'),
  'i4.jpg': require('../assets/catalog-cutouts/fingers.png'),
  'i5.jpg': require('../assets/catalog-hd/toast.png'),
  'i6.jpg': require('../assets/catalog-hd/coleslaw.png'),
  'i7.jpg': require('../assets/catalog-hd/pick-combo.png'),
  'i8.jpg': require('../assets/catalog-hd/master-combo.png'),
  'i9.jpg': require('../assets/catalog-hd/burger-combo.png'),
};
export function connectedProducts(catalog: TestCatalog): Product[] {
  return catalog.products.map((item) => ({
    id: item.id,
    name: item.name,
    description: displayCopy(item.description),
    category: item.category,
    priceMinor: item.price_minor,
    catalogVersion: catalog.catalog_version,
    image:
      item.id === 'piko'
        ? require('../assets/catalog-options/piko.png')
        : (images[item.image_id] ?? require('../../../design/prototype/assets/mockup/logo.png')),
    source: 'server',
    ...('modifier_groups' in item
      ? {
          servingLabel: item.serving_label,
          nutrition: item.nutrition,
          ingredients: displayCopy(item.ingredients),
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

export function publishedProducts(catalog: CatalogMobileStorefront, locale: Locale): Product[] {
  return publishedProductData(catalog, locale).map((item, index) => ({
    ...item,
    image:
      item.id === 'piko' && catalog.payload.products[index]!.image_asset_key === 'generic-drink'
        ? require('../assets/catalog-options/piko.png')
        : (images[catalog.payload.products[index]!.image_asset_key] ??
          require('../../../design/prototype/assets/mockup/logo.png')),
  }));
}
