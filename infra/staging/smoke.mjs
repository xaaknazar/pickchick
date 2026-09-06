import assert from 'node:assert/strict';
import { createPool } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { provisionDevice } from '@pickchick/menu-sync';
import { fixtureIds } from '@pickchick/test-fixtures';

async function smoke() {
  const config = loadConfig('api');
  assert.equal(config.environment, 'staging');
  const owner = createPool(config.databaseUrl);
  const url = new URL(config.databaseUrl);
  url.username = 'pickchick_app';
  url.password = process.env.DB_APP_PASSWORD;
  const runtime = createPool(url.href);
  const request = (path, options) =>
    fetch(`http://api:3100${path}`, {
      ...options,
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
  try {
    const ready = await request('/health/ready');
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).degraded, false);
    const branches = await (await request('/v1/branches')).json();
    assert.equal(branches.branches.find((b) => b.id === fixtureIds.branch).ordering_enabled, false);
    assert.equal((await request('/internal/v1/edge/sync/pull')).status, 401);
    await assert.rejects(runtime.query('CREATE TABLE runtime_forbidden (id integer)'), {
      code: '42501',
    });
    await assert.rejects(runtime.query('UPDATE devices SET status = status'), { code: '42501' });
    await assert.rejects(runtime.query('DELETE FROM schema_migrations'), { code: '42501' });
    const device = await owner.query('SELECT status FROM devices WHERE id=$1', [fixtureIds.device]);
    const identity = await provisionDevice(
      owner,
      fixtureIds.device,
      device.rows[0].status === 'active',
    );
    const pull = await request('/internal/v1/edge/sync/pull', {
      headers: {
        Authorization: `Bearer ${identity.token}`,
        'X-Device-Id': identity.device_id,
      },
    });
    assert.equal(pull.status, 200); // Includes row locks with the restricted runtime DB role.
    console.log(
      JSON.stringify({
        event: 'staging_smoke_passed',
        checks: [
          'readiness',
          'synthetic_branch_closed',
          'unauthorized_401',
          'runtime_ddl_denied',
          'device_mutation_denied',
          'migration_mutation_denied',
          'authorized_pull',
        ],
      }),
    );
  } finally {
    await runtime.end();
    await owner.end();
  }
}
try {
  await smoke();
} catch {
  console.error(JSON.stringify({ event: 'staging_smoke_failed' }));
  process.exitCode = 1;
}
