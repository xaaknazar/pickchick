import test from 'node:test';
import assert from 'node:assert/strict';
import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';
import {
  BURGER_PRODUCT_IDS,
  FINGERS_PRODUCT_IDS,
  isCheeseSauce,
  orderLines,
  orderSummary,
  planUpsell,
  upsellReason,
} from '../../apps/kiosk/src/smartUpsell.ts';

const products = testCompleteCatalog.products;
const drinks = products.filter((p) => p.category === 'Напитки').map((p) => p.id);
const allDrinks = ['lemonade', ...drinks.filter((id) => id !== 'lemonade')];
const ids = (tiles) => tiles.map((tile) => tile.product.id);
const plan = (base, catalog = products) => planUpsell(catalog, base);

test('the rule knows every fingers and burger product of the catalog', () => {
  const catalogIds = new Set(products.map((p) => p.id));
  for (const id of [...FINGERS_PRODUCT_IDS, ...BURGER_PRODUCT_IDS])
    assert.ok(catalogIds.has(id), `${id} is a catalog product`);
  assert.equal(upsellReason(['pick-combo']), 'fingers');
  assert.equal(upsellReason(['fingers-50', 'lemonade']), 'fingers');
  assert.equal(upsellReason(['burger-combo']), 'burger');
  assert.equal(upsellReason(['burger', 'cola']), 'burger');
  assert.equal(upsellReason(['mix-duo']), 'both', 'Микс Дуо holds fingers and a burger');
  assert.equal(upsellReason(['solo-combo', 'burger-duo']), 'both');
  assert.equal(upsellReason(['lemonade', 'toast']), 'neither');
  assert.equal(upsellReason([]), 'neither');
});

test('fingers without a burger: the burger «К ФИНГЕРСАМ», sauces and drinks', () => {
  const result = plan(['pick-combo']);
  assert.equal(result.reason, 'fingers');
  assert.equal(result.hero.product.id, 'burger');
  assert.equal(result.hero.kind, 'burger');
  assert.equal(result.hero.pairing, true);
  assert.equal(result.hero.badge, 'toFingers');
  assert.deepEqual(ids(result.sauces), ['sauce', 'sauce-hot']);
  assert.deepEqual(
    result.sauces.map((tile) => tile.badge),
    ['hit', 'hot'],
  );
  assert.deepEqual(ids(result.drinks), allDrinks);
  assert.deepEqual(
    result.drinks.map((tile) => tile.badge),
    allDrinks.map((id) => (id === 'lemonade' ? 'lemonade' : null)),
  );
});

test('a burger without fingers: single fingers «К БУРГЕРУ»', () => {
  const result = plan(['burger-combo']);
  assert.equal(result.reason, 'burger');
  assert.equal(result.hero.product.id, 'fingers');
  assert.equal(result.hero.pairing, true);
  assert.equal(result.hero.badge, 'toBurger');
  assert.deepEqual(ids(result.drinks), allDrinks);
});

test('both mains: the lemonade hero also stays first in the editable drinks row', () => {
  const result = plan(['pick-combo', 'burger']);
  assert.equal(result.reason, 'both');
  assert.equal(result.hero.product.id, 'lemonade');
  assert.equal(result.hero.pairing, false);
  assert.equal(result.hero.badge, 'lemonade');
  assert.deepEqual(ids(result.drinks), allDrinks);
  // No repeated recommendation, but its quantity stays editable in the row.
  const withLemonade = plan(['mix-duo', 'lemonade']);
  assert.equal(withLemonade.hero, null);
  assert.deepEqual(ids(withLemonade.drinks), allDrinks);
});

test('neither main: fingers as the house dish, then the burger, then the lemonade', () => {
  const result = plan(['toast', 'iced-tea']);
  assert.equal(result.reason, 'neither');
  assert.equal(result.hero.product.id, 'fingers');
  assert.equal(result.hero.pairing, false);
  assert.equal(result.hero.badge, 'hit');
  assert.deepEqual(ids(result.drinks), allDrinks);
  const stopped = products.map((p) => (p.id === 'fingers' ? { ...p, available: false } : p));
  assert.equal(plan(['cola'], stopped).hero.product.id, 'burger');
});

test('existing products keep quantity controls; stopped products disappear and the hero falls back', () => {
  const stopped = products.map((p) =>
    ['burger', 'sauce-hot', 'cola'].includes(p.id) ? { ...p, available: false } : p,
  );
  const result = plan(['fingers-25', 'sauce'], stopped);
  assert.equal(result.reason, 'fingers');
  assert.equal(result.hero.product.id, 'lemonade', 'a stopped burger gives way to the drinks hit');
  assert.equal(result.hero.pairing, false);
  assert.deepEqual(
    ids(result.sauces),
    ['sauce'],
    'signature quantity stays editable, hot is stopped',
  );
  assert.deepEqual(
    ids(result.drinks),
    allDrinks.filter((id) => id !== 'cola'),
  );
});

test('the cheese sauce tile appears only once the catalog has a cheese sauce', () => {
  assert.equal(products.some(isCheeseSauce), false, 'today the catalog has no cheese sauce');
  assert.equal(
    plan(['pick-combo']).sauces.some((tile) => tile.key === 'cheese'),
    false,
  );
  const cheese = {
    ...products.find((p) => p.id === 'sauce'),
    id: 'sauce-cheese',
    name: 'Соус сырный',
  };
  const result = plan(['pick-combo'], [...products, cheese]);
  assert.deepEqual(ids(result.sauces), ['sauce', 'sauce-hot', 'sauce-cheese']);
  assert.equal(result.sauces[2].badge, 'new');
  assert.equal(isCheeseSauce({ id: 'p-77', name: 'Сырный соус 60 г' }), true);
  assert.equal(isCheeseSauce({ id: 'p-78', name: 'Cheese sauce' }), true);
  assert.equal(isCheeseSauce({ id: 'p-79', name: 'Ірімшік тұздығы' }), true);
  assert.equal(isCheeseSauce({ id: 'cheese-burger', name: 'Сырный бургер' }), false);
  assert.equal(isCheeseSauce({ id: 'sauce', name: 'Соус фирменный' }), false);
  assert.equal(isCheeseSauce({ id: 'sauce-hot', name: 'Соус острый' }), false);
  // A stopped cheese sauce is not offered either.
  const off = plan(['pick-combo'], [...products, { ...cheese, available: false }]);
  assert.deepEqual(ids(off.sauces), ['sauce', 'sauce-hot']);
});

test('order captions combine configurations', () => {
  assert.equal(orderSummary(['Pick Combo']), 'Pick Combo');
  assert.equal(orderSummary(['Pick Combo', 'Burger Combo', 'Pick Combo']), 'Pick Combo +1');
  assert.equal(orderSummary([]), '');
  assert.equal(
    orderLines([
      { name: 'Burger Combo', quantity: 1 },
      { name: 'Соус фирменный', quantity: 2 },
    ]),
    'Burger Combo + Соус фирменный ×2',
  );
  assert.equal(
    orderLines([
      { name: 'Pick Combo', quantity: 1 },
      { name: 'Cola', quantity: 1 },
      { name: 'Pick Combo', quantity: 1 },
    ]),
    'Pick Combo ×2 + Cola',
    'two Pick Combos with different drinks read as one product',
  );
});
