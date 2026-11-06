// Cutover CC-5/CC-6: the back-office UI side of roles and stock v2 (pure, no browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  commandPermission,
  permitted,
  roleTitle,
  stockReport,
  stockV2,
} from '../../apps/backoffice/dist/operations-model.js';
import {
  SUPPLIER_KINDS,
  WASTE_REASONS,
  almatyDay,
  stockV2Fields,
  supplierKindLabel,
  wasteReasonLabel,
} from '../../apps/backoffice/dist/inventory-model.js';
import { allowedPath, message, ApiError } from '../../apps/backoffice/dist/api.js';
import {
  BACKOFFICE_PERMISSIONS,
  Command,
  STOCK_SUPPLIER_KINDS,
  STOCK_WASTE_REASONS,
  commandPermission as serverPermission,
  permissionsOf,
} from '../../packages/backoffice-core/dist/index.js';

test('permitted: permissions[] when the server sends them, the old manager rule otherwise', () => {
  for (const permission of BACKOFFICE_PERMISSIONS) {
    assert.equal(permitted({ role: 'manager' }, permission), true);
    assert.equal(permitted({ role: 'analyst' }, permission), permission.endsWith('.read'));
  }
  const shift = { role: 'analyst', permissions: permissionsOf('shift_manager') };
  assert.equal(permitted(shift, 'stock.waste'), true);
  assert.equal(permitted(shift, 'finance.read'), false);
  assert.equal(permitted(shift, 'records.write'), false);
  const accountant = { role: 'analyst', permissions: permissionsOf('accountant') };
  assert.equal(permitted(accountant, 'stock.receipt'), true);
  assert.equal(permitted(accountant, 'stock.waste'), false);
  // A manager on a server with roles: exactly its list.
  assert.equal(permitted({ role: 'manager', permissions: [] }, 'records.write'), false);
  assert.equal(permitted(null, 'reports.read'), false);
});

test('the UI maps every command to the same permission as the server', () => {
  const id = randomUUID();
  const line = { ingredient_id: id, quantity: '1', value_minor: '0', expected_revision: 0 };
  for (const command of [
    { type: 'save', kind: 'promo', id, expected_revision: 0, payload: {} },
    { type: 'publish', kind: 'station', id, expected_revision: 1 },
    { type: 'deliver_station_plan' },
    { type: 'stock', kind: 'receipt', reference: 'R', lines: [line] },
    { type: 'stock', kind: 'waste', reference: 'R', lines: [line] },
    { type: 'stock', kind: 'count', reference: 'R', lines: [line] },
    {
      type: 'produce',
      recipe_id: id,
      recipe_revision: 1,
      batches: 1,
      expected_balances: {},
      reference: 'R',
    },
    { type: 'consume', order_id: id, expected_balances: {} },
    { type: 'revoke_device', id, confirm_name: 'Synthetic' },
    { type: 'cancel_order', id, expected_version: 1 },
    { type: 'refund', id, capture_id: id, amount_minor: '1' },
    { type: 'manual_refund', id, capture_id: id, amount_minor: '1', bank_reference: 'KP-1' },
    { type: 'withdraw_refund', id, refund_id: id },
  ])
    assert.equal(
      commandPermission(command),
      serverPermission(Command.parse(command)),
      command.type,
    );
});

test('role title and stock v2 capability come only from servers that send them', () => {
  assert.equal(roleTitle({ role: 'manager' }), null);
  assert.equal(roleTitle({ effective_role: 'shift_manager' }), 'Вы: начальник смены');
  assert.equal(roleTitle({ effective_role: 'accountant' }), 'Вы: бухгалтер');
  assert.equal(roleTitle({ effective_role: 'manager' }), 'Вы: управляющий');
  assert.equal(roleTitle({ effective_role: 'analyst' }), 'Вы: просмотр');
  assert.equal(stockV2({ capabilities: {} }), false);
  assert.equal(stockV2({ capabilities: { stock_v2: false } }), false);
  assert.equal(stockV2({ capabilities: { stock_v2: true } }), true);
  assert.equal(stockV2(null), false);
});

test('waste reasons and supplier kinds cover the contract enums in order, labels in Russian', () => {
  assert.deepEqual(
    WASTE_REASONS.map(([value]) => value),
    [...STOCK_WASTE_REASONS],
  );
  assert.deepEqual(
    SUPPLIER_KINDS.map(([value]) => value),
    [...STOCK_SUPPLIER_KINDS],
  );
  for (const [, label] of [...WASTE_REASONS, ...SUPPLIER_KINDS]) {
    assert.match(label, /^[А-ЯЁ]/);
    assert.doesNotMatch(label, /[–—]/);
  }
  assert.equal(wasteReasonLabel('hot_cabinet_expired'), 'Тепловой шкаф: старше 50 минут');
  assert.equal(wasteReasonLabel(null), 'Без причины');
  assert.equal(supplierKindLabel('central_kitchen'), 'Цех');
  assert.equal(supplierKindLabel('unknown'), '-');
});

