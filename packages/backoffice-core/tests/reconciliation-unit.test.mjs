import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MappingSchema,
  almatyToUtc,
  businessDay,
  dayBounds,
  factKeys,
  parseAmount,
  parseCsv,
  parseDateTime,
  parseStatement,
  reconcileDay,
  statementDigest,
  cleanDescription,
} from '../dist/reconciliation-model.js';

const mapping = (patch = {}) =>
  MappingSchema.parse({
    version: 1,
    source: 'kaspi',
    delimiter: ';',
    has_header: true,
    columns: {
      occurred_at: 'Дата операции',
      amount: 'Сумма',
      operation_id: 'Номер операции',
      fee: 'Комиссия',
      direction: 'Тип',
      method: 'Канал',
      description: 'Описание',
    },
    date_format: 'dmy',
    decimal_separator: ',',
    amount_unit: 'major',
    refund_values: ['Возврат'],
    method_values: { QR: 'kaspi_qr', Счёт: 'kaspi_remote', Терминал: 'kaspi_pos' },
    ...patch,
  });

test('CSV records keep quoted delimiters, doubled quotes, embedded newlines and drop the BOM', () => {
  const rows = parseCsv('﻿a;"b;c";"d ""e"""\r\n1;"x\ny";3\n\n', ';');
  assert.deepEqual(rows, [['a', 'b;c', 'd "e"'], ['1', 'x\ny', '3'], ['']]);
  assert.equal(statementDigest('a;b\r\nc;d\r\n'), statementDigest('﻿a;b\nc;d'));
  assert.notEqual(statementDigest('a;b\nc;d'), statementDigest('a;b\nc;e'));
});

test('amounts are exact integer minor units with locale separators, signs and currency marks', () => {
  assert.equal(parseAmount('1 234,50 ₸', ',', 'major'), 123450n);
  assert.equal(parseAmount('1.234,5', ',', 'major'), 123450n);
  assert.equal(parseAmount('(500,00)', ',', 'major'), -50000n);
  assert.equal(parseAmount('-1 500', ',', 'major'), -150000n);
  assert.equal(parseAmount('1500-', ',', 'major'), -150000n);
  assert.equal(parseAmount('1,234.56', '.', 'major'), 123456n);
  assert.equal(parseAmount('150000', '.', 'minor'), 150000n);
  assert.equal(parseAmount('15.5', '.', 'minor'), null);
  assert.equal(parseAmount('1,005', '.', 'major'), 100500n);
  assert.equal(parseAmount('12,345', ',', 'major'), null);
  assert.equal(parseAmount('abc', ',', 'major'), null);
  assert.equal(parseAmount('', ',', 'major'), null);
  assert.equal(parseAmount('9999999999999999', '.', 'minor'), null);
});

test('Almaty wall-clock time, business day bounds and impossible dates', () => {
  assert.equal(
    new Date(almatyToUtc(2026, 10, 24, 23, 58, 10)).toISOString(),
    '2026-10-24T18:58:10.000Z',
  );
  assert.equal(almatyToUtc(2026, 2, 31), null);
  assert.equal(almatyToUtc(2026, 10, 24, 24, 0, 0), null);
  assert.equal(businessDay('2026-10-24T19:30:00Z'), '2026-10-25');
  assert.equal(businessDay('2026-10-24T18:59:59Z'), '2026-10-24');
  const { start, end } = dayBounds('2026-10-24');
  assert.equal(start.toISOString(), '2026-10-23T19:00:00.000Z');
  assert.equal(end.toISOString(), '2026-10-24T19:00:00.000Z');
  const t = (d, tm, f) => {
    const p = parseDateTime(d, tm, f);
    return p && [new Date(p.ms).toISOString(), p.precision];
  };
  assert.deepEqual(t('24.10.2026 09:05', null, 'dmy'), ['2026-10-24T04:05:00.000Z', 'minute']);
  assert.deepEqual(t('24.10.2026', '09:05:07', 'dmy'), ['2026-10-24T04:05:07.000Z', 'second']);
  assert.deepEqual(t('24/10/2026', null, 'dmy'), ['2026-10-23T19:00:00.000Z', 'day']);
  assert.deepEqual(t('2026-10-24 23:59:59', null, 'ymd'), ['2026-10-24T18:59:59.000Z', 'second']);
  assert.deepEqual(t('2026-10-24T10:00:00+06:00', null, 'iso'), [
    '2026-10-24T04:00:00.000Z',
    'second',
  ]);
  assert.deepEqual(t('2026-10-24T10:00:00Z', null, 'iso'), ['2026-10-24T10:00:00.000Z', 'second']);
  assert.deepEqual(t('2026-10-24T10:00', null, 'iso'), ['2026-10-24T05:00:00.000Z', 'minute']);
  assert.equal(t('31.02.2026 10:00', null, 'dmy'), null);
  assert.equal(t('24.10.2026 10:00', '10:00', 'dmy'), null);
  assert.equal(t('2026-10-24', null, 'dmy'), null);
});

