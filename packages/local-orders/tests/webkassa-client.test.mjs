import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FiscalCheckError,
  WebkassaSession,
  buildWebkassaCheck,
  readWebkassaAnswer,
} from '@pickchick/local-orders';

// Webkassa client against a simulator only (no real register, synthetic data).
const account = {
  baseUrl: 'https://devkkm.example.test',
  apiKey: 'synthetic-key',
  login: 'synthetic@example.test',
  password: 'synthetic',
  cashboxUniqueNumber: 'SWK00000000',
};
const sale = (extra = {}) => ({
  operation: 'sale',
  externalNumber: '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90',
  lines: [
    { name: 'Синтетическое комбо', quantity: 2, unitPriceMinor: 250000n, totalMinor: 450000n },
    { name: 'Синтетический напиток', quantity: 1, unitPriceMinor: 60000n, totalMinor: 60000n },
  ],
  payments: [{ method: 'cash', amountMinor: 600000n }],
  changeMinor: 90000n,
  vatPercent: 0,
  ...extra,
});

/** Keeps issued checks by ExternalCheckNumber and answers a repeat with the same receipt. */
function simulator({ script = [] } = {}) {
  const calls = [];
  const issued = new Map();
  let tokens = 0;
  return {
    calls,
    issued,
    async post(_base, method, apiKey, body) {
      calls.push({ method, body });
      assert.equal(apiKey, account.apiKey);
      const step = script.shift();
      if (step) return step(method, body);
      if (method === 'api/Authorize') return { kind: 'ok', data: { Token: `t${++tokens}` } };
      const existing = issued.get(body.ExternalCheckNumber);
      if (existing) return { kind: 'ok', data: existing };
      const data = {
        CheckNumber: String(1000 + issued.size),
        DateTime: '16.11.2026 12:00:00',
        OfflineMode: false,
        ShiftNumber: 7,
        TicketUrl: `https://ofd.example.test/t/${issued.size}`,
      };
      issued.set(body.ExternalCheckNumber, data);
      return { kind: 'ok', data };
    },
  };
}

test('sale body: tenge amounts, discount, change, payment type, idempotency key', () => {
  const body = buildWebkassaCheck(sale(), account.cashboxUniqueNumber);
  assert.equal(body.OperationType, 2);
  assert.equal(body.ExternalCheckNumber, sale().externalNumber);
  assert.deepEqual(body.Payments, [{ Sum: 6000, PaymentType: 0 }]);
  assert.equal(body.Change, 900);
  assert.equal(body.Positions[0].Price, 2500);
  assert.equal(body.Positions[0].Discount, 500);
  assert.equal(body.Positions[1].Tax, 0);
});

test('VAT included in price is rounded to tiyn', () => {
  const body = buildWebkassaCheck(
    sale({
      lines: [{ name: 'x', quantity: 1, unitPriceMinor: 100001n, totalMinor: 100001n }],
      payments: [{ method: 'kaspi_terminal', amountMinor: 100001n }],
      changeMinor: 0n,
      vatPercent: 12,
    }),
    account.cashboxUniqueNumber,
  );
  // 1000.01 * 12 / 112 = 107.1439… -> 107.14
  assert.equal(body.Positions[0].Tax, 107.14);
  assert.equal(body.Positions[0].TaxType, 100);
  assert.deepEqual(body.Payments, [{ Sum: 1000.01, PaymentType: 1 }]);
});

test('money that does not add up is never sent', () => {
  const reason = (expected) => (error) =>
    error instanceof FiscalCheckError && error.reason === expected;
  assert.throws(() => buildWebkassaCheck(sale({ changeMinor: 0n }), 'S'), reason('TOTAL'));
  assert.throws(
    () => buildWebkassaCheck(sale({ payments: [{ method: 'glovo', amountMinor: 600000n }] }), 'S'),
    reason('METHOD'),
  );
  assert.throws(() => buildWebkassaCheck(sale({ operation: 'refund' }), 'S'), reason('CHANGE'));
  assert.throws(
    () =>
      buildWebkassaCheck(
        sale({
          payments: [
            { method: 'kaspi_terminal', amountMinor: 590000n },
            { method: 'cash', amountMinor: 10000n },
          ],
        }),
        'S',
      ),
    reason('CHANGE'),
  );
});

test('issue: authorizes once, a repeat after a lost answer returns the same receipt', async () => {
  const sim = simulator();
  const session = new WebkassaSession(account, sim);
  const first = await session.issue(sale());
  assert.equal(first.kind, 'issued');
  assert.equal(first.receipt.checkNumber, '1000');
  // The answer of a second call is lost after Webkassa made the receipt: repeating is safe.
  const lostOnce = simulator();
  const s2 = new WebkassaSession(account, {
    ...lostOnce,
    async post(...args) {
      const result = await lostOnce.post(...args);
      if (
        args[1] === 'api/Check' &&
        lostOnce.calls.filter((c) => c.method === 'api/Check').length === 1
      )
        return { kind: 'lost', reason: 'TIMEOUT' };
      return result;
    },
  });
  assert.equal((await s2.issue(sale())).kind, 'lost');
  const again = await s2.issue(sale());
  assert.equal(again.kind, 'issued');
  assert.equal(lostOnce.issued.size, 1);
  assert.equal(sim.calls.filter((c) => c.method === 'api/Authorize').length, 1);
});

test('expired token is renewed once; other refusals are returned', async () => {
  const sim = simulator({
    script: [
      () => ({ kind: 'ok', data: { Token: 'old' } }),
      () => ({
        kind: 'refused',
        httpStatus: 200,
        errors: [{ code: 2, text: 'Срок сессии истек' }],
      }),
    ],
  });
  const session = new WebkassaSession(account, sim);
  assert.equal((await session.issue(sale())).kind, 'issued');
  assert.deepEqual(
    sim.calls.map((c) => c.method),
    ['api/Authorize', 'api/Check', 'api/Authorize', 'api/Check'],
  );
  const shift = simulator({
    script: [
      () => ({ kind: 'ok', data: { Token: 't' } }),
      () => ({ kind: 'refused', httpStatus: 200, errors: [{ code: 11, text: 'Смена 24 часа' }] }),
    ],
  });
  const refused = await new WebkassaSession(account, shift).issue(sale());
  assert.equal(refused.kind, 'refused');
  assert.equal(refused.errors[0].code, 11);
});

test('unreachable Webkassa sends nothing that could make a receipt', async () => {
  const sim = simulator({ script: [() => ({ kind: 'unreachable', reason: 'CONNECT' })] });
  assert.equal((await new WebkassaSession(account, sim).issue(sale())).kind, 'unreachable');
  assert.equal(sim.calls.filter((c) => c.method === 'api/Check').length, 0);
});

test('answer parsing', () => {
  assert.equal(readWebkassaAnswer(200, '{"Data":{"CheckNumber":"1"}}').kind, 'ok');
  assert.equal(readWebkassaAnswer(200, '{"Errors":[{"Code":1,"Text":"x"}]}').kind, 'refused');
  assert.equal(readWebkassaAnswer(502, '<html>').kind, 'lost');
  assert.equal(readWebkassaAnswer(200, '{}').kind, 'lost');
});
