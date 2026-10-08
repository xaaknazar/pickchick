import { useState } from 'react';
import type { ImageSourcePropType, StyleProp } from 'react-native';
import { Image, type ImageContentFit, type ImageStyle } from 'expo-image';
import type { CatalogMediaMap } from '@pickchick/catalog-admin/contracts';
import { API_URL } from '../api';
import { bundledCatalogImages, catalogLogo } from '../catalog';
import { menuPhotos } from '../menu-photo-assets';
import { photoHeroes } from '../product-photo-assets';
import {
  mediaPrefetchUris,
  resolveProductPhoto,
  type BundledPhotos,
  type PhotoCandidate,
  type PhotoVariant,
  type ResolvedPhoto,
} from '../product-photo';

/**
 * Where a photo is shown decides which bundled retouch belongs there:
 * - menu: light menu tiles (cards, cart lines, order status and history);
 * - hero: blue product-page heroes and companion cards;
 * - extra: cart recommendations, which prefer the light tile and then the hero cut-out.
 */
export type PhotoContext = 'menu' | 'hero' | 'extra';

const piko: ImageSourcePropType = require('../../assets/catalog-options/piko.png');
const byId: Record<PhotoContext, Record<string, ImageSourcePropType>> = {
  menu: { piko, ...menuPhotos },
  hero: photoHeroes,
  extra: { ...photoHeroes, ...menuPhotos },
};
const bundled = (context: PhotoContext): BundledPhotos<ImageSourcePropType> => ({
  byId: byId[context],
  byKey: bundledCatalogImages,
  logo: catalogLogo,
});

export type ProductPhotoSource = ResolvedPhoto<ImageSourcePropType>;

/** Remote uploaded photo, else the bundled photo for the published key, else the logo. */
export function productPhoto(
  product: PhotoCandidate<ImageSourcePropType>,
  variant: PhotoVariant,
  context: PhotoContext,
): ProductPhotoSource {
  return resolveProductPhoto(product, product.media, variant, bundled(context), API_URL);
}

/** Warm the disk cache with every rendition of a newly loaded publication. Never throws. */
export function prefetchCatalogMedia(media: CatalogMediaMap | null | undefined) {
  const uris = mediaPrefetchUris(media, API_URL);
  if (!uris.length) return;
  void Image.prefetch(uris, 'disk').catch(() => false);
}

/**
 * Renders a resolved product photo. A remote photo is cached on disk under its content hash and
 * falls back to the bundled photo when it cannot be loaded (offline first start, media disabled).
 */
export function ProductPhoto({
  photo,
  style,
  contentFit = 'contain',
  accessible,
  accessibilityLabel,
  testID,
  cachePolicy = 'memory-disk',
}: {
  photo: ProductPhotoSource;
  style?: StyleProp<ImageStyle>;
  contentFit?: ImageContentFit;
  accessible?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  /** Cache policy for bundled sources; remote photos always use the disk cache. */
  cachePolicy?: 'memory-disk' | 'memory' | 'disk' | 'none';
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const remote = photo.kind === 'remote' && failed !== photo.cacheKey;
  const shown = photo.kind === 'remote' ? (remote ? photo : photo.fallback) : photo;
  return (
    <Image
      source={shown.source}
      style={style}
      contentFit={contentFit}
      accessible={accessible}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      cachePolicy={remote ? 'disk' : cachePolicy}
      recyclingKey={photo.kind === 'remote' ? photo.cacheKey : undefined}
      onError={remote ? () => setFailed(photo.cacheKey) : undefined}
    />
  );
}
