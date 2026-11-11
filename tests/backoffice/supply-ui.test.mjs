// Lane bo-ui2 step 2 «Закупки» in the cabinet (design-bo-ui §9.4): the gate, the allowlists of
// ops/suppliers and ops/supply-requests, the words for a request, the forms (the same rules as
// the server) and the commands. Pure functions of the built cabinet and the core, no PostgreSQL.
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { allowedPath, reasonMessage } from '../../apps/backoffice/dist/api.js';
import { allowed } from '../../apps/backoffice/server.mjs';
import {
  RIGHTS_TEXT,
  commandPermission,
  permitted,
  rightsText,
  supplyAvailable,
} from '../../apps/backoffice/dist/operations-model.js';
import {
  REQUEST_FORM_ERRORS,
  SUPPLY_BANNER,
  SUPPLY_ERRORS,
  SUPPLY_SECTION,
  belowMinimumLines,
  differenceText,
  dmy,
  emptyRequestForm,
  expectedAmount,
  hintOf,
  lineEstimate,
  linesText,
  partial,
  pricePayload,
  priceText,
  priceUnits,
  pricesInForce,
  receiveCommand,
  receiveFormOf,
  receivePreview,
  requestActions,
  requestFormOf,
  requestPayload,
  requestStateText,
  requestsCsv,
  supplierKindFor,
  supplierPayload,
  suppliersView,
  supplyRequestsView,
  tengeInput,
  totalText,
} from '../../apps/backoffice/dist/supply-model.js';
import {
  P2_COMMAND_PERMISSIONS,
  SupplyRequestPayloadSchema,
  expectedAmount as serverAmount,
  supplierKindFor as serverKindFor,
  supplyHint,
} from '../../packages/backoffice-core/dist/index.js';

const LONG_DASH = /[–—]/;
const branch = randomUUID();
const TODAY = '2026-11-19';
const stock = [
  {
    id: 'a0000000-0000-4000-8000-000000000001',
    payload: { name: 'Синтетическая булка', unit: 'pcs', minimum: '10', active: true },
    quantity: '4',
    value_minor: '4000',
    revision: 3,
  },
  {
    id: 'a0000000-0000-4000-8000-000000000002',
    payload: { name: 'Синтетическое филе', unit: 'g', minimum: '1000', active: true },
    quantity: '250',
    value_minor: '60000',
    revision: 5,
  },
  {
    id: 'a0000000-0000-4000-8000-000000000003',
    payload: { name: 'Синтетическая соль', unit: 'g', minimum: '0', active: true },
    quantity: '0',
    value_minor: '0',
    revision: 0,
  },
  {
    id: 'a0000000-0000-4000-8000-000000000004',
    payload: { name: 'Синтетическая старая позиция', unit: 'pcs', minimum: '5', active: false },
    quantity: '0',
    value_minor: '0',
    revision: 0,
  },
];
const [bun, fillet, salt] = stock.map((s) => s.id);
const request = (over = {}) => ({
  id: randomUUID(),
  number: 7,
  kind: 'supplier',
  state: 'submitted',
  supplier: { id: randomUUID(), name: 'Поставщик 1', kind: 'supplier', active: true },
  needed_by: '2026-11-20',
  note: null,
  lines: [
    {
      ingredient_id: fillet,
      name: 'Синтетическое филе',
      unit: 'g',
      qty: '1500',
      balance_at_request: '250',
      hint: '750',
      price_minor: '375000',
    },
    {
      ingredient_id: bun,
      name: 'Синтетическая булка',
      unit: 'pcs',
      qty: '20',
      balance_at_request: '4',
      hint: '6',
      price_minor: null,
    },
  ],
  total_minor: '375000',
  unpriced_lines: 1,
  receipt_document_id: null,
  revision: 2,
  created_by_name: 'Синтетический управляющий',
  created_at: '2026-11-19T04:30:00.000Z',
  submitted_by_name: 'Синтетический управляющий',
  submitted_at: '2026-11-19T04:31:00.000Z',
  closed_by_name: null,
  closed_at: null,
  cancel_reason: null,
  ...over,
});

