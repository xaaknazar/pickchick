/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  priceCatalogSnapshot,
  CatalogPricingError,
  MinorSchema,
  PricedCatalogQuoteSchema,
  allocateDiscount,
  MAX_MINOR,
} from '../../packages/catalog-pricing/dist/index.js';
import { pricingFixture, product, group, option } from '../helpers/catalog-pricing.mjs';
const isError = (code) => (error) => error instanceof CatalogPricingError && error.code === code;
const selection = (id, quantity = 1, groupId = 'side') => ({
  group_id: groupId,
  option_id: id,
  quantity,
});

test('client cannot submit prices, discounts, trusted scope, fractional quantities or unsupported delivery', () => {
  const f = pricingFixture();
  for (const patch of [
    { total_minor: '1' },
    { customerId: randomUUID() },
    { branch_id: randomUUID() },
    { discount_minor: '1' },
    { channel: 'kiosk' },
    { service_mode: 'delivery' },
    { items: [{ ...f.cart.items[0], price_minor: '0' }] },
    { items: [{ ...f.cart.items[0], quantity: 1.5 }] },
    { items: [] },
    { items: [{ ...f.cart.items[0], selections: undefined }] },
  ])
    assert.throws(() => f.price({ ...f.cart, ...patch }), isError('INVALID_CART'));
  for (const input of ['abc', '1.1', '-1', '01', '1e3', 'Infinity', '9000000000000001'])
    assert.equal(MinorSchema.safeParse(input).success, false, input);
});
test('trusted publication requires matching ownership/hash, explicit content review and enabled branch', () => {
  const f = pricingFixture();
  assert.throws(
    () => priceCatalogSnapshot(f.publication, { ...f.scope, organizationId: randomUUID() }, f.cart),
    isError('SCOPE_MISMATCH'),
  );
  assert.throws(
    () => priceCatalogSnapshot(f.publication, { ...f.scope, branchId: randomUUID() }, f.cart),
    isError('SCOPE_MISMATCH'),
  );
  assert.throws(() => f.price({ ...f.cart, catalog_version: 2 }), isError('STALE_CATALOG'));
  f.publication.orderingEnabled = false;
  assert.throws(() => f.price(), isError('BRANCH_UNAVAILABLE'));
  f.publication.orderingEnabled = true;
  f.publication.payload.products[0].price_minor = '102';
  assert.throws(() => f.price(), isError('CATALOG_INVALID'));
  f.rehash();
  f.publication.payload.content_reviewed = false;
  f.rehash();
  assert.throws(() => f.price(), isError('CATALOG_INVALID'));
});
test('option quantities and parent quantities use exact integer money; parent includes fixed components', () => {
  const f = pricingFixture([
    product('combo', {
      kind: 'combo',
      price_minor: '10001',
      combo_components: [{ product_id: 'side', quantity: 2 }],
      modifier_groups: [
        group(
          [
            option('extra', {
              price_delta_minor: '33',
              max_quantity: 4,
              linked_product_id: 'side',
            }),
          ],
          { max: 4 },
        ),
      ],
    }),
    product('side', { price_minor: '99999999' }),
  ]);
  f.cart.items[0].quantity = 3;
  f.cart.items[0].selections = [selection('extra', 2)];
  const quote = PricedCatalogQuoteSchema.parse(f.price()),
    line = quote.lines[0];
  assert.equal(line.baseUnitPriceMinor, '10001');
  assert.equal(line.modifiersUnitPriceMinor, '66');
  assert.equal(line.unitPriceMinor, '10067');
  assert.equal(line.grossMinor, '30201');
  assert.equal(quote.totalMinor, '30201');
  assert.equal(quote.discountMinor, '0');
  assert.equal(line.selectedDetails.components[0].quantity, 4);
  assert.equal(line.selectedDetails.modifiers[0].totalPriceDeltaMinor, '66');
  assert.equal(line.selectedDetails.nutrition.perServing, null);
  assert.equal(line.selectedDetails.nutrition.reason, 'modifier_nutrition_unknown');
});
test('required/exclusive groups need explicit selections; defaults are not silent orders', () => {
  const f = pricingFixture([
    product('combo', {
      modifier_groups: [
        group(
          [
            option('cola', { default_quantity: 1 }),
            option('water'),
            option('unavailable', { available: false }),
          ],
          { min: 1, max: 1 },
        ),
      ],
    }),
  ]);
  const input = (selections) => ({ ...f.cart, items: [{ ...f.cart.items[0], selections }] });
  for (const selected of [
    [],
    [selection('cola'), selection('water')],
    [selection('cola', 2)],
    [selection('unavailable')],
    [selection('unknown')],
    [selection('cola', 1, 'unknown')],
    [selection('cola'), selection('cola')],
  ])
    assert.throws(() => f.price(input(selected)), isError('INVALID_SELECTION'));
  assert.equal(
    f.price(input([selection('water')])).lines[0].selectedDetails.modifiers[0].optionId,
    'water',
  );
});
test('same SKU variants remain distinct, canonical order is stable and duplicate variants must be consolidated', () => {
  const f = pricingFixture([
    product('burger', { modifier_groups: [group([option('a'), option('b')])] }),
  ]);
  const line = (selections, quantity = 1) => ({ sku: 'BURGER', quantity, selections });
  const a = f.price({ ...f.cart, items: [line([selection('a'), selection('b')], 2), line([])] });
  const b = f.price({ ...f.cart, items: [line([]), line([selection('b'), selection('a')], 2)] });
  assert.deepEqual(a, b);
  assert.notEqual(a.lines[0].lineId, a.lines[1].lineId);
  const q1 = f.price({ ...f.cart, items: [line([selection('a')])] });
  const q2 = f.price({ ...f.cart, items: [line([selection('a')], 3)] });
  assert.equal(q1.lines[0].lineId, q2.lines[0].lineId);
  assert.throws(
    () =>
      f.price({
        ...f.cart,
        items: [line([selection('a'), selection('b')]), line([selection('b'), selection('a')])],
      }),
    isError('INVALID_CART'),
  );
});
test('unavailable SKU/selected linked components reject, while unavailable unselected optional components do not', () => {
  const f = pricingFixture([
    product('burger', {
      modifier_groups: [group([option('side', { linked_product_id: 'side' })])],
    }),
    product('side', { available: false }),
  ]);
  assert.equal(f.price().totalMinor, '101');
  f.cart.items[0].selections = [selection('side')];
  assert.throws(() => f.price(), isError('PRODUCT_UNAVAILABLE'));
  f.cart.items[0] = { sku: 'DOES-NOT-EXIST', quantity: 1, selections: [] };
  assert.throws(() => f.price(), isError('PRODUCT_UNAVAILABLE'));
  f.cart.items[0].sku = 'SIDE';
  assert.throws(() => f.price(), isError('PRODUCT_UNAVAILABLE'));
});
test('nested components flatten quantities without double charging and cannot silently choose nested modifiers', () => {
  const f = pricingFixture([
    product('party', { kind: 'set', combo_components: [{ product_id: 'combo', quantity: 3 }] }),
    product('combo', { kind: 'combo', combo_components: [{ product_id: 'side', quantity: 2 }] }),
    product('side'),
  ]);
  const result = f.price();
  assert.equal(result.lines[0].selectedDetails.components[0].quantity, 6);
  assert.equal(result.totalMinor, '101');
  f.publication.payload.products[1].modifier_groups = [group([option('optional')])];
  f.rehash();
  assert.throws(() => f.price(), isError('AMBIGUOUS_COMPONENT'));
});
test('adversarial component DAG multiplicities are bounded without expanding a million entries', () => {
  const f = pricingFixture([
    product('a', { kind: 'set', combo_components: [{ product_id: 'b', quantity: 1000 }] }),
    product('b', { kind: 'set', combo_components: [{ product_id: 'c', quantity: 1000 }] }),
    product('c', { kind: 'set', combo_components: [{ product_id: 'd', quantity: 1000 }] }),
    product('d'),
  ]);
  assert.throws(() => f.price(), isError('AMBIGUOUS_COMPONENT'));
});
test('valid catalog with many rich combo variants cannot produce an unbounded quote response', () => {
  const components = Array.from({ length: 20 }, (_, i) =>
    product(`leaf-${i}`, {
      description: { ru: 'я'.repeat(2000), kk: '' },
    }),
  );
  const f = pricingFixture([
    product('party', {
      kind: 'set',
      combo_components: components.map((p) => ({ product_id: p.id, quantity: 1 })),
      modifier_groups: [group([option('extras', { max_quantity: 40 })], { max: 40 })],
    }),
    ...components,
  ]);
  assert.equal(f.price().totalMinor, '101');
  assert.throws(
    () =>
      f.price({
        ...f.cart,
        items: Array.from({ length: 20 }, (_, i) => ({
          sku: 'PARTY',
          quantity: 1,
          selections: [selection('extras', i + 1)],
        })),
      }),
    isError('QUOTE_TOO_LARGE'),
  );
});
test('money bounds are checked on base, modifier, unit, line and whole cart; zero total does not issue a quote', () => {
  const f = pricingFixture([
    product('a', { price_minor: MAX_MINOR.toString() }),
    product('b', { price_minor: '1' }),
  ]);
  assert.equal(f.price().totalMinor, MAX_MINOR.toString());
  assert.throws(
    () => f.price({ ...f.cart, items: [{ ...f.cart.items[0], quantity: 2 }] }),
    isError('AMOUNT_OUT_OF_RANGE'),
  );
  assert.throws(
    () =>
      f.price({ ...f.cart, items: [...f.cart.items, { sku: 'B', quantity: 1, selections: [] }] }),
    isError('AMOUNT_OUT_OF_RANGE'),
  );
  f.publication.payload.products[0].modifier_groups = [
    group([option('extra', { price_delta_minor: '1' })]),
  ];
  f.rehash();
  f.cart.items[0].selections = [selection('extra')];
  assert.throws(() => f.price(), isError('AMOUNT_OUT_OF_RANGE'));
  f.publication.payload.products[0].price_minor = '9000000000000001';
  f.rehash();
  assert.throws(() => f.price(), isError('AMOUNT_OUT_OF_RANGE'));
  assert.throws(
    () => pricingFixture([product('free', { price_minor: '0' })]).price(),
    isError('AMOUNT_OUT_OF_RANGE'),
  );
});
test('immutable detached snapshot retains exact localized choice, declaration and source after catalog edits', () => {
  const f = pricingFixture([
    product('burger', {
      modifier_groups: [group([option('extra', { price_delta_minor: '123' })])],
    }),
  ]);
  f.cart.items[0].selections = [selection('extra')];
  const quote = f.price(),
    copy = structuredClone(quote);
  f.publication.payload.products[0].name.ru = 'New name';
  f.publication.payload.products[0].nutrition.energy_kcal = 999;
  f.publication.payload.products[0].modifier_groups[0].options[0].price_delta_minor = '999';
  assert.deepEqual(quote, copy);
  assert.equal(quote.lines[0].selectedDetails.modifiers[0].unitPriceDeltaMinor, '123');
});
test('unverified nutrition is preserved as declaration and never becomes a calculated zero or certified value', () => {
  const f = pricingFixture([product('burger', { nutrition_status: 'unverified' })]);
  f.publication.payload.content_source = 'mockup';
  f.rehash();
  const n = f.price().lines[0].selectedDetails.nutrition;
  assert.equal(n.declaration.energy_kcal, 100);
  assert.equal(n.perServing, null);
  assert.equal(n.lineTotal, null);
  assert.equal(n.reason, 'unverified');
});
test('operator nutrition converts known gram basis and one explicit size only; volume alone cannot imply density', () => {
  const p = product('burger');
  p.nutrition.basis = 'per_100_g';
  p.modifier_groups = [group([option('double', { nutrition_multiplier: 2 })])];
  const f = pricingFixture([p]);
  f.cart.items[0].quantity = 3;
  f.cart.items[0].selections = [selection('double')];
  const n = f.price().lines[0].selectedDetails.nutrition;
  assert.equal(n.perServing.energy_kcal, 300);
  assert.equal(n.lineTotal.energy_kcal, 900);
  assert.equal(n.reason, 'operator_declaration');
  f.publication.payload.products[0].weight_g = null;
  f.publication.payload.products[0].volume_ml = 150;
  f.rehash();
  assert.equal(f.price().lines[0].selectedDetails.nutrition.reason, 'weight_unknown');
});
test('largest remainder allocation is exact, deterministic and handles zero lines without assigning them money', () => {
  const lines = [
    { lineId: 'b', grossMinor: '1' },
    { lineId: 'a', grossMinor: '1' },
    { lineId: 'z', grossMinor: '0' },
  ];
  assert.deepEqual(allocateDiscount(lines, '1'), [
    { lineId: 'a', discountMinor: '1', totalMinor: '0' },
    { lineId: 'b', discountMinor: '0', totalMinor: '1' },
    { lineId: 'z', discountMinor: '0', totalMinor: '0' },
  ]);
  assert.deepEqual(allocateDiscount(lines, '1'), allocateDiscount([...lines].reverse(), '1'));
  assert.equal(
    allocateDiscount(lines, '2').reduce((sum, v) => sum + BigInt(v.discountMinor), 0n),
    2n,
  );
  assert.deepEqual(allocateDiscount([{ lineId: 'z', grossMinor: '0' }], '0'), [
    { lineId: 'z', discountMinor: '0', totalMinor: '0' },
  ]);
  for (const invalid of ['3', '-1', '1.5', 'abc'])
    assert.throws(() => allocateDiscount(lines, invalid), isError('AMOUNT_OUT_OF_RANGE'));
  assert.throws(() => allocateDiscount([lines[0], lines[0]], '1'), isError('AMOUNT_OUT_OF_RANGE'));
  const large = allocateDiscount(
    [
      { lineId: 'a', grossMinor: '4499999999999999' },
      { lineId: 'b', grossMinor: '4500000000000001' },
    ],
    '1234567890123456',
  );
  assert.equal(
    large.reduce((sum, v) => sum + BigInt(v.discountMinor), 0n),
    1234567890123456n,
  );
});
