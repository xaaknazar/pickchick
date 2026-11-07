import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CartSchema,
  CashShiftCloseSchema,
  CashShiftSchema,
  LocalOrderSchema,
  ManagerApprovalRequestSchema,
  ManagerApprovalSchema,
  OrderingStateSchema,
  POS_APPROVAL_TTL_SECONDS,
  POS_PAYMENT_METHOD_POLICY,
  PosCashShiftCloseSchema,
  PosConfigSchema,
  PosErrorCodeSchema,
  PosFiscalPendingSchema,
  PosFiscalReceiptSchema,
  PosFiscalRecordRequestSchema,
  PosPaymentMethodSchema,
  PosQuoteRequestSchema,
  PosRefundRequestSchema,
  PosSaleRequestSchema,
  PosSaleResultSchema,
  PosSaleSchema,
  PosShiftReportSchema,
  PosVoidRequestSchema,
  QuoteSchema,
  posErrorTextRu,
} from '@pickchick/contracts';

// Pure schema checks of the cutover POS contracts (contracts 5.1, section 00); no database.
const id = () => randomUUID();
const time = '2026-11-19T06:00:00.000Z';
const quote = {
  quote_id: id(),
  branch_id: id(),
  release_id: id(),
  menu_version: 3,
  service_mode: 'takeaway',
  channel: 'pos',
  lines: [
    {
      product_id: id(),
      variant_id: id(),
      name: { ru: 'Синтетика', kk: 'Синтетика' },
      quantity: 2,
      unit_price_minor: '150000',
      total_minor: '300000',
    },
  ],
  currency: 'KZT',
  subtotal_minor: '300000',
  discount_minor: '0',
  total_minor: '300000',
  created_at: time,
  expires_at: '2026-11-19T06:05:00.000Z',
};
// Exactly what the 025 runtime returns today for an unpaid order and for its shift.
const unpaidOrder = {
  cash_shift_id: id(),
  order_id: id(),
  branch_id: quote.branch_id,
  quote_id: quote.quote_id,
  version: 1,
  state: 'awaiting_payment',
  payment_state: 'not_started',
  fiscal_state: 'not_requested',
  fulfillment_state: 'accepted',
  execution_mode: 'unpaid_service',
  fulfillment: { version: 1, display_number: '12', state: 'accepted' },
  next_action: 'none',
  snapshot: quote,
  created_at: time,
  cancellation_reason: null,
};
const oldShift = {
  shift_id: id(),
  branch_id: quote.branch_id,
  terminal_id: id(),
  staff_id: id(),
  version: 1,
  state: 'open',
  opened_at: time,
  closed_at: null,
  closed_by_staff_id: null,
  opening_cash_minor: '1000000',
  expected_cash_minor: '1000000',
  cash_movements: [],
  counted_cash_minor: null,
  discrepancy_minor: null,
  closing_reason: null,
  currency: 'KZT',
  order_count: 1,
  awaiting_payment_count: 1,
  cancelled_count: 0,
  order_total_minor: '300000',
  unpaid_total_minor: '300000',
  cash_received_minor: '0',
  cash_refunded_minor: '0',
  payment_processing_available: false,
  report_at: time,
};
const sale = {
  order_id: unpaidOrder.order_id,
  display_number: 12,
  pickup: 'issue',
  sales_channel: 'hall',
  external_order_ref: null,
  service_mode: 'takeaway',
  revenue_kind: 'revenue',
  total_minor: '300000',
  cash_tendered_minor: '500000',
  change_minor: '200000',
  tenders: [
    {
      tender_id: id(),
      method: 'cash',
      amount_minor: '300000',
      confirmation: 'drawer',
      reference: null,
    },
  ],
  refunds: [],
  refundable_minor: '300000',
  fiscal: [
    {
      receipt_id: id(),
      kind: 'sale',
      state: 'pending',
      receipt_number: null,
      version: 1,
      amount_minor: '300000',
    },
  ],
  shift_id: oldShift.shift_id,
  terminal_id: oldShift.terminal_id,
  cashier_staff_id: oldShift.staff_id,
  created_at: time,
};

