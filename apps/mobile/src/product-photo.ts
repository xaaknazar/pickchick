import type { CatalogMediaEntry, CatalogMediaMap } from '@pickchick/catalog-admin/contracts';
import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';

/** Remote rendition of an uploaded back-office photo (see CatalogMediaMapSchema). */
export type PhotoVariant = 'card' | 'hero' | 'thumb';
export type PhotoKind = 'remote' | 'id' | 'key' | 'logo';

export interface PhotoCandidate<S> {
  id: string;
  /** Bundled image already chosen for the product (published key, legacy id or logo). */
  image: S;
  /** Published `image_asset_key`; absent for design and legacy TEST/menu products. */
  imageKey?: string;
  /** Uploaded photo of the current publication, if the media map lists the product. */
  media?: CatalogMediaEntry;
}

export interface BundledPhotos<S> {
  /** The owner's real drink photographs keyed by product id; see `ownerPhoto`. */
  owner?: Readonly<Record<string, S>>;
  /** Context-specific retouches keyed by product id (light menu tile, blue hero...). */
  byId: Readonly<Record<string, S>>;
  /** Bundled photographs keyed by published `image_asset_key`. */
  byKey: Readonly<Record<string, S>>;
  logo: S;
}

export type RemotePhotoSource = { uri: string; cacheKey: string };
export type ResolvedPhoto<S> =
  | { kind: 'remote'; source: RemotePhotoSource; cacheKey: string; fallback: ResolvedPhoto<S> }
  | { kind: Exclude<PhotoKind, 'remote'>; source: S };

const SEED_IMAGE_KEYS: ReadonlyMap<string, string> = new Map(
  testCompleteCatalog.products.map((product) => [product.id, product.image_id]),
);

/** The bundled key every seeded product was published with before any back-office edit. */
export function seedImageKey(productId: string): string | undefined {
  return SEED_IMAGE_KEYS.get(productId);
}

/** Closed back-office key of a drink without its own bundled photo (CATALOG_ASSET_KEYS). */
export const GENERIC_DRINK_KEY = 'generic-drink';

/**
 * Product and drink option ids with the owner's real photograph (assets/drinks/README.md).
 * Exact packaging only: the 0.5 l bottles never stand in for a can (cola, cola-can, *-can), and
 * drinks without an owner photo (fuse-berry, fuse-watermelon, lemonade...) keep their image.
 */
export const ownerDrinkPhotoIds = [
  'fuse-peach',
  'fuse-mango',
  'fuse-mango-pineapple',
  'water',
  'cola-bottle',
  'cola-zero',
  'sprite',
  'fanta',
  'piko',
  'piko-apple',
  'piko-orange',
] as const;
export type OwnerDrinkPhotoId = (typeof ownerDrinkPhotoIds)[number];

/**
 * The owner's photo of exactly this product id while the published key still means "no other
 * photo chosen": the seed key, or `generic-drink`, which the back-office publishes for new
 * drinks. Any other published key is a back-office choice and wins.
 */
export function ownerPhoto<S>(
  owner: Readonly<Record<string, S>> | undefined,
  productId: string,
  imageKey: string | undefined,
): S | undefined {
  if (!owner || !Object.prototype.hasOwnProperty.call(owner, productId)) return undefined;
  return imageKey === undefined ||
    imageKey === seedImageKey(productId) ||
    imageKey === GENERIC_DRINK_KEY
    ? owner[productId]
    : undefined;
}

const MEDIA_PATH = /^\/v1\/media\/catalog\/([a-f0-9]{64})\.(card|hero|thumb)\.webp$/;
const ORIGIN = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;

/** Only immutable same-API hash paths become remote images; anything else is ignored. */
export function remoteMediaSource(
  media: CatalogMediaEntry | undefined,
  variant: PhotoVariant,
  origin: string,
): RemotePhotoSource | null {
  const path = media?.[variant];
  const match = typeof path === 'string' ? MEDIA_PATH.exec(path) : null;
  if (!match || match[2] !== variant || !ORIGIN.test(origin)) return null;
  return { uri: `${origin}${path}`, cacheKey: match[1]! };
}

/**
 * Bundled choice for a product: the owner's photo of this id (seed or generic drink key), then the
 * id retouch while the published key is unchanged, then the key photo, then the logo.
 */
export function resolveBundledPhoto<S>(
  product: PhotoCandidate<S>,
  bundled: BundledPhotos<S>,
): Exclude<ResolvedPhoto<S>, { kind: 'remote' }> {
  const has = (map: Readonly<Record<string, S>>, key: string) =>
    Object.prototype.hasOwnProperty.call(map, key) && map[key] !== undefined;
  const owned = ownerPhoto(bundled.owner, product.id, product.imageKey);
  if (owned !== undefined) return { kind: 'id', source: owned };
  const unchanged = product.imageKey === undefined || product.imageKey === seedImageKey(product.id);
  if (unchanged && has(bundled.byId, product.id))
    return { kind: 'id', source: bundled.byId[product.id]! };
  if (product.imageKey === undefined) return { kind: 'key', source: product.image };
  if (has(bundled.byKey, product.imageKey))
    return { kind: 'key', source: bundled.byKey[product.imageKey]! };
  return { kind: 'logo', source: bundled.logo };
}

/**
 * Photo precedence for one product: the published uploaded photo (remote, immutable hash URL),
 * then the bundled photo of the published key, then the logo. A product-id photo is used only
 * while the key is still the seed default (or `generic-drink` for an owner drink photo), so it
 * never overrides a back-office choice.
 */
export function resolveProductPhoto<S>(
  product: PhotoCandidate<S>,
  media: CatalogMediaEntry | undefined,
  variant: PhotoVariant,
  bundled: BundledPhotos<S>,
  origin: string,
): ResolvedPhoto<S> {
  const fallback = resolveBundledPhoto(product, bundled);
  const remote = remoteMediaSource(media, variant, origin);
  return remote
    ? { kind: 'remote', source: remote, cacheKey: remote.cacheKey, fallback }
    : fallback;
}

/** Media map entries for the given publication version only; a mismatch is ignored. */
export function mediaForVersion(
  media: CatalogMediaMap | null | undefined,
  version: number,
): Readonly<Record<string, CatalogMediaEntry>> {
  return media && media.version === version ? media.products : {};
}

/**
 * Until the media map of a new publication arrives, keep showing the previous uploaded photos
 * instead of the bundled fallback (and keep upload-only products openable). The interim map is
 * replaced as soon as the version-bound map is read.
 */
export function interimMedia(
  previous: CatalogMediaMap | null | undefined,
  next: CatalogMediaMap | null | undefined,
): CatalogMediaMap | null {
  if (!next) return previous ?? null;
  if (!previous || previous.version === next.version || Object.keys(next.products).length)
    return next;
  return { version: next.version, products: previous.products };
}

/** Every remote rendition URL of a media map, deduplicated, for disk prefetch. */
export function mediaPrefetchUris(media: CatalogMediaMap | null | undefined, origin: string) {
  const uris = new Set<string>();
  for (const entry of Object.values(media?.products ?? {}))
    for (const variant of ['card', 'hero', 'thumb'] as const) {
      const source = remoteMediaSource(entry, variant, origin);
      if (source) uris.add(source.uri);
    }
  return [...uris];
}
