import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { publishedProductData } from '../../apps/mobile/src/published-catalog.ts';
import * as productPhoto from '../../apps/mobile/src/product-photo.ts';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { testCompleteCatalog } from '../../packages/test-order-flow/dist/complete-catalog.js';
import { TestCompleteCatalogSchema } from '../../packages/test-order-flow/dist/contracts.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const assetRoot = resolve(root, 'design/prototype/assets/mockup');
const source = readFileSync(resolve(root, 'design/reference-source/kiosk.html.txt'), 'utf8');
const provenance = JSON.parse(readFileSync(resolve(assetRoot, 'provenance.json'), 'utf8'));

// Exercise the actual Metro literal mappings without loading React Native or an image decoder.
function metroModule(relative) {
  const filename = resolve(root, relative);
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText;
  runInNewContext(compiled, {
    exports,
    require(id) {
      if (id === './published-catalog') return { publishedProductData };
      if (id === './product-photo') return productPhoto;
      if (id === '@pickchick/test-order-flow/complete-catalog') return { testCompleteCatalog };
      if (id === './catalog-cutouts') return metroModule('apps/mobile/src/catalog-cutouts.ts');
      assert.match(id, /\.(jpg|png)$/);
      const path = resolve(dirname(filename), id);
      assert(readFileSync(path).length > 0, `Metro asset exists: ${id}`);
      return path;
    },
  });
  return exports;
}
const mobileCatalog = () => metroModule('apps/mobile/src/catalog.ts');

test('burger, tea and water retain original provenance and use bundled HD retouches in mobile', () => {
  const mobile = mobileCatalog().connectedProducts(testCompleteCatalog);
  for (const id of ['burger', 'iced-tea', 'water']) {
    const product = testCompleteCatalog.products.find((item) => item.id === id);
    assert(product);
    const original = source.split('\n').find((line) => line.includes(`name: '${product.name}'`));
    assert(original, `original kiosk product: ${product.name}`);
    const filename = original.match(/img: 'offline\/([^']+)'/)?.[1];
    assert(filename);
    assert.equal(product.image_id, filename);
    const imagePath = resolve(assetRoot, filename);
    const retouch = resolve(root, `apps/mobile/assets/catalog-hd/${id}.png`);
    assert.equal(mobile.find((item) => item.id === id)?.image, retouch);
    assert.deepEqual(
      [...readFileSync(retouch).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
      'bundled PNG retouch',
    );
    const bytes = readFileSync(imagePath);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], 'original JPEG');
    const evidence = provenance.find((entry) => entry.file === filename);
    assert(evidence);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), evidence.sha256);
    assert.equal(evidence.transform, 'none');
  }
});

test('an image added by a newer catalog remains schema-compatible and has a safe mobile fallback', () => {
  const catalog = globalThis.structuredClone(testCompleteCatalog);
  catalog.products[0].image_id = 'future-source-image.jpg';
  const parsed = TestCompleteCatalogSchema.parse(catalog);
  const product = mobileCatalog().connectedProducts(parsed)[0];
  assert.equal(product.image, resolve(assetRoot, 'logo.png'));
  assert.equal(product.id, catalog.products[0].id);
  assert.equal(product.priceMinor, catalog.products[0].price_minor);
  assert.equal(product.catalogVersion, 'mockup-v0.3');
});

const ORIGIN = 'https://pickchick.185.129.51.103.nip.io';
const asset = (path) => resolve(root, 'apps/mobile/assets', path);
const sha = (c) => c.repeat(64);
const media = (card) => ({
  sha256: card,
  card: `/v1/media/catalog/${card}.card.webp`,
  hero: `/v1/media/catalog/${sha('b')}.hero.webp`,
  thumb: `/v1/media/catalog/${sha('c')}.thumb.webp`,
});
function storefront(products = mockupCatalogDraft.products) {
  return {
    branch: { id: '10000000-0000-4000-8000-000000000003' },
    version: 6,
    payload: { ...mockupCatalogDraft, products },
  };
}

