// Lane bo-ui stock P1 in the cabinet (design-bo-ui 5.2, 5.4; design-backoffice 5 «Остатки»): the
// gate, the storno preview and its blockers, quick waste tiles, the waste report CSV and the
// sales notice. Pure functions of the built cabinet, no PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RIGHTS_TEXT,
  commandPermission,
  permitted,
  rightsText,
  stockP1,
} from '../../apps/backoffice/dist/operations-model.js';
import {
  REVERSIBLE_KINDS,
  addQuickWaste,
  csvQuantity,
  documentDetail,
  lastCount,
  quickWasteField,
  quickWasteTiles,
  reversalBlocker,
  reversalPreview,
  reversalState,
  stockDocumentsCsv,
  stockKindLabel,
  stockSalesNotice,
  wasteReasonLabel,
  wasteReasonLabelP1,
  wasteReportCsv,
} from '../../apps/backoffice/dist/inventory-model.js';
import { auditAction } from '../../apps/backoffice/dist/audit-model.js';
import { ApiError, message } from '../../apps/backoffice/dist/api.js';

const BUN = '00000000-0000-4000-8000-000000000001';
const FILLET = '00000000-0000-4000-8000-000000000002';
const stock = [
  {
    id: BUN,
    payload: { name: 'Синтетическая булка', unit: 'pcs', minimum: '0', active: true },
    quantity: '10',
    value_minor: '10000',
    revision: 4,
    counted_at: null,
  },
  {
    id: FILLET,
    payload: {
      name: 'Синтетическое филе',
      unit: 'g',
      minimum: '0',
      active: true,
      quick_waste: { label: 'Мясо', quantity: '500' },
    },
    quantity: '2000',
    value_minor: '200000',
    revision: 7,
    counted_at: '2026-11-19T14:00:00.000Z',
  },
];
const receipt = {
  id: '00000000-0000-4000-8000-0000000000aa',
  kind: 'receipt',
  reference: 'NAK-1',
  reason: 'Поставка пекарни',
  created_at: '2026-11-19T15:00:00.000Z',
  actor_name: 'Синтетический управляющий',
  reason_code: null,
  meta: {
    supplier_kind: 'bakery',
    supplier_name: 'Синтетическая пекарня',
    document_date: '2026-11-19',
  },
  reversed_by: null,
  reversed_at: null,
  reverses: null,
  lines: [
    {
      ingredient_id: BUN,
      name: 'Синтетическая булка',
      unit: 'pcs',
      quantity_delta: '8',
      value_delta_minor: '8000',
    },
  ],
};

test('stock P1 gate, permission and rights text', () => {
  assert.equal(stockP1(null), false);
  assert.equal(stockP1({ capabilities: { stock_v2: true } }), false);
  assert.equal(stockP1({ capabilities: { stock_v2: true, stock_p1: true } }), true);
  assert.equal(commandPermission({ type: 'stock_reverse' }), 'stock.reverse');
  // Without permissions[] the grant decides (manager writes); with roles the server's list.
  assert.equal(permitted({ role: 'manager' }, 'stock.reverse'), true);
  assert.equal(permitted({ role: 'analyst' }, 'stock.reverse'), false);
  assert.equal(
    permitted({ role: 'analyst', permissions: ['reports.read', 'stock.reverse'] }, 'stock.reverse'),
    true,
  );
  assert.equal(RIGHTS_TEXT['stock.reverse'], 'Сторно делают управляющий и бухгалтер.');
  assert.equal(
    rightsText({ permissions: ['reports.read'] }, 'stock.reverse'),
    'Сторно делают управляющий и бухгалтер.',
  );
  assert.deepEqual(auditAction('stock_reverse'), { section: 'Склад', text: 'Сторно документа' });
  for (const reason of ['REVERSAL_NOT_ALLOWED', 'ALREADY_REVERSED', 'COUNTED_AFTER_DOCUMENT']) {
    const text = message(new ApiError('CONFLICT', 409, reason));
    assert.match(text, /[а-я]/, reason);
    assert.doesNotMatch(text, /[—–]/);
  }
  assert.deepEqual([...REVERSIBLE_KINDS], ['receipt', 'waste', 'production', 'consumption']);
});

