import test from 'node:test';
import assert from 'node:assert/strict';
import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';
import { mockupCatalogDraft } from '@pickchick/catalog-admin/seed';
import {
  initialSize,
  isSizeGroup,
  opensInSheet,
  sheetFacts,
  sheetLineId,
  sheetRoom,
  sheetSelections,
  sheetSizeGroup,
  sheetUnitMinor,
} from '../../apps/kiosk/src/productSheet.ts';
import { defaultSelections, testLineId } from '../../apps/kiosk/src/cart.ts';
import { publishedKioskCatalog } from '../../apps/kiosk/src/commercial-controller.ts';
import { sheetCopy, sheetTableForTest } from '../../apps/kiosk/src/sheetCopy.ts';

const clone = (value) => globalThis.structuredClone(value);
const products = testCompleteCatalog.products;
const byId = (id, catalog = products) => clone(catalog.find((p) => p.id === id));
const size = (overrides = {}) => ({
  id: 'size',
  title: 'Размер соуса',
  min: 1,
  max: 1,
  options: [
    {
      id: 's',
      label: '60 мл',
      available: true,
      price_delta_minor: '0',
      default_quantity: 1,
      max_quantity: 1,
    },
    {
      id: 'm',
      label: '0,3 л',
      available: true,
      price_delta_minor: '80000',
      default_quantity: 0,
      max_quantity: 1,
    },
  ],
  ...overrides,
});

test('extras and drinks without a choice, and sauces with one size choice, open the sheet', () => {
  const sheet = products.filter(opensInSheet).map((p) => p.id);
  assert.deepEqual(sheet.sort(), [
    'burger',
    'cola',
    'coleslaw',
    'fingers',
    'fuse-peach',
    'iced-tea',
    'lemonade',
    'piko',
    'sauce',
    'sauce-hot',
    'toast',
    'water',
    'wedges',
  ]);
  // Combos, duos and company sets keep the product page.
  for (const p of products.filter((p) => ['Комбо', 'На двоих', 'На компанию'].includes(p.category)))
    assert.equal(opensInSheet(p), false, p.id);
  assert.equal(sheetSizeGroup(byId('sauce')).id, 'size');
  assert.equal(sheetSizeGroup(byId('toast')), null);
});

test('the published commercial catalog (catalog-admin seed) follows the same rule', () => {
  const catalog = publishedKioskCatalog({
    branch: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    channel: 'kiosk',
    version: 1,
    payload: mockupCatalogDraft,
  });
  const sheet = new Set(catalog.products.filter(opensInSheet).map((p) => p.id));
  for (const id of ['sauce', 'sauce-hot', 'toast', 'burger', 'lemonade', 'cola'])
    assert.ok(sheet.has(id), id);
  for (const id of ['pick-combo', 'master-combo', 'finger-duo', 'fingers-25'])
    assert.ok(!sheet.has(id), id);
});

test('anything that would hide a choice keeps the product page', () => {
  const toast = byId('toast');
  // A flavour (not a size), optional add-ons, two groups, five sizes, an optional size.
  const flavour = size({
    id: 'piko-flavor',
    title: 'Вкус',
    options: size().options.map((o, i) => ({ ...o, label: ['Яблоко', 'Апельсин'][i] })),
  });
  assert.equal(opensInSheet({ ...toast, modifier_groups: [flavour] }), false);
  assert.equal(opensInSheet({ ...toast, modifier_groups: [size({ min: 0, max: 3 })] }), false);
  assert.equal(
    opensInSheet({ ...toast, modifier_groups: [size(), size({ id: 'size-2' })] }),
    false,
  );
  const five = size({
    options: Array.from({ length: 5 }, (_, i) => ({ ...size().options[1], id: 'o' + i })),
  });
  assert.equal(opensInSheet({ ...toast, modifier_groups: [five] }), false);
  assert.equal(opensInSheet({ ...toast, modifier_groups: [size({ min: 0 })] }), false);
  // A combo with a size-only group still opens its page.
  assert.equal(opensInSheet({ ...byId('pick-combo'), modifier_groups: [size()] }), false);
  // Any other catalog category falls into «Допы» (a separate «Соусы» category, for example).
  assert.equal(opensInSheet({ ...toast, category: 'Соусы' }), true);
});

test('a size is recognised by id, title (RU/KZ/EN) or measure labels', () => {
  const anon = (labels, title = 'Выбор') => ({
    ...size({ id: '6f1c2c1e-0000-4000-8000-000000000001', title }),
    options: labels.map((label, i) => ({ ...size().options[0], id: 'o' + i, label })),
  });
  assert.ok(isSizeGroup(anon(['60 мл', '0,3 л', '0.5 L', '250 г'])));
  assert.ok(isSizeGroup(anon(['Маленький', 'Большой'], 'Объём')));
  assert.ok(isSizeGroup(anon(['Кіші', 'Үлкен'], 'Өлшемі')));
  assert.ok(isSizeGroup(anon(['Small', 'Large'], 'Size')));
  assert.ok(!isSizeGroup(anon(['Маленький', 'Большой'])));
  assert.ok(!isSizeGroup(anon(['Яблоко', '0,5 л'])));
});

