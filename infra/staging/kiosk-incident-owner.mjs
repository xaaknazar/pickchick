#!/usr/bin/env node
/**
 * Owner step of the kiosk payment-incident release (cloud050). Run inside the provision
 * container of the candidate release with the owner database URL:
 *
 *   node infra/staging/kiosk-incident-owner.mjs inspect
 *   node infra/staging/kiosk-incident-owner.mjs deploy
 *
 * deploy applies exactly 050 and grants the runtime role SELECT,INSERT on its one new table, in
 * ONE repeatable-read transaction that proves every pre-existing table kept its columns and rows
 * (by content hash) and that no other runtime privilege changed. inspect only reports the plan.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, runtimePrivileges, OwnerGuardError } from './unified-menu-owner.mjs';
import { kioskIncidentGrants } from './kiosk-incident-grants.mjs';

export const INCIDENT_MIGRATION = '050_cloud_kiosk_payment_incidents.sql';
export const INCIDENT_TABLE = 'commerce_kiosk_payment_incidents';
export const INCIDENT_PRIVILEGES = Object.freeze([
  `${INCIDENT_TABLE}||INSERT`,
  `${INCIDENT_TABLE}||SELECT`,
]);
const MIGRATION_LOCK = 724001; // Same advisory lock as @pickchick/database migrate().
const ROLE = /^[a-z][a-z0-9_]{0,62}$/;
const guard = (condition, message) => {
  if (!condition) throw new OwnerGuardError(message);
};
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

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

/** Ledger must be every earlier file with matching checksums; only 050 may be pending. */
export async function incidentPlan(client, directory) {
  const files = (await readdir(directory)).filter((n) => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort();
  guard(files.at(-1) === INCIDENT_MIGRATION, 'Candidate migrations do not end with 050');
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
    pending.length === 0 || (pending.length === 1 && pending[0] === INCIDENT_MIGRATION),
    'Pending migrations are not exactly 050',
  );
  guard(
    files.slice(0, -1).every((n) => applied.has(n)),
    'Earlier migrations must already be installed',
  );
  return { pending, sql, checksum: sha256(sql.get(INCIDENT_MIGRATION)) };
}

export async function inspectIncident(client, { directory, role }) {
  guard(ROLE.test(role), 'Invalid runtime role');
  const plan = await incidentPlan(client, directory);
  const privileges = await runtimePrivileges(client, role);
  return {
    pending: plan.pending,
    checksum: plan.checksum,
    runtimePrivileges: privileges.filter((p) => p.startsWith(INCIDENT_TABLE + '|')),
  };
}

export async function deployIncident(client, { directory, role }) {
  guard(ROLE.test(role), 'Invalid runtime role');
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
  const plan = await incidentPlan(client, directory);
  const before = await tableColumns(client);
  if (plan.pending.length === 0) {
    guard(INCIDENT_TABLE in before, 'Incident table missing although 050 is recorded');
    const privileges = await runtimePrivileges(client, role);
    guard(
      INCIDENT_PRIVILEGES.every((p) => privileges.includes(p)) &&
        privileges.filter((p) => p.startsWith(INCIDENT_TABLE + '|')).length === 2,
      'Incident runtime privileges differ from review',
    );
    return { applied: [], lastMigration: INCIDENT_MIGRATION, privilegesAdded: [], resumed: true };
  }
  guard(!(INCIDENT_TABLE in before), 'Incident table exists without its migration');
  const existing = Object.fromEntries(
    Object.entries(before).filter(([name]) => name !== 'schema_migrations'),
  );
  const start = await fingerprint(client, existing);
  const privilegesBefore = await runtimePrivileges(client, role);
  await client.query(plan.sql.get(INCIDENT_MIGRATION));
  await client.query('INSERT INTO schema_migrations (version, checksum, scope) VALUES ($1,$2,$3)', [
    INCIDENT_MIGRATION,
    plan.checksum,
    'cloud',
  ]);
  await client.query(kioskIncidentGrants(role, true));
  const after = await tableColumns(client);
  guard(
    JSON.stringify(Object.keys(after).sort()) ===
      JSON.stringify([...Object.keys(before), INCIDENT_TABLE].sort()),
    'Unexpected table set after 050',
  );
  for (const [table, columns] of Object.entries(before))
    guard(
      JSON.stringify(after[table]) === JSON.stringify(columns),
      'A pre-existing column changed: ' + table,
    );
  const end = await fingerprint(client, existing);
  for (const table of Object.keys(existing))
    guard(
      end[table].rows === start[table].rows && end[table].hash === start[table].hash,
      'Pre-existing data changed: ' + table,
    );
  const fresh = (await client.query(`SELECT count(*)::int n FROM ${INCIDENT_TABLE}`)).rows[0].n;
  guard(fresh === 0, 'New incident table is not empty');
  const privilegesAfter = await runtimePrivileges(client, role);
  const added = privilegesAfter.filter((p) => !privilegesBefore.includes(p));
  const removed = privilegesBefore.filter((p) => !privilegesAfter.includes(p));
  guard(
    removed.length === 0 &&
      JSON.stringify(added.sort()) === JSON.stringify([...INCIDENT_PRIVILEGES]),
    'Runtime privilege change differs from review',
  );
  return {
    applied: [INCIDENT_MIGRATION],
    lastMigration: INCIDENT_MIGRATION,
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
    'Usage: kiosk-incident-owner.mjs inspect|deploy',
  );
  const pool = createPool(url.href);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    let result;
    if (command === 'inspect') {
      result = await inspectIncident(client, { directory, role: 'pickchick_app' });
      await client.query('ROLLBACK');
    } else {
      result = await deployIncident(client, { directory, role: 'pickchick_app' });
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
