import assert from 'node:assert/strict';
import test from 'node:test';
import {
  copyAggregatorPrices,
  externalMenuSummary,
  filterExternal,
  withAggregatorPrice,
} from '../../apps/backoffice/dist/external-menu.js';

const product = (id, prices, extra = {}) => ({
  id,
  sku: id.toUpperCase(),
  name: { ru: `Блюдо ${id}`, kk: '' },
  price_minor: '199000',
  available: true,
  ...(prices ? { channel_prices_minor: prices } : {}),
  ...extra,
});

test('a typed tenge price sets only that aggregator; empty removes it; garbage is refused', () => {
  const base = product('a', { mobile: '150000' });
  const yandex = withAggregatorPrice(base, 'yandex_eda', '2 390');
  assert.deepEqual(yandex.channel_prices_minor, { mobile: '150000', yandex_eda: '239000' });
  assert.equal(base.channel_prices_minor.yandex_eda, undefined, 'the source stays unchanged');
  const glovo = withAggregatorPrice(yandex, 'glovo', '2390,5');
  assert.equal(glovo.channel_prices_minor.glovo, '239050');
  const cleared = withAggregatorPrice(glovo, 'yandex_eda', '  ');
  assert.deepEqual(cleared.channel_prices_minor, { mobile: '150000', glovo: '239050' });
  const empty = withAggregatorPrice(product('b', { glovo: '1000' }), 'glovo', '');
  assert.equal('channel_prices_minor' in empty, false, 'an emptied price object is dropped');
  assert.equal(withAggregatorPrice(base, 'glovo', 'abc'), null);
  assert.equal(withAggregatorPrice(base, 'glovo', '-5'), null);
});

test('summary counts what each aggregator sells', () => {
  const s = externalMenuSummary([
    product('a', { yandex_eda: '1', glovo: '1' }),
    product('b', { glovo: '1' }),
    product('c', { mobile: '1' }),
    product('d'),
  ]);
  assert.deepEqual(s, { total: 4, yandex_eda: 1, glovo: 2, none: 2 });
});

test('copy Yandex to Glovo fills only empty Glovo prices', () => {
  const changed = copyAggregatorPrices(
    [
      product('a', { yandex_eda: '239000' }),
      product('b', { yandex_eda: '239000', glovo: '249000' }),
      product('c', { glovo: '100' }),
      product('d'),
    ],
    'yandex_eda',
    'glovo',
  );
  assert.deepEqual(
    changed.map((p) => [p.id, p.channel_prices_minor]),
    [['a', { yandex_eda: '239000', glovo: '239000' }]],
  );
});

test('filter by aggregator and search by name or article', () => {
  const list = [
    product('burger', { yandex_eda: '1' }),
    product('duo', { glovo: '1' }),
    product('water'),
  ];
  const ids = (q, f) => filterExternal(list, q, f).map((p) => p.id);
  assert.deepEqual(ids('', 'all'), ['burger', 'duo', 'water']);
  assert.deepEqual(ids('', 'yandex_eda'), ['burger']);
  assert.deepEqual(ids('', 'glovo'), ['duo']);
  assert.deepEqual(ids('', 'none'), ['water']);
  assert.deepEqual(ids('DUO', 'all'), ['duo']);
  assert.deepEqual(ids('блюдо w', 'all'), ['water']);
});
