/* global structuredClone */
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
import { CatalogAdmin, provisionCatalogManager } from '../../packages/catalog-admin/dist/index.js';
import {
  OwnerGuardError,
  UNIFIED_MENU_MIGRATIONS,
  UNIFIED_MENU_TABLES,
  deployUnifiedMenu,
  inspectUnifiedMenu,
  setUnifiedMenuFlag,
  runtimePrivileges,
} from '../../infra/staging/unified-menu-owner.mjs';

const MIGRATIONS = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));

/** A migration directory: the real files up to 049 (or an earlier bound), optionally with an edit. */
// The unified-menu release ends at 049; later migrations belong to later releases.
async function directory(t, { upTo = '049_z', edit } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'um-migrations-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql')).sort()) {
    if (upTo && name > upTo) continue;
    await copyFile(join(MIGRATIONS, name), join(dir, name));
  }
  if (edit) await edit(dir);
  return dir;
}

/**
 * Cloud schema at 046 (the live kiosk QR schema) with synthetic data and a restricted runtime
 * role like production.
 */
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
  await migrate(pool, await directory(t, { upTo: '046_' + 'z' }), 'cloud');
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
  await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role};
    GRANT SELECT ON menu_releases,menu_streams,outbox_events,catalog_menu_deliveries,
      branch_menu_activations,inbox_messages TO ${role};
    GRANT UPDATE(id) ON branches,devices TO ${role};`);
  return { pool, role, org, branch, device, analyst, url: url.toString() };
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

test('deploy applies 047-049 with flags off, proves data kept under a live heartbeat', async (t) => {
  const db = await baseline(t);
  const dir = await directory(t);
  const before = await inTransaction(db.pool, (c) => inspectUnifiedMenu(c, { directory: dir }));
  assert.deepEqual(before, {
    pending: UNIFIED_MENU_MIGRATIONS,
    migrationFiles: 48,
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
  assert.equal(result.migrationFiles, 48);
  assert.equal(result.lastMigration, '049_cloud_catalog_assets.sql');
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
  assert.deepEqual(
    (await flag('edge-publication', true)).privilegesAdded,
    [
      'catalog_menu_deliveries||INSERT',
      'menu_releases||INSERT',
      'menu_streams|last_sequence|UPDATE',
      'menu_streams||INSERT',
      'outbox_events||INSERT',
    ].sort(),
  );
  assert.deepEqual((await flag('edge-publication', false)).privilegesRemoved, []);
  // Remote stops need the fulfillment transport on the runtime role.
  await db.pool.query(`REVOKE UPDATE ON cloud_branch_availability FROM ${db.role}`);
  await assert.rejects(flag('remote-stops', true), /fulfillment transport/);
});

test('release grants let the restricted API publish atomically, replay and retain delivery reads when disabled', async (t) => {
  const db = await baseline(t);
  const dir = await directory(t);
  await inTransaction(db.pool, (c) => deployUnifiedMenu(c, { directory: dir, role: db.role }));
  const manager = await provisionCatalogManager(db.pool, {
    organization_id: db.org,
    name: 'Publication regression',
    branch_ids: [db.branch],
  });
  await db.pool.query("UPDATE devices SET status='active' WHERE id=$1", [db.device]);
  await db.pool.query(
    "INSERT INTO bo_access_grants(actor_id,branch_id,role) VALUES($1,$2,'manager')",
    [manager.actor_id, db.branch],
  );
  await db.pool.query(
    'INSERT INTO edge_menu_state(branch_id,device_id,active_release_id,active_version) VALUES($1,$2,$3,2)',
    [db.branch, db.device, randomUUID()],
  );
  await db.pool.query(
    'INSERT INTO fulfillment_transport_bindings(branch_id,organization_id,device_id,producer_id) VALUES($1,$2,$3,$4)',
    [db.branch, db.org, db.device, randomUUID()],
  );
  const options = { enabled: true, enforceRoles: true, edgePublicationBranchId: db.branch };
  const ownerService = new CatalogAdmin(db.pool, options);
  let state = await ownerService.seed(manager.token, db.branch, {
    expected_revision: 0,
    request_id: randomUUID(),
  });
  const payload = structuredClone(state.draft.payload);
  payload.content_reviewed = true;
  state = await ownerService.save(manager.token, db.branch, {
    expected_revision: state.draft.revision,
    request_id: randomUUID(),
    payload,
  });
  const url = new URL(db.url);
  url.searchParams.set('options', url.searchParams.get('options') + ` -c role=${db.role}`);
  const runtime = createPool(url.toString(), 2);
  try {
    const service = new CatalogAdmin(runtime, options);
    const request = {
      expected_revision: state.draft.revision,
      expected_published_version: 0,
      request_id: randomUUID(),
      confirmation: 'publish_catalog',
    };
    // This is the production failure: owner migrations passed, but the API cannot INSERT a release.
    await assert.rejects(
      service.publish(manager.token, db.branch, request),
      (e) => e.code === '42501',
    );
    for (const table of [
      'catalog_publications',
      'menu_releases',
      'menu_streams',
      'outbox_events',
      'catalog_menu_deliveries',
    ])
      assert.equal((await db.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
    const failed = await ownerService.read(manager.token, db.branch);
    assert.equal(failed.draft.revision, state.draft.revision);
    assert.equal(failed.published, null);
    assert.equal(
      (
        await db.pool.query(
          'SELECT count(*)::int n FROM catalog_command_receipts WHERE request_id=$1',
          [request.request_id],
        )
      ).rows[0].n,
      0,
    );
    const before = await runtimePrivileges(db.pool, db.role);
    const result = await inTransaction(db.pool, (c) =>
      setUnifiedMenuFlag(c, { role: db.role, flag: 'edge-publication', enabled: true }),
    );
    assert.deepEqual(result.privilegesRemoved, []);
    assert.deepEqual(
      result.privilegesAdded,
      [
        'catalog_menu_deliveries||INSERT',
        'menu_releases||INSERT',
        'menu_streams|last_sequence|UPDATE',
        'menu_streams||INSERT',
        'outbox_events||INSERT',
      ].sort(),
    );
    const published = await service.publish(manager.token, db.branch, request);
    assert.equal(published.published.version, 1);
    assert.equal(published.edge_delivery.status, 'pending');
    assert.equal(published.edge_delivery.menu_version, 3);
    assert.deepEqual(await service.publish(manager.token, db.branch, request), published);
    assert.equal(
      (
        await db.pool.query(
          'SELECT count(*)::int n FROM catalog_command_receipts WHERE request_id=$1',
          [request.request_id],
        )
      ).rows[0].n,
      1,
    );
    for (const table of [
      'catalog_publications',
      'menu_releases',
      'menu_streams',
      'outbox_events',
      'catalog_menu_deliveries',
    ])
      assert.equal((await db.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 1);
    assert.equal(
      (await db.pool.query('SELECT last_sequence FROM menu_streams')).rows[0].last_sequence,
      '1',
    );
    for (const sql of [
      'UPDATE menu_releases SET version=version',
      'DELETE FROM menu_releases',
      'UPDATE menu_streams SET producer_id=producer_id',
      'UPDATE outbox_events SET payload=payload',
      'DELETE FROM catalog_menu_deliveries',
      'CREATE TABLE forbidden(id integer)',
    ])
      await assert.rejects(runtime.query(sql), (e) => e.code === '42501');
    await inTransaction(db.pool, (c) =>
      setUnifiedMenuFlag(c, { role: db.role, flag: 'edge-publication', enabled: false }),
    );
    assert.deepEqual(
      await runtimePrivileges(db.pool, db.role),
      [...before, ...result.privilegesAdded].sort(),
    );
    assert.equal((await service.read(manager.token, db.branch)).edge_delivery.status, 'pending');
  } finally {
    await runtime.end();
  }
});

test('publication grant step refuses missing read or row-lock baseline without adding writes', async (t) => {
  const db = await baseline(t);
  const dir = await directory(t);
  await inTransaction(db.pool, (c) => deployUnifiedMenu(c, { directory: dir, role: db.role }));
  const enable = () =>
    inTransaction(db.pool, (c) =>
      setUnifiedMenuFlag(c, { role: db.role, flag: 'edge-publication', enabled: true }),
    );
  await db.pool.query(`REVOKE SELECT ON menu_releases FROM ${db.role}`);
  await assert.rejects(enable(), /read grant missing: menu_releases/);
  await db.pool.query(
    `GRANT SELECT ON menu_releases TO ${db.role}; REVOKE UPDATE(id) ON branches FROM ${db.role}`,
  );
  await assert.rejects(enable(), /row-lock grant missing: branches/);
  assert.equal(
    (await runtimePrivileges(db.pool, db.role)).includes('menu_releases||INSERT'),
    false,
  );
});

test('ledger drift, unreviewed migrations and data edits are refused and rolled back', async (t) => {
  const db = await baseline(t);
  const ledger = async () =>
    (await db.pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.length;
  const extra = await directory(t, {
    edit: (dir) => writeFile(join(dir, '050_cloud_unreviewed.sql'), 'SELECT 1;'),
  });
  await assert.rejects(
    inTransaction(db.pool, (c) => deployUnifiedMenu(c, { directory: extra, role: db.role })),
    /not exactly the reviewed unified-menu set/,
  );
  const edited = await directory(t, {
    edit: async (dir) => {
      const file = join(dir, '049_cloud_catalog_assets.sql');
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
  assert.equal(await ledger(), 45); // 001-046 has 45 files (041 was never used).
  assert.equal(
    (await db.pool.query("SELECT to_regclass('cloud_stop_commands') IS NULL AS absent")).rows[0]
      .absent,
    true,
  );
});
