import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, migrate } from '@pickchick/database';
import { loadConfig } from '@pickchick/platform';
import {
  REGISTRY_MIGRATION,
  REGISTRY_PRIVILEGES,
  deployRegistry,
  inspectRegistry,
} from '../../infra/staging/device-registry-owner.mjs';
import { OwnerGuardError } from '../../infra/staging/unified-menu-owner.mjs';

const MIGRATIONS = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));
const REAL_051 = join(MIGRATIONS, REGISTRY_MIGRATION);
const REAL_GRANTS = fileURLToPath(
  new URL('../../infra/staging/device-registry-grants.mjs', import.meta.url),
);

/**
 * Synthetic 051 of the same additive shape, used to exercise the refusal paths (changed old
 * data, extra privileges) without editing the reviewed file; the last test runs the real 051.
 */
const SYNTHETIC_051 = `
ALTER TABLE devices
  ADD COLUMN role text CHECK (role IN ('edge','pos','kiosk','kitchen_prep','kitchen_assembly','board')),
  ADD COLUMN kiosk_device_id uuid UNIQUE REFERENCES kiosk_devices(id),
  ADD COLUMN edge_terminal_id uuid UNIQUE,
  ADD COLUMN last_seen_at timestamptz,
  ADD COLUMN app_version text CHECK (length(app_version) <= 64),
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by uuid,
  ADD COLUMN created_by uuid;
UPDATE devices SET role = CASE kind WHEN 'display' THEN 'board' WHEN 'kitchen' THEN 'kitchen_prep' ELSE kind END;
CREATE TABLE device_pairing_codes (
  id uuid PRIMARY KEY, device_id uuid NOT NULL REFERENCES devices(id), code_hash bytea NOT NULL,
  state text NOT NULL DEFAULT 'open', failed_attempts integer NOT NULL DEFAULT 0,
  consumed_at timestamptz, consumed_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at <= created_at + interval '15 minutes'));
CREATE TABLE device_events (
  id uuid PRIMARY KEY, device_id uuid NOT NULL REFERENCES devices(id), action text NOT NULL,
  at timestamptz NOT NULL DEFAULT now());
`;
const syntheticGrants = (role) =>
  `REVOKE ALL ON device_pairing_codes, device_events FROM ${role};
   GRANT SELECT, INSERT ON device_pairing_codes, device_events TO ${role};
   GRANT UPDATE(state, failed_attempts, consumed_at, consumed_request_id) ON device_pairing_codes TO ${role};
   GRANT INSERT, UPDATE(name, status, revoked_at, revoked_by, last_seen_at, app_version) ON devices TO ${role};
   GRANT SELECT, INSERT, UPDATE(active) ON kiosk_devices TO ${role};
   GRANT SELECT, INSERT, UPDATE(active) ON kiosk_enrollment_aliases TO ${role};
   GRANT SELECT(device_id, expires_at) ON device_credentials TO ${role};
   GRANT SELECT ON kiosk_sessions TO ${role};`;

async function directory(t, { migration = SYNTHETIC_051, upTo = '050_z', extra } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'registry-migrations-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of (await readdir(MIGRATIONS)).filter((n) => n.endsWith('.sql')).sort())
    if (name <= upTo) await copyFile(join(MIGRATIONS, name), join(dir, name));
  if (migration !== null && upTo === '050_z')
    await writeFile(join(dir, REGISTRY_MIGRATION), migration);
  if (extra) await writeFile(join(dir, extra), 'SELECT 1;\n');
  return dir;
}