test('mapping profiles stay inside their source and need column numbers without a header', () => {
  assert.throws(() => mapping({ default_method: 'tiptoppay' }));
  assert.throws(() => mapping({ method_values: { Карта: 'cash' } }));
  assert.throws(() => mapping({ has_header: false }));
  assert.equal(
    mapping({
      has_header: false,
      columns: { occurred_at: '1', amount: '2' },
      refund_values: [],
      method_values: {},
    }).columns.operation_id,
    null,
  );
  assert.throws(() => mapping({ unknown: true }));
});

test('statement parsing: header after title rows, refunds, fees, methods, masking and row errors', () => {
  const file = [
    'Выписка по счёту (синтетическая)',
    'Период: 24.10.2026',
    'Дата операции;Номер операции;Тип;Канал;Сумма;Комиссия;Описание',
    '24.10.2026 12:00:05;100001;Покупка;QR;1 500,00;14,25;Клиент +7 701 000 00 00',
    '',
    '24.10.2026 13:10:00;100002;Возврат;Счёт;500,00;;Возврат части заказа',
    '24.10.2026 14:00:00;100003;Покупка;Неизвестно;2 000,00;0;',
    'Итого;;;;3 000,00;;',
  ].join('\r\n');
  const strict = parseStatement(file, mapping({ skip_rows: 2 }));
  assert.equal(strict.lines.length, 3);
  assert.deepEqual(strict.errors, [{ row: 8, column: 'occurred_at', code: 'date' }]);
  const lenient = parseStatement(
    file,
    mapping({ skip_rows: 2, skip_invalid_rows: true, default_method: 'kaspi_other' }),
  );
  assert.deepEqual(lenient.errors, []);
  assert.deepEqual(lenient.skipped, [{ row: 8, column: 'occurred_at', code: 'unreadable' }]);
  const [a, b, c] = lenient.lines;
  assert.deepEqual(
    { ...a },
    {
      row_number: 4,
      occurred_at: '2026-10-24T07:00:05.000Z',
      business_day: '2026-10-24',
      time_precision: 'second',
      amount_minor: '150000',
      fee_minor: '1425',
      operation_id: '100001',
      reference: null,
      method: 'kaspi_qr',
      description: 'Клиент •••',
    },
  );
  assert.equal(b.amount_minor, '-50000');
  assert.equal(b.method, 'kaspi_remote');
  assert.equal(c.method, 'kaspi_other');
  assert.equal(c.row_number, 7);
  const missing = parseStatement(file, mapping({ skip_rows: 1 }));
  assert.ok(missing.errors.every((e) => e.code === 'missing_column'));
  assert.equal(cleanDescription('Заказ 12 на 87010000000'), 'Заказ 12 на •••');
  assert.deepEqual(factKeys('kaspi:100001', ['ab12cd34ef', null]), ['100001', 'AB12CD34EF']);
  assert.deepEqual(factKeys('manual:kp 77'), ['KP 77']);
});

// --- matching -------------------------------------------------------------------------------
const D = '2026-10-24';
let seq = 0;
const id = () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0');
const fact = (method, amount, at, patch = {}) => {
  const kind = amount < 0 ? 'refund' : 'capture';
  return {
    id: (kind === 'capture' ? 'c-' : 'r-') + id(),
    kind,
    method,
    amount_minor: BigInt(amount),
    occurred_at: at,
    day: businessDay(at),
    order_id: patch.order_id ?? id(),
    operation_id: patch.operation_id ?? null,
    keys: factKeys(patch.operation_id ?? null),
    gift_minor: 0n,
    ...patch,
  };
};
const line = (source, amount, at, patch = {}) => ({
  id: id(),
  import_id: patch.import_id ?? 'import-1',
  import_seq: 0,
  row_number: ++seq,
  source,
  method: null,
  amount_minor: BigInt(amount),
  fee_minor: 0n,
  occurred_at: at,
  day: businessDay(at),
  time_precision: 'second',
  operation_id: null,
  reference: null,
  description: '',
  window_seconds: 600,
  ...patch,
});
const day = (input) =>
  reconcileDay({
    day: D,
    facts: [],
    lines: [],
    totals: [],
    orders: [],
    shifts: [],
    gifts: { orders: 0, discount_minor: 0n },
    unknown_attempts: {},
    ...input,
  });
