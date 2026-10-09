// Literal paths bundle the customer's supplied artwork for offline presentation.
// v3 kiosk photography (white studio shots, cut-outs, blue combo heroes) is keyed by catalog image_id.
import { Image } from 'expo-image';
import { colors } from './theme';
import { KIOSK_API_URL } from './api';
import { CatalogMediaRegistry, type Photo } from './photo-source';
import type { KioskCatalog, KioskMedia } from './model';
export type { Photo } from './photo-source';
export const assets = {
  logo: require('../assets/v3/logo.webp'),
  logoTile: require('../../../design/prototype/assets/mockup/logo.png'),
  hero: require('../../../design/prototype/assets/mockup/hero.mp4'),
  poster: require('../../../design/prototype/assets/mockup/hero-poster.jpg'),
  billboard: require('../assets/v3/billboard-master.webp'),
  billboardPromo: require('../assets/v3/billboard-7plus1.webp'),
  chefTray: require('../../mobile/assets/order-status/chef-ready.png'),
  chefBag: require('../../mobile/assets/order-status/chef-ready-takeaway.png'),
  chefCooking: require('../../mobile/assets/order-status/chef-cooking.png'),
  chefAssembly: require('../../mobile/assets/order-status/chef-assembly.png'),
};
const photo = (source: number, tile: string | null): Photo => ({
  source,
  tile: tile ?? '#FEF8F0',
  cutout: tile === null,
});
const cards: Record<string, Photo> = {
  'i7.jpg': photo(require('../assets/v3/photos/pick-combo.webp'), '#FFFFFF'),
  'i8.jpg': photo(require('../assets/v3/photos/master-combo.webp'), '#FFFFFF'),
  'i9.jpg': photo(require('../assets/v3/photos/burger-combo.webp'), '#FFFFFF'),
  'i10.jpg': photo(require('../assets/v3/photos/solo-combo.webp'), '#FEFEFE'),
  'i11.jpg': photo(require('../assets/v3/photos/finger-duo.webp'), '#FFFFFF'),
  'i12.jpg': photo(require('../assets/v3/photos/burger-duo.webp'), '#FFFFFF'),
  'i13.jpg': photo(require('../assets/v3/photos/mix-duo.webp'), '#FEFEFE'),
  'i14.jpg': photo(require('../assets/v3/photos/fingers-25.webp'), '#FFFFFF'),
  'i15.jpg': photo(require('../assets/v3/photos/fingers-50.webp'), '#FEFEFE'),
  'i16.jpg': photo(require('../assets/v3/photos/fingers-75.webp'), '#FEFEFD'),
  'i17.jpg': photo(require('../assets/v3/photos/fingers-100.webp'), '#FFFFFF'),
  'i4.jpg': photo(require('../assets/v3/photos/fingers.webp'), null),
  'i18.jpg': photo(require('../assets/v3/photos/sauce.webp'), '#FEFEFE'),
  'i19.jpg': photo(require('../assets/v3/photos/sauce-hot.webp'), '#FEFEFE'),
  'i5.jpg': photo(require('../assets/v3/photos/toast.webp'), '#FFFFFF'),
  'i6.jpg': photo(require('../assets/v3/photos/coleslaw.webp'), '#FFFFFF'),
  'i20.jpg': photo(require('../assets/v3/photos/wedges.webp'), '#FFFFFF'),
  'shot.jpg': photo(require('../assets/v3/photos/burger.webp'), '#FEFEFE'),
  'i0.jpg': photo(require('../assets/v3/photos/lemonade.webp'), '#FFFFFF'),
  'i2.jpg': photo(require('../assets/v3/photos/cola.webp'), '#FFFFFF'),
  'i1.jpg': photo(require('../assets/v3/photos/fuse-peach.webp'), '#FFFFFF'),
  'i22.jpg': photo(require('../assets/v3/photos/iced-tea.webp'), '#FFFFFF'),
  'i23.jpg': photo(require('../assets/v3/photos/water.webp'), '#FFFFFF'),
  'generic-drink': photo(require('../assets/v3/photos/piko.webp'), '#FEF8F0'),
};
const heroes: Record<string, Photo> = {
  'i7.jpg': photo(require('../assets/v3/hero/pick-combo.webp'), '#024ECA'),
  'i8.jpg': photo(require('../assets/v3/hero/master-combo.jpg'), '#0050CC'),
  'i9.jpg': photo(require('../assets/v3/hero/burger-combo.webp'), '#0054D6'),
  'i10.jpg': photo(require('../assets/v3/hero/solo-combo.jpg'), '#0256D4'),
  'i11.jpg': photo(require('../assets/v3/hero/finger-duo.jpg'), '#004DC8'),
  'i12.jpg': photo(require('../assets/v3/hero/burger-duo.jpg'), '#004FCC'),
  'i13.jpg': photo(require('../assets/v3/hero/mix-duo.jpg'), '#0051D4'),
  'i14.jpg': photo(require('../assets/v3/hero/fingers-25.jpg'), '#0052D2'),
  'i15.jpg': photo(require('../assets/v3/hero/fingers-50.jpg'), '#0050CB'),
  'i16.jpg': photo(require('../assets/v3/hero/fingers-75.jpg'), '#015AD2'),
  'i17.jpg': photo(require('../assets/v3/hero/fingers-100.jpg'), '#0051C8'),
  'i18.jpg': photo(require('../assets/v3/hero/sauce.webp'), null),
  'i19.jpg': photo(require('../assets/v3/hero/sauce-hot.webp'), null),
  'i5.jpg': photo(require('../assets/v3/hero/toast.webp'), '#FEF8F1'),
  'i6.jpg': photo(require('../assets/v3/hero/coleslaw.webp'), '#FEF9F2'),
  'i20.jpg': photo(require('../assets/v3/hero/wedges.webp'), '#FEF9EF'),
  'i0.jpg': photo(require('../assets/v3/hero/lemonade.webp'), '#FEFAF6'),
  'i2.jpg': photo(require('../assets/v3/hero/cola.webp'), '#FEFAF4'),
  'i1.jpg': photo(require('../assets/v3/hero/fuse-peach.webp'), '#FEF8F1'),
  'i22.jpg': photo(require('../assets/v3/hero/iced-tea.webp'), '#FEFAF1'),
  'i23.jpg': photo(require('../assets/v3/hero/water.webp'), '#FEFCF5'),
};
const options: Record<string, Photo> = {
  'cola-bottle': photo(require('../assets/v3/options/cola-bottle.webp'), null),
  lemonade: photo(require('../assets/v3/options/lemonade.webp'), '#FEFAF6'),
  'fuse-peach': photo(require('../assets/v3/options/fuse-peach.webp'), null),
  'cola-can': photo(require('../assets/v3/options/cola-can.webp'), '#FEFAF4'),
  fanta: photo(require('../assets/v3/options/fanta.webp'), null),
  sprite: photo(require('../assets/v3/options/sprite.webp'), null),
  'cola-zero': photo(require('../assets/v3/options/cola-zero.webp'), null),
  'iced-tea-sweet': photo(require('../assets/v3/options/iced-tea.webp'), '#FEFAF1'),
  'iced-tea-unsweet': photo(require('../assets/v3/options/iced-tea.webp'), '#FEFAF1'),
  'fuse-berry': photo(require('../assets/v3/options/fuse-berry.webp'), null),
  'fuse-watermelon': photo(require('../assets/v3/options/fuse-watermelon.webp'), null),
  'fuse-mango': photo(require('../assets/v3/options/fuse-mango.webp'), null),
  water: photo(require('../assets/v3/options/water.webp'), '#FEFCF5'),
  piko: photo(require('../assets/v3/options/piko.webp'), '#FEF8F0'),
  pick: photo(require('../assets/v3/options/sauce-pick.webp'), null),
  hot: photo(require('../assets/v3/options/sauce-hot.webp'), null),
  fingers: photo(require('../assets/v3/options/fingers.webp'), null),
  sauce: photo(require('../assets/v3/options/sauce-pick.webp'), null),
  'sauce-hot': photo(require('../assets/v3/options/sauce-hot.webp'), null),
  toast: photo(require('../assets/v3/options/toast.webp'), '#FEF8F1'),
  coleslaw: photo(require('../assets/v3/options/coleslaw.webp'), '#FEF9F2'),
  wedges: photo(require('../assets/v3/options/wedges.webp'), '#FEF9EF'),
};
// Preserve the owner's exact cropped photographs from the shared development branch.
const drinkPhotos: Record<string, Photo> = {
  'fuse-peach': photo(require('../assets/drinks/fuse-peach.png'), null),
  'fuse-mango': photo(require('../assets/drinks/fuse-mango-chamomile.png'), null),
  water: photo(require('../assets/drinks/bonaqua-still.png'), null),
  'cola-bottle': photo(require('../assets/drinks/cola-classic.png'), null),
  'cola-zero': photo(require('../assets/drinks/cola-zero.png'), null),
  sprite: photo(require('../assets/drinks/sprite.png'), null),
  fanta: photo(require('../assets/drinks/fanta.png'), null),
  'piko-apple': photo(require('../assets/drinks/piko-apple.png'), null),
  'piko-orange': photo(require('../assets/drinks/piko-orange.png'), null),
};
drinkPhotos.piko = {
  ...drinkPhotos['piko-apple']!,
  secondarySource: drinkPhotos['piko-orange']!.source,
};
Object.assign(cards, {
  'i1.jpg': drinkPhotos['fuse-peach'],
  'i23.jpg': drinkPhotos.water,
  'generic-drink': drinkPhotos.piko,
});
Object.assign(heroes, {
  'i1.jpg': drinkPhotos['fuse-peach'],
  'i23.jpg': drinkPhotos.water,
  'generic-drink': drinkPhotos.piko,
});
Object.assign(options, drinkPhotos);
const suppliedDrink = (imageId: string) =>
  imageId.startsWith('drink:') ? drinkPhotos[imageId.slice(6)] : undefined;
