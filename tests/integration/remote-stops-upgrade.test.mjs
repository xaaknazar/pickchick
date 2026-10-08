import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { fixtureMenu } from '@pickchick/test-fixtures';
import { hashJson } from '@pickchick/menu-sync';
import { applyRemoteStops, remoteStopsReady, stopAuditReady } from '@pickchick/local-orders';
import { remoteStopTransportReady } from '@pickchick/fulfillment-transport';
import { edgeRuntimeGrantSql } from '../../infra/windows/edge-runtime-grants.mjs';
import { fulfillmentWorkerGrants } from '../../infra/windows/fulfillment-worker-grants.mjs';
import {
  assertRemoteStopPrivileges,
  upgradeRemoteStops,
} from '../../infra/windows/remote-stops-upgrade-db.mjs';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const denied = (error) => error.code === '42501';

/** Edge schema at ledger 018 (after the menu-sync upgrade) with the cashier's two service roles
 * holding their pre-019 grants, plus an unrelated role whose rights must never change. */
async function edgeAt018(run) {
  const config = loadConfig('edge');
  const admin = createPool(config.databaseUrl, 2);
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `remote_stops_${suffix}`,
    runtimeRole = `stop_runtime_${suffix}`,
    workerRole = `stop_worker_${suffix}`,
    otherRole = `stop_other_${suffix}`;
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-remote-stops-upgrade-'));
  const pools = [];
  try {
    for (const name of (await readdir(join(appRoot, 'db/edge/migrations'))).filter(
      (n) => n.endsWith('.sql') && n < '019',
    ))
      await copyFile(join(appRoot, 'db/edge/migrations', name), join(dir, name));
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(config.databaseUrl);
    const connect = (role) => {
      const target = new URL(url);
      target.searchParams.set(
        'options',
        `-c search_path=${schema}` + (role ? ` -c role=${role}` : ''),
      );
      const pool = createPool(target.toString(), 3);
      pools.push(pool);
      return pool;
    };
    const pool = connect();
    await migrate(pool, dir, 'edge');
    const branchId = randomUUID();
    await pool.query(
      "INSERT INTO branch_config(id,code,name,timezone) VALUES ($1,'STOP','Synthetic','Asia/Almaty')",
      [branchId],
    );
    const menu = { ...fixtureMenu, branch_id: branchId, release_id: randomUUID(), version: 2 };
    await pool.query(
      `INSERT INTO menu_snapshots(id,branch_id,version,schema_version,payload,checksum,published_at)
       VALUES ($1,$2,2,1,$3,$4,$5)`,
      [menu.release_id, branchId, menu, hashJson(menu), menu.published_at],
    );
    await pool.query('INSERT INTO active_menu(branch_id,release_id) VALUES ($1,$2)', [
      branchId,
      menu.release_id,
    ]);
    // A POS stop that exists before the upgrade must survive it unchanged (source='pos').
    const stopped = randomUUID();
    await pool.query(
      "INSERT INTO local_stops(branch_id,variant_id,stopped,version,reason) VALUES ($1,$2,true,3,'Synthetic POS stop')",
      [branchId, stopped],
    );
    for (const role of [runtimeRole, workerRole, otherRole])
      await admin.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT`);
    // The cashier's pre-019 grants: full runtime reset at 018 and the base worker set.
    await pool.query(
      edgeRuntimeGrantSql(runtimeRole, {
        schema,
        fulfillment: true,
        cashierReports: true,
        menuMedia: true,
      }),
    );
    await pool.query(fulfillmentWorkerGrants(workerRole, schema));
    await pool.query(`GRANT SELECT ON ${schema}.local_stops TO ${otherRole}`);
    const ledger = async () =>
      (await pool.query('SELECT version,checksum,scope FROM schema_migrations ORDER BY version'))
        .rows;
    const backup = async (overrides = {}) => ({
      format: 'pickchick-native-service-backup-v1',
      runId: randomUUID(),
      branchId,
      sourceDatabase: 'pickchick_edge',
      expectedSchema: 'schema018',
      backupVerified: true,
      restoreVerified: true,
      rehearsalDropped: true,
      completed: true,
      sha256: 'a'.repeat(64),
      archiveBytes: 1024,
      finishedAt: new Date(Date.now() - 60000).toISOString(),
      ledger: await ledger(),
      ...overrides,
    });
    const options = async (mode, extra = {}) => ({
      mode,
      appRoot,
      branchId,
      backup: await backup(),
      schema,
      runtimeRole,
      workerRole,
      ...extra,
    });
    await run({
      admin,
      pool,
      connect,
      schema,
      runtimeRole,
      workerRole,
      otherRole,
      branchId,
      menu,
      stopped,
      backup,
      options,
    });
  } finally {
    for (const pool of pools) await pool.end();
    for (const name of [runtimeRole, workerRole, otherRole]) {
      await admin.query(`DROP OWNED BY ${name}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${name}`);
    }
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
}

const rights = async (client, ctx, sql) => (await client.query(sql, [ctx.workerRole])).rows[0];

test('guarded upgrade applies 019 once and grants exactly the reviewed remote-stop rights', async () => {
  await edgeAt018(async (ctx) => {
    const client = await ctx.pool.connect();
    try {
      const inspect = await upgradeRemoteStops(client, await ctx.options('inspect'));
      assert.deepEqual(
        [inspect.migrations, inspect.migrationPending, inspect.grantsVerified],
        [18, true, false],
      );
      // Gates: stale, foreign, incomplete or mismatched backup proof.
      for (const backup of [
        await ctx.backup({ finishedAt: new Date(Date.now() - 7 * 3600_000).toISOString() }),
        await ctx.backup({ restoreVerified: false }),
        await ctx.backup({ completed: false }),
        await ctx.backup({ branchId: randomUUID() }),
        await ctx.backup({ ledger: (await ctx.backup()).ledger.slice(0, 17) }),
      ])
        await assert.rejects(
          upgradeRemoteStops(client, await ctx.options('apply', { backup })),
          /Fresh matching backup/,
        );
      await assert.rejects(
        upgradeRemoteStops(client, await ctx.options('apply', { branchId: randomUUID() })),
        /Branch differs/,
      );
      // Both roles must exist and stay unprivileged.
      await assert.rejects(
        upgradeRemoteStops(client, await ctx.options('apply', { workerRole: 'missing_role_x' })),
        /Restricted existing/,
      );
      await client.query(`ALTER ROLE ${ctx.workerRole} CREATEDB`);
      await assert.rejects(
        upgradeRemoteStops(client, await ctx.options('apply')),
        /Restricted existing/,
      );
      await client.query(`ALTER ROLE ${ctx.workerRole} NOCREATEDB`);
      await client.query(`GRANT ${ctx.otherRole} TO ${ctx.runtimeRole}`);
      await assert.rejects(
        upgradeRemoteStops(client, await ctx.options('apply')),
        /Restricted existing/,
      );
      await client.query(`REVOKE ${ctx.otherRole} FROM ${ctx.runtimeRole}`);
      // The ledger must be the reviewed 001-018 (a changed 018 or a schema017 cashier fails).
      const real = (await ctx.backup()).ledger;
      await client.query(
        "UPDATE schema_migrations SET checksum=repeat('0',64) WHERE version='018_edge_menu_publication.sql'",
      );
      await assert.rejects(
        upgradeRemoteStops(client, await ctx.options('inspect')),
        /ledger differs/,
      );
      await client.query('DELETE FROM schema_migrations');
      for (const row of real.slice(0, 17))
        await client.query(
          'INSERT INTO schema_migrations(version,checksum,scope) VALUES ($1,$2,$3)',
          [row.version, row.checksum, row.scope],
        );
      await assert.rejects(
        upgradeRemoteStops(client, await ctx.options('inspect')),
        /ledger differs/,
      );
      await client.query(
        'INSERT INTO schema_migrations(version,checksum,scope) SELECT version,checksum,scope FROM json_populate_recordset(NULL::schema_migrations,$1)',
        [JSON.stringify(real.slice(17))],
      );
      assert.equal(
        (await client.query("SELECT to_regclass('remote_stop_commands') IS NULL AS absent")).rows[0]
          .absent,
        true,
      );

      const before = await ctx.backup();
      const applied = await upgradeRemoteStops(client, await ctx.options('apply'));
      assert.deepEqual(
        [
          applied.migrations,
          applied.migrationApplied,
          applied.migrationPending,
          applied.grantsVerified,
        ],
        [19, true, false, true],
      );
      assert.equal(applied.fingerprint, inspect.fingerprint);
      assert.equal(applied.existingDataPreserved, true);
      assert.deepEqual(
        (await client.query('SELECT stopped,version,reason,source FROM local_stops')).rows,
        [{ stopped: true, version: 3, reason: 'Synthetic POS stop', source: 'pos' }],
      );
      // The schema018 backup no longer matches; a fresh schema019 one does.
      await assert.rejects(
        upgradeRemoteStops(client, await ctx.options('inspect', { backup: before })),
        /Fresh matching backup/,
      );
      const again = await upgradeRemoteStops(client, await ctx.options('apply'));
      assert.deepEqual(
        [again.migrations, again.migrationApplied, again.grantsVerified],
        [19, false, true],
      );
      const verified = await upgradeRemoteStops(client, await ctx.options('inspect'));
      assert.deepEqual([verified.migrationPending, verified.grantsVerified], [false, true]);

      // Exact worker authority: no stop writes, no history, no verdicts, no deletes.
      assert.deepEqual(
        await rights(
          client,
          ctx,
          `SELECT has_table_privilege($1,'remote_stop_commands','DELETE') AS command_delete,
            has_column_privilege($1,'remote_stop_commands','state','UPDATE') AS verdict,
            has_column_privilege($1,'remote_stop_commands','reason','SELECT') AS reason_read,
            has_any_column_privilege($1,'local_stop_events','SELECT,INSERT,UPDATE') AS history,
            has_any_column_privilege($1,'local_stops','INSERT,UPDATE') AS stop_write,
            has_column_privilege($1,'local_stops','reason','SELECT') AS stop_reason,
            has_column_privilege($1,'local_stops','source','SELECT') AS stop_source`,
        ),
        {
          command_delete: false,
          verdict: false,
          reason_read: false,
          history: false,
          stop_write: false,
          stop_reason: false,
          stop_source: true,
        },
      );

      // A widened 019 privilege is detected by inspect and reset by a re-apply.
      await client.query(`GRANT DELETE ON remote_stop_commands TO ${ctx.workerRole}`);
      await client.query(`GRANT UPDATE(state) ON remote_stop_commands TO ${ctx.workerRole}`);
      assert.equal(
        (await upgradeRemoteStops(client, await ctx.options('inspect'))).grantsVerified,
        false,
      );
      // Another role's rights on the new tables are never touched.
      await client.query(`GRANT SELECT ON remote_stop_commands TO ${ctx.otherRole}`);
      assert.equal(
        (await upgradeRemoteStops(client, await ctx.options('apply'))).grantsVerified,
        true,
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT has_table_privilege($1,'remote_stop_commands','DELETE') AS worker_delete,
              has_table_privilege($2,'remote_stop_commands','SELECT') AS other_read,
              has_table_privilege($2,'local_stops','SELECT') AS other_stops`,
            [ctx.workerRole, ctx.otherRole],
          )
        ).rows[0],
        { worker_delete: false, other_read: true, other_stops: true },
      );
      // A widened pre-019 worker right on local_stops is not silently revoked: fail closed.
      await client.query(`GRANT UPDATE(stopped) ON local_stops TO ${ctx.workerRole}`);
      await assert.rejects(
        upgradeRemoteStops(client, await ctx.options('apply')),
        /column privileges differ/,
      );
      await assert.rejects(
        assertRemoteStopPrivileges(client, ctx),
        /column privileges differ: worker local_stops/,
      );
      await client.query(`REVOKE UPDATE(stopped) ON local_stops FROM ${ctx.workerRole}`);
      await assertRemoteStopPrivileges(client, ctx);
    } finally {
      client.release();
    }
  });
});