const sum = (rows) => rows.reduce((a, r) => a + BigInt(r.amount_minor), 0n);
const pairRows = (r) => r.rows.filter((x) => /^(pair|int|ext):/.test(x.key));

test('matching by operation id, by amount and time, and both kinds of missing operations', () => {
  const byId = fact('kaspi_remote', 150000, '2026-10-24T06:00:00.000Z', {
    operation_id: 'kaspi:9001',
  });
  const byTime = fact('kaspi_qr', 70000, '2026-10-24T07:00:00.000Z', { operation_id: '5001' });
  const lost = fact('kaspi_qr', 30000, '2026-10-24T08:00:00.000Z', { operation_id: '5002' });
  const differs = fact('kaspi_remote', 99000, '2026-10-24T09:00:00.000Z', {
    operation_id: 'kaspi:9002',
  });
  const report = day({
    facts: [byId, byTime, lost, differs],
    lines: [
      line('kaspi', 150000, '2026-10-24T06:03:00.000Z', { operation_id: '9001' }),
      line('kaspi', 70000, '2026-10-24T07:04:00.000Z'),
      line('kaspi', 98000, '2026-10-24T09:00:30.000Z', { operation_id: '9002' }),
      line('kaspi', 12345, '2026-10-24T10:00:00.000Z', { operation_id: '7777' }),
    ],
  });
  const state = (f) => report.rows.find((r) => r.pickchick?.id === f.id || r.key === 'int:' + f.id);
  assert.equal(state(byId).state, 'matched');
  assert.equal(state(byId).rule, 'operation_id');
  assert.equal(state(byTime).state, 'matched');
  assert.equal(state(byTime).rule, 'amount_time');
  assert.equal(state(lost).state, 'missing_in_bank');
  assert.equal(state(lost).amount_minor, '-30000');
  assert.equal(state(differs).state, 'amount_differs');
  assert.equal(state(differs).amount_minor, '-1000');
  const extra = report.rows.find((r) => r.state === 'missing_in_pickchick');
  assert.equal(extra.amount_minor, '12345');
  assert.equal(extra.method, 'kaspi_other');
  // Every tenge of the difference per method is explained by its rows.
  for (const m of report.methods.filter((m) => m.coverage === 'statement')) {
    const own = pairRows(report).filter((r) => r.method === m.method);
    assert.equal(BigInt(m.bank_minor) - BigInt(m.expected_minor ?? '0'), sum(own), m.method);
    assert.equal(m.difference_minor, String(sum(own)));
  }
  assert.equal(report.methods.find((m) => m.method === 'kaspi_qr').expected_minor, '100000');
  // Outside the window or with two different identifiers nothing is paired by amount.
  const far = day({
    facts: [fact('kaspi_qr', 70000, '2026-10-24T07:00:00.000Z')],
    lines: [line('kaspi', 70000, '2026-10-24T07:11:00.000Z')],
  });
  assert.deepEqual(far.rows.map((r) => r.state).sort(), [
    'missing_in_bank',
    'missing_in_pickchick',
  ]);
  const twoIds = day({
    facts: [fact('kaspi_qr', 70000, '2026-10-24T07:00:00.000Z', { operation_id: '1' })],
    lines: [line('kaspi', 70000, '2026-10-24T07:00:00.000Z', { operation_id: '2' })],
  });
  assert.equal(twoIds.rows.filter((r) => r.state === 'matched').length, 0);
  // Sources never mix: a TipTopPay line cannot settle a Kaspi capture.
  const mixed = day({
    facts: [fact('kaspi_qr', 70000, '2026-10-24T07:00:00.000Z')],
    lines: [line('tiptoppay', 70000, '2026-10-24T07:00:00.000Z')],
  });
  assert.equal(mixed.rows.filter((r) => r.state === 'matched').length, 0);
});

