import test from 'node:test';
import assert from 'node:assert/strict';
import { cartLocationName } from '../../apps/mobile/src/cart-location.ts';

test('compact branch names preserve the selected location identity', () => {
  assert.equal(cartLocationName('ТЦ Abay Plaza'), 'Abay Plaza');
  assert.equal(cartLocationName('ТРЦ Dostyk Plaza'), 'Dostyk Plaza');
  assert.equal(cartLocationName('PickChick - Саялы'), 'PickChick - Саялы');
  assert.equal(cartLocationName('ТЦентр'), 'ТЦентр');
  assert.equal(cartLocationName('ТЦ '), 'ТЦ');
});

test('a missing name never shows another restaurant as a fallback', () => {
  for (const name of [null, undefined, '', '   ']) assert.equal(cartLocationName(name), '');
});
