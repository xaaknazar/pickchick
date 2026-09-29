import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  KaspiBridgeClient,
  findByReference,
  kaspiInvoiceOutcome,
  kaspiMinor,
  kaspiPhone,
  kaspiRemoteConfig,
  verifyKaspiBridgeWebhook,
} from '../../packages/commerce-core/dist/index.js';
import { readCustomerPaymentPhone } from '../../packages/customer-identity/dist/index.js';

const secret = 'synthetic_kaspi_bridge_webhook_secret_0001';
const base = {
  KASPI_REMOTE_ENABLED: 'true',
  KASPI_BRIDGE_URL: 'http://127.0.0.1:3931',
  KASPI_BRIDGE_WEBHOOK_SECRET: secret,
  KASPI_REMOTE_ACCOUNT_ID: randomUUID(),
};
const session = {
  KASPI_SESSION_TOKEN_SN: 'synthetic-token-sn',
  KASPI_SESSION_VTOKEN_SECRET: Buffer.from('synthetic-encrypted-secret').toString('base64'),
  KASPI_SESSION_PROFILE_ID: '12345',
};

test('configuration is opt-in, loopback-only and validates every secret shape', () => {
  assert.equal(kaspiRemoteConfig({}), null);
  assert.equal(kaspiRemoteConfig({ KASPI_REMOTE_ENABLED: 'false' }), null);
  assert.throws(() => kaspiRemoteConfig({ KASPI_REMOTE_ENABLED: 'yes' }), { code: 'INVALID' });
  const ok = kaspiRemoteConfig({ ...base, ...session });
  assert.equal(ok.bridgeUrl, 'http://127.0.0.1:3931');
  assert.equal(ok.invoiceTtlSeconds, 600);
  assert.equal(ok.session.profileId, '12345');
  assert.equal(kaspiRemoteConfig(base).session, null);
  for (const bad of [
    { KASPI_BRIDGE_URL: 'http://10.0.0.5:3931' },
    { KASPI_BRIDGE_URL: 'https://127.0.0.1:3931' },
    { KASPI_BRIDGE_URL: 'http://user:pw@127.0.0.1:3931' },
    { KASPI_BRIDGE_URL: 'http://kaspi.example.com' },
    { KASPI_BRIDGE_WEBHOOK_SECRET: 'short' },
    { KASPI_REMOTE_ACCOUNT_ID: 'not-a-uuid' },
    { KASPI_INVOICE_TTL_SECONDS: '30' },
    { KASPI_INVOICE_TTL_SECONDS: '10.5' },
    { ...session, KASPI_SESSION_PROFILE_ID: '' },
    { ...session, KASPI_SESSION_TOKEN_SN: 'x' },
  ])
    assert.throws(() => kaspiRemoteConfig({ ...base, ...bad }), { code: 'INVALID' });
});

test('phones, amounts and statuses are mapped conservatively', () => {
  assert.equal(kaspiPhone('+77011234567'), '77011234567');
  for (const bad of ['+76011234567', '87011234567', '+7701123456', '+1 7011234567'])
    assert.equal(kaspiPhone(bad), null);
  assert.equal(kaspiMinor(1500), '150000');
  assert.equal(kaspiMinor('1500.5'), '150050');
  for (const bad of [0, -1, '1e3', 1.234, 'abc', null]) assert.equal(kaspiMinor(bad), null);
  assert.equal(kaspiInvoiceOutcome('Processed'), 'captured');
  assert.equal(kaspiInvoiceOutcome('RemotePaymentCreated'), 'pending');
  for (const s of ['RemotePaymentCanceled', 'RemotePaymentRejected', 'Expired'])
    assert.equal(kaspiInvoiceOutcome(s), 'failed');
  // An unfamiliar status is never read as a failure: money may still arrive.
  for (const s of ['Wait', 'Error', 'SomethingNew', undefined, 5])
    assert.equal(kaspiInvoiceOutcome(s), 'unknown');
});

