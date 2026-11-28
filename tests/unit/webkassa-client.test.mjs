import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  WebkassaClient,
  basisDateTime,
  checkBody,
  fiscalLinesOf,
  fiscalPaymentsOf,
  kaspiTerminalPaymentType,
  KASPI_TERMINAL_UNCONFIRMED_PAYMENT_TYPE,
  fitFiscalLines,
  readWebkassaAccount,
  returnBasisFromPrintForm,
  readWebkassaAnswer,
  webkassaEnvironment,
} from '@pickchick/local-orders';

// Webkassa API v4 client: request shapes and answers as seen on devkkm.webkassa.kz 25.11.2026.

test('answers: Data, Errors with the top-level CheckNumber of Code 14, garbage', () => {
  const ok = readWebkassaAnswer(200, '{"Data":{"CheckNumber":"132524690"}}');
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.data.CheckNumber, '132524690');
  const dup = readWebkassaAnswer(
    200,
    '{"CheckNumber":"132524690","Errors":[{"Code":14,"Text":"уже присутствует"}]}',
  );
  assert.equal(dup.kind, 'refused');
  assert.deepEqual(dup.errors, [{ code: 14, text: 'уже присутствует' }]);
  assert.equal(dup.top.CheckNumber, '132524690');
  assert.deepEqual(readWebkassaAnswer(200, '<html>'), { kind: 'lost', reason: 'ANSWER' });
  assert.deepEqual(readWebkassaAnswer(200, '[]'), { kind: 'lost', reason: 'ANSWER' });
  assert.deepEqual(readWebkassaAnswer(500, '{}'), { kind: 'lost', reason: 'ANSWER' });
});

test('check body: tenge with tiyn, no VAT, piece unit, one payment per type, totals must match', () => {
  const body = checkBody('t', 'SWK00036966', {
    operation: 'sale',
    externalNumber: 'e1',
    orderNumber: '17',
    lines: [
      { name: 'Комбо', quantity: 3, unitPriceMinor: 99934n, discountMinor: 2n },
      { name: 'Соус', quantity: 1, unitPriceMinor: 30000n, discountMinor: 0n },
    ],
    payments: [
      { type: 0, amountMinor: 100000n },
      { type: 1, amountMinor: 229800n },
    ],
  });
  assert.equal(body.OperationType, 2);
  assert.equal(body.RoundType, 0);
  assert.equal(body.ExternalCheckNumber, 'e1');
  assert.equal(body.ExternalOrderNumber, '17');
  assert.deepEqual(body.Positions[0], {
    Count: 3,
    Price: 999.34,
    TaxType: 0,
    TaxPercent: 0,
    Tax: 0,
    PositionName: 'Комбо',
    PositionCode: '1',
    PositionType: 0,
    Discount: 0.02,
    Markup: 0,
    UnitCode: 796,
  });
  assert.deepEqual(body.Payments, [
    { Sum: 1000, PaymentType: 0 },
    { Sum: 2298, PaymentType: 1 },
  ]);
  assert.throws(() =>
    checkBody('t', 'SWK00036966', {
      operation: 'sale',
      externalNumber: 'e',
      lines: [{ name: 'x', quantity: 1, unitPriceMinor: 100n, discountMinor: 0n }],
      payments: [{ type: 0, amountMinor: 99n }],
    }),
  );
  assert.throws(() =>
    checkBody('t', 'SWK00036966', {
      operation: 'sale',
      externalNumber: 'e',
      lines: [{ name: 'x', quantity: 1, unitPriceMinor: 100n, discountMinor: 0n }],
      payments: [
        { type: 0, amountMinor: 50n },
        { type: 0, amountMinor: 50n },
      ],
    }),
  );
  const refund = checkBody('t', 'SWK00036966', {
    operation: 'refund',
    externalNumber: 'r1',
    lines: [{ name: 'x', quantity: 1, unitPriceMinor: 10000n, discountMinor: 0n }],
    payments: [{ type: 0, amountMinor: 10000n }],
    returnBasis: {
      checkNumber: '132524690',
      dateTime: '25.11.2026 14:34:29',
      total: 10000n,
      registrationNumber: '057946199798',
      offline: true,
    },
  });
  assert.equal(refund.OperationType, 3);
  assert.equal(refund.ReturnBasisDetails.DateTime, '2026-11-25 14:34:29');
  assert.equal(basisDateTime('01.02.2027 03:04:05'), '2027-02-01 03:04:05');
});

