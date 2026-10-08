/* global structuredClone */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  projectCatalogMenu,
  localSelectionIds,
  localCatalogId,
  CatalogProjectionError,
  canonicalJson,
} from '../../packages/menu-sync/dist/index.js';
import { MenuSnapshotSchema } from '../../packages/contracts/dist/index.js';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
import { previewId } from '../../scripts/local-pos-draft.mjs';
const branch = '10000000-0000-4000-8000-000000000003';
const at = '2026-10-04T00:00:00.000Z';
test('common catalog projection preserves POS stop identities, prices and modifier constraints', () => {
  const menu = projectCatalogMenu(mockupCatalogDraft, branch, 3, at);
  for (const product of mockupCatalogDraft.products) {
    const identities = localSelectionIds(
      branch,
      product.id,
      product.modifier_groups.flatMap((g) =>
        g.options.map((o) => ({ group_id: g.id, option_id: o.id })),
      ),
    );
    const item = menu.items.find((i) => i.variant_id === identities[0]);
    assert.equal(item.price_minor, product.price_minor);
    assert.deepEqual(
      item.modifier_groups.flatMap((g) => g.options.map((o) => o.id)),
      identities.slice(1),
    );
    product.modifier_groups.forEach((g, index) => {
      assert.equal(item.modifier_groups[index].min_selected, g.min);
      assert.equal(item.modifier_groups[index].max_selected, g.max);
      assert.deepEqual(
        item.modifier_groups[index].options.map((o) => o.price_minor),
        g.options.map((o) => o.price_delta_minor),
      );
    });
  }
});
test('differential channel prices fail projection before publication', () => {
  const payload = structuredClone(mockupCatalogDraft);
  payload.products[0].channel_prices_minor = { mobile: '12300' };
  assert.throws(() => projectCatalogMenu(payload, branch, 1, at), /CHANNEL_PRICES_NOT_SUPPORTED/);
  assert.throws(
    () => projectCatalogMenu(payload, branch, 1, at),
    (error) =>
      error instanceof CatalogProjectionError &&
      error.code === 'CHANNEL_PRICES_NOT_SUPPORTED' &&
      error.message === 'CHANNEL_PRICES_NOT_SUPPORTED',
  );
});
test('an available option linked to an unavailable product fails with a typed projection error', () => {
  const payload = structuredClone(mockupCatalogDraft);
  const linked = payload.products.find((p) => p.id !== payload.products[0].id);
  linked.available = false;
  payload.products[0].modifier_groups[0].options[0].linked_product_id = linked.id;
  assert.throws(
    () => projectCatalogMenu(payload, branch, 1, at),
    (error) =>
      error instanceof CatalogProjectionError && error.code === 'UNAVAILABLE_LINKED_PRODUCT',
  );
});
test('unavailable products are excluded without changing stable identities', () => {
  const payload = structuredClone(mockupCatalogDraft);
  payload.products[0].available = false;
  const menu = projectCatalogMenu(payload, branch, 1, at);
  assert.equal(
    menu.items.some(
      (i) => i.variant_id === localSelectionIds(branch, payload.products[0].id, [])[0],
    ),
    false,
  );
});

test('all reviewed default baskets have identical mobile, kiosk and installed POS totals', async () => {
  const { priceCart } = await import('../../packages/local-orders/dist/pricing.js');
  const { priceCatalogSnapshot, catalogPayloadHash } =
    await import('../../packages/catalog-pricing/dist/index.js');
  const payload = structuredClone(mockupCatalogDraft);
  payload.content_reviewed = true;
  const menu = projectCatalogMenu(payload, branch, 1, at);
  const org = '10000000-0000-4000-8000-000000000001';
  const publication = {
    reference: {
      organizationId: org,
      branchId: branch,
      version: 1,
      payloadHash: catalogPayloadHash(payload),
      publishedAt: at,
    },
    orderingEnabled: true,
    payload,
  };
  for (const product of payload.products) {
    const selections = product.modifier_groups.flatMap((g) =>
      g.options
        .filter((o) => o.default_quantity > 0)
        .map((o) => ({ group_id: g.id, option_id: o.id, quantity: o.default_quantity })),
    );
    const cart = {
      catalog_version: 1,
      service_mode: 'takeaway',
      items: [{ sku: product.sku, quantity: 2, selections }],
    };
    const mobile = priceCatalogSnapshot(
      publication,
      { organizationId: org, branchId: branch, customerId: null, channel: 'mobile' },
      cart,
    );
    const kiosk = priceCatalogSnapshot(
      publication,
      { organizationId: org, branchId: branch, customerId: null, channel: 'kiosk' },
      cart,
    );
    const item = menu.items.find(
      (i) => i.variant_id === localSelectionIds(branch, product.id, [])[0],
    );
    const modifiers = selections.map((s) => ({
      group_id: localCatalogId(branch, 'modifier-group', `${product.id}:${s.group_id}`),
      option_id: localCatalogId(
        branch,
        'modifier-option',
        `${product.id}:${s.group_id}:${s.option_id}`,
      ),
      quantity: s.quantity,
    }));
    const pos = priceCart(menu, {
      release_id: menu.release_id,
      service_mode: 'takeaway',
      items: [{ variant_id: item.variant_id, quantity: 2, modifiers }],
    });
    assert.equal(mobile.totalMinor, kiosk.totalMinor, product.sku);
    assert.equal(mobile.totalMinor, pos.total_minor, product.sku);
  }
});

