// Owner 23.11.2026: combo drinks show their volume one way, sauces say «60 мл», KBJU of zeros
// is hidden, sauce pots step by size.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  drinkOptionText,
  hasNutrition,
  sauceOptionText,
  servingLine,
} from '../../apps/kiosk/src/product-presentation.ts';
import { sauceFill } from '../../apps/kiosk/src/menu-presentation.ts';

test('a combo drink takes its menu name: title, volume and can / bottle', () => {
  assert.deepEqual(drinkOptionText('Фанта жб', 'Fanta (в железной банке) — 0.5 л', 'ru'), {
    name: 'Fanta',
    caption: '0.5 л · банка',
  });
  assert.deepEqual(
    drinkOptionText('Ice Tea', 'Фирменный холодный чай (сладкий / несладкий) — 0.5 л', 'ru'),
    { name: 'Фирменный холодный чай', caption: '0.5 л' },
  );
  assert.deepEqual(drinkOptionText('Fuse Tea Персик 0.5 л', 'Fuse Tea Персик — 0.5 л', 'en'), {
    name: 'Fuse Tea Персик',
    caption: '0.5 л',
  });
});

test('a combo drink without a menu item is read from its label', () => {
  assert.deepEqual(drinkOptionText('Piko Яблоко 0.2 л', undefined, 'ru'), {
    name: 'Piko Яблоко',
    caption: '0.2 л',
  });
  assert.deepEqual(drinkOptionText('Фьюс лимон 0,5', undefined, 'ru'), {
    name: 'Фьюс лимон',
    caption: '0.5 л',
  });
  assert.deepEqual(drinkOptionText('Coca-Cola 0.5 л, бутылка', undefined, 'kk'), {
    name: 'Coca-Cola',
    caption: '0.5 л · бөтелке',
  });
  assert.deepEqual(drinkOptionText('Фирменный холодный чай, сладкий', undefined, 'ru'), {
    name: 'Холодный чай',
    caption: 'сладкий',
  });
});

test('every sauce says 60 мл, without the brand', () => {
  assert.deepEqual(sauceOptionText('Фирменный соус Pick Chick', 'ru'), {
    name: 'Фирменный соус',
    caption: '60 мл',
  });
  assert.deepEqual(sauceOptionText('Кетчуп', 'en'), { name: 'Кетчуп', caption: '60 ml' });
  assert.deepEqual(sauceOptionText('Фирменный соус 60 г', 'ru').caption, '60 мл');
});

test('KBJU of zeros is not shown, a real value is', () => {
  const zero = { energy_kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 };
  assert.equal(hasNutrition({ nutrition: zero }), false);
  assert.equal(hasNutrition({ nutrition: null }), false);
  assert.equal(servingLine({ serving_label: '480 г', nutrition: zero }, 'ккал'), '480 г');
  const real = { ...zero, energy_kcal: 1140 };
  assert.equal(hasNutrition({ nutrition: real }), true);
  assert.equal(
    servingLine({ serving_label: '480 г', nutrition: real }, 'ккал'),
    '480 г · 1140 ккал',
  );
});

test('sauce pots step by size, other products fill their photo area', () => {
  const fill = (id, name) => sauceFill({ id, name });
  assert.ok(fill('sauce', 'Фирменный соус 60 г') < fill('sauce-300', 'Фирменный соус 300 г'));
  assert.ok(fill('sauce-300', 'Соус 300 г') < fill('sauce-400', 'Соус 400 г'));
  assert.ok(fill('sauce-cheese-400', 'Сырный 400 г') < fill('sauce-cheese-500', 'Сырный 500 г'));
  assert.equal(fill('fingers', 'Фингерс 1 шт'), 1);
});