test('quote lines become receipt lines whose sum is the sale total to the tiyn', () => {
  const lines = fiscalLinesOf(
    {
      lines: [
        { name: { ru: 'Бургер', kk: 'Бургер' }, quantity: 3, total_minor: '100000' },
        { name: { kk: 'Сусын' }, quantity: 1, total_minor: '50000' },
      ],
    },
    150000n,
  );
  assert.deepEqual(
    lines.map((l) => [l.name, l.quantity, l.unitPriceMinor, l.discountMinor]),
    [
      ['Бургер', 3, 33334n, 2n],
      ['Сусын', 1, 50000n, 0n],
    ],
  );
  assert.throws(() => fiscalLinesOf({ lines: [] }, 1n));
  assert.throws(() => fiscalLinesOf({ lines: [{ name: 'x', quantity: 1, total_minor: '5' }] }, 6n));
  assert.deepEqual(
    fiscalPaymentsOf([
      { method: 'cash', amount_minor: '100' },
      { method: 'kaspi_manual', amount_minor: '200' },
    ]),
    [
      { type: 0, amountMinor: 100n },
      { type: 4, amountMinor: 200n },
    ],
  );
  assert.equal(fiscalPaymentsOf([{ method: 'aggregator_glovo', amount_minor: '100' }]), null);
});

test('a Kaspi terminal tender takes its type from the method the terminal reported (owner 28.11)', () => {
  assert.equal(kaspiTerminalPaymentType('card'), 1);
  assert.equal(kaspiTerminalPaymentType('qr'), 4);
  for (const method of ['alaqan', null, undefined, '', 'cash', 'something-new'])
    assert.equal(kaspiTerminalPaymentType(method), KASPI_TERMINAL_UNCONFIRMED_PAYMENT_TYPE);
  assert.deepEqual(
    fiscalPaymentsOf([
      { method: 'cash', amount_minor: '100' },
      { method: 'kaspi_terminal', amount_minor: '200', terminal_method: 'qr' },
      { method: 'kaspi_terminal', amount_minor: '300', terminal_method: 'qr' },
      { method: 'kaspi_terminal', amount_minor: '400', terminal_method: 'card' },
      { method: 'kaspi_terminal', amount_minor: '500', terminal_method: 'alaqan' },
      { method: 'kaspi_terminal', amount_minor: '600', terminal_method: null },
      { method: 'kaspi_terminal', amount_minor: '700' },
      { method: 'kaspi_manual', amount_minor: '800', terminal_method: 'card' },
    ]),
    [
      { type: 0, amountMinor: 100n },
      { type: 4, amountMinor: 1300n },
      { type: 1, amountMinor: 2200n },
    ],
    'the same type adds up; the terminal method means nothing for other methods',
  );
});

test('the client signs in once, renews an expired session and resolves a duplicate number', async () => {
  const calls = [];
  const answers = [
    { kind: 'ok', data: { Token: 'a' }, top: {} },
    { kind: 'refused', httpStatus: 200, errors: [{ code: 2, text: 'истек' }], top: {} },
    { kind: 'ok', data: { Token: 'b' }, top: {} },
    {
      kind: 'refused',
      httpStatus: 200,
      errors: [{ code: 14, text: 'уже присутствует' }],
      top: { CheckNumber: '555' },
    },
  ];
  const client = new WebkassaClient(
    {
      baseUrl: 'https://devkkm.webkassa.kz',
      apiKey: 'k',
      login: 'l',
      password: 'p',
      cashboxUniqueNumber: 'SWK00036966',
    },
    {
      transport: {
        async post(base, path, key, body) {
          calls.push([path, body.Token ?? null]);
          return answers.shift();
        },
      },
    },
  );
  const result = await client.issue({
    operation: 'sale',
    externalNumber: 'x',
    lines: [{ name: 'x', quantity: 1, unitPriceMinor: 100n, discountMinor: 0n }],
    payments: [{ type: 0, amountMinor: 100n }],
  });
  assert.equal(result.kind, 'issued');
  assert.equal(result.receipt.checkNumber, '555');
  assert.equal(result.receipt.duplicate, true);
  assert.deepEqual(calls, [
    ['api/v4/Authorize', null],
    ['api/v4/check', 'a'],
    ['api/v4/Authorize', null],
    ['api/v4/check', 'b'],
  ]);
});

test('account file: only Webkassa hosts, a SWK number and present fields; absent path = off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-'));
  const file = join(dir, 'webkassa.json');
  const good = {
    baseUrl: 'https://devkkm.webkassa.kz',
    apiKey: 'WKD-SYNTHETIC-0000',
    login: 'synthetic@example.com',
    password: 'p@ss word',
    cashboxUniqueNumber: 'SWK00036966',
  };
  writeFileSync(file, '\uFEFF' + JSON.stringify(good));
  assert.deepEqual(readWebkassaAccount(file), good);
  assert.equal(readWebkassaAccount(undefined), null);
  for (const bad of [
    { baseUrl: 'https://evil.example.com' },
    { baseUrl: 'http://devkkm.webkassa.kz' },
    { cashboxUniqueNumber: '36966' },
    { apiKey: '' },
    // Owner 27.11: the kiosk cashbox is another cashbox of the account, never the point's own.
    { kioskCashboxUniqueNumber: 'SWK00036966' },
    { kioskCashboxUniqueNumber: '36967' },
  ]) {
    writeFileSync(file, JSON.stringify({ ...good, ...bad }));
    assert.throws(() => readWebkassaAccount(file));
  }
  writeFileSync(file, JSON.stringify({ ...good, kioskCashboxUniqueNumber: 'SWK00036967' }));
  assert.equal(readWebkassaAccount(file).kioskCashboxUniqueNumber, 'SWK00036967');
});

