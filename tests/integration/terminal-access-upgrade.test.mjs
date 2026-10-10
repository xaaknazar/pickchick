import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { edgeRuntimeGrantSql } from '../../infra/windows/edge-runtime-grants.mjs';
import {
  upgradeTerminalAccess,
  deviceAccessEnvText,
  parseDeviceAccessEnv,
  ensureDeviceDatabaseConnect,
  assertDeviceDatabaseConnect,
} from '../../infra/windows/terminal-access-upgrade-db.mjs';
const appRoot = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(run) {
  const url = new URL(loadConfig('edge').databaseUrl),
    admin = createPool(url.toString(), 2),
    suffix = randomUUID().replaceAll('-', ''),
    schema = 'devices_' + suffix,
    runtimeRole = 'runtime_' + suffix,
    workerRole = 'mailbox_' + suffix,
    other = 'other_' + suffix,
    branchId = randomUUID(),
    deviceId = randomUUID();
  const dir = await mkdtemp(join(tmpdir(), 'devices019-'));
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set('options', '-c search_path=' + schema);
    pool = createPool(url.toString(), 2);
    for (const name of (await readdir(join(appRoot, 'db/edge/migrations'))).filter(
      (x) => x.endsWith('.sql') && x < '020',
    ))
      await copyFile(join(appRoot, 'db/edge/migrations', name), join(dir, name));
    await migrate(pool, dir, 'edge');
    await pool.query(
      "INSERT INTO branch_config(id,code,name,timezone) VALUES($1,'DEV','Synthetic','Asia/Almaty')",
      [branchId],
    );
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('INSERT INTO fulfillment_config VALUES($1,$2,$3,$4,1)', [
        branchId,
        randomUUID(),
        deviceId,
        randomUUID(),
      ]);
      await c.query('INSERT INTO fulfillment_routing VALUES($1,1,$2,$3)', [
        branchId,
        {},
        'a'.repeat(64),
      ]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await pool.query('INSERT INTO local_terminals(id,branch_id) VALUES($1,$2)', [
      randomUUID(),
      branchId,
    ]);
    for (const role of [runtimeRole, workerRole, other])
      await admin.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT`);
    await pool.query(
      edgeRuntimeGrantSql(runtimeRole, {
        schema,
        fulfillment: true,
        menuMedia: true,
        cashierReports: true,
        remoteStops: true,
      }),
    );
    await pool.query(`GRANT SELECT ON ${schema}.local_terminals TO ${other}`);
    const backup = async (extra = {}) => ({
      format: 'pickchick-native-service-backup-v1',
      branchId,
      sourceDatabase: 'pickchick_edge',
      backupVerified: true,
      restoreVerified: true,
      rehearsalDropped: true,
      completed: true,
      sha256: 'a'.repeat(64),
      archiveBytes: 100,
      finishedAt: new Date(Date.now() - 1000).toISOString(),
      ledger: (
        await pool.query('SELECT scope,version,checksum FROM schema_migrations ORDER BY version')
      ).rows,
      ...extra,
    });
    const options = async (mode, extra = {}) => ({
      mode,
      appRoot,
      schema,
      runtimeRole,
      workerRole,
      branchId,
      deviceId,
      backup: await backup(),
      ...extra,
    });
    await run({
      pool,
      admin,
      schema,
      runtimeRole,
      workerRole,
      other,
      options,
      backup,
      branchId,
      deviceId,
    });
  } finally {
    await pool?.end();
    for (const role of [runtimeRole, workerRole, other]) {
      await admin.query(`DROP OWNED BY ${role}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
    }
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
}
test('019->020 adds exactly device ACLs, preserves old terminal and other ACL, and inspection is read-only', async () =>
  fixture(async (ctx) => {
    const c = await ctx.pool.connect();
    try {
      const before = (await ctx.pool.query('SELECT * FROM local_terminals')).rows;
      const inspected = await upgradeTerminalAccess(c, await ctx.options('inspect'));
      assert.equal(inspected.migrationPending, true);
      assert.equal(inspected.migrations, 19);
      const applied = await upgradeTerminalAccess(c, await ctx.options('apply'));
      assert.equal(applied.migrations, 20);
      assert.equal(applied.grantsVerified, true);
      assert.equal(applied.fingerprint, inspected.fingerprint);
      assert.deepEqual(
        (await ctx.pool.query('SELECT * FROM local_terminals')).rows,
        before.map((r) => ({ ...r, device_access_managed: false })),
      );
      const status = await upgradeTerminalAccess(c, await ctx.options('inspect'));
      assert.equal(status.managedTerminals, 0);
      assert.equal(status.grantsVerified, true);
      await assert.rejects(upgradeTerminalAccess(c, await ctx.options('apply')), /already applied/);
      assert.equal(
        (
          await ctx.pool.query("SELECT has_table_privilege($1,$2,'SELECT') ok", [
            ctx.other,
            ctx.schema + '.local_terminals',
          ])
        ).rows[0].ok,
        true,
      );
    } finally {
      c.release();
    }
  }));