test('storno preview: the exact opposite against today, revisions, refusals named', () => {
  const ok = reversalPreview(receipt, stock);
  assert.equal(ok.error, null);
  assert.deepEqual(ok.command, {
    type: 'stock_reverse',
    document_id: receipt.id,
    expected_balances: { [BUN]: 4 },
  });
  assert.deepEqual(ok.lines, [
    {
      ingredient_id: BUN,
      name: 'Синтетическая булка',
      unit: 'pcs',
      before: '10',
      delta: '-8',
      after: '2',
      value_delta: '-8000',
      ok: true,
    },
  ]);
  // Two buns received at 1000, 12 wasted since: not enough to take 8 back.
  const short = reversalPreview(receipt, [{ ...stock[0], quantity: '6', value_minor: '6000' }]);
  assert.equal(short.lines[0].ok, false);
  assert.match(short.error, /^Синтетическая булка: остаток или его стоимость уже меньше/);
  // Quantity to zero with a value left (moving average) is refused like the server does.
  const value = reversalPreview(receipt, [{ ...stock[0], quantity: '8', value_minor: '9000' }]);
  assert.equal(value.lines[0].ok, false);
  // A waste storno adds back and is always possible.
  const waste = {
    ...receipt,
    kind: 'waste',
    reason_code: 'defect',
    meta: null,
    lines: [{ ...receipt.lines[0], quantity_delta: '-3', value_delta_minor: '-3000' }],
  };
  assert.deepEqual(
    reversalPreview(waste, stock).lines.map((l) => [l.after, l.value_delta, l.ok]),
    [['13', '3000', true]],
  );
});

test('storno blockers: count, storno, done once, counted after the document', () => {
  assert.equal(reversalBlocker(receipt, stock), null);
  assert.match(reversalBlocker({ ...receipt, kind: 'count' }, stock), /новой инвентаризацией/);
  assert.match(reversalBlocker({ ...receipt, kind: 'reversal' }, stock), /Это сторно/);
  assert.match(reversalBlocker({ ...receipt, kind: 'transfer' }, stock), /не сторнируется/);
  assert.match(
    reversalBlocker(
      { ...receipt, reversed_by: 'x', reversed_at: '2026-11-20T04:30:00.000Z' },
      stock,
    ),
    /уже сторнирован 20\.11\.2026 09:30/,
  );
  assert.match(reversalBlocker({ ...receipt, lines: [] }, stock), /нет движений/);
  // The fillet was counted at 19:00 Almaty; a fillet document of 18:00 is blocked, of 20:00 not.
  const fillet = {
    ...receipt,
    lines: [{ ...receipt.lines[0], ingredient_id: FILLET, unit: 'g' }],
  };
  assert.match(
    reversalBlocker({ ...fillet, created_at: '2026-11-19T13:00:00.000Z' }, stock),
    /провели инвентаризацию/,
  );
  assert.equal(reversalBlocker({ ...fillet, created_at: '2026-11-19T15:00:00.000Z' }, stock), null);
});

test('quick waste: tiles of active ingredients, a press adds in base units, editor fields', () => {
  const tiles = quickWasteTiles([
    ...stock,
    {
      id: 'x',
      payload: {
        name: 'Синтетика',
        unit: 'pcs',
        active: false,
        quick_waste: { label: 'Нет', quantity: '1' },
      },
    },
  ]);
  assert.deepEqual(tiles, [{ ingredient_id: FILLET, label: 'Мясо', quantity: '500', unit: 'g' }]);
  const tile = tiles[0];
  // The first press replaces the empty line, the next ones add up; kg are converted.
  let lines = [{ ingredient_id: '', quantity: '', unit: 'pcs', cost: '' }];
  lines = addQuickWaste(lines, tile);
  assert.deepEqual(lines, [{ ingredient_id: FILLET, quantity: '500', unit: 'g', cost: '' }]);
  lines = addQuickWaste(lines, tile);
  assert.equal(lines[0].quantity, '1000');
  lines = addQuickWaste([{ ingredient_id: FILLET, quantity: '1,2', unit: 'kg', cost: '' }], tile);
  assert.deepEqual(lines, [{ ingredient_id: FILLET, quantity: '1700', unit: 'g', cost: '' }]);
  lines = addQuickWaste([{ ingredient_id: BUN, quantity: '2', unit: 'pcs', cost: '' }], tile);
  assert.equal(lines.length, 2);
  assert.equal(
    addQuickWaste([{ ingredient_id: FILLET, quantity: 'abc', unit: 'g', cost: '' }], tile)[0]
      .quantity,
    '500',
  );
  assert.equal(quickWasteField('', ' '), null);
  assert.deepEqual(quickWasteField(' Фингерсы из шкафа ', '5'), {
    label: 'Фингерсы из шкафа',
    quantity: '5',
  });
  assert.throws(() => quickWasteField('Фри', '0'), /больше нуля/);
  assert.throws(() => quickWasteField('Фри', '1,5'), /целое число/);
  assert.throws(() => quickWasteField('', '5'), /от 1 до 40/);
  assert.throws(() => quickWasteField('я'.repeat(41), '5'), /от 1 до 40/);
});