test('bridge webhook requires the exact-byte HMAC and yields only an operation id', () => {
  const body = Buffer.from(
    JSON.stringify({ event: 'payment.success', paymentId: '9876543', type: 'invoice' }),
  );
  const sign = (raw, key = secret) =>
    'sha256=' + createHmac('sha256', key).update(raw).digest('hex');
  assert.deepEqual(verifyKaspiBridgeWebhook(body, sign(body), secret), { operationId: '9876543' });
  const numeric = Buffer.from(JSON.stringify({ paymentId: 42, type: 'invoice' }));
  assert.equal(verifyKaspiBridgeWebhook(numeric, sign(numeric), secret).operationId, '42');
  const altered = Buffer.from(body.toString().replace('9876543', '9876544'));
  assert.throws(() => verifyKaspiBridgeWebhook(altered, sign(body), secret), {
    code: 'SIGNATURE',
  });
  assert.throws(() => verifyKaspiBridgeWebhook(body, sign(body, 'other-secret'), secret), {
    code: 'SIGNATURE',
  });
  assert.throws(() => verifyKaspiBridgeWebhook(body, undefined, secret), { code: 'SIGNATURE' });
  const qr = Buffer.from(JSON.stringify({ paymentId: '1', type: 'qr' }));
  assert.throws(() => verifyKaspiBridgeWebhook(qr, sign(qr), secret), { code: 'INVALID' });
  for (const value of ['null', '[]', 'true']) {
    const raw = Buffer.from(value);
    assert.throws(() => verifyKaspiBridgeWebhook(raw, sign(raw), secret), { code: 'INVALID' });
  }
  const junk = Buffer.from('not json');
  assert.throws(() => verifyKaspiBridgeWebhook(junk, sign(junk), secret), { code: 'INVALID' });
});

test('history search needs the reference in a text field and an operation id', () => {
  const history = {
    Items: [
      { QrOperationId: 11, Comment: 'PickChick ABCDEFGH23', Amount: 1000 },
      { QrOperationId: 12, Comment: 'PickChick ZZZZZZZZZZ', Amount: 1000 },
      { Comment: 'PickChick ABCDEFGH23' },
      { QrOperationId: 13, Comment: 'PickChick ABCDEFGH234' },
    ],
  };
  const found = findByReference(history, 'ABCDEFGH23');
  assert.equal(found.length, 1);
  assert.equal(found[0].QrOperationId, 11);
  assert.deepEqual(findByReference([], 'ABCDEFGH23'), []);
});

test('bridge client separates unsent, uncertain, session, rejected and success answers', async () => {
  const config = kaspiRemoteConfig({ ...base, ...session });
  const calls = [];
  const reply = (status, body) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  const run = async (answer) => {
    const client = new KaspiBridgeClient(config, async (url, init) => {
      calls.push({ url, init });
      return answer();
    });
    return client.createInvoice('77011234567', 1000, 'PickChick ABCDEFGH23');
  };
  assert.deepEqual(await run(() => reply(200, { StatusCode: 0, Data: { QrOperationId: 5 } })), {
    kind: 'ok',
    data: { QrOperationId: 5 },
  });
  const sent = calls.at(-1);
  assert.equal(sent.url, 'http://127.0.0.1:3931/api/invoice/create');
  assert.equal(sent.init.headers['X-Token-SN'], 'synthetic-token-sn');
  assert.deepEqual(JSON.parse(sent.init.body), {
    phoneNumber: '77011234567',
    amount: 1000,
    comment: 'PickChick ABCDEFGH23',
  });
  assert.deepEqual(await run(() => reply(200, { StatusCode: 7, Data: null })), {
    kind: 'rejected',
    statusCode: 7,
  });
  assert.deepEqual(await run(() => reply(200, { StatusCode: -101001 })), { kind: 'session' });
  assert.deepEqual(await run(() => reply(401, { error: 'Missing X-Token-SN header.' })), {
    kind: 'session',
  });
  assert.deepEqual(await run(() => reply(500, { error: 'socket hang up' })), {
    kind: 'uncertain',
  });
  assert.deepEqual(await run(() => reply(200, '<html>')), { kind: 'uncertain' });
  assert.deepEqual(await run(() => reply(200, { StatusCode: 0 })), { kind: 'uncertain' });
  assert.deepEqual(
    await run(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }),
    { kind: 'unsent' },
  );
  assert.deepEqual(
    await run(() => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }),
    { kind: 'uncertain' },
  );
  const cancel = new KaspiBridgeClient(config, async () => reply(200, { StatusCode: 0 }));
  assert.deepEqual(await cancel.cancel('5'), { kind: 'ok', data: {} });
  assert.deepEqual(await cancel.details('5'), { kind: 'uncertain' });
  const history = new KaspiBridgeClient(config, async (url, init) => {
    calls.push({ url, init });
    return reply(200, { StatusCode: 0, Data: [] });
  });
  await history.history();
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { maxResult: 200 });
  const noSession = new KaspiBridgeClient(kaspiRemoteConfig(base), async () => {
    throw new Error('must not be called');
  });
  assert.deepEqual(await noSession.details('1'), { kind: 'session' });
});

