import { publishedProductData } from './published-catalog';
import { mediaForVersion } from './product-photo';
import type { CatalogMediaMap, CatalogMobileStorefront } from '@pickchick/catalog-admin/contracts';
import type { MenuSnapshot } from '@pickchick/contracts';
import type { Product, Locale } from './model';
import type { TestCatalog } from '@pickchick/test-order-flow/contracts';
import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';

export const DESIGN_RELEASE = 'mockup-v0.3';
// Format published menu copy for display without changing the source payload.
const displayCopy = (text: string) => text.replace(/[\u2013\u2014]/g, '-');
// Retouched source photographs, bundled locally for offline use. Provenance: assets/catalog-hd.
// Keys are the published `image_asset_key` values; also the bundled fallback for uploaded photos.
export const bundledCatalogImages: Record<string, number> = {
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
export const catalogLogo: number = require('../../../design/prototype/assets/mockup/logo.png');
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
        : (bundledCatalogImages[item.image_id] ?? catalogLogo),
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
    image: catalogLogo,
    source: 'server',
  }));
}

export function publishedProducts(
  catalog: CatalogMobileStorefront,
  locale: Locale,
  media?: CatalogMediaMap | null,
): Product[] {
  const uploaded = mediaForVersion(media, catalog.version);
  return publishedProductData(catalog, locale).map((item, index) => {
    const key = catalog.payload.products[index]!.image_asset_key;
    const entry = Object.prototype.hasOwnProperty.call(uploaded, item.id)
      ? uploaded[item.id]
      : undefined;
    return {
      ...item,
      imageKey: key,
      ...(entry ? { media: entry } : {}),
      image:
        item.id === 'piko' && key === 'generic-drink'
          ? require('../assets/catalog-options/piko.png')
          : (bundledCatalogImages[key] ?? catalogLogo),
    };
  });
}