const bundledCard = (imageId: string): Photo | null =>
  suppliedDrink(imageId) ?? cards[imageId] ?? null;
const bundledHero = (imageId: string): Photo | null =>
  suppliedDrink(imageId) ?? heroes[imageId] ?? cards[imageId] ?? null;
/** Card photo for menu tiles: published media first; falls back to the original mockup shot. */
export const productPhoto = (imageId: string): Photo | null => media.photo(imageId, 'card');
/** Large product-page photo: blue studio shot for combos, warm shot for singles. */
export const heroPhoto = (imageId: string): Photo | null => media.photo(imageId, 'hero');
/** Modifier option artwork by option id (drinks, sauces, extras). */
export const optionPhoto = (optionId: string): Photo | null => options[optionId] ?? null;
/** Heinz sauces have no supplied photography; they keep a neutral colour mark. */
export const heinzColor = (optionId: string): string | null =>
  /cheese/.test(optionId) ? '#E7A51A' : /bbq/.test(optionId) ? '#7A2E12' : null;
/** Word-mark colour that keeps WCAG AA on its Heinz mark (navy on the light mustard). */
export const heinzInk = (optionId: string): string =>
  /cheese/.test(optionId) ? colors.navy : colors.white;
const products: Record<string, number> = {
  'shot.jpg': require('../../../design/prototype/assets/mockup/shot.jpg'),
  'i0.jpg': require('../../../design/prototype/assets/mockup/i0.jpg'),
  'i1.jpg': require('../assets/drinks/fuse-peach.png'),
  'i2.jpg': require('../../../design/prototype/assets/mockup/i2.jpg'),
  'i4.jpg': require('../../../design/prototype/assets/mockup/i4.jpg'),
  'i5.jpg': require('../../../design/prototype/assets/mockup/i5.jpg'),
  'i6.jpg': require('../../../design/prototype/assets/mockup/i6.jpg'),
  'i7.jpg': require('../../../design/prototype/assets/mockup/i7.jpg'),
  'i8.jpg': require('../../../design/prototype/assets/mockup/i8.jpg'),
  'i9.jpg': require('../../../design/prototype/assets/mockup/i9.jpg'),
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
  'i20.jpg': require('../../../design/prototype/assets/mockup/i20.jpg'),
  'i22.jpg': require('../../../design/prototype/assets/mockup/i22.jpg'),
  'i23.jpg': require('../assets/drinks/bonaqua-still.png'),
  'drink:fuse-peach': require('../assets/drinks/fuse-peach.png'),
  'drink:fuse-mango': require('../assets/drinks/fuse-mango-chamomile.png'),
  'drink:water': require('../assets/drinks/bonaqua-still.png'),
  'drink:cola-bottle': require('../assets/drinks/cola-classic.png'),
  'drink:cola-zero': require('../assets/drinks/cola-zero.png'),
  'drink:sprite': require('../assets/drinks/sprite.png'),
  'drink:fanta': require('../assets/drinks/fanta.png'),
  'drink:piko-apple': require('../assets/drinks/piko-apple.png'),
  'drink:piko-orange': require('../assets/drinks/piko-orange.png'),
};
export const productImage = (id: string): number => products[id] ?? assets.logo;
const media = new CatalogMediaRegistry(KIOSK_API_URL, {
  card: bundledCard,
  hero: bundledHero,
  product: (id) => products[id],
  logo: assets.logo,
});
/** Fallback chain for one photo: remote media, bundled v3 photo, mockup shot, logo. */
export const photoCandidates = (imageId: string, variant: 'card' | 'hero') =>
  media.candidates(imageId, variant);
