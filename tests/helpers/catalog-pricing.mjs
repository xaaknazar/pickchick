/* global structuredClone */
import { randomUUID } from 'node:crypto';
import {
  catalogPayloadHash,
  priceCatalogSnapshot,
} from '../../packages/catalog-pricing/dist/index.js';
export const text = (ru) => ({ ru, kk: '' });
export const product = (id, overrides = {}) => ({
  id,
  sku: id.toUpperCase(),
  name: text(id),
  description: text(`Description ${id}`),
  category_id: 'food',
  price_minor: '101',
  image_asset_key: 'shot.jpg',
  available: true,
  prep_required: true,
  prep_minutes: 10,
  serving_label: text('150 г'),
  weight_g: 150,
  volume_ml: null,
  ingredients: text('Synthetic ingredients'),
  allergens: ['milk'],
  allergens_status: 'declared',
  nutrition_status: 'operator_entered',
  nutrition: { basis: 'per_serving', energy_kcal: 100, protein_g: 10, fat_g: 5, carbs_g: 15 },
  kind: 'item',
  combo_components: [],
  modifier_groups: [],
  ...overrides,
});
export const option = (id, overrides = {}) => ({
  id,
  label: text(id),
  price_delta_minor: '0',
  default_quantity: 0,
  max_quantity: 1,
  available: true,
  linked_product_id: null,
  ...overrides,
});
export const group = (options, overrides = {}) => ({
  id: 'side',
  title: text('Side'),
  min: 0,
  max: 2,
  options,
  ...overrides,
});
export function pricingFixture(products = [product('burger')]) {
  const scope = {
    organizationId: randomUUID(),
    branchId: randomUUID(),
    customerId: null,
    channel: 'mobile',
  };
  const payload = {
    schema_version: 1,
    currency: 'KZT',
    content_source: 'operator',
    content_reviewed: true,
    categories: [{ id: 'food', name: text('Food') }],
    products,
    estimated_minutes: { min: 5, max: 10 },
    upsell_product_ids: [],
  };
  const publication = {
    reference: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      version: 1,
      payloadHash: catalogPayloadHash(payload),
      publishedAt: '2026-09-07T00:00:00.000Z',
    },
    orderingEnabled: true,
    payload,
  };
  const cart = {
    catalog_version: 1,
    service_mode: 'takeaway',
    items: [{ sku: products[0].sku, quantity: 1, selections: [] }],
  };
  return {
    scope,
    publication,
    cart,
    price: (input = cart) => priceCatalogSnapshot(publication, scope, input),
    rehash: () => {
      publication.reference.payloadHash = catalogPayloadHash(publication.payload);
    },
    clone: () => structuredClone({ scope, publication, cart }),
  };
}
