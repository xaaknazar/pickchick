import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { continueUnifiedMenu } from '../../infra/staging/unified-menu-continuation-owner.mjs';
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
  const directory = await mkdtemp(join(tmpdir(), 'continuation051-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of await readdir(DIRECTORY))
    if (name.endsWith('.sql') && name <= '051_z')
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
    continueUnifiedMenu(c, {
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
    continueUnifiedMenu(c, {
      directory: f.directory,
      role: f.role,
      phase,
      enabled,
      expectedState: proof.state_digest,
      ...extra,
    }),
  );
}

test('schema051 continuation adds and revokes each exact ACL without changing data/shared transport', async (t) => {
  const f = await fixture(t),
    initial = await runtimePrivileges(f.pool, f.role);
  for (const phase of ['remote-stops', 'media-upload']) {
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
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 50);
});

test('stale metadata CAS and partial asset ACL refuse with no grant mutation', async (t) => {
  const f = await fixture(t),
    pre = await plan(f, 'remote-stops', true);
  await f.pool.query(`GRANT SELECT ON legal_entities TO ${f.role}`);
  const before = await runtimePrivileges(f.pool, f.role);
  await assert.rejects(apply(f, 'remote-stops', true, pre), /metadata changed/);
  assert.deepEqual(await runtimePrivileges(f.pool, f.role), before);
  await f.pool.query(`GRANT INSERT ON catalog_assets TO ${f.role}`);
  await assert.rejects(plan(f, 'media-upload', true), /partial/);
});

test('future or altered ledger bytes, unexpected asset grants and privileged role fail closed', async (t) => {
  const f = await fixture(t),
    dir = await mkdtemp(join(tmpdir(), 'continuation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of await readdir(DIRECTORY))
    if (name.endsWith('.sql') && name <= '051_z')
      await copyFile(join(DIRECTORY, name), join(dir, name));
  const file = join(dir, '050_cloud_kiosk_payment_incidents.sql'),
    original = await readFile(file);
  await writeFile(file, 'SELECT 1;');
  await assert.rejects(plan(f, 'remote-stops', true, { directory: dir }), /ledger/);
  await writeFile(file, original);
  await writeFile(join(dir, '052_unreviewed.sql'), 'SELECT 1;');
  await assert.rejects(plan(f, 'remote-stops', true, { directory: dir }), /candidate/);
  await f.pool.query(`GRANT UPDATE ON catalog_assets TO ${f.role}`);
  await assert.rejects(plan(f, 'media-upload', true), /Unexpected asset/);
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
      continueUnifiedMenu(
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
    continueUnifiedMenu(
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

test('operator menu SQL joins the actual latest catalog delivery, applied verdict and activation on cloud051', async (t) => {
  const f = await fixture(t),
    legal = randomUUID(),
    branch = randomUUID(),
    edge = randomUUID(),
    actor = randomUUID(),
    release = randomUUID(),
    sum = 'c'.repeat(64);
  await f.pool.query(
    "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES($1,$2,'Synthetic','000000000000')",
    [legal, f.org],
  );
  await f.pool.query(
    "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES($1,$2,$3,'UC','Synthetic')",
    [branch, f.org, legal],
  );
  await f.pool.query(
    "INSERT INTO devices(id,branch_id,organization_id,kind,name,status) VALUES($1,$2,$3,'edge','Synthetic','active')",
    [edge, branch, f.org],
  );
  await f.pool.query(
    "INSERT INTO catalog_managers(id,organization_id,name,token_hash) VALUES($1,$2,'Synthetic',$3)",
    [actor, f.org, sum],
  );
  const payload = {
    schema_version: 1,
    currency: 'KZT',
    content_reviewed: true,
    products: [],
    categories: [],
  };
  await f.pool.query(
    'INSERT INTO catalog_draft_versions(branch_id,organization_id,revision,payload,payload_hash,actor_id) VALUES($1,$2,1,$3,$4,$5)',
    [branch, f.org, payload, sum, actor],
  );
  await f.pool.query(
    'INSERT INTO catalog_publications(branch_id,organization_id,version,source_revision,payload,payload_hash,actor_id) VALUES($1,$2,7,1,$3,$4,$5)',
    [branch, f.org, payload, sum, actor],
  );
  await f.pool.query(
    'INSERT INTO catalog_branch_heads(branch_id,organization_id,draft_revision,published_version) VALUES($1,$2,1,7)',
    [branch, f.org],
  );
  await f.pool.query(
    'INSERT INTO menu_releases(id,branch_id,version,schema_version,payload,checksum,published_at) VALUES($1,$2,6,1,$3,$4,now())',
    [
      release,
      branch,
      { release_id: release, branch_id: branch, version: 6, schema_version: 1, items: [] },
      sum,
    ],
  );
  await f.pool.query(
    'INSERT INTO catalog_menu_deliveries(branch_id,catalog_version,release_id,device_id) VALUES($1,7,$2,$3)',
    [branch, release, edge],
  );
  const { execFileSync } = await import('node:child_process');
  const sql = execFileSync(
    'python3',
    [
      '-c',
      "import importlib.util,sys;s=importlib.util.spec_from_file_location('c','infra/staging/continue-unified-menu.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.menu_head_sql(sys.argv[1]))",
      branch,
    ],
    { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' },
  );
  const read = async () => Object.values((await f.pool.query(sql)).rows[0])[0];
  let result = await read();
  assert.equal(result.applied, false);
  assert.equal(result.activated, false);
  await f.pool.query(
    "INSERT INTO catalog_menu_delivery_results(branch_id,release_id,result) VALUES($1,$2,'applied')",
    [branch, release],
  );
  result = await read();
  assert.equal(result.applied, true);
  assert.equal(result.activated, false);
  await f.pool.query(
    'INSERT INTO branch_menu_activations(branch_id,release_id,acknowledged_at) VALUES($1,$2,now())',
    [branch, release],
  );
  assert.deepEqual(await read(), {
    release_id: release,
    version: 6,
    checksum: sum,
    device_id: edge,
    catalog_version: 7,
    applied: true,
    activated: true,
  });
  assert.equal(
    Object.values((await f.pool.query(sql.replaceAll(branch, randomUUID()))).rows[0])[0],
    null,
  );
});
