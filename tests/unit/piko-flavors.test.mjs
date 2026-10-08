/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { withPikoFlavors } from '../../packages/catalog-admin/dist/piko-flavors.js';

test('Piko flavors preserve SKU, all prices, other products and immutable input', () => {
  const input = structuredClone(mockupCatalogDraft);
  const piko = input.products.find((product) => product.id === 'piko');
  piko.channel_prices_minor = { kiosk: '55000', mobile: '61000' };
  const original = structuredClone(input);
  const result = withPikoFlavors(input);
  assert.deepEqual(input, original);
  assert.equal(result.products.length, input.products.length);
  for (const product of result.products) {
    const before = input.products.find((p) => p.id === product.id);
    assert.deepEqual({ ...product, modifier_groups: [] }, { ...before, modifier_groups: [] });
    if (product.id !== 'piko' && !before.modifier_groups.some((g) => g.id === 'drink'))
      assert.deepEqual(product, before);
  }
  const flavor = result.products.find((p) => p.id === 'piko').modifier_groups[0];
  assert.equal(flavor.min, 1);
  assert.equal(flavor.max, 1);
  assert.deepEqual(
    flavor.options.map((o) => [o.id, o.price_delta_minor]),
    [
      ['piko-apple', '0'],
      ['piko-orange', '0'],
    ],
  );
  assert.deepEqual(withPikoFlavors(result), result);
});

test('combo choices retain surcharge, availability and defaults when expanding Piko', () => {
  const input = structuredClone(mockupCatalogDraft);
  const group = input.products[0].modifier_groups.find((g) => g.id === 'drink');
  group.options.forEach((option) => {
    option.default_quantity = 0;
  });
  const piko = group.options.find((o) => o.id === 'piko');
  piko.price_delta_minor = '23000';
  piko.default_quantity = 1;
  const result = withPikoFlavors(input);
  const options = result.products[0].modifier_groups.find((g) => g.id === 'drink').options;
  assert(!options.some((o) => o.id === 'piko'));
  for (const id of ['piko-apple', 'piko-orange']) {
    const option = options.find((o) => o.id === id);
    assert.equal(option.price_delta_minor, '23000');
    assert.equal(option.available, piko.available);
    assert.equal(option.linked_product_id, piko.linked_product_id);
  }
  assert.equal(
    options.reduce((n, o) => n + o.default_quantity, 0),
    1,
  );
  assert.deepEqual(
    options.filter((o) => !o.id.startsWith('piko-')),
    group.options.filter((o) => o.id !== 'piko'),
  );
});

test('ambiguous existing flavor configuration and wrong volume are rejected', () => {
  const input = structuredClone(mockupCatalogDraft);
  input.products.find((p) => p.id === 'piko').volume_ml = 1000;
  assert.throws(() => withPikoFlavors(input), /200 ml/);
  const mixed = structuredClone(mockupCatalogDraft);
  const group = mixed.products[0].modifier_groups.find((g) => g.id === 'drink');
  group.options.push({ ...group.options.find((o) => o.id === 'piko'), id: 'piko-apple' });
  assert.throws(() => withPikoFlavors(mixed), /Mixed Piko/);
});
