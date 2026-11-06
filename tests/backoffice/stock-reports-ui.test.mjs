// Lane bo-ui step 8 in the cabinet (design-bo-ui 5.2, 5.4, 5.6): the report tabs «Расхождения
// подсчёта» and «Расход по продажам», «Подсчёт на закрытии» of the count_daily positions, the
// ingredient group and the recipe stock policy. Pure functions of the built cabinet, no PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { allowedPath, reasonMessage } from '../../apps/backoffice/dist/api.js';
import { allowed } from '../../apps/backoffice/server.mjs';
import {
  INGREDIENT_GROUP_OPTIONS,
  RECIPE_POLICY_OPTIONS,
  consumptionReportCsv,
  consumptionSourceLabel,
  keyCountLines,
  signedQuantity,
  varianceReportCsv,
} from '../../apps/backoffice/dist/inventory-model.js';
import { checkText } from '../../apps/backoffice/dist/manager-shift-model.js';
import { stockReport } from '../../apps/backoffice/dist/operations-model.js';

const LONG_DASH = /[–—]/;
const card = (name, extra = {}) => ({
  id: randomUUID(),
  quantity: '0',
  value_minor: '0',
  revision: 1,
  payload: { name, unit: 'pcs', minimum: '0', active: true, ...extra },
});

test('closing count: the used count_daily positions by group, then name, as empty lines', () => {
  const bun = card('Булка', { count_daily: true, group: 'semi' });
  const meat = card('Мясо', { count_daily: true, group: 'raw', unit: 'g' });
  const box = card('Коробка', { count_daily: true });
  const off = card('Соус старый', { count_daily: true, active: false });
  const plain = card('Фри', { group: 'raw' });
  assert.deepEqual(keyCountLines([plain, box, off, bun, meat]), [
    { ingredient_id: meat.id, quantity: '', unit: 'g', cost: '' },
    { ingredient_id: bun.id, quantity: '', unit: 'pcs', cost: '' },
    { ingredient_id: box.id, quantity: '', unit: 'pcs', cost: '' },
  ]);
  assert.deepEqual(keyCountLines([plain]), []);
  assert.deepEqual(
    INGREDIENT_GROUP_OPTIONS.map((o) => o.value),
    ['raw', 'semi', 'packaging', 'drink', 'household', 'other'],
  );
  assert.deepEqual(
    RECIPE_POLICY_OPTIONS.map((o) => o.value),
    ['', 'explode', 'stock'],
  );
  for (const o of [...INGREDIENT_GROUP_OPTIONS, ...RECIPE_POLICY_OPTIONS])
    assert.doesNotMatch(o.label, LONG_DASH);
});

test('variance and consumption: words, signed quantities and CSV in tenge', () => {
  assert.equal(signedQuantity('-2', 'pcs'), '-2 шт');
  assert.equal(signedQuantity('500', 'g'), '+0,5 кг');
  assert.equal(signedQuantity('0', 'ml'), '0 л');
  assert.deepEqual(['pos', 'cloud', 'manual'].map(consumptionSourceLabel), [
    'Касса',
    'Приложение и киоск',
    'Вручную по техкартам заказа',
  ]);
  const variance = varianceReportCsv({
    start_date: '2026-11-18',
    end_date: '2026-11-19',
    totals: {
      documents: 2,
      items: 2,
      shortage_value_minor: '20000',
      surplus_value_minor: '10050',
      delta_value_minor: '-9950',
    },
    summary: {
      rows: [
        {
          name: '=Булка',
          unit: 'pcs',
          counts: 2,
          expected: '8',
          counted: '9',
          delta_quantity: '-1',
          delta_value_minor: '-10000',
          last_counted_at: '2026-11-19T17:30:00.000Z',
        },
        {
          name: 'Филе',
          unit: 'g',
          counts: 1,
          expected: '5000',
          counted: '5500',
          delta_quantity: '500',
          delta_value_minor: '50',
          last_counted_at: '2026-11-18T17:00:00.000Z',
        },
      ],
      by_day: [
        {
          day: '2026-11-19',
          documents: 2,
          items: 2,
          shortage_value_minor: '20000',
          surplus_value_minor: '10050',
          delta_value_minor: '-9950',
        },
      ],
    },
  });
  assert.deepEqual(variance[0], ['Расхождения подсчёта за период', '18.11.2026 - 19.11.2026']);
  assert.deepEqual(variance[2], ['2', '2', '200,00', '100,50', '-99,50']);
  assert.deepEqual(variance[4], [
    'Ингредиент',
    'Подсчётов',
    'Ожидалось',
    'Посчитано',
    'Разница',
    'Единица',
    'Сумма, ₸',
    'Последний подсчёт',
  ]);
  // A name that starts like a formula is neutralised; quantities in kg with a comma.
  assert.equal(variance[5][0].startsWith('='), false);
  assert.deepEqual(variance[5].slice(1, 7), ['2', '8', '9', '-1', 'шт', '-100,00']);
  assert.deepEqual(variance[6].slice(1, 7), ['1', '5', '5,5', '0,5', 'кг', '0,50']);
  assert.match(variance[5][7], /^19\.11\.2026 /);
  assert.deepEqual(variance[9], ['19.11.2026', '2', '2', '200,00', '100,50', '-99,50']);
  const consumption = consumptionReportCsv({
    start_date: '2026-11-19',
    end_date: '2026-11-19',
    totals: { documents: 3, reversals: 1, value_minor: '123400' },
    summary: {
      by_source: [
        { source: 'pos', documents: 2, reversals: 1, value_minor: '100000' },
        { source: 'cloud', documents: 1, reversals: 0, value_minor: '23400' },
      ],
      by_day: [{ day: '2026-11-19', documents: 3, reversals: 1, value_minor: '123400' }],
      by_ingredient: [{ name: 'Булка', unit: 'pcs', quantity: '12', value_minor: '123400' }],
    },
  });
  assert.deepEqual(consumption.slice(0, 3), [
    ['Расход по продажам за период', '19.11.2026 - 19.11.2026'],
    ['Документов', 'Сторно', 'Сумма, ₸'],
    ['3', '1', '1234,00'],
  ]);
  assert.deepEqual(consumption[5], ['Касса', '2', '1', '1000,00']);
  assert.deepEqual(consumption[6], ['Приложение и киоск', '1', '0', '234,00']);
  assert.deepEqual(consumption.at(-1), ['Булка', '12', 'шт', '1234,00']);
  for (const row of [...variance, ...consumption])
    for (const cell of row) assert.doesNotMatch(cell, LONG_DASH);
});