test('the gate and the allowlists: the two views and nothing else', async () => {
  assert.equal(supplyAvailable({ capabilities: { supply: true } }), true);
  assert.equal(supplyAvailable({ capabilities: { supply: false } }), false);
  assert.equal(supplyAvailable({ capabilities: {} }), false);
  assert.equal(supplyAvailable(null), false);
  const id = randomUUID();
  const window = 'start_date=2026-11-01&end_date=2026-11-19';
  const views = {
    [`suppliers`]: true,
    [`suppliers?id=${id}`]: true,
    [`suppliers?id=x`]: false,
    [`suppliers?id=${id}&id=${id}`]: false,
    [`suppliers?name=x`]: false,
    [`supply-requests?${window}`]: true,
    [`supply-requests?${window}&state=submitted&kind=bakery&id=${id}`]: true,
    [`supply-requests`]: false,
    [`supply-requests?start_date=2026-11-01`]: false,
    [`supply-requests?${window}&state=open`]: false,
    [`supply-requests?${window}&kind=kitchen`]: false,
    [`supply-requests?${window}&state=draft&state=submitted`]: false,
    [`supply-requests?${window}&q=1`]: false,
    [`suppliers/x`]: false,
  };
  for (const [path, ok] of Object.entries(views)) {
    assert.equal(allowedPath(`operations/branches/${branch}/ops/${path}`), ok, 'cabinet ' + path);
    assert.equal(
      allowed('GET', `/v1/admin/backoffice/branches/${branch}/ops/${path}`),
      ok,
      'proxy ' + path,
    );
  }
  assert.equal(allowed('POST', `/v1/admin/backoffice/branches/${branch}/ops/suppliers`), false);
  // Commands go through the existing commands route.
  assert.equal(allowed('POST', `/v1/admin/backoffice/branches/${branch}/commands`), true);
  const caddy = await readFile(
    new URL('../../infra/public-staging/gateway.Caddyfile', import.meta.url),
    'utf8',
  );
  const regex = new RegExp(/path_regexp backoffice_get (\S+)/.exec(caddy)[1]);
  for (const view of ['suppliers', 'supply-requests'])
    assert.equal(regex.test(`/v1/admin/backoffice/branches/${branch}/ops/${view}`), true, view);
  assert.equal(regex.test(`/v1/admin/backoffice/branches/${branch}/ops/supply`), false);
  assert.equal(regex.test(`/v1/admin/backoffice/branches/${branch}/ops/suppliers/x`), false);
  const server = await readFile(
    new URL('../../apps/backoffice/server.mjs', import.meta.url),
    'utf8',
  );
  for (const name of ["'supply'", "'supply-model'"]) assert.ok(server.includes(name), name);
});

test('section, permissions and rights: the matrix of step 2 in words', () => {
  assert.deepEqual([...SUPPLY_SECTION].slice(0, 2), ['supply', 'Закупки']);
  const expected = {
    supplier_save: 'suppliers.write',
    supplier_price_save: 'suppliers.write',
    supply_request_save: 'supply.write',
    supply_request_submit: 'supply.write',
    supply_request_cancel: 'supply.close',
    supply_request_receive: 'supply.close',
  };
  for (const [type, permission] of Object.entries(expected)) {
    assert.equal(commandPermission({ type }), permission, type);
    // The cabinet checks the first permission of the server list (receive also stock.receipt).
    assert.equal(P2_COMMAND_PERMISSIONS[type][0], permission, type);
  }
  assert.equal(
    RIGHTS_TEXT['supply.close'],
    'Принять поставку по заявке и отменить заявку может только управляющий.',
  );
  assert.equal(
    RIGHTS_TEXT['supply.write'],
    'Заявки создают и подают управляющий и начальник смены.',
  );
  assert.equal(
    RIGHTS_TEXT['suppliers.write'],
    'Поставщиков и их цены ведут управляющий и бухгалтер.',
  );
  assert.equal(
    rightsText({ permissions: ['reports.read'] }, 'supply.close'),
    RIGHTS_TEXT['supply.close'],
  );
  // Without roles on the server the grant decides: the manager writes, the analyst reads.
  assert.equal(permitted({ role: 'manager' }, 'supply.close'), true);
  assert.equal(permitted({ role: 'analyst' }, 'supply.write'), false);
  assert.equal(
    permitted({ role: 'analyst', permissions: ['reports.read', 'supply.write'] }, 'supply.write'),
    true,
  );
  for (const text of [
    ...Object.values(SUPPLY_ERRORS),
    SUPPLY_BANNER,
    ...Object.values(REQUEST_FORM_ERRORS),
  ])
    assert.doesNotMatch(text, LONG_DASH, text);
  for (const reason of [
    'SUPPLIER_NAME_TAKEN',
    'SUPPLIER_INACTIVE',
    'PRICE_UNIT_MISMATCH',
    'REQUEST_LOCKED',
    'REQUEST_INCOMPLETE',
  ])
    assert.equal(reasonMessage(reason), SUPPLY_ERRORS[reason], reason);
});