test('published products carry their bundled key photo, published key and current media entry', () => {
  const catalog = mobileCatalog();
  const publication = storefront();
  const map = { version: 6, products: { burger: media(sha('a')) } };
  const products = catalog.publishedProducts(publication, 'ru', map);
  assert.equal(products.length, 24);
  for (const product of products) {
    const source = mockupCatalogDraft.products.find((item) => item.id === product.id);
    assert.equal(product.imageKey, source.image_asset_key);
    assert.equal(product.imageKey, productPhoto.seedImageKey(product.id));
    assert.equal(
      product.image,
      product.id === 'piko'
        ? asset('catalog-options/piko.png')
        : catalog.bundledCatalogImages[source.image_asset_key],
    );
  }
  assert.deepEqual(products.find((p) => p.id === 'burger').media, map.products.burger);
  assert.ok(products.filter((p) => p.id !== 'burger').every((p) => !('media' in p)));
  // A media map of another version (republished meanwhile) is ignored, not mixed in.
  assert.ok(
    catalog
      .publishedProducts(publication, 'ru', { ...map, version: 5 })
      .every((p) => !('media' in p)),
  );
  assert.ok(catalog.publishedProducts(publication, 'ru').every((p) => !('media' in p)));
  // Every published key has a bundled photo except the explicit no-photo key.
  assert.deepEqual(
    Object.keys(catalog.bundledCatalogImages).sort(),
    mockupCatalogDraft.products
      .map((p) => p.image_asset_key)
      .filter((key) => key !== 'generic-drink')
      .sort(),
  );
});

test('real bundled photos follow remote, then key, then logo; a changed key beats the id retouch', () => {
  const catalog = mobileCatalog();
  const menu = metroModule('apps/mobile/src/menu-photo-assets.ts').menuPhotos;
  const heroes = metroModule('apps/mobile/src/product-photo-assets.ts').photoHeroes;
  const contexts = {
    menu: { piko: asset('catalog-options/piko.png'), ...menu },
    hero: heroes,
  };
  const resolveWith = (products, id, context, variant = 'card') => {
    const product = products.find((p) => p.id === id);
    return productPhoto.resolveProductPhoto(
      product,
      product.media,
      variant,
      { byId: contexts[context], byKey: catalog.bundledCatalogImages, logo: catalog.catalogLogo },
      ORIGIN,
    );
  };
  const seeded = catalog.publishedProducts(storefront(), 'ru');
  // Unchanged seed keys keep today's look in every context.
  assert.equal(
    resolveWith(seeded, 'pick-combo', 'menu').source,
    asset('menu-light/pick-combo.png'),
  );
  assert.equal(
    resolveWith(seeded, 'pick-combo', 'hero').source,
    asset('catalog-hd/pick-combo.png'),
  );
  assert.equal(resolveWith(seeded, 'cola', 'menu').source, asset('catalog-hd/cola.png'));
  assert.equal(resolveWith(seeded, 'piko', 'menu').source, asset('catalog-options/piko.png'));
  assert.equal(resolveWith(seeded, 'piko', 'hero').source, asset('catalog-options/piko.png'));
  assert.equal(resolveWith(seeded, 'fingers', 'hero').source, heroes.fingers);

  // The back-office points pick-combo at the burger-combo photo and cola at no photo.
  const edited = catalog.publishedProducts(
    storefront(
      mockupCatalogDraft.products.map((p) =>
        p.id === 'pick-combo'
          ? { ...p, image_asset_key: 'i9.jpg' }
          : p.id === 'cola'
            ? { ...p, image_asset_key: 'generic-drink' }
            : p,
      ),
    ),
    'ru',
    { version: 6, products: { burger: media(sha('a')) } },
  );
  for (const context of ['menu', 'hero']) {
    const combo = resolveWith(edited, 'pick-combo', context);
    assert.deepEqual(combo, { kind: 'key', source: asset('catalog-hd/burger-combo.png') });
    assert.deepEqual(resolveWith(edited, 'cola', context), {
      kind: 'logo',
      source: resolve(assetRoot, 'logo.png'),
    });
  }
  // An uploaded photo wins everywhere and keeps the bundled photo as its offline fallback.
  const remote = resolveWith(edited, 'burger', 'menu');
  assert.equal(remote.kind, 'remote');
  assert.equal(remote.source.uri, `${ORIGIN}/v1/media/catalog/${sha('a')}.card.webp`);
  assert.equal(remote.fallback.source, asset('catalog-hd/burger.png'));
  assert.equal(
    resolveWith(edited, 'burger', 'hero', 'hero').source.uri,
    `${ORIGIN}/v1/media/catalog/${sha('b')}.hero.webp`,
  );
});
