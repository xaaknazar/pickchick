/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  projectCatalogMenu,
  localSelectionIds,
  localCatalogId,
} from '../../packages/menu-sync/dist/index.js';
import { mockupCatalogDraft } from '../../packages/catalog-admin/dist/seed.js';
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
