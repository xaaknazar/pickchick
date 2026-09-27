import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { testCompleteCatalog } from '../../packages/test-order-flow/dist/complete-catalog.js';
import { TestCompleteCatalogSchema } from '../../packages/test-order-flow/dist/contracts.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const assetRoot = resolve(root, 'design/prototype/assets/mockup');
const source = readFileSync(resolve(root, 'design/reference-source/kiosk.html.txt'), 'utf8');
const provenance = JSON.parse(readFileSync(resolve(assetRoot, 'provenance.json'), 'utf8'));

// Exercise the actual Metro literal mapping without loading React Native or an image decoder.
function mobileCatalog() {
  const filename = resolve(root, 'apps/mobile/src/catalog.ts');
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText;
  runInNewContext(compiled, {
    exports,
    require(id) {
      if (id === '@pickchick/test-order-flow/complete-catalog') return { testCompleteCatalog };
      assert.match(id, /\.(jpg|png)$/);
      const path = resolve(dirname(filename), id);
      assert(readFileSync(path).length > 0, `Metro asset exists: ${id}`);
      return path;
    },
  });
  return exports;
}

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
