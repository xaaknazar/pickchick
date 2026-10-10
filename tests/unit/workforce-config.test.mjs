import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '@pickchick/platform';
test('workforce requires explicit cloud flag and scoped backoffice', () => {
  const env = {
    APP_ENV: 'test',
    CLOUD_DATABASE_URL: 'postgresql://test@127.0.0.1:55445/pickchick_cloud',
    EDGE_DATABASE_URL: 'postgresql://test@127.0.0.1:55445/pickchick_edge',
    REDIS_URL: 'redis://127.0.0.1:56379',
    EDGE_BRANCH_ID: '00000000-0000-4000-8000-000000000001',
  };
  assert.equal(loadConfig('api', env).workforceEnabled, undefined);
  assert.throws(() => loadConfig('api', { ...env, WORKFORCE_ENABLED: 'true' }));
  assert.throws(() => loadConfig('api', { ...env, WORKFORCE_ENABLED: 'yes' }));
  assert.equal(
    loadConfig('api', {
      ...env,
      CATALOG_ADMIN_ENABLED: 'true',
      BACKOFFICE_ENABLED: 'true',
      WORKFORCE_ENABLED: 'true',
    }).workforceEnabled,
    true,
  );
  assert.throws(() =>
    loadConfig('edge', {
      ...env,
      CATALOG_ADMIN_ENABLED: 'true',
      BACKOFFICE_ENABLED: 'true',
      WORKFORCE_ENABLED: 'true',
    }),
  );
});