test('the same rules as the server: amount, hint and who delivers', () => {
  for (const [qty, price, unit] of [
    ['1500', '250000', 'kg'],
    ['1500', '333', 'kg'],
    ['1499', '333', 'kg'],
    ['1', '100', 'kg'],
    ['20', '1500', 'pcs'],
    ['750', '120000', 'l'],
  ])
    assert.equal(
      expectedAmount(qty, price, unit),
      serverAmount(qty, price, unit),
      `${qty} ${unit}`,
    );
  for (const [minimum, balance] of [
    ['10', '4'],
    ['10', '14'],
    ['0', '4'],
  ])
    assert.equal(hintOf(minimum, balance), supplyHint(minimum, balance));
  for (const kind of ['central_kitchen', 'bakery', 'household', 'supplier'])
    assert.equal(supplierKindFor(kind), serverKindFor(kind), kind);
  assert.deepEqual(priceUnits('g'), ['kg', 'g']);
  assert.deepEqual(priceUnits('ml'), ['l', 'ml']);
  assert.deepEqual(priceUnits('pcs'), ['pcs']);
  assert.equal(priceText({ price_minor: '250000', unit: 'kg' }), '2 500 ₸ за 1 кг');
  assert.equal(priceText({ price_minor: '150050', unit: 'pcs' }), '1 500,50 ₸ за 1 шт');
  assert.equal(tengeInput('150050'), '1500,50');
  assert.equal(tengeInput('250000'), '2500');
});

test('the request form: lines in kg or g, the payload the server parses, errors in words', () => {
  const form = emptyRequestForm('supplier', TODAY);
  assert.equal(form.needed_by, '2026-11-20');
  // A draft may be empty; a submission may not.
  assert.equal(requestPayload(form, stock, TODAY).errors.length, 0);
  assert.deepEqual(requestPayload(form, stock, TODAY, true).errors, [
    REQUEST_FORM_ERRORS.empty,
    REQUEST_FORM_ERRORS.supplier,
  ]);
  form.supplier_id = randomUUID();
  form.lines = [
    { ingredient_id: fillet, quantity: '1,5', unit: 'kg' },
    { ingredient_id: bun, quantity: '20', unit: 'pcs' },
  ];
  form.note = '  К утру  ';
  const out = requestPayload(form, stock, TODAY, true);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.payload, {
    kind: 'supplier',
    supplier_id: form.supplier_id,
    needed_by: '2026-11-20',
    note: 'К утру',
    lines: [
      { ingredient_id: fillet, qty: '1500' },
      { ingredient_id: bun, qty: '20' },
    ],
  });
  assert.equal(SupplyRequestPayloadSchema.safeParse(out.payload).success, true);
  for (const bad of [
    [{ ingredient_id: fillet, quantity: '1,2345', unit: 'kg' }],
    [{ ingredient_id: bun, quantity: '1,5', unit: 'pcs' }],
    [{ ingredient_id: bun, quantity: '0', unit: 'pcs' }],
    [{ ingredient_id: '', quantity: '1', unit: 'pcs' }],
    // An inactive position is not offered and not accepted.
    [{ ingredient_id: stock[3].id, quantity: '1', unit: 'pcs' }],
  ])
    assert.deepEqual(requestPayload({ ...form, lines: bad }, stock, TODAY).errors, [
      REQUEST_FORM_ERRORS.line,
    ]);
  assert.deepEqual(
    requestPayload({ ...form, lines: [form.lines[1], form.lines[1]] }, stock, TODAY).errors,
    [REQUEST_FORM_ERRORS.repeated],
  );
  assert.deepEqual(requestPayload({ ...form, needed_by: '2026-11-18' }, stock, TODAY).errors, [
    REQUEST_FORM_ERRORS.past,
  ]);
  assert.deepEqual(requestPayload({ ...form, needed_by: '' }, stock, TODAY, true).errors, [
    REQUEST_FORM_ERRORS.date,
  ]);
  // «Добавить всё ниже минимума»: the hint of each position below its minimum (no salt: no minimum).
  assert.deepEqual(belowMinimumLines({ ...form, lines: [] }, stock), [
    { ingredient_id: bun, quantity: '6', unit: 'pcs' },
    { ingredient_id: fillet, quantity: '750', unit: 'g' },
  ]);
  assert.deepEqual(belowMinimumLines(form, stock), []);
  // A stored request back in the editor.
  assert.deepEqual(requestFormOf(request()).lines, [
    { ingredient_id: fillet, quantity: '1,5', unit: 'kg' },
    { ingredient_id: bun, quantity: '20', unit: 'pcs' },
  ]);
  // The estimate by the price in force.
  assert.equal(lineEstimate(form.lines[0], 'g', { price_minor: '250000', unit: 'kg' }), '375000');
  assert.equal(
    lineEstimate({ ingredient_id: salt, quantity: '1', unit: 'g' }, 'g', {
      price_minor: '100',
      unit: 'kg',
    }),
    null,
  );
  assert.equal(lineEstimate(form.lines[0], 'g', undefined), null);
});

