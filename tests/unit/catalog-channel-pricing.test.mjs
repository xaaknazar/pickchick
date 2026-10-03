/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CatalogProductSchema,
  assertCatalogPublishable,
  CatalogAdminError,
} from '../../packages/catalog-admin/dist/contracts.js';
import {
  priceCatalogSnapshot,
  CatalogPricingError,
} from '../../packages/catalog-pricing/dist/index.js';
import { pricingFixture, product, group, option } from '../helpers/catalog-pricing.mjs';

test('trusted channel selects published price and preserves common modifier arithmetic', () => {
  const f = pricingFixture([
    product('burger', {
      price_minor: '10000',
      channel_prices_minor: { mobile: '20001', kiosk: '30002', pos: '40003' },
      modifier_groups: [group([option('extra', { price_delta_minor: '33', max_quantity: 2 })])],
    }),
  ]);
  f.cart.items[0].quantity = 3;
  f.cart.items[0].selections = [{ group_id: 'side', option_id: 'extra', quantity: 2 }];
  for (const [channel, base, total] of [
    ['mobile', '20001', '60201'],
    ['kiosk', '30002', '90204'],
  ]) {
    const quote = priceCatalogSnapshot(f.publication, { ...f.scope, channel }, f.cart);
    assert.equal(quote.lines[0].baseUnitPriceMinor, base);
    assert.equal(quote.lines[0].modifiersUnitPriceMinor, '66');
    assert.equal(quote.totalMinor, total);
    assert.equal(quote.channel, channel);
  }
  assert.throws(
    () => priceCatalogSnapshot(f.publication, { ...f.scope, channel: 'pos' }, f.cart),
    (error) => error instanceof CatalogPricingError && error.code === 'SCOPE_MISMATCH',
  );
  assert.throws(
    () => f.price({ ...f.cart, channel: 'kiosk' }),
    (error) => error instanceof CatalogPricingError && error.code === 'INVALID_CART',
  );
});

test('legacy publications and absent overrides retain base pricing; zero overrides are not fallback', () => {
  for (const overrides of [undefined, {}, { mobile: '20000' }]) {
    const p = product('burger', { price_minor: '10000' });
    if (overrides !== undefined) p.channel_prices_minor = overrides;
    const f = pricingFixture([p]);
    assert.equal(
      priceCatalogSnapshot(f.publication, { ...f.scope, channel: 'kiosk' }, f.cart).totalMinor,
      '10000',
    );
  }
  const f = pricingFixture([
    product('burger', {
      price_minor: '10000',
      channel_prices_minor: { mobile: '0' },
      modifier_groups: [group([option('extra', { price_delta_minor: '100' })])],
    }),
  ]);
  f.cart.items[0].selections = [{ group_id: 'side', option_id: 'extra', quantity: 1 }];
  assert.equal(f.price().lines[0].baseUnitPriceMinor, '0');
  assert.equal(f.price().totalMinor, '100');
});

test('channel overrides accept exact minor units and reject unsupported keys or malformed amounts', () => {
  const p = product('burger');
  assert.equal(
    CatalogProductSchema.safeParse({
      ...p,
      channel_prices_minor: { mobile: '9000000000000000', pos: '0' },
    }).success,
    true,
  );
  for (const overrides of [
    null,
    [],
    { web: '100' },
    { mobile: '-1' },
    { kiosk: '1.2' },
    { pos: '01' },
    { mobile: 10 },
  ])
    assert.equal(
      CatalogProductSchema.safeParse({ ...p, channel_prices_minor: overrides }).success,
      false,
    );
});

test('publication guard rejects every nonempty channel draft and keeps legacy catalogs publishable', () => {
  const f = pricingFixture();
  assert.doesNotThrow(() => assertCatalogPublishable(f.publication.payload));
  f.publication.payload.products[0].channel_prices_minor = {};
  assert.doesNotThrow(() => assertCatalogPublishable(f.publication.payload));
  for (const channel of ['mobile', 'pos', 'kiosk']) {
    f.publication.payload.products[0].channel_prices_minor = { [channel]: '0' };
    assert.throws(
      () => assertCatalogPublishable(f.publication.payload),
      (error) => error instanceof CatalogAdminError && error.code === 'CONFLICT',
    );
  }
});

test('director cannot dispatch publication while the saved draft contains channel prices', async () => {
  const { CatalogModel } = await import('../../apps/backoffice/dist/model.js');
  const { parsePayload } = await import('../../apps/backoffice/dist/domain.js');
  const f = pricingFixture([product('burger', { channel_prices_minor: { mobile: '12000' } })]);
  let calls = 0;
  const store = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const model = new CatalogModel(store, async () => {
    calls++;
    throw new Error('Unexpected request');
  });
  model.payload = parsePayload(f.publication.payload);
  model.state = { draft: { revision: 1, payload: model.payload } };
  model.dirty = false;
  await model.publish();
  assert.equal(calls, 0);
  assert.match(model.error.message, /только в черновике/);
  const invalid = structuredClone(f.publication.payload);
  invalid.products[0].channel_prices_minor = { web: '1' };
  assert.throws(() => parsePayload(invalid), /INVALID_RESPONSE/);
});
