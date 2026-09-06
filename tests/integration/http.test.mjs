import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '@pickchick/api';
import { createEdge } from '@pickchick/edge';
import { loadConfig } from '@pickchick/platform';
import { ErrorSchema, MenuSnapshotSchema, ReadinessSchema } from '@pickchick/contracts';
import { fixtureIds as id } from '@pickchick/test-fixtures';

async function running(factory, config) {
  const app = await factory(config);
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}
const request = (url, options) => fetch(url, { signal: AbortSignal.timeout(5000), ...options });

test('real API serves the active menu and rejects malformed/unknown branch IDs', async () => {
  const { app, url } = await running(createApi, loadConfig('api'));
  try {
    const branches = await request(`${url}/v1/branches`);
    const body = await branches.json();
    assert.equal(body.branches.find((b) => b.id === id.branch).ordering_enabled, false);
    const menu = await request(`${url}/v1/branches/${id.branch}/menu`);
    assert.equal(MenuSnapshotSchema.parse(await menu.json()).branch_id, id.branch);
    for (const [branch, status] of [
      ['invalid', 400],
      ['20000000-0000-4000-8000-000000000001', 404],
    ]) {
      const response = await request(`${url}/v1/branches/${branch}/menu`, {
        headers: { 'X-Request-Id': 'untrusted-value' },
      });
      assert.equal(response.status, status);
      const error = ErrorSchema.parse(await response.json());
      assert.equal(response.headers.get('x-request-id'), error.trace_id);
      assert.equal(JSON.stringify(error).includes('postgres'), false);
    }
    const post = await request(`${url}/v1/orders`, { method: 'POST' });
    assert.equal(post.status, 404, 'checkout must not exist as a fake success endpoint');
    const ready = await request(`${url}/health/ready`);
    assert.equal(ready.status, 200);
    assert.equal(ReadinessSchema.parse(await ready.json()).dependencies.redis, 'up');
  } finally {
    await app.close();
  }
});

test('edge keeps serving persisted menu after cloud stops and edge restarts', async () => {
  const cloud = await running(createApi, loadConfig('api'));
  let cloudRunning = true;
  let local;
  try {
    local = await running(createEdge, loadConfig('edge'));
    const before = await (await request(`${local.url}/edge/v1/menu`)).json();
    await cloud.app.close();
    cloudRunning = false;
    assert.deepEqual(await (await request(`${local.url}/edge/v1/menu`)).json(), before);
    await local.app.close();
    local = await running(createEdge, loadConfig('edge'));
    assert.deepEqual(await (await request(`${local.url}/edge/v1/menu`)).json(), before);
    const ready = ReadinessSchema.parse(await (await request(`${local.url}/health/ready`)).json());
    assert.equal(ready.ready, true);
    assert.equal(ready.dependencies.redis, 'not_required');
  } finally {
    if (cloudRunning) await cloud.app.close();
    if (local) await local.app.close();
  }
});

test('Redis failure degrades readiness without disabling PostgreSQL menu reads', async () => {
  const { app, url } = await running(createApi, {
    ...loadConfig('api'),
    redisUrl: 'redis://127.0.0.1:1',
  });
  try {
    const response = await request(`${url}/health/ready`);
    assert.equal(response.status, 200);
    const ready = ReadinessSchema.parse(await response.json());
    assert.equal(ready.ready, true);
    assert.equal(ready.degraded, true);
    assert.equal(ready.dependencies.redis, 'down');
    assert.equal((await request(`${url}/v1/branches/${id.branch}/menu`)).status, 200);
  } finally {
    await app.close();
  }
});

test('database outage is not disguised as healthy readiness or a process crash', async () => {
  const config = loadConfig('api');
  const missing = new URL(config.databaseUrl);
  missing.port = '1';
  const { app, url } = await running(createApi, { ...config, databaseUrl: missing.toString() });
  try {
    assert.equal((await request(`${url}/health/live`)).status, 200);
    const response = await request(`${url}/health/ready`);
    assert.equal(response.status, 503);
    const ready = ReadinessSchema.parse(await response.json());
    assert.equal(ready.ready, false);
    assert.equal(ready.dependencies.database, 'down');
  } finally {
    await app.close();
  }
});

test('edge assigned to a different branch cannot expose this branch menu', async () => {
  const config = { ...loadConfig('edge'), branchId: '20000000-0000-4000-8000-000000000001' };
  const { app, url } = await running(createEdge, config);
  try {
    assert.equal((await request(`${url}/health/ready`)).status, 503);
    assert.equal((await request(`${url}/edge/v1/menu`)).status, 404);
  } finally {
    await app.close();
  }
});
