// Product card of the kiosk redesign 2026-10-13 (docs/design/kiosk-redesign-2026-10-13/
// product-and-payment.md §1-2): composition pills, option names, the drink grid with «Ещё N»,
// drink shelves of the sheet, the panel summary and the copy in three languages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testCompleteCatalog } from '@pickchick/test-order-flow/complete-catalog';
import {
  DRINK_SHELVES,
  applyPick,
  cardGroups,
  chooseText,
  compositionPills,
  drinkShelf,
  drinkShelves,
  firstMissing,
  gridColumns,
  groupComplete,
  includedLabel,
  kindLabel,
  optionGrid,
  optionText,
  picked,
  pickedNames,
  productBadge,
  productKind,
  sectionTitle,
  selectionSummary,
  servingLine,
  surchargeMinor,
} from '../../apps/kiosk/src/product-presentation.ts';
import { productCopy, productCopyTable } from '../../apps/kiosk/src/productCopy.ts';
import { defaultSelections, selectedPriceMinor } from '../../apps/kiosk/src/cart.ts';

const products = testCompleteCatalog.products;
const product = (id) => products.find((p) => p.id === id);
const pick = product('pick-combo');
const drinks = pick.modifier_groups.find((g) => g.id === 'drink');
const sauces = pick.modifier_groups.find((g) => g.id === 'sauce');
const ru = productCopy('ru');
const ids = (options) => options.map((option) => option.id);

test('option labels split into the tile name and caption of the design', () => {
  const cases = {
    'Coca-Cola 0.5 л, бутылка': ['Coca-Cola 0.5 л', 'бутылка'],
    'Фирменный лимонад 0.5 л': ['Лимонад 0.5 л', 'фирменный'],
    'Fuse Tea Персик 0.5 л': ['Fuse Tea 0.5 л', 'персик'],
    'Coca-Cola 0.5 л, банка': ['Coca-Cola 0.5 л', 'банка'],
    'Coca-Cola Zero 0.5 л, бутылка': ['Coca-Cola Zero', '0.5 л, бутылка'],
    'Фирменный холодный чай, сладкий': ['Холодный чай', 'сладкий'],
    'Fuse Tea Манго-Ромашка 0.5 л': ['Fuse Tea 0.5 л', 'манго-ромашка'],
    'Bonaqua негазированная 0.5 л': ['Bonaqua 0.5 л', 'негазированная'],
    'Piko 0.2 л': ['Piko 0.2 л', ''],
    'Piko Яблоко 0.2 л': ['Piko 0.2 л', 'яблоко'],
    'Coca-Cola Zero Лайм 0.5 л': ['Coca-Cola Zero', '0.5 л, лайм'],
    'Фирменный соус Pick Chick': ['Фирменный соус', 'Pick Chick'],
    'Острый соус Pick Chick': ['Острый соус', 'Pick Chick'],
    'Heinz сырный': ['Heinz сырный', ''],
    '60 мл': ['60 мл', ''],
    '0,3 л': ['0,3 л', ''],
    'Фингерс, 1 шт': ['Фингерс', '1 шт'],
    'Фирмалық лимонад 0.5 л': ['Лимонад 0.5 л', 'фирмалық'],
    'Signature lemonade 0.5 l': ['Lemonade 0.5 l', 'signature'],
    'Iced tea — sweet.': ['Iced tea - sweet', ''],
  };
  for (const [label, [name, caption]] of Object.entries(cases))
    assert.deepEqual(optionText(label), { name, caption }, label);
  // Every catalog option keeps a non-empty name, never longer than its label.
  for (const p of products)
    for (const group of p.modifier_groups)
      for (const option of group.options) {
        const text = optionText(option.label);
        assert.ok(text.name.length > 0, option.label);
        assert.ok(text.name.length <= option.label.length, option.label);
      }
  assert.deepEqual(optionText(''), { name: '', caption: '' });
  assert.deepEqual(optionText('   '), { name: '', caption: '' });
  assert.deepEqual(optionText('Фирменный'), { name: 'Фирменный', caption: '' });
});

