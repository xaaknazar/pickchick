import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { activateExistingStops } from '../../infra/staging/existing-stops-owner.mjs';
import { runtimePrivileges } from '../../infra/staging/unified-menu-owner.mjs';
import { catalogAssetGrants } from '../../infra/staging/catalog-asset-grants.mjs';
const DIRECTORY = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));
async function fixture(t) {
  const config = loadConfig('api'),
    admin = createPool(config.databaseUrl),
    schema = 'uc_' + randomUUID().replaceAll('-', ''),
    role = 'uc_' + randomUUID().replaceAll('-', '').slice(0, 12);
  await admin.query(`CREATE SCHEMA ${schema};CREATE ROLE ${role} NOLOGIN`);
  const url = new URL(config.databaseUrl);
  url.searchParams.set('options', '-c search_path=' + schema);
  const pool = createPool(url.href);
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE;DROP OWNED BY ${role};DROP ROLE ${role}`);
    await admin.end();
  });
  const directory = await mkdtemp(join(tmpdir(), 'existing-stops052-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of await readdir(DIRECTORY))
    if (name.endsWith('.sql') && name <= '052_z')
      await copyFile(join(DIRECTORY, name), join(directory, name));
  await migrate(pool, directory, 'cloud');
  await pool.query(
    `GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT ON branches,bo_access_grants,cloud_stop_commands TO ${role}; GRANT UPDATE ON cloud_branch_availability TO ${role}; GRANT UPDATE(state,result_version,delivered_at,resolved_at) ON cloud_stop_commands TO ${role};` +
      catalogAssetGrants(role, false),
  );
  const org = randomUUID();
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic continuation')", [org]);
  return { pool, role, org, directory };
}
async function tx(pool, run) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const result = await run(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
async function plan(f, phase, enabled, extra = {}) {
  return tx(f.pool, (c) =>
    activateExistingStops(c, {
      directory: f.directory,
      role: f.role,
      phase,
      enabled,
      inspect: true,
      ...extra,
    }),
  );
}
async function apply(f, phase, enabled, proof, extra = {}) {
  return tx(f.pool, (c) =>
    activateExistingStops(c, {
      directory: f.directory,
      role: f.role,
      phase,
      enabled,
      expectedState: proof.state_digest,
      ...extra,
    }),
  );
}

test('schema052 STOP grant and revoke preserve data and shared transport', async (t) => {
  const f = await fixture(t),
    initial = await runtimePrivileges(f.pool, f.role);
  for (const phase of ['remote-stops']) {
    const pre = await plan(f, phase, true),
      result = await apply(f, phase, true, pre);
    assert.equal(result.existingDataPreserved, true);
    assert.deepEqual(result.privilegesAdded, pre.privilegesAdded);
    await assert.rejects(plan(f, phase, true), /partial, already changed/);
    const off = await plan(f, phase, false);
    await apply(f, phase, false, off);
  }
  const final = await runtimePrivileges(f.pool, f.role);
  assert.deepEqual(final, [...initial, 'catalog_publications||SELECT'].sort());
  assert.equal(
    (await f.pool.query('SELECT name FROM organizations WHERE id=$1', [f.org])).rows[0].name,
    'Synthetic continuation',
  );
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 51);
});

test('stale metadata CAS and partial asset ACL refuse with no grant mutation', async (t) => {
  const f = await fixture(t),
    pre = await plan(f, 'remote-stops', true);
  await f.pool.query(`GRANT SELECT ON legal_entities TO ${f.role}`);
  const before = await runtimePrivileges(f.pool, f.role);
  await assert.rejects(apply(f, 'remote-stops', true, pre), /metadata changed/);
  assert.deepEqual(await runtimePrivileges(f.pool, f.role), before);
  await f.pool.query(`GRANT INSERT ON catalog_assets TO ${f.role}`);
  await assert.rejects(plan(f, 'media-upload', true), /Only remote/);
});

test('future or altered ledger bytes, unexpected asset grants and privileged role fail closed', async (t) => {
  const f = await fixture(t),
    dir = await mkdtemp(join(tmpdir(), 'continuation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of await readdir(DIRECTORY))
    if (name.endsWith('.sql') && name <= '052_z')
      await copyFile(join(DIRECTORY, name), join(dir, name));
  const file = join(dir, '050_cloud_kiosk_payment_incidents.sql'),
    original = await readFile(file);
  await writeFile(file, 'SELECT 1;');
  await assert.rejects(plan(f, 'remote-stops', true, { directory: dir }), /ledger/);
  await writeFile(file, original);
  await writeFile(join(dir, '052_unreviewed.sql'), 'SELECT 1;');
  await assert.rejects(plan(f, 'remote-stops', true, { directory: dir }), /candidate/);
  await f.pool.query(`GRANT UPDATE ON catalog_assets TO ${f.role}`);
  await assert.rejects(plan(f, 'media-upload', true), /Only remote/);
  await f.pool.query(`ALTER ROLE ${f.role} CREATEDB`);
  await assert.rejects(plan(f, 'remote-stops', true), /privileged/);
});

test('injected DML is caught and rolled back, concurrent heartbeat writer is tolerated in RR snapshot', async (t) => {
  const f = await fixture(t),
    pre = await plan(f, 'remote-stops', true);
  const opts = {
    directory: f.directory,
    role: f.role,
    phase: 'remote-stops',
    enabled: true,
    expectedState: pre.state_digest,
  };
  await assert.rejects(
    tx(f.pool, (c) =>
      activateExistingStops(
        {
          query: async (sql, args) => {
            if (
              typeof sql === 'string' &&
              sql.startsWith('GRANT SELECT,INSERT ON cloud_stop_commands')
            )
              await c.query("UPDATE organizations SET name='Injected'");
            return c.query(sql, args);
          },
        },
        opts,
      ),
    ),
    /Data changed/,
  );
  assert.equal(
    (await f.pool.query('SELECT name FROM organizations WHERE id=$1', [f.org])).rows[0].name,
    'Synthetic continuation',
  );
  let updated = false;
  const result = await tx(f.pool, (c) =>
    activateExistingStops(
      {
        query: async (sql, args) => {
          if (
            typeof sql === 'string' &&
            sql.startsWith('GRANT SELECT,INSERT ON cloud_stop_commands')
          ) {
            await f.pool.query("UPDATE organizations SET name='Concurrent' WHERE id=$1", [f.org]);
            updated = true;
          }
          return c.query(sql, args);
        },
      },
      opts,
    ),
  );
  assert.equal(result.existingDataPreserved, true);
  assert.equal(updated, true);
  assert.equal(
    (await f.pool.query('SELECT name FROM organizations WHERE id=$1', [f.org])).rows[0].name,
    'Concurrent',
  );
});

test('an extra applied migration refuses activation, unrelated source files do not relax exact installed ledger', async (t) => {
  const f = await fixture(t);
  await f.pool.query(
    "INSERT INTO schema_migrations(version,scope,checksum) VALUES('053_unreviewed.sql','cloud',$1)",
    ['a'.repeat(64)],
  );
  await assert.rejects(plan(f, 'remote-stops', true), /ledger/);
  assert.equal(
    (await runtimePrivileges(f.pool, f.role)).includes('cloud_stop_commands||INSERT'),
    false,
  );
});
