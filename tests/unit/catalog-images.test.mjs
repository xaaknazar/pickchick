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
import { pikoFlavors } from '../../packages/catalog-admin/dist/piko-flavors.js';
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
      if (id === './drink-photos') return metroModule('apps/mobile/src/drink-photos.ts');
      assert.match(id, /\.(jpg|png)$/);
      const path = resolve(dirname(filename), id);
      assert(readFileSync(path).length > 0, `Metro asset exists: ${id}`);
      return path;
    },
  });
  return exports;
}
const mobileCatalog = () => metroModule('apps/mobile/src/catalog.ts');

test('burger, tea and water retain original provenance; mobile shows HD retouches and owner water', () => {
  const mobile = mobileCatalog().connectedProducts(testCompleteCatalog);
  const bundled = {
    burger: 'catalog-hd/burger.png',
    'iced-tea': 'catalog-hd/iced-tea.png',
    water: 'drinks/bonaqua-still.png',
  };
  for (const [id, file] of Object.entries(bundled)) {
    const product = testCompleteCatalog.products.find((item) => item.id === id);
    assert(product);
    const original = source.split('\n').find((line) => line.includes(`name: '${product.name}'`));
    assert(original, `original kiosk product: ${product.name}`);
    const filename = original.match(/img: 'offline\/([^']+)'/)?.[1];
    assert(filename);
    assert.equal(product.image_id, filename);
    const imagePath = resolve(assetRoot, filename);
    const retouch = resolve(root, 'apps/mobile/assets', file);
    assert.equal(mobile.find((item) => item.id === id)?.image, retouch);
    assert.deepEqual(
      [...readFileSync(retouch).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
      'bundled PNG',
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
  const ownerDrinks = {
    'fuse-peach': asset('drinks/fuse-peach.png'),
    water: asset('drinks/bonaqua-still.png'),
    piko: asset('drinks/piko-apple.png'),
  };
  for (const product of products) {
    const source = mockupCatalogDraft.products.find((item) => item.id === product.id);
    assert.equal(product.imageKey, source.image_asset_key);
    assert.equal(product.imageKey, productPhoto.seedImageKey(product.id));
    assert.equal(
      product.image,
      ownerDrinks[product.id] ?? catalog.bundledCatalogImages[source.image_asset_key],
    );
  }
  // The same owner photos in the legacy TEST / design catalog.
  for (const product of catalog.connectedProducts(testCompleteCatalog))
    if (ownerDrinks[product.id]) assert.equal(product.image, ownerDrinks[product.id]);
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

// Mirrors apps/mobile/src/components/ProductPhoto.tsx (React Native cannot load under Node).
function photoContexts() {
  const catalog = mobileCatalog();
  const menu = metroModule('apps/mobile/src/menu-photo-assets.ts').menuPhotos;
  const heroes = metroModule('apps/mobile/src/product-photo-assets.ts').photoHeroes;
  const owner = metroModule('apps/mobile/src/drink-photos.ts').ownerDrinkPhotos;
  const contexts = { menu, hero: heroes, extra: { ...heroes, ...menu } };
  const resolveWith = (products, id, context, variant = 'card') => {
    const product = products.find((p) => p.id === id);
    return productPhoto.resolveProductPhoto(
      product,
      product.media,
      variant,
      {
        owner,
        byId: contexts[context],
        byKey: catalog.bundledCatalogImages,
        logo: catalog.catalogLogo,
      },
      ORIGIN,
    );
  };
  return { catalog, heroes, resolveWith };
}

test('real bundled photos follow remote, then key, then logo; a changed key beats the id retouch', () => {
  const { catalog, heroes, resolveWith } = photoContexts();
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
  assert.equal(resolveWith(seeded, 'fingers', 'hero').source, heroes.fingers);
  // Drinks with the owner's photo show it in every context, not the earlier generated render.
  for (const context of ['menu', 'hero', 'extra']) {
    assert.equal(resolveWith(seeded, 'cola', context).source, asset('catalog-hd/cola.png'));
    for (const [id, file] of [
      ['fuse-peach', 'fuse-peach'],
      ['water', 'bonaqua-still'],
      ['piko', 'piko-apple'],
    ])
      assert.deepEqual(resolveWith(seeded, id, context), {
        kind: 'id',
        source: asset(`drinks/${file}.png`),
      });
  }

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

// The owner's photographs (2026-10-08): mobile file -> byte-identical kiosk/reference source.
const OWNER_DRINK_FILES = {
  'fuse-peach': 'apps/kiosk/assets/drinks/fuse-peach.png',
  'fuse-mango-chamomile': 'apps/kiosk/assets/drinks/fuse-mango-chamomile.png',
  'fuse-mango-pineapple':
    'docs/operations/images/kiosk-drink-photos/reference-only/fuse-mango-pineapple.png',
  'bonaqua-still': 'apps/kiosk/assets/drinks/bonaqua-still.png',
  'cola-classic': 'apps/kiosk/assets/drinks/cola-classic.png',
  'cola-zero': 'apps/kiosk/assets/drinks/cola-zero.png',
  sprite: 'apps/kiosk/assets/drinks/sprite.png',
  fanta: 'apps/kiosk/assets/drinks/fanta.png',
  'piko-apple': 'apps/kiosk/assets/drinks/piko-apple.png',
  'piko-orange': 'apps/kiosk/assets/drinks/piko-orange.png',
};
// Catalog product / drink option id -> owner photo. Cans never get a bottle photo.
const OWNER_DRINK_IDS = {
  'fuse-peach': 'fuse-peach',
  'fuse-mango': 'fuse-mango-chamomile',
  'fuse-mango-pineapple': 'fuse-mango-pineapple',
  water: 'bonaqua-still',
  'cola-bottle': 'cola-classic',
  'cola-zero': 'cola-zero',
  sprite: 'sprite',
  fanta: 'fanta',
  piko: 'piko-apple',
  'piko-apple': 'piko-apple',
  'piko-orange': 'piko-orange',
};
const NO_OWNER_PHOTO = [
  'cola',
  'cola-can',
  'cola-zero-can',
  'sprite-can',
  'fanta-can',
  'fuse-berry',
  'fuse-watermelon',
  'fuse-strawberry-melon',
  'fuse-lemon',
  'lemonade',
  'iced-tea',
];
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('owner drink photos are byte-identical copies of the kiosk photos and mapped by id', () => {
  const kioskProvenance = JSON.parse(
    readFileSync(resolve(root, 'apps/kiosk/assets/drinks/provenance.json'), 'utf8'),
  );
  for (const [name, source] of Object.entries(OWNER_DRINK_FILES)) {
    const copy = asset(`drinks/${name}.png`);
    const evidence = kioskProvenance.photos.find((photo) => photo.name === name);
    assert.equal(evidence?.output, source, name);
    assert.equal(digest(copy), digest(resolve(root, source)), `${name} is a byte-identical copy`);
    assert.equal(digest(copy), evidence.output_sha256, `${name} matches its provenance`);
  }
  const owner = metroModule('apps/mobile/src/drink-photos.ts').ownerDrinkPhotos;
  assert.deepEqual(
    { ...owner }, // copied out of the VM context, whose Object prototype differs
    Object.fromEntries(
      Object.entries(OWNER_DRINK_IDS).map(([id, name]) => [id, asset(`drinks/${name}.png`)]),
    ),
  );
  assert.deepEqual([...productPhoto.ownerDrinkPhotoIds].sort(), Object.keys(owner).sort());
  for (const id of NO_OWNER_PHOTO) assert.equal(Object.hasOwn(owner, id), false, id);

  const { photoHeroes, optionPhotos } = metroModule('apps/mobile/src/product-photo-assets.ts');
  const catalog = mobileCatalog();
  // Combo drink choices: every owner id uses its photo; the others keep their earlier image.
  for (const [id, name] of Object.entries(OWNER_DRINK_IDS))
    assert.equal(optionPhotos[id], asset(`drinks/${name}.png`), `option ${id}`);
  assert.equal(optionPhotos['cola-can'], asset('catalog-hd/cola.png'));
  assert.equal(optionPhotos.lemonade, asset('catalog-hd/lemonade.png'));
  assert.equal(optionPhotos['iced-tea-sweet'], asset('catalog-hd/iced-tea.png'));
  assert.equal(optionPhotos['fuse-berry'], asset('catalog-cutouts/fuse-berry.png'));
  assert.equal(optionPhotos['fuse-watermelon'], asset('catalog-cutouts/fuse-watermelon.png'));
  const drinkOptions = testCompleteCatalog.products.flatMap((product) =>
    product.modifier_groups
      .filter((group) => group.id === 'drink')
      .flatMap((group) => group.options.map((option) => option.id)),
  );
  assert.ok(drinkOptions.length > 0);
  for (const id of [...drinkOptions, ...pikoFlavors.map((flavor) => flavor.id)])
    assert.ok(optionPhotos[id], `drink option ${id} has a photo`);
  // Product heroes and the published keys of the seeded Fuse peach and Bonaqua.
  assert.equal(photoHeroes['fuse-peach'], asset('drinks/fuse-peach.png'));
  assert.equal(photoHeroes.water, asset('drinks/bonaqua-still.png'));
  assert.equal(photoHeroes.piko, asset('drinks/piko-apple.png'));
  assert.equal(photoHeroes.cola, asset('catalog-hd/cola.png'));
  assert.equal(catalog.bundledCatalogImages['i1.jpg'], asset('drinks/fuse-peach.png'));
  assert.equal(catalog.bundledCatalogImages['i23.jpg'], asset('drinks/bonaqua-still.png'));
  assert.equal(catalog.bundledCatalogImages['i2.jpg'], asset('catalog-hd/cola.png'));
  // The replaced generated renders and placeholders are no longer bundled anywhere.
  const replaced = new Set([
    asset('catalog-options/piko.png'),
    asset('catalog-hd/water.png'),
    ...['cola-bottle', 'cola-zero', 'fanta', 'sprite', 'fuse-peach', 'fuse-mango'].map((id) =>
      asset(`catalog-cutouts/${id}.png`),
    ),
  ]);
  for (const map of [photoHeroes, optionPhotos, catalog.bundledCatalogImages])
    for (const [id, file] of Object.entries(map))
      assert.equal(replaced.has(file), false, `${id} no longer uses ${file}`);
});

test('back-office drinks with owner photo ids show it under the generic drink key', () => {
  const { catalog, resolveWith } = photoContexts();
  const water = mockupCatalogDraft.products.find((p) => p.id === 'water');
  const added = [...Object.keys(OWNER_DRINK_IDS), ...NO_OWNER_PHOTO]
    .filter((id) => !mockupCatalogDraft.products.some((p) => p.id === id))
    .map((id) => ({ ...water, id, sku: id, image_asset_key: 'generic-drink' }));
  assert.ok(added.some((p) => p.id === 'sprite-can') && added.some((p) => p.id === 'cola-bottle'));
  const products = (overrides = {}, map = undefined) =>
    catalog.publishedProducts(
      storefront(
        [...mockupCatalogDraft.products, ...added].map((p) =>
          overrides[p.id] ? { ...p, image_asset_key: overrides[p.id] } : p,
        ),
      ),
      'ru',
      map,
    );
  const published = products();
  const logo = resolve(assetRoot, 'logo.png');
  for (const { id } of added) {
    const expected = OWNER_DRINK_IDS[id] ? asset(`drinks/${OWNER_DRINK_IDS[id]}.png`) : logo;
    assert.equal(published.find((p) => p.id === id).image, expected, `${id} image`);
    for (const context of ['menu', 'hero', 'extra'])
      assert.deepEqual(
        resolveWith(published, id, context),
        { kind: OWNER_DRINK_IDS[id] ? 'id' : 'logo', source: expected },
        `${id} ${context}`,
      );
  }
  // Seeded drinks set to the generic key keep the owner photo; the can keeps no bottle photo.
  const generic = products({ water: 'generic-drink', 'fuse-peach': 'generic-drink' });
  assert.equal(resolveWith(generic, 'water', 'menu').source, asset('drinks/bonaqua-still.png'));
  assert.equal(resolveWith(generic, 'fuse-peach', 'hero').source, asset('drinks/fuse-peach.png'));
  // Any other chosen key is a back-office decision and wins over the id photo.
  const chosen = products({ sprite: 'i0.jpg', water: 'i22.jpg' });
  assert.deepEqual(resolveWith(chosen, 'sprite', 'menu'), {
    kind: 'key',
    source: asset('catalog-hd/lemonade.png'),
  });
  assert.equal(chosen.find((p) => p.id === 'sprite').image, asset('catalog-hd/lemonade.png'));
  assert.equal(resolveWith(chosen, 'water', 'hero').source, asset('catalog-hd/iced-tea.png'));
  // An uploaded back-office photo still wins, with the owner photo as its offline fallback.
  const uploaded = products({}, { version: 6, products: { sprite: media(sha('a')) } });
  for (const context of ['menu', 'hero']) {
    const photo = resolveWith(uploaded, 'sprite', context);
    assert.equal(photo.kind, 'remote');
    assert.equal(photo.source.uri, `${ORIGIN}/v1/media/catalog/${sha('a')}.card.webp`);
    assert.deepEqual(photo.fallback, { kind: 'id', source: asset('drinks/sprite.png') });
  }
});
