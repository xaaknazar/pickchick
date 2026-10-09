import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { hashJson } from '@pickchick/menu-sync';
import { inspectRemoteStops } from '../../infra/windows/remote-stops-readiness.mjs';
import { edgeRuntimeGrantSql } from '../../infra/windows/edge-runtime-grants.mjs';
import { fulfillmentWorkerGrants } from '../../infra/windows/fulfillment-worker-grants.mjs';
async function fixture(run, { badHash = false, omitResult = false } = {}) {
  const url = new URL(loadConfig('edge').databaseUrl),
    admin = createPool(url.toString(), 2),
    suffix = randomUUID().replaceAll('-', ''),
    schema = 'stops_ready_' + suffix;
  const runtimeRole = 'stops_runtime_' + suffix,
    workerRole = 'stops_worker_' + suffix,
    branchId = randomUUID(),
    deviceId = randomUUID(),
    releaseId = randomUUID();
  let pool, client;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set('options', '-c search_path=' + schema);
    pool = createPool(url.toString(), 2);
    await migrate(
      pool,
      fileURLToPath(new URL('../../db/edge/migrations/', import.meta.url)),
      'edge',
    );
    await pool.query(
      "INSERT INTO branch_config(id,code,name,timezone) VALUES($1,'SYN','Synthetic','Asia/Almaty')",
      [branchId],
    );
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('INSERT INTO fulfillment_config VALUES($1,$2,$3,$4,1)', [
      branchId,
      randomUUID(),
      deviceId,
      randomUUID(),
    ]);
    await client.query('INSERT INTO fulfillment_routing VALUES($1,1,$2,$3)', [
      branchId,
      {},
      'a'.repeat(64),
    ]);
    await client.query('COMMIT');
    for (const role of [runtimeRole, workerRole])
      await admin.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT`);
    await pool.query(
      edgeRuntimeGrantSql(runtimeRole, {
        schema,
        fulfillment: true,
        remoteStops: true,
        menuMedia: true,
        cashierReports: true,
      }),
    );
    await pool.query(fulfillmentWorkerGrants(workerRole, schema, { remoteStops: true }));
    const menu = { ...fixtureMenu, branch_id: branchId, release_id: releaseId, version: 6 },
      checksum = badHash ? 'b'.repeat(64) : hashJson(menu),
      eventId = randomUUID();
    await pool.query(
      'INSERT INTO menu_snapshots(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,6,1,$3,$4,now())',
      [releaseId, branchId, menu, checksum],
    );
    await pool.query('INSERT INTO active_menu VALUES($1,$2)', [branchId, releaseId]);
    if (!omitResult)
      await pool.query(
        "INSERT INTO menu_apply_results(release_id,branch_id,event_id,version,result) VALUES($1,$2,$3,6,'applied')",
        [releaseId, branchId, eventId],
      );
    await pool.query(
      `INSERT INTO outbox_events(event_id,producer_id,producer_sequence,branch_id,aggregate_type,aggregate_id,aggregate_version,schema_version,event_type,payload,occurred_at,correlation_id,causation_id,acknowledged_at)
   VALUES($1,$2,1,$3,'menu_release',$4,6,1,'menu.applied',$5,now(),$6,$7,now())`,
      [
        randomUUID(),
        randomUUID(),
        branchId,
        releaseId,
        { release_id: releaseId, checksum },
        randomUUID(),
        eventId,
      ],
    );
    const scope = {
      branchId,
      deviceId,
      schema,
      runtimeRole,
      workerRole,
      expectedLedger: (
        await pool.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version')
      ).rows,
    };
    await run({ pool, client, scope, releaseId, checksum });
  } finally {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    for (const role of [runtimeRole, workerRole]) await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  }
}
test('020 continuation uses actual applied menu/ACK and exact grants without SQL side effects', async () => {
  await fixture(async ({ pool, client, scope, releaseId, checksum }) => {
    const before = await pool.query('SELECT row_to_json(t) row FROM outbox_events t');
    const result = await inspectRemoteStops(client, scope);
    assert.deepEqual(result, {
      branch_id: scope.branchId,
      edge_device_id: scope.deviceId,
      schema: 20,
      grants_verified: true,
      menu_release_id: releaseId,
      menu_version: 6,
      menu_hash: checksum,
      pending_menu_acks: 0,
      pending_stop_commands: 0,
      read_only: true,
    });
    assert.deepEqual(
      (await pool.query('SELECT row_to_json(t) row FROM outbox_events t')).rows,
      before.rows,
    );
    assert.equal(
      (await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,
      'off',
    );
    await assert.rejects(
      inspectRemoteStops(client, { ...scope, deviceId: randomUUID() }),
      /binding/,
    );
    await assert.rejects(
      inspectRemoteStops(client, { ...scope, expectedLedger: scope.expectedLedger.slice(0, 19) }),
      /schema020/,
    );
    await pool.query('UPDATE outbox_events SET acknowledged_at=NULL');
    await assert.rejects(inspectRemoteStops(client, scope), /acknowledged menu/);
    await pool.query('UPDATE outbox_events SET acknowledged_at=now()');
    await pool.query(`REVOKE UPDATE(reported_at) ON remote_stop_commands FROM ${scope.workerRole}`);
    await assert.rejects(inspectRemoteStops(client, scope), /privileges differ/);
  });
});
test('pending remote stop blocks enabling so activation cannot put a product on stop', async () => {
  await fixture(async ({ pool, client, scope }) => {
    await pool.query(
      `INSERT INTO remote_stop_commands(command_id,branch_id,variant_id,stopped,duration,reason,expected_version,actor_label,issued_at) VALUES($1,$2,$3,true,'manual','Synthetic',0,'Synthetic',now())`,
      [randomUUID(), scope.branchId, randomUUID()],
    );
    await assert.rejects(inspectRemoteStops(client, scope), /Pending menu ACK or stop command/);
    assert.equal(
      (await pool.query('SELECT state FROM remote_stop_commands')).rows[0].state,
      'received',
    );
    assert.equal((await pool.query('SELECT count(*)::int n FROM local_stops')).rows[0].n, 0);
  });
});
test('stored checksum and genuine apply outcome are mandatory', async () => {
  for (const options of [{ badHash: true }, { omitResult: true }])
    await fixture(async ({ client, scope }) => {
      await assert.rejects(
        inspectRemoteStops(client, scope),
        /verified applied and acknowledged menu/,
      );
    }, options);
});
