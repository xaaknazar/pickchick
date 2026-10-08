import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import { backofficeGrants } from '../../infra/staging/backoffice-grants.mjs';
import { catalogAdminGrants } from '../../infra/staging/catalog-admin-grants.mjs';
import {
  OwnerGuardError,
  UNIFIED_MENU_MIGRATIONS,
  UNIFIED_MENU_TABLES,
  deployUnifiedMenu,
  inspectUnifiedMenu,
  setUnifiedMenuFlag,
} from '../../infra/staging/unified-menu-owner.mjs';

const MIGRATIONS = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));

/** A migration directory: the real files, optionally only up to 044 or with an edit. */
async function directory(t, { upTo, edit } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'um-migrations-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql')).sort()) {
    if (upTo && name > upTo) continue;
    await copyFile(join(MIGRATIONS, name), join(dir, name));
  }
  if (edit) await edit(dir);
  return dir;
}

/** Cloud schema at 044 with synthetic data and a restricted runtime role like production. */
async function baseline(t) {
  const config = loadConfig('api');
  const admin = createPool(config.databaseUrl);
  const schema = `um_${randomUUID().replaceAll('-', '')}`;
  const role = `um_app_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`CREATE ROLE ${role} NOLOGIN`);
  const url = new URL(config.databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(url.toString());
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.query(`DROP OWNED BY ${role}`).catch(() => {});
    await admin.query(`DROP ROLE ${role}`);
    await admin.end();
  });
  await migrate(pool, await directory(t, { upTo: '044_' + 'z' }), 'cloud');
  const org = randomUUID(),
    legal = randomUUID(),
    branch = randomUUID(),
    device = randomUUID(),
    manager = randomUUID(),
    analyst = randomUUID();
  await pool.query("INSERT INTO organizations(id,name) VALUES ($1,'UM synthetic')", [org]);
  await pool.query(
    "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES ($1,$2,'UM synthetic','000000000000')",
    [legal, org],
  );
  await pool.query(
    "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES ($1,$2,$3,'UM','Synthetic')",
    [branch, org, legal],
  );
  await pool.query(
    "INSERT INTO devices(id,branch_id,organization_id,kind,name) VALUES ($1,$2,$3,'edge','Synthetic')",
    [device, branch, org],
  );
  await pool.query(
    "INSERT INTO cloud_branch_availability(branch_id,device_id,revision,stopped_ids) VALUES ($1,$2,7,'{}')",
    [branch, device],
  );
  for (const [id, name] of [
    [manager, 'Synthetic manager'],
    [analyst, 'Synthetic analyst'],
  ]) {
    await pool.query(
      'INSERT INTO catalog_managers(id,organization_id,name,token_hash) VALUES ($1,$2,$3,$4)',
      [id, org, name, randomUUID().replaceAll('-', '').repeat(2)],
    );
    await pool.query(
      'INSERT INTO catalog_manager_branches(actor_id,organization_id,branch_id) VALUES ($1,$2,$3)',
      [id, org, branch],
    );
  }
  await pool.query(
    "INSERT INTO bo_access_grants(actor_id,branch_id,role) VALUES ($1,$2,'manager')",
    [manager, branch],
  );
  // Production runtime before the release: catalog admin, back-office and transport heartbeat.
  await pool.query(catalogAdminGrants(role, true));
  await pool.query(backofficeGrants(role, true));
  await pool.query(`GRANT SELECT,INSERT,UPDATE ON cloud_branch_availability TO ${role}`);
  return { pool, role, branch, device, analyst, url: url.toString() };
}

async function inTransaction(pool, run) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('deploy applies 045-047 with flags off, proves data kept under a live heartbeat', async (t) => {
  const db = await baseline(t);
  const dir = await directory(t);
  const before = await inTransaction(db.pool, (c) => inspectUnifiedMenu(c, { directory: dir }));
  assert.deepEqual(before, {
    pending: UNIFIED_MENU_MIGRATIONS,
    migrationFiles: 46,
    managersWithoutGrant: 1,
  });
  const client = await db.pool.connect();
  let result;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query('SELECT 1'); // Snapshot taken; a heartbeat then commits concurrently.
    await db.pool.query(
      'UPDATE cloud_branch_availability SET revision=revision+1, observed_at=clock_timestamp() WHERE branch_id=$1',
      [db.branch],
    );
    result = await deployUnifiedMenu(client, { directory: dir, role: db.role });
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  assert.deepEqual(result.applied, UNIFIED_MENU_MIGRATIONS);
  assert.equal(result.migrationFiles, 46);
  assert.equal(result.lastMigration, '047_cloud_catalog_assets.sql');
  assert.deepEqual(result.createdTables, [...UNIFIED_MENU_TABLES].sort());
  assert.equal(result.transportGrants, true);
  assert.ok(result.preservedTables > 100);
  assert.deepEqual(result.privilegesRemoved, []);
  assert.deepEqual(
    result.privilegesAdded,
    [
      'catalog_asset_variants||SELECT',
      'catalog_assets||SELECT',
      'catalog_menu_delivery_results||INSERT',
      'catalog_menu_delivery_results||SELECT',
      'cloud_stop_commands||SELECT',
      'cloud_stop_commands|delivered_at|UPDATE',
      'cloud_stop_commands|resolved_at|UPDATE',
      'cloud_stop_commands|result_version|UPDATE',
      'cloud_stop_commands|state|UPDATE',
      'edge_menu_state||INSERT',
      'edge_menu_state||SELECT',
      'edge_menu_state|active_release_id|UPDATE',
      'edge_menu_state|active_version|UPDATE',
      'edge_menu_state|observed_at|UPDATE',
    ].sort(),
  );
  // The concurrent heartbeat survived and the new column stays empty.
  const row = (
    await db.pool.query(
      'SELECT revision, stop_states FROM cloud_branch_availability WHERE branch_id=$1',
      [db.branch],
    )
  ).rows[0];
  assert.deepEqual(row, { revision: '8', stop_states: null });
  // Idempotent: a second run applies and grants nothing.
  const again = await inTransaction(db.pool, (c) =>
    deployUnifiedMenu(c, { directory: dir, role: db.role }),
  );
  assert.deepEqual(
    [again.applied, again.createdTables, again.privilegesAdded, again.privilegesRemoved],
    [[], [], [], []],
  );
  // Coverage counts only unrevoked managers.
  await db.pool.query('UPDATE catalog_managers SET revoked_at=now() WHERE id=$1', [db.analyst]);
  assert.equal(
    (await inTransaction(db.pool, (c) => inspectUnifiedMenu(c, { directory: dir })))
      .managersWithoutGrant,
    0,
  );
});

test('each flag grants and revokes exactly its own privileges', async (t) => {
  const db = await baseline(t);
  const dir = await directory(t);
  await assert.rejects(
    inTransaction(db.pool, (c) =>
      setUnifiedMenuFlag(c, { role: db.role, flag: 'remote-stops', enabled: true }),
    ),
    (error) => error instanceof OwnerGuardError && /not the installed head/.test(error.message),
  );
  await inTransaction(db.pool, (c) => deployUnifiedMenu(c, { directory: dir, role: db.role }));
  const flag = (name, enabled) =>
    inTransaction(db.pool, (c) => setUnifiedMenuFlag(c, { role: db.role, flag: name, enabled }));
  // Back-office already reads bo_access_grants and locks lock_anchor: nothing new to grant.
  assert.deepEqual((await flag('access-roles', true)).privilegesAdded, []);
  assert.deepEqual(await flag('remote-stops', true), {
    flag: 'remote-stops',
    enabled: true,
    privilegesAdded: ['cloud_stop_commands||INSERT'],
    privilegesRemoved: [],
  });
  assert.deepEqual((await flag('remote-stops', false)).privilegesRemoved, [
    'cloud_stop_commands||INSERT',
  ]);
  const media = await flag('media-upload', true);
  assert.deepEqual(media.privilegesAdded, [
    'catalog_asset_audit||INSERT',
    'catalog_asset_audit||SELECT',
    'catalog_asset_variants||INSERT',
    'catalog_assets||INSERT',
  ]);
  assert.deepEqual(media.privilegesRemoved, []);
  const off = await flag('media-upload', false);
  assert.deepEqual(off.privilegesRemoved, media.privilegesAdded);
  assert.deepEqual(off.privilegesAdded, []);
  await assert.rejects(flag('edge-publication', true), OwnerGuardError);
  // Remote stops need the fulfillment transport on the runtime role.
  await db.pool.query(`REVOKE UPDATE ON cloud_branch_availability FROM ${db.role}`);
  await assert.rejects(flag('remote-stops', true), /fulfillment transport/);
});

test('ledger drift, unreviewed migrations and data edits are refused and rolled back', async (t) => {
  const db = await baseline(t);
  const ledger = async () =>
    (await db.pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.length;
  const extra = await directory(t, {
    edit: (dir) => writeFile(join(dir, '048_cloud_unreviewed.sql'), 'SELECT 1;'),
  });
  await assert.rejects(
    inTransaction(db.pool, (c) => deployUnifiedMenu(c, { directory: extra, role: db.role })),
    /not exactly the reviewed unified-menu set/,
  );
  const edited = await directory(t, {
    edit: async (dir) => {
      const file = join(dir, '047_cloud_catalog_assets.sql');
      await writeFile(
        file,
        (await readFile(file, 'utf8')) + "\nUPDATE branches SET name = name || ' changed';\n",
      );
    },
  });
  await assert.rejects(
    inTransaction(db.pool, (c) => deployUnifiedMenu(c, { directory: edited, role: db.role })),
    /Pre-existing data changed: branches/,
  );
  const changed = await directory(t, {
    edit: async (dir) => {
      const file = join(dir, '030_cloud_branch_availability.sql');
      await writeFile(file, (await readFile(file, 'utf8')) + '\n-- edited\n');
    },
  });
  await assert.rejects(
    inTransaction(db.pool, (c) => deployUnifiedMenu(c, { directory: changed, role: db.role })),
    /ledger differs/,
  );
  assert.equal(await ledger(), 43); // 001-044 has 43 files (041 was never used).
  assert.equal(
    (await db.pool.query("SELECT to_regclass('cloud_stop_commands') IS NULL AS absent")).rows[0]
      .absent,
    true,
  );
});
