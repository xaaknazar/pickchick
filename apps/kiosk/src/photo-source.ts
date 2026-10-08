// Pure photo-source resolution (no bundled require()), so it can be tested in node.
// Order for a product photo: published remote media, then the bundled v3 card/hero photo by
// image_asset_key, then the original mockup shot, then the logo.
import type { KioskMedia } from './model';

/** A bundled module id, or a remote https image. */
export type PhotoSource = number | { uri: string };
export interface Photo {
  source: PhotoSource;
  secondarySource?: PhotoSource;
  tile: string;
  cutout: boolean;
  /** Content hash of a remote photo (expo-image recycling key). */
  sha256?: string;
}
export type PhotoVariant = 'card' | 'hero';
export interface BundledPhotos {
  card(imageId: string): Photo | null;
  hero(imageId: string): Photo | null;
  /** Original mockup shot by image key. */
  product(imageId: string): number | undefined;
  logo: number;
}
/** Artwork id of a product whose publication carries an uploaded photo. */
export const MEDIA_ID_PREFIX = 'media:';
export const DEFAULT_TILE = '#FFFFFF';
const MEDIA_PATH = /^\/v1\/media\/catalog\/([a-f0-9]{64})\.(card|hero|thumb)\.webp$/;
const TILE = /^#[0-9A-F]{6}$/;

/** Absolute URL of a media-map rendition, or null if the path is not a catalog media path. */
export function mediaUrl(origin: string, path: string, variant: PhotoVariant): string | null {
  const match = MEDIA_PATH.exec(path);
  return match && match[2] === variant ? `${origin}${path}` : null;
}
const sha = (path: string) => MEDIA_PATH.exec(path)?.[1];
type Entry = { media: KioskMedia; imageKey: string };
type MediaProduct = { id: string; image_id: string; media?: KioskMedia };

/**
 * Remote photos of the loaded publication. Products with media get the artwork id
 * `media:<product id>`; ids that are still a bundled image key resolve to remote media only
 * when that key belongs to exactly one published photo and the photo is already on disk.
 */
export class CatalogMediaRegistry {
  private readonly byProduct = new Map<string, Entry>();
  private byKey = new Map<string, Entry>();
  private readonly ready = new Set<string>();
  private readonly origin: string;
  private readonly bundled: BundledPhotos;
  constructor(origin: string, bundled: BundledPhotos) {
    this.origin = origin;
    this.bundled = bundled;
  }
  /** Artwork id for a product: remote media first, the bundled image key otherwise. */
  artworkId(product: MediaProduct): string | null {
    const media = product.media;
    if (!media || !mediaUrl(this.origin, media.card, 'card')) return null;
    this.byProduct.set(product.id, { media, imageKey: product.image_id });
    return MEDIA_ID_PREFIX + product.id;
  }
  /** Registers a loaded catalog and returns the remote URLs to prefetch to disk. */
  sync(products: readonly MediaProduct[]): string[] {
    const keys = new Map<string, Entry | null>();
    const urls = new Set<string>();
    for (const product of products) {
      const id = this.artworkId(product);
      const entry = id ? this.byProduct.get(product.id)! : null;
      const previous = keys.get(product.image_id);
      keys.set(
        product.image_id,
        previous === undefined
          ? entry
          : previous && entry && previous.media.sha256 === entry.media.sha256
            ? previous
            : null,
      );
      if (entry)
        for (const variant of ['card', 'hero'] as const) {
          const url = mediaUrl(this.origin, entry.media[variant], variant);
          if (url) urls.add(url);
        }
    }
    this.byKey = new Map([...keys].filter((pair): pair is [string, Entry] => !!pair[1]));
    return [...urls];
  }
  /** Remote URLs that are known to be in the disk cache (offline-safe for plain images). */
  markReady(urls: readonly string[]) {
    for (const url of urls) this.ready.add(url);
  }
  private entry(imageId: string, variant: PhotoVariant): Entry | null {
    if (imageId.startsWith(MEDIA_ID_PREFIX))
      return this.byProduct.get(imageId.slice(MEDIA_ID_PREFIX.length)) ?? null;
    const entry = this.byKey.get(imageId);
    const url = entry && mediaUrl(this.origin, entry.media[variant], variant);
    return url && this.ready.has(url) ? entry : null;
  }
  private local(imageKey: string, variant: PhotoVariant) {
    return variant === 'hero' ? this.bundled.hero(imageKey) : this.bundled.card(imageKey);
  }
  /** Remote-first photo with its tile colour and cutout; null leaves the caller's fallback. */
  photo(imageId: string, variant: PhotoVariant): Photo | null {
    const entry = this.entry(imageId, variant);
    if (!entry) return imageId.startsWith(MEDIA_ID_PREFIX) ? null : this.local(imageId, variant);
    const local = this.local(entry.imageKey, variant);
    const url = mediaUrl(this.origin, entry.media[variant], variant);
    if (!url) return local;
    const tile = entry.media.tile_color;
    return {
      source: { uri: url },
      tile: tile && TILE.test(tile) ? tile : (local?.tile ?? DEFAULT_TILE),
      cutout: entry.media.cutout ?? local?.cutout ?? false,
      sha256: sha(entry.media[variant]),
    };
  }
  /** Ordered fallback chain of image sets: remote, bundled v3 photo, mockup shot, logo. */
  candidates(imageId: string, variant: PhotoVariant): PhotoSource[][] {
    const entry = this.entry(imageId, variant);
    const key = entry?.imageKey ?? imageId;
    const chain: PhotoSource[][] = [];
    const remote = entry ? this.photo(imageId, variant) : null;
    if (remote && typeof remote.source !== 'number') chain.push([remote.source]);
    const local = this.local(key, variant);
    if (local)
      chain.push(local.secondarySource ? [local.source, local.secondarySource] : [local.source]);
    const shot = this.bundled.product(key);
    if (shot !== undefined) chain.push([shot]);
    chain.push([this.bundled.logo]);
    return chain.filter(
      (sources, index) =>
        chain.findIndex((other) => JSON.stringify(other) === JSON.stringify(sources)) === index,
    );
  }
}
