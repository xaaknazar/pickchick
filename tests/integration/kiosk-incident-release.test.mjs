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
  INCIDENT_MIGRATION,
  INCIDENT_TABLE,
  deployIncident,
  inspectIncident,
} from '../../infra/staging/kiosk-incident-owner.mjs';
import { OwnerGuardError } from '../../infra/staging/unified-menu-owner.mjs';

const MIGRATIONS = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));

async function directory(t, { upTo = '050_z', extra } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'incident-migrations-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql')).sort())
    if (name <= upTo) await copyFile(join(MIGRATIONS, name), join(dir, name));
  if (extra) await writeFile(join(dir, extra), 'SELECT 1;\n');
  return dir;
}

/** Cloud schema at 049 (the installed unified-menu API) with data and a restricted role. */
async function baseline(t) {
  const config = loadConfig('api');
  const admin = createPool(config.databaseUrl);
  const schema = `ki_${randomUUID().replaceAll('-', '')}`;
  const role = `ki_app_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
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
  await migrate(pool, await directory(t, { upTo: '049_z' }), 'cloud');
  const org = randomUUID(),
    legal = randomUUID(),
    branch = randomUUID();
  await pool.query("INSERT INTO organizations(id,name) VALUES ($1,'Incident synthetic')", [org]);
  await pool.query(
    "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES ($1,$2,'Incident synthetic','000000000000')",
    [legal, org],
  );
  await pool.query(
    "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES ($1,$2,$3,'KI','Synthetic')",
    [branch, org, legal],
  );
  await pool.query(
    `GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT ON branches TO ${role}`,
  );
  return { pool, role, branch };
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

test('owner step applies exactly 050, grants SELECT,INSERT and keeps existing data', async (t) => {
  const db = await baseline(t);
  const dir = await directory(t);
  const plan = await inTransaction(db.pool, (c) =>
    inspectIncident(c, { directory: dir, role: db.role }),
  );
  assert.deepEqual(plan.pending, [INCIDENT_MIGRATION]);
  assert.deepEqual(plan.runtimePrivileges, []);
  const result = await inTransaction(db.pool, (c) =>
    deployIncident(c, { directory: dir, role: db.role }),
  );
  assert.deepEqual(result.applied, [INCIDENT_MIGRATION]);
  assert.deepEqual(result.privilegesAdded, [
    `${INCIDENT_TABLE}||INSERT`,
    `${INCIDENT_TABLE}||SELECT`,
  ]);
  assert.equal(result.existingDataPreserved, true);
  assert.equal((await db.pool.query(`SELECT count(*)::int n FROM ${INCIDENT_TABLE}`)).rows[0].n, 0);
  assert.equal(
    (await db.pool.query('SELECT count(*)::int n FROM branches WHERE id=$1', [db.branch])).rows[0]
      .n,
    1,
  );
  // Replay after a lost reply is a verified no-op.
  const again = await inTransaction(db.pool, (c) =>
    deployIncident(c, { directory: dir, role: db.role }),
  );
  assert.deepEqual(again.applied, []);
  assert.equal(again.resumed, true);
});

test('owner step refuses unexpected or out-of-order migrations and changed history', async (t) => {
  const db = await baseline(t);
  const extra = await directory(t, { extra: '051_cloud_unreviewed.sql' });
  await assert.rejects(
    inTransaction(db.pool, (c) => deployIncident(c, { directory: extra, role: db.role })),
    (e) => e instanceof OwnerGuardError && /end with 050/.test(e.message),
  );
  const short = await directory(t, { upTo: '049_z' });
  await assert.rejects(
    inTransaction(db.pool, (c) => deployIncident(c, { directory: short, role: db.role })),
    OwnerGuardError,
  );
  const dir = await directory(t);
  await db.pool.query(
    "UPDATE schema_migrations SET checksum=repeat('0',64) WHERE version='049_cloud_catalog_assets.sql'",
  );
  await assert.rejects(
    inTransaction(db.pool, (c) => deployIncident(c, { directory: dir, role: db.role })),
    (e) => e instanceof OwnerGuardError && /ledger/.test(e.message),
  );
  assert.equal(
    (
      await db.pool.query(
        "SELECT to_regclass('commerce_kiosk_payment_incidents') IS NULL AS absent",
      )
    ).rows[0].absent,
    true,
  );
});
