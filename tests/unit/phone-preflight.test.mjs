import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(
  new URL('../../scripts/phone-verification-preflight.mjs', import.meta.url),
);
const syntheticKey = 'synthetic-provider-key-never-used-for-network';
function run(provider, sender = '', args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: 3000,
    env: {
      ...process.env,
      PHONE_DELIVERY_PROVIDER: provider,
      MOBIZON_API_KEY: syntheticKey,
      MOBIZON_APPROVED_SENDER: sender,
    },
  });
}

test('provider preflight stays offline and does not claim account verification', () => {
  for (const provider of ['disabled', 'mobizon']) {
    const result = run(provider, 'PickChick');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      event: 'phone_delivery_configuration',
      scope: 'transport_only',
      provider,
      configured: provider !== 'disabled',
      provider_account_verified: false,
      sms_sent: 0,
    });
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.includes(syntheticKey), false);
  }
});

test('invalid preflight configuration and arguments fail without printing secrets', () => {
  for (const result of [
    run('mobizon'),
    run('unsupported-provider'),
    run('mobizon', 'PickChick', [syntheticKey]),
  ]) {
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /No SMS was sent/);
    assert.equal(result.stderr.includes(syntheticKey), false);
  }
});
