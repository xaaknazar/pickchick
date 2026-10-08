import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { edgeInstallConfig } from '../../scripts/edge-migrate.mjs';
import { edgeRuntimeGrantSql } from '../../infra/windows/edge-runtime-grants.mjs';

test('edge install accepts no cloud or Redis settings, rejects cross-database and URL overrides', () => {
  const env = {
    APP_ENV: 'local',
    EDGE_BRANCH_ID: randomUUID(),
    EDGE_DATABASE_URL: 'postgresql://install:synthetic@127.0.0.1:55433/pickchick_edge',
  };
  assert.equal(edgeInstallConfig(env).service, 'edge');
  assert.equal(edgeInstallConfig(env).redisUrl, undefined);
  for (const databaseUrl of [
    env.EDGE_DATABASE_URL.replace('pickchick_edge', 'pickchick_cloud'),
    env.EDGE_DATABASE_URL.replace('127.0.0.1', '192.0.2.1'),
    env.EDGE_DATABASE_URL + '?options=-csearch_path=other',
    env.EDGE_DATABASE_URL + '#override',
    'postgresql://127.0.0.1/pickchick_edge',
  ])
    assert.throws(() => edgeInstallConfig({ ...env, EDGE_DATABASE_URL: databaseUrl }));
  for (const APP_ENV of ['production', 'staging', undefined])
    assert.throws(() => edgeInstallConfig({ ...env, APP_ENV }));
});

test('runtime grant generator rejects injected identifiers and unknown flag types', () => {
  for (const value of ['role; DROP DATABASE x', 'public.role', '"role"', '', 'a'.repeat(64)]) {
    assert.throws(() => edgeRuntimeGrantSql(value));
    assert.throws(() => edgeRuntimeGrantSql('edge_runtime', { schema: value }));
  }
  assert.throws(() => edgeRuntimeGrantSql('edge_runtime', { fulfillment: 'true' }));
  const sql = edgeRuntimeGrantSql('edge_runtime');
  assert.ok(!sql.includes('fulfillment_'));
  assert.ok(!/GRANT ALL|GRANT DELETE|UPDATE\(role|UPDATE\(token_hash/.test(sql));
});

test('remote stop grants are opt-in: runtime applies, worker only fills the inbox', async () => {
  const { fulfillmentWorkerGrants } =
    await import('../../infra/windows/fulfillment-worker-grants.mjs');
  assert.throws(() => edgeRuntimeGrantSql('edge_runtime', { remoteStops: 'true' }));
  assert.throws(() => fulfillmentWorkerGrants('worker', 'public', { remoteStops: 1 }));
  for (const sql of [edgeRuntimeGrantSql('edge_runtime'), fulfillmentWorkerGrants('worker')])
    assert.doesNotMatch(sql, /remote_stop_commands|local_stop_events|source/);
  const runtime = edgeRuntimeGrantSql('edge_runtime', { remoteStops: true });
  assert.match(runtime, /GRANT UPDATE\(source\) ON "public"\."local_stops"/);
  assert.match(runtime, /GRANT SELECT ON "public"\."remote_stop_commands"/);
  assert.match(
    runtime,
    /GRANT UPDATE\(state, result_version, applied_at\) ON "public"\."remote_stop_commands"/,
  );
  assert.match(runtime, /GRANT INSERT ON "public"\."local_stop_events"/);
  assert.doesNotMatch(runtime, /reported_at|INSERT ON "public"\."remote_stop_commands"/);
  const worker = fulfillmentWorkerGrants('worker', 'public', { remoteStops: true });
  assert.match(worker, /GRANT SELECT\(version,source,updated_at\) ON "public"\."local_stops"/);
  assert.match(worker, /GRANT UPDATE\(reported_at\) ON "public"\."remote_stop_commands"/);
  assert.match(
    worker,
    /GRANT INSERT\(command_id,branch_id,variant_id,stopped,duration,reason,expected_version,actor_label,issued_at\) ON "public"\."remote_stop_commands"/,
  );
  // The worker never writes stops, verdicts or history.
  assert.doesNotMatch(
    worker,
    /local_stop_events|UPDATE\([^)]*\) ON "public"\."local_stops"|INSERT ON "public"\."local_stops"|UPDATE\(state[^)]*\) ON "public"\."remote_stop_commands"/,
  );
});
