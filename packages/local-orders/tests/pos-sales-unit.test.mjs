import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PosPaymentMethodSchema, PosSaleRequestSchema, QuoteSchema } from '@pickchick/contracts';
import { planPosSale, priceCart } from '@pickchick/local-orders';

// POS-2 money rules without a database (contracts 2.2, 5.3, section 00). Synthetic menu only.
const code = (expected) => (error) => error.code === expected;
const ids = {
  release: randomUUID(),
  branch: randomUUID(),
  group: randomUUID(),
  option: randomUUID(),
};
const item = (price, extra = {}) => ({
  product_id: randomUUID(),
  variant_id: randomUUID(),
  category_id: randomUUID(),
  name: { ru: 'Синтетическая позиция', kk: 'Синтетикалық позиция' },
  price_minor: price,
  currency: 'KZT',
  ...extra,
});
const burger = item('349000', {
  aggregator_prices_minor: { yandex_eda: '399000' },
  modifier_groups: [
    {
      id: ids.group,
      name: { ru: 'Соус', kk: 'Соус' },
      min_selected: 0,
      max_selected: 2,
      options: [
        {
          id: ids.option,
          name: { ru: 'Сырный', kk: 'Ірімшік' },
          price_minor: '20000',
          max_quantity: 2,
        },
      ],
    },
  ],
});
const drink = item('125050');
const menu = {
  schema_version: 1,
  release_id: ids.release,
  branch_id: ids.branch,
  version: 3,
  published_at: '2026-11-05T00:00:00Z',
  items: [burger, drink],
};
const cart = (items) => ({ release_id: ids.release, service_mode: 'takeaway', items });
const sauce = { group_id: ids.group, option_id: ids.option, quantity: 2 };

test('hall pricing is unchanged; aggregator lines use the channel price, options the hall one', () => {
  const lines = cart([
    { variant_id: burger.variant_id, quantity: 2, modifiers: [sauce] },
    { variant_id: drink.variant_id, quantity: 1 },
  ]);
  const hall = priceCart(menu, lines);
  assert.deepEqual(priceCart(menu, lines, 'hall'), hall);
  assert.equal(JSON.stringify(priceCart(menu, lines, 'hall')), JSON.stringify(hall));
  assert.equal(hall.total_minor, String((349000 + 40000) * 2 + 125050));
  const yandex = priceCart(
    menu,
    cart([{ variant_id: burger.variant_id, quantity: 2, modifiers: [sauce] }]),
    'yandex_eda',
  );
  assert.equal(yandex.lines[0].unit_price_minor, '439000');
  assert.equal(yandex.lines[0].modifiers[0].price_minor, '20000');
  assert.equal(yandex.total_minor, '878000');
  assert.deepEqual(Object.keys(yandex), Object.keys(hall));
  for (const [channel, items] of [
    ['glovo', [{ variant_id: burger.variant_id, quantity: 1 }]],
    ['yandex_eda', [{ variant_id: drink.variant_id, quantity: 1 }]],
  ])
    assert.throws(() => priceCart(menu, cart(items), channel), code('CHANNEL_PRICE_UNAVAILABLE'));
  // The cart schema stays strict: the channel is an argument, never a cart key.
  assert.throws(
    () => priceCart(menu, { ...lines, sales_channel: 'hall' }),
    code('INVALID_REQUEST'),
  );
});

const quote = (total, extra = {}) =>
  QuoteSchema.parse({
    quote_id: randomUUID(),
    branch_id: ids.branch,
    release_id: ids.release,
    menu_version: 3,
    service_mode: 'takeaway',
    channel: 'pos',
    lines: [
      {
        product_id: burger.product_id,
        variant_id: burger.variant_id,
        name: burger.name,
        quantity: 1,
        unit_price_minor: total,
        total_minor: total,
      },
    ],
    currency: 'KZT',
    subtotal_minor: total,
    discount_minor: '0',
    total_minor: total,
    created_at: '2026-11-19T05:00:00.000Z',
    expires_at: '2026-11-19T05:05:00.000Z',
    ...extra,
  });
const request = (q, extra) =>
  PosSaleRequestSchema.parse({
    quote_id: q.quote_id,
    service_mode_confirmed: true,
    order_repeated: true,
    ...extra,
  });
const plan = (q, extra) => planPosSale(request(q, extra), q);
const approval = { approval_id: randomUUID(), token: 'a'.repeat(64) };

