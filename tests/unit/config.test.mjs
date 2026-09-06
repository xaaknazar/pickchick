import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '@pickchick/platform';
import { fixtureIds } from '@pickchick/test-fixtures';

const env = {
  APP_ENV: 'test',
  CLOUD_DATABASE_URL: 'postgresql://localhost/pickchick_cloud',
  EDGE_DATABASE_URL: 'postgresql://localhost/pickchick_edge',
  EDGE_BRANCH_ID: fixtureIds.branch,
  REDIS_URL: 'redis://localhost:6379',
};

test('edge boots without cloud or Redis configuration', () => {
  const local = { ...env };
  delete local.CLOUD_DATABASE_URL;
  delete local.REDIS_URL;
  assert.equal(loadConfig('edge', local).branchId, fixtureIds.branch);
  assert.equal(loadConfig('edge', local).redisUrl, undefined);
});

test('foundation refuses production, remote databases and swapped scopes', () => {
  for (const changes of [
    { APP_ENV: 'production' },
    { CLOUD_DATABASE_URL: 'postgresql://user:do-not-print@remote.example/pickchick_cloud' },
    { CLOUD_DATABASE_URL: env.EDGE_DATABASE_URL },
    { API_PORT: '0' },
    { API_PORT: '65536' },
    { REDIS_URL: 'redis://remote.example' },
  ]) {
    assert.throws(
      () => loadConfig('api', { ...env, ...changes }),
      (error) => {
        assert.equal(error.message.includes('do-not-print'), false);
        return true;
      },
    );
  }
  assert.throws(() => loadConfig('edge', { ...env, EDGE_BRANCH_ID: 'not-a-uuid' }));
});

test('private staging only permits cloud API with dedicated service hosts and secrets', () => {
  const secret = 'a'.repeat(64);
  const staging = {
    APP_ENV: 'staging',
    CLOUD_DATABASE_URL: `postgresql://pickchick_app:${secret}@cloud-db:5432/pickchick_cloud`,
    REDIS_URL: `redis://default:${secret}@redis-cache:6379/0`,
  };
  assert.equal(loadConfig('api', staging).environment, 'staging');
  assert.equal(loadConfig('api', staging).testOrderFlowEnabled, false);
  assert.equal(
    loadConfig('api', { ...staging, TEST_ORDER_FLOW_ENABLED: 'true' }).testOrderFlowEnabled,
    true,
  );
  assert.throws(() => loadConfig('edge', { ...env, ...staging }));
  for (const changes of [
    { CLOUD_DATABASE_URL: env.CLOUD_DATABASE_URL },
    { CLOUD_DATABASE_URL: staging.CLOUD_DATABASE_URL.replace('cloud-db', 'public.example') },
    { CLOUD_DATABASE_URL: staging.CLOUD_DATABASE_URL + '?host=public.example' },
    { CLOUD_DATABASE_URL: staging.CLOUD_DATABASE_URL.replace(secret, 'weak') },
    { REDIS_URL: env.REDIS_URL },
    { REDIS_URL: staging.REDIS_URL.replace('redis-cache', 'public.example') },
    { REDIS_URL: staging.REDIS_URL + '#fragment' },
  ])
    assert.throws(
      () => loadConfig('api', { ...staging, ...changes }),
      (error) => {
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
});

test('TEST flow gate defaults closed and needs exact opt-in on a non-production cloud API', () => {
  for (const APP_ENV of ['local', 'test']) {
    assert.equal(loadConfig('api', { ...env, APP_ENV }).testOrderFlowEnabled, false);
    assert.equal(
      loadConfig('api', { ...env, APP_ENV, TEST_ORDER_FLOW_ENABLED: 'false' }).testOrderFlowEnabled,
      false,
    );
    assert.equal(
      loadConfig('api', { ...env, APP_ENV, TEST_ORDER_FLOW_ENABLED: 'true' }).testOrderFlowEnabled,
      true,
    );
    assert.throws(() => loadConfig('edge', { ...env, APP_ENV, TEST_ORDER_FLOW_ENABLED: 'true' }));
  }
  for (const value of ['', '1', 'TRUE', 'False', ' true ', 'yes']) {
    assert.throws(() => loadConfig('api', { ...env, TEST_ORDER_FLOW_ENABLED: value }));
  }
  assert.throws(() =>
    loadConfig('api', { ...env, APP_ENV: 'production', TEST_ORDER_FLOW_ENABLED: 'true' }),
  );
});

test('database and HTTP limits are bounded and default to conservative per-process budgets', () => {
  assert.equal(loadConfig('api', env).databasePoolMax, 5);
  assert.equal(loadConfig('api', env).httpMaxInFlight, 32);
  assert.equal(loadConfig('api', { ...env, DB_POOL_MAX: '12' }).databasePoolMax, 12);
  for (const [key, invalid] of [
    ['DB_POOL_MAX', ['0', '65', '-1', '1.5', 'Infinity', ' 5', 'secret-do-not-print']],
    ['HTTP_MAX_IN_FLIGHT', ['0', '1025', '1e3', '', 'secret-do-not-print']],
  ]) {
    for (const value of invalid)
      assert.throws(
        () => loadConfig('api', { ...env, [key]: value }),
        (e) => {
          assert(!e.message.includes('secret-do-not-print'));
          return true;
        },
      );
  }
});
