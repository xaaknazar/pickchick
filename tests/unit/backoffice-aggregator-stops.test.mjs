import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregatorStopReminders } from '../../apps/backoffice/dist/operations-model.js';

const item = (product_id, overrides = {}) => ({
  catalog_ref: { product_id },
  variant_id: `v-${product_id}`,
  kind: 'product',
  name_ru: product_id,
  product_name_ru: product_id,
  listed: true,
  sales_blocked: true,
  ...overrides,
});

test('stopped dishes sold on an aggregator are listed with exactly their aggregators', () => {
  const products = [
    { id: 'burger', channel_prices_minor: { yandex_eda: '239000', glovo: '239000' } },
    { id: 'duo', channel_prices_minor: { glovo: '459000' } },
    { id: 'hall', channel_prices_minor: { mobile: '199000' } },
    { id: 'plain' },
  ];
  const result = aggregatorStopReminders(
    [
      item('burger'),
      item('duo'),
      item('hall'),
      item('plain'),
      item('burger', { variant_id: 'v-burger-on', sales_blocked: false }),
      item('duo', { variant_id: 'v-duo-hidden', listed: false }),
      item('burger', {
        variant_id: 'v-sauce',
        kind: 'option',
        name_ru: 'Сырный соус',
        product_name_ru: 'Pick Burger',
        catalog_ref: { product_id: 'burger', group_id: 'g', option_id: 'o' },
      }),
    ],
    products,
  );
  assert.deepEqual(result, [
    { variant_id: 'v-burger', name: 'burger', aggregators: ['yandex_eda', 'glovo'] },
    { variant_id: 'v-duo', name: 'duo', aggregators: ['glovo'] },
    {
      variant_id: 'v-sauce',
      name: 'Pick Burger: Сырный соус',
      aggregators: ['yandex_eda', 'glovo'],
    },
  ]);
});

test('no published catalog or no aggregator prices gives no reminder', () => {
  assert.deepEqual(aggregatorStopReminders([item('burger')], []), []);
  assert.deepEqual(
    aggregatorStopReminders([item('burger')], [{ id: 'burger', channel_prices_minor: {} }]),
    [],
  );
});
