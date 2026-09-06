import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { priceCart } from '@pickchick/local-orders';
import { fixtureMenu } from '@pickchick/test-fixtures';

const cart = {
  release_id: fixtureMenu.release_id,
  service_mode: 'dine_in',
  items: [{ variant_id: fixtureMenu.items[0].variant_id, quantity: 3 }],
};

test('pricing uses exact integer arithmetic above JavaScript safe range and refuses bigint overflow', () => {
  const menu = {
    ...fixtureMenu,
    items: [{ ...fixtureMenu.items[0], price_minor: '9007199254740993' }],
  };
  assert.equal(priceCart(menu, cart).total_minor, '27021597764222979');
  assert.equal(priceCart(menu, cart).lines[0].unit_price_minor, '9007199254740993');
  assert.throws(() =>
    priceCart({ ...menu, items: [{ ...menu.items[0], price_minor: '9223372036854775807' }] }, cart),
  );
});
test('cart rejects client money, unknown or repeated variants, modifiers and invalid quantities', () => {
  for (const invalid of [
    { ...cart, total_minor: '1' },
    { ...cart, items: [] },
    { ...cart, items: [...cart.items, ...cart.items] },
    { ...cart, items: [{ variant_id: randomUUID(), quantity: 1 }] },
    { ...cart, items: [{ ...cart.items[0], quantity: 0 }] },
    { ...cart, items: [{ ...cart.items[0], quantity: 1.5 }] },
    { ...cart, items: [{ ...cart.items[0], quantity: 100 }] },
    { ...cart, items: [{ ...cart.items[0], modifiers: [] }] },
  ])
    assert.throws(() => priceCart(fixtureMenu, invalid));
  assert.throws(
    () => priceCart(fixtureMenu, { ...cart, release_id: randomUUID() }),
    (e) => e.code === 'MENU_CHANGED',
  );
});
test('quoted totals and product names come from menu; free items never imply payment success', () => {
  assert.equal(priceCart(fixtureMenu, cart).total_minor, '1047000');
  assert.equal(priceCart(fixtureMenu, cart).discount_minor, '0');
  const result = priceCart(
    { ...fixtureMenu, items: [{ ...fixtureMenu.items[0], price_minor: '0' }] },
    cart,
  );
  assert.equal(result.total_minor, '0');
  assert.equal('payment_state' in result, false);
});
