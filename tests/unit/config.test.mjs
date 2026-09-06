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