test('widened index schemas parse every old payload to identical bytes', () => {
  for (const [schema, value] of [
    [LocalOrderSchema, unpaidOrder],
    [LocalOrderSchema, { ...unpaidOrder, execution_mode: undefined, fulfillment: undefined }],
    [
      LocalOrderSchema,
      {
        ...unpaidOrder,
        version: 2,
        state: 'cancelled',
        fulfillment_state: 'cancelled',
        cancellation_reason: 'Синтетическая отмена',
      },
    ],
    [CashShiftSchema, oldShift],
    [QuoteSchema, quote],
    [OrderingStateSchema, { branch_id: id(), ordering_enabled: true, version: 2 }],
    [
      OrderingStateSchema,
      { pos_service_mode: 'unpaid_service', branch_id: id(), ordering_enabled: true, version: 2 },
    ],
  ]) {
    const clean = JSON.parse(JSON.stringify(value));
    assert.equal(JSON.stringify(schema.parse(clean)), JSON.stringify(clean));
  }
  // The paid sale shapes the pos lane will return (contracts 5.1).
  const paid = {
    ...unpaidOrder,
    state: 'paid',
    payment_state: 'captured',
    execution_mode: 'pos_sale',
  };
  assert.deepEqual(LocalOrderSchema.parse(paid), paid);
  assert.equal(
    CashShiftSchema.parse({
      ...oldShift,
      cash_received_minor: '300000',
      cash_refunded_minor: '1000',
      payment_processing_available: true,
    }).cash_received_minor,
    '300000',
  );
  assert.equal(
    OrderingStateSchema.parse({
      pos_service_mode: 'pos_sale',
      branch_id: id(),
      ordering_enabled: true,
      version: 3,
    }).pos_service_mode,
    'pos_sale',
  );
  assert.equal(QuoteSchema.parse({ ...quote, sales_channel: 'glovo' }).sales_channel, 'glovo');
  // Still strict: no new keys, no unknown states, fiscal stays in the sale.
  for (const [schema, value] of [
    [LocalOrderSchema, { ...unpaidOrder, sale }],
    [LocalOrderSchema, { ...unpaidOrder, state: 'refunded' }],
    [LocalOrderSchema, { ...unpaidOrder, fiscal_state: 'manual_pending' }],
    [LocalOrderSchema, { ...unpaidOrder, payment_state: 'partially_refunded' }],
    [CashShiftSchema, { ...oldShift, sales_mode: true }],
    [CashShiftSchema, { ...oldShift, cash_received_minor: '-1' }],
    [QuoteSchema, { ...quote, sales_channel: 'hall' }],
    [QuoteSchema, { ...quote, discount_minor: '100' }],
  ])
    assert.equal(schema.safeParse(value).success, false);
});

