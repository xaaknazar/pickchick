// Release fixes 2026-10-19 (audit 1.3, 4.2, 6.3): combo stop rule, PM decision 1.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { catalogStopView, lineStopIds, localCatalogId } from '@pickchick/menu-sync';

const branch = randomUUID();
const stopOf = (id) => localCatalogId(branch, 'base-preview', id);
const optionStop = (product, group, option) =>
  localCatalogId(branch, 'modifier-option', `${product}:${group}:${option}`);
const item = (id, extra = {}) => ({ id, available: true, modifier_groups: [], ...extra });
const option = (id, extra = {}) => ({ id, available: true, linked_product_id: null, ...extra });
const catalog = [
  item('fries'),
  item('cola'),
  item('piko'),
  item('sauce'),
  item('nuggets'),
  item('box', { combo_components: [{ product_id: 'nuggets' }] }),
  item('pick-combo', {
    combo_components: [{ product_id: 'fries' }, { product_id: 'box' }],
    modifier_groups: [
      {
        id: 'drink',
        min: 1,
        options: [
          option('cola-bottle', { linked_product_id: 'cola' }),
          option('piko-apple', { linked_product_id: 'piko' }),
        ],
      },
      { id: 'sauce', min: 1, options: [option('pick'), option('hot')] },
      { id: 'extras', min: 0, options: [option('sauce'), option('fanta')] },
    ],
  }),
];
const view = (ids) =>
  Object.fromEntries(catalogStopView(branch, new Set(ids), catalog).map((p) => [p.productId, p]));

test('nothing stopped: everything is sold, no option is hidden', () => {
  for (const product of Object.values(view([]))) {
    assert.equal(product.available, true);
    assert.deepEqual(product.stoppedOptions, []);
  }
});

test('a stopped fixed component stops the combo, also through a nested combo', () => {
  assert.equal(view([stopOf('fries')])['pick-combo'].available, false);
  assert.equal(view([stopOf('fries')]).fries.available, false);
  assert.equal(view([stopOf('nuggets')])['pick-combo'].available, false);
  assert.equal(view([stopOf('nuggets')]).box.available, false);
  assert.equal(view([stopOf('cola')])['pick-combo'].available, true);
});

test('a stopped linked product hides only that option; the combo stays on sale', () => {
  const v = view([stopOf('piko')]);
  assert.equal(v['pick-combo'].available, true);
  assert.deepEqual(v['pick-combo'].stoppedOptions, [
    { group_id: 'drink', option_id: 'piko-apple' },
  ]);
  // An option whose id is a product id follows that product without an explicit link.
  assert.deepEqual(view([stopOf('sauce')])['pick-combo'].stoppedOptions, [
    { group_id: 'extras', option_id: 'sauce' },
  ]);
  // The option's own stop still works; an option id that names no product never matches.
  assert.deepEqual(view([optionStop('pick-combo', 'sauce', 'hot')])['pick-combo'].stoppedOptions, [
    { group_id: 'sauce', option_id: 'hot' },
  ]);
  assert.deepEqual(view([stopOf('fanta')])['pick-combo'].stoppedOptions, []);
});

test('every option of a required group stopped makes the combo unavailable; optional groups do not', () => {
  assert.equal(view([stopOf('cola'), stopOf('piko')])['pick-combo'].available, false);
  assert.equal(
    view([optionStop('pick-combo', 'sauce', 'pick'), optionStop('pick-combo', 'sauce', 'hot')])[
      'pick-combo'
    ].available,
    false,
  );
  const extras = view([stopOf('sauce'), optionStop('pick-combo', 'extras', 'fanta')]);
  assert.equal(extras['pick-combo'].available, true);
  assert.equal(extras['pick-combo'].stoppedOptions.length, 2);
});

test('an ordered line is stopped by its product, options, linked products and components', () => {
  const line = {
    productId: 'pick-combo',
    selections: [
      { group_id: 'drink', option_id: 'piko-apple', linked_product_id: 'piko' },
      { group_id: 'extras', option_id: 'sauce', linked_product_id: null },
    ],
    componentIds: ['fries', 'nuggets'],
  };
  const ids = new Set(lineStopIds(branch, line));
  for (const stopped of [
    stopOf('pick-combo'),
    optionStop('pick-combo', 'drink', 'piko-apple'),
    stopOf('piko'),
    stopOf('sauce'),
    stopOf('fries'),
    stopOf('nuggets'),
  ])
    assert.ok(ids.has(stopped));
  assert.ok(!ids.has(stopOf('cola')));
  // Unpriced cart lines (no links, no components) still follow the option-id rule.
  const cart = new Set(
    lineStopIds(branch, {
      productId: 'pick-combo',
      selections: [{ group_id: 'extras', option_id: 'sauce' }],
    }),
  );
  assert.ok(cart.has(stopOf('sauce')));
});