const menuRelease = '30000000-0000-4000-8000-000000000001';
const posV2 = JSON.parse(
  readFileSync(new URL('../../infra/windows/local-pos-draft-catalog-v2.json', import.meta.url)),
);
// Rebuilds the installed POS v2 items exactly as scripts/local-pos-catalog-upgrade.mjs does.
const posV2Items = (branchId) =>
  posV2.products.map((product) => ({
    product_id: previewId(branchId, 'product', product.source_id),
    variant_id: previewId(branchId, 'base-preview', product.source_id),
    category_id: previewId(branchId, 'category', product.category),
    price_minor: product.price_minor,
    ...(product.image_url ? { image_url: product.image_url } : {}),
    modifier_groups: product.modifier_groups.map((group) => ({
      id: previewId(branchId, 'modifier-group', `${product.source_id}:${group.source_id}`),
      min_selected: group.min_selected,
      max_selected: group.max_selected,
      options: group.options.map((option) => ({
        id: previewId(
          branchId,
          'modifier-option',
          `${product.source_id}:${group.source_id}:${option.source_id}`,
        ),
        price_minor: option.price_minor,
        max_quantity: option.max_quantity,
        default_quantity: option.default_quantity,
        available: option.available,
      })),
    })),
  }));
const legacyView = (item) => ({
  product_id: item.product_id,
  variant_id: item.variant_id,
  category_id: item.category_id,
  price_minor: item.price_minor,
  ...(item.image_url ? { image_url: item.image_url } : {}),
  modifier_groups: (item.modifier_groups ?? []).map((group) => ({
    id: group.id,
    min_selected: group.min_selected,
    max_selected: group.max_selected,
    options: group.options.map((option) => ({
      id: option.id,
      price_minor: option.price_minor,
      max_quantity: option.max_quantity,
      default_quantity: option.default_quantity,
      available: option.available,
    })),
  })),
});

test('seed publication keeps ids, prices, options and photos byte-identical to installed POS v2', () => {
  for (const branchId of [branch, '10000000-0000-4000-8000-0000000000aa']) {
    const menu = projectCatalogMenu(mockupCatalogDraft, branchId, 3, at);
    const expected = posV2Items(branchId);
    assert.equal(menu.items.length, expected.length);
    assert.equal(canonicalJson(menu.items.map(legacyView)), canonicalJson(expected));
    // Category ids keep the RU-name hash used by POS v2 and local stops.
    assert.deepEqual(
      new Set(menu.categories.map((c) => c.id)),
      new Set(posV2.products.map((p) => previewId(branchId, 'category', p.category))),
    );
  }
});

test('publication carries optional unified-menu fields without changing schema_version 1', () => {
  const menu = projectCatalogMenu(mockupCatalogDraft, branch, 3, at);
  assert.equal(menu.schema_version, 1);
  assert.deepEqual(
    menu.categories.map((c) => [c.source_id, c.sort_order, c.name.ru]),
    mockupCatalogDraft.categories.map((c, index) => [c.id, index, c.name.ru]),
  );
  for (const category of menu.categories)
    assert.equal(category.id, localCatalogId(branch, 'category', category.name.ru));
  mockupCatalogDraft.products.forEach((product, index) => {
    const item = menu.items.find((i) => i.source_id === product.id);
    assert.equal(item.variant_id, localCatalogId(branch, 'base-preview', product.id));
    assert.equal(item.sku, product.sku);
    assert.equal(item.kind, product.kind);
    assert.equal(item.sort_order, index);
    assert.equal(item.kitchen.route, product.prep_required ? 'prep' : 'assembly_item');
    assert.equal(
      item.kitchen.unexpanded_combo,
      product.kind !== 'item' && product.combo_components.length === 0
        ? 'whole_product'
        : undefined,
    );
    assert.equal(item.image, undefined);
    assert.ok(menu.categories.some((c) => c.id === item.category_id));
  });
  // A re-parse is a no-op, so the stored canonical payload and checksum stay stable.
  assert.equal(canonicalJson(MenuSnapshotSchema.parse(menu)), canonicalJson(menu));
});

