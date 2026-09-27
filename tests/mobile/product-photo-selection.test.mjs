import test from 'node:test';
import assert from 'node:assert/strict';
import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';
import {
  comboSlots,
  replaceComboSlot,
  hasPhotoPilot,
  setExtraQuantity,
  recommendedExtras,
  largeSauceOffer,
  comboCompanions,
  photoCartLimit,
} from '../../apps/mobile/src/product-photo-selection.ts';
import { defaultSelections, lineUnitPrice, validSelections } from '../../apps/mobile/src/domain.ts';
const item = testCompleteCatalog.products.find((p) => p.id === 'finger-duo');
const product = { ...item, priceMinor: item.price_minor, modifierGroups: item.modifier_groups };
const drink = product.modifierGroups.find((g) => g.id === 'drink');
const sauce = product.modifierGroups.find((g) => g.id === 'sauce');
test('only owner-selected combo and burger use the pilot', () => {
  assert.equal(hasPhotoPilot('burger'), true);
  assert.equal(hasPhotoPilot('finger-duo'), true);
  assert.equal(hasPhotoPilot('pick-combo'), false);
});
test('each duo slot replaces one drink and preserves sauces, extras and input', () => {
  const initial = [
    ...defaultSelections(product),
    { group_id: 'extras', option_id: 'fingers', quantity: 1 },
  ];
  const before = initial.map((selection) => ({ ...selection }));
  const next = replaceComboSlot(initial, drink, 0, 'lemonade');
  assert.deepEqual(initial, before);
  assert.deepEqual(comboSlots(drink, next), ['lemonade', 'cola-bottle']);
  assert.deepEqual(comboSlots(sauce, next), ['pick', 'pick']);
  assert.ok(next.some((s) => s.group_id === 'extras' && s.quantity === 1));
  assert.equal(
    BigInt(lineUnitPrice({ product, selections: next })) -
      BigInt(lineUnitPrice({ product, selections: initial })),
    20000n,
  );
  assert.equal(validSelections(product, next), true);
});
test('second replacement and switching back merge counts without duplication', () => {
  const first = replaceComboSlot(defaultSelections(product), drink, 0, 'lemonade');
  const both = replaceComboSlot(first, drink, 1, 'lemonade');
  assert.equal(both.filter((s) => s.group_id === 'drink').length, 1);
  assert.equal(both.find((s) => s.group_id === 'drink').quantity, 2);
  assert.equal(
    BigInt(lineUnitPrice({ product, selections: both })) - BigInt(product.priceMinor),
    40000n,
  );
  const restored = replaceComboSlot(both, drink, 0, 'cola-bottle');
  assert.deepEqual(comboSlots(drink, restored), ['cola-bottle', 'lemonade']);
});
test('stop list, unknown option, slot bounds and per-option limit are respected', () => {
  const initial = defaultSelections(product);
  for (const [index, id] of [
    [0, 'fuse-watermelon'],
    [0, 'missing'],
    [-1, 'lemonade'],
    [2, 'lemonade'],
  ])
    assert.equal(replaceComboSlot(initial, drink, index, id), initial);
  const limited = { ...drink, options: drink.options.map((o) => ({ ...o, max_quantity: 1 })) };
  const once = replaceComboSlot(initial, limited, 0, 'lemonade');
  assert.equal(replaceComboSlot(once, limited, 1, 'lemonade'), once);
});
test('sauce replacement is independent and missing required choices remain visible', () => {
  const initial = defaultSelections(product);
  const next = replaceComboSlot(initial, sauce, 1, 'hot');
  assert.deepEqual(comboSlots(drink, next), ['cola-bottle', 'cola-bottle']);
  assert.deepEqual(comboSlots(sauce, next), ['pick', 'hot']);
  assert.deepEqual(comboSlots(drink, []), [null, null]);
  assert.equal(validSelections(product, replaceComboSlot([], drink, 0, 'lemonade')), false);
});
test('Burger Duo keeps two drinks and sauces and prices one replacement', () => {
  assert.equal(hasPhotoPilot('burger-duo'), true);
  const item = testCompleteCatalog.products.find((p) => p.id === 'burger-duo');
  const duo = { ...item, priceMinor: item.price_minor, modifierGroups: item.modifier_groups };
  const group = duo.modifierGroups.find((g) => g.id === 'drink');
  const sauces = duo.modifierGroups.find((g) => g.id === 'sauce');
  const initial = defaultSelections(duo);
  const next = replaceComboSlot(initial, group, 1, 'lemonade');
  assert.deepEqual(comboSlots(group, next), ['cola-bottle', 'lemonade']);
  assert.deepEqual(comboSlots(sauces, next), ['pick', 'pick']);
  assert.equal(lineUnitPrice({ product: duo, selections: initial }), '699000');
  assert.equal(lineUnitPrice({ product: duo, selections: next }), '719000');
  assert.equal(validSelections(duo, next), true);
});

