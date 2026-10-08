// Literal paths bundle the customer's supplied artwork for offline presentation.
export const assets = {
  logo: require('../../../design/prototype/assets/mockup/logo.png'),
  hero: require('../../../design/prototype/assets/mockup/hero.mp4'),
  poster: require('../../../design/prototype/assets/mockup/hero-poster.jpg'),
  blue: require('../../../design/prototype/assets/mockup/i27.jpg'),
  orange: require('../../../design/prototype/assets/mockup/bg-orange.png'),
  promo: require('../../../design/prototype/assets/mockup/i28.jpg'),
};
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
export const productImage = (id: string) => products[id] ?? assets.logo;

export const isDrinkArtwork = (id: string) =>
  id === 'i1.jpg' || id === 'i23.jpg' || id.startsWith('drink:');

export function productArtworkId(
  product: { id: string; image_id: string },
  selections: readonly { group_id: string; option_id: string }[] = [],
) {
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
