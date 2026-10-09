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

/** Bundled choice for a product: id retouch only while the published key is unchanged. */
export function resolveBundledPhoto<S>(
  product: PhotoCandidate<S>,
  bundled: BundledPhotos<S>,
): Exclude<ResolvedPhoto<S>, { kind: 'remote' }> {
  const has = (map: Readonly<Record<string, S>>, key: string) =>
    Object.prototype.hasOwnProperty.call(map, key) && map[key] !== undefined;
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
 * then the bundled photo of the published key, then the logo. A product-id retouch is used only
 * while the key is still the seed default, so it never overrides a back-office choice.
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
