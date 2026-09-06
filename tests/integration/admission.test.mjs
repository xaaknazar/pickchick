import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '@pickchick/api';
import { createPool } from '@pickchick/database';
import { loadConfig, RESOURCE, Resources } from '@pickchick/platform';
import { setTimeout as delay } from 'node:timers/promises';

async function until(predicate) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('The handler did not reach the expected state within one second');
}

test('bounded HTTP admission survives saturation and client abort without releasing database work early', async () => {
  const config = { ...loadConfig('api'), databasePoolMax: 1, httpMaxInFlight: 1 };
  const blocker = createPool(config.databaseUrl, 1);
  const lock = await blocker.connect();
  const app = await createApi(config);
  let held;
  try {
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    const resource = app.get(RESOURCE);
    await lock.query('BEGIN');
    await lock.query('LOCK TABLE branches IN ACCESS EXCLUSIVE MODE');
    const abort = new AbortController();
    held = fetch(url + '/v1/branches', { signal: abort.signal }).catch(() => null);
    await until(() => resource.admission.active === 1 && resource.pool.totalCount === 1);
    const overload = await Promise.all(
      Array.from({ length: 20 }, () => fetch(url + '/v1/branches')),
    );
    assert(overload.every((response) => response.status === 503));
    assert(overload.every((response) => response.headers.get('retry-after') === '1'));
    assert.equal(resource.admission.rejected, 20);
    assert.equal(resource.pool.waitingCount, 0, 'Rejected work must not enter the database queue');
    assert.equal((await fetch(url + '/health/live')).status, 200);
    const metrics = await (await fetch(url + '/health/metrics')).text();
    assert.match(metrics, /pickchick_http_in_flight 1\n/);
    assert.match(metrics, /pickchick_db_pool_total 1\n/);
    assert.equal(metrics.includes(config.databaseUrl), false);
    abort.abort();
    await held;
    await delay(30);
    assert.equal(
      resource.admission.active,
      1,
      'Client abort does not complete the blocked SQL read',
    );
    assert.equal((await fetch(url + '/v1/branches')).status, 503);
    await lock.query('ROLLBACK');
    await until(() => resource.admission.active === 0);
    assert.equal((await fetch(url + '/v1/branches')).status, 200);
    assert.equal((await fetch(url + '/v1/branches/invalid/menu')).status, 400);
    assert.equal(resource.admission.active, 0, 'Failure paths also release capacity');
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
    await held;
    await app.close();
    await blocker.end();
  }
});

test('concurrent readiness probes share work, while subsequent probes check dependencies again', async () => {
  const resource = new Resources(loadConfig('api'));
  try {
    const first = resource.readiness();
    assert.equal(resource.readiness(), first);
    assert.equal(resource.readiness(), first);
    assert.equal((await first).ready, true);
    const next = resource.readiness();
    assert.notEqual(next, first);
    assert.equal((await next).ready, true);
  } finally {
    await resource.onApplicationShutdown();
  }
});
