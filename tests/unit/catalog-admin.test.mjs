/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CatalogPayloadSchema,
  CatalogCredentialSchema,
  CATALOG_MAX_PAYLOAD_BYTES,
} from '../../packages/catalog-admin/dist/contracts.js';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';
const copy = () => structuredClone(mockupCatalogDraft);
test('source draft preserves all 24 economic records and source images without inheriting TEST authority or verified claims', () => {
  assert.equal(mockupCatalogDraft.products.length, 24);
  assert.equal(mockupCatalogDraft.content_reviewed, false);
  assert.equal(mockupCatalogDraft.content_source, 'mockup');
  for (const field of ['synthetic', 'namespace', 'branch_id', 'catalog_version'])
    assert.equal(field in mockupCatalogDraft, false);
  for (const product of mockupCatalogDraft.products) {
    const source = testCompleteCatalog.products.find((v) => v.id === product.id);
    assert.equal(product.price_minor, source.price_minor);
    assert.equal(product.image_asset_key, source.image_id);
    assert.deepEqual(product.nutrition, source.nutrition);
    assert.equal(product.nutrition_status, 'unverified');
    assert.equal(product.allergens_status, 'unknown');
    assert.equal(product.name.kk, '');
    assert.equal(product.modifier_groups.length, source.modifier_groups.length);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(mockupCatalogDraft)) < CATALOG_MAX_PAYLOAD_BYTES);
});
test('validated catalog rejects broken modifier defaults, missing references and cycles before persistence', () => {
  const invalid = [
    (p) => p.products.push(structuredClone(p.products[0])),
    (p) => {
      p.products[1].sku = p.products[0].sku;
    },
    (p) => {
      p.products[0].category_id = 'missing';
    },
    (p) => {
      p.upsell_product_ids = ['missing'];
    },
    (p) => {
      p.products[0].modifier_groups[0].options[0].default_quantity = 2;
    },
    (p) => {
      p.products[0].modifier_groups[0].options[0].available = false;
    },
    (p) => {
      p.products[0].modifier_groups[0].min = 99;
    },
    (p) => {
      p.products[0].modifier_groups[0].options[0].linked_product_id = 'missing';
    },
    (p) => {
      p.products[0].modifier_groups[0].options[0].linked_product_id = p.products[0].id;
    },
    (p) => {
      p.products[0].kind = 'combo';
      p.products[1].kind = 'combo';
      p.products[0].combo_components = [{ product_id: p.products[1].id, quantity: 1 }];
      p.products[1].combo_components = [{ product_id: p.products[0].id, quantity: 1 }];
    },
  ];
  for (const mutate of invalid) {
    const payload = copy();
    mutate(payload);
    assert.equal(CatalogPayloadSchema.safeParse(payload).success, false);
  }
});
test('money is a decimal integer string, weight is integral, media is an allowed asset key and bilingual content can be edited', () => {
  for (const change of [
    { price_minor: '4190.00' },
    { price_minor: '-1' },
    { price_minor: 419000 },
    { weight_g: 2.5 },
    { nutrition: { ...mockupCatalogDraft.products[0].nutrition, protein_g: -1 } },
    { image_asset_key: 'https://example.test/photo.jpg' },
    { image_asset_key: 'i3.jpg' },
    { image_asset_key: 'i21.jpg' },
  ]) {
    const payload = copy();
    Object.assign(payload.products[0], change);
    assert.equal(CatalogPayloadSchema.safeParse(payload).success, false);
  }
  const payload = copy();
  Object.assign(payload.products[0], {
    price_minor: '429000',
    weight_g: 550,
    name: { ru: 'Новое имя', kk: 'Жаңа атау' },
    description: { ru: 'Описание оператора', kk: 'Сипаттама' },
    nutrition_status: 'operator_entered',
  });
  const saved = CatalogPayloadSchema.parse(payload);
  assert.equal(saved.products[0].name.kk, 'Жаңа атау');
  assert.equal(saved.products[0].price_minor, '429000');
  assert.equal(CatalogCredentialSchema.safeParse({}).success, false);
});
