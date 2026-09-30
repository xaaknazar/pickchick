import assert from 'node:assert/strict';
import test from 'node:test';
import { mockupCatalogDraft } from '@pickchick/catalog-admin/seed';
import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';
import { approvedMobileCatalog } from '../../scripts/build-approved-mobile-catalog.mjs';

test('commercial snapshot preserves every visible mobile price and modifier rule', () => {
  const catalog = approvedMobileCatalog();
  assert.equal(catalog.content_source, 'operator');
  assert.equal(catalog.content_reviewed, true);
  assert.equal(catalog.products.length, testCompleteCatalog.products.length);
  for (const item of testCompleteCatalog.products) {
    const product = catalog.products.find((p) => p.id === item.id);
    assert.equal(product.price_minor, item.price_minor);
    assert.equal(product.nutrition_status, 'unverified');
    assert.equal(product.allergens_status, 'unknown');
    assert.deepEqual(
      product.modifier_groups.map((g) => ({
        ...g,
        title: g.title.ru,
        options: g.options.map(({ linked_product_id, label, ...o }) => {
          assert.equal(linked_product_id, null);
          return { ...o, label: label.ru };
        }),
      })),
      item.modifier_groups,
    );
  }
});
test('an unapproved price or option change cannot be published under the earlier approval', () => {
  for (const mutate of [
    (p) => (p.price_minor = '10000'),
    (p) => (p.modifier_groups[0].options[0].price_delta_minor = '0'),
    (p) => (p.modifier_groups[0].min = 0),
  ]) {
    const changed = globalThis.structuredClone(mockupCatalogDraft);
    mutate(changed.products[0]);
    // The second mutation needs an actual different supplement.
    if (JSON.stringify(changed) === JSON.stringify(mockupCatalogDraft))
      changed.products[0].modifier_groups[0].options[0].price_delta_minor = '100';
    assert.throws(() => approvedMobileCatalog(changed), /Mobile menu changed/);
  }
});