test('late operations across midnight are visible on both business days', () => {
  const f = fact('kaspi_qr', 50000, '2026-10-24T18:58:00.000Z'); // 23:58 Almaty
  const l = line('kaspi', 50000, '2026-10-24T19:03:00.000Z'); // 00:03 next day
  const today = day({ facts: [f], lines: [l] });
  const row = today.rows.find((r) => r.state === 'late');
  assert.equal(row.amount_minor, '-50000');
  assert.equal(row.explanation, 'Другой день: в PickChick 24.10, в банке 25.10');
  // No statement line falls on the 24th: Kaspi has no coverage that day, but the late pair holds.
  assert.equal(today.methods.find((m) => m.method === 'kaspi_qr').coverage, 'none');
  assert.equal(today.rows.length, 1);
  const tomorrow = reconcileDay({ ...baseInput(), day: '2026-10-25', facts: [f], lines: [l] });
  const next = tomorrow.rows.find((r) => r.state === 'late');
  assert.equal(next.key, row.key);
  assert.equal(next.amount_minor, '50000');
  const qr = tomorrow.methods.find((m) => m.method === 'kaspi_qr');
  assert.equal(qr.bank_minor, '50000');
  assert.equal(qr.expected_minor, '0');
  assert.equal(qr.difference_minor, '50000');
});
function baseInput() {
  return {
    facts: [],
    lines: [],
    totals: [],
    orders: [],
    shifts: [],
    gifts: { orders: 0, discount_minor: 0n },
    unknown_attempts: {},
  };
}

test('duplicate statement lines and double payments are flagged, never counted twice', () => {
  const f = fact('kaspi_remote', 20000, '2026-10-24T05:00:00.000Z', { operation_id: 'kaspi:42' });
  const first = line('kaspi', 20000, '2026-10-24T05:00:10.000Z', { operation_id: '42' });
  const again = line('kaspi', 20000, '2026-10-24T05:00:10.000Z', {
    operation_id: '42',
    import_id: 'import-2',
  });
  const plainA = line('kaspi', 1000, '2026-10-24T06:00:00.000Z', { import_id: 'import-1' });
  const plainB = line('kaspi', 1000, '2026-10-24T06:00:00.000Z', { import_id: 'import-2' });
  const report = day({ facts: [f], lines: [first, again, plainA, plainB] });
  const states = Object.fromEntries(report.rows.map((r) => [r.bank?.id ?? r.key, r.state]));
  assert.equal(states[first.id], 'matched');
  assert.equal(states[again.id], 'duplicate');
  assert.equal(states[plainA.id], 'missing_in_pickchick');
  assert.equal(states[plainB.id], 'duplicate');
  const remote = report.methods.find((m) => m.method === 'kaspi_remote');
  assert.equal(remote.bank_minor, '20000');
  assert.equal(remote.bank_count, 1);
  // Same order paid twice (double capture): the excess must be refunded or explained.
  const order = id();
  const twice = day({
    facts: [
      fact('kaspi_qr', 150000, '2026-10-24T05:00:00.000Z', { order_id: order }),
      fact('kaspi_qr', 150000, '2026-10-24T05:01:00.000Z', { order_id: order }),
    ],
    orders: [
      {
        order_id: order,
        method: 'kaspi_qr',
        total_minor: 150000n,
        captured_minor: 300000n,
        refunded_minor: 0n,
        last_capture_day: D,
      },
    ],
  });
  const dbl = twice.rows.find((r) => r.rule === 'double_payment');
  assert.equal(dbl.state, 'duplicate');
  assert.equal(dbl.amount_minor, '150000');
  assert.equal(twice.methods.find((m) => m.method === 'kaspi_qr').orders_paid, 1);
});

test('a refund line under the id of its payment is money out, not a repeated statement line', () => {
  const order = id();
  const capture = fact('kaspi_remote', 300000, '2026-10-24T05:00:00.000Z', {
    order_id: order,
    operation_id: 'kaspi:61',
  });
  const refund = fact('manual_refund', -50000, '2026-10-24T09:00:00.000Z', {
    order_id: order,
    operation_id: 'manual:KP-9',
  });
  const paid = line('kaspi', 300000, '2026-10-24T05:00:10.000Z', { operation_id: '61' });
  const back = line('kaspi', -50000, '2026-10-24T09:30:00.000Z', { operation_id: '61' });
  const again = line('kaspi', -50000, '2026-10-24T09:30:00.000Z', {
    operation_id: '61',
    import_id: 'import-2',
  });
  // Without a payment line the refund line must not settle the capture as "amount differs".
  const alone = day({ facts: [capture], lines: [back] });
  assert.equal(alone.rows.filter((r) => r.state === 'amount_differs').length, 0);
  const report = day({ facts: [capture, refund], lines: [paid, back, again] });
  const byLine = (l) => report.rows.find((r) => r.bank?.id === l.id);
  assert.equal(byLine(paid).state, 'matched');
  assert.deepEqual(
    [byLine(back).state, byLine(back).amount_minor],
    ['missing_in_pickchick', '-50000'],
  );
  assert.equal(byLine(again).state, 'duplicate');
  const manual = report.rows.find((r) => r.key === 'int:' + refund.id);
  assert.deepEqual([manual.state, manual.amount_minor], ['missing_in_bank', '50000']);
  // The refund stays in the bank sum: across methods the differences still add up.
  const total = report.methods.reduce((a, m) => a + BigInt(m.difference_minor ?? '0'), 0n);
  assert.equal(total, sum(pairRows(report)));
  assert.equal(total, 0n);
});

