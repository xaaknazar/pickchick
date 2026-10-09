#!/usr/bin/env node
/**
 * Owner step of the device registry release (cloud051). Run inside the provision container of
 * the candidate release with the owner database URL:
 *
 *   node infra/staging/device-registry-owner.mjs inspect
 *   node infra/staging/device-registry-owner.mjs deploy
 *
 * deploy applies exactly 051 and the device-registry runtime grants in ONE repeatable-read
 * transaction. It proves that every pre-existing table kept its columns (only `devices` may gain
 * the reviewed nullable columns, appended after the old ones) and its rows over the old columns
 * (by content hash), that the two new tables are empty, that no runtime privilege was removed and
 * that exactly the reviewed privileges were added. inspect only reports the plan.
 * See docs/operations/backoffice-devices.md and ADR 0013.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, runtimePrivileges, OwnerGuardError } from './unified-menu-owner.mjs';

export const REGISTRY_MIGRATION = '051_cloud_device_registry.sql';
export const REGISTRY_NEW_TABLES = Object.freeze(['device_events', 'device_pairing_codes']);
/** Nullable columns db/cloud/migrations/051 appends to `devices` (checked against the file). */
export const REGISTRY_DEVICE_COLUMNS = Object.freeze([
  'role',
  'kiosk_device_id',
  'edge_terminal_id',
  'last_seen_at',
  'app_version',
  'revoked_at',
  'revoked_by',
  'created_by',
]);
/**
 * Runtime privileges the API must hold after 051 (`table|column|PRIVILEGE`): exactly
 * DEVICE_REGISTRY_ACL of device-registry-grants.mjs. Rows on existing tables may already be
 * present; rows on the new tables must match exactly. Kept in sync with REQUIRED_ACL in
 * release-device-registry.py and with the grant module (checked by its unit test).
 */