test('payment phone is read only for an active customer with auth enabled', async () => {
  const key = randomBytes(32),
    id = randomUUID();
  const seal = (value) => {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`phone:${id}`));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map((v) => v.toString('base64url')).join('.');
  };
  let row = { phone_cipher: seal('+77011234567'), deleted_at: null };
  const pool = { query: async () => ({ rows: row ? [row] : [] }) };
  const options = { enabled: true, piiKey: key };
  assert.equal(await readCustomerPaymentPhone(pool, options, id), '+77011234567');
  assert.equal(await readCustomerPaymentPhone(pool, { enabled: false }, id), null);
  assert.equal(await readCustomerPaymentPhone(pool, options, 'bad-id'), null);
  row = { phone_cipher: null, deleted_at: new Date() };
  assert.equal(await readCustomerPaymentPhone(pool, options, id), null);
  row = null;
  assert.equal(await readCustomerPaymentPhone(pool, options, id), null);
});

test('cashier login stops before OTP on an obsolete client without printing provider data', async () => {
  const { requireSmsSent } = await import('../../infra/payments/kaspi-bridge/kaspi-login.mjs');
  assert.doesNotThrow(() => requireSmsSent({ success: true }));
  assert.throws(() => requireSmsSent({ success: false, view: 'KPEnterLoginPassword' }), {
    message: 'CASHIER_PASSWORD_LOGIN_NOT_SUPPORTED',
  });
  assert.throws(
    () =>
      requireSmsSent({
        success: false,
        body: {
          view: {
            onOpenAlarm: {
              error: { code: 'OldVersionToUpdate', label: 'private provider response' },
            },
          },
        },
      }),
    { message: 'KASPI_CLIENT_UPDATE_REQUIRED' },
  );
  for (const result of [null, {}, { success: 'true' }, { success: false }])
    assert.throws(() => requireSmsSent(result), { message: 'SMS_NOT_SENT' });
});

test('cashier login helper accepts only a KZ mobile and writes only the three session values', async () => {
  const { cashierPhone, sessionEnv } =
    await import('../../infra/payments/kaspi-bridge/kaspi-login.mjs');
  assert.equal(cashierPhone('+7 701 123 45 67'), '7011234567');
  assert.equal(cashierPhone('87011234567'), '7011234567');
  assert.equal(cashierPhone('7011234567'), '7011234567');
  assert.equal(cashierPhone('+7 601 123 45 67'), null);
  const env = sessionEnv({
    tokenSN: 'synthetic-token-sn',
    vtokenSecret: Buffer.from('synthetic-encrypted-secret').toString('base64'),
    profileId: 12345,
    phone: '77011234567',
  });
  assert.equal(env.split('\n').filter(Boolean).length, 3);
  assert.ok(!env.includes('77011234567'));
  assert.throws(() => sessionEnv({ tokenSN: 'x\nINJECT=1', vtokenSecret: 'y', profileId: 1 }));
});

test('session check rejects invoice arguments before any bridge request', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../../infra/payments/kaspi-bridge/kaspi-check.mjs', import.meta.url)),
      '--invoice-phone',
      '+77011234567',
    ],
    { encoding: 'utf8', env: { ...process.env, ...base, ...session } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /READ_ONLY_CHECK_NO_ARGUMENTS/);
  assert.ok(!result.stderr.includes('77011234567'));
  assert.equal(result.stdout, '');
});