test('partial refund, no bank data, manual totals and the cashier cash discrepancy', () => {
  const order = id();
  const capture = fact('tiptoppay', 300000, '2026-10-24T05:00:00.000Z', {
    order_id: order,
    operation_id: '81',
  });
  const refund = fact('tiptoppay', -100000, '2026-10-24T09:00:00.000Z', {
    order_id: order,
    operation_id: '82',
  });
  const manual = fact('manual_refund', -20000, '2026-10-24T10:00:00.000Z', {
    operation_id: 'manual:KP-1',
  });
  const report = day({
    facts: [capture, refund, manual],
    lines: [
      line('tiptoppay', 300000, '2026-10-24T05:00:05.000Z', { operation_id: '81' }),
      line('tiptoppay', -100000, '2026-10-24T09:00:05.000Z', { operation_id: '82' }),
    ],
    totals: [
      {
        id: id(),
        method: 'cash',
        source: 'kkm',
        amount_minor: 450000n,
        comment: 'Z-отчёт ККМ',
        created_at: '2026-10-25T03:00:00.000Z',
        author: 'Бухгалтер',
      },
    ],
    shifts: [
      { shift_id: id(), closed_at: '2026-10-24T16:00:00.000Z', day: D, discrepancy_minor: -5000n },
    ],
  });
  const card = report.methods.find((m) => m.method === 'tiptoppay');
  assert.deepEqual(
    [
      card.captures_minor,
      card.refunds_minor,
      card.expected_minor,
      card.bank_minor,
      card.difference_minor,
    ],
    ['300000', '100000', '200000', '200000', '0'],
  );
  assert.equal(
    report.rows.filter((r) => r.method === 'tiptoppay' && r.state === 'matched').length,
    2,
  );
  // Manual refunds without a Kaspi statement: one "no bank data" item for the whole method.
  const nobank = report.rows.find((r) => r.key === 'nobank:manual_refund');
  assert.equal(nobank.state, 'missing_in_bank');
  assert.equal(nobank.amount_minor, '20000');
  const cash = report.rows.find((r) => r.rule === 'manual_total');
  assert.equal(cash.state, 'missing_in_pickchick');
  assert.equal(cash.amount_minor, '450000');
  assert.equal(report.methods.find((m) => m.method === 'cash').expected_minor, null);
  assert.equal(report.rows.find((r) => r.rule === 'cash_shift').amount_minor, '-5000');
  // A bank total for a recorded method is compared with the PickChick expectation.
  const total = (amount) =>
    day({
      facts: [capture],
      totals: [
        {
          id: 't-1',
          method: 'tiptoppay',
          source: 'bank',
          amount_minor: BigInt(amount),
          comment: 'Итог банка',
          created_at: '2026-10-25T03:00:00.000Z',
          author: 'Бухгалтер',
        },
      ],
    });
  assert.equal(total(300000).rows[0].state, 'matched');
  assert.equal(total(290000).rows[0].state, 'amount_differs');
  assert.equal(total(290000).rows[0].amount_minor, '-10000');
  assert.equal(total(290000).rows.length, 1);
  assert.equal(total(290000).methods.find((m) => m.method === 'tiptoppay').coverage, 'total');
});

test('the fingerprint changes when a late fact appears and stays stable otherwise', () => {
  const f = fact('kaspi_qr', 50000, '2026-10-24T06:00:00.000Z');
  const a = day({ facts: [f] }).fingerprint;
  assert.equal(day({ facts: [f] }).fingerprint, a);
  assert.notEqual(
    day({ facts: [f, fact('kaspi_qr', 1, '2026-10-24T07:00:00.000Z')] }).fingerprint,
    a,
  );
  assert.match(a, /^[a-f0-9]{64}$/);
});
