import { URLSearchParams } from 'node:url';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  verifyTipTopPayForm,
  tipTopPayMinor,
  parseTipTopPayPayment,
  tipTopPayConfig,
  TipTopPayReceiver,
} from '../../packages/commerce-core/dist/index.js';
import { checkTipTopPay } from '../../infra/payments/check-tiptoppay.mjs';
const secret = 'synthetic-secret-only-for-tests';
const sign = (body) => createHmac('sha256', secret).update(body).digest('base64');
const payment = () => ({
  TransactionId: '123456789012345678',
  Amount: '1.01',
  Currency: 'KZT',
  TestMode: '0',
  Status: 'Completed',
  OperationType: 'Payment',
  DateTime: '2026-09-28 08:00:00',
  InvoiceId: randomUUID(),
  AccountId: randomUUID(),
});

test('original encoded UTF-8 bytes are authenticated before parsing', () => {
  const body = Buffer.from(
    new URLSearchParams({ ...payment(), Description: 'Заказ + & соус' }).toString(),
  );
  assert.equal(verifyTipTopPayForm(body, sign(body), secret).Description, 'Заказ + & соус');
  assert.throws(() =>
    verifyTipTopPayForm(Buffer.concat([body, Buffer.from('x')]), sign(body), secret),
  );
  assert.throws(() => verifyTipTopPayForm(body, sign(body), 'other-secret'));
  for (const bad of [undefined, '', '==', sign(body) + 'x'])
    assert.throws(() => verifyTipTopPayForm(body, bad, secret));
});
test('duplicates and oversized forms are rejected', () => {
  for (const text of ['Amount=1&Amount=1000', 'a=' + 'x'.repeat(16384)]) {
    const raw = Buffer.from(text);
    assert.throws(() => verifyTipTopPayForm(raw, sign(raw), secret));
  }
});
test('amount conversion uses exact minor units, no rounding or exponent notation', () => {
  for (const [value, expected] of [
    ['1', '100'],
    ['1.01', '101'],
    ['4190.50', '419050'],
    ['0.01', '1'],
  ])
    assert.equal(tipTopPayMinor(value), expected);
  for (const value of ['0', '1.001', '01', '1e3', '-1', 'NaN', '1,00', ' 1', '99999999999999'])
    assert.throws(() => tipTopPayMinor(value));
});
test('sandbox, wrong currency, holds and payouts never become captured money', () => {
  for (const patch of [
    { TestMode: '1' },
    { TestMode: undefined },
    { Currency: 'USD' },
    { Status: 'Authorized' },
    { OperationType: 'CardPayout' },
    { DateTime: '2026-02-30 08:00:00' },
    { InvoiceId: '1' },
    { AccountId: 'phone' },
    { TransactionId: '1.1' },
  ])
    assert.throws(() => parseTipTopPayPayment({ ...payment(), ...patch }, 'pay'));
  const result = parseTipTopPayPayment(payment(), 'pay');
  assert.equal(result.amountMinor, '101');
  assert.equal(result.occurredAt, '2026-09-28T08:00:00.000Z');
  assert.equal(result.operationId, '123456789012345678');
  assert.ok(!('AccountId' in result));
});
test('default config is disabled and cannot enable checkout', () => {
  assert.equal(tipTopPayConfig({}), null);
  assert.throws(() => tipTopPayConfig({ TIPTOPPAY_WEBHOOKS_ENABLED: 'true' }));
  const env = {
    TIPTOPPAY_WEBHOOKS_ENABLED: 'true',
    TIPTOPPAY_PUBLIC_ID: 'pk_example',
    TIPTOPPAY_API_SECRET: secret,
    TIPTOPPAY_MODE: 'test',
    TIPTOPPAY_ACCOUNT_ID: randomUUID(),
  };
  assert.throws(() => tipTopPayConfig(env));
  assert.equal(tipTopPayConfig({ ...env, TIPTOPPAY_MODE: 'live' }).acceptNewPayments, false);
});
test('disabled receiver does not access DB; sandbox is rejected before DB', async () => {
  const pool = {
    query() {
      throw new Error('DB must not be accessed');
    },
  };
  const raw = Buffer.from(new URLSearchParams({ ...payment(), TestMode: '1' }).toString());
  await assert.rejects(new TipTopPayReceiver(pool, null).receive('pay', raw, sign(raw)), {
    code: 'DISABLED',
  });
  await assert.rejects(
    new TipTopPayReceiver(pool, { apiSecret: secret }).receive('pay', raw, sign(raw)),
    { code: 'MODE' },
  );
});
test('missing, mismatched account and wrong price cannot authorize a payment', async () => {
  const fields = payment(),
    raw = Buffer.from(new URLSearchParams(fields).toString());
  for (const row of [
    undefined,
    { customer_id: randomUUID(), intended_minor: '101' },
    { customer_id: fields.AccountId, intended_minor: '102' },
  ]) {
    const pool = {
      async query() {
        return { rows: row ? [row] : [] };
      },
    };
    await assert.rejects(
      new TipTopPayReceiver(pool, {
        apiSecret: secret,
        accountId: randomUUID(),
        publicId: 'pk_example',
        acceptNewPayments: false,
      }).receive('check', raw, sign(raw)),
      { code: 'BINDING' },
    );
  }
});
test('valid Check remains denied while checkout rollout is not enabled', async () => {
  const fields = payment(),
    raw = Buffer.from(new URLSearchParams(fields).toString());
  const pool = {
    async query() {
      return {
        rows: [
          {
            customer_id: fields.AccountId,
            intended_minor: '101',
            enabled: true,
            state: 'pending',
            order_state: 'awaiting_payment',
            has_capture: false,
          },
        ],
      };
    },
  };
  assert.deepEqual(
    await new TipTopPayReceiver(pool, { apiSecret: secret, acceptNewPayments: false }).receive(
      'check',
      raw,
      sign(raw),
    ),
    { code: 13 },
  );
});
test('credential probe calls only fixed read-only test endpoint, without redirect', async () => {
  let calls = 0;
  const result = await checkTipTopPay(
    { TIPTOPPAY_PUBLIC_ID: 'pk_example', TIPTOPPAY_API_SECRET: secret },
    async (url, opts) => {
      calls++;
      assert.equal(url, 'https://api.tiptoppay.kz/test');
      assert.equal(opts.redirect, 'error');
      assert.equal(opts.body, '{}');
      return {
        ok: true,
        async json() {
          return { Success: true, Token: 'must-not-return' };
        },
      };
    },
  );
  assert.deepEqual(result, { credentialsAccepted: true, reason: 'ok' });
  assert.equal(calls, 1);
  assert.equal(
    (
      await checkTipTopPay({}, () => {
        throw Error('no call');
      })
    ).reason,
    'credentials_missing',
  );
});