test('uploaded photo and explicit kitchen route override only the new fields', () => {
  const payload = structuredClone(mockupCatalogDraft);
  const sha = 'ab'.repeat(32);
  payload.products[0].image = {
    asset_id: '20000000-0000-4000-8000-000000000001',
    sha256: sha,
    tile_color: '#FFC20E',
    cutout: true,
  };
  payload.products[0].kitchen_route = 'assembly_item';
  payload.products[0].description = { ru: 'Описание', kk: '' };
  const base = projectCatalogMenu(mockupCatalogDraft, branch, 3, at, menuRelease);
  const menu = projectCatalogMenu(payload, branch, 3, at, menuRelease);
  const item = menu.items[0];
  assert.deepEqual(item.image, { sha256: sha, url: `/assets/menu/${sha}.webp` });
  assert.equal(item.image_url, `/assets/menu/${sha}.webp`);
  assert.equal(item.kitchen.route, 'assembly_item');
  assert.deepEqual(item.description, { ru: 'Описание', kk: '' });
  assert.deepEqual(base.items[0].description, mockupCatalogDraft.products[0].description);
  payload.products[0].description = { ru: '  ', kk: 'Сипаттама' };
  assert.equal(projectCatalogMenu(payload, branch, 3, at).items[0].description, undefined);
  assert.equal(item.variant_id, base.items[0].variant_id);
  assert.equal(item.price_minor, base.items[0].price_minor);
  assert.equal(canonicalJson(menu.items.slice(1)), canonicalJson(base.items.slice(1)));
});
test('menu snapshot schema keeps the new fields consistent', () => {
  const menu = projectCatalogMenu(mockupCatalogDraft, branch, 3, at, menuRelease);
  const sha = 'cd'.repeat(32);
  const broken = [
    (m) => m.categories.pop(),
    (m) => m.categories.push(structuredClone(m.categories[0])),
    (m) => (m.categories = Array.from({ length: 201 }, () => m.categories[0])),
    (m) => (m.schema_version = 2),
    (m) => (m.items[0].image = { sha256: sha, url: `/assets/menu/${'ef'.repeat(32)}.webp` }),
    (m) => (m.items[0].image = { sha256: sha, url: `/assets/menu/${sha}.webp` }),
    (m) => (m.items[0].image = { sha256: sha.toUpperCase(), url: `/assets/menu/${sha}.webp` }),
    (m) => (m.items[0].kitchen = { route: 'grill' }),
    (m) => (m.items[0].kitchen = { route: 'prep', unexpanded_combo: 'expand' }),
    (m) => (m.items[0].kitchen.extra = true),
    (m) => (m.items[0].source_id = 'Bad Slug'),
    (m) => (m.items[0].kind = 'duo'),
    (m) => (m.items[0].sort_order = -1),
    (m) => (m.items[0].description = { ru: ' ', kk: '' }),
    (m) => (m.categories[0].source_id = 'Bad Slug'),
  ];
  for (const mutate of broken) {
    const copy = structuredClone(menu);
    mutate(copy);
    assert.equal(MenuSnapshotSchema.safeParse(copy).success, false, mutate.toString());
  }
  const withImage = structuredClone(menu);
  withImage.items[0].image = { sha256: sha, url: `/assets/menu/${sha}.webp` };
  withImage.items[0].image_url = `/assets/menu/${sha}.webp`;
  assert.equal(MenuSnapshotSchema.safeParse(withImage).success, true);
  // Older publications without any of the optional fields remain valid.
  const legacy = structuredClone(menu);
  delete legacy.categories;
  for (const item of legacy.items)
    for (const key of ['source_id', 'sku', 'kind', 'sort_order', 'description', 'kitchen'])
      delete item[key];
  assert.equal(MenuSnapshotSchema.safeParse(legacy).success, true);
});