test('the report answer is checked for the view asked for', () => {
  const branch = randomUUID();
  const answer = {
    schema_version: 1,
    branch_id: branch,
    view: 'variance',
    totals: {},
    summary: { rows: [], by_day: [] },
    documents: [],
    truncated: false,
  };
  assert.equal(stockReport(answer, branch, 'variance').view, 'variance');
  assert.throws(() => stockReport(answer, branch, 'consumption'), /INVALID_RESPONSE/);
  assert.throws(
    () => stockReport({ ...answer, summary: { rows: {} } }, branch, 'variance'),
    /INVALID_RESPONSE/,
  );
});

test('proxy and cabinet allowlists: the two new stock views, nothing else', () => {
  const branch = randomUUID();
  for (const view of ['waste', 'movement', 'variance', 'consumption']) {
    const q = `view=${view}&start_date=2026-11-13&end_date=2026-11-19`;
    assert.equal(
      allowed('GET', `/v1/admin/backoffice/branches/${branch}/ops/stock?${q}`),
      true,
      view,
    );
    assert.equal(allowedPath(`operations/branches/${branch}/ops/stock?${q}`), true, view);
  }
  for (const q of [
    'view=sales&start_date=2026-11-13&end_date=2026-11-19',
    'view=variance&start_date=2026-11-13',
    'view=variance&start_date=2026-11-13&end_date=2026-11-19&scope=daily_key',
  ]) {
    assert.equal(allowed('GET', `/v1/admin/backoffice/branches/${branch}/ops/stock?${q}`), false);
    assert.equal(allowedPath(`operations/branches/${branch}/ops/stock?${q}`), false);
  }
});

test('words: RECIPE_POLICY_EXPLODE and the key count check of the manager shift', () => {
  assert.match(reasonMessage('RECIPE_POLICY_EXPLODE'), /Списывать сам выход/);
  // Review BOUI-R1: a linked output without a chosen policy is not produced either.
  assert.match(reasonMessage('RECIPE_POLICY_UNSET'), /не выбран «Выход техкарты при продаже»/);
  assert.equal(
    checkText('key_count', {
      status: 'problem',
      facts: {
        documents: 1,
        items: 3,
        last_at: '2026-11-19T17:30:00.000Z',
        key_items: 3,
        key_counted: 1,
        key_missing: ['Булка', 'Мясо'],
        key_missing_count: 2,
      },
    }),
    'Не посчитаны ключевые позиции: 2 из 3 (Булка, Мясо). Проведите «Подсчёт на закрытии» в «Остатки» или поясните.',
  );
  assert.equal(
    checkText('key_count', {
      status: 'ok',
      facts: {
        documents: 2,
        items: 3,
        last_at: '2026-11-19T17:30:00.000Z',
        key_items: 3,
        key_counted: 3,
        key_missing: [],
        key_missing_count: 0,
      },
    }),
    'Ключевые позиции посчитаны: 3 из 3, последний подсчёт в 22:30.',
  );
  assert.match(
    checkText('key_count', {
      status: 'problem',
      facts: { key_items: 12, key_missing: ['А', 'Б'], key_missing_count: 11 },
    }),
    /11 из 12 \(А, Б и другие\)/,
  );
  // Without key positions the step 6 text stays.
  assert.equal(
    checkText('key_count', {
      status: 'no_data',
      facts: { documents: 0, items: 0, last_at: null },
    }),
    'Подсчёта за день нет. Проведите инвентаризацию ключевых позиций в «Остатки».',
  );
});
