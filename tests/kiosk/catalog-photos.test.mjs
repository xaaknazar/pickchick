// Every product of the published kiosk catalog must show a real bundled photo in commercial
// mode: catalog image_asset_key -> commercial-controller image_id -> assets.ts card/hero photo.
// assets.ts bundles images with require(), so it is loaded here with its imports stubbed and
// require() returning the bundled path, which is then checked on disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publishedKioskCatalog } from '../../apps/kiosk/src/commercial-controller.ts';
import { mockupCatalogDraft } from '@pickchick/catalog-admin/seed';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = join(root, 'apps/kiosk/src');
const LOGO = '../assets/v3/logo.webp';

/** The published kiosk catalog: product id -> image_asset_key (24 products). */
const expected = {
  'pick-combo': 'i7.jpg',
  'master-combo': 'i8.jpg',
  'burger-combo': 'i9.jpg',
  'solo-combo': 'i10.jpg',
  'finger-duo': 'i11.jpg',
  'burger-duo': 'i12.jpg',
  'mix-duo': 'i13.jpg',
  'fingers-25': 'i14.jpg',
  'fingers-50': 'i15.jpg',
  'fingers-75': 'i16.jpg',
  'fingers-100': 'i17.jpg',
  fingers: 'i4.jpg',
  sauce: 'i18.jpg',
  'sauce-hot': 'i19.jpg',
  toast: 'i5.jpg',
  coleslaw: 'i6.jpg',
  wedges: 'i20.jpg',
  burger: 'shot.jpg',
  lemonade: 'i0.jpg',
  cola: 'i2.jpg',
  'fuse-peach': 'i1.jpg',
  'iced-tea': 'i22.jpg',
  water: 'i23.jpg',
  piko: 'generic-drink',
};

