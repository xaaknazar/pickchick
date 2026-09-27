import test from 'node:test';
import assert from 'node:assert/strict';
import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';
import {
  comboSlots,
  replaceComboSlot,
  hasPhotoPilot,
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
