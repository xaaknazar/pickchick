import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  BACKOFFICE_P2_PERMISSIONS,
  P2Request,
  P2_COMMAND_FLAGS,
  P2_COMMAND_PERMISSIONS,
  P2_ROLE_PERMISSIONS,
  SUPPLY_PERMISSIONS,
  SupplierPayloadSchema,
  SupplyRequestPayloadSchema,
  can,
  expectedAmount,
  permissionsOf,
  requestView,
  supplierKindFor,
  supplyDifference,
  supplyHint,
  supplyQuantity,
  supplyRequestText,
} from '../dist/index.js';

/** Pure parts of the supply step (lane bo-ui2 step 2, supply.ts, p2-commands.ts). Synthetic. */
const LONG_DASH = /[–—]/;

test('expected amount: quantity × price of one purchase unit, half up, one rounding per line', () => {
  assert.equal(expectedAmount('1500', '250000', 'kg'), 375000n);
  assert.equal(expectedAmount('1500', '333', 'kg'), 500n); // 499,5 -> 500
  assert.equal(expectedAmount('1499', '333', 'kg'), 499n); // 499,167 -> 499
  assert.equal(expectedAmount('1', '100', 'kg'), 0n); // 0,1 -> 0: no price on the line
  assert.equal(expectedAmount('20', '1500', 'pcs'), 30000n);
  assert.equal(expectedAmount('750', '120000', 'l'), 90000n);
  assert.equal(expectedAmount('3', '7', 'g'), 21n);
});

test('hint: minimum - balance, never below zero, none without a minimum', () => {
  assert.equal(supplyHint('10', '4'), '6');
  assert.equal(supplyHint('10', '14'), '0');
  assert.equal(supplyHint('10', '10'), '0');
  assert.equal(supplyHint('0', '4'), null);
});

test('quantities in the text: kg and l from 1000, decimal comma, groups of three', () => {
  assert.equal(supplyQuantity('1500', 'g'), '1,5 кг');
  assert.equal(supplyQuantity('1000', 'g'), '1 кг');
  assert.equal(supplyQuantity('1250', 'ml'), '1,25 л');
  assert.equal(supplyQuantity('250', 'g'), '250 г');
  assert.equal(supplyQuantity('999', 'ml'), '999 мл');
  assert.equal(supplyQuantity('30', 'pcs'), '30 шт');
  assert.equal(supplyQuantity('12000', 'pcs'), '12 000 шт');
  assert.equal(supplyQuantity('1234567', 'g'), '1 234,567 кг');
});

test('who delivers: the central kitchen and the bakery their own kinds, a supplier the others', () => {
  assert.equal(supplierKindFor('central_kitchen'), 'central_kitchen');
  assert.equal(supplierKindFor('bakery'), 'bakery');
  assert.equal(supplierKindFor('household'), 'supplier');
  assert.equal(supplierKindFor('supplier'), 'supplier');
});

test('payloads: a supplier name is collapsed and trimmed, an empty note is none', () => {
  assert.equal(
    SupplierPayloadSchema.parse({ name: ' Поставщик \n 1 ', kind: 'supplier', active: true }).name,
    'Поставщик 1',
  );
  const p = SupplyRequestPayloadSchema.parse({ kind: 'bakery', note: '   ', lines: [] });
  assert.deepEqual(p, {
    kind: 'bakery',
    supplier_id: null,
    needed_by: null,
    note: null,
    lines: [],
  });
  assert.equal(
    SupplyRequestPayloadSchema.parse({ kind: 'bakery', note: ' Две\nстроки ', lines: [] }).note,
    'Две\nстроки',
  );
  assert.equal(
    SupplyRequestPayloadSchema.safeParse({ kind: 'bakery', note: 'a'.repeat(501), lines: [] })
      .success,
    false,
  );
  assert.equal(
    SupplyRequestPayloadSchema.safeParse({ kind: 'bakery', needed_by: '2023-12-31', lines: [] })
      .success,
    false,
  );
});

test('permissions: the matrix of step 2 and the order of permissions[]', () => {
  assert.deepEqual(
    [...BACKOFFICE_P2_PERMISSIONS],
    ['suppliers.write', 'supply.write', 'supply.close'],
  );
  assert.deepEqual([...SUPPLY_PERMISSIONS], [...BACKOFFICE_P2_PERMISSIONS]);
  const matrix = Object.fromEntries(
    ['manager', 'shift_manager', 'accountant', 'analyst'].map((role) => [
      role,
      BACKOFFICE_P2_PERMISSIONS.filter((p) => can(role, p)),
    ]),
  );
  assert.deepEqual(matrix, {
    manager: ['suppliers.write', 'supply.write', 'supply.close'],
    shift_manager: ['supply.write'],
    accountant: ['suppliers.write'],
    analyst: [],
  });
  assert.deepEqual(P2_ROLE_PERMISSIONS.manager, BACKOFFICE_P2_PERMISSIONS);
  // Receiving posts a stock receipt: both rights; the shift manager and the accountant have
  // stock.receipt (P0) but not supply.close.
  assert.deepEqual(P2_COMMAND_PERMISSIONS.supply_request_receive, [
    'supply.close',
    'stock.receipt',
  ]);
  for (const role of ['shift_manager', 'accountant']) {
    assert.equal(can(role, 'stock.receipt'), true);
    assert.equal(can(role, 'supply.close'), false);
  }
  for (const flags of Object.values(P2_COMMAND_FLAGS))
    assert.deepEqual([...flags], ['supplyEnabled', 'stockV2Enabled']);
  // Without p2 the list is exactly the one before (P0 then P1).
  assert.deepEqual(permissionsOf('manager', ['discounts.write']), [
    ...permissionsOf('manager'),
    'discounts.write',
  ]);
  assert.deepEqual(permissionsOf('manager', ['discounts.write'], SUPPLY_PERMISSIONS).slice(-4), [
    'discounts.write',
    'suppliers.write',
    'supply.write',
    'supply.close',
  ]);
  assert.deepEqual(permissionsOf('shift_manager', [], SUPPLY_PERMISSIONS).slice(-1), [
    'supply.write',
  ]);
});

