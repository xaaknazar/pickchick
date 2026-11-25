import { catalogCutouts } from './catalog-cutouts';
import { ownerDrinkPhotos } from './drink-photos';
import type { ImageSourcePropType } from 'react-native';
// Owner 25.11.2026: the dish page is warm white, so the 11 combos and sets are transparent
// cut-outs (assets/hero-cutout/README.md), not the photographs on blue.
export const photoHeroes: Record<string, ImageSourcePropType> = {
  'pick-combo': require('../assets/hero-cutout/pick-combo.webp'),
  'master-combo': require('../assets/hero-cutout/master-combo.webp'),
  'burger-combo': require('../assets/hero-cutout/burger-combo.webp'),
  'solo-combo': require('../assets/hero-cutout/solo-combo.webp'),
  'finger-duo': require('../assets/hero-cutout/finger-duo.webp'),
  'burger-duo': require('../assets/hero-cutout/burger-duo.webp'),
  'mix-duo': require('../assets/hero-cutout/mix-duo.webp'),
  'fingers-25': require('../assets/hero-cutout/fingers-25.webp'),
  'fingers-50': require('../assets/hero-cutout/fingers-50.webp'),
  'fingers-75': require('../assets/hero-cutout/fingers-75.webp'),
  'fingers-100': require('../assets/hero-cutout/fingers-100.webp'),
  fingers: catalogCutouts['fingers']!,
  sauce: require('../assets/catalog-hd/sauce.png'),
  'sauce-hot': require('../assets/catalog-hd/sauce-hot.png'),
  toast: require('../assets/catalog-hd/toast.png'),
  coleslaw: require('../assets/catalog-hd/coleslaw.png'),
  wedges: require('../assets/catalog-hd/wedges.png'),
  burger: require('../assets/catalog-hd/burger.png'),
  lemonade: require('../assets/catalog-hd/lemonade.png'),
  // The can SKU keeps its own photo; the owner's bottle photo is never used for it.
  cola: require('../assets/catalog-hd/cola.png'),
  piko: ownerDrinkPhotos['piko']!,
  'fuse-peach': ownerDrinkPhotos['fuse-peach']!,
  'iced-tea': require('../assets/catalog-hd/iced-tea.png'),
  water: ownerDrinkPhotos['water']!,
};
// No invented packaging: missing catalog references keep an explicit placeholder.
export const optionPhotos: Record<string, ImageSourcePropType> = {
  // The owner's real photographs: fuse-peach/-mango, water, cola-bottle/-zero, sprite, fanta, piko.
  ...ownerDrinkPhotos,
  // No owner photo yet: these keep their earlier images.
  'fuse-berry': catalogCutouts['fuse-berry']!,
  'fuse-watermelon': catalogCutouts['fuse-watermelon']!,
  lemonade: require('../assets/catalog-hd/lemonade.png'),
  'cola-can': require('../assets/catalog-hd/cola.png'),
  'iced-tea-sweet': require('../assets/catalog-hd/iced-tea.png'),
  'iced-tea-unsweet': require('../assets/catalog-hd/iced-tea.png'),
  pick: require('../assets/catalog-hd/signature-small.png'),
  hot: require('../assets/catalog-hd/sauce-hot.png'),
  // Review 29.10.2026: the Heinz cheese / barbecue dips showed «Без фото» (App Review 2.1). The
  // clear dip cup of signature-small with the sauce recoloured, no Heinz packaging drawn
  // (assets/catalog-hd/README.md); the owner's photographs replace them when they exist.
  cheese: require('../assets/catalog-hd/sauce-cheese.png'),
  bbq: require('../assets/catalog-hd/sauce-bbq.png'),
  // Catalog 22.11 option ids (the v11 ids pick/hot/cheese above stay for old carts).
  sauce: require('../assets/catalog-hd/signature-small.png'),
  'sauce-hot': require('../assets/catalog-hd/sauce-hot.png'),
  'sauce-cheese': require('../assets/catalog-hd/sauce-cheese.png'),
  // The same clear dip cup as the other sauces (kiosk asset, warm square like sauce-bbq).
  ketchup: require('../assets/catalog-hd/ketchup.png'),
  // Drinks offered as paid add-ons on the finger sets (group drink-extra).
  cola: require('../assets/catalog-hd/cola.png'),
  'iced-tea': require('../assets/catalog-hd/iced-tea.png'),
};
export const extraPhotos: Record<string, ImageSourcePropType> = {
  fingers: catalogCutouts['fingers']!,
  sauce: require('../assets/catalog-hd/signature-small.png'),
  'sauce-hot': require('../assets/catalog-hd/sauce-hot.png'),
  'sauce-cheese': require('../assets/catalog-hd/sauce-cheese.png'),
  'sauce-bbq': require('../assets/catalog-hd/sauce-bbq.png'),
  toast: require('../assets/catalog-hd/toast.png'),
  coleslaw: require('../assets/catalog-hd/coleslaw.png'),
  wedges: require('../assets/catalog-hd/wedges.png'),
};

/** Bundled heroes that are transparent cut-outs: they stand on the page's own paper. */
export const heroCutoutIds: ReadonlySet<string> = new Set([
  'pick-combo',
  'master-combo',
  'burger-combo',
  'solo-combo',
  'finger-duo',
  'burger-duo',
  'mix-duo',
  'fingers-25',
  'fingers-50',
  'fingers-75',
  'fingers-100',
]);
