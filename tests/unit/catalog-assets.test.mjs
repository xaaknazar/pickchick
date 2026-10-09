import { encodeCatalogImage } from '../../services/api/dist/catalog-image-encoder.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { crc32, deflateSync } from 'node:zlib';
import {
  CATALOG_ASSET_MAX_BYTES,
  CATALOG_ASSET_UPLOAD_ROUTE,
  CATALOG_MEDIA_FILE,
  CatalogAdminError,
  CatalogAssetSchema,
  CatalogErrorReasonSchema,
  CatalogMediaEntrySchema,
  catalogMediaOptions,
  catalogMediaUrl,
  containsActiveContent,
  sniffCatalogImage,
} from '../../packages/catalog-admin/dist/index.js';
import { catalogAssetGrants } from '../../infra/staging/catalog-asset-grants.mjs';

const sharp = createRequire(new URL('../../services/api/package.json', import.meta.url))('sharp');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rejects = (reason) => (error) =>
  error instanceof CatalogAdminError && error.code === 'INVALID_REQUEST' && error.reason === reason;
const isWebp = (bytes) =>
  bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
  bytes.subarray(8, 12).toString('latin1') === 'WEBP';

// Deterministic synthetic photo: a gradient with a few shapes, no external files.
async function photo({ width = 1600, height = 1200, format = 'jpeg' } = {}) {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#f4c542"/><stop offset="1" stop-color="#b8321f"/>
      </linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <circle cx="${width / 3}" cy="${height / 2}" r="${height / 4}" fill="#ffffff"/>
      <rect x="${width / 2}" y="${height / 5}" width="${width / 4}" height="${height / 3}" fill="#202020"/>
    </svg>`,
  );
  return sharp(svg)[format]().toBuffer();
}
function png(width, height, idat) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('magic-byte sniffing accepts only JPEG, PNG, WebP and HEIC/HEIF containers', async () => {
  assert.equal(sniffCatalogImage(await photo()), 'jpeg');
  assert.equal(sniffCatalogImage(await photo({ format: 'png' })), 'png');
  assert.equal(sniffCatalogImage(await photo({ format: 'webp' })), 'webp');
  const ftyp = (brand) =>
    Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp' + brand + '\0\0\0\0mif1')]);
  for (const brand of ['heic', 'heix', 'mif1'])
    assert.equal(sniffCatalogImage(ftyp(brand)), 'heif');
  for (const bytes of [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    Buffer.from('﻿<?xml version="1.0"?><svg/>'),
    Buffer.from('GIF89a\x01\x00\x01\x00'),
    Buffer.from('GIF87a/*\x00\x00*/=alert(1)//'),
    Buffer.from('<!DOCTYPE html><img>'),
    Buffer.from('%PDF-1.7'),
    Buffer.from('BM\x00\x00'),
    ftyp('qt  '),
    ftyp('mp42'),
    Buffer.alloc(0),
    Buffer.from([0xff, 0xd8]),
  ])
    assert.equal(sniffCatalogImage(bytes), null, JSON.stringify(bytes.toString('latin1')));
});

test('SVG, GIF, polyglots, oversize files and undecodable HEIC are rejected before storage', async () => {
  const jpeg = await photo();
  await assert.rejects(
    encodeCatalogImage(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>'),
    ),
    rejects('ASSET_UNSUPPORTED_TYPE'),
  );
  const gif = await sharp(jpeg).gif().toBuffer();
  assert.equal(gif.subarray(0, 3).toString('latin1'), 'GIF');
  await assert.rejects(encodeCatalogImage(gif), rejects('ASSET_UNSUPPORTED_TYPE'));
  // A valid JPEG carrying an HTML payload (image/HTML polyglot).
  await assert.rejects(
    encodeCatalogImage(Buffer.concat([jpeg, Buffer.from('<HTML><Script>alert(1)</script>')])),
    rejects('ASSET_UNSUPPORTED_TYPE'),
  );
  assert.equal(containsActiveContent(Buffer.from('xx<sVg XmLnS="x">')), true);
  assert.equal(containsActiveContent(jpeg), false);
  // PNG magic in front of JPEG data: the decoder disagrees with the claimed container.
  await assert.rejects(
    encodeCatalogImage(
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), jpeg]),
    ),
    (error) => error instanceof CatalogAdminError && error.code === 'INVALID_REQUEST',
  );
  // WebP header that wraps JPEG bytes.
  const riff = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'latin1'), jpeg]);
  await assert.rejects(encodeCatalogImage(riff), (error) => error instanceof CatalogAdminError);
  const oversize = Buffer.alloc(CATALOG_ASSET_MAX_BYTES + 1);
  oversize.set([0xff, 0xd8, 0xff]);
  await assert.rejects(encodeCatalogImage(oversize), rejects('ASSET_TOO_LARGE'));
  await assert.rejects(encodeCatalogImage(Buffer.alloc(0)), rejects('ASSET_UNSUPPORTED_TYPE'));
  await assert.rejects(encodeCatalogImage(jpeg.subarray(0, 200)), rejects('ASSET_INVALID_IMAGE'));
  const heic = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from('ftypheic\0\0\0\0mif1heic', 'latin1'),
    Buffer.alloc(64),
  ]);
  await assert.rejects(encodeCatalogImage(heic), rejects('ASSET_INVALID_IMAGE'));
  // Too small to be a product photo.
  await assert.rejects(
    encodeCatalogImage(await photo({ width: 20, height: 400 })),
    rejects('ASSET_INVALID_IMAGE'),
  );
});

test('a decompression bomb is refused from its header, before any pixel is decoded', async () => {
  const bomb = png(20000, 20000, deflateSync(Buffer.alloc(1024)));
  assert.ok(bomb.length < 2048);
  const started = Date.now();
  await assert.rejects(encodeCatalogImage(bomb), rejects('ASSET_INVALID_IMAGE'));
  assert.ok(Date.now() - started < 2000);
  // Just over the 40 MP limit, still tiny on disk.
  await assert.rejects(
    encodeCatalogImage(png(8000, 5001, deflateSync(Buffer.alloc(1024)))),
    rejects('ASSET_INVALID_IMAGE'),
  );
});

test('re-encoding keeps the picture upright and strips EXIF, GPS, XMP and ICC metadata', async () => {
  const source = await sharp(await photo({ width: 1600, height: 900 }))
    .jpeg()
    .withExif({
      IFD0: { Copyright: 'Synthetic', Artist: 'Synthetic' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '43/1 14/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '76/1 53/1 0/1',
      },
    })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const before = await sharp(source).metadata();
  assert.equal(before.orientation, 6);
  assert.ok(before.exif);
  assert.match(before.exif.toString('latin1'), /GPS|Synthetic/);
  const encoded = await encodeCatalogImage(source);
  assert.equal(encoded.type, 'jpeg');
  assert.equal(encoded.source_sha256, sha(source));
  // Orientation 6 = rotated 90 degrees: the stored photo is upright (portrait).
  assert.deepEqual([encoded.width, encoded.height], [900, 1600]);
  for (const [name, edge] of [
    ['card', 640],
    ['hero', 1280],
    ['thumb', 240],
  ]) {
    const variant = encoded.variants[name];
    assert.ok(isWebp(variant.bytes));
    assert.equal(variant.sha256, sha(variant.bytes));
    assert.equal(Math.max(variant.width, variant.height), edge);
    assert.ok(variant.height > variant.width, name + ' stays upright');
    const meta = await sharp(variant.bytes).metadata();
    assert.equal(meta.format, 'webp');
    assert.deepEqual([meta.width, meta.height], [variant.width, variant.height]);
    assert.equal(meta.exif, undefined);
    assert.equal(meta.icc, undefined);
    assert.equal(meta.xmp, undefined);
    assert.equal(meta.orientation, undefined);
    assert.ok(!variant.bytes.includes(Buffer.from('Synthetic')));
    assert.ok(!variant.bytes.includes(Buffer.from('GPS')));
  }
});

test('output hashes are deterministic for a fixture and small sources are never enlarged', async () => {
  const fixture = await photo({ width: 1000, height: 1000, format: 'png' });
  const [first, second] = [await encodeCatalogImage(fixture), await encodeCatalogImage(fixture)];
  for (const name of ['card', 'hero', 'thumb'])
    assert.equal(first.variants[name].sha256, second.variants[name].sha256);
  assert.deepEqual(
    Object.values(first.variants).map((v) => [v.width, v.height]),
    [
      [640, 640],
      [1000, 1000],
      [240, 240],
    ],
  );
  assert.equal(new Set(Object.values(first.variants).map((v) => v.sha256)).size, 3);
  // WebP input is accepted, and a tiny-but-valid source keeps its size in every rendition.
  const small = await encodeCatalogImage(await photo({ width: 200, height: 120, format: 'webp' }));
  assert.equal(small.type, 'webp');
  for (const variant of Object.values(small.variants))
    assert.deepEqual([variant.width, variant.height], [200, 120]);
});

test('flag, routes, URLs and grants are strict and fail closed', () => {
  assert.deepEqual(catalogMediaOptions({}), { mediaEnabled: false });
  assert.deepEqual(catalogMediaOptions({ CATALOG_MEDIA_UPLOAD_ENABLED: 'true' }), {
    mediaEnabled: true,
  });
  for (const value of ['1', 'TRUE', 'yes', ''])
    assert.throws(
      () => catalogMediaOptions({ CATALOG_MEDIA_UPLOAD_ENABLED: value }),
      /CATALOG_MEDIA_UPLOAD_CONFIGURATION_INVALID/,
    );
  const hex = 'ab'.repeat(32);
  assert.equal(catalogMediaUrl(hex, 'card'), `/v1/media/catalog/${hex}.card.webp`);
  // The same URL form the media map contract (WP-A) requires.
  assert.ok(
    CatalogMediaEntrySchema.safeParse({
      sha256: hex,
      card: catalogMediaUrl(hex, 'card'),
      hero: catalogMediaUrl(hex, 'hero'),
      thumb: catalogMediaUrl(hex, 'thumb'),
    }).success,
  );
  for (const file of [`${hex}.webp`, `${hex}.card.webp`, `${hex}.hero.webp`, `${hex}.thumb.webp`])
    assert.ok(CATALOG_MEDIA_FILE.test(file), file);
  for (const file of [
    `${hex.toUpperCase()}.webp`,
    `${hex}.original.webp`,
    `${hex}.png`,
    `${hex}.card.webp.html`,
    `../${hex}.webp`,
    `${hex.slice(1)}.webp`,
  ])
    assert.equal(CATALOG_MEDIA_FILE.test(file), false, file);
  assert.ok(
    CATALOG_ASSET_UPLOAD_ROUTE.test(
      '/v1/admin/catalog/branches/10000000-0000-4000-a000-000000000002/assets',
    ),
  );
  assert.equal(
    CATALOG_ASSET_UPLOAD_ROUTE.test(
      '/v1/admin/catalog/branches/10000000-0000-4000-a000-000000000002/draft',
    ),
    false,
  );
  for (const reason of [
    'ASSET_MISSING',
    'ASSET_UNSUPPORTED_TYPE',
    'ASSET_TOO_LARGE',
    'ASSET_INVALID_IMAGE',
    'ASSET_RATE_LIMITED',
  ])
    assert.ok(CatalogErrorReasonSchema.safeParse(reason).success, reason);
  assert.equal(CatalogAssetSchema.safeParse({}).success, false);
  const off = catalogAssetGrants('pickchick_app', false);
  assert.match(off, /REVOKE ALL ON catalog_assets, catalog_asset_variants, catalog_asset_audit/);
  assert.match(off, /GRANT SELECT ON catalog_assets, catalog_asset_variants TO pickchick_app/);
  assert.doesNotMatch(off, /INSERT|UPDATE|DELETE|catalog_asset_audit TO/);
  const on = catalogAssetGrants('pickchick_app', true);
  assert.match(on, /GRANT INSERT ON catalog_assets, catalog_asset_variants/);
  assert.doesNotMatch(on, /UPDATE|DELETE|TRUNCATE/);
  for (const [role, enabled] of [
    ['Robert; DROP', true],
    ['app', 'true'],
  ])
    assert.throws(() => catalogAssetGrants(role, enabled), /Invalid catalog asset grant/);
});