test('the P2 envelope: strict, every command by its schema', () => {
  const ok = (command) =>
    P2Request.safeParse({ request_id: randomUUID(), reason: 'Синтетика', command }).success;
  const id = randomUUID();
  assert.equal(ok({ type: 'supply_request_submit', id, expected_revision: 1 }), true);
  assert.equal(ok({ type: 'supply_request_submit', id, expected_revision: 0 }), false);
  assert.equal(ok({ type: 'supply_request_cancel', id, expected_revision: 1, reason: 'x' }), false);
  assert.equal(
    ok({
      type: 'supply_request_receive',
      id,
      expected_revision: 2,
      reference: 'НАК-1',
      document_date: '2026-11-19',
      lines: [{ ingredient_id: id, quantity: '1', value_minor: '0', expected_revision: 0 }],
    }),
    true,
  );
  assert.equal(
    ok({
      type: 'supply_request_receive',
      id,
      expected_revision: 2,
      reference: 'НАК-1',
      document_date: '2026-11-19',
      lines: [],
    }),
    false,
  );
  assert.equal(ok({ type: 'stock_reverse', document_id: id, expected_balances: {} }), false);
});

const row = (over = {}) => ({
  id: '0b000000-0000-4000-8000-000000000001',
  number: 12,
  kind: 'bakery',
  state: 'submitted',
  supplier_id: '0b000000-0000-4000-8000-000000000002',
  supplier_name: 'Пекарня 1',
  supplier_kind: 'bakery',
  supplier_active: true,
  needed_by: '2026-11-20',
  note: 'К 07:00',
  lines: [
    { ingredient_id: 'a', unit: 'pcs', qty: '30', balance_at_request: '4', hint: '6' },
    {
      ingredient_id: 'b',
      unit: 'g',
      qty: '1500',
      balance_at_request: '0',
      hint: null,
      price_minor: '375000',
    },
  ],
  receipt_document_id: null,
  revision: 3,
  created_by_name: 'Синтетический управляющий',
  created_at: new Date('2026-11-19T04:30:00Z'),
  submitted_by_name: 'Синтетический управляющий',
  submitted_at: new Date('2026-11-19T04:31:00Z'),
  closed_by_name: null,
  closed_at: null,
  ...over,
});
const names = new Map([
  ['a', { name: 'Синтетическая булка', unit: 'pcs' }],
  ['b', { name: 'Синтетическое филе', unit: 'g' }],
]);
const request = (over = {}) => requestView(row(over), names);

test('the request view and its text for print and copy', () => {
  const r = request();
  assert.equal(r.total_minor, '375000');
  assert.equal(r.unpriced_lines, 1);
  assert.equal(r.cancel_reason, null);
  const text = supplyRequestText(r);
  assert.equal(
    text,
    [
      'Заявка № 12 от 19.11.2026 в пекарню',
      'Нужно к: 20.11.2026',
      'Поставщик: Пекарня 1',
      'Примечание: К 07:00',
      '',
      '1. Синтетическая булка - 30 шт',
      '2. Синтетическое филе - 1,5 кг',
      '',
      'Позиций: 2',
    ].join('\n'),
  );
  assert.doesNotMatch(text, LONG_DASH);
  // No price in the text: the supplier names his own.
  assert.doesNotMatch(text, /₸|3750/);
  assert.match(
    supplyRequestText(request({ state: 'draft', needed_by: null, note: null, supplier_id: null })),
    /^Заявка № 12 от 19\.11\.2026 в пекарню \(черновик\)\nНужно к: не указано\n\n1\./,
  );
  // An evening request after midnight is still dated by Almaty.
  assert.match(
    supplyRequestText(request({ created_at: new Date('2026-11-19T19:30:00Z') })),
    /^Заявка № 12 от 20\.11\.2026/,
  );
  assert.equal(request({ state: 'cancelled' }).cancel_reason, null);
  assert.equal(
    requestView(row({ state: 'cancelled', lines: [] }), new Map(), 'Синтетика').cancel_reason,
    'Синтетика',
  );
});

test('difference: requested against received, extras at the end, signed', () => {
  assert.deepEqual(
    supplyDifference(
      [
        { ingredient_id: 'a', name: 'А', unit: 'pcs', qty: '30' },
        { ingredient_id: 'b', name: 'Б', unit: 'g', qty: '1500' },
      ],
      [
        { ingredient_id: 'b', quantity: '1600' },
        { ingredient_id: 'c', name: 'В', unit: 'g', quantity: '200' },
      ],
    ),
    [
      {
        ingredient_id: 'a',
        name: 'А',
        unit: 'pcs',
        requested: '30',
        received: '0',
        difference: '-30',
      },
      {
        ingredient_id: 'b',
        name: 'Б',
        unit: 'g',
        requested: '1500',
        received: '1600',
        difference: '100',
      },
      {
        ingredient_id: 'c',
        name: 'В',
        unit: 'g',
        requested: '0',
        received: '200',
        difference: '200',
      },
    ],
  );
});
