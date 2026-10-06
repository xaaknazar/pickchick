import test from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal, defaultSelections } from '../../apps/mobile/src/domain.ts';
import {
  publishedProductData,
  publishedCartVersion,
} from '../../apps/mobile/src/published-catalog.ts';
import { pricingFixture, product, group, option } from '../helpers/catalog-pricing.mjs';

test('published storefront, combo selections and commercial quote use identical mobile amounts', () => {
  const f = pricingFixture([
    product('pick-combo', {
      price_minor: '10000',
      modifier_groups: [
        group(
          [
            option('cola', { default_quantity: 1 }),
            option('lemonade', { price_delta_minor: '20000' }),
          ],
          { id: 'drink', min: 1, max: 1 },
        ),
      ],
    }),
    product('burger', {
      price_minor: '249000',
      channel_prices_minor: { mobile: '199000', kiosk: '229000' },
    }),
  ]);
  const storefront = {
    branch: { id: f.scope.branchId },
    version: 1,
    payload: f.publication.payload,
  };
  const projected = publishedProductData(storefront, 'ru');
  for (const quantity of [1, 2, 20]) {
    for (const drink of ['cola', 'lemonade']) {
      const cart = projected.map((item) => ({
        product: item,
        quantity,
        selections: defaultSelections(item),
      }));
      cart[0].selections = [{ group_id: 'drink', option_id: drink, quantity: 1 }];
      const quote = f.price({
        catalog_version: publishedCartVersion(cart, f.scope.branchId),
        service_mode: 'takeaway',
        items: cart.map((line) => ({
          sku: f.publication.payload.products.find((item) => item.id === line.product.id).sku,
          quantity: line.quantity,
          selections: line.selections,
        })),
      });
      assert.equal(cartTotal(cart), quote.totalMinor);
    }
  }
  assert.equal(projected[0].priceMinor, '10000');
  assert.equal(projected[1].priceMinor, '199000');
});

test('a publication price edit cannot silently reprice a quote for the previous catalog version', () => {
  const f = pricingFixture([product('pick-combo', { price_minor: '419000' })]);
  const storefront = {
    branch: { id: f.scope.branchId },
    version: 1,
    payload: f.publication.payload,
  };
  const cart = [
    { product: publishedProductData(storefront, 'ru')[0], quantity: 1, selections: [] },
  ];
  const previous = f.price();
  f.publication.payload.products[0].price_minor = '10000';
  f.publication.reference.version = 2;
  f.rehash();
  assert.equal(cartTotal(cart), '419000');
  assert.equal(previous.totalMinor, '419000');
  assert.throws(() => f.price(), /STALE_CATALOG/);
  const updated = f.price({ ...f.cart, catalog_version: 2 });
  assert.equal(updated.totalMinor, '10000');
});