test('POS request schemas extend the old ones strictly and reject what contracts 5.1 forbids', () => {
  const cart = {
    release_id: id(),
    service_mode: 'takeaway',
    items: [{ variant_id: id(), quantity: 1 }],
  };
  assert.deepEqual(PosQuoteRequestSchema.parse(cart), CartSchema.parse(cart));
  assert.equal(
    PosQuoteRequestSchema.parse({ ...cart, sales_channel: 'hall' }).sales_channel,
    'hall',
  );
  assert.equal(CartSchema.safeParse({ ...cart, sales_channel: 'glovo' }).success, false);
  assert.equal(PosQuoteRequestSchema.safeParse({ ...cart, sales_channel: 'wolt' }).success, false);
  const close = { expected_version: 1, counted_cash_minor: '0', reason: 'Конец смены' };
  assert.deepEqual(PosCashShiftCloseSchema.parse(close), CashShiftCloseSchema.parse(close));
  assert.equal(
    PosCashShiftCloseSchema.safeParse({ ...close, terminal_reported_minor: '100', extra: 1 })
      .success,
    false,
  );
  const approval = { approval_id: id(), token: 'a'.repeat(64) };
  const request = {
    quote_id: id(),
    service_mode_confirmed: true,
    order_repeated: true,
    tenders: [{ method: 'cash', amount_minor: '300000' }],
    cash_tendered_minor: '500000',
  };
  assert.deepEqual(PosSaleRequestSchema.parse(request), request);
  assert.equal(
    PosSaleRequestSchema.parse({ ...request, external_order_ref: ' cf-123 ' }).external_order_ref,
    'cf-123',
  );
  for (const bad of [
    { ...request, service_mode_confirmed: false },
    { ...request, order_repeated: undefined },
    { ...request, tenders: [] },
    { ...request, tenders: [...request.tenders, ...request.tenders, ...request.tenders] },
    { ...request, tenders: [{ method: 'cash', amount_minor: '0' }] },
    { ...request, tenders: [{ method: 'kaspi_ailillu', amount_minor: '1' }] },
    {
      ...request,
      tenders: [{ method: 'kaspi_manual', amount_minor: '1', reference: 'x'.repeat(41) }],
    },
    { ...request, tenders: [{ method: 'kaspi_manual', amount_minor: '1', reference: 'a\nb' }] },
    { ...request, external_order_ref: 'ab' },
    { ...request, beneficiary: '' },
    { ...request, reason: 'ab' },
    { ...request, approval: { ...approval, token: 'A'.repeat(64) } },
    { ...request, fiscal_receipt_number: ' ' },
    { ...request, discount_minor: '0' },
  ])
    assert.equal(PosSaleRequestSchema.safeParse(bad).success, false, JSON.stringify(bad));
  const voidRequest = {
    expected_version: 1,
    reason_code: 'guest_changed_mind',
    reason: 'Гость передумал',
    fiscal_sale_issued: false,
    approval,
  };
  assert.deepEqual(PosVoidRequestSchema.parse(voidRequest), voidRequest);
  assert.equal(
    PosVoidRequestSchema.safeParse({ ...voidRequest, approval: undefined }).success,
    false,
  );
  const tender = { tender_id: id(), amount_minor: '100' };
  const refund = {
    refund_id: id(),
    tenders: [tender],
    reason_code: 'quality',
    reason: 'Синтетика',
    approval,
  };
  assert.deepEqual(PosRefundRequestSchema.parse(refund), refund);
  assert.equal(
    PosRefundRequestSchema.safeParse({ ...refund, tenders: [tender, tender] }).success,
    false,
  );
  assert.equal(
    PosRefundRequestSchema.safeParse({ ...refund, reason_code: 'defect' }).success,
    false,
  );
  for (const subject of [
    { order_id: id(), amount_minor: '0' },
    { quote_id: id(), amount_minor: '300000' },
    { shift_id: id(), amount_minor: '5' },
  ])
    assert.equal(
      ManagerApprovalRequestSchema.safeParse({
        staff_id: id(),
        pin: '1234',
        action: 'void',
        subject,
      }).success,
      true,
    );
  for (const bad of [
    { order_id: id(), quote_id: id(), amount_minor: '0' },
    { amount_minor: '0' },
    { order_id: id() },
  ])
    assert.equal(
      ManagerApprovalRequestSchema.safeParse({
        staff_id: id(),
        pin: '1234',
        action: 'void',
        subject: bad,
      }).success,
      false,
    );
  assert.equal(
    ManagerApprovalRequestSchema.safeParse({
      staff_id: id(),
      pin: '12345',
      action: 'void',
      subject: { order_id: id(), amount_minor: '0' },
    }).success,
    false,
  );
  assert.deepEqual(
    ManagerApprovalSchema.parse({
      ...approval,
      expires_at: time,
      manager: { staff_id: id(), name: 'Начальник смены' },
    }).token,
    approval.token,
  );
  assert.equal(
    PosFiscalRecordRequestSchema.parse({ expected_version: 2, receipt_number: ' 0001 ' })
      .receipt_number,
    '0001',
  );
});