export const REGISTRY_PRIVILEGES = Object.freeze(
  [
    'device_credentials|device_id|SELECT',
    'device_credentials|expires_at|SELECT',
    'device_events||INSERT',
    'device_events||SELECT',
    'device_pairing_codes||INSERT',
    'device_pairing_codes||SELECT',
    'device_pairing_codes|consumed_at|UPDATE',
    'device_pairing_codes|consumed_request_id|UPDATE',
    'device_pairing_codes|failed_attempts|UPDATE',
    'device_pairing_codes|state|UPDATE',
    'devices||INSERT',
    'devices|app_version|UPDATE',
    'devices|last_seen_at|UPDATE',
    'devices|name|UPDATE',
    'devices|revoked_at|UPDATE',
    'devices|revoked_by|UPDATE',
    'devices|status|UPDATE',
    'kiosk_devices||INSERT',
    'kiosk_devices||SELECT',
    'kiosk_devices|active|UPDATE',
    // MVP kiosk pairing issues a cloud044 alias from the back office.
    'kiosk_enrollment_aliases||INSERT',
    'kiosk_enrollment_aliases||SELECT',
    'kiosk_enrollment_aliases|active|UPDATE',
    'kiosk_sessions||SELECT',
  ].sort(),
);
const MIGRATION_LOCK = 724001; // Same advisory lock as @pickchick/database migrate().
const ROLE = /^[a-z][a-z0-9_]{0,62}$/;
const guard = (condition, message) => {
  if (!condition) throw new OwnerGuardError(message);
};
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const onNewTable = (p) => REGISTRY_NEW_TABLES.includes(p.split('|')[0]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function tableColumns(client) {
  const { rows } = await client.query(
    `SELECT c.relname AS name, coalesce(array_agg(a.attname::text ORDER BY a.attnum) FILTER (WHERE a.attnum>0), '{}'::text[]) AS columns
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname=current_schema() AND c.relkind IN ('r','p')
      GROUP BY c.relname ORDER BY c.relname`,
  );
  return Object.fromEntries(rows.map((r) => [r.name, r.columns]));
}

/** Ledger must be every earlier file with matching checksums; only 051 may be pending. */
export async function registryPlan(client, directory) {
  const files = (await readdir(directory)).filter((n) => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort();
  guard(files.at(-1) === REGISTRY_MIGRATION, 'Candidate migrations do not end with 051');
  const sql = new Map();
  for (const name of files) sql.set(name, await readFile(join(directory, name), 'utf8'));
  const { rows } = await client.query(
    'SELECT version,checksum,scope FROM schema_migrations ORDER BY version',
  );
  guard(
    rows.every(
      (r) => r.scope === 'cloud' && sql.has(r.version) && sha256(sql.get(r.version)) === r.checksum,
    ),
    'Installed migration ledger differs from the candidate',
  );
  const applied = new Set(rows.map((r) => r.version));
  const pending = files.filter((n) => !applied.has(n));
  guard(
    pending.length === 0 || (pending.length === 1 && pending[0] === REGISTRY_MIGRATION),
    'Pending migrations are not exactly 051',
  );
  guard(
    files.slice(0, -1).every((n) => applied.has(n)),
    'Earlier migrations must already be installed',
  );
  return { pending, sql, checksum: sha256(sql.get(REGISTRY_MIGRATION)) };
}

function verifyPrivileges(before, after) {
  const removed = before.filter((p) => !after.includes(p));
  const added = after.filter((p) => !before.includes(p)).sort();
  guard(removed.length === 0, 'A runtime privilege was removed');
  guard(
    added.every((p) => REGISTRY_PRIVILEGES.includes(p)),
    'Unreviewed runtime privilege added',
  );
  guard(
    REGISTRY_PRIVILEGES.every((p) => after.includes(p)),
    'Reviewed runtime privilege missing',
  );
  guard(
    same(after.filter(onNewTable).sort(), REGISTRY_PRIVILEGES.filter(onNewTable)),
    'New-table runtime privileges differ from review',
  );
  return added;
}

async function loadGrants() {
  // Owned by the device-registry-db work package (plan WP-2); same signature as the other
  // *-grants.mjs modules: (role, enabled) => SQL.
  const module = await import('./device-registry-grants.mjs');
  return module.deviceRegistryGrants;
}

export async function inspectRegistry(client, { directory, role }) {
  guard(ROLE.test(role), 'Invalid runtime role');
  const plan = await registryPlan(client, directory);
  const privileges = await runtimePrivileges(client, role);
  return {
    pending: plan.pending,
    checksum: plan.checksum,
    missingPrivileges: REGISTRY_PRIVILEGES.filter((p) => !privileges.includes(p)),
  };
}

export async function deployRegistry(client, { directory, role, grants }) {
  guard(ROLE.test(role), 'Invalid runtime role');
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
  const plan = await registryPlan(client, directory);
  const before = await tableColumns(client);
  if (plan.pending.length === 0) {
    guard(
      REGISTRY_NEW_TABLES.every((t) => t in before),
      'Registry tables missing although 051 is recorded',
    );
    const privileges = await runtimePrivileges(client, role);
    guard(
      REGISTRY_PRIVILEGES.every((p) => privileges.includes(p)) &&
        same(privileges.filter(onNewTable).sort(), REGISTRY_PRIVILEGES.filter(onNewTable)),
      'Registry runtime privileges differ from review',
    );
    return { applied: [], lastMigration: REGISTRY_MIGRATION, privilegesAdded: [], resumed: true };
  }
  guard(
    REGISTRY_NEW_TABLES.every((t) => !(t in before)),
    'Registry table exists without its migration',
  );
  guard(
    'devices' in before && REGISTRY_DEVICE_COLUMNS.every((c) => !before.devices.includes(c)),
    'devices already has a registry column',
  );
  const sqlFor = grants ?? (await loadGrants());
  const existing = Object.fromEntries(
    Object.entries(before).filter(([name]) => name !== 'schema_migrations'),
  );
  // Hash over the old columns only: the 051 backfill of the new `devices.role` is allowed.
  const start = await fingerprint(client, existing);
  const privilegesBefore = await runtimePrivileges(client, role);
  await client.query(plan.sql.get(REGISTRY_MIGRATION));
  await client.query('INSERT INTO schema_migrations (version, checksum, scope) VALUES ($1,$2,$3)', [
    REGISTRY_MIGRATION,
    plan.checksum,
    'cloud',
  ]);
  await client.query(sqlFor(role, true));
  const after = await tableColumns(client);
  guard(
    same(Object.keys(after).sort(), [...Object.keys(before), ...REGISTRY_NEW_TABLES].sort()),
    'Unexpected table set after 051',
  );
  for (const [table, columns] of Object.entries(before)) {
    const appended = after[table].slice(columns.length).sort();
    const allowed = table === 'devices' ? [...REGISTRY_DEVICE_COLUMNS].sort() : [];
    guard(
      same(after[table].slice(0, columns.length), columns) && same(appended, allowed),
      'A pre-existing column changed: ' + table,
    );
  }
  const end = await fingerprint(client, existing);
  for (const table of Object.keys(existing))
    guard(
      end[table].rows === start[table].rows && end[table].hash === start[table].hash,
      'Pre-existing data changed: ' + table,
    );
  for (const table of REGISTRY_NEW_TABLES) {
    const fresh = (await client.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
    guard(fresh === 0, 'New registry table is not empty: ' + table);
  }
  const added = verifyPrivileges(privilegesBefore, await runtimePrivileges(client, role));
  return {
    applied: [REGISTRY_MIGRATION],
    lastMigration: REGISTRY_MIGRATION,
    checksum: plan.checksum,
    privilegesAdded: added,
    existingTables: Object.keys(existing).length,
    existingDataPreserved: true,
  };
}

async function main(argv) {
  const { createPool } = await import('@pickchick/database');
  const url = new URL(process.env.CLOUD_DATABASE_URL ?? '');
  guard(
    url.username === 'pickchick_owner' && url.pathname === '/pickchick_cloud',
    'Owner database required',
  );
  const directory = fileURLToPath(new URL('../../db/cloud/migrations/', import.meta.url));
  const [command] = argv;
  guard(
    argv.length === 1 && ['inspect', 'deploy'].includes(command),
    'Usage: device-registry-owner.mjs inspect|deploy',
  );
  const pool = createPool(url.href);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    let result;
    if (command === 'inspect') {
      result = await inspectRegistry(client, { directory, role: 'pickchick_app' });
      await client.query('ROLLBACK');
    } else {
      result = await deployRegistry(client, { directory, role: 'pickchick_app' });
      await client.query('COMMIT');
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    // Curated guard messages only; database errors print their SQLSTATE, never row data.
    console.error(
      error instanceof OwnerGuardError
        ? error.message
        : `Owner step failed (${error?.code ?? 'error'})`,
    );
    process.exitCode = 1;
  });
}
