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
  readWebkassaAccount,
  readWebkassaAnswer,
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
  ]) {
    writeFileSync(file, JSON.stringify({ ...good, ...bad }));
    assert.throws(() => readWebkassaAccount(file));
  }
});
