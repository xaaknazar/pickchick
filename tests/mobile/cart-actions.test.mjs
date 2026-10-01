import test from 'node:test';
import assert from 'node:assert/strict';
import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';
import {
  cartRecommendations,
  mergeCartLines,
  repeatOrderPlan,
} from '../../apps/mobile/src/cart-actions.ts';
import { defaultSelections, cartTotal, cartLineKey } from '../../apps/mobile/src/domain.ts';
import { comboNextStep } from '../../apps/mobile/src/loyalty/combo-progress.ts';

const products = testCompleteCatalog.products.map((p) => ({
  ...p,
  priceMinor: p.price_minor,
  modifierGroups: p.modifier_groups,
  source: 'server',
}));
const makeLine = (id, quantity = 1) => {
  const product = products.find((p) => p.id === id);
  return { product, quantity, selections: defaultSelections(product) };
};
const duo = makeLine('burger-duo', 2);
const saved = {
  ...duo.product,
  id: duo.product.id,
  quantity: 2,
  selections: duo.selections,
  line_total_minor: '100',
};
const order = { snapshot: { lines: [saved] } };

test('repeat uses current money, exact quantities and modifiers without mutating order', () => {
  const before = globalThis.structuredClone(order);
  const plan = repeatOrderPlan(order, products);
  assert.equal(plan.lines[0].quantity, 2);
  assert.deepEqual(plan.lines[0].selections, duo.selections);
  assert.equal(plan.changes[0].before, '100');
  assert.equal(plan.changes[0].after, cartTotal([duo]));
  assert.deepEqual(order, before);
});
test('repeat discloses unavailable products and never substitutes a stopped modifier', () => {
  const blocked = globalThis.structuredClone(products);
  blocked
    .find((p) => p.id === 'burger-duo')
    .modifierGroups.find((g) => g.id === 'drink')
    .options.find((o) => o.id === 'cola-bottle').available = false;
  assert.equal(repeatOrderPlan(order, blocked).lines.length, 0);
  assert.match(repeatOrderPlan(order, blocked).changes[0].reason, /Состав изменился/);
  assert.match(repeatOrderPlan(order, []).changes[0].reason, /нет в меню/);
});
test('legacy history without required selections cannot silently pick defaults', () => {
  const legacy = { ...saved };
  delete legacy.selections;
  assert.equal(repeatOrderPlan({ snapshot: { lines: [legacy] } }, products).lines.length, 0);
  const water = makeLine('water');
  assert.equal(
    repeatOrderPlan(
      { snapshot: { lines: [{ id: 'water', quantity: 1, line_total_minor: cartTotal([water]) }] } },
      products,
    ).lines.length,
    1,
  );
});
test('repeat appends atomically and merges only identical configurations', () => {
  const first = makeLine('burger-duo');
  const different = {
    ...first,
    selections: first.selections.map((s) =>
      s.group_id === 'drink' ? { ...s, option_id: 'lemonade' } : s,
    ),
  };
  const cart = [first, different];
  const next = mergeCartLines(cart, [duo], products);
  assert.equal(next.length, 2);
  assert.equal(next[0].quantity, 3);
  assert.equal(next[1].quantity, 1);
  assert.equal(cart[0].quantity, 1);
});
test('overflow rejects every addition, including those that individually fit', () => {
  const cart = [makeLine('water', 20)];
  assert.equal(mergeCartLines(cart, [makeLine('toast'), makeLine('water')], products), null);
  const many = products
    .filter((p) => defaultSelections(p).length === 0)
    .map((p) => ({ product: p, quantity: 1, selections: [] }));
  const twelve = products
    .slice(0, 12)
    .map((p) => ({ product: p, quantity: 1, selections: defaultSelections(p) }));
  assert.equal(mergeCartLines([], twelve, products), null);
  assert.ok(many.length > 0);
});
test('undo restores exact selection; stale prices, missing items and mixed sources are rejected', () => {
  assert.equal(cartLineKey(mergeCartLines([], [duo], products)[0]), cartLineKey(duo));
  assert.equal(mergeCartLines([], [duo], []), null);
  assert.equal(
    mergeCartLines([], [{ ...duo, product: { ...duo.product, priceMinor: '1' } }], products),
    null,
  );
  assert.equal(
    mergeCartLines(
      [{ ...makeLine('water'), product: { ...makeLine('water').product, source: 'design' } }],
      [duo],
      products,
    ),
    null,
  );
  for (const quantity of [0, -1, 21, 1.5])
    assert.equal(mergeCartLines([], [{ ...duo, quantity }], products), null);
});
test('recommendations match main food, exclude already chosen extras and retain extra drinks', () => {
  assert.equal(cartRecommendations([makeLine('burger-combo')], products)[0].product.id, 'fingers');
  assert.equal(cartRecommendations([makeLine('finger-duo')], products)[0].product.id, 'burger');
  const withExtra = {
    ...makeLine('burger-combo'),
    selections: [
      ...makeLine('burger-combo').selections,
      { group_id: 'extras', option_id: 'fingers', quantity: 1 },
    ],
  };
  const ids = cartRecommendations([withExtra, makeLine('toast')], products).map(
    (l) => l.product.id,
  );
  for (const id of ['fingers', 'toast', 'burger', 'sauce']) assert.ok(!ids.includes(id));
});
test('combo recommendations include every published drink beyond the first six cards', () => {
  const cart = [makeLine('pick-combo')];
  const recommendations = cartRecommendations(cart, products);
  const drinks = products.filter((p) => p.category === 'Напитки').map((p) => p.id);
  assert.ok(recommendations.length > 6);
  assert.deepEqual(
    recommendations.filter((l) => l.product.category === 'Напитки').map((l) => l.product.id),
    drinks,
  );
  const added = mergeCartLines(cart, [recommendations[0]], products);
  assert.ok(added);
  const remaining = cartRecommendations(added, products);
  assert.ok(remaining.length > 3);
  assert.ok(drinks.every((id) => remaining.some((l) => l.product.id === id)));
  const withCola = cartRecommendations([...cart, makeLine('cola')], products);
  assert.ok(!withCola.some((l) => l.product.id === 'cola'));
  assert.ok(withCola.some((l) => l.product.id === 'piko'));
});
test('stopped drinks and unavailable drink defaults are not suggested', () => {
  const catalog = products.map((p) => (p.category === 'Напитки' ? { ...p, available: false } : p));
  assert.ok(cartRecommendations([duo], catalog).every((l) => l.product.category !== 'Напитки'));
});
test('recommendations use published availability and never offer an invalid default', () => {
  assert.deepEqual(cartRecommendations([duo], []), []);
  const unavailable = products.map((p) =>
    p.id === 'fingers'
      ? { ...p, modifierGroups: [{ id: 'required', min: 1, max: 1, options: [] }] }
      : p,
  );
  assert.ok(!cartRecommendations([duo], unavailable).some((l) => l.product.id === 'fingers'));
});
test('7+1 next step distinguishes unknown balance, example and non-redeemable practice completion', () => {
  assert.match(comboNextStep().title, /Войдите/);
  assert.match(comboNextStep(undefined, true).title, /4 комбо/);
  for (const current of [0, 1, 6]) {
    const state = {
      status: 'ready',
      data: { mode: 'practice', current_stamps: current, completed_cycles: 0 },
    };
    assert.match(comboNextStep(state).title, new RegExp(String(7 - current)));
    assert.match(comboNextStep(state).detail, /не даёт право/);
  }
  const complete = comboNextStep({
    status: 'ready',
    data: { mode: 'practice', current_stamps: 0, completed_cycles: 1 },
  });
  assert.match(complete.title, /Пробный круг собран/);
  assert.notEqual(complete.action, 'Получить подарок');
});