/** Registers the loaded publication's photos; returns the remote URLs to keep on disk. */
export const rememberCatalogMedia = (catalog: KioskCatalog | null): string[] =>
  catalog ? media.sync(catalog.products) : [];
/** Downloads every published photo to the expo-image disk cache so the kiosk stays offline-safe. */
export async function prefetchCatalogMedia(urls: readonly string[]): Promise<boolean> {
  const results = await Promise.all(
    urls.map(async (url) => ((await Image.prefetch(url, 'disk').catch(() => false)) ? url : null)),
  );
  const ready = results.filter((url): url is string => !!url);
  media.markReady(ready);
  return ready.length > 0;
}

export const isDrinkArtwork = (id: string) =>
  id === 'i1.jpg' || id === 'i23.jpg' || id.startsWith('drink:');

export function productArtworkId(
  product: { id: string; image_id: string; media?: KioskMedia },
  selections: readonly { group_id: string; option_id: string }[] = [],
) {
  const remote = media.artworkId(product);
  if (remote) return remote;
  if (product.id !== 'piko' || product.image_id !== 'generic-drink') return product.image_id;
  const flavor = selections.find((selection) => selection.group_id === 'piko-flavor');
  return (flavor && modifierArtworkId('piko-flavor', flavor.option_id)) || 'drink:piko';
}

export function modifierArtworkId(groupId: string, optionId: string) {
  if (groupId !== 'drink' && groupId !== 'piko-flavor') return undefined;
  if (optionId === 'piko') return 'drink:piko';
  const id = `drink:${optionId}`;
  return Object.hasOwn(products, id) ? id : undefined;
}