test('responses: config, sale, result, receipts and ShiftReport', () => {
  const config = {
    mode: 'pos_sale',
    methods: PosPaymentMethodSchema.options.map((code) => ({
      code,
      enabled: false,
      requires_approval: POS_PAYMENT_METHOD_POLICY[code].requires_approval,
      allow_in_mix: POS_PAYMENT_METHOD_POLICY[code].allow_in_mix,
      fiscal_policy: POS_PAYMENT_METHOD_POLICY[code].fiscal_policy,
    })),
    channels: [
      { code: 'hall', enabled: true },
      { code: 'yandex_eda', enabled: false },
      { code: 'glovo', enabled: false },
    ],
    fiscal_mode: 'manual_webkassa',
    approval_ttl_seconds: 120,
    server_time: time,
    desk_number: null,
  };
  assert.equal(POS_APPROVAL_TTL_SECONDS, 120);
  assert.deepEqual(PosConfigSchema.parse(config), config);
  assert.equal(PosConfigSchema.safeParse({ ...config, approval_ttl_seconds: 60 }).success, false);
  assert.equal(PosConfigSchema.safeParse({ ...config, discounts: [] }).success, false);
  // Schema028 desk number (CR pos-7): 1..99 or null, always present, the last key.
  for (const desk of [1, 2, 99])
    assert.deepEqual(PosConfigSchema.parse({ ...config, desk_number: desk }).desk_number, desk);
  for (const desk of [0, 100, 1.5, '2', undefined])
    assert.equal(PosConfigSchema.safeParse({ ...config, desk_number: desk }).success, false);
  assert.equal(Object.keys(PosConfigSchema.parse(config)).at(-1), 'desk_number');
  assert.deepEqual(PosSaleSchema.parse(sale), sale);
  const result = {
    order: { ...unpaidOrder, state: 'paid', payment_state: 'captured', execution_mode: 'pos_sale' },
    sale,
  };
  assert.deepEqual(PosSaleResultSchema.parse(result), result);
  for (const bad of [
    { ...sale, fiscal: [] },
    { ...sale, external_order_ref: 'lower-1' },
    { ...sale, display_number: 0 },
    { ...sale, pickup: 'counter' },
    { ...sale, tenders: [{ ...sale.tenders[0], confirmation: 'terminal_adapter' }] },
  ])
    assert.equal(PosSaleSchema.safeParse(bad).success, false);
  const receipt = {
    receipt_id: id(),
    order_id: sale.order_id,
    refund_id: null,
    kind: 'sale',
    mode: 'manual_webkassa',
    state: 'recorded',
    receipt_number: 'SYN-1',
    version: 2,
    amount_minor: '300000',
    recorded_by_staff_id: id(),
    recorded_at: time,
  };
  assert.deepEqual(PosFiscalReceiptSchema.parse(receipt), receipt);
  assert.equal(PosFiscalReceiptSchema.safeParse({ ...receipt, state: 'issued' }).success, false);
  assert.equal(
    PosFiscalPendingSchema.parse({
      receipts: [
        {
          receipt_id: receipt.receipt_id,
          order_id: sale.order_id,
          display_number: 12,
          kind: 'sale',
          amount_minor: '300000',
          methods: ['cash', 'kaspi_terminal'],
          created_at: time,
          version: 1,
        },
      ],
    }).receipts.length,
    1,
  );
  const report = {
    kind: 'x',
    shift_id: oldShift.shift_id,
    terminal_id: oldShift.terminal_id,
    state: 'open',
    opened_at: time,
    closed_at: null,
    opening_cash_minor: '1000000',
    cash_in_minor: '0',
    cash_out_minor: '0',
    cash_sales_minor: '300000',
    cash_refunds_minor: '0',
    expected_cash_minor: '1300000',
    counted_cash_minor: null,
    discrepancy_minor: null,
    methods: [{ method: 'cash', sales_minor: '300000', refunds_minor: '0', count: 1 }],
    channels: [{ sales_channel: 'hall', total_minor: '300000', count: 1 }],
    terminal_reported_minor: null,
    terminal_discrepancy_minor: null,
    fiscal: { pending: 1, recorded: 0, not_required: 0 },
    orders: { count: 1, voided_count: 0 },
    report_at: time,
  };
  assert.deepEqual(PosShiftReportSchema.parse(report), report);
  assert.equal(
    PosShiftReportSchema.parse({ ...report, discrepancy_minor: '-1500' }).discrepancy_minor,
    '-1500',
  );
  assert.equal(PosShiftReportSchema.safeParse({ ...report, kind: 'y' }).success, false);
});