test('a sale plan follows contracts 2.2 and section 00 for every method', () => {
  const hall = quote('349000');
  assert.deepEqual(
    plan(hall, {
      tenders: [{ method: 'cash', amount_minor: '349000' }],
      cash_tendered_minor: '500000',
    }),
    {
      channel: 'hall',
      methods: ['cash'],
      revenueKind: 'revenue',
      externalOrderRef: null,
      cashTendered: '500000',
      change: '151000',
    },
  );
  assert.equal(
    plan(hall, {
      tenders: [
        { method: 'kaspi_terminal', amount_minor: '300000' },
        { method: 'cash', amount_minor: '49000' },
      ],
      cash_tendered_minor: '49000',
    }).change,
    '0',
  );
  assert.equal(
    plan(hall, {
      tenders: [{ method: 'chocofood', amount_minor: '349000' }],
      external_order_ref: 'cf-77',
    }).externalOrderRef,
    'CF-77',
  );
  assert.equal(
    plan(hall, {
      tenders: [{ method: 'staff_meal', amount_minor: '349000' }],
      beneficiary: 'Синтетический повар',
      approval,
    }).revenueKind,
    'staff_meal',
  );
  // Without an approval the plan holds; createPosSale answers APPROVAL_REQUIRED after the
  // method check, so a disabled method never asks for a PIN.
  assert.equal(
    plan(hall, { tenders: [{ method: 'marketing', amount_minor: '349000' }], reason: 'Дегустация' })
      .revenueKind,
    'marketing',
  );
  const yandex = quote('399000', { sales_channel: 'yandex_eda' });
  assert.deepEqual(
    plan(yandex, {
      tenders: [{ method: 'aggregator_yandex_eda', amount_minor: '399000' }],
      external_order_ref: 'ya-1',
    }),
    {
      channel: 'yandex_eda',
      methods: ['aggregator_yandex_eda'],
      revenueKind: 'revenue',
      externalOrderRef: 'YA-1',
      cashTendered: null,
      change: null,
    },
  );
  const odd = quote('125050');
  for (const [q, body, expected] of [
    [
      hall,
      { tenders: [{ method: 'cash', amount_minor: '349001' }], cash_tendered_minor: '349001' },
      'TENDER_SUM_MISMATCH',
    ],
    [
      hall,
      { tenders: [{ method: 'cash', amount_minor: '349000' }], cash_tendered_minor: '348999' },
      'CASH_TENDERED_TOO_LOW',
    ],
    [hall, { tenders: [{ method: 'cash', amount_minor: '349000' }] }, 'INVALID_REQUEST'],
    [
      odd,
      { tenders: [{ method: 'kaspi_terminal', amount_minor: '125050' }] },
      'TERMINAL_AMOUNT_NOT_WHOLE',
    ],
    [hall, { tenders: [{ method: 'chocofood', amount_minor: '349000' }] }, 'EXTERNAL_REF_REQUIRED'],
    [
      yandex,
      { tenders: [{ method: 'aggregator_yandex_eda', amount_minor: '399000' }] },
      'EXTERNAL_REF_REQUIRED',
    ],
    [
      hall,
      {
        tenders: [{ method: 'kaspi_manual', amount_minor: '349000' }],
        external_order_ref: 'X-123',
      },
      'INVALID_REQUEST',
    ],
    [
      yandex,
      {
        tenders: [{ method: 'aggregator_glovo', amount_minor: '399000' }],
        external_order_ref: 'YA-1',
      },
      'INVALID_REQUEST',
    ],
    [
      yandex,
      {
        tenders: [{ method: 'cash', amount_minor: '399000' }],
        cash_tendered_minor: '399000',
        external_order_ref: 'YA-1',
      },
      'INVALID_REQUEST',
    ],
    [
      hall,
      {
        tenders: [{ method: 'aggregator_glovo', amount_minor: '349000' }],
        external_order_ref: 'GL-1',
      },
      'INVALID_REQUEST',
    ],
    [
      quote('399000', { sales_channel: 'glovo', service_mode: 'dine_in' }),
      {
        tenders: [{ method: 'aggregator_glovo', amount_minor: '399000' }],
        external_order_ref: 'GL-1',
      },
      'INVALID_REQUEST',
    ],
    [
      hall,
      {
        tenders: [
          { method: 'cash', amount_minor: '1' },
          { method: 'cash', amount_minor: '348999' },
        ],
        cash_tendered_minor: '349000',
      },
      'INVALID_REQUEST',
    ],
    [
      hall,
      {
        tenders: [
          { method: 'kaspi_manual', amount_minor: '1' },
          { method: 'marketing', amount_minor: '348999' },
        ],
        reason: 'Дегустация',
      },
      'INVALID_REQUEST',
    ],
    [
      hall,
      {
        tenders: [
          { method: 'chocofood', amount_minor: '1' },
          { method: 'kaspi_manual', amount_minor: '348999' },
        ],
        external_order_ref: 'CF-1',
      },
      'INVALID_REQUEST',
    ],
    [
      hall,
      { tenders: [{ method: 'staff_meal', amount_minor: '349000' }], approval },
      'INVALID_REQUEST',
    ],
    [
      hall,
      { tenders: [{ method: 'marketing', amount_minor: '349000' }], approval },
      'INVALID_REQUEST',
    ],
    [
      hall,
      {
        tenders: [{ method: 'staff_meal', amount_minor: '349000' }],
        beneficiary: 'Кто-то',
        reason: 'Лишнее',
        approval,
      },
      'INVALID_REQUEST',
    ],
    [
      hall,
      { tenders: [{ method: 'kaspi_manual', amount_minor: '349000' }], beneficiary: 'Кто-то' },
      'INVALID_REQUEST',
    ],
    [
      hall,
      { tenders: [{ method: 'kaspi_manual', amount_minor: '349000' }], approval },
      'INVALID_REQUEST',
    ],
    [
      hall,
      { tenders: [{ method: 'kaspi_manual', amount_minor: '349000' }], cash_tendered_minor: '1' },
      'INVALID_REQUEST',
    ],
  ])
    assert.throws(() => plan(q, body), code(expected), JSON.stringify(body));
  // Every method of the enum is covered by a rule above or a successful plan.
  assert.equal(PosPaymentMethodSchema.options.length, 8);
});
