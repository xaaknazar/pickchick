import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { digest } from '@pickchick/edge-fulfillment';
import { approvedMobileCatalog } from '../../scripts/build-approved-mobile-catalog.mjs';
import { previewId } from '../../scripts/local-pos-draft.mjs';
import { mobileKitchenRouting } from '../../scripts/build-mobile-kitchen-routing.mjs';

test('mobile routing preserves every POS route and uses each installed station without guessing', () => {
  const branch = randomUUID(),
    prep = randomUUID(),
    assembly = randomUUID();
  const products = approvedMobileCatalog().products;
  const current = {
    version: 1,
    assemblyStationId: assembly,
    routes: products.map((p, index) => ({
      productId: previewId(branch, 'product', p.id),
      stationId: index % 2 ? prep : assembly,
      kind: index % 2 ? 'prep' : 'assembly_item',
    })),
  };
  const before = JSON.parse(JSON.stringify(current));
  const result = mobileKitchenRouting(branch, current, digest(current));
  assert.deepEqual(current, before);
  assert.equal(result.version, 2);
  assert.equal(result.routes.length, 48);
  assert.deepEqual(result.routes.slice(0, 24), before.routes);
  for (const [i, product] of products.entries()) {
    const mapped = result.routes[24 + i];
    assert.equal(mapped.productId, product.id);
    assert.equal(mapped.stationId, before.routes[i].stationId);
    assert.equal(mapped.kind, before.routes[i].kind);
    assert.equal(mapped.unexpandedCombo, product.kind === 'item' ? undefined : 'whole_product');
  }
  assert.throws(() => mobileKitchenRouting(randomUUID(), current, digest(current)), /no matching/);
  assert.throws(() => mobileKitchenRouting(branch, current, '0'.repeat(64)), /changed/);
  assert.throws(() => mobileKitchenRouting(branch, result, digest(result)), /already exists/);
  const missing = { ...current, routes: current.routes.slice(1) };
  assert.throws(() => mobileKitchenRouting(branch, missing, digest(missing)), /no matching/);
  const duplicate = { ...current, routes: [...current.routes, current.routes[0]] };
  assert.throws(() => mobileKitchenRouting(branch, duplicate, digest(duplicate)), /Duplicate/);
});