test('the sheet builds the product page selections, price and cart line', () => {
  const sauce = byId('sauce');
  // The product page starts from the catalog defaults; the sheet's default choice is identical.
  assert.deepEqual(
    sheetSelections(sauce, initialSize(sheetSizeGroup(sauce))),
    defaultSelections(sauce),
  );
  assert.deepEqual(sheetSelections(sauce, 'size-1'), [
    { group_id: 'size', option_id: 'size-1', quantity: 1 },
  ]);
  assert.deepEqual(sheetSelections(byId('toast'), null), defaultSelections(byId('toast')));
  assert.equal(sheetUnitMinor(sauce, 'size-0'), '39000');
  assert.equal(sheetUnitMinor(sauce, 'size-1'), '119000');
  assert.equal(sheetUnitMinor(byId('toast'), null), '39000');
  assert.equal(sheetLineId(sauce, 'size-1'), testLineId('sauce', sheetSelections(sauce, 'size-1')));
  // A stopped default gives way to the first available size; none left means no choice.
  const group = sheetSizeGroup(sauce);
  group.options[0].available = false;
  assert.equal(initialSize(group), 'size-1');
  for (const option of group.options) option.available = false;
  assert.equal(initialSize(group), null);
});

test('the quantity keeps to the cart room of that exact line, as on the product page', () => {
  const line = 'sauce|size:size-0:1';
  assert.deepEqual(sheetRoom(line, [], 0), { room: 20, limit: null });
  assert.deepEqual(sheetRoom(line, [{ lineId: line, quantity: 18 }], 1), { room: 2, limit: null });
  assert.deepEqual(sheetRoom(line, [{ lineId: line, quantity: 20 }], 1), {
    room: 0,
    limit: 'line',
  });
  // Distinct lines never consume the room of another configuration.
  assert.deepEqual(sheetRoom(line, [], 100), { room: 20, limit: null });
  assert.deepEqual(sheetRoom(line, [{ lineId: line, quantity: 3 }], 11), { room: 17, limit: null });
});

test('«60 мл · 230 ккал · КБЖУ» comes from catalog data and omits what it does not know', () => {
  const sauce = byId('sauce');
  assert.deepEqual(sheetFacts(sauce, 'size-0'), {
    serving: '60 мл',
    kcal: 230,
    per100g: false,
    macros: { protein: 1, fat: 23, carbs: 4 },
  });
  // Another size: its label, and its energy by the catalog's multiplier for that size (x5)...
  assert.equal(sheetSizeGroup(sauce).options[1].nutrition_multiplier, 5);
  assert.deepEqual(sheetFacts(sauce, 'size-1'), {
    serving: '0,3 л',
    kcal: 1150,
    per100g: false,
    macros: { protein: 5, fat: 115, carbs: 20 },
  });
  // ...and none at all without one.
  delete sheetSizeGroup(sauce).options[1].nutrition_multiplier;
  assert.deepEqual(sheetFacts(sauce, 'size-1'), {
    serving: '0,3 л',
    kcal: null,
    per100g: false,
    macros: null,
  });
  const toast = byId('toast');
  assert.deepEqual(sheetFacts(toast, null).serving, '40 г');
  assert.equal(sheetFacts({ ...toast, serving_label: '-' }, null).serving, null);
  const per100 = { ...toast, nutrition: { ...toast.nutrition, basis: 'per_100_g' } };
  assert.equal(sheetFacts(per100, null).per100g, true);
  assert.equal(sheetFacts({ ...toast, nutrition: null }, null).kcal, null);
});

test('sheet strings exist in RU/KZ/EN with plain hyphens only', () => {
  const keys = Object.keys(sheetTableForTest.ru).sort();
  for (const locale of ['ru', 'kk', 'en']) {
    assert.deepEqual(Object.keys(sheetTableForTest[locale]).sort(), keys, locale);
    for (const [key, value] of Object.entries(sheetCopy(locale))) {
      assert.ok(value.trim(), `${locale}.${key}`);
      assert.doesNotMatch(value, /[–—]/, `${locale}.${key} uses a long dash`);
    }
  }
  for (const value of Object.values(sheetTableForTest.en))
    assert.doesNotMatch(value, /[А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]/);
  assert.equal(sheetCopy('ru').size, 'Размер');
  assert.equal(sheetCopy('xx').toCart, 'В корзину');
});