test('composition pills come from the list in the ingredients', () => {
  assert.deepEqual(compositionPills(pick.ingredients), [
    '4 фингерса',
    'фри',
    'соус',
    'тост',
    'коулслоу',
    'напиток',
  ]);
  assert.deepEqual(compositionPills(product('master-combo').ingredients), [
    '6 фингерсов',
    'фри',
    '2 соуса',
    '2 тоста',
    'коулслоу',
    'напиток',
  ]);
  assert.deepEqual(compositionPills(product('burger-combo').ingredients), [
    'бургер',
    'фри',
    'соус',
    'напиток',
  ]);
  // The list after "Сытное комбо для двоих:"; "1,5" is a number, not a separator.
  assert.deepEqual(compositionPills(product('finger-duo').ingredients), [
    '8 фингерсов',
    '1,5 порции картофельных долек',
    '2 соуса',
    '2 порции коулслоу',
    '2 тоста',
    '2 напитка',
  ]);
  // A lone phrase between full stops is skipped ("Сет на 20-22 человека.").
  assert.deepEqual(compositionPills(product('fingers-75').ingredients), [
    '75 фингерсов',
    '24 соуса',
  ]);
  assert.deepEqual(compositionPills('4 фингерс, фри және сусын'), ['4 фингерс', 'фри', 'сусын']);
  assert.deepEqual(compositionPills('4 fingers, fries, 1 sauce and a drink of your choice'), [
    '4 fingers',
    'fries',
    'sauce',
    'a drink',
  ]);
});

test('prose gives no pills, so the card shows the description', () => {
  for (const id of ['fingers', 'toast', 'coleslaw', 'burger', 'lemonade', 'iced-tea', 'water'])
    assert.deepEqual(compositionPills(product(id).ingredients || product(id).description), [], id);
  // A list mixed with prose is shown whole rather than as a partial list.
  assert.deepEqual(compositionPills(product('burger-duo').ingredients), []);
  for (const text of ['', '   ', ':', '.', ', , ,', '1, 2, 3', 'и и и', '—', 'Соус'])
    assert.deepEqual(compositionPills(text), [], JSON.stringify(text));
});

test('composition pills are capped and never repeat', () => {
  const long = Array.from({ length: 12 }, (_, i) => `${i + 2} соуса`).join(', ');
  assert.equal(compositionPills(long).length, 8);
  assert.equal(compositionPills(long, 3).length, 3);
  assert.deepEqual(compositionPills('2 соуса, 2 Соуса, тост'), ['2 соуса', 'тост']);
  for (const p of products)
    for (const item of compositionPills(p.ingredients || p.description)) {
      assert.ok(item.split(' ').length <= 4, item);
      assert.ok(item.length <= 30, item);
      assert.doesNotMatch(item, /[–—]|на выбор/u, item);
    }
});

test('the drink grid shows nine drinks and «Ещё N» when more do not fit', () => {
  assert.equal(gridColumns(drinks), 5);
  assert.equal(gridColumns(sauces), 4);
  const grid = optionGrid(drinks.options, ['cola-bottle'], 10);
  assert.equal(drinks.options.length, 14);
  assert.deepEqual(ids(grid.shown), ids(drinks.options.slice(0, 9)));
  assert.deepEqual(ids(grid.hidden), ids(drinks.options.slice(9)));
  assert.equal(grid.hidden.length, 5, '«Ещё 5»');
});

test('a drink picked in the sheet takes slot 9, the rest keep catalog order', () => {
  const grid = optionGrid(drinks.options, ['piko'], 10);
  assert.deepEqual(ids(grid.shown), [...ids(drinks.options.slice(0, 8)), 'piko']);
  assert.deepEqual(ids(grid.hidden), [
    'iced-tea-unsweet',
    'fuse-berry',
    'fuse-watermelon',
    'fuse-mango',
    'water',
  ]);
  assert.equal(grid.shown.length + grid.hidden.length, drinks.options.length);
  // Two hidden picks (a duo) take slots 8 and 9; a visible pick keeps its place.
  const duo = optionGrid(drinks.options, ['water', 'piko'], 10);
  assert.deepEqual(ids(duo.shown).slice(7), ['water', 'piko']);
  const kept = optionGrid(drinks.options, ['iced-tea-unsweet', 'piko'], 10);
  assert.equal(kept.shown[8].id, 'iced-tea-unsweet', 'already in slot 9');
  assert.equal(kept.shown[7].id, 'piko', 'the hidden pick takes the slot before it');
  assert.deepEqual(new Set(ids(kept.shown)).size, 9);
});