test('the restricted roles run the real remote-stop exchange after the upgrade', async () => {
  await edgeAt018(async (ctx) => {
    const runtime = ctx.connect(ctx.runtimeRole),
      worker = ctx.connect(ctx.workerRole);
    // Before the upgrade both services keep their protocol-2 / POS-only behaviour.
    assert.equal(await remoteStopsReady(runtime), false);
    assert.equal(await remoteStopTransportReady(worker), false);
    const client = await ctx.pool.connect();
    try {
      await upgradeRemoteStops(client, await ctx.options('apply'));
    } finally {
      client.release();
    }
    assert.equal(await remoteStopsReady(runtime), true);
    assert.equal(await remoteStopTransportReady(worker), true);
    const audit = await runtime.connect();
    try {
      assert.equal(await stopAuditReady(audit), true);
    } finally {
      audit.release();
    }
    const variant = ctx.menu.items[0].variant_id;
    const commandId = randomUUID();
    // Worker fills the inbox exactly as fulfillment-transport worker.ts does.
    await worker.query(
      `INSERT INTO remote_stop_commands(command_id,branch_id,variant_id,stopped,duration,reason,expected_version,actor_label,issued_at)
      VALUES($1,$2,$3,true,'manual','Synthetic back-office stop',0,'Synthetic manager',now()) ON CONFLICT DO NOTHING`,
      [commandId, ctx.branchId, variant],
    );
    for (const sql of [
      'DELETE FROM remote_stop_commands',
      "UPDATE remote_stop_commands SET state='applied'",
      'UPDATE local_stops SET stopped=false',
      "INSERT INTO local_stops(branch_id,variant_id,stopped,version,reason) VALUES (gen_random_uuid(),gen_random_uuid(),true,1,'x')",
      'SELECT * FROM local_stop_events',
      'SELECT reason FROM local_stops',
    ])
      await assert.rejects(worker.query(sql), denied, sql);
    // The edge service applies it as the runtime role.
    assert.deepEqual(await applyRemoteStops(runtime, ctx.branchId), [
      { commandId, state: 'applied', version: 1 },
    ]);
    for (const sql of [
      'DELETE FROM remote_stop_commands',
      'UPDATE remote_stop_commands SET reported_at=now()',
      "INSERT INTO remote_stop_commands(command_id,branch_id,variant_id,stopped,duration,reason,expected_version,actor_label,issued_at) VALUES (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),true,'manual','x',0,'x',now())",
      'SELECT * FROM local_stop_events',
      'DELETE FROM local_stops',
    ])
      await assert.rejects(runtime.query(sql), denied, sql);
    // Worker reports the verdict once and reads the stop version and source.
    const reported = await worker.query(
      `UPDATE remote_stop_commands SET reported_at=clock_timestamp()
      WHERE branch_id=$1 AND command_id=ANY($2::uuid[]) AND state<>'received' AND reported_at IS NULL`,
      [ctx.branchId, [commandId]],
    );
    assert.equal(reported.rowCount, 1);
    assert.deepEqual(
      (
        await worker.query(
          'SELECT variant_id,version,source,stopped FROM local_stops WHERE branch_id=$1 ORDER BY version',
          [ctx.branchId],
        )
      ).rows,
      [
        { variant_id: variant, version: 1, source: 'backoffice', stopped: true },
        { variant_id: ctx.stopped, version: 3, source: 'pos', stopped: true },
      ],
    );
    assert.deepEqual(
      (
        await ctx.pool.query(
          'SELECT variant_id,version,source,command_id,actor_label FROM local_stop_events',
        )
      ).rows,
      [
        {
          variant_id: variant,
          version: 1,
          source: 'backoffice',
          command_id: commandId,
          actor_label: 'Synthetic manager',
        },
      ],
    );
  });
});
