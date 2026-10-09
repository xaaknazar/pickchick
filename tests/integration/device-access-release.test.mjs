import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import {
  DEVICE_MIGRATION,
  DEVICE_TABLES,
  DEVICE_PRIVILEGES,
  deployDevices,
} from '../../infra/staging/device-access-owner.mjs';
import { OwnerGuardError, runtimePrivileges } from '../../infra/staging/unified-menu-owner.mjs';
const MIGRATIONS = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));
async function directory(t, upTo = '051_z') {
  const dir = await mkdtemp(join(tmpdir(), 'devices-migration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const n of await readdir(MIGRATIONS))
    if (n.endsWith('.sql') && n <= upTo) await copyFile(join(MIGRATIONS, n), join(dir, n));
  return dir;
}
async function fixture(t) {
  const config = loadConfig('api'),
    admin = createPool(config.databaseUrl),
    schema = 'dr_' + randomUUID().replaceAll('-', ''),
    role = 'dr_' + randomUUID().replaceAll('-', '').slice(0, 12);
  await admin.query(`CREATE SCHEMA ${schema};CREATE ROLE ${role} NOLOGIN`);
  const url = new URL(config.databaseUrl);
  url.searchParams.set('options', '-c search_path=' + schema);
  const pool = createPool(url.href);
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE;DROP OWNED BY ${role};DROP ROLE ${role}`);
    await admin.end();
  });
  await migrate(pool, await directory(t, '050_z'), 'cloud');
  await pool.query(
    `GRANT USAGE ON SCHEMA ${schema} TO ${role};GRANT SELECT ON branches TO ${role}`,
  );
  const org = randomUUID();
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic release')", [org]);
  return { pool, role, org };
}
async function transaction(pool, action) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const out = await action(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
test('Devices owner051 adds only reviewed empty tables/ACL and preserves existing rows and role', async (t) => {
  const f = await fixture(t),
    directoryPath = await directory(t),
    options = { directory: directoryPath, role: f.role };
  const plan = await transaction(f.pool, (c) => deployDevices(c, { ...options, inspect: true }));
  assert.deepEqual(plan.pending, [DEVICE_MIGRATION]);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 49);
  const out = await transaction(f.pool, (c) => deployDevices(c, options));
  assert.equal(out.existingDataPreserved, true);
  assert.deepEqual(out.applied, [DEVICE_MIGRATION]);
  assert.deepEqual(out.privilegesAdded, DEVICE_PRIVILEGES);
  for (const table of DEVICE_TABLES)
    assert.equal((await f.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
  assert.equal(
    (await f.pool.query('SELECT name FROM organizations WHERE id=$1', [f.org])).rows[0].name,
    'Synthetic release',
  );
  assert.deepEqual(
    await runtimePrivileges(f.pool, f.role),
    [...DEVICE_PRIVILEGES, 'branches||SELECT'].sort(),
  );
  await assert.rejects(
    transaction(f.pool, (c) => deployDevices(c, options)),
    (e) => e instanceof OwnerGuardError && /not replayed/.test(e.message),
  );
});
test('Devices owner refuses altered old migrations, partial table and future migration without effects', async (t) => {
  const f = await fixture(t),
    dir = await directory(t),
    opts = { directory: dir, role: f.role };
  const target = join(dir, '050_cloud_kiosk_payment_incidents.sql');
  await writeFile(target, 'SELECT 1;');
  await assert.rejects(
    transaction(f.pool, (c) => deployDevices(c, opts)),
    /ledger required/,
  );
  await copyFile(join(MIGRATIONS, '050_cloud_kiosk_payment_incidents.sql'), target);
  await writeFile(join(dir, '052_unreviewed.sql'), 'SELECT 1;');
  await assert.rejects(
    transaction(f.pool, (c) => deployDevices(c, opts)),
    /end at cloud051/,
  );
  await rm(join(dir, '052_unreviewed.sql'));
  await f.pool.query('CREATE TABLE device_events (id integer)');
  await assert.rejects(
    transaction(f.pool, (c) => deployDevices(c, opts)),
    /table exists/,
  );
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 49);
  assert.deepEqual(await runtimePrivileges(f.pool, f.role), ['branches||SELECT']);
});
test('Existing shared device grants remain intact and injected DML rolls the entire owner transaction back', async (t) => {
  const f = await fixture(t),
    dir = await directory(t),
    opts = { directory: dir, role: f.role };
  await f.pool.query(
    `GRANT INSERT ON devices TO ${f.role};GRANT SELECT(device_id,expires_at) ON device_credentials TO ${f.role}`,
  );
  const sql = await import('node:fs/promises').then((m) =>
    m.readFile(join(dir, DEVICE_MIGRATION), 'utf8'),
  );
  await writeFile(
    join(dir, DEVICE_MIGRATION),
    sql + "\nUPDATE organizations SET name='Injected change';\n",
  );
  await assert.rejects(
    transaction(f.pool, (c) => deployDevices(c, opts)),
    /Existing data changed/,
  );
  assert.equal(
    (await f.pool.query('SELECT name FROM organizations WHERE id=$1', [f.org])).rows[0].name,
    'Synthetic release',
  );
  assert.equal(
    (await f.pool.query("SELECT to_regclass('device_terminal_registry') AS present")).rows[0]
      .present,
    null,
  );
  await writeFile(join(dir, DEVICE_MIGRATION), sql);
  const out = await transaction(f.pool, (c) => deployDevices(c, opts));
  assert.equal(out.privilegesAdded.includes('devices||INSERT'), false);
  assert.equal(out.privilegesAdded.includes('device_credentials|expires_at|SELECT'), false);
});

test('RR proof tolerates a concurrent heartbeat-style writer without comparing separate live snapshots', async (t) => {
  const f = await fixture(t),
    dir = await directory(t);
  let concurrent = false;
  await transaction(f.pool, async (client) => {
    const wrapped = {
      query: async (sql, params) => {
        if (typeof sql === 'string' && sql.includes('CREATE TABLE device_terminal_registry')) {
          await f.pool.query(
            "UPDATE organizations SET name='Concurrent synthetic update' WHERE id=$1",
            [f.org],
          );
          concurrent = true;
        }
        return client.query(sql, params);
      },
    };
    const out = await deployDevices(wrapped, { directory: dir, role: f.role });
    assert.equal(out.existingDataPreserved, true);
  });
  assert.equal(concurrent, true);
  assert.equal(
    (await f.pool.query('SELECT name FROM organizations WHERE id=$1', [f.org])).rows[0].name,
    'Concurrent synthetic update',
  );
});