test('payment method policy and Russian error texts follow contracts section 00', () => {
  assert.deepEqual(PosPaymentMethodSchema.options, Object.keys(POS_PAYMENT_METHOD_POLICY));
  const pick = (key) =>
    Object.fromEntries(
      Object.entries(POS_PAYMENT_METHOD_POLICY).map(([code, policy]) => [code, policy[key]]),
    );
  assert.deepEqual(pick('allow_in_mix'), {
    cash: true,
    kaspi_terminal: true,
    aggregator_yandex_eda: false,
    aggregator_glovo: false,
    staff_meal: false,
    marketing: false,
    kaspi_manual: true,
    chocofood: false,
  });
  assert.deepEqual(
    Object.keys(POS_PAYMENT_METHOD_POLICY).filter(
      (code) => POS_PAYMENT_METHOD_POLICY[code].requires_approval,
    ),
    ['staff_meal', 'marketing'],
  );
  assert.deepEqual(
    Object.keys(POS_PAYMENT_METHOD_POLICY).filter(
      (code) => POS_PAYMENT_METHOD_POLICY[code].fiscal_policy === 'manual_webkassa',
    ),
    ['cash', 'kaspi_terminal', 'kaspi_manual'],
  );
  assert.equal(POS_PAYMENT_METHOD_POLICY.kaspi_manual.confirmation, 'cashier_attested');
  assert.equal(POS_PAYMENT_METHOD_POLICY.chocofood.confirmation, 'aggregator_attested');
  assert.deepEqual(POS_PAYMENT_METHOD_POLICY.chocofood.channels, ['hall']);
  assert.deepEqual(POS_PAYMENT_METHOD_POLICY.aggregator_glovo.channels, ['glovo']);
  assert.equal(PosErrorCodeSchema.options.length, 15);
  for (const code of PosErrorCodeSchema.options) {
    const text = posErrorTextRu(code);
    assert.match(text, /[А-Яа-яЁё]/);
    assert.doesNotMatch(text, /[–—]/, code);
  }
  assert.equal(posErrorTextRu('CHANNEL_PRICE_UNAVAILABLE', 'yandex_eda'), 'Нет в меню Яндекс Еды');
  assert.equal(posErrorTextRu('CHANNEL_PRICE_UNAVAILABLE', 'glovo'), 'Нет в меню Glovo');
  assert.equal(posErrorTextRu('EXTERNAL_REF_REQUIRED'), 'Введите номер заказа агрегатора');
  assert.equal(
    posErrorTextRu('EXTERNAL_REF_REQUIRED', 'chocofood'),
    'Введите номер заказа ChocoFood',
  );
  assert.equal(
    posErrorTextRu('REFUND_NOT_SUPPORTED', 'chocofood'),
    'Возврат ChocoFood оформляется в кабинете ChocoFood',
  );
  assert.equal(
    posErrorTextRu('SERVICE_MODE_DISABLED'),
    'Касса не принимает оплату - сообщите менеджеру',
  );
});