test('ten options or fewer are all shown without the «Ещё» tile', () => {
  for (const count of [0, 1, 4, 9, 10]) {
    const grid = optionGrid(drinks.options.slice(0, count), [], 10);
    assert.equal(grid.shown.length, count);
    assert.equal(grid.hidden.length, 0);
  }
  assert.equal(optionGrid(drinks.options.slice(0, 11), [], 10).hidden.length, 2);
  assert.deepEqual(ids(optionGrid(sauces.options, ['bbq'], 8).shown), ids(sauces.options));
});

test('drinks stand on three shelves by option id', () => {
  const expected = {
    'cola-bottle': 'soda',
    'cola-can': 'soda',
    'cola-zero': 'soda',
    fanta: 'soda',
    sprite: 'soda',
    cola: 'soda',
    'fuse-peach': 'tea',
    'fuse-berry': 'tea',
    'fuse-watermelon': 'tea',
    'fuse-mango': 'tea',
    'iced-tea': 'tea',
    'iced-tea-sweet': 'tea',
    'iced-tea-unsweet': 'tea',
    lemonade: 'other',
    water: 'other',
    piko: 'other',
    'piko-apple': 'other',
    'piko-orange': 'other',
    juice: 'other',
    'mango-smoothie': 'other',
    colada: 'other',
    teapot: 'other',
  };
  for (const [id, shelf] of Object.entries(expected)) assert.equal(drinkShelf(id), shelf, id);
  assert.deepEqual(DRINK_SHELVES, ['soda', 'tea', 'other']);
  const shelves = drinkShelves(drinks.options);
  assert.deepEqual(
    shelves.map((entry) => [entry.shelf, ids(entry.options)]),
    [
      ['soda', ['cola-bottle', 'cola-can', 'fanta', 'sprite', 'cola-zero']],
      [
        'tea',
        [
          'fuse-peach',
          'iced-tea-sweet',
          'iced-tea-unsweet',
          'fuse-berry',
          'fuse-watermelon',
          'fuse-mango',
        ],
      ],
      ['other', ['lemonade', 'water', 'piko']],
    ],
  );
  assert.deepEqual(
    drinkShelves([{ id: 'water' }, { id: 'lemonade' }]).map((entry) => entry.shelf),
    ['other'],
    'empty shelves are left out',
  );
});

test('the extras list left the card; required choices are numbered sections', () => {
  for (const p of products) {
    const groups = cardGroups(p);
    assert.ok(!groups.some((g) => g.id === 'extras'), p.id);
    assert.deepEqual(
      groups.map((g) => g.id),
      p.modifier_groups.filter((g) => g.min > 0).map((g) => g.id),
      p.id,
    );
  }
  assert.deepEqual(ids(cardGroups(pick)), ['drink', 'sauce']);
  assert.deepEqual(ids(cardGroups(product('fingers-25'))), ['sauce']);
  assert.deepEqual(ids(cardGroups(product('sauce'))), ['size']);
  const optional = { modifier_groups: [{ id: 'side', min: 0, max: 1, options: [] }] };
  assert.equal(cardGroups(optional).length, 1, 'an optional single choice stays');
});

test('the panel summary and section values follow the picks', () => {
  const groups = cardGroups(pick);
  const base = defaultSelections(pick);
  assert.equal(selectionSummary(groups, base), 'Coca-Cola 0.5 л · Фирменный соус');
  assert.equal(firstMissing(groups, base), undefined);
  const lemonade = applyPick(drinks, base, 'lemonade', 1);
  assert.deepEqual(
    lemonade.filter((s) => s.group_id === 'drink'),
    [{ group_id: 'drink', option_id: 'lemonade', quantity: 1 }],
    'a single choice replaces the pick',
  );
  assert.equal(selectionSummary(groups, lemonade), 'Лимонад 0.5 л · Фирменный соус');
  assert.equal(surchargeMinor(picked(drinks, lemonade)), '20000');
  assert.equal(surchargeMinor(picked(sauces, lemonade)), '0');
  // The panel price: 4 190 ₸ by default, 4 390 ₸ with the lemonade, times the quantity.
  assert.equal(selectedPriceMinor(pick, base), '419000');
  assert.equal(selectedPriceMinor(pick, lemonade), '439000');
  const noSauce = applyPick(sauces, lemonade, 'pick', 0);
  assert.equal(selectionSummary(groups, noSauce), 'Лимонад 0.5 л');
  assert.equal(firstMissing(groups, noSauce)?.id, 'sauce');
  assert.equal(chooseText(firstMissing(groups, noSauce), ru), 'Выберите соус');
  assert.equal(groupComplete(sauces, noSauce), false);
  // A stopped pick no longer counts.
  const stopped = { ...sauces, options: sauces.options.map((o) => ({ ...o, available: false })) };
  assert.equal(groupComplete(stopped, base), false);
  assert.deepEqual(picked(stopped, base), []);
});

