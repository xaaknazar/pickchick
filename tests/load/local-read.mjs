/** Read-only baseline on a disposable API process and local synthetic PostgreSQL. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cpus, platform, arch } from 'node:os';
import { createApi } from '@pickchick/api';
import { loadConfig, RESOURCE } from '@pickchick/platform';
import { fixtureIds } from '@pickchick/test-fixtures';

const config = loadConfig('api');
assert(['local', 'test'].includes(config.environment), 'Never stress the shared VPS');
const concurrency = 16;
const count = 2000;
const app = await createApi(config);
try {
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  assert.equal((await fetch(origin + '/health/ready')).status, 200);
  // Warm connection setup and query plans before collecting the measured sample.
  for (let i = 0; i < 20; i++) await (await fetch(origin + '/v1/branches')).arrayBuffer();
  const latencies = [];
  let next = 0;
  let errors = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < count) {
        const index = next++;
        const start = performance.now();
        try {
          const response = await fetch(
            origin + (index % 2 ? '/v1/branches' : `/v1/branches/${fixtureIds.branch}/menu`),
            { signal: AbortSignal.timeout(5000) },
          );
          const body = await response.json();
          assert.equal(response.status, 200);
          if (index % 2) assert(body.branches.some((b) => b.id === fixtureIds.branch));
          else assert.equal(body.branch_id, fixtureIds.branch);
        } catch {
          errors += 1;
        }
        latencies.push(performance.now() - start);
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const percentile = (p) => Math.round(latencies[Math.ceil(p * latencies.length) - 1] * 100) / 100;
  const resource = app.get(RESOURCE);
  const report = {
    scenario: 'local synthetic menu/branches GET only; no orders created',
    timestamp: new Date().toISOString(),
    node: process.version,
    machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
    requests: count,
    concurrency,
    errors,
    seconds: Math.round(seconds * 100) / 100,
    requests_per_second: Math.round(count / seconds),
    p95_ms: percentile(0.95),
    p99_ms: percentile(0.99),
    db_pool_max: config.databasePoolMax,
    db_pool_total: resource.pool.totalCount,
    db_pool_waiting_after: resource.pool.waitingCount,
    http_in_flight_after: resource.admission.active,
    production_capacity_proven: false,
  };
  console.log(JSON.stringify(report, null, 2));
  assert.equal(errors, 0);
  assert(report.p95_ms <= 400);
  assert.equal(report.db_pool_waiting_after, 0);
  assert.equal(report.http_in_flight_after, 0);
} finally {
  await app.close();
}
