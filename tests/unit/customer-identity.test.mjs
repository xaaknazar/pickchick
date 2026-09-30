import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  CustomerIdentity,
  CustomerIdentityError,
  createCustomerIdentityOptions,
  normalizeKazakhstanPhone,
  isValidCustomerBirthDate,
  CustomerPatchSchema,
  OtpVerifySchema,
} from '../../packages/customer-identity/dist/index.js';
const invalid = (e) => e instanceof CustomerIdentityError && e.code === 'INVALID_REQUEST';
test('KZ mobile range normalization accepts national variants but rejects Russian +7, fixed line and embedded numbers', () => {
  for (const value of ['+77010000001', '8 (701) 000-00-01', '7010000001'])
    assert.equal(normalizeKazakhstanPhone(value), '+77010000001');
  for (const value of [
    '+79120000001',
    '+77270000001',
    '+17010000001',
    'tel:+77010000001',
    'send to +77010000001',
    '+77700000000x3',
  ])
    assert.throws(() => normalizeKazakhstanPhone(value), invalid);
});
test('birthday calendar uses Almaty current day, validates leap dates and rejects timestamps', () => {
  const now = Date.parse('2026-09-07T19:01:00Z'); // 8 September in Almaty
  for (const value of ['1900-01-01', '2000-02-29', '2024-02-29', '2026-09-08'])
    assert.equal(isValidCustomerBirthDate(value, now), true);
  for (const value of [
    '1899-12-31',
    '1900-02-29',
    '2025-02-29',
    '2026-09-09',
    '2026-09-08T00:00:00Z',
    '2026-9-8',
  ])
    assert.equal(isValidCustomerBirthDate(value, now), false);
});
test('profile schema allows clearing optional fields, requires non-null gender and rejects hidden fields', () => {
  assert.deepEqual(
    CustomerPatchSchema.parse({
      nickname: '  ' + '😀'.repeat(32) + '  ',
      birth_date: null,
      gender: 'female',
    }),
    { nickname: '😀'.repeat(32), birth_date: null, gender: 'female' },
  );
  for (const body of [
    {},
    { gender: null },
    { nickname: '😀'.repeat(33) },
    { nickname: 'a\nb' },
    { phone: '+77010000001' },
    { marketing_opt_in: 'true' },
  ])
    assert.equal(CustomerPatchSchema.safeParse(body).success, false);
  assert.equal(OtpVerifySchema.safeParse({ challenge_id: 'bad', code: '123456' }).success, false);
});
test('factory defaults disabled, blocks placeholder/reused crypto keys and requires explicit approved legal version/budget', async () => {
  const calls = [];
  const identity = new CustomerIdentity(
    {
      query() {
        calls.push('database');
        throw Error();
      },
    },
    createCustomerIdentityOptions(),
    {
      provider: 'disabled',
      async sendCode() {
        calls.push('sms');
      },
    },
  );
  assert.deepEqual(identity.config(), {
    enabled: false,
    consent_version: null,
    terms_url: null,
    privacy_url: null,
  });
  await assert.rejects(identity.requestOtp({ phone: '+77010000001' }, '192.0.2.1'), {
    code: 'SERVICE_UNAVAILABLE',
  });
  assert.deepEqual(calls, []);
  const env = {
    CUSTOMER_AUTH_ENABLED: 'true',
    CUSTOMER_AUTH_CONSENT_VERSION: 'test-only-v1',
    CUSTOMER_AUTH_DAILY_SMS_BUDGET: '1000',
    CUSTOMER_AUTH_TERMS_URL: 'https://example.test/terms',
    CUSTOMER_AUTH_PRIVACY_URL: 'https://example.test/privacy',
  };
  const names = ['LOOKUP', 'OTP', 'PII', 'RECEIPT'].map((v) => 'CUSTOMER_AUTH_' + v + '_KEY');
  for (const name of names) env[name] = randomBytes(32).toString('hex');
  assert.equal(createCustomerIdentityOptions(env).enabled, true);
  assert.equal(createCustomerIdentityOptions(env).dailySmsBudget, 1000);
  for (const extra of [
    { CUSTOMER_AUTH_TERMS_URL: 'https://secret@example.test/terms' },
    { CUSTOMER_AUTH_TERMS_URL: 'https://example.test/terms#secret' },
    { CUSTOMER_AUTH_TERMS_URL: 'javascript:alert(1)' },
    { CUSTOMER_AUTH_TERMS_URL: 'https://example.test/terms?token=secret' },
    { CUSTOMER_AUTH_DAILY_SMS_BUDGET: '0' },
    { CUSTOMER_AUTH_CONSENT_VERSION: '' },
    { [names[0]]: 'a'.repeat(64) },
    { [names[0]]: env[names[1]] },
  ])
    assert.throws(
      () => createCustomerIdentityOptions({ ...env, ...extra }),
      /CUSTOMER_AUTH_CONFIGURATION_INVALID/,
    );
});
