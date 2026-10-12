import type { OwnerDrinkPhotoId } from './product-photo';

/**
 * The owner's real drink photographs (2026-10-08), byte-identical copies of the kiosk files:
 * exact screenshot crops with an alpha mask, no generation or resizing. Provenance:
 * assets/drinks/README.md and apps/kiosk/assets/drinks/provenance.json.
 * Keyed by catalog product id and by drink option id; see `ownerDrinkPhotoIds` for the rules.
 */
export const ownerDrinkPhotos: Readonly<Record<string, number>> = {
  'fuse-peach': require('../assets/drinks/fuse-peach.png'),
  'fuse-mango': require('../assets/drinks/fuse-mango-chamomile.png'),
  // Reference-only crop: no product or option uses this id yet.
  'fuse-mango-pineapple': require('../assets/drinks/fuse-mango-pineapple.png'),
  water: require('../assets/drinks/bonaqua-still.png'),
  'cola-bottle': require('../assets/drinks/cola-classic.png'),
  'cola-zero': require('../assets/drinks/cola-zero.png'),
  sprite: require('../assets/drinks/sprite.png'),
  fanta: require('../assets/drinks/fanta.png'),
  // The catalog Piko has no flavour yet: the apple pack stands for it until the owner decides.
  piko: require('../assets/drinks/piko-apple.png'),
  // Prepared Piko flavours (packages/catalog-admin/src/piko-flavors.ts).
  'piko-apple': require('../assets/drinks/piko-apple.png'),
  'piko-orange': require('../assets/drinks/piko-orange.png'),
} satisfies Record<OwnerDrinkPhotoId, number>;