test('stockV2Fields builds exactly the server fields and explains what is missing', () => {
  const draft = {
    reason_code: '',
    supplier_kind: '',
    supplier_name: '',
    document_date: '2026-11-18',
  };
  assert.throws(() => stockV2Fields('waste', draft), /Укажите причину списания/);
  assert.deepEqual(stockV2Fields('waste', { ...draft, reason_code: 'defect' }), {
    reason_code: 'defect',
  });
  assert.throws(() => stockV2Fields('receipt', draft), /откуда пришла поставка/);
  assert.throws(
    () => stockV2Fields('receipt', { ...draft, supplier_kind: 'bakery', document_date: '' }),
    /дату накладной/,
  );
  assert.throws(
    () =>
      stockV2Fields('receipt', { ...draft, supplier_kind: 'bakery', document_date: '2026-02-30' }),
    /дату накладной/,
  );
  assert.deepEqual(stockV2Fields('receipt', { ...draft, supplier_kind: 'bakery' }), {
    meta: { supplier_kind: 'bakery', document_date: '2026-11-18' },
  });
  assert.deepEqual(
    stockV2Fields('receipt', {
      ...draft,
      supplier_kind: 'supplier',
      supplier_name: '  Синтетический поставщик ',
    }),
    {
      meta: {
        supplier_kind: 'supplier',
        supplier_name: 'Синтетический поставщик',
        document_date: '2026-11-18',
      },
    },
  );
  assert.deepEqual(stockV2Fields('count', draft), {});
  // Every built command is accepted by the server schema.
  const line = {
    ingredient_id: randomUUID(),
    quantity: '1',
    value_minor: '1',
    expected_revision: 0,
  };
  for (const [kind, fields] of [
    ['waste', stockV2Fields('waste', { ...draft, reason_code: 'rework' })],
    ['receipt', stockV2Fields('receipt', { ...draft, supplier_kind: 'household' })],
  ])
    assert.equal(
      Command.safeParse({ type: 'stock', kind, reference: 'R', lines: [line], ...fields }).success,
      true,
    );
});

test('Almaty report days and the stock report shape check', () => {
  // 19:30 UTC on 18.11 is already 19.11 in Almaty (UTC+5).
  assert.equal(almatyDay(new Date('2026-11-18T19:30:00Z')), '2026-11-19');
  assert.equal(almatyDay(new Date('2026-11-18T19:30:00Z'), 6), '2026-11-13');
  const branch = randomUUID();
  const report = {
    schema_version: 1,
    branch_id: branch,
    view: 'waste',
    totals: { documents: 0, value_minor: '0' },
    summary: { by_reason: [], by_day: [] },
    documents: [],
    truncated: false,
  };
  assert.equal(stockReport(report, branch, 'waste'), report);
  for (const bad of [
    { ...report, branch_id: randomUUID() },
    { ...report, view: 'movement' },
    { ...report, summary: { by_reason: {} } },
    { ...report, documents: null },
  ])
    assert.throws(() => stockReport(bad, branch, 'waste'), /INVALID_RESPONSE/);
});

test('client allowlist and error texts for the cutover routes', () => {
  const branch = randomUUID();
  const path = (q) => `operations/branches/${branch}/ops/stock?${q}`;
  assert.equal(allowedPath(path('view=waste&start_date=2026-11-13&end_date=2026-11-19')), true);
  assert.equal(allowedPath(path('view=movement&start_date=2026-11-13&end_date=2026-11-19')), true);
  assert.equal(allowedPath(path('view=sales&start_date=2026-11-13&end_date=2026-11-19')), false);
  assert.equal(allowedPath(path('view=waste&start_date=2026-11-13')), false);
  assert.equal(allowedPath(`operations/branches/${branch}/ops/sales`), false);
  assert.equal(
    message(new ApiError('FORBIDDEN', 403, 'ROLE_FORBIDDEN')),
    'Для вашей роли это действие недоступно. Его может выполнить управляющий точки.',
  );
  assert.equal(
    message(new ApiError('INVALID_REQUEST', 400, 'REASON_REQUIRED')),
    'Укажите причину списания.',
  );
  assert.match(message(new ApiError('NOT_READY', 409, 'STOCK_V2_DISABLED')), /не включены/);
});
