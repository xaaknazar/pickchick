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

test('customer SMS auth needs exact cloud opt-in and trusts only explicitly configured proxy addresses', () => {
  assert.equal(loadConfig('api', env).customerAuthEnabled, undefined);
  assert.equal(
    loadConfig('api', { ...env, CUSTOMER_AUTH_ENABLED: 'true' }).customerAuthEnabled,
    true,
  );
  assert.throws(() => loadConfig('edge', { ...env, CUSTOMER_AUTH_ENABLED: 'true' }));
  for (const value of ['', '1', 'TRUE', ' true '])
    assert.throws(() => loadConfig('api', { ...env, CUSTOMER_AUTH_ENABLED: value }));
  assert.deepEqual(
    loadConfig('api', { ...env, TRUSTED_PROXY_IPS: '127.0.0.1,::1' }).trustedProxyIps,
    ['127.0.0.1', '::1'],
  );
  for (const value of [
    'true',
    '*',
    '0.0.0.0',
    '::',
    '10.0.0.0/8',
    'gateway.example',
    Array(9).fill('127.0.0.1').join(','),
  ])
    assert.throws(() => loadConfig('api', { ...env, TRUSTED_PROXY_IPS: value }));
});

test('edge remote stop applier defaults off and is an exact edge-only opt-in', () => {
  assert.equal(loadConfig('edge', env).remoteStopsEnabled, undefined);
  assert.equal(
    loadConfig('edge', { ...env, EDGE_REMOTE_STOPS_ENABLED: 'false' }).remoteStopsEnabled,
    undefined,
  );
  assert.equal(
    loadConfig('edge', { ...env, EDGE_REMOTE_STOPS_ENABLED: 'true' }).remoteStopsEnabled,
    true,
  );
  for (const value of ['1', 'TRUE', 'yes', ''])
    assert.throws(() => loadConfig('edge', { ...env, EDGE_REMOTE_STOPS_ENABLED: value }));
  assert.throws(() => loadConfig('api', { ...env, EDGE_REMOTE_STOPS_ENABLED: 'true' }));
});

// Owner 28.11.2026: without an explicit test/live mode the automatic Webkassa receipts stay off.
test('edge Webkassa mode: EDGE_WEBKASSA_ENVIRONMENT live|test, REQUIRE_LIVE=true is a synonym', () => {
  const mode = (extra) => loadConfig('edge', { ...env, ...extra }).webkassaEnvironment;
  const matrix = [
    // [EDGE_WEBKASSA_ENVIRONMENT, EDGE_WEBKASSA_REQUIRE_LIVE, expected mode]
    [undefined, undefined, undefined],
    [undefined, 'false', undefined],
    [undefined, 'true', 'live'],
    ['live', undefined, 'live'],
    ['live', 'true', 'live'],
    ['live', 'false', 'live'],
    ['test', undefined, 'test'],
    ['test', 'false', 'test'],
    ['', undefined, undefined],
  ];
  for (const [environment, requireLive, expected] of matrix) {
    const extra = {};
    if (environment !== undefined) extra.EDGE_WEBKASSA_ENVIRONMENT = environment;
    if (requireLive !== undefined) extra.EDGE_WEBKASSA_REQUIRE_LIVE = requireLive;
    assert.equal(mode(extra), expected, JSON.stringify(extra));
  }
  // A typo or a contradiction never stops the point server: receipts stay off and the edge says why.
  for (const [extra, invalid] of [
    [
      { EDGE_WEBKASSA_ENVIRONMENT: 'test', EDGE_WEBKASSA_REQUIRE_LIVE: 'true' },
      'environment_conflict',
    ],
    [{ EDGE_WEBKASSA_ENVIRONMENT: 'prod' }, 'environment_invalid'],
    [{ EDGE_WEBKASSA_ENVIRONMENT: 'Live' }, 'environment_invalid'],
    [{ EDGE_WEBKASSA_ENVIRONMENT: 'true' }, 'environment_invalid'],
    [{ EDGE_WEBKASSA_REQUIRE_LIVE: 'yes' }, 'environment_invalid'],
    [{ EDGE_WEBKASSA_REQUIRE_LIVE: '1' }, 'environment_invalid'],
    [
      { EDGE_WEBKASSA_ENVIRONMENT: 'live', EDGE_WEBKASSA_REQUIRE_LIVE: 'maybe' },
      'environment_invalid',
    ],
  ]) {
    const config = loadConfig('edge', { ...env, ...extra });
    assert.equal(config.webkassaModeInvalid, invalid, JSON.stringify(extra));
    assert.equal(config.webkassaEnvironment, undefined, JSON.stringify(extra));
  }
  // Whitespace around a valid value is trimmed, for the old flag as well.
  assert.equal(mode({ EDGE_WEBKASSA_ENVIRONMENT: ' test ' }), 'test');
  assert.equal(mode({ EDGE_WEBKASSA_REQUIRE_LIVE: ' true ' }), 'live');
  assert.equal(loadConfig('edge', env).webkassaModeInvalid, undefined);
  // Edge only.
  assert.throws(() => loadConfig('api', { ...env, EDGE_WEBKASSA_ENVIRONMENT: 'live' }));
  assert.throws(() => loadConfig('api', { ...env, EDGE_WEBKASSA_REQUIRE_LIVE: 'true' }));
  assert.equal(
    loadConfig('api', { ...env, EDGE_WEBKASSA_REQUIRE_LIVE: 'false' }).webkassaEnvironment,
    undefined,
  );
});