test('test or live register: devkkm is TEST, a live point refuses it (audit 26.11 P0-2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-env-'));
  const file = join(dir, 'account.json');
  const account = {
    baseUrl: 'https://devkkm.webkassa.kz',
    apiKey: 'test-api-key-1',
    login: 'cashier@example.com',
    password: 'p',
    cashboxUniqueNumber: 'SWK00036966',
  };
  assert.equal(webkassaEnvironment(account), 'test');
  assert.equal(webkassaEnvironment({ baseUrl: 'https://kkm.webkassa.kz/' }), 'live');
  writeFileSync(file, JSON.stringify(account));
  assert.deepEqual(readWebkassaAccount(file, { requireLive: false }), account);
  assert.throws(() => readWebkassaAccount(file, { requireLive: true }), /live is required/);
  writeFileSync(file, JSON.stringify({ ...account, baseUrl: 'https://kkm.webkassa.kz' }));
  assert.equal(
    readWebkassaAccount(file, { requireLive: true })?.baseUrl,
    'https://kkm.webkassa.kz',
  );
});

// The tail of the 26.11 devkkm sale form (receipt 132600001), as Ticket/PrintFormat returns it.
const SALE_FORM = [
  'Чек/Чек №132600001',
  'ФБ/ФП: 132600001',
  'Уақыты/Время: 26.11.2026 12:01:05',
  'Чек автономды режимде құрастырылған/Чек',
  'сформирован в автономном режиме',
  'МКК БКМ коды (КТН)/Код ККМ КГД (РНМ):',
  '057946199798',
  'КЗН/ЗНМ: SWK00036966',
].map((value, order) => ({ order, type: 0, value, style: 0 }));

test('return basis comes from the sale print form: ФП, time, РНМ, offline mark', () => {
  assert.deepEqual(returnBasisFromPrintForm(SALE_FORM, '132600001', 419000n), {
    checkNumber: '132600001',
    dateTime: '26.11.2026 12:01:05',
    total: 419000n,
    registrationNumber: '057946199798',
    offline: true,
  });
  // A form of another receipt, no time, or no РНМ gives nothing to guess from.
  assert.equal(returnBasisFromPrintForm(SALE_FORM, '132600002', 419000n), null);
  assert.equal(
    returnBasisFromPrintForm(
      SALE_FORM.filter((l) => !/Время/.test(l.value)),
      '132600001',
      1n,
    ),
    null,
  );
  const noRnm = SALE_FORM.filter((l) => !/РНМ|^\d+$/.test(l.value));
  assert.equal(returnBasisFromPrintForm(noRnm, '132600001', 1n), null);
  assert.equal(returnBasisFromPrintForm(null, '132600001', 1n), null);
  // The РНМ is also on the QR link (param f); an online form has no offline mark.
  const online = [
    ...noRnm.filter((l) => !/автономн/.test(l.value)),
    {
      order: 9,
      type: 2,
      value: 'http://ctest2.wofd.kz/consumer?i=132600001&f=057946199798&s=4190.00',
      style: 0,
    },
  ];
  const basis = returnBasisFromPrintForm(online, '132600001', 1n);
  assert.equal(basis.registrationNumber, '057946199798');
  assert.equal(basis.offline, false);
});

test('a partial refund fits the sale lines by discounting the largest first', () => {
  const lines = [
    { name: 'Комбо', quantity: 2, unitPriceMinor: 175000n, discountMinor: 0n },
    { name: 'Морс', quantity: 1, unitPriceMinor: 69000n, discountMinor: 0n },
  ];
  const sum = (ls) =>
    ls.reduce((s, l) => s + l.unitPriceMinor * BigInt(l.quantity) - l.discountMinor, 0n);
  const half = fitFiscalLines(lines, 209500n);
  assert.equal(sum(half), 209500n);
  assert.equal(half[0].discountMinor, 209500n);
  assert.equal(half[1].discountMinor, 0n);
  assert.equal(lines[0].discountMinor, 0n, 'the input is not changed');
  const tiny = fitFiscalLines(lines, 2n);
  assert.deepEqual(
    tiny.map((l) => l.unitPriceMinor * BigInt(l.quantity) - l.discountMinor),
    [1n, 1n],
  );
  assert.deepEqual(fitFiscalLines(lines, 419000n), lines);
  assert.throws(() => fitFiscalLines(lines, 1n));
  assert.throws(() => fitFiscalLines(lines, 419001n));
  assert.throws(() => fitFiscalLines([], 1n));
});