test('labels: old waste, kinds, document detail, storno state, last count, sales notice', () => {
  assert.equal(wasteReasonLabel(null), 'Без причины');
  assert.equal(wasteReasonLabelP1(null), 'Без кода причины (до включения склада v2)');
  assert.equal(wasteReasonLabelP1('hot_cabinet_expired'), 'Тепловой шкаф: старше 50 минут');
  assert.equal(stockKindLabel('reversal'), 'Сторно');
  assert.equal(documentDetail(receipt), 'Пекарня, Синтетическая пекарня, накладная от 19.11.2026');
  assert.equal(
    documentDetail({ kind: 'waste', reason_code: null }),
    'Без кода причины (до включения склада v2)',
  );
  assert.equal(
    documentDetail({
      kind: 'reversal',
      reverses: {
        kind: 'waste',
        reference: 'W-1',
        reason_code: 'damaged',
        created_at: '2026-11-19T04:05:00.000Z',
      },
    }),
    'Сторно: Списание «W-1» от 19.11.2026 09:05, Упало / повреждено',
  );
  assert.equal(documentDetail({ kind: 'count' }), '-');
  assert.equal(reversalState(receipt), '-');
  assert.equal(
    reversalState({ reversed_by: 'x', reversed_at: '2026-11-20T04:30:00.000Z' }),
    'Сторнирован 20.11.2026 09:30',
  );
  assert.equal(lastCount(stock[0]), 'Подсчёта не было');
  assert.equal(lastCount(stock[1]), '19.11.2026 19:00');
  assert.match(stockSalesNotice(), /^Продажи пока не списываются со склада автоматически/);
  assert.doesNotMatch(stockSalesNotice(), /Последний подсчёт/);
  assert.match(stockSalesNotice('off', true), /«Последний подсчёт»/);
  assert.match(stockSalesNotice('dry_run', true), /режиме проверки/);
  assert.equal(stockSalesNotice('on', true), null);
  for (const text of [stockSalesNotice(), stockSalesNotice('dry_run', true)])
    assert.doesNotMatch(text, /[—–]/);
});

test('waste report CSV: exact totals in tenge, negative storno sums stay numbers, formulas defused', () => {
  const report = {
    start_date: '2026-11-18',
    end_date: '2026-11-19',
    totals: { documents: 4, reversals: 2, value_minor: '600000' },
    summary: {
      by_reason: [
        { reason_code: 'damaged', documents: 1, reversals: 1, value_minor: '0' },
        { reason_code: null, documents: 1, reversals: 0, value_minor: '100050' },
      ],
      by_day: [{ day: '2026-11-19', documents: 3, reversals: 2, value_minor: '-400000' }],
      by_ingredient: [{ name: '=Синтетика', unit: 'g', quantity: '-1500', value_minor: '-3000' }],
      by_author: [
        { actor_name: 'Синтетический управляющий', documents: 2, reversals: 2, value_minor: '0' },
      ],
    },
  };
  const rows = wasteReportCsv(report);
  assert.deepEqual(rows[0], ['Списания за период', '18.11.2026 - 19.11.2026']);
  assert.deepEqual(rows[1], ['Документов списания', 'Сторно', 'Сумма, ₸']);
  assert.deepEqual(rows[2], ['4', '2', '6000,00']);
  assert.deepEqual(rows[5], ['Упало / повреждено', '1', '1', '0,00']);
  assert.deepEqual(rows[6], ['Без кода причины (до включения склада v2)', '1', '0', '1000,50']);
  assert.deepEqual(rows[9], ['19.11.2026', '3', '2', '-4000,00']);
  assert.deepEqual(rows[12], ["'=Синтетика", '-1,5', 'кг', '-30,00']);
  assert.deepEqual(rows[15], ['Синтетический управляющий', '2', '2', '0,00']);
  assert.deepEqual(csvQuantity('12', 'pcs'), ['12', 'шт']);
  assert.deepEqual(csvQuantity('1500', 'ml'), ['1,5', 'л']);
  const lines = stockDocumentsCsv([receipt]);
  assert.equal(lines[0][7], 'Сумма, ₸');
  assert.deepEqual(lines[1], [
    '19.11.2026 20:00',
    'NAK-1',
    'Поставка',
    'Пекарня, Синтетическая пекарня, накладная от 19.11.2026',
    'Синтетическая булка',
    '8',
    'шт',
    '80,00',
    'Синтетический управляющий',
    'Поставка пекарни',
    '-',
  ]);
});
