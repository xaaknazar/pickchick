import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCALES,
  LOCALE_LABELS,
  copy,
  dictionariesForTest,
  itemCount,
} from '../../apps/kiosk/src/i18n.ts';
import { localizedText, relabelCatalog } from '../../apps/kiosk/src/commercial-controller.ts';

test('kiosk offers KZ / RU / EN in the order of the v3 switch', () => {
  assert.deepEqual([...LOCALES], ['kk', 'ru', 'en']);
  assert.deepEqual(
    LOCALES.map((l) => LOCALE_LABELS[l].short),
    ['KZ', 'RU', 'EN'],
  );
});

test('every UI string exists and is non-empty in all three locales', () => {
  const keys = Object.keys(dictionariesForTest.ru).sort();
  for (const locale of LOCALES) {
    const dictionary = dictionariesForTest[locale];
    assert.deepEqual(Object.keys(dictionary).sort(), keys, `${locale}: key set differs from ru`);
    for (const key of keys)
      assert.ok(dictionary[key].trim().length > 0, `${locale}.${key} is empty`);
    assert.equal(copy(locale), dictionary);
  }
});

test('English copy is English and follows the owner hyphen rule', () => {
  const en = copy('en');
  assert.equal(en.orderNow, 'ORDER NOW');
  assert.equal(en.modeTitle, 'Where will you eat?');
  assert.equal(en.included, 'Included');
  assert.equal(en.checkout, 'Checkout');
  for (const locale of LOCALES)
    for (const [key, value] of Object.entries(copy(locale)))
      assert.doesNotMatch(value, /[–—]/, `${locale}.${key} uses a long dash`);
  for (const [key, value] of Object.entries(en))
    assert.doesNotMatch(value, /[А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]/, `en.${key} is not translated`);
});

test('item counts are pluralised per locale', () => {
  assert.equal(itemCount(1, 'ru'), '1 позиция');
  assert.equal(itemCount(3, 'ru'), '3 позиции');
  assert.equal(itemCount(5, 'ru'), '5 позиций');
  assert.equal(itemCount(12, 'ru'), '12 позиций');
  assert.equal(itemCount(3, 'kk'), '3 позиция');
  assert.equal(itemCount(1, 'en'), '1 item');
  assert.equal(itemCount(3, 'en'), '3 items');
});

test('catalog texts use the active locale with en -> ru and kk -> ru fallback', () => {
  const text = { ru: 'Соус', kk: 'Тұздық' };
  assert.equal(localizedText(text, 'ru'), 'Соус');
  assert.equal(localizedText(text, 'kk'), 'Тұздық');
  assert.equal(localizedText(text, 'en'), 'Соус');
  assert.equal(localizedText({ ru: 'Соус', kk: ' ' }, 'kk'), 'Соус');
  assert.equal(localizedText({ ...text, en: 'Sauce' }, 'en'), 'Sauce');
});

test('relabelling keeps availability, prices and photos and only swaps texts', () => {
  const product = (name, label, available) => ({
    id: 'p1',
    sku: 'S1',
    name,
    description: name + ' d',
    category: 'Комбо',
    price_minor: '100',
    available,
    serving_label: '-',
    ingredients: '',
    media: { url: 'x' },
    modifier_groups: [
      { id: 'g1', title: name + ' g', min: 0, max: 1, options: [{ id: 'o1', label, available }] },
    ],
  });
  const target = { branch_id: 'b', catalog_version: '1', products: [product('Ру', 'Ру о', false)] };
  const source = { branch_id: 'b', catalog_version: '1', products: [product('En', 'En o', true)] };
  const out = relabelCatalog(target, source);
  assert.equal(out.products[0].name, 'En');
  assert.equal(out.products[0].modifier_groups[0].title, 'En g');
  assert.equal(out.products[0].modifier_groups[0].options[0].label, 'En o');
  assert.equal(out.products[0].available, false);
  assert.equal(out.products[0].modifier_groups[0].options[0].available, false);
  assert.equal(out.products[0].category, 'Комбо');
  assert.deepEqual(out.products[0].media, { url: 'x' });
  assert.equal(target.products[0].name, 'Ру');
});

test('payment wording follows the approved v3 prototype (T.payWith, T.step1-3)', () => {
  assert.equal(copy('en').payKaspiQR, 'Pay with Kaspi QR');
  assert.equal(copy('ru').payKaspiQR, 'Оплата через Kaspi QR');
  assert.equal(copy('en').qrStep1, 'Open the Kaspi.kz app');
  assert.equal(copy('en').qrStep2, 'Tap «Kaspi QR»');
  assert.equal(copy('en').qrStep3, 'Point the camera at the code');
  assert.equal(copy('ru').qrStep1, 'Откройте приложение Kaspi.kz');
  assert.equal(copy('ru').qrStep2, 'Нажмите «Kaspi QR»');
  assert.equal(copy('kk').qrStep1, 'Kaspi.kz қосымшасын ашыңыз');
  assert.equal(copy('kk').qrStep2, '«Kaspi QR» басыңыз');
});

test('guest components take their text from the dictionary, not from a ru/kk branch', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const src = new URL('../../apps/kiosk/src/', import.meta.url);
  const files = ['presentation.ts'];
  for (const dir of ['components/', 'screens/'])
    for (const name of await readdir(new URL(dir, src)))
      if (/\.tsx?$/.test(name) && !name.includes('.stories.')) files.push(dir + name);
  // EnrollmentForm is the staff-only device setup, shown before any guest picks a language.
  const allowed = new Set(['components/EnrollmentForm.tsx']);
  const offenders = [];
  for (const file of files) {
    if (allowed.has(file)) continue;
    const text = await readFile(new URL(file, src), 'utf8');
    if (/locale\s*[!=]==\s*'(ru|kk)'/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'these files would show Kazakh text to an English guest');
});
