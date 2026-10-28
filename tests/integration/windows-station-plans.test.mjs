// Stage 2 lane cfg: guarded edge schema023 -> 024 upgrade for station plans on the Windows
// cashier, and the menu-sync worker role applying a plan with exactly its reviewed rights.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { fixtureMenu } from '@pickchick/test-fixtures';
import {
  hashJson,
  readActiveStationPlan,
  stationPlanReadiness,
  syncStationPlanOnce,
} from '@pickchick/menu-sync';
import { provisionFulfillment } from '@pickchick/edge-fulfillment';
import { ensureMenuSyncRole, upgradeMenuSync } from '../../infra/windows/menu-sync-upgrade-db.mjs';
import { assertMenuSyncPrivileges } from '../../infra/windows/menu-sync-worker-grants.mjs';
import { stationPlanMigration } from '../../infra/windows/station-plan-upgrade-db.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Edge at schema023 (the reviewed runtime) with fulfillment stations and a runtime role. */
async function edgeAt023(run) {
  const config = loadConfig('edge');
  const admin = createPool(config.databaseUrl, 2);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 20);
  const schema = `plan_upgrade_${suffix}`,
    role = `plan_menu_${suffix}`,
    runtimeRole = `plan_runtime_${suffix}`;
  const dir = await mkdtemp(join(tmpdir(), 'pickchick-station-plan-upgrade-'));
  const installed = join(dir, 'installed'),
    appRoot = join(dir, 'candidate');
  let pool;
  try {
    await mkdir(installed, { recursive: true });
    await mkdir(join(appRoot, 'db/edge/migrations'), { recursive: true });
    for (const name of (await readdir(join(root, 'db/edge/migrations'))).filter((n) =>
      n.endsWith('.sql'),
    )) {
      if (name < '025')
        await copyFile(
          join(root, 'db/edge/migrations', name),
          join(appRoot, 'db/edge/migrations', name),
        );
      if (name < '024')
        await copyFile(join(root, 'db/edge/migrations', name), join(installed, name));
    }
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(config.databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool(url.toString(), 4);
    await migrate(pool, installed, 'edge');
    const scope = {
      organizationId: randomUUID(),
      branchId: randomUUID(),
      deviceId: randomUUID(),
      producerId: randomUUID(),
    };
    await pool.query(
      "INSERT INTO branch_config(id,code,name,timezone) VALUES ($1,'PLAN','Synthetic','Asia/Almaty')",
      [scope.branchId],
    );
    const prep = randomUUID(),
      assembly = randomUUID();
    await provisionFulfillment(pool, {
      ...scope,
      stations: [
        { id: prep, kind: 'prep', name: 'Synthetic prep' },
        { id: assembly, kind: 'assembly', name: 'Synthetic assembly' },
      ],
      routing: {
        version: 1,
        assemblyStationId: assembly,
        routes: [{ productId: fixtureMenu.items[0].product_id, stationId: prep, kind: 'prep' }],
      },
    });
    await admin.query(`CREATE ROLE ${runtimeRole} NOLOGIN NOINHERIT`);
    await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
    await pool.query(`GRANT SELECT ON local_orders TO ${runtimeRole}`);
    const backup = async () => ({
      format: 'pickchick-native-service-backup-v1',
      runId: randomUUID(),
      branchId: scope.branchId,
      sourceDatabase: 'pickchick_edge',
      backupVerified: true,
      restoreVerified: true,
      rehearsalDropped: true,
      completed: true,
      sha256: 'a'.repeat(64),
      archiveBytes: 1024,
      finishedAt: new Date(Date.now() - 60000).toISOString(),
      ledger: (
        await pool.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version')
      ).rows.map((row) => ({ version: row.version, checksum: row.checksum, scope: row.scope })),
    });
    await run({
      admin,
      pool,
      url,
      schema,
      role,
      runtimeRole,
      scope,
      prep,
      assembly,
      appRoot,
      backup,
    });
  } finally {
    await pool?.end();
    for (const name of [role, runtimeRole]) {
      await admin.query(`DROP OWNED BY ${name}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${name}`);
    }
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
}

test('guarded 023 -> 024 upgrade keeps data and ACL, grants only the menu-sync role and refuses a repeat', () =>
  edgeAt023(async (ctx) => {
    const client = await ctx.pool.connect();
    const password = randomBytes(32).toString('hex');
    let worker, server;
    try {
      await client.query(
        'INSERT INTO menu_sync_state(branch_id,producer_id,last_sequence) VALUES($1,gen_random_uuid(),5)',
        [ctx.scope.branchId],
      );
      await ensureMenuSyncRole(ctx.admin, { role: ctx.role, password });
      const menuOptions = async () => ({
        mode: 'apply',
        appRoot: ctx.appRoot,
        branchId: ctx.scope.branchId,
        deviceId: ctx.scope.deviceId,
        backup: await ctx.backup(),
        schema: ctx.schema,
        role: ctx.role,
        runtimeRole: ctx.runtimeRole,
        databaseDefaultsRevoked: false,
      });
      assert.equal((await upgradeMenuSync(client, await menuOptions())).grantsVerified, true);

      const options = {
        mode: 'inspect',
        appRoot: ctx.appRoot,
        branchId: ctx.scope.branchId,
        schema: ctx.schema,
        workerRole: ctx.role,
        databaseDefaultsRevoked: false,
      };
      await assert.rejects(
        stationPlanMigration(client, { ...options, appRoot: join(ctx.appRoot, 'missing') }),
      );
      await assert.rejects(
        stationPlanMigration(client, { ...options, branchId: randomUUID() }),
        /Branch differs/,
      );
      const inspect = await stationPlanMigration(client, options);
      assert.deepEqual(
        [inspect.migrations, inspect.workerRolePresent, inspect.stationPlanGrantedTo],
        [23, true, []],
      );
      assert.equal(
        (await client.query("SELECT to_regclass('station_plan_receipts') IS NULL AS absent"))
          .rows[0].absent,
        true,
      );
      const applied = await stationPlanMigration(client, { ...options, mode: 'apply' });
      assert.equal(applied.migrations, 24);
      assert.equal(applied.fingerprint, inspect.fingerprint);
      assert.deepEqual(applied.stationPlanGrantedTo, [ctx.role]);
      assert.equal(
        (await client.query('SELECT last_sequence::int AS s FROM menu_sync_state')).rows[0].s,
        5,
      );
      for (const table of [
        'station_plan_snapshots',
        'station_plan_active',
        'station_plan_receipts',
      ])
        assert.equal(
          (
            await client.query("SELECT has_any_column_privilege($1,$2,'SELECT') AS reach", [
              ctx.runtimeRole,
              table,
            ])
          ).rows[0].reach,
          false,
          table,
        );
      await assertMenuSyncPrivileges(client, ctx.role, ctx.schema, {
        databaseDefaultsRevoked: false,
        stationPlans: true,
      });
      await assert.rejects(
        assertMenuSyncPrivileges(client, ctx.role, ctx.schema, { databaseDefaultsRevoked: false }),
        /privileges differ/,
      );
      await assert.rejects(
        stationPlanMigration(client, { ...options, mode: 'apply' }),
        /Expected unchanged schema023/,
      );
      // Re-running the menu-sync phase after 024 keeps the station plan rights.
      assert.equal((await upgradeMenuSync(client, await menuOptions())).grantsVerified, true);
      await assertMenuSyncPrivileges(client, ctx.role, ctx.schema, {
        databaseDefaultsRevoked: false,
        stationPlans: true,
      });

      // The installed worker role applies a plan with exactly these rights.
      const url = new URL(ctx.url);
      url.username = ctx.role;
      url.password = password;
      worker = createPool(url.toString(), 2);
      assert.equal(await stationPlanReadiness(worker), 'ready');
      const plan = {
        schema_version: 1,
        plan_id: randomUUID(),
        branch_id: ctx.scope.branchId,
        version: 1,
        published_at: new Date().toISOString(),
        stations: [
          {
            id: randomUUID(),
            revision: 1,
            name: 'Фритюр',
            role: 'prep',
            active: true,
            device_id: null,
            edge_station_id: ctx.prep,
            product_ids: ['synthetic-burger'],
            target_seconds: 240,
          },
        ],
      };
      let offered = { plan, checksum: hashJson(plan) };
      const receipts = [];
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          res.setHeader('Content-Type', 'application/json');
          if (req.url === '/internal/v1/edge/station-plans/pull') {
            const answer = { delivery: offered };
            offered = null;
            return res.end(JSON.stringify(answer));
          }
          if (req.url === '/internal/v1/edge/station-plans/receipt') {
            const receipt = JSON.parse(body);
            receipts.push(receipt);
            return res.end(JSON.stringify({ plan_id: receipt.plan_id, recorded: true }));
          }
          res.statusCode = 404;
          res.end('{}');
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const identity = {
        device_id: ctx.scope.deviceId,
        branch_id: ctx.scope.branchId,
        token: 'b'.repeat(64),
        expires_at: new Date(Date.now() + 86400_000).toISOString(),
      };
      assert.deepEqual(await syncStationPlanOnce(worker, ctx.scope.branchId, origin, identity), {
        state: 'applied',
        version: 1,
      });
      assert.deepEqual(
        receipts.map((r) => r.result),
        ['applied'],
      );
      assert.equal((await readActiveStationPlan(worker, ctx.scope.branchId)).version, 1);
      assert.deepEqual(await syncStationPlanOnce(worker, ctx.scope.branchId, origin, identity), {
        state: 'idle',
      });
      for (const sql of [
        'DELETE FROM station_plan_receipts',
        'UPDATE station_plan_snapshots SET version=2',
        'SELECT * FROM local_staff',
      ])
        await assert.rejects(worker.query(sql), { code: '42501' }, sql);
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      await worker?.end();
      client.release();
    }
  }));

test('the upgrade on a cashier without the menu-sync worker grants nobody', () =>
  edgeAt023(async (ctx) => {
    const client = await ctx.pool.connect();
    try {
      const applied = await stationPlanMigration(client, {
        mode: 'apply',
        appRoot: ctx.appRoot,
        branchId: ctx.scope.branchId,
        schema: ctx.schema,
        workerRole: ctx.role,
        databaseDefaultsRevoked: false,
      });
      assert.deepEqual(
        [applied.migrations, applied.workerRolePresent, applied.stationPlanGrantedTo],
        [24, false, []],
      );
      const grantees = (
        await client.query(
          `SELECT count(*)::int AS n FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
           WHERE c.relnamespace=$1::regnamespace AND c.relname LIKE 'station_plan_%' AND x.grantee<>c.relowner`,
          [ctx.schema],
        )
      ).rows[0].n;
      assert.equal(grantees, 0);
    } finally {
      client.release();
    }
  }));