test('the receipt by a request: prefilled lines, the stock preview and the difference', () => {
  const r = request();
  const form = receiveFormOf(r, TODAY);
  assert.equal(form.document_date, TODAY);
  assert.deepEqual(
    form.lines.map((l) => [l.ingredient_id, l.quantity, l.unit, l.cost]),
    [
      [fillet, '1,5', 'kg', ''],
      [bun, '20', 'pcs', ''],
    ],
  );
  assert.throws(() => receivePreview(form, r, stock), /стоимость/i);
  // Partial: 1 kg of fillet, no bun, an extra salt.
  form.lines = [
    { ingredient_id: fillet, quantity: '1', unit: 'kg', cost: '2500' },
    { ingredient_id: salt, quantity: '200', unit: 'g', cost: '10' },
  ];
  const out = receivePreview(form, r, stock);
  assert.deepEqual(out.lines, [
    { ingredient_id: fillet, quantity: '1000', value_minor: '250000', expected_revision: 5 },
    { ingredient_id: salt, quantity: '200', value_minor: '1000', expected_revision: 0 },
  ]);
  assert.deepEqual(
    out.difference.map((d) => [d.name, d.requested, d.received, d.difference]),
    [
      ['Синтетическое филе', '1500', '1000', '-500'],
      ['Синтетическая булка', '20', '0', '-20'],
      ['Синтетическая соль', '0', '200', '200'],
    ],
  );
  assert.equal(partial(out.difference), true);
  assert.equal(differenceText('-500', 'g'), '-0,5 кг');
  assert.equal(differenceText('200', 'g'), '+0,2 кг');
  assert.equal(differenceText('0', 'pcs'), '0 шт');
  const command = receiveCommand(
    r.id,
    r.revision,
    { reference: ' НАК-7 ', document_date: TODAY },
    out.lines,
  );
  assert.deepEqual(command, {
    type: 'supply_request_receive',
    id: r.id,
    expected_revision: 2,
    reference: 'НАК-7',
    document_date: TODAY,
    lines: out.lines,
  });
});

