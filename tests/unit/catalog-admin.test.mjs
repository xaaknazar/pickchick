/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CatalogPayloadSchema,
  CatalogProductSchema,
  CatalogCredentialSchema,
  CatalogMediaMapSchema,
  CatalogMenuDeliverySchema,
  CatalogMenuRejectReasonSchema,
  CatalogStateSchema,
  CATALOG_MAX_PAYLOAD_BYTES,
  stripStorefrontPayload,
} from '../../packages/catalog-admin/dist/contracts.js';
import { MenuRejectReasonSchema } from '../../packages/contracts/dist/index.js';
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

const sha = 'a1'.repeat(32);
const imageRef = {
  asset_id: '20000000-0000-4000-8000-000000000001',
  sha256: sha,
  tile_color: '#FFC20E',
  cutout: true,
};
test('uploaded image ref is a strict content hash and never relaxes the bundled asset key', () => {
  const ok = copy();
  ok.products[0].image = imageRef;
  ok.products[0].kitchen_route = 'assembly_item';
  ok.products[1].image = { asset_id: imageRef.asset_id, sha256: sha };
  assert.equal(CatalogPayloadSchema.safeParse(ok).success, true);
  for (const change of [
    { image: { ...imageRef, sha256: 'A1'.repeat(32) } },
    { image: { ...imageRef, sha256: 'a1'.repeat(31) } },
    { image: { ...imageRef, sha256: `${'a1'.repeat(31)}zz` } },
    { image: { ...imageRef, asset_id: 'photo-1' } },
    { image: { ...imageRef, tile_color: '#ffc20e' } },
    { image: { ...imageRef, cutout: 'yes' } },
    { image: { ...imageRef, url: 'https://example.test/photo.webp' } },
    { image: { asset_id: imageRef.asset_id } },
    { kitchen_route: 'grill' },
    { image: imageRef, image_asset_key: 'https://example.test/photo.jpg' },
    { image: imageRef, image_asset_key: 'i3.jpg' },
    { image: imageRef, image_asset_key: 'i21.jpg' },
  ]) {
    const payload = copy();
    Object.assign(payload.products[0], change);
    assert.equal(CatalogPayloadSchema.safeParse(payload).success, false, JSON.stringify(change));
  }
  const missingKey = copy();
  missingKey.products[0].image = imageRef;
  delete missingKey.products[0].image_asset_key;
  assert.equal(CatalogPayloadSchema.safeParse(missingKey).success, false);
});
test('storefront payload strips unified-menu fields so installed strict clients still parse it', () => {
  // Strict copy of the product schema bundled in kiosk build 7 and the mobile TestFlight build.
  const OldProductSchema = CatalogProductSchema.omit({ image: true, kitchen_route: true });
  const payload = copy();
  payload.products[0].image = imageRef;
  payload.products[0].kitchen_route = 'prep';
  const before = structuredClone(payload);
  assert.equal(OldProductSchema.safeParse(payload.products[0]).success, false);
  const stripped = stripStorefrontPayload(CatalogPayloadSchema.parse(payload));
  assert.deepEqual(payload, before);
  for (const product of stripped.products) {
    assert.equal(OldProductSchema.safeParse(product).success, true);
    assert.equal('image' in product || 'kitchen_route' in product, false);
  }
  assert.equal(CatalogPayloadSchema.safeParse(stripped).success, true);
  assert.deepEqual({ ...stripped, products: [] }, { ...payload, products: [] });
  assert.deepEqual(stripped.products.slice(1), payload.products.slice(1));
  assert.equal(stripped.products[0].image_asset_key, payload.products[0].image_asset_key);
});
test('media map only references immutable hash-named variants of the catalog API', () => {
  const entry = {
    sha256: sha,
    card: `/v1/media/catalog/${sha}.card.webp`,
    hero: `/v1/media/catalog/${sha}.hero.webp`,
    thumb: `/v1/media/catalog/${sha}.thumb.webp`,
    tile_color: '#1A2B3C',
    cutout: false,
  };
  assert.equal(
    CatalogMediaMapSchema.safeParse({ version: 4, products: { 'pick-combo': entry } }).success,
    true,
  );
  for (const map of [
    { version: 0, products: {} },
    { version: 4, products: { 'Bad Id': entry } },
    { version: 4, products: { x: { ...entry, card: `/v1/media/catalog/${sha}.hero.webp` } } },
    { version: 4, products: { x: { ...entry, hero: `https://cdn.test/${sha}.hero.webp` } } },
    { version: 4, products: { x: { ...entry, thumb: `/v1/media/catalog/../${sha}.thumb.webp` } } },
    { version: 4, products: { x: { ...entry, extra: 1 } } },
  ])
    assert.equal(CatalogMediaMapSchema.safeParse(map).success, false, JSON.stringify(map));
});
test('back-office state reports rejected edge deliveries and per-channel publication support', () => {
  assert.deepEqual(CatalogMenuRejectReasonSchema.options, MenuRejectReasonSchema.options);
  const delivery = {
    catalog_version: 3,
    menu_version: 4,
    release_id: '30000000-0000-4000-8000-000000000001',
    device_id: '30000000-0000-4000-8000-000000000002',
    status: 'rejected',
    acknowledged_at: '2026-10-08T00:00:00.000Z',
    reject_reason: 'ROUTING_UNRESOLVED',
    edge_active_version: 3,
    observed_at: '2026-10-08T00:00:01.000Z',
  };
  assert.equal(CatalogMenuDeliverySchema.safeParse(delivery).success, true);
  assert.equal(
    CatalogMenuDeliverySchema.safeParse({ ...delivery, reject_reason: 'OTHER' }).success,
    false,
  );
  const legacy = { ...delivery };
  for (const key of ['reject_reason', 'edge_active_version', 'observed_at']) delete legacy[key];
  assert.equal(CatalogMenuDeliverySchema.safeParse({ ...legacy, status: 'applied' }).success, true);
  const state = {
    branch: { id: delivery.device_id, code: 'b1', name: 'Branch' },
    publication_support: { mobile: true, pos: true, kiosk: true },
    edge_delivery: delivery,
    draft: null,
    published: null,
  };
  assert.equal(CatalogStateSchema.safeParse(state).success, true);
  assert.equal(
    CatalogStateSchema.safeParse({
      ...state,
      publication_support: { mobile: false, pos: false, kiosk: false },
    }).success,
    true,
  );
});