test('paid extras add and remove independently and update the combo price', () => {
  const extras = product.modifierGroups.find((g) => g.id === 'extras');
  const initial = defaultSelections(product);
  const added = setExtraQuantity(initial, extras, 'fingers', 2);
  assert.deepEqual(comboSlots(drink, added), comboSlots(drink, initial));
  assert.equal(
    BigInt(lineUnitPrice({ product, selections: added })) - BigInt(product.priceMinor),
    138000n,
  );
  assert.equal(validSelections(product, added), true);
  assert.deepEqual(setExtraQuantity(added, extras, 'fingers', 0), initial);
  assert.equal(
    initial.some((s) => s.group_id === 'extras'),
    false,
  );
});
test('extra limits reject excess and stopped additions but allow removing stopped food', () => {
  const extras = product.modifierGroups.find((g) => g.id === 'extras');
  const initial = defaultSelections(product);
  for (const n of [-1, 0.5, 11])
    assert.equal(setExtraQuantity(initial, extras, 'fingers', n), initial);
  assert.equal(setExtraQuantity(initial, extras, 'unknown', 1), initial);
  const one = setExtraQuantity(initial, extras, 'fingers', 1);
  assert.equal(setExtraQuantity(one, { ...extras, max: 1 }, 'toast', 1), one);
  const stopped = { ...extras, options: extras.options.map((o) => ({ ...o, available: false })) };
  assert.equal(setExtraQuantity(one, stopped, 'fingers', 2), one);
  assert.deepEqual(setExtraQuantity(one, stopped, 'fingers', 0), initial);
});

const allProducts = testCompleteCatalog.products.map((p) => ({
  ...p,
  priceMinor: p.price_minor,
  modifierGroups: p.modifier_groups,
}));
test('all catalog extras remain available with food first and small signature sauce editable', () => {
  const extras = product.modifierGroups.find((g) => g.id === 'extras');
  const result = recommendedExtras(extras, []);
  assert.equal(result[0].id, 'fingers');
  assert.deepEqual(
    new Set(result.map((o) => o.id)),
    new Set(extras.options.filter((o) => o.id !== 'sauce').map((o) => o.id)),
  );
  const selected = [
    ...defaultSelections(product),
    { group_id: 'extras', option_id: 'sauce', quantity: 1 },
  ];
  assert.ok(recommendedExtras(extras, selected).some((o) => o.id === 'sauce'));
  assert.equal(
    recommendedExtras(extras, setExtraQuantity(selected, extras, 'sauce', 0)).some(
      (o) => o.id === 'sauce',
    ),
    false,
  );
});
test('Finger Duo recommends the real burger; Burger Duo does not recommend another burger', () => {
  const finger = comboCompanions('finger-duo', allProducts);
  assert.deepEqual(
    finger.map((line) => line.product.id),
    ['burger', 'sauce'],
  );
  assert.equal(lineUnitPrice(finger[0]), '239000');
  assert.deepEqual(
    comboCompanions('burger-duo', allProducts).map((line) => line.product.id),
    ['sauce'],
  );
  assert.deepEqual(comboCompanions('burger', allProducts), []);
  assert.deepEqual(comboCompanions('finger-duo', []), []);
});
test('multiple companions reserve all cart slots and reject overflow before adding any line', () => {
  const main = { product, selections: defaultSelections(product), quantity: 2 };
  const additions = comboCompanions('finger-duo', allProducts).map((line) => ({
    ...line,
    quantity: 2,
  }));
  const others = Array.from({ length: 9 }, (_, i) => ({
    product: { ...product, id: `other-${i}` },
    selections: [],
    quantity: 1,
  }));
  assert.ok(photoCartLimit(others, main, undefined, additions));
  assert.equal(photoCartLimit(others.slice(1), main, undefined, additions), null);
  assert.ok(photoCartLimit([{ ...additions[0], quantity: 19 }], main, undefined, additions));
  const amount = [main, ...additions].reduce(
    (sum, line) => sum + BigInt(lineUnitPrice(line)) * BigInt(line.quantity),
    0n,
  );
  assert.equal(amount, 2314000n);
});
test('large sauce is the real 300ml catalog variant at 1190, never the small extra', () => {
  const offer = largeSauceOffer(allProducts);
  assert.equal(offer.product.id, 'sauce');
  assert.deepEqual(offer.selections, [{ group_id: 'size', option_id: 'size-1', quantity: 1 }]);
  assert.equal(lineUnitPrice(offer), '119000');
  assert.equal(validSelections(offer.product, offer.selections), true);
  assert.equal(largeSauceOffer([]), null);
  const stopped = {
    ...offer.product,
    modifierGroups: offer.product.modifierGroups.map((g) => ({
      ...g,
      options: g.options.map((o) => ({ ...o, available: o.id !== 'size-1' })),
    })),
  };
  assert.equal(largeSauceOffer([stopped]), null);
});
test('combo plus large sauce reserves both cart slots and enforces quantity limits', () => {
  const main = { product, selections: defaultSelections(product), quantity: 1 };
  const sauce = largeSauceOffer(allProducts);
  const others = Array.from({ length: 10 }, (_, i) => ({
    product: { ...product, id: `other-${i}` },
    selections: [],
    quantity: 1,
  }));
  assert.ok(photoCartLimit(others, main, undefined, sauce));
  assert.equal(photoCartLimit(others.slice(1), main, undefined, sauce), null);
  assert.equal(photoCartLimit([...others.slice(1), main], main, main, sauce), null);
  assert.ok(photoCartLimit([{ ...sauce, quantity: 20 }], main, undefined, sauce));
  assert.equal(photoCartLimit([{ ...sauce, quantity: 19 }], main, undefined, sauce), null);
});