test('several picks of a group are counted', () => {
  const duo = product('finger-duo');
  const groups = cardGroups(duo);
  const base = defaultSelections(duo);
  assert.equal(selectionSummary(groups, base), 'Coca-Cola 0.5 л × 2 · Фирменный соус × 2');
  const sauce = groups.find((g) => g.id === 'sauce');
  const mixed = applyPick(sauce, applyPick(sauce, base, 'pick', 1), 'hot', 1);
  assert.equal(pickedNames(picked(sauce, mixed)), 'Фирменный соус, Острый соус');
  assert.equal(groupComplete(sauce, mixed), true);
  const three = [
    { option: { label: 'A' }, text: 'A' },
    { option: { label: 'B' }, text: 'B' },
    { option: { label: 'C' }, text: 'C' },
    { option: { label: 'D' }, text: 'D' },
  ];
  assert.equal(pickedNames(three), 'A, B +2');
  assert.equal(pickedNames([]), '');
});

test('section titles, kinds, badges and the serving line', () => {
  assert.equal(sectionTitle(drinks, ru), 'Напиток');
  assert.equal(sectionTitle(sauces, ru), 'Соус');
  assert.equal(sectionTitle(cardGroups(product('master-combo'))[1], ru), 'Соусы');
  assert.equal(sectionTitle(product('sauce').modifier_groups[0], productCopy('en')), 'Size');
  assert.equal(sectionTitle({ id: 'x', title: 'Гарнир на выбор', max: 1 }, ru), 'Гарнир');
  assert.equal(productKind('Комбо'), 'combo');
  assert.equal(productKind('На двоих'), 'duo');
  assert.equal(productKind('На компанию'), 'set');
  assert.equal(productKind('Напитки'), 'drink');
  assert.equal(productKind('Допы'), 'side');
  assert.equal(productKind('Новая категория'), 'side');
  assert.equal(kindLabel('combo', ru), 'Комбо');
  assert.equal(includedLabel('combo', ru), 'Входит в комбо');
  assert.equal(includedLabel('duo', ru), 'Входит в комбо');
  assert.equal(includedLabel('set', ru), 'Входит в набор');
  assert.equal(includedLabel('side', ru), 'Без доплаты');
  assert.deepEqual(productBadge('pick-combo'), { label: 'hit', tone: 'hit' });
  assert.deepEqual(productBadge('master-combo'), { label: 'hit', tone: 'hit' });
  assert.deepEqual(productBadge('finger-duo'), { label: 'hitDuo', tone: 'hit' });
  assert.deepEqual(productBadge('solo-combo'), { label: 'newTag', tone: 'new' });
  assert.deepEqual(productBadge('fingers-25'), { label: 'hitSets', tone: 'hit' });
  assert.equal(productBadge('burger-duo'), null);
  assert.equal(servingLine(pick, 'ккал'), '520 г · 1240 ккал');
  assert.equal(
    servingLine({ serving_label: '-', nutrition: { energy_kcal: 90 } }, 'kcal'),
    '90 kcal',
  );
});

test('product card copy exists in RU, KZ and EN with the owner hyphen rule', () => {
  const keys = Object.keys(productCopyTable.ru).sort();
  for (const locale of ['ru', 'kk', 'en']) {
    const table = productCopyTable[locale];
    assert.deepEqual(Object.keys(table).sort(), keys, locale);
    for (const [key, value] of Object.entries(table)) {
      assert.ok(value.trim(), `${locale}.${key} is empty`);
      assert.doesNotMatch(value, /[–—]/, `${locale}.${key} uses a long dash`);
    }
    assert.equal(productCopy(locale), table);
  }
  for (const [key, value] of Object.entries(productCopyTable.en))
    assert.doesNotMatch(value, /[А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]/, `en.${key} is not translated`);
  assert.equal(productCopy('de'), productCopyTable.ru, 'unknown locale falls back to Russian');
  assert.equal(ru.more.replace('{n}', '4'), 'Ещё 4');
  assert.equal(ru.includedIn.replace('{product}', 'Pick Combo'), 'Входит в Pick Combo');
});