/** Cloud schema at 050 (the installed kiosk-incident API) with data and a restricted role. */
async function baseline(t) {
  const config = loadConfig('api');
  const admin = createPool(config.databaseUrl);
  const schema = `dr_${randomUUID().replaceAll('-', '')}`;
  const role = `dr_app_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
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
  await migrate(pool, await directory(t, { migration: null }), 'cloud');
  const org = randomUUID(),
    legal = randomUUID(),
    branch = randomUUID(),
    device = randomUUID();
  await pool.query("INSERT INTO organizations(id,name) VALUES ($1,'Registry synthetic')", [org]);
  await pool.query(
    "INSERT INTO legal_entities(id,organization_id,name,bin) VALUES ($1,$2,'Registry synthetic','000000000000')",
    [legal, org],
  );
  await pool.query(
    "INSERT INTO branches(id,organization_id,legal_entity_id,code,name) VALUES ($1,$2,$3,'DR','Synthetic')",
    [branch, org, legal],
  );
  await pool.query(
    "INSERT INTO devices(id,branch_id,organization_id,kind,name,status) VALUES ($1,$2,$3,'edge','Synthetic edge','active')",
    [device, branch, org],
  );
  // Pre-existing runtime privileges that 051 must keep (UPDATE(status) comes from backoffice).
  await pool.query(
    `GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT ON branches, devices TO ${role};
     GRANT UPDATE(status) ON devices TO ${role}`,
  );
  return { pool, role, device };
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

test('owner step applies exactly 051, adds only reviewed privileges and keeps existing data', async (t) => {
  const db = await baseline(t);
  const dir = await directory(t);
  const plan = await inTransaction(db.pool, (c) =>
    inspectRegistry(c, { directory: dir, role: db.role }),
  );
  assert.deepEqual(plan.pending, [REGISTRY_MIGRATION]);
  assert.ok(plan.missingPrivileges.includes('device_events||SELECT'));
  assert.ok(!plan.missingPrivileges.includes('devices|status|UPDATE'));
  const result = await inTransaction(db.pool, (c) =>
    deployRegistry(c, { directory: dir, role: db.role, grants: syntheticGrants }),
  );
  assert.deepEqual(result.applied, [REGISTRY_MIGRATION]);
  assert.deepEqual(
    result.privilegesAdded,
    REGISTRY_PRIVILEGES.filter((p) => p !== 'devices|status|UPDATE'),
  );
  assert.equal(result.existingDataPreserved, true);
  const device = await db.pool.query('SELECT name,status,role FROM devices WHERE id=$1', [
    db.device,
  ]);
  assert.deepEqual(device.rows[0], { name: 'Synthetic edge', status: 'active', role: 'edge' });
  // Replay after a lost reply is a verified no-op.
  const again = await inTransaction(db.pool, (c) =>
    deployRegistry(c, { directory: dir, role: db.role, grants: syntheticGrants }),
  );
  assert.deepEqual(again.applied, []);
  assert.equal(again.resumed, true);
});

test('owner step refuses changed old data, extra privileges and unexpected migrations', async (t) => {
  const db = await baseline(t);
  const rename = await directory(t, {
    migration: SYNTHETIC_051 + "UPDATE devices SET name='Changed';",
  });
  await assert.rejects(
    inTransaction(db.pool, (c) =>
      deployRegistry(c, { directory: rename, role: db.role, grants: syntheticGrants }),
    ),
    (e) => e instanceof OwnerGuardError && /Pre-existing data changed: devices/.test(e.message),
  );
  const dir = await directory(t);
  await assert.rejects(
    inTransaction(db.pool, (c) =>
      deployRegistry(c, {
        directory: dir,
        role: db.role,
        grants: (role) => syntheticGrants(role) + `GRANT DELETE ON devices TO ${role};`,
      }),
    ),
    (e) => e instanceof OwnerGuardError && /Unreviewed runtime privilege/.test(e.message),
  );
  await assert.rejects(
    inTransaction(db.pool, (c) =>
      deployRegistry(c, {
        directory: dir,
        role: db.role,
        grants: (role) => syntheticGrants(role) + `REVOKE SELECT ON branches FROM ${role};`,
      }),
    ),
    (e) => e instanceof OwnerGuardError && /removed/.test(e.message),
  );
  const extra = await directory(t, { extra: '052_cloud_unreviewed.sql' });
  await assert.rejects(
    inTransaction(db.pool, (c) =>
      deployRegistry(c, { directory: extra, role: db.role, grants: syntheticGrants }),
    ),
    (e) => e instanceof OwnerGuardError && /end with 051/.test(e.message),
  );
  await db.pool.query(
    "UPDATE schema_migrations SET checksum=repeat('0',64) WHERE version='050_cloud_kiosk_payment_incidents.sql'",
  );
  await assert.rejects(
    inTransaction(db.pool, (c) =>
      deployRegistry(c, { directory: dir, role: db.role, grants: syntheticGrants }),
    ),
    (e) => e instanceof OwnerGuardError && /ledger/.test(e.message),
  );
  assert.equal(
    (await db.pool.query("SELECT to_regclass('device_events') IS NULL AS absent")).rows[0].absent,
    true,
  );
});

test(
  'reviewed 051 and its grant module pass the owner step',
  { skip: !(existsSync(REAL_051) && existsSync(REAL_GRANTS)) && 'reviewed 051 missing' },
  async (t) => {
    const db = await baseline(t);
    const dir = await directory(t, { upTo: '051_z', migration: null });
    const plan = await inTransaction(db.pool, (c) =>
      inspectRegistry(c, { directory: dir, role: db.role }),
    );
    assert.deepEqual(plan.pending, [REGISTRY_MIGRATION]);
    const result = await inTransaction(db.pool, (c) =>
      deployRegistry(c, { directory: dir, role: db.role }),
    );
    assert.deepEqual(result.applied, [REGISTRY_MIGRATION]);
    assert.equal(result.checksum, plan.checksum);
    assert.equal(result.existingDataPreserved, true);
    // The real grant module adds exactly the reviewed list (UPDATE(status) was already held).
    assert.deepEqual(
      result.privilegesAdded,
      REGISTRY_PRIVILEGES.filter((p) => p !== 'devices|status|UPDATE'),
    );
    const device = await db.pool.query('SELECT name,status,role FROM devices WHERE id=$1', [
      db.device,
    ]);
    assert.deepEqual(device.rows[0], { name: 'Synthetic edge', status: 'active', role: 'edge' });
    // The ledger row is what @pickchick/database migrate() would have written.
    const ledger = await db.pool.query(
      'SELECT checksum,scope FROM schema_migrations WHERE version=$1',
      [REGISTRY_MIGRATION],
    );
    assert.deepEqual(ledger.rows[0], { checksum: plan.checksum, scope: 'cloud' });
    const again = await inTransaction(db.pool, (c) =>
      deployRegistry(c, { directory: dir, role: db.role }),
    );
    assert.equal(again.resumed, true);
  },
);
