import { createHash } from 'node:crypto';
import type { Metadata, OutputInfo } from 'sharp';
import {
  CATALOG_ASSET_MAX_BYTES,
  CATALOG_ASSET_MAX_PIXELS,
  CATALOG_ASSET_MIN_SIDE,
  CATALOG_ASSET_VARIANT_MAX_BYTES,
  CATALOG_ASSET_QUALITY,
  CATALOG_ASSET_VARIANTS,
  CatalogAdminError,
  containsActiveContent,
  sniffCatalogImage,
} from '@pickchick/catalog-admin';
import type {
  CatalogAssetVariantName,
  CatalogErrorReason,
  EncodedCatalogImage,
  EncodedCatalogVariant,
} from '@pickchick/catalog-admin';

const VARIANT_NAMES = Object.keys(CATALOG_ASSET_VARIANTS) as CatalogAssetVariantName[];
const failure = (code: CatalogAdminError['code'], reason?: CatalogErrorReason) =>
  reason ? new CatalogAdminError(code, reason) : new CatalogAdminError(code);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

type SharpModule = typeof import('sharp');
let sharpModule: Promise<SharpModule['default']> | undefined;
/**
 * libvips is loaded on first use, so a host without the native binary still boots the API;
 * uploads then fail closed with SERVICE_UNAVAILABLE.
 */
async function loadSharp() {
  sharpModule ??= import('sharp').then(({ default: sharp }) => {
    // No libvips operation cache: uploads are rare and the API container is small.
    sharp.cache(false);
    return sharp;
  });
  try {
    return await sharpModule;
  } catch {
    sharpModule = undefined;
    throw failure('SERVICE_UNAVAILABLE');
  }
}
async function decoder(bytes: Buffer) {
  const sharp = await loadSharp();
  return sharp(bytes, {
    limitInputPixels: CATALOG_ASSET_MAX_PIXELS,
    failOn: 'error',
    animated: false,
    sequentialRead: true,
  });
}

/**
 * Validates and re-encodes one uploaded photo. The content is kept as supplied: the image is
 * only turned upright by its EXIF orientation, resized down and re-compressed to WebP. All
 * metadata (EXIF, GPS, XMP, ICC) is dropped. Throws CatalogAdminError with a stable reason.
 */
export async function encodeCatalogImage(input: Uint8Array): Promise<EncodedCatalogImage> {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!bytes.length) throw failure('INVALID_REQUEST', 'ASSET_UNSUPPORTED_TYPE');
  if (bytes.length > CATALOG_ASSET_MAX_BYTES) throw failure('INVALID_REQUEST', 'ASSET_TOO_LARGE');
  const type = sniffCatalogImage(bytes);
  if (!type || containsActiveContent(bytes))
    throw failure('INVALID_REQUEST', 'ASSET_UNSUPPORTED_TYPE');
  const image = () => decoder(bytes);
  let metadata: Metadata;
  try {
    metadata = await (await image()).metadata();
  } catch (error) {
    if (error instanceof CatalogAdminError) throw error;
    throw failure('INVALID_REQUEST', 'ASSET_INVALID_IMAGE');
  }
  // The decoder must agree with the container the magic bytes claimed.
  if (metadata.format !== type) throw failure('INVALID_REQUEST', 'ASSET_UNSUPPORTED_TYPE');
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  if (
    !width ||
    !height ||
    width * height > CATALOG_ASSET_MAX_PIXELS ||
    Math.min(width, height) < CATALOG_ASSET_MIN_SIDE
  )
    throw failure('INVALID_REQUEST', 'ASSET_INVALID_IMAGE');
  const variants = {} as Record<CatalogAssetVariantName, EncodedCatalogVariant>;
  for (const name of VARIANT_NAMES) {
    const edge = CATALOG_ASSET_VARIANTS[name];
    let output: { data: Buffer; info: OutputInfo };
    try {
      output = await (
        await image()
      )
        .rotate()
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: CATALOG_ASSET_QUALITY, effort: 4, smartSubsample: true })
        .toBuffer({ resolveWithObject: true });
    } catch (error) {
      if (error instanceof CatalogAdminError) throw error;
      throw failure('INVALID_REQUEST', 'ASSET_INVALID_IMAGE');
    }
    if (output.data.length > CATALOG_ASSET_VARIANT_MAX_BYTES)
      throw failure('INVALID_REQUEST', 'ASSET_TOO_LARGE');
    variants[name] = {
      sha256: sha256(output.data),
      bytes: output.data,
      width: output.info.width,
      height: output.info.height,
    };
  }
  return { source_sha256: sha256(bytes), type, width, height, variants };
}
