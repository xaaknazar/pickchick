import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSession } from './session-check.mjs';

const env = {
  KASPI_SESSION_TOKEN_SN: 'synthetic-token',
  KASPI_SESSION_VTOKEN_SECRET: 'synthetic-secret',
  KASPI_SESSION_PROFILE_ID: '1',
};
test('standalone check only reads session and suppresses raw bank/transport data', async () => {
  let calls = 0;
  const request = async (url, options) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:3931/api/session/check');
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, undefined);
    assert.equal(options.body, undefined);
    assert.equal(options.headers['X-Token-SN'], env.KASPI_SESSION_TOKEN_SN);
    return { ok: true, json: async () => ({ active: true, secret: 'must-not-leak' }) };
  };
  assert.deepEqual(await checkSession(env, request), { active: true, reason: 'verified' });
  assert.deepEqual(await checkSession({}, request), { active: false, reason: 'missing_session' });
  assert.equal(calls, 1);
  for (const body of [null, {}, { active: 'true' }, { active: false }])
    assert.equal(
      (await checkSession(env, async () => ({ ok: true, json: async () => body }))).active,
      false,
    );
  assert.deepEqual(
    await checkSession(env, async () => {
      throw new Error('secret');
    }),
    { active: false, reason: 'unavailable' },
  );
  assert.equal(
    (await checkSession(env, async () => ({ ok: false, json: async () => ({ active: true }) })))
      .active,
    false,
  );
});