test('words: states, lines, totals, actions, CSV with «Сумма, ₸», no long dashes', () => {
  assert.equal(
    requestStateText({ state: 'submitted', needed_by: '2026-11-18' }, TODAY),
    'Подана, срок прошёл 18.11.2026',
  );
  assert.equal(requestStateText({ state: 'received', needed_by: '2026-11-18' }, TODAY), 'Получена');
  assert.equal(dmy('2026-11-20'), '20.11.2026');
  assert.equal(dmy(null), '-');
  assert.equal(
    linesText({ line_count: 5, line_names: ['А', 'Б', null] }),
    '5 поз.: А, Б, Позиция и ещё 2',
  );
  assert.equal(linesText({ line_count: 0, line_names: [] }), 'Строк нет');
  assert.equal(totalText(request()), '3 750 ₸, без цены: 1 поз.');
  assert.equal(totalText(request({ supplier: null })), 'Без поставщика');
  assert.equal(totalText(request({ total_minor: null })), 'Нет цен поставщика');
  assert.deepEqual(requestActions({ state: 'draft' }), {
    edit: true,
    submit: true,
    receive: false,
    cancel: true,
  });
  assert.deepEqual(requestActions({ state: 'submitted' }), {
    edit: false,
    submit: false,
    receive: true,
    cancel: true,
  });
  assert.deepEqual(requestActions({ state: 'received' }), {
    edit: false,
    submit: false,
    receive: false,
    cancel: false,
  });
  const { lines, ...row } = request();
  const view = supplyRequestsView(
    {
      schema_version: 1,
      branch_id: branch,
      view: 'supply-requests',
      today: TODAY,
      start_date: '2026-11-06',
      end_date: TODAY,
      requests: [{ ...row, line_count: lines.length, line_names: lines.map((l) => l.name) }],
      counts: { draft: 0, submitted: 1, received: 0, cancelled: 0 },
      open: { draft: 0, submitted: 1 },
      truncated: { requests: false },
    },
    branch,
  );
  const csv = requestsCsv(view);
  assert.deepEqual(csv[0], [
    '№',
    'Создана',
    'Куда',
    'Поставщик',
    'Нужно к',
    'Состояние',
    'Строк',
    'Сумма, ₸',
  ]);
  assert.deepEqual(csv[1], [
    '7',
    '19.11.2026 09:30',
    'Поставщику',
    'Поставщик 1',
    '20.11.2026',
    'Подана',
    '2',
    '3750,00',
  ]);
  assert.throws(
    () => supplyRequestsView({ ...view, branch_id: randomUUID() }, branch),
    /INVALID_RESPONSE/,
  );
  assert.throws(
    () => supplyRequestsView({ ...view, requests: [{ id: 1 }] }, branch),
    /INVALID_RESPONSE/,
  );
});

test('suppliers and prices: the view, the price in force, the price and supplier forms', () => {
  const supplier = randomUUID();
  const view = suppliersView(
    {
      schema_version: 1,
      branch_id: branch,
      view: 'suppliers',
      today: TODAY,
      suppliers: [
        {
          id: supplier,
          name: 'Поставщик 1',
          kind: 'supplier',
          active: true,
          revision: 1,
          prices: 2,
        },
      ],
      truncated: { suppliers: false },
      id: supplier,
      prices: [
        {
          ingredient_id: fillet,
          unit: 'kg',
          price_minor: '260000',
          valid_from: '2026-11-25',
          in_force: false,
          revision: 1,
        },
        {
          ingredient_id: fillet,
          unit: 'kg',
          price_minor: '250000',
          valid_from: '2026-11-10',
          in_force: true,
          revision: 2,
        },
      ],
    },
    branch,
  );
  assert.deepEqual([...pricesInForce(view).keys()], [fillet]);
  assert.equal(pricesInForce(view).get(fillet).price_minor, '250000');
  assert.throws(
    () => suppliersView({ ...view, prices: [{ ingredient_id: fillet, price_minor: '0' }] }, branch),
    /INVALID_RESPONSE/,
  );
  assert.deepEqual(
    pricePayload(
      { ingredient_id: fillet, unit: 'kg', price: '2 500,50', valid_from: TODAY },
      stock,
    ),
    {
      payload: { ingredient_id: fillet, unit: 'kg', price_minor: '250050', valid_from: TODAY },
      errors: [],
    },
  );
  assert.equal(
    pricePayload({ ingredient_id: bun, unit: 'kg', price: '100', valid_from: TODAY }, stock).errors
      .length,
    1,
  );
  assert.equal(
    pricePayload({ ingredient_id: fillet, unit: 'kg', price: '0', valid_from: TODAY }, stock).errors
      .length,
    1,
  );
  assert.equal(
    pricePayload({ ingredient_id: '', unit: '', price: '', valid_from: '' }, stock).errors.length,
    3,
  );
  assert.deepEqual(supplierPayload('  Поставщик \n 1 ', 'supplier', true), {
    payload: { name: 'Поставщик 1', kind: 'supplier', active: true },
    errors: [],
  });
  assert.equal(supplierPayload('   ', 'bakery', true).payload, null);
  assert.equal(supplierPayload('а'.repeat(121), 'bakery', true).payload, null);
});