test('foreign branch/device and stale or mismatched backup reject without migration', async () =>
  fixture(async (ctx) => {
    const c = await ctx.pool.connect();
    try {
      for (const extra of [
        { branchId: randomUUID() },
        { deviceId: randomUUID() },
        {
          backup: await ctx.backup({
            finishedAt: new Date(Date.now() - 7 * 3600000).toISOString(),
          }),
        },
        { backup: await ctx.backup({ restoreVerified: false }) },
      ])
        await assert.rejects(upgradeTerminalAccess(c, await ctx.options('apply', extra)));
      assert.equal(
        (await ctx.pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n,
        19,
      );
    } finally {
      c.release();
    }
  }));
test('unrelated mailbox privileges are refused, never revoked or silently accepted', async () =>
  fixture(async (ctx) => {
    await ctx.pool.query(`GRANT SELECT ON ${ctx.schema}.local_orders TO ${ctx.workerRole}`);
    const c = await ctx.pool.connect();
    try {
      await assert.rejects(
        upgradeTerminalAccess(c, await ctx.options('apply')),
        /already holds privileges/,
      );
      assert.equal((await c.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 19);
    } finally {
      c.release();
    }
  }));
test('an unexpected business row change before commit rolls back migration and grants', async () =>
  fixture(async (ctx) => {
    const c = await ctx.pool.connect();
    let injected = false;
    const wrapped = {
      query: async (q, ...args) => {
        const result = await c.query(q, ...args);
        if (!injected && typeof q === 'string' && q.startsWith('GRANT USAGE')) {
          injected = true;
          await c.query('UPDATE local_terminals SET active=false');
        }
        return result;
      },
    };
    try {
      await assert.rejects(
        upgradeTerminalAccess(wrapped, await ctx.options('apply')),
        /Existing rows/,
      );
      assert.equal((await c.query('SELECT active FROM local_terminals')).rows[0].active, true);
      assert.equal((await c.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 19);
    } finally {
      c.release();
    }
  }));
test('lost COMMIT response leaves truthful020 state and never retries the migration', async () =>
  fixture(async (ctx) => {
    const c = await ctx.pool.connect();
    let commits = 0;
    const wrapped = {
      query: async (q, ...args) => {
        const result = await c.query(q, ...args);
        if (q === 'COMMIT') {
          commits++;
          throw new Error('Synthetic response loss');
        }
        return result;
      },
    };
    try {
      await assert.rejects(
        upgradeTerminalAccess(wrapped, await ctx.options('apply')),
        /Commit result unknown/,
      );
      assert.equal(commits, 1);
      const actual = await upgradeTerminalAccess(c, await ctx.options('inspect'));
      assert.equal(actual.migrations, 20);
      assert.equal(actual.grantsVerified, true);
      await assert.rejects(upgradeTerminalAccess(c, await ctx.options('apply')), /already applied/);
    } finally {
      c.release();
    }
  }));
test('device worker private environment is exact, default disabled, never accepts duplicate or altered credentials', () => {
  const scope = { branchId: randomUUID(), deviceId: randomUUID() },
    password = 'c'.repeat(64),
    text = deviceAccessEnvText({ ...scope, password });
  assert.deepEqual(parseDeviceAccessEnv(text, scope), { password, enabled: false });
  for (const invalid of [
    text.replace('55433', '5432'),
    text + 'DEVICE_ACCESS_WORKER_ENABLED=true\n',
    text.replaceAll('\n', '\r\n'),
    text.replace(scope.branchId, randomUUID()),
  ])
    assert.throws(() => parseDeviceAccessEnv(invalid, scope));
});

// Native foundation revokes PUBLIC database access. Use a separate DB so no shared
// fixture ACL changes can leak into parallel tests, and exercise a real LOGIN.
test('mailbox CONNECT is an owner-only exact additive grant and permits real login with PUBLIC revoked', async () => {
  const base = new URL(loadConfig('edge').databaseUrl);
  const admin = createPool(base.toString(), 2);
  const suffix = randomUUID().replaceAll('-', ''),
    database = 'connect_' + suffix,
    role = 'connect_worker_' + suffix;
  const password = randomUUID().replaceAll('-', '');
  let owner, worker;
  try {
    await admin.query(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${password}'`);
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    const url = new URL(base);
    url.pathname = '/' + database;
    url.searchParams.delete('options');
    owner = createPool(url.toString(), 1);
    const before = (
      await admin.query('SELECT datacl::text acl FROM pg_database WHERE datname=$1', [database])
    ).rows[0].acl;
    const login = new URL(url);
    login.username = role;
    login.password = password;
    worker = createPool(login.toString(), 1);
    await assert.rejects(worker.query('SELECT current_user'), { code: '42501' });
    const client = await owner.connect();
    try {
      await ensureDeviceDatabaseConnect(client, role);
      await assertDeviceDatabaseConnect(client, role);
      const first = (
        await client.query(
          'SELECT datacl::text acl FROM pg_database WHERE datname=current_database()',
        )
      ).rows[0].acl;
      assert.notEqual(first, before);
      assert.equal((await worker.query('SELECT current_user role')).rows[0].role, role);
      await ensureDeviceDatabaseConnect(client, role);
      assert.equal(
        (
          await client.query(
            'SELECT datacl::text acl FROM pg_database WHERE datname=current_database()',
          )
        ).rows[0].acl,
        first,
      );
      const rights = (
        await client.query(
          "SELECT has_database_privilege($1,current_database(),'CREATE') can_create,has_database_privilege($1,current_database(),'TEMP') temp",
          [role],
        )
      ).rows[0];
      assert.deepEqual(rights, { can_create: false, temp: false });
      const restricted = await worker.connect();
      try {
        await assert.rejects(ensureDeviceDatabaseConnect(restricted, role), /owner connection/);
      } finally {
        restricted.release();
      }
      await client.query(`GRANT TEMP ON DATABASE ${database} TO ${role}`);
      const broad = (
        await client.query(
          'SELECT datacl::text acl FROM pg_database WHERE datname=current_database()',
        )
      ).rows[0].acl;
      await assert.rejects(ensureDeviceDatabaseConnect(client, role), /Existing mailbox database/);
      assert.equal(
        (
          await client.query(
            'SELECT datacl::text acl FROM pg_database WHERE datname=current_database()',
          )
        ).rows[0].acl,
        broad,
      );
    } finally {
      client.release();
    }
  } finally {
    await worker?.end();
    await owner?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  }
});