async function loadAssets() {
  const code = stripTypeScriptTypes(readFileSync(join(src, 'assets.ts'), 'utf8'))
    .replace(
      /^import \{ Image \} from 'expo-image';/m,
      'const Image = { prefetch: async () => true };',
    )
    .replace(
      /^import \{ colors \} from '\.\/theme';/m,
      "const colors = { navy: '#04143A', white: '#FFFFFF' };",
    )
    .replace(/'\.\/api'/, JSON.stringify(pathToFileURL(join(src, 'api.ts')).href))
    .replace(/'\.\/photo-source'/, JSON.stringify(pathToFileURL(join(src, 'photo-source.ts')).href))
    .replace(
      /^import \{ bundledPhotoBounds \} from '\.\/bundled-photo-bounds';/m,
      'const bundledPhotoBounds = new Map();',
    )
    .replace(
      /'\.\/photo-bounds'/,
      JSON.stringify(pathToFileURL(join(src, 'photo-bounds.ts')).href),
    );
  assert.doesNotMatch(code, /from '\.\//, 'every relative import of assets.ts is resolved');
  const dir = mkdtempSync(join(tmpdir(), 'kiosk-assets-'));
  const file = join(dir, 'assets.mjs');
  writeFileSync(file, 'const require = (path) => path;\n' + code);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const assets = await loadAssets();
const catalog = publishedKioskCatalog({
  branch: {
    id: '7a6f6d98-395d-4462-b5e4-b0364a4a8ec1',
    code: 'pilot',
    name: 'PickChick',
    timezone: 'Asia/Almaty',
    ordering_enabled: true,
  },
  channel: 'kiosk',
  version: 1,
  published_at: '2026-10-09T00:00:00Z',
  payload: globalThis.structuredClone(mockupCatalogDraft),
});

/** A bundled photo: a real supplied file, never the logo fallback. */
function assertBundled(source, label) {
  assert.equal(typeof source, 'string', `${label}: bundled module, not a remote URL`);
  assert.notEqual(source, LOGO, `${label}: falls back to the logo`);
  assert.match(
    source,
    /^\.\.\/assets\/(v3\/(photos|hero|hd|options)|drinks)\//,
    `${label}: ${source}`,
  );
  assert.ok(existsSync(resolve(src, source)), `${label}: missing file ${source}`);
}

test('published kiosk catalog keeps the 24 known image_asset_key values', () => {
  const actual = Object.fromEntries(catalog.products.map((p) => [p.id, p.image_id]));
  assert.deepEqual(actual, expected);
});

test('every catalog product resolves to a bundled card and hero photo', () => {
  for (const product of catalog.products) {
    const id = assets.productArtworkId(product);
    for (const [variant, photo] of [
      ['card', assets.productPhoto(id)],
      ['hero', assets.heroPhoto(id)],
    ]) {
      const label = `${product.id} (${product.image_id}) ${variant}`;
      assert.ok(photo, `${label}: no photo`);
      assertBundled(photo.source, label);
      if (photo.secondarySource) assertBundled(photo.secondarySource, label + ' second');
      const first = assets.photoCandidates(id, variant)[0];
      assert.deepEqual(
        first,
        photo.secondarySource ? [photo.source, photo.secondarySource] : [photo.source],
      );
    }
  }
});

test('the 24 keys resolve even without the controller (e.g. promotions)', () => {
  for (const [productId, key] of Object.entries(expected)) {
    assertBundled(assets.productPhoto(key)?.source, `${productId} card ${key}`);
    assertBundled(assets.heroPhoto(key)?.source, `${productId} hero ${key}`);
  }
});

test('a published remote photo keeps the bundled photo as its offline fallback', () => {
  const sha = 'a'.repeat(64);
  const media = {
    sha256: sha,
    card: `/v1/media/catalog/${sha}.card.webp`,
    hero: `/v1/media/catalog/${'b'.repeat(64)}.hero.webp`,
    thumb: `/v1/media/catalog/${'c'.repeat(64)}.thumb.webp`,
  };
  for (const product of catalog.products) {
    const id = assets.productArtworkId({ ...product, media });
    const chain = assets.photoCandidates(id, 'card');
    assert.equal(typeof chain[0][0], 'object', `${product.id}: remote photo first`);
    assertBundled(chain[1][0], `${product.id} remote fallback`);
  }
});

test('card illustrations bg1-bg4 are bundled', () => {
  assert.equal(assets.cardBackgrounds.length, 4);
  assets.cardBackgrounds.forEach((source, index) => {
    assert.equal(source, `../assets/v3/bg/bg${index + 1}.svg`);
    assert.ok(existsSync(resolve(src, source)));
  });
});

test('owner 23.11: a combo drink option without its own photo shows its drink product photo', () => {
  const sha = 'b'.repeat(64);
  const product = (id, imageId, media) => ({
    ...catalog.products.find((p) => p.id === 'cola'),
    id,
    image_id: imageId,
    media,
  });
  const live = {
    ...catalog,
    products: [
      ...catalog.products,
      product('fanta-can', 'generic-drink', {
        sha256: sha,
        card: `/v1/media/catalog/${sha}.card.webp`,
        hero: `/v1/media/catalog/${sha}.hero.webp`,
        thumb: `/v1/media/catalog/${sha}.thumb.webp`,
        cutout: true,
      }),
      product('fuse-lemon', 'generic-drink', undefined),
    ],
  };
  assert.equal(assets.optionPhoto('fanta-can'), null, 'unknown before the catalog loads');
  assets.rememberCatalogMedia(live);
  try {
    const can = assets.optionPhoto('fanta-can');
    assert.match(can?.source?.uri ?? '', new RegExp(`${sha}\\.card\\.webp$`));
    assert.equal(can.cutout, true);
    // The catalog ids of the cola can and the iced tea have bundled option photos.
    assertBundled(assets.optionPhoto('cola')?.source, 'cola option');
    assertBundled(assets.optionPhoto('iced-tea')?.source, 'iced-tea option');
    // Only the generic placeholder: the tile keeps the name mark, never another drink.
    assert.equal(assets.optionPhoto('fuse-lemon'), null);
  } finally {
    assets.rememberCatalogMedia(null);
  }
});
