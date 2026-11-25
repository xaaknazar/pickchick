import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountFromEnv, parseEnv } from '../../scripts/webkassa-account-from-env.mjs';

const env = [
  '# comment',
  'export WEBKASSA_API_KEY="synthetic-key-123"',
  "WEBKASSA_LOGIN='cashier@example.test'",
  'WEBKASSA_PASSWORD=pa ss=word',
  'WEBKASSA_CASHBOX=SWK00000001',
].join('\n');

test('maps the private env into the account file shape', () => {
  const { account, used } = accountFromEnv(parseEnv(env));
  assert.deepEqual(account, {
    baseUrl: 'https://devkkm.webkassa.kz',
    apiKey: 'synthetic-key-123',
    login: 'cashier@example.test',
    password: 'pa ss=word',
    cashboxUniqueNumber: 'SWK00000001',
  });
  assert.equal(used.baseUrl, 'default');
  assert.equal(used.password, 'WEBKASSA_PASSWORD');
});

test('refuses foreign hosts and bad cashboxes without echoing values', () => {
  assert.throws(() => accountFromEnv(parseEnv(env), 'https://evil.example'), /baseUrl/);
  assert.throws(
    () => accountFromEnv(parseEnv(env.replace('SWK00000001', 'synthetic-secret'))),
    (error) =>
      /cashboxUniqueNumber/.test(error.message) && !error.message.includes('synthetic-secret'),
  );
});
